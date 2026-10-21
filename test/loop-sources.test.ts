/**
 * 唤醒源 + 假循环 + CLI 测试（milestones.md M1 交付物 7、README 快速验证）
 *
 * 覆盖面：
 *   - sources：看门文件拾取成 wake/manual 且原文件被删除、坏文件改名保留、定时器源写两条事件
 *   - loop：假循环认领与摘要、批次上限、投影缓存落盘（复用 projection-cache 信封）、水位推进
 *   - 衔接：启动恢复（runtime/recover.ts）退回的输入由假循环续号认领，turn 号不复用
 *   - cli：wake 写看门文件、status 报告字段（直接断言函数返回值，不 spawn 进程）
 *
 * 说明：Node 的类型剥离不做 `.js` → `.ts` 映射，所以这里用显式 `.ts` 说明符导入源码；
 * tsconfig 的 include 只有 src/，测试文件不参与 tsc，由 node --test 直接执行。
 */

import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { buildStatusReport, runCli, writeWakeNote, type CliIO } from '../src/cli.ts';
import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent, Projection } from '../src/log/types.ts';
import { advanceWatermark, FakeLoop, maxTurnOfLog } from '../src/runtime/loop.ts';
import { recover } from '../src/runtime/recover.ts';
import { PROJECTION_CACHE_VERSION } from '../src/state/projection-cache.ts';
import { ManualWatchSource, TimerWakeSource, WAKE_WATCH_DIR_NAME, wakeSourceOfType } from '../src/wake/sources.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

/** 固定基准时刻：事件内容可重复构造，断言才能逐字段比对 */
const EPOCH_MS = 1_780_000_000_000;
const EPOCH_ISO = new Date(EPOCH_MS).toISOString();

// ──────────────────────────────── 脚手架 ────────────────────────────────

interface Fixture {
  dataDir: string;
  eventsDir: string;
  watchDir: string;
  open: () => Promise<EventLog>;
}

function setup(t: TestContext): Fixture {
  const dataDir = tempDirSync('irmia-loop-');
  const logs: EventLog[] = [];
  t.after(() => {
    // Windows 下必须先关 fd 才能删目录
    for (const log of logs) {
      try {
        log.close();
      } catch {
        // 已关闭或已失效：清理阶段忽略
      }
    }
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  });
  return {
    dataDir,
    eventsDir: join(dataDir, 'events'),
    watchDir: join(dataDir, WAKE_WATCH_DIR_NAME),
    open: async () => {
      const log = await EventLog.open(join(dataDir, 'events'));
      logs.push(log);
      return log;
    },
  };
}

async function collect(log: EventLog): Promise<AppEvent[]> {
  const out: AppEvent[] = [];
  for await (const event of log.readAll()) out.push(event);
  return out;
}

function byType(events: readonly AppEvent[], type: string): AppEvent[] {
  return events.filter((event) => event.type === type);
}

function appendEvent(log: EventLog, seq: number, type: string, data: unknown, visibility: string): number {
  log.append({
    seq, ts: EPOCH_ISO, type, data, visibility,
  } as unknown as AppEvent, { sync: true });
  return seq;
}

/** 写一条唤醒事件，模拟唤醒源的产出 */
function appendWake(log: EventLog, type: string, data: unknown): number {
  return appendEvent(log, log.nextSeq(), type, data, 'model');
}

function collector(): { io: CliIO; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (line) => lines.push(line), err: (line) => lines.push(`ERR:${line}`) }, lines };
}

// ──────────────────────────────── sources ────────────────────────────────

