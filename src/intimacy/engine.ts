import { INTIMACY_MAX, dayKeyOf, desireMultiplierAt } from './state.ts';
import {
  type IntimacyIntent, type IntimacyReasonCode, type IntimacyState, type IntimacyUpdatedData,
} from './types.ts';

export interface IntimacyIntentInput {
  state: IntimacyState;
  nowMs: number;
  sourceSeq: number;
  intent: IntimacyIntent;
  strength: number;
  spontaneousChance: number;
  timezone: string;
  random?: () => number;
}

const clamp = (value: number): number => Math.max(0, Math.min(INTIMACY_MAX, value));

function sourceSeqOf(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('invalid sourceSeq');
  return value;
}

/**
 * Map one light-model intent onto the four readings. Pure: caller appends the returned event.
 * Boundary is checked first and applies even during a refractory window.
 */
export function applyIntent(input: IntimacyIntentInput): IntimacyUpdatedData | null {
  if (!Number.isFinite(input.strength) || input.strength < 0 || input.strength > 1) {
    throw new RangeError('invalid strength');
  }
  const now = input.nowMs;
  const s = input.state;
  const seq = sourceSeqOf(input.sourceSeq);
  const strength = input.strength;
  const day = dayKeyOf(now, input.timezone);
  const gained = s.intimacyDay === day ? s.intimacyGainedToday : 0;
  const intimacyRoom = Math.max(0, 2 - gained);
  const intimacyGain = Math.min(intimacyRoom, 2 * strength);

  let intimacy = s.intimacy;
  let desire = s.desire;
  let satisfaction = s.satisfaction;
  let restraint = s.restraint;
  let reasonCode: IntimacyReasonCode;
  let causeStrength = Math.round(strength * 100);
  const estrus = s.desire >= INTIMACY_MAX && s.restraint <= 0;
  const desireFactor = desireMultiplierAt(now, input.timezone);

  if (input.intent === 'boundary') {
    // The boundary always wins; no refractory/cooldown gate may swallow it.
    desire = clamp(desire - 25 * strength);
    restraint = clamp(restraint + 15 * strength);
    reasonCode = 'boundary';
  } else if (input.intent === 'closeness') {
    // 普通调情只推动一点情欲；深夜聊天按倍率加速。
    desire = clamp(desire + 4 * strength * desireFactor);
    intimacy = clamp(intimacy + intimacyGain);
    // 调情在没有发情时也会积累一点满足，但比直接性行为慢；发情后调情不再满足。
    satisfaction = clamp(satisfaction + (estrus ? 0 : 3 * strength));
    reasonCode = 'owner_closeness';
  } else if (input.intent === 'sexual_act') {
    // 被做性行为：未发情时情欲与满足一起涨，满足慢于情欲；发情后主要产生满足。
    desire = clamp(desire + (estrus ? 0 : 6 * strength * desireFactor));
    satisfaction = clamp(satisfaction + (estrus ? 20 : 15) * strength);
    intimacy = clamp(intimacy + intimacyGain);
    reasonCode = 'owner_sexual_act';
  } else if (input.intent === 'longing') {
    desire = clamp(desire + 6 * strength * desireFactor);
    intimacy = clamp(intimacy + intimacyGain);
    reasonCode = 'owner_longing';
  } else if (input.intent === 'satisfaction') {
    desire = clamp(desire + 2 * strength * desireFactor);
    satisfaction = clamp(satisfaction + 25 * strength);
    reasonCode = 'satisfied';
  } else {
    const random = input.random?.() ?? Math.random();
    if (!(input.spontaneousChance > 0 && random < input.spontaneousChance)) return null;
    desire = clamp(desire + 2 * desireFactor);
    reasonCode = 'spontaneous';
    causeStrength = 5;
  }

  // 满足条第一次到顶：快速削减情欲，进入满足状态。
  // 之后由 evolveIntimacy 在满足高于阈值时继续压住情欲。
  if (s.satisfaction < INTIMACY_MAX && satisfaction >= INTIMACY_MAX) {
    desire = 0;
    restraint = 0;
  }

  return {
    atMs: now,
    sourceSeq: seq,
    audience: 'owner',
    intimacy,
    desire,
    satisfaction,
    restraint,
    desireFullSinceMs: desire >= INTIMACY_MAX ? (s.desireFullSinceMs ?? now) : null,
    cause: {reasonCode, strength: causeStrength},
  };
}
