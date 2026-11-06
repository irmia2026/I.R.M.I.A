/** Pure, host-neutral capability intersection policy. */
import type { CapabilityGrant } from './api.ts';

export interface CapabilityQuota {
  readonly maxUses?: number;
  readonly maxBytes?: number;
}

export interface CapabilityDeclaration {
  readonly capability: string;
  readonly scope?: readonly string[];
  readonly expiresAt?: string;
  readonly quota?: CapabilityQuota | number;
}

export type DeclaredCapability = string | CapabilityDeclaration;

/** CapabilityGrant intentionally stays type-only; quota is policy metadata. */
export type ApprovedCapabilityGrant = CapabilityGrant & {
  readonly quota?: CapabilityQuota | number;
};

export interface NormalizedQuota {
  readonly maxUses?: number;
  readonly maxBytes?: number;
}

export interface NormalizedCapabilityGrant extends CapabilityGrant {
  readonly quota?: NormalizedQuota;
}

export interface CapabilityRejection {
  readonly capability: string;
  readonly reason: 'unknown-capability' | 'invalid-capability' | 'expired' | 'scope-empty' | 'invalid-quota';
}

export interface CapabilityPolicyInput {
  /** The host-known vocabulary. An omitted or empty vocabulary denies everything. */
  readonly knownCapabilities: readonly string[];
  readonly declared: readonly DeclaredCapability[];
  readonly approved: readonly ApprovedCapabilityGrant[];
  readonly now?: Date | number | string;
}

export interface CapabilityPolicyResult {
  readonly grants: readonly NormalizedCapabilityGrant[];
  /** Alias for callers that use the RFC's `effective` terminology. */
  readonly effective: readonly NormalizedCapabilityGrant[];
  readonly rejected: readonly CapabilityRejection[];
}

const CAPABILITY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

function scopeOf(scope: readonly string[] | undefined): readonly string[] | undefined {
  if (scope === undefined) return undefined;
  const values = [...new Set(scope.map(text).filter((value): value is string => value !== null))];
  return values.sort();
}

function intersectScope(a: readonly string[] | undefined, b: readonly string[] | undefined): readonly string[] | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const right = new Set(b);
  return a.filter(value => right.has(value));
}

function finiteLimit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