test('看门文件被拾取成 wake/manual 且原文件被清理', async (t) => {
  const fx = setup(t);
  const log = await fx.open();
  const loop = new FakeLoop({ log, dataDir: fx.dataDir });
  const source = new ManualWatchSource(fx.watchDir, loop, { pollMs: 0, scanOnStart: false });
  assert.equal(source.name, 'manual');

  const path = writeWakeNote(fx.dataDir, { note: '写日报' }, new Date(EPOCH_MS));
  assert.ok(existsSync(path));
  assert.equal(source.scanOnce(), 1);
  assert.equal(existsSync(path), false, '事件落盘后源文件必须被删除');

  const events = await collect(log);
  const manual = byType(events, 'wake/manual');
  assert.equal(manual.length, 1);
  const data = manual[0]!.data as { note: string; dedupeKey?: string };
  assert.equal(data.note, '写日报');
  assert.equal(data.dedupeKey, undefined);
  assert.equal(manual[0]!.visibility, 'model');
  assert.equal(loop.pendingCount, 1);

  // 目录清空后再扫不会重复注入
  assert.equal(source.scanOnce(), 0);
  assert.equal((await collect(log)).length, 1);
  source.stop();
});

test('看门文件带 dedupeKey 时原样转进事件', async (t) => {
  const fx = setup(t);
  const log = await fx.open();
  const loop = new FakeLoop({ log, dataDir: fx.dataDir });
  const source = new ManualWatchSource(fx.watchDir, loop, { pollMs: 0, scanOnStart: false });

  writeWakeNote(fx.dataDir, { note: '复盘', dedupeKey: 'review-2026-09-29' }, new Date(EPOCH_MS));
  assert.equal(source.scanOnce(), 1);

  const manual = byType(await collect(log), 'wake/manual');
  const data = manual[0]!.data as { note: string; dedupeKey?: string };
  assert.equal(data.dedupeKey, 'review-2026-09-29');
  assert.equal(loop.projection.pending[0]!.dedupeKey, 'review-2026-09-29');
  source.stop();
});

test('同一毫秒连续注入不覆盖既有看门文件', async (t) => {
  const fx = setup(t);
  const now = new Date(EPOCH_MS);
  const first = writeWakeNote(fx.dataDir, { note: 'a' }, now);
  const second = writeWakeNote(fx.dataDir, { note: 'b' }, now);
  assert.notEqual(first, second);
  assert.equal(readdirSync(fx.watchDir).length, 2);
  assert.equal(JSON.parse(readFileSync(first, 'utf8')).note, 'a');
  assert.equal(JSON.parse(readFileSync(second, 'utf8')).note, 'b');
});

test('非法看门文件改名为 .bad 保留，不写事件也不抛错', async (t) => {
  const fx = setup(t);
  const log = await fx.open();
  const loop = new FakeLoop({ log, dataDir: fx.dataDir });
  const source = new ManualWatchSource(fx.watchDir, loop, { pollMs: 0, scanOnStart: false });

  mkdirSync(fx.watchDir, { recursive: true });
  const badPath = join(fx.watchDir, 'wake-1780000000123.json');
  writeFileSync(badPath, '{ 这不是 JSON');

  assert.equal(source.scanOnce(), 0);
  assert.equal(existsSync(badPath), false);
  assert.ok(existsSync(`${badPath}.bad`), '坏文件必须留证据，不能静默删除');
  assert.equal((await collect(log)).length, 0);
  assert.equal(source.warnings().length, 1);
  source.stop();
});

