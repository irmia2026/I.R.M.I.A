/**
 * 进程重启的**留痕 + 真唤醒**（2026-10-11，「她说她没认出来进程在反复重启」）
 *
 * 用户原话（逐字）：
 *   「**她说她没认出来进程在反复重启**。**进程重启应当跟 compact 事件一样，有个通知让
 *     agent 知晓**」。
 *
 * 现场（同一天）：后端因为内存不足反复崩/重启（512 上限崩一次、2048 上限 167 秒崩一次、
 * 无上限涨到 3.8 GB），而她**完全没意识到**——她的上下文里没有任何"我刚被重启过"的痕迹，
 * 于是把断档读成"没人叫我"。对照面是压缩：`compaction/summary` 之后框架**真唤醒**她一次。
 *
 * 这份用例钉的就是那条"同一形状"，四条纪律各一组：
 *   ① **异常退出后启动 ⇒ 有通报**：`runtime/restart`（internal 留痕，每次都写）＋
 *      `wake/manual{via:'restart'}`（model，正文含"重启"与**上一任怎么没的**），
 *      且正文**逐字**进她当轮请求体（"落了事件"本身不算唤醒）；
 *   ② **正常重启 ⇒ 不喊**：上一任写下了 `session/end`、或者拉起器留痕说明它是被**故意**
 *      换掉的（`killed`）⇒ 只留痕、一条通报都不发；
 *   ③ **同一次启动只喊一次**：连打三拍也只有一条通报（去重判据见 `real-loop.ts` 的
 *      `startupRestartEvent`：日志里已经有 `runtime/restart` 就整段跳过）；
 *   ④ **老日志里没有这条事件 ⇒ 不许炸**：第一任（日志是空的）照旧起得来，留痕写"没有上一任
 *      的痕迹"，且**不喊她**；真实探测（不注入替身）在空目录上也不抛。
 *
 * 另外钉两处形状：可见性（表说 internal ＋ 真请求体里那串字节不在）与正文是一个纯函数
 * （同一份判定 ⇒ 同一串字节，重放/测试都引这一串字面量）。
 *
 * 走**真链路**：真 EventLog + 真 fold + 真 RealLoop + 真 warmUp + 真 runTurn，替身只有
 * 模型通道与"上一任的输出日志/拉起器留痕"这两处读盘（`restartProbe` 注入点）。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent, Projection } from '../src/log/types.ts';
import { defaultVisibility, emptyProjection } from '../src/log/types.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';
import {
  RealLoop, classifyRestartLauncher, heapCapOf, previousRunVerdict, restartFacts,
  restartProbeOf, startupRestartEvent,
} from '../src/runtime/real-loop.ts';import { applyOne } from '../src/state/fold.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { TimerStore } from '../src/wake/timer-store.ts';

const TZ = 'Asia/Shanghai';
const T0 = new Date('2026-10-11T12:00:00.000+08:00');
/** 上一任的 pid 与起始时刻（夹具里"已经是第二任"的凭据） */
const PREV_PID = 4242;

const PERSONA: PersonaAssets = {
  identity: 'IDENTITY',
  constitution: 'CONSTITUTION',
  style: 'STYLE',
  state: 'STATE',
  relationship: null,
  personaHash: 'test-hash',
  isSeed: false,
} as unknown as PersonaAssets;

/** 模型替身：heavy 把每一次请求**逐字记下来**（"她这一轮看到了什么"就看它） */
function fakeDs(requests: unknown[]): DsClient {
  return {
    modelFor: (): string => 'fake',
    generate: async (): Promise<unknown> => ({
      status: 'completed',
      outputItems: [{ type: 'message', id: 'm1', text: '{"picks":[]}' }],
      usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, reasoningTokens: 0 },
      incompleteReason: null,
      model: 'fake-light',
      responseId: 'resp_light',
    }),
    stream: async (request: unknown): Promise<unknown> => {
      requests.push(request);
      return {
        status: 'completed',
        text: '嗯。',
        reasoning: '',
        toolCalls: [],
        outputItems: [],
        usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, reasoningTokens: 0 },
        incompleteReason: null,
        model: 'fake-heavy',
        responseId: 'resp_heavy',
        durationMs: 3,
        interrupted: false,
        failure: null,
      };
    },
  } as unknown as DsClient;
}

