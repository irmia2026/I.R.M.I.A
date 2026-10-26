/**
 * Irmia Agent — **空拍提醒她「可以进行自我整理」**：连着两拍一次、再连着三拍一次，之后不再提
 *
 * ───────────────────────── 用户原话（2026-10-22，现行口径） ─────────────────────────
 *
 * > 「**自我整理提示**：连续两次空拍后提示一次，然后，再过三个空拍再提示一次，
 * >  **然后就不提示了**。」
 *
 * 现场（2026-10-22 03:16）：一段安静期里又冒出一条「【框架通报 · 可以自我整理】已经连着两拍
 * 空拍，没人找你。现在可以进行一次自我整理…」。上一版的判据是"**一段安静期只提醒一次**"，
 * 但**只要中间来过一次输入就重新武装**——于是"只提醒一次"在没人理她的长夜里变成了每两拍一次
 * （这一次正是在 03:16 那一拍又响的）。用户要的是**两道、然后闭嘴**：第一道在第 2 拍，
 * 第二道在第 5 拍（再连续 3 拍），之后本段安静期**不再提示**（第 3 次永不出现）。
 *
 * ───────────────────────────── 状态机（现行判据的唯一形状） ─────────────────────────────
 *
 * ```
 *   idleBeats:     0 → 1 → [2] → 3 → 4 → [5] → 6 → 7 → … → ∞
 *   提示:                   第 1 次              第 2 次        之后永不
 *   remindedCount: 0    0     1     1   1    2     2    2   …    2
 * ```
 *
 * 三个出口（{@link planSelfOrganizeReminder}）：
 *   · `remindedCount === 0` 且 `idleBeats >= 2` ⇒ 第 1 次提示（`fired`，`reminderIndex = 1`）；
 *   · `remindedCount === 1` 且 `idleBeats >= 5` ⇒ 第 2 次提示（`fired`，`reminderIndex = 2`）；
 *   · `remindedCount >= 2` ⇒ `already-reminded`（**本段安静期第 3 次永不出现**）。
 *
 * **什么算重置**（这一段就是判据，别在别处再写一套）：出现**一次真实往来**——即**任一条
 * 非心跳唤醒**（`wake/channel` 有人找她、`wake/manual` 用户打字或框架通报、`wake/timer` /
 * `wake/job` 是别的活）——就把 `idleBeats` 与 `remindedCount` **一起归零**，下一次从第 2 拍
 * 重新开始（第 1 次、第 2 次提示照旧各一次）。用例「插一次真实往来 ⇒ 重新从 2 拍起算」钉的就是它。
 *
 * 两条**刻意不算**"真实往来"的（理由都是实测踩过的形状，不是偏好）：
 *   · **`message/assistant`**：每一拍（含沉默的整拍）都会写一条，若它清零，拍数永远是 1
 *     ——现网 `data/events` 462 条心跳里 **428 条 `idleTicks = 1`**（见下面那一节），
 *     按它判等于这条提醒永远不响；
 *   · **心跳那一拍里的工具动作**：她收到"可以整理"之后**本来就会**去读去写（那是这一拍的
 *     正常反应）。如果把它算成"真实往来"，第 1 次提示的**同一轮**就会把梯子重新武装
 *     ⇒ 每两拍又发一条"第 1 次提示"，正好是这一批要收掉的那种刷屏。
 *     `message/user` 总会跟着一条 `wake/manual`（由第一条覆盖），不单独算。
 *
 * ───────────────────── 2026-10-20 的裁决（为什么第一道在第二拍） ─────────────────────
 *
 * > 「之前**自我整理**不是要 **6 拍空拍**才触发吗，改成**第二拍空拍就提醒可以进行自我整理**吧。」
 *
 * 那一版把门槛从"6 拍"降到"2 拍"，并把迟滞做成"一段安静期只提醒一次"。2026-10-22 这一版
 * 把"一次"改成"两次、然后闭嘴"（见上面那段状态机）；**第一道仍在第 2 拍**，没有回退。
 *
 * ───────────────────────── 改之前那条判据在哪（为什么不改它） ─────────────────────────
 *
 * 原来唯一的"空拍 → 自主时间"信号是 `render.ts` 的 `maintenanceWindowOf` 里的
 * `heartbeat-idle` 那一条（`MAINTENANCE_IDLE_TICKS = 6`，连续六拍心跳没有外部事件 ⇒
 * 此刻层多一行 `维护窗口：[自主时段] …`），而且它还在 `MAINTENANCE_MIN_GAP_HOURS`（六小时）
 * 那道闸后面。两件事决定了本批**不动它**：
 *
 *   · 它在 `render.ts` 里、产出的是**此刻层的正文**（请求字节）——改阈值就是改请求体，
 *     按用户的验收口径要另算一版（`RENDER_VERSION` 那一套）；
 *   · 它说的是「这一段时间归你自己」（v53 的逐字草稿），本来就不是"提醒你整理"那一句。
 *
 * 所以本模块加的是**另一条**：真的提醒一次（她看到之后自己决定做不做），走**既有那条真唤醒
 * 通道** `wake/manual{via:'self-organize'}`——与 `compact-soon` / `compact` / `restart` / `mcp`
 * 逐字同形（`runtime/real-loop.ts` 的 `remindSelfOrganizeIfDue`）。于是 `render.ts`
 * **一个字节都不用动**，`RENDER_VERSION` 不用递增，冻结前缀与工具清单都不动。
 *
 * ─────────────── 计数为什么不读 `projection.idleTicks`（这一条是实测，不是偏好） ───────────────
 *
 * 那个数的**文档语义**是"连续没有外部事件的拍数"（`log/types.ts` 的 `idleTicks` 注释），
 * 但 `state/fold.ts` 在 `message/assistant` 上也会把它清零——而**每一步**都会写一条
 * `message/assistant`（`agent-loop` 的 `runStep`，连沉默的整拍也写）⇒ 每一拍心跳的回合跑完，
 * 它就回到 0，下一次心跳取 `idleTicks()+1` 于是**永远是 1**。
 *
 * 本机 `data/events` 的实测（2026-10-20；462 条 `wake/heartbeat` / 20.4 天）：
 *
 *   · `idleTicks = 1` 的有 **428** 条（93%）；≥2 的 34 条**全部落在 2026-10-01 ~ 10-07**
 *     ——2026-10-05 心跳改成"真实唤醒"**之前**的那几天，心跳不起 turn、没人写
 *     `message/assistant`，空拍数才累得起来。**10-05 之后**的 397 条心跳里最大才 **2**
 *     （唯一一条），≥6 的一个都没有；
 *   · 20 条 `compaction/decision.maintenanceWindow` 里 `heartbeat-idle` **0 条**
 *     （12 条压缩临近、8 条凌晨）。
 *
 * ⇒ 若按 `projection.idleTicks >= 2` 判，这条提醒在现网**几乎永远不会响**（它只会亮在
 * 那种"循环被占住"的拍上），等于没做。所以本模块**按日志数拍**：把"拍"定义为
 * **上一次非心跳唤醒之后出现过几条 `wake/heartbeat`**（见 {@link selfOrganizeTraceOf}）——
 * 这正是用户说的"空拍"（没人找她），而且它跨重启成立。
 *
 * 同一份日志按上一版判据重放（模拟那条提醒落库、迟滞如常）：**会响 70 次 ≈ 3.4 次/天**，
 * 每一次都恰好落在第二拍（`idleBeats = 2`）。这一版是**每段安静期最多两次**（第 2 拍与
 * 第 5 拍各一次），阈值/档数要再调都只动本模块的字面量——不要回头去动 `render.ts` 那一条。
 *
 * ⚠ 这条口径**不改** `projection.idleTicks`（fold / GUI / 维护窗口一个字没动）：
 * 那个数要不要按文档语义修正（让 `MAINTENANCE_IDLE_TICKS = 6` 那条也真的会响）是**另一个
 * 决定**——修它会改变此刻层在长空拍里的出现频率（请求字节），必须单独裁决。
 *
 * ───────────────────────── 与那两条「整理」机制的分工 ─────────────────────────
 *
 *   · 本模块（新，第 2 拍 + 第 5 拍）：**提醒"可以整理"**，一段安静期**最多两次、之后闭嘴**；
 *   · `maintenanceWindowOf`（不动，第六拍 + 六小时闸）：原来那条「[自主时段]」信号，照旧；
 *   · `persona/memory-maintain.ts`（不动，每日 cron）：真正跑合并/修剪/写日记的后台任务，
 *     与本模块没有任何调用关系——它既不是本模块触发的，本模块也不替它决定内容。
 *
 * 三个常量/判据刻意**不互相 import**（与 `compaction-warning.ts` 对 `MAINTENANCE_COMPACTION_RATIO`
 * 的那条纪律一致）：绑在一起就会"改一个动两个"。
 */

