/**
 * Irmia Agent — **压缩预警**（压缩**前**叫她一次去整理）的判据与文案
 *
 * ───────────────────────────────── 用户原话（2026-10-15） ─────────────────────────────────
 *
 * 「框架的压缩预警，**得让 agent 看见**，知道上下文已过 80%，**考虑整理和记录**。再继续工作，
 *  **避免压缩导致丢失信息**。比如我设置的 200k 压缩，那么到 **0.8 * 200k** 的时候就要有
 *  **条框架提醒把她唤醒**。其他人设置多少那就是 0.8 * 多少。」
 *
 * ───────────────────────── 2026-10-21：分档 + 冷却（替换一刀切） ─────────────────────────
 *
 * 用户 14:33 报的那件事（「突然被压缩、之前没预警」）的根因不在通路——那条唤醒与 GUI 的
 * 「框架通报」卡一直在——而在**判据**：原来只有"上一次压缩之后提醒过没有"这一面旗
 * （`already-warned`），报过一次之后**无论历史涨到多高都永久静默**。现场日志里连续 6 条
 * `compaction/decision.warning` 都是 `fired=false, why:"already-warned"`，其中
 * histTok **170,207 / 175,379 / 179,777** 三笔已经贴着 200k 的压缩线。
 *
 * 现在的判据（三件一起才成立）：
 *   · **分档**：跨过 **80% / 90% / 95%** 各报一次。跨到更高的新档**不受冷却约束**
 *     （`80 → 90 → 95` 连续越档三次都会报）；
 *   · **同档冷却 30 分钟**（{@link COMPACTION_WARNING_COOLDOWN_MS}）：同一档刚报过就不再叫，
 *     过了冷却同一档可以再叫一次（"冷却"不是"永久"）；
 *   · **重置**（两条，见 {@link compactionWarningStateOf}）：压缩过（`reason: 'wrote'`）
 *     或可见历史掉到阈值 **50%** 以下 ⇒ 分档状态归零，下一次跨 80% 照样报。
 *
 * 为什么压缩本身也算重置：压缩是**唯一**会改变历史规模的机制（压完之后可见历史通常掉到
 * 线下的很低处）。如果只认"某一行读数 <50%"，而压缩后的下一行已经又长过 80%（一次大工具
 * 结果、或紧接的一轮长活），上一档的读数就会把该报的那一次压掉——那正是这次要修的
 * **永久静默**换个形状回来。两条重置合起来才保证"旧档位不会跨压缩活下去"。
 *
 * 本模块只放**纯东西**（判据 / 分档 / 日志复算 / 文案），一行 IO、一行事件写入都没有：
 * 调用方（`runtime/real-loop.ts`）在**本轮收尾、`compaction/decision` 落库之前**判一次，
 * 结论搭在那一行账上（`warning?` 那一格），需要叫醒时另发一条
 * `wake/manual{via:'compact-soon'}`。
 *
 * 为什么判在**收尾**而不是每拍 prepare：判据用的那个数（可见历史估算）**本来就每轮收尾算过一次**
 * （`compactionDecision` 的结论里就有它，`reason='threshold'` 那一支也带）。在 prepare 段判只能读
 * "上一轮落账的那个数"，于是**第一拍永远是"没有读数"**、而且永远慢一轮；在收尾judge 则与压缩判定
 * **同一个数、同一刻**——这正是用户要的"和压缩同一个量"。
 *
 * ⚠ **它不受此刻层那道 6 小时闸约束**（`render.ts` 的 `MAINTENANCE_MIN_GAP_HOURS`）：那条闸管的是
 * "此刻层多一行提示"，而这一条是**独立的真唤醒**。实测过两者混在一起的代价：那道闸把
 * `compaction-soon` 压掉 92 次、而真正压缩的那一刻（10-14 18:45）恰好就是被压掉的那一拍。
 */

import type { AppEvent, CompactionWarning, CompactionWarningTier } from '../log/types.js';

/**
 * 第一档比例：**线 = 本值 × 压缩阈值**（分母随配置走，第一档固定 0.8）。
 *
 * 与此刻层那条维护窗口信号（`render.ts` 的 `MAINTENANCE_COMPACTION_RATIO`）**同源**：
 * 两个常量值相同、含义相同（都是"可见历史 ≥ 80% 压缩线"），但**是两条独立的判据**——
 * 本模块服务"叫她起来整理"，那一条服务"此刻层多一行提示"。刻意不互相 import：
 * 它们的闸不同（这一条没有时间闸），硬绑在一起会让"改一个动两个"。
 */
