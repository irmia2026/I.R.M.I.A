/**
 * Irmia Agent — M1 假循环（docs/design.md §4.4、milestones.md M1 交付物 7）
 *
 * 只写不干：发现 pending 就写 `turn/start` → `input/claimed` → `message/user`（一条摘要）
 * → `turn/end{completed}`，不调模型、不执行工具。M2 会把这里换成真正的 turn/step 双层循环，
 * 但本文件里有两件事它必须原样继承：
 *   1. 投影与日志的一致性维护（日志尾部轮询 + 增量 applyOne）；
 *   2. 水位推进（schema §9）。
 *
 * 分工边界：启动恢复七步在 runtime/recover.ts（含补锁、修日志、结算未闭合单元、重建投影、
 * 恢复定时器），本模块只管"跑起来之后"。recover 第六步刻意不推进 watermark，把这件事
 * 留给唤醒层——就是这里。
 *
 * 约定：值导入写 `.ts`（Node 的 --experimental-strip-types 只擦类型、不改写路径解析，
 * 写 .js 会 ERR_MODULE_NOT_FOUND；tsc 输出时由 rewriteRelativeImportExtensions 改回 .js）。
 * 纯类型导入写 `.js` 无妨——它们会被整体擦除。
 */

import type { EventLog } from '../log/event-log.js';
import type { AppEvent, Projection, UserMessage, WakeSource } from '../log/types.js';
import { defaultVisibility, emptyProjection } from '../log/types.ts';
import { saveProjectionCache } from '../state/projection-cache.ts';
import { applyOne, finalizePressure } from '../state/fold.ts';
import type { WakeEmission, WakeSink } from '../wake/sources.js';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 日志尾部轮询间隔 */
export const DEFAULT_LOOP_POLL_MS = 500;

/** 单拍认领上限：M1 只是写摘要，但上限要在骨架里就立住，免得 M2 接模型时忘了 */
export const DEFAULT_BATCH_LIMIT = 50;

// ──────────────────────────────── 事件写入 ────────────────────────────────

/** 承诺类写入唯一入口：分配 seq → fsync 落盘 → 折进投影。返回落盘后的事件 */
function appendEvent(
  log: EventLog,
  projection: Projection,
  type: string,
  data: unknown,
  now: () => Date,
  origin: string,
): AppEvent {
  const event = {
    seq: log.nextSeq(),
    ts: now().toISOString(),
    type,
    data,
    // 可见性一律走 schema 表，不在写入点手填，避免两处口径漂移
    visibility: defaultVisibility(type),
    origin,
  } as unknown as AppEvent;
  log.append(event, { sync: true });
  applyOne(projection, event);
  return event;
}

// ──────────────────────────────── 水位 ────────────────────────────────

/**
 * 水位推进（docs/schema.md §9 的 M1 口径）。
 *
 * 水位是"连续已消化到的位置"：还有未消化的 pending 时停在最早一条之前，
 * 否则推进到日志末尾。空洞（崩溃留下的缺号）直接跳过——水位不能因为一个缺号
 * 永远卡住，这是 M1-3 验收点。
 *
 * 与 schema §9 原版的差异：原版基于本拍维护的 `handled` 集合逐条判定；M1 的循环是
 * "折进投影 + 批量认领"，等价判据是 lastSeq（已折进投影的位置）加 pending（尚未消化）。
 * M2 接上逐条处理后会换回原版，对外语义不变。水位只增不减。
 */
export function advanceWatermark(log: EventLog, projection: Projection): number {
  const latest = log.latestSeq();
  const pendingSeqs = projection.pending.map((item) => item.wakeSeq);
  const stopAt = pendingSeqs.length > 0 ? Math.min(...pendingSeqs) - 1 : latest;

  let top = projection.watermark;
  for (let seq = top + 1; seq <= latest && seq <= stopAt; seq++) {
    if (seq <= projection.lastSeq) {
      top = seq;
      continue;
    }
    // 有内容却没折进投影：本拍之后新写的，水位不能越过它
    if (log.get(seq) === null) {
      top = seq;
      continue;
    }
    break;
  }
  projection.watermark = top;
  return top;
}

