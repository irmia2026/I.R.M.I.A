/**
 * 压缩**前**的预警（`wake/manual{via:'compact-soon'}`）—— 2026-10-15 用户定稿那一件。
 *
 * ───────────────────────────────── 用户原话 ─────────────────────────────────
 *
 * 「框架的压缩预警，**得让 agent 看见**，知道上下文已过 80%，**考虑整理和记录**。再继续工作，
 *  **避免压缩导致丢失信息**。比如我设置的 200k 压缩，那么到 **0.8 * 200k** 的时候就要有
 *  **条框架提醒把她唤醒**。其他人设置多少那就是 0.8 * 多少。」
 *
 * 这一份钉七件事（正反两面都要）：
 *   ① **线下不动**：历史没到 80% ⇒ 一个字都不发；
 *   ② **越线就发**（在被闸门拦下、压不动的那一拍）；
 *   ③ **同一档不重报**：同一档报过一次之后**永久**不再报（2026-10-22 起没有冷却——
 *      隔一分钟还是隔一天都一样；上一版的 `cooldown` 出口不再产生）；
 *   ④ **分档都报**：**80 → 95 跨档两次都报**（90 那一档 2026-10-22 删掉了）；
 *   ⑤ **重置**：压缩过（`wrote`）或可见历史回落到**阈值 50% 以下** ⇒ 分档状态归零，
 *      下一次跨 80% 照样报；
 *   ⑥ **阈值随配置走**：同一份历史、两个阈值、两种结论（排除"写死 160k"的实现）；
 *   ⑦ **判据同源**：预警用的 `historyTokens` 就是压缩判定刚算出来的那个数。
 *
 * ★ **2026-10-22 的病根与修法**（读懂这几条用例的前提）：上一版是"分档 + 同档 30 分钟冷却"，
 * 现场同一档 80 在 07:34 / 08:25 / 09:09 各报一次（隔 51 / 44 分钟）——冷却挡不住一小时。
 * 用户原话：「**压缩临近变成了每次唤醒都有**。80% 提醒一次、95% 提醒一次就行了。」
 * 所以这一版：两档、每档每周期**只报一次**、判据里**没有时钟**；重报的唯一条件是
 * **换了一档**或**开了新周期**（压缩 / 回落到 <50%）。用例 ⑩-b 就是用户点名的那条曲线。
 *
 * ★ **本文件的配法为什么长这样**（读懂它才读得懂这几条用例）：
 *   压缩线在 **100%**、预警线在 **80%**，而"越线"与"能压"并不总是同时成立——
 *   **越了线但这一拍压不动**（收益闸门 `gate` / 折叠不变小 `no-shrink` / 遮蔽点回退 `monotonic`）
 *   的那些拍，正是这条预警存在的意义。夹具据此分两段：
 *     · **第一次越线**（料把阈值一口气推过）⇒ 同一拍也 `wrote` ⇒ 记 `just-compacted`（不重复叫）；
 *     · **压完再垫一截小的**（越过 80%、但新闭合量不够一个 recent tail）⇒ `gate` ⇒ **发预警**。
 *   这不是为了测试而造的形状：线上 10-11 ~ 10-14 实测有 **92 拍**落在这个形状里。
 *
 * 走**真链路**：真 EventLog + 真 fold + 真 RealLoop + 真 runTurn，替身只有模型通道
 * （与 `compaction-decision-wake.test.ts` 同一套台子——那一份管 `via:'compact'`，这一份管
 * `via:'compact-soon'`，两件事各测各的，判据都按 `via` 分）。
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent, CompactionWarningTier, Projection } from '../src/log/types.ts';
import { emptyProjection } from '../src/log/types.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import {
  COMPACTION_WARNING_COOLDOWN_MS,
  COMPACTION_WARNING_RATIO,
  COMPACTION_WARNING_RESET_RATIO,
  COMPACTION_WARNING_TIER_LINES,
  COMPACTION_WARNING_TIER_RATIOS,
  compactionWarningRowsOf,
  compactionWarningStateOf,
  planCompactionWarning,
  readCompactionWarnings,
  warningTierOf,
  type CompactionWarningRow,
} from '../src/model/compaction-warning.ts';
import { estimateHistoryTokens } from '../src/persona/handoff-note.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';
import { RealLoop } from '../src/runtime/real-loop.ts';
import { applyOne } from '../src/state/fold.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const TZ = 'Asia/Shanghai';
const T0 = new Date('2026-10-15T15:00:00.000+08:00');

/** 小阈值：真阈值（20 万）要垫几十万字符，测试跑起来没意义。**线 = 0.8 × 这个数** */
const THRESHOLD = 10_000;
/** 垫料：一口气把阈值推过（第一拍必然 `wrote`） */
const SEED_TEXT = '往'.repeat(30_000);

const PERSONA = {
  identity: 'IDENTITY',
  constitution: 'CONSTITUTION',
  style: 'STYLE',
  state: 'STATE',
  relationship: null,
  personaHash: 'test-hash',
  isSeed: false,
} as unknown as PersonaAssets;

