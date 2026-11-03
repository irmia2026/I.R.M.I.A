/**
 * `ctx.net.fetch` 的宿主侧实现：**唯一能真正限网的一层**。
 *
 * 为什么必须是宿主代理：Node 的 `--permission` 没有网络那一维（`import('node:http')` 照样能出去），
 * Python 更管不了。插件进程本身没有 `fetch`，所有出站请求都只能把 URL 交给宿主；宿主按
 * `net.allow` 放行、按"解析后的 IP"做 SSRF 判据、限额截断，然后才发出去。
 *
 * 四条硬判据（每一条都对应一类真实事故）：
 *   ① **默认全拒**：`net.allow` 没写就是空表。没有白名单的网络插件只能拿到 -32006。
 *   ② **解析后的 IP 才算数**：白名单匹配的是 URL 里的主机名，但请求真正连的是 DNS 解析结果。
 *      回环/私有/链路本地/保留段一律拒绝——除非主机名本身就是 IP 且**显式**写在 `net.allow` 里
 *      （那是人明确说"我知道它是内网地址，我要放行"的唯一写法）。
 *   ③ **每一跳都重新过判据**：重定向不许把"白名单里的域名"变成"内网地址"或"名单外主机"。
 *      最多 3 跳，超了直接拒绝。
 *   ④ **限额是硬上限**：8MB 响应体、15s 总超时。截断会在返回里如实标 `truncated`。
 *
 * 日志纪律：**只记去掉了 query 的 URL**（query 里可能是密钥），一次调用一条，拒绝也记。
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, validateHeaderValue, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

import { permissionDeniedError, PluginRpcError, PLUGIN_RPC_ERRORS } from './protocol.ts';

/** 响应体硬上限：8MB（与协议单行上限同量级） */
export const PLUGIN_NET_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** 一次 `net.fetch` 的总预算（含所有重定向跳） */
export const PLUGIN_NET_TIMEOUT_MS = 15_000;
/** 最多跟随几跳重定向 */
export const PLUGIN_NET_MAX_REDIRECTS = 3;
/** 请求体上限：插件给宿主的一帧本来就不会超过 8MB，这里再收一档 */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_REQUEST_HEADERS = 32;
const MAX_HEADER_VALUE_CHARS = 2_048;
/** 只留安全的响应头子集（不带 set-cookie、server 内部地址等） */
const SAFE_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'content-type', 'content-length', 'content-language', 'content-encoding',
  'cache-control', 'etag', 'last-modified', 'retry-after',
]);
/** 请求头里不许出现的：逐跳头与由宿主重新计算的头 */
const FORBIDDEN_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'keep-alive', 'te', 'trailer',
]);
const ALLOWED_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const REDIRECT_STATUS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export interface PluginNetFetchInput {
  url: string;
  init?: unknown;
}

export interface PluginNetFetchResult {
  status: number;
  headers: Record<string, string>;
  body: { kind: 'text' | 'base64'; data: string; truncated: boolean };
  /** 最终 URL（含 query——插件自己要求的地址，日志里会去掉 query） */
  url: string;
  redirects: number;
  durationMs: number;
}

export interface PluginNetFetchOptions {
  input: PluginNetFetchInput;
  /** 清单里的网络白名单（已归一化、小写） */
  allow: readonly string[];
  /** 宿主开关：允许 http:// 且只允许 127.0.0.1 / localhost（默认关） */
  allowInsecureLoopbackHttp: boolean;
  /** 日志前缀里的插件标识（`demo@abcd1234`） */
  label: string;
  log: (line: string) => void;
  now?: () => number;
  /** 宿主可收紧总期限，不能超过默认的 15 秒；不接受插件传参覆盖。 */
  timeoutMs?: number;
  /** 宿主解析器；缺省使用系统 lookup，保留 hosts 文件语义。 */
  lookup?: (host: string) => Promise<readonly { address: string; family: number }[]>;
}

interface ParsedInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

interface HopResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
  /** 非 null = 这一跳是重定向，值是已解析的绝对地址 */
  location: string | null;
}

// ──────────────────────────────── 主机名 / IP 判据 ────────────────────────────────

/** 去掉 IPv6 的方括号（URL.hostname 与白名单条目可能是两种写法） */
export function bareHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

