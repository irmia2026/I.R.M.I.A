/**
 * Irmia Agent — 依赖安装（下载 → 解压 → 复检）
 *
 * **零外部依赖是硬约束**，所以这里的三件事全部自己写：
 *   · 下载用 `node:https`（跟随重定向、带上限的流式落盘）；
 *   · 解压用 `node:zlib` 的 `inflateRawSync`（zip 的 deflate 是裸流）+ 手写的 zip 目录解析；
 *   · 落盘用 `node:fs/promises`。
 * 引一个 `extract-zip` 或 `unzipper` 会让"零依赖"这条承诺当场作废，而 zip 的这个子集
 * （只读、只收 store/deflate、路径穿越防护）不到 150 行。
 *
 * **三种失败必须分开反馈**（用户点名）：下载失败 / 解压失败 / 装完复检仍找不到。
 * 合成一句"安装失败"的代价是用户完全不知道下一步做什么——是网络问题就重试、
 * 是包结构变了就换下载源、是杀毒软件挡了就得手动放行，三条路的处置完全不同。
 * 所以 `DepInstallStep` 把阶段名也带出去了。
 *
 * 另有一条刻意的取舍：**不校验签名/哈希**。一是我们拿不到权威的哈希清单（voidtools 有
 * 但会随版本变，ripgrep release 有 .sha256 但同样要按版本拼 URL），二是这类下载走的是
 * 官方 HTTPS 源。真正的防线是"来源固定 + 用户看得见下载了什么"（报告里带 URL 与字节数）。
 */

import { existsSync } from 'node:fs';
import { mkdir, copyFile, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { get as httpsGet, type RequestOptions } from 'node:https';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { TOOLS_DIR_NAME, defaultDepFs, findExecutableInDir, type DepName } from './probe.ts';
import { decodeText } from '../util/bytes-text.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 单次下载的最大字节数：两个包都在 5MB 以内，64MB 已经是"这肯定不是我们要的东西" */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
/** 重定向跟随上限：官方源最多一两跳（GitHub release 资产会跳一次到 CDN） */
export const MAX_REDIRECTS = 5;
/** 单个 zip 内解压出来的总字节上限：防"解压炸弹"（zip 的压缩比可以极高） */
export const MAX_EXTRACT_BYTES = 256 * 1024 * 1024;
/** 自装清单文件名：记下装了什么版本、从哪来、什么时候装的 */
export const MANIFEST_FILE_NAME = 'install.json';
/** 下载临时文件所在子目录（`<dataDir>/tools/.cache/`）：装完就删，失败留一半也能被人看见 */
export const CACHE_DIR_NAME = '.cache';

/** GitHub 的 ripgrep 最新 release 查询端点（用它比写死版本号可靠：版本号会过期） */
export const RIPGREP_RELEASE_API = 'https://api.github.com/repos/BurntSushi/ripgrep/releases/latest';
/** ripgrep 的 Windows 资产名片段：官方 release 里那个 msvc 构建 */
export const RIPGREP_ASSET_MARKER = 'x86_64-pc-windows-msvc.zip';

/**
 * es.exe 的 zip 地址。**它是固定的**（voidtools 的链接不随版本变，历史上 1.1.0.27 → 1.1.0.38
 * 都是同一个 URL），代价是这个 URL 里嵌着版本号 `ES-1.1.0.38`——版本升到 1.1.0.39 时
 * 这个链接会 404。那种情况下 `dep-install` 会如实报"下载失败：HTTP 404"并给出
 * 下载页地址，用户点「打开下载页」手动装即可（不会静默失败）。
 */
export const ES_CLI_ZIP_URL = 'https://www.voidtools.com/ES-1.1.0.38.x64.zip';

/**
 * python.org 的发布列表 API（匿名、无 key、无配额烦恼：装一次用一次）。
 *
 * 为什么要有它（而不是像 es 那样只写死一个地址）：`latest` 那个概念在 python.org 的 ftp 上
 * **不存在**——路径是 `/ftp/python/<版本>/python-<版本>-embed-amd64.zip`，版本号必须自己填。
 * 而"最新稳定版"是**会变的**（实测 2026-10-16：`is_latest` 是 3.15.0，而一年前是 3.13），
 * 写死的那一刻就开始过期。所以这里走"能查就查、查不到就用钉住的兜底"。
 *
 * 响应实测形状（`GET ?is_published=true`，275 条）：一个 JSON 数组，每条有
 * `name`（`Python 3.15.0`）/ `slug`（`python-3150`）/ `pre_release` / `is_latest` / `release_date`。
 */
export const PYTHON_RELEASE_API = 'https://www.python.org/api/v2/downloads/release/?is_published=true';

/** 官方 embeddable 包在 ftp 上的路径形状（3.5 至今没变过）与文件名后缀 */
export const PYTHON_FTP_PREFIX = 'https://www.python.org/ftp/python/';
export const PYTHON_EMBED_ASSET_MARKER = '-embed-amd64.zip';

/**
 * 钉住的兜底：3.13.16（用户 2026-10-16 批的那一版）。
 * 实测 `HEAD` → 200 · 11,439,094 字节 · Last-Modified 2026-09-30；range 摸前 4KB →
 * 标准 zip（`504b0304`）、首成员 **`python.exe`**、method 8（deflate）
 * ⇒ 走我们那个只收 store/deflate 的手写解压器没问题。
 */
export const PYTHON_EMBED_URL =
  `${PYTHON_FTP_PREFIX}3.13.16/python-3.13.16${PYTHON_EMBED_ASSET_MARKER}`;

/** zip 探测签名：末尾的 22 字节 EOCD 里以它开头 */
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** zip 注释最大 65535 字节，EOCD 只可能落在这段里 */
const MAX_COMMENT_BYTES = 0xffff;

// ──────────────────────────────── 阶段与失败分类 ────────────────────────────────

/**
 * 安装阶段。**这三种失败分开反馈**就是靠它：
 *   download → 网络/来源问题；extract → 包结构/损坏；verify → 装完复检仍找不到；done → 成功
 */
export type DepInstallStep = 'download' | 'extract' | 'verify' | 'done';

export interface DepInstallFailure {
  ok: false;
  step: Exclude<DepInstallStep, 'done'>;
  name: DepName;
  /** 给用户看的一句话（含下一步） */
  error: string;
  /** 每一步的具体细节（URL、退出码、试过的路径），报告里逐行列出 */
  details: string[];
}

export interface DepInstallSuccess {
  ok: true;
  step: 'done';
  name: DepName;
  /** 安装目录（`<dataDir>/tools/<name>`） */
  dir: string;
  /** 落地的可执行文件绝对路径 */
  exePath: string;
  version: string;
  sourceUrl: string;
  bytes: number;
  /**
   * 收尾步骤（`ZipPackage.postExtract`）给出的版本，如 python 的 **pip 版本**。
   * 省略 = 这一件没有收尾步骤，或收尾没成——**没成时收尾自己会在 details 里说清**，
   * 这里不许填一个"看起来有"的值。
   */
  auxiliaryVersion?: string | undefined;
  /** 收尾步骤是不是成功了（省略 = 没有收尾步骤）。false 时 details 里必有原因 */
  auxiliaryOk?: boolean | undefined;
  details: string[];
}

export type DepInstallOutcome = DepInstallSuccess | DepInstallFailure;

// ──────────────────────────────── 下载 ────────────────────────────────

export interface DownloadResult {
  ok: boolean;
  /** 落盘的文件路径（失败时可能是一个不完整的临时文件，调用方负责清） */
  path: string;
  bytes: number;
  /** 最终 URL（跟随重定向之后）——报告里给人看的是这个 */
  finalUrl: string;
  error: string;
}

/** 下载器的注入点：测试用假源，绝不联网 */
export type Downloader = (url: string, target: string) => Promise<DownloadResult>;

/** 把 URL 文本解析成请求参数；非 http(s) 一律拒绝（不做 file:// 那种"读本地文件"的后门） */
function parseHttpUrl(url: string): { ok: true; parts: URL } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `下载地址不是合法 URL：${url}` };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: `只支持 http/https 下载，收到 ${parsed.protocol}` };
  }
  return { ok: true, parts: parsed };
}

