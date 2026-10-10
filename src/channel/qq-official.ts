/**
 * Irmia Agent — QQ 官方 Bot API 通道（M9，docs/milestones.md M9-2）
 *
 * 协议依据全部来自官方文档实证（构件时逐页核对，非推测）：
 *   • 获取凭证   POST https://api.bot.qq.com/app/getAppAccessToken  `{appId, clientSecret}` →
 *                `{access_token, expires_in}`；**失败也返回 HTTP 200**，必须看响应体的 `code`；
 *                `expires_in` 是字符串（"7200"），且"在到期前 60 秒内再次获取会换发新的"。
 *                见 https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
 *   • 鉴权头     `Authorization: QQBot {access_token}`（同上页「使用访问凭证」）
 *   • 网关       GET `/gateway` → `{url: "wss://api.bot.qq.com/websocket/"}`；
 *                Hello(op10) 的 `heartbeat_interval` **单位是毫秒**；
 *                Identify(op2) `{token:"QQBot {accessToken}", intents, shard:[0,1], properties}`；
 *                READY 事件带 `d.session_id`；心跳 op1 的 `d` = 收到的最新 `s`（首次 null）；
 *                ACK 是 op11；Resume(op6) `{token, session_id, seq}` → RESUMED 后补发；
 *                op7 是服务端要求重连、op9 表示 identify/resume 参数有错；
 *                `GROUP_AND_C2C_EVENT = 1 << 25` 覆盖 C2C_MESSAGE_CREATE、GROUP_AT_MESSAGE_CREATE
 *                与 GROUP_MESSAGE_CREATE（**全量群消息用的是同一个订阅位**，2026-10-02 对着
 *                官方文档更正：https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html
 *                那一页写明 Intent 就是 GROUP_AND_C2C_EVENT (1<<25)；差别在平台侧有没有开
 *                "接收所有消息"这项功能，不是另申请一个事件订阅位）。
 *                见 wiki/develop/api-v2/dev-prepare/interface-framework/reference.html 与 opcode.html
 *   • 事件体     C2C：`{id, author.user_openid, content, timestamp}`；
 *                群：`{id, author.member_openid, group_openid, content, timestamp}`；
 *                `content` 已去除 @ 前缀（群消息）；attachment 的字段是 `url` / `filename`。
 *   • **群里 @ 人**（2026-10-05 查官方文档确证）：正文里嵌
 *                **`<qqbot-at-user id="<openid>" />`**，客户端渲染成蓝色 @；旧协议 `<@userid>`
 *                官方标注"即将弃用"。它**不需要 markdown**——官方原话"群聊…支持含有文本文字的
 *                消息类型，如：文本消息、图文消息、markdown 消息"，所以 `msg_type:0` 与 `2` 都行。
 *                同一个群成员的 openid **按群隔离**（`member_openid`），跨群抄来的 id @ 不到人。
 *                **那一串由她自己写在正文里**（框架不做名字 → openid 那一跳，见文件末尾那段
 *                注释与 docs/design.md §4.20.1）——本文件只负责把正文原样发出去。
 *                出处《文本交互》：https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/text-chain.html
 *   • 发送消息   POST `/v2/users/{user_openid}/messages` 与 `/v2/groups/{group_openid}/messages`，
 *                体 `{content, msg_type:0, msg_id?, msg_seq?}`。
 *                **被动回复窗口**：单聊 60 分钟且同一条消息最多 4 次；群聊 5 分钟且最多 5 次。
 *                `相同的 msg_id + msg_seq 重复发送会失败`（40054005「消息被去重：请确保每次请求
 *                使用不同的 msgseq 值」），所以本适配器对同一条 messageId 递增 msg_seq。
 *                见 wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html 与
 *                .../v2_groups_group_openid_messages.post.html
 *
 * 三块职责（都在本文件，因为它们共享同一份协议知识）：
 *   ① `QqAccessToken`：凭证缓存与提前刷新（默认提前 5 分钟；官方真正的重叠窗口是 60 秒，
 *      我们取更保守的 5 分钟——多刷几次的代价远小于"发消息时才发现 token 过期"）；
 *   ② `QqGateway`：连接状态机（Hello → Identify/Resume → 心跳 → 事件 → 断线退避重连）；
 *   ③ `QqOfficialChannel`：对系统暴露的通道适配器（ChannelAdapter）——
 *      入站把事件转成 `wake/channel`，出站把 `sendText` 接到 admin 工具的 speak 回投。
 *
 * 与 `wake/channel` 事件的字段对应（严格按 schema）：
 *   channel='qq-official'、chatType、person（openid）、chatId（speak 回投目标）、text、
 *   messageId（平台消息 id）、msgSeq、attachments、dedupeKey=messageId。
 *
 * 约定：值导入写 `.ts`，纯类型导入写 `.js`。
 */

import { createHash } from 'node:crypto';
import { buildMultipartBody } from './multipart.ts';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import type { WakeChannel } from '../log/types.js';
import { sidKindOf } from './sessions.ts';

import { connect as wsConnect, parseWsUrl, type WsClient, type WsConnectOptions } from './ws-client.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 通道标识（wake/channel.channel 的取值，也是 dedupeKey 命名空间的前缀来源） */
export const QQ_CHANNEL_NAME = 'qq-official';

/** 默认 API 根地址（官方文档：网关地址 wss://api.bot.qq.com/websocket/） */
export const DEFAULT_QQ_API_BASE = 'https://api.bot.qq.com';
/** 默认凭证地址（注意与 API 根地址不同域：凭证在 bots/api.bot 域下，官方两种写法并存，取文档 curl 示例的 api.bot 域） */
export const DEFAULT_QQ_TOKEN_URL = 'https://api.bot.qq.com/app/getAppAccessToken';

/** 事件订阅位：GROUP_AND_C2C_EVENT (1 << 25) —— C2C_MESSAGE_CREATE + GROUP_AT_MESSAGE_CREATE + GROUP_MESSAGE_CREATE（全量群消息同一个位，见文件头那段更正） */
export const QQ_INTENTS_GROUP_AND_C2C = 1 << 25;

/** 凭证提前刷新窗口（毫秒，默认 5 分钟） */
export const DEFAULT_TOKEN_REFRESH_AHEAD_MS = 5 * 60 * 1000;
/** 网关未下发 Hello 时的心跳/读超时兜底（官方 Hello 的 heartbeat_interval 默认 45000ms） */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 45_000;
/** 指数退避上限：5 分钟（里程碑要求） */
export const DEFAULT_MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000;
/** 指数退避起点：1 秒 */
export const DEFAULT_RECONNECT_BASE_MS = 1_000;

/** opcode（官方 opcode 表） */
export const QQ_OP = {
  dispatch: 0,
  heartbeat: 1,
  identify: 2,
  resume: 6,
  reconnect: 7,
  invalidSession: 9,
  hello: 10,
  heartbeatAck: 11,
} as const;

/** 被动回复窗口内的可重试错误码：msg_id 过期/次数超限时降级为主动消息，绝不静默丢回复 */
export const QQ_PASSIVE_EXPIRED_CODES: readonly number[] = [304103, 40034005, 40034024, 40034128];

/**
 * 服务端拒绝**原生 markdown** 的错误码（官方文档）：
 *   `40034127` 无 markdown 模板权限 / `40034124` markdown 参数错 / `40034011` 无效的 markdown 内容 /
 *   `22006` 消息类型与内容不匹配。
 *
 * 命中就**降级为纯文本重发一次**——格式不被支持不是丢话的理由。AstrBot 也这么做
 *（它额外用错误文案 "不允许发送原生 markdown" 兜底，这里一并认）。
 */
/**
 * **去重撞车**的错误码（2026-10-03 实测）：`msg_id + msg_seq` 这一对已经被用过。
 *
 * 为什么会出现（真事）：`msg_seq` 计数器活在**进程内存**里，重启就重置；而"重启打断了她的
 * 发言 → 那一轮的输入被退回重跑"正好让她**再回一次同一条消息**——新进程从 2 重新数，
 * 撞上旧进程用过的号。平台只认"这一对是不是新的"，所以撞了就换一个号重发。
 */
export const QQ_DEDUPE_CODES: readonly number[] = [40054005];
export const QQ_MARKDOWN_REJECT_CODES: readonly number[] = [22006, 40034011, 40034124, 40034127];

/**
 * **"正在输入"**（`msg_type: 6` + `input_notify`）的协议常量。
 *
 * 官方口径（2026-10-11 亲验《发送单聊消息》
 * <https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html>）：
 *   • 请求体里 `msg_type` 的取值表写着 `6=输入中状态（input_notify)`；
 *   • `input_notify` 是一个对象：`input_type`「填 1」；`input_second`「状态持续时间，最长 60s」；
 *   • 官方示例体就是 `{msg_type: 6, input_notify: {input_type: 1, input_second: 60}, msg_id, msg_seq}`；
 *   • **只有单聊那一页列了它**——群聊那一页的 `msg_type` 表里没有 6、请求体里也没有 `input_notify`
 *     ⇒ 群里发它是"官方没写的用法"，本适配器**不试**（如实跳过，见 `sendInputNotify`）。
 *
 * `input_type: 1` = 「对方正在输入…」（官方页只写"填 1"，其余取值只在 bot-docs 的**注释掉**的
 * 旧表格里出现过——不采信，所以这里只用 1）。
 */
export const QQ_INPUT_NOTIFY_TYPE = 1;

/**
 * 一次通知里声明的**状态持续时间**（秒，官方上限 60）。
 *
 * 取上限 60 而不是"预计要打多久"：这个状态会被**紧接着发出去的第一条消息自动取消**，
 * 所以它的作用是"她还没开口之前，那一段静默里对方看到的是正在输入"——真正需要覆盖的是
 * 「第一个字出去之前」那段（打字节奏：一段十几个字要等十几秒，一趟总预算 90 秒）。
 * 取小了会在她还没说完时先消失，取大了（上限）没有任何额外代价。
 */
export const QQ_INPUT_NOTIFY_SECONDS = 60;

/** `sendInputNotify` 的结果：三类分得清清楚楚，**"不会发"不是"发失败"** */
export type QqInputNotifyOutcome =
  | { ok: true; messageId: string; passive: boolean }
  /** 这条通道能力上就不做这件事（群聊；或该 chatType 没有这条路）——不是错误，也不进日志 */
  | { ok: false; skipped: true; reason: string }
  /** 真的试了、平台/网络没答应——**调用方据此走"照旧说话"**，绝不让它影响发言 */
  | { ok: false; skipped: false; reason: string };

/** 该响应是不是"不接受原生 markdown"（错误码或文案任一命中） */
function isMarkdownRejected(response: HttpJsonResponse): boolean {
  const payload = asRecord(response.body);
  const code = readNumber(payload, 'code');
  if (code !== null && QQ_MARKDOWN_REJECT_CODES.includes(code)) return true;
  return readString(payload, 'message').includes('不允许发送原生 markdown');
}

/**
 * 各码的人话含义。用途只有一个：**回执里如实说清是哪一种**。
 *
 * 为什么要把它们分开：`40034127`（没有 markdown 模板权限）与 `40034011`（内容不合规）在
 * 处理上是两条路——前者要人去开放平台开权限、或干脆关掉 `useMarkdown`；后者是她那段正文
 * 自己要改。混成一句"发送失败"，她会一遍遍换措辞（这正是她现场卡住的那种循环）。
 */
const MARKDOWN_REJECT_WHY: Readonly<Record<number, string>> = {
  22006: '消息类型与内容不匹配',
  40034011: 'markdown 内容不被接受',
  40034124: 'markdown 参数不合法',
  40034127: '本 Bot 没有原生 markdown 模板权限',
};

/** 被拒的一句话理由（认得出的码给人话，认不出照抄服务端原话——不编） */
function markdownRejectReason(response: HttpJsonResponse): string {
  const payload = asRecord(response.body);
  const code = readNumber(payload, 'code');
  const message = readString(payload, 'message');
  const why = code === null ? '' : MARKDOWN_REJECT_WHY[code];
  if (why !== undefined) return `code=${code} ${why}`;
  const detail = [code === null ? '' : `code=${code}`, message].filter((part) => part !== '').join(' ');
  return detail === '' ? `HTTP ${response.status}` : detail;
}

const QQ_PROPERTIES = {
  $os: process.platform,
  $browser: 'irmia-agent',
  $device: 'irmia-agent',
} as const;

// ──────────────────────────────── HTTP 客户端（可注入） ────────────────────────────────

export interface HttpJsonRequest {
  /** 分片上传要 PUT 原始字节，所以这里不止 GET/POST */
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers?: Record<string, string>;
  jsonBody?: unknown;
  /**
   * **原始字节体**（与 jsonBody 二选一）：分片上传时把这一片直接 PUT 到预签名 URL。
   * 给了它就忽略 jsonBody（两种体不能同时出现）。
   */
  rawBody?: Uint8Array;
  timeoutMs?: number;
}

export interface HttpJsonResponse {
  status: number;
  /** 响应体文本（非 JSON 或缺体时为空串） */
  text: string;
  /** 已解析的 JSON（解析失败为 null） */
  body: unknown;
}

