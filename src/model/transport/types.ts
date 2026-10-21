/**
 * **发送层的协议契约**（`ModelTransport`）：一个协议实现要能回答的五件事。
 *
 * 为什么要这一层（`docs/design-protocol-fallback.md` §8）：
 * `auto` 档位要在"对方不支持 Responses"时把**同一次调用**换成 Chat Completions 重发。
 * 换协议只该换**形状**（URL / 请求体 / 流式事件 / usage 位置），**不该换**调度、超时、
 * 重试、错误分类、记账——那些留在 `DsClient` 里。这条线一旦画歪，就会出现"两套协议两套超时"
 * 这种永远对不上的账。
 *
 * ## 方法清单（B 阶段 = 5 个；另两个按设计在 C 阶段随探测一起加）
 *
 * | 方法 | 干什么 | 归属 |
 * |---|---|---|
 * | `buildRequest()` | 请求形状（**键序即线上字节**） | 协议 |
 * | `send()` | 只做 fetch + 三个头（**不带**超时/重试/错误分类） | 协议 |
 * | `parseStream()` | 流式增量状态机（边收边推，见 {@link StreamAccumulator}） | 协议 |
 * | `parseResponse()` | 非流式整包解析（`generate()` 那条路） | 协议 |
 * | `readUsage()` | usage 读数（**逐字段**：缺项缺席，不许补 0） | 协议 |
 * | `classifyError()` | HTTP 状态 + 错误体 → `DsClientError` | **共用**（`classifyHttpStatus`，留在 ds-client） |
 * | `isProtocolUnsupported()` | 探测判据（这份证据是否说明"本协议不被支持"） | 协议，**C 阶段加** |
 *
 * 后两个为什么不在 B 阶段落：`classifyError` 在 B 阶段**没有任何调用方**（`httpErrorOf` 仍走原路），
 * `isProtocolUnsupported` 的判据是随探测一起写的。B 阶段的原则是**不留一段没人调用、没人测的逻辑**
 * ——空实现进主干比"多一个方法"更贵。（`ChatAdapterFault` 那种"注定要抛"的空实现是例外：
 * 它存在的意义就是**不许被走到**，见 `chat-completions.ts`。）
 */

import type {
  DsClientError,
  DsRequest,
  DsResponse,
  DsStreamCallbacks,
  DsStreamResult,
  DsUsage,
} from '../ds-client.js';
import type { SseFrame } from './sse.js';

/** 两套协议的身份（进 `budget/consumed.protocol` 与 `model/protocol` 事件的就是这两个字符串） */
export type ModelProtocol = 'responses' | 'chat-completions';

/**
 * `models.<lane>.protocol` 的取值域（配置文件 / GUI / `DsClientOptions` 共用这一份）。
 *
 *   · `'auto'`（缺省）= **今天的行为**：先按 Responses 发，探测到对方不支持才切 Chat；
 *   · `'responses'` = 强制 Responses，**永不切**（连探测都不做）；
 *   · `'chat-completions'` = 强制 Chat，**不先试 Responses**（也不探测）。
 *
 * 三档的优先级与"谁压过谁"写在 `DsClient.protocolFor`（设计 §8.8.3）：
 * 环境变量 `IRMIA_DISABLE_CHAT_FALLBACK=1` > 这一格 > 进程内探测结论 > `responses`。
 */
export type ModelProtocolPreference = 'auto' | ModelProtocol;

/** 造一份请求时需要的、**与协议无关**的那几格（由 `DsClient` 从配置与 lane 里取） */
export interface TransportBuildContext {
  /** 这一次请求用的模型 id（`request.model ?? modelFor(lane)` 已经算好了） */
  model: string;
  /** 部署标识：Responses 发 `user`，Chat 侧按它的口径（见设计 §3.7 第 18 条） */
  user: string;
  stream: boolean;
}

/** 发一份请求需要的运行期依赖（**由 `DsClient` 传进来**，transport 自己不持有任何东西） */
export interface TransportSendContext {
  apiKey: string;
  fetchImpl: typeof fetch;
  /** 超时/中断的那条信号：由 `DsClient` 的 `RequestHandle` 提供（协议无关） */
  signal: AbortSignal;
}

/** 造好的请求：`url` 是相对 `baseUrl` 的路径（baseUrl 的收尾口径在 `DsClient` 里） */
export interface TransportRequest {
  url: string;
  /**
   * **已经是结构、不是字符串**：`JSON.stringify` 由 `send()` 做。
   *
   * 为什么不在这一层就序列化：`JSON.stringify(body)` 在两个协议里必须各自只发生一次，
   * 而对象字面量的**键序就是字节**（Responses 那七个键的追加顺序是线上契约）。
   */
  body: Record<string, unknown>;
  stream: boolean;
}

