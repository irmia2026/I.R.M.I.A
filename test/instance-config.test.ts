import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { instanceConfigPath, launcherBackendArgs, prepareInstanceConfig } from '../packaging/instance-config.mjs';

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-instance-config-'));
  return dir;
}

test('prepareInstanceConfig：复制种子、重写 dataDir、清空 mentionKeywords，其余字段保留', () => {
  const root = tempRoot();
  try {
    const rootConfig = join(root, 'config.json');
    const instanceDir = join(root, 'instances', 'astra');
    writeFileSync(rootConfig, JSON.stringify({
      dataDir: 'data',
      web: { port: 7788 },
      channels: { mentionKeywords: ['阿斯特拉', '小特'], other: { keep: true } },
      persona: { owner: 'owner-a' },
      $comment: ['保留注释'],
    }, null, 2));

    const result = prepareInstanceConfig({ rootConfigPath: rootConfig, dataDir: instanceDir });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.created, true);
    assert.equal(result.path, instanceConfigPath(instanceDir));
    assert.equal(existsSync(result.path!), true);

    const written = JSON.parse(readFileSync(result.path!, 'utf8')) as Record<string, unknown>;
    assert.equal(written['dataDir'], resolve(instanceDir), 'dataDir 必须指向实例目录');
    assert.deepEqual((written['channels'] as Record<string, unknown>)['mentionKeywords'], []);
    assert.deepEqual((written['channels'] as Record<string, unknown>)['other'], { keep: true });
    assert.deepEqual(written['persona'], { owner: 'owner-a' });
    assert.deepEqual(written['$comment'], ['保留注释']);
    assert.deepEqual(written['web'], { port: 7788 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareInstanceConfig：已有实例 config 一律不覆盖', () => {
  const root = tempRoot();
  try {
    const rootConfig = join(root, 'config.json');
    const instanceDir = join(root, 'instances', 'astra');
    writeFileSync(rootConfig, JSON.stringify({ dataDir: 'data', channels: { mentionKeywords: ['A'] } }));
    const target = instanceConfigPath(instanceDir);
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(target, JSON.stringify({ marker: 'keep-me' }));

    const result = prepareInstanceConfig({ rootConfigPath: rootConfig, dataDir: instanceDir });
    assert.equal(result.ok, true);
    assert.equal(result.created, false);
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { marker: 'keep-me' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareInstanceConfig：安装根 config 缺失/坏掉时拒绝，不静默退回全局配置', () => {
  const root = tempRoot();
  try {
    const missing = prepareInstanceConfig({
      rootConfigPath: join(root, 'missing.json'),
      dataDir: join(root, 'instances', 'astra'),
    });
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? '', /读不到安装根配置/u);

    const bad = join(root, 'bad.json');
    writeFileSync(bad, '{ not json');
    const broken = prepareInstanceConfig({ rootConfigPath: bad, dataDir: join(root, 'instances', 'astra2') });
    assert.equal(broken.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('launcherBackendArgs：--config 指向传入的实例配置文件，不再写死安装根', () => {
  const args = launcherBackendArgs({
    entry: join('D:', 'app', 'dist', 'main.js'),
    configPath: join('D:', 'instances', 'astra', 'config.json'),
    dataDir: join('D:', 'instances', 'astra'),
    port: 7789,
  });
  assert.deepEqual(args, [
    '--max-old-space-size=1024',
    join('D:', 'app', 'dist', 'main.js'),
    '--config', join('D:', 'instances', 'astra', 'config.json'),
    '--data-dir', join('D:', 'instances', 'astra'),
    '--port', '7789',
  ]);
});