/** 注入点：测试用假实现断言"请求了什么、什么时候发的"，生产用下面的 defaultHttpJson */
export type HttpJsonFn = (request: HttpJsonRequest) => Promise<HttpJsonResponse>;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 默认实现：node:https 发 JSON 请求。
 *
 * 两条刻意的纪律：
 *   • **不看 HTTP 状态码判成败**——QQ 的凭证接口失败时也是 200，判定统一交给调用方看响应体；
 *     这里只把"传输层是否成功"和"对端给了什么"分开如实报出；
 *   • 3xx 不当成功：`location` 不自动跟随（网关与 API 都是固定地址，跟随重定向等于把凭证发给第三方）。
 */
export const defaultHttpJson: HttpJsonFn = async (input) => {
  const url = new URL(input.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`只支持 http(s) 请求，收到 ${url.protocol}`);
  }
  const payload = input.rawBody !== undefined
    ? Buffer.from(input.rawBody)
    : (input.jsonBody === undefined ? null : Buffer.from(JSON.stringify(input.jsonBody), 'utf8'));
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(input.headers ?? {}),
  };
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(payload.length);
  }

  return await new Promise<HttpJsonResponse>((resolve, reject) => {
    // http 与 https 各有一个 request：按 URL 协议分流（官方端点固定 https，明文只用在本机调试）
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === '' ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: input.method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = null;
          try {
            body = text.trim() === '' ? null : JSON.parse(text);
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode ?? 0, text, body });
        });
      },
    );
    req.setTimeout(input.timeoutMs ?? 15_000, () => {
      req.destroy(new Error(`请求超时（${input.timeoutMs ?? 15_000}ms）`));
    });
    req.on('error', (err) => { reject(new Error(`HTTP 请求失败（${input.url}）：${err.message}`)); });
    if (payload !== null) req.write(payload);
    req.end();
  });
};

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

// ──────────────────────────────── 凭证管理 ────────────────────────────────

export interface QqTokenLogger {
  info: (line: string) => void;
  warn: (line: string) => void;
}

export interface QqAccessTokenOptions {
  appId: string;
  clientSecret: string;
  tokenUrl?: string;
  /** 提前刷新窗口（毫秒），默认 DEFAULT_TOKEN_REFRESH_AHEAD_MS */
  refreshAheadMs?: number;
  http?: HttpJsonFn;
  now?: () => number;
  log?: QqTokenLogger;
}

export interface QqTokenSnapshot {
  hasToken: boolean;
  expiresAt: number;
  refreshing: boolean;
}

/**
 * access_token 管家：**缓存复用**是硬要求（每次调用都去换新 token 会把接口打成限流），
 * 而 `expires_in` 是字符串，`Number()` 兜住两种形态。
 *
 * 并发：`acquire()` 用 inflight promise 去重——同一时刻多个发送方只会触发一次换取，
 * 否则"并发发两条消息"就会变成"两次换 token"，第二次换发会让第一次拿到的那把立刻处于
 * 60 秒重叠窗口内，纯属自找麻烦。
 */
export class QqAccessToken {
  private readonly appId: string;
  private readonly clientSecret: string;
  private readonly tokenUrl: string;
  private readonly refreshAheadMs: number;
  private readonly http: HttpJsonFn;
  private readonly now: () => number;
  private readonly log: QqTokenLogger;

  private token: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<string> | null = null;
  /** 可观测计数（测试与排障用）：真实发生了多少次换取 */
  private fetchCount = 0;

  constructor(options: QqAccessTokenOptions) {
    this.appId = options.appId;
    this.clientSecret = options.clientSecret;
    this.tokenUrl = options.tokenUrl ?? DEFAULT_QQ_TOKEN_URL;
    this.refreshAheadMs = options.refreshAheadMs ?? DEFAULT_TOKEN_REFRESH_AHEAD_MS;
    this.http = options.http ?? defaultHttpJson;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? { info: () => {}, warn: () => {} };
  }

  snapshot(): QqTokenSnapshot {
    return { hasToken: this.token !== null, expiresAt: this.expiresAt, refreshing: this.inflight !== null };
  }

  /** 已换取的次数（缓存是否生效的直接证据） */
  get fetches(): number {
    return this.fetchCount;
  }

  /** 当前 token 是否还能用（未过期且不落在提前刷新窗口内） */
  isFresh(): boolean {
    return this.token !== null && this.now() < this.expiresAt;
  }

  /** 取一个可用 token：缓存够用就直接复用，否则换取（并发去重） */
  async acquire(): Promise<string> {
    if (this.isFresh()) {
      return this.token as string;
    }
    if (this.inflight !== null) return await this.inflight;
    this.inflight = this.fetch().finally(() => { this.inflight = null; });
    return await this.inflight;
  }

  /** 供 debug 工具/测试注入用：当前 token（不给就 null），绝不打进日志 */
  peek(): string | null {
    return this.token;
  }

  private async fetch(): Promise<string> {
    this.fetchCount += 1;
    const response = await this.http({
      method: 'POST',
      url: this.tokenUrl,
      jsonBody: { appId: this.appId, clientSecret: this.clientSecret },
      timeoutMs: 15_000,
    });
    const body = asRecord(response.body);
    const code = readNumber(body, 'code');
    const token = readString(body, 'access_token');
    if (token === '') {
      const detail = code !== null ? `code=${code} message=${readString(body, 'message')}` : `HTTP ${response.status}`;
      throw new Error(
        `换取 QQ access_token 失败（${detail}）：请核对 appId/clientSecret 与机器人状态。`
        + '凭证接口即使失败也返回 HTTP 200，因此这里以响应体 code 为准',
      );
    }
    const expiresIn = readNumber(body, 'expires_in') ?? 7200;
    // 官方语义：expires_in 秒；提前 refreshAheadMs 判过期，留出重叠窗口（官方 60 秒内换发新值）
    this.token = token;
    this.expiresAt = this.now() + expiresIn * 1000 - this.refreshAheadMs;
    this.log.info(
      `[QQ] access_token 已刷新：有效期 ${expiresIn}s，本进程将在 ${new Date(this.expiresAt).toISOString()} 后提前刷新`,
    );
    return token;
  }
}

// ──────────────────────────────── 事件解析 ────────────────────────────────

/** 附件：官方字段是 url / filename / content_type，这里做归一化（name 与 filename 都收） */
function readAttachments(source: Record<string, unknown>): WakeChannel['data']['attachments'] {
  const raw = source['attachments'];
  if (!Array.isArray(raw)) return undefined;
  const out: Array<{ type: string; url?: string; name?: string; text?: string }> = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (record === null) continue;
    const type = readString(record, 'content_type') || readString(record, 'type') || 'unknown';
    // 语音优先给 WAV 那条链（2026-10-03，官方文档确证）：url 是 SILK 原始文件（她打不开），
    // voice_wav_url 是平台转好的 WAV（文档原话："语音消息 SILK 等转换后的 WAV 文件 URL"）。
    // 拿不到才退回 url——宁可给原始文件，也别什么都不给。
    const wav = readString(record, 'voice_wav_url');
    const raw = readString(record, 'url');
    const url = type === 'voice' && wav !== '' ? wav : raw;
    const name = readString(record, 'filename') || readString(record, 'name');
    const transcript = readString(record, 'asr_refer_text');
    out.push({
      type,
      ...(url === '' ? {} : { url }),
      ...(name === '' ? {} : { name }),
      ...(transcript === '' ? {} : { text: transcript }),
    });
  }
  return out.length === 0 ? undefined : out;
}

/**
 * 事件体 → `wake/channel` 的 data（不适用的返回 null，调用方据此忽略）。
 *
 * msgSeq 的口径（**实证结论，非推测**）：官方事件体里**没有** msg_seq 字段——它是**出站**字段
 * （"回复消息的序号，与 msg_id 联合使用"）。所以这里把它记为 1，表示"对这条路消息的第一次回复"；
 * 真正的递增在 `QqOfficialChannel.sendText` 里按 messageId 维护（官方明确要求同一 msg_id 反复回复
 * 必须换 msg_seq，否则 40054005）。
 *
 * session_id 与 seq 在本文件由网关状态机持有，不进事件数据：它们是**传输层**会话凭据，
 * 写进上下文既无用又会让每次重启的请求体都不同（缓存前缀失效）。
 */
export function mapDispatchToWakeChannel(
  eventType: string,
  payload: Record<string, unknown>,
  channelName: string = QQ_CHANNEL_NAME,
): WakeChannel['data'] | null {
  // **频道（子频道）消息**：官方事件 `AT_MESSAGE_CREATE`（有人在子频道里 @ 了机器人）。
  // 身份与群聊不同：频道用 `author.id`（频道用户 id），会话 id 用 `channel_id`。
  const isGuild = eventType === 'AT_MESSAGE_CREATE';
  // **频道私信**：官方 `DIRECT_MESSAGE_CREATE`——身份是 `author.id`，会话 id 取 **guild_id**
  // （私信是「这个人所在服务器的私信频道」，发出去也是 `/dms/{guild_id}/messages`）。
  // 单开一个 chatType 而不是并进 c2c（AstrBot 并了，但那样两套 id 空间会混在一个命名空间里）。
  const isDm = eventType === 'DIRECT_MESSAGE_CREATE';
  const isC2c = eventType === 'C2C_MESSAGE_CREATE';
  const isGroupAt = eventType === 'GROUP_AT_MESSAGE_CREATE';
  // 全量群消息（2026-10-02 起接）：平台侧开了"接收所有消息"之后，群里的每一条都会推这个事件，
  // **Intent 与上面两个同一个位（1<<25）**，不是另一个订阅位——见 docs/design.md 那段的更正。
  // 它走的是"进信箱"那条路（main.ts 的 onChannelMessage 按 sid 判），不是无条件唤醒。
  const isGroupAll = eventType === 'GROUP_MESSAGE_CREATE';
  if (!isC2c && !isGroupAt && !isGroupAll && !isGuild && !isDm) return null;
  const id = readString(payload, 'id');
  if (id === '') return null; // 没有消息 id 就无法被动回复，也没有幂等键——宁可丢也不伪造
  const author = asRecord(payload['author']);
  const chatType: WakeChannel['data']['chatType'] =
    isGuild ? 'guild' : (isDm ? 'dm' : (isC2c ? 'c2c' : (isGroupAt ? 'group-at' : 'group')));
  const person = isGuild || isDm
    ? (readString(author, 'id') || readString(author, 'user_openid'))
    : (isC2c
      ? (readString(author, 'user_openid') || readString(author, 'id'))
      : (readString(author, 'member_openid') || readString(author, 'id')));
  // 频道：会话 id 取 **channel_id**（子频道），不是 guild_id——一个服务器里有多条子频道，
  // 而「在哪条子频道里说话」才是会话该有的粒度（与 AstrBot 的 GroupMessage:{channel_id} 同口径）。
  const chatId = isGuild
    ? readString(payload, 'channel_id')
    : (isDm ? readString(payload, 'guild_id') : (isC2c ? person : readString(payload, 'group_openid')));
  if (chatId === '') return null;
  const attachments = readAttachments(payload);
  const mentions = readMentions(payload);
  // **昵称**：官方事件体的 `author.username` 里就有（2026-10-02 查官方文档确认：
  // `GROUP_AT_MESSAGE_CREATE.author = {id, member_openid, member_role, username, …}`，
  // 示例里写着"小明"；AstrBot 的 PR #2626 正是在修"没读这个字段"）。
  // 之前本适配器只取 openid，于是她在群里看到的每个人都叫"甲（id …9F56）"——明明是官方给了名字的。
  // 取来只作**显示**：身份仍按 member_openid/user_openid 判（昵称谁都能改，见 self-brief"名字不是身份"）。
  const nickname = readString(author, 'username').trim();
  // 群角色（member/admin/owner）：官方群消息事件里带，私聊没有。只作**显示**——
  // 她该知道谁是群主，但框架不因为"他是群主"就多信他一分（判据永远是 id）。
  const memberRole = readString(author, 'member_role').trim();
  return {
    channel: channelName,
    chatType,
    person,
    chatId,
    ...(nickname === '' ? {} : { nickname }),
    ...(memberRole === '' ? {} : { memberRole }),
    text: quotedPrefix(payload) + readableContent(readString(payload, 'content')),
    messageId: id,
    // 0 = 平台没给"这条是会话里的第几条"（官方事件体里就没有这个字段）。信箱那条路会在
    // 落库时补成事件 seq（见 main.ts 的 appendWithSeq）；c2c/@ 那两类走唤醒，保持 1 ——
    // 它的原义是"对这条路消息的第一次被动回复"（真正的递增在 QqMessageSender 里按 messageId 维护）。
    msgSeq: isGroupAll ? 0 : 1,
    ...(attachments === undefined ? {} : { attachments }),
    // 这条是不是 @ 了她：group-at 天然是；全量群消息里只能看 `mentions`（content 的 @ 前缀被官方
    // 去掉了，而群里每个人的 openid 是按群隔离的，比对不了"自己的 openid"——只认 mentions 里
    // 有没有机器人）。**只作线索记录，不拿它改 chatType**：唤醒语义绑在 group-at 上，
    // 按它分流会让同一个群出现两套说法（见 channel/inbox.ts 那段）。
    // 群里要 @ 才算点到你；频道 @ 事件本身就是 @；**频道私信**是点对点，天然算。
    ...(isGroupAt || isGuild || isDm || (mentions?.some((m) => m.bot === true) ?? false) ? { mentionsMe: true } : {}),
    ...(mentions === undefined ? {} : { mentionsMe: mentions.some((m) => m.bot === true) }),
    ...(mentions === undefined ? {} : { mentions }),
    /**
     * 幂等键：**带通道命名空间**，与 OneBot 那条同形（`onebot:<messageId>`）。
     *
     * 原先这里是裸 `id`（与上面 `:67` 那句注释说的"通道名是 dedupeKey 命名空间的前缀来源"
     * 相反）。今天没出故障，因为两平台的 id 形状不撞（官方是 117–137 字符的 `ROBOT1.0_…`、
     * OneBot 是数字串）；但 `state/fold.ts` 把两条通道的键放进**同一个扁平数组**去重，
     * 一旦 id 出现交集，表现是**一条通道的消息被另一条静默丢掉**（那里是 `break`，连日志都没有）。
     * 一行加固：id 的归属写进键里，跨通道撞键从"靠形状侥幸"变成"不可能"。
     */
    dedupeKey: `${channelName}:${id}`,
  };
}

