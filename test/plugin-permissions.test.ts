/**
 * 插件平台 · 权限矩阵（P1b 起 14 个权限值逐条覆盖）
 *
 * 做法：给**每一个**权限各造一个真包，activate 里把 14 个 ctx 调用全部试一遍，把结果
 * 用 `ctx.log` 打一行 JSON。于是同一条用例同时钉住两件事：
 *   · 声明了的那一个 → 允许；
 *   · 其余十三个 → 调用那一刻**逐条拒绝**（消息里点得出缺哪张票）。
 *
 * `net` 的"允许"没法用一次真请求证明（这台机器不保证有外网），所以它的探针只要求
 * "错误里出现 net.allow 而不是权限名"——那说明票已经过了，拒它的是网络策略。
 *
 * 为什么不用 mock：权限判据在 host-services 的**请求处理**里，不在协议层；只有真进程
 * 发真请求，才能证明"少写一行 permissions，插件确实调不动"。
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { PluginHost } from '../src/plugin/host-services.ts';
import { PLUGIN_PERMISSIONS, parsePluginManifest } from '../src/plugin/manifest.ts';
import { installPluginPackage } from '../src/plugin/package-store.ts';
import type { ToolDefinition } from '../src/tools/types.js';
import { tempDirSync } from './helpers/temp-dirs.ts';

const PROBE_PERMISSIONS = PLUGIN_PERMISSIONS;

/** 每个权限 → 一次真实 ctx 调用（结果标签 = 权限名，便于逐条核对） */
const PROBE_BODY = `
const results = {};
async function probe(name, fn) {
  try { await fn(); results[name] = 'ok'; } catch (error) { results[name] = String(error && error.message ? error.message : error); }
}
export async function activate(ctx) {
  await probe('tools.define', () => ctx.tools.define({ name: 'probe', description: 'probe', handler: async () => ({ content: 'ok' }) }));
  await probe('hooks.model', () => ctx.hooks.on('model.request', () => ({})));
  await probe('hooks.turn', () => ctx.hooks.on('turn.start', () => ({})));
  await probe('hooks.tool', () => ctx.hooks.on('tool.before', () => ({})));
  await probe('chat.send', () => ctx.chat.send({ text: 'hi' }));
  await probe('chat.read', () => ctx.chat.history(5));
  await probe('model.call', () => ctx.model.complete({ tier: 'light', messages: [{ role: 'user', content: 'hi' }] }));
  await probe('timers', () => ctx.timers.every(1000, () => {}));
  await probe('state.session', () => ctx.state.session.set('probe', 1));
  await probe('state.plugin', () => ctx.state.plugin.set('probe', 1));
  await probe('files', () => ctx.files.write('probe.txt', 'x'));
  await probe('net', async () => {
    try {
      await ctx.net.fetch('https://example.com/');
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      // 票过了、被网络策略拒：这正是"声明 net 得到的结果"（没声明时是权限拒绝）
      if (message.includes('net.allow')) return;
      throw error;
    }
  });
  await probe('messages.read', () => ctx.hooks.on('message.received', () => ({}), { permission: 'all' }));
  await probe('commands.define', () => ctx.commands.define({
    name: 'probe', description: 'probe', permission: 'all', handler: async () => ({}),
  }));
  ctx.log.info('PERMISSION_RESULTS ' + JSON.stringify(results));
}
`;

interface ProbeResult {
  results: Record<string, string>;
  writes: string[];
  registered: string[];
}

async function runProbe(permissions: readonly string[]): Promise<ProbeResult> {
  const dataDir = tempDirSync('irmia-plugin-perm-data-');
  const source = tempDirSync('irmia-plugin-perm-src-');
  const id = `perm-${permissions.length === 0 ? 'none' : permissions[0]!.replace(/[^a-z0-9-]/g, '-')}`;
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({
    apiVersion: 2,
    id,
    version: '1.0.0',
    engine: { irmia: '>=0.1.0-beta.13' },
    runtime: { type: 'node', entry: 'main.mjs' },
    permissions: [...permissions],
  }));
  writeFileSync(join(source, 'main.mjs'), PROBE_BODY, 'utf8');
  const pkg = installPluginPackage(source, dataDir);

  const writes: string[] = [];
  const registered: string[] = [];
  const host = new PluginHost({
    dataDir,
    write: (line) => { writes.push(line); },
    emit: () => {},
    tools: {
      register: (definition: ToolDefinition) => { registered.push(definition.name); },
      unregister: () => {},
    },
    bridge: {
      recordFailure: () => {},
      markRuntimeApplied: () => {},
      applyComposition: () => {},
      autoDisable: () => {},
      packageOf: () => pkg,
    },
    sendChat: async () => ({ ok: true }),
    readChat: async () => [],
    completeModel: async () => ({ text: 'ok', model: 'probe', usage: { inputTokens: 1, outputTokens: 1 } }),
  });
  try {
    await host.startPackage(pkg);
    const line = writes.find((item) => item.includes('PERMISSION_RESULTS'));
    assert.ok(line !== undefined, `插件没有报告权限探测结果（日志：${writes.join(' | ')}）`);
    const json = line.slice(line.indexOf('PERMISSION_RESULTS ') + 'PERMISSION_RESULTS '.length);
    return { results: JSON.parse(json) as Record<string, string>, writes, registered };
  } finally {
    await host.stopAll('test');
  }
}

