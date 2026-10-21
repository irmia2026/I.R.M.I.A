/**
 * M2 崩溃注入测试 T6–T10（docs/milestones.md §M2「崩溃注入测试」）
 *
 * 方法：真子进程（test/fixtures/crash-scenario.ts）按场景把「崩溃前已经落库的事件」写盘，
 * 到达崩溃点后由本测试用 SIGKILL 强杀，再走 recover() 七步验证「进程被杀之后系统怎么收场」。
 * 每个场景的预期基准都来自子进程写下的崩溃点哨兵（crash-point.json），测试不另抄一份常量。
 *
 * 为什么必须是真子进程：崩溃恢复的正确性只能由「进程真的死了、盘上真的只剩这些字节」来证明。
 * 在同进程里 try/finally 或 mock 出来的杀进程路径，证明不了任何事。
 *
 * Windows 语义：SIGKILL 落成 TerminateProcess，被杀进程的退出码是 1 或 null，不是 Unix 的信号
 * 语义。所以这里只断言「非 0 退出」，绝不比对信号名或信号编号。
 *
 * 每个场景都额外断言投影的水位不变量：水位不越过日志末尾，也不能越过尚未处理的输入。
 *
 * 说明：Node 的类型剥离不做 `.js` → `.ts` 映射，所以这里用显式 `.ts` 说明符导入源码。
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';

import type {
  AppEvent, AssistantMessage, InputRequeued, Projection, ToolCall, ToolResult, ToolZombie, TurnEnd,
} from '../src/log/types.ts';
import { render, type InputItem } from '../src/model/render.ts';
import type { EventLog } from '../src/log/event-log.ts';
import { applyOne } from '../src/state/fold.ts';
import { EVENT_LOG_DIR_NAME, recover } from '../src/runtime/recover.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 夹具装配 ────────────────────────────────

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCENARIO_SCRIPT = join(PROJECT_ROOT, 'test', 'fixtures', 'crash-scenario.ts');
/** 等待子进程到达崩溃点的上限：node 冷启动 + 折叠空日志通常 < 1 秒 */
const CRASH_POINT_TIMEOUT_MS = 30_000;
/** 强杀后等待 exit 事件的上限 */
const EXIT_TIMEOUT_MS = 15_000;
const POLL_MS = 20;

/** 子进程写下的崩溃点哨兵：它是断言基准，两侧不各写一份常量 */
interface CrashPoint {
  scenario: string;
  turn: number;
  wakeSeq: number;
  callId?: string;
  callSeq?: number;
  sideEffect?: string;
  doneCallId?: string;
  doneCallSeq?: number;
  openCallId?: string;
  openCallSeq?: number;
  pushedText?: string;
  fullText?: string;
  deltasSeen?: number;
}

interface Fixture {
  dir: string;
  eventDir: string;
  sentinelPath: string;
  /** 直接读盘上的全部分片：恢复期写入的事件会落进新分片，必须读全 */
  events: () => AppEvent[];
  types: () => string[];
}

function makeFixture(t: TestContext): Fixture {
  const dir = tempDirSync('irmia-crash-');
  const eventDir = join(dir, EVENT_LOG_DIR_NAME);
  mkdirSync(eventDir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const events = (): AppEvent[] =>
    readdirSync(eventDir)
      .filter(name => name.endsWith('.jsonl'))
      .sort()
      .flatMap(name => readFileSync(join(eventDir, name), 'utf8')
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => JSON.parse(line) as AppEvent));

  return {
    dir,
    eventDir,
    sentinelPath: join(dir, 'crash-point.json'),
    events,
    types: () => events().map(e => e.type),
  };
}

/** 强杀：Windows 上 SIGKILL 即 TerminateProcess；taskkill 兜底清掉可能的进程树 */
function killHard(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 已经退出
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  }
}

