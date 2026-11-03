import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { PLUGIN_PERMISSIONS, PLUGIN_RESERVED_PERMISSIONS, isPluginEngineCompatible } from './manifest.ts';
import { installPluginPackage, PLUGIN_FILE_LIMITS, type PluginPackage } from './package-store.ts';
import { cancelMarketResponse, readBoundedMarketBody, type MarketBodyResponse } from './market-response.ts';

/**
 * 插件市场客户端（协议见 `docs/plugin-platform-p1-design.md` 六）。
 *
 * 这一层**只做纯逻辑 + 注入依赖**，不自己联网、不读配置、不碰 HTTP/GUI：
 *   · `parseMarketIndex`   把 index.json 变成结构化的索引；非法**条目**逐条报错，不拖垮整份索引；
 *   · `selectRelease`      按 id / version / engine 选一条可安装的发布，失败返回结构化结果而不是抛；
 *   · `verifyAndInstall`   下载 → 校长度与 sha256 → 解包 → 交给 `installPluginPackage` → `PluginPackage`。
 *
 * 三条边界：
 *   ① **签名不验**：`signature` 是协议预留字段（P1 写进协议、客户端不验）。这一版只校 sha256
 *      与安装期的内容寻址哈希；签名验证留到 P1c 与发布流程一起做。类型里保留
 *      `signature?: string | null`，读出来原样带着、**当前不验证**——不要在别处把它当安全凭据。
 *   ② **失败不落盘**：下载先落在系统临时目录（`os.tmpdir()`，测试可注入 `tempDir`），
 *      长度 / sha256 / 解包任何一步不过，临时目录整体删掉；只有全部通过才交给安装器
 *      （安装器自己也是"临时目录 + rename"的原子落盘）。校验失败时 `plugins/packages/` 一个字节都不会多。
 *   ③ **网络超时由调用方注入**：模块不设默认超时（`timeoutMs` 可选）、不建默认 User-Agent、
 *      不重试。取 index / 重试 / 限速都是调用方的事。
 *
 * 包格式：**zip**（协议就是这么定的）。为了不引第三方依赖，这里带一个最小 ZIP 读取器：
 * 只支持 store / deflate、只读中央目录、拒绝 zip64 / 加密 / 符号链接 / 路径逃逸 / 重复条目，
 * 并再按 `PLUGIN_FILE_LIMITS` 卡一遍条目数、单文件与总解压体积（防 zip bomb）。
 * 它只负责"把字节解开"，**不是沙箱**；包的可信度仍来自人 review + sha256 固定。
 */

// ──────────────────────────────── 限额 ────────────────────────────────

/**
 * 市场侧的硬上限。
 *
 * 包上限直接取 `PLUGIN_FILE_LIMITS.maxTotalBytes`（8MB）：市场允许下载的包，必须刚好是
 * 安装器愿意收的包。两个数各写一份，早晚会出现"下下来了、装不上"。
 */
export const MARKET_LIMITS = Object.freeze({
  /** index.json 的字节上限（2MB；正常索引只有几十 KB） */
  maxIndexBytes: 2 * 1024 * 1024,
  /** 包的字节上限（= 安装器的整包上限 8MB，含 zip 头开销） */
  maxPackageBytes: PLUGIN_FILE_LIMITS.maxTotalBytes,
  maxUrlChars: 2048,
  maxSignatureChars: 4096,
  /** 一个版本的 `net` 白名单最多几项（与清单的 MAX_NET_ALLOW_ENTRIES 同口径） */
  maxNetEntries: 64,
  /** `net` 单项最多多少字符（与清单的 MAX_NET_ALLOW_CHARS 同口径） */
  maxNetEntryChars: 255,
  /** 一个版本的 `net` 全部条目加起来最多多少字符：防止用一个超长数组撑爆审阅视图 */
  maxNetTotalChars: 4096,
});

export const MARKET_SCHEMA = 1;

// ──────────────────────────────── 错误码 ────────────────────────────────

/**
 * 市场错误码（也是逐条问题的 code）。
 *
 * 全部带 `market-` 前缀：调用方（P1c 的 HTTP/GUI）可以直接把 code 映射成界面文案，
 * 不用去解析 message。**新增码只加不改**——前端可能已经按旧码写好了分支。
 */
export const MARKET_ERROR_CODES = Object.freeze({
  /** 整份索引不是合法 JSON / 形状不对 / schema 不是 1 */
  indexInvalid: 'market-index-invalid',
  /** 索引超过 2MB */
  indexTooLarge: 'market-index-too-large',
  /** 单个插件或单个版本条目非法（逐条问题的 code） */
  entryInvalid: 'market-entry-invalid',
  /** 索引里没有这个 id */
  pluginNotFound: 'market-plugin-not-found',
  /** 有插件，但没有这一版 / 没有任何版本 */
  versionNotFound: 'market-version-not-found',
  /** 版本存在，但宿主版本不满足 release.engine */
  engineIncompatible: 'market-engine-incompatible',
  /** 调用方给的"当前宿主版本"不是合法 SemVer */
  invalidEngine: 'market-invalid-engine',
  /** 请求参数本身不合法（sha256 形状、size 范围等） */
  requestInvalid: 'market-request-invalid',
  /** 网络失败 / HTTP 非 2xx */
  downloadFailed: 'market-download-failed',
  /** 下载被取消，或注入的超时触发 */
  aborted: 'market-aborted',
  /** 包超过 8MB（索引声明或实际下载，二者都可能） */
  packageTooLarge: 'market-package-too-large',
  /** 实际字节数与索引声明不一致 */
  sizeMismatch: 'market-size-mismatch',
  /** sha256 与索引不一致 */
  hashMismatch: 'market-hash-mismatch',
  /** 解包失败 / 结构不合法 / 包根没有 plugin.json */
  archiveInvalid: 'market-archive-invalid',
  /** 包里的 id / version 与索引条目对不上 */
  packageMismatch: 'market-package-mismatch',
  /** 安装器（scan/installPluginPackage）拒绝了该包 */
  installFailed: 'market-install-failed',
} as const);

export type MarketErrorCode = (typeof MARKET_ERROR_CODES)[keyof typeof MARKET_ERROR_CODES];