/** 把 IPv6 归一到 WHATWG URL 的压缩形式，避免 `0:0:…:1` 与 `::1` 被当成两条白名单 */
function canonicalHost(host: string): string {
  const bare = bareHost(host);
  if (isIP(bare) !== 6) return bare;
  try {
    return new URL(`http://[${bare}]/`).hostname.slice(1, -1);
  } catch {
    return bare;
  }
}

/**
 * 主机名是否命中白名单。
 *
 * 精确条目只匹配它自己；`*.example.com` 匹配**至少一级**子域（`a.example.com` 与
 * `a.b.example.com`），但**不匹配** `example.com` 本身——这是通配符最常见的语义，
 * 也避免"写了 *.example.com 却把主域也放出去"这种意外。
 */
export function isHostAllowed(host: string, allow: readonly string[]): boolean {
  const target = canonicalHost(host);
  for (const entry of allow) {
    const normalized = canonicalHost(entry);
    if (normalized.startsWith('*.')) {
      const suffix = normalized.slice(2);
      if (target.endsWith(`.${suffix}`) && target.length > suffix.length + 1) return true;
      continue;
    }
    if (target === normalized) return true;
  }
  return false;
}

/** IPv4 段 → 人话里的拒绝理由（null = 公网地址） */
function blockedIpv4Reason(address: string): string | null {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return '无法识别的 IPv4 地址';
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0) return '保留地址 0.0.0.0/8';
  if (a === 10) return '私有地址 10.0.0.0/8';
  if (a === 100 && b >= 64 && b <= 127) return '运营商级 NAT 100.64.0.0/10';
  if (a === 127) return '回环地址 127.0.0.0/8';
  if (a === 169 && b === 254) return '链路本地 169.254.0.0/16';
  if (a === 172 && b >= 16 && b <= 31) return '私有地址 172.16.0.0/12';
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return '保留地址 192.0.0.0/24 或 TEST-NET-1';
  if (a === 192 && b === 168) return '私有地址 192.168.0.0/16';
  if (a === 198 && (b === 18 || b === 19)) return '基准测试网段 198.18.0.0/15';
  if (a === 198 && b === 51 && c === 100) return 'TEST-NET-2 198.51.100.0/24';
  if (a === 203 && b === 0 && c === 113) return 'TEST-NET-3 203.0.113.0/24';
  if (a >= 224 && a <= 239) return '组播地址 224.0.0.0/4';
  if (a >= 240) return '保留地址 240.0.0.0/4';
  return null;
}

/** 把 IPv6 展开成 8 个 16 位段（处理 `::` 与内嵌 IPv4） */
function ipv6Groups(address: string): number[] | null {
  const lower = address.toLowerCase().split('%')[0]!;
  if (!lower.includes(':')) return null;
  const [headRaw, tailRaw] = lower.split('::');
  const head = headRaw === '' || headRaw === undefined ? [] : headRaw.split(':');
  const tail = tailRaw === undefined || tailRaw === '' ? [] : tailRaw.split(':');
  const expand = (part: string): string[] => {
    if (!part.includes('.')) return [part];
    const v4 = part.split('.').map(Number);
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return [part];
    return [((v4[0]! << 8) | v4[1]!).toString(16), ((v4[2]! << 8) | v4[3]!).toString(16)];
  };
  const headParts = head.flatMap(expand);
  const tailParts = tail.flatMap(expand);
  const fill = tailRaw === undefined ? [] : new Array(Math.max(0, 8 - headParts.length - tailParts.length)).fill('0');
  const groups = [...headParts, ...fill, ...tailParts];
  if (groups.length !== 8) return null;
  const numbers = groups.map((part) => Number.parseInt(part === '' ? '0' : part, 16));
  return numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff) ? null : numbers;
}

