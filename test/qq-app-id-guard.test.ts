import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { findQqAppIdConflict } from '../src/channel/qq-app-id-guard.ts';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'irmia-qq-guard-'));
}

function instancesFile(appData: string, records: Array<Record<string, unknown>>): string {
  const dir = join(appData, 'Irmia');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'instances.json');
  writeFileSync(path, JSON.stringify({ v: 1, instances: records }, null, 2));
  return path;
}

function keysFor(dataDir: string, appId: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, '.keys.json'), JSON.stringify({ qqAppId: appId }));
}

test('QQ guard：另一台在跑实例的 .keys.json 用同一个 appId ⇒ 报冲突（不返回值）', () => {
  const root = tempRoot();
  try {
    const appData = join(root, 'appdata');
    const current = join(root, 'instance-a');
    const other = join(root, 'instance-b');
    keysFor(other, 'BOT-SAME');
    instancesFile(appData, [{
      id: 'other', name: '阿斯特拉', dataDir: other, host: '127.0.0.1',
      port: 7789, pid: 4242,
    }]);

    const conflict = findQqAppIdConflict({
      dataDir: current,
      appId: 'BOT-SAME',
      env: { APPDATA: appData },
      platform: 'win32',
      isAlive: (pid) => pid === 4242,
    });
    assert.deepEqual(conflict, { name: '阿斯特拉', port: 7789 });
    assert.equal(JSON.stringify(conflict).includes('BOT-SAME'), false, '返回值不许带 appId');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('QQ guard：不同 appId / pid 已死 / 同一 dataDir 都不算冲突', () => {
  const root = tempRoot();
  try {
    const appData = join(root, 'appdata');
    const current = join(root, 'instance-a');
    const other = join(root, 'instance-b');
    keysFor(other, 'BOT-OTHER');
    instancesFile(appData, [{
      id: 'other', name: '阿斯特拉', dataDir: other, host: '127.0.0.1',
      port: 7789, pid: 4242,
    }]);

    assert.equal(findQqAppIdConflict({
      dataDir: current, appId: 'BOT-MINE', env: { APPDATA: appData }, platform: 'win32',
      isAlive: () => true,
    }), null, '不同 appId 不冲突');

    assert.equal(findQqAppIdConflict({
      dataDir: current, appId: 'BOT-OTHER', env: { APPDATA: appData }, platform: 'win32',
      isAlive: () => false,
    }), null, 'pid 已死不算"在跑"');

    assert.equal(findQqAppIdConflict({
      dataDir: other, appId: 'BOT-OTHER', env: { APPDATA: appData }, platform: 'win32',
      isAlive: () => true,
    }), null, '同一实例自己的登记条目不算冲突');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('QQ guard：没有 instances.json / 没有 keys / 非 Windows ⇒ null', () => {
  const root = tempRoot();
  try {
    assert.equal(findQqAppIdConflict({
      dataDir: join(root, 'a'), appId: 'BOT', env: { APPDATA: join(root, 'empty') }, platform: 'win32',
    }), null);
    assert.equal(findQqAppIdConflict({
      dataDir: join(root, 'a'), appId: 'BOT', env: { APPDATA: join(root, 'empty') }, platform: 'linux',
    }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
