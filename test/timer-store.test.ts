/**
 * TimerStore 测试 — src/wake/timer-store.ts
 *
 * 覆盖 docs/design.md §4.3 的四要点、§4.22 的 cron 周期语义、以及
 * review.md 缺陷 4 要求的「以日志为准重建」。
 * 全部用虚拟时钟 + 临时目录，不产生真实等待，不碰仓库里的任何文件。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as fsp from 'node:fs/promises';

import { EventLog } from '../src/log/event-log.ts';
import {
  emptyProjection,
  resolveEventVisibility,
  type AppEvent,
  type Visibility,
} from '../src/log/types.ts';
import { applyOne, finalizePressure, fold } from '../src/state/fold.ts';
import {
  MAX_TIMEOUT_MS,
  TimerStore,
  nextCronTime,
  parseCron,
  timerEntriesFromEvents,
  type TimerEntry,
  type TimerSnapshot,
  type TimerStoreDeps,
  type TimerStoreEventSink,
  type StoredTimerEntry,
} from '../src/wake/timer-store.ts';
import { tempDir } from './helpers/temp-dirs.ts';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const CATCHUP_STAGGER_MS = 5_000;

// ──────────────────────────────── 测试脚手架 ────────────────────────────────

interface VirtualClock {
  now(): Date;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /**
   * 按到期先后依次回调，直到下一次到期时刻越过 deadline；返回本次实际派发数。
   * 语义与真实事件循环一致：每个回调都在它自己的到期时刻执行，期间新排的
   * 定时器按真实剩余时间顺延。
   */
  advance(deadlineMs: number): number;
  /** 最近一次布防的延迟，用于验证分段长度 */
  lastDelayMs: number;
  /** 在途定时器数 */
  pendingCount(): number;
  /** 下一次到期的绝对时刻，没有在途定时器时返回 null */
  nextDeadlineMs(): number | null;
}

/**
 * 确定性虚拟时钟：按真实事件循环的语义推进时间。
 * 用 deadline 表达「推进到某个时刻」或「推进 N 毫秒」，不需要任何快进特例——
 * 离线场景由「没人调用 advance」自然表达。
 */
function createVirtualClock(startMs: number): VirtualClock {
  interface Task { at: number; seq: number; handler: () => void }
  let currentMs = startMs;
  let seq = 0;
  const tasks = new Map<number, Task>();
  let lastDelayMs = 0;

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
    get lastDelayMs() {
      return lastDelayMs;
    },
    now: () => new Date(currentMs),
    setTimeout: (handler, ms) => {
      lastDelayMs = ms;
      const id = ++seq;
      tasks.set(id, { at: currentMs + ms, seq: id, handler });
      return id;
    },
    clearTimeout: (handle) => {
      if (typeof handle === 'number') tasks.delete(handle);
    },
    advance: (deadlineMs) => runUntil(deadlineMs),
    pendingCount: () => tasks.size,
    nextDeadlineMs: () => {
      let min: number | null = null;
      for (const task of tasks.values()) {
        if (min === null || task.at < min) min = task.at;
      }
      return min;
    },
  };
}

/** 把虚拟时钟推进 N 毫秒（同时把微任务队列清空） */
async function advanceMs(clock: VirtualClock, ms: number): Promise<number> {
  const fired = clock.advance(clock.now().getTime() + ms);
  await flushMicrotasks();
  return fired;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * 测试用依赖集合：调度与时钟走虚拟时钟，读盘/落盘走真实文件系统。
 * 注意现在的时间与调度必须同源，否则虚拟时间推进不会驱动定时器。
 */
function virtualStoreDepsForTest(clock: VirtualClock, extra: Partial<TimerStoreDeps> = {}): Partial<TimerStoreDeps> {
  return {
    now: () => clock.now(),
    setTimeout: (handler, ms) => clock.setTimeout(handler, ms),
    clearTimeout: (handle) => clock.clearTimeout(handle),
    readFile: async (path: string) => readFile(path, 'utf8'),
    writeFile: async (path: string, data: string) => {
      await writeFile(path, data, 'utf8');
    },
    ...extra,
  };
}

interface Harness {
  store: TimerStore;
  clock: VirtualClock;
  file: string;
  dir: string;
  fired: Array<{ id: string; at: number; entry: StoredTimerEntry }>;
  startMs: number;
}

async function makeHarness(startMs: number, storeDeps: Partial<TimerStoreDeps> = {}): Promise<Harness> {
  const dir = await tempDir('irmia-timer-');
  const file = join(dir, 'timers.json');
  const clock = createVirtualClock(startMs);
  const deps: Partial<TimerStoreDeps> = {
    ...virtualStoreDepsForTest(clock),
    ...storeDeps,
  };
  const store = new TimerStore(file, deps);
  await store.load();
  const fired: Array<{ id: string; at: number; entry: StoredTimerEntry }> = [];
  store.start((entry) => {
    fired.push({ id: entry.timerId, at: clock.now().getTime(), entry });
  });
  return { store, clock, file, dir, fired, startMs };
}

async function cleanup(h: Harness): Promise<void> {
  h.store.stop();
  // 触发路径的落盘是异步的：先等写链落定，再删目录，避免删完又被写回
  await h.store.flush();
  await removeTree(h.dir);
}

async function readSnapshot(file: string): Promise<TimerSnapshot> {
  return JSON.parse(await readFile(file, 'utf8')) as TimerSnapshot;
}

/**
 * 手工按 cron 语义逐分钟前推，作为 nextCronTime 的独立参照。
 * 只用于期望落在窗口内的表达式（周级别以内），月级别用语义断言。
 */
function bruteForceNext(cron: string, afterMs: number, limit = 20_000): number | null {
  const parsed = parseCron(cron);
  assert.equal(parsed.ok, true, `测试参照用的 cron 应当合法：${cron}`);
  if (!parsed.ok) return null;
  const set = parsed.cron;
  const monthIndex = (m: number) => m + 1;
  const baseMs = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS;
  for (let i = 1; i <= limit; i++) {
    const d = new Date(baseMs + i * MINUTE_MS);
    if (set.minute[d.getMinutes()] !== true) continue;
    if (set.hour[d.getHours()] !== true) continue;
    if (set.month[monthIndex(d.getMonth())] !== true) continue;
    const domHit = set.dom[d.getDate()] === true;
    const dowHit = set.dow[d.getDay()] === true;
    const hit = !set.domAll && !set.dowAll
      ? domHit || dowHit
      : (set.domAll || domHit) && (set.dowAll || dowHit);
    if (hit) return d.getTime();
  }
  return null;
}

/** 断言某个时刻之前没有任何匹配分钟（配合上界一起构成「它就是下一次」的证明） */
function assertNoEarlierMatch(cron: string, afterMs: number, untilMs: number): void {
  // bruteForceNext 的候选点是 floor(after)+i 分钟，i 从 1 起；区间端点必须排掉 untilMs 本身
  const before = bruteForceNext(cron, afterMs, Math.ceil((untilMs - afterMs) / MINUTE_MS) - 2);
  assert.equal(before, null, `${cron} 在 ${new Date(untilMs).toISOString()} 之前不应有更早的匹配`);
}

// ──────────────────────────────── 布防与触发 ────────────────────────────────

test('设 50ms 后的定时器到期后触发一次并从表里消失', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    const res = await h.store.set({ at: new Date(h.clock.now().getTime() + 50).toISOString(), payload: { note: 'x' } });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(h.store.armedCount(), 1);

    await advanceMs(h.clock, 49);
    assert.equal(h.fired.length, 0, '49ms 时未到期');

    await advanceMs(h.clock, 1);
    assert.equal(h.fired.length, 1, '刚过 50ms 即触发');
    assert.equal(h.fired[0]?.id, res.id);
    assert.equal(h.fired[0]?.at, h.startMs + 50, '触发时刻就是到期时刻');
    assert.deepEqual(h.fired[0]?.entry.payload, { note: 'x' });

    // 一次性条目触发后移除，且不再有在途 handle
    assert.equal(h.store.get(res.id), null);
    assert.equal(h.store.list().length, 0);
    assert.equal(h.store.armedCount(), 0);

    await h.store.flush();
    const snap = await readSnapshot(h.file);
    assert.deepEqual(snap.entries, []);
  } finally {
    await cleanup(h);
  }
});

