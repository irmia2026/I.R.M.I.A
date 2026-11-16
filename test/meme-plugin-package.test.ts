import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { scanPluginPackage } from '../src/plugin/package-store.ts';

test('linre-stickers v0.2.0 package is a valid Host Manifest v2 package and linre-meme-photo is retired', () => {
  const retiredBuiltin = resolve('plugins/builtin/linre-meme-photo');
  assert.equal(existsSync(retiredBuiltin), false);

  const stickersRoot = resolve('plugins/builtin/linre-stickers');
  const pkg = scanPluginPackage(stickersRoot);
  assert.equal(pkg.manifest.id, 'linre-stickers');
  assert.equal(pkg.manifest.version, '0.2.0');
  assert.equal(pkg.manifest.apiVersion, 2);
  assert.equal(pkg.manifest.contributions.mcp, 'mcp.json');
  assert.equal(pkg.manifest.contributions.tools, 'tools.json');
  assert.equal(pkg.manifest.contributions.events?.namespace, 'linre-stickers');
  assert.equal(pkg.manifest.contributions.adapters.length, 1);
  assert.equal(pkg.manifest.contributions.adapters[0]?.worker, 'adapter-worker.mjs');
  assert.deepEqual(pkg.manifest.contributions.views?.[0]?.id, 'stickers');
  assert.deepEqual(pkg.manifest.permissions, []);

  const externalMeme = 'C:/Users/admin/Projects/linre-meme-photo';
  if (existsSync(externalMeme)) {
    const extPkg = scanPluginPackage(externalMeme);
    assert.equal(extPkg.manifest.apiVersion, 2);
  }
});
