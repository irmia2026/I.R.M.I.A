/**
 * Irmia Agent — 「这条是不是我自己发的」**唯一那道闸**（2026-10-11）
 *
 * 判据本身只有一份（`channel/self-identity.ts` 的 `isSelfMessage` + `SelfIdentity`）。
 * 这里给出的两个名字是**同一个判据在两个落点上的入口**——留着两个名字只为让调用点读得出
 * "挡的是哪条路"，**不是两份实现**（两份实现迟早漂，而漂的症状从行为上看不出来）：
 *
 *   • {@link channelGate}：宿主落库口（`main.ts` 的 `onChannelMessage`）——命中 ⇒
 *     **不落 `channel/message`、不注册群成员、不计未读**（三件一起，因为它们本就是这条路上
 *     先后发生的三件：落库 → 折叠会话簿 → 注册）；
 *   • {@link groupMemberGate}：群成员自动登记那一档（`runtime/real-loop.ts` 的
 *     `groupMemberCandidateOf`）——挡的是**重折历史事件**那条路（`warmUp` 会把判据补上之前
 *     落下的回声再折一遍，而那一趟不经过宿主的落库口）。
 *
 * ──────────────────────────── 为什么要单独一个模块 ────────────────────────────
 *
 * 不是为了分层，是为了**用例咬得住生产代码**：`main.ts` 的 `runMain` 一跑就起服务、拿实例锁，
 * 单测里没法调它。把这个判断抽成纯函数之后，用例喂进去的就是 `main.ts` 逐字调用的那一个
 * （见 `test/self-message-gate.test.ts` 的两侧对照），而不是"照着实现再写一遍"的影子。
 *
 * ⚠ **不动"她看得见自己的消息"这条固定设计**：她说过什么走的是**另一条路**——
 * `speak`/`report`/`send_media` 成功投递时补的 `speak/sent` 凭据（`admin.ts` 的
 * `deliverToSession`），`read_channel` 由 `readChannelSpoken` 读它、渲染成行首 `（我）`。
 * 这里丢掉的是"平台把我说的话推回来"的**副本**，不是"我说过什么"的凭据。
 */

import { isSelfMessage, type SelfIdentity, type SelfMessageLike } from './self-identity.ts';

/**
 * 落库口那一刀：这条通道消息是**我自己发出去、被平台推回来**的副本吗？
 *
 * `true` = 是我的 ⇒ 调用方**整条丢掉**（不落库、不唤醒、不注册、不计未读）。
 * `false` = 不是（**或还没认出来**）⇒ 照旧走原来的两条出口。
 *
 * 名字写成"该不该丢"而不是"是不是我"，是为了让调用点**读起来就是那个动作**
 * （`if (channelGate(...)) return;`）——判据与用法同形，看错方向的机会就少一次。
 *
 * 认不出来时**放行**是刻意的方向：宁可让一次回声漏进来（下一次就认得了），
 * 也绝不因为"认不出自己"而丢掉别人的话——那种错的代价大一个量级。
 */
export function channelGate(data: SelfMessageLike, self: SelfIdentity): boolean {
  return isSelfMessage(data, self);
}

/**
 * 群成员登记那一刀：这个人**是不是我自己**（是 ⇒ 不许进群成员档案）。
 *
 * 与 {@link channelGate} 共用同一个 `SelfIdentity` 实例：宿主每学到新的标识就推进那一份，
 * 两处读的是同一个结论。**必须是同一个实例**——各持一份的话，"我是谁"会长出两种认知，
 * 而那种偏差的表现是"群里那个群友又是谁"，从行为上根本看不出来。
 */
export function groupMemberGate(data: SelfMessageLike, self: SelfIdentity): boolean {
  return isSelfMessage(data, self);
}