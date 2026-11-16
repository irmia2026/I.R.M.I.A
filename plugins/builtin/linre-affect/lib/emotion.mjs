export const DIMENSIONS = [
  'joy',
  'sadness',
  'anger',
  'anxiety',
  'longing',
  'trust',
  'pride',
  'shame',
  'curiosity',
];

export const REASON_CODES = [
  'owner_care',
  'owner_tease',
  'owner_setback',
  'owner_success',
  'ignored_long',
  'unwelcome_advance',
  'curious_topic',
  'calm_chat',
];

export const BASELINE = {
  joy: 0.15,
  sadness: 0.05,
  anger: 0.0,
  anxiety: 0.05,
  longing: 0.10,
  trust: 0.50,
  pride: 0.10,
  shame: 0.0,
  curiosity: 0.25,
};

export const HALF_LIFE_MIN = {
  joy: 45,
  sadness: 120,
  anger: 30,
  anxiety: 60,
  longing: 180,
  trust: 360,
  pride: 60,
  shame: 40,
  curiosity: 90,
};

export const DIMENSION_LABEL_CN = {
  joy: '喜悦',
  sadness: '低落',
  anger: '恼怒',
  anxiety: '焦虑',
  longing: '挂念',
  trust: '信任',
  pride: '得意',
  shame: '羞赧',
  curiosity: '好奇',
};

export const REASON_LABEL_CN = {
  owner_care: '被关心',
  owner_tease: '被调侃',
  owner_setback: '遇到挫折',
  owner_success: '有所成就',
  ignored_long: '被晾着',
  unwelcome_advance: '越界搭讪',
  curious_topic: '新鲜话题',
  calm_chat: '日常闲聊',
};

const REASON_PHRASE = {
  owner_care: '刚被关心过',
  owner_tease: '刚被调侃完',
  owner_setback: '刚遇到点挫折',
  owner_success: '刚做成一件事',
  ignored_long: '晾了好久没理',
  unwelcome_advance: '有人越界搭讪',
  curious_topic: '聊到新鲜话题',
  calm_chat: '',
};

const PRIMARY_DIMENSIONS = ['joy', 'sadness', 'anger', 'anxiety', 'longing', 'pride', 'shame'];

const PRIMARY_PHRASES = {
  joy: { light: '有点开心', mid: '挺开心', strong: '特别开心', noun: '开心' },
  sadness: { light: '有点低落', mid: '明显低落', strong: '很难过', noun: '低落' },
  anger: { light: '微恼', mid: '有点生气', strong: '很火大', noun: '恼火' },
  anxiety: { light: '有点担心', mid: '有些焦虑', strong: '很不安', noun: '担心' },
  longing: { light: '有点挂念', mid: '很惦记', strong: '满心挂念', noun: '挂念' },
  pride: { light: '有点小得意', mid: '挺得意', strong: '特别自豪', noun: '得意' },
  shame: { light: '有点害羞', mid: '有些不好意思', strong: '脸红羞赧', noun: '害羞' },
};

export const MAX_AFFECT_LINE_CHARS = 160;
const NEUTRAL_DELTA_THRESHOLD = 0.08;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const pos = (value) => Math.max(value, 0);
const neg = (value) => Math.max(-value, 0);

export function snap05(value) {
  const clamped = clamp(Number(value) || 0, 0, 1);
  return Number((Math.round(clamped * 20) / 20).toFixed(2));
}

export function emptyDimensions() {
  return { ...BASELINE };
}

export function emptyState(atMs = 0) {
  return {
    atMs,
    mood: { valence: 0.2, arousal: 0.35 },
    dimensions: emptyDimensions(),
    causes: [],
    lastSeq: 0,
  };
}

