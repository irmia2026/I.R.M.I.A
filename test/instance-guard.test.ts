/**
 * 接管闸门测试（src/runtime/instance-guard.ts）
 *
 * 覆盖用户 2026-10-11 点名的三条验收 + 父线追加的一条：
 *   ① 第二个实例被拒（错误类型 + **人话文案** + 真进程的**退出码**）；
 *   ② 陈旧锁能被接管（四种陈旧判据各一条，接管要留痕）；
 *   ③ 界面在"已有后端"时不起第二个 —— 落点是**后端自己拒绝**（界面那一半见 docs/gui-guard.md §2）；
 *   ④ **两条路径并发拉起只成一个**（重启脚本与 self-restart 各拉一个的那种并发）。
 *
 * 第四条里有一支**故意钉住那个洞**：不带闸门时两个并发启动会**同时**成为用户
 * （见 `没有闸门时…` 那条）。它红了不是"测试坏了"，是"锁自己变原子了"——
 * 那时请重读 instance-guard.ts 的文件头再决定闸门去留。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  acquireInstanceLock, LOCK_FILE_NAME, LockHeldError,
  type AcquireOptions, type LockRecord,
} from '../src/runtime/instance-lock.ts';
import {
  acquireInstanceGate, BackendAlreadyRunningError, InstanceGateBusyError,
  TAKEOVER_GATE_FILE_NAME,
  type GateOptions, type GateReclaimRecord,
} from '../src/runtime/instance-guard.ts';

/** 一个一定不存在的 pid（与 instance-lock.test.ts 同一取值口径） */
const DEAD_PID = 2147483646;
/** 本次开机时刻：构造"开机之后启动"的 startedAt 必须用它（process.uptime 基准点不同） */
const BOOT_MS = Date.now() - uptime() * 1000;

function makeDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function lockPath(dir: string): string {
  return join(dir, LOCK_FILE_NAME);
}

function gatePath(dir: string): string {
  return join(dir, TAKEOVER_GATE_FILE_NAME);
}

/** 盘上写一把"持有者已死"的陈旧锁：心跳也很旧（判据第一优先级是 pid 不在，够用） */
function seedStaleLock(dir: string, at = new Date(BOOT_MS - 60_000)): void {
  const record: LockRecord = {
    pid: DEAD_PID,
    startedAt: at.toISOString(),
    heartbeatAt: at.toISOString(),
  };
  writeFileSync(lockPath(dir), `${JSON.stringify(record, null, 2)}\n`);
}

/** 只认"不是 DEAD_PID 的都活着"：于是陈旧判据只可能落在 pid-gone 上 */
const aliveExceptDead = (pid: number): boolean => pid !== DEAD_PID;

const SILENT: GateOptions = { log: () => {} };
const SILENT_LOCK: AcquireOptions = { log: () => {} };

/**
 * 一次"进程启动"：**与 main.ts 的接线同形**——先拿闸门，再在闸门里做那次可能并发的接管，
 * 拿到锁（或抛错）之后才放闸门。
 */
async function startupOnce(
  dir: string,
  pid: number,
  isPidAlive: (pid: number) => boolean,
): Promise<{ lockPid: number }> {
  const gate = await acquireInstanceGate(dir, { pid, isPidAlive, waitMs: 0, ...SILENT });
  try {
    const lock = await acquireInstanceLock(dir, { pid, isPidAlive, ...SILENT_LOCK });
    return { lockPid: lock.pid };
  } finally {
    gate.release();
  }
}

// ──────────────────────────────── ② 陈旧闸门能被接管（四种判据） ────────────────────────────────

