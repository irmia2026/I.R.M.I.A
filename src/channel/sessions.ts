/**
 * Irmia Agent — 会话簿（她认识"在哪儿说话、跟谁说话"的唯一依据）
 *
 * 三件事：
 *   ① **sid**：会话标识，形如 `qq:c2c:<openid>` / `qq:group-at:<group_openid>` /
 *      `onebot:c2c:<user_id>`。它与回投地址（tools/admin.ts 的 `replyUrlForWake`）
 *      **同形同源**——她说"发给谁"和系统"往哪发"必须是同一个东西，否则就会出现
 *      「她以为发给了张三、实际发到了群里」这种最难查的错。
 *   ② **会话簿**：从 `wake/channel` 与 `channel/message` **两种事件**折叠出来的已知会话
 *      （谁来过、什么时候、说过什么、她读到哪了）。零新增状态：日志仍是唯一真相源，
 *      这里只是它的一个投影。
 *   ③ **场景认知**：本机对话流不是一个"会话"（它没有 sid，也不来自任何通道），
 *      所以它单独标注——她得能分清"我在自己屋里自言自语/跟用户当面说话"与
 *      "我拿起电话打给某个人"。
 *
 * **为什么两种事件必须共用一份折叠实现**（下面 `applyChannelEvent` 只有一处）：
 *   • `wake/channel` 是「叫她」的那条路——@ 她、或关注/用户的会话，进消息流、唤醒 turn；
 *   • `channel/message` 是「手边软件在响」——群里/别人发来的普通消息，只记账、不唤醒。
 *   两者描述的是**同一件事**（某会话里某人说了一句），差别只在"要不要叫她"。折叠写两套的代价
 *   不是冗余：启动时从全量日志折叠（走 wake）与运行期逐条并入（走 message）会慢慢变成两份
 *   不同的记忆，而"她以为群里只来过三条"这种错在界面上看不出来。
 */
import type { AppEvent, ChannelMessage, ChannelRead, ChannelRenderContext, WakeChannel } from '../log/types.js';
import { isOneBotFamilyChannel } from './onebot.ts';

/** 通道显示名：与 GUI 频道页、web/pages/channels.js 同一套词 */
export const CHANNEL_LABELS: Record<string, string> = {
  'qq-official': 'QQ 官方 Bot API',
  onebot: 'OneBot 11',
};

/** 会话类型显示名：与频道页的 `_chatTypes` 同一套词 */
export const CHAT_TYPE_LABELS: Record<string, string> = {
  c2c: '单聊',
  'group-at': '群聊@',
  group: '群聊',
  guild: '频道',
  dm: '频道私信',
};

/**
 * 会话标识的命名空间：与回投 scheme 共用一套（qq: / onebot:）。
 *
 * ⚠️ 判据走 `isOneBotFamilyChannel`（**覆盖别名实例** `onebot-*`）。原来写的是
 * `channel === 'onebot'`，于是别名实例（`channelName: 'onebot-b'`）的会话被塞进
 * **`qq:` 命名空间**，与官方 QQ 的会话混在一起——同一处硬编码在仓库里的第三份。
 */
export function sidNamespaceOf(channel: string): string {
  return isOneBotFamilyChannel(channel) ? 'onebot' : 'qq';
}

/**
 * 一条消息的 chatType → **会话身份**里的那一段。
 *
 * **群聊的 @ 与非 @ 是同一个会话**（2026-10-02 用户拍板"会话身份归一"）：以前 sid 直接把
 * chatType 拼进去，于是同一个群裂成两个会话——`qq:group-at:<群id>`（@ 过她的那些）与
 * `qq:group:<群id>`（其余消息）。代价是三件事一起歪：
 *   • 联系人表里给群起的名字只贴在 @ 的那一份上，非 @ 的那份显示 openid（看着像陌生群）；
 *   • "关注这个群"（联系人/别名 = 关注名单）只覆盖 @ 的那一份，非 @ 的消息照样进信箱
 *     ——实测用户给群起了名字、以为关注上了，结果不 @ 就永远叫不醒她；
 *   • 会话清单里同一个群出现两行，"2 个群聊"其实是 1 个。
 *
 * 现在 chatType 只是**这一条消息**的属性（它 @ 没 @ 我），会话身份与它无关。
 * 回投地址跟着归一（`qq:group:<群id>`）：官方那条 API 的群发路径与 @ 与否无关，
 * 差别只在带不带 `msg_id`（被动回复），而那是**每条消息**的事，不是会话的事。
 */
export function sidKindOf(chatType: string): string {
  return chatType === 'group-at' ? 'group' : chatType;
}

/** 组一个 sid。chatId 里若含 `:`（不该有，但外部数据不可信）会被 parseSid 原样还原 */
export function sidOf(channel: string, chatType: string, chatId: string): string {
  return `${sidNamespaceOf(channel)}:${sidKindOf(chatType)}:${chatId}`;
}

/**
 * 把**别人写下的** sid（配置里的联系人、她自己写的别名、旧日志里的 `channel/read`）归一到
 * 同一个口径。形态不认得就原样返回（不猜）。
 *
 * 为什么读的时候也要归一：归一之前落盘的 sid 里带着 `group-at`，那些记录还在用——
 * 联系人表里 `qq:group-at:<群id>` 是用户自己填的，别名表里可能有她认的群，日志里还有
 * 一批 `channel/read`。**改口径不该把人已经写下的东西变成废纸**。
 */
export function normalizeSid(sid: string): string {
  const parsed = parseSid(sid);
  if (parsed === null) return sid;
  return `${parsed.namespace}:${sidKindOf(parsed.chatType)}:${parsed.chatId}`;
}

