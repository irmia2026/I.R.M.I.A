/**
 * 更新检测的**节流与状态**（检测本身在 `./check.ts`）。
 *
 * ──────────────────────────── 为什么要单独一层 ────────────────────────────
 * `checkForUpdate` 是纯的（给参数、返回结论）。但"多久查一次、上次查到什么、失败了几次、
 * 界面该显示什么"是**跨进程重启也要保留的事实**，所以它们落盘：`<dataDir>/update-state.json`。
 * 本模块是这份状态**唯一的读写点**：事件、`GET /api/update`、下一次节流判定读的都是它。
 *
 * ──────────────────────────── 节流口径（与 docs/update-check.md §2 同源） ────────────────────────────
 *   · 启动后**先等 60 秒**再查第一次（别跟启动抢磁盘/网络）；
 *   · 正常间隔 **12 小时**（从**上一次尝试**算起，失败也算一次尝试——否则一次失败会在
 *     下一拍立刻重试，那就成了"每 12 小时最多一次"的反面）；
 *   · **连续失败 3 次之后降到 24 小时**（不吵：查不到就查不到，下一次隔更久）；
 *   · 任何一次**手动检查**（界面上那个人按的按钮）都不受节流约束——那是人的意图，
 *     不是后台任务；它同样会刷新"下一次允许时间"。
 *
 * ──────────────────────────── 失败语义 ────────────────────────────
 * `status:'unknown'` 是"这次没查到"，不是错误：
 *   · 事件照写（`update/checked`，`reason` 如实带上），日志照打一行；
 *   · **不弹窗、不进她的上下文、不产生 speak/report**（internal 事件，渲染层不认它）；
 *   · 状态文件照写，界面上只说"这次没查到（原因）"，然后等下一次。
 *
 * ──────────────────────────── 写盘 ────────────────────────────
 * 原子写（tmp + fsync + rename）复用 `web/atomic.ts` 那一份实现——`config.json` / `.auth.json`
 * 与本文件是同一类"一份被并发读改写的 JSON"，三处各写一份 rename 逻辑迟早各错各的。
 * **读坏了（不存在/不是 JSON/顶层不是对象）⇒ 当成没有状态、整份重建**：一个坏文件不该
 * 让更新检测永远停摆（下一次检查写回的就是一份干净的状态）。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { writeFileAtomicSync } from '../web/atomic.ts';
import type { UpdateChecked } from '../log/types.ts';
import {
  DEFAULT_UPDATE_TIMEOUT_MS,
  DEFAULT_UPDATE_USER_AGENT,
  checkForUpdate,
  sanitizeEndpoint,
  type UpdateChannel,
  type UpdateCheckResult,
  type UpdateMirror,
  type UpdatePlatform,
  type UpdateStatus,
} from './check.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 状态文件名（在 `<dataDir>` 下） */
export const UPDATE_STATE_FILE_NAME = 'update-state.json';

/** 正常节流窗口：12 小时 */
export const UPDATE_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** 连续失败后的窗口：24 小时 */
export const UPDATE_DEGRADED_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 连续失败几次之后降频 */
export const UPDATE_FAILURE_THRESHOLD = 3;

/** 启动后第一次检查的延迟：60 秒（别跟启动那几秒抢） */
export const UPDATE_FIRST_CHECK_DELAY_MS = 60_000;

/** 状态文件 schema 版本（只认 1；将来加字段时在这里升） */
export const UPDATE_STATE_SCHEMA = 1;

// ──────────────────────────────── 状态 ────────────────────────────────

/**
 * `update-state.json` 的形状。
 *
 * 全部字段都允许为 null：一个"从没检查过"的实例长这样，而**缺少记录不等于失败**。
 * `lastAttemptAt` 是节流的基准（失败也更新它），`lastSuccessAt` 只回答"上一次真的查到
 * 结果是什么时候"——两者分开，人才分得清"12 小时前查过、但一直没查到"。
 */
