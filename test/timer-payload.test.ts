/**
 * `timer` 的 `payload` **三格约定**（2026-10-13，v55）——正反两面。
 *
 * 判据来源：用户的裁决「不需要拉 onebot，**把目前我考虑的东西做完就行**」+ `ALIGN.md` 的
 * 最小可用版本 ⇒ **一个新字段都不加**，`why` / `note` / `sid` 三格全部约进既有的 `payload`。
 * 落点两处（**同一批**）：`self-brief.ts` 的 `PAYLOAD_SHAPE_TEXT`（进 `instructions`）与
 * `admin.ts` 的 `timer.payload` 参数描述（进 `tools` 段）。
 *
 * 这一份钉**正面、反面与"不许动"**三件事，全部走真链路（真 EventLog + 真 TimerStore +
 * 真 TimerWakeSource + 真 RealLoop，只有模型通道是替身——测试台与 `test/timer-wait.test.ts` 同款）：
 *
 *   ① **正面**：`set` 带 `{why, note, sid}` ⇒ 回执与**投影**里三格都在，而且到点那一轮的请求里
 *      读到的正文是 `note`（`render.ts` 的 `[定时器触发] …` 只读这一格）；
 *   ② **反面**：不带这三格（字符串 / 别的对象 / 压根不给）⇒ **一切照旧**，
 *      **不许把缺格当错误**（旧形状仍可读，不新增校验、不新增参数）；
 *   ③ **不许动**：`wait` 的既有 `{kind, note, sid}` 语义一个字不变（含它的去重判据）。
 *
 * ⚠ 这一版**没有**做的一件事，写在这里免得被读成漏做：`set` 那条路**仍然不自动记 `sid`**
 * （`admin.ts` 的 `setTimerAction` 把 `args['payload']` 原样透传，没有 `replyTargetOf` 那一句）。
 * `sid` 是**提示词约定她自己去写**——timer 唤醒那一轮的 trust 是 `'self'`，`replyTargetOf`
 * 在那一轮本来就没有可回投的会话（`runtime/trust.ts`）。这是"不加字段"口径的直接结果。
 *
 * ④ 另加一条**去重锁**：`PAYLOAD_SHAPE_TEXT`（M）与 `SCHEDULING_TEXT`（K）之间
 *   **≥6 字极大公共子串 = 0 处**（用户 2026-10-13 的裁决："K 完整保留、①里重复的删掉"）。
 *   这一条锁的是"别把重复句又写回去"——它是用户点名要的机械检查，读数在
 *   `_research/_tmp-v55-verbatim.txt`。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { defaultVisibility, type AppEvent } from '../src/log/types.ts';
import { PAYLOAD_SHAPE_TEXT, SCHEDULING_TEXT } from '../src/model/self-brief.ts';
import { renderWake } from '../src/model/render.ts';
import { fold, applyOne } from '../src/state/fold.ts';
import { RealLoop } from '../src/runtime/real-loop.ts';
import { createAdminTools, TIMER_FRAMEWORK_CHORE_KINDS, TIMER_WAIT_PAYLOAD_KIND, isOwnerFacingTimer, timerWaitPayloadOf, type TimerStore as TimerStoreType } from '../src/tools/admin.ts';
import { MEMORY_MAINTAIN_PAYLOAD_KIND } from '../src/persona/memory-maintain.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { TimerWakeSource } from '../src/wake/sources.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';

const TZ = 'Asia/Shanghai';
const SID = 'qq:group:G1';
const START_MS = Date.parse('2026-10-13T15:00:00.000+08:00');

const PERSONA: PersonaAssets = {
  identity: 'IDENTITY',
  constitution: 'CONSTITUTION',
  style: 'STYLE',
  state: 'STATE',
  relationship: null,
  personaHash: 'test-hash',
  isSeed: false,
} as unknown as PersonaAssets;

// ──────────────────────────────── 虚拟时钟（与 timer-wait 那份同形） ────────────────────────────────

interface VirtualClock {
  now(): Date;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  advance(deadlineMs: number): number;
}

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

interface PayloadRig {
  clock: VirtualClock;
  timers: TimerStoreType;
  projection: ReturnType<typeof fold>;
  call: (action: string, extra?: Record<string, unknown>) => Promise<{ isError?: unknown; content: string }>;
  /** 时钟推进 N 毫秒（把定时器回调与微任务都放出来） */
  advanceMs: (ms: number) => Promise<void>;
  tick: () => Promise<void>;
  events: () => Promise<AppEvent[]>;
  /** 日志里**已经发生的** `wake/timer`：按发生顺序给出 (timerId, payload) */
  wakeTimers: () => Promise<Array<{ timerId: string; payload: unknown }>>;
  /** 她这一轮发给模型的请求（重放出来的一段文本） */
  requestText: () => string;
}

