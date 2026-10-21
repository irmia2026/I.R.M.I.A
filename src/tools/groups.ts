/**
 * Irmia Agent — 工具分组（供 GUI 与 Web 的工具开关页用）
 *
 * 分组维度只有一个：**这件工具从哪儿来**。
 *   • 内置工具：随程序一起来的，归一个「内置工具」组；
 *   • MCP 工具：按各自的服务分组，组名就是服务名（`mcp__{server}__{tool}` → `<server>`）。
 *
 * 不按功能细分是刻意的：功能分类要维护一张「哪件工具属于哪一类」的表，而那张表既不影响
 * 运行时语义（谁能碰什么由执行器与路径守卫决定，design §4.10），又会在每加一件工具时过期。
 * 来源是唯一不用维护的维度——名字里写着。
 */

import { MCP_NAME_PREFIX } from '../mcp/client.ts';

export interface ToolGroup {
  id: string;
  label: string;
  note: string;
}

export const BUILTIN_GROUP_ID = 'builtin';

export const BUILTIN_GROUP: ToolGroup = {
  id: BUILTIN_GROUP_ID,
  label: '内置工具',
  note: '随程序一起来的工具；关掉即从她的清单里拿掉，下一轮就不会再出现。',
};

/** MCP 工具名 → 服务名；不是 MCP 工具返回 null */
export function mcpServerOfTool(name: string): string | null {
  if (!name.startsWith(MCP_NAME_PREFIX)) return null;
  const rest = name.slice(MCP_NAME_PREFIX.length);
  const separator = rest.indexOf('__');
  return separator <= 0 ? null : rest.slice(0, separator);
}

/** 分组 id：MCP 服务用 `mcp:<server>`，与工具名同源（不另立一张映射表） */
export function mcpGroupId(server: string): string {
  return `mcp:${server}`;
}

export function mcpGroup(server: string): ToolGroup {
  return {
    id: mcpGroupId(server),
    label: server,
    note: `来自 MCP 服务 ${server} 的工具；服务连不上时这一组会整组消失。`,
  };
}

/** 工具名 → 分组 id（内置工具恒为 BUILTIN_GROUP_ID） */
export function groupIdOfTool(name: string): string {
  const server = mcpServerOfTool(name);
  return server === null ? BUILTIN_GROUP_ID : mcpGroupId(server);
}

/**
 * 按现有工具名清单聚合出分组：内置在前，MCP 按首次出现顺序。
 * 界面直接照它摆——没有的工具组不会空摆一个标题（MCP 没接上就没有那一组）。
 */
export function groupsForTools(names: readonly string[]): ToolGroup[] {
  const servers: string[] = [];
  const seen = new Set<string>();
  let hasBuiltin = false;
  for (const name of names) {
    const server = mcpServerOfTool(name);
    if (server === null) {
      hasBuiltin = true;
      continue;
    }
    if (seen.has(server)) continue;
    seen.add(server);
    servers.push(server);
  }
  return [...(hasBuiltin ? [BUILTIN_GROUP] : []), ...servers.map(mcpGroup)];
}
