/**
 * worker 的本地 codegraph 工具（`code`）测试。
 *
 * 四组：
 *   ① 工具装配（只给 worker；没有 projectRoot 不注入；schema 五个 action）；
 *   ② 参数/边界错误（越界 projectDir、缺 query、impact 空 filepaths、pack 非法 mode）——
 *      全部在 spawn 之前拒绝；
 *   ③ 真 Python 端到端：index → explore / trace / pack / impact / status / incremental，
 *      DB 只落 session workspace、项目内不留文件；本机缺 Python 模块时如实 skip；
 *   ④ manager 接线：worker 有 projectRoot ⇒ `code` 注入且可调用；worker 无 projectRoot ⇒
 *      退回 workspace 且不注入 `code`；非 worker 一律没有 `code`；
 *      healthcheck：requires.pythonModules 缺失 ⇒ locked + missing。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { emptyProjection } from '../src/log/types.ts';
import type { AgentLoopDeps } from '../src/runtime/agent-loop.ts';
import { createCodeTool, resolveCodeCliPath, type CodeCliInput, type CodeCliRunner } from '../src/runtime/subagent-code.ts';
import { healthcheckSubagentProfile } from '../src/runtime/subagent-health.ts';
import { SubagentManager } from '../src/runtime/subagent-manager.ts';
import { hashTree } from '../src/runtime/subagent-packages.ts';
import {
  BUILTIN_PROFILES, SubagentProfileRegistry, WORKER_PYTHON_MODULES,
} from '../src/runtime/subagent-profiles.ts';
import { probePythonModules, resetPythonBinaryCache } from '../src/runtime/python-probe.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { okResult, type ToolContext, type ToolDefinition } from '../src/tools/types.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const PERSONA = {identity: 'test', constitution: 'test', style: 'test', state: '', personaHash: 'hash'};
const CTX = {
  callId: 'call', turn: 1, step: 1, signal: new AbortController().signal, workspaceRoot: '',
} as ToolContext;
const MODEL_OK = {contextLimit: 1_000_000, reasoningEfforts: ['low', 'medium', 'high', 'max'] as const};

function temp(t: TestContext): string {
  const dir = tempDirSync('irmia-subagent-code-');
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function parentTool(name: string): ToolDefinition {
  return {
    name, description: name, parameters: {type: 'object', properties: {}, additionalProperties: false},
    executionMode: 'parallel', sideEffect: 'none', timeoutMs: 1000, handler: async () => okResult('ok'),
  };
}

const WORKER = BUILTIN_PROFILES.find((profile) => profile.id === 'worker')!;

/**
 * 让 worker 在 healthcheck 里变成 available 的最小数据目录：
 *   · 空 packs/worker（hashTree 有确定值）+ 与 Profile install 清单一致的记录；
 *   · 5 个技能用最小 SKILL.md 满足（不复制 2MB 的 design-taste-frontend 真包）；
 *   · Python 模块/二进制/模型都由调用方注入真值，避免测试依赖本机环境。
 */
function installFakeWorker(dataDir: string): void {
  const packRoot = join(dataDir, 'subagents', 'packs', 'worker');
  mkdirSync(packRoot, {recursive: true});
  const record = {
    id: 'worker',
    installedAt: '2026-11-05T00:00:00.000Z',
    packHash: hashTree(packRoot),
    sources: WORKER.install!.map((source) => ({
      ...source, id: 'fake', kind: 'skill', license: 'AGPL-3.0-only',
    })),
  };
  mkdirSync(join(dataDir, 'subagents'), {recursive: true});
  writeFileSync(join(dataDir, 'subagents', 'role-packages.json'),
    JSON.stringify({schema: 1, installed: [record]}), 'utf8');
  for (const id of WORKER.skills) {
    const root = join(dataDir, 'skills', id);
    mkdirSync(root, {recursive: true});
    writeFileSync(join(root, 'SKILL.md'), `---\nname: ${id}\ndescription: ${id} fixture\n---\n${id}\n`, 'utf8');
  }
}

