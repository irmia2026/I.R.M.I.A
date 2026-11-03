import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConfigError, loadConfig } from '../src/config/config.ts';

function dirWith(doc: Record<string, unknown>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-intimacy-config-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify(doc, null, 2));
  return { dir, cleanup: () => rmSync(dir, {recursive: true, force: true}) };
}

test('intimacy config defaults: disabled, obvious, owner-private, low spontaneous chance', async () => {
  const {dir, cleanup} = dirWith({});
  try {
    const cfg = (await loadConfig(dir)).config.intimacy;
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.maxLevel, 'obvious');
    assert.equal(cfg.privateOnly, true);
    assert.equal(cfg.spontaneousChance, 0.04);
  } finally {
    cleanup();
  }
});

test('intimacy config: parses valid values and rejects privateOnly=false / bad enums', async () => {
  const valid = dirWith({intimacy: {
    enabled: true, maxLevel: 'strong', spontaneousChance: 0.5, privateOnly: true,
  }});
  try {
    const cfg = (await loadConfig(valid.dir)).config.intimacy;
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.maxLevel, 'strong');
    assert.equal(cfg.spontaneousChance, 0.5);
  } finally {
    valid.cleanup();
  }

  const badPrivate = dirWith({intimacy: {privateOnly: false}});
  try {
    await assert.rejects(() => loadConfig(badPrivate.dir), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /privateOnly/u);
      return true;
    });
  } finally {
    badPrivate.cleanup();
  }

  const badLevel = dirWith({intimacy: {maxLevel: 'high'}});
  try {
    await assert.rejects(() => loadConfig(badLevel.dir), /intimacy\.maxLevel/u);
  } finally {
    badLevel.cleanup();
  }
});
