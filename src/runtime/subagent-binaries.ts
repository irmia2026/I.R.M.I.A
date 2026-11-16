import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';

/**
 * 运行时二进制探测的唯一实现。
 *
 * 为什么单独放这里：`availability()`（同步摘要）和 `healthcheck`（运行时探测）都要用，
 * 不能让两边各写一份；`node`/`npm` 还必须走安装版自带的 node 与 npm-cli.js，
 * 不能假定 PATH 上有它们。
 */
export function npmCliPath(): string {
  const candidates = [
    process.env['npm_execpath'],
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...(process.env['APPDATA'] === undefined
      ? []
      : [join(process.env['APPDATA'], 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js')]),
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
    out.push(join(trimmed, 'npm-cli.js'));
  }
  return out;
}

/** 同步探测一个二进制是否真的能启动；失败一律当作缺失。 */
export function binaryAvailable(id: string, dataDir?: string): boolean {
  if (!/^[A-Za-z0-9._-]+$/u.test(id)) return false;
  if (id === 'node' || id === 'npm') {
    let args: string[];
    try {
      args = id === 'node' ? ['--version'] : [npmCliPath(), '--version'];
    } catch {
      return false;
    }
    const result = spawnSync(process.execPath, args, {
      shell: false, windowsHide: true, timeout: 5_000, encoding: 'utf8',
    });
    return result.status === 0;
  }
  // 先认 PATH（可能是一个能启动的系统版本）；再认托管的 data/tools/<id>
  // 与随包的 runtime/<id>。只查 PATH 会漏掉 managed python。
  if (spawnVersion(id)) return true;
  if (dataDir === undefined) return false;
  const dirs = [
    join(dataDir, 'tools', id),
    join(dataDir, 'tools', id, 'bin'),
    join(dataDir, 'tools', id, 'cmd'),
    join(process.cwd(), 'runtime', id),
  ];
  const exts = (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext !== '');
  const names = [id, ...exts.map((ext) => `${id}${ext}`)];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate) && spawnVersion(candidate)) return true;
    }
  }
  return false;
}

function spawnVersion(exe: string): boolean {
  try {
    return spawnSync(exe, ['--version'], {
      shell: false, windowsHide: true, timeout: 5_000, encoding: 'utf8',
    }).status === 0;
  } catch {
    return false;
  }
}
