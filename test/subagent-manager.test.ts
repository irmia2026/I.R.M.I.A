import assert from 'node:assert/strict';
import { readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { defaultVisibility, emptyProjection, type AppEvent, type Projection } from '../src/log/types.ts';
import { applyOne, applySubagentEvent } from '../src/state/fold.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { errorResult, okResult, type ToolDefinition } from '../src/tools/types.ts';
import { FORK_NOTICE, SubagentManager, createSubagentTools } from '../src/runtime/subagent-manager.ts';
import type { AgentLoopDeps } from '../src/runtime/agent-loop.ts';
import { inputContentText, render, renderInstructions, type RenderInput } from '../src/model/render.ts';
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

function rig(t: TestContext, runTurnFn: (deps: AgentLoopDeps, wake: readonly AppEvent[]) => Promise<unknown>) {
  const dir = tempDirSync('irmia-subagent-');
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const log = new EventLog(join(dir, 'events'));
  return (async () => {
    await log.open?.();
    return null;
  })();
}

interface Fixture {
  dir: string;
  log: EventLog;
  projection: Projection;
  config: ReturnType<typeof defaultConfig>;
  registry: ToolRegistry;
  manager: SubagentManager;
  events: AppEvent[];
  close(): void;
}

async function make(t: TestContext, runTurnFn: (deps: AgentLoopDeps, wake: readonly AppEvent[]) => Promise<unknown>): Promise<Fixture> {
  const dir = tempDirSync('irmia-subagent-');
  const log = await EventLog.open(join(dir, 'events'));
  t.after(() => {
    log.close();
    rmSync(dir, {recursive: true, force: true});
  });
  const config = defaultConfig(dir);
  config.subagents.enabled = true;
  config.subagents.maxConcurrent = 2;
  const registry = new ToolRegistry();
  registry.register(tool('safe_read'));
  registry.register(tool('report'));
  registry.register(tool('safe_write'));
  registry.register(tool('delegate'));
  registry.register(tool('subagent'));
  registry.register(tool('task'));
  const projection = emptyProjection();
  const events: AppEvent[] = [];
  const now = () => new Date().toISOString();
  const manager = new SubagentManager({
    dataDir: dir,
    log,
    registry,
    projection,
    persona: PERSONA,
    ds: {} as never,
    config: () => config,
    projectRoots: [dir],
    now,
    timezone: 'Asia/Shanghai',
    runTurnFn: runTurnFn as never,
  });
  await manager.start();
  return {
    dir, log, projection, config, registry, manager, events,
    close: () => { log.close(); },
  };
}

function appendParent(fx: Fixture, type: string, data: unknown): AppEvent {
  const event = {
    seq: fx.log.nextSeq(), ts: new Date().toISOString(), type, data,
    visibility: defaultVisibility(type),
  } as unknown as AppEvent;
  fx.log.append(event, {sync: true});
  applyOne(fx.projection, event);
  return event;
}

function appendChild(fx: Fixture, deps: AgentLoopDeps, type: string, data: unknown): AppEvent {
  const event = {
    seq: fx.log.nextSeq(),
    ts: new Date().toISOString(),
    type,
    data,
    visibility: 'internal',
    parentCallId: deps.parentCallId,
    agentId: deps.agentId,
  } as unknown as AppEvent;
  fx.log.append(event, {sync: true});
  applyOne(deps.projection, event);
  deps.onEvent?.(event);
  return event;
}

test('P1 默认关闭：config.subagents.enabled=false', () => {
  const config = defaultConfig('D:/irmia-default-off');
  assert.equal(config.subagents.enabled, false);
  assert.equal(config.subagents.maxConcurrent, 2);
  assert.equal(config.subagents.archiveAfterDays, 7);
});

test('delegate 立即返回，后台完成写 report/finished/wake', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fx = await make(t, async () => { await gate; return {kind: 'completed'}; });
  const handle = await fx.manager.delegate({task: '调查一件事'}, {callId: 'call-1', turn: 7});
  assert.equal(handle.status, 'queued');
  assert.match(handle.agentId, /^sub-/u);
  assert.equal(fx.manager.status(handle.agentId)?.status, 'running');
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fx.manager.status(handle.agentId)?.status, 'completed');
  const types = (await readAll(fx)).map((event) => event.type);
  assert.ok(types.includes('subagent/report'));
  assert.ok(types.includes('subagent/finished'));
  assert.ok(types.includes('wake/subagent'));
  assert.equal(fx.projection.pending.some((item) => item.wakeSeq > 0), true);
});