function fakeProject(t: TestContext): {root: string; project: string; workspace: string} {
  const root = temp(t);
  const project = join(root, 'project');
  const workspace = join(root, 'workspace');
  mkdirSync(project, {recursive: true});
  mkdirSync(workspace, {recursive: true});
  return {root, project, workspace};
}

function fakeRunner(calls: CodeCliInput[], result?: Partial<Awaited<ReturnType<CodeCliRunner>>>): CodeCliRunner {
  return async (input) => {
    calls.push(input);
    return {code: 0, stdout: JSON.stringify({ok: true, summary: 'fake'}), stderr: '', aborted: false, timedOut: false, ...result};
  };
}

// ── ① 装配与 schema ─────────────────────────────────────

test('code 工具只给 worker：非 worker 与没有 projectRoot 都不注入', (t) => {
  const {project, workspace} = fakeProject(t);
  assert.equal(createCodeTool({profileId: 'researcher', workspace, projectRoot: project, agentId: 'a'}), null);
  assert.equal(createCodeTool({profileId: 'general', workspace, projectRoot: project, agentId: 'a'}), null);
  assert.equal(createCodeTool({profileId: 'worker', workspace, agentId: 'a'}), null, '没有项目根就没有可索引的东西');
  const tool = createCodeTool({profileId: 'worker', workspace, projectRoot: project, agentId: 'a'});
  assert.notEqual(tool, null);
  assert.equal(tool!.name, 'code');
  assert.equal(tool!.sideEffect, 'idempotent', '只写自己 workspace 的索引，不标 destructive');
  const properties = (tool!.parameters as {properties: Record<string, {enum?: string[]}>}).properties;
  assert.deepEqual(properties['action']?.enum, ['index', 'explore', 'impact', 'pack', 'status']);
  assert.deepEqual(properties['mode']?.enum, ['callers', 'callees', 'both']);
  assert.equal(properties['incremental'] !== undefined, true);
});

test('code_cli.py 路径解析：**唯一权威路径 = 应用根 packs**（没有 dist/packs 双路径），不依赖 cwd', () => {
  const resolved = resolveCodeCliPath();
  assert.notEqual(resolved.path, null, 'dev 仓库里应当能找到脚本');
  assert.match(resolved.path!, /[\\/]packs[\\/]subagents[\\/]tools[\\/]codegraph[\\/]code_cli\.py$/u);
  const applicationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  assert.equal(resolved.path, resolve(applicationRoot, 'packs/subagents/tools/codegraph/code_cli.py'),
    '开发/安装两种布局都只从应用根 packs/ 解析（装配链把 packs/ 整棵拷到包根）');
  assert.equal(resolved.candidates.some((path) => /[\\/]dist[\\/]packs[\\/]/u.test(path)), false,
    'dist/packs 是已删除的重复解析路径：包内同一份资源只允许有一个根');
});

// ── ② 参数与边界（不 spawn） ────────────────────────────

test('code 参数/边界错误：越界 projectDir、缺 query、impact 空 filepaths、非法 mode 均在 spawn 前拒绝', async (t) => {
  const {root, project, workspace} = fakeProject(t);
  const calls: CodeCliInput[] = [];
  const tool = createCodeTool({
    profileId: 'worker', workspace, projectRoot: project, agentId: 'a',
    cliPath: resolveCodeCliPath().path!, pythonPath: 'python', runner: fakeRunner(calls),
  })!;
  const outside = join(root, 'outside');
  mkdirSync(outside, {recursive: true});
  const denied = await tool.handler({action: 'status', projectDir: outside}, CTX);
  assert.equal(denied.isError, true);
  assert.equal(denied.error?.code, 'E_UNSAFE_PATH');
  const traversal = await tool.handler({action: 'status', projectDir: '../outside'}, CTX);
  assert.equal(traversal.error?.code, 'E_UNSAFE_PATH');
  assert.equal(calls.length, 0, '边界判定必须在 spawn 前完成');

  const missingQuery = await tool.handler({action: 'explore'}, CTX);
  assert.equal(missingQuery.error?.code, 'E_INVALID_ARGS');
  const emptyImpact = await tool.handler({action: 'impact', filepaths: []}, CTX);
  assert.equal(emptyImpact.error?.code, 'E_INVALID_ARGS');
  const badMode = await tool.handler({action: 'pack', target: 'x', mode: 'sideways'}, CTX);
  assert.equal(badMode.error?.code, 'E_INVALID_ARGS');
  const badAction = await tool.handler({action: 'index_all'}, CTX);
  assert.equal(badAction.error?.code, 'E_INVALID_ARGS');
  assert.equal(calls.length, 0);

  // 子目录与相对路径是允许的（只禁越界，不禁项目内导航）。
  const ok = await tool.handler({action: 'status', projectDir: '.'}, CTX);
  assert.equal(ok.isError, undefined, ok.content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.cwd, realpathSync.native(resolve(workspace)), '子进程 cwd 固定在 session workspace');
  assert.equal(calls[0]?.env['PYTHONIOENCODING'], 'utf-8');
});

