import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { EventView } from './api.ts';
import type { EventSubscriptionHandle, AfterCommitEventBus } from './event-bus.ts';

const MAX_LINE_BYTES = 2 * 1024 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface AdapterWorkerSpec {
  readonly id: string;
  readonly version: string;
  readonly contentHash: string;
  readonly worker: string;
  readonly capabilities: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface AdapterWorkerStatus {
  readonly id: string;
  readonly worker: string;
  readonly state: 'starting' | 'ready' | 'failed' | 'stopped';
  readonly error?: string;
}

export interface AdapterSupervisorOptions {
  readonly eventBus: AfterCommitEventBus;
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly onEffectProposal?: (pluginId: string, proposal: unknown) => void | Promise<void>;
  readonly onFailure?: (pluginId: string, error: unknown) => void;
  readonly onEventAppend?: (pluginId: string, contentHash: string, payload: unknown) => string | null;
  /**
   * `model/generate` 的宿主实现（worker → 宿主）。
   *
   * 只做转发：能力门（`model.invoke`）在这一侧，密钥与端点也在这一侧；
   * 插件进程永远看不到 baseUrl / apiKey。抛错即回 JSON-RPC error。
   */
  readonly onModelRequest?: (spec: AdapterWorkerSpec, params: unknown) => Promise<unknown>;
  /**
   * `media/store` 的宿主实现（worker → 宿主）。
   *
   * 插件**不直接写宿主文件系统**：它交字节与扩展名，宿主按内容哈希落盘到
   * `data/media/plugin/<pluginId>/`，只回一个**宿主相对路径**（`send_media` 认得的那种）。
   */
  readonly onAssetStore?: (spec: AdapterWorkerSpec, params: unknown) => Promise<unknown>;
  readonly spawn?: typeof spawn;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface WorkerState {
  readonly spec: AdapterWorkerSpec;
  readonly child: ChildProcessWithoutNullStreams;
  readonly pending: Map<string, PendingRequest>;
  subscription: EventSubscriptionHandle;
  buffer: string;
  nextId: number;
  status: AdapterWorkerStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(safeJson);
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (/^(?:path|url|uri|data|data_base64|image_base64|base64|token|secret|password|authorization|apiKey)$/iu.test(key)) continue;
    output[key] = safeJson(item);
  }
  return output;
}

/** Public event projection: model-visible events only, with transport/secrets removed. */
export function adapterEventView(event: EventView<unknown>): EventView<unknown> | null {
  if (event.visibility !== 'model') return null;
  return {
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    data: safeJson(event.data),
    visibility: 'model',
    ...(event.origin === undefined ? {} : { origin: event.origin }),
    ...(event.correlation === undefined ? {} : { correlation: event.correlation }),
  };
}

export class AdapterSupervisor {
  private readonly eventBus: AfterCommitEventBus;
  private readonly handshakeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly onEffectProposal: ((pluginId: string, proposal: unknown) => void | Promise<void>) | undefined;
  private readonly onFailure: ((pluginId: string, error: unknown) => void) | undefined;
  private readonly onModelRequest: ((spec: AdapterWorkerSpec, params: unknown) => Promise<unknown>) | undefined;
  private readonly onAssetStore: ((spec: AdapterWorkerSpec, params: unknown) => Promise<unknown>) | undefined;
  private readonly spawnProcess: typeof spawn;
  private readonly onEventAppend?: AdapterSupervisorOptions['onEventAppend'];

  private readonly workers = new Map<string, WorkerState>();

  constructor(options: AdapterSupervisorOptions) {
    this.eventBus = options.eventBus;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.handshakeTimeoutMs) || this.handshakeTimeoutMs < 1) throw new RangeError('invalid handshakeTimeoutMs');
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs < 1) throw new RangeError('invalid requestTimeoutMs');
    this.onEffectProposal = options.onEffectProposal;
    this.onFailure = options.onFailure;
    this.onModelRequest = options.onModelRequest;
    this.onAssetStore = options.onAssetStore;
    this.onEventAppend = options.onEventAppend;
    this.spawnProcess = options.spawn ?? spawn;
  }

  statuses(): readonly AdapterWorkerStatus[] {
    return [...this.workers.values()].map((worker) => worker.status);
  }

  async start(specs: readonly AdapterWorkerSpec[]): Promise<void> {
    for (const spec of specs) {
      if (this.workers.has(spec.id)) continue;
      try {
        await this.startOne(spec);
      } catch (error) {
        this.onFailure?.(spec.id, error);
      }
    }
  }

  async apply(specs: readonly AdapterWorkerSpec[]): Promise<void> {
    const wanted = new Map(specs.map((spec) => [spec.id, spec]));
    for (const id of [...this.workers.keys()]) {
      const current = this.workers.get(id);
      const next = wanted.get(id);
      if (next === undefined || next.contentHash !== current?.spec.contentHash || next.worker !== current?.spec.worker) {
        await this.stopOne(id);
      }
    }
    await this.start(specs);
  }

  async request(pluginId: string, method: string, params?: unknown): Promise<unknown> {
    const worker = this.workers.get(pluginId);
    if (worker === undefined || worker.status.state !== 'ready') throw new Error(`adapter ${pluginId} is not ready`);
    const id = `${pluginId}:${worker.nextId++}:${randomUUID()}`;
    const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    const result = await new Promise<unknown>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        worker.pending.delete(id);
        reject(new Error(`adapter request timed out: ${method}`));
      }, this.requestTimeoutMs);
      worker.pending.set(id, { resolve: resolvePromise, reject, timer });
      try {
        worker.child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        clearTimeout(timer);
        worker.pending.delete(id);
        reject(error);
      }
    });
    if (isRecord(result) && 'proposal' in result) await this.onEffectProposal?.(pluginId, result.proposal);
    return result;
  }

  async stop(): Promise<void> {
    for (const id of [...this.workers.keys()]) await this.stopOne(id);
  }

  private async startOne(spec: AdapterWorkerSpec): Promise<void> {
    const workerPath = resolve(spec.worker);
    const child = this.spawnProcess(process.execPath, [workerPath], {
      cwd: spec.cwd ?? dirname(workerPath),
      env: { ...process.env, ...(spec.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const state: WorkerState = {
      spec,
      child,
      pending: new Map<string, PendingRequest>(),
      subscription: undefined as unknown as EventSubscriptionHandle,
      buffer: '',
      nextId: 1,
      status: { id: spec.id, worker: basename(workerPath), state: 'starting' },
    };
    this.workers.set(spec.id, state);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.readOutput(state, chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => undefined);
    child.once('error', (error) => this.failWorker(state, error));
    child.once('exit', (code, signal) => {
      if (state.status.state !== 'stopped') this.failWorker(state, new Error(`adapter exited (${code ?? 'null'}/${signal ?? 'none'})`));
    });
    try {
      await this.requestWithTimeout(state, 'initialize', {
        protocolVersion: '2',
        protocol: 'linre.adapter.v2',
        adapter: { id: spec.id, version: spec.version },
        capabilities: spec.capabilities,
      }, this.handshakeTimeoutMs);
      state.status = { id: spec.id, worker: basename(workerPath), state: 'ready' };
      state.subscription = this.eventBus.subscribeWithHandle({
        types: ['*'],
        timeoutMs: this.requestTimeoutMs,
        handler: async (event) => {
          const view = adapterEventView(event);
          if (view === null) return;
          this.notify(state, 'events/observe', { event: view });
        },
      });
    } catch (error) {
      this.failWorker(state, error);
      throw error;
    }
  }

  private notify(state: WorkerState, method: string, params: unknown): void {
    if (state.status.state !== 'ready') return;
    try {
      state.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch (error) {
      this.failWorker(state, error);
    }
  }

  private async requestWithTimeout(state: WorkerState, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = `${state.spec.id}:handshake:${randomUUID()}`;
    return await new Promise<unknown>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error(`adapter handshake timed out: ${method}`));
      }, timeoutMs);
      state.pending.set(id, { resolve: resolvePromise, reject, timer });
      state.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private readOutput(state: WorkerState, chunk: string): void {
    state.buffer += chunk;
    if (Buffer.byteLength(state.buffer, 'utf8') > MAX_LINE_BYTES * 2) {
      this.failWorker(state, new Error('adapter output buffer too large'));
      return;
    }
    let index = state.buffer.indexOf('\n');
    while (index >= 0) {
      const raw = state.buffer.slice(0, index).trim();
      state.buffer = state.buffer.slice(index + 1);
      if (raw !== '') {
        if (Buffer.byteLength(raw, 'utf8') > MAX_LINE_BYTES) {
          this.failWorker(state, new Error('adapter response too large'));
          return;
        }
        try {
          this.handleMessage(state, JSON.parse(raw) as Record<string, unknown>);
        } catch (error) {
          this.failWorker(state, error);
          return;
        }
      }
      index = state.buffer.indexOf('\n');
    }
  }

  private handleMessage(state: WorkerState, message: Record<string, unknown>): void {
    if (typeof message.method === 'string' && message.id !== undefined) {
      this.handleWorkerRequest(state, message);
      return;
    }
    const id = typeof message.id === 'string' ? message.id : null;
    if (id === null) return;
    const pending = state.pending.get(id);
    if (pending === undefined) return;
    state.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) pending.reject(new Error(errorText((message.error as Record<string, unknown>)['message'])));
    else pending.resolve(message.result);
  }

  private handleWorkerRequest(state: WorkerState, message: Record<string, unknown>): void {
    const id = message.id;
    const reply = (body: Record<string, unknown>): void => {
      if (!state.child.stdin.writable) return;
      state.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`);
    };
    if (message.method === 'effect/propose') {
      const handler = this.onEffectProposal;
      void (async () => {
        try {
          await handler?.(state.spec.id, message.params);
        } catch {
          // 记录失败不影响回执：提案本来就不执行
        }
        reply({ result: { accepted: false, reason: '本版不执行副作用提案：只记录，不入队' } });
      })();
      return;
    }
    if (message.method === 'model/generate') {
      // 能力门在最前面：未声明的插件连参数都不该被解析。
      if (!state.spec.capabilities.includes('model.invoke')) {
        reply({ error: { code: -32003, message: 'model/generate 需要能力 model.invoke' } });
        return;
      }
      const handler = this.onModelRequest;
      if (handler === undefined) {
        reply({ error: { code: -32001, message: 'model/generate 未启用' } });
        return;
      }
      void (async () => {
        try {
          reply({ result: await handler(state.spec, message.params) });
        } catch (error) {
          reply({ error: { code: -32002, message: errorText(error) } });
        }
      })();
      return;
    }
    if (message.method === 'media/store') {
      if (!state.spec.capabilities.includes('asset.store')) {
        reply({ error: { code: -32003, message: 'media/store 需要能力 asset.store' } });
        return;
      }
      const handler = this.onAssetStore;
      if (handler === undefined) {
        reply({ error: { code: -32001, message: 'media/store 未启用' } });
        return;
      }
      void (async () => {
        try {
          reply({ result: await handler(state.spec, message.params) });
        } catch (error) {
          reply({ error: { code: -32002, message: errorText(error) } });
        }
      })();
      return;
    }
    if (message.method !== 'event/append') {
      reply({ error: { code: -32601, message: `Method not found: ${String(message.method)}` } });
      return;
    }
    const handler = this.onEventAppend;
    if (handler === undefined) {
      reply({ error: { code: -32001, message: 'event/append 未启用' } });
      return;
    }
    let failure: string | null;
    try {
      failure = handler(state.spec.id, state.spec.contentHash, message.params);
    } catch (error) {
      failure = errorText(error);
    }
    if (failure !== null) reply({ error: { code: -32602, message: failure } });
    else reply({ result: { ok: true } });
  }

  private failWorker(state: WorkerState, error: unknown): void {
    if (state.status.state === 'failed' || state.status.state === 'stopped') return;
    state.status = { ...state.status, state: 'failed', error: errorText(error) };
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    state.pending.clear();
    this.onFailure?.(state.spec.id, error);
  }

  private async stopOne(id: string): Promise<void> {
    const state = this.workers.get(id);
    if (state === undefined) return;
    state.status = { ...state.status, state: 'stopped' };
    state.subscription?.cancel();
    await state.subscription?.drain();
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('adapter stopped'));
    }
    state.pending.clear();
    if (!state.child.killed) state.child.kill();
    this.workers.delete(id);
  }
}

export { DEFAULT_HANDSHAKE_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS };
