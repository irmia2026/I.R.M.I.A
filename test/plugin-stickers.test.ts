import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';

import { AfterCommitEventBus } from '../src/adapter/event-bus.ts';
import { AdapterSupervisor } from '../src/adapter/supervisor.ts';
import { hamming64, inspectImageBuffer, isDuplicateOrBlocked } from '../plugins/builtin/linre-stickers/lib/image-fp.mjs';
import { keywordsOf, pickSticker, renderStickerLine } from '../plugins/builtin/linre-stickers/lib/picker.mjs';

const pluginRoot = resolve('plugins/builtin/linre-stickers');
const workerPath = resolve(pluginRoot, 'adapter-worker.mjs');
const mcpServerPath = resolve(pluginRoot, 'server.mjs');
const skip = !existsSync(workerPath);

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePatternPng(width, height, variant = 0) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    const ny = y / height;
    for (let x = 0; x < width; x += 1) {
      const nx = x / width;
      const idx = y * stride + 1 + x * 3;
      let lum = 128;
      if (variant === 0) {
        lum = Math.round(128 + 100 * Math.sin(nx * Math.PI * 2.5 + ny * 1.1));
      } else if (variant === 1) {
        lum = Math.round(128 + 100 * Math.cos(nx * Math.PI * 4.2 - ny * Math.PI * 2.0));
      } else if (variant === 3) {
        const quad = (nx < 0.5 ? 1 : 0) ^ (ny < 0.5 ? 1 : 0);
        lum = quad ? Math.round(210 * ny + 30) : Math.round(60 * (1 - nx));
      } else {
        const inCenter = nx > 0.25 && nx < 0.75 && ny > 0.25 && ny < 0.75;
        lum = inCenter ? Math.round(230 * nx) : Math.round(40 * (1 - ny));
      }
      raw[idx] = Math.max(0, Math.min(255, lum));
      raw[idx + 1] = Math.max(0, Math.min(255, (lum + variant * 37) % 256));
      raw[idx + 2] = Math.max(0, Math.min(255, 255 - lum));
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

function createWorkerHarness(env = {}, hostHandler = null) {
  const proc = spawn(process.execPath, [workerPath], {
    cwd: pluginRoot,
    env: { ...process.env, LINRE_STICKERS_VLM_GAP_MS: '0', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const hostCalls = [];
  let seq = 1;

  const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const raw = line.trim();
    if (!raw) return;
    const msg = JSON.parse(raw);
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      hostCalls.push({ method: msg.method, params: msg.params });
      Promise.resolve(hostHandler ? hostHandler(msg.method, msg.params) : { ok: true })
        .then((result) => {
          proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
        })
        .catch((err) => {
          proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(err) } })}\n`);
        });
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || 'rpc error'));
      else entry.resolve(msg.result);
    }
  });

  function request(method, params = {}) {
    const id = `test:${seq++}`;
    return new Promise((res, rej) => {
      pending.set(id, { resolve: res, reject: rej });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  function notify(method, params = {}) {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async function close() {
    rl.close();
    proc.stdin.end();
    await new Promise((r) => proc.once('exit', r));
  }

  return { request, notify, close, hostCalls };
}

function createMcpHarness(env = {}) {
  const proc = spawn(process.execPath, [mcpServerPath], {
    cwd: pluginRoot,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let seq = 1;

  const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const raw = line.trim();
    if (!raw) return;
    const msg = JSON.parse(raw);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || 'mcp error'));
      else entry.resolve(msg.result);
    }
  });

  function request(method, params = {}) {
    const id = seq++;
    return new Promise((res, rej) => {
      pending.set(id, { resolve: res, reject: rej });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async function close() {
    rl.close();
    proc.stdin.end();
    await new Promise((r) => proc.once('exit', r));
  }

  return { request, close };
}

test('image-fp: validates PNG dimensions/aspect, rejects tiny/corrupt/panoramic, and detects visual duplicates', () => {
  const goodA = makePatternPng(64, 64, 0);
  const infoA = inspectImageBuffer(goodA);
  assert.ok(infoA);
  assert.equal(infoA.width, 64);
  assert.equal(infoA.height, 64);
  assert.equal(infoA.format, 'png');
  assert.equal(infoA.fp64.length, 16);

  const resizedA = makePatternPng(96, 96, 0);
  const infoResized = inspectImageBuffer(resizedA);
  assert.ok(infoResized);
  assert.ok(hamming64(infoA.fp64, infoResized.fp64) <= 6);

  const different = makePatternPng(64, 64, 1);
  const infoDiff = inspectImageBuffer(different);
  assert.ok(infoDiff);
  assert.notEqual(infoA.sha256, infoDiff.sha256);

  const dup = isDuplicateOrBlocked(infoResized, [{ sha256: infoA.sha256, fp64: infoA.fp64 }], []);
  assert.equal(dup.matched, true);
  assert.equal(dup.kind, 'duplicate');

  const blocked = isDuplicateOrBlocked(infoA, [], [{ sha256: infoA.sha256, fp64: infoA.fp64 }]);
  assert.equal(blocked.matched, true);
  assert.equal(blocked.kind, 'blocked');

  assert.equal(inspectImageBuffer(makePatternPng(16, 16, 0)), null);
  assert.equal(inspectImageBuffer(makePatternPng(320, 32, 0)), null);
  assert.equal(inspectImageBuffer(Buffer.from('not-an-image-at-all'.repeat(20))), null);

  const gifBuf = Buffer.alloc(200);
  gifBuf.write('GIF89a', 0, 'ascii');
  gifBuf.writeUInt16LE(64, 6);
  gifBuf.writeUInt16LE(64, 8);
  const gifInfo = inspectImageBuffer(gifBuf);
  assert.equal(gifInfo?.format, 'gif');
  assert.equal(gifInfo?.width, 64);

  const webpBuf = Buffer.alloc(200);
  webpBuf.write('RIFF', 0, 'ascii');
  webpBuf.writeUInt32LE(192, 4);
  webpBuf.write('WEBP', 8, 'ascii');
  webpBuf.write('VP8 ', 12, 'ascii');
  webpBuf[23] = 0x9d;
  webpBuf[24] = 0x01;
  webpBuf[25] = 0x2a;
  webpBuf.writeUInt16LE(80, 26);
  webpBuf.writeUInt16LE(80, 28);
  const webpInfo = inspectImageBuffer(webpBuf);
  assert.equal(webpInfo?.format, 'webp');
  assert.equal(webpInfo?.width, 80);

  const jpgBuf = Buffer.alloc(200);
  jpgBuf[0] = 0xff;
  jpgBuf[1] = 0xd8;
  jpgBuf[2] = 0xff;
  jpgBuf[3] = 0xc0;
  jpgBuf.writeUInt16BE(17, 4);
  jpgBuf[6] = 8;
  jpgBuf.writeUInt16BE(72, 7);
  jpgBuf.writeUInt16BE(96, 9);
  const jpgInfo = inspectImageBuffer(jpgBuf);
  assert.equal(jpgInfo?.format, 'jpeg');
  assert.equal(jpgInfo?.width, 96);
  assert.equal(jpgInfo?.height, 72);
});

test('picker: enforces approved-only, cooldown, 5-speak fallback, and prompt formatting', () => {
  const catalog = [
    { id: 's1', emotion: '无语', caption: '猫猫盯', tags: ['盯', '无语'], intensity: 4, status: 'approved', path: 'C:/tmp/s1.png' },
    { id: 's2', emotion: '开心', caption: 'pending图', tags: ['开心'], intensity: 5, status: 'pending', path: 'C:/tmp/s2.png' },
    { id: 's3', emotion: '得意', caption: '叉腰笑', tags: ['叉腰'], intensity: 3, status: 'approved', path: 'C:/tmp/s3.png' },
  ];

  const normal = pickSticker(catalog, { keywords: ['无语'], nowMs: 1_000_000 });
  assert.equal(normal?.id, 's1');
  assert.equal(normal?.fallback, false);
  const normalLine = renderStickerLine(normal, 160);
  assert.equal(normalLine, '可配图：[无语] 猫猫盯（标签：盯/无语） → send_media path="C:/tmp/s1.png"');

  assert.equal(pickSticker(catalog, { keywords: ['天气'], nowMs: 1_000_000 }), null);

  const fallback = pickSticker(catalog, { keywords: ['天气'], nowMs: 1_000_000, speaksWithoutSticker: 5, fallbackAfterSpeaks: 5 });
  assert.ok(fallback);
  assert.equal(fallback.fallback, true);
  const fallbackLine = renderStickerLine({ id: 's3', emotion: '得意', caption: '叉腰笑', path: 'C:/tmp/s3.png', fallback: true }, 160);
  assert.equal(fallbackLine, '可配图（已连聊多轮纯文字，顺手带一张更灵动）：[得意] 叉腰笑 → send_media path="C:/tmp/s3.png"');

  const cooldownCatalog = [{ ...catalog[0], lastUsedMs: 1_000_000 }];
  assert.equal(pickSticker(cooldownCatalog, { keywords: ['无语'], nowMs: 1_000_000 + 60_000 }), null);
  assert.equal(pickSticker(cooldownCatalog, { keywords: ['无语'], nowMs: 1_000_000 + 200_000 })?.id, 's1');

  assert.deepEqual(keywordsOf('好耶！happy 2026'), ['好耶', 'happy', '2026']);
});

test('AdapterSupervisor: starts linre-stickers v0.2.0 cleanly and stays silent without approved stickers', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'linre-stickers-sup-'));
  const prevEnv = process.env.IRMIA_DATA_DIR;
  process.env.IRMIA_DATA_DIR = dir;
  const supervisor = new AdapterSupervisor({
    eventBus: new AfterCommitEventBus({ handlerTimeoutMs: 2_000 }),
    handshakeTimeoutMs: 5_000,
    requestTimeoutMs: 8_000,
    onAssetStore: async () => ({ path: join(dir, 'stored.png') }),
  });
  try {
    await supervisor.start([{
      id: 'linre-stickers',
      version: '0.2.0',
      contentHash: 'c'.repeat(64),
      worker: workerPath,
      capabilities: ['event.observe', 'event.publish', 'model.invoke', 'prompt.inject', 'asset.store', 'asset.resolve', 'ui.api'],
      cwd: pluginRoot,
    }]);
    assert.equal(supervisor.statuses()[0]?.state, 'ready');
    const rendered = await supervisor.request('linre-stickers', 'prompt/render', { slot: 'now-layer', maxChars: 160 });
    assert.equal((rendered as { text: string }).text, '');
  } finally {
    await supervisor.stop();
    if (prevEnv === undefined) delete process.env.IRMIA_DATA_DIR;
    else process.env.IRMIA_DATA_DIR = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('end-to-end auto-steal, VLM classification, GUI review, blacklist, edit_item, 5-speak fallback, migration, and MCP', { skip }, async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'linre-stickers-e2e-'));
  const pluginDataDir = join(rootDir, 'plugin-data', 'linre-stickers');
  const legacyDir = join(rootDir, 'plugin-data', 'linre-meme-photo');
  mkdirSync(pluginDataDir, { recursive: true });
  mkdirSync(legacyDir, { recursive: true });

  const legacyPng = makePatternPng(64, 64, 2);
  const legacyPath = join(legacyDir, 'legacy-meme.png');
  writeFileSync(legacyPath, legacyPng);
  writeFileSync(join(legacyDir, 'index.json'), JSON.stringify([
    {
      id: 'legacy-1',
      hash: createHash('sha256').update(legacyPng).digest('hex'),
      path: legacyPath,
      mime: 'image/png',
      label: '老图迁移测试',
      tags: ['怀旧', '开心'],
      mood: '开心',
      source: 'qq-old',
      createdAt: '2026-01-01T00:00:00.000Z',
      useCount: 2,
    },
  ]));

  const tinyPath = join(rootDir, 'tiny-1x1.png');
  writeFileSync(tinyPath, Buffer.alloc(68, 1));
  writeFileSync(join(pluginDataDir, 'catalog.json'), JSON.stringify([
    { id: 'broken-seed', tags: ['开心'], intensity: 3, status: 'approved', path: tinyPath },
  ]));

  const stickerA = makePatternPng(64, 64, 0);
  const shaA = createHash('sha256').update(stickerA).digest('hex');
  const stickerAPath = join(rootDir, 'stickerA.png');
  writeFileSync(stickerAPath, stickerA);

  const nonSticker = makePatternPng(64, 64, 1);
  const shaNon = createHash('sha256').update(nonSticker).digest('hex');
  const nonStickerPath = join(rootDir, 'nonSticker.png');
  writeFileSync(nonStickerPath, nonSticker);

  const vlmMode = { nextNonSticker: false };

  const harness = createWorkerHarness({ IRMIA_DATA_DIR: rootDir }, async (method, params) => {
    if (method === 'media/resolve') {
      if (params.attachmentId === 'att-sticker-a') {
        return {
          ok: true,
          sha256: shaA,
          mimeType: 'image/png',
          sizeBytes: stickerA.length,
          path: stickerAPath,
          mediaUrl: `/api/media/stickers/${shaA}.png`,
          dataBase64: stickerA.toString('base64'),
        };
      }
      if (params.attachmentId === 'att-non-sticker') {
        return {
          ok: true,
          sha256: shaNon,
          mimeType: 'image/png',
          sizeBytes: nonSticker.length,
          path: nonStickerPath,
          mediaUrl: `/api/media/stickers/${shaNon}.png`,
          dataBase64: nonSticker.toString('base64'),
        };
      }
      return { ok: false };
    }
    if (method === 'model/generate') {
      if (vlmMode.nextNonSticker) {
        return {
          text: JSON.stringify({
            isSticker: false,
            emotion: '无语',
            tags: ['代码截图'],
            caption: 'IDE代码',
            intensity: 1,
            confidence: 0.95,
          }),
        };
      }
      return {
        text: JSON.stringify({
          isSticker: true,
          emotion: '无语',
          tags: ['盯', '无语'],
          caption: '猫猫盯',
          intensity: 4,
          confidence: 0.92,
        }),
      };
    }
    if (method === 'event/append') {
      return { ok: true, seq: 99 };
    }
    if (method === 'media/store') {
      return { path: stickerAPath, mediaUrl: `/api/media/plugins/linre-stickers/${shaA}.png` };
    }
    return { ok: true };
  });

  try {
    const initRes = await harness.request('initialize', {
      config: { dataDir: pluginDataDir, ownerIds: ['owner-1'] },
    });
    assert.equal(initRes.ok, true);
    assert.equal(initRes.migratedCount, 1);

    const migratedCatalog = JSON.parse(readFileSync(join(pluginDataDir, 'catalog.json'), 'utf8'));
    assert.equal(migratedCatalog.version, 2);
    assert.equal(migratedCatalog.items.length, 1);
    assert.equal(migratedCatalog.items[0].id, 'legacy-1');
    assert.equal(migratedCatalog.items[0].status, 'approved');

    harness.notify('events/observe', {
      event: {
        type: 'wake/channel',
        data: {
          text: '看看这张图',
          chatId: 'group-100',
          senderId: 'user-200',
          senderName: '群友甲',
          attachments: [{ type: 'image/png', name: 'cat.png', attachmentId: 'att-sticker-a' }],
        },
      },
    });

    await new Promise((r) => setTimeout(r, 180));

    vlmMode.nextNonSticker = true;
    harness.notify('events/observe', {
      event: {
        type: 'channel/message',
        data: {
          text: '代码截图',
          chatId: 'group-100',
          senderId: 'user-201',
          senderName: '群友乙',
          attachments: [{ type: 'image', name: 'code.png', attachmentId: 'att-non-sticker' }],
        },
      },
    });

    await new Promise((r) => setTimeout(r, 180));

    const capturedEvents = harness.hostCalls.filter((c) => c.method === 'event/append' && c.params?.type === 'linre-stickers/captured');
    assert.equal(capturedEvents.length, 1);
    assert.equal(capturedEvents[0].params.data.caption, '猫猫盯');

    const pendingUi = await harness.request('ui/handle', { path: '/ui/stickers', query: {} });
    const tabsBlock = pendingUi.blocks.find((b) => b.type === 'tabs');
    assert.equal(tabsBlock.active, 'pending');
    const pendingGrid = pendingUi.blocks.find((b) => b.type === 'grid');
    assert.equal(pendingGrid.items.length, 1);
    const pendingId = pendingGrid.items[0].id;
    assert.equal(pendingGrid.items[0].title, '猫猫盯');
    assert.equal(pendingGrid.items[0].badge, '无语');

    const editRes = await harness.request('ui/invoke', {
      action: 'edit_item',
      id: pendingId,
      emotion: '得意',
      tags: '叉腰,得意',
      caption: '叉腰笑',
      intensity: 5,
    });
    assert.equal(editRes.ok, true);

    const approveRes = await harness.request('ui/invoke', { action: 'approve', id: pendingId });
    assert.equal(approveRes.ok, true);

    harness.notify('events/observe', {
      event: { type: 'wake/channel', data: { text: '叉腰笑一个' } },
    });
    const renderedNormal = await harness.request('prompt/render', {
      slot: 'now-layer',
      maxChars: 160,
      turn: 1,
      now: 2_000_000,
    });
    assert.match(renderedNormal.text, /可配图：\[得意\] 叉腰笑（标签：叉腰\/得意） → send_media path=/u);

    const sameTurn = await harness.request('prompt/render', {
      slot: 'now-layer',
      maxChars: 160,
      turn: 1,
      now: 2_000_000,
    });
    assert.equal(sameTurn.text, '');

    const cooldownHit = await harness.request('prompt/render', {
      slot: 'now-layer',
      maxChars: 160,
      turn: 2,
      now: 2_001_000,
    });
    assert.ok(!cooldownHit.text.includes('叉腰笑'));

    for (let i = 0; i < 5; i += 1) {
      harness.notify('events/observe', {
        event: { type: 'tool/call', data: { tool: 'speak' } },
      });
    }
    harness.notify('events/observe', {
      event: { type: 'wake/channel', data: { text: '今天天气不错' } },
    });
    const renderedFallback = await harness.request('prompt/render', {
      slot: 'now-layer',
      maxChars: 160,
      turn: 3,
      now: 2_500_000,
    });
    assert.match(renderedFallback.text, /可配图（已连聊多轮纯文字，顺手带一张更灵动）：/u);
    assert.match(renderedFallback.text, /send_media path="/u);

    harness.notify('events/observe', {
      event: { type: 'tool/call', data: { tool: 'send_media', arguments: { path: stickerAPath } } },
    });
    const stateAfterMedia = await harness.request('ui/handle', { path: '/state' });
    assert.equal(stateAfterMedia.speaksWithoutSticker, 0);

    const rejectRes = await harness.request('ui/invoke', { action: 'reject_block', id: pendingId });
    assert.equal(rejectRes.ok, true);

    vlmMode.nextNonSticker = false;
    harness.notify('events/observe', {
      event: {
        type: 'wake/channel',
        data: {
          text: '再发一次被拉黑的图',
          attachments: [{ type: 'image/png', name: 'cat.png', attachmentId: 'att-sticker-a' }],
        },
      },
    });
    await new Promise((r) => setTimeout(r, 150));
    const afterReSteal = await harness.request('ui/handle', { path: '/state' });
    assert.equal(afterReSteal.items.some((x) => x.id === pendingId), false);
    assert.equal(afterReSteal.blocked, 1);

    const importFolder = join(rootDir, 'import-folder');
    mkdirSync(importFolder, { recursive: true });
    writeFileSync(join(importFolder, 'imported.png'), makePatternPng(64, 64, 3));
    const importRes = await harness.request('ui/invoke', { action: 'import_dir', dirPath: importFolder, autoApprove: false });
    assert.equal(importRes.ok, true);

    const approveAllRes = await harness.request('ui/invoke', { action: 'approve_all_pending' });
    assert.equal(approveAllRes.ok, true);

    const approvedUi = await harness.request('ui/handle', { path: '/ui/stickers', query: { tab: 'approved', emotion: '开心' } });
    const approvedGrid = approvedUi.blocks.find((b) => b.type === 'grid');
    assert.ok(approvedGrid.items.length >= 1);

    harness.notify('events/observe', {
      event: { type: 'linre-affect/appraisal', data: { emotion: '开心' } },
    });
    harness.notify('events/observe', {
      event: { type: 'wake/channel', data: { text: '嗯嗯' } },
    });
    const affectRendered = await harness.request('prompt/render', {
      slot: 'now-layer',
      maxChars: 160,
      turn: 4,
      now: 3_000_000,
    });
    assert.match(affectRendered.text, /可配图：\[开心\]/u);

    const saveSettingsRes = await harness.request('ui/invoke', {
      action: 'save_settings',
      autoSteal: true,
      autoApproveOwner: true,
      cooldownSec: 120,
      fallbackAfterSpeaks: 4,
      maxPending: 150,
    });
    assert.equal(saveSettingsRes.ok, true);

    const mcp = createMcpHarness({ IRMIA_DATA_DIR: rootDir });
    try {
      const mcpInit = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
      assert.equal(mcpInit.serverInfo.name, 'linre-stickers');
      const toolsList = await mcp.request('tools/list', {});
      assert.deepEqual(toolsList.tools.map((t) => t.name), ['sticker_find', 'sticker_steal']);

      const foundLegacy = await mcp.request('tools/call', { name: 'sticker_find', arguments: { emotion: '开心', limit: 5 } });
      const foundPayload = JSON.parse(foundLegacy.content[0].text);
      assert.ok(foundPayload.results.length >= 1);
      assert.equal(foundPayload.results.some((r) => r.id === 'legacy-1'), true);

      const blockedSteal = await mcp.request('tools/call', {
        name: 'sticker_steal',
        arguments: { filePath: stickerAPath, caption: '想绕过黑名单', emotion: '无语' },
      });
      assert.equal(blockedSteal.isError, true);

      const newSteal = await mcp.request('tools/call', {
        name: 'sticker_steal',
        arguments: { filePath: nonStickerPath, caption: '新收图', emotion: '害羞', tags: ['脸红'] },
      });
      const newStealPayload = JSON.parse(newSteal.content[0].text);
      assert.equal(newStealPayload.ok, true);
      assert.equal(newStealPayload.status, 'pending');

      const findShy = await mcp.request('tools/call', { name: 'sticker_find', arguments: { emotion: '害羞' } });
      assert.equal(JSON.parse(findShy.content[0].text).results.length, 0);
    } finally {
      await mcp.close();
    }

    const clearBlockedRes = await harness.request('ui/invoke', { action: 'clear_blocked' });
    assert.equal(clearBlockedRes.ok, true);
    const blockedUi = await harness.request('ui/handle', { path: '/ui/stickers', query: { tab: 'blocked' } });
    assert.equal(blockedUi.blocks.some((b) => b.type === 'empty'), true);
  } finally {
    await harness.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
