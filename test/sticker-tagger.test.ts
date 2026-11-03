import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test, { type TestContext } from 'node:test';

import type { DsResponse } from '../src/model/ds-client.js';
import { StickerStore } from '../src/stickers/store.ts';
import { parseStickerTagging, StickerTagger } from '../src/stickers/tagger.ts';
import type { VisionGenerateRequest, VisionModelClient } from '../src/tools/vision.ts';
import { pngBytes, stickerModelResponse } from './helpers/sticker-fixtures.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const VALID = '{"tags":["开心","亲近"],"intensity":"obvious","confidence":0.9,"note":"微笑"}';

function rig(t: TestContext, options: { enabled?: boolean; maxPerHour?: number; text?: string; fail?: boolean } = {}) {
  const dir = tempDirSync('irmia-sticker-tagger-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new StickerStore(dir, () => new Date('2026-10-31T04:00:00.000Z'));
  store.init();
  const imported = store.importSticker({ bytes: pngBytes(), mime: 'image/png', source: 'collected' });
  const requests: VisionGenerateRequest[] = [];
  const usage: Array<DsResponse | null> = [];
  const events: Array<{ type: string; data: unknown }> = [];
  const client: VisionModelClient = {
    generate: async (request) => {
      requests.push(request);
      if (options.fail === true) throw new Error('model unavailable');
      return stickerModelResponse(options.text ?? VALID);
    },
  };
  const tagger = new StickerTagger({
    client,
    store,
    model: 'vision-test',
    enabled: options.enabled,
    maxPerHour: options.maxPerHour,
    onUsage: (response) => usage.push(response),
    emit: (type, data) => events.push({ type, data }),
  });
  return { store, imported, tagger, requests, usage, events };
}

test('tagger：严格 JSON 只收九标签 1–2 个与四字段，其他一律失败', () => {
  assert.deepEqual(parseStickerTagging(VALID), { tags: ['开心', '亲近'], intensity: 'obvious', confidence: 0.9, note: '微笑' });
  for (const raw of [
    '```json\n' + VALID + '\n```',
    VALID.replace('"开心"', '"期待"'),
    VALID.replace('"开心","亲近"', '"开心","开心"'),
    VALID.replace('0.9', '1.1'),
    VALID.replace('0.9', '0.9,"extra":true'),
    VALID.replace('"obvious"', '"very"'),
    '{}',
  ]) assert.equal(parseStickerTagging(raw), null, raw);
});

test('tagger：达标自动入库，视觉请求 light/low，usage 与 tagged 留痕', async (t) => {
  const { store, imported, tagger, requests, usage, events } = rig(t);
  const outcome = await tagger.tag({ stickerId: imported.entry.id, bytes: pngBytes(), mime: 'image/png' });
  assert.equal(outcome.approved, true);
  assert.equal(outcome.reason, 'auto-approved');
  assert.equal(store.findById(imported.entry.id)?.entry.status, 'approved');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.lane, 'light');
  assert.deepEqual(requests[0]?.reasoning, { effort: 'low' });
  assert.equal(requests[0]?.input[0]?.content[0]?.type, 'input_text');
  assert.equal(requests[0]?.input[0]?.content[1]?.type, 'input_image');
  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.model, 'vision-test');
  assert.ok(events.some((event) => event.type === 'sticker/tagged' && (event.data as { ok: boolean }).ok));
});

test('tagger：解析失败与低置信都留待审，不重试轰炸', async (t) => {
  for (const text of ['not json', VALID.replace('0.9', '0.5')]) {
    const { store, imported, tagger, requests } = rig(t, { text });
    const outcome = await tagger.tag({ stickerId: imported.entry.id, bytes: pngBytes(), mime: 'image/png' });
    assert.equal(outcome.approved, false);
    assert.equal(store.findById(imported.entry.id)?.entry.status, 'pending');
    assert.equal(requests.length, 1);
  }
});

test('tagger：关闭与每小时限流都不发模型调用', async (t) => {
  const disabled = rig(t, { enabled: false });
  const off = await disabled.tagger.tag({ stickerId: disabled.imported.entry.id, bytes: pngBytes(), mime: 'image/png' });
  assert.equal(off.reason, 'tagging-disabled');
  assert.equal(disabled.requests.length, 0);

  const limited = rig(t, { maxPerHour: 1 });
  await limited.tagger.tag({ stickerId: limited.imported.entry.id, bytes: pngBytes(), mime: 'image/png' });
  const second = await limited.tagger.tag({ stickerId: limited.imported.entry.id, bytes: pngBytes(), mime: 'image/png' });
  assert.equal(second.reason, 'rate-limited');
  assert.equal(limited.requests.length, 1);
});

test('tagger：模型失败记失败 usage 与 pending，不重试', async (t) => {
  const { store, imported, tagger, requests, usage } = rig(t, { fail: true });
  const outcome = await tagger.tag({ stickerId: imported.entry.id, bytes: pngBytes(), mime: 'image/png' });
  assert.equal(outcome.reason, 'model-failed');
  assert.equal(store.findById(imported.entry.id)?.entry.status, 'pending');
  assert.equal(requests.length, 1);
  assert.deepEqual(usage, [null]);
});