export interface ParsedSid {
  namespace: string;
  chatType: string;
  chatId: string;
}

/** 解一个 sid；形态不对返回 null（不猜） */
export function parseSid(sid: string): ParsedSid | null {
  const first = sid.indexOf(':');
  const second = sid.indexOf(':', first + 1);
  if (first <= 0 || second <= first + 1 || second === sid.length - 1) return null;
  const namespace = sid.slice(0, first);
  const chatType = sid.slice(first + 1, second);
  const chatId = sid.slice(second + 1);
  if (chatId === '') return null;
  return { namespace, chatType, chatId };
}

/** sid 的命名空间反查通道名（`qq` → `qq-official`：回投 poster 按这个选通道） */
export function channelForNamespace(namespace: string): string {
  return namespace === 'onebot' ? 'onebot' : 'qq-official';
}

/**
 * QQ 号：**纯数字、5–12 位**（现实里的号段范围）。判据就是这一条——不是"看起来像"。
 *
 * 为什么必须卡死（用户 2026-10 的口径：「取不到号就 null，**不许瞎拼**」）：
 * 拼错一个字符的腾讯头像地址**照样回一张 200 的图**（默认企鹅），于是界面上会出现
 * "每个会话的头像都长一样"——那是比没有头像更坏的错（它看起来是对的）。
 */
const QQ_NUMBER_RE = /^\d{5,12}$/u;

/**
 * 会话头像的地址（`GET /api/sessions` 的 `avatarUrl`，2026-10 加）。
 *
 * 三档，**判据全在 sid 里**，不查任何表、不发任何请求：
 *   · `onebot:group:<群号>` ⇒ 群头像 `https://p.qlogo.cn/gh/<群号>/<群号>/100`
 *     （腾讯那条群里两个路径段都是群号，这是它的既有形状，不是我们拼的花样）；
 *   · `onebot:c2c:<QQ号>`  ⇒ 个人头像 `https://q.qlogo.cn/g?b=qq&nk=<QQ号>&s=100`；
 *   · **QQ 官方 Bot（`qq:*`）⇒ `null`**：官方 Bot 给的 `person` / `chatId` 是**openid**
 *     （`1A2B3C…` 那种不透明串），平台**不给我们**任何真实号 ⇒ 也就没有头像可拼。
 *     这一格是"平台不给"的事实，不是"我们还没做"——**不许拿别的 id 冒充 QQ 号**
 *     （拼出来的图是 200 的默认头像，看不出来是错的，见 {@link QQ_NUMBER_RE}）。
 *
 * 认不出的 chatType（`guild` / `dm` 等）与取不出号的一律 `null`：界面走首字占位。
 */
export function avatarUrlOf(sid: string): string | null {
  const parsed = parseSid(sid);
  if (parsed === null) return null;
  // 只有 OneBot 族的 id 才是真的 QQ 号；`qq:` 命名空间里那些是 openid（见上面那一段）
  if (parsed.namespace !== 'onebot') return null;
  const id = parsed.chatId.trim();
  if (!QQ_NUMBER_RE.test(id)) return null;
  switch (sidKindOf(parsed.chatType)) {
    case 'group': return `https://p.qlogo.cn/gh/${id}/${id}/100`;
    case 'c2c': return `https://q.qlogo.cn/g?b=qq&nk=${id}&s=100`;
    default: return null;
  }
}

export interface SessionEntry {
  sid: string;
  /** 通道名（`qq-official` / `onebot`） */
  channel: string;
  chatType: string;
  chatId: string;
  /**
   * 最近跟她说话的人：私聊是对方，群里是那位发言者（QQ 给的就是 openid）。
   *
   * **空串 = 这个会话到现在为止只有"动静"、还没有人说过话**（2026-10-11 加 `channel/notice`
   * 之后的第三种来源）：notice 里那个人可能是"被禁言的人"、也可能压根没给（平台常常不说是谁
   * 干的），所以那一格**照实留空**，不硬塞一个名字进去（`resolveSessionName` 会退回会话 id
   * 或别名，见那里的注释）。
   */
  person: string;
  /** 最近一条消息的片段（她认人用，不是全文） */
  lastText: string;
  lastSeenAt: string;
  /** 这个会话里她一共收到过多少条 */
  messages: number;
  /**
   * 别名：`MEMORIES/aliases.md` 里给这个会话起的名字（她自己维护的资产）。
   *
   * 为什么必须有它：QQ **不提供**单聊/群聊用户的昵称（隐私限制），她拿到的 `person`
   * 就是一串 openid。没别名时她只能靠"只有一个私聊会话"这种旁证猜人，猜错的代价是认错人。
   */
  label: string | null;
  /**
   * 她**读到**这个会话的哪一条了（`channel/read` 折叠；0 = 一条都没读过）。
   *
   * 比的是 `msgSeq` 而不是事件 seq：msgSeq 是"这条消息是这个会话里的第几条"，
   * 未读的语义正落在它上面（见 `unread` 的注释）。
   */
  readUpToSeq: number;
  /**
   * 这个会话里 `msgSeq > readUpToSeq` 的条数 = **她还没看的**。
   *
   * 为什么按"最近一次已读位置"算、而不是维护一个自减计数：计数会被重启、丢事件、并发写
   * 各掰一次，错了也没人看得出来；而"读到哪一条"是一个位置，重放日志必然算出同一个数
   * ——这正是本仓库"日志是唯一真相源"的用法。
   *
   * 已知偏差（刻意留着）：平台给不出真 msgSeq 时调用方填事件 seq，而两种值的量纲不同——
   * 一条老消息（事件 seq 很大）之后再来一条新消息（msgSeq 从 1 重新数）会让未读**偏小**。
   * 宁可偏小也不偏大：偏小 = 她少看几条（`read_channel` 现取的永远是最近的，不丢），
   * 偏大 = 每次都催她去看一屏其实看过的旧话。
   */
  unread: number;
}