async function makeRig(t: TestContext): Promise<PayloadRig> {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-timer-payload-'));
  const log = await EventLog.open(join(dir, 'events'));
  const projection = fold([]);
  const clock = createVirtualClock(START_MS);
  const requests: unknown[] = [];
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
      origin: 'test/timer-payload',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    applyOne(projection, event);
  };
  // ⚠ **必须接事件槽**（与 `src/main.ts:934` 那一处同形）：`TimerStore` 自己不写日志
  // （`timer-store.ts` 的 `TimerStoreEventSink` 注释：两者是边界，"没接线就不写事件"）。
  // 不接的话 `timer/set` 一条都不落 ⇒ 投影里 `timers` 恒为空、`render` 的 payload 表也查不到
  // ——本文件第一版就踩在这个坑上（表里明明有那条，投影却是 `[]`）。
  // 回执发出去时日志里已经有它了，所以这里与动作同步写、同步折投影。
  timers.setEventSink({
    set: (entry) => { emit('timer/set', entry); },
    cancelled: (timerId) => { emit('timer/cancelled', { timerId }); },
  });
  const tk = createAdminTools({
    timers,
    emit: emit as never,
    // 有可回投的会话 ⇒ `wait` 那一格仍会写 `sid`（既有语义必须原样成立）
    replyTargetOf: () => ({ url: SID, idempotencyKey: 'turn-1' }),
  });
  const ctx = {
    callId: 'call_timer', turn: 1, step: 1,
    signal: new AbortController().signal, workspaceRoot: dir,
  };
  return {
    clock,
    timers,
    projection,
    call: async (action, extra = {}) => await tk.byName('timer').handler({ action, ...extra }, ctx) as
      { isError?: unknown; content: string },
    advanceMs: async (ms) => {
      clock.advance(clock.now().getTime() + ms);
      await flush();
    },
    tick: async () => { await loop.tickOnce(); },
    events: async () => {
      log.flush();
      const out: AppEvent[] = [];
      for await (const event of log.readAll()) out.push(event);
      return out;
    },
    wakeTimers: async () => {
      log.flush();
      const out: Array<{ timerId: string; payload: unknown }> = [];
      for await (const event of log.readAll()) {
        if (event.type !== 'wake/timer') continue;
        const data = event.data as { timerId: string; payload?: unknown };
        out.push({ timerId: data.timerId, payload: data.payload });
      }
      return out;
    },
    requestText: () => JSON.stringify(requests),
  };
}

// ──────────────────────────────── ① 正面：三格都在 ────────────────────────────────

test('① set 带 {why, note, sid} ⇒ 表里、投影里、回执里三格都在（一个新字段都没加）', async (t) => {
  const rig = await makeRig(t);
  const payload = { why: '他昨天说想让我盯一下这份合同', note: '提醒他合同今天到期', sid: SID };
  const at = new Date(START_MS + 3_600_000).toISOString();
  const out = await rig.call('set', { at, payload });
  assert.equal(out.isError, undefined, out.content);

  // 表里：**原样透传**（`set` 不把关、不规范化——三格是约定，不是 schema）
  const entry = rig.timers.list()[0]!;
  assert.deepEqual(entry.payload, payload, 'payload 原样进表（一个键都没被改写）');
  assert.equal(entry.at, at);

  // 投影里（GUI 与 list 读的就是它）——⚠ **必须在到点之前核**：这一条 `at` 型定时器一触发
  // 就从投影里出表了（`fold.ts` 的 `timer/fired` 那一支），下面为了读事件要推进时钟。
  assert.deepEqual(rig.projection.timers[0]?.payload, payload,
    `投影里三格都在（实际 ${JSON.stringify(rig.projection.timers)}）`);

  // ⚠ **事件的读法照仓里的既有次序**：`log.readAll()` 走的是**已落盘的分段**，
  // 刚 append 的那几条要等一拍（`tick()`）之后才读得回来——`test/timer-wait.test.ts` 里
  // 那两条读事件的用例都先 `tick()` 再 `events()`（本文件第一版没照它写，拿到 0 条）。
  await rig.advanceMs(61_000);
  await rig.tick();
  const found = await rig.events();
  const setEvent = found.find(e => e.type === 'timer/set');
  assert.ok(setEvent !== undefined,
    `有 timer/set 事件（实际拿到 ${found.length} 条：${found.map(e => e.type).join(',')}）`);
  assert.deepEqual(Object.keys(setEvent.data as object).sort(), ['at', 'payload', 'timerId'],
    '事件形状一个字没动（仍只有 at / payload / timerId 三格）');
  assert.deepEqual((setEvent.data as { payload?: unknown }).payload, payload, '三格原样进事件');

  // 回执：仍然给 id + 到期时刻 + 撤销出口（`set` 的回执语义这一版一个字没改）
  assert.match(out.content, new RegExp(`id=${entry.timerId}`), out.content);
  assert.match(out.content, /action=cancel/u, out.content);
});

