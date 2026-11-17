import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { compressedPath, ensureAttachment } from '../src/channel/attachment-store.ts';
import { ensureGifMatrix } from '../src/channel/gif-matrix.ts';
import { instancesFilePath } from '../src/runtime/instance-registry.ts';
import { serverPortFilePath, serverPortFilePathForPort } from '../src/runtime/server-port-file.ts';
import { backfillStickerPHashes } from '../src/stickers/phash-backfill.ts';
import { computeStickerPHash, STICKER_PHASH_FIELD } from '../src/stickers/phash.ts';
import { resizeStickerImage } from '../src/stickers/resize.ts';
import { StickerStore } from '../src/stickers/store.ts';
import { createEnv, createFindTool } from '../src/tools/fs/index.ts';
import { tempDir } from './helpers/temp-dirs.ts';

const linux = { skip: process.platform !== 'linux' };

test('Linux desktop uses private session and state locations', linux, () => {
  const env = { HOME: '/home/test', XDG_STATE_HOME: 'relative', XDG_RUNTIME_DIR: '/run/user/10' };
  assert.equal(instancesFilePath(env), '/home/test/.local/state/irmia/instances.json');
  assert.equal(serverPortFilePath(env), '/run/user/10/irmia/server.json');
  assert.equal(serverPortFilePathForPort(7789, env), '/run/user/10/irmia/server.7789.json');
  assert.equal(instancesFilePath({ HOME: '/home/test' }), null, 'headless service has no desktop session');
});

test('Linux find lists, sorts and counts files without following directory symlinks', linux, async () => {
  const root = await tempDir('irmia-find-');
  await mkdir(join(root, '子目录'));
  await writeFile(join(root, 'A.TXT'), 'a'.repeat(100));
  await writeFile(join(root, '子目录', 'b.txt'), 'b');
  await symlink(root, join(root, 'cycle'));
  const ctx = { callId: 'find', turn: 1, step: 1, signal: new AbortController().signal, workspaceRoot: root };
  const tool = createFindTool(createEnv({}, {}), null);
  const result = await tool.handler({ pattern: '*.txt', detail: 'full', max_results: 1, sort_by: 'size' }, ctx);
  assert.equal(result.isError, undefined, result.content);
  assert.match(result.content, /命中 2 个/u);
  assert.match(result.content, /子目录\/b\.txt/u);
  assert.doesNotMatch(result.content, /A\.TXT/u);
  const count = await tool.handler({ pattern: '^A\\.TXT$', regex: true, max_results: 0 }, ctx);
  assert.match(count.content, /命中 1 个/u);
  const folder = await tool.handler({ pattern: '子目录', file_type: 'folder' }, ctx);
  assert.match(folder.content, /命中 1 个/u);
  const controller = new AbortController();
  controller.abort();
  assert.equal((await tool.handler({ pattern: '*' }, { ...ctx, signal: controller.signal })).isError, true);
});

test('Linux formats attachments and GIFs and preserves legacy sticker hashes', linux, async (t) => {
  const python = process.env['IRMIA_IMAGE_PYTHON'] ?? 'python3';
  if (spawnSync(python, ['-I', '-c', 'import PIL']).status !== 0) {
    t.skip('system Pillow is not installed');
    return;
  }
  const root = await tempDir('irmia-media-');
  const png = join(root, '表 情.png');
  const gif = join(root, '动 图.gif');
  const made = spawnSync(python, ['-I', '-c', [
    'from PIL import Image',
    'import random, sys',
    'random.seed(0)',
    'image = Image.new("RGBA", (520, 320), (0, 0, 0, 0))',
    'image.putdata([(random.randrange(256), random.randrange(256), 0, random.randrange(256)) for _ in range(520 * 320)])',
    'image.save(sys.argv[1])',
    'frames = [Image.new("RGB", (40, 30), color) for color in ("red", "blue", "green")]',
    'frames[0].save(sys.argv[2], append_images=frames[1:], save_all=True, duration=[100, 110, 120], loop=0)',
  ].join('\n'), png, gif], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const bytes = await readFile(png);
  const resized = await resizeStickerImage({ bytes, mime: 'image/png', maxEdge: 160 });
  assert(resized);
  assert.equal(resized.width, 160);
  assert.equal(resized.bytes[25], 6, 'PNG retains its alpha channel');
  const key = 'https://image.invalid/example.png';
  const attachment = await ensureAttachment(root, key, {
    fetchImpl: async () => new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png' } }),
  });
  assert.equal(attachment.compressed, true, attachment.compressFailure);
  assert.equal((await readFile(compressedPath(root, key)))[0], 0xff);
  const matrix = await ensureGifMatrix(gif, join(root, '帧矩阵.jpg'));
  assert.equal(matrix.ok, true, matrix.reason);
  assert.equal(matrix.selected, 3);

  const store = new StickerStore(root);
  const legacy = '0123456789abcdef';
  const entry = store.importSticker({ bytes, mime: 'image/png', source: 'owner', phash: legacy }).entry;
  assert.equal((await backfillStickerPHashes(store)).filled, 1);
  const hash = await computeStickerPHash(bytes, 'image/png');
  assert(hash);
  assert.equal(store.findById(entry.id)?.entry.phash, legacy);
  assert.equal(store.findByPHash(hash, 0, STICKER_PHASH_FIELD)?.entry.id, entry.id);
});
