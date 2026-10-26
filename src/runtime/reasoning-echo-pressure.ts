/**
 * Irmia Agent — **思维链回传压力的前兆告警**（`回传字符 / 上限 ≥ 90%`）的判据与全部文案
 *
 * ───────────────── 用户原话（这一批的根据，2026-10-21） ─────────────────
 *
 * 「我注意到**缓存未命中在暴涨**。并且**框架没有任何警告**」
 * 「只是今天明显是大量未命中了，但我并没有看见告警」
 *
 * ───────────────── 它为什么比"未命中率"更早、更准 ─────────────────
 *
 * 只读审计（本机 `data/events`，20.6 万条，零反例）把当天那场追到了**一个具体机制**上：
 *
 *   回传思维链的字符总量**顶穿** `REASONING_ECHO_POLICY.maxTotalChars`（300,000）
 *   ⇒ 之后**每一笔**都再挤掉一个最老的 assistant 组（`reasoningEchoPlan` 的整组丢）
 *   ⇒ **历史头部每笔都位移一条** ⇒ 请求前缀从被挤掉的那一条起全部失配
 *   ⇒ 每笔 90%+ 未命中，而 `instructions` / `tools` / `memory` 三段的哈希**一个字节都没变**。
 *
 * 三个直接后果，决定了这条判据必须长这个样子：
 *
 *   ① **未命中率是"结果"，不是"前兆"**。等它涨上去，钱已经花掉了（当天那一小时的开销翻了 3 倍多）。
 *      真正的分界线在"顶穿"那一刻，而顶穿前一定会先在 90% 附近停一阵——**那一段才是能救的窗口**；
 *   ② **一旦开始驱逐，`keptChars` 会变好看**：它被压回上限以内，而"会回传的总字符"继续涨。
 *      所以本判据读的是 `echoChars = keptChars + droppedChars`（**会回传的总量**），
 *      不是 `keptChars`。拿 `keptChars` 当压力读，会在真正出事的那一刻失去信号；
 *   ③ **驱逐不是一次事件，是一段状态**：它每一笔都在发生，直到上下文压缩把遮蔽点推过去
 *      （当天 03:34:33 压缩之后才恢复）。所以判据必须去重，否则就是每笔一条。
 *
 * ───────────────── 阈值为什么是 0.9 ─────────────────
 *
 *   · **0.9 是"还剩一次大工具结果"余量**：单条思维链实测最长 111,320 字符
 *     （`render.ts` 的 `ReasoningEchoPolicy` 注释那段读数），而 300,000 的 10% = 30,000
 *     ——比最长单条小，但比"这一步正常长出来的量"大得多。落在 90% 意味着
 *     **再走一两步就可能顶穿**，此时压一次上下文（或收着点干活）还来得及；
 *   · **取 1.0（顶穿了才报）就太晚**：那一刻起每一笔都在重编码，任务还在跑，钱还在烧；
 *   · **取 0.8 会常态化**：长期跑着的实例本来就会在两三成之间浮动，天天报等于没报
 *     （这条教训在本仓库有前科：`cacheBreak` 的"告警常态化 ⇒ 人就不看了"）。
 *
 * ───────────────── 本模块的边界 ─────────────────
 *
 * 只放**纯东西**（读数 / 判据 / 阈值 / 文案），一行 IO、一行事件写入都没有。三个出口：
 *   · `runtime/real-loop.ts` 的 `handleCostAlerts`（事件 + 控制台一行 + 一次真唤醒）；
 *   · `runtime/doctor.ts` 的 `OPS-echo-pressure`（同一个判据、参数不同，见那里的注释）；
 *   · `cli.ts` 的 `summarizeEvent`（读事件自己的载荷，不重算）。
 *
 * ⚠ **不出现任何货币 / 计费口径**（`docs/design.md:603`、`docs/tools-audit.md:403` 等四处成文）：
 * 本模块只说字符、比例、条数。用户在这个模块里的诉求也只用"翻 3 倍"这种**倍数**表达。
 */

