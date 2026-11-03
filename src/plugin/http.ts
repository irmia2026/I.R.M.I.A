import { isAbsolute, win32 } from 'node:path';

import type { PluginManager, PluginView } from './manager.js';

export type PluginCommand = 'plugin-install' | 'plugin-confirm' | 'plugin-enable' | 'plugin-disable' | 'plugin-uninstall';
export interface PluginHttpResult {
  status: number;
  body: unknown;
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

export function listPlugins(manager: PluginManager | undefined): PluginHttpResult {
  if (manager === undefined) return unavailable();
  try {
    return { status: 200, body: { items: manager.list() } };
  } catch (error) {
    return failure('plugin-error', error);
  }
}

export function runPluginCommand(
  command: PluginCommand,
  payload: Record<string, unknown>,
  manager: PluginManager | undefined,
): PluginHttpResult {
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
        permissions: installed.manifest.permissions, net: installed.manifest.netAllow,
        marketId: null, marketVersion: null, pid: null, uptimeMs: 0,
        runtime: { type: installed.manifest.runtime.type, entry: installed.manifest.runtime.entry ?? null, state: 'not-running', pid: null, uptimeMs: 0, restarts: 0 },
      }) } };
    }

    const id = text(payload, 'id');
    const contentHash = text(payload, 'contentHash');
    if (id === '' || contentHash === '') return failure('bad-request', '缺少 id 或 contentHash');
    if (command === 'plugin-uninstall') {
      // 卸载是**不可逆**的（包目录直接删）：进程由 manager 的同步收尸钩子先停掉，
      // 这里只负责把"哪一份内容被删了"如实写进事件。不需要重启宿主——组合面下一拍自己会重算。
      manager.uninstall(id, contentHash);
      return { status: 200, body: { ok: true, uninstalled: { id, contentHash }, restartRequired: false } };
    }
    if (command === 'plugin-confirm') manager.confirm(id, contentHash);
    else manager.setEnabled(id, contentHash, command === 'plugin-enable');
    const plugin = manager.list().find((item) => item.package.manifest.id === id && item.package.contentHash === contentHash);
    if (plugin === undefined) return failure('plugin-error', `Plugin ${id}@${contentHash} not found after command`);
    return {
      status: 200,
      // 回执回答的是「这次命令之后，宿主还需要为它重启吗」——判据只能是插件自己的
      // requiresRestart（本次启停是否还没被装配过），不能对启停一律回答「要重启」：
      // 重复启用一条已生效的插件时运行面一点没变，说「要重启」就是自相矛盾。
      body: { ok: true, plugin, ...(command === 'plugin-confirm' ? {} : { restartRequired: plugin.requiresRestart }) },
    };
  } catch (error) {
    return failure('plugin-error', error);
  }
}
