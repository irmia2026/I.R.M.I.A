/**
 * Irmia Agent — **接管闸门**：让"同一时刻只有一个后端"在**并发**下也成立（B 项）。
 *
 * ## 它补的是哪一条缝
 *
 * `instance-lock.ts` 的排他创建（`openSync(file, 'wx')`）对**首次创建**是原子的，这条一直是对的。
 * 但**接管陈旧锁**那条路不是：`decide()` 判定"前任 pid 已死"之后走的是
 * `writeAtomic()`（tmp + `rename` 覆盖）+ 回读校验，而 `rename` 覆盖**不是**
 * "比较并交换"——两个进程可以各自完成下面这个交错，然后**都**认为自己持锁：
 *
 * ```
 *   A: 读到锁 = 死 pid        B: 读到锁 = 死 pid          ← 两次读都发生在任何写之前
 *   A: writeAtomic(自己)      B: writeAtomic(自己)
 *   A: 回读 = 自己 ⇒ 我持锁   B: 回读 = 自己 ⇒ 我持锁
 * ```
 *
 * 后果是真双写：两个进程各写各的 turn（用户 2026-10-11 报的"两套 turn 同时跑"）。
 * 事后能靠心跳自检（30 秒）纠偏——**但要等最多 30 秒**，而日志已经被两个进程写脏了。
 *
 * ## 闸门怎么补
 *
 * 接管的**判定与写入**必须串行。闸门就是那唯一一处串行点：`<dataDir>/lock.json.takeover`，
 * 同样用 `wx` 排他创建（这一步是原子的），谁建到谁才有资格去碰 `lock.json`；
 * 建不到的那个**如实拒绝启动**，一个字节都不写。
 *
 *   · 于是"两个进程同时接管同一把陈旧锁"退化成"一个接管、另一个拒绝"；
 *   · 闸门只在**整个恢复流程**期间持有（`main.ts` 里 recover 的前后各一次），
 *     因为它保护的正是 recover 第一步那次接管；
 *   · 崩溃不留死闸门：接管判据只看**记录里的 pid 还活着吗**（不是看时间），
 *     持闸者一死，下一个进程立刻接管并留痕。
 *
 * ## 闸门自己的陈旧判据（四值，按优先级；与 instance-lock 的三值**刻意分开**）
 *
 *   ① `unreadable` 记录读不懂（建好了没写完就被杀）⇒ 没有合法持闸者，接管；
 *   ② `self-leak`  记录里的 pid 是**我自己** ⇒ 上一次在本进程里漏了释放，自愈并留痕；
 *   ③ `pid-gone`   记录里的 pid 不在了 ⇒ 接管（**这一条是常态**，不是异常）；
 *   ④ `pid-reused` pid 还活着，但闸门已被持有超过 `maxHoldMs`（10 分钟）——
 *      合法持闸最长也就一次接管宽限期（默认 60 秒）× 最多 3 次尝试 ≈ 3 分钟，
 *      10 分钟还没放说明那个 pid 早就是别的进程了。**这一条是防"假忙"的最后一道**：
 *      少了它，一次 pid 复用会让新实例永远拒绝启动（看起来像"后端起不来了"）。
 *
 * ## 为什么这个文件而不是改 instance-lock.ts
 *
 * `instance-lock.ts` 的判据（pid-gone / pid-reused / stale-heartbeat + 宽限期）一个字都不重复：
 * 本模块**只负责串行**，接管结论仍然整个由它给。判据一处，闸门一处。
 */

import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import type { LockLogger } from './instance-lock.ts';

/** 闸门文件名。与 `lock.json` 同目录、名字相邻，扫一眼数据目录就知道它在不在 */
export const TAKEOVER_GATE_FILE_NAME = 'lock.json.takeover';

/** 建闸门等不到时最多等多久（毫秒）：正常持闸只有几毫秒，等 3 秒已经是"对方在真干活" */
export const DEFAULT_GATE_WAIT_MS = 3_000;
/** 等待期间的轮询间隔（毫秒） */
export const DEFAULT_GATE_POLL_MS = 100;
/** 闸门被持有超过它 + pid 仍活 ⇒ 判定那个 pid 已被复用（合法持闸最长约 3 分钟） */
export const DEFAULT_GATE_MAX_HOLD_MS = 600_000;

/** 闸门记录：`token` 是**本次持有的身份**（同一个 pid 再次申领也不会被误认成自己） */
export interface GateRecord {
  pid: number;
  /** 持有者进程的启动时刻（ISO 8601） */
  startedAt: string;
  /** 本次申领时刻（ISO 8601） */
  at: string;
  /** 本次申领的唯一标识：释放时据此确认"文件里还是我这一次" */
  token: string;
}

/** 接管陈旧闸门的原因（四值） */
export type GateStaleBecause = 'unreadable' | 'self-leak' | 'pid-gone' | 'pid-reused';

