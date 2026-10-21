/**
 * 更新检测器（`https://irmia.me/releases/latest.json` 的客户端那一半）。
 *
 * ──────────────────────────── 它只做四件事 ────────────────────────────
 *   ① GET 一个静态 JSON（**只此一次**，不带任何标识、不跟任何后续地址）；
 *   ② 按语义化版本比较「最新版 vs 当前版」，把 `-beta.N` 这种预发布也排对；
 *   ③ 按 `channel` 与 `minimumVersion` 判出四种结论之一：
 *      `none`（没有更新）/ `available`（有新版本）/ `required`（低于最低可用版本）/ `unknown`（这次没查到）；
 *   ④ 把可展示的字符串（版本号、notes 地址、某个产物的下载地址）**原样交出去**。
 *
 * ──────────────────────────── 三条纪律（都别改） ────────────────────────────
 *   · **绝不下载、绝不执行任何 url**：本模块只会 `GET` 配置里那一个端点；产物地址与
 *     notes 地址只作为字符串返回，谁去打开由人按按钮决定（GUI 的「查看」）。
 *   · **失败不是错误**：网络不通、超时（默认 8 秒）、404/500、坏 JSON、字段缺失、
 *     产物 `_pending` —— 一律 `status:'unknown'` + 一个 `reason`。检测更新失败不该弹在
 *     她或用户面前，那是"这次没查到"，不是"这台机器坏了"。
 *   · **不打印/不存储任何 query 与 UA 标识**：端点只保留 `protocol://host/path`
 *     （见 {@link sanitizeEndpoint}），UA 是一个固定常量 {@link DEFAULT_UPDATE_USER_AGENT}
 *     ——里面没有机器名、没有用户名、没有任何实例标识。
 *
 * 与站点的契约见 `docs/update-check.md` §1（那份文档是这个文件的说明书，不是第二套实现）。
 */

// ──────────────────────────────── 常量 ────────────────────────────────

/** 一次检测的默认总时限（毫秒）。8 秒：比一次慢速 DNS+TLS 宽，又不至于让启动等待拖太久。 */
export const DEFAULT_UPDATE_TIMEOUT_MS = 8_000;

/**
 * 固定的 User-Agent。
 *
 * **它是常量，不是"某个标识"**：没有版本号之外的任何东西（没有 pid、主机名、数据目录、
 * 会话凭据）。站点侧靠它区分"这是更新检测"，我们靠"永远只有这一个值"让隐私说明可验证：
 * 服务器看到的 UA 与上一次、与另一台机器**逐字节相同**。
 */
export const DEFAULT_UPDATE_USER_AGENT = 'IrmiaAgentUpdateCheck/1';

/** 响应体上限：latest.json 实测 880 B；给到 512 KiB 只为挡住畸形/被替换的端点，不参与正常路径 */
export const UPDATE_MANIFEST_MAX_BYTES = 512 * 1024;

// ──────────────────────────────── 类型 ────────────────────────────────

/** 更新通道（站点侧 `releases/channels.json` 里有 beta / stable 两条） */
export type UpdateChannel = 'beta' | 'stable';

/**
 * 一次检测的结论。
 *
 * `unknown` 是**"这次没查到"**，不是"出错了"：调用方据 `reason` 记一笔账（事件里那一格），
 * 但界面不许把它当错误弹出来。
 */
export type UpdateStatus = 'none' | 'available' | 'required' | 'unknown';