function legacyToDimensions(parsed) {
  const r = clamp(Number(parsed.r) || 0, 0, 1);
  const q = clamp(Number(parsed.q) || 0, 0, 1);
  const L = r * q;
  const s = clamp(Number(parsed.s) || 0, -1, 1);
  const u = clamp(Number(parsed.u) || 0, -1, 1);
  const g = clamp(Number(parsed.g) || 0, -1, 1);
  const b = clamp(Number(parsed.b) || 0, 0, 1);
  const n = clamp(Number(parsed.n) || 0, 0, 1);
  const z = clamp(Number(parsed.z) || 0, 0, 1);
  const c = clamp(Number(parsed.c) || 0, 0, 1);
  return {
    joy: snap05(L * (0.8 * pos(s) + 0.35 * 0.8 * pos(u))),
    sadness: snap05(0.85 * L * neg(s) * (1 - 0.3 * c)),
    anger: snap05(0.75 * L * neg(g) * b * (0.5 + 0.5 * c)),
    anxiety: snap05(0.85 * L * neg(u) * (0.6 + 0.4 * z)),
    longing: snap05(0.6 * L * pos(g)),
    trust: snap05(0.5 + 0.4 * L * g),
    pride: snap05(0.6 * L * pos(s) * c),
    shame: snap05(0.65 * L * (0.55 * pos(g) + 0.45 * pos(u)) * (1 - 0.5 * c)),
    curiosity: snap05(0.8 * L * n),
  };
}

export function normalizeAppraisal(raw, actorTier = 'owner') {
  let parsed = raw;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  let dimensions = null;
  const hasAll9 = DIMENSIONS.every((key) => typeof parsed[key] === 'number' && Number.isFinite(parsed[key]));
  if (hasAll9) {
    dimensions = {};
    for (const key of DIMENSIONS) {
      dimensions[key] = snap05(parsed[key]);
    }
  } else if (['r', 's', 'u', 'g', 'b', 'n', 'z', 'c', 'q'].every((key) => typeof parsed[key] === 'number' && Number.isFinite(parsed[key]))) {
    dimensions = legacyToDimensions(parsed);
  } else {
    return null;
  }

  let reasonCode = typeof parsed.reasonCode === 'string' && REASON_CODES.includes(parsed.reasonCode)
    ? parsed.reasonCode
    : 'calm_chat';

  if (actorTier !== 'owner' && reasonCode === 'unwelcome_advance') {
    dimensions.joy = 0;
    dimensions.longing = 0;
    dimensions.trust = 0;
    dimensions.anger = snap05(Math.max(dimensions.anger, 0.6));
    dimensions.anxiety = snap05(Math.max(dimensions.anxiety, 0.35));
  }

  return { dimensions, reasonCode };
}

export function affectAt(state, nowMs) {
  const safeState = state && typeof state === 'object' ? state : emptyState(nowMs);
  const startAt = Number.isFinite(safeState.atMs) ? safeState.atMs : nowMs;
  const effective = Math.max(startAt, nowMs);
  const dt = (effective - startAt) / 60_000;
  const dimensions = emptyDimensions();
  const srcDims = safeState.dimensions && typeof safeState.dimensions === 'object' ? safeState.dimensions : {};
  for (const key of DIMENSIONS) {
    const base = BASELINE[key];
    const current = Number.isFinite(srcDims[key]) ? Number(srcDims[key]) : base;
    dimensions[key] = clamp(base + (current - base) * Math.pow(2, -dt / HALF_LIFE_MIN[key]), 0, 1);
  }
  const srcMood = safeState.mood && typeof safeState.mood === 'object' ? safeState.mood : { valence: 0.2, arousal: 0.35 };
  const mood = {
    valence: clamp(0.2 + (Number(srcMood.valence ?? 0.2) - 0.2) * Math.pow(2, -dt / 480), -1, 1),
    arousal: clamp(0.35 + (Number(srcMood.arousal ?? 0.35) - 0.35) * Math.pow(2, -dt / 240), 0, 1),
  };
  const srcCauses = Array.isArray(safeState.causes) ? safeState.causes : [];
  const causes = srcCauses.filter((cause) => cause && effective - Number(cause.evaluatedAtMs ?? 0) < 24 * 60 * 60_000);
  return {
    atMs: effective,
    dimensions,
    mood,
    causes,
    lastSeq: Number.isSafeInteger(safeState.lastSeq) ? safeState.lastSeq : 0,
  };
}

function deriveMood(dimensions, fallbackMood) {
  const posScore = 0.45 * dimensions.joy
    + 0.30 * dimensions.pride
    + 0.25 * Math.max(0, dimensions.trust - 0.4)
    + 0.15 * Math.max(0, dimensions.curiosity - 0.2);
  const negScore = 0.50 * dimensions.sadness
    + 0.50 * dimensions.anger
    + 0.35 * dimensions.anxiety
    + 0.25 * dimensions.shame;
  const valence = clamp(0.2 + (posScore - negScore) * 0.9, -1, 1);
  const arousal = clamp(
    0.30
    + 0.35 * dimensions.anger
    + 0.30 * dimensions.anxiety
    + 0.25 * dimensions.joy
    + 0.20 * dimensions.curiosity
    + 0.15 * dimensions.pride
    - 0.20 * dimensions.sadness,
    0,
    1,
  );
  if (!Number.isFinite(valence) || !Number.isFinite(arousal)) return fallbackMood;
  return { valence, arousal };
}

