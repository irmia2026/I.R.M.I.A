/**
 * 灰港 Grayhaven 内置通道（observer WebSocket + HTTP command）。
 *
 * 设计边界：
 *   • observer WS 只收 welcome/events/observation，是只读连接；
 *   • 发送 say / direct_message 走 HTTP /v1/characters/:id/commands；
 *   • 控制型动作仍由 MCP 的 /v1/agent/ws 负责，二者不抢同一条连接。
 *
 * 本文件先提供通道核心；配置解析与 main.ts 装配在下一层接入。
 */
import { randomUUID } from 'node:crypto';

import type { WakeChannel } from '../log/types.js';
import type { QqChatType, SendOutcome, SendTextOptions } from './qq-official.ts';
import { connect as wsConnect, type WsClient, type WsConnectOptions } from './ws-client.ts';

export const GREYHARBOR_CHANNEL_NAME = 'greyharbor';
export const GREYHARBOR_REPLY_SCHEME = 'greyharbor:';
export const DEFAULT_GREYHARBOR_BASE_URL = 'http://127.0.0.1:3000';
export const DEFAULT_GREYHARBOR_OBSERVER_PATH = '/v1/agent/observe/ws';
export const DEFAULT_GREYHARBOR_COMMAND_TIMEOUT_MS = 15_000;
export const DEFAULT_GREYHARBOR_HEARTBEAT_MS = 25_000;
export const DEFAULT_GREYHARBOR_RECONNECT_BASE_MS = 1_000;
export const DEFAULT_GREYHARBOR_RECONNECT_MAX_MS = 30_000;

export interface GreyHarborEvent {
  id: number;
  type: string;
  message: string;
}

interface GreyHarborFrame {
  type?: string;
  protocolVersion?: string;
  contentVersion?: string;
  characterId?: string;
  observation?: Record<string, unknown>;
  cursor?: number;
  events?: GreyHarborEvent[];
  at?: string;
  error?: { code?: string; message?: string };
}

export interface GreyHarborObservation {
  character?: { id?: string; name?: string };
  location?: { id?: string; name?: string };
  messages?: Array<{
    id?: string;
    fromId?: string;
    fromName?: string;
    toId?: string;
    toName?: string;
    text?: string;
    isMine?: boolean;
  }>;
  [key: string]: unknown;
}

export interface GreyHarborChannelOptions {
  baseUrl: string;
  token: string;
  characterId: string;
  observerPath?: string;
  connect?: (url: string, options?: WsConnectOptions) => Promise<WsClient>;
  fetch?: typeof fetch;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  heartbeatMs?: number;
  reconnectBaseMs?: number;
  maxReconnectDelayMs?: number;
  commandTimeoutMs?: number;
  /** 只处理这些事件类型；缺省处理 message.direct、combat、party、intimacy、world。 */
  wakeTypes?: string[];
}

/** 回投 URL：`greyharbor:group:<locationId>` / `greyharbor:c2c:<characterId>`。 */
export function greyHarborReplyUrlOf(
  data: Pick<WakeChannel['data'], 'chatType' | 'chatId'>,
): string {
  const kind = data.chatType === 'c2c' || data.chatType === 'dm' ? 'c2c' : 'group';
  return `${GREYHARBOR_REPLY_SCHEME}${kind}:${data.chatId}`;
}

export type GreyHarborReplyUrlParse =
  | { ok: true; chatType: 'c2c' | 'group'; chatId: string }
  | { ok: false; error: string };

export function parseGreyHarborReplyUrl(url: string): GreyHarborReplyUrlParse {
  if (!url.startsWith(GREYHARBOR_REPLY_SCHEME)) {
    return { ok: false, error: `不是 GreyHarbor 回投地址（${url.slice(0, 32)}）` };
  }
  const rest = url.slice(GREYHARBOR_REPLY_SCHEME.length);
  const at = rest.indexOf(':');
  if (at <= 0) return { ok: false, error: `GreyHarbor 回投地址缺少 chatId（${url}）` };
  const kind = rest.slice(0, at);
  const chatId = rest.slice(at + 1);
  if ((kind !== 'c2c' && kind !== 'group') || chatId.trim() === '') {
    return { ok: false, error: `GreyHarbor 回投地址非法（${url}）` };
  }
  return { ok: true, chatType: kind, chatId };
}

