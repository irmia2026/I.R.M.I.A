import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  createEmptyCatalog,
  loadCatalogRaw,
  normalizeItem,
  resolveItemFilePath,
  resolvePluginDataDir,
  saveCatalogAtomic,
} from './lib/catalog-store.mjs';
import { inspectImageBuffer, isDuplicateOrBlocked, MAX_IMAGE_BYTES } from './lib/image-fp.mjs';
import { EMOTIONS, keywordsOf, normalizeEmotion } from './lib/picker.mjs';

const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'sticker_find',
    description: '检索已审核入库的表情包，返回可直接交给 send_media 的路径与标签。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词或描述。' },
        emotion: {
          type: 'string',
          enum: EMOTIONS,
          description: '按情绪分类筛选。',
        },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '返回数量上限，默认 5。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'sticker_steal',
    description: '把本地图片收录进表情包待审核库（默认 pending，审核通过后才会被推荐）。',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '本机图片文件路径。' },
        caption: { type: 'string', description: '简短描述。' },
        emotion: {
          type: 'string',
          enum: EMOTIONS,
          description: '情绪分类。',
        },
        tags: { type: 'array', items: { type: 'string' }, description: '检索标签列表。' },
      },
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
  return textResult(`linre-stickers: ${message}`, true);
}

function dataDirPath() {
  return resolvePluginDataDir('', true);
}

function readCatalog() {
  const dir = dataDirPath();
  if (!dir) return { dir: '', catalog: createEmptyCatalog() };
  const loaded = loadCatalogRaw(dir);
  return { dir, catalog: loaded.catalog };
}

function stickerFind(args) {
  const { catalog } = readCatalog();
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const emotion = typeof args.emotion === 'string' && args.emotion.trim() !== ''
    ? normalizeEmotion(args.emotion, '')
    : '';
  const limit = Math.min(20, Math.max(1, Number.isInteger(args.limit) ? args.limit : 5));
  const qTokens = keywordsOf(query.toLowerCase(), 16);

  const approved = [];
  for (const item of catalog.items) {
    if (!item || item.status !== 'approved') continue;
    const resolvedPath = resolveItemFilePath(item.path);
    if (!resolvedPath) continue;
    if (emotion !== '' && item.emotion !== emotion) continue;

    let score = 0;
    const tags = Array.isArray(item.tags) ? item.tags : [];
    const fields = [item.caption || '', item.emotion || '', ...tags].map((s) => s.toLowerCase());
    if (emotion !== '' && item.emotion === emotion) score += 3;
    for (const tok of qTokens) {
      if (fields.some((f) => f.includes(tok) || tok.includes(f))) score += 2;
    }
    if (qTokens.length > 0 && score === 0) continue;
    score += (Number(item.intensity) || 3) * 0.1;
    approved.push({
      item,
      resolvedPath,
      score,
    });
  }

  approved.sort((a, b) => (
    (b.score - a.score)
    || String(b.item.createdAt).localeCompare(String(a.item.createdAt))
  ));

  const results = approved.slice(0, limit).map(({ item, resolvedPath, score }) => ({
    id: item.id,
    path: resolvedPath,
    mediaUrl: item.mediaUrl || '',
    emotion: item.emotion,
    caption: item.caption,
    tags: item.tags,
    intensity: item.intensity,
    useCount: item.useCount,
    score: Number(score.toFixed(3)),
  }));

  return textResult(JSON.stringify({ count: approved.length, results }, null, 2));
}

function stickerSteal(args) {
  const rawPath = typeof args.filePath === 'string' ? args.filePath.trim() : '';
  if (!rawPath) return fail('需要提供 filePath');
  const absInput = resolve(rawPath);
  if (!existsSync(absInput)) return fail(`文件不存在: ${rawPath}`);
  const st = statSync(absInput);
  if (!st.isFile()) return fail('filePath 不是文件');
  if (st.size > MAX_IMAGE_BYTES) return fail('图片超过 16 MB 限制');

  const buf = readFileSync(absInput);
  const info = inspectImageBuffer(buf);
  if (!info) return fail('图片格式不受支持或尺寸/比例不符合表情包要求');

  const { dir, catalog } = readCatalog();
  const dup = isDuplicateOrBlocked(info, catalog.items, catalog.blocked);
  if (dup.matched) {
    if (dup.kind === 'blocked') return fail('该图片已被拉黑，禁止收录');
    return textResult(JSON.stringify({
      ok: true,
      duplicate: true,
      id: dup.entry.id,
      status: dup.entry.status,
      path: dup.entry.path,
    }, null, 2));
  }

  const imagesDir = join(dir, 'images');
  mkdirSync(imagesDir, { recursive: true });
  const storedPath = join(imagesDir, `${info.sha256}${info.ext}`);
  if (!existsSync(storedPath)) writeFileSync(storedPath, buf);

  const maxPending = catalog.settings.maxPending || 200;
  let pendingList = catalog.items.filter((x) => x.status === 'pending');
  while (pendingList.length >= maxPending) {
    pendingList.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const victim = pendingList[0];
    if (!victim) break;
    catalog.items = catalog.items.filter((x) => x.id !== victim.id);
    pendingList = pendingList.slice(1);
  }

  const caption = typeof args.caption === 'string' ? args.caption.trim().slice(0, 80) : '';
  const emotion = normalizeEmotion(args.emotion, '开心');
  const tags = Array.isArray(args.tags)
    ? args.tags.filter((t) => typeof t === 'string' && t.trim() !== '').map((t) => t.trim().slice(0, 24)).slice(0, 12)
    : [];

  const item = normalizeItem({
    id: info.sha256.slice(0, 16),
    sha256: info.sha256,
    fp64: info.fp64,
    path: storedPath,
    mediaUrl: '',
    mimeType: info.mimeType,
    sizeBytes: info.sizeBytes,
    status: 'pending',
    emotion,
    tags: tags.length > 0 ? tags : [emotion],
    caption: caption || emotion,
    intensity: 3,
    confidence: 1,
    sourceChatId: 'mcp-steal',
    createdAt: new Date().toISOString(),
    reviewedAt: null,
  });

  catalog.items.unshift(item);
  saveCatalogAtomic(dir, catalog);

  return textResult(JSON.stringify({
    ok: true,
    duplicate: false,
    id: item.id,
    status: item.status,
    path: item.path,
    emotion: item.emotion,
    caption: item.caption,
    tags: item.tags,
  }, null, 2));
}

function callTool(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('工具参数必须是对象');
  if (name === 'sticker_find') return stickerFind(args);
  if (name === 'sticker_steal') return stickerSteal(args);
  return fail(`未知工具：${name}`);
}

function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'linre-stickers', version: '0.2.0' },
      },
    });
    return;
  }
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return;
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === 'tools/call') {
    const params = message.params ?? {};
    try {
      send({ jsonrpc: '2.0', id: message.id, result: callTool(params.name, params.arguments ?? {}) });
    } catch (error) {
      send({ jsonrpc: '2.0', id: message.id, result: fail(error instanceof Error ? error.message : String(error)) });
    }
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
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
    try {
      handle(JSON.parse(line));
    } catch (error) {
      process.stderr.write(`invalid MCP message: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
});
