/**
 * 工具注册表 + 执行池测试（milestones.md M2-3 / M2-4 / M2-5 / M2-6 / M2-7 / M2-8 / M2-11）
 *
 * 覆盖面：
 *   - M2-3 顺序提交：第 3 个先完成，日志里的结果顺序仍是 1→2→3，且 result 的 callSeq 指回对应 call
 *   - M2-4 并发生效：4 个各 1s 的 parallel 工具总耗时 < 1.6s
 *   - M2-5 屏障生效：parallel 中间插一个 exclusive，exclusive 期间没有别的工具在跑
 *   - M2-6 超时处理：超时得 status 'timeout'，循环继续跑后续调用
 *   - M2-7 参数容错：非法 JSON 照原样落库 + 可读错误，进程不崩
 *   - M2-8 未知工具：返回可用清单（destructive 默认不在清单里），循环继续
 *   - M2-11 僵尸检测：不响应 AbortSignal 的 handler 迟到完成 → tool/zombie；
 *            子进程隔离路径超时即杀，杀后迟到输出 → tool/zombie
 *   - registry：描述预算拒绝注册、destructive 默认不列、重名保护、executionMode 每次重读
 *
 * 落库用真实 EventLog（write + fsync），断言直接读日志——这是"顺序保证"唯一可信的证据来源。
 *
 * 说明：Node 的类型剥离不做 `.js` → `.ts` 映射，所以这里用显式 `.ts` 说明符导入源码。
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent, ToolCall, ToolResult, ToolZombie } from '../src/log/types.ts';
import { defaultVisibility } from '../src/log/types.ts';
import {
  DEFAULT_ZOMBIE_GRACE_MS, MAX_CONCURRENCY, defaultIsolatedSpawner, executeToolCalls,
  type ExecutionContext, type IsolatedProcess, type IsolatedTask, type IsolationConfig,
  type ToolCallRequest,
} from '../src/tools/executor.ts';
import {
  MAX_DESCRIPTION_TOKENS, ToolDescriptionBudgetError, ToolRegistry, estimateTokens,
  type ListForModelOptions, type ToolDefinition, type ToolHandlerResult,
} from '../src/tools/registry.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const TURN = 7;
const STEP = 2;
const EPOCH_MS = 1_780_000_000_000;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 轮询等待条件成立；失败即抛，避免用固定 sleep 掩盖竞态 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`等待条件超时（${timeoutMs}ms）`);
}

type ToolOverrides = Partial<Omit<ToolDefinition, 'name'>> & { name: string };

function makeTool(overrides: ToolOverrides): ToolDefinition {
  const base = {
    description: '测试用工具',
    parameters: { type: 'object', properties: {} },
    executionMode: 'parallel' as const,
    sideEffect: 'none' as const,
    timeoutMs: 5000,
    handler: async (): Promise<ToolHandlerResult> => ({ content: 'ok' }),
  };
  // 逐键合并并丢掉 undefined：exactOptionalPropertyTypes 下不能让可选字段收到显式 undefined
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as unknown as ToolDefinition;
}

function call(id: string, name: string, args: unknown = {}, raw?: string): ToolCallRequest {
  return { callId: id, name, arguments: raw ?? JSON.stringify(args) };
}

interface HarnessOptions {
  isolation?: IsolationConfig;
  signal?: AbortSignal;
  maxConcurrency?: number;
  modelVisibility?: ListForModelOptions;
}

interface Harness {
  dataDir: string;
  log: EventLog;
  /** 按落库顺序记录的事件（与日志内容一致，省去反复读盘） */
  events: AppEvent[];
  zombies: Array<{ callId: string; name: string; note: string; callSeq: number }>;
  ctx: ExecutionContext;
}

