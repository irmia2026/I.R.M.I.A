import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { emptyProjection } from '../src/log/types.ts';
import type { AgentLoopDeps } from '../src/runtime/agent-loop.ts';
import { SubagentManager } from '../src/runtime/subagent-manager.ts';
import {
  auditShellCommand, createScopedPwshTool, resetShellBinaryCache, resolveShellBinary, scopedShellEnv,
  type ScopedPwshResult, type ScopedPwshRunner,
} from '../src/runtime/subagent-shell.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { okResult, type ToolContext, type ToolDefinition } from '../src/tools/types.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

type RunnerInput = Parameters<ScopedPwshRunner>[0];

const PERSONA = {identity: 'test', constitution: 'test', style: 'test', state: '', personaHash: 'hash'};
const CTX = {callId: 'call', turn: 1, step: 1, signal: new AbortController().signal, workspaceRoot: ''} as ToolContext;

function temp(t: TestContext): string {
  const dir = tempDirSync('irmia-subagent-shell-');
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function tool(name: string): ToolDefinition {
  return {
    name, description: name, parameters: {type: 'object', properties: {}, additionalProperties: false},
    executionMode: 'parallel', sideEffect: 'none', timeoutMs: 1000, handler: async () => okResult('ok'),
  };
}

function fakeRunner(calls: RunnerInput[], result?: Partial<ScopedPwshResult>): ScopedPwshRunner {
  return async (input) => {
    calls.push(input);
    return {code: 0, stdout: 'ok', stderr: '', aborted: false, timedOut: false, ...result};
  };
}

test('P4.5 命令审计：常规构建/测试/文件操作放行；根外绝对路径、..、切换 cwd、嵌套 shell 拒绝', () => {
  const workspace = join('C:', 'work', 'ws');
  const project = join('C:', 'work', 'proj');
  const roots = [workspace, project];
  const allowed = [
    'Get-ChildItem .',
    'Get-Content src\\a.ts',
    'npm test',
    'npx tsc --noEmit -p tsconfig.json',
    'git status --short',
    'node --test "test/*.test.ts"',
    `Get-Content "${join(project, 'src', 'a.ts')}"`,
    'Write-Output "hello"',
    'New-Item -ItemType File -Path out\\a.txt -Force',
  ];
  for (const command of allowed) {
    assert.deepEqual(auditShellCommand(command, roots), {ok: true, code: '', message: ''}, command);
  }
  const denied: Array<[string, string]> = [
    ['Get-Content C:\\Windows\\win.ini', 'shell-path-outside-root'],
    ['Get-Content C:/Windows/win.ini', 'shell-path-outside-root'],
    ['Get-Content D:\\IrmiaAgent\\data\\.keys.json', 'shell-path-outside-root'],
    ['Get-Content ..\\outside.txt', 'shell-parent-traversal'],
    ['Get-Content src\\..\\..\\outside.txt', 'shell-parent-traversal'],
    ['cd ..', 'shell-cwd-locked'],
    ['cd src', 'shell-cwd-locked'],
    ['Set-Location C:\\', 'shell-cwd-locked'],
    ['pushd ..', 'shell-cwd-locked'],
    ['Get-ChildItem ~', 'shell-env-home'],
    ['Get-ChildItem $env:USERPROFILE', 'shell-env-home'],
    ['Get-ChildItem $HOME', 'shell-env-home'],
    ['Get-ChildItem Env:', 'shell-env-dump'],
    ['\\\\server\\share\\secret.txt', 'shell-path-outside-root'],
    ['/etc/passwd', 'shell-path-outside-root'],
    ['Start-Process calc.exe', 'shell-process-escape'],
    ['powershell -Command "Get-ChildItem C:\\"', 'shell-nested-shell'],
    ['cmd /c dir', 'shell-nested-shell'],
    ['Invoke-Expression $payload', 'shell-dynamic-exec'],
    ['Add-Type -TypeDefinition $code', 'shell-dynamic-exec'],
    ['[System.IO.Directory]::SetCurrentDirectory("C:\\")', 'shell-process-api'],
    ['[System.Reflection.Assembly]::Load($bytes)', 'shell-reflection'],
  ];
  for (const [command, code] of denied) {
    const audit = auditShellCommand(command, roots);
    assert.equal(audit.ok, false, command);
    assert.equal(audit.code, code, command);
    assert.ok(audit.message.length > 0);
  }
  assert.equal(auditShellCommand('', roots).code, 'shell-empty');
  assert.equal(auditShellCommand('Get-ChildItem', [project]).ok, true);
  assert.equal(auditShellCommand('Get-Content ' + join(workspace, 'a.txt'), [project]).code, 'shell-path-outside-root',
    'workspace 根只在自己的角色里存在');
  assert.equal(auditShellCommand(`Get-Content "${join(project, 'a.txt')}"`, [workspace]).code, 'shell-path-outside-root');
  assert.equal(auditShellCommand('a'.repeat(16_001), roots).code, 'shell-too-long');
  assert.equal(auditShellCommand('Write-Output "a\0b"', roots).code, 'shell-null-byte');
});

test('P4.5 环境过滤：key/token/secret 与 IRMIA_* 不进子进程；构建所需变量保留', () => {
  const env = scopedShellEnv({
    PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', USERPROFILE: 'C:\\Users\\<user>',
    IRMIA_API_KEY: 'secret', DEEPSEEK_API_KEY: 'secret', npm_config_token: 'secret', AWS_SECRET_ACCESS_KEY: 'secret',
    NORMAL_FLAG: '1', CI: '0',
  });
  assert.equal(env['IRMIA_API_KEY'], undefined);
  assert.equal(env['DEEPSEEK_API_KEY'], undefined);
  assert.equal(env['npm_config_token'], undefined);
  assert.equal(env['AWS_SECRET_ACCESS_KEY'], undefined);
  assert.equal(env['PATH'], 'C:\\Windows');
  assert.equal(env['USERPROFILE'], 'C:\\Users\\<user>');
  assert.equal(env['NORMAL_FLAG'], '1');
  assert.equal(env['CI'], '1');
});

test('P4.5 角色 shell：shell:none 无工具；workspace 只给 workspace；project 给 project+workspace 且 cwd 固定', async (t) => {
  const dir = temp(t);
  const workspace = join(dir, 'ws');
  const project = join(dir, 'proj');
  mkdirSync(workspace, {recursive: true});
  mkdirSync(project, {recursive: true});
  assert.equal(createScopedPwshTool({profileId: 'general', shell: 'none', workspace, agentId: 'a'}), null);

  const workspaceCalls: RunnerInput[] = [];
  const workspaceTool = createScopedPwshTool({
    profileId: 'researcher', shell: 'workspace', workspace, projectRoot: project, agentId: 'a',
    runner: fakeRunner(workspaceCalls),
  })!;
  assert.notEqual(workspaceTool, null);
  const wsProps = (workspaceTool.parameters as {properties: Record<string, unknown>}).properties;
  assert.equal(wsProps['root'], undefined, 'workspace 角色不接受 project 根');
  assert.equal((await workspaceTool.handler({command: 'npm test'}, CTX)).isError, undefined);
  assert.equal(workspaceCalls[0]?.cwd, workspace);
  assert.equal((await workspaceTool.handler({command: 'npm test', root: 'project'}, CTX)).error?.code, 'E_INVALID_ARGS');

  const projectCalls: RunnerInput[] = [];
  const projectTool = createScopedPwshTool({
    profileId: 'worker', shell: 'project', workspace, projectRoot: project, agentId: 'a',
    runner: fakeRunner(projectCalls),
  })!;
  const projProps = (projectTool.parameters as {properties: Record<string, unknown>}).properties;
  assert.deepEqual((projProps['root'] as {enum: string[]}).enum, ['workspace', 'project']);
  assert.equal((await projectTool.handler({command: 'npm test'}, CTX)).isError, undefined);
  assert.equal(projectCalls[0]?.cwd, project, '默认 project 根');
  assert.equal((await projectTool.handler({command: 'Get-ChildItem', root: 'workspace'}, CTX)).isError, undefined);
  assert.equal(projectCalls[1]?.cwd, workspace);
  assert.equal((await projectTool.handler({command: 'npm test', root: 'other'}, CTX)).error?.code, 'E_INVALID_ARGS');

  // 越界命令在执行前就被拒：runner 不会被调用。
  const before = projectCalls.length;
  const out = await projectTool.handler({command: 'Get-Content C:\\Windows\\win.ini'}, CTX);
  assert.equal(out.error?.code, 'E_UNSAFE_PATH');
  assert.equal(projectCalls.length, before);

  // 没有已授权 projectRoot 时退化为 workspace-only，不凭空给项目权限。
  const fallback = createScopedPwshTool({
    profileId: 'worker-x', shell: 'project', workspace, agentId: 'a',
    runner: fakeRunner([]),
  })!;
  const fallbackProps = (fallback.parameters as {properties: Record<string, unknown>}).properties;
  assert.equal(fallbackProps['root'], undefined);
  assert.equal((await fallback.handler({command: 'Get-ChildItem', root: 'project'}, CTX)).error?.code, 'E_INVALID_ARGS');
});

test('P4.5 角色 shell：审计事件、执行失败/超时/取消与最小环境', async (t) => {
  const dir = temp(t);
  const workspace = join(dir, 'ws');
  mkdirSync(workspace, {recursive: true});
  const audits: Array<Record<string, unknown>> = [];
  const calls: RunnerInput[] = [];
  const failing = createScopedPwshTool({
    profileId: 'scribe', shell: 'workspace', workspace, agentId: 'a', emit: (row) => audits.push(row),
    baseEnv: {PATH: 'C:\\Windows', IRMIA_API_KEY: 'secret'},
    runner: fakeRunner(calls, {code: 2, stdout: '', stderr: 'boom'}),
  })!;
  const failed = await failing.handler({command: 'npm run build'}, CTX);
  assert.equal(failed.error?.code, 'scoped-shell-failed');
  assert.match(failed.content, /boom/u);
  const audit = audits.find((row) => row['action'] === 'shell');
  assert.equal(audit?.['ok'], false);
  assert.equal(audit?.['exitCode'], 2);
  assert.equal(typeof audit?.['commandHash'], 'string');
  assert.equal(JSON.stringify(audits).includes('npm run build'), false, '审计不落命令原文');
  assert.equal(calls[0]?.env['IRMIA_API_KEY'], undefined);

  const timedOut = createScopedPwshTool({
    profileId: 'scribe', shell: 'workspace', workspace, agentId: 'a',
    runner: fakeRunner([], {code: null, timedOut: true}),
  })!;
  assert.equal((await timedOut.handler({command: 'npm test', timeoutMs: 5}, CTX)).error?.code, 'scoped-shell-timeout');

  const denied = createScopedPwshTool({profileId: 'scribe', shell: 'workspace', workspace, agentId: 'a', emit: (row) => audits.push(row), runner: fakeRunner([])})!;
  assert.equal((await denied.handler({command: 'cd ..'}, CTX)).error?.code, 'E_UNSAFE_PATH');
  assert.ok(audits.some((row) => row['action'] === 'shell-denied' && row['code'] === 'shell-cwd-locked'));
});

test('P4.5 真实 pwsh 冒烟：固定 cwd 下执行输出；缺少 pwsh 时如实跳过', async (t) => {
  const dir = temp(t);
  const workspace = join(dir, 'ws');
  mkdirSync(workspace, {recursive: true});
  resetShellBinaryCache();
  const binary = resolveShellBinary();
  if (binary === null) {
    t.skip('本机没有 pwsh/powershell.exe，跳过真实执行冒烟');
    return;
  }
  const tool = createScopedPwshTool({profileId: 'researcher', shell: 'workspace', workspace, agentId: 'a'})!;
  const out = await tool.handler({command: 'Write-Output "scoped-pwsh-ok"; Write-Output (Get-Location).Path'}, CTX);
  assert.equal(out.isError, undefined, out.content);
  assert.match(out.content, /scoped-pwsh-ok/u);
  assert.equal(out.content.toLowerCase().includes(workspace.toLowerCase()), true, '执行 cwd 必须是角色 workspace');
  const denied = await tool.handler({command: 'Write-Output (Get-Location).Path; Set-Location C:\\'}, CTX);
  assert.equal(denied.error?.code, 'E_UNSAFE_PATH');
});

test('P4.5 角色权限（manager 端到端）：general/fork 无 pwsh；workspace 角色只有 workspace；project 角色有 project+workspace', async (t) => {
  const dir = temp(t);
  const project = join(dir, 'project');
  mkdirSync(project, {recursive: true});
  mkdirSync(join(dir, 'subagents'), {recursive: true});
  const profiles = [
    {id: 'ws-role', label: 'workspace 角色', tools: 'readonly', workspace: 'own', workdir: 'workspace', shell: 'workspace'},
    {id: 'proj-role', label: 'project 角色', tools: 'readonly', workspace: 'own', workdir: 'project', shell: 'project'},
  ];
  writeFileSync(join(dir, 'subagents', 'profiles.json'), JSON.stringify({profiles}), 'utf8');
  const log = await EventLog.open(join(dir, 'events'));
  t.after(() => log.close());
  const registry = new ToolRegistry();
  for (const name of ['safe_read', 'read_blob', 'grep', 'find', 'report', 'delegate', 'subagent', 'task', 'pwsh']) {
    registry.register(tool(name));
  }
  const config = defaultConfig(dir);
  config.subagents.enabled = true;
  const captured = new Map<string, AgentLoopDeps>();
  const manager = new SubagentManager({
    dataDir: dir, log, registry, projection: emptyProjection(), persona: PERSONA, ds: {} as never,
    config: () => config, now: () => new Date().toISOString(), timezone: 'Asia/Shanghai',
    projectRoots: [project],
    runTurnFn: (async (deps: AgentLoopDeps) => {
      captured.set(deps.agentId ?? 'x', deps);
      return {kind: 'completed'};
    }) as never,
  });
  await manager.start();
  const wait = async (agentId: string): Promise<void> => {
    for (let i = 0; i < 100 && manager.status(agentId)?.status !== 'completed'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const general = await manager.delegate({task: 'general'}, {callId: 'c0', turn: 1});
  await wait(general.agentId);
  assert.equal(captured.get(general.agentId)!.registry.get('pwsh'), null, 'general 没有 shell');
  const fork = await manager.delegate({task: 'fork', fork: true}, {callId: 'c1', turn: 1});
  await wait(fork.agentId);
  assert.equal(captured.get(fork.agentId)!.registry.get('pwsh'), null, 'fork 仍按 general 权限');

  const wsRole = await manager.delegate({profileId: 'ws-role', task: 'ws'}, {callId: 'c2', turn: 1});
  await wait(wsRole.agentId);
  const wsTool = captured.get(wsRole.agentId)!.registry.get('pwsh')!;
  const wsProps = (wsTool.parameters as {properties: Record<string, unknown>}).properties;
  assert.equal(wsProps['root'], undefined);

  const projRole = await manager.delegate({profileId: 'proj-role', task: 'proj', projectRoot: project}, {callId: 'c3', turn: 1});
  await wait(projRole.agentId);
  const projTool = captured.get(projRole.agentId)!.registry.get('pwsh')!;
  const projProps = (projTool.parameters as {properties: Record<string, unknown>}).properties;
  assert.deepEqual((projProps['root'] as {enum: string[]}).enum, ['workspace', 'project']);
});
