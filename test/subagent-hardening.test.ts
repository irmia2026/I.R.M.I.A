/**
 * P3.2.1 子代理硬化：maxTurns 执行 / Profile capability 白名单 / workspace:'none'。
 *
 * 与 `test/subagent-manager.test.ts` 同一套夹具形状（真 EventLog + 假 runTurnFn），
 * 但这里刻意**不注入** runTurnFn 之外的东西：要证的是"管理器自己会停"，
 * 而不是"某个替代实现替我停了"。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { emptyProjection, type AppEvent, type Projection } from '../src/log/types.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { okResult, type ToolDefinition } from '../src/tools/types.ts';
import { SubagentManager } from '../src/runtime/subagent-manager.ts';
import type { AgentLoopDeps } from '../src/runtime/agent-loop.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const PERSONA = {
  identity: 'test', constitution: 'test', style: 'test', state: '', personaHash: 'hash',
};

function tool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    parameters: {type: 'object', properties: {}, additionalProperties: false},
    executionMode: 'parallel',
    sideEffect: 'none',
    timeoutMs: 1000,
    handler: async () => okResult('ok'),
  };
}

/** 父注册表：内置工具的一个真子集（capability 分类认的是工具名，不要求全量装配）。 */
const PARENT_TOOLS = [
  'safe_read', 'read_blob', 'grep', 'find', 'report',
  'safe_write', 'safe_edit', 'multi_edit', 'safe_rollback',
  'http_get', 'http_post', 'http_download', 'web_search',
  'speak', 'send_media', 'read_channel',
  'pwsh', 'delegate', 'task', 'subagent',
];

interface Fixture {
  dir: string;
  log: EventLog;
  projection: Projection;
  config: ReturnType<typeof defaultConfig>;
  registry: ToolRegistry;
  manager: SubagentManager;
  readAll(): Promise<AppEvent[]>;
  sessionOf(agentId: string): Record<string, unknown>;
}

