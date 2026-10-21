/**
 * 「任务」这一层的边界：**task 层暂停被解除 = 那次任务结束 ⇒ `tokensTask` 归零**
 * （2026-10-05 实测的第二处缺陷，`docs/review.md` 的「单任务没有边界」）
 *
 * 病：`tokensTask` 在 fold 里**只累加、永不归零**，于是它数的是"这个进程从第一天到今天一共
 * 花了多少"，而不是"这次任务花了多少"。现场按非缓存口径全量重放出来是 13,443,843，
 * 而 config 里的单任务额度是 5,000,000 ⇒ **就算把旧快照全部丢掉、账重算一遍，
 * 下一次 turn 照样被立刻拒掉**（`budget/exhausted{layer:'task'}` → `turn/end{budget-exhausted}`）。
 *
 * 边界口径（用户 2026-10-05 拍板）：解除 task 层暂停只有一个来源，两条路都算同一条边界——
 *   · `budget/topped-up{layer:'task'}`（人工加注）；
 *   · `budget/resumed{layer:'task'}`（上限被调大）。
 * 两条都意味着"上一段工作已经收尾、现在开始新的一段"。`tokensTask` 归零，`tokensToday` 不动
 * ——日额度是主力刹车，"新任务"不免掉今天的账。
 *
 * 这份文件钉五条（判据只紧不松）：
 *   ① 加注解除 ⇒ 归零；② 日层/步层的解除**不许**顺手清任务账；
 *   ③ `budget/resumed` 那条路同样归零；④ 归零之后同一个额度下能真跑起来（判定层不再拒）；
 *   ⑤ 现场形状的复刻：归零只清任务账，今日累计与 hit/miss 记录逐字节不变。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { emptyProjection, defaultVisibility } from '../src/log/types.ts';
import type { AppEvent } from '../src/log/types.ts';
import { BudgetGuard } from '../src/runtime/budget-guard.ts';
import { applyOne, fold } from '../src/state/fold.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const T0 = Date.parse('2026-10-05T00:00:00Z');

let autoSeq = 0;

function evt(type: string, data: unknown): AppEvent {
  autoSeq += 1;
  return {
    seq: autoSeq, ts: new Date(T0).toISOString(), type, data, visibility: defaultVisibility(type),
  } as unknown as AppEvent;
}

/** 一条消耗事实（现场量级：命中远大于未命中） */
function consumed(inputTokens: number, cacheHitTokens: number, outputTokens: number): AppEvent {
  return evt('budget/consumed', {
    turn: 1, step: 1, lane: 'heavy', model: 'task-boundary-fixture',
    inputTokens, outputTokens, cacheHitTokens,
    cacheMissTokens: Math.max(0, inputTokens - cacheHitTokens),
    durationMs: 1, retryCount: 0, finishReason: 'completed',
  });
}

function factoryBudget(): ReturnType<typeof defaultConfig>['budget'] {
  return defaultConfig('D:\\irmia-task-boundary').budget;
}

// ──────────────────────────────── ① 加注解除 ⇒ 归零 ────────────────────────────────

test('① 人工加注解除 task 层暂停 ⇒ tokensTask 归零；tokensToday 一分不动', () => {
  autoSeq = 0;
  const p = fold([
    evt('budget/rollover', { date: '2026-10-05' }),
    consumed(45_000, 43_650, 350), // 非缓存 1,700
    consumed(20_000, 19_000, 1_000), // 非缓存 2,000
    evt('budget/exhausted', { layer: 'task', limit: 2_000_000, actual: 3_700, resumable: true }),
    evt('budget/topped-up', { layer: 'task', addedTokens: 5_000_000, by: 'owner' }),
  ]);

  assert.equal(p.budget.tokensTask, 0, '① 任务边界：解除即归零');
  assert.equal(p.budget.tokensToday, 3_700, '① 今天的账不许跟着清（日额度是主力刹车）');
  assert.equal(p.budget.tokensTodayHeavy, 3_700);
  assert.equal(p.budget.cacheHitToday, 43_650 + 19_000, '① 记录分量原样留着');
  assert.equal(p.budget.cacheMissToday, 1_350 + 1_000);
  assert.equal(p.budget.date, '2026-10-05');
  assert.equal(p.lastExhausted['task'], undefined, '① 暂停记录照旧被清（老行为不许回退）');
});

