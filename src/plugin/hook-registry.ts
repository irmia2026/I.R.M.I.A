/**
 * 插件平台的**命名 Hook 注册表**。
 *
 * 从 P1a 的"14 个写死在分发器里的点"升级成一张**单一真源**：
 *   · 每个点在这里声明 name / description / family / permission / modes / orderSlots /
 *     defaultTimeoutMs / allowAbort / allowModify；
 *   · 订阅在**那一刻**校验（未知点、模式、abort 意图、超时上限、errorPolicy），
 *     错误消息必须点名"哪个点、哪条约束、允许什么"；
 *   · 分发只读这张表：blocking 按 EARLY→NORMAL→LATE 串行，observe 并发；
 *     超时、失败按订阅声明的 errorPolicy 处理；abort 只在 allowAbort 的点生效。
 *
 * 为什么要有这一层而不是继续在 host-services 里加 if：
 *   "注册成功但永远不触发"是插件平台最难查的一类病。把点位的元数据、声明期校验与分发
 *   顺序收在一处，测试可以直接对着表断言，新增点位也只改这一张表 + 一个触发点。
 *
 * 兼容纪律（P1a 的 14 个名字与权限一个都不改）：
 *   · 名字沿用 `model.request` 这一套；
 *   · 权限沿用现有 14 项，新点只落进已有票（host.ready 免票、command.* 用 commands.define）；
 *   · `message.received` 的"一条订阅一条过滤"模型不变——它仍由 host-services 特判分发，
 *     本注册表只负责校验与记录订阅。
 */

import type { PluginPermission } from './manifest.ts';
import {
  PLUGIN_RPC_ERRORS, PluginRpcError,
  type PluginHookErrorPolicy, type PluginHookMode, type PluginHookOrder,
} from './protocol.ts';

export type { PluginHookErrorPolicy, PluginHookMode, PluginHookOrder };

/** Hook 点所属的能力族（给文档/界面分组，不参与匹配） */
export type PluginHookFamily = 'model' | 'turn' | 'tool' | 'message' | 'reply' | 'lifecycle' | 'command';

/** 单次钩子回调允许声明的超时上限：超过它说明作者在等一个不该在钩子里等的东西 */
export const HOOK_TIMEOUT_MAX_MS = 10_000;

/** 点元数据。`orderSlots=false` 时只接受 NORMAL（本版 17 个点都支持三档）。 */
export interface HookPointMetadata {
  readonly name: PluginHookPoint;
  readonly description: string;
  readonly family: PluginHookFamily;
  /** 订阅该点需要的权限；null = 免权限 */
  readonly permission: PluginPermission | null;
  readonly modes: readonly PluginHookMode[];
  readonly orderSlots: boolean;
  readonly defaultTimeoutMs: number;
  readonly allowAbort: boolean;
  readonly allowModify: boolean;
  /** 允许返回/修改的字段（文档与测试用；分发只认可用字段） */
  readonly modifiableFields: readonly string[];
  /** 允许声明的 errorPolicy（observe 点不允许 ABORT：调用方已经不等它了） */
  readonly errorPolicies: readonly PluginHookErrorPolicy[];
}

/**
 * 点名单：**保留现有 14 个名字与顺序**，新点追加在后面。
 *
 * 新点按域命名：
 *   · `host.ready`    宿主就绪后一次（observe，插件做启动探测）；
 *   · `command.before` 指令命中、正式执行前（blocking，可改 args / abort）；
 *   · `command.after`  指令执行后（observe，载荷含 ok / durationMs / keepInContext）。
 */
export const PLUGIN_HOOK_POINTS = [
  'model.request',
  'model.response',
  'model.waiting',
  'turn.start',
  'turn.end',
  'tool.before',
  'tool.after',
  'reply.decorate',
  'message.sent',
  'message.received',
  'channel.ready',
  'plugin.loaded',
  'plugin.unloaded',
  'plugin.error',
  'host.ready',
  'command.before',
  'command.after',
] as const;

export type PluginHookPoint = (typeof PLUGIN_HOOK_POINTS)[number];