function fakeDs(): DsClient {
  return {
    modelFor: (): string => 'fake',
    generate: async (): Promise<unknown> => ({
      status: 'completed',
      outputItems: [{ type: 'message', id: 'm1', text: '{"picks":[]}' }],
      usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, reasoningTokens: 0 },
      incompleteReason: null,
      model: 'fake-light',
      responseId: 'resp_light',
    }),
    stream: async (): Promise<unknown> => ({
      status: 'completed',
      text: '嗯。',
      reasoning: '',
      toolCalls: [],
      outputItems: [],
      usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, reasoningTokens: 0 },
      incompleteReason: null,
      model: 'fake-heavy',
      responseId: 'resp_heavy',
      durationMs: 3,
      interrupted: false,
      failure: null,
    }),
  } as unknown as DsClient;
}

interface Rig {
  dataDir: string;
  projection: Projection;
  tick: () => Promise<void>;
  events: () => Promise<AppEvent[]>;
  appendWake: (note: string) => Promise<AppEvent>;
  /** 造一条唤醒，它的正文**量出来**约等于 `tokens`（判据用实数，不靠我猜字符数） */
  fillerForTokens: (tokens: number) => Promise<string>;
  /**
   * **在同一份日志上重开一个进程**（换一份空投影 + 新的 RealLoop）——"重启"的替身。
   *
   * 为什么必须换一份**空投影**：重启后 `projection.pending` 是由日志折回来的，而"这条预警发过
   * 没有"不能靠队列（那一格会被重建、也可能早被认领掉）——判据必须从**日志**读回来。
   * 这正是那条用例要钉住的退化点。
   */
  restart: () => Promise<Rig>;
}

async function makeRig(
  t: TestContext,
  opts: { thresholdTokens?: number; reuseDir?: string; keepOnExit?: boolean } = {},
): Promise<Rig> {
  const dir = opts.reuseDir ?? tempDirSync('irmia-compaction-warning-');
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const log = await EventLog.open(join(dataDir, 'events'));
  const projection = emptyProjection();
  const config = defaultConfig(dir);
  config.persona = { ...config.persona, compactionThresholdTokens: opts.thresholdTokens ?? THRESHOLD };
  const loop = new RealLoop({
    log,
    dataDir,
    projection,
    now: () => T0,
    timezone: TZ,
    ds: fakeDs(),
    registry: new ToolRegistry(),
    persona: PERSONA,
    config,
    out: () => {},
    pollMs: 3_600_000,
    timers: new TimerStore(join(dataDir, 'timers.json'), { now: () => T0 }),
  });
  t.after(async () => {
    loop.stop();
    log.close();
    if (opts.keepOnExit === true) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发的句柄占用：清理失败不影响断言结论 */
    }
  });

  const events = async (): Promise<AppEvent[]> => {
    log.flush();
    const out: AppEvent[] = [];
    for await (const event of log.readAll()) out.push(event);
    return out;
  };

  return {
    dataDir,
    projection,
    tick: async () => { await loop.tickOnce(); },
    events,
    appendWake: async (note: string): Promise<AppEvent> => {
      const event = {
        seq: log.nextSeq(),
        ts: T0.toISOString(),
        type: 'wake/manual',
        data: { note },
        visibility: 'model',
        origin: 'test',
      } as unknown as AppEvent;
      log.append(event, { sync: true });
      applyOne(projection, event);
      return event;
    },
    fillerForTokens: async (tokens: number): Promise<string> => {
      log.flush();
      const all: AppEvent[] = [];
      for await (const event of log.readAll()) all.push(event);
      const before = estimateHistoryTokens(all);
      const nextSeq = (all[all.length - 1]?.seq ?? 0) + 1;
      const marker = '\n（新的一段往来。）';
      let text = '料';
      // 逐次逼近：每轮都用**同一把尺**量一次（不做解析式的字符↔token 换算，那是第二份口径）
      for (let i = 0; i < 24; i += 1) {
        const after = estimateHistoryTokens([...all, offsetWake(nextSeq, text + marker)]);
        if (after - before >= tokens) break;
        text += '垫'.repeat(Math.max(64, Math.ceil((tokens - (after - before)) * 1.2)));
      }
      return text + marker;
    },
    restart: async (): Promise<Rig> => {
      log.flush();
      log.close();
      // **在同一份日志上重开一个进程**：换一份空投影 + 新的 RealLoop（`data/` 原样留着）
      const next = await makeRig(t, { ...opts, reuseDir: dir, keepOnExit: true });
      return next;
    },
  };
}

/** 只用于量 token 的假事件（seq 挂在日志末尾之后） */
function offsetWake(seq: number, note: string): AppEvent {
  return {
    seq, ts: T0.toISOString(), type: 'wake/manual', data: { note },
    visibility: 'model', origin: 'test',
  } as unknown as AppEvent;
}

/** 压缩**前**那条预警（本文件唯一的被测对象）；与 `via:'compact'` 严格分开 */
const soonWakes = (events: AppEvent[]): Array<AppEvent & { type: 'wake/manual' }> =>
  events.filter((event): event is AppEvent & { type: 'wake/manual' } =>
    event.type === 'wake/manual' && (event.data as { via?: string }).via === 'compact-soon');

const decisions = (events: AppEvent[]): Array<AppEvent & { type: 'compaction/decision' }> =>
  events.filter((event): event is AppEvent & { type: 'compaction/decision' } =>
    event.type === 'compaction/decision');

