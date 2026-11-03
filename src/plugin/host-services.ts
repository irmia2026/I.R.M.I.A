/**
 * 插件**能力面**的宿主侧实现：`ctx.*` 的每一个方法都落在这里。
 *
 * 这一层的职责只有三件：
 *   ① **权限在调用那一刻判**（不是安装期看清单就算数）：没声明的直接回 `permissionDenied`；
 *   ② **把插件想要的事翻译成宿主既有设施**：工具进 `ToolRegistry`、钩子进分发器、
 *      state/files 落 `<dataDir>/plugins/…`、chat/model 走注入的宿主出口；
 *   ③ **故障按贡献计数**：连续 3 次超时/失败隔离**那一条贡献**，不整包停（设计稿的裁决）。
 *
 * 与 `runtime-process.ts` 的分工：那边只管进程与协议，这边只管"进程里伸出来的手"。
 *
 * ## Python 的边界是"门槛"不是沙箱（必须如实写在文档与错误里）
 * `--permission` 是 JS/TS 的真围栏；Python 没有等价物。这一期给 Python 的三样东西是：
 *   安装期 AST 扫描（`python/ast_scan.py`）+ 运行期超时/kill + `irmia_plugin` shim 只暴露 ctx。
 * 挡不住有心的恶意代码——它的安全性来自"你确认过这个插件"。凡是给用户看的说明都这么写。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

import type { PluginFailureCategory } from './failures.ts';
import {
  HookRegistry, defaultHookTimeoutMs, isPluginHookPoint, normalizeHookSubscription, HOOK_ORDER_WEIGHT,
  PLUGIN_HOOK_PERMISSIONS, PLUGIN_HOOK_POINTS,
  type HookAbortInfo, type HookInvokeResult, type HookSubscription,
  type PluginHookErrorPolicy, type PluginHookOrder, type PluginHookPoint,
} from './hook-registry.ts';
import {
  PLUGIN_PERMISSIONS,
  resolvePluginConfig,
  type PluginManifest,
  type PluginPermission,
} from './manifest.ts';
import { pluginNetFetch, requireNetPermission } from './net-fetch.ts';
import { testMessageRegex } from './filter-regex.ts';
import type { PluginPackage } from './package-store.ts';
import { permissionDeniedError, PluginRpcError, PLUGIN_RPC_ERRORS } from './protocol.ts';
import {
  DEFAULT_PLUGIN_TIMEOUTS, PLUGIN_CRASH_COOLDOWN_MS, PluginRuntimeSupervisor,
  type PluginProcessHandlers, type PluginRuntimeStatus, type PluginTimeouts,
} from './runtime-process.ts';
import { errorResult } from '../tools/types.ts';
import type { ToolDefinition, ToolHandlerResult } from '../tools/types.js';

// ──────────────────────────────── 钩子名单 ────────────────────────────────

/**
 * 命名 Hook 的唯一真源在 `hook-registry.ts`；这里保留旧导出名给既有文档/外部引用。
 *
 * 旧 14 个点的名字、权限与触发语义一个字都没改；新增的 `host.ready` / `command.before` /
 * `command.after` 与元数据表在一起。订阅校验、顺序、超时、abort/errorPolicy 都由注册表
 * 执行，host-services 只负责把"哪个插件、哪个进程"交给它。
 */
export { PLUGIN_HOOK_POINTS, PLUGIN_HOOK_PERMISSIONS };
export type { PluginHookPoint };

/**
 * P1b 之后**没有**被推迟的钩子了（常量保留给既有的文档/外部引用）。
 *
 * 不改名是因为仓库外可能已经有人按这个名字引用；值是空数组，语义从"这些还没做"
 * 变成"这些已经全做了"。
 */
export const PLUGIN_HOOKS_NOT_IN_P1A: readonly string[] = [];

/** 出站媒体（`reply.decorate` 可以附加）：与 `MediaRequest` 的字段同名，但只收 JSON 可表达的值 */
export interface PluginOutboundMedia {
  url?: string;
  /** 插件数据目录里的相对路径（宿主会解析成绝对路径再发；插件不直接碰整机文件系统） */
  path?: string;
  base64?: string;
  name?: string;
  fileType?: 1 | 2 | 3 | 4;
}

export interface PluginHookResult {
  pluginId: string;
  contentHash: string;
  result: unknown;
}

export interface PluginHookOutcome {
  results: PluginHookResult[];
  /** model.request：可追加到系统指令末尾的文本 */
  systemSuffix: string;
  /** reply.decorate：替换后的正文（null = 不改） */
  text: string | null;
  /** reply.decorate：附加媒体 */
  extraMedia: PluginOutboundMedia[];
  /** tool.after：改写后的结果 */
  updatedResult: { content?: string; isError?: boolean } | null;
  /** tool.before：改写后的入参（`undefined` = 不改） */
  updatedInput: unknown;
  /** command.before：改写后的指令参数（`undefined` = 不改） */
  updatedArgs: unknown;
  /** 任何钩子都能补的上下文（已截断） */
  additionalContext: string;
  /** 被哪个 blocking 处理器中止（仅 allowAbort 的点；null = 没中止） */
  abortedBy: HookAbortInfo | null;
  /** errorPolicy=ABORT 让这个点整体失败（调用方应放弃本次修改） */
  failed: boolean;
  error: string | null;
}

const EMPTY_HOOK_OUTCOME: PluginHookOutcome = Object.freeze({
  results: [], systemSuffix: '', text: null, extraMedia: [], updatedResult: null,
  updatedInput: undefined, updatedArgs: undefined, additionalContext: '',
  abortedBy: null, failed: false, error: null,
});

// ──────────────────────────────── 入站消息 / 聊天指令（P1b） ────────────────────────────────

/**
 * `message.received` 的载荷：**宿主归一化之后**的外部消息。
 *
 * 与 `wake/channel` 的差别只有两处：chatType 归成 `group` / `private`（插件不需要知道
 * `group-at` / `guild` 这些宿主内部的分流细节）；发送者叫 `senderId` / `senderName`。
 * 其余字段与落库事件同源，插件拿到的就是"已过滤后的那一条"。
 */
export interface PluginMessageReceivedPayload {
  channel: string;
  chatType: 'group' | 'private';
  chatId: string;
  senderId: string;
  senderName: string;
  text: string;
  mentionsMe: boolean;
  mediaCount: number;
  messageId: string;
  at: string;
}

/** `ctx.hooks.on('message.received', handler, filter)` 的过滤条件（**宿主侧判**） */
export interface PluginMessageFilter {
  channel?: 'qq-official' | 'onebot';
  chatType?: 'group' | 'private';
  mentionMe?: boolean;
  regex?: RegExp;
  permission?: 'admin' | 'all';
}

/** 入站钩子的合并结果：同名钩子按注册顺序串行，后一个看到前一个改写后的正文 */
export interface PluginMessageHookOutcome {
  text: string;
  drop: boolean;
  additionalContext: string;
  /** 实际被调用的订阅数（0 = 没有插件要这条消息） */
  matched: number;
}

/** `ctx.commands.define` 注册成功后，宿主侧保存的指令条目 */
export interface PluginCommandDefinition {
  commandId: string;
  pluginId: string;
  contentHash: string;
  /** 归一化后的名字（小写；用于匹配） */
  name: string;
  aliases: readonly string[];
  description: string;
  permission: 'admin' | 'all';
  args: PluginCommandArgsSchema | null;
}

export interface PluginCommandArgsSchema {
  type: 'object';
  properties: Record<string, PluginCommandArgProperty>;
  required: readonly string[];
}

export interface PluginCommandArgProperty {
  type: 'string' | 'number' | 'integer' | 'boolean';
  enum?: readonly (string | number | boolean)[];
  description?: string;
}

export interface PluginCommandReply {
  text?: string;
  media?: PluginOutboundMedia;
}

/** 一条指令被命中并执行后的宿主结论 */
export interface PluginCommandOutcome {
  matched: true;
  /** 命中的规范名（不是用户打的别名） */
  command: string;
  keepInContext: boolean;
  reply: PluginCommandReply | null;
  /** 失败时给宿主日志的一句原因（不会直接回给用户） */
  error?: string;
}

// ──────────────────────────────── 宿主依赖 ────────────────────────────────

export interface PluginHostToolSink {
  register: (definition: ToolDefinition) => void;
  unregister: (name: string) => void;
}

export interface PluginChatMessage {
  text?: string;
  media?: PluginOutboundMedia;
}

export interface PluginModelRequest {
  tier: 'light' | 'heavy';
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
}

export interface PluginModelReply {
  text: string;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/** 宿主的生命周期桥：只暴露宿主需要的那几件，避免 host-services 反向依赖 PluginManager */
export interface PluginHostBridge {
  /** 记一条插件失败（走既有 `plugin/failed` 事件） */
  recordFailure: (id: string, contentHash: string, reason: string, category?: string) => void;
  /** 运行面已经就位：清掉该包的"需要重启"标记 */
  markRuntimeApplied: (id: string, contentHash: string) => void;
  /** 组合变了（工具/钩子/技能面）：让宿主重算一次（fire-and-forget） */
  applyComposition: () => void | Promise<void>;
  /** 连续崩溃 / 重启失败：自动停用 */
  autoDisable: (id: string, contentHash: string, reason: string) => void;
  /** 按 id@hash 找当前包（热启用事件只带 id 与 hash） */
  packageOf: (id: string, contentHash: string) => PluginPackage | null;
  /** 告警出口（可选） */
  alert?: (input: { category: string; title: string; body: string }) => void;
  /** 宿主日志（可选：默认与 write 同一出口） */
  write?: (line: string) => void;
}

export interface PluginHostOptions {
  dataDir: string;
  write: (line: string) => void;
  emit: (type: string, data: Record<string, unknown>) => void;
  tools: PluginHostToolSink;
  bridge: PluginHostBridge;
  /** `ctx.chat.send` 的宿主出口（main 接到既有回投/媒体投递口） */
  sendChat?: (plugin: PluginInstanceView, message: PluginChatMessage) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** `ctx.chat.history(limit)` 的宿主出口（`chat.read` 权限；main 接 `readChannelMessages`） */
  readChat?: (plugin: PluginInstanceView, request: { limit: number }) => Promise<unknown[]>;
  /** `ctx.model.complete` 的宿主出口（main 接到 DsClient + 预算记账） */
  completeModel?: (plugin: PluginInstanceView, request: PluginModelRequest) => Promise<PluginModelReply>;
  /** 当前会话 id（`ctx.state.session` 的作用域）；缺省 `default` */
  currentSessionId?: () => string | null;
  /**
   * 「这条入站消息的发送者是用户吗」——`message.received` 的 `admin` 过滤条件与
   * `permission: 'admin'` 的聊天指令共用这一格。
   *
   * **判据由宿主给**（`runtime/trust.ts` 那一套：联系人表里的 c2c 用户名字 + 已声明的用户 id），
   * 这里不另造一套身份规则。没接线 = 没人算用户（admin 类订阅/指令对谁都拒绝）。
   */
  isOwnerMessage?: (message: PluginMessageReceivedPayload) => boolean;
  /**
   * 宿主开关：允许 `http://` 且只允许 127.0.0.1 / localhost（默认关）。
   * 生产不打开；测试用它访问本地 fixture server。https 不受它影响。
   */
  netAllowInsecureLoopbackHttp?: boolean;
  /** 配置覆盖值（默认读 `<dataDir>/plugins/config/<id>.json`） */
  readConfigOverrides?: (pluginId: string) => Record<string, unknown>;
  timeouts?: Partial<PluginTimeouts>;
  crashCooldownMs?: number;
  timeoutRestartDelayMs?: number;
  now?: () => number;
  nodePath?: string;
  pythonPath?: string;
  env?: NodeJS.ProcessEnv;
}

/** 给注入回调的只读视图（宿主不需要拿到内部实例） */
export interface PluginInstanceView {
  id: string;
  contentHash: string;
  version: string;
  permissions: readonly string[];
  config: Readonly<Record<string, unknown>>;
}

// ──────────────────────────────── 实例 ────────────────────────────────

interface TimerHandle {
  kind: 'every' | 'cron';
  timer: NodeJS.Timeout;
  /** every：间隔；cron：表达式 */
  spec: number | string;
}

interface PluginInstance {
  id: string;
  contentHash: string;
  version: string;
  apiVersion: number;
  rootDir: string;
  dataDir: string;
  runtime: { type: 'node' | 'python'; entry: string };
  permissions: ReadonlySet<string>;
  config: Record<string, unknown>;
  netAllow: readonly string[];
  hooks: Set<PluginHookPoint>;
  tools: Set<string>;
  /** `message.received` 的订阅：subscriptionId → 宿主侧过滤条件 */
  messageSubscriptions: Map<string, MessageSubscriptionEntry>;
  /** 这个插件注册的指令：commandId → 条目（全局表里的同一份引用） */
  commands: Map<string, PluginCommandDefinition>;
  timers: Map<string, TimerHandle>;
  failureCounts: Map<string, number>;
  isolated: Set<string>;
}

/** 一条 `message.received` 订阅（全局按 order→注册顺序串行；filter 仍一条订阅一个） */
interface MessageSubscriptionEntry {
  subscriptionId: string;
  seq: number;
  instance: PluginInstance;
  filter: PluginMessageFilter;
  order: PluginHookOrder;
  timeoutMs: number;
  errorPolicy: PluginHookErrorPolicy;
}

/** 一条指令在全局命名空间里的条目（name / alias 都指向它） */
interface CommandEntry extends PluginCommandDefinition {
  instance: PluginInstance;
}

const keyOf = (id: string, hash: string): string => `${id}\0${hash}`;
const CONTRIBUTION_ISOLATION_THRESHOLD = 3;

/** 插件数据目录（**不是包目录**）：`ctx.files`、`--allow-fs-write` 与默认配置都落这里 */
export function pluginDataDir(dataDir: string, pluginId: string): string {
  return join(dataDir, 'plugins', 'data', pluginId);
}

/** 插件状态（`ctx.state`）的落盘目录 */
export function pluginStateDir(dataDir: string): string {
  return join(dataDir, 'plugins', 'state');
}

/** 插件配置覆盖值的落盘目录（P1b 的设置页会写这里；P1a 只读） */
export function pluginConfigDir(dataDir: string, pluginId: string): string {
  return join(dataDir, 'plugins', 'config', pluginId);
}

// ──────────────────────────────── 参数读取 ────────────────────────────────

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}: 参数必须是对象`, 'protocol');
  }
  return value as Record<string, unknown>;
}

function optionalText(value: unknown, where: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}: 必须是字符串`, 'protocol');
  if (value.length > maxLength) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}: 超过 ${maxLength} 字符`, 'protocol');
  return value;
}

function requiredText(value: unknown, where: string, maxLength: number): string {
  const text = optionalText(value, where, maxLength);
  if (text === undefined || text === '') throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}: 不能为空`, 'protocol');
  return text;
}