/** 一次检测的完整结果（纯数据、可 JSON 序列化；`downloadUrl` 只是字符串，没人会去取它） */
export interface UpdateCheckResult {
  status: UpdateStatus;
  /** 站点给的最新版号（`unknown` 时尽力给出——能读到就给，读不到就不给） */
  latest?: string;
  /** 命中本机平台的那个产物地址（`kind` 优先 installer → portable → update） */
  downloadUrl?: string;
  /** 发布说明页（站点给的 `notesUrl`） */
  notesUrl?: string;
  /** 站点给的最低可用版本（null/缺省 = 不强制升级；`required` 时它一定可解析） */
  minimumVersion?: string;
  /** 站点给的全部产物（GUI 的"下载入口"按平台分流用；**只是字符串，一个都不会去取**） */
  platforms?: UpdatePlatform[];
  /** 网盘分流（`provider:'pending'` = 还没开放；目前站点清单里没有，出厂就是这一个） */
  mirrors?: UpdateMirror[];
  /** `unknown`/`none` 的判据落点：见 {@link UPDATE_REASONS} 的注释 */
  reason?: string;
}

/** 一个平台产物（GUI 下载入口的一行） */
export interface UpdatePlatform {
  os: string;
  arch: string;
  kind: string;
  /** `_pending` 的条目可能还没有地址（站点还没传完）⇒ 空串 */
  url: string;
  /** true = 站点还没把这一份传完（GUI 灰掉并标「待上传」） */
  pending: boolean;
}

/**
 * 网盘分流（用户 2026-10-22 定下的结构）。
 *
 *   · `pending`：还没开放（**当前的唯一取值**）⇒ GUI 显示 disabled 的「网盘下载 · 即将开放」；
 *   · `baidu` / `quark`：开放之后按 provider 显示「百度网盘下载」/「夸克网盘下载」，
 *     有 `code` 就显示「提取码：xxxx」+ 一键复制。
 */
export type UpdateMirrorProvider = 'pending' | 'baidu' | 'quark';

export interface UpdateMirror {
  provider: UpdateMirrorProvider;
  /** 打开网盘分享页的地址（`pending` 时没有） */
  url?: string;
  /** 提取码（没有就不显示那一行） */
  code?: string;
}

/**
 * `reason` 的取值（**只用于留痕与界面上的"这次为什么没查到"**，不是错误码）。
 *
 *   · `up-to-date`          最新版不高于当前版；
 *   · `older-than-current`  站点给的版本比当前版还旧（多半是回滚或端点配错，不提示升级）；
 *   · `channel-mismatch`    manifest 的 channel 与请求的通道不同（stable 请求不会吃 beta 的包）；
 *   · `prerelease`          stable 通道上出现了预发布版本（不把它当更新）；
 *   · `pending`             manifest / 本机对应产物带 `_pending`（站点还没把那一版发完）；
 *   · `newer`               有新版本（`available` 的判据落点）；
 *   · `below-minimum`       当前版低于站点声明的最低可用版（`required` 的判据落点）；
 *   · `network`             请求发不出去 / 连接被断（DNS、TLS、连接被拒…）；
 *   · `timeout`             超过 `timeoutMs` 还没拿到响应；
 *   · `http-404` / `http-500` … 非 2xx（原样带上状态码）；
 *   · `bad-json`            响应不是合法 JSON；
 *   · `bad-shape`           顶层不是对象、`version`/`channel` 缺失或版本号无法解析、`platforms` 不是数组；
 *   · `too-large`           响应体超过 {@link UPDATE_MANIFEST_MAX_BYTES}；
 *   · `bad-endpoint`        配置里的 endpoint 不是 http(s) 地址；
 *   · `bad-current-version` 当前版本号无法解析（只可能是调用方拼错，不会来自站点）。
 */
export const UPDATE_REASONS = [
  'up-to-date',
  'older-than-current',
  'channel-mismatch',
  'prerelease',
  'pending',
  'newer',
  'below-minimum',
  'network',
  'timeout',
  'bad-json',
  'bad-shape',
  'too-large',
  'bad-endpoint',
  'bad-current-version',
] as const;

