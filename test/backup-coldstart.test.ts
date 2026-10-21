/**
 * M6-4 备份冷启动验收测试 — 把「不可删三目录 + config.json」复制到新目录后从零启动
 *
 * 备份面（docs/operations.md §5）：`events/`（唯一真相源）+ `blobs/`（结果全文）+ `persona/`
 * （人格资产）+ `config.json`。**派生数据（projection.json / timers.json / snapshots/）不进备份**：
 * 它们都能从日志重建，复制过去反而会把"派生文件与日志不一致"这种病带进新实例。
 *
 * 验收口径（docs/milestones.md M6-4）：**仅用这份备份在新目录启动，恢复后投影的关键字段
 * 与源实例一致**。本套件把它做成三段式断言：
 *   ① 源实例先跑一次完整的恢复七步（把崩溃现场补偿干净），得到权威投影 P1；
 *   ② 备份复制到新目录，并**断言派生数据确实没被带过去**；
 *   ③ 新目录冷启动，投影 P2 与 P1 **逐字段 JSON 相等**，且 CLI status 的四要素一致。
 *
 * 第 ③ 步用整份投影比较而不是挑几个字段：挑字段等于给"哪些字段算关键"留一个会漂移的口子，
 * 而投影本来就是 fold 的输出——它相等就是"恢复路径没丢任何一条事实"。
 */

import assert from 'node:assert/strict';
import {
  cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { buildStatusReport, runCli, type CliIO } from '../src/cli.ts';
import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent, Projection } from '../src/log/types.js';
import { defaultVisibility } from '../src/log/types.ts';
import { loadPersona } from '../src/persona/loader.ts';
import { EVENT_LOG_DIR_NAME, TIMER_FILE_NAME, recover, type RecoverResult } from '../src/runtime/recover.ts';
import { blobIdOf, readBlob, writeBlob } from '../src/state/blob-store.ts';
import { applyOne, fold } from '../src/state/fold.ts';
import { PROJECTION_CACHE_FILE } from '../src/state/projection-cache.ts';
import { SNAPSHOT_DIR_NAME } from '../src/state/snapshot.ts';
import { LOCK_FILE_NAME } from '../src/runtime/instance-lock.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const T0 = '2026-07-01T08:00:00.000Z';
const BLOB_CONTENT = '这是一段被外置的大工具结果全文，备份面必须带上它。\n第二行。\n';

/** 备份面的四个成员（派生物一律不复制） */
const BACKUP_ITEMS = ['events', 'blobs', 'persona', 'config.json'] as const;

// ──────────────────────────────── 造一个"崩溃现场" ────────────────────────────────

interface CrashScene {
  dir: string;
  blobId: string;
  /** 崩溃现场里那条 open turn */
  openTurn: number;
}

