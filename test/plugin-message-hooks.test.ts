/**
 * 插件平台 P1b · 入站消息钩子 `message.received`
 *
 * 真子进程 + 真宿主分发。这一组钉住四件事：
 *   ① **过滤在宿主侧**：channel / chatType / mentionMe / regex / admin 五种条件，没匹配到的
 *      订阅一次都不该被回调（用插件状态文件反过来证明它没收到）；
 *   ② **返回值语义**：改写正文（链式）、drop（不进上下文）、追加 context；
 *   ③ **插件故障不丢消息**：报错/超时都只影响那一条订阅，消息原样继续；连续 3 次隔离该订阅；
 *   ④ **同名钩子按注册顺序串行**（跨插件也一样）。
 *
 * 另外把 `InboundPipeline` 的三条出口（wake / inbox / dropped）用同一个真宿主跑一遍：
 * 那个模块是"过滤链 + 原有分流"的唯一收口，语义只该由它定义。
 */

import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  matchesMessageFilter, parseMessageFilter,
  type PluginMessageReceivedPayload,
} from '../src/plugin/host-services.ts';
import { installPluginPackage } from '../src/plugin/package-store.ts';
import { InboundPipeline } from '../src/channel/inbound.ts';
import type { WakeChannel } from '../src/log/types.js';
import { renderExternalEvent } from '../src/model/render.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';
import { createHarness, PLUGIN_FIXTURES, type Harness } from './helpers/plugin-runtime-harness.ts';

const AT = '2026-10-29T12:00:00.000Z';

function payload(overrides: Partial<PluginMessageReceivedPayload> = {}): PluginMessageReceivedPayload {
  return {
    channel: 'onebot',
    chatType: 'private',
    chatId: 'user-1',
    senderId: 'user-1',
    senderName: '阿岚',
    text: '你好',
    mentionsMe: false,
    mediaCount: 0,
    messageId: 'm-1',
    at: AT,
    ...overrides,
  };
}

function stateOf(harness: Harness, id = 'demo-inbound'): Record<string, unknown> {
  const path = join(harness.dataDir, 'plugins', 'state', `${id}.json`);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { plugin?: Record<string, unknown> };
    return parsed.plugin ?? {};
  } catch {
    return {};
  }
}

function tracked(t: TestContext, harness: Harness): Harness {
  t.after(async () => { await harness.dispose(); });
  return harness;
}

async function inboundHarness(
  t: TestContext,
  options: {
    filter?: unknown;
    filters?: unknown[];
    mode?: string;
    hookMs?: number;
    isOwnerMessage?: (message: PluginMessageReceivedPayload) => boolean;
    noFilter?: boolean;
    extraEnv?: NodeJS.ProcessEnv;
  } = {},
): Promise<Harness> {
  const env: NodeJS.ProcessEnv = {
    IRMIA_TEST_INBOUND_MODE: options.mode ?? 'rewrite',
    ...(options.filter === undefined ? {} : { IRMIA_TEST_INBOUND_FILTER: JSON.stringify(options.filter) }),
    ...(options.filters === undefined ? {} : { IRMIA_TEST_INBOUND_FILTERS: JSON.stringify(options.filters) }),
    ...(options.noFilter === true ? { IRMIA_TEST_INBOUND_NO_FILTER: '1' } : {}),
    ...(options.extraEnv ?? {}),
  };
  const harness = await createHarness({
    fixture: 'plugin-inbound',
    env,
    ...(options.hookMs === undefined ? {} : { timeouts: { hookMs: options.hookMs } }),
    ...(options.isOwnerMessage === undefined ? {} : { isOwnerMessage: options.isOwnerMessage }),
  });
  tracked(t, harness);
  await harness.start();
  return harness;
}

// ──────────────────────────────── ① 过滤 ────────────────────────────────