/**
 * 真实下载器：`node:https` 流式落盘，带重定向跟随与字节上限。
 *
 * 为什么要流式而不是 `res.on('data')` 攒 Buffer：两个包虽小，但"攒完再写"意味着
 * 内存占用由**对端**决定；流式落盘让内存恒定，超限时能立刻断开。
 */
export const downloadWithNode: Downloader = (url, target) => {
  return new Promise<DownloadResult>((resolve) => {
    const details: string[] = [];
    let currentUrl = url;

    const fail = (error: string, finalUrl = currentUrl, bytes = 0): void => {
      resolve({ ok: false, path: target, bytes, finalUrl, error });
    };

    const attempt = (hops: number): void => {
      const parsed = parseHttpUrl(currentUrl);
      if (!parsed.ok) {
        fail(parsed.error);
        return;
      }
      const options: RequestOptions = {
        headers: {
          // GitHub API 与 CDN 都要求一个 UA；没有它 api.github.com 会直接 403
          'user-agent': 'irmia-agent-deps/1.0',
          accept: 'application/octet-stream, application/json',
        },
      };

      const request = httpsGet(parsed.parts, options, (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && typeof location === 'string' && location !== '') {
          response.resume(); // 重定向响应体没有用，读完就丢，避免连接挂着
          if (hops >= MAX_REDIRECTS) {
            fail(`重定向超过 ${MAX_REDIRECTS} 跳（最后指向 ${location}）`);
            return;
          }
          details.push(`重定向 ${status} → ${location}`);
          currentUrl = new URL(location, currentUrl).toString();
          attempt(hops + 1);
          return;
        }
        if (status !== 200) {
          response.resume();
          fail(`HTTP ${status}（${currentUrl}）`);
          return;
        }

        const declared = Number.parseInt(String(response.headers['content-length'] ?? ''), 10);
        if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
          response.destroy();
          fail(`声明的体积 ${declared} 字节超过上限 ${MAX_DOWNLOAD_BYTES}`, currentUrl, 0);
          return;
        }

        void (async (): Promise<void> => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          try {
            await mkdir(dirname(target), { recursive: true });
            // 逐个 chunk 累积到临时数组再一次性写：两个包都在 MB 级，分块写的收益抵不上
            // 一次 writeFile 的原子性；上限由 MAX_DOWNLOAD_BYTES 兜住，内存有界
            for await (const chunk of response) {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
              bytes += buf.byteLength;
              if (bytes > MAX_DOWNLOAD_BYTES) {
                response.destroy();
                fail(`下载体积超过上限 ${MAX_DOWNLOAD_BYTES} 字节`, currentUrl, bytes);
                return;
              }
              chunks.push(buf);
            }
            await writeFile(target, Buffer.concat(chunks, bytes));
            resolve({ ok: true, path: target, bytes, finalUrl: currentUrl, error: '' });
          } catch (err) {
            fail(`写盘失败：${err instanceof Error ? err.message : String(err)}`, currentUrl, bytes);
          }
        })();
      });

      request.on('error', (err: Error) => {
        fail(`网络错误：${err.message}`);
      });
      // 总时限：官方源正常在秒级；卡住不动的连接必须自己断，否则安装命令会一直挂着
      request.setTimeout(120_000, () => {
        request.destroy(new Error('下载超时（120s）'));
      });
    };

    attempt(0);
  });
};

