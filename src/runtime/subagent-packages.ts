import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync, writeSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { McpServerEntry } from '../mcp/client.ts';
import { BUILTIN_PROFILES, ROLE_PACKAGES_FILE, type ProfileInstallSource } from './subagent-profiles.ts';
import { inside } from './subagent-workspace.ts';

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

/**
 * 应用资源根：本模块在 dev 是 `<repo>/src/runtime/`、装完是 `<install>/dist/runtime/`，
 * 两种布局下往上两级都正好是“仓库根 / 安装根”。内置角色包（`builtin:packs/...`、
 * `builtin:skills/...`）与 LICENSE 都从这里找，**不能依赖 process.cwd()**：
 * 安装版后端的 cwd 是 `<dataDir>/workspace`（见安装目录 launcher.mjs），拿它当资源根
 * 会让内置包永远 `source-missing`（P4.4 遗留的部署缺陷，P4.5 修）。
 */
const MODULE_RESOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface RolePackageSourceRecord extends ProfileInstallSource {
  id: string;
  kind: 'skill' | 'mcp';
  license: string;
}

export interface RolePackageRecord {
  id: string;
  installedAt: string;
  packHash: string;
  sources: RolePackageSourceRecord[];
}

export interface SubagentPackageInstallerOptions {
  dataDir: string;
  projectRoot?: string;
  fetchImpl?: typeof fetch;
  now?: () => string;
}

interface SourceDescription extends RolePackageSourceRecord {
  sourceDir: string;
  archiveSubdir: string;
}

export class SubagentPackageInstaller {
  private readonly dataDir: string;
  private readonly projectRoot: string;
  /** 内置资源根的候选（按优先级）：显式 projectRoot → process.cwd() → 模块所在应用根。 */
  private readonly resourceRoots: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => string;