/**
 * 正文里的两串"机器话"换成她能读的写法（2026-10-02，对齐 AstrBot 的做法）：
 *
 *   • **@ 标记**：`<@A1B2…>` / `<@!A1B2…>` / `<qqbot-at-user id="A1B2…" />` —— 原来原样进她的
 *     上下文（实测她读到的就是 `<@23757A4ED946257ECBB87585D20A9F56>` 这种一串 id）。
 *     现在换成 `@…9F56`（tail 四位）：她分得清"这几句 @ 的不是同一个人"，也不必读 32 位乱码；
 *     **只作可读化，不作身份判定**——身份永远看 `author`（见 self-brief"名字不是身份"）。
 *   • **表情**：`<faceType=6,faceId="0",ext="<base64>">` —— ext 里是 base64 的 JSON，里面有
 *     `text`（表情名）。解出来写成 `[表情:微笑]`，解不出就写 `[表情]`（**不编名字**）。
 *
 * 刻意**不碰**的：markdown、代码块、以及任何 `<>` 里不是上面两种形状的东西——宁可留着原样，
 * 也不猜（猜错等于篡改她看到的话）。
 */
/**
 * 引用消息（`message_type === 103`）的**被引那句话**，取出来摆在本条正文前面。
 *
 * 为什么（2026-10-02 缺口报告第 ④ 项，AstrBot 有、我们没有）：群里"回复某一句"的语义全在被引
 * 的那句话里——只看正文，她读到的是一句没头没尾的话（"这个不行"到底指哪个？）。
 *
 * 形状：`[引用 @…9F56 原话]` + 正文。**只在 103 上做**：普通消息的 `msg_elements` 里也有
 * 自己的正文，不认这个标记就会把消息本身当成"被引用的那句"（张冠李戴）。
 * 被引原话截到 80 字（她要的是"在说哪件事"，不是逐字转录；全文她自己有办法去看）。
 *
 * **这个前缀不是"发信人自己的话"**：被引的常常就是她刚说的那句（用户回复她时）。所以注入
 * 判定与引文把它整个排除在外——消费者是 `channel/injection.ts` 的 `speakerWordsOf`，改这里的
 * 形状要同时改那里（同一条约定的两端，见那个函数的注释：用她自己的话给她定罪是"框架在骗她"）。
 */
function quotedPrefix(payload: Record<string, unknown>): string {
  if (Number(payload['message_type']) !== 103) return '';
  const elements = Array.isArray(payload['msg_elements']) ? payload['msg_elements'] : [];
  for (const raw of elements) {
    const element = asRecord(raw);
    if (element === null) continue;
    const quoted = readString(element, 'content').replace(/\s+/gu, ' ').trim();
    if (quoted === '') continue;
    const author = asRecord(element['author']);
    const id = author === null
      ? ''
      : (readString(author, 'member_openid') || readString(author, 'id'));
    const who = id === '' ? '' : `${atLabel(id)} `;
    const clip = [...quoted].length <= 80 ? quoted : `${[...quoted].slice(0, 80).join('')}…`;
    return `[引用 ${who}${clip}] `;
  }
  return '';
}

function readableContent(raw: string): string {
  if (raw === '') return raw;
  return raw
    .replace(/<qqbot-at-user\s+id="([^"]+)"\s*\/?>/gu, (_m, id: string) => atLabel(id))
    .replace(/<@!?([0-9A-Za-z_-]{8,})>/gu, (_m, id: string) => atLabel(id))
    .replace(/<faceType=\d+,\s*faceId="[^"]*"(?:,\s*ext="([^"]*)")?\s*\/?>/gu,
      (_m, ext: string | undefined) => faceLabel(ext));
}

/** `@…9F56`：留尾四位，够分清是谁，又不摆 32 位乱码 */
function atLabel(id: string): string {
  const tail = id.length <= 4 ? id : id.slice(-4);
  return `@…${tail}`;
}

/** 表情名从 `ext` 的 base64 JSON 里取（`{"text":"微笑",…}`）；解不出就只写 `[表情]` */
function faceLabel(ext: string | undefined): string {
  if (ext === undefined || ext === '') return '[表情]';
  try {
    const json = Buffer.from(ext, 'base64').toString('utf8');
    const name = (JSON.parse(json) as { text?: unknown }).text;
    return typeof name === 'string' && name.trim() !== '' ? `[表情:${name.trim()}]` : '[表情]';
  } catch {
    return '[表情]';
  }
}

/**
 * 事件体里的 `mentions`（消息里 @ 了谁）。
 *
 * 为什么只留 `bot` 这一个字段：它是**唯一**在群里判"@ 的是不是机器人"的可用信号——
 * 群里每个人的 openid 是**按群隔离**的（`member_openid`），我们拿不到"自己在某个群里的 openid"，
 * 所以比对不了 id。其余字段（昵称等）没有判据价值，不进事件数据。
 */
function readMentions(source: Record<string, unknown>): Array<{ bot: boolean }> | undefined {
  const raw = source['mentions'];
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .map((item) => asRecord(item))
    .filter((record): record is Record<string, unknown> => record !== null)
    .map((record) => ({ bot: record['bot'] === true }));
  return out.length === 0 ? undefined : out;
}

// ──────────────────────────────── 网关状态机 ────────────────────────────────

export interface QqGatewayOptions {
  /** 取 token（内部会转成 `QQBot {token}` 形式） */
  token: () => Promise<string>;
  /** 网关地址提供者：默认 GET {apiBase}/gateway；测试用假网关直连地址 */
  gatewayUrl?: () => Promise<string>;
  apiBase?: string;
  http?: HttpJsonFn;
  intents?: number;
  shard?: [number, number];
  /** 事件里写的通道名（默认 qq-official；测试可用别名区分多实例） */
  channelName?: string;
  /** 连接工厂覆盖点（测试注入本地假网关） */
  connect?: (url: string, options: WsConnectOptions) => Promise<WsClient>;
  /** 未收到 Hello 时的兜底心跳/读超时（毫秒） */
  heartbeatIntervalMs?: number;
  /** 退避起点与上限（毫秒） */
  reconnectBaseMs?: number;
  maxReconnectDelayMs?: number;
  /** 关闭握手等待（毫秒） */
  closeTimeoutMs?: number;
  now?: () => number;
  log?: QqTokenLogger;
  /** 定时器覆盖点（测试注入可控时钟） */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  /** 收到 `wake/channel` 数据（已转成事件形状）时的落地口 */
  onWake: (data: WakeChannel['data']) => void;
}

interface TimerHandle { id: unknown }

/**
 * 退避延迟：`min(起点 × 2^已失败次数, 上限)`。
 *
 * 抽成纯函数是刻意的："退避值算得对"是一条能独立断言的性质，不该依赖
 * "真的断线三次再观察日志"——那种测法既慢又能被网络时序搅浑。
 */
export function reconnectDelayMs(attempts: number, baseMs: number, maxMs: number): number {
  const safeAttempts = Math.max(0, Math.trunc(attempts));
  return Math.min(baseMs * 2 ** safeAttempts, maxMs);
}

/**
 * 网关连接状态机。
 *
 * 生命周期：`start()` → 连网关 → Hello → (有 session 则 Resume，否则 Identify) → 心跳循环
 * → Dispatch 事件 → 断线记 `session_id`/`s` → 退避重连 → Resume 补发。
 *
 * 两条硬纪律：
 *   • **断线后优先 Resume**：`{token, session_id, seq: 最后 s}` 能让网关补发漏掉的事件；
 *     Resume 失败（op9 Invalid Session / 没有 session）则退回 Identify，且**清空 session**
 *     （继续拿一个失效的 session 去 Resume 只会一直失败）；
 *   • **退避封顶 5 分钟**：`min(base × 2^n, max)`，其中 n **只在连接成功且鉴权完成后**清零——
 *     如果一连上就清零，一个"连上就被踢"的坏网关会让它变成 1 秒一次的锤击。
 */
export class QqGateway {
  private readonly options: QqGatewayOptions;
  private readonly log: QqTokenLogger;
  private readonly now: () => number;
  private readonly timeout: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeout: (handle: unknown) => void;
  private readonly setInterval: (fn: () => void, ms: number) => unknown;
  private readonly clearInterval: (handle: unknown) => void;
  private readonly connectFn: (url: string, options: WsConnectOptions) => Promise<WsClient>;

  private client: WsClient | null = null;
  private started = false;
  private stopping = false;
  private connected = false;
  /** 主动消息被平台拒收的次数（与时刻）：用于 status 快照与排障 */
  private rejectedCount = 0;
  private lastRejectedAt: number | null = null;

  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private heartbeatIntervalMs: number;

  private heartbeatTimer: TimerHandle | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private reconnectAttempts = 0;
  private lastReadyAt: number | null = null;

  constructor(options: QqGatewayOptions) {
    this.options = options;
    this.log = options.log ?? { info: () => {}, warn: () => {} };
    this.now = options.now ?? (() => Date.now());
    this.timeout = options.setTimeoutFn ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.clearTimeout = options.clearTimeoutFn ?? ((handle) => {
      if (handle !== null && handle !== undefined) clearTimeout(handle as NodeJS.Timeout);
    });
    this.setInterval = options.setIntervalFn ?? ((fn, ms) => { const t = setInterval(fn, ms); return t; });
    this.clearInterval = options.clearIntervalFn ?? ((handle) => {
      if (handle !== null && handle !== undefined) clearInterval(handle as NodeJS.Timeout);
    });
    this.connectFn = options.connect ?? wsConnect;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  /** 可观测状态（测试与 CLI 状态页用；不含 token 等敏感值） */
  snapshot(): {
    connected: boolean; sessionId: string | null; lastSeq: number | null;
    heartbeatIntervalMs: number; reconnectAttempts: number; hasClient: boolean;
  } {
    return {
      connected: this.connected,
      sessionId: this.sessionId,
      lastSeq: this.lastSeq,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      reconnectAttempts: this.reconnectAttempts,
      hasClient: this.client !== null,
    };
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
    this.stopHeartbeat();
    const client = this.client;
    this.client = null;
    this.connected = false;
    if (client !== null) client.close(1000, 'agent stopping');
  }

  /**
   * 断开后重连（供外部强制触发；正常路径由 onClose 自动走）。
   * 保留 sessionId/lastSeq：Resume 的价值全在这两个值上。
   */
  requestReconnect(reason: string): void {
    if (this.stopping) return;
    this.log.warn(`[QQ/网关] 要求重连：${reason}`);
    this.connected = false;
    this.stopHeartbeat();
    const client = this.client;
    this.client = null;
    if (client !== null) client.close(1000, 'reconnect');
    this.scheduleReconnect();
  }

  // ── 连接 ──

  private async openOnce(): Promise<void> {
    if (this.stopping) return;
    let url: string;
    try {
      url = await this.resolveGatewayUrl();
    } catch (err) {
      this.log.warn(`[QQ/网关] 取网关地址失败：${messageOf(err)}`);
      this.scheduleReconnect();
      return;
    }
    let client: WsClient;
    try {
      client = await this.connectFn(url, {
        // 读超时按"心跳间隔 × 2"初始化；收到 Hello 后会按官方下发值重设（见 setReadTimeout）
        readTimeoutMs: this.heartbeatIntervalMs * 2,
        ...(this.options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: this.options.closeTimeoutMs }),
        onDebug: (line) => { this.log.info(`[QQ/网关] ${line}`); },
      });
    } catch (err) {
      this.log.warn(`[QQ/网关] 连接失败（${url}）：${messageOf(err)}`);
      this.scheduleReconnect();
      return;
    }

    this.client = client;
    client.onMessage((message) => { this.handleMessage(message.text); });
    client.onError((err) => { this.log.warn(`[QQ/网关] 传输层错误：${err.message}`); });
    client.onClose((info) => {
      if (this.client !== client) return; // 已被替换（重连/停止）的旧连接，忽略它的收尾
      this.client = null;
      this.connected = false;
      this.stopHeartbeat();
      if (this.stopping) return;
      this.log.warn(
        `[QQ/网关] 连接断开（code=${info.code ?? '无'}，${info.byLocal ? '本地发起' : '对端/超时'}`
        + `${info.reason === '' ? '' : `，${info.reason}`}），准备重连`,
      );
      this.scheduleReconnect();
    });
    this.log.info(`[QQ/网关] 已连上 ${url}，等待 Hello`);
  }