export interface MarketErrorOptions {
  readonly cause?: unknown;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** 市场客户端的统一错误：带稳定 code，message 给日志/界面看。 */
export class MarketError extends Error {
  readonly code: MarketErrorCode;
  /** 结构化细节（字节数、期望/实际哈希、路径等）；界面可以按需展示 */
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: MarketErrorCode, message: string, options: MarketErrorOptions = {}) {
    super(message);
    this.name = 'MarketError';
    this.code = code;
    this.detail = Object.freeze({ ...(options.detail ?? {}) });
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

// ──────────────────────────────── 协议类型 ────────────────────────────────

export type MarketRuntimeType = 'node' | 'python' | 'declarative';

/**
 * 索引里的一个发布版本（对应设计稿 versions[] 的一项）。
 *
 * `signature` 是**协议预留**：P1 不验证，读到什么就带什么（`null` 表示发布方没签）。
 * 客户端当前只信 sha256；不要把它当安全凭据。
 */
export interface MarketRelease {
  readonly version: string;
  readonly apiVersion: 1 | 2;
  /** 宿主版本要求，如 `>=0.1.0-beta.14`（口径与 plugin.json 的 engine.irmia 相同） */
  readonly engine: string;
  readonly url: string;
  /** 包（zip）的 sha256，64 位十六进制；解析时统一小写 */
  readonly sha256: string;
  /** 包的字节数（下载后按实际长度校验） */
  readonly size: number;
  readonly permissions: readonly string[];
  /**
   * 该插件要访问的主机白名单（可选；缺省 = 索引**没有声明**，按空表展示）。
   *
   * 它与包内 `plugin.json` 的 `net.allow` 是同一件事的两个来源，但**包内清单为准**：
   * 索引这份只用于安装前的审阅与"两边是否一致"的提示（见 `plugin/market-http.ts` 的 review）。
   * 解析时逐项归一化（小写、去掉 IPv6 方括号），非法项逐条报 `MarketProblem`。
   */
  readonly net?: readonly string[];
  readonly runtime: MarketRuntimeType;
  /** 预留：发布方签名。**当前不验证**（P1 只校 sha256，签名留到 P1c）。 */
  readonly signature?: string | null;
}

export interface MarketPluginEntry {
  readonly id: string;
  /** 索引推荐的版本；缺省 / 指向不存在的版本时由 selectRelease 按最高兼容版本选 */
  readonly latest?: string;
  readonly title?: string;
  readonly author?: string;
  readonly desc?: string;
  readonly versions: readonly MarketRelease[];
}

export interface MarketIndex {
  readonly schema: typeof MARKET_SCHEMA;
  readonly updatedAt?: string;
  readonly plugins: readonly MarketPluginEntry[];
}

export interface MarketProblem {
  readonly code: MarketErrorCode;
  /** JSON 路径，如 `plugins[0].versions[1].sha256`——逐条报错要能定位到字段 */
  readonly path: string;
  readonly message: string;
}

export interface MarketIndexParse {
  readonly index: MarketIndex;
  /** 非法条目的逐条问题；合法条目照常出现在 index 里 */
  readonly problems: readonly MarketProblem[];
}

// ──────────────────────────────── 小工具 ────────────────────────────────

// 与 `src/plugin/manifest.ts` 的 `ID` / `VERSION` **同口径**。那两个常量没有导出，
// 而本次改动只允许新增文件，所以复制一份；测试用同一组边界值锁住"生成 → 清单校验"两边。
const PLUGIN_ID = /^[a-z0-9-]{1,64}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const SHA256_HEX = /^[a-f0-9]{64}$/i;

const ENTRY_KEYS = ['id', 'latest', 'title', 'author', 'desc', 'versions'] as const;
const RELEASE_KEYS = ['version', 'apiVersion', 'engine', 'url', 'sha256', 'size', 'permissions', 'net', 'runtime', 'signature'] as const;
const INDEX_KEYS = ['schema', 'updatedAt', 'plugins'] as const;
const META_LIMITS = Object.freeze({ title: 80, author: 80, desc: 500 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * SemVer 比较（与 manifest.ts 的 compareVersions 同口径，包含 prerelease 的规则）。
 *
 * 市场侧只在"没给 latest 时挑最高版本"用它；复制这份是文件限制所致（见上面 PLUGIN_ID 的注释）。
 */
function compareVersions(a: string, b: string): number {
  const parse = (value: string): { core: number[]; pre: (number | string)[] } => {
    const match = SEMVER.exec(value);
    if (match === null) throw new Error(`Invalid semantic version: ${value}`);
    return {
      core: match.slice(1, 4).map(Number),
      pre: match[4]?.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)) ?? [],
    };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index]! - right.core[index]!;
  }
  if (left.pre.length === 0 && right.pre.length > 0) return 1;
  if (left.pre.length > 0 && right.pre.length === 0) return -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return 0;
}

/** 合法的 engine 要求：`>=x.y.z` 或 `x.y.z`（与 manifest.ts 的 isPluginEngineCompatible 同口径） */
function isEngineRequirement(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    // 拿一个必然合法但极低的版本当"当前版本"，只为触发语法校验；返回值不参与判断。
    isPluginEngineCompatible(value, '0.0.0');
    return true;
  } catch {
    return false;
  }
}

// ──────────────────────────────── 索引解析 ────────────────────────────────

/**
 * 解析市场索引（index.json 的原始文本 / 字节）。
 *
 * 失败分两层：
 *   · **整份索引不可用** → 抛 `MarketError`（不是 JSON、schema 不是 1、plugins 不是数组、超过 2MB）；
 *   · **单条非法** → 记进 `problems`，该条被跳过，其它插件/版本照常可用。
 * 这样"索引里混进一个写坏的条目"不会让整个市场消失。
 */
