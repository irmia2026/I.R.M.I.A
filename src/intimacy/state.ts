import {
  INTIMACY_LEVELS, INTIMACY_REASONS, INTIMACY_VERSION,
  type IntimacyAudience, type IntimacyCause, type IntimacyLevel, type IntimacyPhase,
  type IntimacyReasonCode, type IntimacyState, type IntimacyUpdatedData,
} from './types.ts';

export const INTIMACY_MAX = 100;
/** 满足余韵：1/分钟，约 100 分钟走完；避免「刚满足就没了」。 */
export const SATISFACTION_DECAY_PER_MINUTE = 1;
/** 满足高于这条线时，情欲被压住，不再增长；低于它才恢复。 */
export const SATISFACTION_HOLD_THRESHOLD = 15;
/** 余韵期情欲向 0 收拢的速度（顶点那一下已经直接置 0，这里处理边界情况）。 */
export const AFTERGLOW_DESIRE_DROP_PER_MINUTE = 3;
/** 普通日常：0.08/分钟 ≈ 20.8 小时从 0 到 100，正常一天一到两次发情。 */
export const DESIRE_RISE_PER_MINUTE = 0.08;
/** 普通日常克制：0.06/分钟；满情欲后靠下面的加速下降清掉。 */
export const RESTRAINT_RISE_PER_MINUTE = 0.06;
export const FULL_DESIRE_RESTRAINT_DROP_PER_MINUTE = 2;
export const FULL_DESIRE_ACCEL_EVERY_MINUTES = 10;
export const FULL_DESIRE_MAX_DROP_PER_MINUTE = 6;
export const SATISFACTION_REFRACTORY_MS = 60 * 60_000;
export const INTIMACY_DAILY_CAP = 2;
/** 深夜聊天的情欲累积倍率：23:00–05:00（本地时区）。 */
export const LATE_NIGHT_DESIRE_MULTIPLIER = 4;
export const LATE_NIGHT_FROM_HOUR = 23;
export const LATE_NIGHT_TO_HOUR = 5;

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const finite = (value: unknown, where: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError(`invalid ${where}`);
  return value;
};
const range = (value: unknown, where: string): number => {
  const n = finite(value, where);
  if (n < 0 || n > INTIMACY_MAX) throw new RangeError(`invalid ${where}`);
  return n;
};
const integer = (value: unknown, where: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RangeError(`invalid ${where}`);
  return value as number;
};

/** Local calendar day in the configured timezone (not UTC). */
export function dayKeyOf(atMs: number, timezone = 'Asia/Shanghai'): string {
  integer(atMs, 'atMs');
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(atMs));
  } catch {
    return new Date(atMs).toISOString().slice(0, 10);
  }
}

/** Local hour in the configured timezone. */
export function localHourOf(atMs: number, timezone = 'Asia/Shanghai'): number {
  integer(atMs, 'atMs');
  try {
    const part = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(atMs)).find((p) => p.type === 'hour');
    const hour = Number(part?.value);
    return Number.isFinite(hour) ? hour : new Date(atMs).getUTCHours();
  } catch {
    return new Date(atMs).getUTCHours();
  }
}

/** 深夜聊天的情欲倍率；普通时段为 1。 */
export function desireMultiplierAt(atMs: number, timezone = 'Asia/Shanghai'): number {
  const hour = localHourOf(atMs, timezone);
  return hour >= LATE_NIGHT_FROM_HOUR || hour < LATE_NIGHT_TO_HOUR
    ? LATE_NIGHT_DESIRE_MULTIPLIER
    : 1;
}

export function initialIntimacy(atMs = 0): IntimacyState {
  integer(atMs, 'atMs');
  return {
    version: INTIMACY_VERSION,
    atMs,
    intimacy: 0,
    desire: 0,
    satisfaction: 0,
    restraint: 0,
    lastAudience: null,
    lastPrivateAtMs: null,
    refractoryUntilMs: 0,
    intimacyDay: null,
    intimacyGainedToday: 0,
    desireFullSinceMs: null,
    afterglow: false,
    causes: [],
  };
}

function assertAudience(value: unknown): asserts value is IntimacyAudience {
  if (value !== 'owner' && value !== 'group' && value !== 'other') throw new RangeError('invalid audience');
}
function assertReason(value: unknown): asserts value is IntimacyReasonCode {
  if (!(INTIMACY_REASONS as readonly string[]).includes(value as string)) throw new RangeError('invalid reasonCode');
}
function assertCause(cause: unknown): asserts cause is { reasonCode: IntimacyReasonCode; strength: number } {
  if (cause === null || typeof cause !== 'object' || Array.isArray(cause)) throw new RangeError('invalid cause');
  const item = cause as Record<string, unknown>;
  assertReason(item['reasonCode']);
  range(item['strength'], 'cause.strength');
}

