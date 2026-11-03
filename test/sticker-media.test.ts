import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeStickerMime, sniffStickerMime, stickerDimensions } from '../src/stickers/media.ts';
import { gifBytes, jpegBytes, pngBytes, webpBytes } from './helpers/sticker-fixtures.ts';

test('sticker media：四种白名单型别与尺寸都可识别', () => {
  const cases = [
    ['image/png', pngBytes(320, 200)],
    ['image/jpeg', jpegBytes(640, 480)],
    ['image/gif', gifBytes(128, 96)],
    ['image/webp', webpBytes(1024, 768)],
  ] as const;
  for (const [expected, bytes] of cases) {
    assert.equal(sniffStickerMime(bytes), expected);
    assert.ok(stickerDimensions(bytes, expected));
  }
  assert.deepEqual(stickerDimensions(pngBytes(320, 200), 'image/png'), { width: 320, height: 200 });
  assert.deepEqual(stickerDimensions(jpegBytes(640, 480), 'image/jpeg'), { width: 640, height: 480 });
  assert.deepEqual(stickerDimensions(gifBytes(128, 96), 'image/gif'), { width: 128, height: 96 });
  assert.deepEqual(stickerDimensions(webpBytes(1024, 768), 'image/webp'), { width: 1024, height: 768 });
});

test('sticker media：jpg 归一、伪造/未知型别与不可读尺寸安全处理', () => {
  assert.equal(normalizeStickerMime('image/jpg'), 'image/jpeg');
  assert.equal(normalizeStickerMime('image/bmp'), null);
  assert.equal(sniffStickerMime(Buffer.from('not an image')), null);
  assert.equal(stickerDimensions(Buffer.from([0x89, 0x50]), 'image/png'), null);
});