export function applyAppraisal(state, appraisal, options) {
  const atMs = options.atMs;
  const sourceSeq = options.sourceSeq;
  if (!Number.isFinite(atMs)) throw new Error('invalid atMs');
  if (!Number.isSafeInteger(sourceSeq) || sourceSeq <= 0) throw new Error('invalid sourceSeq');
  if (sourceSeq <= (state.lastSeq ?? 0)) return state;

  const weight = clamp(Number(options.weight ?? 1), 0, 1);
  const actorTier = options.actorTier ?? 'owner';
  const base = affectAt(state, atMs);
  const dimensions = { ...base.dimensions };
  const sig = appraisal.dimensions;
  const isUnwelcomeNonOwner = actorTier !== 'owner' && appraisal.reasonCode === 'unwelcome_advance';

  for (const key of DIMENSIONS) {
    const prev = base.dimensions[key];
    const target = sig[key];
    if (isUnwelcomeNonOwner) {
      if (key === 'joy' || key === 'longing') {
        dimensions[key] = 0;
        continue;
      }
      if (key === 'trust') {
        dimensions[key] = clamp(prev - 0.15, 0, 1);
        continue;
      }
      if (key === 'anger' || key === 'anxiety') {
        const guardWeight = Math.max(weight, 0.6);
        dimensions[key] = clamp(prev + (1 - prev) * target * guardWeight, 0, 1);
        continue;
      }
    }
    if (key === 'trust') {
      dimensions[key] = clamp(prev + (target - BASELINE.trust) * 0.45 * weight, 0, 1);
      continue;
    }
    if (target > prev) {
      dimensions[key] = clamp(prev + (target - prev) * (0.65 * weight), 0, 1);
    } else if (weight >= 0.65) {
      dimensions[key] = clamp(prev + (target - prev) * (0.15 * weight), 0, 1);
    } else {
      dimensions[key] = prev;
    }
  }

  const mood = deriveMood(dimensions, base.mood);
  const dominantDimension = dominantOf(dimensions);
  const strength = Math.max(...DIMENSIONS.map((k) => Math.max(0, dimensions[k] - BASELINE[k])));
  const causeEntry = {
    sourceSeq,
    reasonCode: appraisal.reasonCode,
    actorTier,
    weight,
    dominantDimension,
    strength: Number(strength.toFixed(3)),
    evaluatedAtMs: base.atMs,
  };
  const causes = [...base.causes, causeEntry]
    .sort((a, b) => a.evaluatedAtMs - b.evaluatedAtMs || a.sourceSeq - b.sourceSeq)
    .slice(-8);

  return {
    atMs: base.atMs,
    dimensions,
    mood,
    causes,
    lastSeq: sourceSeq,
  };
}

export function resetBaseline(state, nowMs = Date.now()) {
  return {
    atMs: nowMs,
    mood: { valence: 0.2, arousal: 0.35 },
    dimensions: emptyDimensions(),
    causes: [],
    lastSeq: Number.isSafeInteger(state?.lastSeq) ? state.lastSeq : 0,
  };
}

export function stepDecay(state, stepMinutes = 30, nowMs = Date.now()) {
  const anchor = Math.max(Number.isFinite(state?.atMs) ? state.atMs : nowMs, nowMs);
  const future = affectAt(state, anchor + stepMinutes * 60_000);
  return { ...future, atMs: anchor };
}

export function dominantOf(dimensions) {
  let best = DIMENSIONS[0];
  let bestScore = -1;
  for (const key of DIMENSIONS) {
    const score = (dimensions[key] ?? 0) - BASELINE[key];
    if (score > bestScore) {
      bestScore = score;
      best = key;
    }
  }
  return best;
}

export function isNeutralState(state, nowMs = state.atMs) {
  const at = affectAt(state, nowMs);
  return PRIMARY_DIMENSIONS.every((key) => (at.dimensions[key] - BASELINE[key]) < NEUTRAL_DELTA_THRESHOLD)
    && Math.abs(at.dimensions.trust - BASELINE.trust) < 0.12
    && (at.dimensions.curiosity - BASELINE.curiosity) < 0.15;
}