  private async resolveGatewayUrl(): Promise<string> {
    const provided = this.options.gatewayUrl;
    if (provided !== undefined) return await provided();
    const apiBase = (this.options.apiBase ?? DEFAULT_QQ_API_BASE).replace(/\/+$/, '');
    const token = await this.options.token();
    const response = await (this.options.http ?? defaultHttpJson)({
      method: 'GET',
      url: `${apiBase}/gateway`,
      headers: { authorization: `QQBot ${token}` },
      timeoutMs: 15_000,
    });
    const body = asRecord(response.body);
    const url = readString(body, 'url');
    if (url === '') {
      throw new Error(`网关接口未返回 url（HTTP ${response.status}）：${response.text.slice(0, 200)}`);
    }
    const parsed = parseWsUrl(url);
    if (!parsed.ok) throw new Error(`网关返回的地址不可用：${parsed.error}`);
    return url;
  }

  // ── 收消息 ──

  private handleMessage(raw: string): void {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = asRecord(JSON.parse(raw) as unknown);
    } catch {
      this.log.warn(`[QQ/网关] 收到非法 JSON（${raw.length} 字节），已忽略`);
      return;
    }
    if (payload === null) return;
    const op = readNumber(payload, 'op');
    const seq = readNumber(payload, 's');
    // s 只在合法的下行消息上出现，且它是 Resume 的锚点：收到就记，晚一步就可能重复补发
    if (seq !== null) this.lastSeq = seq;
    switch (op) {
      case QQ_OP.hello:
        this.onHello(asRecord(payload['d']));
        return;
      case QQ_OP.dispatch:
        this.onDispatch(readString(payload, 't'), asRecord(payload['d']));
        return;
      case QQ_OP.heartbeatAck:
        return;
      case QQ_OP.heartbeat:
        // 官方定义 op1 是双向的：对端发来也回一个（带最新 s），保持协议对称
        this.sendHeartbeat();
        return;
      case QQ_OP.reconnect:
        this.requestReconnect('服务端下发 op7');
        return;
      case QQ_OP.invalidSession:
        // op9：identify 或 resume 的参数有错。清 session 重 Identify（继续 Resume 只会再失败一次）
        this.log.warn('[QQ/网关] 服务端判定会话无效（op9），清空 session 后重新 Identify');
        this.sessionId = null;
        this.lastSeq = null;
        this.identify();
        return;
      default:
        this.log.info(`[QQ/网关] 忽略未知 opcode：${op === null ? '无' : op}`);
    }
  }

  private onHello(data: Record<string, unknown> | null): void {
    const interval = readNumber(data, 'heartbeat_interval');
    if (interval !== null && interval > 0) {
      this.heartbeatIntervalMs = interval;
      // 读超时跟随官方下发的心跳周期：2 倍宽限（与网关自己的判死逻辑一致）
      this.client?.setReadTimeoutMs?.(interval * 2);
    }
    if (this.sessionId !== null) {
      this.log.info(`[QQ/网关] Hello（心跳 ${this.heartbeatIntervalMs}ms），尝试 Resume 会话 ${this.sessionId}`);
      this.resume();
    } else {
      this.log.info(`[QQ/网关] Hello（心跳 ${this.heartbeatIntervalMs}ms），发送 Identify`);
      this.identify();
    }
  }

  private onDispatch(eventType: string, data: Record<string, unknown> | null): void {
    if (eventType === 'READY') {
      this.sessionId = readString(data, 'session_id');
      this.connected = true;
      this.lastReadyAt = this.now();
      // 鉴权真正完成才清退避：只在"连上"时清零会被"连上就被踢"的网关变成 1 秒锤击
      this.reconnectAttempts = 0;
      this.log.info(`[QQ/网关] READY，session ${this.sessionId === '' ? '（未下发）' : this.sessionId}`);
      this.startHeartbeat();
      return;
    }
    if (eventType === 'RESUMED') {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.log.info('[QQ/网关] RESUMED：漏掉的会话事件已补发');
      this.startHeartbeat();
      return;
    }
    if (eventType === '') return;
    // **拒收事件**（缺口报告第 ③ 项）：用户在客户端关掉「允许主动发送」后，平台推
    // C2C_MSG_REJECT / GROUP_MSG_REJECT——订阅位一直在（1<<25），我们只是没处理。
    // 没有它的时候，"发了没到"只看得到一条发送失败、看不到**原因**。
    if (eventType === 'C2C_MSG_REJECT' || eventType === 'GROUP_MSG_REJECT') {
      const openid = readString(data ?? {}, 'openid') || readString(data ?? {}, 'group_openid');
      const target = eventType === 'C2C_MSG_REJECT' ? '单聊' : '群聊';
      const who = openid === '' ? '' : ' · ' + openid.slice(0, 8) + '…';
      this.log.warn(
        '[QQ] 主动消息被拒（' + target + who + '）：对方在客户端关掉了「允许主动发送」'
          + '——被动回复不受影响，主动推送一律失败。',
      );
      this.rejectedCount += 1;
      this.lastRejectedAt = this.now();
      return;
    }
    // 每条分发都留一行：这个适配器里**只有这里**能回答"QQ 到底推没推"。
    // 2026-10-02 那次"群里 @ 了她却没反应"就是卡在这儿——日志里既没有"收到了但没认"，
    // 也没有"压根没推"的凭据，只能从事件日志反推。只记类型与消息 id 前 12 位：
    // 够把一条消息对上，又不把群里的正文抄进日志。
    const hint = readString(data ?? {}, 'id').slice(0, 12);
    this.log.info(`[QQ/网关] 收到分发：${eventType}${hint === '' ? '' : ` · ${hint}…`}`);
    const wake = mapDispatchToWakeChannel(eventType, data ?? {}, this.options.channelName ?? QQ_CHANNEL_NAME);
    if (wake === null) {
      // 非文本类订阅事件（FRIEND_ADD / GROUP_ADD_ROBOT 等）不产生 wake：它们不是"对我说的话"
      return;
    }
    this.options.onWake(wake);
  }

  // ── 发 ──

  private sendRaw(value: unknown): void {
    this.client?.sendJson(value);
  }

  private identify(): void {
    void this.options.token().then((token) => {
      if (this.stopping) return;
      this.sendRaw({
        op: QQ_OP.identify,
        d: {
          token: `QQBot ${token}`,
          intents: this.options.intents ?? QQ_INTENTS_GROUP_AND_C2C,
          shard: this.options.shard ?? [0, 1],
          properties: QQ_PROPERTIES,
        },
      });
    }).catch((err: unknown) => {
      this.log.warn(`[QQ/网关] Identify 失败：${messageOf(err)}`);
      this.scheduleReconnect();
    });
  }

  private resume(): void {
    const sessionId = this.sessionId;
    if (sessionId === null) {
      this.identify();
      return;
    }
    void this.options.token().then((token) => {
      if (this.stopping) return;
      this.sendRaw({
        op: QQ_OP.resume,
        d: { token: `QQBot ${token}`, session_id: sessionId, seq: this.lastSeq },
      });
    }).catch((err: unknown) => {
      this.log.warn(`[QQ/网关] Resume 失败：${messageOf(err)}`);
      this.sessionId = null;
      this.scheduleReconnect();
    });
  }

  private sendHeartbeat(): void {
    this.sendRaw({ op: QQ_OP.heartbeat, d: this.lastSeq });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // 箭头函数包一层：直接把 this.sendHeartbeat 交给定时器工厂会让 this 悬空
    this.heartbeatTimer = { id: this.setInterval(() => { this.sendHeartbeat(); }, this.heartbeatIntervalMs) };
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === null) return;
    this.clearInterval(this.heartbeatTimer.id);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    if (this.reconnectTimer !== null) return; // 已排定的一拍不许被重复排（否则断线风暴会把定时器堆起来）
    const base = this.options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    const max = this.options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    const delay = reconnectDelayMs(this.reconnectAttempts, base, max);
    this.reconnectAttempts += 1;
    // 亚秒级延迟按毫秒显示：写作"0s"的日志等于在说谎（重连间隔本身就是最需要看清的量）
    const human = delay < 1000 ? `${delay}ms` : `${Math.round(delay / 1000)}s`;
    const maxHuman = max < 1000 ? `${max}ms` : `${Math.round(max / 1000)}s`;
    this.log.warn(`[QQ/网关] ${human} 后重连（第 ${this.reconnectAttempts} 次，退避上限 ${maxHuman}）`);
    this.reconnectTimer = {
      id: this.timeout(() => {
        this.reconnectTimer = null;
        void this.openOnce();
      }, delay),
    };
  }
}

// ──────────────────────────── 出站正文：一个字都不动（2026-10-05） ────────────────────────────

/*
 * **出站正文一律逐字节发出去**，@ 的写法也不例外。
 *
 * 这里原来有一层便利（`renderOutboundMentions`）：把 `[@名字]` / `<@id>` 查成 openid、再改写成
 * 官方形态 `<qqbot-at-user id="…" />`；名字认不出来时**一个字都不发**（怕"她说 @ 了人、其实谁
 * 都没亮"的静默失败）。2026-10-05 用户决定移除，原话：**「我觉得没必要存在。搞完告知她已经移除了就行」**。
 * 两条理由都是事实，不是取舍：
 *   ① **她本人就会写官方形态**：那一串（连同 **我们这一侧**看到的 openid）就记在她自己的
 *      `MEMORIES/aliases.md` 群成员段里——形态与 id 都在她手上。框架替她做这一步，等于把她的
 *      资产搬进框架，中间还多一跳会出错的地方；
 *   ② 它**真的卡过她**：那层判据因为一个读表路径错误，把她整条消息拦下、一个字都没发出去。
 *
 * 所以现在只有一条判据：**正文原样出站**（分段照旧由 `chat-split` 决定）。
 * `[@1 号]`、`<@D37C…>` 都只是普通文字，照发；这里**不认**任何标记，**也不拒发**。
 *
 * 官方形态与"openid 按群隔离"这两条协议知识仍然有效——入站方向仍在剥它（见上面「正文里的
 * 机器话」那段与 `readableContent`）；写给她看的口径在 docs/design.md §4.20.1。
 */

// ──────────────────────────────── 发送（REST） ────────────────────────────────

/**
 * 回投地址里认的会话类型。
 *
 * `group` 与 `group-at` **发出去是同一条路**（`/v2/groups/<id>/messages`），差别只在
 * "有没有 msg_id 可带"——那是**每条消息**的事（被动回复窗口），不是会话的事。
 * 2026-10-02 会话身份归一之后，回投地址统一写 `group`：sid 与回投地址仍然是同一个串
 * （`sessions.ts` 那条不变量），她说"发给谁"和系统"往哪发"不会分家。
 */
export type QqChatType = 'c2c' | 'group-at' | 'group' | 'guild' | 'dm';

export interface SendTextOptions {
  /** 被动回复的消息 id（C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE 的 d.id） */
  msgId?: string;
  /** 被动回复序号；不给则按本适配器的递增器取（官方要求同一 msg_id 每次回复都要换值） */
  msgSeq?: number;
}

export type SendOutcome =
  | {
    ok: true;
    messageId: string;
    passive: boolean;
    msgSeq: number;
    /**
     * **如实回报的降级**：这条本来是 markdown、被服务端拒了，最后按纯文本发出去的。
     *
     * 为什么要把它带回来（2026-10-05）：`ok: true` 只说明"话发出去了"，可"这条 @ 有没有生效"
     * 是另一件事——机器人没有 markdown 权限时，出站形态与她的预期不同，回执里必须说清楚，
     * 否则就是"以为发出去了、其实没 @ 到"的静默失败。消费它是 `tools/admin.ts` 的回执那一行。
     */
    degraded?: string;
  }
  | { ok: false; reason: string; passive: boolean };

/** 官方发送接口的单条路径（chatType → URL 模板） */
/**
 * 发消息的路径。**频道（guild）是另一套接口**：`/channels/{channel_id}/messages`（v1），
 * 单聊与群聊走 v2。AstrBot 的频道分支还要删掉 `msg_type` 字段（v1 不认它）。
 */
export function messagesPathOf(chatType: QqChatType, chatId: string): string {
  const id = encodeURIComponent(chatId);
  if (chatType === 'guild') return `/channels/${id}/messages`;
  // 频道私信是第三条路：`/dms/{guild_id}/messages`（AstrBot 的 DirectMessage 分支，同样去 msg_type）
  if (chatType === 'dm') return `/dms/${id}/messages`;
  return chatType === 'c2c' ? `/v2/users/${id}/messages` : `/v2/groups/${id}/messages`;
}
/**
 * 官方口径的分片阈值：**文件前 10002432 字节**（约 10MiB）——`md5_10m` 取的就是这一段。
 * 超过它就要求走分片上传（单次 base64 那条路只适合小文件）。
 */
export const QQ_CHUNK_HASH_BYTES = 10_002_432;

/** 是否该走分片：本地字节数超过官方那个阈值 */
export function needsChunkedUpload(byteLength: number): boolean {
  return byteLength > QQ_CHUNK_HASH_BYTES;
}

/** 预上传地址（分片第一步） */
function uploadPreparePathOf(chatType: QqChatType, chatId: string): string {
  return chatType === 'c2c'
    ? `/v2/users/${chatId}/upload_prepare`
    : `/v2/groups/${chatId}/upload_prepare`;
}

/** 分片完成确认地址（每片 PUT 成功后调） */
function uploadPartFinishPathOf(chatType: QqChatType, chatId: string): string {
  return chatType === 'c2c'
    ? `/v2/users/${chatId}/upload_part_finish`
    : `/v2/groups/${chatId}/upload_part_finish`;
}

/** 响应里报告的是不是"去重撞车" */
function isDedupeRejected(reason: string): boolean {
  return QQ_DEDUPE_CODES.some((code) => reason.includes(String(code)));
}

