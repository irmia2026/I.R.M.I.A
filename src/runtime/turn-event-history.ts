import type { EventLog } from '../log/event-log.js';
import type { AppEvent } from '../log/types.js';
import { readEventTypes } from '../state/event-snapshot.ts';

type EventFilter = (event: AppEvent) => boolean;

/**
 * Events that can still affect a turn after their seq has been covered by a summary.
 * The selected marker rows preserve turn numbering and the boundaries of render's
 * previous-step diagnostics. Full chronological history is read separately if a
 * new handoff note actually needs to be written.
 */
const COVERED_EVENT_TYPES = new Set<string>([
  'compaction/summary',
  'turn/start', 'turn/end', 'step/start',
  'timer/set', 'timer/cancelled',
  'human/asked', 'human/answered', 'human/expired',
  'input/requeued', 'injection/flagged', 'injection/noted',
  'budget/consumed',
]);

interface TurnEventHistory {
  events: AppEvent[];
  throughSeq: number;
  coveredSeq: number;
  reading: Promise<void> | null;
}

const histories = new WeakMap<EventLog, WeakMap<EventFilter, TurnEventHistory>>();

/** Keep the scope's visible tail and facts that survive context compaction. */
class CoveredHistory {
  private readonly kept: AppEvent[] = [];
  private readonly latestBudget = new Map<string, AppEvent>();
  private highestTurn: Extract<AppEvent, { type: 'turn/start' }> | undefined;
  private latestTurn: AppEvent | undefined;
  private turnBeforeStep: AppEvent | undefined;
  private latestTurnEnd: AppEvent | undefined;
  private latestStep: AppEvent | undefined;

  add(event: AppEvent): void {
    if (event.type === 'budget/consumed' && event.parentCallId === undefined) {
      this.latestBudget.set(event.data.lane, event);
    } else if (event.type === 'turn/start') {
      // maxTurn needs the largest number. The previous-step diagnostics need
      // the latest start and the latest start before the latest step.
      if (this.highestTurn === undefined || event.data.turn > this.highestTurn.data.turn) this.highestTurn = event;
      this.latestTurn = event;
    } else if (event.type === 'turn/end') {
      this.latestTurnEnd = event;
    } else if (event.type === 'step/start') {
      this.latestStep = event;
      this.turnBeforeStep = this.latestTurn;
    } else if (COVERED_EVENT_TYPES.has(event.type) && event.type !== 'budget/consumed') {
      this.kept.push(event);
    }
  }

  finish(): AppEvent[] {
    for (const event of new Set([this.highestTurn, this.latestTurn, this.turnBeforeStep])) {
      if (event !== undefined) this.kept.push(event);
    }
    for (const event of this.latestBudget.values()) this.kept.push(event);
    if (this.latestTurnEnd !== undefined) this.kept.push(this.latestTurnEnd);
    if (this.latestStep !== undefined) this.kept.push(this.latestStep);
    return this.kept.sort((a, b) => a.seq - b.seq);
  }
}

async function refresh(
  log: EventLog,
  filter: EventFilter,
  history: TurnEventHistory,
  throughSeq: number,
): Promise<void> {
  const fromSeq = history.throughSeq + 1;
  let coveredSeq = history.coveredSeq;
  const summaries = await readEventTypes(log, ['compaction/summary'], throughSeq, fromSeq);
  for (const summary of summaries) {
    if (summary.type === 'compaction/summary'
      && Number.isSafeInteger(summary.data.coveredUpToSeq) && filter(summary)) {
      coveredSeq = Math.max(coveredSeq, Math.min(summary.seq - 1, summary.data.coveredUpToSeq));
    }
  }

  let covered: CoveredHistory | undefined;
  const tail: AppEvent[] = [];
  if (coveredSeq > history.coveredSeq) {
    covered = new CoveredHistory();
    for (const event of history.events) {
      if (event.seq <= coveredSeq) covered.add(event);
      else tail.push(event);
    }
    if (fromSeq <= coveredSeq) {
      for await (const event of log.readRange(fromSeq, { throughSeq: coveredSeq, types: COVERED_EVENT_TYPES })) {
        if (filter(event)) covered.add(event);
      }
    }
  }
  for await (const event of log.readRange(Math.max(fromSeq, coveredSeq + 1), { throughSeq })) {
    if (filter(event)) tail.push(event);
  }
  // A failed read leaves the prior view and cursor intact for the next retry.
  if (covered !== undefined) {
    history.events = covered.finish().concat(tail);
    history.coveredSeq = coveredSeq;
  } else {
    for (const event of tail) history.events.push(event);
  }
  history.throughSeq = throughSeq;
}

/** 过滤规则在同一日志范围内须稳定。调用者接收自己的数组，事件对象只读共享。 */
export async function readTurnEventHistory(
  log: EventLog,
  filter: EventFilter,
): Promise<{ events: AppEvent[]; throughSeq: number; coveredSeq: number }> {
  let logHistories = histories.get(log);
  if (logHistories === undefined) {
    logHistories = new WeakMap<EventFilter, TurnEventHistory>();
    histories.set(log, logHistories);
  }
  let history = logHistories.get(filter);
  if (history === undefined) {
    history = { events: [], throughSeq: 0, coveredSeq: 0, reading: null };
    logHistories.set(filter, history);
  }
  const wantedSeq = log.latestSeq();
  while (history.throughSeq < wantedSeq) {
    const reading = history.reading ?? refresh(log, filter, history, wantedSeq);
    history.reading = reading;
    try {
      await reading;
    } finally {
      if (history.reading === reading) history.reading = null;
    }
  }
  return { events: history.events.slice(), throughSeq: history.throughSeq, coveredSeq: history.coveredSeq };
}
