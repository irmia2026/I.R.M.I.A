/**
 * 只读测量：**区外思维链**值多少钱（「区外全传」vs「只传区内」）。
 *
 * ## 判据（与渲染层同一处）
 *   · `reasoningEchoPlan()` —— 今天真发出去的那一份（全量 + 300,000 字符硬上限）；
 *   · **区边界 = 最后一条 user 消息**（19 发真请求实测的服务端判据，见 `src/model/render.ts`
 *     文件头 v75 篇末那一节与 `assertReasoningEchoIntegrity` 的注释）：
 *     渲染里 user item 的来路只有 `message/user` / `image/attached` / `human/answered` /
 *     8 类 `wake/*`。本轮唤醒渲染在 `turn/start` 之前 ⇒ 区内 ≈ 当前这一轮的 reasoning，
 *     除非本轮中途又有 user 事件（那会把边界往后推、区变更小）。
 *   · **区内**（in）= `seq > 区边界`；**区外**（out）= 更早的每一条 reasoning。
 *
 * ## 成本口径（仓库既有口径，不出现货币）
 *   `cost = miss + output + hit / 10`（`docs/design.md:603` 用户分价：未命中价 ≈ 命中价 ×10；
 *   同一条在 `runtime/cache-alert.ts` 的 `estCostPerTurn` 里）。
 *
 * ## 两把尺子怎么对齐
 *   服务端 `inputTokens` 是 provider 口径；`estimateTokens` 是估算器口径。实测校准
 *   （同一窗：每个 step 的 `budget/consumed.reasoningTokens` ÷ 那条 reasoning 正文的
 *   `estimateTokens`，197 个样本）**p50 = 1.13** ⇒ 思维链正文的 provider token ≈ 估算 × 1.13。
 *   本脚本用它把 reasoning 的估算换算成 provider 口径，于是分子分母同一把尺。
 *
 * ## 三种策略（A / B / B'）
 *   · **A 区外全传**（今天）：每笔请求都背着全部历史 reasoning（≈99% 命中，单价 1/10）；
 *   · **B 只传区内**（朴素）：区外 reasoning 一条不传 ⇒ **区边界每轮都往前挪**（本轮 reasoning
 *     下一轮就成了区外）⇒ 每轮**一次**尾部重编码（从上一轮第一条 reasoning 起全部 miss）；
 *   · **B' 只传区内 + 忽略每轮重编码**（= 把"一次性"当真的算法）——只作对照，不是现实。
 *
 * 用法：
 *   node --experimental-strip-types tools/reasoning-region-cost.ts [--last-files 6] [--lane heavy] [--detail]
 */
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import type { AppEvent, ModelLane } from '../src/log/types.ts';
import { REASONING_ECHO_POLICY, reasoningEchoPlan } from '../src/model/render.ts';
import { estimateTokens } from '../src/tools/registry.ts';

/**
 * 思维链正文的 **provider token ÷ estimateTokens** 校准（本窗实测 p50 = 1.13，197 个样本；
 * 判据 = `budget/consumed.reasoningTokens` ÷ 同一 step 那条 `message/reasoning` 正文的估算）。
 */
const REASONING_TOKEN_CALIB = 1.13;

const argOf = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value === undefined ? fallback : value;
};
const lastFiles = Number(argOf('--last-files', '6'));
const laneFilter = argOf('--lane', 'heavy') as ModelLane | 'all';
const showDetail = process.argv.includes('--detail');

const eventDir = join(argOf('--data', 'data'), 'events');
const files = (await readdir(eventDir)).filter(name => name.endsWith('.jsonl')).sort();
const picked = files.slice(Math.max(0, files.length - lastFiles));

/** 渲染成 `{role:'user'}` 的事件类型（唯一判据：`renderEvents` 的 switch） */
const USER_EVENT_TYPES = new Set([
  'message/user', 'image/attached', 'human/answered',
  'wake/timer', 'wake/file', 'wake/webhook', 'wake/manual',
  'wake/heartbeat', 'wake/intention', 'wake/job', 'wake/channel',
]);

interface Row {
  seq: number; turn: number; step: number; lane: string;
  input: number; hit: number; miss: number; output: number;
  ctxInstructions: number; ctxTools: number; ctxInput: number;
}

const events: AppEvent[] = [];
const rows: Row[] = [];

