/**
 * Irmia Agent — DeepSeek Responses API 客户端与错误分类退避
 *
 * 依据：docs/design.md §4.13（cache 协同 → `usage.input_tokens_details.cached_tokens` 归账）、
 * §4.14（模型接入层：错误分类表、指数退避、流式与中断、降级链、连接纪律）。
 * 字段级语义取自官方文档实证（2026-09 核验）：
 *   - `POST {baseUrl}/responses` 无状态，多轮必须每次回传完整 `input`；
 *     请求字段 `model` / `input` / `instructions` / `tools` / `reasoning` / `max_output_tokens` /
 *     `text` / `user`；`input` 与 `instructions` 至少传一个。
 *   - 响应 `status` ∈ {in_progress, completed, incomplete, failed}；`output[]` 三类 item
 *     （message / reasoning / function_call）；用量在 `usage`，缓存命中数为
 *     `usage.input_tokens_details.cached_tokens`；截断原因在 `incomplete_details.reason`
 *     （max_output_tokens / content_filter）。
 *   - `stream: true` 返回语义化 SSE（response.output_text.delta / reasoning_text.delta /
 *     function_call_arguments.delta / output_item.* / completed / incomplete / failed），
 *     最后一个事件是终态且**没有** `data: [DONE]`。
 *   来源：https://api-docs.deepseek.com/zh-cn/api/create-response
 *         https://api-docs.deepseek.com/zh-cn/guides/responses_api/
 *
 * 刻意不做的两件事（边界写清，免得下沉职责）：
 *   1. lane 并发门（heavy 1 / light 2）与 keepalive 复用属于循环层连接纪律：默认 fetch(undici)
 *      已带连接池复用，并发门由 step 调度实现。
 *   2. 降级链状态机（heavy 连败 → 备用端点 → light 兜底）由循环层驱动：本文件只暴露
 *      `modelFor()` 与 `DsRequest.model` 覆盖点，以及可外抛的连续失败计数 `failStreak`。
 *
 * 约定：值导入写 `.ts`（--experimental-strip-types 只擦类型不改路径），类型导入写 `.js`。
 */

import type { ModelLane } from '../log/types.js';
import { chatCompletionsTransport } from './transport/chat-completions.ts';
import { ProtocolRegistry, type FailureEvidence, type SwitchDecision } from './transport/registry.ts';
import { responsesTransportParts } from './transport/responses.ts';
import { SseFrameDecoder } from './transport/sse.ts';
import type { ModelProtocol, ModelProtocolPreference, ModelTransport, StreamAccumulator, TransportRequest } from './transport/types.js';

// ──────────────────────────────── 常量 ────────────────────────────────

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_HEAVY_MODEL = 'deepseek-v4-pro';
export const DEFAULT_LIGHT_MODEL = 'deepseek-flash';
/**
 * 非流式（`generate()`）的单请求**总时限**（含思维链生成时间；§4.14「总超时上限」）。
 *
 * **流式那条路不再用它**（2026-10-16 改，见 {@link DEFAULT_STREAM_SILENCE_MS}）：
 * 总时限对一条正在活跃输出的 SSE 是错的判据——它会在一段正常的长思考写到一半时把连接掐掉。
 * light 的 `generate()` 是"一问一答、没有增量可救"，总时限在那里仍然是对的。
 */
export const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * 流式的**静默时限**（毫秒）：多久**没收到任何 SSE 数据**（分片/心跳/注释行）才判它卡死。
 *
 * 判据是"沉默"而不是"总耗时"——这是 2026-10-16 那批 180s 事故的正解：
 * 实测被掐那一刻服务端**正在活跃输出**（已累积 10 万字符推理、断在半句话上），
 * 而旧判据（总时限）只看得见"从发出到现在多久"，看不见"它一直在吐字"。
 *
 * 取值 **120 s** 的依据：现有的那条总时限是 180s，而实测帧流不慢（180s 内产出 10 万字符
 * ⇒ 平均每 1.8ms 一段）；反过来，**120s 一片都没有**是"这条连接真卡了"的强信号，
 * 而 180s 会把"服务端排队/长思考里正常的空档"一起误伤（那正是用户报的「思考 40 分钟」会被掐）。
 */
export const DEFAULT_STREAM_SILENCE_MS = 120_000;

/**
 * 流式的**硬顶**（毫秒）：无论收到多少数据，一次请求都不许超过这个总时长。
 *
 * 为什么静默判据之外还要它：静默只抓得住"零输出"那一种卡死；一个**永远不结束但一直在吐字**
 * 的服务端（对端 bug、被代理反复喂心跳、模型真的停不下来）能让静默窗口永远被喂饱
 * ⇒ 连接永远挂着。硬顶就是那一种的兜底。
 *
 * 取值 **3 小时**的依据（刻意宽到"长思考根本撞不到"）：
 *   · 用户明说「思考 40 分钟都有可能」；按实测吞吐 8~30 tok/s 反推，
 *     40 分钟 ≈ 1.9~7.2 万 output token；
 *   · 3 小时 = 4.5 个"40 分钟"，对应约 8.6~32 万 token —— 已经越过 max_output_tokens
 *     会把输出截断的量级，所以**真到这一步就不是"想得久"，是"停不下来"**；
 *   · 它与本文件里那条"总时限"是两件事：总时限（180s/可配）判"多久没结束"，
 *     硬顶判"永远不结束"。它不是给正常请求用的，是给挂死的连接用的。
 */
export const DEFAULT_STREAM_HARD_CAP_MS = 10_800_000;

/** 静默时限的合法范围（配置校验用）：1s ~ 1h。再短会把正常空档误判，再长就失去"卡死"的意义 */
export const MIN_STREAM_SILENCE_MS = 1_000;
export const MAX_STREAM_SILENCE_MS = 3_600_000;
/** 硬顶的合法范围：不得短于静默时限，上限 24h（超过它就不再是"兜底"而是"没有兜底"） */
export const MAX_STREAM_HARD_CAP_MS = 86_400_000;
/** 非流式总时限的合法范围：1s ~ 1h */
export const MIN_NONSTREAM_TIMEOUT_MS = 1_000;
export const MAX_NONSTREAM_TIMEOUT_MS = 3_600_000;
/** 连续失败上限，与 §4.6 失败刹车的默认阈值 5 同源 */
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_BASE_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 30_000;
/**
 * `Retry-After` 的**上限**（毫秒，2026-10-18，review P1-08）。
 *
 * 为什么必须封顶：那个头是**对端的建议**，不封顶就等于把"这次调用睡多久"的决定权交给它——
 * 一个 `3600`（秒）就让这一拍在 busy 区里干等一小时（`real-loop` 的 busy 一锁，其余拍全丢，
 * 连"水位停滞"那条告警自己都发不出去）。429 与 5xx 都可能带这个头，HTTP-date 形态更是能到小时级。
 *
 * 取 60s 的依据：一次退避该有的量级（指数曲线自己封在 `DEFAULT_MAX_DELAY_MS` = 30s），
 * 比它更长的等待属于**上层**的节奏（turn 级重投、下一拍），不该在客户端里无条件睡掉。
 * 被封顶时 `RetryInfo.retryAfterCappedFromMs` 带着原值出去，装配层据此写一行日志
 * （"被截断"必须看得见，否则事后只看得见"退了 60s"，看不出对端要的是 1h）。
 */
export const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;
/** `empty` 的有限重试上限（§4.14 表：有限重试 3 次后走降级链） */
export const EMPTY_MAX_ATTEMPTS = 3;
/** 部署标识默认值：KVCache 调度亲和用；字符集限 [a-zA-Z0-9\-_]，≤512 */
export const DEFAULT_DEPLOYMENT_USER = 'irmia-agent';
/** 服务端错误信息截断：进日志也进告警，不把整页 HTML 带进去 */
export const ERROR_DETAIL_LIMIT = 2_000;

// ──────────────────────────────── 请求形状 ────────────────────────────────

/** 输入 item：渲染层（§4.13）产出的字节稳定结构，此处只做透传，不做重排 */
export interface DsInputTextPart {
  type: 'input_text' | 'output_text';
  text: string;
}

/**
 * 图片块：DS Responses 原生支持，`image_url` 可以是 **data URL** 也可以是 http(s) 直链
 * （直链由服务端自己去取——实测拿一个取不到的地址会得到 400 `Failed to download image`，
 * 所以历史里塞过期直链等于把那条历史变成永久 400；进上下文的图片一律落到本地再转 data URL）。
 */
export interface DsInputImagePart {
  type: 'input_image';
  image_url: string;
}

export type DsInputContentPart = DsInputTextPart | DsInputImagePart;

export interface DsInputMessage {
  type?: 'message';
  role: 'user' | 'assistant' | 'system' | 'developer';
  /**
   * 纯文字时是 string（**保持字节稳定**：没有图片的历史渲染结果一个字节都不变），
   * 带图片时是 content 数组。
   */
  content: string | DsInputContentPart[];
}

export interface DsInputFunctionCall {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

export interface DsInputFunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

/** 回传历史时**必须**携带 reasoning（§4.13 铁律 3，v3 修订）：带 tools 的请求若缺了历史轮次的 reasoning_text，下一次请求直接 400——保留类型不是"只为完整"，是规范要求 */
export interface DsInputReasoning {
  type: 'reasoning';
  content: Array<{ type: 'reasoning_text'; text: string }>;
}

export type DsInputItem =
  | DsInputMessage
  | DsInputFunctionCall
  | DsInputFunctionCallOutput
  | DsInputReasoning;

export interface DsTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 思考强度：`none` 关闭思考模式；其余开启（官方 effort 枚举） */
export type DsReasoningEffort = 'none' | 'low' | 'high' | 'max';

export type DsTextFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; schema: Record<string, unknown> };

export interface DsRequest {
  lane: ModelLane;
  /** 覆盖 lane 默认模型：降级链与 light 兜底走这里 */
  model?: string;
  input: string | DsInputItem[];
  instructions?: string;
  tools?: DsTool[];
  reasoning?: { effort: DsReasoningEffort };
  maxOutputTokens?: number;
  text?: DsTextFormat;
  /** 思考模式下不生效（官方说明），保留字段但不做静默改写 */
  temperature?: number;
  /** 仅思考模式生效且下限 0.95 */
  topP?: number;
  /** 调用方中断信号：中断不是错误，见 DsErrorKind 的 aborted */
  signal?: AbortSignal;
}

// ──────────────────────────────── 响应形状 ────────────────────────────────

export interface DsUsage {
  inputTokens: number;
  outputTokens: number;
  /** 命中上下文硬盘缓存的输入 token（§4.13 归账口径） */
  cachedTokens: number;
  /** 思维链 token（usage.output_tokens_details.reasoning_tokens）——**落库到 `budget/consumed.reasoningTokens`**（观测字段，已含在 outputTokens 里） */
  reasoningTokens: number;
}

export interface DsMessageOutput {
  type: 'message';
  id: string;
  text: string;
}