test('code 请求协议：action 参数经 stdin 传给 CLI；index 与查询用不同超时', async (t) => {
  const {project, workspace} = fakeProject(t);
  const calls: CodeCliInput[] = [];
  const tool = createCodeTool({
    profileId: 'worker', workspace, projectRoot: project, agentId: 'a',
    cliPath: resolveCodeCliPath().path!, pythonPath: 'python', runner: fakeRunner(calls),
    timeoutOverrides: {index: 4321},
  })!;
  await tool.handler({action: 'index', incremental: true}, CTX);
  await tool.handler({action: 'pack', target: 'Greeter.greet', depth: 1, mode: 'callers'}, CTX);
  await tool.handler({action: 'impact', filepaths: ['app/util.py'], maxDepth: 2}, CTX);
  assert.equal(calls.length, 3);
  const indexReq = JSON.parse(calls[0]!.stdin) as Record<string, unknown>;
  assert.deepEqual(indexReq, {
    action: 'index', projectDir: realpathSync.native(resolve(project)),
    dbPath: join(realpathSync.native(resolve(workspace)), '.codegraph', 'codegraph.db'),
    workspaceRoot: realpathSync.native(resolve(workspace)),
    allowedRoot: realpathSync.native(resolve(project)), incremental: true,
  });
  assert.equal(calls[0]!.timeoutMs, 4321);
  const packReq = JSON.parse(calls[1]!.stdin) as Record<string, unknown>;
  assert.deepEqual([packReq['target'], packReq['depth'], packReq['mode']], ['Greeter.greet', 1, 'callers']);
  const impactReq = JSON.parse(calls[2]!.stdin) as Record<string, unknown>;
  assert.deepEqual(impactReq['filepaths'], ['app/util.py']);
  assert.equal(impactReq['maxDepth'], 2);
  assert.equal(calls[1]!.timeoutMs, 120_000, '查询动作默认 120s（测试未覆盖）');
});

test('code 执行失败面：超时/取消/spawn 失败/业务错误都返回明确结构化错误', async (t) => {
  const {project, workspace} = fakeProject(t);
  const cases: Array<{result: Partial<Awaited<ReturnType<CodeCliRunner>>>; code: string}> = [
    {result: {code: null, timedOut: true}, code: 'E_TIMEOUT'},
    {result: {code: null, aborted: true}, code: 'E_ABORTED'},
    {result: {code: null, spawnError: 'ENOENT'}, code: 'E_SPAWN_FAILED'},
  ];
  for (const row of cases) {
    const calls: CodeCliInput[] = [];
    const tool = createCodeTool({
      profileId: 'worker', workspace, projectRoot: project, agentId: 'a',
      cliPath: resolveCodeCliPath().path!, pythonPath: 'python', runner: fakeRunner(calls, row.result),
    })!;
    const result = await tool.handler({action: 'status'}, CTX);
    assert.equal(result.isError, true, row.code);
    assert.equal(result.error?.code, row.code);
  }
  const businessCalls: CodeCliInput[] = [];
  const business = createCodeTool({
    profileId: 'worker', workspace, projectRoot: project, agentId: 'a',
    cliPath: resolveCodeCliPath().path!, pythonPath: 'python',
    runner: fakeRunner(businessCalls, {
      stdout: JSON.stringify({ok: false, error_code: 'no_index', error: 'no_index', proposal: '先 index'}),
    }),
  })!;
  const noIndex = await business.handler({action: 'explore', query: 'format_name'}, CTX);
  assert.equal(noIndex.error?.code, 'no_index');
  assert.match(noIndex.content, /先 index/u);
});

