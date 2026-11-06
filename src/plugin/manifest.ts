import { isAbsolute, posix, win32 } from 'node:path';

export interface PluginManifestV1 {
  readonly apiVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly engine: { readonly irmia: string };
  readonly contributions: {
    readonly skills: readonly string[];
    readonly hooks?: string;
    readonly mcp?: string;
    readonly tools?: string;
    readonly events?: { readonly namespace: string };
  };
  /** v1 compatibility metadata; this is not an execution-time policy grant. */
  readonly permissions: readonly string[];
}

export interface AdapterCapabilityDeclaration {
  readonly capability: string;
}

export interface PluginAdapterContribution {
  readonly worker: string;
  readonly apiVersion: 2;
  readonly capabilities: readonly string[];
}

export interface PluginManifestV2 {
  readonly apiVersion: 2;
  readonly id: string;
  readonly version: string;
  readonly engine: { readonly irmia: string };
  readonly contributions: {
    readonly skills: readonly string[];
    readonly hooks?: string;
    readonly mcp?: string;
    readonly tools?: string;
    readonly events?: { readonly namespace: string };
    readonly adapters: readonly PluginAdapterContribution[];
  };
  /** Kept for compatibility; it is declaration input, not an authorization grant. */
  readonly permissions: readonly string[];
  /** Normalized compatibility view for the future capability policy layer. */
  readonly declaredCapabilities: readonly AdapterCapabilityDeclaration[];
}

export type PluginManifest = PluginManifestV1 | PluginManifestV2;

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const ID = /^[a-z0-9-]{1,64}$/;

