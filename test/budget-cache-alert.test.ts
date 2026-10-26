/**
 * 缓存成本的两条告警 —— 2026-10-22 这一批（用户：「缓存未命中在暴涨，框架没有任何警告」）。
 *
 * ─────────────────────────── 这一份钉什么 ───────────────────────────
 *
 * **A. 结果判据**（`budget/cache-alert`，判据在 `runtime/cache-alert.ts`）：
 *   ① **正常窗口不报**（未命中率 1%）——告警不许常态化；
 *   ② **窗口 30% 且比基线高 ≥2 倍 ⇒ 报一条**，载荷字段齐、单位是 token 当量；
 *   ③ **同一天同档不重复报**（24 小时去重，判据从日志读）；
 *   ④ **窗口不足 5 轮不报**（样本不够不判，哪怕比值 90%）；
 *   ⑤ **两条 lane 分开算**（heavy 报、light 不报）；
 *   ⑥ **基线不含窗口自己**（否则"持续恶化"会把中位数拖上去、最该叫的那一次恰好不叫）；
 *   ⑦ **归因写得出 `reasoning-echo-eviction`**（不落进 `unknown`）。
 *
 * **B. 前兆判据**（`model/reasoning-echo{kind:'reasoning_echo_pressure'}`，判据在
 *   `runtime/reasoning-echo-pressure.ts`）：
 *   ⑧ 回传字符 / 上限 ≥ 90% ⇒ 报；60% ⇒ 不报；
 *   ⑨ 顶穿之后读的是**会回传的总量**（kept + dropped），不是 kept —— 后者会变好看；
 *   ⑩ 同档 24 小时去重；没有思维链 ⇒ `no-sample`（不是"0%"）。
 *
 * **C. 三个读数出口同源**：`cli tail` 的一行、doctor 的两条 `OPS-*`——它们引的必须是
 *   **同一份**读数（`cacheAlertReadings` / `echoPressureReadings`），否则"同一个指标两个数"的
 *   老毛病会原样复发。
 *
 * 一律走**真判据**（不 mock 判断逻辑），只构造事件流：这几条判据是纯函数，事件流就是它们的全部输入。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { summarizeEvent } from '../src/cli.ts';
import type { AppEvent } from '../src/log/types.js';
import { estimatePrefixHitOf, type ContextBreakdown, type ContextSectionFact } from '../src/model/context-audit.ts';
import { REASONING_ECHO_POLICY } from '../src/model/render.ts';
import {
  CACHE_ALERT_MIN_TURNS,
  CACHE_ALERT_MISS_RATIO,
  CACHE_ALERT_WINDOW_TURNS,
  cacheAlertConsoleLine,
  cacheAlertPayloadOf,
  cacheAlertReadings,
  cacheAlertWakeNote,
  estimateByBucketOf,
  missRatioBandOf,
  planCacheAlert,
  planCacheAlerts,
} from '../src/runtime/cache-alert.ts';
import { checkCacheMiss, checkEchoPressure } from '../src/runtime/doctor.ts';
import {
  ECHO_PRESSURE_RATIO,
  echoPressureConsoleLine,
  echoPressureReadings,
  planEchoPressure,
  readEchoPressure,
} from '../src/runtime/reasoning-echo-pressure.ts';

// ──────────────────────────────── 夹具 ────────────────────────────────

/** 判据的"现在"（毫秒） */
const NOW_MS = Date.parse('2026-10-21T12:00:00.000Z');
const NOW = new Date(NOW_MS).toISOString();
const seq = { next: 1 };
const at = (minutesAgo: number): string => new Date(NOW_MS - minutesAgo * 60_000).toISOString();
/** 一天前 + 五分钟：落在 24 小时基线窗口之外（基线只回看 24 小时） */
const OUT_OF_BASELINE = 24 * 60 + 5;

function event(type: string, data: unknown, visibility: 'model' | 'internal', ts: string): AppEvent {
  const seqNo = seq.next++;
  return { seq: seqNo, ts, type, data, visibility, origin: 'test/cache-alert' } as unknown as AppEvent;
}

/** 一条 `budget/consumed`（只给判据要的那几格；其余按"缺省 = 未知"处理） */
function consumed(args: {
  ts: string;
  turn: number;
  lane?: 'heavy' | 'light';
  /** 模型名（2026-10-26 起窗口按 `lane|model` 分；缺省 `'fake'` 与老夹具一致） */
  model?: string;
  hit: number;
  miss: number;
  /** 输入合计（缺省 = hit + miss；零命中夹具要显式给，因为 miss 可能也是 0） */
  inputTokens?: number;
  output?: number;
  retryCount?: number;
  reasoningTokens?: number;
  renderVersion?: string;
  headHash?: string;
  /** 整份 `context`（前缀自算那几条用例自己构造；给了它就覆盖下面那份默认段事实） */
  context?: ContextBreakdown;
}): AppEvent {
  const input = args.inputTokens ?? args.hit + args.miss;
  return event('budget/consumed', {
    turn: args.turn,
    step: 1,
    lane: args.lane ?? 'heavy',
    model: args.model ?? 'fake',
    inputTokens: input,
    outputTokens: args.output ?? 100,
    cacheHitTokens: args.hit,
    cacheMissTokens: args.miss,
    reasoningTokens: args.reasoningTokens ?? 0,
    durationMs: 1000,
    retryCount: args.retryCount ?? 0,
    finishReason: 'completed',
    tokensTodayAccum: input,
    ...(args.context !== undefined
      ? { context: args.context }
      : (args.renderVersion === undefined && args.headHash === undefined
        ? {}
        : { context: contextOf({ renderVersion: args.renderVersion, headHash: args.headHash }) })),
  }, 'internal', args.ts);
}

/**
 * 一份完整的 `context` 段事实（`budget/consumed.context` 的形状）。
 *
 * 默认值就是"什么都不变"的那一份；前缀自算的用例只改自己关心的那几段——
 * 这样"哪一段相同、哪一段不同"在夹具里一眼看得出来。
 */
function contextOf(args: {
  renderVersion?: string;
  headHash?: string;
  instructions?: { tokens: number; hash: string };
  tools?: { tokens: number; hash: string };
  memory?: { tokens: number; hash: string };
  history?: { tokens: number; hash: string; items?: number; headHash?: string; headItems?: ContextSectionFact[] };
  state?: { tokens: number; hash: string };
  now?: { tokens: number; hash: string };
  wake?: { tokens: number; hash: string };
  hint?: { tokens: number; hash: string };
  input?: { items: number; tokens: number };
}): ContextBreakdown {
  const history = args.history ?? { tokens: 1, hash: 'h' };
  return {
    renderVersion: args.renderVersion ?? '74',
    instructions: args.instructions ?? { tokens: 1, hash: 'i' },
    tools: args.tools ?? { tokens: 1, hash: 't', count: 1 },
    memory: args.memory ?? { tokens: 1, hash: 'm' },
    history: {
      tokens: history.tokens,
      hash: history.hash,
      items: history.items ?? 1,
      headHash: history.headHash ?? (args.headHash ?? 'head-a'),
      ...(history.headItems === undefined ? {} : { headItems: history.headItems }),
    },
    ...(args.state === undefined ? {} : { state: args.state }),
    now: args.now ?? { tokens: 1, hash: 'n' },
    wake: args.wake ?? { tokens: 1, hash: 'w' },
    hint: args.hint ?? { tokens: 1, hash: 'x' },
    input: args.input ?? { items: 1, tokens: 1 },
  };
}

/** 一条 `message/reasoning`（`reasoningEchoPlan` 只认 model 可见的那些） */
function reasoning(ts: string, chars: number, text = '想'.repeat(chars)): AppEvent {
  return event('message/reasoning', { turn: 1, step: 1, text }, 'model', ts);
}

