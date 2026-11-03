/**
 * RealLoop 级：评价器在候选循环开始前必须看预算暂停。
 *
 * 场景是真实链路（真 RealLoop / agent-loop / fold / log，只有模型是假的）：
 *   第 1 步：唤醒是一句无信息量的「嗯」→ 不该评价；随后 read_channel 工具执行，
 *            它在 handler 里落一条 `budget/exhausted{layer:'task'}`（模拟停在 task 层）。
 *   第 2 步：read_channel 的结果是这次**唯一**可评价的候选；若没有预算闸，会走 light；
 *            有闸则一次 light 都不发，也不写 affect/appraised。
 *
 * 判据刻意不看 `admitWake`：它只拦“下一拍开不开 turn”，本用例要看的是**已经开跑的
 * turn 内、第 2 步之前**那道闸。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { makeRealWakeRig, type RealWakeRig } from './fixtures/real-wake-rig.ts';

const APPRAISAL = { r: 1, s: 0, u: -0.8, g: 0, b: 0, n: 0.2, z: 0.5, c: 0.1, q: 1 };

test('RealLoop：task 层暂停时，候选循环前跳过评价（0 次 light / 0 条 affect）', async (t) => {
  let rig!: RealWakeRig;
  rig = await makeRealWakeRig({
    patchConfig: (config) => {
      config.affect.enabled = true;
      config.affect.evaluatorEnabled = true;
    },
    stream: [
      {
        text: '',
        toolCalls: [{ callId: 'call-read-1', name: 'read_channel', arguments: '{}' }],
      },
      { text: '', toolCalls: [] },
    ],
    // 若闸失效，这一步会被真的调用；给一个合法返回，让失败点落在计数断言而不是脚本耗尽。
    generate: [{
      outputItems: [{ type: 'message', id: 'm-affect-1', text: JSON.stringify(APPRAISAL) }],
      usage: { inputTokens: 12, outputTokens: 8, cachedTokens: 0 },
    }],
    registerTools: [{
      name: 'read_channel',
      sideEffect: 'none',
      handler: async () => {
        // 模拟"这一轮跑到一半，task 层已经暂停"：不碰 actual 用量（admitWake 已过），
        // 只留下 lastExhausted 记录；下一步的 affectBeforeStep 必须看见它。
        rig.append('budget/exhausted', {
          layer: 'task',
          limit: 1,
          actual: 1,
          resumable: true,
        });
        return { content: '今天考试失败了，我好难过。' };
      },
    }],
  });
  t.after(() => rig.dispose());

  rig.append('wake/manual', { note: '嗯' });
  await rig.tick();

  const events = await rig.events();
  const lightCalls = rig.requests.filter(item => item.lane === 'light');
  assert.equal(lightCalls.length, 0, '预算暂停时不该有任何 light 调用');
  assert.equal(
    events.filter(event => event.type === 'affect/appraised').length,
    0,
    '预算暂停时不该写 affect/appraised（也不该假装评价过）',
  );
  assert.equal(
    events.filter(event => event.type === 'budget/consumed' && event.data.affectEvaluation === true).length,
    0,
    '没有 light 调用就不该有 affect 的 budget/consumed 账',
  );
  assert.ok(events.some(event => event.type === 'budget/exhausted'), '前提：暂停事件已落库');
  assert.equal(
    rig.requests.filter(item => item.lane === 'heavy').length,
    2,
    '预算闸只跳过评价，不该中断本 turn 的 heavy 步',
  );
});
