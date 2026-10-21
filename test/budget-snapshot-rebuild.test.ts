/**
 * 预算累计的**跨口径**不变量（2026-10-05 那次实测事故的判据）
 *
 * 现场（逐条实测，不是推测）：
 *   · 磁盘 `config.json`：daily 40,000,000 / task 5,000,000；
 *   · 进程报的限额却是 daily 22,000,000 / task 57,000,000 —— 那是
 *     `config.budget + foldTopUps(日志)`（20M / 52M 人工加注），**这一半是对的**；
 *   · 但 `actual` 是 daily 29,951,973 / task 178,734,979，而同一份日志按当前算式折出来只有
 *     daily 2,052,965 / task 13,443,843 —— 差一到两个数量级；
 *   · 启动日志原文：「投影由快照增量折叠 {"snapshot":"snap-28399.json", …}」——
 *     **旧口径的累计量存在快照里**，`foldFromSnapshot` 只对 `upToSeq` 之后的事件用新算式，
 *     于是旧账压着新账，她一开始 turn 就撞 task 层线。
 *
 * 所以这份文件钉四条（判据只紧不松）：
 *   ① 现场量级的固定账：两套口径各算出什么数（下面所有断言的基准）；
 *   ② 旧口径写的缓存 / 快照 + 新算式启动 ⇒ **整份丢弃重建**，重建后的累计逐个数字等于
 *     「按事件全量重放」（不拿"大于/小于"糊过去）；
 *   ③ **已用额度不许因为换口径被凭空放大**：actual 必须等于事件累计，撞线判定跟着新的数走；
 *   ④ 回归：有旧快照 + 旧缓存时，恢复结果与全量折叠逐字段一致（口径格 + turn 链一起）。
 */

import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent, Projection } from '../src/log/types.ts';
import { defaultVisibility, emptyProjection } from '../src/log/types.ts';
import { BudgetGuard } from '../src/runtime/budget-guard.ts';
import { recover } from '../src/runtime/recover.ts';
import { applyOne, budgetTokensOf, fold } from '../src/state/fold.ts';
import {
  PROJECTION_CACHE_FILE,
  PROJECTION_CACHE_VERSION,
  loadProjectionCache,
  saveProjectionCache,
} from '../src/state/projection-cache.ts';
import { SNAPSHOT_VERSION, loadLatestSnapshot, writeSnapshot } from '../src/state/snapshot.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const T0 = Date.parse('2026-10-05T00:00:00Z');

let autoSeq = 0;

function evt(type: string, data: unknown): AppEvent {
  autoSeq += 1;
  return {
    seq: autoSeq, ts: new Date(T0).toISOString(), type, data, visibility: defaultVisibility(type),
  } as unknown as AppEvent;
}

/**
 * 一条消耗事实。刻意用**现场量级**的数：`cacheHit` 远大于 `cacheMiss`（心跳那一拍的真实形状
 * 是约 97% 命中）——正是这个比例让两套口径差出十倍量级，小数字造不出这个 bug。
 */
function consumed(d: {
  inputTokens: number;
  cacheHitTokens: number;
  outputTokens: number;
  lane?: 'heavy' | 'light';
}): AppEvent {
  return evt('budget/consumed', {
    turn: 1,
    step: 1,
    lane: d.lane ?? 'heavy',
    model: 'noncache-fixture',
    inputTokens: d.inputTokens,
    outputTokens: d.outputTokens,
    cacheHitTokens: d.cacheHitTokens,
    cacheMissTokens: Math.max(0, d.inputTokens - d.cacheHitTokens),
    durationMs: 1,
    retryCount: 0,
    finishReason: 'completed',
  });
}

/**
 * 造一份"旧口径写的投影"：每一条消耗都按**旧算式**（`input + output`，含 cacheHit）累。
 * 这就是现场 `snap-28399.json` / `projection.json` 里那两格的来历。
 *
 * 最后把 `budgetVersion` 整格**删掉**：换口径之前那一版代码根本不写这一格，
 * 所以盘上的旧文件长这样（"缺这一格 = 不认识 ⇒ 重建"正是载入层的判据）。
 */