/** 相对路径 → 插件数据目录内的绝对路径。**越界一律拒绝**（不解析 realpath：数据目录是宿主自己建的） */
function resolveInside(root: string, value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || isAbsolute(value) || win32.isAbsolute(value)) {
    throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}: 必须是插件数据目录内的相对路径`, 'protocol');
  }
  const target = resolve(root, value);
  const relation = relative(root, target);
  if (relation === '' || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}: 路径越出插件数据目录`, 'protocol');
  }
  return target;
}

const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/;

/** `'10m' | '30s' | 600000` → 毫秒（宿主调度用；与 `ctx.timers` 的文档同一口径） */
export function parsePluginDuration(value: unknown, where: string): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string') {
    const match = DURATION.exec(value.trim());
    if (match !== null) {
      const amount = Number(match[1]);
      const unit = match[2] ?? 'ms';
      const factor = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
      const ms = Math.floor(amount * factor);
      if (ms > 0) return ms;
    }
  }
  throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}: 无法识别的时长 ${JSON.stringify(value)}（支持 500ms / 30s / 10m / 1h 或毫秒数）`, 'protocol');
}

// ──────────────────────────────── 入站过滤条件 ────────────────────────────────

const MESSAGE_CHANNELS = ['qq-official', 'onebot'] as const;
const MAX_MESSAGE_SUBSCRIPTIONS_PER_PLUGIN = 16;
const MAX_FILTER_REGEX_CHARS = 200;

/**
 * `hook.subscribe` 的 filter 参数 → 宿主侧过滤条件。
 *
 * **订阅时必须给一个对象**（空对象 = 全部消息，但作者得显式写出来）：不给就等于
 * "这个插件想读所有通道的所有消息"，那种默认值不该由少写一个参数产生。
 */
export function parseMessageFilter(value: unknown): PluginMessageFilter {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, "message.received 订阅必须给过滤条件对象（例如 { chatType: 'private', permission: 'all' }）", 'protocol');
  }
  const record = value as Record<string, unknown>;
  const filter: { channel?: 'qq-official' | 'onebot'; chatType?: 'group' | 'private'; mentionMe?: boolean; regex?: RegExp; permission?: 'admin' | 'all' } = {};
  for (const key of Object.keys(record)) {
    if (key !== 'channel' && key !== 'chatType' && key !== 'mentionMe' && key !== 'regex' && key !== 'permission') {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `message.received 过滤条件不支持 ${key}`, 'protocol');
    }
  }
  const channel = record['channel'];
  if (channel !== undefined) {
    if (typeof channel !== 'string' || !(MESSAGE_CHANNELS as readonly string[]).includes(channel)) {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `message.received.channel: 只能是 ${MESSAGE_CHANNELS.join(' / ')}`, 'protocol');
    }
    filter.channel = channel as 'qq-official' | 'onebot';
  }
  const chatType = record['chatType'];
  if (chatType !== undefined) {
    if (chatType !== 'group' && chatType !== 'private') {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, "message.received.chatType: 只能是 'group' 或 'private'", 'protocol');
    }
    filter.chatType = chatType;
  }
  const mentionMe = record['mentionMe'];
  if (mentionMe !== undefined) {
    if (typeof mentionMe !== 'boolean') throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, 'message.received.mentionMe: 必须是布尔值', 'protocol');
    filter.mentionMe = mentionMe;
  }
  const permission = record['permission'];
  if (permission !== undefined) {
    if (permission !== 'admin' && permission !== 'all') {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, "message.received.permission: 只能是 'admin' 或 'all'", 'protocol');
    }
    filter.permission = permission;
  }
  const regex = record['regex'];
  if (regex !== undefined) {
    if (typeof regex !== 'string' || regex === '') throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, 'message.received.regex: 必须是非空字符串', 'protocol');
    if (regex.length > MAX_FILTER_REGEX_CHARS) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `message.received.regex: 超过 ${MAX_FILTER_REGEX_CHARS} 字符`, 'protocol');
    try {
      // 不带 g/y：RegExp.prototype.test 在无状态模式下才不会被上一次匹配的 lastIndex 影响
      filter.regex = new RegExp(regex, 'u');
    } catch (error) {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `message.received.regex 不是合法正则：${error instanceof Error ? error.message : String(error)}`, 'protocol');
    }
  }
  return filter;
}

/**
 * 宿主侧过滤判据（**插件拿到的永远是通过这里的那一条**）。
 *
 * `regex` 匹配的是**当前正文**（前面的钩子可能已经改写），其余条件匹配原始载荷字段。
 * `permission: 'admin'` 在宿主没接线 `isOwnerMessage` 时一律不匹配（失败关闭）。
 */
export async function matchesMessageFilter(
  filter: PluginMessageFilter,
  payload: PluginMessageReceivedPayload,
  text: string,
  isOwner: ((message: PluginMessageReceivedPayload) => boolean) | undefined,
): Promise<boolean> {
  if (filter.channel !== undefined && payload.channel !== filter.channel) return false;
  if (filter.chatType !== undefined && payload.chatType !== filter.chatType) return false;
  if (filter.mentionMe !== undefined && payload.mentionsMe !== filter.mentionMe) return false;
  if (filter.permission === 'admin' && isOwner?.(payload) !== true) return false;
  if (filter.regex !== undefined && !await testMessageRegex(filter.regex, text)) return false;
  return true;
}

// ──────────────────────────────── 聊天指令（P1b） ────────────────────────────────

/** 宿主内置指令（插件不许覆盖：撞名时宿主那一条永远赢） */
const BUILTIN_COMMANDS = ['compact', 'handoff', 'stop'] as const;
const MAX_COMMAND_NAME_CHARS = 32;
const MAX_COMMAND_ALIASES = 5;
const MAX_COMMAND_ARGS_PROPERTIES = 16;
const MAX_COMMAND_ARGS_REQUIRED = 16;

/**
 * 指令名归一化：去开头的 `/`（作者可能顺手写）、trim、小写。
 *
 * 匹配一律大小写不敏感（与既有斜杠指令的口径一致）；中文名不受影响。
 */
export function normalizeCommandName(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}: 必须是字符串`, 'protocol');
  const trimmed = value.trim().replace(/^\/+/u, '').trim().toLowerCase();
  if (trimmed === '') throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}: 不能为空`, 'protocol');
  if (trimmed.length > MAX_COMMAND_NAME_CHARS) {
    throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}: 超过 ${MAX_COMMAND_NAME_CHARS} 字符`, 'protocol');
  }
  if (/[\s/\\\u0000-\u001f]/u.test(trimmed)) {
    throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}: 不能包含空白、斜杠或控制字符`, 'protocol');
  }
  return trimmed;
}

/** `args` 的 JSON Schema 子集（只认这一期真的会校验的几种类型） */
function parseCommandArgsSchema(value: unknown, where: string): PluginCommandArgsSchema | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}: 必须是 JSON Schema 对象`, 'protocol');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'type' && key !== 'properties' && key !== 'required') {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}: 只支持 type / properties / required（收到 ${key}）`, 'protocol');
    }
  }
  if (record['type'] !== 'object') throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}.type: 只支持 object`, 'protocol');
  const rawProperties = record['properties'];
  if (rawProperties === null || typeof rawProperties !== 'object' || Array.isArray(rawProperties)) {
    throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}.properties: 必须是对象`, 'protocol');
  }
  const propertyEntries = Object.entries(rawProperties as Record<string, unknown>);
  if (propertyEntries.length > MAX_COMMAND_ARGS_PROPERTIES) {
    throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}.properties: 最多 ${MAX_COMMAND_ARGS_PROPERTIES} 项`, 'protocol');
  }
  const properties: Record<string, PluginCommandArgProperty> = {};
  for (const [name, raw] of propertyEntries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/u.test(name)) {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}.properties: 非法参数名 ${JSON.stringify(name)}`, 'protocol');
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}.properties.${name}: 必须是对象`, 'protocol');
    }
    const property = raw as Record<string, unknown>;
    for (const key of Object.keys(property)) {
      if (key !== 'type' && key !== 'enum' && key !== 'description') {
        throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}.properties.${name}: 只支持 type / enum / description（收到 ${key}）`, 'protocol');
      }
    }
    const type = property['type'];
    if (type !== 'string' && type !== 'number' && type !== 'integer' && type !== 'boolean') {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}.properties.${name}.type: 只支持 string / number / integer / boolean`, 'protocol');
    }
    const parsed: { type: PluginCommandArgProperty['type']; enum?: readonly (string | number | boolean)[]; description?: string } = { type };
    if (property['enum'] !== undefined) {
      if (!Array.isArray(property['enum']) || property['enum'].length === 0) {
        throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}.properties.${name}.enum: 必须是非空数组`, 'protocol');
      }
      const choices = property['enum'].map((item) => {
        if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
          throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}.properties.${name}.enum: 每项只能是字符串/数字/布尔`, 'protocol');
        }
        return item;
      });
      parsed.enum = choices;
    }
    if (property['description'] !== undefined) {
      if (typeof property['description'] !== 'string' || property['description'].length > 200) {
        throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}.properties.${name}.description: 必须是 ≤200 字符的字符串`, 'protocol');
      }
      parsed.description = property['description'];
    }
    properties[name] = parsed;
  }
  const rawRequired = record['required'];
  const required: string[] = [];
  if (rawRequired !== undefined) {
    if (!Array.isArray(rawRequired) || rawRequired.length > MAX_COMMAND_ARGS_REQUIRED) {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}.required: 必须是数组（最多 ${MAX_COMMAND_ARGS_REQUIRED} 项）`, 'protocol');
    }
    for (const item of rawRequired) {
      if (typeof item !== 'string' || properties[item] === undefined) {
        throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}.required: ${JSON.stringify(item)} 不在 properties 里`, 'protocol');
      }
      if (required.includes(item)) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}.required: 重复项 ${item}`, 'protocol');
      required.push(item);
    }
  }
  return { type: 'object', properties, required };
}

/** 从一条消息正文里取出 `{ word, rest }`；不是 `/指令` 形状返回 null */
export function parseCommandInvocation(text: string): { word: string; rest: string } | null {
  const trimmed = text.trim();
  const normalized = trimmed.startsWith('／') ? `/${trimmed.slice(1)}` : trimmed;
  if (!normalized.startsWith('/') || normalized.startsWith('//')) return null;
  const body = normalized.slice(1);
  const match = /^(\S+)([\s\S]*)$/u.exec(body);
  if (match === null) return null;
  return { word: match[1]!.toLowerCase(), rest: match[2]!.trim() };
}

/** 指令的宿主用法文案（**只有宿主写**：插件不自己拼，免得三种说法） */
export function commandUsageOf(entry: Pick<PluginCommandDefinition, 'name' | 'args'>): string {
  const names = entry.args === null ? [] : Object.keys(entry.args.properties);
  const required = new Set(entry.args?.required ?? []);
  const parts = names.map((name) => required.has(name) ? `<${name}>` : `[${name}]`);
  return `用法：/${entry.name}${parts.length === 0 ? '' : ` ${parts.join(' ')}`}`;
}

