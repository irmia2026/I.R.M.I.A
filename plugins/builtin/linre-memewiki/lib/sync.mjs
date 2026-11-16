import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import tls from 'node:tls';

import { readConfig } from './config.mjs';

const PUBLIC_MEMES_API = 'https://cnmeme.wiki/api/v1/public/memes';
const INTEGRATIONS_API = 'https://cnmeme.wiki/api/v1/integrations';
const USER_AGENT = 'Mozilla/5.0 linre-memewiki/0.1.0';
const DEFAULT_LOCAL_PROXY = 'http://127.0.0.1:7890';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveProxyUrl() {
  const explicit = (
    process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || ''
  ).trim();
  if (explicit) return { url: explicit, isDefaultProbe: false };
  return { url: DEFAULT_LOCAL_PROXY, isDefaultProbe: true };
}

function requestViaProxy(targetUrl, proxyUrl, options = {}) {
  const target = new URL(targetUrl);
  const proxy = new URL(proxyUrl);
  const timeoutMs = options.timeoutMs ?? 20000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 1500;
  const method = (options.method || 'GET').toUpperCase();
  const body = options.body;
  const headers = {
    'user-agent': USER_AGENT,
    host: target.host,
    ...(options.headers || {}),
  };
  if (body !== undefined && headers['content-length'] === undefined) {
    headers['content-length'] = String(Buffer.byteLength(String(body), 'utf8'));
  }

  return new Promise((resolve, reject) => {
    const port = target.port ? Number(target.port) : (target.protocol === 'https:' ? 443 : 80);
    const proxyPort = proxy.port ? Number(proxy.port) : (proxy.protocol === 'https:' ? 443 : 80);
    let settled = false;
    const finishError = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const connectReq = http.request({
      host: proxy.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      timeout: connectTimeoutMs,
      headers: {
        host: `${target.hostname}:${port}`,
        'user-agent': USER_AGENT,
      },
    });

    connectReq.on('timeout', () => {
      connectReq.destroy(new Error('proxy connect timeout'));
    });

    connectReq.on('error', finishError);

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        finishError(new Error(`proxy CONNECT ${res.statusCode}`));
        return;
      }
      const tlsSocket = target.protocol === 'https:'
        ? tls.connect({ socket, servername: target.hostname })
        : socket;

      const req = https.request({
        hostname: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        createConnection: () => tlsSocket,
        timeout: timeoutMs,
      }, (resp) => {
        const chunks = [];
        resp.on('data', (chunk) => chunks.push(chunk));
        resp.on('end', () => {
          if (settled) return;
          settled = true;
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch {
          }
          resolve({ status: resp.statusCode || 0, ok: (resp.statusCode || 0) >= 200 && (resp.statusCode || 0) < 300, data, text: raw });
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error('proxy request timeout'));
      });
      req.on('error', finishError);
      if (body !== undefined) req.write(body);
      req.end();
    });

    connectReq.end();
  });
}

async function directFetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20000;
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'user-agent': USER_AGENT,
      ...(options.headers || {}),
    },
    ...(options.body !== undefined ? { body: options.body } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
  }
  return { status: res.status, ok: res.ok, data, text };
}

export async function httpRequestJson(url, options = {}) {
  const proxyInfo = resolveProxyUrl();
  if (proxyInfo.url) {
    try {
      return await requestViaProxy(url, proxyInfo.url, {
        ...options,
        connectTimeoutMs: proxyInfo.isDefaultProbe ? 1200 : 4000,
      });
    } catch {
    }
  }
  return await directFetchJson(url, options);
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function inlineText(html) {
  return decodeEntities(String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function htmlToBlocks(html) {
  const output = [];
  const pattern = /<(p|ul|ol|blockquote|pre)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = pattern.exec(html))) {
    const tag = m[1].toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      const items = [...m[2].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
        .map((x) => inlineText(x[1]).replace(/\s*\n\s*/g, ' ').trim())
        .filter(Boolean);
      if (items.length) output.push(items.map((t) => `- ${t}`).join('\n\n'));
    } else if (tag === 'blockquote') {
      const inner = htmlToBlocks(m[2]) || inlineText(m[2]);
      if (inner) output.push(inner);
    } else {
      const text = inlineText(m[2]);
      if (text) output.push(text);
    }
  }
  return output.join('\n\n');
}

function splitSections(html) {
  const sections = [];
  const pattern = /<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2|$)/gi;
  for (const m of String(html || '').matchAll(pattern)) {
    const title = inlineText(m[1]).trim();
    const content = htmlToBlocks(m[2]).trim();
    if (title) sections.push({ title, content });
  }
  return sections;
}