export interface GateReclaimRecord {
  file: string;
  /** 被顶替者的 pid；记录读不懂时为 null */
  previousPid: number | null;
  previousStartedAt: string | null;
  staleBecause: GateStaleBecause;
  /** 它被持有了多久（毫秒）；读不懂时为 null */
  heldMs: number | null;
  at: string;
}

export interface InstanceGate {
  readonly file: string;
  readonly pid: number;
  readonly token: string;
  /** 重读闸门：内容仍是本次申领才算持有有效 */
  verify(): boolean;
  /** 只在内容仍是本次申领时删除；幂等 */
  release(): void;
}

/** 另一个实例正在启动/接管中：**本实例一个字节都不许写** */
export class InstanceGateBusyError extends Error {
  readonly file: string;
  readonly holderPid: number;
  readonly holderStartedAt: string | null;
  readonly waitedMs: number;

  constructor(file: string, holderPid: number, holderStartedAt: string | null, waitedMs: number) {
    super(
      `另一个后端实例正在启动（pid ${holderPid}，正在接管单实例锁）：本实例不启动。`
      + `等了 ${waitedMs} 毫秒它还没让出闸门——同一时刻只允许一个后端，`
      + `两个一起跑会把同一份事件日志写脏（闸门文件：${file}）`,
    );
    this.name = 'InstanceGateBusyError';
    this.file = file;
    this.holderPid = holderPid;
    this.holderStartedAt = holderStartedAt;
    this.waitedMs = waitedMs;
  }
}

/**
 * 单实例锁被**活着的**实例持有 ⇒ 本实例不启动。
 *
 * 它与 `LockHeldError` 的关系：那个是"锁的判据"给的原始错误，这个是**给人和给退出码的那一句**。
 * `message` 逐字就是用户要的那句话的形状（"已经有一个后端在跑（pid N），我这个不启动"）。
 */
export class BackendAlreadyRunningError extends Error {
  readonly lockFile: string;
  readonly holderPid: number;
  readonly holderStartedAt: string | null;

  constructor(lockFile: string, holderPid: number, holderStartedAt: string | null) {
    super(
      `已经有一个后端在跑（pid ${holderPid}`
      + `${holderStartedAt === null ? '' : `，起于 ${holderStartedAt}`}）：我这个不启动。`
      + `单实例锁：${lockFile}`,
    );
    this.name = 'BackendAlreadyRunningError';
    this.lockFile = lockFile;
    this.holderPid = holderPid;
    this.holderStartedAt = holderStartedAt;
  }
}

export interface GateOptions {
  log?: LockLogger;
  /** 注入时钟（毫秒）；测试用假时钟 */
  now?: () => number;
  /** 注入等待；默认真实 setTimeout */
  sleep?: (ms: number) => Promise<void>;
  pid?: number;
  /** PID 探活；默认 process.kill(pid, 0)，EPERM 视为存在（与 instance-lock 同口径） */
  isPidAlive?: (pid: number) => boolean;
  /** 本进程启动时刻（毫秒） */
  processStartedAtMs?: () => number;
  waitMs?: number;
  pollMs?: number;
  maxHoldMs?: number;
  /** 接管了陈旧闸门：调用方据此留痕（事件/日志） */
  onReclaim?: (record: GateReclaimRecord) => void;
}

interface ResolvedGateOptions {
  log: LockLogger;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pid: number;
  isPidAlive: (pid: number) => boolean;
  processStartedAtMs: () => number;
  waitMs: number;
  pollMs: number;
  maxHoldMs: number;
  onReclaim: ((record: GateReclaimRecord) => void) | undefined;
}

type GateProbe =
  | { state: 'absent' }
  | { state: 'record'; record: GateRecord }
  | { state: 'unreadable' };

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseGateRecord(raw: string): GateRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  const pid = obj['pid'];
  const startedAt = obj['startedAt'];
  const at = obj['at'];
  const token = obj['token'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== 'string' || typeof at !== 'string' || typeof token !== 'string') return null;
  if (token === '') return null;
  return { pid, startedAt, at, token };
}

function readGate(file: string): GateProbe {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // 与 instance-lock 同一条纪律：读不到 = 无人持有；读得到但出错（EACCES 等）= 不可解析
    return code === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable' };
  }
  const record = parseGateRecord(raw);
  return record === null ? { state: 'unreadable' } : { state: 'record', record };
}

function sameClaim(a: GateRecord, b: GateRecord): boolean {
  return a.pid === b.pid && a.token === b.token && a.at === b.at;
}

/** `wx` 排他创建：false = 已存在（他人持有）；其他错误直接抛 */
function createGate(file: string, record: GateRecord): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(file);
    } catch {
      // 清理失败只留下不可解析的闸门，下一个进程会按 'unreadable' 接管
    }
    throw err;
  }
  closeSync(fd);
  return true;
}

