import test from 'node:test';
import assert from 'node:assert/strict';
import { affectAt, applyAppraised, computeImpulse, hasAppraised, initialAffect, makeAppraisedData } from '../src/affect/engine.ts';
import { affectReceipt, foldAffectEvents, prepareAffectStep } from '../src/affect/adapter.ts';
import { renderAffectNow } from '../src/affect/render.ts';
import { evaluatedHas } from '../src/affect/index.ts';
import type { AffectAppraisal } from '../src/affect/types.ts';

const setback: AffectAppraisal = { r:1, s:-0.1, u:-0.9, g:0, b:0, n:0.3, z:0.6, c:0.35, q:0.95 };
function event(sourceSeq = 100, evaluatedAtMs = 1_800_000) {
  return makeAppraisedData({ sourceSeq, evaluatedAtMs, sourceWeight:1, appraisal:setback, reasonCode:'owner_setback' });
}

test('a user setback principally creates concern, not self-distress', () => {
  const i = computeImpulse(setback,1);
  assert.ok(i.concern > 0.6);
  assert.ok(i.distress < 0.1);
  assert.equal(i.irritation, 0);
});

test('deduplicates identical sourceSeq, even after replay/requeue', () => {
  const once = applyAppraised(initialAffect(0),event());
  assert.equal(applyAppraised(once,event()),once);
  assert.deepEqual(foldAffectEvents([event(),event()]),once);
  assert.equal(hasAppraised(once,100),true);
});

test('supports out-of-order but unique source IDs; index remains sorted', () => {
  const state = foldAffectEvents([event(102),event(100),event(101)]);
  assert.equal(evaluatedHas(state.evaluated,100),true);
  assert.equal(evaluatedHas(state.evaluated,101),true);
  assert.equal(evaluatedHas(state.evaluated,102),true);
});

test('reading later changes only the derived view and leaves durable state unchanged', () => {
  const state = applyAppraised(initialAffect(),event());
  const frozen = JSON.stringify(state);
  const later = affectAt(state,state.atMs + 90*60_000);
  assert.ok(later.emotions.concern < state.emotions.concern);
  assert.equal(JSON.stringify(state),frozen);
});

test('one half-life halves concern; 24 hours approaches neutral mood', () => {
  const state = applyAppraised(initialAffect(),event());
  const after = affectAt(state,state.atMs+90*60_000);
  assert.ok(Math.abs(after.emotions.concern-state.emotions.concern/2)<1e-12);
  const day = affectAt(state,state.atMs+24*60*60_000);
  assert.ok(Math.abs(day.mood.valence-0.2)<0.02);
});

test('input validation rejects NaN, infinity, out of range, and bogus timestamp', () => {
  assert.throws(()=>computeImpulse({...setback,q:NaN},1),RangeError);
  assert.throws(()=>computeImpulse({...setback,z:Infinity},1),RangeError);
  assert.throws(()=>computeImpulse(setback,1.1),RangeError);
  assert.throws(()=>makeAppraisedData({sourceSeq:-2,evaluatedAtMs:0,sourceWeight:1,appraisal:setback,reasonCode:'general'}),RangeError);
});

test('model string uses fixed vocabulary, no raw private messages, bounded length', () => {
  const state = applyAppraised(initialAffect(),event());
  const line = renderAffectNow(state);
  assert.match(line,/^情绪：/u);
  assert.match(line,/关切/u);
  assert.ok([...line].length <= 100);
  assert.doesNotMatch(line,/面试失败|80211/u);
});

test('step receipt remains identical when replayed using its original timestamp', () => {
  const state = applyAppraised(initialAffect(),event());
  const ts='2026-10-29T21:21:00+08:00';
  const a=affectReceipt(prepareAffectStep(state,ts));
  const b=affectReceipt(prepareAffectStep(foldAffectEvents([event()]),ts));
  assert.deepEqual(a,b);
});

test('event pulse changes mood once, not on every repeated projection', () => {
  const first = applyAppraised(initialAffect(),event());
  const projected = affectAt(first,first.atMs+60_000);
  assert.equal(projected.mood.valence,affectAt(first,first.atMs+60_000).mood.valence);
  assert.ok(projected.mood.valence > first.mood.valence);
});

test('clock rollback does not reverse time', () => {
  const state = applyAppraised(initialAffect(),event());
  assert.deepEqual(affectAt(state,state.atMs-5000),state);
});
