import assert from 'node:assert/strict';
import test from 'node:test';

import {
  candidateFromWake, chooseCandidates, reasonCodeFor, type EvidenceEvent,
} from '../src/affect/triage.ts';
import { AFFECT_APPRAISER_INSTRUCTIONS } from '../src/affect/evaluator.ts';
import { initialAffect } from '../src/affect/engine.ts';
import { renderAffectNow } from '../src/affect/render.ts';

const groupWake: EvidenceEvent = {
  seq: 3, type: 'wake/channel', visibility: 'model',
  data: {chatType: 'group-at', text: '你在吗', person: 'X'},
};
const c2cWake: EvidenceEvent = {seq: 2, type: 'wake/channel', visibility: 'model', data: {chatType: 'c2c', text: '在吗'}};

test('triage: group and group @ are candidates; actor still follows trust', () => {
  const external = candidateFromWake(groupWake, 'external');
  assert.equal(external?.actor, 'external');
  assert.equal(external?.text, '你在吗');
  const owner = candidateFromWake(groupWake, 'owner');
  assert.equal(owner?.actor, 'owner');
  const candidates = chooseCandidates({wakes: [c2cWake, groupWake], trust: 'external', newToolResults: [], history: []});
  assert.equal(candidates.length, 2);
});

test('reasonCodeFor: non-owner unwanted advance wins before generic unfriendliness', () => {
  const candidate = {sourceSeq: 1, kind: 'direct_message' as const, text: 'x', sourceWeight: 0.25, actor: 'external' as const};
  assert.equal(reasonCodeFor({s: -0.2, u: -0.4, g: -0.4, n: 0.2, b: 0.6}, candidate), 'unwelcome_advance');
  assert.notEqual(reasonCodeFor({s: -0.2, u: -0.4, g: -0.4, n: 0.2, b: 0.6}, {...candidate, actor: 'owner'}), 'unwelcome_advance');
});

test('appraiser prompt names the non-owner boundary rule', () => {
  assert.match(AFFECT_APPRAISER_INSTRUCTIONS, /非用户发来的亲密、暧昧、占有、性暗示或越界/u);
  assert.match(AFFECT_APPRAISER_INSTRUCTIONS, /不得给warmth\/joy/u);
});

test('render: an unwelcome advance produces cold, short refusal behavior', () => {
  const state = initialAffect(1000);
  state.emotions.irritation = 0.5;
  state.causes = [{
    sourceSeq: 1, evaluatedAtMs: 1000, dominantEmotion: 'irritation', strength: 0.6,
    reasonCode: 'unwelcome_advance',
  }];
  assert.match(renderAffectNow(state), /→ 冷下来，短句拒绝。$/u);
});