// ──────────────────────────────── zip 解析 ────────────────────────────────

export interface ZipEntry {
  /** zip 内的路径（用 '/' 分隔） */
  name: string;
  /** 解压后的字节 */
  data: Buffer;
}

export interface ZipReadResult {
  ok: boolean;
  entries: ZipEntry[];
  error: string;
}

/** 只收这两种压缩方式：store（0）与 deflate（8）。zip 的其它方式我们不解，遇到就跳过 */
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

function findEocd(buf: Buffer): number {
  const start = Math.max(0, buf.length - MAX_COMMENT_BYTES - 22);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/**
 * 读一个 zip（内存版）。刻意**不支持的**特性一律跳过而不是报错：
 * 目录项、加密项、zip64、我们不认识的压缩方式——跳过它们的后果是"少几个文件"，
 * 而报错的后果是"整包装不上"。我们只关心包里的那一个 .exe。
 */
export function readZipEntries(buf: Buffer): ZipReadResult {
  const eocd = findEocd(buf);
  if (eocd < 0) return { ok: false, entries: [], error: '不是 zip（找不到目录结尾记录）' };

  const count = buf.readUInt16LE(eocd + 10);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (centralOffset >= buf.length) {
    return { ok: false, entries: [], error: 'zip 目录偏移越界（文件可能被截断）' };
  }

  const entries: ZipEntry[] = [];
  let totalBytes = 0;
  let cursor = centralOffset;

  for (let index = 0; index < count; index++) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      return { ok: false, entries: [], error: `zip 目录第 ${index + 1} 项无法解析（文件可能损坏）` };
    }
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    // 成员名的字节没有"一定是 UTF-8"这回事：ZIP 规范在通用位 bit 11 置位时才是 UTF-8，
    // 否则是"本地 ANSI 代码页"——中文 Windows 上就是 GBK（cp936）。原来硬按 UTF-8 读，
    // 一个中文名的成员会变成替换字符，随后"找得到的文件"与"解出来的名字"对不上。
    // 走共享判定链：ASCII/UTF-8 名字结果逐字不变，GBK 名字被正确还原。
    const name = decodeText(buf.subarray(cursor + 46, cursor + 46 + nameLength)).text;

    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue; // 目录项
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) continue; // 不认识的压缩方式
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      return { ok: false, entries: [], error: `zip 成员 ${name} 的本地头无效` };
    }

    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) {
      return { ok: false, entries: [], error: `zip 成员 ${name} 的数据越界（文件可能被截断）` };
    }
    const raw = buf.subarray(dataStart, dataEnd);

    let data: Buffer;
    try {
      data = method === METHOD_STORE ? Buffer.from(raw) : inflateRawSync(raw);
    } catch (err) {
      return {
        ok: false,
        entries: [],
        error: `zip 成员 ${name} 解压失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }

    totalBytes += data.byteLength;
    if (totalBytes > MAX_EXTRACT_BYTES) {
      return { ok: false, entries: [], error: `解压总量超过上限 ${MAX_EXTRACT_BYTES} 字节（疑似解压炸弹）` };
    }
    entries.push({ name, data });
  }

  if (entries.length === 0) return { ok: false, entries: [], error: 'zip 里没有可解压的文件' };
  return { ok: true, entries, error: '' };
}

// ──────────────────────────────── 解压落盘 ────────────────────────────────

/** 单层公共前缀：`ripgrep-15.1.0-x86_64-pc-windows-msvc/rg.exe` → `rg.exe` */
export function stripSingleTopDir(entries: readonly ZipEntry[]): ZipEntry[] {
  if (entries.length === 0) return [];
  const firstSlash = entries[0]!.name.indexOf('/');
  if (firstSlash <= 0) return [...entries];
  const prefix = entries[0]!.name.slice(0, firstSlash + 1);
  const allNested = entries.every((entry) => entry.name.startsWith(prefix) && entry.name.length > prefix.length);
  if (!allNested) return [...entries];
  return entries.map((entry) => ({ name: entry.name.slice(prefix.length), data: entry.data }));
}

/**
 * zip 成员名 → 落在 `root` 里的绝对路径；**越界返回 null**。
 *
 * 这是 **zip-slip 的唯一判据**（`../`、绝对路径、盘符一律拒绝）。做成一个函数而不是在两处
 * 各写一遍：解压器（本文件）与 pip 的 wheel 铺开（`pip.ts`）面对的是同一类外部输入，
 * 两份判据迟早会长成两种口径，而"哪一处漏了"正是这类漏洞最常见的形态（P1-22）。
 */
export function zipEntryPath(root: string, name: string): string | null {
  const target = resolve(root, name);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || /^[A-Za-z]:/u.test(rel)) return null;
  return target;
}

/**
 * 重装时**必须原地保住**的相对子树。
 *
 * 为什么要有这一格（P1-19，2026-10-18）：这一族安装是"下载 → **清空目标目录** → 解压 → 复检"，
 * 而托管 Python 的 `Lib\site-packages` 里装的是**她后来 `pip install` 的东西**——不在我们任何一个
 * 包里。清空目录等于替她把那些装过的包静默卸掉，而回执里一个字都不提。
 * 所以重装时先把这些子树**挪到一边**（同一卷的 rename，不复制），装完再迁回来：
 *   · 新包没带同名的目录 ⇒ 整个原封搬回（常用情形，零复制）；
 *   · 新包自带同名目录 ⇒ 逐个补缺，**新包写下的文件优先**（不拿旧字节盖新包）。
 * 其余文件照旧清空——留一半旧文件会让"复检"认出一个上一次装坏的 exe，那条纪律没变。
 */
export const PRESERVED_ON_REINSTALL: readonly string[] = ['Lib/site-packages'];

/** 重装时保住并迁回的一棵子树（回执里如实列它：多少文件、多少字节） */
export interface PreservedTree {
  /** 相对安装根的路径（`/` 分隔，跨平台同一个写法） */
  path: string;
  files: number;
  bytes: number;
}

export interface ExtractZipOutcome {
  ok: boolean;
  written: number;
  error: string;
  /** 重装时保住并迁回的子树（空 = 这一次没有可保的，不是"保了 0 个"） */
  preserved: PreservedTree[];
  /** 迁回过程中出的事（没迁回来的子树在哪）——安装本身可能还是成功的，但这句话必须带出去 */
  notes: string[];
}

/** 递归列出目录下的普通文件（`rel` 用 `/` 拼，便于与 zip 成员名对齐）；符号链接不跟（它可能指向任何地方） */
async function listTreeFiles(root: string, prefix = ''): Promise<Array<{ rel: string; size: number }>> {
  const out: Array<{ rel: string; size: number }> = [];
  const names = (await readdir(join(root, prefix), { withFileTypes: true }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of names) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...await listTreeFiles(root, rel));
      continue;
    }
    if (!entry.isFile()) continue;
    out.push({ rel, size: (await stat(join(root, rel))).size });
  }
  return out;
}

/**
 * 解压到目标目录。**路径穿越防护**：zip 里的名字是外部输入，`../` 与绝对路径一律拒绝
 * （判据就是 {@link zipEntryPath}，pip 那条路用的是同一个）。
 * 目标目录先清空——留一半旧文件会让"复检"认出一个上一次装坏的 exe；
 * 唯一的例外是 `options.preserve` 列出的子树（理由见 {@link PRESERVED_ON_REINSTALL}）。
 */
export async function extractZipToDirectory(
  entries: readonly ZipEntry[],
  targetDir: string,
  options: { preserve?: readonly string[] | undefined } = {},
): Promise<ExtractZipOutcome> {
  const stripped = stripSingleTopDir(entries);
  const root = resolve(targetDir);
  /** 已挪出目标目录、等着迁回的子树；`backup` 与 root 同卷（都是 <dataDir>/tools 下）⇒ rename 不会跨盘 */
  const parked: Array<{ backup: string; path: string; files: number; bytes: number }> = [];
  const preserved: PreservedTree[] = [];
  const notes: string[] = [];
  let written = 0;

  /**
   * 迁回：成功与失败都要走一次——**挪出去了就必须搬回来**。
   * 失败路径上搬不回来时，把暂存路径写进 notes（宁可让人去手工捡，也不许假装没这回事）。
   */
  const restoreParked = async (): Promise<void> => {
    for (const item of parked.splice(0)) {
      const live = join(root, item.path);
      try {
        if (!existsSync(live)) {
          await mkdir(dirname(live), { recursive: true });
          await rename(item.backup, live);
          preserved.push({ path: item.path, files: item.files, bytes: item.bytes });
          continue;
        }
        // 新包自带同名目录：只补缺，不覆盖新包写下的文件
        let files = 0;
        let bytes = 0;
        for (const file of await listTreeFiles(item.backup)) {
          const dest = join(live, file.rel);
          if (existsSync(dest)) continue;
          await mkdir(dirname(dest), { recursive: true });
          await copyFile(join(item.backup, file.rel), dest);
          files += 1;
          bytes += file.size;
        }
        await rm(item.backup, { recursive: true, force: true });
        if (files === 0) {
          // 旧目录里的每一个文件都被新包覆盖了 ⇒ 没有"她的东西"被保住，就别在回执里认领这件事
          notes.push(`新包自带了 ${item.path}，旧的那份没有一个文件需要补（都被新包的覆盖了）`);
        } else {
          preserved.push({ path: item.path, files, bytes });
        }
      } catch (err) {
        notes.push(`重装前的 ${item.path} 暂存在 ${item.backup} 没能迁回（${err instanceof Error ? err.message : String(err)}），`
          + '那些文件没删，可以手工搬回去');
      }
    }
  };

  try {
    for (const rel of options.preserve ?? []) {
      const live = resolve(root, rel);
      const inside = relative(root, live);
      // 配置（未来可能来自别处）写错了也不许把根外面的东西挪走
      if (inside === '' || inside.startsWith('..') || /^[A-Za-z]:/u.test(inside)) continue;
      if (!existsSync(live)) continue;
      const backup = join(dirname(root), `.reinstall-${basename(root)}-${parked.length}-${Date.now()}`);
      await rename(live, backup);
      const files = await listTreeFiles(backup);
      parked.push({
        backup,
        path: inside.replaceAll('\\', '/'),
        files: files.length,
        bytes: files.reduce((sum, file) => sum + file.size, 0),
      });
    }

    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    let failure = '';
    for (const entry of stripped) {
      if (entry.name === '') continue;
      const target = zipEntryPath(root, entry.name);
      if (target === null) {
        failure = `zip 成员路径越界：${entry.name}`;
        break;
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, entry.data);
      written += 1;
    }
    await restoreParked();
    if (failure !== '') {
      return { ok: false, written, error: failure, preserved, notes };
    }
    return { ok: true, written, error: '', preserved, notes };
  } catch (err) {
    await restoreParked();
    return {
      ok: false,
      written: 0,
      error: err instanceof Error ? err.message : String(err),
      preserved,
      notes,
    };
  }
}

// ──────────────────────────────── 安装编排 ────────────────────────────────

/**
 * "重装保住了什么"那句回执（**唯一措辞处**，成功与失败的详情共用）。
 * 空数组 = 这一次没有可保的（第一次装 / 从没 pip install 过）——那时一个字都不说，
 * 而不是写一句"保留 0 个文件"制造"有东西被保住"的错觉。
 */
function preservedLines(preserved: readonly PreservedTree[]): string[] {
  return preserved.map((tree) => `重装保留了 ${tree.path}（${tree.files} 个文件、${tree.bytes} 字节）：`
    + '她自己装过的包还在——旧安装的其余文件已按新包替换');
}

/** 一个可一键安装的依赖的包描述（探测定义里的 install:'zip' 那部分在这里落地） */
export interface ZipPackage {
  name: DepName;
  /** 包地址；`resolveUrl` 给定时它作为兜底（解析失败就用它） */
  url: string;
  /** 需要联网解析最终地址时用它（ripgrep 走 GitHub API 拿最新 release 的资产） */
  resolveUrl?: (() => Promise<{ ok: true; url: string; version: string } | { ok: false; error: string }>) | undefined;
  /** 期望解压出来的可执行文件名（装完复检找的就是它） */
  exeNames: readonly string[];
  /**
   * "人手动放的离线包"该放在哪。省略时 = `<dataDir>/tools/.cache/<name>.zip`
   * （也就是下载器自己的落点，界面上告诉用户的就是这个路径）。
   * 单列一格的唯一理由：让测试指到临时目录，不去碰真的缓存目录。
   */
  offlineArchive?: string | undefined;
  /**
   * 解压之后的**收尾步骤**（可选）。给它的理由：Python 那一件在"解压完"与"能跑"之间
   * 还有一步独有的活——引导 pip（改 `_pth` + 铺 wheel，见 src/deps/pip.ts）。
   * 把那一整段塞进这份通用编排里会把"下载 → 解压 → 复检"染上 Python 的细节；
   * 做成一个钩子，通用编排只负责"在正确的时机调它、并把结论如实带出去"。
   *
   * 约定：**它失败不推翻整次安装**（python 没有 pip 也还是 python），
   * 但结论必须出现在 details 与 `auxiliaryOk` 上——静默的失败等于撒谎。
   */
  postExtract?:
    | ((input: { dir: string; exePath: string; cacheDir: string }) => Promise<{
      ok: boolean;
      version: string;
      reason: string;
      details: string[];
    }>)
    | undefined;
}

/**
 * 解析 ripgrep 最新 release 里的 Windows 资产地址。
 * 为什么不写死版本号：写死的那一刻就开始过期，而这个依赖是**要求安装**的
 * （过期意味着新用户装不上）。GitHub API 匿名可用（限流 60/小时，装一次用一次，绰绰有余）。
 */
export async function resolveRipgrepAsset(
  fetchJson: (url: string) => Promise<string>,
): Promise<{ ok: true; url: string; version: string } | { ok: false; error: string }> {
  let text: string;
  try {
    text = await fetchJson(RIPGREP_RELEASE_API);
  } catch (err) {
    return { ok: false, error: `查询 ripgrep 最新版本失败：${err instanceof Error ? err.message : String(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'ripgrep 版本查询返回的不是 JSON（可能被网络中间层拦截）' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'ripgrep 版本查询返回了意外结构' };
  }
  const record = parsed as Record<string, unknown>;
  const tag = typeof record['tag_name'] === 'string' ? record['tag_name'] : '';
  const assets = Array.isArray(record['assets']) ? record['assets'] : [];
  for (const asset of assets) {
    if (typeof asset !== 'object' || asset === null) continue;
    const item = asset as Record<string, unknown>;
    const name = typeof item['name'] === 'string' ? item['name'] : '';
    const url = typeof item['browser_download_url'] === 'string' ? item['browser_download_url'] : '';
    if (name.endsWith(RIPGREP_ASSET_MARKER) && url !== '') {
      return { ok: true, url, version: tag.replace(/^v/u, '') };
    }
  }
  return { ok: false, error: `ripgrep 最新 release（${tag || '未知'}）里没有 ${RIPGREP_ASSET_MARKER}` };
}

/**
 * 选一个"最新的稳定版"python 出来。**返回 null = 这次挑不出来**（调用方退回钉住的地址），
 * 不是错误——API 不通、被中间层拦、结构变了，这三件事都不该让安装失败。
 *
 * 两道过滤都是必要的：
 *   · `pre_release === false` —— 排除 rc/beta（它们照样在列表里，`3.15.0rc1` 实测就在）；
 *   · 名字**严格**是 `Python <主>.<次>.<修订>` —— 排除 `Python 3.15.0a1` 这种开发版，
 *     也排除 `Python 3.0.0` 之类历史噪声（它们过不了下面的版本序）。
 * 版本序用手写比较而不是字符串排序：字符串会把 `3.9.0` 排在 `3.15.0` 后面。
 */
export function pickLatestPythonRelease(
  text: string,
): { ok: true; version: string; url: string } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'python.org 版本查询返回的不是 JSON（可能被网络中间层拦截）' };
  }
  // 实测是个裸数组；但换个端点就可能包一层 —— 两种都认，多认一种不会错
  const list = Array.isArray(parsed)
    ? parsed
    : (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>)['objects'])
      ? (parsed as Record<string, unknown>)['objects'] as unknown[]
      : null);
  if (list === null) return { ok: false, error: 'python.org 版本查询返回了意外结构' };

  const stable: number[][] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record['pre_release'] === true) continue;
    const name = typeof record['name'] === 'string' ? record['name'] : '';
    const matched = /^Python (\d+)\.(\d+)\.(\d+)$/u.exec(name);
    if (matched === null) continue;
    stable.push([Number(matched[1]), Number(matched[2]), Number(matched[3])]);
  }
  if (stable.length === 0) return { ok: false, error: 'python.org 的发布列表里没有可用的稳定版 3.x' };

  stable.sort((a, b) => (b[0]! - a[0]!) || (b[1]! - a[1]!) || (b[2]! - a[2]!));
  const best = stable[0]!;
  const version = best.join('.');
  return { ok: true, version, url: `${PYTHON_FTP_PREFIX}${version}/python-${version}${PYTHON_EMBED_ASSET_MARKER}` };
}