test('① 闸门是排他的：有人持着时第二个拿不到，且错误是人话', async (t) => {
  const dir = makeDir(t);
  const first = await acquireInstanceGate(dir, { pid: 1111, isPidAlive: () => true, waitMs: 0, ...SILENT });
  t.after(() => first.release());

  await assert.rejects(
    () => acquireInstanceGate(dir, { pid: 2222, isPidAlive: () => true, waitMs: 0, ...SILENT }),
    (err: unknown) => {
      assert.ok(err instanceof InstanceGateBusyError, `应当是 InstanceGateBusyError，实际 ${String(err)}`);
      assert.equal(err.holderPid, 1111, '错误里要点名持有者 pid——人读那句话全靠它');
      assert.match(err.message, /另一个后端实例正在启动/u);
      assert.match(err.message, /pid 1111/u);
      assert.match(err.message, /本实例不启动/u);
      return true;
    },
  );
});

test('② 陈旧闸门 · 持闸者已死 ⇒ 接管，且留痕写明原因', async (t) => {
  const dir = makeDir(t);
  writeFileSync(gatePath(dir), `${JSON.stringify({
    pid: DEAD_PID,
    startedAt: new Date(BOOT_MS - 120_000).toISOString(),
    at: new Date(BOOT_MS - 120_000).toISOString(),
    token: 'dead-holder',
  }, null, 2)}\n`);

  const reclaimed: GateReclaimRecord[] = [];
  const gate = await acquireInstanceGate(dir, {
    pid: 3333,
    isPidAlive: aliveExceptDead,
    waitMs: 0,
    onReclaim: (record) => reclaimed.push(record),
    ...SILENT,
  });
  t.after(() => gate.release());

  assert.equal(reclaimed.length, 1, '接管必须回调一次：调用方据此留痕');
  assert.equal(reclaimed[0]?.staleBecause, 'pid-gone');
  assert.equal(reclaimed[0]?.previousPid, DEAD_PID);
  assert.ok(gate.verify(), '接管之后闸门是我的');
  assert.equal(JSON.parse(readFileSync(gatePath(dir), 'utf8')).pid, 3333);
});

test('② 陈旧闸门 · 内容读不懂（建好没写完就被杀）⇒ 按 unreadable 接管', async (t) => {
  const dir = makeDir(t);
  writeFileSync(gatePath(dir), '{"pid": 4242, "startedAt"');
  const reclaimed: GateReclaimRecord[] = [];
  const gate = await acquireInstanceGate(dir, {
    pid: 4444,
    isPidAlive: () => true,
    waitMs: 0,
    onReclaim: (record) => reclaimed.push(record),
    ...SILENT,
  });
  t.after(() => gate.release());
  assert.equal(reclaimed[0]?.staleBecause, 'unreadable');
  assert.equal(reclaimed[0]?.previousPid, null);
});

test('② 陈旧闸门 · 记录的 pid 就是我（上一次本进程漏放）⇒ 按 self-leak 自愈', async (t) => {
  const dir = makeDir(t);
  writeFileSync(gatePath(dir), `${JSON.stringify({
    pid: 5555,
    startedAt: new Date(BOOT_MS).toISOString(),
    at: new Date(BOOT_MS).toISOString(),
    token: 'leaked',
  })}\n`);
  const reclaimed: GateReclaimRecord[] = [];
  const gate = await acquireInstanceGate(dir, {
    pid: 5555,
    isPidAlive: () => true,
    waitMs: 0,
    onReclaim: (record) => reclaimed.push(record),
    ...SILENT,
  });
  t.after(() => gate.release());
  assert.equal(reclaimed[0]?.staleBecause, 'self-leak');
});

test('② 陈旧闸门 · pid 还活着但被持有超过上限 ⇒ 判 pid 复用（防"假忙"把后端起不来）', async (t) => {
  const dir = makeDir(t);
  const heldAt = Date.parse('2026-10-11T00:00:00.000Z');
  writeFileSync(gatePath(dir), `${JSON.stringify({
    pid: 6666,
    startedAt: new Date(heldAt - 5_000).toISOString(),
    at: new Date(heldAt).toISOString(),
    token: 'old',
  })}\n`);
  const reclaimed: GateReclaimRecord[] = [];
  const gate = await acquireInstanceGate(dir, {
    pid: 7777,
    isPidAlive: () => true,
    waitMs: 0,
    now: () => heldAt + 11 * 60_000, // 超过 10 分钟上限
    onReclaim: (record) => reclaimed.push(record),
    ...SILENT,
  });
  t.after(() => gate.release());
  assert.equal(reclaimed[0]?.staleBecause, 'pid-reused');
  assert.equal(reclaimed[0]?.heldMs, 11 * 60_000);
});

