/**
 * MCP stdio 客户端池测试（docs/milestones.md M7-1 / M7-2 / M7-3 / M7-8；docs/design.md §4.19 MCP 段）
 *
 * 覆盖面：
 *   M7-1  MCP 全链路   握手（protocolVersion + 空 capabilities + clientInfo）→ notifications/initialized
 *                      → tools/list → tools/call；工具以 mcp__{server}__{tool} 进注册表；
 *                      执行器级超时落 tool/result{status:'timeout'} 并杀 server 进程
 *   M7-2  空闲回收     窗口到期写 mcp/server-stopped{idle-reclaim}，下次调用自动重启（pid 变化）
 *   M7-3  默认不信任   未显式声明的 MCP 工具以 destructive 注册且不在默认模型清单里；
 *                      annotations（readOnlyHint）不参与三属性判定
 *   M7-8  关机序列     关 stdin → 等待 → SIGTERM → 再等待 → SIGKILL（两态各自断言）；
 *                      stdout 非 JSON-RPC 行 → 记协议错误并重启该进程
 *
 * 另有：tools/list 只拉一次（缓存）+ list_changed 刷新、progress 重置软超时但硬上限不可越、
 * 大 content[] 走 blob 外置、mcp.servers[] 配置解析。
 *
 * 两条测试纪律：
 *   1. 全链路口径用**真子进程**（node 版假 MCP server 夹具 test/fixtures/fake-mcp-server.mjs），
 *      "它到底发了什么、进程有没有被杀"从子进程写下的标记与父进程日志两边对账；
 *   2. 关机序列的三条分支用**可编程假进程**（Pool 的 spawner 注入点）——
 *      真进程在 Windows 上无法观测 SIGTERM/SIGKILL 的区分（kill 直接终止，进程捕不到信号），
 *      靠真进程断言这三条分支只会得到一个平台相关的假绿。
 *
 * 说明：Node 的类型剥离不做 `.js` → `.ts` 映射，所以这里用显式 `.ts` 说明符导入源码。
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent, ToolResult } from '../src/log/types.js';
import { defaultVisibility } from '../src/log/types.ts';
import {
  DEFAULT_BACKOFF_BASE_MS, DEFAULT_BACKOFF_CAP_MS, DEFAULT_BACKOFF_RESET_MS,
  DEFAULT_IDLE_RECLAIM_MS,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  MCP_ERROR_CODES, McpClientPool, McpConnection, POSIX_TREE_RSS_ARGS, createMcpRssSampler,
  defaultMcpProcessSpawner, defaultMcpRssSampler,
  mcpToolName, parseCimProcessTable, parseMcpServers, parsePsProcessTable, resolveRssSampler,
  resolveToolAttributes, rssSampleEnvOverride, singleProcessMcpRssSampler, sumProcessTree,
  type McpProcess, type McpProcessSpawner, type McpRssSampler, type McpServerEntry,
  type McpServerStartedData, type McpServerStoppedData,
} from '../src/mcp/client.ts';
import { readBlob } from '../src/state/blob-store.ts';
import { executeToolCalls } from '../src/tools/executor.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.js';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const FAKE_SERVER = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
/** 测试里的关机等待一律配小：真实默认值（2s/5s）是给生产留的余量，不是给测试摆的姿势 */
const FAST_SHUTDOWN = { shutdownStdinWaitMs: 60, shutdownTermWaitMs: 60, shutdownKillGraceMs: 30 } as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000, label = '条件'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`等待${label}超时（${timeoutMs}ms）`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Mark {
  t: string;
  [key: string]: unknown;
}

interface Harness {
  pool: McpClientPool;
  registry: ToolRegistry;
  markerDir: string;
  dataDir: string;
  events: Array<{ type: string; data: unknown }>;
  logs: string[];
  /**
   * 每次 `syncServerTools` 时那一刻的注册表里 `mcp__*` 全名（2026-10-09 加拉）。
   *
   * 池的 `registeredByServer` 与注册表都是**被覆盖**的（清单刷新会卸载消失的工具），
   * 所以"这次一共取到多少件"在多次刷新之后读不出来；分页那条判据要看的是"每一页都到了"，
   * 于是这里把每一次同步的**当次**清单记下来。
   */
  syncs: string[][];
  marks: () => Mark[];
  started: () => McpServerStartedData[];
  stopped: () => McpServerStoppedData[];
}

interface HarnessOptions {
  /** 传给假 server 的环境变量 */
  env?: Record<string, string>;
  /** 该 server 的逐工具三属性显式声明 */
  tools?: McpServerEntry['tools'];
  toolDefaults?: McpServerEntry['toolDefaults'];
  serverName?: string;
  idleReclaimMs?: number;
  requestTimeoutMs?: number;
  progressHardCapMs?: number;
  cancelGraceMs?: number;
  spawner?: McpProcessSpawner;
  /** 覆盖 pool 选项（例如 blob 阈值） */
  pool?: Record<string, unknown>;
}

