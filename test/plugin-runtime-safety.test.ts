import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { runPluginCommand } from '../src/plugin/http.ts';
import { scanPluginPackage } from '../src/plugin/package-store.ts';
import { PluginProcess, PLUGIN_STDERR_LIMITS, pluginProcessEnv } from '../src/plugin/runtime-process.ts';
import { probePython } from '../src/plugin/runner-paths.ts';
import { createHarness } from './helpers/plugin-runtime-harness.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

function directProcess(t: TestContext, code: string, runtime: 'node' | 'python' = 'node', extra: Record<string, string> = {}) {
  const root = tempDirSync('irmia-plugin-runtime-safety-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const entry = runtime === 'node' ? 'main.mjs' : 'main.py';
  writeFileSync(join(root, entry), code);
  for (const [name, content] of Object.entries(extra)) writeFileSync(join(root, name), content);
  const stderr: string[] = [], logs: string[] = [];
  const notifications: Array<{ method: string; params: unknown }> = [];
  const child = new PluginProcess({
    target: { id: 'runtime-safety', version: '1.0.0', apiVersion: 2, contentHash: 'a'.repeat(64),
      rootDir: root, dataDir, runtime: { type: runtime, entry }, permissions: [], netAllow: [], config: {} },
    handlers: { onRequest: async (method, params) => { notifications.push({ method, params }); return { ok: true }; },
      onStderr: (line) => { stderr.push(line); }, onProtocolProblem: (reason) => { logs.push(reason); } },
    log: (line) => { logs.push(line); }, onExit: () => {},
  });
  t.after(async () => { await child.stop('test'); });
  return { child, root, stderr, logs, notifications };
}

test('插件环境只继承运行必需变量，不继承宿主密钥或 NODE_OPTIONS', async (t) => {
  assert.deepEqual(pluginProcessEnv({ PATH: 'safe-path', SystemRoot: 'safe-root', NODE_OPTIONS: '--inspect', API_SECRET: 'fake-secret' }),
    { PATH: 'safe-path', SystemRoot: 'safe-root', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });
  const before = process.env['IRMIA_TEST_HOST_ONLY_SECRET'];
  process.env['IRMIA_TEST_HOST_ONLY_SECRET'] = 'SYNTHETIC_HOST_ONLY';
  t.after(() => { if (before === undefined) delete process.env['IRMIA_TEST_HOST_ONLY_SECRET']; else process.env['IRMIA_TEST_HOST_ONLY_SECRET'] = before; });
  const fx = directProcess(t, `export async function activate(ctx) {
    ctx.log.info(JSON.stringify({secret: process.env.IRMIA_TEST_HOST_ONLY_SECRET ?? null, path: typeof process.env.PATH}));
  }`);
  await fx.child.start();
  const log = fx.notifications.find((item) => item.method === 'log.write')?.params as { message?: string } | undefined;
  assert.ok(log?.message);
  assert.deepEqual(JSON.parse(log.message), { secret: null, path: 'string' });
});

test('stderr 洪泛有字节、行数与单行上限，仍能处理后续协议请求', async (t) => {
  const fx = directProcess(t, `export async function activate(ctx) {
    process.stderr.write('x'.repeat(512 * 1024));
    process.stderr.write(('tiny\\n').repeat(5000));
    await ctx.tools.define({name:'ping',description:'alive',handler:()=>({content:'pong'})});
  }`);
  await fx.child.start();
  const result = await fx.child.request('tool.invoke', { name: 'ping', args: {} });
  assert.deepEqual(result, { content: 'pong' });
  await fx.child.stop('test');
  assert.ok(fx.stderr.length > 0);
  assert.ok(fx.stderr.length <= PLUGIN_STDERR_LIMITS.linesPerWindow);
  assert.ok(fx.stderr.every((line) => line.length <= PLUGIN_STDERR_LIMITS.lineChars));
  assert.ok(fx.stderr.reduce((sum, line) => sum + Buffer.byteLength(line), 0) <= PLUGIN_STDERR_LIMITS.bytesPerWindow);
  assert.ok(fx.logs.some((line) => /stderr.*已丢弃 \d+ 字节/u.test(line)));
});

test('Python 首次运行不生成字节码，正常及损坏包都可通过管理命令停用卸载', async (t) => {
  if (!probePython().available) { t.skip('Python unavailable'); return; }
  const fx = await createHarness({ fixture: 'plugin-py', enable: false });
  t.after(async () => { await fx.dispose(); });
  const payload = { id: fx.pkg.manifest.id, contentHash: fx.pkg.contentHash };
  assert.equal(runPluginCommand('plugin-confirm', payload, fx.manager).status, 200);
  assert.equal(runPluginCommand('plugin-enable', payload, fx.manager).status, 200);
  await fx.waitFor(() => fx.host.status(payload.id, payload.contentHash).state === 'running', 'Python enabled');
  assert.equal(existsSync(join(fx.pkg.rootDir, '__pycache__')), false);
  assert.equal(scanPluginPackage(fx.pkg.rootDir).contentHash, fx.pkg.contentHash);
  assert.equal(runPluginCommand('plugin-disable', payload, fx.manager).status, 200);
  await fx.waitFor(() => fx.host.status(payload.id, payload.contentHash).pid === null, 'Python disabled');
  assert.equal(runPluginCommand('plugin-enable', payload, fx.manager).status, 200);
  await fx.waitFor(() => fx.host.status(payload.id, payload.contentHash).state === 'running', 'Python enabled again');
  writeFileSync(join(fx.pkg.rootDir, 'unexpected.txt'), 'content drift');
  assert.equal(fx.manager.list()[0]?.state, 'invalid');
  assert.equal(runPluginCommand('plugin-disable', payload, fx.manager).status, 200);
  await fx.waitFor(() => fx.host.status(payload.id, payload.contentHash).pid === null, 'damaged Python disabled');
  assert.equal(runPluginCommand('plugin-enable', payload, fx.manager).status, 400, 'bad bytes must never be enabled');
  assert.equal(runPluginCommand('plugin-uninstall', payload, fx.manager).status, 200);
  assert.equal(existsSync(fx.pkg.rootDir), false);
  assert.deepEqual(fx.manager.list(), []);
});

test('Python 父进程正常退出后，其辅助进程随运行层停用一并退出', async (t) => {
  if (!probePython().available) { t.skip('Python unavailable'); return; }
  const fx = directProcess(t, `import helper
def activate(ctx):
    ctx.log.info('CHILD_PID ' + str(helper.start()))
`, 'python', { 'helper.py': `import subprocess
import sys
def start():
    flags = 0x08000000 if sys.platform == 'win32' else 0
    return subprocess.Popen([sys.executable, '-I', '-B', '-c', 'import time; time.sleep(60)'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags).pid
` });
  let descendant = 0;
  t.after(() => { if (descendant && alive(descendant)) { try { process.kill(descendant, 'SIGKILL'); } catch {} } });
  const started = Date.now();
  await fx.child.start();
  assert.ok(Date.now() - started < 15_000, 'job setup fits normal activation budget');
  const message = (fx.notifications.find((item) => item.method === 'log.write')?.params as { message?: string })?.message ?? '';
  descendant = Number(message.split('CHILD_PID ')[1]);
  assert.ok(descendant > 0);
  assert.equal(alive(descendant), true);
  const parent = fx.child.status.pid;
  assert.ok(parent !== null);
  await fx.child.stop('disable');
  const deadline = Date.now() + 3_000;
  while (alive(descendant) && Date.now() < deadline) await sleep(20);
  assert.equal(alive(parent), false);
  assert.equal(alive(descendant), false, 'normal parent exit must not leave helper running');
});