const BLOCKING: readonly PluginHookMode[] = Object.freeze(['blocking']);
const OBSERVE: readonly PluginHookMode[] = Object.freeze(['observe']);
const ALL_ERROR_POLICIES: readonly PluginHookErrorPolicy[] = Object.freeze(['ABORT', 'SKIP', 'LOG']);
const OBSERVE_ERROR_POLICIES: readonly PluginHookErrorPolicy[] = Object.freeze(['SKIP', 'LOG']);
const NO_FIELDS: readonly string[] = Object.freeze([]);

/**
 * 全部 17 个点的元数据。
 *
 * 旧 14 个点的 timeout 与 modes 刻意写成与 P1a/P1b 相同的语义：
 *   · 阻塞点仍然只有 blocking，观察点仍然只有 observe；
 *   · 默认 2s（host-services 仍允许宿主配置覆盖旧点的默认值，见 `defaultHookTimeoutMs`）；
 *   · 旧点不新增 abort 能力——`message.received` 的 `drop` 是另一条既有语义，不是 abort。
 */
export const HOOK_POINT_METADATA: Readonly<Record<PluginHookPoint, HookPointMetadata>> = Object.freeze({
  'model.request': Object.freeze({
    name: 'model.request', description: '模型请求发出前，可往系统指令末尾追加文本',
    family: 'model', permission: 'hooks.model', modes: BLOCKING, orderSlots: true,
    defaultTimeoutMs: 2_000, allowAbort: false, allowModify: true,
    modifiableFields: Object.freeze(['systemSuffix']), errorPolicies: ALL_ERROR_POLICIES,
  }),
  'model.response': Object.freeze({
    name: 'model.response', description: '模型响应已到手，旁路观察（不改响应）',
    family: 'model', permission: 'hooks.model', modes: OBSERVE, orderSlots: true,
    defaultTimeoutMs: 2_000, allowAbort: false, allowModify: false,
    modifiableFields: NO_FIELDS, errorPolicies: OBSERVE_ERROR_POLICIES,
  }),
  'model.waiting': Object.freeze({
    name: 'model.waiting', description: '模型请求已发出、正在等待响应（UX 信号）',
    family: 'model', permission: 'hooks.model', modes: OBSERVE, orderSlots: true,
    defaultTimeoutMs: 2_000, allowAbort: false, allowModify: false,
    modifiableFields: NO_FIELDS, errorPolicies: OBSERVE_ERROR_POLICIES,
  }),
  'turn.start': Object.freeze({
    name: 'turn.start', description: '一轮开始，旁路观察（不阻塞这一轮）',
    family: 'turn', permission: 'hooks.turn', modes: OBSERVE, orderSlots: true,
    defaultTimeoutMs: 2_000, allowAbort: false, allowModify: false,
    modifiableFields: NO_FIELDS, errorPolicies: OBSERVE_ERROR_POLICIES,
  }),
  'turn.end': Object.freeze({
    name: 'turn.end', description: '一轮结束，旁路观察（不阻塞这一轮）',
    family: 'turn', permission: 'hooks.turn', modes: OBSERVE, orderSlots: true,
    defaultTimeoutMs: 2_000, allowAbort: false, allowModify: false,
    modifiableFields: NO_FIELDS, errorPolicies: OBSERVE_ERROR_POLICIES,
  }),
  'tool.before': Object.freeze({
    name: 'tool.before', description: '工具执行前，可改入参或补上下文',
    family: 'tool', permission: 'hooks.tool', modes: BLOCKING, orderSlots: true,
    defaultTimeoutMs: 2_000, allowAbort: false, allowModify: true,
    modifiableFields: Object.freeze(['input', 'additionalContext']), errorPolicies: ALL_ERROR_POLICIES,
  }),
  'tool.after': Object.freeze({
    name: 'tool.after', description: '工具结果已产生、还没喂回模型之前，可改正文/错误标记',
    family: 'tool', permission: 'hooks.tool', modes: BLOCKING, orderSlots: true,
    defaultTimeoutMs: 2_000, allowAbort: false, allowModify: true,
    modifiableFields: Object.freeze(['content', 'isError', 'additionalContext']), errorPolicies: ALL_ERROR_POLICIES,
  }),
  'reply.decorate': Object.freeze({
    name: 'reply.decorate', description: '出站回复装饰：可替换文本、追加媒体',
    family: 'reply', permission: 'chat.send', modes: BLOCKING, orderSlots: true,
    defaultTimeoutMs: 2_000, allowAbort: false, allowModify: true,
    modifiableFields: Object.freeze(['text', 'media']), errorPolicies: ALL_ERROR_POLICIES,
  }),
  'message.sent': Object.freeze({
    name: 'message.sent', description: '消息真正发出之后，旁路观察（不能回滚）',
    family: 'message', permission: 'chat.send', modes: OBSERVE, orderSlots: true,
    defaultTimeoutMs: 2_000, allowAbort: false, allowModify: false,
    modifiableFields: NO_FIELDS, errorPolicies: OBSERVE_ERROR_POLICIES,
  }),
  'message.received': Object.freeze({
    name: 'message.received', description: '入站消息（一条订阅一个过滤条件；可改写/丢弃/补上下文）',
    family: 'message', permission: 'messages.read', modes: BLOCKING, orderSlots: true,
    defaultTimeoutMs: 2_000, allowAbort: false, allowModify: true,
    modifiableFields: Object.freeze(['text', 'drop', 'additionalContext']), errorPolicies: ALL_ERROR_POLICIES,
  }),
  'channel.ready': Object.freeze({
    name: 'channel.ready', description: '某个通道适配器连上（断线重连会再次触发）',
    family: 'lifecycle', permission: null, modes: OBSERVE, orderSlots: true,
    defaultTimeoutMs: 2_000, allowAbort: false, allowModify: false,
    modifiableFields: NO_FIELDS, errorPolicies: OBSERVE_ERROR_POLICIES,
  }),
  'plugin.loaded': Object.freeze({
    name: 'plugin.loaded', description: '插件加载完成（包括插件自己）',
    family: 'lifecycle', permission: null, modes: OBSERVE, orderSlots: true,
    defaultTimeoutMs: 2_000, allowAbort: false, allowModify: false,
    modifiableFields: NO_FIELDS, errorPolicies: OBSERVE_ERROR_POLICIES,
  }),
  'plugin.unloaded': Object.freeze({
    name: 'plugin.unloaded', description: '另一个插件卸载/停用（不发给插件自己）',
    family: 'lifecycle', permission: null, modes: OBSERVE, orderSlots: true,
    defaultTimeoutMs: 2_000, allowAbort: false, allowModify: false,
    modifiableFields: NO_FIELDS, errorPolicies: OBSERVE_ERROR_POLICIES,
  }),
  'plugin.error': Object.freeze({
    name: 'plugin.error', description: '另一个插件失败/崩溃（不发给出事的插件自己）',
    family: 'lifecycle', permission: null, modes: OBSERVE, orderSlots: true,
    defaultTimeoutMs: 2_000, allowAbort: false, allowModify: false,
    modifiableFields: NO_FIELDS, errorPolicies: OBSERVE_ERROR_POLICIES,
  }),
  'host.ready': Object.freeze({
    name: 'host.ready', description: '宿主就绪后一次（插件可做启动探测；observe）',
    family: 'lifecycle', permission: null, modes: OBSERVE, orderSlots: true,
    defaultTimeoutMs: 2_000, allowAbort: false, allowModify: false,
    modifiableFields: NO_FIELDS, errorPolicies: OBSERVE_ERROR_POLICIES,
  }),
  'command.before': Object.freeze({
    name: 'command.before', description: '指令命中、正式执行前（可改 args；abort = 不执行且按未命中继续）',
    family: 'command', permission: 'commands.define', modes: BLOCKING, orderSlots: true,
    defaultTimeoutMs: 2_000, allowAbort: true, allowModify: true,
    modifiableFields: Object.freeze(['args']), errorPolicies: ALL_ERROR_POLICIES,
  }),
  'command.after': Object.freeze({
    name: 'command.after', description: '指令执行后（ok / durationMs / keepInContext）',
    family: 'command', permission: 'commands.define', modes: OBSERVE, orderSlots: true,
    defaultTimeoutMs: 2_000, allowAbort: false, allowModify: false,
    modifiableFields: NO_FIELDS, errorPolicies: OBSERVE_ERROR_POLICIES,
  }),
});