export interface DsReasoningOutput {
  type: 'reasoning';
  id: string;
  text: string;
}

export interface DsFunctionCallOutput {
  type: 'function_call';
  id: string;
  callId: string;
  name: string;
  arguments: string;
}

export type DsOutputItem = DsMessageOutput | DsReasoningOutput | DsFunctionCallOutput;

/** 响应终态：`in_progress` 不是终态，非流式收到它按服务端异常处理 */
export type DsStatus = 'completed' | 'incomplete' | 'failed';

export type DsIncompleteReason = 'max_output_tokens' | 'content_filter';

export interface DsResponse {
  status: DsStatus;
  outputItems: DsOutputItem[];
  usage: DsUsage;
  incompleteReason: DsIncompleteReason | null;
  model: string;
  responseId: string | null;
  /** 本次 HTTP 往返总耗时，直接进 `budget/consumed.durationMs` */
  durationMs: number;
  /**
   * 这一发**实际用的协议**（协议回退之后它可能与配置里的首选不同）。
   *
   * **可选**：老日志、测试替身、以及"没走传输层"的调用点都没有它 ⇒ 缺省 = **不知道**
   * （读的一侧不许默认成 `'responses'`，那会把"没写"读成"用过 Responses"）。
   * 它进 `budget/consumed.protocol`（纯观测字段，不进请求体）。
   */
  protocol?: ModelProtocol;
  /**
   * **对端这一发没给 usage**（连一个字段都没给）——契约、口径与读法**逐字同**
   * `DsStreamResult.usageMissing`（那一条注释是权威版本，不在这里抄第二份）。
   *
   * 非流式那条路的实际价值比流式低（一问一答的对端几乎都会给），但两套协议**同一个形状**
   * 才能让六处写入点用同一行判据，所以照写。
   */
  usageMissing?: true;
}

export interface DsStreamCallbacks {
  /** 可见文本增量：逐段落 `message/assistant` 与前端推送 */
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onFunctionCallDelta?: (delta: {
    callId: string;
    name: string;
    argumentsDelta: string;
  }) => void;
  /** 每个 SSE 事件（含 created/in_progress 等），用于观测与排障 */
  onEvent?: (event: { type: string; payload: unknown }) => void;
}

export interface DsStreamResult {
  /**
   * **上游终态**：`response.completed` / `response.incomplete` / `response.failed` 里服务端自己
   * 报的 status。没收到终态事件时恒为 `'incomplete'` —— **不许**把断流/超时/调用方中断写成
   * `'failed'`：`'failed'` 只表示"上游明确宣告失败"。失败与否只看 `failure` 那一格。
   */
  status: DsStatus;
  /** 已推送的可见文本全文（中断时即"已收部分"，对齐 schema §3 的 interrupted 语义） */
  text: string;
  reasoning: string;
  toolCalls: Array<{ callId: string; name: string; arguments: string }>;
  outputItems: DsOutputItem[];
  usage: DsUsage;
  incompleteReason: DsIncompleteReason | null;
  model: string | null;
  responseId: string | null;
  durationMs: number;
  /** 未收到终态事件即为 true：网络断、超时、调用方中断都算（只说"没收到终态"，不说成没成功） */
  interrupted: boolean;
  /**
   * **失败判据（唯一）**：非 null ⇔ 这次调用**没有正常收尾**。
   *
   * 两类都落在这里：
   *   · 上游终态事件宣告失败（`response.failed`）——非流式的同一状态在 `parseResponseBody`
   *     里直接抛 `DsClientError{kind:'server'}`，两条路的语义一致；
   *   · 或者压根没等到终态事件（断流 / 静默或硬顶超时 / 调用方中断）。
   *
   * 正常收尾（`response.completed` / `response.incomplete`）恒为 `null`。
   *
   * **循环层只读这一格**判"这一步是不是失败"（`runtime/agent-loop.ts` 的 `runStep`），
   * 不再自己组合 `status` / `interrupted` 判第二遍——那正是 2026-10-17 修掉的 P0 的形状：
   * 客户端用 status/failure 表达终态失败，循环层只认 `interrupted`，于是 `response.failed`
   * 走成"成功收尾"（半截工具调用被拿去执行、turn 记 completed、输入不退回）。
   *
   * 这条不变量由 `build()` **一处**兜底：上游没带 `error` 对象、或流在终态前结束，都会补一条
   * **有码有文**的原因 —— "失败不可能没有依据"，循环层也就不需要任何 fallback 判据。
   */
  failure: { code: string; message: string } | null;
  /** 这一发实际用的协议（契约同 `DsResponse.protocol`：可选、缺省 = 不知道） */
  protocol?: ModelProtocol;
  /**
   * **对端这一发没有给 usage**（连一个字段都没给）：四格是补出来的 0，**不是真值**。
   *
   * 为什么值得单开一格（设计 §6.2 / §9.3#20，"预算少算"的唯一答案）：断流/超时/硬顶掐掉的
   * 那一拍常常一个 usage 字段都收不到，账上记 0——事后只能看出"这一拍花了 0 元"，看不出
   * "**这 0 是不知道，不是没花**"。它与 `interrupted` 不是一回事：正常收尾但兼容层不给 usage
   * 的流也会是 `true`（那正是"换到 Chat 之后预算会少算"的现场）。
   *
   * 可选：缺省 = **有 usage**（老日志、测试替身、以及"我们自己造的结果"都没有这一格）。
   * 读的一侧必须写成 `usageMissing === true`，别把 `undefined` 读成"缺"。
   */
  usageMissing?: true;
}

// ──────────────────────────────── 错误分类 ────────────────────────────────

/** §4.14 错误分类表 + aborted（中断不是错误，但必须与 timeout 区分开） */
export type DsErrorKind =
  | 'rate_limited'
  | 'server'
  | 'timeout'
  | 'empty'
  | 'invalid'
  | 'network'
  | 'aborted';

const RETRYABLE_KINDS: ReadonlySet<DsErrorKind> = new Set<DsErrorKind>([
  'rate_limited',
  'server',
  'timeout',
  'empty',
  'network',
]);

export interface DsErrorInit {
  kind: DsErrorKind;
  message: string;
  /** 稳定错误码，进日志与告警指纹 */
  code?: string;
  status?: number | null;
  /** 429 的 Retry-After 解析结果（毫秒） */
  retryAfterMs?: number | null;
  /** 已尝试次数（含本次），由重试层标注 */
  attempts?: number;
  /** 连续失败次数，由 DsClient 外抛 */
  consecutiveFailures?: number;
  /** 服务端响应体片段（截断后） */
  detail?: string | null;
  cause?: unknown;
}

export class DsClientError extends Error {
  readonly kind: DsErrorKind;
  readonly code: string;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly attempts: number;
  readonly consecutiveFailures: number;
  readonly detail: string | null;
  readonly retryable: boolean;

  constructor(init: DsErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'DsClientError';
    this.kind = init.kind;
    this.code = init.code ?? init.kind;
    this.status = init.status ?? null;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.attempts = init.attempts ?? 0;
    this.consecutiveFailures = init.consecutiveFailures ?? 0;
    this.detail = init.detail ?? null;
    this.retryable = RETRYABLE_KINDS.has(init.kind);
  }

  /** 重试层与 DsClient 回填计数用：不改原对象，避免并发路径共享可变状态 */
  withContext(patch: { attempts?: number; consecutiveFailures?: number }): DsClientError {
    return new DsClientError({
      kind: this.kind,
      message: this.message,
      code: this.code,
      status: this.status,
      retryAfterMs: this.retryAfterMs,
      attempts: patch.attempts ?? this.attempts,
      consecutiveFailures: patch.consecutiveFailures ?? this.consecutiveFailures,
      detail: this.detail,
      cause: this.cause,
    });
  }
}

export function isDsClientError(value: unknown): value is DsClientError {
  return value instanceof DsClientError;
}

/**
 * 两个中止原因的**哨兵**（`AbortController.abort(reason)` 的原样载荷）。
 *
 * 为什么用 `instanceof` 认而不是靠错误消息里的字：消息是给人读的文案，会被改；
 * 而"是被我们自己哪一只闸掐掉的"必须是**判据**——`classifyTransportError` 要用它把
 * 两种情况分开（静默 vs 硬顶），归因错了，事后读日志的人会去查错的墙。
 * 取 `name` 也带上（`Error` 子类的常规做法），但判据只用 `instanceof`。
 */
export class DsSilenceTimeout extends Error {
  constructor() {
    super('DsClient 流式静默超时：这么久没有收到任何数据');
    this.name = 'DsSilenceTimeout';
  }
}

export class DsHardCapTimeout extends Error {
  constructor() {
    super('DsClient 流式硬顶超时：一次请求的总时长超过硬上限');
    this.name = 'DsHardCapTimeout';
  }
}

/**
 * `Retry-After` 解析：整数秒或 HTTP-date 两种形态，非法值返回 null。
 * 过去时间与 0 都归 0——服务端说"立即可重试"时不该被我们的指数退避覆盖。
 */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - Date.now());
}

/** HTTP 状态 → 类别（§4.14 表；4xx 除 429 外一律不重试） */
export function classifyHttpStatus(
  status: number,
  extra: { retryAfterMs?: number | null; detail?: string | null } = {},
): DsClientError {
  const detail = extra.detail ?? null;
  const retryAfterMs = extra.retryAfterMs ?? null;
  const code = `http_${status}`;
  if (status === 429) {
    return new DsClientError({
      kind: 'rate_limited',
      code,
      message: `模型接口限流（429）${retryAfterMs === null ? '' : `，服务端建议等待 ${retryAfterMs}ms`}`,
      status,
      retryAfterMs,
      detail,
    });
  }
  if (status >= 500) {
    return new DsClientError({ kind: 'server', code, message: `模型接口服务端错误（${status}）`, status, retryAfterMs, detail });
  }
  return new DsClientError({
    kind: 'invalid',
    code,
    message: `请求被拒绝（${status}）：重试同样的请求必然同样失败`,
    status,
    retryAfterMs,
    detail,
  });
}

/**
 * **400 的一种可判别指纹：思考模式要求回传思维链，而我们没回**（2026-10-17 实测）。
 *
 * 服务端原话（逐字，`data/events/000000136342.jsonl` seq 137943 = turn 2151 / seq 138764 = turn 2174）：
 *   {"error":{"message":"The `reasoning_text` in the thinking mode must be passed back to the API.
 *    (request_id: …)","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}
 *
 * **为什么要一个专门判据，而不是"看见 400 就算"**：4xx 除 429 外一律归 `invalid`、一律不重试，
 * 而 `invalid` 是个大筐。实测同一份日志里 57 条 `http_400` 分两类，处置完全不同：
 *   · 23 条是这条（要改的是"回不回传思维链"，已另案等用户拍板）；
 *   · 32 条是 `input[35]: You have uploaded an unsupported image…`（要改的是那一条消息本身）。
 * 事后只看得见一个 `http_400`，等于两条线索一起丢了。
 *
 * 判据：正文里同时出现 `reasoning_text` 与 `passed back`，
 *   · **大小写不敏感**（服务端换个 casing 也认）；
 *   · **两者之间允许任意字符**（实测原话中间还夹着 "in the thinking mode must be "，
 *     而进日志的是一整段被 JSON 转义过的正文，引号/反斜杠/换行都可能出现）；
 *   · 但**不许隔太远**（`{0,200}`）：一份正文里可能有两段互不相干的字段，隔了半篇就不算同一条消息，
 *     宁可漏标也不误标（误标的代价是把人引去改错的墙）。
 *
 * 它只做**识别**，不做任何处置：分类仍是 `invalid`、仍然不重试、结局仍是 `error`——
 * 这一格不改变任何行为，只让"是哪一类 400"从此能用 grep 判出来。
 */
