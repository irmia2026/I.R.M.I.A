/**
 * worker 运行时能力验收：`safe_rollback` 显式授权 + `shell:'full'`（仅 worker）+ 审计口径。
 *
 * 四组：
 *   ① Profile/capability：worker Profile 显式点名 safe_rollback；其他角色没有；
 *      `write` capability 本身仍然不含回滚（证明是“显式加”而不是“顺手扩大”）。
 *   ② full pwsh 单元：只对 worker 生效；cwd 固定 session workspace；任意绝对路径/cd/嵌套 shell
 *      放行（不做路径审计）；空/超长/NUL 仍拒绝；输出上限/超时/AbortSignal/最小环境保留；
 *      非 worker 的 workspace 档仍然拒绝根外路径（没有把审计一起放宽）。
 *   ③ manager 端到端：worker（有/无 projectRoot）拿到 full pwsh、screenshot、safe_rollback；
 *      full pwsh 能读/写 workspace 外的外部目录（真实 pwsh 跑，缺失时跳真实执行断言）；
 *      非 worker 没有 screenshot/safe_rollback，pwsh 仍是受限档；声明 shell:'full' 的非 worker
 *      拿不到 pwsh 且落 `shell-full-denied` 审计。
 *   ④ 审计事件：subagent/runtime 事件里不出现绝对路径。
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { emptyProjection, type AppEvent } from '../src/log/types.ts';
import type { AgentLoopDeps } from '../src/runtime/agent-loop.ts';
import { SubagentManager } from '../src/runtime/subagent-manager.ts';
import { hashTree } from '../src/runtime/subagent-packages.ts';
import { resolveProfileTools } from '../src/runtime/subagent-capabilities.ts';
import {
  BUILTIN_PROFILES, SubagentProfileRegistry,
} from '../src/runtime/subagent-profiles.ts';
import {
  auditFullShellCommand, createScopedPwshTool, resetShellBinaryCache, resolveShellBinary,
  type ScopedPwshResult, type ScopedPwshRunner,
} from '../src/runtime/subagent-shell.ts';
import type { ScreenshotCommandInput } from '../src/runtime/subagent-screenshot.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { okResult, type ToolContext, type ToolDefinition } from '../src/tools/types.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

type RunnerInput = Parameters<ScopedPwshRunner>[0];

const PERSONA = {identity: 'test', constitution: 'test', style: 'test', state: '', personaHash: 'hash'};
const MODEL_OK = {contextLimit: 1_000_000, reasoningEfforts: ['low', 'medium', 'high', 'max'] as const};
const CTX: ToolContext = {
  callId: 'call', turn: 1, step: 1, signal: new AbortController().signal, workspaceRoot: '',
};
const WORKER = BUILTIN_PROFILES.find((profile) => profile.id === 'worker')!;

function temp(t: TestContext): string {
  const dir = tempDirSync('irmia-subagent-worker-runtime-');
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function fakeRunner(calls: RunnerInput[], result?: Partial<ScopedPwshResult>): ScopedPwshRunner {
  return async (input) => {
    calls.push(input);
    return {code: 0, stdout: 'ok', stderr: '', aborted: false, timedOut: false, ...result};
  };
}

/** 33 字节 PNG 头（screenshot 工具只校验签名+IHDR；真 PNG 由 PowerShell 写）。 */
function writePngHeader(path: string, width: number, height: number): void {
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'latin1');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png[24] = 8;
  png[25] = 2;
  mkdirSync(join(path, '..'), {recursive: true});
  writeFileSync(path, png);
}

// ── ① safe_rollback 显式能力 ────────────────────────────

