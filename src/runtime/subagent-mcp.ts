import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClientPool, type McpServerEntry, type McpToolInfo } from '../mcp/client.ts';
import { checkStdioLauncher } from '../mcp/launcher-guard.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { errorResult, type ToolDefinition, type ToolHandlerResult } from '../tools/types.ts';
import { assertPathAllowed, assertToolArgumentsAllowed } from './subagent-workspace.ts';

export const CURATED_SUBAGENT_MCP = ['serena', 'playwright', 'markitdown'] as const;
export type CuratedSubagentMcp = (typeof CURATED_SUBAGENT_MCP)[number];

export interface SubagentMcpPool {
  listTools(server: string, options: {requireConnected?: boolean; timeoutMs?: number}): Promise<McpToolInfo[]>;
  callTool(server: string, tool: string, args: unknown, options?: {signal?: AbortSignal; timeoutMs?: number}): Promise<ToolHandlerResult>;
  shutdown(): Promise<unknown>;
}

export interface SubagentMcpOptions {
  dataDir: string;
  profileId: string;
  agentId: string;
  servers: readonly string[];
  roots: readonly string[];
  defaultRoot: string;
  emit?: ((data: Record<string, unknown>) => void) | undefined;
  poolFactory?: ((entries: readonly McpServerEntry[], emit: (type: string, data: unknown) => void) => SubagentMcpPool) | undefined;
}

export class SubagentMcpRuntime {
  private readonly options: SubagentMcpOptions;
  private pool: SubagentMcpPool | null = null;
  private tools: Array<{server: CuratedSubagentMcp; tool: McpToolInfo}> = [];

  constructor(options: SubagentMcpOptions) {
    this.options = options;
  }

  get toolCount(): number {
    return this.tools.length;
  }

