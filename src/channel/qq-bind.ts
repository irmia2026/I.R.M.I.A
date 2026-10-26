/**
 * QQ 官方 Bot「扫码创建」——**协议层**（零依赖：只有 `node:crypto` 与全局 `fetch`）。
 *
 * 用户原话：「加入扫码创建 QQ 官方 bot 的功能……在首次启动引导、消息适配器那页，要可选扫码
 * 创建或者填凭据创建。」这一份只做后端那一半：把官方那条**无鉴权**的绑定协议包成人话，
 * 给 `/api/channels/qq-official/bind/*` 用。
 *
 * ## 协议（官方文档 bot.q.qq.com/wiki/agent-qqbot/《第三方 Agent 接入》，2026-10 逐页核过）
 *
 *   1. `POST https://q.qq.com/lite/create_bind_task` body `{"key": base64(32 随机字节)}`
 *      → `{"data":{"task_id":"…"}}`。**key 是我们自己生成的**，它同时是第 4 步解密的密钥。
 *   2. 二维码内容（= 要交给系统浏览器打开的地址）：
 *      `https://q.qq.com/qqbot/openclaw/connect.html?task_id=<id>&source=<平台名>&_wv=2`
 *      那个页面**自己渲染二维码**（原文「请使用手机QQ扫码绑定」），还带「创建新机器人」
 *      「选择主体帐号」两个入口。所以**我们不需要任何二维码编码库**，也不需要画二维码——
 *      把 URL 交给系统浏览器就是我们的流程（见 gui/lib/onboarding.dart 的扫码那一支）。
 *   3. `POST https://q.qq.com/lite/poll_bind_result` body `{"task_id":"…"}`
 *      → `{"data":{"status":0|1|2|3,"bot_appid":"…","bot_encrypt_secret":"…","user_openid":"…"}}`。
 *      `status`：0 待扫 / 1 已扫待确认 / **2 成功** / **3 过期**。
 *   4. 解密：`bot_encrypt_secret` 是 `base64(12B nonce | 密文 | 16B tag)`，算法 AES-256-GCM，
 *      密钥就是第 1 步我们自己生成的那 32 字节。`node:crypto` 的 `aes-256-gcm` + `authTagLength 16`。
 *
 * ## 为什么自己写、不 vendor 官方 SDK
 *
 * 官方 npm 包的 license 是 **UNLICENSED**（不许再分发），而这个仓库的硬约束是零运行时依赖
 * （`package.json` 不许加依赖）。协议本身只有上面三步 + 一次解密，自己写反而更小、更好测。
 *
 * ## 三条纪律
 *
 *   ① **错误一律转成中文人话**：网络失败 / 响应形状不对 / 解密失败各有一句，绝不把异常栈
 *      甩给界面（界面只会把它原样显示出来）。
 *   ② **密钥与 secret 不落日志、不回显**：本模块只对外给 AppID 与状态；`botEncryptSecret`
 *      解出来的 AppSecret 只在内存里交给 {@link QqBindSessionOptions.onSettled} 那一下。
 *   ③ **节奏可注入**：2 秒一次、总超时 3 分钟、`status=3` 自动重建一次——这些全部走
 *      {@link QqBindScheduler} 与 `now`，用例不必真的等两秒，也不会在测试进程里留下定时器。
 *
 * 约定（与全仓一致）：值导入写 `.ts`，纯类型导入写 `.js`。
 */

import { createDecipheriv, randomBytes } from 'node:crypto';

// token 接口的默认地址与「凭据测试」共用同一份常量（唯一出处：qq-official.ts）。
// 那是主流程真正用的地址；这里再写一遍就会在"改端点"时出现两处不一致。
import { DEFAULT_QQ_TOKEN_URL } from './qq-official.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 建任务（不需要任何鉴权） */
export const QQ_CREATE_BIND_TASK_URL = 'https://q.qq.com/lite/create_bind_task';

/** 查绑定结果（不需要任何鉴权） */
export const QQ_POLL_BIND_RESULT_URL = 'https://q.qq.com/lite/poll_bind_result';

