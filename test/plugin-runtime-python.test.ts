/**
 * 插件平台 P1a · Python 入口 e2e
 *
 * 这台机器上没有 Python 就跳过（`t.skip`）：Python 运行器需要宿主机装 3.9+。
 * 有 Python 时钉三件事：`python -I -u` 的启动形状、`irmia_plugin` shim 的 ctx、
 * 以及"安装期 AST 扫描能过"（夹具里没有越权 import）。
 */

import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { installPluginPackage } from '../src/plugin/package-store.ts';
import { probePython } from '../src/plugin/runner-paths.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';
import { createHarness, PLUGIN_FIXTURES } from './helpers/plugin-runtime-harness.ts';

test('python 插件：运行器可跑则注册工具并回结果，不可用则跳过', async (t) => {
  const probe = probePython();
  if (!probe.available) {
    t.skip(`这台机器没有可用的 Python（${probe.binary}：${probe.detail}）`);
    return;
  }
  const harness = await createHarness({ fixture: 'plugin-py' });
  t.after(async () => { await harness.dispose(); });
  await harness.start();
  assert.equal(harness.tools.has('demo-py__echo'), true);
  const result = await harness.callTool('demo-py__echo', { text: '世界' });
  assert.deepEqual(result, { content: 'py:世界' });
  assert.equal(harness.host.status('demo-py', harness.pkg.contentHash).state, 'running');
});

test('python 插件：对象式工具定义保留 destructive 危险等级', async (t) => {
  if (!probePython().available) { t.skip('Python unavailable'); return; }
  const harness = await createHarness();
  t.after(async () => { await harness.dispose(); });
  const source = tempDirSync('irmia-plugin-py-side-effect-');
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({
    apiVersion: 2, id: 'py-side-effect', version: '1.0.0', engine: { irmia: '>=0.1.0-beta.13' },
    runtime: { type: 'python', entry: 'main.py' }, permissions: ['tools.define'],
  }));
  writeFileSync(join(source, 'main.py'), `def activate(ctx):\n    ctx.tools.define({"name":"delete","description":"delete","sideEffect":"destructive","handler":lambda args:{"content":"ok"}})\n`);
  const pkg = harness.manager.install(source);
  await harness.host.startPackage(pkg);
  assert.equal(harness.tools.get('py-side-effect__delete')?.sideEffect, 'destructive');
});

test('python 插件：安装期 AST 扫描拒收越权 import（门槛，不是沙箱）', (t) => {
  const probe = probePython();
  if (!probe.available) {
    t.skip(`这台机器没有可用的 Python（${probe.binary}：${probe.detail}）`);
    return;
  }
  const source = tempDirSync('irmia-plugin-py-ast-');
  cpSync(join(PLUGIN_FIXTURES, 'plugin-py'), source, { recursive: true });
  const manifestPath = join(source, 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, id: 'demo-py-bad', permissions: [] }, null, 2));
  writeFileSync(join(source, 'main.py'), 'import os\n\ndef activate(ctx):\n    pass\n');
  const dataDir = tempDirSync('irmia-plugin-py-ast-data-');
  assert.throws(() => installPluginPackage(source, dataDir), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /AST/);
    assert.match(message, /os/);
    return true;
  });
});

test('python 插件：AST 扫描对动态执行一律拒绝', (t) => {
  const probe = probePython();
  if (!probe.available) {
    t.skip(`这台机器没有可用的 Python（${probe.binary}：${probe.detail}）`);
    return;
  }
  const source = tempDirSync('irmia-plugin-py-dyn-');
  cpSync(join(PLUGIN_FIXTURES, 'plugin-py'), source, { recursive: true });
  const manifestPath = join(source, 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, id: 'demo-py-dyn' }, null, 2));
  writeFileSync(join(source, 'main.py'), 'def activate(ctx):\n    __import__("os").system("echo hi")\n');
  const dataDir = tempDirSync('irmia-plugin-py-dyn-data-');
  assert.throws(() => installPluginPackage(source, dataDir), /动态执行|__import__/);
});
