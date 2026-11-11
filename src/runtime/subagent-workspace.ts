import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { errorResult, TOOL_ERROR_CODES, type ToolDefinition } from '../tools/types.ts';

const PATH_KEYS = new Set([
  'path', 'paths', 'file', 'files', 'dir', 'directory', 'root', 'workspace', 'project',
  'relative_path', 'relativepath', 'filepath', 'file_path', 'directory_path',
  'output', 'outputpath', 'output_path', 'target_path',
]);

export function resolveAuthorizedProject(input: string | undefined, authorizedRoots: readonly string[]): string {
  const roots = authorizedRoots.map((root) => realDirectory(root));
  const chosen = input ?? (roots.length === 1 ? authorizedRoots[0] : undefined);
  if (chosen === undefined || chosen.trim() === '') throw new Error('project-root-required');
  const candidate = realDirectory(chosen);
  if (!roots.some((root) => inside(root, candidate))) throw new Error('project-root-unauthorized');
  return candidate;
}

export function realDirectory(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error('project-root-invalid');
  return realpathSync.native(resolved);
}

export function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function comparable(path: string): string {
  const resolved = resolve(path);
  let base = resolved;
  const rest: string[] = [];
  while (!existsSync(base)) {
    const parent = resolve(base, '..');
    if (parent === base) break;
    rest.unshift(base.slice(parent.length).replace(/^[\\/]+/u, ''));
    base = parent;
  }
  let realBase = base;
  try {
    realBase = realpathSync.native(base);
  } catch {
    // The lexical containment check below still rejects paths outside an authorized root.
  }
  return resolve(realBase, ...rest);
}

export function assertPathAllowed(input: string, roots: readonly string[], defaultRoot: string): void {
  if (input.trim() === '' || input.includes('\0')) throw new Error('path-invalid');
  const candidate = comparable(isAbsolute(input) ? input : resolve(defaultRoot, input));
  const allowed = roots.some((root) => inside(comparable(root), candidate));
  if (!allowed) throw new Error('path-outside-authorized-root');
}

function checkValue(value: unknown, key: string | null, roots: readonly string[], defaultRoot: string): void {
  if (Array.isArray(value)) {
    for (const item of value) checkValue(item, key, roots, defaultRoot);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      checkValue(child, childKey.toLowerCase(), roots, defaultRoot);
    }
    return;
  }
  if (typeof value === 'string' && key !== null && PATH_KEYS.has(key)) {
    assertPathAllowed(value, roots, defaultRoot);
  }
}

export function assertToolArgumentsAllowed(args: unknown, roots: readonly string[], defaultRoot: string): void {
  checkValue(args, null, roots, defaultRoot);
}

export function scopeToolToRoots(
  definition: ToolDefinition,
  roots: readonly string[],
  defaultRoot: string,
): ToolDefinition {
  return {
    ...definition,
    handler: async (args, ctx) => {
      try {
        checkValue(args, null, roots, defaultRoot);
      } catch (error) {
        return errorResult(
          `子代理路径越权：${error instanceof Error ? error.message : String(error)}；只能使用已授权根内的路径。`,
          TOOL_ERROR_CODES.unsafePath,
        );
      }
      return await definition.handler(args, ctx);
    },
  };
}
