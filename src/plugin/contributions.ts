import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { loadHookConfig, type HookConfigEntry } from '../hook/hooks.ts';
import { parseMcpServers, type McpServerEntry } from '../mcp/client.ts';
import type { PluginPackage } from './package-store.ts';

export interface PluginSkillRoot { dir: string; rootName: string; packageHash: string }

export function composePluginSkillRoots(packages: readonly PluginPackage[]): PluginSkillRoot[] {
  return packages.flatMap((pkg) => pkg.manifest.contributions.skills.map((path) => ({
    dir: join(pkg.rootDir, path),
    rootName: relative(process.cwd(), join(pkg.rootDir, path)).split(sep).join('/'),
    packageHash: pkg.contentHash,
  })));
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function composePluginHooks(packages: readonly PluginPackage[]): { entries: HookConfigEntry[]; warnings: string[] } {
  const entries: HookConfigEntry[] = [];
  const warnings: string[] = [];
  for (const pkg of packages) {
    const declaration = pkg.manifest.contributions.hooks;
    if (declaration === undefined) continue;
    const loaded = loadHookConfig(join(pkg.rootDir, declaration));
    // 声明的文件读不到是**配置错误**，不是「没配钩子」：loadHookConfig 对缺文件返回
    // exists: false 且不给 problem（那条语义要留给内置的可选配置，改它会误报），插件侧
    // 必须自己补一条，否则显式声明的钩子会静默消失，只剩「明明写了却没生效」的现象。
    if (!loaded.exists) warnings.push(`${pkg.manifest.id}: 插件显式声明的 Hook 文件不存在或不可读：${declaration}`);
    warnings.push(...loaded.problems.map((problem) => `${pkg.manifest.id}: ${problem}`));
    loaded.entries.forEach((entry, index) => {
      // 停用条目留在声明里但不装配：与内置 Hook 的 enabled 语义（见 main.ts 装配处）一致
      if (entry.enabled === false) return;
      const cwd = entry.cwd === undefined ? pkg.rootDir : resolve(pkg.rootDir, entry.cwd);
      if (!inside(pkg.rootDir, cwd)) {
        warnings.push(`${pkg.manifest.id}: Hook cwd escapes the package: ${entry.cwd}`);
        return;
      }
      // 身份必须唯一到「一条声明」：同一个 hook+matcher 可以合法地出现多条（同一执行点挂
      // 两条不同 command 的钩子）。只用 `hook:matcher` 会让它们共享熔断计数与探针身份——
      // 一条坏掉进隔离后，另一条健康的一次成功就能把整包「恢复」。序号取本条在已解析条目里
      // 的位置（与文件顺序一致），并且在 `enabled: false` 过滤**之前**就定下来——否则把邻居
      // 停用一下就会改掉这一条的身份，刚隔离的贡献立刻对不上号。包由内容哈希寻址、不可变，
      // 所以序号对同一份包恒定。
      entries.push({ ...entry, cwd, plugin: { id: pkg.manifest.id, contentHash: pkg.contentHash, contributionName: `${entry.hook}:${entry.matcher}#${index}` } });
    });
  }
  return { entries, warnings };
}

export function composePluginMcp(packages: readonly PluginPackage[], extraLaunchers?: readonly string[]): { servers: McpServerEntry[]; warnings: string[] } {
  const servers: McpServerEntry[] = [];
  const warnings: string[] = [];
  const names = new Set<string>();
  for (const pkg of packages) {
    const declaration = pkg.manifest.contributions.mcp;
    if (declaration === undefined) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(pkg.rootDir, declaration), 'utf8'));
    } catch (error) {
      warnings.push(`${pkg.manifest.id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!Array.isArray(raw)) {
      warnings.push(`${pkg.manifest.id}: MCP declaration must be an array`);
      continue;
    }
    const parsed: McpServerEntry[] = [];
    raw.forEach((item, index) => {
      try {
        parsed.push(...parseMcpServers([item], `${pkg.manifest.id}.mcp[${index}]`, extraLaunchers));
      } catch (error) {
        warnings.push(`${pkg.manifest.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    for (const entry of parsed) {
      const name = `${pkg.manifest.id}__${entry.name}`;
      if (name.length > 128) {
        warnings.push(`${pkg.manifest.id}: MCP name exceeds 128 characters: ${name}`);
        continue;
      }
      if (names.has(name)) {
        warnings.push(`${pkg.manifest.id}: duplicate MCP name ${name}; later declaration ignored`);
        continue;
      }
      const cwd = entry.cwd === undefined ? pkg.rootDir : resolve(pkg.rootDir, entry.cwd);
      if (!inside(pkg.rootDir, cwd)) {
        warnings.push(`${pkg.manifest.id}: MCP cwd escapes the package: ${entry.cwd}`);
        continue;
      }
      names.add(name);
      servers.push({ ...entry, name, cwd });
    }
  }
  return { servers, warnings };
}
