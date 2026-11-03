import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test, { type TestContext } from 'node:test';

import { applyAppraised, initialAffect, makeAppraisedData } from '../src/affect/engine.ts';
import { defaultConfig } from '../src/config/config.ts';
import { StickerRuntime } from '../src/stickers/runtime.ts';
import { StickerStore } from '../src/stickers/store.ts';
import type { AffectState } from '../src/affect/types.js';
import type { MediaRequest, ReplyOutcome } from '../src/tools/admin.js';
import { pngBytes } from './helpers/sticker-fixtures.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

function rig(t: TestContext, options: { affect?: boolean; media?: boolean; state?: AffectState; random?: () => number; now?: () => Date } = {}) {
  const dir = tempDirSync('irmia-sticker-runtime-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = options.now ?? (() => new Date('2026-10-31T04:00:00.000Z'));
  const store = new StickerStore(dir, now);
  store.init();
  const imported = store.importSticker({ bytes: pngBytes(), mime: 'image/png', source: 'owner' });
  store.applyTagging(imported.entry.id, { tags: ['开心'], intensity: 'obvious', confidence: 1, note: '' }, true);
  const config = defaultConfig(dir);
  config.stickers.minTurnsBetween = 4;
  if (options.affect === true) config.affect.enabled = true;
  const posts: MediaRequest[] = [];
  const events: Array<{ type: string; data: unknown }> = [];
  const runtime = new StickerRuntime({
    store,
    config: () => config,
    affect: () => options.state ?? initialAffect(),
    mediaPoster: options.media === false ? undefined : {
      post: async (_target, media) => {
        posts.push(media);
        return { ok: true, messageId: `m${posts.length}` } as ReplyOutcome;
      },
    },
    emit: (type, data) => events.push({ type, data }),
    random: options.random ?? (() => 0),
    now,
  });
  return { store, config, runtime, posts, events, id: imported.entry.id };
}

function joyful(reasonCode: 'owner_success' | 'owner_setback'): AffectState {
  const evaluatedAtMs = Date.parse('2026-10-31T04:00:00.000Z');
  const event = makeAppraisedData({
    sourceSeq: 100, evaluatedAtMs, sourceWeight: 1,
    appraisal: { r: 1, s: 1, u: 0, g: 0, b: 0, n: 0, z: 0.2, c: 0.2, q: 1 }, reasonCode,
  });
  return applyAppraised(initialAffect(), {
    ...event,
    impulse: { joy: 0.8, distress: 0, concern: 0, irritation: 0, warmth: 0, shyness: 0 },
  });
}

async function passive(runtime: StickerRuntime, turn = 5, toolFailure = false): Promise<boolean> {
  return await runtime.passive({
    turn, chatType: 'c2c', channel: 'onebot', toolFailure,
    target: { url: 'onebot:c2c:owner', idempotencyKey: `passive-${turn}` },
  });
}

test('active：主动选图、发送与事件；同一轮至多一张', async (t) => {
  const { runtime, posts, events, id } = rig(t);
  const selection = runtime.active(1, 'c2c', 'onebot', '开心')!;
  assert.equal(selection.entry.id, id);
  assert.ok(await runtime.deliver({ ...selection, source: 'active', turn: 1, position: 'after', target: { url: 'onebot:c2c:owner', idempotencyKey: 'a' } }));
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.fileType, 1);
  assert.equal(runtime.active(1, 'c2c', 'onebot', '开心'), null);
  const sent = events.find((event) => event.type === 'sticker/sent');
  assert.deepEqual(sent?.data, {
    source: 'active', tag: '开心', stickerId: id, position: 'after', dice: 0, candidates: [id],
  });
});

test('activeProbability：0 永不、1 放行、0.5 固定 random 边界', async (t) => {
  const zero = rig(t, {random: () => 0});
  zero.config.stickers.activeProbability = 0;
  assert.equal(zero.runtime.active(1, 'c2c', 'onebot', '开心'), null);
  assert.ok(zero.events.some((event) => event.type === 'sticker/skipped'
    && (event.data as {reason: string}).reason === 'dice'));

  const one = rig(t, {random: () => 0.999});
  one.config.stickers.activeProbability = 1;
  assert.ok(one.runtime.active(1, 'c2c', 'onebot', '开心') !== null);

  const boundary = rig(t, {random: () => 0.5});
  boundary.config.stickers.activeProbability = 0.5;
  assert.equal(boundary.runtime.active(1, 'c2c', 'onebot', '开心'), null, '[0, p) 语义：0.5 不过');

  const below = rig(t, {random: () => 0.499});
  below.config.stickers.activeProbability = 0.5;
  assert.ok(below.runtime.active(1, 'c2c', 'onebot', '开心') !== null);
});

test('cooldownSeconds：全局门 29 秒拒绝、31 秒放行，主动与被动都受控', async (t) => {
  const base = new Date('2026-10-31T04:00:00.000Z');
  const recent = rig(t, {now: () => new Date(base.getTime() + 29_000)});
  recent.config.stickers.cooldownSeconds = 30;
  const recentState = recent.store.readState(); recentState.sent = [{stickerId: recent.id, atMs: base.getTime()}]; recent.store.writeState(recentState);
  assert.equal(recent.runtime.active(1, 'c2c', 'onebot', '开心'), null);
  assert.ok(recent.events.some((event) => event.type === 'sticker/skipped'
    && (event.data as {reason: string}).reason === 'cooldown'));
  assert.equal(await passive(recent.runtime, 2), false);
  assert.ok(recent.events.some((event) => event.type === 'sticker/skipped'
    && (event.data as {reason: string}).reason === 'cooldown'));

  const later = rig(t, {now: () => new Date(base.getTime() + 31_000)});
  later.config.stickers.cooldownSeconds = 30;
  const laterState = later.store.readState(); laterState.sent = [{stickerId: later.id, atMs: base.getTime()}]; later.store.writeState(laterState);
  assert.ok(later.runtime.active(1, 'c2c', 'onebot', '开心') !== null);
});