test('定时器到期转成 timer/fired（internal）+ wake/timer（model）', async (t) => {
  const fx = setup(t);
  const log = await fx.open();
  const loop = new FakeLoop({ log, dataDir: fx.dataDir });
  const store = new TimerStore(join(fx.dataDir, 'timers.json'));
  const firedAt = new Date('2026-09-29T14:00:00.000Z');
  const source = new TimerWakeSource(store, loop, () => firedAt);
  assert.equal(source.name, 'timer');

  // at 落在过去：start() 的补触发路径同步结算，测试不需要等真实时间
  const created = await store.set({ at: '2026-09-29T13:59:00.000Z', payload: { note: 'x' } });
  assert.equal(created.ok, true);
  const timerId = created.ok ? created.id : '';
  source.start();

  let events = await collect(log);
  assert.deepEqual(events.map((event) => event.type), ['timer/fired', 'wake/timer']);
  assert.equal(events[0]!.visibility, 'internal');
  assert.equal((events[0]!.data as { timerId: string }).timerId, timerId);
  assert.equal(events[1]!.visibility, 'model');
  const wake = events[1]!.data as { timerId: string; scheduledAt: string; firedAt: string };
  assert.equal(wake.timerId, timerId);
  assert.equal(wake.scheduledAt, '2026-09-29T13:59:00.000Z', 'scheduledAt 取条目到期时刻而不是 now');
  assert.equal(wake.firedAt, firedAt.toISOString());
  assert.equal(loop.pendingCount, 1);

  // emitDue 走同一条落库路径：入口层用它补记恢复期被静默结算的那一条
  source.emitDue('t_补记', '2026-09-29T13:00:00.000Z');
  events = await collect(log);
  assert.deepEqual(events.map((event) => event.type), ['timer/fired', 'wake/timer', 'timer/fired', 'wake/timer']);
  assert.equal((events[3]!.data as { scheduledAt: string }).scheduledAt, '2026-09-29T13:00:00.000Z');
  assert.equal(loop.pendingCount, 2);

  source.stop();
  await store.flush();
});

test('wakeSourceOfType 只认唤醒事件', () => {
  assert.equal(wakeSourceOfType('wake/manual'), 'manual');
  assert.equal(wakeSourceOfType('wake/timer'), 'timer');
  assert.equal(wakeSourceOfType('message/user'), null);
  assert.equal(wakeSourceOfType('timer/fired'), null);
});

test('at 型定时器的 payload 跟着 wake/timer 事件走（触发后条目已删，查表拿不到）', async (t) => {
  // 一次实测事故的锁：`/dream` 排的那条唤醒跑成了普通 turn。根因是认领方只查表拿 payload，
  // 而 **at 型定时器一触发就从表里删掉** —— 查表必然 null。cron 型条目触发后保留，
  // 所以这个洞只在一次性定时器上现形，而一次性正是最常用的那种：她自己 `timer`（action=set）布的
  // "到点提醒我做什么"同样是这句话一个字都留不下，而工具描述里明写着 payload 会给她看。
  const fx = setup(t);
  const log = await fx.open();
  const loop = new FakeLoop({ log, dataDir: fx.dataDir });
  const store = new TimerStore(join(fx.dataDir, 'timers.json'));
  const firedAt = new Date('2026-09-29T14:00:00.000Z');
  const source = new TimerWakeSource(store, loop, () => firedAt);

  const created = await store.set({
    at: '2026-09-29T13:59:00.000Z',
    payload: { kind: 'memory-maintain', by: 'human', via: 'dream' },
  });
  assert.equal(created.ok, true);
  const timerId = created.ok ? created.id : '';
  source.start();

  const events = await collect(log);
  const wake = events[1]!.data as { timerId: string; payload?: unknown };
  assert.deepEqual(
    wake.payload,
    { kind: 'memory-maintain', by: 'human', via: 'dream' },
    'payload 必须随事件带出来——at 型条目这时已经不在表里了',
  );
  assert.equal(store.get(timerId), null, '这正是必须靠事件带 payload 的原因：条目已删');
  assert.equal(loop.pendingCount, 1);

  source.stop();
  await store.flush();
});

test('wakeSourceOfType 只认唤醒事件', () => {
  assert.equal(wakeSourceOfType('wake/manual'), 'manual');
  assert.equal(wakeSourceOfType('wake/timer'), 'timer');
  assert.equal(wakeSourceOfType('message/user'), null);
  assert.equal(wakeSourceOfType('timer/fired'), null);
});

// ──────────────────────────────── 假循环 ────────────────────────────────

