import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { assertPathAllowed } from './subagent-workspace.ts';
import { probePythonModules } from './python-probe.ts';

import type { DsClient } from '../model/ds-client.js';
import { SubagentMcpRuntime, type SubagentMcpOptions } from './subagent-mcp.ts';
import { SubagentSkillRuntime } from './subagent-skills.ts';
import { npmCliPath, readRolePackageRecords, verifyRolePackage } from './subagent-packages.ts';
import type {
  ProfileAvailability, SubagentProfile, SubagentProfileRegistry,
} from './subagent-profiles.ts';
import type { SubagentModelCapabilities } from './subagent-manager.js';

export interface SubagentHealthOptions {
  dataDir: string;
  ds: DsClient;
  modelCapabilities?: SubagentModelCapabilities | undefined;
  projectRoots?: readonly string[] | undefined;
  mcpPoolFactory?: SubagentMcpOptions['poolFactory'] | undefined;
  binaryCheck?: ((id: string) => boolean) | undefined;
  /**
   * Python 模块探测注入（测试用）：返回**缺失**模块 id 列表。
   * 生产缺省走 `probePythonModules`（真 spawn 解释器逐模块 import）。
   */
  pythonModulesCheck?: ((modules: readonly string[]) => readonly string[]) | undefined;
}

export async function healthcheckSubagentProfile(
  profile: SubagentProfile,
  registry: SubagentProfileRegistry,
  options: SubagentHealthOptions,
): Promise<ProfileAvailability> {
  if (profile.id === 'general') return {available: true, locked: false, missing: []};
  const base = registry.availability(profile);
  if (profile.install !== undefined && !registry.isRolePackageInstalled(profile.id)) return base;
  const binaries = new Set(profile.requires?.binaries ?? []);
  const missing = base.missing.filter((id) => !binaries.has(id));
  if (missing.length > 0) return {available: false, locked: true, missing};
  if (profile.install !== undefined) {
    const record = readRolePackageRecords(options.dataDir).find((item) => item.id === profile.id);
    if (record === undefined || !verifyRolePackage(options.dataDir, record)
      || !sameSources(profile.install, record.sources)) missing.push('package-integrity');
  }
  if (missing.length > 0) return {available: false, locked: true, missing};
  try {
    const skills = new SubagentSkillRuntime(options.dataDir, profile.id, profile.skills);
    missing.push(...skills.missing);
  } catch {
    missing.push(...profile.skills);
  }
  if (missing.length > 0) return {available: false, locked: true, missing: [...new Set(missing)]};
  const skills = new SubagentSkillRuntime(options.dataDir, profile.id, profile.skills);
  missing.push(...checkExecutableSkills(skills));
  if (missing.length > 0) return {available: false, locked: true, missing: [...new Set(missing)]};
  const binaryCheck = options.binaryCheck ?? binaryAvailable;
  for (const id of profile.requires?.binaries ?? []) {
    let ok = false;
    try { ok = binaryCheck(id); } catch { ok = false; }
    if (!ok) missing.push(id);
  }
  // Python 模块依赖（worker 的 codegraph）：必须逐个真 import，缺一个即 locked。
  // 放在二进制检查之后、模型检查之前：bash/PATH 类缺项先报，避免让用户以为问题在模型上。
  const pythonModules = profile.requires?.pythonModules ?? [];
  if (pythonModules.length > 0) {
    let missingModules: readonly string[];
    try {
      missingModules = options.pythonModulesCheck !== undefined
        ? options.pythonModulesCheck(pythonModules)
        : probePythonModules(pythonModules);
    } catch {
      missingModules = pythonModules;
    }
    for (const id of missingModules) if (!missing.includes(id)) missing.push(id);
  }
  const capabilities = options.modelCapabilities ?? knownModelCapabilities(options.ds);
  if (!capabilities.reasoningEfforts.includes(profile.reasoningEffort)
    || capabilities.contextLimit === null || profile.contextLimit > capabilities.contextLimit) {
    missing.push('model:heavy');
  }
  if (missing.length === 0 && profile.mcpServers.length > 0) {
    const project = profile.workdir === 'workspace' ? options.dataDir
      : options.projectRoots?.[0] ?? process.cwd();
    const runtime = new SubagentMcpRuntime({
      dataDir: options.dataDir, profileId: profile.id, agentId: `health-${profile.id}`,
      servers: profile.mcpServers, roots: [project], defaultRoot: project,
      ...(options.mcpPoolFactory === undefined ? {} : {poolFactory: options.mcpPoolFactory}),
    });
    try {
      await runtime.start();
      for (const id of profile.mcpServers) if (runtime.toolCountFor(id) === 0) missing.push(id);
    } catch {
      missing.push(...profile.mcpServers);
    } finally {
      await runtime.shutdown();
    }
  }
  const unique = [...new Set(missing)];
  return {available: unique.length === 0, locked: unique.length > 0, missing: unique};
}

