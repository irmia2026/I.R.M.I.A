import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { StickerRuntime } from '../src/stickers/runtime.ts';
import { withStickerSpeak } from '../src/stickers/speak.ts';
import { StickerStore } from '../src/stickers/store.ts';
import { STICKER_TAGS } from '../src/stickers/types.ts';
import type { MediaRequest, ReplyOutcome } from '../src/tools/admin.js';
import { okResult, type ToolDefinition } from '../src/tools/types.ts';
import { pngBytes } from './helpers/sticker-fixtures.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

function rig(t: TestContext, options: { mediaFail?: boolean } = {}) {
  const dir = tempDirSync('irmia-sticker-speak-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new StickerStore(dir, () => new Date('2026-10-31T04:00:00.000Z'));
  store.init();
  const imported = store.importSticker({ bytes: pngBytes(), mime: 'image/png', source: 'owner' });
  store.applyTagging(imported.entry.id, { tags: ['开心'], intensity: 'obvious', confidence: 1, note: '' }, true);
  const calls: string[] = [];
  const posts: Array<{ url: string; media: MediaRequest }> = [];
  const events: Array<{ type: string; data: unknown }> = [];
  const runtime = new StickerRuntime({
    store,
    config: () => defaultConfig(dir),
    affect: () => initialAffectForTest(),
    mediaPoster: {
      post: async (target, media) => {
        posts.push({ url: target.url, media });
        if (options.mediaFail === true) return { ok: false, reason: '测试：媒体投递失败' } as ReplyOutcome;
        return { ok: true, messageId: 'm1' } as ReplyOutcome;
      },
    },
    emit: (type, data) => events.push({ type, data }),
    random: () => 0,
  });
  const base: ToolDefinition = {
    name: 'speak',
    description: '跟人说话',
    parameters: { type: 'object', properties: {}, required: ['text'] },
    handler: async (args) => {
      calls.push(typeof args['text'] === 'string' ? args['text'] : '');
      return okResult('text-sent');
    },
  };
  const current = {
    channel: 'onebot', chatType: 'c2c' as const, chatId: 'owner', person: 'owner',
    text: '', messageId: 'm0', msgSeq: 1,
  };
  const tool = withStickerSpeak(base, runtime, () => current);
  return { tool, calls, posts, events, id: imported.entry.id };
}

function initialAffectForTest() {
  return {
    version: 3 as const,
    atMs: 0,
    mood: { valence: 0.2, arousal: 0.35 },
    emotions: { joy: 0, distress: 0, concern: 0, irritation: 0, warmth: 0, shyness: 0 },
    evaluated: { version: 1 as const, chunks: [] },
    causes: [],
  };
}

test('speak schema：九标签与两个可选参数齐全，text 不再强制', (t) => {
  const { tool } = rig(t);
  assert.deepEqual(tool.parameters.required, []);
  assert.deepEqual(tool.parameters.properties['sticker']?.['enum'], STICKER_TAGS);
  assert.deepEqual(tool.parameters.properties['stickerPos']?.['enum'], ['after', 'before', 'only']);
  assert.match(tool.description, /sticker/u);
});

test('speak after：先发文字再发图', async (t) => {
  const { tool, calls, posts, events, id } = rig(t);
  await tool.handler({ text: '在呢', sticker: '开心' }, { turn: 1 });
  assert.deepEqual(calls, ['在呢']);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.media.fileType, 1);
  assert.equal(posts[0]?.url, 'onebot:c2c:owner');
  assert.ok(events.some((event) => event.type === 'sticker/sent' && (event.data as { stickerId: string }).stickerId === id));
});

test('speak before：先发图再发文字', async (t) => {
  const { tool, calls, posts } = rig(t);
  await tool.handler({ text: '在呢', sticker: '开心', stickerPos: 'before' }, { turn: 1 });
  assert.equal(posts.length, 1);
  assert.deepEqual(calls, ['在呢']);
});