/** 一次请求里**输入那一段的全部文本**（外层不套 JSON：Windows 路径的转义会造出假红） */
function textOfRequest(request: unknown): string {
  const input = (request as { input?: unknown }).input;
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  const parts: string[] = [];
  for (const item of input) {
    const content = (item as { content?: unknown }).content;
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
  }
  return parts.join('\n');
}

interface Rig {
  dataDir: string;
  projection: Projection;
  /** 她这一轮发给模型的请求（"看到了什么"的唯一判据） */
  requestText: () => string;
  tick: () => Promise<void>;
  events: () => Promise<AppEvent[]>;
  ofType: <T extends string>(type: T) => Promise<AppEvent[]>;
  seed: (type: string, data: unknown, visibility?: 'model' | 'internal') => AppEvent;
}

/**
 * 建一个真日志 + 真投影 + 真 RealLoop 的台子。
 *
 * `probe` 是"上一任的输出日志/拉起器留痕"那两处读盘的替身（真去造一份几 MB 的 node 输出
 * 日志不现实）；**不传就是真读盘**（`restartProbeOf`）——第 ④ 组用的就是那一档。
 */
async function makeRig(
  t: TestContext,
  opts: {
    /** 起 RealLoop 之前先塞进日志的事件（"上一任"的痕迹都在这里） */
    seedBefore?: (seed: (type: string, data: unknown, visibility?: 'model' | 'internal') => AppEvent) => void;
    probe?: {
      oomEvidence: string | null;
      killEvidence: string | null;
      traceText: string;
      traceUsable: boolean;
    };
    /** 不传 ⇒ 用真探测（读盘那一半） */
    useRealProbe?: boolean;
  } = {},
): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-restart-announce-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const log = await EventLog.open(join(dataDir, 'events'));
  const projection = emptyProjection();
  const requests: unknown[] = [];
  // 关掉记忆托管：这一份用例要的是"启动那一段"，不该顺带布防每日整理（少碰一样盘）
  const config = defaultConfig(dir);
  config.persona = { ...config.persona, memoryEnabled: false };

  const seed = (type: string, data: unknown, visibility: 'model' | 'internal' = 'internal'): AppEvent => {
    const event = {
      seq: log.nextSeq(),
      ts: T0.toISOString(),
      type,
      data,
      visibility,
      origin: 'test',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    applyOne(projection, event);
    return event;
  };
  opts.seedBefore?.(seed);
  // `main.ts` 在装配循环**之前**就会写下本任的 `session/start`（`runMain` 的第②步）。
  // 夹具必须照做：判据取的是"**倒数第二条** `session/start`"——少了这一条，日志里只有上一任，
  // 判据就会读成"这是第一任"（而这正是这次要修的那个盲点：她看不出自己被换过一次）。
  seed('session/start', {
    pid: process.pid, cwd: dir, version: '0.1.0-beta.6', schemaVersion: '1', configHash: 'now',
  });

  const loop = new RealLoop({
    log,
    dataDir,
    projection,
    now: () => T0,
    timezone: TZ,
    ds: fakeDs(requests),
    registry: new ToolRegistry(),
    persona: PERSONA,
    config,
    out: () => {},
    pollMs: 3_600_000,
    timers: new TimerStore(join(dataDir, 'timers.json'), { now: () => T0 }),
    // `runtime/restart` 的通报里要说"你现在跑的是哪一版"（与 session/start.version 同源）
    version: '0.1.0-beta.6',
    ...(opts.useRealProbe === true
      ? {}
      : { restartProbe: () => opts.probe ?? { oomEvidence: null, killEvidence: null, traceText: '', traceUsable: false } }),
  });
  t.after(async () => {
    loop.stop();
    log.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发的句柄占用：清理失败不影响断言结论 */
    }
  });

  const events = async (): Promise<AppEvent[]> => {
    log.flush();
    const out: AppEvent[] = [];
    for await (const event of log.readAll()) out.push(event);
    return out;
  };

  return {
    dataDir,
    projection,
    requestText: () => requests.map(textOfRequest).join('\n'),
    tick: async () => { await loop.tickOnce(); },
    events,
    ofType: async <T extends string>(type: T): Promise<AppEvent[]> =>
      (await events()).filter((event) => event.type === type),
    seed,
  };
}