export function isReasoningEchoRejection(detail: string | null | undefined): boolean {
  if (typeof detail !== 'string' || detail === '') return false;
  return /reasoning_text[\s\S]{0,200}?passed[\s_-]*back/iu.test(detail);
}

/**
 * 传输层失败 → 类别。判据顺序即优先级：先看是谁中止的（调用方 / 我们的超时），
 * 再看 socket 级错误码——连接被重置归 server，DNS 与连接失败归 network（§4.14 表）。
 */
export function classifyTransportError(
  error: unknown,
  flags: { timedOut: boolean; externalAborted: boolean; hardCap?: boolean; silenceMs?: number; hardCapMs?: number },
): DsClientError {
  if (flags.externalAborted) {
    return new DsClientError({ kind: 'aborted', code: 'aborted', message: '调用方中断了请求', cause: error });
  }
  if (flags.timedOut && flags.hardCap === true) {
    // 硬顶与静默必须**分开报**：两者的下一步动作不同（静默 ⇒ 值得重连；硬顶 ⇒ 这条请求本身
    // 就停不下来，重发只会再来三小时），事后读日志的人也要一眼看出是哪一只闸掐的。
    const cap = flags.hardCapMs === undefined ? '' : `（${flags.hardCapMs}ms）`;
    return new DsClientError({
      kind: 'timeout',
      code: 'timeout_hard_cap',
      message: `流式请求撞到硬顶${cap}仍未结束，已中止`,
      cause: error,
    });
  }
  if (flags.timedOut) {
    const silence = flags.silenceMs === undefined ? '' : `（${flags.silenceMs}ms 没有收到任何数据）`;
    return new DsClientError({
      kind: 'timeout',
      code: 'timeout_silent',
      message: `流式请求静默超时${silence}，已中止`,
      cause: error,
    });
  }
  const code = transportCodeOf(error);
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') {
    return new DsClientError({ kind: 'server', code: code, message: `连接被重置（${code}）`, cause: error });
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return new DsClientError({ kind: 'timeout', code, message: `连接层超时（${code}）`, cause: error });
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    // 未命中任何标志的 AbortError：按超时处理，宁可退避也不无限重试
    return new DsClientError({ kind: 'timeout', code: 'aborted_unknown', message: '请求被中止（未区分来源）', cause: error });
  }
  return new DsClientError({
    kind: 'network',
    code: code === '' ? 'network' : code,
    message: `网络不可用（${code === '' ? 'unknown' : code}）：DNS 解析失败或连接无法建立`,
    cause: error,
  });
}

function transportCodeOf(error: unknown): string {
  if (!(error instanceof Error)) return '';
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  const own = (error as { code?: unknown }).code;
  return typeof own === 'string' ? own : '';
}

// ──────────────────────────────── 退避 ────────────────────────────────

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface RetryInfo {
  /** 已失败次数（第 attempt 次失败后准备重试） */
  attempt: number;
  delayMs: number;
  kind: DsErrorKind | 'unknown';
  lane: ModelLane;
  /**
   * `Retry-After` 被**封顶**时的原值（毫秒）：出现它 ⇔ 服务端要求等的时间超过了上限，
   * 真正睡的长度是 `delayMs`。
   *
   * 为什么要这一格：封顶本身必须可观测——只看见"退了 60s"而不知道对端要的是 1h，
   * 事后会去查错的墙（以为我们自己的曲线在退避）。装配层拿它写日志（`main.ts` 的 `onRetry`）。
   */
  retryAfterCappedFromMs?: number;
}

export interface RetryOptions {
  /** 最大尝试次数（含首次），默认 5 */
  maxAttempts?: number;
  lane?: ModelLane;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /**
   * `Retry-After` 的上限（毫秒，缺省 {@link DEFAULT_MAX_RETRY_AFTER_MS}）：
   * 服务端建议超过它时按它睡（并在 `RetryInfo` 里标出原值），**不许**无上限地等下去。
   */
  maxRetryAfterMs?: number;
  /** 中断信号：退避期间被中断即停止重试 */
  signal?: AbortSignal;
  sleep?: SleepFn;
  onRetry?: (info: RetryInfo) => void;
  /** 由调用方收紧重试策略（DsClient 用它把 empty 限到 3 次） */
  shouldRetry?: (error: unknown, attempt: number, lane: ModelLane) => boolean;
}

/** 默认 sleep：可被中断，中断按 aborted 抛出而不是静默返回 */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DsClientError({ kind: 'aborted', code: 'aborted', message: '退避被中断' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DsClientError({ kind: 'aborted', code: 'aborted', message: '退避被中断' }));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 指数退避封装。退避时长 = min(base · 2^(n-1), cap)；服务端给了 `Retry-After` 时以它为准
 * （尊重服务端提示优先于我们的曲线），但它**有上限**（{@link DEFAULT_MAX_RETRY_AFTER_MS}，
 * 超过就按上限睡、并在 `RetryInfo` 里标出原值——理由见那个常量）。
 * 抛出的错误已回填 attempts；连续失败计数由调用方（DsClient）叠加后外抛。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const lane: ModelLane = options.lane ?? 'heavy';
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const maxRetryAfterMs = Math.max(0, options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS);
  const sleep = options.sleep ?? defaultSleep;
  const shouldRetry = options.shouldRetry ?? ((error: unknown) => error instanceof DsClientError && error.retryable);

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !shouldRetry(error, attempt, lane)) {
        throw annotateAttempts(error, attempt);
      }
      const retryAfterMs = retryAfterOf(error);
      const delayMs = backoffDelayMs(attempt, baseDelayMs, maxDelayMs, retryAfterMs, maxRetryAfterMs);
      // 只有"服务端要的比上限长"才算截断（其余情形 delayMs 就是曲线或原值，不标这一格）
      const cappedFromMs = retryAfterMs !== null && retryAfterMs > maxRetryAfterMs ? retryAfterMs : null;
      options.onRetry?.({
        attempt,
        delayMs,
        kind: kindOf(error),
        lane,
        ...(cappedFromMs === null ? {} : { retryAfterCappedFromMs: cappedFromMs }),
      });
      // sleep 自身的中断错误直接外抛：退避期间被取消就不该再打一次请求
      await sleep(delayMs, options.signal);
    }
  }
  throw annotateAttempts(lastError, maxAttempts);
}

export function backoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  retryAfterMs: number | null,
  maxRetryAfterMs: number = DEFAULT_MAX_RETRY_AFTER_MS,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  if (retryAfterMs === null) return exp;
  // 服务端提示优先，但**封顶**：不封顶时一个 3600 就能把一拍 tick 睡一小时（P1-08）
  const hinted = Math.min(retryAfterMs, Math.max(0, maxRetryAfterMs));
  return hinted > exp ? hinted : exp;
}

function retryAfterOf(error: unknown): number | null {
  return error instanceof DsClientError ? error.retryAfterMs : null;
}

function kindOf(error: unknown): DsErrorKind | 'unknown' {
  return error instanceof DsClientError ? error.kind : 'unknown';
}

function annotateAttempts(error: unknown, attempt: number): unknown {
  if (error instanceof DsClientError && error.attempts === 0) return error.withContext({ attempts: attempt });
  return error;
}

// ──────────────────────────────── 传输层（协议实现）────────────────────────────────

/**
 * **协议实现搬家了，字节一个都没搬。**
 *
 * `SseFrameDecoder` / `SseFrame` / `hasUsableOutput` / `hasPartialOutput` 现在住在
 * `transport/` 层（`sse.ts` / `responses.ts`），是**逐字搬过去**的；这里只把它们**再导出**一次
 * ——既有 import（`test/ds-client.test.ts` 直接从本文件取这四样）一行都不用改。
 *
 * 判据（两条一起看，缺一条就不算"零影响"）：
 *   · `test/protocol-bytes.test.ts` —— 请求字节逐字节不变（4 条夹具）；
 *   · `test/ds-client.test.ts` —— 解析行为不变（22 条，含分帧、usage 逐字段、中断结算）。
 */
export { SseFrameDecoder } from './transport/sse.ts';
export type { SseFrame } from './transport/sse.ts';
export { hasPartialOutput, hasUsableOutput } from './transport/responses.ts';

// ──────────────────────────────── 协议选择 ────────────────────────────────

/**
 * Responses 那一份协议实现（`transport/responses.ts` 里的 `responsesTransportParts`）。
 *
 * **必须写成函数（调用期取），不许写成 `const RESPONSES = responsesTransportParts`。**
 * 这不是风格问题：`ds-client ↔ transport/responses` 是**值依赖的环**（那边要 `DsClientError`），
 * 而"谁先被求值"取决于**入口文件的 import 顺序**。写成模块级常量时，只要有人先 import
 * `transport/*`（`test/model-transport.test.ts` 就是），`responses.ts` 会在本文件之前求值、
 * 又在它的顶部把本文件拉起来 ⇒ 本文件走到这一行时 `responsesTransportParts` 还在 TDZ 里，
 * 直接 `ReferenceError: Cannot access 'responsesTransportParts' before initialization`。
 * 写成函数体里的引用就只发生在**调用期**（那时两个模块都已完成求值），任意 import 顺序都成立。
 *
 * （这条是我自己踩出来的：第一次写成常量，`test/model-transport.test.ts` 当场炸。）
 */
function responsesTransport(): ModelTransport {
  return responsesTransportParts;
}

// ──────────────────────────────── 客户端 ────────────────────────────────

