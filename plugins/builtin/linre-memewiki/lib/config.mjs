import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  autoLookup: true,
  trollEnabled: false,
  trollLevel: 50,
  nickname: '林芮',
  contact: '',
});

function toBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  return fallback;
}

function clampLevel(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function normalizeConfig(raw, base = DEFAULT_CONFIG) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const nick = typeof source.nickname === 'string' ? source.nickname.trim().slice(0, 40) : '';
  const contact = typeof source.contact === 'string' ? source.contact.trim().slice(0, 200) : base.contact;
  return {
    autoLookup: toBool(source.autoLookup, base.autoLookup),
    trollEnabled: toBool(source.trollEnabled, base.trollEnabled),
    trollLevel: clampLevel(source.trollLevel, base.trollLevel),
    nickname: nick || base.nickname || DEFAULT_CONFIG.nickname,
    contact,
  };
}

export function readConfig(pluginDataDir) {
  const filePath = join(pluginDataDir, 'config.json');
  try {
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      return normalizeConfig(parsed, DEFAULT_CONFIG);
    }
  } catch {
  }
  return { ...DEFAULT_CONFIG };
}

export function writeConfig(pluginDataDir, patch) {
  const current = readConfig(pluginDataDir);
  const next = normalizeConfig(patch, current);
  mkdirSync(pluginDataDir, { recursive: true });
  writeFileSync(join(pluginDataDir, 'config.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export function readStats(pluginDataDir) {
  const filePath = join(pluginDataDir, 'stats.json');
  try {
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return {
          hitCount: Number.isFinite(Number(parsed.hitCount)) ? Math.max(0, Math.trunc(Number(parsed.hitCount))) : 0,
          lastMatchedAt: typeof parsed.lastMatchedAt === 'string' ? parsed.lastMatchedAt : '',
        };
      }
    }
  } catch {
  }
  return { hitCount: 0, lastMatchedAt: '' };
}

export function recordHits(pluginDataDir, count) {
  const current = readStats(pluginDataDir);
  const delta = Math.max(0, Math.trunc(Number(count) || 0));
  if (delta === 0) return current;
  const next = {
    hitCount: current.hitCount + delta,
    lastMatchedAt: new Date().toISOString(),
  };
  try {
    mkdirSync(pluginDataDir, { recursive: true });
    writeFileSync(join(pluginDataDir, 'stats.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
  }
  return next;
}

export function trollTierInfo(level, enabled) {
  if (!enabled) {
    return { tier: '关闭（自由发挥）', shortLabel: '未接管', guidance: '' };
  }
  const v = clampLevel(level, 50);
  if (v <= 20) {
    return { tier: `极低 (${v})`, shortLabel: '串子极低', guidance: '串子极低:点到即止绝不冒犯' };
  }
  if (v <= 45) {
    return { tier: `偏低 (${v})`, shortLabel: '串子偏低', guidance: '串子偏低:损操作不损人' };
  }
  if (v <= 70) {
    return { tier: `中等 (${v})`, shortLabel: '串子中等', guidance: '串子中等:顺着群友气氛接梗反讽' };
  }
  return { tier: `拉满 (${v})`, shortLabel: '串子拉满', guidance: '串子拉满:放开玩梗互损黑称但看场合收手' };
}