const restartLogs = (events: AppEvent[]): Array<AppEvent & { type: 'runtime/restart' }> =>
  events.filter((event): event is AppEvent & { type: 'runtime/restart' } => event.type === 'runtime/restart');

const restartWakes = (events: AppEvent[]): Array<AppEvent & { type: 'wake/manual' }> =>
  events.filter((event): event is AppEvent & { type: 'wake/manual' } =>
    event.type === 'wake/manual' && (event.data as { via?: string }).via === 'restart');

/** "上一任"的痕迹：一条 `session/start`（pid = PREV_PID） */
const seedPreviousSession = (seed: Rig['seed']): void => {
  seed('session/start', {
    pid: PREV_PID, cwd: '/tmp/prev', version: '0.1.0-beta.5', schemaVersion: '1', configHash: 'prev',
  });
};

// ════════════════ ① 异常退出后启动 ⇒ 有通报、正文含"重启"与原因 ════════════════

test('异常退出（OOM 崩的）⇒ 留痕 + 真唤醒，正文含"重启"与内存不足这个原因，且逐字进当轮请求', async (t) => {
  const oomLine = 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory';
  const rig = await makeRig(t, {
    seedBefore: seedPreviousSession,
    probe: {
      oomEvidence: `D:/irmia/agent-console.out.log：${oomLine}`,
      killEvidence: null,
      traceText: '',
      traceUsable: false,
    },
  });

  // 前提：还没起拍时不许已经有留痕（否则下面测不出"启动那一段"）
  assert.equal(restartLogs(await rig.events()).length, 0);

  await rig.tick(); // 第一拍：warmUp ⇒ 留痕 + 通报（同一拍被认领 ⇒ 真起 turn）

  const events = await rig.events();
  const logged = restartLogs(events)[0];
  assert.ok(logged !== undefined, `每一次启动都要留一条 runtime/restart：${events.map(e => e.type).join(',')}`);
  const wake = restartWakes(events)[0];
  assert.ok(wake !== undefined,
    `异常退出之后必须叫醒她一次（wake/manual · via=restart）：${events.map(e => e.type).join(',')}`);

  // ① 留痕的形状与判据结论（"电子证据"逐格核对）
  assert.equal(logged.data.previous.death, 'oom', '内存不足是硬件级事实，判据优先级最高');
  assert.equal(logged.data.previous.abnormal, true, 'OOM ⇒ 异常退出');
  assert.equal(logged.data.previous.pid, PREV_PID, '上一任的 pid 从 session/start 取');
  assert.equal(logged.data.previous.version, '0.1.0-beta.5', '上一任的版本号照实记');
  assert.equal(logged.data.previous.endedAt, null, '它没能写下 session/end（这份"缺失"就是判据的输入）');
  assert.ok(logged.data.previous.evidence.includes('heap out of memory'), 'OOM 的引擎原话要留在证据里');
  assert.equal(logged.data.wake, true, '叫过了 ⇒ 留痕这一格是 true');
  assert.equal(logged.data.version, '0.1.0-beta.6', '本任的版本号（通报里那句"你现在跑的是…"同源）');
  assert.equal(logged.data.pid, process.pid, 'pid 是本进程的（她"现在跑在哪一任上"的凭据）');
  assert.equal(logged.visibility, 'internal', '留痕不进她的上下文（给她的是下面那条通报）');

  // ② 通报的形状：model、via=restart、不带人（框架通报不是用户打的话）
  assert.equal(wake.visibility, 'model', '通报要进她的上下文');
  assert.equal((wake.data as { via?: string }).via, 'restart');
  assert.equal((wake.data as { person?: string }).person, undefined,
    '用户没开口 ⇒ 不带人（带了会把关系档案注进这一轮）');
  assert.equal((wake.data as { dedupeKey?: string }).dedupeKey, `runtime-restart#${logged.seq}`,
    '幂等键挂在留痕的 seq 上：同一任只可能算出同一个键');
  assert.ok(logged.seq < wake.seq, `先留痕、后通报（restart=${logged.seq} wake=${wake.seq}）`);

  // ③ 正文逐字进**当轮**请求体（分行验：漏一段就红）
  const note = (wake.data as { note: string }).note;
  const sent = rig.requestText();
  for (const line of note.split('\n')) {
    assert.ok(sent.includes(line), `这一行必须逐字进她的请求：\n${line}\n---请求尾部---\n${sent.slice(-1200)}`);
  }
  assert.ok(sent.includes('**我刚被重启过**'), '段头那句"我刚被重启过"要在（她一眼看出这不是用户说的话）');
  assert.ok(sent.includes('进程重启'), '正文里要有"重启"这两个字');
  assert.ok(sent.includes('内存不足'), '原因要在正文里（"上一任是因为内存不足崩掉的"）');
  assert.ok(sent.includes('0.1.0-beta.6'), '要说清现在跑的是哪一版');
  assert.ok(sent.includes('接着做'), '要说"没做完的接着做"');
  // 用户点名要的那一句：重启不影响记忆
  assert.ok(sent.includes('重启不影响你的记忆与记忆里的结论'),
    '用户原话里那一句「重启不影响你的记忆与记忆里的结论」必须在');
  // 那次唤醒真的被认领、真的起了一个 turn（"落了事件"本身不是唤醒）
  assert.ok((await rig.ofType('input/claimed')).length >= 1, '那条通报被当轮认领掉（不留在队列里反复叫）');
});

