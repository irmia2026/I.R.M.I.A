/**
 * Irmia Agent — 启动恢复七步（docs/design.md §4.7 与 §5 时序）
 *
 * 七步严格按序，顺序不可调换：拿锁 → 修日志 → 重建投影 → 结算未闭合单元 →
 * 恢复定时器 → 恢复水位 → 返回进入主循环。前一步失败就不做后一步：
 * 没有锁的进程去修日志，等于替另一个活着的实例写事件。
 *
 * 恢复流程是运行时而非纯函数，允许读时钟：事件 ts 一律用 new Date().toISOString()。
 * 纯函数约束（不读时钟）只作用于 fold 及其下游渲染。
 *
 * 承诺类事件（sync: true）：恢复期写入的每一条补偿事件都是「外部世界可能已改变」的事实，
 * 必须先落盘；这里不用观测类（sync: false）——恢复期没有 step 边界来兜底 flush。
 *
 * 零外部依赖：只用 node: 标准库。
 */

import { join } from 'node:path';

import { EventLog } from '../log/event-log.ts';
import type {
  AppEvent, InputDeadLetter, InputRequeued, PendingInput, Projection, ToolResult, TurnEnd, WakeSource,
} from '../log/types.js';
import { applyEvent, finalizePressure, fold } from '../state/fold.ts';
import { isCacheValid, loadProjectionCache, saveProjectionCache } from '../state/projection-cache.ts';
import { foldFromSnapshot, loadLatestSnapshot } from '../state/snapshot.ts';
import { TimerStore } from '../wake/timer-store.ts';
import {
  acquireInstanceLock, LockHeldError,
  type AcquireOptions, type InstanceLock, type LockLogger,
} from './instance-lock.ts';

// ──────────────────────────────── 对外类型 ────────────────────────────────

/** 恢复期允许出现的日志级别；与 InstanceLock 的 LockLogger 同口径，便于两边共用实现 */
export type RecoverLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type RecoverLogger = (
  level: RecoverLogLevel,
  message: string,
  extra?: Record<string, unknown>,
) => void;

export interface RecoverDeps {
  /** 数据根目录：事件日志在 <dataDir>/events/，派生缓存在 <dataDir>/*.json */
  dataDir: string;
  log?: RecoverLogger;
  /**
   * 宿主的定时器表。不传时 recover 自建一份指向 <dataDir>/timers.json 的实例，
   * 并用 timersOf() 暴露——M1 阶段没有到期回调的消费者，恢复流程只负责重新布防。
   */
  timers?: TimerStore;
}

export interface RecoverResult {
  lock: InstanceLock;
  log: EventLog;
  projection: Projection;
  /** 本次启动做的补偿动作清单（供启动告警逐条展示） */
  repairs: string[];
}

export const EVENT_LOG_DIR_NAME = 'events';
export const TIMER_FILE_NAME = 'timers.json';
/** 输入被认领多少次后进死信（design.md §4.7「毒消息进死信」） */
export const MAX_CLAIM_COUNT = 3;
/** 重启补投上限：超过只补最近一段并告警（schema.md §9） */
export const MAX_REQUEUE = 200;

/** 内部创建的 TimerStore 按锁对象登记：返回类型里没有它的位置，但必须保持强引用，否则定时器随 GC 消失 */
const internalTimers = new WeakMap<InstanceLock, TimerStore>();

/** 取出 recover 内部创建的定时器表（宿主需要 onDue 回调时应自行通过 RecoverDeps.timers 传入） */
export function timersOf(result: RecoverResult): TimerStore | null {
  return internalTimers.get(result.lock) ?? null;
}

// ──────────────────────────────── 内部工具 ────────────────────────────────

interface Ctx {
  readonly eventDir: string;
  readonly timerPath: string;
  readonly log: RecoverLogger;
  readonly repairs: string[];
  readonly deps: RecoverDeps;
}

/** 恢复期的读写句柄对：日志与投影必须成对传递，避免某一步只更新其中一个 */
interface State {
  log: EventLog;
  projection: Projection;
}