/** 浏览器里那个**自己渲染二维码**的页面（第 2 步的 URL 前缀） */
export const QQ_BIND_PAGE_URL = 'https://q.qq.com/qqbot/openclaw/connect.html';

/** 平台名（官方 URL 里的 `source`）：默认用本框架的名字 */
export const QQ_BIND_SOURCE_DEFAULT = 'irmia';

/** 我们生成的密钥长度（AES-256 ⇒ 32 字节） */
export const QQ_BIND_KEY_BYTES = 32;

/** GCM nonce 长度（官方 SDK 的布局：12 字节） */
export const QQ_BIND_NONCE_BYTES = 12;

/** GCM tag 长度（16 字节） */
export const QQ_BIND_TAG_BYTES = 16;

/** 轮询节奏：2 秒一次（与官方 SDK 同档；界面也按这个间隔问状态） */
export const QQ_BIND_POLL_INTERVAL_MS = 2000;

/** 一轮扫码的总超时：3 分钟（过了就回 `expired`，界面给「重新生成」） */
export const QQ_BIND_TIMEOUT_MS = 3 * 60_000;

/** `status` 的三个已知值（0 待扫 / 1 已扫待确认 / 2 成功 / 3 过期） */
export const QQ_BIND_STATUS_PENDING = 0;
export const QQ_BIND_STATUS_SCANNED = 1;
export const QQ_BIND_STATUS_SUCCESS = 2;
export const QQ_BIND_STATUS_EXPIRED = 3;

/** 网络请求默认超时（比轮询间隔长，比总超时短） */
const HTTP_TIMEOUT_MS = 15_000;

// ──────────────────────────────── HTTP 注入点 ────────────────────────────────

export interface QqBindHttpRequest {
  method: 'POST';
  url: string;
  jsonBody: unknown;
  timeoutMs?: number;
}

export interface QqBindHttpResponse {
  status: number;
  /** 响应体原文（非 JSON / 空体时为空串） */
  text: string;
  /** 已解析的 JSON（解析失败为 null） */
  body: unknown;
}

/**
 * HTTP 出口。生产 = {@link defaultQqBindHttp}（全局 fetch）；
 * 用例 = 自己记流水账的假函数（断言"打了哪几步、body 是什么"）。
 */
export type QqBindHttp = (request: QqBindHttpRequest) => Promise<QqBindHttpResponse>;

/**
 * 默认实现：全局 `fetch`。
 *
 * 三条与正文同源的取舍：
 *   • **不看 HTTP 状态码判业务成败**——官方这两条接口失败时也常回 200，
 *     判定交给调用方看响应体（与 `channel/qq-official.ts` 的 `defaultHttpJson` 同一条纪律）；
 *   • 超时用 `AbortSignal.timeout`：不引第三方库，也不靠"对端自己断"；
 *   • **传输层错误在这里就翻成人话**：`连不上 QQ 的接口（地址）：原因`。
 *     上层（会话/端点）只需要原样带出去，不必再各写一遍平台措辞。
 */
export const defaultQqBindHttp: QqBindHttp = async (request) => {
  const timeoutMs = request.timeoutMs ?? HTTP_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request.jsonBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const reason = name === 'TimeoutError' || name === 'AbortError'
      ? `请求超时（${timeoutMs}ms）`
      : messageOf(err);
    throw new Error(`连不上 QQ 的接口（${request.url}）：${reason}`);
  }
  let text = '';
  try {
    text = await response.text();
  } catch (err) {
    throw new Error(`读 QQ 的响应体失败（${request.url}）：${messageOf(err)}`);
  }
  let body: unknown = null;
  try {
    body = text.trim() === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    body = null;
  }
  return { status: response.status, text, body };
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 官方回包的 `data` 那一层；不是对象就是 null（形状错误由调用方报人话） */
function dataOf(body: unknown): Record<string, unknown> | null {
  const root = asRecord(body);
  return root === null ? null : asRecord(root['data']);
}

