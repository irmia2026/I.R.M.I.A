/**
 * 单实例锁测试（src/runtime/instance-lock.ts）
 * 覆盖：排他、并发原子性、PID 复用、接管宽限期、心跳刷新、自检夺锁、release 语义。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  acquireInstanceLock,
  LockHeldError,
  LOCK_FILE_NAME,
  toInstanceTakeoverData,
  type AcquireOptions,
  type LockRecord,
  type StolenInfo,
  type TakeoverRecord,
} from '../src/runtime/instance-lock.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

/** 实测在 Windows 上对不存在的 pid 抛 ESRCH 的取值 */
const DEAD_PID = 2147483646;
/** 心跳陈旧场景里代表"存活但无响应的外部持有者"的假 pid */
const FAKE_LIVE_PID = 4242;

const SILENT: AcquireOptions = { log: () => {} };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeDir(t: TestContext): string {
  const dir = tempDirSync('irmia-lock-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function lockPath(dir: string): string {
  return join(dir, LOCK_FILE_NAME);
}

function readLock(dir: string): LockRecord {
  return JSON.parse(readFileSync(lockPath(dir), 'utf8')) as LockRecord;
}

function writeLock(dir: string, record: LockRecord): void {
  writeFileSync(lockPath(dir), JSON.stringify(record, null, 2));
}

/**
 * 本次开机时刻，用于构造"开机之后启动"的 startedAt。
 * 必须用 os.uptime()：process.uptime() 是本进程存活时长，两者基准点不同——
 * 用错会让 startedAt 落在开机之后（开机满 24h 后该用例必挂），与 src 的启动时间判据错位。
 */
function bootTimeMs(): number {
  return Date.now() - uptime() * 1000;
}

function alivePid(): boolean {
  try {
    process.kill(DEAD_PID, 0);
    return true;
  } catch {
    return false;
  }
}

test('首次 acquire 拿到锁，锁文件三字段完整', async (t) => {
  const dir = makeDir(t);
  const lock = await acquireInstanceLock(dir, SILENT);
  t.after(() => lock.release());

  assert.equal(lock.owns, true);
  assert.equal(lock.file, lockPath(dir));
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.verify(), true);

  const record = readLock(dir);
  assert.equal(record.pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(record.startedAt)));
  assert.ok(Number.isFinite(Date.parse(record.heartbeatAt)));
});

test('同一 dataDir 第二次 acquire 抛 LockHeldError', async (t) => {
  const dir = makeDir(t);
  const first = await acquireInstanceLock(dir, SILENT);
  t.after(() => first.release());

  await assert.rejects(
    () => acquireInstanceLock(dir, SILENT),
    (err: unknown) => {
      assert.ok(err instanceof LockHeldError);
      assert.equal(err.holder.pid, process.pid);
      assert.equal(err.file, lockPath(dir));
      return true;
    },
  );

  // 被拒绝的过程不得破坏现有锁
  assert.equal(readLock(dir).pid, process.pid);
  assert.equal(first.verify(), true);
});

test('并发 acquire 只有一个成功', async (t) => {
  const dir = makeDir(t);
  const results = await Promise.allSettled([
    acquireInstanceLock(dir, SILENT),
    acquireInstanceLock(dir, SILENT),
  ]);
  for (const r of results) {
    if (r.status === 'fulfilled') t.after(() => r.value.release());
  }

  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  assert.ok((failed[0] as PromiseRejectedResult).reason instanceof LockHeldError);
});

test('手工删除锁文件后可重新 acquire，且旧句柄不会误删新锁', async (t) => {
  const dir = makeDir(t);
  const first = await acquireInstanceLock(dir, SILENT);
  t.after(() => first.release());

  unlinkSync(lockPath(dir));
  assert.equal(first.verify(), false);

  // 模块身份 = (pid, startedAt)。这里用注入 pid 表示"另一个进程"抢到了锁：
  // 锁文件已不存在，走排他创建路径，不触碰探活，该 pid 无需真实存在。
  // （同进程同 pid 的重复 acquire 在真实路径上会被 LockHeldError 挡掉，不会产生重叠句柄。）
  const second = await acquireInstanceLock(dir, { log: () => {}, pid: FAKE_LIVE_PID });
  const recordBefore = readLock(dir);
  assert.equal(recordBefore.pid, FAKE_LIVE_PID);

  // 旧持有者此刻才释放：锁已属于 second，first 不得到删
  first.release();
  assert.equal(existsSync(lockPath(dir)), true);
  assert.deepEqual(readLock(dir), recordBefore);

  second.release();
  assert.equal(existsSync(lockPath(dir)), false);
});