export function parseMarketIndex(raw: string | Uint8Array): MarketIndexParse {
  const bytes = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength;
  if (bytes > MARKET_LIMITS.maxIndexBytes) {
    throw new MarketError(
      MARKET_ERROR_CODES.indexTooLarge,
      `市场索引 ${bytes} 字节，超过 ${MARKET_LIMITS.maxIndexBytes} 字节上限`,
      { detail: { actualBytes: bytes, maxBytes: MARKET_LIMITS.maxIndexBytes } },
    );
  }
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch (error) {
      throw new MarketError(MARKET_ERROR_CODES.indexInvalid, '市场索引不是合法的 UTF-8 文本', { cause: error });
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new MarketError(MARKET_ERROR_CODES.indexInvalid, `市场索引不是合法 JSON：${messageOf(error)}`, { cause: error });
  }
  if (!isRecord(parsed)) throw new MarketError(MARKET_ERROR_CODES.indexInvalid, '市场索引必须是 JSON 对象');
  for (const key of Object.keys(parsed)) {
    if (!(INDEX_KEYS as readonly string[]).includes(key)) {
      throw new MarketError(MARKET_ERROR_CODES.indexInvalid, `市场索引有未知字段 ${key}`);
    }
  }
  if (parsed['schema'] !== MARKET_SCHEMA) {
    throw new MarketError(
      MARKET_ERROR_CODES.indexInvalid,
      `市场索引 schema 必须是 ${MARKET_SCHEMA}（实际 ${JSON.stringify(parsed['schema'])}）`,
    );
  }
  const pluginsRaw = parsed['plugins'];
  if (!Array.isArray(pluginsRaw)) throw new MarketError(MARKET_ERROR_CODES.indexInvalid, '市场索引 plugins 必须是数组');

  const problems: MarketProblem[] = [];
  const plugins: MarketPluginEntry[] = [];
  const seenIds = new Set<string>();
  for (let index = 0; index < pluginsRaw.length; index += 1) {
    const path = `plugins[${index}]`;
    const entry = parseEntry(pluginsRaw[index], path, problems);
    if (entry === null) continue;
    if (seenIds.has(entry.id)) {
      problems.push({ code: MARKET_ERROR_CODES.entryInvalid, path: `${path}.id`, message: `重复的插件 id ${entry.id}（后出现的这份被忽略）` });
      continue;
    }
    seenIds.add(entry.id);
    plugins.push(entry);
  }

  let updatedAt: string | undefined;
  const updatedAtRaw = parsed['updatedAt'];
  if (updatedAtRaw !== undefined) {
    if (typeof updatedAtRaw !== 'string' || Number.isNaN(Date.parse(updatedAtRaw))) {
      problems.push({ code: MARKET_ERROR_CODES.entryInvalid, path: 'updatedAt', message: `updatedAt 不是可解析的时间：${JSON.stringify(updatedAtRaw)}（已忽略）` });
    } else {
      updatedAt = updatedAtRaw;
    }
  }

  return {
    index: Object.freeze({
      schema: MARKET_SCHEMA,
      ...(updatedAt === undefined ? {} : { updatedAt }),
      plugins: Object.freeze(plugins),
    }),
    problems: Object.freeze(problems),
  };
}

function parseEntry(raw: unknown, path: string, problems: MarketProblem[]): MarketPluginEntry | null {
  const problem = (field: string, message: string): void => {
    problems.push({ code: MARKET_ERROR_CODES.entryInvalid, path: field === '' ? path : `${path}.${field}`, message });
  };
  if (!isRecord(raw)) {
    problem('', '每个插件条目必须是 JSON 对象');
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!(ENTRY_KEYS as readonly string[]).includes(key)) {
      problem(key, `未知字段 ${key}`);
      return null;
    }
  }
  const id = raw['id'];
  if (typeof id !== 'string' || !PLUGIN_ID.test(id)) {
    problem('id', `插件 id 不合法（1–64 位小写字母/数字/连字符）：${JSON.stringify(id)}`);
    return null;
  }
  const versionsRaw = raw['versions'];
  if (!Array.isArray(versionsRaw) || versionsRaw.length === 0) {
    problem('versions', 'versions 必须是非空数组');
    return null;
  }
  const releases: MarketRelease[] = [];
  const seenVersions = new Set<string>();
  for (let index = 0; index < versionsRaw.length; index += 1) {
    const release = parseRelease(versionsRaw[index], `${path}.versions[${index}]`, problems);
    if (release === null) continue;
    if (seenVersions.has(release.version)) {
      problems.push({ code: MARKET_ERROR_CODES.entryInvalid, path: `${path}.versions[${index}].version`, message: `重复的版本 ${release.version}（后出现的这份被忽略）` });
      continue;
    }
    seenVersions.add(release.version);
    releases.push(release);
  }
  if (releases.length === 0) {
    problem('versions', '这个插件没有任何可用版本（每个版本的问题见上）');
    return null;
  }

  let latest: string | undefined;
  const latestRaw = raw['latest'];
  if (latestRaw !== undefined) {
    if (typeof latestRaw !== 'string' || !SEMVER.test(latestRaw)) {
      problem('latest', `latest 必须是语义化版本：${JSON.stringify(latestRaw)}（已忽略）`);
    } else if (!seenVersions.has(latestRaw)) {
      problem('latest', `latest 指向的版本 ${latestRaw} 不在 versions 里（已忽略，改按最高兼容版本选）`);
    } else {
      latest = latestRaw;
    }
  }

  const meta: { title?: string; author?: string; desc?: string } = {};
  for (const key of ['title', 'author', 'desc'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0) {
      problem(key, `${key} 必须是非空字符串（已忽略）`);
      continue;
    }
    if (value.length > META_LIMITS[key]) {
      problem(key, `${key} 超过 ${META_LIMITS[key]} 字符（已忽略）`);
      continue;
    }
    meta[key] = value;
  }

  return Object.freeze({
    id,
    ...(latest === undefined ? {} : { latest }),
    ...(meta.title === undefined ? {} : { title: meta.title }),
    ...(meta.author === undefined ? {} : { author: meta.author }),
    ...(meta.desc === undefined ? {} : { desc: meta.desc }),
    versions: Object.freeze(releases),
  });
}

/**
 * 解析一个发布版本。**一个字段坏就整条丢弃**（版本是安装的最小单位，缺一列都装不了），
 * 但会把这条上的所有字段问题**逐个报完**，让人一次改完。
 */
