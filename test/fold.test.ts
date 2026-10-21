/**
 * fold 折叠函数测试 — src/state/fold.ts
 *
 * 覆盖 docs/milestones.md M1-4（折叠确定性）与 docs/schema.md §8（状态投影）、
 * §12（不变量清单）中可折叠验证的部分：
 *   折叠确定性 / 全量与增量一致 / 工具生命周期 / 输入生命周期 / dedupe 窗口 /
 *   预算累计与清零 / 定时器表 / 压力结算 / 纯函数性 / turn 收口。
 *
 * 全部事件用固定 ts（2020-06-01 起）与自增 seq 构造，不读环境时钟、不碰文件系统。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyEvent, applyOne, finalizePressure, fold } from '../src/state/fold.ts';
import { defaultVisibility, emptyProjection } from '../src/log/types.ts';
import type {
  AlarmSent, AppEvent, AssistantMessage, BudgetConsumed, BudgetExhausted,
  BudgetRollover, BudgetResumed, BudgetToppedUp, CompactionSummary, ConfigChanged,
  DeveloperMessage, HumanAnswered, HumanAsked, InputClaimed, InputDeadLetter,
  InputRequeued, InstanceTakeover, IntentionActed, IntentionRaised, JobFinished,
  JobStarted, LogRepaired, McpServerStarted, McpServerStopped, ModelDegraded,
  ModelRestored, PersonaUpdated, PolicyDenied, Projection, ReviewResolved,
  SessionEnd, SessionStart, SnapshotCheckpoint, SpeakSent, StepEnd, StepStart,
  TimerCancelled, TimerFired, TimerSet, TodoUpdated, ToolCall, ToolResult,
  ToolZombie, TurnEnd, TurnStart, UserMessage, WakeFile, WakeHeartbeat,
  WakeIntention, WakeJob, WakeManual, WakeTimer, WakeWebhook,
} from '../src/log/types.ts';

// ──────────────────────────────── 测试脚手架 ────────────────────────────────

const T0_MS = Date.parse('2020-06-01T00:00:00.000Z');
const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
/** 底噪：emptyProjection 与 finalizePressure 的起点 */
const BASE_PRESSURE = 0.05;

function tsAfter(minutes: number): string {
  return new Date(T0_MS + minutes * MIN_MS).toISOString();
}

let autoSeq = 0;
let autoTick = 0;

/** 每个用例开头重置，保证同一构造函数的输出逐字节可复现 */
function resetFactory(): void {
  autoSeq = 0;
  autoTick = 0;
}

interface EvPatch {
  seq?: number;
  ts?: string;
  origin?: string;
}

/**
 * 事件工厂：seq 自增，ts 默认按分钟自增；需要精确值时用 patch 覆盖。
 * 显式给出类型参数（evt<ToolCall>(...)）以便类型检查能验证 data 形状。
 */
function evt<T extends AppEvent>(type: T['type'], data: T['data'], patch: EvPatch = {}): T {
  autoSeq += 1;
  autoTick += 1;
  const seq = patch.seq ?? autoSeq;
  const ts = patch.ts ?? tsAfter(autoTick);
  return {
    seq,
    ts,
    type,
    data,
    visibility: defaultVisibility(type),
    ...(patch.origin !== undefined ? { origin: patch.origin } : {}),
  } as unknown as T;
}

/** 逐条 applyOne 的增量路径（不结算压力） */
function incrementalOf(events: AppEvent[]): Projection {
  const p = emptyProjection();
  for (const e of events) applyOne(p, e);
  return p;
}

/** 增量路径 + 一次压力结算 */
function pressureOf(events: AppEvent[], referenceTs?: string): number {
  const p = incrementalOf(events);
  finalizePressure(p, referenceTs);
  return p.pressure;
}

/**
 * 混合全部主要类型的事件序列（覆盖 50 余种事件），供确定性与一致性测试共用。
 * 顺序刻意做成「真实一次会话的形状」：turn 开启 → 工具调用 → 预算扣减 →
 * 唤醒入队 → 认领与退回 → 定时器增删 → 收口。
 */