export interface DsClientOptions {
  /**
   * **配置的生命周期（2026-10-22 写明，别再猜）**：本接口的每一格都是**构造期取一次**，
   * 实例没有热更入口。`models.*` 是 **restart 级**（`config/watcher.ts` 的
   * `HOT_RELOAD_FIELDS` 只有 `mcp.servers`）⇒ 换端点/模型/时限/协议都要重启进程。
   *
   * 从前这里有一个 `applyConfig(patch)`：它收 `baseUrl` / 模型 / 三格时限，看着像热更。
   * 但**全仓零调用**（生产从未接线、也不打算接线），而它同时逼着 7 个字段不能 `readonly`
   * ——一处死代码，两种代价。已删除；`test/ds-client-lane-route.test.ts` 钉住"per-lane 取值
   * 只走 {@link DsClient.endpointFor}"，`test/model-transport.test.ts` 的 P9 钉住"URL 在
   * **send 那一刻**由 lane 的端点拼出来"（构造后不变，但也不是构造时拼死的）。
   */
  baseUrl?: string;
  apiKey: string;
  /**
   * **light lane 的端点**（`models.light.baseUrl`，2026-10-21 接上）。
   *
   * 缺省 = heavy 的 `baseUrl`：出厂配置里两格同值，所以既有的调用点与底片
   * （`test/protocol-bytes.test.ts`、`test/protocol-fallback.test.ts` …）**一个字节都不变**。
   *
   * 为什么它必须在这里：配置本来就是逐 lane 的（`models.heavy` / `models.light` 各有
   * `model` / `baseUrl` / `apiKeyEnv` / `protocol`），而这一格从前**从来没被运行时读过**
   * ——于是在 light 卡里换了端点，界面显示新值、请求仍旧打到 heavy 的 DeepSeek。
   * 判据见 `endpointFor`（唯一取值口）与 `test/ds-client-lane-route.test.ts`。
   */
  lightBaseUrl?: string;
  /**
   * **light lane 的密钥**（由宿主按 `models.light.apiKeyEnv` 单独解析后传进来）。
   *
   *   · 缺省（`undefined`）= **沿用 heavy 的** `apiKey`。出厂形态两格的 `apiKeyEnv` 都是
   *     `IRMIA_API_KEY`（同一个环境变量只可能有一个值），所以"沿用"就是事实；老调用点
   *     （测试、`tools/`、以及只配了一份 key 的历史配置）因此不受影响。
   *   · 显式 `null` = 这一格**没有可用的密钥**。此时若 `lightBaseUrl` 与 heavy 的不同，
   *     发送前当场报 `missing_api_key`（`kind:'invalid'`，不重试），**绝不**把 heavy 的密钥
   *     发到另一个端点——"换个 baseUrl 顺手把别人的 key 带过去"是一次真实的泄密形态。
   */
  lightApiKey?: string | null;
  heavyModel?: string;
  lightModel?: string;
  /**
   * `models.heavy.protocol` / `models.light.protocol`（配置层三档，协议回退 C-3，2026-10-21 加）。
   *
   * **分 lane 传**：配置本来就是逐 lane 的，同一端点上 heavy 与 light 可以各选各的。
   * 优先级与语义写在 {@link DsClient.protocolFor}；**restart 级**（没有运行期入口，
   * 因为"在途请求算哪套协议"没有正确答案）。
   */
  heavyProtocol?: ModelProtocolPreference;
  lightProtocol?: ModelProtocolPreference;
  /** 非流式（`generate()`）的总时限；缺省 {@link DEFAULT_TIMEOUT_MS}（配置键 `models.nonStreamTimeoutMs`） */
  timeoutMs?: number;
  /** 流式的**静默**时限；缺省 {@link DEFAULT_STREAM_SILENCE_MS}（配置键 `models.requestSilenceMs`） */
  silenceMs?: number;
  /** 流式的**硬顶**；缺省 {@link DEFAULT_STREAM_HARD_CAP_MS}（配置键 `models.requestHardCapMs`） */
  hardCapMs?: number;
  /** 部署标识，固定写进请求 `user`：KVCache 调度亲和（§4.13 观测闭环） */
  user?: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** `Retry-After` 的上限（毫秒，缺省 {@link DEFAULT_MAX_RETRY_AFTER_MS}；P1-08 的收口点之一） */
  maxRetryAfterMs?: number;
  /** 注入点：测试用 mock server 时无需替换；需要统计或代理时替换 */
  fetchImpl?: typeof fetch;
  sleep?: SleepFn;
  now?: () => number;
  onRetry?: (info: RetryInfo) => void;
  /**
   * **按协议覆盖实现**（注入点；生产永远不传）。
   *
   * 为什么 B 阶段就要有它：用户给的 R2 是"Chat 适配器抛任何异常 ⇒ 只能让这次请求退回**原始
   * Responses 错误**，绝不允许因为适配器有 bug 让本来能跑的主路径失败"。那条约束**必须注入一个
   * 会抛的实现**才测得到——否则它只是一句承诺（`test/model-transport.test.ts` 的两条用例用的就是它）。
   *
   * 它同时是"假传输"唯一的入口：不去改模块级共享对象（那会污染同进程里别的用例）。
   */
  transportOverride?: {
    responses?: ModelTransport | undefined;
    chat?: ModelTransport | undefined;
  } | undefined;
  /**
   * **一键关掉协议回退**（`IRMIA_DISABLE_CHAT_FALLBACK=1`，用户在 R3 里定的救急闸）。
   * `true` ⇒ 所有 lane 一律 `responses`，**连探测判据都不算**（探测计数恒 0）——"关掉就完全回到今天"。
   * 由宿主（`main.ts`）从环境变量读一次传进来：`DsClient` 自己不读 `process.env`（否则测试不可控）。
   */
  disableChatFallback?: boolean;
  /** 结论缓存的注入点：测试要"跨 client 共享同一份结论"时传它；生产不传（本实例独占一份） */
  registry?: ProtocolRegistry;
}

interface RequestHandle {
  signal: AbortSignal;
  timedOut(): boolean;
  /** 是"硬顶"而不是"静默"掐的吗（决定错误码，见 classifyTransportError） */
  hardCapped(): boolean;
  externalAborted(): boolean;
  /** 收到任何数据（含响应头）时调一次：静默计时器就此重置 */
  noteData(): void;
  dispose(): void;
}

export class DsClient {
  /**
   * heavy lane 的端点（`models.heavy.baseUrl`）与模型 id。
   *
   * **全部 `readonly`，构造后不再变**（2026-10-22）：`models.*` 是 **restart 级**配置
   * （`config/watcher.ts` 的 `HOT_RELOAD_FIELDS` 只有 `mcp.servers`），宿主在启动那一拍把两格
   * 端点/模型取定一次；换值 = 重启进程。原先这里有一支 `applyConfig(patch)` 的热更入口，
   * 但**全仓零调用**（生产从不热更、也没有计划热更）——留着它就是一份"看起来能热更"的
   * 假承诺，还会让这几个字段永远是可变状态。它已被删除（详见 {@link DsClientOptions}
   * 顶部那段"配置的生命周期"）。
   */
  readonly baseUrl: string;
  /**
   * light lane 的端点（`models.light.baseUrl`）。
   *
   * 与 {@link baseUrl}（heavy 的）分开两个字段、**不是一个"当前端点"**：同一拍里 heavy 与
   * light 可能同时有请求在飞，而它们本来就允许指向两个端点。取值只走 {@link endpointFor}。
   */
  readonly lightBaseUrl: string;
  readonly heavyModel: string;
  readonly lightModel: string;
  /**
   * 非流式总时限 / 流式静默时限 / 流式硬顶（毫秒）。
   *
   * **启动期参数**：来自 `models.requestTimeout`，而那一格**不在热更白名单里**
   * （`config/watcher.ts` 的 `HOT_RELOAD_FIELDS` 只有 `mcp.servers`）⇒ 改完要重启进程。
   * 在途请求按出发时那一份参数走；重启之后才换值。
   */
  readonly timeoutMs: number;
  readonly silenceMs: number;
  readonly hardCapMs: number;
  readonly user: string;

  /**
   * 三档协议选择（`models.heavy.protocol` / `models.light.protocol`，协议回退 C-3；**restart 级**）。
   *
   * 只在这里读一次（构造时由宿主从配置取）：中途换档会让"同一次调用的两发"落在两套协议上，
   * 而那时没有正确答案 ⇒ 与三格时限同一条口径（启动期参数）。
   */
  readonly heavyProtocol: ModelProtocolPreference;
  readonly lightProtocol: ModelProtocolPreference;

  private readonly apiKey: string;
  /**
   * light lane 的密钥（`models.light.apiKeyEnv` 解析出来的那一把）。
   *
   * `null` = 这一格没有可用密钥（见 `DsClientOptions.lightApiKey` 的两档语义）。
   * `undefined` 在构造器里已经被折成 heavy 的那一把，所以运行期只有 `string | null`。
   */
  private readonly lightApiKey: string | null;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: SleepFn;
  private readonly now: () => number;
  /**
   * 重试订阅者（`onRetry` 的**多播**形态）。
   *
   * 为什么从"构造时注入一个回调"改成订阅：消费方是**每轮新建**的（`runTurn` 每轮一个
   * `TurnRunner`），而 `DsClient` 是**进程级单例**——构造时注入就等于把第一轮的那个
   * 闭包永久钉在上面，后面每一轮的重试都记到第一轮头上去。订阅让"谁在听"跟着轮次走。
   *
   * 这一格的存在就是为了 `budget/consumed.retryCount`：原先只有**抛错**那条路上带得到
   * `attempts`，成功路径恒写 0（`agent-loop.ts` 里那条 TODO）。
   */
  private readonly retryListeners = new Set<(info: RetryInfo) => void>();
  /** 连续失败计数：成功即清零；随错误外抛供 §4.6 失败刹车使用 */
  private streak = 0;
  /** 最近一次**真发出去**的请求用的协议（`null` = 本进程还没发过）；只读接口见 {@link lastProtocol} */
  private lastSentProtocol: ModelProtocol | null = null;
  /** 按协议覆盖实现（注入点，见 `DsClientOptions.transportOverride`）：生产恒为空 */
  private readonly transportOverride: {
    responses?: ModelTransport | undefined;
    chat?: ModelTransport | undefined;
  };
  /** 协议回退的结论缓存 + 状态机（设计 §2.4/§5.2）：**本实例独占一份**，除非注入 */
  private readonly registry: ProtocolRegistry;

