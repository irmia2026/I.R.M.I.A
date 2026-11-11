/**
 * 后台子代理的工具面（2026-11-05 合并）：父级只注册两件 —— `delegate` + `subagent`。
 *
 * 这一份钉住合并后的契约（都是"静默坏掉"也看不出来的那几条）：
 *   ① 启用后父工具清单只有两件，旧三件（`subagent_message`/`subagent_cancel`/
 *      `subagent_status`）**不再注册**；
 *   ② `subagents.enabled=false` 时工厂一件都不给（父工具清单与缓存前缀不变）；
 *   ③ `subagent({action:'status'})` 的三种读法：全部未归档 / 单条 / 含归档；
 *   ④ `action:'message'` 运行中入 inbox、完成后自动 resume；`action:'cancel'` 取消
 *      running（AbortSignal）与 queued（直接出队）；
 *   ⑤ 缺 action / 未知 action / 缺 agentId / 空 message 都在 handler 里明确报错
 *      （不靠 JSON schema 的条件必填——运行期不做那个校验）；
 *   ⑥ 子代理内部 schema 保留 `delegate`/`subagent`，但执行期被递归 guard 拒绝
 *      （`subagent` 不许变成可递归创建）。
 *
 * 夹具与 `test/subagent-manager.test.ts` 同形（真 EventLog + 假 runTurnFn），区别只在
 * 父注册表里装的是 **createSubagentTools 的真产物**，于是 handler 的参数校验与错误码
 * 走的是生产路径，而不是测试替身。
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { emptyProjection, type AppEvent, type Projection } from '../src/log/types.ts';
import type { AgentLoopDeps } from '../src/runtime/agent-loop.ts';
import {
  SUBAGENT_TOOL_NAMES, SubagentManager, createSubagentTools,
} from '../src/runtime/subagent-manager.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { okResult, type ToolDefinition, type ToolHandlerResult } from '../src/tools/types.ts';
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

interface Fixture {
  dir: string;
  log: EventLog;
  projection: Projection;
  config: ReturnType<typeof defaultConfig>;
  registry: ToolRegistry;
  manager: SubagentManager;
  /** 工厂实际给出的工具（enabled=false 时是空数组） */
  tools: ToolDefinition[];
}

async function make(
  t: TestContext,
  options: {
    enabled?: boolean;
    runTurnFn?: (deps: AgentLoopDeps, wake: readonly AppEvent[]) => Promise<unknown>;
  } = {},
): Promise<Fixture> {
  const dir = tempDirSync('irmia-subagent-tools-');
  const log = await EventLog.open(join(dir, 'events'));
  t.after(() => {
    log.close();
    rmSync(dir, {recursive: true, force: true});
  });
  const config = defaultConfig(dir);
  config.subagents.enabled = options.enabled ?? true;
  config.subagents.maxConcurrent = 2;
  const registry = new ToolRegistry();
  // 父注册表的固定几件：子代理工具之外的基线（用来证明"清单不变"）
  for (const name of ['safe_read', 'safe_write', 'report']) registry.register(tool(name));
  const projection = emptyProjection();
  const manager = new SubagentManager({
    dataDir: dir,
    log,
    registry,
    projection,
    persona: PERSONA,
    ds: {} as never,
    config: () => config,
    now: () => new Date().toISOString(),
    timezone: 'Asia/Shanghai',
    runTurnFn: (options.runTurnFn ?? (async () => ({kind: 'completed'}))) as never,
  });
  await manager.start();
  const tools = createSubagentTools(manager);
  for (const def of tools) registry.register(def);
  return {dir, log, projection, config, registry, manager, tools};
}

/** 父 turn 的工具上下文（只填 handler 真会读的那几格） */
function ctxOf(fx: Fixture): never {
  return {
    callId: 'parent-call', turn: 1, step: 1,
    signal: new AbortController().signal, workspaceRoot: fx.dir,
  } as never;
}

async function call(fx: Fixture, args: unknown): Promise<ToolHandlerResult> {
  const def = fx.registry.get('subagent');
  assert.notEqual(def, null, 'subagent 工具必须已注册');
  return def!.handler(args, ctxOf(fx));
}

async function delegateTask(fx: Fixture, task: string): Promise<string> {
  const def = fx.registry.get('delegate');
  assert.notEqual(def, null, 'delegate 工具必须已注册');
  const result = await def!.handler({task}, ctxOf(fx));
  assert.equal(result.isError, undefined, result.content);
  return (JSON.parse(result.content) as {agentId: string}).agentId;
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`等待条件超时（${timeoutMs}ms）`);
}