// ── ③ 真 Python 端到端 ──────────────────────────────────

function writeFixtureProject(project: string): void {
  mkdirSync(join(project, 'app'), {recursive: true});
  writeFileSync(join(project, 'app', '__init__.py'), '', 'utf8');
  writeFileSync(join(project, 'app', 'util.py'),
    'def format_name(name):\n    return name.strip().title()\n', 'utf8');
  writeFileSync(join(project, 'app', 'service.py'), [
    'from app.util import format_name',
    '',
    'class Greeter:',
    '    def greet(self, name):',
    '        return format_name(name)',
    '',
    'def build_greeter():',
    '    return Greeter()',
    '',
    'def main():',
    "    return build_greeter().greet('x')",
    '',
  ].join('\n'), 'utf8');
  mkdirSync(join(project, 'web'), {recursive: true});
  writeFileSync(join(project, 'web', 'widget.ts'), [
    'export function helper(x: number): number {',
    '  return x + 1;',
    '}',
    '',
    'export class Widget {',
    '  render(): string {',
    '    return String(helper(2));',
    '  }',
    '}',
    '',
  ].join('\n'), 'utf8');
  mkdirSync(join(project, 'lib'), {recursive: true});
  writeFileSync(join(project, 'lib', 'main.dart'), 'void main() {}\n', 'utf8');
}

function pythonReady(): boolean {
  resetPythonBinaryCache();
  return probePythonModules(WORKER_PYTHON_MODULES).length === 0;
}

function parseToolContent(result: {content: string}): Record<string, unknown> {
  return JSON.parse(result.content) as Record<string, unknown>;
}