/**
 * 会进会话簿的**四种**事件。前两种唯一实质差别是"要不要叫她"，折叠口径完全相同；
 * 后两种（`channel/notice` 群里的动静、`channel/self-action` 她自己的管理动作）是**同一档**：
 * 与它们共用同一份折叠，只在两处刻意不同（见 `applyChannelMessage` 里的 `accrues` 与 `isAside`）。
 *
 * 写成联合而不是交叉：交叉类型（`A & B`）在窄化到具体一种事件之后会被收成 never
 * （两个字面量 type 不可能同时成立），折叠函数里就一个字段都读不出来。
 */
export type ChannelEvent =
  | (AppEvent & { type: 'wake/channel' })
  | (AppEvent & { type: 'channel/message' })
  | (AppEvent & { type: 'channel/notice' })
  | (AppEvent & { type: 'channel/self-action' });

/** 这条事件要不要并进会话簿（唯一判据，collect 与 upsert 共用一处） */
function isChannelEvent(event: AppEvent): event is ChannelEvent {
  return event.type === 'wake/channel' || event.type === 'channel/message'
    || event.type === 'channel/notice' || event.type === 'channel/self-action';
}

/**
 * 从事件流折叠会话簿（按最后说话时间倒序）。
 *
 * 认两种事件：`wake/channel`（叫她来的那些）与 `channel/message`（只记账的那些）；
 * `channel/read` 再叠上"她读到哪了"。她不认识的会话就是没来过，不猜、不编——
 * 想给人发消息得先有过往来（或者人先来找她）。
 */
export function collectSessions(events: readonly AppEvent[]): SessionEntry[] {
  const map = new Map<string, SessionEntry>();
  for (const e of events) {
    if (isChannelEvent(e)) applyChannelMessage(map, e);
    else if (e.type === 'channel/read') applyChannelRead(map, e);
  }
  return sortSessions(map);
}

/**
 * 把一条通道事件并入会话簿（增量更新用）。
 *
 * 运行期不可能每轮重扫全量日志：real-loop 在启动时用 `collectSessions` 折叠一次，
 * 之后每收到一条就调这里。两者共用 `applyChannelMessage` / `applyChannelRead` 与
 * `sortSessions`——**一份实现**，否则"启动时算的"与"运行期长的"会慢慢变成两份不同的记忆。
 *
 * 不是通道事件就原样返回（会话簿只记"外面有人跟她说话"这一件事）。
 */
export function upsertSession(book: readonly SessionEntry[], event: AppEvent): SessionEntry[] {
  const map = new Map<string, SessionEntry>(book.map((entry) => [entry.sid, entry]));
  if (event.type === 'channel/read') applyChannelRead(map, event);
  else if (isChannelEvent(event)) applyChannelMessage(map, event);
  return sortSessions(map);
}

/** 通道数据 → sid（她读哪个会话、`channel/read` 记在谁头上，都得是同一个算法） */
export function sidOfChannelData(data: {
  channel: string; chatType: string; chatId: string;
}): string {
  return sidOf(data.channel, data.chatType, data.chatId);
}

/** 三种通道事件共有的那段负载（折叠唯一需要的字段；`mentionsMe` 之类刻意不在其中） */
export interface ChannelMessageFields {
  channel: string;
  chatType: string;
  person: string;
  chatId: string;
  text: string;
  messageId: string;
  msgSeq: number;
}

/**
 * 取一条通道事件的共有字段（notice 与 self-action 的 `person` 那一格**照实留空**——都没有发言人）。
 *
 * 为什么不直接用 `event.data`：四种事件的 data 键集不同（一个带 `dedupeKey`、一个带
 * `mentionsMe`、一个带 `noticeType`、一个带 `receipt`），联合类型下 TS 会把不相交的属性收成 never。
 * 折叠**只该读这几个字段**——把口径收成一份显式的清单，也顺手挡住了"顺手多读一个字段"的漂移。
 */
export function channelDataOf(event: ChannelEvent): ChannelMessageFields {
  if (event.type === 'channel/notice') {
    return {
      channel: event.data.channel,
      chatType: event.data.chatType,
      // 群里的一件动静**没有发言人**：照实留空，不拿"被禁言的那个人"顶替（那是两个问题）
      person: '',
      chatId: event.data.chatId,
      // 清单那一行缀的是"最近说了什么"——动静那一条缀上它的类别（`group_ban` 这种协议词
      // 摆给她是噪音，所以只作**兜底**：真正可读的那一句在 `read_channel` 那一行里）
      text: event.data.noticeType,
      messageId: event.data.messageId ?? '',
      msgSeq: event.data.msgSeq ?? 0,
    };
  }
  if (event.type === 'channel/self-action') {
    return {
      channel: event.data.channel,
      chatType: event.data.chatType,
      // 她自己的动作**也没有发言人**（那是"我做的"，不是"谁说的"）
      person: '',
      chatId: event.data.chatId,
      // 同上：清单那一行缀协议动作名（真正可读的那一句在 `read_channel` 那一行里）
      text: event.data.action,
      messageId: '',
      msgSeq: 0,
    };
  }
  return event.data;
}

/**
 * 一条通道消息并入会话簿（**唯一实现**：collect 与 upsert 都走它）。
 *
 * 三件事在同一份数据上落：
 *   ① 新消息覆盖"最近一条"、累计条数（既有语义，一个字没动）；
 *   ② `msgSeq` 超过已读位置就是没看过的，未读 +1——**未读在这里算，不另立一处**；
 *      于是"重启后剩下的未读"与"运行期长出来的未读"必然一致（日志重放得同一个数）；
 *   ③ 已读位置只增不减（见 applyChannelRead）。
 */