/** 跑场景脚本到崩溃点，SIGKILL 终结它，返回它写下的崩溃点哨兵 */
async function runScenarioToCrash(fx: Fixture, scenario: string): Promise<CrashPoint> {
  const child = spawn(process.execPath, [
    '--experimental-strip-types', SCENARIO_SCRIPT,
    '--data-dir', fx.dir,
    '--scenario', scenario,
    '--sentinel', fx.sentinelPath,
  ], { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  child.stdout?.resume(); // 排水，避免管道写满把子进程卡住

  const settled = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });

  const deadline = Date.now() + CRASH_POINT_TIMEOUT_MS;
  while (!existsSync(fx.sentinelPath)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      killHard(child);
      await settled;
      throw new Error(
        `场景 ${scenario} 在写崩溃点哨兵之前就退出了（exitCode=${String(child.exitCode)}）\n`
        + `--- 子进程 stderr ---\n${stderr}`,
      );
    }
    if (Date.now() > deadline) {
      killHard(child);
      await settled;
      throw new Error(`场景 ${scenario} 等待崩溃点哨兵超时（${CRASH_POINT_TIMEOUT_MS}ms）\n--- 子进程 stderr ---\n${stderr}`);
    }
    await delay(POLL_MS);
  }

  const point = JSON.parse(readFileSync(fx.sentinelPath, 'utf8')) as CrashPoint;
  killHard(child);
  const exit = await Promise.race([
    settled,
    delay(EXIT_TIMEOUT_MS).then(() => { throw new Error(`场景 ${scenario} 被强杀后仍未退出`); }),
  ]);

  // Windows：被杀进程退出码为 1（或 signal 上报时 code 为 null），只要求「非 0 退出」
  assert.notEqual(
    exit.code, 0,
    `场景 ${scenario} 必须被强杀，实际退出码 ${String(exit.code)}（signal=${String(exit.signal)}）\n--- stderr ---\n${stderr}`,
  );
  return point;
}

interface Recovered {
  projection: Projection;
  events: AppEvent[];
  repairs: string[];
  log: EventLog;
}

/** 重启：走真实恢复七步（拿锁会顺带接管被 SIGKILL 的进程留下的陈旧锁） */
async function recoverAfterCrash(t: TestContext, fx: Fixture): Promise<Recovered> {
  const warnings: string[] = [];
  const result = await recover({
    dataDir: fx.dir,
    log: (level, message, extra) => {
      if (level !== 'warn' && level !== 'error') return;
      warnings.push(`${level}: ${message} ${extra === undefined ? '' : JSON.stringify(extra)}`);
    },
  });
  t.after(() => result.log.close());
  t.after(() => result.lock.release());
  return { projection: result.projection, events: fx.events(), repairs: result.repairs, log: result.log };
}

// ──────────────────────────────── 断言小工具 ────────────────────────────────

function needString(value: unknown, field: string): string {
  assert.equal(typeof value, 'string', `崩溃点哨兵缺少字符串字段 ${field}`);
  return value as string;
}

function needNumber(value: unknown, field: string): number {
  assert.equal(typeof value, 'number', `崩溃点哨兵缺少数字字段 ${field}`);
  return value as number;
}

function toolCallsOf(events: readonly AppEvent[], callId: string): ToolCall[] {
  return events.filter((e): e is ToolCall => e.type === 'tool/call' && e.data.callId === callId);
}

function toolResultsOf(events: readonly AppEvent[], callId: string): ToolResult[] {
  return events.filter((e): e is ToolResult => e.type === 'tool/result' && e.data.callId === callId);
}

function zombieIds(events: readonly AppEvent[], callId?: string): string[] {
  return events
    .filter((e): e is ToolZombie => e.type === 'tool/zombie')
    .filter(e => callId === undefined || e.data.callId === callId)
    .map(e => e.data.callId);
}

function zombieNoteOf(events: readonly AppEvent[], callId: string): string {
  const zombie = events.find((e): e is ToolZombie => e.type === 'tool/zombie' && e.data.callId === callId);
  assert.ok(zombie !== undefined, `缺少 ${callId} 的 tool/zombie 审计记录`);
  return zombie.data.note;
}

function turnEndOf(events: readonly AppEvent[]): TurnEnd {
  const ended = events.find((e): e is TurnEnd => e.type === 'turn/end');
  assert.ok(ended !== undefined, '恢复流程必须补写 turn/end');
  return ended;
}

function requeueOf(events: readonly AppEvent[]): InputRequeued {
  const requeued = events.find((e): e is InputRequeued => e.type === 'input/requeued');
  assert.ok(requeued !== undefined, '被认领的输入必须经 input/requeued 回队列');
  return requeued;
}