  constructor(options: DsClientOptions) {
    this.baseUrl = stripTrailingSlash(options.baseUrl ?? DEFAULT_BASE_URL);
    this.apiKey = options.apiKey;
    // light 的两格缺省都**继承 heavy**：出厂形态两格同值，老调用点因此逐字节不变。
    // 只有宿主显式给了 `lightBaseUrl` / `lightApiKey` 才会分岔（`main.ts` 按 lane 传）。
    this.lightBaseUrl = stripTrailingSlash(options.lightBaseUrl ?? this.baseUrl);
    this.lightApiKey = options.lightApiKey === undefined ? this.apiKey : options.lightApiKey;
    this.heavyModel = options.heavyModel ?? DEFAULT_HEAVY_MODEL;
    this.lightModel = options.lightModel ?? DEFAULT_LIGHT_MODEL;
    this.heavyProtocol = options.heavyProtocol ?? 'auto';
    this.lightProtocol = options.lightProtocol ?? 'auto';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.silenceMs = options.silenceMs ?? DEFAULT_STREAM_SILENCE_MS;
    this.hardCapMs = options.hardCapMs ?? DEFAULT_STREAM_HARD_CAP_MS;
    this.user = options.user ?? DEFAULT_DEPLOYMENT_USER;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.maxRetryAfterMs = Math.max(0, options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
    this.transportOverride = options.transportOverride ?? {};
    this.registry = options.registry ?? new ProtocolRegistry({
      disabled: options.disableChatFallback === true,
    });
    if (options.onRetry !== undefined) this.retryListeners.add(options.onRetry);
  }

  /**
   * 订阅"发生了一次重试"（返回退订函数）。
   *
   * 与构造选项 `onRetry` 等价，只是可以**多播**、且可以在运行期挂/摘——
   * 见 `retryListeners` 那段注释（轮次级观测需要它）。退订是幂等的。
   */
  subscribeRetry(listener: (info: RetryInfo) => void): () => void {
    this.retryListeners.add(listener);
    return () => { this.retryListeners.delete(listener); };
  }

  /** 通知所有订阅者；**任何订阅者抛错都不影响这次调用**（观测不该有能力打断请求） */
  private notifyRetry(info: RetryInfo): void {
    for (const listener of this.retryListeners) {
      try {
        listener(info);
      } catch {
        /* 观测回调抛错只丢这一次观测 */
      }
    }
  }

  /** lane → 端点模型；降级链用 `DsRequest.model` 覆盖 */
  modelFor(lane: ModelLane): string {
    return lane === 'light' ? this.lightModel : this.heavyModel;
  }

  /**
   * lane → **这一发真的会打到的端点与密钥**（2026-10-21）。
   *
   * 这是全类**唯一**的 per-lane 取值口：`protocolFor` / `assertProtocolAvailable` /
   * `noteFailureDecision` / `send` 全部从这里取，不再直接读 `this.baseUrl` / `this.apiKey`。
   * 少这一处收敛，"light 有自己的端点"就会变成五个地方各判一遍、迟早漏一个
   * （漏的那一个正是"界面换了端点、请求仍打 heavy"）。
   *
   * 密钥可能是 `null`（light 那一格没配、且宿主显式标了"没有"）：`send` 在发之前就把它
   * 变成 `missing_api_key`，绝不拿 heavy 的密钥顶上去——两格指不同端点时，那不是"兜底"
   * 而是把 A 家的密钥发给 B 家。
   */
  private endpointFor(lane: ModelLane): { baseUrl: string; apiKey: string | null } {
    return lane === 'light'
      ? { baseUrl: this.lightBaseUrl, apiKey: this.lightApiKey }
      : { baseUrl: this.baseUrl, apiKey: this.apiKey };
  }

  /**
   * 这一格（lane）此刻该走哪套协议 —— **唯一读点**（设计 §8.8.3 的优先级，从上到下第一个有结论的说话）：
   *
   *   1. `IRMIA_DISABLE_CHAT_FALLBACK=1`（构造时的 `disableChatFallback`，落在 `registry.disabled`）
   *      ⇒ **恒 `responses`**，连判据都不算（用户 R3 的救急闸：关掉就完全回到今天）；
   *   2. `models.<lane>.protocol` 是显式档（`'responses'` / `'chat-completions'`）⇒ **就是它**：
   *      强制档**不探测、不回退**（`'responses'` 永不切；`'chat-completions'` 不先试 Responses）；
   *   3. `'auto'`（缺省）⇒ 本进程对这个端点的探测结论（{@link ProtocolRegistry.protocolFor}）；
   *   4. 没结论 ⇒ `responses` —— **今天的行为**。
   *
   * 为什么分 lane：配置本来就是逐 lane 的（`models.heavy` / `models.light`），同一端点上两条
   * lane 可以各选各的；端点级的探测结论仍是共享的（`/responses` 存不存在是端点属性）。
   *
   * ⚠ 它**不是**"能不能发"的判据：`unavailable`（两条路都不通）时它返回 `'responses'`
   * （registry 那一侧的总函数口径），发送前的短路在 {@link assertProtocolAvailable} 里。
   */
  protocolFor(lane: ModelLane): ModelProtocol {
    if (this.registry.disabled) return 'responses';
    const preference = lane === 'light' ? this.lightProtocol : this.heavyProtocol;
    if (preference !== 'auto') return preference;
    // 端点级的探测结论是**按端点**的（`/responses` 存不存在是那个服务商的属性）：
    // 所以 light 指着另一个 baseUrl 时，它读的是**那个端点**的结论，不是 heavy 的。
    return this.registry.protocolFor(this.endpointFor(lane).baseUrl);
  }

  /**
   * 这一格是不是**配置强制档**（`auto` 之外的两档）。
   *
   * 强制档的判据要单独认，是因为它的两条语义都靠"**别去动 registry**"实现：
   *   · `'responses'` 永不切 ⇒ 失败时**不许**让 registry 记一条"切到 chat"的结论；
   *   · `'chat-completions'` 不先试 Responses ⇒ 也没有"退回原件"那条路。
   * 让强制档去 `noteFailure()`，会在 `model/protocol` 里留下一条从没发生过的切换
   * （"从没试过 Responses"被说成"切过"），而那正好是这份审计账要回答的问题。
   *
   * 环境变量开关不算强制档：它是 registry 自己的 `disabled` 分支（`noteFailure` 当场返回 null），
   * 记账口径已经由 registry 一条路统一，这里不重复判。
   */
  private laneForced(lane: ModelLane): boolean {
    if (this.registry.disabled) return false;
    return (lane === 'light' ? this.lightProtocol : this.heavyProtocol) !== 'auto';
  }

  /**
   * 这一次请求走哪个协议实现（`transportFor` = `protocolFor` 的**实现映射**）。
   *
   * 为什么写成**一个方法**、而不是在 `generate()` / `stream()` 里直接引用常量：
   * 协议选择只有这一处，两个调用点的**调用序一个字都不用动**——那是"零影响"能被证明的前提
   * （`test/protocol-bytes.test.ts` 的 4 条夹具 + `test/ds-client.test.ts` 的 22 条）。
   */
  private transportFor(lane: ModelLane): ModelTransport {
    // ★ **这是唯一改变线上行为的地方**（C-2）：没结论、关掉开关、`auto` 未命中时都返回
    // `responses` ⇒ 默认档位走不到 Chat（判据见 `test/protocol-fallback.test.ts` 的
    // "默认档位 chat 计数 = 0"）。C-3 起多认配置的强制档（见 {@link protocolFor}）。
    if (this.protocolFor(lane) === 'chat-completions') {
      return this.transportOverride.chat ?? chatCompletionsTransport;
    }
    return this.transportOverride.responses ?? responsesTransport();
  }

  /** 订阅"发生了一次协议切换"（C-3 会把它落成 `model/protocol` 事件）；退订幂等 */
  subscribeProtocol(listener: (decision: SwitchDecision) => void): () => void {
    return this.registry.subscribe(listener);
  }

  /**
   * 救急闸的**生效读数**（`IRMIA_DISABLE_CHAT_FALLBACK=1`）：`true` ⇒ 全 lane 恒 `responses`、
   * 探测计数恒 0（"关掉就完全回到今天"）。
   *
   * 为什么把它暴露出来：这个开关的接线只有一行（构造器里的 `disabled: options.disableChatFallback === true`），
   * 而**注入 registry 的测试覆盖不到那一行**——评审的变异 M0 删掉它之后 18/18 全绿，就是因为它
   * 唯一的行为痕迹被"注入一个 disabled registry"抹平了。有了这一格，"构造器有没有把开关接进去"
   * 才是可断言的判据（`test/protocol-fallback.test.ts` 的 M0 守卫）。
   */
  get chatFallbackDisabled(): boolean {
    return this.registry.disabled;
  }

  /**
   * 发一发（**含协议回退**）：失败且判据命中时，把**同一条请求**用另一套协议重发一次。
   *
   * 三条边界：
   *   · **上限 1**（R5）：重发之后无论成败都往外抛/往外交，绝不循环；
   *   · **不占重试预算**（§5.5）：它是"改路由"不是"重试同一条请求"，所以 `attempts`/`retryCount` 不受影响；
   *   · **硬前置**（§5.4）：`!res.ok` 那个切换点**一个 body 字节都还没解析**（`pump` 还没开始）⇒
   *     `evidence.delivered` 恒为 `false`。2xx 那个切换点（{@link resendOnNoOutput}）另有一道
   *     真判据：累积器一个字都没交付过（`hasDeliveredContent() === false`）。
   *
   * R2：Chat 那一发如果抛的是**非 `DsClientError`**（适配器自己的 bug）⇒ 把 chat 判死、
   * **把原始的 Responses 错误原样抛出去**——最坏结果 = "和今天一模一样的那条失败"。
   *
   * **强制档不回退**（`models.<lane>.protocol` = `responses` / `chat-completions`）：上面这整套
   * "先 404、再换 Chat 重发、再判死"都不发生——第一发失败就原样抛，registry 一个字节都不动
   * （理由见 {@link laneForced}）。
   *
   * **`unavailable` 短路**（§5.2，2026-10-21 修）：端点被判成"两条路都不通"之后，这里**一个请求
   * 都不发**，直接抛 `protocol_unavailable`。判据是 {@link assertProtocolAvailable}。
   */
  private async exchange(
    request: DsRequest,
    lane: ModelLane,
    model: string,
    stream: boolean,
    handle: RequestHandle,
  ): Promise<{ res: Response; transport: ModelTransport }> {
    this.assertProtocolAvailable(lane);
    const first = this.transportFor(lane);
    // 观测：**发之前**记下这一发用的协议——`failStep` 那条没有结果对象的路上只有这一个口
    // （口径与边界见 {@link lastProtocol}；回退后的第二发会把它覆盖成 chat）
    this.lastSentProtocol = first.protocol;
    const firstRes = await this.send(
      first.buildRequest(request, { model, user: this.user, stream }), first, handle, lane,
    );
    if (firstRes.ok) return { res: firstRes, transport: first };

    const originalError = await httpErrorOf(firstRes, first);
    // 强制档（`models.<lane>.protocol` = `responses` / `chat-completions`）：**不探测、不回退**。
    // 让 registry 记一笔结论会把"从没试过 Responses"写成"切过一次"，而且强制 `responses` 时
    // 一次 404 也不许把档位改成 chat（判据与优先级见 {@link laneForced} / {@link protocolFor}）。
    const next = this.noteFailureDecision(
      lane, model, first.protocol, this.evidenceOf(originalError, firstRes.status),
    );
    if (next === 'unavailable') throw this.protocolUnavailableError(lane);
    if (next !== 'chat') throw originalError;
    return await this.resendOnOther(request, lane, model, stream, handle, originalError);
  }

  /**
   * 端点这一刻**能不能发**（§5.2 的 `unavailable` 短路，2026-10-21 修）。
   *
   * 评审 T3 的现场：两个协议都 404 之后，第 3 次调用照旧发 `/responses`（`protocolFor` 对
   * `unavailable` 返回 `'responses'`），于是"两条路都不通"这个结论在**发送侧根本没有读者**。
   * 现在的判据只有这一处：`auto` 档 + registry 说 `unavailable` ⇒ 当场抛，不发请求。
   *
   * 两个**不查**的例外（刻意）：
   *   · 开关关掉（`disabled`）：那时 registry 连判据都不算，`unavailable` 不可能存在；
   *   · 配置强制档：人不让读探测结论（`laneForced`），强制 `chat-completions` 的人知道自己在干什么。
   */
  private assertProtocolAvailable(lane: ModelLane): void {
    if (this.registry.disabled) return;
    const preference = lane === 'light' ? this.lightProtocol : this.heavyProtocol;
    if (preference !== 'auto') return;
    if (this.registry.isUnavailable(this.endpointFor(lane).baseUrl)) throw this.protocolUnavailableError(lane);
  }

  /**
   * "两条路都不通"的错误（设计 §5.2：`kind:'invalid'` + `code:'protocol_unavailable'`）。
   *
   * `kind:'invalid'` ⇒ `retryable === false` ⇒ 不占重试预算、不会被退避重试（今天的 404 也是
   * `invalid`）⇒ "少打一次已知会失败的请求"，语义与今天等价。
   */
  private protocolUnavailableError(lane: ModelLane): DsClientError {
    const endpoint = this.endpointFor(lane);
    const seen = this.registry.unavailableOf(endpoint.baseUrl);
    const why = seen === null ? '' : `（判据 ${seen.criterion}，首次发现 ${seen.firstSeenAt}）`;
    return new DsClientError({
      kind: 'invalid',
      code: 'protocol_unavailable',
      message: `端点 ${endpoint.baseUrl}（lane ${lane}）两套协议都不通：`
        + `/responses 与 /chat/completions 都被判成"不支持"${why}`
        + '。本进程不再对它发请求（多半是 baseUrl 填错了）；'
        + `要恢复探测请改 models.${lane}.baseUrl 或重启，要强制某一套协议就设 models.${lane}.protocol`,
    });
  }

  /**
   * 把一份失败证据交给 registry，并折成**下一步**（三个结论）：
   *
   *   · `'chat'`        —— 从 responses 切到 chat ⇒ 调用方**用另一套协议重发一次**（R5 上限 1）；
   *   · `'unavailable'` —— chat 那一发也命中了判据 ⇒ 两条路都不通，抛 `protocol_unavailable`；
   *   · `null`          —— 不换（反判据 / 已有结论 / 强制档 / 开关关掉）。
   *
   * 它把"问 registry"与"按结论分流"合成一处：三条失败路径（`!res.ok`、2xx 没产出、
   * 重发那一发也失败）都只说"我这份证据"，不各自解释一遍状态机。
   */
  private noteFailureDecision(
    lane: ModelLane,
    model: string,
    protocol: ModelProtocol,
    evidence: FailureEvidence,
  ): 'chat' | 'unavailable' | null {
    if (this.laneForced(lane)) return null;
    const decision = this.registry.noteFailure({
      baseUrl: this.endpointFor(lane).baseUrl, lane, model, protocol, evidence,
    });
    if (decision === null) return null;
    if (decision.to === 'unavailable') return 'unavailable';
    return decision.to === 'chat-completions' && protocol === 'responses' ? 'chat' : null;
  }

  /** 失败现场（`bodyText` 缺省取 `error.detail`——`bad_shape` / `bad_status` 那两条自己不带 detail） */
  private evidenceOf(error: DsClientError, status: number | null, bodyText?: string | null): FailureEvidence {
    const detail = bodyText === undefined ? error.detail : bodyText;
    return {
      status,
      bodyText: detail === null ? null : detail.slice(0, ERROR_DETAIL_LIMIT),
      code: error.code,
      kind: error.kind,
      delivered: false,
    };
  }

  /**
   * 判据命中之后的那一发：**换到另一套协议重发一次**（§5.1 的"同一次调用内换协议"）。
   *
   * 两件事只在这里发生：
   *   · chat 那一发**也失败** ⇒ 先把它自己的证据交给 registry（这就是 `unavailable` 的入口，
   *     2026-10-21 之前这里直接 `throw chatError`，于是 `unavailable` 永远落不下去）；
   *   · chat 适配器抛**非 `DsClientError`** ⇒ R2：判死 + 退回**原始 Responses 错误**。
   */
  private async resendOnOther(
    request: DsRequest,
    lane: ModelLane,
    model: string,
    stream: boolean,
    handle: RequestHandle,
    originalError: DsClientError,
  ): Promise<{ res: Response; transport: ModelTransport }> {
    const second = this.transportFor(lane);
    try {
      this.lastSentProtocol = second.protocol;
      const retriedRes = await this.send(
        second.buildRequest(request, { model, user: this.user, stream }), second, handle, lane,
      );
      if (!retriedRes.ok) {
        const chatError = await httpErrorOf(retriedRes, second);
        const next = this.noteFailureDecision(
          lane, model, second.protocol, this.evidenceOf(chatError, retriedRes.status),
        );
        if (next === 'unavailable') throw this.protocolUnavailableError(lane);
        throw chatError;
      }
      return { res: retriedRes, transport: second };
    } catch (fault) {
      if (!(fault instanceof DsClientError)) {
        // R2：适配器炸了 ⇒ 判死 + **退回原件**
        this.registry.noteAdapterFault(
          this.endpointFor(lane).baseUrl, lane, model, fault instanceof Error ? fault.message : String(fault),
        );
        throw originalError;
      }
      throw fault;
    }
  }

  /**
   * **2xx 但一个产出都没有** ⇒ 也要把证据交给 registry（P2/P3 的**生产入口**，评审 blocker ①）。
   *
   * 为什么必须在这里补：`httpErrorOf` 只在 `!res.ok` 时被调，而"200 + HTML / 200 + `{"detail":
   * "Not Found"}` / 200 + `{}`"这三种形状的失败是在**解析阶段**才暴露的（非流式抛
   * `bad_json`/`bad_status`，流式连一个 SSE 帧都收不到 ⇒ `stream_interrupted`）。不补这一处，
   * 两个判据在真实链路上就是不可达的，heavy 每一拍都被记成"断流"并重投。
   *
   * 返回 `null` = 不切（调用方把原始失败交出去）；返回一对 = 换协议重发后的响应。
   * `delivered` 恒 `false`：调用方只在"一个字都没交付"时才会问（流式那一路另有
   * `hasDeliveredContent()` 作硬前置，见 {@link stream}）。
   */
  private async resendOnNoOutput(
    request: DsRequest,
    lane: ModelLane,
    model: string,
    stream: boolean,
    handle: RequestHandle,
    first: { transport: ModelTransport; status: number },
    firstError: DsClientError,
    firstBody: string | null,
  ): Promise<{ res: Response; transport: ModelTransport } | null> {
    const next = this.noteFailureDecision(
      lane, model, first.transport.protocol, this.evidenceOf(firstError, first.status, firstBody),
    );
    if (next === 'unavailable') throw this.protocolUnavailableError(lane);
    if (next !== 'chat') return null;
    return await this.resendOnOther(request, lane, model, stream, handle, firstError);
  }

  /**
   * 适配器故障 → 这条请求该抛出去的错误（用户 R2 的那个"退回原件"的**唯一落点**）。
   *
   * **B 阶段 = 原样返回**。理由：R2 的完整句子是"适配器抛任何异常 ⇒ 只能让这次请求退回
   * **Responses 那条路的原始错误**"，而"退回原件"的前提是**手里有一份原件**——
   * 那需要先有一次 Responses 的失败（C 阶段的协议回退才有）。B 阶段 `transportFor()` 恒返回
   * responses，`ChatAdapterFault` 只可能来自注入的假传输，没有"原件"可退。
   *
   * **C 阶段这一处要变成**：接住 `ChatAdapterFault` ⇒ 把 chat 判死（`quarantined`，本进程不再试）
   * ⇒ 抛出**那一次 Responses 的原始 `DsClientError`**（`kind`/`code`/`status`/`detail`/`retryable`
   * 一个都不改）。所以它现在就必须是一个**独立的、被调用到的**方法，而不是一句写在注释里的承诺
   * ——C 阶段改这一个方法体，`generate()` / `stream()` 两条路的处置同时生效。
   */
  private adapterFailureOf(error: unknown): unknown {
    return error;
  }

  /**
   * 最近一次**实际发出去**的请求用的是哪套协议（`null` = 本进程还没发过任何请求）。
   *
   * 为什么需要它：`budget/consumed.protocol` 的写入点里，`runtime/agent-loop.ts` 的 `failStep`
   * 是唯一拿不到结果对象的那个（调用**抛了**，`DsStreamResult` 根本不存在），而"这一拍是哪套
   * 协议失败的"恰恰是排障时最要紧的一格——切到 Chat 之后第一次失败，与还在 Responses 上失败，
   * 是两件完全不同的事。⇒ 客户端自己记一份，失败路径**只读地问一次**，绝不按配置猜。
   *
   * 口径：在 `exchange()` 里**每一发 `send()` 之前**更新 ⇒ 抛错时它指向**这一发**（含回退后
   * 的 Chat 那一发）。不默认成 `'responses'`：没发过就是 `null`，读的一侧据此**不写这一格**
   * （缺省 = 不知道，见 `log/types.ts` 的 `protocol` 注释）。
   *
   * ⚠ 边界（写清，别读成"这一次调用"的保证）：它只回答"**最近**一次实际协议"。若某次失败发生在
   * **一发都没出去**之前（信号已中断、`buildRequest` 自己抛了），它可能仍是上一发留下的值。
   * 那种拍在账上是 `inputTokens/outputTokens === 0` 且没有对端错误码，与"真发出去又失败"可以
   * 区分；两条路都只影响这一格**观测**，不影响任何行为（切换判据在 `registry`，不读它）。
   */
  get lastProtocol(): ModelProtocol | null {
    return this.lastSentProtocol;
  }

  get failStreak(): number {
    return this.streak;
  }

  resetFailStreak(): void {
    this.streak = 0;
  }

  /**
   * 非流式生成：带错误分类与指数退避。刻意不重试的两类——invalid（重试必然同样失败）
   * 与 aborted（调用方要求停）；empty 收紧到 3 次后外抛，由调用方走降级链。
   */
  async generate(request: DsRequest): Promise<DsResponse> {
    const lane = request.lane;
    const model = request.model ?? this.modelFor(lane);
    const startedAt = this.now();
    const retry = this.retryOptions(lane, request.signal);

    try {
      const core = await withRetry(async () => {
        const handle = this.createHandle('total', request.signal);
        try {
          return await this.generateOnce(request, lane, model, handle);
        } finally {
          handle.dispose();
        }
      }, retry);
      this.streak = 0;
      return { ...core, durationMs: this.now() - startedAt };
    } catch (error) {
      throw this.trackFailure(this.adapterFailureOf(error));
    }
  }

  /**
   * 非流式的**一发**（含两道回退闸）：`!res.ok` 那道在 `exchange()` 里，**2xx 但没产出**那道在
   * 这里——解析失败之后再问一次 registry（裁决与重发都在 {@link resendOnNoOutput}）。
   *
   * 为什么"解析"要包在 try 里再发一次：`parseResponse` 是协议实现，它对"200 但不是我要的形状"
   * 抛的是 `DsClientError`（`bad_json` / `bad_shape` / `bad_status` / `empty_output`）。其中
   * **前三个**正是"对端根本不是 Responses 端点"的证据，`empty_output` 不是（那是"支持 Responses
   * 但这一拍没内容"，属于反判据，registry 自己会用 `DENIED_KINDS` 挡掉）。这一层不判断是谁，
   * 只把**现场**（状态码 + 正文 + code/kind）递过去——判据的唯一实现留在 registry。
   */
  private async generateOnce(
    request: DsRequest,
    lane: ModelLane,
    model: string,
    handle: RequestHandle,
  ): Promise<Omit<DsResponse, 'durationMs'> & { protocol: ModelProtocol }> {
    // 请求体由协议实现造（**键序即字节**），回退也在 `exchange()` 里（上限 1）
    const exchange = await this.exchange(request, lane, model, false, handle);
    // 非流式拿到响应头就已经是"有数据"了（body 还没读完，但连接是活的）：
    // 重置一次静默计时器，让"响应头快、正文慢"这类请求走总时限那条判据而不是静默那条
    handle.noteData();
    const text = await this.readBody(exchange.res, handle);
    // 协议随结果回去（`budget/consumed.protocol` 的唯一来源；`exchange()` 保证了它恒有值）
    try {
      return { ...exchange.transport.parseResponse(text, model), protocol: exchange.transport.protocol };
    } catch (error) {
      if (!(error instanceof DsClientError)) throw error;
      const second = await this.resendOnNoOutput(
        request, lane, model, false, handle,
        { transport: exchange.transport, status: exchange.res.status }, error, text,
      );
      if (second === null) throw error;
      handle.noteData();
      const secondText = await this.readBody(second.res, handle);
      try {
        return { ...second.transport.parseResponse(secondText, model), protocol: second.transport.protocol };
      } catch (secondError) {
        if (!(secondError instanceof DsClientError)) throw secondError;
        // **第二发也是同一形状** ⇒ chat 侧的证据同样要进 registry（否则 "两条路都不通" 只能靠
        // 下一次调用再撞一次 HTTP 才判得出来）。命中 unavailable 就改成抛它。
        const next = this.noteFailureDecision(
          lane, model, second.transport.protocol, this.evidenceOf(secondError, second.res.status, secondText),
        );
        if (next === 'unavailable') throw this.protocolUnavailableError(lane);
        throw secondError;
      }
    }
  }

  /**
   * SSE 流式。已推送的内容不可重放，因此这里不做整条流的重试（重试决策属于调用方）：
   * 收到过内容后发生中断/超时/网络断，返回已收部分（`interrupted: true`）；
   * 一个字都没收到就失败，则当作可重试错误抛出，与 generate 的错误语义一致。
   *
   * **超时语义是"静默"不是"总耗时"**（2026-10-16 改，理由见 {@link DEFAULT_STREAM_SILENCE_MS}）：
   * 每收到一片数据就重置静默计时器，另有一条很宽的硬顶兜"一直在吐字但永不结束"。
   */
  async stream(request: DsRequest, callbacks: DsStreamCallbacks = {}): Promise<DsStreamResult> {
    const lane = request.lane;
    const model = request.model ?? this.modelFor(lane);
    const startedAt = this.now();
    const handle = this.createHandle('silent', request.signal);

    try {
      /**
       * ⚠ **协议实现的调用一律在 `try` 里**（2026-10-21 修，评审 P1）。
       *
       * 原样：`parseStream(...)` 写在 `try` **之前**。今天没事（Responses 的 `parseStream`
       * 只建一个 Map、不抛），但 **Chat 的 `parseStream` 按设计会抛**（B 阶段是
       * `ChatAdapterFault`，C 阶段是它自己实现里的形状假设），而它在 `try` 外 ⇒
       * `finally` 里的 `handle.dispose()` 不执行 ⇒ **静默计时器（`silenceMs`，默认 120s）与
       * 硬顶（`hardCapMs`，默认 3h）两只闸都漏掉**；漏掉的那只 3h 定时器还会把进程多按住三小时。
       *
       * 判据：`test/model-transport.test.ts` 的"注入会抛的假传输"用例——
       * ① 定时器数回到基线 ② 错误原样抛出 ③ 没有 unhandledRejection。
       */
      // 回退有两道：`!res.ok`（在 `exchange()` 里，一个 body 字节都还没解析）与
      // **2xx 但一个字都没收到**（在下面 `pump` 之后）。后者同样满足 §5.4 的硬前置——
      // 判据是累积器自己的 `hasDeliveredContent()`（"有没有可留存的内容"），不是"回调调没调过"。
      const exchange = await this.exchange(request, lane, model, true, handle);
      // ⚠ 累积器必须按**实际用的那个协议**造（2026-10-21 修，C-2 的漏网）：原来在 `exchange()`
      // 之前就按"第一发"的协议造好了，于是换到 Chat 之后解析器仍是 Responses 那一套 ——
      // 帧名对不上 ⇒ 一个字都收不到 ⇒ 一次本该成功的调用被记成空回包。
      const accumulator = exchange.transport.parseStream({
        fallbackModel: model,
        callbacks,
        startedAt,
        now: this.now,
      });
      // **响应头到达 = 收到数据**：它是"连接活着、服务端已接手"的第一个证据。
      // 少这一下，一个"记得住响应头、之后才慢慢想"的服务端会被静默闸在 120s 处掐掉——
      // 而那恰恰是用户说的"超长思考"最典型的形状。
      handle.noteData();
      if (exchange.res.body === null) {
        throw new DsClientError({ kind: 'server', code: 'no_body', message: '流式响应缺少 body' });
      }
      this.streak = 0;
      const streamed = await this.pump(exchange.res.body, accumulator, handle);
      /**
       * **2xx 但连一个 SSE 帧都没收到** ⇒ 它多半根本不是 SSE（HTML 兜底页 / JSON 错误体 / `{}`）。
       *
       * 判据三条一起（少一条都会误伤正常流）：
       *   ① `interrupted`（没收到终态事件——收到 `response.failed` 那是上游的终态失败，属于反判据）；
       *   ② `failure !== null`；
       *   ③ `hasDeliveredContent() === false`（§5.4 的硬前置：一个字都没交付过才允许换协议）。
       * 命中之后由 `resendOnNoOutput` 问判据并重发；**证据里的正文是 `pump` 顺手攒的原始片段**
       * ——没有它，P2 认不出 HTML、P3 也解析不出形状。
       */
      if (streamed.result.interrupted && streamed.result.failure !== null && !accumulator.hasDeliveredContent()) {
        const failure = streamed.result.failure;
        const firstError = new DsClientError({
          kind: 'server',
          code: failure.code,
          message: failure.message,
        });
        const second = await this.resendOnNoOutput(
          request, lane, model, true, handle,
          { transport: exchange.transport, status: exchange.res.status }, firstError, streamed.rawSnippet,
        );
        if (second !== null) {
          return await this.pumpSwitched(lane, model, second, callbacks, startedAt, handle);
        }
      }
      return { ...streamed.result, protocol: exchange.transport.protocol };
    } catch (error) {
      throw this.trackFailure(this.adapterFailureOf(error));
    } finally {
      handle.dispose();
    }
  }

  /**
   * 换协议重发之后的**那一发流**：造累积器（按新协议）→ 读流 → 结算。
   *
   * 与第一发同一套两步：`pump` 的返回要么是终态结果、要么（一个字都没收到时）交给 registry
   * 再判一次——第二发也"2xx 没产出"就说明两条路都不通，落 `unavailable`（并抛
   * `protocol_unavailable`）。不落这一步的话，`unavailable` 要等**下一次调用**再撞一次 HTTP
   * 才判得出来，而那一次已经花掉了钱。
   */
  private async pumpSwitched(
    lane: ModelLane,
    model: string,
    exchange: { res: Response; transport: ModelTransport },
    callbacks: DsStreamCallbacks,
    startedAt: number,
    handle: RequestHandle,
  ): Promise<DsStreamResult> {
    const accumulator = exchange.transport.parseStream({
      fallbackModel: model,
      callbacks,
      startedAt,
      now: this.now,
    });
    handle.noteData();
    if (exchange.res.body === null) {
      throw new DsClientError({ kind: 'server', code: 'no_body', message: '流式响应缺少 body' });
    }
    const pumped = await this.pump(exchange.res.body, accumulator, handle);
    if (pumped.result.interrupted && pumped.result.failure !== null && !accumulator.hasDeliveredContent()) {
      const failure = pumped.result.failure;
      const next = this.noteFailureDecision(
        lane, model, exchange.transport.protocol,
        this.evidenceOf(
          new DsClientError({ kind: 'server', code: failure.code, message: failure.message }),
          exchange.res.status,
          pumped.rawSnippet,
        ),
      );
      if (next === 'unavailable') throw this.protocolUnavailableError(lane);
    }
    return { ...pumped.result, protocol: exchange.transport.protocol };
  }

  /**
   * 读流：字节 → 文本 → SSE 帧 → 状态机。中断在帧循环内结算，不外抛（除非一个字都没收到）。
   *
   * 另外**顺手攒一份原始正文片段**（前 `ERROR_DETAIL_LIMIT` 个字符）：它的唯一用途是给
   * "2xx 但根本没在发 SSE"那种形状留证据（HTML / JSON / `{}` 都在这一小段里定得了性）。
   * 不攒它，流式那条路对"对端回了一张网页"就只剩一句 `stream_interrupted`——
   * 而那句话说不清"到底是断流，还是这个端点压根不是 SSE"。
   */
  private async pump(
    body: ReadableStream<Uint8Array>,
    accumulator: StreamAccumulator,
    handle: RequestHandle,
  ): Promise<{ result: DsStreamResult; rawSnippet: string }> {
    const decoder = new TextDecoder('utf-8');
    const sse = new SseFrameDecoder();
    const reader = body.getReader();
    let rawSnippet = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) {
          // **收到一片就重置静默计时器**（这是本函数存在的全部要点）：静默判据问的是
          // "多久没有数据"，不是"一共花了多久"——长思考期间服务端一直在吐 reasoning 分片，
          // 所以它永远不该撞上这只闸。
          handle.noteData();
          const text = decoder.decode(value, { stream: true });
          if (rawSnippet.length < ERROR_DETAIL_LIMIT) {
            rawSnippet = (rawSnippet + text).slice(0, ERROR_DETAIL_LIMIT);
          }
          for (const frame of sse.push(text)) accumulator.apply(frame);
        }
      }
      for (const frame of sse.push(decoder.decode())) accumulator.apply(frame);
      for (const frame of sse.flush()) accumulator.apply(frame);
      return { result: accumulator.finish(), rawSnippet };
    } catch (error) {
      const classified = classifyTransportError(error, {
        timedOut: handle.timedOut(),
        externalAborted: handle.externalAborted(),
        hardCap: handle.hardCapped(),
        silenceMs: this.silenceMs,
        hardCapMs: this.hardCapMs,
      });
      // `settleTransportFailure` 可能**抛**（一个字都没收到）：那是"该不该重试"的判据，
      // 与"该不该换协议"无关——抛出去之后由 `stream()` 的 catch 交给调用方。
      return { result: accumulator.settleTransportFailure(classified), rawSnippet };
    }
  }

  private retryOptions(lane: ModelLane, signal?: AbortSignal): RetryOptions {
    const options: RetryOptions = {
      maxAttempts: this.maxAttempts,
      lane,
      baseDelayMs: this.baseDelayMs,
      maxDelayMs: this.maxDelayMs,
      maxRetryAfterMs: this.maxRetryAfterMs,
      sleep: this.sleep,
      shouldRetry: (error: unknown, attempt: number) => shouldRetryAttempt(error, attempt),
    };
    if (signal !== undefined) options.signal = signal;
    // 无条件挂上多播口：没有订阅者时它是一次空转，比"记得在有订阅者时才接线"可靠
    options.onRetry = (info) => { this.notifyRetry(info); };
    return options;
  }

  /**
   * 请求句柄：超时与调用方中断共用一条 `AbortController`，但保留**来源标志**以便分类。
   *
   * 两种模式（2026-10-16 拆开，这是长思考事故的机制层修复）：
   *   · `'total'` —— **总时限**：从建表到 `dispose` 只有这一只闸。用于非流式 `generate()`
   *     （一问一答、没有增量可救，超了就该退避重试）。
   *   · `'silent'` —— **静默时限 + 硬顶**：只要 `noteData()` 被叫到（每收到一片数据/响应头），
   *     静默计时器就重新起跳；硬顶不重置。用于流式 `stream()`。
   *
   * 为什么两种模式必须分开而不是"把 180s 调大"：调大只是把墙往后推，
   * 一条活跃输出了 40 分钟的流照样会在第 N 分钟被同一只闸掐掉，而它本来能正常收尾。
   */
  private createHandle(mode: 'total' | 'silent', external?: AbortSignal): RequestHandle {
    const controller = new AbortController();
    let timedOut = false;
    let hardCap = false;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let capTimer: ReturnType<typeof setTimeout> | null = null;

    const abortSilent = (): void => {
      timedOut = true;
      controller.abort(new DsSilenceTimeout());
    };
    const abortHardCap = (): void => {
      timedOut = true;
      hardCap = true;
      controller.abort(new DsHardCapTimeout());
    };

    if (mode === 'total') {
      // 非流式：老口径不变（一个总时限），只是现在可配、也可热更
      silenceTimer = setTimeout(abortSilent, this.timeoutMs);
    } else {
      // 流式：静默闸先起跳（等响应头也在它的覆盖下）+ 硬顶
      silenceTimer = setTimeout(abortSilent, this.silenceMs);
      capTimer = setTimeout(abortHardCap, this.hardCapMs);
    }

    const onExternalAbort = (): void => controller.abort(new Error('调用方中断'));
    if (external !== undefined) {
      if (external.aborted) onExternalAbort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }
    return {
      signal: controller.signal,
      timedOut: () => timedOut,
      hardCapped: () => hardCap,
      externalAborted: () => external?.aborted === true,
      noteData: () => {
        if (mode !== 'silent' || timedOut) return;
        // 重置（不是"停止"）：静默判据是滑动窗口——只要还在吐字，它就一直被推到下一次数据之后
        if (silenceTimer !== null) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(abortSilent, this.silenceMs);
      },
      dispose: () => {
        if (silenceTimer !== null) clearTimeout(silenceTimer);
        if (capTimer !== null) clearTimeout(capTimer);
        silenceTimer = null;
        capTimer = null;
        external?.removeEventListener('abort', onExternalAbort);
      },
    };
  }

  /**
   * 发一条已经由协议实现造好的请求。
   *
   * **这里只剩"协议无关"的三件事**：lane 的端点/密钥取值（`endpointFor`）、`baseUrl` 收尾
   * （`built.url` 是相对路径）与**传输层失败的分类**（`classifyTransportError`：静默/硬顶/
   * 调用方中断/连接重置/DNS，全部与协议无关）。
   * `fetch` 本身与三个头在协议实现里（`transport.send`）——所以"两套协议三套超时"这种账不可能出现。
   *
   * 为什么 `{ ...built, url }` 要新建一个对象而不是就地改：`built` 是纯函数的产物，
   * 就地改会让"同一份请求重发两次"在调试时看到两个不同的对象（C 阶段的协议回退正是重发）。
   *
   * **两个 lane 各发各的端点是这里兑现的**（2026-10-21）：URL 前缀与 `Authorization` 都来自
   * `endpointFor(lane)`。`built` 里一个端点字节都没有（协议实现只造路径与正文），所以
   * "light 打到 heavy 的端点"这种错不可能再发生在别处。
   */
  private async send(
    built: TransportRequest,
    transport: ModelTransport,
    handle: RequestHandle,
    lane: ModelLane,
  ): Promise<Response> {
    const endpoint = this.endpointFor(lane);
    if (endpoint.apiKey === null) {
      // 这一格没有可用密钥 ⇒ **不发请求**（尤其不能拿另一格的密钥顶上：两格指不同端点时
      // 那是把 A 家的密钥发给 B 家）。`kind:'invalid'` ⇒ 不重试，错误里点名该设哪个环境变量。
      throw new DsClientError({
        kind: 'invalid',
        code: 'missing_api_key',
        message: `lane ${lane} 没有可用的 API key（端点 ${endpoint.baseUrl}）：`
          + `设环境变量 models.${lane}.apiKeyEnv 或在设置页给这一格填密钥——`
          + '它与 heavy 指向不同端点，不会借用 heavy 的密钥',
      });
    }
    try {
      return await transport.send(
        { apiKey: endpoint.apiKey, fetchImpl: this.fetchImpl, signal: handle.signal },
        { ...built, url: `${endpoint.baseUrl}${built.url}` },
      );
    } catch (error) {
      // fetch 只在传输层失败时抛：DNS/连接/中断都从这里出去并分类
      throw classifyTransportError(error, {
        timedOut: handle.timedOut(),
        externalAborted: handle.externalAborted(),
        hardCap: handle.hardCapped(),
        silenceMs: this.silenceMs,
        hardCapMs: this.hardCapMs,
      });
    }
  }

  private async readBody(res: Response, handle: RequestHandle): Promise<string> {
    try {
      return await res.text();
    } catch (error) {
      throw classifyTransportError(error, {
        timedOut: handle.timedOut(),
        externalAborted: handle.externalAborted(),
        hardCap: handle.hardCapped(),
        silenceMs: this.silenceMs,
        hardCapMs: this.hardCapMs,
      });
    }
  }

  /** 连续失败计数外抛：只统计模型侧失败，中断不算失败 */
  private trackFailure(error: unknown): unknown {
    if (error instanceof DsClientError && error.kind !== 'aborted') {
      this.streak += 1;
      return error.withContext({ consecutiveFailures: this.streak });
    }
    return error;
  }
}