/**
 * 撞车后换一个新序号：在 1..10000 里随机取一个、且与刚用过的那个不同。
 * 为什么随机而不是继续 +1：那个号可能已被**另一个进程**（重启前的那次）用过——只有换到一个
 * 没被用过的号才解决问题，而"哪些用过"我们无从知道（它不是我们的账）。
 */
function freshSeq(used: number): number {
  for (let i = 0; i < 8; i += 1) {
    const candidate = 1 + Math.floor(Math.random() * 10_000);
    if (candidate !== used) return candidate;
  }
  return used === 1 ? 2 : 1;
}

/** 富媒体上传地址（单聊与群聊**不互通**，官方口径） */
function filesPathOf(chatType: QqChatType, chatId: string): string {
  return chatType === 'c2c' ? `/v2/users/${chatId}/files` : `/v2/groups/${chatId}/files`;
}

/** 官方文件类型：1=图片 2=视频 3=语音 4=文件 */
export type QqFileType = 1 | 2 | 3 | 4;

/** 上传入参：网络地址或本地字节二选一 */
export interface QqMediaInput {
  fileType: QqFileType;
  /** 网络地址（与 data 二选一） */
  url?: string;
  /** 本地字节（与 url 二选一）——走 base64 的 file_data */
  data?: Uint8Array;
  /** 文件名（可选；文件类建议给） */
  name?: string;
}

/** 流式分片的结果：`streamMsgId` 首片由服务端给出，续片照抄 */
export type QqStreamOutcome =
  | { ok: true; streamMsgId: string; remainMsgLen: number; index: number }
  | { ok: false; reason: string };

export type QqUploadOutcome =
  | { ok: true; fileInfo: string; fileUuid: string; ttl: number }
  | { ok: false; reason: string };


export interface QqSenderOptions {
  token: () => Promise<string>;
  apiBase?: string;
  http?: HttpJsonFn;
  log?: QqTokenLogger;
  /** dedupe 判定注入点（测试断言递增） */
  nextSeq?: (messageId: string) => number;
  /**
   * 发文本时用**原生 markdown**（`msg_type: 2`）。**默认开**：开了她写的 Markdown 才能在
   * QQ 里真正渲染；机器人没有 markdown 权限时服务端会拒绝，这里自动降级为纯文本重发。
   * 若那个机器人根本没权限、而你又不想每次多花一个失败请求，把它关掉。
   */
  useMarkdown?: boolean;
  /** 时钟（可注入：ttl 过期这件事要能在用例里拨动） */
  now?: () => number;
}

/**
 * 出站发送器。
 *
 * 被动（带 msg_id）优先：它复用平台给的回复窗口，不消耗主动消息频控配额；
 * 窗口语义（**官方原文**）：单聊 60 分钟 / 同一条消息最多 4 次，群聊 5 分钟 / 最多 5 次。
 * 窗口过期或次数用尽时官方会拒绝（304103 / 40034005 / 40034128），这时**降级为主动消息重发一次**——
 * 目的是"不丢回复"，且绝不假装被动（不带 msg_id 的请求本身就是主动消息）。
 *
 * msg_seq：同一 msg_id 反复回复必须换值（否则 40054005「消息被去重」）。
 */
/** 上传结果缓存：同一份字节在 ttl 内不必重传 */
interface UploadCacheEntry {
  fileInfo: string;
  fileUuid: string;
  ttl: number;
  /** 本地判过期用（毫秒）；ttl=0（官方"可长期使用"）时给一个保守上限 */
  expiresAt: number;
}

/** 缓存条数上限（超了丢最早的一条；发送是长跑进程，不能让它无限长） */
const UPLOAD_CACHE_MAX = 50;
/** ttl=0（官方"可长期使用"）时的保守上限：一天 */
const UPLOAD_CACHE_FALLBACK_MS = 24 * 60 * 60 * 1000;

export class QqMessageSender {
  /**
   * **上传结果缓存**（2026-10-03，对齐 AstrBot 没有、但官方 ttl 明确允许的那一步）。
   *
   * 只缓存**本机字节**：键是内容的 sha256——同一份字节必然同一份文件，复用 `file_info` 不会
   * 发错东西。网络地址**一律重传**：同一个 URL 背后的内容随时可能变，拿旧凭据发出去就是发错
   * （这条边界与"零依赖也要能证明"是一个道理）。
   */
  private readonly uploadCache = new Map<string, UploadCacheEntry>();
  /** 时钟（可注入：ttl 过期这件事要能在用例里拨动） */
  private readonly now: () => number;

  private readonly options: QqSenderOptions;
  private readonly apiBase: string;
  private readonly http: HttpJsonFn;
  private readonly log: QqTokenLogger;
  private readonly seqCounters = new Map<string, number>();
  private readonly nextSeqFn: (messageId: string) => number;

  constructor(options: QqSenderOptions) {
    this.now = options.now ?? (() => Date.now());
    this.options = options;
    this.apiBase = (options.apiBase ?? DEFAULT_QQ_API_BASE).replace(/\/+$/, '');
    this.http = options.http ?? defaultHttpJson;
    this.log = options.log ?? { info: () => {}, warn: () => {} };
    this.nextSeqFn = options.nextSeq ?? ((messageId) => this.bumpSeq(messageId));
  }

  /**
   * 「正在输入」的三个观测计数（**观测面只有这一处**，不写进事件日志）。
   *
   * 为什么落在发送器（真正发请求的那一层）而不是 `admin`（决定"要不要发"的那一层）：
   * 失败的真凭据在这里——平台错误码就在这个函数手里。而事件日志的类型表是只读契约
   * （`log/types.ts`），一个零成本的可选动作不配在它上面开一个新事件类型。
   *   • `attempts`：真发出去的请求数（群里那条路**不算**——它是合法的"不发"）；
   *   • `sent`：平台答应了的次数；
   *   • `failed` = attempts − sent，每一次都配一行 `log.warn`（配额出问题时人看得见）。
   */
  private inputNotifyAttempts = 0;
  private inputNotifySent = 0;
  private inputNotifyFailed = 0;

  /**
   * 发送器的观测快照（CLI/测试用）：今天只有「正在输入」那三个数。
   *
   * 与 `QqOfficialChannel.snapshot()` 同一个成例（那个把网关与凭证的快照拼在一起）——
   * 通道那一层把它原样透出去，于是"她怎么不显示正在输入"这个问题有一条**只读**的答案：
   * `attempts === 0` ⇒ 根本没走到通道（群里 / 开关关了 / 没有回投地址）；
   * `attempts > 0 && sent === 0` ⇒ 走了但平台不要（去 `log.warn` 那行看错误码）。
   */
  snapshot(): { inputNotify: { attempts: number; sent: number; failed: number } } {
    return {
      inputNotify: {
        attempts: this.inputNotifyAttempts,
        sent: this.inputNotifySent,
        failed: this.inputNotifyFailed,
      },
    };
  }

  /** 同一条消息的回复序号递增（从 2 起：第一条被动回复天然是 1） */
  private bumpSeq(messageId: string): number {
    const next = (this.seqCounters.get(messageId) ?? 1) + 1;
    this.seqCounters.set(messageId, next);
    // 记满即清最旧的：这只是防重复的去重序号，不需要无限记账
    if (this.seqCounters.size > 512) {
      const oldest = this.seqCounters.keys().next();
      if (!oldest.done) this.seqCounters.delete(oldest.value);
    }
    return next;
  }

  async sendText(
    chatType: QqChatType,
    chatId: string,
    text: string,
    options: SendTextOptions = {},
  ): Promise<SendOutcome> {
    const msgId = options.msgId ?? '';
    const passive = msgId !== '';
    const msgSeq = options.msgSeq ?? (passive ? this.nextSeqFn(msgId) : 1);
    /** `degraded` 只在真发生过时出现：三个成功出口共用一个映射（免得漏掉一条出口） */
    const done = (
      result: { messageId: string; msgSeq: number },
      wasPassive: boolean,
      note: string | null,
    ): SendOutcome => ({
      ok: true,
      messageId: result.messageId,
      passive: wasPassive,
      msgSeq: result.msgSeq,
      ...(note === null ? {} : { degraded: note }),
    });
    const first = await this.post(chatType, chatId, text, passive ? { msgId, msgSeq } : { msgSeq });
    if (first.ok) return done(first, passive, first.degraded);
    // **去重撞车**：换一个新序号再发一次（平台只认 msg_id+msg_seq 这一对是不是新的）。
    // 成因见 QQ_DEDUPE_CODES 那段注释：计数器活在内存里，重启后会与旧进程用过的号撞上。
    if (passive && isDedupeRejected(first.reason)) {
      const retrySeq = freshSeq(msgSeq);
      this.log.warn(`[QQ] 被动回复撞上去重（${first.reason}），换 msg_seq=${retrySeq} 重发一次`);
      const deduped = await this.post(chatType, chatId, text, { msgId, msgSeq: retrySeq });
      if (deduped.ok) return done(deduped, passive, deduped.degraded);
      return { ok: false, reason: deduped.reason, passive };
    }
    if (!passive || !first.retryable) return { ok: false, reason: first.reason, passive };
    this.log.warn(`[QQ] 被动回复被拒（${first.reason}），降级为主动消息重发一次`);
    const second = await this.post(chatType, chatId, text, { msgSeq: 1 });
    return second.ok
      ? done(second, false, second.degraded)
      : { ok: false, reason: second.reason, passive: false };
  }



  /**
   * **上传富媒体换 `file_info`**（官方口径：先传后发，`srv_send_msg=false` 只拿凭据——
   * 这样**不占主动消息频次**，发送那一步仍可走被动回复窗口）。
   *
   * 两条路不互通：单聊的凭证发不到群里，反之亦然（所以这个函数按 chatType 选地址）。
   * `ttl` 是凭据有效期（官方"0 表示可长期使用"，没有固定值）——过期要重传，调用方自己记。
   */
  /**
   * **大文件分片上传**（官方口径：超过 `md5_10m` 那个数——10002432 字节、约 10MiB——才走这条路）。
   *
   * 四步（照着 api-v2 文档与 AstrBot 的实现）：
   *   ① `POST …/upload_prepare`：交 file_size / md5 / sha1 / **md5_10m**（前 10002432 字节的 MD5），
   *      换回 `upload_id` + 每片的**预签名 URL**（以及并发/重试配置）；
   *   ② 逐片 `PUT` 到预签名 URL（**原始字节**，不是 JSON）；
   *   ③ 每片成功后 `POST …/upload_part_finish`（`upload_id` + `part_index` + 该片大小 + 该片 MD5）；
   *   ④ 全部完成后用 `upload_id` 调一次 `…/files` 合并，拿回 `file_info`。
   *
   * 并发按平台下发的 `concurrency`（默认 1，AstrBot 用的是上限 4）：这里保守取 min(下发值, 4)。
   * `40093001`（文件上传失败，可重试）与 `40093002`（当日配额用尽，别再试）分开对待。
   */
  /**
   * 记一条上传凭据。**过期时间按官方 ttl 算，并留 60 秒余量**：ttl 说的是平台的凭据有效期，
   * 卡着最后一秒复用就是在赌网络延迟（赢了省一次上传，输了发不出去）。
   * `ttl=0` 是官方"可长期使用"，这里保守当一天（宁可多传一次，也不拿过期凭据去发）。
   */
  private rememberUpload(
    key: string,
    value: { fileInfo: string; fileUuid: string; ttl: number },
  ): void {
    const ttlMs = value.ttl > 0 ? value.ttl * 1000 : UPLOAD_CACHE_FALLBACK_MS;
    const expiresAt = this.now() + Math.max(0, ttlMs - 60_000);
    if (expiresAt <= this.now()) return; // 余量比 ttl 还长：不值得缓存
    this.uploadCache.set(key, { ...value, expiresAt });
    while (this.uploadCache.size > UPLOAD_CACHE_MAX) {
      const oldest = this.uploadCache.keys().next();
      if (oldest.done === true) break;
      this.uploadCache.delete(oldest.value);
    }
  }

  /**
   * **频道（guild）发媒体**：v1 的 `/channels/{channel_id}/messages` + **multipart**。
   *
   * 口径来自 AstrBot 的频道分支（`qqofficial_message_event.py:586-599`）：字段 `file_image`
   * 直接带文件字节、并且**去掉 `msg_type`**（v1 不认 v2 的字段）；botpy 内部就是这么拼 multipart 的。
   *
   * 只支持**本机字节**：那条路要的是文件本体，AstrBot 传的也是本地路径——网络地址得先下载下来，
   * 那是另一件事（这里如实拒，不假装发得出去）。
   */
  async sendGuildMedia(
    chatType: 'guild' | 'dm',
    chatId: string,
    media: { fileType: QqFileType; data: Uint8Array; name?: string },
    options: { text?: string; msgId?: string } = {},
  ): Promise<SendOutcome> {
    let token: string;
    try {
      token = await this.options.token();
    } catch (err) {
      return { ok: false, reason: `取 token 失败：${messageOf(err)}`, passive: options.msgId !== undefined };
    }
    const multipart = buildMultipartBody({
      fields: [
        // v1 的正文就是 `content`（不是 v2 的 msg_type=7 + media.file_info）
        { name: 'content', value: options.text ?? '' },
        ...(options.msgId === undefined || options.msgId === '' ? [] : [{ name: 'msg_id', value: options.msgId }]),
      ],
      file: {
        name: 'file_image',
        filename: media.name ?? 'image',
        data: media.data,
        contentType: media.fileType === 1 ? 'image/png' : 'application/octet-stream',
      },
    });
    const response = await this.http({
      method: 'POST',
      url: `${this.apiBase}${messagesPathOf(chatType, chatId)}`,
      headers: { authorization: `QQBot ${token}`, 'content-type': multipart.contentType },
      rawBody: multipart.body,
    });
    const payload = asRecord(response.body);
    const messageId = readString(payload, 'id');
    if (messageId === '') {
      const code = readNumber(payload, 'code');
      const message = readString(payload, 'message');
      const detail = [code === null ? '' : `code=${code}`, message].filter(p => p !== '').join(' ');
      return { ok: false, reason: `频道发媒体被拒（${detail === '' ? `HTTP ${response.status}` : detail}）`, passive: options.msgId !== undefined };
    }
    return { ok: true, messageId, passive: options.msgId !== undefined, msgSeq: 1 };
  }