/**
 * 解析 python 最新稳定版的 embeddable 包地址。
 *
 * **与 `resolveRipgrepAsset` 的一处刻意不同**：这里拿不到"资产列表"，只能**按版本号拼地址**
 * ——python.org 的 API 只回发布元数据，不回文件清单。所以"拼出来的地址真的存在吗"这一步
 * 留给了下载本身：拼错了就是一次 HTTP 404，而那正是 `step:'download'` 会如实报出来的东西
 * （界面显示"下载失败：HTTP 404"，用户点「下载页」自己装，不会静默）。
 */
export async function resolvePythonEmbedUrl(
  fetchJson: (url: string) => Promise<string>,
): Promise<{ ok: true; url: string; version: string } | { ok: false; error: string }> {
  let text: string;
  try {
    text = await fetchJson(PYTHON_RELEASE_API);
  } catch (err) {
    return { ok: false, error: `查询 python 最新版本失败：${err instanceof Error ? err.message : String(err)}` };
  }
  const picked = pickLatestPythonRelease(text);
  if (!picked.ok) return picked;
  return { ok: true, url: picked.url, version: picked.version };
}

export interface InstallDependencyInput {
  name: DepName;
  /** 包描述 */
  pkg: ZipPackage;
  /** 数据目录：安装落点是 `<dataDir>/tools/<name>/` */
  dataDir: string;
  download: Downloader;
  /** 复检：装完之后用真正的探测再看一遍（返回 null = 还是找不到） */
  verify: (exePath: string) => Promise<{ version: string } | null>;
  /** 解析文本型 URL 的注入点（GitHub API 那条路）；省略时只有一个 zip 源 */
  fetchText?: ((url: string) => Promise<string>) | undefined;
  timeoutMs?: number | undefined;
}