function foldWithLegacyFormula(events: readonly AppEvent[]): Projection {
  const p = fold([]);
  for (const e of events) {
    if (e.type === 'budget/rollover') {
      p.budget.date = e.data.date;
      p.budget.tokensToday = 0;
      p.budget.tokensTodayHeavy = 0;
      p.budget.tokensTodayLight = 0;
      p.budget.cacheHitToday = 0;
      p.budget.cacheMissToday = 0;
      continue;
    }
    if (e.type !== 'budget/consumed') {
      applyOne(p, e);
      continue;
    }
    const d = e.data;
    const legacy = d.inputTokens + d.outputTokens;
    if (d.lane === 'heavy') p.budget.tokensTodayHeavy += legacy;
    else p.budget.tokensTodayLight += legacy;
    p.budget.tokensToday += legacy;
    p.budget.tokensTask += legacy;
    p.budget.cacheHitToday += d.cacheHitTokens;
    p.budget.cacheMissToday += d.cacheMissTokens;
  }
  delete p.budget.budgetVersion;
  return p;
}

/** 把盘上那份派生状态的**信封版本**降成 1：模拟"它是换口径之前那一刻写的" */
function downgradeEnvelope(path: string, version = 1): void {
  const envelope = JSON.parse(readFileSync(path, 'utf8')) as { version: number };
  envelope.version = version;
  writeFileSync(path, `${JSON.stringify(envelope)}\n`, 'utf8');
}

/** 今天的固定账：三条调用，命中率约 96% —— 两套口径在那两格上差一个数量级 */
function todayEvents(): AppEvent[] {
  return [
    evt('budget/rollover', { date: '2026-10-05' }),
    consumed({ inputTokens: 45_000, cacheHitTokens: 43_650, outputTokens: 350 }), // 新 1,700 / 旧 45,350
    consumed({ inputTokens: 12_000, cacheHitTokens: 11_500, outputTokens: 200, lane: 'light' }),
    consumed({ inputTokens: 30_000, cacheHitTokens: 29_000, outputTokens: 400 }),
  ];
}

/** 逐个数字断言"投影 = 按事件重放"，报错时把两边的数都打出来 */
function assertSameAccounting(actual: Projection, expected: Projection, where: string): void {
  for (const key of ['tokensToday', 'tokensTodayHeavy', 'tokensTodayLight', 'tokensTask'] as const) {
    assert.equal(actual.budget[key], expected.budget[key], `${where}：budget.${key}`);
  }
  // 原始分量是**记录**，不受口径影响：换口径不许把它们也改写
  for (const key of ['cacheHitToday', 'cacheMissToday', 'date'] as const) {
    assert.equal(actual.budget[key], expected.budget[key], `${where}：budget.${key}（记录，不许被口径改写）`);
  }
}

/** 把事件写进真日志文件（recover 需要一份真日志；与既有用例同一套做法） */
async function writeLog(dir: string, events: readonly AppEvent[]): Promise<void> {
  const log = await EventLog.open(join(dir, 'events'));
  try {
    for (const event of events) log.append({ ...event, seq: log.nextSeq() } as AppEvent, { sync: true });
    log.flush();
  } finally {
    log.close();
  }
}

/** 从盘上把日志整份读回来（恢复期补写过补偿事件，日志才是唯一真相源） */
async function readAllEvents(dir: string): Promise<AppEvent[]> {
  const log = await EventLog.open(join(dir, 'events'));
  try {
    const all: AppEvent[] = [];
    for await (const event of log.readAll()) all.push(event);
    return all;
  } finally {
    log.close();
  }
}