test('safe_rollback：worker Profile 显式点名（write capability 不展开它），其他角色不扩大', (t) => {
  const registry = new SubagentProfileRegistry(temp(t));
  const worker = registry.get('worker')!;
  assert.ok(worker.tools !== 'readonly' && worker.tools.includes('safe_rollback'),
    'worker.tools 必须是显式数组并含 safe_rollback');
  assert.ok(registry.toolNames(worker).includes('safe_rollback'));
  for (const id of ['researcher', 'general']) {
    const profile = registry.get(id)!;
    assert.equal(registry.toolNames(profile).includes('safe_rollback'), false, `${id} 不应有 safe_rollback`);
    assert.notEqual(profile.shell, 'full', `${id} 不能有 full shell`);
  }
  assert.equal(worker.shell, 'full', 'worker 是重度开发主力');
  assert.equal(registry.get('scribe')!.shell, 'full', 'scribe 需要 full pwsh 跑 skill 脚本');
  // `write` capability 的展开面仍是三件（回滚是显式加的，不是 write 顺带发的）。
  const expanded = resolveProfileTools({id: 'w', tools: ['write'], workspace: 'own'}).names;
  assert.deepEqual(expanded.filter((name) => name !== 'report').sort(),
    ['multi_edit', 'safe_edit', 'safe_write']);
  assert.equal(expanded.includes('safe_rollback'), false);
});

// ── ② full pwsh 单元 ────────────────────────────────────

test('full pwsh：只对 worker 生效；cwd 固定 workspace；任意路径/cd/嵌套 shell 放行且不做路径审计', async (t) => {
  const root = temp(t);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, {recursive: true});
  const outside = join(root, 'outside');
  mkdirSync(outside, {recursive: true});
  const audits: Array<Record<string, unknown>> = [];
  const calls: RunnerInput[] = [];
  const tool = createScopedPwshTool({
    profileId: 'worker', shell: 'full', workspace, agentId: 'a',
    emit: (row) => audits.push(row),
    baseEnv: {PATH: 'C:\\Windows', IRMIA_API_KEY: 'secret', DEEPSEEK_API_KEY: 'secret'},
    runner: fakeRunner(calls),
  })!;
  assert.notEqual(tool, null);
  const schema = tool.parameters as {properties: Record<string, unknown>; required: string[]};
  assert.equal(schema.properties['root'], undefined, 'full 档不接受 root 参数（cwd 固定 workspace）');
  assert.deepEqual(schema.required, ['command']);

  const commands = [
    `Get-Content "${join(outside, 'a.txt')}"`,
    'Get-Content C:\\Windows\\win.ini',
    `cd "${outside}"; Get-ChildItem`,
    'Set-Location ..',
    'powershell -Command "Get-ChildItem C:\\"',
    'Start-Process notepad.exe',
    'Invoke-Expression $payload',
  ];
  for (const command of commands) {
    const result = await tool.handler({command}, CTX);
    assert.equal(result.isError, undefined, `${command} 在 full 档必须放行：${result.content}`);
  }
  assert.equal(calls.length, commands.length);
  for (const call of calls) assert.equal(call.cwd, workspace, 'full 档 cwd 固定 session workspace');
  assert.equal(calls[0]!.env['IRMIA_API_KEY'], undefined, '仍是最小环境：凭据不透传');
  assert.equal(calls[0]!.env['DEEPSEEK_API_KEY'], undefined);
  assert.equal(calls[0]!.env['PATH'], 'C:\\Windows', '构建所需变量保留');
  const exec = audits.filter((row) => row['action'] === 'shell');
  assert.equal(exec.length, commands.length);
  assert.equal(exec[0]?.['unrestricted'], true);
  assert.equal(JSON.stringify(audits).includes('win.ini'), false, '审计不落命令原文');

  // 空命令/超长/NUL 是执行前自检，不是路径审计。
  assert.equal((await tool.handler({command: '   '}, CTX)).error?.code, 'E_INVALID_ARGS');
  assert.equal((await tool.handler({command: 'a'.repeat(16_001)}, CTX)).error?.code, 'E_INVALID_ARGS');
  assert.equal((await tool.handler({command: 'Write-Output "a\0b"'}, CTX)).error?.code, 'E_INVALID_ARGS');
  assert.equal(calls.length, commands.length, '自检拒绝不 spawn');
  assert.deepEqual(auditFullShellCommand('Get-Content C:\\Windows\\win.ini'), {ok: true, code: '', message: ''});

  // 非 worker 声明 full：拿不到工具，并落一条明确审计（数据文件不能自己申请 full）。
  const deniedAudits: Array<Record<string, unknown>> = [];
  for (const profileId of ['researcher', 'general', 'plain-role', 'needs-skill']) {
    assert.equal(createScopedPwshTool({
      profileId, shell: 'full', workspace, agentId: 'a', emit: (row) => deniedAudits.push(row),
      runner: fakeRunner([]),
    }), null, `${profileId} 不得拿到 full pwsh`);
  }
  assert.equal(deniedAudits.filter((row) => row['action'] === 'shell-full-denied').length, 4);
  assert.equal(JSON.stringify(deniedAudits).includes(workspace), false, '审计不带绝对路径');
});