const WAKE_TYPES = new Set<string>([
  'wake/timer', 'wake/file', 'wake/webhook', 'wake/manual', 'wake/heartbeat', 'wake/intention', 'wake/job',
  // IM 通道（M9）：漏了它，来自 QQ 的输入在崩溃重入队时会"查不到原事件"而被丢掉
  'wake/channel',
]);

/** 当前时刻的 ISO 8601（恢复流程是运行时路径，允许读环境时钟） */
function nowIso(): string {
  return new Date().toISOString();
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 分配 seq 并写事件（恢复期一律 sync），随后按归属折进投影，
 * 保证「内存投影 = 日志折叠结果」在恢复结束时依然成立（fold.ts 铁律 2）。
 * 恢复期自己写的事件都不带 `parentCallId`（走 applyOne），除子代理 turn 的补偿收尾——
 * 那一类由 applyEvent 分派，与 fold 全量重建的口径同一份。
 */
function appendEvent(state: State, event: AppEvent): AppEvent {
  const withSeq: AppEvent = { ...event, seq: state.log.nextSeq() } as AppEvent;
  state.log.append(withSeq, { sync: true });
  applyEvent(state.projection, withSeq);
  return withSeq;
}

/** 从日志取回原 wake 事件：输入退回时用它还原来源（fold 只按 wakeSeqs 剔除，不保留来源） */
function wakeEventOrNull(log: EventLog, wakeSeq: number): AppEvent | null {
  const event = log.get(wakeSeq);
  if (event === null) return null;
  return WAKE_TYPES.has(event.type) ? event : null;
}

function wakeSourceOf(type: string | undefined): WakeSource {
  switch (type) {
    case 'wake/timer': return 'timer';
    case 'wake/file': return 'file';
    case 'wake/webhook': return 'webhook';
    case 'wake/intention': return 'intention';
    case 'wake/job': return 'job';
    case 'wake/heartbeat': return 'heartbeat';
    case 'wake/channel': return 'channel';
    default: return 'manual';
  }
}

// ──────────────────────────────── 主流程 ────────────────────────────────

/**
 * 启动恢复七步。
 *
 * 拿锁失败（LockHeldError）在此处记 error 日志并 rethrow：RecoverResult 的形状要求必然持锁，
 * 没有「无锁但返回结果」的合法分支。设计文档 §5 的「告警 + 退出」由调用方在这一层之外执行。
 *
 * @param options 透传给 acquireInstanceLock（onTakeover/onStolen、测试注入假时钟与假 pid 探活）
 */
export async function recover(deps: RecoverDeps, options: AcquireOptions = {}): Promise<RecoverResult> {
  const log: RecoverLogger = deps.log ?? (() => {});
  const ctx: Ctx = {
    eventDir: join(deps.dataDir, EVENT_LOG_DIR_NAME),
    timerPath: join(deps.dataDir, TIMER_FILE_NAME),
    log,
    repairs: [],
    deps,
  };

  // ── 第一步：拿锁 ─────────────────────────────────────────────────────
  // 调用方传入的 log 优先：它可能要在 onTakeover 回调里写 instance/takeover 事件
  const lockLogger: LockLogger = options.log ?? ((level, message, extra) => {
    log(level, message, extra);
  });
  let lock: InstanceLock;
  try {
    lock = await acquireInstanceLock(deps.dataDir, { ...options, log: lockLogger });
  } catch (err) {
    if (err instanceof LockHeldError) {
      log('error', '单实例锁被他人持有，拒绝启动', {
        file: err.file,
        pid: err.holder.pid,
        startedAt: err.holder.startedAt,
      });
    }
    throw err;
  }

  let timers: TimerStore | null = null;
  try {
    // ── 第二步：修日志 ─────────────────────────────────────────────────
    const eventLog = await EventLog.open(ctx.eventDir);
    const state: State = { log: eventLog, projection: emptyProjection() };

    if (eventLog.repair !== null) {
      const repair = eventLog.repair;
      appendEvent(state, {
        ts: nowIso(),
        type: 'log/repaired',
        data: { truncatedBytes: repair.truncatedBytes, lastGoodSeq: repair.lastGoodSeq },
        visibility: 'internal',
        origin: 'runtime/recover',
      } as AppEvent);
      ctx.repairs.push(
        `日志末行自愈：${repair.file} 截断 ${repair.truncatedBytes} 字节，最后完整 seq=${repair.lastGoodSeq}`,
      );
      log('warn', '事件日志末行不完整，已截断并写 log/repaired', {
        file: repair.file,
        truncatedBytes: repair.truncatedBytes,
        lastGoodSeq: repair.lastGoodSeq,
      });
    }

    // ── 第三步：重建投影 ───────────────────────────────────────────────
    // 读缓存是异步的（node:fs/promises），故第三步整体 await
    const cached = await loadProjectionCache(deps.dataDir);
    if (isCacheValid(cached, eventLog.latestSeq())) {
      // 缓存命中也必须重算压力：缓存里的 pressure 是上次启动的参照时刻算出来的，
      // 而压力依赖「距上次发言多久」，只有当前参照时刻才算得对
      // （isCacheValid 是类型谓词，通过即收窄为非 null；取 state 是因为信封还带版本与 lastSeq）
      state.projection = cached.state;
      finalizePressure(state.projection);
      log('info', '投影取自缓存', { lastSeq: state.projection.lastSeq });
    } else {
      // 缓存不可用（不存在 / 落后 / 损坏）：按 schema §8「从最近 checkpoint 重算」，
      // checkpoint 即 data/snapshots/ 里最大 upToSeq 的快照（M5-9）
      state.projection = await restoreProjection(ctx, eventLog);
      finalizePressure(state.projection);
    }

    // ── 第四步：结算未闭合单元 ─────────────────────────────────────────
    // 两处「关 turn 前必须取走」的状态：
    //   turn 号 —— 悬空 tool/result 要回填它归属的 turn；
    //   认领列表 —— fold 的 turn/end 分支会 delete claimedByTurn[turn]，
    //   而退回输入恰恰要读它。顺序对了，输入就不会丢。
    const openTurn = state.projection.openTurn;
    const turnHint = openTurn?.turn ?? 0;
    const claimed = openTurn === null ? [] : [...(state.projection.claimedByTurn[openTurn.turn] ?? [])];
    const claimCounts = openTurn === null
      ? new Map<number, number>()
      : await claimedCountsOf(eventLog, openTurn.turn);
    // 内层先结算：子代理链的开放 turn 补 interrupted，随后才是父 turn 与悬空调用
    // （design §4.21 崩溃恢复：子代理的开放 turn 走同样的未闭合结算，不新增机制）
    await settleChildTurns(ctx, state);
    settleOpenTurn(ctx, state);
    settleOpenTools(ctx, state, turnHint);
    settleClaimedInputs(ctx, state, claimed, claimCounts);

    // 结算后仍有开放单元说明补偿没落地，必须暴露而不是静默继续
    if (state.projection.openTurn !== null || state.projection.openTools.length > 0) {
      ctx.repairs.push(
        `警告：结算后仍有开放单元（turn=${String(state.projection.openTurn?.turn ?? 'none')}, `
        + `openTools=${state.projection.openTools.length}），需要人工检查`,
      );
    }

    // 补偿改动的正是压力的两个输入（pending / needsReview），所以必须重算一次：
    // 否则恢复结束时"内存投影 = 日志折叠结果"这条铁律在 pressure 上不成立——
    // 下一次从同一份日志冷启动（全量折叠，补偿事件已在日志里）会算出另一个值，
    // 而它的消费者（心跳退避）会拿着补偿前的旧值开局。
    finalizePressure(state.projection);

    // ── 第五步：恢复定时器 ─────────────────────────────────────────────
    // 以投影（= 日志折叠结果）为准整体覆盖盘上 hint：timers.json 只是启动加速器
    timers = deps.timers ?? new TimerStore(ctx.timerPath);
    if (deps.timers === undefined) internalTimers.set(lock, timers);
    await timers.importEntries(state.projection.timers);
    // 已过期条目由 TimerStore 按到期先后错峰补触发（相邻 >= 5 秒），恢复流程不干预
    timers.start((entry) => {
      log('debug', '定时器到期（恢复期布防，回调待宿主接管）', { timerId: entry.timerId, at: entry.at });
    });
    if (state.projection.timers.length > 0) {
      ctx.repairs.push(
        `恢复定时器：${state.projection.timers.length} 条来自投影，已布防 ${timers.armedCount()} 个在途句柄`,
      );
    }
    for (const warning of timers.warnings()) ctx.repairs.push(`定时器表：${warning}`);

    // ── 第六步：恢复水位 ───────────────────────────────────────────────
    // M1 简化：水位保持 fold 结果（fold 只累计 lastSeq，不推进 watermark），
    // pending 已经是折叠出的未处理输入。补投上限的截断属 M2 唤醒层职责。
    const pending = state.projection.pending;
    if (pending.length > 0) {
      ctx.repairs.push(`水位恢复：待处理输入 ${pending.length} 条（${describePending(pending)}）`);
      log('info', '水位恢复：未处理输入等待投递', {
        watermark: state.projection.watermark,
        pending: pending.length,
      });
    }

    await saveProjectionCache(deps.dataDir, state.projection, state.projection.lastSeq);

    // ── 第七步：返回 ───────────────────────────────────────────────────
    log('info', '启动恢复完成', {
      repairs: ctx.repairs.length,
      lastSeq: state.projection.lastSeq,
      watermark: state.projection.watermark,
      pending: state.projection.pending.length,
      openTools: state.projection.openTools.length,
      needsReview: state.projection.needsReview.length,
    });
    return { lock, log: eventLog, projection: state.projection, repairs: ctx.repairs };
  } catch (err) {
    // 恢复中途失败必须放锁：否则下次启动会把一个已经死掉的进程判为持有者
    timers?.stop();
    try {
      lock.release();
    } catch {
      // 释放失败不覆盖原始错误
    }
    log('error', '启动恢复失败，已释放单实例锁', { error: messageOf(err) });
    throw err;
  }
}

/** 空投影：走 fold 的同一条规范路径，不直接造字面量 */
function emptyProjection(): Projection {
  return fold([]);
}

/**
 * 全量折叠：流式读日志，逐条 applyOne，不整份事件入内存。
 * 与 fold(readAll()) 严格等价——fold 本身就是「空投影 + 逐条 applyOne + finalizePressure」。
 */
async function foldFromLog(eventLog: EventLog): Promise<Projection> {
  const projection = fold([]);
  for await (const event of eventLog.readAll()) applyEvent(projection, event);
  return projection;
}

/**
 * 兜底重建投影：有可用快照就从快照起算，否则全量折叠（M5-9）。
 *
 * 有一条必须显式拒绝的输入：**快照领先于日志末尾**。它只可能来自"日志被截断/分片被删"，
 * 此时快照描述的是现实里已不存在的事件，采信它等于凭空造出一个水位。宁可全量折叠。
 *
 * 压力（pressure）不在本函数内结算：它依赖"当前参照时刻"，由调用方在两种路径之后统一重算。
 */
async function restoreProjection(ctx: Ctx, eventLog: EventLog): Promise<Projection> {
  const snapshot = await loadLatestSnapshot(ctx.deps.dataDir);
  if (snapshot === null) {
    ctx.log('info', '没有可用快照，投影由日志全量折叠');
    return foldFromLog(eventLog);
  }
  if (snapshot.upToSeq > eventLog.latestSeq()) {
    ctx.log('warn', '快照领先于日志末尾，已放弃快照改为全量折叠（日志可能被截断）', {
      snapshot: snapshot.file,
      upToSeq: snapshot.upToSeq,
      latestSeq: eventLog.latestSeq(),
    });
    return foldFromLog(eventLog);
  }
  const projection = await foldFromSnapshot(eventLog, snapshot);
  // 只记 info 不进 repairs：快照起算是正常加速路径，不是"这次启动做了补偿动作"
  ctx.log('info', '投影由快照增量折叠', {
    snapshot: snapshot.file,
    fromSeq: snapshot.upToSeq,
    lastSeq: projection.lastSeq,
  });
  return projection;
}

// ──────────────────────────────── 第四步：结算 ────────────────────────────────

/**
 * 子代理开放 turn → 每个 `parentCallId` 的未闭合 turn 补 `turn/end{interrupted}`
 * （design §4.21 / milestones M8-2「子 turn 链补 interrupted」）。
 *
 * 为什么这里必须单独扫一遍：子代理链的事件**不参与本层状态机**（见 fold.applySubagentEvent），
 * 所以父投影的 `openTurn` 只可能是父自己的 turn——子代理的未闭合 turn 在投影里根本没有痕迹。
 * 判定依据只有日志本身：同一 `(parentCallId, turn)` 有 `turn/start` 而无 `turn/end` 即为未闭合。
 *
 * 补偿事件带上原 `parentCallId`：它仍然是那条链的收尾，父层的状态机同样不该被它改动。
 * 没有子代理事件时（绝大多数日志）本函数只做一次顺序扫描，不写任何东西。
 */
async function settleChildTurns(ctx: Ctx, state: State): Promise<void> {
  const open = new Map<string, { callId: string; turn: number }>();
  for await (const event of state.log.readAll()) {
    const callId = event.parentCallId;
    if (callId === undefined) continue;
    if (event.type === 'turn/start') {
      open.set(`${callId}#${event.data.turn}`, { callId, turn: event.data.turn });
    } else if (event.type === 'turn/end') {
      open.delete(`${callId}#${event.data.turn}`);
    }
  }
  for (const { callId, turn } of open.values()) {
    appendEvent(state, {
      ts: nowIso(),
      type: 'turn/end',
      // spoke 恒为 false：崩溃时无从得知子代理是否已发言（与父 turn 同一口径）
      data: { turn, reason: { kind: 'interrupted' }, spoke: false },
      visibility: 'internal',
      origin: 'runtime/recover',
      parentCallId: callId,
    } as AppEvent);
    ctx.repairs.push(
      `子代理 turn ${turn}（parentCallId=${callId}）在崩溃时未闭合，已补写 turn/end{interrupted}`,
    );
    ctx.log('warn', '子代理链存在未闭合 turn，已按 interrupted 结算', { turn, parentCallId: callId });
  }
}

/**
 * 开放 turn → turn/end{interrupted}。
 * spoke 恒为 false：崩溃时无从得知模型是否已对外发言，未确认的发言不得声称发生过。
 * 该 turn 认领过的输入由 settleClaimedInputs 退回——刻意分成两步，日志里才是
 * 「turn 已关闭、输入回到待处理」的可读时序。
 */
function settleOpenTurn(ctx: Ctx, state: State): void {
  const open = state.projection.openTurn;
  if (open === null) return;

  const end: TurnEnd = {
    seq: 0, // appendEvent 用 log.nextSeq() 覆盖
    ts: nowIso(),
    type: 'turn/end',
    data: { turn: open.turn, reason: { kind: 'interrupted' }, spoke: false },
    visibility: 'internal',
    origin: 'runtime/recover',
  };
  appendEvent(state, end);
  ctx.repairs.push(`上一次运行异常退出：turn ${open.turn} 补写 turn/end{interrupted}`);
  ctx.log('warn', '发现未闭合 turn，已按 interrupted 结算', { turn: open.turn, step: open.step });
}

/**
 * 悬空 tool/call 三态结算（design.md §4.7 第三态）：
 *   none / idempotent → 可重试，写 tool/zombie 记 note，不写 result（留给 loop 重跑该调用）
 *   destructive       → 结果未知，写 tool/zombie + tool/result{status:'unknown'} 并进入待确认
 *
 * 关键点：绝不替 destructive 调用猜结果。「到底发出去了没有」系统无从得知，
 * 承认不知道，让模型在下一步看到 unknown 这一事实（needsReview 由 fold 自然产生）。
 */
function settleOpenTools(ctx: Ctx, state: State, turnHint: number): void {
  for (const call of [...state.projection.openTools]) {
    if (call.sideEffect !== 'destructive') {
      // 可重试调用**也要收尾**（2026-10-02 补，用户："两个兜底你去写一下吧"）。
      //
      // 原实现刻意不写事件（怕 `tool/zombie` 留下永远清不掉的开放项、每次启动重复累积）——
      // 那个顾虑对 `tool/zombie` 成立，但**写 `tool/result` 恰恰是"收尾"**：折叠一见 result
      // 就把这条从 openTools 里摘掉，于是 `openTools` 不再一直挂着一个；而"那次调用没跑完"
      // 这件事也从此**落在日志里**（以前只有渲染层每次现补一句占位，日志里查不到）。
      // 结果写成 error 而不是 ok：结果未知，绝不让她以为它成功了。
      const note = '进程在调用执行期间退出，这次调用没有跑完；结果未知，要重做就再调一次';
      const result: ToolResult = {
        seq: 0,
        ts: nowIso(),
        type: 'tool/result',
        data: {
          turn: turnHint,
          step: 0,
          callId: call.callId,
          callSeq: call.callSeq,
          status: 'error',
          content: '（这次调用没有跑完：进程在它执行期间退出。结果未知——不要当成成功；要重做就再调一次。）',
          error: { message: note, code: 'recovered-unfinished' },
        },
        visibility: 'model',
        origin: 'runtime/recover',
      };
      appendEvent(state, result);
      ctx.repairs.push(`悬空 ${call.sideEffect} 调用 ${call.name}(${call.callId}) 记为"没跑完"并收尾`);
      ctx.log('info', '悬空工具调用已收尾', { callId: call.callId, name: call.name, sideEffect: call.sideEffect });
      continue;
    }

    const note = '进程在调用执行期间退出，有副作用的调用结果未知；不自动重试，需人工或查外部状态确认';
    appendEvent(state, {
      ts: nowIso(),
      type: 'tool/zombie',
      data: { callId: call.callId, name: call.name, note },
      visibility: 'internal',
      origin: 'runtime/recover',
    } as AppEvent);

    const result: ToolResult = {
      seq: 0,
      ts: nowIso(),
      type: 'tool/result',
      data: {
        turn: turnHint,
        step: 0,
        callId: call.callId,
        callSeq: call.callSeq,
        status: 'unknown',
        content: 'Its outcome is unknown.',
        error: { message: note, code: 'recovered-unknown' },
      },
      visibility: 'model',
      origin: 'runtime/recover',
    };
    appendEvent(state, result);
    ctx.repairs.push(`悬空 destructive 调用 ${call.name}(${call.callId}) 标记为 unknown 并进入待确认`);
    ctx.log('warn', '悬空 destructive 工具调用已标记 unknown', { callId: call.callId, name: call.name });
  }
}

/**
 * 从日志取回该 turn 认领过的每一条输入的认领次数（**按 wakeSeq 索引**）。
 *
 * 为什么用 Map 而不是数组：同一个 turn 可以**分批**认领——turn 开头一笔，中途被她看见的
 * 插话各一笔（agent-loop 的 `claimInterruption`）。数组那种"第 i 个对应第 i 个"的契约在分批
 * 之后就成了两份不同来源的列表在对齐，错位一次就把认领次数记到别人头上；
 * 按 seq 索引则没有位可错。同一 seq 出现在多笔账里时取**最后**一笔（后写的才是最新事实）。
 *
 * 语义：`input/claimed.claimCounts[i]` 是「本次认领之前已完成的认领次数」，
 * 范围 0..MAX_CLAIM_COUNT-1（PendingInput.claimCount 的初值与 loop 的写法一致）。
 * 所以退回时 +1 得到「本次认领之后累计次数」，达到 MAX_CLAIM_COUNT 才判毒消息——
 * 这正是「同一输入被认领 3 次仍未能完成」的判定点。
 *
 * 为什么必须回日志：投影的 claimedByTurn 只留 wakeSeq（number[]），认领次数在
 * input/claimed 折叠时被丢掉——pending 里读不到（认领即从 pending 删除），
 * 而改动 claimedByTurn 的形状会破坏 schema.md 与既有 fold 契约。
 * 日志是唯一真相源：readRange 走分片 + 检查点，不整份事件入内存。
 */
async function claimedCountsOf(eventLog: EventLog, turn: number): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  for await (const event of eventLog.readRange(1)) {
    if (event.type !== 'input/claimed' || event.data.turn !== turn) continue;
    event.data.wakeSeqs.forEach((wakeSeq, i) => {
      counts.set(wakeSeq, event.data.claimCounts[i] ?? 0);
    });
  }
  return counts;
}

