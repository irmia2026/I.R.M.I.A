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

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { keywordsOf, pickSticker, renderStickerLine } from './lib/picker.mjs';

const PLUGIN_ID = 'linre-stickers';

/** 1×1 透明 PNG：示例素材，避免插件依赖包外文件。 */
const SAMPLE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let catalog = [];
/** 最近一条可见事件的文本（关键词来源） */
let recentText = '';
let nextId = 1;
const pending = new Map();

function loadCatalog() {
  try {
    const raw = readFileSync(new URL('./catalog.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      catalog = parsed.filter((entry) => entry !== null && typeof entry === 'object');
    }
  } catch (error) {
    process.stderr.write(`[${PLUGIN_ID}] catalog.json 读取失败：${String(error)}\n`);
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
