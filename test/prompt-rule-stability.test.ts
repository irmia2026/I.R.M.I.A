import assert from 'node:assert/strict';
import test from 'node:test';

import { affectRulesForReplay } from '../src/affect/render.ts';
import { intimacyRulesForReplay } from '../src/intimacy/render.ts';
import { render, type RenderInput, type RenderPersona } from '../src/model/render.ts';

const PERSONA: RenderPersona = {
  identity: 'IDENTITY：你是 Irmia。',
  constitution: 'CONSTITUTION：不越权。',
  style: 'STYLE：短句。',
  state: 'STATE：待命中。',
};

function renderOnce(o: Partial<RenderInput> = {}): string {
  return render({
    events: [],
    persona: PERSONA,
    tools: [],
    wakeEvent: null,
    taskCard: null,
    now: '2026-03-01T00:00:00.000Z',
    timezone: 'Asia/Shanghai',
    model: 'deepseek-flash',
    lane: 'heavy',
    softHint: null,
    ...o,
  }).instructions;
}

test('规范搬进 SELF_BRIEF：功能开关与状态行都不再改变 instructions', () => {
  const base = renderOnce();
  assert.match(base, /## 6\. 情绪与欲望/u, '规范已在常驻自述里');
  assert.equal(base.includes('【情绪使用规范】'), false, '条件静态后缀已删除');
  assert.equal(base.includes('【亲密与情欲的使用规范】'), false);

  const enabledWithLine = renderOnce({
    affectRules: true, intimacyRules: true,
    affectLine: '情绪：平稳。', intimacyLine: '亲密：平稳 · 情欲：平静 → 保持平时的距离与语气。',
  });
  assert.equal(enabledWithLine, base, '开关与状态行都不得改变系统前缀');
});

test('回放：新收据读显式 rules；老日志退回“有行就有”', () => {
  assert.equal(affectRulesForReplay({ data: { affectRules: true } }), true);
  assert.equal(affectRulesForReplay({ data: { affectRules: false, affect: { renderedLine: '情绪：平稳。' } } }), false);
  assert.equal(affectRulesForReplay({ data: { affect: { renderedLine: '情绪：平稳。' } } }), true, '老日志');
  assert.equal(affectRulesForReplay({ data: {} }), false);

  assert.equal(intimacyRulesForReplay({ data: { intimacyRules: true } }), true);
  assert.equal(intimacyRulesForReplay({ data: { intimacyRules: false, intimacy: { renderedLine: '亲密：平稳。' } } }), false);
  assert.equal(intimacyRulesForReplay({ data: { intimacy: { renderedLine: '亲密：平稳。' } } }), true, '老日志');
  assert.equal(intimacyRulesForReplay({ data: {} }), false);
});
