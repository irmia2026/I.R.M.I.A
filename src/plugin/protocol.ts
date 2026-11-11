/**
 * 插件平台的 **stdio 行协议**（JSON-RPC 2.0，`\n` 分隔）
 *
 * 为什么是行协议而不是长度前缀：两端（Node 与 Python）都只要一行 `readline` 语义就能实现，
 * 用户拿任何语言写插件都能对着这份文件抄一遍（P2 的"协议文档化"就靠它）。代价是**一行必须
 * 是完整 JSON**——所以本模块把分帧、上限、坏 JSON 三件事都收在这里，别的模块不许自己拼。
 *
 * 三条纪律（违反任何一条，宿主都会被一段坏插件带崩）：
 *   ① **坏 JSON 不炸宿主**：解出来的错误作为一条 {@link DecodeFailure} 交给调用方记录，
 *      解码器继续读下一行。协议层永不 throw。
 *   ② **一行有上限**：超限的那一行整段丢弃并只报一次错（不无限缓存）。否则一个只写换行
 *      不写内容的插件就能把宿主内存吃光。
 *   ③ **id 关联只做一对一**：请求/响应都带 id，响应只能兑现一个在飞的请求；对不上号的
 *      响应是协议错误，同样只记录、不 throw。
 *
 * 方法名的命名口径与 `ctx` API 一致（能力域在前、动词在后）：宿主发给插件的是
 * `tool.invoke` / `hook.invoke`，插件发给宿主的是 `tool.register` / `hook.subscribe`。
 */

/** 协议版本：实现方自报用；当前宿主仅等待 ready 帧，尚不按自报值协商版本。 */
export const PLUGIN_PROTOCOL_VERSION = 1;

/**
 * 单行上限（字节）：8 MB 与整包上限同量级。
 *
 * 为什么需要：`ctx.model.complete` 的返回正文、`ctx.files.read` 的内容都可能很大；给一个
 * 明确的天花板，超了就说"这一帧太大"而不是把宿主的内存当垃圾桶。
 */
export const PLUGIN_LINE_LIMIT_BYTES = 8 * 1024 * 1024;

// ──────────────────────────────── 命名钩子的消息形状 ────────────────────────────────

/**
 * 钩子处理器模式（与 `hook-registry.ts` 的元数据同一份口径）。
 *
 * `blocking` 串行、可改载荷；`observe` 并发、只读、不阻塞调用方。点自己决定允许哪几种，
 * 具体允许值与超时上限只在订阅那一刻由注册表校验——运行器不自行判断。
 */
export type PluginHookMode = 'blocking' | 'observe';
/** 同点内的执行顺序：EARLY → NORMAL → LATE，同序按注册先后 */
export type PluginHookOrder = 'EARLY' | 'NORMAL' | 'LATE';
/** 处理器失败策略：ABORT 整点失败 / SKIP 跳过继续 / LOG 同 SKIP 但额外记一条 */
export type PluginHookErrorPolicy = 'ABORT' | 'SKIP' | 'LOG';

/**
 * `hook.subscribe` 的参数形状。
 *
 * `point` 必须命注册表；`mode` / `order` / `timeoutMs` / `errorPolicy` / `abort` 都是
 * **声明期**校验的。`filter` 只属于 `message.received`（一条订阅一个过滤条件）。
 * 声明 `abort:true` 表示这个处理器可能返回 `{abort:true}`，只在点允许中止时接受。
 */
export interface HookSubscribeParams {
  point: string;
  mode?: PluginHookMode;
  order?: PluginHookOrder;
  timeoutMs?: number;
  errorPolicy?: PluginHookErrorPolicy;
  abort?: boolean;
  filter?: unknown;
}

/**
 * `hook.invoke` 的参数形状。
 *
 * `subscriptionId` 现在对所有点都带（宿主按订阅逐条回调）；旧版运行器只认 point 的
 * 形状仍保留兼容，但新运行器一律按 id 找 handler，避免同点多次订阅互相串结果。
 */
export interface HookInvokeParams {
  point: string;
  subscriptionId?: string;
  payload?: Record<string, unknown>;
}

/** 宿主 → 插件的方法名 */
export const PLUGIN_HOST_METHODS = {
  /** 加载插件并调用它的 `activate(ctx)`；参数里带权限、配置与身份 */
  activate: 'plugin.activate',
  /** 让插件做收尾（插件可以在这一帧里清自己的资源；宿主随后会关 stdin） */
  deactivate: 'plugin.deactivate',
  /** 存活检查（也用于"进程还在但事件循环卡死"的探测） */
  ping: 'plugin.ping',
  /** 调用插件注册的一件工具 */
  invokeTool: 'tool.invoke',
  /** 触发插件订阅的一条钩子 */
  invokeHook: 'hook.invoke',
  /** 执行插件注册的一条聊天指令（P1b） */
  invokeCommand: 'command.invoke',
  /** 定时器到点 */
  fireTimer: 'timer.fire',
} as const;

