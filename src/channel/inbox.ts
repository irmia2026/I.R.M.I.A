/**
 * Irmia Agent — 通道消息分流器（design §4.24 的姊妹件：那边管"什么时候看"，这边管"要不要看"）
 *
 * **模型（用户定的）**：QQ 对她来说应该是"手边一个可以点开的软件"，不是推给她的消息流。
 * 除了用户与她自己标记为关注的会话，其他私聊/群聊消息**不强制注入**：框架照收照留
 * （写一条 `channel/message`，见 log/types.ts 那段注释），她只是**知晓**"某某会话积累了多少条"，
 * 可以选择看，也可以不看——不看也不会丢（已经到了我们这里的那些）。
 *
 * 在这之上只有一条硬提高优先级的路径：**@ 她 / 提到她**。那条进消息流并唤醒她，
 * 提示里写清"某群有人提到你，那里积累了 N 条"（见 model/self-brief.ts 的 renderMentionNote），
 * 剩下是她自己的决定：翻全部（大部分时候没用）还是只看 @ 附近（`read_channel`）。
 *
 * **为什么是纯函数**（不读配置、不碰日志、不查会话簿）：
 *   • 它决定的是一件有后果的事（要不要打断她），而后果要靠断言钉住——四种情形逐条可测，
 *     不必搭一整个循环；
 *   • 接线（谁来算 `watchedSids`、谁来写 `channel/message`）留在宿主（main.ts）里：
 *     本模块只回答"这条消息该不该叫她"，不替宿主决定从哪儿知道"谁被关注"。
 */

import type { WakeChannel } from '../log/types.js';
import { sidOf } from './sessions.ts';

/**
 * 复用会话层的 `sidOf`（`qq:c2c:<openid>` / `onebot:group-at:<id>`）。
 *
 * 为什么在这里再导出一次而不是让调用方去 import sessions：分流器的**全部**判断都基于 sid
 * （它要拿 sid 去比对 `watchedSids`，而 `watchedSids` 里的值又来自会话簿）。谁用分流器，
 * 谁就必须用同一个 sid 算法——两处各拼一次串，代价是"关注了 A 却永远不唤醒"这种查不出来的错。
 */
export { sidOf };

/**
 * 与 `wake/channel` 同形的数据 → sid。叫法与返回值都与会话簿一致。
 *
 * 只吃三个字段而不是整个 data：这样"哪些字段决定 sid"是一眼可读的，
 * 而且调用方不必为了算一个 sid 去凑齐一条完整消息。
 */
export function sidOfChannelData(data: Pick<WakeChannel['data'], 'channel' | 'chatType' | 'chatId'>): string {
  return sidOf(data.channel, data.chatType, data.chatId);
}

/**
 * **什么算"关注"**（`watchedSids` 该装哪些 sid）——这份清单是口径，实现在宿主（main.ts）。
 *
 * 两条来源，取并集：
 *   ① **用户**：`config.persona.contacts` 里显式声明过名字的那些 sid——人声明的事实最优先
 *      （它同时也是**身份与称呼**的依据：`resolveSessionName` 与 `runtime/trust.ts` 用的就是
 *      同一张表，用户认不认得出、叫什么名字都靠它）。
 *   ② **她自己标的**：`MEMORIES/aliases.md` 里出现过的 sid（她认出来的人）。
 *      理由是把"谁是谁"这件判断交回给她的资产：她写一行 `sid = 名字` 就等于说"这个人我认得"。
 *   ③ 将来若加显式配置（如 `channels.watch: []`），也并进同一份 —— 但**不要**在这里替
 *      宿主去读文件或配置：本模块是纯函数，读盘是宿主的事。
 *
 * ⚠️ **这份清单现在不决定"叫不叫她"**（2026-10-08）：它以前是私聊的唤醒闸门——不在名单里的
 * 私聊一律进信箱，于是"给这个人起个名字"顺手变成了"订阅这个人的每句话"的同义词。
 * 现在**私聊一律唤醒**（判据见 `shouldWakeForChannelMessage`），名单只回答"这个人是谁"。
 * 谁要拿它当唤醒判据前先想清楚：那等于让**命名**变成**订阅**。
 *
 * 刻意**不**包含的东西：群。给群起名字是"让她认得这个会话"，不是"订阅这个群的每句话"——
 * 2026-10-02 实测踩到过：用户给群填了名字，于是他在群里发的四个字、几个数字全被送进她的上下文。
 * 群里只有**叫到她**（@ 或喊她的名字）才进对话流，其余进信箱（未读照算）。
 *
 * ⚠️ **"进信箱"有一个我们控制不了的前提**：消息得先由官方 Bot **推给我们**（平台侧的消息权限 /
 * 订阅设置）。我们这一侧只有这一条路——平台没推的，我们收不到、也存不进信箱。所以这里**不说**
 * "一条不丢"（那句话把前提说成了结果）：**平台推给我们的，照旧进信箱**。2026-10-04 的现场核查
 * （`docs/unread-and-inbox-check.md`）就是因为这句失真的话被追问过：25 小时里一条非 @ 群消息都没到，
 * 而根因在平台侧的权限，不在这条分流逻辑里。
 */