test('set 落盘的内容能被新实例 load 回来', async () => {
  const dir = await tempDir('irmia-timer-');
  const file = join(dir, 'timers.json');
  const nowMs = 1_800_000_000_000;
  const clockA = createVirtualClock(nowMs);
  const a = new TimerStore(file, virtualStoreDepsForTest(clockA));
  await a.load();
  const res = await a.set({ at: new Date(nowMs + 3_600_000).toISOString(), payload: 42 });
  assert.equal(res.ok, true);
  if (!res.ok) return;

  const clockB = createVirtualClock(nowMs);
  const b = new TimerStore(file, virtualStoreDepsForTest(clockB));
  await b.load();
  const loaded = b.list();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.timerId, res.id);
  assert.equal(loaded[0]?.payload, 42);
  assert.equal(loaded[0]?.at, new Date(nowMs + 3_600_000).toISOString());
  assert.deepEqual(b.warnings(), []);
  a.stop();
  b.stop();
  await removeTree(dir);
});

test('已过期条目在 start() 时立即触发（once 语义，不跳过）', async () => {
  const dir = await tempDir('irmia-timer-');
  const file = join(dir, 'timers.json');
  const startMs = 1_800_000_000_000;
  const past = new Date(startMs - 5 * MINUTE_MS).toISOString();

  // 预置一份「上次运行留下的、已经过期」的表
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      savedAt: past,
      entries: [{ timerId: 't_overdue', at: past, payload: 'wake-me', skipped: 0 }],
    }),
    'utf8',
  );

  const clock = createVirtualClock(startMs);
  const store = new TimerStore(file, virtualStoreDepsForTest(clock));
  await store.load();
  // 构造时只读盘，不布防、不触发
  assert.equal(store.list().length, 1);

  const fired: StoredTimerEntry[] = [];
  store.start((entry) => {
    fired.push(entry);
  });

  // start() 内部就完成了触发，不需要推进时钟
  assert.equal(fired.length, 1);
  assert.equal(fired[0]?.timerId, 't_overdue');
  assert.equal(fired[0]?.payload, 'wake-me');
  assert.equal(store.get('t_overdue'), null);
  assert.equal(store.armedCount(), 0);

  store.stop();
  await removeTree(dir);
});

test('已过期的 cron 条目在 start() 时补最近一次并重新布防', async () => {
  const dir = await tempDir('irmia-timer-');
  const file = join(dir, 'timers.json');
  const startMs = 1_800_000_000_000;
  const lastDue = new Date(startMs - 3 * DAY_MS).toISOString();
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      savedAt: lastDue,
      entries: [{ timerId: 't_daily', at: lastDue, cron: '0 9 * * *', payload: { kind: 'digest' }, skipped: 0 }],
    }),
    'utf8',
  );

  const clock = createVirtualClock(startMs);
  const store = new TimerStore(file, virtualStoreDepsForTest(clock));
  await store.load();
  const fired: StoredTimerEntry[] = [];
  store.start((entry) => {
    fired.push(entry);
  });

  assert.equal(fired.length, 1);
  const after = store.get('t_daily');
  assert.notEqual(after, null);
  assert.ok(Date.parse(after?.at ?? '') > startMs, '下一次到期必须在未来');
  assert.ok((after?.skipped ?? 0) >= 3, `离线段数应被记数，实际 ${after?.skipped}`);
  assert.deepEqual(after?.payload, { kind: 'digest' });

  store.stop();
  await removeTree(dir);
});

test('start() 重复调用不会重复布防，stop() 清空在途 handle', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    await h.store.set({ at: new Date(h.clock.now().getTime() + 60_000).toISOString() });
    assert.equal(h.store.armedCount(), 1);
    h.store.start(() => {});
    assert.equal(h.store.armedCount(), 1, '不应因重复 start 叠加 handle');

    h.store.stop();
    assert.equal(h.store.armedCount(), 0);
    await advanceMs(h.clock, 120_000);
    assert.equal(h.fired.length, 0, 'stop 之后不得触发');

    // stop 不改表也不删文件
    assert.equal(h.store.list().length, 1);
    await h.store.flush();
    const snap = await readSnapshot(h.file);
    assert.equal(snap.entries.length, 1);
  } finally {
    await cleanup(h);
  }
});

test('cancel() 移除条目、清 handle 并落盘', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    const res = await h.store.set({ at: new Date(h.clock.now().getTime() + 1_000).toISOString() });
    assert.equal(res.ok, true);
    if (!res.ok) return;

    assert.equal(await h.store.cancel(res.id), true);
    assert.equal(await h.store.cancel(res.id), false);
    assert.equal(h.store.armedCount(), 0);
    await advanceMs(h.clock, 5_000);
    assert.equal(h.fired.length, 0);

    const snap = await readSnapshot(h.file);
    assert.deepEqual(snap.entries, []);
  } finally {
    await cleanup(h);
  }
});

// ──────────────────────────────── 分段布防 ────────────────────────────────

test('30 天后的定时器按 2^31-1ms 分段布防，不溢出也不提前触发', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    const due = h.clock.now().getTime() + 30 * DAY_MS;
    const res = await h.store.set({ at: new Date(due).toISOString() });
    assert.equal(res.ok, true);
    if (!res.ok) return;

    // 第一段顶到上限
    assert.equal(h.clock.lastDelayMs, MAX_TIMEOUT_MS);
    assert.equal(h.store.armedCount(), 1);

    // 第一段醒来时还没到点：重新接力而不是触发
    await advanceMs(h.clock, MAX_TIMEOUT_MS);
    assert.equal(h.fired.length, 0);
    assert.ok(h.clock.lastDelayMs > 0 && h.clock.lastDelayMs <= MAX_TIMEOUT_MS, '接力段必须落在上限内');

    // 最后一段收尾
    await advanceMs(h.clock, 30 * DAY_MS - MAX_TIMEOUT_MS);
    assert.equal(h.fired.length, 1);
    assert.equal(h.fired[0]?.id, res.id);
    assert.equal(h.fired[0]?.at, due);
    assert.equal(h.store.armedCount(), 0);
  } finally {
    await cleanup(h);
  }
});

test('超过上限仅一点点的延迟也会被切成两段', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    const due = h.clock.now().getTime() + MAX_TIMEOUT_MS + 1_000;
    await h.store.set({ at: new Date(due).toISOString() });
    assert.equal(h.clock.lastDelayMs, MAX_TIMEOUT_MS);
    await advanceMs(h.clock, MAX_TIMEOUT_MS);
    assert.equal(h.fired.length, 0);
    assert.equal(h.clock.lastDelayMs, 1_000);
    await advanceMs(h.clock, 1_000);
    assert.equal(h.fired.length, 1);
    assert.equal(h.fired[0]?.at, due);
  } finally {
    await cleanup(h);
  }
});

// ──────────────────────────────── cron ────────────────────────────────

test('cron "*/1 * * * *" 触发后不删除条目，自动结算下一次', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    const res = await h.store.set({ cron: '*/1 * * * *', payload: 'tick' });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const first = h.store.get(res.id);
    assert.equal(first?.at, new Date(h.startMs + MINUTE_MS).toISOString());

    await advanceMs(h.clock, MINUTE_MS);
    assert.equal(h.fired.length, 1);
    assert.equal(h.fired[0]?.at, h.startMs + MINUTE_MS);

    const after = h.store.get(res.id);
    assert.notEqual(after, null, '周期条目触发后必须留在表里');
    assert.equal(after?.at, new Date(h.startMs + 2 * MINUTE_MS).toISOString());
    assert.equal(after?.cron, '*/1 * * * *');
    assert.equal(after?.skipped, 0);
    assert.equal(h.store.armedCount(), 1, '应当已重新布防');
    assert.equal(h.clock.lastDelayMs, MINUTE_MS);

    await advanceMs(h.clock, MINUTE_MS);
    assert.equal(h.fired.length, 2);
    assert.equal(h.store.get(res.id)?.at, new Date(h.startMs + 3 * MINUTE_MS).toISOString());

    // 落盘的表里也是推进后的 at，重启不会回到第一拍
    await h.store.flush();
    const snap = await readSnapshot(h.file);
    assert.equal(snap.entries[0]?.at, new Date(h.startMs + 3 * MINUTE_MS).toISOString());
  } finally {
    await cleanup(h);
  }
});