test('过滤判据：channel / chatType / mentionMe / regex / admin 逐条可判', async () => {
  const message = payload();
  assert.equal(await matchesMessageFilter({ channel: 'onebot' }, message, message.text, undefined), true);
  assert.equal(await matchesMessageFilter({ channel: 'qq-official' }, message, message.text, undefined), false);
  assert.equal(await matchesMessageFilter({ chatType: 'private' }, message, message.text, undefined), true);
  assert.equal(await matchesMessageFilter({ chatType: 'group' }, message, message.text, undefined), false);
  assert.equal(await matchesMessageFilter({ mentionMe: false }, message, message.text, undefined), true);
  assert.equal(await matchesMessageFilter({ mentionMe: true }, message, message.text, undefined), false);
  assert.equal(await matchesMessageFilter({ regex: /^你好/u }, message, message.text, undefined), true);
  assert.equal(await matchesMessageFilter({ regex: /^再见/u }, message, message.text, undefined), false);
  // admin 过滤：没接线 = 谁都不匹配（失败关闭）；接线后按宿主判据
  assert.equal(await matchesMessageFilter({ permission: 'admin' }, message, message.text, undefined), false);
  assert.equal(await matchesMessageFilter({ permission: 'admin' }, message, message.text, () => false), false);
  assert.equal(await matchesMessageFilter({ permission: 'admin' }, message, message.text, () => true), true);
  assert.equal(await matchesMessageFilter({ permission: 'all' }, message, message.text, () => false), true);

  assert.deepEqual(parseMessageFilter({ channel: 'qq-official', chatType: 'group', mentionMe: true, regex: '^天气', permission: 'admin' }), {
    channel: 'qq-official', chatType: 'group', mentionMe: true, regex: /^天气/u, permission: 'admin',
  });
  assert.throws(() => parseMessageFilter(undefined), /过滤条件/);
  assert.throws(() => parseMessageFilter({ regex: '[' }), /正则/);
  assert.throws(() => parseMessageFilter({ channel: 'telegram' }), /channel/);
  assert.throws(() => parseMessageFilter({ unknown: true }), /不支持/);
});

test('订阅时必须给过滤条件；给了非法 regex 也当场拒绝（不拖到运行期）', async (t) => {
  const noFilter = await createHarness({
    fixture: 'plugin-inbound',
    env: { IRMIA_TEST_INBOUND_NO_FILTER: '1' },
  });
  t.after(async () => { await noFilter.dispose(); });
  await assert.rejects(noFilter.start(), /过滤条件/);

  const badRegex = await createHarness({
    fixture: 'plugin-inbound',
    env: { IRMIA_TEST_INBOUND_FILTER: JSON.stringify({ regex: '[' }) },
  });
  t.after(async () => { await badRegex.dispose(); });
  await assert.rejects(badRegex.start(), /正则/);
});

test('过滤链真的在宿主侧：不匹配的消息插件一次都收不到', async (t) => {
  const harness = await inboundHarness(t, { filter: { channel: 'qq-official' }, mode: 'observe' });

  const skipped = await harness.host.dispatchMessageReceived(payload({ channel: 'onebot', messageId: 'm-onebot' }));
  assert.equal(skipped.matched, 0, 'onebot 的消息不该被 qq-official 订阅收到');
  assert.equal(stateOf(harness)['last'], undefined, '插件状态里不能出现这条消息');

  const delivered = await harness.host.dispatchMessageReceived(payload({ channel: 'qq-official', messageId: 'm-qq' }));
  assert.equal(delivered.matched, 1);
  const last = stateOf(harness)['last'] as Record<string, unknown>;
  assert.equal(last['messageId'], 'm-qq');
  assert.equal(last['channel'], 'qq-official');
});

test('admin 过滤：非用户不回调，用户回调（判据来自宿主 isOwnerMessage）', async (t) => {
  const harness = await inboundHarness(t, {
    filter: { permission: 'admin' },
    mode: 'observe',
    isOwnerMessage: (message) => message.senderId === 'owner-1',
  });
  const guest = await harness.host.dispatchMessageReceived(payload({ senderId: 'guest-1', messageId: 'm-guest' }));
  assert.equal(guest.matched, 0);
  assert.equal(stateOf(harness)['last'], undefined);
  const owner = await harness.host.dispatchMessageReceived(payload({ senderId: 'owner-1', messageId: 'm-owner' }));
  assert.equal(owner.matched, 1);
  assert.equal((stateOf(harness)['last'] as Record<string, unknown>)['messageId'], 'm-owner');
});

