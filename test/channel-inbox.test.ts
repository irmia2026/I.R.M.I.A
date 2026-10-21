/**
 * 通道消息分流测试 — src/channel/inbox.ts
 *
 * 这一轮改的是**她跟外面的关系**：QQ 从"推给她的消息流"变成"手边一个可以点开的软件"。
 * 分流器就是那条线上的闸：
 *
 *   • **@ 她 / 提到她**（群）→ 进消息流并唤醒她（群里唯一一条"别人能直接叫到她"的路）；
 *   • **私聊**（谁的都一样）→ 唤醒（2026-10-08 收敛：私聊里没有"@ 不 @"这回事，
 *     正文直接进"本轮新输入"，不是什么"要她自己 read_channel"的东西）；
 *   • **其余群消息** → 进信箱 → 框架照收照留（写一条 `channel/message`），只记账、不打断她。
 *
 * 判据必须是纯函数、**顺序即优先级**——"要不要打断她"是件有后果的事，靠断言钉住才敢改。
 * 文件只 import `inbox.ts`（不碰 admin/render）：这样回退实现时红的是**断言**，
 * 而不是整个文件在导入期就炸（v27 记过那个坑：那种"全红"什么都没验到）。
 *
 * 约定：值导入写 `.ts`（Node 的 --experimental-strip-types 只擦类型、不改写路径解析）。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { inboxMsgSeqOf, msgSeqOf, mentionsKeyword, sidOfChannelData, shouldWakeForChannelMessage, type WakeCriteria } from '../src/channel/inbox.ts';
// 唤醒那条路的补法在 real-loop（事件 seq 是它分配的）；判据与上面同一个 `msgSeqOf`
import { withMsgSeqFallback } from '../src/runtime/real-loop.ts';

/** 判据的两个输入：用例只覆盖它关心的那一维，其余留默认（没关注、没关键词） */
function criteria(
  watchedSids: ReadonlySet<string> = new Set(),
  mentionKeywords: readonly string[] = [],
): WakeCriteria {
  return { watchedSids, mentionKeywords };
}

const NO_WATCH = criteria();
const WATCH_OWNER_FAV = criteria(new Set(['qq:c2c:OWNER', 'qq:group:FAV']));