test('心跳陈旧且 pid 不存在时立即接管（staleBecause: pid-gone）', async (t) => {
  assert.equal(alivePid(), false, '前提：DEAD_PID 探活失败');

  const dir = makeDir(t);
  const stale = new Date(Date.now() - 3_600_000).toISOString();
  writeLock(dir, { pid: DEAD_PID, startedAt: stale, heartbeatAt: stale });

  const takeovers: TakeoverRecord[] = [];
  const sleeps: number[] = [];
  const lock = await acquireInstanceLock(dir, {
    log: () => {},
    takeoverGraceMs: 60_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onTakeover: (r) => takeovers.push(r),
  } as AcquireOptions);
  t.after(() => lock.release());

  // pid 已消失是确定性判据，不该消耗宽限期
  assert.deepEqual(sleeps, []);
  assert.equal(takeovers.length, 1);
  assert.equal(takeovers[0]?.staleBecause, 'pid-gone');
  assert.equal(takeovers[0]?.previousPid, DEAD_PID);
  assert.equal(takeovers[0]?.previousHeartbeatAt, stale);
  assert.equal(readLock(dir).pid, process.pid);
  assert.equal(lock.verify(), true);
});

test('pid 存活但 startedAt 早于开机时间判定为复用，心跳新鲜也不放过', async (t) => {
  const dir = makeDir(t);
  // 心跳是"现在"，只有 startedAt 落在开机之前——纯心跳方案会认为锁健康
  writeLock(dir, {
    pid: process.pid,
    startedAt: new Date(bootTimeMs() - 86_400_000).toISOString(),
    heartbeatAt: new Date().toISOString(),
  });

  const takeovers: TakeoverRecord[] = [];
  const sleeps: number[] = [];
  const lock = await acquireInstanceLock(dir, {
    log: () => {},
    takeoverGraceMs: 60_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onTakeover: (r) => takeovers.push(r),
  });
  t.after(() => lock.release());

  assert.deepEqual(sleeps, []);
  assert.equal(takeovers.length, 1);
  assert.equal(takeovers[0]?.staleBecause, 'pid-reused');
  assert.equal(lock.verify(), true);
});

test('心跳陈旧且 pid 存活：宽限期后仍陈旧才接管（stale-heartbeat）', async (t) => {
  const dir = makeDir(t);
  const startedAt = new Date(bootTimeMs() + 60_000).toISOString();
  writeLock(dir, { pid: FAKE_LIVE_PID, startedAt, heartbeatAt: new Date(Date.now() - 600_000).toISOString() });

  const takeovers: TakeoverRecord[] = [];
  const sleeps: number[] = [];
  const lock = await acquireInstanceLock(dir, {
    log: () => {},
    isPidAlive: () => true,
    staleHeartbeatMs: 1_000,
    takeoverGraceMs: 30,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onTakeover: (r) => takeovers.push(r),
  });
  t.after(() => lock.release());

  assert.deepEqual(sleeps, [30], '宽限期必须恰好等待一次');
  assert.equal(takeovers.length, 1);
  assert.equal(takeovers[0]?.staleBecause, 'stale-heartbeat');
  assert.equal(takeovers[0]?.previousPid, FAKE_LIVE_PID);
  assert.equal(readLock(dir).pid, process.pid);
});

test('宽限期内心跳恢复则放弃接管（慢关机不误杀）', async (t) => {
  const dir = makeDir(t);
  const startedAt = new Date(bootTimeMs() + 60_000).toISOString();
  const revived: LockRecord = {
    pid: FAKE_LIVE_PID,
    startedAt,
    heartbeatAt: new Date(Date.now() - 600_000).toISOString(),
  };
  writeLock(dir, revived);

  const takeovers: TakeoverRecord[] = [];
  const sleeps: number[] = [];
  await assert.rejects(
    () =>
      acquireInstanceLock(dir, {
        log: () => {},
        isPidAlive: () => true,
        staleHeartbeatMs: 1_000,
        takeoverGraceMs: 30,
        sleep: async (ms) => {
          sleeps.push(ms);
          // 宽限期内原持有者把心跳刷回来
          writeLock(dir, { ...revived, heartbeatAt: new Date().toISOString() });
        },
        onTakeover: (r) => takeovers.push(r),
      }),
    (err: unknown) => {
      assert.ok(err instanceof LockHeldError);
      assert.equal(err.holder.pid, FAKE_LIVE_PID);
      return true;
    },
  );

  assert.deepEqual(sleeps, [30]);
  assert.deepEqual(takeovers, []);
  assert.equal(readLock(dir).pid, FAKE_LIVE_PID, '锁必须仍在原持有者手里');
});

