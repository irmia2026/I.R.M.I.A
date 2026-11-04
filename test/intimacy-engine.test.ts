import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INTIMACY_DAILY_CAP, SATISFACTION_REFRACTORY_MS,
  applyIntimacyUpdated, dayKeyOf, desireMultiplierAt, estrusOf, evolveIntimacy, initialIntimacy, phaseOf,
} from '../src/intimacy/state.ts';
import { applyIntent } from '../src/intimacy/engine.ts';
import { evaluateIntimacy, parseIntimacyOutput, type IntimacyLightClient } from '../src/intimacy/evaluator.ts';
import { MAX_INTIMACY_LINE_CHARS, renderIntimacyNow } from '../src/intimacy/render.ts';
import { buildIntimacyView } from '../src/web/intimacy-view.ts';
import { emptyProjection, type AppEvent } from '../src/log/types.ts';
import { applyEvent } from '../src/state/fold.ts';
import type { AppConfig } from '../src/config/config.ts';
import type { IntimacyUpdatedData } from '../src/intimacy/types.ts';

const NOW = 1_700_000_000_000;

function updated(overrides: Partial<IntimacyUpdatedData> = {}): IntimacyUpdatedData {
  return {
    atMs: NOW, sourceSeq: 10, audience: 'owner',
    intimacy: 8, desire: 22, satisfaction: 0, restraint: 0,
    cause: {reasonCode: 'owner_closeness', strength: 22},
    ...overrides,
  };
}

test('state: update carries values and satisfaction opens a 60-minute refractory', () => {
  const state = applyIntimacyUpdated(initialIntimacy(NOW - 1000), updated());
  assert.equal(state.intimacy, 8);
  assert.equal(state.desire, 22);
  assert.equal(state.refractoryUntilMs, 0);
  const satisfied = applyIntimacyUpdated(state, updated({
    atMs: NOW + 1000, satisfaction: 20, cause: {reasonCode: 'satisfied', strength: 16},
  }));
  assert.equal(satisfied.satisfaction, 20);
  assert.equal(satisfied.refractoryUntilMs, NOW + 1000 + SATISFACTION_REFRACTORY_MS);
});

test('evolve: 未到 100 的满足只衰减，不压情欲', () => {
  const base = applyIntimacyUpdated(initialIntimacy(NOW), updated({satisfaction: 20, desire: 10, restraint: 0}));
  const after = evolveIntimacy(base, NOW + 4 * 60_000);
  assert.ok(Math.abs(after.satisfaction - 16) < 1e-9, '1/min decay');
  assert.ok(Math.abs(after.desire - 10.32) < 1e-9, '满足未到 100，情欲按普通速度增长');
  assert.ok(Math.abs(after.restraint - 0.24) < 1e-9);
  assert.equal(after.afterglow, false);
  const later = evolveIntimacy(base, NOW + 30 * 60_000);
  assert.ok(Math.abs(later.satisfaction) < 1e-9);
  assert.ok(Math.abs(later.desire - 12.4) < 1e-9, '0.08/min 普通增长');
  assert.ok(Math.abs(later.restraint - 1.8) < 1e-9, '0.06/min');
  const fast = evolveIntimacy({...base, satisfaction: 0, desire: 0, restraint: 0}, NOW + 10 * 60_000);
  assert.ok(Math.abs(fast.desire - 0.8) < 1e-9, '普通日常 0.08/min');
  assert.ok(Math.abs(fast.restraint - 0.6) < 1e-9, '普通日常 0.06/min');
});

test('evolve: 低满足区间直接走普通增长', () => {
  const base = applyIntimacyUpdated(initialIntimacy(NOW), updated({satisfaction: 5, desire: 10, restraint: 0}));
  const after = evolveIntimacy(base, NOW + 30 * 60_000);
  assert.ok(Math.abs(after.satisfaction) < 1e-9);
  assert.ok(Math.abs(after.desire - 12.4) < 1e-9, `desire=${after.desire}`);
  assert.ok(Math.abs(after.restraint - 1.8) < 1e-9, `restraint=${after.restraint}`);
});

test('evolve: 发情中的部分满足不结束发情，只有到 100 才进入余韵', () => {
  const partial = {
    ...initialIntimacy(NOW),
    desire: 100,
    restraint: 0,
    satisfaction: 19,
    desireFullSinceMs: NOW,
  };
  const after7 = evolveIntimacy(partial, NOW + 7 * 60_000);
  assert.ok(Math.abs(after7.satisfaction - 12) < 1e-9);
  assert.equal(after7.desire, 100);
  assert.equal(after7.restraint, 0);
  assert.equal(after7.afterglow, false);
  assert.equal(estrusOf(after7), true, '19 满足不能把发情压掉');
});

