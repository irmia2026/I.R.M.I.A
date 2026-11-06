import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { AfterCommitEventBus } from '../src/adapter/event-bus.ts';
import { AdapterSupervisor } from '../src/adapter/supervisor.ts';

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
