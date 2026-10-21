/**
 * 运行情况页的状态与告警判据 — `src/web/server.ts` 的 `livePausedLayers` 与 `pairedRecoveries`
 * 通过 `buildDashboard` / `/api/framework-notes` 两条真实路径验。
 *
 * 立这份测试的三条意见（用户 2026-10-05，逐字）：
 *   > 「GUI 上还是一直显示预算耗尽」+ 左上角状态「已暂停（预算耗尽）」——**那是旧状态没被解除**；
 *   > 「框架提示」里那条 17:33 的"预算耗尽（任务 token）：已用 178734979 / 上限 57000000"
 *   > 也还以"严重"挂在最上面（数字还是当时算错的那批）。
 *
 * 所以三件事各钉一条：
 *   ① 有 recovered 配对的旧告警**不再按当前严重渲染**（配到 `recovered:true` + `historical`）；
 *   ② **没有配对的照旧严重**（不许把还没好的事说成好了）；
 *   ③ 状态文本按**当刻**走，且"曾经耗尽、现已恢复"有一个说得出来的形态。
 *
 * 现场那个投影的形状是逐字抄来的（`data/projection.json` 实测：`lastExhausted` 里只剩
 * `turn` 层一条 `limit=30, actual=30`，而它后面的每个 turn 都从第 1 步重新开始）。
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import type { AppEvent, BudgetLayer, Projection } from '../src/log/types.ts';
import { applyEvent, fold } from '../src/state/fold.ts';
import { emptyProjection } from '../src/log/types.ts';
import { buildDashboard, livePausedLayers } from '../src/web/server.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const T0 = new Date('2026-10-05T15:40:00.000Z');

let seq = 0;
/** 造一条事件（只填折叠真正读到的字段，形状按 src/log/types.ts） */
function event(type: string, data: unknown, at: number = T0.getTime()): AppEvent {
  seq += 1;
  return {
    seq,
    ts: new Date(at).toISOString(),
    type,
    data,
    visibility: 'internal',
    origin: 'test/state',
  } as unknown as AppEvent;
}

/** 用户机器上的那份投影（实测形状）：只有 turn 层那条陈旧的撞线记录 */
function projectionWithStaleTurnPause(): Projection {
  const p = emptyProjection();
  applyEvent(p, event('budget/exhausted', { layer: 'turn', limit: 30, actual: 30 }));
  // 之后又跑过 turn：每一步都从第 1 步重新数（`step/start` 无条件赋值）
  applyEvent(p, event('turn/start', { turn: 41 }));
  applyEvent(p, event('step/start', { turn: 41, step: 1 }));
  return p;
}

test('状态判据：turn 层那条陈旧的撞线记录（计数器已归零）不再算暂停', () => {
  const p = projectionWithStaleTurnPause();
  assert.deepEqual(
    Object.keys(p.lastExhausted), ['turn'],
    '前提：投影里确实留着那条记录（投影不保证它会消失，这是那个 bug 的根）',
  );
  assert.deepEqual(livePausedLayers(p), [], '当刻本 turn 才第 1 步，而记录说撞在第 30 步 ⇒ 早就不在暂停态');
});

test('状态判据：真撞线时照旧是暂停（判据只收紧"陈旧记录"，不放行真暂停）', () => {
  const p = emptyProjection();
  applyEvent(p, event('budget/exhausted', { layer: 'turn', limit: 30, actual: 30 }));
  applyEvent(p, event('turn/start', { turn: 42 }));
  applyEvent(p, event('step/start', { turn: 42, step: 30 }));
  assert.deepEqual(livePausedLayers(p), ['turn'], '步数到达上限 = 真停着');

  const step = emptyProjection();
  applyEvent(step, event('budget/exhausted', { layer: 'step', limit: 20, actual: 21 }));
  applyEvent(step, event('step/start', { turn: 1, step: 1 }));
  for (let i = 0; i < 21; i += 1) applyEvent(step, event('tool/call', { callId: `c${i}`, name: 't', arguments: {} }));
  assert.deepEqual(livePausedLayers(step), ['step'], '工具调用数超过上限 = 真停着');
});

test('状态判据：task / daily 两层照旧按投影（运行期那条路的账，服务端不替它判）', () => {
  const p = emptyProjection();
  applyEvent(p, event('budget/exhausted', { layer: 'task', limit: 100, actual: 120 }));
  applyEvent(p, event('budget/exhausted', { layer: 'daily', limit: 500, actual: 600 }));
  assert.deepEqual(livePausedLayers(p), ['daily', 'task'], '两层都没有计数器语义：只有 budget/resumed 能销账');

  // 真落了 budget/resumed（运行期解账）之后，它自然不在列表里
  applyEvent(p, event('budget/resumed', { layer: 'daily', limit: 900, actual: 600 }));
  assert.deepEqual(livePausedLayers(p), ['task']);
});