/** `parseStream()` 的入参：全是 `DsClient` 那边的运行期事实 */
export interface ParseStreamContext {
  /** 没拿到 `model` 时的兜底（`DsStreamResult.model` 用它） */
  fallbackModel: string;
  /** 增量回调的口（准实时推送，正文不落这里） */
  callbacks: DsStreamCallbacks;
  /** 本次调用起跳时刻（`durationMs` 用） */
  startedAt: number;
  /** 时钟注入（测试要确定性） */
  now: () => number;
}

/**
 * 流式事件状态机（**逐字搬自** `ds-client.ts:928-933` 的接口声明；第四项是 v2 补的，见下）。
 *
 * 为什么必须是"增量"而不是"一次性解析"：静默计时器靠**每收到一片就重置**（长思考期间服务端
 * 一直在吐分片），一次性解析等于把连接挂死在"等收完"上——那正是 2026-10-16 那批 180s 事故的形状。
 */
export interface StreamAccumulator {
  apply(frame: SseFrame): void;
  finish(): DsStreamResult;
  /** 传输中断/超时：已有内容就交付已收部分，否则把错误抛出去交给重试层 */
  settleTransportFailure(error: DsClientError): DsStreamResult;
  /**
   * **协议回退的硬前置**（设计 §5.4；评审 P2 要求它必须在 B 阶段就位）：这一发有没有已经把内容
   * 交付给调用方。
   *
   * 换协议 = 把同一条请求重发一遍，而已推送的增量**不可重放**：吐过字再换协议，调用方会看到
   * 同一段话被推两遍，`message/assistant` 也会写出重复正文。
   * ⇒ 只要它返回 `true`，**一律不许换协议**（宁可让这次调用按今天的失败路径收尾）。
   *
   * 判据是"累积器里有没有可留存的内容"（正文 / 函数调用 / 思维链），**不是**"回调有没有被调过"：
   * `onFunctionCallDelta` 在空 `argumentsDelta` 上也会被调用（见 `responses.ts` 的
   * `response.function_call_arguments.delta` 分支），拿回调当判据会把"只收到一个空的入参分片"
   * 误读成"已经吐过字"，于是**该切的时候不敢切**。
   */
  hasDeliveredContent(): boolean;
}

/** 一个协议的实现。`readonly protocol` 是身份，其余是那五件事（+ 可选的错误分类）。 */
export interface ModelTransport {
  readonly protocol: ModelProtocol;
  buildRequest(request: DsRequest, ctx: TransportBuildContext): TransportRequest;
  send(ctx: TransportSendContext, req: TransportRequest): Promise<Response>;
  parseStream(ctx: ParseStreamContext): StreamAccumulator;
  parseResponse(text: string, model: string): Omit<DsResponse, 'durationMs'>;
  readUsage(raw: unknown): Partial<DsUsage> | null;
  /**
   * **错误分类（可选）**：两套协议的错误体形状不同（Responses 与 Chat 都是
   * `{error:{message,type,param,code}}`，但**同一个 HTTP 状态在两家服务商眼里的含义**可能不同），
   * 而"错误分类的知识属于协议"——所以它可以由协议自己实现。
   *
   * **默认回退**：没实现（`undefined`）⇒ `ds-client.ts` 用那份共用的 `classifyHttpStatus`
   * （§4.14 那张表）。⇒ 接口是**可选**的，加它不会把既有的 Responses 实现逼着改一行。
   *
   * **但产出的类型必须是同一套** `DsClientError`（`kind` 七类不变）：上层/回执/日志不分叉
   * 是这条接口的前提（用户 2026-10-21 拍的口径）。
   */
  classifyError?(input: TransportErrorInput): DsClientError;
}

/**
 * `classifyError()` 的入参：**已解析过的**错误现场。
 *
 * 为什么要 `envelope` 这一格（而不是只给原始 body）：信封是 OpenAI 系共有的形状，
 * 解析一次就够了；两个协议实现只需要各自决定"要不要用它、怎么用"。
 */
export interface TransportErrorInput {
  /** HTTP 状态（一定是 4xx/5xx：只在 `!res.ok` 时才问分类） */
  status: number;
  /** `Retry-After` 的解析结果（毫秒）；没有这个头就是 `null` */
  retryAfterMs: number | null;
  /** 错误正文（已按 2,000 字符截断，与 `ERROR_DETAIL_LIMIT` 同源） */
  bodyText: string | null;
  /** 解析出来的错误信封；正文不是 JSON / 不是这形状 ⇒ `null`（不是错误） */
  envelope: { message: string; code: string; type: string; param: string } | null;
}