/** 旧 14 个点：宿主对它们的默认超时沿用 `PluginTimeouts.hookMs`（已有行为） */
const LEGACY_HOOK_POINTS: ReadonlySet<PluginHookPoint> = new Set(PLUGIN_HOOK_POINTS.slice(0, 14));

/** 点名 → 权限（兼容 P1a 的导出名） */
export const PLUGIN_HOOK_PERMISSIONS: Readonly<Record<PluginHookPoint, PluginPermission | null>> = Object.freeze(
  Object.fromEntries(PLUGIN_HOOK_POINTS.map((point) => [point, HOOK_POINT_METADATA[point].permission])),
) as Readonly<Record<PluginHookPoint, PluginPermission | null>>;

/** 判断一个值是否是命名 Hook 点（供 manifest / HTTP / 测试共用） */
export function isPluginHookPoint(value: unknown): value is PluginHookPoint {
  return typeof value === 'string' && (PLUGIN_HOOK_POINTS as readonly string[]).includes(value);
}

/** 取元数据；未知点给出可行动的清单（调用方通常已经先判过 isPluginHookPoint） */
export function hookMetadataOf(point: string): HookPointMetadata {
  if (!isPluginHookPoint(point)) {
    throw invalidParams(`未知 Hook 点 ${JSON.stringify(point)}；已命名 ${PLUGIN_HOOK_POINTS.length} 个点：${PLUGIN_HOOK_POINTS.join(', ')}`);
  }
  return HOOK_POINT_METADATA[point];
}