test('① 归零之后新任务重新累计：再花一笔就只算这一笔', () => {
  autoSeq = 0;
  const events = [
    consumed(45_000, 43_650, 350), // 1,700
    evt('budget/topped-up', { layer: 'task', addedTokens: 1_000, by: 'owner' }),
  ];
  const p = fold(events);
  assert.equal(p.budget.tokensTask, 0);
  applyOne(p, consumed(10_000, 9_000, 500)); // 1,500
  assert.equal(p.budget.tokensTask, 1_500, '新任务从零开始数');
  assert.equal(p.budget.tokensToday, 3_200, '今天的账继续累（1,700 + 1,500）');
});

// ──────────────────────────────── ② 别的层解除不许清任务账 ────────────────────────────────

test('② 日层 / 步层 / 轮层的解除：不许顺手清掉任务账（边界只属于 task 那一层）', () => {
  autoSeq = 0;
  const p = fold([
    consumed(45_000, 43_650, 350), // 1,700
    evt('budget/exhausted', { layer: 'daily', limit: 1_000, actual: 1_700, resumable: true }),
    evt('budget/topped-up', { layer: 'daily', addedTokens: 10_000, by: 'owner' }),
    evt('budget/resumed', { layer: 'daily', limit: 20_000, actual: 1_700, reason: 'limit-raised' }),
    evt('budget/resumed', { layer: 'step', limit: 40, actual: 21, reason: 'limit-raised' }),
    evt('budget/resumed', { layer: 'turn', limit: 60, actual: 30, reason: 'limit-raised' }),
  ]);

  assert.equal(p.budget.tokensTask, 1_700, '② 只有 task 层的解除才是任务边界——别层解除不许动这一格');
  assert.equal(p.budget.tokensToday, 1_700);
});

// ──────────────────────────────── ③ budget/resumed 那条路 ────────────────────────────────

test('③ 上限被调大解除 task 层暂停（budget/resumed）⇒ 同样归零', () => {
  autoSeq = 0;
  const p = fold([
    evt('budget/rollover', { date: '2026-10-05' }),
    consumed(50_000, 45_000, 1_000), // 6,000
    evt('budget/exhausted', { layer: 'task', limit: 5_000, actual: 6_000, resumable: true }),
    // 现场那条：`budget/resumed{layer:'task', limit:57000000, actual:178734979, reason:'limit-raised'}`
    evt('budget/resumed', { layer: 'task', limit: 30_000_000, actual: 6_000, reason: 'limit-raised' }),
  ]);

  assert.equal(p.budget.tokensTask, 0, '③ 抬上限解除也是一条任务边界');
  assert.equal(p.budget.tokensToday, 6_000);
});

// ──────────────────────────────── ④ 归零之后判定层真的放行 ────────────────────────────────

