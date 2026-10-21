/**
 * M2 崩溃注入场景脚本（test/crash-injection.test.ts 的子进程夹具）
 *
 * 为什么必须是真子进程：崩溃恢复的正确性只能由「进程真的死了、盘上真的只剩这些字节」来证明。
 * 在同一个进程里用 try/finally 或 mock 出来的"杀进程"路径，证明不了任何事。
 *
 * 本脚本用真模块（runtime/recover + log/EventLog）按场景把「崩溃前已经落库的事件」写盘，
 * 到达崩溃点后写下哨兵文件（crash-point.json）并挂住事件循环，等测试进程用 SIGKILL 终结它。
 * 哨兵是两侧唯一的常量交汇点：测试只断言哨兵里写明的值，避免夹具与断言各写一份而悄悄漂移。
 *
 * 不经模型、不用 DsClient：这里测的是持久化与恢复，不是模型行为。工具执行与流式输出都用
 * 「事件已落库 / 尚未落库」这一刻的磁盘事实来代表。
 *
 * 用法：
 *   node --experimental-strip-types test/fixtures/crash-scenario.ts \
 *     --data-dir <dir> --scenario <t6-tool-exec|...> --sentinel <file>
 */

import { writeFileSync } from 'node:fs';

import type { EventLog } from '../../src/log/event-log.ts';
import type { AppEvent, AppEventType, Projection } from '../../src/log/types.ts';
import { defaultVisibility } from '../../src/log/types.ts';
import { RENDER_VERSION } from '../../src/model/render.ts';
import { recover } from '../../src/runtime/recover.ts';
import { applyOne } from '../../src/state/fold.ts';

// ──────────────────────────────── 场景参数 ────────────────────────────────

/** 固定 turn 号：断言侧从哨兵取值，不硬编码 */
const TURN = 9;
const STEP = 1;

/** T9 的流式素材：第 3 段到达时流被中断，落库的「已推送部分」= 前三段拼接 */
const STREAM_DELTAS = ['你', '好，', '我在', '听', '你说'] as const;
const PUSH_AT_DELTA = 3;

// ──────────────────────────────── 写入器 ────────────────────────────────

/**
 * 承诺类写入：seq → append(fsync) → 折进投影，与运行期（agent-loop / loop 的 write）同一纪律。
 * 崩溃注入的前提是「落库就是事实」，所以这里一律 sync: true。
 */
class ScenarioWriter {
  private readonly log: EventLog;
  private readonly projection: Projection;

  constructor(log: EventLog, projection: Projection) {
    this.log = log;
    this.projection = projection;
  }

  write(type: AppEventType, data: unknown): AppEvent {
    const event = {
      seq: this.log.nextSeq(),
      ts: new Date().toISOString(),
      type,
      data,
      visibility: defaultVisibility(type),
      origin: 'test/fixtures/crash-scenario',
    } as unknown as AppEvent;
    this.log.append(event, { sync: true });
    applyOne(this.projection, event);
    return event;
  }
}

/** 一次唤醒 → 开 turn → 认领输入 → 进 step：所有场景共用的前段 */
function openTurn(w: ScenarioWriter, turn: number): { wakeSeq: number } {
  const wake = w.write('wake/manual', { note: '崩溃注入：唤醒输入', dedupeKey: `crash-inject-${turn}` });
  w.write('turn/start', { turn });
  w.write('input/claimed', { turn, wakeSeqs: [wake.seq], claimCounts: [0] });
  w.write('step/start', {
    turn,
    step: STEP,
    model: 'fixture-model',
    lane: 'heavy',
    renderVersion: RENDER_VERSION,
    personaHash: 'fixture-persona',
  });
  return { wakeSeq: wake.seq };
}

/**
 * 崩溃点：写哨兵 → 挂住事件循环等 SIGKILL。
 * 真实进程此刻正 await 工具或流，没有任何机会再写补偿事件——这正是本组测试要考的场景。
 */