import type { AppEvent } from '../log/types.js';

/**
 * **第一道**的门槛（`2`）：连着两拍空拍就提醒第一次。
 *
 * 为什么从 `6` 降到 `2`（用户 2026-10-20 的原话见文件头）：六拍心跳（现场目标均值
 * `wake.heartbeatTargetMeanMin` = 45 分钟）≈ 三小时以上才等到一次"可以整理"，而那时候她
 * 手上的旧账已经在上下文里滚了好几轮；第二拍（≈ 一个半小时没人找她）正是"安静下来了、
 * 但还没到该睡回去"的那一格。
 *
 * 2026-10-22 起它只是**第一道**的门槛（第二道见 {@link SELF_ORGANIZE_SECOND_TICKS}）。
 *
 * ⚠ 它**不是** `MAINTENANCE_IDLE_TICKS`（那边仍是 `6`，`render.ts`，本批一个字没动）：
 * 两个数服务两条不同的路——这一条是**提醒**，那一条是**此刻层那行自主时段**。
 */
export const SELF_ORGANIZE_REMINDER_TICKS = 2;

/**
 * **第二道**要"再连续几拍"（`3`）：第一道之后又安静了三拍 ⇒ 第二道。
 *
 * 用户原话：「连续两次空拍后提示一次，然后，**再过三个空拍**再提示一次」。它数的是
 * **第一道之后**的拍数，不是累计拍数——累计门槛见 {@link SELF_ORGANIZE_SECOND_TICKS}。
 */
