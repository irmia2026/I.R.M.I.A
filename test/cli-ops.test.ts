/**
 * CLI 运维命令测试 — persona log/diff/rollback 与 export（docs/operations.md §6 的 CLI 表）
 *
 * 三条纪律沿用 cli-observe.test.ts：
 *   1. 一个用例一个临时目录（rollback 写日志要求"没有第二个写者"）；
 *   2. 断言首选"日志里有什么"，其次才是命令输出文本；
 *   3. 时间全部钉死在假时钟上。
 *
 * 特别关注的两件事：
 *   - **回滚必须可回滚**：回滚前的内容要进版本库，否则一次人工误操作就永久丢失了当前人格；
 *   - **写日志前必须探锁**：主进程活着时回滚应当拒绝（退出码 3），否则两个写者撞 seq
 *     会让日志下次启动直接拒绝启动。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  buildExport, buildPersonaDiff, buildPersonaLog, runCli, type CliIO,
} from '../src/cli.ts';
import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent } from '../src/log/types.js';
import { defaultVisibility } from '../src/log/types.ts';
import { readPersonaVersion, sha256Hex, writePersonaVersion } from '../src/persona/versions.ts';
import { LOCK_FILE_NAME } from '../src/runtime/instance-lock.ts';
import { EVENT_LOG_DIR_NAME } from '../src/runtime/recover.ts';

const T0 = '2026-06-01T10:00:00.000Z';
const OLD = '# 当前状态\n\n第一版。\n第二行。\n第三行。\n';
const NEW = '# 当前状态\n\n第二版。\n第三行。\n第四行。\n';
const OLD_HASH = sha256Hex(OLD);
const NEW_HASH = sha256Hex(NEW);

// ──────────────────────────────── 脚手架 ────────────────────────────────

interface Fixture {
  dir: string;
  log: EventLog;
  append: (type: string, data: unknown) => AppEvent;
  close: () => void;
  readAll: () => Promise<AppEvent[]>;
}

async function setup(t: TestContext, options: { seedVersionStore?: boolean } = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-cli-ops-'));
  mkdirSync(join(dir, 'persona'), { recursive: true });
  writeFileSync(join(dir, 'persona', 'STATE.md'), NEW, 'utf8');
  if (options.seedVersionStore !== false) {
    await writePersonaVersion(dir, 'STATE.md', OLD);
  }

  const log = await EventLog.open(join(dir, EVENT_LOG_DIR_NAME));
  t.after(() => {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const append = (type: string, data: unknown): AppEvent => {
    const event = {
      seq: log.nextSeq(),
      ts: T0,
      type,
      data,
      visibility: defaultVisibility(type),
      origin: 'test/cli-ops',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    return event;
  };

  return {
    dir,
    log,
    append,
    close: () => log.close(),
    readAll: async () => {
      const reader = await EventLog.open(join(dir, EVENT_LOG_DIR_NAME));
      const out: AppEvent[] = [];
      try {
        for await (const event of reader.readAll()) out.push(event);
      } finally {
        reader.close();
      }
      return out;
    },
  };
}

/** 造一份"改过两次"的人格历史：OLD 先落版本库，再记 OLD → NEW 两条 persona/updated */
async function withPersonaHistory(t: TestContext, options: { seedVersionStore?: boolean } = {}): Promise<Fixture> {
  const fx = await setup(t, options);
  fx.append('persona/updated', { file: 'STATE.md', diffHash: OLD_HASH, by: 'agent' });
  fx.append('persona/updated', { file: 'STATE.md', diffHash: NEW_HASH, by: 'agent' });
  return fx;
}

function collector(): { io: CliIO; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { io: { out: (line) => lines.push(line), err: (line) => errors.push(line) }, lines, errors };
}

// ──────────────────────────────── persona log ────────────────────────────────