/** URL 收尾统一口径：项目里 baseUrl 不含 /responses 后缀，也不留尾斜杠 */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/u, '');
}

/** 超时型失败内层最多重试一次（理由见 {@link shouldRetryAttempt}） */
export const TIMEOUT_MAX_ATTEMPTS = 2;

/**
 * 内层重试判据（只作用于 `generate()`——`stream()` 不做内层重试，见它的注释）。
 *
 *   · `empty`   —— 有限重试 3 次后外抛（§4.14 表，原口径不变）；
 *   · `timeout` —— **最多一次带退避的重试**（2026-10-16 加，这是"又 error 又重投"的一半机制）：
 *       内层原来对 timeout 一视同仁地重试满 `maxAttempts`（默认 5），而每一次都要
 *       把同一个总时限**再等一遍** ⇒ 单次调用最坏 5×180s=15 分钟，然后外层再走 turn 级重投。
 *       现在语义是"给你一次机会、退避之后再问一次；还是超时就是这条请求真过不去"，
 *       第二次失败外抛的原因里带着是哪只闸（`timeout_silent` / `timeout_hard_cap`）。
 *   · 其余可重试类别照旧按 §4.14 表退避。
 *
 * ⚠ 它**不能**收紧到"一次都不重试"：偶发网络抖动造成的 `timeout_silent` 是**该**重试的
 * （那条连接确实断了，重发一条通常会好），一次都不重试会把偶发故障变成硬失败。
 */
