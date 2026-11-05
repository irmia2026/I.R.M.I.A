import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { defaultVisibility, emptyProjection, type AppEvent } from '../src/log/types.ts';
import type { DsClient, DsRequest } from '../src/model/ds-client.ts';
import { inputContentText, render, renderInstructions, type RenderInput } from '../src/model/render.ts';
import type { AgentLoopDeps } from '../src/runtime/agent-loop.ts';
import {
  compactCutoff, readingForRequest, type SubagentCompactSummary,
} from '../src/runtime/subagent-compaction.ts';
import { SubagentManager, type SubagentModelCapabilities } from '../src/runtime/subagent-manager.ts';
import { SubagentProfileRegistry } from '../src/runtime/subagent-profiles.ts';
import { applyOne } from '../src/state/fold.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { okResult, type ToolDefinition } from '../src/tools/types.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const PERSONA = {identity: 'test', constitution: 'test', style: 'test', state: '', personaHash: 'hash'};
const SUMMARY: SubagentCompactSummary = {
  goal: '完成调研', task: 'summary-task', constraints: ['不丢原始日志'], plan: '继续',
  progress: '已完成三轮', decisions: ['保留最近两轮'], artifacts: [{path: 'notes/a.md', summary: '笔记'}],
  openQuestions: ['下一步？'], recentTurns: [{turn: 3, summary: '第三轮'}],
  toolResultsIndex: [{callId: 'call-tool', tool: 'safe_read', seq: 4, summary: '完整结果仍在日志'}],
};

function tool(name: string): ToolDefinition {
  return {
    name, description: name, parameters: {type: 'object', properties: {}, additionalProperties: false},
    executionMode: 'parallel', sideEffect: 'none', timeoutMs: 1000, handler: async () => okResult('ok'),
  };
}

async function make(t: TestContext, options: {
  runTurnFn?: (deps: AgentLoopDeps, wakes: readonly AppEvent[]) => Promise<unknown>;
  compactFn?: (input: unknown) => Promise<unknown>;
  ds?: DsClient;
  effort?: string;
  contextLimit?: number;
  modelCapabilities?: SubagentModelCapabilities;
} = {}) {
  const dir = tempDirSync('irmia-subagent-context-');
  const log = await EventLog.open(join(dir, 'events'));
  t.after(() => {
    log.close();
    rmSync(dir, {recursive: true, force: true});
  });
  mkdirSync(join(dir, 'subagents'), {recursive: true});
  writeFileSync(join(dir, 'subagents', 'profiles.json'), JSON.stringify({profiles: [{
    id: 'context-test', label: '上下文测试', description: '', systemPrompt: '',
    tools: ['read', 'report'], workspace: 'own', workdir: 'workspace', shell: 'none',
    skills: [], mcpServers: [], reasoningEffort: options.effort ?? 'max',
    contextLimit: options.contextLimit ?? 100_000, compactAt: 0.5, maxTurns: 20,
  }]}), 'utf8');
  const registry = new ToolRegistry();
  for (const name of ['safe_read', 'read_blob', 'grep', 'find', 'report', 'delegate', 'subagent', 'task']) {
    registry.register(tool(name));
  }
  const config = defaultConfig(dir);
  config.subagents.enabled = true;
  const manager = new SubagentManager({
    dataDir: dir, log, registry, projection: emptyProjection(), persona: PERSONA,
    ds: options.ds ?? ({} as DsClient), config: () => config, now: () => new Date().toISOString(),
    timezone: 'Asia/Shanghai',
    ...(options.runTurnFn === undefined ? {} : {runTurnFn: options.runTurnFn as never}),
    ...(options.compactFn === undefined ? {} : {compactFn: options.compactFn as never}),
    ...(options.modelCapabilities === undefined ? {} : {modelCapabilities: options.modelCapabilities}),
  });
  await manager.start();
  return {dir, log, config, registry, manager};
}

async function all(log: EventLog): Promise<AppEvent[]> {
  const events: AppEvent[] = [];
  for await (const event of log.readAll()) events.push(event);
  return events;
}

async function settled(manager: SubagentManager, agentId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i += 1) {
    const view = manager.status(agentId);
    if (view !== null && ['completed', 'interrupted', 'cancelled'].includes(String(view['status']))) return view;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`subagent did not settle: ${JSON.stringify(manager.status(agentId))}`);
}

function childEvent(deps: AgentLoopDeps, type: string, data: unknown): AppEvent {
  const event = {
    seq: deps.log.nextSeq(), ts: deps.now(), type, data,
    visibility: defaultVisibility(type), parentCallId: deps.parentCallId, agentId: deps.agentId,
  } as unknown as AppEvent;
  deps.log.append(event, {sync: true});
  applyOne(deps.projection, event);
  deps.onEvent?.(event);
  return event;
}