test('cron 跨过多拍时只补最近一次并记 skipped', async () => {
  const dir = await tempDir('irmia-timer-');
  const file = join(dir, 'timers.json');
  const startMs = 1_800_000_000_000;
  // 模拟「进程离线 2 小时」留下的表：上次到期时刻停在 2 小时前
  const lastDueMs = startMs - 2 * 3_600_000;
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      savedAt: new Date(lastDueMs).toISOString(),
      entries: [{ timerId: 't_tick', at: new Date(lastDueMs).toISOString(), cron: '*/1 * * * *', payload: null, skipped: 0 }],
    }),
    'utf8',
  );

  const clock = createVirtualClock(startMs);
  const store = new TimerStore(file, virtualStoreDepsForTest(clock));
  await store.load();
  const fired: string[] = [];
  store.start((entry) => {
    fired.push(entry.timerId);
  });

  // 前 119 拍被跨过：只在当前时刻补一次
  assert.deepEqual(fired, ['t_tick'], '离线跨过的拍次只补最近一次');
  const entry = store.get('t_tick');
  assert.ok((entry?.skipped ?? 0) >= 120, `跨过的拍次要计数，实际 ${entry?.skipped}`);
  assert.equal(store.armedCount(), 1, '周期条目触发后仍在表里且已重新布防');

  // 下一次到期落在未来，延迟不超过一个周期
  const nextAt = Date.parse(entry?.at ?? '');
  assert.ok(nextAt > startMs, '下一次到期必须在未来');
  assert.ok(nextAt - startMs <= MINUTE_MS, '重新布防的延迟不超过一个周期');

  // 再走一拍：正常触发，并且仍然留在表里
  const fired2 = clock.advance(nextAt);
  await flushMicrotasks();
  assert.equal(fired2, 1);
  assert.equal(fired.length, 2);
  const after = store.get('t_tick');
  assert.notEqual(after, null);
  assert.ok(Date.parse(after?.at ?? '') > nextAt);

  store.stop();
  await removeTree(dir);
});

test('cron 解析：五段语法与对照参照逐拍一致', async () => {
  const startMs = 1_800_000_000_000;

  // "*/15 9-18 * * 1-5"：工作日 9-18 点的每 15 分钟
  const a = parseCron('*/15 9-18 * * 1-5');
  assert.equal(a.ok, true);
  if (!a.ok) return;
  const aOut = nextCronTime(a.cron, new Date(startMs));
  assert.notEqual(aOut, null);
  if (aOut === null) return;
  assert.ok((aOut.getMinutes() % 15) === 0);
  assert.ok(aOut.getHours() >= 9 && aOut.getHours() <= 18);
  assert.ok((aOut.getDay() >= 1 && aOut.getDay() <= 5));

  // "0 3 1 * *"：每月 1 号 3 点（日段受限、周段为 *，不能落到 OR 分支）
  const b = parseCron('0 3 1 * *');
  assert.equal(b.ok, true);
  if (!b.ok) return;
  const bOut = nextCronTime(b.cron, new Date(startMs));
  assert.notEqual(bOut, null);
  if (bOut === null) return;
  assert.equal(bOut.getDate(), 1);
  assert.equal(bOut.getHours(), 3);
  assert.equal(bOut.getMinutes(), 0);
  // 下一次之前的 3 天里不应有更早的匹配
  assertNoEarlierMatch('0 3 1 * *', startMs, bOut.getTime());

  // 日与周同时受限 → vixie 的 OR 语义
  const c = parseCron('0 0 1 * 1');
  assert.equal(c.ok, true);
  if (!c.ok) return;
  const cOut = nextCronTime(c.cron, new Date(startMs));
  assert.equal(bruteForceNext('0 0 1 * 1', startMs), cOut?.getTime());

  // 星期 7 等同 0（周日）
  const d = parseCron('30 5 * * 7');
  assert.equal(d.ok, true);
  if (!d.ok) return;
  const dOut = nextCronTime(d.cron, new Date(startMs));
  assert.equal(dOut?.getDay(), 0);
  assert.equal(dOut?.getMinutes(), 30);
});

test('cron 解析拒绝非法表达式', () => {
  const bad = [
    '',
    '* * * *',
    '* * * * * *',
    '61 * * * *',
    '* 24 * * *',
    '* * 0 * *',
    '* * * 13 *',
    '* * * * 8',
    '5-1 * * * *',
    '*/0 * * * *',
    'a * * * *',
    '* * * JAN *',
    '@daily',
  ];
  for (const expr of bad) {
    const res = parseCron(expr);
    assert.equal(res.ok, false, `应拒绝：${expr}`);
  }
  const good = ['* * * * *', '*/5 * * * *', '0 9 * * 1-5', '0,30 8-18 * * *', '15 4 1,15 * *'];
  for (const expr of good) {
    assert.equal(parseCron(expr).ok, true, `应接受：${expr}`);
  }
});

test('set() 拒绝非法输入，重复 id 由 store 自管', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    const missing = await h.store.set({});
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.error, /至少提供一个/);

    const badAt = await h.store.set({ at: '2026-09-30 14:00:00' });
    assert.equal(badAt.ok, false);
    if (!badAt.ok) assert.match(badAt.error, /ISO 8601/);

    const badCron = await h.store.set({ cron: '99 * * * *' });
    assert.equal(badCron.ok, false);
    if (!badCron.ok) assert.match(badCron.error, /cron 非法/);

    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const badPayload = await h.store.set({ at: new Date(h.clock.now().getTime() + 1_000).toISOString(), payload: circular });
    assert.equal(badPayload.ok, false);
    if (!badPayload.ok) assert.match(badPayload.error, /序列化/);

    const farFuture = await h.store.set({ at: '9999-01-01T00:00:00Z' });
    assert.equal(farFuture.ok, false);
    if (!farFuture.ok) assert.match(farFuture.error, /50 年/);

    // at 与 cron 同时给出：以 at 为准并留 warning
    const bothAt = new Date(h.clock.now().getTime() + 5_000).toISOString();
    const both = await h.store.set({ at: bothAt, cron: '0 0 * * *' });
    assert.equal(both.ok, true);
    if (!both.ok) return;
    const stored = h.store.get(both.id);
    assert.equal(stored?.cron, undefined, '同时给出时 cron 必须被忽略');
    assert.equal(stored?.at, bothAt);
    assert.ok(h.store.warnings().some((w) => w.includes('以 at 为准')));
    assert.equal(h.store.list().length, 1, '每次 set 都拿到独立 id，互不覆盖');

    await h.store.cancel(both.id);
    assert.equal(h.store.list().length, 0);

    // cron 形式的 set 正常入表，并且结算出下一次到期
    const byCron = await h.store.set({ cron: '0 9 * * *' });
    assert.equal(byCron.ok, true);
    if (!byCron.ok) return;
    const cronEntry = h.store.get(byCron.id);
    assert.equal(cronEntry?.cron, '0 9 * * *');
    assert.ok(Date.parse(cronEntry?.at ?? '') > h.clock.now().getTime());
  } finally {
    await cleanup(h);
  }
});

// ──────────────────────────────── 落盘 ────────────────────────────────

test('布局：set 后原文件存在，tmp 文件被 rename 掉', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    assert.equal(await stat(h.file).then(() => true, () => false), false, '首次 set 前不应有表文件');
    await h.store.set({ at: new Date(h.clock.now().getTime() + 60_000).toISOString() });
    const files = await readdir(h.dir);
    await h.store.flush();
    const files2 = await readdir(h.dir);
    assert.deepEqual(files2, ['timers.json'], '落盘结束后只应留下正式文件');
    assert.equal((await stat(h.file)).size > 0, true);
  } finally {
    await cleanup(h);
  }
});

/**
 * 清理临时目录。Windows 上目录刚被写过的瞬间常报 ENOTEMPTY（空目录也删不掉，
 * 通常是防病毒/索引持有句柄），所以退避重试，且绝不让清理失败掩盖断言结果。
 */
