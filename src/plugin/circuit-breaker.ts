import { isSystemicPluginFailure, PluginProbeCancelledError, type PluginFailure } from './failures.ts';
import type { PluginManager } from './manager.js';

export interface PluginCircuitBreakerOptions {
  manager: PluginManager;
  now: () => number;
  apply: () => Promise<void>;
  probe: (pluginId: string, contentHash: string) => Promise<void>;
}

const failureKey = (failure: PluginFailure): string => [failure.pluginId, failure.contentHash, failure.contributionKind, failure.contributionName].join('\0');

export class PluginCircuitBreaker {
  private readonly manager: PluginManager;
  private readonly now: () => number;
  private readonly apply: () => Promise<void>;
  private readonly probe: (pluginId: string, contentHash: string) => Promise<void>;
  private readonly consecutive = new Map<string, number>();
  private readonly probing = new Set<string>();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private drainChain: Promise<void> = Promise.resolve();

  constructor(options: PluginCircuitBreakerOptions) {
    this.manager = options.manager;
    this.now = options.now;
    this.apply = options.apply;
    this.probe = options.probe;
  }

  noteFailure(failure: PluginFailure): void {
    if (!isSystemicPluginFailure(failure)) return;
    const probing = this.manager.list().find((view) => view.package.manifest.id === failure.pluginId && view.package.contentHash === failure.contentHash && view.state === 'probing');
    if (probing?.circuit) {
      if (probing.circuit.contributionKind !== failure.contributionKind || probing.circuit.contributionName !== failure.contributionName) return;
      const delay = Math.min(900_000, 30_000 * 2 ** probing.circuit.strikes);
      this.manager.quarantine(failure, probing.circuit.count + 1, new Date(this.now() + delay).toISOString(), new Date(this.now()).toISOString());
      this.dirty = true;
      return;
    }
    const key = failureKey(failure);
    const count = (this.consecutive.get(key) ?? 0) + 1;
    this.consecutive.set(key, count);
    if (count < 3) return;
    this.consecutive.delete(key);
    const retryAt = new Date(this.now() + 30_000).toISOString();
    this.manager.quarantine(failure, count, retryAt, new Date(this.now()).toISOString());
    this.dirty = true;
  }

  noteSuccess(failure: PluginFailure): void {
    this.consecutive.delete(failureKey(failure));
    const view = this.manager.list().find((item) => item.package.manifest.id === failure.pluginId && item.package.contentHash === failure.contentHash && item.state === 'probing');
    if (view?.circuit?.contributionKind === failure.contributionKind && view.circuit.contributionName === failure.contributionName) {
      this.manager.recovered(failure.pluginId, failure.contentHash, new Date(this.now()).toISOString());
      this.dirty = true;
    }
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => { void this.drain(false); }, 1000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.drainChain;
  }

  drain(applyPending = true): Promise<void> {
    const run = this.drainChain.then(async () => await this.drainOnce(applyPending));
    this.drainChain = run.catch(() => undefined);
    return run;
  }

  private async drainOnce(applyPending: boolean): Promise<void> {
    if (applyPending) await this.flushApply();
    const probes: Promise<void>[] = [];
    for (const view of this.manager.list()) {
      const circuit = view.circuit;
      if (view.state !== 'quarantined' || circuit?.retryAt === undefined || Date.parse(circuit.retryAt) > this.now()) continue;
      const key = `${view.package.manifest.id}\0${view.package.contentHash}`;
      if (this.probing.has(key)) continue;
      const probeAt = new Date(this.now()).toISOString();
      if (!this.manager.beginProbe(view.package.manifest.id, view.package.contentHash, probeAt)) continue;
      if (circuit.contributionKind === 'hook') {
        this.dirty = true;
        continue;
      }
      this.probing.add(key);
      probes.push(this.runProbe(view.package.manifest.id, view.package.contentHash, key, probeAt));
    }
    if (applyPending) await this.flushApply();
    await Promise.all(probes);
    if (applyPending) await this.flushApply();
  }

  private async flushApply(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      await this.apply();
    }
  }

  private async runProbe(id: string, hash: string, key: string, probeAt: string): Promise<void> {
    try {
      await this.probe(id, hash);
      const view = this.manager.list().find((item) => item.package.manifest.id === id && item.package.contentHash === hash && item.state === 'probing');
      if (view !== undefined && view.circuit?.contributionKind !== 'hook') this.manager.recovered(id, hash, new Date(this.now()).toISOString());
      this.dirty = true;
    } catch (error) {
      // 取消不是失败：宿主关停时会先把在飞的探测池 shutdown 掉，探针被拒是「我们主动
      // 收摊」，不是被探测方又坏了一次。这条必须先判——否则关一次进程就让隔离期按
      // 30s×2^strikes 翻倍，还凭空写一条 plugin/quarantined 假事实。
      if (error instanceof PluginProbeCancelledError) {
        // 只还原内存态（隔离中、立刻可重试）。日志里那条 plugin/probe-started 重放时
        // 本来就会折回这个形状，所以不补事件也不会让重放漂移。
        this.manager.abortProbe(id, hash, probeAt);
        return;
      }
      const view = this.manager.list().find((item) => item.package.manifest.id === id && item.package.contentHash === hash);
      const circuit = view?.circuit;
      if (circuit) {
        const strikes = circuit.strikes;
        const delay = Math.min(900_000, 30_000 * 2 ** strikes);
        this.manager.quarantine({
          pluginId: id, contentHash: hash, contributionKind: circuit.contributionKind as PluginFailure['contributionKind'],
          contributionName: circuit.contributionName, category: circuit.category as PluginFailure['category'],
          message: error instanceof Error ? error.message : String(error),
        }, circuit.count + 1, new Date(this.now() + delay).toISOString(), new Date(this.now()).toISOString());
        this.dirty = true;
      }
    } finally {
      this.probing.delete(key);
    }
  }
}
