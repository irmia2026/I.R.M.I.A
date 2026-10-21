/**
 * Irmia Agent — 折叠快照（docs/schema.md §11 `snapshot/checkpoint`、docs/design.md §4.12、M5-9）
 *
 * `data/snapshots/snap-<upToSeq>.json` 存 `{ version, upToSeq, state }`，语义只有一条：
 * **它是 `fold(seq ≤ upToSeq 的全部事件)` 的结果**。恢复时先读快照，再增量折叠之后的事件，
 * 结果必须与全量折叠逐字段相等——这就是 M5-9 的验收口径（有快照也让启动耗时不再随日志
 * 总长线性增长）。快照**不是**真相源：删掉 `snapshots/` 只是让下次启动慢一点。
 *
 * 与投影缓存（state/projection-cache.ts）的分工：
 *   - 投影缓存是"必须与日志末尾严格相等才能用"的加速器（恰好等于最新状态才命中）；
 *   - 快照是"任意历史位置都能用的重放起点"（落后是常态，落后才需要它）。
 * 两者都在损坏时被丢弃、绝不修补；读盘异常一律交给调用方降级处理。
 *
 * 写盘一律「写 .tmp + rename 覆盖」，与 projection-cache 同一套纪律：崩溃在任何一步，
 * 已存在的快照文件都保持完整。旧快照**不在这里清理**：保留历史对复盘有用，
 * 清理超龄快照属每日整理任务的职责（design.md §4.19/M7）。
 *
 * 零外部依赖：只用 node: 标准库。
 */

import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { EventLog } from '../log/event-log.js';
import type { Projection } from '../log/types.js';
import { applyEvent, finalizePressure } from './fold.ts';
// 形状校验只有一处实现（投影缓存在用同一份判据），快照复用而不另写一套
import { basicProjectionShape } from './projection-cache.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 快照目录名（schema §11 目录树） */
export const SNAPSHOT_DIR_NAME = 'snapshots';
/**
 * 快照信封版本。递增理由与 `projection-cache.ts` 的 `PROJECTION_CACHE_VERSION` **完全一样**：
 * 信封形状变化，或者 `state/fold.ts` 的预算口径（`budgetTokensOf` 的算式）变化。
 * **两个常量必须一起 +1**——只动其中一个，另一条恢复路径就会把旧口径的累计量喂回新进程。
 *
 * 为什么这里也必须动（2026-10-05 现场）：那份进程的启动日志原文是
 * 「投影由快照增量折叠 {"snapshot":"snap-28399.json", …}」——它**根本没走投影缓存**，
 * 而是从快照续算，于是 `snap-28399.json` 里旧口径的 `tokensToday=29,951,973` /
 * `tokensTask=178,734,979` 被原样继承（`foldFromSnapshot` 只对 `upToSeq` **之后**的事件
 * 用新算式），新账压在旧账上。丢弃旧版本快照的代价是首次启动做一次全量折叠，那是**换来
 * 一份能对账的账**，值得。
 *
 * 记账：v1 = 未扣缓存口径；v2 = 非缓存口径（`(input − cacheHit) + output`）。
 */
export const SNAPSHOT_VERSION = 2;
/** 文件名前缀 */
export const SNAPSHOT_FILE_PREFIX = 'snap-';
const SNAPSHOT_FILE_RE = /^snap-(\d+)\.json$/u;

// ──────────────────────────────── 对外类型 ────────────────────────────────

/** 磁盘上的快照外形（upToSeq 冗余一份，便于不反序列化 state 就判定位置） */
export interface SnapshotEnvelope {
  version: number;
  /** 快照覆盖到的最后一条事件 seq；state 就是折叠到这里的投影 */
  upToSeq: number;
  state: Projection;
}

export interface WrittenSnapshot {
  /** 文件名（写进 snapshot/checkpoint.file 的就是它，只存名字不存绝对路径） */
  file: string;
  upToSeq: number;
  path: string;
  bytes: number;
}

export interface LoadedSnapshot {
  file: string;
  upToSeq: number;
  path: string;
  state: Projection;
}

/** 读盘结果的判别联合：ok=false 只用于日志排障，调用方一律降级为「没有快照」 */
export type SnapshotLoadResult =
  | { ok: true; snapshot: LoadedSnapshot }
  | { ok: false; reason: string };