export const WATCHED_SESSION_SOURCES = ['config.persona.contacts', 'MEMORIES/aliases.md'] as const;

/**
 * 这条通道消息该不该**唤醒**她（true = 进消息流并起 turn；false = 进信箱，只记账）。
 *
 * **判据只有两条，顺序无所谓，但两条各自都是完整的**（2026-10-08 收敛，见下面那条纪律）：
 *   ① **私聊（`chatType === 'c2c'`）→ 无条件 true。**
 *      私聊里没有"@ 不 @"这回事：对方就是在跟她说话，她当然要**当场**看到那句话——
 *      正文直接进"本轮新输入"，不是"丢进外部会话、要她自己 `read_channel`"。
 *   ② **群聊**：`group-at`（平台 @ 了她）或 `mentionsMe === true`（适配器如实填的"提到了你"）
 *      或正文里出现了**她被怎么称呼**里的词（`mentionKeywords`，2026-10-02 用户拍板）→ true；
 *      其余 → false（进信箱，只记账）。
 *
 * ── 为什么私聊那条是**无条件**的（这条纪律值得写在代码里）──
 *
 * 两条通道的适配器都忠于同一份协议事实（官方 `C2C_MESSAGE_CREATE` → `c2c`，
 * OneBot `message_type==='private'` → `c2c`，`person=chatId=对方 id`），**分歧从来不在适配器里，
 * 而在这里**：这条判据原先多问了一句"这个 sid 在不在 `watchedSids` 里"，而那份名单来自
 * 联系人表 ∪ 她把名字写下来的别名表。于是**同一个行为（给这个人起个名字）在两条通道上
 * 有了两种后果**：官 Bot 那个人的 sid 早就在配置里 ⇒ 私聊照样唤醒；OneBot 那个人的 sid
 * 只是晚填了一行 ⇒ 他的私聊**静默变成"只进信箱"**，她得自己 `read_channel` 才看得见
 * ——正是用户 2026-10-08 报的那句「onebot 被私聊……变成和群聊类似的 read channel 了」。
 * 那不是"OneBot 的私聊和官 Bot 的私聊不一样"，是**私聊被当成了群聊来分流**。
 *
 * 所以判据收成这一处、且**不许按通道名或按名单再分叉**：
 *   · 哪条通道来的不重要（`data.channel` 在这条判据里一个字都不读，两条通道共用这一份）；
 *   · 对方是谁不重要（认人靠 `runtime/trust.ts` 与联系人表，那是**信任级**的事，
 *     不是"要不要把这句话递到她面前"的事）；
 *   · **群里才需要 @ / 关键词**——那是"当众说话里哪一句是在叫她"的判据，私聊没有这个问题。
 *
 * ⚠️ **改动这条判据要一起改的三处**（它们锁着同一个口径）：
 *   `test/channel-inbox.test.ts`（判据本体）、`test/channel-onebot-c2c-wake.test.ts`
 *   （真链路：OneBot 私聊 ⇒ 正文进请求体）、以及 `docs/design.md` 里那段分流说明。
 *
 * 关于 `mentionsMe`：适配器"给得出就填"（官方通道在 `GROUP_MESSAGE_CREATE` 里看 `mentions`
 * 数组里有没有机器人开头的项），它是**平台级的事实**，所以认它。但它与 `chatType === 'group-at'`
 * 不冲突——适配器把 @ 归类为 `group-at` 时顺带填它，两处信息同源。
 * 私聊上它**没有意义**（`self-brief.ts` 的 `renderMentionNote` 对 c2c 一律返回 null：私聊里
 * 没有"有人在里面提到你"这回事），适配器也不该填——填了不会改这里的结论。
 */
export function shouldWakeForChannelMessage(
  data: WakeChannel['data'],
  criteria: WakeCriteria,
): boolean {
  // ① 私聊：无条件唤醒（对方就是在跟她说话）。**不许**在这里回头查 `criteria.watchedSids`
  //    ——那正是 2026-10-08 那个 bug 的形状（见上面那段）。
  if (data.chatType === 'c2c') return true;
  // ② 群聊：只有"叫到她"才进对话流。guild / dm 也是"当众/别的场景"，与群聊同一条规矩。
  if (data.chatType === 'group-at') return true;
  if (data.mentionsMe === true) return true;
  return mentionsKeyword(data.text, criteria.mentionKeywords);
}

