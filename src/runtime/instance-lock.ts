/**
 * Irmia Agent — 单实例锁（docs/design.md §4.8）
 *
 * data/lock.json 持有 { pid, startedAt, heartbeatAt }：
 *   - 排他创建：openSync(file, 'wx')，抢不到就是有人持有；
 *   - 一切写盘走 tmp + rename（原子替换，绝不留下半截 JSON）；
 *   - 三个陈旧判据按优先级：pid 不存在 → pid 被复用 → 心跳陈旧。
 *
 * 心跳（30 秒）是活性证据而非唯一判据：进程被 SIGSTOP 时心跳停更但进程仍活，
 * 纯心跳方案会误判陈旧导致双写；因此保留 PID 复用检测，并给心跳陈旧加接管宽限期。
 *
 * 与 docs/schema.md 的差异：schema 的 instance/takeover 事件只声明了
 * 'no-heartbeat' | 'pid-gone' | 'pid-reused'，本模块对外用更精确的
 * TakeoverReason（'pid-gone' | 'stale-heartbeat' | 'pid-reused'），
 * 需要写事件时用 toInstanceTakeoverData() 做映射，不擅自改事件形状。
 */

import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';

import type { InstanceTakeover } from '../log/types.js';

export const LOCK_FILE_NAME = 'lock.json';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_SELF_CHECK_INTERVAL_MS = 60_000;
export const DEFAULT_STALE_HEARTBEAT_MS = 90_000;
export const DEFAULT_TAKEOVER_GRACE_MS = 60_000;

/**
 * 开机时间的比较容差：os.uptime() 与 process.uptime() 精度有限，
 * 且二者基准点不同，开机瞬间启动的进程不应被误判为 PID 复用。
 */
export const BOOT_TIME_TOLERANCE_MS = 2_000;

/** 接管重试上限：仅在并发接管的极端竞态下才会消耗，正常路径最多一轮 */
const MAX_ATTEMPTS = 3;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LockLogger = (level: LogLevel, message: string, detail?: Record<string, unknown>) => void;

/** 锁文件内容，三字段固定；缺失任一字段即视为不可用 */
export interface LockRecord {
  pid: number;
  /** 持有者进程的启动时刻（ISO 8601），用于 PID 复用检测 */
  startedAt: string;
  /** 持有者心跳时刻（ISO 8601），活性证据 */
  heartbeatAt: string;
}

export interface LockHolderRef {
  pid: number;
  startedAt: string;
}

export type LockFileState = 'absent' | 'record' | 'unreadable';

/** 接管原因：任务口径的三值；映射到事件负载见 toInstanceTakeoverData() */
export type TakeoverReason = 'pid-gone' | 'stale-heartbeat' | 'pid-reused';

export interface TakeoverRecord {
  file: string;
  /** 被顶替者的 pid；锁文件不可解析时为 null */
  previousPid: number | null;
  /** 被顶替者的最后心跳；缺失时为 null */
  previousHeartbeatAt: string | null;
  staleBecause: TakeoverReason;
  at: string;
}

export interface StolenInfo {
  file: string;
  expectedPid: number;
  expectedStartedAt: string;
  /** 重读到的内容；锁文件消失或不可解析时对应 null */
  observed: LockRecord | null;
  observedState: LockFileState;
}

export class LockHeldError extends Error {
  readonly holder: LockHolderRef;
  readonly file: string;

  constructor(file: string, holder: LockHolderRef) {
    super(`单实例锁已被 pid ${holder.pid}（startedAt ${holder.startedAt}）持有：${file}`);
    this.name = 'LockHeldError';
    this.file = file;
    this.holder = holder;
  }
}

export interface InstanceLock {
  /** 恒为 true：没拿到锁时 acquireInstanceLock 抛错而不是返回对象 */
  readonly owns: boolean;
  readonly file: string;
  readonly pid: number;
  readonly startedAt: string;
  /** 重读锁文件：内容仍是自己才算持有有效 */
  verify(): boolean;
  /** 停止心跳与自检，并仅在锁内容仍是自己时删除锁文件；幂等 */
  release(): void;
}

export interface AcquireOptions {
  log?: LockLogger;
  /** 注入时钟（毫秒）；测试用假时钟驱赶陈旧判定 */
  now?: () => number;
  /** 注入等待；宽限期用真实 setTimeout 会拖慢测试 */
  sleep?: (ms: number) => Promise<void>;
  /** 本次开机时刻（毫秒），默认为 Date.now() - os.uptime()*1000 */
  bootTimeMs?: () => number;
  /** 本进程启动时刻（毫秒），默认为 Date.now() - process.uptime()*1000 */
  processStartedAtMs?: () => number;
  pid?: number;
  /** PID 探活；默认 process.kill(pid, 0)，EPERM 视为存在 */
  isPidAlive?: (pid: number) => boolean;
  heartbeatIntervalMs?: number;
  selfCheckIntervalMs?: number;
  staleHeartbeatMs?: number;
  takeoverGraceMs?: number;
  onTakeover?: (record: TakeoverRecord) => void;
  /** 锁已被他人夺走：调用方负责告警并退出，本模块只保证不再写锁 */
  onStolen?: (info: StolenInfo) => void;
}

