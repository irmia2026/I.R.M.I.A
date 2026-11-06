import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { AfterCommitEventBus } from '../src/adapter/event-bus.ts';
import { AdapterSupervisor } from '../src/adapter/supervisor.ts';

const pluginRoot = resolve('plugins/builtin/linre-affect');
const worker = resolve(pluginRoot, 'adapter-worker.mjs');
const skip = !existsSync(worker);

const APPROVAL = { r: 0.9, s: 0.6, u: 0.4, g: 0.7, b: 0.5, n: 0.4, z: 0.3, c: 0.6, q: 0.9 };

function event(seq: number, text: string) {
  return {
    seq,
    ts: new Date().toISOString(),
    type: 'wake/message',
    data: { text },
    visibility: 'model' as const,
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function startSupervisor(capabilities: readonly string[], onModelRequest: (spec: unknown, params: unknown) => Promise<unknown>) {
  const bus = new AfterCommitEventBus({ handlerTimeoutMs: 2_000 });
  const failures: unknown[] = [];
  const supervisor = new AdapterSupervisor({
    eventBus: bus,
    handshakeTimeoutMs: 5_000,
    requestTimeoutMs: 8_000,
    onModelRequest,
    onFailure: (_id, error) => failures.push(error),
  });
  return { bus, supervisor, failures };
}

test('情绪插件：评价一条事件后渲染出情绪行', { skip }, async () => {
  const calls: unknown[] = [];
  const { bus, supervisor, failures } = startSupervisor(
    ['event.observe', 'event.publish', 'model.invoke'],
    async (spec, params) => {
      calls.push({ spec, params });
      return { text: JSON.stringify(APPROVAL), model: 'fake-light' };
    },
  );
  try {
    await supervisor.start([{
      id: 'linre-affect',
      version: '0.1.0',
      contentHash: 'b'.repeat(64),
      worker,
      capabilities: ['event.observe', 'event.publish', 'model.invoke'],
      cwd: pluginRoot,
    }]);
    assert.equal(supervisor.statuses()[0]?.state, 'ready', 'worker 应握手成功');
    assert.deepEqual(failures, []);

    bus.publishAfterCommit(event(7, '今天她夸我做得很好，我特别开心。'));
    await sleep(120);

    const rendered = await supervisor.request('linre-affect', 'prompt/render', { slot: 'now-layer', maxChars: 90 });
    const text = (rendered as { text?: unknown }).text;
    assert.equal(typeof text, 'string');
    assert.match(text as string, /^情绪：/, `应渲染情绪行，实际：${String(text)}`);
    assert.match(text as string, /愉快|亲近/, `正面事件应出现正面情绪，实际：${String(text)}`);
    assert.ok([...(text as string)].length <= 90, '不得超过声明的 maxChars');
    assert.equal(calls.length, 1, '恰好一次模型调用');
    const payload = calls[0] as { params: { lane?: unknown; text?: { name?: unknown } } };
    assert.equal(payload.params.lane, 'light', '评价器必须走 light 档');
    assert.equal(payload.params.text?.name, 'affect_appraisal');
  } finally {
    await supervisor.stop();
  }
});

test('情绪插件：没有候选事件时返回平稳且不调模型', { skip }, async () => {
  let calls = 0;
  const { supervisor } = startSupervisor(
    ['event.observe', 'event.publish', 'model.invoke'],
    async () => {
      calls += 1;
      return { text: JSON.stringify(APPROVAL) };
    },
  );
  try {
    await supervisor.start([{
      id: 'linre-affect',
      version: '0.1.0',
      contentHash: 'b'.repeat(64),
      worker,
      capabilities: ['event.observe', 'event.publish', 'model.invoke'],
      cwd: pluginRoot,
    }]);
    const rendered = await supervisor.request('linre-affect', 'prompt/render', { slot: 'now-layer', maxChars: 90 });
    assert.equal((rendered as { text: string }).text, '情绪：平稳。');
    assert.equal(calls, 0);
  } finally {
    await supervisor.stop();
  }
});

test('情绪插件：未声明 model.invoke 时模型调用被拒', { skip }, async () => {
  let calls = 0;
  const { bus, supervisor, failures } = startSupervisor(
    ['event.observe'],
    async () => {
      calls += 1;
      return { text: JSON.stringify(APPROVAL) };
    },
  );
  try {
    await supervisor.start([{
      id: 'linre-affect',
      version: '0.1.0',
      contentHash: 'b'.repeat(64),
      worker,
      capabilities: ['event.observe'],
      cwd: pluginRoot,
    }]);
    bus.publishAfterCommit(event(9, '有人夸我。'));
    await sleep(120);
    const rendered = await supervisor.request('linre-affect', 'prompt/render', { slot: 'now-layer', maxChars: 90 });
    // 评价被拒 ⇒ fail-open：照样返回一行（平稳），但宿主一次模型调用都不该收到
    assert.equal(calls, 0, '未授权时宿主不得被调用');
    assert.equal((rendered as { text: string }).text, '情绪：平稳。');
    assert.deepEqual(failures, []);
  } finally {
    await supervisor.stop();
  }
});

test('情绪插件：只读视图给出与上游同形的状态', { skip }, async () => {
  const { bus, supervisor } = startSupervisor(
    ['event.observe', 'event.publish', 'model.invoke', 'ui.api'],
    async () => ({ text: JSON.stringify(APPROVAL), model: 'fake-light' }),
  );
  type View = {
    neutral: boolean;
    renderLine: string;
    emotions: Record<string, number>;
    mood: { valence: number; arousal: number };
    history: Array<{ atMs: number; valence: number; dominant: string; strength: number }>;
    causes: unknown[];
    updatedAt: string | null;
  };
  try {
    await supervisor.start([{
      id: 'linre-affect',
      version: '0.1.0',
      contentHash: 'b'.repeat(64),
      worker,
      capabilities: ['event.observe', 'event.publish', 'model.invoke', 'ui.api'],
      cwd: pluginRoot,
    }]);
    const before = await supervisor.request('linre-affect', 'ui/handle', { path: '/state' }) as View;
    assert.equal(before.neutral, true);
    assert.equal(before.renderLine, '情绪：平稳。');
    assert.deepEqual(Object.keys(before.emotions).sort(), ['concern', 'distress', 'irritation', 'joy', 'shyness', 'warmth']);
    assert.deepEqual(before.history, []);
    assert.equal(before.updatedAt, null);

    bus.publishAfterCommit(event(11, '她夸我做得很好，我特别开心。'));
    await sleep(120);
    await supervisor.request('linre-affect', 'prompt/render', { slot: 'now-layer', maxChars: 90 });

    const after = await supervisor.request('linre-affect', 'ui/handle', { path: '/state' }) as View;
    assert.equal(after.neutral, false);
    assert.equal(after.history.length, 1);
    assert.equal(typeof after.history[0]?.atMs, 'number');
    assert.ok(after.history[0]!.strength > 0.15);
    assert.match(after.renderLine, /^情绪：/);
    assert.equal(typeof after.updatedAt, 'string');

    await assert.rejects(supervisor.request('linre-affect', 'ui/handle', { path: '/nope' }));
  } finally {
    await supervisor.stop();
  }
});