async function removeTree(dir: string): Promise<void> {
  let delay = 20;
  for (let attempt = 0; attempt < 9; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* 清理失败不影响测试结论：临时目录留在系统 temp 里由 OS 回收 */
  }
}

test('save() 走 .tmp + rename，且原文件在整个过程中始终存在', async () => {
  const dir = await tempDir('irmia-timer-');
  const file = join(dir, 'timers.json');
  const clock = createVirtualClock(1_800_000_000_000);
  const seen: Array<{ from: string; to: string; destExisted: boolean; tmpReadable: string }> = [];
  let destMissing = 0;
  // 用注入的 createExclusive/rename 观察两阶段写入：esm 的命名空间导出不可改，
  // 但依赖注入点本来就为可观测性预留
  const store = new TimerStore(file, virtualStoreDepsForTest(clock, {
    createExclusive: async (path: string, data: string) => {
      await fsp.open(path, 'wx').then(async (handle) => {
        await handle.truncate(0);
        await handle.writeFile(data, 'utf8');
        await handle.sync();
        await handle.close();
      });
    },
    rename: async (from: string, to: string) => {
      const destExisted = await stat(to).then(() => true, () => false);
      if (!destExisted) destMissing += 1;
      const tmpReadable = await readFile(from, 'utf8');
      seen.push({ from, to, destExisted, tmpReadable });
      await fsp.rename(from, to);
    },
  }));
  await store.load();

  await store.set({ at: new Date(clock.now().getTime() + 1_000).toISOString() });
  const before = await readSnapshot(file);
  assert.equal(before.entries.length, 1);
  assert.equal(seen.length, 1, '第一次 set 也应经由 rename 落盘');

  await store.set({ at: new Date(clock.now().getTime() + 2_000).toISOString() });
  await store.flush();

  assert.equal(seen.length >= 2, true, `覆盖写必须经由 rename，实际 ${seen.length} 次`);
  for (const call of seen) {
    assert.equal(call.to, file);
    assert.match(call.from, /^.*timers\.json\.tmp\.\d+$/, `tmp 文件名应为 <path>.tmp.<pid>：${call.from}`);
    // rename 之前原文件仍在（不允许先删原文件）
    assert.ok(call.tmpReadable.includes('"entries"'), 'tmp 文件在 rename 前必须已写入内容');
  }
  assert.equal(destMissing, 1, '只有第一次 set 时目标文件不存在，此后每次都在');

  const after = await readSnapshot(file);
  assert.equal(after.entries.length, 2);
  const files = await readdir(dir);
  assert.deepEqual(files, ['timers.json']);
  store.stop();
  await removeTree(dir);
});

test('落盘失败只记 warning，内存表与既有文件都不被破坏', async () => {
  const dir = await tempDir('irmia-timer-');
  const file = join(dir, 'timers.json');
  const clock = createVirtualClock(1_800_000_000_000);
  const store = new TimerStore(file, virtualStoreDepsForTest(clock, { rename: async () => { throw new Error('EIO: 磁盘故障'); } }));
  await store.load();
  const res = await store.set({ at: new Date(clock.now().getTime() + 1_000).toISOString() });
  assert.equal(res.ok, true);
  assert.equal(store.list().length, 1);
  assert.ok(store.warnings().some((w) => w.includes('EIO')), '失败必须留下可告警的痕迹');
  store.stop();
  await removeTree(dir);
});

test('损坏或非法的 timers.json 不会让 load 抛错，只留 warning', async () => {
  const dir = await tempDir('irmia-timer-');
  const file = join(dir, 'timers.json');
  const nowMs = 1_800_000_000_000;
  await writeFile(file, '{ 这不是 JSON', 'utf8');
  const clockA = createVirtualClock(nowMs);
  const a = new TimerStore(file, virtualStoreDepsForTest(clockA));
  await a.load();
  assert.deepEqual(a.list(), []);
  assert.equal(a.warnings().length, 1);
  a.stop();

  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      savedAt: 'x',
      entries: [
        { timerId: 'ok', at: new Date(nowMs + 60_000).toISOString(), payload: null, skipped: 0 },
        { timerId: 'no-at' },
        { at: new Date(nowMs + 60_000).toISOString() },
        { timerId: 'bad-cron', at: new Date(nowMs + 60_000).toISOString(), cron: '99 * * * *' },
        { timerId: 'ok', at: new Date(nowMs + 120_000).toISOString() },
      ],
    }),
    'utf8',
  );
  const clockB = createVirtualClock(nowMs);
  const b = new TimerStore(file, virtualStoreDepsForTest(clockB));
  await b.load();
  assert.deepEqual(b.list().map((e) => e.timerId), ['ok']);
  assert.ok(b.warnings().some((w) => w.includes('非法表项')));
  assert.ok(b.warnings().some((w) => w.includes('去重')));
  b.stop();
  await removeTree(dir);
});

// ──────────────────────────────── 错峰补触发 ────────────────────────────────

test('多条过期条目按到期先后串行补触发，相邻间隔 >= 5s', async () => {
  const dir = await tempDir('irmia-timer-');
  const file = join(dir, 'timers.json');
  const startMs = 1_800_000_000_000;
  const ago = (ms: number) => new Date(startMs - ms).toISOString();

  // 故意乱序写入，验证按 at 排序而不是按文件顺序
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      savedAt: ago(DAY_MS),
      entries: [
        { timerId: 't_late', at: ago(3 * DAY_MS), payload: 'third', skipped: 0 },
        { timerId: 't_first', at: ago(9 * DAY_MS), payload: 'first', skipped: 0 },
        { timerId: 't_second', at: ago(5 * DAY_MS), payload: 'second', skipped: 0 },
      ],
    }),
    'utf8',
  );

  const clock = createVirtualClock(startMs);
  const store = new TimerStore(file, virtualStoreDepsForTest(clock));
  await store.load();
  const fired: Array<{ id: string; at: number }> = [];
  const listsInsideCb: number[] = [];
  store.start((entry) => {
    fired.push({ id: entry.timerId, at: clock.now().getTime() });
    listsInsideCb.push(store.list().length);
  });

  // 第一发立即（start 内同步完成），后续各让出 5 秒
  assert.deepEqual(fired.map((f) => f.id), ['t_first']);
  // 回调触发时条目已经结算（一次性条目已从表里摘掉）
  assert.deepEqual(listsInsideCb, [2]);

  // 推进到第二条到期前 1ms：不得触发
  assert.equal(clock.advance(startMs + 5_000 - 1), 0, '不到 5 秒不得触发第二条');
  assert.equal(fired.length, 1);
  // 再前进 1ms 到第二个到期点
  assert.equal(clock.advance(startMs + 5_000), 1);
  await flushMicrotasks();
  assert.deepEqual(fired.map((f) => f.id), ['t_first', 't_second']);
  // 第三个到期点在 +5s，中间不得有夹带触发
  assert.equal(clock.advance(startMs + 10_000 - 1), 0);
  assert.equal(fired.length, 2);
  assert.equal(clock.advance(startMs + 10_000), 1);
  await flushMicrotasks();
  assert.deepEqual(fired.map((f) => f.id), ['t_first', 't_second', 't_late']);

  const gaps = [fired[1]!.at - fired[0]!.at, fired[2]!.at - fired[1]!.at];
  for (const gap of gaps) assert.ok(gap >= 5_000, `相邻间隔必须 >= 5s，实际 ${gap}`);
  assert.equal(store.list().length, 0);
  assert.ok(store.warnings().some((w) => w.includes('已过期')));

  store.stop();
  await removeTree(dir);
});

test('单条过期条目的立即触发不被错峰延迟', async () => {
  const dir = await tempDir('irmia-timer-');
  const file = join(dir, 'timers.json');
  const startMs = 1_800_000_000_000;
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      savedAt: new Date(startMs - DAY_MS).toISOString(),
      entries: [{ timerId: 't_only', at: new Date(startMs - DAY_MS).toISOString(), payload: null, skipped: 0 }],
    }),
    'utf8',
  );
  const clock = createVirtualClock(startMs);
  const store = new TimerStore(file, virtualStoreDepsForTest(clock));
  await store.load();
  const fired: string[] = [];
  store.start((entry) => {
    fired.push(entry.timerId);
  });
  assert.deepEqual(fired, ['t_only']);
  assert.equal(clock.now().getTime(), startMs, '不得为唯一一条付错峰代价');
  store.stop();
  await removeTree(dir);
});

