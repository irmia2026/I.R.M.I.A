import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { HookRunner, type HookProcess, type HookTask } from '../src/hook/hooks.ts';
import { composePluginHooks, composePluginMcp, composePluginSkillRoots } from '../src/plugin/contributions.ts';
import type { PluginPackage } from '../src/plugin/package-store.ts';
import { SkillManager } from '../src/skill/skills.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

function plugin(id = 'demo') {
  const root = tempDirSync(`irmia-${id}-`);
  writeFileSync(join(root, 'plugin.json'), '{}');
  return {
    root,
    package: {
      rootDir: root,
      contentHash: 'a'.repeat(64),
      fileCount: 1,
      totalBytes: 2,
      manifest: { apiVersion: 1, id, version: '1.0.0', engine: { irmia: '>=0.1.0' }, contributions: { skills: ['skills'] }, permissions: [] },
    },
  };
}

function skill(root: string, name: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: A sufficiently descriptive plugin capability\n---\nBody`);
}

test('整包信任让插件 Skill 进入 catalog，内置 Skill 仍需独立确认', () => {
  const base = tempDirSync('irmia-builtins-');
  const { root, package: pkg } = plugin();
  skill(join(root, 'skills'), 'plugin-skill');
  skill(join(base, 'skills'), 'builtin-skill');
  const manager = new SkillManager({ baseRoot: base, rootNames: ['skills'], packageRoots: composePluginSkillRoots([pkg]) });
  assert.deepEqual(manager.catalog().entries.map((entry) => entry.name), ['plugin-skill']);
  assert.equal(manager.pending().some((entry) => entry.name === 'builtin-skill'), true);
  assert.equal(manager.pending().some((entry) => entry.name === 'plugin-skill'), false);
});

test('内置根优先于插件同名 Skill', () => {
  const base = tempDirSync('irmia-builtins-');
  const { root, package: pkg } = plugin();
  skill(join(root, 'skills'), 'shared');
  skill(join(base, 'skills'), 'shared');
  const manager = new SkillManager({ baseRoot: base, rootNames: ['skills'], packageRoots: composePluginSkillRoots([pkg]) });
  manager.confirm('shared');
  assert.equal(manager.catalog().entries[0]?.skillPath, 'skills/shared/SKILL.md');
  assert.match(manager.catalog().warnings.join('\n'), /同名/);
});

test('插件 Hook 默认包 cwd，相对 cwd 不可逃逸，运行时使用条目 cwd', async () => {
  const { root, package: pkg } = plugin();
  writeFileSync(join(root, 'hooks.json'), JSON.stringify([
    { hook: 'Wake', matcher: 'manual', command: 'node hook.mjs' },
    { hook: 'Wake', matcher: 'timer', command: 'node hook.mjs', cwd: 'nested' },
    { hook: 'Wake', matcher: 'manual', command: 'node escape.mjs', cwd: '../outside' },
  ]));
  pkg.manifest = { ...pkg.manifest, contributions: { skills: [], hooks: 'hooks.json' } };
  const composed = composePluginHooks([pkg]);
  assert.equal(composed.entries[0]?.cwd, root);
  assert.equal(composed.entries[1]?.cwd, join(root, 'nested'));
  assert.equal(composed.entries.length, 2);
  assert.match(composed.warnings.join('\n'), /escapes|outside|cwd/i);
  const tasks: HookTask[] = [];
  const runner = new HookRunner({
    entries: composed.entries.slice(1),
    cwd: tempDirSync('irmia-runner-default-'),
    spawn: (task) => {
      tasks.push(task);
      const close: ((code: number | null) => void)[] = [];
      const process: HookProcess = {
        onStdout: () => {}, onStderr: () => {}, onClose: (handler) => close.push(handler),
        write: () => {}, endInput: () => close.forEach((handler) => handler(0)), kill: () => {},
      };
      return process;
    },
  });
  await runner.wake({ text: '', sources: ['timer'], turn: 1 });
  assert.equal(tasks[0]?.cwd, join(root, 'nested'));
});

test('enabled: false 的 Hook 条目不装配，全停用的插件不贡献任何 Hook', () => {
  const { root, package: pkg } = plugin();
  writeFileSync(join(root, 'hooks.json'), JSON.stringify([
    { hook: 'Wake', matcher: 'manual', command: 'node on.mjs' },
    { hook: 'Wake', matcher: 'timer', command: 'node off.mjs', enabled: false },
  ]));
  pkg.manifest = { ...pkg.manifest, contributions: { skills: [], hooks: 'hooks.json' } };
  const mixed = composePluginHooks([pkg]);
  assert.deepEqual(mixed.entries.map((entry) => entry.plugin?.contributionName), ['Wake:manual#0']);
  assert.deepEqual(mixed.warnings, []);

  // 一个插件的钩子全停用时，它贡献 0 条：既不留空壳，也不算配置错误
  writeFileSync(join(root, 'hooks.json'), JSON.stringify([
    { hook: 'Wake', matcher: 'manual', command: 'node on.mjs', enabled: false },
    { hook: 'PreToolUse', matcher: '.*', command: 'node off.mjs', enabled: false },
  ]));
  const allOff = composePluginHooks([pkg]);
  assert.deepEqual(allOff.entries, []);
  assert.deepEqual(allOff.warnings, []);
});

test('停用的 Hook 条目一次进程都不起', async () => {
  const { root, package: pkg } = plugin();
  writeFileSync(join(root, 'hooks.json'), JSON.stringify([
    { hook: 'Wake', matcher: 'manual', command: 'node on.mjs' },
    { hook: 'Wake', matcher: 'manual', command: 'node off.mjs', enabled: false },
  ]));
  pkg.manifest = { ...pkg.manifest, contributions: { skills: [], hooks: 'hooks.json' } };
  const tasks: HookTask[] = [];
  const runner = new HookRunner({
    entries: composePluginHooks([pkg]).entries,
    cwd: root,
    spawn: (task) => {
      tasks.push(task);
      const close: ((code: number | null) => void)[] = [];
      const process: HookProcess = {
        onStdout: () => {}, onStderr: () => {}, onClose: (handler) => close.push(handler),
        write: () => {}, endInput: () => close.forEach((handler) => handler(0)), kill: () => {},
      };
      return process;
    },
  });
  await runner.wake({ text: '', sources: ['manual'], turn: 1 });
  assert.deepEqual(tasks.map((task) => task.command), ['node on.mjs']);
});

test('插件显式声明的 Hook 文件缺失时给出 warning，而不是静默消失', () => {
  const { package: pkg } = plugin();
  pkg.manifest = { ...pkg.manifest, contributions: { skills: [], hooks: 'hooks.json' } };
  const composed = composePluginHooks([pkg]);
  assert.deepEqual(composed.entries, []);
  assert.equal(composed.warnings.length, 1);
  assert.match(composed.warnings[0] ?? '', /hooks[.]json/);
  assert.match(composed.warnings[0] ?? '', /不存在|不可读/);

  // 对照：MCP 声明文件缺失早就有 warning，这条既有行为不该退化
  pkg.manifest = { ...pkg.manifest, contributions: { skills: [], mcp: 'mcp.json' } };
  assert.equal(composePluginMcp([pkg], []).warnings.length, 1);
});

test('MCP 名称命名空间化、保留属性并默认包 cwd', () => {
  const { root, package: pkg } = plugin();
  writeFileSync(join(root, 'mcp.json'), JSON.stringify([{ name: 'chat', command: process.execPath, args: ['server.mjs'], tools: { recall: { sideEffect: 'none' } } }]));
  pkg.manifest = { ...pkg.manifest, contributions: { skills: [], mcp: 'mcp.json' } };
  const composed = composePluginMcp([pkg], []);
  assert.equal(composed.servers[0]?.name, 'demo__chat');
  assert.equal(composed.servers[0]?.cwd, root);
  assert.deepEqual(composed.servers[0]?.args, ['server.mjs']);
  assert.equal(composed.servers[0]?.tools?.recall?.sideEffect, 'none');
});

test('MCP launcher 校验、超长名与碰撞均显式拒绝', () => {
  const { root, package: pkg } = plugin();
  writeFileSync(join(root, 'mcp.json'), JSON.stringify([
    { name: 'unsafe', command: 'definitely-not-a-allowed-launcher' },
    { name: 'same', command: process.execPath },
    { name: 'same', command: process.execPath },
    { name: 'x'.repeat(128), command: process.execPath },
  ]));
  pkg.manifest = { ...pkg.manifest, contributions: { skills: [], mcp: 'mcp.json' } };
  const composed = composePluginMcp([pkg], []);
  assert.equal(composed.servers.length, 1);
  assert.equal(composed.servers[0]?.name, 'demo__same');
  assert.match(composed.warnings.join('\n'), /unsafe|launcher|command/i);
  assert.match(composed.warnings.join('\n'), /duplicate|collision|同名|冲突/i);
  assert.match(composed.warnings.join('\n'), /128|long|长度/i);
});
