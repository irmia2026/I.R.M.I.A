/**
 * 插件平台 P1a · 热生命周期
 *
 * 钉住四件事（设计稿 §五 的裁决）：
 *   ① enable / disable 是**热**的：进程当场起停，`requiresRestart` 立刻变 false；
 *   ② 崩溃 → `plugin/crashed` → 冷却后重启**一次** → 再崩 → 自动停用；
 *   ③ uninstall 删包目录（且先杀进程、再删）；
 *   ④ `plugin.error` 在别的插件启动失败时带 `category` 送达（免权限）。
 */

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { installPluginPackage } from '../src/plugin/package-store.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';
import { createHarness, PLUGIN_FIXTURES } from './helpers/plugin-runtime-harness.ts';

function stateOf(dataDir: string, id: string): Record<string, unknown> {
  const path = join(dataDir, 'plugins', 'state', `${id}.json`);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { plugin?: Record<string, unknown> };
    return parsed.plugin ?? {};
  } catch {
    return {};
  }
}

test('热启停：enable 起进程、disable 杀进程，宿主不用重启', async (t) => {
  const harness = await createHarness({ enable: false, crashCooldownMs: 60 });
  t.after(async () => { await harness.dispose(); });
  const id = harness.pkg.manifest.id;
  const hash = harness.pkg.contentHash;

  // enable 之前：包在盘上、没进程
  assert.equal(harness.host.status(id, hash).pid, null);
  harness.manager.confirm(id, hash);
  harness.manager.setEnabled(id, hash, true);
  await harness.waitFor(() => harness.host.status(id, hash).state === 'running', '热启用把进程拉起来');
  assert.equal(typeof harness.host.status(id, hash).pid, 'number');
  assert.equal(harness.manager.list()[0]?.requiresRestart, false, '热启用后不该还要求重启');
  assert.equal(harness.tools.has('demo-node__echo'), true);
  assert.deepEqual(harness.manager.active().map((pkg) => pkg.contentHash), [hash], '组合面立刻收它');

  harness.manager.setEnabled(id, hash, false);
  await harness.waitFor(() => harness.host.status(id, hash).pid === null, '热停用杀掉进程');
  await harness.waitFor(() => harness.tools.size === 0, '工具随进程撤掉');
  assert.equal(harness.manager.list()[0]?.state, 'disabled');
  assert.equal(harness.events.some((event) => event.type === 'plugin/runtime-stopped'
    && (event.data as Record<string, unknown>)['reason'] === 'disable'), true);

  // plugin.loaded 钩子真的送达过（免权限的生命周期钩子）
  await harness.waitFor(() => stateOf(harness.dataDir, id)['loaded'] !== undefined, 'plugin.loaded 落到插件状态');
});

test('崩溃：crashed 事件 → 冷却后重启一次 → 再崩自动停用', async (t) => {
  const harness = await createHarness({ crashCooldownMs: 60, timeoutRestartDelayMs: 60 });
  t.after(async () => { await harness.dispose(); });
  const id = harness.pkg.manifest.id;
  const hash = harness.pkg.contentHash;
  await harness.start();
  const firstPid = harness.host.status(id, hash).pid;
  assert.equal(typeof firstPid, 'number');

  const crashed = await harness.callTool('demo-node__crash', {});
  assert.equal(crashed.isError, true, '进程退出时工具调用必须回错误，而不是挂住');
  await harness.waitFor(() => harness.events.some((event) => event.type === 'plugin/crashed'), '第一条 plugin/crashed');
  const firstCrash = harness.events.find((event) => event.type === 'plugin/crashed')!;
  assert.equal((firstCrash.data as Record<string, unknown>)['willRestart'], true);

  await harness.waitFor(() => harness.events.some((event) => event.type === 'plugin/restarted'), '冷却后拉起一次');
  await harness.waitFor(() => harness.host.status(id, hash).state === 'running', '进程重新 running');
  const secondPid = harness.host.status(id, hash).pid;
  assert.notEqual(secondPid, firstPid, '重启后是新的进程');
  // 重启后工具要重新注册（崩溃时被撤掉的那一批）
  await harness.waitFor(() => harness.tools.has('demo-node__crash'), '重启后重新注册工具');

  await harness.callTool('demo-node__crash', {});
  await harness.waitFor(() => harness.events.some((event) => event.type === 'plugin/crashed'
    && (event.data as Record<string, unknown>)['willRestart'] === false), '第二次崩溃不再重启');
  await harness.waitFor(() => harness.manager.list()[0]?.state === 'disabled', '连续两次崩溃 → 自动停用');
  assert.equal(harness.events.filter((event) => event.type === 'plugin/restarted').length, 1, '只重启一次');
  assert.equal(harness.events.some((event) => event.type === 'plugin/failed'
    && String((event.data as Record<string, unknown>)['reason'] ?? '').includes('连续两次崩溃')), true);
});