/** 数字或数字字符串都认（官方 SDK 的字段偶尔是字符串） */
function readNumber(source: Record<string, unknown> | null, key: string): number | null {
  const value = source?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function readString(source: Record<string, unknown> | null, key: string): string {
  const value = source?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

// ──────────────────────────────── ① 建任务 / ② URL ────────────────────────────────

export interface QqBindTask {
  taskId: string;
  /** base64 的 32 字节密钥（**不落盘、不进日志**；只在本进程内存里留给第 4 步解密） */
  keyB64: string;
}

/**
 * 第 1 步：建一个绑定任务，返回 `{taskId, keyB64}`。
 *
 * 密钥由**我们**生成（官方要求 `base64(32 随机字节)`），它既是请求体，也是第 4 步解密
 * `bot_encrypt_secret` 的密钥——所以调用方必须把 `keyB64` 带在同一个会话里，别丢。
 */
export async function createBindTask(http: QqBindHttp = defaultQqBindHttp): Promise<QqBindTask> {
  const key = randomBytes(QQ_BIND_KEY_BYTES);
  const response = await http({
    method: 'POST',
    url: QQ_CREATE_BIND_TASK_URL,
    jsonBody: { key: key.toString('base64') },
    timeoutMs: HTTP_TIMEOUT_MS,
  });
  const data = dataOf(response.body);
  const taskId = readString(data, 'task_id');
  if (taskId === '') {
    throw new Error(
      `QQ 的绑定服务回了一个看不懂的响应（缺少 data.task_id，HTTP ${response.status}）：`
        + '请稍后再试，或改用「填写凭据」创建。',
    );
  }
  return { taskId, keyB64: key.toString('base64') };
}

/**
 * 第 2 步：二维码内容 = 交给系统浏览器打开的地址。
 *
 * 页面**自己渲染二维码**（官方原文「请使用手机QQ扫码绑定」），我们只管把地址交出去。
 * `source` 只是平台展示用的名字，官方要求非空；改动它不影响协议。
 */
export function bindUrlOf(taskId: string, source: string = QQ_BIND_SOURCE_DEFAULT): string {
  const id = taskId.trim();
  if (id === '') throw new Error('绑定任务的 task_id 是空的：没有二维码可打开（请重新发起扫码）');
  const platform = source.trim() === '' ? QQ_BIND_SOURCE_DEFAULT : source.trim();
  return `${QQ_BIND_PAGE_URL}?task_id=${encodeURIComponent(id)}`
    + `&source=${encodeURIComponent(platform)}&_wv=2`;
}

// ──────────────────────────────── ③ 查结果 ────────────────────────────────

export interface QqBindPollResult {
  status: number;
  /** 成功时才有：机器人 AppID */
  botAppId: string;
  /** 成功时才有：base64(12B nonce | 密文 | 16B tag) */
  botEncryptSecret: string;
  /** 成功时才有：扫码人的 openid（我们不用它，但排障时能说出"是谁扫的"） */
  userOpenId: string;
}

/**
 * 第 3 步：查一次绑定结果。
 *
 * 「形状不对」与「业务失败」分开报：缺 `status` 是**我们看不懂**（可能官方改了协议），
 * 而 `status=3` 是**业务上过期**（要重建任务）——两者的处置完全不同，不能合成一句话。
 */
export async function pollBindResult(
  taskId: string,
  http: QqBindHttp = defaultQqBindHttp,
): Promise<QqBindPollResult> {
  const id = taskId.trim();
  if (id === '') throw new Error('绑定任务的 task_id 是空的：没东西可查（请重新发起扫码）');
  const response = await http({
    method: 'POST',
    url: QQ_POLL_BIND_RESULT_URL,
    jsonBody: { task_id: id },
    timeoutMs: HTTP_TIMEOUT_MS,
  });
  const data = dataOf(response.body);
  const status = readNumber(data, 'status');
  if (status === null) {
    throw new Error(
      `QQ 的绑定服务回了一个看不懂的响应（缺少 data.status，HTTP ${response.status}）：`
        + '请稍后再试，或改用「填写凭据」创建。',
    );
  }
  return {
    status,
    botAppId: readString(data, 'bot_appid'),
    botEncryptSecret: readString(data, 'bot_encrypt_secret'),
    userOpenId: readString(data, 'user_openid'),
  };
}

// ──────────────────────────────── ④ 解密 ────────────────────────────────

function decodeBase64(text: string, what: string): Buffer {
  const trimmed = text.trim();
  // 标准与 URL-safe 两种字母表都认：官方 SDK 用标准 base64，转一手成本极低
  const normalized = trimmed.replace(/-/gu, '+').replace(/_/gu, '/');
  if (normalized === '' || !/^[A-Za-z0-9+/=]+$/u.test(normalized)) {
    throw new Error(`绑定凭据解密失败：${what}不是合法的 base64（请重新扫码）`);
  }
  return Buffer.from(normalized, 'base64');
}

/**
 * 第 4 步：解出 AppSecret。
 *
 * 布局（官方 SDK 的 dist 里核过）：`base64(12B nonce | 密文 | 16B tag)`，AES-256-GCM，
 * 认证 tag 是**尾巴那 16 字节**（不是头部）。错 key / 密文被改 / 布局不对，
 * GCM 的 `final()` 会抛——统一翻成一句「解密失败」，不把 OpenSSL 的原文交给界面。
 *
 * 返回值是**明文 AppSecret**：调用方只许把它写进 `data/.keys.json`（或喂给连接测试），
 * **不许回显、不许进日志**。
 */
export function decryptBindSecret(encryptedB64: string, keyB64: string): string {
  const raw = decodeBase64(encryptedB64, '绑定密文');
  const key = decodeBase64(keyB64, '绑定密钥');
  if (key.length !== QQ_BIND_KEY_BYTES) {
    throw new Error(
      `绑定凭据解密失败：密钥是 ${key.length} 字节（应为 ${QQ_BIND_KEY_BYTES} 字节）——请重新扫码`,
    );
  }
  if (raw.length <= QQ_BIND_NONCE_BYTES + QQ_BIND_TAG_BYTES) {
    throw new Error(
      '绑定凭据解密失败：密文太短（应为 12 字节 nonce + 密文 + 16 字节 tag）——请重新扫码',
    );
  }
  const nonce = raw.subarray(0, QQ_BIND_NONCE_BYTES);
  const tag = raw.subarray(raw.length - QQ_BIND_TAG_BYTES);
  const ciphertext = raw.subarray(QQ_BIND_NONCE_BYTES, raw.length - QQ_BIND_TAG_BYTES);
  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: QQ_BIND_TAG_BYTES });
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // 刻意不把底层异常带出来：它只会说 "Unsupported state or unable to authenticate data"
    throw new Error('绑定凭据解密失败：密钥或密文不匹配（请重新扫码；或改用「填写凭据」创建）');
  }
  const secret = plain.toString('utf8').trim();
  if (secret === '') {
    throw new Error('绑定凭据解密失败：解出来是空的（请重新扫码；或改用「填写凭据」创建）');
  }
  return secret;
}

