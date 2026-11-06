/**
 * linre-affect — 情绪核心（纯函数，零依赖）
 *
 * 与上游 `src/affect/engine.ts` 同一套语义，但**没有**位图去重与事件折叠：
 * 去重由宿主的 sourceSeq 单调性保证（worker 只记 lastSeq），折叠由
 * `linre-affect.appraised` 事件在需要时重放。
 *
 * 这里只做三件事：算冲动、随时间衰减、渲染一行字。
 */

export const EMOTIONS = ['joy', 'distress', 'concern', 'irritation', 'warmth', 'shyness'];

/** 半衰期（分钟）；与上游一致。 */
export const HALF_LIFE_MIN = { joy: 45, distress: 120, concern: 90, irritation: 30, warmth: 240, shyness: 40 };

const LABELS = { joy: '愉快', distress: '低落', concern: '关切', irritation: '不悦', warmth: '亲近', shyness: '害羞' };

/** 此刻层只留 8~15 字的短行为。 */
const SHORT_BEHAVIOR = {
  joy: { light: '轻快，句尾带点俏皮', obvious: '话变多，主动分享', strong: '表达热烈，连发两条' },
  warmth: { light: '温和，多应一句', obvious: '语气放软，主动关心', strong: '黏人，语气明显软' },
  concern: { light: '多留意对方状态', obvious: '先问一句，语速放慢', strong: '注意力全放对方' },
  irritation: { light: '话少，语气硬一点', obvious: '回复变短，带一点刺', strong: '短句反问，不骂人' },
  distress: { light: '平淡，不太热络', obvious: '提不起劲，句子变短', strong: '几乎不想多说' },
  shyness: { light: '有点不自在，语气软下来', obvious: '想躲眼神，嘴上不承认', strong: '句子变短，想藏又想留' },
};

export const MAX_AFFECT_LINE_CHARS = 90;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const pos = (value) => Math.max(value, 0);
const neg = (value) => Math.max(-value, 0);

export function emptyVector() {
  return { joy: 0, distress: 0, concern: 0, irritation: 0, warmth: 0, shyness: 0 };
}

export function emptyState(atMs = 0) {
  return { atMs, mood: { valence: 0.2, arousal: 0.35 }, emotions: emptyVector(), causes: [], lastSeq: 0 };
}

/** 纯视图：时钟推移不改状态本身（调用方决定何时落盘）。 */
export function affectAt(state, nowMs) {
  const effective = Math.max(state.atMs, nowMs);
  const dt = (effective - state.atMs) / 60_000;
  const emotions = emptyVector();
  for (const key of EMOTIONS) emotions[key] = (state.emotions[key] ?? 0) * Math.pow(2, -dt / HALF_LIFE_MIN[key]);
  const mood = {
    valence: 0.2 + (state.mood.valence - 0.2) * Math.pow(2, -dt / 480),
    arousal: 0.35 + (state.mood.arousal - 0.35) * Math.pow(2, -dt / 240),
  };
  const causes = state.causes.filter((cause) => effective - cause.evaluatedAtMs < 24 * 60 * 60_000);
  return { ...state, atMs: effective, mood, emotions, causes };
}

/**
 * 九维评价 → 六维冲动。
 *
 * `empathy` 与上游同义（默认 0.8）：它压住"别人的事"对"我的情绪"的传导。
 */
export function computeImpulse(appraisal, sourceWeight = 1, empathy = 0.8) {
  const weight = clamp(Number(sourceWeight) || 0, 0, 1);
  const r = clamp(Number(appraisal.r) || 0, 0, 1);
  const q = clamp(Number(appraisal.q) || 0, 0, 1);
  const L = r * q * weight;
  return {
    joy: clamp(L * (0.8 * pos(appraisal.s) + 0.35 * empathy * pos(appraisal.u)), 0, 1),
    distress: clamp(0.85 * L * neg(appraisal.s) * (1 - 0.3 * (appraisal.c ?? 0)), 0, 1),
    concern: clamp(0.85 * L * neg(appraisal.u) * (0.6 + 0.4 * (appraisal.z ?? 0)), 0, 1),
    irritation: clamp(0.75 * L * neg(appraisal.g) * (appraisal.b ?? 0) * (0.5 + 0.5 * (appraisal.c ?? 0)), 0, 1),
    warmth: clamp(0.8 * L * pos(appraisal.g), 0, 1),
    shyness: clamp(0.7 * L * (0.55 * pos(appraisal.g) + 0.45 * pos(appraisal.u)) * (1 - 0.5 * (appraisal.c ?? 0)), 0, 1),
  };
}