function applyChannelMessage(map: Map<string, SessionEntry>, event: ChannelEvent): void {
  // 联合类型在这里窄化不了（两种事件都是 AppEvent，data 的键集不同），所以取一次共有字段。
  // 只读这几个字段是**有意的**：fold 不该关心"这条是不是 @ 了我"——那是分流器的事。
  const d = channelDataOf(event);
  const sid = sidOf(d.channel, d.chatType, d.chatId);
  const prev = map.get(sid);  const readUpToSeq = prev?.readUpToSeq ?? 0;
  /**
   * 这条算不算"未读的积累"——**只有进信箱的才算**。
   *
   * 判据是事件类型，而不是"@ 没 @ 我"（那确实是分流器的事，fold 不该管）。区别在另一处：
   * `wake/channel` 是**已经送进她上下文**的那条，她当场看到了（哪怕选择不理，也是看过了）；
   * `channel/message` 才是攒在信箱里、等她哪天想翻再翻的。
   *
   * 两者混在一起数的后果是外部会话清单给她报一批**假未读**：实测用户那个单聊显示
   * "18 条没看"，而那些消息她全都看过、也回过。她会为了这批假数字去 `read_channel`
   * 翻一遍——白花一轮，还把自己刚说过的话重读一遍。
   *
   * （`messages` 那个总数仍然两种都计：它答的是"这个会话来过多少条"，与看没看过无关。）
   */
  const accrues = event.type === 'channel/message';
  /**
   * **不是"别人的话"的两类**（`channel/notice` 群里的动静、`channel/self-action` 她自己的动作）：
   * 它们进会话簿的目的只有一个——让"这个会话"在她眼里存在。两处刻意与消息不同：
   *   • **不计未读**（`accrues` 已经是 false）——未读数的必须是"别人的话"，
   *     把"某人加入了群聊"或"我设过全员禁言"算进去会让她以为有人在等她回话；
   *   • **不计入 `messages` 那个总数**——那个数的语义是"这个会话来过多少条**话**"
   *     （见 `SessionEntry.messages` 与 `read_channel` 的"最近 N 条"），
   *     混进这两类会让"他说了很多"变成一个假的量。
   */
  const isAside = event.type === 'channel/notice' || event.type === 'channel/self-action';
  map.set(sid, {
    sid,
    channel: d.channel,
    // 会话的类型取**会话口径**（群聊一律 group）：它答的是"这是个什么会话"，
    // 而不是"这一条 @ 没 @ 我"——后者属于消息，记在事件上
    chatType: sidKindOf(d.chatType),
    chatId: d.chatId,
    person: d.person,
    lastText: d.text.replace(/\s+/gu, ' ').trim().slice(0, 60),
    lastSeenAt: event.ts,
    messages: (prev?.messages ?? 0) + (isAside ? 0 : 1),
    // 别名不在这里查：折叠只管事实（谁在什么时候说了什么），名字是单独的、可以随时改的一份表
    label: prev?.label ?? null,
    readUpToSeq,
    unread: (prev?.unread ?? 0) + (accrues && d.msgSeq > readUpToSeq ? 1 : 0),
  });
}

/**
 * 折叠一条 `channel/read`：把已读位置推高，并按新位置重算未读。
 *
 * **只增不减**：读一条更早的记录（重放日志、或者她翻完历史又回头看了一段）不该让未读弹回来
 * ——"已读"在人的直觉里也是一次性的，退回去只会让她被同一批旧话反复叫住。
 *
 * 没有对应会话条目时**什么也不做**（不凭空造一个空会话）：那说明这个 sid 从来没有消息来过，
 * 这条读位记录就是无主数据，凭空造条目会让外部会话清单里冒出一个"没说过话的会话"。
 */
function applyChannelRead(map: Map<string, SessionEntry>, event: AppEvent & { type: 'channel/read' }): void {
  // 归一之后再查：旧日志里这条事件写的是 `qq:group-at:<群id>`（归一之前的形态），
  // 而会话条目现在是 `qq:group:<群id>`——不归一就读成"这个 sid 没来过"，已读位白记
  const sid = normalizeSid(event.data.sid);
  const upToSeq = event.data.upToSeq;
  const prev = map.get(sid);
  if (prev === undefined || upToSeq <= prev.readUpToSeq) return;
  // 未读**不按"减掉读过的条数"算**（读一半、跳着读都会算错），而是按位置重算：
  // 已读位置一动，未读的定义（msgSeq > readUpToSeq 的条数）就跟着变，位置是唯一的真相。
  //
  // 折叠里没有逐条消息的清单（会话簿是投影，不是消息表），所以能推断的是上界：未读数本身
  // 就是"介于旧已读位与最新一条之间"的条数，推高已读位最多把它清零。若新旧之间实际少于未读
  // 数（跳着读、平台序号有洞），剩下的部分会在她下一次 read_channel 时被一并归零——
  // 保守留一点，不凭空多减。而 read_channel 取回的永远是最新的若干条，不会因此丢掉内容。
  map.set(sid, { ...prev, readUpToSeq: upToSeq, unread: 0 });
}

/** 排序的唯一实现：最近说话的排最前（她要的是"现在谁在那头"） */
function sortSessions(map: ReadonlyMap<string, SessionEntry>): SessionEntry[] {
  return [...map.values()].sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0));
}

/** 会话的人读名字：`QQ 官方 Bot API · 单聊` */
export function sessionLabelOf(entry: Pick<SessionEntry, 'channel' | 'chatType'>): string {
  const channel = CHANNEL_LABELS[entry.channel] ?? entry.channel;
  const chatType = CHAT_TYPE_LABELS[entry.chatType] ?? entry.chatType;
  return `${channel} · ${chatType}`;
}