// ──────────────────────────────── ② 返回值语义 ────────────────────────────────

test('改写：同名钩子按注册顺序串行，后一个看到前一个改过的正文', async (t) => {
  const harness = await inboundHarness(t, {
    filters: [{ permission: 'all' }, { permission: 'all' }],
    mode: 'rewrite',
  });
  const outcome = await harness.host.dispatchMessageReceived(payload({ text: '原文' }));
  assert.equal(outcome.matched, 2);
  assert.equal(outcome.text, '原文 [demo-inbound:0] [demo-inbound:1]');
  assert.equal(outcome.drop, false);
});

test('drop：这条消息不再进上下文（也不进信箱）', async (t) => {
  const harness = await inboundHarness(t, { filter: { permission: 'all' }, mode: 'drop' });
  const outcome = await harness.host.dispatchMessageReceived(payload({ text: '刷屏内容' }));
  assert.equal(outcome.drop, true);
  assert.equal(outcome.matched, 1);
  // 丢弃的日志在 InboundPipeline 那一层（这里是宿主分发，还没到分流口）——
  // 管线出口的断言在下面那组用例里。
});

test('additionalContext：追加到本次唤醒的提示里（wake.channel.pluginContext）', async (t) => {
  const harness = await inboundHarness(t, { filter: { permission: 'all' }, mode: 'context' });
  const outcome = await harness.host.dispatchMessageReceived(payload());
  assert.equal(outcome.additionalContext, 'ctx:[demo-inbound:0]');
});

// ──────────────────────────────── ③ 故障隔离、不丢消息 ────────────────────────────────

test('插件报错：消息原样继续，错误按贡献计数，连续 3 次隔离这条订阅', async (t) => {
  const harness = await inboundHarness(t, { filter: { permission: 'all' }, mode: 'throw' });
  for (let index = 0; index < 3; index += 1) {
    const outcome = await harness.host.dispatchMessageReceived(payload({ text: `原话${index}` }));
    assert.equal(outcome.text, `原话${index}`, '插件报错绝不能改写/丢掉用户消息');
    assert.equal(outcome.matched, 1, '前三次都该真的调用到插件');
  }
  const isolated = harness.events.find((event) => event.type === 'plugin/contribution-isolated');
  assert.ok(isolated !== undefined, `应产出贡献隔离事件：${harness.events.map((event) => event.type).join(',')}`);
  assert.match(String((isolated.data as Record<string, unknown>)['contributionName'] ?? ''), /message\.received/);
  assert.equal(harness.events.filter((event) => event.type === 'plugin/failed').length >= 3, true);

  const after = await harness.host.dispatchMessageReceived(payload({ text: '之后的原话' }));
  assert.equal(after.text, '之后的原话');
  assert.equal(after.matched, 0, '隔离之后不再回调这条订阅');
});

test('2s 超时：按时间预算收场、不挂住消息；连续 3 次隔离', async (t) => {
  const harness = await inboundHarness(t, { filter: { permission: 'all' }, mode: 'hang', hookMs: 250 });
  const started = Date.now();
  for (let index = 0; index < 3; index += 1) {
    const outcome = await harness.host.dispatchMessageReceived(payload({ text: `等不到回话${index}` }));
    assert.equal(outcome.text, `等不到回话${index}`, '超时也不许丢消息');
  }
  assert.ok(Date.now() - started < 5_000, '三次超时必须按 250ms 预算收场，不能被挂死');
  const isolated = harness.events.find((event) => event.type === 'plugin/contribution-isolated');
  assert.ok(isolated !== undefined);
  assert.equal((isolated.data as Record<string, unknown>)['category'], 'hook-timeout');
});

// ──────────────────────────────── ④ 跨插件顺序 + 管线出口 ────────────────────────────────