export const COMPACTION_WARNING_RATIO = 0.8;

/**
 * **三档刻度**（升序，比例）：跨过其一就报一次；`tier` 是它对应的百分比整数。
 *
 * 只在这里写一遍：判据（{@link warningTierOf}）、事件契约（`log/types.ts` 的
 * `CompactionWarningTier`）与 doctor 的读数（`OPS-compaction`）都从这一份刻度来。
 */
export const COMPACTION_WARNING_TIER_RATIOS = [0.8, 0.9, 0.95] as const;

/** 三档对应的百分比整数（与 {@link COMPACTION_WARNING_TIER_RATIOS} 同序、一一对应） */
export const COMPACTION_WARNING_TIER_LINES: readonly CompactionWarningTier[] = [80, 90, 95];

/**
 * **同档冷却**（毫秒）：同一档最多每 30 分钟催一次。
 *
 * 为什么不是"只报一次"：用户要的是"**考虑整理和记录**"的持续提醒，不是一条报完就作废的告警。
 * 历史停在 92% 一小时而框架一声不吭，正是 14:33 那次"突然被压缩"的现场形状。
 * 为什么不是"每拍都催"：那会让越线状态每拍各发一条真唤醒（实测踩过）。
 */
export const COMPACTION_WARNING_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * **重置比例**：可见历史掉到阈值的这个比例以下 ⇒ 分档状态归零（下一次跨 80% 照样报）。
 *
 * 0.5 是用户给的例子（"回落到低位，例如 <50%"）。它与"压缩"是两条独立的重置路径：
 * 没有压缩但历史回落（人工 `/clear`、换会话、日志重建）也该让旧档位作废。
 */
export const COMPACTION_WARNING_RESET_RATIO = 0.5;

/** 比例 → 档位。`NaN`/负比例 ⇒ 0（判不出来就按"一档都没到"，不猜） */
export function warningTierOf(ratio: number): CompactionWarningTier {
  if (!Number.isFinite(ratio)) return 0;
  if (ratio >= 0.95) return 95;
  if (ratio >= 0.9) return 90;
  if (ratio >= COMPACTION_WARNING_RATIO) return 80;
  return 0;
}

/** 判据要的全部输入（纯数据，一个都不可省） */
export interface CompactionWarningSignals {
  /**
   * 本轮算出来的**可见历史估算**（与压缩判定同一个数，来自 `compactionDecision` 的结论）。
   * `null` = 这一轮没算（判不出来）⇒ 不判。
   */
  historyTokens: number | null;
  /** 当时生效的压缩阈值（同一份结论里的 `thresholdTokens`）；`null`/≤0 ⇒ 不判 */
  thresholdTokens: number | null;
  /** 本轮压缩判定的结论：`'wrote'` = 这一拍真的压了（⇒ 压缩是重置点，这一拍不叫） */
  reason: string;
  /**
   * **这一拍之前**，当前压缩周期里已经报过的**最高档**（`0` = 一档都没报过）。
   *
   * ⚠ 它必须**从日志里复算**（{@link compactionWarningStateOf}），不看进程内存——
   * 重启之后那面旗必须照样成立，否则每次重启都会补一条（与 `lastMaintenanceWindowAt`
   * 同一条纪律）。刻意**不是**"队列里有没有一条没被认领的"：那条提醒被认领的那一刻就从
   * 队列里没了，按队列判会让越线状态**每拍各发一条**（实测 3 拍 3 条）。
   */
  lastTier: CompactionWarningTier;
  /** 上一次真的发出去的毫秒时刻（`null` = 本周期还没报过） */
  lastAtMs: number | null;
  /** 现在（毫秒）——同档冷却判据的另一端 */
  nowMs: number;
  /**
   * 同档冷却（毫秒）；缺省 {@link COMPACTION_WARNING_COOLDOWN_MS}。
   *
   * 留成参数是为了**可复算**：事件里记着当时生效的那个值（`warning.cooldownMs`），
   * 事后读日志的人不必猜"那一版是 30 分钟还是别的"。
   */
  cooldownMs?: number;
}

