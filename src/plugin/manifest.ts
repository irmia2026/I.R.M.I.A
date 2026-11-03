import { isIP } from 'node:net';
import { isAbsolute, posix, win32 } from 'node:path';

import {
  HOOK_POINT_METADATA, hookDeclarationOf, normalizeHookSubscription,
  type PluginHookDeclaration,
} from './hook-registry.ts';

/**
 * 插件清单（apiVersion 1 = P0 声明式；apiVersion 2 = P1 代码级扩展）
 *
 * P1a 的清单只加"跑什么代码、要什么权限、配置长什么样"，不加任何新贡献类型：
 * 代码插件通过 `ctx.tools.define` / `ctx.hooks.on` 在**运行期**产生贡献，清单里不写死。
 * P1b 再加一张网络白名单（`net.allow`）与两个权限位（`messages.read` / `commands.define`）。
 *
 * 三条兼容纪律：
 *   ① apiVersion 1 的旧包一个字节都不用改：`runtime` 缺省 = `declarative`，
 *      `permissions` 照旧只校验"是非空字符串数组"（P0 从来没执行过这些值）。
 *   ② apiVersion 2 的 `permissions` **严格按白名单校验**：`shell` 这一期仍不在集合里，
 *      出现即拒收并明确说"默认永不授予"——静默忽略等于让人以为它要到了权限。
 *   ③ `net.allow` **没写就是全拒**：它是网络代理唯一的放行依据，缺省值必须是空表。
 */

export const PLUGIN_API_VERSION_V1 = 1;
export const PLUGIN_API_VERSION_V2 = 2;

/**
 * 允许声明的权限（**14 个，全部在调用那一刻执行**）。
 *
 * 这张表是唯一真源：`manifest.ts` 用它校验清单，`host-services.ts` 用它判每个 ctx 方法。
 * 两处各写一份的话，"清单里写了却调不动 / 没写却调得动"迟早会出现。
 *
 * P1b 新增的三个：
 *   · `net`             —— `ctx.net.fetch`（只能经宿主代理，按 `net.allow` 放行）；
 *   · `messages.read`   —— `ctx.hooks.on('message.received', …)`（入站过滤器）；
 *   · `commands.define` —— `ctx.commands.define(…)`（聊天指令）。
 */
export const PLUGIN_PERMISSIONS = [
  'tools.define',
  'hooks.model',
  'hooks.turn',
  'hooks.tool',
  'chat.send',
  'chat.read',
  'model.call',
  'timers',
  'state.session',
  'state.plugin',
  'files',
  'net',
  'messages.read',
  'commands.define',
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/**
 * 这一期**明确不支持**的权限：出现即清单校验失败。
 *
 * 为什么不是"忽略掉"：插件作者会以为它拿到了命令能力，然后在运行期收到一个
 * 完全不相干的"未知方法"错误。拒收并说清"默认永不授予"才是可行动的。
 */
export const PLUGIN_RESERVED_PERMISSIONS: Readonly<Record<string, string>> = Object.freeze({
  shell: '执行命令本平台默认永不授予；要跑命令请走 MCP 工具',
});

export type PluginRuntimeType = 'node' | 'python' | 'declarative';

export interface PluginRuntime {
  readonly type: PluginRuntimeType;
  /** `node` / `python` 必有；`declarative` 不该有 */
  readonly entry?: string;
}

export interface PluginMeta {
  readonly title?: string;
  readonly author?: string;
  readonly desc?: string;
}

export interface PluginManifest {
  readonly apiVersion: typeof PLUGIN_API_VERSION_V1 | typeof PLUGIN_API_VERSION_V2;
  readonly id: string;
  readonly version: string;
  readonly engine: { readonly irmia: string };
  /**
   * 声明式贡献。代码插件通常三者皆空（贡献在运行期由 ctx 产生），但**允许同时带**：
   * 一个插件可以既注册工具、又带一份技能包。
   */
  readonly contributions: {
    readonly skills: readonly string[];
    readonly hooks?: string;
    readonly mcp?: string;
  };
  readonly permissions: readonly string[];
  /**
   * 可选：这个插件打算挂在哪些命名 Hook 点上（**审阅展示用，不是授权**）。
   *
   * 运行期仍以 `hook.subscribe` 为准；这一格让安装页在插件跑起来之前就能回答
   * "它要挂哪些点、哪些是 blocking、defaultTimeout 多少"。声明里的权限必须已在
   * `permissions` 中，否则清单直接拒收（避免审阅时看到一条永远订阅不上的声明）。
   */
  readonly hooks?: readonly PluginHookDeclaration[];
  /**
   * 网络白名单（`ctx.net.fetch` 唯一的放行依据）。
   *
   * **没写 = 空表 = 什么都放行不了**；值只能是域名 / `*.域名` / IP 字面量，
   * 不许带协议、端口、路径。apiVersion 1 的包恒为空表（那一版没有 `net` 权限）。
   */
  readonly netAllow: readonly string[];
  /** 缺省 = declarative（apiVersion 1 的旧包就是这个形状） */
  readonly runtime: PluginRuntime;
  /** 可选的配置文件（相对包根的 POSIX 路径），内容按下面那个 JSON Schema 子集校验 */
  readonly config?: string;
  readonly meta?: PluginMeta;
}

// ──────────────────────────────── 配置 schema（P1a 只做校验与默认值） ────────────────────────────────

/**
 * P1a 的配置 schema 子集：`object` + `string/number/boolean` + `enum/default/description`。
 *
 * 刻意不做完整 JSON Schema：设置页表单渲染是 P1b 的事，这一期只需要"能读出默认值、
 * 能校验覆盖值"。支持得少但每条都真的执行，比"宣称支持 JSON Schema"却只认一半强。
 */
export interface PluginConfigProperty {
  readonly type: 'string' | 'number' | 'boolean';
  readonly enum?: readonly (string | number | boolean)[];
  readonly default?: string | number | boolean;
  readonly description?: string;
}

export interface PluginConfigSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, PluginConfigProperty>>;
}

