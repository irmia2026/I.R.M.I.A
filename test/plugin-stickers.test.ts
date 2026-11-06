import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { AfterCommitEventBus } from '../src/adapter/event-bus.ts';
import { AdapterSupervisor } from '../src/adapter/supervisor.ts';
// @ts-expect-error 纯 JS 纯函数模块（无 .d.ts，测试用 strip-types 直接跑）
import { keywordsOf, pickSticker, renderStickerLine } from '../plugins/builtin/linre-stickers/lib/picker.mjs';

const pluginRoot = resolve('plugins/builtin/linre-stickers');
const worker = resolve(pluginRoot, 'adapter-worker.mjs');
const skip = !existsSync(worker);

const CATALOG = [
  { id: 'happy', tags: ['开心', '好耶'], intensity: 3, status: 'approved', path: 'media/plugin/x/happy.png' },
  { id: 'pending-one', tags: ['开心'], intensity: 9, status: 'pending', path: 'media/plugin/x/p.png' },
  { id: 'tired', tags: ['累', '困'], intensity: 2, status: 'approved', path: 'media/plugin/x/tired.png' },
];

test('表情选择：只认 approved，pending 的强度再高也不选', () => {
  const picked = pickSticker(CATALOG, { keywords: ['开心'], nowMs: 1_000_000 });
  assert.equal(picked?.id, 'happy');
});

test('表情选择：没有标签交集就一个都不给', () => {
  assert.equal(pickSticker(CATALOG, { keywords: ['天气'], nowMs: 1_000_000 }), null);
});

test('表情选择：冷却期内不重复', () => {
  const catalog = [{ ...CATALOG[0], lastUsedMs: 1_000_000 }];
  assert.equal(pickSticker(catalog, { keywords: ['开心'], nowMs: 1_000_000 + 60_000 }), null);
  assert.equal(pickSticker(catalog, { keywords: ['开心'], nowMs: 1_000_000 + 21 * 60_000 })?.id, 'happy');
});

test('表情选择：命中标签多的优先，其次强度高的', () => {
  const catalog = [
    { id: 'a', tags: ['开心'], intensity: 5, status: 'approved', path: 'a' },
    { id: 'b', tags: ['开心', '好耶'], intensity: 1, status: 'approved', path: 'b' },
  ];
  assert.equal(pickSticker(catalog, { keywords: ['开心', '好耶'], nowMs: 1 })?.id, 'b');
});

test('注入行带得上 send_media 能认的相对路径，且不超字数', () => {
  const line = renderStickerLine({ id: 'happy', path: 'media/plugin/x/happy.png', tags: ['开心'] }, 90);
  assert.match(line, /send_media path=media\/plugin\/x\/happy\.png/u);
  assert.ok([...line].length <= 90);
  assert.equal(renderStickerLine(null), '');
});

test('关键词切分：中英数都留，标点当分隔', () => {
  assert.deepEqual(keywordsOf('好耶！happy 2026'), ['好耶', 'happy', '2026']);
});

test('表情插件：给出审核过的那张图，并让宿主落地示例素材', { skip }, async () => {
  const stored: Array<{ pluginId: string; params: unknown }> = [];
  const bus = new AfterCommitEventBus({ handlerTimeoutMs: 2_000 });
  const failures: unknown[] = [];
  const supervisor = new AdapterSupervisor({
    eventBus: bus,
    handshakeTimeoutMs: 5_000,
    requestTimeoutMs: 8_000,
    onAssetStore: async (spec, params) => {
      stored.push({ pluginId: spec.id, params });
      return { path: `media/plugin/${spec.id}/deadbeef.png`, sha256: 'deadbeef', bytes: 68 };
    },
    onFailure: (_id, error) => failures.push(error),
  });
  try {
    await supervisor.start([{
      id: 'linre-stickers',
      version: '0.1.0',
      contentHash: 'c'.repeat(64),
      worker,
      capabilities: ['event.observe', 'prompt.inject', 'asset.store'],
      cwd: pluginRoot,
    }]);
    assert.equal(supervisor.statuses()[0]?.state, 'ready');
    // 示例素材是握手后异步落地的，等它一拍
    await new Promise((done) => setTimeout(done, 150));
    assert.ok(stored.length >= 1, '启动时应把示例图交给宿主落地');

    bus.publishAfterCommit({
      seq: 3,
      ts: new Date().toISOString(),
      type: 'wake/message',
      data: { text: '今天好耶，开心！' },
      visibility: 'model' as const,
    });
    await new Promise((done) => setTimeout(done, 120));

    const rendered = await supervisor.request('linre-stickers', 'prompt/render', { slot: 'now-layer', maxChars: 90 });
    const text = (rendered as { text?: unknown }).text;
    assert.equal(typeof text, 'string');
    assert.match(text as string, /可以配图|可配图/u, `应给出候选，实际：${String(text)}`);
    assert.match(text as string, /send_media path=/u);
    assert.deepEqual(failures, []);

    // 冷却：紧接着再问一次，同一张图不该再出现
    const again = await supervisor.request('linre-stickers', 'prompt/render', { slot: 'now-layer', maxChars: 90 });
    assert.equal((again as { text: string }).text, '', '冷却期内不该再推荐同一张图');
  } finally {
    await supervisor.stop();
  }
});

test('表情插件：没有审核通过的图时保持沉默', { skip }, async () => {
  const supervisor = new AdapterSupervisor({
    eventBus: new AfterCommitEventBus({ handlerTimeoutMs: 2_000 }),
    handshakeTimeoutMs: 5_000,
    requestTimeoutMs: 8_000,
    onAssetStore: async () => ({ path: 'media/plugin/x/y.png' }),
  });
  try {
    await supervisor.start([{
      id: 'linre-stickers',
      version: '0.1.0',
      contentHash: 'c'.repeat(64),
      worker,
      capabilities: ['event.observe', 'prompt.inject'],
      cwd: pluginRoot,
    }]);
    await new Promise((done) => setTimeout(done, 120));
    const rendered = await supervisor.request('linre-stickers', 'prompt/render', { slot: 'now-layer', maxChars: 90 });
    assert.equal((rendered as { text: string }).text, '', '没有可发图时必须是空串，不能塞占位');
  } finally {
    await supervisor.stop();
  }
});