test('codegraph 真索引：index/explore/pack/impact/status + 增量 + 越界', async (t) => {
  if (!pythonReady()) {
    t.skip('本机缺 Python 或 tree-sitter 模块，跳过真索引用例（healthcheck 已单独覆盖缺失路径）');
    return;
  }
  const {root, project, workspace} = fakeProject(t);
  writeFixtureProject(project);
  const tool = createCodeTool({profileId: 'worker', workspace, projectRoot: project, agentId: 'a'})!;
  const dbPath = join(workspace, '.codegraph', 'codegraph.db');

  // ① 越界在执行前被拒，且不创建 DB
  const outside = join(root, 'outside');
  mkdirSync(outside, {recursive: true});
  const denied = await tool.handler({action: 'status', projectDir: outside}, CTX);
  assert.equal(denied.error?.code, 'E_UNSAFE_PATH');
  assert.equal(existsSync(dbPath), false);

  // ② index
  const indexed = await tool.handler({action: 'index'}, CTX);
  assert.equal(indexed.isError, undefined, indexed.content);
  const indexPayload = parseToolContent(indexed);
  assert.equal(indexPayload['ok'], true);
  assert.equal(indexPayload['languages'] !== undefined, true);
  assert.ok(existsSync(dbPath), 'DB 落在 session workspace');
  assert.equal(existsSync(join(project, '.codegraph')), false, '项目内不留索引文件');
  const unsupported = indexPayload['unsupported_suffixes'] as Record<string, number> | undefined;
  assert.ok((unsupported?.['.dart'] ?? 0) >= 1, 'Dart 不假装支持，index 如实计数');

  // ③ explore：按符号名能找到
  const explored = await tool.handler({action: 'explore', query: 'format_name'}, CTX);
  const explorePayload = parseToolContent(explored);
  assert.equal(explorePayload['found'], true);
  const names = (explorePayload['symbols'] as Array<{name: string}>).map((row) => row.name);
  assert.ok(names.includes('format_name'), JSON.stringify(names));

  // 调用链追踪（同一动作的自然语言分支）
  const traced = await tool.handler({action: 'explore', query: '从 main 到 format_name'}, CTX);
  const tracePayload = parseToolContent(traced);
  assert.equal(tracePayload['found'], true);
  assert.deepEqual(tracePayload['path'], ['main', 'Greeter.greet', 'format_name']);

  // ④ pack：目标符号 + 调用链源码
  const packed = await tool.handler({action: 'pack', target: 'greet', depth: 2, mode: 'both'}, CTX);
  const packPayload = parseToolContent(packed);
  assert.equal(packPayload['ok'], true);
  const target = packPayload['target'] as {name: string; source: string};
  assert.equal(target.name, 'Greeter.greet', '短名按后缀唯一匹配到方法');
  assert.match(target.source, /format_name\(name\)/u);
  const deps = packPayload['dependencies'] as Array<{name: string; relation: string}>;
  assert.ok(deps.some((row) => row.name === 'format_name' && row.relation === 'callee'), JSON.stringify(deps));

  // ⑤ impact：被调用者（变更文件里的符号）与调用者
  const impacted = await tool.handler({action: 'impact', filepaths: ['app/util.py'], maxDepth: 3}, CTX);
  const impactPayload = parseToolContent(impacted);
  assert.equal(impactPayload['ok'], true);
  const affected = (impactPayload['affected_symbols'] as Array<{name: string; depth: number}>)
    .map((row) => row.name);
  assert.ok(affected.includes('format_name'), JSON.stringify(affected));
  assert.ok(affected.includes('Greeter.greet'), 'impact 给出调用者');

  // ⑥ status：语言覆盖 + grammar + Dart 明确不支持
  const status = await tool.handler({action: 'status'}, CTX);
  const statusPayload = parseToolContent(status);
  assert.equal(statusPayload['ok'], true);
  assert.equal(statusPayload['has_index'], true);
  assert.deepEqual(statusPayload['languages_indexed'], {python: 3, typescript: 1});
  assert.deepEqual(statusPayload['missing_grammars'], []);
  const unsupportedLanguages = statusPayload['unsupported_languages'] as Record<string, string>;
  assert.equal(typeof unsupportedLanguages['dart'], 'string');
  assert.match(String(statusPayload['language_support']), /dart ❌\(不支持\)/u);
  assert.match(String(statusPayload['language_support']), /typescript ✅/u);

  // ⑦ 增量：新增文件后只重建变更文件
  writeFileSync(join(project, 'app', 'extra.py'), 'def extra_fn():\n    return 1\n', 'utf8');
  const incremental = await tool.handler({action: 'index', incremental: true}, CTX);
  const incrementalPayload = parseToolContent(incremental);
  assert.match(String(incrementalPayload['summary']), /增量: 1\/5 文件变更/u);

  // ⑧ TS pack 也要真的带回源码（原 devkit 的 TS 提取只存 name/signature）
  const tsPacked = await tool.handler({action: 'pack', target: 'helper', depth: 1}, CTX);
  const tsTarget = parseToolContent(tsPacked)['target'] as {source: string};
  assert.match(tsTarget.source, /return x \+ 1/u);
});

// ── ④ manager 接线与 healthcheck ────────────────────────

interface ManagerFixture {
  dir: string;
  project: string;
  manager: SubagentManager;
  captured: Map<string, AgentLoopDeps>;
}