function buildMixedLog(): AppEvent[] {
  resetFactory();
  const log: AppEvent[] = [];
  const push = (...es: AppEvent[]): void => {
    for (const e of es) log.push(e);
  };

  push(
    evt<SessionStart>('session/start', {
      pid: 4242, cwd: 'D:\\agent', version: '0.1.0', schemaVersion: '1', configHash: 'h0',
    }),
    evt<TurnStart>('turn/start', { turn: 1 }),
    evt<StepStart>('step/start', {
      turn: 1, step: 0, model: 'heavy-1', lane: 'heavy', renderVersion: 'r1', personaHash: 'p1',
    }),
    evt<UserMessage>('message/user', { text: '看下备份', source: 'human' }),
    evt<AssistantMessage>('message/assistant', { text: '在，先读日志。', toolCalls: [] }),
  );

  const c1 = evt<ToolCall>('tool/call', {
    turn: 1, step: 0, callId: 'c1', name: 'read_file', arguments: '{"path":"INBOX.md"}', sideEffect: 'none',
  });
  const c2 = evt<ToolCall>('tool/call', {
    turn: 1, step: 0, callId: 'c2', name: 'shell', arguments: '{"cmd":"backup"}', sideEffect: 'destructive',
  });
  push(c1, c2);
  push(evt<ToolResult>('tool/result', {
    turn: 1, step: 0, callId: 'c1', callSeq: c1.seq, status: 'ok', content: 'ok', durationMs: 3,
  }));
  push(evt<ToolResult>('tool/result', {
    turn: 1, step: 0, callId: 'c2', callSeq: c2.seq, status: 'unknown', content: '',
  }));
  push(evt<ReviewResolved>('review/resolved', {
    callId: 'c2', outcome: 'succeeded', note: '人工确认备份确实完成', by: 'human',
  }));
  // c3 保持开放：§12-9 允许「恢复结算前」的开放调用存在于投影里
  push(evt<ToolCall>('tool/call', {
    turn: 1, step: 1, callId: 'c3', name: 'shell', arguments: '{}', sideEffect: 'idempotent',
  }));
  push(evt<StepEnd>('step/end', { turn: 1, step: 0, toolCalls: 2 }));

  push(
    evt<BudgetConsumed>('budget/consumed', {
      turn: 1, step: 0, lane: 'heavy', model: 'heavy-1',
      inputTokens: 800, outputTokens: 200, cacheHitTokens: 500, cacheMissTokens: 500,
      durationMs: 12, retryCount: 0, finishReason: 'completed', tokensTodayAccum: 9999,
    }),
    evt<BudgetConsumed>('budget/consumed', {
      turn: 1, step: 1, lane: 'light', model: 'light-1',
      inputTokens: 100, outputTokens: 50, cacheHitTokens: 10, cacheMissTokens: 140,
      durationMs: 5, retryCount: 0, finishReason: 'failed', tokensTodayAccum: 0,
    }),
    evt<BudgetExhausted>('budget/exhausted', { layer: 'daily', limit: 100_000, actual: 100_010, resumable: true }),
    evt<BudgetToppedUp>('budget/topped-up', { layer: 'daily', addedTokens: 50_000, by: 'human' }),
    evt<BudgetRollover>('budget/rollover', { date: '2020-06-02' }),
    evt<BudgetConsumed>('budget/consumed', {
      turn: 1, step: 1, lane: 'light', model: 'light-1',
      inputTokens: 60, outputTokens: 20, cacheHitTokens: 5, cacheMissTokens: 75,
      durationMs: 4, retryCount: 1, finishReason: 'completed', tokensTodayAccum: 9999,
    }),
  );

  const wf = evt<WakeFile>('wake/file', { path: 'INBOX.md', kind: 'changed', dedupeKey: 'file:INBOX.md' });
  const wt = evt<WakeTimer>('wake/timer', { timerId: 'tm1', scheduledAt: tsAfter(1), firedAt: tsAfter(2) });
  const ww = evt<WakeWebhook>('wake/webhook', { path: '/hook/x', body: '{}', headers: { 'x-id': '1' }, dedupeKey: 'hook:x' });
  const wm = evt<WakeManual>('wake/manual', { note: '手动戳一下' });
  const wi = evt<WakeIntention>('wake/intention', { intentionId: 'i1', content: '检查备份' });
  const wj = evt<WakeJob>('wake/job', { jobId: 'job1' });
  push(wf, wt, ww, wm, wi, wj);
  push(evt<WakeHeartbeat>('wake/heartbeat', { quietSeconds: 900, idleTicks: 2, pressure: 0.2, probability: 0.4, roll: 0.2 }));
  push(evt<InputClaimed>('input/claimed', { turn: 1, wakeSeqs: [wf.seq, wt.seq], claimCounts: [0, 0] }));
  push(evt<InputRequeued>('input/requeued', {
    wakeSeqs: [wf.seq], claimCounts: [1], sources: ['file'], reason: 'turn-interrupted',
  }));
  push(evt<InputDeadLetter>('input/dead-letter', { inputSeq: wt.seq, claimCount: 3, lastError: '反复被中断' }));

  push(
    evt<TimerSet>('timer/set', { timerId: 'a1', at: tsAfter(60), payload: { note: 'a' } }),
    evt<TimerSet>('timer/set', { timerId: 'a2', cron: '0 9 * * *', payload: null }),
    evt<TimerSet>('timer/set', { timerId: 'a1', at: tsAfter(90), payload: { note: 'b' } }),
    evt<TimerCancelled>('timer/cancelled', { timerId: 'a2' }),
    evt<TimerFired>('timer/fired', { timerId: 'a1' }),
  );

  push(
    evt<IntentionRaised>('intention/raised', { intentionId: 'i9', content: '给 YG 发周报', triggerAt: tsAfter(120) }),
    evt<IntentionRaised>('intention/raised', {
      intentionId: 'i9', content: '给 YG 发周报（改到 3 点）', triggerAt: tsAfter(180), condition: '无人工干预',
    }),
    evt<IntentionActed>('intention/acted', { intentionId: 'i9', turn: 1 }),
    evt<IntentionRaised>('intention/raised', { intentionId: 'i10', content: '盯着磁盘水位', triggerAt: tsAfter(240) }),
    evt<TodoUpdated>('todo/updated', {
      items: [{ content: '写测试', status: 'in_progress' }, { content: '跑 tsc', status: 'pending' }],
    }),
    evt<JobStarted>('job/started', { jobId: 'job1', command: 'pwsh -File backup.ps1', turn: 1 }),
    evt<JobFinished>('job/finished', { jobId: 'job1', exitCode: 0 }),
    evt<HumanAsked>('human/asked', { question: '备份要外传吗？', context: '备份已完成', turn: 1 }),
    evt<HumanAnswered>('human/answered', { question: '备份要外传吗？', answer: '不要', by: 'human' }),
    evt<SnapshotCheckpoint>('snapshot/checkpoint', { upToSeq: 40, file: 'events/0001.jsonl' }),
    evt<ModelDegraded>('model/degraded', { lane: 'heavy', reason: '上游 5xx' }),
    evt<ModelRestored>('model/restored', { lane: 'heavy' }),
    evt<PolicyDenied>('policy/denied', { tool: 'shell', rule: 'command-denylist', reason: 'rm -rf /', callId: 'c9' }),
    evt<LogRepaired>('log/repaired', { truncatedBytes: 12, lastGoodSeq: 41 }),
    evt<InstanceTakeover>('instance/takeover', {
      previousPid: 111, previousHeartbeatAt: tsAfter(1), staleBecause: 'no-heartbeat',
    }),
    evt<DeveloperMessage>('developer/message', { added: ['read_file'], removed: [] }),
    evt<McpServerStarted>('mcp/server-started', { name: 'fs', pid: 9, tools: ['read'] }),
    evt<McpServerStopped>('mcp/server-stopped', { name: 'fs', reason: 'idle-reclaim' }),
    evt<SpeakSent>('speak/sent', { channel: 'notify', chars: 42 }),
    evt<AlarmSent>('alarm/sent', { fingerprint: 'fp1', level: 'warn', title: '预算接近上限' }),
    evt<CompactionSummary>('compaction/summary', { coveredUpToSeq: 30, summary: '……' }),
    evt<PersonaUpdated>('persona/updated', { file: 'persona/IDENTITY.md', diffHash: 'd1', by: 'agent' }),
    evt<ToolZombie>('tool/zombie', { callId: 'c3', name: 'shell', note: '恢复时未配对' }),
    evt<StepEnd>('step/end', { turn: 1, step: 1, toolCalls: 0 }),
    evt<TurnEnd>('turn/end', { turn: 1, reason: { kind: 'interrupted' }, spoke: true }),
  );

  push(
    evt<TurnStart>('turn/start', { turn: 2 }),
    evt<StepStart>('step/start', {
      turn: 2, step: 3, model: 'light-1', lane: 'light', renderVersion: 'r2', personaHash: 'p1',
    }),
    evt<InputClaimed>('input/claimed', { turn: 2, wakeSeqs: [wm.seq], claimCounts: [0] }),
    evt<SessionEnd>('session/end', { reason: 'shutdown' }),
  );

  return log;
}

// ──────────────────────────────── 折叠确定性 ────────────────────────────────

test('M1-4 折叠确定性：混合全部主要类型的序列折叠 100 次字节一致', () => {
  const events = buildMixedLog();
  assert.ok(events.length >= 30, `混合序列至少要 30 条，实际 ${events.length}`);
  const kinds = new Set(events.map((e) => e.type));
  assert.ok(kinds.size >= 40, `事件类型覆盖至少要 40 种，实际 ${kinds.size}`);

  const first = JSON.stringify(fold(events));
  for (let i = 0; i < 100; i++) {
    assert.equal(JSON.stringify(fold(events)), first, `第 ${i + 1} 次折叠与首次不一致`);
  }
});

test('折叠不就地改写输入：序列反复折叠后与新建的序列逐字节相同，且冻结的序列照样能折', () => {
  const events = buildMixedLog();
  fold(events);
  assert.equal(JSON.stringify(events), JSON.stringify(buildMixedLog()), 'fold 不得改写输入事件');

  // ESM 是严格模式：若 fold 往冻结对象上写，会直接抛 TypeError
  const frozen = buildMixedLog();
  for (const e of frozen) {
    Object.freeze(e.data);
    Object.freeze(e);
  }
  const p = fold(frozen);
  assert.equal(p.lastSeq, frozen[frozen.length - 1]?.seq);
});

test('lastSeq 取最大 seq；firstEventAt 取首条被应用事件的 ts', () => {
  resetFactory();
  const a = evt<WakeFile>('wake/file', { path: 'a', kind: 'created' }, { seq: 10, ts: tsAfter(100) });
  const b = evt<WakeWebhook>('wake/webhook', { path: '/b', body: '', headers: {} }, { seq: 4, ts: tsAfter(200) });

  const p = fold([a, b]);
  assert.equal(p.lastSeq, 10, 'seq 允许空洞，lastSeq 是见过的最大值');
  assert.equal(p.firstEventAt, a.ts, 'firstEventAt 是第一条被应用事件的 ts');
  assert.equal(p.watermark, 0, '水位推进不在 fold 里做，投影只留字段位');
});

// ──────────────────────────────── 全量与增量一致 ────────────────────────────────

test('fold(全部) 与逐条 applyOne + finalizePressure 的最终投影深相等', () => {
  const events = buildMixedLog();
  const whole = fold(events);

  const incremental = incrementalOf(events);
  assert.equal(incremental.pressure, BASE_PRESSURE, '未结算前压力保持初值');
  finalizePressure(incremental);

  assert.deepEqual(incremental, whole);
  assert.equal(incremental.pressure, whole.pressure);
});

test('增量路径逐条结算压力与批次末结算的压力结算口径一致（同一参照时刻）', () => {
  const events = buildMixedLog();
  const ref = tsAfter(500);

  const whole = fold(events);
  const p = incrementalOf(events);
  finalizePressure(p, ref);

  const q = incrementalOf(events);
  finalizePressure(q, ref);
  assert.equal(p.pressure, q.pressure, '同一投影 + 同一参照时刻必须得到同一压力值');
  assert.ok(whole.pressure >= BASE_PRESSURE && whole.pressure <= 1);
});

// ──────────────────────────────── 工具生命周期 ────────────────────────────────

