import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent } from '../src/log/types.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const event = (seq: number): AppEvent => ({
  seq, ts: '2026-10-30T00:00:00.000Z', type: 'message/user',
  data: { text: 'synthetic', source: 'human' }, visibility: 'model',
} as AppEvent);
const realWrite = fs.writeSync;
const realSync = fs.fsyncSync;
const realTruncate = fs.ftruncateSync;
function restore(): void {
  fs.writeSync = realWrite; fs.fsyncSync = realSync; fs.ftruncateSync = realTruncate;
  syncBuiltinESMExports();
}
async function sequences(log: EventLog): Promise<number[]> {
  const out: number[] = [];
  for await (const entry of log.readAll()) out.push(entry.seq);
  return out;
}
function disk(dir: string): number[] {
  return fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort()
    .flatMap(name => fs.readFileSync(join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).seq));
}

test('刷新中途写失败保留未写后缀，重试没有丢失或重复', async (t) => {
  const dir = tempDirSync('irmia-log-retry-');
  const log = await EventLog.open(dir, { indexStride: 1 });
  t.after(() => { restore(); log.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let seq = 1; seq <= 3; seq++) log.append(event(log.nextSeq()), { sync: false });
  fs.writeSync = function(fd, buffer, ...args) {
    if (Buffer.isBuffer(buffer) && buffer.toString().startsWith('{"seq":2,')) throw new Error('synthetic EIO');
    return realWrite(fd, buffer, ...args);
  } as typeof fs.writeSync;
  syncBuiltinESMExports();
  assert.throws(() => log.flush(), /synthetic EIO/);
  restore();
  assert.equal(log.bufferedCount, 2);
  assert.deepEqual(disk(dir), [1]);
  log.append(event(log.nextSeq()), { sync: true });
  assert.deepEqual(await sequences(log), [1, 2, 3, 4]);
  assert.deepEqual(disk(dir), [1, 2, 3, 4]);
  assert.equal(log.bufferedCount, 0);
});

test('fsync 失败可靠回滚后，后续同步成功的事件可以检索并重放', async (t) => {
  const dir = tempDirSync('irmia-log-sync-');
  const log = await EventLog.open(dir, { indexStride: 1 });
  t.after(() => { restore(); log.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  log.append(event(log.nextSeq()), { sync: true });
  let first = true;
  fs.fsyncSync = (fd) => { if (first) { first = false; throw new Error('synthetic fsync EIO'); } realSync(fd); };
  syncBuiltinESMExports();
  assert.throws(() => log.append(event(log.nextSeq()), { sync: true }), /synthetic fsync EIO/);
  restore();
  log.append(event(log.nextSeq()), { sync: true });
  assert.deepEqual(disk(dir), [1, 3]);
  assert.deepEqual(await sequences(log), [1, 3]);
  assert.equal(log.get(2), null);
  assert.equal(log.get(3)?.seq, 3);
  const range: number[] = [];
  for await (const entry of log.readRange(2)) range.push(entry.seq);
  assert.deepEqual(range, [3]);
  log.close();
  const reopened = await EventLog.open(dir);
  try { assert.deepEqual(await sequences(reopened), [1, 3]); } finally { reopened.close(); }
});

test('同步及回滚同步都失败后冻结写者，关闭仍释放句柄', async (t) => {
  const dir = tempDirSync('irmia-log-failed-');
  const log = await EventLog.open(dir);
  t.after(() => { restore(); try { log.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  log.append(event(log.nextSeq()), { sync: true });
  fs.fsyncSync = () => { throw new Error('synthetic persistent sync EIO'); };
  syncBuiltinESMExports();
  assert.throws(() => log.append(event(log.nextSeq()), { sync: true }), /回滚也失败/);
  restore();
  assert.throws(() => log.nextSeq(), /已停止写入/);
  assert.throws(() => log.flush(), /已停止写入/);
  assert.throws(() => log.append(event(3), { sync: true }), /已停止写入/);
  assert.throws(() => log.close(), /已停止写入/);
  assert.deepEqual(disk(dir), [1]);
  const reopened = await EventLog.open(dir);
  try {
    reopened.append(event(reopened.nextSeq()), { sync: true });
    assert.deepEqual(await sequences(reopened), [1, 2]);
  } finally { reopened.close(); }
});

test('部分写入且回滚失败时禁止继续接行，重开日志修复尾行', async (t) => {
  const dir = tempDirSync('irmia-log-partial-');
  const log = await EventLog.open(dir);
  t.after(() => { restore(); try { log.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  log.append(event(log.nextSeq()), { sync: true });
  let calls = 0;
  fs.writeSync = function(fd, buffer, offset, length, position) {
    if (++calls === 1) return realWrite(fd, buffer, offset, 9, position);
    throw new Error('synthetic partial EIO');
  } as typeof fs.writeSync;
  fs.ftruncateSync = () => { throw new Error('synthetic rollback EIO'); };
  syncBuiltinESMExports();
  assert.throws(() => log.append(event(log.nextSeq()), { sync: true }), /回滚也失败/);
  restore();
  assert.throws(() => log.append(event(3), { sync: true }), /已停止写入/);
  assert.throws(() => log.close(), /已停止写入/);
  const reopened = await EventLog.open(dir);
  try {
    assert.ok(reopened.repair);
    assert.deepEqual(await sequences(reopened), [1]);
  } finally { reopened.close(); }
});

for (const rotated of [false, true]) {
  test(`${rotated ? '轮转' : '首次'}空片首条同步失败后跳过 seq，成功事件仍可重开`, async (t) => {
    const dir = tempDirSync('irmia-log-empty-');
    const log = await EventLog.open(dir, {shardMaxBytes: 1});
    t.after(() => { restore(); log.close(); fs.rmSync(dir, {recursive: true, force: true}); });
    if (rotated) log.append(event(log.nextSeq()), {sync: true});
    let first = true;
    fs.fsyncSync = fd => { if (first) { first = false; throw new Error('synthetic first sync EIO'); } realSync(fd); };
    syncBuiltinESMExports();
    assert.throws(() => log.append(event(log.nextSeq()), {sync: true}), /synthetic first sync EIO/);
    restore();
    const next = log.nextSeq();
    log.append(event(next), {sync: true});
    const expected = rotated ? [1, 3] : [2];
    assert.deepEqual(await sequences(log), expected);
    log.close();
    const reopened = await EventLog.open(dir);
    try {
      assert.deepEqual(await sequences(reopened), expected);
      assert.equal(reopened.get(next)?.seq, next);
      assert.equal(reopened.shardFiles.length, expected.length);
    } finally { reopened.close(); }
  });
}