/**
 * 拿一个 sid 去"人写下的表"里查时，该试哪几个键（按顺序）。
 *
 * 两种写法都要试的理由：归一（2026-10-02）之前写下的记录还在用——用户填的联系人表里可能是
 * `qq:group-at:<群id>`，她自己写的别名同理。**改口径不该把人已经写下的东西变成废纸**，
 * 而失效的样子很难看："我给这个群起过名字"却在界面上看见一串 openid。
 */
export function sidLookupKeys(sid: string): string[] {
  const parsed = parseSid(sid);
  if (parsed === null) return [sid];
  const kind = sidKindOf(parsed.chatType);
  const keys = [`${parsed.namespace}:${kind}:${parsed.chatId}`];
  // 群聊再补一次旧形态；其余类型没有第二种写法
  if (kind === 'group') keys.push(`${parsed.namespace}:group-at:${parsed.chatId}`);
  return keys;
}

/** 在表里按 [sidLookupKeys] 的顺序查第一份命中（查不到返回 undefined，不编） */
export function lookupBySid(
  table: ReadonlyMap<string, string> | undefined,
  sid: string,
): string | undefined {
  if (table === undefined) return undefined;
  for (const key of sidLookupKeys(sid)) {
    const hit = table.get(key);
    if (hit !== undefined && hit !== '') return hit;
  }
  return undefined;
}

/**
 * 别名表里一条记的是什么：`name` 是名字本身，`note` 是名字后括号里的备注。
 *
 * 为什么备注要留下来而不是解析时丢掉：它是**她的行为口径**（"这个群里不聊什么、要不要接话"），
 * 人得看得见它才敢改名字——丢掉之后界面上就只剩一个光名字，改名等于替她把口径也删了。
 */
export interface SessionAlias {
  /** 显示名（第一个括号之前那部分） */
  name: string;
  /** 括号里的备注；没写括号就没有这一项 */
  note?: string;
}

/**
 * 别名表的值有两种形态：她自己写的（{@link SessionAlias}）与人声明的联系人表（纯名字串）。
 *
 * 为什么要这个并集：名字查找（`lookupBySid` / `resolveSessionName` / `readableSessionName`）
 * 对两张表是**同一套**判据，只有"这张表里有没有备注"不同。与其在每个调用点把其中一张转成另一种
 * 形状（那等于把同一件事抄好几遍），不如让查找自己认这两种值——**从值里取名字只有下面一处**。
 */
export type AliasEntry = string | SessionAlias;
/** 按 sid 查名字的表（联系人表、别名表都符合） */
export type AliasTable = ReadonlyMap<string, AliasEntry>;

/** 表里一条的显示名（空串与查不到都返回 undefined：这两种对调用方是同一件事——没有名字） */
function aliasNameOf(entry: AliasEntry | undefined): string | undefined {
  if (entry === undefined) return undefined;
  const name = (typeof entry === 'string' ? entry : entry.name).trim();
  return name === '' ? undefined : name;
}

/** 在名字表里查（联系人表与别名表共用；查不到返回 undefined，不编） */
function lookupAliasBySid(table: AliasTable | undefined, sid: string): SessionAlias | undefined {
  if (table === undefined) return undefined;
  for (const key of sidLookupKeys(sid)) {
    const entry = table.get(key);
    const name = aliasNameOf(entry);
    if (name === undefined) continue;
    const note = typeof entry === 'string' ? undefined : entry?.note?.trim();
    return note === undefined || note === '' ? { name } : { name, note };
  }
  return undefined;
}

/**
 * 单个 sid 的名字（联系人表优先，其次别名表）：给"只拿到一个 sid"的调用方用。
 *
 * 与 `resolveSessionName` 同一套查找（含新旧两种写法的兼容），差别只是输入不是会话条目。
 * real-loop 渲染一条通道消息、以及 `read_channel` 解析名字，都走这里——**一处实现**，
 * 否则"消息旁边显示 openid、清单上显示名字"这种不一致迟早出现。
 */
export function resolveNameForSid(
  sid: string,
  contacts: ReadonlyMap<string, string> | undefined,
  aliases: AliasTable | undefined,
): string | null {
  return lookupBySid(contacts, sid) ?? aliasNameBySid(aliases, sid) ?? null;
}

