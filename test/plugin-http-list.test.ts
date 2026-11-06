import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { listPlugins } from '../src/plugin/http.ts';
import { PluginManager } from '../src/plugin/manager.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

function writePackage(root: string, version: string, marker: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    apiVersion: 1,
    id: 'demo',
    version,
    engine: { irmia: '>=0.1.0-beta.12' },
    contributions: { skills: [] },
    permissions: [],
  }));
  writeFileSync(join(root, 'note.txt'), marker);
}

test('插件列表：同 id 多份只列一条，取最高版本', (t) => {
  const dir = tempDirSync('irmia-plugin-list-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = new PluginManager(join(dir, 'data'), () => undefined);
  const low = join(dir, 'low');
  const high = join(dir, 'high');
  writePackage(low, '1.0.0', 'a');
  writePackage(high, '2.0.0', 'b');
  manager.install(low);
  manager.install(high);

  const result = listPlugins(manager);
  assert.equal(result.status, 200);
  const items = (result.body as { items: Array<{ package: { manifest: { id: string; version: string } } }> }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.package.manifest.id, 'demo');
  assert.equal(items[0]?.package.manifest.version, '2.0.0');
});

test('插件列表：未注入管理器时如实 501', () => {
  const result = listPlugins(undefined);
  assert.equal(result.status, 501);
});