/**
 * 宿主对某个旧点采用的默认超时。
 *
 * 旧 14 个点的"默认 2s"一直可由 `PluginTimeouts.hookMs` 覆盖；这里保留那条既有行为，
 * 新点则用自己的 `defaultTimeoutMs`。显式订阅值不经过这个函数（在 normalize 里校验）。
 */
export function defaultHookTimeoutMs(point: PluginHookPoint, legacyHookMs: number): number {
  return LEGACY_HOOK_POINTS.has(point) ? legacyHookMs : HOOK_POINT_METADATA[point].defaultTimeoutMs;
}

/** 声明期归一化后的订阅选项（不含订阅 id / 插件身份） */
export interface NormalizedHookSubscription {
  readonly point: PluginHookPoint;
  readonly mode: PluginHookMode;
  readonly order: PluginHookOrder;
  readonly timeoutMs: number;
  readonly errorPolicy: PluginHookErrorPolicy;
  readonly abortIntent: boolean;
}

/** 清单里可选声明的 hooks 条目（展示"它要挂在哪些点"，不是授权） */
export interface PluginHookDeclaration {
  readonly point: PluginHookPoint;
  readonly mode: PluginHookMode;
  readonly order: PluginHookOrder;
  readonly timeoutMs: number;
  readonly errorPolicy: PluginHookErrorPolicy;
  readonly abort: boolean;
}

export const HOOK_SUBSCRIBE_OPTION_KEYS = Object.freeze([
  'point', 'mode', 'order', 'timeoutMs', 'errorPolicy', 'abort',
] as const);

const HOOK_ORDERS: readonly PluginHookOrder[] = Object.freeze(['EARLY', 'NORMAL', 'LATE']);

function invalidParams(message: string): PluginRpcError {
  return new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, message, 'protocol');
}

function describeAllowed<T extends string>(values: readonly T[]): string {
  return values.length === 0 ? '（无）' : values.join(' / ');
}

/**
 * 订阅那一刻的**唯一校验入口**。
 *
 * 所有失败都抛 `PluginRpcError(-32602)`，消息统一写成
 * `hook.subscribe.point "xxx": <哪条约束>（收到 …；允许 …）`，让插件作者当场能改。
 * `options.allowFilter` 只给 host-services 用（`filter` 只属于 message.received）；
 * 清单声明校验传 false，避免把运行期的过滤条件塞进安装审阅。
 */