/**
 * 判据：**这一轮该不该叫醒她整理**。每个出口都对应 `CompactionWarning['why']` 的一个取值
 * （那六个值就是这份判据的形状，别在别处再写一套）。
 *
 * 六个出口的顺序是刻意的：
 *   ① 没有读数 ⇒ `unknown`（不猜"大概是吧"）；
 *   ② 本轮刚压过 ⇒ `just-compacted`（**这一拍不重复叫**；它同时是下一行的重置点）；
 *   ③ 线下（<80%）⇒ `below-line`（绝大多数轮次；比率 <50% 的那一行同时是重置点）；
 *   ④ 跨了**新档**（`tier > lastTier`）⇒ `fired`——新档不受冷却约束，所以 80→90→95 三连都报；
 *   ⑤ 同一档且冷却已过 ⇒ `fired`；同一档且还在冷却里 ⇒ `cooldown`；
 *   ⑥ 已经报过**更高**的档（历史回落到 80~90 之间）⇒ `already-warned`（不回头补报低档）。
 *
 * ⚠ **②③ 必须排在 ④⑤⑥ 前面**（实测踩过）：压缩之后可见历史通常**掉到线下**，若先判"线下"，
 * 那些拍会被记成 `below-line`——而它们真正的原因是"刚压过"。三者都是"不发"，
 * 但**事后读日志的人要能分清**（"还没到时候" / "刚做过" / "冷却里"）。
 */
export function planCompactionWarning(signals: CompactionWarningSignals): CompactionWarning {
  const { historyTokens, thresholdTokens, reason, lastTier, nowMs } = signals;
  const lastAtMs = signals.lastAtMs ?? null;
  const cooldownMs = signals.cooldownMs ?? COMPACTION_WARNING_COOLDOWN_MS;
  const base = {
    historyTokens,
    thresholdTokens,
    ratio: COMPACTION_WARNING_RATIO,
    lastTier,
    lastAtMs,
    cooldownMs,
  };

  if (
    historyTokens === null
    || thresholdTokens === null
    || !(thresholdTokens > 0)
    || !Number.isFinite(historyTokens)
  ) {
    return { fired: false, why: 'unknown', tier: null, ...base };
  }
  const tier = warningTierOf(historyTokens / thresholdTokens);
  if (reason === 'wrote') return { fired: false, why: 'just-compacted', tier, ...base };
  if (tier === 0) return { fired: false, why: 'below-line', tier, ...base };
  // ④ 跨了新档 ⇒ 立刻报（同档冷却不该挡住"又高了一档"这件事）
  if (tier > lastTier) return { fired: true, why: 'fired', tier, ...base };
  // ⑤ 同一档 ⇒ 冷却（`now - lastAtMs >= cooldownMs` 就是这一支的算式；时钟回拨按 0 算）
  if (tier === lastTier) {
    const elapsed = lastAtMs === null ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - lastAtMs);
    return elapsed >= cooldownMs
      ? { fired: true, why: 'fired', tier, ...base }
      : { fired: false, why: 'cooldown', tier, ...base };
  }
  // ⑥ 本周期已经报过更高的一档
  return { fired: false, why: 'already-warned', tier, ...base };
}

// ──────────────────────────────── 从日志复算分档状态 ────────────────────────────────

/**
 * 一行 `compaction/decision` 的**复算材料**（只留判据要用的那几格，纯数据）。
 *
 * 判据与复算读同一份字段：`firedTier` 由写入侧记下的 `warning.tier` 来；老日志没有那一格时，
 * {@link compactionWarningRowsOf} 会按同一条刻度（{@link warningTierOf}）**补算**——补算不是
 * 第二份判据，只是同一把尺子量同一个数。
 */
export interface CompactionWarningRow {
  seq: number;
  ts: string;
  turn: number;
  /** 这一行的可见历史估算（事件契约里恒有；坏行按 null 处理，不猜） */
  historyTokens: number | null;
  /** 这一行生效的阈值 */
  thresholdTokens: number | null;
  /** 这一行的压缩结论（`wrote` = 重置点） */
  reason: string;
  /** 这一行的档位（读数不可用 = null） */
  tier: CompactionWarningTier | null;
  /** 这一行真的报过的话，报的是哪一档；没报/没判 = null */
  firedTier: CompactionWarningTier | null;
  /** 这一行的毫秒时刻（`ts` 解析不出来 = null；只服务冷却，不参与"是否越线"） */
  atMs: number | null;
  /** 这一行带的真实读数（有就是有，没有就是 null——不编 0） */
  real: { inputTokens: number; estimatedInputTokens: number } | null;
}

const isTier = (value: unknown): value is CompactionWarningTier =>
  value === 80 || value === 90 || value === 95;