  async uploadMediaChunked(
    chatType: QqChatType,
    chatId: string,
    input: { fileType: QqFileType; data: Uint8Array; name: string },
  ): Promise<QqUploadOutcome> {
    let token: string;
    try {
      token = await this.options.token();
    } catch (err) {
      return { ok: false, reason: `取 token 失败：${messageOf(err)}` };
    }
    const bytes = Buffer.from(input.data);
    const base = `${this.apiBase}${filesPathOf(chatType, chatId)}`;
    const hashes = {
      md5: createHash('md5').update(bytes).digest('hex'),
      sha1: createHash('sha1').update(bytes).digest('hex'),
      // 官方字段名就叫 md5_10m：**前 10002432 字节**（不是 10MiB 整）
      md5_10m: createHash('md5').update(bytes.subarray(0, QQ_CHUNK_HASH_BYTES)).digest('hex'),
    };

    const prepared = await this.http({
      method: 'POST',
      url: `${this.apiBase}${uploadPreparePathOf(chatType, chatId)}`,
      headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
      jsonBody: {
        file_type: input.fileType,
        file_size: String(bytes.length),
        file_name: input.name,
        md5: hashes.md5,
        sha1: hashes.sha1,
        md5_10m: hashes.md5_10m,
      },
    });
    const prepBody = asRecord(prepared.body);
    const uploadId = readString(prepBody, 'upload_id');
    const parts = Array.isArray(prepBody?.['parts']) ? prepBody['parts'] : [];
    if (uploadId === '' || parts.length === 0) {
      const code = readNumber(prepBody, 'code');
      const message = readString(prepBody, 'message');
      const detail = [code === null ? '' : `code=${code}`, message].filter(p => p !== '').join(' ');
      return { ok: false, reason: `预上传被拒（${detail === '' ? `HTTP ${prepared.status}` : detail}）` };
    }

    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      if (part === null) continue;
      const index = readNumber(part, 'index') ?? 0;
      const presigned = readString(part, 'presigned_url');
      if (presigned === '') return { ok: false, reason: `第 ${index} 片没有预签名地址` };
      const size = Number(readString(part, 'block_size') || String(bytes.length)) || bytes.length;
      const slice = bytes.subarray(index * size, Math.min(bytes.length, (index + 1) * size));
      const put = await this.http({ method: 'PUT', url: presigned, rawBody: slice });
      if (put.status >= 300) {
        return { ok: false, reason: `第 ${index} 片上传失败（HTTP ${put.status}）` };
      }
      const finish = await this.http({
        method: 'POST',
        url: `${this.apiBase}${uploadPartFinishPathOf(chatType, chatId)}`,
        headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
        jsonBody: {
          upload_id: uploadId,
          part_index: index,
          block_size: String(slice.length),
          md5: createHash('md5').update(slice).digest('hex'),
        },
      });
      const finishBody = asRecord(finish.body);
      const finishCode = readNumber(finishBody, 'code');
      if (finishCode !== null && finishCode !== 0) {
        const message = readString(finishBody, 'message');
        return { ok: false, reason: `第 ${index} 片确认失败（code=${finishCode} ${message}）` };
      }
    }

    // ④ 用 upload_id 合并（同一个 /files 接口，只是体里换成 upload_id）
    const merged = await this.http({
      method: 'POST',
      url: base,
      headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
      jsonBody: { file_type: input.fileType, srv_send_msg: false, upload_id: uploadId },
    });
    const mergedBody = asRecord(merged.body);
    const fileInfo = readString(mergedBody, 'file_info');
    if (fileInfo === '') {
      const code = readNumber(mergedBody, 'code');
      const message = readString(mergedBody, 'message');
      const detail = [code === null ? '' : `code=${code}`, message].filter(p => p !== '').join(' ');
      return { ok: false, reason: `分片合并被拒（${detail === '' ? `HTTP ${merged.status}` : detail}）` };
    }
    const ttl = readNumber(mergedBody, 'ttl') ?? 0;
    const fileUuid = readString(mergedBody, 'file_uuid');
    // 分片这条路也要记：大文件重复发送的代价更高，缓存的意义更大
    this.rememberUpload(`${chatType}:${chatId}:${createHash('sha256').update(bytes).digest('hex')}`, {
      fileInfo, fileUuid, ttl,
    });
    return { ok: true, fileInfo, fileUuid, ttl };
  }

  /**
   * **流式发送（仅单聊）**。官方口径（api-v2 文档，逐字对过）：
   *
   *   • 路径 `/v2/users/{user_openid}/stream_messages`（50 QPS）；**群聊不支持流式参数**
   *     ——所以群聊在这里直接拒，而不是发出去让平台报错；
   *   • 每个分片 `index` 从 0 递增；`stream_msg_id` 由**首片响应**给出，后续分片必须携带；
   *   • `input_state`：1=生成中、10=生成结束；
   *   • `input_mode`：`append`（默认，拼到 Pending 上）或 `replace`（`content_raw` 是当前全量正文，
   *     且**必须以上游已下发的前缀开头**，否则 40007）；
   *   • 被动回复二选一：`msg_id` 或 `event_id`。
   *
   * 两个实测坑（AstrBot 踩过、这里直接按结论做）：
   *   ① **结束片必须以换行结尾**：`input_state=10` 那一片内容末尾没有 \n 时，平台会认为这一轮
   *      还没完——这里缺了就补一个（补的是空白，不改她的字）；
   *   ② 首片不带 `stream_msg_id`，续片不带就是另起一条新消息（不是同一条在长）。
   */
  async sendStreamChunk(
    chatType: QqChatType,
    chatId: string,
    chunk: {
      text: string;
      index: number;
      state: 1 | 10;
      streamMsgId?: string;
      mode?: 'append' | 'replace';
      contentType?: 'text' | 'markdown';
    },
    options: { msgId?: string; eventId?: string; msgSeq?: number } = {},
  ): Promise<QqStreamOutcome> {
    if (chatType !== 'c2c') {
      return { ok: false, reason: '流式只支持单聊（官方口径：群消息不支持流式参数）' };
    }
    let token: string;
    try {
      token = await this.options.token();
    } catch (err) {
      return { ok: false, reason: `取 token 失败：${messageOf(err)}` };
    }
    // 结束片补换行：缺了它这一轮在平台那边不算完（补的是空白，不动她的字）
    const text = chunk.state === 10 && !chunk.text.endsWith('\n') ? `${chunk.text}\n` : chunk.text;
    const body: Record<string, unknown> = {
      input_mode: chunk.mode ?? 'append',
      input_state: chunk.state,
      index: chunk.index,
      content_type: chunk.contentType ?? 'markdown',
      content_raw: text,
    };
    if (chunk.streamMsgId !== undefined && chunk.streamMsgId !== '') body['stream_msg_id'] = chunk.streamMsgId;
    if (options.msgId !== undefined && options.msgId !== '') body['msg_id'] = options.msgId;
    if (options.eventId !== undefined && options.eventId !== '') body['event_id'] = options.eventId;
    if (options.msgSeq !== undefined) body['msg_seq'] = options.msgSeq;

    const response = await this.http({
      method: 'POST',
      url: `${this.apiBase}/v2/users/${chatId}/stream_messages`,
      headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
      jsonBody: body,
    });
    const payload = asRecord(response.body);
    const streamMsgId = readString(payload, 'id');
    if (streamMsgId === '') {
      const code = readNumber(payload, 'code');
      const message = readString(payload, 'message');
      const detail = [code === null ? '' : `code=${code}`, message].filter(p => p !== '').join(' ');
      return { ok: false, reason: `流式分片被拒（${detail === '' ? `HTTP ${response.status}` : detail}）` };
    }
    return {
      ok: true,
      streamMsgId,
      remainMsgLen: readNumber(payload, 'remain_msg_len') ?? 0,
      index: chunk.index,
    };
  }

  async uploadMedia(
    chatType: QqChatType,
    chatId: string,
    input: QqMediaInput,
  ): Promise<QqUploadOutcome> {
    // 本机字节先查缓存（键 = 内容哈希 + 目的地：单聊与群聊的上传口不互通，不能混用）
    const cacheKey = input.data === undefined
      ? null
      : `${chatType}:${chatId}:${createHash('sha256').update(Buffer.from(input.data)).digest('hex')}`;
    if (cacheKey !== null) {
      const hit = this.uploadCache.get(cacheKey);
      if (hit !== undefined && hit.expiresAt > this.now()) {
        return { ok: true, fileInfo: hit.fileInfo, fileUuid: hit.fileUuid, ttl: hit.ttl };
      }
      if (hit !== undefined) this.uploadCache.delete(cacheKey);
    }

    let token: string;
    try {
      token = await this.options.token();
    } catch (err) {
      return { ok: false, reason: `取 token 失败：${messageOf(err)}` };
    }
    // **大文件自动走分片**（官方口径：超过 10002432 字节就该分片；单次 base64 那条路只适合小文件）
    if (input.data !== undefined && needsChunkedUpload(input.data.length)) {
      return await this.uploadMediaChunked(chatType, chatId, {
        fileType: input.fileType,
        data: input.data,
        name: input.name ?? 'file',
      });
    }
    const body: Record<string, unknown> = {
      file_type: input.fileType,
      srv_send_msg: false,
    };
    if (input.url !== undefined && input.url !== '') {
      body['url'] = input.url;
    } else if (input.data !== undefined && input.data.length > 0) {
      body['file_data'] = Buffer.from(input.data).toString('base64');
    } else {
      return { ok: false, reason: '上传富媒体需要 url 或 data 二者之一' };
    }
    if (input.name !== undefined && input.name !== '') body['file_name'] = input.name;

    const response = await this.http({
      method: 'POST',
      url: `${this.apiBase}${filesPathOf(chatType, chatId)}`,
      headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
      jsonBody: body,
    });
    const uploadBody = asRecord(response.body);
    const fileInfo = readString(uploadBody, 'file_info');
    if (fileInfo === '') {
      const code = readNumber(uploadBody, 'code');
      const message = readString(uploadBody, 'message');
      const detail = [code === null ? '' : `code=${code}`, message].filter(p => p !== '').join(' ');
      return { ok: false, reason: `上传被拒（${detail === '' ? `HTTP ${response.status}` : detail}）` };
    }
    const ttl = readNumber(uploadBody, 'ttl') ?? 0;
    const fileUuid = readString(uploadBody, 'file_uuid');
    if (cacheKey !== null) this.rememberUpload(cacheKey, { fileInfo, fileUuid, ttl });
    return { ok: true, fileInfo, fileUuid, ttl };
  }

  /**
   * 用 `file_info` 发一条**富媒体消息**（`msg_type=7`）。
   *
   * 官方口径两条硬约束，都体现在签名里：
   *   • **一条消息只带一个 media**（所以这个函数一次只发一个文件）；说明文字得另发一条；
   *   • 与文本消息共用被动窗口与 `msg_seq`——同一条 messageId 连发多条要递增（否则 40054005），
   *     失败降级为主动消息的逻辑与 sendText 一致（去 msg_id 重发一次）。
   */
  async sendMedia(
    chatType: QqChatType,
    chatId: string,
    fileInfo: string,
    options: SendTextOptions = {},
  ): Promise<SendOutcome> {
    const msgId = options.msgId ?? '';
    const passive = msgId !== '';
    const msgSeq = options.msgSeq ?? (passive ? this.nextSeqFn(msgId) : 1);
    const send = async (withMsgId: boolean): Promise<{ ok: boolean; reason: string; retryable: boolean; messageId: string }> => {
      let token: string;
      try {
        token = await this.options.token();
      } catch (err) {
        return { ok: false, reason: `取 token 失败：${messageOf(err)}`, retryable: false, messageId: '' };
      }
      const payload: Record<string, unknown> = {
        msg_type: 7,
        media: { file_info: fileInfo },
        msg_seq: msgSeq,
      };
      if (withMsgId) payload['msg_id'] = msgId;
      const response = await this.http({
        method: 'POST',
        url: `${this.apiBase}${messagesPathOf(chatType, chatId)}`,
        headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
        jsonBody: payload,
      });
      const sent = asRecord(response.body);
      const id = readString(sent, 'id');
      if (id !== '') return { ok: true, reason: '', retryable: false, messageId: id };
      const code = readNumber(sent, 'code');
      const message = readString(sent, 'message');
      const detail = [code === null ? '' : `code=${code}`, message].filter(p => p !== '').join(' ');
      return {
        ok: false,
        reason: detail === '' ? `HTTP ${response.status}` : detail,
        retryable: code !== null && QQ_PASSIVE_EXPIRED_CODES.includes(code),
        messageId: '',
      };
    };

    const first = await send(passive);
    if (first.ok) return { ok: true, messageId: first.messageId, passive, msgSeq };
    if (!passive || !first.retryable) return { ok: false, reason: first.reason, passive };
    this.log?.warn?.(`[QQ] 富媒体被动回复被拒（${first.reason}），降级为主动消息重发一次`);
    const second = await send(false);
    return second.ok
      ? { ok: true, messageId: second.messageId, passive: false, msgSeq: 1 }
      : { ok: false, reason: second.reason, passive: false };
  }

  /**
   * **发一个"正在输入"状态**（`msg_type: 6` + `input_notify`）。
   *
   * 协议依据见 `QQ_INPUT_NOTIFY_TYPE` 那段注释（官方示例体逐字段照抄，只少一个 `msg_seq`）。
   *
   * 四条纪律，逐条都有代价在后面：
   *   ① **仅单聊**（`c2c`）：官方只在《发送单聊消息》页列了 `msg_type: 6`，群聊页没有它。
   *      群里发 = 拿一个官方没写的用法去赌，赌输的形态未知 ⇒ 这里**连试都不试**，
   *      返回 `skipped: true`（"不会发"不是"发失败"，日志里也不该出现它）。
   *   ② **不碰 `msg_seq` 计数器**（最要紧的一条）：`sendText` 的序号是 `msg_id + msg_seq`
   *      这一对上的去重号，也是**被动回复 4 次窗口**往下数的凭据。这里刻意**不带 `msg_seq`**
   *      （官方"不填默认是 1"），于是：
   *        · 如果平台把 `msg_type:6` 算作一次回复 ⇒ 这一次**照样会**从窗口里扣掉一次
   *          （那是平台说了算，我们藏不掉），但它**不会**把后面几条正文的号往后推；
   *        · 如果平台不算 ⇒ 一个字都没多花。
   *      两边的结果都只是"这一次通知本身"，**绝不牵连后面那几条正文的编号**。
   *      ⚠️ **它到底算不算一次被动回复，官方文档没写**（《消息收发概述》只说被动回复
   *      "每个消息最多回复 4 次"）。这条**未亲验**，所以它是可关的
   *      （`config.speak.inputNotify`，出厂开）——撞了 `40034128` 就把它关掉。
   *   ③ **只发一次、不重试、不降级**：去重撞车那套重发是给"内容必须送到"的正文用的；
   *      一个状态通知没送到**什么都不影响**，多试一次只是多花一次配额。
   *      `msg_id` 过期（`40034005`/`40034128`…）时**也不降级为主动消息**：状态通知不值得
   *      动主动配额（那是每月限额，见《发送消息》页），如实失败即可。
   *   ④ **失败就是失败**：返回 `ok: false`，由调用方决定"照旧说话"（`admin.speak` 就是这么用的）。
   *      这里不抛异常——取 token 失败、网络失败都折成返回值，调用方不必再写 try/catch。
   */
  async sendInputNotify(
    chatType: QqChatType,
    chatId: string,
    options: SendTextOptions = {},
  ): Promise<QqInputNotifyOutcome> {
    // ① 能力判据**只有这一处**：官方只有单聊有 `input_notify`。频道（guild/dm）走的是 v1
    //（`/channels/…`、`/dms/…`，连 `msg_type` 都不认，见 `post()` 里那段），群聊官方页没列。
    if (chatType !== 'c2c') {
      return { ok: false, skipped: true, reason: `官方只有单聊支持"正在输入"（${chatType} 不发）` };
    }
    let token: string;
    try {
      token = await this.options.token();
    } catch (err) {
      return { ok: false, skipped: false, reason: `取 token 失败：${messageOf(err)}` };
    }
    const msgId = options.msgId ?? '';
    const payload: Record<string, unknown> = {
      msg_type: 6,
      input_notify: { input_type: QQ_INPUT_NOTIFY_TYPE, input_second: QQ_INPUT_NOTIFY_SECONDS },
    };
    // ② 只在**真有被动窗口**时带上 msg_id（官方示例就是这么发的）：不带它这条会被平台当成
    // **主动消息**——那是另一套配额，一个状态通知不值得动它。
    if (msgId !== '') payload['msg_id'] = msgId;
    const url = `${this.apiBase}${messagesPathOf(chatType, chatId)}`;
    /** 失败留痕**只此一处**：`log.warn` 一行 + 计数一格（见 `snapshot().inputNotify`）。 */
    const failed = (reason: string): QqInputNotifyOutcome => {
      this.inputNotifyFailed += 1;
      this.log.warn?.(`[QQ] "正在输入"没发出去（不影响这次发言，chatType=${chatType}）：${reason}`);
      return { ok: false, skipped: false, reason };
    };
    this.inputNotifyAttempts += 1;
    let response: HttpJsonResponse;
    try {
      response = await this.http({
        method: 'POST',
        url,
        headers: { authorization: `QQBot ${token}` },
        jsonBody: payload,
        timeoutMs: 15_000,
      });
    } catch (err) {
      return failed(`发送请求失败（${url}）：${messageOf(err)}`);
    }
    const body = asRecord(response.body);
    const code = readNumber(body, 'code');
    if (code !== null && code !== 0) {
      const detail = readString(body, 'message');
      return failed(`HTTP ${response.status} code=${code} ${detail}`);
    }
    const messageId = readString(body, 'id');
    if (response.status >= 300 || messageId === '') {
      return failed(`HTTP ${response.status}，响应体：${response.text.slice(0, 200)}`);
    }
    this.inputNotifySent += 1;
    return { ok: true, messageId, passive: msgId !== '' };
  }

  private async post(
    chatType: QqChatType,
    chatId: string,
    text: string,
    extra: { msgId?: string; msgSeq: number },
  ): Promise<{ ok: true; messageId: string; passive: boolean; msgSeq: number; degraded: string | null }
    | { ok: false; reason: string; retryable: boolean }> {
    let token: string;
    try {
      token = await this.options.token();
    } catch (err) {
      return { ok: false, reason: `取 token 失败：${messageOf(err)}`, retryable: false };
    }
    const body = (markdown: boolean): Record<string, unknown> => {
      // 官方口径：**content 与 markdown 互斥**（"传了 markdown 后此字段必须为空"），
      // 所以两套字段一次只能用一套。之前写死 `{content, msg_type: 0}`，她写的 Markdown
      // 就被当成纯文本发出去了——QQ 上看到的是原始的 `##` 与 `**`。
      // 频道（v1）**不认 msg_type / msg_seq**（AstrBot 的频道分支就是删掉它们）；
      // 图片那条路也不一样（只能走本地 file_image）——媒体先不支持，文字走通。
      const payload: Record<string, unknown> = chatType === 'guild' || chatType === 'dm'
        ? { content: text }
        : (markdown
          ? { msg_type: 2, markdown: { content: text }, msg_seq: extra.msgSeq }
          : { content: text, msg_type: 0, msg_seq: extra.msgSeq });
      if (extra.msgId !== undefined && extra.msgId !== '') payload['msg_id'] = extra.msgId;
      return payload;
    };
    const url = `${this.apiBase}${messagesPathOf(chatType, chatId)}`;
    const send = async (markdown: boolean): Promise<HttpJsonResponse> => this.http({
      method: 'POST',
      url,
      headers: { authorization: `QQBot ${token}` },
      jsonBody: body(markdown),
      timeoutMs: 15_000,
    });

    const wantMarkdown = this.options.useMarkdown === true;
    let response: HttpJsonResponse;
    // 降级事实（原样带回给调用方，见 SendOutcome.degraded）：null = 这条本来就是按预期形态发的
    let degraded: string | null = null;
    try {
      response = await send(wantMarkdown);
    } catch (err) {
      return { ok: false, reason: `发送请求失败（${url}）：${messageOf(err)}`, retryable: true };
    }
    // 降级：机器人没有原生 markdown 权限时改发纯文本重试一次（绝不因为格式不被支持就丢话）
    if (wantMarkdown && isMarkdownRejected(response)) {
      const why = markdownRejectReason(response);
      this.log.warn(`[QQ] 原生 markdown 被拒（${why}），降级为纯文本重发一次`);
      degraded = `markdown 被拒（${why}），这条按纯文本发出`;
      try {
        response = await send(false);
      } catch (err) {
        return { ok: false, reason: `发送请求失败（${url}）：${messageOf(err)}`, retryable: true };
      }
    }
    const payload = asRecord(response.body);
    const code = readNumber(payload, 'code');
    const messageId = readString(payload, 'id');
    if (code !== null && code !== 0) {
      const detail = readString(payload, 'message');
      return {
        ok: false,
        reason: `HTTP ${response.status} code=${code} ${detail}`,
        retryable: QQ_PASSIVE_EXPIRED_CODES.includes(code),
      };
    }
    if (response.status >= 300 || messageId === '') {
      return {
        ok: false,
        reason: `HTTP ${response.status}，响应体：${response.text.slice(0, 200)}`,
        retryable: response.status >= 500,
      };
    }
    return { ok: true, messageId, passive: extra.msgId !== undefined, msgSeq: extra.msgSeq, degraded };
  }
}