async function makeCrashScene(t: TestContext): Promise<CrashScene> {
  const dir = tempDirSync('irmia-coldstart-src-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // ① 人格资产（不可删目录之一）
  mkdirSync(join(dir, 'persona'), { recursive: true });
  for (const [name, content] of Object.entries({
    'IDENTITY.md': '# 我是谁\n\n我是伊尔弥亚。\n',
    'CONSTITUTION.md': '# 行为宪法\n\n- 沉默是正常动作。\n',
    'STYLE.md': '# 表达风格\n\n- 简短。\n',
    'STATE.md': '# 当前状态\n\n正在处理备份演练。\n',
  })) {
    writeFileSync(join(dir, 'persona', name), content, 'utf8');
  }

  // ② 配置（第四件不可删的东西）；不带上机器相关的 dataDir，保证两边可比
  const config = defaultConfig(dir);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...config, dataDir: '.' }, null, 2), 'utf8');

  // ③ 大工具结果外置（blobs/ 是不可删目录）
  const blob = await writeBlob(dir, BLOB_CONTENT);

  // ④ 日志：一条待处理输入 + 一个开放 turn + 一个悬空 destructive 调用 + 一个定时器
  const log = await EventLog.open(join(dir, EVENT_LOG_DIR_NAME));
  const projection: Projection = fold([]);
  const append = (type: string, data: unknown): AppEvent => {
    const event = {
      seq: log.nextSeq(),
      ts: T0,
      type,
      data,
      visibility: defaultVisibility(type),
      origin: 'test/backup-coldstart',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    applyOne(projection, event);
    return event;
  };

  try {
    const persona = loadPersona(dir);
    append('session/start', {
      pid: 1001, cwd: dir, version: '0.1.0', schemaVersion: '1', configHash: 'cfg-scene',
    });
    append('persona/updated', { file: 'STATE.md', diffHash: persona.personaHash, by: 'agent' });
    const wake = append('wake/manual', { note: '先看看备份面有没有缺东西', dedupeKey: 'coldstart-1' });
    append('turn/start', { turn: 1 });
    append('input/claimed', { turn: 1, wakeSeqs: [wake.seq], claimCounts: [0] });
    append('step/start', {
      turn: 1, step: 1, model: 'fake-heavy', lane: 'heavy', renderVersion: '1', personaHash: persona.personaHash,
    });
    // 一个正常闭合的调用：结果全文外置到 blobs/（备份面的第三件）
    const readCall = append('tool/call', {
      turn: 1, step: 1, callId: 'call_read', name: 'read_file',
      arguments: '{"file_path":"big.log"}', sideEffect: 'none',
    });
    append('tool/result', {
      turn: 1, step: 1, callId: 'call_read', callSeq: readCall.seq, status: 'ok',
      content: `${BLOB_CONTENT.slice(0, 20)}…`,
      contentRef: { blobId: blob.blobId, bytes: blob.bytes },
    });
    // 一个悬空的 destructive 调用：恢复流程会把它标成 unknown 并进待确认
    append('tool/call', {
      turn: 1, step: 1, callId: 'call_backup', name: 'http_post',
      arguments: '{"url":"https://example.test/notify","body":"备份完成"}', sideEffect: 'destructive',
    });
    append('timer/set', {
      timerId: 'timer_backup', at: '2026-07-02T08:00:00.000Z', payload: { note: '检查备份副本' },
    });
  } finally {
    log.close();
  }

  return { dir, blobId: blob.blobId, openTurn: 1 };
}

/** 跑一次恢复七步并立刻收敛（关日志、放锁），返回投影——源实例的"权威状态" */
async function recoveredProjection(_t: TestContext, dataDir: string): Promise<Projection> {
  const result: RecoverResult = await recover({ dataDir, log: () => {} });
  const snapshot = JSON.parse(JSON.stringify(result.projection)) as Projection;
  result.log.close();
  // 心跳定时器随释放而停：测试进程不能带着活句柄退场
  result.lock.release();
  return snapshot;
}

function collector(): { io: CliIO; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { io: { out: (line) => lines.push(line), err: (line) => errors.push(line) }, lines, errors };
}

// ──────────────────────────────── 主验收 ────────────────────────────────

