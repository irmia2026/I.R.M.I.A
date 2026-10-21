/**
 * 附件仓库测试 — src/channel/attachment-store.ts
 *
 * 这一层是「图片进上下文」的地基：直链只是线索，进上下文的一律是本地那份字节。
 * 所以每条用例都在问同一件事——**本地到底有没有那份字节，取不到时有没有老实降级**。
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';

import {
  ATTACHMENT_DIR_NAME,
  CONTEXT_IMAGE_COMPRESS_ABOVE_BYTES,
  CONTEXT_IMAGE_HARD_BYTES,
  CONTEXT_IMAGE_MAX_EDGE,
  DEFAULT_ATTACHMENT_DOWNLOAD_MAX_BYTES,
  attachmentPath,
  compressedPath,
  ensureAttachment,
  readAttachmentDataUrl,
  readFileDataUrl,
  setImageCompressorForTest,
} from '../src/channel/attachment-store.ts';
import { tempDir } from './helpers/temp-dirs.ts';

async function makeTempDir(): Promise<string> {
  return tempDir('irmia-attach-');
}

interface FakeHost {
  origin: string;
  hits: () => number;
  close: () => Promise<void>;
}

/** 只会吐 bytes 的小服务器：够验证"下载—落盘—再读"这条路 */
async function startHost(
  handler: (req: { url: string }, res: {
    writeHead: (code: number, headers?: Record<string, string>) => void;
    end: (body?: Buffer | string) => void;
  }) => void,
): Promise<FakeHost> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    hits += 1;
    handler({ url: req.url ?? '' }, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('ensureAttachment：下载一次就落盘，第二次直接用本地那份（同一个 URL 不重复取）', async (t) => {
  const dataDir = await makeTempDir();
  const host = await startHost((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end(Buffer.from('jpeg-bytes'));
  });
  t.after(async () => { await host.close(); await rm(dataDir, { recursive: true, force: true }); });

  const url = `${host.origin}/a.jpg`;
  const first = await ensureAttachment(dataDir, url);
  assert.equal(first.outcome, 'fetched');
  assert.equal(first.bytes, 10);
  assert.equal(host.hits(), 1);

  const target = attachmentPath(dataDir, url);
  assert.ok(existsSync(target), '落盘路径 = blobs/images/<sha256(url)>');
  assert.equal((await readFile(target)).toString('utf8'), 'jpeg-bytes');

  const second = await ensureAttachment(dataDir, url);
  assert.equal(second.outcome, 'cached', '已有本地字节就不该再打一次网络');
  assert.equal(host.hits(), 1, '第二次没有再请求服务器');
});

test('ensureAttachment：超过下载上限就跳过，不写半个文件（只防"这不是一张图"）', async (t) => {
  const dataDir = await makeTempDir();
  const host = await startHost((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end(Buffer.alloc(2048, 1));
  });
  t.after(async () => { await host.close(); await rm(dataDir, { recursive: true, force: true }); });

  const url = `${host.origin}/big.jpg`;
  const result = await ensureAttachment(dataDir, url, { maxBytes: 1024 });
  assert.equal(result.outcome, 'skipped');
  assert.match(String(result.reason), /超过下载上限/);
  assert.ok(!existsSync(attachmentPath(dataDir, url)), '跳过的图不该留下垃圾文件');
});

test('ensureAttachment：HTTP 失败与空 body 都算 failed，不抛错（调用方靠它决定降级）', async (t) => {
  const dataDir = await makeTempDir();
  const host = await startHost((req, res) => {
    if (req.url === '/empty') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(Buffer.alloc(0));
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  t.after(async () => { await host.close(); await rm(dataDir, { recursive: true, force: true }); });

  const missing = await ensureAttachment(dataDir, `${host.origin}/gone.jpg`);
  assert.equal(missing.outcome, 'failed');
  assert.match(String(missing.reason), /404/);

  const empty = await ensureAttachment(dataDir, `${host.origin}/empty`);
  assert.equal(empty.outcome, 'failed');

  const blank = await ensureAttachment(dataDir, '');
  assert.equal(blank.outcome, 'skipped');
});

test('ensureAttachment：取不到地址也只是 failed，不会把异常抛给调用方', async () => {
  const dataDir = await makeTempDir();
  try {
    const result = await ensureAttachment(dataDir, 'https://example.invalid/none.jpg', { timeoutMs: 1_000 });
    assert.equal(result.outcome, 'failed');
    assert.ok(result.reason !== undefined && result.reason !== '');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('readAttachmentDataUrl：本地有字节才给 data URL，没有/超限一律 null（降级为纯文字）', async (t) => {
  const dataDir = await makeTempDir();
  const host = await startHost((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from('png-bytes'));
  });
  t.after(async () => { await host.close(); await rm(dataDir, { recursive: true, force: true }); });

  const url = `${host.origin}/a.png`;
  const ref = { source: 'remote' as const, key: url, mime: 'image/png' };

  assert.equal(readAttachmentDataUrl(dataDir, ref), null, '还没落盘时不能凭空造一张图');
  await ensureAttachment(dataDir, url);
  assert.equal(
    readAttachmentDataUrl(dataDir, ref),
    `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`,
  );
  assert.equal(readAttachmentDataUrl(dataDir, ref, 4), null, '超过本次允许的字节数就退化成纯文字');
  assert.equal(readAttachmentDataUrl(dataDir, { ...ref, key: '' }), null);
});

test('readFileDataUrl：她自己要求放进来的图走这条（工作目录内的文件）', async () => {
  const dir = await makeTempDir();
  try {
    const file = join(dir, 'pic.jpg');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, Buffer.from('local-bytes'));

    assert.equal(
      readFileDataUrl(file, 'image/jpeg', CONTEXT_IMAGE_HARD_BYTES),
      `data:image/jpeg;base64,${Buffer.from('local-bytes').toString('base64')}`,
    );
    assert.equal(readFileDataUrl(join(dir, 'nope.jpg'), 'image/jpeg', 1_000), null);
    assert.equal(readFileDataUrl(file, 'image/jpeg', 2), null, '超限同样退化');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('附件目录与落盘命名：内容寻址、不带扩展名（MIME 由事件给，不靠文件名猜）', async () => {
  const dataDir = await makeTempDir();
  try {
    const a = attachmentPath(dataDir, 'https://x.invalid/a.jpg');
    const b = attachmentPath(dataDir, 'https://x.invalid/a.jpg');
    const c = attachmentPath(dataDir, 'https://x.invalid/b.jpg');
    assert.equal(a, b, '同一个 URL 永远同一个落点');
    assert.notEqual(a, c);
    assert.ok(a.startsWith(join(dataDir, 'blobs', ATTACHMENT_DIR_NAME)));
    assert.ok(!a.endsWith('.jpg'), '不带扩展名：MIME 来自事件里的 type');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// ──────────────────────────── 大图先压再进 ────────────────────────────

/** 造一张"超过压缩阈值"的假图（内容无所谓，只看体积） */
function bigImage(): Buffer {
  return Buffer.alloc(CONTEXT_IMAGE_COMPRESS_ABOVE_BYTES + 2048, 7);
}

async function hostServing(body: Buffer): Promise<FakeHost> {
  return await startHost((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(body);
  });
}

test('大图先压：超过阈值就压一道，进上下文的是压缩产物而不是原件', async (t) => {
  const dataDir = await makeTempDir();
  const host = await hostServing(bigImage());
  const calls: Array<{ source: string; dest: string; maxEdge: number; quality: number }> = [];
  setImageCompressorForTest(async (source, dest, options) => {
    calls.push({ source, dest, maxEdge: options.maxEdge, quality: options.quality });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(dest, Buffer.from('small-jpeg'));
    return true;
  });
  t.after(async () => {
    setImageCompressorForTest(null);
    await host.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const url = `${host.origin}/big.png`;
  const result = await ensureAttachment(dataDir, url);
  assert.equal(result.outcome, 'fetched');
  assert.equal(result.compressed, true, '超过阈值必须压');
  assert.equal(calls.length, 1, '压一次就够，不重复起进程');
  assert.equal(calls[0]?.maxEdge, CONTEXT_IMAGE_MAX_EDGE);
  assert.ok(existsSync(compressedPath(dataDir, url)), '压缩产物按 .ctx.jpg 落在原件旁边');

  const dataUrl = readAttachmentDataUrl(dataDir, { source: 'remote', key: url, mime: 'image/png' });
  assert.equal(dataUrl, `data:image/jpeg;base64,${Buffer.from('small-jpeg').toString('base64')}`);
  assert.ok(
    (dataUrl?.length ?? 0) < CONTEXT_IMAGE_COMPRESS_ABOVE_BYTES,
    '每轮重发的是那一小份，不是原件',
  );
});

test('小图不压：不值得为它起一次进程', async (t) => {
  const dataDir = await makeTempDir();
  const host = await hostServing(Buffer.from('tiny'));
  let called = 0;
  setImageCompressorForTest(async () => { called += 1; return false; });
  t.after(async () => {
    setImageCompressorForTest(null);
    await host.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const url = `${host.origin}/small.jpg`;
  const result = await ensureAttachment(dataDir, url);
  assert.equal(result.outcome, 'fetched');
  assert.equal(result.compressed, undefined);
  assert.equal(called, 0);
  assert.equal(
    readAttachmentDataUrl(dataDir, { source: 'remote', key: url, mime: 'image/jpeg' }),
    `data:image/jpeg;base64,${Buffer.from('tiny').toString('base64')}`,
  );
});

test('压缩失败不改结局：原件还在，小于兜底上限就照常进上下文', async (t) => {
  const dataDir = await makeTempDir();
  const host = await hostServing(bigImage());
  setImageCompressorForTest(async () => false);
  t.after(async () => {
    setImageCompressorForTest(null);
    await host.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const url = `${host.origin}/big.png`;
  const result = await ensureAttachment(dataDir, url);
  assert.equal(result.outcome, 'fetched', '压不动不算下载失败');
  assert.equal(result.compressed, false);
  assert.ok(!existsSync(compressedPath(dataDir, url)));
  // 原件比兜底上限小，所以仍然进得去——压缩是优化，不是准入条件
  assert.ok(readAttachmentDataUrl(dataDir, { source: 'remote', key: url, mime: 'image/png' }) !== null);
});

test('下载上限与压缩阈值是两回事：真正的巨物才被挡在门外', async (t) => {
  const dataDir = await makeTempDir();
  // 只比下载上限大一点点：造一个 32MB 的 buffer 太浪费，直接用小上限注入
  const host = await hostServing(bigImage());
  t.after(async () => {
    await host.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const url = `${host.origin}/huge.png`;
  const result = await ensureAttachment(dataDir, url, { maxBytes: 1024 });
  assert.equal(result.outcome, 'skipped');
  assert.match(String(result.reason), /超过下载上限/);
  assert.ok(DEFAULT_ATTACHMENT_DOWNLOAD_MAX_BYTES > CONTEXT_IMAGE_COMPRESS_ABOVE_BYTES,
    '下载上限必须远大于压缩阈值——否则"先压再进"就没机会发生');
});

test('压缩好的产物复用：第二次不再起进程', async (t) => {
  const dataDir = await makeTempDir();
  const host = await hostServing(bigImage());
  let called = 0;
  setImageCompressorForTest(async (_source, dest) => {
    called += 1;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(dest, Buffer.from('small-jpeg'));
    return true;
  });
  t.after(async () => {
    setImageCompressorForTest(null);
    await host.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const url = `${host.origin}/big.png`;
  await ensureAttachment(dataDir, url);
  await ensureAttachment(dataDir, url);
  assert.equal(called, 1, '第二次该直接用已压好的那份');
});

// ─────────────────── 压缩失败要说得出原因（2026-10-21） ───────────────────
//
// 现场读数：107 个原件、0 个 `.ctx.jpg`；42 个 >400KB 的走过压缩分支，一个产物都没有，
// 而日志里**一个字都没有**——压缩器原来只回 `false`。下面两条锁"失败必须带原因"这一条，
// 三条出口各说各的（返回 false / 返回 {ok:false,reason} / 抛错）。

test('压缩失败把原因交出来（`compressFailure`）：结局不变，但不再只给一个 false', async (t) => {
  const dataDir = await makeTempDir();
  const host = await hostServing(bigImage());
  setImageCompressorForTest(async () => ({ ok: false, reason: 'GDI+ 进程起不来（用例注入）' }));
  t.after(async () => {
    setImageCompressorForTest(null);
    await host.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const url = `${host.origin}/big.png`;
  const result = await ensureAttachment(dataDir, url);
  assert.equal(result.outcome, 'fetched', '压不动不是下载失败');
  assert.equal(result.compressed, false);
  assert.equal(result.compressFailure, 'GDI+ 进程起不来（用例注入）', '原因要原样交出去（调用方拿它落 image/trace）');
});

test('压缩器抛错 / 只回 boolean 的旧写法：两种失败也各有原因（不静默）', async (t) => {
  const dataDir = await makeTempDir();
  const host = await hostServing(bigImage());
  t.after(async () => {
    setImageCompressorForTest(null);
    await host.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  setImageCompressorForTest(async () => { throw new Error('powershell 起不来'); });
  const thrown = await ensureAttachment(dataDir, `${host.origin}/boom.png`);
  assert.equal(thrown.outcome, 'fetched');
  assert.match(String(thrown.compressFailure), /powershell 起不来/u, '抛错要把错因带上');

  // 旧写法（只给 boolean）没有原因可给——如实说"它没给原因"，不编一个
  setImageCompressorForTest(async () => false);
  const url = `${host.origin}/legacy.png`;
  const legacy = await ensureAttachment(dataDir, url);
  assert.equal(legacy.compressed, false);
  assert.match(String(legacy.compressFailure), /没有给出原因/u);
});