/** IPv6 → 拒绝理由（null = 公网地址） */
function blockedIpv6Reason(address: string): string | null {
  const lower = address.toLowerCase().split('%')[0]!;
  // IPv4 映射/转换的各种写法都先按"映射地址"拒掉：插件要访问公网不需要它，
  // 而各种 `::ffff:0:…` 变体最容易让逐段判断漏掉一个内嵌的私网 IPv4。
  if (lower.includes('::ffff:')) return 'IPv4 映射地址（内嵌 IPv4 一律按内网判据处理）';
  const groups = ipv6Groups(address);
  if (groups === null) return '无法识别的 IPv6 地址';
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  if (groups.every((group) => group === 0)) return '未指定地址 ::';
  if (groups.slice(0, 7).every((group) => group === 0) && g7 === 1) return '回环地址 ::1';
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    const mapped = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
    const reason = blockedIpv4Reason(mapped);
    return reason === null ? null : `IPv4 映射地址 ${mapped}（${reason}）`;
  }
  if ((g0 & 0xfe00) === 0xfc00) return '唯一本地地址 fc00::/7';
  if ((g0 & 0xffc0) === 0xfe80) return '链路本地 fe80::/10';
  if ((g0 & 0xff00) === 0xff00) return '组播地址 ff00::/8';
  if (g0 === 0x2001 && g1 === 0x0db8) return '文档地址 2001:db8::/32';
  if (g0 === 0x64 && g1 === 0xff9b) return 'NAT64 映射 64:ff9b::/96';
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return '丢弃专用 100::/64';
  return null;
}

/**
 * 这个地址是不是"不该从插件里出去"的地址。返回 null = 公网。
 *
 * 覆盖了需求里点名的全部段，并顺手把 TEST-NET / 组播 / NAT64 也带上：这些地址要么根本
 * 不可达，要么是扫描内网的常见跳板，放行它们没有任何业务价值。
 */
export function blockedAddressReason(address: string): string | null {
  const version = isIP(address);
  if (version === 4) return blockedIpv4Reason(address);
  if (version === 6) return blockedIpv6Reason(address);
  return '不是 IP 地址';
}

// ──────────────────────────────── 入参解析 ────────────────────────────────

function business(message: string, data?: Record<string, unknown>): PluginRpcError {
  return new PluginRpcError(PLUGIN_RPC_ERRORS.business, message, 'business', data);
}

function invalid(message: string): PluginRpcError {
  return new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams, message, 'protocol');
}

function parseInit(value: unknown): ParsedInit {
  if (value === undefined || value === null) return { method: 'GET', headers: {} };
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('net.fetch 的第二个参数必须是对象');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'method' && key !== 'headers' && key !== 'body') {
      throw invalid(`net.fetch 的第二个参数只支持 method / headers / body（收到了 ${key}）`);
    }
  }
  const rawMethod = record['method'];
  const method = typeof rawMethod === 'string' ? rawMethod.trim().toUpperCase() : 'GET';
  if (!ALLOWED_METHODS.has(method)) throw invalid(`net.fetch.method: 只支持 ${[...ALLOWED_METHODS].join('/')}`);
  const headers: Record<string, string> = {};
  const rawHeaders = record['headers'];
  if (rawHeaders !== undefined && rawHeaders !== null) {
    if (typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) throw invalid('net.fetch.headers: 必须是对象');
    const entries = Object.entries(rawHeaders as Record<string, unknown>);
    if (entries.length > MAX_REQUEST_HEADERS) throw invalid(`net.fetch.headers: 最多 ${MAX_REQUEST_HEADERS} 项`);
    for (const [name, headerValue] of entries) {
      const lower = name.toLowerCase();
      if (!/^[a-z0-9-]{1,64}$/.test(lower)) throw invalid(`net.fetch.headers: 非法头名 ${JSON.stringify(name)}`);
      if (FORBIDDEN_REQUEST_HEADERS.has(lower) || lower.startsWith('proxy-')) {
        throw invalid(`net.fetch.headers: 不允许设置 ${name}（由宿主决定）`);
      }
      if (typeof headerValue !== 'string' || headerValue.length > MAX_HEADER_VALUE_CHARS || /[\r\n]/.test(headerValue)) {
        throw invalid(`net.fetch.headers.${name}: 必须是 ≤${MAX_HEADER_VALUE_CHARS} 字符且不含换行的字符串`);
      }
      try { validateHeaderValue(lower, headerValue); }
      catch { throw invalid(`net.fetch.headers.${name}: 含 HTTP 请求头不支持的字符`); }
      headers[lower] = headerValue;
    }
  }
  const rawBody = record['body'];
  if (rawBody === undefined || rawBody === null) return { method, headers };
  if (typeof rawBody !== 'string') throw invalid('net.fetch.body: 只支持字符串（二进制请先 base64 再自行编码）');
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_REQUEST_BODY_BYTES) {
    throw invalid(`net.fetch.body: 超过 ${MAX_REQUEST_BODY_BYTES} 字节`);
  }
  if (method === 'GET' || method === 'HEAD') throw invalid(`net.fetch: ${method} 不能带 body`);
  return { method, headers, body: rawBody };
}

