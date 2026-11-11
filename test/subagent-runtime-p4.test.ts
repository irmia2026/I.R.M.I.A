import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { emptyProjection } from '../src/log/types.ts';
import type { McpServerEntry } from '../src/mcp/client.ts';
import type { AgentLoopDeps } from '../src/runtime/agent-loop.ts';
import { SubagentManager } from '../src/runtime/subagent-manager.ts';
import { SubagentMcpRuntime, type SubagentMcpPool } from '../src/runtime/subagent-mcp.ts';
import { SubagentSkillRuntime } from '../src/runtime/subagent-skills.ts';
import { resolveAuthorizedProject, scopeToolToRoots } from '../src/runtime/subagent-workspace.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { errorResult, okResult, type ToolContext, type ToolDefinition } from '../src/tools/types.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const PERSONA = {identity: 'test', constitution: 'test', style: 'test', state: '', personaHash: 'hash'};
const CTX = {callId: 'call', turn: 1, step: 1, signal: new AbortController().signal, workspaceRoot: ''} as ToolContext;

function temp(t: TestContext): string {
  const dir = tempDirSync('irmia-subagent-p4-');
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function definition(name: string, handler?: ToolDefinition['handler']): ToolDefinition {
  return {
    name, description: name, parameters: {type: 'object', properties: {}, additionalProperties: true},
    executionMode: 'parallel', sideEffect: 'none', timeoutMs: 1000,
    handler: handler ?? (async () => okResult('ok')),
  };
}

function writeSkill(root: string, id: string): void {
  mkdirSync(join(root, 'references'), {recursive: true});
  writeFileSync(join(root, 'SKILL.md'), `---\nname: ${id}\ndescription: ${id} 的测试技能与审查流程\n---\nREAD-${id}\n`, 'utf8');
  writeFileSync(join(root, 'references', 'rules.txt'), `RULE-${id}`, 'utf8');
}

test('P4.3 project/workdir：只接受授权根；文件工具相对路径、绝对路径与 symlink 均不能越界', async (t) => {
  const dir = temp(t);
  const project = join(dir, 'project');
  const outside = join(dir, 'outside');
  mkdirSync(project, {recursive: true});
  mkdirSync(outside, {recursive: true});
  writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf8');
  assert.equal(resolveAuthorizedProject(undefined, [project]), realpathSync.native(project));
  assert.equal(resolveAuthorizedProject(project, [project]), realpathSync.native(project));
  assert.throws(() => resolveAuthorizedProject(outside, [project]), /project-root-unauthorized/u);
  assert.throws(() => resolveAuthorizedProject(undefined, []), /project-root-required/u);

  let calls = 0;
  const scoped = scopeToolToRoots(definition('safe_read', async () => { calls += 1; return okResult('read'); }), [project], project);
  const ok = await scoped.handler({path: 'src/a.ts'}, CTX);
  assert.equal(ok.isError, undefined);
  assert.equal(calls, 1);
  for (const args of [{path: '../outside/secret.txt'}, {path: join(outside, 'secret.txt')}, {paths: ['ok', '../outside/secret.txt']}]) {
    const denied = await scoped.handler(args, CTX);
    assert.equal(denied.isError, true);
  }
  assert.equal(calls, 1);
  const link = join(project, 'escape');
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await scoped.handler({path: 'escape/secret.txt'}, CTX);
  assert.equal(linked.isError, true, '已存在 symlink 的真实目标也不能越界');
});

test('P4.3 skills：白名单 catalog + 同一只读入口，正文/references/assets 可读，越界与未列出 skill 拒绝', async (t) => {
  const dir = temp(t);
  const skillRoot = join(dir, 'subagents', 'packs', 'coder', 'skills', 'review');
  writeSkill(skillRoot, 'review');
  writeSkill(join(dir, 'skills', 'parent-only'), 'parent-only');
  const runtime = new SubagentSkillRuntime(dir, 'coder', ['review', 'missing-skill']);
  assert.match(runtime.catalog, /review/u);
  assert.equal(runtime.catalog.includes('parent-only'), false);
  assert.deepEqual(runtime.missing, ['missing-skill']);
  const read = runtime.tool();
  assert.match((await read.handler({skill: 'review'}, CTX)).content, /READ-review/u);
  assert.equal((await read.handler({skill: 'review', path: 'references/rules.txt'}, CTX)).content, 'RULE-review');
  assert.equal((await read.handler({skill: 'review', path: 'SKILL.md', encoding: 'base64'}, CTX)).isError, undefined);
  assert.equal((await read.handler({skill: 'parent-only'}, CTX)).error?.code, 'skill-not-allowed');
  assert.equal((await read.handler({skill: 'review', path: '../outside'}, CTX)).error?.code, 'skill-path-denied');
});

class FakePool implements SubagentMcpPool {
  calls: Array<{server: string; tool: string; args: unknown}> = [];
  closed = false;
  failList = false;

  async listTools(server: string): Promise<never[] | Array<{name: string; description: string; inputSchema: Record<string, unknown>}>> {
    if (this.failList) throw new Error('list failed');
    const names = server === 'serena' ? ['find_symbol', 'execute_shell', 'serena_repl'] : server === 'playwright' ? ['browser_navigate', 'browser_run_code'] : ['convert_to_markdown', 'other'];
    return names.map((name) => ({name, description: name, inputSchema: {type: 'object', properties: {}, additionalProperties: true}}));
  }

  async callTool(server: string, tool: string, args: unknown) {
    this.calls.push({server, tool, args});
    return okResult('mcp-ok');
  }

  async shutdown(): Promise<void> {
    this.closed = true;
  }
}

function writeMcp(dir: string, profile: string, id: string): void {
  const root = join(dir, 'subagents', 'packs', profile, 'mcp');
  mkdirSync(root, {recursive: true});
  writeFileSync(join(root, `${id}.json`), JSON.stringify({name: id, command: id === 'playwright' ? 'node' : 'uvx', args: ['server.js']}), 'utf8');
}

test('P4.3 MCP：curated + Profile 白名单 + 工具过滤；路径/网络边界、调用审计与 shutdown', async (t) => {
  const dir = temp(t);
  for (const id of ['serena', 'playwright', 'markitdown']) writeMcp(dir, 'coder', id);
  const pool = new FakePool();
  const audits: Record<string, unknown>[] = [];
  const runtime = new SubagentMcpRuntime({
    dataDir: dir, profileId: 'coder', agentId: 'sub-test', servers: ['serena', 'playwright', 'markitdown'],
    roots: [dir], defaultRoot: dir, emit: (data) => audits.push(data),
    poolFactory: (_entries: readonly McpServerEntry[]) => pool,
  });
  await runtime.start();
  const registry = new ToolRegistry();
  runtime.registerTools(registry);
  assert.ok(registry.get('mcp__serena__find_symbol'));
  assert.equal(registry.get('mcp__serena__execute_shell'), null);
  assert.equal(registry.get('mcp__serena__serena_repl'), null);
  assert.equal(registry.get('mcp__playwright__browser_run_code'), null);
  assert.ok(registry.get('mcp__markitdown__convert_to_markdown'));
  assert.equal(registry.get('mcp__markitdown__other'), null);

  assert.equal((await registry.get('mcp__serena__find_symbol')!.handler({relative_path: '../outside'}, CTX)).error?.code, 'mcp-boundary-denied');
  assert.equal((await registry.get('mcp__serena__find_symbol')!.handler({relative_path: 'src/a.ts'}, CTX)).isError, undefined);
  assert.equal((await registry.get('mcp__playwright__browser_navigate')!.handler({url: 'https://example.com'}, CTX)).error?.code, 'mcp-boundary-denied');
  assert.equal((await registry.get('mcp__playwright__browser_navigate')!.handler({url: 'http://127.0.0.1:3000'}, CTX)).isError, undefined);
  assert.equal((await registry.get('mcp__markitdown__convert_to_markdown')!.handler({uri: 'https://example.com/a.pdf'}, CTX)).error?.code, 'mcp-boundary-denied');
  assert.equal(pool.calls.length, 2);
  assert.ok(audits.some((row) => row['action'] === 'tools-listed'));
  assert.ok(audits.some((row) => row['action'] === 'tool-denied'));
  await runtime.shutdown();
  assert.equal(pool.closed, true);

  const denied = new SubagentMcpRuntime({dataDir: dir, profileId: 'coder', agentId: 'x', servers: ['random'], roots: [dir], defaultRoot: dir});
  await assert.rejects(denied.start(), /mcp-not-curated/u);
});

test('P4.3 MCP tools/list 失败会关停池，不把半启动运行时交给会话', async (t) => {
  const dir = temp(t);
  writeMcp(dir, 'coder', 'serena');
  const pool = new FakePool();
  pool.failList = true;
  const runtime = new SubagentMcpRuntime({
    dataDir: dir, profileId: 'coder', agentId: 'x', servers: ['serena'], roots: [dir], defaultRoot: dir,
    poolFactory: () => pool,
  });
  await assert.rejects(runtime.start(), /list failed/u);
  assert.equal(pool.closed, true);
});

test('P4.3 manager 端到端：coder project + review skill + Serena + 角色 pwsh 真装配且可调用', async (t) => {
  const dir = temp(t);
  const project = join(dir, 'project');
  mkdirSync(project, {recursive: true});
  writeSkill(join(dir, 'subagents', 'packs', 'runtime-test', 'skills', 'review'), 'review');
  writeMcp(dir, 'runtime-test', 'serena');
  mkdirSync(join(dir, 'subagents'), {recursive: true});
  writeFileSync(join(dir, 'subagents', 'profiles.json'), JSON.stringify({profiles: [{
    id: 'runtime-test', label: '运行时测试', tools: ['read', 'write', 'report'], workspace: 'own',
    workdir: 'project', shell: 'project', skills: ['review'], mcpServers: ['serena'],
    reasoningEffort: 'max', contextLimit: 1_000_000, compactAt: 0.7,
  }]}), 'utf8');
  const log = await EventLog.open(join(dir, 'events'));
  t.after(() => log.close());
  const registry = new ToolRegistry();
  for (const name of ['safe_read', 'read_blob', 'grep', 'find', 'safe_write', 'safe_edit', 'multi_edit', 'report', 'delegate', 'subagent', 'task', 'pwsh']) {
    registry.register(definition(name));
  }
  const config = defaultConfig(dir);
  config.subagents.enabled = true;
  const pool = new FakePool();
  let captured: AgentLoopDeps | null = null;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const manager = new SubagentManager({
    dataDir: dir, log, registry, projection: emptyProjection(), persona: PERSONA, ds: {} as never,
    config: () => config, now: () => new Date().toISOString(), timezone: 'Asia/Shanghai', projectRoots: [project],
    mcpPoolFactory: () => pool,
    runTurnFn: (async (deps: AgentLoopDeps) => {
      captured = deps;
      await gate;
      return {kind: 'completed'};
    }) as never,
  });
  await manager.start();
  const handle = await manager.delegate({profileId: 'runtime-test', task: 'task', projectRoot: project}, {callId: 'call', turn: 1});
  for (let i = 0; i < 100 && captured === null; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const deps = captured!;
  assert.equal(deps.workspaceRoot, realpathSync.native(project));
  assert.match(deps.skillCatalog ?? '', /review/u);
  assert.notEqual(deps.registry.get('pwsh'), null, 'shell:project 的 coder 必须装配角色 pwsh');
  assert.equal((await deps.registry.get('skill_read')!.handler({skill: 'review'}, CTX)).isError, undefined);
  assert.equal((await deps.registry.get('mcp__serena__find_symbol')!.handler({relative_path: 'src/a.ts'}, CTX)).isError, undefined);
  assert.equal(pool.calls.length, 1);
  assert.equal(pool.closed, false);
  release();
  for (let i = 0; i < 100 && manager.status(handle.agentId)?.status !== 'completed'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(manager.status(handle.agentId)?.status, 'completed');
  assert.equal(pool.closed, true, 'turn 收尾后 MCP 生命周期关闭');
});
