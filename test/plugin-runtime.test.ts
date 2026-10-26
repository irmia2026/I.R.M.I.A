import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import type { AppEvent } from '../src/log/types.ts';
import { HookRunner } from '../src/hook/hooks.ts';
import type { PluginFailure } from '../src/plugin/failures.ts';
import { PluginCircuitBreaker } from '../src/plugin/circuit-breaker.ts';
import { PluginManager } from '../src/plugin/manager.ts';
import { composePluginRuntime, mapPluginMcpOwners, mergeMcpDeclarations, pluginCompositionRevision, pluginProtectedPaths } from '../src/plugin/runtime.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

function enabledPlugin() {
  const dataDir = tempDirSync('irmia-runtime-data-');
  const source = tempDirSync('irmia-runtime-source-');
  mkdirSync(join(source, 'skills', 'companion'), { recursive: true });
  writeFileSync(join(source, 'skills', 'companion', 'SKILL.md'), '---\nname: companion\ndescription: Companion behavior supplied by a package\n---\nBody');
  writeFileSync(join(source, 'hooks.json'), JSON.stringify([{ hook: 'Wake', matcher: 'manual', command: 'node hook.mjs' }]));
  writeFileSync(join(source, 'mcp.json'), JSON.stringify([{ name: 'chat', command: process.execPath, args: ['server.mjs'] }]));
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({ apiVersion: 1, id: 'demo', version: '1.0.0', engine: { irmia: '>=0.1.0-beta.12' }, contributions: { skills: ['skills'], hooks: 'hooks.json', mcp: 'mcp.json' }, permissions: [] }));
  const events: AppEvent[] = [];
  const manager = new PluginManager(dataDir, (type, data) => events.push({ seq: events.length + 1, ts: new Date(0).toISOString(), type, data, visibility: 'internal' } as AppEvent));
  const installed = manager.install(source);
  manager.confirm(installed.manifest.id, installed.contentHash);
  manager.setEnabled(installed.manifest.id, installed.contentHash, true);
  manager.setEvents(events);
  return { manager, dataDir };
}

test('内置为空时组合保持不变，启用插件提供三类贡献', () => {
  const empty = composePluginRuntime(new PluginManager(tempDirSync('irmia-empty-')), []);
  assert.deepEqual(empty, { packages: [], revision: pluginCompositionRevision([]), skillRoots: [], hookEntries: [], mcpServers: [], warnings: [] });
  const { manager } = enabledPlugin();
  const composed = composePluginRuntime(manager, []);
  assert.equal(composed.packages.length, 1);
  assert.equal(composed.skillRoots.length, 1);
  assert.equal(composed.hookEntries.length, 1);
  assert.equal(composed.mcpServers[0]?.name, 'demo__chat');
});

test('未确认或人工待启用的包不进入启动组合', () => {
  const dataDir = tempDirSync('irmia-runtime-data-');
  const source = tempDirSync('irmia-runtime-source-');
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({ apiVersion: 1, id: 'demo', version: '1.0.0', engine: { irmia: '>=0.1.0-beta.12' }, contributions: { skills: [] }, permissions: [] }));
  const manager = new PluginManager(dataDir);
  const installed = manager.install(source);
  assert.equal(composePluginRuntime(manager, []).packages.length, 0);
  manager.confirm(installed.manifest.id, installed.contentHash);
  manager.setEnabled(installed.manifest.id, installed.contentHash, true);
  assert.equal(composePluginRuntime(manager, []).packages.length, 0);
});

test('内置与插件 MCP 合并稳定，重名显式拒绝且不覆盖', () => {
  const builtin = [{ name: 'shared', command: process.execPath }];
  const plugin = [{ name: 'demo__chat', command: process.execPath }];
  assert.deepEqual(mergeMcpDeclarations(builtin, plugin).map((entry) => entry.name), ['shared', 'demo__chat']);
  const changed = [{ name: 'new-built-in', command: process.execPath }];
  assert.deepEqual(mergeMcpDeclarations(changed, plugin).map((entry) => entry.name), ['new-built-in', 'demo__chat']);
  assert.throws(() => mergeMcpDeclarations(builtin, [{ name: 'shared', command: process.execPath }]), /duplicate|collision|冲突/i);
});

