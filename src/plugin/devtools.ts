import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { composePluginHooks, composePluginMcp, composePluginSkillRoots } from './contributions.ts';
import { PluginHost } from './host-services.ts';
import { PLUGIN_HOOK_POINTS } from './hook-registry.ts';
import { scanPluginPackage, type PluginPackage } from './package-store.ts';
import { ToolRegistry } from '../tools/registry.ts';

export interface PluginCheckReport {
  kind: 'check';
  ok: true;
  id: string;
  version: string;
  contentHash: string;
  runtime: string;
  entry: string | null;
  permissions: string[];
  netAllow: string[];
  fileCount: number;
  totalBytes: number;
  contributions: { skillRoots: number; hooks: number; mcp: number };
}

export interface PluginSmokeReport {
  kind: 'smoke';
  ok: true;
  id: string;
  version: string;
  contentHash: string;
  runtime: string;
  declarative: boolean;
  processStarted: boolean;
  processStopped: boolean;
  tools: string[];
  hooks: string[];
  commandRegistered: boolean;
}

function packageReport(pkg: PluginPackage) {
  return {
    id: pkg.manifest.id,
    version: pkg.manifest.version,
    contentHash: pkg.contentHash,
    runtime: pkg.manifest.runtime.type,
    entry: pkg.manifest.runtime.entry ?? null,
    permissions: [...pkg.manifest.permissions],
    netAllow: [...pkg.manifest.netAllow],
    fileCount: pkg.fileCount,
    totalBytes: pkg.totalBytes,
  };
}

function checkDeclarations(pkg: PluginPackage): PluginCheckReport['contributions'] {
  const skillRoots = composePluginSkillRoots([pkg]);
  for (const root of skillRoots) {
    if (!statSync(root.dir).isDirectory()) throw new Error(`技能根不是可读目录：${root.dir}`);
  }
  const hooks = composePluginHooks([pkg]);
  const mcp = composePluginMcp([pkg]);
  const warnings = [...hooks.warnings, ...mcp.warnings];
  if (warnings.length > 0) throw new Error(`声明组合检查失败：${warnings.join('；')}`);
  return { skillRoots: skillRoots.length, hooks: hooks.entries.length, mcp: mcp.servers.length };
}

export function checkPlugin(sourceDir: string, cwd = process.cwd()): PluginCheckReport {
  const pkg = scanPluginPackage(resolve(cwd, sourceDir));
  const contributions = checkDeclarations(pkg);
  return { kind: 'check', ok: true, ...packageReport(pkg), contributions };
}

export async function smokePlugin(sourceDir: string, cwd = process.cwd()): Promise<PluginSmokeReport> {
  const pkg = scanPluginPackage(resolve(cwd, sourceDir));
  checkDeclarations(pkg);
  const base = packageReport(pkg);
  if (pkg.manifest.runtime.type === 'declarative') {
    return {
      kind: 'smoke', ok: true, ...base, declarative: true,
      processStarted: false, processStopped: true, tools: [], hooks: [], commandRegistered: false,
    };
  }

  const dataDir = mkdtempSync(resolve(tmpdir(), 'irmia-plugin-smoke-'));
  const registry = new ToolRegistry();
  const events: string[] = [];
  const failures: string[] = [];
  const host = new PluginHost({
    dataDir,
    write: () => {},
    emit: (type) => { events.push(type); },
    tools: {
      register: (definition) => { registry.register(definition, { replace: true }); },
      unregister: (name) => { registry.unregister(name); },
    },
    bridge: {
      recordFailure: (_id, _hash, reason) => { failures.push(reason); },
      markRuntimeApplied: () => {},
      applyComposition: () => {},
      autoDisable: () => {},
      packageOf: () => pkg,
    },
    sendChat: async () => ({ ok: true }),
    readChat: async () => [],
    completeModel: async () => ({
      text: '[plugin-smoke synthetic response]', model: 'plugin-smoke', usage: { inputTokens: 0, outputTokens: 0 },
    }),
    currentSessionId: () => 'plugin-smoke',
    netDisabled: true,
  });
  let primary: unknown;
  try {
    await host.startPackage(pkg);
    const running = host.status(pkg.manifest.id, pkg.contentHash);
    const report = {
      tools: registry.names(), hooks: PLUGIN_HOOK_POINTS.filter((point) => host.hasHook(point)),
      commandRegistered: host.hasCommands(),
      processStarted: running.state === 'running' && running.pid !== null,
    };
    if (!report.processStarted) throw new Error(`插件未进入 running：${running.state}`);
    if (failures.length > 0) throw new Error(`插件激活或启动通知失败：${failures.join('；')}`);
    await host.stopAll('plugin-smoke');
    const stopped = host.status(pkg.manifest.id, pkg.contentHash).pid === null && !host.hasRunning();
    if (!stopped) throw new Error('插件进程或实例仍未回收');
    return { kind: 'smoke', ok: true, ...base, declarative: false, processStopped: stopped, ...report };
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try { await host.stopAll('plugin-smoke-cleanup'); }
    catch (error) { if (primary === undefined) throw error; }
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
}

export function formatPluginDevReport(report: PluginCheckReport | PluginSmokeReport): string[] {
  const lines = [
    `插件 ${report.id}@${report.version}`,
    `内容哈希：${report.contentHash}`,
    `运行时：${report.runtime}`,
  ];
  if (report.kind === 'check') {
    lines.push(
      `权限：${report.permissions.length === 0 ? '无' : report.permissions.join(', ')}`,
      `net.allow：${report.netAllow.length === 0 ? '空（全拒）' : report.netAllow.join(', ')}`,
      `包：${report.fileCount} 文件 / ${report.totalBytes} 字节`,
      `声明式贡献：技能根 ${report.contributions.skillRoots} · 外部 Hook ${report.contributions.hooks} · MCP ${report.contributions.mcp}`,
      '检查通过：未安装、未信任、未启用',
    );
  } else {
    lines.push(
      report.declarative ? '声明式包：无代码进程；静态与声明检查通过' : `代码进程：启动=${report.processStarted}，回收=${report.processStopped}`,
      `注册工具：${report.tools.length === 0 ? '无' : report.tools.join(', ')}`,
      `命名 Hook：${report.hooks.length === 0 ? '无' : report.hooks.join(', ')}`,
      `聊天指令：${report.commandRegistered ? '有注册' : '无'}`,
      '冒烟通过：未连接真实聊天、模型或网络',
    );
  }
  return lines;
}