function itemToRow(item) {
  const sections = splitSections(item?.content_html);
  const pick = (name) => (sections.find((s) => s.title === name)?.content || '').trim();
  const other = sections
    .filter((s) => s.title !== '来源' && s.title !== '用法')
    .map((s) => (s.content ? `${s.title}\n${s.content}` : s.title))
    .join('\n\n');
  const str = (v) => (v == null ? '' : String(v));
  return {
    title: str(item?.title).trim(),
    slug: str(item?.slug).trim() || str(item?.title).trim(),
    tags: Array.isArray(item?.tags) ? item.tags.map(str).join('、') : str(item?.tags),
    usage: pick('用法'),
    origin: pick('来源'),
    other,
    summary: str(item?.summary),
    aliases: Array.isArray(item?.aliases) ? item.aliases.map(str).join(',') : str(item?.aliases),
    updated_at: str(item?.updated_at),
  };
}

function inlineToMarkdown(html) {
  let s = String(html || '');
  s = s.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  s = s.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  s = s.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  return decodeEntities(s).trim();
}

export function htmlToMarkdown(html) {
  let s = String(html || '');
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => `\n${'#'.repeat(Number(n))} ${inlineToMarkdown(t)}\n\n`);
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, t) => `\n> ${inlineToMarkdown(t).replace(/\n/g, '\n> ')}\n\n`);
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `- ${inlineToMarkdown(t)}\n`);
  s = s.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, t) => `${inlineToMarkdown(t)}\n\n`);
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function appendSection(body, sectionName, content) {
  const heading = `## ${sectionName}`;
  const lines = String(body || '').split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    return `${String(body || '').trim() ? `${String(body).trim()}\n\n` : ''}${heading}\n\n${content.trim()}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,2}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, end).join('\n').replace(/\n+$/, '');
  const after = lines.slice(end).join('\n').replace(/^\n+/, '');
  return `${before}\n\n${content.trim()}${after ? `\n\n${after}` : '\n'}`;
}

async function fetchPublicJson(path, retries = 4) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const res = await httpRequestJson(`${PUBLIC_MEMES_API}${path}`, { timeoutMs: 20000 });
      if (res.status === 429 || res.status >= 500) {
        const waitMs = Math.min(15000, 1500 * (2 ** i));
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.data;
    } catch (error) {
      if (i === retries - 1) throw error;
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error('request retries exhausted');
}

export async function syncCnmeme({ db, pluginDataDir, dryRun = false, noExisting = false, onProgress }) {
  const startedAt = Date.now();
  const report = (msg) => {
    if (typeof onProgress === 'function') onProgress(msg);
  };

  const localStat = db.getStats();
  const localBefore = localStat.total;
  const builtAt = localStat.builtAt;
  const cutoffMs = builtAt ? Date.parse(builtAt.replace(' ', 'T')) : 0;

  const existingList = db.getAllTitlesAndSlugs();
  const localTitles = new Set(existingList.map((r) => String(r.title || '')));
  const localSlugs = new Set(existingList.map((r) => String(r.slug || '')));

  const siteItems = [];
  let offset = 0;
  let pages = 0;
  report(`开始扫描 cnmeme.wiki 公开词条列表（本地现有 ${localBefore} 条）`);
  for (;;) {
    const payload = await fetchPublicJson(`?limit=30&offset=${offset}`);
    const items = Array.isArray(payload?.items) ? payload.items : [];
    if (items.length === 0) break;
    for (const item of items) {
      siteItems.push({ slug: item.slug, title: item.title, updated_at: item.updated_at });
    }
    offset += items.length;
    pages += 1;
    if (pages % 25 === 0) {
      report(`已扫描 ${pages} 页 / ${siteItems.length} 条`);
    }
    if (!payload?.has_more) break;
    await sleep(120);
  }

  const siteSlugs = new Set(siteItems.map((x) => x.slug));
  const toInsert = [];
  const toUpdate = [];
  for (const item of siteItems) {
    const has = localTitles.has(item.title) || localSlugs.has(item.slug);
    if (!has) {
      toInsert.push(item);
    } else if (!noExisting && cutoffMs && item.updated_at && Date.parse(item.updated_at) > cutoffMs) {
      toUpdate.push(item);
    }
  }
  const removedOnSite = existingList.filter((r) => !siteSlugs.has(r.slug)).length;

  report(`扫描完成：新增 ${toInsert.length}，待更新 ${toUpdate.length}，远端已下架 ${removedOnSite}`);

  if (toInsert.length === 0 && toUpdate.length === 0) {
    return {
      ok: true,
      localBefore,
      total: localBefore,
      added: 0,
      updated: 0,
      failed: 0,
      removedOnSite,
      pages,
      siteCount: siteItems.length,
      backupPath: '',
      durationSec: Math.round((Date.now() - startedAt) / 1000),
      dryRun,
    };
  }

  const targets = [...toInsert, ...toUpdate];
  const details = [];
  let failed = 0;
  for (let i = 0; i < targets.length; i += 1) {
    const item = targets[i];
    try {
      const body = await fetchPublicJson(`/${encodeURIComponent(item.slug)}`);
      details.push(body && body.item && typeof body.item === 'object' ? body.item : body);
    } catch {
      failed += 1;
    }
    if ((i + 1) % 10 === 0) {
      report(`拉取详情 ${i + 1}/${targets.length}`);
    }
    await sleep(220);
  }

  if (dryRun) {
    return {
      ok: true,
      localBefore,
      total: localBefore,
      added: toInsert.length,
      updated: toUpdate.length,
      failed,
      removedOnSite,
      pages,
      siteCount: siteItems.length,
      backupPath: '',
      durationSec: Math.round((Date.now() - startedAt) / 1000),
      dryRun: true,
      previewAdd: toInsert.map((x) => x.title),
      previewUpdate: toUpdate.map((x) => x.title),
    };
  }

  mkdirSync(pluginDataDir, { recursive: true });
  const stamp = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14);
  const backupPath = join(pluginDataDir, `memes.db.bak-${stamp}`);
  if (existsSync(db.userPath)) {
    copyFileSync(db.userPath, backupPath);
  }

  const conn = db.ensureWritableDb();
  let added = 0;
  let updated = 0;
  try {
    conn.exec('BEGIN');
    for (const item of details) {
      const row = itemToRow(item);
      if (!row.title) continue;
      const prev = conn.prepare('SELECT * FROM memes WHERE title = ?').get(row.title);
      if (!prev) {
        conn.prepare(
          'INSERT OR REPLACE INTO memes (title, slug, tags, usage, origin, other, summary, aliases) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(row.title, row.slug, row.tags, row.usage, row.origin, row.other, row.summary, row.aliases);
        added += 1;
      } else {
        const merged = {
          slug: row.slug || prev.slug,
          tags: row.tags || prev.tags,
          usage: row.usage || prev.usage,
          origin: row.origin || prev.origin,
          other: row.other || prev.other,
          summary: row.summary || prev.summary,
          aliases: row.aliases || prev.aliases || '',
        };
        const changed = ['slug', 'tags', 'usage', 'origin', 'other', 'summary', 'aliases']
          .some((k) => String(prev[k] ?? '') !== String(merged[k] ?? ''));
        if (changed) {
          conn.prepare(
            'UPDATE memes SET slug = ?, tags = ?, usage = ?, origin = ?, other = ?, summary = ?, aliases = ? WHERE title = ?',
          ).run(merged.slug, merged.tags, merged.usage, merged.origin, merged.other, merged.summary, merged.aliases, row.title);
          updated += 1;
        }
      }
    }
    const total = Number(conn.prepare('SELECT COUNT(*) AS n FROM memes').get()?.n || 0);
    const nowText = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    conn.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('built_at', ?)").run(nowText);
    conn.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('count', ?)").run(String(total));
    conn.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('source', ?)").run('cnmeme.wiki /api/v1/public/memes');
    conn.exec('COMMIT');
    db.reload();
    return {
      ok: true,
      localBefore,
      total,
      added,
      updated,
      failed,
      removedOnSite,
      pages,
      siteCount: siteItems.length,
      backupPath,
      durationSec: Math.round((Date.now() - startedAt) / 1000),
      dryRun: false,
    };
  } catch (error) {
    try {
      conn.exec('ROLLBACK');
    } catch {
    }
    throw error;
  } finally {
    conn.close();
  }
}

function readFeedbackStore(pluginDataDir) {
  const filePath = join(pluginDataDir, 'memewiki-feedback.json');
  try {
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return {
          tokenInfo: parsed.tokenInfo || null,
          submissions: Array.isArray(parsed.submissions) ? parsed.submissions : [],
          instanceId: typeof parsed.instanceId === 'string' ? parsed.instanceId : '',
        };
      }
    }
  } catch {
  }
  return { tokenInfo: null, submissions: [], instanceId: '' };
}

function writeFeedbackStore(pluginDataDir, store) {
  mkdirSync(pluginDataDir, { recursive: true });
  writeFileSync(join(pluginDataDir, 'memewiki-feedback.json'), `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function formatFeedbackError(res) {
  const d = res?.data;
  if (d && d.detail) {
    if (Array.isArray(d.detail)) return d.detail.map((x) => x.msg || JSON.stringify(x)).join('；');
    if (typeof d.detail === 'string') return d.detail;
  }
  if (d && d.error) return String(d.error);
  return `HTTP ${res?.status || '?'}`;
}

async function ensureFeedbackClientToken(pluginDataDir) {
  const store = readFeedbackStore(pluginDataDir);
  if (store.tokenInfo && typeof store.tokenInfo.token === 'string' && store.tokenInfo.token !== '') {
    return { ok: true, token: store.tokenInfo.token, store };
  }
  const config = readConfig(pluginDataDir);
  const contact = String(config.contact || '').trim();
  if (!contact) {
    return { ok: false, reason: 'missing_contact' };
  }
  if (!store.instanceId) {
    store.instanceId = `linre-${Math.random().toString(36).slice(2, 10)}`;
  }
  const res = await httpRequestJson(`${INTEGRATIONS_API}/clients`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'linre',
      client_id: store.instanceId,
      name: String(config.nickname || '林芮').trim().slice(0, 100) || '林芮',
      contact: contact.slice(0, 200),
      plugin_name: 'linre-memewiki',
      plugin_version: '0.1.0',
    }),
  });
  if (res.status !== 201 || !res.data || !res.data.token) {
    return { ok: false, reason: 'register_failed', error: formatFeedbackError(res) };
  }
  store.tokenInfo = {
    token: res.data.token,
    client_id: res.data.client_id,
    expires_at: res.data.expires_at,
    claimedAt: new Date().toISOString(),
  };
  writeFeedbackStore(pluginDataDir, store);
  return { ok: true, token: store.tokenInfo.token, store };
}

