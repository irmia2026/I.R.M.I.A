/**
 * `%TEMP%` 兜底扫（`src/util/temp-sweep.ts`，2026-10-21）
 *
 * 为什么这份测试的重点不是"它能删"，而是"它**不该删**"：这个模块是全仓库唯一一个
 * 会 `rm` 别人（也就是全机所有进程）共用目录的地方。四条分寸的每一条都要有一条用例
 * 指着它说"没删"：
 *   ① 前缀不在白名单 ⇒ 不动（`other-data-*` 那条）；
 *   ② 不够老 ⇒ 不动（刚建的那个）；
 *   ③ 被占用 ⇒ 不动（把目录当 CWD，Windows 的 rename 会失败）；
 *   ④ `dry`（缺省档）⇒ **一个都不删**，只在账上写"将删 N 个 / 共 M MB"。
 *
 * 用**自己的临时根**（`tempDir('irmia-sweep-test-')`）跑，绝不碰真的 `os.tmpdir()`：
 * 这份测试自己就是"会被兜底扫扫到的人"，一旦它往真 TEMP 里造目录又忘了删，就成了新的泄漏源。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import test from 'node:test';

import { tempDir } from './helpers/temp-dirs.ts';
import {
  TEMP_SWEEP_RULES, formatTempSweepLine, parseTempSweepMode, planTempSweep,
  runStartupTempSweep, runTempSweep,
} from '../src/util/temp-sweep.ts';

const HOUR_MS = 3_600_000;

/** 造一个"25 小时前"的目录（mtime 往回拨，判据看的就是 mtime） */
function backdate(dir: string, hours: number): void {
  const at = new Date(Date.now() - hours * HOUR_MS);
  utimesSync(dir, at, at);
}

/** 三个样本：新 / 25h 前（前缀命中）/ 25h 前（**不是**我们的前缀） */
async function makeSamples(): Promise<{ root: string; fresh: string; old: string; foreign: string }> {
  const root = await tempDir('irmia-sweep-test-');
  const fresh = `${root}/irmia-setup-fresh`;
  const old = `${root}/irmia-setup-old`;
  const foreign = `${root}/other-data-old`;
  for (const dir of [fresh, old, foreign]) mkdirSync(dir, { recursive: true });
  writeFileSync(`${old}/payload.7z`, Buffer.alloc(2048));
  backdate(old, 25);
  backdate(foreign, 25);
  return { root, fresh, old, foreign };
}

test('dry（缺省档）：三个样本一个都不删，账上写「将删 1 个」', async (t) => {
  const { root, fresh, old, foreign } = await makeSamples();
  const report = await runTempSweep({ mode: 'dry', root });

  assert.equal(report.mode, 'dry');
  assert.equal(report.candidates, 1, '只有"前缀命中 + 够老"的那一个算候选');
  assert.equal(report.deleted, 0, 'dry 一个都不许删');
  assert.equal(report.skippedYoung, 1, '刚建的那个太年轻，跳过');
  assert.ok(report.bytes >= 2048, `候选字节数要把目录里的文件算进去（实际 ${report.bytes}）`);

  // 三家都还在——这条是整份测试的题眼
  for (const dir of [fresh, old, foreign]) assert.equal(existsSync(dir), true, `dry 不许删 ${dir}`);

  const line = formatTempSweepLine(report);
  assert.match(line, /dry-run/u, line);
  assert.match(line, /将删 1 个 \/ 共 [\d.]+ (KB|MB)/u, line);
  t.diagnostic(line);
});

test('on：只删"前缀命中 + 够老"的那一个，新目录与非白名单前缀照旧不动', async (t) => {
  const { root, fresh, old, foreign } = await makeSamples();
  const report = await runTempSweep({ mode: 'on', root });

  assert.equal(report.deleted, 1);
  assert.equal(report.failures, 0);
  assert.equal(existsSync(old), false, '够老的那一个该被删');
  assert.equal(existsSync(fresh), true, '太年轻的（可能正在用）不许删');
  assert.equal(existsSync(foreign), true, '不是 irmia- 前缀的绝不许删');
  assert.match(formatTempSweepLine(report), /已删 1 个/u);
  t.diagnostic(formatTempSweepLine(report));
});

