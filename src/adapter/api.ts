/**
 * Small, type-only contract between a plugin adapter and the host runtime.
 *
 * The shapes deliberately mirror the existing manifest, event log, tool context,
 * and channel reply/media boundaries. This module has no runtime dependencies.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Stable identity for an installed package revision. */
export interface PluginIdentity {
  readonly id: string;
  readonly version: string;
  /** Content hash, not a mutable install path, identifies the trusted revision. */
  readonly contentHash: string;
}

/** Trace facts already used by event envelopes, tool calls, and child turns. */
export interface Correlation {
  readonly eventId?: string;
  readonly requestId?: string;
  readonly turn?: number;
  readonly step?: number;
  readonly callId?: string;
  readonly parentCallId?: string;
}

export type EventVisibility = 'model' | 'internal';

/** Read-only event projection; the host remains responsible for sequence allocation. */
export interface EventView<TData = unknown> {
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly data: TData;
  readonly visibility: EventVisibility;
  readonly origin?: string;
  readonly correlation?: Correlation;
}

export interface EventInvocationContext {
  readonly signal: AbortSignal;
  readonly deadlineAt?: string;
  readonly attempt: number;
}

export type EventHandler<TData = unknown> = (event: EventView<TData>, context: EventInvocationContext) => void | Promise<void>;

/** A subscription declaration; delivery and disposal are owned by AdapterRuntime. */
export interface EventSubscription<TData = unknown> {
  readonly types: readonly string[];
  readonly handler: EventHandler<TData>;
  /** Maximum handler duration; the host aborts the invocation when exceeded. */
  readonly timeoutMs?: number;
}

/** One host-approved capability, optionally narrowed to named resources. */
export interface CapabilityGrant {
  readonly capability: string;
  readonly scope?: readonly string[];
  readonly expiresAt?: string;
}

/** Per-invocation facts made available to an adapter. */
export interface CapabilityContext {
  readonly plugin: PluginIdentity;
  readonly grants: readonly CapabilityGrant[];
  readonly correlation: Correlation;
  readonly signal?: AbortSignal;
}

/** Short name for callers that already have a capability-scoped context. */
export type Context = CapabilityContext;

/** Key/value persistence boundary; paths and filesystem handles never cross it. */
export interface StoragePort {
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<readonly string[]>;
}

export type MediaKind = 'image' | 'video' | 'audio' | 'file';

/** Opaque asset metadata visible to plugins; bytes and transport URLs stay host-only. */
export interface Asset {
  readonly id: string;
  readonly kind: MediaKind;
  readonly mediaType: string;
  readonly name?: string;
  readonly bytes?: number;
}

export interface MediaPort {
  resolve(ref: string): Promise<Asset | null>;
}

export type EffectLevel = 'none' | 'idempotent' | 'destructive';

export interface TextPart {
  readonly type: 'text';
  readonly text: string;
}

export interface MediaPart {
  readonly type: 'media';
  readonly assetId: string;
  readonly alt?: string;
}

export interface MentionPart {
  readonly type: 'mention';
  readonly target: string;
}

export type MessagePart = TextPart | MediaPart | MentionPart;

/** A host-neutral outbound message; adapters propose it, the host decides whether to execute it. */
export interface OutboundIntent {
  readonly target: string;
  readonly idempotencyKey: string;
  readonly parts: readonly MessagePart[];
  readonly correlation?: Correlation;
}

/** Approval/audit envelope around an outbound or other adapter effect. */
export interface EffectProposal {
  readonly intent: OutboundIntent;
  readonly capability: string;
  readonly sideEffect: EffectLevel;
  readonly reason?: string;
  readonly correlation?: Correlation;
}

export type EffectResult =
  | { readonly ok: true; readonly effectId?: string; readonly detail?: string }
  | { readonly ok: false; readonly reason: string; readonly retryable?: boolean };

export interface AuditRecord {
  readonly action: string;
  readonly outcome: 'accepted' | 'rejected' | 'completed' | 'failed';
  readonly plugin: PluginIdentity;
  readonly correlation?: Correlation;
  readonly detail?: JsonValue;
}

export interface AuditPort {
  record(entry: AuditRecord): Promise<void>;
}

/**
 * 模型档位：`light` = 分类/摘要/低延迟评价；`heavy` = 主循环那一档。
 *
 * 插件**永远拿不到** baseUrl / apiKey：请求经宿主转发，密钥不出宿主进程。
 */
export type ModelLaneName = 'light' | 'heavy';

/** 结构化输出声明；`schema` 是 JSON Schema，宿主原样交给传输层。 */
export interface ModelTextFormat {
  readonly type: 'json_schema';
  readonly name: string;
  readonly schema: Record<string, JsonValue>;
}

/**
 * 一次模型调用的插件侧请求。
 *
 * 与 `DsRequest` 刻意不同形：插件不该知道 `tools` / `temperature` 这类宿主旋钮，
 * 也不该覆盖 `model`（挡掉"借 light 配额打 heavy 端点"这类越权）。
 */
export interface ModelGenerateRequest {
  readonly lane: ModelLaneName;
  readonly input: string;
  readonly instructions?: string;
  readonly text?: ModelTextFormat;
  readonly reasoning?: { readonly effort: 'low' | 'medium' | 'high' };
  readonly timeoutMs?: number;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
}

/** 宿主回执：只给文本与用量，不给上游原始响应（避免插件反推端点）。 */
export interface ModelGenerateResult {
  readonly text: string;
  readonly model?: string;
  readonly protocol?: string;
  readonly usage?: ModelUsage;
}

/** 模型端口；实现方在宿主，调用方是插件适配器。 */
export interface ModelPort {
  generate(request: ModelGenerateRequest, context: CapabilityContext): Promise<ModelGenerateResult>;
}

/** Host capabilities exposed to one adapter instance. */
export interface AdapterRuntime {
  readonly plugin: PluginIdentity;
  readonly context: CapabilityContext;
  readonly storage: StoragePort;
  readonly media: MediaPort;
  readonly audit: AuditPort;
  /** 仅在授予 `model.invoke` 时存在。 */
  readonly model?: ModelPort;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  subscribe<TData>(subscription: EventSubscription<TData>): () => void;
  propose(effect: EffectProposal): Promise<EffectResult>;
}