/**
 * **发言人（`person`）→ 名字的唯一判据**——群里的发言人与单聊的对方都走它。
 *
 * 为什么需要单独一层（2026-10-11 补的一处缺口）：`resolveNameForSid` 的输入是**会话 sid**，而群消息
 * 里拿到的是**发言人 id**；把后者变成前者要凭空合成 `qq:c2c:<id>` / `onebot:c2c:<id>` 两种键
 * （real-loop 原来就是在这两个键上试的）。那条路只覆盖"这个人**从这扇单聊门**跟她说过话"的情形，
 * 而群成员**可能从没私聊过她**——那正是她在 `aliases.md` 的 `# 群成员` 段里按段头那句
 * "只在认人时用"写下裸 id 的原因（她真写了六条：`1 号`、`甲`、`丙`、`Linre`、用户的官方
 * openid…）。而原来那一段被 `parseAliases` 丢掉（它只收 sid 那类键），于是**她写在正确位置的
 * 身份声明，框架一条都没看见**：那些人在她眼里只剩机器发的一次性占位名（"群友A（群昵称：…）"），
 * 而占位名发了就不改（见 group-members.ts）。缺口就是这里：**裸 id 的声明没人查**。
 *
 * 一个反例，免得把这一层想得比它大：用户本人 10-07 02:26 那次的映射她写在**标题行**里
 * （`# 该群成员（…）：1234567890 = **阿岚（用户）**…`），而 `#` 是 markdown 标题/散文、
 * 一律跳过——那一笔**这一层照样读不到**（判据见 [forEachAliasRow]，测试钉在
 * `test/person-name.test.ts` ①b）。他后来能对上名，靠的是另写了一条 `onebot:c2c:<QQ号>`
 * （会话键那一档）。所以这一层修的是"她按模板写的裸 id 行不许再是死信"，不是"任何写法都认"。
 *
 * 权威顺序（与 `group-members.ts` 文件头那份一致，人写的永远压过机器攒的）：
 *   ① 用户手写的联系人表（`config.persona.contacts`，按合成出来的 c2c 键查）
 *   ② 她自己的会话别名（同一批键：`onebot:c2c:<id>` / `qq:c2c:<id>`）
 *   ③ 她自己的群成员别名（`aliases.md` 的 `# 群成员` 段，**裸 id 精确相等**）
 *   ④ 查不到 → `null`，由调用方接最后一档（群成员档案里那个自动占位名，见
 *      `real-loop.personNameOf`；**它不在这里**，因为"人写的 > 机器攒的"这条要靠顺序表达，
 *      而不许把机器攒的那份混进"人写的"里——`humanSourceNameOf` 正是靠"这里返回 null"来判
 *      "这人还没有名字、该进档案"）。
 *
 * 两条都是**名字**，不是身份：身份（谁能指挥她）只由 `trust.ts` 按联系人表判，这里一个字都不碰
 * ——她给自己的群成员写了个什么名字，都不会让那个人变成用户。
 */
export function resolvePersonNameFromTables(
  person: string,
  contacts: ReadonlyMap<string, string> | undefined,
  aliases: AliasTable | undefined,
  memberAliases: AliasTable | undefined,
): string | null {
  const id = person.trim();
  if (id === '') return null;
  for (const namespace of ['qq', 'onebot']) {
    const named = resolveNameForSid(`${namespace}:c2c:${id}`, contacts, aliases);
    if (named !== null && named !== '') return named;
  }
  // 群成员那一段的键就是**裸 id**（没有 `:`，见 [MEMBER_KEY_RE]），所以这里精确相等地查一次
  const member = aliasNameOf(memberAliases?.get(id));
  return member ?? null;
}

/**
 * 一条通道唤醒的**显示名**（`session=` / `sid=` / `person=` 那三个标签的素材）：
 * 运行期、CLI 重放、界面预览**三处共用的唯一实现**。
 *
 * 为什么必须是"一处"：这段判据有四个出口（会话名、发言人名、私聊里"会话名兼作发言人名"的兜底、
 * 查不到就不写），三份实现各写一遍迟早漂成"当时写着摸鱼群、复盘时写成 openid"——而且不报错，
 * 只有逐字节对比才抓得到（2026-10-21 的两条红就是这么来的）。所以：
 *   · 运行期 `real-loop.channelRenderContext` 调它（每次装配 deps 算一份）；
 *   · 重放的**旧日志回退路径**调它（新日志优先读 `step/start.channelRender` 里当时记下的结论）。
 *
 * 三条口径（与 v76 之后运行期的行为**逐字节相同**——这是重构，不是改判据）：
 *   ① `sid` 从事件算（`sidOf`；`group-at` 归一到 `group`，见 [sidKindOf]）；
 *   ② 会话名 = 联系人表 > 她的会话别名 > **退回 `chatId`**（原样写 id，不编名字）；
 *   ③ 发言人名 = 人写的三档（{@link resolvePersonNameFromTables}）> 第四档
 *      `groupMemberNameOf`（群成员档案里的自动占位名）；还是查不到时，若会话名解析出来了就
 *      **拿会话名兼作发言人名**（私聊里两者本来同一个值，这是 v32 的既有兜底），否则整格省略。
 *
 * `groupMemberNameOf` 是**入参而不是这里读盘**：调用方一个在内存里（`GroupMemberBook`）、
 * 一个在读只读快照——路径怎么拼、有没有那份文件，不该由这条纯判据去猜。
 */
export interface ChannelRenderTables {
  /** 用户手写的联系人表（`config.persona.contacts`） */
  contacts?: ReadonlyMap<string, string> | undefined;
  /** 她自己的会话别名（`MEMORIES/aliases.md` 的 sid 段） */
  aliases?: AliasTable | undefined;
  /** 她的群成员别名（同一份文件里的裸 id 段） */
  memberAliases?: AliasTable | undefined;
  /** 第四档：群成员档案里的自动占位名（`data/group-members.json`）；给不了 = 那一档没有名字 */
  groupMemberNameOf?: ((person: string) => string | null) | undefined;
}

export function channelRenderOf(
  wake: Pick<WakeChannel['data'], 'channel' | 'chatType' | 'chatId' | 'person'>,
  tables: ChannelRenderTables = {},
): ChannelRenderContext {
  const sid = sidOf(wake.channel, wake.chatType, wake.chatId);
  const named = resolveNameForSid(sid, tables.contacts, tables.aliases);
  // 发言人按 `person` 查，**不是会话名**（2026-10-03 上下文审计）：群里两者不是一回事，
  // 拿会话名当人名会写成"摸鱼群：…"，看起来像群在说话。
  const speaker = resolvePersonNameFromTables(
    wake.person,
    tables.contacts,
    tables.aliases,
    tables.memberAliases,
  ) ?? tables.groupMemberNameOf?.(wake.person) ?? null;
  return {
    sid,
    sessionLabel: named ?? wake.chatId,
    // 查不到人名时的既有兜底：会话名有就借来当人名（私聊里两者同一个值），否则这一格省略
    ...(speaker === null ? (named === null ? {} : { personLabel: named }) : { personLabel: speaker }),
  };
}