/** 插件 → 宿主的方法名（全部要过权限门，见 `host-services.ts`） */
export const PLUGIN_PLUGIN_METHODS = {
  registerTool: 'tool.register',
  subscribeHook: 'hook.subscribe',
  log: 'log.write',
  stateGet: 'state.get',
  stateSet: 'state.set',
  filesRead: 'files.read',
  filesWrite: 'files.write',
  filesList: 'files.list',
  chatSend: 'chat.send',
  chatRead: 'chat.read',
  modelComplete: 'model.complete',
  timerEvery: 'timer.every',
  timerCron: 'timer.cron',
  timerCancel: 'timer.cancel',
  /** P1b：经宿主代理访问网络（唯一能真限网的一层） */
  netFetch: 'net.fetch',
  /** P1b：注册一条聊天指令 */
  defineCommand: 'command.define',
  configGet: 'config.get',
} as const;

/** 通知（无 id、不要回帧） */
export const PLUGIN_NOTIFICATIONS = {
  /** 运行器把入口模块加载完了，随时可以 `plugin.activate` */
  ready: 'plugin.ready',
} as const;

/** 宿主→插件的方法名联合 */
export type PluginHostMethod = (typeof PLUGIN_HOST_METHODS)[keyof typeof PLUGIN_HOST_METHODS];
/** 插件→宿主的方法名联合 */
export type PluginPluginMethod = (typeof PLUGIN_PLUGIN_METHODS)[keyof typeof PLUGIN_PLUGIN_METHODS];

/**
 * 错误码：JSON-RPC 2.0 的标准段（-32700…-32603）+ 本平台的语义段（-3200x）。
 *
 * 为什么语义码要单列：宿主需要把"插件没权限"与"插件写错了"分开处置——前者是安装清单的
 * 问题（人要去改 `permissions`），后者是插件代码的问题（插件作者要去改代码）。
 */
export const PLUGIN_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** 插件未声明所需权限（调用那一刻判，不是安装期） */
  permissionDenied: -32001,
  /** 调用超时（宿主已按类别取消等待；进程是否还活着由运行层决定） */
  timeout: -32002,
  /** 宿主未接线的能力出口；shell 始终拒绝，net 已由宿主代理提供。 */
  unsupported: -32003,
  /** 插件进程已经退出 */
  pluginExited: -32004,
  /** 贡献已被隔离（连续失败达到阈值） */
  isolated: -32005,
  /** 调用被宿主业务规则拒绝（例如 chat.send 没有可用通道） */
  business: -32006,
} as const;

export type PluginRpcErrorCode = (typeof PLUGIN_RPC_ERRORS)[keyof typeof PLUGIN_RPC_ERRORS];

// ──────────────────────────────── 帧形状 ────────────────────────────────

export interface RpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface RpcSuccess {
  jsonrpc: '2.0';
  id: number | string;
  result: unknown;
}

export interface RpcFailure {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type RpcResponse = RpcSuccess | RpcFailure;
export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

/** 一条解析失败的帧：`line` 是原文（已截断），`reason` 给人看 */
export interface DecodeFailure {
  reason: string;
  line: string;
}

export type DecodedFrame = { message: RpcMessage } | { failure: DecodeFailure };

// ──────────────────────────────── 类型判定 ────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRpcRequest(value: RpcMessage): value is RpcRequest {
  return 'method' in value && 'id' in value && typeof (value as RpcRequest).method === 'string';
}

export function isRpcNotification(value: RpcMessage): value is RpcNotification {
  return 'method' in value && !('id' in value) && typeof (value as RpcNotification).method === 'string';
}

export function isRpcResponse(value: RpcMessage): value is RpcResponse {
  return 'id' in value && !('method' in value);
}

// ──────────────────────────────── 编码 ────────────────────────────────

/**
 * 一帧 = JSON + `\n`。**不允许值里出现裸换行**：`JSON.stringify` 会把它们转义成 `\n`，
 * 所以只要不手工拼字符串，这条协议天然安全。
 */
