import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { AppEvent, AppEventType } from '../log/types.js';
import type { PluginFailure } from './failures.js';
import { installPluginPackage, pluginPackageFingerprint, pluginPackagesRoot, scanPluginPackage, type PluginPackage } from './package-store.ts';

export type PluginState = 'untrusted' | 'disabled' | 'enabled' | 'invalid' | 'quarantined' | 'probing';
export interface PluginCircuitView {
  state: 'quarantined' | 'probing';
  contributionKind: string;
  contributionName: string;
  category: string;
  count: number;
  retryAt?: string;
  lastError: string;
  strikes: number;
}
export interface PluginView {
  package: PluginPackage;
  state: PluginState;
  problems: string[];
  requiresRestart: boolean;
  circuit?: PluginCircuitView;
}
export type PluginEventSink = (type: AppEventType, data: AppEvent['data']) => void;

interface Lifecycle { trusted: boolean; enabled: boolean; circuit?: PluginCircuitView | undefined }
const keyOf = (id: string, hash: string): string => `${id}\0${hash}`;
const asString = (value: unknown): string => typeof value === 'string' ? value : '';

/** 生命周期表的键是 id 与内容哈希拼起来的：取「同 id」前缀一律走它，别把分隔符写成字面量。 */
const idPrefixOf = (id: string): string => keyOf(id, '');
/** 与 package-store 同一条规矩：排序按码点，别让 locale/ICU 版本影响先后。 */
const compareCodePoint = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export class PluginManager {
  private lifecycle = new Map<string, Lifecycle>();
  private runtimeEnabled = new Map<string, boolean>();
  private versions = new Map<string, string>();
  private readonly dataDir: string;
  private readonly emit: PluginEventSink;
  /**
   * 扫描结果缓存：key 是包目录，value = 只 stat 的指纹 + 扫描结果（或失败原因）。
   *
   * 为什么必须有：隔离期的包每秒会被 circuit-breaker 的 drain 问一次，`list()` 原先每次都
   * 重读整包并重算 SHA256（8 MB 的包就是每秒 8 MB 盘读）。指纹不读字节，内容/大小/时间
   * 任一变化就失效；包目录被删掉时整条缓存一并清掉。
   */
  private readonly scans = new Map<string, { fingerprint: string; plugin?: PluginPackage; error?: string }>();
  /**
   * 装配期重校验发现的内容问题：键是包目录，值是给人看的原因。
   *
   * 为什么单开一张表：`active()` / `hookProbes()` 返回前要无缓存重算内容哈希，失败时
   * **不能抛错**（那会炸掉整份组合，把无关插件一起停掉），但也不能静默剔除——原因必须
   * 从 `list()` 的 `problems` 里报出来，否则「包明明在磁盘上却没生效」就成了无迹可查的
   * 悬案。它会让该包显示成 `invalid`：字节对不上目录名里的内容哈希，本来就不该继续装。
   */
  private readonly assemblyProblems = new Map<string, string>();
  /**
   * 同 id 多版本冲突的裁剪说明（键是被裁掉的那个包目录）。
   *
   * 与 `assemblyProblems` 分开是因为它**不改变包自身的状态**：被裁掉的那份内容完全合法，
   * 只是这一轮组合不收它。混进 `assemblyProblems` 的话，`list()` 会把它算成 `invalid`，
   * 下一轮 `active()` 便直接跳过它、冲突随之消失、说明也跟着没了——视图会一拍两拍地闪。
   */
  private readonly versionTrims = new Map<string, string>();

  constructor(dataDir: string, emit: PluginEventSink = () => {}) {
    this.dataDir = dataDir;
    this.emit = emit;
  }

  setEvents(events: readonly AppEvent[]): void {
    this.lifecycle.clear();
    this.versions.clear();
    for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
      if (!event.type.startsWith('plugin/')) continue;
      const data = event.data as Record<string, unknown>;
      const id = asString(data['id']);
      const hash = asString(data['contentHash']);
      if (!id || !hash) continue;
      const key = keyOf(id, hash);
      const current = this.lifecycle.get(key) ?? { trusted: false, enabled: false };
      if (event.type === 'plugin/installed' && typeof data['version'] === 'string') {
        current.trusted = true;
        this.versions.set(key, data['version']);
      } else if (event.type === 'plugin/enabled' && current.trusted) current.enabled = true;
      else if (event.type === 'plugin/disabled') current.enabled = false;
      else if (event.type === 'plugin/quarantined') {
        const previous = current.circuit;
        current.circuit = {
          state: 'quarantined', contributionKind: asString(data['contributionKind']), contributionName: asString(data['contributionName']),
          category: asString(data['category']), count: Number(data['count']) || 0, retryAt: asString(data['retryAt']),
          lastError: asString(data['reason']) || event.ts, strikes: (previous?.strikes ?? 0) + 1,
        };
      } else if (event.type === 'plugin/probe-started' && current.circuit) {
        current.circuit = { ...current.circuit, state: 'quarantined', retryAt: event.ts };
      } else if (event.type === 'plugin/recovered') current.circuit = undefined;
      this.lifecycle.set(key, current);
    }
    this.runtimeEnabled = new Map([...this.lifecycle].map(([key, value]) => [key, value.enabled]));
  }

  install(sourceDir: string): PluginPackage { return installPluginPackage(sourceDir, this.dataDir); }

  confirm(id: string, contentHash: string): void {
    const plugin = this.requirePackage(id, contentHash);
    if (this.state(id, contentHash).trusted) return;
    this.emit('plugin/installed', { id, version: plugin.manifest.version, contentHash, path: plugin.rootDir, by: 'human' });
    this.lifecycle.set(keyOf(id, contentHash), { trusted: true, enabled: false });
    this.versions.set(keyOf(id, contentHash), plugin.manifest.version);
  }

  setEnabled(id: string, contentHash: string, enabled: boolean): void {
    this.requirePackage(id, contentHash);
    const state = this.lifecycle.get(keyOf(id, contentHash));
    if (!state?.trusted) throw new Error(`Plugin ${id}@${contentHash} must be confirmed before enablement`);
    if (state.enabled === enabled) return;
    if (enabled) {
      // 同 id 只允许一个 hash 生效：两版同时在组合里会产出两套同命名空间的贡献，
      // 「现在跑的是哪一版」和故障该记到谁头上都会说不清。P0 不提供更新命令，所以这里
      // 只把门关上、让用户显式处置旧版本——静默替换等于把这条事实藏起来。
      const conflict = [...this.lifecycle].find(([key, value]) => value.enabled && key.startsWith(idPrefixOf(id)) && key !== keyOf(id, contentHash));
      if (conflict !== undefined) {
        const otherHash = conflict[0].slice(idPrefixOf(id).length);
        throw new Error(`Plugin ${id}@${otherHash} is already enabled; disable or uninstall it before enabling ${id}@${contentHash}`);
      }
    }
    this.emit(enabled ? 'plugin/enabled' : 'plugin/disabled', { id, contentHash });
    this.lifecycle.set(keyOf(id, contentHash), { ...state, enabled });
  }

  recordFailure(id: string, contentHash: string, reason: string): void {
    this.requirePackage(id, contentHash);
    this.emit('plugin/failed', { id, contentHash, reason });
  }

  quarantine(failure: PluginFailure, count: number, retryAt: string, failedAt: string): void {
    this.requirePackage(failure.pluginId, failure.contentHash);
    const state = this.lifecycle.get(keyOf(failure.pluginId, failure.contentHash));
    if (!state?.trusted || !state.enabled) return;
    this.emit('plugin/quarantined', {
      id: failure.pluginId, contentHash: failure.contentHash, contributionKind: failure.contributionKind,
      contributionName: failure.contributionName, category: failure.category, count, retryAt, failedAt, reason: failure.message,
    });
    this.lifecycle.set(keyOf(failure.pluginId, failure.contentHash), { ...state, circuit: {
      state: 'quarantined', contributionKind: failure.contributionKind, contributionName: failure.contributionName,
      category: failure.category, count, retryAt, lastError: failure.message, strikes: (state.circuit?.strikes ?? 0) + 1,
    } });
  }

  beginProbe(id: string, hash: string, probeAt: string): boolean {
    const state = this.lifecycle.get(keyOf(id, hash));
    if (!state?.circuit || state.circuit.state !== 'quarantined') return false;
    const circuit = state.circuit;
    this.emit('plugin/probe-started', { id, contentHash: hash, contributionKind: circuit.contributionKind,
      contributionName: circuit.contributionName, category: circuit.category, count: circuit.count, probeAt });
    this.lifecycle.set(keyOf(id, hash), { ...state, circuit: { ...circuit, state: 'probing' } });
    return true;
  }

  /**
   * 取消一次在飞的探针：把它**还原**成「隔离中、立刻可重试」，其余字段（count/strikes/
   * category/contributionName/lastError）原样保留，且**不发任何事件**。
   *
   * 为什么可以不发事件：日志里那条 `plugin/probe-started` 已经写下了，而 `setEvents` 重放时
   * 本来就把它折回 `{ state: 'quarantined', retryAt: 事件时间 }`——内存态与重放态因此天然
   * 一致。再补一条事件反而会让「这次探针」有两个事实来源。
   */
  abortProbe(id: string, hash: string, probeAt: string): void {
    const state = this.lifecycle.get(keyOf(id, hash));
    const circuit = state?.circuit;
    if (state === undefined || circuit === undefined || circuit.state !== 'probing') return;
    this.lifecycle.set(keyOf(id, hash), { ...state, circuit: { ...circuit, state: 'quarantined', retryAt: probeAt } });
  }

  recovered(id: string, hash: string, recoveredAt: string): void {
    const state = this.lifecycle.get(keyOf(id, hash));
    if (!state?.circuit) return;
    const circuit = state.circuit;
    this.emit('plugin/recovered', { id, contentHash: hash, contributionKind: circuit.contributionKind,
      contributionName: circuit.contributionName, category: circuit.category, count: circuit.count, recoveredAt });
    this.lifecycle.set(keyOf(id, hash), { ...state, circuit: undefined });
  }

  list(): PluginView[] {
    const candidates = this.discover();
    const live = new Set(candidates.map((candidate) => candidate.rootDir));
    for (const key of [...this.scans.keys()]) if (!live.has(key)) this.scans.delete(key);
    for (const key of [...this.assemblyProblems.keys()]) if (!live.has(key)) this.assemblyProblems.delete(key);
    for (const key of [...this.versionTrims.keys()]) if (!live.has(key)) this.versionTrims.delete(key);
    return candidates.map((candidate) => {
      const lifecycle = this.state(candidate.id, candidate.hash);
      const key = keyOf(candidate.id, candidate.hash);
      const problems: string[] = [];
      let plugin: PluginPackage;
      try {
        plugin = this.loadPackage(candidate.rootDir);
        if (plugin.manifest.id !== candidate.id) throw new Error(`Package id mismatch: ${plugin.manifest.id}`);
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
        plugin = { rootDir: candidate.rootDir, contentHash: candidate.hash, fileCount: 0, totalBytes: 0,
          manifest: { apiVersion: 1, id: candidate.id, version: this.versions.get(key) ?? '0.0.0',
            engine: { irmia: '>=0.0.0' }, contributions: { skills: [] }, permissions: [] } };
      }
      const assembled = this.assemblyProblems.get(candidate.rootDir);
      if (assembled !== undefined) problems.push(assembled);
      const state: PluginState = problems.length ? 'invalid' : !lifecycle.trusted ? 'untrusted' : !lifecycle.enabled ? 'disabled' : lifecycle.circuit?.state ?? 'enabled';
      // 裁剪说明在状态算完后再追加：它只说明「这一轮组合没收你」，不该把合法包标成 invalid
      const trimmed = this.versionTrims.get(candidate.rootDir);
      if (trimmed !== undefined) problems.push(trimmed);
      return { package: plugin, state, problems, requiresRestart: lifecycle.enabled !== (this.runtimeEnabled.get(key) ?? false),
        ...(lifecycle.circuit !== undefined ? { circuit: lifecycle.circuit } : {}) };
    });
  }

  /**
   * 进入运行组合的包。返回前**重新校验内容哈希**，不吃 stat 缓存。
   *
   * 为什么装配口必须重算字节：指纹由元数据算出，不是内容的函数（见 `pluginPackageFingerprint`），
   * 而装配是「磁盘上的声明变成进程、工具与模型索引」的最后一道关。多读一次字节的代价，
   * 远低于让一份被改写过的声明生效。
   */
  active(): PluginPackage[] {
    const verified: PluginPackage[] = [];
    for (const view of this.list()) {
      if (view.state !== 'enabled' || view.requiresRestart) continue;
      const fresh = this.verifyContents(view);
      if (fresh !== undefined) verified.push(fresh);
    }
    return this.dedupeByVersion(verified);
  }

  /** 半开探针要重装的那一份包。与 `active()` 同样先重校验字节：坏包不装，原因进 `problems`。 */
  hookProbes(): PluginPackage[] {
    const verified: PluginPackage[] = [];
    for (const view of this.list()) {
      if (view.state !== 'probing' || view.circuit?.contributionKind !== 'hook') continue;
      if (view.package.manifest.contributions.hooks === undefined) continue;
      const fresh = this.verifyContents(view);
      if (fresh !== undefined) verified.push(fresh);
    }
    return verified;
  }

  /**
   * 无缓存重校验：重算整包字节哈希（`scanPluginPackage` 会拿「目录名就是内容哈希」去比）。
   * 失败只登记原因并返回 undefined——一个坏包不该把整份组合拖下水。
   */
  private verifyContents(view: PluginView): PluginPackage | undefined {
    try {
      const fresh = scanPluginPackage(view.package.rootDir);
      if (fresh.manifest.id !== view.package.manifest.id) throw new Error(`Package id mismatch: ${fresh.manifest.id}`);
      this.assemblyProblems.delete(view.package.rootDir);
      return fresh;
    } catch (error) {
      this.assemblyProblems.set(view.package.rootDir, error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  /**
   * 同 id 多版本的防御性去重：一个 id 只放一个 hash 进组合。
   *
   * `setEnabled` 已经拒绝新的并发启用，但**历史日志**里可能早就有两条 `plugin/enabled`
   * （那道门是后加的）。同 id 两版同时装进组合会产出两套同命名空间的 MCP/Hook/Skill，
   * 调用与故障归因都会说不清，所以这里只留一个：按 contentHash 码点序取首个（与整包
   * 哈希的排序口径一致，跨机器稳定），其余登记裁剪原因交给 `list()` 报出去。
   */
  private dedupeByVersion(packages: readonly PluginPackage[]): PluginPackage[] {
    this.versionTrims.clear();
    const kept = new Map<string, PluginPackage>();
    for (const pkg of packages) {
      const existing = kept.get(pkg.manifest.id);
      if (existing === undefined) {
        kept.set(pkg.manifest.id, pkg);
        continue;
      }
      const [winner, loser] = compareCodePoint(pkg.contentHash, existing.contentHash) < 0 ? [pkg, existing] : [existing, pkg];
      kept.set(pkg.manifest.id, winner);
      this.versionTrims.set(loser.rootDir,
        `同 id 多版本同时启用：已按 contentHash 码点序裁剪 ${loser.manifest.id}@${loser.contentHash}，保留 ${winner.contentHash}；请停用或卸载多余版本`);
    }
    return [...kept.values()].sort((a, b) => compareCodePoint(a.manifest.id, b.manifest.id) || compareCodePoint(a.contentHash, b.contentHash));
  }

  private state(id: string, hash: string): Lifecycle { return this.lifecycle.get(keyOf(id, hash)) ?? { trusted: false, enabled: false }; }

  /**
   * 带缓存的整包加载。指纹一致就复用上次结果（含失败结果——坏包不该每秒重读一遍）。
   * 指纹本身抛错（符号链接、超限）时不写缓存：那种判定只看 stat，重算很便宜。
   */
  private loadPackage(rootDir: string): PluginPackage {
    const fingerprint = pluginPackageFingerprint(rootDir);
    const cached = this.scans.get(rootDir);
    if (cached !== undefined && cached.fingerprint === fingerprint) {
      if (cached.plugin !== undefined) return cached.plugin;
      throw new Error(cached.error ?? 'Plugin scan failed');
    }
    try {
      const plugin = scanPluginPackage(rootDir);
      this.scans.set(rootDir, { fingerprint, plugin });
      return plugin;
    } catch (error) {
      this.scans.set(rootDir, { fingerprint, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * 人为确认/启停/隔离前的取包：**不走 stat 缓存**，每次都重算字节哈希。
   *
   * 缓存是性能手段，不是完整性凭据（见 `pluginPackageFingerprint`）；而这几条命令的语义
   * 都是「从现在起把这份声明当成已确认的内容」，指纹相同却字节不同的包绝不能混过去。
   */
  private requirePackage(id: string, hash: string): PluginPackage {
    if (!/^[a-z0-9-]{1,64}$/.test(id) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid plugin id or contentHash');
    const rootDir = join(pluginPackagesRoot(this.dataDir), id, hash);
    const plugin = scanPluginPackage(rootDir);
    if (plugin.manifest.id !== id) throw new Error(`Plugin id mismatch: ${plugin.manifest.id}`);
    this.assemblyProblems.delete(rootDir);
    return plugin;
  }

  private discover(): { id: string; hash: string; rootDir: string }[] {
    const root = pluginPackagesRoot(this.dataDir);
    if (!existsSync(root)) return [];
    const out: { id: string; hash: string; rootDir: string }[] = [];
    for (const id of readdirSync(root, { withFileTypes: true })) {
      if (!id.isDirectory() || !/^[a-z0-9-]{1,64}$/.test(id.name)) continue;
      for (const hash of readdirSync(join(root, id.name), { withFileTypes: true })) {
        if (hash.isDirectory() && /^[a-f0-9]{64}$/.test(hash.name)) out.push({ id: id.name, hash: hash.name, rootDir: join(root, id.name, hash.name) });
      }
    }
    return out.sort((a, b) => compareCodePoint(a.id, b.id) || compareCodePoint(a.hash, b.hash));
  }
}
