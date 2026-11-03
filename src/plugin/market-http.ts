import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginsConfig } from '../config/config.ts';
import { AGENT_VERSION } from '../main.ts';
import type { PluginManager } from './manager.ts';
import { isPluginEngineCompatible, type PluginManifest } from './manifest.ts';
import { cancelMarketResponse, readBoundedMarketBody, type MarketBodyResponse } from './market-response.ts';
import {
  MARKET_ERROR_CODES, MARKET_LIMITS, MARKET_SCHEMA, MarketError,
  parseMarketIndex, selectRelease, verifyAndInstall,
  type MarketErrorCode, type MarketIndex, type MarketPluginEntry, type MarketProblem, type MarketRelease,
} from './market.ts';

/**
 * 插件市场的 **HTTP 面**（`GET /api/plugins/market*` 与 `POST /api/commands/plugin-market-install`）。
 *
 * 这一层只做四件事，判据都在别处：
 *   ① 取索引：只 GET 配置里那一个地址（同源重定向最多 3 跳）、10 秒超时、响应 ≤2MB，
 *      进程内缓存 5 分钟（`?refresh=1` 强制刷新）；
 *   ② 把索引折成**审阅视图**：每个版本都带 permissions + net，并标出"与本机宿主版本是否兼容"；
 *   ③ 安装：版本选择交给 `market.ts` 的 `selectRelease`，下载/校 sha256/size/包身份交给
 *      `verifyAndInstall`，最后交给 `PluginManager.install` 落进正式包仓库；
 *   ④ 回执：内容哈希、权限、网络白名单、是否需要重启，以及"索引与包内声明是否一致"。
 *
 * **三条安全边界（都别在这里放宽）**：
 *   · 不允许任意 URL：入口只有配置里的 index 地址；索引里的包地址与 sha256 是唯一来源，
 *     请求体里出现 url / sha256 / size 一律拒绝（防"绕过索引校验"的调用方）；
 *   · 索引被投毒时，能做的仍是**人看审阅数据 → confirm → enable**：这一层绝不自动确认或启用，
 *     安装完成的状态一定是 `untrusted`；包内 `plugin.json` 的 net.allow 与 permissions
 *     才是执行期真正生效的那一份，索引只用于展示与"不一致"提示；
 *   · 失败不改写上游错误：HTTP 状态、网络异常、sha256 期望/实际值都原样带进 message/detail，
 *     人能看懂"是 503、是超时、还是哈希不对"。
 */

// ──────────────────────────────── 常量 ────────────────────────────────

/** 索引缓存的 TTL：5 分钟（`?refresh=1` 不读缓存，但仍然会刷新缓存） */
export const MARKET_CACHE_TTL_MS = 5 * 60 * 1000;
/** 取索引的总时限：10 秒（与包下载同一条口径，由调用方注入） */
export const MARKET_INDEX_TIMEOUT_MS = 10_000;
/** 索引请求的固定 User-Agent：没有机器名、用户名、实例标识 */
export const MARKET_USER_AGENT = 'IrmiaAgentMarket/1';
/** 同源重定向最多跟几跳 */
const MARKET_MAX_REDIRECTS = 3;

// ──────────────────────────────── 注入的 fetch 形状 ────────────────────────────────

export interface MarketHttpResponse extends MarketBodyResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
  /** 最终 URL（有就校验同源；测试的假 fetch 可以不给） */
  readonly url?: string;
  /** Content-Length 是提前拒绝的提示；实际响应仍逐块计数限额。 */
  readonly headers?: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface MarketHttpRequestInit {
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  readonly redirect?: 'follow' | 'manual';
}

export type MarketHttpFetch = (url: string, init: MarketHttpRequestInit) => Promise<MarketHttpResponse>;

/** 生产路径的缺省 fetch：直接包一层全局 fetch（`Response` 的形状满足上面那个窄接口）。 */
export function defaultMarketHttpFetch(): MarketHttpFetch {
  const impl = globalThis.fetch;
  return async (url, init) => {
    if (typeof impl !== 'function') throw new Error('本进程没有可用的 fetch');
    return await impl(url, init as RequestInit) as unknown as MarketHttpResponse;
  };
}

// ──────────────────────────────── 对外形状 ────────────────────────────────