export function normalizeHookSubscription(
  pointValue: unknown,
  body: Record<string, unknown>,
  where = 'hook.subscribe',
  options: { allowFilter?: boolean; defaultTimeoutMs?: number } = {},
): NormalizedHookSubscription {
  if (!isPluginHookPoint(pointValue)) {
    throw invalidParams(`${where}.point: 未知 Hook 点 ${JSON.stringify(pointValue)}；已命名点：${PLUGIN_HOOK_POINTS.join(', ')}`);
  }
  const point = pointValue;
  const meta = HOOK_POINT_METADATA[point];
  const allowFilter = options.allowFilter === true;

  if (!allowFilter && body['filter'] !== undefined) {
    throw invalidParams(`${where}.filter: 清单里的 hooks 声明不接受过滤条件；运行期用 message.received 的 filter 参数`);
  }
  const allowedKeys = new Set<string>([...HOOK_SUBSCRIBE_OPTION_KEYS]);
  if (allowFilter) allowedKeys.add('filter');
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      throw invalidParams(`${where}: 不支持的字段 ${key}（${point} 允许：${[...allowedKeys].join(', ')}）`);
    }
  }
  if (allowFilter && point !== 'message.received' && body['filter'] !== undefined) {
    throw invalidParams(`${where}.filter: 只有 message.received 接受过滤条件（${point} 不需要 filter）`);
  }

  const requestedMode = body['mode'];
  if (requestedMode !== undefined && typeof requestedMode !== 'string') {
    throw invalidParams(`${where}.mode: 必须是 ${describeAllowed(meta.modes)} 之一（收到 ${JSON.stringify(requestedMode)}）`);
  }
  const mode = requestedMode === undefined
    ? (meta.modes.includes('blocking') ? 'blocking' : 'observe')
    : requestedMode as PluginHookMode;
  if (!meta.modes.includes(mode)) {
    throw invalidParams(`${where}.point ${JSON.stringify(point)}: 不允许 ${mode} 模式（收到 ${JSON.stringify(mode)}；允许：${describeAllowed(meta.modes)}）`);
  }

  const requestedOrder = body['order'];
  if (requestedOrder !== undefined && (typeof requestedOrder !== 'string' || !(HOOK_ORDERS as readonly string[]).includes(requestedOrder))) {
    throw invalidParams(`${where}.point ${JSON.stringify(point)}: order 只能是 ${describeAllowed(HOOK_ORDERS)}（收到 ${JSON.stringify(requestedOrder)}）`);
  }
  const order = (requestedOrder ?? 'NORMAL') as PluginHookOrder;
  if (!meta.orderSlots && order !== 'NORMAL') {
    throw invalidParams(`${where}.point ${JSON.stringify(point)}: 不支持 order=${order}（该点不提供顺序槽位，只允许 NORMAL）`);
  }

  const requestedTimeout = body['timeoutMs'];
  if (requestedTimeout !== undefined) {
    if (typeof requestedTimeout !== 'number' || !Number.isInteger(requestedTimeout) || requestedTimeout <= 0) {
      throw invalidParams(`${where}.point ${JSON.stringify(point)}.timeoutMs: 必须是正整数毫秒（收到 ${JSON.stringify(requestedTimeout)}）`);
    }
    if (requestedTimeout > HOOK_TIMEOUT_MAX_MS) {
      throw invalidParams(`${where}.point ${JSON.stringify(point)}.timeoutMs: 超过上限 ${HOOK_TIMEOUT_MAX_MS}ms（收到 ${requestedTimeout}ms；允许范围 1..${HOOK_TIMEOUT_MAX_MS}）`);
    }
  }
  const timeoutMs = requestedTimeout ?? options.defaultTimeoutMs ?? meta.defaultTimeoutMs;

  const requestedPolicy = body['errorPolicy'];
  if (requestedPolicy !== undefined && (typeof requestedPolicy !== 'string' || !(ALL_ERROR_POLICIES as readonly string[]).includes(requestedPolicy))) {
    throw invalidParams(`${where}.point ${JSON.stringify(point)}.errorPolicy: 只能是 ${describeAllowed(ALL_ERROR_POLICIES)}（收到 ${JSON.stringify(requestedPolicy)}）`);
  }
  const errorPolicy = (requestedPolicy ?? 'SKIP') as PluginHookErrorPolicy;
  if (!meta.errorPolicies.includes(errorPolicy)) {
    throw invalidParams(`${where}.point ${JSON.stringify(point)}.errorPolicy: 不允许 ${errorPolicy}（该点允许：${describeAllowed(meta.errorPolicies)}）`);
  }

  const requestedAbort = body['abort'];
  if (requestedAbort !== undefined && typeof requestedAbort !== 'boolean') {
    throw invalidParams(`${where}.point ${JSON.stringify(point)}.abort: 必须是布尔值（收到 ${JSON.stringify(requestedAbort)}）`);
  }
  const abortIntent = requestedAbort === true;
  if (abortIntent && !meta.allowAbort) {
    throw invalidParams(`${where}.point ${JSON.stringify(point)}: 该点不允许声明 abort 意图（allowAbort=false；只有 ${PLUGIN_HOOK_POINTS.filter((candidate) => HOOK_POINT_METADATA[candidate].allowAbort).join(', ')} 允许）`);
  }

  return Object.freeze({ point, mode, order, timeoutMs, errorPolicy, abortIntent });
}