export interface PluginConfigResolution {
  readonly values: Record<string, string | number | boolean>;
  readonly problems: string[];
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const ID = /^[a-z0-9-]{1,64}$/;
const CONFIG_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_CONFIG_PROPERTIES = 64;
const MAX_META_CHARS = { title: 80, author: 80, desc: 500 } as const;

function record(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where}: expected an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${where}: unsupported field ${key}`);
}

export function pluginContributionPath(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\') || isAbsolute(value) || win32.isAbsolute(value)) {
    throw new Error(`${where}: expected a relative POSIX path`);
  }
  const normalized = posix.normalize(value);
  if (normalized !== value || value === '.' || value.startsWith('../') || value.endsWith('/')) throw new Error(`${where}: path escapes the package`);
  return value;
}

function parseVersion(value: string): { core: number[]; pre: (number | string)[] } {
  const match = VERSION.exec(value);
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  return {
    core: match.slice(1, 4).map(Number),
    pre: match[4]?.split('.').map((part) => /^\d+$/.test(part) ? Number(part) : part) ?? [],
  };
}

function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) if (left.core[i] !== right.core[i]) return left.core[i]! - right.core[i]!;
  if (left.pre.length === 0 && right.pre.length > 0) return 1;
  if (left.pre.length > 0 && right.pre.length === 0) return -1;
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const a = left.pre[i];
    const b = right.pre[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'number') return -1;
    if (typeof b === 'number') return 1;
    return a < b ? -1 : a > b ? 1 : 0; // SemVer 规定 ASCII 码点序，不用 locale 排序
  }
  return 0;
}

export function isPluginEngineCompatible(requirement: string, currentVersion: string): boolean {
  const minimum = requirement.startsWith('>=') ? requirement.slice(2) : requirement;
  if (!VERSION.test(minimum) || (requirement.startsWith('>=') && requirement.length === 2)) throw new Error(`Invalid engine requirement: ${requirement}`);
  const comparison = compareVersions(currentVersion, minimum);
  return requirement.startsWith('>=') ? comparison >= 0 : comparison === 0;
}

function permissionsArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

/**
 * apiVersion 2 的权限白名单校验。
 *
 * 顺序有讲究：先认 `net` / `shell` 并给出"暂不支持"的专属消息，再报一般性未知值——
 * 否则 `net` 只会得到一句"未知权限"，插件作者会去猜是不是拼错了。
 */
function parseV2Permissions(value: unknown, where: string): string[] {
  if (!permissionsArray(value)) throw new Error(`${where}: expected a string array`);
  const seen = new Set<string>();
  for (const permission of value) {
    if (seen.has(permission)) throw new Error(`${where}: duplicate permission ${permission}`);
    seen.add(permission);
    const reserved = PLUGIN_RESERVED_PERMISSIONS[permission];
    if (reserved !== undefined) throw new Error(`${where}: permission ${permission} 暂不支持 —— ${reserved}`);
    if (!(PLUGIN_PERMISSIONS as readonly string[]).includes(permission)) {
      throw new Error(`${where}: 未知权限 ${permission}（本版本允许：${PLUGIN_PERMISSIONS.join(', ')}）`);
    }
  }
  return [...value];
}

const MAX_NET_ALLOW_ENTRIES = 64;
const MAX_NET_ALLOW_CHARS = 255;
/** 域名标签：字母数字开头结尾、中间允许短横线（与 DNS 主机名同一口径，不含下划线） */
const NET_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * 一条 `net.allow` 的值 → 归一化后的主机模式（小写、去掉 IPv6 方括号）。
 *
 * 允许三种形状：`api.example.com`、`*.example.com`、IP 字面量（v4 / v6）。
 * **故意不宽**：带协议、端口、路径、空白、裸 `*` 的值一律拒收——白名单里一条含糊的
 * 写法会让"到底放行了什么"说不清，而这层是唯一能限网络的地方。
 */
function normalizeNetAllowEntry(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where}: 每项都必须是字符串`);
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') throw new Error(`${where}: 不能包含空字符串`);
  if (trimmed.length > MAX_NET_ALLOW_CHARS) throw new Error(`${where}: 单项超过 ${MAX_NET_ALLOW_CHARS} 字符`);
  if (/[\s/\\@?#]/.test(trimmed)) throw new Error(`${where}: ${JSON.stringify(value)} 不能带协议、路径、查询或空白（只写主机）`);
  if (trimmed.includes(':')) {
    // IPv6 字面量可以带方括号（与 URL.hostname 同形）；去掉之后必须真的是一个 IP
    const bare = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
    const version = isIP(bare);
    if (version !== 6) throw new Error(`${where}: ${JSON.stringify(value)} 不是合法的 IPv6 地址（IPv4/域名不要带端口）`);
    return bare;
  }
  const wildcard = trimmed.startsWith('*.');
  const base = wildcard ? trimmed.slice(2) : trimmed;
  if (base === '') throw new Error(`${where}: ${JSON.stringify(value)} 缺少域名`);
  if (base === '*') throw new Error(`${where}: 不允许裸通配 *（要放行整域请写 *.example.com）`);
  if (isIP(base) !== 0) {
    if (wildcard) throw new Error(`${where}: 通配不能用在 IP 上（${JSON.stringify(value)}）`);
    return base;
  }
  if (base.length > 253) throw new Error(`${where}: 域名超过 253 字符`);
  const labels = base.split('.');
  // 单标签主机（`localhost`、内网机器名）是合法的放行目标；通配才要求至少两级——
  // `*.com` 那种写法放行的是一个 TLD，不可能是作者的本意。
  if (wildcard && labels.length < 2) throw new Error(`${where}: 通配至少要两级域名`);
  for (const label of labels) {
    if (!NET_LABEL.test(label)) throw new Error(`${where}: ${JSON.stringify(value)} 不是合法域名（每段只能字母数字与短横线）`);
  }
  return wildcard ? `*.${base}` : base;
}

/**
 * apiVersion 2 的网络白名单。
 *
 * 两种写法都认（同一件事只允许写一处）：
 *   · 规范形状 `"net": { "allow": [...] }`；
 *   · 兼容形状 `"net.allow": [...]`（有些作者按字段路径写）。
 * 两者同时出现时**拒收**：一份清单里两个"放行什么"的来源，猜哪个都不对。
 *
 * 没写 = 空表（**默认全拒**）。**非空**白名单却没有 `net` 权限 → 拒收：那多半是作者
 * 漏了权限位，静默接受会让人以为它在运行期有网络，实际每次调用都被 -32001 拒。
 * 空表不需要权限位——它本来就没放行任何东西。
 */
function parseNetAllow(value: Record<string, unknown>, permissions: readonly string[], where: string): string[] {
  const nested = value['net'];
  const flat = value['net.allow'];
  if (nested !== undefined && flat !== undefined) {
    throw new Error(`${where}: net 与 net.allow 只能写一种（推荐 "net": {"allow": [...]}）`);
  }
  let raw: unknown;
  if (nested !== undefined) {
    const container = record(nested, `${where}.net`);
    exactKeys(container, ['allow'], `${where}.net`);
    raw = container['allow'];
  } else if (flat !== undefined) {
    raw = flat;
  } else {
    return [];
  }
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${where}.net.allow: expected a string array`);
  if (raw.length > MAX_NET_ALLOW_ENTRIES) throw new Error(`${where}.net.allow: 最多 ${MAX_NET_ALLOW_ENTRIES} 项`);
  // 空表等于"什么都没放行"，有没有 net 票都一样；**非空**白名单却没有 net 票才是作者漏了
  // 权限位（那种清单会让插件作者以为运行期有网络，实际每次调用都被 -32001 拒）。
  if (raw.length > 0 && !permissions.includes('net')) {
    throw new Error(`${where}.net.allow: 声明了网络白名单但没有 net 权限（在 permissions 里加 "net"）`);
  }
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const normalized = normalizeNetAllowEntry(entry, `${where}.net.allow[${index}]`);
    if (seen.has(normalized)) throw new Error(`${where}.net.allow: 重复的条目 ${normalized}`);
    seen.add(normalized);
    return normalized;
  });
}

const MAX_HOOK_DECLARATIONS = 32;

/**
 * 清单里的可选 `hooks` 数组 → 归一化声明。
 *
 * 支持两种写法（都只是"审阅展示"，真正订阅在运行期）：
 *   `"hooks": ["model.request", { "point": "command.before", "errorPolicy": "ABORT" }]`
 *
 * 校验与 `hook.subscribe` 同一套元数据：未知点/模式/abort/超时/errorPolicy 都当场拒，
 * 并要求点所需权限已出现在 `permissions` 里——否则审阅页会展示一个永远订阅不上的点。
 */
function parseHookDeclarations(value: unknown, permissions: readonly string[], where: string): PluginHookDeclaration[] {
  if (!Array.isArray(value)) throw new Error(`${where}: expected an array`);
  if (value.length > MAX_HOOK_DECLARATIONS) throw new Error(`${where}: 最多 ${MAX_HOOK_DECLARATIONS} 项`);
  return value.map((item, index) => {
    const itemWhere = `${where}[${index}]`;
    let body: Record<string, unknown>;
    if (typeof item === 'string') {
      body = { point: item };
    } else if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      body = item as Record<string, unknown>;
    } else {
      throw new Error(`${itemWhere}: 必须是 Hook 点名或声明对象`);
    }
    const normalized = normalizeHookSubscription(body['point'], body, itemWhere, { allowFilter: false });
    const permission = HOOK_POINT_METADATA[normalized.point].permission;
    if (permission !== null && !permissions.includes(permission)) {
      throw new Error(`${itemWhere}.point: ${normalized.point} 需要权限 ${permission}（在 permissions 里声明后才允许写进 hooks）`);
    }
    return hookDeclarationOf(normalized);
  });
}

function parseRuntime(value: unknown, where: string, apiVersion: number): PluginRuntime {
  if (apiVersion === PLUGIN_API_VERSION_V1) return Object.freeze({ type: 'declarative' });
  const runtime = record(value, where);
  exactKeys(runtime, ['type', 'entry'], where);
  const type = runtime['type'];
  if (type !== 'node' && type !== 'python' && type !== 'declarative') {
    throw new Error(`${where}.type: 只能是 node / python / declarative`);
  }
  if (type === 'declarative') {
    if (runtime['entry'] !== undefined) throw new Error(`${where}.entry: declarative 包不该有入口文件`);
    return Object.freeze({ type });
  }
  if (runtime['entry'] === undefined) throw new Error(`${where}.entry: ${type} 包必须声明入口文件`);
  return Object.freeze({ type, entry: pluginContributionPath(runtime['entry'], `${where}.entry`) });
}

function parseMeta(value: unknown, where: string): PluginMeta {
  const meta = record(value, where);
  exactKeys(meta, ['title', 'author', 'desc'], where);
  const out: { title?: string; author?: string; desc?: string } = {};
  for (const key of ['title', 'author', 'desc'] as const) {
    const item = meta[key];
    if (item === undefined) continue;
    if (typeof item !== 'string' || item.length === 0) throw new Error(`${where}.${key}: expected a non-empty string`);
    if (item.length > MAX_META_CHARS[key]) throw new Error(`${where}.${key}: 超过 ${MAX_META_CHARS[key]} 字符`);
    out[key] = item;
  }
  return Object.freeze(out);
}

export function parsePluginManifest(raw: unknown, where = 'plugin.json'): PluginManifest {
  const value = record(raw, where);
  const apiVersion = value['apiVersion'];
  if (apiVersion !== PLUGIN_API_VERSION_V1 && apiVersion !== PLUGIN_API_VERSION_V2) {
    throw new Error(`${where}: apiVersion must be 1 or 2`);
  }
  const allowedKeys = apiVersion === 1
    ? ['apiVersion', 'id', 'version', 'engine', 'contributions', 'permissions', 'hooks']
    : ['apiVersion', 'id', 'version', 'engine', 'contributions', 'permissions', 'runtime', 'config', 'meta', 'net', 'net.allow', 'hooks'];
  exactKeys(value, allowedKeys, where);
  if (typeof value['id'] !== 'string' || !ID.test(value['id'])) throw new Error(`${where}: invalid plugin id`);
  if (typeof value['version'] !== 'string' || !VERSION.test(value['version'])) throw new Error(`${where}: invalid version`);
  const engine = record(value['engine'], `${where}.engine`);
  exactKeys(engine, ['irmia'], `${where}.engine`);
  if (typeof engine['irmia'] !== 'string') throw new Error(`${where}.engine.irmia: expected a version requirement`);
  isPluginEngineCompatible(engine['irmia'], '0.0.0');

  // contributions 在 apiVersion 2 里是**可选**的：代码插件的贡献在运行期产生。
  // apiVersion 1 照旧必填（P0 的包一直有这一格，缺了它是清单写错，不是"没有贡献"）。
  const contributionsValue = value['contributions'];
  if (apiVersion === PLUGIN_API_VERSION_V1 && contributionsValue === undefined) {
    throw new Error(`${where}.contributions: expected an object`);
  }
  const contributions = contributionsValue === undefined
    ? {}
    : record(contributionsValue, `${where}.contributions`);
  exactKeys(contributions, ['skills', 'hooks', 'mcp'], `${where}.contributions`);
  const skillsValue = contributions['skills'];
  if (skillsValue !== undefined && !Array.isArray(skillsValue)) throw new Error(`${where}.contributions.skills: expected an array`);
  if (apiVersion === PLUGIN_API_VERSION_V1 && skillsValue === undefined) {
    throw new Error(`${where}.contributions.skills: expected an array`);
  }
  const skills = Object.freeze((skillsValue ?? []).map((path, i) => pluginContributionPath(path, `${where}.contributions.skills[${i}]`)));
  const result: { skills: readonly string[]; hooks?: string; mcp?: string } = { skills };
  for (const key of ['hooks', 'mcp'] as const) {
    if (contributions[key] !== undefined) result[key] = pluginContributionPath(contributions[key], `${where}.contributions.${key}`);
  }

  const permissions = apiVersion === PLUGIN_API_VERSION_V1
    ? (() => {
      if (!permissionsArray(value['permissions'])) throw new Error(`${where}.permissions: expected a string array`);
      return [...value['permissions']];
    })()
    : parseV2Permissions(value['permissions'], `${where}.permissions`);

  const hooks = value['hooks'] === undefined
    ? []
    : parseHookDeclarations(value['hooks'], permissions, `${where}.hooks`);

  const netAllow = apiVersion === PLUGIN_API_VERSION_V2
    ? parseNetAllow(value, permissions, where)
    : [];

  const runtime = parseRuntime(value['runtime'], `${where}.runtime`, apiVersion);
  const config = apiVersion === PLUGIN_API_VERSION_V2 && value['config'] !== undefined
    ? pluginContributionPath(value['config'], `${where}.config`)
    : undefined;
  const meta = apiVersion === PLUGIN_API_VERSION_V2 && value['meta'] !== undefined
    ? parseMeta(value['meta'], `${where}.meta`)
    : undefined;

  return Object.freeze({
    apiVersion,
    id: value['id'],
    version: value['version'],
    engine: Object.freeze({ irmia: engine['irmia'] }),
    contributions: Object.freeze(result),
    permissions: Object.freeze(permissions),
    hooks: Object.freeze(hooks),
    netAllow: Object.freeze(netAllow),
    runtime,
    ...(config === undefined ? {} : { config }),
    ...(meta === undefined ? {} : { meta }),
  }) as PluginManifest;
}

/** 这份清单是否要起子进程（false = P0 的声明式包，装配面完全不变） */
export function isCodePlugin(manifest: PluginManifest): boolean {
  return manifest.runtime.type === 'node' || manifest.runtime.type === 'python';
}

// ──────────────────────────────── 配置 schema 校验 ────────────────────────────────

function configScalar(value: unknown, where: string): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  throw new Error(`${where}: 只支持 string / number / boolean`);
}

function matchesType(value: unknown, type: PluginConfigProperty['type']): boolean {
  // number 不走 `typeof` 的宽松口径：`NaN`/`Infinity` 不是能被 JSON 表达的配置值
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

export function parsePluginConfigSchema(raw: unknown, where = 'config.schema.json'): PluginConfigSchema {
  const value = record(raw, where);
  exactKeys(value, ['type', 'properties', 'description'], where);
  if (value['type'] !== 'object') throw new Error(`${where}.type: 只支持 object`);
  const properties = record(value['properties'], `${where}.properties`);
  const keys = Object.keys(properties);
  if (keys.length > MAX_CONFIG_PROPERTIES) throw new Error(`${where}.properties: 最多 ${MAX_CONFIG_PROPERTIES} 项`);
  const out: Record<string, PluginConfigProperty> = {};
  for (const key of keys) {
    if (!CONFIG_KEY.test(key)) throw new Error(`${where}.properties: 非法键名 ${JSON.stringify(key)}`);
    const property = record(properties[key], `${where}.properties.${key}`);
    exactKeys(property, ['type', 'enum', 'default', 'description'], `${where}.properties.${key}`);
    const type = property['type'];
    if (type !== 'string' && type !== 'number' && type !== 'boolean') {
      throw new Error(`${where}.properties.${key}.type: 只支持 string / number / boolean`);
    }
    const parsed: { type: PluginConfigProperty['type']; enum?: readonly (string | number | boolean)[]; default?: string | number | boolean; description?: string } = { type };
    if (property['enum'] !== undefined) {
      if (!Array.isArray(property['enum']) || property['enum'].length === 0) throw new Error(`${where}.properties.${key}.enum: expected a non-empty array`);
      const choices = property['enum'].map((item, index) => configScalar(item, `${where}.properties.${key}.enum[${index}]`));
      if (!choices.every((choice) => matchesType(choice, type))) throw new Error(`${where}.properties.${key}.enum: 每项都要与 type 一致`);
      parsed.enum = Object.freeze(choices);
    }
    if (property['default'] !== undefined) {
      const fallback = configScalar(property['default'], `${where}.properties.${key}.default`);
      if (!matchesType(fallback, type)) throw new Error(`${where}.properties.${key}.default: 与 type 不一致`);
      if (parsed.enum !== undefined && !parsed.enum.includes(fallback)) throw new Error(`${where}.properties.${key}.default: 不在 enum 内`);
      parsed.default = fallback;
    }
    if (property['description'] !== undefined) {
      if (typeof property['description'] !== 'string' || property['description'].length > 500) {
        throw new Error(`${where}.properties.${key}.description: expected a string (≤500 字符)`);
      }
      parsed.description = property['description'];
    }
    out[key] = Object.freeze(parsed);
  }
  return Object.freeze({ type: 'object', properties: Object.freeze(out) });
}

/**
 * 默认值 + 人工覆盖值 → 插件实际拿到的配置。
 *
 * 覆盖值**不合法不抛错**：一个写坏的设置项不该让插件起不来（那会让整个插件从执行面消失），
 * 但也不能静默——问题以字符串返回，调用方写进宿主日志。
 */
export function resolvePluginConfig(
  schema: PluginConfigSchema | undefined,
  overrides: Record<string, unknown> = {},
): PluginConfigResolution {
  const values: Record<string, string | number | boolean> = {};
  if (schema === undefined) return { values, problems: [] };
  const problems: string[] = [];
  for (const [key, property] of Object.entries(schema.properties)) {
    if (property.default !== undefined) values[key] = property.default;
  }
  for (const [key, raw] of Object.entries(overrides)) {
    const property = schema.properties[key];
    if (property === undefined) {
      problems.push(`配置项 ${key} 不在 schema 里，已忽略`);
      continue;
    }
    if (!matchesType(raw, property.type)) {
      problems.push(`配置项 ${key} 应为 ${property.type}，实际是 ${typeof raw}，已忽略`);
      continue;
    }
    if (property.enum !== undefined && !property.enum.includes(raw as string | number | boolean)) {
      problems.push(`配置项 ${key} 的值不在 enum 内，已忽略`);
      continue;
    }
    values[key] = raw as string | number | boolean;
  }
  return { values, problems };
}
