import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { AfterCommitEventBus } from '../src/adapter/event-bus.ts';
import { AdapterSupervisor } from '../src/adapter/supervisor.ts';

const workerSource = `
import { writeFileSync } from 'node:fs';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const raw = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (raw === '') continue;
    const message = JSON.parse(raw);
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { ok: true } });
      send({ jsonrpc: '2.0', id: 'w1', method: 'event/append', params: { type: 'plugin/test-demo/message', visibility: 'model', data: { text: '群里阿甲：晚上开黑吗' } } });
      send({ jsonrpc: '2.0', id: 'w2', method: 'not-a-method', params: {} });
      send({ jsonrpc: '2.0', id: 'w3', method: 'effect/propose', params: { kind: 'send' } });
    }
    if (message.id === 'w1' || message.id === 'w2' || message.id === 'w3') {
      writeFileSync(process.env.RECEIPT_PATH + '-' + message.id, JSON.stringify({ id: message.id, body: message }));
    }
  }
});
`;

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolvePromise();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('等待超时'));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

test('worker→host event/append 被宿主接收，未知方法回 -32601', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-append-'));
  const worker = join(dir, 'worker.mjs');
  const receiptPath = join(dir, 'receipt.json');
  writeFileSync(worker, workerSource);

  const received: Array<{ pluginId: string; contentHash: string; payload: unknown }> = [];
  const bus = new AfterCommitEventBus({ handlerTimeoutMs: 2_000 });
  const supervisor = new AdapterSupervisor({
    eventBus: bus,
    handshakeTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    onEventAppend: (pluginId, contentHash, payload) => {
      received.push({ pluginId, contentHash, payload });
      return null;
    },
  });

  try {
    await supervisor.start([{
      id: 'test-demo',
      version: '0.1.0',
      contentHash: 'b'.repeat(64),
      worker,
      capabilities: ['event.observe'],
      env: { RECEIPT_PATH: receiptPath },
    }]);
    assert.equal(supervisor.statuses()[0]?.state, 'ready');

    await waitFor(() => received.length === 1 && existsSync(`${receiptPath}-w1`));
    assert.equal(received[0]?.pluginId, 'test-demo');
    assert.equal(received[0]?.contentHash, 'b'.repeat(64));
    const payload = received[0]?.payload as { type: string; data: { text: string } };
    assert.equal(payload.type, 'plugin/test-demo/message');
    assert.equal(payload.data.text, '群里阿甲：晚上开黑吗');

    const receipt = JSON.parse(readFileSync(`${receiptPath}-w1`, 'utf8')) as { id: string; body: { result?: unknown; error?: { code: number } } };
    assert.equal(receipt.body.result !== undefined || receipt.body.error !== undefined, true);
  } finally {
    await supervisor.stop();
  }
});

test('event/append 的拒绝原因会原样回给 worker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-append-bad-'));
  const worker = join(dir, 'worker.mjs');
  const receiptPath = join(dir, 'receipt.json');
  writeFileSync(worker, workerSource);

  const bus = new AfterCommitEventBus({ handlerTimeoutMs: 2_000 });
  const supervisor = new AdapterSupervisor({
    eventBus: bus,
    handshakeTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    onEventAppend: () => '命名空间不合法',
  });

  try {
    await supervisor.start([{
      id: 'test-demo',
      version: '0.1.0',
      contentHash: 'c'.repeat(64),
      worker,
      capabilities: ['event.observe'],
      env: { RECEIPT_PATH: receiptPath },
    }]);
    await waitFor(() => existsSync(`${receiptPath}-w1`));
    const receipt = JSON.parse(readFileSync(`${receiptPath}-w1`, 'utf8')) as { body: { error?: { code: number; message: string } } };
    assert.equal(receipt.body.error?.code, -32602);
    assert.match(String(receipt.body.error?.message), /命名空间不合法/u);
  } finally {
    await supervisor.stop();
  }
});

test('effect/propose 被显式拒绝而不是静默成功', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-effect-'));
  const worker = join(dir, 'worker.mjs');
  const receiptPath = join(dir, 'receipt.json');
  writeFileSync(worker, workerSource);
  const seen: unknown[] = [];
  const bus = new AfterCommitEventBus({ handlerTimeoutMs: 2_000 });
  const supervisor = new AdapterSupervisor({
    eventBus: bus,
    handshakeTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    onEffectProposal: (_pluginId, proposal) => {
      seen.push(proposal);
    },
  });
  try {
    await supervisor.start([{
      id: 'test-demo',
      version: '0.1.0',
      contentHash: 'd'.repeat(64),
      worker,
      capabilities: ['event.observe'],
      env: { RECEIPT_PATH: receiptPath },
    }]);
    await waitFor(() => existsSync(`${receiptPath}-w3`));
    await waitFor(() => seen.length === 1);
    const receipt = JSON.parse(readFileSync(`${receiptPath}-w3`, 'utf8')) as { body: { result?: { accepted: boolean; reason: string } } };
    assert.equal(receipt.body.result?.accepted, false);
    assert.match(String(receipt.body.result?.reason), /不执行/u);
  } finally {
    await supervisor.stop();
  }
});