test('工具生命周期：call 进 openTools，ok 移除，unknown 进 needsReview，resolved 结案', () => {
  resetFactory();
  const c1 = evt<ToolCall>('tool/call', {
    turn: 1, step: 0, callId: 'c1', name: 'read_file', arguments: '{}', sideEffect: 'none',
  });
  const c2 = evt<ToolCall>('tool/call', {
    turn: 1, step: 0, callId: 'c2', name: 'shell', arguments: '{}', sideEffect: 'destructive',
  });
  const r1 = evt<ToolResult>('tool/result', {
    turn: 1, step: 0, callId: 'c1', callSeq: c1.seq, status: 'ok', content: 'done',
  });
  const r2 = evt<ToolResult>('tool/result', {
    turn: 1, step: 0, callId: 'c2', callSeq: c2.seq, status: 'unknown', content: '',
  });
  const resolved = evt<ReviewResolved>('review/resolved', {
    callId: 'c2', outcome: 'succeeded', note: '确认完成', by: 'human',
  });

  const p = emptyProjection();
  applyOne(p, c1);
  assert.deepEqual(p.openTools, [
    { callId: 'c1', name: 'read_file', sideEffect: 'none', callSeq: c1.seq },
  ]);
  applyOne(p, c2);
  assert.deepEqual(p.openTools.map((t) => t.callId), ['c1', 'c2']);
  assert.deepEqual(p.openTools[1], {
    callId: 'c2', name: 'shell', sideEffect: 'destructive', callSeq: c2.seq,
  });
  assert.deepEqual(p.needsReview, [], '仅 tool/call 不产生待审项');

  applyOne(p, r1);
  assert.deepEqual(p.openTools.map((t) => t.callId), ['c2'], '结果只关闭对应 callId');
  assert.deepEqual(p.needsReview, [], 'status=ok 不进待审');

  applyOne(p, r2);
  assert.deepEqual(p.openTools, [], 'status=unknown 同样关闭调用');
  assert.deepEqual(p.needsReview, [{ callId: 'c2', name: '', at: r2.ts }], '§12-6：unknown 必须在 needsReview');

  applyOne(p, resolved);
  assert.deepEqual(p.needsReview, [], 'review/resolved 按 callId 结案');
});

test('只有 status=unknown 进 needsReview；重复 tool/result 不重复关闭仍开放的调用', () => {
  resetFactory();
  const p = emptyProjection();
  const statuses = ['ok', 'error', 'timeout', 'denied', 'aborted'] as const;

  statuses.forEach((status, i) => {
    const callId = `x${i}`;
    const call = evt<ToolCall>('tool/call', {
      turn: 1, step: 0, callId, name: 'tool', arguments: '{}', sideEffect: 'idempotent',
    });
    applyOne(p, call);
    applyOne(p, evt<ToolResult>('tool/result', {
      turn: 1, step: 0, callId, callSeq: call.seq, status, content: '',
    }));
  });

  assert.deepEqual(p.openTools, []);
  assert.deepEqual(p.needsReview, [], '五种非 unknown 终态都不产生待审项');

  // 已关闭调用的迟到结果是无副作用的：不得把它重新变回开放状态
  applyOne(p, evt<ToolResult>('tool/result', {
    turn: 1, step: 0, callId: 'x0', callSeq: 1, status: 'timeout', content: '',
  }));
  assert.deepEqual(p.openTools, []);
  assert.deepEqual(p.needsReview, []);
});

// ──────────────────────────────── 输入生命周期 ────────────────────────────────