test('异常退出（没能留下停机记录）⇒ 同样要喊，且如实说"说不清具体原因"', async (t) => {
  const rig = await makeRig(t, { seedBefore: seedPreviousSession });

  await rig.tick();
  const events = await rig.events();
  const logged = restartLogs(events)[0]!;
  assert.equal(logged.data.previous.death, 'unknown');
  assert.equal(logged.data.previous.abnormal, true,
    '上一任没能写下 session/end ⇒ 算异常退出（宁可多叫一次，也不许她再把断档读成"没人叫我"）');
  const wake = restartWakes(events)[0];
  assert.ok(wake !== undefined, '这一档也要喊');
  const note = (wake.data as { note: string }).note;
  assert.ok(note.includes('没能留下停机记录'), `正文要如实说清这一档的原因：\n${note}`);
  assert.ok(note.includes('硬杀'), '不编原因：把"可能是什么"如实列出来');
});

test('上一任自己报的异常退出（session/end{reason:error}）⇒ 也喊', async (t) => {
  const rig = await makeRig(t, {
    seedBefore: (seed) => {
      seedPreviousSession(seed);
      seed('session/end', { reason: 'error', detail: '写入时崩了' });
    },
  });
  await rig.tick();
  const events = await rig.events();
  const logged = restartLogs(events)[0]!;
  assert.equal(logged.data.previous.death, 'error');
  assert.equal(logged.data.previous.abnormal, true);
  assert.equal(logged.data.previous.endedReason, 'error', '它自己那条停机记录要照实记下来');
  assert.ok(logged.data.previous.endedAt !== null, '停机时刻也要记（"什么时候没的"）');
  assert.ok(restartWakes(events)[0] !== undefined, '它自己报了异常 ⇒ 叫醒她');
});

// ════════════════ ② 正常重启 ⇒ 不喊（只留痕） ════════════════

test('正常重启（上一任干净停机 session/end{shutdown}）⇒ 只留痕、一条通报都不发', async (t) => {
  const rig = await makeRig(t, {
    seedBefore: (seed) => {
      seedPreviousSession(seed);
      seed('session/end', { reason: 'shutdown' });
    },
  });
  await rig.tick();
  const events = await rig.events();
  const logged = restartLogs(events)[0];
  assert.ok(logged !== undefined, '正常重启**也要留痕**（"这一任什么时候起的"是所有复盘的第一格）');
  assert.equal(logged.data.previous.abnormal, false, '干净停机 ⇒ 不算异常');
  assert.equal(logged.data.wake, false, '没喊 ⇒ 留痕这一格是 false（判据与动作分得开）');
  assert.equal(restartWakes(events).length, 0, '正常重启一个字都不发（她本来就知道）');
  assert.equal((await rig.ofType('turn/start')).length, 0, '连 turn 都不该起（没有唤醒）');
});