export interface MarketHttpResult {
  status: number;
  body: unknown;
}

/** `GET /api/plugins/market` 里一个版本的形状（字段与任务约定逐项对齐） */
export interface MarketReleaseView {
  version: string;
  apiVersion: 1 | 2;
  engine: string;
  size: number;
  sha256: string;
  permissions: string[];
  net: string[];
  runtime: string;
  url: string;
}

/** 单个版本的兼容性判读（只在 `GET /api/plugins/market/<id>` 里出现） */
export interface MarketReleaseReview extends MarketReleaseView {
  /** 本机宿主版本满足 release.engine 吗 */
  compatible: boolean;
  /** 不兼容时的人话原因（兼容时为 null） */
  compatibility: string | null;
}

/** 安装前给人看的审阅数据（索引那一半；安装回执里会多出包内那一半） */
export interface MarketIndexReview {
  marketId: string;
  version: string;
  runtime: string;
  engine: string;
  size: number;
  sha256: string;
  permissions: string[];
  net: string[];
  /**
   * `index` = 只看得到索引声明；
   * `package` = 已经拿到包，下面两格来自包内 `plugin.json`（执行期真正生效的那一份）。
   */
  basis: 'index' | 'package';
  indexPermissions: string[];
  indexNet: string[];
  /** 包内清单的权限 / net.allow；basis === 'index' 时是 null */
  packagePermissions: string[] | null;
  packageNet: string[] | null;
  /** 索引与包内声明是否不一致（安装回执里才会为 true） */
  netMismatch: boolean;
  permissionsMismatch: boolean;
  warnings: string[];
}

interface CachedIndex {
  readonly url: string;
  readonly index: MarketIndex;
  readonly problems: readonly MarketProblem[];
  readonly fetchedAt: number;
}

export interface PluginMarketClientOptions {
  readonly dataDir: string;
  readonly plugins: PluginsConfig | undefined;
  readonly fetch?: MarketHttpFetch | undefined;
  readonly now?: (() => Date) | undefined;
  readonly hostVersion?: string | undefined;
  readonly timeoutMs?: number | undefined;
  /** 临时目录父目录（测试用；缺省 os.tmpdir） */
  readonly tempDir?: string | undefined;
}

// ──────────────────────────────── 客户实现 ────────────────────────────────

export class PluginMarketClient {
  private readonly dataDir: string;
  private readonly enabled: boolean;
  private readonly indexUrl: string;
  private readonly fetchImpl: MarketHttpFetch;
  private readonly now: () => Date;
  private readonly hostVersion: string;
  private readonly timeoutMs: number;
  private readonly tempDir: string | undefined;
  private cache: CachedIndex | null = null;

  constructor(options: PluginMarketClientOptions) {
    this.dataDir = options.dataDir;
    // 直接调用方（测试/嵌入方）可能给一份不带 plugins 的旧形状：缺省按出厂值，
    // 与 AppConfig 的默认值同源（打开市场 + 官方索引）。
    const plugins = options.plugins ?? { marketEnabled: true, marketIndexUrl: 'https://irmia.me/plugins/index.json' };
    this.enabled = plugins.marketEnabled === true;
    this.indexUrl = plugins.marketIndexUrl;
    this.fetchImpl = options.fetch ?? defaultMarketHttpFetch();
    this.now = options.now ?? (() => new Date());
    this.hostVersion = options.hostVersion ?? AGENT_VERSION;
    this.timeoutMs = options.timeoutMs ?? MARKET_INDEX_TIMEOUT_MS;
    this.tempDir = options.tempDir;
  }

  // ── 读：索引 / 单插件审阅 ──

  async indexView(refresh = false): Promise<MarketHttpResult> {
    if (!this.enabled) return disabled('市场已关闭：plugins.marketEnabled 为 false，所以不取索引。打开它并重启后端后可用。');
    try {
      const loaded = await this.loadIndex(refresh);
      return ok({
        schema: MARKET_SCHEMA,
        updatedAt: loaded.index.updatedAt ?? null,
        plugins: loaded.index.plugins.map((entry) => this.pluginEntryView(entry)),
        problems: loaded.problems,
        fetchedAt: new Date(loaded.fetchedAt).toISOString(),
        cached: loaded.cached,
        cacheTtlSeconds: MARKET_CACHE_TTL_MS / 1000,
      });
    } catch (error) {
      return marketFailure(error);
    }
  }