export const SELF_ORGANIZE_SECOND_AFTER_TICKS = 3;

/**
 * **第二道**的累计门槛（`5` = 2 + 3）：`idleBeats >= 它` 才发第二道。
 *
 * 写成"第一道 + 再连续三拍"的和（而不是另写一个 5）是为了让两条门槛**只有一处**：
 * 调第一道时第二道自动跟着走，不会出现"改了 2 忘了改 5"那种两个数打架的形状。
 */
export const SELF_ORGANIZE_SECOND_TICKS =
  SELF_ORGANIZE_REMINDER_TICKS + SELF_ORGANIZE_SECOND_AFTER_TICKS;

/**
 * **一段安静期最多提示几次**（`2`）。
 *
 * 用户原话最后一句：「**然后就不提示了**」——第 3 次永不出现。判据用它做"闭嘴"那一道闸：
 * `remindedCount >= 它` ⇒ `already-reminded`（不再看拍数）。
 */
export const SELF_ORGANIZE_MAX_REMINDERS = 2;

/**
 * 这条提醒在事件里的来源标记：`wake/manual.via`（与 `'compact-soon'` / `'restart'` 同一格）。
 *
 * 界面按"`via` 有值 = 框架通报"一刀切（`gui/lib/pages/chat_page.dart` 的 `_consume`），
 * 认不出来的来源兜底叫「框架通报」⇒ 加这个值**不必回头改界面**；`isSlashCommandEvent`
 * 也按 `via !== undefined` 绕开（这条 note 是对她说的话，不是给框架的指令）。
 */
export const SELF_ORGANIZE_VIA = 'self-organize';

/** 判据要的全部输入（纯数据，一个都不可省） */
export interface SelfOrganizeSignals {
  /**
   * **连着几拍空拍**（{@link selfOrganizeTraceOf} 从日志里数出来的那个数：上一次非心跳唤醒
   * 之后出现过几条 `wake/heartbeat`）。`null` / 非有限 / 负数 ⇒ 不判（不猜）。
   *
   * ⚠ 它**不是** `projection.idleTicks`（那个数被每拍的 `message/assistant` 清零，
   * 现网 93% 的拍都是 1；理由见文件头那一节）。
   */
  idleBeats: number | null;
  /**
   * **这一段安静期里已经提示过几次**（0 / 1 / 2；同样从日志里读，不看进程内存——重启之后
   * "已经提示过两次"必须照样成立，与 `warnedSinceLastCompaction` / `lastMaintenanceWindowAt`
   * 同一条纪律）。
   *
   * 三条刻意的选择：
   *   · 不看"队列里还有没有这条唤醒"：提醒被认领的那一刻就从队列里没了，按队列判会让
   *     同一段安静期**每两拍各发一条**（`compact-soon` 踩过同一个坑）；
   *   · 提醒自己**不算**"外部事件"：否则旗子会自己复位，于是每两拍又提醒一次
   *     （第二拍提醒、第三拍清零、第四拍再提醒……正是要防的刷屏）。
   *     见 {@link selfOrganizeTraceOf}：它把"自己这条提醒"与"外部事件"分开数；
   *   · 只数到 {@link SELF_ORGANIZE_MAX_REMINDERS}（`2`）：第 3 条本来就不该存在，
   *     真出现了也按"已经两次"处理（判据对 ≥2 一视同仁）。
   */
  remindedCount: number;
}

