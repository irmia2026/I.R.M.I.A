import { isAbsolute, join } from 'node:path';

type Env = Record<string, string | undefined>;

function absolute(env: Env, key: string): string | null {
  const value = env[key]?.trim();
  return value && isAbsolute(value) ? value : null;
}

export function linuxRuntimeDirectory(env: Env): string | null {
  const root = absolute(env, 'XDG_RUNTIME_DIR');
  return root === null ? null : join(root, 'irmia');
}

export function linuxStateDirectory(env: Env): string | null {
  const state = absolute(env, 'XDG_STATE_HOME');
  if (state !== null) return join(state, 'irmia');
  const home = absolute(env, 'HOME');
  return home === null ? null : join(home, '.local', 'state', 'irmia');
}