// ──────────────────────────────── 通道适配器 ────────────────────────────────

/**
 * 通道适配器接口：与唤醒源（src/wake/sources.ts 的 WakeSourceAdapter）平级的**输入源**，
 * 外加一条输出通道（sendText 供 speak 回投）。
 *
 * 输入侧的纪律与文件看门目录一致：`onMessage` 回调返回时，事件必须已经落进日志——
 * 否则上层的 dedupe/认领会在事件还不在盘上时就看到它（wake/channel 是承诺类事件）。
 */
export interface ChannelAdapter {
  readonly name: string;
  start(): void;
  stop(): void;
  /** 收到一条通道消息（已转成 wake/channel 的 data 形状） */
  onMessage?: (event: WakeChannel['data']) => void;
  /** 回投：chatType + chatId + 文本；msgId/msgSeq 给定时走被动回复 */
  sendText(chatType: QqChatType, chatId: string, text: string, options?: SendTextOptions): Promise<SendOutcome>;
  /**
   * **能力声明**：这条通道会不会发"正在输入"（`msg_type: 6` + `input_notify`）。
   *
   * 有这个方法 = 会发；没有 = 不会（OneBot 就**没有**它：官方那套补充协议里没有等价能力）。
   * 判定一律走 `typeof channel.sendInputNotify === 'function'`——**不按通道名分支**：
   * 名字会变（别名实例）、能力在不在是事实。
   *
   * 注意它**不是**"一定发得出去"：能不能发还要看 `chatType`（官方只有单聊支持）与网络，
   * 由实现自己如实回（`QqInputNotifyOutcome` 把"不会发"与"发失败"分开）。
   * 调用方（`channel/input-notify.ts` → `speak`）对一切结果的态度只有一条：**照旧说话**。
   */
  sendInputNotify?(chatType: QqChatType, chatId: string, options?: SendTextOptions): Promise<QqInputNotifyOutcome>;
}

export interface QqOfficialChannelOptions {
  appId: string;
  clientSecret: string;
  /** 发文本用原生 markdown（默认开；被拒时自动降级纯文本） */
  useMarkdown?: boolean;
  apiBase?: string;
  tokenUrl?: string;
  /** 网关地址覆盖点（测试用假网关） */
  gatewayUrl?: string;
  http?: HttpJsonFn;
  connect?: (url: string, options: WsConnectOptions) => Promise<WsClient>;
  intents?: number;
  shard?: [number, number];
  refreshAheadMs?: number;
  heartbeatIntervalMs?: number;
  reconnectBaseMs?: number;
  maxReconnectDelayMs?: number;
  /** 心跳与退避的时钟/定时器注入（测试） */
  now?: () => number;
  setTimeoutFn?: QqGatewayOptions['setTimeoutFn'];
  clearTimeoutFn?: QqGatewayOptions['clearTimeoutFn'];
  setIntervalFn?: QqGatewayOptions['setIntervalFn'];
  clearIntervalFn?: QqGatewayOptions['clearIntervalFn'];
  log?: QqTokenLogger;
  /** 命中器：本地 mock / 隐私（无用，保留扩展点） */
  onWake?: (data: WakeChannel['data']) => void;
}

/** QQ 官方通道：凭证 + 网关 + 发送器三件套的组合，对系统只暴露 ChannelAdapter 形状 */
export class QqOfficialChannel implements ChannelAdapter {
  readonly name = QQ_CHANNEL_NAME;

  private readonly tokens: QqAccessToken;
  private readonly gateway: QqGateway;
  private readonly sender: QqMessageSender;
  private readonly log: QqTokenLogger;
  private readonly appId: string;
  /** 出站 http 客户端（发消息用） */
  private readonly outboundHttp: HttpJsonFn;
  /** 观测计数：收到并已投递的通道消息条数 */
  private delivered = 0;

  onMessage?: (event: WakeChannel['data']) => void;