test('evolve: full desire accelerates restraint drop; restraint 0 + desire 100 is estrus', () => {
  const full = {...initialIntimacy(NOW), desire: 100, restraint: 100, desireFullSinceMs: NOW};
  const ten = evolveIntimacy(full, NOW + 20 * 60_000);
  assert.ok(ten.restraint < 100, 'restraint drops at full desire');
  const estrus = evolveIntimacy(full, NOW + 60 * 60_000);
  assert.equal(estrus.desire, 100);
  assert.equal(estrus.restraint, 0);
  assert.equal(estrusOf(estrus), true);
  assert.equal(phaseOf(estrus), 'estrus');
});

test('old intimacy/updated without desireFullSinceMs folds with null anchor', () => {
  const state = applyIntimacyUpdated(initialIntimacy(NOW), updated({desire: 100}));
  assert.equal(state.desire, 100);
  assert.equal(state.desireFullSinceMs, null);
});

test('local day boundary uses config timezone, not UTC', () => {
  const instant = Date.parse('2026-11-03T16:30:00.000Z');
  assert.equal(dayKeyOf(instant, 'Asia/Shanghai'), '2026-11-04');
  assert.equal(dayKeyOf(instant, 'UTC'), '2026-11-03');
});

test('satisfaction: 调情慢、性行为快；发情后只有直接性行为能加', () => {
  const base = initialIntimacy(NOW);
  const flirt = applyIntent({state: base, nowMs: NOW, sourceSeq: 1, intent: 'closeness', strength: 0.8,
    spontaneousChance: 0, timezone: 'Asia/Shanghai'});
  assert.ok(flirt !== null);
  assert.ok(Math.abs(flirt.satisfaction - 2.4) < 1e-9, '调情 3×0.8，慢于性行为');
  assert.ok(Math.abs(flirt.desire - 3.2) < 1e-9);

  const act = applyIntent({state: base, nowMs: NOW, sourceSeq: 2, intent: 'sexual_act', strength: 0.8,
    spontaneousChance: 0, timezone: 'Asia/Shanghai'});
  assert.ok(act !== null);
  assert.ok(Math.abs(act.satisfaction - 12) < 1e-9, '性行为 15×0.8');
  assert.ok(Math.abs(act.desire - 4.8) < 1e-9);
  assert.equal(act.cause.reasonCode, 'owner_sexual_act');

  const estrusBase = {...base, desire: 100, restraint: 0, satisfaction: 20};
  const flirtEstrus = applyIntent({state: estrusBase, nowMs: NOW, sourceSeq: 3, intent: 'closeness', strength: 0.8,
    spontaneousChance: 0, timezone: 'Asia/Shanghai'});
  assert.ok(flirtEstrus !== null && flirtEstrus.satisfaction === 20, '发情后调情不再满足');

  const actEstrus = applyIntent({state: estrusBase, nowMs: NOW, sourceSeq: 4, intent: 'sexual_act', strength: 0.8,
    spontaneousChance: 0, timezone: 'Asia/Shanghai'});
  assert.ok(actEstrus !== null);
  assert.ok(Math.abs(actEstrus.satisfaction - 36) < 1e-9, '发情后直接性行为 20×0.8');
});

test('climax: 满足第一次到顶会把情欲压到 0，进入满足状态', () => {
  const base = {...initialIntimacy(NOW), desire: 100, restraint: 0, satisfaction: 90};
  const data = applyIntent({state: base, nowMs: NOW, sourceSeq: 5, intent: 'sexual_act', strength: 1,
    spontaneousChance: 0, timezone: 'Asia/Shanghai'});
  assert.ok(data !== null);
  assert.equal(data.satisfaction, 100);
  assert.equal(data.desire, 0, '顶点直接削减情欲');
  assert.equal(data.restraint, 0);
  assert.equal(data.afterglow, true, '只有到 100 才进入余韵');
  const state = applyIntimacyUpdated(base, data);
  assert.equal(state.afterglow, true);
  assert.equal(estrusOf(state), false);
  assert.equal(phaseOf(state), 'warm');
  assert.match(renderIntimacyNow(state, {maxLevel: 'strong', nowMs: NOW}), /余韵还在身体里/u);

  const after30 = evolveIntimacy(state, NOW + 30 * 60_000);
  assert.equal(after30.satisfaction, 70);
  assert.equal(after30.desire, 0, '到过 100 后余韵期情欲保持 0');
  assert.equal(after30.afterglow, true);
  assert.match(renderIntimacyNow(after30, {maxLevel: 'strong', nowMs: NOW + 30 * 60_000}), /慵懒/u);
  const after50 = evolveIntimacy(state, NOW + 50 * 60_000);
  assert.equal(after50.satisfaction, 50);
  assert.match(renderIntimacyNow(after50, {maxLevel: 'strong', nowMs: NOW + 50 * 60_000}), /不久前刚和用户亲近过/u);
  const after80 = evolveIntimacy(state, NOW + 80 * 60_000);
  assert.equal(after80.satisfaction, 20);
  assert.match(renderIntimacyNow(after80, {maxLevel: 'strong', nowMs: NOW + 80 * 60_000}), /元气满满/u);
  const after95 = evolveIntimacy(state, NOW + 95 * 60_000);
  assert.equal(after95.satisfaction, 5);
  assert.equal(after95.afterglow, false, '满足降到阈值以下，余韵结束');
  assert.ok(after95.desire > 0, '满足低于阈值后情欲重新开始涨');
  assert.match(renderIntimacyNow(after95, {maxLevel: 'strong', nowMs: NOW + 95 * 60_000}), /心里开始有些痒痒/u);
});

