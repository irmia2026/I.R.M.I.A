/**
 * Irmia Agent — Python 解释器与模块探测（coder/worker 的 codegraph 工具共用）
 *
 * 为什么单独一层：这套判据有两个消费者，必须在同一处：
 *   ① `subagent-health.ts` 的 healthcheck —— Profile 的 `requires.pythonModules` 缺失时
 *      必须把角色锁成 `locked + missing`（不能静默降级成“工具在但用不了”）；
 *   ② `subagent-code.ts` 的 code 工具 —— 每次 spawn `code_cli.py` 前要知道用哪个解释器。
 * 两处各写一套 PATH 猜测，就会出现“健康检查说可用、工具却说找不到 python”的假账。
 *
 * 边界：这是**可用性探测**，不是沙箱。探测只回答“这个解释器能不能起、这些模块能不能
 * import”，不做路径隔离；子进程仍以同一用户权限运行（见 subagent-shell.ts 的文件头口径）。
 */
import { spawnSync } from 'node:child_process';

/** healthcheck 与工具共用的默认模块清单（worker Profile 的 requires.pythonModules 同源）。 */
export const WORKER_PYTHON_MODULES = Object.freeze([
  'tree_sitter',
  'tree_sitter_javascript',
  'tree_sitter_typescript',
  'tree_sitter_go',
  'tree_sitter_rust',
  'tree_sitter_java',
  'tree_sitter_c',
  'tree_sitter_cpp',
] as const);

/** 解释器候选：与框架其它 Python 消费口（plugin/runner-paths.ts、deps/probe.ts）保持同名链。 */
export function pythonBinaryCandidates(override?: string): string[] {
  const envOverride = process.env['IRMIA_PYTHON'];
  const fromEnv = typeof envOverride === 'string' && envOverride.trim() !== '' ? envOverride.trim() : undefined;
  const explicit = override !== undefined && override.trim() !== '' ? [override.trim()] : [];
  const platformOrder = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  return [...new Set([...explicit, ...(fromEnv === undefined ? [] : [fromEnv]), ...platformOrder])];
}

export interface PythonProbe {
  binary: string;
  available: boolean;
  /** 形如 "3.11.5"；不可用时为空串。 */
  version: string;
  detail: string;
}

export interface PythonRunnerResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** spawn 级错误（ENOENT 等）；有它时 status 通常为 null。 */
  error?: string;
}

/**
 * 可注入的命令执行器：默认 spawnSync（同步、带 timeout）；测试用它替代真解释器，
 * 免得 healthcheck 用例依赖“这台机器必须装了什么”。
 */
export type PythonRunner = (binary: string, args: readonly string[], timeoutMs: number) => PythonRunnerResult;

export const DEFAULT_PYTHON_PROBE_TIMEOUT_MS = 15_000;

const defaultRunner: PythonRunner = (binary, args, timeoutMs) => {
  try {
    const result = spawnSync(binary, [...args], {
      shell: false, windowsHide: true, timeout: timeoutMs, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const base: PythonRunnerResult = {
      status: result.status,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
    };
    if (result.error !== undefined && result.error !== null) base.error = result.error.message;
    return base;
  } catch (error) {
    return {
      status: null, stdout: '', stderr: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/** 探测单个候选解释器：能起且能打印版本才算可用。 */
export function probePython(
  binary: string,
  options: {runner?: PythonRunner; timeoutMs?: number} = {},
): PythonProbe {
  const runner = options.runner ?? defaultRunner;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PYTHON_PROBE_TIMEOUT_MS;
  // 不加 `-I/-E`：这里要回答的是“真实 spawn 时能不能用”。隔离模式会同时忽略
  // PYTHONPATH 与 user site-packages——某些机器上 tree-sitter 恰好装在那里，加了它
  // 就会出现“healthcheck 说缺、code 工具却能 import”的假账。
  const result = runner(binary, ['-c', 'import sys; sys.stdout.write(sys.version.split()[0])'], timeoutMs);
  if (result.error !== undefined) return {binary, available: false, version: '', detail: result.error};
  if (result.status !== 0) {
    return {binary, available: false, version: '', detail: result.stderr.trim() || `exit=${String(result.status)}`};
  }
  return {binary, available: true, version: result.stdout.trim(), detail: result.stdout.trim()};
}

let cachedPython: {key: string; binary: string | null} | null = null;

/**
 * 解析一个**真能启动**的 Python 解释器；找不到返回 null。
 *
 * 只缓存无 override 的默认结论（测试里显式 override 时不缓存，避免不同用例互相污染）。
 */
export function resolvePythonBinary(options: {override?: string} = {}): string | null {
  const override = options.override?.trim();
  if (override !== undefined && override !== '') {
    return probePython(override).available ? override : null;
  }
  if (cachedPython !== null && cachedPython.key === 'default') return cachedPython.binary;
  let found: string | null = null;
  for (const candidate of pythonBinaryCandidates()) {
    if (probePython(candidate).available) {
      found = candidate;
      break;
    }
  }
  cachedPython = {key: 'default', binary: found};
  return found;
}

/** 测试隔离：清掉解释器定位缓存（PATH 可能在不同用例里被改）。 */
export function resetPythonBinaryCache(): void {
  cachedPython = null;
}

/**
 * 用一次子进程检查多个模块能否真的 import（`importlib.import_module`，不是 find_spec：
 * 后者只回答“找得到文件”，装坏了的原生扩展照样会过）。
 *
 * 返回缺失模块 id 列表（顺序与输入一致）。解释器不可用 / 探测超时 ⇒ 全部算缺失。
 */
export function probePythonModules(
  modules: readonly string[],
  options: {binary?: string; override?: string; runner?: PythonRunner; timeoutMs?: number} = {},
): string[] {
  const unique = [...new Set(modules)];
  if (unique.length === 0) return [];
  const binary = options.binary
    ?? resolvePythonBinary(options.override === undefined ? {} : {override: options.override});
  if (binary === null) return unique;
  const runner = options.runner ?? defaultRunner;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PYTHON_PROBE_TIMEOUT_MS;
  const script = [
    'import importlib, json, sys',
    'missing = []',
    'for name in json.loads(sys.argv[1]):',
    '    try:',
    '        importlib.import_module(name)',
    '    except BaseException:',
    '        missing.append(name)',
    'sys.stdout.write(json.dumps(missing))',
  ].join('\n');
  const result = runner(binary, ['-c', script, JSON.stringify(unique)], timeoutMs);
  if (result.error !== undefined || result.status !== 0) return unique;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) return unique;
    const missing = parsed.filter((item): item is string => typeof item === 'string');
    // 只回报输入里有的 id，顺序按输入；防御子进程多吐/乱吐。
    return unique.filter((id) => missing.includes(id));
  } catch {
    return unique;
  }
}