test('persona log：按 persona/updated 倒序给出演化时间线，并标出快照是否在库', async (t) => {
  const fx = await withPersonaHistory(t);

  const entries = buildPersonaLog(fx.dir);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.diffHash, NEW_HASH, '最近一次改动排最前');
  assert.equal(entries[1]!.diffHash, OLD_HASH);
  assert.equal(entries[0]!.by, 'agent');
  assert.notEqual(entries[1]!.snapshotPath, null, 'OLD 的快照已在版本库里');
  assert.equal(entries[0]!.snapshotPath, null, 'NEW 还没进版本库');

  const cli = collector();
  assert.equal(await runCli(['persona', 'log'], cli.io, { dataDir: fx.dir }), 0);
  const text = cli.lines.join('\n');
  assert.match(text, /人格演化 2 条/);
  assert.match(text, new RegExp(NEW_HASH.slice(0, 8)));
  assert.match(text, /版本库无此快照/);

  // --json 给机器消费
  const json = collector();
  assert.equal(await runCli(['persona', 'log', '--json'], json.io, { dataDir: fx.dir }), 0);
  const parsed = JSON.parse(json.lines.join('\n')) as Array<{ diffHash: string }>;
  assert.deepEqual(parsed.map((item) => item.diffHash), [NEW_HASH, OLD_HASH]);

  // 未知参数 → 退出码 2
  const bad = collector();
  assert.equal(await runCli(['persona', 'log', '--oops'], bad.io, { dataDir: fx.dir }), 2);
  assert.match(bad.errors.join('\n'), /无法识别的参数/);
});

test('persona log：事件里那 16 位前缀也要认出**在库**的快照（版本库文件名是满 64 位）', async (t) => {
  // 现场：2026-10-11 之前 GUI 直编那条通道往事件里写 `.slice(0, 16)`，版本库的快照文件名却是
  // `sha256Hex(content)` 的满 64 位 ⇒ 直接拿事件里那串拼路径，会把在库的快照说成"版本库无此快照"
  const fx = await setup(t);
  fx.append('persona/updated', { file: 'STATE.md', diffHash: OLD_HASH.slice(0, 16), by: 'human' });

  const entries = buildPersonaLog(fx.dir);
  assert.equal(entries[0]!.diffHash, OLD_HASH.slice(0, 16), '事件里那串是历史事实，原样报');
  assert.notEqual(entries[0]!.snapshotPath, null, '但快照必须认出在库（解一次唯一前缀）');

  const cli = collector();
  assert.equal(await runCli(['persona', 'log'], cli.io, { dataDir: fx.dir }), 0);
  assert.match(cli.lines.join('\n'), /快照在库/);
  assert.ok(!cli.lines.join('\n').includes('版本库无此快照'));
});

// ──────────────────────────────── persona diff ────────────────────────────────

test('persona diff：当前与上一版本快照逐行对照，行号可读', async (t) => {
  const fx = await withPersonaHistory(t);

  const result = buildPersonaDiff(fx.dir, 'STATE.md');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const report = result.report;
  assert.equal(report.currentHash, NEW_HASH);
  assert.equal(report.currentEvented, true, '当前内容与最近一条 persona/updated 一致');
  assert.equal(report.previous?.diffHash, OLD_HASH);
  assert.equal(report.previous?.by, 'agent');
  assert.ok(report.stats.added >= 1 && report.stats.removed >= 1);

  const cli = collector();
  assert.equal(await runCli(['persona', 'diff', 'STATE.md'], cli.io, { dataDir: fx.dir }), 0);
  const text = cli.lines.join('\n');
  assert.match(text, /人格差异 · STATE\.md/);
  // 行级对照：`- 旧行号 | 被删内容`、`+ 新行号 | 新增内容`（删行没有新行号，反之亦然）
  const diffRows = cli.lines.filter((line) => line.includes('│'));
  assert.ok(diffRows.some((line) => line.includes('-') && line.includes('第一版。')), text);
  assert.ok(diffRows.some((line) => line.includes('+') && line.includes('第二版。')), text);
  assert.match(text, /\+1 \/ -1|\+\d+ \/ -\d+/);
});