function createHarness(t: TestContext, options: HarnessOptions = {}): Harness {
  const markerDir = mkdtempSync(join(tmpdir(), 'irmia-mcp-mark-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'irmia-mcp-data-'));
  const registry = new ToolRegistry();
  const events: Array<{ type: string; data: unknown }> = [];
  const logs: string[] = [];
  const syncs: string[][] = [];
  const serverName = options.serverName ?? 'fake';

  const entry: McpServerEntry = {
    name: serverName,
    command: process.execPath,
    args: [FAKE_SERVER],
    env: { FAKE_MCP_MARKER_DIR: markerDir, ...(options.env ?? {}) },
  };
  if (options.tools !== undefined) entry.tools = options.tools;
  if (options.toolDefaults !== undefined) entry.toolDefaults = options.toolDefaults;

  const poolOptions: Record<string, unknown> = {
    servers: [entry],
    emit: (type: string, data: unknown) => {
      events.push({ type, data });
    },
    dataDir,
    registry,
    onLog: (line: string) => {
      logs.push(line);
    },
    idleReclaimMs: options.idleReclaimMs ?? 60_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
    cancelGraceMs: options.cancelGraceMs ?? 150,
    ...FAST_SHUTDOWN,
    ...(options.progressHardCapMs === undefined ? {} : { progressHardCapMs: options.progressHardCapMs }),
    ...(options.spawner === undefined ? {} : { spawner: options.spawner }),
    ...(options.pool ?? {}),
  };

  const pool = new McpClientPool(poolOptions as never);
  // 每一次清单同步都留一份当次快照（分页那条判据要看"每一页都到了"；注册表本身会被覆盖）
  const poolSync = pool.syncServerTools.bind(pool);
  pool.syncServerTools = (conn) => {
    poolSync(conn);
    syncs.push(registry.names().filter((name) => name.startsWith('mcp__')));
  };

  t.after(async () => {
    await pool.shutdown().catch(() => undefined);
    rmSync(markerDir, { recursive: true, force: true, maxRetries: 5 });
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  });

  const marks = (): Mark[] => {
    const path = join(markerDir, 'events.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Mark);
  };

  return {
    pool,
    registry,
    markerDir,
    dataDir,
    events,
    logs,
    syncs,
    marks,
    started: () => events.filter((e) => e.type === 'mcp/server-started').map((e) => e.data as McpServerStartedData),
    stopped: () => events.filter((e) => e.type === 'mcp/server-stopped').map((e) => e.data as McpServerStoppedData),
  };
}

function toolCtx(signal?: AbortSignal): ToolContext {
  return {
    callId: 'call_mcp_test',
    turn: 1,
    step: 1,
    signal: signal ?? new AbortController().signal,
    workspaceRoot: process.cwd(),
  };
}

// ──────────────────────────────── M7-1 全链路 ────────────────────────────────

test('M7-1 全链路：握手 → initialized → tools/list → tools/call，工具进注册表', async (t) => {
  const h = createHarness(t);
  await h.pool.registerAll();

  assert.deepEqual(
    h.registry.names(),
    ['mcp__fake__echo', 'mcp__fake__big', 'mcp__fake__fail', 'mcp__fake__slow'],
    '工具按清单顺序以 mcp__{server}__{tool} 命名注册',
  );

  const def = h.registry.get('mcp__fake__echo');
  assert.ok(def !== null);
  assert.equal(def.name, mcpToolName('fake', 'echo'));
  assert.equal(def.timeoutMs, DEFAULT_MCP_TOOL_TIMEOUT_MS, '缺省执行器级超时与池的每请求软超时同源（120s）');

  const result = await def.handler({ text: '你好' }, toolCtx());
  assert.equal(result.isError ?? false, false);
  assert.equal(result.content, 'echo:你好');

  const started = h.started();
  assert.equal(started.length, 1);
  assert.equal(started[0]?.name, 'fake');
  assert.ok((started[0]?.pid ?? 0) > 0, 'server-started 带真实 pid');
  assert.deepEqual(h.stopped(), [], '还在跑的时候没有 server-stopped');
  assert.ok((started[0]?.tools ?? []).includes('echo'));
  assert.ok(started[0]?.tools.includes('slow'));

  const marks = h.marks();
  const initialize = marks.find((m) => m.t === 'initialize');
  assert.ok(initialize !== undefined, '夹具收到了 initialize');
  // 不声明 roots/sampling/elicitation：capabilities 就是空对象
  assert.deepEqual(initialize.capabilities, {});
  assert.deepEqual(initialize.clientInfo, { name: 'irmia-agent', version: '0.1.0-beta.6' });
  assert.ok(marks.some((m) => m.t === 'initialized'), '握手第二步发了 notifications/initialized');
  assert.equal(marks.filter((m) => m.t === 'list').length, 1, 'tools/list 在进程启动时拉一次');
  assert.equal(marks.find((m) => m.t === 'call')?.name, 'echo');

  // 再调一次：清单有缓存，调用路径上不做重复 list
  await def.handler({ text: '第二次' }, toolCtx());
  assert.equal(h.marks().filter((m) => m.t === 'list').length, 1, '调用路径不重复 tools/list');

  // isError → status 'error' 的映射（内容透传，错误码稳定）
  const failed = await h.registry.get('mcp__fake__fail')?.handler({}, toolCtx());
  assert.ok(failed !== undefined);
  assert.equal(failed.isError, true);
  assert.equal(failed.error?.code, MCP_ERROR_CODES.toolError);
  assert.match(failed.content, /夹具主动报告的工具失败/);
});

test('M7-3 默认不信任：MCP 工具 destructive 注册，annotations 不参与三属性判定', async (t) => {
  const h = createHarness(t);
  await h.pool.registerAll();

  const echo = h.registry.get('mcp__fake__echo');
  assert.ok(echo !== null);
  // 夹具自己声明了 annotations.readOnlyHint = true，但我们不采信它
  assert.equal(echo.sideEffect, 'destructive', 'readOnlyHint 不改变 sideEffect');
  assert.equal(echo.executionMode, 'exclusive');
  assert.deepEqual(h.registry.listForModel({}).map((s) => s.name), [], 'destructive 默认不进模型清单');
  assert.ok(h.registry.listForModel({ includeDestructive: true }).some((s) => s.name === echo.name));

  // 另一条：显式声明才降级（配置里显式写 sideEffect 是唯一合法路径）
  const h2 = createHarness(t, { tools: { echo: { sideEffect: 'none', executionMode: 'parallel' } } });
  await h2.pool.registerAll();
  const echo2 = h2.registry.get('mcp__fake__echo');
  assert.ok(echo2 !== null);
  assert.equal(echo2.sideEffect, 'none');
  assert.equal(echo2.executionMode, 'parallel');
  assert.ok(h2.registry.listForModel({}).some((s) => s.name === echo2.name), '显式降级后进默认清单');
  // 未显式声明的同类工具仍然 destructive
  assert.equal(h2.registry.get('mcp__fake__big')?.sideEffect, 'destructive');
});

test('tools/list 缓存 + notifications/tools/list_changed 触发刷新（新增与卸载）', async (t) => {
  const h = createHarness(t, { env: { FAKE_MCP_LIST_CHANGED: '1' } });
  await h.pool.registerAll();

  assert.equal(h.marks().filter((m) => m.t === 'list').length, 1);
  assert.equal(h.registry.has('mcp__fake__late'), false, '首次清单里没有 late 工具');

  await h.registry.get('mcp__fake__echo')?.handler({ text: '触发 list_changed' }, toolCtx());
  await waitFor(() => h.registry.has('mcp__fake__late'), 3000, 'list_changed 刷新');

  assert.equal(h.marks().filter((m) => m.t === 'list').length, 2, 'list_changed 之后重新拉清单');
  assert.ok(h.registry.get('mcp__fake__late')?.sideEffect === 'destructive', '刷新出来的工具同样默认不信任');
});

// ──────────────────────────────── tools/list 分页（2026-10-09） ────────────────────────────────
//
// 修前的形状（评审 `docs/mcp-chain-review.md` 缺陷 ③，探针 `_research/mcp-pagination-probe.mts`）：
// 只发一次 `tools/list`、`params:{}`、回包的 `nextCursor` **静默丢弃**。两页夹具
// `[alpha,beta]+nextCursor` / `[gamma]` ⇒ 真客户端只拿到 alpha,beta，`gamma` 消失、**零告警**；
// 更坏的是入口的"名字核对"用同一份缓存 ⇒ 她调 gamma 会被告知「没有名为 gamma 的工具」。
// 下面四条：① 取全；② 到顶如实截断并给出路；③ 中途失败如实报（不许只给第一页）；④ 游标回环不空转。

test('tools/list 分页：带 cursor 循环拉全（两页夹具 ⇒ 清单里三件都在，且记下页数）', async (t) => {
  // 夹具的 4 件工具按 2 件一页 ⇒ 2 页；`nextCursor` 是"下一页起始下标@圈数"
  const h = createHarness(t, { env: { FAKE_MCP_PAGE_SIZE: '2' } });
  await h.pool.registerAll();

  assert.equal(h.marks().filter((m) => m.t === 'list').length, 2, '两页就该发两次 tools/list');
  assert.deepEqual(
    h.marks().filter((m) => m.t === 'list').map((m) => m.cursor),
    [null, '2@0'],
    '第二次必须**带上** cursor（修前这里是"只发一次、params 空"）',
  );
  // 注册表里的名字就是"这份清单取全了没有"的判据（修前只有前两件）
  const registered = h.registry.names().filter((name) => name.startsWith('mcp__fake__')).sort();
  assert.deepEqual(registered, ['mcp__fake__big', 'mcp__fake__echo', 'mcp__fake__fail', 'mcp__fake__slow'],
    '四件工具一件都不许少——`nextCursor` 曾被静默丢掉，后一页的工具等于不存在');
  assert.equal(h.pool.status()[0]?.listCount, 1, 'listCount 数的是"刷新了几次"，不是"发了几页"');
});

test('tools/list 分页：页数超上限 ⇒ 停在 20 页并**如实说"还有更多"**（绝不静默截断）', async (t) => {
  // 夹具永远声明"还有下一页"（cursor 逐页不同）⇒ 客户端只能靠页数上限停下（20 页 × 2 件 = 40 件）
  const h = createHarness(t, { env: { FAKE_MCP_PAGE_SIZE: '2', FAKE_MCP_REPEAT_CURSOR: '1' } });
  await h.pool.registerAll();

  assert.equal(h.marks().filter((m) => m.t === 'list').length, 20, '页数上限是 20：到顶就停（防失控分页）');
  // 一共同步两次（`refreshTools` 里一次 + `startConnection` 收尾一次，这是既有的形态）；
  // 两次看到的都必须是**全的** 40 件——一页同步一次会让注册表被后面那些页反复覆盖。
  assert.deepEqual(h.syncs.map((names) => names.length), [40, 40], '20 页 × 2 件 = 40 件，一条都不许丢');
  assert.ok(
    h.logs.some((line) => line.includes('超过 20 页') && line.includes('后面还有')),
    `必须如实说"后面还有"（实际日志：${h.logs.filter((l) => l.includes('工具清单')).join(' | ')}）`,
  );
  assert.ok(
    h.logs.some((line) => line.includes('工具清单：40 件 / 20 页') && line.includes('已截断')),
    '刷新日志要带件数 / 页数 / 截断三件事',
  );
});

test('tools/list 分页：`nextCursor` 存在但第二页失败 ⇒ 如实报（绝不静默只给第一页）', async (t) => {
  // 为什么用**假进程**而不是真夹具：真路径上"握手里的 list 失败"会被 `startConnection` 收掉进程、
  // 由 `ensureReady` 折算成"未能启动"（那是给"起不来"写的措辞，会把这件事说歪）。
  // 而"半份清单"这句话的判据在**连接层**：`refreshTools()` 抛什么、连接里留下什么。
  // 所以这里直接连一个假进程，把 `McpConnection` 的那份契约读出来（第 ④ 条同理）。
  const handle = makeFakeProcess({ exitOnStdinEnd: true, listPaging: 'fail-second-page' });
  const harness = makeConnectionHarness(t, handle);

  await assert.rejects(
    () => harness.conn.refreshTools(),
    (err: unknown) => {
      const text = err instanceof Error ? err.message : String(err);
      assert.match(text, /第 2 页/, `要点名卡在第几页（实际：${text}）`);
      assert.match(text, /已经取到 2 件/, '要说清已经取到几件');
      assert.match(text, /不完整/, '不许让半份清单看起来像全的');
      return true;
    },
    '第二页失败必须抛出去（静默只给第一页正是修前那个 bug 的形态）',
  );
  // 第一页真的取到了（所以这不是"一件都没有"，是"没取全"）
  // 注意：握手里的 list 失败会让 `startConnection` 收掉整条连接 ⇒ `syncServerTools` 从未被调用
  //（注册表是空的，这不是判据）；"取到哪里"读的是连接自己的缓存与新加的 `toolsListSummary`。
  assert.deepEqual(harness.conn.tools.map((tool) => tool.name), ['echo', 'second']);
  assert.equal(harness.conn.toolsListSummary.pages, 1);
  assert.equal(harness.conn.toolsListSummary.tools, 2);
});

test('tools/list 分页：游标回环（server 反复回同一个 cursor）⇒ 停下并如实说，不空转', async (t) => {
  const handle = makeFakeProcess({ exitOnStdinEnd: true, listPaging: 'repeat-cursor' });
  const harness = makeConnectionHarness(t, handle);

  await harness.conn.refreshTools();
  // 第一页拿到 1 件；第二页回的 cursor 与第一页相同 ⇒ 立刻停下（不等 20 页上限）
  assert.equal(harness.conn.toolsListSummary.pages, 2, '认出游标回环就停：不该把同一个 cursor 一路发到页数上限');
  assert.equal(harness.conn.toolsListSummary.truncated, true, '回环 = 没取全，这件事必须记下来');
  assert.equal(harness.conn.toolsListSummary.nextCursor, 'loop');
  assert.ok(
    harness.lines.some((line) => line.includes('游标回环')),
    `要如实说这是回环（实际：${harness.lines.join(' | ')}）`,
  );
});

// ──────────────────────────────── M7-1 超时与取消 ────────────────────────────────

test('每请求超时：发 notifications/cancelled，并回收不配合取消的 server 进程', async (t) => {
  const h = createHarness(t, { idleReclaimMs: 60_000 });
  await h.pool.registerAll();
  const pid = h.started()[0]?.pid ?? 0;
  assert.ok(pidAlive(pid));

  const result = await h.pool.callTool('fake', 'slow', { ms: 5_000 }, { timeoutMs: 200 });
  assert.equal(result.isError, true);
  assert.equal(result.error?.code, MCP_ERROR_CODES.timeout);
  assert.match(result.content, /超过 200ms 未返回/);
  assert.match(result.content, /notifications\/cancelled/);

  // 取消通知是写给子进程的，夹具落盘要等它读到那一行；这里等它出现，不用固定 sleep 赌时序
  await waitFor(() => h.marks().some((m) => m.t === 'cancelled'), 2000, '夹具收到取消通知');
  assert.equal(h.marks().find((m) => m.t === 'cancelled')?.reason, 'timeout');
  await waitFor(
    () => h.logs.some((line) => line.includes('取消宽限')),
    3000,
    '取消宽限判定（server 不配合取消 → 连接失效）',
  );
  await waitFor(() => h.stopped().some((s) => s.reason === 'crashed'), 3000, '超时后回收进程');
  assert.equal(pidAlive(pid), false, '进程被真的杀掉了（超时即杀）');

  // 下次调用自动重新拉起（随用随起）
  const again = await h.pool.callTool('fake', 'echo', { text: '重启后' });
  assert.equal(again.isError ?? false, false);
  assert.equal(again.content, 'echo:重启后');
  assert.equal(h.started().length, 2);
});

test('M7-1 执行器级超时：落 tool/result{status:"timeout"} 且 server 进程被杀', async (t) => {
  const h = createHarness(t, { tools: { slow: { timeoutMs: 250 } } });
  await h.pool.registerAll();
  const pid = h.started()[0]?.pid ?? 0;

  const dataDir = mkdtempSync(join(tmpdir(), 'irmia-mcp-log-'));
  const log = await EventLog.open(join(dataDir, 'events'));
  const events: AppEvent[] = [];
  t.after(() => {
    try {
      log.close();
    } catch {
      // 已关闭
    }
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  });

  const append = (type: string, data: unknown): AppEvent => {
    const event = {
      seq: log.nextSeq(),
      ts: new Date(1_780_000_000_000 + events.length).toISOString(),
      type,
      data,
      visibility: defaultVisibility(type),
      origin: 'test/mcp',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    events.push(event);
    return event;
  };

  await executeToolCalls([{ callId: 'call_slow', name: 'mcp__fake__slow', arguments: '{"ms":5000}' }], {
    registry: h.registry,
    turn: 1,
    step: 1,
    workspaceRoot: dataDir,
    onToolCall: (call) => append('tool/call', {
      turn: 1,
      step: 1,
      callId: call.callId,
      name: call.name,
      arguments: call.arguments,
      sideEffect: h.registry.get(call.name)?.sideEffect ?? 'destructive',
    }).seq,
    onToolResult: (call, result, callSeq) => {
      append('tool/result', {
        turn: 1,
        step: 1,
        callId: call.callId,
        callSeq,
        status: result.status,
        content: result.content,
        durationMs: result.durationMs,
        ...(result.error === undefined ? {} : { error: result.error }),
      });
    },
  });

  const results = events.filter((e): e is ToolResult => e.type === 'tool/result');
  assert.equal(results.length, 1);
  assert.equal(results[0]?.data.status, 'timeout', '执行器级超时写 status timeout');

  assert.ok(h.marks().some((m) => m.t === 'cancelled'), '超时同时把取消告诉了 server');
  await waitFor(() => h.stopped().some((s) => s.reason === 'crashed'), 3000, '超时后回收进程');
  assert.equal(pidAlive(pid), false, '超过执行器超时的 server 进程被回收');
});

// ──────────────────────────────── M7-2 空闲回收 ────────────────────────────────

test('M7-2 空闲回收：窗口到期写 server-stopped{idle-reclaim}，下次调用自动重启', async (t) => {
  const h = createHarness(t, { idleReclaimMs: 150 });
  await h.pool.registerAll();
  const firstPid = h.started()[0]?.pid ?? 0;
  assert.ok(pidAlive(firstPid));
  assert.equal(h.marks().some((m) => m.t === 'exit'), false);

  await waitFor(() => h.stopped().length >= 1, 4000, '空闲回收');
  const stopped = h.stopped()[0];
  assert.equal(stopped?.name, 'fake');
  assert.equal(stopped?.reason, 'idle-reclaim', '回收原因如实记 idle-reclaim');
  await waitFor(() => !pidAlive(firstPid), 2000, '回收后进程退出');

  const result = await h.pool.callTool('fake', 'echo', { text: '唤醒' });
  assert.equal(result.isError ?? false, false);
  const starts = h.started();
  assert.equal(starts.length, 2, '随用随起：下次调用重新拉起');
  assert.notEqual(starts[1]?.pid, firstPid, '是新进程');
});

// ──────────────────────────────── M7-8 stdout 纪律 ────────────────────────────────

test('M7-8 stdout 污染：记协议错误并重启该 server 进程，重启后恢复可用', async (t) => {
  // 退避窗口压到 40ms（2026-10-10 加崩溃退避之后）：污染让**第一次启动就失败**，
  // 于是它进的是"连续启动失败"那本账 ⇒ 下一次调用要等退避过去。
  // 这一条测的是"退避过去之后能恢复"，不是"不等也能恢复"——所以窗口调小、然后等它。
  const h = createHarness(t, { env: { FAKE_MCP_POLLUTE: '1' }, pool: { backoffBaseMs: 40, backoffCapMs: 40 } });

  // 第一次启动就被污染行打断：握手失败，工具没有注册（但不抛穿调用方）
  await h.pool.registerAll();
  assert.equal(h.registry.names().length, 0, '协议错误的 server 不上线工具');
  assert.ok(
    h.logs.some((line) => line.includes('协议错误')),
    '记协议错误',
  );
  assert.equal(h.stopped()[0]?.reason, 'crashed', '被污染的进程按 crashed 收掉');

  // 退避窗口内**如实拒绝**（不退化成"再起一次"）：回执里要有"连续启动失败 N 次 + 还要等多久"
  const blocked = await h.pool.callTool('fake', 'echo', { text: '退避中' });
  assert.equal(blocked.isError, true, '退避窗口内不发这次调用');
  assert.match(blocked.content, /连续启动失败 1 次/u);
  assert.match(blocked.content, /退避/u);

  // 等退避过去：下一次调用自动重新拉起（夹具只在首次启动污染）
  await sleep(60);
  const result = await h.pool.callTool('fake', 'echo', { text: '重启之后' });
  assert.equal(result.isError ?? false, false);
  assert.equal(result.content, 'echo:重启之后');
  assert.equal(h.registry.has('mcp__fake__echo'), true, '重启后工具进入注册表');
  assert.ok(h.started().length >= 1, '重启过程有 server-started');
  assert.equal(h.marks().filter((m) => m.t === 'initialize').length, 2, '第二次启动完成了握手');
});

test('M7-8 关机序列（真进程）：关 stdin 即退出的 server 不走 SIGTERM', async (t) => {
  const h = createHarness(t);
  await h.pool.registerAll();
  const pid = h.started()[0]?.pid ?? 0;

  const reports = await h.pool.shutdown();
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.reason, 'shutdown');
  assert.deepEqual(reports[0]?.stages, ['stdin-closed', 'exited'], '关 stdin 之后它自己走了，不必动信号');
  assert.ok(h.marks().some((m) => m.t === 'stdin-end'), '夹具确认收到了 stdin 关闭');
  assert.equal(pidAlive(pid), false);
  assert.equal(h.stopped()[0]?.reason, 'shutdown');
});

test('M7-8 关机序列（真进程）：忽略 stdin 关闭的 server 走 SIGTERM', async (t) => {
  const h = createHarness(t, { env: { FAKE_MCP_IGNORE_STDIN_END: '1' } });
  await h.pool.registerAll();

  const reports = await h.pool.shutdown();
  const stages = reports[0]?.stages ?? [];
  assert.deepEqual(stages.slice(0, 2), ['stdin-closed', 'sigterm'], '先关 stdin，等待无果后再 SIGTERM');
  assert.ok(stages.includes('exited'), '被终止后进程消失');
  assert.ok(!stages.includes('sigkill'), '没有走到 SIGKILL');
});

// ──────────────────────────────── M7-8 关机序列（可编程假进程） ────────────────────────────────

interface FakeProcessOptions {
  /** 关 stdin 之后是否自行退出 */
  exitOnStdinEnd: boolean;
  /** 收到 SIGTERM 之后是否退出 */
  exitOnTerm?: boolean;
  /** 收到 SIGKILL 之后是否退出（默认 false：模拟免疫终止） */
  exitOnKill?: boolean;
  /**
   * `tools/list` 的分页编排（2026-10-09 加，缺陷 ③ 的"第二页失败"那一档）：
   *   `'fail-second-page'`  第一页正常（1 件 + nextCursor），第二页回 JSON-RPC 错误；
   *   `'repeat-cursor'`     永远回同一个 nextCursor（测游标回环保护）；
   *   缺省 = 一页给全（与以前逐字相同）。
   */
  listPaging?: 'fail-second-page' | 'repeat-cursor';
}

interface FakeProcessHandle {
  process: McpProcess;
  /** 调用顺序事实：closeStdin / kill:SIGTERM / kill:SIGKILL */
  calls: string[];
}

/**
 * 可编程假进程：应答 initialize 与 tools/list 让握手通过，关机行为由测试编排。
 * 真进程无法在 Windows 上区分 SIGTERM 与 SIGKILL（kill 直接终止，进程捕不到信号），
 * 所以"两级超时都用到了"这条只能靠它在跨平台上被确定性地断言。
 */
function makeFakeProcess(options: FakeProcessOptions): FakeProcessHandle {
  const stdoutHandlers: Array<(chunk: string) => void> = [];
  const exitHandlers: Array<(code: number | null, signal: string | null) => void> = [];
  const calls: string[] = [];
  let exited = false;

  const push = (text: string): void => {
    for (const handler of stdoutHandlers) handler(text);
  };
  const emitExit = (code: number | null): void => {
    if (exited) return;
    exited = true;
    for (const handler of exitHandlers) handler(code, null);
  };
  const reply = (id: unknown, result: unknown): void => {
    push(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  };
  const handle = (line: string): void => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const method = message['method'];
    if (method === 'initialize') {
      reply(message['id'], {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'fake-memory', version: '1.0.0' },
      });
      return;
    }
    if (method === 'tools/list') {
      const cursor = (message['params'] as { cursor?: unknown } | undefined)?.cursor;
      if (options.listPaging === 'fail-second-page' && cursor !== undefined) {
        push(`${JSON.stringify({
          jsonrpc: '2.0', id: message['id'],
          error: { code: -32603, message: '假进程刻意让第二页失败' },
        })}\n`);
        return;
      }
      const tools = [
        { name: 'echo', description: '内存假工具', inputSchema: { type: 'object', properties: {} } },
        { name: 'second', description: '第二页之前的另一件', inputSchema: { type: 'object', properties: {} } },
      ];
      const next = options.listPaging === 'fail-second-page'
        ? 'page-2'
        : options.listPaging === 'repeat-cursor' ? 'loop' : undefined;
      reply(message['id'], next === undefined ? { tools } : { tools, nextCursor: next });
      return;
    }
    if (method === 'tools/call') {
      reply(message['id'], { content: [{ type: 'text', text: 'ok' }] });
    }
  };

  const process: McpProcess = {
    pid: 4242,
    onStdout(handler) {
      stdoutHandlers.push(handler);
    },
    onStderr() {
      // 假进程没有 stderr
    },
    onExit(handler) {
      exitHandlers.push(handler);
    },
    write(line) {
      calls.push('write');
      handle(line);
    },
    closeStdin() {
      calls.push('closeStdin');
      if (options.exitOnStdinEnd) setTimeout(() => emitExit(0), 0);
    },
    kill(signal) {
      calls.push(`kill:${signal}`);
      if (signal === 'SIGTERM' && options.exitOnTerm === true) {
        setTimeout(() => emitExit(0), 0);
        return;
      }
      if (signal === 'SIGKILL' && options.exitOnKill === true) {
        setTimeout(() => emitExit(null), 0);
      }
    },
  };
  return { process, calls };
}

function fakeSpawner(handle: FakeProcessHandle): McpProcessSpawner {
  return () => handle.process;
}

/**
 * 直连一个 `McpConnection`（假进程 + 假宿主）——**连接层契约**的判据台（2026-10-09 分页那两条用）。
 *
 * 为什么不能只用池：握手里的 `tools/list` 失败会被 `startConnection` 收掉进程、由 `ensureReady`
 * 折算成"未能启动"那句给"起不来"写的措辞。要读"半份清单"这句话本身，就得拿到连接对象；
 * 而 `refreshTools()` 是公开方法（`list_changed` 那天走的就是它），手调它**就是**生产形态。
 */
function makeConnectionHarness(t: TestContext, handle: FakeProcessHandle): {
  conn: McpConnection;
  lines: string[];
} {
  const lines: string[] = [];
  const connRef: { value: McpConnection | null } = { value: null };
  const entry: McpServerEntry = { name: 'fake-conn', command: process.execPath, args: [] };
  const host = {
    clientInfo: { name: 'irmia-agent-test', version: '0.0.0' },
    protocolVersion: '2025-06-18',
    progressHardCapMs: 60_000,
    defaultRequestTimeoutMs: 5_000,
    now: () => Date.now(),
    log: (line: string) => { lines.push(line); },
    syncServerTools: () => undefined,
    onListChangedRefresh: () => undefined,
    onConnectionExit: () => undefined,
    onProtocolViolation: () => undefined,
    gracefulCancel: () => undefined,
  };
  const conn = new McpConnection(entry, handle.process, host);
  connRef.value = conn;
  handle.process.onStdout((chunk) => conn.onStdoutChunk(chunk));
  handle.process.onExit((code, signal) => conn.onProcessExit(code, signal));
  t.after(() => {
    // 假进程：closeStdin 会（按 options）自己退出，不留真进程
    conn.closeStdin();
  });
  return { conn, lines };
}

test('M7-8 关机序列三分支：stdin → SIGTERM → SIGKILL 的顺序与用法', async (t) => {
  // ① 关 stdin 就退出：不动任何信号
  const a = makeFakeProcess({ exitOnStdinEnd: true });
  const ha = createHarness(t, { spawner: fakeSpawner(a) });
  await ha.pool.registerAll();
  const reportA = (await ha.pool.shutdown())[0];
  assert.deepEqual(reportA?.stages, ['stdin-closed', 'exited']);
  assert.deepEqual(a.calls, ['write', 'write', 'write', 'closeStdin'], '只有 write/closeStdin，没有 kill');

  // ② 忽略 stdin 关闭、响应 SIGTERM
  const b = makeFakeProcess({ exitOnStdinEnd: false, exitOnTerm: true });
  const hb = createHarness(t, { spawner: fakeSpawner(b) });
  await hb.pool.registerAll();
  const reportB = (await hb.pool.shutdown())[0];
  assert.deepEqual(reportB?.stages, ['stdin-closed', 'sigterm', 'exited']);
  assert.ok(b.calls.includes('kill:SIGTERM'));
  assert.ok(!b.calls.includes('kill:SIGKILL'), 'SIGTERM 之后退出，不该再升级');

  // ③ 免疫 stdin 关闭与 SIGTERM：必须升级到 SIGKILL，且如实报告"没退出"
  const c = makeFakeProcess({ exitOnStdinEnd: false, exitOnTerm: false, exitOnKill: false });
  const hc = createHarness(t, { spawner: fakeSpawner(c) });
  await hc.pool.registerAll();
  const reportC = (await hc.pool.shutdown())[0];
  assert.deepEqual(reportC?.stages, ['stdin-closed', 'sigterm', 'sigkill'], '两级超时都用到了');
  assert.deepEqual(c.calls.filter((call) => call.startsWith('kill:')), ['kill:SIGTERM', 'kill:SIGKILL']);
  assert.ok(
    hc.logs.some((line) => line.includes('SIGKILL 之后仍未退出')),
    '没退出这件事必须留痕，不能假装收干净了',
  );
});

// ──────────────────────────────── 超时时钟：progress 与硬上限 ────────────────────────────────

test('progress 通知重置软超时时钟，但硬上限不可越过', async (t) => {
  // ① 响应比软超时慢，但 progress 一直续命 → 成功
  const slowButAlive = createHarness(t, {
    env: { FAKE_MCP_PROGRESS_MS: '60', FAKE_MCP_RESPOND_AFTER_MS: '600' },
    progressHardCapMs: 4_000,
  });
  await slowButAlive.pool.registerAll();
  const ok = await slowButAlive.pool.callTool('fake', 'echo', { text: '续命成功' }, { timeoutMs: 250 });
  assert.equal(ok.isError ?? false, false, 'progress 把 600ms 的请求从 250ms 软超时里救回来了');
  assert.equal(ok.content, 'echo:续命成功');

  // ② progress 一直发，但撞到硬上限 → 仍然超时（这是"有硬上限"的意义）
  const hardCapped = createHarness(t, {
    env: { FAKE_MCP_PROGRESS_MS: '40', FAKE_MCP_RESPOND_AFTER_MS: '1500' },
    progressHardCapMs: 350,
  });
  await hardCapped.pool.registerAll();
  const timedOut = await hardCapped.pool.callTool('fake', 'echo', { text: '硬上限' }, { timeoutMs: 200 });
  assert.equal(timedOut.isError, true);
  assert.equal(timedOut.error?.code, MCP_ERROR_CODES.timeout);
  assert.match(timedOut.content, /硬上限/);
  await waitFor(
    () => hardCapped.marks().some((m) => m.t === 'cancelled' && m.reason === 'hard-timeout'),
    2000,
    '硬上限取消通知到达夹具',
  );
});

// ──────────────────────────────── 大结果外置 ────────────────────────────────

test('MCP content[] 超阈值走 blob 外置，全文可用 read_blob 取回', async (t) => {
  // 阈值**显式给**：这条要测的是"过线就外置 + 指针可寻回"，不是出厂阈值是多少
  // （出厂阈值 2026-10-06 从 8k 提到 21k，见 blob-store 的 DEFAULT_BLOB_THRESHOLD_TOKENS；
  //  同一次改动把估算口径收口成 tools/registry 那一份，中文 20,000 字估算约 13,334 token）。
  const h = createHarness(t, { pool: { blobThresholdTokens: 8_000 } });
  await h.pool.registerAll();

  const result = await h.registry.get('mcp__fake__big')?.handler({ chars: 20_000 }, toolCtx());
  assert.ok(result !== undefined);
  assert.equal(result.isError ?? false, false);
  assert.match(result.content, /完整结果 \d+ 字节，不在本次对话里；用 read_blob 取（offset\/limit 可翻页）：[0-9a-f]{64}/);
  assert.ok(result.content.length < 3_000, '预览控制在头部切片量级');

  const blobId = /可翻页）：([0-9a-f]{64})/u.exec(result.content)?.[1];
  assert.ok(blobId !== undefined);
  const full = await readBlob(h.dataDir, blobId);
  assert.equal(full.toString('utf8').length, 20_000, 'blob 里是完整全文');
});

// ──────────────────────────────── 配置解析 ────────────────────────────────

test('mcp.servers[] 配置解析：合法项逐字段落地，非法项当场报错不回退默认', () => {
  const parsed = parseMcpServers([
    {
      name: 'fs',
      command: 'node',
      args: ['server.mjs', '--root', '.'],
      env: { LOG: 'debug' },
      tools: { read: { sideEffect: 'none', executionMode: 'parallel' } },
      disabled: true,
    },
    { name: 'git_2', command: 'mcp-server-git' },
  ]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.name, 'fs');
  assert.deepEqual(parsed[0]?.args, ['server.mjs', '--root', '.']);
  assert.deepEqual(parsed[0]?.env, { LOG: 'debug' });
  assert.equal(parsed[0]?.disabled, true);
  assert.equal(parsed[0]?.tools?.['read']?.sideEffect, 'none');
  assert.deepEqual(parsed[1], { name: 'git_2', command: 'mcp-server-git' });

  assert.deepEqual(parseMcpServers(undefined), [], '没配就是空数组');

  const bad: Array<[unknown, string]> = [
    [[{ name: 'a b', command: 'node' }], 'name'],
    [[{ name: 'ok' }], 'command'],
    [[{ name: 'ok', command: 'node', args: 'x' }], 'args'],
    [[{ name: 'ok', command: 'node', env: { A: 1 } }], 'env'],
    [[{ name: 'ok', command: 'node', tools: { t: { sideEffect: 'safe' } } }], 'sideEffect'],
    [[{ name: 'ok', command: 'node', tools: { t: { timeoutMs: 0 } } }], 'timeoutMs'],
    ['not-an-array', '必须是数组'],
  ];
  for (const [raw, needle] of bad) {
    assert.throws(() => parseMcpServers(raw), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, new RegExp(needle));
      return true;
    }, `非法配置必须报错：${JSON.stringify(raw)}`);
  }

  // 三属性缺省口径：不声明即 destructive / exclusive / 传入的默认超时
  assert.deepEqual(resolveToolAttributes({ name: 's', command: 'c' }, 'x', 1234), {
    sideEffect: 'destructive', executionMode: 'exclusive', timeoutMs: 1234,
  });
  // 逐工具声明优先于 server 默认；全名与短名都认
  const entry: McpServerEntry = {
    name: 's',
    command: 'c',
    toolDefaults: { sideEffect: 'idempotent', timeoutMs: 500 },
    tools: { x: { sideEffect: 'none' }, 'mcp__s__y': { executionMode: 'parallel' } },
  };
  assert.deepEqual(resolveToolAttributes(entry, 'x', 10), {
    sideEffect: 'none', executionMode: 'exclusive', timeoutMs: 500,
  });
  assert.deepEqual(resolveToolAttributes(entry, 'y', 10), {
    sideEffect: 'idempotent', executionMode: 'parallel', timeoutMs: 500,
  });
});

