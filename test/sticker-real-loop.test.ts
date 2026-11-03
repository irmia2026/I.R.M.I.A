import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';

import { makeAppraisedData } from '../src/affect/engine.ts';
import { defaultConfig } from '../src/config/config.ts';
import { StickerRuntime } from '../src/stickers/runtime.ts';
import { StickerStore } from '../src/stickers/store.ts';
import type { MediaRequest, ReplyOutcome } from '../src/tools/admin.js';
import { makeRealWakeRig, RIG_NOW, type RealWakeRig } from './fixtures/real-wake-rig.ts';
import { pngBytes } from './helpers/sticker-fixtures.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

test('RealLoop：真实 turn 收尾按当前情绪补一张贴纸并落 sent 事件', async (t) => {
  const dir = tempDirSync('irmia-sticker-real-loop-');
  const store = new StickerStore(dir, () => new Date(RIG_NOW));
  store.init();
  const imported = store.importSticker({ bytes: pngBytes(), mime: 'image/png', source: 'owner' });
  store.applyTagging(imported.entry.id, { tags: ['开心'], intensity: 'obvious', confidence: 1, note: '' }, true);
  const config = defaultConfig(dir);
  config.affect.enabled = true;
  const posts: Array<{ url: string; media: MediaRequest }> = [];
  let rig!: RealWakeRig;
  const stickerRuntime = new StickerRuntime({
    store,
    config: () => config,
    affect: () => rig.projection.affect,
    mediaPoster: {
      post: async (target, media) => {
        posts.push({ url: target.url, media });
        return { ok: true, messageId: 'sticker-real-loop' } as ReplyOutcome;
      },
    },
    emit: (type, data) => { rig.append(type, data); },
    random: () => 0,
    now: () => new Date(RIG_NOW),
  });
  rig = await makeRealWakeRig({
    stream: [{ text: '', toolCalls: [] }],
    patchConfig: (current) => { current.affect.enabled = true; },
    stickerRuntime,
  });
  t.after(() => {
    rig.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const turn of [1, 2, 3]) rig.append('turn/start', { turn });
  const atMs = Date.parse(RIG_NOW);
  rig.append('affect/appraised', makeAppraisedData({
    sourceSeq: 100,
    evaluatedAtMs: atMs,
    sourceWeight: 1,
    appraisal: { r: 1, s: 1, u: 1, g: 0, b: 0, n: 0, z: 0.2, c: 0.2, q: 1 },
    reasonCode: 'owner_success',
  }));
  rig.append('wake/channel', {
    channel: 'onebot', chatType: 'c2c', person: 'owner', chatId: 'owner',
    text: '好消息', messageId: 'm1', msgSeq: 1,
  });
  await rig.tick();

  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.url, 'onebot:c2c:owner');
  const events = await rig.events();
  const sent = events.find((event) => event.type === 'sticker/sent');
  assert.deepEqual(sent?.data, {
    source: 'passive', tag: '开心', stickerId: imported.entry.id, position: 'after',
    dice: 0, affect: { dominant: 'joy', value: 1 }, candidates: [imported.entry.id],
  });
  assert.equal(sent?.visibility, 'internal');
  assert.ok(events.findIndex((event) => event.type === 'sticker/sent') > events.findIndex((event) => event.type === 'turn/end'));
});
