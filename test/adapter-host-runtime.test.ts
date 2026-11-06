import assert from 'node:assert/strict';
import test from 'node:test';
import type { Asset, AuditRecord, EffectProposal, MediaPort, PluginIdentity } from '../src/adapter/api.ts';
import { CapabilityBroker, InMemoryStoragePort } from '../src/adapter/capability-broker.ts';
import { EffectDispatcher } from '../src/adapter/effect-dispatcher.ts';

const plugin: PluginIdentity = { id: 'demo-adapter', version: '1.0.0', contentHash: 'hash-1' };

function proposal(key: string, capability = 'message.send', target = 'room-a'): EffectProposal {
  return {
    capability,
    sideEffect: 'destructive',
    intent: { target, idempotencyKey: key, parts: [{ type: 'text', text: 'hello' }] },
  };
}

function auditLog() {
  const records: AuditRecord[] = [];
  return { records, audit: { record: async (entry: AuditRecord) => { records.push(entry); } } };
}

test('broker enforces scope, expiry, quotas, storage isolation, and media resolver', async () => {
  const asset: Asset = { id: 'asset-1', kind: 'image', mediaType: 'image/png', bytes: 3 };
  const media: MediaPort = { resolve: async (ref) => ref === asset.id ? asset : null };
  const broker = new CapabilityBroker({
    plugin,
    now: () => Date.parse('2026-11-01T00:00:00Z'),
    grants: [{ capability: 'message.send', scope: ['room-a'], expiresAt: '2026-11-02T00:00:00Z', quota: { maxUses: 1, maxBytes: 4 } }],
    storageNamespace: 'demo',
    media,
  });

  assert.deepEqual(broker.check({ capability: 'message.send', scope: 'room-b' }), { ok: false, reason: 'scope-denied' });
  assert.equal((broker.check({ capability: 'message.send' })).ok, false);
  assert.equal((broker.authorize({ capability: 'message.send', scope: 'room-a', bytes: 3 })).ok, true);
  assert.deepEqual(await broker.media.resolve('asset-1'), asset);
  assert.equal((broker.authorize({ capability: 'message.send', scope: 'room-a', bytes: 1 })).ok, false);

  const source = new Uint8Array([1, 2, 3]);
  await broker.storage.set('images/item', source);
  source[0] = 9;
  const read = await broker.storage.get('images/item');
  assert.deepEqual(read, new Uint8Array([1, 2, 3]));
  read![1] = 8;
  assert.deepEqual(await broker.storage.get('images/item'), new Uint8Array([1, 2, 3]));
  assert.deepEqual(await broker.storage.list('images/'), ['images/item']);
  await assert.rejects(() => broker.storage.set('../escape', new Uint8Array(0)), /invalid storage key/);
});

test('dispatcher authorizes, audits, executes once per idempotency key, and returns rejection', async () => {
  const { records, audit } = auditLog();
  const broker = new CapabilityBroker({
    plugin,
    grants: [{ capability: 'message.send', scope: ['room-a'], quota: { maxUses: 1 } }],
    now: () => Date.parse('2026-11-01T00:00:00Z'),
  });
  let executions = 0;
  const dispatcher = new EffectDispatcher({
    broker,
    audit,
    executor: async () => { executions += 1; return { ok: true, effectId: 'effect-1' }; },
  });

  const first = await dispatcher.dispatch(proposal('same-key'));
  const duplicate = await dispatcher.dispatch(proposal('same-key'));
  const denied = await dispatcher.dispatch(proposal('other-key', 'message.delete'));
  assert.deepEqual(first, { ok: true, effectId: 'effect-1' });
  assert.deepEqual(duplicate, first);
  assert.deepEqual(denied, { ok: false, reason: 'capability-capability-denied' });
  assert.equal(executions, 1);
  assert.deepEqual(records.map(record => record.action), [
    'effect.accept', 'effect.complete', 'effect.duplicate', 'effect.reject',
  ]);
});

test('dispatcher refuses invalid intents before calling executor', async () => {
  const { records, audit } = auditLog();
  const broker = new CapabilityBroker({ plugin, grants: [{ capability: 'message.send' }] });
  let called = false;
  const dispatcher = new EffectDispatcher({
    broker,
    audit,
    executor: async () => { called = true; return { ok: true }; },
  });
  const invalid = await dispatcher.dispatch({
    capability: 'message.send', sideEffect: 'idempotent',
    intent: { target: '', idempotencyKey: 'invalid', parts: [] },
  });
  assert.deepEqual(invalid, { ok: false, reason: 'invalid-effect-intent' });
  assert.equal(called, false);
  assert.equal(records[0]?.action, 'effect.reject');
});

test('dispatcher converts executor exceptions into retryable failures and allows retry', async () => {
  const { audit } = auditLog();
  const broker = new CapabilityBroker({ plugin, grants: [{ capability: 'message.send' }] });
  let executions = 0;
  const dispatcher = new EffectDispatcher({
    broker,
    audit,
    executor: async () => { executions += 1; throw new Error('offline'); },
  });
  const first = await dispatcher.dispatch(proposal('failed'));
  const second = await dispatcher.dispatch(proposal('failed'));
  assert.deepEqual(first, { ok: false, reason: 'executor-error: offline', retryable: true });
  assert.deepEqual(second, first);
  assert.equal(executions, 2);
});

test('storage instances are isolated by namespace', async () => {
  const left = new InMemoryStoragePort({ namespace: 'left' });
  const right = new InMemoryStoragePort({ namespace: 'right' });
  await left.set('x', new Uint8Array([1]));
  assert.equal(await right.get('x'), null);
});
