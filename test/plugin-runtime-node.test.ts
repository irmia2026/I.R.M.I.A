/**
 * 插件平台 P1a · Node 进程 e2e
 *
 * 真包、真子进程、真 JSON-RPC：
 *   ① 注册工具 → 宿主调用 → 拿回结果（两次调用各自的 id 关联到各自的响应）；
 *   ② 没声明 `tools.define` → 注册直接报错（权限在调用那一刻判）；
 *   ③ 工具超时 → 进程被杀 + 贡献级计数；
 *   ④ `tool.after` 能改结果（语义：结果已产生、还没喂回模型之前）；
 *   ⑤ `reply.decorate` 能改出站文本；
 *   ⑥ `config.schema.json` 的默认值真的交到插件手里。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';

import { HookRunner } from '../src/hook/hooks.ts';
import { createHarness, type Harness } from './helpers/plugin-runtime-harness.ts';

function tracked(t: TestContext, harness: Harness): Harness {
  t.after(async () => { await harness.dispose(); });
  return harness;
}

test('node 插件：注册工具 → 宿主调用 → 两次调用各自拿到自己的结果', async (t) => {
  const harness = tracked(t, await createHarness());
  await harness.start();
  assert.equal(harness.tools.has('demo-node__echo'), true, '工具必须进注册表');
  const first = await harness.callTool('demo-node__echo', { text: '一' });
  const second = await harness.callTool('demo-node__echo', { text: '二' });
  assert.deepEqual(first, { content: 'echo:一' });
  assert.deepEqual(second, { content: 'echo:二' });
  assert.equal(harness.host.status('demo-node', harness.pkg.contentHash).state, 'running');
  assert.equal(harness.manager.list()[0]?.requiresRestart, false, '热启用之后不该还显示"需要重启"');
});

test('node 插件：没声明 tools.define 时注册直接报错，消息里要指路', async (t) => {
  const harness = tracked(t, await createHarness({ manifest: { permissions: [] } }));
  await assert.rejects(harness.start(), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /tools\.define/);
    assert.match(message, /权限|permissions/);
    return true;
  });
  assert.equal(harness.tools.size, 0);
});

test('node 插件：工具超时 → 杀进程 + 记一次 timeout（不整包停）', async (t) => {
  const harness = tracked(t, await createHarness({ timeouts: { toolMs: 300 }, timeoutRestartDelayMs: 60_000 }));
  await harness.start();
  const result = await harness.callTool('demo-node__hang', {});
  assert.equal(result.isError, true);
  assert.equal(result.error?.code, 'E_TIMEOUT');
  assert.match(result.content, /超时|300ms/);
  await harness.waitFor(
    () => harness.events.some((event) => event.type === 'plugin/failed' && String((event.data as Record<string, unknown>)['reason'] ?? '').includes('timeout')),
    '一条 timeout 的 plugin/failed',
  );
  // 超时击杀是一次"我们让它退"，进程必须真的没了（pid=null），但插件本身仍在管理表里
  await harness.waitFor(() => harness.host.status('demo-node', harness.pkg.contentHash).pid === null, '进程被杀掉');
  assert.equal(harness.manager.list()[0]?.state, 'enabled', '超时不整包停用');
});

test('node 插件：tool.after 能改写结果（HookRunner 的插件挂点）', async (t) => {
  const harness = tracked(t, await createHarness());
  await harness.start();
  const runner = new HookRunner({
    entries: [],
    pluginToolHooks: {
      before: async (request) => await harness.host.tapToolBefore(request),
      after: async (request, result) => await harness.host.tapToolAfter(request, result),
    },
  });
  const decision = await runner.afterToolCall(
    { callId: 'c1', tool: 'demo-node__echo', input: { text: 'x' }, turn: 1, step: 1 },
    { status: 'ok', isError: false, content: 'echo:x', durationMs: 1 },
  );
  assert.deepEqual(decision.updatedResult, { content: 'echo:x [after]' });
  // 别的工具不归它管：钩子只能看见自己认得的工具
  const untouched = await runner.afterToolCall(
    { callId: 'c2', tool: 'safe_read', input: {}, turn: 1, step: 1 },
    { status: 'ok', isError: false, content: 'file', durationMs: 1 },
  );
  assert.equal(untouched.updatedResult, undefined);
});

test('node 插件：reply.decorate 改出站文本，message.sent 是旁路（不阻塞发送）', async (t) => {
  const harness = tracked(t, await createHarness());
  await harness.start();
  const decorated = await harness.host.decorateReply({ channel: 'onebot', chatId: '1', text: '你好' });
  assert.equal(decorated.text, '你好 [decorated]');
  assert.deepEqual(decorated.extraMedia, []);
  // 没有订阅 message.sent 的插件时它是空转（这里只钉"调用不抛"）
  assert.doesNotThrow(() => { harness.host.noteMessageSent({ channel: 'onebot', chatId: '1', ok: true }); });

  const stateFile = `${harness.dataDir}/plugins/state/demo-node.json`;
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { plugin?: Record<string, unknown> };
  assert.equal(typeof state.plugin?.['activatedAt'], 'string', 'ctx.state.plugin 必须真的落盘');
});

test('node 插件：config.schema.json 的默认值进 ctx.config，覆盖值按 schema 校验', async (t) => {
  const harness = tracked(t, await createHarness({ config: { greeting: 'hi', unknownKey: 1, retries: 'not-a-number' } }));
  await harness.start();
  const result = await harness.callTool('demo-node__config', {});
  const config = JSON.parse(result.content) as Record<string, unknown>;
  assert.equal(config['greeting'], 'hi', '覆盖值生效');
  assert.equal(config['retries'], 2, '类型不对的覆盖值回落到默认值');
  assert.equal(config['verbose'], false);
  assert.equal(config['mode'], 'safe');
  assert.equal(harness.writes.some((line) => line.includes('不在 schema 里')), true, '未知配置项要报出来');
});
