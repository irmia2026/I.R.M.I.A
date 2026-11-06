import type {
  AuditPort,
  EffectProposal,
  EffectResult,
  PluginIdentity,
} from './api.ts';
import { type CapabilityBroker, type CapabilityCheckRequest } from './capability-broker.ts';

export interface EffectExecutionContext {
  readonly plugin: PluginIdentity;
  readonly signal?: AbortSignal;
}

export type EffectExecutor = (proposal: EffectProposal, context: EffectExecutionContext) => Promise<EffectResult>;

export interface EffectDispatcherOptions {
  readonly broker: CapabilityBroker;
  readonly executor: EffectExecutor;
  readonly audit: AuditPort;
}

function fail(reason: string, retryable = false): EffectResult {
  return { ok: false, reason, ...(retryable ? { retryable: true } : {}) };
}

function validIntent(proposal: EffectProposal): boolean {
  if (proposal.intent.target.trim() === '' || proposal.intent.parts.length === 0) return false;
  if (!['none', 'idempotent', 'destructive'].includes(proposal.sideEffect)) return false;
  return proposal.intent.parts.every((part) => {
    if (part.type === 'text') return typeof part.text === 'string' && part.text.length > 0 && part.text.length <= 20_000;
    if (part.type === 'mention') return typeof part.target === 'string' && part.target.trim() !== '';
    if (part.type === 'media') {
      const candidate = part as unknown as Record<string, unknown>;
      return typeof part.assetId === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(part.assetId)
        && !('asset' in candidate) && !('url' in candidate) && !('path' in candidate) && !('data' in candidate);
    }
    return false;
  });
}

/** Host-side effect gate: authorize, audit, deduplicate, then invoke an injected executor. */
export class EffectDispatcher {
  private readonly broker: CapabilityBroker;
  private readonly executor: EffectExecutor;
  private readonly audit: AuditPort;
  private readonly completed = new Map<string, EffectResult>();
  private readonly inFlight = new Map<string, Promise<EffectResult>>();

  constructor(options: EffectDispatcherOptions) {
    this.broker = options.broker;
    this.executor = options.executor;
    this.audit = options.audit;
  }

  async dispatch(proposal: EffectProposal, signal?: AbortSignal): Promise<EffectResult> {
    const key = proposal.intent.idempotencyKey.trim();
    if (key === '') return fail('invalid-idempotency-key');
    const prior = this.completed.get(key);
    if (prior !== undefined) {
      await this.tryAudit({ action: 'effect.duplicate', outcome: prior.ok ? 'completed' : 'rejected', detail: { idempotencyKey: key } }, proposal);
      return prior;
    }
    const active = this.inFlight.get(key);
    if (active !== undefined) return active;
    const task = this.run(key, proposal, signal);
    this.inFlight.set(key, task);
    try {
      return await task;
    } finally {
      this.inFlight.delete(key);
    }
  }

  clearIdempotency(key?: string): void {
    if (key === undefined) this.completed.clear();
    else this.completed.delete(key);
  }

  private async run(key: string, proposal: EffectProposal, signal: AbortSignal | undefined): Promise<EffectResult> {
    if (!validIntent(proposal)) {
      const result = fail('invalid-effect-intent');
      this.remember(key, result);
      await this.tryAudit({ action: 'effect.reject', outcome: 'rejected', detail: { reason: 'invalid-effect-intent' } }, proposal);
      return result;
    }
    const request: CapabilityCheckRequest = {
      capability: proposal.capability,
      scope: proposal.intent.target,
      bytes: 0,
    };
    const checked = this.broker.check(request);
    if (!checked.ok) {
      const result = fail(`capability-${checked.reason}`);
      this.remember(key, result);
      await this.tryAudit({ action: 'effect.reject', outcome: 'rejected', detail: { reason: checked.reason } }, proposal);
      return result;
    }
    const accepted = await this.tryAudit({ action: 'effect.accept', outcome: 'accepted', detail: { capability: proposal.capability } }, proposal);
    if (!accepted) {
      const result = fail('audit-unavailable', true);
      return result;
    }
    const authorized = this.broker.authorize(request);
    if (!authorized.ok) {
      const result = fail(`capability-${authorized.reason}`);
      this.remember(key, result);
      await this.tryAudit({ action: 'effect.reject', outcome: 'rejected', detail: { reason: authorized.reason } }, proposal);
      return result;
    }
    let result: EffectResult;
    try {
      result = await this.executor(proposal, { plugin: this.broker.plugin, ...(signal === undefined ? {} : { signal }) });
    } catch (error) {
      result = fail(`executor-error: ${error instanceof Error ? error.message : String(error)}`, true);
    }
    this.remember(key, result);
    await this.tryAudit({
      action: result.ok ? 'effect.complete' : 'effect.fail',
      outcome: result.ok ? 'completed' : 'failed',
      detail: { ...(result.ok ? {} : { reason: result.reason }) },
    }, proposal);
    return result;
  }

  private remember(key: string, result: EffectResult): void {
    if (result.ok || result.retryable !== true) this.completed.set(key, result);
  }

  private async tryAudit(
    entry: { readonly action: string; readonly outcome: 'accepted' | 'rejected' | 'completed' | 'failed'; readonly detail?: Record<string, string> },
    proposal: EffectProposal,
  ): Promise<boolean> {
    try {
      await this.audit.record({
        action: entry.action,
        outcome: entry.outcome,
        plugin: this.broker.plugin,
        ...(proposal.correlation === undefined ? {} : { correlation: proposal.correlation }),
        ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      });
      return true;
    } catch {
      return false;
    }
  }
}