/**
 * 一条连接的生命周期：
 *   DISCONNECTED → connect observer → welcome → READY → events/observation
 *   → close → 退避重连 → 可选 HTTP 补事件
 */
export class GreyHarborChannel {
  readonly name = GREYHARBOR_CHANNEL_NAME;

  onMessage?: (event: WakeChannel['data']) => void;
  onReady?: () => void;

  private readonly options: GreyHarborChannelOptions;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  private client: WsClient | null = null;
  private started = false;
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelayMs: number;
  private observation: GreyHarborObservation | null = null;
  private cursor = 0;
  private readonly seen = new Set<number>();
  private readonly seenOrder: number[] = [];

  constructor(options: GreyHarborChannelOptions) {
    this.options = options;
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.reconnectDelayMs = options.reconnectBaseMs ?? DEFAULT_GREYHARBOR_RECONNECT_BASE_MS;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.open(++this.generation);
  }

  stop(): void {
    this.started = false;
    this.generation += 1;
    if (this.reconnectTimer !== null) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    const client = this.client;
    this.client = null;
    if (client !== null) {
      try {
        client.close(1000, 'agent stopping');
      } catch {
        // 连接已关闭
      }
    }
  }

  /** 当前观察（welcome/observation 的最新值）。 */
  currentObservation(): GreyHarborObservation | null {
    return this.observation;
  }

  /** 她自己在这个世界里的角色 id。 */
  selfIds(): string[] {
    return [this.options.characterId];
  }

  private observerUrl(): string {
    const wsBase = this.options.baseUrl.replace(/^http/u, 'ws').replace(/\/+$/u, '');
    const path = this.options.observerPath ?? DEFAULT_GREYHARBOR_OBSERVER_PATH;
    const params = new URLSearchParams({
      token: this.options.token,
      characterId: this.options.characterId,
    });
    return `${wsBase}${path}?${params.toString()}`;
  }

  private async open(generation: number): Promise<void> {
    if (!this.started || generation !== this.generation) return;
    let client: WsClient;
    try {
      client = await (this.options.connect ?? wsConnect)(this.observerUrl(), {});
    } catch {
      this.scheduleReconnect(generation);
      return;
    }
    if (!this.started || generation !== this.generation) {
      client.close(1000, 'stale connection');
      return;
    }
    this.client = client;

    client.onMessage((message) => {
      if (generation !== this.generation || this.client !== client) return;
      this.handleFrame(message.text);
    });
    client.onClose(() => {
      if (generation !== this.generation || this.client !== client) return;
      this.client = null;
      this.stopHeartbeat();
      this.scheduleReconnect(generation);
    });
  }

