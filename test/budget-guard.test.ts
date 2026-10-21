/**
 * 刹车核心测试 — src/runtime/budget-guard.ts
 *
 * 覆盖 docs/milestones.md M3-1（单步限制）、M3-2（单轮限制）、M3-3（跨重启累计）、
 * M3-4（软提示先到）、M3-5（硬停后恢复）、M3-8（日额度）与 docs/design.md §4.6。
 *
 * 全部用例用固定时刻（2024-01-01T00:00:00Z 起）与自增 seq 构造事件，
 * 不读环境时钟、不依赖真实时间流逝；临时目录只在看门文件用例里出现。
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { emptyProjection, defaultVisibility } from '../src/log/types.ts';
import type { AppEvent, Projection } from '../src/log/types.ts';
import { fold } from '../src/state/fold.ts';
import {
  applyTopUpEvent, BudgetGuard, emptyTopUps, parseTopUpRequest, stallOf, writeTopUpRequest,
  TOPUP_FILE_PREFIX, TOPUP_WATCH_DIR_NAME, type BudgetGuardConfig, type TopUpRequest,
} from '../src/runtime/budget-guard.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const T0 = Date.parse('2024-01-01T00:00:00Z');
const MIN_MS = 60_000;

/** 与 config.ts 的默认预算同形（判定用例按它算期望值） */
const CONFIG: BudgetGuardConfig = {
  stepTools: 20,
  turnSteps: 30,
  taskTokens: 500_000,
  dailyTokens: 2_000_000,
  softRatio: 0.8,
  failStreakMax: 5,
};

interface Captured {
  type: string;
  data: Record<string, unknown>;
  visibility: string;
}

interface Harness {
  p: Projection;
  guard: BudgetGuard;
  captured: Captured[];
}

/** 自带事件写入的构造形状（deps 形状）：投影与 guard 共用同一个对象 */
function setup(config: BudgetGuardConfig = CONFIG, atMs = T0): Harness {
  const p = emptyProjection();
  const captured: Captured[] = [];
  const guard = new BudgetGuard({
    config,
    projection: p,
    emit: (type, data, visibility) => {
      captured.push({ type, data: data as Record<string, unknown>, visibility });
    },
    now: () => new Date(atMs),
  });
  return { p, guard, captured };
}

let autoSeq = 0;

function ev(type: string, data: unknown, ts = new Date(T0).toISOString()): AppEvent {
  autoSeq += 1;
  return { seq: autoSeq, ts, type, data, visibility: defaultVisibility(type) } as unknown as AppEvent;
}

function consume(tokens: number): AppEvent {
  return ev('budget/consumed', {
    turn: 1, step: 1, lane: 'heavy', model: 'm',
    inputTokens: tokens, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: tokens,
    durationMs: 1, retryCount: 0, finishReason: 'completed', tokensTodayAccum: tokens,
  });
}

function toolCall(callId: string): AppEvent {
  return ev('tool/call', {
    turn: 1, step: 1, callId, name: 'read_file', arguments: '{}', sideEffect: 'none',
  });
}

// ──────────────────────────────── 四层硬刹车 ────────────────────────────────

test('单步层：工具调用数超上限即撞刹车，写 budget/exhausted（resumable）', () => {
  const { p, guard, captured } = setup();
  p.budget.toolCallsThisStep = 21;

  assert.deepEqual(guard.checkBeforeStep(p), { kind: 'budget-exhausted', layer: 'step' });
  assert.deepEqual(captured, [
    {
      type: 'budget/exhausted',
      data: { layer: 'step', limit: 20, actual: 21, resumable: true },
      visibility: 'internal',
    },
  ]);
});

test('单步层：恰好用满上限不算越线（第 21 次才是多余调用）', () => {
  const { p, guard, captured } = setup();
  p.budget.toolCallsThisStep = 20;

  assert.equal(guard.checkBeforeStep(p), null);
  assert.equal(captured.length, 0);
});