export function assertIntimacyState(value: unknown): asserts value is IntimacyState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RangeError('invalid intimacy state');
  const s = value as Record<string, unknown>;
  if (s['version'] !== INTIMACY_VERSION) throw new RangeError('unsupported intimacy state version');
  for (const key of ['atMs', 'refractoryUntilMs', 'lastPrivateAtMs', 'desireFullSinceMs']) {
    const item = s[key];
    if (item !== null) integer(item, key);
  }
  for (const key of ['intimacy', 'desire', 'satisfaction', 'restraint']) range(s[key], key);
  if (s['afterglow'] !== undefined && typeof s['afterglow'] !== 'boolean') throw new RangeError('invalid afterglow');
  if (s['lastAudience'] !== null) assertAudience(s['lastAudience']);
  if (s['intimacyDay'] !== null && typeof s['intimacyDay'] !== 'string') throw new RangeError('invalid intimacyDay');
  if (typeof s['intimacyGainedToday'] !== 'number' || !Number.isFinite(s['intimacyGainedToday'] as number)
    || (s['intimacyGainedToday'] as number) < 0 || (s['intimacyGainedToday'] as number) > INTIMACY_DAILY_CAP) {
    throw new RangeError('invalid intimacyGainedToday');
  }
  if (!Array.isArray(s['causes'])) throw new RangeError('invalid causes');
  for (const cause of s['causes'] as unknown[]) {
    if (cause === null || typeof cause !== 'object' || Array.isArray(cause)) throw new RangeError('invalid cause');
    const c = cause as Record<string, unknown>;
    integer(c['atMs'], 'cause.atMs');
    integer(c['sourceSeq'], 'cause.sourceSeq');
    assertReason(c['reasonCode']);
    range(c['strength'], 'cause.strength');
  }
}

export function assertIntimacyUpdated(data: IntimacyUpdatedData): void {
  integer(data.atMs, 'atMs');
  integer(data.sourceSeq, 'sourceSeq');
  if (data.sourceSeq <= 0) throw new RangeError('invalid sourceSeq');
  assertAudience(data.audience);
  for (const key of ['intimacy', 'desire', 'satisfaction', 'restraint'] as const) range(data[key], key);
  if (data.desireFullSinceMs !== undefined && data.desireFullSinceMs !== null) {
    integer(data.desireFullSinceMs, 'desireFullSinceMs');
  }
  if (data.afterglow !== undefined && typeof data.afterglow !== 'boolean') throw new RangeError('invalid afterglow');
  assertCause(data.cause);
}

/** Fold one update; event values are the archived result, never recomputed. */
export function applyIntimacyUpdated(
  state: IntimacyState,
  data: IntimacyUpdatedData,
  timezone = 'Asia/Shanghai',
): IntimacyState {
  assertIntimacyUpdated(data);
  const day = dayKeyOf(data.atMs, timezone);
  const sameDay = state.intimacyDay === day;
  const gained = sameDay ? state.intimacyGainedToday : 0;
  const delta = Math.max(0, data.intimacy - state.intimacy);
  const nextGained = sameDay ? Math.min(INTIMACY_DAILY_CAP, gained + delta) : Math.min(INTIMACY_DAILY_CAP, delta);
  const refractory = data.satisfaction > state.satisfaction
    ? data.atMs + SATISFACTION_REFRACTORY_MS
    : state.refractoryUntilMs;
  const cause: IntimacyCause = {
    atMs: data.atMs,
    sourceSeq: data.sourceSeq,
    reasonCode: data.cause.reasonCode,
    strength: data.cause.strength,
  };
  const causes = data.cause.strength > 0 ? [...state.causes, cause].slice(-8) : state.causes;
  // Old intimacy/updated events have no anchor: fold treats the missing field as null.
  const desireFullSinceMs = data.desireFullSinceMs === undefined || data.desireFullSinceMs === null
    ? null
    : data.desireFullSinceMs;
  const afterglow = data.afterglow ?? state.afterglow ?? false;
  return {
    ...state,
    atMs: data.atMs,
    intimacy: data.intimacy,
    desire: data.desire,
    satisfaction: data.satisfaction,
    restraint: data.restraint,
    lastAudience: data.audience,
    lastPrivateAtMs: data.audience === 'owner' ? data.atMs : state.lastPrivateAtMs,
    refractoryUntilMs: refractory,
    intimacyDay: day,
    intimacyGainedToday: nextGained,
    desireFullSinceMs,
    afterglow,
    causes,
  };
}