interface ParsedCommandArgs {
  args: Record<string, unknown>;
  error: string | null;
}

function coerceCommandArg(raw: string, property: PluginCommandArgProperty): { value: unknown; error: string | null } {
  let value: unknown = raw;
  if (property.type === 'number' || property.type === 'integer') {
    const number = Number(raw);
    if (!Number.isFinite(number) || (property.type === 'integer' && !Number.isInteger(number))) {
      return { value: undefined, error: `参数应为${property.type === 'integer' ? '整数' : '数字'}` };
    }
    value = number;
  } else if (property.type === 'boolean') {
    const lower = raw.toLowerCase();
    if (lower === 'true' || lower === '1' || lower === '是') value = true;
    else if (lower === 'false' || lower === '0' || lower === '否') value = false;
    else return { value: undefined, error: '参数应为 true / false' };
  }
  if (property.enum !== undefined && !property.enum.some((choice) => String(choice) === String(value))) {
    return { value: undefined, error: `参数只能是 ${property.enum.map((choice) => String(choice)).join(' / ')}` };
  }
  return { value, error: null };
}

/**
 * 正文 → 按 `args` schema 解析出的参数对象。
 *
 * 解析口径刻意简单（这一期不做完整 JSON Schema）：
 *   · 无参数指令：多写任何东西都算参数错误；
 *   · 一个参数：整段 rest 都是它（`/表情 开心 一点` 里的空格属于正文）；
 *   · 多个参数：按空白切，最后一个 string 参数吃掉剩下的所有词（中文里"一句话里带空格"很常见）。
 */
function parseCommandArgs(schema: PluginCommandArgsSchema | null, rest: string): ParsedCommandArgs {
  const args: Record<string, unknown> = {};
  if (schema === null || Object.keys(schema.properties).length === 0) {
    return rest === '' ? { args, error: null } : { args, error: '这个指令不接受参数' };
  }
  const names = Object.keys(schema.properties);
  const required = new Set(schema.required);
  if (rest === '') {
    const missing = names.filter((name) => required.has(name));
    return missing.length === 0 ? { args, error: null } : { args, error: `缺少参数 ${missing.join(', ')}` };
  }
  if (names.length === 1) {
    const name = names[0]!;
    const coerced = coerceCommandArg(rest, schema.properties[name]!);
    if (coerced.error !== null) return { args, error: coerced.error };
    args[name] = coerced.value;
    return { args, error: null };
  }
  const tokens = rest.split(/\s+/u);
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]!;
    const property = schema.properties[name]!;
    const isLast = index === names.length - 1;
    const token = isLast ? tokens.slice(index).join(' ') : tokens[index];
    if (token === undefined || token === '') {
      if (required.has(name)) return { args, error: `缺少参数 ${name}` };
      continue;
    }
    const coerced = coerceCommandArg(token, property);
    if (coerced.error !== null) return { args, error: `${name}：${coerced.error}` };
    args[name] = coerced.value;
  }
  return { args, error: null };
}

// ──────────────────────────────── 主类 ────────────────────────────────

export class PluginHost {
  private readonly options: PluginHostOptions;
  private readonly supervisor: PluginRuntimeSupervisor;
  private readonly instances = new Map<string, PluginInstance>();
  private readonly timeouts: PluginTimeouts;
  private readonly now: () => number;
  /** 命名 Hook 的订阅与分发（除 message.received 的特判过滤链外，全部走这里） */
  private readonly hookRegistry = new HookRegistry();
  /** 入站订阅：全局按 order→注册顺序（seq 单调递增） */
  private messageSubscriptions: MessageSubscriptionEntry[] = [];
  /** 指令命名空间：name / alias（小写）→ 条目 */
  private readonly commandNames = new Map<string, CommandEntry>();
  /** `commandId` → 条目（插件回调时按它找 handler） */
  private readonly commandsById = new Map<string, CommandEntry>();
  private subscriptionSeq = 0;
  private hookSubscriptionSeq = 0;
  private commandSeq = 0;
  /** host.ready 是"宿主生命周期内一次"：即便当时没有订阅也要先记下已经发生过 */
  private hostReadyFired = false;

  constructor(options: PluginHostOptions) {
    this.options = options;
    this.timeouts = { ...DEFAULT_PLUGIN_TIMEOUTS, ...options.timeouts };
    this.now = options.now ?? Date.now;
    this.supervisor = new PluginRuntimeSupervisor({
      log: (line) => { this.options.write(line); },
      emit: (type, data) => this.onRuntimeEvent(type, data),
      timeouts: this.timeouts,
      crashCooldownMs: options.crashCooldownMs ?? PLUGIN_CRASH_COOLDOWN_MS,
      ...(options.timeoutRestartDelayMs === undefined ? {} : { timeoutRestartDelayMs: options.timeoutRestartDelayMs }),
      ...(options.nodePath === undefined ? {} : { nodePath: options.nodePath }),
      ...(options.pythonPath === undefined ? {} : { pythonPath: options.pythonPath }),
      ...(options.env === undefined ? {} : { env: options.env }),
      now: this.now,
      onFatal: (target, reason) => {
        this.options.write(`[插件] ${target.id}@${target.contentHash.slice(0, 8)} ${reason}，自动停用`);
        try {
          this.options.bridge.autoDisable(target.id, target.contentHash, reason);
        } catch (error) {
          this.options.write(`[插件] 自动停用失败：${error instanceof Error ? error.message : String(error)}`);
        }
        this.options.bridge.alert?.({
          category: 'plugin-crashed',
          title: `插件 ${target.id} 连续崩溃，已自动停用`,
          body: `${reason}。插件包 ${target.id}@${target.contentHash.slice(0, 8)}；检查插件日志后可在扩展页手动重新启用。`,
        });
      },
    });
  }

  // ── 生命周期 ──

  /** 起一个代码插件的进程（declarative 包直接跳过：它的贡献由组合面处理） */
  async startPackage(pkg: PluginPackage): Promise<void> {
    const manifest = pkg.manifest;
    if (manifest.runtime.type === 'declarative') return;
    const key = keyOf(manifest.id, pkg.contentHash);
    if (this.instances.has(key)) await this.stopPackage(manifest.id, pkg.contentHash, 'restart');
    const instance = this.buildInstance(pkg);
    this.instances.set(key, instance);
    try {
      await this.supervisor.start({
        id: instance.id,
        contentHash: instance.contentHash,
        version: instance.version,
        apiVersion: instance.apiVersion,
        rootDir: instance.rootDir,
        dataDir: instance.dataDir,
        runtime: instance.runtime,
        permissions: [...instance.permissions],
        netAllow: [...instance.netAllow],
        config: instance.config,
      }, this.handlersOf(instance));
    } catch (error) {
      // Activation can register contributions before rejecting. Revoke them while
      // the instance still exists, then stop the process and discard its reference.
      this.revokeContributions(instance);
      await this.supervisor.stop(instance.id, instance.contentHash, 'activate-failed');
      this.instances.delete(key);
      await this.options.bridge.applyComposition();
      const reason = error instanceof Error ? error.message : String(error);
      this.options.write(`[插件] ${manifest.id} 启动失败：${reason}`);
      this.options.bridge.recordFailure(manifest.id, pkg.contentHash, `启动失败：${reason}`, 'start');
      throw error;
    }
    this.options.bridge.markRuntimeApplied(manifest.id, pkg.contentHash);
    this.notifyPluginLifecycle('plugin.loaded', {
      id: instance.id, contentHash: instance.contentHash, runtime: instance.runtime.type,
      version: instance.version, entry: instance.runtime.entry,
    }, null);
    void this.options.bridge.applyComposition();
  }

  async stopPackage(id: string, contentHash: string, reason = 'disable'): Promise<void> {
    const key = keyOf(id, contentHash);
    const instance = this.instances.get(key);
    if (instance === undefined) {
      await this.supervisor.stop(id, contentHash, reason);
      return;
    }
    this.notifyPluginLifecycle('plugin.unloaded', { id, contentHash, reason }, key);
    this.revokeContributions(instance);
    await this.supervisor.stop(id, contentHash, reason);
    this.instances.delete(key);
    this.options.bridge.markRuntimeApplied(id, contentHash);
    void this.options.bridge.applyComposition();
  }

  /**
   * 卸载前的**同步**收尸：`PluginManager.uninstall` 是同步的（HTTP 命令层不改异步），
   * 而"删包目录前进程必须已经不在"不能等一个 await。`kill` 本身是同步发信号。
   */
  killForUninstall(id: string, contentHash: string): void {
    const key = keyOf(id, contentHash);
    const instance = this.instances.get(key);
    if (instance !== undefined) {
      this.notifyPluginLifecycle('plugin.unloaded', { id, contentHash, reason: 'uninstall' }, key);
      this.revokeContributions(instance);
      this.instances.delete(key);
    }
    this.supervisor.killNow(id, contentHash, 'uninstall');
  }

  async stopAll(reason = 'shutdown'): Promise<void> {
    const ids = [...this.instances.values()].map((instance) => ({ id: instance.id, hash: instance.contentHash }));
    for (const item of ids) this.notifyPluginLifecycle('plugin.unloaded', { id: item.id, contentHash: item.hash, reason }, keyOf(item.id, item.hash));
    await this.supervisor.stopAll(reason);
    for (const instance of this.instances.values()) this.revokeContributions(instance);
    this.instances.clear();
  }