/**
 * 退回开放 turn 认领过的输入（claimCount +1）。
 * wakeSeqs / claimCounts 由调用方在关 turn 之前快照传入：fold 的 turn/end 分支会清掉
 * claimedByTurn，认领次数则只存在于 input/claimed 事件里。
 *
 * 达 MAX_CLAIM_COUNT 的输入进死信、不再自动认领——否则一条必然致崩的输入会把守护进程
 * 拖进「拉起 → 崩溃 → 拉起」死循环，且崩溃发生在预算检查之外，刹车拦不住。
 */
function settleClaimedInputs(
  ctx: Ctx,
  state: State,
  wakeSeqs: readonly number[],
  claimCounts: ReadonlyMap<number, number>,
): void {
  if (wakeSeqs.length === 0) return;

  const requeueSeqs: number[] = [];
  const requeueCounts: number[] = [];
  const requeueSources: WakeSource[] = [];

  for (const wakeSeq of wakeSeqs) {
    // 本次认领前的累计次数；+1 = 本次认领后的累计次数
    const nextCount = (claimCounts.get(wakeSeq) ?? 0) + 1;

    if (nextCount >= MAX_CLAIM_COUNT) {
      const deadLetter: InputDeadLetter = {
        seq: 0,
        ts: nowIso(),
        type: 'input/dead-letter',
        data: {
          inputSeq: wakeSeq,
          claimCount: nextCount,
          lastError: '同一输入反复认领后均撞上进程退出，不再自动认领',
          // **为什么进死信**要能一眼看出是哪一类（2026-10-16 加）：界面读字段、读不了自由文本，
          // 而"认领到上限"与"用户按下 /stop"的下一步动作完全不同。
          reason: 'claim-limit',
        },
        visibility: 'internal',
        origin: 'runtime/recover',
      };
      appendEvent(state, deadLetter);
      ctx.repairs.push(`输入 seq=${wakeSeq} 认领 ${nextCount} 次仍未完成，转入死信队列`);
      ctx.log('error', '输入转入死信队列（毒消息保护）', { inputSeq: wakeSeq, claimCount: nextCount });
      continue;
    }

    // 输入来源只认原 wake 事件；投影 pending 里已经没有它（认领即删）
    const wakeEvent = wakeEventOrNull(state.log, wakeSeq);
    const source: WakeSource = wakeSourceOf(wakeEvent?.type);
    requeueSeqs.push(wakeSeq);
    requeueCounts.push(nextCount);
    requeueSources.push(source);
    if (wakeEvent === null) {
      ctx.log('warn', '退回输入找不到原 wake 事件，按投影中的来源还原', { wakeSeq, source });
    }
  }

  if (requeueSeqs.length === 0) return;
  const requeued: InputRequeued = {
    seq: 0,
    ts: nowIso(),
    type: 'input/requeued',
    data: {
      wakeSeqs: requeueSeqs,
      claimCounts: requeueCounts,
      sources: requeueSources,
      reason: 'turn-interrupted',
    },
    visibility: 'internal',
    origin: 'runtime/recover',
  };
  appendEvent(state, requeued);
  ctx.repairs.push(`退回输入 ${requeueSeqs.length} 条（seq ${requeueSeqs.join(',')}），等待重新认领`);
}

// ──────────────────────────────── 第六步：补投摘要 ────────────────────────────────

/** 按来源聚合 pending，超过补投上限时明确写出被截断的条数（不静默丢弃） */
function describePending(pending: readonly PendingInput[]): string {
  const head = pending.slice(0, MAX_REQUEUE);
  const bySource = new Map<WakeSource, number>();
  for (const item of head) bySource.set(item.source, (bySource.get(item.source) ?? 0) + 1);
  const parts = [...bySource.entries()].map(([source, count]) => `${source}×${count}`);
  const tail = pending.length > head.length
    ? `，另 ${pending.length - head.length} 条超出补投上限 ${MAX_REQUEUE}`
    : '';
  return `${parts.join('、')}${tail}`;
}