/**
 * 判据的出口（四个取值就是这份判据的形状，别在别处再写一套；与 `CompactionWarning['why']` 同形）。
 *
 *   · `unknown`         —— 没有拍数 ⇒ 不判；
 *   · `not-idle-enough` —— 还没到**下一道**的门槛（绝大多数轮次；下一道是 2 拍或 5 拍）；
 *   · `already-reminded`—— 这一段安静期**已经提示过两次**（第 3 次永不出现）；
 *   · `fired`           —— 该提醒了（`reminderIndex` 说清这是第几次）。
 */
export type SelfOrganizeWhy = 'unknown' | 'not-idle-enough' | 'already-reminded' | 'fired';

/** 一次判定的结论（`idleBeats` / `threshold` / `reminderIndex` 原样带出来，留痕与测试都读它们） */
export interface SelfOrganizePlan {
  fired: boolean;
  why: SelfOrganizeWhy;
  /** 判定时数到的空拍数（缺/非法时是 `null`） */
  idleBeats: number | null;
  /** 判据读到的"本段安静期已提示几次"（原样带出来，便于事后复算） */
  remindedCount: number;
  /** 这一次是**第几次**提示（`1` / `2`；没发 = `0`） */
  reminderIndex: 0 | 1 | 2;
  /**
   * 这一次判据用的门槛（第 1 道 = {@link SELF_ORGANIZE_REMINDER_TICKS}，
   * 第 2 道 = {@link SELF_ORGANIZE_SECOND_TICKS}）：换代之后日志仍可复算。
   */
  threshold: number;
}

/**
 * 判据：**这一拍该不该提醒她"可以进行自我整理"**。
 *
 * 四个出口的顺序是刻意的：
 *   ① 没有拍数 ⇒ `unknown`（不猜"大概是吧"）；
 *   ② 本段安静期已经提示过两次 ⇒ `already-reminded`（**闭嘴那一道闸，先于拍数判**）；
 *   ③ 还没到下一道的门槛（`2` 拍或 `5` 拍）⇒ `not-idle-enough`；
 *   ④ 到了 ⇒ `fired`，`reminderIndex = remindedCount + 1`。
 *
 * ⚠ ② 必须排在 ③ 前面（与 `planCompactionWarning` 同一条理由）：第九、第十拍的拍数
 * 仍然 ≥ 5，若先判"够拍了"就会被记成 `fired`，事实却是"已经提示过两次、这一版不再提了"。
 * 两者都是"不发"，但事后读日志的人要能分清。
 */
export function planSelfOrganizeReminder(signals: SelfOrganizeSignals): SelfOrganizePlan {
  const { idleBeats } = signals;
  const remindedCount = Number.isFinite(signals.remindedCount)
    ? Math.min(Math.max(0, Math.trunc(signals.remindedCount)), SELF_ORGANIZE_MAX_REMINDERS)
    : 0;
  const nextThreshold = remindedCount <= 0
    ? SELF_ORGANIZE_REMINDER_TICKS
    : SELF_ORGANIZE_SECOND_TICKS;
  const base = {
    idleBeats,
    remindedCount,
    reminderIndex: 0 as const,
    threshold: nextThreshold,
  };

  if (idleBeats === null || !Number.isFinite(idleBeats) || idleBeats < 0) {
    return { fired: false, why: 'unknown', ...base };
  }
  if (remindedCount >= SELF_ORGANIZE_MAX_REMINDERS) {
    return { fired: false, why: 'already-reminded', ...base };
  }
  if (idleBeats < nextThreshold) return { fired: false, why: 'not-idle-enough', ...base };
  return {
    fired: true,
    why: 'fired',
    ...base,
    reminderIndex: (remindedCount + 1) as 1 | 2,
  };
}

/** 从事件快照里数出来的两件事（判据要的全部材料） */
export interface SelfOrganizeTrace {
  /** 上一次**非心跳唤醒**之后出现过几条 `wake/heartbeat`（"连着几拍空拍"） */
  idleBeats: number;
  /** 那之后已经出现过几条自我整理提醒（{@link SELF_ORGANIZE_VIA}；最多记到 `2`） */
  remindedCount: 0 | 1 | 2;
}

