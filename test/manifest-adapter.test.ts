import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parsePluginManifest,
  permissionsToCapabilityDeclarations,
  type PluginManifestV2,
} from '../src/plugin/manifest.ts';

function base(apiVersion: 1 | 2, contributions: Record<string, unknown>, permissions: unknown = []): Record<string, unknown> {
  return {
    apiVersion,
    id: 'adapter-demo',
    version: '1.0.0',
    engine: { irmia: '>=0.1.0-beta.14' },
    contributions,
    permissions,
  };
}

test('apiVersion 1 保持原有清单形状和权限语义', () => {
  const parsed = parsePluginManifest(base(1, { skills: ['skills'], hooks: 'hooks.json' }, ['legacy.permission']));
  assert.equal(parsed.apiVersion, 1);
  assert.deepEqual(parsed.contributions, { skills: ['skills'], hooks: 'hooks.json' });
  assert.deepEqual(parsed.permissions, ['legacy.permission']);
  assert.equal('declaredCapabilities' in parsed, false);
});

test('apiVersion 2 接受严格的 adapters 声明并映射旧 permissions', () => {
  const parsed = parsePluginManifest(base(2, {
    skills: [],
    adapters: [{ worker: 'adapter/worker.mjs', apiVersion: 2, capabilities: ['events.channel.message.read', 'effects.message.propose'] }],
  }, ['legacy.permission'])) as PluginManifestV2;
  assert.deepEqual(parsed.contributions.adapters, [{
    worker: 'adapter/worker.mjs',
    apiVersion: 2,
    capabilities: ['events.channel.message.read', 'effects.message.propose'],
  }]);
  assert.deepEqual(parsed.declaredCapabilities, [{ capability: 'legacy.permission' }]);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.contributions.adapters), true);
});

test('v2 拒绝未知字段、拼写错误、非法版本和空能力', () => {
  const valid = {
    skills: [],
    adapters: [{ worker: 'adapter/worker.mjs', apiVersion: 2, capabilities: ['assets.read'] }],
  };
  assert.throws(() => parsePluginManifest(base(2, { ...valid, adapaters: valid.adapters })), /adapaters/);
  assert.throws(() => parsePluginManifest(base(2, { ...valid, adapters: [{ ...valid.adapters[0], extra: true }] })), /extra/);
  assert.throws(() => parsePluginManifest(base(2, { ...valid, adapters: [{ ...valid.adapters[0], apiVersion: 1 }] })), /apiVersion/);
  assert.throws(() => parsePluginManifest(base(2, { ...valid, adapters: [{ ...valid.adapters[0], capabilities: [] }] })), /non-empty/);
  assert.throws(() => parsePluginManifest(base(2, { ...valid, adapters: [{ ...valid.adapters[0], capabilities: ['bad capability'] }] })), /capability/);
  assert.throws(() => parsePluginManifest(base(2, { ...valid, adapters: [{ ...valid.adapters[0], capabilities: ['assets.read', 'assets.read'] }] })), /duplicate/);
});

test('v2 拒绝 worker 路径逃逸和空 adapters', () => {
  const adapter = (worker: string) => ({ skills: [], adapters: [{ worker, apiVersion: 2, capabilities: ['assets.read'] }] });
  for (const worker of ['../worker.mjs', '/worker.mjs', 'C:/worker.mjs', 'adapter/../worker.mjs', '']) {
    assert.throws(() => parsePluginManifest(base(2, adapter(worker))), /path|worker/);
  }
  assert.throws(() => parsePluginManifest(base(2, { skills: [], adapters: [] })), /non-empty/);
});

test('旧 permissions 映射为声明输入但不修改原数组', () => {
  const permissions = ['assets.read', 'effects.message.propose'];
  const mapped = permissionsToCapabilityDeclarations(permissions);
  assert.deepEqual(mapped, [{ capability: 'assets.read' }, { capability: 'effects.message.propose' }]);
  assert.notEqual(mapped[0], permissions[0]);
  assert.equal(Object.isFrozen(mapped), true);
  assert.deepEqual(permissions, ['assets.read', 'effects.message.propose']);
});