/** 最后一行留痕里的 `warning` 那一格 */
const lastWarning = (events: AppEvent[]): Record<string, unknown> | undefined => {
  const rows = decisions(events);
  return rows[rows.length - 1]?.data.warning as Record<string, unknown> | undefined;
};

/**
 * 把夹具推到"**越线、但这一拍压不动**"那一支（预警真正该响的形状）：
 *   ① 第一次越线（顺带压一次，复位那面旗）→ ② 消费掉压缩后的那条唤醒
 *   → ③ 垫一截**超过 80%、但不到一个 recent tail** 的料 ⇒ 下一拍 `gate` ⇒ 该发预警。
 *
 * 判据是**读出来的**而不是"跑了几拍"：`tick` 到出现 `gate`（或已发预警）为止，**最多 6 拍**。
 * 不写死拍数的理由（实测踩过）：垫料的量是按"同一把尺"逐次逼近出来的，落点会在
 * `gate` 与 `threshold` 之间浮动一档；把拍数写死会让用例变成在测"我猜的那一支"。
 */
async function driveToGate(rig: Rig): Promise<{ rows: string[]; soon: number }> {
  await rig.appendWake(SEED_TEXT);
  await rig.tick();                                   // turn 1：wrote（复位那面旗）
  await rig.tick();                                   // turn 2：消费 via=compact

  for (let attempt = 0; attempt < 6; attempt += 1) {
    await rig.appendWake(await rig.fillerForTokens(THRESHOLD + 1_000));
    await rig.tick();
    const events = await rig.events();
    const rows = decisions(events);
    const last = rows[rows.length - 1];
    const soon = soonWakes(events).length;
    const why = (last?.data.warning as { why?: string } | undefined)?.why;
    if (soon > 0 || last?.data.reason === 'gate') {
      return { rows: rows.map(r => `${r.data.turn}:${r.data.reason}/${(r.data.warning as {why?:string})?.why}`), soon };
    }
  }
  const events = await rig.events();
  throw new Error(`6 拍之内没能推到"越线且压不动"那一支：`
    + JSON.stringify(decisions(events).map(r => `${r.data.turn}:${r.data.reason}/${r.data.historyTokens}`)));
}

// ──────────────────────── ① 线下不动 ────────────────────────

test('① 线下不动：历史没到 80% ⇒ 一个字都不发，留痕说清为什么', async (t) => {
  const rig = await makeRig(t, { thresholdTokens: 1_000_000 });
  await rig.appendWake(SEED_TEXT);
  await rig.tick();

  const events = await rig.events();
  assert.equal(soonWakes(events).length, 0, '线下 ⇒ **一条都不发**');
  const w = lastWarning(events);
  assert.equal(w?.['why'], 'below-line', `留痕该如实写"线下"：${JSON.stringify(w)}`);
  assert.equal(w?.['fired'], false);
  assert.equal(typeof w?.['historyTokens'], 'number', '判据用的那个数要留档（不是只留一句结论）');
  assert.equal(w?.['thresholdTokens'], 1_000_000);
  assert.equal(w?.['ratio'], COMPACTION_WARNING_RATIO, '比例固定 0.8（判据模块里那一个常量）');
  // 2026-10-21 加的四格：状态与参数一起落账，事后才能复算"那一拍为什么没报"
  assert.equal(w?.['tier'], 0, '线下 ⇒ 第 0 档');
  assert.equal(w?.['lastTier'], 0, '还没报过 ⇒ 最高档 0');
  assert.equal(w?.['lastAtMs'], null, '还没报过 ⇒ 上次时刻 null');
  assert.equal(w?.['cooldownMs'], 0, '冷却已废弃（2026-10-22）：这一格恒为 0');
  assert.equal(COMPACTION_WARNING_COOLDOWN_MS, 0, '同档冷却整条删掉——常量恒为 0，判据不读时钟');
});

// ──────────────────────── ② 越线就发 ────────────────────────

test('② 越线就发：可见历史 ≥ 80% 且这一拍压不动 ⇒ 发一条真唤醒', async (t) => {
  const rig = await makeRig(t);
  await driveToGate(rig);
  const events = await rig.events();
  const rows = decisions(events);
  const diag = JSON.stringify(rows.map(r => `${r.data.turn}:${r.data.reason}/${r.data.historyTokens}/${(r.data.warning as {why?:string})?.why}`));
  // 发出去的那一行（不是"最后一行"）：驱动函数可能多跑一拍才确认，所以按判据找那一行
  const firedRow = rows.find(r => (r.data.warning as { why?: string } | undefined)?.why === 'fired');
  assert.ok(firedRow !== undefined, `必须有一行落在"发了"那一支：${diag}`);
  assert.equal(soonWakes(events).length, 1, `越线该发一条（实测 ${soonWakes(events).length} 条）`);
  const w = firedRow.data.warning as { why?: string; fired?: boolean; historyTokens?: number; tier?: number | null };
  assert.equal(w.fired, true);
  assert.ok((w.historyTokens ?? 0) >= THRESHOLD * COMPACTION_WARNING_RATIO,
    `判据用的历史确实在线上（${String(w.historyTokens)}）`);
  assert.ok(w.tier === 80 || w.tier === 90 || w.tier === 95,
    `那一拍要落在某一档上（收到 ${String(w.tier)}）`);
  assert.equal(firedRow.data.reason, 'gate', `那一行该是"压不动"那一档：${diag}`);

/** 与文案里同一个千分位口径（`160000` → `160,000`）：用例按人读到的那串字断言 */
const thousands = (value: number): string => value.toLocaleString('en-US');

const note = String(soonWakes(events)[0]!.data.note);
assert.ok(note.startsWith('【框架通报 · 压缩临近】'), '开头要有来源锚（她与事后读日志的人都靠它）');
assert.ok(note.includes(thousands(firedRow.data.historyTokens!)),
  `要给她**现在多少**（绝对数、千分位：${thousands(firedRow.data.historyTokens!)}）——实测正文：${note.slice(0, 80)}`);
assert.ok(note.includes('10,000'), '要给她**阈值多少**（千分位）');
assert.ok(/（\d+(\.\d+)?%）/u.test(note), `要给她百分比——实测正文：${note.slice(0, 80)}`);
assert.ok(note.includes('考虑整理与记录'), '用户点名那一句必须在');
assert.ok(note.includes('继续手头的工作'), '"不是让你停下"那一句必须在');
assert.ok(!note.includes('MEMORIES/facts.md'), '不点名具体要改哪几样（只给方向）');
});