/**
 * 事件流 → 复算行（按 seq 升序；只认 `compaction/decision`）。
 *
 * 老日志（没有 `warning.tier`）按同一把尺补算：`warning.fired === true` 的那一行，
 * 用它的 `historyTokens / thresholdTokens` 过 {@link warningTierOf}。这样"从日志复算"与
 * "当时判的"是同一个口径，而不是两套。
 */
export function compactionWarningRowsOf(events: readonly AppEvent[]): CompactionWarningRow[] {
  const rows: CompactionWarningRow[] = [];
  for (const event of events) {
    if (event.type !== 'compaction/decision') continue;
    const data = event.data;
    const historyTokens = Number.isFinite(data.historyTokens) ? data.historyTokens : null;
    const thresholdTokens = Number.isFinite(data.thresholdTokens) ? data.thresholdTokens : null;
    const tier = historyTokens !== null && thresholdTokens !== null && thresholdTokens > 0
      ? warningTierOf(historyTokens / thresholdTokens)
      : null;
    const warning = data.warning;
    let firedTier: CompactionWarningTier | null = null;
    if (warning !== undefined && warning.fired === true) {
      if (isTier(warning.tier)) firedTier = warning.tier;
      else if (tier !== null && tier > 0) firedTier = tier;
    }
    const atMs = Date.parse(event.ts);
    const real = typeof data.inputTokens === 'number' && Number.isFinite(data.inputTokens)
      && typeof data.estimatedInputTokens === 'number' && Number.isFinite(data.estimatedInputTokens)
      ? { inputTokens: data.inputTokens, estimatedInputTokens: data.estimatedInputTokens }
      : null;
    rows.push({
      seq: event.seq,
      ts: event.ts,
      turn: data.turn,
      historyTokens,
      thresholdTokens,
      reason: data.reason,
      tier,
      firedTier,
      atMs: Number.isFinite(atMs) ? atMs : null,
      real,
    });
  }
  return rows;
}

/**
 * 复算"**这一行之前**的分档状态"：`{ lastTier, lastAtMs }`——判据的 ④⑤⑥ 三支就靠它。
 *
 * 两条重置（见文件头）：`reason === 'wrote'`（压缩过）或某一行读数 **< 50% 阈值**
 * （{@link COMPACTION_WARNING_RESET_RATIO}）。**任一条件成立**就把状态归零，其余行只把
 * "报过的最高档"抬上去、把"上次时刻"换成那一行。
 *
 * ⚠ 顺序：**先判重置、再看这一行报没报**。`wrote` 那一行永远不报（判据的 ②），
 * 而它正是新周期的第一行——下一行的 `lastTier` 必须是 0。
 */
export function compactionWarningStateOf(
  rows: readonly CompactionWarningRow[],
): { lastTier: CompactionWarningTier; lastAtMs: number | null } {
  let lastTier: CompactionWarningTier = 0;
  let lastAtMs: number | null = null;
  for (const row of rows) {
    const low = row.historyTokens !== null && row.thresholdTokens !== null && row.thresholdTokens > 0
      && row.historyTokens / row.thresholdTokens < COMPACTION_WARNING_RESET_RATIO;
    if (row.reason === 'wrote' || low) {
      lastTier = 0;
      lastAtMs = null;
      continue;
    }
    if (row.firedTier !== null && row.firedTier > 0) {
      lastTier = Math.max(lastTier, row.firedTier) as CompactionWarningTier;
      lastAtMs = row.atMs ?? lastAtMs;
    }
  }
  return { lastTier, lastAtMs };
}

/**
 * **常驻读数的那一份**（doctor 的 `OPS-compaction` 与 `tools/cost-segments.ts` 的页脚用它）：
 * 最新的那一行、最近一次真的报过的预警、最新一条带真实读数的行、以及复算出来的状态。
 *
 * 全是日志里的既成事实，没有一行新算式——`lastFired` / `state` 用的就是运行期同一份
 * `compactionWarningStateOf`（"复算"与"当时判的"是同一个口径）。
 */
export interface CompactionWarningReadout {
  /** 日志里 `compaction/decision` 的条数 */
  rows: number;
  /** 最后一条读数可用的行（`historyTokens`/`thresholdTokens` 都有） */
  latest: CompactionWarningRow | null;
  /** 最近一次真的报过预警的行 */
  lastFired: CompactionWarningRow | null;
  /** 最近一条带真实读数（`inputTokens` + `estimatedInputTokens`）的行 */
  lastReal: CompactionWarningRow | null;
  /** 复算出来的分档状态（= 下一拍判据要读的那两个数） */
  state: { lastTier: CompactionWarningTier; lastAtMs: number | null };
}

