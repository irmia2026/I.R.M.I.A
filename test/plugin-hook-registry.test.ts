/**
 * 命名 Hook 注册表 · 声明期校验 + 分发语义 + 三个新点的 e2e
 *
 * 前三组是不起进程的纯注册表测试（顺序/并发/abort/errorPolicy/超时），后面接真宿主：
 *   · 六个能力族缺票 → `hook.subscribe` 当场 -32001；
 *   · `host.ready` 在宿主生命周期内只触发一次；
 *   · `command.before` 能改 args / abort 后按未命中继续；`command.after` 拿到结果载荷。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  HOOK_POINT_METADATA, HOOK_TIMEOUT_MAX_MS, HookRegistry,
  PLUGIN_HOOK_PERMISSIONS, PLUGIN_HOOK_POINTS, normalizeHookSubscription,
  type HookSubscriptionInput,
} from '../src/plugin/hook-registry.ts';
import type { PluginMessageReceivedPayload } from '../src/plugin/host-services.ts';
import { listPlugins } from '../src/plugin/http.ts';
import { parsePluginManifest } from '../src/plugin/manifest.ts';
import { PLUGIN_RPC_ERRORS } from '../src/plugin/protocol.ts';
import { InboundPipeline } from '../src/channel/inbound.ts';
import { createHarness, type Harness } from './helpers/plugin-runtime-harness.ts';

const HASH_A = 'a'.repeat(64);
const AT = '2026-10-29T12:00:00.000Z';

let subscriptionSeed = 0;

function add(registry: HookRegistry, overrides: Partial<HookSubscriptionInput> = {}) {
  subscriptionSeed += 1;
  return registry.register({
    subscriptionId: overrides.subscriptionId ?? `sub-${subscriptionSeed}`,
    pluginId: overrides.pluginId ?? `plugin-${subscriptionSeed}`,
    contentHash: overrides.contentHash ?? HASH_A,
    point: overrides.point ?? 'command.before',
    mode: overrides.mode ?? 'blocking',
    order: overrides.order ?? 'NORMAL',
    timeoutMs: overrides.timeoutMs ?? 1_000,
    errorPolicy: overrides.errorPolicy ?? 'SKIP',
    abortIntent: overrides.abortIntent ?? false,
  });
}

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

function stateOf(harness: Harness, id: string): Record<string, unknown> {
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

const tick = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

async function expectRpcError(fn: () => unknown, pattern: RegExp): Promise<void> {
  await assert.rejects(async () => fn(), (error: unknown) => {
    const rpc = error as { code?: number; message?: string };
    assert.equal(rpc.code, PLUGIN_RPC_ERRORS.invalidParams, `应为 -32602：${String(rpc.message)}`);
    assert.match(String(rpc.message), pattern);
    return true;
  });
}

// ──────────────────────────────── 元数据表 ────────────────────────────────

test('注册表：17 个点名（旧 14 个逐字保留）与每点元数据完整', () => {
  assert.equal(PLUGIN_HOOK_POINTS.length, 17);
  assert.deepEqual(PLUGIN_HOOK_POINTS.slice(0, 14), [
    'model.request', 'model.response', 'model.waiting', 'turn.start', 'turn.end',
    'tool.before', 'tool.after', 'reply.decorate', 'message.sent', 'message.received',
    'channel.ready', 'plugin.loaded', 'plugin.unloaded', 'plugin.error',
  ]);
  assert.deepEqual(PLUGIN_HOOK_POINTS.slice(14), ['host.ready', 'command.before', 'command.after']);

  const expectedPermissions = {
    'model.request': 'hooks.model', 'model.response': 'hooks.model', 'model.waiting': 'hooks.model',
    'turn.start': 'hooks.turn', 'turn.end': 'hooks.turn',
    'tool.before': 'hooks.tool', 'tool.after': 'hooks.tool',
    'reply.decorate': 'chat.send', 'message.sent': 'chat.send', 'message.received': 'messages.read',
    'channel.ready': null, 'plugin.loaded': null, 'plugin.unloaded': null, 'plugin.error': null,
    'host.ready': null, 'command.before': 'commands.define', 'command.after': 'commands.define',
  } as const;
  assert.deepEqual(PLUGIN_HOOK_PERMISSIONS, expectedPermissions);

  for (const point of PLUGIN_HOOK_POINTS) {
    const meta = HOOK_POINT_METADATA[point];
    assert.equal(meta.name, point);
    assert.ok(meta.description.length > 0, `${point} 缺少 description`);
    assert.ok(meta.modes.length > 0, `${point} 缺少 modes`);
    assert.ok(meta.errorPolicies.length > 0, `${point} 缺少 errorPolicies`);
    assert.ok(meta.defaultTimeoutMs > 0 && meta.defaultTimeoutMs <= HOOK_TIMEOUT_MAX_MS);
    assert.equal(meta.permission, expectedPermissions[point]);
    assert.equal(meta.orderSlots, true);
  }
  assert.deepEqual(HOOK_POINT_METADATA['host.ready'].modes, ['observe']);
  assert.equal(HOOK_POINT_METADATA['host.ready'].allowAbort, false);
  assert.deepEqual(HOOK_POINT_METADATA['command.before'].modes, ['blocking']);
  assert.equal(HOOK_POINT_METADATA['command.before'].allowAbort, true);
  assert.equal(HOOK_POINT_METADATA['command.after'].allowModify, false);
});

// ──────────────────────────────── 清单声明 ────────────────────────────────

test('清单：可选 hooks 数组接受点名/对象两种写法，归一化后可供安装审阅', () => {
  const parsed = parsePluginManifest({
    apiVersion: 2,
    id: 'demo-hook-manifest',
    version: '1.0.0',
    engine: { irmia: '>=0.1.0' },
    runtime: { type: 'node', entry: 'main.mjs' },
    permissions: ['hooks.model', 'commands.define'],
    hooks: [
      'model.request',
      { point: 'command.before', errorPolicy: 'ABORT', abort: true, timeoutMs: 1_200 },
    ],
  });
  assert.deepEqual(parsed.hooks, [
    { point: 'model.request', mode: 'blocking', order: 'NORMAL', timeoutMs: 2_000, errorPolicy: 'SKIP', abort: false },
    { point: 'command.before', mode: 'blocking', order: 'NORMAL', timeoutMs: 1_200, errorPolicy: 'ABORT', abort: true },
  ]);

  const manifest = (overrides: Record<string, unknown>) => ({
    apiVersion: 2,
    id: 'demo-hook-manifest',
    version: '1.0.0',
    engine: { irmia: '>=0.1.0' },
    runtime: { type: 'node', entry: 'main.mjs' },
    permissions: [],
    ...overrides,
  });
  assert.throws(() => parsePluginManifest(manifest({ hooks: ['does.not.exist'] })), /未知 Hook 点/u);
  assert.throws(
    () => parsePluginManifest(manifest({ permissions: [], hooks: [{ point: 'command.before', abort: true }] })),
    /command\.before 需要权限 commands\.define|需要权限 commands\.define/u,
  );
  assert.throws(
    () => parsePluginManifest(manifest({ permissions: ['hooks.turn'], hooks: [{ point: 'turn.start', abort: true }] })),
    /不允许声明 abort 意图/u,
  );
  assert.throws(
    () => parsePluginManifest(manifest({ permissions: ['hooks.model'], hooks: [{ point: 'model.request', timeoutMs: HOOK_TIMEOUT_MAX_MS + 1 }] })),
    /超过上限 10000ms/u,
  );
  assert.throws(
    () => parsePluginManifest(manifest({
      permissions: ['messages.read'],
      hooks: [{ point: 'message.received', filter: { permission: 'all' } }],
    })),
    /不接受过滤条件/u,
  );
});

// ──────────────────────────────── 声明期校验 ────────────────────────────────

test('订阅校验：未知点 / 不允许的模式 / 不允许的 abort / 超限超时 / 非法 errorPolicy 都拒绝且点名约束', async () => {
  await expectRpcError(
    () => normalizeHookSubscription('does.not.exist', { point: 'does.not.exist' }),
    /未知 Hook 点.*does\.not\.exist.*已命名点/u,
  );
  await expectRpcError(
    () => normalizeHookSubscription('turn.start', { point: 'turn.start', mode: 'blocking' }),
    /turn\.start.*不允许 blocking 模式.*允许：observe/u,
  );
  await expectRpcError(
    () => normalizeHookSubscription('tool.before', { point: 'tool.before', abort: true }),
    /tool\.before.*不允许声明 abort 意图.*allowAbort=false/u,
  );
  await expectRpcError(
    () => normalizeHookSubscription('command.before', { point: 'command.before', timeoutMs: HOOK_TIMEOUT_MAX_MS + 1 }),
    /command\.before.*timeoutMs.*超过上限 10000ms.*10001ms/u,
  );
  await expectRpcError(
    () => normalizeHookSubscription('host.ready', { point: 'host.ready', errorPolicy: 'ABORT' }),
    /host\.ready.*errorPolicy.*不允许 ABORT.*允许：SKIP \/ LOG/u,
  );
  await expectRpcError(
    () => normalizeHookSubscription('command.before', { point: 'command.before', order: 'FIRST' }),
    /command\.before.*order 只能是 EARLY \/ NORMAL \/ LATE/u,
  );

  const accepted = normalizeHookSubscription('command.before', {
    point: 'command.before', mode: 'blocking', order: 'EARLY', timeoutMs: 1_500,
    errorPolicy: 'LOG', abort: true,
  });
  assert.deepEqual(accepted, {
    point: 'command.before', mode: 'blocking', order: 'EARLY', timeoutMs: 1_500,
    errorPolicy: 'LOG', abortIntent: true,
  });
});

// ──────────────────────────────── 顺序 / 串行 / 并发 ────────────────────────────────

test('顺序：blocking 按 EARLY→NORMAL→LATE，同序按注册先后串行', async () => {
  const registry = new HookRegistry();
  add(registry, { subscriptionId: 'late', order: 'LATE' });
  add(registry, { subscriptionId: 'normal', order: 'NORMAL' });
  add(registry, { subscriptionId: 'early-1', order: 'EARLY' });
  add(registry, { subscriptionId: 'early-2', order: 'EARLY' });

  const calls: string[] = [];
  const result = await registry.invoke('command.before', {}, {
    call: async (subscription) => { calls.push(subscription.subscriptionId); return {}; },
  });
  assert.deepEqual(calls, ['early-1', 'early-2', 'normal', 'late']);
  assert.equal(result.results.length, 4);
  assert.equal(result.failed, false);
});

test('blocking 载荷链：nextPayload 把前一个的修改交给后一个（command.before 的 args）', async () => {
  const registry = new HookRegistry();
  add(registry, { subscriptionId: 'one', order: 'EARLY' });
  add(registry, { subscriptionId: 'two', order: 'NORMAL' });
  const seen: unknown[] = [];
  const result = await registry.invoke('command.before', { args: { value: '起点' } }, {
    call: async (_subscription, payload) => {
      seen.push(payload['args']);
      const args = payload['args'] as { value: string };
      return { args: { value: `${args.value}+${seen.length}` } };
    },
    nextPayload: (_subscription, current, value) => ({
      ...current,
      args: (value as Record<string, unknown>)['args'],
    }),
  });
  assert.deepEqual(seen, [{ value: '起点' }, { value: '起点+1' }]);
  assert.equal(result.results.length, 2);
});

test('blocking 串行：前一个没返回，后一个不会开始', async () => {
  const registry = new HookRegistry();
  add(registry, { subscriptionId: 'first', order: 'NORMAL', timeoutMs: 2_000 });
  add(registry, { subscriptionId: 'second', order: 'NORMAL', timeoutMs: 2_000 });

  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const pending = registry.invoke('command.before', {}, {
    call: async (subscription) => {
      calls.push(subscription.subscriptionId);
      if (subscription.subscriptionId === 'first') await gate;
      return {};
    },
  });
  await tick();
  assert.deepEqual(calls, ['first']);
  release?.();
  await pending;
  assert.deepEqual(calls, ['first', 'second']);
});

test('observe 并发：所有处理器同时起跑，互不等待', async () => {
  const registry = new HookRegistry();
  add(registry, { subscriptionId: 'obs-1', point: 'host.ready', mode: 'observe', timeoutMs: 2_000 });
  add(registry, { subscriptionId: 'obs-2', point: 'host.ready', mode: 'observe', timeoutMs: 2_000 });

  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const pending = registry.invoke('host.ready', {}, {
    call: async (subscription) => {
      started.push(subscription.subscriptionId);
      await new Promise<void>((resolve) => { releases.set(subscription.subscriptionId, resolve); });
      return {};
    },
  });
  await tick();
  assert.deepEqual(started, ['obs-1', 'obs-2'], '两个 observe 处理器必须在任何一个返回前都已起跑');
  releases.get('obs-1')?.();
  releases.get('obs-2')?.();
  const result = await pending;
  assert.equal(result.results.length, 2);
  assert.equal(result.failures.length, 0);
});

// ──────────────────────────────── abort ────────────────────────────────

test('abort：允许的点能停止后续 blocking，并告知调用方被谁中止', async () => {
  const registry = new HookRegistry();
  add(registry, { subscriptionId: 'first', pluginId: 'p-first', abortIntent: true });
  add(registry, { subscriptionId: 'stopper', pluginId: 'p-stop', abortIntent: true });
  add(registry, { subscriptionId: 'never', pluginId: 'p-never', abortIntent: true });

  const calls: string[] = [];
  const result = await registry.invoke('command.before', {}, {
    call: async (subscription) => {
      calls.push(subscription.subscriptionId);
      if (subscription.subscriptionId === 'stopper') return { abort: true, reason: '不要执行' };
      return {};
    },
  });
  assert.deepEqual(calls, ['first', 'stopper']);
  assert.equal(result.failed, false);
  assert.equal(result.abortedBy?.pluginId, 'p-stop');
  assert.equal(result.abortedBy?.subscriptionId, 'stopper');
  assert.equal(result.abortedBy?.reason, '不要执行');
});

test('abort：声明了 abort 但点不允许时在订阅那一刻就被拒（不是运行时静默）', async () => {
  await expectRpcError(
    () => normalizeHookSubscription('tool.after', { point: 'tool.after', abort: true }),
    /tool\.after.*不允许声明 abort 意图/u,
  );
  // 未经声明的 abort 返回值不会中止（只在 allowAbort 且 abortIntent=true 时生效）
  const registry = new HookRegistry();
  add(registry, { subscriptionId: 'unclaimed', abortIntent: false });
  add(registry, { subscriptionId: 'after', abortIntent: false });
  const calls: string[] = [];
  const result = await registry.invoke('command.before', {}, {
    call: async (subscription) => {
      calls.push(subscription.subscriptionId);
      return subscription.subscriptionId === 'unclaimed' ? { abort: true } : {};
    },
  });
  assert.deepEqual(calls, ['unclaimed', 'after']);
  assert.equal(result.abortedBy, null);
});

// ──────────────────────────────── errorPolicy ────────────────────────────────

test('errorPolicy：ABORT 停整点、SKIP 静默继续、LOG 继续但额外记一条', async () => {
  const run = async (errorPolicy: 'ABORT' | 'SKIP' | 'LOG') => {
    const registry = new HookRegistry();
    add(registry, { subscriptionId: 'boom', errorPolicy });
    add(registry, { subscriptionId: 'after' });
    const calls: string[] = [];
    const logs: string[] = [];
    const result = await registry.invoke('command.before', {}, {
      call: async (subscription) => {
        calls.push(subscription.subscriptionId);
        if (subscription.subscriptionId === 'boom') throw new Error('boom');
        return {};
      },
      log: (line) => { logs.push(line); },
    });
    return { result, calls, logs };
  };

  const abort = await run('ABORT');
  assert.deepEqual(abort.calls, ['boom'], 'ABORT 之后不再调用后续 blocking');
  assert.equal(abort.result.failed, true);
  assert.match(String(abort.result.error), /errorPolicy=ABORT/u);

  const skip = await run('SKIP');
  assert.deepEqual(skip.calls, ['boom', 'after']);
  assert.equal(skip.result.failed, false);
  assert.equal(skip.logs.length, 0, 'SKIP 在注册表层不额外记日志（宿主仍会计失败次数）');

  const log = await run('LOG');
  assert.deepEqual(log.calls, ['boom', 'after']);
  assert.equal(log.result.failed, false);
  assert.equal(log.logs.length, 1);
  assert.match(log.logs[0]!, /errorPolicy=LOG/u);
});

// ──────────────────────────────── 超时 ────────────────────────────────

test('超时：blocking 超时按点默认/订阅值计为失败，ABORT 时中止后续', async () => {
  const registry = new HookRegistry();
  add(registry, { subscriptionId: 'slow', timeoutMs: 35, errorPolicy: 'ABORT' });
  add(registry, { subscriptionId: 'after', timeoutMs: 1_000 });

  const started = Date.now();
  const calls: string[] = [];
  const result = await registry.invoke('command.before', {}, {
    call: async (subscription) => {
      calls.push(subscription.subscriptionId);
      if (subscription.subscriptionId === 'slow') await new Promise(() => {});
      return {};
    },
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `超时必须在订阅值附近收场（实际 ${elapsed}ms）`);
  assert.deepEqual(calls, ['slow']);
  assert.equal(result.failed, true);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.category, 'timeout');
  assert.match(result.failures[0]?.error.message ?? '', /35ms 未返回/u);
});

test('超时：observe 慢处理器不拖住调用方，失败只记在结果里', async () => {
  const registry = new HookRegistry();
  add(registry, { subscriptionId: 'slow-observe', point: 'host.ready', mode: 'observe', timeoutMs: 30 });
  const started = Date.now();
  const result = await registry.invoke('host.ready', {}, {
    call: async () => await new Promise(() => {}),
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `observe 超时也必须快速返回（实际 ${elapsed}ms）`);
  assert.equal(result.failed, false, 'observe 失败不让整点失败');
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.category, 'timeout');
});

// ──────────────────────────────── 权限（真宿主 e2e） ────────────────────────────────

test('权限：六个能力族各缺一张票，订阅当场 -32001 并点名权限', async (t) => {
  const harness = tracked(t, await createHarness({ fixture: 'plugin-hook-permissions' }));
  await harness.start();
  const line = harness.writes.find((item) => item.includes('HOOK_PERMISSION_RESULTS '));
  assert.ok(line !== undefined, `插件没有报告权限结果：${harness.writes.join(' | ')}`);
  const results = JSON.parse(line.slice(line.indexOf('HOOK_PERMISSION_RESULTS ') + 'HOOK_PERMISSION_RESULTS '.length)) as Record<
    string, { code: number | null; message: string }
  >;
  const expected = {
    'model.request': 'hooks.model',
    'turn.start': 'hooks.turn',
    'tool.before': 'hooks.tool',
    'reply.decorate': 'chat.send',
    'message.received': 'messages.read',
    'command.before': 'commands.define',
  } as const;
  for (const [point, permission] of Object.entries(expected)) {
    assert.equal(results[point]?.code, PLUGIN_RPC_ERRORS.permissionDenied, `${point} 应是 -32001：${JSON.stringify(results[point])}`);
    assert.match(results[point]?.message ?? '', new RegExp(permission.replace('.', '\\.')), `${point} 的错误里要点名 ${permission}`);
  }
});

// ──────────────────────────────── 新点 e2e ────────────────────────────────

test('host.ready：宿主生命周期内只触发一次（observe），载荷带 at', async (t) => {
  const harness = tracked(t, await createHarness({ fixture: 'plugin-hook-compat' }));
  await harness.start();

  harness.host.noteHostReady({ source: 'test' });
  await harness.waitFor(() => stateOf(harness, 'demo-hook-compat')['hostReadyCount'] === 1, 'host.ready 第一次送达');
  harness.host.noteHostReady({ source: 'test-again' });
  await sleep(200);
  const state = stateOf(harness, 'demo-hook-compat');
  assert.equal(state['hostReadyCount'], 1, '第二次 noteHostReady 不许再触发');
  const ready = state['hostReady'] as Record<string, unknown>;
  assert.equal(ready['source'], 'test');
  assert.equal(typeof ready['at'], 'string');

  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
  assert.match(source, /pluginHost\.noteHostReady\(\);/u, 'main 装配点必须真的发一次 host.ready');
});

test('command.before：改 args 后 handler 看到新参数；command.after 收到 ok/durationMs/keepInContext', async (t) => {
  const harness = tracked(t, await createHarness({ fixture: 'plugin-hook-commands' }));
  await harness.start();

  // 清单声明进 /api/plugins 的视图（`package.manifest.hooks`）
  const view = harness.manager.list()[0];
  assert.deepEqual(view?.package.manifest.hooks?.map((hook) => hook.point), ['command.before', 'command.after']);
  const listed = listPlugins(harness.manager);
  assert.equal(listed.status, 200);
  const body = listed.body as { items: Array<{ package: { manifest: { hooks?: Array<{ point: string; timeoutMs: number }> } } }> };
  assert.equal(body.items[0]?.package.manifest.hooks?.[0]?.point, 'command.before');
  assert.equal(body.items[0]?.package.manifest.hooks?.[0]?.timeoutMs, 1_500);

  const outcome = await harness.host.runCommand({ text: '/probe 原值', message: message({ text: '/probe 原值' }) });
  assert.ok(outcome !== null);
  assert.equal(outcome.command, 'probe');
  assert.equal(outcome.keepInContext, true);
  assert.deepEqual(outcome.reply, { text: 'probe:原值-before+second' });

  await harness.waitFor(() => stateOf(harness, 'demo-hook-commands')['after'] !== undefined, 'command.after 送达');
  const state = stateOf(harness, 'demo-hook-commands');
  assert.equal((state['before'] as Record<string, unknown>)['command'], 'probe');
  assert.deepEqual((state['before2'] as Record<string, unknown>)['args'], { value: '原值-before' }, '第二个 blocking 必须看到第一个改过的 args');
  assert.deepEqual(state['handlerArgs'], { value: '原值-before+second' });
  const after = state['after'] as Record<string, unknown>;
  assert.equal(after['ok'], true);
  assert.equal(after['keepInContext'], true);
  assert.equal(typeof after['durationMs'], 'number');
});

test('Python 运行期：带选项订阅 + 订阅 id + command.before 改 args 同样生效', async (t) => {
  const harness = tracked(t, await createHarness({ fixture: 'plugin-hook-py' }));
  await harness.start();

  harness.host.noteTurn('turn.start', { turn: 9, seq: 90 });
  await harness.waitFor(
    () => (stateOf(harness, 'demo-hook-py')['turn'] as Record<string, unknown> | undefined)?.['turn'] === 9,
    'Python turn.start 送达',
  );

  const outcome = await harness.host.runCommand({ text: '/pytest abc', message: message({ text: '/pytest abc' }) });
  assert.ok(outcome !== null);
  assert.deepEqual(outcome.reply, { text: 'py:abc-py' });
  assert.equal(outcome.keepInContext, true);
  await harness.waitFor(() => stateOf(harness, 'demo-hook-py')['after'] !== undefined, 'Python command.after 送达');
  const state = stateOf(harness, 'demo-hook-py');
  assert.equal((state['before'] as Record<string, unknown>)['command'], 'pytest');
  assert.deepEqual(state['handlerArgs'], { value: 'abc-py' });
  assert.equal((state['after'] as Record<string, unknown>)['ok'], true);
});

test('command.before abort：不跑 handler、不回话、command.after 不触发，消息按未命中继续唤醒', async (t) => {
  const harness = tracked(t, await createHarness({
    fixture: 'plugin-hook-commands',
    env: { IRMIA_TEST_COMMAND_HOOK_MODE: 'abort' },
  }));
  await harness.start();

  const direct = await harness.host.runCommand({ text: '/probe 原值', message: message({ text: '/probe 原值' }) });
  assert.equal(direct, null, 'abort 必须返回 null（等价"未命中指令"）');
  await sleep(150);
  const state = stateOf(harness, 'demo-hook-commands');
  assert.equal(state['handlerArgs'], undefined, 'handler 不许执行');
  assert.equal(state['before2'], undefined, 'abort 后后续 blocking 不许执行');
  assert.equal(state['after'], undefined, 'command.after 不许触发');

  const wakes: Array<Record<string, unknown>> = [];
  const inbox: Array<Record<string, unknown>> = [];
  const replies: unknown[] = [];
  const pipeline = new InboundPipeline({
    plugins: harness.host,
    shouldWake: () => true,
    isMentioned: () => false,
    wake: (data) => { wakes.push(data as unknown as Record<string, unknown>); },
    inbox: (data) => { inbox.push(data as unknown as Record<string, unknown>); },
    reply: async (reply) => { replies.push(reply); },
    log: () => {},
  });
  const result = await pipeline.handle({
    channel: 'onebot', chatType: 'c2c', person: 'u-1', chatId: 'u-1',
    text: '/probe 原值', messageId: 'm-abort', msgSeq: 1,
  });
  assert.equal(result.action, 'wake', 'abort 后按未命中指令继续原流程');
  assert.equal(result.command, null);
  assert.deepEqual(replies, [], 'abort 不许回任何话');
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]?.['text'], '/probe 原值');
  assert.deepEqual(inbox, []);
});