/** 日志中出现过的最大 turn 号：假循环据此续号，绝不回退复用旧号 */
export async function maxTurnOfLog(log: EventLog): Promise<number> {
  let max = 0;
  for await (const event of log.readAll()) {
    if (event.type === 'turn/start' && event.data.turn > max) max = event.data.turn;
  }
  return max;
}

// ──────────────────────────────── 假循环 ────────────────────────────────

export interface FakeLoopOptions {
  log: EventLog;
  /** 数据目录：投影缓存写在 <dataDir>/projection.json */
  dataDir: string;
  /** 续号起点，取 maxTurnOfLog */
  startTurn?: number;
  /** 起始投影，取 recover() 的投影 */
  projection?: Projection;
  pollMs?: number;
  batchLimit?: number;
  now?: () => Date;
  origin?: string;
}

interface PendingItem {
  wakeSeq: number;
  source: WakeSource;
  text: string;
}

/** 唤醒事件的摘要文本：写成一行中文，便于 tail 日志时直接读懂这一拍为什么醒 */
function describeWake(event: AppEvent | null): string {
  if (event === null) return '内容缺失（seq 空洞）';
  switch (event.type) {
    case 'wake/timer': return `定时器 ${event.data.timerId} 到期`;
    case 'wake/manual': return `手动注入：${event.data.note}`;
    case 'wake/file': return `文件变化：${event.data.path}`;
    case 'wake/webhook': return `回调：${event.data.path}`;
    case 'wake/intention': return `意图到期：${event.data.content}`;
    case 'wake/job': return `后台任务完成：${event.data.jobId}`;
    case 'wake/channel': {
      const where = event.data.chatType === 'c2c' ? '私聊' : event.data.chatType === 'group-at' ? '群@' : '群';
      return `IM 消息（${event.data.channel}/${where}）：${event.data.text.slice(0, 60)}`;
    }
    default: return `唤醒：${event.type}`;
  }
}

function buildSummary(items: readonly PendingItem[]): string {
  const counts = new Map<WakeSource, number>();
  for (const item of items) counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
  const dist = [...counts.entries()].map(([source, n]) => `${source}×${n}`).join('、');
  return `${items.length} 条待办（${dist}）：${items[0]?.text ?? ''}`;
}

/**
 * 待办批次的 message/user.source。`WakeSource` 里的 `manual` 在消息语义上就是人说话
 * （CLI 注入），映射成 `human`；`heartbeat` 不在消息来源枚举里（心跳不产生 pending），
 * 真走到那里说明上游违约，按 timer 记账而不是崩溃。
 */
function userMessageSourceOf(source: WakeSource): UserMessage['data']['source'] {
  switch (source) {
    case 'manual': return 'human';
    case 'timer': return 'timer';
    case 'file': return 'file';
    case 'webhook': return 'webhook';
    case 'intention': return 'intention';
    case 'job': return 'job';
    case 'channel': return 'human'; // IM 通道消息语义上是人说话
    case 'heartbeat': return 'timer';
  }
}

/**
 * M1 假循环。它实现了 WakeSink，所以唤醒源可以直接把唤醒交给它——
 * 生产者只声明"发生了什么"，这里负责"落进日志并推进投影"。
 */
export class FakeLoop implements WakeSink {
  readonly projection: Projection;

  private readonly log: EventLog;
  private readonly dataDir: string;
  private readonly pollMs: number;
  private readonly batchLimit: number;
  private readonly now: () => Date;
  private readonly origin: string;
  private timer: NodeJS.Timeout | null = null;
  private turnCounter: number;
  private writtenCount = 0;

  constructor(options: FakeLoopOptions) {
    this.log = options.log;
    this.dataDir = options.dataDir;
    this.pollMs = options.pollMs ?? DEFAULT_LOOP_POLL_MS;
    this.batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
    this.now = options.now ?? (() => new Date());
    this.origin = options.origin ?? 'runtime/loop';
    this.projection = options.projection ?? emptyProjection();
    this.turnCounter = options.startTurn ?? 0;
  }

  /** 本进程写过的 turn 号上界（诊断用） */
  get lastTurn(): number {
    return this.turnCounter;
  }

