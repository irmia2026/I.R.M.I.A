import { statSync } from 'node:fs';
import { isAbsolute, win32 } from 'node:path';

import { compareVersions, parseVersion } from '../update/check.ts';
import type { PluginManager, PluginView } from './manager.js';

export type PluginCommand = 'plugin-install' | 'plugin-confirm' | 'plugin-enable' | 'plugin-disable';
export interface PluginHttpResult {
  status: number;
  body: unknown;
}
/**
 * 启停命令后的**热重组装**口：宿主把 `applyPluginRuntime` 递进来，enable/disable 就不再
 * 以「重启后生效」收尾。confirm/install 不改变运行组合，不触发。
 *
 * 为什么 optional：缺省时维持旧行为（requiresRestart=true）——CLI 与测试里没装配运行面
 * 的宿主不该被强迫提供一个空重组装，更不该因此静默改变回执语义。
 */
export interface PluginCommandHooks {
  apply?: (() => Promise<void>) | undefined;
}

function unavailable(): PluginHttpResult {
  return { status: 501, body: { error: { code: 'not-implemented', message: '没有注入 PluginManager：这条实例不提供插件管理' } } };
}

function failure(code: string, error: unknown): PluginHttpResult {
  return { status: 400, body: { error: { code, message: error instanceof Error ? error.message : String(error) } } };
}

function text(payload: Record<string, unknown>, key: string): string {
  return typeof payload[key] === 'string' ? payload[key].trim() : '';
}

function isLocalAbsolutePath(value: string): boolean {
  if (process.platform === 'win32') return win32.isAbsolute(value) && /^[A-Za-z]:/.test(value);
  return isAbsolute(value);
}

function current(manager: PluginManager, view: PluginView): PluginView {
  return manager.list().find((item) => item.package.manifest.id === view.package.manifest.id
    && item.package.contentHash === view.package.contentHash) ?? view;
}

function stateRank(state: PluginView['state']): number {
  if (state === 'untrusted') return 4;
  if (state === 'enabled') return 3;
  if (state === 'probing') return 2;
  if (state === 'disabled') return 1;
  return 0;
}

function mtimeOf(rootDir: string): number {
  try { return statSync(rootDir).mtimeMs; } catch { return 0; }
}

function preferView(a: PluginView, b: PluginView): PluginView {
  const byState = stateRank(a.state) - stateRank(b.state);
  if (byState !== 0) return byState > 0 ? a : b;
  const left = parseVersion(a.package.manifest.version);
  const right = parseVersion(b.package.manifest.version);
  if (left !== null && right !== null) {
    const byVersion = compareVersions(left, right);
    if (byVersion !== 0) return byVersion > 0 ? a : b;
  }
  const leftMs = mtimeOf(a.package.rootDir);
  const rightMs = mtimeOf(b.package.rootDir);
  if (leftMs !== rightMs) return leftMs > rightMs ? a : b;
  return a.package.contentHash <= b.package.contentHash ? a : b;
}

export function listPlugins(manager: PluginManager | undefined): PluginHttpResult {
  if (manager === undefined) return unavailable();
  try {
    const byId = new Map<string, PluginView>();
    for (const view of manager.list()) {
      const id = view.package.manifest.id;
      const existing = byId.get(id);
      byId.set(id, existing === undefined ? view : preferView(existing, view));
    }
    return { status: 200, body: { items: [...byId.values()] } };
  } catch (error) {
    return failure('plugin-error', error);
  }
}

export async function runPluginCommand(
  command: PluginCommand,
  payload: Record<string, unknown>,
  manager: PluginManager | undefined,
  hooks: PluginCommandHooks = {},
): Promise<PluginHttpResult> {
  if (manager === undefined) return unavailable();
  try {
    if (command === 'plugin-install') {
      const sourceDir = text(payload, 'sourceDir');
      if (!isLocalAbsolutePath(sourceDir)) {
        return failure('invalid-source', 'plugin-install 只接受绝对本地目录 sourceDir');
      }
      const installed = manager.install(sourceDir);
      return { status: 200, body: { ok: true, plugin: current(manager, {
        package: installed, state: 'untrusted', problems: [], requiresRestart: false,
      }) } };
    }

    const id = text(payload, 'id');
    const contentHash = text(payload, 'contentHash');
    if (id === '' || contentHash === '') return failure('bad-request', '缺少 id 或 contentHash');
    if (command === 'plugin-confirm') manager.confirm(id, contentHash);
    else manager.setEnabled(id, contentHash, command === 'plugin-enable');

    // 启停热重组装：先放行 `active()` 的门（markApplied），再走宿主递进来的 apply 管道
    // （与熔断器同一条）。装失败把快照还回去——requiresRestart 保持 true，重启兜底，
    // 回执里如实带 applyError，不假装生效。
    let applyError: string | undefined;
    if ((command === 'plugin-enable' || command === 'plugin-disable') && hooks.apply !== undefined) {
      const snapshot = manager.appliedSnapshot();
      manager.markApplied();
      try {
        await hooks.apply();
      } catch (error) {
        manager.restoreApplied(snapshot);
        applyError = error instanceof Error ? error.message : String(error);
      }
    }

    const plugin = manager.list().find((item) => item.package.manifest.id === id && item.package.contentHash === contentHash);
    if (plugin === undefined) return failure('plugin-error', `Plugin ${id}@${contentHash} not found after command`);
    return {
      status: 200,
      // 回执回答的是「这次命令之后，宿主还需要为它重启吗」——判据只能是插件自己的
      // requiresRestart（本次启停是否还没被装配过），不能对启停一律回答「要重启」：
      // 重复启用一条已生效的插件时运行面一点没变，说「要重启」就是自相矛盾。
      body: { ok: true, plugin, ...(command === 'plugin-confirm' ? {} : { restartRequired: plugin.requiresRestart }),
        ...(applyError !== undefined ? { applyError } : {}) },
    };
  } catch (error) {
    return failure('plugin-error', error);
  }
}