test('uninstall：先杀进程、再删包目录，事件留得下 path', async (t) => {
  const harness = await createHarness({ crashCooldownMs: 60 });
  t.after(async () => { await harness.dispose(); });
  const id = harness.pkg.manifest.id;
  const hash = harness.pkg.contentHash;
  await harness.start();
  const rootDir = harness.pkg.rootDir;
  assert.equal(existsSync(rootDir), true);

  harness.manager.uninstall(id, hash);
  assert.equal(existsSync(rootDir), false, '包目录必须被删掉');
  assert.equal(harness.host.status(id, hash).pid, null, '进程必须先停');
  assert.equal(harness.tools.size, 0, '工具随卸载撤掉');
  assert.deepEqual(harness.manager.list(), []);
  const event = harness.events.find((item) => item.type === 'plugin/uninstalled');
  assert.ok(event !== undefined, '卸载必须有事件');
  assert.equal((event.data as Record<string, unknown>)['path'], rootDir, '事件里要留得下它原来在哪');
});

test('plugin.error：别的插件崩溃时带 category=crash 送达（第一次崩溃就要触发）', async (t) => {
  const harness = await createHarness({ crashCooldownMs: 60, timeoutRestartDelayMs: 60 });
  t.after(async () => { await harness.dispose(); });
  const observer = harness.pkg.manifest.id;
  await harness.start();

  // 第二个插件：同一份夹具，换个 id（它的 `crash` 工具会 process.exit）
  const source = tempDirSync('irmia-plugin-crasher-');
  cpSync(join(PLUGIN_FIXTURES, 'plugin-node'), source, { recursive: true });
  const manifestPath = join(source, 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, id: 'crash-node' }, null, 2));
  const crashing = installPluginPackage(source, harness.dataDir);
  await harness.host.startPackage(crashing);
  await harness.waitFor(() => harness.tools.has('crash-node__crash'), '崩溃插件的工具注册好');

  const crashed = await harness.callTool('crash-node__crash', {});
  assert.equal(crashed.isError, true);
  await harness.waitFor(() => {
    const lastError = stateOf(harness.dataDir, observer)['lastError'] as Record<string, unknown> | undefined;
    return lastError !== undefined && lastError['category'] === 'crash';
  }, 'plugin.error 在第一次崩溃时就带 category=crash');
  const lastError = stateOf(harness.dataDir, observer)['lastError'] as Record<string, unknown>;
  assert.equal(lastError['id'], 'crash-node');
});

test('plugin.error：别的插件启动失败时，带 category 与可读原因送达（免权限）', async (t) => {
  const harness = await createHarness({ crashCooldownMs: 60 });
  t.after(async () => { await harness.dispose(); });
  const observer = harness.pkg.manifest.id;
  await harness.start();

  // 造一个 activate 必炸的包
  const source = tempDirSync('irmia-plugin-bad-');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({
    apiVersion: 2, id: 'bad-node', version: '1.0.0', engine: { irmia: '>=0.1.0-beta.13' },
    runtime: { type: 'node', entry: 'main.mjs' }, permissions: [],
  }));
  writeFileSync(join(source, 'main.mjs'), 'export async function activate() { throw new Error("boom"); }\n');
  const bad = installPluginPackage(source, harness.dataDir);
  await assert.rejects(harness.host.startPackage(bad));

  await harness.waitFor(() => {
    const lastError = stateOf(harness.dataDir, observer)['lastError'] as Record<string, unknown> | undefined;
    return lastError !== undefined && lastError['category'] === 'start';
  }, 'plugin.error 送达观察者（category=start）');
  const lastError = stateOf(harness.dataDir, observer)['lastError'] as Record<string, unknown>;
  assert.equal(lastError['id'], 'bad-node');
  assert.match(String(lastError['reason'] ?? ''), /boom|启动失败/);
});