function parseRelease(raw: unknown, path: string, problems: MarketProblem[]): MarketRelease | null {
  const before = problems.length;
  const problem = (field: string, message: string): void => {
    problems.push({ code: MARKET_ERROR_CODES.entryInvalid, path: field === '' ? path : `${path}.${field}`, message });
  };
  if (!isRecord(raw)) {
    problem('', '版本条目必须是 JSON 对象');
    return null;
  }
  const unknown = Object.keys(raw).find((key) => !(RELEASE_KEYS as readonly string[]).includes(key));
  if (unknown !== undefined) {
    problem(unknown, `未知字段 ${unknown}`);
    return null;
  }

  const version = raw['version'];
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    problem('version', `version 必须是语义化版本（x.y.z[-pre]）：${JSON.stringify(version)}`);
  }
  const apiVersionRaw = raw['apiVersion'];
  if (apiVersionRaw !== 1 && apiVersionRaw !== 2) {
    problem('apiVersion', `apiVersion 只能是 1 或 2：${JSON.stringify(apiVersionRaw)}`);
  }
  const runtime = raw['runtime'];
  if (runtime !== 'node' && runtime !== 'python' && runtime !== 'declarative') {
    problem('runtime', `runtime 只能是 node / python / declarative：${JSON.stringify(runtime)}`);
  } else if (apiVersionRaw === 1 && runtime !== 'declarative') {
    problem('runtime', `apiVersion 1 的包只能是 declarative（带代码入口的包必须 apiVersion 2）`);
  }
  const engine = raw['engine'];
  if (!isEngineRequirement(engine)) {
    problem('engine', `engine 必须是 ">=x.y.z" 或 "x.y.z"：${JSON.stringify(engine)}`);
  }

  let url = '';
  const urlRaw = raw['url'];
  if (typeof urlRaw !== 'string' || urlRaw.length === 0) {
    problem('url', `url 必须是非空字符串：${JSON.stringify(urlRaw)}`);
  } else if (urlRaw.length > MARKET_LIMITS.maxUrlChars) {
    problem('url', `url 超过 ${MARKET_LIMITS.maxUrlChars} 字符`);
  } else {
    try {
      const parsed = new URL(urlRaw);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        problem('url', `url 只能是 https:// 或 http://：${urlRaw}`);
      } else if (parsed.username !== '' || parsed.password !== '') {
        problem('url', 'url 里不能带用户名/密码');
      } else if (parsed.hash !== '') {
        problem('url', 'url 里不能带 #fragment');
      } else {
        url = urlRaw;
      }
    } catch {
      problem('url', `url 不是合法 URL：${urlRaw}`);
    }
  }

  let sha256 = '';
  const sha256Raw = raw['sha256'];
  if (typeof sha256Raw !== 'string' || !SHA256_HEX.test(sha256Raw)) {
    problem('sha256', `sha256 必须是 64 位十六进制：${JSON.stringify(sha256Raw)}`);
  } else {
    sha256 = sha256Raw.toLowerCase();
  }

  let size = 0;
  const sizeRaw = raw['size'];
  if (typeof sizeRaw !== 'number' || !Number.isSafeInteger(sizeRaw) || sizeRaw <= 0) {
    problem('size', `size 必须是正整数（字节）：${JSON.stringify(sizeRaw)}`);
  } else if (sizeRaw > MARKET_LIMITS.maxPackageBytes) {
    problem('size', `包大小 ${sizeRaw} 字节超过上限 ${MARKET_LIMITS.maxPackageBytes} 字节`);
  } else {
    size = sizeRaw;
  }

  const permissions = parsePermissions(raw['permissions'], `${path}.permissions`, problems);
  const net = parseNet(raw['net'], `${path}.net`, problems);

  let signature: string | null = null;
  const signatureRaw = raw['signature'];
  if (signatureRaw !== undefined && signatureRaw !== null) {
    // 预留字段：只做形状约束，**不验证**（见文件头 ①）。
    if (typeof signatureRaw !== 'string' || signatureRaw.length === 0 || signatureRaw.length > MARKET_LIMITS.maxSignatureChars) {
      problem('signature', `signature 必须是字符串或 null（≤${MARKET_LIMITS.maxSignatureChars} 字符）`);
    } else {
      signature = signatureRaw;
    }
  }

  if (problems.length !== before) return null;
  return Object.freeze({
    version: version as string,
    apiVersion: apiVersionRaw as 1 | 2,
    engine: engine as string,
    url,
    sha256,
    size,
    permissions: Object.freeze(permissions as string[]),
    ...(net === null ? {} : { net: Object.freeze(net) }),
    runtime: runtime as MarketRuntimeType,
    signature,
  });
}

/**
 * 索引里的 `net`（该插件要访问的主机白名单）。
 *
 * **可选**：没写 = 索引没有声明（不是空表的另一种说法，审阅视图会如实区分）。
 * 形状与清单的 `net.allow` 同口径（域名 / `*.域名` / IP 字面量），但这里只做**展示前的**
 * 形状归一化——真正在执行期生效的是包内 `plugin.json` 的 `net.allow`（包内为准）。
 *
 * 失败语义与其它字段一致：坏项**逐条**进 `problems`（带 `[i]` 定位），该版本整条被丢弃；
 * 不影响索引里的其它插件/版本，更不会让整份索引失败。
 */
function parseNet(value: unknown, path: string, problems: MarketProblem[]): string[] | null {
  if (value === undefined) return null;
  const problem = (field: string, message: string): void => {
    problems.push({ code: MARKET_ERROR_CODES.entryInvalid, path: field === '' ? path : `${path}.${field}`, message });
  };
  if (!Array.isArray(value)) {
    problem('', 'net 必须是字符串数组（等价于清单里的 net.allow）');
    return null;
  }
  if (value.length > MARKET_LIMITS.maxNetEntries) {
    problem('', `net 最多 ${MARKET_LIMITS.maxNetEntries} 项（收到 ${value.length} 项）`);
    return null;
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  let failed = false;
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (typeof raw !== 'string') {
      problem(`[${index}]`, `net 的每一项都必须是字符串：${JSON.stringify(raw)}`);
      failed = true;
      continue;
    }
    const entry = normalizeNetEntry(raw);
    if (entry === null) {
      problem(`[${index}]`, `不是合法的主机白名单项（只写域名 / *.域名 / IP，不能带协议、端口、路径或空白）：${JSON.stringify(raw)}`);
      failed = true;
      continue;
    }
    if (seen.has(entry)) {
      problem(`[${index}]`, `重复的 net 条目 ${entry}`);
      failed = true;
      continue;
    }
    seen.add(entry);
    normalized.push(entry);
  }
  const totalChars = normalized.reduce((sum, entry) => sum + entry.length, 0);
  if (totalChars > MARKET_LIMITS.maxNetTotalChars) {
    problem('', `net 全部条目合计 ${totalChars} 字符，超过 ${MARKET_LIMITS.maxNetTotalChars} 字符上限`);
    failed = true;
  }
  return failed ? null : normalized;
}

/**
 * 一条 `net` → 归一化主机模式（小写、去掉 IPv6 方括号）。
 *
 * 这是 `manifest.ts` 的 `normalizeNetAllowEntry` 的**只读镜像**：那份没导出，而本文件
 * 不允许改 manifest.ts（另一个施工面正在改它）。两边口径必须一致，否则"索引与包内不一致"
 * 会因为大小写/方括号被判成不一致——所以这里的规则刻意写得与那份逐条同形。
 */