// ──────────────────────── ③ 只发一次 ────────────────────────

test('③ 只发一次：同一条越线状态**不许每拍各发一条**', async (t) => {
  const rig = await makeRig(t);
  await driveToGate(rig);
  await rig.tick();                                   // turn 4：仍然越线、仍然压不动
  await rig.tick();                                   // turn 5：同上

  const events = await rig.events();
  assert.equal(soonWakes(events).length, 1,
    `越线多拍只许一条（实测 ${soonWakes(events).length} 条）：`
    + `${JSON.stringify(decisions(events).map(r => `${r.data.turn}:${r.data.reason}/${(r.data.warning as {why?:string})?.why}`))}`);
  const whys = decisions(events).map(r => (r.data.warning as { why?: string } | undefined)?.why);
  assert.ok(whys.includes('already-warned'),
    `留痕要说清"为什么不发第二条"（**这一档报过了**，2026-10-22 起没有 cooldown）：${JSON.stringify(whys)}`);

  // 那一行的四格必须**足以复算**：同档、上次时刻就是"报过"那一行、冷却已废弃（0）
  const firedRow = decisions(events).find(r => (r.data.warning as { why?: string } | undefined)?.why === 'fired')!;
  const repeatRows = decisions(events).filter(
    r => (r.data.warning as { why?: string } | undefined)?.why === 'already-warned',
  );
  const repeatRow = repeatRows[repeatRows.length - 1]!;
  const firedTier = (firedRow.data.warning as { tier?: number }).tier;
  const cw = repeatRow.data.warning as {
    tier?: number; lastTier?: number; lastAtMs?: number | null; cooldownMs?: number;
  };
  assert.equal(cw.tier, firedTier, '同一档（tier 相同）');
  assert.equal(cw.lastTier, firedTier, 'lastTier = 本周期已经报过的那一档');
  assert.equal(cw.lastAtMs, Date.parse(firedRow.ts), 'lastAtMs = 报过那一行的 ts（同一把钟）');
  assert.equal(cw.cooldownMs, 0, '冷却已废弃：这一格恒为 0');
});

// ──────────────────────── ④ 压缩复位 ────────────────────────

test('④ 压缩复位：压过之后那面旗翻回来 ⇒ 下一次越线再提醒一次', async (t) => {
  const rig = await makeRig(t);
  await driveToGate(rig);
  const afterFirst = await rig.events();
  assert.equal(soonWakes(afterFirst).length, 1, '先拿到第一条预警');

  await rig.tick();                                   // 认领第一条预警
  // 垫够**一个 recent tail 以上**的新料 ⇒ 这一次真的压得动（`wrote`）⇒ 旗子复位
  const big = await rig.fillerForTokens(30_000);
  await rig.appendWake(big);
  await rig.tick();                                   // turn N：wrote（复位）
  await rig.appendWake(await rig.fillerForTokens(THRESHOLD + 1_000));
  await rig.tick();                                   // turn N+1：又越线、又压不动 ⇒ 第二条预警

  const events = await rig.events();
  assert.ok(decisions(events).some(r => r.data.reason === 'wrote'), '中途必须真的压过一次（否则这一条没测到复位）');
  assert.equal(soonWakes(events).length, 2,
    `压过一次之后该允许再提醒一次（实测 ${soonWakes(events).length} 条）：`
    + `${JSON.stringify(decisions(events).map(r => `${r.data.turn}:${r.data.reason}/${(r.data.warning as {why?:string})?.why}`))}`);
  const wakes = soonWakes(events);
  assert.ok(wakes[0]!.seq < wakes[1]!.seq, '顺序单调');
});

// ──────────────────────── ⑤ 阈值随配置走 ────────────────────────