  async pluginView(id: string, refresh = false): Promise<MarketHttpResult> {
    if (!this.enabled) return disabled('市场已关闭：plugins.marketEnabled 为 false，所以不取索引。打开它并重启后端后可用。');
    if (!/^[a-z0-9-]{1,64}$/.test(id)) {
      return failure(404, MARKET_ERROR_CODES.pluginNotFound, `市场索引里没有插件 ${JSON.stringify(id)}（插件 id 只能是 1–64 位小写字母/数字/连字符）`);
    }
    try {
      const loaded = await this.loadIndex(refresh);
      const index = loaded.index.plugins.findIndex((entry) => entry.id === id);
      const entry = index < 0 ? undefined : loaded.index.plugins[index];
      if (entry === undefined) {
        return failure(
          404,
          MARKET_ERROR_CODES.pluginNotFound,
          `市场索引里没有插件 ${id}（索引里共 ${loaded.index.plugins.length} 个插件）`,
        );
      }
      const selection = selectRelease(loaded.index, id, { engine: this.hostVersion });
      const compatibleVersion = selection.ok ? selection.release.version : null;
      const selectionView = selection.ok
        ? { version: compatibleVersion, code: null, message: null, skipped: selection.skipped.map((release) => release.version) }
        : { version: null, code: selection.code, message: selection.message, skipped: [] as string[] };
      const reviewRelease = selection.ok
        ? selection.release
        : entry.versions.find((release) => release.version === entry.latest) ?? entry.versions[0]!;
      return ok({
        id: entry.id,
        title: entry.title ?? null,
        author: entry.author ?? null,
        desc: entry.desc ?? null,
        latest: entry.latest ?? null,
        hostVersion: this.hostVersion,
        compatible: selection.ok,
        compatibleVersion,
        selection: selectionView,
        versions: entry.versions.map((release) => this.releaseReview(release)),
        review: this.indexReview(entry, reviewRelease),
        problems: loaded.problems.filter((problem) => {
          const prefix = `plugins[${index}]`;
          return problem.path === prefix || problem.path.startsWith(`${prefix}.`);
        }),
      });
    } catch (error) {
      return marketFailure(error);
    }
  }

  // ── 写：从市场安装 ──

