import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { emptyProjection } from '../src/log/types.ts';
import type { AgentLoopDeps } from '../src/runtime/agent-loop.ts';
import { healthcheckSubagentProfile } from '../src/runtime/subagent-health.ts';
import { SubagentManager } from '../src/runtime/subagent-manager.ts';
import {
  SubagentPackageInstaller, extractPackageArchive, hashTree, readRolePackageRecords, verifyRolePackage,
} from '../src/runtime/subagent-packages.ts';
import { BUILTIN_PROFILES, SubagentProfileRegistry } from '../src/runtime/subagent-profiles.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { okResult, type ToolDefinition } from '../src/tools/types.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const PERSONA = {identity: 'test', constitution: 'test', style: 'test', state: '', personaHash: 'hash'};
const MODEL_OK = {contextLimit: 1_000_000, reasoningEfforts: ['low', 'medium', 'high', 'max'] as const};

function tool(name: string): ToolDefinition {
  return {
    name, description: name, parameters: {type: 'object', properties: {}, additionalProperties: false},
    executionMode: 'parallel', sideEffect: 'none', timeoutMs: 1000, handler: async () => okResult('ok'),
  };
}

function temp(t: TestContext): string {
  const dir = tempDirSync('irmia-subagent-packages-');
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

test('P4.4 清单：所有来源固定 ref + sha256，角色 MCP/技能依赖完整且无 latest', () => {
  for (const profile of BUILTIN_PROFILES.filter((item) => item.id !== 'general')) {
    assert.ok(profile.install !== undefined && profile.install.length > 0, profile.id);
    for (const source of profile.install!) {
      assert.ok(source.ref && source.ref.length >= 3, `${profile.id} ref`);
      assert.match(source.sha256 ?? '', /^[a-f0-9]{64}$/u);
      assert.equal(source.source.includes('@latest'), false);
    }
  }
  assert.deepEqual(BUILTIN_PROFILES.find((item) => item.id === 'worker')?.mcpServers, [],
    'worker（coder+design 合并）不接 MCP');
  assert.deepEqual(BUILTIN_PROFILES.find((item) => item.id === 'scribe')?.mcpServers, [],
    'scribe（原 officer）不接 MCP');
  assert.equal(BUILTIN_PROFILES.some((item) => item.id === 'coder' || item.id === 'design'), false);
  const worker = BUILTIN_PROFILES.find((item) => item.id === 'worker')!;
  assert.equal(worker.install!.length, 8, 'worker 合并了 coder 的 4 个技能 + 4 个设计技能');
  assert.deepEqual(worker.requires?.pythonModules?.includes('tree_sitter'), true);
  // 外部设计 skill 已 vendor：必须有固定 commit ref + 真实 sha256，不能留占位。
  const vendored = ['ui-ux-pro-max', 'impeccable', 'motion-design'] as const;
  for (const id of vendored) {
    const source = worker.install!.find((item) => item.source.endsWith(`/${id}`))!;
    assert.notEqual(source.ref, 'pending-vendor', id);
    assert.match(source.ref, /^[a-f0-9]{40}$/u, `${id} 必须固定到 commit`);
    assert.match(source.sha256 ?? '', /^[a-f0-9]{64}$/u, id);
    assert.equal(/^0{64}$/u.test(source.sha256 ?? ''), false, `${id} 不能是占位 hash`);
    assert.ok((worker.requires?.skills ?? []).includes(id), `${id} 必须在 requires.skills 里（缺失即 locked）`);
  }
  const motion = worker.install!.find((item) => item.source.endsWith('/motion-design'))!;
  assert.equal(motion.ref, 'f9a8a041b85185ee4881b3471d3415e939aac772', 'motion-design 固定 commit');
  assert.equal(motion.sha256, '1b0700e2b0076b2efd86eb94d84f1bb67342e90a57ff58d9d7df04b06c3a3599', 'motion-design 归档 hash');
});

test('P4.5 tar 解包：Windows 真实归档在绝对路径/盘符下可用（不传 --force-local）', (t) => {
  const dir = temp(t);
  const source = join(dir, 'source', 'package');
  mkdirSync(source, {recursive: true});
  writeFileSync(join(source, 'SKILL.md'), 'packed-skill', 'utf8');
  mkdirSync(join(source, 'references'), {recursive: true});
  writeFileSync(join(source, 'references', 'rules.md'), 'packed-rules', 'utf8');
  const archive = join(dir, 'fixture.tgz');
  const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
  // 打包侧也要按平台判据：Windows bsdtar 不认 --force-local（这正是 P4 的阻塞缺陷）。
  const forceLocal = process.platform === 'win32' ? [] : ['--force-local'];
  const packed = spawnSync(tar, [
    ...forceLocal, '-czf', archive.replaceAll('\\', '/'),
    '-C', join(dir, 'source').replaceAll('\\', '/'), 'package',
  ], {shell: false, windowsHide: true});
  assert.equal(packed.status, 0, String(packed.stderr ?? ''));
  const target = join(dir, 'unpacked');
  extractPackageArchive(archive, target);
  assert.equal(readFileSync(join(target, 'package', 'SKILL.md'), 'utf8'), 'packed-skill');
  assert.equal(readFileSync(join(target, 'package', 'references', 'rules.md'), 'utf8'), 'packed-rules');
  // 幂等：同一归档解到已存在的目标目录也应成功。
  extractPackageArchive(archive, target);
  assert.equal(readFileSync(join(target, 'package', 'SKILL.md'), 'utf8'), 'packed-skill');
});

test('P4.4 真安装 researcher：解锁并运行；篡改包后 verify 重新锁定，general 不受影响', async (t) => {
  const dir = temp(t);
  const log = await EventLog.open(join(dir, 'events'));
  t.after(() => log.close());
  const registry = new ToolRegistry();
  for (const name of ['safe_read', 'read_blob', 'grep', 'find', 'safe_write', 'safe_edit', 'multi_edit',
    'http_get', 'http_post', 'http_download', 'web_search', 'report', 'delegate', 'subagent', 'task']) {
    registry.register(tool(name));
  }
  const config = defaultConfig(dir);
  config.subagents.enabled = true;
  let captured: AgentLoopDeps | null = null;
  const manager = new SubagentManager({
    dataDir: dir, log, registry, projection: emptyProjection(), persona: PERSONA, ds: {} as never,
    config: () => config, now: () => new Date().toISOString(), timezone: 'Asia/Shanghai',
    modelCapabilities: MODEL_OK,
    runTurnFn: (async (deps: AgentLoopDeps) => { captured = deps; return {kind: 'completed'}; }) as never,
  });
  await manager.start();
  await assert.rejects(manager.delegate({profileId: 'researcher', task: 'task'}, {callId: 'locked', turn: 1}), /profile-locked/u);
  const installed = await manager.installProfile('researcher');
  assert.equal(installed?.available, true);
  assert.deepEqual(installed?.missing, []);
  const record = readRolePackageRecords(dir).find((item) => item.id === 'researcher')!;
  assert.equal(verifyRolePackage(dir, record), true);
  assert.ok(existsSync(join(dir, 'subagents', 'packs', 'researcher', 'skills', 'auto-deep-research', 'SKILL.md')));

  const handle = await manager.delegate({profileId: 'researcher', task: 'task'}, {callId: 'ready', turn: 1});
  for (let i = 0; i < 100 && manager.status(handle.agentId)?.status !== 'completed'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(manager.status(handle.agentId)?.status, 'completed');
  assert.ok(captured!.registry.get('web_search'));
  assert.ok(captured!.registry.get('skill_read'));
  assert.notEqual(captured!.registry.get('pwsh'), null, 'researcher 的 shell:workspace 必须落成角色 pwsh');

  writeFileSync(join(dir, 'subagents', 'packs', 'researcher', 'skills', 'auto-deep-research', 'SKILL.md'), 'tampered', 'utf8');
  const locked = await manager.verifyProfile('researcher');
  assert.equal(locked?.locked, true);
  assert.deepEqual(locked?.missing, ['package-integrity']);
  await assert.rejects(manager.delegate({profileId: 'researcher', task: 'again'}, {callId: 'again', turn: 2}), /profile-locked/u);
  const general = await manager.delegate({task: 'general'}, {callId: 'general', turn: 2});
  assert.equal(general.profileId, 'general');
  for (let i = 0; i < 100 && manager.status(general.agentId)?.status !== 'completed'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(manager.status(general.agentId)?.status, 'completed');
  assert.equal(captured!.registry.get('pwsh'), null, 'general 的 shell:none 不接任何命令面');
});

test('P4.4 scribe 全内置来源：不依赖外部归档，安装后包可校验', async (t) => {
  const dir = temp(t);
  const installer = new SubagentPackageInstaller({
    dataDir: dir,
    fetchImpl: async () => {
      throw new Error('scribe 不应访问外部归档');
    },
  });
  const installed = await installer.install('scribe');
  assert.equal(installed.id, 'scribe');
  assert.equal(verifyRolePackage(dir, installed), true);
  assert.equal(readRolePackageRecords(dir).some((row) => row.profileId === 'coder' || row.profileId === 'design' || row.profileId === 'officer'), false);
});

test('P4.4 healthcheck：二进制、模型与 tools/list 分别决定 missing；MCP 总是关停', async (t) => {
  const dir = temp(t);
  mkdirSync(join(dir, 'subagents'), {recursive: true});
  const manifestSource = {source: 'skills/health-role', ref: 'v1', sha256: 'd'.repeat(64)};
  writeFileSync(join(dir, 'subagents', 'profiles.json'), JSON.stringify({profiles: [{
    id: 'health-role', label: '健康测试', tools: 'readonly', workspace: 'own',
    workdir: 'workspace', shell: 'none', skills: ['check-skill'], mcpServers: ['serena'],
    reasoningEffort: 'max', contextLimit: 1_000_000, compactAt: 0.7,
    requires: {skills: ['check-skill'], mcp: ['serena'], binaries: ['node']}, install: [manifestSource],
  }]}), 'utf8');
  const packRoot = join(dir, 'subagents', 'packs', 'health-role');
  const declarationDir = join(packRoot, 'mcp');
  mkdirSync(declarationDir, {recursive: true});
  writeFileSync(join(declarationDir, 'serena.json'), JSON.stringify({name: 'serena', command: 'uvx'}), 'utf8');
  const skillRoot = join(packRoot, 'skills', 'check-skill');
  mkdirSync(skillRoot, {recursive: true});
  writeFileSync(join(skillRoot, 'SKILL.md'), '---\nname: check-skill\ndescription: 健康检查脚本夹具\n---\n', 'utf8');
  writeFileSync(join(skillRoot, 'check.js'), 'process.stdout.write("ok");\n', 'utf8');
  writeFileSync(join(skillRoot, 'health.json'), JSON.stringify({scripts: [{command: 'node', path: 'check.js'}]}), 'utf8');
  writeFileSync(join(dir, 'subagents', 'role-packages.json'), JSON.stringify({installed: [{
    id: 'health-role', installedAt: '2026-11-05T00:00:00.000Z', packHash: hashTree(packRoot),
    sources: [{...manifestSource, id: 'health-role', kind: 'skill', license: 'AGPL-3.0-only'}],
  }]}), 'utf8');
  const profile = new SubagentProfileRegistry(dir).get('health-role')!;
  const registry = new SubagentProfileRegistry(dir);
  let closed = 0;
  const pool = {
    listTools: async () => [{name: 'find_symbol', inputSchema: {type: 'object'}}],
    callTool: async () => okResult('ok'),
    shutdown: async () => { closed += 1; },
  };
  const base = {
    dataDir: dir, ds: {} as never, modelCapabilities: MODEL_OK,
    binaryCheck: () => true, mcpPoolFactory: () => pool,
  };
  const healthy = await healthcheckSubagentProfile(profile, registry, base);
  assert.deepEqual(healthy, {available: true, locked: false, missing: []});
  assert.equal(closed, 1);
  const binaryMissing = await healthcheckSubagentProfile(profile, registry, {...base, binaryCheck: () => false});
  assert.deepEqual(binaryMissing.missing, ['node']);
  assert.equal(closed, 1, '二进制已缺时不再启动 MCP');
  const modelMissing = await healthcheckSubagentProfile(profile, registry, {
    ...base, modelCapabilities: {contextLimit: 100, reasoningEfforts: ['high']},
  });
  assert.deepEqual(modelMissing.missing, ['model:heavy']);
  assert.equal(closed, 1);
  const badPool = {...pool, listTools: async () => { throw new Error('offline'); }};
  const mcpMissing = await healthcheckSubagentProfile(profile, registry, {...base, mcpPoolFactory: () => badPool});
  assert.deepEqual(mcpMissing.missing, ['serena']);
  assert.equal(closed, 2, 'tools/list 失败仍关停本次池');
  writeFileSync(join(skillRoot, 'check.js'), 'process.exit(1);\n', 'utf8');
  const registryPath = join(dir, 'subagents', 'role-packages.json');
  const registered = JSON.parse(readFileSync(registryPath, 'utf8')) as {installed: Array<{packHash: string}>};
  registered.installed[0]!.packHash = hashTree(packRoot);
  writeFileSync(registryPath, JSON.stringify(registered), 'utf8');
  const scriptMissing = await healthcheckSubagentProfile(profile, registry, base);
  assert.deepEqual(scriptMissing.missing, ['check-skill']);
  assert.equal(closed, 2, '脚本失败时不再启动 MCP');
});
