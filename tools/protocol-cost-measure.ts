/**
 * 协议回退的**成本读数**（只读：只读 `data/events/*.jsonl`，不写任何东西）。
 *
 * 回答一个问题：**把同一批历史按 Chat Completions 发，输入侧能省多少 token？**
 *
 * 判据只用两样真东西：
 *   ① `budget/consumed.context` —— 渲染层的归因（每段都是 `estimateTokens` 口径的 token），
 *      把它们加起来 ≈ 服务端真实计费的 `inputTokens`（本脚本会打印这个**校准比**，
 *      实测中位数 **1.01**，所以两个口径可以当一个用）；
 *   ② `reasoningEchoPlan()`（`src/model/render.ts` 的**唯一判据**）——这一次请求到底回传了
 *      哪几条思维链、共多少字符 / 多少估算 token。
 *
 * 为什么分子分母都用 `estimateTokens`、而不把分子换成 provider token：
 *   两个口径实测一致（见 `calibration`），同一把尺相除才是干净的结论；换算是另一把尺，
 *   混用会把"尺子差"算进结论里。字符数照样打印，便于别人用别人的尺复核。
 *
 * 用法：
 *   node --experimental-strip-types tools/protocol-cost-measure.ts [--last-files 4] [--lane heavy|light|all]
 *   node --experimental-strip-types tools/protocol-cost-measure.ts --detail   # 逐请求明细（前 20 条）
 *
 * 输出：一段 JSON（读数直接抄进 `docs/design-protocol-fallback.md` 的 §3.8）。
 */
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import type { AppEvent, ModelLane } from '../src/log/types.ts';
import { REASONING_ECHO_POLICY, reasoningEchoPlan, type ReasoningEchoPolicy } from '../src/model/render.ts';
import { estimateTokens } from '../src/tools/registry.ts';

/** v68 那顶旧帽子（"最近 3 条 / 单条 ≤ 20,000 字符"）：复算"v72 当年实际发出去的那一份" */
const V72_HAT = { maxItems: 3, maxCharsPerItem: 20_000 } as const;

interface ConsumedRow {
  seq: number;
  turn: number;
  step: number;
  lane: ModelLane | '(none)';
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  reasoningTokens: number;
  finishReason: string;
  /** `context` 里各段 token 之和（estimateTokens 口径） */
  contextTokens: number | null;
  prefixTokens: number | null;
}

function argOf(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value === undefined ? fallback : value;
}

const lastFiles = Number(argOf('--last-files', '4'));
const laneFilter = argOf('--lane', 'heavy') as ModelLane | 'all';
const showDetail = process.argv.includes('--detail');
const dataDir = argOf('--data', 'data');

const eventDir = join(dataDir, 'events');
const files = (await readdir(eventDir)).filter(name => name.endsWith('.jsonl')).sort();
if (files.length === 0) throw new Error(`${eventDir} 里没有 .jsonl`);
const picked = files.slice(Math.max(0, files.length - lastFiles));

const reasoningEvents: AppEvent[] = [];
const stepStarts: Array<{ seq: number; turn: number; step: number }> = [];
const covered: Array<{ seq: number; coveredUpToSeq: number }> = [];
const consumed: ConsumedRow[] = [];
let scanned = 0;
let firstSeq = Number.POSITIVE_INFINITY;

/**
 * 从 `context` 归因里取"**这次请求的全部输入**"（estimateTokens 口径）。
 *
 * ⚠ **只加三段**：`instructions` + `tools` + `input`。
 *   · `instructions` / `tools` 是请求体的两个顶层字段；
 *   · `input` 是 `input[]` 数组的**总量**，它**已经包含** `memory` / `history` / `state` /
 *     `now` / `wake` / `hint` 那几段（实测：5,021+17,464+619+652+64 = 23,820 = `input.tokens`）。
 *   ⇒ 把六段一起加会**双计**一大块（实测 +24%），份额会被低估。这条坑是量出来的，别改回去。
 */
function contextTokensOf(context: unknown): { base: number | null; prefix: number | null; ratioParts: { instructions: number; tools: number; input: number } | null } {
  if (typeof context !== 'object' || context === null) return { base: null, prefix: null, ratioParts: null };
  const record = context as Record<string, unknown>;
  const tokensOf = (key: string): number | null => {
    const value = record[key];
    if (typeof value !== 'object' || value === null) return null;
    const tokens = (value as { tokens?: unknown }).tokens;
    return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : null;
  };
  const instructions = tokensOf('instructions');
  const tools = tokensOf('tools');
  const input = tokensOf('input');
  if (instructions === null || tools === null || input === null) {
    return { base: null, prefix: instructions !== null && tools !== null ? instructions + tools : null, ratioParts: null };
  }
  return {
    base: instructions + tools + input,
    prefix: instructions + tools,
    ratioParts: { instructions, tools, input },
  };
}

