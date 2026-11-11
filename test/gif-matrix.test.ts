import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  ensureGifMatrix, gifMatrixPath, isGifFile,
} from '../src/channel/gif-matrix.ts';
import {
  attachmentPath, ensureAttachment, readAttachmentImage,
} from '../src/channel/attachment-store.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

// 2 帧、各 0.7s 的 GIF（由 ffmpeg 生成后取字节）；测试不依赖本机 ffmpeg。
const TWO_FRAME_GIF = Buffer.from(
  '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',
  'base64',
);

test('多帧 GIF：生成矩阵缓存，附件读取优先采用矩阵', { skip: process.platform !== 'win32' }, async () => {
  const dir = tempDirSync('gif-matrix-');
  const key = 'https://example.test/two-frame.gif';
  const source = attachmentPath(dir, key);
  mkdirSync(join(dir, 'blobs', 'images'), { recursive: true });
  writeFileSync(source, TWO_FRAME_GIF);
  assert.equal(isGifFile(source), true);

  const ensured = await ensureAttachment(dir, key);
  assert.equal(ensured.gifMatrix, true);

  const matrix = gifMatrixPath(dir, key);
  assert.equal(isGifFile(matrix), false, '矩阵产物应是 JPEG，不是原 GIF');
  const read = readAttachmentImage(dir, { source: 'remote', key, mime: 'image/gif' });
  assert.equal(read.ok, true);
  assert.equal(read.ok ? read.image.mediaType : null, 'image/jpeg');
  assert.equal(read.ok ? read.compressed : null, true);
});

test('非 GIF 不生成矩阵；转换器保留回退边界', { skip: process.platform !== 'win32' }, async () => {
  const dir = tempDirSync('gif-matrix-static-');
  const source = join(dir, 'not-gif.gif');
  writeFileSync(source, Buffer.from('not a gif'));
  const result = await ensureGifMatrix(source, join(dir, 'out.jpg'));
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /不是 GIF/u);
});