test('假循环把待办批量写成 input/claimed + message/user 并闭合 turn', async (t) => {
  const fx = setup(t);
  const log = await fx.open();
  const wakeManual = appendWake(log, 'wake/manual', { note: '看看博客' });
  const wakeTimer = appendWake(log, 'wake/timer', {
    timerId: 't_1', scheduledAt: EPOCH_ISO, firedAt: EPOCH_ISO,
  });

  const loop = new FakeLoop({ log, dataDir: fx.dataDir, now: () => new Date(EPOCH_MS) });
  assert.equal(loop.pollTail(), 2, '日志尾部的新事件都要折进投影');
  assert.equal(loop.pendingCount, 2);

  assert.equal(await loop.runOnce(), 4, '一拍写 turn/start + input/claimed + message/user + turn/end');
  assert.equal(loop.pendingCount, 0);
  assert.equal(loop.projection.openTurn, null, 'turn 必须闭合');

  const events = await collect(log);
  const claimed = byType(events, 'input/claimed');
  assert.equal(claimed.length, 1);
  const claimData = claimed[0]!.data as { turn: number; wakeSeqs: number[]; claimCounts: number[] };
  assert.deepEqual(claimData.wakeSeqs, [wakeManual, wakeTimer]);
  assert.deepEqual(claimData.claimCounts, [0, 0]);
  assert.equal(claimed[0]!.visibility, 'internal');

  const message = byType(events, 'message/user');
  assert.equal(message.length, 1);
  const messageData = message[0]!.data as { text: string; source: string };
  assert.match(messageData.text, /^2 条待办（manual×1、timer×1）：手动注入：看看博客$/);
  assert.equal(messageData.source, 'human', '批次以最早一条输入的来源定性，manual 映射为 human');
  assert.equal(message[0]!.visibility, 'model');

  const end = byType(events, 'turn/end');
  assert.equal(end.length, 1);
  const endData = end[0]!.data as { turn: number; reason: { kind: string }; spoke: boolean };
  assert.equal(endData.turn, 1);
  assert.deepEqual(endData.reason, { kind: 'completed' });
  assert.equal(endData.spoke, false, 'M1 不调模型，不算发言');

  assert.ok(existsSync(join(fx.dataDir, 'projection.json')), '有变化就落投影缓存');

  // 已消化的输入不会被二次认领
  assert.equal(await loop.runOnce(), 0);
  assert.equal(loop.lastTurn, 1);
});

test('假循环按批次上限分批认领', async (t) => {
  const fx = setup(t);
  const log = await fx.open();
  for (let i = 0; i < 3; i++) appendWake(log, 'wake/manual', { note: `n${i}` });

  const loop = new FakeLoop({ log, dataDir: fx.dataDir, batchLimit: 2, now: () => new Date(EPOCH_MS) });
  loop.pollTail();
  assert.equal(await loop.runOnce(), 4);
  assert.equal(loop.pendingCount, 1, '超出一批的先留在队列里');

  assert.equal(await loop.runOnce(), 4);
  assert.equal(loop.pendingCount, 0);
  assert.equal(loop.lastTurn, 2);

  const claimed = byType(await collect(log), 'input/claimed');
  const first = claimed[0]!.data as { wakeSeqs: number[] };
  const second = claimed[1]!.data as { wakeSeqs: number[] };
  assert.equal(first.wakeSeqs.length, 2);
  assert.equal(second.wakeSeqs.length, 1);
});

test('投影缓存走 projection-cache 信封，带 version/lastSeq/state', async (t) => {
  const fx = setup(t);
  const log = await fx.open();
  const loop = new FakeLoop({ log, dataDir: fx.dataDir, now: () => new Date(EPOCH_MS) });
  await loop.writeProjectionCache();

  const empty = JSON.parse(readFileSync(join(fx.dataDir, 'projection.json'), 'utf8'));
  // 版本读常量而不是写死数字：口径一变（`PROJECTION_CACHE_VERSION` 与 `SNAPSHOT_VERSION`
  // 一起抬，见 state/projection-cache.ts 的文件头）这条就不该再红——它要钉的是
  // "落盘走的是同一套信封"，而不是那个数字本身
  assert.equal(empty.version, PROJECTION_CACHE_VERSION);
  assert.equal(empty.lastSeq, 0);
  assert.equal(empty.state.watermark, 0);

  appendWake(log, 'wake/manual', { note: 'x' });
  await loop.runOnce();
  const filled = JSON.parse(readFileSync(join(fx.dataDir, 'projection.json'), 'utf8'));
  assert.equal(filled.lastSeq, 5);
  assert.equal((filled.state as Projection).pending.length, 0);
  assert.equal(filled.state.watermark, 5);
});

