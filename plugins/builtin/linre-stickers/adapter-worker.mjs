import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import {
  blockCatalogItem,
  createEmptyCatalog,
  loadCatalogRaw,
  migrateAndLoadCatalog,
  normalizeItem,
  normalizeSettings,
  readCatalogIfChanged,
  resolveItemFilePath,
  resolvePluginDataDir,
  saveCatalogAtomic,
} from './lib/catalog-store.mjs';
import { inspectImageBuffer, isDuplicateOrBlocked } from './lib/image-fp.mjs';
import { EMOTIONS, keywordsOf, normalizeEmotion, pickSticker, renderStickerLine } from './lib/picker.mjs';

const PLUGIN_ID = 'linre-stickers';
const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const VLM_MIN_GAP_MS = Number.isFinite(Number(process.env.LINRE_STICKERS_VLM_GAP_MS))
  ? Math.max(0, Number(process.env.LINRE_STICKERS_VLM_GAP_MS))
  : 3000;
const VLM_TIMEOUT_MS = 6000;
const MAX_STEAL_BASE64_BYTES = 1_500_000;

let dataDir = resolvePluginDataDir();
let catalog = createEmptyCatalog();
let catalogMtimeMs = 0;
let ownerIds = new Set();

let recentText = '';
let currentEmotion = '';
let speaksWithoutSticker = 0;
let lastRecommendedTurn = null;
let recentIds = [];

let nextId = 1;
const pendingRpc = new Map();

const stealQueue = [];
const queuedAttachmentIds = new Set();
let stealRunning = false;
let lastVlmCallMs = 0;

const stats = {
  nonStickerSkipped: 0,
  dedupSkipped: 0,
  blockedSkipped: 0,
  vlmFailures: 0,
};

function syncFromDisk() {
  if (!dataDir) return;
  const res = readCatalogIfChanged(dataDir, catalogMtimeMs, catalog);
  if (res.changed) {
    catalog = res.catalog;
    catalogMtimeMs = res.mtimeMs;
  }
}

function persistCatalog() {
  if (!dataDir) return false;
  try {
    catalogMtimeMs = saveCatalogAtomic(dataDir, catalog);
    return true;
  } catch (error) {
    process.stderr.write(`[${PLUGIN_ID}] catalog save failed: ${String(error)}\n`);
    return false;
  }
}

function callHost(method, params, timeoutMs = 8000) {
  const id = `${PLUGIN_ID}:${nextId++}`;
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pendingRpc.delete(id);
      rejectPromise(new Error(`${method} timeout`));
    }, timeoutMs);
    pendingRpc.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
    try {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    } catch (error) {
      clearTimeout(timer);
      pendingRpc.delete(id);
      rejectPromise(error);
    }
  });
}

function reply(id, body) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseVlmJson(rawText) {
  if (typeof rawText !== 'string' || rawText.trim() === '') return null;
  let cleaned = rawText.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned);
  if (fenced) cleaned = fenced[1].trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

function buildVlmPrompt(hintName = '') {
  const hint = hintName ? `文件名提示：${hintName}\n` : '';
  return `${hint}请判断这张图片是否适合作为聊天表情包/梗图（代码截图、长文章截图、纯聊天记录截图、普通风景证件照算作 false）。严格输出纯 JSON（不要多余解释）：\n{"isSticker":true,"emotion":"开心|难过|担心|生气|亲近|好奇|无语|得意|害羞","tags":["标签1","标签2"],"caption":"简短描述(<=20字)","intensity":3,"confidence":0.9}`;
}

