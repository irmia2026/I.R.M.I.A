import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { inspectImageBuffer, isDuplicateOrBlocked } from './image-fp.mjs';
import { normalizeEmotion } from './picker.mjs';

export const DEFAULT_SETTINGS = Object.freeze({
  autoSteal: true,
  onlyStickerTagged: true,
  autoApproveOwner: false,
  cooldownSec: 180,
  fallbackAfterSpeaks: 5,
  maxPending: 200,
});

export function resolvePluginDataDir(explicitDir = '', fallbackToHome = false) {
  if (typeof explicitDir === 'string' && explicitDir.trim() !== '') {
    return resolve(explicitDir.trim());
  }
  if (typeof process.env.LINRE_STICKERS_DATA_DIR === 'string' && process.env.LINRE_STICKERS_DATA_DIR.trim() !== '') {
    return resolve(process.env.LINRE_STICKERS_DATA_DIR.trim());
  }
  if (typeof process.env.LINRE_PLUGIN_DATA_DIR === 'string' && process.env.LINRE_PLUGIN_DATA_DIR.trim() !== '') {
    return resolve(process.env.LINRE_PLUGIN_DATA_DIR.trim());
  }
  if (typeof process.env.IRMIA_DATA_DIR === 'string' && process.env.IRMIA_DATA_DIR.trim() !== '') {
    return resolve(join(process.env.IRMIA_DATA_DIR.trim(), 'plugin-data', 'linre-stickers'));
  }
  if (fallbackToHome) {
    return process.env.LOCALAPPDATA
      ? resolve(join(process.env.LOCALAPPDATA, 'linre-stickers'))
      : resolve(join(homedir(), '.linre-stickers'));
  }
  return '';
}

export function createEmptyCatalog() {
  return {
    version: 2,
    items: [],
    blocked: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const cooldownSec = Number(src.cooldownSec);
  const fallbackAfterSpeaks = Number(src.fallbackAfterSpeaks);
  const maxPending = Number(src.maxPending);
  return {
    autoSteal: src.autoSteal !== undefined ? Boolean(src.autoSteal) : DEFAULT_SETTINGS.autoSteal,
    onlyStickerTagged: src.onlyStickerTagged !== undefined ? Boolean(src.onlyStickerTagged) : DEFAULT_SETTINGS.onlyStickerTagged,
    autoApproveOwner: src.autoApproveOwner !== undefined ? Boolean(src.autoApproveOwner) : DEFAULT_SETTINGS.autoApproveOwner,
    cooldownSec: Number.isFinite(cooldownSec) ? Math.max(10, Math.min(3600, Math.round(cooldownSec))) : DEFAULT_SETTINGS.cooldownSec,
    fallbackAfterSpeaks: Number.isFinite(fallbackAfterSpeaks) ? Math.max(1, Math.min(50, Math.round(fallbackAfterSpeaks))) : DEFAULT_SETTINGS.fallbackAfterSpeaks,
    maxPending: Number.isFinite(maxPending) ? Math.max(10, Math.min(2000, Math.round(maxPending))) : DEFAULT_SETTINGS.maxPending,
  };
}

export function resolveItemFilePath(itemPath) {
  if (typeof itemPath !== 'string' || itemPath.trim() === '') return '';
  if (existsSync(itemPath)) return itemPath;
  if (!isAbsolute(itemPath) && typeof process.env.IRMIA_DATA_DIR === 'string' && process.env.IRMIA_DATA_DIR.trim() !== '') {
    const joined = join(process.env.IRMIA_DATA_DIR.trim(), itemPath);
    if (existsSync(joined)) return joined;
  }
  return '';
}

function cleanTagsList(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const tag of raw) {
    if (typeof tag !== 'string') continue;
    const t = tag.trim().slice(0, 32);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 16) break;
  }
  return out;
}

