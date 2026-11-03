/**
 * 命名 Hook 注册表 · 旧 14 点兼容回归
 *
 * 目的不是重复既有测试，而是证明"触发点改走注册表之后，旧语义逐字没变"：
 *   · message.received 仍是一条订阅一条过滤、改写链、不丢消息；
 *   · reply.decorate / tool.before / tool.after / model.request 的修改仍按原方向生效；
 *   · turn.* / model.waiting / model.response / message.sent / channel.ready 仍不阻塞调用方；
 *   · plugin.loaded / unloaded / error 仍只发给别的插件，且失败不参与隔离。
 */

import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import type { PluginMessageReceivedPayload } from '../src/plugin/host-services.ts';
import { installPluginPackage } from '../src/plugin/package-store.ts';
import { createHarness, PLUGIN_FIXTURES, type Harness } from './helpers/plugin-runtime-harness.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const AT = '2026-10-29T12:00:00.000Z';

function message(overrides: Partial<PluginMessageReceivedPayload> = {}): PluginMessageReceivedPayload {
  return {
    channel: 'onebot',
    chatType: 'private',
    chatId: 'u-1',
    senderId: 'u-1',
    senderName: '阿岚',
    text: '你好',
    mentionsMe: false,
    mediaCount: 0,
    messageId: 'm-1',
    at: AT,
    ...overrides,
  };
}

function stateOf(harness: Harness, id = 'demo-hook-compat'): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(join(harness.dataDir, 'plugins', 'state', `${id}.json`), 'utf8')) as {
      plugin?: Record<string, unknown>;
    };
    return parsed.plugin ?? {};
  } catch {
    return {};
  }
}

function tracked(t: TestContext, harness: Harness): Harness {
  t.after(async () => { await harness.dispose(); });
  return harness;
}

// ──────────────────────────────── message.received ────────────────────────────────

test('兼容：message.received 过滤仍在宿主侧，未命中一次都不回调；改写链不改丢消息', async (t) => {
  const harness = tracked(t, await createHarness({
    fixture: 'plugin-inbound',
    env: { IRMIA_TEST_INBOUND_FILTER: JSON.stringify({ channel: 'onebot' }) },
  }));
  await harness.start();

  const skipped = await harness.host.dispatchMessageReceived(message({ channel: 'qq-official', messageId: 'm-qq' }));
  assert.equal(skipped.matched, 0);
  assert.equal(skipped.text, '你好');
  assert.equal(stateOf(harness, 'demo-inbound')['last'], undefined);

  const delivered = await harness.host.dispatchMessageReceived(message({ text: '原文', messageId: 'm-onebot' }));
  assert.equal(delivered.matched, 1);
  assert.equal(delivered.drop, false);
  assert.equal(delivered.text, '原文 [demo-inbound:0]');
  assert.equal((stateOf(harness, 'demo-inbound')['last'] as Record<string, unknown>)['messageId'], 'm-onebot');
});

// ──────────────────────────────── 可修改的 blocking 点 ────────────────────────────────

test('兼容：model.request / tool.before / tool.after / reply.decorate 的修改方向不变', async (t) => {
  const harness = tracked(t, await createHarness({ fixture: 'plugin-hook-compat' }));
  await harness.start();

  assert.equal(
    await harness.host.modelRequestSuffix({ lane: 'heavy', model: 'test-model', instructions: '原始指令' }),
    '[compat:原始指令]',
  );

  const before = await harness.host.tapToolBefore({
    callId: 'c-before', tool: 'demo-node__echo', input: { text: 'x' }, turn: 1, step: 1,
  });
  assert.deepEqual(before?.updatedInput, { text: 'x', modified: true });
  assert.equal(before?.additionalContext, 'before-ctx');

  const after = await harness.host.tapToolAfter(
    { callId: 'c-after', tool: 'demo-node__echo', input: { text: 'x' }, turn: 1, step: 2 },
    { status: 'ok', isError: false, content: '结果', durationMs: 3 },
  );
  assert.deepEqual(after?.updatedResult, { content: '结果 [after]' });
  assert.equal(after?.additionalContext, 'after-ctx');

  const decorated = await harness.host.decorateReply({ channel: 'onebot', chatId: 'u-1', text: '你好' });
  assert.equal(decorated.text, '你好 [decorated]');
  assert.equal(decorated.extraMedia.length, 1);
  assert.equal(decorated.extraMedia[0]?.url, 'https://example.test/plugin.png');
  assert.equal(decorated.extraMedia[0]?.name, 'plugin.png');
});