test('④ 归零之后同一个额度下能跑：checkBeforeStep 不再报 task 层', () => {
  autoSeq = 0;
  const budget = { ...factoryBudget(), taskTokens: 5_000, dailyTokens: 2_000_000 };
  const p = fold([
    consumed(50_000, 45_000, 1_000), // 6,000 > taskTokens 5,000 ⇒ 撞线
  ]);
  const guard = new BudgetGuard({ config: budget, projection: p, emit: () => {}, now: () => new Date(T0) });
  assert.deepEqual(guard.checkBeforeStep(p), { kind: 'budget-exhausted', layer: 'task' }, '撞线时照旧拒');

  // 加注解除（走判定器的恢复路径：写事件 + 折进投影）
  const emitted: Array<{ type: string; data: unknown }> = [];
  const p2 = fold([consumed(50_000, 45_000, 1_000)]);
  const guard2 = new BudgetGuard({
    config: budget,
    projection: p2,
    emit: (type, data) => {
      emitted.push({ type, data });
      applyOne(p2, evt(type, data));
    },
    now: () => new Date(T0),
  });
  assert.deepEqual(guard2.checkBeforeStep(p2), { kind: 'budget-exhausted', layer: 'task' });
  assert.deepEqual(emitted.map(e => e.type), ['budget/exhausted'], '判定即落事件（撞线那一条）');
  guard2.resume('task', 'owner', 5_000_000);
  assert.deepEqual(emitted.map(e => e.type), ['budget/exhausted', 'budget/topped-up'], '加注落自己那条事件');
  assert.equal(p2.budget.tokensTask, 0, '④ 解除事件一折进来，任务账就归零');
  assert.equal(guard2.checkBeforeStep(p2), null, '④ 下一次 step 边界真的放行（这就是现场缺的那一步）');
  assert.equal(guard2.dailyBreach(p2), null, '④ 日层也没被牵连');
});

// ──────────────────────────────── ⑤ 现场形状的复刻 ────────────────────────────────

test('⑤ 现场复刻：归零只清任务账，今日累计与 hit/miss 逐字节不变（全量折叠与增量折叠同结论）', () => {
  autoSeq = 0;
  // 600 条心跳拍的非缓存量（每条 1,700）⇒ 今日 1,020,000；task 曾经一路累到撞线
  const events: AppEvent[] = [evt('budget/rollover', { date: '2026-10-05' })];
  for (let i = 0; i < 600; i++) events.push(consumed(45_000, 43_650, 350));
  events.push(evt('budget/exhausted', { layer: 'task', limit: 5_000_000, actual: 1_020_000, resumable: true }));
  events.push(evt('budget/resumed', { layer: 'task', limit: 40_000_000, actual: 1_020_000, reason: 'limit-raised' }));

  const full = fold(events);
  // 增量折叠（运行期那条路）必须得到同一结论
  const incremental = emptyProjection();
  for (const e of events) applyOne(incremental, e);

  assert.equal(full.budget.tokensTask, 0);
  assert.equal(incremental.budget.tokensTask, 0, '⑤ 增量与全量同结论');
  assert.equal(full.budget.tokensToday, 1_020_000, '⑤ 今日累计原样（这是真花掉的那部分）');
  assert.equal(incremental.budget.tokensToday, full.budget.tokensToday);
  assert.equal(full.budget.cacheHitToday, 600 * 43_650);
  assert.equal(incremental.budget.cacheHitToday, full.budget.cacheHitToday);
  assert.equal(full.budget.cacheMissToday, 600 * 1_350);
  // 归零之后按现场那套额度重判：不撞（旧行为是 tokensTask=1,020,000 接着涨，终将撞死）
  const guard = new BudgetGuard({
    config: { ...factoryBudget(), taskTokens: 30_000_000, dailyTokens: 40_000_000 },
    projection: full,
    emit: () => {},
    now: () => new Date(T0),
  });
  assert.equal(guard.checkBeforeStep(full), null);
});

test('⑤ 归零是**事件**驱动的，不是"进程内存里的一次清空"：重启重放同一结论', () => {
  autoSeq = 0;
  const events = [
    consumed(45_000, 43_650, 350),
    evt('budget/topped-up', { layer: 'task', addedTokens: 5_000_000, by: 'owner' }),
    consumed(10_000, 9_000, 500),
  ];
  const first = fold(events);
  const second = fold(events); // 同一份日志折两次
  assert.equal(first.budget.tokensTask, 1_500);
  assert.equal(second.budget.tokensTask, first.budget.tokensTask, '同一份日志永远折出同一个投影');
});