test('①b 到点那一轮：请求正文里读到的是 note（render 只读这一格，why/sid 不占那一行）', async (t) => {
  const rig = await makeRig(t);
  const at = new Date(START_MS + 60_000).toISOString();
  const out = await rig.call('set', {
    at,
    payload: { why: '他提的要求（记在 why 里）', note: '提醒他去看那份合同', sid: SID },
  });
  assert.equal(out.isError, undefined, out.content);

  await rig.advanceMs(61_000);
  await rig.tick();

  const text = rig.requestText();
  assert.ok(text.includes('[定时器触发] 提醒他去看那份合同'),
    `到点那一行取的是 payload.note：\n${text}`);
  // 反面：why 与 sid **不进**那一行（它们是给"为什么/往哪说"用的，不是唤醒正文）
  assert.equal(text.includes('他提的要求（记在 why 里）'), false, 'why 不进 [定时器触发] 那一行');
  assert.equal(text.includes('qq:group:G1'), false, 'sid 不进 [定时器触发] 那一行');
});

// ──────────────────────────────── ② 反面：不带这三格，一切照旧 ────────────────────────────────

test('② 不带这三格 ⇒ 一切照旧：字符串 / 别的对象 / 不给 payload 三种旧形状都不报错', async (t) => {
  const rig = await makeRig(t);
  const at1 = new Date(START_MS + 60_000).toISOString();
  const at2 = new Date(START_MS + 120_000).toISOString();
  const at3 = new Date(START_MS + 180_000).toISOString();

  const legacy = await rig.call('set', { at: at1, payload: '老形状：一句话' });
  assert.equal(legacy.isError, undefined, `字符串 payload 不许被当成缺格报错：${legacy.content}`);

  const otherObject = await rig.call('set', { at: at2, payload: { kind: 'memory-maintain', by: 'human' } });
  assert.equal(otherObject.isError, undefined, `别的对象 payload 照旧：${otherObject.content}`);

  const noPayload = await rig.call('set', { at: at3 });
  assert.equal(noPayload.isError, undefined, `压根不给 payload 照旧：${noPayload.content}`);

  const list = rig.timers.list();
  assert.equal(list.length, 3, '三条都布防了（缺格不是错误、不拦）');
  assert.equal(list[0]?.payload, '老形状：一句话', '字符串原样');
  assert.deepEqual(list[1]?.payload, { kind: 'memory-maintain', by: 'human' }, '别的对象原样');
  assert.equal(list[2]?.payload, null, '不给就是 null（与表项一致，不留 undefined）');
  // 投影里三条也都在（GUI 与 list 读的就是它）——同样要在到点之前核
  assert.deepEqual(rig.projection.timers.map(e => e.payload),
    ['老形状：一句话', { kind: 'memory-maintain', by: 'human' }, null], '投影里三种旧形状都原样');

  // 到点：`renderWake` 只从**对象型** payload 里读 `note`（`typeof payload === 'object' && 'note' in payload`）
  // ⇒ 字符串型与"对象但没有 note"都回退成 timerId。这是**既有口径**（`render.test.ts` 的
  // 「payload 无 note / 非对象 / 已取消 → 回退 timerId」正面钉着），这一版一个字没改。
  //
  // ⚠ 两处**节奏**（这两个坑本文件第一版都踩过，如实记在注释里免得下一个人再踩）：
  //   ① `TimerStore` 会**错峰**（`staggerTarget`）：相邻补触发之间隔 `staggerMs`，第二条不会正好
  //      落在它名义上的 `at` 上 ⇒ 推进要留余量；
  //   ② 一拍（`tick()`）只处理**一条**待唤醒 ⇒ 三条要推进/跑三拍。
  const fired: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    await rig.advanceMs(70_000);
    await rig.tick();
    fired.push(...(await rig.wakeTimers()).slice(fired.length).map(w => w.timerId));
  }
  assert.deepEqual(fired, list.map(e => e.timerId),
    '三条到点都发了 `wake/timer`，顺序按到期先后（三种旧形状各自照旧）');
  assert.equal(rig.timers.list().length, 0, '三条都触发了（at 型触发即出表）');
  // payload：字符串 / 别的对象**原样跟着事件走**；不给的那条（`null`）在事件里是**缺格**
  // （`timer/set` 的 payload 为 null 时事件不带这一格——既有口径，不是这一版改的）。
  const wakes = await rig.wakeTimers();
  assert.deepEqual(wakes.map(w => w.payload ?? null),
    ['老形状：一句话', { kind: 'memory-maintain', by: 'human' }, null],
    'payload 原样跟着事件走（字符串 / 别的对象 / 缺格三种旧形状都还在）');
  // 正文那一半用**纯渲染**核（`renderWake` 是导出函数）：真链路那台子一拍只渲一条待唤醒，
  // 拿它逐条核正文会把"台子的节流"误读成"没回退"。这里直接问渲染层要那三行的正文——
  // 与 `test/render.test.ts`「payload 无 note / 非对象 / 已取消 → 回退 timerId」同一条口径。
  const wakeEvent = (timerId: string, at: string): AppEvent => ({
    seq: 0, ts: at, type: 'wake/timer',
    data: { timerId, scheduledAt: at, firedAt: at },
    visibility: 'model',
  } as unknown as AppEvent);
  for (const [timerId, payload] of [
    ['t-str', '老形状：一句话'], ['t-obj', { kind: 'memory-maintain', by: 'human' }], ['t-none', null],
  ] as Array<[string, unknown]>) {
    const line = renderWake(wakeEvent(timerId, '2026-10-13T07:00:00.000Z'), new Map([[timerId, payload]]));
    assert.equal(line, `[定时器触发] ${timerId}（计划时刻 2026-10-13T07:00:00.000Z）`,
      `没有 note 的旧形状一律回退 timerId（实际：${line}）`);
  }
  // 正对照：同一入口下，带 `note` 的**新约定**取的是 note——否则上面三条可能只是因为整条路都坏了
  const withNote = renderWake(wakeEvent('t-new', '2026-10-13T07:00:00.000Z'),
    new Map([['t-new', { why: '他要求排的', note: '提醒他合同到期', sid: SID }]]));
  assert.equal(withNote, '[定时器触发] 提醒他合同到期（计划时刻 2026-10-13T07:00:00.000Z）',
    '新约定的 note 才是正文（why/sid 不占那一行）');
});