/** 检测参数（全部有出厂值；测试可注入 fetch 与时钟） */
export interface CheckForUpdateOptions {
  /** 本进程版本号（`AGENT_VERSION` / `package.json` 的 version） */
  currentVersion: string;
  /** 想走的通道：`beta` 或 `stable` */
  channel: UpdateChannel;
  /** latest.json 的完整地址（配置项 `update.endpoint`） */
  endpoint: string;
  /** 总时限（毫秒），缺省 {@link DEFAULT_UPDATE_TIMEOUT_MS} */
  timeoutMs?: number;
  /** 固定 UA 的覆盖点（**只给测试**：生产路径永远用缺省常量） */
  userAgent?: string;
  /** fetch 覆盖点（测试注入；缺省全局 fetch） */
  fetchImpl?: typeof fetch;
}

// ──────────────────────────────── 版本比较（语义化，含 -beta.N） ────────────────────────────────

/** 解析后的版本：major/minor/patch + 预发布标识数组（无预发布 = 空数组） */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

/**
 * 解析一个语义化版本（允许前缀 `v`、允许 `+build` 元数据）。
 *
 * 只认 `X.Y.Z` 三段：站点的版号一直是这个形状（`0.1.0-beta.12`）。解析不出来时返回 null
 * ——**不猜**（把 `0.2` 猜成 `0.2.0` 会在比较里悄悄造出一个不存在的版本）。
 */
export function parseVersion(raw: string): ParsedVersion | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/^v/iu, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(text);
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  const prerelease = match[4] === undefined ? [] : match[4].split('.');
  // 预发布标识不许为空段（`-beta..1` 这种是坏数据，不猜它是 beta.1）
  if (prerelease.some((part) => part === '')) return null;
  return { major, minor, patch, prerelease };
}

/** 单个预发布标识的比较（语义化 §11：数字段按数值、其余按 ASCII；数字段低于非数字段） */
function comparePrereleaseIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/u.test(a);
  const bNumeric = /^\d+$/u.test(b);
  if (aNumeric && bNumeric) {
    const an = Number(a);
    const bn = Number(b);
    if (an === bn) return 0;
    return an < bn ? -1 : 1;
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * 比较两个版本：`a<b` ⇒ -1、`a===b` ⇒ 0、`a>b` ⇒ 1。
 *
 * 预发布口径（语义化 §11）：**有预发布的低于同号正式版**（`0.1.0-beta.13 < 0.1.0`），
 * 标识段逐个比，`beta.12 > beta.2`（数字按数值，不是字典序）；前缀相同则短的低。
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.min(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    // noUncheckedIndexedAccess：上面 length 已经保证这两格存在
    if (left === undefined || right === undefined) break;
    const verdict = comparePrereleaseIdentifier(left, right);
    if (verdict !== 0) return verdict;
  }
  if (a.prerelease.length === b.prerelease.length) return 0;
  return a.prerelease.length < b.prerelease.length ? -1 : 1;
}

/** 便捷判定：`latest` 严格高于 `current` 吗（任一边解析不出来 ⇒ false） */
export function isNewerVersion(latest: string, current: string): boolean {
  const left = parseVersion(latest);
  const right = parseVersion(current);
  if (left === null || right === null) return false;
  return compareVersions(left, right) > 0;
}

// ──────────────────────────────── 端点与 URL 的隐私边界 ────────────────────────────────

/**
 * 端点 → **可以写进事件/状态/日志/API 响应的那个串**。
 *
 * 只保留 `protocol//host/path`：**query、fragment、userinfo 一律丢掉**。理由不是洁癖：
 * query 里可能带着站点给的签名（`?token=…`），而事件日志是长期留档、`GET /api/update`
 * 是界面要显示的——两处都不该出现一次性的凭据。检测本身仍用原地址（签名端点必须能取到）。
 *
 * 解析失败 ⇒ 空串（调用方显示"配置的端点不可用"，不把原文回显出去）。
 */
export function sanitizeEndpoint(raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  const path = url.pathname === '' ? '/' : url.pathname;
  return `${url.protocol}//${url.host}${path}`;
}

/** 只接受 http(s) 的地址（产物/notes 用；不认识的 scheme 一律不给，免得界面把 `file:` 交给系统） */
function httpUrlOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '') return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return text;
  } catch {
    return undefined;
  }
}