import { REASONING_ECHO_POLICY, reasoningEchoPlan } from '../model/render.ts';
import { formatCompact, formatPercent } from '../format/units.ts';
import type { AppEvent } from '../log/types.js';

// ──────────────────────────────── 阈值（唯一一处定义） ────────────────────────────────

/** 前兆线：`echoChars / cap ≥ 0.9` 就报（理由见文件头） */
export const ECHO_PRESSURE_RATIO = 0.9;
/** 去重档位宽度：5 个百分点一档（90–95 / 95–100 / ≥100 封顶） */
export const ECHO_PRESSURE_BAND = 0.05;
/** 去重窗口：同一 (档位, 上限) 在这么久之内只报一次 */
export const ECHO_PRESSURE_DEDUPE_HOURS = 24;
/**
 * 档位**封顶**在 100%（= `1 / ECHO_PRESSURE_BAND` 档）。
 *
 * 不封顶的后果是具体的：驱逐一旦开始，`echoChars` 随历史只增不减地涨，
 * 档位每涨 5 个百分点就报一条 —— 从 300k 涨到 400k 会报 6 次，而它说的是同一件事。
 * 封顶之后：**90–95% 报一次、95–100% 报一次、顶穿报一次，此后 24 小时不再重复**。
 */
export const ECHO_PRESSURE_BAND_MAX = Math.floor(1 / ECHO_PRESSURE_BAND);

/** 判据要的全部读数（**纯数据**：一个字段都不在这里现算，`readEchoPressure` 是唯一来源） */
export interface EchoPressureSignals {
  /**
   * **本轮**号（= 日志里最后一条 `turn/end` 的 `turn`）与它最后一步的步号。
   *
   * 它们只服务事件信封（`model/reasoning-echo` 的 `turn`/`step` 是既有必填字段）——
   * 压力这条不针对某一步，取"本轮最后一步"最贴近"现在"。
   */
  turn: number;
  step: number;
  /** 上限（`REASONING_ECHO_POLICY.maxTotalChars`）；`null` = 出厂没设上限 ⇒ 不判 */
  cap: number | null;
  /** 会回传的总字符（= `keptChars + droppedChars`） */
  echoChars: number;
  /** 实际回传的字符 */
  keptChars: number;
  /** 当前口径下被挤掉的组数 */
  droppedGroups: number;
  /** 当前口径下被挤掉的字符数 */
  droppedChars: number;
  /** **本轮**有没有落过 `reasoning_echo_prune` */
  evictedThisTurn: boolean;
}

/** 判据没响的原因（与 `runtime/cache-alert.ts` 的 `CacheAlertSkip` 同一条纪律：不发也要分得清理由） */
export type EchoPressureSkip =
  /** 出厂策略没设总字符上限（`maxTotalChars === null`）⇒ 这条判据没有对象 */
  | 'no-cap'
  /** 一条思维链都没有（空历史 / 全在遮蔽点之前）⇒ 比例算不出来 */
  | 'no-sample'
  /** 没过 90% 线（绝大多数轮次） */
  | 'below-line'
  /** 同 (档位, 上限) 24 小时内已报过 */
  | 'duplicate';

/** 一次判据的结论 */
export interface EchoPressureVerdict {
  fired: boolean;
  why: EchoPressureSkip | 'fired';
  /** `echoChars / cap`；算不出来时 `-1`（**不拿 0 冒充**"没有压力"） */
  ratio: number;
  /** 去重档位（已封顶）；算不出来时 `-1` */
  band: number;
  signals: EchoPressureSignals;
}

// ──────────────────────────────── 读数 ────────────────────────────────