function fakeRequest(tokens: number) {
  return {context: {instructions: {tokens: 0}, tools: {tokens: 0}, input: {tokens}}} as never;
}

function compactResult() {
  return {
    summary: SUMMARY,
    usage: {inputTokens: 100, outputTokens: 20, cachedTokens: 0, reasoningTokens: 3},
    usageMissing: false, model: 'compact-test',
  };
}

test('P4.2 读数：Provider prompt tokens 优先，缺失时明确使用请求估算；cutoff 保留最近两轮', () => {
  const request = {context: {instructions: {tokens: 10}, tools: {tokens: 20}, input: {tokens: 30}}};
  assert.deepEqual(readingForRequest(request, 700), {tokens: 700, source: 'provider'});
  assert.deepEqual(readingForRequest(request, null), {tokens: 60, source: 'estimated'});
  const event = (seq: number, type = 'turn/end') => ({seq, type, parentCallId: 'call'}) as AppEvent;
  assert.equal(compactCutoff([event(1), event(2), event(3), event(4)], 'call', undefined, 0), 2);
  assert.equal(compactCutoff([event(1), event(2)], 'call', undefined, 0), null);
});

test('P4.2 Provider 能力预检：不支持的 effort/context 明确拒绝，不创建会话', async (t) => {
  const noEffort = await make(t, {modelCapabilities: {contextLimit: 100_000, reasoningEfforts: ['high']}});
  await assert.rejects(
    noEffort.manager.delegate({profileId: 'context-test', task: 'task'}, {callId: 'a', turn: 1}),
    /reasoning-effort-unsupported/u,
  );
  const noContext = await make(t, {modelCapabilities: {contextLimit: 50_000, reasoningEfforts: ['max']}});
  await assert.rejects(
    noContext.manager.delegate({profileId: 'context-test', task: 'task'}, {callId: 'b', turn: 1}),
    /context-limit-unsupported/u,
  );
});

test('P4.2 reasoningEffort 真进模型请求，并冻结到 session；resume 不取 Profile 新值', async (t) => {
  let resolveFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { resolveFirst = resolve; });
  const requests: DsRequest[] = [];
  const ds = {
    modelFor: () => 'm',
    subscribeRetry: () => () => undefined,
    stream: async (request: DsRequest) => {
      requests.push(request);
      if (requests.length === 1) await firstGate;
      return {
        status: 'completed', text: 'done', reasoning: '', toolCalls: [],
        outputItems: [{type: 'message', id: 'm', text: 'done'}],
        usage: {inputTokens: 10, outputTokens: 2, cachedTokens: 0, reasoningTokens: 0},
        incompleteReason: null, model: 'm', responseId: null, durationMs: 1,
        interrupted: false, failure: null,
      };
    },
  } as unknown as DsClient;
  const fx = await make(t, {ds});
  const handle = await fx.manager.delegate({profileId: 'context-test', task: 'task'}, {callId: 'call', turn: 1});
  await new Promise((resolve) => setTimeout(resolve, 10));
  resolveFirst();
  await settled(fx.manager, handle.agentId);
  assert.deepEqual(requests[0]?.reasoning, {effort: 'max'});
  const sessionPath = join(fx.dir, 'subagents', 'sessions', handle.agentId, 'session.json');
  const saved = JSON.parse(readFileSync(sessionPath, 'utf8')) as Record<string, unknown>;
  assert.equal(saved['reasoningEffort'], 'max');
  assert.equal(saved['reasoningEffortApplied'], 'max');
  assert.equal(saved['contextLimit'], 100_000);

  writeFileSync(join(fx.dir, 'subagents', 'profiles.json'), JSON.stringify({profiles: [{
    id: 'context-test', label: '上下文测试', tools: ['read'], workspace: 'own',
    reasoningEffort: 'low', contextLimit: 20, compactAt: 0.9,
  }]}), 'utf8');
  const profiles = new SubagentProfileRegistry(fx.dir);
  const recovered = new SubagentManager({
    dataDir: fx.dir, log: fx.log, registry: fx.registry, projection: emptyProjection(), persona: PERSONA,
    ds, config: () => fx.config, now: () => new Date().toISOString(), timezone: 'Asia/Shanghai', profiles,
  });
  await recovered.start();
  recovered.message(handle.agentId, 'continue');
  await settled(recovered, handle.agentId);
  assert.deepEqual(requests[1]?.reasoning, {effort: 'max'});
  assert.equal(recovered.status(handle.agentId)?.['contextLimit'], 100_000);
});

