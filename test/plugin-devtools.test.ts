import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runCli } from '../src/cli.ts';
import { checkPlugin, smokePlugin } from '../src/plugin/devtools.ts';
import { pluginPackageFingerprint } from '../src/plugin/package-store.ts';
import { probePython } from '../src/plugin/runner-paths.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const EXAMPLES = fileURLToPath(new URL('../examples', import.meta.url));
const example = (name: string): string => join(EXAMPLES, name);

test('plugin check：真实示例通过，且只读不改包', () => {
  for (const name of ['hello-tool', 'echo-command', 'hook-observer']) {
    const before = pluginPackageFingerprint(example(name));
    const report = checkPlugin(example(name));
    assert.equal(report.ok, true);
    assert.equal(report.id, name);
    assert.equal(report.kind, 'check');
    assert.equal(pluginPackageFingerprint(example(name)), before);
  }
});

test('plugin smoke：Node 与 TS 示例完成真实激活和进程回收', async () => {
  for (const name of ['hello-tool', 'echo-command']) {
    const report = await smokePlugin(example(name));
    assert.equal(report.processStarted, true);
    assert.equal(report.processStopped, true);
    assert.equal(report.declarative, false);
  }
  const tools = await smokePlugin(example('hello-tool'));
  assert.deepEqual(tools.tools, ['hello-tool__hello']);
  const commands = await smokePlugin(example('echo-command'));
  assert.equal(commands.commandRegistered, true);
});

test('plugin smoke：Python 示例在解释器可用时通过', async (t) => {
  if (!probePython().available) { t.skip('Python unavailable'); return; }
  const report = await smokePlugin(example('hook-observer'));
  assert.equal(report.processStarted, true);
  assert.equal(report.processStopped, true);
  assert.ok(report.hooks.includes('plugin.loaded'));
});

test('plugin smoke：离线宿主拒绝真实网络，不需要联网来验证插件', async () => {
  const source = tempDirSync('irmia-plugin-smoke-offline-');
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({
    apiVersion: 2, id: 'offline-smoke', version: '1.0.0', engine: { irmia: '>=0.1.0-beta.13' },
    runtime: { type: 'node', entry: 'main.mjs' }, permissions: ['net'], net: { allow: ['example.com'] },
  }));
  writeFileSync(join(source, 'main.mjs'), `export async function activate(ctx) {
    try { await ctx.net.fetch('https://example.com/'); throw new Error('network unexpectedly allowed'); }
    catch (error) { if (error?.code !== -32006) throw error; }
  }`);
  const report = await smokePlugin(source);
  assert.equal(report.processStopped, true);
});

test('plugin check / smoke：非法包和激活失败给出真实错误', async () => {
  const source = tempDirSync('irmia-plugin-check-invalid-');
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({
    apiVersion: 2, id: 'invalid-plugin', version: '1.0.0', engine: { irmia: '>=0.1.0-beta.13' }, permissions: [],
  }));
  assert.throws(() => checkPlugin(source), /runtime/);
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({
    apiVersion: 2, id: 'invalid-plugin', version: '1.0.0', engine: { irmia: '>=0.1.0-beta.13' },
    runtime: { type: 'node', entry: 'main.mjs' }, permissions: [],
  }));
  writeFileSync(join(source, 'main.mjs'), 'export function activate() { throw new Error("synthetic activation failure"); }');
  await assert.rejects(smokePlugin(source), /synthetic activation failure/);
});

test('CLI：plugin check 支持 JSON，参数错误与检查失败使用不同退出码', async () => {
  const lines: string[] = [];
  const errors: string[] = [];
  const io = { out: (line: string) => { lines.push(line); }, err: (line: string) => { errors.push(line); } };
  const ctx = { dataDir: tempDirSync('irmia-plugin-cli-data-'), cwd: process.cwd() };
  assert.equal(await runCli(['plugin', 'check', example('hello-tool'), '--json'], io, ctx), 0);
  const report = JSON.parse(lines.join('\n'));
  assert.equal(report.id, 'hello-tool');
  assert.equal(report.kind, 'check');
  assert.equal(await runCli(['plugin', 'check'], io, ctx), 2);
  assert.equal(await runCli(['plugin', 'check', example('missing-plugin')], io, ctx), 1);
  assert.ok(errors.some((line) => line.includes('失败')));
});
