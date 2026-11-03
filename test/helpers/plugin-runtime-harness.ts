/**
 * 插件运行层的测试台（只给 `test/plugin-runtime-*.test.ts` 与 `plugin-hot-lifecycle` 用）
 *
 * 它搭的是**真的**那一套：真包安装（含内容哈希）、真子进程、真 JSON-RPC、真工具注册表条目
 * ——只有"宿主其余部分"（模型、通道、告警）是替身。理由：这一期要钉的正是"跨进程"这件事，
 * 用假进程去测协议等于什么都没测。
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppEvent } from '../../src/log/types.ts';
import { PluginHost, type PluginHostOptions, type PluginModelReply } from '../../src/plugin/host-services.ts';
import { PluginManager } from '../../src/plugin/manager.ts';
import { installPluginPackage, type PluginPackage } from '../../src/plugin/package-store.ts';
import type { ToolContext, ToolDefinition, ToolHandlerResult } from '../../src/tools/types.js';
import { tempDirSync } from './temp-dirs.ts';

export const PLUGIN_FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));

export interface HarnessOptions {
  fixture?: string;
  /** 改插件清单（id / permissions / runtime …） */
  manifest?: Record<string, unknown>;
  /** 覆盖 `config.schema.json` 的默认值（写进 config 覆盖文件） */
  config?: Record<string, unknown>;
  /** false = 装完不自动确认/启用（热生命周期用例自己按事件驱动） */
  enable?: boolean;
  timeouts?: PluginHostOptions['timeouts'];
  crashCooldownMs?: number;
  timeoutRestartDelayMs?: number;
  sendChat?: PluginHostOptions['sendChat'];
  readChat?: PluginHostOptions['readChat'];
  completeModel?: PluginHostOptions['completeModel'];
  /** 入站消息的"发送者是不是用户"判据（message.received admin 过滤 / admin 指令） */
  isOwnerMessage?: PluginHostOptions['isOwnerMessage'];
  /** 允许 http://127.0.0.1 / localhost（给 net 用例访问本地 fixture server；生产默认关） */
  netAllowInsecureLoopbackHttp?: boolean;
  /** 额外环境变量（测试夹具用它读过滤条件/指令定义） */
  env?: NodeJS.ProcessEnv;
}

export interface Harness {
  dataDir: string;
  sourceDir: string;
  manager: PluginManager;
  host: PluginHost;
  events: Array<Pick<AppEvent, 'type' | 'data'>>;
  writes: string[];
  tools: Map<string, ToolDefinition>;
  pkg: PluginPackage;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 启用的包（manager 视图里的 package） */
  active(): PluginPackage;
  tool(name: string): ToolDefinition;
  callTool(name: string, args: unknown): Promise<ToolHandlerResult>;
  waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs?: number): Promise<void>;
  dispose(): Promise<void>;
}