test('active：四个失败出口各回调一次 onSkip 原因；成功不回调', async (t) => {
  const { runtime } = rig(t);
  const reasons: string[] = [];
  const onSkip = (reason: string): void => { reasons.push(reason); };

  const selection = runtime.active(1, 'c2c', 'onebot', '开心', onSkip);
  assert.ok(selection !== null);
  await runtime.deliver({
    ...selection, source: 'active', turn: 1, position: 'after',
    target: { url: 'onebot:c2c:owner', idempotencyKey: 'a' },
  });
  assert.equal(runtime.active(1, 'c2c', 'onebot', '开心', onSkip), null);
  assert.equal(runtime.active(2, 'group', 'onebot', '开心', onSkip), null);
  assert.equal(runtime.active(3, 'c2c', 'onebot', '期待', onSkip), null);
  assert.equal(runtime.active(4, 'c2c', 'onebot', '难过', onSkip), null);

  assert.deepEqual(reasons, ['turn-cap', 'disabled', 'unknown-tag', 'no-candidates']);
});

test('active：未知标签话照发路径不选图；群聊默认关、私聊开', (t) => {
  const { runtime, posts, events } = rig(t);
  assert.equal(runtime.active(1, 'c2c', 'onebot', '期待'), null);
  assert.ok(events.some((event) => event.type === 'sticker/unknown-tag'));
  assert.equal(runtime.active(1, 'group', 'onebot', '开心'), null);
  assert.equal(posts.length, 0);
  assert.ok(runtime.active(1, 'c2c', 'onebot', '开心') !== null);
});

test('deliver：通道不支持或媒体失败不记 sent，也不虚报成功', async (t) => {
  const { store, runtime, posts, events, id } = rig(t, { media: false });
  const selection = runtime.active(1, 'c2c', 'onebot', '开心')!;
  const ok = await runtime.deliver({ ...selection, source: 'active', turn: 1, position: 'only', target: null });
  assert.equal(ok, false);
  assert.equal(posts.length, 0);
  assert.equal(store.findById(id)?.entry.stats.sent, 0);
  assert.ok(events.some((event) => event.type === 'sticker/skipped' && (event.data as { reason: string }).reason === 'channel-unsupported'));
});

test('passive：情绪关闭时不补图；主动不依赖情绪', async (t) => {
  const { runtime, posts, events } = rig(t);
  assert.equal(await runtime.passive({ turn: 5, chatType: 'c2c', channel: 'onebot', target: null, toolFailure: false }), false);
  assert.ok(events.some((event) => event.type === 'sticker/skipped' && (event.data as { reason: string }).reason === 'affect-disabled'));
  assert.ok(runtime.active(1, 'c2c', 'onebot', '开心') !== null);
  assert.equal(posts.length, 0);
});

test('passive：高情绪且冷却满足才补图，事件带骰子、候选与情绪快照', async (t) => {
  const { runtime, posts, events, id } = rig(t, { affect: true, state: joyful('owner_success') });
  assert.equal(await passive(runtime), true);
  assert.equal(posts.length, 1);
  assert.deepEqual(events.find((event) => event.type === 'sticker/sent')?.data, {
    source: 'passive', tag: '开心', stickerId: id, position: 'after', dice: 0,
    affect: { dominant: 'joy', value: 0.8 }, candidates: [id],
  });
  assert.equal(await passive(runtime), false, '同一轮主动或被动已经发过，不能重复补图');
  assert.equal(posts.length, 1);
});

test('passive：冷却跨重启保留，历史里连续不足四轮不发', async (t) => {
  const { store, runtime, posts, events } = rig(t, { affect: true, state: joyful('owner_success') });
  const state = store.readState();
  state.lastStickerTurn = 4;
  store.writeState(state);
  assert.equal(await passive(runtime), false);
  assert.equal(posts.length, 0);
  assert.ok(events.some((event) => event.type === 'sticker/skipped' && (event.data as { reason: string }).reason === 'cooldown'));
});

test('passive：本轮工具失败与 owner_setback 原因都严肃收敛', async (t) => {
  const failed = rig(t, { affect: true, state: joyful('owner_success') });
  assert.equal(await passive(failed.runtime, 5, true), false);
  assert.equal(failed.posts.length, 0);
  assert.ok(failed.events.some((event) => event.type === 'sticker/skipped' && (event.data as { reason: string }).reason === 'serious-context'));
  const setback = rig(t, { affect: true, state: joyful('owner_setback') });
  assert.equal(await passive(setback.runtime), false);
  assert.equal(setback.posts.length, 0);
});

test('passive：低情绪、骰子未命中都不发，阈值不做放宽', async (t) => {
  const low = rig(t, { affect: true });
  assert.equal(await passive(low.runtime), false);
  assert.ok(low.events.some((event) => event.type === 'sticker/skipped' && (event.data as { reason: string }).reason === 'affect-too-low'));
  const dice = rig(t, { affect: true, state: joyful('owner_success'), random: () => 0.12 });
  assert.equal(await passive(dice.runtime), false);
  assert.ok(dice.events.some((event) => event.type === 'sticker/skipped' && (event.data as { reason: string }).reason === 'dice'));
});