test('跨插件：按注册顺序串行（先起的插件先改，后起的看到改过的正文）', async (t) => {
  const harness = await inboundHarness(t, { filter: { permission: 'all' }, mode: 'rewrite' });
  const source = tempDirSync('irmia-plugin-inbound-b-');
  cpSync(join(PLUGIN_FIXTURES, 'plugin-inbound'), source, { recursive: true });
  const manifestPath = join(source, 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, id: 'demo-inbound-b' }, null, 2));
  const second = installPluginPackage(source, harness.dataDir);
  await harness.host.startPackage(second);

  const outcome = await harness.host.dispatchMessageReceived(payload({ text: '起点' }));
  assert.equal(outcome.matched, 2);
  assert.equal(outcome.text, '起点 [demo-inbound:0] [demo-inbound-b:0]');
});

test('InboundPipeline：rewrite 进 wake、drop 什么都不进、context 进 pluginContext', async (t) => {
  const makePipeline = (harness: Harness, wakeResult: boolean): {
    pipeline: InboundPipeline;
    wakes: WakeChannel['data'][];
    inbox: WakeChannel['data'][];
    replies: unknown[];
  } => {
    const wakes: WakeChannel['data'][] = [];
    const inbox: WakeChannel['data'][] = [];
    const replies: unknown[] = [];
    const pipeline = new InboundPipeline({
      plugins: harness.host,
      shouldWake: () => wakeResult,
      isMentioned: () => false,
      wake: (data) => { wakes.push(data); },
      inbox: (data) => { inbox.push(data); },
      reply: async (reply) => { replies.push(reply); },
      log: () => {},
      now: () => new Date(AT),
    });
    return { pipeline, wakes, inbox, replies };
  };
  const data = (text: string): WakeChannel['data'] => ({
    channel: 'onebot', chatType: 'c2c', person: 'user-1', chatId: 'user-1',
    text, messageId: 'm-1', msgSeq: 1,
  });

  const rewrite = await inboundHarness(t, { filter: { permission: 'all' }, mode: 'rewrite' });
  const rewritten = makePipeline(rewrite, true);
  const outcome = await rewritten.pipeline.handle(data('你好'));
  assert.equal(outcome.action, 'wake');
  assert.equal(rewritten.wakes[0]?.text, '你好 [demo-inbound:0]');

  const drop = await inboundHarness(t, { filter: { permission: 'all' }, mode: 'drop' });
  const dropped = makePipeline(drop, true);
  const dropOutcome = await dropped.pipeline.handle(data('刷屏'));
  assert.equal(dropOutcome.action, 'dropped');
  assert.deepEqual(dropped.wakes, []);
  assert.deepEqual(dropped.inbox, []);

  const context = await inboundHarness(t, { filter: { permission: 'all' }, mode: 'context' });
  const contextual = makePipeline(context, true);
  await contextual.pipeline.handle(data('带上下文'));
  assert.equal(contextual.wakes[0]?.pluginContext, 'ctx:[demo-inbound:0]');

  const throwing = await inboundHarness(t, { filter: { permission: 'all' }, mode: 'throw' });
  const fallback = makePipeline(throwing, true);
  const fallbackOutcome = await fallback.pipeline.handle(data('插件坏了也别丢'));
  assert.equal(fallbackOutcome.action, 'wake');
  assert.equal(fallback.wakes[0]?.text, '插件坏了也别丢');
});

test('渲染层：pluginContext 渲染在外部消息框之外（没有就不改变字节）', () => {
  const base = {
    channel: 'onebot', chatType: 'c2c' as const, person: 'user-1', text: '你好',
    messageId: 'm-1', msgSeq: 1, chatId: 'user-1',
  };
  const without = renderExternalEvent(base);
  const withContext = renderExternalEvent({ ...base, pluginContext: '插件补充：今天有雨' });
  assert.equal(without.includes('[插件上下文]'), false);
  assert.equal(withContext.includes('[插件上下文] 插件补充：今天有雨'), true);
  assert.ok(withContext.startsWith(without), '附加内容不能改写外部消息框本身');
  assert.ok(withContext.indexOf('[/external_event]') < withContext.indexOf('[插件上下文]'), '必须渲染在框外');
});