// ──────────────────────────────── 连接测试（凭据真的能用吗） ────────────────────────────────

export interface QqTokenTestOk {
  ok: true;
  /** 官方 `expires_in`（秒） */
  expiresIn: number;
}

export interface QqTokenTestFail {
  ok: false;
  /** 中文人话：为什么连不上 */
  error: string;
}

export type QqTokenTest = QqTokenTestOk | QqTokenTestFail;

/**
 * 用当前 AppID / AppSecret **真去换一次 access_token**。
 *
 * 为什么需要它（比"填了没空白"强得多）：凭据写对了**不等于**连得上——机器人可能没上线、
 * 被下架、AppSecret 被轮换过、或 AppID 填成了另一个应用。扫码绑定的成功与"能收消息"之间
 * 隔着的就是这一步，所以扫码成功后**自动跑一次**，手填那条路也有「测试连接」按钮。
 *
 * 与 `QqAccessToken` 的关系：它换 token 时把结果缓存起来（生产路径必须复用）；这里是
 * **一次性探针**，不复用缓存、也不写任何状态。两者的成败判定同源（官方失败也回 HTTP 200，
 * 要看响应体），但这里要把 `expires_in` 原样回给界面。
 */
export async function testQqCredentials(input: {
  appId: string;
  clientSecret: string;
  /** 凭证地址覆盖点（配置里 `channels.qqOfficial.tokenUrl`）；不写用官方默认 */
  tokenUrl?: string | undefined;
  http?: QqBindHttp | undefined;
  timeoutMs?: number | undefined;
}): Promise<QqTokenTest> {
  const appId = input.appId.trim();
  const clientSecret = input.clientSecret.trim();
  if (appId === '' || clientSecret === '') {
    return {
      ok: false,
      error: '还没填 AppID / AppSecret：先在「填写凭据」里填上，或扫码创建。',
    };
  }
  const http = input.http ?? defaultQqBindHttp;
  let response: QqBindHttpResponse;
  try {
    response = await http({
      method: 'POST',
      url: input.tokenUrl ?? DEFAULT_QQ_TOKEN_URL,
      jsonBody: { appId, clientSecret },
      timeoutMs: input.timeoutMs ?? HTTP_TIMEOUT_MS,
    });
  } catch (err) {
    return { ok: false, error: messageOf(err) };
  }
  const body = asRecord(response.body);
  const token = readString(body, 'access_token');
  if (token === '') {
    const code = readNumber(body, 'code');
    const message = readString(body, 'message');
    const detail = code !== null ? `code=${code} message=${message}` : `HTTP ${response.status}`;
    return {
      ok: false,
      error: `换取 access_token 失败（${detail}）：请核对 AppID / AppSecret，并确认机器人已在 QQ 开放平台上线。`,
    };
  }
  const expiresIn = readNumber(body, 'expires_in') ?? 7200;
  return { ok: true, expiresIn };
}

