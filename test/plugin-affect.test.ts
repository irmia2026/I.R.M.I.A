import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { AfterCommitEventBus } from '../src/adapter/event-bus.ts';
import { AdapterSupervisor } from '../src/adapter/supervisor.ts';
import { scanPluginPackage } from '../src/plugin/package-store.ts';
import {
  BASELINE,
  DIMENSIONS,
  applyAppraisal,
  emptyState,
  normalizeAppraisal,
  renderLine,
} from '../plugins/builtin/linre-affect/lib/emotion.mjs';
import { TRUST_WEIGHTS, triageEvent } from '../plugins/builtin/linre-affect/lib/triage.mjs';

const pluginRoot = resolve('plugins/builtin/linre-affect');
const worker = resolve(pluginRoot, 'adapter-worker.mjs');
const skip = !existsSync(worker);

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const OWNER_TEASE = {
  joy: 0.25,
  sadness: 0.05,
  anger: 0.45,
  anxiety: 0.1,
  longing: 0.35,
  trust: 0.85,
  pride: 0.1,
  shame: 0.15,
  curiosity: 0.65,
  reasonCode: 'owner_tease',
};

const UNWELCOME_FLIRT = {
  joy: 0.7,
  sadness: 0.0,
  anger: 0.2,
  anxiety: 0.1,
  longing: 0.6,
  trust: 0.8,
  pride: 0.1,
  shame: 0.2,
  curiosity: 0.4,
  reasonCode: 'unwelcome_advance',
};

