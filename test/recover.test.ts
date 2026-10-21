/**
 * 启动恢复七步测试（src/runtime/recover.ts）
 * 覆盖：空目录启动、末行自愈、开放 turn 退回输入、悬空 destructive 调用转 unknown、claimCount 达 3 进死信。
 *
 * 说明：Node 的类型剥离不做 `.js` → `.ts` 映射，所以这里用显式 `.ts` 说明符导入源码。
 */

import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import type { AppEvent } from '../src/log/types.ts';
import { fold } from '../src/state/fold.ts';
import { PROJECTION_CACHE_FILE } from '../src/state/projection-cache.ts';
import { acquireInstanceLock, LockHeldError } from '../src/runtime/instance-lock.ts';
import { EVENT_LOG_DIR_NAME, MAX_CLAIM_COUNT, recover, type RecoverResult } from '../src/runtime/recover.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

/** 固定基准时刻：事件内容可重复构造 */
const EPOCH_MS = 1_780_000_000_000;

/** 恢复流程会读环境时钟，测试只断言事件存在与负载，不比对 ts 的字面值 */
function ts(offsetSec: number): string {
  return new Date(EPOCH_MS + offsetSec * 1000).toISOString();
}

interface Fixture {
  dir: string;
  eventDir: string;
  /** 直接写一组事件到指定分片（默认首片），用于伪造崩溃前的磁盘状态 */
  writeShard: (events: AppEvent[], startSeq?: number) => void;
  /** 追加原始字节（用于制造「写了一半」的残行） */
  appendRaw: (text: string) => void;
  readEvents: () => AppEvent[];
  types: () => string[];
  cachePath: string;
}

function makeFixture(t: TestContext, events: AppEvent[] = []): Fixture {
  const dir = tempDirSync('irmia-recover-');
  const eventDir = join(dir, EVENT_LOG_DIR_NAME);
  mkdirSync(eventDir, { recursive: true });
  const shardPath = (startSeq: number): string =>
    join(eventDir, `${String(startSeq).padStart(12, '0')}.jsonl`);

  if (events.length > 0) {
    writeFileSync(shardPath(events[0]!.seq), `${events.map(e => JSON.stringify(e)).join('\n')}\n`, 'utf8');
  }

  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const readEvents = (): AppEvent[] => {
    // 恢复期写入的事件会落进新分片（分片名 = 首条事件的 seq），所以必须读全部片
    return readdirSync(eventDir)
      .filter(name => name.endsWith('.jsonl'))
      .sort()
      .flatMap((name) =>
        readFileSync(join(eventDir, name), 'utf8')
          .split('\n')
          .filter(line => line.length > 0)
          .map(line => JSON.parse(line) as AppEvent),
      );
  };

  return {
    dir,
    eventDir,
    writeShard: (list, startSeq) => {
      writeFileSync(shardPath(startSeq ?? list[0]?.seq ?? 1), `${list.map(e => JSON.stringify(e)).join('\n')}\n`, 'utf8');
    },
    appendRaw: (text) => appendFileSync(shardPath(1), text, 'utf8'),
    readEvents,
    types: () => readEvents().map(e => e.type),
    cachePath: join(dir, PROJECTION_CACHE_FILE),
  };
}

/** 恢复完成后放锁：测试进程不能留下心跳定时器拖住 event loop */
async function withRecover(
  t: TestContext,
  fixture: Fixture,
  check: (result: RecoverResult) => void | Promise<void>,
): Promise<void> {
  const warnings: string[] = [];
  const result = await recover({
    dataDir: fixture.dir,
    log: (level, message) => {
      if (level === 'warn' || level === 'error') warnings.push(`${level}: ${message}`);
    },
  });
  t.after(() => result.lock.release());
  try {
    await check(result);
  } finally {
    result.log.close();
  }
}

function event(seq: number, type: string, data: unknown, offsetSec: number, visibility = 'internal'): AppEvent {
  return { seq, ts: ts(offsetSec), type, data, visibility, origin: 'test' } as AppEvent;
}

const wakeManual = (seq: number, note = 'test wake'): AppEvent =>
  event(seq, 'wake/manual', { note, dedupeKey: `k${seq}` }, seq, 'model');

// ──────────────────────────────── ① 正常空目录启动 ────────────────────────────────