test('wake 一律进 pending 并带来源（含 heartbeat），heartbeat 额外写 idleTicks', () => {
  resetFactory();
  const file = evt<WakeFile>('wake/file', { path: 'a.md', kind: 'created' });
  const timer = evt<WakeTimer>('wake/timer', { timerId: 'x', scheduledAt: tsAfter(1), firedAt: tsAfter(2) });
  const webhook = evt<WakeWebhook>('wake/webhook', { path: '/h', body: '{}', headers: {} });
  const manual = evt<WakeManual>('wake/manual', { note: 'poke' });
  const intention = evt<WakeIntention>('wake/intention', { intentionId: 'i', content: 'check' });
  const job = evt<WakeJob>('wake/job', { jobId: 'j' });
  const hb = evt<WakeHeartbeat>('wake/heartbeat', { quietSeconds: 600, idleTicks: 7, pressure: 0.4, probability: 0.4, roll: 0.2 });

  const p = fold([file, timer, webhook, manual, intention, job, hb]);
  assert.deepEqual(
    p.pending.map((x) => x.source),
    ['file', 'timer', 'webhook', 'manual', 'intention', 'job', 'heartbeat'],
  );
  // 心跳也占一格：otherwise 循环层看不到它，回复必要性门就没有"这一拍"可判（M5-4/M5-5）
  assert.equal(p.pending.length, 7, '心跳同其他唤醒一样进输入队列');
  assert.deepEqual(p.pending.map((x) => x.claimCount), [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(p.lastWake, { source: 'heartbeat', at: hb.ts });
  assert.equal(p.idleTicks, 7, 'heartbeat 直接写 idleTicks（不退避复位）');
  assert.deepEqual(
    p.pending.map((x) => x.wakeSeq),
    [file, timer, webhook, manual, intention, job, hb].map((e) => e.seq),
  );
});

test('input/claimed 把输入移出 pending 并记入 claimedByTurn', () => {
  resetFactory();
  const f = evt<WakeFile>('wake/file', { path: 'a.md', kind: 'changed', dedupeKey: 'file:a.md' });
  const t = evt<WakeTimer>('wake/timer', { timerId: 'tm1', scheduledAt: tsAfter(1), firedAt: tsAfter(2) });
  const claim = evt<InputClaimed>('input/claimed', { turn: 3, wakeSeqs: [f.seq, t.seq], claimCounts: [0, 0] });

  const p = emptyProjection();
  applyOne(p, f);
  applyOne(p, t);
  assert.deepEqual(p.pending, [
    { wakeSeq: f.seq, source: 'file', claimCount: 0, dedupeKey: 'file:a.md' },
    { wakeSeq: t.seq, source: 'timer', claimCount: 0 },
  ]);
  assert.deepEqual(p.lastWake, { source: 'timer', at: t.ts });

  applyOne(p, claim);
  assert.deepEqual(p.pending, [], '认领即出队');
  assert.deepEqual(p.claimedByTurn, { 3: [f.seq, t.seq] });
});

test('同一 turn 分批认领：pending 增量摘除、claimedByTurn 取并集（中途插话销账的前提）', () => {
  // 场景（docs/review.md「未了结」）：turn 9 开头认领了 a；她发言途中 x 到达并打断了她，
  // speak 于是在同一轮里补记第二笔账——她已经看见 x 了，它不该再留在队列里等下一轮。
  resetFactory();
  const a = evt<WakeManual>('wake/manual', { note: '先问的那句' });
  const x = evt<WakeManual>('wake/manual', { note: '她说话时又来的那句' });
  const first = evt<InputClaimed>('input/claimed', { turn: 9, wakeSeqs: [a.seq], claimCounts: [0] });
  const second = evt<InputClaimed>('input/claimed', { turn: 9, wakeSeqs: [x.seq], claimCounts: [0] });

  const p = incrementalOf([a, x, first, second]);
  assert.deepEqual(p.pending, [], '两笔账都当场摘除（pending 是增量摘的，不是覆盖）');
  assert.deepEqual(p.claimedByTurn[9], [a.seq, x.seq], '并集：后一笔不许抹掉本轮原有的账');

  // 同一 seq 重复报：并集天然去重，账上不会出现两次
  const again = evt<InputClaimed>('input/claimed', { turn: 9, wakeSeqs: [x.seq], claimCounts: [0] });
  assert.deepEqual(incrementalOf([a, x, first, second, again]).claimedByTurn[9], [a.seq, x.seq]);

  // 退回（崩溃恢复）按账上的全部走：少了 a 就是丢掉她最初那条话
  const requeue = evt<InputRequeued>('input/requeued', {
    wakeSeqs: [a.seq, x.seq], claimCounts: [1, 1], sources: ['manual', 'manual'], reason: 'turn-interrupted',
  });
  const r = incrementalOf([a, x, first, second, requeue]);
  assert.deepEqual(
    r.pending.map((item) => [item.wakeSeq, item.claimCount]),
    [[a.seq, 1], [x.seq, 1]],
    '两笔账上的输入都要回到队列，且各带自己的认领次数',
  );
  assert.deepEqual(r.claimedByTurn[9], [a.seq, x.seq], '退回不动认领记录，收口仍由 turn/end 负责');
});

test('input/requeued 按 sources 与 claimCounts 重新入队，缺项有兜底', () => {
  resetFactory();
  const a = evt<WakeFile>('wake/file', { path: 'a', kind: 'changed' });
  const b = evt<WakeTimer>('wake/timer', { timerId: 't', scheduledAt: tsAfter(1), firedAt: tsAfter(2) });
  const claim = evt<InputClaimed>('input/claimed', { turn: 4, wakeSeqs: [a.seq, b.seq], claimCounts: [0, 0] });

  const full = evt<InputRequeued>('input/requeued', {
    wakeSeqs: [a.seq, b.seq], claimCounts: [1, 2], sources: ['file', 'timer'], reason: 'turn-interrupted',
  });
  const p = fold([a, b, claim, full]);
  assert.deepEqual(p.pending, [
    { wakeSeq: a.seq, source: 'file', claimCount: 1 },
    { wakeSeq: b.seq, source: 'timer', claimCount: 2 },
  ]);
  assert.deepEqual(p.claimedByTurn[4], [a.seq, b.seq], '退回不清理认领记录，由 turn/end 收口');

  // sources / claimCounts 短于 wakeSeqs：退化为 manual 与 1 次认领
  const short = evt<InputRequeued>('input/requeued', {
    wakeSeqs: [a.seq, b.seq], claimCounts: [2], sources: ['file'], reason: 'startup-recovery',
  });
  const q = fold([a, b, claim, short]);
  assert.deepEqual(q.pending, [
    { wakeSeq: a.seq, source: 'file', claimCount: 2 },
    { wakeSeq: b.seq, source: 'manual', claimCount: 1 },
  ]);
});

test('claimCount 达 3 的输入经 input/dead-letter 进死信并离开队列', () => {
  resetFactory();
  const w = evt<WakeManual>('wake/manual', { note: 'x' });
  const claim = evt<InputClaimed>('input/claimed', { turn: 5, wakeSeqs: [w.seq], claimCounts: [0] });
  const requeue = evt<InputRequeued>('input/requeued', {
    wakeSeqs: [w.seq], claimCounts: [3], sources: ['manual'], reason: 'turn-interrupted',
  });

  const p = incrementalOf([w, claim, requeue]);
  assert.deepEqual(p.pending, [{ wakeSeq: w.seq, source: 'manual', claimCount: 3 }]);
  assert.deepEqual(p.deadLetters, [], '阈值判定不在 fold 层：光有 claimCount=3 还不进死信');

  const deadLetter = evt<InputDeadLetter>('input/dead-letter', {
    inputSeq: w.seq, claimCount: 3, lastError: '连续三次被中断',
  });
  applyOne(p, deadLetter);
  assert.deepEqual(p.pending, [], '死信后必须离开待处理队列');
  assert.deepEqual(p.deadLetters, [{ inputSeq: w.seq, claimCount: 3, at: deadLetter.ts }]);
  assert.deepEqual(p.claimedByTurn[5], [w.seq], '死信不代 turn/end 收口认领记录');

  // 死信按 inputSeq 记账：队列里没有也能落档（恢复流程补记场景）
  applyOne(p, evt<InputDeadLetter>('input/dead-letter', { inputSeq: 999, claimCount: 3 }));
  assert.deepEqual(p.deadLetters.map((d) => d.inputSeq), [w.seq, 999]);
  assert.deepEqual(p.pending, []);
});

// ──────────────────────────────── dedupe 窗口 ────────────────────────────────

test('dedupe：同 key 的第二个 wake 不入 pending，无 key 的重复照收', () => {
  resetFactory();
  const first = evt<WakeWebhook>('wake/webhook', { path: '/h', body: '1', headers: {}, dedupeKey: 'hook:42' });
  const dup = evt<WakeWebhook>('wake/webhook', { path: '/h', body: '2', headers: {}, dedupeKey: 'hook:42' });
  const other = evt<WakeWebhook>('wake/webhook', { path: '/h', body: '3', headers: {}, dedupeKey: 'hook:43' });
  const plain1 = evt<WakeManual>('wake/manual', { note: 'same' });
  const plain2 = evt<WakeManual>('wake/manual', { note: 'same' });

  const p = fold([first, dup, other, plain1, plain2]);
  assert.deepEqual(p.pending.map((x) => x.dedupeKey ?? null), ['hook:42', 'hook:43', null, null]);
  assert.deepEqual(p.dedupeKeys, ['hook:42', 'hook:43'], '被丢弃的重复键不重复登记');
  assert.deepEqual(p.lastWake, { source: 'manual', at: plain2.ts }, '被丢弃的 wake 不推进 lastWake');
});

test('dedupe 窗口：容量 1000，第 1001 个键淘汰最旧的键', () => {
  resetFactory();
  const p = emptyProjection();

  const batch: AppEvent[] = [];
  for (let i = 1; i <= 1000; i++) {
    batch.push(evt<WakeManual>('wake/manual', { note: `n${i}`, dedupeKey: `k${i}` }));
  }
  for (const e of batch) applyOne(p, e);
  assert.equal(p.pending.length, 1000);
  assert.equal(p.dedupeKeys.length, 1000);
  assert.equal(p.dedupeKeys[0], 'k1');

  // 窗口内：k1 仍在，重复被丢弃
  applyOne(p, evt<WakeManual>('wake/manual', { note: 'dup', dedupeKey: 'k1' }));
  assert.equal(p.pending.length, 1000, '窗口内的重复键必须被丢弃');
  assert.equal(p.dedupeKeys.length, 1000);

  // 第 1001 个键：FIFO 淘汰最旧的 k1
  applyOne(p, evt<WakeManual>('wake/manual', { note: 'k1001', dedupeKey: 'k1001' }));
  assert.equal(p.dedupeKeys.length, 1000, '窗口容量固定为 1000');
  assert.equal(p.dedupeKeys[0], 'k2', '淘汰发生在一端（最旧）');
  assert.equal(p.dedupeKeys[p.dedupeKeys.length - 1], 'k1001', '新键追加在另一端');
  assert.equal(p.pending.length, 1001);
  assert.equal(p.dedupeKeys.includes('k1'), false);

  // 被淘汰之后同一个键可以重新入队
  applyOne(p, evt<WakeManual>('wake/manual', { note: 'k1 again', dedupeKey: 'k1' }));
  assert.equal(p.pending.length, 1002);
  assert.equal(p.dedupeKeys[p.dedupeKeys.length - 1], 'k1');
  assert.equal(p.dedupeKeys.length, 1000);
});

// ──────────────────────────────── 预算 ────────────────────────────────

test('budget/consumed 分 lane 与 hit/miss 累计：预算只加"没命中缓存的那部分 + 输出"', () => {
  resetFactory();
  const p = emptyProjection();
  // heavy：input 100 = 命中 30 + 未命中 70，输出 20 ⇒ 计入预算 = 70 + 20 = 90（旧口径是 120）
  const heavy = evt<BudgetConsumed>('budget/consumed', {
    turn: 1, step: 0, lane: 'heavy', model: 'm',
    inputTokens: 100, outputTokens: 20, cacheHitTokens: 30, cacheMissTokens: 70,
    durationMs: 5, retryCount: 0, finishReason: 'completed', tokensTodayAccum: 999_999,
  });
  applyOne(p, heavy);

  assert.deepEqual(p.budget, {
    date: null,
    // 口径版本随累计量一起盖章（换口径时恢复层靠它判"这份累计能不能续用"，见 log/types.ts）
    budgetVersion: 2,
    tokensToday: 90, tokensTodayHeavy: 90, tokensTodayLight: 0,
    // 命中/未命中照事件原样折（喂命中率那条观测），与计入预算的 90 不是一回事
    cacheHitToday: 30, cacheMissToday: 70,
    tokensTask: 90, stepsThisTurn: 0, toolCallsThisStep: 0,
  });
  assert.equal(p.failStreak, 0);
  assert.equal(p.lastModelSuccessAt, heavy.ts);

  // light：input 40 = 命中 5 + 未命中 35，输出 10 ⇒ 计入预算 = 35 + 10 = 45（旧口径是 50）
  const light = evt<BudgetConsumed>('budget/consumed', {
    turn: 1, step: 1, lane: 'light', model: 'm2',
    inputTokens: 40, outputTokens: 10, cacheHitTokens: 5, cacheMissTokens: 35,
    durationMs: 3, retryCount: 2, finishReason: 'completed', tokensTodayAccum: 0,
  });
  applyOne(p, light);

  assert.equal(p.budget.tokensToday, 135, '只按 (input − cacheHit) + output 累计，不信事件自带的 tokensTodayAccum');
  assert.equal(p.budget.tokensTodayHeavy, 90);
  assert.equal(p.budget.tokensTodayLight, 45);
  assert.equal(p.budget.tokensToday, p.budget.tokensTodayHeavy + p.budget.tokensTodayLight);
  assert.equal(p.budget.cacheHitToday, 35);
  assert.equal(p.budget.cacheMissToday, 105);
  assert.equal(p.budget.tokensTask, 135);
});

test('failStreak 只在 failed 上递增，其余 finishReason 清零并推进 lastModelSuccessAt', () => {
  resetFactory();
  const p = emptyProjection();
  const mk = (lane: 'heavy' | 'light', finishReason: BudgetConsumed['data']['finishReason']): BudgetConsumed =>
    evt<BudgetConsumed>('budget/consumed', {
      turn: 1, step: 0, lane, model: 'm',
      inputTokens: 10, outputTokens: 5, cacheHitTokens: 0, cacheMissTokens: 15,
      durationMs: 1, retryCount: 0, finishReason, tokensTodayAccum: 0,
    });

  const ok = mk('heavy', 'completed');
  applyOne(p, ok);
  assert.equal(p.lastModelSuccessAt, ok.ts);

  const fail1 = mk('heavy', 'failed');
  applyOne(p, fail1);
  const fail2 = mk('heavy', 'failed');
  applyOne(p, fail2);
  assert.equal(p.failStreak, 2);
  assert.equal(p.lastModelSuccessAt, ok.ts, '失败不推进 lastModelSuccessAt');

  const aborted = mk('light', 'aborted');
  applyOne(p, aborted);
  assert.equal(p.failStreak, 0, 'aborted 视为走出失败链');
  assert.equal(p.lastModelSuccessAt, aborted.ts);

  applyOne(p, mk('light', 'failed'));
  assert.equal(p.failStreak, 1);
  const maxTokens = mk('light', 'max_output_tokens');
  applyOne(p, maxTokens);
  assert.equal(p.failStreak, 0);
  assert.equal(p.lastModelSuccessAt, maxTokens.ts);
});

test('budget/rollover 只清 today 系，tokensTask 与 failStreak 跨日保留', () => {
  resetFactory();
  const p = emptyProjection();
  // input 500 = 命中 50 + 未命中 450，输出 100 ⇒ 非缓存口径计入 550（旧口径 600）
  applyOne(p, evt<BudgetConsumed>('budget/consumed', {
    turn: 1, step: 0, lane: 'heavy', model: 'm',
    inputTokens: 500, outputTokens: 100, cacheHitTokens: 50, cacheMissTokens: 450,
    durationMs: 2, retryCount: 0, finishReason: 'failed', tokensTodayAccum: 0,
  }));
  applyOne(p, evt<BudgetRollover>('budget/rollover', { date: '2020-06-02' }));

  assert.equal(p.budget.tokensToday, 0);
  assert.equal(p.budget.tokensTodayHeavy, 0);
  assert.equal(p.budget.tokensTodayLight, 0);
  assert.equal(p.budget.cacheHitToday, 0);
  assert.equal(p.budget.cacheMissToday, 0);
  assert.equal(p.budget.tokensTask, 550, '任务内累计不随日界清零（非缓存口径：450 + 100）');
  assert.equal(p.failStreak, 1, '日界不清失败链');
  assert.equal(p.lastModelSuccessAt, null, '本次没有成功调用，成功时刻保持 null');
});

test('投影记住记账日期：它是"今天记过没有"的唯一凭据（重启不清零的根据）', () => {
  // 一次实测事故的锁：运行时原来只看进程内存里的一个字段判断要不要写 rollover，
  // 而它每次启动都是 null —— 于是**每启动一次就写一条**，fold 收到就把当日计数清零一次。
  // 表现是运行情况页的「今日 token」老是 0、缓存命中率显示 `-`（0/0），
  // 而同页的 hourly 曲线（从事件重算）一切正常；那天重启三次就归零三次。
  resetFactory();
  const p = emptyProjection();
  applyOne(p, evt<BudgetConsumed>('budget/consumed', {
    turn: 1, step: 0, lane: 'heavy', model: 'm',
    inputTokens: 500, outputTokens: 100, cacheHitTokens: 50, cacheMissTokens: 550,
    durationMs: 2, retryCount: 0, finishReason: 'completed', tokensTodayAccum: 0,
  }));
  assert.equal(p.budget.date, null, '还没跨过天，没有记账日期');

  applyOne(p, evt<BudgetRollover>('budget/rollover', { date: '2026-10-01' }));
  assert.equal(p.budget.date, '2026-10-01', '记账日期必须折进投影（旧实现里它根本没这个字段）');

  // 跨天之后又用了一些：这个数不该再被任何"重启"清掉——运行时看到 date 是今天就不会写 rollover
  // input 300 = 命中 200 + 未命中 100，输出 50 ⇒ 非缓存口径计入 150（旧口径 350）
  applyOne(p, evt<BudgetConsumed>('budget/consumed', {
    turn: 2, step: 0, lane: 'light', model: 'm',
    inputTokens: 300, outputTokens: 50, cacheHitTokens: 200, cacheMissTokens: 100,
    durationMs: 2, retryCount: 0, finishReason: 'completed', tokensTodayAccum: 0,
  }));
  assert.equal(p.budget.tokensToday, 150, '当日量照常累计（非缓存口径：100 + 50）');
  assert.equal(p.budget.date, '2026-10-01', '累计不改记账日期');
});

test('§12-7 预算不变量：tokensToday 等于最近一次 rollover 之后所有 consumed 之和', () => {
  resetFactory();
  // 第 i 条：input = 100 + i（其中命中 i）⇒ 未命中恒为 100，输出 10 + i
  //   ⇒ **非缓存口径**每条计入 100 + (10 + i) = 110 + i（旧口径是 110 + 2i）
  const events: AppEvent[] = [];
  const mk = (i: number): BudgetConsumed => evt<BudgetConsumed>('budget/consumed', {
    turn: 1, step: i, lane: i % 2 === 0 ? 'heavy' : 'light', model: 'm',
    inputTokens: 100 + i, outputTokens: 10 + i, cacheHitTokens: i, cacheMissTokens: 100,
    durationMs: 1, retryCount: 0, finishReason: 'completed', tokensTodayAccum: 0,
  });

  let beforeRollover = 0;
  let afterRollover = 0;
  for (let i = 0; i < 5; i++) {
    events.push(mk(i));
    beforeRollover += 110 + i;
  }
  events.push(evt<BudgetRollover>('budget/rollover', { date: '2020-06-02' }));
  for (let i = 5; i < 11; i++) {
    events.push(mk(i));
    afterRollover += 110 + i;
  }

  const p = fold(events);
  assert.equal(p.budget.tokensToday, afterRollover);
  assert.equal(p.budget.tokensTask, beforeRollover + afterRollover, 'tokensTask 覆盖全任务而非仅今日');
});

test('budget/exhausted 按层记档，同层覆盖，topped-up 清除对应层', () => {
  resetFactory();
  const p = emptyProjection();
  const daily = evt<BudgetExhausted>('budget/exhausted', { layer: 'daily', limit: 1_000_000, actual: 1_000_500, resumable: true });
  applyOne(p, daily);
  assert.deepEqual(p.lastExhausted.daily, { at: daily.ts, limit: 1_000_000, actual: 1_000_500 });
  assert.equal(p.lastExhausted.step, undefined);

  const stepEx = evt<BudgetExhausted>('budget/exhausted', { layer: 'step', limit: 8_000, actual: 8_100, resumable: true });
  applyOne(p, stepEx);
  assert.deepEqual(Object.keys(p.lastExhausted).sort(), ['daily', 'step']);

  const dailyAgain = evt<BudgetExhausted>('budget/exhausted', { layer: 'daily', limit: 1_200_000, actual: 1_200_400, resumable: true });
  applyOne(p, dailyAgain);
  assert.deepEqual(p.lastExhausted.daily, { at: dailyAgain.ts, limit: 1_200_000, actual: 1_200_400 }, '同层以最新一次为准');

  applyOne(p, evt<BudgetToppedUp>('budget/topped-up', { layer: 'daily', addedTokens: 500_000, by: 'human' }));
  assert.equal(p.lastExhausted.daily, undefined);
  assert.deepEqual(p.lastExhausted.step, { at: stepEx.ts, limit: 8_000, actual: 8_100 }, '加预算只清指定层');
});

/**
 * `budget/resumed`：抬上限解除暂停的**那件事**（2026-10-04 修的真 bug）。
 *
 * 这里盯的是折叠口径：解除必须是日志里的事件（与 `topped-up` 同一个出口，只清指定层），
 * 因为 `lastExhausted` 是日志的折叠结果——解除只改投影的话，下一次重启会被日志推翻。
 * 顺带钉住 `resumable: false` 那一位的折法：它只在不可恢复的暂停上出现，是抬上限那条
 * 规则"别解它"的凭据（见 Projection.lastExhausted 与 BudgetGuard.liftedPauses）。
 */
test('budget/resumed 解除指定层暂停（与 topped-up 同出口），resumable:false 留下凭据', () => {
  resetFactory();
  const p = emptyProjection();
  const task = evt<BudgetExhausted>('budget/exhausted', { layer: 'task', limit: 100, actual: 120, resumable: true });
  const daily = evt<BudgetExhausted>('budget/exhausted', { layer: 'daily', limit: 1_000, actual: 1_100, resumable: true });
  applyOne(p, task);
  applyOne(p, daily);
  assert.deepEqual(Object.keys(p.lastExhausted).sort(), ['daily', 'task']);

  const resumed = evt<BudgetResumed>('budget/resumed', { layer: 'task', limit: 1_000, actual: 120, reason: 'limit-raised' });
  applyOne(p, resumed);
  assert.equal(p.lastExhausted.task, undefined, 'budget/resumed 解掉记录');
  assert.deepEqual(p.lastExhausted.daily, { at: daily.ts, limit: 1_000, actual: 1_100 }, '只清指定层');
  // 全量与增量一致：同一条序列 fold 出来的解除结果必须逐字节相同
  assert.deepEqual(fold([task, daily, resumed]).lastExhausted, { daily: { at: daily.ts, limit: 1_000, actual: 1_100 } });

  // 子代理链的事件同样在父层折这份记账（与 topped-up 同一口径：父的唤醒门读的就是它）
  const childResume = {
    ...evt<BudgetResumed>('budget/resumed', { layer: 'daily', limit: 9_000, actual: 1_100, reason: 'topup' }),
    parentCallId: 'call_child_1',
  } as BudgetResumed;
  applyEvent(p, childResume);
  assert.equal(p.lastExhausted.daily, undefined, '子代理链的解除同样折进父层');

  // 不可恢复的暂停（手写/旧日志才可能出现，类型上是字面量 true）：折进投影时必须带标记，
  // 否则"抬上限"那条规则会把它当成普通的预算暂停顺手解掉
  const hard = evt<BudgetExhausted>('budget/exhausted', { layer: 'turn', limit: 30, actual: 30, resumable: true });
  (hard.data as { resumable: unknown }).resumable = false;
  applyOne(p, hard);
  assert.deepEqual(p.lastExhausted.turn, { at: hard.ts, limit: 30, actual: 30, resumable: false });

  // 同层再来一条可恢复的：覆盖时标记要一并消失（暂停的性质以后写的为准）
  const soft = evt<BudgetExhausted>('budget/exhausted', { layer: 'turn', limit: 30, actual: 31, resumable: true });
  applyOne(p, soft);
  assert.deepEqual(p.lastExhausted.turn, { at: soft.ts, limit: 30, actual: 31 });
});

// ──────────────────────────────── 定时器 ────────────────────────────────

test('timer/set 覆盖同 id 条目并把它移到表尾', () => {
  resetFactory();
  const a1 = evt<TimerSet>('timer/set', { timerId: 'a1', at: tsAfter(60), payload: { note: 'a' } });
  const a2 = evt<TimerSet>('timer/set', { timerId: 'a2', cron: '0 9 * * *', payload: null });
  const a1Again = evt<TimerSet>('timer/set', { timerId: 'a1', at: tsAfter(90), payload: { note: 'b' } });

  const p = fold([a1, a2]);
  assert.deepEqual(p.timers, [
    { timerId: 'a1', at: tsAfter(60), payload: { note: 'a' } },
    { timerId: 'a2', cron: '0 9 * * *', payload: null },
  ]);
  assert.equal('cron' in (p.timers[0] ?? {}), false, '只有 at 的条目不带 cron 字段');

  applyOne(p, a1Again);
  assert.equal(p.timers.length, 2, '同 id 覆盖而不是追加');
  assert.deepEqual(p.timers.map((t) => t.timerId), ['a2', 'a1']);
  assert.deepEqual(p.timers[1], { timerId: 'a1', at: tsAfter(90), payload: { note: 'b' } });
});

test('timer/cancelled 移除条目；对未知 id 无副作用', () => {
  resetFactory();
  const a1 = evt<TimerSet>('timer/set', { timerId: 'a1', at: tsAfter(10), payload: null });
  const a2 = evt<TimerSet>('timer/set', { timerId: 'a2', at: tsAfter(20), payload: null });
  const p = fold([a1, a2]);
  assert.equal(p.timers.length, 2);

  applyOne(p, evt<TimerCancelled>('timer/cancelled', { timerId: 'nope' }));
  assert.deepEqual(p.timers.map((t) => t.timerId), ['a1', 'a2']);

  applyOne(p, evt<TimerCancelled>('timer/cancelled', { timerId: 'a1' }));
  assert.deepEqual(p.timers.map((t) => t.timerId), ['a2']);
});

test('timer/fired：无 cron 的条目移除，带 cron 的保留（推进 at 由 TimerStore 负责）', () => {
  resetFactory();
  const once = evt<TimerSet>('timer/set', { timerId: 'once', at: tsAfter(10), payload: 'p' });
  const cron = evt<TimerSet>('timer/set', { timerId: 'cron', cron: '*/5 * * * *', payload: 'q' });
  const p = fold([once, cron]);

  applyOne(p, evt<TimerFired>('timer/fired', { timerId: 'once' }));
  assert.deepEqual(p.timers.map((t) => t.timerId), ['cron'], '一次性条目触发即出表');

  const snapshot = JSON.stringify(p.timers);
  applyOne(p, evt<TimerFired>('timer/fired', { timerId: 'cron' }));
  assert.equal(JSON.stringify(p.timers), snapshot, '周期条目触发后原样保留，折叠层不重算下一拍');

  applyOne(p, evt<TimerFired>('timer/fired', { timerId: 'ghost' }));
  assert.deepEqual(p.timers.map((t) => t.timerId), ['cron'], '未知 id 的触发不新增条目');
});

// ──────────────────────────────── 压力结算 ────────────────────────────────

test('压力四项加权：needsReview / pending / 到期意图 / 距发言超 2h', () => {
  resetFactory();
  assert.equal(pressureOf([]), BASE_PRESSURE, '空投影只有底噪');

  // needsReview：+0.3，与待审条数无关
  const c1 = evt<ToolCall>('tool/call', {
    turn: 1, step: 0, callId: 'c1', name: 'shell', arguments: '{}', sideEffect: 'destructive',
  });
  const r1 = evt<ToolResult>('tool/result', {
    turn: 1, step: 0, callId: 'c1', callSeq: c1.seq, status: 'unknown', content: '',
  });
  const c2 = evt<ToolCall>('tool/call', {
    turn: 1, step: 0, callId: 'c2', name: 'shell', arguments: '{}', sideEffect: 'destructive',
  });
  const r2 = evt<ToolResult>('tool/result', {
    turn: 1, step: 0, callId: 'c2', callSeq: c2.seq, status: 'unknown', content: '',
  });
  assert.equal(pressureOf([c1, r1]), BASE_PRESSURE + 0.3);
  assert.equal(pressureOf([c1, r1, c2, r2]), BASE_PRESSURE + 0.3, '按存在性加权，不按条数');

  // pending：+0.2，同样只看有没有
  const w1 = evt<WakeManual>('wake/manual', { note: '1' });
  const w2 = evt<WakeManual>('wake/manual', { note: '2' });
  assert.equal(pressureOf([w1]), BASE_PRESSURE + 0.2);
  assert.equal(pressureOf([w1, w2]), BASE_PRESSURE + 0.2);

  // 到期意图：+0.25；未到期或无 triggerAt 不加
  const ref = tsAfter(100);
  const due = evt<IntentionRaised>('intention/raised', { intentionId: 'i', content: 'x', triggerAt: tsAfter(50) });
  const future = evt<IntentionRaised>('intention/raised', { intentionId: 'j', content: 'y', triggerAt: tsAfter(101) });
  const whenever = evt<IntentionRaised>('intention/raised', { intentionId: 'k', content: 'z' });
  assert.equal(pressureOf([due], ref), BASE_PRESSURE + 0.25);
  assert.equal(pressureOf([due, whenever], ref), BASE_PRESSURE + 0.25, '无 triggerAt 的意图不参与到期判定');
  assert.equal(pressureOf([future], ref), BASE_PRESSURE);

  // 距上次发言超 2h：+0.2；恰好 2h 不算
  const t1 = tsAfter(200);
  const said = evt<AssistantMessage>('message/assistant', { text: '我在', toolCalls: [] }, { ts: t1 });
  const hb = evt<WakeHeartbeat>('wake/heartbeat', { quietSeconds: 7200, idleTicks: 1, pressure: 0.1, probability: 1, roll: 0.5 }, { ts: t1 });
  assert.equal(
    pressureOf([said, hb], new Date(Date.parse(t1) + 2 * HOUR_MS).toISOString()),
    BASE_PRESSURE,
    '恰好 2h 不属于「超过」',
  );
  assert.equal(
    pressureOf([said, hb], new Date(Date.parse(t1) + 2 * HOUR_MS + 1).toISOString()),
    BASE_PRESSURE + 0.2,
  );

  // 四项全中：权重和已达 1，封顶到 1
  const allRef = new Date(Date.parse(t1) + 3 * HOUR_MS).toISOString();
  assert.ok(BASE_PRESSURE + 0.3 + 0.2 + 0.25 + 0.2 >= 1, '全触发时权重和应当触顶');
  assert.equal(pressureOf([c1, r1, w1, due, said, hb], allRef), 1, '压力封顶 1');

  // 空投影与只有 pending 的投影都不得越界
  for (const pressure of [pressureOf([]), pressureOf([w1])]) {
    assert.ok(pressure >= 0 && pressure <= 1);
  }
});

test('压力参照时刻优先级：referenceTs > lastWake > lastModelSuccessAt > lastAssistantAt > firstEventAt', () => {
  resetFactory();
  const hb = evt<WakeHeartbeat>('wake/heartbeat', { quietSeconds: 10, idleTicks: 0, pressure: 0, probability: 0, roll: 0.5 }, { ts: tsAfter(200) });
  const success = evt<BudgetConsumed>('budget/consumed', {
    turn: 1, step: 0, lane: 'heavy', model: 'm',
    inputTokens: 1, outputTokens: 1, cacheHitTokens: 0, cacheMissTokens: 2,
    durationMs: 1, retryCount: 0, finishReason: 'completed', tokensTodayAccum: 0,
  }, { ts: tsAfter(300) });
  const said = evt<AssistantMessage>('message/assistant', { text: 'x', toolCalls: [] }, { ts: tsAfter(400) });
  const iA = evt<IntentionRaised>('intention/raised', { intentionId: 'A', content: 'x', triggerAt: tsAfter(250) });
  const iB = evt<IntentionRaised>('intention/raised', { intentionId: 'B', content: 'x', triggerAt: tsAfter(350) });

  // iA 落在 lastWake(200) 与 lastModelSuccessAt(300) 之间：取 lastWake 时未到期
  assert.equal(pressureOf([hb, success, iA]), BASE_PRESSURE, 'lastWake 优先于 lastModelSuccessAt');
  // iB 落在 lastModelSuccessAt(300) 与 lastAssistantAt(400) 之间：取成功时刻时未到期
  assert.equal(pressureOf([success, said, iB]), BASE_PRESSURE, 'lastModelSuccessAt 优先于 lastAssistantAt');
  // 退化到 lastAssistantAt：iB 到期
  assert.equal(pressureOf([said, iB]), BASE_PRESSURE + 0.25, '无 wake 与成功调用时用 lastAssistantAt');

  // 全部缺失时退到 firstEventAt：只要 triggerAt 早于首事件就算到期
  const onlyDefault = evt<SessionStart>('session/start', {
    pid: 1, cwd: 'D:\\a', version: '0.1.0', schemaVersion: '1', configHash: 'h',
  }, { ts: tsAfter(500) });
  const stale = evt<IntentionRaised>('intention/raised', { intentionId: 'C', content: 'x', triggerAt: tsAfter(400) });
  assert.equal(pressureOf([onlyDefault, stale]), BASE_PRESSURE + 0.25, 'firstEventAt 是最后兜底');

  // 显式参照时刻压过一切
  assert.equal(pressureOf([onlyDefault, stale], tsAfter(300)), BASE_PRESSURE, 'referenceTs 优先');
  assert.equal(pressureOf([hb, success, iA], tsAfter(400)), BASE_PRESSURE + 0.25, '显式参照时刻可把未到期意图判为到期');
});

test('压力不读环境时钟：把 Date.now 打桩到 1979 年，结论仍按日志内 ts 计算', () => {
  resetFactory();
  const hb = evt<WakeHeartbeat>('wake/heartbeat', { quietSeconds: 10, idleTicks: 0, pressure: 0, probability: 0, roll: 0.5 }, { ts: tsAfter(600) });
  const due = evt<IntentionRaised>('intention/raised', { intentionId: 'i', content: 'x', triggerAt: tsAfter(590) });

  const realNow = Date.now;
  let measured = 0;
  let clockReads = 0;
  try {
    Date.now = () => {
      clockReads += 1;
      return Date.parse('1979-01-01T00:00:00.000Z');
    };
    measured = pressureOf([hb, due]);
  } finally {
    Date.now = realNow;
  }

  assert.equal(measured, BASE_PRESSURE + 0.25, '到期判定用的是日志内的 lastWake.at');
  assert.equal(clockReads, 0, 'fold 与 finalizePressure 全程不读环境时钟');
});

// ──────────────────────────────── 纯函数性 ────────────────────────────────

test('纯函数性：同一序列在不同时刻折叠结果字节一致', () => {
  const events = buildMixedLog();
  const first = JSON.stringify(fold(events));

  const realNow = Date.now;
  let step = 0;
  try {
    Date.now = () => 1_000_000_000_000 + step++ * 86_400_000;
    assert.equal(JSON.stringify(fold(events)), first);
    assert.equal(JSON.stringify(fold(events)), first);
  } finally {
    Date.now = realNow;
  }

  const again = fold(events);
  assert.equal(JSON.stringify(again), first);
  assert.deepEqual(again, fold(events));
});

// ──────────────────────────────── turn 收口 ────────────────────────────────

test('turn/end interrupted 清理 claimedByTurn 与 openTurn', () => {
  resetFactory();
  const start = evt<TurnStart>('turn/start', { turn: 7 });
  const step = evt<StepStart>('step/start', {
    turn: 7, step: 3, model: 'm', lane: 'heavy', renderVersion: 'r', personaHash: 'p',
  });
  const w = evt<WakeManual>('wake/manual', { note: 'x' });
  const claim = evt<InputClaimed>('input/claimed', { turn: 7, wakeSeqs: [w.seq], claimCounts: [0] });
  const end = evt<TurnEnd>('turn/end', { turn: 7, reason: { kind: 'interrupted' }, spoke: false });

  const p = incrementalOf([start, step, w, claim]);
  assert.deepEqual(p.openTurn, { turn: 7, step: 3 });
  assert.deepEqual(p.claimedByTurn[7], [w.seq]);

  applyOne(p, end);
  assert.equal(p.openTurn, null);
  assert.equal(7 in p.claimedByTurn, false, 'interrupted 收口必须清掉认领记录');
});

test('turn/end 只收口自己的 turn，其他 reason 同样收口；step/start 不认错误 turn', () => {
  resetFactory();
  const t1 = evt<TurnStart>('turn/start', { turn: 1 });
  const w1 = evt<WakeManual>('wake/manual', { note: 'a' });
  const claim1 = evt<InputClaimed>('input/claimed', { turn: 1, wakeSeqs: [w1.seq], claimCounts: [0] });
  const t2 = evt<TurnStart>('turn/start', { turn: 2 });
  const w2 = evt<WakeManual>('wake/manual', { note: 'b' });
  const claim2 = evt<InputClaimed>('input/claimed', { turn: 2, wakeSeqs: [w2.seq], claimCounts: [0] });
  const endOther = evt<TurnEnd>('turn/end', { turn: 9, reason: { kind: 'completed' }, spoke: false });

  const p = incrementalOf([t1, w1, claim1, t2, w2, claim2]);
  assert.deepEqual(p.openTurn, { turn: 2, step: 0 }, '新 turn/start 覆盖 openTurn');

  applyOne(p, endOther);
  assert.deepEqual(p.openTurn, { turn: 2, step: 0 }, '收口别的 turn 不得关掉当前 turn');
  assert.deepEqual(p.claimedByTurn[1], [w1.seq]);
  assert.deepEqual(p.claimedByTurn[2], [w2.seq]);

  applyOne(p, evt<StepStart>('step/start', {
    turn: 99, step: 8, model: 'm', lane: 'light', renderVersion: 'r', personaHash: 'p',
  }));
  assert.deepEqual(p.openTurn, { turn: 2, step: 0 }, 'step/start 只推进同 turn 的步号');

  applyOne(p, evt<TurnEnd>('turn/end', { turn: 2, reason: { kind: 'completed' }, spoke: true }));
  assert.equal(p.openTurn, null);
  assert.deepEqual(p.claimedByTurn, { 1: [w1.seq] }, '只删自己那一条');
});

// ──────────────────────────────── 其余投影字段 ────────────────────────────────

test('message/assistant 截断 80 字符；text=null 只推进时刻', () => {
  resetFactory();
  const long = 'x'.repeat(120);
  const m1 = evt<AssistantMessage>('message/assistant', { text: long, toolCalls: [] });
  const p = emptyProjection();
  applyOne(p, m1);
  assert.equal(p.lastAssistantText, long.slice(0, 80));
  assert.equal(p.lastAssistantText?.length, 80);
  assert.equal(p.lastAssistantAt, m1.ts);

  const m2 = evt<AssistantMessage>('message/assistant', { text: null, toolCalls: [] });
  applyOne(p, m2);
  assert.equal(p.lastAssistantText, long.slice(0, 80), 'null 发言不覆盖上一条文本');
  assert.equal(p.lastAssistantAt, m2.ts, '时刻照常推进');
});

test('jobs、waitingHuman、degraded、intentions、todoList、lastArchiveAt 的折叠语义', () => {
  resetFactory();
  const p = emptyProjection();

  const started = evt<JobStarted>('job/started', { jobId: 'j1', command: 'pwsh -File b.ps1', turn: 3 });
  applyOne(p, started);
  assert.deepEqual(p.jobs, { j1: { command: 'pwsh -File b.ps1', turn: 3, startedAt: started.ts } });
  applyOne(p, evt<JobStarted>('job/started', { jobId: 'j2', command: 'echo', turn: 3 }));
  applyOne(p, evt<JobFinished>('job/finished', { jobId: 'j1', exitCode: 0 }));
  assert.deepEqual(Object.keys(p.jobs), ['j2']);

  const asked = evt<HumanAsked>('human/asked', { question: '要外传吗？', context: '', turn: 3 });
  applyOne(p, asked);
  assert.deepEqual(p.waitingHuman, { question: '要外传吗？', turn: 3, at: asked.ts });
  applyOne(p, evt<HumanAnswered>('human/answered', { question: '要外传吗？', answer: '不要', by: 'human' }));
  assert.equal(p.waitingHuman, null);

  const degradedEvt = evt<ModelDegraded>('model/degraded', { lane: 'heavy', reason: '上游 5xx' });
  applyOne(p, degradedEvt);
  assert.deepEqual(p.degraded, { lane: 'heavy', since: degradedEvt.ts, reason: '上游 5xx' });
  applyOne(p, evt<ModelRestored>('model/restored', { lane: 'light' }));
  assert.deepEqual(
    p.degraded,
    { lane: 'heavy', since: degradedEvt.ts, reason: '上游 5xx' },
    '恢复别的 lane 不得清掉降级状态',
  );
  applyOne(p, evt<ModelRestored>('model/restored', { lane: 'heavy' }));
  assert.equal(p.degraded, null);

  const raised1 = evt<IntentionRaised>('intention/raised', { intentionId: 'i1', content: '第一版', triggerAt: tsAfter(10) });
  applyOne(p, raised1);
  const raised2 = evt<IntentionRaised>('intention/raised', { intentionId: 'i1', content: '第二版', condition: '安静时' });
  applyOne(p, raised2);
  assert.deepEqual(p.intentions, [{ intentionId: 'i1', content: '第二版', condition: '安静时' }], '同 id 覆盖且不带旧 triggerAt');
  applyOne(p, evt<IntentionActed>('intention/acted', { intentionId: 'i1', turn: 3 }));
  assert.deepEqual(p.intentions, []);

  const todo = evt<TodoUpdated>('todo/updated', {
    items: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'completed' }],
  });
  applyOne(p, todo);
  assert.deepEqual(p.todoList, [
    { content: 'a', status: 'pending' },
    { content: 'b', status: 'completed' },
  ]);
  assert.notEqual(p.todoList[0], todo.data.items[0], 'todoList 是副本，不共享事件里的对象引用');

  const checkpoint = evt<SnapshotCheckpoint>('snapshot/checkpoint', { upToSeq: 10, file: 'events/0001.jsonl' });
  applyOne(p, checkpoint);
  assert.equal(p.lastArchiveAt, checkpoint.ts);
});