export interface UpdateState {
  schema: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: UpdateStatus | null;
  currentVersion: string | null;
  channel: UpdateChannel | null;
  /** **已脱敏**的端点（query/fragment/userinfo 都不在；见 check.ts 的 sanitizeEndpoint） */
  endpoint: string | null;
  latestVersion: string | null;
  downloadUrl: string | null;
  notesUrl: string | null;
  minimumVersion: string | null;
  /** 站点给的全部产物（GUI 下载入口按平台分流；`_pending` 的那几条也在，供界面灰掉） */
  platforms: UpdatePlatform[];
  /** 网盘分流（今天恒为 `[{provider:'pending'}]`：用户还没申请下来） */
  mirrors: UpdateMirror[];
  reason: string | null;
  consecutiveFailures: number;
}

/** 没有状态时的初值（也用于坏文件重建） */
export function emptyUpdateState(): UpdateState {
  return {
    schema: UPDATE_STATE_SCHEMA,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastStatus: null,
    currentVersion: null,
    channel: null,
    endpoint: null,
    latestVersion: null,
    downloadUrl: null,
    notesUrl: null,
    minimumVersion: null,
    platforms: [],
    mirrors: [],
    reason: null,
    consecutiveFailures: 0,
  };
}

const STATUSES: readonly UpdateStatus[] = ['none', 'available', 'required', 'unknown'];

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** 状态文件里的 `platforms[]`：形状不对的条目丢掉（它不是判据，只是给界面看的清单） */
function parsePlatformsOf(value: unknown): UpdatePlatform[] {
  if (!Array.isArray(value)) return [];
  const out: UpdatePlatform[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const os = stringOrNull(entry['os']);
    const arch = stringOrNull(entry['arch']);
    const kind = stringOrNull(entry['kind']);
    if (os === null || arch === null || kind === null) continue;
    const url = typeof entry['url'] === 'string' ? entry['url'] : '';
    out.push({ os, arch, kind, url, pending: entry['pending'] === true });
  }
  return out;
}

/** 状态文件里的 `mirrors[]`（provider 只认三档；就绪的那两档必须有地址） */
function parseMirrorsOf(value: unknown): UpdateMirror[] {
  if (!Array.isArray(value)) return [];
  const out: UpdateMirror[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const provider = entry['provider'];
    if (provider !== 'pending' && provider !== 'baidu' && provider !== 'quark') continue;
    const url = stringOrNull(entry['url']);
    if (provider !== 'pending' && url === null) continue;
    const code = stringOrNull(entry['code']);
    out.push({
      provider,
      ...(url !== null ? { url } : {}),
      ...(code !== null ? { code } : {}),
    });
  }
  return out;
}

/**
 * 解析一份状态文件的内容。
 *
 * 分两档（与 `web/auth.ts` 的凭据文件同一套分寸）：
 *   · **整份读不出来**（不存在 / 不是 JSON / 顶层不是对象）⇒ [emptyUpdateState]（重建）；
 *   · **单格不对**（时间戳不是时间、状态不在枚举里）⇒ 那一格当 null，其余照收。
 *     "坏了一格就丢掉全部"会让上一次检查的版本信息白丢，而它本来还能给界面用。
 */
export function parseUpdateState(text: string | null): UpdateState {
  const state = emptyUpdateState();
  if (text === null) return state;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return state;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return state;
  const doc = raw as Record<string, unknown>;

  state.lastAttemptAt = isoOrNull(doc['lastAttemptAt']);
  state.lastSuccessAt = isoOrNull(doc['lastSuccessAt']);
  const status = doc['lastStatus'];
  state.lastStatus = typeof status === 'string' && (STATUSES as readonly string[]).includes(status)
    ? (status as UpdateStatus)
    : null;
  state.currentVersion = stringOrNull(doc['currentVersion']);
  const channel = doc['channel'];
  state.channel = channel === 'beta' || channel === 'stable' ? channel : null;
  // 盘上的端点也重新脱敏一次：老版本/手工改过的文件可能把 query 留在这里
  state.endpoint = stringOrNull(doc['endpoint']) === null ? null : sanitizeEndpoint(stringOrNull(doc['endpoint']) ?? '');
  state.latestVersion = stringOrNull(doc['latestVersion']);
  state.downloadUrl = stringOrNull(doc['downloadUrl']);
  state.notesUrl = stringOrNull(doc['notesUrl']);
  state.minimumVersion = stringOrNull(doc['minimumVersion']);
  state.platforms = parsePlatformsOf(doc['platforms']);
  state.mirrors = parseMirrorsOf(doc['mirrors']);
  state.reason = stringOrNull(doc['reason']);
  const failures = doc['consecutiveFailures'];
  state.consecutiveFailures = typeof failures === 'number' && Number.isSafeInteger(failures) && failures >= 0
    ? Math.min(failures, 1_000)
    : 0;
  return state;
}