/** 归一化结果 → 清单展示形状 */
export function hookDeclarationOf(normalized: NormalizedHookSubscription): PluginHookDeclaration {
  return Object.freeze({
    point: normalized.point,
    mode: normalized.mode,
    order: normalized.order,
    timeoutMs: normalized.timeoutMs,
    errorPolicy: normalized.errorPolicy,
    abort: normalized.abortIntent,
  });
}

// ──────────────────────────────── 运行期订阅 ────────────────────────────────

/** 一条已注册订阅：插件身份 + 选项 + 全局注册序号（同序时的稳定依据） */
export interface HookSubscription extends NormalizedHookSubscription {
  readonly subscriptionId: string;
  readonly pluginId: string;
  readonly contentHash: string;
  readonly seq: number;
}

export type HookSubscriptionInput = Omit<HookSubscription, 'seq'>;

export interface HookResultRecord {
  readonly subscription: HookSubscription;
  readonly result: unknown;
}

export interface HookFailureRecord {
  readonly subscription: HookSubscription;
  readonly error: Error;
  readonly category: 'timeout' | 'error';
}

export interface HookAbortInfo {
  readonly point: PluginHookPoint;
  readonly pluginId: string;
  readonly contentHash: string;
  readonly subscriptionId: string;
  readonly reason: string | null;
}

export interface HookInvokeResult {
  readonly point: PluginHookPoint;
  /** 成功返回的处理器（blocking 按执行顺序，observe 按顺序槽位/注册序） */
  readonly results: readonly HookResultRecord[];
  readonly failures: readonly HookFailureRecord[];
  /** 被哪个处理器中止；null = 没中止 */
  readonly abortedBy: HookAbortInfo | null;
  /** errorPolicy=ABORT 的处理器让整个点失败 */
  readonly failed: boolean;
  readonly error: string | null;
}

export interface HookInvokeSettleEvent {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: Error;
  readonly category?: 'timeout' | 'error';
}

/**
 * 分发回调。
 *
 * `call` 由宿主实现（进程请求），注册表只负责顺序/模式/超时/错误策略/abort；
 * `settle` 用来让宿主记贡献成功或失败（隔离仍走既有机制）；`available` 让宿主跳过
 * 已停进程或生命周期要排除的插件。三者都不是必填，纯单元测试可以只给 `call`。
 */
export interface HookInvokeContext {
  call: (subscription: HookSubscription, payload: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
  available?: (subscription: HookSubscription) => boolean;
  settle?: (subscription: HookSubscription, event: HookInvokeSettleEvent) => void;
  log?: (line: string) => void;
  /**
   * blocking 结果 → 下一个 blocking 处理器看到的载荷。
   *
   * 默认不链式（旧 14 点的行为：每个处理器都看原始载荷，结果由宿主按"第一个修改生效"
   * 汇总）。新点 `command.before` 用它把 args 链下去；返回 undefined 表示不改载荷。
   */
  nextPayload?: (subscription: HookSubscription, payload: Record<string, unknown>, result: unknown) => Record<string, unknown> | undefined;
}

/** 超时错误（宿主按 `category='timeout'` 计入既有 hook-timeout 口径） */
export class HookTimeoutError extends Error {
  readonly code: number = PLUGIN_RPC_ERRORS.timeout;
  readonly category = 'timeout' as const;
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = 'HookTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** 顺序槽位的权重（host-services 的 message.received 过滤链也用它排序） */
export const HOOK_ORDER_WEIGHT: Readonly<Record<PluginHookOrder, number>> = Object.freeze({ EARLY: 0, NORMAL: 1, LATE: 2 });

function compareSubscriptions(left: HookSubscription, right: HookSubscription): number {
  const byOrder = HOOK_ORDER_WEIGHT[left.order] - HOOK_ORDER_WEIGHT[right.order];
  return byOrder !== 0 ? byOrder : left.seq - right.seq;
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isTimeoutError(error: Error): boolean {
  return error instanceof HookTimeoutError
    || (error as { category?: unknown }).category === 'timeout'
    || (error as { code?: unknown }).code === PLUGIN_RPC_ERRORS.timeout;
}

function withTimeout(promise: Promise<unknown>, timeoutMs: number, message: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new HookTimeoutError(message, timeoutMs));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function abortReasonOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const raw = record['reason'] ?? record['abortReason'];
  return typeof raw === 'string' && raw !== '' ? raw.slice(0, 500) : null;
}

function isAbortResult(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>)['abort'] === true;
}

/**
 * 注册表本体。
 *
 * 它**不持有插件进程**：进程与权限在 host-services；这里只回答"有哪些订阅、按什么顺序、
 * 超时多久、失败怎么办、能不能中止"。订阅的增删与分发都走同一份记录，避免"校验看的表和
 * 分发看的表不是同一张"。
 */
export class HookRegistry {
  private readonly subscriptions = new Map<string, HookSubscription>();
  private seq = 0;