/** 唤醒判据的两个外部输入：都来自宿主（配置与她的别名表），本模块只读结论 */
export interface WakeCriteria {
  /**
   * 用户 / 她认得的会话（键已归一，见 sessions.ts 的 `normalizeSid`）。
   *
   * ⚠️ **它现在不参与"叫不叫她"**：私聊无条件唤醒（见 `shouldWakeForChannelMessage`），
   * 群聊只认 @ / 关键词。这个字段留着是因为它仍是**同一份口径的一部分**（宿主每次都得
   * 把两份素材现读出来），而且将来若有"不是私聊、也不带 @"的新来源（比如某个平台的订阅流），
   * 它会是那份判据的输入。**今天的判据一个字都不读它**——要读之前先想清楚上面那段。
   */
  watchedSids: ReadonlySet<string>;
  /** 「她被怎么称呼」：正文里出现就当作在叫她（**群聊**判据）。空数组 = 只认平台的 @ */
  mentionKeywords: readonly string[];
}

/**
 * 正文里有没有人在叫她（关键词匹配）。
 *
 * 三条刻意的规则：
 *   • **大小写不敏感**：英文名（Irmia / irmia）不该因为大小写漏掉；
 *   • **空词忽略**：列表里混进空串不该让每条消息都命中；
 *   • **只匹配正文**：附件名、消息 id 不参与——那些不是"人在叫她"。
 *
 * 不做词边界判断（中文没有词边界，做了反而更糟）：代价是"伊尔弥亚的粉丝"这类也会命中，
 * 而那正是"她在群里被提到"的常见形态——多醒一次比漏听一句便宜。
 */
export function mentionsKeyword(text: string, keywords: readonly string[]): boolean {
  if (text === '' || keywords.length === 0) return false;
  const haystack = text.toLowerCase();
  return keywords.some((word) => {
    const needle = word.trim().toLowerCase();
    return needle !== '' && haystack.includes(needle);
  });
}

/**
 * 落库时这条消息的 `msgSeq`：**平台给不出真序号（0）就填事件 seq**。
 *
 * 为什么必须补：未读的判据是 `msgSeq > readUpToSeq`（见 `sessions.ts` 的 fold）。平台给不出
 * 序号的那两类——OneBot 没 @ 的群消息、官方全量群消息（事件体里压根没有这个字段）——如果
 * 原样落 0，每一条都是 0，她读一次之后未读**永远是 0**，于是"某群积累了 N 条"再也显示不出来，
 * 正好把这个信箱废掉。事件 seq 单调、重放稳定，正是这里要的那个数（约定写在 sessions.ts 那段）。
 *
 * 给得出真序号的（OneBot 带 message_seq 的那些）原样留着——那是平台自己的编号，量纲别混。
 *
 * **2026-10-07：唤醒那条路（`wake/channel`）也走它**（原来只有信箱那条走）。理由是同一个判据
 * 在**两处**读同一个字段：
 *   • 信箱：未读 `msgSeq > readUpToSeq`；
 *   • 唤醒：「这一条你还没看过」，`wakeEvent.data.msgSeq > entry.readUpToSeq`
 *     （`agent-loop.ts` 的 `contactWithWakeStamp`）。
 * 唤醒那条原先不补，于是 OneBot 群里 @ 她的那一轮 `0 > 0` 恒假——通知里**永远**不出现
 * 「（这一条你还没看过）」，她会读成"又是上一次那条"而选择不回（报告 §3.4；那正是用户
 * 2026-10-02 踩过的那个坑，这段代码存在的唯一理由就是修它）。
 * 两条路走**同一个函数**（唤醒那条是 `runtime/real-loop.ts` 的 `withMsgSeqFallback`，
 * 它调的也是这里）⇒ 同一个数、同一套量纲，"信箱说 5 条、唤醒说没看过"这种自相矛盾
 * 从源头不可能出现。
 */
export function msgSeqOf(data: { msgSeq?: number | undefined }, eventSeq: number): number {
  const platform = data.msgSeq ?? 0;
  // 非正数一律当"平台没给"：0 是"没有这个字段"的既有写法，负数不是合法序号
  return platform > 0 ? platform : eventSeq;
}

/**
 * 旧名字（信箱那条路的调用点用惯了）。逐字节等价于 `msgSeqOf`——留它是为了**不让这次
 * 语义扩大变成一次改名**：改名会让 review 分不清"哪些是行为变化、哪些只是重命名"。
 */
export const inboxMsgSeqOf = msgSeqOf;