describe('通道消息分流 · 什么该叫她、什么只进信箱', () => {
  test('群里 @ 了她 → 唤醒（哪怕这个会话没被关注）', () => {
    // 这是唯一一条"别人能直接叫到她"的路径，用户的要求就是这条
    assert.equal(
      shouldWakeForChannelMessage(
        { channel: 'qq-official', chatType: 'group-at', person: '张三', chatId: 'G1', text: '@她', messageId: 'm1', msgSeq: 1, mentionsMe: true },
        NO_WATCH,
      ),
      true,
    );
  });

  test('**正文里喊了她的名字**也算叫她（文本提及，2026-10-02 用户拍板）', () => {
    // 实测：群里的人不打 @ 直接喊"弥亚小姐，帮我看看"，四条全进了信箱——她一条都没听见。
    // 平台不会把那种句子标成"提到了机器人"，所以由人给几个词（channels.mentionKeywords）。
    const withNames = criteria(new Set(), ['伊尔弥亚', '弥亚小姐', 'Irmia']);
    assert.equal(
      shouldWakeForChannelMessage(
        { channel: 'qq-official', chatType: 'group', person: '甲', chatId: 'G1', text: '弥亚小姐，帮我看个东西', messageId: 'm1', msgSeq: 1 },
        withNames,
      ),
      true,
      '群里喊名字要叫醒她——不然她永远听不见那些没 @ 的话',
    );
    // 平台级 mentionsMe（全量群消息里 mentions 带机器人）同样算
    assert.equal(
      shouldWakeForChannelMessage(
        { channel: 'qq-official', chatType: 'group', person: '甲', chatId: 'G1', text: '看这个', messageId: 'm2', msgSeq: 2, mentionsMe: true },
        NO_WATCH,
      ),
      true,
      '适配器给了"这条提到了机器人"就认它——它与 chatType 是两处同源的信息',
    );
    // 大小写不敏感（英文名不该因为大小写漏掉）
    assert.equal(mentionsKeyword('IRMIA 在吗', ['irmia']), true);
    // 关键词是空的 → 一条都不命中（旧行为：只认平台的 @）
    assert.equal(mentionsKeyword('弥亚小姐在吗', []), false);
    assert.equal(mentionsKeyword('', ['弥亚']), false);
    // 词表里混进空串不该让每条消息都命中
    assert.equal(mentionsKeyword('随便一句话', ['', '   ']), false);
  });

  test('关注/用户的**私聊** → 唤醒；群聊不因为"被关注"而整体唤醒', () => {
    const watched = criteria(new Set(['qq:c2c:OWNER', 'qq:group:FAV']));
    assert.equal(
      shouldWakeForChannelMessage(
        { channel: 'qq-official', chatType: 'c2c', person: '用户', chatId: 'OWNER', text: '在吗', messageId: 'm2', msgSeq: 1 },
        watched,
      ),
      true,
      '用户的私聊必须唤醒——他说话她不醒，这个 agent 就没用了',
    );
    // 2026-10-02 用户报的岔子：给群起名字（= 进关注名单）之后，他在群里发的四个字、几个数字
    // 全被送进了她的上下文。**起名字是"让她认得这个会话"，不是"订阅这个群的每句话"**。
    assert.equal(
      shouldWakeForChannelMessage(
        { channel: 'qq-official', chatType: 'group', person: '甲', chatId: 'FAV', text: '群里的普通发言', messageId: 'm3', msgSeq: 1 },
        watched,
      ),
      false,
      '群里的非提及消息只入信箱：一条不丢，但不打断她',
    );
    // 同一个群里**叫到她**照样唤醒（@ 与关键词都不受"是否关注"影响）
    assert.equal(
      shouldWakeForChannelMessage(
        { channel: 'qq-official', chatType: 'group', person: '甲', chatId: 'FAV', text: '弥亚小姐在吗', messageId: 'm3b', msgSeq: 2 },
        criteria(new Set(['qq:group:FAV']), ['弥亚小姐']),
      ),
      true,
      '群里喊她的名字要唤醒——这正是文本提及的用意',
    );
  });

  test('群里的普通发言进信箱（不唤醒）——不 @、不喊名字', () => {
    const watched = criteria(new Set(['qq:c2c:OWNER']));
    for (const data of [
      { channel: 'qq-official', chatType: 'group' as const, person: '甲', chatId: 'G9', text: '闲聊', messageId: 'm4', msgSeq: 1 },
      { channel: 'onebot', chatType: 'group' as const, person: '乙', chatId: '12345', text: '水群', messageId: 'm6', msgSeq: 1 },
    ]) {
      assert.equal(
        shouldWakeForChannelMessage(data, watched),
        false,
        `${data.chatType}:${data.chatId} 不该叫醒她（QQ 是手边的软件，不是推给她的消息流）`,
      );
    }
  });

  test('**私聊一律唤醒**——认不认识、在不在关注名单里，都一样（2026-10-08）', () => {
    // 用户 2026-10-08 报的现象：「onebot 被私聊……变成和群聊类似的 read channel 了」。
    // 根因是这条判据原来对私聊多问了一句"这个 sid 在不在 watchedSids 里"，
    // 而那份名单是**联系人表 ∪ 她的别名表**——于是"给这个人起个名字"事实上变成了
    // "订阅这个人的每句话"：官 Bot 那个人的 sid 早在配置里（照样唤醒），
    // OneBot 那个人的 sid 晚填一行（**静默进信箱**，她得自己 read_channel 才看得见）。
    // 私聊里没有"@ 不 @"这回事，所以判据里**不许**再出现名单——两种通道、认不认识，四条全唤醒。
    const nobodyWatched = criteria(new Set());
    const ownerWatched = criteria(new Set(['qq:c2c:OWNER']));
    const cases: Array<[string, Parameters<typeof shouldWakeForChannelMessage>[0], WakeCriteria]> = [
      ['官Bot·用户（表里有）', { channel: 'qq-official', chatType: 'c2c', person: '用户', chatId: 'OWNER', text: '在吗', messageId: 'p1', msgSeq: 1 }, ownerWatched],
      ['OneBot·用户（表里有）', { channel: 'onebot', chatType: 'c2c', person: '10001', chatId: '10001', text: '在吗', messageId: 'p2', msgSeq: 1 }, ownerWatched],
      ['官Bot·陌生人（表里没有）', { channel: 'qq-official', chatType: 'c2c', person: '路人', chatId: 'STRANGER', text: '在吗', messageId: 'p3', msgSeq: 1 }, ownerWatched],
      ['OneBot·陌生人（表里没有）', { channel: 'onebot', chatType: 'c2c', person: '10009', chatId: '10009', text: '在吗', messageId: 'p4', msgSeq: 1 }, ownerWatched],
      ['OneBot·陌生人 + **空**名单', { channel: 'onebot', chatType: 'c2c', person: '10009', chatId: '10009', text: '在吗', messageId: 'p5', msgSeq: 1 }, nobodyWatched],
    ];
    for (const [label, data, watched] of cases) {
      assert.equal(
        shouldWakeForChannelMessage(data, watched),
        true,
        `${label}：私聊必须唤醒——正文要直接进"本轮新输入"，不是丢进外部会话等她 read_channel`,
      );
    }
    // 反向：私聊上**不该**因为"文案里没有关键词"而改变结论（关键词从来不是私聊的判据），
    // 而且它不该需要 mentionsMe —— 适配器在私聊上压根不填那个字段。
    assert.equal(
      shouldWakeForChannelMessage(
        { channel: 'onebot', chatType: 'c2c', person: '10009', chatId: '10009', text: '随便一句话', messageId: 'p6', msgSeq: 1 },
        criteria(new Set(), []),
      ),
      true,
    );
  });

  test('关注名单**不再**参与唤醒判据：给会话起名字 ≠ 订阅它的每句话', () => {
    // 这条锁的是"判据里没有那份名单"这个事实本身：名单里放什么都不该改变群聊的结论
    //（私聊的结论与名单无关，见上一条）。**别把名单当成"放宽群聊"的开关**——
    // 群聊只有"叫到她"才进对话流。
    const weird = criteria(new Set(['qq:group:G9', 'onebot:group:12345', 'qq:c2c:OWNER']));
    assert.equal(
      shouldWakeForChannelMessage(
        { channel: 'qq-official', chatType: 'group', person: '甲', chatId: 'G9', text: '闲聊', messageId: 'm4', msgSeq: 1 },
        weird,
      ),
      false,
      '群被"关注"了也不唤醒：给群起名字只是让她认得这个会话',
    );
    assert.equal(
      shouldWakeForChannelMessage(
        { channel: 'onebot', chatType: 'group', person: '乙', chatId: '12345', text: '水群', messageId: 'm6', msgSeq: 1 },
        weird,
      ),
      false,
    );
  });

  test('顺序即优先级：@ 优先于"没被关注"这个事实', () => {
    // 判据写反（先查 watched 再查 group-at）时，没被关注的群里的 @ 就唤不醒她——
    // 而那正是用户要的那一条。这条用例锁的是**顺序**，不是某一条单独的返回值。
    assert.equal(
      shouldWakeForChannelMessage(
        { channel: 'onebot', chatType: 'group-at', person: '丙', chatId: 'NEVER_SEEN', text: '@她', messageId: 'm7', msgSeq: 1 },
        criteria(new Set(['onebot:group-at:OTHER'])),
      ),
      true,
    );
    // 反向：关注名单里的**另一个**会话不该被这条 @ 连带唤醒（比对的是 sid，不是"有没有关注过谁"）
    assert.equal(
      shouldWakeForChannelMessage(
        { channel: 'onebot', chatType: 'group', person: '丙', chatId: 'NEVER_SEEN', text: '闲话', messageId: 'm8', msgSeq: 1 },
        criteria(new Set(['onebot:group-at:OTHER'])),
      ),
      false,
    );
  });

  test('sid 与会话簿/回投地址同形（关注名单里装的必须是同一个串）', () => {
    // 两处各拼一次串的代价是"关注了 A 却永远不唤醒"——这种错在日志里长得跟正常一样
    assert.equal(sidOfChannelData({ channel: 'qq-official', chatType: 'c2c', chatId: 'X' }), 'qq:c2c:X');
    assert.equal(sidOfChannelData({ channel: 'onebot', chatType: 'group-at', chatId: '12345' }), 'onebot:group:12345');
    assert.equal(sidOfChannelData({ channel: 'qq-official', chatType: 'group', chatId: 'G' }), 'qq:group:G');
    // **归一**：群里 @ 过的那条与非 @ 的那些落在同一个 sid 上——关注名单从此一次覆盖全群
    assert.equal(
      sidOfChannelData({ channel: 'qq-official', chatType: 'group-at', chatId: 'G' }),
      sidOfChannelData({ channel: 'qq-official', chatType: 'group', chatId: 'G' }),
    );
  });

  test('信箱落库时 msgSeq 要补齐：平台给 0 就填事件 seq，别让未读永远算不出来', () => {
    // 未读的判据是 `msgSeq > readUpToSeq`。平台给不出序号的那两类（OneBot 没 @ 的群消息、
    // 官方全量群消息）原样落 0 的话，每一条都是 0——她读一次之后未读永远是 0，
    // "某群积累了 N 条"再也显示不出来，信箱就白做了。
    const group = {
      channel: 'qq-official', chatType: 'group' as const, person: '张三', chatId: 'G1',
      text: '闲话', messageId: 'm1', msgSeq: 0,
    };
    assert.equal(inboxMsgSeqOf(group, 4242), 4242, '0 = 平台没给序号 → 用事件 seq');

    // 给得出真序号的（OneBot 带 message_seq 的那些）原样留着：那是平台自己的编号，量纲别混
    const onebot = { ...group, channel: 'onebot', msgSeq: 77 };
    assert.equal(inboxMsgSeqOf(onebot, 4242), 77, '有真序号就别覆盖');
    // 两个名字指向同一个实现（改名只为让 review 分得清"行为变化"与"重命名"）
    assert.equal(msgSeqOf, inboxMsgSeqOf);
  });

  test('唤醒那条路也补齐（同一个判据）：OneBot 群 @ 那一轮的通知才说得出"这一条你还没看过"', () => {
    // `agent-loop.ts` 的判据是 `wakeEvent.data.msgSeq > entry.readUpToSeq`。
    // OneBot 的群 @ 原先落 0 —— `0 > 0` 恒假，于是那一轮的通知里**永远**不出现
    // 「（这一条你还没看过）」，她会读成"又是上一次那条"而不回（报告 §3.4；
    // 用户 2026-10-02 踩过的那个坑：「她老是觉得自己已经回过了就不回」）。
    const onebotGroupAt = {
      channel: 'onebot', chatType: 'group-at' as const, person: '10001', chatId: '20002',
      text: '在吗', messageId: 'g-1', msgSeq: 0,
    };
    const seq = 947;
    const filled = withMsgSeqFallback(onebotGroupAt, seq) as { msgSeq: number };
    assert.equal(filled.msgSeq, seq, '平台没给序号 → 用事件 seq（单调、重放稳定）');
    assert.ok(filled.msgSeq > 0, '必须是**正**数：判据是 `> readUpToSeq`，0 永远为假');
    assert.equal(onebotGroupAt.msgSeq, 0, '不改入参：落库的是拷一份之后的那个对象');

    // 平台给了真序号就不许覆盖（量纲不同）
    const withSeq = withMsgSeqFallback({ msgSeq: 77, channel: 'onebot' }, 947) as { msgSeq: number };
    assert.equal(withSeq.msgSeq, 77);
    // 不带 msgSeq 的载荷（定时器、意图、心跳）原样返回：逐字节不变
    const timer = { note: '看看备份' };
    assert.equal(withMsgSeqFallback(timer, 947), timer, '不是通道载荷就别动它');
    assert.equal(withMsgSeqFallback(null, 947), null);
  });

  /**
   * **review P1-10（2026-10-18）**：官方通道的 c2c / group-at 原先落 **1**（那是**出站** `msg_seq`
   * 的语义）⇒ 读过一次之后 `1 > 1` 永假，「（这一条你还没看过）」在这个群**永久失明**。
   *
   * 现在适配器一律落 0（与 OneBot 没给 `message_seq` 时同形），下面这条用例用**现场的四个 seq**
   * 走一遍：群 @ 被读过（`channel/read{upToSeq:17731}`）之后再来两条 @，两条都必须"还没看过"。
   */
  test('官方入站一律落 0 ⇒ 读过一次之后，下一条群 @ 仍然说得出"这一条你还没看过"', () => {
    // 形状与 `qq-official.ts` 的 `mapDispatchToWakeChannel` 输出一致（2026-10-18 起 msgSeq 恒 0）
    const officialGroupAt = (messageId: string) => ({
      channel: 'qq-official', chatType: 'group-at' as const, person: 'MEMBER-OPENID',
      chatId: 'GROUP-OPENID', text: '@她 在吗', messageId, msgSeq: 0, mentionsMe: true,
    });

    // 现场：17721 那条 @ 被读（channel/read upToSeq=17731），下一条 @ 落在 17755
    const readUpToSeq = 17_731;
    const first = withMsgSeqFallback(officialGroupAt('ROBOT1.0_A'), 17_721) as { msgSeq: number };
    assert.ok(first.msgSeq <= readUpToSeq, '读过的那一条落回已读位之内（它不是新的）');

    for (const seq of [17_755, 17_793]) {
      const next = withMsgSeqFallback(officialGroupAt(`ROBOT1.0_${seq}`), seq) as { msgSeq: number };
      assert.equal(next.msgSeq, seq, '平台没给序号 ⇒ 补事件 seq（与信箱那条同一个函数）');
      assert.ok(next.msgSeq > readUpToSeq, `seq ${seq} 的这一条必须判成"还没看过"（P1-10 的正向）`);
    }

    // 反面：**出站**被动回复的 `msg_seq` 预算与这一格无关（它由 QqMessageSender 按 messageId 递增），
    // 所以入站改 0 不会把同一 msg_id 的多次回复压成同一个 1（那条有 `qq-channel.test.ts` 的顺序用例钉着）。
    assert.equal(officialGroupAt('X').msgSeq, 0, '入站这一格就是"平台没给"的 0，不是"第一次回复"的 1');
  });
});
