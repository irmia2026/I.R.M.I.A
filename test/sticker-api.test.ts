import assert from 'node:assert/strict';
import { createHash, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent } from '../src/log/types.js';
import { defaultVisibility, emptyProjection } from '../src/log/types.ts';
import type { StickerPHasher } from '../src/stickers/phash.ts';
import { StickerService } from '../src/stickers/service.ts';
import { StickerStore } from '../src/stickers/store.ts';
import { StickerTagger } from '../src/stickers/tagger.ts';
import { applyOne, finalizePressure } from '../src/state/fold.ts';
import { AUTH_FILE_NAME, SCRYPT_PARAMS } from '../src/web/auth.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { pngBytes, stickerModelResponse } from './helpers/sticker-fixtures.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const TOKEN = 'sticker-api-test-token-0123456789';
const PASSWORD = 'sticker-api-test-password';
const SALT = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const HASH = scryptSync(PASSWORD, SALT, 32, { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p }).toString('hex');

async function rig(t: TestContext, withService = true, tagText = '', phash?: StickerPHasher) {
  const dir = tempDirSync('irmia-sticker-api-');
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), '{"schemaVersion":1}\n');
  writeFileSync(join(dataDir, AUTH_FILE_NAME), JSON.stringify({
    v: 1,
    scrypt: { salt: SALT.toString('hex'), ...SCRYPT_PARAMS },
    hash: HASH,
    sessions: [{ id: 'aabbccddeeff0011', hash: createHash('sha256').update(TOKEN).digest('hex'), createdAt: '2026-02-14T10:00:00.000Z', label: 'test' }],
  }));
  const log = await EventLog.open(join(dataDir, 'events'));
  const projection = emptyProjection();
  const config = defaultConfig(dataDir);
  const now = () => new Date('2026-02-14T10:00:00.000Z');
  const store = new StickerStore(dataDir, now);
  store.init();
  const modelCalls: unknown[] = [];
  const tagger = new StickerTagger({
    client: {
      generate: async (request) => {
        modelCalls.push(request);
        return stickerModelResponse(tagText || JSON.stringify({ tags: ['开心'], intensity: 'obvious', confidence: 0.96, note: '测试贴图', isSticker: true }));
      },
    },
    store,
    model: 'fake-light',
    emit: (type, data) => append(type, data),
  });
  const append = (type: string, data: unknown): AppEvent => {
    const event = { seq: log.nextSeq(), ts: now().toISOString(), type, data, visibility: defaultVisibility(type), origin: 'test/sticker-api' } as unknown as AppEvent;
    log.append(event, { sync: true });
    applyOne(projection, event);
    finalizePressure(projection, event.ts);
    return event;
  };
  const service = new StickerService({
    store, tagger, config: () => config, emit: append,
    phash: phash ?? (async (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16)),
  });
  const server: WebServer = await startWebServer({
    log, projection, config, personaRoot: join(dataDir, 'persona'), dataDir,
    timers: new TimerStore(join(dataDir, 'timers.json'), { now }), now,
    configPath: join(dir, 'config.json'), port: 0, uiToken: null,
    ...(withService ? { stickers: service } : {}), out: () => undefined,
  });
  t.after(async () => {
    await server.close();
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (method: string, path: string, body?: unknown, confirm?: string, auth = true) => {
    const response = await fetch(`${server.url()}${path}`, {
      method,
      headers: {
        ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(confirm === undefined ? {} : { 'x-confirm': confirm }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString('utf8');
    return { status: response.status, body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) as any : bytes };
  };
  const upload = async (bytes: Buffer = pngBytes()) =>
    (await call('POST', '/api/stickers', { mime: 'image/png', data: bytes.toString('base64') })).body;
  return { store, config, modelCalls, call, upload, dir };
}

test('API：列表、筛选、九标签计数与分页参数都走真实库存', async (t) => {
  const fx = await rig(t);
  const owner = fx.store.importSticker({ bytes: pngBytes(), mime: 'image/png', source: 'owner' });
  fx.store.applyTagging(owner.entry.id, { tags: ['开心'], intensity: 'obvious', confidence: 1, note: '' }, true);
  const collected = fx.store.importSticker({ bytes: pngBytes(2, 2), mime: 'image/png', source: 'collected' });
  const list = await fx.call('GET', '/api/stickers');
  assert.equal(list.status, 200);
  assert.equal(list.body.counts.approved, 1);
  assert.equal(list.body.counts.pending, 1);
  assert.equal(list.body.tags['开心'], 1);
  assert.equal(list.body.settings.harvestProbability, 0.15);
  assert.equal(list.body.settings.activeProbability, fx.config.stickers.activeProbability);
  assert.equal(list.body.settings.cooldownSeconds, fx.config.stickers.cooldownSeconds);
  fx.config.stickers.activeProbability = 0.42;
  fx.config.stickers.cooldownSeconds = 17;
  const refreshed = await fx.call('GET', '/api/stickers');
  assert.equal(refreshed.body.settings.activeProbability, 0.42);
  assert.equal(refreshed.body.settings.cooldownSeconds, 17);
  const filtered = await fx.call('GET', '/api/stickers?status=pending&source=collected');
  assert.deepEqual(filtered.body.items.map((item: any) => item.id), [collected.entry.id]);
  assert.equal(filtered.body.items[0].source, 'collected');
  const tags = await fx.call('GET', '/api/stickers/tags');
  assert.equal(tags.body.tags['开心'], 1);
  const bad = await fx.call('GET', '/api/stickers?page=1.5');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'invalid-sticker-page');
});

test('API：上传→视觉打标→待审预览；高置信也不绕过人工确认，重复上传不再打标', async (t) => {
  const fx = await rig(t);
  const first = await fx.upload();
  assert.equal(first.entry.status, 'pending');
  assert.deepEqual(first.entry.tags, ['开心']);
  assert.equal(first.entry.tagConfidence, 0.96);
  assert.equal(first.tagging.approved, false);
  assert.equal(first.tagging.reason, 'pending');
  assert.equal(first.duplicate, false);
  assert.equal(fx.modelCalls.length, 1);
  assert.ok(existsSync(fx.store.entryPath('owner-stickers', first.entry.file)));
  const second = await fx.upload();
  assert.equal(second.duplicate, true);
  assert.equal(second.tagging, null);
  assert.equal(fx.modelCalls.length, 1);
});

test('API：上传近重复 phash 被 duplicate 拒绝，不新增条目', async (t) => {
  let call = 0;
  const hashes = ['0000000000000000', '0000000000000001'];
  const fx = await rig(t, true, '', async () => hashes[Math.min(call++, 1)]!);
  const first = await fx.upload(pngBytes(10, 10));
  assert.equal(first.duplicate, false);
  const second = await fx.upload(pngBytes(20, 20));
  assert.equal(second.duplicate, true);
  assert.equal(second.entry.id, first.entry.id);
  assert.equal(fx.store.listEntries().length, 1);
});

test('API：上传非表情包 isSticker=false 返回 400 not-sticker，库里不新增', async (t) => {
  const fx = await rig(t, true,
    JSON.stringify({tags: ['开心'], intensity: 'obvious', confidence: 0.96, note: '截图', isSticker: false}));
  const response = await fx.call('POST', '/api/stickers', {
    mime: 'image/png', data: pngBytes().toString('base64'),
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'not-sticker');
  assert.match(response.body.error.message, /不是表情包/u);
  assert.equal(fx.store.listEntries().length, 0);
  assert.equal(fx.store.purgeRejected(), 0);
});

test('API：批准、改标签、拒绝与恢复都落人审事件', async (t) => {
  const fx = await rig(t);
  const uploaded = await fx.upload();
  const id = uploaded.entry.id as string;
  const approved = await fx.call('PATCH', `/api/stickers/${id}`, { tags: ['亲近'], intensity: 'strong', status: 'approved' });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.entry.status, 'approved');
  assert.deepEqual(approved.body.entry.tags, ['亲近']);
  assert.equal(approved.body.action, 'approve');
  const edited = await fx.call('PATCH', `/api/stickers/${id}`, { tags: ['开心', '亲近'] });
  assert.equal(edited.body.action, 'edit');
  assert.equal(edited.body.entry.status, 'approved');
  const rejected = await fx.call('PATCH', `/api/stickers/${id}`, { status: 'rejected' });
  assert.equal(rejected.body.entry.status, 'rejected');
  const restored = await fx.call('PATCH', `/api/stickers/${id}`, { status: 'approved' });
  assert.equal(restored.body.action, 'restore');
  const events = await fx.call('GET', '/api/stickers/events');
  assert.deepEqual(events.body.items.filter((event: any) => event.type === 'sticker/reviewed').map((event: any) => event.data.action), ['restore', 'reject', 'edit', 'approve']);
  assert.ok(events.body.items.every((event: any) => event.type.startsWith('sticker/')));
});

test('API：删除要 X-Confirm，物理清理只认已拒绝；全过程可撤销后再清理', async (t) => {
  const fx = await rig(t);
  const uploaded = await fx.upload();
  const id = uploaded.entry.id as string;
  await fx.call('PATCH', `/api/stickers/${id}`, { status: 'approved' });
  const denied = await fx.call('DELETE', `/api/stickers/${id}`);
  assert.equal(denied.status, 400);
  assert.equal(denied.body.error.code, 'confirm-required');
  assert.equal(fx.store.findById(id)?.entry.status, 'approved');
  const removed = await fx.call('DELETE', `/api/stickers/${id}`, undefined, 'sticker-delete');
  assert.equal(removed.body.status, 'rejected');
  const notReady = await fx.call('PATCH', `/api/stickers/${id}`, { status: 'approved' });
  assert.equal(notReady.body.entry.status, 'approved');
  const purgeDenied = await fx.call('DELETE', '/api/commands/stickers-purge', {}, 'sticker-delete');
  assert.equal(purgeDenied.body.error.code, 'confirm-required');
  await fx.call('DELETE', `/api/stickers/${id}`, undefined, 'sticker-delete');
  const purged = await fx.call('DELETE', '/api/commands/stickers-purge', { id }, 'stickers-purge');
  assert.deepEqual(purged.body, { count: 1, ids: [id] });
  assert.equal(fx.store.findById(id), null);
  assert.equal((await fx.call('GET', `/api/stickers/${id}`)).status, 404);
});

test('API：原图路由复用鉴权并返回正确 MIME；无凭据与坏 id 不泄露图片', async (t) => {
  const fx = await rig(t);
  const imported = fx.store.importSticker({ bytes: pngBytes(), mime: 'image/png', source: 'owner' });
  fx.store.applyTagging(imported.entry.id, { tags: ['开心'], intensity: 'obvious', confidence: 1, note: '' }, true);
  const image = await fx.call('GET', imported.entry ? `/api/stickers/${imported.entry.id}/image` : '/api/stickers/nope/image');
  assert.equal(image.status, 200);
  assert.equal(Buffer.from(image.body).equals(pngBytes()), true);
  const denied = await fx.call('GET', `/api/stickers/${imported.entry.id}/image`, undefined, undefined, false);
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error.code, 'unauthorized');
  assert.equal((await fx.call('GET', '/api/stickers/nope/image')).body.error.code, 'sticker-not-found');
});

test('API：非法型别、超尺寸与 8MB 上限在打标前拒绝', async (t) => {
  const fx = await rig(t);
  const type = await fx.call('POST', '/api/stickers', { mime: 'image/png', data: Buffer.from('not a png').toString('base64') });
  assert.equal(type.body.error.code, 'invalid-sticker-content');
  const dimensions = await fx.call('POST', '/api/stickers', { mime: 'image/png', data: pngBytes(1025, 1).toString('base64') });
  assert.equal(dimensions.body.error.code, 'sticker-dimensions-too-large');
  const large = await fx.call('POST', '/api/stickers', { mime: 'image/png', data: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') });
  assert.equal(large.status, 413);
  assert.equal(large.body.error.code, 'payload-too-large');
  assert.equal(fx.modelCalls.length, 0);
});

test('API：采收开关鉴权、写配置并明确是否仍需重启；贴纸事件不进通知', async (t) => {
  const fx = await rig(t);
  const denied = await fx.call('POST', '/api/commands/sticker-harvest', { enabled: false }, undefined, false);
  assert.equal(denied.status, 401);
  const saved = await fx.call('POST', '/api/commands/sticker-harvest', { enabled: false });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.enabled, false);
  assert.equal(saved.body.requiresRestart, true);
  const doc = JSON.parse(readFileSync(join(fx.dir, 'config.json'), 'utf8'));
  assert.equal(doc.stickers.harvest.enabled, false);
  assert.equal(doc.stickers.harvest.probability, undefined);
  const patched = await fx.call('PATCH', '/api/config', { fields: { 'stickers.harvest.probability': 0.25, 'stickers.enabled': false } }, 'config-update');
  assert.equal(patched.status, 200);
  const after = JSON.parse(readFileSync(join(fx.dir, 'config.json'), 'utf8'));
  assert.equal(after.stickers.harvest.probability, 0.25);
  assert.equal(after.stickers.enabled, false);
  const events = await fx.call('GET', '/api/stickers/events');
  assert.equal(events.body.items.some((event: any) => event.type.startsWith('wake/')), false);
});

test('API：未装配服务时报 501，不伪造空库存', async (t) => {
  const fx = await rig(t, false);
  const result = await fx.call('GET', '/api/stickers');
  assert.equal(result.status, 501);
  assert.equal(result.body.error.code, 'not-implemented');
});
