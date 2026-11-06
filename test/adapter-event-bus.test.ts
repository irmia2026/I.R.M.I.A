import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AfterCommitEventBus } from '../src/adapter/event-bus.ts';
import type { EventView } from '../src/adapter/api.ts';

function event(type: string, value: number): EventView<{ value: number }> {
  return {
    seq: value,
    ts: new Date(0).toISOString(),
    type,
    data: { value },
    visibility: 'internal',
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('publishes after commit, filters by type, and delivers asynchronously in FIFO order', async () => {
  const bus = new AfterCommitEventBus({ queueLimit: 4 });
  const seen: number[] = [];
  bus.subscribe({
    types: ['message/created'],
    handler: (received) => {
      seen.push(received.data.value);
    },
  });

  const result = bus.publishAfterCommit(event('message/created', 1));
  assert.deepEqual(result, { matched: 1, queued: 1, dropped: 0 });
  assert.deepEqual(seen, [], 'handler must not run before publish returns');

  const ignored = bus.publishAfterCommit(event('message/updated', 2));
  assert.deepEqual(ignored, { matched: 0, queued: 0, dropped: 0 });
  await tick();
  assert.deepEqual(seen, [1]);
});

test('bounds each subscriber queue and reports dropped events', async () => {
  const bus = new AfterCommitEventBus({ queueLimit: 2 });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handle = bus.subscribeWithHandle({
    types: ['message/created'],
    handler: async () => {
      await blocked;
    },
  });

  bus.publishAfterCommit(event('message/created', 1));
  await Promise.resolve();
  bus.publishAfterCommit(event('message/created', 2));
  bus.publishAfterCommit(event('message/created', 3));
  const dropped = bus.publishAfterCommit(event('message/created', 4));
  assert.deepEqual(dropped, { matched: 1, queued: 0, dropped: 1 });
  assert.equal(handle.stats().dropped, 1);

  release();
  await tick();
  assert.equal(handle.stats().delivered, 3);
});

test('cancellation clears queued events and prevents later delivery', async () => {
  const bus = new AfterCommitEventBus({ queueLimit: 3 });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: number[] = [];
  const handle = bus.subscribeWithHandle({
    types: ['message/created'],
    handler: async (received) => {
      seen.push(received.data.value);
      await blocked;
    },
  });

  bus.publishAfterCommit(event('message/created', 1));
  await Promise.resolve();
  bus.publishAfterCommit(event('message/created', 2));
  bus.publishAfterCommit(event('message/created', 3));
  assert.deepEqual(handle.cancel(), { cancelled: true, dropped: 2 });
  assert.deepEqual(handle.stats(), {
    queued: 0,
    processing: true,
    delivered: 0,
    dropped: 2,
    failures: 0,
    cancelled: true,
  });

  release();
  await tick();
  assert.deepEqual(seen, [1]);
  assert.equal(handle.stats().delivered, 1);
  assert.deepEqual(handle.cancel(), { cancelled: false, dropped: 0 });
});