test('speak only / 空文本：只发图，成功回执明确说发了', async (t) => {
  const { tool, calls, posts } = rig(t);
  const result = await tool.handler({ text: '', sticker: '开心', stickerPos: 'only' }, { turn: 1 });
  assert.equal(calls.length, 0);
  assert.equal(posts.length, 1);
  assert.equal(result.content, '（已发一张表情包）');
  assert.notEqual(result.isError, true);
});

test('speak 未知标签：文字照发、图跳过并留 unknown-tag，回执末尾说明没发', async (t) => {
  const { tool, calls, posts, events } = rig(t);
  const result = await tool.handler({ text: '在呢', sticker: '期待' }, { turn: 1 });
  assert.deepEqual(calls, ['在呢']);
  assert.equal(posts.length, 0);
  assert.ok(events.some((event) => event.type === 'sticker/unknown-tag' && (event.data as { tag: string }).tag === '期待'));
  assert.equal(result.content, 'text-sent\n（表情包没发：没有这个表情标签）');
});

test('speak 群聊 disabled + 只发图：回执明确说没发，不设 isError', async (t) => {
  const { tool, calls, posts } = rig(t);
  const result = await tool.handler({
    sticker: '开心', stickerPos: 'only', to: 'qq:group:123',
  }, { turn: 1 });
  assert.equal(calls.length, 0);
  assert.equal(posts.length, 0);
  assert.notEqual(result.isError, true);
  assert.equal(result.content, '（表情包没发：这个会话没开表情包（群聊默认关闭））');
});

test('speak 群聊 disabled + 带文字：文字照发，回执末尾追加没发说明', async (t) => {
  const { tool, calls, posts } = rig(t);
  const result = await tool.handler({
    text: '在呢', sticker: '开心', to: 'qq:group:123',
  }, { turn: 1 });
  assert.deepEqual(calls, ['在呢']);
  assert.equal(posts.length, 0);
  assert.notEqual(result.isError, true);
  assert.equal(result.content, 'text-sent\n（表情包没发：这个会话没开表情包（群聊默认关闭））');
});

test('speak 媒体投递失败 + 只发图：回执明确说没发', async (t) => {
  const { tool, posts, events } = rig(t, { mediaFail: true });
  const result = await tool.handler({ sticker: '开心', stickerPos: 'only' }, { turn: 1 });
  assert.equal(posts.length, 1, '媒体投递确实尝试过');
  assert.notEqual(result.isError, true);
  assert.equal(result.content, '（表情包没发：这条通道不支持发图，或发送失败）');
  assert.ok(events.some((event) => event.type === 'sticker/skipped' && (event.data as { reason: string }).reason === 'media-failed'));
});

test('speak 媒体投递失败 + 带文字：文字照发，回执末尾追加失败说明', async (t) => {
  const { tool, calls, posts } = rig(t, { mediaFail: true });
  const result = await tool.handler({ text: '在呢', sticker: '开心' }, { turn: 1 });
  assert.deepEqual(calls, ['在呢']);
  assert.equal(posts.length, 1);
  assert.notEqual(result.isError, true);
  assert.equal(result.content, 'text-sent\n（表情包没发：这条通道不支持发图，或发送失败）');
});

test('speak 标签没有候选：只发图时回执说明库里没有', async (t) => {
  const { tool, posts } = rig(t);
  const result = await tool.handler({ sticker: '难过', stickerPos: 'only' }, { turn: 1 });
  assert.equal(posts.length, 0);
  assert.equal(result.content, '（表情包没发：库里没有这个标签的表情）');
});

test('speak 同一轮第二次不再发图，但文字照常', async (t) => {
  const { tool, calls, posts } = rig(t);
  await tool.handler({ text: '第一句', sticker: '开心' }, { turn: 1 });
  const second = await tool.handler({ text: '第二句', sticker: '开心' }, { turn: 1 });
  assert.deepEqual(calls, ['第一句', '第二句']);
  assert.equal(posts.length, 1);
  assert.equal(second.content, 'text-sent\n（表情包没发：这一轮已经发过一张表情了）');
});