/** 水位不变量（schema §9 / §12）：水位不越过日志末尾，也不越过任何未处理输入 */
function assertProgressInvariant(p: Projection): void {
  assert.ok(p.watermark <= p.lastSeq, `水位 ${p.watermark} 不得越过日志末尾 ${p.lastSeq}`);
  for (const item of p.pending) {
    assert.ok(item.wakeSeq > p.watermark, `未处理输入 seq=${item.wakeSeq} 落在水位 ${p.watermark} 之下`);
  }
}

// ──────────────────────────────── T6 ────────────────────────────────

test('T6 工具执行中途 SIGKILL：该调用结算为 unknown（不是 ok 也不是 error）', async (t) => {
  const fx = makeFixture(t);
  const point = await runScenarioToCrash(fx, 't6-tool-exec');
  const callId = needString(point.callId, 'callId');
  const callSeq = needNumber(point.callSeq, 'callSeq');
  const { projection, events, repairs } = await recoverAfterCrash(t, fx);

  // 完整时序即语义：先关 turn → 再结算悬空工具 → 最后退回输入
  assert.deepEqual(fx.types(), [
    'wake/manual', 'turn/start', 'input/claimed', 'step/start', 'message/assistant',
    'tool/call', 'turn/end', 'tool/zombie', 'tool/result', 'input/requeued',
  ]);

  const results = toolResultsOf(events, callId);
  assert.equal(results.length, 1, '悬空调用必须被结算，且只结算一次');
  const status = results[0]!.data.status;
  assert.equal(status, 'unknown');
  // 口径声明：unknown 是第三态，既不能被乐观地当成成功，也不能被简化成失败
  assert.notEqual(status, 'ok');
  assert.notEqual(status, 'error');
  assert.equal(results[0]!.data.callSeq, callSeq, 'callSeq 必须引用原 tool/call 的 seq');
  assert.equal(results[0]!.data.turn, needNumber(point.turn, 'turn'));
  assert.equal(results[0]!.data.error?.code, 'recovered-unknown');
  assert.match(results[0]!.data.content, /unknown/i);

  // 有副作用的调用不得自动重发：重发一次无法撤回的副作用比承认不知道更糟
  assert.equal(toolCallsOf(events, callId).length, 1, '结果未知的 destructive 调用不得被自动重试');
  assert.deepEqual(zombieIds(events, callId), [callId], '审计留痕：tool/zombie 记一条 note');
  assert.match(zombieNoteOf(events, callId), /结果未知/);

  assert.deepEqual(projection.openTools, [], 'unknown 已闭合该调用，不再算开放');
  assert.deepEqual(projection.needsReview.map(r => r.callId), [callId], 'unknown 必须进入待确认');
  assert.ok(
    repairs.some(r => r.includes(callId) && r.includes('unknown')),
    `repairs 应记录待确认调用，实际：${JSON.stringify(repairs)}`,
  );
  assertProgressInvariant(projection);
});

// ──────────────────────────────── T7 ────────────────────────────────

test('T7 tool/call 已写、tool/result 未写时 SIGKILL：结算 unknown 且进入待确认', async (t) => {
  const fx = makeFixture(t);
  const point = await runScenarioToCrash(fx, 't7-call-without-result');
  const openCallId = needString(point.openCallId, 'openCallId');
  const openCallSeq = needNumber(point.openCallSeq, 'openCallSeq');
  const doneCallId = needString(point.doneCallId, 'doneCallId');
  const doneCallSeq = needNumber(point.doneCallSeq, 'doneCallSeq');
  const { projection, events, repairs } = await recoverAfterCrash(t, fx);

  assert.deepEqual(fx.types(), [
    'wake/manual', 'turn/start', 'input/claimed', 'step/start', 'message/assistant',
    'tool/call', 'tool/result', 'tool/call', 'turn/end', 'tool/zombie', 'tool/result', 'input/requeued',
  ]);

  // 未闭合的那条：结算 unknown 并进入待确认
  const openResults = toolResultsOf(events, openCallId);
  assert.equal(openResults.length, 1);
  assert.equal(openResults[0]!.data.status, 'unknown');
  assert.equal(openResults[0]!.data.callSeq, openCallSeq);
  assert.deepEqual(projection.needsReview.map(r => r.callId), [openCallId], '待确认列表里有且只有它');

  // 已闭合的那条：原样保留，绝不被二次结算（两阶段落库的配对判据是 callId + callSeq）
  const doneResults = toolResultsOf(events, doneCallId);
  assert.equal(doneResults.length, 1, '已闭合的调用不得被重新结算');
  assert.equal(doneResults[0]!.data.status, 'ok');
  assert.equal(doneResults[0]!.data.callSeq, doneCallSeq);
  assert.equal(zombieIds(events, doneCallId).length, 0, '已闭合的调用不是僵尸');

  assert.deepEqual(projection.openTools, []);
  assert.ok(
    repairs.some(r => r.includes(openCallId) && r.includes('unknown')),
    `repairs 应记录待确认调用，实际：${JSON.stringify(repairs)}`,
  );
  assertProgressInvariant(projection);
});

