import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { join, resolve } from 'node:path';
import { AfterCommitEventBus } from '../src/adapter/event-bus.ts';
import { AdapterSupervisor, adapterEventView } from '../src/adapter/supervisor.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const memeWorker = resolve('C:/Users/admin/Projects/linre-meme-photo/adapter-worker.mjs');

test('supervisor handshakes with meme worker and rejects direct effects', { skip: !existsSync(memeWorker) }, async () => {
  const bus = new AfterCommitEventBus({ handlerTimeoutMs: 2_000 });
  const failures: unknown[] = [];
  const supervisor = new AdapterSupervisor({
    eventBus: bus,
    handshakeTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    onFailure: (_id, error) => failures.push(error),
  });
  await supervisor.start([{
    id: 'linre-meme-photo',
    version: '0.1.0',
    contentHash: 'a'.repeat(64),
    worker: memeWorker,
    capabilities: ['event.observe', 'asset.resolve', 'storage.kv', 'message.propose'],
    cwd: resolve('C:/Users/admin/Projects/linre-meme-photo'),
  }]);
  assert.equal(supervisor.statuses()[0]?.state, 'ready');
  await assert.rejects(
    supervisor.request('linre-meme-photo', 'send_meme', { assetId: 'x' }),
    /Direct effects are not permitted/,
  );
  assert.deepEqual(failures, []);
  await supervisor.stop();
  assert.deepEqual(supervisor.statuses(), []);
});

test('adapterEventView forwards channel/message as model-visible and replaces attachment url with attachmentId', () => {
  const url = 'https://example.com/sticker.png?token=secret';
  const expectedId = createHash('sha256').update(url, 'utf8').digest('hex');

  const msgView = adapterEventView({
    seq: 10,
    ts: '2026-11-06T00:00:00.000Z',
    type: 'channel/message',
    visibility: 'internal',
    data: {
      channel: 'onebot',
      chatType: 'group',
      chatId: 'G1',
      person: '12345',
      text: 'hi',
      token: 'should-be-stripped',
      attachments: [
        { type: 'image', name: 'cat.png', url: ` ${url} `, text: 'meme' },
        { type: 'file', path: 'C:/secret.txt' },
      ],
    },
  });
  assert.ok(msgView !== null);
  assert.equal(msgView.visibility, 'model');
  const data = msgView.data as Record<string, unknown>;
  assert.equal('token' in data, false);
  const attachments = data['attachments'] as Array<Record<string, unknown>>;
  assert.deepEqual(attachments, [
    { type: 'image', name: 'cat.png', text: 'meme', attachmentId: expectedId },
    { type: 'file' },
  ]);

  const otherInternal = adapterEventView({
    seq: 11,
    ts: '2026-11-06T00:00:01.000Z',
    type: 'budget/consumed',
    visibility: 'internal',
    data: { tokens: 100 },
  });
  assert.equal(otherInternal, null);
});

test('AdapterSupervisor gates media/resolve by asset.resolve and passes config in initialize', async (t) => {
  const dir = tempDirSync('irmia-adapter-resolve-');
  const workerFile = join(dir, 'worker.mjs');
  writeFileSync(workerFile, `
import readline from 'node:readline';
let initConfig = null;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('close', () => process.exit(0));
const pending = new Map();
let seq = 1;
function callHost(method, params) {
  const id = 'w:' + (seq++);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
  });
}
rl.on('line', async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && msg.method === undefined) {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
    else entry.resolve(msg.result);
    return;
  }
  if (msg.method === 'initialize') {
    initConfig = msg.params.config ?? null;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }) + '\\n');
    return;
  }
  if (msg.method === 'test/get-config') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: initConfig }) + '\\n');
    return;
  }
  if (msg.method === 'test/resolve') {
    try {
      const res = await callHost('media/resolve', msg.params);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: res }) + '\\n');
    } catch (err) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { errorCode: err.code, errorMessage: err.message } }) + '\\n');
    }
  }
});
`, 'utf8');

  const bus = new AfterCommitEventBus({ handlerTimeoutMs: 2_000 });
  const resolveCalls: Array<{ id: string; params: unknown }> = [];
  const supervisor = new AdapterSupervisor({
    eventBus: bus,
    handshakeTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    onAssetResolve: async (spec, params) => {
      resolveCalls.push({ id: spec.id, params });
      return { ok: true, sha256: 'abc', mimeType: 'image/png', sizeBytes: 4, path: '/tmp/abc.png', mediaUrl: '/api/media/stickers/abc.png', dataBase64: 'AAAA' };
    },
  });
  t.after(async () => {
    await supervisor.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  await supervisor.start([
    {
      id: 'no-cap',
      version: '1.0.0',
      contentHash: '1'.repeat(64),
      worker: workerFile,
      capabilities: ['event.observe'],
      cwd: dir,
      config: { dataDir: dir, ownerIds: ['10001'] },
    },
    {
      id: 'with-cap',
      version: '1.0.0',
      contentHash: '2'.repeat(64),
      worker: workerFile,
      capabilities: ['event.observe', 'asset.resolve'],
      cwd: dir,
      config: { dataDir: dir, ownerIds: ['10001', 'openid-a'] },
    },
  ]);

  const initCfg = await supervisor.request('with-cap', 'test/get-config');
  assert.deepEqual(initCfg, { dataDir: dir, ownerIds: ['10001', 'openid-a'] });

  const denied = await supervisor.request('no-cap', 'test/resolve', { attachmentId: 'x' });
  assert.deepEqual(denied, { errorCode: -32003, errorMessage: 'media/resolve 需要能力 asset.resolve' });
  assert.equal(resolveCalls.length, 0);

  const allowed = await supervisor.request('with-cap', 'test/resolve', { attachmentId: 'deadbeef' });
  assert.deepEqual(allowed, {
    ok: true,
    sha256: 'abc',
    mimeType: 'image/png',
    sizeBytes: 4,
    path: '/tmp/abc.png',
    mediaUrl: '/api/media/stickers/abc.png',
    dataBase64: 'AAAA',
  });
  assert.deepEqual(resolveCalls, [{ id: 'with-cap', params: { attachmentId: 'deadbeef' } }]);
});