test('单轮层：步数达上限 → turn 层撞刹车（M3-2）', () => {
  const { p, guard, captured } = setup();
  p.budget.stepsThisTurn = 30;

  assert.deepEqual(guard.checkBeforeStep(p), { kind: 'budget-exhausted', layer: 'turn' });
  assert.deepEqual(captured[0]?.data, { layer: 'turn', limit: 30, actual: 30, resumable: true });
});

test('单任务层：累计 token 达上限 → task 层撞刹车', () => {
  const { p, guard, captured } = setup();
  p.budget.tokensTask = 500_000;

  assert.deepEqual(guard.checkBeforeStep(p), { kind: 'budget-exhausted', layer: 'task' });
  assert.deepEqual(captured[0]?.data, { layer: 'task', limit: 500_000, actual: 500_000, resumable: true });
});

test('每日层：今天累计 token 达上限 → daily 层撞刹车（M3-8 的判定侧）', () => {
  const { p, guard } = setup();
  p.budget.tokensToday = 2_000_000;

  assert.deepEqual(guard.checkBeforeStep(p), { kind: 'budget-exhausted', layer: 'daily' });
  assert.deepEqual(guard.dailyBreach(p), { layer: 'daily', limit: 2_000_000, actual: 2_000_000 });
});

test('判定顺序：多层同时越线时先报最紧的一层（先停手，再报账）', () => {
  const { p, guard } = setup();
  p.budget.toolCallsThisStep = 25;
  p.budget.stepsThisTurn = 40;
  p.budget.tokensTask = 900_000;
  p.budget.tokensToday = 3_000_000;

  assert.deepEqual(guard.checkBeforeStep(p), { kind: 'budget-exhausted', layer: 'step' });
});

test('同一个停顿只写一条 budget/exhausted（暂停是状态，不是每秒刷一条）', () => {
  const { p, guard, captured } = setup();
  p.budget.tokensTask = 600_000;

  guard.checkBeforeStep(p);
  guard.checkBeforeStep(p);
  guard.checkBeforeStep(p);
  assert.equal(captured.length, 1);

  // 投影里已有未恢复的停顿记录时，也不再重复写（跨重启后重入同一状态）
  const fresh = setup();
  fresh.p.lastExhausted['task'] = { at: new Date(T0).toISOString(), limit: 500_000, actual: 600_000 };
  fresh.p.budget.tokensTask = 600_000;
  fresh.guard.checkBeforeStep(fresh.p);
  assert.equal(fresh.captured.length, 0);
  assert.equal(fresh.guard.isPaused('task'), true);
});

test('未越线时判定为 null 且不产生任何事件', () => {
  const { p, guard, captured } = setup();
  p.budget.toolCallsThisStep = 3;
  p.budget.stepsThisTurn = 4;
  p.budget.tokensTask = 1000;
  p.budget.tokensToday = 2000;

  assert.equal(guard.checkBeforeStep(p), null);
  assert.deepEqual(guard.statuses(p).map(s => s.over), [false, false, false, false]);
  assert.deepEqual(captured, []);
});

// ──────────────────────────────── 跨重启累计（M3-3） ────────────────────────────────

test('跨重启累计：计数从事件重放，剩余额度 = 上限 − 已消耗而不是回到满格', () => {
  autoSeq = 0;
  const events: AppEvent[] = [
    ev('turn/start', { turn: 1 }),
    ev('step/start', {
      turn: 1, step: 7, model: 'm', lane: 'heavy', renderVersion: 'v1', personaHash: 'h1',
    }),
    toolCall('c1'), toolCall('c2'), toolCall('c3'),
    consume(400_000),
  ];
  // 重启等价于「从同一份日志重新折叠」：同一份投影，同样的刹车判定
  const reopened = fold(events);

  assert.equal(reopened.budget.stepsThisTurn, 7, '步号即本轮已开始的步数');
  assert.equal(reopened.budget.toolCallsThisStep, 3, '本步工具调用数由 tool/call 累计');
  assert.equal(reopened.budget.tokensTask, 400_000);
  assert.equal(reopened.budget.tokensToday, 400_000);

  const guard = new BudgetGuard(CONFIG);
  assert.equal(guard.breachOf(reopened), null, '400k < 500k：还有额度');

  // 再走两步、再吃掉 120k 后越线——累计而非重置
  const more = fold([...events, ev('step/start', {
    turn: 1, step: 8, model: 'm', lane: 'heavy', renderVersion: 'v1', personaHash: 'h1',
  }), consume(120_000)]);
  assert.equal(more.budget.stepsThisTurn, 8);
  assert.equal(more.budget.toolCallsThisStep, 0, '新 step 一开，本步工具计数归零');
  assert.deepEqual(guard.breachOf(more), { layer: 'task', limit: 500_000, actual: 520_000 });
});