async function makeManager(t: TestContext): Promise<ManagerFixture> {
  const root = temp(t);
  const project = join(root, 'project');
  const dataDir = join(root, 'data');
  mkdirSync(project, {recursive: true});
  installFakeWorker(dataDir);
  mkdirSync(join(dataDir, 'subagents', 'profiles'), {recursive: true});
  writeFileSync(join(dataDir, 'subagents', 'profiles.json'), JSON.stringify({profiles: [
    {
      id: 'proj-role', label: '普通项目角色', tools: 'readonly', workspace: 'own',
      workdir: 'project', shell: 'project', requires: {},
    },
  ]}), 'utf8');
  const log = await EventLog.open(join(dataDir, 'events'));
  t.after(() => log.close());
  const registry = new ToolRegistry();
  for (const name of ['safe_read', 'read_blob', 'grep', 'find', 'safe_write', 'vision_read',
    'vision_query', 'report', 'delegate', 'subagent', 'task', 'pwsh']) {
    registry.register(parentTool(name));
  }
  const config = defaultConfig(dataDir);
  config.subagents.enabled = true;
  const captured = new Map<string, AgentLoopDeps>();
  const manager = new SubagentManager({
    dataDir, log, registry, projection: emptyProjection(), persona: PERSONA, ds: {} as never,
    config: () => config, now: () => new Date().toISOString(), timezone: 'Asia/Shanghai',
    projectRoots: [project],
    modelCapabilities: MODEL_OK,
    binaryCheck: () => true,
    pythonModulesCheck: () => [],
    codePythonPath: 'python',
    codeCliPath: resolveCodeCliPath().path!,
    codeRunner: async () => ({
      code: 0, stdout: JSON.stringify({ok: true, action: 'status', has_index: false}),
      stderr: '', aborted: false, timedOut: false,
    }),
    runTurnFn: (async (deps: AgentLoopDeps) => {
      captured.set(deps.agentId ?? 'x', deps);
      return {kind: 'completed'};
    }) as never,
  });
  await manager.start();
  return {dir: dataDir, project, manager, captured};
}