test('M6-4：仅用 events/ + blobs/ + persona/ + config.json 冷启动，投影与源实例逐字段一致', async (t) => {
  const scene = await makeCrashScene(t);

  // ── ① 源实例：先跑一次恢复（补偿崩溃现场），取得权威投影 ──
  const source = await recoveredProjection(t, scene.dir);
  assert.equal(source.openTurn, null, '恢复后不应残留未闭合 turn');
  assert.deepEqual(source.openTools, [], '恢复后不应残留开放调用');
  assert.equal(source.needsReview.length, 1, '悬空 destructive 调用应转成待确认');
  assert.equal(source.pending.length, 1, '被认领的输入应退回待处理');
  assert.equal(source.timers.length, 1, '定时器应恢复进投影');

  // ── ② 备份：只复制四个成员 ──
  const backup = tempDirSync('irmia-coldstart-bak-');
  t.after(() => rmSync(backup, { recursive: true, force: true }));
  for (const item of BACKUP_ITEMS) {
    cpSync(join(scene.dir, item), join(backup, item), { recursive: true });
  }

  // 派生数据必须**不在**备份里：它们是加速器，带过去只会把"缓存与日志不一致"一起搬走
  const derived = [
    PROJECTION_CACHE_FILE, TIMER_FILE_NAME, LOCK_FILE_NAME, SNAPSHOT_DIR_NAME,
  ];
  for (const name of derived) {
    assert.equal(existsSync(join(backup, name)), false, `${name} 不该出现在备份目录里`);
  }
  // 而备份面本身必须完整
  assert.equal(existsSync(join(backup, EVENT_LOG_DIR_NAME)), true);
  assert.equal(existsSync(join(backup, 'config.json')), true);
  assert.equal(
    readFileSync(join(backup, 'config.json'), 'utf8'),
    readFileSync(join(scene.dir, 'config.json'), 'utf8'),
    'config.json 必须逐字节复制',
  );

  // ── ③ 冷启动：新目录、只有备份 ──
  const restored = await recoveredProjection(t, backup);

  assert.equal(
    JSON.stringify(restored),
    JSON.stringify(source),
    '恢复后的投影必须与源实例逐字段一致（水位 / pending / needsReview / timers / 预算 / 全部派生字段）',
  );

  // 关键字段再单列断言一次：整份相等时它们是冗余的，但人读报告时看的就是这几个
  assert.equal(restored.lastSeq, source.lastSeq);
  assert.equal(restored.watermark, source.watermark);
  assert.deepEqual(
    restored.pending.map((item) => ({ seq: item.wakeSeq, source: item.source, count: item.claimCount })),
    source.pending.map((item) => ({ seq: item.wakeSeq, source: item.source, count: item.claimCount })),
  );
  assert.deepEqual(restored.needsReview.map((item) => item.callId), source.needsReview.map((item) => item.callId));
  assert.deepEqual(
    restored.timers.map((timer) => ({ id: timer.timerId, at: timer.at })),
    source.timers.map((timer) => ({ id: timer.timerId, at: timer.at })),
  );

  // ── ④ 不可删资产的第三件：blobs 里那份全文能原样取回 ──
  assert.equal(blobIdOf(await readBlob(backup, scene.blobId)), scene.blobId);
  assert.equal((await readBlob(backup, scene.blobId)).toString('utf8'), BLOB_CONTENT);
  // 人格资产也随备份过去了
  assert.equal(loadPersona(backup).state, '# 当前状态\n\n正在处理备份演练。\n');
});

test('M6-4：恢复后 CLI status 的四要素与源实例一致（水位 / 待办 / 待确认 / 定时器）', async (t) => {
  const scene = await makeCrashScene(t);
  const source = await recoveredProjection(t, scene.dir);

  const backup = tempDirSync('irmia-coldstart-bak-');
  t.after(() => rmSync(backup, { recursive: true, force: true }));
  for (const item of BACKUP_ITEMS) cpSync(join(scene.dir, item), join(backup, item), { recursive: true });
  await recoveredProjection(t, backup);

  const report = await buildStatusReport(backup);

  // 水位口径与 status / loop.advanceWatermark 同源：有 pending 就停在最早一条之前
  const expectedWatermark = source.pending.length > 0
    ? Math.min(...source.pending.map((item) => item.wakeSeq)) - 1
    : source.lastSeq;
  assert.equal(report.watermark, expectedWatermark);
  assert.equal(report.pending.total, source.pending.length);
  assert.equal(report.needsReview, source.needsReview.length);
  assert.equal(report.timers.total, source.timers.length);
  assert.equal(report.events.maxSeq, source.lastSeq);
  // 备份目录自己的运行态是新的：源实例的 lock.json 没被带过来，恢复后也已正常释放
  assert.equal(existsSync(join(backup, LOCK_FILE_NAME)), false);

  const cli = collector();
  assert.equal(await runCli(['status'], cli.io, { dataDir: backup }), 0);
  assert.match(cli.lines.join('\n'), new RegExp(`水位: ${expectedWatermark} · 待办 1`));
});

test('M6-4：备份里缺 blobs/ 时，doctor 立刻报出引用丢失（备份面不完整不能装没看见）', async (t) => {
  const scene = await makeCrashScene(t);
  await recoveredProjection(t, scene.dir);

  const backup = tempDirSync('irmia-coldstart-bak-');
  t.after(() => rmSync(backup, { recursive: true, force: true }));
  // 故意只复制三件：漏掉 blobs/
  for (const item of ['events', 'persona', 'config.json'] as const) {
    cpSync(join(scene.dir, item), join(backup, item), { recursive: true });
  }
  await recoveredProjection(t, backup);

  const cli = collector();
  assert.equal(await runCli(['doctor'], cli.io, { dataDir: backup }), 1);
  const text = cli.lines.join('\n');
  assert.match(text, /✗ OPS-blob/);
  assert.match(text, /引用的 blob .* 不存在/);
});