test('不进投影的事件类型：只有 lastSeq 与 firstEventAt 前进，其余字段与空投影一致', () => {
  resetFactory();
  const events: AppEvent[] = [
    evt<SessionStart>('session/start', {
      pid: 1, cwd: 'D:\\a', version: '0.1.0', schemaVersion: '1', configHash: 'h',
    }),
    evt<DeveloperMessage>('developer/message', { added: ['read_file'], removed: [] }),
    evt<PolicyDenied>('policy/denied', { tool: 'shell', rule: 'hook', reason: '被 hook 拦下', callId: 'c1' }),
    evt<LogRepaired>('log/repaired', { truncatedBytes: 3, lastGoodSeq: 2 }),
    evt<InstanceTakeover>('instance/takeover', {
      previousPid: 9, previousHeartbeatAt: tsAfter(1), staleBecause: 'pid-gone',
    }),
    evt<ConfigChanged>('config/changed', { fields: ['quietMs'], configHash: 'h2' }),
    evt<AlarmSent>('alarm/sent', { fingerprint: 'fp', level: 'info', title: 't' }),
    evt<CompactionSummary>('compaction/summary', { coveredUpToSeq: 3, summary: '……' }),
    evt<McpServerStarted>('mcp/server-started', { name: 'fs', pid: 2, tools: [] }),
    evt<McpServerStopped>('mcp/server-stopped', { name: 'fs', reason: 'crashed' }),
    evt<ToolZombie>('tool/zombie', { callId: 'c1', name: 'shell', note: 'n' }),
    evt<SpeakSent>('speak/sent', { channel: 'log', chars: 3 }),
    evt<PersonaUpdated>('persona/updated', { file: 'persona/IDENTITY.md', diffHash: 'd', by: 'agent' }),
    evt<StepEnd>('step/end', { turn: 1, step: 0, toolCalls: 0 }),
    evt<SessionEnd>('session/end', { reason: 'error', detail: 'boom' }),
  ];

  const p = fold(events);
  assert.deepEqual({ ...p, lastSeq: 0, firstEventAt: null }, emptyProjection());
  assert.equal(p.lastSeq, events[events.length - 1]?.seq);
  assert.equal(p.firstEventAt, events[0]?.ts);
  assert.equal(p.pressure, BASE_PRESSURE, '没有待审/待处理/到期意图时压力只有底噪');
});
