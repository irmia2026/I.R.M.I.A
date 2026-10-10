/**
 * Irmia Agent — 持久定时器模块
 *
 * 对齐 docs/design.md §4.3、§4.22 与 docs/schema.md §5，四个硬要求：
 *   1. 到期时间持久化，进程重启后重新布防；
 *   2. 重启时已过期的条目立即触发（arm(entry,'now') 语义），不跳过；
 *   3. setTimeout 上限 2^31-1ms（约 24.8 天），超长延迟分段重新布防；
 *   4. save() 一律「写 .tmp + rename 覆盖」，绝不先删原文件。
 *
 * 真相源是事件日志，不是 timers.json（这是对 Cortico 的有意偏离）：
 * 本模块把盘上的表当 hint 载入，真相由调用方用日志折叠结果经 reconcile()/importEntries()
 * 覆盖回来，不一致时以日志为准并回报差异。
 *
 * 零外部依赖：只用 node: 标准库。
 */

import { readFile, rename, rm, writeFile, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { TimerEntry } from '../log/types.js';

export type { TimerEntry };

// ──────────────────────────────── 常量 ────────────────────────────────

/** setTimeout 约 24.8 天的上限；超过一秒的部分由分段布防接力 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** 重启后过期条目错峰触发的相邻最小间隔（design.md §4.3） */
export const CATCHUP_STAGGER_MS = 5_000;

/**
 * 单条 timer/set 允许的最大超前量（约 50 年）。上限只用来挡荒谬输入，
 * 不设下限：秒级/亚秒级定时器是正常用法，而一次已过期的 set 总会被立即触发
 * 且只烧一次模型调用，不会造成启动风暴（风暴由 CATCHUP_STAGGER_MS 挡住）。
 */
const MAX_HORIZON_MS = 50 * 365 * 24 * 3_600_000;

/** cron 结算下一次时最多向后搜索 4 年，覆盖 2 月 29 日这类稀疏表达式 */
const CRON_SEARCH_MINUTES = 4 * 366 * 24 * 60;

const DATE_GUARD_LIMIT = 8_640_000_000_000_000; // ±1e8 天，Date 的合法边界

const CRON_MONTH_INDEX = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const MAX_CRON_ERRORS = 8;

// ──────────────────────────────── 类型 ────────────────────────────────

export interface TimerSetInput {
  /** ISO 8601 绝对时刻，与 cron 互斥；两者同时给出时以 at 为准 */
  at?: string;
  /** 五段 cron：分 时 日 月 周；触发后不删除条目，自动结算下一次 */
  cron?: string;
  payload?: unknown;
}

export type TimerSetResult = { ok: true; id: string } | { ok: false; error: string };

export interface StoredTimerEntry {
  timerId: string;
  /** 下一次到期时刻（ISO 8601，带时区） */
  at: string;
  cron?: string;
  payload: unknown;
  /** 离线期间被跨过的次数：只补最近一次并记录跳过了几拍 */
  skipped: number;
}

export interface TimerSnapshot {
  version: 1;
  savedAt: string;
  entries: StoredTimerEntry[];
}

/** 测试与宿主注入点：默认全部走 node: 标准库的真实实现 */
export interface TimerStoreDeps {
  now(): Date;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  /** 以 wx 排他创建并独占写入，用于 tmp 文件；临时文件绝不会覆盖任何已有文件 */
  createExclusive(path: string, data: string): Promise<void>;
  /** 分段布防的分段长度，默认 MAX_TIMEOUT_MS；测试与宿主要求更细碎分段时覆盖 */
  maxTimeoutMs?: number;
}

export interface ReconcileResult {
  /** 按 (timerId, at) 比较：日志有而盘上没有，或两者的到期时刻不一致 */
  mismatch: boolean;
  missing: string[];
  extra: string[];
  different: string[];
  sourceCount: number;
  fileCount: number;
}

// ──────────────────────────────── cron 解析（mini 版） ────────────────────────────────

/**
 * 各字段按索引存的合法值集合。`*` 的步进语法由 ParseResult 的 all 标记，
 * 命中判定统一走数组下标，避免每次触发重新解析表达式。
 */
interface CronSet {
  minute: boolean[];
  hour: boolean[];
  dom: boolean[];
  month: boolean[];
  dow: boolean[];
  domAll: boolean;
  dowAll: boolean;
  /** 原始表达式，便于日志与快照对照 */
  source: string;
}

function emptyBits(length: number): boolean[] {
  return new Array<boolean>(length).fill(false);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function parseCronField(
  raw: string,
  lo: number,
  hi: number,
  label: string,
  bits: boolean[],
  errors: string[],
): void {
  for (const part of raw.split(',')) {
    if (part === '') {
      if (errors.length <= MAX_CRON_ERRORS) errors.push(`${label}' 段含空项`);
      break;
    }
    const [base = '', stepText] = part.split('/');
    if (part.includes('/') && base === '') {
      if (errors.length <= MAX_CRON_ERRORS) errors.push(`${label}' 段的 '/' 前缺省了基数`);
      break;
    }
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) {
        if (errors.length <= MAX_CRON_ERRORS) errors.push(`${label}' 段的步长 ${stepText} 不是数字`);
        break;
      }
      step = Number(stepText);
      if (step < 1) {
        if (errors.length <= MAX_CRON_ERRORS) errors.push(`${label}' 段的步长必须 >= 1`);
        break;
      }
    }
    let from: number;
    let to: number;
    if (base === '*') {
      from = lo;
      to = hi;
    } else if (base.includes('-')) {
      const [fromText = '', toText = ''] = base.split('-');
      if (!/^\d+$/.test(fromText) || !/^\d+$/.test(toText)) {
        if (errors.length <= MAX_CRON_ERRORS) errors.push(`${label}' 段的区间 ${base} 不是数字`);
        break;
      }
      from = Number(fromText);
      to = Number(toText);
      if (from > to) {
        if (errors.length <= MAX_CRON_ERRORS) errors.push(`${label}' 段的区间 ${base} 起点大于终点`);
        break;
      }
    } else {
      if (!/^\d+$/.test(base)) {
        if (errors.length <= MAX_CRON_ERRORS) errors.push(`${label}' 段的值 ${base} 不是数字`);
        break;
      }
      from = Number(base);
      to = stepText === undefined ? from : hi;
    }
    if (from < lo || to > hi) {
      if (errors.length <= MAX_CRON_ERRORS) errors.push(`${label}' 段的取值 ${base} 超出 [${lo},${hi}]`);
      break;
    }
    // 星期 7 与 0 同为周日
    for (let v = from; v <= to; v += step) bits[v === hi + 1 && label === 'dow' ? lo : v] = true;
    if (label === 'dow' && to === 7) bits[0] = true;
  }
}