test('未配置或已禁用的 server：调用得到可读结果，不抛不崩', async (t) => {
  const h = createHarness(t, { serverName: 'fake' });
  const missing = await h.pool.callTool('nosuch', 'echo', {});
  assert.equal(missing.error?.code, MCP_ERROR_CODES.notConfigured);
  assert.match(missing.content, /不在配置里/);

  const disabled = createHarness(t, { serverName: 'off' });
  const off = new McpClientPool({
    servers: [{
      name: 'off', command: process.execPath, args: [FAKE_SERVER],
      env: { FAKE_MCP_MARKER_DIR: disabled.markerDir }, disabled: true,
    }],
    emit: () => undefined,
    dataDir: disabled.dataDir,
    registry: disabled.registry,
    ...FAST_SHUTDOWN,
  });
  t.after(async () => {
    await off.shutdown();
  });
  const result = await off.callTool('off', 'echo', {});
  assert.equal(result.error?.code, MCP_ERROR_CODES.disabled);
  assert.deepEqual(off.status()[0]?.tools, []);
  assert.equal(off.status()[0]?.running, false);
});

// ──────────────────────────────── A① 工具清单落盘缓存（2026-10-10） ────────────────────────────────
//
// 判据（docs/multi-mcp-orchestration.md 缺口 ① / L1 风险 1）：
//   · 命中缓存时**不起进程**（"看一眼有哪些工具"从一次冷启动变成读一个 json）；
//   · 回执那一侧必须能看出它旧 —— 由池的 onSource 交出来源与取回时间（test/mcp-entry.test.ts 验措辞）；
//   · 配置变了（command/args/cwd/env 指纹）或它起不来了 ⇒ 缓存作废、下次真连一次。