test('① 空数据目录启动：拿到锁、无开放单元、投影为空且落盘缓存', async (t) => {
  const fixture = makeFixture(t);
  await withRecover(t, fixture, (result) => {
    assert.equal(result.lock.owns, true);
    assert.equal(existsSync(join(fixture.dir, 'lock.json')), true);
    assert.equal(result.projection.lastSeq, 0);
    assert.equal(result.projection.openTurn, null);
    assert.deepEqual(result.projection.openTools, []);
    assert.deepEqual(result.projection.pending, []);
    // 没有任何补偿动作：空目录不需要修复任何东西
    assert.deepEqual(result.repairs, []);
    // 投影缓存必须落盘，供下次启动命中
    assert.equal(existsSync(fixture.cachePath), true);
    // 事件日志保持空——恢复流程不写无意义事件
    assert.deepEqual(fixture.types(), []);
  });
});

test('①b 二次启动命中投影缓存：结果与全量折叠一致', async (t) => {
  const fixture = makeFixture(t, [
    wakeManual(1),
    event(2, 'turn/start', { turn: 1 }, 2),
    event(3, 'input/claimed', { turn: 1, wakeSeqs: [1], claimCounts: [0] }, 3),
    event(4, 'turn/end', { turn: 1, reason: { kind: 'completed' }, spoke: true }, 4),
  ]);

  let first: RecoverResult | null = null;
  await withRecover(t, fixture, (result) => {
    first = result;
    // 历史 turn 已正常结束，不需要任何补偿；只有水位恢复的摘要
    assert.deepEqual(result.projection.pending, []);
    assert.equal(result.projection.openTurn, null);
  });
  const firstLastSeq = first!.projection.lastSeq;
  first!.lock.release();

  // 第二次启动：缓存 lastSeq 与日志末尾一致 → 走缓存路径，且状态与折叠结果相同
  const second = await recover({ dataDir: fixture.dir, log: () => {} });
  t.after(() => second.lock.release());
  try {
    assert.equal(second.projection.lastSeq, firstLastSeq);
    const folded = fold(fixture.readEvents());
    assert.deepEqual(second.projection.pending, folded.pending);
    assert.equal(second.projection.openTurn, null);
    assert.deepEqual(second.projection.openTools, []);
  } finally {
    second.log.close();
  }
});

// ──────────────────────────────── ② 末行自愈 ────────────────────────────────

test('② 末行写了一半：启动后截断残行并写 log/repaired', async (t) => {
  const fixture = makeFixture(t, [wakeManual(1)]);
  // 模拟「写到一半被杀」：半截 JSON，没有换行结尾
  fixture.appendRaw('{"seq":2,"ts":"2026-06-01T00:00:02.000Z","type":"turn/end","dat');

  await withRecover(t, fixture, (result) => {
    const events = fixture.readEvents();
    assert.deepEqual(events.map(e => e.type), ['wake/manual', 'log/repaired']);
    const repaired = events[1]!;
    assert.equal(repaired.visibility, 'internal');
    assert.equal(repaired.data.lastGoodSeq, 1);
    assert.ok(repaired.data.truncatedBytes > 0);
    // 残行必须已从磁盘上消失：原始分片只应剩一条完整事件
    const firstShard = readFileSync(join(fixture.eventDir, '000000000001.jsonl'), 'utf8');
    assert.equal(firstShard.trimEnd().split('\n').length, 1);
    assert.equal(firstShard.includes('turn/end'), false);
    assert.equal(result.projection.lastSeq, 2);
    assert.ok(
      result.repairs.some(r => r.includes('截断')),
      `repairs 应记录自愈动作，实际：${JSON.stringify(result.repairs)}`,
    );
  });
});

// ──────────────────────────────── ③ 开放 turn + 认领输入 ────────────────────────────────

