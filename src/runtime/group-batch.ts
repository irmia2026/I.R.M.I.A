/**
 * Irmia Agent — 群消息攒批门（design §4.24）
 *
 * 私聊是「人直接跟你说话」，每句都要及时看；群里的一条 @ 常常只是半句话，逐条起 turn
 * 既贵又容易答错。所以群消息落库后先攒着，等窗口到点才一起看。
 *
 * 判据做成纯函数（不读时钟、不碰投影），因为它决定的是「这一拍要不要起 turn」——
 * 抽出来才能把四种不攒的情形逐条钉死，而不必搭一整个循环。
 *
 * 四种情形不攒（任一命中就立即起 turn）：
 *   • 窗口为 0：用户选择每条都唤醒；
 *   • pending 里有非通道来源的唤醒（定时器、意图、人工、心跳…）：那些事不该被群消息拖住；
 *   • pending 里有单聊（c2c）：私聊每句都及时看；
 *   • 最早一条群消息已经超过窗口：到点了就该看。
 *
 * 「看了也不一定说话」不在这里判断：要不要发言是她在 turn 里自己决定的事（沉默是正常动作），
 * 这道门只负责「什么时候看」。
 */

import type { AppEvent } from '../log/types.js';
import type { PendingInput } from '../log/types.js';

export interface GroupBatchInput {
  pending: readonly PendingInput[];
  /** 按 seq 取回事件（日志句柄注入，纯函数自己不读盘） */
  getEvent: (seq: number) => AppEvent | null;
  /** 当前时刻（调用方给，本模块不读时钟） */
  nowMs: number;
  /** 攒批窗口（毫秒）；<= 0 表示不攒 */
  windowMs: number;
}

/** 单聊以外都算群聊：`group-at`（群里 @）与将来的 `group`（全量模式）都走攒批 */
function isDirectChat(chatType: string): boolean {
  return chatType === 'c2c';
}

export function holdsGroupBatch(input: GroupBatchInput): boolean {
  if (!(input.windowMs > 0)) return false;
  if (input.pending.length === 0) return false;

  let oldestMs = Number.POSITIVE_INFINITY;
  for (const item of input.pending) {
    if (item.source !== 'channel') return false;
    const event = input.getEvent(item.wakeSeq);
    if (event === null || event.type !== 'wake/channel') return false;
    if (isDirectChat(event.data.chatType)) return false;
    const at = Date.parse(event.ts);
    if (Number.isFinite(at) && at < oldestMs) oldestMs = at;
  }
  // 一条都解析不出时刻（时间戳全坏）时不当攒：宁可多起一个 turn，也不要把消息压在窗口里
  if (!Number.isFinite(oldestMs)) return false;
  return input.nowMs - oldestMs < input.windowMs;
}