// ──────────────────────────────── 不阻塞的 observe 点 ────────────────────────────────

test('兼容：turn.* / model.response / model.waiting / message.sent / channel.ready 都不阻塞调用方', async (t) => {
  const harness = tracked(t, await createHarness({ fixture: 'plugin-hook-compat' }));
  await harness.start();

  const startedAt = Date.now();
  harness.host.noteTurn('turn.start', { turn: 3, seq: 10 });
  harness.host.noteTurn('turn.end', { turn: 3, seq: 11, spoke: true, reason: 'done' });
  harness.host.noteModelResponse({
    model: 'test-model', status: 'ok',
    outputItems: [{ type: 'message', text: '回答' }],
    usage: { inputTokens: 5, outputTokens: 6 },
  });
  harness.host.noteModelWaiting({ lane: 'heavy', model: 'test-model' });
  harness.host.noteChannelReady({ channel: 'onebot' });
  harness.host.noteMessageSent({ channel: 'onebot', chatId: 'u-1', ok: true, text: '发出去了' });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 100, `这些观察点必须 fire-and-forget（实际 ${elapsed}ms）`);

  await harness.waitFor(() => stateOf(harness)['turnEnd'] !== undefined, 'turn.end 送达');
  await harness.waitFor(() => stateOf(harness)['modelResponse'] !== undefined, 'model.response 送达');
  await harness.waitFor(() => stateOf(harness)['modelWaiting'] !== undefined, 'model.waiting 送达');
  await harness.waitFor(() => stateOf(harness)['lastChannelReady'] !== undefined, 'channel.ready 送达');
  await harness.waitFor(() => stateOf(harness)['lastSent'] !== undefined, 'message.sent 送达');

  const state = stateOf(harness);
  assert.equal((state['turnStart'] as Record<string, unknown>)['turn'], 3);
  assert.equal((state['turnEnd'] as Record<string, unknown>)['spoke'], true);
  assert.equal((state['modelResponse'] as Record<string, unknown>)['text'], '回答');
  assert.deepEqual((state['modelResponse'] as Record<string, unknown>)['usage'], { inputTokens: 5, outputTokens: 6 });
  assert.equal((state['modelWaiting'] as Record<string, unknown>)['lane'], 'heavy');
  assert.equal((state['lastChannelReady'] as Record<string, unknown>)['channel'], 'onebot');
  assert.equal((state['lastSent'] as Record<string, unknown>)['ok'], true);
});

// ──────────────────────────────── 生命周期 ────────────────────────────────

test('兼容：plugin.loaded / unloaded / error 仍只发给别的插件，且顺序不阻塞启动', async (t) => {
  const harness = tracked(t, await createHarness({ fixture: 'plugin-hook-compat' }));
  await harness.start();

  const secondSource = tempDirSync('irmia-plugin-hook-compat-b-');
  cpSync(join(PLUGIN_FIXTURES, 'plugin-hook-compat'), secondSource, { recursive: true });
  const manifestPath = join(secondSource, 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, id: 'demo-hook-compat-b' }, null, 2)}\n`, 'utf8');
  const second = installPluginPackage(secondSource, harness.dataDir);

  const startedAt = Date.now();
  await harness.host.startPackage(second);
  const startedElapsed = Date.now() - startedAt;
  assert.ok(startedElapsed < 5_000, `生命周期通知不许拖住启动（实际 ${startedElapsed}ms）`);
  await harness.waitFor(
    () => (stateOf(harness)['lastLoaded'] as Record<string, unknown> | undefined)?.['id'] === 'demo-hook-compat-b',
    'plugin.loaded 送达别的插件',
  );

  await harness.host.stopPackage('demo-hook-compat-b', second.contentHash, 'test');
  await harness.waitFor(
    () => (stateOf(harness)['lastUnloaded'] as Record<string, unknown> | undefined)?.['id'] === 'demo-hook-compat-b',
    'plugin.unloaded 送达别的插件',
  );

  await harness.host.dispatchHook('plugin.error', {
    id: 'demo-broken', contentHash: 'b'.repeat(64), category: 'crash', reason: '测试',
  });
  await harness.waitFor(() => stateOf(harness)['lastError'] !== undefined, 'plugin.error 送达');
  const lastError = stateOf(harness)['lastError'] as Record<string, unknown>;
  assert.equal(lastError['id'], 'demo-broken');
  assert.equal(lastError['category'], 'crash');
});