test('新 turn 把单轮步数与单步工具数归零（不影响 task/daily 的累计）', () => {
  autoSeq = 0;
  const p = fold([
    ev('turn/start', { turn: 1 }),
    ev('step/start', { turn: 1, step: 3, model: 'm', lane: 'heavy', renderVersion: 'v', personaHash: 'h' }),
    toolCall('c1'), consume(1000),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' }, spoke: false }),
    ev('turn/start', { turn: 2 }),
    ev('step/start', { turn: 2, step: 1, model: 'm', lane: 'heavy', renderVersion: 'v', personaHash: 'h' }),
  ]);

  assert.equal(p.budget.stepsThisTurn, 1);
  assert.equal(p.budget.toolCallsThisStep, 0);
  assert.equal(p.budget.tokensTask, 1000, 'task 层跨 turn 累计');
  assert.equal(p.budget.tokensToday, 1000, 'daily 层跨 turn 累计');
});

// ──────────────────────────────── 软阈值（M3-4） ────────────────────────────────

test('软提示：达到 softRatio 先说话，本 turn 每层只提示一次', () => {
  const { p, guard } = setup();
  p.openTurn = { turn: 1, step: 5 };
  p.budget.stepsThisTurn = 24; // 24/30 = 0.8 ≥ softRatio

  const hint = guard.softHint(p);
  assert.ok(hint !== null);
  assert.ok(hint.includes('收尾'), '提示要说"收尾"这件事');
  assert.ok(hint.includes('单轮 24/30'), '提示里带当前比例，模型据此判断还剩多少');
  assert.equal(guard.softHint(p), null, '同一个 turn 同一层不再重复提示');

  // 换 turn 即重新武装：新一轮的刹车要重新提醒
  p.openTurn = { turn: 2, step: 1 };
  assert.ok(guard.softHint(p) !== null);
});

test('软提示：未达阈值不提示，且不因越线而免掉（提示与刹车不互斥）', () => {
  const { p, guard } = setup();
  p.openTurn = { turn: 1, step: 1 };
  p.budget.stepsThisTurn = 23;

  assert.equal(guard.softHint(p), null);

  p.budget.stepsThisTurn = 31;
  const hint = guard.softHint(p);
  assert.ok(hint !== null);
  assert.ok(hint.includes('单轮 31/30'));
});

test('软提示：多层同时达标合成一条，各层各自只计一次', () => {
  const { p, guard } = setup();
  p.openTurn = { turn: 1, step: 1 };
  p.budget.toolCallsThisStep = 18; // 0.9
  p.budget.stepsThisTurn = 26;     // 0.867
  p.budget.tokensToday = 1_700_000; // 0.85

  const hint = guard.softHint(p);
  assert.ok(hint !== null);
  assert.ok(hint.includes('单步 18/20'));
  assert.ok(hint.includes('单轮 26/30'));
  assert.ok(hint.includes('每日 1700000/2000000'));
  assert.equal(guard.softHint(p), null, '三条都提示过了');
});

// ──────────────────────────────── 恢复（M3-5） ────────────────────────────────

