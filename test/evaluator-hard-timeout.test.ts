/**
 * 兜底超时：provider 的 fetch 不响应 abort 时，评价器也不许把 turn 永久挂住。
 * 现场：turn 卡在 step/start 之前，模型连接一直 Established，watchdog 只报警、/stop 也清不掉。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateCandidate } from '../src/affect/evaluator.ts';
import { evaluateIntimacy } from '../src/intimacy/evaluator.ts';

const hang = {
  generate: () => new Promise<never>(() => undefined),
} as never;

test('affect evaluator: 永不返回的 light client 也会在硬超时后放走', async () => {
  const started = Date.now();
  const result = await evaluateCandidate({
    candidate: {sourceSeq: 1, kind: 'direct_message', text: '今天发生了很多事', sourceWeight: 1, actor: 'owner'},
    nowMs: Date.now(),
    client: hang,
    timeoutMs: 50,
  });
  assert.equal(result.data, null);
  assert.equal(result.status, 'failed');
  assert.ok(Date.now() - started < 1_000, 'must not wait for the client');
});

test('intimacy evaluator: 永不返回的 light client 也会在硬超时后放走', async () => {
  const started = Date.now();
  const result = await evaluateIntimacy({text: '想你了', client: hang, timeoutMs: 50});
  assert.equal(result.judgement, null);
  assert.equal(result.status, 'failed');
  assert.ok(Date.now() - started < 1_000, 'must not wait for the client');
});