// ──────────────────────────────── 水位 ────────────────────────────────

test('水位：有未消化输入时停在它之前，空洞不阻塞推进', async (t) => {
  const fx = setup(t);
  const log = await fx.open();
  // 故意留出 2/3/4 三个空洞（崩溃留下的缺号）：先把分配器推过去再写 seq 5
  appendEvent(log, 1, 'wake/manual', { note: 'a' }, 'model');
  for (let i = 0; i < 5; i++) log.nextSeq();
  appendEvent(log, 5, 'wake/manual', { note: 'b' }, 'model');

  const loop = new FakeLoop({ log, dataDir: fx.dataDir, now: () => new Date(EPOCH_MS) });
  loop.pollTail();
  assert.equal(loop.pendingCount, 2);

  assert.equal(advanceWatermark(log, loop.projection), 0, '待办未消化，水位不许越过它');

  loop.drainPending();
  assert.equal(loop.projection.lastSeq, 9, '认领后又写了 4 条事件（seq 6..9）');
  assert.equal(advanceWatermark(log, loop.projection), 9, '消化完毕后水位推到末尾，跨过 2/3/4 的空洞');

  // 水位只增不减：再调一次不会回退
  assert.equal(advanceWatermark(log, loop.projection), 9);
});

test('maxTurnOfLog 取日志里最大的 turn 号，供假循环续号', async (t) => {
  const fx = setup(t);
  const log = await fx.open();
  assert.equal(await maxTurnOfLog(log), 0);
  appendEvent(log, 1, 'turn/start', { turn: 3 }, 'internal');
  appendEvent(log, 2, 'turn/end', { turn: 3, reason: { kind: 'completed' }, spoke: false }, 'internal');
  assert.equal(await maxTurnOfLog(log), 3);
});

// ──────────────────────────────── 与恢复流程衔接 ────────────────────────────────

test('衔接：恢复退回的输入由假循环续号认领，旧 turn 号不被复用', async (t) => {
  const fx = setup(t);
  const log = await fx.open();
  appendWake(log, 'wake/manual', { note: '崩溃前的输入' });
  appendEvent(log, 2, 'turn/start', { turn: 1 }, 'internal');
  appendEvent(log, 3, 'input/claimed', { turn: 1, wakeSeqs: [1], claimCounts: [0] }, 'internal');
  log.close(); // 模拟崩溃：turn 没闭合

  const recovery = await recover({ dataDir: fx.dataDir });
  t.after(() => {
    recovery.lock.release();
  });
  assert.equal(recovery.projection.openTurn, null);
  assert.equal(recovery.projection.pending.length, 1);
  assert.equal(recovery.projection.pending[0]!.claimCount, 1, '退回时认领次数 +1');

  const startTurn = await maxTurnOfLog(recovery.log);
  assert.equal(startTurn, 1);

  const loop = new FakeLoop({
    log: recovery.log,
    dataDir: fx.dataDir,
    startTurn,
    projection: recovery.projection,
    now: () => new Date(EPOCH_MS),
  });
  assert.equal(await loop.runOnce(), 4);
  assert.equal(loop.pendingCount, 0);
  assert.equal(loop.lastTurn, 2, '新 turn 必须续在崩溃前那条之后');

  const events = await collect(recovery.log);
  const requeued = byType(events, 'input/requeued');
  assert.equal(requeued.length, 1);
  const message = byType(events, 'message/user')[0]!;
  assert.match((message.data as { text: string }).text, /手动注入：崩溃前的输入/);
  const end = byType(events, 'turn/end');
  assert.deepEqual((end[0]!.data as { reason: { kind: string } }).reason, { kind: 'interrupted' });
  assert.equal((end[1]!.data as { turn: number }).turn, 2);

  recovery.log.close();
});

