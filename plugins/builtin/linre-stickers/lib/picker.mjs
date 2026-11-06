/**
 * linre-stickers — 候选选择（纯函数，零依赖）
 *
 * 三个判据，缺一不可：
 *   ① **只认审核过的**（`status === 'approved'`）——`pending` 永远不出现在注入里；
 *   ② 标签要**和当前上下文有交集**（否则就是随机塞图）；
 *   ③ **冷却与最近使用**：同一张图不连着发，刚发过的排后面。
 *
 * 时间一律由调用方给（`nowMs`），这里不读时钟——同一份输入必须得到同一份输出，
 * 否则 conftest 没法复现，缓存前缀也会每步漂。
 */

/** 默认冷却：同一张图 20 分钟内不重复。 */
export const DEFAULT_COOLDOWN_MS = 20 * 60_000;

export const STICKER_STATUSES = ['pending', 'approved', 'rejected', 'blocked'];

/**
 * @param {Array<{id:string, tags:string[], intensity?:number, status:string, path:string, lastUsedMs?:number}>} catalog
 * @param {{ keywords?: string[], nowMs: number, cooldownMs?: number }} context
 * @returns {{ id: string, path: string, tags: string[] } | null}
 */
export function pickSticker(catalog, context) {
  if (!Array.isArray(catalog) || catalog.length === 0) return null;
  const nowMs = Number(context?.nowMs);
  if (!Number.isFinite(nowMs)) return null;
  const cooldownMs = Number.isFinite(Number(context?.cooldownMs))
    ? Math.max(0, Number(context.cooldownMs))
    : DEFAULT_COOLDOWN_MS;
  const keywords = Array.isArray(context?.keywords)
    ? context.keywords.filter((word) => typeof word === 'string' && word !== '')
    : [];
  const scored = [];
  for (const entry of catalog) {
    if (entry === null || typeof entry !== 'object') continue;
    if (entry.status !== 'approved') continue;
    if (typeof entry.id !== 'string' || entry.id === '') continue;
    if (typeof entry.path !== 'string' || entry.path === '') continue;
    const lastUsedMs = Number(entry.lastUsedMs);
    if (Number.isFinite(lastUsedMs) && nowMs - lastUsedMs < cooldownMs) continue;
    const tags = Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === 'string') : [];
    const hits = keywords.length === 0 ? 0 : tags.filter((tag) => keywords.some((word) => tag.includes(word) || word.includes(tag))).length;
    if (keywords.length > 0 && hits === 0) continue;
    const intensity = Number.isFinite(Number(entry.intensity)) ? Number(entry.intensity) : 3;
    scored.push({
      id: entry.id,
      path: entry.path,
      tags,
      hits,
      intensity,
      lastUsedMs: Number.isFinite(lastUsedMs) ? lastUsedMs : 0,
    });
  }
  if (scored.length === 0) return null;
  scored.sort((left, right) => (
    right.hits - left.hits
    || right.intensity - left.intensity
    || left.lastUsedMs - right.lastUsedMs
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  ));
  const best = scored[0];
  return { id: best.id, path: best.path, tags: best.tags };
}

/**
 * 注入行：只给"能发什么"，不替模型决定"要不要发"。
 *
 * 一行 ≤ `maxChars`；超了按码点截断（不切半个代理对）。
 */
export function renderStickerLine(sticker, maxChars = 90) {
  if (sticker === null || typeof sticker.path !== 'string' || sticker.path === '') return '';
  const tags = Array.isArray(sticker.tags) && sticker.tags.length > 0 ? `（${sticker.tags.slice(0, 3).join('/')}）` : '';
  const line = `可配图：${sticker.id}${tags} → send_media path=${sticker.path}`;
  return [...line].length <= maxChars ? line : [...line].slice(0, maxChars).join('');
}

/** 从一段文本里抽关键词（这里只做极简切分：非字母数字汉字都当分隔）。 */
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
