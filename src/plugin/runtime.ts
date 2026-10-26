import { createHash } from 'node:crypto';

import type { HookConfigEntry } from '../hook/hooks.js';
import type { McpServerEntry } from '../mcp/client.js';
import { composePluginHooks, composePluginMcp, composePluginSkillRoots, type PluginSkillRoot } from './contributions.ts';
import type { PluginManager } from './manager.ts';
import { compareCodePoint, pluginPackagesRoot, type PluginPackage } from './package-store.ts';

export interface PluginRuntimeComposition {
  packages: PluginPackage[];
  /**
   * 组合摘要：只由「启用了哪些 `id@hash`」决定，任何一个插件的启停/换版都换新值。
   *
   * 消费方是**常驻索引的失效判据**（`RealLoop.mcpIndexSync`）：MCP 索引原先只按
   * `RENDER_VERSION` 与压缩代次判断该不该重建，于是「插件撤走了一个 server」这种
   * **执行面已经变了、索引却还是旧字节**的情形没有任何判据能发现——模型会对着一个
   * 池里已不能调用的 server 名反复发起调用。把「组合变了」变成一个可比较的值，
   * 就和技能索引那一支的 `SkillManager.packageRevision` 对齐了。
   *
   * 为什么是摘要而不是递增计数：宿主重启后计数会归零，而摘要对同一份组合恒等。
   */
  revision: string;
  skillRoots: PluginSkillRoot[];
  hookEntries: HookConfigEntry[];
  mcpServers: McpServerEntry[];
  warnings: string[];
}

/**
 * 组合摘要：按码点序折 `id@contentHash`，与 locale/ICU 版本无关。
 *
 * 用长度前缀而不是换行分隔：`id`/`hash` 的字符集虽然已经受限，但摘要函数不该
 * 依赖「值里不含分隔符」这条隐含约定——长度前缀对任意输入都无歧义。
 */
export function pluginCompositionRevision(packages: readonly PluginPackage[]): string {
  const hash = createHash('sha256');
  for (const pkg of [...packages].sort((a, b) => compareCodePoint(a.manifest.id, b.manifest.id) || compareCodePoint(a.contentHash, b.contentHash))) {
    hash.update(`${pkg.manifest.id.length}:${pkg.manifest.id}@${pkg.contentHash.length}:${pkg.contentHash}`);
  }
  return hash.digest('hex');
}

export function composePluginRuntime(manager: PluginManager, extraLaunchers?: readonly string[]): PluginRuntimeComposition {
  const packages = manager.active();
  const hooks = composePluginHooks(packages);
  const hookProbes = manager.hookProbes().flatMap((pkg) => {
    const circuit = manager.list().find((view) => view.package.manifest.id === pkg.manifest.id
      && view.package.contentHash === pkg.contentHash)?.circuit;
    if (circuit?.contributionKind !== 'hook') return [];
    const composed = composePluginHooks([pkg]);
    return composed.entries.filter((entry) => entry.plugin?.contributionName === circuit.contributionName);
  });
  const mcp = composePluginMcp(packages, extraLaunchers);
  return {
    packages,
    revision: pluginCompositionRevision(packages),
    skillRoots: composePluginSkillRoots(packages),
    hookEntries: [...hooks.entries, ...hookProbes],
    mcpServers: mcp.servers,
    warnings: [...manager.list().flatMap((view) => view.problems), ...hooks.warnings, ...mcp.warnings],
  };
}

export function mergeMcpDeclarations(configServers: readonly McpServerEntry[], pluginServers: readonly McpServerEntry[]): McpServerEntry[] {
  const merged = [...configServers, ...pluginServers];
  const names = new Set<string>();
  for (const entry of merged) {
    if (names.has(entry.name)) throw new Error(`Duplicate MCP declaration name: ${entry.name}`);
    names.add(entry.name);
  }
  return merged;
}

export function mapPluginMcpOwners(
  configServers: readonly McpServerEntry[],
  packages: readonly PluginPackage[],
  extraLaunchers?: readonly string[],
): Map<string, { pluginId: string; contentHash: string }> {
  const composed = composePluginMcp(packages, extraLaunchers);
  try {
    mergeMcpDeclarations(configServers, composed.servers);
  } catch {
    return new Map();
  }
  const accepted = new Set(composed.servers.map((server) => server.name));
  const owners = new Map<string, { pluginId: string; contentHash: string }>();
  for (const pkg of packages) {
    for (const server of composePluginMcp([pkg], extraLaunchers).servers) {
      if (accepted.has(server.name) && !owners.has(server.name)) {
        owners.set(server.name, { pluginId: pkg.manifest.id, contentHash: pkg.contentHash });
      }
    }
  }
  return owners;
}

export function pluginProtectedPaths(dataDir: string): string[] {
  return [pluginPackagesRoot(dataDir)];
}