/**
 * 从事件流里读出**当前**的回传压力（纯函数、可复算：同一份日志永远给同一组数）。
 *
 * 口径三处，与渲染层**同一把尺**（`reasoningEchoPlan`，不是另算一遍）：
 *
 *   · **遮蔽点**：取所有 `compaction/summary.coveredUpToSeq` 的**最大值**——与 `render()`
 *     （`model/render.ts` 的 `render` 开头那一段）逐字同一条判据；压在遮蔽点之前的思维链
 *     本来就不回传，算进来会让压力虚高；
 *   · **策略**：出厂 `REASONING_ECHO_POLICY`（`agent-loop` 只有在 400 自救那一次才换成
 *     "连上限都不设"，那是**一次性**的，不是常态，不该进这条判据）；
 *   · **"本轮"**：日志里最后一条 `turn/end` 的轮号。用它数 `reasoning_echo_prune` 而不用进程
 *     内存——重启之后"这一轮驱逐过没有"照样读得出来（与 `real-loop.warnedSinceLastCompaction`
 *     同一条纪律）。
 *
 * ⚠ 入参 `events` 必须是**渲染看见的那一份**（`real-loop.ts` 的 `contextEventFilter` 之后）：
 * 子代理链的事件不在父请求里，混进来会把字符数算大。
 */
export function readEchoPressure(events: readonly AppEvent[]): EchoPressureSignals {
  const cap = REASONING_ECHO_POLICY.maxTotalChars;
  // 遮蔽点：与 `render()` 同一条判据（取最大值）
  let coveredUpToSeq = 0;
  for (const event of events) {
    if (event.type === 'compaction/summary' && event.data.coveredUpToSeq > coveredUpToSeq) {
      coveredUpToSeq = event.data.coveredUpToSeq;
    }
  }
  // 这一个纯函数就是渲染层自己用的那一个（`reasoningEchoOf` 是它的便捷入口）
  const plan = reasoningEchoPlan(events, coveredUpToSeq, REASONING_ECHO_POLICY);
  const droppedChars = plan.dropped.reduce((sum, entry) => sum + entry.chars, 0);

  // **本轮**号：日志里最后一条 turn/end（"本轮最后一步"取那之后最大的 step/start）
  let lastTurn = 0;
  for (const event of events) {
    if (event.type === 'turn/end' && event.data.turn > lastTurn) lastTurn = event.data.turn;
  }
  let lastStep = 0;
  for (const event of events) {
    if (event.type === 'step/start' && event.data.turn === lastTurn && event.data.step > lastStep) {
      lastStep = event.data.step;
    }
  }
  let evictedThisTurn = false;
  for (const event of events) {
    if (event.type !== 'model/reasoning-echo') continue;
    if (event.data.kind !== 'reasoning_echo_prune') continue;
    if (event.data.turn !== lastTurn) continue;
    if ((event.data.dropped ?? []).length === 0) continue;
    evictedThisTurn = true;
    break;
  }

  return {
    turn: lastTurn,
    step: lastStep,
    cap,
    // 会回传的总量 = 留下的 + 已挤掉的（见文件头 ②：驱逐开始之后 `keptChars` 会变好看）
    echoChars: plan.totalChars + droppedChars,
    keptChars: plan.totalChars,
    droppedGroups: plan.dropped.length,
    droppedChars,
    evictedThisTurn,
  };
}

// ──────────────────────────────── 判据 ────────────────────────────────

/** 比例 → 去重档位（5 个百分点一档，**100% 封顶**；理由见 `ECHO_PRESSURE_BAND_MAX`） */
export function echoPressureBandOf(ratio: number): number {
  if (!(ratio > 0)) return -1;
  return Math.min(Math.floor(ratio / ECHO_PRESSURE_BAND), ECHO_PRESSURE_BAND_MAX);
}

/**
 * 去重：**同 (档位, 上限) 在 {@link ECHO_PRESSURE_DEDUPE_HOURS} 小时内报过没有**——从日志里数。
 *
 * 与 `runtime/cache-alert.ts` 的 `alreadyReported` 同一条纪律（三个理由逐字相同）：
 * 重启之后"报过"必须照样成立；不用 `wake/manual.dedupeKey`（那条键永久生效，会把"恶化一档该再叫"
 * 压成"这台机器上永远只叫一次"）；去重只在这一处，不在唤醒那条路上再写一遍。
 */
