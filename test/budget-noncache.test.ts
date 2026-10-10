/**
 * 预算换口径 — **单日只算"不命中缓存的部分"**（2026-10-05 定的口径）
 *
 * 定义（**唯一一处**在 `src/state/fold.ts` 的 `budgetTokensOf`）：
 *
 *     计入预算的 token = (inputTokens − cacheHitTokens) + outputTokens
 *
 * 这个文件钉四件事（判据只紧不松）：
 *   ① **命中不计**：一条调用里 cacheHit 很大、未命中很小 ⇒ 日累计只加未命中那部分 + 输出；
 *   ② **输出计**：输出一律进累计（哪怕输入整段命中缓存）；
 *   ③ **撞顶**：累计到日额度（出厂默认 5e7）⇒ `budget/exhausted{layer:'daily'}`；
 *   ④ **回归**：step / turn 两层的判定与改口径前**逐字一致**（它们数的是次数，不受 token 口径影响），
 *      且 task 层与 daily 层**同一个口径**（不许一层一个口径——那正是"不协调"）。
 *
 * 全部用例用固定时刻与自增 seq 构造事件，不读环境时钟、不依赖真实时间流逝。
 */

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { emptyProjection, defaultVisibility } from '../src/log/types.ts';
import type { AppEvent } from '../src/log/types.ts';
import { BudgetGuard, type BudgetGuardConfig } from '../src/runtime/budget-guard.ts';
import { applyOne, budgetTokensOf, fold } from '../src/state/fold.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const T0 = Date.parse('2026-10-05T00:00:00Z');

let autoSeq = 0;

/** `parentCallId` 必须挂在**事件**上（fold 按它分派父子归属），不是 data 里 */
function evt(type: string, data: unknown, parentCallId?: string): AppEvent {
  autoSeq += 1;
  return {
    seq: autoSeq,
    ts: new Date(T0).toISOString(),
    type,
    data,
    visibility: defaultVisibility(type),
    ...(parentCallId === undefined ? {} : { parentCallId }),
  } as unknown as AppEvent;
}

/** 一条完整的消耗事实（字段一个不少：投影靠它累计，缺字段就是伪造事实） */
function consumed(d: {
  lane?: 'heavy' | 'light';
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  turn?: number;
  step?: number;
  /** 子代理链：挂在父层记账上（`parentCallId` 非空走 applySubagentEvent） */
  parentCallId?: string;
}): AppEvent {
  const cacheMissTokens = Math.max(0, d.inputTokens - d.cacheHitTokens);
  return evt('budget/consumed', {
    turn: d.turn ?? 1,
    step: d.step ?? 1,
    lane: d.lane ?? 'heavy',
    model: 'noncache-fixture',
    inputTokens: d.inputTokens,
    outputTokens: d.outputTokens,
    cacheHitTokens: d.cacheHitTokens,
    cacheMissTokens,
    durationMs: 1,
    retryCount: 0,
    finishReason: 'completed',
    // 观测字段（写入方口径是"投影基线 + in + out"的混合口径，见 docs/schema.md §6 该字段注释）
    // ——这里刻意给个旧口径的数，证明**判据不读它**：投影只按 budgetTokensOf 累
    tokensTodayAccum: d.inputTokens + d.outputTokens,
  }, d.parentCallId);
}

/** 出厂默认那套额度（5e7 日 / 5e8 单任务）——撞顶用例按**出厂值**判，不另编一套数 */
function factoryBudget(): BudgetGuardConfig {
  return defaultConfig(tmpdir()).budget;
}

// ──────────────────────────────── ① 命中不计 ────────────────────────────────

test('① 命中不计：日累计只加"未命中的输入 + 输出"，命中那一大截一分不加', () => {
  autoSeq = 0;
  const p = fold([
    // 心跳那一拍的真实形状（design.md §4.12 的实测分量：一拍里命中约 4.2 万、未命中约 0.36 万、
    // 输出约 350）⇒ 计入预算 = 3,600 + 350 = 3,950。旧口径会记成 45,950（差 11 倍）。
    consumed({ inputTokens: 45_600, outputTokens: 350, cacheHitTokens: 42_000 }),
    // 第二条：输入整段命中缓存（命中 = 输入），只有输出是真花钱的
    consumed({ inputTokens: 1_000, outputTokens: 200, cacheHitTokens: 1_000, lane: 'light' }),
  ]);

  assert.equal(p.budget.tokensToday, 3_950 + 200, '① 只加 (input − cacheHit) + output');
  assert.equal(p.budget.tokensTodayHeavy, 3_950);
  assert.equal(p.budget.tokensTodayLight, 200);
  assert.equal(p.budget.tokensToday, p.budget.tokensTodayHeavy + p.budget.tokensTodayLight);
  // 原始分量照旧折（它们是记录，喂缓存命中率那条观测）——别拿它们与上面的数对账
  assert.equal(p.budget.cacheHitToday, 43_000);
  assert.equal(p.budget.cacheMissToday, 3_600);
  // 反面锁：旧口径的两个数都必须**不等于**累计值（改回旧口径这条立刻红）
  assert.notEqual(p.budget.tokensToday, 45_600 + 350 + 1_000 + 200, '不许是"未扣缓存"的总量');
  assert.notEqual(p.budget.tokensToday, 43_000 + 4_150, '也不许把命中那部分算进来');
});