export function readCompactionWarnings(events: readonly AppEvent[]): CompactionWarningReadout {
  const rows = compactionWarningRowsOf(events);
  let latest: CompactionWarningRow | null = null;
  let lastFired: CompactionWarningRow | null = null;
  let lastReal: CompactionWarningRow | null = null;
  for (const row of rows) {
    if (row.historyTokens !== null && row.thresholdTokens !== null && row.thresholdTokens > 0) latest = row;
    if (row.firedTier !== null) lastFired = row;
    if (row.real !== null) lastReal = row;
  }
  return { rows: rows.length, latest, lastFired, lastReal, state: compactionWarningStateOf(rows) };
}

/** 整数千分位（`160000` → `160,000`）。只服务下面那条通报里的三个数——不引 `Intl`、不受 locale 影响 */
export function thousands(value: number): string {
  const text = String(Math.trunc(Math.abs(value)));
  const out: string[] = [];
  for (let i = text.length; i > 0; i -= 3) out.unshift(text.slice(Math.max(0, i - 3), i));
  return `${value < 0 ? '-' : ''}${out.join(',')}`;
}

/**
 * **压缩预警那条通报的正文**（用户原话见文件头）。
 *
 * 三件刻意的写法（改这句之前先读这三条）：
 *   • **三个数都给**（现在多少 / 阈值多少 / 百分比）：只给百分比她没法判断还剩多少余量，
 *     只给绝对数她没法一眼看出离线的远近——用户点名要"知道已过 80%"；
 *   • **不点名"整理哪几样"**：只给方向（"落到你自己记得住的地方"）。"机制不替她决定记忆
 *     内容"是既有边界（见 `real-loop.ts` 的 `planMemorySelection` 方法头那次删选材的理由），
 *     点名文件就是把那条边界拆了；
 *   • **末尾必须有一句"不是让你停下"**：它与压缩后那条通报（`via:'compact'`，"接着做"）
 *     互为两面，少了它她会把一次预警读成一次收工。
 *
 * 渲染形态：`wake/manual` 会被 `renderWake` 拼成 `[界面消息] <本函数返回值>`
 * （`render.ts` 的 `case 'wake/manual'`，这条前缀是既有的，本批不动渲染层）——开头那句
 * `【框架通报 · 压缩临近】` 就是给她（与给事后读日志的人）认来源的锚。
 *
 * **超过 100% 时多一句**（2026-10-15 用户拍板）：历史**已过压缩线**而这一拍仍然发预警，说明
 * 压缩这拍**没能压成**（收益闸门 / 折叠不变小 / 遮蔽点回退那一支）。这时只写"已到 80%"会让她
 * 以为还在预警区，所以要补一句把真相说清——**仍是要她先整理，压不压得成由框架那头定**。
 * 补的是**分支文案**：四个要点与三个数字的口径一个字不动（判据也不动）。
 *
 * ⚠ 文案**不随档位变**（80/90/95 三档共用这一段）：档位是判据的账（事件里的 `tier`），
 * 她需要读的是"现在多少 / 线多少 / 该整理"，而不是"这是第三档"。多印一句档位只会把
 * 一条真唤醒变成一条告警等级播报。
 */
export function compactionSoonNote(args: { historyTokens: number; thresholdTokens: number }): string {
  const { historyTokens, thresholdTokens } = args;
  const percent = ((historyTokens / thresholdTokens) * 100).toFixed(1);
  // 已过 100% 才补那一句（预警区与线下都不带它）
  const overLine = historyTokens >= thresholdTokens
    ? '\n- （已过压缩线 100%，但这一拍没能压成——你仍可以先整理，压成与否由框架那头决定）'
    : '';
  return `【框架通报 · 压缩临近】你的可见历史已到 ${thousands(historyTokens)} / 压缩线 ${thousands(thresholdTokens)}（${percent}%）。${overLine}
- 再往上长就会触发压缩：那一段往来会被折成一篇交接笔记，细节读不回来（只能按 seq 回查日志）。
- 所以现在**考虑整理与记录**：把这一段里还会再用到的结论、决定、还没办完的事，落到你自己记得住的地方（\`MEMORIES/\`、\`STATE.md\`、日记）。
- 整完**继续手头的工作**——这条通报只是让你先收起该收的东西，不是让你停下。
- 压完框架会再叫你一次（\`via=compact\`），那时接着做。`;
}