async function make(
  t: TestContext,
  runTurnFn: (deps: AgentLoopDeps, wake: readonly AppEvent[]) => Promise<unknown>,
  options: {profilesDoc?: unknown; profiles?: unknown} = {},
): Promise<Fixture> {
  const dir = tempDirSync('irmia-subagent-hardening-');
  const log = await EventLog.open(join(dir, 'events'));
  t.after(() => {
    log.close();
    rmSync(dir, {recursive: true, force: true});
  });
  // Profile 注册表在 SubagentManager 构造时加载：数据文件必须先落盘
  if (options.profilesDoc !== undefined) {
    mkdirSync(join(dir, 'subagents'), {recursive: true});
    writeFileSync(join(dir, 'subagents', 'profiles.json'), JSON.stringify(options.profilesDoc), 'utf8');
  }
  const config = defaultConfig(dir);
  config.subagents.enabled = true;
  config.subagents.maxConcurrent = 2;
  const registry = new ToolRegistry();
  for (const name of PARENT_TOOLS) registry.register(tool(name));
  const projection = emptyProjection();
  const manager = new SubagentManager({
    dataDir: dir,
    log,
    registry,
    projection,
    persona: PERSONA,
    ds: {} as never,
    config: () => config,
    modelCapabilities: {contextLimit: 1_000_000, reasoningEfforts: ['low', 'medium', 'high', 'max']},
    now: () => new Date().toISOString(),
    timezone: 'Asia/Shanghai',
    runTurnFn: runTurnFn as never,
    ...(options.profiles === undefined ? {} : {profiles: options.profiles as never}),
  });
  await manager.start();
  return {
    dir, log, projection, config, registry, manager,
    async readAll(): Promise<AppEvent[]> {
      const out: AppEvent[] = [];
      for await (const event of log.readAll()) out.push(event);
      return out;
    },
    sessionOf(agentId: string): Record<string, unknown> {
      return JSON.parse(readFileSync(
        join(dir, 'subagents', 'sessions', agentId, 'session.json'), 'utf8',
      )) as Record<string, unknown>;
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`等待条件超时（${timeoutMs}ms）`);
}

test('maxTurns=1：跑满一轮就停模型调用，写 max-turns 终态/report/wake', async (t) => {
  const calls: string[] = [];
  let fx!: Fixture;
  fx = await make(t, async (deps) => {
    calls.push(deps.agentId ?? '');
    if (calls.length === 1) fx.manager.message(deps.agentId!, '队列里的第二条');
    return {kind: 'completed'};
  }, {
    profilesDoc: {profiles: [{id: 'limit1', label: '限一轮', tools: 'readonly', workspace: 'own', maxTurns: 1}]},
  });

  const handle = await fx.manager.delegate({task: '第一轮任务', profileId: 'limit1'}, {callId: 'mt-1', turn: 1});
  await waitFor(() => fx.manager.status(handle.agentId)?.status === 'interrupted');

  assert.equal(calls.length, 1, 'maxTurns=1 ⇒ 只允许一次模型调用');
  const session = fx.sessionOf(handle.agentId);
  assert.equal(session['status'], 'interrupted');
  assert.equal(session['error'], 'max-turns');
  assert.equal(session['maxTurns'], 1);
  assert.deepEqual(session['pendingMessages'], ['队列里的第二条'], '没跑的消息留在队列里，不丢');

  const events = await fx.readAll();
  const interrupted = events.filter((event) => event.type === 'subagent/interrupted'
    && (event.data as {reason?: string}).reason === 'max-turns');
  assert.equal(interrupted.length, 1, '每次激活只写一条 max-turns 事实');
  assert.equal((interrupted[0]!.data as {maxTurns?: number}).maxTurns, 1);
  assert.ok(events.some((event) => event.type === 'subagent/report'
    && (event.data as {summary: string}).summary.includes('maxTurns')));
  assert.ok(events.some((event) => event.type === 'wake/subagent'
    && (event.data as {status: string; summary: string}).status === 'interrupted'
    && (event.data as {summary: string}).summary.includes('maxTurns')), '父代理被叫醒并知道这是暂停');

  // 父代理继续：resume/续聊重新起算一次激活额度
  fx.manager.message(handle.agentId, '继续做');
  await waitFor(() => calls.length === 2 && fx.manager.status(handle.agentId)?.status === 'interrupted');
  assert.equal(calls.length, 2);
  assert.equal(fx.sessionOf(handle.agentId)['error'], 'max-turns');
});

test('maxTurns=2：第二次到上限即停，剩余队列保留', async (t) => {
  const calls: string[] = [];
  let fx!: Fixture;
  fx = await make(t, async (deps) => {
    calls.push(deps.agentId ?? '');
    // 每轮都往队列里塞两条：没有上限时这个循环不会自己停
    fx.manager.message(deps.agentId!, `第${calls.length}轮-A`);
    fx.manager.message(deps.agentId!, `第${calls.length}轮-B`);
    return {kind: 'completed'};
  }, {
    profilesDoc: {profiles: [{id: 'limit2', label: '限两轮', tools: 'readonly', workspace: 'own', maxTurns: 2}]},
  });

  const handle = await fx.manager.delegate({task: '长任务', profileId: 'limit2'}, {callId: 'mt-2', turn: 1});
  await waitFor(() => fx.manager.status(handle.agentId)?.status === 'interrupted');

  assert.equal(calls.length, 2, 'maxTurns=2 ⇒ 恰好两次模型调用');
  const session = fx.sessionOf(handle.agentId);
  assert.equal(session['status'], 'interrupted');
  assert.equal(session['maxTurns'], 2);
  assert.ok((session['pendingMessages'] as string[]).length > 0, '剩余消息没有被吞掉');

  const events = await fx.readAll();
  assert.equal(events.filter((event) => event.type === 'subagent/interrupted'
    && (event.data as {reason?: string}).reason === 'max-turns').length, 1);
});

test('maxTurns 冻结在 session 上：老会话缺省取 Profile 值', async (t) => {
  // 只验证解析链路：没有 maxTurns 字段的会话（P3.2 之前写下的）用 Profile 当前值。
  const fx = await make(t, async () => ({kind: 'completed'}));
  const handle = await fx.manager.delegate({task: '冻结'}, {callId: 'mt-freeze', turn: 1});
  await waitFor(() => fx.manager.status(handle.agentId)?.status === 'completed');
  assert.equal(fx.sessionOf(handle.agentId)['maxTurns'], 12, 'general Profile 的出厂 maxTurns');
  assert.ok(existsSync(join(fx.dir, 'subagents', 'sessions', handle.agentId, 'session.json')));
});

test('恶意 profiles.json：speak/pwsh/未知写工具/递归工具一律拒绝并记录', async (t) => {
  let childDeps: AgentLoopDeps | null = null;
  const fx = await make(t, async (deps) => {
    childDeps = deps;
    return {kind: 'completed'};
  }, {
    profilesDoc: {profiles: [
      {id: 'speak-prof', label: '用户通道', tools: ['speak'], workspace: 'own'},
      {id: 'media-prof', label: '用户通道2', tools: ['send_media'], workspace: 'own'},
      {id: 'pwsh-prof', label: '命令执行', tools: ['pwsh'], workspace: 'own'},
      {id: 'unknown-prof', label: '未知写工具', tools: ['write_file_evil'], workspace: 'own'},
      {id: 'recursive-prof', label: '递归', tools: ['delegate'], workspace: 'own'},
      // 内置 researcher 被恶意覆盖：必须回退内置只读，而不是拿到 speak
      {id: 'researcher', label: '被污染的调研', tools: ['safe_read', 'speak'], workspace: 'own'},
    ]},
  });

  const ids = ['speak-prof', 'media-prof', 'pwsh-prof', 'unknown-prof', 'recursive-prof'];
  for (const id of ids) {
    assert.equal(fx.manager.profileSummaries().some((item) => item.id === id), false, `${id} 不应被加载`);
    await assert.rejects(
      () => fx.manager.delegate({task: 'x', profileId: id}, {callId: `call-${id}`, turn: 1}),
      /profile-unknown/u,
    );
  }
  const errors = fx.manager.profileErrors().join('\n');
  for (const needle of ['speak', 'send_media', 'pwsh', 'write_file_evil', 'delegate']) {
    assert.ok(errors.includes(needle), `应记录被拒条目：${needle}`);
  }
  // 内置 researcher 回退到出厂定义；真实安装后也不能拿到被注入的 speak。
  assert.equal(fx.manager.profileSummaries().find((item) => item.id === 'researcher')?.label, '调研');
  await fx.manager.installProfile('researcher');

  const handle = await fx.manager.delegate({task: '调研', profileId: 'researcher'}, {callId: 'research-fallback', turn: 1});
  await waitFor(() => fx.manager.status(handle.agentId)?.status === 'completed');
  assert.equal(childDeps!.registry.get('speak'), null, '回退后的 researcher 拿不到 speak');
  assert.notEqual(childDeps!.registry.get('safe_read'), null);
  assert.notEqual(childDeps!.registry.get('report'), null);
});

test('纵深防御：注入的恶意 Profile 也过运行期 capability 闸', async (t) => {
  const stubProfile = {
    id: 'evil', label: '恶意', description: '', systemPrompt: '',
    tools: ['speak', 'pwsh', 'write_file_evil', 'safe_read', 'http_get'],
    workspace: 'own', lane: 'heavy', maxTurns: 2,
  };
  const stub = {
    errors: [] as string[],
    get: (id: string) => (id === 'evil' ? stubProfile : null),
    list: () => [stubProfile],
    summaries: () => [{id: 'evil', label: '恶意', description: '', toolCount: 5, workspace: 'own', lane: 'heavy'}],
    toolNames: () => ['speak', 'pwsh', 'write_file_evil', 'safe_read', 'http_get'],
    availability: () => ({available: true, locked: false, missing: []}),
    contextText: () => '',
  };
  let childDeps: AgentLoopDeps | null = null;
  const fx = await make(t, async (deps) => {
    childDeps = deps;
    const report = deps.registry.get('report');
    assert.notEqual(report, null);
    const result = await report!.handler({text: '注入来源的进度'}, {
      callId: 'child', turn: 1, step: 1, signal: new AbortController().signal, workspaceRoot: fx.dir,
    } as never);
    assert.equal(result.isError, undefined, 'report 仍然只路由父代理');
    return {kind: 'completed'};
  }, {profiles: stub});

  const handle = await fx.manager.delegate({task: '绕过试试', profileId: 'evil'}, {callId: 'stub-evil', turn: 1});
  await waitFor(() => fx.manager.status(handle.agentId)?.status === 'completed');
  for (const name of ['speak', 'pwsh', 'write_file_evil']) {
    assert.equal(childDeps!.registry.get(name), null, `${name} 不得进入子代理注册表`);
  }
  assert.notEqual(childDeps!.registry.get('safe_read'), null);
  assert.notEqual(childDeps!.registry.get('http_get'), null, '可授予 capability 不受影响');
  assert.notEqual(childDeps!.registry.get('delegate'), null, '递归 schema 保留（执行期拒绝）');
  assert.notEqual(childDeps!.registry.get('subagent'), null, '合并后的 subagent schema 也保留（执行期拒绝）');
  const events = await fx.readAll();
  assert.ok(events.some((event) => event.type === 'subagent/report'
    && (event.data as {kind: string}).kind === 'progress'));
  assert.equal(events.some((event) => event.type === 'channel/message'), false, '没有任何用户通道出口');
});

test("workspace:'none'：不创建 session workspace，文件工具一律拒绝", async (t) => {
  let childDeps: AgentLoopDeps | null = null;
  const fx = await make(t, async (deps) => {
    childDeps = deps;
    return {kind: 'completed'};
  }, {
    profilesDoc: {profiles: [
      {id: 'nows', label: '无工作区', tools: 'readonly', workspace: 'none', systemPrompt: '只报告，不碰文件。'},
      {id: 'nows-write', label: '自相矛盾', tools: ['read', 'write'], workspace: 'none'},
    ]},
  });

  // 加载期就拒绝"workspace none + 写工具"这份矛盾配置
  assert.equal(fx.manager.profileSummaries().some((item) => item.id === 'nows-write'), false);
  assert.ok(fx.manager.profileErrors().some((message) => message.includes('workspace')), '记录矛盾原因');

  const handle = await fx.manager.delegate({task: '不落盘', profileId: 'nows'}, {callId: 'nows', turn: 1});
  await waitFor(() => fx.manager.status(handle.agentId)?.status === 'completed');
  const sessionDir = join(fx.dir, 'subagents', 'sessions', handle.agentId);
  assert.equal(fx.sessionOf(handle.agentId)['workspaceMode'], 'none');
  assert.equal(existsSync(join(sessionDir, 'workspace')), false, '不创建 session workspace');

  const registry = childDeps!.registry;
  for (const name of ['safe_read', 'read_blob', 'grep', 'find', 'safe_write', 'safe_edit']) {
    assert.equal(registry.get(name), null, `workspace:'none' 下 ${name} 必须拒绝`);
  }
  assert.notEqual(registry.get('report'), null, '报告通道保留');
  assert.equal(childDeps!.workspaceRoot, join(sessionDir, 'workspace'));
  assert.notEqual(childDeps!.workspaceRoot, fx.dir, '读根不是父 workspace');
  assert.equal(childDeps!.boundaryRoot, childDeps!.workspaceRoot, '边界也在 session 内');
});

test('capability 展开：read/network 只发对应工具，write 只在 own workspace', async (t) => {
  const captured: AgentLoopDeps[] = [];
  const fx = await make(t, async (deps) => {
    captured.push(deps);
    return {kind: 'completed'};
  }, {
    profilesDoc: {profiles: [
      {id: 'net', label: '联网', tools: ['read', 'network'], workspace: 'own'},
      {id: 'writer', label: '写手', tools: ['write'], workspace: 'own'},
    ]},
  });

  const net = await fx.manager.delegate({task: '联网', profileId: 'net'}, {callId: 'net', turn: 1});
  await waitFor(() => fx.manager.status(net.agentId)?.status === 'completed');
  const netTools = captured[0]!.registry.names().sort();
  for (const name of ['safe_read', 'read_blob', 'grep', 'find', 'http_get', 'http_post', 'http_download', 'web_search', 'report', 'delegate', 'task', 'subagent']) {
    assert.ok(netTools.includes(name), `net 应含 ${name}`);
  }
  assert.equal(netTools.includes('safe_write'), false, 'read/network 不发写工具');
  assert.equal(netTools.includes('speak'), false);

  const writer = await fx.manager.delegate({task: '写', profileId: 'writer'}, {callId: 'writer', turn: 1});
  await waitFor(() => fx.manager.status(writer.agentId)?.status === 'completed');
  const writerTools = captured[1]!.registry.names().sort();
  for (const name of ['safe_write', 'safe_edit', 'multi_edit', 'report']) {
    assert.ok(writerTools.includes(name), `writer 应含 ${name}`);
  }
  assert.equal(writerTools.includes('safe_read'), false, '没申请 read 就不发读工具');
  assert.equal(writerTools.includes('speak'), false);
});
