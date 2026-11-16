export const DEFAULT_COOLDOWN_MS = 180 * 1000;
export const DEFAULT_FALLBACK_AFTER_SPEAKS = 5;
export const STICKER_STATUSES = ['pending', 'approved', 'disabled'];

export const EMOTIONS = [
  '开心',
  '难过',
  '担心',
  '生气',
  '亲近',
  '好奇',
  '无语',
  '得意',
  '害羞',
];

const EMOTION_ALIASES = new Map([
  ['开心', '开心'],
  ['高兴', '开心'],
  ['快乐', '开心'],
  ['喜悦', '开心'],
  ['好耶', '开心'],
  ['笑', '开心'],
  ['happy', '开心'],
  ['joy', '开心'],
  ['excited', '开心'],
  ['难过', '难过'],
  ['伤心', '难过'],
  ['悲伤', '难过'],
  ['哭', '难过'],
  ['委屈', '难过'],
  ['累', '难过'],
  ['困', '难过'],
  ['sad', '难过'],
  ['cry', '难过'],
  ['担心', '担心'],
  ['焦虑', '担心'],
  ['紧张', '担心'],
  ['害怕', '担心'],
  ['慌', '担心'],
  ['worried', '担心'],
  ['anxious', '担心'],
  ['生气', '生气'],
  ['愤怒', '生气'],
  ['气', '生气'],
  ['怒', '生气'],
  ['烦', '生气'],
  ['angry', '生气'],
  ['mad', '生气'],
  ['亲近', '亲近'],
  ['喜欢', '亲近'],
  ['贴贴', '亲近'],
  ['抱', '亲近'],
  ['爱', '亲近'],
  ['温柔', '亲近'],
  ['affection', '亲近'],
  ['love', '亲近'],
  ['好奇', '好奇'],
  ['疑惑', '好奇'],
  ['疑问', '好奇'],
  ['震惊', '好奇'],
  ['惊', '好奇'],
  ['问号', '好奇'],
  ['curious', '好奇'],
  ['无语', '无语'],
  ['呆', '无语'],
  ['盯', '无语'],
  ['沉默', '无语'],
  ['冷漠', '无语'],
  ['汗', '无语'],
  ['speechless', '无语'],
  ['得意', '得意'],
  ['骄傲', '得意'],
  ['傲娇', '得意'],
  ['炫耀', '得意'],
  ['叉腰', '得意'],
  ['smug', '得意'],
  ['proud', '得意'],
  ['害羞', '害羞'],
  ['脸红', '害羞'],
  ['尴尬', '害羞'],
  ['shy', '害羞'],
  ['embarrassed', '害羞'],
]);