// ──────────────────────────────── CLI ────────────────────────────────

test('cli wake 写看门文件，缺参数与未知命令返回退出码 2', async (t) => {
  const fx = setup(t);
  const { io, lines } = collector();

  assert.equal(await runCli(['wake', '--note', '看日志'], io, { dataDir: fx.dataDir }), 0);
  const files = readdirSync(fx.watchDir);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^wake-\d+\.json$/);
  assert.equal(JSON.parse(readFileSync(join(fx.watchDir, files[0]!), 'utf8')).note, '看日志');

  assert.equal(await runCli(['wake'], io, { dataDir: fx.dataDir }), 2);
  assert.equal(await runCli(['wake', '--note'], io, { dataDir: fx.dataDir }), 2);
  assert.equal(await runCli(['nope'], io, { dataDir: fx.dataDir }), 2);
  assert.equal(await runCli(['--help'], io, { dataDir: fx.dataDir }), 0);
  assert.ok(lines.some((line) => line.includes('wake --note')));
});

test('cli status 报告水位/待办/定时器/锁，缓存缺失也给出权威值', async (t) => {
  const fx = setup(t);
  const log = await fx.open();
  appendWake(log, 'wake/manual', { note: 'x' });
  appendEvent(log, 2, 'timer/set', { timerId: 't_1', at: '2026-09-29T15:00:00.000Z', payload: null }, 'internal');
  log.close();

  const report = await buildStatusReport(fx.dataDir);
  assert.equal(report.events.maxSeq, 2);
  assert.equal(report.events.shards, 1);
  assert.equal(report.events.badLines, 0);
  assert.equal(report.cache.state, 'missing');
  assert.equal(report.watermark, 0);
  assert.equal(report.pending.total, 1);
  assert.deepEqual(report.pending.bySource, { manual: 1 });
  assert.equal(report.openTurn, null);
  assert.equal(report.timers.total, 1);
  assert.equal(report.timers.nextAt, '2026-09-29T15:00:00.000Z');
  assert.equal(report.lock.present, false);
  assert.equal(report.lock.alive, null);

  const { io, lines } = collector();
  assert.equal(await runCli(['status'], io, { dataDir: fx.dataDir }), 0);
  assert.ok(lines.some((line) => line.includes('水位: 0')), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes('待办 1（manual×1）')), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes('锁: 未持有')), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes('最近到期 2026-09-29T15:00:00.000Z')), lines.join('\n'));

  const { io: jsonIo, lines: jsonLines } = collector();
  assert.equal(await runCli(['status', '--json'], jsonIo, { dataDir: fx.dataDir }), 0);
  const parsed = JSON.parse(jsonLines.join('\n')) as { watermark: number; pending: { total: number } };
  assert.equal(parsed.watermark, 0);
  assert.equal(parsed.pending.total, 1);
});

test('端到端：cli 注入 → 看门源拾取 → 假循环认领 → status 可见', async (t) => {
  const fx = setup(t);
  const log = await fx.open();
  const loop = new FakeLoop({ log, dataDir: fx.dataDir, now: () => new Date(EPOCH_MS) });
  const source = new ManualWatchSource(fx.watchDir, loop, { pollMs: 0, scanOnStart: false });
  const { io } = collector();

  assert.equal(await runCli(['wake', '--note', '端到端'], io, { dataDir: fx.dataDir }), 0);
  assert.equal(source.scanOnce(), 1);
  assert.equal(await loop.runOnce(), 4);

  const report = await buildStatusReport(fx.dataDir);
  assert.equal(report.pending.total, 0);
  assert.equal(report.watermark, report.events.maxSeq);
  assert.equal(report.cache.state, 'hit', '循环已经把投影落进缓存，且 lastSeq 与日志末尾一致');

  const message = byType(await collect(log), 'message/user')[0]!;
  assert.match((message.data as { text: string }).text, /手动注入：端到端/);
  source.stop();
});