  /**
   * 热生命周期事件入口（由宿主的事件写入点转手）。
   *
   * 只认 `plugin/enabled` 与 `plugin/disabled`：uninstall 在删目录**之前**由 manager 的
   * 同步钩子调 `killForUninstall`，走不到这里。
   */
  onLifecycleEvent(type: string, data: Record<string, unknown>): void {
    if (type !== 'plugin/enabled' && type !== 'plugin/disabled') return;
    const id = typeof data['id'] === 'string' ? data['id'] : '';
    const hash = typeof data['contentHash'] === 'string' ? data['contentHash'] : '';
    if (id === '' || hash === '') return;
    if (type === 'plugin/enabled') {
      const pkg = this.options.bridge.packageOf(id, hash);
      if (pkg === null) {
        this.options.write(`[插件] 收到 ${id}@${hash.slice(0, 8)} 的启用事件，但找不到这个包`);
        return;
      }
      void this.startPackage(pkg).catch((error: unknown) => {
        this.options.write(`[插件] ${id} 热启动失败：${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    void this.stopPackage(id, hash, 'disable').catch((error: unknown) => {
      this.options.write(`[插件] ${id} 热停止失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** 启动时把"日志里已启用"的代码插件拉起来 */
  async startEnabled(packages: readonly PluginPackage[]): Promise<void> {
    for (const pkg of packages) {
      if (pkg.manifest.runtime.type === 'declarative') continue;
      try {
        await this.startPackage(pkg);
      } catch (error) {
        this.options.write(`[插件] ${pkg.manifest.id} 未能启动：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // ── 状态 ──

  status(id: string, contentHash: string): PluginRuntimeStatus & { type: string; entry: string | null } {
    const instance = this.instances.get(keyOf(id, contentHash));
    const runtime = this.supervisor.status(id, contentHash);
    return {
      type: instance?.runtime.type ?? 'declarative',
      entry: instance?.runtime.entry ?? null,
      ...(runtime ?? {
        state: 'stopped' as const, pid: null, startedAt: 0, uptimeMs: 0, restarts: 0, lastExit: null,
      }),
    };
  }

  hasRunning(): boolean {
    return this.instances.size > 0;
  }

  // ── 钩子分发 ──

  async dispatchHook(point: PluginHookPoint, payload: Record<string, unknown>): Promise<PluginHookOutcome> {
    if (this.instances.size === 0) return EMPTY_HOOK_OUTCOME;
    const result = await this.invokeHook(point, payload);
    return this.hookOutcomeOf(result);
  }

  /**
   * 走命名注册表分发一次。
   *
   * 这里只做三件宿主才能做的事：找出订阅者对应的进程、把调用送进去、按贡献记账。
   * 顺序/超时/abort/errorPolicy 全在 `HookRegistry`（单元测试可脱离进程直接验它）。
   * `account=false` 给生命周期通知用：它们是通知，失败不参与贡献隔离（与 P1a 一致）。
   */
  private async invokeHook(
    point: PluginHookPoint,
    payload: Record<string, unknown>,
    options: { excludeKeys?: readonly string[]; account?: boolean } = {},
  ): Promise<HookInvokeResult> {
    const excluded = new Set(options.excludeKeys ?? []);
    return await this.hookRegistry.invoke(point, payload, {
      available: (subscription) => {
        const key = keyOf(subscription.pluginId, subscription.contentHash);
        if (excluded.has(key)) return false;
        const instance = this.instances.get(key);
        if (instance === undefined) return false;
        if (instance.isolated.has(`hook:${point}`)) return false;
        return this.supervisor.get(instance.id, instance.contentHash) !== null;
      },
      call: async (subscription: HookSubscription, stepPayload, timeoutMs) => {
        const key = keyOf(subscription.pluginId, subscription.contentHash);
        const instance = this.instances.get(key);
        if (instance === undefined) throw new Error(`插件 ${subscription.pluginId} 已不在运行面`);
        const process = this.supervisor.get(instance.id, instance.contentHash);
        if (process === null) throw new Error(`插件 ${subscription.pluginId} 的进程当前没有运行`);
        return await process.request('hook.invoke', {
          point,
          subscriptionId: subscription.subscriptionId,
          payload: stepPayload,
        }, timeoutMs);
      },
      ...(point === 'command.before'
        ? {
          // 新点的 args 按 blocking 串行链下去：后一个处理器看到前一个改过的参数。
          // 旧 14 点不传这个回调，保持"每个处理器看原始载荷 + 第一个修改生效"的既有语义。
          nextPayload: (_subscription: HookSubscription, current: Record<string, unknown>, result: unknown) => {
            if (result === null || typeof result !== 'object' || Array.isArray(result)) return undefined;
            const args = (result as Record<string, unknown>)['args'];
            if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
            return { ...current, args };
          },
        }
        : {}),
      ...(options.account === false ? {} : {
        settle: (subscription: HookSubscription, event: { ok: boolean; error?: Error }) => {
          const instance = this.instances.get(keyOf(subscription.pluginId, subscription.contentHash));
          if (instance === undefined) return;
          if (event.ok) this.noteContributionSuccess(instance, `hook:${point}`);
          else this.noteContributionFailure(instance, `hook:${point}`, event.error ?? new Error('钩子处理器失败'), 'hook');
        },
      }),
      log: (line) => { this.options.write(line); },
    });
  }

  /** 注册表结果 → 既有 `PluginHookOutcome`（字段语义与 P1a 的逐个 if 完全一致） */
  private hookOutcomeOf(result: HookInvokeResult): PluginHookOutcome {
    const results: PluginHookResult[] = [];
    let systemSuffix = '';
    let text: string | null = null;
    const extraMedia: PluginOutboundMedia[] = [];
    let updatedResult: { content?: string; isError?: boolean } | null = null;
    let updatedInput: unknown;
    let updatedArgs: unknown;
    let additionalContext = '';

    for (const item of result.results) {
      const subscription = item.subscription;
      const instance = this.instances.get(keyOf(subscription.pluginId, subscription.contentHash));
      if (instance === undefined) continue;
      results.push({ pluginId: instance.id, contentHash: instance.contentHash, result: item.result });
      // observe 是只读的：结果只进 results 供诊断，不许改载荷/补上下文。
      if (subscription.mode !== 'blocking') continue;
      const record = item.result !== null && typeof item.result === 'object' && !Array.isArray(item.result)
        ? item.result as Record<string, unknown>
        : null;
      if (record === null) continue;
      if (result.point === 'model.request' && typeof record['systemSuffix'] === 'string' && systemSuffix === '') {
        systemSuffix = record['systemSuffix'].slice(0, 4_000);
      }
      if (result.point === 'reply.decorate') {
        if (typeof record['text'] === 'string' && text === null) text = record['text'].slice(0, 20_000);
        if (Array.isArray(record['media'])) {
          for (const raw of record['media'].slice(0, 4) as unknown[]) {
            try {
              const parsed = parseOutboundMedia(raw);
              if (parsed !== null) extraMedia.push(absolutizeMedia(instance, parsed));
            } catch (error) {
              this.options.write(`[插件] ${instance.id} 的 reply.decorate 附加媒体被拒：${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      }
      if (result.point === 'tool.before' && updatedInput === undefined && record['input'] !== undefined) {
        updatedInput = record['input'];
      }
      if (result.point === 'tool.after' && updatedResult === null) {
        const content = record['content'];
        const isError = record['isError'];
        if (typeof content === 'string' || typeof isError === 'boolean') updatedResult = {
          ...(typeof content === 'string' ? { content: content.slice(0, 200_000) } : {}),
          ...(typeof isError === 'boolean' ? { isError } : {}),
        };
      }
      if (result.point === 'command.before' && record['args'] !== null
        && typeof record['args'] === 'object' && !Array.isArray(record['args'])) {
        // 与 nextPayload 的链式语义一致：最后一个**合法对象**是最终 args；非法形状不覆盖前一个。
        updatedArgs = record['args'];
      }
      if (typeof record['additionalContext'] === 'string' && record['additionalContext'] !== '') {
        additionalContext = additionalContext === '' ? record['additionalContext'].slice(0, 10_000) : `${additionalContext}\n\n${record['additionalContext'].slice(0, 10_000)}`;
      }
    }

    if (result.failed) {
      // errorPolicy=ABORT 是"整点失败"：不把失败前的半截修改交给调用方（结果仍留在 results 供诊断）。
      return {
        results, systemSuffix: '', text: null, extraMedia: [], updatedResult: null,
        updatedInput: undefined, updatedArgs: undefined, additionalContext: '',
        abortedBy: result.abortedBy, failed: true, error: result.error,
      };
    }
    return {
      results, systemSuffix, text, extraMedia, updatedResult, updatedInput, updatedArgs, additionalContext,
      abortedBy: result.abortedBy, failed: false, error: null,
    };
  }

  /**
   * `tool.before`：交给 `HookRunner` 的插件挂点。返回 null = 没有改动。
   * 只允许"追加"（改参数 / 补上下文），拒绝语义仍然只属于外部进程钩子。
   */
  async tapToolBefore(request: { callId: string; tool: string; input: unknown; turn: number; step: number }): Promise<{ decision: 'allow'; updatedInput?: unknown; additionalContext?: string } | null> {
    if (!this.hasHook('tool.before')) return null;
    const outcome = await this.dispatchHook('tool.before', { ...request });
    if (outcome.updatedInput === undefined && outcome.additionalContext === '') return null;
    return {
      decision: 'allow',
      ...(outcome.updatedInput === undefined ? {} : { updatedInput: outcome.updatedInput }),
      ...(outcome.additionalContext === '' ? {} : { additionalContext: outcome.additionalContext }),
    };
  }

  /**
   * `tool.after`：语义钉死为**"结果已经产生、还没喂回模型之前"**（等价 astrbot 的
   * `on_llm_tool_respond`）。可以改写正文与错误标记。
   */
  async tapToolAfter(
    request: { callId: string; tool: string; input: unknown; turn: number; step: number },
    result: { status: string; isError: boolean; content: string; durationMs: number },
  ): Promise<{ decision: 'allow'; updatedResult?: { content?: string; isError?: boolean }; additionalContext?: string } | null> {
    if (!this.hasHook('tool.after')) return null;
    const outcome = await this.dispatchHook('tool.after', { ...request, result: { ...result } });
    if (outcome.updatedResult === null && outcome.additionalContext === '') return null;
    return {
      decision: 'allow',
      ...(outcome.updatedResult === null ? {} : { updatedResult: outcome.updatedResult }),
      ...(outcome.additionalContext === '' ? {} : { additionalContext: outcome.additionalContext }),
    };
  }

  /** model.request：内联等待（最多 2s），返回要追加到系统指令末尾的文本 */
  async modelRequestSuffix(request: { lane?: string; model?: string; instructions?: string }): Promise<string> {
    if (!this.hasHook('model.request')) return '';
    const outcome = await this.dispatchHook('model.request', {
      ...(request.lane === undefined ? {} : { lane: request.lane }),
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
    });
    return outcome.systemSuffix;
  }

  /**
   * model.response：**不 await**（响应已经在手里，插件只做旁路观察/记账）。
   *
   * 如果哪个插件想因为响应而发消息，它走 `ctx.chat.send`，那条路有自己的预算与通道判定。
   */
  noteModelResponse(response: unknown): void {
    if (!this.hasHook('model.response')) return;
    const record = response !== null && typeof response === 'object' ? response as Record<string, unknown> : {};
    const usage = record['usage'] !== null && typeof record['usage'] === 'object' ? record['usage'] as Record<string, unknown> : {};
    const text = Array.isArray(record['outputItems'])
      ? (record['outputItems'] as unknown[])
        .map((item) => item !== null && typeof item === 'object' && (item as Record<string, unknown>)['type'] === 'message' ? String((item as Record<string, unknown>)['text'] ?? '') : '')
        .join('')
      : '';
    void this.dispatchHook('model.response', {
      model: typeof record['model'] === 'string' ? record['model'] : '',
      status: typeof record['status'] === 'string' ? record['status'] : '',
      text: text.slice(0, 20_000),
      usage: {
        inputTokens: Number(usage['inputTokens'] ?? 0),
        outputTokens: Number(usage['outputTokens'] ?? 0),
      },
    }).catch((error: unknown) => {
      this.options.write(`[插件] model.response 钩子出错：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** turn.start / turn.end 的观察口（事件驱动：**不阻塞** turn） */
  noteTurn(point: 'turn.start' | 'turn.end', payload: Record<string, unknown>): void {
    if (!this.hasHook(point)) return;
    void this.dispatchHook(point, payload).catch((error: unknown) => {
      this.options.write(`[插件] ${point} 钩子出错：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** 出站文本的装饰口（`reply.decorate`）：返回替换后的正文与附加媒体 */
  async decorateReply(input: { channel?: string; chatId?: string; text: string }): Promise<{ text: string; extraMedia: PluginOutboundMedia[] }> {
    if (!this.hasHook('reply.decorate')) return { text: input.text, extraMedia: [] };
    const outcome = await this.dispatchHook('reply.decorate', { ...input });
    return { text: outcome.text ?? input.text, extraMedia: outcome.extraMedia };
  }

  /** 真正发出去之后（`message.sent`）。**不 await**：发送已经发生，钩子不能拖慢或回滚它 */
  noteMessageSent(input: { channel: string; chatId: string; ok: boolean; text?: string }): void {
    if (!this.hasHook('message.sent')) return;
    void this.dispatchHook('message.sent', { ...input }).catch((error: unknown) => {
      this.options.write(`[插件] message.sent 钩子出错：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  hasHook(point: PluginHookPoint): boolean {
    if (point === 'message.received') return this.hasInboundSubscriptions();
    for (const subscription of this.hookRegistry.list(point)) {
      const instance = this.instances.get(keyOf(subscription.pluginId, subscription.contentHash));
      if (instance === undefined) continue;
      if (instance.isolated.has(`hook:${point}`)) continue;
      if (this.supervisor.get(instance.id, instance.contentHash) !== null) return true;
    }
    return false;
  }

  // ── 入站消息（P1b：宿主侧过滤 + 串行回调） ──

  /** 有没有任何 `message.received` 订阅（没有就走原来的同步落库路，零开销） */
  hasInboundSubscriptions(): boolean {
    if (this.messageSubscriptions.length === 0) return false;
    for (const entry of this.messageSubscriptions) {
      if (entry.instance.isolated.has('hook:message.received')) continue;
      if (entry.instance.isolated.has(`hook:message.received:${entry.subscriptionId}`)) continue;
      if (this.supervisor.get(entry.instance.id, entry.instance.contentHash) !== null) return true;
    }
    return false;
  }

  /** 有没有注册任何聊天指令 */
  hasCommands(): boolean {
    return this.commandsById.size > 0;
  }

  /**
   * 跑一遍 `message.received`（**同名钩子按注册顺序串行**）。
   *
   * 三条语义：
   *   ① 过滤在宿主侧做：不匹配的订阅根本不会被回调，插件拿到的只有"已过滤后的那一条"；
   *   ② 后面看到的是前面改写后的正文（`text` 链式传递）；
   *   ③ **任何单条订阅失败（超时/报错）都只影响它自己**：不 throw、不丢消息，原样继续下一条。
   *
   * 每次回调都用 `hookMs`（默认 2s）超时；连续 3 次失败按贡献隔离（沿用 P1a 的口径）。
   */
  async dispatchMessageReceived(input: PluginMessageReceivedPayload): Promise<PluginMessageHookOutcome> {
    let text = input.text;
    let drop = false;
    let additionalContext = '';
    let matched = 0;
    const ordered = [...this.messageSubscriptions].sort((left, right) =>
      HOOK_ORDER_WEIGHT[left.order] - HOOK_ORDER_WEIGHT[right.order] || left.seq - right.seq);
    for (const entry of ordered) {
      const instance = entry.instance;
      if (instance.isolated.has('hook:message.received')) continue;
      if (instance.isolated.has(`hook:message.received:${entry.subscriptionId}`)) continue;
      const process = this.supervisor.get(instance.id, instance.contentHash);
      if (process === null) continue;
      try {
        if (!await matchesMessageFilter(entry.filter, input, text, this.options.isOwnerMessage)) continue;
        matched += 1;
        const result = await process.request('hook.invoke', {
          point: 'message.received',
          subscriptionId: entry.subscriptionId,
          payload: { ...input, text },
        }, entry.timeoutMs);
        this.noteContributionSuccess(instance, `hook:message.received:${entry.subscriptionId}`);
        const record = result !== null && typeof result === 'object' && !Array.isArray(result)
          ? result as Record<string, unknown>
          : null;
        if (record === null) continue;
        if (record['drop'] === true) {
          drop = true;
          break;
        }
        if (typeof record['text'] === 'string') text = record['text'].slice(0, 20_000);
        if (typeof record['additionalContext'] === 'string' && record['additionalContext'] !== '') {
          additionalContext = additionalContext === ''
            ? record['additionalContext'].slice(0, 10_000)
            : `${additionalContext}\n\n${record['additionalContext'].slice(0, 10_000)}`;
        }
      } catch (error) {
        this.noteContributionFailure(instance, `hook:message.received:${entry.subscriptionId}`, error, 'hook');
        if (entry.errorPolicy === 'LOG') {
          this.options.write(`[插件] message.received 的订阅 ${entry.subscriptionId}（插件 ${instance.id}）失败（errorPolicy=LOG，跳过继续）：${error instanceof Error ? error.message : String(error)}`);
        }
        if (entry.errorPolicy === 'ABORT') {
          this.options.write(`[插件] message.received 的订阅 ${entry.subscriptionId}（插件 ${instance.id}）失败且 errorPolicy=ABORT，停止本次过滤链（消息不丢，按当前正文继续）`);
          break;
        }
      }
    }
    return { text, drop, additionalContext, matched };
  }

  // ── 聊天指令（P1b） ──

  /**
   * 尝试把一条消息当聊天指令处理。返回 null = **没命中**（调用方照常走原有流程）。
   *
   * 命中之后的五种结局都写在这里：
   *   · 非用户打 `admin` 指令 → 宿主回一句"只有用户可以使用"，**不进上下文**；
   *   · 参数不合 schema → 宿主回宿主自己的用法文案，**不进上下文**；
   *   · `command.before` 返回 abort / 该点整体失败 → **不执行 handler、不回话**，返回 null，
   *     调用方按"未命中指令"继续原有流程（唤醒/信箱）；handler 与 command.after 都不跑；
   *   · handler 正常返回 → 回它给的文本/媒体，`keepInContext` 决定要不要继续进上下文；
   *   · handler 报错/超时 → 回一句宿主文案（不泄露插件内部细节），**不进上下文**。
   */
  async runCommand(input: { text: string; message: PluginMessageReceivedPayload }): Promise<PluginCommandOutcome | null> {
    if (this.commandsById.size === 0) return null;
    const invocation = parseCommandInvocation(input.text);
    if (invocation === null) return null;
    const entry = this.commandNames.get(invocation.word);
    if (entry === undefined) return null;
    if (entry.permission === 'admin' && this.options.isOwnerMessage?.(input.message) !== true) {
      return {
        matched: true, command: entry.name, keepInContext: false,
        reply: { text: `只有用户可以使用 /${entry.name}。` },
      };
    }
    const parsed = parseCommandArgs(entry.args, invocation.rest);
    if (parsed.error !== null) {
      return {
        matched: true, command: entry.name, keepInContext: false,
        reply: { text: `${parsed.error}。${commandUsageOf(entry)}` },
      };
    }
    const process = this.supervisor.get(entry.instance.id, entry.instance.contentHash);
    if (process === null) {
      return {
        matched: true, command: entry.name, keepInContext: false,
        reply: { text: `/${entry.name} 所属的插件进程当前没有运行，指令暂时不可用。` },
      };
    }

    // `command.before`：正式执行前。abort / errorPolicy=ABORT 都按"未命中指令"返回 null——
    // 不回任何话，让 InboundPipeline 继续原有分流（不是静默吞掉一条消息）。
    let before: PluginHookOutcome;
    try {
      before = await this.dispatchHook('command.before', {
        command: entry.name,
        args: parsed.args,
        text: input.text,
        message: input.message,
      });
    } catch (error) {
      this.options.write(`[插件] command.before 分发异常（指令 /${entry.name} 不执行）：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (before.abortedBy !== null) {
      this.options.write(`[插件] 指令 /${entry.name} 被插件 ${before.abortedBy.pluginId} 在 command.before 中止${before.abortedBy.reason === null ? '' : `（${before.abortedBy.reason}）`}；按未命中指令继续原有流程`);
      return null;
    }
    if (before.failed) {
      this.options.write(`[插件] command.before 整体失败（${before.error ?? '未知原因'}），指令 /${entry.name} 不执行；按未命中指令继续原有流程`);
      return null;
    }
    let args: Record<string, unknown> = parsed.args;
    if (before.updatedArgs !== undefined) {
      if (before.updatedArgs !== null && typeof before.updatedArgs === 'object' && !Array.isArray(before.updatedArgs)) {
        // 参数改写是插件自己的声明；仍要求是对象，避免把数组/标量塞进 handler。
        args = before.updatedArgs as Record<string, unknown>;
      } else {
        this.options.write(`[插件] command.before 返回的 args 不是对象，已忽略（指令 /${entry.name} 用原参数执行）`);
      }
    }

    const startedAt = this.now();
    try {
      const result = await process.request('command.invoke', {
        commandId: entry.commandId,
        args,
        message: input.message,
      }, this.timeouts.toolMs);
      this.noteContributionSuccess(entry.instance, `command:${entry.commandId}`);
      const outcome = this.commandOutcomeOf(entry, result);
      this.noteCommandAfter({
        command: entry.name,
        ok: true,
        durationMs: Math.max(0, this.now() - startedAt),
        keepInContext: outcome.keepInContext,
        args,
        message: input.message,
      });
      return outcome;
    } catch (error) {
      this.noteContributionFailure(entry.instance, `command:${entry.commandId}`, error, 'command');
      const message = error instanceof Error ? error.message : String(error);
      this.options.write(`[插件] 指令 /${entry.name} 执行失败：${message}`);
      this.noteCommandAfter({
        command: entry.name,
        ok: false,
        durationMs: Math.max(0, this.now() - startedAt),
        keepInContext: false,
        args,
        message: input.message,
        error: message,
      });
      return {
        matched: true, command: entry.name, keepInContext: false,
        reply: { text: `/${entry.name} 执行失败，请稍后再试。` },
        error: message,
      };
    }
  }

  private commandOutcomeOf(entry: CommandEntry, result: unknown): PluginCommandOutcome {
    if (result === undefined || result === null) return { matched: true, command: entry.name, keepInContext: false, reply: null };
    if (typeof result === 'string') {
      return { matched: true, command: entry.name, keepInContext: false, reply: { text: result.slice(0, 10_000) } };
    }
    if (typeof result !== 'object' || Array.isArray(result)) {
      return { matched: true, command: entry.name, keepInContext: false, reply: null };
    }
    const record = result as Record<string, unknown>;
    const reply: { text?: string; media?: PluginOutboundMedia } = {};
    if (typeof record['text'] === 'string' && record['text'] !== '') reply.text = record['text'].slice(0, 10_000);
    if (record['media'] !== undefined) {
      try {
        const media = parseOutboundMedia(record['media']);
        if (media !== null) reply.media = absolutizeMedia(entry.instance, media);
      } catch (error) {
        this.options.write(`[插件] 指令 /${entry.name} 的媒体被拒：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      matched: true,
      command: entry.name,
      keepInContext: record['keepInContext'] === true,
      reply: reply.text === undefined && reply.media === undefined ? null : reply,
    };
  }

  // ── 两个 P1b 小钩子（fire-and-forget，不阻塞调用方） ──

  /** `model.waiting`：请求已发出、正在等模型。**不 await**（UX 信号，不许拖慢模型调用） */
  noteModelWaiting(payload: { lane?: string; model?: string }): void {
    if (!this.hasHook('model.waiting')) return;
    void this.dispatchHook('model.waiting', { ...payload, at: new Date(this.now()).toISOString() }).catch((error: unknown) => {
      this.options.write(`[插件] model.waiting 钩子出错：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** `channel.ready`：某条通道适配器连上（断线重连会再次调用）。**不 await** */
  noteChannelReady(payload: { channel: string }): void {
    if (!this.hasHook('channel.ready')) return;
    void this.dispatchHook('channel.ready', { ...payload, at: new Date(this.now()).toISOString() }).catch((error: unknown) => {
      this.options.write(`[插件] channel.ready 钩子出错：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * `host.ready`：宿主就绪后**一次**（observe；给插件做启动探测）。
   *
   * 一次性由宿主持有：重复调用（或多条启动路径）不会让插件收到第二遍。即使触发时没有
   * 任何订阅，也用同一个标记记下来——"宿主已经就绪过"是事实，不该因为当时没人听就忘掉。
   */
  noteHostReady(payload: Record<string, unknown> = {}): void {
    if (this.hostReadyFired) return;
    this.hostReadyFired = true;
    if (!this.hasHook('host.ready')) return;
    void this.dispatchHook('host.ready', {
      ...payload,
      at: new Date(this.now()).toISOString(),
    }).catch((error: unknown) => {
      this.options.write(`[插件] host.ready 钩子出错：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** `command.after`：指令 handler 已返回/已失败（observe，不阻塞回话） */
  private noteCommandAfter(payload: {
    command: string;
    ok: boolean;
    durationMs: number;
    keepInContext: boolean;
    args: Record<string, unknown>;
    message: PluginMessageReceivedPayload;
    error?: string;
  }): void {
    if (!this.hasHook('command.after')) return;
    void this.dispatchHook('command.after', {
      command: payload.command,
      ok: payload.ok,
      durationMs: payload.durationMs,
      keepInContext: payload.keepInContext,
      args: payload.args,
      message: payload.message,
      ...(payload.error === undefined ? {} : { error: payload.error }),
      at: new Date(this.now()).toISOString(),
    }).catch((error: unknown) => {
      this.options.write(`[插件] command.after 钩子出错：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  // ── 工具调用（宿主 → 插件） ──

  private async invokeTool(instance: PluginInstance, localName: string, args: unknown): Promise<ToolHandlerResult> {
    const process = this.supervisor.get(instance.id, instance.contentHash);
    if (process === null) return errorResult(`插件 ${instance.id} 的进程当前没有运行`, 'E_PLUGIN_STOPPED');
    try {
      const result = await process.request('tool.invoke', { name: localName, args }, this.timeouts.toolMs);
      this.noteContributionSuccess(instance, `tool:${localName}`);
      return normalizeToolResult(result);
    } catch (error) {
      const category = error instanceof PluginRpcError && error.category === 'timeout' ? 'timeout' : 'business';
      this.noteContributionFailure(instance, `tool:${localName}`, error, 'tool');
      // 工具超时：JS 拦不住死循环，唯一可靠的处置是杀进程（运行层按自己的冷却拉起来）
      if (category === 'timeout') process.kill('timeout');
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(`插件工具 ${localName} 失败：${message}`, category === 'timeout' ? 'E_TIMEOUT' : 'E_PLUGIN_TOOL');
    }
  }

  // ── 内部：实例与处理器 ──

  private buildInstance(pkg: PluginPackage): PluginInstance {
    const manifest = pkg.manifest;
    if (manifest.runtime.type === 'declarative') throw new Error('declarative 包没有进程');
    const dataDir = pluginDataDir(this.options.dataDir, manifest.id);
    mkdirSync(dataDir, { recursive: true });
    if (manifest.apiVersion === 2) {
      // 版本升级共用一份数据目录；第一次启用时把默认配置也落一份可读的说明（P1b 的设置页读它）
      this.writeConfigDefaults(manifest, pkg);
    }
    const overrides = this.options.readConfigOverrides?.(manifest.id) ?? this.readConfigOverrides(manifest.id);
    const resolved = resolvePluginConfig(pkg.configSchema, overrides);
    for (const problem of resolved.problems) this.options.write(`[插件] ${manifest.id} 配置：${problem}`);
    return {
      id: manifest.id,
      contentHash: pkg.contentHash,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      rootDir: pkg.rootDir,
      dataDir,
      runtime: { type: manifest.runtime.type, entry: manifest.runtime.entry! },
      permissions: new Set(manifest.permissions),
      // `resolved.values` 已经是"schema 默认值 + 覆盖值"；`pkg.configDefaults` 只是它的底座。
      // 顺序写反过一次：默认值会盖掉人工覆盖值，而"设置页改了却不生效"是最难查的一类。
      config: { ...(pkg.configDefaults ?? {}), ...resolved.values },
      // 没写 net.allow = 空表 = 默认全拒（`parsePluginManifest` 已经保证这格永远存在）
      netAllow: manifest.netAllow,
      hooks: new Set<PluginHookPoint>(),
      tools: new Set<string>(),
      messageSubscriptions: new Map<string, MessageSubscriptionEntry>(),
      commands: new Map<string, PluginCommandDefinition>(),
      timers: new Map<string, TimerHandle>(),
      failureCounts: new Map<string, number>(),
      isolated: new Set<string>(),
    };
  }

  private writeConfigDefaults(manifest: PluginManifest, pkg: PluginPackage): void {
    if (manifest.config === undefined || pkg.configSchema === undefined) return;
    const dir = pluginConfigDir(this.options.dataDir, manifest.id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'README.txt');
    if (existsSync(path)) return;
    const lines = [
      `# ${manifest.id} 的配置覆盖值`,
      '',
      'P1a 只支持"读默认值 + 可选覆盖"：同目录下的 config.json（若存在）按下面这份 schema 校验后交给插件。',
      '设置页表单是 P1b 的工作。',
      '',
      'schema:',
      ...Object.entries(pkg.configSchema.properties).map(([key, property]) =>
        `  - ${key}: ${property.type}${property.default === undefined ? '' : ` = ${JSON.stringify(property.default)}`}${property.description === undefined ? '' : `  # ${property.description}`}`),
    ];
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  }

  private readConfigOverrides(pluginId: string): Record<string, unknown> {
    const path = join(pluginConfigDir(this.options.dataDir, pluginId), 'config.json');
    if (!existsSync(path)) return {};
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    } catch (error) {
      this.options.write(`[插件] ${pluginId} 的 config.json 读不出来，按默认值：${error instanceof Error ? error.message : String(error)}`);
      return {};
    }
  }

  private handlersOf(instance: PluginInstance): PluginProcessHandlers {
    return {
      onRequest: async (method, params) => await this.handleRequest(instance, method, params),
      onStderr: (line) => { this.options.write(`[插件 ${instance.id}] ${line}`); },
      onProtocolProblem: (message, line) => {
        this.options.write(`[插件 ${instance.id}] 协议问题：${message}（${line.slice(0, 200)}）`);
        this.options.bridge.recordFailure(instance.id, instance.contentHash, `协议问题：${message}`, 'protocol');
      },
    };
  }

  private requirePermission(instance: PluginInstance, permission: PluginPermission | null, method: string): void {
    if (permission === null) return;
    if (instance.permissions.has(permission)) return;
    throw permissionDeniedError(instance.id, permission, method);
  }

  private async handleRequest(instance: PluginInstance, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'tool.register': return this.registerTool(instance, params);
      case 'hook.subscribe': return this.subscribeHook(instance, params);
      case 'log.write': return this.writeLog(instance, params);
      case 'state.get': return this.stateGet(instance, params);
      case 'state.set': return this.stateSet(instance, params);
      case 'files.read': return this.filesRead(instance, params);
      case 'files.write': return this.filesWrite(instance, params);
      case 'files.list': return this.filesList(instance, params);
      case 'chat.send': return this.chatSend(instance, params);
      case 'chat.read': return this.chatRead(instance, params);
      case 'model.complete': return this.modelComplete(instance, params);
      case 'timer.every': return this.timerEvery(instance, params);
      case 'timer.cron': return this.timerCron(instance, params);
      case 'timer.cancel': return this.timerCancel(instance, params);
      case 'net.fetch': return await this.netFetch(instance, params);
      case 'command.define': return this.defineCommand(instance, params);
      case 'config.get': return { config: instance.config };
      default:
        throw new PluginRpcError(PLUGIN_RPC_ERRORS.methodNotFound, `宿主不认识方法 ${method}`, 'protocol');
    }
  }

  /**
   * `ctx.commands.define`：注册一条聊天指令。
   *
   * 冲突策略是**后者拒绝**（不静默覆盖）：同名/同别名被别的插件或宿主内置指令占用时，
   * 这一条 `command.define` 直接失败，插件作者当场看得见。宿主内置指令永远赢。
   */
  private defineCommand(instance: PluginInstance, params: unknown): unknown {
    this.requirePermission(instance, 'commands.define', 'command.define');
    const body = asRecord(params, 'command.define');
    for (const key of Object.keys(body)) {
      if (key !== 'name' && key !== 'aliases' && key !== 'description' && key !== 'permission' && key !== 'args') {
        throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `command.define: 不支持的字段 ${key}`, 'protocol');
      }
    }
    const name = normalizeCommandName(body['name'], 'command.define.name');
    const rawAliases = body['aliases'];
    const aliases: string[] = [];
    if (rawAliases !== undefined) {
      if (!Array.isArray(rawAliases)) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, 'command.define.aliases: 必须是数组', 'protocol');
      if (rawAliases.length > MAX_COMMAND_ALIASES) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `command.define.aliases: 最多 ${MAX_COMMAND_ALIASES} 个`, 'protocol');
      for (const raw of rawAliases) {
        const alias = normalizeCommandName(raw, 'command.define.aliases');
        if (alias === name) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `command.define.aliases: 别名不能与指令名相同（${alias}）`, 'protocol');
        if (aliases.includes(alias)) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `command.define.aliases: 重复别名 ${alias}`, 'protocol');
        aliases.push(alias);
      }
    }
    const description = requiredText(body['description'], 'command.define.description', 500);
    const permission = body['permission'];
    if (permission !== 'admin' && permission !== 'all') {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, "command.define.permission: 只能是 'admin' 或 'all'", 'protocol');
    }
    const args = parseCommandArgsSchema(body['args'], 'command.define.args');
    this.commandSeq += 1;
    const commandId = `cmd-${this.commandSeq}`;
    const definition: CommandEntry = {
      commandId, pluginId: instance.id, contentHash: instance.contentHash,
      name, aliases, description, permission, args, instance,
    };
    for (const key of [name, ...aliases]) {
      if ((BUILTIN_COMMANDS as readonly string[]).includes(key)) {
        throw new PluginRpcError(PLUGIN_RPC_ERRORS.business, `指令 /${key} 与宿主内置指令重名，插件不能覆盖它`, 'business', { name: key });
      }
      const existing = this.commandNames.get(key);
      if (existing !== undefined) {
        const owner = existing.instance.id === instance.id ? '本插件' : `插件 ${existing.instance.id}`;
        throw new PluginRpcError(PLUGIN_RPC_ERRORS.business, `指令 /${key} 已被${owner}注册，拒绝覆盖（后注册者失败）`, 'business', { name: key, owner: existing.instance.id });
      }
    }
    this.commandsById.set(commandId, definition);
    for (const key of [name, ...aliases]) this.commandNames.set(key, definition);
    instance.commands.set(commandId, definition);
    this.options.write(`[插件] ${instance.id} 注册指令 /${name}${aliases.length === 0 ? '' : `（别名：${aliases.map((alias) => `/${alias}`).join(' ')}）`}权限=${permission}`);
    return { ok: true, commandId, name };
  }

  /**
   * `ctx.net.fetch`：权限门在这里，网络策略在 `net-fetch.ts`（白名单 / SSRF / 重定向 / 限额）。
   *
   * 日志由 net-fetch 统一写一条（含去 query 的 URL、status、耗时、拒绝原因）。
   */
  private async netFetch(instance: PluginInstance, params: unknown): Promise<unknown> {
    requireNetPermission(instance.id, instance.permissions);
    const body = asRecord(params, 'net.fetch');
    const url = requiredText(body['url'], 'net.fetch.url', 4_096);
    const label = `${instance.id}@${instance.contentHash.slice(0, 8)}`;
    return await pluginNetFetch({
      input: { url, ...(body['init'] === undefined ? {} : { init: body['init'] }) },
      allow: instance.netAllow,
      allowInsecureLoopbackHttp: this.options.netAllowInsecureLoopbackHttp === true,
      label,
      log: (line) => { this.options.write(`[插件 ${label}] ${line.replace(`${label} `, '')}`); },
      now: this.now,
    });
  }

  private registerTool(instance: PluginInstance, params: unknown): unknown {
    this.requirePermission(instance, 'tools.define', 'tool.register');
    const body = asRecord(params, 'tool.register');
    const localName = requiredText(body['name'], 'tool.register.name', 48);
    if (!/^[A-Za-z0-9_.-]+$/.test(localName)) {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, 'tool.register.name: 只能用字母、数字、下划线、点、短横线', 'protocol');
    }
    const exposed = `${instance.id}__${localName}`;
    if (exposed.length > 64) {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `工具名 ${exposed} 超过 64 字符：请缩短插件 id 或工具名`, 'protocol');
    }
    if (instance.isolated.has(`tool:${localName}`)) {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.isolated, `工具 ${localName} 因连续超时已被隔离；重新启用插件才会恢复`, 'business');
    }
    const description = requiredText(body['description'], 'tool.register.description', 1_000);
    const parameters = body['parameters'] === undefined ? { type: 'object', properties: {} } : body['parameters'];
    if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, 'tool.register.parameters: 必须是 JSON Schema 对象', 'protocol');
    }
    const sideEffectValue = body['sideEffect'];
    const sideEffect = sideEffectValue === 'none' || sideEffectValue === 'idempotent' || sideEffectValue === 'destructive'
      ? sideEffectValue
      : 'idempotent';
    const existing = instance.tools.has(localName);
    instance.tools.add(localName);
    const definition: ToolDefinition = {
      name: exposed,
      description,
      parameters: parameters as Record<string, unknown>,
      executionMode: 'exclusive',
      sideEffect,
      // 执行器的上限要比宿主那一道宽 2s：真正的超时判定在宿主（它会杀进程），
      // 执行器先超时的话，进程还挂着、而回执已经开始说"超时"，两边口径就分叉了。
      timeoutMs: this.timeouts.toolMs + 2_000,
      handler: async (args: unknown) => await this.invokeTool(instance, localName, args),
    };
    this.options.tools.register(definition);
    this.options.write(`[插件] ${instance.id} 注册工具 ${exposed}${existing ? '（覆盖同名）' : ''}`);
    return { ok: true, name: exposed };
  }

  /**
   * `hook.subscribe`：**声明期**校验（fail-fast）。
   *
   * 未知点 / 不允许的模式 / 不允许的 abort 意图 / 超限超时 / 不允许的 errorPolicy 都会在
   * 这一帧就被拒；权限仍在这里判（-32001）。`message.received` 额外要求一个过滤条件，
   * 并保持"一条订阅一个 filter"的既有模型。
   */
  private subscribeHook(instance: PluginInstance, params: unknown): unknown {
    const body = asRecord(params, 'hook.subscribe');
    const pointValue = body['point'];
    const configuredDefault = isPluginHookPoint(pointValue)
      ? defaultHookTimeoutMs(pointValue, this.timeouts.hookMs)
      : undefined;
    const normalized = normalizeHookSubscription(pointValue, body, 'hook.subscribe', {
      allowFilter: true,
      ...(configuredDefault === undefined ? {} : { defaultTimeoutMs: configuredDefault }),
    });
    const typed = normalized.point;
    this.requirePermission(instance, PLUGIN_HOOK_PERMISSIONS[typed], `hooks.on('${typed}')`);

    if (typed === 'message.received') {
      if (instance.isolated.has('hook:message.received')) {
        throw new PluginRpcError(PLUGIN_RPC_ERRORS.isolated, 'message.received 钩子因连续失败已被隔离；重新启用插件才会恢复', 'business');
      }
      if (instance.messageSubscriptions.size >= MAX_MESSAGE_SUBSCRIPTIONS_PER_PLUGIN) {
        throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `message.received 最多订阅 ${MAX_MESSAGE_SUBSCRIPTIONS_PER_PLUGIN} 条（每条一个过滤条件）`, 'protocol');
      }
      const filter = parseMessageFilter(body['filter']);
      this.subscriptionSeq += 1;
      const subscriptionId = `msg-${this.subscriptionSeq}`;
      const entry: MessageSubscriptionEntry = {
        subscriptionId,
        seq: this.subscriptionSeq,
        instance,
        filter,
        order: normalized.order,
        timeoutMs: normalized.timeoutMs,
        errorPolicy: normalized.errorPolicy,
      };
      instance.messageSubscriptions.set(subscriptionId, entry);
      this.messageSubscriptions.push(entry);
      instance.hooks.add(typed);
      return { ok: true, subscriptionId };
    }

    if (instance.isolated.has(`hook:${typed}`)) {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.isolated, `钩子 ${typed} 因连续失败已被隔离`, 'business');
    }
    this.hookSubscriptionSeq += 1;
    const subscriptionId = `hook-${this.hookSubscriptionSeq}`;
    this.hookRegistry.register({
      subscriptionId,
      pluginId: instance.id,
      contentHash: instance.contentHash,
      point: typed,
      mode: normalized.mode,
      order: normalized.order,
      timeoutMs: normalized.timeoutMs,
      errorPolicy: normalized.errorPolicy,
      abortIntent: normalized.abortIntent,
    });
    instance.hooks.add(typed);
    return { ok: true, subscriptionId };
  }

  private writeLog(instance: PluginInstance, params: unknown): unknown {
    const body = asRecord(params, 'log.write');
    const level = body['level'] === 'warn' || body['level'] === 'error' ? body['level'] : 'info';
    const message = body['message'] === undefined || body['message'] === null ? '' : String(body['message']).slice(0, 4_000);
    const extra = body['extra'];
    const suffix = extra === undefined ? '' : ` ${JSON.stringify(extra).slice(0, 1_000)}`;
    this.options.write(`[插件 ${instance.id}] [${level}] ${message}${suffix}`);
    return { ok: true };
  }

  // ── state ──

  private stateFile(instance: PluginInstance): string {
    mkdirSync(pluginStateDir(this.options.dataDir), { recursive: true });
    return join(pluginStateDir(this.options.dataDir), `${instance.id}.json`);
  }

  private readState(instance: PluginInstance): { plugin: Record<string, unknown>; sessions: Record<string, Record<string, unknown>> } {
    const path = this.stateFile(instance);
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { plugin: {}, sessions: {} };
      const record = raw as Record<string, unknown>;
      const plugin = record['plugin'] !== null && typeof record['plugin'] === 'object' && !Array.isArray(record['plugin']) ? record['plugin'] as Record<string, unknown> : {};
      const sessionsRaw = record['sessions'];
      const sessions: Record<string, Record<string, unknown>> = {};
      if (sessionsRaw !== null && typeof sessionsRaw === 'object' && !Array.isArray(sessionsRaw)) {
        for (const [key, value] of Object.entries(sessionsRaw)) {
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) sessions[key] = value as Record<string, unknown>;
        }
      }
      return { plugin, sessions };
    } catch {
      return { plugin: {}, sessions: {} };
    }
  }

  private writeState(instance: PluginInstance, state: { plugin: Record<string, unknown>; sessions: Record<string, Record<string, unknown>> }): void {
    const path = this.stateFile(instance);
    const text = JSON.stringify(state);
    if (text.length > 1024 * 1024) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, '插件状态超过 1MB，拒绝写入', 'protocol');
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, text, 'utf8');
    renameSync(temporary, path);
  }

  private stateGet(instance: PluginInstance, params: unknown): unknown {
    const body = asRecord(params, 'state.get');
    const scope = body['scope'];
    const key = requiredText(body['key'], 'state.get.key', 256);
    const state = this.readState(instance);
    if (scope === 'plugin') {
      this.requirePermission(instance, 'state.plugin', 'state.plugin.get');
      return { value: state.plugin[key] ?? null };
    }
    if (scope === 'session') {
      this.requirePermission(instance, 'state.session', 'state.session.get');
      const session = this.sessionId();
      return { value: state.sessions[session]?.[key] ?? null };
    }
    throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, 'state.get.scope: 只能是 plugin 或 session', 'protocol');
  }

  private stateSet(instance: PluginInstance, params: unknown): unknown {
    const body = asRecord(params, 'state.set');
    const scope = body['scope'];
    const key = requiredText(body['key'], 'state.set.key', 256);
    const value = body['value'];
    const serialized = JSON.stringify(value ?? null);
    if (serialized.length > 64 * 1024) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, 'state.set.value: 超过 64KB', 'protocol');
    const state = this.readState(instance);
    if (scope === 'plugin') {
      this.requirePermission(instance, 'state.plugin', 'state.plugin.set');
      if (value === undefined) delete state.plugin[key];
      else state.plugin[key] = value;
      this.writeState(instance, state);
      return { ok: true };
    }
    if (scope === 'session') {
      this.requirePermission(instance, 'state.session', 'state.session.set');
      const session = this.sessionId();
      const current = state.sessions[session] ?? {};
      if (value === undefined) delete current[key];
      else current[key] = value;
      state.sessions[session] = current;
      // 会话表设上限：插件不该因为长期运行把状态文件撑成日志
      const keys = Object.keys(state.sessions);
      if (keys.length > 200) {
        for (const stale of keys.slice(0, keys.length - 200)) delete state.sessions[stale];
      }
      this.writeState(instance, state);
      return { ok: true };
    }
    throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, 'state.set.scope: 只能是 plugin 或 session', 'protocol');
  }

  private sessionId(): string {
    const live = this.options.currentSessionId?.() ?? null;
    return live === null || live === '' ? 'default' : live;
  }

  // ── files ──

  private filesRead(instance: PluginInstance, params: unknown): unknown {
    this.requirePermission(instance, 'files', 'files.read');
    const body = asRecord(params, 'files.read');
    const path = resolveInside(instance.dataDir, body['path'], 'files.read.path');
    const encoding = body['encoding'] === 'base64' ? 'base64' : 'utf8';
    const stat = statSync(path);
    if (!stat.isFile()) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, 'files.read.path: 不是文件', 'protocol');
    if (stat.size > 1024 * 1024) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, 'files.read: 文件超过 1MB', 'protocol');
    return { data: readFileSync(path).toString(encoding === 'base64' ? 'base64' : 'utf8'), encoding };
  }

  private filesWrite(instance: PluginInstance, params: unknown): unknown {
    this.requirePermission(instance, 'files', 'files.write');
    const body = asRecord(params, 'files.write');
    const path = resolveInside(instance.dataDir, body['path'], 'files.write.path');
    const encoding = body['encoding'] === 'base64' ? 'base64' : 'utf8';
    const data = requiredText(body['data'], 'files.write.data', 1_400_000);
    const bytes = Buffer.from(data, encoding);
    if (bytes.length > 1024 * 1024) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, 'files.write: 写入超过 1MB', 'protocol');
    const dir = resolve(path, '..');
    mkdirSync(dir, { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, bytes);
    renameSync(temporary, path);
    return { bytes: bytes.length };
  }

  private filesList(instance: PluginInstance, params: unknown): unknown {
    this.requirePermission(instance, 'files', 'files.list');
    const body = params === undefined ? {} : asRecord(params, 'files.list');
    const raw = body['dir'];
    const dir = raw === undefined ? instance.dataDir : resolveInside(instance.dataDir, raw, 'files.list.dir');
    if (!existsSync(dir)) return { entries: [] };
    if (!statSync(dir).isDirectory()) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, 'files.list.dir: 不是目录', 'protocol');
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      .slice(0, 512)
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
        size: entry.isFile() ? statSync(join(dir, entry.name)).size : 0,
      }));
    return { entries };
  }

  // ── chat / model ──

  private async chatSend(instance: PluginInstance, params: unknown): Promise<unknown> {
    this.requirePermission(instance, 'chat.send', 'chat.send');
    const body = asRecord(params, 'chat.send');
    const text = optionalText(body['text'], 'chat.send.text', 10_000);
    const media = parseOutboundMedia(body['media']);
    if ((text === undefined || text === '') && media === null) {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, 'chat.send: text 与 media 至少要有一个', 'protocol');
    }
    if (this.options.sendChat === undefined) {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.unsupported, '宿主没有接线 chat.send（没有可用通道）', 'unsupported');
    }
    const outcome = await this.options.sendChat(this.viewOf(instance), {
      ...(text === undefined || text === '' ? {} : { text }),
      ...(media === null ? {} : { media: absolutizeMedia(instance, media) }),
    });
    if (!outcome.ok) throw new PluginRpcError(PLUGIN_RPC_ERRORS.business, `chat.send 失败：${outcome.reason}`, 'business');
    return { ok: true };
  }

  /** `chat.read`：读当前会话的最近消息（与 `read_channel` 同一个宿主口，只读） */
  private async chatRead(instance: PluginInstance, params: unknown): Promise<unknown> {
    this.requirePermission(instance, 'chat.read', 'chat.history');
    const body = params === undefined ? {} : asRecord(params, 'chat.read');
    const limitRaw = body['limit'];
    const limit = limitRaw === undefined ? 20 : limitRaw;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0 || limit > 200) {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, 'chat.history(limit): 1–200 的整数', 'protocol');
    }
    if (this.options.readChat === undefined) {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.unsupported, '宿主没有接线 chat.read（没有会话读取口）', 'unsupported');
    }
    return { messages: await this.options.readChat(this.viewOf(instance), { limit }) };
  }

  private async modelComplete(instance: PluginInstance, params: unknown): Promise<unknown> {
    this.requirePermission(instance, 'model.call', 'model.complete');
    const body = asRecord(params, 'model.complete');
    const tier = body['tier'] === 'heavy' ? 'heavy' : body['tier'] === 'light' ? 'light' : null;
    if (tier === null) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, "model.complete.tier: 只能是 'light' 或 'heavy'", 'protocol');
    const messagesRaw = body['messages'];
    if (!Array.isArray(messagesRaw) || messagesRaw.length === 0 || messagesRaw.length > 32) {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, 'model.complete.messages: 需要 1–32 条消息', 'protocol');
    }
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = messagesRaw.map((item, index) => {
      const message = asRecord(item, `model.complete.messages[${index}]`);
      const role = message['role'];
      if (role !== 'system' && role !== 'user' && role !== 'assistant') {
        throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `model.complete.messages[${index}].role: 只能是 system / user / assistant`, 'protocol');
      }
      return { role, content: requiredText(message['content'], `model.complete.messages[${index}].content`, 20_000) };
    });
    const maxTokensRaw = body['maxTokens'];
    if (maxTokensRaw !== undefined && (typeof maxTokensRaw !== 'number' || !Number.isInteger(maxTokensRaw) || maxTokensRaw <= 0 || maxTokensRaw > 8_000)) {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, 'model.complete.maxTokens: 1–8000 的整数', 'protocol');
    }
    if (this.options.completeModel === undefined) {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.unsupported, '宿主没有接线 model.complete（没有模型通道）', 'unsupported');
    }
    const reply = await this.options.completeModel(this.viewOf(instance), {
      tier,
      messages,
      ...(maxTokensRaw === undefined ? {} : { maxTokens: maxTokensRaw }),
    });
    return { text: reply.text, ...(reply.model === undefined ? {} : { model: reply.model }), ...(reply.usage === undefined ? {} : { usage: reply.usage }) };
  }

  // ── timers ──

  private timerEvery(instance: PluginInstance, params: unknown): unknown {
    this.requirePermission(instance, 'timers', 'timers.every');
    const body = asRecord(params, 'timers.every');
    const timerId = requiredText(body['timerId'], 'timers.every.timerId', 64);
    const intervalMs = parsePluginDuration(body['intervalMs'], 'timers.every.intervalMs');
    if (intervalMs < 1_000) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, 'timers.every: 最小 1s（避免插件把宿主变成忙等循环）', 'protocol');
    if (intervalMs > 24 * 3_600_000) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, 'timers.every: 最大 24h', 'protocol');
    this.cancelTimer(instance, timerId);
    const timer = setInterval(() => { this.fireTimer(instance, timerId); }, intervalMs);
    timer.unref();
    instance.timers.set(timerId, { kind: 'every', timer, spec: intervalMs });
    return { ok: true };
  }

  private timerCron(instance: PluginInstance, params: unknown): unknown {
    this.requirePermission(instance, 'timers', 'timers.cron');
    const body = asRecord(params, 'timers.cron');
    const timerId = requiredText(body['timerId'], 'timers.cron.timerId', 64);
    const expression = requiredText(body['expression'], 'timers.cron.expression', 120);
    const next = nextCronOccurrence(expression, new Date(this.now()));
    if (next === null) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `timers.cron: 表达式 ${expression} 在一年内没有下一次触发`, 'protocol');
    this.cancelTimer(instance, timerId);
    this.scheduleCron(instance, timerId, expression, next.getTime());
    return { ok: true };
  }

  private scheduleCron(instance: PluginInstance, timerId: string, expression: string, at: number): void {
    const delay = Math.max(1_000, at - this.now());
    const timer = setTimeout(() => {
      this.fireTimer(instance, timerId);
      if (!instance.timers.has(timerId)) return;
      const next = nextCronOccurrence(expression, new Date(this.now() + 1_000));
      if (next !== null) this.scheduleCron(instance, timerId, expression, next.getTime());
    }, delay);
    timer.unref();
    instance.timers.set(timerId, { kind: 'cron', timer, spec: expression });
  }

  private timerCancel(instance: PluginInstance, params: unknown): unknown {
    this.requirePermission(instance, 'timers', 'timers.cancel');
    const body = asRecord(params, 'timer.cancel');
    const timerId = requiredText(body['timerId'], 'timer.cancel.timerId', 64);
    this.cancelTimer(instance, timerId);
    return { ok: true };
  }

  private cancelTimer(instance: PluginInstance, timerId: string): void {
    const handle = instance.timers.get(timerId);
    if (handle === undefined) return;
    if (handle.kind === 'every') clearInterval(handle.timer);
    else clearTimeout(handle.timer);
    instance.timers.delete(timerId);
  }

  private fireTimer(instance: PluginInstance, timerId: string): void {
    const process = this.supervisor.get(instance.id, instance.contentHash);
    if (process === null) return;
    void process.request('timer.fire', { timerId }, this.timeouts.timerMs).then(
      () => { this.noteContributionSuccess(instance, `timer:${timerId}`); },
      (error: unknown) => {
        this.noteContributionFailure(instance, `timer:${timerId}`, error, 'timer');
      },
    );
  }

  // ── 贡献故障计数 / 隔离 ──

  private noteContributionSuccess(instance: PluginInstance, contribution: string): void {
    instance.failureCounts.delete(contribution);
    instance.isolated.delete(contribution);
  }

  /**
   * 一次贡献级失败。连续 3 次 → **隔离这一条**（工具撤注册 / 钩子退订 / 定时器停掉），
   * 进程照旧活着：隔离的粒度是贡献，不是整包（设计稿的裁决）。
   */
  private noteContributionFailure(instance: PluginInstance, contribution: string, error: unknown, kind: 'tool' | 'hook' | 'timer' | 'command'): void {
    if (instance.isolated.has(contribution)) return;
    const count = (instance.failureCounts.get(contribution) ?? 0) + 1;
    instance.failureCounts.set(contribution, count);
    const category: PluginFailureCategory = error instanceof PluginRpcError && error.category === 'timeout'
      ? (kind === 'hook' ? 'hook-timeout' : 'timeout')
      : (kind === 'hook' ? 'hook-error' : 'business');
    const message = error instanceof Error ? error.message : String(error);
    this.options.write(`[插件] ${instance.id} 的贡献 ${contribution} 第 ${count} 次失败（${category}）：${message}`);
    this.options.bridge.recordFailure(instance.id, instance.contentHash, `${contribution} 失败（${category}）：${message}`, category);
    if (count < CONTRIBUTION_ISOLATION_THRESHOLD) return;
    instance.isolated.add(contribution);
    instance.failureCounts.delete(contribution);
    this.revokeContribution(instance, contribution, kind);
    this.options.emit('plugin/contribution-isolated', {
      id: instance.id, contentHash: instance.contentHash,
      contributionKind: kind === 'timer' || kind === 'command' ? 'hook' : kind,
      contributionName: contribution,
      category, count, reason: message, at: new Date(this.now()).toISOString(),
    });
    this.options.write(`[插件] ${instance.id} 的贡献 ${contribution} 连续 ${CONTRIBUTION_ISOLATION_THRESHOLD} 次失败，已隔离该贡献（插件其余能力不受影响）`);
  }

  private revokeContribution(instance: PluginInstance, contribution: string, kind: 'tool' | 'hook' | 'timer' | 'command'): void {
    if (kind === 'tool') {
      const localName = contribution.slice('tool:'.length);
      instance.tools.delete(localName);
      this.options.tools.unregister(`${instance.id}__${localName}`);
      return;
    }
    if (kind === 'timer') {
      this.cancelTimer(instance, contribution.slice('timer:'.length));
      return;
    }
    if (kind === 'command') {
      this.removeCommand(contribution.slice('command:'.length));
      return;
    }
    if (contribution.startsWith('hook:message.received:')) {
      // 一条入站订阅被隔离：撤掉这条订阅，并给整条 message.received 线打上"已隔离"标记
      // ——否则插件只要重新 subscribe 就能绕开隔离（连续失败 3 次的意义就没了）。
      const subscriptionId = contribution.slice('hook:message.received:'.length);
      instance.messageSubscriptions.delete(subscriptionId);
      this.messageSubscriptions = this.messageSubscriptions.filter((entry) => entry.subscriptionId !== subscriptionId);
      instance.isolated.add('hook:message.received');
      if (instance.messageSubscriptions.size === 0) instance.hooks.delete('message.received');
      return;
    }
    const point = contribution.slice('hook:'.length) as PluginHookPoint;
    this.hookRegistry.removePoint(instance.id, instance.contentHash, point);
    instance.hooks.delete(point);
  }

  private removeCommand(commandId: string): void {
    const entry = this.commandsById.get(commandId);
    if (entry === undefined) return;
    this.commandsById.delete(commandId);
    for (const key of [entry.name, ...entry.aliases]) {
      if (this.commandNames.get(key) === entry) this.commandNames.delete(key);
    }
    entry.instance.commands.delete(commandId);
  }

  private revokeContributions(instance: PluginInstance): void {
    for (const localName of instance.tools) this.options.tools.unregister(`${instance.id}__${localName}`);
    instance.tools.clear();
    for (const timerId of [...instance.timers.keys()]) this.cancelTimer(instance, timerId);
    for (const subscriptionId of [...instance.messageSubscriptions.keys()]) {
      instance.messageSubscriptions.delete(subscriptionId);
      this.messageSubscriptions = this.messageSubscriptions.filter((entry) => entry.subscriptionId !== subscriptionId);
    }
    for (const commandId of [...instance.commands.keys()]) this.removeCommand(commandId);
    this.hookRegistry.removePlugin(instance.id, instance.contentHash);
    instance.hooks.clear();
  }

  // ── 运行层事件 ──

  /**
   * 运行层事件先原样落日志，再按类型做两件事：
   *   · 进程没了 → 撤掉它注册过的一切（否则模型还能调到一个没有进程的工具）；
   *   · `plugin/failed` → 给**别的**插件发 `plugin.error`（崩溃的那个已经收不到消息了）。
   */
  private onRuntimeEvent(type: string, data: Record<string, unknown>): void {
    this.options.emit(type, data);
    const id = typeof data['id'] === 'string' ? data['id'] : '';
    const hash = typeof data['contentHash'] === 'string' ? data['contentHash'] : '';
    if (type === 'plugin/runtime-stopped' || type === 'plugin/crashed') {
      const instance = this.instances.get(keyOf(id, hash));
      if (instance !== undefined) {
        this.revokeContributions(instance);
        instance.hooks.clear();
      }
    }
    if (type === 'plugin/failed') {
      const category = typeof data['category'] === 'string' ? data['category'] : 'crash';
      const reason = typeof data['reason'] === 'string' ? data['reason'] : '';
      this.notifyPluginError(id, hash, category, reason);
    }
    // 崩溃本身也要给**别的**插件一个 plugin.error（且带 category='crash'）：
    // 第一次崩溃只写 plugin/crashed、不写 plugin/failed，只盯着 failed 会让观察者漏掉第一次。
    if (type === 'plugin/crashed') {
      const reason = typeof data['reason'] === 'string' ? data['reason'] : '进程退出';
      const exitCode = data['exitCode'];
      this.notifyPluginError(id, hash, 'crash', `插件进程崩溃（reason=${reason}，exitCode=${String(exitCode ?? 'null')}）`);
    }
  }

  private notifyPluginLifecycle(point: 'plugin.loaded' | 'plugin.unloaded', payload: Record<string, unknown>, excludeKey: string | null): void {
    void this.dispatchLifecycle(point, payload, excludeKey);
  }

  private notifyPluginError(id: string, contentHash: string, category: string, reason: string): void {
    void this.dispatchLifecycle('plugin.error', { id, contentHash, category, reason }, keyOf(id, contentHash));
  }

  /**
   * 生命周期钩子**不阻塞**调用方：它们是通知，不是判定。
   *
   * 仍然走注册表（顺序/超时/observe 并发一致），但 `account:false`：生命周期通知失败
   * 不参与贡献隔离，也不因一次通知失败撤掉订阅——这与 P1a 的直接循环一致。
   */
  private async dispatchLifecycle(point: 'plugin.loaded' | 'plugin.unloaded' | 'plugin.error', payload: Record<string, unknown>, excludeKey: string | null): Promise<void> {
    if (!this.hookRegistry.has(point)) return;
    try {
      await this.invokeHook(point, payload, {
        account: false,
        ...(excludeKey === null ? {} : { excludeKeys: [excludeKey] }),
      });
    } catch (error) {
      this.options.write(`[插件] ${point} 钩子分发异常：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private viewOf(instance: PluginInstance): PluginInstanceView {
    return {
      id: instance.id,
      contentHash: instance.contentHash,
      version: instance.version,
      permissions: [...instance.permissions],
      config: instance.config,
    };
  }
}

// ──────────────────────────────── 小工具 ────────────────────────────────

function parseOutboundMedia(value: unknown): PluginOutboundMedia | null {  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, 'media: 必须是对象', 'protocol');
  }
  const record = value as Record<string, unknown>;
  const out: PluginOutboundMedia = {};
  if (typeof record['url'] === 'string' && record['url'] !== '') {
    if (!/^https?:\/\//i.test(record['url'])) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, 'media.url: 只支持 http/https', 'protocol');
    out.url = record['url'];
  }
  if (typeof record['path'] === 'string' && record['path'] !== '') out.path = record['path'];
  if (typeof record['base64'] === 'string' && record['base64'] !== '') out.base64 = record['base64'];
  if (typeof record['name'] === 'string' && record['name'] !== '') out.name = record['name'];
  const fileType = record['fileType'];
  if (fileType === 1 || fileType === 2 || fileType === 3 || fileType === 4) out.fileType = fileType;
  if (out.url === undefined && out.path === undefined && out.base64 === undefined) return null;
  return out;
}

/**
 * 媒体的 `path` 一律解释为**插件数据目录里的相对路径**（插件没有整机文件系统）。
 * 出去之前解析成绝对路径——通道层只知道绝对路径，它不该再去认哪个目录是插件的。
 */
function absolutizeMedia(instance: PluginInstance, media: PluginOutboundMedia): PluginOutboundMedia {
  if (media.path === undefined) return media;
  return { ...media, path: resolveInside(instance.dataDir, media.path, 'media.path') };
}

function normalizeToolResult(value: unknown): ToolHandlerResult {
  if (typeof value === 'string') return { content: value };
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record['content'] === 'string') {
      return {
        content: record['content'],
        ...(record['isError'] === true ? { isError: true } : {}),
        ...(record['isError'] === true ? { error: { message: record['content'], code: 'E_PLUGIN_TOOL' } } : {}),
      };
    }
  }
  return { content: JSON.stringify(value ?? null) };
}

// ──────────────────────────────── cron（5 段，分钟粒度） ────────────────────────────────

interface CronField { values: Set<number> }

function parseCronField(raw: string, min: number, max: number, where: string): CronField {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    if (part === '') throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}: 空字段`, 'protocol');
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}: 非法步长 ${part}`, 'protocol');
    let start = min;
    let end = max;
    if (rangePart !== '*') {
      const bounds = (rangePart ?? '').split('-');
      const first = Number(bounds[0]);
      if (!Number.isInteger(first)) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}: 非法值 ${part}`, 'protocol');
      start = first;
      end = bounds.length === 2 ? Number(bounds[1]) : (stepPart === undefined ? first : max);
      if (!Number.isInteger(end)) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}: 非法值 ${part}`, 'protocol');
    }
    if (start < min || end > max || start > end) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}: 超出范围 ${part}`, 'protocol');
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return { values };
}

