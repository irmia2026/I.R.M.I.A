/**
 * DeepSeek 余额（官方 `GET /user/balance`）的唯一取数和格式化实现。
 *
 * 为什么单独一层：余额是**宿主事实**，不能让 render 在读上下文时发网络请求
 * （缓存铁律 1）。这里按固定间隔刷新成一个内存快照，RenderInput 只拿快照。
 * key 不离开这个模块，也不写事件日志。
 */

export interface BalanceFacts {
  isAvailable: boolean;
  balances: DeepSeekBalanceInfo[];
  fetchedAtMs: number;
}

export interface DeepSeekBalanceSnapshot extends BalanceFacts {}
export interface DeepSeekBalanceInfo {
  currency: string;
  total: string;
  granted: string;
  toppedUp: string;
}

export function isDeepSeekBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'api.deepseek.com' || host.endsWith('.deepseek.com');
  } catch {
    return false;
  }
}

export function deepSeekBalanceUrl(baseUrl: string): string {
  return new URL('/user/balance', baseUrl).toString();
}

export interface DeepSeekBalanceOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** 余额不是实时计费，默认 5 分钟刷新一次。 */
  intervalMs?: number;
  timeoutMs?: number;
  /** 测试可关掉自动启动，手动调 refresh()。 */
  autoStart?: boolean;
}

export class DeepSeekBalanceService {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #intervalMs: number;
  readonly #timeoutMs: number;
  readonly #timer: NodeJS.Timeout | null;
  #snapshot: DeepSeekBalanceSnapshot | null = null;
  #inFlight: Promise<void> | null = null;

  constructor(options: DeepSeekBalanceOptions) {
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? (() => Date.now());
    this.#intervalMs = options.intervalMs ?? 5 * 60_000;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (options.autoStart !== false) {
      void this.refresh();
      this.#timer = setInterval(() => { void this.refresh(); }, this.#intervalMs);
      this.#timer.unref?.();
    } else {
      this.#timer = null;
    }
  }

  snapshot(): DeepSeekBalanceSnapshot | null {
    return this.#snapshot === null ? null : { ...this.#snapshot, balances: this.#snapshot.balances.map((item) => ({ ...item })) };
  }

  async refresh(): Promise<void> {
    if (this.#inFlight !== null) return this.#inFlight;
    const task = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        const response = await this.#fetch(deepSeekBalanceUrl(this.#baseUrl), {
          method: 'GET',
          headers: { authorization: `Bearer ${this.#apiKey}`, accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) return;
        const parsed: unknown = await response.json();
        if (typeof parsed !== 'object' || parsed === null) return;
        const record = parsed as Record<string, unknown>;
        const infos = Array.isArray(record['balance_infos']) ? record['balance_infos'] : [];
        const balances: DeepSeekBalanceInfo[] = [];
        for (const item of infos) {
          if (typeof item !== 'object' || item === null) continue;
          const row = item as Record<string, unknown>;
          if (typeof row['currency'] !== 'string'
            || typeof row['total_balance'] !== 'string'
            || typeof row['granted_balance'] !== 'string'
            || typeof row['topped_up_balance'] !== 'string') continue;
          balances.push({
            currency: row['currency'],
            total: row['total_balance'],
            granted: row['granted_balance'],
            toppedUp: row['topped_up_balance'],
          });
        }
        if (balances.length === 0) return;
        this.#snapshot = {
          isAvailable: record['is_available'] === true,
          balances,
          fetchedAtMs: this.#now(),
        };
      } catch {
        // 网络失败/超时保留上一份快照；没有快照就整行不出现。
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => { this.#inFlight = null; });
    this.#inFlight = task;
    return task;
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
  }
}

/** 把快照渲染成此刻层的一行；没有可用信息返回 null。 */
export function formatDeepSeekBalance(snapshot: DeepSeekBalanceSnapshot | null): string | null {
  if (snapshot === null || snapshot.balances.length === 0) return null;
  const parts = snapshot.balances.map((info) => {
    const extras: string[] = [];
    if (info.granted !== '') extras.push(`赠金 ${info.granted}`);
    if (info.toppedUp !== '') extras.push(`充值 ${info.toppedUp}`);
    return `${info.currency} ${info.total}` + (extras.length === 0 ? '' : `（${extras.join(' · ')}）`);
  });
  return `DeepSeek API 余额：${snapshot.isAvailable ? '' : '⚠ 不可用 · '}${parts.join(' · ')}`;
}