interface ResolvedOptions {
  log: LockLogger;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  bootTimeMs: () => number;
  processStartedAtMs: () => number;
  pid: number;
  isPidAlive: (pid: number) => boolean;
  heartbeatIntervalMs: number;
  selfCheckIntervalMs: number;
  staleHeartbeatMs: number;
  takeoverGraceMs: number;
  onTakeover: ((record: TakeoverRecord) => void) | undefined;
  onStolen: ((info: StolenInfo) => void) | undefined;
}

type LockProbe =
  | { state: 'absent' }
  | { state: 'record'; record: LockRecord }
  | { state: 'unreadable' };

type Verdict =
  | { kind: 'retry' }
  | { kind: 'takeover'; record: LockRecord | null; staleBecause: TakeoverReason }
  | { kind: 'held'; holder: LockHolderRef };

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 说明进程存在但没有权限向它发信号，仍按存活处理
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function serialize(record: LockRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function parseRecord(raw: string): LockRecord | null {
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
  const heartbeatAt = obj['heartbeatAt'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== 'string' || typeof heartbeatAt !== 'string') return null;
  return { pid, startedAt, heartbeatAt };
}

function readProbe(file: string): LockProbe {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // 读不到文件 → 未持有；读得到但出错（EACCES 等）→ 不可解析，绝不当成"无人持有"
    return code === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable' };
  }
  const record = parseRecord(raw);
  return record === null ? { state: 'unreadable' } : { state: 'record', record };
}

/** 身份 = pid + startedAt；心跳变化不算换人 */
function sameIdentity(a: LockRecord, b: LockRecord): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

function isStaleHeartbeat(record: LockRecord, opts: ResolvedOptions): boolean {
  const beat = Date.parse(record.heartbeatAt);
  // 心跳不可解析等价于无限陈旧
  if (!Number.isFinite(beat)) return true;
  const age = opts.now() - beat;
  // 时钟回拨会让 age 为负，此时保守判为新鲜，宁可多等一个周期也不误杀
  return age > opts.staleHeartbeatMs;
}

/** 'wx' 排他创建：返回 false 表示已存在（他人持有），其他错误直接抛 */
function createExclusive(file: string, record: LockRecord): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, serialize(record));
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(file);
    } catch {
      // 清理失败即留下不可解析的锁文件，后续会被判为陈旧，不影响正确性
    }
    throw err;
  }
  closeSync(fd);
  return true;
}

/** 原子替换：写 tmp → rename 覆盖。Windows 上 rename 也允许覆盖已存在文件 */
function writeAtomic(file: string, record: LockRecord): void {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, serialize(record));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp 残留无害：名字含 uuid，不会与后续写入冲突
    }
    throw err;
  }
}

function takeoverFrom(probe: LockProbe, staleBecause: TakeoverReason): Verdict {
  return {
    kind: 'takeover',
    record: probe.state === 'record' ? probe.record : null,
    staleBecause,
  };
}

/**
 * 判定当前锁的归属。只有"心跳陈旧且 pid 仍存活"这一条会消耗宽限期；
 * 其余情形均为确定性判据，立即返回。
 */