test('未来条目与过期条目共存：未来的照常守时，过期的不冲掉它', async () => {
  const dir = await tempDir('irmia-timer-');
  const file = join(dir, 'timers.json');
  const startMs = 1_800_000_000_000;
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      savedAt: new Date(startMs - DAY_MS).toISOString(),
      entries: [
        { timerId: 't_past', at: new Date(startMs - DAY_MS).toISOString(), payload: null, skipped: 0 },
        { timerId: 't_future', at: new Date(startMs + 30_000).toISOString(), payload: null, skipped: 0 },
      ],
    }),
    'utf8',
  );
  const clock = createVirtualClock(startMs);
  const store = new TimerStore(file, virtualStoreDepsForTest(clock));
  await store.load();
  const fired: Array<{ id: string; at: number }> = [];
  store.start((entry) => {
    fired.push({ id: entry.timerId, at: clock.now().getTime() });
  });
  assert.deepEqual(fired.map((f) => f.id), ['t_past']);
  await advanceMs(clock, 30_000);
  assert.deepEqual(fired.map((f) => f.id), ['t_past', 't_future']);
  assert.equal(fired[1]?.at, startMs + 30_000);
  store.stop();
  await removeTree(dir);
});

// ──────────────────────────────── 真相源校准 ────────────────────────────────

test('snapshotFromEntries 与 importEntries：日志折算是真相源', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    const stale = await h.store.set({ at: new Date(h.clock.now().getTime() + 3_600_000).toISOString(), payload: 'stale' });
    assert.equal(stale.ok, true);
    assert.equal(h.store.list().length, 1);

    const fromLog: unknown[] = [
      { timerId: 't_a', at: new Date(h.clock.now().getTime() + 120_000).toISOString(), payload: { a: 1 }, skipped: 0 },
      { timerId: 't_b', at: new Date(h.clock.now().getTime() + 240_000).toISOString(), skipped: 2 },
      { timerId: 'bad', at: 'not-a-time' },
    ];
    const res = await h.store.importEntries(fromLog);
    assert.equal(res.imported, 2);
    assert.equal(res.rejected.length, 1);

    // 盘上的旧条目不在了，并且真的写进了文件
    assert.deepEqual(h.store.snapshotFromEntries().map((e) => e.timerId), ['t_a', 't_b']);
    const snap = await readSnapshot(h.file);
    assert.deepEqual(snap.entries.map((e) => e.timerId), ['t_a', 't_b']);
    assert.equal(snap.entries[1]?.skipped, 2);
    assert.equal(h.store.armedCount(), 2, '导入时已在运行，应重新布防');
    await h.store.flush();
    assert.deepEqual(await h.store.snapshotFromEntries(), (await readSnapshot(h.file)).entries, 'snapshotFromEntries 必须与落盘一致');
  } finally {
    await cleanup(h);
  }
});

test('reconcile：盘上 hint 与日志不一致时以日志为准并回报差异', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    const nowMs = h.clock.now().getTime();
    // 盘上塞两个 hint 条目：一个日志里没有（脏），一个到期时刻和日志不一致（陈旧）
    await h.store.importEntries([
      { timerId: 't_keep', at: new Date(nowMs + 60_000).toISOString(), payload: 'keep', skipped: 0 },
      { timerId: 't_dirty', at: new Date(nowMs + 90_000).toISOString(), payload: 'dirty', skipped: 0 },
      { timerId: 't_stale', at: new Date(nowMs + 600_000).toISOString(), payload: 'stale', skipped: 0 },
    ]);
    assert.equal(h.store.list().length, 3);

    const logDerived: unknown[] = [
      { timerId: 't_keep', at: new Date(nowMs + 60_000).toISOString(), payload: 'keep', skipped: 0 },
      { timerId: 't_stale', at: new Date(nowMs + 300_000).toISOString(), payload: 'stale', skipped: 0 },
      { timerId: 't_new', at: new Date(nowMs + 420_000).toISOString(), payload: 'new', skipped: 0 },
    ];
    const diff = await h.store.reconcile(logDerived);

    assert.equal(diff.mismatch, true);
    assert.deepEqual(diff.missing, ['t_new']);
    assert.deepEqual(diff.extra, ['t_dirty']);
    assert.deepEqual(diff.different, ['t_stale']);
    assert.equal(diff.sourceCount, 3);
    assert.equal(diff.fileCount, 3);
    assert.ok(h.store.warnings().some((w) => w.includes('按日志重建')));

    // 内存与磁盘都已按日志重建
    assert.deepEqual(h.store.snapshotFromEntries().map((e) => e.timerId), ['t_keep', 't_stale', 't_new']);
    const snap = await readSnapshot(h.file);
    assert.deepEqual(snap.entries.map((e) => e.timerId), ['t_keep', 't_stale', 't_new']);
    assert.equal(snap.entries[1]?.at, new Date(nowMs + 300_000).toISOString());
  } finally {
    await cleanup(h);
  }
});

test('reconcile：一致时不改动盘上文件', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    const nowMs = h.clock.now().getTime();
    const entries: unknown[] = [
      { timerId: 't_x', at: new Date(nowMs + 60_000).toISOString(), payload: 1, skipped: 0 },
      { timerId: 't_y', at: new Date(nowMs + 120_000).toISOString(), cron: '0 9 * * *', payload: 2, skipped: 3 },
    ];
    await h.store.importEntries(entries);
    const rawBefore = await readFile(h.file, 'utf8');

    const diff = await h.store.reconcile(entries);
    assert.equal(diff.mismatch, false);
    assert.deepEqual(diff.missing, []);
    assert.deepEqual(diff.extra, []);
    assert.deepEqual(diff.different, []);
    assert.equal(await readFile(h.file, 'utf8'), rawBefore, '一致时不得重写文件');
  } finally {
    await cleanup(h);
  }
});

// ──────────────────────────────── 事件折叠辅助 ────────────────────────────────

test('timerEntriesFromEvents 折叠 timer/set 与 timer/cancelled', () => {
  const events = [
    { type: 'timer/set', data: { timerId: 't1', at: '2026-09-30T14:00:00+08:00', payload: { a: 1 } } },
    { type: 'timer/set', data: { timerId: 't2', cron: '0 9 * * *', payload: null } },
    { type: 'timer/set', data: { timerId: 't3', at: '2026-09-30T15:00:00+08:00', payload: null } },
    { type: 'timer/cancelled', data: { timerId: 't3' } },
    { type: 'timer/set', data: {} },
    { type: 'timer/fired', data: { timerId: 't1' } },
    { type: 'timer/set', data: { timerId: 't4', payload: null } },
  ];
  const folded = timerEntriesFromEvents(events);
  assert.deepEqual(folded.map((e) => e.timerId), ['t1', 't2']);
  assert.deepEqual(folded[0]?.at, '2026-09-30T14:00:00+08:00');
  assert.deepEqual(folded[0]?.payload, { a: 1 });
  assert.equal(folded[1]?.cron, '0 9 * * *');
});

test('折叠结果经 importEntries 能被直接采用', async () => {
  const h = await makeHarness(1_800_000_000_000);
  try {
    const nowMs = h.clock.now().getTime();
    const events = [
      { type: 'timer/set', data: { timerId: 't1', at: new Date(nowMs + 60_000).toISOString(), payload: 'p' } },
      { type: 'timer/set', data: { timerId: 't2', at: 'not-a-time', payload: 'q' } },
    ];
    const res = await h.store.importEntries(timerEntriesFromEvents(events));
    assert.equal(res.imported, 1);
    assert.equal(res.rejected.length, 1);
    assert.equal(h.store.list()[0]?.timerId, 't1');
  } finally {
    await cleanup(h);
  }
});