test('off：连目录都不读（根指到不存在的路径也不报错）', async () => {
  const report = await runTempSweep({ mode: 'off', root: 'C:/no/such/temp/dir' });
  assert.equal(report.mode, 'off');
  assert.equal(report.scanned, 0);
  assert.equal(report.error, '');
  assert.match(formatTempSweepLine(report), /已关闭/u);
});

test('占用（把目录当 CWD）⇒ rename 试探失败 ⇒ 跳过，绝不动它', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await tempDir('irmia-sweep-busy-');
  const busy = `${root}/irmia-setup-busy`;
  mkdirSync(busy, { recursive: true });
  backdate(busy, 25);

  const before = process.cwd();
  process.chdir(busy); // Windows：目录是某个进程的 CWD 时 rename 会失败
  let report;
  try {
    report = await runTempSweep({ mode: 'on', root });
  } finally {
    process.chdir(before);
  }
  assert.equal(existsSync(busy), true, '判定为占用的目录不许删');
  assert.equal(report.skippedInUse, 1, `该记一笔"占用跳过"：${JSON.stringify(report)}`);
  assert.equal(report.deleted, 0);
  t.diagnostic(formatTempSweepLine(report));
});

test('白名单前缀表：irmia-boot- 留 7 天，其余 24 小时；顺序即优先级', () => {
  const boot = TEMP_SWEEP_RULES[0]!;
  assert.equal(boot.prefix, 'irmia-boot-');
  assert.equal(boot.minAgeMs, 7 * 24 * HOUR_MS, '失败现场留 7 天（安装器那边刻意保留的证据）');
  const setup = TEMP_SWEEP_RULES.find((rule) => rule.prefix === 'irmia-setup-');
  assert.equal(setup?.minAgeMs, 24 * HOUR_MS);
  // 7 天以前建的 boot 目录会被扫掉：这是"保留但限时"的判据落点
  assert.equal(TEMP_SWEEP_RULES.filter((rule) => rule.prefix === 'irmia-boot-').length, 1);
});

test('环境变量解析：缺省 dry；off|dry|on 照写；写错不猜、退回 dry 且说破', () => {
  assert.deepEqual(parseTempSweepMode(undefined), { mode: 'dry', problem: '' });
  assert.deepEqual(parseTempSweepMode(''), { mode: 'dry', problem: '' });
  assert.deepEqual(parseTempSweepMode('ON'), { mode: 'on', problem: '' });
  const bad = parseTempSweepMode('yes');
  assert.equal(bad.mode, 'dry');
  assert.match(bad.problem, /IRMIA_TEMP_SWEEP/);
});

// ──────────────────────── 启动接线（`runMain` 那一拍，抽出来才测得到） ────────────────────────
//
// `runMain` 全仓没有测试覆盖（见 `test/main-entry.test.ts` 文件头），所以"启动到底按哪一档跑、
// 事件落不落"抽成了 `planTempSweep` + `runStartupTempSweep`（`src/util/temp-sweep.ts`）。
// 这里拿假 logger + 假事件口 + 自己的临时根，把那条路径**整条**跑一遍——判据是
// "`IRMIA_TEMP_SWEEP` 未设 ⇒ 确实按 dry 跑了一次：`temp/swept` 出现、`deleted=0`、旧目录还在"。

type RecordedEvent = { type: string; data: Record<string, unknown>; visibility: string };

/** 启动接线的测试台：假 logger + 假事件口 + 自己的根 */
async function startupRig(): Promise<{
  root: string;
  old: string;
  fresh: string;
  lines: string[];
  events: RecordedEvent[];
}> {
  const { root, old, fresh } = await makeSamples();
  return { root, old, fresh, lines: [], events: [] };
}

