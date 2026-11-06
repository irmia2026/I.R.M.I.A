import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { scanPluginPackage } from '../src/plugin/package-store.ts';

const memeRoots = [
  'C:/Users/admin/Projects/linre-meme-photo',
  'C:/Users/admin/Documents/linre-src/L.i.N.R.E/plugins/builtin/linre-meme-photo',
];

test('linre-meme-photo packages are valid Host Manifest v2 packages', () => {
  for (const memeRoot of memeRoots) {
    if (!existsSync(memeRoot)) continue;
    const pkg = scanPluginPackage(memeRoot);
    assert.equal(pkg.manifest.id, 'linre-meme-photo');
    assert.equal(pkg.manifest.apiVersion, 2);
    assert.equal(pkg.manifest.contributions.adapters.length, 1);
    assert.equal(pkg.manifest.contributions.adapters[0]?.worker, 'adapter-worker.mjs');
    assert.deepEqual(pkg.manifest.permissions, []);
  }
});