test('启用后父工具清单：只有 delegate + subagent，旧三件不再注册', async (t) => {
  const fx = await make(t);
  assert.deepEqual(fx.tools.map((def) => def.name), ['delegate', 'subagent']);
  assert.deepEqual([...SUBAGENT_TOOL_NAMES], ['delegate', 'subagent']);
  assert.ok(fx.registry.has('delegate'), 'delegate 必须在');
  assert.ok(fx.registry.has('subagent'), 'subagent 必须在');
  for (const gone of ['subagent_message', 'subagent_cancel', 'subagent_status']) {
    assert.equal(fx.registry.get(gone), null, `${gone} 不许再注册（每轮都要为它付 schema）`);
  }
  const modelNames = fx.registry.listForModel({includeDestructive: true}).map((spec) => spec.name);
  assert.equal(modelNames.filter((name) => name === 'delegate').length, 1);
  assert.equal(modelNames.filter((name) => name === 'subagent').length, 1);
});

test('默认关闭：subagents.enabled=false 时一件都不注册，父工具清单不变', async (t) => {
  const fx = await make(t, {enabled: false});
  assert.equal(fx.manager.enabled, false);
  assert.deepEqual(fx.tools, [], 'enabled=false 时工厂不产出任何工具');
  assert.deepEqual(fx.registry.names().sort(), ['report', 'safe_read', 'safe_write'],
    '父工具清单与启用前逐字相同');
  for (const name of ['delegate', 'subagent']) {
    assert.equal(fx.registry.get(name), null, `${name} 默认关闭时不许出现`);
  }
});

test('subagent status：全部未归档 / 单条 / 归档（includeArchived）', async (t) => {
  const fx = await make(t);
  const agentId = await delegateTask(fx, '状态查询');
  await waitFor(() => fx.manager.status(agentId)?.status === 'completed');

  const all = await call(fx, {action: 'status'});
  assert.equal(all.isError, undefined, all.content);
  const items = (JSON.parse(all.content) as {items: Array<{agentId: string}>}).items;
  assert.deepEqual(items.map((item) => item.agentId), [agentId], '不带 agentId 返回全部未归档摘要');

  const single = await call(fx, {action: 'status', agentId});
  assert.equal(single.isError, undefined, single.content);
  const view = JSON.parse(single.content) as {
    agentId: string; status: string; canResume: boolean;
    lastReport?: unknown; parentCallId?: unknown; tokens?: unknown; profileLabel?: string;
  };
  assert.equal(view.agentId, agentId);
  assert.equal(view.status, 'completed');
  assert.equal(view.canResume, true);
  assert.equal(view.profileLabel, '通用');
  assert.equal(view.lastReport, undefined, 'status 不把完整报告塞回父上下文');
  assert.equal(view.parentCallId, undefined, 'status 不回父调用 id');
  assert.equal(view.tokens, undefined, 'status 不回 token 明细');
  const listText = all.content;
  assert.equal(listText.includes('"lastReport"'), false, '列表回执不包含完整 lastReport');
  assert.equal(listText.includes('"parentCallId"'), false, '列表回执不包含 parentCallId');

  assert.equal(fx.manager.archive(agentId), true);
  const afterArchive = await call(fx, {action: 'status'});
  assert.deepEqual((JSON.parse(afterArchive.content) as {items: unknown[]}).items, [],
    '未归档清单不再包含归档会话');
  const withArchived = await call(fx, {action: 'status', includeArchived: true});
  const archivedItems = (JSON.parse(withArchived.content) as {
    items: Array<{agentId: string; status: string}>;
  }).items;
  assert.deepEqual(archivedItems.map((item) => item.agentId), [agentId], 'includeArchived 才列归档');
  assert.equal(archivedItems[0]!.status, 'archived');
  const archivedSingle = await call(fx, {action: 'status', agentId});
  assert.equal((JSON.parse(archivedSingle.content) as {status: string}).status, 'archived',
    '单条按 id 仍可查归档');
});

test('subagent status：未知 agentId 明确报 subagent-not-found', async (t) => {
  const fx = await make(t);
  const result = await call(fx, {action: 'status', agentId: 'sub-0000000000000000'});
  assert.equal(result.isError, true);
  assert.equal(result.error?.code, 'subagent-not-found');
  assert.match(result.content, /subagent-not-found/u);
});

test('subagent message：完成后追加消息自动 resume，再跑一轮', async (t) => {
  const notes: string[] = [];
  const fx = await make(t, {
    runTurnFn: async (_deps, wake) => {
      notes.push(String((wake[0]?.data as {note?: string} | undefined)?.note ?? ''));
      return {kind: 'completed'};
    },
  });
  const agentId = await delegateTask(fx, '第一轮');
  await waitFor(() => fx.manager.status(agentId)?.status === 'completed');
  assert.equal(notes.length, 1);

  const resumed = await call(fx, {action: 'message', agentId, message: '接着做第二轮'});
  assert.equal(resumed.isError, undefined, resumed.content);
  const accepted = JSON.parse(resumed.content) as {accepted: boolean; queued: boolean; agentId: string};
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.queued, false, '完成态直接 resume，不是排队');
  assert.equal(accepted.agentId, agentId);

  await waitFor(() => notes.length === 2);
  assert.match(notes[0]!, /第一轮/u);
  assert.match(notes[1]!, /第二轮/u);
  await waitFor(() => fx.manager.status(agentId)?.status === 'completed');
});

