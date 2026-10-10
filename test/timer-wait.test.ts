/**
 * `timer action=wait`（2026-10-08 用户的口径：「timer 提供一个 wait」）
 * ——src/tools/admin.ts 的新动作、src/wake/timer-store.ts 的那个时钟口
 *
 * 语义按用户的原话落定：**她调 `timer wait <时长>` ⇒ 框架在同一拍里安排一次"到点唤醒"
 * 并让她这一拍收尾，到点后正常唤醒她**；**不是**让模型在原地阻塞等待（那会白烧步数与 token，
 * 而"反复 read_channel"正是那样烧出来的）。所以这一份钉四件事：
 *   ① **排下一次唤醒**：表里真的多了一条，到期时刻 = 排的那一刻 + 时长（按**调度器的时钟**算）；
 *   ② **不阻塞当前拍**：工具当场返回、虚拟时钟一格没走、`wake/timer` 一条都还没有；
 *   ③ **到点走既有的那条路**：`TimerWakeSource` → `timer/fired` + `wake/timer` → 真 `RealLoop`
 *      起一个 turn，她这一轮的请求里**真的能看到那句理由**（复用既有唤醒机制，没有第二套）；
 *   ④ **同一会话 + 同一理由不重复布防**（如实提示"已经有一个到点唤醒了"）、**超上限报参数错**。
 *
 * 走**真链路**：真 EventLog + 真 TimerStore（虚拟时钟）+ 真 TimerWakeSource + 真 RealLoop，
 * 替身只有模型通道那一个。判据的落点全是"日志里/表里到底发生了什么"，不是"回执说了什么"。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { defaultVisibility, type AppEvent } from '../src/log/types.ts';
import { fold, applyOne } from '../src/state/fold.ts';
import { RealLoop } from '../src/runtime/real-loop.ts';
import {
  createAdminTools,
  TIMER_WAIT_MAX_MINUTES,
  TIMER_WAIT_PAYLOAD_KIND,
  timerWaitPayloadOf,
  type TimerStore as TimerStoreType,
} from '../src/tools/admin.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { TimerWakeSource } from '../src/wake/sources.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { TOOL_ERROR_CODES, type ToolHandlerResult } from '../src/tools/types.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';

const TZ = 'Asia/Shanghai';
const SID = 'qq:group:G1';
const START_MS = Date.parse('2026-10-08T15:00:00.000+08:00');

const PERSONA: PersonaAssets = {
  identity: 'IDENTITY',
  constitution: 'CONSTITUTION',
  style: 'STYLE',
  state: 'STATE',
  relationship: null,
  personaHash: 'test-hash',
  isSeed: false,
} as unknown as PersonaAssets;

// ──────────────────────────────── 虚拟时钟（与 timer-store 那份同形） ────────────────────────────────

interface VirtualClock {
  now(): Date;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** 推进到某个绝对时刻，按到期先后依次回调；返回实际派发数 */
  advance(deadlineMs: number): number;
}

/**
 * 确定性虚拟时钟。**串行驱动**（回调里可能又排新的定时器）——分段布防（>24.8 天）也会
 * 按真实剩余时间顺延，与 `test/timer-store.test.ts` 里那份口径一致。
 */