/**
 * 名字表里一条的**名字**（别名表那条可能带着备注，这里只要名字）。
 *
 * 与 `lookupBySid` 分工：那个给纯名字表（人声明的联系人表）用，这个给她的别名表用，
 * 两者都走 [sidLookupKeys] 的顺序——新旧两种 sid 写法的兼容只在这一层，别处不许再判一次。
 */
function aliasNameBySid(aliases: AliasTable | undefined, sid: string): string | undefined {
  return lookupAliasBySid(aliases, sid)?.name;
}

/**
 * 名字优先级：**框架联系人表**（人声明的事实）> 她自己的别名 > openid。
 *
 * 为什么人声明的优先：她可能认错人，而联系人表是"这个会话是谁"的权威来源——
 * 一个认错用户的 agent，后面所有判断都是歪的。
 */
export function resolveSessionName(
  entry: Pick<SessionEntry, 'sid' | 'label' | 'person'>,
  contacts: ReadonlyMap<string, string> | undefined,
  aliases: AliasTable | undefined,
): string {
  return lookupBySid(contacts, entry.sid) ?? aliasNameBySid(aliases, entry.sid) ?? entry.label ?? entry.person;
}

/**
 * 会话的**可读称呼**：名字真源查不到时，退回"一个群聊（…000000）"，**不摆 openid**。
 *
 * 为什么（2026-10-02 实测误导）：用户新开了一个群，联系人表里还没有它的名字，于是
 * `resolveSessionName` 退到 `entry.person`——那句通知成了
 * 「有人在 00000000000000000000000000000001 里提到了你」。她读到的既不是群名、也看不出那是
 * "群里"（长得像个人名），接着就把这条通知当成**上一轮那条旧消息**，选择不回复。
 * openid 是给人（与日志）对号用的，不该出现在"叫她"的那句话里。
 */
export function readableSessionName(
  entry: Pick<SessionEntry, 'sid' | 'label' | 'person' | 'chatType'>,
  contacts: ReadonlyMap<string, string> | undefined,
  aliases: AliasTable | undefined,
): string {
  const named = lookupBySid(contacts, entry.sid) ?? aliasNameBySid(aliases, entry.sid) ?? entry.label;
  if (named !== null && named !== undefined && named.trim() !== '') return named.trim();
  const kind = entry.chatType === 'c2c' ? '一个单聊' : '一个群聊';
  const tail = entry.sid.length <= 6 ? entry.sid : entry.sid.slice(-6);
  return `${kind}（…${tail}）`;
}

/**
 * 这个名字是从**哪儿**来的，以及她写在那条别名后面的备注。
 *
 * 为什么名字与备注要一起答：备注是**别名的从属信息**，只有名字真源就是那条别名时它才成立。
 * 联系人表里人写的名字把群叫成别的了，却还在旁边挂着她给旧名字写的口径，那比不显示更坏
 * （人会以为那句口径还作数）。所以这里把"名字从哪来"与"备注是什么"一次算清，
 * 界面与端点都不许自己再拼一遍（判据只做一处）。
 */
export function aliasNoteOf(
  entry: Pick<SessionEntry, 'sid' | 'label' | 'person'>,
  contacts: ReadonlyMap<string, string> | undefined,
  aliases: AliasTable | undefined,
): { source: 'contacts' | 'alias' | 'label' | 'person'; note: string | null } {
  const contact = lookupBySid(contacts, entry.sid);
  if (contact !== undefined) return { source: 'contacts', note: null };
  const alias = lookupAliasBySid(aliases, entry.sid);
  if (alias !== undefined) return { source: 'alias', note: alias.note ?? null };
  return { source: entry.label == null ? 'person' : 'label', note: null };
}

/**
 * 别名表里一条的键**是什么**。
 *
 * 这张表其实记着两类东西，形态不同：
 *   • `sid`（`qq:c2c:<openid>`、`qq:group:<群id>`）——**会话**，用来显示"这是谁/哪个群"；
 *   • `member`（裸 openid）——**群成员**，她的表里单起一段（`# 群成员（openid，不是 sid…）`）。
 *     群成员不是会话（他可能从没私聊过她），而且这一段的**用途是认人**：@ 人时她照它写官方形态
 *     `<qqbot-at-user id="…" />`（docs/design.md §4.20.1），**以及**把裸 id 解析成人名
 *     （见 [resolvePersonNameFromTables] 的第三档）。**名字 → openid 那一跳框架仍然不做**
 *     （2026-10-05 移除，别从这张表倒推 openid）；它对会话别名表也依然是噪音
 *     （见 [parseAliases]）。
 */
export type AliasKeyKind = 'sid' | 'member';

/** 别名表里解析出来的一行（键 + 归类 + 名字/备注） */
export interface AliasRow {
  key: string;
  kind: AliasKeyKind;
  alias: SessionAlias;
}

/**
 * 群成员键的形状：**裸 openid**——没有 `:`，也不含空白、括号、汉字。
 *
 * 为什么要判形状而不是"看它在不在 `# 群成员` 那一段下面"：段标题是她手写的，位置随时会动；
 * 而"裸 openid"这个形状本身就是**不含歧义**的（sid 一定有 `:`，正文里的等号左边不会有这种东西）。
 * 长度下限 8 是为了把 `abc = 1` 这类随手写的行挡在外面。
 */
const MEMBER_KEY_RE = /^[0-9A-Za-z_-]{8,}$/u;