  private scheduleReconnect(generation: number): void {
    if (!this.started || generation !== this.generation || this.reconnectTimer !== null) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(
      this.options.maxReconnectDelayMs ?? DEFAULT_GREYHARBOR_RECONNECT_MAX_MS,
      Math.max(DEFAULT_GREYHARBOR_RECONNECT_BASE_MS, this.reconnectDelayMs * 2),
    );
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      void this.open(++this.generation);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.options.heartbeatMs ?? DEFAULT_GREYHARBOR_HEARTBEAT_MS;
    this.heartbeatTimer = setInterval(() => {
      const client = this.client;
      if (client === null || !client.isOpen) return;
      try {
        client.send(JSON.stringify({ type: 'ping' }));
      } catch {
        // close 回调会负责重连
      }
    }, interval);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private handleFrame(raw: string): void {
    let frame: GreyHarborFrame;
    try {
      frame = JSON.parse(raw) as GreyHarborFrame;
    } catch {
      return;
    }
    if (frame.type === 'welcome') {
      this.observation = (frame.observation ?? {}) as GreyHarborObservation;
      this.cursor = Number.isSafeInteger(frame.cursor) ? frame.cursor! : 0;
      this.reconnectDelayMs = this.options.reconnectBaseMs ?? DEFAULT_GREYHARBOR_RECONNECT_BASE_MS;
      this.startHeartbeat();
      this.onReady?.();
      return;
    }
    if (frame.type === 'observation') {
      this.observation = (frame.observation ?? {}) as GreyHarborObservation;
      if (Number.isSafeInteger(frame.cursor)) this.cursor = Math.max(this.cursor, frame.cursor!);
      return;
    }
    if (frame.type === 'events') {
      this.mergeEvents(frame.events ?? [], frame.cursor);
    }
  }

  private mergeEvents(events: GreyHarborEvent[], cursor?: number): void {
    const sorted = [...events].sort((a, b) => a.id - b.id);
    for (const event of sorted) {
      if (!Number.isSafeInteger(event.id) || this.seen.has(event.id)) continue;
      this.rememberSeen(event.id);
      const mapped = this.mapEvent(event);
      if (mapped !== null) this.onMessage?.(mapped);
      this.cursor = Math.max(this.cursor, event.id);
    }
    if (Number.isSafeInteger(cursor)) this.cursor = Math.max(this.cursor, cursor!);
  }

  private rememberSeen(id: number): void {
    this.seen.add(id);
    this.seenOrder.push(id);
    while (this.seenOrder.length > 1_000) {
      const old = this.seenOrder.shift();
      if (old !== undefined) this.seen.delete(old);
    }
  }

  private mapEvent(event: GreyHarborEvent): WakeChannel['data'] | null {
    if (!this.shouldWake(event.type)) return null;
    const direct = event.type === 'message.direct';
    if (direct) {
      const target = this.latestDirectTarget();
      if (target === null) return null;
      return {
        channel: GREYHARBOR_CHANNEL_NAME,
        chatType: 'c2c',
        person: target.id,
        nickname: target.name,
        chatId: target.id,
        text: event.message,
        messageId: String(event.id),
        msgSeq: event.id,
        dedupeKey: `${GREYHARBOR_CHANNEL_NAME}:${event.id}`,
      };
    }
    const location = this.observation?.location;
    if (location?.id === undefined || location.id === '') return null;
    return {
      channel: GREYHARBOR_CHANNEL_NAME,
      chatType: 'group',
      person: 'world',
      nickname: location.name ?? '灰港',
      chatId: location.id,
      text: event.message,
      messageId: String(event.id),
      msgSeq: event.id,
      dedupeKey: `${GREYHARBOR_CHANNEL_NAME}:${event.id}`,
    };
  }

  private shouldWake(type: string): boolean {
    const allowed = this.options.wakeTypes ?? [
      'message.direct',
      'combat.',
      'party.',
      'intimacy.',
      'world.',
    ];
    return allowed.some((prefix) => type === prefix || type.startsWith(prefix));
  }

  private latestDirectTarget(): { id: string; name: string } | null {
    const messages = this.observation?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]!;
      if (message.isMine === true || message.fromId === undefined || message.fromId === '') continue;
      return { id: message.fromId, name: message.fromName ?? message.fromId };
    }
    return null;
  }

  async sendText(
    chatType: QqChatType,
    chatId: string,
    text: string,
    options: SendTextOptions = {},
  ): Promise<SendOutcome> {
    void options;
    const command = chatType === 'c2c' || chatType === 'dm'
      ? { type: 'direct_message', targetId: chatId, message: text }
      : { type: 'say', message: text };
    const requestId = `greyharbor-${randomUUID()}`;
    const timeoutMs = this.options.commandTimeoutMs ?? DEFAULT_GREYHARBOR_COMMAND_TIMEOUT_MS;
    try {
      const response = await this.fetchFn(
        `${this.options.baseUrl.replace(/\/+$/u, '')}/v1/characters/${encodeURIComponent(this.options.characterId)}/commands`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.options.token}`,
          },
          body: JSON.stringify({ request_id: requestId, command }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      const body = await response.json().catch(() => null) as
        | { error?: { message?: string } }
        | null;
      if (!response.ok) {
        return {
          ok: false,
          reason: body?.error?.message ?? `GreyHarbor HTTP ${response.status}`,
          passive: false,
        };
      }
      return { ok: true, messageId: '', passive: false, msgSeq: 0 };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        passive: false,
      };
    }
  }
}