function tempDir(t: TestContext, tag: string): string {
  const dir = tempDirSync(`irmia-${tag}-`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ──────────────────────────────── ① 数字先钉死 ────────────────────────────────

test('① 现场量级的固定账：两套口径各算出什么数（下面所有断言的基准）', () => {
  autoSeq = 0;
  const events = todayEvents();
  const fresh = fold(events);
  const legacy = foldWithLegacyFormula(events);

  // 新口径 = 每条 (input − cacheHit) + output
  assert.equal(budgetTokensOf({ inputTokens: 45_000, cacheHitTokens: 43_650, outputTokens: 350 }), 1_700);
  assert.equal(fresh.budget.tokensToday, 1_700 + 700 + 1_400);
  assert.equal(fresh.budget.tokensTask, 3_800);
  // 旧口径 = 每条 input + output（含命中）——现场那两格的来历
  assert.equal(legacy.budget.tokensToday, 45_350 + 12_200 + 30_400);
  assert.equal(legacy.budget.tokensTask, 87_950);
  // 记录分量两边逐字节相同：差异只该出在"口径换算过的累计量"上
  assert.equal(fresh.budget.cacheHitToday, legacy.budget.cacheHitToday);
  assert.equal(fresh.budget.cacheMissToday, legacy.budget.cacheMissToday);
  assert.equal(fresh.budget.cacheHitToday, 43_650 + 11_500 + 29_000);
  // 放大倍数：现场是"差两个数量级"，这里同样是十倍量级
  assert.equal(legacy.budget.tokensTask / fresh.budget.tokensTask > 10, true);
});

// ──────────────────────────────── ② 换口径必须作废旧快照与旧缓存 ────────────────────────────────

test('② 两个版本常量与口径绑定：算式一变，两个都必须一起动', () => {
  // 这一条是"绑定的那一处"：谁改了 fold.ts 的算式而没抬版本号，第一层断言先红，
  // 第二层告诉他该动哪两个常量（换口径而旧快照仍被采信 = 旧账压新账）。
  assert.equal(
    budgetTokensOf({ inputTokens: 100, cacheHitTokens: 90, outputTokens: 5 }),
    15,
    '预算口径的锚点：v2 = (input − cacheHit) + output。改这个算式 ⇒ 同时抬下面两个版本号',
  );
  assert.equal(PROJECTION_CACHE_VERSION, 2, '投影缓存版本必须与口径同步（v1 = 未扣缓存口径）');
  assert.equal(SNAPSHOT_VERSION, 2, '折叠快照版本必须与口径同步——只抬缓存那条，快照仍会把旧账喂回来');
});

test('② 旧口径写的投影缓存 + 新算式启动：缓存被丢弃、重建后等于按事件重放', async (t) => {
  const dir = tempDir(t, 'budget-old-cache');
  autoSeq = 0;
  const events = todayEvents();
  await writeLog(dir, events);

  // 旧口径写的缓存（现场那份的角色）：信封降成 v1，state 里也没有 budgetVersion
  const legacy = foldWithLegacyFormula(events);
  assert.equal(legacy.budget.tokensToday, 87_950, '旧口径：87,950');
  assert.equal(legacy.budget.budgetVersion, undefined, '旧文件里根本没有这一格');
  await saveProjectionCache(dir, legacy, legacy.lastSeq);
  downgradeEnvelope(join(dir, PROJECTION_CACHE_FILE));

  // 版本不认识 ⇒ 丢弃（载入层返回 null），调用方走重放
  assert.equal(await loadProjectionCache(dir), null, '旧口径的缓存必须整份丢弃，不许拿它续算新增量');

  // 真启动路径：recover 拿不到可用缓存 ⇒ 从日志重放 ⇒ 累计等于按事件重放的那些数
  const result = await recover({ dataDir: dir });
  result.lock.release();
  assertSameAccounting(result.projection, fold(await readAllEvents(dir)), '恢复后的投影 vs 从日志全量折叠');
  assert.equal(result.projection.budget.tokensToday, 3_800, '今日非缓存累计（旧口径写的是 87,950）');
  assert.equal(result.projection.budget.tokensTask, 3_800);
});

test('② 旧口径写的折叠快照 + 新算式启动：快照被丢弃、投影等于按事件重放', async (t) => {
  const dir = tempDir(t, 'budget-old-snapshot');
  autoSeq = 0;
  const events = todayEvents();
  await writeLog(dir, events);

  // 旧口径写的快照（现场 `snap-28399.json` 就是这个角色）
  const legacy = foldWithLegacyFormula(events);
  const written = await writeSnapshot(dir, legacy);
  assert.equal(written.upToSeq, legacy.lastSeq);
  downgradeEnvelope(written.path);

  assert.equal(await loadLatestSnapshot(dir), null, '旧口径的快照必须整份丢弃（否则旧账压新账）');

  const result = await recover({ dataDir: dir });
  result.lock.release();
  assertSameAccounting(result.projection, fold(await readAllEvents(dir)), '恢复后的投影 vs 从日志全量折叠');
  assert.equal(result.projection.budget.tokensToday, 3_800, '不许沿用快照里旧口径的 87,950');
  assert.equal(result.projection.budget.tokensTask, 3_800, '不许沿用快照里旧口径的 87,950');
});

// ──────────────────────────────── ③ 已用额度不许被凭空放大 ────────────────────────────────

test('③ 换口径不许放大已用额度：actual 等于事件累计，撞线判定跟着新的数走', async (t) => {
  const dir = tempDir(t, 'budget-no-inflation');
  autoSeq = 0;
  // 现场量级：600 条心跳拍（每条非缓存 1,700、旧口径 45,350）⇒ 旧 27,210,000、新 1,020,000
  const events: AppEvent[] = [evt('budget/rollover', { date: '2026-10-05' })];
  for (let i = 0; i < 600; i++) {
    events.push(consumed({ inputTokens: 45_000, cacheHitTokens: 43_650, outputTokens: 350 }));
  }
  await writeLog(dir, events);
  const legacy = foldWithLegacyFormula(events);
  assert.equal(legacy.budget.tokensToday, 600 * 45_350, '旧口径 27,210,000（现场 29.95M 的同一量级）');

  const result = await recover({ dataDir: dir });
  result.lock.release();
  const p = result.projection;
  assert.equal(p.budget.tokensToday, 600 * 1_700, '新口径 1,020,000');

  const replayed = fold(await readAllEvents(dir));
  assert.equal(p.budget.tokensToday, replayed.budget.tokensToday, 'actual 必须等于事件累计（一个字节都不许多）');
  assert.equal(p.budget.tokensTask, replayed.budget.tokensTask);

  // 撞线判定跟着**重建后的数**走：日额度 2M 时 1.02M 还没到线（若沿用旧数 27.2M 会立刻撞）
  const guard = new BudgetGuard({
    config: { ...defaultConfig(dir).budget, dailyTokens: 2_000_000, taskTokens: 5_000_000 },
    projection: p,
    emit: () => {},
    now: () => new Date(T0),
  });
  assert.equal(guard.checkBeforeStep(p), null, '非缓存 1.02M < 日额度 2M：不许撞线');
  assert.equal(guard.dailyBreach(p), null);
});

// ──────────────────────────────── ④ 回归：有旧快照 + 旧缓存时的恢复一致性 ────────────────────────────────

test('④ 回归：旧快照与旧缓存都在时，恢复结果与全量折叠一致（含未闭合 turn 的补偿）', async (t) => {
  const dir = tempDir(t, 'budget-replay-parity');
  autoSeq = 0;
  const events = [
    ...todayEvents(),
    // 一个未闭合的 turn：恢复期要补 turn/end{interrupted}，补完仍须与全量折叠一致
    evt('turn/start', { turn: 7 }),
    evt('step/start', { turn: 7, step: 1, model: 'm', lane: 'heavy', renderVersion: 'v', personaHash: 'h' }),
  ];
  await writeLog(dir, events);
  // 两份旧账都放上（现场就是"缓存落后 + 快照命中"的组合），都降成 v1
  const legacy = foldWithLegacyFormula(events);
  const written = await writeSnapshot(dir, legacy);
  downgradeEnvelope(written.path);
  await saveProjectionCache(dir, legacy, legacy.lastSeq);
  downgradeEnvelope(join(dir, PROJECTION_CACHE_FILE));

  // 两条恢复路径都必须判它不可用（只抬其中一条的版本 = 另一条仍会把旧账喂回来）
  assert.equal(await loadLatestSnapshot(dir), null, '旧快照必须被丢弃');
  assert.equal(await loadProjectionCache(dir), null, '旧缓存必须被丢弃');

  const result = await recover({ dataDir: dir });
  result.lock.release();
  const full = fold(await readAllEvents(dir));

  assertSameAccounting(result.projection, full, '恢复 vs 全量折叠');
  assert.equal(result.projection.openTurn, null, '未闭合 turn 已被补偿收尾');
  assert.equal(result.projection.lastExhausted['daily'], undefined);
});

// ──────────────────────────────── ⑤ 没有任何旧物时也走同一条路 ────────────────────────────────

test('⑤ 没有任何缓存/快照时：全量折叠的累计就是非缓存口径', () => {
  autoSeq = 0;
  const p = fold(todayEvents());
  assert.equal(p.budget.tokensToday, 3_800);
  assert.equal(p.budget.tokensTodayHeavy, 1_700 + 1_400);
  assert.equal(p.budget.tokensTodayLight, 700);
  assert.equal(p.budget.tokensToday, p.budget.tokensTodayHeavy + p.budget.tokensTodayLight);
  assert.equal(emptyProjection().budget.tokensToday, 0);
});