async function waitCompleted(manager: SubagentManager, agentId: string): Promise<void> {
  for (let i = 0; i < 200 && manager.status(agentId)?.status !== 'completed'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('manager 接线：worker 有 projectRoot ⇒ 注入 code 且可调用；非 worker 没有 code', async (t) => {
  const fx = await makeManager(t);
  const workerHandle = await fx.manager.delegate(
    {profileId: 'worker', task: '看看代码', projectRoot: fx.project}, {callId: 'worker', turn: 1});
  await waitCompleted(fx.manager, workerHandle.agentId);
  const workerDeps = fx.captured.get(workerHandle.agentId)!;
  assert.notEqual(workerDeps, undefined);
  assert.equal(resolve(workerDeps.workspaceRoot), realpathSync.native(resolve(fx.project)),
    '有 projectRoot 时文件面是项目根');
  const codeTool = workerDeps.registry.get('code');
  assert.notEqual(codeTool, null, 'worker + projectRoot 必须注入 code');
  assert.notEqual(workerDeps.registry.get('pwsh'), null, 'worker 仍有角色 pwsh');
  assert.notEqual(workerDeps.registry.get('vision_read'), null, '合并后 worker 保留 vision_read');
  assert.notEqual(workerDeps.registry.get('vision_query'), null);
  const result = await codeTool!.handler({action: 'status'}, CTX);
  assert.equal(result.isError, undefined, result.content);

  const otherHandle = await fx.manager.delegate(
    {profileId: 'proj-role', task: '不是 worker', projectRoot: fx.project}, {callId: 'other', turn: 2});
  await waitCompleted(fx.manager, otherHandle.agentId);
  const otherDeps = fx.captured.get(otherHandle.agentId)!;
  assert.equal(otherDeps.registry.get('code'), null, '非 worker 不注册 code');
  assert.notEqual(otherDeps.registry.get('pwsh'), null);
});

test('manager 接线：worker 没有 projectRoot ⇒ 退回 workspace，不注入 code', async (t) => {
  const fx = await makeManager(t);
  const handle = await fx.manager.delegate({profileId: 'worker', task: '纯设计任务'}, {callId: 'no-project', turn: 1});
  await waitCompleted(fx.manager, handle.agentId);
  const deps = fx.captured.get(handle.agentId)!;
  assert.equal(deps.registry.get('code'), null, '没有项目根就没有代码图');
  assert.notEqual(deps.registry.get('pwsh'), null, 'workspace-only 的 pwsh 仍然可用');
  assert.equal(
    resolve(deps.workspaceRoot),
    resolve(join(fx.dir, 'subagents', 'sessions', handle.agentId, 'workspace')),
    '没有项目根时文件面退回会话 workspace',
  );
});

test('healthcheck：requires.pythonModules 缺失 ⇒ worker locked + missing（注入 stub 覆盖缺失/可用两路）', async (t) => {
  const dir = temp(t);
  mkdirSync(join(dir, 'subagents'), {recursive: true});
  writeFileSync(join(dir, 'subagents', 'profiles.json'), JSON.stringify({profiles: [{
    id: 'needs-python', label: 'Python 依赖', tools: 'readonly', workspace: 'own',
    workdir: 'workspace', shell: 'none', reasoningEffort: 'max', contextLimit: 1_000_000, compactAt: 0.7,
    requires: {pythonModules: ['tree_sitter', 'definitely_missing_module']},
  }]}), 'utf8');
  const registry = new SubagentProfileRegistry(dir);
  const profile = registry.get('needs-python')!;
  const base = {dataDir: dir, ds: {} as never, modelCapabilities: MODEL_OK};

  const missing = await healthcheckSubagentProfile(profile, registry, {
    ...base,
    pythonModulesCheck: (modules) => modules.filter((id) => id !== 'tree_sitter'),
  });
  assert.equal(missing.locked, true);
  assert.deepEqual(missing.missing, ['definitely_missing_module'], '缺失模块 id 原样回报，不静默可用');

  const healthy = await healthcheckSubagentProfile(profile, registry, {
    ...base, pythonModulesCheck: () => [],
  });
  assert.deepEqual(healthy, {available: true, locked: false, missing: []});

  // 真探测：不注入 stub 时，缺失模块必须如实回报（不假装可用）。
  // 另建一个只依赖 worker 真实模块清单的 Profile：本机装齐才 available，否则 locked。
  mkdirSync(join(dir, 'subagents'), {recursive: true});
  writeFileSync(join(dir, 'subagents', 'profiles.json'), JSON.stringify({profiles: [
    {
      id: 'needs-python', label: 'Python 依赖', tools: 'readonly', workspace: 'own',
      workdir: 'workspace', shell: 'none', reasoningEffort: 'max', contextLimit: 1_000_000, compactAt: 0.7,
      requires: {pythonModules: ['tree_sitter', 'definitely_missing_module']},
    },
    {
      id: 'real-python', label: '真实 Python 依赖', tools: 'readonly', workspace: 'own',
      workdir: 'workspace', shell: 'none', reasoningEffort: 'max', contextLimit: 1_000_000, compactAt: 0.7,
      requires: {pythonModules: [...WORKER_PYTHON_MODULES]},
    },
  ]}), 'utf8');
  const registry2 = new SubagentProfileRegistry(dir);
  const realProfile = registry2.get('real-python')!;
  const real = await healthcheckSubagentProfile(realProfile, registry2, base);
  if (pythonReady()) {
    assert.deepEqual(real, {available: true, locked: false, missing: []});
  } else {
    assert.equal(real.locked, true);
    assert.ok(real.missing.length > 0);
  }
});

test('healthcheck：worker 真 Profile 在 fake 包 + 注入探测下 available；缺模块则 locked', async (t) => {
  const dir = temp(t);
  installFakeWorker(dir);
  const registry = new SubagentProfileRegistry(dir);
  const worker = registry.get('worker')!;
  const base = {
    dataDir: dir, ds: {} as never, modelCapabilities: MODEL_OK, binaryCheck: () => true,
  };
  const ok = await healthcheckSubagentProfile(worker, registry, {...base, pythonModulesCheck: () => []});
  assert.deepEqual(ok, {available: true, locked: false, missing: []});
  const locked = await healthcheckSubagentProfile(worker, registry, {
    ...base, pythonModulesCheck: () => ['tree_sitter_go'],
  });
  assert.equal(locked.locked, true);
  assert.deepEqual(locked.missing, ['tree_sitter_go']);
});
