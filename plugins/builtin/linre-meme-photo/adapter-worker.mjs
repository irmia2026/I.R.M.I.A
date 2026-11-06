#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve } from 'node:path';

const PROTOCOL = 'linre.adapter.v2';
const PROTOCOL_VERSION = '2';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const root = resolve(
  process.env.LINRE_MEME_DATA_DIR
    ?? process.env.IRMIA_DATA_DIR
    ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'linre-meme-photo') : join(homedir(), '.linre-meme-photo')),
);
const imageDir = join(root, 'images');
const indexPath = join(root, 'index.json');

function cleanText(value, max = 300) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function cleanTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item) => typeof item === 'string')
    .map((item) => cleanText(item, 40))
    .filter(Boolean))].slice(0, 30);
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

function readIndex() {
  mkdirSync(imageDir, { recursive: true });
  if (!existsSync(indexPath)) return [];
  let value;
  try {
    value = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (error) {
    throw new Error(`图库索引损坏：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(value)) throw new Error('图库索引损坏：根值必须是数组');
  return value.filter((item) => item && typeof item === 'object');
}

function writeIndex(items) {
  mkdirSync(root, { recursive: true });
  const temporary = `${indexPath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
  renameSync(temporary, indexPath);
}

function detectImage(buffer, declaredMime = '') {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { ext: '.png', mime: 'image/png' };
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return { ext: '.jpg', mime: 'image/jpeg' };
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString() === 'GIF87a' || buffer.subarray(0, 6).toString() === 'GIF89a')) return { ext: '.gif', mime: 'image/gif' };
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return { ext: '.webp', mime: 'image/webp' };
  throw new Error(`输入内容不是受支持的 PNG/JPEG/GIF/WebP 图片${declaredMime ? `（声明为 ${declaredMime}）` : ''}`);
}

function decodeBase64(value) {
  let encoded = cleanText(value, MAX_IMAGE_BYTES * 2);
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(encoded);
  if (match) encoded = match[2];
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw new Error('图片 base64 无法解码');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length) throw new Error('图片内容为空');
  return bytes;
}

function existingRealPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isInside(path, directory) {
  const relation = relative(directory, path);
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${requirePathSeparator()}`) && !isAbsolute(relation));
}

function requirePathSeparator() {
  return process.platform === 'win32' ? '\\' : '/';
}

function allowedAssetRoots() {
  const configured = [
    process.env.LINRE_ADAPTER_ASSET_DIR,
    process.env.LINRE_WORKSPACE_DIR,
  ].filter((value) => typeof value === 'string' && value.trim());
  return [root, ...configured.map((value) => resolve(value))]
    .map((value) => existingRealPath(value) ?? value)
    .filter((value, index, all) => all.indexOf(value) === index);
}

function readAllowedPath(value) {
  const candidate = resolve(cleanText(value, 4096));
  const real = existingRealPath(candidate);
  if (!real) throw new Error('图片资产路径不存在');
  if (!statSync(real).isFile()) throw new Error('图片资产路径不是文件');
  if (!allowedAssetRoots().some((directory) => isInside(real, directory))) {
    throw new Error('图片资产路径不在 Host 授权的资产目录内');
  }
  const bytes = readFileSync(real);
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片超过 10 MB 限制');
  return bytes;
}

function storeImage(bytes, metadata = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('图片内容为空');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片超过 10 MB 限制');
  const { ext, mime } = detectImage(bytes, cleanText(metadata.mimeType, 80));
  const hash = createHash('sha256').update(bytes).digest('hex');
  const items = readIndex();
  const existing = items.find((item) => item.hash === hash);
  if (existing) return { ok: true, duplicate: true, id: existing.id, path: existing.path, label: existing.label };

  const id = hash.slice(0, 16);
  const path = join(imageDir, `${hash}${ext}`);
  mkdirSync(imageDir, { recursive: true });
  writeFileSync(path, bytes, { flag: 'wx' });
  const item = {
    id,
    hash,
    path,
    mime,
    label: cleanText(metadata.label) || '未标注图片',
    tags: cleanTags(metadata.tags),
    mood: cleanText(metadata.mood, 80),
    source: cleanText(metadata.source, 200),
    createdAt: new Date().toISOString(),
    useCount: 0,
  };
  try {
    writeIndex([item, ...items]);
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
  return { ok: true, duplicate: false, id, path, mime, label: item.label, tags: item.tags, mood: item.mood };
}

function assetBase64(asset) {
  if (typeof asset.data_base64 === 'string') return asset.data_base64;
  if (typeof asset.image_base64 === 'string') return asset.image_base64;
  if (typeof asset.base64 === 'string') return asset.base64;
  if (asset.content && typeof asset.content.base64 === 'string') return asset.content.base64;
  return '';
}

function assetBytes(asset) {
  const encoded = assetBase64(asset);
  if (encoded) return decodeBase64(encoded);
  if (typeof asset.path === 'string' && asset.path.trim()) {
    if (/^(?:https?|data):/iu.test(asset.path.trim())) {
      throw new Error('网络图片必须由 Host 下载后以授权路径或 base64 资产提供；worker 不执行网络 fetch');
    }
    return readAllowedPath(asset.path);
  }
  if (typeof asset.url === 'string' || typeof asset.uri === 'string') {
    throw new Error('网络图片必须由 Host 下载后以授权路径或 base64 资产提供；worker 不执行网络 fetch');
  }
  throw new Error('image 资产缺少授权 path 或 base64 内容');
}

function eventAssets(params) {
  const event = params?.event && typeof params.event === 'object' ? params.event : params;
  if (event?.replay === true || event?.replayed === true || event?.delivery === 'replay') {
    throw new Error('event replay is host-only and is not accepted by this adapter');
  }
  const candidates = [event?.assets, event?.message?.assets, event?.payload?.assets];
  return candidates.find((value) => Array.isArray(value)) ?? [];
}

function observe(params) {
  const assets = eventAssets(params);
  const collected = [];
  const rejected = [];
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object') {
      rejected.push({ reason: '资产必须是对象' });
      continue;
    }
    const type = cleanText(asset.type || asset.kind, 40).toLocaleLowerCase();
    if (type && type !== 'image' && type !== 'image_asset' && type !== 'photo') continue;
    try {
      const result = storeImage(assetBytes(asset), {
        mimeType: asset.mimeType || asset.mime_type,
        label: asset.label || asset.alt || asset.description,
        tags: asset.tags,
        mood: asset.mood,
        source: asset.source || 'linre-adapter-event',
      });
      collected.push(publicStored(result));
    } catch (error) {
      rejected.push({ reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: true, observed: assets.length, collected, rejected };
}

function ranked(items, query, mood) {
  const wanted = tokens([query, mood].filter(Boolean).join(' '));
  return items.map((item, index) => {
    const haystack = tokens(recordText(item));
    let score = query || mood ? wanted.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0) : 0;
    if (mood && cleanText(item.mood).toLocaleLowerCase().includes(cleanText(mood).toLocaleLowerCase())) score += 3;
    score += Math.max(0, 0.01 - index / 100000);
    return { item, score };
  }).filter((entry) => !query && !mood || entry.score > 0)
    .sort((a, b) => b.score - a.score || b.item.createdAt.localeCompare(a.item.createdAt));
}

function publicStored(result) {
  return {
    ok: result.ok,
    duplicate: result.duplicate,
    assetId: result.id,
    label: result.label,
    ...(result.tags ? { tags: result.tags } : {}),
    ...(result.mood ? { mood: result.mood } : {}),
  };
}

function publicItem(item, score) {
  return {
    assetId: item.id,
    label: item.label,
    tags: item.tags,
    mood: item.mood,
    useCount: item.useCount,
    ...(score === undefined ? {} : { score: Number(score.toFixed(3)) }),
  };
}

function queryMemes(params) {
  const query = cleanText(params?.query, 200);
  const mood = cleanText(params?.mood, 80);
  const limit = Math.min(20, Math.max(1, Number.isInteger(params?.limit) ? params.limit : 5));
  const items = readIndex();
  const matches = ranked(items, query, mood);
  let selectedEntry;
  if (typeof params?.id === 'string' && params.id.trim()) {
    selectedEntry = matches.find(({ item }) => item.id === params.id);
    if (!selectedEntry) {
      const item = items.find((candidate) => candidate.id === params.id);
      if (item) selectedEntry = { item, score: 1 };
    }
  } else {
    selectedEntry = matches[0];
  }
  return {
    ok: true,
    count: items.length,
    results: matches.slice(0, limit).map(({ item, score }) => publicItem(item, score)),
    ...(selectedEntry ? { selected: publicItem(selectedEntry.item, selectedEntry.score) } : {}),
  };
}

function selectItem(params) {
  const items = readIndex();
  const requestedId = typeof params?.assetId === 'string' ? params.assetId : params?.id;
  if (typeof requestedId === 'string' && requestedId.trim()) {
    const item = items.find((candidate) => candidate.id === requestedId);
    if (item) return item;
  }
  const query = cleanText(params?.query, 200);
  const mood = cleanText(params?.mood, 80);
  const item = ranked(items, query, mood)[0]?.item;
  if (!item) throw new Error('没有匹配的表情包；先让 Host 观察并收录图片资产');
  return item;
}

function proposeEffect(params) {
  const item = selectItem(params);
  const text = cleanText(params?.text ?? params?.message, 2000) || item.label;
  const items = readIndex();
  const indexed = items.find((candidate) => candidate.id === item.id);
  if (indexed) {
    indexed.useCount = Number(indexed.useCount ?? 0) + 1;
    writeIndex(items);
  }
  const image = { assetId: item.id };
  return {
    ok: true,
    proposal: {
      type: 'effect_proposal',
      effect: 'send_message',
      requiresApproval: true,
      source: 'linre-meme-photo',
      payload: { text, images: [image] },
    },
  };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export async function handleMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return rpcError(null, -32600, 'Invalid Request');
  const id = message.id;
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(id, -32600, 'JSON-RPC 2.0 request required');
  try {
    switch (message.method) {
      case 'initialize':
        return { jsonrpc: '2.0', id, result: {
          protocolVersion: PROTOCOL_VERSION,
          protocol: PROTOCOL,
          adapter: { id: 'linre-meme-photo', version: '0.1.0' },
          capabilities: ['event.observe', 'asset.resolve', 'storage.kv', 'message.propose'],
          policy: { network: false, directSend: false },
        } };
      case 'ping':
        return { jsonrpc: '2.0', id, result: { ok: true, protocol: PROTOCOL } };
      case 'events/observe':
      case 'observe':
      case 'event':
        return { jsonrpc: '2.0', id, result: observe(message.params ?? {}) };
      case 'query':
        return { jsonrpc: '2.0', id, result: queryMemes(message.params ?? {}) };
      case 'effect/propose':
      case 'effects/propose':
      case 'effect_proposal':
        return { jsonrpc: '2.0', id, result: proposeEffect(message.params ?? {}) };
      case 'effect/execute':
      case 'effects/execute':
      case 'effect/approve':
      case 'effect':
      case 'effects':
      case 'message/send':
      case 'send':
      case 'send_media':
      case 'send_meme':
      case 'send_message':
        return rpcError(id, -32001, 'Direct effects are not permitted; submit the returned effect_proposal to Linre Adapter Host for approval');
      default:
        return rpcError(id, -32601, `Method not found: ${message.method}`);
    }
  } catch (error) {
    return rpcError(id, -32602, error instanceof Error ? error.message : String(error));
  }
}

async function run() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input, 'utf8') > MAX_LINE_BYTES * 2) {
      process.stdout.write(`${JSON.stringify(rpcError(null, -32700, 'Input buffer too large'))}\n`);
      input = '';
      continue;
    }
    let newline;
    while ((newline = input.indexOf('\n')) >= 0) {
      const raw = input.slice(0, newline).trim();
      input = input.slice(newline + 1);
      if (!raw) continue;
      if (Buffer.byteLength(raw, 'utf8') > MAX_LINE_BYTES) {
        process.stdout.write(`${JSON.stringify(rpcError(null, -32700, 'JSONL message too large'))}\n`);
        continue;
      }
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        process.stdout.write(`${JSON.stringify(rpcError(null, -32700, 'Parse error: invalid JSON'))}\n`);
        continue;
      }
      const response = await handleMessage(message);
      if (message.id !== undefined || response.error) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void run();
}