test('A① 清单落盘缓存：真拉一次后落盘；空闲回收后命中缓存且**不再起进程**', async (t) => {
  const h = createHarness(t, { idleReclaimMs: 60 });
  await h.pool.listTools('fake', { requireConnected: true });
  const cachePath = join(h.dataDir, 'mcp-cache', 'fake.json');
  assert.ok(existsSync(cachePath), '真拉过之后缓存文件落盘');
  const saved = JSON.parse(readFileSync(cachePath, 'utf8')) as {
    version: number; server: string; fingerprint: string; fetchedAtMs: number; tools: Array<{ name: string }>;
  };
  assert.equal(saved.server, 'fake');
  assert.match(saved.fingerprint, /^[0-9a-f]{64}$/u, '指纹是 SHA-256');
  assert.ok(saved.tools.some((tool) => tool.name === 'echo'), '缓存里有清单');
  assert.equal(h.marks().filter((m) => m.t === 'initialize').length, 1);

  // 空闲回收：进程收掉（清单只剩缓存在磁盘上）
  await h.pool.reclaimIdle();
  await waitFor(() => h.pool.status()[0]?.running === false, 1_000, '空闲回收');
  assert.equal(h.stopped()[0]?.reason, 'idle-reclaim');

  // 再看一次清单：命中缓存 —— 不起进程（没有第二次 initialize）、来源如实标成 cache
  let source: { source: string; ageMs: number; fetchedAtMs: number | null; mayBeStale: boolean } | null = null;
  const tools = await h.pool.listTools('fake', {
    onSource: (info) => { source = info; },
  });
  assert.ok(tools.some((tool) => tool.name === 'echo'), '缓存里有工具');
  assert.equal(source?.source, 'cache');
  assert.equal(source?.mayBeStale, true, '缓存必须自己承认可能过期');
  assert.ok((source?.ageMs ?? -1) >= 0);
  assert.equal(h.marks().filter((m) => m.t === 'initialize').length, 1, '命中缓存**没有**再起进程');
  assert.equal(h.pool.status()[0]?.running, false, '它仍然没在跑');
});