  async install(payload: Record<string, unknown>, manager: PluginManager | undefined): Promise<MarketHttpResult> {
    if (!this.enabled) return disabled('市场已关闭：plugins.marketEnabled 为 false，所以不能从市场安装。打开它并重启后端后可用。');
    if (manager === undefined) {
      return { status: 501, body: { error: { code: 'not-implemented', message: '没有注入 PluginManager：这条实例不提供插件管理' } } };
    }

    const id = typeof payload['id'] === 'string' ? payload['id'].trim() : '';
    if (!/^[a-z0-9-]{1,64}$/.test(id)) {
      return failure(400, MARKET_ERROR_CODES.requestInvalid, `缺少合法的 id（1–64 位小写字母/数字/连字符）：${JSON.stringify(payload['id'])}`);
    }
    const versionRaw = payload['version'];
    if (versionRaw !== undefined && (typeof versionRaw !== 'string' || versionRaw.trim() === '')) {
      return failure(400, MARKET_ERROR_CODES.requestInvalid, `version 必须是字符串：${JSON.stringify(versionRaw)}`);
    }
    // **只认索引**：URL 与 sha256 是防篡改的两个固定点，绝不允许调用方自带一份来"覆盖"它们。
    for (const forbidden of ['url', 'sha256', 'size'] as const) {
      if (Object.prototype.hasOwnProperty.call(payload, forbidden)) {
        return failure(
          400,
          MARKET_ERROR_CODES.requestInvalid,
          `plugin-market-install 不接受 body 里的 ${forbidden}：包的地址、sha256 与大小一律取自市场索引（只接受 id 与可选 version）`,
        );
      }
    }

    try {
      const loaded = await this.loadIndex(false);
      const selection = selectRelease(loaded.index, id, {
        ...(typeof versionRaw === 'string' ? { version: versionRaw.trim() } : {}),
        engine: this.hostVersion,
      });
      if (!selection.ok) return selectionFailure(selection);

      const entry = selection.plugin;
      const release = selection.release;
      const stagingRoot = mkdtempSync(join(this.tempDir ?? tmpdir(), 'irmia-market-stage-'));
      try {
        // 第一段：校验下载（sha256/size/包身份）并解包到 staging 的临时包仓库。
        // 用 staging 而不是直接写 dataDir，是为了把"真正落进正式包仓库"这一步留给
        // PluginManager.install——安装的原子性/扫描/内容寻址只有一处实现。
        const staged = await verifyAndInstall(
          {
            dataDir: stagingRoot,
            fetch: this.fetchImpl,
            timeoutMs: this.timeoutMs,
            ...(this.tempDir === undefined ? {} : { tempDir: this.tempDir }),
          },
          {
            url: release.url,
            sha256: release.sha256,
            size: release.size,
            id: entry.id,
            version: release.version,
          },
        );
        // 第二段：交给 manager 的正式安装流程（它自己再扫一遍、按内容哈希原子落盘）。
        const installed = manager.install(staged.rootDir);
        if (installed.contentHash !== staged.contentHash) {
          throw new MarketError(
            MARKET_ERROR_CODES.packageMismatch,
            `安装结果的内容哈希与校验过的包不一致：校验 ${staged.contentHash}，安装 ${installed.contentHash}`,
            { detail: { checkedContentHash: staged.contentHash, installedContentHash: installed.contentHash } },
          );
        }
        manager.recordMarketOrigin(installed.manifest.id, installed.contentHash, {
          marketId: entry.id,
          version: release.version,
          installedAt: this.now().toISOString(),
        });
        const plugin = manager.list().find(
          (item) => item.package.manifest.id === installed.manifest.id && item.package.contentHash === installed.contentHash,
        );
        if (plugin === undefined) {
          throw new MarketError(MARKET_ERROR_CODES.installFailed, `安装完成后在插件列表里找不到 ${installed.manifest.id}@${installed.contentHash}`);
        }
        const review = this.review(entry, release, installed.manifest);
        return ok({
          ok: true,
          plugin,
          contentHash: installed.contentHash,
          market: { id: entry.id, version: release.version, url: release.url },
          permissions: review.permissions,
          net: review.net,
          runtime: installed.manifest.runtime.type,
          // 安装不改变运行组合：代码插件是热启停，declarative 包也要等 enable 那一步。
          restartRequired: false,
          review,
          next: '安装完成，但状态仍是 untrusted：必须再执行 plugin-confirm（X-Confirm: plugin-confirm）之后才能 plugin-enable。',
        });
      } finally {
        try {
          rmSync(stagingRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
        } catch {
          /* staging 在系统 TEMP 里；清理失败不改写安装结果 */
        }
      }
    } catch (error) {
      return marketFailure(error);
    }
  }

  // ── 索引读取 / 缓存 ──

  private async loadIndex(refresh: boolean): Promise<CachedIndex & { cached: boolean }> {
    const nowMs = this.now().getTime();
    if (!refresh && this.cache !== null && this.cache.url === this.indexUrl
      && nowMs - this.cache.fetchedAt < MARKET_CACHE_TTL_MS) {
      return { ...this.cache, cached: true };
    }
    const fetchedAt = this.now().getTime();
    const bytes = await this.fetchIndexBytes();
    // parseMarketIndex 自己也会卡 2MB / UTF-8 / schema / 逐条条目；这里不重复判形状。
    const parsed = parseMarketIndex(bytes);
    this.cache = { url: this.indexUrl, index: parsed.index, problems: parsed.problems, fetchedAt };
    return { ...this.cache, cached: false };
  }

  private async fetchIndexBytes(): Promise<Uint8Array> {
    let configured: URL;
    try {
      configured = new URL(this.indexUrl);
    } catch (error) {
      throw new MarketError(
        MARKET_ERROR_CODES.indexInvalid,
        `配置里的 plugins.marketIndexUrl 不是合法 URL：${JSON.stringify(this.indexUrl)}（${messageOf(error)}）`,
        { cause: error },
      );
    }
    if (configured.protocol !== 'http:' && configured.protocol !== 'https:') {
      throw new MarketError(
        MARKET_ERROR_CODES.indexInvalid,
        `配置里的 plugins.marketIndexUrl 只能是 http:// 或 https://：${JSON.stringify(this.indexUrl)}`,
      );
    }
    const origin = configured.origin;
    // 运行期再读 `market.ts` 的常量（模块之间有循环：这里不能在模块顶层碰它的导出）
    const maxIndexBytes = MARKET_LIMITS.maxIndexBytes;
    const signal = AbortSignal.timeout(this.timeoutMs);
    let current = configured;

    for (let hop = 0; hop <= MARKET_MAX_REDIRECTS; hop += 1) {
      let response: MarketHttpResponse;
      try {
        response = await this.withTimeout(
          this.fetchImpl(current.href, {
            signal,
            headers: { accept: 'application/json', 'user-agent': MARKET_USER_AGENT },
            // 重定向必须自己跟：这样"跨源跳转"在读到任何响应体之前就被拒掉。
            redirect: 'manual',
          }),
          current.href,
        );
      } catch (error) {
        if (error instanceof MarketError) throw error;
        throw this.indexFetchFailure(error, signal, current.href);
      }
      // 有些 fetch 实现（或测试替身）会忽略 redirect:'manual' 直接跟到终点：用最终 URL 兜底校验。
      if (response.url !== undefined && response.url !== '') {
        try { this.assertSameOrigin(response.url, origin, current.href); }
        catch (error) { cancelMarketResponse(response, error); throw error; }
      }
      if (isRedirect(response.status)) {
        cancelMarketResponse(response);
        if (hop === MARKET_MAX_REDIRECTS) {
          throw new MarketError(
            MARKET_ERROR_CODES.downloadFailed,
            `市场索引重定向次数过多（最多 ${MARKET_MAX_REDIRECTS} 次）：${current.href}`,
            { detail: { status: response.status, url: current.href } },
          );
        }
        const location = response.headers?.get('location') ?? '';
        if (location === '') {
          throw new MarketError(
            MARKET_ERROR_CODES.downloadFailed,
            `市场索引返回 HTTP ${response.status} 重定向但没有 Location：${current.href}`,
            { detail: { status: response.status, url: current.href } },
          );
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch (error) {
          throw new MarketError(
            MARKET_ERROR_CODES.downloadFailed,
            `市场索引重定向的 Location 不是合法 URL：${JSON.stringify(location)}（${messageOf(error)}）`,
            { cause: error, detail: { status: response.status, url: current.href } },
          );
        }
        this.assertSameOrigin(next.href, origin, current.href);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new MarketError(
            MARKET_ERROR_CODES.downloadFailed,
            `市场索引重定向到了非 http(s) 地址：${next.href}`,
            { detail: { status: response.status, url: current.href } },
          );
        }
        current = next;
        continue;
      }
      if (!response.ok) {
        cancelMarketResponse(response);
        throw new MarketError(
          MARKET_ERROR_CODES.downloadFailed,
          `取市场索引失败：GET ${current.href} 返回 HTTP ${response.status}${response.statusText === undefined || response.statusText === '' ? '' : ` ${response.statusText}`}`,
          { detail: { status: response.status, url: current.href } },
        );
      }

      try {
        return await this.withTimeout(readBoundedMarketBody(response, maxIndexBytes, (actualBytes, declared) => new MarketError(
          MARKET_ERROR_CODES.indexTooLarge,
          `市场索引${declared ? '声明' : '实际'} ${actualBytes} 字节，超过 ${maxIndexBytes} 字节上限（${current.href}）`,
          { detail: { ...(declared ? { declaredBytes: actualBytes } : { actualBytes }), maxBytes: maxIndexBytes, url: current.href } },
        ), signal), current.href);
      } catch (error) {
        if (error instanceof MarketError) throw error;
        throw this.indexFetchFailure(error, signal, current.href);
      }
    }
    // 上面的循环要么 return、要么 throw；这里只是让 TS 看到穷尽。
    throw new MarketError(MARKET_ERROR_CODES.downloadFailed, `市场索引重定向次数过多：${configured.href}`);
  }

  private assertSameOrigin(raw: string, origin: string, from: string): void {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new MarketError(MARKET_ERROR_CODES.downloadFailed, `市场索引返回了不合法的地址：${JSON.stringify(raw)}（来自 ${from}）`);
    }
    if (url.origin !== origin) {
      throw new MarketError(
        MARKET_ERROR_CODES.downloadFailed,
        `市场索引重定向到了不同源（${url.origin}），已拒绝：只允许配置里那一个地址及其同源重定向（来自 ${from}）`,
        { detail: { from, to: url.href, allowedOrigin: origin } },
      );
    }
  }

