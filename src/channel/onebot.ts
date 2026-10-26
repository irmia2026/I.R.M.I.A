/**
 * Irmia Agent — OneBot 11 通道适配器（NapCat / go-cqhttp 等协议端接入，M9）
 *
 * 与 `qq-official.ts` 的关系：**同一个 `ChannelAdapter` 接口、同一份 `wake/channel` 契约**，
 * 差别只在传输与语义：
 *   • QQ 官方走「HTTP 换 token + 官方网关 opcode 状态机 + REST 被动回复（msg_id/msg_seq 窗口）」；
 *   • OneBot 11 走「正向 WebSocket + JSON 动作/响应 + 无被动回复窗口」——连上 NapCat 的
 *     ws 端口即收事件，发消息是同一条连接上的 `{action, params, echo}` 请求/响应。
 *
 * 协议依据（OneBot 11 标准语义，NapCat 与 go-cqhttp 一致的部分）：
 *   • 事件：`post_type==='message'`，`message_type` 为 `private` / `group`；
 *     `raw_message` 是"原始消息（string 形态，含 CQ 码）"，`message` 是消息段数组
 *     （`message_post_format` 也可能是 string 形态的 CQ 码串）；每条事件都带 `self_id`。
 *   • 消息段：`{type:'text', data:{text}}` / `{type:'at', data:{qq}}` / `{type:'image', data:{file,url}}`
 *     / `{type:'file', data:{file,name,url}}`；CQ 码字符串是它的等价写法（`[CQ:at,qq=123]`）。
 *   • 动作：`{action:'send_private_msg', params:{user_id, message}, echo}` 与
 *     `{action:'send_group_msg', params:{group_id, message}, echo}`；响应同一条连接回
 *     `{status, retcode, data, echo}`，`echo` 是配对的唯一凭据，`retcode===0` 为成。
 *   • 鉴权：access_token 校验在**握手**上，服务端认两种形式——`Authorization: Bearer <token>`
 *     或 query `?access_token=`。**内置协议端 SnowLuma 的判据就是这两条**
 *     （`data/services/snowluma/index.mjs` 的 `isAuthorized`：先比 `request.headers.authorization`
 *     是否等于 `Bearer <token>`，再比 `new URL(request.url).searchParams.get('access_token')`；
 *     两条都不是就回 401 `Unauthorized`）。NapCat 同样认 query 形态。
 *     本项目的 ws-client 刻意不留"自定义握手头"的口子（它逐字校验
 *     `Sec-WebSocket-Accept`，头部白名单越窄越好），所以这里一律用 query 形态，
 *     并把 token 从日志里打码（`maskAccessToken`）。
 *
 * 三块职责：
 *   ① 事件解析（纯函数）：事件体 → `wake/channel` 的 data，全部可独立断言；
 *   ② `OneBotClient`：连接状态机（连接 → 事件分发 → 动作/echo 配对 → 断线退避重连）；
 *   ③ `OneBotChannel`：对系统暴露的 `ChannelAdapter`（入站转 wake、出站接 speak 回投）。
 *
 * 两条硬纪律（与官方通道一致，理由相同）：
 *   • **退避计数只在链路真的活了之后清零**：一连上就清零会被"连上就被踢"的坏端口变成 1 秒锤击；
 *   • **发送失败按 retcode 分类**：`1404`（会话不存在）这类是"这条发不出去"而不是"链路坏了"，
 *     不许当成断线去重建连接——那只会把一条逻辑错误放大成一场重连风暴。
 *
 * 约定：值导入写 `.ts`，纯类型导入写 `.js`。
 */

import { randomUUID } from 'node:crypto';

// 值导入写 `.ts`（`--experimental-strip-types` 不重写 `.js`，而这里真的要用那个函数：
// 附件的两个判据是**两条通道共用**的唯一实现，见 log/types.ts 那段注释）
import { isFetchableAttachmentUrl, type WakeChannel } from '../log/types.ts';
import { type ChannelNoticeData } from './self-identity.ts';
import {
  reconnectDelayMs,
  type ChannelAdapter,
  type QqChatType,
  type SendOutcome,
  type SendTextOptions,
} from './qq-official.ts';
import { connect as wsConnect, parseWsUrl, type WsClient, type WsConnectOptions } from './ws-client.ts';
import { sidKindOf } from './sessions.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 通道标识（wake/channel.channel 的取值，也是 dedupeKey 命名空间的前缀来源） */
export const ONEBOT_CHANNEL_NAME = 'onebot';

/** NapCat 正向 ws 的默认端口（协议端默认监听 3001；不写 wsUrl 时用它） */
export const DEFAULT_ONEBOT_WS_URL = 'ws://127.0.0.1:3001';
/** access_token 所在环境变量名（配置里只写变量名，值只在建连时从进程环境读） */
export const DEFAULT_ONEBOT_TOKEN_ENV = 'ONEBOT_ACCESS_TOKEN';
/** 握手 query 里的 token 参数名（NapCat 与 SnowLuma 都认这个键） */
export const ONEBOT_ACCESS_TOKEN_QUERY = 'access_token';

/**
 * 端点重读的**硬下限**（毫秒）：两次真正读盘之间至少隔这么久。
 *
 * 为什么需要它：对接点是**现读现用**的（协议端的配置可能晚于本进程物化，见下面
 * `OneBotEndpointMemo`），而重连退避在小步长那几拍是 1s / 2s / 4s——没有下限的话，
 * "每次建连都重读"就变成了退避期里的高频磁盘 IO，而**读到的内容在 10 秒里根本不会变**
 * （协议端写那份配置是人登录 QQ 触发的，分钟级的事）。
 *
 * 10 秒这个数取的是"比退避的起步档大一档、比它写文件的节奏小一档"：
 * 最坏情况下（1 秒一拍的抖动）每 10 秒一次 `readdir` + 一两次小文件 `readFile`；
 * 而配置真的出现时，最多晚一拍（≤10s）被看见。
 */
export const DEFAULT_ONEBOT_ENDPOINT_REREAD_MS = 10_000;

/** 指数退避起点：1 秒 */
export const DEFAULT_ONEBOT_RECONNECT_BASE_MS = 1_000;
/** 指数退避上限：60 秒（里程碑要求；比官方通道的 5 分钟更急，因为本地协议端通常就在同一台机器上） */
export const DEFAULT_ONEBOT_MAX_RECONNECT_DELAY_MS = 60_000;
/** 读超时兜底：协议端未下发 heartbeat 时的"链路是否还活着"判据 */
export const DEFAULT_ONEBOT_READ_TIMEOUT_MS = 60_000;
/** 动作等待响应的超时（NapCat 的 send_* 是同步返回的，正常在毫秒级） */
export const DEFAULT_ONEBOT_ACTION_TIMEOUT_MS = 15_000;

/** retcode：成功 */
export const ONEBOT_RETCODE_OK = 0;
/** retcode：异步调用已提交（协议端接受了，结果另行通知）——按成功计 */
export const ONEBOT_RETCODE_ASYNC = 1;

/**
 * 「这条发不出去，但链路是好的」的 retcode 集合（OneBot 11 标准错误码）：
 *   100 参数错 / 102 操作失败 / 103 凭证失效 / 104 权限不足 / 1400 无效参数 /
 *   1401 逻辑错误 / 1403 权限不足 / 1404 资源（会话/群）不存在。
 * 命中它们时**不重连、不重试**：重试同一个错误参数只会得到同一个错误，
 * 而"顺手重连"会把一条业务错误升级成链路抖动。
 */
export const ONEBOT_PERMANENT_RETCODES: readonly number[] = [100, 102, 103, 104, 1400, 1401, 1403, 1404];

/** retcode 三分类：成功 / 不可重试 / 可重试（含超时与链路故障） */
export type OneBotRetcodeClass = 'ok' | 'async' | 'permanent' | 'transient';

export function classifyRetcode(retcode: number): OneBotRetcodeClass {
  if (retcode === ONEBOT_RETCODE_OK) return 'ok';
  if (retcode === ONEBOT_RETCODE_ASYNC) return 'async';
  return ONEBOT_PERMANENT_RETCODES.includes(retcode) ? 'permanent' : 'transient';
}

/** 动作失败的原因分类（调用方据此决定"要不要重试/要不要重连"） */
export type OneBotFailureClass = 'permanent' | 'transient' | 'offline';

export interface OneBotLogger {
  info: (line: string) => void;
  warn: (line: string) => void;
}

const SILENT_LOG: OneBotLogger = { info: () => {}, warn: () => {} };