test('full pwsh：输出上限/超时/取消/spawn 失败仍按执行资源边界处理', async (t) => {
  const root = temp(t);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, {recursive: true});
  const huge = 'x'.repeat(200_000);
  const truncating = createScopedPwshTool({
    profileId: 'worker', shell: 'full', workspace, agentId: 'a',
    runner: fakeRunner([], {stdout: huge}),
  })!;
  const truncated = await truncating.handler({command: 'Write-Output huge'}, CTX);
  assert.equal(truncated.isError, undefined);
  assert.ok(truncated.content.length <= 64_000 + 64, `输出必须截断（实际 ${truncated.content.length}）`);

  const cases: Array<[Partial<ScopedPwshResult>, string]> = [
    [{code: null, timedOut: true}, 'scoped-shell-timeout'],
    [{code: null, aborted: true}, 'scoped-shell-aborted'],
    [{code: 1, stdout: '', stderr: 'boom'}, 'scoped-shell-failed'],
    [{code: null, spawnError: 'ENOENT'}, 'scoped-shell-failed'],
  ];
  for (const [result, code] of cases) {
    const tool = createScopedPwshTool({
      profileId: 'worker', shell: 'full', workspace, agentId: 'a', runner: fakeRunner([], result),
    })!;
    const out = await tool.handler({command: 'npm test'}, CTX);
    assert.equal(out.error?.code, code);
  }

  // AbortSignal 真从 ctx 传到 runner：handler 等到 runner 看到 abort 才算收口。
  const controller = new AbortController();
  let sawAbort = false;
  const abortTool = createScopedPwshTool({
    profileId: 'worker', shell: 'full', workspace, agentId: 'a',
    runner: async (input) => {
      await new Promise<void>((resolveAbort) => {
        if (input.signal.aborted) { sawAbort = true; resolveAbort(); return; }
        input.signal.addEventListener('abort', () => { sawAbort = true; resolveAbort(); }, {once: true});
      });
      return {code: null, stdout: '', stderr: '', aborted: true, timedOut: false};
    },
  })!;
  const pending = abortTool.handler({command: 'npm test'}, {
    callId: 'call', turn: 1, step: 1, signal: controller.signal, workspaceRoot: workspace,
  });
  controller.abort();
  const aborted = await pending;
  assert.equal(sawAbort, true);
  assert.equal(aborted.error?.code, 'scoped-shell-aborted');
});

test('非 worker 的受限档没有跟着放宽：workspace 档仍拒绝根外绝对路径、cd 与嵌套 shell', async (t) => {
  const root = temp(t);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, {recursive: true});
  const calls: RunnerInput[] = [];
  const tool = createScopedPwshTool({
    profileId: 'researcher', shell: 'workspace', workspace, agentId: 'a', runner: fakeRunner(calls),
  })!;
  for (const command of ['Get-Content C:\\Windows\\win.ini', 'cd ..', 'powershell -Command dir']) {
    const out = await tool.handler({command}, CTX);
    assert.equal(out.error?.code, 'E_UNSAFE_PATH', command);
  }
  assert.equal(calls.length, 0, '受限档越界命令不 spawn');
});

// ── ③ manager 端到端 ────────────────────────────────────

const WORKER_PROFILE = WORKER;

/**
 * worker 可用的最小数据目录：空 packs/worker（记录 hashTree）+ 全部白名单 skill 的最小
 * SKILL.md；Python 模块/二进制/模型都由调用方注入真值，不依赖本机环境。
 */
