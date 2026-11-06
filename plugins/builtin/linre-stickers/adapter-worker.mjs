/**
 * linre-stickers — 适配器 worker
 *
 * 职责只有一件：**告诉宿主此刻有哪张审核过的图适合发**，发不发由模型自己决定。
 *
 * 刻意不做的事：
 *  · 不自己发图（副作用一律走宿主的 `send_media` 工具）；
 *  · 不把 `pending` 的图放进注入（审核卡点在宿主侧，插件不替人做决定）；
 *  · 不读宿主文件系统（要落盘就走 `media/store`，由宿主内容寻址地写）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { keywordsOf, pickSticker, renderStickerLine } from './lib/picker.mjs';

const PLUGIN_ID = 'linre-stickers';

/** 1×1 透明 PNG：示例素材，避免插件依赖包外文件。 */
const SAMPLE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const DATA_DIR = process.env.IRMIA_DATA_DIR ?? '';
const DATA_SUBDIR = 'plugin-data/linre-stickers';

let catalog = [];
/** 最近一条可见事件的文本（关键词来源） */
let recentText = '';
let nextId = 1;
const pending = new Map();

function catalogPaths() {
  if (DATA_DIR === '') return null;
  const dir = join(DATA_DIR, DATA_SUBDIR);
  return { dir, file: join(dir, 'catalog.json') };
}

function seedCatalogText() {
  try {
    return readFileSync(new URL('./catalog.json', import.meta.url), 'utf8');
  } catch (error) {
    process.stderr.write(`[${PLUGIN_ID}] 种子 catalog.json 读取失败：${String(error)}\n`);
    return null;
  }
}

function saveCatalog() {
  const paths = catalogPaths();
  if (paths === null) return false;
  try {
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.file, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
    return true;
  } catch (error) {
    process.stderr.write(`[${PLUGIN_ID}] catalog 写入失败：${String(error)}\n`);
    return false;
  }
}

function loadCatalog() {
  const paths = catalogPaths();
  let raw = null;
  if (paths !== null) {
    try {
      raw = readFileSync(paths.file, 'utf8');
    } catch {
      raw = null;
    }
  }
  if (raw === null) {
    raw = seedCatalogText();
    if (raw !== null && paths !== null) {
      try {
        mkdirSync(paths.dir, { recursive: true });
        writeFileSync(paths.file, raw, 'utf8');
      } catch (error) {
        process.stderr.write(`[${PLUGIN_ID}] catalog 初始化落盘失败：${String(error)}\n`);
      }
    }
  }
  if (raw === null) {
    catalog = [];
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    catalog = Array.isArray(parsed) ? parsed.filter((entry) => entry !== null && typeof entry === 'object') : [];
  } catch (error) {
    process.stderr.write(`[${PLUGIN_ID}] catalog 解析失败：${String(error)}\n`);
    catalog = [];
  }
}

