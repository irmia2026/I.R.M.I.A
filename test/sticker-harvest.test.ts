import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test, { type TestContext } from 'node:test';

import { createHash } from 'node:crypto';
import { StickerHarvester, STICKER_HARVEST_MAX_BYTES, type HarvestMessage } from '../src/stickers/harvest.ts';
import type { StickerResizer } from '../src/stickers/resize.ts';
import { StickerStore } from '../src/stickers/store.ts';
import { StickerTagger } from '../src/stickers/tagger.ts';
import { gifBytes, pngBytes, stickerModelResponse } from './helpers/sticker-fixtures.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const VALID = '{"tags":["开心"],"intensity":"obvious","confidence":0.9,"note":"微笑","isSticker":true}';
const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
const message = (bytes: Buffer, chatType: HarvestMessage['chatType'] = 'group'): HarvestMessage => ({
  channel: 'onebot', chatType, chatId: 'group-1', person: 'person-1',
  attachments: [{ type: 'image', url: dataUrl(bytes) }],
});

function rig(t: TestContext, options: { probability?: number; text?: string; resize?: StickerResizer } = {}) {
  const dir = tempDirSync('irmia-sticker-harvest-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // store 与 harvester 必须用同一个固定时钟：store 用 04:00 写限流窗口，而 harvester
  // 默认 `new Date()`；一旦墙钟走过 05:00，窗口就被当成"一小时前"清掉，限流用例随机红。
  const now = () => new Date('2026-10-31T04:00:00.000Z');
  const store = new StickerStore(dir, now);
  store.init();
  let modelCalls = 0;
  const tagger = new StickerTagger({
    store,
    model: 'vision-test',
    client: { generate: async () => { modelCalls += 1; return stickerModelResponse(options.text ?? VALID); } },
    emit: (type, data) => events.push({ type, data }),
  });
  const events: Array<{ type: string; data: unknown }> = [];
  const harvester = new StickerHarvester({
    store,
    tagger,
    probability: options.probability ?? 1,
    random: () => 0,
    now,
    ...(options.resize === undefined ? {} : {resize: options.resize}),
    emit: (type, data) => events.push({ type, data }),
  });
  return { store, harvester, events, modelCalls: () => modelCalls };
}

test('harvest：群聊候选落 inbox 后进入 pending，只写 internal 贴纸事件', async (t) => {
  const { store, harvester, events } = rig(t);
  const outcome = await harvester.harvest(message(pngBytes(32, 32)));
  assert.equal(outcome.result, 'pending');
  assert.equal(store.listEntries()[0]?.entry.status, 'pending');
  assert.deepEqual(events.map((event) => event.type).sort(), ['sticker/harvested', 'sticker/tagged']);
  assert.ok(events.every((event) => !event.type.startsWith('wake/')));
});

test('harvest：私聊只收用户，别人与自我回声在打标前拒绝', async (t) => {
  const { harvester, modelCalls } = rig(t);
  const other = await harvester.harvest(message(pngBytes(), 'c2c'), { owner: false });
  assert.equal(other.result, 'rejected');
  assert.equal(other.reason, 'private-non-owner');
  const own = await harvester.harvest(message(pngBytes(), 'c2c'), { self: true, owner: true });
  assert.equal(own.result, 'rejected');
  assert.equal(own.reason, 'self-message');
  assert.equal(modelCalls(), 0);
});

test('harvest：超字节/重复内容都不进库', async (t) => {
  const { store, harvester, modelCalls } = rig(t);
  assert.equal((await harvester.harvest(message(pngBytes(1, 1)))).result, 'pending');
  assert.equal((await harvester.harvest(message(pngBytes(1, 1)))).reason, 'duplicate');
  assert.equal(store.listEntries().length, 1);
  assert.equal(modelCalls(), 1);
  const huge = Buffer.concat([pngBytes(), Buffer.alloc(STICKER_HARVEST_MAX_BYTES)]);
  assert.equal((await harvester.harvest(message(huge))).reason, 'too-large');
});

test('harvest：非 GIF 超 160 先 resize，用缩后字节入库与打标', async (t) => {
  let calls = 0;
  const resized = pngBytes(160, 80);
  const { store, harvester, events } = rig(t, {
    resize: async () => {
      calls += 1;
      return {bytes: resized, mime: 'image/png', width: 160, height: 80, resized: true};
    },
  });
  const outcome = await harvester.harvest(message(pngBytes(640, 480)));
  assert.equal(calls, 1);
  assert.equal(outcome.result, 'pending');
  assert.equal(outcome.sha256, createHash('sha256').update(resized).digest('hex'));
  const entry = store.listEntries()[0]!.entry;
  assert.equal(entry.sha256, outcome.sha256);
  assert.deepEqual(store.readEntryBytes(entry.id), resized);
  assert.equal(events.some((event) => event.type === 'sticker/harvested'
    && (event.data as {resizeFailed?: boolean}).resizeFailed === true), false);
});

test('harvest：GIF 不调用 resize，即使超过 160', async (t) => {
  let calls = 0;
  const { store, harvester } = rig(t, {
    resize: async () => {
      calls += 1;
      throw new Error('GIF must not resize');
    },
  });
  const gif = gifBytes(640, 480);
  const outcome = await harvester.harvest(message(gif));
  assert.equal(calls, 0);
  assert.equal(outcome.result, 'pending');
  const entry = store.listEntries()[0]!.entry;
  assert.deepEqual(store.readEntryBytes(entry.id), gif);
});

test('harvest：resize 失败回退原图、事件带 resizeFailed，不崩', async (t) => {
  const original = pngBytes(640, 480);
  const { store, harvester, events } = rig(t, {resize: async () => null});
  const outcome = await harvester.harvest(message(original));
  assert.equal(outcome.result, 'pending');
  assert.equal(outcome.resizeFailed, true);
  assert.equal(outcome.sha256, createHash('sha256').update(original).digest('hex'));
  assert.deepEqual(store.readEntryBytes(store.listEntries()[0]!.entry.id), original);
  const harvested = events.find((event) => event.type === 'sticker/harvested')!.data as {resizeFailed?: boolean};
  assert.equal(harvested.resizeFailed, true);
});

test('harvest：isSticker=false 进 rejected，不进可发送列表', async (t) => {
  const { store, harvester, events } = rig(t, {
    text: '{"tags":["开心"],"intensity":"obvious","confidence":0.9,"note":"截图","isSticker":false}',
  });
  const outcome = await harvester.harvest(message(pngBytes(32, 32)));
  assert.equal(outcome.result, 'rejected');
  assert.equal(outcome.reason, 'not-sticker');
  assert.equal(store.listEntries()[0]?.entry.status, 'rejected');
  assert.equal(store.candidates('开心').length, 0);
  const harvested = events.find((event) => event.type === 'sticker/harvested')!.data as {result: string; reason: string};
  assert.equal(harvested.result, 'rejected');
  assert.equal(harvested.reason, 'not-sticker');
});

test('harvest：骰子未命中不写文件也不打标', async (t) => {
  const { store, harvester, modelCalls } = rig(t, { probability: 0 });
  const outcome = await harvester.harvest(message(pngBytes()));
  assert.equal(outcome.result, 'skipped');
  assert.equal(outcome.reason, 'disabled');
  assert.equal(store.listEntries().length, 0);
  assert.equal(modelCalls(), 0);
});

test('harvest：低置信留待审，单条消息最多收一张', async (t) => {
  const { store, harvester } = rig(t, { text: VALID.replace('0.9', '0.5') });
  const input = message(pngBytes(2, 2));
  input.attachments!.push({ type: 'image', url: dataUrl(pngBytes(3, 3)) });
  const outcome = await harvester.harvest(input);
  assert.equal(outcome.result, 'pending');
  assert.equal(store.listEntries().length, 1);
  assert.equal(store.listEntries()[0]?.entry.status, 'pending');
});

test('harvest：会话限流在骰子与打标之前生效', async (t) => {
  const { store, harvester, modelCalls } = rig(t);
  for (let i = 0; i < 10; i++) store.consumeHarvest('onebot:group:group-1', new Date('2026-10-31T04:00:00.000Z'), 10, 50);
  const outcome = await harvester.harvest(message(pngBytes()));
  assert.equal(outcome.result, 'rejected');
  assert.equal(outcome.reason, 'rate-limited');
  assert.equal(modelCalls(), 0);
});