test('persona diff：接受 persona/ 前缀写法；文件不存在或路径越界退出码 2', async (t) => {
  const fx = await withPersonaHistory(t);

  const cli = collector();
  assert.equal(await runCli(['persona', 'diff', 'persona/STATE.md'], cli.io, { dataDir: fx.dir }), 0);
  assert.match(cli.lines.join('\n'), /人格差异 · STATE\.md/);

  const missing = collector();
  assert.equal(await runCli(['persona', 'diff', 'NOPE.md'], missing.io, { dataDir: fx.dir }), 2);
  assert.match(missing.errors.join('\n'), /没有这个人格文件/);

  const escape = collector();
  assert.equal(await runCli(['persona', 'diff', '../secret.md'], escape.io, { dataDir: fx.dir }), 2);
  assert.match(escape.errors.join('\n'), /\.\./);
});

test('persona diff：当前内容被人工直改时如实标注，并拿最后一条记录当对照', async (t) => {
  const fx = await withPersonaHistory(t);
  writeFileSync(join(fx.dir, 'persona', 'STATE.md'), '# 当前状态\n\n人类手改的版本。\n', 'utf8');

  const result = buildPersonaDiff(fx.dir, 'STATE.md');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.currentEvented, false);
  assert.equal(result.report.previous?.diffHash, NEW_HASH, '对照 = 日志里最后一条内容不同的记录');
  assert.ok(result.report.notes.some((note) => note.includes('不一致')));
});

test('persona diff：版本库缺快照时不编造内容，只报事件记录', async (t) => {
  const fx = await withPersonaHistory(t, { seedVersionStore: false });

  const result = buildPersonaDiff(fx.dir, 'STATE.md');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.previous?.snapshotPath, null);
  assert.equal(result.report.lines.length, 0);
  assert.ok(result.report.notes.some((note) => note.includes('版本库里缺')));

  const cli = collector();
  assert.equal(await runCli(['persona', 'diff', 'STATE.md'], cli.io, { dataDir: fx.dir }), 0);
  assert.match(cli.lines.join('\n'), /版本库缺这份内容/);
});

test('persona diff：日志那条只有 16 位（GUI 直编通道）⇒ 不报"不一致"，对照取更早那条', async (t) => {
  // 现场（真 data/ 上三个文件都是这个形状）：事件里记的是 `.slice(0, 16)`，盘上重算是满 64 位
  // ⇒ 拿 64 比 16，内容一字不差也判"不一致"，而且会把**最近那条**当成"上一版本"（当前 vs 当前）
  const fx = await setup(t);
  fx.append('persona/updated', { file: 'STATE.md', diffHash: OLD_HASH, by: 'agent' });
  fx.append('persona/updated', { file: 'STATE.md', diffHash: NEW_HASH.slice(0, 16), by: 'human' });

  const result = buildPersonaDiff(fx.dir, 'STATE.md');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.currentEvented, true, '16 位前缀与满 64 位说的是同一份内容');
  assert.equal(result.report.previous?.diffHash, OLD_HASH, '对照是**更早**那条，不是当前这条自己');
  assert.notEqual(result.report.previous?.snapshotPath, null, '在库的快照不许被报成缺');
  assert.ok(!result.report.notes.some((note) => note.includes('不一致')), '不许留下假的"不一致"注');
  assert.ok(!result.report.notes.some((note) => note.includes('版本库里缺')), '快照在库就不许说缺');
  assert.ok(result.report.stats.removed >= 1 && result.report.stats.added >= 1, '真比出了差异');

  const cli = collector();
  assert.equal(await runCli(['persona', 'diff', 'STATE.md'], cli.io, { dataDir: fx.dir }), 0);
  assert.match(cli.lines.join('\n'), /与日志最近一条 persona\/updated 一致/);
});

