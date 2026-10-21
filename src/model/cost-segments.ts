/**
 * Irmia Agent — **段归因的常驻读数**（`budget/consumed.context` 的段账 → 占比）
 *
 * 用户 2026-10-21 的口径：成本要能**按段归因**，而不是只有一个总数——"这段钱花在历史上、
 * 还是花在人格常驻层 / 工具清单 / 此刻层上"必须能一眼读出来。这份模块只做**只读聚合**：
 *   · 输入 = `budget/consumed.context`（渲染层每步记下的段事实，`model/context-audit.ts`）；
 *   · 输出 = 每段的合计/均值/占比 + 末笔的明细（给 doctor 一行与 `tools/cost-segments.ts`）。
 *
 * 三条纪律：
 *   1. **不重算渲染**：段 token 全部来自渲染层的既成事实（`context.*.tokens`），这里只相加。
 *      自己再估一遍就是第二份口径，迟早与请求体里的那一份对不上；
 *   2. **不猜缺失**：老日志没有 `context` / `state` / `memory.sections` 时**跳过那一格**
 *      （按 0 计并让"占比"只在它真的存在时出现），不编一个数把空白填上；
 *   3. **不引入货币**：只记 token 与占比（仓库既有铁律：本模块不出现任何计价 / 货币概念）。
 *
 * 段的口径（**唯一出处是 `render.ts` 的 `render()` 返回值**）：
 *   · `instructions` —— 人格常驻层（IDENTITY / CONSTITUTION / STYLE / 装置自述）；
 *   · `tools`        —— 工具清单（JSON 形态的 name/description/parameters）；
 *   · `history`      —— 事件流渲染出来的历史 items；
 *   · `summary`      —— 长期记忆层里那一节"早期历史摘要"（`memory.sections` 的 `summary`）；
 *   · `memoryOther`  —— 长期记忆层的其余几节（技能目录 + MCP 索引），
 *     与 `summary` 合计 = `context.memory.tokens`（**同一层拆开看**，不是两段独立内容）；
 *   · `state`        —— 本轮固定块（`[当前状态]` + 关系档案 + 记忆索引）；
 *   · `now`          —— 此刻层（尾部那条 developer 消息，逐 step 变）；
 *   · `wake`         —— 本轮新输入（turn 首个 step 才有）；
 *   · `hint`         —— 尾部插播（软阈值提示 / 钩子注入）。
 *
 * `totalTokens` = 上面九段之和（= `instructions + tools + context.input.tokens`：
 * `context.input.tokens` 只数 item 段，见 `render.ts` 那一格的注释）。
 */

import { formatExact, formatPercent } from '../format/units.ts';
import type { AppEvent } from '../log/types.js';

/** 段键（**显示顺序**就是 {@link COST_SEGMENT_ORDER}：从最大的一层读到最小的一格） */
export type CostSegmentKey =
  | 'history'
  | 'now'
  | 'state'
  | 'instructions'
  | 'tools'
  | 'summary'
  | 'wake'
  | 'memoryOther'
  | 'hint';

/** 全部分段（报表按这个顺序印：先用户点名的七段，再补上把它凑满 100% 的两段） */
export const COST_SEGMENT_ORDER: readonly CostSegmentKey[] = [
  'history', 'now', 'state', 'instructions', 'tools', 'summary', 'wake', 'memoryOther', 'hint',
];

/** **用户点名要看的那七段**（`OPS-cost-segments` 的一行只印这七格；顺序就是他点名的顺序） */
export const COST_SEGMENT_FOCUS: readonly CostSegmentKey[] = [
  'history', 'now', 'state', 'instructions', 'tools', 'summary', 'wake',
];

/** 段的中文名（报表与 doctor 一行共用；别在两处各起一个名字） */
export const COST_SEGMENT_LABELS: Readonly<Record<CostSegmentKey, string>> = {
  history: 'history · 历史',
  now: '此刻层',
  state: '固定块',
  instructions: 'instructions · 人格常驻层',
  tools: 'tools · 工具清单',
  summary: 'summary · 早期摘要',
  wake: 'wake · 本轮新输入',
  memoryOther: '记忆层其余（技能/MCP）',
  hint: '尾部插播',
};

/**
 * doctor 那一行用的**短名**：用户点名的写法（`history` / 此刻层 / 固定块 / `instructions` /
 * `tools` / `summary` / `wake`）——一行七个占比，名字长了就挤不下；报表里那列用长名。
 */
const COST_SEGMENT_SHORT_LABELS: Readonly<Record<CostSegmentKey, string>> = {
  history: 'history',
  now: '此刻层',
  state: '固定块',
  instructions: 'instructions',
  tools: 'tools',
  summary: 'summary',
  wake: 'wake',
  memoryOther: '记忆层其余',
  hint: '尾部插播',
};

/** 一行 `budget/consumed` 的段事实（窗口里的一笔） */
export interface CostSegmentRow {
  seq: number;
  ts: string;
  turn: number;
  step: number;
  /** 九段之和（估算口径，与 `context.*.tokens` 同源） */
  totalTokens: number;
  segments: Record<CostSegmentKey, number>;
}