/**
 * 别名表的**唯一**行解析（`parseAliases` 走它）。
 *
 * 一行一条：`<键> = <名字>`（前面的 `-` 或 `*` 随便写，当列表写也行）。键按形状分两类
 * （见 [AliasKeyKind]），**认不出的键一个都不收**——否则 markdown 正文里的等号会被当成别名。
 *
 * **名字后面的括号是备注，不是名字的一部分**（见 [splitAliasNote]）：她实际就是这么写的
 * （模板当初只说"`<sid> = <名字>`"，没写备注该放哪儿，于是她把口径一起写在等号右边），
 * 而读取侧原来把整串当名字，界面那格窄、长文本把光标顶到末尾，人看到的就是备注的尾巴——
 * 像是名字坏了。备注留下来（`note`）给人看，名字只取括号前那一段。
 *
 * 它为什么是**她的资产**而不是框架配置：只有她知道"这串 openid 是谁"——
 * 可能是人告诉她的，也可能是她聊了几次之后认出来的。框架只负责读进来、显示出去。
 */
function forEachAliasRow(text: string, visit: (row: AliasRow) => void): void {
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^[-*]\s*/u, '').trim();
    if (line === '' || line.startsWith('#') || line.startsWith('```')) continue;
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const { name, note } = splitAliasNote(line.slice(at + 1));
    if (name === '') continue;
    const kind: AliasKeyKind | null = key.includes(':')
      ? 'sid'
      : (MEMBER_KEY_RE.test(key) ? 'member' : null);
    if (kind === null) continue;
    visit({ key, kind, alias: note === undefined ? { name } : { name, note } });
  }
}

/**
 * 会话别名（`sid → 名字`）：**只收 sid 那类键**，成员那一段不进这张表。
 *
 * 为什么成员不并进来（2026-10-05）：`parseAliases` 的消费者有六处（联系人显示、关系档案注入、
 * 重放、界面、看门名单），它们问的全是"**这个会话**叫什么"。裸 openid 塞进去对它们是纯噪音
 * （永远匹配不上，还会在界面上多出一排点不开的条目），改口径又要动一批不许动的文件。
 * 那一段的消费点在别处：**认人**走 `parseMemberAliases`（2026-10-11 接上，此前是死信），
 * @ 人时她照它写官方形态（docs/design.md §4.20.1）。这里唯一的职责就是**把它挡在会话表外**
 * （形状判据见 [MEMBER_KEY_RE]）。
 */
export function parseAliases(text: string): Map<string, SessionAlias> {
  const out = new Map<string, SessionAlias>();
  forEachAliasRow(text, (row) => {
    if (row.kind === 'sid') out.set(row.key, row.alias);
  });
  return out;
}

/**
 * 群成员别名（`# 群成员` 那一段的 `裸 id = 名字`）——**只服务"认人"**。
 *
 * 与 {@link parseAliases} **逐字对称**：同一份文件、同一个 [forEachAliasRow] 解析、只挑另一类键。
 * 两张表分开而不是合成一张，是因为它们的**键空间不同**：会话那张的键是 sid（一定含 `:`），
 * 这张的键是平台给的发言人 id（一定不含）——合成一张会让 `resolveNameForSid` 那种"按 sid 查"
 * 的调用方多出一批永远匹配不上的条目（六个消费者全都要改口径）。
 *
 * 消费点**只有一处**：`resolvePersonNameFromTables` 的第三档（见那里的权威顺序）。它**不**参与
 * "名字 → openid"那一跳（2026-10-05 已移除），也不参与任何身份判定。
 */
export function parseMemberAliases(text: string): Map<string, SessionAlias> {
  const out = new Map<string, SessionAlias>();
  forEachAliasRow(text, (row) => {
    if (row.kind === 'member') out.set(row.key, row.alias);
  });
  return out;
}

/**
 * 把等号右边那串拆成**名字**与**备注**：名字 = 第一个 `（` 或 `(` 之前那部分。
 *
 * 四条边界，都按"她那支笔会怎么写"定的：
 *   • 包裹名字的空白与 markdown 粗体标记不算名字（她写 `**甲** = 名字` 这类格式很常见）；
 *   • 没有括号 ⇒ 整串就是名字，`note` 不出现（不是空串：空串与"没写备注"在界面上不该长得一样）；
 *   • 括号前什么都没有（`（纯备注）`）⇒ **整串当名字**，不去括号里猜——猜错就把一条备注
 *     变成了名字，而她写这一行时想要的恰恰相反；
 *   • 只认**第一个**括号：备注里再写括号（`（口径：不聊 A（B））`）时它整段留在备注里，不切第二次。
 */
export function splitAliasNote(raw: string): { name: string; note?: string } {
  const text = raw.trim();
  const at = text.search(/[（(]/u);
  if (at <= 0) return { name: stripNameMarks(text) };
  // 粗体标记在**切完之后**再去：`**甲**（备注）` 的两个 `**` 被括号隔在两段里，
  // 只在整串两端去标记的话，名字会留下一个 `甲**`（实测踩到）
  const name = stripNameMarks(text.slice(0, at));
  if (name === '') return { name: stripNameMarks(text) };
  const note = text.slice(at + 1).replace(/[）)]\s*$/u, '').trim();
  return note === '' ? { name } : { name, note };
}

/** 去掉包裹名字的空白与 markdown 粗体/斜体标记（`**甲**` → `甲`） */
function stripNameMarks(text: string): string {
  return text.trim().replace(/^\*+|\*+$/gu, '').trim();
}

/** 把别名贴到会话条目上（不改原数组；没别名的保持原样） */
export function applyAliases(
  entries: readonly SessionEntry[],
  aliases: AliasTable,
): SessionEntry[] {
  return entries.map((entry) => ({
    ...entry,
    label: aliasNameBySid(aliases, entry.sid) ?? entry.label ?? null,
  }));
}