/** 闸门靠"pid 还活着吗"判陈旧，**与 instance-lock 同一条口径**（活着的 pid 是硬判据，时间不是） */
function staleBecauseOf(probe: GateProbe, opts: ResolvedGateOptions): GateStaleBecause | null {
  if (probe.state === 'absent') return null;
  if (probe.state === 'unreadable') return 'unreadable';
  const held = probe.record;
  if (held.pid === opts.pid) return 'self-leak';
  if (!opts.isPidAlive(held.pid)) return 'pid-gone';
  const heldMs = opts.now() - Date.parse(held.at);
  if (Number.isFinite(heldMs) && heldMs > opts.maxHoldMs) return 'pid-reused';
  return null;
}

class GateHandle implements InstanceGate {
  readonly file: string;
  readonly pid: number;
  readonly token: string;

  private readonly record: GateRecord;
  private released = false;

  constructor(file: string, record: GateRecord) {
    this.file = file;
    this.record = record;
    this.pid = record.pid;
    this.token = record.token;
  }

  verify(): boolean {
    if (this.released) return false;
    const probe = readGate(this.file);
    return probe.state === 'record' && sameClaim(probe.record, this.record);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    const probe = readGate(this.file);
    if (probe.state !== 'record' || !sameClaim(probe.record, this.record)) {
      // 闸门已易主：删别人的闸门会把"正在接管的那个"放进来，坚决不动
      return;
    }
    try {
      unlinkSync(this.file);
    } catch {
      // 删不掉就留着一个"持闸者已死"的闸门，下一个进程按 pid-gone 接管，正确性不受影响
    }
  }
}

function resolveGateOptions(options: GateOptions): ResolvedGateOptions {
  return {
    log: options.log ?? (() => {}),
    now: options.now ?? Date.now,
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    pid: options.pid ?? process.pid,
    isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
    processStartedAtMs: options.processStartedAtMs ?? (() => Date.now() - process.uptime() * 1000),
    waitMs: options.waitMs ?? DEFAULT_GATE_WAIT_MS,
    pollMs: options.pollMs ?? DEFAULT_GATE_POLL_MS,
    maxHoldMs: options.maxHoldMs ?? DEFAULT_GATE_MAX_HOLD_MS,
    onReclaim: options.onReclaim,
  };
}

/**
 * 拿接管闸门。拿到返回句柄；确认被**活着的**实例或同行持有则抛 `InstanceGateBusyError`。
 *
 * 调用纪律（`main.ts` 那两行）：**在 `recover()` 之前拿、在它返回之后放**
 * ——recover 的第一步就是那次可能并发的接管，闸门必须罩住它。
 */
export async function acquireInstanceGate(
  dataDir: string,
  options: GateOptions = {},
): Promise<InstanceGate> {
  const opts = resolveGateOptions(options);
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, TAKEOVER_GATE_FILE_NAME);

  const mine: GateRecord = {
    pid: opts.pid,
    startedAt: new Date(opts.processStartedAtMs()).toISOString(),
    at: new Date(opts.now()).toISOString(),
    token: randomUUID(),
  };

  const deadline = opts.now() + opts.waitMs;
  for (;;) {
    if (createGate(file, mine)) {
      opts.log('debug', '已持有接管闸门', { file, pid: mine.pid });
      return new GateHandle(file, mine);
    }

    const probe = readGate(file);
    if (probe.state === 'absent') continue; // 对方刚释放：立刻重试创建

    const staleBecause = staleBecauseOf(probe, opts);
    if (staleBecause !== null) {
      const previous = probe.state === 'record' ? probe.record : null;
      const heldMs = previous === null ? null : opts.now() - Date.parse(previous.at);
      try {
        unlinkSync(file);
      } catch (err) {
        // 删不掉（被别人先删了 / 权限）：下一轮重读再判，不在这里抛
        opts.log('debug', '删除陈旧闸门失败，下一轮重判', { file, error: String(err) });
        continue;
      }
      const record: GateReclaimRecord = {
        file,
        previousPid: previous?.pid ?? null,
        previousStartedAt: previous?.startedAt ?? null,
        staleBecause,
        heldMs: heldMs !== null && Number.isFinite(heldMs) ? heldMs : null,
        at: new Date(opts.now()).toISOString(),
      };
      opts.log('warn', '接管了陈旧闸门', {
        file,
        previousPid: record.previousPid,
        staleBecause,
        heldMs: record.heldMs,
      });
      const cb = opts.onReclaim;
      if (cb !== undefined) {
        try {
          cb(record);
        } catch (err) {
          opts.log('error', 'onReclaim 回调抛错', { error: String(err) });
        }
      }
      continue;
    }

    // 活着、且不是我自己：等一小会儿（正常持闸只有几毫秒），等不到就如实拒绝
    if (opts.now() >= deadline) {
      const holder = probe.state === 'record' ? probe.record : null;
      throw new InstanceGateBusyError(file, holder?.pid ?? 0, holder?.startedAt ?? null, opts.waitMs);
    }
    await opts.sleep(opts.pollMs);
  }
}