/**
 * 一段"正常"的调用：每轮 hit 99000 / miss 1000 ⇒ 未命中率 **1%**（用户给的正常值 ~1–2%）。
 *
 * `startMinutesAgo` 是**第一轮**距今多少分钟，往后每轮晚一分钟（越靠后越新）。
 * turn 号从 `firstTurn` 起递增——判据按"哪一档更新"（seq）排序，轮号只用来分桶。
 */
function normalTurns(args: {
  count: number;
  firstTurn: number;
  startMinutesAgo: number;
  lane?: 'heavy' | 'light';
  renderVersion?: string;
  headHash?: string;
}): AppEvent[] {
  const out: AppEvent[] = [];
  for (let index = 0; index < args.count; index += 1) {
    out.push(consumed({
      ts: at(args.startMinutesAgo - index),
      turn: args.firstTurn + index,
      ...(args.lane === undefined ? {} : { lane: args.lane }),
      hit: 99_000,
      miss: 1_000,
      ...(args.renderVersion === undefined ? {} : { renderVersion: args.renderVersion }),
      ...(args.headHash === undefined ? {} : { headHash: args.headHash }),
    }));
  }
  return out;
}

/** 一段"暴涨"的调用：每轮 hit 70000 / miss 30000 ⇒ 未命中率 **30%** */
function badTurns(args: {
  count: number;
  firstTurn: number;
  startMinutesAgo: number;
  lane?: 'heavy' | 'light';
  renderVersion?: string;
  headHash?: string;
}): AppEvent[] {
  const out: AppEvent[] = [];
  for (let index = 0; index < args.count; index += 1) {
    out.push(consumed({
      ts: at(args.startMinutesAgo - index),
      turn: args.firstTurn + index,
      ...(args.lane === undefined ? {} : { lane: args.lane }),
      hit: 70_000,
      miss: 30_000,
      ...(args.renderVersion === undefined ? {} : { renderVersion: args.renderVersion }),
      ...(args.headHash === undefined ? {} : { headHash: args.headHash }),
    }));
  }
  return out;
}

/**
 * 货币符号本身也**不写字面量**：下面几条断言要证明"文案里没有它"，
 * 而源码里留一个它，等于同一个符号仍然在仓库里。
 * `U+00A5` = 半角 yen/yuan 符号。
 */
const CURRENCY_SIGN = String.fromCodePoint(0xa5);

const plan = (events: AppEvent[], lane: 'heavy' | 'light' = 'heavy', respectDedupe = true) =>
  planCacheAlert({ events, lane, nowMs: NOW_MS, respectDedupe });

// ──────────────────────────────── A. 结果判据 ────────────────────────────────