function shouldRetryAttempt(error: unknown, attempt: number): boolean {
  if (!(error instanceof DsClientError)) return false;
  if (!error.retryable) return false;
  if (error.kind === 'empty') return attempt < EMPTY_MAX_ATTEMPTS;
  if (error.kind === 'timeout') return attempt < TIMEOUT_MAX_ATTEMPTS;
  return true;
}

/**
 * HTTP 失败 → `DsClientError`（**协议可插拔**，用户 2026-10-21 拍的口径）。
 *
 * 顺序只有两步：先把错误正文截断、把 OpenAI 形状的信封解析出来；再问**当前协议**要不要自己分类。
 *   · 协议实现了 `classifyError`（今天的 Responses 与 Chat 都实现了）⇒ 用它的；
 *   · 没实现 ⇒ **回退**到这份共用的 `classifyHttpStatus`（§4.14 那张表）。
 *
 * 为什么信封在这里解析、而不是各协议自己解析：信封是 OpenAI 系共有形状，解析一次就够；
 * 协议那边只需要决定"要不要用它、怎么用"（`transport/types.ts` 的 `TransportErrorInput`）。
 */
async function httpErrorOf(res: Response, transport: ModelTransport): Promise<DsClientError> {
  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
  let bodyText: string | null = null;
  try {
    const text = await res.text();
    bodyText = text === '' ? null : text.slice(0, ERROR_DETAIL_LIMIT);
  } catch {
    bodyText = null;
  }
  const input = { status: res.status, retryAfterMs, bodyText, envelope: envelopeOfBody(bodyText) };
  return transport.classifyError?.(input) ?? classifyHttpStatus(res.status, { retryAfterMs, detail: bodyText });
}

/** `{"error":{"message","type","param","code"}}` → 四个字符串；不是这形状就是 `null` */
function envelopeOfBody(bodyText: string | null): { message: string; code: string; type: string; param: string } | null {
  if (bodyText === null || bodyText === '') return null;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const error = (parsed as { error?: unknown }).error;
    if (typeof error !== 'object' || error === null || Array.isArray(error)) return null;
    const read = (key: string): string => {
      const value = (error as Record<string, unknown>)[key];
      return typeof value === 'string' ? value : '';
    };
    return { message: read('message'), code: read('code'), type: read('type'), param: read('param') };
  } catch {
    return null;
  }
}
