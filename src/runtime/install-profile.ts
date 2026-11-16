import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

import type { AppConfig } from '../config/config.ts';
import type { DepsManager } from '../deps/manager.ts';
import { PIP_MIRROR_INDEX_URL, PIP_OFFICIAL_INDEX_URL } from '../deps/pip.ts';

/**
 * 安装器只负责把文件铺好；真正需要 Python 包的组件，由后端首次启动时消费
 * `install-profile.json`：
 *
 *   office   → 确保托管 Python，安装 profile 里列出的包，并做一次 import 检查
 *   deskhand → 安装安装器指定的 GitHub 归档，写入一条默认 disabled 的 MCP 声明
 *
 * 这不是模型工具，也不自动下载附件。它只把安装器勾选的能力真正落地；
 * 失败会写回 profile 的状态，下一次启动可重试。
 */

export interface FirstRunCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type FirstRunRunner = (
  exe: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<FirstRunCommandResult>;

export interface ApplyInstallProfileOptions {
  dataDir: string;
  configPath: string;
  config: AppConfig;
  deps: Pick<DepsManager, 'managedDir' | 'install'> & {
    /** 与 pwsh 的 Python 解析同一份结论；测试可省略。 */
    get?: (name: 'python') => Promise<{ path: string }>;
  };
  write?: (line: string) => void;
  run?: FirstRunRunner;
  now?: () => string;
}

export interface ApplyInstallProfileResult {
  found: boolean;
  applied: boolean;
  office: 'skipped' | 'ready' | 'failed';
  deskhand: 'skipped' | 'ready' | 'failed';
  errors: string[];
}

const OFFICE_IMPORTS = ['docx', 'openpyxl', 'reportlab', 'PIL', 'lxml', 'pdfplumber', 'pikepdf', 'pypdfium2'];
const DESKHAND_FALLBACK =
  'deskhand-mcp[all] @ https://github.com/irmia2026/deskhand-mcp/archive/a7c24ae.zip';
/** 上游 pyproject 漏了 httpx；deskhand_mcp.engine.vl 会直接 import 它。 */
const DESKHAND_EXTRA_REQUIREMENTS = ['httpx'];

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
}