describe('A · 缓存未命中率告警（budget/cache-alert）', () => {
  test('① 正常窗口（未命中率 1%）⇒ 不报', () => {
    const events = [
      ...normalTurns({ count: 10, firstTurn: 1, startMinutesAgo: 200 }),
      ...normalTurns({ count: CACHE_ALERT_WINDOW_TURNS, firstTurn: 100, startMinutesAgo: 30 }),
    ];
    const verdict = plan(events);
    assert.equal(verdict.fired, false, '未命中率 1% 时一个字都不许报');
    assert.equal(verdict.why, 'below-ratio');
    assert.ok(verdict.reading !== null);
    // 读数照样给得出来（doctor 要能读"现在多健康"，不只是"叫没叫"）
    assert.equal(verdict.reading.missRatio, 0.01);
    assert.equal(verdict.reading.windowTurns, CACHE_ALERT_WINDOW_TURNS);
  });

  test('② 窗口 30% 且比基线高 ≥2 倍 ⇒ 报一条，载荷字段齐', () => {
    const events = [
      // 基线：窗口之前的 10 轮，1%（同一份 renderVersion，避免撞上'渲染换代'那条归因）
      ...normalTurns({ count: 10, firstTurn: 1, startMinutesAgo: 200, renderVersion: '74' }),
      // 窗口：最近 20 轮，30%
      ...badTurns({ count: CACHE_ALERT_WINDOW_TURNS, firstTurn: 100, startMinutesAgo: 30, renderVersion: '74' }),
    ];
    const verdict = plan(events);
    assert.equal(verdict.fired, true, '30% 且基线 1% ⇒ 必须报');
    assert.equal(verdict.why, 'fired');
    const reading = verdict.reading;
    assert.ok(reading !== null);

    // 三个触发条件各自的读数（缺一条都不该报，所以三条都要能在载荷里核对）
    assert.ok(reading.missRatio > CACHE_ALERT_MISS_RATIO, `窗口 30% > 触发线 ${CACHE_ALERT_MISS_RATIO}`);
    assert.equal(reading.baselineMissRatio, 0.01, '基线 = 窗口之前 24 小时的每轮中位数');
    assert.equal(reading.windowTurns, CACHE_ALERT_WINDOW_TURNS);

    // 载荷：任务书点名的那六格 + 单位 + 去重键两格，一格都不许少。
    // 2026-10-26 起再加四格（窗口按模型切 + 自算口径，见 `runtime/cache-alert.ts` 的文件头 ①②）：
    // `model` / `modelsInWindow` / `windowInputTokens` / `windowProviderHitTokens`，
    // 以及两格口径 `cacheReported` / `cacheEstimated`。
    const payload = cacheAlertPayloadOf(reading);
    assert.deepEqual(Object.keys(payload).sort(), [
      'baselineMissRatio', 'cacheEstimated', 'cacheReported', 'estCostPerTurn', 'estCostUnit', 'lane',
      'missRatio', 'missRatioBand', 'model', 'modelsInWindow', 'renderVersion', 'topContributor',
      'windowInputTokens', 'windowProviderHitTokens', 'windowTurns',
    ]);
    assert.equal(payload.model, 'fake', '窗口用的是哪个模型必须落进载荷（文案要带模型名）');
    assert.deepEqual(payload.modelsInWindow, ['fake'], '这一段只混过一个模型');
    assert.equal(payload.windowInputTokens, 100_000 * CACHE_ALERT_WINDOW_TURNS, 'Σinput = Σ(hit+miss)');
    assert.equal(payload.windowProviderHitTokens, 70_000 * CACHE_ALERT_WINDOW_TURNS);
    assert.equal(payload.cacheReported, true, '供方给了数 ⇒ 这一行读数按供方算');
    assert.equal(payload.cacheEstimated, false);
    assert.equal(payload.estCostUnit, 'miss-equiv-tokens', '单位必须写进数据里，防误读成金额');
    // estCostPerTurn = 未命中 + 输出 + 命中/10 = 30000 + 100 + 7000 = 37100（**token，不是钱**）
    assert.equal(payload.estCostPerTurn, 37_100);
    assert.equal(payload.lane, 'heavy');
    assert.equal(payload.missRatioBand, missRatioBandOf(reading.missRatio));
    // 归因：没有任何一条候选成立时如实说"不知道"，不许编
    assert.equal(payload.topContributor, 'unknown');
  });

  test('②b 实测当天峰值 22.82% 也要报（任务书原定的 25% 正好落在峰值之上）', () => {
    // 2026-10-21 那天那一场：全天峰值窗口 **22.82%**、基线 1.73%（13.2 倍）。
    // 这一条正面钉住"绝对线必须低于实测峰值"，否则这条判据在把它叫出来的事故里一次都不响。
    const events = [
      ...normalTurns({ count: 10, firstTurn: 1, startMinutesAgo: 200, renderVersion: '74' }),
      // 20 轮 × (hit 77_180 / miss 22_820) ⇒ 22.82%
      ...Array.from({ length: CACHE_ALERT_WINDOW_TURNS }, (_, index) => consumed({
        ts: at(30 - index),
        turn: 100 + index,
        hit: 77_180,
        miss: 22_820,
        renderVersion: '74',
      })),
    ];
    const verdict = plan(events);
    assert.equal(verdict.fired, true);
    assert.equal(verdict.reading?.missRatio, 0.2282);
    assert.ok(verdict.reading!.missRatio > CACHE_ALERT_MISS_RATIO);
  });

  test('③ 同一天再触发同档 ⇒ 不重复报（24 小时去重从日志读）', () => {
    const base = [
      ...normalTurns({ count: 10, firstTurn: 1, startMinutesAgo: 200, renderVersion: '74' }),
      ...badTurns({ count: CACHE_ALERT_WINDOW_TURNS, firstTurn: 100, startMinutesAgo: 30, renderVersion: '74' }),
    ];
    const first = plan(base);
    assert.equal(first.fired, true);
    assert.ok(first.reading !== null);

    // 把"已经报过"这件事落成事件（运行期就是 `real-loop` 的 appendSync），再判一次
    const reported = event(
      'budget/cache-alert',
      { ...cacheAlertPayloadOf(first.reading) },
      'internal',
      at(1),
    );
    const second = plan([...base, reported]);
    assert.equal(second.fired, false, '同一 (lane, renderVersion, 档位) 24 小时内只报一次');
    assert.equal(second.why, 'duplicate');
    // 读数照旧给得出来——"没再叫"不等于"已经好了"
    assert.ok(second.reading !== null);
    assert.ok(second.reading.missRatio > CACHE_ALERT_MISS_RATIO);
  });

  test('③b 越过 24 小时之后同一个档位可以再报', () => {
    const events = [
      ...normalTurns({ count: 10, firstTurn: 1, startMinutesAgo: 200, renderVersion: '74' }),
      ...badTurns({ count: CACHE_ALERT_WINDOW_TURNS, firstTurn: 100, startMinutesAgo: 30, renderVersion: '74' }),
      // 一天多以前报过的那条：不该压住今天这一条
      event('budget/cache-alert', {
        lane: 'heavy', windowTurns: 20, missRatio: 0.3, baselineMissRatio: 0.01,
        estCostPerTurn: 37_100, estCostUnit: 'miss-equiv-tokens', topContributor: 'unknown',
        renderVersion: '74', missRatioBand: missRatioBandOf(0.3),
      }, 'internal', at(OUT_OF_BASELINE + 60)),
    ];
    const verdict = plan(events);
    assert.equal(verdict.fired, true, '去重窗口是 24 小时，昨天的账不该压住今天');
  });

  test('④ 窗口不足 5 轮 ⇒ 不报（哪怕比值 90%）', () => {
    // 这条 lane 一共只有 4 档（窗口 = 最近 20 档，但这里只有 4 档）
    const events = badTurns({
      count: CACHE_ALERT_MIN_TURNS - 1, firstTurn: 100, startMinutesAgo: 30, renderVersion: '74',
    }).map((item) => {
      const data = (item as unknown as { data: Record<string, unknown> }).data;
      data['cacheHitTokens'] = 0;
      data['cacheMissTokens'] = 100_000;
      return item;
    });
    const verdict = plan(events);
    assert.equal(verdict.fired, false, '样本不够不判');
    assert.equal(verdict.why, 'too-few-turns');
    assert.ok(verdict.reading !== null);
    assert.equal(verdict.reading.windowTurns, CACHE_ALERT_MIN_TURNS - 1);
    // "样本不够"不许被读成"数值健康"：比值本身是 100%，出口却必须说清原因
    assert.equal(verdict.reading.missRatio, 1);
  });

  test('⑤ 两条 lane 分开算：heavy 报、light 不报', () => {
    const events = [
      ...normalTurns({ count: 10, firstTurn: 1, startMinutesAgo: 200, renderVersion: '74' }),
      ...badTurns({ count: CACHE_ALERT_WINDOW_TURNS, firstTurn: 100, startMinutesAgo: 30, lane: 'heavy', renderVersion: '74' }),
      // light 同期 1%（另一条 lane 的正常值本来就不是一个数）
      ...normalTurns({ count: 10, firstTurn: 1, startMinutesAgo: 200, lane: 'light', renderVersion: '74' }),
      ...normalTurns({ count: CACHE_ALERT_WINDOW_TURNS, firstTurn: 100, startMinutesAgo: 30, lane: 'light', renderVersion: '74' }),
    ];
    // 一趟算两条（运行期与 doctor 走的都是这一条）
    const verdicts = planCacheAlerts({ events, nowMs: NOW_MS, respectDedupe: true });
    const heavy = verdicts.find(verdict => verdict.reading?.lane === 'heavy')
      ?? verdicts[0];
    const light = verdicts.find(verdict => verdict.reading?.lane === 'light')
      ?? verdicts[1];
    assert.ok(heavy !== undefined && light !== undefined);
    assert.equal(heavy.fired, true, 'heavy 30% ⇒ 报');
    assert.equal(light.fired, false, 'light 1% ⇒ 不报');
    assert.equal(light.why, 'below-ratio');
    assert.equal(heavy.reading?.missRatio, 0.3);
    assert.equal(light.reading?.missRatio, 0.01);
  });

  test('⑥ 基线不含窗口自己：持续恶化时中位数不会被拖高', () => {
    // 窗口之前 20 轮 1%、窗口 20 轮 30%。若把窗口算进基线，中位数会被拉向 30%，
    // 比值趋近 1 ⇒ 最该叫的那一次恰好不叫。这里正面钉住"不含"。
    const events = [
      ...normalTurns({ count: 20, firstTurn: 1, startMinutesAgo: 200, renderVersion: '74' }),
      ...badTurns({ count: CACHE_ALERT_WINDOW_TURNS, firstTurn: 100, startMinutesAgo: 30, renderVersion: '74' }),
    ];
    const verdict = plan(events);
    assert.equal(verdict.reading?.baselineMissRatio, 0.01, '基线只看窗口之前那一段');
    assert.equal(verdict.fired, true);
  });

  test('⑥b 窗口之前 24 小时内没有基线 ⇒ 不报（no-baseline，不拿 0 冒充）', () => {
    const events = [
      // 基线全在 24 小时之外
      ...normalTurns({ count: 20, firstTurn: 1, startMinutesAgo: OUT_OF_BASELINE + 60, renderVersion: '74' }),
      ...badTurns({ count: CACHE_ALERT_WINDOW_TURNS, firstTurn: 100, startMinutesAgo: 30, renderVersion: '74' }),
    ];
    const verdict = plan(events);
    assert.equal(verdict.fired, false);
    assert.equal(verdict.why, 'no-baseline');
    assert.equal(verdict.reading?.baselineMissRatio, -1, '算不出来就是 -1，不写 0');
  });

  test('⑦ 归因写得出 reasoning-echo-eviction（不落进 unknown）', () => {
    // ⚠ 顺序即 seq：事件按插入顺序发 seq，而"窗口的 seq 区间"是判据的一部分——
    // 所以那条 prune 必须**插在窗口中间**，不能补在末尾（补在末尾就落在窗口之外了）。
    const events = [
      ...normalTurns({ count: 10, firstTurn: 1, startMinutesAgo: 200, renderVersion: '74' }),
      ...badTurns({ count: 10, firstTurn: 100, startMinutesAgo: 50, renderVersion: '74' }),
      // 窗口中间落一条"撞总字符上限的整组丢"——那正是当天那场（顶穿 300,000 之后每笔挤掉最老一组）
      event('model/reasoning-echo', {
        turn: 110,
        step: 1,
        kind: 'reasoning_echo_prune',
        dropped: [{ assistantSeq: 5, reasoningSeqs: [6], chars: 60_000, items: 2, why: 'maxTotalChars' }],
      }, 'internal', at(20)),
      ...badTurns({ count: 10, firstTurn: 110, startMinutesAgo: 40, renderVersion: '74' }),
    ];
    const verdict = plan(events);
    assert.equal(verdict.fired, true);
    assert.equal(verdict.reading?.windowTurns, CACHE_ALERT_WINDOW_TURNS);
    assert.equal(verdict.reading?.topContributor, 'reasoning-echo-eviction');
  });

  test('⑦b 只有 half-state / maxItems 的整组丢 ⇒ 不算那个根因', () => {
    const events = [
      ...normalTurns({ count: 10, firstTurn: 1, startMinutesAgo: 200, renderVersion: '74' }),
      ...badTurns({ count: 10, firstTurn: 100, startMinutesAgo: 50, renderVersion: '74' }),
      event('model/reasoning-echo', {
        turn: 110, step: 1, kind: 'reasoning_echo_prune',
        dropped: [{ assistantSeq: 5, reasoningSeqs: [], chars: 0, items: 2, why: 'half-state' }],
      }, 'internal', at(20)),
      ...badTurns({ count: 10, firstTurn: 110, startMinutesAgo: 40, renderVersion: '74' }),
    ];
    const verdict = plan(events);
    assert.equal(verdict.fired, true);
    assert.notEqual(verdict.reading?.topContributor, 'reasoning-echo-eviction');
  });
});