test('⑤ 阈值改 100k ⇒ 线跟着变 80k：**同一份历史、两个阈值、两种结论**', async (t) => {
  // 同一份垫料（量出来约 20,000 token），只改阈值：
  //   · 40,000 ⇒ 线 32,000 ⇒ 线下 ⇒ 不叫
  //   · 20,000 ⇒ 线 16,000 ⇒ 线上 ⇒ 叫
  const below = await makeRig(t, { thresholdTokens: 40_000 });
  await below.appendWake(SEED_TEXT);
  await below.tick();
  const belowEvents = await below.events();
  const belowHistory = lastWarning(belowEvents)?.['historyTokens'] as number;

  const above = await makeRig(t, { thresholdTokens: 20_000 });
  await above.appendWake(SEED_TEXT);
  await above.tick();
  const aboveEvents = await above.events();
  const aboveHistory = lastWarning(aboveEvents)?.['historyTokens'] as number;

  // 判据：**同一份历史估算**（两个夹具喂的是同一份料，量出来的数也就一样）
  assert.equal(belowHistory, aboveHistory,
    `同一份垫料 ⇒ 判据读到的历史该相同（${belowHistory} vs ${aboveHistory}）`);

  const line = (threshold: number): number => threshold * COMPACTION_WARNING_RATIO;
  assert.ok(belowHistory < line(40_000), `${belowHistory} 该在 32,000 之下 ⇒ 不叫`);
  assert.ok(aboveHistory >= line(20_000), `${aboveHistory} 该在 16,000 之上 ⇒ 叫`);

  assert.equal(lastWarning(belowEvents)?.['thresholdTokens'], 40_000, '一边记的是 4 万');
  assert.equal(lastWarning(aboveEvents)?.['thresholdTokens'], 20_000, '另一边记的是 2 万（各记各的）');
  // 两个夹具都只跑了一拍、都在"第一次越线顺带压了"那一档 ⇒ 两边都不发；
  // "线随阈值走"这件事由上面那两条 historyTokens 的比较钉住（同一份历史、两条线）。
  assert.equal(soonWakes(belowEvents).length, 0);
});

// ──────────────────────── ⑥ 判据同源 ────────────────────────

test('⑥ 判据同源：预警读的 `historyTokens` 就是压缩判定刚算出来的那个数', async (t) => {
  const rig = await makeRig(t);
  await driveToGate(rig);

  const events = await rig.events();
  const rows = decisions(events);
  const last = rows[rows.length - 1]!;
  const w = last.data.warning as { historyTokens?: number; thresholdTokens?: number } | undefined;

  assert.equal(w?.historyTokens, last.data.historyTokens,
    '同一个数：留痕里的 historyTokens 与决策里的 historyTokens 逐字相同（不是另算一份）');
  assert.equal(w?.thresholdTokens, last.data.thresholdTokens,
    '阈值同理——预警与压缩读的是同一个键');
});

// ──────────────────────── ⑦ 超 100% 时多一句 ────────────────────────

test('⑦ 超 100% 时文案补一句；没超就不带它（纯文案分支，判据不动）', async (t) => {
  const rig = await makeRig(t);
  await driveToGate(rig);
  const events = await rig.events();
  const note = String(soonWakes(events)[0]!.data.note);
  const firedRow = decisions(events).find(r => (r.data.warning as { why?: string } | undefined)?.why === 'fired')!;

  // 这一支是"越线但压不动"，垫料把历史推过阈值 ⇒ 实测 pct > 100
  const pct = (firedRow.data.historyTokens / firedRow.data.thresholdTokens) * 100;
  assert.ok(pct >= 100, `这个夹具该落在"超 100%"那一档（实测 pct=${pct.toFixed(1)}）`);
  assert.ok(note.includes('已过压缩线 100%，但这一拍没能压成'),
    `超 100% ⇒ 必须补那一句：${note.slice(0, 120)}`);
  // 四个既有要点与三个数一个都不许少（补的是**分支**，不是改写）
  assert.ok(note.includes(`${THRESHOLD.toLocaleString('en-US')}（`), '阈值那个数照旧在');
  assert.ok(note.includes('考虑整理与记录'), '要点一');
  assert.ok(note.includes('继续手头的工作'), '要点二');
  assert.ok(note.includes('压完框架会再叫你一次'), '要点三');
  assert.ok(note.includes('细节读不回来'), '要点四（后果）');
});

test('⑦-b 没超 100% ⇒ 文案**不带**那一句（同一段文字、两种分支）', async (t) => {
  // 配法：线 0.8T 与阈值 T 之间要夹住历史 —— 历史量出来约 20,006 ⇒ 取 T=24,000（线 19,200）。
  // 历史落在 [19,200, 24,000) ⇒ 越线、但**没超 100%** ⇒ 该发、且文案不带那一句。
  const rig = await makeRig(t, { thresholdTokens: 24_000 });
  await rig.appendWake(SEED_TEXT);
  for (let i = 0; i < 6; i += 1) {
    const evs = await rig.events();
    if (soonWakes(evs).length > 0) break;
    await rig.appendWake(await rig.fillerForTokens(1_000));
    await rig.tick();
  }
  const evs = await rig.events();
  const soon = soonWakes(evs);
  const diag = JSON.stringify(decisions(evs).map(r => `${r.data.turn}:${r.data.reason}/${r.data.historyTokens}/${(r.data.warning as {why?:string})?.why}`));
  assert.equal(soon.length, 1, `这一档该发一条（实测 ${soon.length}）：${diag}`);

  const firedRow = decisions(evs).find(r => (r.data.warning as { why?: string } | undefined)?.why === 'fired')!;
  const pct = (firedRow.data.historyTokens / firedRow.data.thresholdTokens) * 100;
  const note = String(soon[0]!.data.note);
  assert.ok(pct < 100, `这个夹具该落在"没超 100%"那一档（实测 ${pct.toFixed(1)}%）：${diag}`);
  assert.ok(!note.includes('已过压缩线 100%'),
    `没超 100% ⇒ **不许**带那一句：${note.slice(0, 120)}`);
  // 四个要点照旧都在（同一段文字，只是少了那一句）
  assert.ok(note.includes('考虑整理与记录') && note.includes('继续手头的工作'));
  assert.ok(note.includes('压完框架会再叫你一次') && note.includes('细节读不回来'));
});