test('③ 开放 turn：补写 turn/end{interrupted}，认领输入退回队列', async (t) => {
  const fixture = makeFixture(t, [
    wakeManual(1, '崩溃前收到的唤醒'),
    event(2, 'turn/start', { turn: 7 }, 2),
    event(3, 'step/start', { turn: 7, step: 1, model: 'heavy', lane: 'heavy', renderVersion: 'v1', personaHash: 'p' }, 3),
    event(4, 'input/claimed', { turn: 7, wakeSeqs: [1], claimCounts: [0] }, 4),
  ]);

  await withRecover(t, fixture, (result) => {
    const events = fixture.readEvents();
    assert.deepEqual(events.map(e => e.type), [
      'wake/manual', 'turn/start', 'step/start', 'input/claimed', 'turn/end', 'input/requeued',
    ]);

    const end = events[4]!;
    assert.equal(end.data.turn, 7);
    assert.deepEqual(end.data.reason, { kind: 'interrupted' });
    assert.equal(end.data.spoke, false);

    const requeued = events[5]!;
    assert.deepEqual(requeued.data.wakeSeqs, [1]);
    assert.deepEqual(requeued.data.claimCounts, [1]);
    assert.deepEqual(requeued.data.sources, ['manual']);
    assert.equal(requeued.data.reason, 'turn-interrupted');

    // 投影同步：turn 已关、输入回到 pending、两个开放集合都空
    assert.equal(result.projection.openTurn, null);
    assert.deepEqual(result.projection.pending.map(p => [p.wakeSeq, p.claimCount, p.source]), [[1, 1, 'manual']]);
    assert.deepEqual(result.projection.claimedByTurn, {});
  });
});

test('③b 退回后的投影与磁盘日志的全量折叠完全一致', async (t) => {
  const fixture = makeFixture(t, [
    wakeManual(1),
    event(2, 'turn/start', { turn: 3 }, 2),
    event(3, 'input/claimed', { turn: 3, wakeSeqs: [1], claimCounts: [0] }, 3),
  ]);

  await withRecover(t, fixture, (result) => {
    const folded = fold(fixture.readEvents());
    assert.deepEqual(result.projection.pending, folded.pending);
    assert.deepEqual(result.projection.deadLetters, folded.deadLetters);
    assert.deepEqual(result.projection.needsReview, folded.needsReview);
    assert.equal(result.projection.lastSeq, folded.lastSeq);
  });
});

// ──────────────────────────────── ④ 悬空 destructive 调用 ────────────────────────────────

test('④ 悬空 destructive 调用：写 tool/result{unknown} 且进入待确认', async (t) => {
  const fixture = makeFixture(t, [
    event(1, 'turn/start', { turn: 2 }, 1),
    event(2, 'tool/call', {
      turn: 2, step: 1, callId: 'c1', name: 'http_post',
      arguments: '{"url":"http://example.invalid"}', sideEffect: 'destructive',
    }, 2, 'model'),
    event(3, 'tool/call', {
      turn: 2, step: 1, callId: 'c2', name: 'read_file',
      arguments: '{"path":"a.md"}', sideEffect: 'none',
    }, 3, 'model'),
  ]);

  await withRecover(t, fixture, (result) => {
    const events = fixture.readEvents();
    const unknownResults = events.filter(e => e.type === 'tool/result' && e.data.status === 'unknown');
    assert.equal(unknownResults.length, 1, '只有 destructive 调用应被标记 unknown');
    const unknown = unknownResults[0]!;
    assert.equal(unknown.data.callId, 'c1');
    assert.equal(unknown.data.callSeq, 2, 'callSeq 必须引用原 tool/call 的 seq');
    assert.equal(unknown.data.turn, 2);
    assert.equal(unknown.visibility, 'model', 'unknown 结果必须让模型看得见');
    assert.match(unknown.data.content, /unknown/i);

    // destructive 调用写 tool/zombie 作审计
    assert.deepEqual(events.filter(e => e.type === 'tool/zombie').map(e => e.data.callId), ['c1']);

    // **只读调用也要收尾**（2026-10-02 改，用户："两个兜底你去写一下吧"）：
    // 原设计刻意不写（怕"假结果污染上下文"，且 tool/zombie 清不掉开放项）——但写 `tool/result`
    // 恰恰是**收尾**：折叠一见 result 就把它从 openTools 摘掉，"那次调用没跑完"这件事也第一次
    // 落进了日志（以前只有渲染层每次现补一句占位，日志里查不到）。措辞说实话：没跑完、结果未知。
    const unfinished = events.filter(e => e.type === 'tool/result' && e.data.callId === 'c2');
    assert.equal(unfinished.length, 1, '可重试调用也要有一条终态，否则 openTools 永远挂着它');
    assert.equal(unfinished[0]!.data.status, 'error', '不许写成 ok：结果未知');
    assert.match(String(unfinished[0]!.data.content), /没有跑完/u);
    assert.equal(unfinished[0]!.visibility, 'model', '它要进她下一步的上下文');
    assert.ok(
      result.repairs.some(r => r.includes('c2') && r.includes('收尾')),
      `repairs 应记录这次收尾，实际：${JSON.stringify(result.repairs)}`,
    );

    // needsReview 由 fold 自然产生
    assert.deepEqual(result.projection.needsReview.map(r => r.callId), ['c1']);
    // 两条都已闭合：destructive 走 unknown，可重试走"没跑完"——openTools 不再留着没人认领的开放项
    assert.deepEqual(result.projection.openTools.map(t => t.callId), [], '悬空调用全部收尾');
    assert.ok(
      result.repairs.some(r => r.includes('c1') && r.includes('unknown')),
      `repairs 应记录待确认调用，实际：${JSON.stringify(result.repairs)}`,
    );
  });
});