// ──────────────── A2. 2026-10-26 这一批：窗口按模型切 + 不返回缓存就自算 ────────────────
//
// 用户两条指示（原话）：
//   ①「缓存命中只看窗口内模型。切换模型就重新放。」
//   ②「如果是不返回缓存命中的模型就我们自己算。」
// 现场根据（`<数据目录>\events` seq 250635–250947 / turns 3783–3792）：
//   `gpt-6.1-sol` 30 拍 hit=47,232 / miss=820,151（94.6%），每拍 hit 恒为 0 或固定的 5,248；
//   切回 `deepseek-flash` 之后 22 拍 11.1%（逐步 6.3 / 8.1 / 6.5%）。
// 下面每一条都走**真判据**（`planCacheAlert` / `planCacheAlerts`），只构造事件流。

/** 一段"某个模型"的调用（`hit`/`miss`/`inputTokens` 原样给，做零命中/固定命中那些夹具用） */
function series(args: {
  count: number;
  firstTurn: number;
  startMinutesAgo: number;
  model: string;
  hits: readonly number[];
  inputs: readonly number[];
  contextOfIndex?: (index: number) => ContextBreakdown;
}): AppEvent[] {
  const out: AppEvent[] = [];
  for (let index = 0; index < args.count; index += 1) {
    const hit = args.hits[index] ?? 0;
    const inputTokens = args.inputs[index] ?? 0;
    out.push(consumed({
      ts: at(args.startMinutesAgo - index),
      turn: args.firstTurn + index,
      model: args.model,
      hit,
      miss: Math.max(0, inputTokens - hit),
      inputTokens,
      ...(args.contextOfIndex === undefined ? {} : { context: args.contextOfIndex(index) }),
    }));
  }
  return out;
}

/** 读数里剔除"诊断那一格"（`modelsInWindow` 就是这么一格：它不参与判据） */
function withoutModelsInWindow(reading: unknown): Record<string, unknown> {
  const { modelsInWindow, ...rest } = reading as Record<string, unknown>;
  void modelsInWindow;
  return rest;
}

describe('A2 · 窗口按 lane|model 切（换模型即重开）', () => {
  test('① 同一模型 20 轮、中间夹 3 轮别的模型 ⇒ 窗口只统计前者，读数与"只喂前者"逐字相同', () => {
    // 基线 10 轮（同模型、1%）+ 窗口 20 轮（同模型、30%）：模型名都用 deepseek-flash，
    // 这样"基线也要同模型"那一条也一起被钉住。
    // ⚠ seq 是**按创建顺序**发的，所以这里按"日志里的顺序"建：基线 → 前 10 轮 → 3 轮别的模型
    //   → 后 10 轮。那 3 轮夹在窗口中间（不是补在末尾——补在末尾就成了"最新那个模型"）。
    const baseline = series({
      count: 10, firstTurn: 1, startMinutesAgo: 200, model: 'deepseek-flash',
      hits: new Array(10).fill(99_000), inputs: new Array(10).fill(100_000),
    });
    const mineFirst = series({
      count: 10, firstTurn: 100, startMinutesAgo: 30, model: 'deepseek-flash',
      hits: new Array(10).fill(70_000), inputs: new Array(10).fill(100_000),
    });
    // 中间夹 3 轮**另一个模型**（现场就是 gpt-6.1-sol：hit 恒 0 或 5248 那种）
    const foreign = series({
      count: 3, firstTurn: 60, startMinutesAgo: 24, model: 'gpt-6.1-sol',
      hits: [0, 5_248, 0], inputs: [20_000, 21_000, 22_000],
    });
    const mineSecond = series({
      count: 10, firstTurn: 110, startMinutesAgo: 20, model: 'deepseek-flash',
      hits: new Array(10).fill(70_000), inputs: new Array(10).fill(100_000),
    });

    const pure = plan([...baseline, ...mineFirst, ...mineSecond]);
    const mixed = plan([...baseline, ...mineFirst, ...foreign, ...mineSecond]);
    assert.ok(pure.reading !== null && mixed.reading !== null);

    // **逐字相同**（除了那格"诊断用的模型清单"）：3 轮别的模型一个字节都没进这个窗口
    assert.deepEqual(withoutModelsInWindow(mixed.reading), withoutModelsInWindow(pure.reading));
    assert.equal(mixed.reading.windowTurns, CACHE_ALERT_WINDOW_TURNS, '窗口仍是前者的 20 轮');
    assert.equal(mixed.reading.missRatio, 0.3);
    assert.equal(mixed.reading.baselineMissRatio, 0.01, '基线也是同一模型那 10 轮');
    assert.equal(mixed.reading.model, 'deepseek-flash', '窗口用的是最新那个模型');
    // 夹在里面的模型只在诊断那一格出现，**不参与判据**
    assert.deepEqual(mixed.reading.modelsInWindow, ['deepseek-flash', 'gpt-6.1-sol']);
    assert.deepEqual(pure.reading.modelsInWindow, ['deepseek-flash']);
    assert.equal(pure.fired, true, '30% 且基线 1% ⇒ 照旧报');
    // 旧口径（"最近 20 档不分模型"）会把这 3 轮也算进来：17 拍 30% + 3 拍几乎全 miss 的别的模型
    // ⇒ 32.2%（不是 30%）。这里把这笔旧账**算出来留在断言里**，让"为什么要按模型切"
    // 有一个可复算的对照数——现场那一版是 94.6% 与 11.1% 混成一个 79.8%，偏差比这大得多。
    const legacyHit = 17 * 70_000 + (0 + 5_248 + 0);
    const legacyMiss = 17 * 30_000 + (20_000 + 21_000 + 22_000 - 5_248);
    assert.equal(Math.round((legacyMiss / (legacyHit + legacyMiss)) * 10_000) / 10_000, 0.322);
  });

  test('② 换了模型之后第一轮 ⇒ 窗口只有 1 个样本，不到 MIN_TURNS ⇒ 不报', () => {
    const events = [
      ...normalTurns({ count: 20, firstTurn: 1, startMinutesAgo: 200, renderVersion: '74' }),
      // 新模型的第一拍：就算它是 100% 未命中，也不许拿"上一个模型的 20 轮"来判
      consumed({
        ts: at(5), turn: 300, model: 'gpt-6.1-sol', hit: 0, miss: 21_378,
      }),
    ];
    const verdict = plan(events);
    assert.equal(verdict.fired, false);
    assert.equal(verdict.why, 'too-few-turns');
    assert.ok(verdict.reading !== null);
    assert.equal(verdict.reading.model, 'gpt-6.1-sol');
    assert.equal(verdict.reading.windowTurns, 1, '换模型即重开：窗口只有新模型这一拍');
    assert.ok(verdict.reading.windowTurns < CACHE_ALERT_MIN_TURNS);
  });
});