function installFakeWorker(dataDir: string): void {
  const packRoot = join(dataDir, 'subagents', 'packs', 'worker');
  mkdirSync(packRoot, {recursive: true});
  const record = {
    id: 'worker',
    installedAt: '2026-11-05T00:00:00.000Z',
    packHash: hashTree(packRoot),
    sources: WORKER_PROFILE.install!.map((source) => ({
      ...source, id: 'fake', kind: 'skill', license: 'AGPL-3.0-only',
    })),
  };
  mkdirSync(join(dataDir, 'subagents'), {recursive: true});
  writeFileSync(join(dataDir, 'subagents', 'role-packages.json'),
    JSON.stringify({schema: 1, installed: [record]}), 'utf8');
  for (const id of WORKER_PROFILE.skills) {
    const root = join(dataDir, 'skills', id);
    mkdirSync(root, {recursive: true});
    writeFileSync(join(root, 'SKILL.md'), `---\nname: ${id}\ndescription: ${id} fixture\n---\n${id}\n`, 'utf8');
  }
}

function parentTool(name: string): ToolDefinition {
  return {
    name, description: name, parameters: {type: 'object', properties: {}, additionalProperties: false},
    executionMode: 'parallel', sideEffect: 'none', timeoutMs: 1000, handler: async () => okResult('ok'),
  };
}

interface WorkerFixture {
  dir: string;
  dataDir: string;
  project: string;
  manager: SubagentManager;
  captured: Map<string, AgentLoopDeps>;
  screenshotCalls: ScreenshotCommandInput[];
  log: EventLog;
}

async function makeManager(t: TestContext): Promise<WorkerFixture> {
  const root = temp(t);
  const project = join(root, 'project');
  const dataDir = join(root, 'data');
  mkdirSync(project, {recursive: true});
  installFakeWorker(dataDir);
  mkdirSync(join(dataDir, 'subagents', 'profiles'), {recursive: true});
  writeFileSync(join(dataDir, 'subagents', 'profiles.json'), JSON.stringify({profiles: [
    {
      id: 'plain-role', label: '普通只读', tools: ['read', 'write'], workspace: 'own',
      workdir: 'workspace', shell: 'workspace', requires: {},
    },
    {
      id: 'sneaky-full', label: '声明 full 的非 worker', tools: 'readonly', workspace: 'own',
      workdir: 'workspace', shell: 'full', requires: {},
    },
  ]}), 'utf8');
  const log = await EventLog.open(join(dataDir, 'events'));
  t.after(() => log.close());
  const registry = new ToolRegistry();
  for (const name of [
    'safe_read', 'read_blob', 'grep', 'find', 'safe_write', 'safe_edit', 'multi_edit', 'safe_rollback',
    'vision_read', 'vision_query', 'report', 'delegate', 'subagent', 'task', 'pwsh',
  ]) {
    registry.register(parentTool(name));
  }
  const config = defaultConfig(dataDir);
  config.subagents.enabled = true;
  const captured = new Map<string, AgentLoopDeps>();
  const screenshotCalls: ScreenshotCommandInput[] = [];
  const manager = new SubagentManager({
    dataDir, log, registry, projection: emptyProjection(), persona: PERSONA, ds: {} as never,
    config: () => config, now: () => new Date().toISOString(), timezone: 'Asia/Shanghai',
    projectRoots: [project],
    modelCapabilities: MODEL_OK,
    binaryCheck: () => true,
    pythonModulesCheck: () => [],
    screenshotRunner: async (input) => {
      screenshotCalls.push(input);
      writePngHeader(String(input.env['IRMIA_SHOT_PATH']), 320, 240);
      return {
        code: 0,
        stdout: JSON.stringify({ok: true, width: 320, height: 240, bytes: 33}),
        stderr: '', aborted: false, timedOut: false,
      };
    },
    runTurnFn: (async (deps: AgentLoopDeps) => {
      captured.set(deps.agentId ?? 'x', deps);
      return {kind: 'completed'};
    }) as never,
  });
  await manager.start();
  return {dir: root, dataDir, project, manager, captured, screenshotCalls, log};
}