// ──────────────────────────────── T8 ────────────────────────────────

test('T8 turn 中途 SIGKILL：补写 turn/end{interrupted, spoke:false}，认领输入回队列', async (t) => {
  const fx = makeFixture(t);
  const point = await runScenarioToCrash(fx, 't8-turn-midway');
  const wakeSeq = needNumber(point.wakeSeq, 'wakeSeq');
  const turn = needNumber(point.turn, 'turn');
  const { projection, events, repairs } = await recoverAfterCrash(t, fx);

  assert.deepEqual(fx.types(), [
    'wake/manual', 'turn/start', 'input/claimed', 'step/start', 'turn/end', 'input/requeued',
  ]);

  const ended = turnEndOf(events);
  assert.equal(ended.data.turn, turn);
  assert.deepEqual(ended.data.reason, { kind: 'interrupted' });
  // 崩溃时无从得知模型是否已对外发言：未确认的发言不得声称发生过
  assert.equal(ended.data.spoke, false);

  const requeued = requeueOf(events);
  assert.deepEqual(requeued.data.wakeSeqs, [wakeSeq]);
  assert.deepEqual(requeued.data.claimCounts, [1], '认领计数 = 本次认领之后累计（原 0 + 1）');
  assert.deepEqual(requeued.data.sources, ['manual'], '来源从原 wake 事件还原');
  assert.equal(requeued.data.reason, 'turn-interrupted');
  // 磁盘时序：先关 turn 再退回输入。反过来的话，认领列表已被 turn/end 折叠清空，输入就丢了
  assert.ok(ended.seq < requeued.seq, 'turn/end 必须先于 input/requeued 落盘');

  assert.equal(projection.openTurn, null);
  assert.deepEqual(projection.claimedByTurn, {});
  assert.deepEqual(projection.pending.map(p => [p.wakeSeq, p.claimCount, p.source]), [[wakeSeq, 1, 'manual']]);
  assert.ok(repairs.some(r => r.includes('turn/end{interrupted}')));
  assert.ok(repairs.some(r => r.includes('退回输入')));
  assertProgressInvariant(projection);
});

// ──────────────────────────────── T9 ────────────────────────────────