test('状态判据：不可恢复的暂停（人审挂起超时）不被计数器顺手解开', () => {
  const p = emptyProjection();
  applyEvent(p, event('budget/exhausted', {
    layer: 'task', limit: 10, actual: 5, resumable: false,
  } as unknown as Record<string, unknown>));
  assert.deepEqual(livePausedLayers(p), ['task'], '它的解除条件是"人答了"，不是计数器');
});

test('状态文本：曾经耗尽、现已恢复 ⇒ 不是 paused，且有一句说得出来的下文', () => {
  const p = projectionWithStaleTurnPause();
  const view = buildDashboard({ projection: p, events: [], now: T0, personaRoot: emptyDir() });
  assert.notEqual(view.state, 'paused', '跑起来了就不许还写"已暂停"——这正是用户报的那句假话');
  assert.equal(view.state, 'running', '当刻有个 turn 开着：状态说的是"正在值守"');
  assert.equal(view.stateText, 'Agent 正在值守', '状态词说的是当刻在干什么');
  assert.match(view.stateNote, /预算暂停已解除/u, '那句话必须有下文，不能凭空消失');
  assert.match(view.stateNote, /turn/u, '说清是哪一层被解除了');
});

test('状态文本：还在暂停时 stateText 照旧说暂停（别把真暂停也擦掉）', () => {
  const p = emptyProjection();
  applyEvent(p, event('budget/exhausted', { layer: 'task', limit: 100, actual: 120 }));
  const view = buildDashboard({ projection: p, events: [], now: T0, personaRoot: emptyDir() });
  assert.equal(view.state, 'paused');
  assert.equal(view.stateText, '预算暂停（task 层）');
  assert.equal(view.stateNote, '', '当刻就是暂停着：没有"已解除"可说');
});

test('状态文本：一层真停着、另一层是陈旧记录 ⇒ 仍说暂停（旧的那层只进 note）', () => {
  const p = emptyProjection();
  applyEvent(p, event('budget/exhausted', { layer: 'turn', limit: 30, actual: 30 }));
  applyEvent(p, event('budget/exhausted', { layer: 'task', limit: 100, actual: 120 }));
  applyEvent(p, event('turn/start', { turn: 9 }));
  applyEvent(p, event('step/start', { turn: 9, step: 1 }));
  const view = buildDashboard({ projection: p, events: [], now: T0, personaRoot: emptyDir() });
  assert.equal(view.state, 'paused');
  assert.equal(view.stateText, '预算暂停（task 层）', '只报当刻真停着的那一层');
});

/** 一个存在的空目录（buildDashboard 只把它交给 buildPersonaFiles 列清单） */
function emptyDir(): string {
  const dir = tempDirSync('irmia-state-');
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('现场对账：把真实日志那一批事件折一遍，左上角不许再说"已暂停"', (t: TestContext) => {
  t.diagnostic('（这一条读的是本仓 data/events 的实测日志，见 _research/alarm-pairing-state.txt）');
  const events: AppEvent[] = [
    event('budget/exhausted', { layer: 'task', limit: 57000000, actual: 178734979 }, T0.getTime() - 3_600_000),
    event('budget/resumed', { layer: 'task', limit: 252000000, actual: 152266905 }, T0.getTime() - 3_500_000),
    event('budget/exhausted', { layer: 'daily', limit: 22000000, actual: 29951973 }, T0.getTime() - 3_400_000),
    event('budget/resumed', { layer: 'daily', limit: 60000000, actual: 29951973 }, T0.getTime() - 3_300_000),
    event('budget/exhausted', { layer: 'turn', limit: 30, actual: 30 }, T0.getTime() - 3_200_000),
    event('turn/start', { turn: 300 }, T0.getTime() - 60_000),
    event('step/start', { turn: 300, step: 1 }, T0.getTime() - 59_000),
  ];
  const p = fold(events);
  assert.deepEqual(
    Object.keys(p.lastExhausted), ['turn'],
    '重放之后投影里只剩 turn 那一条陈旧记录（与实测的 projection.json 同形）',
  );
  assert.deepEqual(livePausedLayers(p), []);
  const view = buildDashboard({
    projection: p, events, now: T0, personaRoot: emptyDir(),
  });
  assert.notEqual(view.state, 'paused', '一日之内报过、也解过两轮，当刻不该还说暂停');
});

test('状态判据的层序是稳定的（同一批层每次都同一串，界面才能照抄）', () => {
  const p = emptyProjection();
  const layers: BudgetLayer[] = ['task', 'daily', 'turn'];
  for (const layer of layers) {
    applyEvent(p, event('budget/exhausted', { layer, limit: 10, actual: 20 }));
  }
  // turn 层要"当刻真停着"得让计数器也到线：turn 走 10 步（记录里那个 limit）
  applyEvent(p, event('turn/start', { turn: 1 }));
  applyEvent(p, event('step/start', { turn: 1, step: 10 }));
  assert.deepEqual(livePausedLayers(p), ['daily', 'task', 'turn']);
  assert.deepEqual(livePausedLayers(p), ['daily', 'task', 'turn'], '同一个投影判两次必须同一串');
});
