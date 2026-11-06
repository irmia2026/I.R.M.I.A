import type {
  EventHandler,
  EventInvocationContext,
  EventSubscription,
  EventView,
} from './api.js';

export interface EventBusOptions {
  /** Maximum number of events waiting behind one in-flight handler. */
  readonly queueLimit?: number;
  /** Default maximum handler duration; zero disables the deadline. */
  readonly handlerTimeoutMs?: number;
  /** Host callback for circuit/audit integration; handler errors are never thrown to publishers. */
  readonly onHandlerFailure?: (event: EventView<unknown>, error: unknown) => void;
}

export interface EventDispatchResult {
  readonly matched: number;
  readonly queued: number;
  readonly dropped: number;
}

export interface EventSubscriptionStats {
  readonly queued: number;
  readonly processing: boolean;
  readonly delivered: number;
  readonly dropped: number;
  readonly failures: number;
  readonly cancelled: boolean;
}

export interface EventSubscriptionCancellation {
  readonly cancelled: boolean;
  readonly dropped: number;
}

export interface EventSubscriptionHandle {
  unsubscribe(): EventSubscriptionCancellation;
  cancel(): EventSubscriptionCancellation;
  drain(): Promise<void>;
  stats(): EventSubscriptionStats;
}

const DEFAULT_QUEUE_LIMIT = 64;

function assertQueueLimit(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`queueLimit must be a positive integer, received ${value}`);
  }
}

interface SubscriptionRecord {
  readonly types: ReadonlySet<string>;
  readonly handler: EventHandler<unknown>;
  readonly timeoutMs?: number;
  readonly queue: EventView<unknown>[];
  readonly drainWaiters: Array<() => void>;
  processing: boolean;
  cancelled: boolean;
  activeController: AbortController | null;
  cancelledFirst: EventView<unknown> | null;
  delivered: number;
  dropped: number;
  failures: number;
}

function matches(record: SubscriptionRecord, type: string): boolean {
  return record.types.size === 0 || record.types.has('*') || record.types.has(type);
}

/**
 * A standalone, post-commit event fan-out queue.
 *
 * Callers must invoke emitAfterCommit only once the event's durable commit has
 * completed. Delivery is always deferred and each subscriber is FIFO/serial.
 */
export class AfterCommitEventBus {
  readonly queueLimit: number;
  readonly handlerTimeoutMs: number;
  private readonly onHandlerFailure: ((event: EventView<unknown>, error: unknown) => void) | undefined;
  private readonly subscriptions = new Set<SubscriptionRecord>();

  constructor(options: EventBusOptions = {}) {
    const queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT;
    const handlerTimeoutMs = options.handlerTimeoutMs ?? 30_000;
    assertQueueLimit(queueLimit);
    if (!Number.isFinite(handlerTimeoutMs) || handlerTimeoutMs < 0) {
      throw new RangeError(`handlerTimeoutMs must be a non-negative finite number, received ${handlerTimeoutMs}`);
    }
    this.queueLimit = queueLimit;
    this.handlerTimeoutMs = Math.trunc(handlerTimeoutMs);
    this.onHandlerFailure = options.onHandlerFailure;
  }

  /** Subscribe without replay; only events emitted after this call are seen. */
  subscribe<TData>(subscription: EventSubscription<TData>): () => void {
    const handle = this.subscribeWithHandle(subscription);
    return () => {
      return handle.unsubscribe();
    };
  }