test('T9 流式输出中途 SIGKILL：历史里保留已推送的部分，且只保留一次', async (t) => {
  const fx = makeFixture(t);
  const point = await runScenarioToCrash(fx, 't9-stream-midway');
  const pushedText = needString(point.pushedText, 'pushedText');
  const fullText = needString(point.fullText, 'fullText');
  const wakeSeq = needNumber(point.wakeSeq, 'wakeSeq');
  const { projection, events, repairs } = await recoverAfterCrash(t, fx);

  assert.deepEqual(fx.types(), [
    'wake/manual', 'turn/start', 'input/claimed', 'step/start', 'message/assistant',
    'turn/end', 'input/requeued',
  ]);

  const assistants = events.filter((e): e is AssistantMessage => e.type === 'message/assistant');
  assert.equal(assistants.length, 1, '被中断的流只应留下一条 assistant 记录');
  assert.equal(assistants[0]!.data.text, pushedText, '文本必须等于已推送的部分');
  assert.equal(assistants[0]!.data.interrupted, true);
  assert.deepEqual(assistants[0]!.data.toolCalls, [], '被截断的调用一律丢弃：拿半个参数执行有副作用的事才是灾难');

  // 留下来的是「推到哪儿算哪儿」的已推送部分，不是事后拼凑的全文
  assert.notEqual(pushedText, fullText);
  assert.ok(fullText.startsWith(pushedText));

  // 模型不会重复发言：历史里那段 assistant 内容要么恰好出现一次、要么（v74 起）根本不出现。
  //
  // **v74 的口径（改了这一条）**：中断那一步只写了 `message/assistant`、**没有** `message/reasoning`
  // （流在落思维链之前就被 SIGKILL 掐了）⇒ 它在服务端眼里是"assistant 条目在、reasoning_text 缺"
  // ——正是 2026-10-20 那场每轮 400 的形状。所以 v74 起**孤儿正文整条不发**（`render.ts` 的②），
  // 已推送的那半句不再进请求；事件日志里的那一条照旧留着（下面三行仍钉着它只出现一次、带中断标记）。
  const rendered = render({
    events,
    persona: { identity: 'IDENTITY', constitution: 'CONSTITUTION', style: 'STYLE', state: 'STATE' },
    tools: [],
    wakeEvent: null,
    taskCard: null,
    now: new Date().toISOString(),
    timezone: 'UTC',
    model: 'fixture-model',
    lane: 'heavy',
  });
  const assistantTexts = rendered.input
    .filter((item): item is Extract<InputItem, { type: 'message' }> => item.type === 'message' && item.role === 'assistant')
    .map(item => item.content);
  assert.deepEqual(assistantTexts, [], 'v74：没有配对 reasoning 的中断正文不再进请求（孤儿一律不发）');
  assert.deepEqual(
    rendered.reasoningEchoRepair.orphanAssistants.map(item => item.chars),
    [`${pushedText}\n[输出在此处被中断]`.length],
    '丢的账要写得出来（字数逐字对得上）',
  );
  assert.equal(
    rendered.input.filter(item => item.type === 'message' && item.content.includes(pushedText)).length, 0,
    '已推送部分要么一次、要么零次——绝不能出现两次（重复发言的根因就在这里）',
  );

  // 流没收尾就崩了：turn 同样必须结算，输入同样要退回
  assert.equal(projection.openTurn, null);
  assert.deepEqual(projection.pending.map(p => p.wakeSeq), [wakeSeq]);
  assert.ok(repairs.some(r => r.includes('interrupted')));
  assertProgressInvariant(projection);
});

// ──────────────────────────────── T10 ────────────────────────────────

test('T10 sideEffect=idempotent 执行中途 SIGKILL：允许自动重试且重试有记录', async (t) => {
  const fx = makeFixture(t);
  const point = await runScenarioToCrash(fx, 't10-idempotent-retry');
  const callId = needString(point.callId, 'callId');
  const callSeq = needNumber(point.callSeq, 'callSeq');
  const turn = needNumber(point.turn, 'turn');
  const { projection, events, repairs, log } = await recoverAfterCrash(t, fx);

  assert.deepEqual(fx.types(), [
    'wake/manual', 'turn/start', 'input/claimed', 'step/start', 'message/assistant',
    'tool/call', 'turn/end', 'tool/result', 'input/requeued',
  ]);

  // 2026-10-02 改（用户："两个兜底你去写一下吧"）：可重试调用**也要一条终态**——
  // 写 `tool/result{status:'error', code:'recovered-unfinished'}`（说实话："没跑完、结果未知"），
  // 于是它从 openTools 里摘掉、"那次调用没跑完"也第一次落进日志（以前只有渲染层现补占位）。
  const unfinished = toolResultsOf(events, callId);
  assert.equal(unfinished.length, 1, '可重试调用不会永远挂在开放集里');
  assert.equal(unfinished[0]!.data.status, 'error', '不许写成 ok：结果未知');
  assert.equal((unfinished[0]!.data.error as { code?: string } | undefined)?.code, 'recovered-unfinished');
  assert.deepEqual(zombieIds(events, callId), [], '仍然不写 tool/zombie：那是"死信"口径，清不掉开放项');
  assert.deepEqual(projection.needsReview, [], '可重试调用不需要人工确认');
  assert.deepEqual(projection.openTools, [], '已收尾，不再留一个没人认领的开放项');

  // 「重试有记录」= recover 的补偿清单里逐条写明（这次收尾的 note）
  const note = repairs.find(r => r.includes(callId));
  assert.ok(
    note !== undefined && note.includes('收尾'),
    `repairs 应记录这次收尾，实际：${JSON.stringify(repairs)}`,
  );
  assert.equal(note.includes('unknown'), false, '可重试调用不得被写成 unknown');

  // 想重做就再调一次：新调用是新 callId，这是一条普通的新 tool/call（与旧账无关）
  assert.equal(projection.openTools.length, 0, '旧的开放项已经闭合，不会有"幽灵待办"');
  assertProgressInvariant(projection);
});
