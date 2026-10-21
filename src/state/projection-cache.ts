/**
 * Irmia Agent — 投影缓存（docs/schema.md §8、docs/design.md §4.2、docs/review.md P2-18）
 *
 * data/projection.json 存 { version, lastSeq, state }，是**派生缓存**：随时可删重建，
 * 真相源永远是事件日志。三条不变量：
 *   1. 写盘一律「写 .tmp + rename 覆盖」，绝不先删原文件——崩溃在任何一步，
 *      原文件都保持完整（milestones.md T2 的验收点）；
 *   2. 读盘任何异常（缺失、半截 JSON、形状不对、版本不认识）一律当 null 交给调用方
 *      重算，绝不抛错、绝不修补——半截缓存的静默修补比丢缓存危险得多；
 *   3. 命中判据只有一条：lastSeq 与日志末尾严格相等（`isCacheValid`）。
 *
 * 零外部依赖：只用 node: 标准库。
 */

import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Projection } from '../log/types.js';
// 预算口径版本：累计量跨不了口径，载入时必须校验它（值导入写 .ts，见 fold.ts 的约定）
import { BUDGET_ACCOUNTING_VERSION } from '../log/types.ts';

/** 缓存文件名，固定，不随配置变化 */
export const PROJECTION_CACHE_FILE = 'projection.json';

/**
 * 缓存信封格式版本。两条递增理由，任一成立就必须 +1（旧版本一律按「不认识」丢弃重算）：
 *   ① **信封形状**变化（`ProjectionCache` 增删字段）；
 *   ② **预算口径**变化——即 `state/fold.ts` 的 `budgetTokensOf` 的算式变了。
 *
 * ② 是 2026-10-05 那次实测事故的直接对策：投影里的 `tokensToday` / `tokensTask` 是**累计量**，
 * 一半来自旧算式、一半来自新算式就没法再对账（现场：磁盘缓存里冻结着旧口径的
 * `tokensToday=29,951,973`，而同一份日志按新口径折出来只有 `2,052,965`——
 * 进程照旧拿前者判刹车，于是她一开始 turn 就被 `budget/exhausted{layer:'task'}` 拒掉）。
 * 累计量**不能跨口径续用**，只能整份丢弃、从事件重放。
 *
 * 与之配对的是 `state/snapshot.ts` 的 `SNAPSHOT_VERSION`：两条恢复路径（缓存 / 快照）
 * **必须一起 +1**，否则旧快照仍会把旧口径的累计喂回新进程（现场正是走的快照那条路）。
 * `test/budget-snapshot-rebuild.test.ts` 钉住这条配对关系。
 *
 * 记账：v1 = 未扣缓存口径（`input + output`，含 cacheHit）；v2 = 非缓存口径
 * （`(input − cacheHit) + output`，见 `state/fold.ts` 的 `budgetTokensOf`）。
 */
export const PROJECTION_CACHE_VERSION = 2;

/** 磁盘上的缓存外形（lastSeq 冗余一份，便于不反序列化 state 就判定新鲜度） */
export interface ProjectionCache {
  version: number;
  /** 与该投影对应的日志末尾 seq */
  lastSeq: number;
  state: Projection;
}

/** 读盘结果的判别联合：ok=false 时 reason 只用于日志排障，调用方一律当 null 处理 */
export type LoadResult =
  | { ok: true; cache: ProjectionCache }
  | { ok: false; reason: string };