function frameOf(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

export function encodeRpcRequest(id: number | string, method: string, params?: unknown): string {
  return frameOf({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
}

export function encodeRpcResult(id: number | string, result: unknown): string {
  return frameOf({ jsonrpc: '2.0', id, result });
}

export function encodeRpcError(id: number | string | null, code: number, message: string, data?: unknown): string {
  return frameOf({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

export function encodeRpcNotification(method: string, params?: unknown): string {
  return frameOf({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
}

// ──────────────────────────────── 解码 ────────────────────────────────

/**
 * 增量行解码器：`push()` 喂任意分块的字节/字符串，返回这一块解出来的完整帧。
 *
 * 只在**看到换行**时才解析；半个 JSON 留在内部缓冲里等下一块。缓冲区按字节上限截断：
 * 一行超限后进入"丢弃模式"，一直丢到下一个换行，避免把半行 JSON 当合法输入。
 */
export class RpcLineDecoder {
  private readonly maxLineBytes: number;
  private buffer = '';
  private discarding = false;

  constructor(options: { maxLineBytes?: number } = {}) {
    this.maxLineBytes = options.maxLineBytes ?? PLUGIN_LINE_LIMIT_BYTES;
  }

  push(chunk: string | Uint8Array): DecodedFrame[] {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const frames: DecodedFrame[] = [];
    let cursor = 0;
    while (cursor < text.length) {
      const newline = text.indexOf('\n', cursor);
      const end = newline === -1 ? text.length : newline;
      const segment = text.slice(cursor, end);
      if (!this.discarding) {
        this.buffer += segment;
        // 用 UTF-8 字节数判上限：字符数会被多字节字符放过（一个 4 字节 emoji 只算 1 个字符）
        if (Buffer.byteLength(this.buffer, 'utf8') > this.maxLineBytes) {
          this.discarding = true;
          this.buffer = '';
          frames.push({ failure: { reason: `帧超过上限 ${this.maxLineBytes} 字节，已丢弃到下一个换行`, line: segment.slice(0, 200) } });
        }
      }
      if (newline === -1) break;
      if (!this.discarding) {
        const line = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
        this.buffer = '';
        if (line.trim() !== '') frames.push(decodeLine(line));
      }
      this.discarding = false;
      cursor = end + 1;
    }
    return frames;
  }

  /** 还剩多少字节没成帧（诊断用） */
  get pendingBytes(): number {
    return Buffer.byteLength(this.buffer, 'utf8');
  }
}

function decodeLine(line: string): DecodedFrame {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { failure: { reason: '不是合法 JSON', line: line.slice(0, 500) } };
  }
  if (!isRecord(value)) return { failure: { reason: '帧必须是 JSON 对象', line: line.slice(0, 500) } };
  if (value['jsonrpc'] !== '2.0') return { failure: { reason: 'jsonrpc 必须是 "2.0"', line: line.slice(0, 500) } };
  const hasMethod = typeof value['method'] === 'string';
  const hasId = typeof value['id'] === 'number' || typeof value['id'] === 'string';
  if (hasMethod) {
    if (hasId) return { message: { jsonrpc: '2.0', id: value['id'] as number | string, method: value['method'] as string, ...(value['params'] === undefined ? {} : { params: value['params'] }) } };
    return { message: { jsonrpc: '2.0', method: value['method'] as string, ...(value['params'] === undefined ? {} : { params: value['params'] }) } };
  }
  if (!('id' in value)) return { failure: { reason: '既没有 method 也没有 id', line: line.slice(0, 500) } };
  const id = value['id'];
  if (id !== null && typeof id !== 'number' && typeof id !== 'string') {
    return { failure: { reason: 'id 必须是数字、字符串或 null', line: line.slice(0, 500) } };
  }
  const error = value['error'];
  if (isRecord(error) && typeof error['code'] === 'number' && typeof error['message'] === 'string') {
    return {
      message: {
        jsonrpc: '2.0',
        id: id as number | string | null,
        error: { code: error['code'], message: error['message'], ...(error['data'] === undefined ? {} : { data: error['data'] }) },
      },
    };
  }
  if ('result' in value && id !== null) return { message: { jsonrpc: '2.0', id: id as number | string, result: value['result'] } };
  return { failure: { reason: '响应既没有 result 也没有合法 error', line: line.slice(0, 500) } };
}

// ──────────────────────────────── 错误 ────────────────────────────────

/**
 * 宿主侧对插件调用失败的统一形态。
 *
 * `category` 直接对接 `failures.ts` 的熔断口径（`PluginFailureCategory` 的子集），
 * 于是"超时按系统性失败计数"不需要在运行层再翻译一次。
 */
export class PluginRpcError extends Error {
  readonly code: number;
  readonly category: 'protocol' | 'timeout' | 'denied' | 'unsupported' | 'crash' | 'business';
  readonly data: unknown;

  constructor(code: number, message: string, category: PluginRpcError['category'] = 'protocol', data?: unknown) {
    super(message);
    this.name = 'PluginRpcError';
    this.code = code;
    this.category = category;
    this.data = data;
  }
}

/** 便捷构造：权限拒绝。消息要把「哪个权限、哪个方法、怎么改」一次说清。 */
export function permissionDeniedError(pluginId: string, permission: string, method: string): PluginRpcError {
  return new PluginRpcError(
    PLUGIN_RPC_ERRORS.permissionDenied,
    `插件 ${pluginId} 未声明 ${permission} 权限，不能调用 ${method}（在 plugin.json 的 permissions 里显式声明后才允许）`,
    'denied',
    { permission, method },
  );
}

/** 这一期明确不支持的能力：消息里必须写清"不是写错了，是还没做" */
export function unsupportedError(permission: string, hint: string): PluginRpcError {
  return new PluginRpcError(
    PLUGIN_RPC_ERRORS.unsupported,
    `权限 ${permission} 本版本不支持：${hint}`,
    'unsupported',
    { permission },
  );
}