// ──────────────────────────────── 会话（节奏 + 自动重建） ────────────────────────────────

/** 定时器注入点：用例给一个"手动点火"的假实现，就不必真的等 2 秒 */
export interface QqBindScheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * 默认调度器：真定时器，**全部 unref**。
 *
 * unref 的理由：一轮扫码最长挂 3 分钟。它不该成为"进程退不出去"的理由——
 * 界面关掉之后，后台没有谁在等这个定时器。
 */
export const defaultQqBindScheduler: QqBindScheduler = {
  setInterval(fn, ms) {
    const handle = setInterval(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** 界面拿得到的状态（**没有 secret**）：pending 等扫码，success 绑定成功，expired 要重新生成 */
export type QqBindStatus = 'idle' | 'pending' | 'success' | 'expired';

export interface QqBindConnectionResult {
  ok: boolean;
  expiresIn?: number;
  /** 连不上的中文原因（ok=false 时才有） */
  error?: string;
}

/** 绑定成功之后、落盘那一步的回执（由 WebServer 提供：写 .keys.json + 启用 + 连接测试） */
export interface QqBindSettled {
  /** 凭据是否已写入 `data/.keys.json` */
  saved: boolean;
  /** `channels.qqOfficial.enabled` 是否为 true（这一轮写完之后的结论） */
  enabled: boolean;
  /** 自动跑的那一次连接测试 */
  connection?: QqBindConnectionResult;
  /** 一句人话，说明写了哪儿（界面也可以自己按 saved/enabled 拼，不依赖它） */
  note?: string;
  /** 落盘失败时的中文原因（此时 saved=false，但绑定本身是成功的） */
  error?: string;
}

export interface QqBindSettledInput {
  appId: string;
  /** 明文 AppSecret：只许写盘/测连接，不许回显 */
  clientSecret: string;
}

export interface QqBindSessionOptions {
  http?: QqBindHttp;
  /** 时钟（毫秒）；缺省 `Date.now`。注入它，超时用例才不用真的等 3 分钟 */
  now?: () => number;
  /** 平台名（URL 里的 `source`） */
  source?: string;
  /** 轮询节奏；**<= 0 = 不起定时器，完全由 `poll()` 驱动**（用例用） */
  pollIntervalMs?: number;
  /** 总超时 */
  timeoutMs?: number;
  /** `status=3` 时自动重建一次任务（与官方 SDK 同档）；缺省 true */
  rebuildOnExpired?: boolean;
  /** 成功那一刻：把凭据落盘 + 启用 + 连接测试（失败会体现在回执里，不吞） */
  onSettled?: (input: QqBindSettledInput) => Promise<QqBindSettled>;
  /** 诊断输出（**只给非密钥的事实**：状态、错误、重建） */
  onError?: (line: string) => void;
  scheduler?: QqBindScheduler;
}

/** 端点回给界面的形状（JSON 可直接序列化；secret 永远不在里面） */
export interface QqBindView {
  status: QqBindStatus;
  taskId?: string;
  /** 二维码地址（pending 时给，界面对照"要不要重新打开浏览器"） */
  url?: string;
  /** 成功且解出 AppID 之后才有 */
  appId?: string;
  saved?: boolean;
  enabled?: boolean;
  connection?: QqBindConnectionResult;
  note?: string;
  /** 最近一次网络/形状错误（中文人话；仍是 pending 时会一直更新） */
  error?: string;
  /** 为什么到了 expired（「二维码过期了」/「等待超时」/「重建失败」） */
  reason?: string;
}

export interface QqBindStarted {
  taskId: string;
  url: string;
}

/**
 * 一轮扫码的会话。
 *
 * 生命周期：
 * ```
 * start() ──建任务──▶ pending ──每 2s 查一次──▶ success（落盘 + 启用 + 连测）
 *                        │
 *                        ├─ status=3 ⇒ 自动重建一次（新 taskId/url）
 *                        ├─ 再 status=3 / 超过 3 分钟 / 重建失败 ⇒ expired
 *                        └─ cancel() ⇒ 释放定时器（状态停在原处）
 * ```
 *
 * 为什么会话自己拿着定时器（而不是"界面来问一次才查一次"）：绑定成功那一下要**立刻**
 * 写进配置。界面可能被关掉、可能切走了——后台这一份仍要把它落完。"成功那一刻写进配置"
 * 这句话只有在会话自己有节奏时才成立。
 *
 * 并发：`start()`/`tick()` 之间用 `generation` 代次号隔开——一轮新的扫码开始之后，
 * 上一轮还在飞的请求即使回来了也不许改这一轮的状态（否则第二个二维码会显示第一个的结果）。
 */
export class QqBindSession {
  private readonly options: QqBindSessionOptions;
  private readonly http: QqBindHttp;
  private readonly now: () => number;
  private readonly scheduler: QqBindScheduler;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly rebuildOnExpired: boolean;

  private generation = 0;
  private state: QqBindStatus = 'idle';
  private cancelled = true;
  private taskId = '';
  private keyB64 = '';
  private url = '';
  private startedAt = 0;
  private lastTickAt = 0;
  private rebuilt = false;

  private appId = '';
  private settled: QqBindSettled | null = null;
  private lastError = '';
  private reason = '';

  private inflight: Promise<void> | null = null;
  private intervalHandle: unknown = null;
  private deadlineHandle: unknown = null;

  constructor(options: QqBindSessionOptions = {}) {
    this.options = options;
    this.http = options.http ?? defaultQqBindHttp;
    this.now = options.now ?? (() => Date.now());
    this.scheduler = options.scheduler ?? defaultQqBindScheduler;
    this.pollIntervalMs = options.pollIntervalMs ?? QQ_BIND_POLL_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? QQ_BIND_TIMEOUT_MS;
    this.rebuildOnExpired = options.rebuildOnExpired ?? true;
  }

  /** 建任务、起定时器。**失败（网络/形状）抛中文错误**，由端点转成 502。 */
  async start(): Promise<QqBindStarted> {
    this.stopTimers();
    this.generation += 1;
    const generation = this.generation;
    this.cancelled = false;
    this.state = 'pending';
    this.taskId = '';
    this.keyB64 = '';
    this.url = '';
    this.rebuilt = false;
    this.appId = '';
    this.settled = null;
    this.lastError = '';
    this.reason = '';
    this.startedAt = this.now();
    this.lastTickAt = this.startedAt;

    let created: QqBindTask;
    try {
      created = await createBindTask(this.http);
    } catch (err) {
      // 建任务失败：不留一个"看起来在等扫码、其实没有二维码"的 pending 态
      if (generation === this.generation) this.state = 'idle';
      throw err;
    }
    if (generation !== this.generation) {
      // 等待建任务期间又有人点了一次「扫码创建」：这一轮作废（新一轮的会在自己那支里返回）
      throw new Error('已经开始了新一轮扫码，这一轮作废；请以最新那个二维码为准。');
    }
    this.taskId = created.taskId;
    this.keyB64 = created.keyB64;
    this.url = bindUrlOf(created.taskId, this.options.source ?? QQ_BIND_SOURCE_DEFAULT);
    // pollIntervalMs <= 0：不起后台定时器，完全由 poll() 驱动（用例的确定性靠它）
    if (this.pollIntervalMs > 0) {
      this.intervalHandle = this.scheduler.setInterval(() => {
        void this.runTick();
      }, this.pollIntervalMs);
    }
    this.deadlineHandle = this.scheduler.setTimeout(() => {
      this.expire('等待超时（二维码等了太久），请重新生成。');
    }, this.timeoutMs);
    return { taskId: this.taskId, url: this.url };
  }

  /**
   * 查一次状态（端点用它；界面每 2 秒问一次）。
   *
   * 有在飞的网络请求就先等它（拿到的就是最新结论）；没有且到了节奏就顺手查一次
   * ——所以"界面在轮询"与"后台定时器"两条路都能推动这轮扫码，且不会把对端打成压力测试。
   */
  async poll(): Promise<QqBindView> {
    try {
      if (this.inflight !== null) {
        await this.inflight;
      } else if (this.state === 'pending' && !this.cancelled && this.due()) {
        await this.runTick();
      }
    } catch (err) {
      // 兜底：tick 自己不该抛，但"读状态"这一下不该把异常栈甩给界面
      this.lastError = messageOf(err);
      this.options.onError?.(`[QQ] 查绑定结果失败：${this.lastError}`);
    }
    return this.snapshot();
  }

  /** 当前状态（不发请求，纯读） */
  snapshot(): QqBindView {
    const view: QqBindView = { status: this.state };
    if (this.taskId !== '') view.taskId = this.taskId;
    if (this.url !== '') view.url = this.url;
    if (this.appId !== '') view.appId = this.appId;
    if (this.settled !== null) {
      view.saved = this.settled.saved;
      view.enabled = this.settled.enabled;
      if (this.settled.connection !== undefined) view.connection = this.settled.connection;
      if (this.settled.note !== undefined) view.note = this.settled.note;
      if (this.settled.error !== undefined) view.error = this.settled.error;
    }
    if (this.lastError !== '' && view.error === undefined) view.error = this.lastError;
    if (this.reason !== '') view.reason = this.reason;
    return view;
  }

  /** 取消这一轮：释放定时器。状态停在原处，下一次 `start()` 会重开一轮。 */
  cancel(): void {
    this.cancelled = true;
    this.generation += 1;
    this.stopTimers();
  }

  // ── 内部 ──

  private due(): boolean {
    if (this.pollIntervalMs <= 0) return true;
    return this.now() - this.lastTickAt >= this.pollIntervalMs;
  }

  private runTick(): Promise<void> {
    if (this.inflight !== null) return this.inflight;
    // 节奏只认这一处：界面每 2 秒来问一次、后台定时器也每 2 秒响一拍——两条路可能挤在同一拍，
    // 这里按 `lastTickAt` 让它们合流，最多仍是"每 2 秒一次网络请求"。
    // `pollIntervalMs <= 0`（用例）不设限：完全由 `poll()` 驱动，要的是确定性。
    if (this.pollIntervalMs > 0 && this.now() - this.lastTickAt < this.pollIntervalMs) {
      return Promise.resolve();
    }
    const generation = this.generation;
    const running = this.tick(generation).finally(() => {
      if (this.inflight === running) this.inflight = null;
    });
    this.inflight = running;
    return running;
  }

  /** 一轮网络往返。**不抛**：所有失败都转成 `lastError`（中文），状态机照旧往前走。 */
  private async tick(generation: number): Promise<void> {
    if (this.state !== 'pending' || this.cancelled || generation !== this.generation) return;
    const nowMs = this.now();
    if (nowMs - this.startedAt >= this.timeoutMs) {
      this.expire('等待超时（二维码等了太久），请重新生成。');
      return;
    }
    this.lastTickAt = nowMs;
    const taskId = this.taskId;
    let result: QqBindPollResult;
    try {
      result = await pollBindResult(taskId, this.http);
    } catch (err) {
      if (generation !== this.generation) return;
      this.lastError = messageOf(err);
      this.options.onError?.(`[QQ] 查绑定结果失败：${this.lastError}`);
      return;
    }
    if (generation !== this.generation || this.state !== 'pending' || this.cancelled) return;

    if (result.status === QQ_BIND_STATUS_SUCCESS) {
      await this.complete(generation, result);
      return;
    }
    if (result.status === QQ_BIND_STATUS_EXPIRED) {
      if (this.rebuildOnExpired && !this.rebuilt) {
        this.rebuilt = true;
        this.options.onError?.('[QQ] 二维码过期，自动重建一次');
        try {
          const created = await createBindTask(this.http);
          if (generation !== this.generation || this.state !== 'pending') return;
          this.taskId = created.taskId;
          this.keyB64 = created.keyB64;
          this.url = bindUrlOf(created.taskId, this.options.source ?? QQ_BIND_SOURCE_DEFAULT);
          this.lastTickAt = this.now();
          this.lastError = '';
        } catch (err) {
          if (generation !== this.generation) return;
          this.expire(`二维码过期了，自动重建也没成功：${messageOf(err)}`);
        }
        return;
      }
      this.expire('二维码过期了，请重新生成。');
      return;
    }
    // 0 / 1 / 未知：都当"还没好"。未知值不报错——官方可能加中间态，等超时兜底。
  }

  private async complete(generation: number, result: QqBindPollResult): Promise<void> {
    const appId = result.botAppId.trim();
    if (appId === '') {
      this.expire('绑定成功了，但响应里没有 AppID：请重新生成二维码再扫一次。');
      return;
    }
    let clientSecret: string;
    try {
      clientSecret = decryptBindSecret(result.botEncryptSecret, this.keyB64);
    } catch (err) {
      // 解不出来就**不能**算成功：没有 secret 的 AppID 写进去只会让通道一直 401。
      this.expire(messageOf(err));
      return;
    }
    if (generation !== this.generation || this.state !== 'pending') return;

    this.appId = appId;
    this.state = 'success';
    this.stopTimers();
    this.options.onError?.(`[QQ] 扫码绑定成功：AppID ${appId}`);
    if (this.options.onSettled === undefined) return;
    try {
      this.settled = await this.options.onSettled({ appId, clientSecret });
    } catch (err) {
      // 绑定本身成功、但落盘失败：如实说"没保存"，让人知道还得再来一次
      this.settled = {
        saved: false,
        enabled: false,
        error: `绑定成功，但凭据没写进去：${messageOf(err)}`,
      };
    }
  }

  private expire(reason: string): void {
    if (this.state !== 'pending') return;
    this.state = 'expired';
    this.reason = reason;
    this.stopTimers();
    this.options.onError?.(`[QQ] 扫码结束（expired）：${reason}`);
  }

  private stopTimers(): void {
    if (this.intervalHandle !== null) {
      this.scheduler.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.deadlineHandle !== null) {
      this.scheduler.clearTimeout(this.deadlineHandle);
      this.deadlineHandle = null;
    }
  }
}