// ──────────────────────────────── ⑤ 毒消息进死信 ────────────────────────────────

test('⑤ claimCount 达 3：输入进死信队列，不再回到 pending', async (t) => {
  // input/claimed 的 claimCounts 语义 = 本次认领之前已完成的认领次数；退回时 +1
  const fixture = makeFixture(t, [
    wakeManual(1, '注定失败的输入'),
    // 第 1 次认领 → 崩溃回收（退回后累计 1）
    event(2, 'turn/start', { turn: 1 }, 2),
    event(3, 'input/claimed', { turn: 1, wakeSeqs: [1], claimCounts: [0] }, 3),
    event(4, 'turn/end', { turn: 1, reason: { kind: 'interrupted' }, spoke: false }, 4),
    event(5, 'input/requeued', { wakeSeqs: [1], claimCounts: [1], sources: ['manual'], reason: 'turn-interrupted' }, 5),
    // 第 2 次认领 → 再次崩溃回收（退回后累计 2）
    event(6, 'turn/start', { turn: 2 }, 6),
    event(7, 'input/claimed', { turn: 2, wakeSeqs: [1], claimCounts: [1] }, 7),
    event(8, 'turn/end', { turn: 2, reason: { kind: 'interrupted' }, spoke: false }, 8),
    event(9, 'input/requeued', { wakeSeqs: [1], claimCounts: [2], sources: ['manual'], reason: 'turn-interrupted' }, 9),
    // 第 3 次认领 → 本次启动的恢复必须把它推进死信，不再退回
    event(10, 'turn/start', { turn: 3 }, 10),
    event(11, 'input/claimed', { turn: 3, wakeSeqs: [1], claimCounts: [2] }, 11),
  ]);

  await withRecover(t, fixture, (result) => {
    const events = fixture.readEvents();
    const dead = events.filter(e => e.type === 'input/dead-letter');
    assert.equal(dead.length, 1);
    assert.equal(dead[0]!.data.inputSeq, 1);
    assert.equal(dead[0]!.data.claimCount, MAX_CLAIM_COUNT);
    // **为什么进死信**要说得出是哪一类（2026-10-16 加）：界面读字段、读不了自由文本，
    // 而"认领到上限"与"用户按下 /stop"的下一步动作完全不同（前者要查它为什么必然失败，后者随时能重投）
    assert.equal(dead[0]!.data.reason, 'claim-limit');
    // 死信路径不得再退回队列
    assert.equal(events.filter(e => e.type === 'input/requeued').length, 2, '只有历史那两条 requeued');

    assert.deepEqual(result.projection.pending, []);
    assert.deepEqual(result.projection.deadLetters.map(d => [d.inputSeq, d.claimCount]), [[1, MAX_CLAIM_COUNT]]);
    assert.ok(
      result.repairs.some(r => r.includes('死信')),
      `repairs 应记录死信，实际：${JSON.stringify(result.repairs)}`,
    );
  });
});