test('② release 只删自己那一次持有：闸门被别人顶替后不动别人的文件', async (t) => {
  const dir = makeDir(t);
  const gate = await acquireInstanceGate(dir, { pid: 8888, isPidAlive: () => true, waitMs: 0, ...SILENT });
  // 模拟"别人接管了"：直接把文件换成另一份记录
  writeFileSync(gatePath(dir), `${JSON.stringify({
    pid: 9999,
    startedAt: new Date(BOOT_MS).toISOString(),
    at: new Date().toISOString(),
    token: 'someone-else',
  })}\n`);
  assert.equal(gate.verify(), false, '内容不是我 ⇒ verify 为 false');
  gate.release();
  assert.ok(existsSync(gatePath(dir)), '别人的闸门一个字节都不许动');
  assert.equal(JSON.parse(readFileSync(gatePath(dir), 'utf8')).pid, 9999);
});

// ──────────────────────────────── ③ 第二个实例被拒 ────────────────────────────────

test('③ 锁被活着的实例持有时，接管闸门挡住第二个（不能靠"眼疾手快"）', async (t) => {
  const dir = makeDir(t);
  // 一把**活着**的持有者写的锁：pid 用本测试进程自己（一定活着），心跳新鲜、startedAt 在开机之后
  const live: LockRecord = {
    pid: process.pid,
    startedAt: new Date(BOOT_MS + 1_000).toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  writeFileSync(lockPath(dir), `${JSON.stringify(live, null, 2)}\n`);

  await assert.rejects(
    () => acquireInstanceLock(dir, { pid: 12345, isPidAlive: () => true, ...SILENT_LOCK }),
    (err: unknown) => {
      assert.ok(err instanceof LockHeldError, `应当是 LockHeldError，实际 ${String(err)}`);
      assert.equal(err.holder.pid, process.pid);
      return true;
    },
  );

  // 而"人话那一句"由 BackendAlreadyRunningError 给（main.ts 在 recover 抛 LockHeldError 时就地翻译）
  const human = new BackendAlreadyRunningError(lockPath(dir), live.pid, live.startedAt);
  assert.match(human.message, /已经有一个后端在跑/u);
  assert.match(human.message, new RegExp(`pid ${String(process.pid)}`, 'u'));
  assert.match(human.message, /我这个不启动/u);
});

// ──────────────────────────────── ①④ 并发：只成一个 ────────────────────────────────

test('④ 两条路径并发拉起（带闸门）⇒ **恰好一个**成为用户，另一个被拒且不动日志', async (t) => {
  const dir = makeDir(t);
  seedStaleLock(dir);

  const results = await Promise.allSettled([
    startupOnce(dir, 1111, aliveExceptDead),
    startupOnce(dir, 2222, aliveExceptDead),
  ]);

  const ok = results.filter((r) => r.status === 'fulfilled');
  const bad = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, `应当恰好一个成功，实际 ${ok.length} 个：${JSON.stringify(results.map((r) => r.status))}`);
  assert.equal(bad.length, 1, '另一个必须被挡在门外——它一个字节都不该写');

  const rejected = bad[0] as PromiseRejectedResult;
  const err = rejected.reason as unknown;
  assert.ok(
    err instanceof InstanceGateBusyError || err instanceof LockHeldError,
    `被拒的原因应当是闸门或锁给的，实际 ${String(err)}`,
  );

  // 用户: 日志里那把锁只能属于一个人
  const finalPid = (JSON.parse(readFileSync(lockPath(dir), 'utf8')) as LockRecord).pid;
  const winner = ok[0] as PromiseFulfilledResult<{ lockPid: number }>;
  assert.equal(finalPid, winner.value.lockPid, '锁文件里最终那个 pid 必须就是"唯一成功"的那个');
});

