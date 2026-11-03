import assert from 'node:assert/strict';
import test from 'node:test';

import { applyAppraised, computeImpulse, initialAffect, makeAppraisedData } from '../src/affect/engine.ts';
import { AFFECT_STATE_VERSION, EMOTIONS } from '../src/affect/types.ts';
import type { AffectAppraisal } from '../src/affect/types.ts';

const appraisal = (patch: Partial<AffectAppraisal> = {}): AffectAppraisal => ({
  r: 1, s: 0.4, u: 0.3, g: 0.5, b: 0.4, n: 0.3, z: 0.3, c: 0.2, q: 1, ...patch,
});

test('six dimensions: curiosity removed, shyness added, state version 3', () => {
  assert.deepEqual([...EMOTIONS], ['joy', 'distress', 'concern', 'irritation', 'warmth', 'shyness']);
  assert.equal(AFFECT_STATE_VERSION, 3);
  assert.equal('curiosity' in initialAffect().emotions, false);
  assert.equal(initialAffect().emotions.shyness, 0);
});

test('shyness formula follows the approved weights', () => {
  const a = appraisal();
  const L = a.r * a.q;
  const expected = Math.max(0, Math.min(1, 0.7 * L
    * (0.55 * Math.max(a.g, 0) + 0.45 * Math.max(a.u, 0))
    * (1 - 0.5 * a.c)));
  assert.ok(Math.abs(computeImpulse(a, 1).shyness - expected) < 1e-12);
});

test('old affect/appraised with curiosity and no shyness folds without failing', () => {
  const event = makeAppraisedData({
    sourceSeq: 7, evaluatedAtMs: 1000, sourceWeight: 1,
    appraisal: appraisal({g: 0.2, u: 0.1}), reasonCode: 'general',
  });
  const legacy = {
    ...event,
    impulse: {joy: 0, distress: 0, concern: 0, irritation: 0, warmth: 0.2, curiosity: 0.9},
  } as unknown as typeof event;
  const state = applyAppraised(initialAffect(0), legacy);
  assert.equal(state.emotions.shyness, 0);
  assert.equal('curiosity' in state.emotions, false);
  assert.equal(state.causes[0]?.dominantEmotion, 'warmth');
});