function callHost(method, params) {
  const id = `${PLUGIN_ID}:${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时`));
    }, 8_000);
    pending.set(id, { resolve, reject, timer });
    try {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

function reply(id, body) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`);
}

/**
 * 启动时把示例图落到宿主媒体目录，换来一个 `send_media` 认得的相对路径。
 * 失败不致命：没路径 ⇒ 注入行不出现（宁可没有图，也不给一个发不出去的路径）。
 */
async function materializeSamples() {
  for (const entry of catalog) {
    if (entry === null || typeof entry !== 'object') continue;
    if (entry.status !== 'approved') continue;
    if (typeof entry.path === 'string' && entry.path !== '') continue;
    const data = typeof entry.sample === 'string' && entry.sample !== '' ? entry.sample : SAMPLE_PNG;
    try {
      const result = await callHost('media/store', { kind: 'image', data });
      const stored = result !== null && typeof result === 'object' && typeof result.path === 'string' ? result.path : '';
      if (stored !== '') entry.path = stored;
    } catch (error) {
      process.stderr.write(`[${PLUGIN_ID}] 示例图落地失败（${entry.id}）：${String(error)}\n`);
    }
  }
}

function textOf(data) {
  if (data === null || typeof data !== 'object') return '';
  if (typeof data.text === 'string') return data.text;
  if (Array.isArray(data.parts)) {
    return data.parts.filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join(' ');
  }
  return '';
}

function observe(event) {
  if (event === null || typeof event !== 'object') return;
  const text = textOf(event.data).trim();
  if (text !== '') recentText = [...text].slice(0, 500).join('');
}

function renderFor(maxChars) {
  const picked = pickSticker(catalog, { keywords: keywordsOf(recentText), nowMs: Date.now() });
  if (picked === null) return '';
  // 记下使用时刻：冷却与"刚发过的排后面"都靠它（内存态，重启清零是可接受的退化）
  const entry = catalog.find((item) => item.id === picked.id);
  if (entry) entry.lastUsedMs = Date.now();
  return renderStickerLine(picked, maxChars);
}

function buildView() {
  const items = catalog.map((entry) => ({
    id: typeof entry.id === 'string' ? entry.id : '',
    tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === 'string') : [],
    intensity: Number.isFinite(entry.intensity) ? entry.intensity : 0,
    status: typeof entry.status === 'string' ? entry.status : 'pending',
    path: typeof entry.path === 'string' ? entry.path : '',
    lastUsedMs: Number.isFinite(entry.lastUsedMs) ? entry.lastUsedMs : null,
  }));
  const approved = items.filter((item) => item.status === 'approved');
  const pendingCount = items.filter((item) => item.status === 'pending').length;
  const picked = pickSticker(catalog, { keywords: keywordsOf(recentText), nowMs: Date.now() });
  return {
    atMs: Date.now(),
    total: items.length,
    approved: approved.length,
    pending: pendingCount,
    other: items.length - approved.length - pendingCount,
    items,
    preview: picked === null ? null : { id: picked.id, tags: Array.isArray(picked.tags) ? picked.tags : [] },
    renderLine: picked === null ? '暂无可配图。' : renderStickerLine(picked, 90),
  };
}

const STATUS_LABEL = { approved: '可用', pending: '待审' };
const STATUS_TONE = { approved: 'ok', pending: 'warn' };

function buildSchema() {
  const view = buildView();
  const blocks = [
    {
      type: 'hero',
      badge: '图',
      tone: 'primary',
      title: view.renderLine,
      chips: [
        { label: '总数', value: `${view.total}` },
        { label: '可用', value: `${view.approved}`, tone: 'ok' },
        { label: '待审', value: `${view.pending}`, tone: 'warn' },
      ],
    },
    {
      type: 'grid',
      title: '图库',
      items: view.items.map((item) => ({
        title: item.id,
        subtitle: item.path === '' ? '未落地' : '已落地',
        badge: STATUS_LABEL[item.status] ?? '未启用',
        tone: STATUS_TONE[item.status] ?? 'muted',
        dots: { filled: Math.max(0, Math.min(5, Number(item.intensity) || 0)), total: 5 },
        chips: item.tags,
      })),
    },
    {
      type: 'kv',
      title: '说明',
      items: [
        { key: '注入位置', value: '此刻层' },
        { key: '待审图', value: '不参与注入，等人在扩展页确认' },
        { key: '发图方式', value: '模型自己调用 send_media' },
      ],
    },
  ];
  return { title: '表情包', blocks };
}

function invokeUi(params) {
  const action = typeof params.action === 'string' ? params.action : '';
  const target = typeof params.target === 'string' ? params.target : '';
  if (action === 'reset') {
    const seed = seedCatalogText();
    if (seed === null) return { ok: false, message: '种子目录读不到' };
    try {
      const parsed = JSON.parse(seed);
      catalog = Array.isArray(parsed) ? parsed.filter((entry) => entry !== null && typeof entry === 'object') : [];
    } catch {
      return { ok: false, message: '种子目录解析失败' };
    }
    if (!saveCatalog()) return { ok: false, message: '写入失败，目录不可写' };
    return { ok: true, refresh: true, message: '已恢复初始目录' };
  }
  const entry = catalog.find((item) => item.id === target);
  if (entry === undefined) return { ok: false, message: `没有这张图：${target}` };
  if (action === 'approve') entry.status = 'approved';
  else if (action === 'reject') entry.status = 'rejected';
  else if (action === 'remove') catalog = catalog.filter((item) => item.id !== target);
  else if (action === 'set-tags') {
    const tags = Array.isArray(params.tags)
      ? params.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '').map((tag) => tag.trim()).slice(0, 16)
      : [];
    entry.tags = tags;
  } else if (action === 'set-intensity') {
    const value = Number(params.intensity);
    if (!Number.isFinite(value)) return { ok: false, message: '强度必须是数字' };
    entry.intensity = Math.max(0, Math.min(5, Math.round(value)));
  } else {
    return { ok: false, message: `不认识的操作：${action}` };
  }
  if (!saveCatalog()) return { ok: false, message: '写入失败，目录不可写' };
  return { ok: true, refresh: true, message: `已更新 ${target}` };
}

loadCatalog();

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', (line) => {
  const raw = line.trim();
  if (raw === '') return;
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    process.stderr.write(`[${PLUGIN_ID}] 非 JSON 输入，丢弃\n`);
    return;
  }
  if (message === null || typeof message !== 'object') return;
  const id = message.id;

  if (typeof message.method === 'string' && id !== undefined) {
    if (message.method === 'initialize') {
      reply(id, { result: { ok: true, pluginId: PLUGIN_ID, protocol: 'linre.adapter.v2' } });
      void materializeSamples();
      return;
    }
    if (message.method === 'prompt/render') {
      const params = message.params ?? {};
      const maxChars = Number.isSafeInteger(params.maxChars) ? params.maxChars : 90;
      const text = params.slot === 'now-layer' || params.slot === undefined ? renderFor(maxChars) : '';
      reply(id, { result: { text } });
      return;
    }
    if (message.method === 'ui/invoke') {
      reply(id, { result: invokeUi(message.params ?? {}) });
      return;
    }
    if (message.method === 'ui/handle') {
      const params = message.params ?? {};
      const path = typeof params.path === 'string' ? params.path : '';
      if (path === '/ui/stickers' || path === '/ui/stickers/') {
        reply(id, { result: buildSchema() });
        return;
      }
      if (path !== '/state' && path !== '/state/' && path !== '' && path !== '/') {
        reply(id, { error: { code: -32601, message: `未知视图路径: ${path}` } });
        return;
      }
      reply(id, { result: buildView() });
      return;
    }
    reply(id, { error: { code: -32601, message: `Method not found: ${String(message.method)}` } });
    return;
  }

  if (message.method === 'events/observe') {
    observe(message.params && message.params.event);
    return;
  }

  if (id !== undefined) {
    const entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
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
process.stderr.write(`[${PLUGIN_ID}] worker 已启动\n`);