export function normalizeEmotion(raw, fallback = '无语') {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  if (EMOTIONS.includes(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (EMOTION_ALIASES.has(lower)) return EMOTION_ALIASES.get(lower);
  for (const [alias, canonical] of EMOTION_ALIASES.entries()) {
    if (lower.includes(alias)) return canonical;
  }
  return fallback;
}

function itemLastUsedMs(entry) {
  if (Number.isFinite(Number(entry.lastUsedMs))) return Number(entry.lastUsedMs);
  if (typeof entry.lastUsedAt === 'string' && entry.lastUsedAt !== '') {
    const parsed = Date.parse(entry.lastUsedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function pickSticker(catalog, context) {
  if (!Array.isArray(catalog) || catalog.length === 0) return null;
  const nowMs = Number(context?.nowMs);
  if (!Number.isFinite(nowMs)) return null;
  const cooldownMs = Number.isFinite(Number(context?.cooldownMs))
    ? Math.max(0, Number(context.cooldownMs))
    : DEFAULT_COOLDOWN_MS;
  const keywords = Array.isArray(context?.keywords)
    ? context.keywords.filter((w) => typeof w === 'string' && w !== '').map((w) => w.toLowerCase())
    : [];
  const targetEmotion = typeof context?.emotion === 'string' && context.emotion.trim() !== ''
    ? normalizeEmotion(context.emotion, '')
    : '';
  const recentIds = Array.isArray(context?.recentIds) ? context.recentIds : [];
  const recentSet = new Set(recentIds);
  const speaksWithoutSticker = Number.isFinite(Number(context?.speaksWithoutSticker))
    ? Number(context.speaksWithoutSticker)
    : 0;
  const fallbackAfterSpeaks = Number.isFinite(Number(context?.fallbackAfterSpeaks))
    ? Math.max(1, Number(context.fallbackAfterSpeaks))
    : DEFAULT_FALLBACK_AFTER_SPEAKS;
  const canFallback = speaksWithoutSticker >= fallbackAfterSpeaks;

  const eligible = [];
  for (const entry of catalog) {
    if (entry === null || typeof entry !== 'object') continue;
    if (entry.status !== 'approved') continue;
    if (typeof entry.id !== 'string' || entry.id === '') continue;
    if (typeof entry.path !== 'string' || entry.path === '') continue;
    const lastUsedMs = itemLastUsedMs(entry);
    if (lastUsedMs > 0 && nowMs - lastUsedMs < cooldownMs) continue;
    const tags = Array.isArray(entry.tags)
      ? entry.tags.filter((t) => typeof t === 'string' && t.trim() !== '')
      : [];
    const emotion = typeof entry.emotion === 'string' && entry.emotion.trim() !== ''
      ? normalizeEmotion(entry.emotion, entry.emotion.trim())
      : '';
    const caption = typeof entry.caption === 'string' ? entry.caption.trim() : '';
    const searchFields = [
      ...tags.map((t) => t.toLowerCase()),
      ...(caption ? [caption.toLowerCase()] : []),
      ...(emotion ? [emotion.toLowerCase()] : []),
    ];
    let keywordHits = 0;
    for (const kw of keywords) {
      if (searchFields.some((f) => f.includes(kw) || kw.includes(f))) {
        keywordHits += 1;
      }
    }
    const emotionHit = targetEmotion !== '' && (
      emotion === targetEmotion
      || tags.some((t) => normalizeEmotion(t, '') === targetEmotion)
    );
    const strongHit = keywordHits > 0 || emotionHit;
    const intensity = Number.isFinite(Number(entry.intensity)) ? Number(entry.intensity) : 3;
    const useCount = Number.isFinite(Number(entry.useCount)) ? Number(entry.useCount) : 0;
    eligible.push({
      id: entry.id,
      path: entry.path,
      tags,
      emotion: emotion || '开心',
      caption: caption || entry.id,
      keywordHits,
      emotionHit,
      strongHit,
      intensity,
      useCount,
      lastUsedMs,
      inRecent: recentSet.has(entry.id),
    });
  }

  if (eligible.length === 0) return null;

  let pool = eligible.filter((c) => !c.inRecent);
  if (pool.length === 0) pool = eligible;

  const matched = pool.filter((c) => c.strongHit);
  let fallback = false;
  let finalPool = matched;
  if (finalPool.length === 0) {
    if (!canFallback) return null;
    fallback = true;
    finalPool = pool;
  }

  finalPool.sort((a, b) => (
    (Number(b.emotionHit) - Number(a.emotionHit))
    || (b.keywordHits - a.keywordHits)
    || (b.intensity - a.intensity)
    || (a.lastUsedMs - b.lastUsedMs)
    || (a.useCount - b.useCount)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  ));

  const best = finalPool[0];
  return {
    id: best.id,
    path: best.path,
    tags: best.tags,
    emotion: best.emotion,
    caption: best.caption,
    fallback,
  };
}

export function renderStickerLine(sticker, maxChars = 160) {
  if (sticker === null || typeof sticker !== 'object') return '';
  if (typeof sticker.path !== 'string' || sticker.path === '') return '';
  const emotion = typeof sticker.emotion === 'string' && sticker.emotion !== '' ? sticker.emotion : '开心';
  const rawCaption = typeof sticker.caption === 'string' && sticker.caption !== '' ? sticker.caption : (sticker.id || '表情');
  const tags = Array.isArray(sticker.tags) ? sticker.tags.filter((t) => typeof t === 'string' && t !== '').slice(0, 3) : [];
  const suffix = ` → send_media path="${sticker.path}"`;
  const prefix = sticker.fallback
    ? `可配图（已连聊多轮纯文字，顺手带一张更灵动）：[${emotion}] `
    : `可配图：[${emotion}] `;
  const tagText = !sticker.fallback && tags.length > 0 ? `（标签：${tags.join('/')}）` : '';

  let line = `${prefix}${rawCaption}${tagText}${suffix}`;
  if ([...line].length <= maxChars) return line;

  line = `${prefix}${rawCaption}${suffix}`;
  if ([...line].length <= maxChars) return line;

  const fixedLen = [...prefix].length + [...suffix].length;
  if (fixedLen < maxChars) {
    const avail = maxChars - fixedLen;
    const shortCaption = [...rawCaption].slice(0, Math.max(1, avail)).join('');
    return `${prefix}${shortCaption}${suffix}`;
  }
  return [...line].slice(0, maxChars).join('');
}

export function keywordsOf(text, limit = 12) {
  if (typeof text !== 'string' || text === '') return [];
  const parts = text.split(/[^0-9A-Za-z\u4e00-\u9fff]+/u).filter((part) => part.length >= 1);
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    if (seen.has(part)) continue;
    seen.add(part);
    out.push(part);
    if (out.length >= limit) break;
  }
  return out;
}