async function decide(file: string, opts: ResolvedOptions): Promise<Verdict> {
  const first = readProbe(file);
  if (first.state === 'absent') return { kind: 'retry' };
  if (first.state === 'unreadable') {
    // 崩溃遗留（'wx' 建好但没写完就被杀）或外部改写。写入协议保证任何良性持有者
    // 都留下完整可解析的记录，读不懂就说明没有合法持有者，直接接管。
    opts.log('warn', '锁文件不可解析，判定为崩溃遗留并接管', { file });
    return takeoverFrom(first, 'pid-gone');
  }

  const held = first.record;
  if (!opts.isPidAlive(held.pid)) {
    return takeoverFrom(first, 'pid-gone');
  }

  const startedMs = Date.parse(held.startedAt);
  if (!Number.isFinite(startedMs) || startedMs < opts.bootTimeMs() - BOOT_TIME_TOLERANCE_MS) {
    // pid 存活但记录的启动时刻早于本次开机 → 这个 pid 已被别的进程复用，
    // 锁不属于它。心跳对此无能为力（那个 pid 根本不是本程序）。
    opts.log('warn', '锁记录的启动时刻早于本次开机，判定 pid 被复用', {
      pid: held.pid,
      startedAt: held.startedAt,
    });
    return takeoverFrom(first, 'pid-reused');
  }

  if (!isStaleHeartbeat(held, opts)) {
    return { kind: 'held', holder: { pid: held.pid, startedAt: held.startedAt } };
  }

  // 心跳陈旧但 pid 仍活：可能是慢关机、SIGSTOP 或调度饥饿，等一个宽限期再判
  opts.log('info', '心跳陈旧，进入接管宽限期', {
    pid: held.pid,
    heartbeatAt: held.heartbeatAt,
    graceMs: opts.takeoverGraceMs,
  });
  await opts.sleep(opts.takeoverGraceMs);

  const second = readProbe(file);
  if (second.state === 'absent') {
    // 宽限期内原持有者自己释放了，回到正常的排他创建路径
    return { kind: 'retry' };
  }
  if (second.state === 'unreadable') {
    return takeoverFrom(second, 'stale-heartbeat');
  }
  const after = second.record;
  if (!sameIdentity(after, held)) {
    // 锁在宽限期内换了用户：让新持有者的状态决定去留
    if (opts.isPidAlive(after.pid) && !isStaleHeartbeat(after, opts)) {
      return { kind: 'held', holder: { pid: after.pid, startedAt: after.startedAt } };
    }
    return takeoverFrom(second, 'stale-heartbeat');
  }
  if (!opts.isPidAlive(after.pid)) {
    return takeoverFrom(second, 'pid-gone');
  }
  if (!isStaleHeartbeat(after, opts)) {
    // 宽限期内心跳恢复 → 慢关机，放弃接管
    opts.log('info', '宽限期内心跳恢复，放弃接管', { pid: after.pid });
    return { kind: 'held', holder: { pid: after.pid, startedAt: after.startedAt } };
  }
  return takeoverFrom(second, 'stale-heartbeat');
}

class InstanceLockHandle implements InstanceLock {
  readonly owns = true;
  readonly file: string;
  readonly pid: number;
  readonly startedAt: string;

  private record: LockRecord;
  private readonly opts: ResolvedOptions;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private selfCheckTimer: NodeJS.Timeout | null = null;
  private released = false;
  private stolen = false;

  constructor(file: string, record: LockRecord, opts: ResolvedOptions) {
    this.file = file;
    this.record = record;
    this.pid = record.pid;
    this.startedAt = record.startedAt;
    this.opts = opts;

    if (opts.heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => this.beat(), opts.heartbeatIntervalMs);
      // 定时器不阻止进程退出：主循环该是唯一的存活理由
      this.heartbeatTimer.unref();
    }
    if (opts.selfCheckIntervalMs > 0) {
      this.selfCheckTimer = setInterval(() => this.selfCheck(), opts.selfCheckIntervalMs);
      this.selfCheckTimer.unref();
    }
    opts.log('info', '已持有单实例锁', { file, pid: record.pid, startedAt: record.startedAt });
  }

  verify(): boolean {
    if (this.released) return false;
    const probe = readProbe(this.file);
    return probe.state === 'record' && sameIdentity(probe.record, this.record);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.stopTimers();

    const probe = readProbe(this.file);
    if (probe.state !== 'record' || !sameIdentity(probe.record, this.record)) {
      // 锁已易主或消失：删别人的锁会造成双写，坚决不动
      this.opts.log('warn', '释放时锁内容已不是自己，跳过删除', { file: this.file, state: probe.state });
      return;
    }
    try {
      unlinkSync(this.file);
      this.opts.log('info', '已释放单实例锁', { file: this.file, pid: this.pid });
    } catch (err) {
      this.opts.log('warn', '删除锁文件失败', { file: this.file, error: String(err) });
    }
  }

  private beat(): void {
    if (this.released || this.stolen) return;
    // 写前先确认锁仍是自己：否则会把新持有者的锁覆盖掉，那才是真正的双写
    const probe = readProbe(this.file);
    if (probe.state !== 'record' || !sameIdentity(probe.record, this.record)) {
      this.markStolen(probe);
      return;
    }
    const next: LockRecord = { ...this.record, heartbeatAt: new Date(this.opts.now()).toISOString() };
    try {
      writeAtomic(this.file, next);
      this.record = next;
    } catch (err) {
      // 写失败不致命：下个周期重试，持续失败会被自检或上层发现
      this.opts.log('warn', '心跳写入失败，下个周期重试', { file: this.file, error: String(err) });
    }
  }

  private selfCheck(): void {
    if (this.released || this.stolen) return;
    const probe = readProbe(this.file);
    if (probe.state === 'record' && sameIdentity(probe.record, this.record)) return;
    this.markStolen(probe);
  }

  private markStolen(probe: LockProbe): void {
    if (this.stolen) return;
    this.stolen = true;
    this.stopTimers();

    const info: StolenInfo = {
      file: this.file,
      expectedPid: this.pid,
      expectedStartedAt: this.startedAt,
      observed: probe.state === 'record' ? probe.record : null,
      observedState: probe.state,
    };
    this.opts.log('error', '锁已不属于本进程，应立即告警并退出', {
      file: this.file,
      expectedPid: this.pid,
      observedState: probe.state,
      observedPid: info.observed?.pid ?? null,
    });
    const cb = this.opts.onStolen;
    if (cb !== undefined) {
      try {
        cb(info);
      } catch (err) {
        // 回调是调用方的代码，不能让它的异常掀翻定时器
        this.opts.log('error', 'onStolen 回调抛错', { error: String(err) });
      }
    }
  }

  private stopTimers(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.selfCheckTimer !== null) {
      clearInterval(this.selfCheckTimer);
      this.selfCheckTimer = null;
    }
  }
}