describe('A2 · 不返回缓存命中的模型：我们自己算', () => {
  /**
   * 前缀"两段相同"的上下文：`instructions`（1000 tok）与 `memory`（2000 tok）每拍都一样，
   * `tools` 同哈希但 0 tok（这样"两段之和"就是 1000 + 2000），`history` 每拍都不同 ⇒
   * 前缀在 memory 之后断掉，`state` / `now` 都不进估算。
   */
  const sharingPrefix = (index: number): ContextBreakdown => contextOf({
    instructions: { tokens: 1_000, hash: 'i-same' },
    tools: { tokens: 0, hash: 't-same', count: 0 },
    memory: { tokens: 2_000, hash: 'm-same' },
    history: {
      tokens: 100 + index, hash: `h-${index}`, items: 1 + index,
      headItems: [{ name: '#1', tokens: 100 + index, hash: `head-${index}` }],
    },
    state: { tokens: 50, hash: 's-same' },
    now: { tokens: 5, hash: `n-${index}` },
  });

  test('③ 零命中模型（供方 hit 恒 0）⇒ 走自算；5 拍前缀两段相同 ⇒ 命中=两段之和、miss=input−它', () => {
    // 6 拍、每拍 10,000 输入、供方 hit 恒 0（`cacheMissTokens` 也照写入侧口径 = input）
    const events = series({
      count: 6, firstTurn: 100, startMinutesAgo: 30, model: 'gpt-6.1-sol',
      hits: [0, 0, 0, 0, 0, 0], inputs: [10_000, 10_000, 10_000, 10_000, 10_000, 10_000],
      contextOfIndex: sharingPrefix,
    });
    // 纯函数那一半先钉住"两段 tokens 之和"：1000（instructions）+ 0（tools）+ 2000（memory）
    const estimate = estimatePrefixHitOf(sharingPrefix(0), sharingPrefix(1));
    assert.equal(estimate, 3_000, '只累加连续相同的段：instructions + tools(0) + memory');

    // 真判据：整窗改自算（第一拍没有同模型上一拍 ⇒ 只算 0，保守）
    const verdict = plan(events);
    const reading = verdict.reading;
    assert.ok(reading !== null);
    assert.equal(reading.cacheEstimated, true, '这一行读数是按上下文前缀自算的');
    assert.equal(reading.cacheReported, false, '供方没给数');
    assert.equal(reading.windowProviderHitTokens, 0, '供方一次都没报命中');
    assert.equal(reading.windowInputTokens, 60_000);
    // 5 拍各 3000 = 15,000 估算命中；其余 45,000 是估算未命中 ⇒ 75%
    assert.equal(reading.missRatio, 0.75);
    // 逐档也钉一下：第一拍 0 / 后面每拍 3000
    const samples = estimateByBucketOf({ events, lane: 'heavy', model: 'gpt-6.1-sol' });
    const values = [...samples.values()].map(sample => sample.hit);
    assert.deepEqual(values, [0, 3_000, 3_000, 3_000, 3_000, 3_000]);
    assert.equal(samples.size, 6);

    // 供方没给数 ⇒ 事件里那两格如实写（`budget/consumed` 由写入侧写；这里是同口径的窗口级读数）
    const payload = cacheAlertPayloadOf(reading);
    assert.equal(payload.cacheReported, false);
    assert.equal(payload.cacheEstimated, true);
    assert.equal(payload.model, 'gpt-6.1-sol');
    // 没有同模型基线 ⇒ 照旧不报（自算不放宽"相对基线"这一条）
    assert.equal(verdict.fired, false);
    assert.equal(verdict.why, 'no-baseline');
  });

  test('③b 「拍」与「轮」不是同一个数：4 轮 / 32 拍也能自算，但判据仍按轮（不报）', () => {
    // 现场形状：gpt-6.1-sol 的 30 拍只摊在 4 轮里（每轮 8 步）。口径按**拍**开
    // （"持续 ≥ 5 拍"），判据的样本下限按**轮**（"≥ 5 轮"）——两个数都写在这里。
    const events: AppEvent[] = [];
    for (let turn = 100; turn < 104; turn += 1) {
      for (let step = 0; step < 8; step += 1) {
        const index = (turn - 100) * 8 + step;
        events.push(consumed({
          ts: at(30 - index * 0.1), turn, model: 'gpt-6.1-sol', hit: 5_248 * (index % 2), miss: 0,
          // 现场那一拍的输入（21,378）：`c × 4 = 20,992 ≤ 21,378` ⇒ 走"常数命中量"那一档判据
          inputTokens: 21_378, context: sharingPrefix(index),
        }));
      }
    }
    const verdict = plan(events);
    const reading = verdict.reading;
    assert.ok(reading !== null);
    assert.equal(reading.windowCalls, 32, '拍数 32');
    assert.equal(reading.windowTurns, 4, '轮数只有 4');
    assert.equal(reading.cacheEstimated, true, '口径按拍开 ⇒ 这一行是自算的');
    assert.equal(verdict.fired, false);
    assert.equal(verdict.why, 'too-few-turns', '判据按轮：4 轮 < 5 ⇒ 判不出来就不报');
  });

  test('④ 供方给了数 ⇒ 用供方，cacheEstimated:false（不被自算覆盖）', () => {
    // 同一份"两段相同"的上下文（自算会给到 3000 命中），但供方明确报了 70,000 命中。
    // ⇒ 读数必须是供方的 30%，而不是自算出来的那个更大的数。
    const events = series({
      count: 6, firstTurn: 100, startMinutesAgo: 30, model: 'deepseek-flash',
      hits: [70_000, 70_000, 70_000, 70_000, 70_000, 70_000],
      inputs: [100_000, 100_000, 100_000, 100_000, 100_000, 100_000],
      contextOfIndex: sharingPrefix,
    });
    const verdict = plan(events);
    const reading = verdict.reading;
    assert.ok(reading !== null);
    assert.equal(reading.cacheEstimated, false, '供方给了数 ⇒ 一个字都不自算');
    assert.equal(reading.cacheReported, true);
    assert.equal(reading.missRatio, 0.3, '30% = 供方的数（自算会把它盖成 99.7%）');
    assert.equal(reading.windowProviderHitTokens, 70_000 * 6);
  });

  test('⑤ 文案三档：常规 / 零命中 / 自算，各自带模型名、都不写钱', () => {
    // ① 常规：供方给了数（deepseek-flash，30% 且基线 1%）
    const regular = plan([
      ...series({
        count: 10, firstTurn: 1, startMinutesAgo: 200, model: 'deepseek-flash',
        hits: new Array(10).fill(99_000), inputs: new Array(10).fill(100_000),
      }),
      ...series({
        count: CACHE_ALERT_WINDOW_TURNS, firstTurn: 100, startMinutesAgo: 30, model: 'deepseek-flash',
        hits: new Array(CACHE_ALERT_WINDOW_TURNS).fill(70_000),
        inputs: new Array(CACHE_ALERT_WINDOW_TURNS).fill(100_000),
      }),
    ]);
    assert.ok(regular.reading !== null);
    const regularNote = cacheAlertWakeNote(regular.reading);
    assert.match(regularNote, /【框架通报 · 缓存成本】最近 20 轮（heavy · deepseek-flash）未命中 30\.0%，24 小时基线 1\.0%——/u);
    assert.ok(!regularNote.includes(CURRENCY_SIGN), '文案里不许出现货币符号');
    assert.ok(!regularNote.includes('自算'), '供方给了数就不许说自算');

    // ② 零命中：供方 hit 恒 0（gpt-6.1-sol）
    const zero = plan(series({
      count: 6, firstTurn: 100, startMinutesAgo: 30, model: 'gpt-6.1-sol',
      hits: [0, 0, 0, 0, 0, 0], inputs: [10_000, 10_000, 10_000, 10_000, 10_000, 10_000],
      contextOfIndex: sharingPrefix,
    }));
    assert.ok(zero.reading !== null);
    const zeroNote = cacheAlertWakeNote(zero.reading);
    assert.match(zeroNote, /gpt-6\.1-sol 最近 6 轮一次缓存都没命中（命中 0 \/ 输入 60k）/u);
    assert.match(zeroNote, /该端点很可能不支持前缀缓存，换模型即可恢复/u);
    assert.ok(!zeroNote.includes(CURRENCY_SIGN));

    // ③ 自算：供方报的是一个**与上下文规模无关的常数**（现场那 9 拍固定 5,248）
    const fixed = plan(series({
      count: 6, firstTurn: 100, startMinutesAgo: 30, model: 'gpt-6.1-sol',
      hits: [0, 5_248, 0, 5_248, 0, 5_248],
      inputs: [21_378, 20_239, 20_449, 16_074, 22_259, 28_404],
      contextOfIndex: (index) => contextOf({
        instructions: { tokens: 7_052, hash: 'd3738e' },
        tools: { tokens: 5_476, hash: '4d118a', count: 24 },
        memory: { tokens: 1_057, hash: 'bf5909' },
        history: {
          tokens: 200 + index, hash: `h-${index}`, items: 1 + index,
          headItems: [{ name: '#1', tokens: 200 + index, hash: `head-${index}` }],
        },
        now: { tokens: 314, hash: `n-${index}` },
      }),
    }));
    assert.ok(fixed.reading !== null);
    assert.equal(fixed.reading.cacheEstimated, true, '常数命中量 ⇒ 视作"不返回缓存数据"⇒ 自算');
    assert.equal(fixed.reading.windowProviderHitTokens, 5_248 * 3, '供方那三拍的 5248 照旧落账');
    const fixedNote = cacheAlertWakeNote(fixed.reading);
    assert.match(fixedNote, /（heavy · gpt-6\.1-sol）未命中/u);
    assert.match(fixedNote, /（该模型不返回缓存数据，本行按上下文前缀自算）/u);
    assert.ok(!fixedNote.includes(CURRENCY_SIGN));
    // 三档的读数行（控制台/doctor/cli 同源）也都要带模型名
    assert.match(cacheAlertReadings(regular.reading), /（heavy · deepseek-flash）/u);
    assert.match(cacheAlertReadings(zero.reading), /（heavy · gpt-6\.1-sol） · 按上下文前缀自算/u);
  });

  test('⑤b 自算那一档：前缀断了、命中就塌（判据照旧抓得住）', () => {
    // 基线（同模型、窗口之前、24 小时内）：10 拍，前缀稳定 ⇒ 自算命中高（约 13.6k / 14k 输入）
    const stable = (index: number): ContextBreakdown => contextOf({
      instructions: { tokens: 7_052, hash: 'i' },
      tools: { tokens: 5_476, hash: 't' },
      memory: { tokens: 1_057, hash: 'm' },
      history: {
        tokens: 20 + index, hash: `hs-${index}`, items: 1 + index,
        headItems: [{ name: '#1', tokens: 20, hash: 'same-head' }],
      },
      now: { tokens: 300, hash: `ns-${index}` },
    });
    // 窗口（同模型、最近 20 拍）：instructions 每拍都被改写 ⇒ 自算命中塌到 0
    const broken = (index: number): ContextBreakdown => contextOf({
      instructions: { tokens: 7_052, hash: `i-${index}` },
      tools: { tokens: 5_476, hash: 't' },
      memory: { tokens: 1_057, hash: 'm' },
      history: { tokens: 200, hash: `hb-${index}`, items: 2, headItems: [{ name: '#1', tokens: 200, hash: `head-b-${index}` }] },
      now: { tokens: 300, hash: `nb-${index}` },
    });
    const events = [
      ...series({
        count: 10, firstTurn: 1, startMinutesAgo: 300, model: 'gpt-6.1-sol',
        hits: new Array(10).fill(0), inputs: new Array(10).fill(14_000), contextOfIndex: stable,
      }),
      ...series({
        count: CACHE_ALERT_WINDOW_TURNS, firstTurn: 100, startMinutesAgo: 30, model: 'gpt-6.1-sol',
        hits: new Array(CACHE_ALERT_WINDOW_TURNS).fill(0),
        inputs: new Array(CACHE_ALERT_WINDOW_TURNS).fill(14_000),
        contextOfIndex: broken,
      }),
    ];
    const verdict = plan(events);
    assert.ok(verdict.reading !== null);
    assert.equal(verdict.reading.cacheEstimated, true);
    assert.ok(verdict.reading.missRatio > 0.9, `窗口自算未命中应接近 100%：${verdict.reading.missRatio}`);
    assert.ok(verdict.reading.baselineMissRatio < 0.05, `基线也走自算：前缀稳定时命中高（${verdict.reading.baselineMissRatio}）`);
    assert.equal(verdict.fired, true, '自算口径下"前缀每拍都断"必须报');
  });
});

