import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import type { AppEvent } from '../src/log/types.ts';
import { PluginCircuitBreaker } from '../src/plugin/circuit-breaker.ts';
import { isSystemicPluginFailure, PluginProbeCancelledError, type PluginFailure } from '../src/plugin/failures.ts';
import { PluginManager } from '../src/plugin/manager.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';
import { makeRealWakeRig } from './fixtures/real-wake-rig.ts';

const failure: PluginFailure = {
  pluginId: 'demo', contentHash: '', contributionKind: 'mcp', contributionName: 'demo__chat', category: 'timeout', message: 'request timed out',
};

function harness(probe: (id: string, hash: string) => Promise<void> = async () => {}) {
  const dataDir = tempDirSync('irmia-circuit-data-');
  const source = tempDirSync('irmia-circuit-source-');
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({ apiVersion: 1, id: 'demo', version: '1.0.0', engine: { irmia: '>=0.1.0-beta.12' }, contributions: { skills: [] }, permissions: [] }));
  const events: AppEvent[] = [];
  const manager = new PluginManager(dataDir, (type, data) => events.push({ seq: events.length + 1, ts: new Date(0).toISOString(), type, data, visibility: 'internal' } as AppEvent));
  const installed = manager.install(source);
  failure.contentHash = installed.contentHash;
  manager.confirm('demo', installed.contentHash);
  manager.setEnabled('demo', installed.contentHash, true);
  manager.setEvents(events);
  let now = Date.parse('2026-01-01T00:00:00Z');
  let applications = 0;
  const breaker = new PluginCircuitBreaker({ manager, now: () => now, probe, apply: async () => { applications += 1; } });
  return { manager, breaker, events, installed, dataDir, probe, now: () => now, tick: (ms: number) => { now += ms; }, applications: () => applications };
}

test('同一贡献连续三次系统性故障隔离整包，先落事件再在边界移除', async () => {
  const h = harness();
  h.breaker.noteFailure(failure);
  h.breaker.noteFailure(failure);
  assert.equal(h.manager.list()[0]?.state, 'enabled');
  h.breaker.noteFailure(failure);
  assert.equal(h.manager.list()[0]?.state, 'quarantined');
  assert.equal(h.manager.active().length, 0);
  assert.equal(h.events.at(-1)?.type, 'plugin/quarantined');
  assert.equal(h.manager.list()[0]?.circuit?.count, 3);
  assert.equal(h.manager.list()[0]?.circuit?.lastError, 'request timed out');
  assert.equal(h.manager.list()[0]?.circuit?.retryAt, '2026-01-01T00:00:30.000Z');
  assert.equal(h.applications(), 0);
  await h.breaker.drain();
  assert.equal(h.applications(), 1);
});

test('半开阶段只有原故障贡献成功才恢复整包', () => {
  const h = harness();
  for (let i = 0; i < 3; i += 1) h.breaker.noteFailure(failure);
  assert.equal(h.manager.beginProbe('demo', h.installed.contentHash, new Date(h.now()).toISOString()), true);
  h.breaker.noteSuccess({ ...failure, contributionKind: 'hook', contributionName: 'Wake:healthy' });
  assert.equal(h.manager.list()[0]?.state, 'probing');
  h.breaker.noteSuccess(failure);
  assert.equal(h.manager.list()[0]?.state, 'enabled');
  assert.equal(h.events.at(-1)?.type, 'plugin/recovered');
});

test('成功只重置对应贡献，业务错误和门控拒绝永不计数', () => {
  const h = harness();
  h.breaker.noteFailure(failure);
  h.breaker.noteFailure(failure);
  h.breaker.noteSuccess(failure);
  h.breaker.noteFailure(failure);
  h.breaker.noteFailure(failure);
  assert.equal(h.manager.list()[0]?.state, 'enabled');
  for (const category of ['business', 'bad-arguments', 'denied', 'overloaded', 'cancelled'] as const) {
    assert.equal(isSystemicPluginFailure({ ...failure, category }), false);
    h.breaker.noteFailure({ ...failure, category });
  }
  assert.equal(h.manager.list()[0]?.state, 'enabled');
});

test('重启保留冷却，半开并发只有一个探测，成功恢复', async () => {
  let release: (() => void) | undefined;
  let calls = 0;
  const h = harness(async () => { calls += 1; await new Promise<void>((resolve) => { release = resolve; }); });
  for (let i = 0; i < 3; i += 1) h.breaker.noteFailure(failure);
  const restored = new PluginManager(h.dataDir, (type, data) => h.events.push({ seq: h.events.length + 1, ts: new Date(0).toISOString(), type, data, visibility: 'internal' } as AppEvent));
  restored.setEvents(h.events);
  assert.equal(restored.list()[0]?.circuit?.retryAt, '2026-01-01T00:00:30.000Z');
  h.tick(29_999);
  await h.breaker.drain();
  assert.equal(calls, 0);
  h.tick(1);
  const first = h.breaker.drain();
  const second = h.breaker.drain();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(calls, 1);
  assert.equal(h.manager.list()[0]?.state, 'probing');
  release!();
  await Promise.all([first, second]);
  assert.equal(h.manager.list()[0]?.state, 'enabled');
  assert.equal(h.events.at(-1)?.type, 'plugin/recovered');
});