  private indexFetchFailure(error: unknown, signal: AbortSignal, url: string): MarketError {
    const aborted = signal.aborted || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'));
    if (aborted) {
      return new MarketError(
        MARKET_ERROR_CODES.aborted,
        `取市场索引超时（${this.timeoutMs}ms）：${url}`,
        { cause: error, detail: { timeoutMs: this.timeoutMs, url } },
      );
    }
    return new MarketError(
      MARKET_ERROR_CODES.downloadFailed,
      `取市场索引失败：GET ${url} —— ${messageOf(error)}`,
      { cause: error, detail: { url } },
    );
  }

  /**
   * 硬时限：除了 `AbortSignal.timeout` 让真 fetch 自己断，还在这一层与它赛跑。
   *
   * 为什么两条都要：真实 fetch 会在 signal 上断，但测试替身/某些 polyfill 可能不理会
   * signal；只靠 signal 会让"超时"退化成"挂到天荒地老"。赛跑只用于**取索引**——
   * 包下载不能这样截断（截断后那边可能还在往临时目录写），它继续靠 signal。
   */
  private async withTimeout<T>(promise: Promise<T>, url: string): Promise<T> {
    const timeoutMs = Math.max(1, this.timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new MarketError(
          MARKET_ERROR_CODES.aborted,
          `取市场索引超时（${timeoutMs}ms）：${url}`,
          { detail: { timeoutMs, url } },
        ));
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // ── 视图 ──

  private pluginEntryView(entry: MarketPluginEntry): Record<string, unknown> {
    return {
      id: entry.id,
      title: entry.title ?? null,
      author: entry.author ?? null,
      desc: entry.desc ?? null,
      latest: entry.latest ?? null,
      versions: entry.versions.map((release) => this.releaseView(release)),
    };
  }

  private releaseView(release: MarketRelease): MarketReleaseView {
    return {
      version: release.version,
      apiVersion: release.apiVersion,
      engine: release.engine,
      size: release.size,
      sha256: release.sha256,
      permissions: [...release.permissions],
      net: [...(release.net ?? [])],
      runtime: release.runtime,
      url: release.url,
    };
  }

  private releaseReview(release: MarketRelease): MarketReleaseReview {
    const verdict = this.engineVerdict(release.engine);
    return {
      ...this.releaseView(release),
      compatible: verdict.compatible,
      compatibility: verdict.reason,
    };
  }

  private engineVerdict(engine: string): { compatible: boolean; reason: string | null } {
    try {
      if (isPluginEngineCompatible(engine, this.hostVersion)) return { compatible: true, reason: null };
      return { compatible: false, reason: `需要 Irmia ${engine}，当前宿主是 ${this.hostVersion}` };
    } catch (error) {
      return { compatible: false, reason: `无法判断兼容性：${messageOf(error)}（engine=${JSON.stringify(engine)}，宿主=${this.hostVersion}）` };
    }
  }

  private indexReview(entry: MarketPluginEntry, release: MarketRelease): MarketIndexReview {
    const permissions = [...release.permissions];
    const net = [...(release.net ?? [])];
    return {
      marketId: entry.id,
      version: release.version,
      runtime: release.runtime,
      engine: release.engine,
      size: release.size,
      sha256: release.sha256,
      permissions,
      net,
      basis: 'index',
      indexPermissions: permissions,
      indexNet: net,
      packagePermissions: null,
      packageNet: null,
      netMismatch: false,
      permissionsMismatch: false,
      warnings: [],
    };
  }

  /**
   * 安装后的完整审阅：**包内清单是执行期真正生效的那一份**。
   *
   * 索引与包内不一致时**不拒绝安装**（包已经通过 sha256/内容哈希/安装器三重校验，拒装
   * 反而是在惩罚一个合法的包），但必须在回执里显眼地说出来——所以 warnings 一定逐条写明
   * "索引是什么、包内是什么、以哪边为准"。
   */
  private review(entry: MarketPluginEntry, release: MarketRelease, manifest: PluginManifest): MarketIndexReview {
    const indexPermissions = [...release.permissions];
    const indexNet = [...(release.net ?? [])];
    const packagePermissions = [...manifest.permissions];
    const packageNet = [...manifest.netAllow];
    const permissionsMismatch = !sameStringSet(indexPermissions, packagePermissions);
    const netMismatch = !sameStringSet(indexNet, packageNet);
    const warnings: string[] = [];
    if (netMismatch) {
      warnings.push(
        `索引与包内声明不一致（net.allow）：索引为 [${indexNet.join(', ')}]，包内为 [${packageNet.join(', ')}]；`
        + '按包内 plugin.json 执行（包内为准）。',
      );
    }
    if (permissionsMismatch) {
      warnings.push(
        `索引与包内声明不一致（permissions）：索引为 [${indexPermissions.join(', ')}]，包内为 [${packagePermissions.join(', ')}]；`
        + '按包内 plugin.json 执行（包内为准）。',
      );
    }
    return {
      marketId: entry.id,
      version: release.version,
      runtime: manifest.runtime.type,
      engine: release.engine,
      size: release.size,
      sha256: release.sha256,
      permissions: packagePermissions,
      net: packageNet,
      basis: 'package',
      indexPermissions,
      indexNet,
      packagePermissions,
      packageNet,
      netMismatch,
      permissionsMismatch,
      warnings,
    };
  }
}

// ──────────────────────────────── 结果/错误映射 ────────────────────────────────

function ok(body: unknown): MarketHttpResult {
  return { status: 200, body };
}

function failure(status: number, code: string, message: string): MarketHttpResult {
  return { status, body: { error: { code, message } } };
}

function disabled(message: string): MarketHttpResult {
  return failure(501, 'market-disabled', message);
}

function selectionFailure(selection: Extract<ReturnType<typeof selectRelease>, { ok: false }>): MarketHttpResult {
  const status = selection.code === MARKET_ERROR_CODES.pluginNotFound || selection.code === MARKET_ERROR_CODES.versionNotFound
    ? 404
    : selection.code === MARKET_ERROR_CODES.engineIncompatible ? 409 : 400;
  return failure(status, selection.code, selection.message);
}

function statusForCode(code: MarketErrorCode): number {
  switch (code) {
    case MARKET_ERROR_CODES.pluginNotFound:
    case MARKET_ERROR_CODES.versionNotFound:
      return 404;
    case MARKET_ERROR_CODES.engineIncompatible:
      return 409;
    case MARKET_ERROR_CODES.indexInvalid:
    case MARKET_ERROR_CODES.indexTooLarge:
    case MARKET_ERROR_CODES.downloadFailed:
      return 502;
    case MARKET_ERROR_CODES.entryInvalid:
      return 502;
    case MARKET_ERROR_CODES.aborted:
      return 504;
    case MARKET_ERROR_CODES.invalidEngine:
      return 500;
    case MARKET_ERROR_CODES.requestInvalid:
    case MARKET_ERROR_CODES.packageTooLarge:
    case MARKET_ERROR_CODES.sizeMismatch:
    case MARKET_ERROR_CODES.hashMismatch:
    case MARKET_ERROR_CODES.archiveInvalid:
    case MARKET_ERROR_CODES.packageMismatch:
    case MARKET_ERROR_CODES.installFailed:
      return 400;
  }
}

function marketFailure(error: unknown): MarketHttpResult {
  if (error instanceof MarketError) {
    return {
      status: statusForCode(error.code),
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(Object.keys(error.detail).length === 0 ? {} : { detail: error.detail }),
        },
      },
    };
  }
  return failure(500, MARKET_ERROR_CODES.installFailed, `市场操作失败：${messageOf(error)}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** 顺序无关的字符串集合比较：索引与包内声明的顺序可能不同，但语义是集合。 */
function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