test('完成唤醒进入父 pending 队列，不直接抢当前 turn', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fx = await make(t, async () => { await gate; return {kind: 'completed'}; });
  const before = fx.projection.pending.length;
  await fx.manager.delegate({task: 'wake me'}, {callId: 'busy', turn: 1});
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fx.projection.pending.length, before + 1);
  assert.equal(fx.projection.openTurn, null, '父 turn 没有被后台子代理抢占');
});

test('预算记账：子代理的 budget/consumed 回流父投影并写进 session.tokens', async (t) => {
  let fx!: Fixture;
  fx = await make(t, async (deps) => {
    appendChild(fx, deps, 'budget/consumed', {
      turn: 1, step: 1, lane: 'heavy', model: 'fake',
      inputTokens: 10, outputTokens: 5, cacheHitTokens: 0, cacheMissTokens: 10,
    });
    return {kind: 'completed'};
  });
  const handle = await fx.manager.delegate({task: 'budget'}, {callId: 'budget', turn: 1});
  await new Promise((resolve) => setTimeout(resolve, 20));
  const view = fx.manager.status(handle.agentId) as {tokens: {used: number}};
  assert.ok(view.tokens.used > 0);
  assert.ok(fx.projection.budget.tokensTask > 0);
});

test('subagent({action:"message"}) 可续聊：完成后追加消息再跑一轮', async (t) => {
  const notes: string[] = [];
  const fx = await make(t, async (_deps, wake) => {
    notes.push(String((wake[0]?.data as {note?: string} | undefined)?.note ?? ''));
    return {kind: 'completed'};
  });
  const handle = await fx.manager.delegate({task: '第一轮'}, {callId: 'continue', turn: 1});
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(fx.manager.status(handle.agentId)?.status, 'completed');
  fx.manager.message(handle.agentId, '接着做第二轮');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(notes.length, 2);
  assert.match(notes[0]!, /第一轮/u);
  assert.match(notes[1]!, /第二轮/u);
});

test('maxConcurrent 排队：第二个会话在前一个结束后才 running', async (t) => {
  const releases: Array<() => void> = [];
  const fx = await make(t, async () => {
    await new Promise<void>((resolve) => releases.push(resolve));
    return {kind: 'completed'};
  });
  fx.config.subagents.maxConcurrent = 1;
  const a = await fx.manager.delegate({task: 'a'}, {callId: 'a', turn: 1});
  const b = await fx.manager.delegate({task: 'b'}, {callId: 'b', turn: 1});
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fx.manager.status(a.agentId)?.status, 'running');
  assert.equal(fx.manager.status(b.agentId)?.status, 'queued');
  releases[0]!();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fx.manager.status(b.agentId)?.status, 'running');
  releases[1]!();
});

test('cancel：运行中会话终止，不写完成 wake', async (t) => {
  let seenSignal: AbortSignal | null = null;
  const fx = await make(t, async (deps) => {
    seenSignal = deps.signal ?? null;
    await new Promise<void>((resolve) => deps.signal?.addEventListener('abort', () => resolve(), {once: true}));
    return {kind: 'aborted', cause: 'signal'};
  });
  const handle = await fx.manager.delegate({task: 'long'}, {callId: 'cancel', turn: 1});
  await new Promise((resolve) => setTimeout(resolve, 5));
  fx.manager.cancel(handle.agentId, 'test');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(seenSignal !== null);
  assert.equal(fx.manager.status(handle.agentId)?.status, 'cancelled');
  const events = await readAll(fx);
  assert.ok(events.some((event) => event.type === 'subagent/cancelled'));
  assert.equal(events.some((event) => event.type === 'wake/subagent'), false);
});