/** 等待用：**不 unref**（unref 的 sleep 会在"插件刚被杀、重启定时器也是 unref"时让测试进程提前退出） */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dataDir = tempDirSync('irmia-plugin-harness-');
  const sourceDir = join(tempDirSync('irmia-plugin-src-'), 'fixture');
  cpSync(join(PLUGIN_FIXTURES, options.fixture ?? 'plugin-node'), sourceDir, { recursive: true });
  if (options.manifest !== undefined) {
    const manifestPath = join(sourceDir, 'plugin.json');
    const current = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(manifestPath, `${JSON.stringify({ ...current, ...options.manifest }, null, 2)}\n`, 'utf8');
  }
  const events: Array<Pick<AppEvent, 'type' | 'data'>> = [];
  const writes: string[] = [];
  const tools = new Map<string, ToolDefinition>();
  const hostRef: { host: PluginHost | null } = { host: null };
  const manager = new PluginManager(dataDir, (type, data) => {
    events.push({ type, data } as Pick<AppEvent, 'type' | 'data'>);
    hostRef.host?.onLifecycleEvent(type, data as Record<string, unknown>);
  });
  const installed = manager.install(sourceDir);
  // 确认 + 启用（等价于人点过两次头）。此刻 host 还没建 ⇒ 事件只落数组，不会自动拉起进程；
  // 拉起由 harness.start() 显式做，测试对"什么时候起"有确定控制。
  if (options.enable !== false) {
    manager.confirm(installed.manifest.id, installed.contentHash);
    manager.setEnabled(installed.manifest.id, installed.contentHash, true);
  }
  if (options.config !== undefined) {
    const configDir = join(dataDir, 'plugins', 'config', installed.manifest.id);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(options.config), 'utf8');
  }
  const host = new PluginHost({
    dataDir,
    write: (line) => { writes.push(line); },
    emit: (type, data) => { events.push({ type, data } as Pick<AppEvent, 'type' | 'data'>); },
    tools: {
      register: (definition) => { tools.set(definition.name, definition); },
      unregister: (name) => { tools.delete(name); },
    },
    bridge: {
      recordFailure: (id, contentHash, reason) => {
        events.push({ type: 'plugin/failed', data: { id, contentHash, reason } } as Pick<AppEvent, 'type' | 'data'>);
      },
      markRuntimeApplied: (id, contentHash) => { manager?.markRuntimeApplied(id, contentHash); },
      applyComposition: () => {},
      autoDisable: (id, contentHash) => {
        try { manager?.setEnabled(id, contentHash, false); } catch { /* 测试里不关心 */ }
      },
      packageOf: (id, contentHash) => manager?.list()
        .find((view) => view.package.manifest.id === id && view.package.contentHash === contentHash)?.package ?? null,
    },
    ...(options.sendChat === undefined ? {} : { sendChat: options.sendChat }),
    ...(options.readChat === undefined ? {} : { readChat: options.readChat }),
    ...(options.completeModel === undefined ? {} : { completeModel: options.completeModel }),
    ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
    ...(options.crashCooldownMs === undefined ? {} : { crashCooldownMs: options.crashCooldownMs }),
    ...(options.timeoutRestartDelayMs === undefined ? {} : { timeoutRestartDelayMs: options.timeoutRestartDelayMs }),
    ...(options.isOwnerMessage === undefined ? {} : { isOwnerMessage: options.isOwnerMessage }),
    ...(options.netAllowInsecureLoopbackHttp === undefined ? {} : { netAllowInsecureLoopbackHttp: options.netAllowInsecureLoopbackHttp }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  hostRef.host = host;
  manager.setUninstallHook((id, contentHash) => { host.killForUninstall(id, contentHash); });

  const harness: Harness = {
    dataDir,
    sourceDir,
    manager,
    host,
    events,
    writes,
    tools,
    pkg: installed,
    async start() {
      await host.startPackage(installed);
      await harness.waitFor(() => host.status(installed.manifest.id, installed.contentHash).state === 'running', '插件进程进入 running');
    },
    async stop() {
      await host.stopPackage(installed.manifest.id, installed.contentHash, 'test');
    },
    active() {
      return manager.list()[0]!.package;
    },
    tool(name: string) {
      const definition = tools.get(name);
      if (definition === undefined) throw new Error(`工具没注册：${name}（已注册：${[...tools.keys()].join(', ')}）`);
      return definition;
    },
    async callTool(name: string, args: unknown) {
      return await harness.tool(name).handler(args, fakeToolContext());
    },
    async waitFor(predicate, label, timeoutMs = 8_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await sleep(25);
      }
      throw new Error(`等不到：${label}（最近日志：${writes.slice(-8).join(' | ') || '无'}）`);
    },
    async dispose() {
      await host.stopAll('test');
    },
  };
  return harness;
}

function fakeToolContext(): ToolContext {
  return {
    callId: 'test-call',
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    workspaceRoot: process.cwd(),
  };
}

export function makeModelReply(text: string): PluginModelReply {
  return { text, model: 'test-model', usage: { inputTokens: 1, outputTokens: 1 } };
}