interface CronSpec { minute: CronField; hour: CronField; day: CronField; month: CronField; weekday: CronField }

export function parsePluginCron(expression: string, where = 'timers.cron'): CronSpec {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, `${where}: 必须是 5 段（分 时 日 月 周），收到 ${parts.length} 段`, 'protocol');
  return {
    minute: parseCronField(parts[0]!, 0, 59, `${where}.minute`),
    hour: parseCronField(parts[1]!, 0, 23, `${where}.hour`),
    day: parseCronField(parts[2]!, 1, 31, `${where}.day`),
    month: parseCronField(parts[3]!, 1, 12, `${where}.month`),
    weekday: parseCronField(parts[4]!, 0, 6, `${where}.weekday`),
  };
}

/** 下一次触发（本地时区，分钟粒度）；一年内没有就返回 null */
export function nextCronOccurrence(expression: string, from: Date): Date | null {
  const spec = parsePluginCron(expression);
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = from.getTime() + 366 * 24 * 3_600_000;
  while (cursor.getTime() <= limit) {
    if (!spec.month.values.has(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.day.values.has(cursor.getDate()) || !spec.weekday.values.has(cursor.getDay())) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.hour.values.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!spec.minute.values.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }
    return new Date(cursor.getTime());
  }
  return null;
}

/** 权限表的只读导出（测试与文档用它核对"哪个方法要哪张票"） */
export const PLUGIN_METHOD_PERMISSIONS: Readonly<Record<string, PluginPermission | null>> = Object.freeze({
  'tool.register': 'tools.define',
  'hook.subscribe': null, // 按钩子点判，见 PLUGIN_HOOK_PERMISSIONS
  'log.write': null,
  'state.get': null,
  'state.set': null,
  'files.read': 'files',
  'files.write': 'files',
  'files.list': 'files',
  'chat.send': 'chat.send',
  'chat.read': 'chat.read',
  'model.complete': 'model.call',
  'timer.every': 'timers',
  'timer.cron': 'timers',
  'timer.cancel': 'timers',
  'net.fetch': 'net',
  'command.define': 'commands.define',
  'config.get': null,
});

/** 供测试/文档核对：当前权限全集（P1b 起 14 项） */
export const PLUGIN_ALL_PERMISSIONS: readonly PluginPermission[] = PLUGIN_PERMISSIONS;

/** 旧名字（P1a 的测试/文档引用过）：值永远与 `PLUGIN_PERMISSIONS` 同一份 */
export const P1A_PERMISSIONS: readonly PluginPermission[] = PLUGIN_PERMISSIONS;