test('正常重启（拉起器故意换人、旧实例没走完优雅退出）⇒ killed，也不喊', async (t) => {
  const rig = await makeRig(t, {
    seedBefore: seedPreviousSession,
    probe: {
      oomEvidence: null,
      killEvidence: '拉起器留痕里出现了「停主进程」：旧实例是被**故意**停掉的',
      traceText: '[重启] 停主进程 PID 4242\n',
      traceUsable: true,
    },
  });
  await rig.tick();
  const events = await rig.events();
  const logged = restartLogs(events)[0]!;
  assert.equal(logged.data.previous.death, 'killed', '被故意换掉 ⇒ killed（不是崩溃）');
  assert.equal(logged.data.previous.abnormal, false);
  assert.equal(restartWakes(events).length, 0, '人按下按钮时她本来就知道 ⇒ 不喊');
});

// ════════════════ ③ 同一次启动只喊一次 ════════════════

test('同一次启动只喊一次：连打三拍也只有一条通报（去重判据是"日志里已有留痕"）', async (t) => {
  const rig = await makeRig(t, {
    seedBefore: seedPreviousSession,
    probe: {
      oomEvidence: 'D:/x.log：FATAL ERROR: Reached heap allocation failed - JavaScript heap out of memory',
      killEvidence: null,
      traceText: '',
      traceUsable: false,
    },
  });
  await rig.tick();
  await rig.tick();
  await rig.tick();
  const events = await rig.events();
  assert.equal(restartLogs(events).length, 1, '留痕也只该有一条（每次都写 = 每一任一条，不是每一拍一条）');
  assert.equal(restartWakes(events).length, 1, '同一次启动只喊一次');
  // 去重判据本身：留痕在 ⇒ 整段跳过（`announceRestart` 的第一行）
  assert.ok(startupRestartEvent(events) !== null);
});

// ════════════════ ④ 老日志/第一任 ⇒ 不许炸 ════════════════

test('第一任（日志是空的）：不喊她，但留痕照写，并如实说"没有上一任的痕迹"', async (t) => {
  const rig = await makeRig(t); // 一条事件都不塞
  await rig.tick();
  const events = await rig.events();
  const logged = restartLogs(events)[0];
  assert.ok(logged !== undefined, '第一任也要留痕');
  assert.equal(logged.data.previous.pid, null, '没有上一任 ⇒ pid 如实为 null（不编）');
  assert.equal(logged.data.previous.abnormal, false, '第一任没有"断档"可言 ⇒ 不吵她');
  assert.equal(logged.data.previous.death, 'unknown', '判不出就是 unknown');
  assert.ok(logged.data.previous.evidence.includes('没有上一任'), `证据要说清为什么：${logged.data.previous.evidence}`);
  assert.equal(restartWakes(events).length, 0, '第一任不喊');
});

test('回溯友好：没有留痕、没有 session/start、没有任何痕迹的老目录 ⇒ 真探测不抛、照旧起得来', async (t) => {
  // 这一档**不注入探测替身**：走真的 `restartProbeOf`（读盘那一半），目录里一个文件都没有
  const rig = await makeRig(t, { useRealProbe: true });
  await rig.tick();
  const events = await rig.events();
  const logged = restartLogs(events)[0];
  assert.ok(logged !== undefined, '盘上什么都没有也照样起得来、照样留痕');
  assert.equal(logged.data.launchedBy, 'unknown', '没有痕迹 ⇒ 如实说不知道是谁拉起的（不许猜）');
  assert.equal(logged.data.previous.death, 'unknown');
  assert.equal(restartWakes(events).length, 0, '第一任不喊');
});

// ════════════════ 契约（形状、可见性、纯函数） ════════════════