/** 测试与宿主注入点：默认全部走 node: 标准库的真实实现 */
export interface ProjectionCacheDeps {
  readFile(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  /** 以 wx 排他创建并独占写入 tmp 文件；绝不覆盖任何已有文件 */
  createExclusive(path: string, data: string): Promise<void>;
}

// ──────────────────────────────── 默认依赖 ────────────────────────────────

const defaultDeps: ProjectionCacheDeps = {
  readFile: (path) => readFile(path, 'utf8'),
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
      await handle.truncate(0);
      await handle.writeFile(data, 'utf8');
      // 先让数据落盘再 rename：否则存在「名字已就位、内容仍在页缓存」的窗口，
      // 断电后会留下一个长度正确但内容是零的缓存文件
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

// ──────────────────────────────── 内部工具 ────────────────────────────────

function hasCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** tmp 文件名的进程内唯一序号：同进程并发写不会互相踩到对方的 tmp */
let tmpSeq = 0;

/** 投影里数值型的键 */
const NUMBER_KEYS = ['lastSeq', 'watermark', 'failStreak', 'idleTicks', 'pressure'] as const;

/** 投影里数组型的键 */
const ARRAY_KEYS = [
  'pending', 'openTools', 'needsReview', 'planPending', 'planApproved',
  'timers', 'intentions', 'todoList', 'dedupeKeys', 'deadLetters',
  // 人类提问队列（design §6）：加进这条名单意味着**旧缓存不接受**（缺这个字段就不是合法投影），
  // 于是一次全量重算——这正是要的：老的缓存没有"台面上还有哪些提问"，接着用它比丢它危险。
  'humanAsks',
] as const;

/** 投影里可空字符串型的键 */
const NULLABLE_STRING_KEYS = [
  'lastModelSuccessAt', 'firstEventAt', 'lastAssistantText', 'lastAssistantAt', 'lastArchiveAt',
] as const;

/** 投影里可空对象型的键 */
const NULLABLE_OBJECT_KEYS = ['openTurn', 'waitingHuman', 'degraded', 'lastWake'] as const;

/**
 * 投影的**基本**形状校验（schema §8「缓存损坏一律删掉重算，不做修补」）。
 *
 * 只钉「能否安全参与折叠」，不深入数组元素：漏一个字段会让后续调度读到 undefined，
 * 而过度校验会在事件类型演进时误丢仍然可用的缓存——元素级坏数据由读到具体项的使用方处理。
 *
 * 一条**语义**校验（不是形状）：`budget.budgetVersion` 必须等于当前口径版本
 * （`BUDGET_ACCOUNTING_VERSION`，由 fold 盖章）。累计量跨不了口径，缺这一格或版本不符
 * 就整份丢弃、从事件重放——这正是 2026-10-05「旧账压新账」那次事故的判据。
 *
 * 导出供 state/snapshot.ts 复用：快照与缓存校验的是同一份投影形状，
 * 两处各写一套必然漂移（那次事故就是"快照那条路没校验"造成的）。
 */
export function basicProjectionShape(value: unknown): value is Projection {
  if (!isRecord(value)) return false;
  for (const key of NUMBER_KEYS) {
    // lastSeq/watermark/idleTicks/failStreak 必须是非负整数；pressure 允许小数
    const field = value[key];
    if (typeof field !== 'number') return false;
    if (key !== 'pressure' && (!Number.isInteger(field) || field < 0)) return false;
  }
  for (const key of ARRAY_KEYS) {
    if (!Array.isArray(value[key])) return false;
  }
  for (const key of NULLABLE_STRING_KEYS) {
    const field = value[key];
    if (field !== null && typeof field !== 'string') return false;
  }
  for (const key of NULLABLE_OBJECT_KEYS) {
    const field = value[key];
    if (field !== null && !isRecord(field)) return false;
  }
  for (const key of ['budget', 'jobs', 'claimedByTurn', 'lastExhausted'] as const) {
    if (!isRecord(value[key])) return false;
  }
  const budget = value['budget'] as Record<string, unknown>;
  if (budget['budgetVersion'] !== BUDGET_ACCOUNTING_VERSION) return false;
  return true;
}

function cachePath(dir: string): string {
  return join(dir, PROJECTION_CACHE_FILE);
}

// ──────────────────────────────── 写盘 ────────────────────────────────

/**
 * 写 data/projection.json。先写 `projection.json.tmp.<pid>.<n>` 再 rename 覆盖：
 *   - 任一步失败都不动原文件（原文件要么是上次成功的快照，要么压根不存在）；
 *   - 失败路径顺手清掉 tmp，不留垃圾（同 pid 同序号不可能重名，清掉即可）；
 *   - pid+序号后缀让同进程并发写各有独立 tmp，最后 rename 的都是完整内容。
 *
 * 写失败**会抛出**：投影重算昂贵，调用方必须知道这次保存没生效才能决定告警或重试。
 */
export async function saveProjectionCache(
  dir: string,
  projection: Projection,
  lastSeq: number,
  deps: Partial<ProjectionCacheDeps> = {},
): Promise<void> {
  const d: ProjectionCacheDeps = { ...defaultDeps, ...deps };
  const path = cachePath(dir);
  const envelope: ProjectionCache = {
    version: PROJECTION_CACHE_VERSION,
    lastSeq,
    state: projection,
  };
  const body = `${JSON.stringify(envelope)}\n`;
  tmpSeq += 1;
  const tmp = `${path}.tmp.${process.pid}.${tmpSeq}`;

  try {
    await d.mkdir(dirname(path), { recursive: true });
    await d.createExclusive(tmp, body);
    await d.rename(tmp, path);
  } catch (err) {
    try {
      await d.rm(tmp, { force: true });
    } catch {
      /* tmp 清理失败不影响原文件完整性，下一次 save 用新名字重建 */
    }
    throw new Error(`写入投影缓存 ${path} 失败：${toErrorMessage(err)}`);
  }
}

// ──────────────────────────────── 读盘 ────────────────────────────────

/**
 * 读投影缓存并做基本校验。任何损坏/缺失都返回 { ok:false }，不抛错：
 * 缓存只是加速启动的 hint，丢掉的代价是一次全量折叠，抛错的代价是启动失败。
 * 这里**不删除**坏文件——删除是调用方的决定（schema §8 的「删掉重算」），
 * 库层静默删文件会让排查「缓存为什么老失效」失去现场。
 */
export async function loadProjectionCacheResult(
  dir: string,
  deps: Partial<ProjectionCacheDeps> = {},
): Promise<LoadResult> {
  const d: ProjectionCacheDeps = { ...defaultDeps, ...deps };
  const path = cachePath(dir);

  let text: string;
  try {
    text = await d.readFile(path);
  } catch (err) {
    if (hasCode(err, 'ENOENT')) return { ok: false, reason: `缓存不存在：${path}` };
    return { ok: false, reason: `读取 ${path} 失败：${toErrorMessage(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `${path} 不是合法 JSON：${toErrorMessage(err)}` };
  }

  if (!isRecord(parsed)) return { ok: false, reason: `${path} 顶层不是 JSON 对象` };

  const lastSeq = parsed['lastSeq'];
  if (!Number.isInteger(lastSeq) || (lastSeq as number) < 0) {
    return { ok: false, reason: `${path} 的 lastSeq 非法：${String(lastSeq)}` };
  }

  // 版本缺失一律丢弃：这一格只可能来自"换口径之前那一版代码"（累计量的口径不明就不能续算）。
  // 版本不认识同样丢弃，不猜未知字段语义。
  const rawVersion = parsed['version'];
  if (rawVersion !== PROJECTION_CACHE_VERSION) {
    return { ok: false, reason: `${path} 的版本 ${String(rawVersion)} 不认识（缺失或过期）` };
  }

  const state = parsed['state'];
  if (!basicProjectionShape(state)) {
    return { ok: false, reason: `${path} 的 state 形状不正确` };
  }

  // 信封 lastSeq 与投影内 lastSeq 必须一致；以信封为准会静默制造错误水位
  if (state.lastSeq !== lastSeq) {
    return {
      ok: false,
      reason: `${path} 的信封 lastSeq(${String(lastSeq)}) 与 state.lastSeq(${state.lastSeq}) 不一致`,
    };
  }

  return { ok: true, cache: { version: PROJECTION_CACHE_VERSION, lastSeq: lastSeq as number, state } };
}

/** 便利包装：只要缓存本体，损坏一律 null（调用方据此决定全量重算） */
export async function loadProjectionCache(
  dir: string,
  deps: Partial<ProjectionCacheDeps> = {},
): Promise<ProjectionCache | null> {
  const result = await loadProjectionCacheResult(dir, deps);
  return result.ok ? result.cache : null;
}

// ──────────────────────────────── 命中判定 ────────────────────────────────

/**
 * 命中条件只有一条：缓存的 lastSeq 与日志末尾严格相等。
 * 不留容差、不许「落后一点也能用」——投影的 pending/openTools/水位互相纠缠，
 * 从中间接续等于接受一份错状态；落后就全量重算，代价可接受。
 * 缓存领先日志（日志被截断/分片被删）同样不可用：只可能重算，不可能修补。
 */
export function isCacheValid(
  cache: ProjectionCache | null,
  latestSeq: number,
): cache is ProjectionCache {
  if (cache === null) return false;
  if (!Number.isInteger(latestSeq) || latestSeq < 0) return false;
  return cache.lastSeq === latestSeq;
}