/**
 * Four-reading pure view. Projection stores only event values; API/render/engine
 * all use this evolved view, and the next event starts from it.
 */
export function evolveIntimacy(state: IntimacyState, nowMs: number): IntimacyState {
  integer(nowMs, 'nowMs');
  if (nowMs <= state.atMs) return state;
  const minutes = (nowMs - state.atMs) / 60_000;
  let satisfaction = state.satisfaction;
  let desire = state.desire;
  let restraint = state.restraint;

  let remaining = minutes;
  // 只有满足真正到过 100 才允许进入余韵；部分满足（例如 19）只累积/衰减，
  // 不得按“高潮后”压情欲。afterglow 由 applyIntent 在首次到顶时置位。
  let afterglow = state.afterglow === true;
  if (afterglow && satisfaction <= SATISFACTION_HOLD_THRESHOLD) afterglow = false;
  if (satisfaction > 0) {
    if (afterglow && satisfaction > SATISFACTION_HOLD_THRESHOLD) {
      const holdMinutes = Math.min(
        remaining,
        (satisfaction - SATISFACTION_HOLD_THRESHOLD) / SATISFACTION_DECAY_PER_MINUTE,
      );
      satisfaction = Math.max(0, satisfaction - SATISFACTION_DECAY_PER_MINUTE * holdMinutes);
      desire = Math.max(0, desire - AFTERGLOW_DESIRE_DROP_PER_MINUTE * holdMinutes);
      remaining -= holdMinutes;
      if (satisfaction <= SATISFACTION_HOLD_THRESHOLD) afterglow = false;
    }
    if (remaining > 0) {
      satisfaction = Math.max(0, satisfaction - SATISFACTION_DECAY_PER_MINUTE * remaining);
      desire += DESIRE_RISE_PER_MINUTE * remaining;
      restraint += RESTRAINT_RISE_PER_MINUTE * remaining;
      remaining = 0;
    }
    if (satisfaction <= 0) afterglow = false;
  }
  if (remaining > 0) {
    desire += DESIRE_RISE_PER_MINUTE * remaining;
    restraint += RESTRAINT_RISE_PER_MINUTE * remaining;
  }

  desire = clamp(desire, 0, INTIMACY_MAX);
  restraint = clamp(restraint, 0, INTIMACY_MAX);
  let desireFullSinceMs = state.desireFullSinceMs;
  if (desire >= INTIMACY_MAX) {
    if (desireFullSinceMs === null) desireFullSinceMs = state.atMs;
    const fullSince = Math.max(state.atMs, desireFullSinceMs);
    const fullMinutes = Math.max(0, (nowMs - fullSince) / 60_000);
    const rate = Math.min(
      FULL_DESIRE_MAX_DROP_PER_MINUTE,
      FULL_DESIRE_RESTRAINT_DROP_PER_MINUTE
        + Math.floor(fullMinutes / FULL_DESIRE_ACCEL_EVERY_MINUTES),
    );
    restraint = clamp(restraint - rate * fullMinutes, 0, INTIMACY_MAX);
  } else {
    desireFullSinceMs = null;
  }

  return {
    ...state,
    atMs: nowMs,
    desire,
    satisfaction: clamp(satisfaction, 0, INTIMACY_MAX),
    restraint,
    desireFullSinceMs,
    afterglow,
  };
}

export function estrusOf(state: IntimacyState): boolean {
  return state.desire >= INTIMACY_MAX && state.restraint <= 0;
}

export function phaseOf(state: IntimacyState): IntimacyPhase {
  if (estrusOf(state)) return 'estrus';
  if (state.satisfaction > 0) return 'warm';
  if (state.desire >= 70 && state.restraint < 35) return 'tense';
  return 'calm';
}

export function levelOf(value: number): IntimacyLevel {
  if (value >= 70) return 'strong';
  if (value >= 35) return 'obvious';
  return 'subtle';
}

export function levelRank(level: IntimacyLevel): number {
  return INTIMACY_LEVELS.indexOf(level);
}

export function capLevel(level: IntimacyLevel, maxLevel: IntimacyLevel): IntimacyLevel {
  return levelRank(level) <= levelRank(maxLevel) ? level : maxLevel;
}

export function effectiveLevel(state: IntimacyState, maxLevel: IntimacyLevel): IntimacyLevel {
  const raw = levelRank(levelOf(state.intimacy)) >= levelRank(levelOf(state.desire))
    ? levelOf(state.intimacy)
    : levelOf(state.desire);
  return capLevel(raw, maxLevel);
}

export function isRefractory(state: IntimacyState, nowMs: number): boolean {
  return state.refractoryUntilMs > nowMs;
}