function resolveOptions(options: AcquireOptions): ResolvedOptions {
  return {
    log: options.log ?? (() => {}),
    now: options.now ?? Date.now,
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    bootTimeMs: options.bootTimeMs ?? (() => Date.now() - uptime() * 1000),
    processStartedAtMs: options.processStartedAtMs ?? (() => Date.now() - process.uptime() * 1000),
    pid: options.pid ?? process.pid,
    isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    selfCheckIntervalMs: options.selfCheckIntervalMs ?? DEFAULT_SELF_CHECK_INTERVAL_MS,
    staleHeartbeatMs: options.staleHeartbeatMs ?? DEFAULT_STALE_HEARTBEAT_MS,
    takeoverGraceMs: options.takeoverGraceMs ?? DEFAULT_TAKEOVER_GRACE_MS,
    onTakeover: options.onTakeover,
    onStolen: options.onStolen,
  };
}

/**
 * 获取单实例锁。拿到锁返回句柄；确认被他人持有时抛 LockHeldError。
 * 接管成功时先回调 onTakeover（含 staleBecause），再返回句柄——调用方据此写
 * instance/takeover 事件。宽限期内的等待是异步的，故本函数为 async。
 */
export async function acquireInstanceLock(dataDir: string, options: AcquireOptions = {}): Promise<InstanceLock> {
  const opts = resolveOptions(options);
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, LOCK_FILE_NAME);

  const mine: LockRecord = {
    pid: opts.pid,
    startedAt: new Date(opts.processStartedAtMs()).toISOString(),
    heartbeatAt: new Date(opts.now()).toISOString(),
  };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (createExclusive(file, mine)) {
      return new InstanceLockHandle(file, mine, opts);
    }

    const verdict = await decide(file, opts);
    if (verdict.kind === 'retry') continue;
    if (verdict.kind === 'held') {
      throw new LockHeldError(file, verdict.holder);
    }

    // rename 覆盖是原子的，但并发接管时双方都可能以为成功：覆盖后必须回读校验
    writeAtomic(file, mine);
    const check = readProbe(file);
    if (check.state === 'record' && sameIdentity(check.record, mine)) {
      const record: TakeoverRecord = {
        file,
        previousPid: verdict.record?.pid ?? null,
        previousHeartbeatAt: verdict.record?.heartbeatAt ?? null,
        staleBecause: verdict.staleBecause,
        at: new Date(opts.now()).toISOString(),
      };
      opts.log('warn', '已接管陈旧锁', {
        file,
        previousPid: record.previousPid,
        staleBecause: record.staleBecause,
      });
      const cb = opts.onTakeover;
      if (cb !== undefined) {
        try {
          cb(record);
        } catch (err) {
          opts.log('error', 'onTakeover 回调抛错', { error: String(err) });
        }
      }
      return new InstanceLockHandle(file, mine, opts);
    }
    opts.log('warn', '接管出现竞态，锁已被其他进程改写，重新判定', { file });
  }

  const last = readProbe(file);
  const holder: LockHolderRef =
    last.state === 'record' ? { pid: last.record.pid, startedAt: last.record.startedAt } : { pid: 0, startedAt: 'unknown' };
  throw new LockHeldError(file, holder);
}

/**
 * 映射到 schema 的 instance/takeover 事件负载。
 * 'stale-heartbeat' 在 schema 里没有对应取值，归入语义等价的 'no-heartbeat'
 * （心跳超过 90 秒未更新即视为心跳不可用）。
 */
export function toInstanceTakeoverData(record: TakeoverRecord): InstanceTakeover['data'] {
  return {
    previousPid: record.previousPid ?? 0,
    previousHeartbeatAt: record.previousHeartbeatAt ?? new Date(0).toISOString(),
    staleBecause: record.staleBecause === 'stale-heartbeat' ? 'no-heartbeat' : record.staleBecause,
  };
}