/** 归一化后可记录的 URL：**去掉 query**（可能是密钥），并截断到人能读的长度 */
export function redactUrlForLog(raw: string, maxChars = 300): string {
  try {
    const url = new URL(raw);
    const query = url.search === '' ? '' : '?<已隐去>';
    const rendered = `${url.protocol}//${url.host}${url.pathname}${query}`;
    return rendered.length <= maxChars ? rendered : `${rendered.slice(0, maxChars)}…`;
  } catch {
    // 连 URL 都解析不了：至少把 query / fragment 切掉，绝不把疑似密钥的原文照抄进日志
    const flat = raw.split('?')[0]!.split('#')[0]!.replace(/\s+/gu, ' ');
    return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}…`;
  }
}

function checkTarget(raw: string, options: PluginNetFetchOptions): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid(`net.fetch: 不是合法 URL（${raw.slice(0, 200)}）`);
  }
  if (url.username !== '' || url.password !== '') throw business('net.fetch 拒绝：URL 里不能带用户名或密码');
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:') {
    if (!options.allowInsecureLoopbackHttp) {
      throw business('net.fetch 拒绝：只允许 https（http 默认关闭；要访问本机回环必须由宿主显式打开开关）');
    }
    const host = bareHost(url.hostname);
    if (host !== '127.0.0.1' && host !== 'localhost') {
      throw business(`net.fetch 拒绝：http 只允许 127.0.0.1 / localhost（收到 ${host}）`);
    }
    return url;
  }
  throw business(`net.fetch 拒绝：只支持 https（收到 ${url.protocol}）；file: / data: 等协议一律不允许`);
}

async function resolveChecked(url: URL, options: PluginNetFetchOptions): Promise<ResolvedAddress> {
  const host = bareHost(url.hostname);
  if (!isHostAllowed(host, options.allow)) {
    throw business(`net.fetch 拒绝：主机 ${host} 不在 net.allow 里（插件 ${options.label}）`, { host, reason: 'not-allowlisted' });
  }
  let addresses: ResolvedAddress[];
  if (isIP(host) !== 0) {
    addresses = [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
  } else {
    try {
      const list = await (options.lookup === undefined
        ? dnsLookup(host, { all: true, verbatim: true })
        : options.lookup(host));
      addresses = list.map((item) => ({ address: item.address, family: item.family === 6 ? 6 : 4 }));
    } catch (error) {
      throw business(`net.fetch 失败：无法解析主机 ${host}（${error instanceof Error ? error.message : String(error)}）`, { host, reason: 'dns' });
    }
  }
  if (addresses.length === 0) throw business(`net.fetch 失败：主机 ${host} 没有解析结果`, { host, reason: 'dns' });
  // 显式放行一个 IP 字面量：这是**人**在清单里写下的"我知道它是内网地址"。
  // 只有主机名本身是 IP 时才算数；一个域名解析到内网地址永远不享受这个豁免。
  const explicitlyAllowedIp = isIP(host) !== 0 && isHostAllowed(host, options.allow);
  for (const address of addresses) {
    const reason = blockedAddressReason(address.address);
    if (reason !== null && !explicitlyAllowedIp) {
      throw business(
        `net.fetch 拒绝：${host} 解析到 ${address.address}（${reason}）。内网/回环地址只有在 net.allow 里显式写这个 IP 时才放行`,
        { host, address: address.address, reason: 'ssrf' },
      );
    }
  }
  return addresses[0]!;
}

// ──────────────────────────────── 单跳请求 ────────────────────────────────

function safeResponseHeaders(raw: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!SAFE_RESPONSE_HEADERS.has(name)) continue;
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function decodeBody(buffer: Buffer, headers: Record<string, string>): { kind: 'text' | 'base64'; data: string } {
  const encoding = (headers['content-encoding'] ?? '').toLowerCase().trim();
  if (encoding !== '' && encoding !== 'identity') {
    // 没解压就老实给 base64：把压缩字节当文本解码只会得到乱码，那是"看起来成功"的假话
    return { kind: 'base64', data: buffer.toString('base64') };
  }
  const contentType = (headers['content-type'] ?? '').toLowerCase();
  const mime = contentType.split(';')[0]?.trim() ?? '';
  const textual = mime === ''
    || mime.startsWith('text/')
    || /(?:json|xml|javascript|x-www-form-urlencoded|graphql|yaml|csv)/u.test(mime);
  if (!textual) return { kind: 'base64', data: buffer.toString('base64') };
  const charset = /charset\s*=\s*"?([^";]+)"?/iu.exec(contentType)?.[1]?.trim() ?? 'utf-8';
  try {
    return { kind: 'text', data: new TextDecoder(charset, { fatal: true }).decode(buffer) };
  } catch {
    return { kind: 'base64', data: buffer.toString('base64') };
  }
}

function pinnedLookup(address: ResolvedAddress): LookupFunction {
  const lookup = ((_hostname: string, lookupOptions: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (lookupOptions.all === true) {
      callback(null, [{ address: address.address, family: address.family }]);
      return;
    }
    callback(null, address.address, address.family);
  }) as unknown as LookupFunction;
  return lookup;
}

function requestHop(url: URL, init: ParsedInit, address: ResolvedAddress, timeoutMs: number, signal: AbortSignal, totalTimeoutMs: number): Promise<HopResult> {
  return new Promise<HopResult>((resolve, reject) => {
    const requestOptions: RequestOptions = {
      method: init.method,
      headers: {
        ...init.headers,
        accept: init.headers['accept'] ?? '*/*',
        'accept-encoding': 'identity',
        'user-agent': init.headers['user-agent'] ?? 'irmia-plugin-net/1',
      },
      lookup: pinnedLookup(address),
      signal,
    };
    let settled = false;
    let truncated = false;
    let request: ClientRequest | undefined;
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      request?.destroy();
      reject(business(`net.fetch 失败：超过 ${totalTimeoutMs}ms 未完成（${redactUrlForLog(url.href)}）`, { reason: 'timeout' }));
    }, Math.max(1, timeoutMs));
    const finish = (result: HopResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(business(`net.fetch 失败：${error instanceof Error ? error.message : String(error)}（${redactUrlForLog(url.href)}）`, { reason: 'network' }));
    };
    try {
    request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, requestOptions, (response) => {
      const status = response.statusCode ?? 0;
      const headers = safeResponseHeaders(response.headers);
      const location = typeof response.headers.location === 'string' ? response.headers.location : null;
      if (REDIRECT_STATUS.has(status) && location !== null) {
        response.destroy();
        finish({ status, headers, body: Buffer.alloc(0), truncated: false, location });
        return;
      }
      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        if (total >= PLUGIN_NET_MAX_BODY_BYTES) {
          truncated = true;
          response.destroy();
          finish({ status, headers, body: Buffer.concat(chunks, total), truncated, location: null });
          return;
        }
        const remaining = PLUGIN_NET_MAX_BODY_BYTES - total;
        if (chunk.length > remaining) {
          chunks.push(chunk.subarray(0, remaining));
          total += remaining;
          truncated = true;
          response.destroy();
          finish({ status, headers, body: Buffer.concat(chunks, total), truncated, location: null });
          return;
        }
        chunks.push(chunk);
        total += chunk.length;
      });
      response.on('end', () => {
        finish({ status, headers, body: Buffer.concat(chunks, total), truncated, location: null });
      });
      response.on('error', (error) => {
        if (truncated) {
          finish({ status, headers, body: Buffer.concat(chunks, total), truncated, location: null });
          return;
        }
        fail(error);
      });
    });
    } catch (error) { fail(error); return; }
    request.on('error', (error) => {
      if (truncated) {
        finish({ status: 0, headers: {}, body: Buffer.concat(chunks, total), truncated, location: null });
        return;
      }
      fail(error);
    });
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}

// ──────────────────────────────── 入口 ────────────────────────────────

/**
 * 执行一次 `ctx.net.fetch`。**所有失败都以 PluginRpcError 抛出**，并且一定会写一条日志。
 *
 * 调用方（host-services）只负责权限判断（`net` 票），网络策略全部在这里。
 */
export async function pluginNetFetch(options: PluginNetFetchOptions): Promise<PluginNetFetchResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const timeoutMs = options.timeoutMs === undefined || !Number.isFinite(options.timeoutMs)
    ? PLUGIN_NET_TIMEOUT_MS : Math.max(1, Math.min(PLUGIN_NET_TIMEOUT_MS, options.timeoutMs));
  const controller = new AbortController();
  const timeoutError = (): PluginRpcError => business(`net.fetch 失败：超过 ${timeoutMs}ms 未完成`, { reason: 'timeout' });
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
  // 系统 lookup 不支持取消；只等待到总期限，迟到的结果／拒绝被消费，绝不再发请求。
  const withinDeadline = async <T>(run: () => Promise<T>): Promise<T> => {
    if (controller.signal.aborted) throw timeoutError();
    return await new Promise<T>((resolve, reject) => {
      const abort = (): void => { reject(timeoutError()); };
      controller.signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(run).then(resolve, reject).finally(() => {
        controller.signal.removeEventListener('abort', abort);
      });
    });
  };
  let method = 'GET';
  let loggedUrl = options.input.url;
  try {
    const init = parseInit(options.input.init);
    method = init.method;
    let current = checkTarget(options.input.url, options);
    loggedUrl = current.href;
    let redirects = 0;
    const deadline = started + timeoutMs;
    for (;;) {
      if (deadline - now() <= 0 || controller.signal.aborted) throw timeoutError();
      const address = await withinDeadline(async () => await resolveChecked(current, options));
      const remaining = deadline - now();
      if (remaining <= 0 || controller.signal.aborted) throw timeoutError();
      const hop = await withinDeadline(async () => await requestHop(current, init, address, remaining, controller.signal, timeoutMs));
      if (hop.location !== null) {
        if (redirects >= PLUGIN_NET_MAX_REDIRECTS) {
          throw business(`net.fetch 拒绝：重定向超过 ${PLUGIN_NET_MAX_REDIRECTS} 次`, { reason: 'redirect-limit' });
        }
        const nextRaw = new URL(hop.location, current).href;
        // 浏览器同形语义：303 一律 GET；301/302 的非 GET/HEAD 也降成 GET 并丢掉 body
        if (hop.status === 303 || ((hop.status === 301 || hop.status === 302) && init.method !== 'GET' && init.method !== 'HEAD')) {
          init.method = 'GET';
          delete init.body;
        }
        current = checkTarget(nextRaw, options);
        redirects += 1;
        continue;
      }
      const decoded = decodeBody(hop.body, hop.headers);
      const result: PluginNetFetchResult = {
        status: hop.status,
        headers: hop.headers,
        body: { ...decoded, truncated: hop.truncated },
        url: current.href,
        redirects,
        durationMs: Math.max(0, now() - started),
      };
      options.log(`${options.label} net.fetch ${method} ${redactUrlForLog(current.href)} -> ${result.status}`
        + `（${result.durationMs}ms${result.body.truncated ? '，响应体已截断到 8MB' : ''}${redirects > 0 ? `，${redirects} 次重定向` : ''}）`);
      return result;
    }
  } catch (error) {
    if (controller.signal.aborted) error = timeoutError();
    const message = error instanceof Error ? error.message : String(error);
    options.log(`${options.label} net.fetch ${method} ${redactUrlForLog(loggedUrl)} 被拒/失败：${message}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `net.fetch` 的权限门（单独导出给测试与文档核对）：没声明 `net` 直接 -32001。
 *
 * 放在这里而不是 host-services 里，是为了让"缺哪张票"与网络策略在同一份文件里可读。
 */
export function requireNetPermission(pluginId: string, permissions: ReadonlySet<string>, method = 'net.fetch'): void {
  if (permissions.has('net')) return;
  throw permissionDeniedError(pluginId, 'net', method);
}