export type CronParseResult = { ok: true; cron: CronSet } | { ok: false; error: string };

/**
 * 解析五段 cron：`分 时 日 月 周`，支持 `*` `,` `-` `/` 与数字。
 * 不支持名称别名（JAN/MON）与 `@daily` 之类的宏，遇到就报错，不猜。
 */
export function parseCron(expr: string): CronParseResult {
  const text = expr.trim();
  if (text === '') return { ok: false, error: 'cron 表达式为空' };
  const fields = text.split(/\s+/);
  if (fields.length !== 5) {
    return { ok: false, error: `cron 需要 5 段（分 时 日 月 周），实际 ${fields.length} 段` };
  }
  const parts: string[] = [];
  for (let i = 0; i < 5; i++) parts.push(fields[i] ?? '');

  const cron: CronSet = {
    minute: emptyBits(60),
    hour: emptyBits(24),
    dom: emptyBits(32),
    month: emptyBits(13),
    dow: emptyBits(7),
    domAll: false,
    dowAll: false,
    source: text,
  };
  const errors: string[] = [];
  parseCronField(parts[0] ?? '', 0, 59, '分', cron.minute, errors);
  parseCronField(parts[1] ?? '', 0, 23, '时', cron.hour, errors);
  parseCronField(parts[2] ?? '', 1, 31, '日', cron.dom, errors);
  parseCronField(parts[3] ?? '', 1, 12, '月', cron.month, errors);
  parseCronField(parts[4] ?? '', 0, 7, 'dow', cron.dow, errors);

  if (errors.length > 0) return { ok: false, error: errors.join('；') };
  cron.domAll = parts[2] === '*' || parts[2]?.startsWith('*/') === true;
  cron.dowAll = parts[4] === '*' || parts[4]?.startsWith('*/') === true;
  if (!cron.minute.some(Boolean) || !cron.hour.some(Boolean) || !cron.month.some(Boolean)) {
    return { ok: false, error: 'cron 的 分/时/月 段无任何可匹配值' };
  }
  return { ok: true, cron };
}

/**
 * vixie cron 语义：日与周两段同时受限时取「或」，否则必须同时命中。
 * 返回 false 表示该 cron 永不触发（例如 2 月 30 日），调用方应当拒绝布防。
 */
function cronMatches(cron: CronSet, d: Date): boolean {
  if (cron.minute[d.getMinutes()] !== true) return false;
  if (cron.hour[d.getHours()] !== true) return false;
  const month = (CRON_MONTH_INDEX[d.getMonth()] ?? 0);
  if (cron.month[month] !== true) return false;
  const domHit = cron.dom[d.getDate()] === true;
  const dowHit = cron.dow[d.getDay()] === true;
  if (!cron.domAll && !cron.dowAll) return domHit || dowHit;
  if (!cron.domAll && !domHit) return false;
  if (!cron.dowAll && !dowHit) return false;
  return true;
}

/**
 * 计算 `after` 之后的下一个匹配分钟；找不到（或超过 4 年）返回 null。
 * 用本地日历字段推进（cron 的「日/月/周」按机器本地时间理解，与系统 cron 一致），
 * 再按绝对毫秒逐分钟前推，夏令时切换也不会漏拍或重复。
 */