test('②b 三格**各缺一格**也照旧：只给 note / 只给 why / 只给 sid 都不报错、都原样进表', async (t) => {
  const rig = await makeRig(t);
  for (const [index, payload] of [
    { note: '只有 note' },
    { why: '只有 why' },
    { sid: SID },
    {},
  ].entries()) {
    const at = new Date(START_MS + (index + 1) * 60_000).toISOString();
    const out = await rig.call('set', { at, payload });
    assert.equal(out.isError, undefined, `缺格不许报错（${JSON.stringify(payload)}）：${out.content}`);
  }
  assert.deepEqual(rig.timers.list().map(e => e.payload), [
    { note: '只有 note' }, { why: '只有 why' }, { sid: SID }, {},
  ], '四条的 payload 都原样进表（一个键都没补、没删）');
});

// ──────────────────────────────── ③ 不许动：wait 的既有语义 ────────────────────────────────

test('③ wait 的 {kind, note, sid} 语义一个字不变（含它的去重判据）', async (t) => {
  const rig = await makeRig(t);
  const out = await rig.call('wait', { minutes: 5, payload: '看看邮件回来没有' });
  assert.equal(out.isError, undefined, out.content);

  const entry = rig.timers.list()[0]!;
  assert.deepEqual(timerWaitPayloadOf(entry.payload), {
    kind: TIMER_WAIT_PAYLOAD_KIND, note: '看看邮件回来没有', sid: SID,
  }, 'wait 仍然写 kind / note / sid 三格（`set` 那三格与它**不是同一个形状**，也没有合并）');
  // 去重判据照旧：同会话 + 同理由不叠第二条
  const again = await rig.call('wait', { minutes: 10, payload: '看看邮件回来没有' });
  assert.match(again.content, /已经有一个到点唤醒了/u, again.content);
  assert.equal(rig.timers.list().length, 1, '去重仍然生效（这一版没碰它）');
  // 而 `set` 排的条目**不会**被 wait 的去重认成"同一条"（kind 不同 ⇒ timerWaitPayloadOf 返回 null）
  await rig.call('set', {
    at: new Date(START_MS + 3_600_000).toISOString(),
    payload: { note: '看看邮件回来没有', sid: SID },
  });
  assert.equal(timerWaitPayloadOf({ note: '看看邮件回来没有', sid: SID }), null,
    'set 的三格形状**不是** wait 那一档：它没有 kind，所以不会误进 wait 的去重');
  assert.equal(rig.timers.list().length, 2, 'wait 一条 + set 一条，两条并存（互不干扰）');
});

