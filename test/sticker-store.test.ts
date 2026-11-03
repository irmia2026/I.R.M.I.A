import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import test, { type TestContext } from 'node:test';

import { StickerStore } from '../src/stickers/store.ts';
import { pngBytes } from './helpers/sticker-fixtures.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

function rig(t: TestContext) {
  const dir = tempDirSync('irmia-sticker-store-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new StickerStore(dir, () => new Date('2026-10-31T04:00:00.000Z'));
  store.init();
  return store;
}

test('store：初始化两个包，导入待审、内容哈希去重、批准后移动原图', (t) => {
  const store = rig(t);
  assert.deepEqual(store.listPacks().map((pack) => pack.packId).sort(), ['collected', 'owner-stickers']);
  const bytes = pngBytes(16, 16);
  const imported = store.importSticker({ bytes, mime: 'image/png', source: 'collected' });
  assert.equal(imported.duplicate, false);
  assert.equal(imported.entry.status, 'pending');
  assert.ok(existsSync(store.entryPath('collected', imported.entry.file)));
  assert.equal(store.importSticker({ bytes, mime: 'image/png', source: 'collected' }).duplicate, true);
  assert.equal(store.listEntries().length, 1);

  const approved = store.applyTagging(imported.entry.id, { tags: ['开心'], intensity: 'obvious', confidence: 0.9, note: '测试' }, true);
  assert.equal(approved.status, 'approved');
  assert.ok(approved.file.startsWith('cache/'));
  assert.ok(existsSync(store.entryPath('collected', approved.file)));
  assert.equal(store.candidates('开心').length, 1);
});

test('store：init 幂等降级旧的 collected 自动批准条目，owner/人工批准不动', (t) => {
  const store = rig(t);
  const legacy = store.importSticker({ bytes: pngBytes(11, 11), mime: 'image/png', source: 'collected' });
  const human = store.importSticker({ bytes: pngBytes(12, 12), mime: 'image/png', source: 'collected' });
  const owner = store.importSticker({ bytes: pngBytes(13, 13), mime: 'image/png', source: 'owner' });
  const pack = store.readPack('collected');
  Object.assign(pack.stickers.find((item) => item.id === legacy.entry.id)!, {status: 'approved', tags: ['开心'], tagSource: 'auto'});
  Object.assign(pack.stickers.find((item) => item.id === human.entry.id)!, {status: 'approved', tags: ['开心'], tagSource: 'human'});
  store.writePack(pack);
  const ownerPack = store.readPack('owner-stickers');
  Object.assign(ownerPack.stickers.find((item) => item.id === owner.entry.id)!, {status: 'approved', tags: ['难过'], tagSource: 'auto'});
  store.writePack(ownerPack);

  assert.equal(store.migrateLegacyCollectedApprovals(), 1);
  assert.equal(store.findById(legacy.entry.id)?.entry.status, 'pending');
  assert.equal(store.findById(human.entry.id)?.entry.status, 'approved');
  assert.equal(store.findById(owner.entry.id)?.entry.status, 'approved', 'owner 包不动');
  assert.deepEqual(store.candidates('开心').map((entry) => entry.id), [human.entry.id]);
  assert.equal(store.migrateLegacyCollectedApprovals(), 0, '幂等');
});

test('store：phash 写入、最近邻查找、补写与缺 hash 列表', (t) => {
  const store = rig(t);
  const a = store.importSticker({
    bytes: pngBytes(21, 21), mime: 'image/png', source: 'collected', phash: '0000000000000000',
  });
  const b = store.importSticker({
    bytes: pngBytes(22, 22), mime: 'image/png', source: 'collected', phash: 'ffffffffffffffff',
  });
  const c = store.importSticker({bytes: pngBytes(23, 23), mime: 'image/png', source: 'owner'});
  assert.equal(a.entry.phash, '0000000000000000');
  assert.equal(store.findByPHash('0000000000000001')?.entry.id, a.entry.id, '距离 1');
  assert.equal(store.findByPHash('00000000000000ff'), null, '距离 8 超阈值');
  assert.equal(store.findByPHash('ffffffffffffffff')?.entry.id, b.entry.id);
  assert.deepEqual(store.entriesMissingPHash().map((row) => row.id), [c.entry.id]);
  assert.ok(store.entriesMissingPHash()[0]!.path.endsWith('.png'));
  store.setPHash(c.entry.id, '00ff00ff00ff00ff');
  assert.equal(store.findById(c.entry.id)?.entry.phash, '00ff00ff00ff00ff');
  assert.deepEqual(store.entriesMissingPHash(), []);
});

test('store：最近十张去重、同图三十天三次上限与今日计数', (t) => {
  const store = rig(t);
  const imported = store.importSticker({ bytes: pngBytes(), mime: 'image/png', source: 'owner' });
  store.applyTagging(imported.entry.id, { tags: ['开心'], intensity: 'obvious', confidence: 1, note: '' }, true);
  for (let i = 0; i < 3; i++) store.recordSent(imported.entry.id, new Date(`2026-10-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`));
  assert.equal(store.candidates('开心', new Date('2026-10-15T00:00:00.000Z')).length, 0, '三十天三次后不再候选');
  assert.equal(store.sentToday(new Date('2026-10-03T00:00:00.000Z')), 1);
});

test('store：discard 从索引与文件彻底移除，rejected 相对路径也安全', (t) => {
  const store = rig(t);
  const pending = store.importSticker({bytes: pngBytes(31, 31), mime: 'image/png', source: 'collected'});
  const pendingPath = store.entryPath('collected', pending.entry.file);
  assert.equal(store.discard(pending.entry.id), true);
  assert.equal(store.findById(pending.entry.id), null);
  assert.equal(existsSync(pendingPath), false);
  assert.equal(store.discard(pending.entry.id), false, '找不到不抛，返回 false');

  const rejected = store.importSticker({bytes: pngBytes(32, 32), mime: 'image/png', source: 'collected'});
  store.review(rejected.entry.id, 'reject');
  const rejectedPath = store.entryPath('collected', store.findById(rejected.entry.id)!.entry.file);
  assert.equal(store.discard(rejected.entry.id), true);
  assert.equal(store.findById(rejected.entry.id), null);
  assert.equal(existsSync(rejectedPath), false);
  assert.equal(store.purgeRejected(), 0);
});

test('store：手动 reject 仍保留在 rejected，不被 discard 逻辑误伤', (t) => {
  const store = rig(t);
  const imported = store.importSticker({bytes: pngBytes(33, 33), mime: 'image/png', source: 'collected'});
  store.review(imported.entry.id, 'reject');
  assert.equal(store.findById(imported.entry.id)?.entry.status, 'rejected');
  assert.equal(store.listEntries().length, 1);
});

test('store：拒绝保留原图、恢复回库、彻底删除只清 rejected', (t) => {
  const store = rig(t);
  const imported = store.importSticker({ bytes: pngBytes(), mime: 'image/png', source: 'collected' });
  store.review(imported.entry.id, 'reject');
  const rejected = store.findById(imported.entry.id)!.entry;
  assert.ok(rejected.file.includes('rejected'));
  assert.equal(rejected.rejectedAt, '2026-10-31T04:00:00.000Z');
  assert.ok(existsSync(store.entryPath('collected', rejected.file)));
  store.review(imported.entry.id, 'restore');
  assert.equal(store.findById(imported.entry.id)?.entry.status, 'approved');
  assert.equal(store.findById(imported.entry.id)?.entry.rejectedAt, undefined);
  store.review(imported.entry.id, 'delete');
  assert.equal(store.purgeRejected(), 1);
  assert.equal(store.findById(imported.entry.id), null);
});

test('store：打标与采收限流状态可从 state.json 重建', (t) => {
  const store = rig(t);
  assert.equal(store.consumeTagging(new Date('2026-10-31T04:00:00.000Z'), 1), true);
  assert.equal(store.consumeTagging(new Date('2026-10-31T04:30:00.000Z'), 1), false);
  assert.equal(store.consumeHarvest('qq:c2c:owner', new Date('2026-10-31T04:00:00.000Z'), 1, 1), true);
  assert.equal(store.harvestAllowed('qq:c2c:owner', new Date('2026-10-31T04:30:00.000Z'), 1, 1), false);
  const state = JSON.parse(readFileSync(`${store.root}/state.json`, 'utf8')) as { tagging: { callsMs: number[] } };
  assert.equal(state.tagging.callsMs.length, 1);
});