test('① 口径函数本身：命中数不许超过输入数（坏日志），坏值一律当 0', () => {
  assert.equal(budgetTokensOf({ inputTokens: 100, cacheHitTokens: 30, outputTokens: 20 }), 90);
  assert.equal(budgetTokensOf({ inputTokens: 100, cacheHitTokens: 100, outputTokens: 5 }), 5);
  // cacheHit > input 的手写日志：夹住，算 0 而不是负数（负累计会让预算倒着走）
  assert.equal(budgetTokensOf({ inputTokens: 100, cacheHitTokens: 180, outputTokens: 5 }), 5);
  assert.equal(budgetTokensOf({ inputTokens: Number.NaN, cacheHitTokens: 1, outputTokens: 2 }), 2);
  assert.equal(budgetTokensOf({ inputTokens: -5, cacheHitTokens: 0, outputTokens: -1 }), 0);
});

// ──────────────────────────────── ② 输出计 ────────────────────────────────

test('② 输出计：输入整段命中缓存时，计入的只有输出', () => {
  autoSeq = 0;
  const p = fold([consumed({ inputTokens: 40_000, outputTokens: 512, cacheHitTokens: 40_000 })]);

  assert.equal(p.budget.tokensToday, 512, '输出没有缓存一说，每一次都按全价计');
  assert.equal(p.budget.cacheMissToday, 0);
  assert.equal(p.budget.cacheHitToday, 40_000, '输入确实全命中了——但一分钱都不进预算');
});

// ──────────────────────────────── ③ 撞顶 ────────────────────────────────

test('③ 撞顶：非缓存累计到日额度（出厂 5e7）⇒ budget/exhausted{layer: daily}', () => {
  autoSeq = 0;
  const budget = factoryBudget();
  assert.equal(budget.dailyTokens, 50_000_000, '出厂日额度 = 5e7（单日非缓存预算）');
  assert.equal(budget.taskTokens, 500_000_000, '出厂单任务额度 = 5e8（= 日额度的 10 倍）');

  const p = emptyProjection();
  const sink: Array<{ type: string; data: Record<string, unknown> }> = [];
  const guard = new BudgetGuard({
    config: budget,
    projection: p,
    emit: (type, data) => { sink.push({ type, data: data as Record<string, unknown> }); },
    now: () => new Date(T0),
  });

  // 心跳一拍的真实形状：input 4.5 万、命中 97%（约 43,650）、输出 350 ⇒ 计入 1,350 + 350 = 1,700。
  // 旧口径下每次是 45,350 ⇒ 到不了这个额度就早已"预算耗尽"；新口径下要 29,412 拍才见顶
  //（5e7 / 1,700 ≈ 29,412 拍 ≈ 306 天的心跳），所以这里不再逐拍循环，直接构造"差一拍"的累计。
  const perCall = budgetTokensOf({ inputTokens: 45_000, cacheHitTokens: 43_650, outputTokens: 350 });
  assert.equal(perCall, 1_700);

  // 先把累计推到"再一拍就正好撞线"的位置：5e7 − 1,700 = 49,998,300。
  // 用整数倍关系把"跨线那一格"落在 5e7 上（daily 那层是 `used >= limit` 语义，到线即停）——
  // 于是这一拍同时钉住两件事：**到线就停**，以及"停在线上"不等于"还没到线"。
  const below = budget.dailyTokens - perCall;
  applyOne(p, consumed({ inputTokens: below, outputTokens: 0, cacheHitTokens: 0 }));
  assert.equal(p.budget.tokensToday, below, '累计 = 非缓存量（这次 input 整段未命中）');
  assert.ok(p.budget.tokensToday < budget.dailyTokens, '还没到顶：判 null');
  assert.equal(guard.checkBeforeStep(p), null);
  assert.equal(guard.dailyBreach(p), null);

  // 再来一拍（1,700）：below + 1,700 = 5e7 ⇒ 正好到线，日那一层撞线
  applyOne(p, consumed({ inputTokens: 45_000, outputTokens: 350, cacheHitTokens: 43_650 }));
  assert.equal(p.budget.tokensToday, budget.dailyTokens);
  assert.deepEqual(guard.checkBeforeStep(p), { kind: 'budget-exhausted', layer: 'daily' });
  assert.deepEqual(sink.at(-1), {
    type: 'budget/exhausted',
    data: { layer: 'daily', limit: 50_000_000, actual: 50_000_000, resumable: true },
  });
  assert.deepEqual(guard.dailyBreach(p), { layer: 'daily', limit: 50_000_000, actual: 50_000_000 });
});