function record(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where}: expected an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${where}: unsupported field ${key}`);
}

export function pluginContributionPath(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\') || isAbsolute(value) || win32.isAbsolute(value)) {
    throw new Error(`${where}: expected a relative POSIX path`);
  }
  const normalized = posix.normalize(value);
  if (normalized !== value || value === '.' || value.startsWith('../') || value.endsWith('/')) throw new Error(`${where}: path escapes the package`);
  return value;
}

function parseVersion(value: string): { core: number[]; pre: (number | string)[] } {
  const match = VERSION.exec(value);
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  return {
    core: match.slice(1, 4).map(Number),
    pre: match[4]?.split('.').map((part) => /^\d+$/.test(part) ? Number(part) : part) ?? [],
  };
}

function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) if (left.core[i] !== right.core[i]) return left.core[i]! - right.core[i]!;
  if (left.pre.length === 0 && right.pre.length > 0) return 1;
  if (left.pre.length > 0 && right.pre.length === 0) return -1;
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const a = left.pre[i];
    const b = right.pre[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'number') return -1;
    if (typeof b === 'number') return 1;
    return a < b ? -1 : a > b ? 1 : 0; // SemVer 规定 ASCII 码点序，不用 locale 排序
  }
  return 0;
}

export function isPluginEngineCompatible(requirement: string, currentVersion: string): boolean {
  const minimum = requirement.startsWith('>=') ? requirement.slice(2) : requirement;
  if (!VERSION.test(minimum) || (requirement.startsWith('>=') && requirement.length === 2)) throw new Error(`Invalid engine requirement: ${requirement}`);
  const comparison = compareVersions(currentVersion, minimum);
  return requirement.startsWith('>=') ? comparison >= 0 : comparison === 0;
}

export function parsePluginManifest(raw: unknown, where = 'plugin.json'): PluginManifest {
  const value = record(raw, where);
  if (value.apiVersion !== 1 && value.apiVersion !== 2) throw new Error(`${where}: apiVersion must be 1 or 2`);
  const apiVersion = value.apiVersion;
  const allowedKeys = ['apiVersion', 'id', 'version', 'engine', 'contributions', 'permissions'];
  exactKeys(value, allowedKeys, where);
  if (typeof value.id !== 'string' || !ID.test(value.id)) throw new Error(`${where}: invalid plugin id`);
  if (typeof value.version !== 'string' || !VERSION.test(value.version)) throw new Error(`${where}: invalid version`);
  const engine = record(value.engine, `${where}.engine`);
  exactKeys(engine, ['irmia'], `${where}.engine`);
  if (typeof engine.irmia !== 'string') throw new Error(`${where}.engine.irmia: expected a version requirement`);
  isPluginEngineCompatible(engine.irmia, '0.0.0');
  const contributions = record(value.contributions, `${where}.contributions`);
  const contributionKeys = apiVersion === 2 ? ['skills', 'hooks', 'mcp', 'adapters', 'tools', 'events'] : ['skills', 'hooks', 'mcp'];
  exactKeys(contributions, contributionKeys, `${where}.contributions`);
  if (!Array.isArray(contributions.skills)) throw new Error(`${where}.contributions.skills: expected an array`);
  const skills = Object.freeze(contributions.skills.map((path, i) => pluginContributionPath(path, `${where}.contributions.skills[${i}]`)));
  const legacy: { skills: readonly string[]; hooks?: string; mcp?: string; tools?: string } = { skills };
  for (const key of ['hooks', 'mcp', 'tools'] as const) {
    if (contributions[key] !== undefined) legacy[key] = pluginContributionPath(contributions[key], `${where}.contributions.${key}`);
  }
  if (!permissionsArray(value.permissions)) throw new Error(`${where}.permissions: expected a string array`);
  const permissions = Object.freeze([...value.permissions]);
  const engineResult = Object.freeze({ irmia: engine.irmia });
  if (apiVersion === 1) {
    return Object.freeze({
      apiVersion: 1,
      id: value.id,
      version: value.version,
      engine: engineResult,
      contributions: Object.freeze(legacy),
      permissions,
    });
  }
  const adapters = parseAdapterContributions(contributions.adapters, `${where}.contributions.adapters`);
  const eventsContribution = contributions.events === undefined
    ? undefined
    : parseEventsContribution(contributions.events, `${where}.contributions.events`);
  return Object.freeze({
    apiVersion: 2,
    id: value.id,
    version: value.version,
    engine: engineResult,
    contributions: Object.freeze({ ...legacy, adapters, ...(eventsContribution === undefined ? {} : { events: eventsContribution }) }),
    permissions,
    declaredCapabilities: permissionsToCapabilityDeclarations(permissions),
  });
}

const CAPABILITY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function capabilityArray(value: unknown, where: string, requireNonEmpty: boolean): readonly string[] {
  if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)) {
    throw new Error(`${where}: expected a non-empty string array`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || !CAPABILITY.test(item)) throw new Error(`${where}[${index}]: invalid capability`);
    if (seen.has(item)) throw new Error(`${where}[${index}]: duplicate capability ${item}`);
    seen.add(item);
    result.push(item);
  }
  return Object.freeze(result);
}

/** Convert legacy permissions into declaration-shaped input without granting anything. */
export function permissionsToCapabilityDeclarations(permissions: readonly string[]): readonly AdapterCapabilityDeclaration[] {
  return Object.freeze(permissions.map((capability) => Object.freeze({ capability })));
}

function parseAdapterContribution(value: unknown, where: string): PluginAdapterContribution {
  const adapter = record(value, where);
  exactKeys(adapter, ['worker', 'apiVersion', 'capabilities'], where);
  if (adapter.apiVersion !== 2) throw new Error(`${where}.apiVersion: expected adapter API version 2`);
  const worker = pluginContributionPath(adapter.worker, `${where}.worker`);
  const capabilities = capabilityArray(adapter.capabilities, `${where}.capabilities`, true);
  return Object.freeze({ worker, apiVersion: 2, capabilities });
}

const NAMESPACE = /^[a-z][a-z0-9-]{1,40}$/;

function parseEventsContribution(value: unknown, where: string): { readonly namespace: string } {
  const event = record(value, where);
  exactKeys(event, ['namespace'], where);
  if (typeof event.namespace !== 'string' || !NAMESPACE.test(event.namespace)) throw new Error(`${where}.namespace: invalid namespace`);
  return Object.freeze({ namespace: event.namespace });
}

function parseAdapterContributions(value: unknown, where: string): readonly PluginAdapterContribution[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${where}: expected a non-empty array`);
  return Object.freeze(value.map((adapter, index) => parseAdapterContribution(adapter, `${where}[${index}]`)));
}

function permissionsArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}