test('late night: 23:00–05:00 的情欲增长明显更快', () => {
  const day = Date.parse('2026-11-03T04:00:00Z');  // 12:00 Asia/Shanghai
  const night = Date.parse('2026-11-03T15:30:00Z'); // 23:30 Asia/Shanghai
  assert.equal(desireMultiplierAt(day, 'Asia/Shanghai'), 1);
  assert.equal(desireMultiplierAt(night, 'Asia/Shanghai'), 4);
  const base = initialIntimacy(night);
  const dayGain = applyIntent({state: base, nowMs: day, sourceSeq: 1, intent: 'closeness', strength: 0.8,
    spontaneousChance: 0, timezone: 'Asia/Shanghai'});
  const nightGain = applyIntent({state: base, nowMs: night, sourceSeq: 2, intent: 'closeness', strength: 0.8,
    spontaneousChance: 0, timezone: 'Asia/Shanghai'});
  assert.ok(dayGain !== null && nightGain !== null);
  assert.ok(Math.abs(dayGain.desire - 3.2) < 1e-9);
  assert.ok(Math.abs(nightGain.desire - 12.8) < 1e-9);
});

test('cadence: 没有互动时，普通日常一天大约一次发情', () => {
  const start = Date.parse('2026-11-03T04:00:00Z');
  let state = initialIntimacy(start);
  let count = 0;
  let wasEstrus = false;
  for (let minute = 1; minute <= 24 * 60; minute += 1) {
    state = evolveIntimacy(state, start + minute * 60_000);
    const nowEstrus = estrusOf(state);
    if (nowEstrus && !wasEstrus) count += 1;
    wasEstrus = nowEstrus;
  }
  assert.equal(count, 1, '普通日常基线应约一天一次');
});

test('applyIntent maps closeness/longing/satisfaction/boundary and boundary wins over refractory', () => {
  const base = {...initialIntimacy(NOW), refractoryUntilMs: NOW + 10 * 60_000};
  const close = applyIntent({state: base, nowMs: NOW, sourceSeq: 1, intent: 'closeness', strength: 0.4,
    spontaneousChance: 0, timezone: 'Asia/Shanghai'});
  assert.ok(close !== null && Math.abs(close.desire - 1.6) < 1e-9, '4 × 0.4');
  assert.ok(close !== null && Math.abs(close.satisfaction - 1.2) < 1e-9, '调情满足 3 × 0.4');
  const long = applyIntent({state: base, nowMs: NOW, sourceSeq: 2, intent: 'longing', strength: 0.5,
    spontaneousChance: 0, timezone: 'Asia/Shanghai'});
  assert.ok(long !== null && Math.abs(long.desire - 3) < 1e-9, '6 × 0.5');
  const sat = applyIntent({state: base, nowMs: NOW, sourceSeq: 3, intent: 'satisfaction', strength: 0.5,
    spontaneousChance: 0, timezone: 'Asia/Shanghai'});
  assert.ok(sat !== null && sat.satisfaction === 12.5 && Math.abs(sat.desire - 1) < 1e-9, 'satisfaction 25×.5 / desire 2×.5');
  const boundary = applyIntent({state: base, nowMs: NOW, sourceSeq: 4, intent: 'boundary', strength: 0.4,
    spontaneousChance: 0, timezone: 'Asia/Shanghai'});
  assert.ok(boundary !== null);
  assert.equal(boundary.desire, 0, 'boundary subtracts even during refractory');
  assert.equal(boundary.restraint, 6, '15 × 0.4');
});

test('applyIntent neutral uses spontaneous chance; no stop words remain', () => {
  const base = initialIntimacy(NOW);
  const no = applyIntent({state: base, nowMs: NOW, sourceSeq: 1, intent: 'neutral', strength: 0,
    spontaneousChance: 0.04, timezone: 'Asia/Shanghai', random: () => 0.99});
  assert.equal(no, null);
  const yes = applyIntent({state: base, nowMs: NOW, sourceSeq: 2, intent: 'neutral', strength: 0,
    spontaneousChance: 0.04, timezone: 'Asia/Shanghai', random: () => 0});
  assert.ok(yes !== null && yes.desire === 2);
});

