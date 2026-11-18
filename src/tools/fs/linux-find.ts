import { lstat, opendir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

import { globToRegExp } from './text-codec.ts';

export const LINUX_FIND_SORT_KEYS = ['name', 'path', 'size', 'ext', 'date_created', 'date_modified', 'date_accessed'] as const;
type SortKey = (typeof LINUX_FIND_SORT_KEYS)[number];

const MAX_ENTRIES = 75_000;
const MAX_DEPTH = 64;
const SCAN_TIME_MS = 10_000;
const VIRTUAL_ROOTS = new Set(['/dev', '/proc', '/sys']);

export interface LinuxFindOptions {
  root: string;
  pattern: string;
  regex: boolean;
  ignoreCase: boolean;
  matchPath: boolean;
  wholeWord: boolean;
  ext: string;
  fileType: 'all' | 'file' | 'folder';
  sortBy: SortKey;
  maxResults: number;
  detail: boolean;
}

interface Hit {
  path: string;
  size: number | null;
  mtime: number | null;
  sortValue: string | number;
}

type ScanResult = { error: string; invalidPattern?: true } | {
  hits: Hit[];
  matched: number;
  partial: boolean;
};

function makePattern(options: LinuxFindOptions): RegExp {
  const pattern = options.pattern;
  const wildcard = !options.regex && /[*?]/u.test(pattern);
  // The file-name glob matches the whole name. Plain text and regular expressions can match substrings.
  const source = options.regex ? pattern : wildcard ? globToRegExp(pattern).source
    : pattern.replace(/[.*+?^$(){}|[\]\\]/gu, '\\$&');
  const expression = options.wholeWord
    ? '(?<![\\p{L}\\p{N}_])(?:' + source + ')(?![\\p{L}\\p{N}_])'
    : source;
  return new RegExp(expression, options.ignoreCase ? 'iu' : 'u');
}

function compare(a: Hit, b: Hit): number {
  if (a.sortValue !== b.sortValue) return a.sortValue < b.sortValue ? -1 : 1;
  return a.path < b.path ? -1 : a.path === b.path ? 0 : 1;
}

function keepHit(hits: Hit[], hit: Hit, limit: number): void {
  let lower = 0;
  let upper = hits.length;
  while (lower < upper) {
    const middle = (lower + upper) >>> 1;
    if (compare(hits[middle]!, hit) <= 0) lower = middle + 1;
    else upper = middle;
  }
  if (lower === limit) return;
  hits.splice(lower, 0, hit);
  if (hits.length > limit) hits.pop();
}

async function scan(options: LinuxFindOptions): Promise<ScanResult> {
  let matcher: RegExp;
  try { matcher = makePattern(options); }
  catch (error) { return { error: String(error), invalidPattern: true }; }
  const { root, sortBy, maxResults } = options;
  const hits: Hit[] = [];
  const until = Date.now() + SCAN_TIME_MS;
  const needsStat = options.detail || sortBy === 'size' || sortBy.startsWith('date_');
  const extension = options.ext.replace(/^\./u, '').toLowerCase();
  let matched = 0;
  let visited = 0;
  let partial = false;
  let stopped = false;

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) { partial = true; return; }
    try {
      const entries = await opendir(dir);
      for await (const entry of entries) {
        if (visited >= MAX_ENTRIES || Date.now() >= until) { partial = stopped = true; return; }
        visited++;
        const path = join(dir, entry.name);
        if (VIRTUAL_ROOTS.has(path)) continue;
        const folder = entry.isDirectory();
        const file = entry.isFile();
        const ext = extname(entry.name).slice(1).toLowerCase();
        if ((options.fileType === 'all' ? (folder || file || entry.isSymbolicLink())
          : options.fileType === 'folder' ? folder : file)
          && (options.regex || extension === '' || (file && ext === extension))
          && matcher.test(options.matchPath ? path : entry.name)) {
          matched++;
          if (maxResults > 0) {
            const info = needsStat ? await lstat(path).catch(() => null) : null;
            const size = file ? (info?.size ?? null) : null;
            const values = {
              name: options.ignoreCase ? entry.name.toLowerCase() : entry.name,
              path, ext, size: size ?? -1,
              date_created: info?.birthtimeMs ?? -1,
              date_modified: info?.mtimeMs ?? -1,
              date_accessed: info?.atimeMs ?? -1,
            };
            keepHit(hits, { path, size, mtime: info?.mtimeMs ?? null, sortValue: values[sortBy] }, maxResults);
          }
        }
        if (folder) await visit(path, depth + 1);
        if (stopped) return;
      }
    } catch (error) {
      if (depth === 0) throw error;
      partial = true;
    }
  }

  try { await visit(root, 0); }
  catch (error) { return { error: String(error) }; }
  return { hits, matched, partial };
}

if (!isMainThread && parentPort !== null && workerData?.linuxFind !== undefined) {
  parentPort.postMessage(await scan(workerData.linuxFind as LinuxFindOptions));
}

/** Use a short-lived worker so a pathological regex or glob cannot block the agent. */
export async function runLinuxFind(options: LinuxFindOptions, signal: AbortSignal): Promise<ScanResult> {
  signal.throwIfAborted();
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { linuxFind: options },
    resourceLimits: { maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 4 },
  });
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(SCAN_TIME_MS + 2_000)]);
  const abort = (): void => { void worker.terminate(); };
  deadline.addEventListener('abort', abort, { once: true });
  try {
    return await new Promise<ScanResult>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', () => reject(deadline.reason ?? new Error('文件名搜索提前退出')));
      if (deadline.aborted) abort();
    });
  } finally {
    deadline.removeEventListener('abort', abort);
    await worker.terminate();
  }
}