function writeAtomic(path: string, value: unknown): void {
  const temp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

const defaultRunner: FirstRunRunner = (exe, args, options) => new Promise((resolve) => {
  const child = spawn(exe, [...args], {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const timer = setTimeout(() => {
    child.kill();
    resolve({ code: -1, stdout, stderr: `${stderr}\n命令超时` });
  }, options.timeoutMs);
  child.on('error', (error) => {
    clearTimeout(timer);
    resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve({ code: code ?? -1, stdout, stderr });
  });
});

/**
 * 读取并执行安装器留下的 profile。返回值只用于日志/诊断；不抛启动失败。
 */
export async function applyInstallProfile(
  options: ApplyInstallProfileOptions,
): Promise<ApplyInstallProfileResult> {
  const profilePath = join(dirname(options.configPath), 'install-profile.json');
  if (!existsSync(profilePath)) {
    return { found: false, applied: false, office: 'skipped', deskhand: 'skipped', errors: [] };
  }
  let doc: Record<string, unknown>;
  try {
    doc = record(JSON.parse(readFileSync(profilePath, 'utf8')));
  } catch (error) {
    return {
      found: true, applied: false, office: 'skipped', deskhand: 'skipped',
      errors: [`install-profile.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const components = strings(doc['components']);
  const office = record(doc['office']);
  const deps = record(doc['deps']);
  const mcpPresets = record(doc['mcpPresets']);
  // 已完成的 profile 不每次启动都重跑 pip；安装器覆盖 profile 时会把 appliedAt 写回 null。
  if (typeof doc['appliedAt'] === 'string' && doc['appliedAt'] !== '') {
    return { found: true, applied: true, office: 'skipped', deskhand: 'skipped', errors: [] };
  }
  const officeSelected = components.includes('office') && (office['installOnFirstRun'] !== false);
  const deskhandSelected = components.includes('deskhand');
  if (!officeSelected && !deskhandSelected) {
    if (doc['appliedAt'] === null || doc['appliedAt'] === undefined) {
      doc['appliedAt'] = (options.now ?? (() => new Date().toISOString()))();
      try { writeAtomic(profilePath, doc); } catch { /* status write is best-effort */ }
    }
    return { found: true, applied: false, office: 'skipped', deskhand: 'skipped', errors: [] };
  }

  const write = options.write ?? (() => undefined);
  const run = options.run ?? defaultRunner;
  const pipEnv = {
    ...process.env,
    PIP_INDEX_URL: process.env.PIP_INDEX_URL ?? PIP_MIRROR_INDEX_URL,
    PIP_EXTRA_INDEX_URL: process.env.PIP_EXTRA_INDEX_URL ?? PIP_OFFICIAL_INDEX_URL,
  };
  const errors: string[] = [];
  let officeState: ApplyInstallProfileResult['office'] = officeSelected ? 'failed' : 'skipped';
  let deskhandState: ApplyInstallProfileResult['deskhand'] = deskhandSelected ? 'failed' : 'skipped';

  const managedPython = join(options.deps.managedDir('python'), 'python.exe');
  let python = '';
  // 用与 pwsh 相同的 Python 结论：PATH 上已有解释器时就把包装到那一份，
  // 否则才安装托管 Python。只装托管却不看工具实际用哪一份，会让 office 看似装好、实际 import 不到。
  if (options.deps.get !== undefined) {
    try {
      const current = await options.deps.get('python');
      if (current.path.trim() !== '') python = current.path.trim();
    } catch { /* fall through to managed */ }
  }
  if (python === '' && existsSync(managedPython)) python = managedPython;
  if (python === '') {
    write('[安装配置] 没有可用 Python，开始安装托管 Python');
    const installed = await options.deps.install('python');
    if (installed.ok && installed.exePath !== '') python = installed.exePath;
    if (python === '' || !existsSync(python)) {
      errors.push('office/deskhand 需要 Python，安装失败');
      write(`[安装配置] ${errors.at(-1)}`);
    }
  }

  if (python !== '' && officeSelected) {
    const packages = strings(office['pythonPackages'] ?? deps['pythonPackages']);
    if (packages.length === 0) {
      errors.push('office 未列出 pythonPackages');
    } else {
      const args = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', ...packages];
      write(`[安装配置] 安装 Office Python 包：${packages.join(' / ')}`);
      const result = await run(python, args, {
        cwd: dirname(profilePath),
        env: pipEnv,
        timeoutMs: 1_800_000,
      });
      if (result.code !== 0) {
        errors.push(`office pip install 失败（exit ${result.code}）`);
        write(`[安装配置] ${errors.at(-1)}${result.stderr.trim() === '' ? '' : `：${result.stderr.trim().split(/\r?\n/u).at(-1)}`}`);
      } else {
        const check = await run(python, ['-c', `import ${OFFICE_IMPORTS.join(', ')}`], {
          cwd: dirname(profilePath),
          env: pipEnv,
          timeoutMs: 60_000,
        });
        if (check.code !== 0) {
          errors.push('office 包已安装但 import 检查失败');
          write(`[安装配置] ${errors.at(-1)}`);
        } else {
          officeState = 'ready';
          write('[安装配置] Office Python 包已安装并通过 import 检查');
        }
      }
    }
  }

  if (python !== '' && deskhandSelected) {
    const preset = record(mcpPresets['deskhand']);
    const installArgs = strings(preset['installArgs']);
    const requirement = typeof preset['installRequirement'] === 'string' && preset['installRequirement'].trim() !== ''
      ? preset['installRequirement'].trim()
      : DESKHAND_FALLBACK;
    const args = installArgs.length > 0
      ? installArgs
      : ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', requirement];
    for (const extra of DESKHAND_EXTRA_REQUIREMENTS) {
      if (!args.includes(extra)) args.push(extra);
    }
    write('[安装配置] 安装 deskhand-mcp（含 httpx）');
    const result = await run(python, args, {
      cwd: dirname(profilePath),
      env: pipEnv,
      timeoutMs: 1_800_000,
    });
    if (result.code !== 0) {
      errors.push(`deskhand pip install 失败（exit ${result.code}）`);
      write(`[安装配置] ${errors.at(-1)}`);
    } else {
      const check = await run(python, ['-c', 'import deskhand_mcp.server; import httpx'], {
        cwd: dirname(profilePath),
        env: pipEnv,
        timeoutMs: 60_000,
      });
      if (check.code !== 0) {
        errors.push('deskhand 已安装但 import 检查失败（可能缺 httpx）');
        write(`[安装配置] ${errors.at(-1)}`);
      } else {
        try {
          const configDoc = record(JSON.parse(readFileSync(options.configPath, 'utf8')));
          const mcp = record(configDoc['mcp']);
          const servers = Array.isArray(mcp['servers']) ? mcp['servers'] as Array<Record<string, unknown>> : [];
          if (!servers.some((server) => server['name'] === 'deskhand')) {
            servers.push({
              name: 'deskhand',
              command: python,
              args: ['-m', 'deskhand_mcp.server'],
              env: { DESKHAND_DATA_DIR: join(options.dataDir, 'mcp', 'deskhand') },
              disabled: preset['enabledByDefault'] !== true,
            });
            mcp['servers'] = servers;
            configDoc['mcp'] = mcp;
            writeAtomic(options.configPath, configDoc);
            options.config.mcp.servers = servers as unknown as AppConfig['mcp']['servers'];
          }
          deskhandState = 'ready';
          write('[安装配置] deskhand 已安装并通过 import 检查；MCP 声明已写入，默认 disabled，需在扩展页启用');
        } catch (error) {
          errors.push(`deskhand 已安装但写 MCP 配置失败：${error instanceof Error ? error.message : String(error)}`);
          write(`[安装配置] ${errors.at(-1)}`);
        }
      }
    }
  }

  const applied = errors.length === 0;
  const attemptedAt = (options.now ?? (() => new Date().toISOString()))();
  doc['bootstrap'] = {
    attemptedAt,
    office: officeState,
    deskhand: deskhandState,
    errors,
  };
  if (applied) doc['appliedAt'] = attemptedAt;
  try { writeAtomic(profilePath, doc); } catch { /* status write is best-effort */ }
  return {
    found: true,
    applied,
    office: officeState,
    deskhand: deskhandState,
    errors,
  };
}