test('P1b 的 14 个权限逐条覆盖：声明即允许，未声明即拒绝', async () => {
  for (const permission of PROBE_PERMISSIONS) {
    const { results } = await runProbe([permission]);
    assert.equal(results[permission], 'ok', `声明了 ${permission} 却被拒：${JSON.stringify(results)}`);
    for (const other of PROBE_PERMISSIONS) {
      if (other === permission) continue;
      const message = results[other] ?? '';
      assert.notEqual(message, 'ok', `只声明了 ${permission}，${other} 却成功了`);
      assert.match(message, new RegExp(other.replace('.', '\\.')), `${other} 的拒绝消息里要能看出缺哪张票：${message}`);
    }
  }
});

test('一个权限都没声明：14 个调用全部被拒绝（没有"默认放行"这回事）', async () => {
  const { results, registered } = await runProbe([]);
  for (const permission of PROBE_PERMISSIONS) {
    assert.match(results[permission] ?? '', /权限|permissions/, `${permission} 不该放行`);
  }
  assert.deepEqual(registered, [], '没声明 tools.define 时工具一件都不该注册');
});

test('shell 仍被拒收；net 已开放但 net.allow 必须校验形状、且没写就是全拒', () => {
  assert.throws(
    () => parsePluginManifest({
      apiVersion: 2, id: 'demo', version: '1.0.0', engine: { irmia: '>=0.1.0' },
      runtime: { type: 'node', entry: 'main.mjs' }, permissions: ['shell'],
    }),
    /默认永不授予/,
  );
  assert.throws(
    () => parsePluginManifest({
      apiVersion: 2, id: 'demo', version: '1.0.0', engine: { irmia: '>=0.1.0' },
      runtime: { type: 'node', entry: 'main.mjs' }, permissions: ['filesystem.read'],
    }),
    /未知权限/,
  );
  // 只声明 net、不写 allow：合法，且白名单是空表（默认全拒）
  const bare = parsePluginManifest({
    apiVersion: 2, id: 'demo', version: '1.0.0', engine: { irmia: '>=0.1.0' },
    runtime: { type: 'node', entry: 'main.mjs' }, permissions: ['net'],
  });
  assert.deepEqual(bare.netAllow, []);
  // 规范形状
  const nested = parsePluginManifest({
    apiVersion: 2, id: 'demo', version: '1.0.0', engine: { irmia: '>=0.1.0' },
    runtime: { type: 'node', entry: 'main.mjs' }, permissions: ['net'],
    net: { allow: ['API.Example.com', '*.example.com', '127.0.0.1', '::1'] },
  });
  assert.deepEqual(nested.netAllow, ['api.example.com', '*.example.com', '127.0.0.1', '::1']);
  // 兼容形状（字段路径写法）
  const flat = parsePluginManifest({
    apiVersion: 2, id: 'demo', version: '1.0.0', engine: { irmia: '>=0.1.0' },
    runtime: { type: 'node', entry: 'main.mjs' }, permissions: ['net'], 'net.allow': ['localhost'],
  });
  assert.deepEqual(flat.netAllow, ['localhost']);
  // 写了 allow 却没有 net 票；两种写法同时出现；含糊条目——都拒收
  for (const manifest of [
    { permissions: [], net: { allow: ['example.com'] } },
    { permissions: ['net'], net: { allow: [] }, 'net.allow': [] },
    { permissions: ['net'], net: { allow: ['https://example.com'] } },
    { permissions: ['net'], net: { allow: ['example.com:443'] } },
    { permissions: ['net'], net: { allow: ['*'] } },
    { permissions: ['net'], net: { allow: ['*.127.0.0.1'] } },
  ]) {
    assert.throws(() => parsePluginManifest({
      apiVersion: 2, id: 'demo', version: '1.0.0', engine: { irmia: '>=0.1.0' },
      runtime: { type: 'node', entry: 'main.mjs' }, ...manifest,
    }), /net|权限|域名|通配|字符串/i);
  }
});

test('apiVersion 2 必须有 runtime；apiVersion 1 缺省 declarative（旧包一个字节不用改）', () => {
  assert.throws(() => parsePluginManifest({
    apiVersion: 2, id: 'demo', version: '1.0.0', engine: { irmia: '>=0.1.0' },
    contributions: { skills: [] }, permissions: [],
  }), /runtime/);
  const legacy = parsePluginManifest({
    apiVersion: 1, id: 'demo', version: '1.0.0', engine: { irmia: '>=0.1.0' },
    contributions: { skills: [] }, permissions: ['filesystem.read'],
  });
  assert.equal(legacy.runtime.type, 'declarative');
});