test('重启：running 标 interrupted 并补 turn/end；父可 resume', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = await make(t, async (deps) => {
    appendChild(first, deps, 'turn/start', {turn: 8});
    await gate;
    return {kind: 'completed'};
  });
  const handle = await first.manager.delegate({task: 'crash me'}, {callId: 'restart', turn: 7});
  await new Promise((resolve) => setTimeout(resolve, 5));

  const second = await make(t, async () => ({kind: 'completed'}));
  // second uses a different temp dir; point it at first's directory by constructing directly.
  const config = defaultConfig(first.dir);
  config.subagents.enabled = true;
  const recovered = new SubagentManager({
    dataDir: first.dir, log: first.log, registry: first.registry, projection: first.projection,
    persona: PERSONA, ds: {} as never, config: () => config, now: () => new Date().toISOString(),
    timezone: 'Asia/Shanghai', runTurnFn: (async () => ({kind: 'completed'})) as never,
  });
  await recovered.start();
  const persisted = JSON.parse(readFileSync(join(first.dir, 'subagents', 'sessions', handle.agentId, 'session.json'), 'utf8')) as {status: string};
  assert.equal(persisted.status, 'interrupted');
  const events = await readAll(first);
  assert.ok(events.some((event) => event.type === 'subagent/interrupted'));
  assert.ok(events.some((event) => event.type === 'turn/end'
    && (event.data as {reason: {kind: string}}).reason.kind === 'interrupted'));
  recovered.resume(handle.agentId);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(recovered.status(handle.agentId)?.status, 'completed');
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  second.close();
});

