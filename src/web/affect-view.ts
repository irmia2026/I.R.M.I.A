import { foldAffectEvents, prepareAffectStep } from '../affect/adapter.ts';
// 值导入写 `.ts`（Node 的 --experimental-strip-types 不改写扩展名；编译时由 rewriteRelativeImportExtensions 换回 .js）
import { EMOTIONS, REASONS, type EmotionName, type EmotionVector, type ReasonCode } from '../affect/types.ts';
import { affectEnabled, type AppConfig } from '../config/config.ts';
import type { AffectAppraised, AppEvent, Projection } from '../log/types.js';

/** 心境轨迹上的一个点：某次评价落下之后那一刻的累计状态。 */
export interface AffectHistoryPoint {
  atMs: number;
  valence: number;
  arousal: number;
  dominant: EmotionName;
  /** 这一拍评价的原因码（与 causes 同一套词表；未知码归一成 general） */
  reasonCode: ReasonCode;
  /** 这一拍的主导情绪强度（折叠后 `state.emotions[dominant]`，0..1） */
  strength: number;
}

/** 轨迹最多返回多少个点：够画一条"今天/近 7 天"的线，又不至于让响应体无限长。 */
export const AFFECT_HISTORY_LIMIT = 400;

export interface AffectView {
  enabled: boolean;
  configured: boolean;
  /** 评价器开关（enabled=true 但它为 false 时不会有新评价，界面要如实说） */
  evaluatorEnabled: boolean;
  atMs: number | null;
  updatedAt: string | null;
  emotions: EmotionVector;
  mood: { valence: number; arousal: number };
  causes: Array<{
    reasonCode: ReasonCode;
    dominantEmotion: EmotionName;
    strength: number;
    evaluatedAtMs: number;
  }>;
  /**
   * 每次都评价之后的心境快照（按时间升序，最多 [AFFECT_HISTORY_LIMIT] 点）。
   *
   * 为什么在这里算而不是让界面自己折：折叠的判据（半衰期、冲动、主导情绪）只有
   * `affect/adapter.ts` 一份，界面若自算就会长出第二套公式。这里用
   * `foldAffectEvents` 的逐条回调一次线性折完，既拿到每个时点，又不重复判据。
   */
  history: AffectHistoryPoint[];
  neutral: boolean;
  renderLine: string | null;
}

/** 累计折叠 `affect/appraised` 事件，产出每个时点的轨迹（只保留最后 [limit] 个点）。 */
export function buildAffectHistory(
  events: readonly AppEvent[],
  limit = AFFECT_HISTORY_LIMIT,
): AffectHistoryPoint[] {
  const appraised = events.filter((event): event is AffectAppraised => event.type === 'affect/appraised');
  if (appraised.length === 0) return [];
  const points: AffectHistoryPoint[] = [];
  // onState 与事件一一对应、按同一顺序回调；cursor 把每个快照映射回它那条事件的原因码。
  let cursor = 0;
  foldAffectEvents(appraised.map((event) => event.data), 0, (state) => {
    const source = appraised[cursor]?.data;
    cursor += 1;
    let dominant: EmotionName = EMOTIONS[0];
    for (const name of EMOTIONS) {
      if (state.emotions[name] > state.emotions[dominant]) dominant = name;
    }
    const rawReason = source?.reasonCode ?? 'general';
    const reasonCode = (REASONS as readonly string[]).includes(rawReason)
      ? (rawReason as ReasonCode)
      : 'general';
    points.push({
      atMs: state.atMs,
      valence: state.mood.valence,
      arousal: state.mood.arousal,
      dominant,
      reasonCode,
      strength: state.emotions[dominant],
    });
  });
  // 事件在日志里按 seq 追加，正常情况下已经是升序；这里再按 atMs 稳定排一次，
  // 免得时钟回拨留下的"早评价写在晚评价后面"让折线倒着画。
  points.sort((a, b) => a.atMs - b.atMs);
  return points.slice(-limit);
}

export function buildAffectView(input: {
  config: AppConfig;
  configured: boolean;
  projection: Projection;
  events: readonly AppEvent[];
  now: string;
  env?: Record<string, string | undefined>;
}): AffectView {
  const enabled = affectEnabled(input.config, input.env ?? process.env);
  const prepared = enabled ? prepareAffectStep(input.projection.affect, input.now) : null;
  const state = prepared?.state ?? input.projection.affect;
  const latest = [...input.events].reverse().find((event) => event.type === 'affect/appraised');
  return {
    enabled,
    configured: input.configured,
    evaluatorEnabled: input.config.affect?.evaluatorEnabled === true,
    atMs: latest === undefined ? null : input.projection.affect.atMs,
    updatedAt: latest?.ts ?? null,
    emotions: { ...state.emotions },
    mood: { ...state.mood },
    causes: [...state.causes]
      .sort((a, b) => b.evaluatedAtMs - a.evaluatedAtMs || b.sourceSeq - a.sourceSeq)
      .slice(0, 5)
      .map((cause) => ({
        reasonCode: cause.reasonCode,
        dominantEmotion: cause.dominantEmotion,
        strength: cause.strength,
        evaluatedAtMs: cause.evaluatedAtMs,
      })),
    history: enabled ? buildAffectHistory(input.events) : [],
    neutral: Object.values(state.emotions).every((value) => value < 0.15),
    renderLine: prepared?.renderedLine ?? null,
  };
}