  /** 注册一条订阅（调用方应先跑 normalizeHookSubscription；这里仍做防呆） */
  register(input: HookSubscriptionInput): HookSubscription {
    const meta = hookMetadataOf(input.point);
    if (!meta.modes.includes(input.mode)) {
      throw invalidParams(`hook.register.point ${JSON.stringify(input.point)}: 不允许 ${input.mode} 模式（允许：${describeAllowed(meta.modes)}）`);
    }
    if (!meta.errorPolicies.includes(input.errorPolicy)) {
      throw invalidParams(`hook.register.point ${JSON.stringify(input.point)}: 不允许 errorPolicy=${input.errorPolicy}（允许：${describeAllowed(meta.errorPolicies)}）`);
    }
    if (input.abortIntent && !meta.allowAbort) {
      throw invalidParams(`hook.register.point ${JSON.stringify(input.point)}: 该点不允许 abort 意图`);
    }
    if (this.subscriptions.has(input.subscriptionId)) {
      throw invalidParams(`hook.register: 订阅 id ${JSON.stringify(input.subscriptionId)} 已存在`);
    }
    this.seq += 1;
    const subscription = Object.freeze({ ...input, seq: this.seq });
    this.subscriptions.set(subscription.subscriptionId, subscription);
    return subscription;
  }

  /** 所有订阅（可按点筛选）；返回副本，调用方排序不会改注册表 */
  list(point?: PluginHookPoint): HookSubscription[] {
    const all = [...this.subscriptions.values()].filter((subscription) => point === undefined || subscription.point === point);
    return all.sort((left, right) => left.seq - right.seq);
  }

  has(point: PluginHookPoint): boolean {
    for (const subscription of this.subscriptions.values()) if (subscription.point === point) return true;
    return false;
  }

  remove(subscriptionId: string): boolean {
    return this.subscriptions.delete(subscriptionId);
  }