export function nextCronTime(cron: CronSet, after: Date): Date | null {
  let curMs = (Math.floor(after.getTime() / 60_000) + 1) * 60_000;
  for (let i = 0; i < CRON_SEARCH_MINUTES; i++) {
    const candidate = new Date(curMs);
    if (cron.month[(CRON_MONTH_INDEX[candidate.getMonth()] ?? 0)] === true && cronMatches(cron, candidate)) {
      return candidate;
    }
    curMs += 60_000;
  }
  return null;
}

// ──────────────────────────────── 解析工具 ────────────────────────────────

function isValidDate(d: Date): boolean {
  return !Number.isNaN(d.getTime()) && Math.abs(d.getTime()) <= DATE_GUARD_LIMIT;
}

/**
 * 只接受带时区的 ISO 8601。不带时区的本地时间在无人值守场景里是隐患
 * （时区/夏令时切换会让「什么时候醒」不可复现），所以直接拒绝。
 */
function parseIso(text: string): Date | null {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return null;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  return isValidDate(d) ? d : null;
}

function canonicalIso(d: Date): string {
  // 存 UTC（带 Z）而不是本地偏移：跨时区重启后语义不变；毫秒必须保留，
  // 截断会让 'now + 50ms' 落回 now，被误判成已过期而跳过等待
  return d.toISOString();
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** 字段顺序稳定的规范化序列化，用于「快照是否一致」的比较与落盘 */
function normalizeEntry(e: { timerId: string; at: string; cron?: string; payload: unknown; skipped: number }): string {
  return JSON.stringify([e.timerId, e.at, e.cron ?? null, e.payload ?? null, e.skipped]);
}

interface ValidateOptions {
  /** 要求 at 存在（盘上的表与日志折叠结果都必须有确定到期时刻） */
  requireAt: boolean;
  nowMs: number;
  label: string;
}

interface ValidatedEntry {
  timerId: string;
  at: string;
  cron?: string;
  payload: unknown;
  skipped: number;
}

function validateEntry(raw: unknown, opts: ValidateOptions): { value: ValidatedEntry } | { error: string } {
  if (!isRecord(raw)) return { error: `${opts.label} 不是对象` };
  const timerId = raw['timerId'];
  if (typeof timerId !== 'string' || timerId === '') return { error: `${opts.label} 的 timerId 非法` };

  const payload: unknown = raw['payload'] ?? null;
  try {
    JSON.stringify(payload);
  } catch {
    return { error: `${opts.label} 的 payload 无法序列化` };
  }

  let cron: string | undefined;
  if (raw['cron'] !== undefined && raw['cron'] !== null && raw['cron'] !== '') {
    if (typeof raw['cron'] !== 'string') return { error: `${opts.label} 的 cron 非法` };
    const parsed = parseCron(raw['cron']);
    if (!parsed.ok) return { error: `${opts.label} 的 cron 非法：${parsed.error}` };
    cron = raw['cron'].trim();
  }

  let at: string;
  const atRaw = raw['at'];
  if (atRaw === undefined || atRaw === null || atRaw === '') {
    if (opts.requireAt) return { error: `${opts.label} 缺少 at` };
    // 只有 cron 时先占一个哨兵到期时刻，由布防阶段结算真实下一次
    at = canonicalIso(new Date(opts.nowMs));
  } else {
    if (typeof atRaw !== 'string') return { error: `${opts.label} 的 at 非法` };
    const d = parseIso(atRaw);
    if (d === null) return { error: `${opts.label} 的 at 不是带时区的 ISO 8601：${atRaw}` };
    // 已过期的 at 是合法状态（离线期间到期），由布防阶段决定立即触发或错峰补触发
    at = canonicalIso(d);
  }

  const skippedRaw = raw['skipped'];
  let skipped = 0;
  if (skippedRaw !== undefined) {
    if (typeof skippedRaw !== 'number' || !Number.isInteger(skippedRaw) || skippedRaw < 0) {
      return { error: `${opts.label} 的 skipped 非法` };
    }
    skipped = skippedRaw;
  }

  return { value: cron === undefined ? { timerId, at, payload, skipped } : { timerId, at, cron, payload, skipped } };
}

// ──────────────────────────────── 默认依赖 ────────────────────────────────

function hasCode(err: unknown, code: string): boolean {
  return isRecord(err) && err['code'] === code;
}

const defaultDeps: TimerStoreDeps = {
  now: () => new Date(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: async (path, data) => {
    await writeFile(path, data, 'utf8');
  },
  rename: async (from, to) => {
    await rename(from, to);
  },
  rm: async (path, options) => {
    await rm(path, { force: options?.force ?? false });
  },
  mkdir: async (path, options) => mkdir(path, options),
  createExclusive: async (path, data) => {
    const handle = await open(path, 'wx');
    try {
      await handle.truncate(0);
      await handle.writeFile(data, 'utf8');
      // 先让数据落盘，再 rename：rename 之后不存在「名字已就位、内容还在页缓存」的窗口
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

// ──────────────────────────────── TimerStore ────────────────────────────────

interface Armed {
  handle: unknown;
  /** 布防时的时间代数：stop() 或重建后旧 handle 即便漏进来也不会被当真 */
  generation: number;
}

interface ArmOptions {
  /** 宿主要求清空 skipped 计数 */
  resetSkip?: boolean;
}

export class TimerStore {
  private readonly deps: TimerStoreDeps;
  private readonly maxTimeoutMs: number;
  private readonly staggerMs: number;

  #filePath: string | null;
  #savePath: string | null;
  #entries = new Map<string, StoredTimerEntry>();
  #armed = new Map<string, Armed>();
  #onDue: ((entry: StoredTimerEntry) => void) | null = null;
  #running = false;
  #warnings: string[] = [];
  #seq = 0;
  #generation = 0;
  /** 错峰游标：恢复期下一次补触发不得早于该时刻 */
  #staggerNextAt = 0;
  #staggering = false;
  /** 本次恢复窗口是否已经排过补触发：第一条立即走，其余让出间隔 */
  #staggerArmed = false;
  /** 落盘串行链的链尾。触发路径上的 save 是 fire-and-forget，但宿主可以 await flush() 等它落定 */
  #saveChain: Promise<void> = Promise.resolve();

  /** 构造即读盘（design.md §4.3 第 1 点），但此时没有 onDue，不会触发任何定时器 */
  constructor(filePath: string | null = null, deps: Partial<TimerStoreDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
    this.#filePath = filePath;
    this.#savePath = filePath;
    this.maxTimeoutMs = Math.min(this.deps.maxTimeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
    this.staggerMs = CATCHUP_STAGGER_MS;
  }

  // ── 生命周期 ──

  /** 载入盘上的 hint 表。文件缺失、损坏、含非法条目都只记 warning，绝不让启动失败 */
  async load(): Promise<void> {
    const path = this.#filePath;
    if (path === null) return;
    let text: string;
    try {
      text = await this.deps.readFile(path);
    } catch (err) {
      if (hasCode(err, 'ENOENT')) return;
      this.#warnings.push(`load: 读取 ${path} 失败：${toErrorMessage(err)}`);
      return;
    }
    const root = parseObject(text);
    if (root === null) {
      this.#warnings.push(`load: ${path} 不是合法 JSON 对象，按空表继续（真相以日志为准）`);
      return;
    }
    const rawList: unknown = root['entries'];
    if (!Array.isArray(rawList)) {
      this.#warnings.push(`load: ${path} 缺少 entries 数组，按空表继续`);
      return;
    }

    const nowMs = this.deps.now().getTime();
    const rejected: string[] = [];
    const accepted: StoredTimerEntry[] = [];
    for (const raw of rawList) {
      const label = `load: ${path} 的表项`;
      const res = validateEntry(raw, { requireAt: true, nowMs, label });
      if ('error' in res) {
        rejected.push(res.error);
        continue;
      }
      accepted.push({ ...res.value });
    }

    this.#entries.clear();
    const duplicate: string[] = [];
    for (const entry of accepted) {
      const res = this.addEntry(entry);
      if (res.error !== null) duplicate.push(res.error);
    }
    if (rejected.length > 0) {
      const head = rejected.slice(0, 3).join(' | ');
      this.#warnings.push(`load: 跳过 ${rejected.length} 个非法表项：${head}`);
    }
    if (duplicate.length > 0) {
      const head = duplicate.slice(0, 3).join(' | ');
      this.#warnings.push(`load: 去重 ${duplicate.length} 个同 id 表项：${head}`);
    }
  }

  /** 布防。已布防时再次调用不重复布防；已过期的条目立即触发或按错峰补触发 */
  start(onDue: (entry: StoredTimerEntry) => void): void {
    this.#onDue = onDue;
    if (this.#running) return;
    this.#running = true;
    this.#warnings.length = 0;
    for (const id of [...this.#armed.keys()]) this.armedDelete(id);

    const nowMs = this.deps.now().getTime();
    const overdue: StoredTimerEntry[] = [];
    for (const entry of [...this.#entries.values()]) {
      if (Date.parse(entry.at) <= nowMs) overdue.push(entry);
      else this.arm(entry.timerId, {});
    }
    if (overdue.length === 0) return;

    // 错峰游标：第一条过期条目立即触发，其后每条至少让出 staggerMs。
    // 用调度延迟而不是在 onDue 里 sleep，避免挡住事件循环。
    this.#staggering = true;
    this.#staggerArmed = false;
    this.#staggerNextAt = 0;
    const ordered = [...overdue].sort((a, b) => this.compareDue(a, b));
    for (const entry of ordered) this.arm(entry.timerId, {});
    this.#staggering = false;
    if (overdue.length > 1) {
      // 注：游标从 0 起算，第一条立即触发，第二条起才让出间隔
      this.#warnings.push(
        `start: ${overdue.length} 个条目已过期，按到期先后串行补触发，相邻间隔 >= ${this.staggerMs}ms`,
      );
    }
  }

  /** 停止：清掉所有在途 handle 与错峰状态；不改动表，也不删文件 */
  stop(): void {
    this.#running = false;
    this.#onDue = null;
    this.#staggering = false;
    this.#staggerNextAt = 0;
    for (const id of [...this.#armed.keys()]) this.armedDelete(id);
  }

  // ── 操作 ──

  /**
   * 新增或整体替换一个定时器（同 id 覆盖会重新布防）。
   * at 与 cron 同时给出时以 at 为准并记 warning。
   */
  async set(input: TimerSetInput): Promise<TimerSetResult> {
    const nowMs = this.deps.now().getTime();
    const cronRaw = typeof input.cron === 'string' ? input.cron.trim() : undefined;
    const atRaw = input.at;
    let cron: string | undefined;
    let at: string;

    if (atRaw !== undefined) {
      if (typeof atRaw !== 'string') return { ok: false, error: 'at 必须是字符串' };
      const d = parseIso(atRaw);
      if (d === null) return { ok: false, error: `at 不是带时区的 ISO 8601：${atRaw}` };
      if (d.getTime() - nowMs > MAX_HORIZON_MS) return { ok: false, error: 'at 超前超过 50 年' };
      at = canonicalIso(d);
      if (cronRaw !== undefined && cronRaw !== '') {
        this.#warnings.push('set: at 与 cron 同时给出，以 at 为准，cron 被忽略');
      }
    } else {
      if (cronRaw === undefined || cronRaw === '') {
        return { ok: false, error: 'at 与 cron 至少提供一个' };
      }
      const parsed = parseCron(cronRaw);
      if (!parsed.ok) return { ok: false, error: `cron 非法：${parsed.error}` };
      const next = nextCronTime(parsed.cron, this.deps.now());
      if (next === null) return { ok: false, error: `cron 永不触发：${cronRaw}` };
      if (next.getTime() - nowMs > MAX_HORIZON_MS) return { ok: false, error: 'cron 的下一次到期超过 50 年' };
      cron = cronRaw;
      at = canonicalIso(next);
    }

    let payload: unknown;
    try {
      payload = input.payload ?? null;
      JSON.stringify(payload);
    } catch (err) {
      return { ok: false, error: `payload 无法序列化：${toErrorMessage(err)}` };
    }

    const id = this.nextId();
    const entry: StoredTimerEntry = cron === undefined
      ? { timerId: id, at, payload, skipped: 0 }
      : { timerId: id, at, cron, payload, skipped: 0 };
    this.#entries.set(id, entry);
    this.arm(id, { resetSkip: true });
    // 先落盘再返回：崩溃恢复时表里不该缺掉一个已经报过 ok 的定时器
    await this.save();
    return { ok: true, id };
  }

  /** 取消条目：在途 handle 与错峰状态一并清理，然后落盘 */
  async cancel(id: string): Promise<boolean> {
    const existed = this.#entries.delete(id);
    this.armedDelete(id);
    if (existed) await this.save();
    return existed;
  }

  /** 表项的只读副本（按到期先后排序） */
  list(): StoredTimerEntry[] {
    const all = [...this.#entries.values()].sort((a, b) => this.compareDue(a, b));
    return all.map((e) => ({ ...e }));
  }

  /**
   * 现在几点（毫秒）——**与调度用的是同一个时钟**（`deps.now`）。
   *
   * 为什么要把它露出来（2026-10-08，`timer action=wait`）：那一个动作要把"多久之后"算成一个
   * 绝对时刻（`at = 现在 + 时长`），而"现在"只能有一处。工具层自己 `new Date()` 的话，
   * 两种时钟一旦分岔（测试注入的时钟、宿主给 `--data-dir` 场景的固定时钟），
   * 算出来的 `at` 与调度器认的时刻就不是一回事——排出去的唤醒会在错的时刻响，
   * 而那种错从回执上完全看不出来。判据收在这里：**排定时器的那个时钟就是报时刻的那个时钟**。
   */
  nowMs(): number {
    return this.deps.now().getTime();
  }

  get(id: string): StoredTimerEntry | null {
    const entry = this.#entries.get(id);
    return entry === undefined ? null : { ...entry };
  }

  /** 在途 handle 数：>1 说明有分段布防或错峰补触发正在进行 */
  armedCount(): number {
    return this.#armed.size;
  }

  /** 盘上的表在载入/校准时发现的异常，供启动流程写日志与告警 */
  warnings(): string[] {
    return [...this.#warnings];
  }

  // ── 真相源校准 ──

  /** 当前表的确定性快照：与同一份日志折叠结果逐字段可比 */
  snapshotFromEntries(): StoredTimerEntry[] {
    return this.list();
  }

  /**
   * 用日志折叠出的定时器表覆盖内存与磁盘（design.md §4.3：以日志为准）。
   * 返回被拒绝的条目说明；可用条目即使只有一部分，也会被采用。
   */
  async importEntries(entries: readonly unknown[]): Promise<{ imported: number; rejected: string[] }> {
    const nowMs = this.deps.now().getTime();
    const next = new Map<string, StoredTimerEntry>();
    const rejected: string[] = [];
    for (const raw of entries) {
      const label = 'import: 日志折叠表项';
      const res = validateEntry(raw, { requireAt: true, nowMs, label });
      if ('error' in res) {
        rejected.push(res.error);
        continue;
      }
      if (next.has(res.value.timerId)) {
        rejected.push(`${label} 的 timerId 重复：${res.value.timerId}`);
        continue;
      }
      next.set(res.value.timerId, { ...res.value });
    }
    this.replaceAll(next.values());
    if (rejected.length > 0) {
      const head = rejected.slice(0, 3).join(' | ');
      this.#warnings.push(`import: 拒绝 ${rejected.length} 个日志表项：${head}`);
    }
    await this.save();
    return { imported: next.size, rejected };
  }

  /**
   * 启动校准：把日志派生的表和盘上 hint 比对。日志说了算——有差异就用日志的表覆盖并落盘，
   * 差异明细交还调用方写告警（review.md 缺陷 4 要求的「以日志为准并告警」）。
   */
  async reconcile(source: readonly unknown[]): Promise<ReconcileResult> {
    const nowMs = this.deps.now().getTime();
    const expected = new Map<string, StoredTimerEntry>();
    const rejected: string[] = [];
    for (const raw of source) {
      const label = 'reconcile: 日志折叠表项';
      const res = validateEntry(raw, { requireAt: true, nowMs, label });
      if ('error' in res) {
        rejected.push(res.error);
        continue;
      }
      if (expected.has(res.value.timerId)) {
        rejected.push(`${label} 的 timerId 重复：${res.value.timerId}`);
        continue;
      }
      expected.set(res.value.timerId, { ...res.value });
    }
    if (rejected.length > 0) {
      const head = rejected.slice(0, 3).join(' | ');
      this.#warnings.push(`reconcile: 忽略 ${rejected.length} 个日志表项：${head}`);
    }

    const fileIndex = new Map<string, StoredTimerEntry>();
    for (const entry of this.#entries.values()) fileIndex.set(entry.timerId, entry);

    const missing: string[] = [];
    const different: string[] = [];
    const matched = new Set<string>();
    for (const [id, entry] of expected) {
      const onFile = fileIndex.get(id);
      if (onFile === undefined) {
        missing.push(id);
        continue;
      }
      matched.add(id);
      // 到期时刻或内容任一不同都算「陈旧」，以日志的版本覆盖
      if (onFile.at !== entry.at || normalizeEntry(onFile) !== normalizeEntry(entry)) different.push(id);
    }
    const extra: string[] = [];
    for (const [id] of fileIndex) {
      if (!matched.has(id)) extra.push(id);
    }

    const mismatch = missing.length > 0 || extra.length > 0 || different.length > 0;
    if (mismatch) {
      this.replaceAll(expected.values());
      this.#warnings.push(
        `reconcile: 盘上 hint 与日志不一致（缺 ${missing.length} / 多 ${extra.length} / 不一致 ${different.length}），已按日志重建`,
      );
      await this.save();
    }
    return {
      mismatch,
      missing,
      extra,
      different,
      sourceCount: expected.size,
      fileCount: fileIndex.size,
    };
  }

  /**
   * 触发路径上的落盘是 fire-and-forget，但写链是串行的：flush() 等链尾落定，
   * 宿主在关停前 await 它即可保证盘上的表与内存一致。
   */
  async flush(): Promise<void> {
    await this.save();
  }

  /** fire-and-forget 的落盘：失败只留告警，绝不因磁盘问题打断调度 */
  private persist(): void {
    this.save().catch((err: unknown) => {
      this.#warnings.push(`save: ${toErrorMessage(err)}`);
    });
  }

  // ── 落盘 ─────────────────────────────────────────────────────────────

  /**
   * 写 .tmp + rename 覆盖。绝不先删原文件：崩溃在任何一步，原文件都保持完整
   * （milestones.md T3 的验收点）。多次并发调用被串成一条链，后写的快照一定更新，
   * 不会出现旧快照覆盖新快照。
   */
  async save(): Promise<void> {
    const next = this.#saveChain.then(() => this.writeSnapshot().catch((err: unknown) => {
      // 落盘失败不抛出：写不进盘只是丢 hint，真相源仍在日志；但必须留告警痕迹
      this.#warnings.push(`save: ${toErrorMessage(err)}`);
    }));
    this.#saveChain = next.then(
      () => undefined,
      () => undefined,
    );
    await next;
  }

  private async writeSnapshot(): Promise<void> {
    const path = this.#savePath;
    if (path === null) return;
    const snapshot: TimerSnapshot = {
      version: 1,
      savedAt: canonicalIso(this.deps.now()),
      entries: this.snapshotFromEntries(),
    };
    const body = `${JSON.stringify(snapshot, null, 2)}\n`;
    const tmp = `${path}.tmp.${process.pid}`;
    try {
      await this.deps.mkdir(dirname(path), { recursive: true });
      // wx：若残留着上一轮崩溃留下的同名 tmp，直接重建而不是追加
      await this.deps.createExclusive(tmp, body);
      await this.deps.rename(tmp, path);
    } catch (err) {
      // 原文件此时必然完好：要么是上次成功留下的旧快照，要么压根还没创建
      try {
        await this.deps.rm(tmp, { force: true });
      } catch {
        /* tmp 清理失败不影响原文件完整性，下一次 save 会重建 */
      }
      throw new Error(`写入 ${path} 失败：${toErrorMessage(err)}`);
    }
  }

  /** 重新指向另一份表文件（宿主切换 data/ 目录时用）；不自动载入，由调用方决定 */
  async setFilePath(path: string | null): Promise<void> {
    this.#filePath = path;
    this.#savePath = path;
    this.#entries.clear();
    this.#warnings.length = 0;
    await this.load();
  }

  /** 放弃 onDue 回调侧写：只回吐磁盘上原样的 JSON 文本，便于排障与人工核对 */
  async readRaw(): Promise<string | null> {
    const path = this.#filePath;
    if (path === null) return null;
    try {
      return await this.deps.readFile(path);
    } catch (err) {
      if (hasCode(err, 'ENOENT')) return null;
      throw err;
    }
  }

  // ── 内部：布防与触发 ─────────────────────────────────────────────────

  private compareDue(a: StoredTimerEntry, b: StoredTimerEntry): number {
    const diff = Date.parse(a.at) - Date.parse(b.at);
    if (diff !== 0) return diff;
    return a.timerId < b.timerId ? -1 : a.timerId > b.timerId ? 1 : 0;
  }

  private addEntry(entry: StoredTimerEntry): { id: string; error: string | null } {
    if (this.#entries.has(entry.timerId)) {
      return { id: entry.timerId, error: `timerId 重复：${entry.timerId}` };
    }
    this.#entries.set(entry.timerId, entry);
    return { id: entry.timerId, error: null };
  }

  private replaceAll(entries: Iterable<StoredTimerEntry>): void {
    this.#entries.clear();
    for (const id of [...this.#armed.keys()]) this.armedDelete(id);
    for (const entry of entries) this.#entries.set(entry.timerId, { ...entry });
    if (this.#running) {
      for (const entry of [...this.#entries.values()]) {
        this.arm(entry.timerId, {});
      }
    }
  }

  private nextId(): string {
    this.#seq += 1;
    return `t_${this.deps.now().getTime()}_${this.#seq}`;
  }

  private armedDelete(id: string): void {
    const armed = this.#armed.get(id);
    if (armed === undefined) return;
    this.#armed.delete(id);
    if (armed.handle !== null && armed.handle !== undefined) this.deps.clearTimeout(armed.handle);
  }

  /**
   * 布防一个条目：
   *   ① 没过期 → 正常排期，延迟超过 setTimeout 上限时分段接力；
   *   ② 已过期且处于恢复错峰窗口 → 排到 stagger 游标之后（第一条不等待）；
   *   ③ 已过期且不在错峰窗口 → 当场结算（arm(entry, 'now') 语义）。
   */
  private arm(id: string, opts: ArmOptions = {}): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    this.armedDelete(id);
    if (!this.#running || this.#onDue === null) return;

    const nowMs = this.deps.now().getTime();
    const dueMs = Date.parse(entry.at);
    const overdue = dueMs <= nowMs;
    // 单次布防不得超过 setTimeout 上限（约 24.8 天），超长延迟交给接力段
    let delayMs = overdue ? 0 : Math.min(dueMs - nowMs, this.maxTimeoutMs);

    if (this.#staggering && overdue) {
      // 恢复期补触发：第一条（已排序的最早到期项）立即触发，其后每条至少让出
      // staggerMs，用调度延迟实现而不是在 onDue 里 sleep
      if (this.#staggerArmed) {
        const waitMs = this.staggerTarget(nowMs) - nowMs;
        delayMs = waitMs > 0 ? waitMs : (entry.cron === undefined ? 0 : this.staggerMs);
      } else {
        this.#staggerArmed = true;
        delayMs = 0;
      }
    }

    if (delayMs <= 0) {
      this.settle(id);
      return;
    }
    this.schedule(id, delayMs, opts.resetSkip === true);
  }

  /** 错峰游标：已经让出间隔就把窗口往后推，保证相邻补触发间隔不小于 staggerMs */
  private staggerTarget(nowMs: number): number {
    const anchor = Math.max(nowMs, this.#staggerNextAt);
    const target = anchor + this.staggerMs;
    this.#staggerNextAt = target;
    return target;
  }

  private schedule(id: string, delayMs: number, resetSkip: boolean): void {
    const generation = this.#generation;
    const handle = this.deps.setTimeout(() => {
      this.onTimer(id, generation);
    }, delayMs);
    this.#armed.set(id, { handle, generation });
    if (resetSkip) {
      const entry = this.#entries.get(id);
      if (entry !== undefined && entry.skipped !== 0) this.#entries.set(id, { ...entry, skipped: 0 });
    }
  }

  /** 布防的 handle 到期：还没到点就再排一段接力，到点了才结算 */
  private onTimer(id: string, generation: number): void {
    if (generation !== this.#generation) return;
    const armed = this.#armed.get(id);
    if (armed === undefined) return;
    this.#armed.delete(id);

    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    const remainMs = Date.parse(entry.at) - this.deps.now().getTime();
    if (remainMs > 0) {
      this.schedule(id, Math.min(remainMs, this.maxTimeoutMs), false);
      return;
    }
    this.settle(id);
  }

  /**
   * 到期的结算。一次性条目触发即出表；周期条目触发后留在表里并结算下一次，
   * 离线跨过的拍次只记数不重放。回调在结算之后调用，所以回调里 list() 读到的
   * 已经是「触发后」的表。
   */
  private settle(id: string): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    const nowMs = this.deps.now().getTime();
    const dueMs = Date.parse(entry.at);

    if (entry.cron === undefined) {
      this.#entries.delete(id);
      this.persist();
      this.emit(entry);
      return;
    }

    const crossed = dueMs < nowMs ? Math.max(1, Math.floor((nowMs - dueMs) / 60_000)) : 0;
    const upcoming = this.nextCronOccurrence(entry, nowMs);
    if (upcoming === null) {
      // 表达式永不触发：剔除条目并告警，不留一个永不醒的僵尸
      this.#entries.delete(id);
      this.#warnings.push(`fire: cron 无法结算下一次，已移除条目 ${id}（${entry.cron}）`);
      this.persist();
      this.emit(entry);
      return;
    }
    this.#entries.set(id, { ...entry, at: canonicalIso(upcoming), skipped: entry.skipped + crossed });
    this.persist();
    this.emit(entry);

    // 离线太久时下一次也已经过期：逐拍向前推进并让出 staggerMs，
    // 把恢复期的唤醒风暴摊成一条平滑队列；1000 拍上限防止病态表达式烧 CPU。
    let carry = upcoming;
    let guard = 0;
    const fromMs = Math.max(nowMs - 1, dueMs);
    while (carry.getTime() <= nowMs && guard < 1_000) {
      const next = this.nextCronOccurrence(entry, Math.max(carry.getTime(), fromMs));
      if (next === null) break;
      carry = next;
      guard += 1;
    }
    const baseMs = this.deps.now().getTime();
    if (guard > 0) this.#staggerNextAt = Math.max(this.#staggerNextAt, baseMs);
    const waitMs = carry.getTime() - baseMs;
    this.schedule(id, waitMs > 0 ? Math.min(waitMs, this.maxTimeoutMs) : this.staggerMs, false);
  }

  /** 下一次到期时刻：按条目里的 cron 表达式从给定时刻往后找；解析失败返回 null */
  private nextCronOccurrence(entry: StoredTimerEntry, afterMs: number): Date | null {
    if (entry.cron === undefined) return null;
    const parsed = parseCron(entry.cron);
    if (!parsed.ok) return null;
    return nextCronTime(parsed.cron, new Date(afterMs));
  }

  private emit(entry: StoredTimerEntry): void {
    const cb = this.#onDue;
    if (cb === null) return;
    try {
      cb({ ...entry });
    } catch (err) {
      // 回调抛错不能带崩调度器
      this.#warnings.push(`onDue: ${toErrorMessage(err)}`);
    }
  }
}

// ──────────────────────────────── 便利函数 ────────────────────────────────

/** 从事件日志折叠出的表项里挑出定时器条目（timer/set 触发后 / timer/cancelled 移除） */
export function timerEntriesFromEvents(
  events: readonly { type: string; data: unknown }[],
): TimerEntry[] {
  const table = new Map<string, TimerEntry>();
  for (const event of events) {
    if (event.type === 'timer/set') {
      const data = event.data;
      if (!isRecord(data)) continue;
      const timerId = data['timerId'];
      if (typeof timerId !== 'string' || timerId === '') continue;
      const atRaw = data['at'];
      const cronRaw = data['cron'];
      const entry: TimerEntry = {
        timerId,
        payload: data['payload'] ?? null,
        ...(typeof atRaw === 'string' ? { at: atRaw } : {}),
        ...(typeof cronRaw === 'string' ? { cron: cronRaw } : {}),
      };
      if (entry.at === undefined && entry.cron === undefined) continue;
      table.set(timerId, entry);
    } else if (event.type === 'timer/cancelled') {
      const data = event.data;
      if (!isRecord(data)) continue;
      const timerId = data['timerId'];
      if (typeof timerId === 'string') table.delete(timerId);
    }
  }
  return [...table.values()].sort((a, b) => a.timerId.localeCompare(b.timerId));
}