function phraseFor(key, value) {
  const delta = value - BASELINE[key];
  const entry = PRIMARY_PHRASES[key];
  if (delta >= 0.48 || value >= 0.65) return entry.strong;
  if (delta >= 0.30 || value >= 0.48) return entry.mid;
  return entry.light;
}

export function renderLine(state, nowMs = state.atMs, maxChars = MAX_AFFECT_LINE_CHARS) {
  const at = affectAt(state, nowMs);
  const activePrimary = PRIMARY_DIMENSIONS
    .map((key) => ({ key, value: at.dimensions[key], delta: at.dimensions[key] - BASELINE[key] }))
    .filter((item) => item.delta >= NEUTRAL_DELTA_THRESHOLD)
    .sort((a, b) => b.delta - a.delta || PRIMARY_DIMENSIONS.indexOf(a.key) - PRIMARY_DIMENSIONS.indexOf(b.key))
    .slice(0, 2);

  const attitudes = [];
  if (at.dimensions.trust >= 0.60) attitudes.push('信任高');
  else if (at.dimensions.trust <= 0.32) attitudes.push('戒心偏重');
  if (at.dimensions.curiosity >= 0.40) attitudes.push('好奇升起');

  const recentCause = at.causes.length > 0 ? at.causes[at.causes.length - 1] : null;
  const reasonPhrase = recentCause && (at.atMs - recentCause.evaluatedAtMs) < 2 * 60 * 60_000
    ? (REASON_PHRASE[recentCause.reasonCode] ?? '')
    : '';

  if (activePrimary.length === 0 && attitudes.length === 0) {
    return '心绪：平稳安静。';
  }

  let mainPart = '平稳';
  if (activePrimary.length === 1) {
    mainPart = phraseFor(activePrimary[0].key, activePrimary[0].value);
  } else if (activePrimary.length >= 2) {
    mainPart = `${phraseFor(activePrimary[0].key, activePrimary[0].value)}带点${PRIMARY_PHRASES[activePrimary[1].key].noun}`;
  }

  const reasonSuffix = reasonPhrase ? `（${reasonPhrase}）` : '';
  const tailSuffix = attitudes.length > 0 ? `｜${attitudes.join('·')}` : '';
  const full = `心绪：${mainPart}${reasonSuffix}${tailSuffix}`;
  const chars = [...full];
  if (chars.length <= maxChars) return full;
  return chars.slice(0, maxChars).join('');
}

export function serializeState(state, history = []) {
  return {
    version: 2,
    state: {
      atMs: Number.isFinite(state.atMs) ? state.atMs : Date.now(),
      mood: {
        valence: Number(state.mood?.valence ?? 0.2),
        arousal: Number(state.mood?.arousal ?? 0.35),
      },
      dimensions: { ...state.dimensions },
      causes: Array.isArray(state.causes) ? state.causes.slice(-8) : [],
      lastSeq: Number.isSafeInteger(state.lastSeq) ? state.lastSeq : 0,
    },
    history: Array.isArray(history) ? history.slice(-400) : [],
  };
}

export function deserializeState(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw.state && typeof raw.state === 'object' ? raw.state : raw;
  const dims = src.dimensions && typeof src.dimensions === 'object' ? src.dimensions : null;
  if (!dims) return null;
  const restored = emptyState(Number.isFinite(src.atMs) ? src.atMs : nowMs);
  for (const key of DIMENSIONS) {
    if (typeof dims[key] === 'number' && Number.isFinite(dims[key])) {
      restored.dimensions[key] = clamp(dims[key], 0, 1);
    }
  }
  if (src.mood && typeof src.mood === 'object') {
    if (typeof src.mood.valence === 'number' && Number.isFinite(src.mood.valence)) {
      restored.mood.valence = clamp(src.mood.valence, -1, 1);
    }
    if (typeof src.mood.arousal === 'number' && Number.isFinite(src.mood.arousal)) {
      restored.mood.arousal = clamp(src.mood.arousal, 0, 1);
    }
  }
  if (Array.isArray(src.causes)) restored.causes = src.causes.slice(-8);
  if (Number.isSafeInteger(src.lastSeq) && src.lastSeq >= 0) restored.lastSeq = src.lastSeq;
  const decayed = affectAt(restored, nowMs);
  const history = Array.isArray(raw.history) ? raw.history.slice(-400) : [];
  return { state: decayed, history };
}