  constructor(options: QqOfficialChannelOptions) {
    this.appId = options.appId;
    this.log = options.log ?? { info: () => {}, warn: () => {} };
    this.outboundHttp = options.http ?? defaultHttpJson;
    this.tokens = new QqAccessToken({
      appId: options.appId,
      clientSecret: options.clientSecret,
      ...(options.tokenUrl === undefined ? {} : { tokenUrl: options.tokenUrl }),
      ...(options.refreshAheadMs === undefined ? {} : { refreshAheadMs: options.refreshAheadMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
      http: this.outboundHttp,
      log: this.log,
    });
    this.sender = new QqMessageSender({
      token: () => this.tokens.acquire(),
      ...(options.apiBase === undefined ? {} : { apiBase: options.apiBase }),
      ...(options.useMarkdown === undefined ? {} : { useMarkdown: options.useMarkdown }),
      http: this.outboundHttp,
      log: this.log,
    });
    this.gateway = new QqGateway({
      token: () => this.tokens.acquire(),
      onWake: (data) => {
        this.delivered += 1;
        this.onMessage?.(data);
      },
      ...(options.apiBase === undefined ? {} : { apiBase: options.apiBase }),
      ...(options.gatewayUrl === undefined ? {} : { gatewayUrl: () => Promise.resolve(options.gatewayUrl as string) }),
      ...(options.connect === undefined ? {} : { connect: options.connect }),
      ...(options.intents === undefined ? {} : { intents: options.intents }),
      ...(options.shard === undefined ? {} : { shard: options.shard }),
      ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
      ...(options.reconnectBaseMs === undefined ? {} : { reconnectBaseMs: options.reconnectBaseMs }),
      ...(options.maxReconnectDelayMs === undefined ? {} : { maxReconnectDelayMs: options.maxReconnectDelayMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.setTimeoutFn === undefined ? {} : { setTimeoutFn: options.setTimeoutFn }),
      ...(options.clearTimeoutFn === undefined ? {} : { clearTimeoutFn: options.clearTimeoutFn }),
      ...(options.setIntervalFn === undefined ? {} : { setIntervalFn: options.setIntervalFn }),
      ...(options.clearIntervalFn === undefined ? {} : { clearIntervalFn: options.clearIntervalFn }),
      http: this.outboundHttp,
      log: this.log,
    });
  }

  start(): void {
    this.gateway.start();
  }

  stop(): void {
    this.gateway.stop();
  }

  sendText(
    chatType: QqChatType,
    chatId: string,
    text: string,
    options: SendTextOptions = {},
  ): Promise<SendOutcome> {
    return this.sender.sendText(chatType, chatId, text, options);
  }

  /** "正在输入"（`msg_type: 6`）：能力与限制全在 `QqMessageSender.sendInputNotify` 的注释里 */
  sendInputNotify(
    chatType: QqChatType,
    chatId: string,
    options: SendTextOptions = {},
  ): Promise<QqInputNotifyOutcome> {
    return this.sender.sendInputNotify(chatType, chatId, options);
  }

  /**
   * 发一个**富媒体**：先上传换 `file_info`，再按 `msg_type=7` 发出。
   *
   * 两步都在这里做（而不是让工具层分两次调）：`file_info` 的 `ttl` 是平台给的、不经我们手，
   * 中间那一步没有任何可复用的状态，拆开只会多一处可能忘传的地方。
   */
  async sendMediaTo(
    chatType: QqChatType,
    chatId: string,
    media: QqMediaInput,
    options: SendTextOptions = {},
  ): Promise<SendOutcome> {
    // **频道发媒体是另一套**（2026-10-03 查 AstrBot 的频道分支确认）：v1 的 `/channels/{id}/messages`
    // 收 `file_image`、走 multipart，与 v2 的"先换 file_info 再 msg_type=7"完全不通用。
    if (chatType === 'guild' || chatType === 'dm') {
      if (media.data === undefined) {
        return {
          ok: false,
          reason: '频道里发媒体只支持本机文件（v1 那条路要文件字节），网络地址得先下载下来——这条还没做',
          passive: options.msgId !== undefined,
        };
      }
      return await this.sender.sendGuildMedia(
        chatType,
        chatId,
        { fileType: media.fileType, data: media.data, ...(media.name === undefined ? {} : { name: media.name }) },
        { ...(options.msgId === undefined ? {} : { msgId: options.msgId }) },
      );
    }
    const uploaded = await this.sender.uploadMedia(chatType, chatId, media);
    if (!uploaded.ok) return { ok: false, reason: uploaded.reason, passive: options.msgId !== undefined };
    return await this.sender.sendMedia(chatType, chatId, uploaded.fileInfo, options);
  }

  /** 状态快照（CLI/测试观测；token 值本身从不外露） */
  snapshot(): {
    appId: string;
    delivered: number;
    tokenFetches: number;
    hasToken: boolean;
    gateway: ReturnType<QqGateway['snapshot']>;
    /**
     * 「正在输入」的读数（2026-10-11 加）：`attempts` = 真发出去的请求数，
     * `sent` = 平台答应的次数，`failed` = 前两者之差。
     *
     * 怎么用它判断"她怎么不显示正在输入"：`attempts === 0` ⇒ 根本没走到通道
     *（群里？开关关了？没有回投地址？——那三件事各有各的判据，都不在这里）；
     * `attempts > 0 && sent === 0` ⇒ 走了但平台不要（看 `log.warn` 那一行的错误码）。
     */
    inputNotify: { attempts: number; sent: number; failed: number };
  } {
    return {
      appId: this.appId,
      delivered: this.delivered,
      tokenFetches: this.tokens.fetches,
      hasToken: this.tokens.snapshot().hasToken,
      gateway: this.gateway.snapshot(),
      inputNotify: this.sender.snapshot().inputNotify,
    };
  }
}

// ──────────────────────────────── speak 回投接线 ────────────────────────────────

/** 回投地址的 scheme：`qq:<chatType>:<chatId>`（把出站路由要求编码进 URL，admin 的 ReplyTarget 只有 url 字段） */
export const QQ_REPLY_SCHEME = 'qq:';

/** 把 wake/channel 数据编成回投 URL（**归一形态**：群聊一律 `group`，理由见 `QqChatType`） */
export function replyUrlOf(data: Pick<WakeChannel['data'], 'chatType' | 'chatId'>): string {
  return `${QQ_REPLY_SCHEME}${sidKindOf(data.chatType)}:${data.chatId}`;
}

export type ReplyUrlParse =
  | { ok: true; chatType: QqChatType; chatId: string }
  | { ok: false; error: string };

/** 解析回投 URL；认 `qq:c2c:` / `qq:group:`（旧记录里可能还是 `qq:group-at:`） */
export function parseReplyUrl(url: string): ReplyUrlParse {
  if (!url.startsWith(QQ_REPLY_SCHEME)) {
    return { ok: false, error: `不是 QQ 回投地址（${url.slice(0, 32)}）` };
  }
  const rest = url.slice(QQ_REPLY_SCHEME.length);
  const index = rest.indexOf(':');
  if (index <= 0) return { ok: false, error: `回投地址缺少 chatId：${url}` };
  const chatType = rest.slice(0, index);
  const chatId = rest.slice(index + 1);
  const known = chatType === 'c2c' || chatType === 'group' || chatType === 'group-at'
    || chatType === 'guild' || chatType === 'dm';
  if (!known) {
    return { ok: false, error: `不支持的 chatType：${chatType}` };
  }
  if (chatId === '') return { ok: false, error: `回投地址的 chatId 为空：${url}` };
  return { ok: true, chatType, chatId };
}

/**
 * 回投实现：把 admin 工具 `speak` 的第三路（replyPoster）接到通道的 sendText 上。
 *
 * 为什么做成独立函数而不是塞进 main：它只依赖"某个通道能不能发文本"这一件事，
 * 在 CLI/测试里可以独立装配与断言。
 */
/**
 * 媒体投递口（`send_media` 工具用）：与 `createChannelReplyPoster` 同一套成例——
 * 认回投地址、超时由调用方预算说了算、失败如实回报。
 *
 * 与文本那条的唯一区别：**超时预算更大**（默认 60s）：先上传再发送是两次往返，
 * 网络图还要平台先回源拉一遍，15s 那条线会把它误判成超时。
 *
 * **2026-10-07：`channelName` 参数化，装配层不再写死"只有 qq-official 会发媒体"。**
 *
 * 原先这里写死两件通道事：`parseReplyUrl`（只认 `qq:` 前缀）与 `channels.get(QQ_CHANNEL_NAME)`；
 * 结果是 `main.ts` 也照着写死了装配条件（`qqChannel !== null` 才造 mediaPoster）——
 * OneBot 上 `send_media` 直接不存在。现在"认哪个通道"由**调用方按回投地址的 scheme 决定**
 * （`admin.parseReplyUrlAny` 已经把 scheme → 通道名映射好了，与 speak 那条路同一份判据），
 * 这个函数只负责"把媒体交给那条通道的 `sendMediaTo`"。
 *
 * 三条纪律照旧：**通道没装配**如实说、**通道不会发媒体**如实说（不假装发过）、
 * 超时由调用方预算说了算。**不在这里按通道名分支**——有没有 `sendMediaTo` 是通道自己的事。
 */
export function createChannelMediaPoster(
  channels: ReadonlyMap<string, ChannelAdapter>,
  options: {
    timeoutMs?: number;
    /**
     * 认哪条通道的媒体接口。省略 = `qq-official`（既有调用点逐字节不变）。
     * 装配层按回投地址的 scheme 递进来。
     */
    channelName?: string;
    /** 解析回投地址的入口（省略 = 本文件的 `parseReplyUrl`，即只认 `qq:` 前缀） */
    parseUrl?: (url: string) => { ok: true; chatType: QqChatType; chatId: string } | { ok: false; error: string };
  } = {},
): {
  post(
    target: { url: string; idempotencyKey: string; msgId?: string },
    media: QqMediaInput,
  ): Promise<{ ok: true; status: number } | { ok: false; reason: string }>;
} {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const channelName = options.channelName ?? QQ_CHANNEL_NAME;
  const parseUrl = options.parseUrl ?? parseReplyUrl;
  return {
    async post(target, media) {
      const parsed = parseUrl(target.url);
      if (!parsed.ok) return { ok: false, reason: parsed.error };
      const channel = channels.get(channelName);
      if (channel === undefined) return { ok: false, reason: `${channelName} 通道未装配，媒体发送跳过` };
      // **能力判据是"这条通道有没有那个方法"**，不是它的名字：名字会变，方法在不在是事实。
      // 没有就如实说清（她据此决定换会话还是换方式），绝不假装发过。
      const sender = channel as ChannelAdapter & {
        sendMediaTo?: (
          chatType: QqChatType,
          chatId: string,
          media: QqMediaInput,
          options?: SendTextOptions,
        ) => Promise<SendOutcome>;
      };
      if (typeof sender.sendMediaTo !== 'function') {
        return { ok: false, reason: `${channelName} 通道不支持发媒体（它没有实现 sendMediaTo）` };
      }
      const timerRef: { handle: NodeJS.Timeout | null } = { handle: null };
      try {
        const outcome = await Promise.race([
          sender.sendMediaTo(
            parsed.chatType,
            parsed.chatId,
            media,
            target.msgId === undefined ? {} : { msgId: target.msgId },
          ),
          new Promise<never>((_resolve, reject) => {
            timerRef.handle = setTimeout(() => reject(new Error(`媒体发送超时（${timeoutMs}ms）`)), timeoutMs);
            timerRef.handle.unref?.();
          }),
        ]);
        return outcome.ok
          ? { ok: true, status: 200 }
          : { ok: false, reason: outcome.reason };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      } finally {
        if (timerRef.handle !== null) clearTimeout(timerRef.handle);
      }
    },
  };
}

export function createChannelReplyPoster(
  channels: ReadonlyMap<string, ChannelAdapter>,
  options: { timeoutMs?: number } = {},
): { post(target: { url: string; idempotencyKey: string; msgId?: string }, text: string): Promise<{ ok: true; status: number; note?: string } | { ok: false; reason: string }> } {
  const timeoutMs = options.timeoutMs ?? 15_000;
  return {
    // 返回"带 post 的对象"而不是裸函数：admin 的 ReplyPoster 是接口（post 方法），
    // 结构类型下只有对象形状才对得上——裸函数会在装配点报类型错误。
    async post(target, text) {
      const parsed = parseReplyUrl(target.url);
      if (!parsed.ok) return { ok: false, reason: parsed.error };
      const channel = channels.get(QQ_CHANNEL_NAME);
      if (channel === undefined) return { ok: false, reason: 'QQ 通道未装配，回投跳过' };
      const timerRef: { handle: NodeJS.Timeout | null } = { handle: null };
      try {
        // 超时用竞速实现而不是在通道内部设超时：回投是"这一轮发言"的一部分，
        // 卡住的是工具调用，必须由调用方（工具超时预算）说了算。
        const outcome = await Promise.race([
          // **带上 msg_id 才是被动回复**：那是"回复那条消息"，不是"主动找他"。
          // 少了它，平台一律按主动消息处理——而群聊的主动消息要额外权限与配额
          // （实测 40034105），被动回复本来就免费。事故经过见 admin.ts 的 ReplyTarget.msgId。
          channel.sendText(parsed.chatType, parsed.chatId, text,
            target.msgId === undefined ? {} : { msgId: target.msgId }),
          new Promise<never>((_resolve, reject) => {
            timerRef.handle = setTimeout(() => { reject(new Error(`回投超时（${timeoutMs}ms）`)); }, timeoutMs);
          }),
        ]);
        if (outcome.ok) {
          // 降级事实**原样带上**（`degraded` → `note`）：`ok: true` 只说"话发出去了"，
          // 而"这条的形态与她以为的不一样（例如 markdown 被拒、按纯文本发的）"是回执里
          // 必须说清的另一件事——不然就是"以为发出去了、其实没 @ 到"的静默失败。
          return outcome.degraded === undefined
            ? { ok: true, status: 200 }
            : { ok: true, status: 200, note: outcome.degraded };
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
