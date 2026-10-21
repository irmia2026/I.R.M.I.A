/**
 * Irmia Agent — **空拍到第二拍就提醒她「可以进行自我整理」**（2026-10-20 用户裁决）
 *
 * ───────────────────────────────── 用户原话（逐字） ─────────────────────────────────
 *
 * > 「之前**自我整理**不是要 **6 拍空拍**才触发吗，改成**第二拍空拍就提醒可以进行自我整理**吧。」
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
 * 同一份日志按本判据重放（模拟那条提醒落库、迟滞如常）：**会响 70 次 ≈ 3.4 次/天**，
 * 每一次都恰好落在第二拍（`idleBeats = 2`）。若用户觉得还太勤，抬阈值或再加一道闸
 * 都只动本模块一个字面量——不要回头去动 `render.ts` 那一条。
 *
 * ⚠ 这条口径**不改** `projection.idleTicks`（fold / GUI / 维护窗口一个字没动）：
 * 那个数要不要按文档语义修正（让 `MAINTENANCE_IDLE_TICKS = 6` 那条也真的会响）是**另一个
 * 决定**——修它会改变此刻层在长空拍里的出现频率（请求字节），必须单独裁决。
 *
 * ───────────────────────── 与那两条「整理」机制的分工 ─────────────────────────
 *
 *   · 本模块（新，第二拍）：**提醒"可以整理"**，一段安静期**只提醒一次**；
 *   · `maintenanceWindowOf`（不动，第六拍 + 六小时闸）：原来那条「[自主时段]」信号，照旧；
 *   · `persona/memory-maintain.ts`（不动，每日 cron）：真正跑合并/修剪/写日记的后台任务，
 *     与本模块没有任何调用关系——它既不是本模块触发的，本模块也不替它决定内容。
 *
 * 三个常量/判据刻意**不互相 import**（与 `compaction-warning.ts` 对 `MAINTENANCE_COMPACTION_RATIO`
 * 的那条纪律一致）：绑在一起就会"改一个动两个"。
 */

import type { AppEvent } from '../log/types.js';

/**
 * 空拍到第几拍就提醒（`2`）。
 *
 * 为什么从 `6` 降到 `2`（用户 2026-10-20 的原话见文件头）：六拍心跳（现场目标均值
 * `wake.heartbeatTargetMeanMin` = 45 分钟）≈ 三小时以上才等到一次"可以整理"，而那时候她
 * 手上的旧账已经在上下文里滚了好几轮；第二拍（≈ 一个半小时没人找她）正是"安静下来了、
 * 但还没到该睡回去"的那一格。
 *
 * ⚠ 它**不是** `MAINTENANCE_IDLE_TICKS`（那边仍是 `6`，`render.ts`，本批一个字没动）：
 * 两个数服务两条不同的路——这一条是**提醒**，那一条是**此刻层那行自主时段**。
 */
export const SELF_ORGANIZE_REMINDER_TICKS = 2;

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
   * **这一段安静期是不是已经提醒过她**（同样从日志里读，不看进程内存——重启之后"提醒过"
   * 必须照样成立，与 `warnedSinceLastCompaction` / `lastMaintenanceWindowAt` 同一条纪律）。
   *
   * 两条刻意的选择：
   *   · 不看"队列里还有没有这条唤醒"：提醒被认领的那一刻就从队列里没了，按队列判会让
   *     同一段安静期**每两拍各发一条**（`compact-soon` 踩过同一个坑）；
   *   · 提醒自己**不算**"外部事件"：否则旗子会自己复位，于是每两拍又提醒一次
   *     （第二拍提醒、第三拍清零、第四拍再提醒……正是要防的刷屏）。
   *     见 {@link selfOrganizeTraceOf}：它把"自己这条提醒"与"外部事件"分开数。
   */
  remindedSinceLastInput: boolean;
}

/**
 * 判据的出口（五个取值就是这份判据的形状，别在别处再写一套；与 `CompactionWarning['why']` 同形）。
 *
 *   · `unknown`         —— 没有拍数 ⇒ 不判；
 *   · `not-idle-enough` —— 还没到第二拍（绝大多数轮次）；
 *   · `already-reminded`—— 这一段安静期已经提醒过（**这就是"只提醒一次"的迟滞**）；
 *   · `fired`           —— 该提醒了。
 */
export type SelfOrganizeWhy = 'unknown' | 'not-idle-enough' | 'already-reminded' | 'fired';

/** 一次判定的结论（`idleBeats` / `threshold` 原样带出来，留痕与测试都读它们） */
export interface SelfOrganizePlan {
  fired: boolean;
  why: SelfOrganizeWhy;
  /** 判定时数到的空拍数（缺/非法时是 `null`） */
  idleBeats: number | null;
  /** 当时生效的阈值（{@link SELF_ORGANIZE_REMINDER_TICKS}）：换代之后日志仍可复算 */
  threshold: number;
}