async function setup(
  t: TestContext,
  registry: ToolRegistry,
  options: HarnessOptions = {},
): Promise<Harness> {
  const dataDir = tempDirSync('irmia-tools-');
  const log = await EventLog.open(join(dataDir, 'events'));
  t.after(() => {
    // Windows 下必须先关 fd 才能删目录
    try {
      log.close();
    } catch {
      // 已关闭：清理阶段忽略
    }
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  });

  const events: AppEvent[] = [];
  const zombies: Harness['zombies'] = [];

  const append = (type: string, data: unknown): AppEvent => {
    const event = {
      seq: log.nextSeq(),
      ts: new Date(EPOCH_MS + events.length).toISOString(),
      type,
      data,
      visibility: defaultVisibility(type),
      origin: 'test/tools',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    events.push(event);
    return event;
  };

  const ctx: ExecutionContext = {
    registry,
    turn: TURN,
    step: STEP,
    workspaceRoot: dataDir,
    // 阶段一：tool/call 先落库并 fsync（承诺类，review.md 缺陷 1）
    onToolCall: (req) => append('tool/call', {
      turn: TURN,
      step: STEP,
      callId: req.callId,
      name: req.name,
      arguments: req.arguments,
      sideEffect: registry.get(req.name)?.sideEffect ?? 'none',
    }).seq,
    // 阶段二：tool/result 后落库，引用 callSeq
    onToolResult: (req, result, callSeq) => {
      append('tool/result', {
        turn: TURN,
        step: STEP,
        callId: req.callId,
        callSeq,
        status: result.status,
        content: result.content,
        durationMs: result.durationMs,
        ...(result.error !== undefined ? { error: result.error } : {}),
      });
    },
    onToolZombie: (req, note, callSeq) => {
      zombies.push({ callId: req.callId, name: req.name, note, callSeq });
      append('tool/zombie', { callId: req.callId, name: req.name, note });
    },
  };
  if (options.isolation !== undefined) ctx.isolation = options.isolation;
  if (options.signal !== undefined) ctx.signal = options.signal;
  if (options.maxConcurrency !== undefined) ctx.maxConcurrency = options.maxConcurrency;
  if (options.modelVisibility !== undefined) ctx.modelVisibility = options.modelVisibility;

  return { dataDir, log, events, zombies, ctx };
}

function callsIn(events: readonly AppEvent[]): ToolCall[] {
  return events.filter((e): e is ToolCall => e.type === 'tool/call');
}

function resultsIn(events: readonly AppEvent[]): ToolResult[] {
  return events.filter((e): e is ToolResult => e.type === 'tool/result');
}

function zombiesIn(events: readonly AppEvent[]): ToolZombie[] {
  return events.filter((e): e is ToolZombie => e.type === 'tool/zombie');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ──────────────────────────────── registry ────────────────────────────────

test('registry：描述超预算拒绝注册（每件 ≤100 token）', () => {
  const registry = new ToolRegistry();
  const longDescription = '这是一段故意写得很长的工具描述，用来验证描述预算审查。'.repeat(10);
  assert.ok(estimateTokens(longDescription) > MAX_DESCRIPTION_TOKENS);

  assert.throws(
    () => registry.register(makeTool({ name: 'too_big', description: longDescription })),
    (error: unknown) => {
      assert.ok(error instanceof ToolDescriptionBudgetError);
      assert.equal(error.toolName, 'too_big');
      assert.equal(error.limit, MAX_DESCRIPTION_TOKENS);
      return true;
    },
  );
  assert.equal(registry.size, 0, '被拒绝的工具不能留在注册表里');

  // 预算内的正常描述可以注册，且总清单 token 可观测（design §4.18 的 2k 常驻线）
  registry.register(makeTool({ name: 'read_file', description: '读取工作目录内的文件内容，支持偏移与行数上限。' }));
  assert.equal(registry.size, 1);
  assert.ok(registry.catalogTokens() > 0);
});

test('registry：destructive 默认不进模型清单，配置显式开启才列', () => {
  const registry = new ToolRegistry();
  registry.register(makeTool({ name: 'read_file' }));
  registry.register(makeTool({ name: 'set_timer', sideEffect: 'idempotent' }));
  registry.register(makeTool({ name: 'safe_edit', sideEffect: 'destructive' }));

  assert.deepEqual(registry.listForModel().map((s) => s.name), ['read_file', 'set_timer']);
  assert.deepEqual(
    registry.listForModel({ includeDestructive: true }).map((s) => s.name),
    ['read_file', 'set_timer', 'safe_edit'],
  );
  assert.deepEqual(
    registry.listForModel({ includeDestructive: ['safe_edit'] }).map((s) => s.name),
    ['read_file', 'set_timer', 'safe_edit'],
  );
  assert.deepEqual(
    registry.listForModel({ includeDestructive: ['other_tool'] }).map((s) => s.name),
    ['read_file', 'set_timer'],
  );
  // 清单顺序 = 注册顺序（渲染确定性），覆盖注册不改变位置
  registry.register(makeTool({ name: 'read_file', description: '改过的描述' }), { replace: true });
  assert.deepEqual(registry.listForModel().map((s) => s.name), ['read_file', 'set_timer']);
});

test('registry：重名拒绝、replace 覆盖、executionMode 每次查表', () => {
  const registry = new ToolRegistry();
  registry.register(makeTool({ name: 'a' }));
  assert.throws(() => registry.register(makeTool({ name: 'a' })), /已经注册过/);

  registry.register(makeTool({ name: 'a', executionMode: 'exclusive' }), { replace: true });
  assert.equal(registry.executionMode('a'), 'exclusive');
  // 未知工具按最保守处理：单独成组当前后屏障
  assert.equal(registry.executionMode('不存在'), 'exclusive');
  assert.equal(registry.get('不存在'), null);
  assert.deepEqual(registry.names(), ['a']);
  assert.equal(registry.unregister('a'), true);
  assert.equal(registry.unregister('a'), false);
});

// ──────────────────────────────── 执行池 ────────────────────────────────

test('M2-3 顺序提交：第 3 个先完成，日志里结果顺序仍是 1→2→3', async (t) => {
  const registry = new ToolRegistry();
  const completionOrder: string[] = [];
  const timed = (name: string, ms: number): ToolDefinition => makeTool({
    name,
    handler: async () => {
      await sleep(ms);
      completionOrder.push(name);
      return { content: `${name} 完成` };
    },
  });
  registry.register(timed('tool_a', 120));
  registry.register(timed('tool_b', 60));
  registry.register(timed('tool_c', 20));
  const h = await setup(t, registry);

  const records = await executeToolCalls(
    [call('c1', 'tool_a'), call('c2', 'tool_b'), call('c3', 'tool_c')],
    h.ctx,
  );

  // 完成顺序刻意反着来
  assert.deepEqual(completionOrder, ['tool_c', 'tool_b', 'tool_a']);

  const callEvents = callsIn(h.events);
  const resultEvents = resultsIn(h.events);
  assert.deepEqual(callEvents.map((e) => e.data.callId), ['c1', 'c2', 'c3']);
  assert.deepEqual(resultEvents.map((e) => e.data.callId), ['c1', 'c2', 'c3'], '提交顺序必须等于调用顺序');

  // 配对与 seq 关系（schema §12 不变量 2/9）
  for (const record of records) {
    const matched = resultEvents.find((e) => e.data.callId === record.call.callId);
    assert.ok(matched !== undefined, `${record.call.callId} 必须有结果`);
    assert.equal(matched.data.callSeq, record.callSeq);
    assert.equal(matched.data.status, 'ok');
    const source = callEvents.find((e) => e.seq === matched.data.callSeq);
    assert.ok(source !== undefined, 'callSeq 必须指回一条真实的 tool/call');
    assert.ok(matched.seq > source.seq, '结果必须写在它的调用之后');
  }
  // 两阶段落库：日志里每条结果都出现在它自己的调用之后，且每条调用只有一条结果
  assert.equal(resultEvents.length, callEvents.length);
});

test('M2-4 并发生效：4 个耗时 1 秒的 parallel 工具总耗时 < 1.6 秒', async (t) => {
  const registry = new ToolRegistry();
  for (const name of ['p1', 'p2', 'p3', 'p4']) {
    registry.register(makeTool({
      name,
      timeoutMs: 5000,
      handler: async () => {
        await sleep(1000);
        return { content: `${name} done` };
      },
    }));
  }
  const h = await setup(t, registry);

  const started = Date.now();
  const records = await executeToolCalls(
    [call('p1', 'p1'), call('p2', 'p2'), call('p3', 'p3'), call('p4', 'p4')],
    h.ctx,
  );
  const elapsed = Date.now() - started;

  assert.equal(MAX_CONCURRENCY, 4, '并发度默认 4（design §4.5）');
  assert.equal(records.length, 4);
  assert.ok(elapsed >= 1000, `总耗时 ${elapsed}ms 说明工具确实各自跑满了 1 秒`);
  assert.ok(elapsed < 1600, `4 个 1 秒的 parallel 工具总耗时 ${elapsed}ms 应 < 1600ms`);
});

test('M2-5 屏障生效：exclusive 执行期间没有其他工具在跑', async (t) => {
  const registry = new ToolRegistry();
  const intervals = new Map<string, { start: number; end: number }>();
  let active = 0;
  let maxActiveWhileExclusive = 0;

  const tracked = (name: string, ms: number, mode: 'parallel' | 'exclusive'): ToolDefinition => makeTool({
    name,
    executionMode: mode,
    handler: async () => {
      const start = Date.now();
      active += 1;
      if (mode === 'exclusive') maxActiveWhileExclusive = Math.max(maxActiveWhileExclusive, active);
      else if (intervals.has('ex') && intervals.get('ex')!.end === 0) {
        // 其他工具在 exclusive 还没结束时就在跑：记账，最后断言
        maxActiveWhileExclusive = Math.max(maxActiveWhileExclusive, active);
      }
      await sleep(ms);
      active -= 1;
      intervals.set(name, { start, end: Date.now() });
      return { content: name };
    },
  });
  registry.register(tracked('p1', 200, 'parallel'));
  registry.register(tracked('p2', 200, 'parallel'));
  registry.register(tracked('ex', 200, 'exclusive'));
  registry.register(tracked('p3', 200, 'parallel'));
  const h = await setup(t, registry);

  const started = Date.now();
  const records = await executeToolCalls(
    [call('1', 'p1'), call('2', 'p2'), call('3', 'ex'), call('4', 'p3')],
    h.ctx,
  );
  const elapsed = Date.now() - started;

  assert.deepEqual(records.map((r) => r.result.status), ['ok', 'ok', 'ok', 'ok']);
  assert.equal(maxActiveWhileExclusive, 1, 'exclusive 运行时活跃工具数只能是 1');

  const exclusive = intervals.get('ex');
  assert.ok(exclusive !== undefined);
  for (const [name, iv] of intervals) {
    if (name === 'ex') continue;
    const overlaps = iv.start < exclusive.end && iv.end > exclusive.start;
    assert.equal(overlaps, false, `${name} 的区间与 exclusive 重叠：${JSON.stringify({ iv, exclusive })}`);
  }
  // [p1,p2] → [ex] → [p3]：三组串行，至少 600ms；若被并行吞掉会明显更快
  assert.ok(elapsed >= 560, `屏障生效时应串行三组，实测 ${elapsed}ms`);
});

test('M2-6 超时处理：超时得 timeout 结果，循环继续', async (t) => {
  const registry = new ToolRegistry();
  registry.register(makeTool({
    name: 'never_returns',
    timeoutMs: 80,
    // 永不 settle 且不响应 signal：超时是唯一出路
    handler: () => new Promise<ToolHandlerResult>(() => {}),
  }));
  registry.register(makeTool({
    name: 'after_timeout',
    handler: async () => ({ content: '循环继续跑完了这一条' }),
  }));
  const h = await setup(t, registry);

  const records = await executeToolCalls(
    [call('t1', 'never_returns'), call('t2', 'after_timeout')],
    h.ctx,
  );

  assert.equal(records[0]!.result.status, 'timeout');
  assert.equal(records[0]!.result.error?.code, 'TOOL_TIMEOUT');
  assert.match(records[0]!.result.content, /超时/);
  assert.equal(records[1]!.result.status, 'ok');
  assert.equal(records[1]!.result.content, '循环继续跑完了这一条');

  const statuses = resultsIn(h.events).map((e) => e.data.status);
  assert.deepEqual(statuses, ['timeout', 'ok']);
});

test('M2-7 参数容错：非法 JSON 照原样落库并回可读错误，进程不崩', async (t) => {
  const registry = new ToolRegistry();
  registry.register(makeTool({
    name: 'echo',
    handler: async (args) => ({ content: JSON.stringify(args) }),
  }));
  const h = await setup(t, registry);

  const broken = call('b1', 'echo', {}, '{"path": ');
  const records = await executeToolCalls(
    [broken, call('b2', 'echo'), call('b3', 'echo', {}, '')],
    h.ctx,
  );

  assert.equal(records[0]!.result.status, 'error');
  assert.equal(records[0]!.result.error?.code, 'INVALID_JSON_ARGUMENTS');
  assert.match(records[0]!.result.content, /不是合法 JSON/);
  assert.match(records[0]!.result.content, /原文已照原样落库/);

  // 原文落库：模型原样说了什么，日志里就是什么（schema §4）
  assert.equal(callsIn(h.events)[0]!.data.arguments, '{"path": ');

  // 非法参数不拖累同组其余调用；空参数按无参调用处理
  assert.equal(records[1]!.result.status, 'ok');
  assert.equal(records[1]!.result.content, '{}');
  assert.equal(records[2]!.result.status, 'ok');
  assert.equal(records[2]!.result.content, '{}');
});

test('M2-8 未知工具：返回可用清单，循环继续', async (t) => {
  const registry = new ToolRegistry();
  registry.register(makeTool({ name: 'read_file' }));
  registry.register(makeTool({ name: 'set_timer', sideEffect: 'idempotent' }));
  registry.register(makeTool({ name: 'safe_edit', sideEffect: 'destructive' }));
  const h = await setup(t, registry);

  const records = await executeToolCalls(
    [call('u1', 'no_such_tool'), call('u2', 'read_file')],
    h.ctx,
  );

  assert.equal(records[0]!.result.status, 'error');
  assert.equal(records[0]!.result.error?.code, 'UNKNOWN_TOOL');
  assert.match(records[0]!.result.content, /read_file/);
  assert.match(records[0]!.result.content, /set_timer/);
  assert.equal(records[0]!.result.content.includes('safe_edit'), false, 'destructive 默认不进可用清单');

  // 未知工具单独成组（executionMode 未知按 exclusive），不阻塞后续调用
  assert.equal(records[1]!.result.status, 'ok');
});

test('执行器：executionMode 每次启动一组前重新读注册表', async (t) => {
  const registry = new ToolRegistry();
  const intervals = new Map<string, { start: number; end: number }>();

  // 同一份 handler 在 replace 前后都要用：换模式不能悄悄把行为也换掉
  const recordInterval = (name: string, ms: number) => async (): Promise<ToolHandlerResult> => {
    const start = Date.now();
    await sleep(ms);
    intervals.set(name, { start, end: Date.now() });
    return { content: name };
  };

  registry.register(makeTool({
    name: 'x',
    executionMode: 'exclusive',
    handler: async () => {
      const start = Date.now();
      await sleep(100);
      intervals.set('x', { start, end: Date.now() });
      // 前序调用改注册表：把 a 从 parallel 改成 exclusive
      registry.register(makeTool({
        name: 'a',
        executionMode: 'exclusive',
        handler: recordInterval('a', 100),
      }), { replace: true });
      return { content: 'x' };
    },
  }));
  registry.register(makeTool({ name: 'a', executionMode: 'parallel', handler: recordInterval('a', 100) }));
  registry.register(makeTool({ name: 'b', executionMode: 'parallel', handler: recordInterval('b', 100) }));
  const h = await setup(t, registry);

  const started = Date.now();
  const records = await executeToolCalls([call('1', 'x'), call('2', 'a'), call('3', 'b')], h.ctx);
  const elapsed = Date.now() - started;

  assert.deepEqual(records.map((r) => r.result.status), ['ok', 'ok', 'ok']);
  const a = intervals.get('a');
  const b = intervals.get('b');
  assert.ok(a !== undefined && b !== undefined, `两条调用都应留下区间：${JSON.stringify([...intervals])}`);
  // 若开头一次性分类完，a 与 b 会同组并发；重读之后 a 已是 exclusive，必须与 b 串行
  assert.equal(a.end <= b.start || b.end <= a.start, true, `a/b 不应并发：${JSON.stringify({ a, b })}`);
  assert.ok(elapsed >= 280, `三组串行应 ≥280ms，实测 ${elapsed}ms`);
});

test('执行池：空调用列表与并发度下界不炸', async (t) => {
  const registry = new ToolRegistry();
  registry.register(makeTool({ name: 'q' }));
  const h = await setup(t, registry, { maxConcurrency: 0 });
  assert.deepEqual(await executeToolCalls([], h.ctx), []);
  const records = await executeToolCalls([call('q1', 'q'), call('q2', 'q')], h.ctx);
  assert.equal(records.length, 2);
});

// ──────────────────────────────── 僵尸检测 ────────────────────────────────

test('M2-11 不响应 signal 的 handler 迟到完成 → 丢弃结果并记 tool/zombie', async (t) => {
  const registry = new ToolRegistry();
  registry.register(makeTool({
    name: 'stubborn',
    timeoutMs: 60,
    handler: async () => {
      await sleep(250);
      return { content: '迟到但副作用可能已经发生' };
    },
  }));
  const h = await setup(t, registry);

  const records = await executeToolCalls([call('z1', 'stubborn')], h.ctx);
  assert.equal(records[0]!.result.status, 'timeout');

  await waitFor(() => h.zombies.length > 0, 3000);
  assert.equal(h.zombies[0]!.callId, 'z1');
  assert.equal(h.zombies[0]!.name, 'stubborn');
  assert.match(h.zombies[0]!.note, /超时之后仍然完成/);
  assert.match(h.zombies[0]!.note, /副作用可能已经发生/);

  // 迟到的 resolve 绝不落库：一条调用只有一条结果（不变量 9）
  assert.equal(resultsIn(h.events).length, 1);
  assert.equal(zombiesIn(h.events).length >= 1, true);
});

test('M2-11 子进程隔离：超时即杀，杀后迟到输出记 tool/zombie', async (t) => {
  const registry = new ToolRegistry();
  registry.register(makeTool({
    name: 'isolated_fake',
    executionMode: 'exclusive',
    timeoutMs: 40,
    handler: async () => ({ content: '隔离路径不会调用 handler' }),
  }));

  let dataHandler: ((chunk: string, stream: 'stdout' | 'stderr') => void) | null = null;
  let closeHandler: ((code: number | null) => void) | null = null;
  let killed = false;
  const fake: IsolatedProcess = {
    pid: 4242,
    onData(handler) {
      dataHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
    },
    kill() {
      killed = true; // 刻意不立刻 close：模拟"杀之后仍有输出到达"
    },
  };

  const h = await setup(t, registry, {
    isolation: {
      resolve: (): IsolatedTask => ({ command: 'fake-process', args: [] }),
      spawn: () => fake,
      zombieGraceMs: 40,
    },
  });

  const pending = executeToolCalls([call('i1', 'isolated_fake')], h.ctx);
  await waitFor(() => killed, 2000);
  dataHandler!('kill 之后才到达的输出', 'stdout'); // 迟到副作用迹象
  await sleep(10);
  closeHandler!(null); // 进程最终退出

  const records = await pending;
  assert.equal(records[0]!.result.status, 'timeout');
  assert.equal(records[0]!.result.error?.code, 'TOOL_TIMEOUT');
  assert.match(records[0]!.result.content, /终止隔离子进程|超时/);

  await waitFor(() => h.zombies.length > 0, 2000);
  assert.match(h.zombies[0]!.note, /被终止/);
  assert.match(h.zombies[0]!.note, /仍产生 stdout 输出/);
  assert.equal(zombiesIn(h.events).length >= 1, true);
});

test('M2-11 真实子进程隔离：超时被杀且不再存活；正常退出取 stdout', async (t) => {
  const registry = new ToolRegistry();
  registry.register(makeTool({
    name: 'iso_sleep',
    executionMode: 'exclusive',
    timeoutMs: 400,
    handler: async () => ({ content: '隔离路径不会调用 handler' }),
  }));
  registry.register(makeTool({
    name: 'iso_echo',
    executionMode: 'exclusive',
    handler: async () => ({ content: '隔离路径不会调用 handler' }),
  }));

  let pid: number | undefined;
  const h = await setup(t, registry, {
    isolation: {
      resolve: (def): IsolatedTask | null => {
        if (def?.name === 'iso_sleep') {
          return { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'] };
        }
        if (def?.name === 'iso_echo') {
          return { command: process.execPath, args: ['-e', 'console.log("hello from child")'] };
        }
        return null;
      },
      spawn: (task) => {
        const proc = defaultIsolatedSpawner(task);
        pid = proc.pid;
        return proc;
      },
      zombieGraceMs: DEFAULT_ZOMBIE_GRACE_MS,
    },
  });

  const records = await executeToolCalls(
    [call('r1', 'iso_sleep'), call('r2', 'iso_echo')],
    h.ctx,
  );

  assert.equal(records[0]!.result.status, 'timeout', '必然超时的隔离子进程要被记成 timeout 结果');
  assert.ok(pid !== undefined && pid > 0, '应拿到子进程 pid');
  const killedPid = pid;
  await waitFor(() => !pidAlive(killedPid), 5000);

  assert.equal(records[1]!.result.status, 'ok');
  assert.match(records[1]!.result.content, /hello from child/);
});