// ──────────────────────────────── manifest 形状 ────────────────────────────────

/** 站点 `platforms[]` 的一项（只取我们用得上的四格 + `_pending`；`UpdatePlatform` 是它的对外别名） */
export type UpdateArtifact = UpdatePlatform;

/** 解析后的 manifest（只保留判定需要的字段；未知字段安静忽略——站点将来加字段不该让旧客户端失效） */
interface ParsedManifest {
  channel: string;
  version: string;
  minimumVersion: string | null;
  notesUrl: string | undefined;
  platforms: UpdatePlatform[];
  mirrors: UpdateMirror[];
  pending: boolean;
}

/** 平台名的**同一性映射**：站点可能写 `windows`/`win32`，本机 `process.platform` 是 `win32` */
function osMatches(declared: string, host: string): boolean {
  const normalize = (value: string): string => value.trim().toLowerCase();
  const left = normalize(declared);
  const right = normalize(host);
  if (left === right) return true;
  if (right === 'win32') return left === 'windows' || left === 'win';
  if (right === 'darwin') return left === 'macos' || left === 'mac' || left === 'osx';
  return false;
}

/** 架构的同一性映射：`x64` / `amd64` / `x86_64` 是一件事 */
function archMatches(declared: string, host: string): boolean {
  const normalize = (value: string): string => value.trim().toLowerCase().replace(/[-_]/gu, '');
  const left = normalize(declared);
  const right = normalize(host);
  if (left === right) return true;
  const x64 = new Set(['x64', 'amd64', 'x8664']);
  if (x64.has(right)) return x64.has(left);
  const arm64 = new Set(['arm64', 'aarch64']);
  if (arm64.has(right)) return arm64.has(left);
  return false;
}

/** 产物的优先档：installer 优先（一步装完），其次 portable，最后 update 包 */
const KIND_PRIORITY: readonly string[] = ['installer', 'portable', 'update'];

/**
 * manifest → 判定用的形状。
 *
 * 严格与宽容的分界：
 *   · `version` / `channel` / `platforms` **必须有**（缺了就是"这次没查到"，`bad-shape`）；
 *   · `platforms[]` 里**单项**形状不对（不是对象、url 不是 http(s)）⇒ 跳过那一项，
 *     不让一个坏条目毁掉整份清单（站点多平台发布时，某一平台漏了 url 是常事）；
 *   · `minimumVersion` 写了但解析不出来 ⇒ 整份 `bad-shape`：最低版本是**强制升级**的判据，
 *     读不懂就放过它等于 fail-open（该拦的没拦），宁可这次不报。
 */
function parseManifest(value: unknown): ParsedManifest | { error: 'bad-shape' } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'bad-shape' };
  const doc = value as Record<string, unknown>;
  const version = doc['version'];
  const channel = doc['channel'];
  if (typeof version !== 'string' || parseVersion(version) === null) return { error: 'bad-shape' };
  if (typeof channel !== 'string' || channel.trim() === '') return { error: 'bad-shape' };
  if (!Array.isArray(doc['platforms'])) return { error: 'bad-shape' };

  let minimumVersion: string | null = null;
  const rawMinimum = doc['minimumVersion'];
  if (rawMinimum !== undefined && rawMinimum !== null) {
    if (typeof rawMinimum !== 'string' || parseVersion(rawMinimum) === null) return { error: 'bad-shape' };
    minimumVersion = rawMinimum;
  }

  const platforms: UpdatePlatform[] = [];
  for (const item of doc['platforms'] as unknown[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const os = entry['os'];
    const arch = entry['arch'];
    const kind = entry['kind'];
    if (typeof os !== 'string' || typeof arch !== 'string' || typeof kind !== 'string') continue;
    const pending = entry['_pending'] === true;
    // `_pending` 的条目**允许还没有地址**（站点还没传完）：GUI 要把它显示成「待上传」，
    // 而不是因为"缺 url"整条消失。非 pending 的必须是一个真 http(s) 地址。
    const url = httpUrlOf(entry['url']);
    if (url === undefined && !pending) continue;
    platforms.push({
      os: os.trim(),
      arch: arch.trim(),
      kind: kind.trim(),
      url: url ?? '',
      pending,
    });
  }

  return {
    channel: channel.trim(),
    version: version.trim(),
    minimumVersion,
    notesUrl: httpUrlOf(doc['notesUrl']),
    platforms,
    mirrors: parseMirrors(doc['mirrors']),
    pending: doc['_pending'] === true,
  };
}