for (const name of picked) {
  const reader = createInterface({ input: createReadStream(join(eventDir, name), { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of reader) {
    if (line.trim() === '') continue;
    let event: AppEvent;
    try { event = JSON.parse(line) as AppEvent; } catch { continue; }
    if (typeof event.seq !== 'number') continue;
    events.push(event);
    if (event.type !== 'budget/consumed') continue;
    const d = event.data as unknown as Record<string, unknown>;
    const ctx = (d['context'] ?? {}) as Record<string, Record<string, unknown>>;
    const num = (bag: Record<string, unknown> | undefined, key: string): number => {
      const value = bag?.[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    };
    rows.push({
      seq: event.seq,
      turn: Number(d['turn'] ?? 0),
      step: Number(d['step'] ?? 0),
      lane: String(d['lane'] ?? ''),
      input: num(d, 'inputTokens'),
      hit: num(d, 'cacheHitTokens'),
      miss: num(d, 'cacheMissTokens'),
      output: num(d, 'outputTokens'),
      ctxInstructions: num(ctx['instructions'], 'tokens'),
      ctxTools: num(ctx['tools'], 'tokens'),
      ctxInput: num(ctx['input'], 'tokens'),
    });
  }
}
events.sort((a, b) => a.seq - b.seq);

const reasoningAll: Array<{ seq: number; text: string }> = [];
const stepStarts: Array<{ seq: number; turn: number; step: number }> = [];
const turnStarts: Array<{ seq: number; turn: number }> = [];
const coveredPts: Array<{ seq: number; coveredUpToSeq: number }> = [];
const userSeqs: number[] = [];
for (const event of events) {
  const d = event.data as unknown as Record<string, unknown>;
  switch (event.type) {
    case 'message/reasoning':
      if (event.visibility === 'model' && typeof d['text'] === 'string' && d['text'] !== '') {
        reasoningAll.push({ seq: event.seq, text: d['text'] });
      }
      break;
    case 'step/start':
      stepStarts.push({ seq: event.seq, turn: Number(d['turn'] ?? 0), step: Number(d['step'] ?? 0) });
      break;
    case 'turn/start':
      turnStarts.push({ seq: event.seq, turn: Number(d['turn'] ?? 0) });
      break;
    case 'compaction/summary':
      if (typeof d['coveredUpToSeq'] === 'number') {
        coveredPts.push({ seq: event.seq, coveredUpToSeq: d['coveredUpToSeq'] });
      }
      break;
    default:
      if (USER_EVENT_TYPES.has(event.type)) userSeqs.push(event.seq);
      break;
  }
}

const coveredBefore = (seq: number): number => {
  let value = 0;
  for (const point of coveredPts) if (point.seq < seq && point.coveredUpToSeq > value) value = point.coveredUpToSeq;
  return value;
};
const lastTurnStartBefore = (seq: number): number => {
  let value = 0;
  for (const start of turnStarts) if (start.seq < seq) value = start.seq;
  return value;
};
const lastUserBefore = (seq: number): number => {
  let value = 0;
  for (const user of userSeqs) if (user < seq) value = user;
  return value;
};
const boundaryOf = (row: Row): number => {
  let exact = -1;
  let best = -1;
  for (const start of stepStarts) {
    if (start.seq >= row.seq) break;
    if (start.turn === row.turn && start.step === row.step) exact = start.seq;
    best = start.seq;
  }
  return exact >= 0 ? exact : best;
};

const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[index]!;
};
const mean = (values: readonly number[]): number => values.length === 0
  ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
const round = (value: number, digits = 1): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
/** 估算 → provider 口径（只用于思维链正文；校准判据见文件头） */
const providerTokensOf = (text: string): number => estimateTokens(text) * REASONING_TOKEN_CALIB;

const firstSeq = events.length > 0 ? events[0]!.seq : 0;
const WARMUP = firstSeq + 2_000;

interface Measured extends Row {
  boundary: number;
  echoTokens: number; echoChars: number; echoItems: number;
  inTokens: number; outTokens: number;
  hitRatio: number;
  cost: number;
  saving: number;
  outShareOfInput: number;
}

const measured: Measured[] = [];
for (const row of rows) {
  if (row.input <= 0) continue;
  if (row.seq <= WARMUP) continue;
  if (laneFilter !== 'all' && row.lane !== laneFilter) continue;
  const boundary = boundaryOf(row);
  if (boundary < 0) continue;
  const covered = coveredBefore(boundary);
  // 与 render 同一处判据：默认口径（全量 + 300,000 字符硬上限）
  const plan = reasoningEchoPlan(events.filter(event => event.seq < boundary), covered, REASONING_ECHO_POLICY);
  const turnStart = lastTurnStartBefore(boundary);
  // 本轮唤醒钉在 turn/start 之前 ⇒ 区边界从 turn/start 起算；本轮中途有 user 事件则以那条为准
  const midTurnUser = lastUserBefore(boundary);
  const regionStart = midTurnUser > turnStart ? midTurnUser : turnStart;
  let echoTokens = 0;
  let inTokens = 0;
  for (const entry of plan.kept) {
    const tokens = providerTokensOf(entry.text);
    echoTokens += tokens;
    if (entry.seq > regionStart) inTokens += tokens;
  }
  const outTokens = echoTokens - inTokens;
  const cost = row.miss + row.output + row.hit / 10;
  measured.push({
    ...row,
    boundary,
    echoTokens, echoChars: plan.totalChars, echoItems: plan.kept.length,
    inTokens, outTokens,
    hitRatio: row.input === 0 ? 0 : row.hit / row.input,
    cost,
    saving: outTokens / 10,
    outShareOfInput: outTokens / row.input,
  });
}

// ── 轮级：区边界**每轮都往前挪** ⇒ B 不是"一次性重建"，而是**每轮一次尾部重编码** ──
const turnBounds = turnStarts
  .map(start => ({ ...start }))
  .sort((a, b) => a.seq - b.seq);
const contentTokensOfTurn = (startSeq: number, endSeq: number): number => {
  let tokens = 0;
  for (const event of events) {
    if (event.seq <= startSeq || event.seq >= endSeq) continue;
    if (event.visibility !== 'model') continue;
    const d = event.data as unknown as Record<string, unknown>;
    if (event.type === 'message/reasoning' || event.type === 'message/assistant') {
      const text = d['text'];
      if (typeof text === 'string') tokens += estimateTokens(text);
    } else if (event.type === 'tool/call') {
      const args = d['arguments'];
      if (typeof args === 'string') tokens += estimateTokens(args);
    } else if (event.type === 'tool/result') {
      const content = d['content'];
      if (typeof content === 'string') tokens += estimateTokens(content);
    }
  }
  return tokens;
};
const turnSizes = new Map<number, number>();
for (let index = 0; index < turnBounds.length; index += 1) {
  const start = turnBounds[index]!;
  const end = turnBounds[index + 1]?.seq;
  if (end === undefined) continue;
  turnSizes.set(start.turn, contentTokensOfTurn(start.seq, end));
}

const byTurn = new Map<number, Measured[]>();
for (const row of measured) {
  const list = byTurn.get(row.turn) ?? [];
  list.push(row);
  byTurn.set(row.turn, list);
}
const turnNumbers = [...byTurn.keys()].sort((a, b) => a - b);
const turnRows = turnNumbers.map((turn) => {
  const rowsOfTurn = byTurn.get(turn)!;
  const costA = rowsOfTurn.reduce((sum, r) => sum + r.cost, 0);
  const saving = rowsOfTurn.reduce((sum, r) => sum + r.saving, 0);
  const previous = turnSizes.get(turn - 1) ?? null;
  // 断点在"上一轮第一条 reasoning"：它之后的一切要重编码 ⇒ 多付 0.9 × 上一轮内容
  const breakCost = previous === null ? 0 : 0.9 * previous;
  return { turn, requests: rowsOfTurn.length, costA, saving, previous, breakCost, net: saving - breakCost };
});
const netSaving = turnRows.reduce((sum, r) => sum + r.net, 0);
const totalCostA = turnRows.reduce((sum, r) => sum + r.costA, 0);
const breakTokens = turnRows.reduce((sum, r) => sum + r.breakCost, 0) / 0.9;

const totals = measured.reduce((acc, r) => {
  acc.input += r.input; acc.hit += r.hit; acc.miss += r.miss; acc.output += r.output;
  acc.echo += r.echoTokens; acc.in += r.inTokens; acc.out += r.outTokens; acc.cost += r.cost;
  acc.saving += r.saving;
  return acc;
}, { input: 0, hit: 0, miss: 0, output: 0, echo: 0, in: 0, out: 0, cost: 0, saving: 0 });

const costB = totals.miss + breakTokens + totals.output + (totals.hit - totals.out - breakTokens) / 10;
const inputB = totals.input - totals.out;
const hitB = totals.hit - totals.out - breakTokens;
const firstTs = events.length > 0 ? Date.parse(events[0]!.ts) : Number.NaN;
const lastTs = events.length > 0 ? Date.parse(events[events.length - 1]!.ts) : Number.NaN;
const hours = Number.isFinite(firstTs) && Number.isFinite(lastTs) ? (lastTs - firstTs) / 3_600_000 : 0;

const summary = {
  window: {
    files: picked, requests: measured.length, turns: turnNumbers.length, lane: laneFilter,
    hours: round(hours), turnsPerHour: hours > 0 ? round(turnNumbers.length / hours, 1) : null,
    requestsPerTurn: round(measured.length / Math.max(1, turnNumbers.length), 1),
    warmupBeforeSeq: WARMUP,
  },
  policy: REASONING_ECHO_POLICY,
  perRequest: {
    inputTokens: { p50: percentile(measured.map(r => r.input), 50), mean: round(mean(measured.map(r => r.input))) },
    hitRatio: { p50: round(percentile(measured.map(r => r.hitRatio), 50) * 100, 1), mean: round(mean(measured.map(r => r.hitRatio)) * 100, 1) },
    echoChars: { p50: percentile(measured.map(r => r.echoChars), 50) },
    echoTokens: { p50: percentile(measured.map(r => r.echoTokens), 50), mean: round(mean(measured.map(r => r.echoTokens))) },
    inRegionTokens: { p50: percentile(measured.map(r => r.inTokens), 50), mean: round(mean(measured.map(r => r.inTokens))) },
    outRegionTokens: { p50: percentile(measured.map(r => r.outTokens), 50), mean: round(mean(measured.map(r => r.outTokens))) },
    inRegionShareOfEcho: { p50: round(percentile(measured.map(r => r.echoTokens === 0 ? 0 : r.inTokens / r.echoTokens), 50) * 100, 1) },
    outRegionShareOfInput: { p50: round(percentile(measured.map(r => r.outShareOfInput), 50) * 100, 1), mean: round(mean(measured.map(r => r.outShareOfInput)) * 100, 1) },
    cost: { p50: round(percentile(measured.map(r => r.cost), 50)), mean: round(mean(measured.map(r => r.cost))) },
    saving: { p50: round(percentile(measured.map(r => r.saving), 50)), mean: round(mean(measured.map(r => r.saving))) },
    savingShareOfCost: { p50: round(percentile(measured.map(r => r.cost === 0 ? 0 : r.saving / r.cost), 50) * 100, 1) },
  },
  perTurn: {
    contentTokens: { p50: percentile([...turnSizes.values()], 50), p90: percentile([...turnSizes.values()], 90) },
    breakCost: { p50: round(percentile(turnRows.map(r => r.breakCost), 50)), mean: round(mean(turnRows.map(r => r.breakCost))) },
    saving: { p50: round(percentile(turnRows.map(r => r.saving), 50)), mean: round(mean(turnRows.map(r => r.saving))) },
    net: { p50: round(percentile(turnRows.map(r => r.net), 50)), mean: round(mean(turnRows.map(r => r.net))) },
    turnsWorse: turnRows.filter(r => r.net < 0).length,
  },
  /** ★ 三种策略的对照（聚合口径；cost = miss + output + hit/10） */
  strategies: {
    A: {
      inputPerRequest: round(totals.input / measured.length),
      hitRatio: round(100 * totals.hit / totals.input, 1),
      costPerRequest: round(totals.cost / measured.length),
      cost: round(totals.cost),
    },
    B: {
      inputPerRequest: round(inputB / measured.length),
      hitRatio: round(100 * hitB / Math.max(1, inputB), 1),
      costPerRequest: round(costB / measured.length),
      cost: round(costB),
    },
    /** B'：只传区内、但假装没有每轮重编码（= "一次性"那个假设） */
    bPrime: {
      cost: round(totals.cost - totals.saving),
      savedShareOfCost: round(100 * totals.saving / totals.cost, 1),
    },
    dropShareOfInput: round(100 * totals.out / totals.input, 1),
    savedShareOfCost: round(100 * (totals.cost - costB) / totals.cost, 1),
    switchCostTokens: round(percentile(measured.map(r => Math.max(0, r.input - r.ctxInstructions - r.ctxTools)), 50)),
    paybackTurns: round(percentile(measured.map(r => Math.max(0, r.input - r.ctxInstructions - r.ctxTools)), 50)
      / Math.max(1, mean(turnRows.map(r => r.net)))),
  },
  calibration: {
    reasoningProviderOverEstimate: REASONING_TOKEN_CALIB,
    wholeInputProviderOverContextSum: round(percentile(measured.map(r =>
      r.input / Math.max(1, r.ctxInstructions + r.ctxTools + r.ctxInput)), 50), 3),
    note: '整份 input 的 1.4x 差来自 item 信封/结构 token，与 reasoning 正文无关（正文 p50 = 1.13）',
  },
};
console.log(JSON.stringify(summary, null, 2));

if (showDetail) {
  console.log('\n# 逐请求（前 40 条）');
  for (const row of measured.slice(0, 40)) {
    console.log(`seq=${row.seq} turn=${row.turn}.${row.step} input=${row.input} hit=${row.hit}(${round(row.hitRatio * 100, 1)}%) `
      + `echo=${round(row.echoTokens)}tok in=${round(row.inTokens)} out=${round(row.outTokens)} `
      + `drop=${round(row.outShareOfInput * 100, 1)}% cost=${round(row.cost)} saved=${round(row.saving)}(${round(100 * row.saving / Math.max(1, row.cost), 1)}%)`);
  }
}