  subscribeWithHandle<TData>(subscription: EventSubscription<TData>): EventSubscriptionHandle {
    if (subscription.timeoutMs !== undefined
      && (!Number.isFinite(subscription.timeoutMs) || subscription.timeoutMs < 0)) {
      throw new RangeError(`subscription timeoutMs must be a non-negative finite number, received ${subscription.timeoutMs}`);
    }
    const record: SubscriptionRecord = {
      types: new Set(subscription.types),
      handler: subscription.handler as EventHandler<unknown>,
      ...(subscription.timeoutMs === undefined ? {} : { timeoutMs: Math.max(0, Math.trunc(subscription.timeoutMs)) }),
      queue: [],
      drainWaiters: [],
      processing: false,
      cancelled: false,
      activeController: null,
      cancelledFirst: null,
      delivered: 0,
      dropped: 0,
      failures: 0,
    };
    this.subscriptions.add(record);

    const cancel = (): EventSubscriptionCancellation => {
      if (record.cancelled) return { cancelled: false, dropped: 0 };
      record.cancelled = true;
      record.activeController?.abort();
      const first = record.activeController === null && record.processing ? record.queue.shift() : undefined;
      record.cancelledFirst = first ?? null;
      const dropped = record.queue.length;
      record.queue.length = 0;
      record.dropped += dropped;
      this.subscriptions.delete(record);
      this.resolveDrainWaiters(record);
      return { cancelled: true, dropped };
    };

    const drain = async (): Promise<void> => {
      if (!record.processing) return;
      await new Promise<void>((resolve) => record.drainWaiters.push(resolve));
    };

    return {
      unsubscribe: cancel,
      cancel,
      drain,
      stats: () => ({
        queued: record.queue.length,
        processing: record.processing,
        delivered: record.delivered,
        dropped: record.dropped,
        failures: record.failures,
        cancelled: record.cancelled,
      }),
    };
  }

  /**
   * Fan out one event after its commit. A full subscriber queue drops the new
   * event, preserving the oldest queued events and their FIFO order.
   */
  publishAfterCommit<TData>(event: EventView<TData>): EventDispatchResult {
    let matched = 0;
    let queued = 0;
    let dropped = 0;

    for (const record of this.subscriptions) {
      if (!matches(record, event.type)) continue;
      matched += 1;
      if (record.queue.length >= this.queueLimit) {
        record.dropped += 1;
        dropped += 1;
        continue;
      }
      record.queue.push(event as EventView<unknown>);
      queued += 1;
      this.pump(record);
    }
    return { matched, queued, dropped };
  }

  /** Descriptive alias for callers that use emit terminology. */
  emitAfterCommit<TData>(event: EventView<TData>): EventDispatchResult {
    return this.publishAfterCommit(event);
  }

  /** Remove all subscriptions and discard their queued events. */
  close(): number {
    let dropped = 0;
    for (const record of [...this.subscriptions]) {
      const queued = record.queue.length;
      dropped += queued;
      record.cancelled = true;
      record.activeController?.abort();
      const first = record.activeController === null && record.processing ? record.queue.shift() : undefined;
      record.cancelledFirst = first ?? null;
      record.queue.length = 0;
      record.dropped += queued;
      this.subscriptions.delete(record);
      this.resolveDrainWaiters(record);
    }
    return dropped;
  }

  private pump(record: SubscriptionRecord): void {
    if (record.processing || record.cancelled) return;
    record.processing = true;
    queueMicrotask(() => {
      void this.drain(record);
    });
  }

  private async drain(record: SubscriptionRecord): Promise<void> {
    let cancelledFirst = record.cancelledFirst;
    record.cancelledFirst = null;
    try {
      while (!record.cancelled || cancelledFirst !== null) {
        const event = cancelledFirst ?? record.queue.shift();
        cancelledFirst = null;
        if (event === undefined) break;
        const controller = new AbortController();
        record.activeController = controller;
        const timeoutMs = record.timeoutMs ?? this.handlerTimeoutMs;
        const deadlineAt = timeoutMs > 0 ? new Date(Date.now() + timeoutMs).toISOString() : undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const handlerPromise = Promise.resolve(record.handler(event, {
          signal: controller.signal,
          ...(deadlineAt === undefined ? {} : { deadlineAt }),
          attempt: 1,
        } satisfies EventInvocationContext));
        void handlerPromise.catch(() => undefined);
        try {
          if (timeoutMs > 0) {
            const timeoutPromise = new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new Error('adapter event handler timeout'));
              }, timeoutMs);
            });
            await Promise.race([handlerPromise, timeoutPromise]);
          } else {
            await handlerPromise;
          }
          record.delivered += 1;
        } catch (error) {
          record.failures += 1;
          this.onHandlerFailure?.(event, error);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          if (record.activeController === controller) record.activeController = null;
        }
      }
    } finally {
      record.processing = false;
      this.resolveDrainWaiters(record);
      if (!record.cancelled && record.queue.length > 0) this.pump(record);
    }
  }

  private resolveDrainWaiters(record: SubscriptionRecord): void {
    if (record.processing) return;
    const waiters = record.drainWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

export { DEFAULT_QUEUE_LIMIT };