test('resume：写 budget/topped-up 解除暂停，进度不丢、计数不重置', () => {
  const { p, guard, captured } = setup();
  p.budget.stepsThisTurn = 30;
  assert.deepEqual(guard.checkBeforeStep(p), { kind: 'budget-exhausted', layer: 'turn' });
  assert.equal(captured.length, 1);

  guard.resume('turn', 'human', 5);
  assert.deepEqual(captured[1], {
    type: 'budget/topped-up',
    data: { layer: 'turn', addedTokens: 5, by: 'human' },
    visibility: 'internal',
  });

  // 加注后有效上限 30 + 5 = 35：当前 30 步不再越线，且已消耗的 30 步没有被清零
  assert.equal(guard.limitOf('turn'), 35);
  assert.equal(p.budget.stepsThisTurn, 30, '进度保留');
  assert.equal(guard.checkBeforeStep(p), null);

  // 再次越线仍会写事件（"已写"记忆随加注清除）
  p.budget.stepsThisTurn = 36;
  assert.deepEqual(guard.checkBeforeStep(p), { kind: 'budget-exhausted', layer: 'turn' });
  assert.equal(captured.filter(x => x.type === 'budget/exhausted').length, 2);
});

test('加注：单笔累加与从日志折叠载入（跨重启后有效上限不回退）', () => {
  const p = emptyProjection();
  p.budget.tokensTask = 500_000;
  const guard = new BudgetGuard(CONFIG);

  assert.deepEqual(guard.breachOf(p), { layer: 'task', limit: 500_000, actual: 500_000 });
  guard.addTopUp('task', 200_000);
  assert.equal(guard.limitOf('task'), 700_000);
  assert.equal(guard.breachOf(p), null);

  // 从日志折叠出的加注总量交给新建实例（重启路径）
  const totals = emptyTopUps();
  applyTopUpEvent(totals, ev('budget/topped-up', { layer: 'task', addedTokens: 100_000, by: 'human' }));
  applyTopUpEvent(totals, ev('budget/topped-up', { layer: 'daily', addedTokens: 0, by: 'rollover' }));
  applyTopUpEvent(totals, consume(9999)); // 别的事件一律不认
  const reopened = new BudgetGuard(CONFIG);
  reopened.setTopUps(totals);

  assert.equal(reopened.limitOf('task'), 600_000);
  assert.equal(reopened.limitOf('daily'), 2_000_000, 'rollover 的 0 加注不改变上限');
  assert.deepEqual(reopened.topUpTotals(), { step: 0, turn: 0, task: 100_000, daily: 0 });
  assert.equal(reopened.breachOf(p), null, '500k < 600k：加注后不再撞刹车');
});

// ──────────────────────────────── 上限的构成（config + 加注） ────────────────────────────────

test('上限的构成一眼看得出：base 来自 config、topUp 来自加注，两者相加 == limit', () => {
  const p = emptyProjection();
  // 用**现场那份配置**（task 5M / daily 2M）：现场报的是 task 57M、daily 22M
  const guard = new BudgetGuard({ ...CONFIG, taskTokens: 5_000_000, dailyTokens: 2_000_000 });
  guard.setTopUps({ step: 0, turn: 0, task: 52_000_000, daily: 20_000_000 });

  const statuses = guard.statuses(p);
  const task = statuses.find(st => st.layer === 'task')!;
  const daily = statuses.find(st => st.layer === 'daily')!;
  assert.deepEqual(task.composition, { base: 5_000_000, topUp: 52_000_000 });
  assert.equal(task.limit, task.composition.base + task.composition.topUp, '构成必须加得上');
  assert.equal(task.limit, 57_000_000, '现场报的 task 上限');
  assert.equal(daily.limit, 22_000_000, '现场报的 daily 上限');
  // 没有加注的层：topUp 为 0（不是 undefined——界面与告警读它时不该再判空）
  assert.deepEqual(statuses.find(st => st.layer === 'step')!.composition, { base: CONFIG.stepTools, topUp: 0 });
});