async function classifyWithVlm(mimeType, dataBase64, hintName = '') {
  const now = Date.now();
  const waitMs = lastVlmCallMs > 0 ? Math.max(0, VLM_MIN_GAP_MS - (now - lastVlmCallMs)) : 0;
  if (waitMs > 0) await sleep(waitMs);
  lastVlmCallMs = Date.now();
  try {
    const res = await callHost(
      'model/generate',
      {
        lane: 'light',
        prompt: buildVlmPrompt(hintName),
        images: [{ mimeType, dataBase64 }],
        maxTokens: 300,
      },
      VLM_TIMEOUT_MS,
    );
    const rawText = typeof res === 'string'
      ? res
      : (res?.text ?? res?.content ?? res?.output ?? res?.choices?.[0]?.message?.content ?? '');
    const parsed = parseVlmJson(rawText);
    if (!parsed) {
      stats.vlmFailures += 1;
      return { ok: false, isSticker: true, emotion: '无语', tags: ['待分类'], caption: hintName || '未识别表情', intensity: 3, confidence: 0.3 };
    }
    if (parsed.isSticker === false) {
      return { ok: true, isSticker: false };
    }
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.filter((t) => typeof t === 'string' && t.trim() !== '').map((t) => t.trim().slice(0, 24)).slice(0, 10)
      : [];
    const emotion = normalizeEmotion(parsed.emotion, '开心');
    const caption = typeof parsed.caption === 'string' && parsed.caption.trim() !== ''
      ? parsed.caption.trim().slice(0, 80)
      : (hintName || emotion);
    const intensityNum = Number(parsed.intensity);
    const confidenceNum = Number(parsed.confidence);
    return {
      ok: true,
      isSticker: true,
      emotion,
      tags: tags.length > 0 ? tags : [emotion],
      caption,
      intensity: Number.isFinite(intensityNum) ? Math.max(1, Math.min(5, Math.round(intensityNum))) : 3,
      confidence: Number.isFinite(confidenceNum) ? Math.max(0, Math.min(1, confidenceNum)) : 0.85,
    };
  } catch {
    stats.vlmFailures += 1;
    return { ok: false, isSticker: true, emotion: '无语', tags: ['待分类'], caption: hintName || '未识别表情', intensity: 3, confidence: 0.3 };
  }
}

function evictOldestPendingIfNeeded() {
  const maxPending = catalog.settings.maxPending || 200;
  let pendingList = catalog.items.filter((x) => x.status === 'pending');
  while (pendingList.length >= maxPending) {
    pendingList.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const victim = pendingList[0];
    if (!victim) break;
    catalog.items = catalog.items.filter((x) => x.id !== victim.id);
    pendingList = pendingList.slice(1);
  }
}