test('宽限期内原持有者自行释放则回到排他创建路径', async (t) => {
  const dir = makeDir(t);
  writeLock(dir, {
    pid: FAKE_LIVE_PID,
    startedAt: new Date(bootTimeMs() + 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 600_000).toISOString(),
  });

  const takeovers: TakeoverRecord[] = [];
  const lock = await acquireInstanceLock(dir, {
    log: () => {},
    isPidAlive: () => true,
    staleHeartbeatMs: 1_000,
    takeoverGraceMs: 30,
    sleep: async () => {
      unlinkSync(lockPath(dir));
    },
    onTakeover: (r) => takeovers.push(r),
  });
  t.after(() => lock.release());

  // 没有顶替任何人，不该产生接管记录
  assert.deepEqual(takeovers, []);
  assert.equal(readLock(dir).pid, process.pid);
});

test('宽限期内 pid 退出则按 pid-gone 接管，不再等满宽限期', async (t) => {
  const dir = makeDir(t);
  writeLock(dir, {
    pid: FAKE_LIVE_PID,
    startedAt: new Date(bootTimeMs() + 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 600_000).toISOString(),
  });

  let alive = true;
  const takeovers: TakeoverRecord[] = [];
  const lock = await acquireInstanceLock(dir, {
    log: () => {},
    isPidAlive: () => alive,
    staleHeartbeatMs: 1_000,
    takeoverGraceMs: 30,
    sleep: async () => {
      // 宽限期内对方进程真的退出了
      alive = false;
    },
    onTakeover: (r) => takeovers.push(r),
  });
  t.after(() => lock.release());

  assert.equal(takeovers.length, 1);
  assert.equal(takeovers[0]?.staleBecause, 'pid-gone');
  assert.equal(takeovers[0]?.previousPid, FAKE_LIVE_PID);
});

test('宽限期内锁被第三方抢走且第三方健康则放弃接管', async (t) => {
  const dir = makeDir(t);
  const previous: LockRecord = {
    pid: FAKE_LIVE_PID,
    startedAt: new Date(bootTimeMs() + 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 600_000).toISOString(),
  };
  writeLock(dir, previous);

  const third: LockRecord = {
    pid: 7777,
    startedAt: new Date(bootTimeMs() + 120_000).toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  const takeovers: TakeoverRecord[] = [];
  await assert.rejects(
    () =>
      acquireInstanceLock(dir, {
        log: () => {},
        isPidAlive: (pid) => pid === FAKE_LIVE_PID || pid === third.pid,
        staleHeartbeatMs: 1_000,
        takeoverGraceMs: 30,
        sleep: async () => {
          writeLock(dir, third);
        },
        onTakeover: (r) => takeovers.push(r),
      }),
    (err: unknown) => {
      assert.ok(err instanceof LockHeldError);
      assert.equal(err.holder.pid, third.pid);
      return true;
    },
  );

  assert.deepEqual(takeovers, []);
  assert.deepEqual(readLock(dir), third);
});

test('onTakeover 回调抛错不影响接管成功', async (t) => {
  const dir = makeDir(t);
  writeLock(dir, {
    pid: DEAD_PID,
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 3_600_000).toISOString(),
  });

  const lock = await acquireInstanceLock(dir, {
    log: () => {},
    onTakeover: () => {
      throw new Error('调用方回调自身出错');
    },
  });
  t.after(() => lock.release());

  assert.equal(lock.owns, true);
  assert.equal(readLock(dir).pid, process.pid);
});