export function echoPressureAlreadyReported(
  events: readonly AppEvent[],
  reading: { band: number; cap: number },
  nowMs: number,
): boolean {
  const floorMs = nowMs - ECHO_PRESSURE_DEDUPE_HOURS * 3_600_000;
  for (const event of events) {
    if (event.type !== 'model/reasoning-echo') continue;
    if (event.data.kind !== 'reasoning_echo_pressure') continue;
    const pressure = event.data.pressure;
    if (pressure === undefined) continue;
    const at = Date.parse(event.ts);
    if (!Number.isFinite(at) || at < floorMs) continue;
    if (pressure.band !== reading.band) continue;
    if (pressure.cap !== reading.cap) continue;
    return true;
  }
  return false;
}

/**
 * **判据本体**（唯一一处）。三条：上限存在、比例算得出来、**过 90% 线**；再加一条去重。
 *
 * 出口顺序（与 `planCompactionWarning` / `planCacheAlert` 同一条纪律）：
 *   ① 没有上限 ⇒ `no-cap`（这条判据没有对象）
 *   ② 没有样本 ⇒ `no-sample`（分母侧没东西，比例不是 0 而是"算不出来"）
 *   ③ 没过线 ⇒ `below-line`（绝大多数轮次）
 *   ④ 报过了 ⇒ `duplicate`
 *   ⑤ 其余 ⇒ `fired`
 *
 * ⚠ ② 必须排在 ③ 前面：`echoChars === 0` 时比例是 `0/300000 = 0%`，看起来"非常健康"，
 * 而它真正说的是"一条思维链都没有"——把两者混成一个出口，会让"这个实例根本没在思考"
 * 被读成"压力很小"。
 */
export function planEchoPressure(
  signals: EchoPressureSignals,
  options: { nowMs: number; events: readonly AppEvent[]; respectDedupe: boolean },
): EchoPressureVerdict {
  const { cap, echoChars } = signals;
  const ratio = cap !== null && cap > 0 ? echoChars / cap : -1;
  const band = echoPressureBandOf(ratio);
  const verdict = (fired: boolean, why: EchoPressureSkip | 'fired'): EchoPressureVerdict =>
    ({ fired, why, ratio, band, signals });

  if (cap === null || !(cap > 0)) return verdict(false, 'no-cap');
  if (!(echoChars > 0)) return verdict(false, 'no-sample');
  if (!(ratio >= ECHO_PRESSURE_RATIO)) return verdict(false, 'below-line');
  if (options.respectDedupe && echoPressureAlreadyReported(options.events, { band, cap }, options.nowMs)) {
    return verdict(false, 'duplicate');
  }
  return verdict(true, 'fired');
}

// ──────────────────────────────── 文案（三处出口共用一份读数） ────────────────────────────────

/** 没响的原因 → 一句话（只服务 `doctor` 与排障；没响的轮次不进日志） */
export const ECHO_PRESSURE_SKIP_TEXT: Record<EchoPressureSkip, string> = {
  'no-cap': '出厂策略没有设总字符上限，这条判据没有对象',
  'no-sample': '一条会回传的思维链都没有，比例算不出来',
  'below-line': `在线内（前兆线 ${formatPercent(ECHO_PRESSURE_RATIO)}）`,
  duplicate: `同 (档位, 上限) 在 ${ECHO_PRESSURE_DEDUPE_HOURS} 小时内已报过`,
};

/**
 * 三处出口共用的那一段读数：**会回传多少 / 上限多少 / 百分之几 / 已挤掉几组**。
 *
 * 四个数缺一不可：只给百分比看不出"离顶穿还剩多少字符"，只给字符数看不出"还剩几步"，
 * 不给"已挤掉几组"就分不清"快顶穿"与"已经在挤"——而这两件的处置完全不同。
 */
export function echoPressureReadings(signals: EchoPressureSignals, ratio: number): string {
  const cap = signals.cap ?? 0;
  return `思维链回传 ${formatCompact(signals.echoChars)} / 上限 ${formatCompact(cap)}`
    + `（${formatPercent(ratio)}）`
    + ` · 已挤掉 ${signals.droppedGroups} 组 / ${formatCompact(signals.droppedChars)} 字符`
    + (signals.evictedThisTurn ? '（本轮已在驱逐）' : '');
}