test('契约：runtime/restart 是 internal、wake/manual 是 model，且留痕那串字节不进请求', async (t) => {
  const rig = await makeRig(t, {
    seedBefore: seedPreviousSession,
    probe: {
      oomEvidence: 'D:/x.log：FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      killEvidence: null, traceText: '', traceUsable: false,
    },
  });
  await rig.tick();
  assert.equal(defaultVisibility('runtime/restart'), 'internal',
    '写入点走 defaultVisibility，所以表里这一格就是契约');
  const sent = rig.requestText();
  assert.equal(sent.includes('runtime/restart'), false, '事件类型名不该出现在请求里');
  assert.equal(sent.includes('launchedEvidence'), false, '判据的字段名同样不该出现');
  // 正对照：同一次请求里那条通报**必须在**（否则上面两条不算证据）
  assert.ok(sent.includes('【框架通报 · 进程重启】'), '同一次请求里通报要在');
});

test('判据是纯函数：同一份判定给同一串字节（重放与测试引同一串字面量）', () => {
  // 两任的痕迹：上一任（pid 4242）＋本任 —— 判据取的是**倒数第二条** `session/start`
  const events = [sessionStart(1, PREV_PID), sessionStart(2, process.pid)];
  const oom = 'D:/x.log：JavaScript heap out of memory';
  const previous = previousRunVerdict({
    events,
    oomEvidence: oom,
    killEvidence: null,
    previousPid: null,
  });
  assert.equal(previous.pid, PREV_PID, '上一任 = 倒数第二条 session/start');
  assert.equal(previous.death, 'oom');
  const facts = (): ReturnType<typeof restartFacts> => restartFacts({
    events, argv: ['node', 'dist/main.js'], env: {}, now: T0,
    pid: 999, version: '0.1.0-beta.6', oomEvidence: oom,
    killEvidence: null, traceText: '', traceUsable: false, heapLimitBytes: 1024 * 1024 * 1024,
  });
  const first = facts();
  const second = facts();
  assert.equal(first.note, second.note, '同一份输入 ⇒ 同一串字节（纯函数）');
  assert.ok(first.note !== null && first.note.includes(T0.toISOString()),
    '正文里带上重启时刻（她才不用再翻事件）');
  assert.equal(first.heapCap.enabled, false, '命令行没带 --max-old-space-size ⇒ 如实写"未启用"');
});

test('上限读得回来：带了 --max-old-space-size 就写上限是多少', () => {
  const gib = 1024 * 1024 * 1024;
  assert.deepEqual(heapCapOf(['node', '--max-old-space-size=1024', 'dist/main.js'], gib),
    { enabled: true, limitMb: 1024 }, 'V8 报多少就写多少（1024 MB）');
  assert.deepEqual(heapCapOf(['node', 'dist/main.js'], gib), { enabled: false, limitMb: null },
    '没带参数 ⇒ enabled:false（"没有上限"与"上限读不出"是两件事）');
  // 带了参数但 V8 报的数不可用 ⇒ limitMb 如实留 null，**不编一个数**
  assert.deepEqual(heapCapOf(['node', '--max-old-space-size=512', 'x.js'], Number.NaN),
    { enabled: true, limitMb: null });
});