test('persona diff：只有一条记录（16 位那条）⇒ 说"没有更早的版本可比"，不印假 diff', async (t) => {
  const fx = await setup(t, { seedVersionStore: false });
  fx.append('persona/updated', { file: 'STATE.md', diffHash: NEW_HASH.slice(0, 16), by: 'human' });

  const result = buildPersonaDiff(fx.dir, 'STATE.md');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.currentEvented, true);
  assert.equal(result.report.previous, null, '没有更早的版本 ⇒ 不许把最近那条拿来当对照');
  assert.equal(result.report.lines.length, 0, '没有对照就没有 diff 行');

  const cli = collector();
  assert.equal(await runCli(['persona', 'diff', 'STATE.md'], cli.io, { dataDir: fx.dir }), 0);
  const text = cli.lines.join('\n');
  assert.match(text, /对照：无（日志里只有当前这一版：没有更早的版本可比）/);
  assert.ok(!text.includes('来自 seq'), '没有任何"对照"记录时不许印出对照行');
});

test('persona diff：16 位那条 + 内容真改过 ⇒ 仍如实报"不一致"（判据没被放宽）', async (t) => {
  const fx = await setup(t);
  fx.append('persona/updated', { file: 'STATE.md', diffHash: NEW_HASH.slice(0, 16), by: 'human' });
  writeFileSync(join(fx.dir, 'persona', 'STATE.md'), '# 当前状态\n\n被人手改了。\n', 'utf8');

  const result = buildPersonaDiff(fx.dir, 'STATE.md');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.currentEvented, false, '改过一个字就不是同一份内容');
  assert.equal(result.report.previous?.diffHash, NEW_HASH.slice(0, 16), '对照仍是那条记录（记的是改前的内容）');
  assert.equal(result.report.previous?.snapshotPath, null, '那份内容从没进过版本库（写入时不存新内容）');
  assert.ok(result.report.notes.some((note) => note.includes('不一致')));
});

// ──────────────────────────────── persona rollback ────────────────────────────────

test('persona rollback：写回快照内容 + 记 persona/updated{by:human} + 归档回滚前内容', async (t) => {
  const fx = await withPersonaHistory(t);

  const cli = collector();
  assert.equal(await runCli(['persona', 'rollback', 'STATE.md', OLD_HASH.slice(0, 8)], cli.io, { dataDir: fx.dir }), 0);
  assert.match(cli.lines.join('\n'), /已回滚 STATE\.md/);

  // ① 文件内容回到 OLD
  assert.equal(readFileSync(join(fx.dir, 'persona', 'STATE.md'), 'utf8'), OLD);
  // ② 回滚前的内容也进了版本库：回滚本身因此可逆
  assert.equal(readPersonaVersion(fx.dir, 'STATE.md', NEW_HASH), NEW);
  // ③ 事件已落盘，by 是 human
  const events = await fx.readAll();
  const updated = events.filter((event) => event.type === 'persona/updated');
  assert.equal(updated.length, 3);
  const last = updated[updated.length - 1]!;
  assert.equal(last.type, 'persona/updated');
  if (last.type === 'persona/updated') {
    assert.equal(last.data.file, 'STATE.md');
    assert.equal(last.data.diffHash, OLD_HASH);
    assert.equal(last.data.by, 'human');
  }

  // ④ 再回滚一次回到 NEW 也可行（版本库里有它）→ 证明"回滚可回滚"
  const back = collector();
  assert.equal(await runCli(['persona', 'rollback', 'STATE.md', NEW_HASH.slice(0, 8)], back.io, { dataDir: fx.dir }), 0);
  assert.equal(readFileSync(join(fx.dir, 'persona', 'STATE.md'), 'utf8'), NEW);
});

test('persona rollback：主进程在跑时拒绝写（退出码 3），文件与日志都不动', async (t) => {
  const fx = await withPersonaHistory(t);
  writeFileSync(
    join(fx.dir, LOCK_FILE_NAME),
    JSON.stringify({ pid: process.pid, startedAt: T0, heartbeatAt: T0 }),
    'utf8',
  );

  const cli = collector();
  assert.equal(await runCli(['persona', 'rollback', 'STATE.md', OLD_HASH.slice(0, 8)], cli.io, { dataDir: fx.dir }), 3);
  assert.match(cli.errors.join('\n'), /主进程正在运行/);
  assert.equal(readFileSync(join(fx.dir, 'persona', 'STATE.md'), 'utf8'), NEW, '被拒绝的写不得落盘');
  assert.equal((await fx.readAll()).filter((event) => event.type === 'persona/updated').length, 2);
});