test('④ 没有闸门时，同一场景会**同时**出现两个用户 —— 这条钉的是闸门为什么必须有', async (t) => {
  const dir = makeDir(t);
  seedStaleLock(dir);

  // 故意走 instance-lock 的裸接管路径：两个并发调用各自都"判定前任已死 → 覆盖 → 回读是自己"
  const results = await Promise.allSettled([
    acquireInstanceLock(dir, { pid: 1111, isPidAlive: aliveExceptDead, ...SILENT_LOCK }),
    acquireInstanceLock(dir, { pid: 2222, isPidAlive: aliveExceptDead, ...SILENT_LOCK }),
  ]);
  t.after(() => {
    for (const r of results) if (r.status === 'fulfilled') r.value.release();
  });

  const owners = results.filter((r) => r.status === 'fulfilled').length;
  assert.equal(
    owners, 2,
    '两条都拿到了锁 = 这个洞是真的（两个后端会各写各的 turn）。'
    + '若这条红了：说明 instance-lock 自己变成原子的了，请重读 instance-guard.ts 的文件头再决定闸门去留',
  );
});

test('④ 第二个**真进程**：启动被拒、退出码 1、文案是人话，且一个字节都没写', async (t) => {
  const dir = makeDir(t);
  // 塞一把"活着的持有者"写的锁：pid 用本测试进程（子进程一定看得见它活着）
  const live: LockRecord = {
    pid: process.pid,
    startedAt: new Date(BOOT_MS + 1_000).toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  writeFileSync(lockPath(dir), `${JSON.stringify(live, null, 2)}\n`);
  const before = readFileSync(lockPath(dir), 'utf8');

  const probe = spawnSync(
    process.execPath,
    ['--experimental-strip-types', join(process.cwd(), 'src', 'main.ts')],
    {
      encoding: 'utf8',
      timeout: 120_000,
      // 数据目录指到临时目录：一个字节都不碰真 data/
      env: { ...process.env, IRMIA_DATA_DIR: dir },
    },
  );
  const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;

  assert.equal(probe.status, 1, `第二个实例必须**立刻退出**（退出码 1）。实测输出：${output.slice(-600)}`);
  assert.match(output, /已经有一个后端在跑/u);
  assert.match(output, new RegExp(`pid ${String(process.pid)}`, 'u'));
  assert.match(output, /我这个不启动/u);

  assert.equal(readFileSync(lockPath(dir), 'utf8'), before, '被拒的那一个不许动锁文件');
  assert.equal(existsSync(gatePath(dir)), false, '它退出前必须把接管闸门放掉（否则下一次启动会看到陈旧闸门）');
});

test('④ 三条路径并发拉起（脚本 / self-restart / 桌面 cmd）⇒ 仍然只有一个用户', async (t) => {
  const dir = makeDir(t);
  seedStaleLock(dir);

  const results = await Promise.allSettled([
    startupOnce(dir, 1111, aliveExceptDead),
    startupOnce(dir, 2222, aliveExceptDead),
    startupOnce(dir, 3333, aliveExceptDead),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  assert.equal(ok.length, 1, `三条路并发只许成一个，实际 ${ok.length} 个`);
  const refused = results.filter((r) => r.status === 'rejected');
  assert.equal(refused.length, 2);
  for (const r of refused) {
    const err = (r as PromiseRejectedResult).reason as unknown;
    assert.ok(
      err instanceof InstanceGateBusyError || err instanceof LockHeldError,
      `被拒的原因应当是闸门或锁给的，实际 ${String(err)}`,
    );
  }
  const finalPid = (JSON.parse(readFileSync(lockPath(dir), 'utf8')) as LockRecord).pid;
  assert.equal(finalPid, (ok[0] as PromiseFulfilledResult<{ lockPid: number }>).value.lockPid);
});
