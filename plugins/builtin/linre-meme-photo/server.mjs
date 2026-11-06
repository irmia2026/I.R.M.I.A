#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PROTOCOL_VERSION = '2025-06-18';
const root = resolve(
  process.env.LINRE_MEME_DATA_DIR
    ?? process.env.IRMIA_DATA_DIR
    ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'linre-meme-photo') : join(homedir(), '.linre-meme-photo')),
);
const imageDir = join(root, 'images');
const indexPath = join(root, 'index.json');

const TOOLS = [
  {
    name: 'steal_meme',
    description: '收录一张表情包到 Linre 图库。支持 image_path 或 image_base64，调用后会按 SHA-256 去重。网络图片请先用宿主 http_download 落到工作区。',
    inputSchema: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: '宿主 http_download 落盘后的本机图片路径。' },
        image_base64: { type: 'string', description: '图片的 base64 或 data URL。' },
        mime_type: { type: 'string', description: 'base64 输入的 MIME 类型，例如 image/png。' },
        label: { type: 'string', description: '一句话描述。' },
        tags: { type: 'array', items: { type: 'string' }, description: '检索标签。' },
        mood: { type: 'string', description: '情绪，例如 开心、无语、震惊。' },
        source: { type: 'string', description: '来源会话或来源说明。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_meme',
    description: '按描述、标签或情绪检索已收录的表情包，返回可交给 send_media 的本机路径。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词；留空时返回最近收录的图片。' },
        mood: { type: 'string', description: '优先匹配的情绪。' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'send_meme',
    description: '选择一张表情包并返回路径；随后必须调用宿主已有的 send_media 真正发出图片。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'search_meme 返回的表情包 id。' },
        query: { type: 'string', description: '没有 id 时按描述或情绪检索。' },
        mood: { type: 'string', description: '检索情绪。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_memes',
    description: '查看图库数量和最近收录的表情包。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
  },
  {
    name: 'forget_meme',
    description: '从图库删除一张表情包及其本地文件。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function fail(message) {
  return textResult(`linre-meme-photo: ${message}`, true);
}

function readIndex() {
  mkdirSync(imageDir, { recursive: true });
  if (!existsSync(indexPath)) return [];
  try {
    const value = JSON.parse(readFileSync(indexPath, 'utf8'));
    return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
  } catch (error) {
    throw new Error(`图库索引损坏：${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeIndex(items) {
  mkdirSync(root, { recursive: true });
  const temporary = `${indexPath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
  renameSync(temporary, indexPath);
}

function cleanText(value, max = 300) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function cleanTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string').map((item) => cleanText(item, 40)).filter(Boolean))].slice(0, 30);
}

function tokens(value) {
  const text = cleanText(value, 500).toLocaleLowerCase();
  const found = new Set(text.match(/[a-z0-9]+/g) ?? []);
  const cjk = [...text].filter((char) => /[\u3400-\u9fff]/u.test(char));
  for (const char of cjk) found.add(char);
  for (let i = 0; i + 1 < cjk.length; i += 1) found.add(cjk[i] + cjk[i + 1]);
  return [...found];
}

function recordText(item) {
  return [item.label, item.mood, ...(item.tags ?? []), item.source].filter(Boolean).join(' ');
}

function detectImage(buffer, declaredMime = '') {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { ext: '.png', mime: 'image/png' };
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return { ext: '.jpg', mime: 'image/jpeg' };
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString() === 'GIF87a' || buffer.subarray(0, 6).toString() === 'GIF89a')) return { ext: '.gif', mime: 'image/gif' };
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return { ext: '.webp', mime: 'image/webp' };
  if (declaredMime.startsWith('image/')) throw new Error('输入内容不是受支持的 PNG/JPEG/GIF/WebP 图片');
  throw new Error('输入内容不是受支持的 PNG/JPEG/GIF/WebP 图片');
}

async function readImageInput(args) {
  let bytes;
  let declaredMime = cleanText(args.mime_type, 80);
  if (typeof args.image_base64 === 'string' && args.image_base64.trim() !== '') {
    let encoded = args.image_base64.trim();
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(encoded);
    if (match) { declaredMime = match[1]; encoded = match[2]; }
    try { bytes = Buffer.from(encoded, 'base64'); } catch { throw new Error('image_base64 无法解码'); }
  } else if (typeof args.image_path === 'string' && args.image_path.trim() !== '') {
    const path = resolve(args.image_path);
    const info = statSync(path);
    if (!info.isFile()) throw new Error('image_path 不是文件');
    if (info.size > MAX_IMAGE_BYTES) throw new Error('图片超过 10 MB 限制');
    bytes = readFileSync(path);
  } else {
    throw new Error('需要提供 image_path 或 image_base64；网络图片请先调用宿主 http_download');
  }
  if (!bytes || bytes.length === 0) throw new Error('图片内容为空');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片超过 10 MB 限制');
  return { bytes, ...detectImage(bytes, declaredMime) };
}

async function steal(args) {
  const { bytes, ext, mime } = await readImageInput(args);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const items = readIndex();
  const existing = items.find((item) => item.hash === hash);
  if (existing) return textResult(JSON.stringify({ ok: true, duplicate: true, id: existing.id, path: existing.path, label: existing.label }, null, 2));
  const id = hash.slice(0, 16);
  const path = join(imageDir, `${hash}${ext}`);
  writeFileSync(path, bytes, { flag: 'wx' });
  const item = {
    id,
    hash,
    path,
    mime,
    label: cleanText(args.label) || '未标注图片',
    tags: cleanTags(args.tags),
    mood: cleanText(args.mood, 80),
    source: cleanText(args.source, 200),
    createdAt: new Date().toISOString(),
    useCount: 0,
  };
  try { writeIndex([item, ...items]); } catch (error) { rmSync(path, { force: true }); throw error; }
  return textResult(JSON.stringify({ ok: true, duplicate: false, id, path, mime, label: item.label, tags: item.tags, mood: item.mood }, null, 2));
}

function ranked(items, query, mood) {
  const wanted = tokens([query, mood].filter(Boolean).join(' '));
  return items.map((item, index) => {
    const haystack = tokens(recordText(item));
    let score = query || mood ? wanted.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0) : 0;
    if (mood && cleanText(item.mood).toLocaleLowerCase().includes(cleanText(mood).toLocaleLowerCase())) score += 3;
    score += Math.max(0, 0.01 - index / 100000);
    return { item, score };
  }).filter((entry) => !query && !mood || entry.score > 0).sort((a, b) => b.score - a.score || b.item.createdAt.localeCompare(a.item.createdAt));
}

function search(args) {
  const items = readIndex();
  const limit = Math.min(20, Math.max(1, Number.isInteger(args.limit) ? args.limit : 5));
  const results = ranked(items, cleanText(args.query, 200), cleanText(args.mood, 80)).slice(0, limit).map(({ item, score }) => ({
    id: item.id, path: item.path, label: item.label, tags: item.tags, mood: item.mood, mime: item.mime, useCount: item.useCount, score: Number(score.toFixed(3)),
  }));
  return textResult(JSON.stringify({ count: items.length, results }, null, 2));
}

function sendMeme(args) {
  const items = readIndex();
  let item = typeof args.id === 'string' ? items.find((candidate) => candidate.id === args.id) : undefined;
  if (!item) item = ranked(items, cleanText(args.query, 200), cleanText(args.mood, 80))[0]?.item;
  if (!item) return fail('没有匹配的表情包；先用 steal_meme 收录图片。');
  item.useCount = Number(item.useCount ?? 0) + 1;
  writeIndex(items);
  return textResult(JSON.stringify({
    ok: true,
    id: item.id,
    path: item.path,
    mime: item.mime,
    label: item.label,
    instruction: '请立即调用宿主已有的 send_media，参数 path 使用上面的绝对路径；不要把路径当成已发送回执。',
  }, null, 2));
}

function listMemes(args) {
  const items = readIndex();
  const limit = Math.min(50, Math.max(1, Number.isInteger(args.limit) ? args.limit : 10));
  return textResult(JSON.stringify({ count: items.length, root, results: items.slice(0, limit).map((item) => ({ id: item.id, path: item.path, label: item.label, tags: item.tags, mood: item.mood, createdAt: item.createdAt, useCount: item.useCount })) }, null, 2));
}

function forget(args) {
  const items = readIndex();
  const item = items.find((candidate) => candidate.id === args.id);
  if (!item) return fail(`找不到 id=${cleanText(args.id, 80)}`);
  const imageRoot = resolve(imageDir);
  const imagePath = resolve(item.path);
  const relation = relative(imageRoot, imagePath);
  if (relation === '' || relation === '..' || relation.startsWith('..') || isAbsolute(relation)) throw new Error('图库记录路径不在插件图片目录内');
  rmSync(imagePath, { force: true });
  writeIndex(items.filter((candidate) => candidate.id !== item.id));
  return textResult(JSON.stringify({ ok: true, id: item.id, label: item.label }, null, 2));
}

async function callTool(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('工具参数必须是对象');
  if (name === 'steal_meme') return await steal(args);
  if (name === 'search_meme') return search(args);
  if (name === 'send_meme') return sendMeme(args);
  if (name === 'list_memes') return listMemes(args);
  if (name === 'forget_meme') return forget(args);
  return fail(`未知工具：${name}`);
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'linre-meme-photo', version: '0.1.0' } } });
    return;
  }
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return;
  if (message.method === 'tools/list') { send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } }); return; }
  if (message.method === 'tools/call') {
    const params = message.params ?? {};
    try { send({ jsonrpc: '2.0', id: message.id, result: await callTool(params.name, params.arguments ?? {}) }); }
    catch (error) { send({ jsonrpc: '2.0', id: message.id, result: fail(error instanceof Error ? error.message : String(error)) }); }
    return;
  }
  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!line) continue;
    try { void handle(JSON.parse(line)); } catch (error) { process.stderr.write(`invalid MCP message: ${error instanceof Error ? error.message : String(error)}\n`); }
  }
});
