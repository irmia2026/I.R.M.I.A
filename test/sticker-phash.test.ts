import assert from 'node:assert/strict';
import test from 'node:test';

import { rmSync } from 'node:fs';

import {
  STICKER_PHASH_MAX_DISTANCE, computeStickerPHashBatch, phashDistance,
} from '../src/stickers/phash.ts';
import { backfillStickerPHashes } from '../src/stickers/phash-backfill.ts';
import { StickerStore } from '../src/stickers/store.ts';
import { pngBytes } from './helpers/sticker-fixtures.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

test('phash distance: same=0, 1 bit=1, 7 bits=7, malformed=max', () => {
  const a = '0123456789abcdef';
  assert.equal(phashDistance(a, a), 0);
  assert.equal(phashDistance(a, '0123456789abcdee'), 1);
  assert.equal(phashDistance(a, '0123456789abcd00'), 7);
  assert.equal(phashDistance(a, 'not-a-hash'), 64);
  assert.equal(phashDistance(a, null), 64);
  assert.equal(STICKER_PHASH_MAX_DISTANCE, 6);
});

test('phash threshold separates near duplicates from different images', () => {
  const base = '0000000000000000';
  const near = '0000000000000007'; // 3 bits
  const different = 'ffffffffffffffff';
  assert.ok(phashDistance(base, near) <= STICKER_PHASH_MAX_DISTANCE);
  assert.ok(phashDistance(base, different) > STICKER_PHASH_MAX_DISTANCE);
});

test('empty batch does not spawn a process and returns []', async () => {
  assert.deepEqual(await computeStickerPHashBatch([]), []);
});

test('backfill: one batch writes missing hashes and leaves existing hashes alone', async () => {
  const dir = tempDirSync('irmia-sticker-phash-backfill-');
  try {
    const store = new StickerStore(dir);
    store.init();
    const existing = store.importSticker({
      bytes: pngBytes(2, 2), mime: 'image/png', source: 'collected', phash: '1111111111111111',
    });
    const missing = store.importSticker({bytes: pngBytes(3, 3), mime: 'image/png', source: 'collected'});
    const missingOwner = store.importSticker({bytes: pngBytes(4, 4), mime: 'image/png', source: 'owner'});
    let calls = 0;
    const result = await backfillStickerPHashes(store, async (paths) => {
      calls += 1;
      assert.equal(paths.length, 2);
      return ['2222222222222222', '3333333333333333'];
    });
    assert.deepEqual(result, {total: 2, filled: 2, failed: 0});
    assert.equal(calls, 1, '一次批量进程');
    assert.equal(store.findById(existing.entry.id)?.entry.phash, '1111111111111111');
    assert.equal(store.findById(missing.entry.id)?.entry.phash, '2222222222222222');
    assert.equal(store.findById(missingOwner.entry.id)?.entry.phash, '3333333333333333');
    assert.deepEqual(store.entriesMissingPHash(), []);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('backfill: batch failure counts failures but does not throw', async () => {
  const dir = tempDirSync('irmia-sticker-phash-backfill-fail-');
  try {
    const store = new StickerStore(dir);
    store.init();
    store.importSticker({bytes: pngBytes(5, 5), mime: 'image/png', source: 'collected'});
    const result = await backfillStickerPHashes(store, async () => { throw new Error('gdi failed'); });
    assert.deepEqual(result, {total: 1, filled: 0, failed: 1});
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