test('探测失败指数退避到十五分钟', async () => {
  const h = harness(async () => { throw new Error('still broken'); });
  for (let i = 0; i < 3; i += 1) h.breaker.noteFailure(failure);
  for (const expected of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
    h.tick(Date.parse(h.manager.list()[0]!.circuit!.retryAt!) - h.now());
    await h.breaker.drain();
    const circuit = h.manager.list()[0]!.circuit!;
    assert.equal(circuit.state, 'quarantined');
    assert.equal(Date.parse(circuit.retryAt!) - h.now(), expected);
  }
});

test('探针被取消不算失败：还原成隔离态，计数与 strike 不变，也不写 plugin/quarantined', async () => {
  const h = harness(async () => { throw new PluginProbeCancelledError(); });
  for (let i = 0; i < 3; i += 1) h.breaker.noteFailure(failure);
  const before = h.manager.list()[0]!.circuit!;
  assert.equal(before.count, 3);
  assert.equal(before.strikes, 1);
  h.tick(Date.parse(before.retryAt!) - h.now());
  const quarantinedEvents = h.events.filter((event) => event.type === 'plugin/quarantined').length;
  await h.breaker.drain();

  const view = h.manager.list()[0]!;
  assert.equal(view.state, 'quarantined');
  assert.equal(view.circuit!.count, before.count, '取消不是一次新的失败，计数不能涨');
  assert.equal(view.circuit!.strikes, before.strikes, 'strike 不涨，隔离期才不会平白翻倍');
  assert.equal(view.circuit!.lastError, before.lastError);
  assert.equal(view.circuit!.contributionName, before.contributionName);
  assert.equal(h.events.filter((event) => event.type === 'plugin/quarantined').length, quarantinedEvents,
    '取消不该在日志里留下一条「它又坏了」');
  // 立刻可重试：retryAt 回到本次探针开始的时刻，而不是被推后一档退避
  assert.equal(Date.parse(view.circuit!.retryAt!), h.now());
});

test('取消之后再来一次真实失败照样涨 strike、写隔离事件', async () => {
  let cancelled = true;
  const h = harness(async () => {
    if (cancelled) throw new PluginProbeCancelledError();
    throw new Error('still broken');
  });
  for (let i = 0; i < 3; i += 1) h.breaker.noteFailure(failure);
  h.tick(30_000);
  await h.breaker.drain();
  assert.equal(h.manager.list()[0]!.state, 'quarantined');
  assert.equal(h.manager.list()[0]!.circuit!.strikes, 1);

  cancelled = false;
  await h.breaker.drain();
  const circuit = h.manager.list()[0]!.circuit!;
  assert.equal(circuit.strikes, 2, '真实失败照常累加 strike');
  assert.equal(circuit.count, 4);
  assert.equal(h.events.at(-1)?.type, 'plugin/quarantined');
});

test('进程死在半开状态后重启会立即重试，不会永久卡住', async () => {
  let calls = 0;
  const h = harness(async () => { calls += 1; });
  for (let i = 0; i < 3; i += 1) h.breaker.noteFailure(failure);
  h.tick(30_000);
  assert.equal(h.manager.beginProbe('demo', h.installed.contentHash, new Date(h.now()).toISOString()), true);
  assert.equal(h.manager.list()[0]?.state, 'probing');
  const restored = new PluginManager(h.dataDir, (type, data) => h.events.push({ seq: h.events.length + 1, ts: new Date(0).toISOString(), type, data, visibility: 'internal' } as AppEvent));
  restored.setEvents(h.events);
  assert.equal(restored.list()[0]?.state, 'quarantined');
  const breaker = new PluginCircuitBreaker({ manager: restored, now: h.now, probe: h.probe, apply: async () => {} });
  await breaker.drain();
  assert.equal(calls, 1);
  assert.equal(restored.list()[0]?.state, 'enabled');
});

test('停止熔断器会等待在飞探测和运行面应用', async () => {
  let release: (() => void) | undefined;
  const h = harness(async () => { await new Promise<void>((resolve) => { release = resolve; }); });
  for (let i = 0; i < 3; i += 1) h.breaker.noteFailure(failure);
  h.tick(30_000);
  const draining = h.breaker.drain();
  let stopped = false;
  const stopping = h.breaker.stop().then(() => { stopped = true; });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(h.manager.list()[0]?.state, 'probing');
  assert.equal(stopped, false);
  release!();
  await Promise.all([draining, stopping]);
  assert.equal(h.manager.list()[0]?.state, 'enabled');
});

test('人工禁用和未信任包不会自动探测', async () => {
  let calls = 0;
  const h = harness(async () => { calls += 1; });
  for (let i = 0; i < 3; i += 1) h.breaker.noteFailure(failure);
  h.manager.setEnabled('demo', h.installed.contentHash, false);
  h.tick(30_000);
  await h.breaker.drain();
  assert.equal(calls, 0);
  assert.equal(h.manager.list()[0]?.state, 'disabled');
});

test('RealLoop 在 turn 落尾之后才应用插件变更', async (t) => {
  const settledAtBoundary: boolean[] = [];
  const rig = await makeRealWakeRig({
    stream: [{ text: '完成。' }],
    onTurnBoundary: async () => { settledAtBoundary.push((await rig.events()).some((event) => event.type === 'turn/end')); },
  });
  t.after(rig.dispose);
  rig.append('wake/manual', { note: '验证插件边界' });
  await rig.tick();
  assert.deepEqual(settledAtBoundary, [true]);
});
