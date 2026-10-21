/**
 * 事件日志测试：对应 milestones.md M1-1 / M1-2 / M1-3 与 review.md 缺陷 1 / 缺陷 8 的验收面。
 *
 * 说明：Node 的类型剥离不做 `.js` → `.ts` 映射，所以这里用显式 `.ts` 说明符导入源码；
 * tsconfig 的 include 只有 src/，测试文件不参与 tsc 类型检查，由 node --test 直接执行。
 */

import assert from 'node:assert/strict';
import {
  appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test, { type TestContext } from 'node:test';
import { EventLog, writeShardLine, type EventLogOpenOptions } from '../src/log/event-log.ts';
import type { AppEvent } from '../src/log/types.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const FIRST_SHARD = '000000000001.jsonl';
/** 固定基准时刻：事件内容必须可重复构造，才能逐字节比对 */
const EPOCH_MS = 1_780_000_000_000;

function makeEvent(seq: number): AppEvent {
  return {
    seq,
    ts: new Date(EPOCH_MS + seq * 1000).toISOString(),
    type: 'message/user',
    // 多字节负载专门用来压测字节偏移与流式切行的正确性
    data: { text: `第 ${seq} 条事件 — 多字节负载 ✅ \\ "quote"`, source: 'human' },
    visibility: 'model',
  } as AppEvent;
}

function textOf(event: AppEvent): string {
  return (event.data as { text: string }).text;
}

async function collect(iterable: AsyncIterable<AppEvent>): Promise<AppEvent[]> {
  const out: AppEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

interface Fixture {
  dir: string;
  open: (options?: EventLogOpenOptions) => Promise<EventLog>;
  pathOf: (file?: string) => string;
}

function setup(t: TestContext): Fixture {
  const dir = tempDirSync('irmia-eventlog-');
  const opened: EventLog[] = [];
  t.after(() => {
    // Windows 下必须先关 fd 才能删目录
    for (const log of opened) {
      try {
        log.close();
      } catch {
        // 已关闭或已失效：清理阶段忽略
      }
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return {
    dir,
    open: async (options) => {
      const log = await EventLog.open(dir, options);
      opened.push(log);
      return log;
    },
    pathOf: (file = FIRST_SHARD) => join(dir, file),
  };
}

/** 写入 n 条观测类事件：每 1000 条用一次承诺类同步落盘，模拟真实混合节奏 */
function writeMany(log: EventLog, n: number): void {
  for (let i = 0; i < n; i++) {
    const seq = log.nextSeq();
    log.append(makeEvent(seq), { sync: seq % 1000 === 0 });
  }
  log.flush();
}

test('空目录 open：不预建分片，首次写入才落盘；seq 从 1 起、readAll 为空', async (t) => {
  const fx = setup(t);
  const log = await fx.open();

  assert.equal(log.repair, null);
  assert.equal(log.latestSeq(), 0);
  assert.deepEqual(log.shardFiles, []);
  assert.equal(existsSync(fx.pathOf()), false);
  assert.equal(log.nextSeq(), 1);
  assert.equal(log.nextSeq(), 2);
  assert.deepEqual(await collect(log.readAll()), []);
  assert.equal(log.get(1), null);

  // 分配 seq 本身不产生文件（空洞合法），只有真正 append 才建分片；
  // 分片文件名取该片首条事件的 seq，所以首条写入 seq=3 时得到 000000000003.jsonl
  log.append(makeEvent(3), { sync: true });
  assert.deepEqual(log.shardFiles, ['000000000003.jsonl']);
  assert.equal(
    readFileSync(fx.pathOf('000000000003.jsonl'), 'utf8').startsWith('{"seq":3,'),
    true,
  );

  log.close();
  assert.throws(() => log.append(makeEvent(4), { sync: true }), /已关闭/);
});

test('nextSeq 重启后从日志最大 seq + 1 接续', async (t) => {
  const fx = setup(t);
  const first = await fx.open();
  assert.equal(first.nextSeq(), 1);
  first.append(makeEvent(1), { sync: true });
  first.append(makeEvent(2), { sync: true });
  first.close();

  const second = await fx.open();
  assert.equal(second.latestSeq(), 2);
  assert.equal(second.nextSeq(), 3);
  assert.equal(second.nextSeq(), 4);
  second.close();
});

test('写 10000 条：逐条读回内容一致、seq 无重复且严格递增', async (t) => {
  const fx = setup(t);
  const log = await fx.open();
  writeMany(log, 10_000);
  assert.equal(log.latestSeq(), 10_000);

  const read = await collect(log.readAll());
  assert.equal(read.length, 10_000);
  const seen = new Set<number>();
  for (let i = 0; i < read.length; i++) {
    const event = read[i]!;
    assert.deepEqual(event, makeEvent(i + 1));
    assert.equal(seen.has(event.seq), false);
    seen.add(event.seq);
  }
  assert.equal(seen.size, 10_000);
});

test('写入分级：sync=true 立刻落盘，sync=false 只进缓冲且 get() 可见', async (t) => {
  const fx = setup(t);
  const log = await fx.open();

  log.append(makeEvent(1), { sync: true });
  assert.ok(readFileSync(fx.pathOf(), 'utf8').includes('"seq":1,'));

  const buffered = makeEvent(2);
  log.append(buffered, { sync: false });
  assert.equal(readFileSync(fx.pathOf(), 'utf8').includes('"seq":2,'), false);
  assert.equal(log.bufferedCount, 1);
  assert.deepEqual(log.get(2), buffered);
  assert.equal(log.latestSeq(), 2);

  log.flush();
  assert.equal(log.bufferedCount, 0);
  const text = readFileSync(fx.pathOf(), 'utf8');
  assert.ok(text.includes('"seq":1,') && text.includes('"seq":2,'));
  // 缓冲落盘后行序仍等于 seq 升序
  assert.ok(text.indexOf('"seq":1,') < text.indexOf('"seq":2,'));
});

test('承诺类事件会先把缓冲落盘，保证文件内行序恒为 seq 升序', async (t) => {
  const fx = setup(t);
  const log = await fx.open();
  for (const seq of [1, 2, 3]) log.append(makeEvent(seq), { sync: false });
  log.append(makeEvent(4), { sync: true });

  const lines = readFileSync(fx.pathOf(), 'utf8').split('\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 4);
  assert.deepEqual(
    lines.map((line) => (JSON.parse(line) as AppEvent).seq),
    [1, 2, 3, 4],
  );
});

test('末行写一半：启动时截断自愈并报告 truncatedBytes / lastGoodSeq', async (t) => {
  const fx = setup(t);
  const log = await fx.open();
  for (let seq = 1; seq <= 10; seq++) log.append(makeEvent(seq), { sync: true });
  log.close();

  const path = fx.pathOf();
  const goodSize = statSync(path).size;
  const partial = '{"seq":11,"ts":"2026-09-29T14:02:11.482+08:00","type":"message/user"';
  appendFileSync(path, partial);
  assert.equal(statSync(path).size, goodSize + Buffer.byteLength(partial));

  const repaired = await fx.open();
  assert.notEqual(repaired.repair, null);
  assert.equal(repaired.repair?.file, FIRST_SHARD);
  assert.equal(repaired.repair?.truncatedBytes, Buffer.byteLength(partial));
  assert.equal(repaired.repair?.lastGoodSeq, 10);
  assert.equal(statSync(path).size, goodSize);
  assert.equal(repaired.latestSeq(), 10);
  assert.equal(repaired.nextSeq(), 11);
  assert.equal((await collect(repaired.readAll())).length, 10);

  // 修复后必须能无缝续写，且不会与被截断的残行粘在一起
  repaired.append(makeEvent(11), { sync: true });
  repaired.close();

  const after = await fx.open();
  assert.equal(after.repair, null);
  const read = await collect(after.readAll());
  assert.equal(read.length, 11);
  assert.deepEqual(read[10], makeEvent(11));
});

test('末行完整但缺换行：补回换行，后续追加不粘连', async (t) => {
  const fx = setup(t);
  const log = await fx.open();
  for (let seq = 1; seq <= 3; seq++) log.append(makeEvent(seq), { sync: true });
  log.close();

  const path = fx.pathOf();
  const content = readFileSync(path, 'utf8');
  writeFileSync(path, content.slice(0, -1));
  // 注意：内容含多字节字符，字节数必须用 Buffer.byteLength，不能拿字符串长度当字节数
  assert.equal(statSync(path).size, Buffer.byteLength(content) - 1);

  const reopened = await fx.open();
  assert.equal(reopened.repair, null);
  assert.equal(statSync(path).size, Buffer.byteLength(content));
  reopened.append(makeEvent(4), { sync: true });
  reopened.close();

  const read = await collect(await (await fx.open()).readAll());
  assert.equal(read.length, 4);
  assert.deepEqual(read[3], makeEvent(4));
});

test('中间位置的坏行属于真故障：拒绝启动', async (t) => {
  const fx = setup(t);
  const build = async (): Promise<string> => {
    const log = await fx.open();
    for (let seq = 1; seq <= 5; seq++) log.append(makeEvent(seq), { sync: true });
    log.close();
    return readFileSync(fx.pathOf(), 'utf8');
  };

  const content = await build();
  const lines = content.split('\n').filter((line) => line.length > 0);

  // 中部插入完整坏行（后面还有合法事件）
  lines.splice(2, 0, 'this is not json');
  writeFileSync(fx.pathOf(), `${lines.join('\n')}\n`);
  await assert.rejects(fx.open(), /不是合法 JSON/);

  // 末尾的完整坏行同样是真故障：它已经以换行结束，不是"写了一半"
  writeFileSync(fx.pathOf(), `${content}oops\n`);
  await assert.rejects(fx.open(), /不是合法 JSON/);

  // 缺字段的"合法 JSON"也拒绝
  writeFileSync(fx.pathOf(), `${content}{"ts":"2026-09-29T14:02:11+08:00","type":"x"}\n`);
  await assert.rejects(fx.open(), /seq/);
});

test('重复 seq 拒绝启动（日志被拼接或分片重叠）', async (t) => {
  const fx = setup(t);
  const log = await fx.open();
  for (let seq = 1; seq <= 3; seq++) log.append(makeEvent(seq), { sync: true });
  log.close();

  const path = fx.pathOf();
  const duplicated = makeEvent(3);
  appendFileSync(path, `${JSON.stringify(duplicated)}\n`);
  await assert.rejects(fx.open(), /重复 seq 3/);
});

test('分片轮转：超阈值新建分片、旧片不丢、文件名等于该片首条 seq', async (t) => {
  const fx = setup(t);
  const log = await fx.open({ shardMaxBytes: 2000 });
  writeMany(log, 60);

  const files = log.shardFiles;
  assert.ok(files.length >= 3, `期望触发多次轮转，实际只有 ${files.length} 个分片`);
  assert.equal(files[0], FIRST_SHARD);

  const singleLineBytes = Buffer.byteLength(`${JSON.stringify(makeEvent(1))}\n`);
  for (const file of files) {
    const raw = readFileSync(fx.pathOf(file), 'utf8');
    const lines = raw.split('\n').filter((line) => line.length > 0);
    assert.ok(lines.length > 0);
    // 12 位定宽文件名 + 首行 seq 对齐
    assert.equal(Number(file.slice(0, 12)), (JSON.parse(lines[0]!) as AppEvent).seq);
    assert.ok(statSync(fx.pathOf(file)).size <= 2000 + singleLineBytes);
  }

  // 旧片不丢：跨分片流式读回必须完整
  const read = await collect(log.readAll());
  assert.equal(read.length, 60);
  for (let i = 0; i < read.length; i++) assert.deepEqual(read[i], makeEvent(i + 1));

  // 轮转后随机访问仍能跨片命中
  assert.deepEqual(log.get(1), makeEvent(1));
  assert.deepEqual(log.get(60), makeEvent(60));
  assert.equal(log.get(61), null);

  // 重启后重建索引：分片沿用（分片延迟创建，重启不留下空片），不新建
  log.close();
  const reopened = await fx.open({ shardMaxBytes: 2000 });
  assert.deepEqual(reopened.shardFiles, files);
  assert.equal(reopened.nextSeq(), 61);
  assert.equal((await collect(reopened.readAll())).length, 60);
  assert.deepEqual(reopened.get(45), makeEvent(45));
});

test('手工删掉中间一条事件：readAll 跳过空洞、get 返回 null、水位不卡死', async (t) => {
  const fx = setup(t);
  const log = await fx.open();
  for (let seq = 1; seq <= 20; seq++) log.append(makeEvent(seq), { sync: true });
  log.close();

  const path = fx.pathOf();
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
  lines.splice(6, 1);
  writeFileSync(path, `${lines.join('\n')}\n`);

  const reopened = await fx.open();
  assert.equal(reopened.latestSeq(), 20);

  const read = await collect(reopened.readAll());
  assert.equal(read.length, 19);
  assert.equal(read.some((event) => event.seq === 7), false);
  assert.deepEqual(
    read.map((event) => event.seq),
    [...Array.from({ length: 6 }, (_, i) => i + 1), ...Array.from({ length: 13 }, (_, i) => i + 8)],
  );

  assert.equal(reopened.get(7), null);
  assert.deepEqual(reopened.get(6), makeEvent(6));
  assert.deepEqual(reopened.get(8), makeEvent(8));

  // 模拟水位推进：从 1 走到末尾，空洞不能让推进停住
  let watermark = 0;
  for (let seq = 1; seq <= reopened.latestSeq(); seq++) {
    if (reopened.get(seq) === null) continue;
    watermark = seq;
  }
  assert.equal(watermark, 20);

  // 空洞不影响后续分配
  assert.equal(reopened.nextSeq(), 21);
});

test('get(seq) 随机访问正确，且从检查点定位（平均 < 1ms）', async (t) => {
  const fx = setup(t);
  const log = await fx.open();
  writeMany(log, 10_000);

  const expected = new Map<number, string>();
  for (let seq = 1; seq <= 10_000; seq++) expected.set(seq, textOf(makeEvent(seq)));

  let checksum = 0;
  const queries = Array.from({ length: 500 }, () => 1 + Math.floor(Math.random() * 10_000));
  const started = performance.now();
  for (const seq of queries) {
    const event = log.get(seq);
    assert.notEqual(event, null);
    assert.equal(event!.seq, seq);
    assert.equal(textOf(event!), expected.get(seq));
    checksum += seq;
  }
  const perCall = (performance.now() - started) / queries.length;
  t.diagnostic(`get(seq) 平均 ${perCall.toFixed(3)}ms/次（目标 < 1ms，500 次查询）`);
  assert.ok(checksum > 0);
  assert.ok(perCall < 1, `稀疏索引随机访问过慢：${perCall.toFixed(3)}ms/次`);

  // 越界与非法输入
  assert.equal(log.get(10_001), null);
  assert.equal(log.get(0), null);
  assert.equal(log.get(-1), null);

  // 检查点密度：每 1000 条一个，10000 条事件应有 10 个检查点起点可复用
  const sample = [1000, 2000, 5000, 9000, 9999];
  for (const seq of sample) assert.equal(log.get(seq)!.seq, seq);
});

test('readRange 从任意 seq 起流式返回，跨分片不重不漏', async (t) => {  const fx = setup(t);
  const log = await fx.open({ shardMaxBytes: 2000 });
  writeMany(log, 30);
  assert.ok(log.shardFiles.length >= 3);

  const from11 = await collect(log.readRange(11));
  assert.equal(from11.length, 20);
  assert.equal(from11[0]!.seq, 11);
  assert.equal(from11[19]!.seq, 30);

  const from14 = await collect(log.readRange(14));
  assert.deepEqual(
    from14.map((event) => event.seq),
    Array.from({ length: 17 }, (_, i) => i + 14),
  );

  const all = await collect(log.readRange(1));
  assert.equal(all.length, 30);

  const beyond = await collect(log.readRange(31));
  assert.deepEqual(beyond, []);

  await assert.rejects(async () => {
    for await (const _ of log.readRange(0)) break;
  }, /fromSeq/);
});

// ───────────────────── 半行（REVIEW P1-18）：写侧回滚 + 读侧自愈 ─────────────────────

test('P1-18 写失败：writeShardLine 抛错、文件一个字节都不许长出来（半个行不许留）', async (t) => {
  // 这条钉的是"写失败会把半个行留在分片中间"的**写侧**那一半。
  // 真实世界里它由磁盘满 / EIO 触发（本机造不出来），所以判据放在那个唯一写入口上：
  // 抛错之前必须把这次写进去的半截截掉（回滚到写前长度）。
  const fx = setup(t);
  const log = await fx.open();
  log.append(makeEvent(1), { sync: true });
  log.close();
  const path = fx.pathOf();
  const size = statSync(path).size;

  // 反：只读 fd ⇒ 写必然失败；失败之后文件长度必须还是原来那个数
  const readOnlyFd = openSync(path, 'r');
  try {
    assert.throws(
      () => writeShardLine(readOnlyFd, '{"seq":2,"ts":"x","type":"y"}\n', size),
      /分片写入失败/,
      '写失败要抛（不许静默吞掉）',
    );
  } finally {
    closeSync(readOnlyFd);
  }
  assert.equal(statSync(path).size, size, '失败之后文件长度不许变（半行 = 下次启动拒绝启动）');

  // 正：同一个入口在可写 fd 上写成功，且总是**整行**
  const appendFd = openSync(path, 'a');
  const line = '{"seq":2,"ts":"2026-09-29T14:02:11.000Z","type":"message/user"}\n';
  try {
    writeShardLine(appendFd, line, size);
  } finally {
    closeSync(appendFd);
  }
  assert.equal(statSync(path).size, size + Buffer.byteLength(line));
  assert.equal(readFileSync(path, 'utf8').endsWith(line), true);
});

test('P1-18 半行拼接（写失败后进程继续写）：启动自愈——可继续、有 repair 读数、好行一个不丢', async (t) => {
  // 形状：第 6 条只写了半个 JSON，进程没死，第 7 条接在它后面 ⇒ 这一"行"以换行结尾却解析不出来。
  // 改动前：`scanShard` 把它当坏行**拒绝启动**。改动后：认出接缝（尾部是一条完整事件）、
  // 只删那半个行，并留一条 repair 记录（recover.ts 据此写 `log/repaired` 与告警）。
  const fx = setup(t);
  const log = await fx.open();
  for (let seq = 1; seq <= 5; seq++) log.append(makeEvent(seq), { sync: true });
  log.close();

  const path = fx.pathOf();
  const goodSize = statSync(path).size;
  const half = '{"seq":6,"ts":"2026-09-29T14:02:11.482+08:00","type":"message/user"';
  const seventh = `${JSON.stringify(makeEvent(7))}\n`;
  appendFileSync(path, half);
  appendFileSync(path, seventh);
  assert.equal(statSync(path).size, goodSize + Buffer.byteLength(half) + Buffer.byteLength(seventh));

  const healed = await fx.open();
  // 告警那一侧：`repair` 就是"修过什么"的读数（recover.ts 拿它写 log/repaired + 告警行）
  assert.notEqual(healed.repair, null, '修了就必须报（不许静默自愈）');
  assert.equal(healed.repair?.file, FIRST_SHARD);
  assert.equal(healed.repair?.truncatedBytes, Buffer.byteLength(half), '报的就是那半个行的字节数');
  assert.equal(healed.repair?.lastGoodSeq, 7, '最后一条完整事件是 seq 7（被接在后面的那条）');
  assert.equal(
    statSync(path).size,
    goodSize + Buffer.byteLength(seventh),
    '只删那半个行：后面那条好事件一个字节都不许丢',
  );
  assert.equal(healed.latestSeq(), 7);
  assert.equal(healed.nextSeq(), 8);
  const read = await collect(healed.readAll());
  assert.deepEqual(read.map((event) => event.seq), [1, 2, 3, 4, 5, 7]);

  // 续写不粘连：修完之后新事件照样整行落盘、再启动一次干净
  healed.append(makeEvent(8), { sync: true });
  healed.close();
  const again = await fx.open();
  assert.equal(again.repair, null, '自愈是幂等的：第二次启动没有什么可修');
  assert.deepEqual((await collect(again.readAll())).map((event) => event.seq), [1, 2, 3, 4, 5, 7, 8]);
});

test('P1-18 中间分片的末行也只写了一半：同样自愈（不拒启动），且报得出是哪一片', async (t) => {
  // 另一种真实形态：写失败留下半行、下一次轮转先发生 ⇒ 那半行落在**不是最后一个**的分片末尾。
  // 改动前它是"真故障"（拒绝启动）；改动后与末片同一条自愈路径。
  const fx = setup(t);
  const log = await fx.open({ shardMaxBytes: 600 });
  writeMany(log, 12);
  const files = log.shardFiles;
  assert.ok(files.length >= 2, `夹具要至少两个分片，实际 ${files.length}`);
  log.close();

  const first = fx.pathOf(files[0]!);
  const goodSize = statSync(first).size;
  const half = '{"seq":9999,"ts":"2026-09-29T14:02:11.482+08:00","type":"message/user"';
  appendFileSync(first, half);

  const reopened = await fx.open({ shardMaxBytes: 600 });
  assert.equal(reopened.repair?.file, files[0], '报的就是那一片（不是"最后一个分片"）');
  assert.equal(reopened.repair?.truncatedBytes, Buffer.byteLength(half));
  assert.equal(reopened.repair?.lastGoodSeq, 12, '给的是整份日志最后一条完整事件');
  assert.equal(statSync(first).size, goodSize, '只截那半截');
  assert.equal((await collect(reopened.readAll())).length, 12, '全部好行照旧读得回来');
  assert.equal(reopened.nextSeq(), 13);
});

test('P1-18 反：坏行不"看起来像半行"就照旧拒绝启动（判据没被放宽）', async (t) => {
  const fx = setup(t);
  const build = async (): Promise<string> => {
    const log = await fx.open();
    for (let seq = 1; seq <= 5; seq++) log.append(makeEvent(seq), { sync: true });
    log.close();
    return readFileSync(fx.pathOf(), 'utf8');
  };
  const content = await build();
  const lines = content.split('\n').filter((line) => line.length > 0);

  // ① 尾部不是完整事件的坏行（接缝不存在）：老判据不许放宽
  lines.splice(2, 0, '{"seq":6,"ts":"2026-09-29T14:02:11.482+08:00","ty');
  writeFileSync(fx.pathOf(), `${lines.join('\n')}\n`);
  await assert.rejects(fx.open(), /不是合法 JSON/);

  // ② "半行 + 一条**旧**事件"：恢复出来的 seq 不大于本片已收下的 ⇒ 不是写失败的接缝，拒绝
  const stale = readFileSync(fx.pathOf(), 'utf8').split('\n').filter((line) => line.length > 0);
  const half = '{"seq":6,"ts":"2026-09-29T14:02:11.482+08:00","type":"message/user"';
  stale.splice(3, 0, `${half}${JSON.stringify(makeEvent(2))}`);
  writeFileSync(fx.pathOf(), `${stale.join('\n')}\n`);
  await assert.rejects(fx.open(), /不是合法 JSON/);

  // ③ 末行残行（写一半就崩、后面没有别的事件）仍走"截断"那条老路，不误删好行
  writeFileSync(fx.pathOf(), content);
  appendFileSync(fx.pathOf(), half);
  const truncated = await fx.open();
  assert.equal(truncated.repair?.truncatedBytes, Buffer.byteLength(half));
  assert.deepEqual((await collect(truncated.readAll())).map((event) => event.seq), [1, 2, 3, 4, 5]);
});

test('P1-18 半行拼接后接的那条也是"写了一半"：删半行 + 补尾换行两步都走，好行仍保住', async (t) => {
  // 两个写失败叠在一起：第 6 条半个行 + 第 7 条也没写完换行（但它本身是完整 JSON）。
  // 这两种自愈在同一次启动里都要生效：删掉那半个行，再给缺换行的尾行补一个换行。
  const fx = setup(t);
  const log = await fx.open();
  for (let seq = 1; seq <= 5; seq++) log.append(makeEvent(seq), { sync: true });
  log.close();

  const path = fx.pathOf();
  const half = '{"seq":6,"ts":"2026-09-29T14:02:11.482+08:00","type":"message/user"';
  appendFileSync(path, half);
  appendFileSync(path, JSON.stringify(makeEvent(7))); // 完整 JSON，但没有换行

  const healed = await fx.open();
  assert.equal(healed.repair?.truncatedBytes, Buffer.byteLength(half));
  assert.equal(healed.latestSeq(), 7);
  assert.deepEqual((await collect(healed.readAll())).map((event) => event.seq), [1, 2, 3, 4, 5, 7]);
  healed.close();
  // 补的那一个换行也在：再启动一次不修复、能续写
  const again = await fx.open();
  assert.equal(again.repair, null);
  again.append(makeEvent(8), { sync: true });
  again.close();
  const fin = await fx.open();
  assert.deepEqual((await collect(fin.readAll())).map((event) => event.seq), [1, 2, 3, 4, 5, 7, 8]);
});
