import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ID = 'linre-memewiki';
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function resolvePluginDataDir(explicitDir) {
  if (typeof explicitDir === 'string' && explicitDir.trim() !== '') {
    return resolve(explicitDir.trim());
  }
  const directEnv = process.env.LINRE_PLUGIN_DATA_DIR || process.env.MEMEWIKI_DATA_DIR;
  if (typeof directEnv === 'string' && directEnv.trim() !== '') {
    return resolve(directEnv.trim());
  }
  const irmiaDataDir = process.env.IRMIA_DATA_DIR;
  if (typeof irmiaDataDir === 'string' && irmiaDataDir.trim() !== '') {
    return join(resolve(irmiaDataDir.trim()), 'plugin-data', PLUGIN_ID);
  }
  let dir = PACKAGE_ROOT;
  for (let i = 0; i < 8; i += 1) {
    if (basename(dir) === 'packages' && basename(dirname(dir)) === 'plugins') {
      return join(dirname(dirname(dir)), 'plugin-data', PLUGIN_ID);
    }
    if (existsSync(join(dir, 'events'))) {
      return join(dir, 'plugin-data', PLUGIN_ID);
    }
    if (existsSync(join(dir, 'data', 'events'))) {
      return join(dir, 'data', 'plugin-data', PLUGIN_ID);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(homedir(), '.linre', 'plugin-data', PLUGIN_ID);
}