test('限额实时取自 config：configure 之后**立刻**按新值判（不许留一份开户时的上限副本）', () => {
  const p = emptyProjection();
  p.budget.tokensTask = 7_000_000;
  p.budget.tokensToday = 7_000_000;
  const guard = new BudgetGuard({ ...CONFIG, taskTokens: 5_000_000, dailyTokens: 5_000_000 });
  assert.deepEqual(guard.breachOf(p), { layer: 'task', limit: 5_000_000, actual: 7_000_000 }, '旧上限下越线');

  // 宿主拿到一份新配置（重启装配 / 将来的热更回调）——同一个判定器实例立刻改口径
  guard.configure({ ...CONFIG, taskTokens: 30_000_000, dailyTokens: 40_000_000 });
  assert.equal(guard.limitOf('task'), 30_000_000);
  assert.equal(guard.limitOf('daily'), 40_000_000);
  assert.deepEqual(guard.statuses(p).find(st => st.layer === 'task')!.composition, {
    base: 30_000_000, topUp: 0,
  }, '构成跟着新配置走');
  assert.equal(guard.breachOf(p), null, '新上限下不再越线——这就是"配置改了立刻按新值判"');

  // 加注那部分不许被 configure 冲掉（它是日志折出来的另一条来源）
  guard.addTopUp('task', 1_000_000);
  guard.configure({ ...CONFIG, taskTokens: 30_000_000, dailyTokens: 40_000_000 });
  assert.equal(guard.limitOf('task'), 31_000_000, '有效上限 = 新配置 + 累计加注');
});

test('configure 之后"本进程已写过"的标记重新武装：新上限下再撞仍会落事件', () => {
  const p = emptyProjection();
  p.budget.tokensTask = 6_000_000;
  const captured: Array<{ type: string; data: unknown }> = [];
  const guard = new BudgetGuard({
    config: { ...CONFIG, taskTokens: 5_000_000 },
    projection: p,
    emit: (type, data) => captured.push({ type, data }),
    now: () => new Date(T0),
  });
  assert.deepEqual(guard.checkBeforeStep(p), { kind: 'budget-exhausted', layer: 'task' });
  assert.equal(captured.filter(x => x.type === 'budget/exhausted').length, 1);

  // 上限调大 → 不再越线；再调小 → 又越线。第二次必须还能写事件（否则改完配置这一层哑了）
  guard.configure({ ...CONFIG, taskTokens: 30_000_000 });
  assert.equal(guard.checkBeforeStep(p), null);
  guard.configure({ ...CONFIG, taskTokens: 1_000_000 });
  assert.deepEqual(guard.checkBeforeStep(p), { kind: 'budget-exhausted', layer: 'task' });
  assert.equal(captured.filter(x => x.type === 'budget/exhausted').length, 2);
});

// ──────────────────────────────── 单步工具数（M3-1） ────────────────────────────────

test('单步切分与收束：超限部分不执行，收束结局由预算实现给出', () => {
  const { guard, captured } = setup();
  const calls = Array.from({ length: 23 }, (_, i) => `c${i + 1}`);

  const split = guard.limitStepCalls(calls);
  assert.equal(split.allowed.length, 20);
  assert.deepEqual(split.over, ['c21', 'c22', 'c23']);

  assert.deepEqual(guard.noteStepOverflow(23), { kind: 'budget-exhausted', layer: 'step' });
  assert.deepEqual(captured[0]?.data, { layer: 'step', limit: 20, actual: 23, resumable: true });
  assert.equal(guard.stepCallLimit(), 20);
});