  /** 本进程写入的事件条数（诊断用） */
  get writtenEvents(): number {
    return this.writtenCount;
  }

  get pendingCount(): number {
    return this.projection.pending.length;
  }

  /** 定时器到期记账（internal）：投影据此把一次性条目出表、周期条目结算下一拍 */
  timerFired(timerId: string): void {
    this.append('timer/fired', { timerId });
  }

  /** 唤醒事件（model，承诺类）：返回时已在磁盘上，调用方随后才能删外部文件 */
  wake(emission: WakeEmission): void {
    this.append(emission.type, emission.data);
  }

  /** 起拍：先跑一拍（把启动前遗留的 pending 消化掉），再按 pollMs 轮询 */
  start(): void {
    if (this.timer !== null) return;
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.pollMs);
    // 刻意不 unref：这个轮询就是主进程的存活理由。一旦 unref，进程会在没有在途定时器时
    // 静默退出——实测就是只写了 session/start 就结束，待办永远没人认领。
    // 其余附属定时器（看门目录轮询、锁心跳）保持 unref，它们不该单独维持进程存活。
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 跑一拍：拾取日志尾部新事件（含别的模块写进来的）→ 消化 pending → 推进水位 → 落投影缓存。
   * 返回本拍写入的事件条数，便于测试与观测。
   */
  async runOnce(): Promise<number> {
    const before = this.projection.lastSeq;
    const beforeWatermark = this.projection.watermark;
    let written = this.pollTail();
    written += this.drainPending();
    advanceWatermark(this.log, this.projection);
    if (this.projection.lastSeq !== before || this.projection.watermark !== beforeWatermark) {
      finalizePressure(this.projection, this.now().toISOString());
      await this.writeProjectionCache();
    }
    return written;
  }

  /**
   * 日志尾部轮询：把 lastSeq 之后的事件逐条折进投影。空 seq（崩溃空洞）直接跳过——
   * 水位不能因为一个缺号卡住（schema §9）。自己写的事件已经折过，不会被重复应用。
   */
  pollTail(): number {
    const latest = this.log.latestSeq();
    let applied = 0;
    for (let seq = this.projection.lastSeq + 1; seq <= latest; seq++) {
      const event = this.log.get(seq);
      if (event === null) continue;
      applyOne(this.projection, event);
      applied += 1;
    }
    return applied;
  }

  /**
   * 消化待办：一批 pending 写一个 turn——`turn/start` → `input/claimed`（认领，承诺类）
   * → `message/user`（摘要）→ `turn/end{completed}`。不调模型，`spoke: false`。
   * 批次以最早一条输入的来源定性 message/user.source，来源分布写在摘要文本里。
   */
  drainPending(): number {
    const batch = this.projection.pending.slice(0, this.batchLimit);
    if (batch.length === 0) return 0;

    const items: PendingItem[] = batch.map((entry) => ({
      wakeSeq: entry.wakeSeq,
      source: entry.source,
      text: describeWake(this.log.get(entry.wakeSeq)),
    }));

    const turn = this.turnCounter + 1;
    this.append('turn/start', { turn });
    this.append('input/claimed', {
      turn,
      wakeSeqs: items.map((item) => item.wakeSeq),
      claimCounts: batch.map((entry) => entry.claimCount),
    });
    this.append('message/user', { text: buildSummary(items), source: userMessageSourceOf(items[0]!.source) });
    this.append('turn/end', { turn, reason: { kind: 'completed' }, spoke: false });
    this.turnCounter = turn;
    return 4;
  }

  /**
   * 投影落盘（复用 state/projection-cache.ts 的信封与 tmp+rename 规则）。
   * 缓存只是加速启动的 hint：写失败不打断循环，真相始终在事件日志里。
   */
  async writeProjectionCache(): Promise<void> {
    try {
      await saveProjectionCache(this.dataDir, this.projection, this.projection.lastSeq);
    } catch (err) {
      void err;
    }
  }

  private append(type: string, data: unknown): AppEvent {
    const event = appendEvent(this.log, this.projection, type, data, this.now, this.origin);
    this.writtenCount += 1;
    return event;
  }
}