function normalizeNetEntry(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') return null;
  if (trimmed.length > MARKET_LIMITS.maxNetEntryChars) return null;
  if (/[\s/\\@?#]/.test(trimmed)) return null;
  if (trimmed.includes(':')) {
    const bare = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
    return isIP(bare) === 6 ? bare : null;
  }
  const wildcard = trimmed.startsWith('*.');
  const base = wildcard ? trimmed.slice(2) : trimmed;
  if (base === '' || base === '*') return null;
  if (isIP(base) !== 0) return wildcard ? null : base;
  if (base.length > 253) return null;
  const labels = base.split('.');
  if (wildcard && labels.length < 2) return null;
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
  }
  return wildcard ? `*.${base}` : base;
}

/** 权限数组：与清单同一张白名单；`shell` 等保留权限仍然明确拒收。 */
function parsePermissions(value: unknown, path: string, problems: MarketProblem[]): string[] | null {
  const problem = (field: string, message: string): void => {
    problems.push({ code: MARKET_ERROR_CODES.entryInvalid, path: field === '' ? path : `${path}.${field}`, message });
  };
  if (!Array.isArray(value)) {
    problem('', 'permissions 必须是字符串数组');
    return null;
  }
  const seen = new Set<string>();
  let failed = false;
  for (let index = 0; index < value.length; index += 1) {
    const permission = value[index];
    if (typeof permission !== 'string' || permission.length === 0) {
      problem(`[${index}]`, `权限必须是非空字符串：${JSON.stringify(permission)}`);
      failed = true;
      continue;
    }
    const reserved = PLUGIN_RESERVED_PERMISSIONS[permission];
    if (reserved !== undefined) {
      problem(`[${index}]`, `权限 ${permission} 暂不支持 —— ${reserved}`);
      failed = true;
      continue;
    }
    if (!(PLUGIN_PERMISSIONS as readonly string[]).includes(permission)) {
      problem(`[${index}]`, `未知权限 ${permission}（本版本允许：${PLUGIN_PERMISSIONS.join(', ')}）`);
      failed = true;
      continue;
    }
    if (seen.has(permission)) {
      problem(`[${index}]`, `重复的权限 ${permission}`);
      failed = true;
      continue;
    }
    seen.add(permission);
  }
  return failed ? null : [...value];
}

// ──────────────────────────────── 版本选择 ────────────────────────────────

export interface MarketSelectOptions {
  /** 指定版本（精确匹配）。不给 = 用 latest，缺 latest 时取最高兼容版本 */
  readonly version?: string;
  /**
   * 当前宿主版本（如 `AGENT_VERSION`）。**给了才做 engine 兼容性筛选**；
   * 不给 = 不筛（调用方自己承担"装上去可能起不来"的风险）。
   */
  readonly engine?: string;
}

export interface MarketSelectionSuccess {
  readonly ok: true;
  readonly plugin: MarketPluginEntry;
  readonly release: MarketRelease;
  /** 因为 engine 不兼容被跳过的更新版本（界面可以提示"有新版但当前宿主跑不了"） */
  readonly skipped: readonly MarketRelease[];
}

export interface MarketSelectionFailure {
  readonly ok: false;
  readonly code: MarketErrorCode;
  readonly message: string;
  /** 插件存在时带上它，界面可直接展示权限/版本列表 */
  readonly plugin?: MarketPluginEntry;
}

export type MarketSelection = MarketSelectionSuccess | MarketSelectionFailure;

/**
 * 选一条可安装的发布。**不抛**：找不到 / 不兼容都返回结构化结果。
 *
 * 规则（刻意可预测）：
 *   · 指定 `version` → 必须精确命中；engine 不兼容就直接失败（不偷偷换别的版本）；
 *   · 没指定 → 先试 `latest`，再按 SemVer 从高到低试；**跳过** engine 不兼容的，
 *     选中的那条会在 `skipped` 里如实列出被跳过的更新版本；
 *   · 全都不兼容 → 失败，message 里逐个写"哪个版本要 >= 什么"。
 */
export function selectRelease(index: MarketIndex, id: string, options: MarketSelectOptions = {}): MarketSelection {
  const plugin = index.plugins.find((entry) => entry.id === id);
  if (plugin === undefined) {
    return {
      ok: false,
      code: MARKET_ERROR_CODES.pluginNotFound,
      message: `市场索引里没有插件 ${id}（索引里共 ${index.plugins.length} 个插件）`,
    };
  }
  const current = options.engine;
  const incompatible = (release: MarketRelease): boolean => {
    if (current === undefined) return false;
    try {
      return !isPluginEngineCompatible(release.engine, current);
    } catch (error) {
      // 走到这里说明 options.engine 本身不是合法版本号——包在下面统一转成 invalidEngine。
      throw new MarketError(MARKET_ERROR_CODES.invalidEngine, `当前宿主版本 ${JSON.stringify(current)} 不是合法的语义化版本：${messageOf(error)}`, { cause: error });
    }
  };

  if (options.version !== undefined) {
    const release = plugin.versions.find((candidate) => candidate.version === options.version);
    if (release === undefined) {
      return {
        ok: false,
        code: MARKET_ERROR_CODES.versionNotFound,
        message: `插件 ${id} 没有版本 ${options.version}（可用：${plugin.versions.map((candidate) => candidate.version).join(', ')}）`,
        plugin,
      };
    }
    let blocked: boolean;
    try {
      blocked = incompatible(release);
    } catch (error) {
      if (error instanceof MarketError) return { ok: false, code: error.code, message: error.message, plugin };
      throw error;
    }
    if (blocked) {
      return {
        ok: false,
        code: MARKET_ERROR_CODES.engineIncompatible,
        message: `插件 ${id}@${release.version} 需要 Irmia ${release.engine}，当前是 ${current ?? '(未知)'}`,
        plugin,
      };
    }
    return { ok: true, plugin, release, skipped: [] };
  }

  const ordered = [...plugin.versions].sort((left, right) => compareVersions(right.version, left.version));
  const latest = plugin.latest === undefined ? undefined : plugin.versions.find((candidate) => candidate.version === plugin.latest);
  const candidates = latest === undefined ? ordered : [latest, ...ordered.filter((candidate) => candidate.version !== latest.version)];

  const skipped: MarketRelease[] = [];
  for (const release of candidates) {
    let blocked: boolean;
    try {
      blocked = incompatible(release);
    } catch (error) {
      if (error instanceof MarketError) return { ok: false, code: error.code, message: error.message, plugin };
      throw error;
    }
    if (!blocked) return { ok: true, plugin, release, skipped };
    skipped.push(release);
  }
  const detail = skipped.map((release) => `${release.version} 需要 ${release.engine}`).join('；');
  return {
    ok: false,
    code: MARKET_ERROR_CODES.engineIncompatible,
    message: `插件 ${id} 没有兼容 Irmia ${current ?? '(未知)'} 的版本：${detail}`,
    plugin,
  };
}

// ──────────────────────────────── 下载并安装 ────────────────────────────────

/**
 * 注入的最小 fetch 形状（不依赖 DOM 的 `Response` 类型，测试好造假）。
 * 生产侧直接传 `globalThis.fetch` 的适配器即可。
 */
export interface MarketFetchInit {
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface MarketFetchResponse extends MarketBodyResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type MarketFetch = (url: string, init: MarketFetchInit) => Promise<MarketFetchResponse>;

export interface MarketInstallDeps {
  /** 插件包仓库的根（宿主 dataDir）；安装器会落到 `<dataDir>/plugins/packages/<id>/<hash>/` */
  readonly dataDir: string;
  readonly fetch: MarketFetch;
  /** 超时（毫秒）。**由调用方注入**：模块不设默认值，也不重试 */
  readonly timeoutMs?: number;
  /** 临时目录的父目录（默认 `os.tmpdir()`）；测试用它断言"失败后什么都没留下" */
  readonly tempDir?: string;
}

export interface MarketInstallRequest {
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
  /** 可选：索引条目的 id / version，给了就校安装结果确实是这一条（市场客户端应始终传） */
  readonly id?: string;
  readonly version?: string;
  /** 调用方自己的取消信号（和 timeoutMs 二选一；都给时以 signal 为准） */
  readonly signal?: AbortSignal;
}

/**
 * 下载 → 校长度与 sha256 → 解包 → 安装。返回安装器给出的 `PluginPackage`。
 *
 * 顺序刻意如此：**先校验、后落盘**。任何一步失败都只会删掉自己的临时目录，
 * `dataDir/plugins/packages/` 不会出现半份包（安装器的原子性另算，见 package-store.ts）。
 * 未验证签名的 `signature` 不参与这里的任何判断（见文件头 ①）。
 */
export async function verifyAndInstall(deps: MarketInstallDeps, request: MarketInstallRequest): Promise<PluginPackage> {
  const expectedHash = normalizeSha256(request.sha256);
  const declaredSize = request.size;
  if (typeof declaredSize !== 'number' || !Number.isSafeInteger(declaredSize) || declaredSize <= 0) {
    throw new MarketError(MARKET_ERROR_CODES.requestInvalid, `索引声明的包大小不合法：${JSON.stringify(declaredSize)}`);
  }
  if (declaredSize > MARKET_LIMITS.maxPackageBytes) {
    throw new MarketError(
      MARKET_ERROR_CODES.packageTooLarge,
      `索引声明的包大小 ${declaredSize} 字节超过上限 ${MARKET_LIMITS.maxPackageBytes} 字节`,
      { detail: { declaredBytes: declaredSize, maxBytes: MARKET_LIMITS.maxPackageBytes } },
    );
  }
  const tempParent = deps.tempDir ?? tmpdir();
  try {
    mkdirSync(tempParent, { recursive: true });
  } catch (error) {
    throw new MarketError(MARKET_ERROR_CODES.installFailed, `临时目录不可用：${tempParent}（${messageOf(error)}）`, { cause: error });
  }
  const root = mkdtempSync(join(tempParent, 'irmia-market-'));
  const packageDir = join(root, 'package');
  try {
    const bytes = await downloadPackage(deps, request);
    if (bytes.byteLength > MARKET_LIMITS.maxPackageBytes) {
      throw new MarketError(
        MARKET_ERROR_CODES.packageTooLarge,
        `下载到的包 ${bytes.byteLength} 字节，超过上限 ${MARKET_LIMITS.maxPackageBytes} 字节`,
        { detail: { actualBytes: bytes.byteLength, maxBytes: MARKET_LIMITS.maxPackageBytes } },
      );
    }
    if (bytes.byteLength !== declaredSize) {
      throw new MarketError(
        MARKET_ERROR_CODES.sizeMismatch,
        `包大小不匹配：索引声明 ${declaredSize} 字节，实际下载 ${bytes.byteLength} 字节`,
        { detail: { expectedBytes: declaredSize, actualBytes: bytes.byteLength } },
      );
    }
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== expectedHash) {
      throw new MarketError(
        MARKET_ERROR_CODES.hashMismatch,
        `包 sha256 不匹配：期望 ${expectedHash}，实际 ${actualHash}（索引写错或下载内容被篡改）`,
        { detail: { expectedSha256: expectedHash, actualSha256: actualHash } },
      );
    }

    mkdirSync(packageDir, { recursive: true });
    try {
      extractZipArchive(bytes, packageDir);
    } catch (error) {
      if (error instanceof MarketError) throw error;
      throw new MarketError(MARKET_ERROR_CODES.archiveInvalid, `解开插件包失败：${messageOf(error)}`, { cause: error });
    }
    if (!existsSync(join(packageDir, 'plugin.json'))) {
      throw new MarketError(MARKET_ERROR_CODES.archiveInvalid, '插件包根目录没有 plugin.json');
    }
    // 索引说 A、包却是 B：**在交给安装器之前**就拦下来，失败路径同样一个字节都不落盘。
    // 这里只读清单里的 id / version（不重做整份校验）：其它不合法留给安装器报 install-failed。
    const identity = readPackageIdentity(packageDir);
    if (request.id !== undefined && identity.id !== undefined && identity.id !== request.id) {
      throw new MarketError(
        MARKET_ERROR_CODES.packageMismatch,
        `包里的插件 id 是 ${identity.id}，索引条目是 ${request.id}`,
        { detail: { expectedId: request.id, actualId: identity.id } },
      );
    }
    if (request.version !== undefined && identity.version !== undefined && identity.version !== request.version) {
      throw new MarketError(
        MARKET_ERROR_CODES.packageMismatch,
        `包里的插件版本是 ${identity.version}，索引条目是 ${request.version}`,
        { detail: { expectedVersion: request.version, actualVersion: identity.version } },
      );
    }

    let installed: PluginPackage;
    try {
      installed = installPluginPackage(packageDir, deps.dataDir);
    } catch (error) {
      throw new MarketError(MARKET_ERROR_CODES.installFailed, `安装器拒绝了该插件包：${messageOf(error)}`, { cause: error });
    }
    return installed;
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    } catch {
      // 清理失败不改写上面的结果：临时目录在系统 TEMP 里，生产侧另有兜底清扫。
    }
  }
}

