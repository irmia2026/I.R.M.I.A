import type { Asset, CapabilityGrant, MediaPort, PluginIdentity, StoragePort } from './api.ts';
import type { NormalizedCapabilityGrant, NormalizedQuota } from './capability-policy.ts';

export interface CapabilityCheckRequest {
  readonly capability: string;
  readonly scope?: string;
  readonly bytes?: number;
}

export type CapabilityCheckResult =
  | { readonly ok: true; readonly grant: NormalizedCapabilityGrant; readonly remainingUses?: number; readonly remainingBytes?: number }
  | { readonly ok: false; readonly reason: CapabilityCheckReason };

export type CapabilityCheckReason =
  | 'capability-denied'
  | 'scope-denied'
  | 'scope-required'
  | 'grant-expired'
  | 'quota-exhausted'
  | 'quota-bytes-exhausted'
  | 'invalid-request';

export interface InMemoryStorageOptions {
  readonly namespace: string;
  readonly maxKeys?: number;
  readonly maxBytes?: number;
}

const NAMESPACE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

function copyBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function assertNamespace(namespace: string): void {
  if (!NAMESPACE_RE.test(namespace)) throw new Error(`invalid storage namespace: ${namespace}`);
}

function assertKey(key: string, allowEmpty = false): void {
  if (allowEmpty && key === '') return;
  if (!KEY_RE.test(key) || key.startsWith('/') || key.includes('\\') || key.split('/').some(part => part === '..' || part === '')) {
    throw new Error(`invalid storage key: ${key}`);
  }
}

function assertLimit(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) throw new Error(`invalid ${label}`);
}

/** In-memory, plugin-scoped KV storage. Values are copied at both boundaries. */
export class InMemoryStoragePort implements StoragePort {
  readonly namespace: string;
  private readonly values = new Map<string, Uint8Array>();
  private readonly maxKeys: number | undefined;
  private readonly maxBytes: number | undefined;
  private totalBytes = 0;

  constructor(options: InMemoryStorageOptions) {
    assertNamespace(options.namespace);
    assertLimit(options.maxKeys, 'maxKeys');
    assertLimit(options.maxBytes, 'maxBytes');
    this.namespace = options.namespace;
    this.maxKeys = options.maxKeys;
    this.maxBytes = options.maxBytes;
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertKey(key);
    const value = this.values.get(key);
    return value === undefined ? null : copyBytes(value);
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    assertKey(key);
    if (!(value instanceof Uint8Array)) throw new TypeError('storage value must be Uint8Array');
    const next = copyBytes(value);
    const previous = this.values.get(key);
    const nextTotal = this.totalBytes - (previous?.byteLength ?? 0) + next.byteLength;
    if (this.maxKeys !== undefined && previous === undefined && this.values.size >= this.maxKeys) throw new Error('storage key quota exceeded');
    if (this.maxBytes !== undefined && nextTotal > this.maxBytes) throw new Error('storage byte quota exceeded');
    this.values.set(key, next);
    this.totalBytes = nextTotal;
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    const previous = this.values.get(key);
    if (previous === undefined) return;
    this.values.delete(key);
    this.totalBytes -= previous.byteLength;
  }

  async list(prefix = ''): Promise<readonly string[]> {
    if (prefix !== '' && (!KEY_RE.test(prefix.replace(/\/$/, '')) || prefix.startsWith('/') || prefix.includes('\\') || prefix.split('/').some((part, index, parts) => part === '..' || (part === '' && index !== parts.length - 1)))) {
      throw new Error(`invalid storage key: ${prefix}`);
    }
    return [...this.values.keys()].filter(key => key.startsWith(prefix)).sort();
  }
}

export interface CapabilityBrokerOptions {
  readonly plugin: PluginIdentity;
  readonly grants: readonly NormalizedCapabilityGrant[];
  readonly now?: () => number;
  readonly storage?: StoragePort;
  readonly storageNamespace?: string;
  readonly storageMaxKeys?: number;
  readonly storageMaxBytes?: number;
  readonly media?: MediaPort;
}

type GrantWithQuota = NormalizedCapabilityGrant & { readonly quota?: NormalizedQuota };

function quotaOf(grant: GrantWithQuota): NormalizedQuota | undefined {
  return grant.quota;
}

function validBytes(bytes: number | undefined): boolean {
  return bytes === undefined || (Number.isInteger(bytes) && bytes >= 0);
}

