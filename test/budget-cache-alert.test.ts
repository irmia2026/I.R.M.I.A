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
import { REASONING_ECHO_POLICY } from '../src/model/render.ts';
import {
  CACHE_ALERT_MIN_TURNS,
  CACHE_ALERT_MISS_RATIO,
  CACHE_ALERT_WINDOW_TURNS,
  cacheAlertConsoleLine,
  cacheAlertPayloadOf,
  cacheAlertReadings,
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
  hit: number;
  miss: number;
  output?: number;
  retryCount?: number;
  reasoningTokens?: number;
  renderVersion?: string;
  headHash?: string;
}): AppEvent {
  return event('budget/consumed', {
    turn: args.turn,
    step: 1,
    lane: args.lane ?? 'heavy',
    model: 'fake',
    inputTokens: args.hit + args.miss,
    outputTokens: args.output ?? 100,
    cacheHitTokens: args.hit,
    cacheMissTokens: args.miss,
    reasoningTokens: args.reasoningTokens ?? 0,
    durationMs: 1000,
    retryCount: args.retryCount ?? 0,
    finishReason: 'completed',
    tokensTodayAccum: args.hit + args.miss,
    ...(args.renderVersion === undefined && args.headHash === undefined
      ? {}
      : {
        context: {
          renderVersion: args.renderVersion ?? '74',
          instructions: { tokens: 1, hash: 'i' },
          tools: { tokens: 1, hash: 't', count: 1 },
          memory: { tokens: 1, hash: 'm' },
          history: { tokens: 1, hash: 'h', items: 1, headHash: args.headHash ?? 'head-a' },
          now: { tokens: 1, hash: 'n' },
          wake: { tokens: 1, hash: 'w' },
          hint: { tokens: 1, hash: 'x' },
          input: { items: 1, tokens: 1 },
        },
      }),
  }, 'internal', args.ts);
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

    // 载荷：任务书点名的那六格 + 单位 + 去重键两格，一格都不许少
    const payload = cacheAlertPayloadOf(reading);
    assert.deepEqual(Object.keys(payload).sort(), [
      'baselineMissRatio', 'estCostPerTurn', 'estCostUnit', 'lane',
      'missRatio', 'missRatioBand', 'renderVersion', 'topContributor', 'windowTurns',
    ]);
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
      lane: 'heavy', windowTurns: 20, missRatio: 0.3, baselineMissRatio: 0.01,
      estCostPerTurn: 37_100, estCostUnit: 'miss-equiv-tokens',
      topContributor: 'reasoning-echo-eviction', renderVersion: '74', missRatioBand: 3,
    }, 'internal', NOW);
    const line = summarizeEvent(alert);
    assert.match(line, /缓存未命中率 30\.0%（基线 1\.0%）/u);
    assert.match(line, /最近 20 轮（heavy）/u);
    assert.match(line, /主嫌疑 reasoning-echo-eviction/u);
    assert.ok(!line.includes(CURRENCY_SIGN));

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
