/**
 * 插件平台 P1b · 两个小钩子
 *
 *   · `model.waiting`：模型请求已发出、正在等响应。**fire-and-forget**——宿主不 await，
 *     插件慢/坏都不许拖慢一次真实请求；
 *   · `channel.ready`：适配器连上时触发，**断线重连要能再次触发**。这一条不能只测
 *     `host.noteChannelReady` 调两次（那只是宿主入口），要真的走一遍 OneBot 客户端的
 *     "连上 → 断开 → 自动重连 → 再连上"，证明回调是接在链路状态上的。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { OneBotClient } from '../src/channel/onebot.ts';
import type { WsClient, WsCloseInfo, WsMessage } from '../src/channel/ws-client.ts';
import { createHarness, type Harness } from './helpers/plugin-runtime-harness.ts';

const ID = 'demo-lifecycle';

function lifecycleState(harness: Harness): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(join(harness.dataDir, 'plugins', 'state', `${ID}.json`), 'utf8')) as {
      plugin?: Record<string, unknown>;
    };
    return parsed.plugin ?? {};
  } catch {
    return {};
  }
}

function readyLines(harness: Harness): string[] {
  return harness.writes.filter((line) => line.includes('CHANNEL_READY'));
}

async function lifecycleHarness(t: TestContext, env: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const harness = await createHarness({ fixture: 'plugin-lifecycle', env });
  t.after(async () => { await harness.dispose(); });
  await harness.start();
  return harness;
}

test('model.waiting：宿主调用立即返回（不阻塞模型请求），插件稍后收到', async (t) => {
  const harness = await lifecycleHarness(t, { IRMIA_TEST_WAIT_DELAY_MS: '300' });
  const started = Date.now();
  harness.host.noteModelWaiting({ lane: 'heavy', model: 'test-model' });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 100, `noteModelWaiting 必须 fire-and-forget（实际 ${elapsed}ms）`);
  assert.equal(harness.writes.some((line) => line.includes('MODEL_WAITING')), false, '调用返回时插件还没跑完，说明没被 await');

  await harness.waitFor(
    () => harness.writes.some((line) => line.includes('MODEL_WAITING')),
    '插件收到 model.waiting',
  );
  const waiting = lifecycleState(harness)['lastWaiting'] as Record<string, unknown>;
  assert.equal(waiting['lane'], 'heavy');
  assert.equal(waiting['model'], 'test-model');
  assert.equal(typeof waiting['at'], 'string');
});

test('channel.ready：宿主入口每次调用都触发（断线重连的宿主侧语义）', async (t) => {
  const harness = await lifecycleHarness(t);
  harness.host.noteChannelReady({ channel: 'onebot' });
  harness.host.noteChannelReady({ channel: 'qq-official' });
  await harness.waitFor(() => readyLines(harness).length === 2, '两条 channel.ready 都送达');
  assert.match(readyLines(harness)[0] ?? '', /"channel":"onebot"/);
  assert.match(readyLines(harness)[1] ?? '', /"channel":"qq-official"/);
  assert.equal(lifecycleState(harness)['readyCount'], 2);
});

/** OneBot 客户端测试用的假 ws：能推事件、能模拟对端断线 */
function fakeWs(): { client: WsClient; push(value: unknown): void; drop(): void; sent: string[] } {
  let open = true;
  let onMessage: ((message: WsMessage) => void) | null = null;
  let onClose: ((info: WsCloseInfo) => void) | null = null;
  const sent: string[] = [];
  const client: WsClient = {
    get isOpen() { return open; },
    send(text) { sent.push(text); },
    sendJson(value) { sent.push(JSON.stringify(value)); },
    onMessage(callback) { onMessage = callback; },
    onClose(callback) { onClose = callback; },
    onError() {},
    setReadTimeoutMs() {},
    close(code = 1000, reason = '') {
      if (!open) return;
      open = false;
      onClose?.({ code, reason, byLocal: true });
    },
  };
  return {
    client,
    sent,
    push(value) {
      if (!open) return;
      onMessage?.({ type: 'text', text: JSON.stringify(value), bytes: Buffer.from(JSON.stringify(value)) });
    },
    drop() {
      if (!open) return;
      open = false;
      onClose?.({ code: 1006, reason: 'peer dropped', byLocal: false });
    },
  };
}

test('channel.ready：OneBot 断线自动重连后再次触发（真客户端状态机）', async (t) => {
  const harness = await lifecycleHarness(t);
  const sockets: Array<ReturnType<typeof fakeWs>> = [];
  const client = new OneBotClient({
    wsUrl: 'ws://fixture.invalid/onebot',
    channelName: 'onebot',
    connect: async () => {
      const fake = fakeWs();
      sockets.push(fake);
      return fake.client;
    },
    reconnectBaseMs: 1,
    maxReconnectDelayMs: 1,
    onWake: () => {},
    // **这就是宿主接线**：适配器每次链路就绪都转成插件钩子
    onReady: () => { harness.host.noteChannelReady({ channel: 'onebot' }); },
    log: { info: () => {}, warn: () => {} },
  });
  t.after(() => { client.stop(); });

  client.start();
  await harness.waitFor(() => sockets.length === 1, '第一次连上');
  sockets[0]!.push({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect', self_id: '10001' });
  await harness.waitFor(() => readyLines(harness).length === 1, '第一次 channel.ready');
  assert.match(readyLines(harness)[0] ?? '', /"channel":"onebot"/);

  // 模拟对端断线：客户端按 1ms 退避重连（真状态机，不是手动再调一次）
  sockets[0]!.drop();
  await harness.waitFor(() => sockets.length === 2, '断线后自动重连');
  sockets[1]!.push({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: '10001', interval: 30_000 });
  await harness.waitFor(() => readyLines(harness).length === 2, '重连后再次 channel.ready');
  assert.equal(lifecycleState(harness)['readyCount'], 2, '两次就绪都要落进插件状态');
});