test('P4.5 显式 resume 已完成会话：真正续跑一轮并完成，不空转 running', async (t) => {
  let turns = 0;
  const fx = await make(t, async (deps) => {
    turns += 1;
    appendChild(fx, deps, 'message/assistant', {text: `round-${turns}`, toolCalls: []});
    return {kind: 'completed'};
  });
  const handle = await fx.manager.delegate({task: 'resume me'}, {callId: 'resume', turn: 1});
  for (let i = 0; i < 100 && fx.manager.status(handle.agentId)?.status !== 'completed'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(fx.manager.status(handle.agentId)?.status, 'completed');
  assert.equal(turns, 1);
  fx.manager.resume(handle.agentId);
  for (let i = 0; i < 100 && fx.manager.status(handle.agentId)?.status !== 'completed'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(fx.manager.status(handle.agentId)?.status, 'completed', 'resume 必须真正跑完，而不是卡在 running');
  assert.equal(turns, 2, 'resume 必须真的再调一轮模型');
  assert.equal(fx.manager.status(handle.agentId)?.lastReport, 'round-2');
});

test('P4.5 cancel 后立刻 resume：旧 worker 不许把它覆盖回 cancelled，恢复必须真的再跑一轮', async (t) => {
  let turns = 0;
  const fx = await make(t, async (deps) => {
    turns += 1;
    if (turns === 1) {
      await new Promise<void>((resolve) => {
        if (deps.signal?.aborted === true) resolve();
        else deps.signal?.addEventListener('abort', () => resolve(), {once: true});
      });
      return {kind: 'aborted', cause: 'signal'};
    }
    appendChild(fx, deps, 'message/assistant', {text: `recovered-${turns}`, toolCalls: []});
    return {kind: 'completed'};
  });
  const handle = await fx.manager.delegate({task: 'cancel then resume'}, {callId: 'cr', turn: 1});
  for (let i = 0; i < 100 && turns < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(turns, 1, '第一轮必须真的开跑');
  fx.manager.cancel(handle.agentId);
  // 不等旧 worker 收尾，立刻恢复（模拟父代理连续两条命令）
  fx.manager.resume(handle.agentId);
  for (let i = 0; i < 200 && fx.manager.status(handle.agentId)?.status !== 'completed'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(fx.manager.status(handle.agentId)?.status, 'completed', '取消后恢复必须真的跑完');
  assert.equal(turns, 2);
  assert.equal(fx.manager.status(handle.agentId)?.lastReport, 'recovered-2');
});

test('递归 guard：子代理 schema 保留 delegate/subagent，但 handler 拒绝', async (t) => {
  let childRegistry: ToolRegistry | null = null;
  const fx = await make(t, async (deps) => {
    childRegistry = deps.registry;
    return {kind: 'completed'};
  });
  const handle = await fx.manager.delegate({task: 'check'}, {callId: 'guard', turn: 1});
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fx.manager.status(handle.agentId)?.status, 'completed');
  for (const name of ['delegate', 'subagent']) {
    const def: ToolDefinition = childRegistry!.get(name)!;
    assert.notEqual(def, null, `${name} schema 必须保留`);
    const result: Awaited<ReturnType<ToolDefinition['handler']>> = await def.handler({}, {
      callId: 'child', turn: 1, step: 1, signal: new AbortController().signal, workspaceRoot: fx.dir,
    } as never);
    assert.equal(result.isError, true, `${name} 必须执行期拒绝`);
    assert.equal(result.error?.code, 'depth-exceeded');
  }
});

test('P2 fork：边界止于最后一个 turn/end，不含当前 delegate tool/call', async (t) => {
  let notes: string[] = [];
  const fx = await make(t, async (_deps, wake) => {
    notes = wake.map((event) => String((event.data as {note?: string}).note ?? ''));
    return {kind: 'completed'};
  });
  appendParent(fx, 'turn/start', {turn: 1});
  appendParent(fx, 'message/user', {text: '父历史', source: 'human'});
  appendParent(fx, 'message/assistant', {text: '父回答', toolCalls: []});
  const end = appendParent(fx, 'turn/end', {turn: 1, reason: {kind: 'completed'}, spoke: true});
  appendParent(fx, 'turn/start', {turn: 2});
  const currentCall = appendParent(fx, 'tool/call', {
    turn: 2, step: 1, callId: 'delegate-call', name: 'delegate', arguments: '{}',
  });
  const handle = await fx.manager.delegate({task: 'fork task', fork: true}, {callId: 'delegate-call', turn: 2});
  const session = JSON.parse(readFileSync(join(fx.dir, 'subagents', 'sessions', handle.agentId, 'session.json'), 'utf8')) as {
    forkFromSeq: number; prefixHash: string;
  };
  assert.equal(session.forkFromSeq, end.seq);
  assert.match(session.prefixHash, /^[0-9a-f]{64}$/u);
  const prefix = JSON.parse(readFileSync(join(fx.dir, 'subagents', 'sessions', handle.agentId, 'prefix.json'), 'utf8')) as AppEvent[];
  assert.equal(prefix.some((event) => event.seq >= currentCall.seq), false);
  assert.equal(prefix[prefix.length - 1]?.seq, end.seq);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(notes[0], FORK_NOTICE, 'notice 在 task 之前');
  assert.match(notes[1]!, /fork task/u);
  assert.equal(notes[0]!.includes('developer'), false);
});

test('P2.1 real render：父 system/tools/prefix → Fork notice(user) → task(user)', async (t) => {
  const fx = await make(t, async () => ({kind: 'completed'}));
  appendParent(fx, 'turn/start', {turn: 1});
  appendParent(fx, 'message/user', {text: '父历史问题', source: 'human'});
  appendParent(fx, 'message/assistant', {text: '父历史回答', toolCalls: []});
  appendParent(fx, 'turn/end', {turn: 1, reason: {kind: 'completed'}, spoke: true});
  appendParent(fx, 'turn/start', {turn: 2});
  appendParent(fx, 'tool/call', {
    turn: 2, step: 1, callId: 'delegate-call', name: 'delegate', arguments: '{}',
  });
  const handle = await fx.manager.delegate({task: 'real render task', fork: true}, {callId: 'delegate-call', turn: 2});
  await new Promise((resolve) => setTimeout(resolve, 15));
  const prefix = JSON.parse(readFileSync(join(fx.dir, 'subagents', 'sessions', handle.agentId, 'prefix.json'), 'utf8')) as AppEvent[];
  const head = JSON.parse(readFileSync(join(fx.dir, 'subagents', 'sessions', handle.agentId, 'head.json'), 'utf8')) as {
    persona: {identity: string; constitution: string; style: string; state: string};
    tools: Array<{name: string; description: string; parameters: Record<string, unknown>}>;
  };
  const childEvents = (await readAll(fx)).filter((event) => event.parentCallId === 'delegate-call'
    && event.type === 'wake/manual').sort((a, b) => a.seq - b.seq);
  assert.equal(childEvents.length, 2);
  const notice = childEvents[0]!;
  const task = childEvents[1]!;
  assert.equal((notice.data as {note: string}).note, FORK_NOTICE);
  assert.match((task.data as {note: string}).note, /real render task/u);
  const input = {
    events: [...prefix, notice],
    persona: head.persona,
    tools: head.tools.map((spec) => ({type: 'function' as const, ...spec})),
    wakeEvent: task,
    taskCard: null,
    now: '2026-02-14T10:00:00.000+08:00',
    timezone: 'Asia/Shanghai',
    model: 'm',
    lane: 'heavy' as const,
    contact: null,
    mentionNotice: null,
    machine: null,
    usage: null,
    asks: null,
    injection: null,
    loadImage: null,
    softHint: null,
    memoryIndex: null,
    skillCatalog: null,
    turnBlock: null,
    stateBytes: null,
    stateBudgetBytes: null,
  } satisfies RenderInput;
  const rendered = render(input);
  assert.equal(rendered.instructions, renderInstructions(head.persona));
  assert.deepEqual(rendered.tools.map((tool) => tool.name), head.tools.map((tool) => tool.name));
  const userTexts = rendered.input
    .filter((item) => item.type === 'message' && item.role === 'user')
    .map((item) => inputContentText(item.content));
  const noticeIndex = userTexts.findIndex((text) => text.includes(FORK_NOTICE));
  const taskIndex = userTexts.findIndex((text) => text.includes('real render task'));
  assert.ok(noticeIndex >= 0, 'notice 是 user message');
  assert.ok(taskIndex > noticeIndex, 'notice 在 task 之前');
  assert.equal(JSON.stringify(rendered).includes('delegate-call'), false, '不含当前 delegate tool/call');
  assert.equal(JSON.stringify(rendered).includes('父历史问题'), true, '父前缀已进入请求');
});

test('P2 fork：无已完成 turn 退化为 general，不写 fork 字段', async (t) => {
  const fx = await make(t, async () => ({kind: 'completed'}));
  const handle = await fx.manager.delegate({task: 'no prefix', fork: true}, {callId: 'nofork', turn: 1});
  const session = JSON.parse(readFileSync(join(fx.dir, 'subagents', 'sessions', handle.agentId, 'session.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(session['forkFromSeq'], undefined);
  assert.equal(session['prefixHash'], undefined);
});

test('P2 fork：schema 与父同集，report 路由父、delegate/subagent guard depth-exceeded', async (t) => {
  let childDeps: AgentLoopDeps | null = null;
  const fx = await make(t, async (deps) => {
    childDeps = deps;
    const report = deps.registry.get('report')!;
    const reported = await report.handler({text: '阶段完成'}, {
      callId: 'child', turn: 1, step: 1, signal: new AbortController().signal, workspaceRoot: fx.dir,
    } as never);
    assert.equal(reported.isError, undefined);
    for (const name of ['delegate', 'subagent']) {
      const guarded = await deps.registry.get(name)!.handler({}, {
        callId: 'child', turn: 1, step: 1, signal: new AbortController().signal, workspaceRoot: fx.dir,
      } as never);
      assert.equal(guarded.error?.code, 'depth-exceeded', `${name} 必须执行期拒绝`);
    }
    const write = await deps.registry.get('safe_write')!.handler({}, {
      callId: 'child', turn: 1, step: 1, signal: new AbortController().signal, workspaceRoot: fx.dir,
    } as never);
    assert.equal(write.error?.code, 'fork-permission-denied');
    return {kind: 'completed'};
  });
  appendParent(fx, 'turn/start', {turn: 1});
  appendParent(fx, 'turn/end', {turn: 1, reason: {kind: 'completed'}, spoke: true});
  const handle = await fx.manager.delegate({task: 'schema', fork: true}, {callId: 'schema', turn: 2});
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(fx.manager.status(handle.agentId)?.status, 'completed');
  assert.deepEqual(childDeps!.registry.names().sort(),
    ['delegate', 'report', 'safe_read', 'safe_write', 'subagent', 'task'], '父可见 schema 同集');
  const events = await readAll(fx);
  assert.ok(events.some((event) => event.type === 'subagent/report'
    && (event.data as {kind: string}).kind === 'progress'));
  assert.ok(events.some((event) => event.type === 'wake/subagent'
    && (event.data as {kind?: string}).kind === 'progress'));
  assert.equal(events.some((event) => event.type === 'channel/message'), false);
});

test('P2 fork：resume 沿用同一 prefixHash，不重新取当前父前缀', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = await make(t, async () => { await gate; return {kind: 'completed'}; });
  appendParent(first, 'turn/start', {turn: 1});
  appendParent(first, 'turn/end', {turn: 1, reason: {kind: 'completed'}, spoke: true});
  const handle = await first.manager.delegate({task: 'fork resume', fork: true}, {callId: 'fork-resume', turn: 2});
  const before = JSON.parse(readFileSync(join(first.dir, 'subagents', 'sessions', handle.agentId, 'session.json'), 'utf8')) as {prefixHash: string; forkFromSeq: number; tokens: {used: number}};
  appendParent(first, 'turn/start', {turn: 3});
  appendParent(first, 'turn/end', {turn: 3, reason: {kind: 'completed'}, spoke: true});
  const config = defaultConfig(first.dir);
  config.subagents.enabled = true;
  const recovered = new SubagentManager({
    dataDir: first.dir, log: first.log, registry: first.registry, projection: first.projection,
    persona: PERSONA, ds: {} as never, config: () => config, now: () => new Date().toISOString(),
    timezone: 'Asia/Shanghai', runTurnFn: (async () => ({kind: 'completed'})) as never,
  });
  await recovered.start();
  recovered.resume(handle.agentId);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const after = JSON.parse(readFileSync(join(first.dir, 'subagents', 'sessions', handle.agentId, 'session.json'), 'utf8')) as {prefixHash: string; forkFromSeq: number; tokens: {used: number}};
  assert.equal(after.prefixHash, before.prefixHash);
  assert.equal(after.forkFromSeq, before.forkFromSeq);
  assert.equal(after.tokens.used, before.tokens.used);
  release();
});

test('P2.1 head freeze：父新增工具/改 persona 后，fork 子代理仍用冻结头', async (t) => {
  const originalIdentity = PERSONA.identity;
  let calls = 0;
  let secondDeps: AgentLoopDeps | null = null;
  const fx = await make(t, async (deps) => {
    calls += 1;
    if (calls === 2) secondDeps = deps;
    return {kind: 'completed'};
  });
  appendParent(fx, 'turn/start', {turn: 1});
  appendParent(fx, 'turn/end', {turn: 1, reason: {kind: 'completed'}, spoke: true});
  const handle = await fx.manager.delegate({task: 'freeze', fork: true}, {callId: 'freeze', turn: 2});
  const headPath = join(fx.dir, 'subagents', 'sessions', handle.agentId, 'head.json');
  const headBefore = readFileSync(headPath, 'utf8');
  const sessionBefore = JSON.parse(readFileSync(join(fx.dir, 'subagents', 'sessions', handle.agentId, 'session.json'), 'utf8')) as {headHash: string};
  await new Promise((resolve) => setTimeout(resolve, 15));
  fx.registry.register(tool('late_tool'));
  PERSONA.identity = 'changed-after-fork';
  fx.manager.message(handle.agentId, '继续');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondDeps!.persona.identity, originalIdentity);
  assert.equal(secondDeps!.registry.get('late_tool'), null);
  assert.equal(readFileSync(headPath, 'utf8'), headBefore);
  assert.equal(JSON.parse(readFileSync(join(fx.dir, 'subagents', 'sessions', handle.agentId, 'session.json'), 'utf8')).headHash, sessionBefore.headHash);
  PERSONA.identity = originalIdentity;
});

test('P2.1 head snapshot 缺失/损坏：resume 明确拒绝，不静默用当前父头', async (t) => {
  const fx = await make(t, async () => ({kind: 'completed'}));
  appendParent(fx, 'turn/start', {turn: 1});
  appendParent(fx, 'turn/end', {turn: 1, reason: {kind: 'completed'}, spoke: true});
  const handle = await fx.manager.delegate({task: 'head missing', fork: true}, {callId: 'head-missing', turn: 2});
  await new Promise((resolve) => setTimeout(resolve, 15));
  const headPath = join(fx.dir, 'subagents', 'sessions', handle.agentId, 'head.json');
  const config = defaultConfig(fx.dir);
  config.subagents.enabled = true;
  const recovered = new SubagentManager({
    dataDir: fx.dir, log: fx.log, registry: fx.registry, projection: fx.projection,
    persona: PERSONA, ds: {} as never, config: () => config, now: () => new Date().toISOString(),
    timezone: 'Asia/Shanghai', runTurnFn: (async () => ({kind: 'completed'})) as never,
  });
  await recovered.start();
  unlinkSync(headPath);
  assert.throws(() => recovered.resume(handle.agentId), /fork-head-missing/u);
  writeFileSync(headPath, '{"schema":1,"broken":true}', 'utf8');
  assert.throws(() => recovered.resume(handle.agentId), /fork-head-missing/u);
});

test('P2.1 general 子代理 progress report 到父，不进用户通道', async (t) => {
  let reported = false;
  const fx = await make(t, async (deps) => {
    const report = deps.registry.get('report');
    assert.notEqual(report, null, 'general Profile 显式带 report');
    const result = await report!.handler({text: '中途进度'}, {
      callId: 'child', turn: 1, step: 1, signal: new AbortController().signal, workspaceRoot: fx.dir,
    } as never);
    reported = result.isError !== true;
    return {kind: 'completed'};
  });
  const handle = await fx.manager.delegate({task: 'general progress'}, {callId: 'general-progress', turn: 1});
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(reported, true);
  const events = await readAll(fx);
  assert.ok(events.some((event) => event.type === 'subagent/report'
    && (event.data as {kind: string}).kind === 'progress'));
  assert.ok(events.some((event) => event.type === 'wake/subagent'
    && (event.data as {kind?: string}).kind === 'progress'));
  assert.equal(events.some((event) => event.type === 'channel/message'), false);
  assert.equal(fx.manager.status(handle.agentId)?.status, 'completed');
});

test('P4.4 执行闸：locked 角色拒绝且 missing 可解释，general 与未知 Profile 语义不变', async (t) => {
  const fx = await make(t, async () => ({kind: 'completed'}));
  for (const profileId of ['researcher', 'worker', 'scribe']) {
    await assert.rejects(
      fx.manager.delegate({task: 'x', profileId, projectRoot: fx.dir}, {callId: `locked-${profileId}`, turn: 1}),
      (error) => {
        assert.match(String(error), /profile-locked/u);
        assert.match(String(error), /missing=/u);
        return true;
      },
    );
  }
  const general = await fx.manager.delegate({task: 'general'}, {callId: 'general', turn: 1});
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(fx.manager.status(general.agentId)?.status, 'completed');
  await assert.rejects(() => fx.manager.delegate({task: 'x', profileId: 'nope'}, {callId: 'nope', turn: 1}),
    /profile-unknown/u);
});

test('status 不泄漏绝对 workspace 路径', async (t) => {
  const fx = await make(t, async () => ({kind: 'completed'}));
  const handle = await fx.manager.delegate({task: 'x'}, {callId: 'status', turn: 1});
  await new Promise((resolve) => setTimeout(resolve, 10));
  const text = JSON.stringify(fx.manager.status(handle.agentId));
  assert.equal(text.includes(fx.dir), false);
  assert.equal(text.includes('workspace/'), false);
});

async function readAll(fx: Fixture): Promise<AppEvent[]> {
  const out: AppEvent[] = [];
  for await (const event of fx.log.readAll()) out.push(event);
  return out;
}

test('applySubagentEvent import is used by helper (keeps parent budget path explicit)', () => {
  const p = emptyProjection();
  const event = {
    seq: 1, ts: new Date().toISOString(), type: 'budget/consumed', visibility: 'internal', parentCallId: 'x',
    data: {
      turn: 1, step: 1, lane: 'heavy', model: 'm', inputTokens: 10, outputTokens: 5,
      cacheHitTokens: 0, cacheMissTokens: 10,
    },
  } as unknown as AppEvent;
  applySubagentEvent(p, event);
  assert.ok(p.budget.tokensToday > 0);
});