test('A① 缓存失效：配置指纹变了 ⇒ 不命中；启动失败 ⇒ 缓存作废', async (t) => {
  const h = createHarness(t);
  await h.pool.listTools('fake', { requireConnected: true });
  const cachePath = join(h.dataDir, 'mcp-cache', 'fake.json');
  assert.ok(existsSync(cachePath));
  const saved = JSON.parse(readFileSync(cachePath, 'utf8')) as { tools: unknown[] };
  // 手写一份"过期但形状合法"的缓存：指纹是原样的 ⇒ 换个 entry 就该判它不命中
  assert.ok(saved.tools.length > 0);

  // 换一个 server 名 + 换 env（等于换指纹）：同一份文件读不到（按名字分文件），
  // 于是这里换的是"同一个名字、不同配置"那条路——直接改文件里的指纹最直白
  const tampered = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>;
  tampered['fingerprint'] = 'deadbeef';
  writeFileSync(cachePath, JSON.stringify(tampered), 'utf8');
  // 先把活连接收掉：这条测的是"缓存那一档"，活连接优先级更高（它的判据在另一条用例里）
  await h.pool.shutdown();
  let source: { source: string } | null = null;
  const empty = await h.pool.listTools('fake', { onSource: (info) => { source = info; } });
  assert.deepEqual(empty, [], '指纹对不上 = 没有可用缓存');
  assert.equal(source?.source, 'none', '来源如实标成"既没连着也没有缓存"');
});

test('A① 启动失败 ⇒ 那份缓存作废（它不再代表现在）', async (t) => {
  const h = createHarness(t);
  await h.pool.listTools('fake', { requireConnected: true });
  const cachePath = join(h.dataDir, 'mcp-cache', 'fake.json');
  assert.ok(existsSync(cachePath));
  await h.pool.shutdown();

  // 同一个 dataDir、同一个名字，但 command 换成一个必然起不来的（指纹也变了）：
  // 先证明"起不来"这条路自己会把缓存抹掉
  const registry = new ToolRegistry();
  const broken = new McpClientPool({
    servers: [{ name: 'fake', command: process.execPath, args: [FAKE_SERVER], env: { FAKE_MCP_BOGUS: '1' } }],
    emit: () => undefined,
    dataDir: h.dataDir,
    registry,
    onLog: () => undefined,
    backoffBaseMs: 1_000,
    ...FAST_SHUTDOWN,
    spawner: () => { throw new Error('起不来（测试注入）'); },
  });
  t.after(async () => { await broken.shutdown().catch(() => undefined); });
  const failed = await broken.callTool('fake', 'echo', {});
  assert.equal(failed.isError, true);
  assert.match(failed.content, /未能启动/u);
  assert.equal(existsSync(cachePath), false, '起不来 ⇒ 缓存作废（别把"它现在坏了"藏在一份正常清单后面）');
});

// ──────────────────────────────── A② 崩溃退避（2026-10-10） ────────────────────────────────

test('A② 连续启动失败：退避 10s→20s→40s…封顶，回执如实说"失败几次 + 还要等多久"', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'irmia-mcp-backoff-'));
  const logs: string[] = [];
  // 假时钟：退避是**时间**的事，用真 sleep 验它既慢又不稳（判据是"窗口内不发、窗口外翻倍"）
  let clock = 1_000_000;
  const pool = new McpClientPool({
    servers: [{ name: 'bad', command: process.execPath, args: ['--nope'] }],
    emit: () => undefined,
    dataDir,
    onLog: (line) => { logs.push(line); },
    now: () => clock,
    // 序列用小窗口验形状（判据是"每次翻倍、封顶不再涨"），默认值另有一条断言盯着
    backoffBaseMs: 1_000,
    backoffCapMs: 4_000,
    ...FAST_SHUTDOWN,
    spawner: () => { throw new Error('起不来（测试注入）'); },
  });
  t.after(async () => {
    await pool.shutdown().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  });

  // ① 第一次：真去起了、失败了 ⇒ 记上一笔（这一次的回执还是"未能启动"，退避从下一次才开始拦）
  const first = await pool.callTool('bad', 'echo', {});
  assert.equal(first.isError, true);
  assert.match(first.content, /未能启动/u, '第一次是"未能启动"，还没有退避可言');
  assert.equal(pool.status()[0]?.consecutiveFailures, 1);

  // ② 窗口内：**不再起进程**，如实说"失败 1 次 + 还要等多久"
  const blocked1 = await pool.callTool('bad', 'echo', {});
  assert.match(blocked1.content, /连续启动失败 1 次/u);
  assert.match(blocked1.content, /现在在退避/u);
  assert.match(blocked1.content, /约 1 秒后/u, '第一次退避 = 基准 1s');
  assert.match(blocked1.content, /这不是新故障/u, '不许把它说成一次新故障');

  // ③ 窗口过去之后又失败一次 ⇒ 计数 2、下一次翻倍（2s）
  clock += 1_001;
  const second = await pool.callTool('bad', 'echo', {});
  assert.match(second.content, /未能启动/u, '窗口过去 ⇒ 真的又试了一次（并又失败了）');
  const blocked2 = await pool.callTool('bad', 'echo', {});
  assert.match(blocked2.content, /连续启动失败 2 次/u);
  assert.match(blocked2.content, /约 2 秒后/u, '第二次退避 = 基准 ×2');

  // ④ 再一次：4s；⑤ 再下一次撞封顶：还是 4s（不再翻倍）
  clock += 2_001;
  await pool.callTool('bad', 'echo', {});
  const blocked3 = await pool.callTool('bad', 'echo', {});
  assert.match(blocked3.content, /连续启动失败 3 次/u);
  assert.match(blocked3.content, /约 4 秒后/u);
  clock += 4_001;
  await pool.callTool('bad', 'echo', {});
  const blocked4 = await pool.callTool('bad', 'echo', {});
  assert.match(blocked4.content, /连续启动失败 4 次/u);
  assert.match(blocked4.content, /约 4 秒后/u, '封顶之后不再翻倍');

  const status = pool.status()[0];
  assert.equal(status?.consecutiveFailures, 4);
  assert.equal(status?.backoffUntilMs, clock + 4_000, '快照里能读出"退避到哪一刻"');
  assert.ok(
    logs.some((line) => line.includes('退避')),
    '日志里也留痕（排障时不必猜为什么它不重试）',
  );
});

test('A② 退避默认值：10s 起、300s 封顶（与 idleReclaimMs 同一个重置窗口）', () => {
  assert.equal(DEFAULT_BACKOFF_BASE_MS, 10_000);
  assert.equal(DEFAULT_BACKOFF_CAP_MS, 300_000);
  assert.equal(
    DEFAULT_BACKOFF_RESET_MS, DEFAULT_IDLE_RECLAIM_MS,
    '重置窗口与空闲回收窗口**同一个数**（少一个要记的常量）',
  );
});

test('A② 成功之后稳定运行满重置窗口 ⇒ 计数归零（不拿"很久以前那几次"累计）', async (t) => {
  let fail = true;
  let clock = 5_000_000;
  const h = createHarness(t, {
    idleReclaimMs: 10,
    pool: {
      now: () => clock,
      backoffBaseMs: 1_000,
      backoffCapMs: 4_000,
      backoffResetMs: 5_000,
      spawner: (entry: McpServerEntry) => {
        if (fail) throw new Error('起不来（测试注入）');
        return defaultMcpProcessSpawner(entry);
      },
    },
  });

  // ① 失败一次 ⇒ 账上 1 次
  const first = await h.pool.callTool('fake', 'echo', { text: 'x' });
  assert.equal(first.isError, true);
  assert.equal(h.pool.status()[0]?.consecutiveFailures, 1);

  // ② 等退避过去，让它真起来一次（成功 ⇒ 记下"这一刻它是好的"）
  clock += 1_001;
  fail = false;
  const ok = await h.pool.callTool('fake', 'echo', { text: 'x' });
  assert.equal(ok.isError ?? false, false, '退避过去之后它其实是好的');
  assert.equal(h.pool.status()[0]?.consecutiveFailures, 1, '刚成功还不足以清零：窗口是"稳定运行满"');

  // ③ 回收掉它，稳定运行满 5s 之后又失败 ⇒ 算**第一次**（不是第二次）
  clock += 20;
  await h.pool.reclaimIdle();
  assert.equal(h.pool.status()[0]?.running, false);
  clock += 6_000;
  fail = true;
  const again = await h.pool.callTool('fake', 'echo', { text: 'x' });
  assert.equal(again.isError, true);
  assert.equal(h.pool.status()[0]?.consecutiveFailures, 1, '稳定运行过 ⇒ 这本账从头开始');
  const blocked = await h.pool.callTool('fake', 'echo', { text: 'x' });
  assert.match(blocked.content, /连续启动失败 1 次/u);
});

// ──────────────────────────────── A③ 资源观测（2026-10-10） ────────────────────────────────

test('A③ 资源观测：启动耗时 / RSS / 在飞峰值 / 回收时刻 都进 internal 事件与快照', async (t) => {
  const h = createHarness(t, {
    pool: { rssSampler: async () => ({ rssMb: 46.5, source: 'proc' as const }) },
  });
  await h.pool.listTools('fake', { requireConnected: true });
  const started = h.started()[0];
  assert.ok((started?.startMs ?? -1) >= 0, 'mcp/server-started 带本次启动耗时');

  // 资源采样是**异步**落的：等它到
  await waitFor(() => h.pool.status()[0]?.rssMb !== null, 1_000, '资源采样');
  const resource = h.events.find((e) => e.type === 'mcp/server-resource')?.data as
    { rssMb: number | null; rssSource: string; startMs: number; inFlightPeak: number } | undefined;
  assert.ok(resource !== undefined, 'mcp/server-resource 落了');
  assert.equal(resource?.rssMb, 46.5);
  assert.equal(resource?.rssSource, 'proc', '采样来源如实带出（没采到与 0 MB 必须分得开）');
  assert.ok((resource?.startMs ?? -1) >= 0);
  assert.ok(
    (resource?.inFlightPeak ?? 0) >= 1,
    '握手自己就是一条在飞请求（initialize / tools/list）⇒ 峰值至少 1',
  );

  const snapshot = h.pool.status()[0];
  assert.equal(snapshot?.rssMb, 46.5);
  assert.equal(snapshot?.rssSource, 'proc');
  assert.ok((snapshot?.lastStartMs ?? -1) >= 0);

  // 回收：一条 stopped 事件带活多久 + 峰值 + 最后采到的 RSS
  await h.pool.shutdown();
  const stopped = h.stopped()[0];
  assert.equal(stopped?.reason, 'shutdown');
  assert.ok((stopped?.uptimeMs ?? -1) >= 0, 'uptimeMs 答"它活了多久"');
  assert.ok((stopped?.inFlightPeak ?? 0) >= 1, '整个生命周期的在飞峰值（握手那一条至少算 1）');
  assert.equal(stopped?.rssMb, 46.5, '回收事件带最近一次采到的 RSS');
  assert.ok((h.pool.status()[0]?.lastReclaimedAtMs ?? 0) > 0, '快照里有最近一次回收时刻');
  assert.equal(h.pool.status()[0]?.lastStopReason, 'shutdown');
});