/** 一份段归因读数（窗口内的合计/均值/占比 + 首末两笔） */
export interface CostSegmentsReading {
  /** 窗口里有可用 `context` 的行数 */
  rows: number;
  /** 日志里 `budget/consumed` 的总条数（解释"为什么行数比想象少"：老日志没有 context） */
  budgetRows: number;
  /** 窗口第一笔 / 最后一笔（没有可用行时为 null） */
  first: CostSegmentRow | null;
  last: CostSegmentRow | null;
  /** 窗口合计（各段） */
  totals: Record<CostSegmentKey, number>;
  /** 窗口总 token（九段之和） */
  totalTokens: number;
  /** 各段占比（0–1；`totalTokens === 0` 时全 0） */
  shares: Record<CostSegmentKey, number>;
  /** 各段均值（合计 ÷ 行数；`rows === 0` 时全 0） */
  avg: Record<CostSegmentKey, number>;
}

const ZERO_SEGMENTS = (): Record<CostSegmentKey, number> => ({
  history: 0,
  now: 0,
  state: 0,
  instructions: 0,
  tools: 0,
  summary: 0,
  wake: 0,
  memoryOther: 0,
  hint: 0,
});

/** 非负有限数才认（坏数据按 0——它不是"缺"，只是不加进来） */
const tokensOf = (value: unknown): number =>
  (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * 一条 `budget/consumed` → 段事实。**没有可用的 `context` ⇒ null**（跳过这一行，
 * 不让它把"老日志没有归因"混进 0 里）。
 */
function costSegmentRowOf(event: AppEvent & { type: 'budget/consumed' }): CostSegmentRow | null {
  const context = event.data.context;
  if (context === undefined) return null;

  const segments = ZERO_SEGMENTS();
  segments.instructions = tokensOf(context.instructions?.tokens);
  segments.tools = tokensOf(context.tools?.tokens);
  segments.history = tokensOf(context.history?.tokens);
  segments.now = tokensOf(context.now?.tokens);
  segments.state = tokensOf(context.state?.tokens);
  segments.wake = tokensOf(context.wake?.tokens);
  segments.hint = tokensOf(context.hint?.tokens);
  // 长期记忆层拆成"早期摘要"与"其余（技能目录 + MCP 索引）"两格；没有分节事实时后者 = 全层。
  const memory = tokensOf(context.memory?.tokens);
  const summarySection = (context.memory?.sections ?? []).find((section) => section.name === 'summary');
  segments.summary = tokensOf(summarySection?.tokens);
  segments.memoryOther = Math.max(0, memory - segments.summary);

  const totalTokens = COST_SEGMENT_ORDER.reduce((sum, key) => sum + segments[key], 0);
  if (totalTokens <= 0) return null;
  return {
    seq: event.seq,
    ts: event.ts,
    turn: event.data.turn,
    step: event.data.step,
    totalTokens,
    segments,
  };
}

/**
 * 读一份段归因（**纯函数，只读事件数组**）。
 *
 * @param windowRows 只统计**最后 N 笔**（默认 200）：段占比会随压缩/长活漂移，整份日志的均值
 *   会把最近这一段的形状抹平；`<= 0` = 全量（诊断历史时用）。
 */
export function readCostSegments(events: readonly AppEvent[], windowRows = 200): CostSegmentsReading {
  const rows: CostSegmentRow[] = [];
  let budgetRows = 0;
  for (const event of events) {
    if (event.type !== 'budget/consumed') continue;
    budgetRows += 1;
    const row = costSegmentRowOf(event);
    if (row !== null) rows.push(row);
  }
  const window = windowRows > 0 ? rows.slice(Math.max(0, rows.length - windowRows)) : rows;

  const totals = ZERO_SEGMENTS();
  for (const row of window) {
    for (const key of COST_SEGMENT_ORDER) totals[key] += row.segments[key];
  }
  const totalTokens = COST_SEGMENT_ORDER.reduce((sum, key) => sum + totals[key], 0);
  const shares = ZERO_SEGMENTS();
  const avg = ZERO_SEGMENTS();
  for (const key of COST_SEGMENT_ORDER) {
    shares[key] = totalTokens > 0 ? totals[key] / totalTokens : 0;
    avg[key] = window.length > 0 ? totals[key] / window.length : 0;
  }
  return {
    rows: window.length,
    budgetRows,
    first: window[0] ?? null,
    last: window[window.length - 1] ?? null,
    totals,
    totalTokens,
    shares,
    avg,
  };
}

/** 时刻的**确定性**写法（不看机器时区：日志里的 ISO 串直接截到秒）。doctor 与报表共用 */
export function formatStamp(ts: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/u.exec(ts);
  return match === null ? ts : `${match[1]} ${match[2]}`;
}

/**
 * 报表页脚要用的两格（**调用方从 `compaction/decision` 读出来**，这里只负责印）。
 *
 * 为什么分开：`latest`（估算线用到几成）与 `real`（真实 vs 估算）可能**不是同一行**
 * （真实读数那两格是 2026-10-21 才加的，老日志只有前者）——混成一行就会把两个不同 seq 的
 * 数摆在一起，读的人无法复算。
 */
export interface CostSegmentsCompactionFooter {
  /** 最新一条有读数的行（`historyTokens / thresholdTokens`） */
  latest: { seq: number; turn: number; usedRatio: number } | null;
  /** 最近一条带 `inputTokens` + `estimatedInputTokens` 的行 */
  real: { seq: number; turn: number; inputTokens: number; estimatedInputTokens: number } | null;
}

/**
 * `tools/cost-segments.ts` 的人读报表（纯字符串，不写盘）。
 *
 * 尾巴上那一条"真实 vs 估算"不是必须的：调用方手里有 `compaction/decision` 的读数时才传
 * （那两格是 2026-10-21 才加的，老日志没有）。
 */
export function formatCostSegments(
  reading: CostSegmentsReading,
  options: { dataDir?: string; compaction?: CostSegmentsCompactionFooter | null } = {},
): string[] {
  const lines: string[] = [];
  lines.push(`段归因 · ${options.dataDir ?? 'data'}（只读 data/events，口径 = budget/consumed.context）`);
  if (reading.rows === 0) {
    lines.push(`日志里 ${reading.budgetRows} 笔 budget/consumed，没有一笔带 context ⇒ 读不出段归因`);
    return lines;
  }
  const first = reading.first === null ? '?' : formatStamp(reading.first.ts);
  const last = reading.last === null ? '?' : formatStamp(reading.last.ts);
  lines.push(`窗口 ${reading.rows} 笔（日志里共 ${reading.budgetRows} 笔 budget/consumed）· ${first} ~ ${last}`);
  lines.push('');
  lines.push('段                                占比        窗口合计        均值        末笔');
  for (const key of COST_SEGMENT_ORDER) {
    const label = COST_SEGMENT_LABELS[key].padEnd(18, ' ');
    const lastTokens = reading.last === null ? 0 : reading.last.segments[key];
    lines.push(
      `${label}  ${formatPercent(reading.shares[key]).padStart(6, ' ')}`
      + `  ${formatExact(reading.totals[key]).padStart(10, ' ')}`
      + `  ${formatExact(reading.avg[key]).padStart(9, ' ')}`
      + `  ${formatExact(lastTokens).padStart(9, ' ')}`,
    );
  }
  lines.push(
    `${'合计'.padEnd(18, ' ')}  ${formatPercent(1).padStart(6, ' ')}`
    + `  ${formatExact(reading.totalTokens).padStart(10, ' ')}`
    + `  ${formatExact(reading.rows > 0 ? reading.totalTokens / reading.rows : 0).padStart(9, ' ')}`
    + `  ${formatExact(reading.last?.totalTokens ?? 0).padStart(9, ' ')}`,
  );
  const compaction = options.compaction;
  if (compaction !== null && compaction !== undefined) {
    const real = compaction.real;
    if (real === null) {
      lines.push('真实 vs 估算：日志里还没有带 inputTokens/estimatedInputTokens 的 compaction/decision');
    } else {
      const ratio = real.estimatedInputTokens > 0 ? real.inputTokens / real.estimatedInputTokens : 0;
      lines.push(
        `真实 vs 估算（compaction/decision seq ${real.seq} · turn ${real.turn}）：`
        + `inputTokens ${formatExact(real.inputTokens)} / estimatedInputTokens ${formatExact(real.estimatedInputTokens)}`
        + ` = ${ratio.toFixed(2)}×`,
      );
    }
    if (compaction.latest === null) {
      lines.push('估算线用到：日志里还没有可用的 compaction/decision 读数');
    } else {
      lines.push(
        `估算线用到 ${formatPercent(compaction.latest.usedRatio)}`
        + `（compaction/decision seq ${compaction.latest.seq} · turn ${compaction.latest.turn} 的`
        + ' historyTokens / thresholdTokens）',
      );
    }
  }
  return lines;
}

/**
 * `OPS-cost-segments` 那一行的 detail（**只印用户点名的七段**，顺序照他的写法）。
 *
 * 用**窗口合计的占比**（不是末笔的单行）：常驻读数要回答"这一段总体上占多少"，
 * 末笔会被一次大工具结果带偏；末笔的总量另给一格，用来对照"此刻这一发有多大"。
 */
export function costSegmentsDoctorDetail(reading: CostSegmentsReading): string {
  if (reading.rows === 0) {
    return `日志里 ${reading.budgetRows} 笔 budget/consumed，没有一笔带 context ⇒ 读不出段归因`;
  }
  const parts = COST_SEGMENT_FOCUS.map(
    (key) => `${COST_SEGMENT_SHORT_LABELS[key]} ${formatPercent(reading.shares[key])}`,
  );
  const lastTotal = reading.last === null ? 0 : reading.last.totalTokens;
  return `近 ${reading.rows} 笔（末笔 ${formatExact(lastTotal)} tok）：${parts.join(' / ')}`;
}
