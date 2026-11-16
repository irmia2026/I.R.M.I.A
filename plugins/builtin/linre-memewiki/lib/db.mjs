import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { PACKAGE_ROOT } from './paths.mjs';

const STOP_WORDS = new Set([
  '哈哈', '哈哈哈', '好的', '好吧', '晚安', '早安', '收到', '谢谢', '没事', '干嘛',
  '在吗', '在不在', '睡觉', '吃饭', '好耶', '笑死', '什么', '怎么', '知道', '可以',
  '不是', '没有', '这个', '那个', '自己', '现在', '今天', '明天', '已经', '觉得',
]);

const SCHEMA_SQL = [
  'CREATE TABLE IF NOT EXISTS memes (title TEXT PRIMARY KEY, slug TEXT, tags TEXT, usage TEXT, origin TEXT, other TEXT, summary TEXT, aliases TEXT)',
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)',
].join('; ');

function isAsciiAlnum(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122) || code === 95;
}

function splitAliases(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw
    .split(/[,，、;；]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildAutomaton(rows) {
  const patterns = [];
  const seenKey = new Map();
  for (const row of rows) {
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    if (!title) continue;
    const candidates = [{ text: title, isTitle: true }];
    for (const alias of splitAliases(row.aliases)) {
      candidates.push({ text: alias, isTitle: false });
    }
    for (const item of candidates) {
      const lower = item.text.toLowerCase();
      const charLen = [...lower].length;
      if (charLen < 2) continue;
      if (STOP_WORDS.has(lower)) continue;
      const key = `${lower}\0${title}`;
      if (seenKey.has(key)) continue;
      seenKey.set(key, true);
      patterns.push({
        lower,
        title,
        len: lower.length,
        charLen,
        isTitle: item.isTitle,
        isAsciiWord: /^[a-z0-9_-]+$/u.test(lower),
      });
    }
  }

  const nodes = [{ next: new Map(), fail: 0, out: [] }];
  for (let pIdx = 0; pIdx < patterns.length; pIdx += 1) {
    const word = patterns[pIdx].lower;
    let state = 0;
    for (let i = 0; i < word.length; i += 1) {
      const ch = word[i];
      let nextState = nodes[state].next.get(ch);
      if (nextState === undefined) {
        nextState = nodes.length;
        nodes.push({ next: new Map(), fail: 0, out: [] });
        nodes[state].next.set(ch, nextState);
      }
      state = nextState;
    }
    nodes[state].out.push(pIdx);
  }

  const queue = [];
  for (const child of nodes[0].next.values()) {
    queue.push(child);
  }
  let head = 0;
  while (head < queue.length) {
    const r = queue[head++];
    for (const [ch, s] of nodes[r].next.entries()) {
      queue.push(s);
      let state = nodes[r].fail;
      while (state !== 0 && !nodes[state].next.has(ch)) {
        state = nodes[state].fail;
      }
      const failTo = nodes[state].next.get(ch) ?? 0;
      nodes[s].fail = failTo;
      if (nodes[failTo].out.length > 0) {
        nodes[s].out.push(...nodes[failTo].out);
      }
    }
  }

  return { patterns, nodes };
}

function runMatch(automaton, rawText, limit = 2) {
  if (!automaton || typeof rawText !== 'string') return [];
  const text = rawText.trim();
  if (text.length < 2) return [];
  const lower = text.toLowerCase();
  const { patterns, nodes } = automaton;
  const hits = [];

  let state = 0;
  for (let i = 0; i < lower.length; i += 1) {
    const ch = lower[i];
    while (state !== 0 && !nodes[state].next.has(ch)) {
      state = nodes[state].fail;
    }
    state = nodes[state].next.get(ch) ?? 0;
    const out = nodes[state].out;
    if (out.length === 0) continue;
    const end = i + 1;
    for (const pIdx of out) {
      const pat = patterns[pIdx];
      const start = end - pat.len;
      if (pat.isAsciiWord) {
        if (start > 0 && isAsciiAlnum(lower[start - 1])) continue;
        if (end < lower.length && isAsciiAlnum(lower[end])) continue;
      }
      hits.push({ start, end, pat });
    }
  }

  if (hits.length === 0) return [];
  hits.sort((a, b) => (
    b.pat.charLen - a.pat.charLen
    || b.pat.len - a.pat.len
    || (a.pat.isTitle ? 0 : 1) - (b.pat.isTitle ? 0 : 1)
    || a.start - b.start
  ));

  const acceptedSpans = [];
  const selectedTitles = [];
  const seenTitles = new Set();
  const cap = Math.max(1, Math.min(3, limit));

  for (const hit of hits) {
    if (seenTitles.has(hit.pat.title)) continue;
    const overlaps = acceptedSpans.some((span) => !(hit.end <= span.start || hit.start >= span.end));
    if (overlaps) continue;
    acceptedSpans.push({ start: hit.start, end: hit.end });
    seenTitles.add(hit.pat.title);
    selectedTitles.push(hit.pat.title);
    if (selectedTitles.length >= cap) break;
  }
  return selectedTitles;
}

export function createMemeDb(options = {}) {
  const packageRoot = options.packageRoot || PACKAGE_ROOT;
  const pluginDataDir = options.pluginDataDir;
  if (!pluginDataDir) throw new Error('pluginDataDir is required');
  const bundledDir = join(packageRoot, 'data');
  const bundledPath = options.bundledPath || join(bundledDir, 'memes.db');
  const seedPath = join(pluginDataDir, 'memes.seed.db');
  const userPath = join(pluginDataDir, 'memes.db');

  function materializeSeedPath() {
    if (existsSync(bundledPath)) return bundledPath;
    if (existsSync(seedPath)) return seedPath;
    if (!existsSync(bundledDir)) return '';
    const partNames = readdirSync(bundledDir)
      .filter((name) => name.startsWith('memes.db.gz.part'))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (partNames.length === 0) return '';
    mkdirSync(pluginDataDir, { recursive: true });
    const raw = gunzipSync(Buffer.concat(partNames.map((name) => readFileSync(join(bundledDir, name)))));
    const tmp = join(pluginDataDir, `memes.seed.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, raw);
    if (!existsSync(seedPath)) {
      renameSync(tmp, seedPath);
    }
    return seedPath;
  }

  let readConn = null;
  let usingUser = false;
  let userMtimeMs = -1;
  let automaton = null;

  function closeRead() {
    if (readConn) {
      try {
        readConn.close();
      } catch {
      }
      readConn = null;
    }
  }

  function loadAutomaton(conn) {
    if (!conn) {
      automaton = { patterns: [], nodes: [{ next: new Map(), fail: 0, out: [] }] };
      return;
    }
    const rows = conn.prepare('SELECT title, aliases FROM memes').all();
    automaton = buildAutomaton(rows);
  }

  function getReadConn() {
    const hasUser = existsSync(userPath);
    if (hasUser) {
      const mtime = statSync(userPath).mtimeMs;
      if (!readConn || !usingUser || mtime !== userMtimeMs) {
        closeRead();
        readConn = new DatabaseSync(userPath, { readOnly: true });
        usingUser = true;
        userMtimeMs = mtime;
        loadAutomaton(readConn);
      }
      return readConn;
    }
    if (!readConn || usingUser) {
      closeRead();
      const baseDb = materializeSeedPath();
      if (baseDb && existsSync(baseDb)) {
        readConn = new DatabaseSync(baseDb, { readOnly: true });
      }
      usingUser = false;
      userMtimeMs = -1;
      loadAutomaton(readConn);
    }
    return readConn;
  }

  function invalidate() {
    closeRead();
    userMtimeMs = -1;
    automaton = null;
  }

  function ensureWritableDb() {
    mkdirSync(pluginDataDir, { recursive: true });
    if (!existsSync(userPath)) {
      const baseDb = materializeSeedPath();
      if (baseDb && existsSync(baseDb)) {
        copyFileSync(baseDb, userPath);
      } else {
        const initConn = new DatabaseSync(userPath);
        initConn.exec(SCHEMA_SQL);
        initConn.close();
      }
    }
    const writeConn = new DatabaseSync(userPath);
    writeConn.exec('PRAGMA busy_timeout = 8000');
    writeConn.exec(SCHEMA_SQL);
    return writeConn;
  }

  function getStats() {
    const conn = getReadConn();
    if (!conn) {
      return {
        total: 0,
        builtAt: '',
        source: '',
        isUserCopy: existsSync(userPath),
        userPath,
        bundledPath,
      };
    }
    const total = Number(conn.prepare('SELECT COUNT(*) AS n FROM memes').get()?.n || 0);
    let builtAt = '';
    let source = '';
    try {
      builtAt = String(conn.prepare("SELECT value FROM meta WHERE key = 'built_at'").get()?.value || '');
      source = String(conn.prepare("SELECT value FROM meta WHERE key = 'source'").get()?.value || '');
    } catch {
    }
    return {
      total,
      builtAt,
      source,
      isUserCopy: existsSync(userPath),
      userPath,
      bundledPath,
    };
  }

  function getAllTitlesAndSlugs() {
    const conn = getReadConn();
    if (!conn) return [];
    return conn.prepare('SELECT title, slug FROM memes').all();
  }

  function getByTitle(title) {
    const t = String(title || '').trim();
    if (!t) return null;
    const conn = getReadConn();
    if (!conn) return null;
    return conn.prepare('SELECT * FROM memes WHERE title = ?').get(t) || null;
  }

  function matchMessage(text, opts = {}) {
    const conn = getReadConn();
    if (!conn || !automaton) return [];
    const limit = opts.limit ?? 2;
    const titles = runMatch(automaton, text, limit);
    if (titles.length === 0) return [];
    const stmt = conn.prepare('SELECT * FROM memes WHERE title = ?');
    const out = [];
    for (const title of titles) {
      const row = stmt.get(title);
      if (row) out.push(row);
    }
    return out;
  }

  function searchMemes(query, opts = {}) {
    const q = String(query || '').trim();
    const limit = Math.max(1, Math.min(20, Math.trunc(Number(opts.limit) || 5)));
    if (!q) return [];
    const conn = getReadConn();
    if (!conn) return [];

    const seen = new Set();
    const results = [];
    const pushRows = (rows) => {
      for (const row of rows) {
        if (!row || seen.has(row.title)) continue;
        seen.add(row.title);
        results.push(row);
        if (results.length >= limit) return true;
      }
      return false;
    };

    const exact = conn.prepare('SELECT * FROM memes WHERE title = ? OR lower(title) = lower(?) LIMIT ?').all(q, q, limit);
    if (pushRows(exact)) return results;

    const aliasHits = conn.prepare(
      "SELECT * FROM memes WHERE aliases IS NOT NULL AND instr(',' || lower(aliases) || ',', ',' || lower(?) || ',') > 0 LIMIT ?",
    ).all(q, limit);
    if (pushRows(aliasHits)) return results;

    const prefix = conn.prepare(
      "SELECT * FROM memes WHERE lower(title) LIKE lower(?) || '%' ORDER BY length(title) ASC LIMIT ?",
    ).all(q, limit);
    if (pushRows(prefix)) return results;

    const reverse = conn.prepare(
      'SELECT * FROM memes WHERE length(title) >= 2 AND instr(lower(?), lower(title)) > 0 ORDER BY length(title) DESC LIMIT ?',
    ).all(q, limit);
    if (pushRows(reverse)) return results;

    const like = `%${q}%`;
    const fuzzy = conn.prepare(
      'SELECT * FROM memes WHERE title LIKE ? OR aliases LIKE ? OR tags LIKE ? OR summary LIKE ? OR usage LIKE ? OR origin LIKE ? ORDER BY length(title) ASC LIMIT ?',
    ).all(like, like, like, like, like, like, limit * 2);
    pushRows(fuzzy);
    return results;
  }

  function listMemes(opts = {}) {
    const conn = getReadConn();
    if (!conn) return { total: 0, items: [] };
    const q = String(opts.q || '').trim();
    const limit = Math.max(1, Math.min(60, Math.trunc(Number(opts.limit) || 24)));
    const offset = Math.max(0, Math.trunc(Number(opts.offset) || 0));
    if (q === '__random__') {
      const total = Number(conn.prepare('SELECT COUNT(*) AS n FROM memes').get()?.n || 0);
      const items = conn.prepare('SELECT * FROM memes ORDER BY RANDOM() LIMIT ?').all(limit);
      return { total, items };
    }
    if (!q) {
      const total = Number(conn.prepare('SELECT COUNT(*) AS n FROM memes').get()?.n || 0);
      const items = conn.prepare('SELECT * FROM memes ORDER BY title LIMIT ? OFFSET ?').all(limit, offset);
      return { total, items };
    }
    const like = `%${q}%`;
    const total = Number(
      conn.prepare(
        'SELECT COUNT(*) AS n FROM memes WHERE title LIKE ? OR aliases LIKE ? OR tags LIKE ? OR summary LIKE ? OR usage LIKE ? OR origin LIKE ?',
      ).get(like, like, like, like, like, like)?.n || 0,
    );
    const items = conn.prepare(
      'SELECT * FROM memes WHERE title LIKE ? OR aliases LIKE ? OR tags LIKE ? OR summary LIKE ? OR usage LIKE ? OR origin LIKE ? ORDER BY CASE WHEN title = ? THEN 0 WHEN lower(title) LIKE lower(?) || \'%\' THEN 1 ELSE 2 END, length(title) ASC LIMIT ? OFFSET ?',
    ).all(like, like, like, like, like, like, q, q, limit, offset);
    return { total, items };
  }

  function randomMemes(opts = {}) {
    const conn = getReadConn();
    if (!conn) return [];
    const tag = String(opts.tag || '').trim();
    const count = Math.max(1, Math.min(5, Math.trunc(Number(opts.count) || 1)));
    if (tag) {
      const like = `%${tag}%`;
      return conn.prepare(
        'SELECT * FROM memes WHERE tags LIKE ? OR aliases LIKE ? OR title LIKE ? ORDER BY RANDOM() LIMIT ?',
      ).all(like, like, like, count);
    }
    return conn.prepare('SELECT * FROM memes ORDER BY RANDOM() LIMIT ?').all(count);
  }

  function upsertMeme(entry) {
    const title = String(entry?.title || '').trim();
    if (!title) throw new Error('词条标题不能为空');
    if ([...title].length > 60) throw new Error('词条标题不能超过 60 字');
    const oldTitle = String(entry?.oldTitle || '').trim();
    const isRename = oldTitle !== '' && oldTitle !== title;

    const conn = ensureWritableDb();
    try {
      const existing = conn.prepare('SELECT * FROM memes WHERE title = ?').get(isRename ? oldTitle : title);
      if (isRename && !existing) throw new Error(`原词条「${oldTitle}」不存在`);
      if (isRename && conn.prepare('SELECT title FROM memes WHERE title = ?').get(title)) {
        throw new Error(`词条「${title}」已存在`);
      }

      const aliases = entry.aliases !== undefined ? String(entry.aliases ?? '').trim() : String(existing?.aliases ?? '');
      const tags = entry.tags !== undefined ? String(entry.tags ?? '').trim() : String(existing?.tags ?? '');
      const usage = entry.usage !== undefined ? String(entry.usage ?? '').trim() : String(existing?.usage ?? '');
      const origin = entry.origin !== undefined ? String(entry.origin ?? '').trim() : String(existing?.origin ?? '');
      const summary = entry.summary !== undefined ? String(entry.summary ?? '').trim() : String(existing?.summary ?? '');
      const other = entry.other !== undefined ? String(entry.other ?? '').trim() : String(existing?.other ?? '');
      let slug;
      if (entry.slug !== undefined && String(entry.slug).trim() !== '') {
        slug = String(entry.slug).trim();
      } else {
        const oldSlug = existing?.slug ? String(existing.slug) : '';
        slug = oldSlug === '' || oldSlug === oldTitle ? title : oldSlug;
      }

      if (isRename) {
        conn.prepare(
          'UPDATE memes SET title = ?, slug = ?, tags = ?, usage = ?, origin = ?, other = ?, summary = ?, aliases = ? WHERE title = ?',
        ).run(title, slug, tags, usage, origin, other, summary, aliases, oldTitle);
      } else {
        conn.prepare(
          'INSERT OR REPLACE INTO memes (title, slug, tags, usage, origin, other, summary, aliases) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(title, slug, tags, usage, origin, other, summary, aliases);
      }
      const total = Number(conn.prepare('SELECT COUNT(*) AS n FROM memes').get()?.n || 0);
      conn.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('count', ?)").run(String(total));
      const row = conn.prepare('SELECT * FROM memes WHERE title = ?').get(title);
      invalidate();
      getReadConn();
      return { row, total };
    } finally {
      conn.close();
    }
  }

  function deleteMeme(title) {
    const t = String(title || '').trim();
    if (!t) throw new Error('缺少词条标题');
    const conn = ensureWritableDb();
    try {
      const info = conn.prepare('DELETE FROM memes WHERE title = ?').run(t);
      const total = Number(conn.prepare('SELECT COUNT(*) AS n FROM memes').get()?.n || 0);
      conn.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('count', ?)").run(String(total));
      invalidate();
      getReadConn();
      return { deleted: Number(info?.changes || 0), total };
    } finally {
      conn.close();
    }
  }

  function reload() {
    invalidate();
    return getReadConn();
  }

  function close() {
    closeRead();
    automaton = null;
  }

  getReadConn();

  return {
    bundledPath,
    userPath,
    getStats,
    getAllTitlesAndSlugs,
    getByTitle,
    matchMessage,
    searchMemes,
    listMemes,
    randomMemes,
    upsertMeme,
    deleteMeme,
    ensureWritableDb,
    reload,
    close,
  };
}
