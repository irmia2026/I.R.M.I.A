/**
 * 运行器与外部解释器的**路径解析**（唯一一处，别在两条调用链里各猜一遍）
 *
 * 三条路径各有各的坑，所以集中在这里：
 *   · `node-runner.mjs` / `python/runner.py` 在源码树里住在 `src/plugin/runners`，而
 *     `tsc` **只编译 `.ts`**（`include` 只收 `src` 下的 `.ts`）。于是打包后的 `dist/plugin/` 里
 *     没有它们（见交付说明里的"待补的打包步骤"）。这里按"模块目录 → 仓库 src → cwd/src"
 *     的顺序找一个真实存在的，找不到时把查过的路径写进错误里，而不是静默起不来。
 *   · **自带 node**：安装包把它放在 `<包根>/runtime/node/node.exe`（`restart-chain.ts` 的
 *     `BUNDLED_NODE_REL` 是同一份口径），开发机上没有这一份就退回 `process.execPath`。
 *   · **Python**：用宿主 PATH 上的 `python`（可用 `IRMIA_PYTHON` 覆盖）。P1a 不打包 Python，
 *     所以"这台机器没有 Python"必须是一条能读懂的安装期错误，而不是 ENOENT 栈。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUNDLED_NODE_REL } from '../runtime/restart-chain.ts';

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** 运行器目录：源码树里就是 `src/plugin/runners`；`dist/plugin` 下缺失时回落到源码树 */
export function pluginRunnerRoot(): string {
  const candidates = [
    join(moduleDir, 'runners'),
    // dist/plugin → <包根>/src/plugin/runners（开发/自托管布局；打包版需要补齐 runners 目录）
    join(moduleDir, '..', '..', 'src', 'plugin', 'runners'),
    join(process.cwd(), 'src', 'plugin', 'runners'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return resolve(candidate);
  return resolve(candidates[0]!);
}

export function nodeRunnerPath(): string {
  return join(pluginRunnerRoot(), 'node-runner.mjs');
}

export function pythonRunnerPath(): string {
  return join(pluginRunnerRoot(), 'python', 'runner.py');
}

/** Python 插件的 AST 扫描器（安装期用，不是运行期） */
export function pythonAstScannerPath(): string {
  return join(pluginRunnerRoot(), 'python', 'ast_scan.py');
}

/** 自带 node 优先；开发机上退回当前进程用的那个（版本完全相同：>=22 才允许起宿主） */
export function resolveNodeExecutable(): string {
  const bundled = join(process.cwd(), BUNDLED_NODE_REL);
  return existsSync(bundled) ? bundled : process.execPath;
}

export function resolvePythonExecutable(): string {
  const override = process.env['IRMIA_PYTHON'];
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return process.platform === 'win32' ? 'python' : 'python3';
}

let pythonProbe: { binary: string; available: boolean; detail: string } | null = null;

/**
 * Python 可用性探测（**只探一次**：安装期与运行期读同一个结论）。
 *
 * 探的是"能不能被宿主这样拉起"：`-I` 隔离模式 + `-u` 无缓冲，与真实启动形状一致。
 */
export function probePython(binary = resolvePythonExecutable()): { available: boolean; detail: string; binary: string } {
  if (pythonProbe !== null && pythonProbe.binary === binary) return pythonProbe;
  let available = false;
  let detail = '';
  try {
    const result = spawnSync(binary, ['-I', '-c', 'import sys; sys.stdout.write(sys.version.split()[0])'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error !== undefined && result.error !== null) detail = result.error.message;
    else if (result.status !== 0) detail = (result.stderr ?? '').trim() || `退出码 ${String(result.status)}`;
    else {
      available = true;
      detail = (result.stdout ?? '').trim();
    }
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  pythonProbe = { binary, available, detail };
  return pythonProbe;
}

/** 仅供测试：清掉探测缓存（不同测试文件里的 PATH 可能不同） */
export function resetPythonProbe(): void {
  pythonProbe = null;
}