/**
 * 只读包根 plugin.json 里的 id / version（用于"索引条目与包对得上吗"）。
 * 读不到/不是合法 JSON 时返回空对象：那种包交给安装器，让它用正式错误拒掉。
 */
function readPackageIdentity(packageDir: string): { id?: string; version?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(packageDir, 'plugin.json'), 'utf8'));
  } catch {
    return {};
  }
  if (!isRecord(raw)) return {};
  const identity: { id?: string; version?: string } = {};
  if (typeof raw['id'] === 'string') identity.id = raw['id'];
  if (typeof raw['version'] === 'string') identity.version = raw['version'];
  return identity;
}

function normalizeSha256(value: string): string {  // `String(value)` 只为防调用方绕过类型检查；parseMarketIndex 已经保证形状。
  const text = String(value ?? '');
  if (!SHA256_HEX.test(text)) {
    throw new MarketError(MARKET_ERROR_CODES.requestInvalid, `sha256 必须是 64 位十六进制：${JSON.stringify(value)}`);
  }
  return text.toLowerCase();
}

/**
 * 下载包体。HTTP 非 2xx、网络异常、取消/超时都转成 `MarketError`；
 * **不重试**、不写盘；响应流逐块计数，超过 8MB 立即取消，不保留超限部分。
 */
