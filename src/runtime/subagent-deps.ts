import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

import { downloadWithNode, installZipDependency, type DepName } from '../deps/index.ts';
import { PIP_MIRROR_INDEX_URL, PIP_OFFICIAL_INDEX_URL } from '../deps/pip.ts';
import { binaryAvailable } from './subagent-binaries.ts';
import { probePythonModules } from './python-probe.ts';

/**
 * 大依赖只在用户点“安装/下载”时补：MinGit 从华为镜像取，tree-sitter 从 PyPI 镜像取。
 * npm 是小的那一类，随 Node 运行时入包，不在这里下载。
 */
export const GIT_MIRROR_URL =
  'https://mirrors.huaweicloud.com/git-for-windows/v2.53.0.windows.2/MinGit-2.53.0.2-64-bit.zip';

export const SUBAGENT_PYTHON_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  tree_sitter: 'tree-sitter',
  tree_sitter_javascript: 'tree-sitter-javascript',
  tree_sitter_typescript: 'tree-sitter-typescript',
  tree_sitter_go: 'tree-sitter-go',
  tree_sitter_rust: 'tree-sitter-rust',
  tree_sitter_java: 'tree-sitter-java',
  tree_sitter_c: 'tree-sitter-c',
  tree_sitter_cpp: 'tree-sitter-cpp',
});

export interface SubagentDependencyResult {
  ok: boolean;
  git: 'ready' | 'installed' | 'failed';
  python: 'ready' | 'installed' | 'failed';
  details: string[];
}

/** healthcheck / codegraph 共用的解释器选路：托管 Python 优先，避免装一处探另一处。 */
export function subagentPythonBinary(dataDir: string): string {
  const managed = join(dataDir, 'tools', 'python', 'python.exe');
  if (existsSync(managed)) return managed;
  const override = process.env['IRMIA_PYTHON']?.trim();
  if (override !== undefined && override !== '') return override;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function installGit(dataDir: string): Promise<{ ok: boolean; details: string[] }> {
  if (binaryAvailable('git', dataDir)) return Promise.resolve({ ok: true, details: ['git 已可用，跳过下载'] });
  return installZipDependency({
    name: 'git' as DepName,
    dataDir,
    pkg: {
      name: 'git' as DepName,
      url: GIT_MIRROR_URL,
      exeNames: ['git.exe'],
    },
    download: downloadWithNode,
    verify: async (exePath) => {
      const result = spawnSync(exePath, ['--version'], {
        shell: false, windowsHide: true, timeout: 15_000, encoding: 'utf8',
      });
      if (result.status !== 0) return null;
      const version = (typeof result.stdout === 'string' ? result.stdout : '').trim().replace(/^git version\s+/iu, '');
      return version === '' ? null : { version };
    },
  }).then((outcome) => {
    if (!outcome.ok) return { ok: false, details: [outcome.error] };
    const gitCmd = join(dirname(outcome.exePath));
    // 子代理 shell 继承父进程环境；把 MinGit 的 cmd/ 放到最前，命令里 `git` 才找得到。
    const path = process.env['PATH'] ?? process.env['Path'] ?? '';
    process.env['PATH'] = `${gitCmd}${delimiter}${path}`;
    return { ok: true, details: [`Git ${outcome.version} 已装到 ${join(dataDir, 'tools', 'git')}`] };
  }).catch((error: unknown) => ({
    ok: false,
    details: [error instanceof Error ? error.message : String(error)],
  }));
}

function installPython(modules: readonly string[], dataDir: string): { ok: boolean; details: string[] } {
  const packages = [...new Set(modules.map((module) => SUBAGENT_PYTHON_PACKAGES[module] ?? module))];
  if (packages.length === 0) return { ok: true, details: [] };
  const binary = subagentPythonBinary(dataDir);
  const result = spawnSync(binary, [
    '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', ...packages,
  ], {
    cwd: dataDir,
    shell: false,
    windowsHide: true,
    timeout: 900_000,
    encoding: 'utf8',
    env: {
      ...process.env,
      PIP_INDEX_URL: process.env.PIP_INDEX_URL ?? PIP_MIRROR_INDEX_URL,
      PIP_EXTRA_INDEX_URL: process.env.PIP_EXTRA_INDEX_URL ?? PIP_OFFICIAL_INDEX_URL,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tail = ((typeof result.stderr === 'string' ? result.stderr : '')
    || (typeof result.stdout === 'string' ? result.stdout : ''))
    .trim().split(/\r?\n/u).filter(Boolean).slice(-2).join(' | ');
  const details = [`python: ${binary}`, `packages: ${packages.join(', ')}`];
  if (result.error !== undefined) details.push(`error: ${result.error.message}`);
  if (tail !== '') details.push(`pip: ${tail}`);
  return { ok: result.status === 0 && result.error === undefined, details };
}

/** `subagent-install` 的后半段：只补该 Profile 声明、当前缺的依赖。 */
export async function installSubagentDependencies(
  requirements: { binaries?: readonly string[]; pythonModules?: readonly string[] } | undefined,
  dataDir: string,
): Promise<SubagentDependencyResult> {
  const details: string[] = [];
  const needsGit = requirements?.binaries?.includes('git') === true;
  const modules = requirements?.pythonModules ?? [];
  let git: SubagentDependencyResult['git'] = needsGit ? 'failed' : 'ready';
  let python: SubagentDependencyResult['python'] = modules.length > 0 ? 'failed' : 'ready';

  if (needsGit) {
    if (process.platform === 'linux') {
      git = binaryAvailable('git', dataDir) ? 'ready' : 'failed';
      if (git === 'failed') details.push('请用发行版包管理器安装 Git（Ubuntu：sudo apt install git）。');
    } else {
      const outcome = await installGit(dataDir);
      git = outcome.ok ? 'installed' : 'failed';
      details.push(...outcome.details);
    }
  }
  if (modules.length > 0) {
    if (process.platform === 'linux') {
      const missing = probePythonModules(modules);
      python = missing.length === 0 ? 'ready' : 'failed';
      if (python === 'failed') {
        details.push('请在独立虚拟环境中安装依赖并将 IRMIA_PYTHON 指向该解释器；缺少：'
          + missing.map(module => SUBAGENT_PYTHON_PACKAGES[module] ?? module).join(', '));
      }
    } else {
      const outcome = installPython(modules, dataDir);
      python = outcome.ok ? 'installed' : 'failed';
      details.push(...outcome.details);
    }
  }
  return { ok: git !== 'failed' && python !== 'failed', git, python, details };
}