/**
 * 网盘分流：站点清单里可选的 `mirrors[]`。
 *
 * 形状（用户 2026-10-22 定）：
 *   `[{ provider: 'baidu'|'quark'|'pending', url?, code? }]`
 *
 * 两条分寸：
 *   · `baidu` / `quark` **必须有 http(s) 地址**（没有地址的"就绪"是一个点了没反应的按钮，
 *     宁可跳过它让 GUI 落到 pending 那一档）；
 *   · 清单里没有 `mirrors`（**今天的站点就是这样**）⇒ 返回一条 `pending`：GUI 的下载入口
 *     永远有"网盘下载 · 即将开放"这一格，不必在界面上写死"现在没有网盘"。
 */
function parseMirrors(value: unknown): UpdateMirror[] {
  if (!Array.isArray(value)) return [{ provider: 'pending' }];
  const out: UpdateMirror[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const provider = entry['provider'];
    if (provider !== 'pending' && provider !== 'baidu' && provider !== 'quark') continue;
    const code = typeof entry['code'] === 'string' && entry['code'].trim() !== ''
      ? entry['code'].trim()
      : undefined;
    if (provider === 'pending') {
      out.push({ provider, ...(code !== undefined ? { code } : {}) });
      continue;
    }
    const url = httpUrlOf(entry['url']);
    if (url === undefined) continue;
    out.push({ provider, url, ...(code !== undefined ? { code } : {}) });
  }
  return out.length > 0 ? out : [{ provider: 'pending' }];
}

/** 本机平台名：`process.platform` / `process.arch`（测试想造别的平台时直接传字符串） */
function hostPlatform(): { os: string; arch: string } {
  return { os: process.platform, arch: process.arch };
}

/**
 * 挑本机该用哪个产物。
 *
 * 同档里取**第一个非 `_pending`** 的；全都在 `_pending` 时返回 `'pending'`；
 * 一个都匹配不上返回 `null`（此时结论仍可以是 available，只是没有"直接下"的地址——
 * 人点「查看」去发布页自己找）。
 */
function pickArtifact(
  platforms: readonly UpdateArtifact[],
  host: { os: string; arch: string },
): UpdateArtifact | 'pending' | null {
  const matching = platforms.filter(
    (item) => osMatches(item.os, host.os) && archMatches(item.arch, host.arch),
  );
  if (matching.length === 0) return null;
  const ready = (item: UpdateArtifact): boolean => !item.pending && item.url !== '';
  for (const kind of KIND_PRIORITY) {
    const sameKind = matching.filter((item) => item.kind.toLowerCase() === kind);
    const found = sameKind.find(ready);
    if (found !== undefined) return found;
  }
  // 没有已知档位的（站点将来加 kind）：同样只取第一个"已就绪"的
  return matching.find(ready) ?? 'pending';
}

// ──────────────────────────────── 检测主体 ────────────────────────────────

function unknown(reason: string): UpdateCheckResult {
  return { status: 'unknown', reason };
}

/**
 * 检测一次更新。
 *
 * **永不抛**：任何异常都被收成 `{status:'unknown', reason}`。调用方（`update/service.ts`）
 * 只负责节流、落库与留痕，不需要再写一遍 try/catch。
 */