export function normalizeItem(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const status = src.status === 'approved' || src.status === 'disabled' ? src.status : 'pending';
  const intensityRaw = Number(src.intensity);
  const confidenceRaw = Number(src.confidence);
  const useCountRaw = Number(src.useCount);
  const sizeBytesRaw = Number(src.sizeBytes);
  return {
    id: typeof src.id === 'string' && src.id.trim() !== '' ? src.id.trim() : randomUUID().slice(0, 16),
    sha256: typeof src.sha256 === 'string' ? src.sha256 : '',
    fp64: typeof src.fp64 === 'string' ? src.fp64 : '',
    path: typeof src.path === 'string' ? src.path : '',
    mediaUrl: typeof src.mediaUrl === 'string' ? src.mediaUrl : '',
    mimeType: typeof src.mimeType === 'string' ? src.mimeType : '',
    sizeBytes: Number.isFinite(sizeBytesRaw) ? sizeBytesRaw : 0,
    status,
    emotion: normalizeEmotion(src.emotion, '开心'),
    tags: cleanTagsList(src.tags),
    caption: typeof src.caption === 'string' ? src.caption.trim().slice(0, 120) : '',
    intensity: Number.isFinite(intensityRaw) ? Math.max(1, Math.min(5, Math.round(intensityRaw))) : 3,
    confidence: Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0.8,
    sourceChatId: typeof src.sourceChatId === 'string' ? src.sourceChatId : '',
    sourcePerson: typeof src.sourcePerson === 'string' ? src.sourcePerson : '',
    sourceNickname: typeof src.sourceNickname === 'string' ? src.sourceNickname : '',
    createdAt: typeof src.createdAt === 'string' && src.createdAt !== '' ? src.createdAt : new Date().toISOString(),
    reviewedAt: typeof src.reviewedAt === 'string' ? src.reviewedAt : null,
    useCount: Number.isFinite(useCountRaw) ? Math.max(0, Math.round(useCountRaw)) : 0,
    lastUsedAt: typeof src.lastUsedAt === 'string' ? src.lastUsedAt : null,
  };
}

function normalizeBlocked(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const b of raw) {
    if (!b || typeof b !== 'object' || typeof b.sha256 !== 'string' || b.sha256 === '') continue;
    if (seen.has(b.sha256)) continue;
    seen.add(b.sha256);
    out.push({
      sha256: b.sha256,
      fp64: typeof b.fp64 === 'string' ? b.fp64 : '',
      reason: typeof b.reason === 'string' ? b.reason : '已拉黑',
      blockedAt: typeof b.blockedAt === 'string' ? b.blockedAt : new Date().toISOString(),
    });
  }
  return out;
}

function inspectExistingFile(filePath) {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size <= 128) return null;
    const buf = readFileSync(filePath);
    if (buf.length <= 128) return null;
    const info = inspectImageBuffer(buf);
    if (!info) return null;
    return { stat, info };
  } catch {
    return null;
  }
}

export function loadCatalogRaw(dataDir) {
  if (!dataDir) return { catalog: createEmptyCatalog(), mtimeMs: 0, existed: false };
  const file = join(dataDir, 'catalog.json');
  if (!existsSync(file)) return { catalog: createEmptyCatalog(), mtimeMs: 0, existed: false };
  try {
    const stat = statSync(file);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) {
      return {
        catalog: {
          version: 2,
          items: parsed.filter((x) => x && typeof x === 'object').map((x) => normalizeItem(x)),
          blocked: [],
          settings: { ...DEFAULT_SETTINGS },
        },
        mtimeMs: stat.mtimeMs,
        existed: true,
      };
    }
    if (parsed && typeof parsed === 'object') {
      const items = Array.isArray(parsed.items)
        ? parsed.items.filter((x) => x && typeof x === 'object').map((x) => normalizeItem(x))
        : [];
      return {
        catalog: {
          version: 2,
          items,
          blocked: normalizeBlocked(parsed.blocked),
          settings: normalizeSettings(parsed.settings),
        },
        mtimeMs: stat.mtimeMs,
        existed: true,
      };
    }
  } catch {
    return { catalog: createEmptyCatalog(), mtimeMs: 0, existed: true };
  }
  return { catalog: createEmptyCatalog(), mtimeMs: 0, existed: true };
}

export function saveCatalogAtomic(dataDir, catalog) {
  if (!dataDir) return 0;
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'catalog.json');
  const tmp = `${file}.${randomUUID()}.tmp`;
  const payload = {
    version: 2,
    items: Array.isArray(catalog.items) ? catalog.items : [],
    blocked: Array.isArray(catalog.blocked) ? catalog.blocked : [],
    settings: normalizeSettings(catalog.settings),
  };
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  try {
    return statSync(file).mtimeMs;
  } catch {
    return Date.now();
  }
}