// ──────────────────────── ⑧ 重启后不补发 ────────────────────────

test('⑧ 重启后不补发：日志里已有预警、其后没有 `wrote` ⇒ 新进程的第一拍**不再发一条**', async (t) => {
  const rig = await makeRig(t);
  await driveToGate(rig);                       // 日志里落了一条 compact-soon（其后没有 wrote）
  await rig.tick();                             // 认领掉它（队列清空 —— 重启后的那份 pending 也不该带上它）
  const before = await rig.events();
  const soonBefore = soonWakes(before).length;
  assert.equal(soonBefore, 1, `先得有那一条（实测 ${soonBefore}）`);
  const lastWrite = decisions(before).filter(r => r.data.reason === 'wrote').length;
  assert.ok(lastWrite >= 1, '这条日志里压过一次（判据的参照点就是它）');

  // ★ 重启：同一份日志、**一份全新的空投影**、新的 RealLoop
  const fresh = await rig.restart();
  assert.equal(fresh.projection.pending.length, 0, '新进程起来时队列是空的（那条预警不在队列里）');

  await fresh.tick();                           // 重启后的第一拍
  const after = await fresh.events();
  assert.equal(soonWakes(after).length, 1,
    `重启**不许**补发（实测 ${soonWakes(after).length} 条）：判据必须从日志读回来，不能靠队列`);
  const why = (decisions(after)[decisions(after).length - 1]?.data.warning as { why?: string } | undefined)?.why;
  assert.equal(why, 'already-warned',
    `留痕要说清"为什么不补发"（这一档本周期报过了；收到 ${String(why)}）`);
});

// ═══════════ ⑨–⑬ 纯判据：两档 / 每档一次 / 重置 / 从日志复算（2026-10-22） ═══════════
//
// 上面 ①–⑧ 走真链路（真 EventLog + 真 RealLoop），钉"接通"与"不重报"；
// 下面这几条只调纯函数，钉**判据的形状**（档位、每档一次的永久性、重置、复算材料）。
// 分开的理由：真链路夹具里"越线"往往一口气越过 100%（于是永远落在 95 档），
// 用它的落点去测 80 → 95 两档会变成在测"我猜的那一支"——判据该由显式输入钉。

/** 纯判据用的阈值（只服务下面几条用例；与真链路的 THRESHOLD 无关） */
const TIER_THRESHOLD = 200_000;
const NOW_MS = Date.parse('2026-10-21T14:00:00.000+08:00');
const HOUR_MS = 60 * 60 * 1000;

/**
 * 纯判据调用（缺省：本周期还没报过、结论是"越线但压不动"的那一拍）。
 *
 * ⚠ 不传 `nowMs` / `cooldownMs`：2026-10-22 起判据**不读时钟**（那两个参数已从
 * `CompactionWarningSignals` 删掉）；传了也只是被类型忽略。
 */
function planPure(
  historyTokens: number | null,
  options: {
    thresholdTokens?: number;
    reason?: string;
    lastTier?: CompactionWarningTier;
    lastAtMs?: number | null;
  } = {},
): ReturnType<typeof planCompactionWarning> {
  return planCompactionWarning({
    historyTokens,
    thresholdTokens: options.thresholdTokens ?? TIER_THRESHOLD,
    reason: options.reason ?? 'gate',
    lastTier: options.lastTier ?? 0,
    lastAtMs: options.lastAtMs ?? null,
  });
}

test('⑨ 两档：80% 与 95% 各报一次；90% 落在 80 档（90 那一档删了）', () => {
  const at80 = planPure(0.80 * TIER_THRESHOLD);
  assert.equal(at80.fired, true, '跨 80% ⇒ 报');
  assert.equal(at80.why, 'fired');
  assert.equal(at80.tier, 80);
  assert.equal(at80.lastTier, 0, '这是本周期第一次');
  assert.equal(at80.lastAtMs, null);
  assert.equal(at80.cooldownMs, 0, '冷却已废弃：落账恒为 0');

  const at95 = planPure(0.96 * TIER_THRESHOLD, { lastTier: 80, lastAtMs: NOW_MS - 60_000 });
  assert.equal(at95.fired, true, '跨到 95 档必须报（才过 1 分钟也要报）');
  assert.equal(at95.tier, 95);
  assert.equal(at95.lastTier, 80);

  // 档位刻度只有一处（`warningTierOf`）：边界值按它判——90% 现在只是"还在 80 档"
  assert.equal(warningTierOf(0.7999), 0);
  assert.equal(warningTierOf(0.8), 80);
  assert.equal(warningTierOf(0.8999), 80);
  assert.equal(warningTierOf(0.9), 80, '90% 落在 80 档：90 那一档 2026-10-22 删了');
  assert.equal(warningTierOf(0.9499), 80);
  assert.equal(warningTierOf(0.95), 95);
  assert.equal(warningTierOf(Number.NaN), 0);
  // 刻度表本身只有两档（判据、事件、doctor 读数都从这一份来）
  assert.deepEqual([...COMPACTION_WARNING_TIER_RATIOS], [0.8, 0.95]);
  assert.deepEqual([...COMPACTION_WARNING_TIER_LINES], [80, 95]);
});