function createVirtualClock(startMs: number): VirtualClock {
  interface Task { at: number; seq: number; handler: () => void }
  let currentMs = startMs;
  let seq = 0;
  const tasks = new Map<number, Task>();
  const runUntil = (deadlineMs: number): number => {
    let fired = 0;
    for (;;) {
      let pick: Task | null = null;
      for (const task of tasks.values()) {
        if (task.at > deadlineMs) continue;
        if (pick === null || task.at < pick.at || (task.at === pick.at && task.seq < pick.seq)) pick = task;
      }
      if (pick === null) break;
      tasks.delete(pick.seq);
      if (pick.at > currentMs) currentMs = pick.at;
      fired += 1;
      pick.handler();
    }
    if (deadlineMs > currentMs) currentMs = deadlineMs;
    return fired;
  };
  return {
    now: () => new Date(currentMs),
    setTimeout: (handler, ms) => {
      const id = ++seq;
      tasks.set(id, { at: currentMs + ms, seq: id, handler });
      return id;
    },
    clearTimeout: (handle) => {
      if (typeof handle === 'number') tasks.delete(handle);
    },
    advance: (deadlineMs) => runUntil(deadlineMs),
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ──────────────────────────────── 测试台 ────────────────────────────────

/** 模型替身：heavy 记下每一次请求（断言"她这一轮看到了什么"），light 回一个空 JSON */
function fakeDs(requests: unknown[]): DsClient {
  return {
    modelFor: (): string => 'fake',
    generate: async (): Promise<unknown> => ({
      status: 'completed',
      outputItems: [{ type: 'message', id: 'm1', text: '{}' }],
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

interface WaitRig {
  clock: VirtualClock;
  timers: TimerStoreType;
  log: EventLog;
  /** 她这一拍所在的那个会话（不传 = 本机那一拍，没有可回投的会话） */
  wait: (args: Record<string, unknown>) => Promise<ToolHandlerResult>;
  call: (action: string, extra?: Record<string, unknown>) => Promise<ToolHandlerResult>;
  /** 时钟推进 N 毫秒（把定时器回调与微任务都放出来） */
  advanceMs: (ms: number) => Promise<void>;
  /** 跑一拍（生产定时器回调与这里调的是同一个方法） */
  tick: () => Promise<void>;
  /** `pending` 里那几条唤醒的类型（"它是待办的活"的判据） */
  pendingTypes: () => Promise<string[]>;
  events: () => Promise<AppEvent[]>;
  types: () => Promise<string[]>;
  /** 她这一轮发给模型的请求（重放出来的一段文本） */
  requestText: () => string;
  dispose: () => void;
}

/** 真链路测试台：真日志 + 真定时器表（虚拟时钟）+ 真唤醒源 + 真 RealLoop */
async function makeRig(t: TestContext, options: { session?: string | null } = {}): Promise<WaitRig> {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-timer-wait-'));
  const log = await EventLog.open(join(dir, 'events'));
  const projection = fold([]);
  const clock = createVirtualClock(START_MS);
  const requests: unknown[] = [];
  const session = options.session === undefined ? SID : options.session;
  const timers = new TimerStore(join(dir, 'timers.json'), {
    now: clock.now,
    setTimeout: (handler, ms) => clock.setTimeout(handler, ms),
    clearTimeout: (handle) => clock.clearTimeout(handle),
  });
  const loop = new RealLoop({
    log,
    dataDir: dir,
    projection,
    now: clock.now,
    timezone: TZ,
    ds: fakeDs(requests),
    registry: new ToolRegistry(),
    persona: PERSONA,
    config: defaultConfig(dir),
    out: () => {},
    pollMs: 3_600_000,
    timers,
  });
  // 唤醒源按**生产那一条路**接：TimerWakeSource 到期 → `timer/fired` + `wake/timer`
  // （sink 就是真 RealLoop，它自己实现 WakeSink），没有第二套唤醒机制。
  const source = new TimerWakeSource(timers, loop, clock.now);
  source.start();
  t.after(() => {
    source.stop();
    loop.stop();
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const emit = (type: string, data: unknown): void => {
    const event = {
      seq: log.nextSeq(),
      ts: clock.now().toISOString(),
      type,
      data,
      visibility: defaultVisibility(type),
      origin: 'test/timer-wait',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    applyOne(projection, event);
  };
  const tk = createAdminTools({
    timers,
    emit: emit as never,
    ...(session === null ? {} : { replyTargetOf: () => ({ url: session, idempotencyKey: 'turn-1' }) }),
  });
  const ctx = {
    callId: 'call_timer', turn: 1, step: 1,
    signal: new AbortController().signal, workspaceRoot: dir,
  };
  const wait = async (args: Record<string, unknown>) => await tk.byName('timer').handler(
    { action: 'wait', ...args },
    ctx,
  );
  return {
    clock,
    timers,
    log,
    wait,
    call: async (action, extra = {}) => await tk.byName('timer').handler({ action, ...extra }, ctx),
    advanceMs: async (ms) => {
      clock.advance(clock.now().getTime() + ms);
      await flush();
    },
    tick: async () => { await loop.tickOnce(); },
    pendingTypes: async () => {
      const out: string[] = [];
      for (const item of projection.pending) {
        const event = log.get(item.wakeSeq);
        if (event !== null) out.push(event.type);
      }
      return out;
    },
    events: async () => {
      log.flush();
      const out: AppEvent[] = [];
      for await (const event of log.readAll()) out.push(event);
      return out;
    },
    types: async () => {
      log.flush();
      const out: string[] = [];
      for await (const event of log.readAll()) out.push(event.type);
      return out;
    },
    requestText: () => JSON.stringify(requests),
    dispose: () => { source.stop(); loop.stop(); log.close(); },
  };
}

// ──────────────────────────────── ① 排下一次唤醒 ────────────────────────────────

test('wait：表里真的多了一条，到期时刻 = 现在 + 时长（按调度器的时钟算）', async (t) => {
  const rig = await makeRig(t);
  const out = await rig.wait({ minutes: 5, payload: '看看邮件回来没有' });
  assert.equal(out.isError, undefined, out.content);

  const entries = rig.timers.list();
  assert.equal(entries.length, 1, '排一次就一条');
  const entry = entries[0]!;
  assert.equal(entry.at, new Date(START_MS + 5 * 60_000).toISOString(),
    '到期时刻是"现在 + 5 分钟"（用排定时器的那个时钟算，不是另找一份"现在"）');
  assert.deepEqual(timerWaitPayloadOf(entry.payload), {
    kind: TIMER_WAIT_PAYLOAD_KIND, note: '看看邮件回来没有', sid: SID,
  }, 'payload 带 kind（判重复）、note（到点给她看的那句话）、sid（哪个会话排的）');

  // 回执：id、时长、到期时刻、理由、以及"这一拍不用等"那条语义
  assert.match(out.content, new RegExp(`id=${entry.timerId}`), out.content);
  assert.match(out.content, /5 分钟之后/, out.content);
  assert.match(out.content, new RegExp(entry.at.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')), out.content);
  assert.match(out.content, /到点你会看到：\[定时器触发\] 看看邮件回来没有/u, out.content);
  assert.match(out.content, /这一拍不用等/u, `语义必须写在回执里：${out.content}`);
  assert.match(out.content, /action=cancel/u, '撤销的路要给她');
  // 与既有 timer 语义一致：同一件工具的 list 看得到它
  const list = await rig.call('list');
  assert.match(list.content, new RegExp(entry.timerId), list.content);
});

test('wait：**不阻塞当前拍** —— 工具当场返回，时钟一格没走、唤醒一条还没到', async (t) => {
  const rig = await makeRig(t);
  const before = rig.clock.now().getTime();
  const out = await rig.wait({ seconds: 30 });
  assert.equal(out.isError, undefined, out.content);
  assert.equal(rig.clock.now().getTime(), before,
    '时刻原地不动：它只是"排了一次唤醒"，没有谁在这里等那 30 秒');
  assert.equal(rig.timers.armedCount() >= 1, true, '在途 handle 已经布好（同一拍里就安排完了）');
  assert.equal((await rig.types()).includes('wake/timer'), false, '还没到点 ⇒ 一条唤醒都不该产生');
  // 同一拍里继续干别的事：list 立刻就能看见它
  const list = await rig.call('list');
  assert.match(list.content, /wait/u, `排完就能查到（同一拍里已经落表）：${list.content}`);
});

// ──────────────────────────────── ② 到点：走既有的那条唤醒路 ────────────────────────────────

test('到点：timer/fired + wake/timer 落进真日志，真 RealLoop 起一个 turn，理由就在她的请求里', async (t) => {
  const rig = await makeRig(t);
  const out = await rig.wait({ minutes: 5, payload: '看看邮件回来没有' });
  assert.equal(out.isError, undefined, out.content);
  const entry = rig.timers.list()[0]!;

  // 没到点：什么都不会发生
  await rig.advanceMs(4 * 60_000);
  await rig.tick();
  assert.equal((await rig.types()).includes('wake/timer'), false, '差一分钟也不许提前叫醒她');

  // 到点：唤醒源（生产那一个实现）结算
  await rig.advanceMs(60_000 + 1_000);
  const events = await rig.events();
  const fired = events.find((event) => event.type === 'timer/fired');
  const wake = events.find((event) => event.type === 'wake/timer');
  assert.ok(fired !== undefined, '定时器到期要记一笔（internal）');
  assert.ok(wake !== undefined, '唤醒事件是模型可见的那一条');
  assert.equal((wake as AppEvent & { type: 'wake/timer' }).data.timerId, entry.timerId);
  assert.equal((wake as AppEvent & { type: 'wake/timer' }).data.scheduledAt, entry.at,
    '计划时刻 = 排定时算出来的那个 at（"早了/晚了多久"据此可算）');
  assert.equal(
    ((wake as AppEvent & { type: 'wake/timer' }).data.payload as { note?: string }).note,
    '看看邮件回来没有',
    '理由跟着事件走（at 型条目一触发就从表里删了，payload 必须随事件带过来）',
  );
  assert.ok(fired!.seq < wake!.seq, '日志顺序即因果顺序：先记到期，再唤醒');

  // **反向用例**（2026-10-08 用户的判据："落了事件"不许冒充"真唤醒"）：
  // 到点这一刻事件刚进日志、还没跑拍 —— 不许已经有 turn；而它是 `pending` 里的**待办的活**。
  assert.equal((await rig.pendingTypes()).includes('wake/timer'), true,
    '唤醒要进待办队列（它是"该起一轮"的活，不是一条躺着的通知）');
  assert.equal((await rig.types()).includes('turn/start'), false,
    '还没跑拍 ⇒ 不许已经有 turn（否则下面那条"真的起了 turn"就没有证明力）');

  // 再跑一拍：真 RealLoop 认领这条唤醒 → 真 turn → 她的请求里出现那句话
  await rig.tick();
  const types = await rig.types();
  assert.equal(types.includes('turn/start'), true, '到点后照常起一个 turn（与外部事件/心跳同一条路）');
  const text = rig.requestText();
  assert.ok(text.includes('看看邮件回来没有'),
    `到点那一轮她必须看见自己写下的理由：\n${text.slice(0, 800)}`);
  assert.ok(text.includes('定时器触发') || text.includes('wake/timer'),
    '渲染走既有的 wake/timer 那一行（不另造一套唤醒文案）');
  // `at` 型条目触发即出表（既有语义，wait 不例外）。**只断言这一条**：真 RealLoop 自己
  // 还会布防框架的条目（每日记忆整理那条 cron），那不是这一条用例的事。
  assert.equal(rig.timers.get(entry.timerId), null, '一次性条目触发后从表里移除');
});

// ──────────────────────────────── ③ 重复 wait：如实提示，不叠第二条 ────────────────────────────────

test('同一会话 + 同一理由重复 wait：如实说"已经有一个到点唤醒了"，不叠第二条', async (t) => {
  const rig = await makeRig(t);
  const first = await rig.wait({ minutes: 10, payload: '看构建结果' });
  assert.equal(first.isError, undefined, first.content);
  const entry = rig.timers.list()[0]!;

  const again = await rig.wait({ minutes: 10, payload: '看构建结果' });
  assert.equal(again.isError, undefined, again.content);
  assert.match(again.content, /已经有一个到点唤醒了/u, `要如实说，别默默再排一条：${again.content}`);
  assert.match(again.content, new RegExp(`id=${entry.timerId}`), '要给已有的那条 id');
  assert.match(again.content, new RegExp(entry.at.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')), '要说清它什么时候到点');
  assert.match(again.content, /action=cancel/u, '要给她"改时间"的路（撤掉再排）');
  assert.equal(rig.timers.list().length, 1, '**不新增**：到点被连叫 N 次，每一次都是一整轮 turn');

  // 换个理由 ⇒ 那是另一件事，照排（判据是"同一会话 + 同一理由"，不是"同一会话一律只许一条"）
  const other = await rig.wait({ minutes: 10, payload: '看另一个人回了没有' });
  assert.equal(other.isError, undefined, other.content);
  assert.equal(rig.timers.list().length, 2, '理由不同 ⇒ 是另一件要等的事');
});

// ──────────────────────────────── ④ 上限与参数错 ────────────────────────────────

test('超上限报参数错并指路：分钟与秒两条路都拦，且一个字都不布防', async (t) => {
  const rig = await makeRig(t);
  const tooFar = await rig.wait({ minutes: TIMER_WAIT_MAX_MINUTES + 1 });
  assert.equal(tooFar.isError, true, tooFar.content);
  assert.equal(tooFar.error?.code, TOOL_ERROR_CODES.invalidArgs);
  assert.match(tooFar.content, /超过上限/u, tooFar.content);
  assert.match(tooFar.content, /12 小时/u, '上限要写成她读得懂的量（小时）');
  assert.match(tooFar.content, /action=set/u, '要给出去路：更远的唤醒用 set 的 at/cron');
  assert.match(tooFar.content, /本次没有布防/u, '不许静默夹到上限（她以为排的是自己说的那个时长）');

  const tooFarSeconds = await rig.wait({ seconds: TIMER_WAIT_MAX_MINUTES * 60 + 1 });
  assert.equal(tooFarSeconds.isError, true, tooFarSeconds.content);
  assert.match(tooFarSeconds.content, /超过上限/u);
  assert.equal(rig.timers.list().length, 0, '两次都被拒 ⇒ 表里一条都没有');

  // 正好在上限上：照排（边界是精确的）
  const edge = await rig.wait({ minutes: TIMER_WAIT_MAX_MINUTES });
  assert.equal(edge.isError, undefined, edge.content);
  assert.equal(rig.timers.list().length, 1);
});

test('参数错：时长缺失 / 两个单位同时给 / 非正整数 —— 都当场拒绝并说清怎么改', async (t) => {
  const rig = await makeRig(t);
  const missing = await rig.wait({ payload: '到点看看' });
  assert.equal(missing.isError, true, missing.content);
  assert.match(missing.content, /seconds 或 minutes/u, missing.content);

  const both = await rig.wait({ seconds: 30, minutes: 1 });
  assert.equal(both.isError, true, both.content);
  assert.match(both.content, /二选一/u, both.content);

  const zero = await rig.wait({ seconds: 0 });
  assert.equal(zero.isError, true, zero.content);
  assert.match(zero.content, /正整数/u, zero.content);

  const notNumber = await rig.wait({ minutes: '5' });
  assert.equal(notNumber.isError, true, `时长只认数字（不猜字符串）：${notNumber.content}`);
  assert.equal(rig.timers.list().length, 0, '四次都没有布防');

  // 理由的形状也要当场判：静默丢掉它比报错坏得多（她到点会看到一行没有理由的 [定时器触发]）
  const badReason = await rig.wait({ minutes: 5, payload: { 想看: '邮件' } });
  assert.equal(badReason.isError, true, badReason.content);
  assert.match(badReason.content, /payload/u, badReason.content);
  assert.equal(rig.timers.list().length, 0);
});

test('本机那一拍（没有可回投会话）照样能 wait：sid 记 null，去重按"同一理由"判', async (t) => {
  const rig = await makeRig(t, { session: null });
  const out = await rig.wait({ minutes: 3, payload: '回头看那件事' });
  assert.equal(out.isError, undefined, out.content);
  const entry = rig.timers.list()[0]!;
  assert.deepEqual(timerWaitPayloadOf(entry.payload), {
    kind: TIMER_WAIT_PAYLOAD_KIND, note: '回头看那件事', sid: null,
  }, '没有会话坐标就记 null（不编一个假 sid）');

  const again = await rig.wait({ minutes: 3, payload: '回头看那件事' });
  assert.match(again.content, /已经有一个到点唤醒了/u, again.content);
  assert.match(again.content, /同一个理由/u, `没有会话时那句话要说得准（不许说"同一个会话"）：${again.content}`);
  assert.equal(rig.timers.list().length, 1);
});