  constructor(options: SubagentPackageInstallerOptions) {
    this.dataDir = resolve(options.dataDir);
    this.projectRoot = resolve(options.projectRoot ?? process.cwd());
    const roots = [this.projectRoot, resolve(process.cwd()), MODULE_RESOURCE_ROOT];
    this.resourceRoots = [...new Set(roots)];
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async install(profileId: string): Promise<RolePackageRecord> {
    const profile = BUILTIN_PROFILES.find((item) => item.id === profileId);
    if (profile === undefined || profileId === 'general' || profile.install === undefined || profile.install.length === 0) {
      throw new Error('profile-install-not-supported');
    }
    const packs = resolve(this.dataDir, 'subagents', 'packs');
    const staging = resolve(packs, '.staging', `${profileId}-${randomUUID()}`);
    const final = resolve(packs, profileId);
    const backup = resolve(packs, '.backups', `${profileId}-${randomUUID()}`);
    mkdirSync(staging, {recursive: true});
    const sourceRecords: RolePackageSourceRecord[] = [];
    try {
      for (const source of profile.install) {
        const description = describeSource(source);
        const target = resolve(staging, description.kind === 'skill' ? 'skills' : 'mcp-packages', description.id);
        if (source.source.startsWith('builtin:')) {
          const builtin = this.resolveBuiltinSource(description, source.sha256 ?? '');
          assertNoLinks(builtin.dir);
          copyTree(builtin.dir, target);
        } else {
          const archive = resolve(staging, '.downloads', `${description.id}.tgz`);
          await this.download(source, archive);
          if (sha256File(archive) !== source.sha256) throw new Error(`source-hash-mismatch:${description.id}`);
          const extracted = resolve(staging, '.extracted', description.id);
          extractPackageArchive(archive, extracted);
          const roots = readdirSync(extracted).filter((name) => !name.startsWith('.'));
          if (roots.length !== 1) throw new Error(`archive-root-invalid:${description.id}`);
          const sourceDir = resolve(extracted, roots[0]!, description.archiveSubdir);
          if (!inside(extracted, sourceDir) || !existsSync(sourceDir)) throw new Error(`archive-source-missing:${description.id}`);
          assertNoLinks(sourceDir);
          verifyLicense(findLicense(sourceDir, resolve(extracted, roots[0]!)), description.license);
          copyTree(sourceDir, target);
        }
        sourceRecords.push({
          id: description.id, kind: description.kind, license: description.license,
          source: source.source, ...(source.ref === undefined ? {} : {ref: source.ref}),
          ...(source.sha256 === undefined ? {} : {sha256: source.sha256}),
        });
      }
      for (const id of profile.mcpServers) {
        const declaration = mcpDeclaration(id);
        const file = resolve(staging, 'mcp', `${id}.json`);
        mkdirSync(dirname(file), {recursive: true});
        writeFileSync(file, `${JSON.stringify(declaration, null, 2)}\n`, 'utf8');
        if (id === 'playwright') installPlaywrightDependencies(resolve(staging, 'mcp-packages', 'playwright'));
      }
      removeTransientDirs(staging);
      const record: RolePackageRecord = {
        id: profileId, installedAt: this.now(), packHash: hashTree(staging), sources: sourceRecords,
      };
      let backedUp = false;
      try {
        if (existsSync(final)) {
          mkdirSync(dirname(backup), {recursive: true});
          renameSync(final, backup);
          backedUp = true;
        }
        renameSync(staging, final);
        registerRolePackage(this.dataDir, record);
      } catch (error) {
        if (existsSync(final)) rmSync(final, {recursive: true, force: true});
        if (backedUp && existsSync(backup)) renameSync(backup, final);
        throw error;
      }
      if (existsSync(backup)) rmSync(backup, {recursive: true, force: true});
      return record;
    } catch (error) {
      if (existsSync(staging)) rmSync(staging, {recursive: true, force: true});
      throw error;
    }
  }

  /**
   * 内置来源（`builtin:<相对路径>`）的定位与校验。
   *
   * 候选根按 `resourceRoots` 优先级逐个试：只有 hash 与清单完全一致的候选才算命中
   * （老安装目录里残留的旧版技能目录不会被误当成“当前包”）。一个候选都不可用 ⇒
   * `source-missing`；有候选但 hash 全不符 ⇒ `source-hash-mismatch`（默认拒绝，不静默换根）。
   * LICENSE 从来源目录 / 命中的资源根 / 模块应用根里找，找到后按 Profile 声明的许可证校验正文。
   */
  private resolveBuiltinSource(description: SourceDescription, expectedHash: string): {dir: string; license: string} {
    if (expectedHash === '') throw new Error(`source-not-pinned:${description.id}`);
    const candidates = this.resourceRoots
      .map((root) => ({root, dir: resolve(root, description.sourceDir)}))
      .filter((candidate) => inside(candidate.root, candidate.dir) && existsSync(candidate.dir));
    if (candidates.length === 0) throw new Error(`source-missing:${description.id}`);
    for (const candidate of candidates) {
      if (hashTree(candidate.dir) !== expectedHash) continue;
      const license = findLicenseAmong([candidate.dir, candidate.root, MODULE_RESOURCE_ROOT]);
      verifyLicense(license, description.license);
      return {dir: candidate.dir, license};
    }
    throw new Error(`source-hash-mismatch:${description.id}`);
  }

  private async download(source: ProfileInstallSource, target: string): Promise<void> {    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await this.fetchImpl(source.source, {signal: controller.signal, redirect: 'follow'});
      if (!response.ok || response.body === null) throw new Error(`download-failed:${response.status}`);
      mkdirSync(dirname(target), {recursive: true});
      const fd = openSync(target, 'wx');
      let total = 0;
      try {
        const reader = response.body.getReader();
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          total += value?.byteLength ?? 0;
          if (total > MAX_ARCHIVE_BYTES) throw new Error('archive-too-large');
          if (value !== undefined) writeSync(fd, value);
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

export function readRolePackageRecords(dataDir: string): RolePackageRecord[] {
  const file = resolve(dataDir, 'subagents', ROLE_PACKAGES_FILE);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const rows = Array.isArray(raw) ? raw : typeof raw === 'object' && raw !== null && Array.isArray((raw as {installed?: unknown}).installed)
      ? (raw as {installed: unknown[]}).installed : [];
    return rows.filter((row): row is RolePackageRecord => typeof row === 'object' && row !== null
      && typeof (row as {id?: unknown}).id === 'string'
      && typeof (row as {packHash?: unknown}).packHash === 'string'
      && Array.isArray((row as {sources?: unknown}).sources));
  } catch {
    return [];
  }
}

export function verifyRolePackage(dataDir: string, record: RolePackageRecord): boolean {
  try {
    const root = resolve(dataDir, 'subagents', 'packs', record.id);
    return existsSync(root) && hashTree(root) === record.packHash;
  } catch {
    return false;
  }
}

export function hashTree(root: string): string {
  if (!existsSync(root)) throw new Error('package-missing');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const path = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('package-symlink-not-allowed');
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relativePosix(root, path));
    }
  };
  walk(root);
  const hash = createHash('sha256');
  for (const name of files.sort()) {
    hash.update(name);
    hash.update('\0');
    hash.update(readFileSync(resolve(root, name)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function registerRolePackage(dataDir: string, record: RolePackageRecord): void {
  const existing = readRolePackageRecords(dataDir);
  const rows: unknown[] = [...existing.filter((item) => item.id !== record.id), record];
  const legacyFile = resolve(dataDir, 'subagents', ROLE_PACKAGES_FILE);
  if (existsSync(legacyFile)) {
    try {
      const raw = JSON.parse(readFileSync(legacyFile, 'utf8')) as unknown;
      const oldRows = Array.isArray(raw) ? raw : typeof raw === 'object' && raw !== null && Array.isArray((raw as {installed?: unknown}).installed)
        ? (raw as {installed: unknown[]}).installed : [];
      for (const row of oldRows) {
        const id = typeof row === 'string' ? row : typeof row === 'object' && row !== null ? (row as {id?: unknown}).id : null;
        if (typeof id === 'string' && id !== record.id && !existing.some((item) => item.id === id)) rows.push(row);
      }
    } catch {
      // A corrupt old registry must not make a newly verified package look installed under another role.
    }
  }
  writeJsonAtomic(legacyFile, {schema: 1, installed: rows});
}

function describeSource(source: ProfileInstallSource): SourceDescription {
  if (source.ref === undefined || source.sha256 === undefined) throw new Error('source-not-pinned');
  if (source.source.startsWith('builtin:')) {
    const sourceDir = source.source.slice('builtin:'.length);
    const id = sourceDir.split('/').at(-1) ?? '';
    return {id, kind: 'skill', license: source.license ?? 'AGPL-3.0-only', source: source.source, ref: source.ref, sha256: source.sha256, sourceDir, archiveSubdir: ''};
  }
  const url = new URL(source.source);
  if (url.hostname === 'codeload.github.com' && url.pathname.includes('/oraios/serena/')) {
    return remote(source, 'serena', 'mcp', 'GPL-3.0-or-later AND MIT', '');
  }
  if (url.hostname === 'codeload.github.com' && url.pathname.includes('/forint573/human-copywrite/')) {
    return remote(source, 'human-copywrite', 'skill', 'Apache-2.0', 'human-copywrite');
  }
  if (url.hostname === 'codeload.github.com' && url.pathname.includes('/microsoft/markitdown/')) {
    return remote(source, 'markitdown', 'mcp', 'MIT', '');
  }
  if (url.hostname === 'registry.npmjs.org' && url.pathname === '/@playwright/mcp/-/mcp-0.0.84.tgz') {
    return remote(source, 'playwright', 'mcp', 'Apache-2.0', '');
  }
  throw new Error('source-not-curated');
}

function remote(
  source: ProfileInstallSource,
  id: string,
  kind: 'skill' | 'mcp',
  license: string,
  archiveSubdir: string,
): SourceDescription {
  return {id, kind, license, source: source.source, ref: source.ref!, sha256: source.sha256!, sourceDir: '', archiveSubdir};
}

function mcpDeclaration(id: string): McpServerEntry {
  if (id === 'serena') return {
    name: id, command: 'uvx',
    args: [
      '--from', '{pack}/mcp-packages/serena', 'serena', 'start-mcp-server',
      '--context', 'ide', '--agent-interface', 'tools', '--open-web-dashboard', 'false', '--project', '{project}',
    ],
    cwd: '{project}', toolsCache: false, requestTimeoutMs: 120_000,
  };
  if (id === 'playwright') return {
    name: id, command: 'node',
    args: ['{pack}/mcp-packages/playwright/cli.js', '--browser', 'msedge', '--headless', '--isolated', '--allow-unrestricted-file-access'],
    cwd: '{workspace}', toolsCache: false, requestTimeoutMs: 120_000,
  };
  if (id === 'markitdown') return {
    name: id, command: 'uvx',
    args: [
      '--from', '{pack}/mcp-packages/markitdown/packages/markitdown-mcp',
      '--with', '{pack}/mcp-packages/markitdown/packages/markitdown', 'markitdown-mcp',
    ],
    cwd: '{workspace}', toolsCache: false, requestTimeoutMs: 120_000,
  };
  throw new Error('mcp-not-curated');
}

/**
 * tar 是否支持 GNU 的 `--force-local`。
 *
 * 为什么需要探测：Windows 自带的是 bsdtar（`C:\Windows\System32\tar.exe`），它不认识
 * `--force-local`（实测 `tar.exe: Option --force-local is not supported`）；GNU tar 则需要它
 * 来避免把 `C:\path` 里的盘符当成远程主机。所以按平台分：Windows 不传，其它平台保留。
 * 这条判据只此一处，`-t/-tv/-x` 三条调用共用。
 */
function tarForceLocalArgs(): string[] {
  return process.platform === 'win32' ? [] : ['--force-local'];
}

export function extractPackageArchive(archive: string, target: string): void {
  mkdirSync(target, {recursive: true});
  const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
  const archiveArg = archive.replaceAll('\\', '/');
  const targetArg = target.replaceAll('\\', '/');
  const forceLocal = tarForceLocalArgs();
  const listed = run(tar, [...forceLocal, '-tf', archiveArg], dirname(archive));
  for (const raw of listed.split(/\r?\n/u)) {
    const name = raw.trim().replace(/^\.\//u, '');
    if (name === '') continue;
    if (isAbsolute(name) || name.includes('\0') || name.split(/[\\/]/u).includes('..')) throw new Error('archive-path-denied');
  }
  const verbose = run(tar, [...forceLocal, '-tvf', archiveArg], dirname(archive));
  for (const line of verbose.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    if (!['-', 'd'].includes(line[0] ?? '')) throw new Error('archive-link-not-allowed');
  }
  run(tar, [...forceLocal, '-xf', archiveArg, '-C', targetArg, '--no-same-owner', '--no-same-permissions'], dirname(archive));
  assertNoLinks(target);
}

function installPlaywrightDependencies(root: string): void {
  run(process.execPath, [
    npmCliPath(), 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
  ], root);
}

/**
 * 找到 npm 的 CLI 入口（用 `process.execPath` 直接跑它，不经过 .cmd / shell）。
 *
 * 候选顺序：
 *   ① `npm_execpath`（父进程就是 npm 时它一定对）；
 *   ② `<当前 node 目录>/node_modules/npm/bin/npm-cli.js`（标准 Node 发行版布局）；
 *   ③ `%APPDATA%\npm\node_modules\npm\bin\npm-cli.js`（npm 全局前缀）；
 *   ④ **PATH 里每个目录下的 `node_modules/npm/bin/npm-cli.js`**（P4.5 补）——
 *      安装版后端自带的 `runtime\node` 只有 node.exe、没有 npm；而用户的 Node 可能装在
 *      任意目录（本机 `<安装根>\tools\node`）并且已经进了 PATH。不查 PATH 的话，
 *      Playwright 这类 MCP 依赖的安装与 healthcheck 的 `npm` 二进制定位会直接失败。
 * 一处实现，安装与 healthcheck 共用。
 */
export function npmCliPath(): string {
  const candidates = [
    process.env['npm_execpath'],
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...(process.env['APPDATA'] === undefined ? [] : [join(process.env['APPDATA'], 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js')]),
    ...pathNpmCliCandidates(),
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.endsWith('.js') && existsSync(candidate)) return resolve(candidate);
  }
  throw new Error('npm-not-found');
}

function pathNpmCliCandidates(): string[] {
  const pathValue = process.env['PATH'] ?? process.env['Path'] ?? '';
  const out: string[] = [];
  for (const dir of pathValue.split(delimiter)) {
    const trimmed = dir.trim().replace(/^"|"$/gu, '');
    if (trimmed === '') continue;
    out.push(join(trimmed, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    // 有些发行版把 npm-cli.js 直接放在 node 主目录（少见但成本很低）
    out.push(join(trimmed, 'npm-cli.js'));
  }
  return out;
}

function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, [...args], {
    cwd, shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180_000,
  });
  const status = result.status;
  const stdout = result.stdout;
  if (status !== 0) throw new Error(`package-command-failed:${status ?? 'spawn'}`);
  return typeof stdout === 'string' ? stdout : String(stdout ?? '');
}

function assertNoLinks(root: string): void {
  for (const entry of readdirSync(root, {withFileTypes: true})) {
    const path = resolve(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('package-symlink-not-allowed');
    if (entry.isDirectory()) assertNoLinks(path);
  }
}

/**
 * 显式递归复制（P4.5 收尾）。
 *
 * 为什么不用 `fs.cpSync`：本机实测**原生崩溃**——`cpSync(<安装根>/packs/subagents/skills/auto-deep-research,
 * ...)` 在 Node 22.19 / Windows 上稳定以 0xC0000409 退出（同一源目录手工 readdir+copyFile
 * 一切正常，dev 仓库里的同内容目录也不崩）。安装接口在做内置包复制时正好走这条路径，表现为
 * “点安装 → 后端进程静默消失、角色仍 locked”。换成显式递归复制后行为确定、可测，
 * 并且顺手把 symlink 拒在每个文件/目录上（与 `assertNoLinks` 同一套判据，纵深防御）。
 * 只复制普通文件与目录；权限位/时间戳不保留（包完整性由 hashTree 兜底，不需要这些元数据）。
 */
function copyTree(from: string, to: string): void {
  mkdirSync(to, {recursive: true});
  for (const entry of readdirSync(from, {withFileTypes: true})) {
    const source = resolve(from, entry.name);
    const target = resolve(to, entry.name);
    if (entry.isSymbolicLink()) throw new Error('package-symlink-not-allowed');
    if (entry.isDirectory()) copyTree(source, target);
    else if (entry.isFile()) copyFileSync(source, target);
  }
}

function findLicense(sourceDir: string, archiveRoot: string): string {
  for (const root of [sourceDir, archiveRoot]) {
    for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
      const path = resolve(root, name);
      if (existsSync(path)) return path;
    }
  }
  throw new Error('license-missing');
}

/** 在给定根里找许可证文件（内置来源用：来源目录 → 命中的资源根 → 模块应用根）。 */
function findLicenseAmong(roots: readonly string[]): string {
  for (const root of roots) {
    for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
      const path = resolve(root, name);
      if (existsSync(path)) return path;
    }
  }
  throw new Error('license-missing');
}

function verifyLicense(path: string, expected: string): void {
  const text = readFileSync(path, 'utf8');
  const ok = expected.includes('AGPL') ? /AFFERO GENERAL PUBLIC LICENSE/iu.test(text)
    : expected.includes('Apache') ? /Apache License/iu.test(text)
      : expected.includes('MIT') && !expected.includes('GPL') ? /MIT License/iu.test(text)
        : expected.includes('GPL') ? /GPL-3\.0-or-later|General Public License/iu.test(text) : false;
  if (!ok) throw new Error('license-mismatch');
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function relativePosix(root: string, path: string): string {
  return relative(resolve(root), resolve(path)).replaceAll('\\', '/');
}

function removeTransientDirs(staging: string): void {
  for (const name of ['.downloads', '.extracted']) rmSync(resolve(staging, name), {recursive: true, force: true});
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), {recursive: true});
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, 'wx');
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    rmSync(tmp, {force: true});
    throw error;
  }
}