test('A③ 采样器缺省不上：给 null 就不落资源事件（观测不该拖慢被观测的东西）', async (t) => {
  const h = createHarness(t, { pool: { rssSampler: null } });
  await h.pool.listTools('fake', { requireConnected: true });
  await sleep(50);
  assert.equal(h.events.some((e) => e.type === 'mcp/server-resource'), false);
  assert.equal(h.pool.status()[0]?.rssMb, null);
  assert.equal(h.pool.status()[0]?.rssSource, 'unavailable', '"没采到"不是"0 MB"');
});

test('A③ 采样开关三级优先：显式注入 > 环境变量 > 配置 > 出厂开（写错值 = "没说"，交给下一级）', () => {
  // Windows 上采一次要起一个 tasklist（**本机实测中位数 509 ms**），所以必须留"彻底关掉"的口子。
  // 优先级是**两轮**谈定的：环境变量（命令行临时开关）比 config.json 优先，显式注入最高（测试用）。
  const restore = process.env['IRMIA_MCP_RSS_SAMPLE'];
  try {
    delete process.env['IRMIA_MCP_RSS_SAMPLE'];
    assert.equal(rssSampleEnvOverride(), null, '没写 = 没意见');
    assert.equal(resolveRssSampler({}), defaultMcpRssSampler, '① 出厂缺省 = 开');
    assert.equal(resolveRssSampler({ rssSample: false }), null, '② 配置关 ⇒ 关');
    assert.equal(resolveRssSampler({ rssSample: true }), defaultMcpRssSampler, '② 配置开 ⇒ 开');

    for (const off of ['0', 'false', 'OFF', ' no ']) {
      process.env['IRMIA_MCP_RSS_SAMPLE'] = off;
      assert.equal(rssSampleEnvOverride(), false, `${JSON.stringify(off)} = 关`);
      assert.equal(resolveRssSampler({ rssSample: true }), null, '环境变量 > 配置（临时关掉）');
      assert.equal(resolveRssSampler({ rssSampler: null }), null);
    }
    for (const on of ['1', 'true', 'yes', 'ON']) {
      process.env['IRMIA_MCP_RSS_SAMPLE'] = on;
      assert.equal(rssSampleEnvOverride(), true, `${JSON.stringify(on)} = 开`);
      assert.equal(resolveRssSampler({ rssSample: false }), defaultMcpRssSampler, '环境变量 > 配置（临时打开）');
    }
    for (const junk of ['乱写的值', '', '2', 'yep']) {
      process.env['IRMIA_MCP_RSS_SAMPLE'] = junk;
      assert.equal(rssSampleEnvOverride(), null, `${JSON.stringify(junk)} = 没说（拼错的开关不许悄悄改行为）`);
      assert.equal(resolveRssSampler({ rssSample: false }), null, '没意见 ⇒ 配置说话');
    }
    // 显式注入最高：宿主/测试给了就按它，环境变量都不看
    const stub: McpRssSampler = async () => ({ rssMb: 1, source: 'unavailable' });
    process.env['IRMIA_MCP_RSS_SAMPLE'] = '0';
    assert.equal(resolveRssSampler({ rssSampler: stub }), stub, '显式注入 > 环境变量');
  } finally {
    if (restore === undefined) delete process.env['IRMIA_MCP_RSS_SAMPLE'];
    else process.env['IRMIA_MCP_RSS_SAMPLE'] = restore;
  }
});

test('A③ 池按三级优先接住开关：配置关 ⇒ 不落资源事件；配置开 + 环境变量关 ⇒ 也不落', async (t) => {
  const restore = process.env['IRMIA_MCP_RSS_SAMPLE'];
  try {
    delete process.env['IRMIA_MCP_RSS_SAMPLE'];
    const off = createHarness(t, { pool: { rssSample: false } });
    await off.pool.listTools('fake', { requireConnected: true });
    await sleep(50);
    assert.equal(off.events.some((e) => e.type === 'mcp/server-resource'), false, '配置关 ⇒ 不采');
    assert.equal(off.pool.status()[0]?.rssSource, 'unavailable', '关掉后那几格如实留空（不是填 0）');

    // 配置开着，但命令行临时关：环境变量赢
    const h = createHarness(t, { pool: { rssSample: true } });
    process.env['IRMIA_MCP_RSS_SAMPLE'] = '0';
    await h.pool.listTools('fake', { requireConnected: true });
    await sleep(50);
    assert.equal(h.events.some((e) => e.type === 'mcp/server-resource'), false, '环境变量关 ⇒ 不采');
  } finally {
    if (restore === undefined) delete process.env['IRMIA_MCP_RSS_SAMPLE'];
    else process.env['IRMIA_MCP_RSS_SAMPLE'] = restore;
  }
});

test('A③ 真读数（Windows）：量到的是**整棵树**；采不到就如实 unavailable，不编 0', async () => {
  if (process.platform !== 'win32') return; // 这一条只验 Windows 那条路
  const sample = await defaultMcpRssSampler(process.pid);
  assert.equal(sample.source, 'cim-tree', 'Windows 上走的是 CIM 那条整棵树的路');
  assert.ok((sample.rssMb ?? 0) > 5, `本进程的 RSS 应当读得到（实际 ${JSON.stringify(sample)}）`);
  // 一个不存在的 pid：**必须是 unavailable**，不许把"读不到"说成 0
  const dead = await defaultMcpRssSampler(999_999_999);
  assert.deepEqual(dead, { rssMb: null, source: 'unavailable' });
  // 非正整数 pid：连命令都不该起
  assert.deepEqual(await defaultMcpRssSampler(0), { rssMb: null, source: 'unavailable' });
});

// ──────────────────── A④ 整棵进程树（2026-10-10 第二版；第一版只量根进程） ────────────────────

test('A④ 纯函数：自根向下求和（只算子树的、算上孙进程、防环、root 不在表里 ⇒ null）', () => {
  const mb = (n: number): number => Math.round(n * 1024 * 1024);
  const rows = [
    { pid: 100, ppid: 1, rssBytes: mb(10) },     // 根（启动器：uvx / npx 那一层）
    { pid: 101, ppid: 100, rssBytes: mb(20) },   // 子（真 server）
    { pid: 102, ppid: 101, rssBytes: mb(30) },   // 孙（Python 解释器 / console-script）
    { pid: 103, ppid: 100, rssBytes: mb(40) },   // 另一个子（conhost 那种）
    { pid: 200, ppid: 1, rssBytes: mb(999) },    // 根的同级：**不算**
    { pid: 201, ppid: 200, rssBytes: mb(888) },  // 同级的子树：**也不算**
  ];
  const sum = sumProcessTree(rows, 100);
  assert.ok(sum !== null);
  assert.equal(sum.processes, 4, '根 + 两个子 + 一个孙 = 4（同级与它的子树一个都不许进来）');
  assert.ok(Math.abs(sum.rssBytes / (1024 * 1024) - 100) < 0.001, '和 = 10+20+30+40 = 100 MB');

  // 防环：ppid 表是外部数据，`A→B→A` 不许把求和变成死循环
  const cyclic = sumProcessTree([
    { pid: 1, ppid: 2, rssBytes: mb(1) },
    { pid: 2, ppid: 1, rssBytes: mb(2) },
  ], 1);
  assert.ok(cyclic !== null);
  assert.equal(cyclic.processes, 2, '环里的两个各算一次（不重复加、也转得出来）');

  // root 不在表里 ⇒ null：**"0 个进程的和"不许冒充一个数**（让调用方降级或答 unavailable）
  assert.equal(sumProcessTree(rows, 999), null);
  // 单进程形态 ⇒ processes = 1（两种口径在数值上分得开）
  const solo = sumProcessTree([{ pid: 7, ppid: 1, rssBytes: mb(5) }], 7);
  assert.ok(solo !== null);
  assert.equal(solo.processes, 1);
  assert.equal(solo.rssBytes, mb(5));
});

test('A④ 纯函数：两种读数格式的解析（坏行丢掉、绝不抛）', () => {
  // CIM：`pid,ppid,bytes`（Windows；含空行 / 半截行 / 非数字）
  const cim = parseCimProcessTable('0,0,8192\r\n105216,70000,53484544\r\n半截行\r\n,,\r\nx,y,z\r\n');
  assert.deepEqual(
    cim.map((row) => [row.pid, row.ppid, row.rssBytes]),
    [[0, 0, 8192], [105216, 70000, 53484544]],
    '只收三格都能转成数的那两行',
  );
  // ps：`pid ppid rss(KB)`（其它平台；rss 是 KB ⇒ 归一成字节）
  const ps = parsePsProcessTable('    1     0  1024\n  200   1  2048\n\n乱的一行\n');
  assert.deepEqual(
    ps.map((row) => [row.pid, row.ppid, row.rssBytes]),
    [[1, 0, 1024 * 1024], [200, 1, 2048 * 1024]],
  );
  assert.deepEqual(parseCimProcessTable(''), []);
  assert.deepEqual(parsePsProcessTable(''), []);
});