// ──────────────────────────────── 值读取 ────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(source: Record<string, unknown> | null, key: string): string {
  const value = source?.[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(source: Record<string, unknown> | null, key: string): number | null {
  const value = source?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * 读一个「数字或数字字符串」标量并统一成字符串。
 *
 * OneBot 的 id 类字段（user_id / group_id / message_id / self_id）在不同实现里时而数字时而字符串，
 * 而且 int64 在 JS number 上有精度风险——所以**统一按字符串收**，只在出站参数里按需转回数字。
 */
function readScalar(source: Record<string, unknown> | null, key: string): string {
  const value = source?.[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** 消息段 data 的值同样"数字或字符串"混杂；统一成字符串，非标量直接丢掉（不猜测结构） */
function readStringMap(source: unknown): Record<string, string> {
  const record = asRecord(source);
  const out: Record<string, string> = {};
  if (record === null) return out;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = String(value);
    else if (typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ──────────────────────────────── CQ 码与消息段 ────────────────────────────────

export interface OneBotSegment {
  type: string;
  data: Record<string, string>;
}

/**
 * CQ 码的转义表（OneBot 11 标准）：编码顺序是 `&` → `[` → `]` → `,`，
 * 所以解码必须**逆序**做——先处理 `&#44;` 之类再收尾 `&amp;`，
 * 否则 `&amp;#91;`（字面量 "&#91;"）会被误解成左方括号。
 */
export function unescapeCqText(text: string): string {
  return text
    .replace(/&#91;/gu, '[')
    .replace(/&#93;/gu, ']')
    .replace(/&#44;/gu, ',')
    .replace(/&amp;/gu, '&');
}

/**
 * 解析 CQ 码字符串 → 消息段数组。
 *
 * 值里的逗号按规范必须写成 `&#44;`，所以按 `,` 切分参数是安全的；
 * 不为非标准写法做"尽力解析"的妥协（那会让"文本里到底有没有 CQ 码"变成不可判定的问题）。
 */
export function parseCqMessage(raw: string): OneBotSegment[] {
  const pattern = /\[CQ:([A-Za-z0-9_.-]+)((?:,[^\]]*)?)\]/gu;
  const segments: OneBotSegment[] = [];
  let cursor = 0;
  for (;;) {
    const match = pattern.exec(raw);
    if (match === null) break;
    const index = match.index;
    if (index > cursor) {
      const text = unescapeCqText(raw.slice(cursor, index));
      if (text !== '') segments.push({ type: 'text', data: { text } });
    }
    const data: Record<string, string> = {};
    const params = (match[2] ?? '').replace(/^,/u, '');
    if (params !== '') {
      for (const pair of params.split(',')) {
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        data[pair.slice(0, eq).trim()] = unescapeCqText(pair.slice(eq + 1));
      }
    }
    segments.push({ type: (match[1] ?? '').toLowerCase(), data });
    cursor = index + match[0].length;
  }
  if (cursor < raw.length) {
    const text = unescapeCqText(raw.slice(cursor));
    if (text !== '') segments.push({ type: 'text', data: { text } });
  }
  return segments;
}

/**
 * 平台给的昵称/群名片 → `{ nickname }`（没有就一个字段都不给）。
 *
 * 用户 2026-10-02 的口径："群昵称我认为是应该读的，因为有助于快速识别身份。其他太长的 id
 * 反而没意义。" —— 所以昵称要读、要显示（`sender.card` 是这个群里的显示名，优先；
 * 退到 `sender.nickname`）；但它**只是显示**：谁都能把自己改成"用户（OWNER）"，
 * 身份判定永远按 id 走（契约里 `nickname` 的注释与 self-brief 那一段都写着这一条）。
 */
function nicknameOf(event: Record<string, unknown>): { nickname?: string } {
  const sender = asRecord(event['sender']);
  if (sender === null) return {};
  const card = readScalar(sender, 'card');
  const nick = readScalar(sender, 'nickname');
  const value = card !== '' ? card : nick;
  return value === '' ? {} : { nickname: value };
}


export function toSegments(message: unknown): OneBotSegment[] {
  if (typeof message === 'string') return parseCqMessage(message);
  if (!Array.isArray(message)) return [];
  const out: OneBotSegment[] = [];
  for (const item of message) {
    const record = asRecord(item);
    if (record === null) continue;
    const type = readString(record, 'type');
    if (type === '') continue;
    out.push({ type, data: readStringMap(record['data']) });
  }
  return out;
}

/** 消息段里的纯文本（只取 text 段：@、图片、表情都不属于"对我说的话"） */
export function textOfSegments(segments: readonly OneBotSegment[]): string {
  let out = '';
  for (const segment of segments) {
    if (segment.type === 'text') out += segment.data['text'] ?? '';
  }
  return out;
}

/** CQ 码字符串 → 纯文本（剥掉所有码，只留文字） */
export function stripCqCodes(raw: string): string {
  return textOfSegments(parseCqMessage(raw));
}

/** 非文本类附件段（文本已剥离，它们是"平台上还带了什么"，供上层渲染与必要判断） */
const ATTACHMENT_SEGMENTS: readonly string[] = ['image', 'file', 'video', 'record'];

/**
 * 段类型**就是**给上层的附件类型：OneBot 这边不发明第二种写法。
 *
 * 为什么不在这里把它翻成 MIME（`image` → `image/png`）：段类型是协议事实，而 MIME 是
 * 猜的——`image` 段没有画质信息，`record` 可能是 silk / amr，翻出来的每一个 MIME 都可能是假的。
 * 于是"这是不是一张图"这个判定交给 `isImageAttachment`（两种形态都认），
 * 它只认形态、不认来源，两条通道因此走同一个判据。
 */
function attachmentsOf(segments: readonly OneBotSegment[]): WakeChannel['data']['attachments'] {
  const out: Array<{ type: string; url?: string; name?: string; text?: string }> = [];
  for (const segment of segments) {
    if (!ATTACHMENT_SEGMENTS.includes(segment.type)) continue;
    const rawUrl = segment.data['url'] ?? '';
    const file = segment.data['file'] ?? '';
    // image 段的 url 常常缺席而 file 只是协议端那边的本地文件名：只把**真取得到东西**的
    // 地址当 URL 收下（http(s) / file / data），不然模型会拿到一个点不开的假地址。
    const url = rawUrl !== '' ? rawUrl : (isFetchableAttachmentUrl(file) ? file : '');
    const name = segment.data['name'] ?? file;
    // 语音转写：协议端若在 `record` 段里给了文字（部分实现带 `text` 字段），原样带上——
    // 平台已经替她把这句听成字了，丢掉等于"她少一种听懂的方式"（官方通道的 `asr_refer_text` 同理）。
    // **未核实**：SnowLuma / NapCat 是否真的下发这个字段（本机没有任何语音事件样本）；
    // 有就带上，没有这条线是空的、不会伪造。
    const transcript = segment.data['text'] ?? '';
    out.push({
      type: segment.type,
      ...(url === '' ? {} : { url }),
      ...(name === '' ? {} : { name }),
      ...(transcript === '' ? {} : { text: transcript }),
    });
  }
  return out.length === 0 ? undefined : out;
}

/** 该消息是否 @ 了机器人（`qq=all` 的 @全体不算：它是发给所有人的，不是对她说的话） */
export function mentionsSelf(segments: readonly OneBotSegment[], selfId: string): boolean {
  if (selfId === '') return false;
  return segments.some((segment) => segment.type === 'at' && segment.data['qq'] === selfId);
}

/**
 * 这条消息里被引用的那条是哪一条（OneBot 的 `reply` 段，`data.id` 是 message_id）。
 *
 * 为什么只拿得到 id：OneBot 的 reply 段**不给被引正文**（官方那条路给，所以官方能做成
 * `[引用 原话] ` 前缀）。要拿正文得回头查本地日志里那条 message_id——那要往适配器里塞一个
 * 日志查询口，代价与收益不成比例（见报告 §3.5 的两条路）。这里取 (b)：把"这是回复哪一条"
 * 如实写进前缀，信息量低但零成本，而且**形状与官方一致**（`injection.ts` 的 `speakerWordsOf`
 * 按 `[引用…]` 开头整块剥掉——被引的那句常常是她自己刚说的，用她自己的话给她定罪是另一类错）。
 */
export function replyIdOf(segments: readonly OneBotSegment[]): string {
  for (const segment of segments) {
    if (segment.type !== 'reply') continue;
    const id = (segment.data['id'] ?? '').trim();
    if (id !== '') return id;
  }
  return '';
}

// ──────────────────────────────── 事件 → channel/notice ────────────────────────────────

/**
 * `post_type === 'notice'` 的事件 → `channel/notice` 的载荷（不适用/形状不全的返回 null）。
 *
 * ──────────────────────────── 为什么要有这条路（2026-10-11） ────────────────────────────
 *
 * 原先 `dispatch` 对非 message 的事件**只记一行日志就丢**，于是这类事实整条链不存在：
 * 别人开了全员禁言、有人被踢、有人撤回——她读那个群时一个字都看不到（诊断报告 §3：
 * `notice` 在全部事件里 0 命中，`channel/notice` 这类事件根本不存在）。
 *
 * ──────────────────────────── 字段口径（哪一格是谁，别串） ────────────────────────────
 *
 * OneBot 11 的 notice 里，**同名的 `user_id` 在不同类别里指的可能是不同的人**：
 *   • `group_ban`：`user_id` = **被禁言的人**，`operator_id` = 谁禁的（协议端可能不给）；
 *   • `group_admin` / `group_increase` / `group_decrease` / `group_recall`：`user_id` = **当事人**，
 *     `operator_id` = 操作者（撤回那条里"管理员撤别人的话"就靠这两个不同判出来）。
 * 所以这里把两者分开成 `targetId` / `actorId`：渲染时"谁被禁"与"谁禁的"是两个人。
 *
 * `duration` 是**秒**（OneBot 的 `set_group_ban` 就是秒）；`0` 是有效的协议值
 * （全员禁言那一路），所以判"有没有给"只能用 `undefined`，不许用真假。
 *
 * 形状不全（没有 `notice_type` / 定位不到会话）⇒ 返回 null，**宁可丢也不伪造**
 * （与消息那条纪律逐字相同：没有 message_id 的消息也一律丢）。
 */
export function noticeDataOf(
  event: Record<string, unknown>,
  context: { selfId?: string; channelName?: string } = {},
): ChannelNoticeData | null {
  const noticeType = readString(event, 'notice_type');
  if (noticeType === '') return null;
  const channel = context.channelName ?? ONEBOT_CHANNEL_NAME;
  const subType = readString(event, 'sub_type');
  // 除了 group_* 那几种，其余都是"谁跟谁之间的事"：friend_recall / friend_add / notify
  const feedId = readScalar(event, 'friend_id') || readScalar(event, 'user_id');
  const groupId = readScalar(event, 'group_id');
  const chatType: ChannelNoticeData['chatType'] = groupId === '' ? 'c2c' : 'group';
  const chatId = groupId !== '' ? groupId : feedId;
  // 定位不到会话的动静**归不到任何一屏**（read_channel 是按会话读的）⇒ 丢掉，不落一条孤儿事件
  if (chatId === '') return null;

  const selfId = readScalar(event, 'self_id') || (context.selfId ?? '');
  // `request` 那一类的主键是 `request_type`（friend / group），子类另有 `sub_type`；
  // 两条都留着容易串，所以统一进 `subType`，`noticeType` 保留协议原样 `request`。
  const effectiveSub = noticeType === 'request' ? readString(event, 'request_type') : subType;

  const duration = readNumber(event, 'duration');
  /**
   * `notice` 里**只有 id、没有昵称**（OneBot 标准语义）⇒ 名字靠既有真源现查（渲染那一步）。
   * 这里把平台原样给的字符串**照收不误**，一个字都不改：`detail` 是渲染层唯一能拿到
   * "平台到底说了什么"的地方（比如改名片那条的 `card_new`）。
   */
  const detail: Record<string, string> = {};
  for (const key of NOTICE_DETAIL_KEYS) {
    const value = readString(event, key);
    if (value !== '') detail[key] = value;
  }

  return {
    channel,
    chatId,
    chatType,
    noticeType,
    ...(effectiveSub === '' ? {} : { subType: effectiveSub }),
    ...(selfId === '' ? {} : { selfId }),
    ...(readScalar(event, 'operator_id') === '' ? {} : { actorId: readScalar(event, 'operator_id') }),
    /**
     * 当事人。**大多数类别里是 `user_id`**（被禁言/被设管理员/入群的人）；
     * 例外是 `group_upload`——那一条里 `user_id` 是**上传的人**（没有单独的 operator），
     * 所以它同时当 actor 用（渲染那边就按"某人 上传了群文件"写，不另编一个字段）。
     */
    ...(readScalar(event, 'user_id') === '' ? {} : { targetId: readScalar(event, 'user_id') }),
    ...(duration === null ? {} : { durationSec: duration }),
    ...(readScalar(event, 'message_id') === '' ? {} : { messageId: readScalar(event, 'message_id') }),
    ...(groupId === '' ? {} : { groupId }),
    ...(Object.keys(detail).length === 0 ? {} : { detail }),
  };
}

/**
 * 进 `detail` 的那几个原样字符串字段（**只收已知有用的**，不做通配搬运）。
 *
 * 为什么不通通收下：`detail` 会随事件落盘、每次 `read_channel` 翻到都要读。
 * 把整个 notice 抄进去既没有判据价值，也把协议端的自由发挥带进了我们的日志。
 */
const NOTICE_DETAIL_KEYS = ['card_new', 'card_old', 'honor_type', 'file_name', 'target_id'] as const;

// ──────────────────────────────── 事件 → wake/channel ────────────────────────────────

export interface OneBotEventContext {
  /** 机器人自身 QQ 号：事件里没有 self_id 时用缓存值补齐 */
  selfId?: string;
  /** 事件里写的通道名（默认 onebot；测试可用别名区分多实例） */
  channelName?: string;
  /**
   * 这条回复的**是不是她自己说过的话**——调用方给得出就给（判据是本地那份已发消息 id 表，
   * 见 `OneBotChannel.sendText`）。给不出时按"不是回复她"处理（少登记一个人，比错登记好）。
   */
  isReplyToSelf?: (replyId: string) => boolean;
}

/**
 * 事件体 → `wake/channel` 的 data（不适用的返回 null，调用方据此忽略）。
 *
 * 文本口径：`raw_message` 在 string 形态下是**含 CQ 码的原文**，直接透传会把协议码喂给模型，
 * 所以两条来源都先剥码再取用——`raw_message` 剥完非空就用它（它是协议的权威原文），
 * 否则退回消息段里的 text 拼接（对端没给 raw_message 时的等价来源）。
 *
 * 群消息必须是"@ 了机器人"才唤醒：没 @ 的群消息是别人的对话，把她拖进去等于噪声。
 * 拿不到 self_id 时**宁可丢**——"猜自己是不是被 @"必然猜错一部分。
 */
export function mapEventToWakeChannel(
  event: Record<string, unknown>,
  context: OneBotEventContext = {},
): WakeChannel['data'] | null {
  if (readString(event, 'post_type') !== 'message') return null;
  const messageType = readString(event, 'message_type');
  if (messageType !== 'private' && messageType !== 'group') return null;

  const messageId = readScalar(event, 'message_id');
  // 没有 message_id 就没有幂等键：宁可丢也不伪造（与官方通道同一条纪律）
  if (messageId === '') return null;
  const person = readScalar(event, 'user_id');
  if (person === '') return null;

  const segments = toSegments(event['message']);
  const rawMessage = readString(event, 'raw_message');
  const fromRaw = rawMessage === '' ? '' : stripCqCodes(rawMessage).trim();
  const body = fromRaw !== '' ? fromRaw : textOfSegments(segments).trim();
  const attachments = attachmentsOf(segments);
  const channelName = context.channelName ?? ONEBOT_CHANNEL_NAME;

  /**
   * "这一条是不是在叫她" —— **如实填**（2026-10-07 对齐官方通道时补的）。
   *
   * 原先这个字段**从不填**，后果不是"少一个标志"，是整条链断掉：
   * `real-loop.ts` 的 `registerGroupMembers`（群成员档案）**唯一入口**就是
   * `data.mentionsMe === true`——官方每条 `GROUP_AT_MESSAGE_CREATE` 都填，OneBot 一条不填，
   * 于是 OneBot 群里 @ 过她的人在档案里**一个都不出现**，她问"甲是谁"时框架给不出名字。
   *
   * 判据两条，都是协议事实、不做推测：
   *   ① `at` 段里就是她的 `self_id`（→ `group-at`）——与官方那条同一语义；
   *   ② 这条消息**回复的是她自己发的那条**（`reply` 段的 id 在本地已发消息表里）。
   *      为什么这条也算：@ 与"接着她那句说下去"在群里是同一件事的两种形态，而 OneBot 的 `reply`
   *      是唯一能判出来的形态。**判不出就不填**——`self_id` 缺失时宁可当"没叫她"（少登记一个人，
   *      比把满群闲话的人都灌进档案好）。
   * 关键词那一层不在这里：它在 `main.ts`（`mentionsKeyword`），宿主在落库前补同一个字段。
   */
  let chatType: WakeChannel['data']['chatType'];
  let chatId: string;
  let mentionsMe = false;
  let quotedPrefix = '';
  if (messageType === 'private') {
    chatType = 'c2c';
    chatId = person;
    /**
     * **私聊里的引用也解析**（2026-10-12 修的不对称，只读、零风险）。
     *
     * 原来这个前缀只在**群**那一支里生产（下面 `else` 那一段），私聊一个字都不解析——
     * 于是同一条 `reply` 段，在群里读得出"这是回复哪一条"、在私聊里**凭空消失**。
     * 而协议这一层根本没有"私聊不给 `reply` 段"这回事：`segments` 是从事件体里统一解析出来的
     * （`toSegments`），`replyIdOf` 只按段类型找 `reply`，**两条路拿到的是同一份东西**——
     * 差别只在下面这个 `if` 把它写不写进前缀。
     *
     * 为什么这件事对私聊**更**要紧：私聊是点对点，人引用她上一句时，"这是回复哪一条"是
     * 那条消息**唯一**的结构化线索（群里还有 @ 与昵称可当旁证）。丢了它，她读到的就是一句
     * 没头没尾的话——与官方门那条 2026-10-02 的缺口报告第 ④ 项是同一类病
     *（"这个不行"到底指哪个？）。
     *
     * `mentionsMe` **刻意不在这里填**：私聊的 `chatType` 恒为 `c2c`，而分流判据
     *（`channel/inbox.ts`）对 `c2c` 的第一条就是"无条件进唤醒"——引用判不出来也不影响
     * 她读得到它。给 c2c 填一个 `mentionsMe` 只会给同一个事实造出第二种说法
     *（`self-brief` 的 `renderMentionNote` 对 c2c 一律返回 null，本来就当它没有意义）。
     */
    const replyId = replyIdOf(segments);
    if (replyId !== '') quotedPrefix = `[引用 #${replyId}] `;
  } else {
    chatId = readScalar(event, 'group_id');
    if (chatId === '') return null;
    /**
     * 群里的话分两种，**没 @ 她的那条不再丢掉**。
     *
     * 协议端（NapCat / Lagrange 这类走客户端协议的）**会推全量群消息**——群里谁说什么它都给。
     * （**2026-10-02 更正**：官方 Bot API 在平台侧开了「接收所有消息」之后同样推全量群消息——
     * `GROUP_MESSAGE_CREATE` 与 @ 消息是同一个订阅位，见 design.md §4.24。所以"只有协议端拿得到
     * 全量"这个旧说法是错的；这里以前对没 @ 的一律 `return null`，代价是把白送的能力扔掉，
     * 也让"信箱"（`channel/message`、未读、话题、`read_channel`）永远收不到东西。）
     *
     * 现在的分工与官方通道一致：**@ 她的**标 `group-at`（唤醒她），**其余**标 `group`
     * （进信箱：只记账、算未读，她想知道再翻）。分流在 `channel/inbox.ts` 里判。
     *
     * `self_id` 拿不到时**按"没 @ 她"处理**（不是丢弃）：判不出是不是叫她，那就当群里的一句闲话——
     * 少叫醒她一次，比把整条消息扔掉好；而且这条消息在会话清单里仍然看得到。
     */
    const selfId = readScalar(event, 'self_id') || (context.selfId ?? '');
    const atSelf = selfId !== '' && mentionsSelf(segments, selfId);
    const replyId = replyIdOf(segments);
    const replyToSelf = replyId !== '' && (context.isReplyToSelf?.(replyId) ?? false);
    // 被回复的是她自己那句：**叫她的另一种形态**，于是它从信箱提成唤醒。
    // 这一侧是刻意的（用户 2026-10-07 的判据："被 @ / 被回复 / 群里点到她"都算在叫她）；
    // 判不出来时（本地表里没有这个 id）什么都不改——宁可少叫一次。
    chatType = atSelf || replyToSelf ? 'group-at' : 'group';
    mentionsMe = atSelf || replyToSelf;
    // 被引用的那句**只拿得到 id**（OneBot 的 reply 段不给正文）：如实写成前缀，
    // 她至少知道"这是回复哪一条"。形状与官方的 `[引用 …] ` 同族——`speakerWordsOf` 按
    // `[引用…]` 开头整块剥掉（被引的常是她自己刚说的那句，不许拿去给她定罪）。
    //
    // ⚠ 这里**只做"谁引用了她"这一层**（`replyToSelf` 是提成唤醒的判据）——前缀本身
    // 私聊那一支也会生产了（2026-10-12，见上面 `if (messageType === 'private')` 里那段）。
    // 两处生产的是**同一个形态**：判据仍然只有 `replyIdOf` 一处。
    if (replyId !== '') quotedPrefix = `[引用 #${replyId}] `;
  }

  return {
    channel: channelName,
    chatType,
    person,
    // 平台给的昵称/群名片（`sender.card` 优先——那是这个群里的显示名，最便于认人）。
    // **只用于显示**：身份永远按 id 判（见 self-brief"名字不是身份"那一段）。
    ...nicknameOf(event),
    chatId,
    text: `${quotedPrefix}${body}`,
    messageId,
    // 协议给了 `message_seq` 就照它记（那是平台自己的编号）；没给就是 0，由宿主在落库那一刻
    // 补成事件 seq（规则见 `channel/inbox.ts` 的 `msgSeqOf`：唤醒那条与信箱那条用的是同一个数，
    // 否则"这一条你还没看过"对唤醒那条**永远判错**——见报告 §3.4）。
    msgSeq: readNumber(event, 'message_seq') ?? 0,
    ...(attachments === undefined ? {} : { attachments }),
    // `mentionsMe` 只在**真的是**的时候出现：一个恒假的字段会把"给得出就填"这条纪律变成噪音，
    // 而且它会进事件载荷——能不带就不带。
    ...(mentionsMe ? { mentionsMe: true } : {}),
    dedupeKey: `${channelName}:${messageId}`,
  };
}

// ──────────────────────────────── 读超时与握手地址 ────────────────────────────────

/**
 * heartbeat 的 interval（毫秒）→ 读超时。
 *
 * 取 3 倍宽限：协议端的 heartbeat 本身可能晚一拍，读超时贴着 interval 会在网络抖动时误判断线
 * （误判的代价是一次完整重连，比晚几秒发现真断线的代价大）。下限 15 秒，避免对端配了个
 * 很小的 interval 就把读超时压到"每几秒重连一次"。
 */
export function heartbeatToReadTimeoutMs(intervalMs: number): number {
  return Math.max(15_000, Math.trunc(intervalMs) * 3);
}

/** 把 access_token 拼进握手 query（ws-client 不支持自定义握手头，见文件头说明） */
export function buildConnectUrl(wsUrl: string, accessToken: string): string {
  const parsed = parseWsUrl(wsUrl);
  if (!parsed.ok) throw new Error(`OneBot wsUrl 非法：${parsed.error}`);
  if (accessToken === '') return wsUrl;
  const url = new URL(wsUrl);
  url.searchParams.set(ONEBOT_ACCESS_TOKEN_QUERY, accessToken);
  return url.toString();
}

/** 日志里的地址：token 必须打码（它会随日志落盘，等于把网关凭据抄进文件） */
export function maskAccessToken(url: string): string {
  return url.replace(
    new RegExp(`([?&]${ONEBOT_ACCESS_TOKEN_QUERY}=)[^&]*`, 'u'),
    '$1***',
  );
}

/** chatId → 出站 id：纯数字且在安全整数内就给 number（NapCat 两种都收），其余原样发字符串 */
export function oneBotIdOf(chatId: string): number | string {
  if (!/^-?\d+$/u.test(chatId)) return chatId;
  const value = Number(chatId);
  return Number.isSafeInteger(value) ? value : chatId;
}

// ──────────────────────────────── 出站媒体 ────────────────────────────────

/**
 * 要发的一个媒体：与官方通道的 `QqMediaInput` **同一套形态**
 * （`fileType` 的四个值同源：1 图 / 2 视频 / 3 语音 / 4 文件）。
 *
 * 这里不 import 官方那个类型：`onebot.ts` 对 `qq-official.ts` 只取接口与工厂（见文件头），
 * 而"媒体是什么"是工具层的产物（`MediaRequest`），两条通道各自翻译自己的那一份。
 */
export interface OneBotMediaInput {
  fileType: 1 | 2 | 3 | 4;
  /** 网络地址（与 `data` / `path` 三选一） */
  url?: string;
  /** 本机字节（宿主读了文件之后给）——按 `base64://` 交给协议端 */
  data?: Uint8Array;
  /** 本机路径（文件类走 `upload_*_file` 时需要） */
  path?: string;
  name?: string;
}

/** 四类媒体在 OneBot 里的两种出站形态：消息段 / 群文件上传 */
const MEDIA_SEGMENT_TYPES: Readonly<Record<number, string>> = {
  1: 'image',
  2: 'video',
  3: 'record',
};

export type OneBotMediaCall =
  | {
    ok: true;
    action: string;
    params: Record<string, unknown>;
    /** 这条动作的响应里带不带 `message_id`（文件上传那条不带，它回 `file_id`） */
    returnsMessageId: boolean;
  }
  | { ok: false; reason: string };

/**
 * 媒体 → OneBot 动作（**纯函数**：不碰网络、不读文件，所以每条形态都能单独断言）。
 *
 * 为什么单独拆出来：这是"OneBot 上到底发不发得出去媒体"的**全部判据**所在
 * （动作名、参数名、段类型、来源形态）。留在 `sendMediaTo` 里就得开一条真连接才测得到，
 * 而这条链最缺的恰恰是"构造对不对"的用例（现场那条通道此刻收不到事件，见报告 §3.1）。
 *
 * 两类形态的来路（**未实测**，判据读自协议端产物 `data/services/snowluma/`，见提交说明）：
 *   • **消息段**（图 / 视频 / 语音）：`send_group_msg` / `send_private_msg` 的 `message`
 *     收段数组，段的 `file` 可以是 `base64://` 或 http(s) 地址；
 *   • **群文件 / 私聊文件**（`kind:'file'`）：走 `upload_group_file` / `upload_private_file`——
 *     OneBot 11 里这两条是**独立动作**，不是消息段（协议端的 `file` 段只承接**入站**的
 *     收文件通知）。所以文件那条**要求本机路径**：网络地址要发文件，得先下载到本地
 *     （那是调用方的事，这里如实报"给不了路径"而不是发一个协议端认不出的段）。
 */
export function oneBotMediaCall(
  isGroup: boolean,
  chatId: string,
  media: OneBotMediaInput,
): OneBotMediaCall {
  const name = (media.name ?? '').trim();
  const url = (media.url ?? '').trim();
  if (media.fileType === 4) {
    const path = (media.path ?? '').trim();
    if (path === '') {
      return {
        ok: false,
        reason: 'OneBot 发文件走的是"上传文件"那条动作，要一个本机路径'
          + '（网络来的文件请先下载到本地再发）',
      };
    }
    const params: Record<string, unknown> = isGroup
      ? { group_id: oneBotIdOf(chatId), file: path }
      : { user_id: oneBotIdOf(chatId), file: path };
    if (name !== '') params['name'] = name;
    return {
      ok: true,
      action: isGroup ? 'upload_group_file' : 'upload_private_file',
      params,
      returnsMessageId: false,
    };
  }

  const segmentType = MEDIA_SEGMENT_TYPES[media.fileType];
  if (segmentType === undefined) {
    return { ok: false, reason: `OneBot 不认识这种媒体类型：${String(media.fileType)}` };
  }
  const file = url !== '' ? url : (media.data === undefined ? '' : `base64://${Buffer.from(media.data).toString('base64')}`);
  if (file === '') {
    return { ok: false, reason: '这条媒体既没有网络地址也没有字节，发不出去' };
  }
  const segment: Record<string, unknown> = { type: segmentType, data: { file } };
  // 视频段带个 `name`：协议端要用它给文件起名（图片/语音不需要，多给一个字段只是噪音）
  if (name !== '' && segmentType === 'video') {
    (segment['data'] as Record<string, unknown>)['name'] = name;
  }
  return {
    ok: true,
    action: isGroup ? 'send_group_msg' : 'send_private_msg',
    params: isGroup
      ? { group_id: oneBotIdOf(chatId), message: [segment] }
      : { user_id: oneBotIdOf(chatId), message: [segment] },
    returnsMessageId: true,
  };
}

// ──────────────────────────────── 端点重读（缓存 + 失效） ────────────────────────────────

/** 一次建连要用的对接点：地址 + 凭据（`accessToken` 空串 = 协议端没开校验） */
export interface OneBotEndpoint {
  wsUrl: string;
  accessToken: string;
}

/**
 * 对接点的缓存：**只在"要建连"这一刻读盘，两次读盘之间隔着一个硬下限**。
 *
 * 为什么需要"现读现用"而不是装配时读一次（这是本文件里唯一一条为了排障而存在的机制）：
 * 内置协议端（SnowLuma）的 OneBot 配置是**人登录 QQ 之后**才物化到盘上的，而框架进程可能
 * 比它先起（实测现场就是这样：进程 01:58 起来时 `config/onebot.json` 还不存在）。
 * 装配时读一次、读不到就固化成"没有 token"的后果不是"晚一点连上"，而是**永远连不上**：
 * 适配器此后每一拍都拿着空 token 去敲一个随机生成了 access_token 并开着校验的端口，
 * 表现是 401 + 无限重连，日志里只有"升级被拒"，看不出根因是"配置读早了"。
 *
 * 三条规则（都在 `current()` 里，顺序就是优先级）：
 *   ① 从来没读过 ⇒ 读一次；
 *   ② 距上次读盘不到 `rereadMs` ⇒ **直接用缓存，哪怕它已经被判失效**（硬下限，见
 *      `DEFAULT_ONEBOT_ENDPOINT_REREAD_MS`）；
 *   ③ 距上次读盘够久，且**没有失效理由** ⇒ 复用（链路活着的时候一次盘都不读）。
 *
 * 失效理由只有一条：`invalidate()`——上一次建连失败了（连不上 / 握手被拒 / 刚连上就断）。
 * **"读不出来"从来不是"该猜一个端口"的理由**：`read` 给 null 就如实返回 null，
 * 由调用方回落到它自己那份配置（配置是人写的，猜不是）。
 */
export class OneBotEndpointMemo {
  private readonly read: () => OneBotEndpoint | null;
  private readonly now: () => number;
  private readonly rereadMs: number;

  /** 上一次读盘得到的结论（null = 那一刻读不出来） */
  private value: OneBotEndpoint | null = null;
  /** 有没有读过盘（区分"读过、结论是 null"与"还没读过"） */
  private resolved = false;
  private lastReadAt = 0;
  /** 手里的结论还能不能信（true = 下次建连要重读） */
  private dirty = true;
  private readCount = 0;

  constructor(options: {
    /** 真去读一次（给 `readEndpointFromConfig` 这类函数；返回 null 表示这一刻读不出来） */
    read: () => OneBotEndpoint | null;
    /** 时钟（测试注入；默认 `Date.now`） */
    now?: () => number;
    /** 硬下限（毫秒，默认 `DEFAULT_ONEBOT_ENDPOINT_REREAD_MS`；0 = 不设下限，测试用） */
    rereadMs?: number;
  }) {
    this.read = options.read;
    this.now = options.now ?? ((): number => Date.now());
    this.rereadMs = Math.max(0, options.rereadMs ?? DEFAULT_ONEBOT_ENDPOINT_REREAD_MS);
  }

  /** 建连前的问法：这一刻该用的对接点（读不出来就是 null）。可能读盘 */
  current(): OneBotEndpoint | null {
    if (this.resolved) {
      const since = this.now() - this.lastReadAt;
      if (since < this.rereadMs) return this.value;
      if (!this.dirty) return this.value;
    }
    this.resolved = true;
    this.lastReadAt = this.now();
    this.readCount += 1;
    this.value = this.read();
    this.dirty = false;
    return this.value;
  }

  /**
   * 只报"手里这份是什么"，**绝不读盘**。
   *
   * 给状态查询用：界面每次轮询都会问一次"适配器想连哪儿"，而磁盘 IO 不该长在轮询路径上。
   * 没读过盘时给 null（调用方回落到构造时那份配置，与建连时的回落同一个口径）。
   */
  peek(): OneBotEndpoint | null {
    return this.resolved ? this.value : null;
  }

  /**
   * 让手里的结论作废：**下一次建连必须重读**（仍受硬下限约束）。
   *
   * 调用点是"上一次尝试失败了"——那正是"手里这份可能已经过时"的唯一证据
   * （协议端刚把配置写下来、换了端口、换了 token，或刚从重启里回来）。
   */
  invalidate(): void {
    this.dirty = true;
  }

  /** 读过几次盘（观测与测试用） */
  get reads(): number {
    return this.readCount;
  }
}

// ──────────────────────────────── 动作调用 ────────────────────────────────

export type OneBotActionResult =
  | { ok: true; retcode: number; data: Record<string, unknown> | null }
  | { ok: false; retcode: number | null; klass: OneBotFailureClass; reason: string };

interface PendingCall {
  action: string;
  resolve: (result: OneBotActionResult) => void;
  timer: unknown;
}

interface TimerHandle { id: unknown }

// ──────────────────────────────── 连接状态机 ────────────────────────────────

export interface OneBotClientOptions {
  /** 协议端正向 ws 地址（如 ws://127.0.0.1:3001） */
  wsUrl: string;
  /** access_token（空串表示协议端未开校验）；只进握手 query，不进日志 */
  accessToken?: string;
  /**
   * 端点重读口（可选，v37 起给内置协议端用）：给了它，**每次建连之前**都问一次
   * "现在该连哪儿、带什么 token"，读到就压过上面那两个字段。
   *
   * 返回 null = "这一刻读不出来"：那时回落到 `wsUrl` / `accessToken`（人写在配置里的那份）。
   * 实现见 `OneBotEndpointMemo`（读盘频率与失效条件都在那里）。
   */
  resolveEndpoint?: () => OneBotEndpoint | null;
  /** 端点重读的硬下限（毫秒，默认 `DEFAULT_ONEBOT_ENDPOINT_REREAD_MS`；测试用） */
  endpointRereadMs?: number;
  /** 事件里写的通道名（默认 onebot） */
  channelName?: string;
  /** 连接工厂覆盖点（测试注入本地假协议端） */
  connect?: (url: string, options: WsConnectOptions) => Promise<WsClient>;
  /** 读超时（毫秒）：连续这么久没收到任何帧即判链路已死 */
  readTimeoutMs?: number;
  reconnectBaseMs?: number;
  maxReconnectDelayMs?: number;
  actionTimeoutMs?: number;
  closeTimeoutMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  log?: OneBotLogger;
  /** 收到 `wake/channel` 数据（已转成事件形状）时的落地口 */
  onWake: (data: WakeChannel['data']) => void;
  /**
   * 收到 `notice` 事件（已转成 `channel/notice` 形状）时的落地口。
   *
   * 与 `onWake` **刻意是两个口**：notice 不是"叫她"的那条路（它不唤醒、不进消息流），
   * 混进 `onWake` 就等于让它走一遍唤醒分流——那是"群里有人撤回了一条消息"把她叫醒一次，
   * 显然不是要的东西。宿主那边它也落成**另一种事件**（`channel/notice`，见 main.ts）。
   *
   * 没接线 = 这一路整条不落（与 notice 之前的现状逐字相同，不静默改行为）。
   */
  onNotice?: (data: ChannelNoticeData) => void;
  /**
   * 某个 message_id 是不是**她自己发出去的**那条（给了才判得出"被回复=在叫她"）。
   *
   * 为什么由上面那层给：这份表只有真正发过消息的一方有（`OneBotChannel.sendText` 拿回了
   * 协议端的 `message_id`）。客户端自己不维护它——那是"她说过什么"，属于会话状态，不属于链路。
   */
  isSentMessageId?: (id: string) => boolean;
  /**
   * **学到"我自己是谁"了**（机器人 QQ 号）——运行期回调，可以调多次，宿主按去重处理。
   *
   * 两个触发点：`dispatch` 里事件自带的 `self_id`（协议端每条事件都带），以及
   * `get_login_info` 的兜底结果。**必须回调到宿主**，不能只留在客户端里：
   * 判据（这条消息是不是我自己发的）在宿主那一处，而它建判据的时刻早于本客户端认识自己
   * （2026-10-11 修的"改了等于没改"那处缺陷就是这条线断了）。
   */
  onSelfId?: (id: string) => void;
}

/**
 * OneBot 正向 ws 客户端：收事件、发动作、按 echo 配对、断线退避重连。
 *
 * 与 `QqGateway` 的关键差别只有一处：**没有 opcode 状态机**。OneBot 的动作与事件共用一条连接，
 * 配对靠 `echo`——所以每个动作发出去前先登记 echo，收到的 JSON 先查 echo 再当事件处理。
 */
export class OneBotClient {
  private readonly options: OneBotClientOptions;
  private readonly log: OneBotLogger;
  private readonly timeout: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeout: (handle: unknown) => void;
  private readonly connectFn: (url: string, options: WsConnectOptions) => Promise<WsClient>;

  private client: WsClient | null = null;
  private started = false;
  private stopping = false;
  private ready = false;

  private selfId = '';
  private reconnectTimer: TimerHandle | null = null;
  private reconnectAttempts = 0;
  private actionSeq = 0;
  private readTimeoutMs: number;

  private readonly pending = new Map<string, PendingCall>();
  private incomingCount = 0;
  private actionCount = 0;
  /** 落成 `channel/notice` 的条数（观测用；"协议端推没推 notice"看它最直接） */
  private noticeCount = 0;

  /**
   * 端点缓存（`resolveEndpoint` 给了才有）。
   *
   * 它同时服务两件事：建连前"该连哪儿"（`current()`，可能读盘）与状态查询
   * "手里这份是什么"（`peek()`，绝不读盘）。
   */
  private readonly endpointMemo: OneBotEndpointMemo | null;

  constructor(options: OneBotClientOptions) {
    this.options = options;
    this.log = options.log ?? SILENT_LOG;
    this.timeout = options.setTimeoutFn ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.clearTimeout = options.clearTimeoutFn ?? ((handle) => {
      if (handle !== null && handle !== undefined) clearTimeout(handle as NodeJS.Timeout);
    });
    this.connectFn = options.connect ?? wsConnect;
    this.readTimeoutMs = options.readTimeoutMs ?? DEFAULT_ONEBOT_READ_TIMEOUT_MS;
    const resolveEndpoint = options.resolveEndpoint;
    this.endpointMemo = resolveEndpoint === undefined ? null : new OneBotEndpointMemo({
      read: resolveEndpoint,
      ...(options.endpointRereadMs === undefined ? {} : { rereadMs: options.endpointRereadMs }),
    });
  }

  /** 可观测状态（测试与 CLI 状态页用；不含 token） */
  snapshot(): {
    connected: boolean; selfId: string; reconnectAttempts: number;
    pendingCalls: number; incomingCount: number; actionCount: number; noticeCount: number;
  } {
    return {
      connected: this.client !== null && this.client.isOpen,
      selfId: this.selfId,
      reconnectAttempts: this.reconnectAttempts,
      pendingCalls: this.pending.size,
      incomingCount: this.incomingCount,
      actionCount: this.actionCount,
      // 落成 channel/notice 的条数：协议端**到底推没推** notice，看这一个数最直接
      // （原先这一类只写一行英文日志，翻不出"推了几条"）
      noticeCount: this.noticeCount,
    };
  }

  /** 机器人 QQ 号（群 @ 判定的前提） */
  get loginId(): string {
    return this.selfId;
  }

  /**
   * 它打算连的地址（**token 已经打过码**）。
   *
   * 这一条是给界面看的："适配器想连哪儿"是排障时最短的一步——而它必须与日志里那句
   * 用同一个口径（都走 `maskAccessToken`），否则界面上看到的和日志里对不上号，
   * 人就会开始怀疑是两个不同的东西。
   *
   * **只读缓存、不读盘**：界面每次轮询都会问它一次（`OneBotEndpointMemo.peek` 的注释）。
   * 端点重读口还没被问过时（比如进程刚起来、还没建第一次连），报的是构造时那份配置——
   * 那也是"它接下来会用的"那一份。token 有没有被带上，看这句话里有没有 `access_token=***`。
   */
  get maskedTarget(): string {
    const cached = this.endpointMemo?.peek() ?? null;
    const wsUrl = cached?.wsUrl ?? this.options.wsUrl;
    const accessToken = cached?.accessToken ?? (this.options.accessToken ?? '');
    try {
      return maskAccessToken(buildConnectUrl(wsUrl, accessToken));
    } catch {
      // 地址本身非法（配置里写坏了）：如实报"地址非法"，不抛——状态查询不该因为坏配置而失败
      return `（地址非法：${wsUrl}）`;
    }
  }

  /** 起连。幂等：重复调用不会建第二条连接 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    void this.openOnce();
  }

  stop(): void {
    this.stopping = true;
    this.started = false;
    if (this.reconnectTimer !== null) {
      this.clearTimeout(this.reconnectTimer.id);
      this.reconnectTimer = null;
    }
    const client = this.client;
    this.client = null;
    this.ready = false;
    this.failPending('OneBot 客户端已停止，动作未送达');
    if (client !== null) client.close(1000, 'agent stopping');
  }

  /**
   * 发一个动作并等它的响应。
   *
   * 不抛异常：发送路径的失败都是**预期内的事实**（未连接 / 超时 / retcode 非 0），
   * 用返回值表达比用异常更贴近调用方（sendText 要把 reason 报给模型，而不是让工具崩掉）。
   */
  async call(action: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<OneBotActionResult> {
    const client = this.client;
    if (client === null || !client.isOpen) {
      return { ok: false, retcode: null, klass: 'offline', reason: `OneBot 未连接，动作 ${action} 未发出` };
    }
    const echo = `irmia-${++this.actionSeq}-${randomUUID()}`;
    const timeout = timeoutMs ?? this.options.actionTimeoutMs ?? DEFAULT_ONEBOT_ACTION_TIMEOUT_MS;
    this.actionCount += 1;
    const result = await new Promise<OneBotActionResult>((resolve) => {
      const timer = this.timeout(() => {
        // 超时必须把登记项摘掉：留着它只会让后续同 echo 的响应去唤醒一个已经结束的调用
        this.pending.delete(echo);
        resolve({
          ok: false, retcode: null, klass: 'transient',
          reason: `OneBot ${action} 等待响应超时（${timeout}ms）`,
        });
      }, timeout);
      this.pending.set(echo, { action, resolve, timer });
      client.sendJson({ action, params, echo });
    });
    if (result.ok) return result;
    if (result.klass === 'permanent') {
      // 协议端说过"这条不行"（1404 等）：链路没问题，绝不因此重连
      this.log.warn(`[OneBot] ${result.reason}（retcode 判定为不可重试，不触发重连）`);
    }
    return result;
  }

  // ── 连接 ──

  /**
   * 这一刻建连该用的对接点。
   *
   * 端点重读口给了就问它（可能读盘，频率由 `OneBotEndpointMemo` 兜住）；它说"读不出来"
   * 时回落到构造时那份配置——那是人写在配置里的值，**这里不猜端口、也不编凭据**。
   */
  private targetEndpoint(): OneBotEndpoint {
    const resolved = this.endpointMemo?.current() ?? null;
    if (resolved !== null) return resolved;
    return { wsUrl: this.options.wsUrl, accessToken: this.options.accessToken ?? '' };
  }

  private async openOnce(): Promise<void> {
    if (this.stopping) return;
    let url: string;
    try {
      const target = this.targetEndpoint();
      url = buildConnectUrl(target.wsUrl, target.accessToken);
    } catch (err) {
      // 地址读出来了但不可用（配置写坏了）：照样作废手里的结论，下一拍重读
      this.endpointMemo?.invalidate();
      this.log.warn(`[OneBot] 连接地址不可用：${messageOf(err)}`);
      this.scheduleReconnect();
      return;
    }
    let client: WsClient;
    try {
      client = await this.connectFn(url, {
        readTimeoutMs: this.readTimeoutMs,
        ...(this.options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: this.options.closeTimeoutMs }),
        onDebug: (line) => { this.log.info(`[OneBot/ws] ${line}`); },
      });
    } catch (err) {
      /**
       * 这一拍没连上：手里的端点结论作废，下一拍重读。
       *
       * **这就是治"配置晚于进程物化"的那一处**：进程起来时协议端还没登录 QQ、配置还没落盘，
       * 读到的是 null ⇒ 拿配置里那份（没有 token）去连 ⇒ 401；而下一秒重连时重读一次，
       * 那时配置已经在盘上了，token 就跟着上去了。没有这一步，空 token 会被固化到天荒地老。
       */
      this.endpointMemo?.invalidate();
      this.log.warn(`[OneBot] 连接失败（${maskAccessToken(url)}）：${messageOf(err)}`);
      this.scheduleReconnect();
      return;
    }

    this.client = client;
    client.onMessage((message) => { this.handleIncoming(message.text); });
    client.onError((err) => { this.log.warn(`[OneBot] 传输层错误：${err.message}`); });
    client.onClose((info) => {
      if (this.client !== client) return; // 已被替换（重连/停止）的旧连接，忽略它的收尾
      this.client = null;
      this.ready = false;
      this.failPending('OneBot 连接已断开，动作未送达');
      if (this.stopping) return;
      // 链路断了也是"手里这份可能过时"的证据（对端可能重启并换了端口或 token）：下一拍重读
      this.endpointMemo?.invalidate();
      this.log.warn(
        `[OneBot] 连接断开（code=${info.code ?? '无'}，${info.byLocal ? '本地发起' : '对端/超时'}`
        + `${info.reason === '' ? '' : `，${info.reason}`}），准备重连`,
      );
      this.scheduleReconnect();
    });
    this.log.info(`[OneBot] 已连上 ${maskAccessToken(url)}，等待协议端事件`);
    // 机器人 QQ 号是群 @ 判定的前提：事件通常自带 self_id，但生命周期事件流也可能先到，
    // 所以连上就问一次（失败只警告：事件自带的 self_id 依然够用）
    if (this.selfId === '') void this.fetchSelfId();
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    if (this.reconnectTimer !== null) return; // 已排定的一拍不许被重复排（否则断线风暴会把定时器堆起来）
    const base = this.options.reconnectBaseMs ?? DEFAULT_ONEBOT_RECONNECT_BASE_MS;
    const max = this.options.maxReconnectDelayMs ?? DEFAULT_ONEBOT_MAX_RECONNECT_DELAY_MS;
    const delay = reconnectDelayMs(this.reconnectAttempts, base, max);
    this.reconnectAttempts += 1;
    const human = delay < 1000 ? `${delay}ms` : `${Math.round(delay / 1000)}s`;
    const maxHuman = max < 1000 ? `${max}ms` : `${Math.round(max / 1000)}s`;
    this.log.warn(`[OneBot] ${human} 后重连（第 ${this.reconnectAttempts} 次，退避上限 ${maxHuman}）`);
    this.reconnectTimer = {
      id: this.timeout(() => {
        this.reconnectTimer = null;
        void this.openOnce();
      }, delay),
    };
  }

  // ── 收 ──

  private handleIncoming(raw: string): void {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = asRecord(JSON.parse(raw) as unknown);
    } catch {
      this.log.warn(`[OneBot] 收到非法 JSON（${raw.length} 字节），已忽略`);
      return;
    }
    if (payload === null) return;
    this.incomingCount += 1;
    // 任何一条入站消息都是"握手通过 + 链路活着"的证据：退避计数到这里才清零
    this.markReady();

    const echo = payload['echo'];
    if (echo !== undefined && echo !== null) {
      const key = String(echo);
      if (this.pending.has(key)) {
        this.settle(key, payload);
        return;
      }
      // echo 不认识：可能是上一轮超时后迟到的响应（也可能是对端乱发），不当事件处理
      this.log.info(`[OneBot] 忽略无法配对的动作响应：echo=${key.slice(0, 40)}`);
      return;
    }
    this.dispatch(payload);
  }

  private settle(key: string, payload: Record<string, unknown>): void {
    const call = this.pending.get(key);
    if (call === undefined) return;
    this.pending.delete(key);
    this.clearTimeout(call.timer);
    const retcode = readNumber(payload, 'retcode') ?? -1;
    const klass = classifyRetcode(retcode);
    if (klass === 'ok' || klass === 'async') {
      call.resolve({ ok: true, retcode, data: asRecord(payload['data']) });
      return;
    }
    const detail = readString(payload, 'wording') || readString(payload, 'msg') || readString(payload, 'status');
    call.resolve({
      ok: false,
      retcode,
      klass,
      reason: `OneBot ${call.action} 失败：retcode=${retcode}${detail === '' ? '' : ` ${detail}`}`,
    });
  }

  /** 断线/停止时把所有在途动作结清：挂着的 promise 比失败更难查 */
  private failPending(reason: string): void {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, call] of entries) {
      this.clearTimeout(call.timer);
      call.resolve({ ok: false, retcode: null, klass: 'offline', reason });
    }
  }

  private markReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer !== null) {
      // 已排定的重连作废：链路已经活了（否则会在重连计时器到点时再连第二条）
      this.clearTimeout(this.reconnectTimer.id);
      this.reconnectTimer = null;
    }
    this.log.info('[OneBot] 链路就绪，退避计数清零');
  }

  private dispatch(payload: Record<string, unknown>): void {
    // 每条事件都带 self_id：收到就跟着更新（比只信一次 get_login_info 更贴近事实）
    const selfId = readScalar(payload, 'self_id');
    if (selfId !== '') this.learnSelfId(selfId);

    const postType = readString(payload, 'post_type');
    if (postType === 'meta_event') {
      this.onMetaEvent(payload);
      return;
    }
    if (postType !== 'message') {
      /**
       * 非 message 的事件**留一行日志**（与官方通道同一条口径，见 qq-official.ts 的
       * `[QQ/网关] 收到分发：…`）。
       *
       * 为什么值得占一行：这条链路最要紧的排障问题是"协议端到底推没推、适配器认没认"——
       * 原先这里直接 `return`，一个字都不记，于是"群里 @ 了她却没反应"只能靠翻协议端自己的
       * 日志（另一套知识、另一份路径）。官方那条路的同类注释就是为同一个坑写的
       * （2026-10-02 那次"群里 @ 了她却没反应"），OneBot 又踩了一遍。
       * 只记类型与 id 前 12 位：既够定位，也不会把整条事件抄进日志。
       */
      const id = readScalar(payload, 'message_id') || readScalar(payload, 'notice_type')
        || readScalar(payload, 'request_type') || readScalar(payload, 'sub_type');
      const what = postType === '' ? '（缺 post_type）' : postType;
      /**
       * **2026-10-11：`notice` 不再"记一行就丢"**（用户点的第二件，见 `noticeDataOf`）。
       * 这一支原先只写日志——于是"别人开了全员禁言"这类事实整条链不存在：她读那个群，
       * 看不到半小时前发生过什么。现在它落成 `channel/notice`（internal、不唤醒、不计未读），
       * 由 `read_channel` 按 `noticeLineText` 渲染成一行 `[阿岚 开启了全员禁言]`。
       *
       * 日志照旧写（那是"协议端到底推没推"的凭据），只是从"只写日志"变成"写日志 + 落事件"。
       */
      const notice = postType === 'notice' ? noticeDataOf(payload, { selfId: this.selfId, channelName: this.options.channelName ?? ONEBOT_CHANNEL_NAME }) : null;
      if (notice !== null) {
        this.noticeCount += 1;
        this.options.onNotice?.(notice);
        this.log.info(`[OneBot] 收到分发：notice · ${notice.noticeType}${notice.subType === undefined ? '' : `/${notice.subType}`}（已落 channel/notice）`);
        return;
      }
      this.log.info(`[OneBot] 收到分发：${what}${id === '' ? '' : ` · ${id.slice(0, 12)}`}（不是消息事件，已忽略）`);
      return;
    }
    const wake = mapEventToWakeChannel(payload, {
      selfId: this.selfId,
      channelName: this.options.channelName ?? ONEBOT_CHANNEL_NAME,
      // 回复她自己的那条 = 在叫她（见 mapEventToWakeChannel 的判据②）：表在上面那层，
      // 因为"她发过哪些 message_id"只有真正发过消息的一方知道
      isReplyToSelf: (id) => this.options.isSentMessageId?.(id) ?? false,
    });
    if (wake === null) return;
    this.options.onWake(wake);
  }

  private onMetaEvent(payload: Record<string, unknown>): void {
    const metaType = readString(payload, 'meta_event_type');
    if (metaType === 'heartbeat') {
      const interval = readNumber(payload, 'interval');
      if (interval !== null && interval > 0) this.applyReadTimeout(heartbeatToReadTimeoutMs(interval));
      return;
    }
    if (metaType === 'lifecycle') {
      const subType = readString(payload, 'sub_type');
      this.log.info(`[OneBot] 生命周期事件：${subType === '' ? '未标注' : subType}（self_id=${this.selfId === '' ? '未知' : this.selfId}）`);
      if (subType === 'connect' && this.selfId === '') void this.fetchSelfId();
    }
  }

  /**
   * 读超时跟随协议端心跳节奏。注意 `setReadTimeoutMs(0)` 在 ws-client 里是"不改动"，
   * 所以这里只接受正数（对端关掉心跳时保持兜底值，而不是把链路判断彻底关掉）。
   */
  private applyReadTimeout(ms: number): void {
    if (ms <= 0 || ms === this.readTimeoutMs) return;
    this.readTimeoutMs = ms;
    this.client?.setReadTimeoutMs?.(ms);
  }

  /**
   * 学到机器人自己的 QQ 号（`self_id` / `get_login_info` 两个来源都走这里，**唯一入口**）。
   *
   * 除了留在客户端里（群 @ 判定要用），还要**回调给宿主**：判据在那一处
   * （`channel/self-identity.ts` 的 `isSelfMessage`），而它建判据的时刻早于这里——
   * 少了这根线，"平台推回来的自己的消息"就永远认不出来（2026-10-11 修的那处缺陷）。
   */
  private learnSelfId(id: string): void {
    const key = id.trim();
    if (key === '') return;
    const changed = this.selfId !== key;
    this.selfId = key;
    // 只在"这是个新值"时回调：宿主那侧是幂等的，但没必要的调用会掩盖真正的变化点
    if (!changed) return;
    this.options.onSelfId?.(key);
    this.selfIdListener?.(key);
  }

  /**
   * 接上"学到自己是谁了"的回调（宿主装配后调；见 `OneBotClientOptions.onSelfId`）。
   *
   * 接上时**立刻补推一次当下那份**：客户端可能在接线之前就学到了（构造时的那次握手、
   * 或第一条事件的 `self_id`——两者都比宿主装配完判据更早，是真会发生的）。
   * 宿主那侧按去重处理，重复推一次没有代价。
   */
  setSelfIdListener(listener: (id: string) => void): void {
    this.selfIdListener = listener;
    const known = this.selfId.trim();
    if (known !== '') listener(known);
  }

  private selfIdListener: ((id: string) => void) | null = null;

  private async fetchSelfId(): Promise<void> {
    const result = await this.call('get_login_info', {});
    if (!result.ok) {
      this.log.warn(`[OneBot] get_login_info 未拿到机器人 QQ 号：${result.reason}（群 @ 判定将依赖事件自带的 self_id）`);
      return;
    }
    const userId = readScalar(result.data, 'user_id');
    if (userId === '') {
      this.log.warn('[OneBot] get_login_info 响应里没有 user_id，已忽略');
      return;
    }
    this.learnSelfId(userId);
    this.log.info(`[OneBot] 机器人 QQ 号：${userId}`);
  }
}

// ──────────────────────────────── 通道适配器 ────────────────────────────────

/** OneBot 出站的消息形态：**纯文本字符串**（不构造 CQ 码数组，文本原样发） */
export type OneBotChatType = QqChatType;

export interface OneBotChannelOptions {
  /** 协议端正向 ws 地址（如 ws://127.0.0.1:3001） */
  wsUrl: string;
  /** access_token；只进握手 query，不进日志 */
  accessToken?: string;
  /** 端点重读口（内置协议端用：每次建连前现读一次它的配置；见 `OneBotClientOptions`） */
  resolveEndpoint?: () => OneBotEndpoint | null;
  /** 端点重读的硬下限（毫秒，默认 `DEFAULT_ONEBOT_ENDPOINT_REREAD_MS`；测试用） */
  endpointRereadMs?: number;
  channelName?: string;
  connect?: (url: string, options: WsConnectOptions) => Promise<WsClient>;
  readTimeoutMs?: number;
  reconnectBaseMs?: number;
  maxReconnectDelayMs?: number;
  actionTimeoutMs?: number;
  closeTimeoutMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  log?: OneBotLogger;
  /** 命中器：本地 mock / 隐私（无用，保留扩展点） */
  onWake?: (data: WakeChannel['data']) => void;
  /**
   * 群里动静（`notice` → `channel/notice`）的落地口。
   *
   * 与 `onMessage`（上面那格 `onWake`，还有实例上的同名属性）**同一个成例**：装配时能给，
   * 装配之后也能改（宿主在两个通道上写 `onMessage` 就是这么做的）。两个入口都通到同一格。
   */
  onNotice?: (data: ChannelNoticeData) => void;
}

/** OneBot 通道：客户端 + 发送封装的组合，对系统只暴露 `ChannelAdapter` 形状 */
export class OneBotChannel implements ChannelAdapter {
  readonly name = ONEBOT_CHANNEL_NAME;

  onMessage?: (event: WakeChannel['data']) => void;

  /**
   * 群里动静（`notice` → `channel/notice`）的落地口。**与 `onMessage` 分开**：那条是"有人在说话"，
   * 这条是"群里发生了一件事"——宿主要落的也是两种事件，混在一个口里就得在下游再分一次流。
   */
  onNotice?: (data: ChannelNoticeData) => void;

  private readonly client: OneBotClient;
  private readonly log: OneBotLogger;
  /** 观测计数：收到并已投递的通道消息条数 */
  private delivered = 0;
  /** 观测计数：落成 `channel/notice` 的群里动静条数 */
  private notices = 0;
  /**
   * 最近一条消息事件的时刻（毫秒），0 = 还没收到过。
   *
   * 与 `delivered` 是两个问题：那个答"一共来过多少"，这个答"上一次是什么时候"。
   * **后者才是能看出静默假活的那个数**（见 `snapshot()` 的注释）。
   */
  private lastEventAtMs = 0;
  /**
   * **她自己发出去的那些 message_id**（最近 `SENT_ID_WINDOW` 条，先进先出）。
   *
   * 为什么需要它：`reply` 段只给"回复的是哪一条"，而"那条是不是我说的"是**本地才知道**的事实
   * ——它决定这条消息算不算在叫她（`mentionsMe`、`group-at`，见 `mapEventToWakeChannel` 判据②），
   * 而那个判据是群成员档案与唤醒的入口。没有这份表，被回复就永远判不出来。
   *
   * 为什么是有界窗口而不是全量：她说过的话可能上万条，而"有人在回复她刚说的那句"几乎总在
   * 最近若干条之内；无界增长换来的只是内存账单。窗口之外的量不到就按"不是回复她"处理
   * （少登记一个人，比错登记好）。
   */
  private readonly sentMessageIds = new Set<string>();
  /** 发出去的消息 id 记多少条（窗口） */
  private static readonly SENT_ID_WINDOW = 512;

  constructor(options: OneBotChannelOptions) {
    this.log = options.log ?? SILENT_LOG;
    this.client = new OneBotClient({
      wsUrl: options.wsUrl,
      ...(options.accessToken === undefined ? {} : { accessToken: options.accessToken }),
      ...(options.resolveEndpoint === undefined ? {} : { resolveEndpoint: options.resolveEndpoint }),
      ...(options.endpointRereadMs === undefined ? {} : { endpointRereadMs: options.endpointRereadMs }),
      ...(options.channelName === undefined ? {} : { channelName: options.channelName }),
      ...(options.connect === undefined ? {} : { connect: options.connect }),
      ...(options.readTimeoutMs === undefined ? {} : { readTimeoutMs: options.readTimeoutMs }),
      ...(options.reconnectBaseMs === undefined ? {} : { reconnectBaseMs: options.reconnectBaseMs }),
      ...(options.maxReconnectDelayMs === undefined ? {} : { maxReconnectDelayMs: options.maxReconnectDelayMs }),
      ...(options.actionTimeoutMs === undefined ? {} : { actionTimeoutMs: options.actionTimeoutMs }),
      ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
      ...(options.setTimeoutFn === undefined ? {} : { setTimeoutFn: options.setTimeoutFn }),
      ...(options.clearTimeoutFn === undefined ? {} : { clearTimeoutFn: options.clearTimeoutFn }),
      log: this.log,
      // "这条回复的是不是我发的那句"：表就在这一层（只有发过消息的一方有）
      isSentMessageId: (id) => this.sentMessageIds.has(id),
      // 群里动静：转成 `channel/notice` 之后交给宿主（它落成另一种事件，见 main.ts）。
      // **两个出口都走这里**（装配期的 `options.onNotice` 与装配后赋的 `this.onNotice`）：
      // 与 `onWake`/`onMessage` 那一对逐字同形，宿主少一处特例。
      onNotice: (data) => {
        this.notices += 1;
        options.onNotice?.(data);
        this.onNotice?.(data);
      },
      onWake: (data) => {
        this.delivered += 1;
        // 记下"最近一条消息是什么时候来的"——见 lastEventAt 的注释：协议端有一种
        // **静默假活**（进程活着、端口在听、心跳照发，但下游一条事件都收不到），
        // 链路层看不见它，而"多久没消息"这个事实看得见。
        this.lastEventAtMs = Date.now();
        options.onWake?.(data);
        this.onMessage?.(data);
      },
    });
  }

  /**
   * **我自己的标识**（这一条通道上的形态：机器人 QQ 号）。
   *
   * 为什么要有这个口（2026-10-11 用户裁决的落点）：入站那条路上原先没有任何一处判
   * "这条是不是我自己发的"，于是协议端一旦把她自己发的话推回来，它就会被完整地当成
   * 某个群成员说的话——落库、算未读、进群成员档案。判据收在宿主一处
   * （`channel/self-identity.ts` 的 `isSelfMessage`），而"我自己是谁"由**各通道自己回答**：
   * OneBot 这边就是 `self_id`（协议端每条事件都带，另有 `get_login_info` 兜底）。
   *
   * 拿不到就返回空数组（**不是**猜一个）：宿主那边的方向是"认不出自己时宁可让一次回声漏进来"，
   * 也绝不因为认不出而丢掉别人的话。**每次调用现读一次**（不是快照）——协议端可能刚刚才把
   * `self_id` 送进来，而宿主的判据每收到一条消息都要问一次。
   */
  selfIds(): string[] {
    const id = this.client.loginId.trim();
    return id === '' ? [] : [id];
  }

  /**
   * 接上"学到自己是谁了"的回调（宿主在装配后调；见 `OneBotClientOptions.onSelfId`）。
   *
   * 为什么是**事后接线**而不是装配期给：通道比宿主那份判据先建好（判据还要把两条通道的
   * `selfIds()` 当现读口），所以这一格只能装配后接。接上时**立刻补推一次当下那份**——
   * 通道可能在接线之前就已经学到（构造时的那次握手）。
   */
  setSelfIdListener(listener: (id: string) => void): void {
    this.client.setSelfIdListener(listener);
  }

  start(): void {
    this.client.start();
  }

  stop(): void {
    this.client.stop();
  }

  /**
   * 记下自己发出去的那条：`reply` 段指的若是它，那条消息就算在叫她。
   *
   * 只记非空 id（协议端没给 id 时没什么可记的），并按窗口淘汰最旧的一条
   * （`Set` 的迭代顺序就是插入顺序）。
   */
  private rememberSentMessage(messageId: string): void {
    if (messageId === '') return;
    this.sentMessageIds.add(messageId);
    while (this.sentMessageIds.size > OneBotChannel.SENT_ID_WINDOW) {
      const oldest = this.sentMessageIds.values().next().value;
      if (oldest === undefined) break;
      this.sentMessageIds.delete(oldest);
    }
  }

  /**
   * 回投（speak 的第三路）。
   *
   * `options.msgId/msgSeq` 在 OneBot 语义下**一律忽略**：那是官方被动回复窗口的字段
   * （同一 msg_id 必须换 msg_seq，否则 40054005 去重失败），OneBot 没有这条限制——
   * 回复就是一条普通的 send_* 动作，重发也不会被去重拒绝。
   *
   * 但 `msgId` **照原样收下并显式丢掉**（而不是把签名缩窄成没有它）：两条通道的 poster 接口
   * 同形，形状在这里说真话——"这条通道没有那个概念"写在实现里，不写在类型上让人猜
   * （报告 §3.11）。发出去之后那个 `message_id` 反过来有用：它进 `sentMessageIds`，
   * "有人回复她那句"才判得出来。
   */
  async sendText(
    chatType: OneBotChatType,
    chatId: string,
    text: string,
    options: SendTextOptions = {},
  ): Promise<SendOutcome> {
    // OneBot 没有被动回复窗口：`msgId`（回哪一条）与 `msgSeq`（同一 msg_id 的第几次）
    // 在本通道下都没有语义，而"引用回复"是另一个可选参数（本适配器不代劳，与她写 CQ 码同一口径）。
    void options.msgId;
    void options.msgSeq;
    const raw: string = chatType;
    const isGroup = raw === 'group-at' || raw === 'group';
    if (!isGroup && raw !== 'c2c') {
      return { ok: false, reason: `OneBot 不支持的 chatType：${raw}`, passive: false };
    }
    const action = isGroup ? 'send_group_msg' : 'send_private_msg';
    const params: Record<string, unknown> = isGroup
      ? { group_id: oneBotIdOf(chatId), message: text }
      : { user_id: oneBotIdOf(chatId), message: text };
    const result = await this.client.call(action, params);
    if (!result.ok) return { ok: false, reason: result.reason, passive: false };
    const messageId = readScalar(result.data, 'message_id');
    this.rememberSentMessage(messageId);
    // `passive` 恒 false：这条通道没有被动/主动之分（如实报，不借官方的语义）
    return { ok: true, messageId, passive: false, msgSeq: 0 };
  }

  /**
   * 发一个**媒体**（`send_media` 走到这条通道时的落点）：图片 / 语音 / 视频 / 文件。
   *
   * 与官方那条路的差别是**没有上传那一步**：OneBot 的媒体就在消息段里给协议端一个来源，
   * 由协议端自己去取（官方要先 `uploadMedia` 换 `file_info` 再 `msg_type=7` 发）。
   *
   * 来源形态按 `kind` 定，**只给协议端真的认得的**（下面每条都写了它是从哪来的；判据在
   * `data/services/snowluma` 的产物里读出来的，见提交说明的"未实测"那一段）：
   *   • `url`（网络地址）→ 段里 `file` 直接放那个 http(s) 地址；
   *   • 本机字节 → `base64://<base64>`。协议端的二进制来源装载器认
   *     `base64://` / `http(s)://` / `file://` / 本地路径四种（`loadBinarySource` +
   *     `resolveLocalFilePath`），而 base64 那一种**不依赖"适配器与协议端同机"**，
   *     也不需要往盘上写临时文件、更不需要事后清理；
   *   • 文件类且有本机**路径** → `file://` 地址（`upload_group_file` / `upload_private_file`
   *     的 `file` 参数语义就是"路径或 URL"）。
   *
   * 语种形态的 id 与官方那套 `fileType: 1|2|3|4` **同源**（1 图 / 2 视频 / 3 语音 / 4 文件），
   * 因为 `MediaRequest` 是工具层的产物、两条通道共用；这个函数只负责把它翻成消息段。
   */
  async sendMediaTo(
    chatType: OneBotChatType,
    chatId: string,
    media: OneBotMediaInput,
    options: SendTextOptions = {},
  ): Promise<SendOutcome> {
    // 与 sendText 同一条纪律：`msgId` / `msgSeq` 是官方被动回复窗口的字段，本通道没有这个概念。
    // 但**不收起来假装没有**——签名留着它，这里显式说明为什么不用（报告 §3.11）。
    void options.msgId;
    void options.msgSeq;
    const raw: string = chatType;
    const isGroup = raw === 'group-at' || raw === 'group';
    if (!isGroup && raw !== 'c2c') {
      return { ok: false, reason: `OneBot 不支持的 chatType：${raw}`, passive: false };
    }
    const built = oneBotMediaCall(isGroup, chatId, media);
    if (!built.ok) return { ok: false, reason: built.reason, passive: false };
    const result = await this.client.call(built.action, built.params);
    if (!result.ok) return { ok: false, reason: result.reason, passive: false };
    const messageId = built.returnsMessageId ? readScalar(result.data, 'message_id') : '';
    // 媒体也记：`send_media` 发出去的那条同样可能被人回复，判据与文本那条同源
    this.rememberSentMessage(messageId);
    return { ok: true, messageId, passive: false, msgSeq: 0 };
  }

  /** 状态快照（CLI/测试观测；token 值本身从不外露） */
  snapshot(): { delivered: number; notices: number; lastEventAt: number | null } & ReturnType<OneBotClient['snapshot']> {
    return {
      delivered: this.delivered,
      // 群里动静（notice）另计一格：它与"有人说话"是两件事，混在一起就答不了
      // "协议端到底推没推 notice"（那是这一类事件原先整条不存在时最先要问的问题）
      notices: this.notices,
      // 最近一条消息事件的时刻（毫秒），还没收到过就是 null。
      //
      // 为什么要有它：协议端有一种**静默假活**——账号被悄悄踢了，但它不重登、不通知下游，
      // 而**进程活着、端口在听、TCP 已建立、心跳照发**。读超时因此永远不会触发（心跳一直在
      // 重置它），链路层看过去一切健康，实际下游可能几十小时收不到任何事件（NapCat #2071
      // 就是这么记的）。链路层测不出来，能测出来的只有"多久没有消息了"这一个事实。
      //
      // 所以这里**只报事实、不下判断**：是不是假活、该不该重启，留给看它的人（或上层策略）——
      // 对一个本来就冷清的群，"六小时没消息"完全正常。这与框架一贯的分寸一致：
      // 拿不准的事不替她决定。
      lastEventAt: this.lastEventAtMs === 0 ? null : this.lastEventAtMs,
      ...this.client.snapshot(),
    };
  }

  /**
   * 链路观测（第三档）：界面要回答的是"适配器到底连上没有、它想连哪儿"。
   *
   * 与 `snapshot()` 的分工：那个是给测试与 CLI 看的计数，这个是给**界面**看的句子——
   * 多了一个 `target`（含 token 打码后的地址：日志里怎么打码，这里就怎么打）。
   *
   * token **必须打码**：这个值会进 HTTP 响应。`maskAccessToken` 是那条链上唯一的口径，
   * 所以这里直接复用它（在 `OneBotClient.maskedTarget` 里），不另写一份替换规则。
   */
  linkView(): { connected: boolean; target: string; selfId: string; reconnectAttempts: number } {
    const snapshot = this.snapshot();
    return {
      connected: snapshot.connected,
      target: this.client.maskedTarget,
      selfId: snapshot.selfId,
      reconnectAttempts: snapshot.reconnectAttempts,
    };
  }
}

// ──────────────────────────────── speak 回投接线 ────────────────────────────────

/** 回投地址的 scheme：`onebot:<chatType>:<chatId>`（与普通通道的 `qq:` 并行，各占自己的命名空间） */
export const ONEBOT_REPLY_SCHEME = 'onebot:';

/**
 * 这个通道名**是不是 OneBot 家族**（默认名 `onebot` 与它的别名实例 `onebot-*` 都算）。
 *
 * 为什么需要它（2026-10-08）：这条判据过去在仓库里**被硬编码写了四遍**
 * （`tools/admin.ts` 的 `replyUrlForWake`、`channel/media-poster.ts`、
 *   `channel/sessions.ts` 的命名空间、`channel/warn-exempt.ts` 的豁免名单），
 * 每处都是 `x === 'onebot'`。而**通道名可以是别名**——`OneBotClientOptions.channelName`
 * 明摆着允许（本仓测试用的就是 `'onebot-b'`），于是别名实例：
 *   · `replyUrlForWake` 把它当非 OneBot ⇒ 回投地址造错命名空间 ⇒ **静默回投不出去**
 *     （比投错地址更坏：没有任何报错）；
 *   · `sidNamespaceOf` 把它的会话**塞进 `qq:` 命名空间** ⇒ 别名实例的会话与官方 QQ 的会话
 *     混在一起（本机没开别名实例，所以这个一直没露过面）。
 *
 * 收成**一处**，四边共用：一处改、四处跟着对，不再出现"只改了一处"。
 *
 * 判据的**依据**：OneBot 家族的回投地址 scheme 是 `onebot:`（见上面那个常量），
 * 而这个 scheme 是**适配器自己**在造地址时写下的（携带别名实例的 `chatType`/`chatId`），
 * 所以"是 OneBot 家族"这件事在 URL 上本来就是确凿的。名字这一层则按
 * `onebot` 或 `onebot-<后缀>` 认——与 `channelName` 的既有用法一致（`onebot-b`）。
 */
export function isOneBotFamilyChannel(channel: string | undefined): boolean {
  if (channel === undefined) return false;
  return channel === ONEBOT_CHANNEL_NAME || channel.startsWith(`${ONEBOT_CHANNEL_NAME}-`);
}

/** 把 wake/channel 数据编成回投 URL（**归一形态**：群聊一律 `group`，与 sid 同一个口径） */
export function replyUrlOf(data: Pick<WakeChannel['data'], 'chatType' | 'chatId'>): string {
  return `${ONEBOT_REPLY_SCHEME}${sidKindOf(data.chatType)}:${data.chatId}`;
}

export type OneBotReplyUrlParse =
  | { ok: true; chatType: OneBotChatType; chatId: string }
  | { ok: false; error: string };

/** 解析回投 URL；认 `onebot:c2c:` / `onebot:group:`（旧记录里可能还是 `onebot:group-at:`） */
export function parseReplyUrl(url: string): OneBotReplyUrlParse {
  if (!url.startsWith(ONEBOT_REPLY_SCHEME)) {
    return { ok: false, error: `不是 OneBot 回投地址（${url.slice(0, 32)}）` };
  }
  const rest = url.slice(ONEBOT_REPLY_SCHEME.length);
  const index = rest.indexOf(':');
  if (index <= 0) return { ok: false, error: `回投地址缺少 chatId：${url}` };
  const chatType = rest.slice(0, index);
  if (chatType !== 'c2c' && chatType !== 'group' && chatType !== 'group-at') {
    return { ok: false, error: `不支持的 chatType：${chatType}` };
  }
  const chatId = rest.slice(index + 1);
  if (chatId === '') return { ok: false, error: `回投地址的 chatId 为空：${url}` };
  return { ok: true, chatType, chatId };
}

/**
 * 回投实现：把 admin 工具 `speak` 的第三路（replyPoster）接到本通道的 sendText 上。
 *
 * 与 `createChannelReplyPoster` 同形（同一个 `ReplyPoster` 形状、同样的超时竞速），
 * 差别只是"认哪张回投地址"——scheme 与通道名都取自本文件，所以这里不需要知道 QQ 通道存在。
 */
export function createOneBotReplyPoster(
  channels: ReadonlyMap<string, ChannelAdapter>,
  options: { timeoutMs?: number } = {},
): { post(target: { url: string; idempotencyKey: string }, text: string): Promise<{ ok: true; status: number; messageId?: string } | { ok: false; reason: string }> } {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ONEBOT_ACTION_TIMEOUT_MS;
  return {
    async post(target, text) {
      const parsed = parseReplyUrl(target.url);
      if (!parsed.ok) return { ok: false, reason: parsed.error };
      const channel = channels.get(ONEBOT_CHANNEL_NAME);
      if (channel === undefined) return { ok: false, reason: 'OneBot 通道未装配，回投跳过' };
      const timerRef: { handle: NodeJS.Timeout | null } = { handle: null };
      try {
        // 超时由调用方（工具超时预算）说了算：回投是"这一轮发言"的一部分
        const outcome = await Promise.race([
          channel.sendText(parsed.chatType, parsed.chatId, text),
          new Promise<never>((_resolve, reject) => {
            timerRef.handle = setTimeout(() => { reject(new Error(`回投超时（${timeoutMs}ms）`)); }, timeoutMs);
          }),
        ]);
        // 平台回的 `message_id` **必须原样带出去**（2026-10-12 修的静默丢失）：它是
        // "她刚发出去的那一条"的唯一坐标，而这条回投路径就是**唯一**拿得到它的地方——
        // 原来的签名在这里把它窄化掉了（`return { ok: true, status: 200 }`），于是
        // `speak/sent` 里没有 id、`read_channel` 的 `（我）`那一行永远拿不到 id，
        // 她连"撤掉我自己刚发的那条"都做不到（实测 T1308：11 步里 6~7 步花在找 id 上，
        // 其中 S4/S8 两步是去扫原始 jsonl）。
        //
        // 空 id 就不带这一格（不是带一个空串）：`SendOutcome.messageId` 在协议端没给 id 时
        // 就是空串，而"给了但为空"在消费侧会读成"这个 id 是 ''"——那比缺席更难判。
        // 旧消费者与旧日志的形状都不变（这一格是**可选**的，见 `ReplyOutcome`）。
        if (outcome.ok) {
          return outcome.messageId === ''
            ? { ok: true, status: 200 }
            : { ok: true, status: 200, messageId: outcome.messageId };
        }
        return { ok: false, reason: outcome.reason };
      } catch (err) {
        return { ok: false, reason: messageOf(err) };
      } finally {
        if (timerRef.handle !== null) clearTimeout(timerRef.handle);
      }
    },
  };
}