test('⑩ 同一档报过就永久不再报：隔一小时 / 一天 / 时钟回拨都不重报；不回头补报更低档', () => {
  for (const [label, lastAtMs] of [
    ['5 分钟', NOW_MS - 5 * 60_000],
    ['整一小时', NOW_MS - HOUR_MS],
    ['一天', NOW_MS - 24 * HOUR_MS],
    ['时钟回拨（lastAtMs 在未来）', NOW_MS + 60_000],
  ] as const) {
    const repeat = planPure(0.92 * TIER_THRESHOLD, { lastTier: 80, lastAtMs });
    assert.equal(repeat.fired, false, `同一档报过之后不重报（${label}）`);
    assert.equal(repeat.why, 'already-warned', `出口是 already-warned，不是已删掉的 cooldown（${label}）`);
    assert.equal(repeat.tier, 80);
    assert.equal(repeat.lastTier, 80);
    assert.equal(repeat.lastAtMs, lastAtMs, '把读到的状态一起落账（便于复算）');
  }

  const lower = planPure(0.85 * TIER_THRESHOLD, { lastTier: 95, lastAtMs: NOW_MS - 24 * HOUR_MS });
  assert.equal(lower.fired, false, '本周期已经报过更高一档 ⇒ 不回头补报低档');
  assert.equal(lower.why, 'already-warned');
});

test('⑩-b 用户点名的那条曲线：同一档跨 5 次只报 1 次；压到 95 再报 1 次；压缩后回落再跨 80 又报 1 次', () => {
  // ① 同一档 80 连跨 5 次，每次隔一小时 ⇒ 只有第一次报
  let lastTier: CompactionWarningTier = 0;
  let lastAtMs: number | null = null;
  let fired = 0;
  for (let i = 0; i < 5; i += 1) {
    const plan = planPure(0.82 * TIER_THRESHOLD, { lastTier, lastAtMs });
    if (plan.fired) {
      fired += 1;
      lastTier = plan.tier as CompactionWarningTier;
      lastAtMs = NOW_MS + i * HOUR_MS;
    }
  }
  assert.equal(fired, 1, `同一档连续跨 5 次（每次隔一小时）⇒ 只报 1 次（实测 ${fired} 次）`);

  // ② 压到 95 ⇒ 再报 1 次（换了一档）
  const at95 = planPure(0.96 * TIER_THRESHOLD, { lastTier, lastAtMs });
  assert.equal(at95.fired, true, '95 是新档 ⇒ 必须报');
  assert.equal(at95.tier, 95);

  // ③ 压缩 ⇒ 分档状态归零（用**复算**这一条真判据，不手写 0）
  const reset = compactionWarningStateOf([
    {
      seq: 1, ts: new Date(NOW_MS).toISOString(), turn: 1,
      historyTokens: 0.82 * TIER_THRESHOLD, thresholdTokens: TIER_THRESHOLD, reason: 'gate',
      tier: 80, firedTier: 80, atMs: NOW_MS, real: null,
    },
    {
      seq: 2, ts: new Date(NOW_MS + HOUR_MS).toISOString(), turn: 2,
      historyTokens: 0.96 * TIER_THRESHOLD, thresholdTokens: TIER_THRESHOLD, reason: 'gate',
      tier: 95, firedTier: 95, atMs: NOW_MS + HOUR_MS, real: null,
    },
    {
      seq: 3, ts: new Date(NOW_MS + 2 * HOUR_MS).toISOString(), turn: 3,
      historyTokens: 0.10 * TIER_THRESHOLD, thresholdTokens: TIER_THRESHOLD, reason: 'wrote',
      tier: 0, firedTier: null, atMs: NOW_MS + 2 * HOUR_MS, real: null,
    },
  ]);
  assert.deepEqual(reset, { lastTier: 0, lastAtMs: null }, '压缩那一行把分档状态归零');

  // ④ 下个周期再跨 80 ⇒ 又报 1 次
  const again = planPure(0.82 * TIER_THRESHOLD, reset);
  assert.equal(again.fired, true, '压缩后回落再跨 80% ⇒ 又报 1 次');
  assert.equal(again.tier, 80);
});

test('⑪ 压缩 / 回落到低位 ⇒ 分档状态归零，下次跨 80 仍报（两个重置点）', () => {
  // 压缩那一行：不判（just-compacted），同时是重置点
  const wrote = planPure(0.98 * TIER_THRESHOLD, {
    reason: 'wrote', lastTier: 95, lastAtMs: NOW_MS - 60_000,
  });
  assert.equal(wrote.fired, false);
  assert.equal(wrote.why, 'just-compacted');

  // 压缩后回 10%：线下（这一行同时是"回落重置"点——比率 < 50%）
  const low = planPure(0.10 * TIER_THRESHOLD);
  assert.equal(low.fired, false);
  assert.equal(low.why, 'below-line');
  assert.equal(low.tier, 0);
  assert.ok(0.10 < COMPACTION_WARNING_RESET_RATIO, '10% 确实落在重置线之下（常量口径）');

  // 状态归零之后，下次跨 80% **仍报**——这就是修掉"永久静默"的那一条
  const again = planPure(0.85 * TIER_THRESHOLD, { lastTier: 0, lastAtMs: null });
  assert.equal(again.fired, true);
  assert.equal(again.tier, 80);
});