for (const name of picked) {
  const reader = createInterface({ input: createReadStream(join(eventDir, name), { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of reader) {
    if (line.trim() === '') continue;
    scanned += 1;
    let event: AppEvent;
    try {
      event = JSON.parse(line) as AppEvent;
    } catch {
      continue;
    }
    if (typeof event.seq !== 'number') continue;
    if (event.seq < firstSeq) firstSeq = event.seq;
    switch (event.type) {
      case 'message/reasoning':
        reasoningEvents.push(event);
        break;
      case 'step/start':
        stepStarts.push({
          seq: event.seq,
          turn: Number((event.data as { turn?: number }).turn ?? 0),
          step: Number((event.data as { step?: number }).step ?? 0),
        });
        break;
      case 'compaction/summary': {
        const value = (event.data as { coveredUpToSeq?: unknown }).coveredUpToSeq;
        if (typeof value === 'number') covered.push({ seq: event.seq, coveredUpToSeq: value });
        break;
      }
      case 'budget/consumed': {
        const d = event.data as unknown as Record<string, unknown>;
        const { base, prefix } = contextTokensOf(d['context']);
        consumed.push({
          seq: event.seq,
          turn: Number(d['turn'] ?? 0),
          step: Number(d['step'] ?? 0),
          lane: (typeof d['lane'] === 'string' ? d['lane'] : '(none)') as ModelLane | '(none)',
          inputTokens: Number(d['inputTokens'] ?? 0),
          outputTokens: Number(d['outputTokens'] ?? 0),
          cacheHitTokens: Number(d['cacheHitTokens'] ?? 0),
          reasoningTokens: Number(d['reasoningTokens'] ?? 0),
          finishReason: String(d['finishReason'] ?? '?'),
          contextTokens: base,
          prefixTokens: prefix,
        });
        break;
      }
      default:
        break;
    }
  }
}

function boundaryOf(row: ConsumedRow): number {
  let best = -1;
  for (const start of stepStarts) {
    if (start.seq >= row.seq) break;
    if (start.turn === row.turn && start.step === row.step) return start.seq;
    best = start.seq;
  }
  return best;
}

function coveredBefore(seq: number): number {
  let value = 0;
  for (const item of covered) {
    if (item.seq >= seq) break;
    if (item.coveredUpToSeq > value) value = item.coveredUpToSeq;
  }
  return value;
}

function echoBefore(seq: number, policy: ReasoningEchoPolicy): { chars: number; tokens: number; items: number } {
  const boundary = coveredBefore(seq);
  const plan = reasoningEchoPlan(reasoningEvents.filter(e => e.seq < seq), boundary, policy);
  let tokens = 0;
  for (const entry of plan.kept) tokens += estimateTokens(entry.text);
  return { chars: plan.totalChars, tokens, items: plan.kept.length };
}

/** v72 的帽子：最近 3 条、每条只留**尾部** 20,000 字符（当年"截断 + 一行说明"的近似） */
function v72HatBefore(seq: number): { chars: number; tokens: number; items: number } {
  const boundary = coveredBefore(seq);
  const visible = reasoningEvents.filter(e => e.seq < seq && e.seq > boundary);
  const last = visible.slice(Math.max(0, visible.length - V72_HAT.maxItems));
  let chars = 0;
  let tokens = 0;
  for (const event of last) {
    const text = (event.data as { text?: string }).text ?? '';
    const clipped = text.length > V72_HAT.maxCharsPerItem ? text.slice(-V72_HAT.maxCharsPerItem) : text;
    chars += clipped.length;
    tokens += estimateTokens(clipped);
  }
  return { chars, tokens, items: last.length };
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[index]!;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 热身：窗口前 2000 条事件里的请求，它的"历史"没完整落在窗口内 ⇒ 不参与统计 */
const WARMUP_SEQ = firstSeq + 2_000;
const rows = consumed.filter(row =>
  row.seq > WARMUP_SEQ
  && row.inputTokens > 0
  && (laneFilter === 'all' || row.lane === laneFilter));

const report = rows.map(row => {
  /**
   * light 请求**天生不带历史**：5 个调用点传的 `input` 都是一条 prompt（`vision.ts` 那条也是
   * "一条带图的 user 消息"，没有历史）。所以它的思维链回传**恒为 0**——不能拿"上一条 step/start"
   * 去算，那会算成同一个 turn 里 heavy 那一发（差两个数量级，`--lane light` 会看到假的 10 万字符）。
   */
  const echo73 = row.lane === 'heavy' ? echoBefore(boundaryOf(row), REASONING_ECHO_POLICY) : { chars: 0, tokens: 0, items: 0 };
  const echo72 = row.lane === 'heavy' ? v72HatBefore(boundaryOf(row)) : { chars: 0, tokens: 0, items: 0 };
  // 分母：优先用 context 归因之和（与分子同一把尺）；没有 context 的退回首选的 inputTokens
  const base = row.contextTokens ?? row.inputTokens;
  return {
    ...row,
    echoChars73: echo73.chars,
    echoTokens73: echo73.tokens,
    echoItems73: echo73.items,
    echoTokens72: echo72.tokens,
    base,
    // v73 全量回传会把 base 撑大到 base + echo（今天的 base 不含它）
    share73: base > 0 ? echo73.tokens / (base + echo73.tokens) : 0,
    share72: base > 0 ? echo72.tokens / base : 0,
    growth: base > 0 ? (base + echo73.tokens) / base : 1,
  };
});

const withContext = report.filter(row => row.contextTokens !== null);
const calibration = withContext.map(row => row.inputTokens / row.contextTokens!);
const shares = report.map(row => row.share73);
const shares72 = report.map(row => row.share72);
const growths = report.map(row => row.growth);
const echoTokens = report.map(row => row.echoTokens73);
const echoChars = report.map(row => row.echoChars73);
const bases = report.map(row => row.base);
const inputs = report.map(row => row.inputTokens);
const outputs = report.map(row => row.outputTokens);
const cacheRatios = report.map(row => row.cacheHitTokens / row.inputTokens);
const misses = report.map(row => Math.max(0, row.inputTokens - row.cacheHitTokens));
const prefixShares = report.filter(row => row.prefixTokens !== null).map(row => row.prefixTokens! / (row.contextTokens ?? row.inputTokens));

const summary = {
  window: { files: picked, scannedEvents: scanned, firstSeq, requests: report.length, lane: laneFilter, warmupSkippedBeforeSeq: WARMUP_SEQ },
  /** 校准：服务端 inputTokens ÷ 估算器口径的输入。≈1.33 ⇒ 估算器低估 25% */
  calibration: { samples: calibration.length, p50: round(percentile(calibration, 50), 3), p10: round(percentile(calibration, 10), 3), p90: round(percentile(calibration, 90), 3) },
  inputTokens: { p50: percentile(inputs, 50), p90: percentile(inputs, 90), max: Math.max(...inputs, 0) },
  contextTokens: { p50: percentile(bases, 50), p90: percentile(bases, 90) },
  outputTokens: { p50: percentile(outputs, 50), p90: percentile(outputs, 90), p99: percentile(outputs, 99), max: Math.max(...outputs, 0) },
  reasoningTokensOut: { p50: percentile(report.map(r => r.reasoningTokens), 50), p90: percentile(report.map(r => r.reasoningTokens), 90) },
  echo73: {
    policy: REASONING_ECHO_POLICY,
    chars: { p50: percentile(echoChars, 50), p90: percentile(echoChars, 90), mean: round(mean(echoChars)) },
    tokens: { p50: percentile(echoTokens, 50), p90: percentile(echoTokens, 90), mean: round(mean(echoTokens)) },
    items: { p50: percentile(report.map(r => r.echoItems73), 50), p90: percentile(report.map(r => r.echoItems73), 90) },
    zeroRequests: report.filter(r => r.echoTokens73 === 0).length,
  },
  /** ★ 结论用这一格：v73（全量回传）下，思维链占"含它的那份输入"的百分比 */
  share73: { p50: round(percentile(shares, 50) * 100, 2), p90: round(percentile(shares, 90) * 100, 2), mean: round(mean(shares) * 100, 2) },
  /** 对照：v72 的帽子（最近 3 条 / ≤20K）——当年没人觉得贵的原因 */
  share72: { p50: round(percentile(shares72, 50) * 100, 2), p90: round(percentile(shares72, 90) * 100, 2), mean: round(mean(shares72) * 100, 2) },
  /** 切到 Chat 之后，同一批历史在 Responses 上的输入会被撑大多少倍（Chat 省掉的正是这一块） */
  inputGrowth73: { p50: round(percentile(growths, 50), 3), p90: round(percentile(growths, 90), 3), mean: round(mean(growths), 3) },
  cacheHitRatio: { p50: round(percentile(cacheRatios, 50) * 100, 1), p90: round(percentile(cacheRatios, 90) * 100, 1) },
  /** 非缓存 token（= 预算口径 udgetTokensOf 的输入那一半）：切 Chat 省不掉的那部分 */
  missTokens: { p50: percentile(misses, 50), p90: percentile(misses, 90), mean: round(mean(misses)) },
  frozenPrefixShare: { samples: prefixShares.length, p50: round(percentile(prefixShares, 50) * 100, 1) },
  finish: {
    completed: report.filter(r => r.finishReason === 'completed').length,
    maxOutputTokens: report.filter(r => r.finishReason === 'max_output_tokens').length,
    contentFilter: report.filter(r => r.finishReason === 'content_filter').length,
    failed: report.filter(r => r.finishReason === 'failed').length,
    aborted: report.filter(r => r.finishReason === 'aborted').length,
  },
};

console.log(JSON.stringify(summary, null, 2));

if (showDetail) {
  console.log('\n# 逐请求（前 20 条）');
  for (const row of report.slice(0, 20)) {
    console.log(`seq=${row.seq} turn=${row.turn} step=${row.step} input=${row.inputTokens} base=${row.base} `
      + `echo73=${row.echoTokens73}tok/${row.echoChars73}ch(${row.echoItems73}条) echo72=${row.echoTokens72}tok `
      + `share73=${round(row.share73 * 100, 1)}% share72=${round(row.share72 * 100, 2)}%`);
  }
}