export async function checkForUpdate(options: CheckForUpdateOptions): Promise<UpdateCheckResult> {
  const current = parseVersion(options.currentVersion);
  if (current === null) return unknown('bad-current-version');
  if (options.channel !== 'beta' && options.channel !== 'stable') return unknown('bad-endpoint');

  let url: URL;
  try {
    url = new URL(options.endpoint);
  } catch {
    return unknown('bad-endpoint');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return unknown('bad-endpoint');

  const timeoutMs = options.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;
  const userAgent = options.userAgent ?? DEFAULT_UPDATE_USER_AGENT;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return unknown('network');

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, Math.max(1, timeoutMs));
  // 检测不该把进程留住：定时器是"这次请求的保险丝"，不是后台任务
  timer.unref?.();

  try {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          // 只要 JSON、不要任何协商出来的私有格式
          accept: 'application/json',
          // 固定常量（见 DEFAULT_UPDATE_USER_AGENT 的注释：没有机器/人/实例的任何标识）
          'user-agent': userAgent,
        },
        signal: controller.signal,
      });
    } catch {
      // 超时与网络故障在 fetch 这一层是同一个 catch：靠 signal 是否已 abort 分辨
      return unknown(controller.signal.aborted ? 'timeout' : 'network');
    }

    if (!response.ok) {
      // 主动把响应体读掉/丢掉：不读会留一个悬挂的连接（Node 会警告），也不该拿 500 的正文当数据
      try {
        await response.body?.cancel();
      } catch {
        // 取消失败不影响结论
      }
      return unknown(`http-${response.status}`);
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      return unknown(controller.signal.aborted ? 'timeout' : 'network');
    }
    if (text.length > UPDATE_MANIFEST_MAX_BYTES) return unknown('too-large');

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return unknown('bad-json');
    }

    const manifest = parseManifest(raw);
    if ('error' in manifest) return unknown(manifest.error);

    const latest = manifest.version;
    const base: UpdateCheckResult = {
      status: 'none',
      latest,
      // 平台与网盘分流**随结论一起带出去**：GUI 的下载入口只读这一份，
      // 不自己去拼地址、也不自己判断哪一份"已就绪"（判据在 check.ts 与站点清单之间只有这一处）。
      platforms: manifest.platforms,
      mirrors: manifest.mirrors,
    };
    if (manifest.notesUrl !== undefined) base.notesUrl = manifest.notesUrl;
    if (manifest.minimumVersion !== null) base.minimumVersion = manifest.minimumVersion;

    // ① 通道：manifest 自己说它是哪条通道的。请求 stable 却拿到 beta（或反过来）⇒ 这次不算数。
    if (manifest.channel !== options.channel) {
      return { ...base, status: 'none', reason: 'channel-mismatch' };
    }
    const latestParsed = parseVersion(latest);
    if (latestParsed === null) return unknown('bad-shape');
    // ② stable 通道不把预发布当更新（站点配错/手动放了一份 beta 的 JSON 时也不提示）
    if (options.channel === 'stable' && latestParsed.prerelease.length > 0) {
      return { ...base, status: 'none', reason: 'prerelease' };
    }
    // ③ 站点整份还没发完：这一次什么都没确认，连"有没有新版"都不说
    if (manifest.pending) return unknown('pending');

    const artifact = pickArtifact(manifest.platforms, hostPlatform());
    if (artifact === 'pending') return unknown('pending');
    if (artifact !== null) base.downloadUrl = artifact.url;

    // ④ 强制升级线：当前版低于站点声明的最低可用版 ⇒ required（与"有没有更新"是两条判据）
    if (manifest.minimumVersion !== null) {
      const minimum = parseVersion(manifest.minimumVersion);
      if (minimum !== null && compareVersions(current, minimum) < 0) {
        return { ...base, status: 'required', reason: 'below-minimum' };
      }
    }

    // ⑤ 常规比较
    const verdict = compareVersions(latestParsed, current);
    if (verdict > 0) return { ...base, status: 'available', reason: 'newer' };
    if (verdict < 0) return { ...base, status: 'none', reason: 'older-than-current' };
    return { ...base, status: 'none', reason: 'up-to-date' };
  } finally {
    clearTimeout(timer);
  }
}