test('⑫ 从日志复算：wrote 与 <50% 都是重置点；报过的最高档与时刻逐行可复算', () => {
  const row = (
    historyTokens: number,
    reason: string,
    firedTier: CompactionWarningTier | null,
    atMs: number,
  ): CompactionWarningRow => ({
    seq: Math.round(atMs / 1000),
    ts: new Date(atMs).toISOString(),
    turn: 1,
    historyTokens,
    thresholdTokens: TIER_THRESHOLD,
    reason,
    tier: warningTierOf(historyTokens / TIER_THRESHOLD),
    firedTier,
    atMs,
    real: null,
  });

  // 三行都报过（中间那一行是 2026-10-21 老日志里的 90 档）⇒ 最高 95、上次时刻 = 第三行
  const three = [
    row(0.80 * TIER_THRESHOLD, 'gate', 80, NOW_MS - 3_000),
    row(0.90 * TIER_THRESHOLD, 'gate', 90, NOW_MS - 2_000),
    row(0.95 * TIER_THRESHOLD, 'gate', 95, NOW_MS - 1_000),
  ];
  assert.deepEqual(compactionWarningStateOf(three), { lastTier: 95, lastAtMs: NOW_MS - 1_000 });

  // 压缩那一行 ⇒ 归零（旧档位不跨压缩活下去）
  assert.deepEqual(
    compactionWarningStateOf([...three, row(0.97 * TIER_THRESHOLD, 'wrote', null, NOW_MS)]),
    { lastTier: 0, lastAtMs: null },
  );

  // 没有压缩、但回落到 <50% ⇒ 也归零
  assert.deepEqual(
    compactionWarningStateOf([...three, row(0.10 * TIER_THRESHOLD, 'threshold', null, NOW_MS)]),
    { lastTier: 0, lastAtMs: null },
  );

  // 回落到 60%（在重置线之上）⇒ 保留最高档与时刻；它不该被当成新周期
  assert.deepEqual(
    compactionWarningStateOf([...three, row(0.60 * TIER_THRESHOLD, 'threshold', null, NOW_MS)]),
    { lastTier: 95, lastAtMs: NOW_MS - 1_000 },
  );
});

test('⑬ 老日志兼容：没有 tier 那一格的旧行按同一把尺补算；readout 给出最近一次预警与真实读数', () => {
  const decisionEvent = (seq: number, ts: string, data: Record<string, unknown>): AppEvent => ({
    seq, ts, type: 'compaction/decision', data, visibility: 'internal', origin: 'test',
  } as unknown as AppEvent);

  const oldRow = decisionEvent(1, '2026-10-21T06:00:00.000Z', {
    turn: 3,
    historyTokens: 170_000,
    thresholdTokens: 200_000,
    reason: 'gate',
    // 2026-10-21 之前写的形状：**没有** tier / lastTier / lastAtMs / cooldownMs
    warning: {
      fired: true, why: 'fired', historyTokens: 170_000, thresholdTokens: 200_000, ratio: COMPACTION_WARNING_RATIO,
    },
  });
  const rows = compactionWarningRowsOf([oldRow]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.tier, 80, '170k / 200k = 0.85 ⇒ 80 档');
  assert.equal(rows[0]!.firedTier, 80, '旧行按同一把尺补算出"报过哪一档"');

  const readout = readCompactionWarnings([oldRow]);
  assert.equal(readout.lastFired?.firedTier, 80);
  assert.equal(readout.state.lastTier, 80);
  assert.equal(readout.lastReal, null, '旧行没有真实读数 ⇒ 不编一个 0');

  // 2026-10-21 那一版写下的形状：真实读数两格原样进复算（`readCompactionWarnings.lastReal`），
  // 而 `tier: 90` / `cooldownMs: 1800000` 这两个**老档位与老冷却**也必须读得回来
  const legacyTiered = decisionEvent(2, '2026-10-21T06:10:00.000Z', {
    turn: 4,
    historyTokens: 180_000,
    thresholdTokens: 200_000,
    reason: 'gate',
    inputTokens: 151_204,
    estimatedInputTokens: 180_000,
    warning: {
      fired: true, why: 'fired', historyTokens: 180_000, thresholdTokens: 200_000, ratio: COMPACTION_WARNING_RATIO,
      tier: 90, lastTier: 80, lastAtMs: Date.parse('2026-10-21T06:00:00.000Z'),
      cooldownMs: 30 * 60 * 1000,
    },
  });
  const readout2 = readCompactionWarnings([oldRow, legacyTiered]);
  assert.deepEqual(readout2.lastReal?.real, { inputTokens: 151_204, estimatedInputTokens: 180_000 });
  assert.equal(readout2.state.lastTier, 90, '老日志里的 90 档照样复算出来（本版判据不再产生它）');
  assert.equal(readout2.state.lastAtMs, Date.parse('2026-10-21T06:10:00.000Z'));
});
