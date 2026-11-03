import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { checkForUpdate, UPDATE_MANIFEST_MAX_BYTES } from '../src/update/check.ts';
import { UpdateService, readUpdateState } from '../src/update/service.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const manifest = (channel: string, version: string): Response => new Response(JSON.stringify({channel, version, platforms: []}));
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return {promise, resolve};
}

for (const oldFirst of [true, false]) {
  test(`切换通道不复用或接受旧检查，旧请求${oldFirst ? '先' : '后'}结束`, async (t) => {
    const dir = tempDirSync('irmia-update-generation-');
    const beta = pending<Response>(), stable = pending<Response>();
    let calls = 0;
    const events: unknown[] = [];
    const service = new UpdateService({dataDir: dir, currentVersion: '1.0.0', enabled: true, channel: 'beta',
      endpoint: 'https://synthetic.invalid/version.json', emit: (_type, event) => { events.push(event); },
      fetchImpl: async () => ++calls === 1 ? beta.promise : stable.promise});
    t.after(() => { service.stop(); fs.rmSync(dir, {recursive: true, force: true}); });
    const old = service.checkNow({manual: true});
    const changed = service.applyChannel('stable');
    assert.equal(calls, 2);
    if (oldFirst) {
      beta.resolve(manifest('beta', '9.0.0-beta.1')); await old;
      assert.equal(service.view().status, 'unknown');
      assert.equal(events.length, 0);
    }
    const shared = service.checkNow({manual: true});
    assert.equal(calls, 2, '旧检查收尾不能清掉新检查的并发去重');
    stable.resolve(manifest('stable', '2.0.0'));
    await Promise.all([changed, shared]);
    if (!oldFirst) { beta.resolve(manifest('beta', '9.0.0-beta.1')); await old; }
    assert.equal(service.view().channel, 'stable');
    assert.equal(service.view().latestVersion, '2.0.0');
    assert.equal(service.view().status, 'available');
    assert.equal(events.length, 1);
    const persisted = readUpdateState(join(dir, 'update-state.json'));
    assert.equal(persisted.channel, 'stable'); assert.equal(persisted.latestVersion, '2.0.0');
  });
}

const check = (fetchImpl: typeof fetch, timeoutMs = 1000) => checkForUpdate({
  currentVersion: '1.0.0', channel: 'stable', endpoint: 'https://synthetic.invalid/version.json', fetchImpl, timeoutMs,
});

test('更新清单超限时立即取消流，不读取剩余正文', async () => {
  let supplied = 0, cancelled = false;
  const chunkSize = 64 * 1024;
  const result = await check(async () => new Response(new ReadableStream({
    pull(controller) { supplied += chunkSize; controller.enqueue(new Uint8Array(chunkSize).fill(32)); },
    cancel() { cancelled = true; },
  })));
  assert.equal(result.reason, 'too-large');
  assert.equal(cancelled, true);
  assert.ok(supplied <= UPDATE_MANIFEST_MAX_BYTES + 2 * chunkSize);
});

test('更新清单按 UTF-8 字节限额，不按字符串长度', async () => {
  const text = JSON.stringify({pad: '界'.repeat(Math.floor(UPDATE_MANIFEST_MAX_BYTES / 3))});
  assert.ok(text.length < UPDATE_MANIFEST_MAX_BYTES);
  assert.ok(Buffer.byteLength(text) > UPDATE_MANIFEST_MAX_BYTES);
  assert.equal((await check(async () => new Response(text))).reason, 'too-large');
});

test('Content-Length 超限时不取得 reader，取消响应体', async () => {
  let cancelled = false;
  const response = {
    ok: true, headers: new Headers({'content-length': String(UPDATE_MANIFEST_MAX_BYTES + 1)}),
    body: {getReader() { assert.fail('oversized response must not be read'); }, async cancel() { cancelled = true; }},
  } as unknown as Response;
  assert.equal((await check(async () => response)).reason, 'too-large');
  assert.equal(cancelled, true);
});

test('更新正文读到一半停止，期限覆盖 reader 并取消流', async () => {
  let cancelled = false;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const result = await check(async () => new Response(new ReadableStream({
      pull() { return new Promise(() => {}); }, cancel() { cancelled = true; },
    })), 25);
    assert.equal(result.reason, 'timeout'); assert.equal(cancelled, true);
  } finally { clearTimeout(keepAlive); }
});