test('persona rollback：目标不存在 / 就是当前内容 / 参数缺失，都退出码 2', async (t) => {
  const fx = await withPersonaHistory(t);

  const unknown = collector();
  assert.equal(await runCli(['persona', 'rollback', 'STATE.md', 'deadbeef'], unknown.io, { dataDir: fx.dir }), 2);
  assert.match(unknown.errors.join('\n'), /版本库里没有以 deadbeef 开头/);

  const same = collector();
  assert.equal(await runCli(['persona', 'rollback', 'STATE.md', NEW_HASH.slice(0, 8)], same.io, { dataDir: fx.dir }), 2);
  assert.match(same.errors.join('\n'), /无需回滚/);

  const missing = collector();
  assert.equal(await runCli(['persona', 'rollback', 'STATE.md'], missing.io, { dataDir: fx.dir }), 2);
  assert.match(missing.errors.join('\n'), /缺少 <diffHash>/);

  const badPrefix = collector();
  assert.equal(await runCli(['persona', 'rollback', 'STATE.md', 'XYZ'], badPrefix.io, { dataDir: fx.dir }), 2);
  assert.match(badPrefix.errors.join('\n'), /8-64 位十六进制/);
});

test('persona：未知子命令退出码 2 并给用法', async (t) => {
  const fx = await withPersonaHistory(t);
  const cli = collector();
  assert.equal(await runCli(['persona', 'nope'], cli.io, { dataDir: fx.dir }), 2);
  assert.match(cli.errors.join('\n'), /未知子命令 nope/);
});

// ──────────────────────────────── export ────────────────────────────────

test('export：区间导出为可读回的 JSONL，头信息走 stderr', async (t) => {
  const fx = await setup(t);
  for (let index = 1; index <= 6; index++) {
    fx.append('wake/manual', { note: `第 ${index} 条`, dedupeKey: `k${index}` });
  }
  fx.close();

  const report = buildExport(fx.dir, 2, 4);
  assert.equal(report.count, 3);
  assert.equal(report.badLines, 0);
  assert.deepEqual(
    report.body.split('\n').filter((line) => line !== '').map((line) => (JSON.parse(line) as AppEvent).seq),
    [2, 3, 4],
  );

  const cli = collector();
  assert.equal(await runCli(['export', '--from', '2', '--to', '4'], cli.io, { dataDir: fx.dir }), 0);
  assert.equal(cli.lines.length, 3, 'stdout 只有可重定向的 JSONL');
  assert.match(cli.errors.join('\n'), /导出 seq 2\.\.4：3 条事件/);

  const out = join(fx.dir, 'slice.jsonl');
  const toFile = collector();
  assert.equal(await runCli(['export', '--from', '5', '--to', '6', '--out', out], toFile.io, { dataDir: fx.dir }), 0);
  assert.equal(existsSync(out), true);
  assert.deepEqual(
    readFileSync(out, 'utf8').split('\n').filter((line) => line !== '').map((line) => (JSON.parse(line) as AppEvent).seq),
    [5, 6],
  );
});

test('export：参数校验（缺项 / to < from / 非整数）退出码 2', async (t) => {
  const fx = await setup(t);
  fx.append('wake/manual', { note: 'x', dedupeKey: 'k1' });
  fx.close();

  for (const args of [
    ['export', '--from', '1'],
    ['export', '--to', '3'],
    ['export', '--from', '3', '--to', '1'],
    ['export', '--from', '0', '--to', '1'],
  ]) {
    const cli = collector();
    assert.equal(await runCli(args, cli.io, { dataDir: fx.dir }), 2, args.join(' '));
    assert.ok(cli.errors.length > 0);
  }
});