/** Normalize quotas without allowing NaN, infinity, fractions, or negatives to widen access. */
export function normalizeQuota(value: CapabilityQuota | number | undefined): NormalizedQuota | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    const maxUses = finiteLimit(value);
    return maxUses === undefined ? undefined : { maxUses };
  }
  if (value === null || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const maxUses = source.maxUses === undefined ? undefined : finiteLimit(source.maxUses);
  const maxBytes = source.maxBytes === undefined ? undefined : finiteLimit(source.maxBytes);
  if (source.maxUses !== undefined && maxUses === undefined) return undefined;
  if (source.maxBytes !== undefined && maxBytes === undefined) return undefined;
  if (maxUses === undefined && maxBytes === undefined) return {};
  return {
    ...(maxUses === undefined ? {} : { maxUses }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}

function intersectQuota(a: NormalizedQuota | undefined, b: NormalizedQuota | undefined): NormalizedQuota | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const maxUses = a.maxUses === undefined ? b.maxUses : b.maxUses === undefined ? a.maxUses : Math.min(a.maxUses, b.maxUses);
  const maxBytes = a.maxBytes === undefined ? b.maxBytes : b.maxBytes === undefined ? a.maxBytes : Math.min(a.maxBytes, b.maxBytes);
  return {
    ...(maxUses === undefined ? {} : { maxUses }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}

function timestamp(value: Date | number | string | undefined): number {
  if (value === undefined) return Date.now();
  const result = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(result) ? result : Number.NaN;
}

function expiry(value: string | undefined, now: number): string | undefined | null {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  if (!Number.isFinite(now) || parsed <= now) return null;
  return new Date(parsed).toISOString();
}

function declarationOf(value: DeclaredCapability): CapabilityDeclaration | null {
  if (typeof value === 'string') return { capability: value };
  if (value === null || typeof value !== 'object') return null;
  return value;
}

function validCapability(value: unknown): string | null {
  const capability = text(value);
  return capability !== null && CAPABILITY_RE.test(capability) ? capability : null;
}

function isNonEmptyQuota(quota: NormalizedQuota | undefined): boolean {
  return quota === undefined || Object.keys(quota).length === 0 || Object.values(quota).some(limit => limit > 0);
}

/**
 * Resolve declared capabilities against host-known, user-approved grants.
 * Missing vocabulary entries, malformed values, expired grants, and empty scopes deny.
 */
export function resolveCapabilityPolicy(input: CapabilityPolicyInput): CapabilityPolicyResult {
  const known = new Set(input.knownCapabilities.map(validCapability).filter((value): value is string => value !== null));
  const now = timestamp(input.now);
  const rejected: CapabilityRejection[] = [];
  const declarations: CapabilityDeclaration[] = [];

  for (const raw of input.declared) {
    const declaration = declarationOf(raw);
    if (declaration === null) {
      rejected.push({ capability: '', reason: 'invalid-capability' });
      continue;
    }
    const capability = validCapability(declaration.capability);
    if (capability === null) {
      rejected.push({ capability: text(declaration.capability) ?? '', reason: 'invalid-capability' });
      continue;
    }
    if (!known.has(capability)) {
      rejected.push({ capability, reason: 'unknown-capability' });
      continue;
    }
    const scope = scopeOf(declaration.scope);
    if (scope !== undefined && scope.length === 0) {
      rejected.push({ capability, reason: 'scope-empty' });
      continue;
    }
    const quota = normalizeQuota(declaration.quota);
    if (declaration.quota !== undefined && quota === undefined) {
      rejected.push({ capability, reason: 'invalid-quota' });
      continue;
    }
    const expiresAt = expiry(declaration.expiresAt, now);
    if (expiresAt === null) {
      rejected.push({ capability, reason: 'expired' });
      continue;
    }
    declarations.push({
      ...declaration,
      capability,
      ...(scope === undefined ? {} : { scope }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(quota === undefined ? {} : { quota }),
    });
  }

  const grants: NormalizedCapabilityGrant[] = [];
  for (const raw of input.approved) {
    const capability = validCapability(raw?.capability);
    if (capability === null) {
      rejected.push({ capability: text(raw?.capability) ?? '', reason: 'invalid-capability' });
      continue;
    }
    if (!known.has(capability)) {
      rejected.push({ capability, reason: 'unknown-capability' });
      continue;
    }
    const scope = scopeOf(raw.scope);
    if (scope !== undefined && scope.length === 0) {
      rejected.push({ capability, reason: 'scope-empty' });
      continue;
    }
    const expiresAt = expiry(raw.expiresAt, now);
    if (expiresAt === null) {
      rejected.push({ capability, reason: 'expired' });
      continue;
    }
    const quota = normalizeQuota(raw.quota);
    if (raw.quota !== undefined && quota === undefined) {
      rejected.push({ capability, reason: 'invalid-quota' });
      continue;
    }
    for (const declaration of declarations) {
      if (declaration.capability !== capability) continue;
      const effectiveScope = intersectScope(declaration.scope, scope);
      if (effectiveScope !== undefined && effectiveScope.length === 0) {
        rejected.push({ capability, reason: 'scope-empty' });
        continue;
      }
      const effectiveQuota = intersectQuota(normalizeQuota(declaration.quota), quota);
      if (!isNonEmptyQuota(effectiveQuota)) {
        rejected.push({ capability, reason: 'invalid-quota' });
        continue;
      }
      const effectiveExpiresAt = declaration.expiresAt === undefined || expiresAt === undefined
        ? (declaration.expiresAt ?? expiresAt)
        : new Date(Math.min(Date.parse(declaration.expiresAt), Date.parse(expiresAt))).toISOString();
      grants.push({
        capability,
        ...(effectiveScope === undefined ? {} : { scope: effectiveScope }),
        ...(effectiveExpiresAt === undefined ? {} : { expiresAt: effectiveExpiresAt }),
        ...(effectiveQuota === undefined ? {} : { quota: effectiveQuota }),
      });
    }
  }

  const unique = new Map<string, NormalizedCapabilityGrant>();
  for (const grant of grants) {
    const key = JSON.stringify([grant.capability, grant.scope ?? null, grant.expiresAt ?? null, grant.quota ?? null]);
    unique.set(key, grant);
  }
  const effective = [...unique.values()].sort((a, b) => a.capability.localeCompare(b.capability) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { grants: effective, effective, rejected };
}

/** Short alias for callers that only need the set intersection. */
export const intersectCapabilities = resolveCapabilityPolicy;