/** 安装目录：三处（探测 / 安装 / 复检）共用这一个约定 */
export function managedDirFor(dataDir: string, name: DepName): string {
  return join(dataDir, TOOLS_DIR_NAME, name);
}

/** 下载缓存目录：失败留下的半截文件在这里，人能自己看一眼 */
export function cacheDirFor(dataDir: string): string {
  return join(dataDir, TOOLS_DIR_NAME, CACHE_DIR_NAME);
}

/**
 * 一键安装：下载 → 解压 → **复检** → 写清单。
 *
 * 复检这一步是刻意的设计（不是可选的收尾）：解压成功不等于能跑——杀毒软件会隔离
 * 刚落地的 exe、x86/x64 装错、包结构变了导致文件不在预期位置，这些都在"解压成功"之后才暴露。
 * 装完不验就报"已安装"，用户会在下一次搜索时才发现没生效，而那时他早就忘了自己装过。
 *
 * **下载失败时可以退到"人手动放的离线包"**（见 ②⁰ / ②′）：把官方包放在
 * `<dataDir>/tools/.cache/<name>.zip`，再点一次「安装」就不再联网。两条纪律：
 * 暂存发生在下载**之前**（否则失败的下载会把用户那个文件截断），暂存件装完就删
 * （留着会让下一次失败静默退回旧包）。用户自己那份不删。
 */