/** 测试与宿主注入点：默认全部走 node: 标准库的真实实现 */
export interface SnapshotDeps {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
  /** 以 wx 排他创建并独占写入 tmp 文件；绝不覆盖任何已有文件 */
  createExclusive(path: string, data: string): Promise<void>;
}

// ──────────────────────────────── 默认依赖 ────────────────────────────────

function hasCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const defaultDeps: SnapshotDeps = {
  readFile: (path) => readFile(path, 'utf8'),
  readdir: (path) => readdir(path),
  rename: async (from, to) => {
    await rename(from, to);
  },
  rm: async (path, options) => {
    await rm(path, { force: options?.force ?? false });
  },
  mkdir: async (path, options) => mkdir(path, options),
  createExclusive: async (path, data) => {
    const handle = await open(path, 'wx');
    try {
      await handle.writeFile(data, 'utf8');
      // 先落盘再 rename：否则可能留下「名字对、内容是零」的快照
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

/** tmp 文件名的进程内唯一序号 */
let tmpSeq = 0;

// ──────────────────────────────── 路径 ────────────────────────────────

/** 快照目录：<dataDir>/snapshots */
export function snapshotDirOf(dataDir: string): string {
  return join(dataDir, SNAPSHOT_DIR_NAME);
}

/** 文件名由 upToSeq 唯一决定：同名即同位置，写第二次就是覆盖同一份内容 */
export function snapshotFileName(upToSeq: number): string {
  return `${SNAPSHOT_FILE_PREFIX}${upToSeq}.json`;
}

// ──────────────────────────────── 写 ────────────────────────────────

/**
 * 把当前投影写快照，文件名 `snap-<projection.lastSeq>.json`，返回文件名供写 `snapshot/checkpoint`。
 *
 * 调用顺序不可颠倒：**先写快照、再写 checkpoint 事件**。这样 checkpoint 事件的 seq 必然大于
 * 快照的 upToSeq，恢复时它会被增量重放一遍（fold 里它只更新 lastArchiveAt，结果一致）。
 * 反过来先写事件再写快照，事件里声明的 upToSeq 就可能落在快照覆盖范围之外。
 *
 * 写失败**会抛出**：调用方（real-loop）捕获后降级为一行日志——快照只是加速器，不能拖垮循环。
 */
export async function writeSnapshot(
  dataDir: string,
  projection: Projection,
  deps: Partial<SnapshotDeps> = {},
): Promise<WrittenSnapshot> {
  const d: SnapshotDeps = { ...defaultDeps, ...deps };
  const upToSeq = projection.lastSeq;
  const file = snapshotFileName(upToSeq);
  const dir = snapshotDirOf(dataDir);
  const path = join(dir, file);
  const envelope: SnapshotEnvelope = { version: SNAPSHOT_VERSION, upToSeq, state: projection };
  const body = `${JSON.stringify(envelope)}\n`;
  tmpSeq += 1;
  const tmp = `${path}.tmp.${process.pid}.${tmpSeq}`;

  try {
    await d.mkdir(dir, { recursive: true });
    await d.createExclusive(tmp, body);
    await d.rename(tmp, path);
  } catch (err) {
    try {
      await d.rm(tmp, { force: true });
    } catch {
      /* tmp 清理失败不影响已存在的快照完整性 */
    }
    throw new Error(`写入快照 ${path} 失败：${toErrorMessage(err)}`);
  }
  return { file, upToSeq, path, bytes: Buffer.byteLength(body) };
}

// ──────────────────────────────── 读 ────────────────────────────────

/**
 * 单个快照文件的读取与校验（expectedSeq 来自文件名）。
 * 任何一处不符即判损坏：版本不认识、upToSeq 非法、文件名与信封不一致、state 形状不对、
 * state.lastSeq 与 upToSeq 不等。半截快照的静默修补比丢掉它危险得多。
 */
async function readSnapshotFile(
  path: string,
  file: string,
  expectedSeq: number,
  deps: SnapshotDeps,
): Promise<SnapshotLoadResult> {
  let text: string;
  try {
    text = await deps.readFile(path);
  } catch (err) {
    return { ok: false, reason: `读取 ${file} 失败：${toErrorMessage(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `${file} 不是合法 JSON：${toErrorMessage(err)}` };
  }
  if (!isRecord(parsed)) return { ok: false, reason: `${file} 顶层不是 JSON 对象` };

  const rawVersion = parsed['version'];
  if (rawVersion !== undefined && rawVersion !== SNAPSHOT_VERSION) {
    return { ok: false, reason: `${file} 的版本 ${String(rawVersion)} 不认识` };
  }

  const upToSeq = parsed['upToSeq'];
  if (!Number.isInteger(upToSeq) || (upToSeq as number) < 0) {
    return { ok: false, reason: `${file} 的 upToSeq 非法：${String(upToSeq)}` };
  }
  if (upToSeq !== expectedSeq) {
    return { ok: false, reason: `${file} 的文件名与 upToSeq(${String(upToSeq)}) 不一致` };
  }

  const state = parsed['state'];
  if (!basicProjectionShape(state)) return { ok: false, reason: `${file} 的 state 形状不正确` };
  // 快照的语义是"折叠到 upToSeq"，两者不等说明文件被改写：丢弃，不猜
  if (state.lastSeq !== upToSeq) {
    return {
      ok: false,
      reason: `${file} 的 upToSeq(${String(upToSeq)}) 与 state.lastSeq(${state.lastSeq}) 不一致`,
    };
  }

  return {
    ok: true,
    snapshot: { file, upToSeq: upToSeq as number, path, state },
  };
}

/**
 * 找最大 upToSeq 的快照读回。目录不存在、没有快照、所有快照都损坏都返回 `{ ok:false }`——
 * 这不是错误，只是"这次启动得靠全量折叠"。按 seq 降序逐个尝试：最新的坏了就退到次新的，
 * 一份可用的旧快照依然比全量折叠便宜。
 */
export async function loadLatestSnapshotResult(
  dataDir: string,
  deps: Partial<SnapshotDeps> = {},
): Promise<SnapshotLoadResult> {
  const d: SnapshotDeps = { ...defaultDeps, ...deps };
  const dir = snapshotDirOf(dataDir);

  let names: string[];
  try {
    names = await d.readdir(dir);
  } catch (err) {
    if (hasCode(err, 'ENOENT')) return { ok: false, reason: `快照目录不存在：${dir}` };
    return { ok: false, reason: `读取快照目录 ${dir} 失败：${toErrorMessage(err)}` };
  }

  const candidates = names
    .map(name => {
      const matched = SNAPSHOT_FILE_RE.exec(name);
      return matched === null ? null : { name, seq: Number(matched[1]) };
    })
    .filter((item): item is { name: string; seq: number } => item !== null)
    .sort((a, b) => b.seq - a.seq);

  if (candidates.length === 0) return { ok: false, reason: `${dir} 里没有快照文件` };

  const failures: string[] = [];
  for (const candidate of candidates) {
    const result = await readSnapshotFile(join(dir, candidate.name), candidate.name, candidate.seq, d);
    if (result.ok) return result;
    failures.push(result.reason);
  }
  return { ok: false, reason: `${candidates.length} 个快照都不可用：${failures[0] ?? ''}` };
}

/** 便利包装：只要快照本体，任何异常一律 null（调用方据此决定全量折叠） */
export async function loadLatestSnapshot(
  dataDir: string,
  deps: Partial<SnapshotDeps> = {},
): Promise<LoadedSnapshot | null> {
  const result = await loadLatestSnapshotResult(dataDir, deps);
  return result.ok ? result.snapshot : null;
}

// ──────────────────────────────── 从快照续算 ────────────────────────────────

/**
 * 从快照起算增量折叠：`snapshot.upToSeq + 1` 之后的事件逐条 applyEvent，末尾重算一次压力。
 * 与全量折叠（recover.foldFromLog）严格等价——两者都是「空投影或快照 + 逐条按归属折叠 +
 * finalizePressure」，这正是 M5-9 可断言的基础。
 *
 * 走 applyEvent（而不是 applyOne）：子代理链的事件（`parentCallId` 非空）只折父层记账，
 * 与 fold 全量重建同一口径。否则「快照续算」与「全量折叠」会在有子代理日志时分叉。
 *
 * 前置条件：`snapshot.upToSeq ≤ 日志末尾`。快照领先日志只可能是日志被截断（分片被删），
 * 那属于调用方该拒绝的输入，本函数不做"领先就清日志"这类危险推断。
 * 本函数**原地修改** `snapshot.state`（刚从磁盘读出的独占对象，调用方不应再持有它）。
 */
export async function foldFromSnapshot(log: EventLog, snapshot: LoadedSnapshot): Promise<Projection> {
  const projection = snapshot.state;
  for await (const event of log.readRange(snapshot.upToSeq + 1)) applyEvent(projection, event);
  finalizePressure(projection);
  return projection;
}
