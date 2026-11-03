import assert from 'node:assert/strict';
import test from 'node:test';

import { makeAppraisedData } from '../src/affect/engine.ts';
import { defaultConfig } from '../src/config/config.ts';
import { emptyProjection, type AppEvent } from '../src/log/types.ts';
import { applyOne } from '../src/state/fold.ts';
import { buildAffectView } from '../src/web/affect-view.ts';

const NOW = '2026-10-31T02:00:00.000Z';
const APPRAISAL = { r: 1, s: 0, u: -0.8, g: 0, b: 0, n: 0.2, z: 0.5, c: 0.1, q: 1 };

function appraisalEvent(): AppEvent {
  return {
    seq: 1,
    ts: NOW,
    type: 'affect/appraised',
    visibility: 'internal',
    data: makeAppraisedData({
      sourceSeq: 42,
      evaluatedAtMs: Date.parse(NOW),
      sourceWeight: 1,
      appraisal: APPRAISAL,
      reasonCode: 'owner_setback',
    }),
  };
}

/** 在 [at] 落一条 `affect/appraised`；`sourceSeq` 与 `seq` 由调用方给，保证全日志唯一。 */
function appraisalAt(
  at: string,
  sourceSeq: number,
  appraisal: typeof APPRAISAL,
  reasonCode: 'owner_setback' | 'owner_success' = 'owner_success',
): AppEvent {
  return {
    seq: sourceSeq,
    ts: at,
    type: 'affect/appraised',
    visibility: 'internal',
    data: makeAppraisedData({
      sourceSeq,
      evaluatedAtMs: Date.parse(at),
      sourceWeight: 1,
      appraisal,
      reasonCode,
    }),
  };
}

test('affect view：未开启时没有请求行，也不伪造评价时间', () => {
  const view = buildAffectView({
    config: defaultConfig('.'), configured: false, projection: emptyProjection(), events: [], now: NOW, env: {},
  });
  assert.equal(view.enabled, false);
  assert.equal(view.configured, false);
  assert.equal(view.atMs, null);
  assert.equal(view.updatedAt, null);
  assert.equal(view.renderLine, null);
  assert.equal(view.neutral, true);
  assert.equal(view.evaluatorEnabled, false, 'evaluatorEnabled 透传自 config.affect.evaluatorEnabled（出厂 false）');
  assert.deepEqual(view.causes, []);
  assert.deepEqual(view.history, []);
});

test('affect view：开启但无评价时显示真实的中性行', () => {
  const config = defaultConfig('.');
  config.affect.enabled = true;
  const view = buildAffectView({ config, configured: true, projection: emptyProjection(), events: [], now: NOW, env: {} });
  assert.equal(view.enabled, true);
  assert.equal(view.renderLine, '情绪：平稳。');
  assert.equal(view.updatedAt, null);
  assert.equal(view.atMs, null);
});

test('affect view：有评价时返回原因码、事件时间和同一个渲染函数的结果', () => {
  const config = defaultConfig('.');
  config.affect.enabled = true;
  const projection = emptyProjection();
  const event = appraisalEvent();
  applyOne(projection, event);
  const view = buildAffectView({ config, configured: false, projection, events: [event], now: NOW, env: {} });
  assert.equal(view.enabled, true);
  assert.equal(view.configured, false);
  assert.equal(view.atMs, Date.parse(NOW));
  assert.equal(view.updatedAt, NOW);
  assert.equal(view.causes.length, 1);
  assert.equal(view.causes[0]?.reasonCode, 'owner_setback');
  assert.equal(view.causes[0]?.dominantEmotion, 'concern');
  assert.ok(view.emotions.concern > 0.15);
  assert.match(view.renderLine ?? '', /^情绪：/u);
  assert.equal(view.neutral, false);

  const overridden = buildAffectView({ config, configured: true, projection, events: [event], now: NOW, env: { IRMIA_AFFECT_ENABLED: '0' } });
  assert.equal(overridden.enabled, false);
  assert.equal(overridden.renderLine, null);
});

test('affect view：history 每条评价一个快照，按时间升序，主导情绪取该刻最大分量', () => {
  const config = defaultConfig('.');
  config.affect.enabled = true;
  const firstAt = '2026-10-31T00:00:00.000Z';
  const positive = { r: 1, s: 0.9, u: 0.3, g: 0.6, b: 0, n: 0.3, z: 0.5, c: 0, q: 1 };
  const first = appraisalAt(firstAt, 1, APPRAISAL, 'owner_setback');
  const second = appraisalAt(NOW, 2, positive, 'owner_success');
  const projection = emptyProjection();
  applyOne(projection, first);
  applyOne(projection, second);

  const view = buildAffectView({ config, configured: true, projection, events: [first, second], now: NOW, env: {} });
  assert.equal(view.history.length, 2);
  assert.equal(view.history[0]?.atMs, Date.parse(firstAt));
  assert.equal(view.history[1]?.atMs, Date.parse(NOW));
  assert.ok((view.history[0]?.atMs ?? 0) < (view.history[1]?.atMs ?? 0));
  assert.equal(view.history[0]?.dominant, 'concern');
  assert.equal(view.history[1]?.dominant, 'joy');
  // 每个点带回自己的原因码与那一刻的主导强度（UI 在 causes 空掉时靠它兜底）
  assert.equal(view.history[0]?.reasonCode, 'owner_setback');
  assert.equal(view.history[1]?.reasonCode, 'owner_success');
  assert.ok(Math.abs((view.history[0]?.strength ?? 0) - 0.544) < 1e-9, '第一个点的主导强度 = 关切的折叠值');
  assert.equal(view.history[1]?.strength, view.emotions.joy);
  // 最后一个点就是"最近一次评价那一刻"的累计状态；now 与它同一时刻，所以与 view.mood 一致
  assert.equal(view.history[1]?.valence, view.mood.valence);
  assert.equal(view.history[1]?.arousal, view.mood.arousal);
  assert.ok(view.history[1]?.valence !== view.history[0]?.valence, '两次评价的倾向应当不同');
});

test('affect view：history 最多 400 点，保留最近的', () => {
  const config = defaultConfig('.');
  config.affect.enabled = true;
  const startMs = Date.parse('2026-10-30T00:00:00.000Z');
  const events: AppEvent[] = [];
  for (let i = 1; i <= 450; i += 1) {
    events.push(appraisalAt(new Date(startMs + i * 60_000).toISOString(), i, APPRAISAL, 'owner_setback'));
  }
  const view = buildAffectView({
    config, configured: true, projection: emptyProjection(), events, now: NOW, env: {},
  });
  assert.equal(view.history.length, 400);
  assert.equal(view.history[0]?.atMs, startMs + 51 * 60_000, '窗口应向后滑：前 50 个点被丢掉');
  assert.equal(view.history.at(-1)?.atMs, startMs + 450 * 60_000);
  const ascending = view.history.every((point, index) => index === 0 || point.atMs >= (view.history[index - 1]?.atMs ?? 0));
  assert.equal(ascending, true, 'history 必须按时间升序');
});