describe('A2 · 前缀自算（estimatePrefixHitOf）的六条口径', () => {
  const base = (patch: Parameters<typeof contextOf>[0]): ContextBreakdown => contextOf(patch);

  test('两段相同、history 不同 ⇒ 只算前两段；instructions 一变 ⇒ 0', () => {
    const a = base({
      instructions: { tokens: 1_000, hash: 'i' },
      tools: { tokens: 0, hash: 't' },
      memory: { tokens: 2_000, hash: 'm' },
      history: { tokens: 5, hash: 'h-a' },
    });
    const b = base({
      instructions: { tokens: 1_000, hash: 'i' },
      tools: { tokens: 0, hash: 't' },
      memory: { tokens: 2_000, hash: 'm' },
      history: { tokens: 7, hash: 'h-b' },
    });
    assert.equal(estimatePrefixHitOf(a, b), 3_000, 'instructions + memory（tools 那一段 0 token）');
    assert.equal(estimatePrefixHitOf(b, base({
      instructions: { tokens: 1_000, hash: 'i-changed' },
      tools: { tokens: 0, hash: 't' },
      memory: { tokens: 2_000, hash: 'm' },
    })), 0, '第一处就不同 ⇒ 一个 token 都不算');
  });

  test('history 逐条比：追加 ⇒ 前面算、还能继续；就地改写 ⇒ 算到断点就停', () => {
    const prev = base({
      instructions: { tokens: 1_000, hash: 'i' },
      tools: { tokens: 500, hash: 't' },
      memory: { tokens: 200, hash: 'm' },
      history: {
        tokens: 20, hash: 'h1', items: 2,
        headItems: [{ name: '#1', tokens: 10, hash: 'a' }, { name: '#2', tokens: 10, hash: 'b' }],
      },
      state: { tokens: 50, hash: 's' },
      now: { tokens: 5, hash: 'n1' },
    });
    // 追加一条：前缀仍然完整 ⇒ 继续到 state（state 相同、now 不同就停）
    const appended = base({
      instructions: { tokens: 1_000, hash: 'i' },
      tools: { tokens: 500, hash: 't' },
      memory: { tokens: 200, hash: 'm' },
      history: {
        tokens: 30, hash: 'h2', items: 3,
        headItems: [{ name: '#1', tokens: 10, hash: 'a' }, { name: '#2', tokens: 10, hash: 'b' }, { name: '#3', tokens: 10, hash: 'c' }],
      },
      state: { tokens: 50, hash: 's' },
      now: { tokens: 5, hash: 'n2' },
    });
    assert.equal(estimatePrefixHitOf(prev, appended), 1_000 + 500 + 200 + 20 + 50);
    // 就地改写：条数没变而整段哈希变了 ⇒ 第一条就不同 ⇒ 只算到 history 之前
    const rewritten = base({
      instructions: { tokens: 1_000, hash: 'i' },
      tools: { tokens: 500, hash: 't' },
      memory: { tokens: 200, hash: 'm' },
      history: {
        tokens: 20, hash: 'h9', items: 2,
        headItems: [{ name: '#1', tokens: 10, hash: 'a-rewritten' }, { name: '#2', tokens: 10, hash: 'b' }],
      },
      state: { tokens: 50, hash: 's' },
      now: { tokens: 5, hash: 'n2' },
    });
    assert.equal(estimatePrefixHitOf(prev, rewritten), 1_000 + 500 + 200);
  });

  test('没有逐条事实（老日志）⇒ history 一个 token 都不算；两边段集合不同 ⇒ 从缺的那段断', () => {
    const prev = base({
      instructions: { tokens: 1_000, hash: 'i' },
      tools: { tokens: 0, hash: 't' },
      memory: { tokens: 0, hash: 'm' },
      history: { tokens: 20, hash: 'h1' },
      now: { tokens: 5, hash: 'n1' },
    });
    // 两边都没有 headItems：整段哈希不同 ⇒ 无法逐条比 ⇒ 0（不猜）
    const cur = base({
      instructions: { tokens: 1_000, hash: 'i' },
      tools: { tokens: 0, hash: 't' },
      memory: { tokens: 0, hash: 'm' },
      history: { tokens: 30, hash: 'h2' },
      now: { tokens: 5, hash: 'n2' },
    });
    assert.equal(estimatePrefixHitOf(prev, cur), 1_000);
    // 整段哈希相同 ⇒ 整段命中，继续往后比（state 只有一边有 ⇒ 断在 state）
    const same = base({
      instructions: { tokens: 1_000, hash: 'i' },
      tools: { tokens: 0, hash: 't' },
      memory: { tokens: 0, hash: 'm' },
      history: { tokens: 20, hash: 'h1' },
      state: { tokens: 50, hash: 's' },
      now: { tokens: 5, hash: 'n1' },
    });
    assert.equal(estimatePrefixHitOf(prev, same), 1_000 + 20);
  });
});