async function crashHere(sentinelPath: string, payload: Record<string, unknown>): Promise<never> {
  writeFileSync(sentinelPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  // 保活：定时器不 unref + 顶层 await 永不 settle，进程只能被外部杀掉
  setInterval(() => { /* 保活 */ }, 1_000);
  return await new Promise<never>(() => { /* 永不 settle */ });
}

// ──────────────────────────────── 场景 ────────────────────────────────

/** T6：有副作用的工具执行中途被杀 —— 它到底发出去了没有，谁也说不清 */
async function t6ToolExec(w: ScenarioWriter, sentinel: string): Promise<never> {
  const { wakeSeq } = openTurn(w, TURN);
  const call = { callId: 'c-http', name: 'http_post', arguments: '{"url":"http://example.invalid/hook","body":"ping"}' };
  w.write('message/assistant', { text: null, toolCalls: [call] });
  const callSeq = w.write('tool/call', {
    turn: TURN, step: STEP, callId: call.callId, name: call.name,
    arguments: call.arguments, sideEffect: 'destructive',
  }).seq;
  return await crashHere(sentinel, {
    scenario: 't6-tool-exec', turn: TURN, wakeSeq,
    callId: call.callId, callSeq, sideEffect: 'destructive',
  });
}

/** T7：tool/call 已写、tool/result 未写 —— 精确停在两阶段落库的中间 */
async function t7CallWithoutResult(w: ScenarioWriter, sentinel: string): Promise<never> {
  const { wakeSeq } = openTurn(w, TURN);
  const done = { callId: 'c-done', name: 'read_file', arguments: '{"path":"notes.md"}' };
  const open = { callId: 'c-open', name: 'http_post', arguments: '{"url":"http://example.invalid/hook"}' };
  w.write('message/assistant', { text: null, toolCalls: [done, open] });

  // 第一条：两阶段都完成，闭合
  const doneSeq = w.write('tool/call', {
    turn: TURN, step: STEP, callId: done.callId, name: done.name,
    arguments: done.arguments, sideEffect: 'none',
  }).seq;
  w.write('tool/result', {
    turn: TURN, step: STEP, callId: done.callId, callSeq: doneSeq,
    status: 'ok', content: '文件内容', durationMs: 3,
  });

  // 第二条：只有 tool/call，对不上 result
  const openSeq = w.write('tool/call', {
    turn: TURN, step: STEP, callId: open.callId, name: open.name,
    arguments: open.arguments, sideEffect: 'destructive',
  }).seq;
  return await crashHere(sentinel, {
    scenario: 't7-call-without-result', turn: TURN, wakeSeq,
    doneCallId: done.callId, doneCallSeq: doneSeq,
    openCallId: open.callId, openCallSeq: openSeq, sideEffect: 'destructive',
  });
}

/** T8：turn 中途被杀 —— 输入已认领、turn 还开着 */
async function t8TurnMidway(w: ScenarioWriter, sentinel: string): Promise<never> {
  const { wakeSeq } = openTurn(w, TURN);
  return await crashHere(sentinel, { scenario: 't8-turn-midway', turn: TURN, wakeSeq });
}

/** T9：流式输出中途被杀 —— 中断时把「已推送部分」按承诺类落库，随后进程死在收尾之前 */
async function t9StreamMidway(w: ScenarioWriter, sentinel: string): Promise<never> {
  const { wakeSeq } = openTurn(w, TURN);
  let pushed = '';
  for (let i = 0; i < PUSH_AT_DELTA; i++) pushed += STREAM_DELTAS[i]!;
  // schema §3：interrupted 的语义就是「已经推送给用户的那部分」。落库了才允许继续推理，
  // 否则模型下一步会以为自己什么都没说，重复发言。
  w.write('message/assistant', { text: pushed, toolCalls: [], interrupted: true });
  return await crashHere(sentinel, {
    scenario: 't9-stream-midway', turn: TURN, wakeSeq,
    pushedText: pushed,
    // 被杀时本该说完的全文：刻意不等于 pushedText，用来证明留下的是「已推送部分」而非事后拼凑
    fullText: STREAM_DELTAS.join(''),
    deltasSeen: PUSH_AT_DELTA,
  });
}

/** T10：幂等工具执行中途被杀 —— 重跑它不会让世界更糟，恢复流程应放行重试 */
async function t10IdempotentRetry(w: ScenarioWriter, sentinel: string): Promise<never> {
  const { wakeSeq } = openTurn(w, TURN);
  const call = { callId: 'c-idem', name: 'http_get', arguments: '{"url":"http://example.invalid/status"}' };
  w.write('message/assistant', { text: null, toolCalls: [call] });
  const callSeq = w.write('tool/call', {
    turn: TURN, step: STEP, callId: call.callId, name: call.name,
    arguments: call.arguments, sideEffect: 'idempotent',
  }).seq;
  return await crashHere(sentinel, {
    scenario: 't10-idempotent-retry', turn: TURN, wakeSeq,
    callId: call.callId, callSeq, sideEffect: 'idempotent',
  });
}

// ──────────────────────────────── 入口 ────────────────────────────────

interface FixtureArgs {
  dataDir: string;
  scenario: string;
  sentinel: string;
}

function parseArgs(argv: readonly string[]): FixtureArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`参数 ${token} 缺少取值`);
    values.set(token.slice(2), value);
    i += 1;
  }
  const dataDir = values.get('data-dir');
  const scenario = values.get('scenario');
  const sentinel = values.get('sentinel');
  if (dataDir === undefined || scenario === undefined || sentinel === undefined) {
    throw new Error('缺少必填参数：--data-dir / --scenario / --sentinel');
  }
  return { dataDir, scenario, sentinel };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // 与真实入口同一顺序：先走恢复七步拿到锁与投影，再干活
  const rec = await recover({
    dataDir: args.dataDir,
    log: (level, message, extra) => {
      if (level === 'debug') return;
      process.stderr.write(`[fixture] ${level}: ${message} ${extra === undefined ? '' : JSON.stringify(extra)}\n`);
    },
  });
  const writer = new ScenarioWriter(rec.log, rec.projection);

  switch (args.scenario) {
    case 't6-tool-exec': await t6ToolExec(writer, args.sentinel); return;
    case 't7-call-without-result': await t7CallWithoutResult(writer, args.sentinel); return;
    case 't8-turn-midway': await t8TurnMidway(writer, args.sentinel); return;
    case 't9-stream-midway': await t9StreamMidway(writer, args.sentinel); return;
    case 't10-idempotent-retry': await t10IdempotentRetry(writer, args.sentinel); return;
    default: throw new Error(`未知场景：${args.scenario}`);
  }
}

await main();
