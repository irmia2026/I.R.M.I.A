import type { AppConfig } from '../config/config.ts';
import type { AppEvent, Projection } from '../log/types.js';
import {
  applyIntimacyUpdated, effectiveLevel, estrusOf, evolveIntimacy, initialIntimacy, levelOf, phaseOf,
} from '../intimacy/state.ts';
import { renderIntimacyNow } from '../intimacy/render.ts';
import type {
  IntimacyLevel, IntimacyPhase, IntimacyReasonCode, IntimacyState,
} from '../intimacy/types.ts';

export const INTIMACY_HISTORY_LIMIT = 400;

export const INTIMACY_REASON_LABELS: Record<IntimacyReasonCode, string> = {
  owner_closeness: '用户靠近',
  owner_longing: '久别/想念',
  owner_sexual_act: '直接亲密',
  late_night: '深夜',
  owner_return: '再次独处',
  satisfied: '满足',
  boundary: '边界尝试',
  left_private: '离开私聊',
  spontaneous: '自主靠近',
  general: '近期经历',
};

export interface IntimacyLabels {
  intimacy: '平稳' | '轻微' | '明显' | '强烈';
  desire: '平稳' | '轻微' | '明显' | '强烈';
  satisfaction: '平稳' | '轻微' | '明显' | '强烈';
  restraint: '平稳' | '轻微' | '明显' | '强烈';
}

const LEVEL_LABELS: Record<IntimacyLevel, '轻微' | '明显' | '强烈'> = {
  subtle: '轻微', obvious: '明显', strong: '强烈',
};

/** Real value labels, never capped by maxLevel (maxLevel only caps 亲密/情欲 expression). */
export function intimacyLabels(state: IntimacyState): IntimacyLabels {
  const one = (value: number): '平稳' | '轻微' | '明显' | '强烈' =>
    value < 15 ? '平稳' : LEVEL_LABELS[levelOf(value)];
  return {
    intimacy: one(state.intimacy),
    desire: one(state.desire),
    satisfaction: one(state.satisfaction),
    restraint: one(state.restraint),
  };
}

export interface IntimacyView {
  enabled: boolean;
  configured: boolean;
  privateOnly: true;
  maxLevel: 'subtle' | 'obvious' | 'strong';
  atMs: number;
  updatedAt: string | null;
  intimacy: number;
  desire: number;
  satisfaction: number;
  restraint: number;
  level: 'subtle' | 'obvious' | 'strong';
  estrus: boolean;
  phase: IntimacyPhase;
  labels: IntimacyLabels;
  line: string | null;
  renderLine: string | null;
  causes: Array<{ atMs: number; reasonCode: IntimacyReasonCode; strength: number; label: string }>;
  history: Array<{ atMs: number; intimacy: number; desire: number; satisfaction: number; restraint: number }>;
}

function historyOf(events: readonly AppEvent[], limit = INTIMACY_HISTORY_LIMIT): IntimacyView['history'] {
  let state = initialIntimacy(0);
  const points: IntimacyView['history'] = [];
  for (const event of events) {
    if (event.type !== 'intimacy/updated') continue;
    try {
      state = applyIntimacyUpdated(state, event.data);
    } catch {
      continue;
    }
    points.push({
      atMs: state.atMs,
      intimacy: state.intimacy,
      desire: state.desire,
      satisfaction: state.satisfaction,
      restraint: state.restraint,
    });
  }
  return points.slice(-limit);
}

export function buildIntimacyView(input: {
  config: AppConfig;
  configured: boolean;
  projection: Projection;
  events: readonly AppEvent[];
  now: string;
}): IntimacyView {
  const enabled = input.config.intimacy.enabled === true;
  const state: IntimacyState = input.projection.intimacy;
  const nowMs = Date.parse(input.now);
  const viewState = Number.isFinite(nowMs) ? evolveIntimacy(state, nowMs) : state;
  const latest = [...input.events].reverse().find((event) => event.type === 'intimacy/updated');
  let line: string | null = null;
  if (enabled && Number.isFinite(nowMs)) {
    try {
      line = renderIntimacyNow(viewState, {maxLevel: input.config.intimacy.maxLevel, nowMs});
    } catch {
      line = null;
    }
  }
  return {
    enabled,
    configured: input.configured,
    privateOnly: true,
    maxLevel: input.config.intimacy.maxLevel,
    atMs: state.atMs,
    updatedAt: latest?.ts ?? null,
    intimacy: viewState.intimacy,
    desire: viewState.desire,
    satisfaction: viewState.satisfaction,
    restraint: viewState.restraint,
    level: effectiveLevel(viewState, input.config.intimacy.maxLevel),
    estrus: estrusOf(viewState),
    phase: phaseOf(viewState),
    labels: intimacyLabels(viewState),
    line,
    renderLine: line,
    causes: [...state.causes]
      .sort((a, b) => b.atMs - a.atMs || b.sourceSeq - a.sourceSeq)
      .slice(0, 5)
      .map((cause) => ({
        atMs: cause.atMs,
        reasonCode: cause.reasonCode,
        strength: cause.strength,
        label: INTIMACY_REASON_LABELS[cause.reasonCode] ?? '近期经历',
      })),
    history: enabled ? historyOf(input.events) : [],
  };
}