/**
 * **沿一份事件快照数拍**（纯函数；调用方给 `real-loop` 每拍已经读过的那份 `eventView`）。
 *
 * 拍的定义只有一句：**上一次非心跳唤醒之后，出现过几条 `wake/heartbeat`**。
 *
 * 三条刻意的选择：
 *   · **非心跳唤醒才清零**（与 `state/fold.ts` 的唤醒分支同一把尺子：`wake/channel` 有人
 *     找她、`wake/manual` 用户打字、`wake/timer` / `wake/job` 是别的活、以及框架通报
 *     ——都算"这一拍不空"；**这就是"真实往来"的判据**，见文件头那一节）；
 *   · **`message/assistant` / `message/user` 不算**：前者是她自己开口（每拍都有一条，见
 *     文件头那一节），后者总会跟着一条 `wake/manual` ——若让它清零，拍数就永远是 1；
 *   · **自己那条提醒不算"外部事件"**：否则每两拍又会重新武装（刷屏）。
 *     它只把 `remindedCount` 抬一（最多 2），**不动** `idleBeats`——第 2 道提示要的正是
 *     "第一道之后又安静了三拍"这三拍。
 *
 * 顺序：`events` 按 seq 升序（`eventView` 与 `log.readAll()` 都是这个顺序），所以
 * "最后一条"就是"最新的那条"。
 */
export function selfOrganizeTraceOf(events: readonly AppEvent[]): SelfOrganizeTrace {
  let idleBeats = 0;
  let remindedCount = 0;
  for (const event of events) {
    if (event.type === 'wake/heartbeat') {
      idleBeats += 1;
      continue;
    }
    if (!event.type.startsWith('wake/')) continue;
    if (event.type === 'wake/manual'
      && (event.data as { via?: unknown }).via === SELF_ORGANIZE_VIA) {
      if (remindedCount < SELF_ORGANIZE_MAX_REMINDERS) remindedCount += 1;
      continue;
    }
    // 真实往来：拍数与"已提示几次"一起归零（见文件头那段判据）
    idleBeats = 0;
    remindedCount = 0;
  }
  return { idleBeats, remindedCount: remindedCount as 0 | 1 | 2 };
}

/**
 * **那条提醒的正文**（`wake/manual.note` 逐字；渲染沿既有那条路：
 * `renderWake` 的 `wake/manual` 分支给它套 `[界面消息]` 前缀——`render.ts` 本批不动）。
 *
 * 两份正文（`reminderIndex` 1 / 2，2026-10-22 两段式）：
 *   · **第 1 次**：说清"现在可以整理"，并**预告**"之后还会再提醒一次"；
 *   · **第 2 次**：说清"这是这一段安静里的最后一次"，之后不再提。
 *   两句都必须诚实：她可以只读不做，但不能让她以为后面还有一串催促。
 *
 * 四条刻意的写法（改这句之前先读）：
 *   · **是提醒，不是派活**（用户原话："提醒可以进行自我整理"）：做不做、做多少由她自己判断；
 *   · **点名"自我整理"包括什么**：流水账并进记忆 / 过时的 STATE 与事实条目 / 日记——三样都是
 *     既有机制里她本来就会做的（`MEMORIES/`、`STATE.md`、`workspace/diary/`）；
 *   · **不写数字、不写频次配额**（用户这一场的纪律："不要加什么阀门""主动联系不设频次"）：
 *     所以写"连着两拍" / "又安静了三拍"，不写"第 2 拍" / "还剩 1 次"；
 *   · **正文里不许出现 Markdown 记号**（2026-10-22 用户点名的硬性要求）：这条正文是给人
 *     在界面上读的纯文本，渲染层不认 Markdown——`**重点**` 会原样显示成四个星号
 *     （截图里就是它）。要强调用「」或换行。
 */
export function selfOrganizeNote(reminderIndex: 1 | 2 = 1): string {
  const first = reminderIndex <= 1;
  return [
    first
      ? '【框架通报 · 可以自我整理】已经连着两拍空拍，没人找你。'
      : '【框架通报 · 可以自我整理】又安静了三拍，还是没人找你。',
    '- 现在可以进行一次自我整理：把 `episodes/` 里过期的流水账并进记忆、'
    + '把 `STATE.md` 与事实条目里过时的部分修掉、把今天值得留下的写成日记。',
    '- 这只是提醒，不是派活：做不做、做多少，你自己判断；手上还有活就先干活。',
    first
      ? '- 要是之后还是这么安静，我会再提醒你一次；没有东西可整就接着睡。'
      : '- 这是这一段安静里的最后一次提醒，之后不会再催；没有东西可整就接着睡。',
  ].join('\n');
}