/** Capability-scoped host ports for one trusted plugin revision. */
export class CapabilityBroker {
  readonly plugin: PluginIdentity;
  readonly storage: StoragePort;
  readonly media: MediaPort;
  private readonly grants: readonly GrantWithQuota[];
  private readonly now: () => number;
  private readonly usedUses = new Map<string, number>();
  private readonly usedBytes = new Map<string, number>();

  constructor(options: CapabilityBrokerOptions) {
    this.plugin = options.plugin;
    this.grants = options.grants;
    this.now = options.now ?? (() => Date.now());
    this.storage = options.storage ?? new InMemoryStoragePort({
      namespace: options.storageNamespace ?? options.plugin.id,
      ...(options.storageMaxKeys === undefined ? {} : { maxKeys: options.storageMaxKeys }),
      ...(options.storageMaxBytes === undefined ? {} : { maxBytes: options.storageMaxBytes }),
    });
    this.media = options.media ?? { resolve: async () => null };
  }

  /** Check a request without consuming quota. */
  check(request: CapabilityCheckRequest): CapabilityCheckResult {
    if (typeof request.capability !== 'string' || request.capability.trim() === '' || !validBytes(request.bytes)) {
      return { ok: false, reason: 'invalid-request' };
    }
    const now = this.now();
    if (!Number.isFinite(now)) return { ok: false, reason: 'grant-expired' };
    const candidates = this.grants.filter(grant => grant.capability === request.capability);
    if (candidates.length === 0) return { ok: false, reason: 'capability-denied' };
    let scopeRequired = false;
    let scopeDenied = false;
    for (const grant of candidates) {
      if (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= now) continue;
      const scope = grant.scope;
      if (scope !== undefined && request.scope === undefined) {
        scopeRequired = true;
        continue;
      }
      if (scope !== undefined && request.scope !== undefined && !scope.includes(request.scope)) {
        scopeDenied = true;
        continue;
      }
      const quota = quotaOf(grant);
      const key = this.usageKey(grant, request.scope);
      const usedUses = this.usedUses.get(key) ?? 0;
      const usedBytes = this.usedBytes.get(key) ?? 0;
      if (quota?.maxUses !== undefined && usedUses >= quota.maxUses) continue;
      if (quota?.maxBytes !== undefined && (request.bytes ?? 0) + usedBytes > quota.maxBytes) continue;
      return {
        ok: true,
        grant,
        ...(quota?.maxUses === undefined ? {} : { remainingUses: quota.maxUses - usedUses }),
        ...(quota?.maxBytes === undefined ? {} : { remainingBytes: quota.maxBytes - usedBytes }),
      };
    }
    if (scopeRequired && request.scope === undefined) return { ok: false, reason: 'scope-required' };
    if (scopeDenied) return { ok: false, reason: 'scope-denied' };
    const live = candidates.some(grant => grant.expiresAt === undefined || Date.parse(grant.expiresAt) > now);
    if (!live) return { ok: false, reason: 'grant-expired' };
    const bytesLimited = candidates.some(grant => grant.quota?.maxBytes !== undefined);
    if (bytesLimited && (request.bytes ?? 0) > 0) return { ok: false, reason: 'quota-bytes-exhausted' };
    return { ok: false, reason: 'quota-exhausted' };
  }

  /** Check and consume one use of a capability grant. */
  authorize(request: CapabilityCheckRequest): CapabilityCheckResult {
    const result = this.check(request);
    if (!result.ok) return result;
    const key = this.usageKey(result.grant, request.scope);
    this.usedUses.set(key, (this.usedUses.get(key) ?? 0) + 1);
    if (request.bytes !== undefined && request.bytes > 0) this.usedBytes.set(key, (this.usedBytes.get(key) ?? 0) + request.bytes);
    return result;
  }

  private usageKey(grant: GrantWithQuota, scope: string | undefined): string {
    return `${grant.capability}\0${JSON.stringify(grant.scope ?? null)}\0${scope ?? ''}`;
  }
}

/** Create an independent namespace-scoped in-memory storage port. */
export function createMemoryStorage(options: InMemoryStorageOptions): StoragePort {
  return new InMemoryStoragePort(options);
}

/** Helper for dispatcher tests and policy decisions. */
export function assetBytes(asset: Asset): number {
  if (asset.bytes !== undefined && Number.isInteger(asset.bytes) && asset.bytes >= 0) return asset.bytes;
  return asset.bytes ?? 0;
}