test('锁文件不可解析时立即接管（崩溃遗留的半截文件）', async (t) => {
  const dir = makeDir(t);
  writeFileSync(lockPath(dir), '{ "pid": 4');

  const takeovers: TakeoverRecord[] = [];
  const sleeps: number[] = [];
  const lock = await acquireInstanceLock(dir, {
    log: () => {},
    takeoverGraceMs: 60_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onTakeover: (r) => takeovers.push(r),
  });
  t.after(() => lock.release());

  assert.deepEqual(sleeps, []);
  assert.equal(takeovers.length, 1);
  assert.equal(takeovers[0]?.staleBecause, 'pid-gone');
  assert.equal(takeovers[0]?.previousPid, null);
  assert.equal(takeovers[0]?.previousHeartbeatAt, null);
  assert.equal(readLock(dir).pid, process.pid);
});

test('release 删除锁文件并让 verify 失效，重复调用安全', async (t) => {
  const dir = makeDir(t);
  const lock = await acquireInstanceLock(dir, SILENT);

  assert.equal(existsSync(lockPath(dir)), true);
  lock.release();
  assert.equal(existsSync(lockPath(dir)), false);
  assert.equal(lock.verify(), false);

  lock.release();
  assert.equal(existsSync(lockPath(dir)), false);
});

test('持锁后心跳按间隔更新 heartbeatAt', async (t) => {
  const dir = makeDir(t);
  const lock = await acquireInstanceLock(dir, {
    log: () => {},
    heartbeatIntervalMs: 20,
    selfCheckIntervalMs: 10_000,
  });
  t.after(() => lock.release());

  const before = readLock(dir).heartbeatAt;
  await sleep(90);
  const after = readLock(dir).heartbeatAt;

  assert.notEqual(after, before);
  assert.ok(Date.parse(after) >= Date.parse(before));
  assert.equal(readLock(dir).pid, process.pid);
});

test('锁被他人覆写：自检触发 onStolen，心跳停止，释放不删他人锁', async (t) => {
  const dir = makeDir(t);
  const stolen: StolenInfo[] = [];
  const lock = await acquireInstanceLock(dir, {
    log: () => {},
    heartbeatIntervalMs: 20,
    selfCheckIntervalMs: 20,
    onStolen: (info) => stolen.push(info),
  });
  t.after(() => lock.release());

  const intruder: LockRecord = {
    pid: 999_999,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  writeLock(dir, intruder);
  await sleep(120);

  assert.equal(stolen.length, 1, 'onStolen 只应触发一次');
  assert.equal(stolen[0]?.expectedPid, process.pid);
  assert.equal(stolen[0]?.observed?.pid, intruder.pid);
  assert.equal(stolen[0]?.observedState, 'record');
  assert.equal(lock.verify(), false);

  // 心跳必须已经停手：锁内容仍是闯入者写的
  lock.release();
  assert.deepEqual(readLock(dir), intruder);
});

test('锁文件消失也会触发 onStolen（observed 为 null）', async (t) => {
  const dir = makeDir(t);
  const stolen: StolenInfo[] = [];
  const lock = await acquireInstanceLock(dir, {
    log: () => {},
    heartbeatIntervalMs: 10_000,
    selfCheckIntervalMs: 20,
    onStolen: (info) => stolen.push(info),
  });
  t.after(() => lock.release());

  unlinkSync(lockPath(dir));
  await sleep(120);

  assert.equal(stolen.length, 1);
  assert.equal(stolen[0]?.observed, null);
  assert.equal(stolen[0]?.observedState, 'absent');
});

test('toInstanceTakeoverData 对齐 schema 的 instance/takeover 负载', () => {
  const base: TakeoverRecord = {
    file: 'data/lock.json',
    previousPid: 7,
    previousHeartbeatAt: '2026-01-01T00:00:00.000Z',
    staleBecause: 'stale-heartbeat',
    at: '2026-01-02T00:00:00.000Z',
  };

  // schema 只认 'no-heartbeat' | 'pid-gone' | 'pid-reused'，陈旧心跳归入 no-heartbeat
  assert.deepEqual(toInstanceTakeoverData(base), {
    previousPid: 7,
    previousHeartbeatAt: '2026-01-01T00:00:00.000Z',
    staleBecause: 'no-heartbeat',
  });
  assert.equal(toInstanceTakeoverData({ ...base, staleBecause: 'pid-gone' }).staleBecause, 'pid-gone');
  assert.equal(toInstanceTakeoverData({ ...base, staleBecause: 'pid-reused' }).staleBecause, 'pid-reused');

  const unknown = toInstanceTakeoverData({ ...base, previousPid: null, previousHeartbeatAt: null });
  assert.equal(unknown.previousPid, 0);
  assert.equal(unknown.previousHeartbeatAt, new Date(0).toISOString());
});