async function downloadPackage(deps: MarketInstallDeps, request: MarketInstallRequest): Promise<Uint8Array> {
  const timeoutMs = deps.timeoutMs;
  const signal = request.signal ?? (timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs));
  const init: { signal?: AbortSignal; headers?: Record<string, string> } = {
    headers: { accept: 'application/zip, application/octet-stream' },
  };
  if (signal !== undefined) init.signal = signal;
  let response: MarketFetchResponse;
  try {
    response = await deps.fetch(request.url, init);
  } catch (error) {
    throw downloadFailure(error, timeoutMs, signal);
  }
  if (!response.ok) {
    cancelMarketResponse(response);
    throw new MarketError(
      MARKET_ERROR_CODES.downloadFailed,
      `下载失败：HTTP ${response.status}${response.statusText === undefined ? '' : ` ${response.statusText}`}（${request.url}）`,
      { detail: { status: response.status } },
    );
  }
  try {
    return await readBoundedMarketBody(response, MARKET_LIMITS.maxPackageBytes, (actualBytes, declared) => new MarketError(
      MARKET_ERROR_CODES.packageTooLarge,
      `${declared ? '服务器声明的包' : '下载到的包'} ${actualBytes} 字节，超过上限 ${MARKET_LIMITS.maxPackageBytes} 字节`,
      { detail: { actualBytes, maxBytes: MARKET_LIMITS.maxPackageBytes } },
    ), signal);
  } catch (error) {
    if (error instanceof MarketError) throw error;
    throw downloadFailure(error, timeoutMs, signal);
  }
}

function downloadFailure(error: unknown, timeoutMs: number | undefined, signal: AbortSignal | undefined): MarketError {
  const aborted = signal?.aborted === true || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'));
  if (aborted) {
    const reason = timeoutMs === undefined ? '下载已取消或超时' : `下载已取消或超时（timeoutMs=${timeoutMs}）`;
    return new MarketError(MARKET_ERROR_CODES.aborted, reason, { cause: error });
  }
  return new MarketError(MARKET_ERROR_CODES.downloadFailed, `下载失败：${messageOf(error)}`, { cause: error });
}

// ──────────────────────────────── 最小 ZIP 读取器 ────────────────────────────────
//
// 只做市场包需要的那一小片：中央目录 + 本地头、store(0) / deflate(8)。
// 不读 CRC（整包 sha256 已经把字节钉住了；CRC 是传输错误检测，不是安全边界）。
// 拒绝：zip64、分卷、加密、符号链接/特殊文件、路径逃逸、重复条目；按 PLUGIN_FILE_LIMITS 限体积。

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;

function zipError(message: string): MarketError {
  return new MarketError(MARKET_ERROR_CODES.archiveInvalid, message);
}

function readU16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) throw zipError(`ZIP 截断：偏移 ${offset} 处读 u16 越界`);
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) throw zipError(`ZIP 截断：偏移 ${offset} 处读 u32 越界`);
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function findEocd(bytes: Uint8Array): number {
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= lowest; offset -= 1) {
    if (readU32(bytes, offset) === ZIP_EOCD) return offset;
  }
  throw zipError('找不到 ZIP 目录结尾（EOCD）签名：不是 zip 或文件被截断');
}

/** 条目名 → 包内相对路径。任何可能"写到目标目录之外"的写法都拒掉。 */
function normalizeArchivePath(name: string): { path: string; directory: boolean } {
  if (name.length === 0) throw zipError('ZIP 条目名为空');
  if (name.includes('\0')) throw zipError('ZIP 条目名包含 NUL');
  if (name.includes('\\')) throw zipError(`ZIP 条目名必须用 / 分隔，不能含反斜杠：${name}`);
  if (name.startsWith('/') || isAbsolute(name) || /^[A-Za-z]:/.test(name)) {
    throw zipError(`ZIP 条目名不能是绝对路径：${name}`);
  }
  const directory = name.endsWith('/');
  const trimmed = directory ? name.slice(0, -1) : name;
  if (trimmed.length === 0) throw zipError(`ZIP 条目名不合法：${JSON.stringify(name)}`);
  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') throw zipError(`ZIP 条目路径不合法（空段 / . / ..）：${name}`);
    if (segment.includes(':')) throw zipError(`ZIP 条目路径不能含冒号：${name}`);
    if (/[<>"|?*\u0000-\u001f\u007f]/u.test(segment) || /[. ]$/u.test(segment)) {
      throw zipError(`ZIP 条目路径含跨平台不安全的字符或尾点/空格：${name}`);
    }
    const stem = segment.split('.')[0]!.trimEnd();
    if (/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/iu.test(stem)) {
      throw zipError(`ZIP 条目路径使用 Windows 保留名称：${name}`);
    }
  }
  return { path: segments.join('/'), directory };
}