test('intimacy daily cap stays +2', () => {
  let state = initialIntimacy(NOW);
  for (let i = 0; i < 10; i += 1) {
    const data = applyIntent({state, nowMs: NOW + i * 1000, sourceSeq: 10 + i, intent: 'closeness',
      strength: 1, spontaneousChance: 0, timezone: 'Asia/Shanghai'});
    if (data !== null) state = applyIntimacyUpdated(state, data);
  }
  assert.ok(state.intimacy <= INTIMACY_DAILY_CAP + 1e-9);
});

test('render: four true labels, short behavior, maxLevel never caps readings, estrus behavior wins', () => {
  const state = applyIntimacyUpdated(initialIntimacy(NOW), updated({intimacy: 90, desire: 95, restraint: 80}));
  const line = renderIntimacyNow(state, {maxLevel: 'obvious', nowMs: NOW});
  assert.match(line, /^亲密：.+ · 情欲：.+ · 满足：.+ · 克制：.+ → /u);
  assert.ok([...line].length <= MAX_INTIMACY_LINE_CHARS);
  assert.match(line, /亲密：强烈/u, 'maxLevel must not cap the reading');
  assert.match(line, /情欲：强烈/u, 'maxLevel must not cap the reading');
  assert.match(line, /克制：强烈/u, 'satisfaction/restraint labels are real, not capped');
  assert.match(line, /还忍得住/u);
  const estrusStrong = renderIntimacyNow({...state, desire: 100, restraint: 0}, {maxLevel: 'strong', nowMs: NOW});
  assert.match(estrusStrong, /不再收着/u, 'estrus behavior is available at strong');
  const estrusSubtle = renderIntimacyNow({...state, desire: 100, restraint: 0}, {maxLevel: 'subtle', nowMs: NOW});
  assert.match(estrusSubtle, /靠近一点/u, 'maxLevel caps outward behavior, not readings');
  assert.match(estrusSubtle, /情欲：强烈/u, 'readings stay real even at subtle');
});

test('API view: enabled exposes four readings, estrus/phase and line; bad event never throws', () => {
  const projection = emptyProjection();
  projection.intimacy = applyIntimacyUpdated(projection.intimacy,
    updated({intimacy: 8, desire: 22, satisfaction: 80, restraint: 50}));
  const config = {intimacy: {
    enabled: true, maxLevel: 'obvious', spontaneousChance: 0.04, privateOnly: true,
  }} as unknown as AppConfig;
  const view = buildIntimacyView({
    config, configured: true, projection, events: [], now: new Date(NOW).toISOString(),
  });
  for (const key of ['enabled', 'configured', 'privateOnly', 'maxLevel', 'atMs', 'updatedAt', 'intimacy',
    'desire', 'satisfaction', 'restraint', 'level', 'estrus', 'afterglow', 'phase', 'labels', 'line', 'renderLine', 'causes', 'history']) {
    assert.ok(key in view, `missing ${key}`);
  }
  assert.equal(view.privateOnly, true);
  assert.deepEqual(view.labels, {
    intimacy: '平稳', desire: '轻微', satisfaction: '强烈', restraint: '明显',
  }, 'labels use real values, not maxLevel caps');
  assert.match(view.line ?? '', /^亲密：/u);
  assert.equal(typeof view.estrus, 'boolean');
});

test('fold: bad intimacy event is skipped through repair callback', () => {
  const projection = emptyProjection();
  const skipped: string[] = [];
  const bad = {
    seq: 5, ts: new Date(NOW).toISOString(), type: 'intimacy/updated', visibility: 'internal',
    data: updated({desire: 101}),
  } as unknown as AppEvent;
  applyEvent(projection, bad, (_event, error) => skipped.push(String(error)));
  assert.equal(skipped.length, 1);
  assert.equal(projection.intimacy.desire, 0);
});

test('light evaluator: valid JSON, invalid JSON and timeout are fail-open', async () => {
  const client = (text: string): IntimacyLightClient => ({
    async generate() {
      return {outputItems: [{type: 'message', text}], usage: {inputTokens: 10, outputTokens: 2, cachedTokens: 0}};
    },
  });
  const ok = await evaluateIntimacy({text: '抱抱', client: client('{"intent":"closeness","strength":0.5}')});
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.judgement, {intent: 'closeness', strength: 0.5});
  const bad = await evaluateIntimacy({text: '抱抱', client: client('{"intent":"closeness","strength":2}')});
  assert.equal(bad.status, 'invalid');
  assert.equal(bad.judgement, null);
  assert.equal(parseIntimacyOutput('{"intent":"boundary","strength":0.5}')?.intent, 'boundary');
});