function startSupervisor(onModelRequest: (spec: unknown, params: unknown) => Promise<unknown>) {
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

test('情绪插件：scanPluginPackage 校验通过且升级至 0.2.0', () => {
  const pkg = scanPluginPackage(pluginRoot);
  assert.equal(pkg.manifest.id, 'linre-affect');
  assert.equal(pkg.manifest.version, '0.2.0');
  assert.equal(pkg.manifest.apiVersion, 2);
});

test('情绪分诊：正确过滤 via、斜杠命令、敷衍短词并识别信任权重', () => {
  const cfg = { ownerIds: ['10001'], trustedIds: ['20002'] };

  assert.equal(triageEvent({ seq: 1, type: 'wake/manual', data: { via: 'timer', text: '提醒时间到了' } }, cfg), null);
  assert.equal(triageEvent({ seq: 2, type: 'wake/manual', data: { source: 'human', text: '/status' } }, cfg), null);
  assert.equal(triageEvent({ seq: 3, type: 'wake/manual', data: { source: 'human', text: '好的！' } }, cfg), null);
  assert.equal(triageEvent({ seq: 4, type: 'wake/manual', data: { source: 'human', text: 'ok' } }, cfg), null);

  const manual = triageEvent({ seq: 5, type: 'wake/manual', data: { source: 'human', text: '今天写代码辛苦了，早点休息' } }, cfg);
  assert.equal(manual?.actorTier, 'owner');
  assert.equal(manual?.weight, TRUST_WEIGHTS.owner);

  assert.equal(triageEvent({ seq: 6, type: 'channel/message', data: { chatType: 'group', mentionsMe: false, senderId: '30003', text: '群里闲聊一句' } }, cfg), null);

  const c2cTrusted = triageEvent({ seq: 7, type: 'channel/message', data: { chatType: 'c2c', senderId: '20002', text: '周末一起打游戏吗' } }, cfg);
  assert.equal(c2cTrusted?.actorTier, 'trusted');
  assert.equal(c2cTrusted?.weight, TRUST_WEIGHTS.trusted);

  const groupAtExternal = triageEvent({ seq: 8, type: 'channel/message', data: { chatType: 'group-at', mentionsMe: true, senderId: '99999', text: '看看这个新东西' } }, cfg);
  assert.equal(groupAtExternal?.actorTier, 'external');
  assert.equal(groupAtExternal?.weight, TRUST_WEIGHTS.external);

  const readChannel = triageEvent({ seq: 9, type: 'tool/result', data: { name: 'read_channel', result: '大家都在聊新番' } }, cfg);
  assert.equal(readChannel?.actorTier, 'external');
});

test('情绪核心：严格 0.05 步进夹紧与非主人 unwelcome_advance 边界保护', () => {
  const clamped = normalizeAppraisal({
    joy: 1.42,
    sadness: -0.2,
    anger: 0.33,
    anxiety: 0.12,
    longing: 0.48,
    trust: 0.67,
    pride: 0.04,
    shame: 0.51,
    curiosity: 0.89,
    reasonCode: 'curious_topic',
  }, 'owner');
  assert.ok(clamped !== null);
  for (const key of DIMENSIONS) {
    const val = clamped.dimensions[key];
    assert.ok(val >= 0 && val <= 1);
    assert.ok(Math.abs(val * 20 - Math.round(val * 20)) < 1e-7);
  }
  assert.equal(clamped.dimensions.joy, 1);
  assert.equal(clamped.dimensions.sadness, 0);
  assert.equal(clamped.dimensions.anger, 0.35);

  const guarded = normalizeAppraisal(UNWELCOME_FLIRT, 'external');
  assert.ok(guarded !== null);
  assert.equal(guarded.dimensions.joy, 0);
  assert.equal(guarded.dimensions.longing, 0);
  assert.equal(guarded.dimensions.trust, 0);
  assert.ok(guarded.dimensions.anger >= 0.6);
  assert.ok(guarded.dimensions.anxiety >= 0.35);

  const next = applyAppraisal(emptyState(1_000), guarded, {
    atMs: 1_000,
    sourceSeq: 1,
    weight: TRUST_WEIGHTS.external,
    actorTier: 'external',
  });
  assert.ok(next.dimensions.joy <= 0.05);
  assert.ok(next.dimensions.trust < BASELINE.trust);
  assert.ok(next.dimensions.anger > 0.3);
});

test('情绪插件：自然定性提示行渲染、持久化重载衰减与 UI 交互动作', { skip }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'affect-data-'));
  const calls: unknown[] = [];
  const { bus, supervisor, failures } = startSupervisor(async (spec, params) => {
    calls.push({ spec, params });
    return { text: JSON.stringify(OWNER_TEASE), model: 'fake-light' };
  });

  try {
    await supervisor.start([{
      id: 'linre-affect',
      version: '0.2.0',
      contentHash: 'b'.repeat(64),
      worker,
      capabilities: ['event.observe', 'event.publish', 'model.invoke', 'prompt.inject', 'ui.api'],
      cwd: pluginRoot,
    }]);
    await supervisor.request('linre-affect', 'adapter/init', {
      config: { dataDir, ownerIds: ['10001'] },
    });

    bus.publishAfterCommit({
      seq: 10,
      ts: new Date().toISOString(),
      type: 'wake/manual',
      data: { source: 'human', senderId: '10001', text: '又熬夜写 bug 被我抓到了吧' },
      visibility: 'model',
    });
    await sleep(100);

    const rendered = await supervisor.request('linre-affect', 'prompt/render', { slot: 'now-layer', maxChars: 160 }) as { text: string; lines: string[] };
    assert.match(rendered.text, /^心绪：/);
    assert.doesNotMatch(rendered.text, /\d+\.\d+/);
    assert.match(rendered.text, /微恼|恼/);
    assert.match(rendered.text, /刚被调侃完/);
    assert.match(rendered.text, /信任高/);
    assert.match(rendered.text, /好奇升起/);
    assert.ok([...rendered.text].length <= 160);
    assert.equal(calls.length, 1);

    const payload = calls[0] as { params: { lane?: unknown; text?: { name?: unknown } } };
    assert.equal(payload.params.lane, 'light');
    assert.equal(payload.params.text?.name, 'affect_appraisal');

    assert.ok(existsSync(join(dataDir, 'state.json')));

    const moodDoc = await supervisor.request('linre-affect', 'ui/handle', { path: '/ui/mood' }) as {
      title: string;
      blocks: Array<{ type: string; items?: Array<{ action?: string }> }>;
    };
    assert.equal(moodDoc.title, '情绪');
    const barsBlock = moodDoc.blocks.find((b) => b.type === 'bars');
    assert.equal(barsBlock?.items?.length, 9);
    assert.ok(moodDoc.blocks.some((b) => b.type === 'hero'));
    assert.ok(moodDoc.blocks.some((b) => b.type === 'metrics'));
    assert.ok(moodDoc.blocks.some((b) => b.type === 'chart'));
    assert.ok(moodDoc.blocks.some((b) => b.type === 'list'));
    const actionsBlock = moodDoc.blocks.find((b) => b.type === 'actions');
    assert.ok(actionsBlock?.items?.some((a) => a.action === 'reset_baseline'));
    assert.ok(actionsBlock?.items?.some((a) => a.action === 'step_decay'));

    const stateDoc = await supervisor.request('linre-affect', 'ui/handle', { path: '/state' }) as {
      dimensions: Record<string, number>;
      blocks: unknown[];
    };
    assert.ok(stateDoc.dimensions.anger > 0.2);
    assert.ok(Array.isArray(stateDoc.blocks));

    const beforeStep = stateDoc.dimensions.anger;
    const stepRes = await supervisor.request('linre-affect', 'ui/invoke', { action: 'step_decay' }) as { ok: boolean };
    assert.equal(stepRes.ok, true);
    const afterStep = await supervisor.request('linre-affect', 'ui/handle', { path: '/state' }) as { dimensions: Record<string, number> };
    assert.ok(afterStep.dimensions.anger < beforeStep);

    const resetRes = await supervisor.request('linre-affect', 'ui/invoke', { action: 'reset_baseline' }) as { ok: boolean };
    assert.equal(resetRes.ok, true);
    const afterReset = await supervisor.request('linre-affect', 'prompt/render', { slot: 'now-layer', maxChars: 160 }) as { text: string };
    assert.equal(afterReset.text, '心绪：平稳安静。');
    assert.deepEqual(failures, []);

    await assert.rejects(supervisor.request('linre-affect', 'ui/handle', { path: '/nope' }));
  } finally {
    await supervisor.stop();
  }

  const saved = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as {
    state: { atMs: number; dimensions: Record<string, number> };
  };
  saved.state.dimensions.joy = 0.95;
  saved.state.atMs = Date.now() - 90 * 60_000;
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify(saved), 'utf8');

  const secondRun = startSupervisor(async () => ({ text: JSON.stringify(OWNER_TEASE) }));
  try {
    await secondRun.supervisor.start([{
      id: 'linre-affect',
      version: '0.2.0',
      contentHash: 'b'.repeat(64),
      worker,
      capabilities: ['event.observe', 'event.publish', 'model.invoke', 'prompt.inject', 'ui.api'],
      cwd: pluginRoot,
    }]);
    await secondRun.supervisor.request('linre-affect', 'adapter/init', { config: { dataDir } });
    const reloaded = await secondRun.supervisor.request('linre-affect', 'ui/handle', { path: '/state' }) as {
      dimensions: Record<string, number>;
    };
    assert.ok(reloaded.dimensions.joy < 0.5 && reloaded.dimensions.joy > BASELINE.joy);
  } finally {
    await secondRun.supervisor.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('情绪插件：非主人 channel/message 触发 unwelcome_advance 边界保护', { skip }, async () => {
  const { bus, supervisor, failures } = startSupervisor(async () => ({
    text: JSON.stringify(UNWELCOME_FLIRT),
    model: 'fake-light',
  }));
  try {
    await supervisor.start([{
      id: 'linre-affect',
      version: '0.2.0',
      contentHash: 'b'.repeat(64),
      worker,
      capabilities: ['event.observe', 'event.publish', 'model.invoke', 'prompt.inject', 'ui.api'],
      cwd: pluginRoot,
    }]);
    await supervisor.request('linre-affect', 'adapter/init', {
      config: { ownerIds: ['10001'] },
    });
    bus.publishAfterCommit({
      seq: 15,
      ts: new Date().toISOString(),
      type: 'channel/message',
      data: { chatType: 'group-at', mentionsMe: true, senderId: '88888', text: '做我女朋友吧亲亲' },
      visibility: 'model',
    });
    await sleep(100);
    const rendered = await supervisor.request('linre-affect', 'prompt/render', { slot: 'now-layer', maxChars: 160 }) as { text: string };
    assert.match(rendered.text, /保持冷淡|越界搭讪/);
    assert.match(rendered.text, /恼|生气|火大/);
    const stateDoc = await supervisor.request('linre-affect', 'ui/handle', { path: '/state' }) as {
      dimensions: Record<string, number>;
    };
    assert.ok(stateDoc.dimensions.joy <= 0.05);
    assert.ok(stateDoc.dimensions.longing <= 0.05);
    assert.ok(stateDoc.dimensions.trust < BASELINE.trust);
    assert.ok(stateDoc.dimensions.anger > 0.3);
    assert.deepEqual(failures, []);
  } finally {
    await supervisor.stop();
  }
});

test('情绪插件：未声明 model.invoke 时 fail-open 且不调用宿主模型', { skip }, async () => {
  let calls = 0;
  const { bus, supervisor, failures } = startSupervisor(async () => {
    calls += 1;
    return { text: JSON.stringify(OWNER_TEASE) };
  });
  try {
    await supervisor.start([{
      id: 'linre-affect',
      version: '0.2.0',
      contentHash: 'b'.repeat(64),
      worker,
      capabilities: ['event.observe', 'prompt.inject'],
      cwd: pluginRoot,
    }]);
    bus.publishAfterCommit({
      seq: 20,
      ts: new Date().toISOString(),
      type: 'wake/manual',
      data: { source: 'human', text: '今天辛苦啦，表现超棒' },
      visibility: 'model',
    });
    await sleep(100);
    const rendered = await supervisor.request('linre-affect', 'prompt/render', { slot: 'now-layer', maxChars: 160 }) as { text: string };
    assert.equal(calls, 0);
    assert.equal(rendered.text, '心绪：平稳安静。');
    assert.deepEqual(failures, []);
  } finally {
    await supervisor.stop();
  }
});

test('情绪核心：renderLine 在超长 maxChars 下截断不越界', () => {
  const s = applyAppraisal(
    emptyState(1_000),
    normalizeAppraisal(OWNER_TEASE, 'owner')!,
    { atMs: 1_000, sourceSeq: 1, weight: 1, actorTier: 'owner' },
  );
  const short = renderLine(s, 1_000, 12);
  assert.ok([...short].length <= 12);
});