test('A④ 平台分支与降级：都能在同一台机器上确定性地走一遍（注入读数出口）', async () => {
  const mb = (n: number): number => Math.round(n * 1024 * 1024);
  const never = async (): Promise<string> => { throw new Error('这条路在这台机器上跑不通（测试注入）'); };

  // ① Windows 整棵树：一条 CIM，父子表在 JS 里求和
  const winArgs: string[][] = [];
  const win = createMcpRssSampler({
    platform: 'win32',
    runCapture: async (command, args) => {
      assert.equal(command, 'powershell.exe', 'Windows 整棵树走 powershell.exe + Win32_Process');
      winArgs.push([...args]);
      return `100,1,${mb(10)}\r\n101,100,${mb(20)}\r\n`;
    },
  });
  const treeSample = await win(100);
  assert.equal(treeSample.source, 'cim-tree');
  assert.equal(treeSample.processes, 2, '整棵树：根 + 子');
  assert.equal(treeSample.rssMb, 30, '10 + 20 MB');
  assert.ok(winArgs[0]?.some((arg) => arg.includes('ParentProcessId')), '判据就在 ParentProcessId 上');

  // ② Windows 降级：没有 PowerShell / CIM 被策略挡 / 超时 ⇒ 退回 tasklist（**只量根进程**）
  const degraded = createMcpRssSampler({
    platform: 'win32',
    runCapture: async (command) => {
      if (command === 'powershell.exe') throw new Error('CIM 这条路不通（测试注入）');
      assert.equal(command, 'tasklist', '降级路是原来那一条');
      return '"node.exe","100","Console","1","10,240 K"\n';
    },
  });
  const degradedSample = await degraded(100);
  assert.equal(degradedSample.source, 'tasklist', '口径如实标成"只剩根进程"的那一个');
  assert.equal(degradedSample.processes, 1, '降级口径就是 1 个进程');
  assert.equal(degradedSample.rssMb, 10);

  // ③ 其它平台整棵树：`ps -Ao pid=,ppid=,rss=`（本机是 Windows ⇒ 这条路**没有真跑过**，只验判据与算术）
  const linux = createMcpRssSampler({
    platform: 'linux',
    runCapture: async (command, args) => {
      assert.equal(command, 'ps');
      assert.deepEqual([...args], [...POSIX_TREE_RSS_ARGS]);
      return '100 1 1024\n101 100 2048\n';
    },
  });
  const linuxTree = await linux(100);
  assert.equal(linuxTree.source, 'ps-tree');
  assert.equal(linuxTree.processes, 2);
  assert.equal(linuxTree.rssMb, 3, '1024 + 2048 KB = 3 MB');

  // ④ Linux 降级：`ps` 不通 ⇒ 读 /proc/<pid>/status 的 VmRSS
  const readPaths: string[] = [];
  const linuxDegraded = createMcpRssSampler({
    platform: 'linux',
    runCapture: never,
    readFile: (path) => {
      readPaths.push(path);
      return 'Name:\tnode\nVmRSS:\t  2048 kB\n';
    },
  });
  const procSample = await linuxDegraded(100);
  assert.deepEqual(readPaths, ['/proc/100/status']);
  assert.equal(procSample.source, 'proc');
  assert.equal(procSample.processes, 1);
  assert.equal(procSample.rssMb, 2);

  // ⑤ 全都读不到 ⇒ unavailable（**不是 0**），而且一个进程数都不许编
  const dead = createMcpRssSampler({ platform: 'win32', runCapture: never });
  assert.deepEqual(await dead(100), { rssMb: null, source: 'unavailable' });
  // 非正整数 pid：连命令都不起
  assert.deepEqual(await dead(0), { rssMb: null, source: 'unavailable' });
});

/**
 * 真进程夹具：根进程再 spawn 一个"睡着的"子进程。
 *
 * 收尾**不发信号、不杀进程**：关掉根进程的 stdin（`stdin.on('end')` ⇒ 它自己退），
 * 那个睡着的孙进程到点自己退（6s）。
 */
