import type { EventLog } from '../log/event-log.js';
import type { AppEvent } from '../log/types.js';

// Keep the inexpensive shared path for short logs. Once either limit is
// exceeded, full reads are temporary and only overlap with active callers.
const MAX_CACHED_SEQ = 8192;
const MAX_CACHED_LOG_BYTES = 8 * 1024 * 1024;

interface EventSnapshot {
  upToSeq: number;
  events: AppEvent[];
  inflight: { throughSeq: number; result: Promise<readonly AppEvent[]> } | null;
}

const eventSnapshots = new WeakMap<EventLog, EventSnapshot>();

function fitsCache(log: EventLog): boolean {
  return log.latestSeq() <= MAX_CACHED_SEQ && log.sizeBytes() <= MAX_CACHED_LOG_BYTES;
}

/** Number of raw events retained by the shared cache. */
export function snapshotSizeOf(log: EventLog): number {
  return eventSnapshots.get(log)?.events.length ?? 0;
}

/**
 * Read the complete history through the seq observed by this caller.
 * Prefer a typed or ranged read when the caller needs a subset.
 */
export async function allEventsOf(log: EventLog): Promise<readonly AppEvent[]> {
  let snapshot = eventSnapshots.get(log);
  if (snapshot === undefined) {
    snapshot = { upToSeq: 0, events: [], inflight: null };
    eventSnapshots.set(log, snapshot);
  }

  const throughSeq = log.latestSeq();
  const pending = snapshot.inflight;
  if (pending !== null) {
    const events = await pending.result;
    return pending.throughSeq >= throughSeq ? events : allEventsOf(log);
  }

  const keep = fitsCache(log);
  if (!keep) {
    snapshot.events = [];
    snapshot.upToSeq = 0;
  } else if (throughSeq === snapshot.upToSeq) {
    return snapshot.events;
  }
  const target = snapshot;
  const fromSeq = target.upToSeq + 1;
  const result = (async (): Promise<readonly AppEvent[]> => {
    const events: AppEvent[] = [];
    for await (const event of log.readRange(fromSeq, { throughSeq })) events.push(event);
    if (!keep) return events;

    // Publish additions only after the entire range was read successfully.
    const previous = target.events;
    for (const event of events) previous.push(event);
    if (fitsCache(log)) {
      target.upToSeq = throughSeq;
    } else {
      target.events = [];
      target.upToSeq = 0;
    }
    return previous;
  })();
  target.inflight = { throughSeq, result };
  try {
    return await result;
  } finally {
    target.inflight = null;
  }
}

/** Read selected event types in seq order, through a fixed watermark. */
export async function readEventTypes(
  log: EventLog,
  types: readonly string[],
  throughSeq = log.latestSeq(),
  fromSeq = 1,
): Promise<readonly AppEvent[]> {
  const events: AppEvent[] = [];
  for await (const event of log.readRange(fromSeq, { throughSeq, types: new Set(types) })) events.push(event);
  return events;
}

export const readAllEvents = allEventsOf;
