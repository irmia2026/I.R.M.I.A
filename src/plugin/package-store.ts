import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AGENT_VERSION } from '../version.ts';
import { isPluginEngineCompatible, parsePluginManifest, type PluginManifest } from './manifest.ts';

export const PLUGIN_FILE_LIMITS = Object.freeze({ maxFiles: 256, maxFileBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 });

export interface PluginPackage {
  readonly rootDir: string;
  readonly contentHash: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly manifest: PluginManifest;
}

interface ScannedFile { absolute: string; relative: string; bytes: Buffer }

/** 只带 stat 的同一遍目录扫描结果：算哈希要字节，校验缓存只要它。 */
interface FileStat { absolute: string; relative: string; size: number; mtimeMs: number; ctimeMs: number }

/**
 * 文本排序一律按**码点**比较，不用 `localeCompare`。
 *
 * 为什么：ICU collation 的规则随 locale 与 Node/ICU 版本变化（`Z` 与 `a`，码点是 Z 在前，
 * en 排序是 a 在前）。整包哈希依赖文件顺序 ⇒ 换机器或换 Node 版本可能算出不同哈希 ⇒
 * 已信任的包被判 invalid。哈希的输入必须和运行环境无关。
 */
export function compareCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function pluginPackagesRoot(dataDir: string): string {
  return join(dataDir, 'plugins', 'packages');
}

/** 扫一遍目录：只 stat、不读内容，顺带把符号链接/非常规文件/体积上限判掉。 */
function collectStats(rootDir: string): FileStat[] {
  const root = realpathSync(rootDir);
  const files: FileStat[] = [];
  let totalBytes = 0;
  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareCodePoint(a.name, b.name));
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Plugin contains a symbolic link: ${absolute}`);
      if (stat.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Plugin contains a non-regular entry: ${absolute}`);
      if (stat.size > PLUGIN_FILE_LIMITS.maxFileBytes) throw new Error(`Plugin file size exceeds ${PLUGIN_FILE_LIMITS.maxFileBytes}: ${absolute}`);
      totalBytes += stat.size;
      if (totalBytes > PLUGIN_FILE_LIMITS.maxTotalBytes) throw new Error(`Plugin total size exceeds ${PLUGIN_FILE_LIMITS.maxTotalBytes}`);
      if (files.length >= PLUGIN_FILE_LIMITS.maxFiles) throw new Error(`Plugin file count exceeds ${PLUGIN_FILE_LIMITS.maxFiles}`);
      files.push({ absolute, relative: relative(root, absolute).split(sep).join('/'), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
    }
  }
  walk(root);
  return files;
}

function fingerprintOf(stats: readonly FileStat[]): string {
  const hash = createHash('sha256');
  for (const file of [...stats].sort((a, b) => compareCodePoint(a.relative, b.relative))) {
    // 折进 ctime：`utimes` 能把 mtime 还原成原值，ctime 由内核在内容/元数据每次变更时重写，
    // 用户态没有还原它的接口。于是「保留 size 与 mtime 改写内容」这种篡改在指纹上就会现形，
    // 而指纹仍然只 stat、不读一个字节。
    hash.update(`${file.relative}\0${file.size}\0${file.mtimeMs}\0${file.ctimeMs}\n`);
  }
  return hash.digest('hex');
}

/**
 * 整包缓存指纹：**只 stat，不读字节**。
 *
 * 用途是让 `list()` 判断「这包跟上次扫的是不是同一份」。隔离期的包每秒被问一次，
 * 真去读 8 MB 再算一遍 SHA256 就是白烧 IO；改任一文件的内容、大小或时间都会让指纹变。
 *
 * **它只是缓存失效判据，不是内容完整性凭据**：指纹由元数据算出来，而元数据不是内容的
 * 函数（同一份元数据对应得了两份不同的字节）。凡是「这个包的声明要变成运行面」的入口
 * （`PluginManager` 的确认/启停/隔离/装配）都必须用 `scanPluginPackage` 重算字节哈希。
 */
export function pluginPackageFingerprint(rootDir: string): string {
  return fingerprintOf(collectStats(rootDir));
}

function scanFiles(rootDir: string): ScannedFile[] {
  return collectStats(rootDir).map((file) => ({ absolute: file.absolute, relative: file.relative, bytes: readFileSync(file.absolute) }));
}

function hashFiles(files: readonly ScannedFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => compareCodePoint(a.relative, b.relative))) {
    hash.update(file.relative);
    hash.update('\0');
    hash.update(file.bytes);
  }
  return hash.digest('hex');
}

function scan(rootDir: string, expectedHash?: string): PluginPackage {
  const files = scanFiles(rootDir);
  const contentHash = hashFiles(files);
  if (expectedHash !== undefined && contentHash !== expectedHash) throw new Error(`Installed plugin contentHash mismatch: expected ${expectedHash}, got ${contentHash}`);
  const manifestPath = join(rootDir, 'plugin.json');
  const manifest = parsePluginManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), manifestPath);
  if (!isPluginEngineCompatible(manifest.engine.irmia, AGENT_VERSION)) {
    throw new Error(`Plugin ${manifest.id} requires Irmia ${manifest.engine.irmia}; current version is ${AGENT_VERSION}`);
  }
  return { rootDir, contentHash, fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes.length, 0), manifest };
}

export function scanPluginPackage(rootDir: string): PluginPackage {
  const root = realpathSync(rootDir);
  const expectedHash = /^[a-f0-9]{64}$/.test(basename(root)) ? basename(root) : undefined;
  return scan(root, expectedHash);
}

export function assertPluginSourceOutsideStore(source: string, destinationRoot: string): void {
  const relation = relative(destinationRoot, source);
  if (relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))) {
    throw new Error('Plugin source is inside the destination package store; refusing recursive installation');
  }
}

export function installPluginPackage(sourceDir: string, dataDir: string): PluginPackage {
  const source = realpathSync(sourceDir);
  const destinationRoot = resolve(pluginPackagesRoot(dataDir));
  assertPluginSourceOutsideStore(source, destinationRoot);
  const scanned = scan(source);
  const parent = join(destinationRoot, scanned.manifest.id);
  const destination = join(parent, scanned.contentHash);
  if (existsSync(destination)) return scan(destination, scanned.contentHash);
  mkdirSync(parent, { recursive: true });
  const temporary = join(parent, `.${basename(destination)}.${randomUUID()}.tmp`);
  try {
    cpSync(source, temporary, { recursive: true, dereference: false, errorOnExist: true });
    scan(temporary, scanned.contentHash);
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return scan(destination, scanned.contentHash);
}