// ────────────────────── 事件出口：timer/set / timer/cancelled ──────────────────────
//
// 这一组钉住 2026-10-12 修的那条静默失效：`TimerStore` 原先只写 `data/timers.json`、
// 一个事件都不写，而真相源是日志 ⇒ `fold.ts` 的 `case 'timer/set'` 是死代码
// ⇒ `projection.timers` 恒为 `[]` ⇒ 首页卡片永远空态、界面「撤销」永远 notFound。
//
// 判据四条（每条都能独立失败）：
//   ① 布防恰好多一条 `timer/set`、撤销恰好多一条 `timer/cancelled`（不是"至少一条"——
//      重复写会让 `timer/set` 的条数失去意义，而它是"她排过几次"的唯一账）；
//   ② 事件形状与 `log/types.ts` 的 TimerSet / TimerCancelled 逐字段相同（不多不少），
//      **重放这些事件重建出来的表 == 盘上那份**（投影不是真相源，日志才是）；
//   ③ 恢复路径：投影非空时再走一遍 load + importEntries **不产生任何事件**
//      ——补了事件之后投影会非空，重复布防正是这一批最容易出事的地方；
//   ④ 反面对照：只读 `list` 不产生事件。

/** 假的事件出口：既记账，又把事件折成一张表。
 *
 * `set` / `cancelled` 的折叠语义与 `timerEntriesFromEvents` 同口径；`fired` 那一条
 * 按 `state/fold.ts` 的定时器分支走（一次性出表、周期留着）——下面逐条列出**就是这个原因**：
 * 真实的重放要走 fold，而这里要能在没有 EventLog 的情况下做"重放 == 盘上"的对照。
 */
function makeEventLogFixture(): {
  sink: TimerStoreEventSink;
  events: Array<{ type: string; data: Record<string, unknown> }>;
  counts(): { set: number; cancelled: number };
  fired(timerId: string): void;
  entries(): TimerEntry[];
} {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const sink: TimerStoreEventSink = {
    set: (entry) => { events.push({ type: 'timer/set', data: { ...entry } }); },
    cancelled: (timerId) => { events.push({ type: 'timer/cancelled', data: { timerId } }); },
  };
  return {
    sink,
    events,
    counts: () => ({
      set: events.filter((e) => e.type === 'timer/set').length,
      cancelled: events.filter((e) => e.type === 'timer/cancelled').length,
    }),
    fired: (timerId) => { events.push({ type: 'timer/fired', data: { timerId } }); },
    entries: () => {
      // 按 `fold.ts` 的定时器分支逐条走一遍，而不是在既有折叠结果上打补丁：
      // 那里 timer/fired 只让**一次性**条目出表，周期条目留着（它的 at 由后续 timer/set 推进）。
      const table = new Map<string, TimerEntry>();
      for (const event of events) {
        const timerId = event.data['timerId'];
        if (typeof timerId !== 'string') continue;
        if (event.type === 'timer/set') {
          const atRaw = event.data['at'];
          const cronRaw = event.data['cron'];
          const entry: TimerEntry = {
            timerId,
            payload: event.data['payload'] ?? null,
            ...(typeof atRaw === 'string' ? { at: atRaw } : {}),
            ...(typeof cronRaw === 'string' ? { cron: cronRaw } : {}),
          };
          if (entry.at === undefined && entry.cron === undefined) continue;
          table.set(timerId, entry);
        } else if (event.type === 'timer/cancelled') {
          table.delete(timerId);
        } else if (event.type === 'timer/fired') {
          const firedEntry = table.get(timerId);
          if (firedEntry !== undefined && firedEntry.cron === undefined) table.delete(timerId);
        }
      }
      return [...table.values()].sort(byTimerId);
    },
  };
}

/** 与 fold 的定时器分支同口径、与 log/types.ts 的 TimerEntry 同形状（`skipped` 不在投影里）。
 * 按 timerId 排——`store.list()` 是按到期先后排的，比之前先对齐次序。 */
function projectionOfEntries(entries: readonly StoredTimerEntry[]): TimerEntry[] {
  return entries
    .map((e) => ({
      timerId: e.timerId,
      at: e.at,
      ...(e.cron === undefined ? {} : { cron: e.cron }),
      payload: e.payload,
    }))
    .sort(byTimerId);
}

const byTimerId = (a: { timerId: string }, b: { timerId: string }): number => a.timerId.localeCompare(b.timerId);

/** `EventLog.readAll()` 是异步迭代器；测试里要的是数组（与 web-server 夹具同一条） */
async function readAllEvents(log: EventLog): Promise<AppEvent[]> {
  const out: AppEvent[] = [];
  for await (const event of log.readAll()) out.push(event);
  return out;
}

test('布防恰好多一条 timer/set，字段与 TimerSet 逐字一致（重放 == 盘上）', async () => {
  const h = await makeHarness(1_800_000_000_000);
  const log = makeEventLogFixture();
  h.store.setEventSink(log.sink);
  try {
    assert.deepEqual(log.counts(), { set: 0, cancelled: 0 }, '接线本身不产生事件');

    const at = new Date(h.clock.now().getTime() + 3_600_000).toISOString();
    const res = await h.store.set({ at, payload: { note: '到点提醒我' } });
    assert.equal(res.ok, true);
    if (!res.ok) return;

    assert.deepEqual(log.counts(), { set: 1, cancelled: 0 }, '布防**恰好**多一条 timer/set');
    const setEvent = log.events[0];
    assert.equal(setEvent?.type, 'timer/set');
    // 逐字段：timerId / at / payload 三个键，**没有 cron 那一格**（没给就不写，不是写 null）
    assert.deepEqual(Object.keys(setEvent?.data ?? {}).sort(), ['at', 'payload', 'timerId']);
    assert.equal(setEvent?.data['timerId'], res.id);
    assert.equal(setEvent?.data['at'], h.store.list()[0]?.at, '事件里的 at 就是表里那个规范化时刻');
    assert.deepEqual(setEvent?.data['payload'], { note: '到点提醒我' });

    // 重放：日志折出来的表 == 盘上那份（逐字段）
    await h.store.flush();
    assert.deepEqual(await readSnapshot(h.file).then((s) => s.entries), h.store.list(), '盘上 == 内存');
    assert.deepEqual(log.entries(), projectionOfEntries(h.store.list()), '日志折出来的 == 盘上那份');

    // cron 条：多出 cron 那一格，at 是那一次到期时刻
    const cronRes = await h.store.set({ cron: '0 9 * * *', payload: null });
    assert.equal(cronRes.ok, true);
    if (!cronRes.ok) return;
    assert.deepEqual(log.counts(), { set: 2, cancelled: 0 });
    const cronData = log.events[1]?.data ?? {};
    assert.deepEqual(Object.keys(cronData).sort(), ['at', 'cron', 'payload', 'timerId']);
    assert.equal(cronData['cron'], '0 9 * * *');
    assert.equal(cronData['payload'], null, 'payload 缺省就是 null（与表项一致，不留 undefined）');
    assert.deepEqual(log.entries(), projectionOfEntries(h.store.list()));
  } finally {
    await cleanup(h);
  }
});

test('撤销恰好多一条 timer/cancelled；取消不存在的 id 一条都不写', async () => {
  const h = await makeHarness(1_800_000_000_000);
  const log = makeEventLogFixture();
  h.store.setEventSink(log.sink);
  try {
    const res = await h.store.set({ at: new Date(h.clock.now().getTime() + 60_000).toISOString(), payload: 'x' });
    assert.equal(res.ok, true);
    if (!res.ok) return;

    assert.equal(await h.store.cancel(res.id), true);
    assert.deepEqual(log.counts(), { set: 1, cancelled: 1 }, '撤销**恰好**多一条 timer/cancelled');
    assert.deepEqual(log.events[1], { type: 'timer/cancelled', data: { timerId: res.id } });
    assert.deepEqual(log.events[1]?.data, { timerId: res.id }, '只有 timerId 一格（与 TimerCancelled 一致）');
    assert.deepEqual(log.entries(), [], '取消之后重放不出任何条目');

    // 幂等：不在表里的 id 不产生事件（否则"撤销了几次"这条账会被重复点击写花）
    assert.equal(await h.store.cancel(res.id), false);
    assert.equal(await h.store.cancel('t_never_existed'), false);
    assert.deepEqual(log.counts(), { set: 1, cancelled: 1 }, '取消不存在的 id 一条都不写');
  } finally {
    await cleanup(h);
  }
});