function persistLocalStickerBytes(sha256, ext, buf) {
  if (!dataDir) return '';
  const dir = join(dataDir, 'images');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${sha256}${ext}`);
  if (!existsSync(target)) {
    writeFileSync(target, buf);
  }
  return target;
}

async function processStealJob(job) {
  let resolved;
  try {
    resolved = await callHost('media/resolve', { attachmentId: job.attachmentId }, 10000);
  } catch {
    return;
  }
  if (!resolved || typeof resolved !== 'object' || resolved.ok === false) return;

  let buf = null;
  let b64 = typeof resolved.dataBase64 === 'string' ? resolved.dataBase64 : '';
  if (b64 !== '') {
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      buf = null;
    }
  } else if (typeof resolved.path === 'string' && resolved.path !== '' && existsSync(resolved.path)) {
    try {
      buf = readFileSync(resolved.path);
      b64 = buf.toString('base64');
    } catch {
      buf = null;
    }
  }
  if (!buf) return;

  const info = inspectImageBuffer(buf);
  if (!info) return;

  syncFromDisk();
  const preCheck = isDuplicateOrBlocked(info, catalog.items, catalog.blocked);
  if (preCheck.matched) {
    if (preCheck.kind === 'blocked') stats.blockedSkipped += 1;
    else stats.dedupSkipped += 1;
    return;
  }

  if (Buffer.byteLength(b64, 'utf8') > MAX_STEAL_BASE64_BYTES) {
    stats.nonStickerSkipped += 1;
    return;
  }

  const vlm = await classifyWithVlm(info.mimeType, b64, job.name);
  if (vlm.isSticker === false) {
    stats.nonStickerSkipped += 1;
    return;
  }

  syncFromDisk();
  const postCheck = isDuplicateOrBlocked(info, catalog.items, catalog.blocked);
  if (postCheck.matched) {
    if (postCheck.kind === 'blocked') stats.blockedSkipped += 1;
    else stats.dedupSkipped += 1;
    return;
  }

  const itemPath = typeof resolved.path === 'string' && resolved.path !== ''
    ? resolved.path
    : persistLocalStickerBytes(info.sha256, info.ext, buf);
  if (!itemPath) return;

  const nowIso = new Date().toISOString();
  const shouldApprove = Boolean(catalog.settings.autoApproveOwner && job.isOwner && vlm.ok);
  if (!shouldApprove) evictOldestPendingIfNeeded();

  const item = normalizeItem({
    id: info.sha256.slice(0, 16),
    sha256: info.sha256,
    fp64: info.fp64,
    path: itemPath,
    mediaUrl: typeof resolved.mediaUrl === 'string' ? resolved.mediaUrl : '',
    mimeType: info.mimeType,
    sizeBytes: info.sizeBytes,
    status: shouldApprove ? 'approved' : 'pending',
    emotion: vlm.emotion,
    tags: vlm.tags,
    caption: vlm.caption,
    intensity: vlm.intensity,
    confidence: vlm.confidence,
    sourceChatId: job.sourceChatId,
    sourcePerson: job.sourcePerson,
    sourceNickname: job.sourceNickname,
    createdAt: nowIso,
    reviewedAt: shouldApprove ? nowIso : null,
    useCount: 0,
    lastUsedAt: null,
  });

  catalog.items.unshift(item);
  persistCatalog();

  callHost('event/append', {
    type: 'linre-stickers/captured',
    visibility: 'internal',
    data: {
      id: item.id,
      emotion: item.emotion,
      caption: item.caption,
      status: item.status,
      sourceChatId: item.sourceChatId,
      sourceNickname: item.sourceNickname,
    },
  }).catch(() => {});
}

async function runStealQueue() {
  if (stealRunning) return;
  stealRunning = true;
  try {
    while (stealQueue.length > 0) {
      const job = stealQueue.shift();
      if (!job) continue;
      try {
        await processStealJob(job);
      } catch (error) {
        process.stderr.write(`[${PLUGIN_ID}] steal job error: ${String(error)}\n`);
      } finally {
        queuedAttachmentIds.delete(job.attachmentId);
      }
    }
  } finally {
    stealRunning = false;
  }
}

function enqueueStealJob(job) {
  if (!job || !job.attachmentId || queuedAttachmentIds.has(job.attachmentId)) return;
  queuedAttachmentIds.add(job.attachmentId);
  stealQueue.push(job);
  void runStealQueue();
}

function textOf(data) {
  if (data === null || typeof data !== 'object') return '';
  if (typeof data.text === 'string') return data.text;
  if (Array.isArray(data.parts)) {
    return data.parts
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join(' ');
  }
  return '';
}

function pushRecentId(id) {
  recentIds = [id, ...recentIds.filter((x) => x !== id)].slice(0, 5);
}

function observe(event) {
  if (event === null || typeof event !== 'object') return;
  const type = typeof event.type === 'string' ? event.type : '';
  const data = event.data && typeof event.data === 'object' ? event.data : {};

  if (type === 'linre-affect/appraisal') {
    const rawEmotion = data.emotion ?? data.dominant ?? data.mood ?? data.appraisal?.emotion ?? data.label ?? '';
    const norm = normalizeEmotion(rawEmotion, '');
    if (norm !== '') currentEmotion = norm;
  }

  if (type === 'tool/call') {
    const toolName = String(data.tool ?? data.name ?? data.toolName ?? '').trim();
    if (toolName === 'speak') {
      speaksWithoutSticker += 1;
    } else if (toolName === 'send_media') {
      speaksWithoutSticker = 0;
      const sentPath = String(data.arguments?.path ?? data.args?.path ?? data.path ?? '').trim();
      if (sentPath !== '') {
        syncFromDisk();
        const match = catalog.items.find((x) => x.path === sentPath || resolve(x.path || '.') === resolve(sentPath));
        if (match) {
          match.useCount = (Number(match.useCount) || 0) + 1;
          match.lastUsedAt = new Date().toISOString();
          match.lastUsedMs = Date.now();
          pushRecentId(match.id);
          persistCatalog();
        }
      }
    }
  }

  const text = textOf(data).trim();
  if (text !== '') {
    recentText = [...text].slice(0, 500).join('');
  }

  if ((type === 'wake/channel' || type === 'channel/message') && catalog.settings.autoSteal !== false) {
    const attachments = Array.isArray(data.attachments) ? data.attachments : [];
    const sourceChatId = String(data.chatId ?? data.channelId ?? data.groupId ?? data.peerId ?? '');
    const sourcePerson = String(data.senderId ?? data.userId ?? data.authorId ?? data.fromId ?? '');
    const sourceNickname = String(data.senderName ?? data.nickname ?? data.authorName ?? data.senderNickname ?? '');
    const isOwner = Boolean(data.isOwner) || (sourcePerson !== '' && ownerIds.has(sourcePerson));
    for (const att of attachments) {
      if (!att || typeof att !== 'object') continue;
      const attType = typeof att.type === 'string' ? att.type.toLowerCase() : '';
      const attachmentId = typeof att.attachmentId === 'string' ? att.attachmentId.trim() : '';
      if (attachmentId !== '' && (attType === 'image' || attType.startsWith('image/'))) {
        enqueueStealJob({
          attachmentId,
          name: typeof att.name === 'string' ? att.name : '',
          sourceChatId,
          sourcePerson,
          sourceNickname,
          isOwner,
        });
      }
    }
  }
}

function renderFor(params) {
  syncFromDisk();
  const maxChars = Number.isSafeInteger(params.maxChars) ? params.maxChars : 160;
  const turn = params.turn !== undefined && params.turn !== null ? params.turn : null;
  if (turn !== null && turn === lastRecommendedTurn) return '';

  let nowMs = Date.now();
  if (Number.isFinite(Number(params.now))) nowMs = Number(params.now);
  else if (typeof params.now === 'string' && Number.isFinite(Date.parse(params.now))) nowMs = Date.parse(params.now);

  const cooldownMs = Math.max(0, Number(catalog.settings.cooldownSec ?? 180) * 1000);
  const picked = pickSticker(catalog.items, {
    keywords: keywordsOf(recentText),
    emotion: currentEmotion,
    nowMs,
    cooldownMs,
    recentIds,
    speaksWithoutSticker,
    fallbackAfterSpeaks: catalog.settings.fallbackAfterSpeaks ?? 5,
  });
  if (picked === null) return '';

  const entry = catalog.items.find((item) => item.id === picked.id);
  if (entry) {
    entry.lastUsedMs = nowMs;
    entry.lastUsedAt = new Date(nowMs).toISOString();
  }
  pushRecentId(picked.id);
  if (turn !== null) lastRecommendedTurn = turn;
  persistCatalog();
  return renderStickerLine(picked, maxChars);
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function editPromptFields(item) {
  return [
    { key: 'emotion', label: '主情绪分类', type: 'select', value: item.emotion || '开心', options: EMOTIONS },
    { key: 'tags', label: '标签（逗号分隔）', type: 'text', value: Array.isArray(item.tags) ? item.tags.join(',') : '' },
    { key: 'caption', label: '描述', type: 'text', value: item.caption || '' },
    { key: 'intensity', label: '强烈度 (1-5)', type: 'slider', min: 1, max: 5, value: Number(item.intensity) || 3 },
  ];
}

function buildView() {
  syncFromDisk();
  const approved = catalog.items.filter((x) => x.status === 'approved');
  const pendingItems = catalog.items.filter((x) => x.status === 'pending');
  return {
    atMs: Date.now(),
    total: catalog.items.length,
    approved: approved.length,
    pending: pendingItems.length,
    blocked: catalog.blocked.length,
    speaksWithoutSticker,
    currentEmotion,
    items: catalog.items,
    settings: catalog.settings,
  };
}

function buildSchema(query = {}) {
  syncFromDisk();
  const pendingItems = catalog.items.filter((x) => x.status === 'pending');
  const approvedItems = catalog.items.filter((x) => x.status === 'approved');
  const validTabs = ['pending', 'approved', 'blocked', 'settings'];
  const requestedTab = typeof query.tab === 'string' ? query.tab : '';
  const activeTab = validTabs.includes(requestedTab)
    ? requestedTab
    : (pendingItems.length > 0 ? 'pending' : 'approved');
  const emotionFilter = typeof query.emotion === 'string' && query.emotion !== '全部' ? query.emotion.trim() : '';

  const blocks = [
    {
      type: 'tabs',
      active: activeTab,
      items: [
        { id: 'pending', label: `待审核 (${pendingItems.length})` },
        { id: 'approved', label: `已入库 (${approvedItems.length})` },
        { id: 'blocked', label: `黑名单 (${catalog.blocked.length})` },
        { id: 'settings', label: '采集设置' },
      ],
    },
    {
      type: 'metrics',
      items: [
        { label: '待审核数', value: String(pendingItems.length), tone: pendingItems.length > 0 ? 'warn' : 'muted' },
        { label: '已入库数', value: String(approvedItems.length), tone: 'ok' },
        { label: '已拉黑拦截数', value: String(catalog.blocked.length + stats.blockedSkipped), tone: 'err' },
        { label: '连聊未配图轮数', value: String(speaksWithoutSticker), tone: speaksWithoutSticker >= catalog.settings.fallbackAfterSpeaks ? 'warn' : 'primary' },
      ],
    },
  ];

  if (activeTab === 'pending') {
    blocks.push({
      type: 'actions',
      items: [
        { label: '全部通过待审', tone: 'ok', kind: 'post', action: 'approve_all_pending' },
        { label: '清空待审（不拉黑）', tone: 'warn', kind: 'post', action: 'clear_pending', confirm: '确定清空所有待审核表情包（不会加入黑名单）？' },
        {
          label: '从本地目录导入',
          kind: 'post',
          action: 'import_dir',
          promptFields: [
            { key: 'dirPath', label: '本地图片目录路径', type: 'text', value: '' },
            { key: 'autoApprove', label: '直接入库免审', type: 'switch', value: true },
          ],
        },
      ],
    });
    if (pendingItems.length === 0) {
      blocks.push({ type: 'empty', title: '暂无待审核表情包', subtitle: '群聊收到的新图片或手工推荐的图片会出现在这里。' });
    } else {
      blocks.push({
        type: 'grid',
        title: `待审核队列 (${pendingItems.length})`,
        items: pendingItems.map((item) => ({
          id: item.id,
          image: item.mediaUrl || item.path,
          title: item.caption || item.id,
          badge: item.emotion || '无语',
          tone: 'warn',
          dots: { filled: Math.max(1, Math.min(5, Number(item.intensity) || 3)), total: 5 },
          subtitle: `${item.sourceNickname || item.sourcePerson || item.sourceChatId || '本地'} · ${formatBytes(item.sizeBytes)}`,
          chips: Array.isArray(item.tags) ? item.tags : [],
          actions: [
            { label: '通过', tone: 'ok', kind: 'post', action: 'approve', params: { id: item.id } },
            { label: '拒绝拉黑', tone: 'err', kind: 'post', action: 'reject_block', params: { id: item.id } },
            { label: '改分类', kind: 'post', action: 'edit_item', params: { id: item.id }, promptFields: editPromptFields(item) },
            { label: 'AI重识', kind: 'post', action: 'reanalyze', params: { id: item.id } },
          ],
        })),
      });
    }
  } else if (activeTab === 'approved') {
    const filterButtons = [
      { label: '全部', tone: emotionFilter === '' ? 'primary' : 'muted', kind: 'query', query: { tab: 'approved', emotion: '' } },
      ...EMOTIONS.map((em) => ({
        label: em,
        tone: emotionFilter === em ? 'primary' : 'muted',
        kind: 'query',
        query: { tab: 'approved', emotion: em },
      })),
    ];
    blocks.push({ type: 'actions', items: filterButtons });
    const filtered = emotionFilter ? approvedItems.filter((x) => x.emotion === emotionFilter) : approvedItems;
    if (filtered.length === 0) {
      blocks.push({ type: 'empty', title: '暂无已入库表情包', subtitle: emotionFilter ? `当前「${emotionFilter}」分类下没有表情包。` : '请先在待审核区通过图片或导入本地目录。' });
    } else {
      blocks.push({
        type: 'grid',
        title: `已入库图库 (${filtered.length})`,
        items: filtered.map((item) => ({
          id: item.id,
          image: item.mediaUrl || item.path,
          title: item.caption || item.id,
          badge: item.emotion || '开心',
          tone: 'ok',
          dots: { filled: Math.max(1, Math.min(5, Number(item.intensity) || 3)), total: 5 },
          subtitle: `使用 ${item.useCount || 0} 次 · ${formatBytes(item.sizeBytes)}`,
          chips: Array.isArray(item.tags) ? item.tags : [],
          actions: [
            { label: '改分类', kind: 'post', action: 'edit_item', params: { id: item.id }, promptFields: editPromptFields(item) },
            { label: '退回待审', tone: 'warn', kind: 'post', action: 'unapprove', params: { id: item.id } },
            { label: '删除拉黑', tone: 'err', kind: 'post', action: 'delete_block', params: { id: item.id }, confirm: '确定删除该表情包并加入黑名单？' },
          ],
        })),
      });
    }
  } else if (activeTab === 'blocked') {
    blocks.push({
      type: 'actions',
      items: [
        { label: '清空黑名单', tone: 'err', kind: 'post', action: 'clear_blocked', confirm: '确定清空所有黑名单记录？' },
      ],
    });
    if (catalog.blocked.length === 0) {
      blocks.push({ type: 'empty', title: '黑名单为空', subtitle: '被拒绝或删除拉黑的图片哈希会记录在此，避免再次被自动偷取。' });
    } else {
      blocks.push({
        type: 'list',
        title: `已拉黑哈希 (${catalog.blocked.length})`,
        items: catalog.blocked.map((entry) => ({
          title: entry.sha256.slice(0, 16),
          subtitle: `fp64: ${entry.fp64 || '-'} · ${entry.reason || '已拉黑'} · ${entry.blockedAt || ''}`,
          badge: '已拉黑',
          tone: 'err',
          actions: [
            { label: '解除拉黑', tone: 'ok', kind: 'post', action: 'unblock', params: { sha256: entry.sha256 } },
          ],
        })),
      });
    }
  } else if (activeTab === 'settings') {
    blocks.push({
      type: 'form',
      title: '采集与配图设置',
      kind: 'post',
      action: 'save_settings',
      submitLabel: '保存设置',
      fields: [
        { key: 'autoSteal', label: '开启自动偷图', type: 'switch', value: Boolean(catalog.settings.autoSteal) },
        { key: 'autoApproveOwner', label: '主人发的图免审直接入库', type: 'switch', value: Boolean(catalog.settings.autoApproveOwner) },
        { key: 'cooldownSec', label: '同图冷却时间（秒）', type: 'slider', min: 10, max: 1800, value: Number(catalog.settings.cooldownSec) || 180 },
        { key: 'fallbackAfterSpeaks', label: '连聊纯文字几轮后兜底配图', type: 'slider', min: 1, max: 20, value: Number(catalog.settings.fallbackAfterSpeaks) || 5 },
        { key: 'maxPending', label: '待审核池上限', type: 'slider', min: 20, max: 500, value: Number(catalog.settings.maxPending) || 200 },
      ],
    });
  }

  return { title: '表情包', blocks };
}

function parseTagsInput(raw) {
  if (Array.isArray(raw)) {
    return raw.filter((t) => typeof t === 'string').map((t) => t.trim()).filter(Boolean).slice(0, 16);
  }
  if (typeof raw === 'string') {
    return raw.split(/[,，\n]/).map((t) => t.trim()).filter(Boolean).slice(0, 16);
  }
  return null;
}

async function invokeUi(params) {
  syncFromDisk();
  const action = typeof params?.action === 'string' ? params.action : '';
  const id = typeof params?.id === 'string' ? params.id : (typeof params?.target === 'string' ? params.target : '');

  if (action === 'approve_all_pending') {
    const nowIso = new Date().toISOString();
    let count = 0;
    for (const item of catalog.items) {
      if (item.status === 'pending') {
        item.status = 'approved';
        item.reviewedAt = nowIso;
        count += 1;
      }
    }
    persistCatalog();
    return { ok: true, refresh: true, message: `已全部通过 ${count} 张待审表情` };
  }

  if (action === 'clear_pending') {
    const before = catalog.items.length;
    catalog.items = catalog.items.filter((x) => x.status !== 'pending');
    const removed = before - catalog.items.length;
    persistCatalog();
    return { ok: true, refresh: true, message: `已清空 ${removed} 张待审表情` };
  }

  if (action === 'clear_blocked') {
    const count = catalog.blocked.length;
    catalog.blocked = [];
    persistCatalog();
    return { ok: true, refresh: true, message: `已清空 ${count} 条黑名单记录` };
  }

  if (action === 'unblock') {
    const sha256 = typeof params?.sha256 === 'string' ? params.sha256.trim() : '';
    const before = catalog.blocked.length;
    catalog.blocked = catalog.blocked.filter((b) => b.sha256 !== sha256);
    if (catalog.blocked.length === before) return { ok: false, message: '未找到该黑名单记录' };
    persistCatalog();
    return { ok: true, refresh: true, message: '已解除拉黑' };
  }

  if (action === 'save_settings') {
    catalog.settings = normalizeSettings({
      autoSteal: params.autoSteal ?? catalog.settings.autoSteal,
      autoApproveOwner: params.autoApproveOwner ?? catalog.settings.autoApproveOwner,
      cooldownSec: params.cooldownSec ?? catalog.settings.cooldownSec,
      fallbackAfterSpeaks: params.fallbackAfterSpeaks ?? catalog.settings.fallbackAfterSpeaks,
      maxPending: params.maxPending ?? catalog.settings.maxPending,
    });
    persistCatalog();
    return { ok: true, refresh: true, message: '设置已保存' };
  }

  if (action === 'import_dir') {
    const dirPath = typeof params?.dirPath === 'string' ? params.dirPath.trim() : '';
    if (!dirPath) return { ok: false, message: '请提供本地图片目录路径' };
    const resolvedDir = resolve(dirPath);
    if (!existsSync(resolvedDir) || !statSync(resolvedDir).isDirectory()) {
      return { ok: false, message: `目录不存在或不可读取: ${dirPath}` };
    }
    const autoApprove = params.autoApprove !== false;
    const entries = readdirSync(resolvedDir, { withFileTypes: true }).slice(0, 200);
    let imported = 0;
    let skipped = 0;
    const nowIso = new Date().toISOString();

    for (const dirent of entries) {
      if (!dirent.isFile()) continue;
      const ext = extname(dirent.name).toLowerCase();
      if (!ALLOWED_IMAGE_EXTS.has(ext)) continue;
      const fullPath = join(resolvedDir, dirent.name);
      let buf;
      try {
        buf = readFileSync(fullPath);
      } catch {
        skipped += 1;
        continue;
      }
      const info = inspectImageBuffer(buf);
      if (!info) {
        skipped += 1;
        continue;
      }
      const dup = isDuplicateOrBlocked(info, catalog.items, catalog.blocked);
      if (dup.matched) {
        skipped += 1;
        continue;
      }

      let storedPath = '';
      let mediaUrl = '';
      try {
        const stored = await callHost('media/store', { kind: 'image', data: buf.toString('base64'), mimeType: info.mimeType }, 5000);
        if (stored && typeof stored.path === 'string' && stored.path !== '') storedPath = stored.path;
        if (stored && typeof stored.mediaUrl === 'string') mediaUrl = stored.mediaUrl;
      } catch {
        storedPath = '';
      }
      if (!storedPath) {
        if (dataDir) {
          const imagesDir = join(dataDir, 'images');
          mkdirSync(imagesDir, { recursive: true });
          const dest = join(imagesDir, `${info.sha256}${info.ext}`);
          if (!existsSync(dest)) copyFileSync(fullPath, dest);
          storedPath = dest;
        } else {
          storedPath = fullPath;
        }
      }

      if (!autoApprove) evictOldestPendingIfNeeded();
      const baseName = dirent.name.replace(/\.[^.]+$/, '');
      catalog.items.unshift(normalizeItem({
        id: info.sha256.slice(0, 16),
        sha256: info.sha256,
        fp64: info.fp64,
        path: storedPath,
        mediaUrl,
        mimeType: info.mimeType,
        sizeBytes: info.sizeBytes,
        status: autoApprove ? 'approved' : 'pending',
        emotion: '开心',
        tags: [baseName.slice(0, 20)].filter(Boolean),
        caption: baseName.slice(0, 40),
        intensity: 3,
        confidence: 1,
        sourceChatId: 'local-import',
        createdAt: nowIso,
        reviewedAt: autoApprove ? nowIso : null,
      }));
      imported += 1;
    }
    persistCatalog();
    return { ok: true, refresh: true, message: `导入完成：新增 ${imported} 张，跳过 ${skipped} 张` };
  }

  const item = catalog.items.find((x) => x.id === id);
  if (!item) return { ok: false, message: `未找到表情包: ${id}` };

  if (action === 'approve') {
    item.status = 'approved';
    item.reviewedAt = new Date().toISOString();
    persistCatalog();
    return { ok: true, refresh: true, message: `已通过 ${item.caption || item.id}` };
  }

  if (action === 'unapprove') {
    item.status = 'pending';
    item.reviewedAt = null;
    persistCatalog();
    return { ok: true, refresh: true, message: `已退回待审 ${item.caption || item.id}` };
  }

  if (action === 'reject_block' || action === 'delete_block') {
    const reason = action === 'delete_block' ? '库内删除拉黑' : '审核拒绝';
    blockCatalogItem(catalog, item, typeof params.reason === 'string' && params.reason.trim() !== '' ? params.reason.trim() : reason);
    persistCatalog();
    return { ok: true, refresh: true, message: `已拉黑并移除 ${item.caption || item.id}` };
  }

  if (action === 'edit_item') {
    if (typeof params.emotion === 'string' && params.emotion.trim() !== '') {
      item.emotion = normalizeEmotion(params.emotion, item.emotion || '开心');
    }
    const parsedTags = parseTagsInput(params.tags);
    if (parsedTags !== null) item.tags = parsedTags;
    if (typeof params.caption === 'string') item.caption = params.caption.trim().slice(0, 120);
    if (params.intensity !== undefined) {
      const val = Number(params.intensity);
      if (Number.isFinite(val)) item.intensity = Math.max(1, Math.min(5, Math.round(val)));
    }
    persistCatalog();
    return { ok: true, refresh: true, message: `已更新 ${item.caption || item.id}` };
  }

  if (action === 'reanalyze') {
    const filePath = resolveItemFilePath(item.path);
    if (!filePath) return { ok: false, message: '原图文件不存在，无法重新识图' };
    let buf;
    try {
      buf = readFileSync(filePath);
    } catch {
      return { ok: false, message: '读取图片失败' };
    }
    const vlm = await classifyWithVlm(item.mimeType || 'image/png', buf.toString('base64'), item.caption);
    if (!vlm.ok) return { ok: false, message: 'AI 识图失败或超时，保留原分类' };
    if (vlm.isSticker === false) return { ok: true, refresh: true, message: 'AI 判定可能非表情包，建议人工决定是否拉黑' };
    item.emotion = vlm.emotion;
    item.tags = vlm.tags;
    item.caption = vlm.caption;
    item.intensity = vlm.intensity;
    item.confidence = vlm.confidence;
    persistCatalog();
    return { ok: true, refresh: true, message: `AI 已重识：${item.emotion} · ${item.caption}` };
  }

  return { ok: false, message: `未知操作: ${action}` };
}

function handleInitialize(params) {
  const cfg = params && typeof params.config === 'object' && params.config !== null ? params.config : {};
  const explicitDir = typeof cfg.dataDir === 'string' && cfg.dataDir !== ''
    ? cfg.dataDir
    : (typeof params?.dataDir === 'string' ? params.dataDir : '');
  const resolvedDir = resolvePluginDataDir(explicitDir);
  if (resolvedDir) dataDir = resolvedDir;

  if (Array.isArray(cfg.ownerIds)) {
    ownerIds = new Set(cfg.ownerIds.map((x) => String(x ?? '').trim()).filter(Boolean));
  }

  const migrated = dataDir ? migrateAndLoadCatalog(dataDir) : { catalog: createEmptyCatalog(), mtimeMs: 0, migratedCount: 0 };
  catalog = migrated.catalog;
  catalogMtimeMs = migrated.mtimeMs;
  return {
    ok: true,
    pluginId: PLUGIN_ID,
    protocol: 'linre.adapter.v2',
    migratedCount: migrated.migratedCount,
  };
}

if (dataDir) {
  const initial = loadCatalogRaw(dataDir);
  catalog = initial.catalog;
  catalogMtimeMs = initial.mtimeMs;
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', (line) => {
  const raw = line.trim();
  if (raw === '') return;
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    process.stderr.write(`[${PLUGIN_ID}] invalid json\n`);
    return;
  }
  if (message === null || typeof message !== 'object') return;
  const id = message.id;

  if (message.method === 'events/observe') {
    observe(message.params && message.params.event ? message.params.event : message.params);
    if (id !== undefined) reply(id, { result: { ok: true } });
    return;
  }

  if (typeof message.method === 'string' && id !== undefined) {
    if (message.method === 'initialize') {
      reply(id, { result: handleInitialize(message.params ?? {}) });
      return;
    }
    if (message.method === 'ping') {
      reply(id, { result: { ok: true, protocol: 'linre.adapter.v2' } });
      return;
    }
    if (message.method === 'prompt/render') {
      const params = message.params ?? {};
      const text = params.slot === 'now-layer' || params.slot === undefined ? renderFor(params) : '';
      reply(id, { result: { text } });
      return;
    }
    if (message.method === 'ui/invoke') {
      void invokeUi(message.params ?? {})
        .then((result) => reply(id, { result }))
        .catch((error) => reply(id, { result: { ok: false, message: error instanceof Error ? error.message : String(error) } }));
      return;
    }
    if (message.method === 'ui/handle') {
      const params = message.params ?? {};
      const path = typeof params.path === 'string' ? params.path : '';
      const query = params.query && typeof params.query === 'object' ? params.query : {};
      if (path === '/ui/stickers' || path === '/ui/stickers/') {
        reply(id, { result: buildSchema(query) });
        return;
      }
      if (path === '/state' || path === '/state/' || path === '' || path === '/') {
        reply(id, { result: buildView() });
        return;
      }
      reply(id, { error: { code: -32601, message: `未知视图路径: ${path}` } });
      return;
    }
    reply(id, { error: { code: -32601, message: `Method not found: ${String(message.method)}` } });
    return;
  }

  if (id !== undefined) {
    const entry = pendingRpc.get(id);
    if (entry === undefined) return;
    pendingRpc.delete(id);
    clearTimeout(entry.timer);
    if (message.error !== undefined) {
      const detail = message.error && typeof message.error.message === 'string' ? message.error.message : 'unknown';
      entry.reject(new Error(detail));
    } else {
      entry.resolve(message.result);
    }
  }
});

input.on('close', () => process.exit(0));
process.stderr.write(`[${PLUGIN_ID}] worker v0.2.0 started\n`);
