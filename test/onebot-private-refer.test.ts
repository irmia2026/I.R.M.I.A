/**
 * OneBot 私聊里的**引用**（`reply` 段）—— 2026-10-12 修的不对称
 *
 * 用户反馈：「私聊没有引用 refer」。
 *
 * 诊断（只读、对 HEAD `1c5bda5`）：
 *   · **收**这一侧是真不对称：`mapEventToWakeChannel` 里 `[引用 #<id>] ` 前缀的**唯一**
 *     生产点在**群**那一支（`else` 分支里），私聊那一支一个字都不解析。而同一条 `reply` 段
 *     在两支里拿到的是**同一份东西**（`segments` 由 `toSegments` 统一解析、`replyIdOf`
 *     只按段类型找）——差别只在那一支写不写它。所以"私聊不给引用"是**我们丢的**，不是平台没给。
 *   · 官方门（`qq-official`）没有这个不对称：它的 `quotedPrefix` 只认 `message_type === 103`，
 *     **不区分群聊私聊**（所以官方门私聊里本来就有引用）。
 *   · 本机 `data/events` 里 **OneBot 私聊样本共 4 条，全部不带 `reply`/引用**（如实记录：
 *     **本机无样本**可以证明"平台在私聊里到底给不给 reply 段"）。
 *
 * 这个文件钉的是**我们能控制的那一半**：给了 `reply` 段就解析出来，不给就一个字不加；
 * 并且**群那一支的行为逐字不变**（反面对照）。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { mapEventToWakeChannel, type OneBotEventContext } from '../src/channel/onebot.ts';

/** 一条私聊事件（NapCat 现场那种形状：`raw_message` 带 CQ 码、`message` 是段数组） */
function privateEvent(raw: string, segments: unknown[]): Record<string, unknown> {
  return {
    post_type: 'message',
    message_type: 'private',
    message_id: 24681357,
    user_id: 1234567890,
    self_id: 10001,
    raw_message: raw,
    message: segments,
    sender: { user_id: 1234567890, nickname: '用户' },
  };
}

/** 一条群里 @ 了她的事件 */
function groupAtEvent(raw: string, segments: unknown[]): Record<string, unknown> {
  return {
    post_type: 'message',
    message_type: 'group',
    message_id: 1739441710,
    group_id: 123456789,
    user_id: 1234567890,
    self_id: 10001,
    raw_message: raw,
    message: segments,
    sender: { user_id: 1234567890, nickname: '用户', card: '用户' },
  };
}

const AT_SELF = { type: 'at', data: { qq: '10001' } };

describe('OneBot 私聊 · 引用（reply 段）', () => {
  test('私聊里引用某条 ⇒ `[引用 #<id>] ` 前缀（与群那边同一个形态）', () => {
    const data = mapEventToWakeChannel(privateEvent(
      '[CQ:reply,id=-1283734959]这边也是我呀',
      [{ type: 'reply', data: { id: '-1283734959' } }, { type: 'text', data: { text: '这边也是我呀' } }],
    ));
    assert.ok(data !== null, '私聊消息要认（没 @ 也算叫她）');
    assert.equal(data.chatType, 'c2c');
    assert.equal(data.text, '[引用 #-1283734959] 这边也是我呀',
      '引用的 id 必须如实写进前缀——这是那条消息**唯一**的结构化线索（私聊没有 @ 可当旁证）');
    assert.equal(data.messageId, '24681357');
  });

  test('**反向**：私聊里没引用 ⇒ 一个字都不加（不许凭空造前缀）', () => {
    const data = mapEventToWakeChannel(privateEvent(
      '在吗',
      [{ type: 'text', data: { text: '在吗' } }],
    ));
    assert.equal(data?.text, '在吗', '没有 reply 段就没有前缀');
    assert.equal(data?.text?.includes('[引用'), false);
  });

  test('**反向**：`reply` 段的 id 是空串 ⇒ 不加前缀（宁可没有，也不写一个空的 `[引用 #]`）', () => {
    const data = mapEventToWakeChannel(privateEvent(
      '在吗',
      [{ type: 'reply', data: { id: '' } }, { type: 'text', data: { text: '在吗' } }],
    ));
    assert.equal(data?.text, '在吗', '空 id 不算引用（`replyIdOf` 的判据只此一处）');
  });

  test('私聊引用**不**改 `chatType`、也**不**填 `mentionsMe`（私聊本来就无条件唤醒她）', () => {
    // 这条钉的是"别顺手把群那套语义搬过来"：群里"回复的是她"是**提成唤醒**的判据
    //（`group-at` + `mentionsMe`），而私聊恒为 `c2c`、分流第一条就是无条件进唤醒
    //（`channel/inbox.ts`）。给 c2c 填 `mentionsMe` 只会给同一个事实造出第二种说法。
    const context: OneBotEventContext = { isReplyToSelf: () => true };
    const data = mapEventToWakeChannel(privateEvent(
      '[CQ:reply,id=111]嗯嗯',
      [{ type: 'reply', data: { id: '111' } }, { type: 'text', data: { text: '嗯嗯' } }],
    ), context);
    assert.equal(data?.chatType, 'c2c', '私聊仍然是 c2c（不因为"回复的是她"变成 group-at）');
    assert.equal(data?.mentionsMe, undefined, '私聊不填 mentionsMe（那在私聊里没有意义）');
  });

  test('**反面对照**：群那一支的行为逐字不变（@ 她 + 引用她 ⇒ 仍是 group-at + mentionsMe）', () => {
    const context: OneBotEventContext = { isReplyToSelf: () => true };
    const data = mapEventToWakeChannel(groupAtEvent(
      '[CQ:reply,id=111][CQ:at,qq=10001] 嗯嗯',
      [{ type: 'reply', data: { id: '111' } }, AT_SELF, { type: 'text', data: { text: ' 嗯嗯' } }],
    ), context);
    assert.equal(data?.chatType, 'group-at', '群里"回复的是她"仍然提成 group-at');
    assert.equal(data?.mentionsMe, true);
    assert.equal(data?.text, '[引用 #111] 嗯嗯', '群里前缀形态不变（两个生产点同形）');
  });

  test('**反面对照**：群里没 @ 也没引用她 ⇒ 仍是 `group`（进信箱，不唤醒）', () => {
    const data = mapEventToWakeChannel(groupAtEvent(
      '随便说一句',
      [{ type: 'text', data: { text: '随便说一句' } }],
    ), { isReplyToSelf: () => false });
    assert.equal(data?.chatType, 'group');
    assert.equal(data?.mentionsMe, undefined);
    assert.equal(data?.text, '随便说一句');
  });
});