test('⑤c 认领次数**跨重启**累计：判据全部从日志读回，不靠进程内存', async (t) => {
  /**
   * 这一条钉的是用户报的那件事（「我重启了又 tm 重投了」）**为什么本来就成立**：
   * `claimCount` 的每一次累加都落在**日志**里（`input/claimed.claimCounts` +
   * `input/requeued.claimCounts`），恢复流程用 `claimedCountsOf` **回读日志**
   * （`recover.ts` 的注释写明"为什么必须回日志：投影的 claimedByTurn 只留 wakeSeq，
   * 认领次数在 `input/claimed` 折叠时被丢掉"）——所以"重启三次 = 认领三次"跨进程成立，
   * 唯一会把它清零的是**人**（`web/server.ts` 的 `requeue` 显式写 `claimCounts: [0]`）。
   *
   * ⚠ 这里刻意**不做**"认领了但没关 turn 就重启"那一步：那样会把同一个 wakeSeq 在 pending 里
   * 复制一条（`fold.ts` 的 `input/requeued` 是 push，不是 upsert），而那种形状**生产里到不了**
   * ——每次 `input/claimed` 都紧跟着同一个 turn 的 `turn/end`（turn 一定会闭合，
   * 崩了也由恢复流程补 `turn/end{interrupted}`）。所以这条用例按生产的形状造数据，
   * 判据仍然全部落在日志上，只是**前一次认领的累计结果从上一轮恢复里读出来**
   * （而不是像 ⑤ 那样把三轮都写在同一份夹具里、由一次恢复读完）。
   */
  const fixture = makeFixture(t, [
    wakeManual(1, '总在重启时被撞见的输入'),
    // 第 1 轮：起 turn、认领、崩溃（没有 turn/end）⇒ 恢复必须退回队列，累计 1
    event(2, 'turn/start', { turn: 1 }, 2),
    event(3, 'input/claimed', { turn: 1, wakeSeqs: [1], claimCounts: [0] }, 3),
  ]);

  /** 一次完整的"启动 → 断言 → 关机"（每次都必须放锁） */
  const bootOnce = async (check: (result: RecoverResult) => void): Promise<void> => {
    // 每次启动前删掉投影缓存：这一条验的是"**判据从日志读回来**"，
    // 命中缓存会把它变成"读上一份内存快照"（缓存合法性由 ①b 钉着）
    rmSync(fixture.cachePath, { force: true });
    const result = await recover({ dataDir: fixture.dir, log: () => {} });
    try {
      check(result);
    } finally {
      result.lock.release();
      result.log.close();
    }
  };

  // ── 第 1 次重启：退回，累计 1 ──
  await bootOnce((result) => {
    const requeued = fixture.readEvents().filter(e => e.type === 'input/requeued').at(-1);
    assert.equal(requeued?.data.claimCounts[0], 1, '第 1 次重启：退回时累计到 1');
    assert.equal(result.projection.pending[0]?.claimCount, 1, '投影里读到的也是它');
  });

  // ── 运行期（第 2 轮）：**认领次数从日志读回**（这次是上一轮恢复写下的那一笔） ──
  const claimSeq = fixture.readEvents().length + 1;
  fixture.appendRaw(
    `${JSON.stringify(event(claimSeq, 'turn/start', { turn: 2 }, claimSeq))}\n`
    + `${JSON.stringify(event(claimSeq + 1, 'input/claimed', { turn: 2, wakeSeqs: [1], claimCounts: [1] }, claimSeq + 1))}\n`,
  );

  // ── 第 2 次重启：再退一次，累计 **2**（不是从 0 重来） ──
  await bootOnce((result) => {
    const requeued = fixture.readEvents().filter(e => e.type === 'input/requeued').at(-1);
    assert.equal(requeued?.data.claimCounts[0], 2, '★ 重启不重置：累计接着 1 数到 2');
    /**
     * ⚠ 读 pending 时按 wakeSeq 取**最大**的认领次数，而不是 `pending[0]`：
     * 这一轮恢复把"已经在队列里、又没被任何 turn 认领"的那条**又 push 了一次**
     * （`fold.ts` 的 `input/requeued` 是 push、不是 upsert），于是队列里同时有累计 1 与累计 2 两份。
     * 那是**本用例造的形状**（真实运行期认领一定先于退回：`input/claimed` 摘走它、
     * `turn/end` 收尾），不是判据的落点——判据是"退回时读到的是日志里的累计值"，
     * 就是上面那条断言。死信那一步会把同名项一并摘掉（`fold.ts` 的 filter），
     * 所以这份重复不会带到"进死信"之后。
     */
    const maxClaim = Math.max(...result.projection.pending.filter(p => p.wakeSeq === 1).map(p => p.claimCount));
    assert.equal(maxClaim, 2);
  });

  // ── 运行期（第 3 轮）：再认领一次 ──
  const claimSeq2 = fixture.readEvents().length + 1;
  fixture.appendRaw(
    `${JSON.stringify(event(claimSeq2, 'turn/start', { turn: 3 }, claimSeq2))}\n`
    + `${JSON.stringify(event(claimSeq2 + 1, 'input/claimed', { turn: 3, wakeSeqs: [1], claimCounts: [2] }, claimSeq2 + 1))}\n`,
  );

  // ── 第 3 次重启：**到上限 ⇒ 进死信**，不再退回 ──
  await bootOnce((result) => {
    const dead = fixture.readEvents().filter(e => e.type === 'input/dead-letter');
    assert.equal(dead.length, 1, '跨重启累计到上限 ⇒ 进死信，不再自动重投');
    assert.equal(dead[0]!.data.inputSeq, 1);
    assert.equal(dead[0]!.data.claimCount, MAX_CLAIM_COUNT);
    assert.equal(dead[0]!.data.reason, 'claim-limit');
    assert.deepEqual(result.projection.pending, [], '它不再回到队列里 ⇒ 重启也不会再被认领一次');
    assert.deepEqual(result.projection.deadLetters.map(d => d.inputSeq), [1]);
  });
});

