import assert from 'node:assert/strict';
import test from 'node:test';
import { PluginProcess, PluginRuntimeSupervisor } from '../src/plugin/runtime-process.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';
import { rmSync } from 'node:fs';

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
function options(root: string) {
  return {
    target: {id: 'cleanup-fixture', contentHash: 'a'.repeat(64), version: '1.0.0', apiVersion: 2,
      rootDir: root, dataDir: root, runtime: {type: 'node' as const, entry: 'unused.js'}, permissions: [], netAllow: [], config: {}},
    handlers: {onRequest: async () => null, onStderr: () => {}, onProtocolProblem: () => {}},
    timeouts: {activationMs: 80}, log: () => {}, onExit: () => {},
  };
}
const command = () => ({file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)']});

test('Windows taskkill 不在 PATH 时直接终止自己的子进程，激活仍有界失败', {skip: process.platform !== 'win32', timeout: 5000}, async () => {
  const root = tempDirSync('irmia-plugin-kill-fallback-');
  const plugin = new PluginProcess(options(root));
  (plugin as any).buildCommand = command;
  const before = process.env.PATH;
  let pid: number | null = null;
  try {
    process.env.PATH = root;
    const start = Date.now();
    const started = plugin.start(); pid = plugin.status.pid;
    await assert.rejects(started, /ready|超时|超过|启动/u);
    assert.ok(Date.now() - start < 1500);
    assert.equal(plugin.status.pid, null);
    assert.ok(pid !== null); assert.equal(alive(pid), false);
  } finally {
    if (before === undefined) delete process.env.PATH; else process.env.PATH = before;
    if (pid !== null && alive(pid)) process.kill(pid, 'SIGKILL');
    await plugin.stop('test'); rmSync(root, {recursive: true, force: true});
  }
});

test('无法终止时激活有界拒绝，保留 PID 并阻止同包重复启动', {timeout: 10_000}, async () => {
  const root = tempDirSync('irmia-plugin-unreaped-');
  const logs: string[] = [];
  const proto = PluginProcess.prototype as any;
  const originalCommand = proto.buildCommand, originalKill = proto.killNow;
  proto.buildCommand = command; proto.killNow = () => {};
  const supervisor = new PluginRuntimeSupervisor({timeouts: {activationMs: 80}, emit: () => {}, log: line => { logs.push(line); }});
  const config = options(root);
  let pid: number | null = null;
  try {
    const start = Date.now();
    const started = supervisor.start(config.target, config.handlers);
    pid = supervisor.status(config.target.id, config.target.contentHash)?.pid ?? null;
    await assert.rejects(started, /终止后仍未退出.*PID/);
    assert.ok(Date.now() - start < 3500);
    assert.ok(pid !== null); assert.equal(alive(pid), true);
    assert.equal(supervisor.status(config.target.id, config.target.contentHash)?.pid, pid);
    assert.ok(logs.some(line => line.includes(`PID ${pid}`)));
    await assert.rejects(supervisor.start(config.target, config.handlers), /未完成清理/);
    assert.equal(supervisor.status(config.target.id, config.target.contentHash)?.pid, pid);
    assert.equal(supervisor.status(config.target.id, config.target.contentHash)?.state, 'crashed');
  } finally {
    proto.buildCommand = originalCommand; proto.killNow = originalKill;
    if (pid !== null && alive(pid)) process.kill(pid, 'SIGKILL');
    await supervisor.stopAll('test'); rmSync(root, {recursive: true, force: true});
  }
});