/**
 * 判据：**这一拍该不该提醒她"可以进行自我整理"**。
 *
 * 三个出口的顺序是刻意的：
 *   ① 没有拍数 ⇒ `unknown`（不猜"大概是吧"）；
 *   ② 不足 {@link SELF_ORGANIZE_REMINDER_TICKS} 拍 ⇒ `not-idle-enough`；
 *   ③ 这一段安静期已经提醒过 ⇒ `already-reminded`（不催第二遍——她可能判断"现在不值得整"，
 *      那是她的决定，框架不该替她反复催）。
 *
 * ⚠ ③ 必须排在 ② 前面（与 `planCompactionWarning` 同一条理由）：安静期的第三、第四拍
 * 拍数仍然 ≥ 阈值，若先判"够拍了"就会被记成 `fired`，事实却是"已经说过一次了"。
 * 两者都是"不发"，但事后读日志的人要能分清。
 */
export function planSelfOrganizeReminder(signals: SelfOrganizeSignals): SelfOrganizePlan {
  const { idleBeats, remindedSinceLastInput } = signals;
  const base = { idleBeats, threshold: SELF_ORGANIZE_REMINDER_TICKS };

  if (idleBeats === null || !Number.isFinite(idleBeats) || idleBeats < 0) {
    return { fired: false, why: 'unknown', ...base };
  }
  if (remindedSinceLastInput) return { fired: false, why: 'already-reminded', ...base };
  if (idleBeats < SELF_ORGANIZE_REMINDER_TICKS) return { fired: false, why: 'not-idle-enough', ...base };
  return { fired: true, why: 'fired', ...base };
}

/** 从事件快照里数出来的两件事（判据要的全部材料） */
export interface SelfOrganizeTrace {
  /** 上一次**非心跳唤醒**之后出现过几条 `wake/heartbeat`（"连着几拍空拍"） */
  idleBeats: number;
  /** 那之后是不是已经出现过一条自我整理提醒（{@link SELF_ORGANIZE_VIA}） */
  remindedSinceLastInput: boolean;
}

/**
 * **沿一份事件快照数拍**（纯函数；调用方给 `real-loop` 每拍已经读过的那份 `eventView`）。
 *
 * 拍的定义只有一句：**上一次非心跳唤醒之后，出现过几条 `wake/heartbeat`**。
 *
 * 三条刻意的选择：
 *   · **非心跳唤醒才清零**（与 `state/fold.ts` 的唤醒分支同一把尺子：`wake/channel` 有人
 *     找她、`wake/manual` 用户打字、`wake/timer` / `wake/job` 是别的活、以及框架通报
 *     ——都算"这一拍不空"）；
 *   · **`message/assistant` / `message/user` 不算**：前者是她自己开口（每拍都有一条，见
 *     文件头那一节），后者总会跟着一条 `wake/manual` ——若让它清零，拍数就永远是 1；
 *   · **自己那条提醒不算"外部事件"**：否则每两拍又会重新武装（刷屏）。
 *     顺手把 `remindedSinceLastInput` 一起数出来，两块事实同一趟扫描、同一份口径。
 *
 * 顺序：`events` 按 seq 升序（`eventView` 与 `log.readAll()` 都是这个顺序），所以
 * "最后一条"就是"最新的那条"。
 */
export function selfOrganizeTraceOf(events: readonly AppEvent[]): SelfOrganizeTrace {
  let lastInputSeq = 0;
  let lastReminderSeq = 0;
  let idleBeats = 0;
  for (const event of events) {
    if (event.type === 'wake/heartbeat') {
      idleBeats += 1;
      continue;
    }
    if (!event.type.startsWith('wake/')) continue;
    if (event.type === 'wake/manual'
      && (event.data as { via?: unknown }).via === SELF_ORGANIZE_VIA) {
      lastReminderSeq = event.seq;
      continue;
    }
    lastInputSeq = event.seq;
    idleBeats = 0;
  }
  return { idleBeats, remindedSinceLastInput: lastReminderSeq > lastInputSeq };
}

/**
 * **那条提醒的正文**（`wake/manual.note` 逐字；渲染沿既有那条路：
 * `renderWake` 的 `wake/manual` 分支给它套 `[界面消息]` 前缀——`render.ts` 本批不动）。
 *
 * 四条刻意的写法（改这句之前先读）：
 *   · **是提醒，不是派活**（用户原话："提醒可以进行自我整理"）：做不做、做多少由她自己判断；
 *   · **点名"自我整理"包括什么**：流水账并进记忆 / 过时的 STATE 与事实条目 / 日记——三样都是
 *     既有机制里她本来就会做的（`MEMORIES/`、`STATE.md`、`workspace/diary/`）；
 *   · **不写数字、不写频次配额**（用户这一场的纪律："不要加什么阀门""主动联系不设频次"）：
 *     所以写"连着两拍"而不写"第 2 拍"；
 *   · **明说不会再催**：她可以只读不做，这不会变成一轮催促链。
 */
export function selfOrganizeNote(): string {
  return [
    '【框架通报 · 可以自我整理】已经连着两拍空拍，没人找你。',
    '- 现在**可以进行一次自我整理**：把 `episodes/` 里过期的流水账并进记忆、'
    + '把 `STATE.md` 与事实条目里过时的部分修掉、把今天值得留下的写成日记。',
    '- 这只是**提醒**，不是派活：做不做、做多少，你自己判断；手上还有活就先干活。',
    '- 这一段时间里我只提醒这一次，不会再催；没有东西可整就接着睡。',
  ].join('\n');
}