async function driveCompact(t: TestContext, failCompact: boolean) {
  let compactCalls = 0;
  let turns = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fx = await make(t, {
    contextLimit: 1000,
    compactFn: (async () => {
      compactCalls += 1;
      if (failCompact) throw new Error('model unavailable');
      return compactResult();
    }) as never,
    runTurnFn: (async (deps: AgentLoopDeps, wakes: readonly AppEvent[]) => {
      if (turns === 0) await gate;
      const verdict = deps.contextGuard?.(fakeRequest(compactCalls === 0 && turns >= 3 ? 600 : 10), null) ?? null;
      if (verdict !== null) return verdict;
      turns += 1;
      const turn = deps.turnBase! + 1;
      childEvent(deps, 'turn/start', {turn});
      if (turns === 1) {
        childEvent(deps, 'tool/result', {callId: 'call-tool', content: 'full-original-result', status: 'ok'});
      }
      childEvent(deps, 'turn/end', {turn, reason: {kind: 'completed'}, spoke: false});
      return {kind: 'completed'};
    }) as never,
  });
  const handle = await fx.manager.delegate({profileId: 'context-test', task: 'initial-task'}, {callId: 'call', turn: 0});
  fx.manager.message(handle.agentId, 'message-1');
  fx.manager.message(handle.agentId, 'message-2');
  fx.manager.message(handle.agentId, 'message-3');
  release();
  const view = await settled(fx.manager, handle.agentId);
  return {fx, handle, view, compactCalls};
}

test('P4.2 compact：结构化字段、最近原始轮次、完整日志、计账与 resumed 请求都成立', async (t) => {
  const {fx, handle, view, compactCalls} = await driveCompact(t, false);
  assert.equal(view['status'], 'completed');
  assert.equal(compactCalls, 1);
  assert.equal(view['compactCount'], 1);
  assert.equal(view['contextTokenSource'], 'estimated');
  assert.equal(view['reasoningEffortApplied'], 'max');
  const usedBeforeResume = (view['tokens'] as {used: number}).used;
  fx.manager.message(handle.agentId, 'after-resume');
  const resumed = await settled(fx.manager, handle.agentId);
  assert.equal(resumed['compactCount'], 1, 'resume 不重复生成摘要');
  assert.equal((resumed['tokens'] as {used: number}).used, usedBeforeResume, 'resume 不重复计 compact 账');
  const events = await all(fx.log);
  const compacted = events.find((event) => event.type === 'subagent/compacted');
  assert.ok(compacted !== undefined);
  const data = compacted.data as Record<string, unknown>;
  for (const key of ['goal', 'task', 'constraints', 'plan', 'progress', 'decisions', 'artifacts', 'openQuestions', 'recentTurns', 'toolResultsIndex']) {
    assert.ok(key in (data['summary'] as Record<string, unknown>), key);
  }
  assert.equal(events.some((event) => JSON.stringify(event.data).includes('full-original-result')), true);
  assert.equal(view['tokens'] && (view['tokens'] as {used: number}).used >= 120, true);

  const child = events.filter((event) => event.parentCallId === handle.agentId || event.parentCallId === 'call');
  const input = {
    events: child, persona: PERSONA, tools: [], wakeEvent: null, taskCard: null,
    now: '2026-11-05T10:00:00.000+08:00', timezone: 'Asia/Shanghai', model: 'm', lane: 'heavy' as const,
    contact: null, mentionNotice: null, machine: null, usage: null, asks: null, injection: null,
    loadImage: null, softHint: null, memoryIndex: null, skillCatalog: null, turnBlock: null,
    stateBytes: null, stateBudgetBytes: null,
  } satisfies RenderInput;
  const rendered = render(input);
  assert.equal(rendered.instructions, renderInstructions(PERSONA));
  const serialized = JSON.stringify(rendered.input);
  assert.equal(serialized.includes('summary-task'), true);
  assert.equal(serialized.includes('initial-task'), false, '被摘要覆盖的旧轮次不再重放');
  assert.equal(serialized.includes('message-3'), true, '最近两轮原始消息仍保留');
  assert.equal(serialized.includes('上下文已压缩'), true);
  const texts = rendered.input.filter((item) => item.type === 'message')
    .map((item) => inputContentText(item.content)).join('\n');
  assert.match(texts, /子代理结构化上下文摘要/u);
});

test('P4.2 compact 失败：不遮蔽、不截断，interrupted + compact-failed 并通知父代理', async (t) => {
  const {fx, handle, view, compactCalls} = await driveCompact(t, true);
  assert.equal(compactCalls, 1);
  assert.equal(view['status'], 'interrupted');
  assert.equal(view['headError'], 'compact-failed');
  const events = await all(fx.log);
  assert.equal(events.some((event) => event.type === 'compaction/summary'), false);
  assert.equal(events.some((event) => JSON.stringify(event.data).includes('full-original-result')), true);
  const interrupted = events.find((event) => event.type === 'subagent/interrupted');
  assert.equal((interrupted?.data as {reason?: string}).reason, 'compact-failed');
  const wake = events.find((event) => event.type === 'wake/subagent');
  assert.match(String((wake?.data as {summary?: string}).summary), /compact-failed/u);
});