async function waitCompleted(manager: SubagentManager, agentId: string): Promise<void> {
  for (let i = 0; i < 400 && manager.status(agentId)?.status !== 'completed'; i += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

function sessionWorkspace(fx: WorkerFixture, agentId: string): string {
  return join(fx.dataDir, 'subagents', 'sessions', agentId, 'workspace');
}

test('manager：worker（无 projectRoot）拿到 full pwsh / screenshot / safe_rollback，且能访问 workspace 外目录', async (t) => {
  const fx = await makeManager(t);
  const handle = await fx.manager.delegate({profileId: 'worker', task: '做点东西'}, {callId: 'w-full', turn: 1});
  await waitCompleted(fx.manager, handle.agentId);
  const deps = fx.captured.get(handle.agentId)!;
  assert.notEqual(deps, undefined);
  const workspace = sessionWorkspace(fx, handle.agentId);
  assert.equal(realpathSync.native(resolve(deps.workspaceRoot)), realpathSync.native(resolve(workspace)));

  const pwsh = deps.registry.get('pwsh');
  assert.notEqual(pwsh, null, 'worker 必须有 pwsh');
  assert.equal((pwsh!.parameters as {properties: Record<string, unknown>}).properties['root'], undefined,
    'worker 的 full pwsh 不接受 root 参数（cwd 固定 workspace）');
  const screenshot = deps.registry.get('screenshot');
  assert.notEqual(screenshot, null, 'worker 必须有 screenshot（没有 projectRoot 也要有）');
  const rollback = deps.registry.get('safe_rollback');
  assert.notEqual(rollback, null, 'worker 必须显式拿到 safe_rollback');

  // screenshot 在 manager 装配下真能跑（注入 runner）：落盘在 session workspace 内。
  const shot = await screenshot!.handler({}, {...CTX, workspaceRoot: deps.workspaceRoot});
  assert.equal(shot.isError, undefined, shot.content);
  const payload = JSON.parse(shot.content) as Record<string, unknown>;
  assert.equal(resolve(String(payload['path'])).startsWith(realpathSync.native(workspace)), true,
    'screenshot 返回 workspace 内的绝对路径（worker 有 projectRoot 时文件工具根不同）');
  assert.match(String(payload['path']).replaceAll('\\', '/'), /\/screenshots\/\d{8}-\d{6}-\d{3}\.png$/u);
  assert.equal(fx.screenshotCalls.length, 1);
  assert.equal(String(fx.screenshotCalls[0]!.env['IRMIA_SHOT_PATH']).startsWith(realpathSync.native(workspace)), true);

  // safe_rollback 经 scopeToolToRoots 包装后仍可调用（父注册表假实现回 ok）。
  const rolled = await rollback!.handler({path: 'a.ts'}, {...CTX, workspaceRoot: deps.workspaceRoot});
  assert.equal(rolled.isError, undefined, rolled.content);

  resetShellBinaryCache();
  const binary = resolveShellBinary();
  if (binary === null) return; // 无 pwsh 的机器：full 档行为已由单元用例覆盖
  const ctx = {...CTX, workspaceRoot: deps.workspaceRoot};
  const cwdOut = await pwsh!.handler({command: 'Write-Output (Get-Location).Path'}, ctx);
  assert.equal(cwdOut.isError, undefined, cwdOut.content);
  assert.equal(cwdOut.content.toLowerCase().includes(workspace.toLowerCase()), true, 'full 档 cwd 默认 workspace');

  // 核心诉求：pwsh 能访问 workspace 之外的任意目录（真实执行）。
  const external = join(fx.dir, 'external');
  mkdirSync(external, {recursive: true});
  const externalFile = join(external, 'probe.txt');
  const wrote = await pwsh!.handler({command: `Set-Content -LiteralPath "${externalFile}" -Value "outside-ok"`}, ctx);
  assert.equal(wrote.isError, undefined, wrote.content);
  assert.equal(readFileSync(externalFile, 'utf8').trim(), 'outside-ok');

  // cd 到外部目录再干活（受限档这是被拒绝的写法）。
  const cd = await pwsh!.handler({command: `cd "${external}"; Set-Content -LiteralPath "rel.txt" -Value "cd-ok"; (Get-Location).Path`}, ctx);
  assert.equal(cd.isError, undefined, cd.content);
  assert.equal(readFileSync(join(external, 'rel.txt'), 'utf8').trim(), 'cd-ok');
  assert.equal(cd.content.toLowerCase().includes(external.toLowerCase()), true);
});

test('manager：worker（有 projectRoot）文件面仍收口项目根，但 full pwsh 仍可访问外部目录', async (t) => {
  const fx = await makeManager(t);
  writeFileSync(join(fx.project, 'app.ts'), 'export const x = 1\n', 'utf8');
  const handle = await fx.manager.delegate(
    {profileId: 'worker', task: '改代码', projectRoot: fx.project}, {callId: 'w-proj', turn: 2},
  );
  await waitCompleted(fx.manager, handle.agentId);
  const deps = fx.captured.get(handle.agentId)!;
  assert.equal(realpathSync.native(resolve(deps.workspaceRoot)), realpathSync.native(resolve(fx.project)),
    '文件工具的根仍是 project（不因 full pwsh 而扩大文件面）');
  assert.notEqual(deps.registry.get('screenshot'), null);
  assert.notEqual(deps.registry.get('safe_rollback'), null);
  const pwsh = deps.registry.get('pwsh');
  assert.notEqual(pwsh, null);

  resetShellBinaryCache();
  if (resolveShellBinary() === null) return;
  const ctx = {...CTX, workspaceRoot: deps.workspaceRoot};
  // 项目文件用绝对路径读（cwd 是 session workspace，不在项目里——full 档允许绝对路径）。
  const read = await pwsh!.handler({command: `Get-Content "${join(fx.project, 'app.ts')}"`}, ctx);
  assert.equal(read.isError, undefined, read.content);
  assert.match(read.content, /export const x = 1/u);
  const cwdOut = await pwsh!.handler({command: 'Write-Output (Get-Location).Path'}, ctx);
  assert.equal(cwdOut.content.toLowerCase().includes(sessionWorkspace(fx, handle.agentId).toLowerCase()), true,
    'cwd 默认 session workspace（不是项目根）');
});

test('manager：非 worker 没有 screenshot/safe_rollback，pwsh 仍受限；声明 full 的非 worker 拿不到 pwsh', async (t) => {
  const fx = await makeManager(t);
  const plain = await fx.manager.delegate(
    {profileId: 'plain-role', task: '只读活'}, {callId: 'plain', turn: 1},
  );
  await waitCompleted(fx.manager, plain.agentId);
  const plainDeps = fx.captured.get(plain.agentId)!;
  assert.equal(plainDeps.registry.get('screenshot'), null, 'screenshot 只给 worker');
  assert.equal(plainDeps.registry.get('safe_rollback'), null, 'write capability 不展开 safe_rollback');
  const plainPwsh = plainDeps.registry.get('pwsh');
  assert.notEqual(plainPwsh, null, '普通 Profile 仍有受限 pwsh');
  const denied = await plainPwsh!.handler({command: 'Get-Content C:\\Windows\\win.ini'},
    {...CTX, workspaceRoot: plainDeps.workspaceRoot});
  assert.equal(denied.error?.code, 'E_UNSAFE_PATH', '非 worker 没有跟着放宽');

  const sneaky = await fx.manager.delegate(
    {profileId: 'sneaky-full', task: '试图拿 full'}, {callId: 'sneaky', turn: 2},
  );
  await waitCompleted(fx.manager, sneaky.agentId);
  const sneakyDeps = fx.captured.get(sneaky.agentId)!;
  assert.equal(sneakyDeps.registry.get('pwsh'), null, '数据文件声明 full 也拿不到 pwsh');

  // 审计：明确记录“非 worker 声明 full 被拒”，且不含绝对路径。
  const events: AppEvent[] = [];
  for await (const event of fx.log.readAll()) events.push(event);
  const runtimeRows = events.filter((event) => event.type === 'subagent/runtime')
    .map((event) => event.data as Record<string, unknown>);
  assert.ok(runtimeRows.some((row) => row['action'] === 'shell-full-denied' && row['profileId'] === 'sneaky-full'));
  assert.equal(JSON.stringify(runtimeRows).includes(fx.dataDir), false, 'subagent/runtime 审计不得带绝对路径');
  assert.equal(JSON.stringify(runtimeRows).includes(fx.dir), false, 'subagent/runtime 审计不得带绝对路径');
});
