/**
 * **人工归集入口 `irmia skill reindex`**（2026-10-23）—— 用户这一轮那条事故的收口。
 *
 * ──────────────────────────── 它治的是什么（现场） ────────────────────────────
 *
 * 迁移时 `core.autocrlf` 把 SKILL.md 落成 CRLF，信任门失配 ⇒ 19:42 写下了一条**只有 2 个技能**
 * 的 `skill/index` 快照。之后信任表修回 7 个（`skill list` 7/7 生效），可快照仍是 2 个，
 * 而循环那三条判据（`real-loop.ts` 的 `skillIndexSync`：首次 / 模板换代 / 快照早于最后一次压缩）
 * **一条都不成立** ⇒ **重启也不会重建**，只能等她下一次压缩摘要。代价是固定块里那一段只列 2 个，
 * 另外 5 个她看不见。
 *
 * 判据落成三件事（这一整个文件就是它们）：
 *   ① **形状与循环逐字段相同**：同一份 `writeSkillIndexSnapshot`（`src/skill/index-snapshot.ts`），
 *      `version` / `text` / `skills` 与循环那次写下的 data **逐字节**（含键顺序）相同；
 *      `coveredSeq` 与循环同一口径 = 日志里最后一条 `compaction/summary` 的 seq；
 *   ② **幂等**：内容与当前快照逐字节相同（且同代模板）⇒ **不写事件**；
 *   ③ **`--dry` 不写盘**：日志一个字节都不变，而它打印的 text 与真跑写下的**逐字节相同**
 *      （演练与真跑走的是同一条代码路径，只把"落库"换成"凭空算一个 seq"）。
 *
 * 另有一条纪律单独验：**真跑要探锁**（主进程活着就退出码 3），`--dry` 不写所以不拦
 * ——与 `review resolve` / `skill confirm` 同源，撞号会让日志下次启动拒绝启动。
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { reindexSkills, runCli, type CliIO } from '../src/cli.ts';
import { EventLog } from '../src/log/event-log.ts';
import { readEventsReadOnly } from '../src/log/read-only.ts';
import type { AppEvent } from '../src/log/types.js';
import { RENDER_VERSION, skillIndexOf } from '../src/model/render.ts';
import { LOCK_FILE_NAME } from '../src/runtime/instance-lock.ts';
import { EVENT_LOG_DIR_NAME } from '../src/runtime/recover.ts';
import { CATALOG_HEADER, SkillManager } from '../src/skill/skills.ts';
import { sha256Hex } from '../src/tools/fs/text-codec.ts';
import { makeRealWakeRig } from './fixtures/real-wake-rig.ts';
import type { RealWakeRig } from './fixtures/real-wake-rig.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const T0 = '2026-10-23T11:42:00.000Z';

// ──────────────────────────────── 台子上的小工具（与 skill-index.test.ts 同一套形状） ────────────────────────────────

/** 一份技能的 SKILL.md（frontmatter 两字段就够；name 必须与目录同名） */
function skillText(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n正文不进请求（渐进披露第二层）。\n`;
}

/** 往技能根里写一份技能（`<dir>/skills/<name>/SKILL.md`），返回 SKILL.md 的原文 */
function writeSkill(root: string, name: string, description: string): string {
  const dir = join(root, 'skills', name);
  mkdirSync(dir, { recursive: true });
  const text = skillText(name, description);
  writeFileSync(join(dir, 'SKILL.md'), text, 'utf8');
  return text;
}

/** 写一条 `skill/installed`（**信任门的唯一凭据**；`by:'human'` 才是人批的） */
function trust(rig: RealWakeRig, name: string, text: string): void {
  rig.append('skill/installed', {
    name, path: `skills/${name}`, by: 'human', contentHash: sha256Hex(text),
  });
}

/** 一个合法形状的 server 条目（本文件只渲染索引，**永远不会被起**） */
function server(name: string, desc: string): unknown {
  return { name, command: 'definitely-not-a-real-command', args: [], desc };
}

/** 真台子 + 真技能管理器（技能根挂在台子的临时目录上；与 skill-index.test.ts 同一个台子） */
async function rigWithSkills(): Promise<RealWakeRig> {
  return makeRealWakeRig({
    skills: (baseRoot) => new SkillManager({ baseRoot, out: () => undefined }),
    patchConfig: (config) => {
      (config.mcp as { servers: unknown[] }).servers = [server('alpha', '管着一个测试用的文件树')];
    },
    stream: Array.from({ length: 4 }, () => ({ text: '好。' })),
  });
}

function collector(): { io: CliIO; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { io: { out: (line) => lines.push(line), err: (line) => errors.push(line) }, lines, errors };
}

/** 台子日志里的全部事件 */
async function eventsOf(rig: RealWakeRig): Promise<AppEvent[]> {
  return [...(await rig.events())];
}

/**
 * 把一份事件序列抄进**另一个**数据目录（seq 重排成 1..n：`EventLog.append` 只要求严格递增，
 * 空洞是允许的，见 schema §12 不变量 1）。
 *
 * 用来造"日志里**还没有** `skill/index`"的现场——于是人工归集那一路一定会写一条，
 * 而循环那一路写下的那条就在手边可比（形状断言需要同台子的一对样本）。
 */
async function copyLog(dir: string, events: readonly AppEvent[]): Promise<AppEvent[]> {
  const log = await EventLog.open(join(dir, EVENT_LOG_DIR_NAME));
  try {
    events.forEach((event, index) => {
      log.append({ ...event, seq: index + 1 } as unknown as AppEvent, { sync: true });
    });
  } finally {
    log.close();
  }
  return events.map((event, index) => ({ ...event, seq: index + 1 }) as unknown as AppEvent);
}

/** 某个数据目录里的全部事件（只读扫描，与 CLI 自己那条路同一个函数） */
function scanEvents(dir: string): AppEvent[] {
  return readEventsReadOnly(join(dir, EVENT_LOG_DIR_NAME)).events;
}

// ──────────────────────────────── ① 形状与循环逐字段相同 ────────────────────────────────

test('① 归集写下的事件与循环那次**逐字段相同**（version / text / skills，含键顺序）', async (t) => {
  const rig = await rigWithSkills();
  t.after(rig.dispose);
  const alpha = writeSkill(rig.dir, 'alpha-search', '搜网页与站内内容并按相关性排序；查资料、验证事实时用。');
  const beta = writeSkill(rig.dir, 'beta-tools', '处理本地文件的那些脚本：批量改名、按内容找文件。');
  trust(rig, 'alpha-search', alpha);
  trust(rig, 'beta-tools', beta);

  // 循环那一路：第一拍没有快照（首次）⇒ 写一条
  rig.append('wake/manual', { note: '看看有什么' });
  await rig.tick();
  const loopSnapshot = (await eventsOf(rig)).find((event) => event.type === 'skill/index');
  assert.ok(loopSnapshot !== undefined, '循环那一拍该写下一条 skill/index（前置条件）');

  // 人工归集那一路：同一份事件序列抄进新目录，**去掉 skill/index**（否则它会被判"内容没变"）
  const copyDir = tempDirSync('irmia-skill-reindex-');
  t.after(() => rmSync(copyDir, { recursive: true, force: true }));
  await copyLog(copyDir, (await eventsOf(rig)).filter((event) => event.type !== 'skill/index'));

  const result = await reindexSkills(copyDir, {}, new Date(T0), rig.dir);
  assert.equal(result.ok, true, '归集该成功');
  if (!result.ok) return;
  assert.equal(result.report.written, true, '日志里没有快照 ⇒ 这一下必须写一条');
  assert.equal(result.report.skipped, null);

  const after = scanEvents(copyDir);
  const fresh = after.find((event) => event.type === 'skill/index');
  assert.ok(fresh !== undefined, '人工归集该追加一条 skill/index');

  // 逐字段（含键顺序）：JSON.stringify 一比就够——键序变了就过不了这一条
  assert.equal(
    JSON.stringify(fresh.data),
    JSON.stringify(loopSnapshot.data),
    '两条路写下的 data 必须逐字节相同（同一份 writeSkillIndexSnapshot）',
  );
  const data = fresh.data as { version: string; text: string; skills: Array<{ name: string }> };
  assert.equal(data.version, RENDER_VERSION, 'version 就是当前的 RENDER_VERSION');
  assert.deepEqual(Object.keys(data), ['version', 'text', 'skills'], '字段与键序都照抄循环那一份');
  assert.deepEqual(
    data.skills.map((row) => row.name),
    ['alpha-search', 'beta-tools'],
    '进索引的就是过了信任门的那几个',
  );
  assert.ok(data.text.startsWith(CATALOG_HEADER), 'text 就是渲染层那段（不是另拼的一份）');
  // 与技能系统此刻算出来的逐字节相同（不是这里手拼的期望值）
  const live = new SkillManager({ baseRoot: rig.dir });
  live.setTrustEvents(after);
  assert.equal(data.text, live.catalogText(), 'text 必须与技能系统此刻的 catalog 逐字节相同');

  // coveredSeq 与循环**同一口径**：日志里最后一条 compaction/summary 的 seq
  assert.equal(
    result.report.coveredSeq,
    skillIndexOf(after).coveredSeq,
    'coveredSeq 必须是"最后一条 compaction/summary"的 seq（与循环判据同一个来源）',
  );

  // 压缩之后再看一眼：coveredSeq 要跟着挪到最后那条 compaction/summary 上（不是写死的 0）
  const log = await EventLog.open(join(copyDir, EVENT_LOG_DIR_NAME));
  let compactionSeq = 0;
  try {
    const event = {
      seq: log.nextSeq(),
      ts: T0,
      type: 'compaction/summary',
      data: { coveredUpToSeq: 1, summary: '（测试用的交接笔记）' },
      visibility: 'model',
      origin: 'test/skill-reindex',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    compactionSeq = event.seq;
  } finally {
    log.close();
  }
  const summarized = await reindexSkills(copyDir, {}, new Date(T0), rig.dir);
  assert.equal(summarized.ok, true);
  if (!summarized.ok) return;
  assert.equal(summarized.report.coveredSeq, compactionSeq, 'coveredSeq 该是那条压缩的 seq');
  assert.equal(
    summarized.report.written,
    false,
    '文本一字未变（只是压缩了）⇒ 人工归集不写事件：覆盖压缩是循环下一拍的事，人这一下不掺和',
  );
  assert.equal(summarized.report.skipped, 'unchanged');
  // 而循环那一路在同一现场**会**写一条（它要记"我归集到了这次压缩之后"）——两条路的差别只有这一处
  const pointNow = skillIndexOf(scanEvents(copyDir));
  assert.ok(
    pointNow.seq < pointNow.coveredSeq,
    '压缩之后，那份快照确实早于最后一次压缩（循环下一拍会补一条；人这一下不掺和）',
  );
});

// ──────────────────────────────── ② 幂等：内容相同不写事件 ────────────────────────────────

test('② 内容与当前快照逐字节相同 ⇒ 不写事件（连跑两次只多一条快照）', async (t) => {
  const dir = tempDirSync('irmia-skill-reindex-idem-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const alpha = writeSkill(dir, 'alpha-search', '搜网页与站内内容；查资料时用。');
  const log = await EventLog.open(join(dir, EVENT_LOG_DIR_NAME));
  try {
    const event = {
      seq: log.nextSeq(),
      ts: T0,
      type: 'skill/installed',
      data: { name: 'alpha-search', path: 'skills/alpha-search', by: 'human', contentHash: sha256Hex(alpha) },
      visibility: 'internal',
      origin: 'test/skill-reindex',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
  } finally {
    log.close();
  }

  const first = await reindexSkills(dir, {}, new Date(T0), dir);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.report.written, true, '第一次：日志里没有快照 ⇒ 写一条');
  const afterFirst = scanEvents(dir);
  const snapshotCount = afterFirst.filter((event) => event.type === 'skill/index').length;
  assert.equal(snapshotCount, 1);
  const seqAfterFirst = readEventsReadOnly(join(dir, EVENT_LOG_DIR_NAME)).maxSeq;

  // 第二次：同一份信任表、同一代模板 ⇒ 字节没变 ⇒ 一条事件都不许多
  const cli = collector();
  const code = await runCli(['skill', 'reindex'], cli.io, { dataDir: dir, cwd: dir, now: () => new Date(T0) });
  assert.equal(code, 0, '幂等不是错误：退出码 0');
  const text = cli.lines.join('\n');
  assert.match(text, /索引已是最新（1 个技能），未写事件/u);
  assert.equal(cli.errors.length, 0);

  const afterSecond = scanEvents(dir);
  assert.equal(
    afterSecond.filter((event) => event.type === 'skill/index').length,
    snapshotCount,
    '内容相同不许再写一条快照',
  );
  assert.equal(afterSecond.length, afterFirst.length, '日志条数一个都不许多');
  assert.equal(
    readEventsReadOnly(join(dir, EVENT_LOG_DIR_NAME)).maxSeq,
    seqAfterFirst,
    'seq 也不许动（幂等 = 一个字节都不写）',
  );

  // 反面：换一份技能目录（内容真变了）⇒ 照旧会写（幂等不是"再也不写"）
  const beta = writeSkill(dir, 'beta-tools', '处理本地文件的那些脚本。');
  const log2 = await EventLog.open(join(dir, EVENT_LOG_DIR_NAME));
  try {
    log2.append({
      seq: log2.nextSeq(),
      ts: T0,
      type: 'skill/installed',
      data: { name: 'beta-tools', path: 'skills/beta-tools', by: 'human', contentHash: sha256Hex(beta) },
      visibility: 'internal',
      origin: 'test/skill-reindex',
    } as unknown as AppEvent, { sync: true });
  } finally {
    log2.close();
  }
  const third = await reindexSkills(dir, {}, new Date(T0), dir);
  assert.equal(third.ok, true);
  if (!third.ok) return;
  assert.equal(third.report.written, true, '信任表里多了一个技能 ⇒ 字节变了 ⇒ 该写');
  assert.equal(third.report.entries, 2);
});

// ──────────────────────────────── ③ --dry 不写盘 ────────────────────────────────

test('③ --dry 一个字节都不写，而它打印的 text 与真跑写下的**逐字节相同**', async (t) => {
  const dir = tempDirSync('irmia-skill-reindex-dry-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const alpha = writeSkill(dir, 'alpha-search', '搜网页与站内内容并按相关性排序；查资料时用。');
  const gamma = writeSkill(dir, 'gamma-docs', '把一段需求写成可执行的文档：结构、边界、验收。');
  const log = await EventLog.open(join(dir, EVENT_LOG_DIR_NAME));
  try {
    for (const [name, text] of [['alpha-search', alpha], ['gamma-docs', gamma]] as const) {
      log.append({
        seq: log.nextSeq(),
        ts: T0,
        type: 'skill/installed',
        data: { name, path: `skills/${name}`, by: 'human', contentHash: sha256Hex(text) },
        visibility: 'internal',
        origin: 'test/skill-reindex',
      } as unknown as AppEvent, { sync: true });
    }
  } finally {
    log.close();
  }

  const before = readEventsReadOnly(join(dir, EVENT_LOG_DIR_NAME));
  const dry = collector();
  assert.equal(
    await runCli(['skill', 'reindex', '--dry'], dry.io, { dataDir: dir, cwd: dir, now: () => new Date(T0) }),
    0,
  );
  const afterDry = readEventsReadOnly(join(dir, EVENT_LOG_DIR_NAME));
  assert.equal(afterDry.events.length, before.events.length, '--dry 不许写任何事件');
  assert.equal(afterDry.maxSeq, before.maxSeq, '--dry 不许动 seq');
  assert.equal(
    afterDry.events.filter((event) => event.type === 'skill/index').length,
    0,
    '--dry 不许写 skill/index',
  );

  const dryText = dry.lines.join('\n');
  assert.match(dryText, /--dry：只打印，不写盘/u, '演练必须自己说清"没写盘"');
  assert.match(dryText, /技能索引已归集：2 个技能（catalog 估算 \d+ token）· seq=\d+/u);
  assert.ok(dryText.includes(CATALOG_HEADER), '演练要把**将要写入的那段 text** 打出来');
  assert.match(dryText, /- alpha-search: /u);
  assert.match(dryText, /- gamma-docs: /u);
  assert.match(dryText, /--- text 结束 ---/u);

  // 真跑：日志多一条，text 与演练打印的那段**逐字节**相同
  const real = collector();
  assert.equal(
    await runCli(['skill', 'reindex'], real.io, { dataDir: dir, cwd: dir, now: () => new Date(T0) }),
    0,
  );
  const realText = real.lines.join('\n');
  assert.match(realText, /^技能索引已归集：2 个技能（catalog 估算 \d+ token）· seq=\d+$/mu, '真跑那行照口径');
  const written = readEventsReadOnly(join(dir, EVENT_LOG_DIR_NAME)).events
    .filter((event) => event.type === 'skill/index');
  assert.equal(written.length, 1, '真跑写了一条');
  const data = written[0]!.data as { text: string; version: string };
  const printed = dryText.split('\n');
  const start = printed.findIndex((line) => line.startsWith('--- 将要写入的 text'));
  const end = printed.findIndex((line) => line === '--- text 结束 ---');
  assert.ok(start >= 0 && end > start, '演练输出里该有 text 的起止标线');
  assert.equal(printed.slice(start + 1, end).join('\n'), data.text, '演练打印的 text 与真跑写下的逐字节相同');
  assert.equal(data.version, RENDER_VERSION);
});

// ──────────────────────────────── ④ 探锁与空索引 ────────────────────────────────

test('④ 真跑要探锁（主进程活着 ⇒ 退出码 3）；--dry 不写所以不拦', async (t) => {
  const dir = tempDirSync('irmia-skill-reindex-lock-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const alpha = writeSkill(dir, 'alpha-search', '搜网页与站内内容；查资料时用。');
  const log = await EventLog.open(join(dir, EVENT_LOG_DIR_NAME));
  try {
    log.append({
      seq: log.nextSeq(),
      ts: T0,
      type: 'skill/installed',
      data: { name: 'alpha-search', path: 'skills/alpha-search', by: 'human', contentHash: sha256Hex(alpha) },
      visibility: 'internal',
      origin: 'test/skill-reindex',
    } as unknown as AppEvent, { sync: true });
  } finally {
    log.close();
  }
  // 主进程"活着"：pid 用自己（探锁判的是进程在不在）
  writeFileSync(
    join(dir, LOCK_FILE_NAME),
    JSON.stringify({ pid: process.pid, startedAt: T0, heartbeatAt: T0 }),
    'utf8',
  );

  const before = readEventsReadOnly(join(dir, EVENT_LOG_DIR_NAME)).events.length;
  const blocked = collector();
  assert.equal(
    await runCli(['skill', 'reindex'], blocked.io, { dataDir: dir, cwd: dir, now: () => new Date(T0) }),
    3,
    '主进程在跑就拒绝写（撞号会让下一次启动拒绝启动）',
  );
  assert.match(blocked.errors.join('\n'), /主进程正在运行/u);
  assert.equal(readEventsReadOnly(join(dir, EVENT_LOG_DIR_NAME)).events.length, before, '拒绝时一个字节都不许写');

  // --dry 不写盘 ⇒ 不探锁（它没有撞号风险）
  const dry = collector();
  assert.equal(
    await runCli(['skill', 'reindex', '--dry'], dry.io, { dataDir: dir, cwd: dir, now: () => new Date(T0) }),
    0,
  );
  assert.equal(readEventsReadOnly(join(dir, EVENT_LOG_DIR_NAME)).events.length, before);
});

test('④b 一个可用技能都没有：空索引不写事件（退出码 2，与循环 ③ 同一口径）', async (t) => {
  const dir = tempDirSync('irmia-skill-reindex-empty-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 目录在、但没人批过 ⇒ 信任表里一条已生效的都没有
  writeSkill(dir, 'alpha-search', '只在待确认清单里：没写过 skill/installed 就不进 catalog。');

  const cli = collector();
  assert.equal(
    await runCli(['skill', 'reindex'], cli.io, { dataDir: dir, cwd: dir, now: () => new Date(T0) }),
    2,
    '空索引不是"成功归集"：退出码 2 才有脚本可判的语义',
  );
  assert.match(cli.lines.join('\n'), /一个可用技能都没有/u);
  assert.equal(
    scanEvents(dir).filter((event) => event.type === 'skill/index').length,
    0,
    '空索引不落事件',
  );
});
