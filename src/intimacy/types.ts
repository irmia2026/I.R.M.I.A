/** Intimacy is simulated private attachment state, not a claim about consent or subjective experience. */

export const INTIMACY_VERSION = 1 as const;
export const INTIMACY_LEVELS = ['subtle', 'obvious', 'strong'] as const;
export type IntimacyLevel = typeof INTIMACY_LEVELS[number];

export const INTIMACY_AUDIENCES = ['owner', 'group', 'other'] as const;
export type IntimacyAudience = typeof INTIMACY_AUDIENCES[number];

export const INTIMACY_PHASES = ['calm', 'warm', 'tense', 'estrus'] as const;
export type IntimacyPhase = typeof INTIMACY_PHASES[number];

export const INTIMACY_INTENTS = ['neutral', 'closeness', 'longing', 'sexual_act', 'satisfaction', 'boundary'] as const;
export type IntimacyIntent = typeof INTIMACY_INTENTS[number];

export const INTIMACY_REASONS = [
  'owner_closeness', 'owner_longing', 'owner_sexual_act', 'late_night', 'owner_return',
  'satisfied', 'boundary', 'left_private', 'spontaneous', 'general',
] as const;
export type IntimacyReasonCode = typeof INTIMACY_REASONS[number];

export interface IntimacyCause {
  atMs: number;
  sourceSeq: number;
  reasonCode: IntimacyReasonCode;
  strength: number;
}

export interface IntimacyState {
  version: typeof INTIMACY_VERSION;
  atMs: number;
  intimacy: number;
  desire: number;
  satisfaction: number;
  restraint: number;
  lastAudience: IntimacyAudience | null;
  lastPrivateAtMs: number | null;
  refractoryUntilMs: number;
  intimacyDay: string | null;
  intimacyGainedToday: number;
  /** First moment desire reached 100; drives the sustained estrus ramp. */
  desireFullSinceMs: number | null;
  causes: IntimacyCause[];
}

export interface IntimacyUpdatedData {
  atMs: number;
  sourceSeq: number;
  audience: IntimacyAudience;
  intimacy: number;
  desire: number;
  satisfaction: number;
  restraint: number;
  /** New events carry the full-desire anchor; old logs omit it (fold treats missing as null). */
  desireFullSinceMs?: number | null;
  cause: { reasonCode: IntimacyReasonCode; strength: number };
}

/** Optional step/start receipt; keeps historical prompt suffix independent of current state. */
export interface IntimacyStepReceipt {
  version: number;
  atMs: number;
  renderedLine: string;
  estrus?: boolean;
  phase?: IntimacyPhase;
}