// ──────────────────────────────── B. 前兆判据 ────────────────────────────────

describe('B · 思维链回传压力告警（reasoning_echo_pressure）', () => {
  const CAP = REASONING_ECHO_POLICY.maxTotalChars ?? 0;

  /** 一段"只有思维链 + 一条 turn/end"的事件流（判据只读这两类） */
  function echoEvents(charsList: readonly number[], turn = 7): AppEvent[] {
    const events: AppEvent[] = charsList.map((chars, index) => reasoning(at(60 - index), chars));
    events.push(event('turn/start', { turn }, 'internal', at(70)));
    events.push(event('step/start', { turn, step: 2, model: 'fake', lane: 'heavy', renderVersion: '74', personaHash: 'p' }, 'internal', at(65)));
    events.push(event('turn/end', { turn, reason: { kind: 'completed' }, spoke: false }, 'internal', at(1)));
    return events;
  }

  test('⑧ 回传字符 / 上限 ≥ 90% ⇒ 报；60% ⇒ 不报', () => {
    assert.ok(CAP > 0, '出厂策略该有总字符上限');
    // 95%：一条 0.95 × cap 的思维链
    const hot = echoEvents([Math.round(CAP * 0.95)]);
    const hotSignals = readEchoPressure(hot);
    assert.equal(hotSignals.echoChars, Math.round(CAP * 0.95));
    assert.equal(hotSignals.cap, CAP);
    const hotVerdict = planEchoPressure(hotSignals, { nowMs: NOW_MS, events: hot, respectDedupe: true });
    assert.equal(hotVerdict.fired, true, '95% 是前兆区，必须报');
    assert.equal(hotVerdict.why, 'fired');
    assert.ok(hotVerdict.ratio >= ECHO_PRESSURE_RATIO);

    // 60%：不报
    const cool = echoEvents([Math.round(CAP * 0.6)]);
    const coolVerdict = planEchoPressure(readEchoPressure(cool), { nowMs: NOW_MS, events: cool, respectDedupe: true });
    assert.equal(coolVerdict.fired, false);
    assert.equal(coolVerdict.why, 'below-line');
  });

  test('⑧b 前兆比结果**早**：还没开始驱逐（dropped=0）时就可以响', () => {
    // 实测那一场：回传字符在本地 02:30 之前就到 93.9%（**还没开始挤**），
    // 而驱逐从 02:54:56 才开始、结果判据要到 03:24 才越过 20%。
    // 这一条钉住"前兆在驱逐之前就能响"——否则它就只是结果判据的复读机。
    const cap = REASONING_ECHO_POLICY.maxTotalChars ?? 0;
    const events = echoEvents([Math.round(cap * 0.939)]);
    const signals = readEchoPressure(events);
    assert.equal(signals.droppedGroups, 0, '还没开始驱逐');
    assert.equal(signals.evictedThisTurn, false);
    const verdict = planEchoPressure(signals, { nowMs: NOW_MS, events, respectDedupe: true });
    assert.equal(verdict.fired, true, '93.9% ⇒ 前兆必须已经响');
    assert.ok(verdict.ratio < 1, '而且是在**顶穿之前**响的');
  });

  test('⑨ 顶穿之后读的是"会回传的总量"，不是 kept（后者会变好看）', () => {
    // 6 条各 0.2 × cap = 1.2 × cap ⇒ 撞上限、整组丢到 ≤ cap
    const each = Math.round(CAP * 0.2);
    const events = echoEvents(Array.from({ length: 6 }, () => each));
    const signals = readEchoPressure(events);
    assert.ok(signals.droppedGroups >= 1, '超上限 ⇒ 一定有整组被丢');
    assert.ok(signals.keptChars <= CAP, 'kept 被压回上限以内（这正是"拿 it 当压力会变好看"的原因）');
    assert.ok(signals.echoChars > CAP, '会回传的总量已经顶穿');
    assert.equal(signals.echoChars, signals.keptChars + signals.droppedChars);
    const verdict = planEchoPressure(signals, { nowMs: NOW_MS, events, respectDedupe: true });
    assert.equal(verdict.fired, true);
    // 档位封顶在 100%：顶穿之后不再随历史增长而逐档刷屏
    assert.equal(verdict.band, Math.floor(1 / 0.05));
  });

  test('⑨b 本轮驱逐过没有：从日志里的 turn 号读，不看进程内存', () => {
    const each = Math.round(CAP * 0.2);
    const events = echoEvents(Array.from({ length: 6 }, () => each), 7);
    assert.equal(readEchoPressure(events).evictedThisTurn, false, '没有 prune 事件 ⇒ 本轮没驱逐');

    events.push(event('model/reasoning-echo', {
      turn: 7, step: 2, kind: 'reasoning_echo_prune',
      dropped: [{ assistantSeq: 1, reasoningSeqs: [2], chars: each, items: 2, why: 'maxTotalChars' }],
    }, 'internal', at(0.5)));
    assert.equal(readEchoPressure(events).evictedThisTurn, true, '本轮的 prune 事件 ⇒ 已在驱逐');

    // 别的轮的 prune 不算"本轮"
    const otherTurn = [...events, event('model/reasoning-echo', {
      turn: 6, step: 2, kind: 'reasoning_echo_prune',
      dropped: [{ assistantSeq: 1, reasoningSeqs: [2], chars: each, items: 2, why: 'maxTotalChars' }],
    }, 'internal', at(0.4))];
    assert.equal(readEchoPressure(otherTurn).evictedThisTurn, true, '本轮那条还在，当然仍是 true');
  });

  test('⑩ 同档 24 小时去重；没有思维链 ⇒ no-sample（不是"0%"）', () => {
    const hot = echoEvents([Math.round(CAP * 0.95)]);
    const signals = readEchoPressure(hot);
    const first = planEchoPressure(signals, { nowMs: NOW_MS, events: hot, respectDedupe: true });
    assert.equal(first.fired, true);

    const reported = event('model/reasoning-echo', {
      turn: 7, step: 2, kind: 'reasoning_echo_pressure',
      pressure: {
        echoChars: signals.echoChars, keptChars: signals.keptChars, cap: CAP,
        ratio: first.ratio, evicted: false, droppedGroups: 0, droppedChars: 0, band: first.band,
      },
    }, 'internal', at(1));
    const second = planEchoPressure(signals, { nowMs: NOW_MS, events: [...hot, reported], respectDedupe: true });
    assert.equal(second.fired, false);
    assert.equal(second.why, 'duplicate');

    // 空历史：没有一条会回传的思维链 ⇒ 比例算不出来（不是 0%）
    const empty = echoEvents([]);
    const emptySignals = readEchoPressure(empty);
    assert.equal(emptySignals.echoChars, 0);
    const emptyVerdict = planEchoPressure(emptySignals, { nowMs: NOW_MS, events: empty, respectDedupe: true });
    assert.equal(emptyVerdict.fired, false);
    assert.equal(emptyVerdict.why, 'no-sample');
  });
});

