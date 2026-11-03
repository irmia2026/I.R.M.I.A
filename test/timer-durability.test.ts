import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { EventLog } from '../src/log/event-log.ts';
import { emptyProjection, type AppEvent } from '../src/log/types.ts';
import { applyOne, fold } from '../src/state/fold.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

test('取消事实写失败必须拒绝并保留任务，重试成功后重启不再触发', async (t) => {
  const dir = tempDirSync('irmia-timer-durability-');
  const hint = join(dir, 'timers.json');
  const log = await EventLog.open(join(dir, 'events'));
  const projection = emptyProjection();
  const now = Date.parse('2026-10-30T00:00:00.000Z');
  const handles = new Map<number, () => void>();
  let next = 0;
  const deps = {
    now: () => new Date(now),
    setTimeout: (handler: () => void) => { handles.set(++next, handler); return next; },
    clearTimeout: (handle: unknown) => { handles.delete(handle as number); },
  };
  const store = new TimerStore(hint, deps);
  const restored = new TimerStore(hint, deps);
  const realWrite = fs.writeSync;
  t.after(async () => {
    fs.writeSync = realWrite; syncBuiltinESMExports();
    store.stop(); restored.stop(); await store.flush(); await restored.flush(); log.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const emit = (type: string, data: unknown): void => {
    const entry = { seq: log.nextSeq(), ts: new Date(now).toISOString(), type, data, visibility: 'internal' } as AppEvent;
    log.append(entry, { sync: true }); applyOne(projection, entry);
  };
  store.setEventSink({set: entry => emit('timer/set', entry), cancelled: timerId => emit('timer/cancelled', {timerId})});
  store.start(() => assert.fail('synthetic clock has not fired'));
  const created = await store.set({at: new Date(now + 60_000).toISOString(), payload: {note: 'synthetic'}});
  assert.equal(created.ok, true); if (!created.ok) return;
  fs.writeSync = function(fd, buffer, ...args) {
    if (Buffer.isBuffer(buffer) && buffer.toString().includes('"type":"timer/cancelled"')) throw new Error('synthetic cancellation EIO');
    return realWrite(fd, buffer, ...args);
  } as typeof fs.writeSync;
  syncBuiltinESMExports();
  try { await assert.rejects(store.cancel(created.id), /synthetic cancellation EIO/); }
  finally { fs.writeSync = realWrite; syncBuiltinESMExports(); }
  assert.equal(store.get(created.id)?.timerId, created.id);
  assert.equal(store.armedCount(), 1);
  assert.equal(projection.timers.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(hint, 'utf8')).entries.length, 1);
  assert.equal(log.bufferedCount, 0);
  assert.equal(await store.cancel(created.id), true);
  assert.equal(projection.timers.length, 0);
  assert.equal(store.armedCount(), 0);
  const events: AppEvent[] = [];
  for await (const entry of log.readAll()) events.push(entry);
  assert.deepEqual(events.map(entry => entry.type), ['timer/set', 'timer/cancelled']);
  store.stop();
  await restored.load();
  await restored.importEntries(fold(events).timers);
  let fired = 0;
  restored.start(() => { fired++; });
  assert.deepEqual(restored.list(), []);
  for (const handler of [...handles.values()]) handler();
  assert.equal(fired, 0);
});

test('创建事件写失败不布防；立即到期任务也先记录 set 再回调', async () => {
  const now = Date.parse('2026-10-30T00:00:00.000Z');
  const store = new TimerStore(null, { now: () => new Date(now) });
  let fired = 0;
  store.start(() => { fired++; });
  store.setEventSink({set: () => { throw new Error('synthetic set failure'); }, cancelled: () => {}});
  await assert.rejects(store.set({at: new Date(now).toISOString()}), /synthetic set failure/);
  assert.deepEqual(store.list(), []);
  assert.equal(store.armedCount(), 0);
  assert.equal(fired, 0);
  const order: string[] = [];
  store.setEventSink({set: () => { order.push('set'); }, cancelled: () => {}});
  store.stop(); store.start(() => { order.push('due'); });
  try {
    assert.equal((await store.set({at: new Date(now).toISOString()})).ok, true);
    assert.deepEqual(order, ['set', 'due']);
  } finally { store.stop(); await store.flush(); }
});

test('cron 后台推进写事件失败只留告警并停止重新布防', async () => {
  let now = Date.parse('2026-10-30T00:00:00.000Z');
  let next = 0, fired = 0, fail = false;
  const handles = new Map<number, () => void>();
  const store = new TimerStore(null, {now: () => new Date(now),
    setTimeout: handler => { handles.set(++next, handler); return next; },
    clearTimeout: handle => { handles.delete(handle as number); }});
  store.setEventSink({set: () => { if (fail) throw new Error('synthetic cron event EIO'); }, cancelled: () => {}});
  store.start(() => { fired++; });
  try {
    assert.equal((await store.set({cron: '* * * * *'})).ok, true);
    assert.equal(store.armedCount(), 1);
    fail = true; now += 60_000;
    const handler = [...handles.values()][0]!; handles.clear();
    assert.doesNotThrow(handler);
    assert.equal(fired, 1);
    assert.equal(store.armedCount(), 0);
    assert.ok(store.warnings().some(warning => warning.includes('synthetic cron event EIO')));
    await store.flush();
  } finally { store.stop(); }
});
