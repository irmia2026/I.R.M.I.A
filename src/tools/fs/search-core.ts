/**
 * Irmia Agent — 文件系工具包：递归扫描与匹配内核
 *
 * rg_search / es_search 在没有外部引擎时需要同一条 TS fallback 路径，
 * `safe_read` 列目录时也需要单层目录枚举。三处共用本模块，保证：
 *   • 忽略集合唯一（`.git` `node_modules` `dist` 等只在常量里写一次）；
 *   • 深度、文件数、单文件字节三个上限统一，避免 fallback 比引擎路径更容易失控；
 *   • AbortSignal 在每个文件边界检查一次，长扫描能被超时打断（design.md §4.5）。
 */

import { opendir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { matchesGlob, globToRegExp } from './text-codec.ts';
import { FS_ERROR_CODES, toErrorMessage } from './types.ts';

/** 默认跳过的目录名。零依赖下不解析 .gitignore，用固定集合覆盖绝大多数噪声源 */
export const DEFAULT_SKIP_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  '.codegraph',
  '.versions',
  'dist',
  'build',
  'coverage',
  '.cache',
  '.next',
  'target',
  '__pycache__',
  '.venv',
  'venv',
];

export interface WalkEntry {
  /** 绝对路径 */
  path: string;
  /** 相对扫描根的路径，始终用 `/` 分隔，便于与 rg 输出对齐 */
  relPath: string;
  name: string;
  size: number;
  mtimeMs: number;
}

export interface WalkOptions {
  root: string;
  skipDirNames: ReadonlySet<string>;
  maxDepth: number;
  /** 最多访问多少个文件条目，防 fallback 在巨树上失控 */
  maxFiles: number;
  signal?: AbortSignal;
  /** 返回 false 表示提前停止遍历 */
  onFile: (entry: WalkEntry) => boolean | Promise<boolean>;
}

export interface WalkStats {
  filesSeen: number;
  dirsSeen: number;
  truncated: boolean;
  aborted: boolean;
}

export interface DirEntryInfo {
  name: string;
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mtimeMs: number;
}

function kindOf(entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): DirEntryInfo['kind'] {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  return 'other';
}

/** 单层目录枚举（`safe_read` 列目录用，经 `renderDirectoryListing`）。返回 null 表示该目录不可读 */
export async function readDirEntries(dir: string): Promise<DirEntryInfo[] | null> {
  const out: DirEntryInfo[] = [];
  try {
    const handle = await opendir(dir);
    for await (const entry of handle) {
      const full = join(dir, entry.name);
      let size = 0;
      let mtimeMs = 0;
      try {
        const info = await stat(full);
        size = info.size;
        mtimeMs = info.mtimeMs;
      } catch {
        // 断链的符号链接 / 权限不足：仍列出条目，但尺寸时间留空
      }
      out.push({ name: entry.name, path: full, kind: kindOf(entry), size, mtimeMs });
    }
  } catch {
    return null;
  }
  return out;
}

/**
 * 深度优先遍历文件。符号链接一律不跟进目录（防环），
 * 但符号链接指向的文件会被当作普通文件产出。
 */
export async function walkFiles(options: WalkOptions): Promise<WalkStats> {
  const stats: WalkStats = { filesSeen: 0, dirsSeen: 0, truncated: false, aborted: false };
  let stopped = false;

  async function recurse(dir: string, depth: number): Promise<void> {
    if (stopped) return;
    if (options.signal?.aborted === true) {
      stats.aborted = true;
      stopped = true;
      return;
    }
    if (depth > options.maxDepth) return;

    let entries;
    try {
      entries = await opendir(dir);
    } catch {
      return;
    }

    for await (const entry of entries) {
      if (stopped) return;
      if (stats.filesSeen >= options.maxFiles) {
        stats.truncated = true;
        stopped = true;
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (options.skipDirNames.has(entry.name)) continue;
        stats.dirsSeen += 1;
        await recurse(full, depth + 1);
        continue;
      }
      if (entry.isSymbolicLink()) {
        // 只收「指向文件」的链接；指向目录的链接是环的风险源，跳过
        let target;
        try {
          target = await stat(full);
        } catch {
          continue;
        }
        if (target.isDirectory()) continue;
      }
      stats.filesSeen += 1;
      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      const proceed = await options.onFile({
        path: full,
        relPath: relative(options.root, full).replaceAll('\\', '/'),
        name: entry.name,
        size: info.size,
        mtimeMs: info.mtimeMs,
      });
      if (!proceed) {
        stopped = true;
        return;
      }
    }
  }

  await recurse(options.root, 1);
  return stats;
}

// ──────────────────────────────── 匹配器 ────────────────────────────────

export interface MatcherOptions {
  ignoreCase?: boolean;
  fixedStrings?: boolean;
}

export type Matcher = (text: string) => { index: number; length: number } | null;

/** 构造单行匹配器。正则非法时返回错误说明，由调用方转成 INVALID_ARGS 回给模型 */
export function buildMatcher(pattern: string, options: MatcherOptions = {}): { matcher: Matcher } | { error: string } {
  if (pattern === '') return { error: 'pattern 不能为空' };
  if (options.fixedStrings === true) {
    const needle = options.ignoreCase === true ? pattern.toLowerCase() : pattern;
    return {
      matcher: (text: string) => {
        const hay = options.ignoreCase === true ? text.toLowerCase() : text;
        const index = hay.indexOf(needle);
        return index === -1 ? null : { index, length: needle.length };
      },
    };
  }
  const flags = options.ignoreCase === true ? 'iu' : 'u';
  try {
    const re = new RegExp(pattern, flags);
    return {
      matcher: (text: string) => {
        const hit = re.exec(text);
        return hit === null ? null : { index: hit.index, length: hit[0].length };
      },
    };
  } catch (err) {
    return { error: `正则表达式非法：${toErrorMessage(err)}` };
  }
}

/** 由选项构造跳过目录集合 */
export function buildSkipSet(custom: readonly string[] | undefined): Set<string> {
  const set = new Set<string>(DEFAULT_SKIP_DIRS);
  for (const name of custom ?? []) set.add(name);
  return set;
}

// ──────────────────────────────── glob 过滤 ────────────────────────────────

export interface GlobFilter {
  test(relPath: string, name: string): boolean;
  description: string;
}

/** glob 过滤只按「单个 pattern」实现（不引入逗号分隔的多模式语义，避免与 rg 行为分叉） */
export function buildGlobFilter(globs: readonly string[]): GlobFilter {
  if (globs.length === 0) {
    return { test: () => true, description: '*' };
  }
  const compiled = globs.map((glob) => ({
    source: glob,
    hasSlash: glob.includes('/'),
    re: globToRegExp(glob),
  }));
  return {
    test: (relPath, name) =>
      compiled.some((item) => matchesGlob(item.re, relPath, name, item.hasSlash)),
    description: globs.join(','),
  };
}