  removePoint(pluginId: string, contentHash: string, point: PluginHookPoint): number {
    let removed = 0;
    for (const [id, subscription] of [...this.subscriptions.entries()]) {
      if (subscription.pluginId === pluginId && subscription.contentHash === contentHash && subscription.point === point) {
        this.subscriptions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  removePlugin(pluginId: string, contentHash: string): number {
    let removed = 0;
    for (const [id, subscription] of [...this.subscriptions.entries()]) {
      if (subscription.pluginId === pluginId && subscription.contentHash === contentHash) {
        this.subscriptions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.subscriptions.clear();
  }

  get size(): number {
    return this.subscriptions.size;
  }

  /**
   * 分发一次。
   *
   * 顺序：blocking（EARLY→NORMAL→LATE，同序按注册先后，串行）→ observe（并发）。
   * 超时按订阅值；失败按 errorPolicy；只有 `allowAbort` 且订阅声明了 `abort:true` 的
   * blocking 处理器能用 `{abort:true}` 停止后续 blocking。返回值把成功结果、失败与
   * "被谁中止"一起交给调用方，调用方据此决定是否应用修改。
   */
  async invoke(
    point: PluginHookPoint,
    payload: Record<string, unknown>,
    context: HookInvokeContext,
  ): Promise<HookInvokeResult> {
    const meta = hookMetadataOf(point);
    const subscriptions = this.list(point).filter((subscription) => context.available?.(subscription) !== false);
    const blocking = subscriptions.filter((subscription) => subscription.mode === 'blocking').sort(compareSubscriptions);
    const observing = subscriptions.filter((subscription) => subscription.mode === 'observe').sort(compareSubscriptions);
    const results: HookResultRecord[] = [];
    const failures: HookFailureRecord[] = [];
    let abortedBy: HookAbortInfo | null = null;
    let failed = false;
    let error: string | null = null;
    let blockingPayload = payload;

    const deliver = async (
      subscription: HookSubscription,
      currentPayload: Record<string, unknown>,
    ): Promise<{ ok: true; result: unknown } | { ok: false; error: Error; category: 'timeout' | 'error' }> => {
      try {
        const result = await withTimeout(
          Promise.resolve().then(async () => await context.call(subscription, currentPayload, subscription.timeoutMs)),
          subscription.timeoutMs,
          `钩子 ${point} 的处理器（插件 ${subscription.pluginId}，订阅 ${subscription.subscriptionId}）超过 ${subscription.timeoutMs}ms 未返回`,
        );
        this.settleSafely(context, subscription, { ok: true, result });
        return { ok: true, result };
      } catch (caught) {
        const failure = errorOf(caught);
        const category = isTimeoutError(failure) ? 'timeout' : 'error';
        this.settleSafely(context, subscription, { ok: false, error: failure, category });
        return { ok: false, error: failure, category };
      }
    };

    for (const subscription of blocking) {
      const outcome = await deliver(subscription, blockingPayload);
      if (outcome.ok) {
        results.push({ subscription, result: outcome.result });
        if (isAbortResult(outcome.result)) {
          if (meta.allowAbort && subscription.abortIntent) {
            abortedBy = Object.freeze({
              point,
              pluginId: subscription.pluginId,
              contentHash: subscription.contentHash,
              subscriptionId: subscription.subscriptionId,
              reason: abortReasonOf(outcome.result),
            });
            break;
          }
          context.log?.(`[插件钩子] ${point}: 插件 ${subscription.pluginId} 返回了 abort，但该订阅未获准中止（allowAbort=${meta.allowAbort}，声明 abort=${subscription.abortIntent}）；已忽略`);
        }
        const nextPayload = context.nextPayload?.(subscription, blockingPayload, outcome.result);
        if (nextPayload !== undefined) blockingPayload = nextPayload;
        continue;
      }
      failures.push({ subscription, error: outcome.error, category: outcome.category });
      if (subscription.errorPolicy === 'ABORT') {
        failed = true;
        error = `${point} 的处理器（插件 ${subscription.pluginId}）失败且 errorPolicy=ABORT：${outcome.error.message}`;
        break;
      }
      if (subscription.errorPolicy === 'LOG') {
        context.log?.(`[插件钩子] ${point}: 插件 ${subscription.pluginId} 的处理器失败（errorPolicy=LOG，跳过继续）：${outcome.error.message}`);
      }
    }

    if (!failed && observing.length > 0) {
      const observed = await Promise.all(observing.map(async (subscription) => await deliver(subscription, payload)));
      for (let index = 0; index < observing.length; index += 1) {
        const subscription = observing[index]!;
        const outcome = observed[index]!;
        if (outcome.ok) {
          results.push({ subscription, result: outcome.result });
        } else {
          failures.push({ subscription, error: outcome.error, category: outcome.category });
          context.log?.(`[插件钩子] ${point}: 插件 ${subscription.pluginId} 的 observe 处理器失败（errorPolicy=${subscription.errorPolicy}，已记录，不阻塞调用方）：${outcome.error.message}`);
        }
      }
    }

    return Object.freeze({
      point,
      results: Object.freeze(results),
      failures: Object.freeze(failures),
      abortedBy,
      failed,
      error,
    });
  }

  private settleSafely(context: HookInvokeContext, subscription: HookSubscription, event: HookInvokeSettleEvent): void {
    try {
      context.settle?.(subscription, event);
    } catch (error) {
      context.log?.(`[插件钩子] ${subscription.point}: settle 回调异常（已忽略）：${errorOf(error).message}`);
    }
  }
}