// ──────────────────────────────── ④ 去重锁（用户点名要的机械检查）────────────────────────────────

test('④ K ∩ ① 的重复句：≥6 字极大公共子串 = 0 处（去重不许被写回去）', () => {
  /** 两串之间所有**极大公共子串**（长度 ≥ min）——与 `_research/_tmp-v55-verbatim.mts` 同一实现 */
  const maximalCommonRuns = (a: string, b: string, min: number): string[] => {
    const found = new Set<string>();
    for (let i = 0; i < a.length; i += 1) {
      for (let j = 0; j < b.length; j += 1) {
        let len = 0;
        while (i + len < a.length && j + len < b.length && a[i + len] === b[j + len]) len += 1;
        if (len >= min) found.add(a.slice(i, i + len));
      }
    }
    const list = [...found].sort((x, y) => y.length - x.length);
    return list.filter(s => !list.some(t => t !== s && t.includes(s)));
  };
  const runs = maximalCommonRuns(SCHEDULING_TEXT, PAYLOAD_SHAPE_TEXT, 6);
  assert.deepEqual(runs, [], `K 与 ① 之间不许有 ≥6 字的重复句：${runs.map(r => `「${r}」`).join(' / ')}`);
  // 正对照：三格与三条纪律一个都没被去重删掉（否则"0 处"可以靠删空达到）
  for (const kept of ['why', 'note', 'sid', '发到哪儿', '取消旧的、排一条新的就行', 'facts', '单开一格']) {
    assert.ok(PAYLOAD_SHAPE_TEXT.includes(kept), `去重不许把这一处删掉：「${kept}」`);
  }
});

// ──────────────────── ⑤ 第五格 `scope`：哪一条算"给用户的"（v59，用户 2026-10-12）────────────────────

test('⑤ 判据（正反两面）：人建的/缺省 ⇒ 用户向；scope:self 与框架内务 ⇒ 不上日程页', () => {
  // ① `by:'human'` **最优先**：人自己建的，哪怕同时标了 scope:self 也算用户向
  //    （那张卡片是人写的"提醒我"，不该因为她顺手带了一格就消失）
  assert.equal(isOwnerFacingTimer({ by: 'human' }), true);
  assert.equal(isOwnerFacingTimer({ by: 'human', scope: 'self' }), true, 'by:human 优先于 scope');
  assert.equal(isOwnerFacingTimer({ by: 'human', kind: 'memory-maintain' }), true, 'by:human 优先于内务 kind');

  // ② 她自报的内部事
  assert.equal(isOwnerFacingTimer({ scope: 'self' }), false);
  assert.equal(isOwnerFacingTimer({ scope: 'self', title: '整理这周的复盘' }), false);

  // ③ 框架内务
  assert.equal(isOwnerFacingTimer({ kind: 'memory-maintain' }), false);

  // ④ 缺省 ⇒ **用户向**（默认可见比默认隐藏安全）——`wait` 那种"到点叫我"也走这一档
  assert.equal(isOwnerFacingTimer({ kind: 'wait', note: '提醒他合同今天到期' }), true,
    'wait 不在内务白名单里：它多半是替用户记的事');
  assert.equal(isOwnerFacingTimer({ title: '交材料', cat: 'work' }), true, '没写 scope ⇒ 用户向');
  assert.equal(isOwnerFacingTimer('老形状：一句话'), true, '旧形状（字符串 payload）⇒ 用户向');
  assert.equal(isOwnerFacingTimer(null), true);
  assert.equal(isOwnerFacingTimer(undefined), true);

  // 白名单与 persona 那一层的常量**必须同步**（`admin.ts` 不 import persona，靠这一条锁住）
  assert.ok(TIMER_FRAMEWORK_CHORE_KINDS.includes(MEMORY_MAINTAIN_PAYLOAD_KIND),
    '框架内务白名单里少了 memory-maintain：日程页的周历会开始画"每日记忆整理"');
});

