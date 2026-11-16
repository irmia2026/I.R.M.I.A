import { randomUUID } from 'node:crypto';

import { readConfig, readStats, recordHits, trollTierInfo, writeConfig } from './lib/config.mjs';
import { createMemeDb } from './lib/db.mjs';
import { resolvePluginDataDir } from './lib/paths.mjs';
import { syncCnmeme } from './lib/sync.mjs';

let pluginDataDir = resolvePluginDataDir();
let db = createMemeDb({ pluginDataDir });
let capabilities = [];
let lastObservedSeq = null;
let lastObservedText = '';
let latestHits = [];
let lastSyncInfo = null;
const readChannelCallIds = new Set();
const pendingHostRequests = new Map();
let nextHostReqId = 1;

const SYSTEM_VIA_SET = new Set([
  'system', 'compact', 'compact-soon', 'restart', 'mcp', 'grant', 'self-organize', 'dream',
]);

function sendJsonRpc(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendHostRequest(method, params) {
  const id = `memewiki-host-${nextHostReqId++}-${randomUUID()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHostRequests.delete(id);
      reject(new Error(`host request timeout: ${method}`));
    }, 5000);
    pendingHostRequests.set(id, { resolve, reject, timer });
    sendJsonRpc({ jsonrpc: '2.0', id, method, params });
  });
}

function switchDataDirIfNeeded(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') return;
  const resolved = resolvePluginDataDir(candidate);
  if (resolved === pluginDataDir) return;
  db.close();
  pluginDataDir = resolved;
  db = createMemeDb({ pluginDataDir });
}

function clipChars(value, maxChars) {
  const clean = String(value ?? '').replace(/\s+/gu, ' ').trim();
  const chars = [...clean];
  if (chars.length <= maxChars) return clean;
  if (maxChars <= 1) return chars.slice(0, Math.max(0, maxChars)).join('');
  return `${chars.slice(0, maxChars - 1).join('')}…`;
}

function splitTags(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw.split(/[、,，;；]/u).map((x) => x.trim()).filter(Boolean);
}

function compactSummary(row) {
  const raw = String(row?.summary || row?.origin || row?.usage || '').replace(/\s+/gu, ' ').trim();
  return raw.replace(/^来源\s*/u, '').trim();
}

function compactUsage(row) {
  return String(row?.usage || '').replace(/\s+/gu, ' ').trim();
}

function renderPromptLine(maxChars) {
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
    ? Math.trunc(Number(maxChars))
    : 160;
  const config = readConfig(pluginDataDir);
  const troll = trollTierInfo(config.trollLevel, config.trollEnabled);
  const hits = config.autoLookup ? latestHits : [];

  if (hits.length === 0 && !troll.guidance) {
    return '';
  }

  if (hits.length === 0) {
    return clipChars(`梗百科：${troll.guidance}`, limit);
  }

  const suffix = troll.guidance ? `｜${troll.guidance}` : '';
  const suffixLen = [...suffix].length;
  const ruleTag = '（先自然接梗别科普）';
  const primary = hits[0];
  const usageRaw = compactUsage(primary);
  const summaryRaw = compactSummary(primary);

  const buildSingle = (sumCap, useCap) => {
    const sumPart = sumCap > 0 && summaryRaw ? `=${clipChars(summaryRaw, sumCap)}` : '';
    const usePart = useCap > 0 && usageRaw ? `｜接法：${clipChars(usageRaw, useCap)}` : '';
    return `梗百科：「${primary.title}」${sumPart}${usePart}${ruleTag}${suffix}`;
  };

  let line = buildSingle(34, 45);
  if (hits.length > 1 && [...line].length + 24 <= limit) {
    const second = hits[1];
    const extra = `；「${second.title}」=${clipChars(compactSummary(second) || compactUsage(second), 18)}`;
    const withSecond = `梗百科：「${primary.title}」=${clipChars(summaryRaw, 22)}${usageRaw ? `｜接法：${clipChars(usageRaw, 26)}` : ''}${extra}${ruleTag}${suffix}`;
    if ([...withSecond].length <= limit) {
      line = withSecond;
    }
  }

  if ([...line].length <= limit) return line;

  const available = limit - [...`梗百科：「${primary.title}」${ruleTag}`].length - suffixLen;
  if (available >= 16) {
    const useCap = Math.min(45, Math.max(0, Math.floor(available * 0.55) - 4));
    const sumCap = Math.max(4, available - (useCap > 0 ? useCap + 4 : 0) - 1);
    const fitted = buildSingle(sumCap, useCap);
    if ([...fitted].length <= limit) return fitted;
  }

  const minimal = `梗百科：「${primary.title}」${ruleTag}${suffix}`;
  if ([...minimal].length <= limit) return minimal;
  return clipChars(minimal, limit);
}

function extractEventText(event) {
  if (!event || typeof event !== 'object') return '';
  const type = String(event.type || '');
  const data = event.data && typeof event.data === 'object' ? event.data : {};

  if (type === 'wake/channel' || type === 'channel/message' || type === 'wake/message' || type === 'message/user') {
    const parts = [];
    if (typeof data.text === 'string' && data.text.trim()) parts.push(data.text.trim());
    if (typeof data.note === 'string' && data.note.trim()) parts.push(data.note.trim());
    if (Array.isArray(data.attachments)) {
      for (const item of data.attachments) {
        if (item && typeof item === 'object' && typeof item.text === 'string' && item.text.trim()) {
          parts.push(item.text.trim());
        }
      }
    }
    return parts.join(' ').trim();
  }

  if (type === 'wake/manual') {
    const via = typeof data.via === 'string' ? data.via.trim() : '';
    if (via && SYSTEM_VIA_SET.has(via)) return '';
    const note = typeof data.note === 'string' ? data.note.trim() : '';
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    return note || text;
  }

  if (type === 'tool/call') {
    if (data.name === 'read_channel' && typeof data.callId === 'string' && data.callId) {
      readChannelCallIds.add(data.callId);
      if (readChannelCallIds.size > 100) {
        const first = readChannelCallIds.values().next().value;
        readChannelCallIds.delete(first);
      }
    }
    return '';
  }

  if (type === 'tool/result') {
    const isReadChannel = data.name === 'read_channel'
      || (typeof data.callId === 'string' && readChannelCallIds.has(data.callId));
    if (typeof data.callId === 'string') readChannelCallIds.delete(data.callId);
    const content = typeof data.content === 'string' ? data.content.trim() : '';
    if (!content) return '';
    if (isReadChannel || /^\s*·\s+\d{2}:\d{2}\s+/mu.test(content)) {
      return content;
    }
    return '';
  }

  return '';
}

function handleObserveEvent(params) {
  const event = params && typeof params === 'object' && params.event ? params.event : params;
  const text = extractEventText(event);
  if (!text) return;

  const seq = event?.seq ?? null;
  const isDuplicate = seq !== null && seq === lastObservedSeq && text === lastObservedText;
  lastObservedSeq = seq;
  lastObservedText = text;

  const config = readConfig(pluginDataDir);
  if (!config.autoLookup) {
    latestHits = [];
    return;
  }

  const hits = db.matchMessage(text, { limit: 2 });
  latestHits = hits;

  if (hits.length > 0 && !isDuplicate) {
    recordHits(pluginDataDir, hits.length);
    if (capabilities.includes('event.publish')) {
      const titles = hits.map((h) => h.title).join('、');
      void sendHostRequest('event/append', {
        type: 'plugin/linre-memewiki/hit',
        visibility: 'internal',
        data: { text: `命中梗词条：${titles}` },
      }).catch(() => undefined);
    }
  }
}

function buildEditPromptFields(row) {
  return [
    { key: 'title', label: '词条名', type: 'text', value: String(row.title || '') },
    { key: 'aliases', label: '别名（逗号分隔）', type: 'text', value: String(row.aliases || '') },
    { key: 'tags', label: '标签', type: 'text', value: String(row.tags || '') },
    { key: 'summary', label: '释义', type: 'text', multiline: true, value: String(row.summary || '') },
    { key: 'usage', label: '怎么用 / 怎么接', type: 'text', multiline: true, value: String(row.usage || '') },
    { key: 'origin', label: '出处', type: 'text', multiline: true, value: String(row.origin || '') },
  ];
}

function buildMemeGridItems(rows) {
  return rows.map((row) => {
    const aliases = splitTags(row.aliases);
    const tags = splitTags(row.tags);
    const summaryText = clipChars(compactSummary(row), 68);
    const usageText = clipChars(compactUsage(row), 48);
    const originText = clipChars(row.origin || '', 36);
    const subtitleParts = [];
    if (originText) subtitleParts.push(`出处：${originText}`);
    if (summaryText) subtitleParts.push(summaryText);
    if (usageText) subtitleParts.push(`接法：${usageText}`);
    return {
      title: String(row.title || ''),
      badge: clipChars(row.tags || (aliases[0] || '热梗'), 18),
      tone: 'ok',
      subtitle: subtitleParts.join(' ｜ ') || '暂无简介',
      chips: [...new Set([...aliases, ...tags])].slice(0, 6),
      actions: [
        {
          label: '编辑词条',
          kind: 'post',
          action: 'upsert_entry',
          params: { oldTitle: String(row.title || '') },
          promptFields: buildEditPromptFields(row),
        },
        {
          label: '删除',
          tone: 'danger',
          kind: 'post',
          action: 'delete_entry',
          params: { title: String(row.title || '') },
          confirm: `确定从本地词库删除「${String(row.title || '')}」？`,
        },
      ],
    };
  });
}

function buildUiDoc(params = {}) {
  const query = params && typeof params.query === 'object' && params.query ? params.query : {};
  const rawTab = String(query.tab || 'overview').trim();
  const tab = rawTab === 'browse' || rawTab === 'create' ? rawTab : 'overview';
  const q = String(query.q || '').trim();
  const page = Math.max(1, Math.trunc(Number(query.page) || 1));
  const pageSize = 24;

  const stats = db.getStats();
  const config = readConfig(pluginDataDir);
  const hitStats = readStats(pluginDataDir);
  const troll = trollTierInfo(config.trollLevel, config.trollEnabled);

  const blocks = [
    {
      type: 'tabs',
      active: tab,
      items: [
        { id: 'overview', label: '概览与设置' },
        { id: 'browse', label: '查词与改词' },
        { id: 'create', label: '新增词条' },
      ],
    },
  ];

  if (tab === 'overview') {
    blocks.push({
      type: 'hero',
      title: '梗百科 · 6792+ 本地黑话词典',
      subtitle: `内置 SQLite 离线词库（更新于 ${stats.builtAt || '未知'}），自动预查群聊热梗、按串子程度把控接梗分寸。`,
      badge: String(stats.total),
      tone: 'ok',
      chips: [
        { label: '预查', value: config.autoLookup ? '开启' : '关闭', tone: config.autoLookup ? 'ok' : 'muted' },
        { label: '串子', value: troll.tier, tone: config.trollEnabled ? 'warn' : 'muted' },
        { label: '数据源', value: stats.isUserCopy ? 'plugin-data 可写副本' : '包内只读库', tone: 'primary' },
      ],
    });
    blocks.push({
      type: 'metrics',
      title: '词库与命中概览',
      items: [
        { label: '词条总数', value: String(stats.total), unit: '条', tone: 'ok' },
        { label: '本地数据源状态', value: stats.isUserCopy ? '可写副本' : '只读内置', tone: stats.isUserCopy ? 'ok' : 'muted' },
        { label: '累计命中次数', value: String(hitStats.hitCount), unit: '次', tone: 'primary' },
        { label: '当前串子档位', value: troll.shortLabel, tone: config.trollEnabled ? 'warn' : 'muted' },
      ],
    });
    blocks.push({
      type: 'form',
      title: '预查与串子设置',
      kind: 'post',
      action: 'save_settings',
      submitLabel: '保存设置',
      fields: [
        { key: 'autoLookup', label: '自动预查消息里的梗', type: 'switch', value: config.autoLookup },
        { key: 'trollEnabled', label: '开启串子程度调节', type: 'switch', value: config.trollEnabled },
        { key: 'trollLevel', label: '串子程度', type: 'slider', min: 0, max: 100, divisions: 20, value: config.trollLevel },
        { key: 'nickname', label: '反馈提交昵称', type: 'text', placeholder: '林芮', value: config.nickname },
        { key: 'contact', label: 'cnmeme.wiki 联系方式（可选）', type: 'text', placeholder: '邮箱或社交账号，仅用于领凭证', value: config.contact },
      ],
    });
    blocks.push({
      type: 'actions',
      items: [
        {
          label: '从 cnmeme.wiki 同步最新词条',
          tone: 'ok',
          kind: 'post',
          action: 'sync_online',
          confirm: '从 cnmeme.wiki 增量同步最新公开词条到本地可写库？',
        },
        {
          label: '随机抽几条看看',
          kind: 'query',
          query: { tab: 'browse', q: '__random__' },
        },
      ],
    });
    if (lastSyncInfo) {
      blocks.push({
        type: 'kv',
        title: '最近一次同步',
        items: [
          { key: '结果', value: lastSyncInfo.message },
          { key: '时间', value: lastSyncInfo.at },
        ],
      });
    }
    return { title: '梗百科', blocks };
  }

  if (tab === 'browse') {
    blocks.push({
      type: 'form',
      title: '检索本地词条',
      kind: 'query',
      submitLabel: '搜索',
      fields: [
        {
          key: 'q',
          label: '关键词',
          type: 'text',
          placeholder: '输入梗名、别名、标签或释义...',
          value: q === '__random__' ? '' : q,
        },
      ],
    });
    blocks.push({
      type: 'actions',
      items: [
        { label: '随机抽几条', kind: 'query', query: { tab: 'browse', q: '__random__' } },
        { label: '恢复全部列表', kind: 'query', query: { tab: 'browse', q: '', page: '1' } },
      ],
    });

    const listed = db.listMemes({ q, limit: pageSize, offset: (page - 1) * pageSize });
    if (listed.items.length === 0) {
      blocks.push({
        type: 'empty',
        text: q ? `没有找到匹配「${q}」的词条` : '词库里还没有词条',
      });
    } else {
      const titleLabel = q === '__random__'
        ? `随机抽取 ${listed.items.length} 条`
        : (q ? `「${q}」命中 ${listed.total} 条（当前第 ${page} 页）` : `词条列表（共 ${listed.total} 条，第 ${page} 页）`);
      blocks.push({
        type: 'grid',
        title: titleLabel,
        items: buildMemeGridItems(listed.items),
      });
      if (q !== '__random__' && listed.total > pageSize) {
        const navActions = [];
        if (page > 1) {
          navActions.push({ label: '上一页', kind: 'query', query: { tab: 'browse', q, page: String(page - 1) } });
        }
        if (page * pageSize < listed.total) {
          navActions.push({ label: '下一页', kind: 'query', query: { tab: 'browse', q, page: String(page + 1) } });
        }
        if (navActions.length > 0) {
          blocks.push({ type: 'actions', items: navActions });
        }
      }
    }
    return { title: '梗百科', blocks };
  }

  blocks.push({
    type: 'form',
    title: '新增词条到本地词库',
    kind: 'post',
    action: 'upsert_entry',
    submitLabel: '保存词条',
    fields: [
      { key: 'title', label: '词条名', type: 'text', placeholder: '例如：去码头整点薯条', value: '' },
      { key: 'aliases', label: '别名（逗号分隔）', type: 'text', placeholder: '缩写或俗称', value: '' },
      { key: 'tags', label: '标签', type: 'text', placeholder: '例如：动物梗、反差', value: '' },
      { key: 'summary', label: '释义', type: 'text', multiline: true, value: '' },
      { key: 'usage', label: '怎么用 / 怎么接', type: 'text', multiline: true, value: '' },
      { key: 'origin', label: '出处', type: 'text', multiline: true, value: '' },
    ],
  });
  return { title: '梗百科', blocks };
}

async function handleUiInvoke(params = {}) {
  const action = String(params?.action || '').trim();
  if (action === 'save_settings') {
    const saved = writeConfig(pluginDataDir, params);
    return {
      ok: true,
      message: `设置已保存（预查：${saved.autoLookup ? '开' : '关'}，串子：${saved.trollEnabled ? saved.trollLevel : '关'}）`,
      refresh: true,
    };
  }
  if (action === 'upsert_entry') {
    const res = db.upsertMeme({
      title: params.title,
      oldTitle: params.oldTitle,
      aliases: params.aliases,
      tags: params.tags,
      summary: params.summary,
      usage: params.usage,
      origin: params.origin,
    });
    return {
      ok: true,
      message: `已保存词条「${res.row.title}」（当前共 ${res.total} 条）`,
      refresh: true,
      query: { tab: 'browse', q: res.row.title },
    };
  }
  if (action === 'delete_entry') {
    const res = db.deleteMeme(params.title);
    return {
      ok: res.deleted > 0,
      message: res.deleted > 0
        ? `已删除词条「${String(params.title || '').trim()}」（剩余 ${res.total} 条）`
        : `未找到词条「${String(params.title || '').trim()}」`,
      refresh: true,
    };
  }
  if (action === 'sync_online') {
    try {
      const res = await syncCnmeme({ db, pluginDataDir, noExisting: true });
      const msg = `同步完成：新增 ${res.added} 条，更新 ${res.updated} 条，现共 ${res.total} 条`;
      lastSyncInfo = { at: new Date().toISOString(), message: msg };
      return { ok: true, message: msg, refresh: true };
    } catch (error) {
      const msg = `同步失败：${error instanceof Error ? error.message : String(error)}`;
      lastSyncInfo = { at: new Date().toISOString(), message: msg };
      return { ok: false, message: msg, refresh: true };
    }
  }
  return { ok: false, message: `未知操作：${action || '(空)'}` };
}

async function handleMessage(message) {
  if (!message || message.jsonrpc !== '2.0') return;
  if (message.method === undefined && message.id !== undefined) {
    const pending = pendingHostRequests.get(message.id);
    if (!pending) return;
    pendingHostRequests.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      pending.reject(new Error(String(message.error?.message || 'host error')));
    } else {
      pending.resolve(message.result);
    }
    return;
  }

  const { id, method, params } = message;
  if (typeof method !== 'string') return;

  if (method === 'initialize') {
    capabilities = Array.isArray(params?.capabilities) ? [...params.capabilities] : [];
    switchDataDirIfNeeded(params?.config?.dataDir ?? params?.dataDir);
    if (id !== undefined) {
      sendJsonRpc({ jsonrpc: '2.0', id, result: { ok: true, id: 'linre-memewiki', version: '0.1.0' } });
    }
    return;
  }

  if (method === 'adapter/init') {
    switchDataDirIfNeeded(params?.config?.dataDir ?? params?.dataDir);
    if (id !== undefined) {
      sendJsonRpc({ jsonrpc: '2.0', id, result: { ok: true } });
    }
    return;
  }

  if (method === 'events/observe') {
    try {
      handleObserveEvent(params);
    } catch {
    }
    if (id !== undefined) {
      sendJsonRpc({ jsonrpc: '2.0', id, result: { ok: true } });
    }
    return;
  }

  if (method === 'prompt/render') {
    try {
      const text = renderPromptLine(params?.maxChars);
      sendJsonRpc({ jsonrpc: '2.0', id, result: { text } });
    } catch (error) {
      sendJsonRpc({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      });
    }
    return;
  }

  if (method === 'ui/handle') {
    try {
      const path = String(params?.path || '/state');
      if (path !== '/state' && !path.startsWith('/ui/')) {
        sendJsonRpc({ jsonrpc: '2.0', id, error: { code: -32602, message: `未知视图路径：${path}` } });
        return;
      }
      sendJsonRpc({ jsonrpc: '2.0', id, result: buildUiDoc(params) });
    } catch (error) {
      sendJsonRpc({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      });
    }
    return;
  }

  if (method === 'ui/invoke') {
    try {
      const result = await handleUiInvoke(params);
      sendJsonRpc({ jsonrpc: '2.0', id, result });
    } catch (error) {
      sendJsonRpc({
        jsonrpc: '2.0',
        id,
        result: { ok: false, message: error instanceof Error ? error.message : String(error), refresh: false },
      });
    }
    return;
  }

  if (id !== undefined) {
    sendJsonRpc({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      void handleMessage(JSON.parse(line));
    } catch {
    }
  }
});

process.stdin.on('end', () => {
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