export function migrateAndLoadCatalog(dataDir) {
  if (!dataDir) return { catalog: createEmptyCatalog(), mtimeMs: 0, migratedCount: 0 };
  const file = join(dataDir, 'catalog.json');
  const loaded = loadCatalogRaw(dataDir);
  const catalog = loaded.catalog;
  let dirty = false;

  const validItems = [];
  for (const rawItem of catalog.items) {
    const resolvedPath = resolveItemFilePath(rawItem.path);
    if (!resolvedPath) {
      dirty = true;
      continue;
    }
    const inspected = inspectExistingFile(resolvedPath);
    if (!inspected) {
      dirty = true;
      continue;
    }
    const item = normalizeItem({
      ...rawItem,
      path: resolvedPath,
      sha256: rawItem.sha256 || inspected.info.sha256,
      fp64: rawItem.fp64 || inspected.info.fp64,
      mimeType: rawItem.mimeType || inspected.info.mimeType,
      sizeBytes: rawItem.sizeBytes || inspected.info.sizeBytes,
    });
    if (!rawItem.sha256 || !rawItem.fp64 || !rawItem.mimeType || !rawItem.sizeBytes) dirty = true;
    validItems.push(item);
  }
  catalog.items = validItems;

  const legacyDir = resolve(join(dataDir, '..', 'linre-meme-photo'));
  const legacyIndex = join(legacyDir, 'index.json');
  let migratedCount = 0;
  if (existsSync(legacyIndex)) {
    try {
      const legacyParsed = JSON.parse(readFileSync(legacyIndex, 'utf8'));
      if (Array.isArray(legacyParsed)) {
        const nowIso = new Date().toISOString();
        for (const entry of legacyParsed) {
          if (!entry || typeof entry !== 'object') continue;
          const entryPath = resolveItemFilePath(entry.path);
          if (!entryPath) continue;
          const inspected = inspectExistingFile(entryPath);
          if (!inspected) continue;
          const dup = isDuplicateOrBlocked(inspected.info, catalog.items, catalog.blocked);
          if (dup.matched) continue;
          const migratedItem = normalizeItem({
            id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : inspected.info.sha256.slice(0, 16),
            sha256: inspected.info.sha256,
            fp64: inspected.info.fp64,
            path: entryPath,
            mediaUrl: '',
            mimeType: inspected.info.mimeType,
            sizeBytes: inspected.info.sizeBytes,
            status: 'approved',
            emotion: normalizeEmotion(entry.mood, '开心'),
            tags: cleanTagsList(entry.tags),
            caption: typeof entry.label === 'string' ? entry.label : '',
            intensity: 3,
            confidence: 0.9,
            sourceChatId: typeof entry.source === 'string' ? entry.source : '',
            sourcePerson: '',
            sourceNickname: '',
            createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : nowIso,
            reviewedAt: nowIso,
            useCount: Number.isFinite(Number(entry.useCount)) ? Number(entry.useCount) : 0,
            lastUsedAt: null,
          });
          catalog.items.push(migratedItem);
          migratedCount += 1;
          dirty = true;
        }
      }
    } catch {
      dirty = dirty || false;
    }
  }

  let mtimeMs = loaded.mtimeMs;
  if (dirty || !existsSync(file)) {
    mtimeMs = saveCatalogAtomic(dataDir, catalog);
  }
  return { catalog, mtimeMs, migratedCount };
}

export function readCatalogIfChanged(dataDir, knownMtimeMs, currentCatalog) {
  if (!dataDir) return { catalog: currentCatalog, mtimeMs: knownMtimeMs, changed: false };
  const file = join(dataDir, 'catalog.json');
  if (!existsSync(file)) return { catalog: currentCatalog, mtimeMs: knownMtimeMs, changed: false };
  try {
    const stat = statSync(file);
    if (stat.mtimeMs !== knownMtimeMs) {
      const loaded = loadCatalogRaw(dataDir);
      return { catalog: loaded.catalog, mtimeMs: loaded.mtimeMs, changed: true };
    }
  } catch {
    return { catalog: currentCatalog, mtimeMs: knownMtimeMs, changed: false };
  }
  return { catalog: currentCatalog, mtimeMs: knownMtimeMs, changed: false };
}

export function blockCatalogItem(catalog, item, reason = '审核拒绝') {
  if (!item || typeof item.sha256 !== 'string' || item.sha256 === '') return false;
  const exists = catalog.blocked.some((b) => b.sha256 === item.sha256);
  if (!exists) {
    catalog.blocked.unshift({
      sha256: item.sha256,
      fp64: typeof item.fp64 === 'string' ? item.fp64 : '',
      reason,
      blockedAt: new Date().toISOString(),
    });
  }
  catalog.items = catalog.items.filter((x) => x.id !== item.id && x.sha256 !== item.sha256);
  return true;
}