test('③ 单任务那一层比日额度宽：同一次累计先撞 daily，不会先撞 task', () => {
  autoSeq = 0;
  const budget = factoryBudget();
  const p = emptyProjection();
  const guard = new BudgetGuard(budget);

  // 跨过日线、但远没到单任务线（5e7 < 5e8）
  applyOne(p, consumed({ inputTokens: budget.dailyTokens + 800, outputTokens: 0, cacheHitTokens: 0 }));

  assert.equal(p.budget.tokensTask, p.budget.tokensToday, 'task 与 daily 同口径、同累计（差只差日界清零）');
  assert.equal(guard.breachOf(p)?.layer, 'daily', '5e8 的 task 层还没到，先响的是 5e7 的日那层');
});

// ──────────────────────────────── ④ 回归：别的三层一个字没动 ────────────────────────────────

test('④ 回归：step / turn 两层数的是次数，与 token 口径无关（改口径前后逐字一致）', () => {
  autoSeq = 0;
  const budget = factoryBudget();
  const p = emptyProjection();
  const guard = new BudgetGuard(budget);

  // 一次"整段命中"的调用也照样把步数/工具数往前推——它们数的是动作，不是钱
  applyOne(p, evt('turn/start', { turn: 1 }));
  applyOne(p, evt('step/start', { turn: 1, step: 20, model: 'm', lane: 'heavy', renderVersion: 'v', personaHash: 'h' }));
  applyOne(p, evt('tool/call', { turn: 1, step: 20, callId: 'c1', name: 'read_file', arguments: '{}', sideEffect: 'none' }));
  applyOne(p, consumed({ inputTokens: 90_000, outputTokens: 10, cacheHitTokens: 90_000, step: 20 }));

  assert.equal(p.budget.stepsThisTurn, 20);
  assert.equal(p.budget.toolCallsThisStep, 1);
  assert.equal(p.budget.tokensToday, 10, 'token 那边只加了输出');
  assert.equal(
    guard.checkBeforeStep(p), null,
    `20 步 / 1 次调用都没到线（turn ${budget.turnSteps} / step ${budget.stepTools}）`,
  );

  // 单步超限：第 21 次工具调用才越线（`>` 语义，与改口径前一致）
  assert.deepEqual(guard.limitStepCalls(Array.from({ length: 23 }, (_, i) => `c${i}`)), {
    allowed: Array.from({ length: 20 }, (_, i) => `c${i}`),
    over: ['c20', 'c21', 'c22'],
  });
  // 单轮达上限即停（`>=` 语义）。
  // 步数**按出厂值取**（不是写死 30）：这条用例判的是"turn 那一层数的是次数、与 token 口径无关"，
  // 不是"出厂 turnSteps 等于多少"——那个数字由 test/config.test.ts 的地板那条钉着。
  // 写死的话，出厂值一改这条就变成"什么都没测"（而不是失败），那是最坏的一种测试。
  applyOne(p, evt('step/start', {
    turn: 1, step: budget.turnSteps, model: 'm', lane: 'heavy', renderVersion: 'v', personaHash: 'h',
  }));
  assert.deepEqual(guard.checkBeforeStep(p), { kind: 'budget-exhausted', layer: 'turn' });
});

test('④ 回归：子代理链的消耗折进父层记账时也走同一个口径（四层统一）', () => {
  autoSeq = 0;
  // 走 fold（= applyEvent 的归属分派）：子代理链事件按 `parentCallId` 只折父层记账，
  // turn/tool 链一律不进父层状态机（applyOne 是"本层"那条路，这里不用它）
  const p = fold([
    consumed({ inputTokens: 20_000, outputTokens: 100, cacheHitTokens: 19_000, parentCallId: 'call_parent' }),
    evt('turn/start', { turn: 9 }, 'call_parent'),
  ]);

  assert.equal(p.budget.tokensToday, 1_000 + 100, '子代理烧的钱按同一口径扣父任务额度');
  assert.equal(p.budget.tokensTask, 1_100);
  assert.equal(p.openTurn, null, '子代理的 turn 不进父层状态机（口径统一不等于归属混乱）');
});

test('④ 回归：跨天 rollover 清 today 系、保留 tokensTask（口径不变）', () => {
  autoSeq = 0;
  const p = fold([
    consumed({ inputTokens: 10_000, outputTokens: 100, cacheHitTokens: 9_500 }),
    evt('budget/rollover', { date: '2026-10-06' }),
    consumed({ inputTokens: 10_000, outputTokens: 100, cacheHitTokens: 9_000 }),
  ]);

  assert.equal(p.budget.tokensToday, 1_000 + 100, '只算 rollover 之后那一条（(10000−9000) + 100）');
  assert.equal(p.budget.tokensTask, 600 + 1_100, 'task 跨日累计，不清零');
  assert.equal(p.budget.date, '2026-10-06');
});