test('subagent message：运行中入 inbox（queued=true），当前轮结束后继续', async (t) => {
  const notes: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  const fx = await make(t, {
    runTurnFn: async (_deps, wake) => {
      notes.push(String((wake[0]?.data as {note?: string} | undefined)?.note ?? ''));
      if (first) {
        first = false;
        await gate;
      }
      return {kind: 'completed'};
    },
  });
  const agentId = await delegateTask(fx, '长活');
  await waitFor(() => fx.manager.status(agentId)?.status === 'running');

  const queued = await call(fx, {action: 'message', agentId, message: '补一句'});
  assert.equal(queued.isError, undefined, queued.content);
  const accepted = JSON.parse(queued.content) as {queued: boolean};
  assert.equal(accepted.queued, true, '运行中进 inbox');
  release();

  await waitFor(() => notes.length === 2);
  assert.match(notes[1]!, /补一句/u);
  await waitFor(() => fx.manager.status(agentId)?.status === 'completed');
});

test('subagent cancel：运行中触发 AbortSignal，状态 cancelled', async (t) => {
  let seenSignal: AbortSignal | null = null;
  const fx = await make(t, {
    runTurnFn: async (deps) => {
      seenSignal = deps.signal ?? null;
      await new Promise<void>((resolve) => {
        if (deps.signal?.aborted === true) resolve();
        else deps.signal?.addEventListener('abort', () => resolve(), {once: true});
      });
      return {kind: 'aborted', cause: 'signal'};
    },
  });
  const agentId = await delegateTask(fx, '长任务');
  await waitFor(() => fx.manager.status(agentId)?.status === 'running');

  const cancelled = await call(fx, {action: 'cancel', agentId, reason: '测试取消'});
  assert.equal(cancelled.isError, undefined, cancelled.content);
  assert.equal((JSON.parse(cancelled.content) as {cancelled: boolean}).cancelled, true);
  await waitFor(() => fx.manager.status(agentId)?.status === 'cancelled');
  assert.notEqual(seenSignal, null, '取消必须走 AbortSignal');
});

test('subagent cancel：queued 直接取消，不进入 running', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = 0;
  const fx = await make(t, {
    runTurnFn: async () => {
      started += 1;
      await gate;
      return {kind: 'completed'};
    },
  });
  fx.config.subagents.maxConcurrent = 1;
  const first = await delegateTask(fx, '第一条');
  const second = await delegateTask(fx, '第二条');
  await waitFor(() => fx.manager.status(first)?.status === 'running');
  assert.equal(fx.manager.status(second)?.status, 'queued');

  const cancelled = await call(fx, {action: 'cancel', agentId: second});
  assert.equal(cancelled.isError, undefined, cancelled.content);
  assert.equal(fx.manager.status(second)?.status, 'cancelled');
  assert.equal(started, 1, 'queued 的那条一次模型都没调');
  release();
  await waitFor(() => fx.manager.status(first)?.status === 'completed');
});

test('subagent 参数错误：缺 action / 未知 action / 缺 agentId / 空 message 都明确', async (t) => {
  const fx = await make(t);
  const cases: Array<[string, unknown, RegExp]> = [
    ['缺 action', {}, /缺少必填参数 action/u],
    ['未知 action', {action: 'kill'}, /action 只能是 status \/ message \/ cancel/u],
    ['message 缺 agentId', {action: 'message', message: 'x'}, /缺少必填参数 agentId/u],
    ['cancel 缺 agentId', {action: 'cancel'}, /缺少必填参数 agentId/u],
    ['message 空串', {action: 'message', agentId: 'sub-0000000000000000', message: '   '},
      /message 不能为空/u],
    ['action 类型错', {action: 42}, /action 必须是字符串/u],
  ];
  for (const [label, args, pattern] of cases) {
    const result = await call(fx, args);
    assert.equal(result.isError, true, `${label} 必须报错`);
    assert.equal(result.error?.code, 'E_INVALID_ARGS', `${label} 的错误码`);
    assert.match(result.content, pattern, label);
  }
});

test('子代理内部：schema 保留 delegate/subagent，执行期递归 guard 拒绝', async (t) => {
  let childRegistry: ToolRegistry | null = null;
  const fx = await make(t, {
    runTurnFn: async (deps) => {
      childRegistry = deps.registry;
      return {kind: 'completed'};
    },
  });
  const agentId = await delegateTask(fx, '检查递归');
  await waitFor(() => fx.manager.status(agentId)?.status === 'completed');
  assert.notEqual(childRegistry, null);

  for (const name of ['delegate', 'subagent']) {
    const def = childRegistry!.get(name);
    assert.notEqual(def, null, `${name} 的 schema 必须保留（禁用不摘除）`);
    const result = await def!.handler({action: 'status'}, ctxOf(fx));
    assert.equal(result.isError, true, `${name} 必须执行期拒绝`);
    assert.equal(result.error?.code, 'depth-exceeded');
  }
  // 「subagent 不得变成可递归创建」：子代理里那次调用没有真的建出第三个会话
  assert.deepEqual(fx.manager.list(true).map((item) => item['agentId']), [agentId]);
});
