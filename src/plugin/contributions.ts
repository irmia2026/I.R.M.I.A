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

export interface PluginToolEntry {
  readonly pluginId: string;
  readonly contentHash: string;
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly server: string;
  readonly tool: string;
}

const PLUGIN_TOOL_NAME = /^[a-z][a-z0-9_]{1,40}$/;
const PLUGIN_TOOLS_PER_PACKAGE = 8;
const PLUGIN_TOOLS_TOTAL = 12;
const PLUGIN_TOOL_NAME_MAX = 128;

export function composePluginTools(packages: readonly PluginPackage[]): { entries: PluginToolEntry[]; warnings: string[] } {
  const entries: PluginToolEntry[] = [];
  const warnings: string[] = [];
  const names = new Set<string>();
  for (const pkg of packages) {
    const declaration = pkg.manifest.contributions.tools;
    if (declaration === undefined) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(pkg.rootDir, declaration), 'utf8'));
    } catch (error) {
      warnings.push(`${pkg.manifest.id}: tools 声明读不动：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!Array.isArray(raw)) {
      warnings.push(`${pkg.manifest.id}: tools 声明必须是数组`);
      continue;
    }
    let accepted = 0;
    for (const item of raw) {
      if (accepted >= PLUGIN_TOOLS_PER_PACKAGE) {
        warnings.push(`${pkg.manifest.id}: 工具超过每插件 ${PLUGIN_TOOLS_PER_PACKAGE} 件上限，多余的忽略`);
        break;
      }
      if (entries.length >= PLUGIN_TOOLS_TOTAL) {
        warnings.push(`${pkg.manifest.id}: 工具超过全插件 ${PLUGIN_TOOLS_TOTAL} 件上限，多余的忽略`);
        break;
      }
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        warnings.push(`${pkg.manifest.id}: tools 里有一项不是对象`);
        continue;
      }
      const record = item as Record<string, unknown>;
      const local = typeof record['name'] === 'string' ? record['name'] : '';
      const description = typeof record['description'] === 'string' ? record['description'].trim() : '';
      const server = typeof record['server'] === 'string' ? record['server'] : '';
      const tool = typeof record['tool'] === 'string' ? record['tool'] : '';
      const parameters = record['inputSchema'];
      if (!PLUGIN_TOOL_NAME.test(local)) {
        warnings.push(`${pkg.manifest.id}: 工具名不合法（^[a-z][a-z0-9_]{1,40}$）：${JSON.stringify(local)}`);
        continue;
      }
      if (description === '') {
        warnings.push(`${pkg.manifest.id}: 工具 ${local} 没有描述`);
        continue;
      }
      if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
        warnings.push(`${pkg.manifest.id}: 工具 ${local} 的 inputSchema 必须是对象`);
        continue;
      }
      if (server === '' || tool === '') {
        warnings.push(`${pkg.manifest.id}: 工具 ${local} 缺 server/tool`);
        continue;
      }
      const name = `plugin__${pkg.manifest.id}__${local}`;
      if (name.length > PLUGIN_TOOL_NAME_MAX) {
        warnings.push(`${pkg.manifest.id}: 注册名过长（${name.length} > ${PLUGIN_TOOL_NAME_MAX}）：${name}`);
        continue;
      }
      if (names.has(name)) {
        warnings.push(`${pkg.manifest.id}: 工具名重复，后者忽略：${name}`);
        continue;
      }
      names.add(name);
      accepted += 1;
      entries.push(Object.freeze({
        pluginId: pkg.manifest.id,
        contentHash: pkg.contentHash,
        name,
        description,
        parameters: parameters as Record<string, unknown>,
        server,
        tool,
      }));
    }
  }
  return { entries, warnings };
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