test('判定版（宿主自己写事件的形状）：breachOf / failBreach / stall 三路判定', () => {
  const p = emptyProjection();
  p.pending.push({ wakeSeq: 1, source: 'manual', claimCount: 0 });
  const guard = new BudgetGuard(CONFIG, { stallMs: 10 * MIN_MS });

  // 停滞的计时起点是**输入自己的到达时刻**（2026-10-03 改口径：原来量的是"距上次成功模型调用"，
  // 于是正常空闲一被新输入打破就误报）
  const observation = (nowMs: number, busy = false) => ({
    pending: p.pending.length,
    oldestPendingAt: new Date(T0).toISOString(),
    busy,
    now: new Date(nowMs),
  });

  assert.equal(guard.stall(observation(T0 + 9 * MIN_MS)), null, '未到阈值不算停滞');
  const stall = guard.stall(observation(T0 + 11 * MIN_MS));
  assert.ok(stall !== null);
  assert.equal(stall.pending, 1);
  assert.equal(stall.oldestPendingAt, new Date(T0).toISOString());
  assert.ok(stall.waitedMs >= 10 * MIN_MS, '停滞时长 = 最早那条输入已经等了多久');

  // 循环手上有活（一个 turn 正在跑）时输入排队是正常背压，不是停滞
  assert.equal(guard.stall(observation(T0 + 60 * MIN_MS, true)), null);

  // 队列空时不报停滞（没人等，就不是停滞）
  p.pending = [];
  assert.equal(guard.stall(observation(T0 + 60 * MIN_MS)), null);

  p.failStreak = 5;
  assert.deepEqual(guard.failBreach(p), { limit: 5, actual: 5 });
  p.failStreak = 4;
  assert.equal(guard.failBreach(p), null);

  // 判定版不持有投影：checkBeforeStep 必须显式传投影，不传就明确报错而不是默默放行
  assert.throws(() => guard.checkBeforeStep(), /未持有投影/u);
  p.budget.stepsThisTurn = 30;
  assert.equal(guard.checkBeforeStep(p)?.kind, 'budget-exhausted');
});

test('stallOf（唯一一份判据）：到达时刻读不出来时不报，而不是拿当前时刻编一个时长', () => {
  const now = new Date(T0 + 60 * MIN_MS);
  assert.equal(stallOf({ pending: 1, oldestPendingAt: null, busy: false, now, stallMs: MIN_MS }), null);
  assert.equal(stallOf({ pending: 1, oldestPendingAt: '不是时间', busy: false, now, stallMs: MIN_MS }), null);
  // 阈值是严格大于：刚好等于阈值那一拍不报
  assert.equal(
    stallOf({ pending: 2, oldestPendingAt: new Date(T0).toISOString(), busy: false, now: new Date(T0 + MIN_MS), stallMs: MIN_MS }),
    null,
  );
  assert.notEqual(
    stallOf({
      pending: 2, oldestPendingAt: new Date(T0).toISOString(), busy: false,
      now: new Date(T0 + MIN_MS + 1), stallMs: MIN_MS,
    }),
    null,
  );
});

// ──────────────────────────────── 加注看门文件 ────────────────────────────────

test('加注看门文件：CLI 写、循环解析，同毫秒不覆盖，非法内容返回 null', (t: TestContext) => {
  const dir = tempDirSync('irmia-topup-');
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const request: TopUpRequest = {
    layer: 'turn',
    addedTokens: 10,
    by: 'human',
    ts: new Date(T0).toISOString(),
  };
  const path = writeTopUpRequest(dir, request, new Date(T0));
  assert.ok(path.includes(TOPUP_WATCH_DIR_NAME));
  assert.ok(path.includes(TOPUP_FILE_PREFIX));
  assert.deepEqual(parseTopUpRequest(readFileSync(path, 'utf8')), request);

  const second = writeTopUpRequest(dir, request, new Date(T0));
  assert.notEqual(second, path, '同毫秒第二次加注向后借 1ms，绝不覆盖');
  assert.equal(readdirSync(join(dir, TOPUP_WATCH_DIR_NAME)).length, 2);

  assert.equal(parseTopUpRequest('{ 半截 JSON'), null);
  assert.equal(parseTopUpRequest(JSON.stringify({ layer: 'tsak', addedTokens: 1, by: 'human', ts: 'x' })), null);
  assert.equal(parseTopUpRequest(JSON.stringify({ layer: 'turn', addedTokens: -1, by: 'human', ts: 'x' })), null);
  assert.deepEqual(applyTopUpEventAndRead({ layer: 'turn', addedTokens: 7, by: 'h', ts: 'x' }), 7);
});

/** 小工具：造一条 topped-up 事件走一遍折叠，返回该层累计 */
function applyTopUpEventAndRead(request: TopUpRequest): number {
  const totals = emptyTopUps();
  applyTopUpEvent(totals, ev('budget/topped-up', {
    layer: request.layer, addedTokens: request.addedTokens, by: request.by,
  }));
  return totals[request.layer];
}