test('⑤ list 的回执：用户向的在前并标出来，她自己的另列（参数一个没加）', async (t) => {
  const rig = await makeRig(t);
  const at = (minutes: number): string => new Date(START_MS + minutes * 60_000).toISOString();
  // 故意**先排她自己的**，再看回执是不是仍把用户向的放前面
  await rig.call('set', { at: at(180), payload: { scope: 'self', title: '自检一遍工具表' } });
  await rig.call('set', { at: at(60), payload: { title: '提醒他合同今天到期', cat: 'work' } });
  await rig.call('set', { at: at(120), payload: { kind: 'memory-maintain' } });

  const out = await rig.call('list');
  assert.equal(out.isError, undefined, out.content);
  const text = out.content;
  assert.match(text, /定时器 3 个（用户向 1 个在前，你自己的 2 个在后）/u, text);
  assert.match(text, /【给用户的】（日程页的周历会画它们）/u, text);
  assert.match(text, /【你自己的事】（不上日程页的周历）/u, text);
  // 次序：用户向那一段在"你自己的"那一段之前
  assert.ok(text.indexOf('【给用户的】') < text.indexOf('【你自己的事】'), text);
  // 每行自带标记 ⇒ 她扫一眼就知道周历会画哪几行
  const ownerBlock = text.slice(text.indexOf('【给用户的】'), text.indexOf('【你自己的事】'));
  assert.ok(!ownerBlock.includes('[你自己的·不上周历]'), ownerBlock);
  const mineBlock = text.slice(text.indexOf('【你自己的事】'));
  assert.equal((mineBlock.match(/\[你自己的·不上周历\]/gu) ?? []).length, 2, mineBlock);
  // 一条都不许丢：三条 id 都在
  for (const entry of rig.timers.list()) {
    assert.ok(text.includes(entry.timerId), `list 少了一行：${entry.timerId}\n${text}`);
  }
});

test('⑤ set 的回执自检：标题 · 时刻（周期）· 分类 · 是否上日程页（缺格照实说，不报错）', async (t) => {
  const rig = await makeRig(t);
  const at = new Date(START_MS + 3_600_000).toISOString();
  const filled = await rig.call('set', {
    at,
    payload: { title: '提醒他合同今天到期', cat: 'work', dur: 15, note: '合同今天到期' },
  });
  assert.equal(filled.isError, undefined, filled.content);
  assert.match(filled.content, /自检——标题：提醒他合同今天到期/u, filled.content);
  assert.match(filled.content, /分类：work/u, filled.content);
  assert.match(filled.content, /上日程页的周历（替用户记的那一类）/u, filled.content);
  assert.match(filled.content, /时刻：\S+（一次性）/u, filled.content);

  // 她自己那条：回执说清"不上日程页的周历"
  const mine = await rig.call('set', {
    cron: '0 4 * * *',
    payload: { scope: 'self', title: '每日记忆整理' },
  });
  assert.equal(mine.isError, undefined, mine.content);
  assert.match(mine.content, /不上日程页的周历（你自己的内部事）/u, mine.content);
  assert.match(mine.content, /（周期（0 4 \* \* \*））/u, mine.content);

  // 缺格（旧形状：连 payload 都没有）⇒ 缺省口径照实说，**不是错误**
  const bare = await rig.call('set', { at });
  assert.equal(bare.isError, undefined, bare.content);
  assert.match(bare.content, /标题：（没写，日程页用"到点做什么"的第一句）/u, bare.content);
  assert.match(bare.content, /分类：（没写，日程页不涂色）/u, bare.content);
  assert.match(bare.content, /上日程页的周历/u, bare.content);
});