export async function installZipDependency(input: InstallDependencyInput): Promise<DepInstallOutcome> {
  const details: string[] = [];
  const targetDir = managedDirFor(input.dataDir, input.name);

  // ① 定地址：能解析就解析（拿到最新版本），不能就用固定地址
  let url = input.pkg.url;
  let resolvedVersion = '';
  if (input.pkg.resolveUrl !== undefined) {
    const resolved = await input.pkg.resolveUrl();
    if (resolved.ok) {
      url = resolved.url;
      resolvedVersion = resolved.version;
      details.push(`解析到最新版本 ${resolved.version}：${url}`);
    } else {
      details.push(`解析最新版本失败，退回固定地址：${resolved.error}`);
    }
  }

  // ② 下载
  const archive = join(cacheDirFor(input.dataDir), `${input.name}.zip`);
  await mkdir(dirname(archive), { recursive: true });

  /**
   * ②⁰ **先把人手动放的离线包挪到一边**（在下载之前！）。
   *
   * 顺序是这条回退的关键：下载器把响应**流式写盘**，所以一次失败的下载会把
   * 同一个路径上的包**截断/覆盖**掉——先下载再找离线包，找到的是自己刚写坏的那半截。
   * 两道保险，缺一不可：
   *   · **下载写的是 `.part` 临时名**，成功了才改名到 `archive`（于是 `archive` 这个
   *     "用户也会放包的位置"在下载失败时**根本不会被碰**）；
   *   · 下载之前把已有的包复制到 `stagedArchive`（下载器不会碰的名字），用它当回退源。
   *
   * 这两条都是被用例逼出来的：第一版直接下载到 `archive`，用例里那个"先截断再报错"的
   * 假下载器当场把用户放的包变成 0 字节（而真实下载器就是流式写的，行为一样）。
   */
  const offlineArchive = input.pkg.offlineArchive ?? archive;
  const stagedArchive = join(cacheDirFor(input.dataDir), `${input.name}.offline.zip`);
  const downloadPath = `${archive}.part`;
  let staged = false;
  if (existsSync(offlineArchive)) {
    try {
      await copyFile(offlineArchive, stagedArchive);
      staged = true;
    } catch {
      staged = false; // 复制不了就当没放（下面会如实报"下载失败"）
    }
  }

  const downloaded = await input.download(url, downloadPath);
  // 只有下载**真的成功**才把临时名转正：失败时 `archive` 上那份（用户放的）原封不动
  let archivePath = downloaded.path;
  if (downloaded.ok) {
    try {
      await rename(downloadPath, archive);
      archivePath = archive;
    } catch (err) {
      // 改名失败不该把一次成功的下载变成失败：退回用那个 `.part` 文件（下面照样能解压）
      details.push(`下载临时文件改名失败（改用临时文件继续）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * ②′ **下载失败时改用手动放的离线包**（用户 2026-10-16 点名要的那条回退）。
   *
   * 为什么必须有这条路：这台机器上那个 7897 是死的（隧道建不起来），别的机器上
   * 还有代理、防火墙、公司镜像这些更常见的东西。一条"必须联网才能装上"的依赖，
   * 在一台连不出去的机器上就是**永远装不上**——而人手里其实有一个浏览器。
   *
   * 三条纪律：
   *   · **不假装联网成功**：details 里第一行就是下载失败的原因，用的是本地包这件事写清楚；
   *   · **失败态不消失**：文件不存在/不是 zip/复检不过时，报的仍然是各自的真实阶段；
   *   · **一次性**：这一次装完（成功或复检失败）都把暂存件删掉——留着它会让下一次失败
   *     静默退回旧包，而"我以为下的是新版，其实用的是上次那个"是最难查的一类故障。
   *     用户自己那份**不删**：那是他的文件，我们没资格动。
   */
  const offline: string[] = [];
  /** 这一次用的是不是"人手动放的离线包"（清单里要如实记，不许拿下载地址假装） */
  let useOffline = false;
  if (!downloaded.ok) {
    offline.push(`下载失败：${downloaded.error}`);
    if (staged || existsSync(stagedArchive)) {
      archivePath = stagedArchive;
      useOffline = true;
      offline.push(`改用你手动放的离线包：${offlineArchive}`);
    } else {
      return {
        ok: false,
        step: 'download',
        name: input.name,
        error: `下载失败：${downloaded.error}。检查网络后重试；若是来源地址变了，点「打开下载页」手动安装。`
          + `也可以手动下载官方包放到 ${offlineArchive} 再点一次「安装」（那时不再联网；`
          + '你放的包我们只读不删，下载成功的那一次才会覆盖这个位置）。',
        details: [
          ...details,
          ...offline,
          `下载地址：${url}`,
          `离线包该放的位置：${offlineArchive}`,
        ],
      };
    }
  } else {
    details.push(`已下载 ${downloaded.bytes} 字节（最终地址 ${downloaded.finalUrl}）`);
  }

  /**
   * 把"下载失败 / 用的是离线包"这两行**并进 details**（而不是只在失败返回里展开）。
   *
   * 为什么必须在这里并：走到成功返回时，失败返回那条路上的 `...offline` 根本不会执行——
   * 第一版就是这么写的，结果"下载失败：ECONNREFUSED"这句话**在最终回执里整段消失**，
   * 只剩"已解压 1 个文件"。用户看到的是"装好了"，而真相是"网没通、用的是他手动放的包"。
   * 并进来之后，下面每一条返回路径（成功、解压失败、复检失败）都自带这句话。
   */
  details.push(...offline);

  /**
   * 清理：**只删临时件**，用户放的离线包一律不动。
   *
   * 这条是被用例抓出来的第二个版本。第一版写了"暂存件与下载缓存都删"，而下载缓存
   * `<cache>/<name>.zip` **恰好就是界面告诉用户放离线包的那个路径**——于是"离线装成功"
   * 会顺手把用户那个 11MB 的包删掉（实测复现：装完 `.cache/` 是空的）。
   * 他下次在另一台机器、或下一次网络又抽风时，手里那个包已经没了，而他从头到尾
   * 没被告知"我们把它删了"。
   *
   * 于是规矩改成：**用户放的位置，我们只读不写不删**。
   *   · `stagedArchive`（我们自己复制的 `<name>.offline.zip`）——用完就删；
   *   · `downloadPath`（`<name>.zip.part`，下载器的临时落点）——有就删（半截文件留着没用）；
   *   · `archive`（= 离线包位置）——**只有这一次真的下载成功才删**；没下载成功时，
   *     那个文件只可能是用户放的，留着。
   */
  const cleanArchives = async (): Promise<void> => {
    const files = downloaded.ok ? [archive, stagedArchive, downloadPath] : [stagedArchive, downloadPath];
    for (const file of files) {
      try {
        await rm(file, { force: true });
      } catch {
        /* 删不掉就留着，不是错误 */
      }
    }
  };

  // ③ 解压
  let archiveBytes: Buffer;
  try {
    archiveBytes = await readFile(archivePath);
  } catch (err) {
    await cleanArchives();
    return {
      ok: false,
      step: 'extract',
      name: input.name,
      error: `解压失败：读不到刚下载的包（${err instanceof Error ? err.message : String(err)}）`,
      details: [...details, ...offline, `包路径：${archivePath}`],
    };
  }
  const zip = readZipEntries(archiveBytes);
  if (!zip.ok) {
    await cleanArchives();
    return {
      ok: false,
      step: 'extract',
      name: input.name,
      error: `解压失败：${zip.error}。这通常意味着下载到的不是 zip（代理拦截、镜像换包）——`
        + '请重试，或点「打开下载页」手动安装。',
      details: [...details, ...offline, `包大小 ${archiveBytes.byteLength} 字节`, `包路径：${archivePath}`],
    };
  }
  const extracted = await extractZipToDirectory(zip.entries, targetDir, { preserve: PRESERVED_ON_REINSTALL });
  if (!extracted.ok) {
    await cleanArchives();
    return {
      ok: false,
      step: 'extract',
      name: input.name,
      error: `解压失败：${extracted.error}`,
      details: [
        ...details,
        ...offline,
        `目标目录：${targetDir}`,
        ...preservedLines(extracted.preserved),
        ...extracted.notes,
      ],
    };
  }
  details.push(`已解压 ${extracted.written} 个文件到 ${targetDir}`);
  // **回执里明说保留了什么**（P1-19）：她的 pip 包装在 `Lib\site-packages` 里，不在我们任何
  // 一个包里。重装时保住它却不说，等于让人下一次发现"我装过的包怎么没了"时无从对账。
  details.push(...preservedLines(extracted.preserved));
  details.push(...extracted.notes);

  // ④ 复检：**这一条不能省**（理由见函数头）。
  //
  // 定位用 `findExecutableInDir`——与日常探测**同一个实现**（probe.ts）。
  // 两处各写一套的后果实测过一次：voidtools 的 CLI 包里 es.exe 在 `x64/` 子目录下，
  // 只查根目录的话"装完成了但复检说找不到"，而文件明明躺在那儿。
  const exePath = findExecutableInDir(input.pkg.exeNames, targetDir, existsSync, defaultDepFs.listDir);
  let version = '';
  if (exePath !== null) {
    const verified = await input.verify(exePath);
    if (verified !== null) version = verified.version;
    else details.push(`${exePath} 存在但探测不通过（版本不符或无法启动）`);
  }
  if (exePath === null || version === '') {
    await cleanArchives();
    return {
      ok: false,
      step: 'verify',
      name: input.name,
      error: `安装完成但复检仍找不到可用的 ${input.pkg.exeNames.join(' / ')}：`
        + `文件已解压到 ${targetDir}，请检查杀毒软件是否隔离了它，或手动确认该目录下的文件名。`,
      details: [
        ...details,
        ...offline,
        `期望的可执行文件：${input.pkg.exeNames.join(' / ')}（含一层子目录）`,
      ],
    };
  }

  // ④′ 收尾步骤（只有声明了 `postExtract` 的包才有，如 python 的 pip 引导）。
  // **跑在复检之后**：先确认"解释器真的能跑"，再去让它装自己的东西——
  // 反过来的话，一个起不来的 exe 会先在收尾步骤里报一堆看不懂的错。
  // 它失败**不推翻安装**（理由见 ZipPackage.postExtract 的注释），但必须落在 details 上。
  let auxiliaryVersion: string | undefined;
  let auxiliaryOk: boolean | undefined;
  if (input.pkg.postExtract !== undefined) {
    const result = await input.pkg.postExtract({
      dir: targetDir,
      exePath,
      cacheDir: cacheDirFor(input.dataDir),
    });
    auxiliaryOk = result.ok;
    if (result.ok) auxiliaryVersion = result.version;
    else details.push(`收尾步骤未完成（${result.reason}）`);
    details.push(...result.details);
  }

  // ⑤ 清单（人可读：装了什么、从哪来、什么时候）
  //
  // 走离线包时 `finalUrl` / `bytes` 是空的：没什么可填的——**不许拿下载地址假装**。
  // 一份"从 https://... 下了 11MB"的清单而实际上是从本地文件装的，比空着坏得多。
  const manifest = {
    name: input.name,
    version: version === '' ? resolvedVersion : version,
    sourceUrl: useOffline ? offlineArchive : url,
    finalUrl: downloaded.finalUrl,
    bytes: downloaded.bytes,
    installedAt: new Date().toISOString(),
    exePath,
    // 收尾步骤的结论（python 的 pip 版本）也进清单：GUI 与 `readManifest` 都读它，
    // 于是"这个 python 带不带 pip"是一份可查的事实，而不是只能现场跑一遍才知道
    ...(auxiliaryVersion === undefined ? {} : { auxiliaryVersion }),
    ...(auxiliaryOk === undefined ? {} : { auxiliaryOk }),
  };
  try {
    await writeFile(join(targetDir, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } catch (err) {
    // 清单写不下去不影响使用（探测看的是 exe 本身），但要说出来
    details.push(`清单写入失败（不影响使用）：${err instanceof Error ? err.message : String(err)}`);
  }

  // 顺手清掉下载缓存与离线暂存件：包本身没用了，留着只会占地方
  // （用户自己放在 `.cache/<name>.zip` 的那份**不动**——那是他的文件）
  await cleanArchives();

  details.push(`复检通过：${exePath}（版本 ${version}）`);
  return {
    ok: true,
    step: 'done',
    name: input.name,
    dir: targetDir,
    exePath,
    version,
    sourceUrl: useOffline ? offlineArchive : url,
    bytes: downloaded.bytes,
    ...(auxiliaryVersion === undefined ? {} : { auxiliaryVersion }),
    ...(auxiliaryOk === undefined ? {} : { auxiliaryOk }),
    details,
  };
}

/** 读清单（自装目录里装的是什么版本）；没有清单返回 null */
export async function readManifest(
  dataDir: string,
  name: DepName,
): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(join(managedDirFor(dataDir, name), MANIFEST_FILE_NAME), 'utf8');
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