/**
 * 已知模型的能力面（只认**在仓库里有依据**的型号）：
 *
 *   · `deepseek-v4-pro`：1M 上下文、low/high/max（P4.2 起按它做默认档）；
 *   · `deepseek-flash`：官方“模型细节”写明上下文 1M token、输出最长 384K
 *     （见 `src/model/render.ts` 的 reasoning-echo 上限推导与 `docs/context-management-audit.md`），
 *     思考档同样是 DeepSeek 的 `none/low/high/max` 枚举（`docs/design-protocol-fallback.md`）。
 *     生产 `config.json` 的 heavy 就落在它上面，不认它会让角色包在装包后仍以 `model:heavy` 锁定。
 *
 * 其它型号不猜：返回 `contextLimit: null` + 空档位 ⇒ 健康检查如实报 `model:heavy`，保持 locked。
 * 要接新 provider 就给 manager 注入 `modelCapabilities`（P4.2 的既有口子），不要往这里塞猜测。
 */
export function knownModelCapabilities(ds: DsClient): SubagentModelCapabilities {
  const model = typeof ds.modelFor === 'function' ? ds.modelFor('heavy') : '';
  if (model === 'deepseek-v4-pro' || model === 'deepseek-flash') {
    return {contextLimit: 1_000_000, reasoningEfforts: ['low', 'medium', 'high', 'max']};
  }
  return {contextLimit: null, reasoningEfforts: []};
}

function binaryAvailable(id: string): boolean {
  if (!/^[A-Za-z0-9._-]+$/u.test(id)) return false;
  // `node` / `npm` 用当前进程自己的 node：安装版后端的 PATH 不保证有 node.exe
  //（它的运行时就住在 `<安装根>\runtime\node`，且不带 npm），但 process.execPath 一定对。
  if (id === 'node' || id === 'npm') {
    const args = id === 'node' ? ['--version'] : [npmCliPath(), '--version'];
    const result = spawnSync(process.execPath, args, {
      shell: false, windowsHide: true, timeout: 5_000, encoding: 'utf8',
    });
    return result.status === 0;
  }
  const result = spawnSync(id, ['--version'], {
    shell: false, windowsHide: true, timeout: 5_000, encoding: 'utf8',
  });
  return result.status === 0;
}

function checkExecutableSkills(skills: SubagentSkillRuntime): string[] {
  const failed: string[] = [];
  for (const entry of skills.entries) {
    const file = join(entry.root, 'health.json');
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as {scripts?: unknown};
      if (!Array.isArray(raw.scripts) || raw.scripts.length > 8) throw new Error('health-scripts-invalid');
      for (const script of raw.scripts) {
        if (typeof script !== 'object' || script === null) throw new Error('health-script-invalid');
        const row = script as {command?: unknown; path?: unknown};
        if ((row.command !== 'node' && row.command !== 'python') || typeof row.path !== 'string') {
          throw new Error('health-script-denied');
        }
        assertPathAllowed(row.path, [entry.root], entry.root);
        const result = spawnSync(row.command, [resolve(entry.root, row.path)], {
          cwd: entry.root, shell: false, windowsHide: true, timeout: 5_000,
          env: {
            PATH: process.env['PATH'] ?? process.env['Path'] ?? '',
            ...(process.env['SystemRoot'] === undefined ? {} : {SystemRoot: process.env['SystemRoot']}),
            ...(process.env['TEMP'] === undefined ? {} : {TEMP: process.env['TEMP']}),
            ...(process.env['TMP'] === undefined ? {} : {TMP: process.env['TMP']}),
          },
        });
        if (result.status !== 0) throw new Error('health-script-failed');
      }
    } catch {
      failed.push(entry.id);
    }
  }
  return [...new Set(failed)];
}

function sameSources(
  expected: readonly {source: string; ref?: string; sha256?: string}[],
  actual: readonly {source: string; ref?: string; sha256?: string}[],
): boolean {
  const key = (row: {source: string; ref?: string; sha256?: string}): string => `${row.source}\0${row.ref ?? ''}\0${row.sha256 ?? ''}`;
  return expected.length === actual.length
    && expected.map(key).sort().every((value, index) => value === actual.map(key).sort()[index]);
}