/** 读状态文件（不存在/坏 JSON ⇒ 空状态；**不抛**） */
export function readUpdateState(path: string): UpdateState {
  let text: string | null;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return emptyUpdateState();
  }
  return parseUpdateState(text);
}

/** 写状态文件（原子；**不抛**：写不进去只影响"下次重启还记不记得"，不该让检测失败） */
export function writeUpdateState(path: string, state: UpdateState): boolean {
  try {
    writeFileAtomicSync(path, `${JSON.stringify(state, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** 当前的节流窗口（毫秒）：连续失败达到阈值 ⇒ 24 小时，否则 12 小时 */
export function updateIntervalMs(consecutiveFailures: number): number {
  return consecutiveFailures >= UPDATE_FAILURE_THRESHOLD
    ? UPDATE_DEGRADED_INTERVAL_MS
    : UPDATE_INTERVAL_MS;
}

/** 下一次允许自动检查的时刻（毫秒）；从没尝试过 ⇒ null */
export function nextAllowedMsOf(state: UpdateState): number | null {
  if (state.lastAttemptAt === null) return null;
  const attemptedAt = Date.parse(state.lastAttemptAt);
  if (Number.isNaN(attemptedAt)) return null;
  return attemptedAt + updateIntervalMs(state.consecutiveFailures);
}

// ──────────────────────────────── 对外视图 ────────────────────────────────

/**
 * `GET /api/update` 的响应体（界面直接显示它，**文案不在这里**：这是给三种界面共用的数据，
 * 措辞由 GUI / 托盘各自的文案表决定）。
 *
 * 四个"时间"的分工：
 *   · `checkedAt`     上一次**尝试**的时刻（成功失败都算）；
 *   · `lastSuccessAt` 上一次**真的查到结果**的时刻（一直失败时它会更旧）；
 *   · `nextAllowedAt` 下一次允许自动检查的时刻（节流的唯一出口）；
 *   · `intervalHours` 当前生效的窗口长度（12 或 24）。
 */
export interface UpdateView {
  schema: number;
  enabled: boolean;
  channel: UpdateChannel;
  /** 已脱敏的端点（不含 query/fragment/userinfo） */
  endpoint: string;
  currentVersion: string;
  status: UpdateStatus;
  latestVersion: string | null;
  downloadUrl: string | null;
  notesUrl: string | null;
  minimumVersion: string | null;
  /** 站点给的全部产物（GUI 下载入口按平台分流；`_pending` 的那几条也在，供界面灰掉「待上传」） */
  platforms: UpdatePlatform[];
  /** 网盘分流（今天恒为 `[{provider:'pending'}]`：用户还没申请下来） */
  mirrors: UpdateMirror[];
  /** 官方发布页（由端点 origin 推出来：`https://<host>/releases/`）；「查看」打不开时用它 */
  releasesUrl: string;
  reason: string | null;
  checkedAt: string | null;
  lastSuccessAt: string | null;
  nextAllowedAt: string | null;
  intervalHours: number;
  consecutiveFailures: number;
  /** 这条提醒能不能被"×"关掉：`required` 不可关（低于最低可用版本，必须让人看见） */
  dismissible: boolean;
}

/** 一次主动检查的结果（`POST /api/update/check` 的响应体） */
export interface UpdateRunResult {
  /** 这一次调用**真的发过一次请求**（节流跳过/关闭时为 false） */
  performed: boolean;
  /** 没发请求的原因：`disabled` = 配置关了；`throttled` = 还在 12h/24h 窗口里 */
  skipped?: 'disabled' | 'throttled';
  view: UpdateView;
}

/** 注入给 web 层的那两个口（`web/server.ts` 只认这个接口，不认实现） */
export interface UpdateHost {
  view(): UpdateView;
  checkNow(): Promise<UpdateRunResult>;
  /**
   * 切通道（设置页 beta/stable）：**清掉节流状态**并立刻查一次。
   * 配置文件的写盘在 web 层（那里有 `withConfigDoc` 的那套校验/回滚），本方法只改**运行期**。
   */
  applyChannel(channel: UpdateChannel): Promise<UpdateRunResult>;
}

/**
 * 由端点推出**官方发布页**（`https://irmia.me/releases/latest.json` → `https://irmia.me/releases/`）。
 *
 * 界面「查看」优先用站点给的 `notesUrl`；没有时才落到这里。用端点推而不是写死官方域名：
 * 换成自建镜像的人不该被带到一个他没配置过的站点。
 */
export function releasePageUrlOf(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}/releases/`;
  } catch {
    return '';
  }
}

// ──────────────────────────────── 服务 ────────────────────────────────

export interface UpdateServiceOptions {
  /** 数据根（状态文件落在它下面） */
  dataDir: string;
  /** 本进程版本号（`AGENT_VERSION`） */
  currentVersion: string;
  /** 配置里的三个值（`update.enabled` / `.channel` / `.endpoint`） */
  enabled: boolean;
  channel: UpdateChannel;
  endpoint: string;
  now?: (() => Date) | undefined;
  /** 事件出口：与 `main.ts` 的 `append` 同形（本模块永远只写 internal） */
  emit?: ((type: 'update/checked', data: UpdateChecked['data'], visibility: 'internal') => void) | undefined;
  /** 诊断输出（一行话；**不含**端点 query、UA、任何标识） */
  out?: ((line: string) => void) | undefined;
  /** 单次请求时限（测试可调小） */
  timeoutMs?: number | undefined;
  userAgent?: string | undefined;
  /** 启动后第一次检查的延迟（测试可调成 0） */
  firstCheckDelayMs?: number | undefined;
  /** 测试注入的 fetch */
  fetchImpl?: typeof fetch | undefined;
}

export class UpdateService {
  readonly statePath: string;
  private readonly options: Required<Pick<UpdateServiceOptions, 'currentVersion' | 'enabled' | 'channel' | 'endpoint'>> & UpdateServiceOptions;
  private readonly now: () => Date;
  private readonly write: (line: string) => void;
  /** 运行期通道：设置页切换后**当场**改它（配置文件的写盘由 web 层负责），不等重启 */
  private channel: UpdateChannel;
  private state: UpdateState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 在飞的那一次检查（并发调用共享它：两条链路同时到也不发两次请求） */
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private started = false;

  constructor(options: UpdateServiceOptions) {
    this.options = options;
    this.statePath = join(resolve(options.dataDir), UPDATE_STATE_FILE_NAME);
    this.now = options.now ?? (() => new Date());
    this.write = options.out ?? (() => {});
    this.channel = options.channel;
    this.state = readUpdateState(this.statePath);
  }

  /** 当前状态快照（`GET /api/update` 与托盘都读它；每次现算，不缓存派生量） */
  view(): UpdateView {
    const nextAllowed = nextAllowedMsOf(this.state);
    const status = this.state.lastStatus ?? 'unknown';
    return {
      schema: UPDATE_STATE_SCHEMA,
      enabled: this.options.enabled,
      channel: this.channel,
      endpoint: sanitizeEndpoint(this.options.endpoint),
      currentVersion: this.options.currentVersion,
      status,
      latestVersion: this.state.latestVersion,
      downloadUrl: this.state.downloadUrl,
      notesUrl: this.state.notesUrl,
      minimumVersion: this.state.minimumVersion,
      platforms: this.state.platforms,
      mirrors: this.state.mirrors.length > 0 ? this.state.mirrors : [{ provider: 'pending' }],
      releasesUrl: releasePageUrlOf(this.options.endpoint),
      // 从没查过时给一个可解释的 reason（不是错误，只是"还没开始"）
      reason: this.state.reason ?? (this.state.lastAttemptAt === null ? 'never-checked' : null),
      checkedAt: this.state.lastAttemptAt,
      lastSuccessAt: this.state.lastSuccessAt,
      nextAllowedAt: nextAllowed === null ? null : new Date(nextAllowed).toISOString(),
      intervalHours: updateIntervalMs(this.state.consecutiveFailures) / 3_600_000,
      consecutiveFailures: this.state.consecutiveFailures,
      dismissible: status !== 'required',
    };
  }

  /**
   * 起拍：读状态、按"下一次允许时间"与 60 秒首检延迟排第一次。
   *
   * 幂等（重复调用不再排第二条定时器）。关闭时**什么都不排**——`enabled:false` 的语义是
   * "这个进程一个更新请求都不发"，不是"发了但忽略结果"。
   */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    if (!this.options.enabled) {
      this.write('[更新] 更新检查已关闭（update.enabled = false）：不访问任何站点');
      return;
    }
    const firstDelay = this.options.firstCheckDelayMs ?? UPDATE_FIRST_CHECK_DELAY_MS;
    const next = nextAllowedMsOf(this.state);
    const remaining = next === null ? 0 : next - this.now().getTime();
    this.schedule(Math.max(firstDelay, remaining, 1));
    this.write(`[更新] 更新检查已启用：${this.channel} 通道 · ${sanitizeEndpoint(this.options.endpoint)}`
      + `（首次 ${Math.round(Math.max(firstDelay, remaining) / 1000)} 秒后，之后每 ${updateIntervalMs(this.state.consecutiveFailures) / 3_600_000} 小时一次）`);
  }

  /** 收掉定时器（退出流程；在飞的那一次请求由它自己超时收场） */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * 查一次。
   *
   * 缺省（`manual` 省略）走节流：还在窗口里就**不发请求**，返回 `skipped:'throttled'`。
   * 手动（界面上那颗按钮）无视窗口，见文件头。
   */
  async checkNow(options: { manual?: boolean } = {}): Promise<UpdateRunResult> {
    if (!this.options.enabled) {
      return { performed: false, skipped: 'disabled', view: this.view() };
    }
    const manual = options.manual === true;
    if (!manual) {
      const next = nextAllowedMsOf(this.state);
      if (next !== null && this.now().getTime() < next) {
        return { performed: false, skipped: 'throttled', view: this.view() };
      }
    }
    await this.perform();
    return { performed: true, view: this.view() };
  }

  // ── 内部 ──

  /**
   * 切通道（`POST /api/update/channel` 的运行期那一半）。
   *
   * 三件事，顺序不能反：
   *   ① 改**运行期**通道（下一次请求就按新通道的语义判：stable 不把预发布当更新）；
   *   ② **清掉节流状态**——不清的话刚切过来会被 12h 窗口挡住，"切了没反应"；
   *      上一次的 `latestVersion`/`platforms` 也一起清（那是上一条通道的结果，留着会显示串味）；
   *   ③ 立刻查一次（手动语义，无视窗口），把这一次的结果一并交给界面。
   *
   * 配置文件的写盘**不在这里**：web 层用 `withConfigDoc`（保注释、写后 `loadConfig` 复核、
   * 失败回滚）写 `update.channel` 那一格；本方法只负责让运行期立刻生效。
   */
  async applyChannel(channel: UpdateChannel): Promise<UpdateRunResult> {
    this.channel = channel;
    this.state = {
      ...emptyUpdateState(),
      schema: UPDATE_STATE_SCHEMA,
      currentVersion: this.options.currentVersion,
      channel,
      endpoint: sanitizeEndpoint(this.options.endpoint),
    };
    if (!writeUpdateState(this.statePath, this.state)) {
      this.write('[更新] 切通道后状态文件写不进去（本次切换只在内存里生效）');
    }
    this.write(`[更新] 通道已切到 ${channel}（节流状态已清空，立刻查一次）`);
    return await this.checkNow({ manual: true });
  }

  /** 真发一次请求（并发去重）。失败不会抛：`checkForUpdate` 的契约就是永不抛。 */
  private perform(): Promise<void> {
    const running = this.inFlight;
    if (running !== null) return running;
    const run = (async (): Promise<void> => {
      const result = await checkForUpdate({
        currentVersion: this.options.currentVersion,
        channel: this.channel,
        endpoint: this.options.endpoint,
        timeoutMs: this.options.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS,
        userAgent: this.options.userAgent ?? DEFAULT_UPDATE_USER_AGENT,
        ...(this.options.fetchImpl !== undefined ? { fetchImpl: this.options.fetchImpl } : {}),
      });
      this.apply(result, this.now());
    })();
    this.inFlight = run;
    return run.finally(() => {
      this.inFlight = null;
    });
  }

  /** 把一次结果写进状态、落盘、留痕（顺序：状态 → 磁盘 → 事件 → 日志） */
  private apply(result: UpdateCheckResult, at: Date): void {
    const atIso = at.toISOString();
    const failed = result.status === 'unknown';
    const failures = failed ? this.state.consecutiveFailures + 1 : 0;
    this.state = {
      schema: UPDATE_STATE_SCHEMA,
      lastAttemptAt: atIso,
      lastSuccessAt: failed ? this.state.lastSuccessAt : atIso,
      lastStatus: result.status,
      currentVersion: this.options.currentVersion,
      channel: this.channel,
      endpoint: sanitizeEndpoint(this.options.endpoint),
      latestVersion: result.latest ?? null,
      downloadUrl: result.downloadUrl ?? null,
      notesUrl: result.notesUrl ?? null,
      minimumVersion: result.minimumVersion ?? null,
      platforms: result.platforms ?? [],
      mirrors: result.mirrors ?? [],
      reason: result.reason ?? null,
      consecutiveFailures: failures,
    };

    if (!writeUpdateState(this.statePath, this.state)) {
      // 写不进去不改变"这次查到了什么"：内存里那份照旧给界面用，下次启动回到上一次的盘上状态
      this.write('[更新] 状态文件写不进去（本次结果只在内存里生效）');
    }

    const payload: UpdateChecked['data'] = {
      status: result.status,
      currentVersion: this.options.currentVersion,
      latestVersion: result.latest ?? null,
      channel: this.channel,
      endpoint: sanitizeEndpoint(this.options.endpoint),
      checkedAt: atIso,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    };
    try {
      this.options.emit?.('update/checked', payload, 'internal');
    } catch {
      // 事件写不进去（日志只读/盘满）：检测结果仍在状态文件与内存里，不影响界面
    }

    const intervalHours = updateIntervalMs(failures) / 3_600_000;
    if (failed) {
      this.write(`[更新] 这次没查到（${result.reason ?? 'unknown'}，连续失败 ${failures} 次；`
        + `下次最多 ${intervalHours} 小时后）`);
    } else if (result.status === 'available') {
      this.write(`[更新] 有新版本 ${result.latest ?? '?'}（当前 ${this.options.currentVersion}）`);
    } else if (result.status === 'required') {
      this.write(`[更新] 低于最低可用版本（当前 ${this.options.currentVersion}，最低 ${result.minimumVersion ?? '?'}）：请升级`);
    } else {
      this.write(`[更新] 已是最新（当前 ${this.options.currentVersion}${result.reason === undefined ? '' : `，${result.reason}`}）`);
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped || !this.options.enabled) return;
    if (this.timer !== null) clearTimeout(this.timer);
    const timer = setTimeout(() => {
      this.timer = null;
      void this.autoTick();
    }, Math.max(1, delayMs));
    // 12 小时的定时器不该把进程留在事件循环里（退出流程不该等它）
    timer.unref?.();
    this.timer = timer;
  }

  /** 定时器到点：真查一次，然后按这次的结果排下一次 */
  private async autoTick(): Promise<void> {
    if (this.stopped || !this.options.enabled) return;
    const outcome = await this.checkNow({ manual: false });
    if (this.stopped) return;
    if (!outcome.performed) {
      // 被节流挡下 = 这一拍来早了（时钟跳变/手改状态文件）：按剩余时间重排，不发请求
      const next = nextAllowedMsOf(this.state);
      this.schedule(next === null ? this.options.firstCheckDelayMs ?? UPDATE_FIRST_CHECK_DELAY_MS : next - this.now().getTime());
      return;
    }
    this.scheduleAfterCheck();
  }

  /** 一次成功的检查之后：下一次 = 这次尝试 + 当前窗口（失败 3 次后窗口自动变 24h） */
  private scheduleAfterCheck(): void {
    const next = nextAllowedMsOf(this.state);
    const remaining = next === null
      ? UPDATE_INTERVAL_MS
      : next - this.now().getTime();
    this.schedule(Math.max(remaining, 1_000));
  }
}