function runStartup(rig: { root: string; lines: string[]; events: RecordedEvent[] }, env: Record<string, string | undefined>) {
  return runStartupTempSweep({
    plan: planTempSweep(env),
    log: (line) => rig.lines.push(line),
    append: (type, data, visibility) => {
      rig.events.push({ type, data: data as unknown as Record<string, unknown>, visibility });
    },
    root: rig.root,
  });
}

test('启动接线：IRMIA_TEMP_SWEEP 未设 ⇒ 按 dry 跑一次、落 temp/swept{mode:dry,deleted:0}，旧目录一个不动', async (t) => {
  const rig = await startupRig();
  const plan = planTempSweep({});
  assert.equal(plan.mode, 'dry', '缺省必须是 dry（只报不删）');
  assert.equal(plan.problem, '');

  const report = await runStartup(rig, {});
  assert.equal(report.mode, 'dry');
  assert.equal(report.deleted, 0);
  assert.equal(existsSync(rig.old), true, 'dry 档启动那一拍也不许删');

  const swept = rig.events.find((event) => event.type === 'temp/swept');
  assert.ok(swept !== undefined, '启动那一拍也要落事件（事后查得到）');
  assert.equal(swept.visibility, 'internal', '临时目录的账不进她的上下文');
  assert.equal(swept.data['mode'], 'dry');
  assert.equal(swept.data['deleted'], 0);
  assert.equal(swept.data['candidates'], 1);
  assert.equal(swept.data['root'], rig.root);

  assert.ok(
    rig.lines.some((line) => /dry-run：将删 1 个 \/ 共 [\d.]+ (KB|MB)/u.test(line)),
    `当场也要看得见（启动日志）：\n${rig.lines.join('\n')}`,
  );
  t.diagnostic(`启动日志：${rig.lines.join(' ｜ ')}`);
});

test('启动接线：IRMIA_TEMP_SWEEP=off ⇒ 不扫、不落事件，只写一行"已关闭"', async (t) => {
  const rig = await startupRig();
  const report = await runStartup(rig, { IRMIA_TEMP_SWEEP: 'off' });
  assert.equal(report.mode, 'off');
  assert.equal(report.scanned, 0);
  assert.equal(rig.events.length, 0, '关掉了不是一次"扫了零个"的账');
  assert.ok(rig.lines.some((line) => line.includes('已关闭')), rig.lines.join('\n'));
  assert.equal(existsSync(rig.old), true);
  t.diagnostic(rig.lines.join(' ｜ '));
});

test('启动接线：开关写错（yes）⇒ 先打一行说破，再按 dry 跑（不猜成 on）', async (t) => {
  const rig = await startupRig();
  const report = await runStartup(rig, { IRMIA_TEMP_SWEEP: 'yes' });
  assert.equal(report.mode, 'dry');
  assert.equal(report.deleted, 0);
  assert.ok(rig.lines.some((line) => line.includes('IRMIA_TEMP_SWEEP=yes') && line.includes('不认识')),
    rig.lines.join('\n'));
  assert.equal(rig.events.find((event) => event.type === 'temp/swept')?.data['mode'], 'dry');
  t.diagnostic(rig.lines[0] ?? '');
});

test('启动接线：显式 on ⇒ 同一段装配真的会删（证明档位确实透传到扫描）', async (t) => {
  const rig = await startupRig();
  const report = await runStartup(rig, { IRMIA_TEMP_SWEEP: 'on' });
  assert.equal(report.mode, 'on');
  assert.equal(report.deleted, 1);
  assert.equal(existsSync(rig.old), false, 'on 档够老的那个该被删');
  const swept = rig.events.find((event) => event.type === 'temp/swept');
  assert.equal(swept?.data['mode'], 'on');
  assert.equal(swept?.data['deleted'], 1);
  assert.ok(rig.lines.some((line) => line.includes('已删 1 个')), rig.lines.join('\n'));
  t.diagnostic(rig.lines.join(' ｜ '));
});