/**
 * **出口 ①：控制台那一行**（`real-loop` 的 `handleCostAlerts` 原地 `write`）。
 *
 * 尾巴那句是用户点名要的因果链，逐字保留"顶穿 ⇒ 每一笔挤掉最老的一组 ⇒ 历史头部位移 ⇒
 * 每笔重编码前缀 ⇒ 当天翻 3 倍以上"——它回答的是"**为什么这条前兆值得现在处理**"，
 * 少了它，人只会看到一串字符数。
 */
export function echoPressureConsoleLine(signals: EchoPressureSignals, ratio: number): string {
  return `[成本] ${echoPressureReadings(signals, ratio)}`
    + ' —— 一旦顶穿，之后每一笔都会挤掉最老的一个 assistant 组'
    + '（历史头部位移 ⇒ 每笔重编码前缀），当天开销会翻 3 倍以上';
}

/**
 * **出口 ②：`doctor` 那一条的 detail**（`OPS-echo-pressure`，warn 级，不进退出码）。
 *
 * 与上面那行**同源**（`echoPressureReadings` 逐字同一份），末尾接上"这一条在防什么"。
 * 用户点名要在 doctor 里点明「这一步一旦顶穿，账单当天翻 3 倍以上」——那句话在这里。
 */
export function echoPressureDoctorDetail(
  signals: EchoPressureSignals,
  ratio: number,
  why: EchoPressureSkip | 'fired',
): string {
  const head = echoPressureReadings(signals, ratio);
  if (why !== 'fired') return `${head} · ${ECHO_PRESSURE_SKIP_TEXT[why]}`;
  return `${head} · **顶穿之后每一笔都会挤掉最老的一个 assistant 组**（历史头部位移 ⇒ 每笔重编码前缀），`
    + '当天开销会翻 3 倍以上 —— 先压一次上下文（把遮蔽点推过去）或让这一轮收尾，别接着做长任务';
}

/**
 * **出口 ③：那条真唤醒的正文**（`wake/manual{via:'system'}.note`，逐字进日志与她的上下文）。
 *
 * 四行对应四件事（与 `cacheAlertWakeNote` 同一个形状）：
 *   · 现在多满（四个数）；
 *   · **该停什么**：别起长任务，因为长任务 = 几十笔请求，每笔都在挤；
 *   · **该做什么**：压一次上下文（把遮蔽点推过去）——那是当天真正让它恢复的动作；
 *   · 用户那句"可以说一句"的原话照给，再补一条自己能查的路。
 *
 * ⚠ **正文里不许出现 Markdown 记号**（2026-10-22 用户点名的硬性要求）：它是在界面上读的
 * 纯文本，渲染层不认 Markdown——要强调用「」或换行。
 */
export function echoPressureWakeNote(signals: EchoPressureSignals, ratio: number): string {
  return `【框架通报 · 思维链回传压力】会回传的思维链已经有 ${formatCompact(signals.echoChars)} 字符，`
    + `上限 ${formatCompact(signals.cap ?? 0)}（${formatPercent(ratio)}）`
    + `，当前已经挤掉 ${signals.droppedGroups} 组 / ${formatCompact(signals.droppedChars)} 字符。
- 先别做长任务：长任务要发几十笔请求，每一笔都会再挤掉最老的一个 assistant 组，历史头部因此每笔都在位移——那之后每一笔都要把整段前缀重新编码一遍，当天的开销会翻 3 倍以上。
- 现在真的有用的一步是压一次上下文（\`/compact\`，或让一轮正常收尾触发自动压缩）：遮蔽点推过去，被挤的那一段就不再进请求，压力随之清零。
- 可以跟用户说一句：最近缓存命中低，我少绕两圈。
- 想自己核对就去看 \`model/reasoning-echo\`（\`kind:'reasoning_echo_prune'\` 是已经挤掉的账，\`kind:'reasoning_echo_pressure'\` 是这条读数）。`;
}