const FIXTURE_ROOT_SCRIPT = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'ignore' });
console.log(String(child.pid));
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`.trim();

function spawnFixtureRoot(script: string): ChildProcess {
  return spawn(process.execPath, ['-e', script], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
}

/** 等夹具把子进程 pid 印出来（只用来确认它真的起了个子进程） */
async function firstLine(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (stream === null) return '';
  return await new Promise<string>((resolve) => {
    let buffer = '';
    const timer = setTimeout(() => { resolve(buffer.trim()); }, 2_000);
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\n')) {
        clearTimeout(timer);
        resolve(buffer.trim());
      }
    });
  });
}

test('A④ 真进程夹具：采到的是**树的和**，不是只有根进程', async () => {
  const root = spawnFixtureRoot(FIXTURE_ROOT_SCRIPT);
  try {
    const childPid = Number.parseInt((await firstLine(root.stdout)).split(/\r?\n/u)[0] ?? '', 10);
    assert.ok(Number.isInteger(childPid) && childPid > 0, '夹具真的起了一个子进程');

    const tree = await defaultMcpRssSampler(root.pid ?? 0);
    const single = await singleProcessMcpRssSampler(root.pid ?? 0);
    assert.match(tree.source, /-tree$/u, `整棵树那条路（实际 ${tree.source}）`);
    assert.ok((tree.processes ?? 0) >= 2, `树里至少是"根 + 子"（实际 ${JSON.stringify(tree)}）`);
    assert.notEqual(single.source, tree.source, '降级口径的来源与整棵树分得开');
    assert.ok(
      (tree.rssMb ?? 0) > (single.rssMb ?? 0),
      `整棵树必须**大于**只量根进程（树 ${tree.rssMb} vs 根 ${single.rssMb}）`,
    );
    // 子进程是一个完整的 node（≈40 MB 级）+ conhost：差值必须是"看得见的一大块"，不是噪声
    assert.ok(
      (tree.rssMb ?? 0) - (single.rssMb ?? 0) > 20,
      `这一版修的就是这个低报：差值应当远大于 0（实际 ${(tree.rssMb ?? 0) - (single.rssMb ?? 0)} MB）`,
    );
  } finally {
    root.stdin?.end();
  }
});

test('A④ 对照：只有单进程形态时数值不变（差值只该是 conhost 那一份）', async () => {
  const solo = spawnFixtureRoot('setTimeout(() => {}, 6000);');
  try {
    const tree = await defaultMcpRssSampler(solo.pid ?? 0);
    const single = await singleProcessMcpRssSampler(solo.pid ?? 0);
    assert.ok((tree.processes ?? 0) <= 3,
      `单进程形态：树上只该多一份 conhost（实际 ${JSON.stringify(tree)}）`);
    const gap = (tree.rssMb ?? 0) - (single.rssMb ?? 0);
    assert.ok(gap >= -1 && gap <= 24,
      `两种口径的差只该是 conhost 那一份（实测 ${gap} MB，树 ${tree.rssMb} / 根 ${single.rssMb}）`);
  } finally {
    solo.stdin?.end();
  }
});

// ──────────────────────────────── B④ 在飞上限 + 背压（2026-10-10） ────────────────────────────────

test('B④ per-server 在飞上限：超限**如实拒绝**（不排队、不抢占）', async (t) => {
  const h = createHarness(t, {
    env: { FAKE_MCP_RESPOND_AFTER_MS: '300' },
    pool: { maxInFlight: 100, maxInFlightPerServer: 2 },
  });
  await h.pool.listTools('fake', { requireConnected: true });

  const calls = [1, 2, 3].map(() => h.pool.callTool('fake', 'echo', { text: '并发' }));
  const results = await Promise.all(calls);
  const overloaded = results.filter((item) => item.error?.code === MCP_ERROR_CODES.overloaded);
  assert.equal(overloaded.length, 1, '第 3 件被如实拒掉（上限 2）');
  assert.match(overloaded[0]?.content ?? '', /同时在飞的调用已达上限 2 件/u);
  assert.match(overloaded[0]?.content ?? '', /没有发出去/u);
  assert.match(overloaded[0]?.content ?? '', /同时调用太多/u);
  assert.equal(results.filter((item) => (item.isError ?? false) === false).length, 2, '另外两件照跑');
});

test('B④ 池级在飞上限：整池超限也如实拒绝（跨 server 的总量）', async (t) => {
  const h = createHarness(t, {
    env: { FAKE_MCP_RESPOND_AFTER_MS: '300' },
    pool: { maxInFlight: 2, maxInFlightPerServer: 100 },
  });
  await h.pool.listTools('fake', { requireConnected: true });
  const results = await Promise.all([1, 2, 3].map(() => h.pool.callTool('fake', 'echo', { text: '整池' })));
  const overloaded = results.filter((item) => item.error?.code === MCP_ERROR_CODES.overloaded);
  assert.equal(overloaded.length, 1);
  assert.match(overloaded[0]?.content ?? '', /整池同时在飞的 MCP 调用已达上限 2 件/u);
  assert.equal(h.pool.status()[0]?.inFlightPeak, 2, '在飞峰值记下来了（观测面读得到）');
});

test('B④ 退避与在飞上限**不是同一本账**：上限拒绝不进崩溃退避', async (t) => {
  const h = createHarness(t, {
    env: { FAKE_MCP_RESPOND_AFTER_MS: '200' },
    pool: { maxInFlight: 100, maxInFlightPerServer: 1 },
  });
  await h.pool.listTools('fake', { requireConnected: true });
  const results = await Promise.all([
    h.pool.callTool('fake', 'echo', { text: 'a' }),
    h.pool.callTool('fake', 'echo', { text: 'b' }),
  ]);
  assert.ok(results.some((item) => item.error?.code === MCP_ERROR_CODES.overloaded));
  assert.equal(h.pool.status()[0]?.consecutiveFailures, 0, '"问得太急"不该让它背上"起不来"的账');
  assert.equal(h.pool.status()[0]?.backoffUntilMs, null);
});

// ──────────────────────────────── B⑤ 启动失败隔离（2026-10-10 核实 + 补一个缺口） ────────────────
//
// 判据（纪律 4「崩溃不传染」）：一个 server 起不来 / 崩了，**不许**影响其它 server 与调用方。
// 核实结论（代码复核 + 这两条用例）：
//   · `callTool` 永不抛（起不来 ⇒ 一句如实的 errorResult）；`listTools` 抛，但入口那条路接住了；
//   · `ensureReady` 失败只收掉**自己**那个进程（`startConnection` 的 catch 里 reap 的是 `conn`）；
//   · 启动期不 `registerAll()`（main.ts），一个坏 server 连启动都拦不住；
//   · 真缺口在**回收路径**：`reclaimIdle` / `shutdown` 原来直接 `await this.reap(...)`，
//     一个连接在关机序列里抛了就**断在那一行** ⇒ 后面的 server 全都不回收（留下孤儿 + 白占内存）。
//     补法见 `reapOne`：逐个 try/catch，失败的跳过并留一行日志。

test('B⑤ 启动失败隔离：一台起不来，另一台照常工作，调用方拿到的是话不是异常', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'irmia-mcp-iso-'));
  const good = makeFakeProcess({ exitOnStdinEnd: true });
  const events: Array<{ type: string; data: unknown }> = [];
  const logs: string[] = [];
  const registry = new ToolRegistry();
  const pool = new McpClientPool({
    servers: [
      { name: 'bad', command: process.execPath, args: ['x'] },
      { name: 'good', command: process.execPath, args: ['x'] },
    ],
    emit: (type, data) => { events.push({ type, data }); },
    dataDir,
    registry,
    onLog: (line) => { logs.push(line); },
    backoffBaseMs: 50,
    backoffCapMs: 50,
    ...FAST_SHUTDOWN,
    spawner: (entry: McpServerEntry) => {
      if (entry.name === 'bad') throw new Error('起不来（测试注入）');
      return good.process;
    },
  });
  t.after(async () => {
    await pool.shutdown().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  });

  // ① 坏的起不来：得到一句如实的话（**不抛**），并且它自己的账记上了
  const bad = await pool.callTool('bad', 'echo', {});
  assert.equal(bad.isError, true);
  assert.match(bad.content, /未能启动/u);
  assert.equal(pool.status().find((item) => item.name === 'bad')?.consecutiveFailures, 1);

  // ② 好的照常工作 + 进注册表 + 事件只记好的那条
  const ok = await pool.callTool('good', 'echo', {});
  assert.equal(ok.isError ?? false, false, `另一台不受影响：${ok.content}`);
  assert.equal(ok.content, 'ok');
  assert.equal(registry.has('mcp__good__echo'), true, '好的那台上线了工具');
  assert.deepEqual(
    events.filter((event) => event.type === 'mcp/server-started')
      .map((event) => (event.data as { name: string }).name),
    ['good'],
    '只有一个启动事件（坏的那台一条都没有）',
  );
  assert.equal(registry.names().some((name) => name.startsWith('mcp__bad__')), false);

  // ③ 坏的那台被点第二次只是"退避"（不再试），好的那台继续可用
  const again = await pool.callTool('bad', 'echo', {});
  assert.match(again.content, /连续启动失败 1 次/u);
  const okAgain = await pool.callTool('good', 'echo', {});
  assert.equal(okAgain.isError ?? false, false, '一个坏 server 的退避不许牵连到别的 server');

  // ④ 坏的**不进** started/stopped 事件，也不在快照里冒充"在跑"
  assert.equal(events.some((event) => event.type === 'mcp/server-stopped'), false);
  assert.equal(pool.status().find((item) => item.name === 'bad')?.running, false);
  assert.ok(logs.some((line) => line.includes('退避')), '坏的那台在日志里留痕');
});

test('B⑤ 回收隔离：一台收不掉，不许拦住其余 server 的回收与关停', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'irmia-mcp-iso2-'));
  const stuck = makeFakeProcess({ exitOnStdinEnd: false, exitOnTerm: false, exitOnKill: false });
  const healthy = makeFakeProcess({ exitOnStdinEnd: true });
  // 坏句柄：关机序列的第一步就抛（进程句柄坏掉/平台相关的 kill 异常都是这个形状）
  let brokenCloseStdinCalls = 0;
  const brokenHandle: McpProcess = {
    ...stuck.process,
    closeStdin() {
      brokenCloseStdinCalls += 1;
      throw new Error('句柄坏了（测试注入）');
    },
  };
  const logs: string[] = [];
  // 假时钟 + 60s 窗口：扫描器周期是窗口的 1/4（=5s），这个用例跑不到 5s
  // ⇒ "谁回收的"完全确定（不会出现"后台扫描器顺手替我收了"那种偶发绿）
  let clock = 1_000_000;
  const pool = new McpClientPool({
    servers: [
      { name: 'broken', command: process.execPath, args: ['x'] },
      { name: 'healthy', command: process.execPath, args: ['x'] },
    ],
    emit: () => undefined,
    dataDir,
    onLog: (line) => { logs.push(line); },
    idleReclaimMs: 60_000,
    now: () => clock,
    ...FAST_SHUTDOWN,
    spawner: (entry: McpServerEntry) => (entry.name === 'broken' ? brokenHandle : healthy.process),
  });
  t.after(async () => {
    await pool.shutdown().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  });

  await pool.listTools('broken', { requireConnected: true });
  await pool.listTools('healthy', { requireConnected: true });
  // 空闲回收：坏的那台抛 ⇒ 它之后的**健康那台照样被回收**（修前这里一条都收不掉）
  clock += 60_001; // 让两条都过掉回收窗口（假时钟 ⇒ 确定，不靠 sleep）
  const reports = await pool.reclaimIdle();
  assert.equal(brokenCloseStdinCalls, 1, '前提：坏的那台真走到了关机序列第一步（然后抛了）');
  assert.deepEqual(reports.map((report) => report.name), ['healthy'],
    `收不掉的不进报告，但别拦住后面的：${JSON.stringify(reports)}`);
  assert.equal(pool.status().find((item) => item.name === 'healthy')?.running, false);
  assert.ok(
    logs.some((line) => line.includes('回收失败') && line.includes('broken')),
    '收不掉的那台必须留一行日志（"少了一个进程"要看得见）',
  );

  // 关停同一条纪律：`shutdown()` 不许因为一个坏连接就中途放弃
  await pool.listTools('healthy', { requireConnected: true });
  const atExit = await pool.shutdown();
  assert.deepEqual(atExit.map((report) => report.name), ['healthy'], '退出时仍然把能收的都收掉');
  assert.equal((healthy.calls.filter((call) => call === 'closeStdin').length) >= 1, true);
});

// ──────────────────────────────── B⑥ 懒连接的正确性（2026-10-10 核实） ────────────────────────────────

test('B⑥ "只是列清单"这条路不会顺手拉起 server：status / 无缓存的 listTools 都不起进程', async (t) => {
  const spawned: string[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), 'irmia-mcp-lazy-'));
  const markerDir = mkdtempSync(join(tmpdir(), 'irmia-mcp-lazy-mark-'));
  const entries: McpServerEntry[] = ['a', 'b', 'c'].map((name) => ({
    name, command: process.execPath, args: [FAKE_SERVER], env: { FAKE_MCP_MARKER_DIR: markerDir },
  }));
  const pool = new McpClientPool({
    servers: entries,
    emit: () => undefined,
    dataDir,
    onLog: () => undefined,
    spawner: (entry: McpServerEntry) => {
      spawned.push(entry.name);
      return defaultMcpProcessSpawner(entry);
    },
    ...FAST_SHUTDOWN,
  });
  t.after(async () => {
    await pool.shutdown().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
    rmSync(markerDir, { recursive: true, force: true, maxRetries: 5 });
  });

  // ① 第一层（声明面快照）：一个进程都不起
  assert.equal(pool.status().length, 3);
  assert.deepEqual(spawned, [], 'status() 读的是池构造时定下的那一份，不落盘、不起进程');

  // ② 无缓存 + requireConnected 缺省：返回空 + 来源 none，**仍然不起进程**
  for (const name of ['a', 'b', 'c']) {
    let source: { source: string } | null = null;
    const tools = await pool.listTools(name, { onSource: (info) => { source = info; } });
    assert.deepEqual(tools, []);
    assert.equal(source?.source, 'none', '"没有清单来源"与"它一件工具都没有"是两句话');
  }
  assert.deepEqual(spawned, [], '列清单这条路没有顺手拉起任何一个 server');

  // ③ 只有真的 requireConnected 才起，而且**只起被点名的那一个**
  await pool.listTools('b', { requireConnected: true });
  assert.deepEqual(spawned, ['b'], '只拉起被点名的那一个');
});

// ────────────── C⑦ 起进程那一层：`npx` 的形状在起进程之前就被换成一句能照做的诊断 ──────────────

test('C⑦ Windows：`npx` / `npx.cmd` 的**回执**是一句能照做的话（不是裸 ENOENT/EINVAL）', async (t) => {
  if (process.platform !== 'win32') return; // 非 Windows 上 npx 是真能起的，这一条不适用
  const dataDir = mkdtempSync(join(tmpdir(), 'irmia-mcp-npx-'));
  const events: Array<{ type: string }> = [];
  const logs: string[] = [];
  const pool = new McpClientPool({
    // 出厂示例就是这么写的（`config.ts` 的 mcp 段旧注释、半个生态的 README 也一样）
    servers: [{ name: 'npxsrv', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] }],
    emit: (type) => { events.push({ type }); },
    dataDir,
    onLog: (line) => { logs.push(line); },
    ...FAST_SHUTDOWN,
  });
  t.after(async () => {
    await pool.shutdown().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  });

  const result = await pool.callTool('npxsrv', 'list_allowed_directories', {});
  assert.equal(result.isError, true, '这次调用必须如实失败');
  // 「为什么」与「改成什么」两段都必须在回执里
  assert.match(result.content, /在 Windows 上起不来/u, `要说清为什么（实际：${result.content}）`);
  assert.match(result.content, /ENOENT/u, '带上实测到的那件事');
  assert.match(result.content, /node <绝对路径>\/cli\.js/u, '给出路①');
  assert.match(result.content, /uvx <工具名>/u, '给出路②');
  assert.match(result.content, /没有为它留下任何进程/u, '说清这一步判在起进程之前');
  assert.match(result.content, /MCP server npxsrv 未能启动/u, '仍然是那条"未能启动"的回执（措辞没换）');
  // **最要紧的一条**：一个进程都没有起过（不是"起了才发现 ENOENT"）
  assert.equal(events.some((event) => event.type === 'mcp/server-started'), false, '没有起过任何进程');
  assert.equal(pool.status()[0]?.running, false);
  assert.equal(pool.status()[0]?.consecutiveFailures, 1, '照旧进"起不来"那本账（退避从下一次开始）');
  assert.ok(logs.some((line) => line.includes('在 Windows 上起不来')), '日志里也留一句同样的话');

  // `.cmd` 那条路（实测同步 EINVAL）：同样的诊断，不是"没见过的异常"
  const cmdPool = new McpClientPool({
    servers: [{ name: 'cmdsrv', command: 'npx.cmd', args: ['-y', 'x'] }],
    emit: () => undefined,
    dataDir,
    onLog: () => undefined,
    ...FAST_SHUTDOWN,
  });
  t.after(async () => {
    await cmdPool.shutdown().catch(() => undefined);
  });
  const cmdResult = await cmdPool.callTool('cmdsrv', 'x', {});
  assert.equal(cmdResult.isError, true);
  assert.match(cmdResult.content, /EINVAL/u);
  assert.match(cmdResult.content, /CVE-2024-27980/u);
  assert.match(cmdResult.content, /uvx <工具名>/u);
});

test('C⑦ 起进程那一层：能起的形状照旧真的去起（诊断不许误伤）', async () => {
  // ① 放行：绝对路径的 node.exe（实测 spawned exit=0）——真起一个会自己退的进程（不发信号、不杀）
  const child = defaultMcpProcessSpawner({ name: 'x', command: process.execPath, args: ['--version'] });
  assert.ok((child.pid ?? 0) > 0, '真去起了（拿到 pid）');
  await new Promise<void>((resolve) => {
    child.onExit(() => { resolve(); });
    setTimeout(resolve, 5_000);
  });

  // ② 拦下：Windows 上的 npx 形状**抛在 spawn 之前**（所以上面那种"起了才发现"的事不会发生）
  if (process.platform === 'win32') {
    for (const command of ['npx', 'npx.cmd']) {
      assert.throws(
        () => defaultMcpProcessSpawner({ name: 'x', command, args: ['-y', 'x'] }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /在 Windows 上起不来/u);
          assert.match(err.message, /node <绝对路径>\/cli\.js/u);
          return true;
        },
        `${command} 必须在起进程之前被换成诊断`,
      );
    }
    // 真 .exe 的启动器一个都不许被这条路拦（`uvx` / `cmd` 都实测能起）。
    // 两条都自己退（`--version` / `/c exit`）：**不发信号、不杀进程**，超时也只是不等它。
    for (const [command, args] of [['uvx', ['--version']], ['cmd', ['/c', 'exit']]] as const) {
      const handle = defaultMcpProcessSpawner({ name: 'x', command, args: [...args] });
      await new Promise<void>((resolve) => {
        handle.onExit(() => { resolve(); });
        setTimeout(resolve, 5_000);
      });
    }
  }
});