test('谁拉起的：拉起器留痕优先，其次 argv，再其次环境变量，都没有就是 unknown', () => {
  const base = { env: {} as Record<string, string | undefined> };
  assert.equal(classifyRestartLauncher({
    ...base, argv: ['node', 'dist/main.js'],
    traceText: '完整命令行（D:\\Tools\\pwsh7\\pwsh.dll -NoProfile -File tools\\restart-agent.ps1）',
    traceUsable: true,
  }).launchedBy, 'root-script');
  assert.equal(classifyRestartLauncher({
    ...base, argv: ['node', 'dist/main.js'],
    traceText: '完整命令行（pwsh -File restart.ps1）', traceUsable: true,
  }).launchedBy, 'packaged-script');
  assert.equal(classifyRestartLauncher({
    ...base, argv: ['node', 'dist/runtime/restart-worker.js', '--old-pid', '1'],
    traceText: '', traceUsable: false,
  }).launchedBy, 'self-restart', 'argv 里带着拉起器的参数');
  assert.equal(classifyRestartLauncher({
    ...base, argv: ['node', 'dist/main.js'],
    traceText: '[重启][发起] 路径=self-restart · 由服务端发起 pid=1', traceUsable: true,
  }).launchedBy, 'ui', '服务端发起的那一行 `[发起]`');
  assert.equal(classifyRestartLauncher({
    argv: ['node', 'dist/main.js'], traceText: '', traceUsable: false,
    env: { IRMIA_LAUNCHED_BY: 'external' },
  }).launchedBy, 'external', '外部看护显式声明');
  assert.equal(classifyRestartLauncher({
    ...base, argv: ['node', 'dist/main.js'], traceText: '', traceUsable: false,
  }).launchedBy, 'unknown', '没有任何痕迹 ⇒ 如实说不知道');
  // 留痕里那次重启**不是**把我拉起来的那次（mtime 太旧）⇒ 整条不看
  assert.equal(classifyRestartLauncher({
    ...base, argv: ['node', 'dist/main.js'],
    traceText: '完整命令行（pwsh -File tools\\restart-agent.ps1）', traceUsable: false,
  }).launchedBy, 'unknown');
});

test('真探测不炸：目录里什么都没有时给"没有这条证据"（而不是抛）', () => {
  const empty = mkdtempSync(join(tmpdir(), 'irmia-restart-probe-'));
  try {
    const probe = restartProbeOf(empty, new Date());
    assert.equal(probe.oomEvidence, null);
    assert.equal(probe.killEvidence, null);
    assert.equal(probe.traceText, '');
    assert.equal(probe.traceUsable, false);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('真探测认得留痕里的输出落点与致命原话（这一条走真文件）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-restart-probe2-'));
  try {
    const outLog = join(dir, 'agent-console.out.log');
    // 留痕里那句"完整命令行"逐字带着输出落点（`>> "<路径>" 2>&1`）——真实现就是这么找它的
    writeFileSync(join(dir, 'restart-trace.log'),
      `2026-10-11 12:00:00 [重启] 停主进程 PID 4242\r\n`
      + `2026-10-11 12:00:01 [重启] 拉起读数：cmd.exe /s /c "node "x.js" >> "${outLog}" 2>&1"\r\n`, 'utf8');
    writeFileSync(outLog,
      '一堆正常输出\n<--- Last few GCs --->\n'
      + 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n'
      + '----- Native stack trace -----\n', 'utf8');
    // 「留痕里那次重启就是我这次启动吗」按**文件 mtime 距离现在多久**判 ⇒ 这里必须用真时钟
    // （夹具里那个固定的 T0 是给"纯函数"那几条用的，拿它当"现在"会让新鲜度判据必然判假）
    const probe = restartProbeOf(dir, new Date());
    assert.equal(probe.traceUsable, true, '留痕刚写过 ⇒ 这一次可用');
    assert.ok(probe.oomEvidence !== null && probe.oomEvidence.includes('heap out of memory'),
      `要认出致命原话：${String(probe.oomEvidence)}`);
    assert.ok(probe.killEvidence !== null && probe.killEvidence.includes('停主进程'),
      `要认出"故意换人"那句话：${String(probe.killEvidence)}`);
    // 优先级：OOM 胜过 killing 痕迹（正在 OOM 的进程就算同时留下别的痕迹，也是被内存搞死的）
    const verdict = previousRunVerdict({
      events: [sessionStart(1, PREV_PID), sessionStart(2, process.pid)],
      oomEvidence: probe.oomEvidence,
      killEvidence: probe.killEvidence, previousPid: null,
    });
    assert.equal(verdict.death, 'oom');
    assert.equal(verdict.abnormal, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 夹具用的 `session/start`（信封的 ts 与 data 都要对，判据读的是两处） */
function sessionStart(seq: number, pid: number): AppEvent {
  return {
    seq,
    ts: T0.toISOString(),
    type: 'session/start',
    data: { pid, cwd: '/tmp/prev', version: '0.1.0-beta.5', schemaVersion: '1', configHash: 'prev' },
    visibility: 'internal',
    origin: 'test',
  } as unknown as AppEvent;
}
