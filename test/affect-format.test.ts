import assert from 'node:assert/strict';
import test from 'node:test';

import { initialAffect } from '../src/affect/engine.ts';
import { MAX_AFFECT_LINE_CHARS, renderAffectNow } from '../src/affect/render.ts';
import type { AffectState } from '../src/affect/types.ts';

function stateWith(values: Partial<AffectState['emotions']>, cause = false): AffectState {
  const base = initialAffect(1000);
  return {
    ...base,
    emotions: {...base.emotions, ...values},
    ...(cause ? {
      causes: [{
        sourceSeq: 1, evaluatedAtMs: 1000,
        dominantEmotion: 'joy' as const, strength: 0.8, reasonCode: 'friendly_contact' as const,
      }],
    } : {}),
  };
}

test('affect line: short behavior, mixed secondary, no cause and 90-char budget', () => {
  const neutral = renderAffectNow(initialAffect(0));
  assert.equal(neutral, '情绪：平稳。', 'no >=0.15 is byte-identical');

  const single = renderAffectNow(stateWith({joy: 0.5}));
  assert.equal(single, '情绪：明显愉快 → 话变多，主动分享。');
  assert.equal(single.includes('微带'), false);
  assert.equal(single.includes('（'), false, '原因括号不再进此刻层');

  const mixed = renderAffectNow(stateWith({joy: 0.8, warmth: 0.5}, true));
  assert.equal(mixed, '情绪：强烈愉快·微带亲近 → 表达热烈，连发两条。');
  assert.ok([...mixed].length <= MAX_AFFECT_LINE_CHARS);
  assert.equal(MAX_AFFECT_LINE_CHARS, 90);
});

test('affect line: every emotion has a concrete three-band short behavior', () => {
  const cases = {
    joy: '愉快', distress: '低落', concern: '关切', irritation: '不悦', warmth: '亲近', shyness: '害羞',
  } as const;
  for (const [emotion, label] of Object.entries(cases)) {
    for (const value of [0.2, 0.5, 0.8]) {
      const line = renderAffectNow(stateWith({[emotion]: value}));
      assert.match(line, new RegExp(`^情绪：(轻微|明显|强烈)${label}(?:·微带[^ ]+)? → `, 'u'));
      assert.ok([...line].length <= MAX_AFFECT_LINE_CHARS);
    }
  }
});