test('恢复路径：投影非空时重走一遍 load + importEntries，不重复导入、不重复布防、不再写事件', async () => {
  const startMs = 1_800_000_000_000;
  const dir = await tempDir('irmia-timer-');
  const file = join(dir, 'timers.json');
  const log = makeEventLogFixture();
  try {
    // ── 第一任进程：布防两条（一条 cron 周期、一条远期一次性）──
    const clockA = createVirtualClock(startMs);
    const a = new TimerStore(file, virtualStoreDepsForTest(clockA));
    a.setEventSink(log.sink);
    await a.load();
    a.start(() => { /* 第一任：这一拍不触发任何东西 */ });
    const futureAt = new Date(startMs + DAY_MS).toISOString();
    const once = await a.set({ at: futureAt, payload: { note: '一次性' } });
    const cron = await a.set({ cron: '0 4 * * *', payload: { kind: 'memory-maintain' } });
    assert.equal(once.ok && cron.ok, true);
    if (!once.ok || !cron.ok) return;
    await a.flush();
    a.stop();
    assert.deepEqual(log.counts(), { set: 2, cancelled: 0 }, '第一任恰好两条 timer/set');

    const eventsAfterFirstLife = log.events.length;
    const fileAfterFirstLife = await readSnapshot(file);
    const projection = log.entries(); // ≡ 重启后 fold 出来的 projection.timers（补了事件之后它**非空**）

    // ── 第二任进程（重启模拟）：load 盘上 hint → importEntries(投影) → start ──
    const clockB = createVirtualClock(startMs + 60_000);
    const b = new TimerStore(file, virtualStoreDepsForTest(clockB));
    b.setEventSink(log.sink);
    await b.load();
    assert.equal(b.list().length, 2, '盘上 hint 还在');
    const imported = await b.importEntries(projection);
    assert.equal(imported.imported, 2, '投影里两条都被采用');
    assert.deepEqual(imported.rejected, [], '一条都没被拒');
    assert.equal(b.list().length, 2, '导入**不叠加**：还是两条（不是 2 + 2 = 4）');
    b.start(() => { /* 恢复期不触发 */ });
    assert.equal(b.armedCount(), 2, '两条各自恰好一个在途 handle');

    const before = b.list();
    await b.flush();
    assert.deepEqual(b.list(), before, '重走一遍 importEntries 不改变表');
    assert.deepEqual(log.counts(), { set: 2, cancelled: 0 }, '恢复路径一条事件都不写（不重复布防）');
    assert.equal(log.events.length, eventsAfterFirstLife, '事件流在重启前后逐条相同');
    // 落盘的 `savedAt` 每任进程都写自己那一刻（它是"这一任什么时候存的"，不是事实），
    // 事实是 entries 那一份：逐字段比它。
    assert.deepEqual((await readSnapshot(file)).entries, fileAfterFirstLife.entries,
      '盘上的表逐字段没变（重启不重排、不重复导入）');
    assert.deepEqual(log.entries(), projectionOfEntries(b.list()));

    // ── 恢复期到期（投影里那一条的 at 已经过去）：推进一拍并留下一条事件，不重复布防 ──
    // 这条路径才是"补了事件之后"真正会变的形状：投影非空 ⇒ 恢复会布防它 ⇒ 已过期当场结算。
    // 时间取在周期条那一次到期**之后**（'0 4 * * *' = 本地 04:00；起点是本地 01:00）。
    // 再一次 `start()` = 宿主接管布防（`main.ts` 里 `TimerWakeSource.start()` 那一刻）：
    // `start` 对**已布防**的条目不会重复挂两个 handle——它先清空在途 handle 再按表重排一次。
    const staleAt = b.list().find((e) => e.cron !== undefined)?.at ?? '';
    clockB.advance(Date.parse(staleAt) + 1_000);
    assert.equal(Date.parse(staleAt) <= clockB.now().getTime(), true, '这一条此刻已经过期');
    b.start((entry) => { log.fired(entry.timerId); });
    const advanced = b.list().find((e) => e.cron !== undefined);
    assert.notEqual(advanced?.at, staleAt, '恢复期到期 ⇒ at 推进到下一拍');
    assert.equal(Date.parse(advanced?.at ?? '') > clockB.now().getTime(), true, '推进后的时刻在未来');
    assert.equal(b.list().length, 2, '推进期间条目没被复制成两条');
    assert.deepEqual(log.counts(), { set: 3, cancelled: 0 }, '推进恰好留下一条 timer/set');
    assert.deepEqual(projectionOfEntries(b.list()), log.entries(),
      '推进之后：重放出来的表与盘上逐字段一致');
    await b.flush();
    assert.deepEqual((await readSnapshot(file)).entries, b.list(), '推进后的表已落盘');

    // 再走一遍（第三任）：结论必须一样——"恰好多一条"这件事在恢复上要成立任意次
    const clockC = createVirtualClock(startMs + 120_000);
    const c = new TimerStore(file, virtualStoreDepsForTest(clockC));
    c.setEventSink(log.sink);
    await c.load();
    await c.importEntries(log.entries());
    const setCountBeforeC = log.counts().set;
    c.start(() => { /* 恢复期不触发 */ });
    assert.equal(c.list().length, 2, '第三任照样两条');
    assert.equal(c.armedCount(), 2);
    assert.equal(log.counts().set, setCountBeforeC, '第三任的恢复一条事件都不写');
    assert.deepEqual(projectionOfEntries(c.list()), log.entries());
    c.stop();
    b.stop();
  } finally {
    await removeTree(dir);
  }
});

test('到期：一次性条目出表、周期条目留在表里并结算下一拍（timer/fired 的既有语义）', async () => {
  const startMs = 1_800_000_000_000;
  const dir = await tempDir('irmia-timer-');
  const file = join(dir, 'timers.json');
  const log = makeEventLogFixture();
  try {
    const clock = createVirtualClock(startMs);
    const store = new TimerStore(file, virtualStoreDepsForTest(clock));
    store.setEventSink(log.sink);
    await store.load();
    const firedIds: string[] = [];
    store.start((entry) => { firedIds.push(entry.timerId); });

    const once = await store.set({ at: new Date(startMs + 60_000).toISOString(), payload: 'g' });
    const daily = await store.set({ cron: '0 9 * * *', payload: { kind: 'digest' } });
    assert.equal(once.ok && daily.ok, true);
    if (!once.ok || !daily.ok) return;
    assert.equal(store.armedCount(), 2);

    // 快进一分钟：一次性那条到期（周期那条的下一次在 09:00，不在这一拍）
    await advanceMs(clock, 60_000);
    assert.deepEqual(firedIds, [once.id]);
    log.fired(once.id); // 到期记账由 WakeSink 落（本模块不发这条），这里补上真实的因果顺序

    assert.equal(store.get(once.id), null, '一次性条目触发即出表');
    assert.equal(store.get(daily.id)?.cron, '0 9 * * *', '周期条目留在表里');
    assert.equal(store.armedCount(), 1, '周期那条已经排好下一拍');

    // 折叠语义（与 state/fold.ts 的定时器分支同口径）：一次性那条被 fired 收掉、
    // 周期那条留在表里且 at 已推进到下一拍（推进这件事本身也是一条 timer/set）
    const afterOnce = log.entries();
    assert.deepEqual(afterOnce.map((e) => e.timerId), [daily.id], '一次性那条被 fired 收掉');
    assert.deepEqual(afterOnce, projectionOfEntries(store.list()), '周期那条的 at 已推进到下一拍');

    // 更长的离线：跳过好几拍也只记数不重放，表里照旧只有周期那一条。
    // 期望值按**本机时区**算（cron 走本地墙钟：09:00 是本地九点，不是 UTC 九点）——
    // 起点是 startMs + 4 天 01:00 本地，所以下一拍就是"那一天本地 09:00"。
    await advanceMs(clock, 3 * DAY_MS);
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0]?.timerId, daily.id);
    const afterCatchup = new Date(startMs + 4 * DAY_MS);
    afterCatchup.setHours(9, 0, 0, 0);
    assert.equal(store.list()[0]?.at, afterCatchup.toISOString());
    assert.deepEqual(projectionOfEntries(store.list()), log.entries(),
      '每次推进都留下一条 timer/set：重放出来的 at 与盘上同一个时刻');
    assert.deepEqual(log.counts(), { set: 5, cancelled: 0 },
      '2 次布防 + 到期后 3 次重新布防；`timer/fired` 不是本模块写的事件');
    store.stop();
    await store.flush();
  } finally {
    await removeTree(dir);
  }
});