/** Validate every path before creating files, using one portable naming policy. */
function validateArchivePaths(archive: Uint8Array, offset: number, count: number): void {
  const paths = new Map<string, { path: string; directory: boolean; explicit: boolean }>();
  let cursor = offset;
  for (let index = 0; index < count; index += 1) {
    if (readU32(archive, cursor) !== ZIP_CENTRAL) throw zipError(`第 ${index + 1} 个条目的中央目录签名不对`);
    const nameLength = readU16(archive, cursor + 28);
    const extraLength = readU16(archive, cursor + 30);
    const commentLength = readU16(archive, cursor + 32);
    const start = cursor + 46;
    if (start + nameLength > archive.length) throw zipError('ZIP 条目名越过文件末尾');
    let name: string;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(archive.subarray(start, start + nameLength)); }
    catch { throw zipError('ZIP 条目名不是合法 UTF-8'); }
    cursor = start + nameLength + extraLength + commentLength;
    if (cursor > archive.length) throw zipError('ZIP 中央目录条目越过文件末尾');
    const normalized = normalizeArchivePath(name);
    const segments = normalized.path.split('/');
    for (let part = 1; part <= segments.length; part += 1) {
      const path = segments.slice(0, part).join('/');
      const key = path.normalize('NFC').toUpperCase();
      const final = part === segments.length;
      const directory = !final || normalized.directory;
      const existing = paths.get(key);
      if (existing !== undefined) {
        if (existing.path !== path) throw zipError(`ZIP 条目大小写或 Unicode 名称冲突：${existing.path} / ${path}`);
        if (!existing.directory || !directory) throw zipError(`ZIP 条目文件/目录路径冲突或重复：${path}`);
        if (final && existing.explicit) throw zipError(`包内重复的条目：${path}`);
        if (final) existing.explicit = true;
      } else {
        paths.set(key, { path, directory, explicit: final });
      }
    }
  }
}

/**
 * 把 zip 解到 `destination`（调用方保证 destination 是本进程新造的临时目录）。
 * 解出来的东西还没被信任：紧接着会交给 `installPluginPackage` 再扫一遍。
 */
function extractZipArchive(archive: Uint8Array, destination: string): void {
  const eocd = findEocd(archive);
  const disk = readU16(archive, eocd + 4);
  const centralDisk = readU16(archive, eocd + 6);
  const entriesOnDisk = readU16(archive, eocd + 8);
  const entriesTotal = readU16(archive, eocd + 10);
  const centralSize = readU32(archive, eocd + 12);
  const centralOffset = readU32(archive, eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entriesTotal) throw zipError('不支持分卷 ZIP');
  if (entriesTotal === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) throw zipError('不支持 ZIP64');
  if (entriesTotal > PLUGIN_FILE_LIMITS.maxFiles) {
    throw zipError(`包内条目数 ${entriesTotal} 超过上限 ${PLUGIN_FILE_LIMITS.maxFiles}`);
  }
  if (centralOffset + centralSize > archive.length) throw zipError('ZIP 中央目录越过文件末尾');
  validateArchivePaths(archive, centralOffset, entriesTotal);

  const root = resolve(destination);
  const seen = new Set<string>();
  let cursor = centralOffset;
  let files = 0;
  let totalBytes = 0;
  for (let index = 0; index < entriesTotal; index += 1) {
    if (readU32(archive, cursor) !== ZIP_CENTRAL) throw zipError(`第 ${index + 1} 个条目的中央目录签名不对`);
    const flags = readU16(archive, cursor + 8);
    const method = readU16(archive, cursor + 10);
    const compressedSize = readU32(archive, cursor + 20);
    const uncompressedSize = readU32(archive, cursor + 24);
    const nameLength = readU16(archive, cursor + 28);
    const extraLength = readU16(archive, cursor + 30);
    const commentLength = readU16(archive, cursor + 32);
    const externalAttributes = readU32(archive, cursor + 38);
    const localOffset = readU32(archive, cursor + 42);
    const nameStart = cursor + 46;
    if (nameStart + nameLength > archive.length) throw zipError('ZIP 条目名越过文件末尾');
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(archive.subarray(nameStart, nameStart + nameLength));
    } catch {
      throw zipError('ZIP 条目名不是合法 UTF-8');
    }
    cursor = nameStart + nameLength + extraLength + commentLength;
    if (cursor > archive.length) throw zipError('ZIP 中央目录条目越过文件末尾');
    if ((flags & 0x1) === 1) throw zipError(`不支持加密 ZIP 条目：${name}`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw zipError('不支持 ZIP64 条目');

    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const fileType = unixMode & 0xf000;
    if (fileType === 0xa000) throw zipError(`包内不允许符号链接：${name}`);
    if (fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000) throw zipError(`包内不允许特殊文件：${name}`);

    const normalized = normalizeArchivePath(name);
    if (seen.has(normalized.path)) throw zipError(`包内重复的条目：${normalized.path}`);
    seen.add(normalized.path);
    if (normalized.directory) {
      if (uncompressedSize !== 0) throw zipError(`目录条目不应带内容：${name}`);
      mkdirSync(join(root, ...normalized.path.split('/')), { recursive: true });
      continue;
    }

    files += 1;
    if (uncompressedSize > PLUGIN_FILE_LIMITS.maxFileBytes) {
      throw zipError(`文件 ${name} 解压后 ${uncompressedSize} 字节，超过单文件上限 ${PLUGIN_FILE_LIMITS.maxFileBytes} 字节`);
    }
    totalBytes += uncompressedSize;
    if (totalBytes > PLUGIN_FILE_LIMITS.maxTotalBytes) {
      throw zipError(`解压后总大小超过上限 ${PLUGIN_FILE_LIMITS.maxTotalBytes} 字节（在 ${name} 处越界）`);
    }

    if (readU32(archive, localOffset) !== ZIP_LOCAL) throw zipError(`条目 ${name} 的本地文件头签名不对`);
    const localNameLength = readU16(archive, localOffset + 26);
    const localExtraLength = readU16(archive, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > archive.length) throw zipError(`条目 ${name} 的压缩数据越过文件末尾`);
    const chunk = archive.subarray(dataStart, dataStart + compressedSize);

    let content: Uint8Array;
    if (method === 0) {
      content = chunk;
    } else if (method === 8) {
      try {
        content = inflateRawSync(chunk, { maxOutputLength: PLUGIN_FILE_LIMITS.maxFileBytes + 1 });
      } catch (error) {
        throw new MarketError(MARKET_ERROR_CODES.archiveInvalid, `解压 ${name} 失败（可能超过单文件上限）：${messageOf(error)}`, { cause: error });
      }
    } else {
      throw zipError(`不支持的压缩方法 ${method}：${name}`);
    }
    if (content.byteLength !== uncompressedSize) {
      throw zipError(`条目 ${name} 解压后 ${content.byteLength} 字节，与声明的 ${uncompressedSize} 字节不符`);
    }

    const target = resolve(root, ...normalized.path.split('/'));
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw zipError(`条目路径逃出包目录：${name}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  if (files === 0) throw zipError('ZIP 里没有文件（只有目录或空包）');
}

// 保持包的公共表面最小：只导出上面这些。内部 helper 一律不导出，
// 免得调用方绕过 parseMarketIndex 的限额/校验直接拼一个"看起来合法"的对象。
