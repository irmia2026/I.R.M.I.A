/**
 * Timer payload policy shared by schedule projection and runtime delivery guards.
 *
 * This module intentionally has no runtime, filesystem, or tool imports: the same
 * payload rule must be usable by render/projection code without creating a cycle.
 */

export const TIMER_SELF_SCOPE = 'self' as const;
export const TIMER_FRAMEWORK_CHORE_KINDS: readonly string[] = ['memory-maintain'];

/**
 * A human-created entry remains owner-facing even if it also carries scope:self.
 * Unknown and legacy payload shapes keep the historical owner-facing default.
 */
export function isOwnerFacingTimer(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return true;
  const record = payload as Record<string, unknown>;
  if (record['by'] === 'human') return true;
  if (record['scope'] === TIMER_SELF_SCOPE) return false;
  const kind = record['kind'];
  if (typeof kind === 'string' && TIMER_FRAMEWORK_CHORE_KINDS.includes(kind)) return false;
  return true;
}

/** A wake/timer payload is internal when it is not owner-facing. */
export function isInternalTimerPayload(payload: unknown): boolean {
  return !isOwnerFacingTimer(payload);
}

/**
 * A turn is eligible for the internal-timer delivery guard only when every
 * claimed wake is a non-owner-facing timer. Mixed turns retain normal delivery.
 */
export function isPureInternalTimerBatch(
  events: readonly { type: string; data: unknown }[],
): boolean {
  return events.length > 0 && events.every((event) => {
    if (event.type !== 'wake/timer') return false;
    const data = event.data;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
    return isInternalTimerPayload((data as Record<string, unknown>)['payload']);
  });
}
