/**
 * Irmia Agent — **压缩预警**（压缩**前**叫她一次去整理）的判据与文案
 *
 * ───────────────────────────────── 用户原话（2026-10-15） ─────────────────────────────────
 *
 * 「框架的压缩预警，**得让 agent 看见**，知道上下文已过 80%，**考虑整理和记录**。再继续工作，
 *  **避免压缩导致丢失信息**。比如我设置的 200k 压缩，那么到 **0.8 * 200k** 的时候就要有
 *  **条框架提醒把她唤醒**。其他人设置多少那就是 0.8 * 多少。」
 *
 * 本模块只放**三样纯东西**（判据 / 比例 / 文案），一行 IO、一行事件写入都没有：
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

import type { CompactionWarning } from '../log/types.js';

/**
 * 触发线比例：**线 = 本值 × 压缩阈值**（分母随配置走，比例固定 0.8）。
 *
 * 与此刻层那条维护窗口信号（`render.ts` 的 `MAINTENANCE_COMPACTION_RATIO`）**同源**：
 * 两个常量值相同、含义相同（都是"可见历史 ≥ 80% 压缩线"），但**是两条独立的判据**——
 * 本模块服务"叫她起来整理"，那一条服务"此刻层多一行提示"。刻意不互相 import：
 * 它们的闸不同（这一条没有时间闸），硬绑在一起会让"改一个动两个"。
 */
export const COMPACTION_WARNING_RATIO = 0.8;

/** 判据要的全部输入（纯数据，一个都不可省） */
export interface CompactionWarningSignals {
  /**
   * 本轮算出来的**可见历史估算**（与压缩判定同一个数，来自 `compactionDecision` 的结论）。
   * `null` = 这一轮没算（判不出来）⇒ 不判。
   */
  historyTokens: number | null;
  /** 当时生效的压缩阈值（同一份结论里的 `thresholdTokens`）；`null`/≤0 ⇒ 不判 */
  thresholdTokens: number | null;
  /** 本轮压缩判定的结论：`'wrote'` = 这一拍真的压了（⇒ 那条提醒已完成使命） */
  reason: string;
  /**
   * **上一次压缩之后是否已经提醒过**（判据在调用方：从日志里数，不看进程内存——
   * 重启之后那条"提醒过"必须照样成立，否则每次重启都会补一条）。
   *
   * ⚠ 它**不是**"队列里有没有一条没被认领的"：那条提醒被认领的那一刻就从队列里没了，
   * 而"提醒过没有"这件事必须比队列活得久（实测踩过：按队列判会让越线状态**每拍各发一条**）。
   */
  warnedSinceLastCompaction: boolean;
}

/**
 * 判据：**这一轮该不该叫醒她整理**。每个出口都对应 `CompactionWarning['why']` 的一个取值
 * （那五个值就是这份判据的形状，别在别处再写一套）。
 *
 * 五个出口的顺序是刻意的：
 *   ① 没有读数 ⇒ `unknown`（不猜"大概是吧"）；
 *   ② 本轮刚压过 ⇒ `just-compacted`（**这条就是"一次压缩只提醒一次"的迟滞**）；
 *   ③ 上一次压缩之后**已经提醒过** ⇒ `already-warned`（不重复叫——她可能正在整理，也可能
 *      判断"现在不值得整"，两种都该由她定，框架不该催第二遍）；
 *   ④ 线下 ⇒ `below-line`（绝大多数轮次）；
 *   ⑤ 其余 ⇒ `fired`。
 *
 * ⚠ **②③ 必须排在 ④ 前面**（实测踩过）：压缩之后可见历史通常**掉到线下**，若先判"线下"，
 * 那些拍会被记成 `below-line`——而它们真正的原因是"刚压过"或"已经提醒过"。三者都是"不发"，
 * 但**事后读日志的人要能分清**（"还没到时候" / "刚做过" / "已经说过一次了"）。
 *
 * ★ 为什么重置靠 ② 而不是"回落到线下"：能不能再提醒一次，只由**"上一次压缩之后提醒过没有"**
 * 决定。压过一次，那面旗就翻回来——下一次越线（通常是新长出来的那段历史又把线推过）再提醒。
 * 这正是用户要的"一次压缩一次提醒"，而"回落"不足以承担它（那条线附近的历史本来就在阈值上下
 * 浮动，用它当重置会让"压过了"与"还没到时候"混成同一种形状）。
 */
export function planCompactionWarning(signals: CompactionWarningSignals): CompactionWarning {
  const { historyTokens, thresholdTokens, reason, warnedSinceLastCompaction } = signals;
  const base = { historyTokens, thresholdTokens, ratio: COMPACTION_WARNING_RATIO };

  if (historyTokens === null || thresholdTokens === null || !(thresholdTokens > 0)) {
    return { fired: false, why: 'unknown', ...base };
  }
  if (reason === 'wrote') return { fired: false, why: 'just-compacted', ...base };
  if (warnedSinceLastCompaction) return { fired: false, why: 'already-warned', ...base };
  if (historyTokens < thresholdTokens * COMPACTION_WARNING_RATIO) {
    return { fired: false, why: 'below-line', ...base };
  }
  return { fired: true, why: 'fired', ...base };
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