test('MCP 名称与内置声明冲突时不把内置 server 归给插件', () => {
  const { manager } = enabledPlugin();
  const pkg = manager.active()[0]!;
  assert.equal(mapPluginMcpOwners([], [pkg]).get('demo__chat')?.pluginId, 'demo');
  assert.equal(mapPluginMcpOwners([{ name: 'demo__chat', command: process.execPath }], [pkg]).size, 0);
});

test('半开 Hook 只执行失败 Hook，并由它的成功恢复插件', async () => {
  const dataDir = tempDirSync('irmia-probe-hooks-data-');
  const source = tempDirSync('irmia-probe-hooks-source-');
  const healthyMarker = join(source, 'healthy-ran');
  const brokenMarker = join(source, 'broken-ran');
  const writeMarkerScript = (marker: string): string => {
    const script = join(source, `${marker.endsWith('healthy-ran') ? 'healthy' : 'broken'}.mjs`);
    writeFileSync(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    return script;
  };
  const healthyScript = writeMarkerScript(healthyMarker);
  const brokenScript = writeMarkerScript(brokenMarker);
  const command = (script: string): string => `"${process.execPath}" "${script}"`;
  writeFileSync(join(source, 'hooks.json'), JSON.stringify([
    { hook: 'PreToolUse', matcher: '.*', command: command(healthyScript), timeoutMs: 2000 },
    { hook: 'PreToolUse', matcher: 'Echo', command: command(brokenScript), timeoutMs: 2000 },
  ]));
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({ apiVersion: 1, id: 'demo', version: '1.0.0', engine: { irmia: '>=0.1.0-beta.12' }, contributions: { skills: [], hooks: 'hooks.json' }, permissions: [] }));
  const manager = new PluginManager(dataDir);
  const installed = manager.install(source);
  manager.confirm('demo', installed.contentHash);
  manager.setEnabled('demo', installed.contentHash, true);
  manager.quarantine({ pluginId: 'demo', contentHash: installed.contentHash, contributionKind: 'hook', contributionName: 'PreToolUse:Echo#1', category: 'hook-error', message: 'broken' }, 3, new Date(0).toISOString(), new Date(0).toISOString());
  assert.equal(manager.beginProbe('demo', installed.contentHash, new Date().toISOString()), true);
  const composed = composePluginRuntime(manager, []);
  assert.deepEqual(composed.hookEntries.map((entry) => entry.plugin?.contributionName), ['PreToolUse:Echo#1']);

  let breaker: PluginCircuitBreaker;
  const runner = new HookRunner({
    entries: composed.hookEntries,

    emit: (event) => {
      assert.equal(event.contributionName, 'PreToolUse:Echo#1');
      const failure: PluginFailure = { pluginId: event.pluginId!, contentHash: event.contentHash!,
        contributionKind: 'hook', contributionName: event.contributionName!, category: 'hook-error', message: '' };
      if (event.outcome === 'ok') breaker.noteSuccess(failure);
      else breaker.noteFailure(failure);
    },
  });
  breaker = new PluginCircuitBreaker({ manager, now: () => Date.now(), apply: async () => {}, probe: async () => {} });
  await runner.beforeToolCall({ callId: 'probe', tool: 'Echo', input: {}, turn: 1, step: 1 });
  assert.equal(existsSync(brokenMarker), true);
  assert.equal(existsSync(healthyMarker), false);
  assert.equal(manager.list()[0]?.state, 'enabled');
});

test('Hook-only 半开只恢复真实 Hook，不提前恢复 Skill 和 MCP', () => {
  const dataDir = tempDirSync('irmia-probe-runtime-data-');
  const source = tempDirSync('irmia-probe-runtime-source-');
  mkdirSync(join(source, 'skills', 'companion'), { recursive: true });
  writeFileSync(join(source, 'skills', 'companion', 'SKILL.md'), '---\nname: companion\ndescription: probe\n---\nBody');
  writeFileSync(join(source, 'hooks.json'), JSON.stringify([{ hook: 'Wake', matcher: 'manual', command: 'node hook.mjs' }]));
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({ apiVersion: 1, id: 'demo', version: '1.0.0', engine: { irmia: '>=0.1.0-beta.12' }, contributions: { skills: ['skills'], hooks: 'hooks.json' }, permissions: [] }));
  const manager = new PluginManager(dataDir);
  const installed = manager.install(source);
  manager.confirm('demo', installed.contentHash);
  manager.setEnabled('demo', installed.contentHash, true);
  manager.quarantine({ pluginId: 'demo', contentHash: installed.contentHash, contributionKind: 'hook', contributionName: 'Wake:manual#0', category: 'hook-error', message: 'broken' }, 3, new Date(0).toISOString(), new Date(0).toISOString());
  assert.equal(manager.beginProbe('demo', installed.contentHash, new Date().toISOString()), true);
  const composed = composePluginRuntime(manager, []);
  assert.equal(composed.packages.length, 0);
  assert.equal(composed.skillRoots.length, 0);
  assert.equal(composed.mcpServers.length, 0);
  assert.equal(composed.hookEntries.length, 1);
  assert.equal(composed.hookEntries[0]?.plugin?.contentHash, installed.contentHash);
});