test('⑤ 分批认领的开放 turn：退回时两笔账都要还，认领次数各按自己那笔算', async (t) => {
  // 同一 turn 可以分批认领：turn 开头一笔 + 中途被她看见的插话各一笔（agent-loop 的
  // claimInterruption）。认领次数必须**按 seq** 找自己那一笔——按"最后一笔"的数组去对齐，
  // 会把 seq 1 的累计次数少算一次（毒消息保护就要多崩一轮才生效），甚至把整条输入漏掉。
  const fixture = makeFixture(t, [
    wakeManual(1, '先问的那句'),
    wakeManual(2, '她说话时又来的那句'),
    event(3, 'turn/start', { turn: 1 }, 3),
    // 第 1 笔：开头认领，此前已认领过 1 次
    event(4, 'input/claimed', { turn: 1, wakeSeqs: [1], claimCounts: [1] }, 4),
    // 第 2 笔：她发言途中被打断，销账（首次认领）
    event(5, 'input/claimed', { turn: 1, wakeSeqs: [2], claimCounts: [0] }, 5),
    // 之后崩溃：没有 turn/end
  ]);

  await withRecover(t, fixture, (result) => {
    const requeued = fixture.readEvents().filter(e => e.type === 'input/requeued');
    assert.equal(requeued.length, 1);
    assert.deepEqual(requeued[0]!.data.wakeSeqs, [1, 2], '两笔账上的输入都要回到队列');
    assert.deepEqual(requeued[0]!.data.claimCounts, [2, 1], 'seq 1 累到 2（它本来已经认领过一次）');
    assert.deepEqual(
      result.projection.pending.map(p => [p.wakeSeq, p.claimCount]),
      [[1, 2], [2, 1]],
    );
  });
});

// ──────────────────────────────── 边界 ────────────────────────────────
test('持锁失败：LockHeldError 直接抛出且不写事件', async (t) => {
  const fixture = makeFixture(t, [wakeManual(1)]);
  const holder = await acquireInstanceLock(fixture.dir, { log: () => {} });
  t.after(() => holder.release());

  await assert.rejects(
    () => recover({ dataDir: fixture.dir, log: () => {} }),
    (err: unknown) => err instanceof LockHeldError,
  );
  // 拒绝启动时不得动日志：那不是它的日志
  assert.deepEqual(fixture.types(), ['wake/manual']);
});

test('恢复中途失败：放锁并抛出，不把死进程留在锁文件里', async (t) => {
  const fixture = makeFixture(t, [wakeManual(1)]);
  // 伪造一个中间坏行（完整行但非法 JSON）：EventLog.open 必须拒绝启动
  fixture.appendRaw('{ not json }\n');

  await assert.rejects(() => recover({ dataDir: fixture.dir, log: () => {} }));
  assert.equal(existsSync(join(fixture.dir, 'lock.json')), false, '失败路径必须释放锁');
});