export async function submitFeedback({ db, pluginDataDir, title, content, requestType, saveLocal = true }) {
  const cleanTitle = String(title || '').trim();
  const cleanContent = String(content || '').trim();
  if (!cleanTitle) return { ok: false, error: '缺少词条标题（title）' };
  if (!cleanContent) return { ok: false, error: '缺少反馈或新增内容（content）' };

  const existing = db.getByTitle(cleanTitle);
  const kind = requestType === 'edit' || requestType === 'create'
    ? requestType
    : (existing && existing.slug ? 'edit' : 'create');

  let localSaved = false;
  if (saveLocal !== false) {
    const mergedUsage = existing?.usage
      ? `${existing.usage}\n\n${cleanContent}`
      : cleanContent;
    db.upsertMeme({
      title: cleanTitle,
      usage: mergedUsage,
      summary: existing?.summary || cleanContent.slice(0, 160),
    });
    localSaved = true;
  }

  let auth;
  try {
    auth = await ensureFeedbackClientToken(pluginDataDir);
  } catch (error) {
    return {
      ok: localSaved,
      localSaved,
      remoteSubmitted: false,
      error: `联网领取凭证失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!auth.ok) {
    if (auth.reason === 'missing_contact') {
      return {
        ok: localSaved,
        localSaved,
        remoteSubmitted: false,
        message: localSaved
          ? '已写入本地可写词库；尚未配置 cnmeme.wiki 联系方式，暂未提交到线上（可在插件设置页填写联系方式后重试）。'
          : '未配置 cnmeme.wiki 联系方式，无法领取线上反馈凭证。',
      };
    }
    return {
      ok: localSaved,
      localSaved,
      remoteSubmitted: false,
      error: `领取线上反馈凭证失败：${auth.error}`,
    };
  }

  const slug = String(existing?.slug || '').trim();
  let bodyPayload;
  if (kind === 'edit' && slug) {
    let contentMd = `## 用法\n\n${cleanContent}\n`;
    try {
      const detail = await fetchPublicJson(`/${encodeURIComponent(slug)}`, 2);
      const item = detail?.item || detail;
      if (item && item.content_html) {
        contentMd = appendSection(htmlToMarkdown(item.content_html), '用法', cleanContent);
      }
    } catch {
    }
    bodyPayload = {
      kind: 'edit',
      entry_slug: slug,
      changes: { content_md: contentMd.slice(0, 20000) },
      reason: cleanContent.slice(0, 2000),
    };
  } else {
    bodyPayload = {
      kind: 'create',
      title: cleanTitle,
      changes: {
        title: cleanTitle,
        content_md: `## 用法\n\n${cleanContent}\n`.slice(0, 20000),
      },
      reason: cleanContent.slice(0, 2000),
    };
  }

  try {
    const res = await httpRequestJson(`${INTEGRATIONS_API}/entry-requests`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${auth.token}`,
        'idempotency-key': `linre-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      },
      body: JSON.stringify(bodyPayload),
    });

    if (res.status === 401) {
      auth.store.tokenInfo = null;
      writeFeedbackStore(pluginDataDir, auth.store);
      return {
        ok: localSaved,
        localSaved,
        remoteSubmitted: false,
        error: '线上反馈凭证已过期或失效，已清除旧凭证，请重试。',
      };
    }
    if (res.status !== 202 && !res.ok) {
      return {
        ok: localSaved,
        localSaved,
        remoteSubmitted: false,
        error: `线上提交失败：${formatFeedbackError(res)}`,
      };
    }
    const requestId = String(res.data?.request_id || '');
    const status = String(res.data?.status || 'pending');
    auth.store.submissions = [
      { at: new Date().toISOString(), title: cleanTitle, kind, requestId, status },
      ...auth.store.submissions,
    ].slice(0, 50);
    writeFeedbackStore(pluginDataDir, auth.store);
    return {
      ok: true,
      localSaved,
      remoteSubmitted: true,
      requestId,
      status,
      kind,
      message: `已提交到 cnmeme.wiki（请求号 ${requestId || '已受理'}，状态 ${status}）${localSaved ? '，并已同步保存到本地词库' : ''}。`,
    };
  } catch (error) {
    return {
      ok: localSaved,
      localSaved,
      remoteSubmitted: false,
      error: `线上提交请求失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