test('同一 matcher 的两条 Hook 身份互不相同：探针只跑失败那条，健康条目的成功不能恢复整包', async () => {
  const dataDir = tempDirSync('irmia-probe-identity-data-');
  const source = tempDirSync('irmia-probe-identity-source-');
  const healthyMarker = join(source, 'healthy-ran');
  const brokenMarker = join(source, 'broken-ran');
  // 两条**同 matcher**：0 号健康（退出 0）、1 号失败（退出 1）。旧身份（hook:matcher）下
  // 它们会撞成同一条，于是 0 号的一次成功就能把 1 号判下的隔离抹掉。
  const writeScript = (name: string, marker: string, exitCode: number): string => {
    const script = join(source, `${name}.mjs`);
    writeFileSync(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nprocess.exitCode = ${exitCode};\n`);
    return script;
  };
  const command = (script: string): string => `"${process.execPath}" "${script}"`;
  writeFileSync(join(source, 'hooks.json'), JSON.stringify([
    { hook: 'PreToolUse', matcher: 'Echo', command: command(writeScript('healthy', healthyMarker, 0)), timeoutMs: 5000 },
    { hook: 'PreToolUse', matcher: 'Echo', command: command(writeScript('broken', brokenMarker, 1)), timeoutMs: 5000 },
  ]));
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({ apiVersion: 1, id: 'demo', version: '1.0.0', engine: { irmia: '>=0.1.0-beta.12' }, contributions: { skills: [], hooks: 'hooks.json' }, permissions: [] }));
  const manager = new PluginManager(dataDir);
  const installed = manager.install(source);
  manager.confirm('demo', installed.contentHash);
  manager.setEnabled('demo', installed.contentHash, true);
  const failure = (contributionName: string): PluginFailure => ({ pluginId: 'demo', contentHash: installed.contentHash,
    contributionKind: 'hook', contributionName, category: 'hook-error', message: 'broken' });
  manager.quarantine(failure('PreToolUse:Echo#1'), 3, new Date(0).toISOString(), new Date(0).toISOString());
  assert.equal(manager.beginProbe('demo', installed.contentHash, new Date().toISOString()), true);

  const composed = composePluginRuntime(manager, []);
  assert.deepEqual(composed.hookEntries.map((entry) => entry.plugin?.contributionName), ['PreToolUse:Echo#1']);

  const breaker = new PluginCircuitBreaker({ manager, now: () => Date.now(), apply: async () => {}, probe: async () => {} });
  // 0 号是健康条目：它成功属于「另一条贡献」，绝不能把 1 号的隔离状态抹掉
  breaker.noteSuccess(failure('PreToolUse:Echo#0'));
  assert.equal(manager.list()[0]?.state, 'probing');

  const runner = new HookRunner({
    entries: composed.hookEntries,
    emit: (event) => {
      // 方法要绑着 breaker 调：解构出来调用会丢 this，而 HookRunner 会吞掉 emit 里的异常
      const recorded = failure(event.contributionName!);
      if (event.outcome === 'ok') breaker.noteSuccess(recorded);
      else breaker.noteFailure(recorded);
    },
  });
  await runner.beforeToolCall({ callId: 'probe', tool: 'Echo', input: {}, turn: 1, step: 1 });
  assert.equal(existsSync(brokenMarker), true, '探针必须真的执行失败的那一条');
  assert.equal(existsSync(healthyMarker), false, '同 matcher 的健康条目不在探针里，一次进程都不该起');
  assert.equal(manager.list()[0]?.state, 'quarantined', '探针失败后必须留在隔离态，不能被健康条目的成功「恢复」');
});

test('插件包存储根进入受保护路径', () => {
  const dataDir = tempDirSync('irmia-protected-');
  assert.deepEqual(pluginProtectedPaths(dataDir), [join(dataDir, 'plugins', 'packages')]);
});
