/**
 * Irmia Agent — 文件系工具包：备份与回滚存储
 *
 * safe 家族五步链的第一步与最后一步都落在这里：写前必须留下可回滚的副本，
 * 失败才能把文件复原。对齐 docs/design.md §4.18（safe_edit 五步链）与
 * §4.22（workspace 文件版本：写工具执行后自动留快照）。
 *
 * 布局：`<备份根>/<转义后的相对目录>/<文件名>.<时间戳>.<pid>-<序号>.bak`
 *   • 文件名里的时间戳是紧凑 ISO（`2026-09-29T12-30-45-123Z`），字典序即时间序，
 *     因此「保留最近 N 份」不需要读文件内容或 mtime，纯字符串排序即可；
 *   • 相对目录按段转义，杜绝 `..`、盘符、保留设备名把备份写到备份根之外；
 *   • 每文件保留 10 份（可配），超出即删最旧——无人值守下备份不能无限膨胀。
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { compactTimestamp, sha256Hex } from './text-codec.ts';
import { FS_ERROR_CODES, toErrorMessage } from './types.ts';

/** 备份根缺失 home 时的退路标记：调用方会用 `<dataDir>/backups` 兜底 */
export const FALLBACK_BACKUP_DIR_NAME = 'backups';

const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export interface BackupEntry {
  /** 备份文件名（相对该文件的备份目录） */
  name: string;
  /** 备份文件绝对路径 */
  path: string;
  bytes: number;
  /** ISO 8601 */
  mtime: string;
}

export interface BackupRecord extends BackupEntry {
  /** 目标文件在备份时刻是否已存在；false 表示这次备份记录的是「即将新建」 */
  existedBefore: boolean;
  createdAt: string;
}

/** 每个进程一份单调序号，保证同一毫秒内的多次备份也有确定顺序 */
let backupSeq = 0;

function escapeSegment(raw: string): string {
  let seg = raw.replace(/[<>:"|?*\u0000-\u001f]/gu, '_');
  if (seg === '' || /^\.+$/u.test(seg)) seg = '_';
  seg = seg.replace(/[ .]+$/u, '_');
  const dot = seg.indexOf('.');
  const stem = (dot === -1 ? seg : seg.slice(0, dot)).toUpperCase();
  if (WINDOWS_RESERVED.has(stem)) seg = `_${seg}`;
  if (seg.length > 80) {
    seg = `${seg.slice(0, 64)}_${sha256Hex(raw).slice(0, 8)}`;
  }
  return seg;
}

/** 目标文件的备份目录：镜像工作区内的相对目录结构，逐段转义 */
export function backupDirFor(backupRoot: string, workspaceRoot: string, absPath: string): string {
  const rel = relative(workspaceRoot, absPath).replaceAll('\\', '/');
  const segments = rel.split('/');
  const dirSegments = segments.slice(0, -1).filter((seg) => seg !== '' && seg !== '.');
  return dirSegments.length === 0
    ? backupRoot
    : join(backupRoot, ...dirSegments.map(escapeSegment));
}

function backupNameFor(absPath: string, at: Date): string {
  const base = absPath.replaceAll('\\', '/').split('/').pop() ?? 'file';
  backupSeq += 1;
  // pid 与序号都必须零填充：文件名排序是「取最近一份」的唯一依据，
  // 不定宽的话 `-10.bak` 会排到 `-9.bak` 前面，最近备份就选错了。
  const pid = String(process.pid).padStart(8, '0');
  const seq = String(backupSeq).padStart(6, '0');
  return `${escapeSegment(base)}.${compactTimestamp(at)}.${pid}-${seq}.bak`;
}

/**
 * 写入一份备份并清理超龄副本，返回备份记录。
 * `content` 为 null 表示目标文件当前不存在（记录一次「新建前」的空快照，
 * 供回滚时删除文件用）。
 */
export async function createBackup(
  backupRoot: string,
  workspaceRoot: string,
  absPath: string,
  content: Buffer | null,
  at: Date,
  keep: number,
): Promise<BackupRecord> {
  const dir = backupDirFor(backupRoot, workspaceRoot, absPath);
  await mkdir(dir, { recursive: true });
  const name = backupNameFor(absPath, at);
  const path = join(dir, name);
  const body = content ?? Buffer.from('');
  await writeFile(path, body);
  await pruneBackups(backupRoot, workspaceRoot, absPath, keep);
  return {
    name,
    path,
    bytes: body.byteLength,
    mtime: at.toISOString(),
    existedBefore: content !== null,
    createdAt: at.toISOString(),
  };
}

/** 备份文件名的前缀：`<转义文件名>.` */
function backupPrefix(absPath: string): string {
  const base = absPath.replaceAll('\\', '/').split('/').pop() ?? 'file';
  return `${escapeSegment(base)}.`;
}

/** 列出一个目标文件的所有备份，按时间从新到旧 */
export async function listBackups(
  backupRoot: string,
  workspaceRoot: string,
  absPath: string,
): Promise<BackupEntry[]> {
  const dir = backupDirFor(backupRoot, workspaceRoot, absPath);
  const prefix = backupPrefix(absPath);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const entries: BackupEntry[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.bak')) continue;
    const full = join(dir, name);
    try {
      const info = await stat(full);
      if (!info.isFile()) continue;
      entries.push({ name, path: full, bytes: info.size, mtime: info.mtime.toISOString() });
    } catch {
      // 竞态下文件消失：跳过，不影响列举
    }
  }
  // 文件名内嵌时间戳，字典序降序即最新在前
  entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return entries;
}

async function pruneBackups(backupRoot: string, workspaceRoot: string, absPath: string, keep: number): Promise<void> {
  if (keep <= 0) return;
  const all = await listBackups(backupRoot, workspaceRoot, absPath);
  for (const stale of all.slice(keep)) {
    try {
      await rm(stale.path, { force: true });
    } catch {
      // 清理失败只影响磁盘占用，绝不影响本次写入的正确性
    }
  }
}

export type ReadBackupResult =
  | { ok: true; buffer: Buffer; path: string }
  | { ok: false; code: string; reason: string };

/** 读取指定备份的内容；`name` 省略时取最近一份 */
export async function readBackup(
  backupRoot: string,
  workspaceRoot: string,
  absPath: string,
  name?: string,
): Promise<ReadBackupResult> {
  const all = await listBackups(backupRoot, workspaceRoot, absPath);
  if (all.length === 0) {
    return {
      ok: false,
      code: FS_ERROR_CODES.NO_BACKUP,
      reason: `没有 ${absPath} 的可用备份（备份根：${backupRoot}）`,
    };
  }
  let chosen: BackupEntry;
  if (name === undefined || name === '') {
    chosen = all[0] as BackupEntry;
  } else {
    const hit = all.find((entry) => entry.name === name);
    if (hit === undefined) {
      return {
        ok: false,
        code: FS_ERROR_CODES.NO_BACKUP,
        reason: `备份 ${name} 不存在；可用：${all.map((e) => e.name).join(', ')}`,
      };
    }
    chosen = hit;
  }
  try {
    const buffer = await readFile(chosen.path);
    return { ok: true, buffer, path: chosen.path };
  } catch (err) {
    return {
      ok: false,
      code: FS_ERROR_CODES.NO_BACKUP,
      reason: `读取备份失败：${toErrorMessage(err)}`,
    };
  }
}

export function backupDirFromHome(home: string): string {
  return join(home, '.irmia', FALLBACK_BACKUP_DIR_NAME);
}

export function backupDirFromData(dataDir: string): string {
  return join(dataDir, FALLBACK_BACKUP_DIR_NAME);
}