/**
 * 叠加一次冲动。
 *
 * 返回**新状态**，不改入参；`sourceSeq` 只前进不后退（幂等）。
 */
export function applyImpulse(state, impulse, options) {
  const atMs = options.atMs;
  const sourceSeq = options.sourceSeq;
  if (!Number.isFinite(atMs)) throw new Error('invalid atMs');
  if (!Number.isSafeInteger(sourceSeq) || sourceSeq <= 0) throw new Error('invalid sourceSeq');
  if (sourceSeq <= state.lastSeq) return state;
  const base = affectAt(state, atMs);
  const emotions = emptyVector();
  for (const key of EMOTIONS) {
    const old = base.emotions[key] ?? 0;
    emotions[key] = clamp(old + (1 - old) * (impulse[key] ?? 0), 0, 1);
  }
  const mood = {
    valence: clamp(base.mood.valence + 0.12 * (impulse.joy + 0.5 * impulse.warmth - impulse.distress - 0.5 * impulse.irritation - 0.35 * impulse.concern), -1, 1),
    arousal: clamp(base.mood.arousal + 0.1 * (0.5 * impulse.joy + 0.6 * impulse.irritation + 0.6 * impulse.concern + 0.5 * impulse.shyness - 0.4 * impulse.distress), 0, 1),
  };
  const dominant = EMOTIONS.reduce((a, b) => (impulse[b] > impulse[a] ? b : a), EMOTIONS[0]);
  const strength = Math.max(...EMOTIONS.map((key) => impulse[key]));
  const causes = strength < 0.08
    ? base.causes
    : [...base.causes, { sourceSeq, reasonCode: options.reasonCode ?? 'general', dominantEmotion: dominant, strength, evaluatedAtMs: base.atMs }]
      .sort((a, b) => a.evaluatedAtMs - b.evaluatedAtMs || a.sourceSeq - b.sourceSeq)
      .slice(-8);
  return { ...base, emotions, mood, causes, lastSeq: sourceSeq };
}

const band = (value) => (value >= 0.65 ? 'strong' : value >= 0.35 ? 'obvious' : 'light');
const level = (value) => (value >= 0.65 ? '强烈' : value >= 0.35 ? '明显' : '轻微');

/** 渲染此刻层那一行；≤ `MAX_AFFECT_LINE_CHARS`，无情绪时给"平稳"。 */
export function renderLine(state, nowMs = state.atMs) {
  const at = affectAt(state, nowMs);
  const active = EMOTIONS
    .map((key) => ({ key, value: at.emotions[key] ?? 0 }))
    .filter((entry) => entry.value >= 0.15)
    .sort((a, b) => b.value - a.value || EMOTIONS.indexOf(a.key) - EMOTIONS.indexOf(b.key))
    .slice(0, 2);
  if (active.length === 0) return '情绪：平稳。';
  const main = active[0];
  const second = active[1];
  const mixed = second === undefined ? '' : `·微带${LABELS[second.key]}`;
  const unwelcome = at.causes.some((cause) => cause.reasonCode === 'unwelcome_advance'
    && cause.strength >= 0.08 && at.atMs - cause.evaluatedAtMs < 6 * 60 * 60_000);
  const behavior = unwelcome ? '冷下来，短句拒绝' : SHORT_BEHAVIOR[main.key][band(main.value)];
  const line = `情绪：${level(main.value)}${LABELS[main.key]}${mixed} → ${behavior}。`;
  return [...line].length <= MAX_AFFECT_LINE_CHARS ? line : [...line].slice(0, MAX_AFFECT_LINE_CHARS).join('');
}