// ──────────────────────────────── C. 三个读数出口同源 ────────────────────────────────

describe('C · 出口同源（控制台 / doctor / cli tail）', () => {
  test('① 控制台一行与 doctor 的读数引用的是同一份字面量', () => {
    const events = [
      ...normalTurns({ count: 10, firstTurn: 1, startMinutesAgo: 200, renderVersion: '74' }),
      ...badTurns({ count: CACHE_ALERT_WINDOW_TURNS, firstTurn: 100, startMinutesAgo: 30, renderVersion: '74' }),
    ];
    const verdict = plan(events);
    assert.ok(verdict.reading !== null);
    const readings = cacheAlertReadings(verdict.reading);
    const line = cacheAlertConsoleLine(verdict.reading);
    assert.ok(line.startsWith('[成本] '), `控制台行要以 [成本] 开头：${line}`);
    assert.ok(line.includes(readings), '控制台那一行必须整段引用同一份读数');
    // 任务书原句的四个要素：现在的未命中率 / 基线 / 最近多少轮 / 每轮多少
    assert.match(line, /缓存未命中率 30\.0%（基线 1\.0%）/u);
    assert.match(line, /最近 20 轮/u);
    assert.match(line, /每轮约 37\.1k 未命中当量/u);
    assert.match(line, /检查 renderVersion 换代 \/ reasoning 回传 \/ 历史尾部变化/u);
    // ⚠ 代码里不许出现货币符号 / 计费口径（四处成文的用户铁律）
    assert.ok(!line.includes(CURRENCY_SIGN), '文案里不许出现货币符号');
  });

  test('② doctor：两条 OPS 项——超线是 warn、正常是 ok、判不出来是 skip', () => {
    const bad = [
      ...normalTurns({ count: 10, firstTurn: 1, startMinutesAgo: 200, renderVersion: '74' }),
      ...badTurns({ count: CACHE_ALERT_WINDOW_TURNS, firstTurn: 100, startMinutesAgo: 30, renderVersion: '74' }),
    ];
    const missWarn = checkCacheMiss(bad, NOW_MS, '');
    assert.equal(missWarn.id, 'OPS-cache-miss');
    assert.equal(missWarn.status, 'warn');
    assert.ok(missWarn.detail.includes('缓存未命中率 30.0%'));
    assert.ok(!missWarn.detail.includes(CURRENCY_SIGN));

    const good = normalTurns({ count: 30, firstTurn: 1, startMinutesAgo: 200, renderVersion: '74' });
    assert.equal(checkCacheMiss(good, NOW_MS, '').status, 'ok');

    // 判不出来（样本不够）⇒ skip，不许读成"健康"
    const thin = normalTurns({ count: 2, firstTurn: 1, startMinutesAgo: 10, renderVersion: '74' });
    assert.equal(checkCacheMiss(thin, NOW_MS, '').status, 'skip');

    // 压力那条
    const cap = REASONING_ECHO_POLICY.maxTotalChars ?? 0;
    const hot = [reasoning(at(5), Math.round(cap * 0.95)),
      event('turn/end', { turn: 7, reason: { kind: 'completed' }, spoke: false }, 'internal', at(1))];
    const pushWarn = checkEchoPressure(hot);
    assert.equal(pushWarn.id, 'OPS-echo-pressure');
    assert.equal(pushWarn.status, 'warn');
    assert.match(pushWarn.detail, /翻 3 倍以上/u, 'doctor 要写明"顶穿之后账单翻 3 倍以上"');
    assert.ok(!pushWarn.detail.includes(CURRENCY_SIGN));
    // 没有思维链 ⇒ skip（不是 ok）
    assert.equal(checkEchoPressure([]).status, 'skip');
  });

  test('③ cli tail 一行读得到这两条事件（沿用既有 summarize）', () => {
    const alert = event('budget/cache-alert', {
      lane: 'heavy', model: 'deepseek-flash', modelsInWindow: ['deepseek-flash'],
      windowTurns: 20, windowInputTokens: 2_000_000, windowProviderHitTokens: 1_400_000,
      missRatio: 0.3, baselineMissRatio: 0.01,
      estCostPerTurn: 37_100, estCostUnit: 'miss-equiv-tokens',
      topContributor: 'reasoning-echo-eviction', renderVersion: '74', missRatioBand: 3,
      cacheReported: true, cacheEstimated: false,
    }, 'internal', NOW);
    const line = summarizeEvent(alert);
    assert.match(line, /缓存未命中率 30\.0%（基线 1\.0%）/u);
    assert.match(line, /最近 20 轮（heavy · deepseek-flash）/u);
    assert.match(line, /主嫌疑 reasoning-echo-eviction/u);
    assert.ok(!line.includes(CURRENCY_SIGN));

    // 老事件（2026-10-26 之前写的，没有 `model` 那一格）：`cli tail` 照样要印得出一行，
    // 缺模型就写"模型未知"——不拿 lane 名顶替（那会把"没记"读成"这条 lane 只有一个模型"）。
    const legacy = event('budget/cache-alert', {
      lane: 'heavy', windowTurns: 20, missRatio: 0.3, baselineMissRatio: 0.01,
      estCostPerTurn: 37_100, estCostUnit: 'miss-equiv-tokens',
      topContributor: 'unknown', renderVersion: '74', missRatioBand: 3,
    }, 'internal', NOW);
    assert.match(summarizeEvent(legacy), /最近 20 轮（heavy · 模型未知）/u);

    const pressure = event('model/reasoning-echo', {
      turn: 7, step: 2, kind: 'reasoning_echo_pressure',
      pressure: {
        echoChars: 288_000, keptChars: 288_000, cap: 300_000,
        ratio: 0.96, evicted: false, droppedGroups: 0, droppedChars: 0, band: 19,
      },
    }, 'internal', NOW);
    const pLine = summarizeEvent(pressure);
    assert.match(pLine, /前兆 · 回传 288000 \/ 上限 300000 字符（96\.0%）/u);
    assert.ok(!pLine.includes(CURRENCY_SIGN));

    // 压力那条的读数函数与 doctor/控制台同源
    const signals = {
      turn: 7, step: 2, cap: 300_000, echoChars: 288_000, keptChars: 288_000,
      droppedGroups: 0, droppedChars: 0, evictedThisTurn: false,
    };
    const readings = echoPressureReadings(signals, 0.96);
    assert.ok(echoPressureConsoleLine(signals, 0.96).includes(readings));
  });
});