  toolCountFor(server: string): number {
    return this.tools.filter((item) => item.server === server).length;
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.options.servers.length === 0) return;
    const entries: McpServerEntry[] = [];
    for (const id of this.options.servers) {
      if (!CURATED_SUBAGENT_MCP.includes(id as CuratedSubagentMcp)) throw new Error('mcp-not-curated');
      const file = resolve(this.options.dataDir, 'subagents', 'packs', this.options.profileId, 'mcp', `${id}.json`);
      let entry: McpServerEntry;
      try {
        entry = JSON.parse(readFileSync(file, 'utf8')) as McpServerEntry;
      } catch {
        throw new Error(`mcp-declaration-missing:${id}`);
      }
      const expectedCommand = id === 'playwright' ? 'node' : 'uvx';
      if (entry.name !== id || entry.disabled === true || entry.command !== expectedCommand
        || (entry.args !== undefined && !entry.args.every((arg) => typeof arg === 'string'))) {
        throw new Error(`mcp-declaration-invalid:${id}`);
      }
      const pack = resolve(this.options.dataDir, 'subagents', 'packs', this.options.profileId);
      const workspace = this.options.roots[this.options.roots.length - 1] ?? this.options.defaultRoot;
      const expand = (value: string): string => value.replaceAll('{pack}', pack)
        .replaceAll('{project}', this.options.defaultRoot).replaceAll('{workspace}', workspace);
      entry = {
        ...entry,
        inheritEnv: false,
        ...(entry.args === undefined ? {} : {args: entry.args.map(expand)}),
        ...(entry.cwd === undefined ? {} : {cwd: expand(entry.cwd)}),
      };
      if (entry.cwd !== undefined) assertPathAllowed(entry.cwd, this.options.roots, this.options.defaultRoot);
      const launcherIssue = checkStdioLauncher(entry.command, entry.args, entry.env);
      if (launcherIssue !== null) throw new Error(`mcp-launcher-denied:${id}`);
      entries.push(entry);
    }
    const emit = (type: string, data: unknown): void => {
      const row = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {};
      this.options.emit?.({
        action: 'lifecycle', type,
        server: String(row['serverName'] ?? row['name'] ?? ''),
        ...(typeof row['reason'] === 'string' ? {reason: row['reason']} : {}),
      });
    };
    this.pool = this.options.poolFactory?.(entries, emit) ?? new McpClientPool({
      servers: entries, emit, dataDir: this.options.dataDir, toolsCache: false, rssSample: false,
    });
    try {
      for (const entry of entries) {
        const server = entry.name as CuratedSubagentMcp;
        const listed = await abortable(this.pool.listTools(server, {requireConnected: true}), signal);
        for (const tool of listed) {
          if (toolAllowed(server, tool.name)) this.tools.push({server, tool});
        }
        this.options.emit?.({action: 'tools-listed', server, listed: listed.length, granted: this.tools.filter((item) => item.server === server).length});
      }
    } catch (error) {
      await this.pool.shutdown();
      this.pool = null;
      throw error;
    }
  }

  registerTools(registry: ToolRegistry): void {
    for (const {server, tool} of this.tools) {
      const name = `mcp__${server}__${tool.name}`;
      if (name.length > 64 || /\s/u.test(name)) continue;
      const parameters = typeof tool.inputSchema === 'object' && tool.inputSchema !== null && !Array.isArray(tool.inputSchema)
        ? tool.inputSchema as Record<string, unknown>
        : {type: 'object', properties: {}, additionalProperties: true};
      const definition: ToolDefinition = {
        name,
        description: String(tool.description ?? `${server} ${tool.name}`).slice(0, 600),
        parameters,
        ...(typeof tool.outputSchema === 'object' && tool.outputSchema !== null && !Array.isArray(tool.outputSchema)
          ? {outputSchema: tool.outputSchema as Record<string, unknown>} : {}),
        executionMode: 'exclusive',
        sideEffect: server === 'serena' ? 'destructive' : 'idempotent',
        timeoutMs: 120_000,
        handler: async (args, ctx) => {
          const denied = this.guardArguments(server, tool.name, args);
          if (denied !== null) return denied;
          const result = await this.pool?.callTool(server, tool.name, args, {signal: ctx.signal, timeoutMs: 120_000})
            ?? errorResult('MCP 会话已关闭。', 'mcp-session-closed');
          this.options.emit?.({
            action: 'tool-called', server, tool: tool.name, ok: result.isError !== true,
            ...(result.error?.code === undefined ? {} : {errorCode: result.error.code}),
          });
          return result;
        },
      };
      try {
        registry.register(definition);
      } catch (error) {
        this.options.emit?.({action: 'tool-rejected', server, tool: tool.name, reason: error instanceof Error ? error.message : String(error)});
      }
    }
  }

  async shutdown(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    if (pool !== null) await pool.shutdown();
  }

  private guardArguments(server: CuratedSubagentMcp, tool: string, args: unknown): ToolHandlerResult | null {
    try {
      assertToolArgumentsAllowed(args, this.options.roots, this.options.defaultRoot);
      if (typeof args === 'object' && args !== null) {
        for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
          if (typeof value !== 'string' || !['url', 'uri', 'url_or_path', 'file_url'].includes(key.toLowerCase())) continue;
          if (server === 'playwright') assertLocalBrowserUrl(value, this.options.roots, this.options.defaultRoot);
          if (server === 'markitdown') {
            if (/^https?:/iu.test(value)) throw new Error('scribe MCP 不接受网络 URI');
            const path = value.startsWith('file://') ? fileURLToPath(value) : value;
            assertPathAllowed(path, this.options.roots, this.options.defaultRoot);
          }
        }
      }
      return null;
    } catch (error) {
      this.options.emit?.({action: 'tool-denied', server, tool, reason: error instanceof Error ? error.message : String(error)});
      return errorResult(`MCP 参数越过当前角色边界：${error instanceof Error ? error.message : String(error)}`, 'mcp-boundary-denied');
    }
  }
}

function toolAllowed(server: CuratedSubagentMcp, name: string): boolean {
  if (/delegate|subagent|speak|send_media|ask_human|user.channel/iu.test(name)) return false;
  if (server === 'playwright') return name.startsWith('browser_') && !['browser_run_code', 'browser_install'].includes(name);
  if (server === 'markitdown') return name === 'convert_to_markdown';
  if (name === 'serena_repl') return false;
  return !/shell|terminal|execute|run_command|spawn|process/iu.test(name);
}

function assertLocalBrowserUrl(value: string, roots: readonly string[], defaultRoot: string): void {
  if (value === 'about:blank' || value.startsWith('data:')) return;
  const url = new URL(value);
  if (url.protocol === 'file:') {
    // design 的本地设计稿/测试页通常就在 workspace 里；只允许角色根内的 file URL。
    // Playwright MCP 用 --allow-unrestricted-file-access 才能打开 file://，这里的路径闸
    // 仍把范围收在 workspace/project 根内。
    assertPathAllowed(fileURLToPath(url), roots, defaultRoot);
    return;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('Playwright 只允许本地页面 URL');
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await promise;
  if (signal.aborted) throw new Error('mcp-start-aborted');
  return await new Promise<T>((resolvePromise, reject) => {
    const abort = (): void => reject(new Error('mcp-start-aborted'));
    signal.addEventListener('abort', abort, {once: true});
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