test('反面对照：只 list / get / 重复 start 不产生任何事件', async () => {
  const h = await makeHarness(1_800_000_000_000);
  const log = makeEventLogFixture();
  h.store.setEventSink(log.sink);
  try {
    const res = await h.store.set({ at: new Date(h.clock.now().getTime() + 3_600_000).toISOString(), payload: 1 });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(log.counts(), { set: 1, cancelled: 0 });

    h.store.list();
    h.store.snapshotFromEntries();
    h.store.get(res.id);
    h.store.armedCount();
    h.store.nowMs();
    h.store.warnings();
    h.store.start(() => { /* 再 start 一次：已在跑，不重复布防 */ });
    await h.store.flush();

    assert.deepEqual(log.counts(), { set: 1, cancelled: 0 }, '只读动作一条事件都不该写');
    assert.equal(h.store.armedCount(), 1);

    // 没接线（CLI 只读场景）：布防照旧能用，但一个事件都不写——绝不静默造一条没有主的记录
    const bare = new TimerStore(null, virtualStoreDepsForTest(h.clock));
    const bareRes = await bare.set({ at: new Date(h.clock.now().getTime() + 1000).toISOString() });
    assert.equal(bareRes.ok, true);
    assert.equal(bare.list().length, 1);
    assert.deepEqual(log.counts(), { set: 1, cancelled: 0 }, '未接线的实例不写事件');
  } finally {
    await cleanup(h);
  }
});

// ──────────── 端到端：真 store → 真事件日志 → 真投影（首页卡片与撤销按钮读的就是它） ────────────
//
// 上面那一组用的是假出口；这一组按 `main.ts` 的**生产接线**把三件真东西串起来：
// `TimerStore.setEventSink({set: emit('timer/set'), cancelled: emit('timer/cancelled')})`
// ——`emit` 就是 `main.ts:906` 那一格（`append` 落库 + `applyOne` 折投影）。
//
// 它要能回答用户问的那两句话：
//   · 首页「定时器」卡片现在列得出来吗？——投影 `timers` 里有没有那一条、字段够不够；
//   · 「撤销」按钮现在能成功吗？——`web/server.ts` 的 `timer-cancel` 判据是
//     `projection.timers.some(t => t.timerId === timerId)`，投影里有它就 200、没有就 404。
// 不再重启真后端也能把这条链验穿：那两条判据读的都是**这里折出来的同一份投影**。

test('端到端（生产接线）：布防 ⇒ 投影里看得见那一条（首页卡片）；撤销 ⇒ 投影里那条没了（按钮成功）', async () => {
  const dir = await tempDir('irmia-timer-e2e-');
  const file = join(dir, 'timers.json');
  const eventsDir = join(dir, 'events');
  const clock = createVirtualClock(1_800_000_000_000);
  let log: EventLog | null = null;
  try {
    log = await EventLog.open(eventsDir);
    const projection = emptyProjection();
    // 与 main.ts 逐字同形的接线：事件先落盘（sync）、再折投影
    const emit = (type: string, data: unknown, visibility?: Visibility): void => {
      const event = {
        seq: log?.nextSeq(),
        ts: clock.now().toISOString(),
        type,
        data,
        visibility: resolveEventVisibility(type, visibility),
        origin: 'test/timer-e2e',
      } as unknown as AppEvent;
      log?.append(event, { sync: true });
      applyOne(projection, event);
      finalizePressure(projection, event.ts);
    };
    const store = new TimerStore(file, virtualStoreDepsForTest(clock));
    store.setEventSink({
      set: (entry) => { emit('timer/set', entry, 'internal'); },
      cancelled: (timerId) => { emit('timer/cancelled', { timerId }, 'internal'); },
    });
    await store.load();
    store.start(() => { /* 本用例只看投影，不看到期 */ });

    // ── 首页卡片：`gui/lib/pages/overview_page.dart` 的 `_timers` 读 proj['timers'] ──
    assert.deepEqual(projection.timers, [], '接线前后：投影还是空的（撤销按钮此刻必然 404）');

    const at = new Date(clock.now().getTime() + 3_600_000).toISOString();
    const once = await store.set({ at, payload: { note: '到点提醒我看一眼昨天的账' } });
    const daily = await store.set({ cron: '0 9 * * *', payload: { kind: 'digest' } });
    assert.equal(once.ok && daily.ok, true);
    if (!once.ok || !daily.ok) return;

    // 一次性的那条：`_TimerLine` 要 `timerId` + `at` + `payload`（三格都在）
    const cardOnce = projection.timers.find((t) => t.timerId === once.id);
    assert.notEqual(cardOnce, undefined, '布防之后投影里就有它了（卡片的判据）');
    assert.equal(cardOnce?.at, store.list().find((e) => e.timerId === once.id)?.at);
    assert.deepEqual(cardOnce?.payload, { note: '到点提醒我看一眼昨天的账' },
      'payload 就是卡片上那句「要做什么」');
    assert.equal('cron' in (cardOnce ?? {}), false, '一次性那条不带 cron（界面据此显示时刻而不是"周期 …"）');

    // 周期的那条：`cron` 那一格在（界面显示「周期 0 9 * * *」）
    const cardDaily = projection.timers.find((t) => t.timerId === daily.id);
    assert.equal(cardDaily?.cron, '0 9 * * *');
    assert.notEqual(cardDaily?.at, undefined, '周期条也有下一次到期时刻（派生 nextWakeAt 用它）');
    assert.equal(projection.timers.length, 2, '卡片上「2 个在等」');

    // ── 撤销按钮：`web/server.ts` 的 timer-cancel 判据 ──
    // 真实那条路（`web/server.ts:6429`）自己写 `timer/cancelled` 再调 `store.cancel()`；
    // 这里走 `store.cancel()` 自己那一半——补了事件之后**它也会写**，所以 web 侧那条
    // 手写的事件不再是唯一的来源（同一形状、同一类型，`fold` 里同一条 case）。
    const known = projection.timers.some((t) => t.timerId === once.id);
    assert.equal(known, true, '投影里有它 ⇒ timer-cancel 不会 404（从前恒为 false ⇒ 恒 404）');
    assert.equal(await store.cancel(once.id), true);
    assert.equal(projection.timers.some((t) => t.timerId === once.id), false, '撤销后投影里那条没了');
    assert.equal(projection.timers.length, 1, '另一条不被牵连');
    assert.equal(
      (await readAllEvents(log)).filter((e) => e.type === 'timer/cancelled').length, 1,
      '撤销恰好一条 timer/cancelled（不是两条）',
    );
    assert.equal(
      projection.timers.some((t) => t.timerId === once.id), false,
      '再点一次就是 404（"可能已触发或已取消"——与 UI 的文案一致）',
    );

    // ── 重放：从盘上的事件流冷折叠出来的投影，与内存这份逐字段相同 ──
    const replay = fold(await readAllEvents(log));
    assert.deepEqual(replay.timers, projection.timers, '冷重放 == 内存投影（逐字段）');
    assert.deepEqual(projectionOfEntries(store.list()), replay.timers, '盘上的表 == 重放出来的表');

    store.stop();
    await store.flush();
  } finally {
    await log?.close();
    await removeTree(dir);
  }
});

// ──────────────────────────────── 常量护栏 ────────────────────────────────

test('MAX_TIMEOUT_MS 就是 2^31-1', () => {
  assert.equal(MAX_TIMEOUT_MS, 2 ** 31 - 1);
  assert.equal(new Date(MAX_TIMEOUT_MS).getTime() > 0, true);
});
