import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { EVENT_VISIBILITY, type AppEvent } from '../src/log/types.ts';
import { PluginManager } from '../src/plugin/manager.ts';
import { installPluginPackage } from '../src/plugin/package-store.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

function source(version = '1.0.0'): string {
  const dir = tempDirSync('irmia-manager-source-');
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({
    apiVersion: 1,
    id: 'memory-friend',
    version,
    engine: { irmia: '>=0.1.0-beta.12' },
    contributions: { skills: [] },
    permissions: [],
  }));
  return dir;
}

function harness() {
  const dataDir = tempDirSync('irmia-manager-data-');
  const emitted: AppEvent[] = [];
  const manager = new PluginManager(dataDir, (type, data) => {
    emitted.push({ seq: emitted.length + 1, ts: new Date(0).toISOString(), type, data, visibility: 'internal' } as AppEvent);
  });
  return { manager, emitted, dataDir };
}

test('安装不可信，确认绑定内容后才允许启用，重复命令幂等', () => {
  const { manager, emitted } = harness();
  const installed = manager.install(source());
  assert.equal(manager.list()[0]?.state, 'untrusted');
  assert.equal(emitted.length, 0);
  assert.throws(() => manager.setEnabled(installed.manifest.id, installed.contentHash, true), /confirm|trust/i);
  manager.confirm(installed.manifest.id, installed.contentHash);
  assert.equal(manager.list()[0]?.state, 'disabled');
  manager.confirm(installed.manifest.id, installed.contentHash);
  assert.equal(emitted.length, 1);
  manager.setEnabled(installed.manifest.id, installed.contentHash, true);
  manager.setEnabled(installed.manifest.id, installed.contentHash, true);
  assert.equal(manager.list()[0]?.state, 'enabled');
  assert.equal(manager.list()[0]?.requiresRestart, true);
  assert.equal(manager.active().length, 0);
  assert.equal(emitted.length, 2);
  assert.deepEqual(emitted.map((event) => event.type), ['plugin/installed', 'plugin/enabled']);
});

test('启停按 seq 最后事件生效，旧无关事件不改变插件状态', () => {
  const { manager, dataDir } = harness();
  const installed = installPluginPackage(source(), dataDir);
  const base = { ts: new Date(0).toISOString(), visibility: 'internal' as const };
  manager.setEvents([
    { ...base, seq: 4, type: 'plugin/disabled', data: { id: installed.manifest.id, contentHash: installed.contentHash } },
    { ...base, seq: 2, type: 'plugin/enabled', data: { id: installed.manifest.id, contentHash: installed.contentHash } },
    { ...base, seq: 1, type: 'plugin/installed', data: { id: installed.manifest.id, version: installed.manifest.version, contentHash: installed.contentHash, path: installed.rootDir, by: 'human' } },
    { ...base, seq: 3, type: 'memory/selected', data: { query: 'old', selected: [] } },
  ] as AppEvent[]);
  assert.equal(manager.list()[0]?.state, 'disabled');
  assert.equal(manager.list()[0]?.requiresRestart, false);
});

test('升级 hash 不继承信任，篡改包保持 invalid 且不进入 active', () => {
  const { manager, emitted, dataDir } = harness();
  const oldPackage = manager.install(source('1.0.0'));
  manager.confirm(oldPackage.manifest.id, oldPackage.contentHash);
  manager.setEnabled(oldPackage.manifest.id, oldPackage.contentHash, true);
  const upgraded = manager.install(source('2.0.0'));
  assert.equal(manager.list().find((item) => item.package.contentHash === upgraded.contentHash)?.state, 'untrusted');
  manager.setEvents(emitted);
  assert.equal(manager.active().length, 1);
  writeFileSync(join(oldPackage.rootDir, 'unexpected.txt'), 'tampered');
  assert.equal(manager.list().find((item) => item.package.contentHash === oldPackage.contentHash)?.state, 'invalid');
  assert.equal(manager.active().length, 0);
  assert.ok(manager.list().find((item) => item.package.contentHash === oldPackage.contentHash)?.problems.length);
  assert.equal(upgraded.rootDir.startsWith(dataDir), true);
});

test('所有插件事件都显式为 internal', () => {
  for (const type of ['plugin/installed', 'plugin/enabled', 'plugin/disabled', 'plugin/failed']) {
    assert.equal(EVENT_VISIBILITY[type], 'internal');
  }
});

test('事件写盘失败时不提前改变本地状态', () => {
  const dir = source();
  const dataDir = tempDirSync('irmia-manager-data-');
  const installed = installPluginPackage(dir, dataDir);
  const manager = new PluginManager(dataDir, () => { throw new Error('disk full'); });
  assert.throws(() => manager.confirm(installed.manifest.id, installed.contentHash), /disk full/);
  assert.equal(manager.list()[0]?.state, 'untrusted');
});

test('同大小同 mtime 改写内容也逃不过内容哈希：list 报 invalid、确认启停被拒、不进 active', () => {
  const { manager } = harness();
  const installed = manager.install(source());
  manager.confirm(installed.manifest.id, installed.contentHash);
  manager.setEnabled(installed.manifest.id, installed.contentHash, true);
  assert.equal(manager.list()[0]?.state, 'enabled');

  // 把 mtime 钉死，让「缓存指纹还能不能失效」只剩 ctime 这一个变量
  const manifestPath = join(installed.rootDir, 'plugin.json');
  const fixed = new Date('2020-01-02T03:04:05.000Z');
  utimesSync(manifestPath, fixed, fixed);
  assert.equal(manager.list()[0]?.state, 'enabled');
  const before = statSync(manifestPath);

  const bytes = readFileSync(manifestPath, 'utf8');
  const tampered = bytes.replace('"version":"1.0.0"', '"version":"1.0.1"');
  assert.notEqual(tampered, bytes, '样本必须真的换了字节');
  writeFileSync(manifestPath, tampered);
  utimesSync(manifestPath, fixed, fixed);
  const after = statSync(manifestPath);
  assert.equal(after.size, before.size, '必须同大小，否则测的是 size 而不是内容');
  assert.equal(after.mtimeMs, before.mtimeMs, 'mtime 已还原，指纹只能靠 ctime 失效');

  const view = manager.list()[0];
  assert.equal(view?.state, 'invalid');
  assert.match(view?.problems.join('\n') ?? '', /contentHash mismatch/i);
  assert.throws(() => manager.confirm(installed.manifest.id, installed.contentHash), /contentHash mismatch/i);
  assert.throws(() => manager.setEnabled(installed.manifest.id, installed.contentHash, false), /contentHash mismatch/i);
  assert.equal(manager.active().length, 0);
});

test('同 id 已有另一个 hash 启用时拒绝再次启用，停用旧的才能换版本', () => {
  const { manager, emitted } = harness();
  const first = manager.install(source('1.0.0'));
  manager.confirm(first.manifest.id, first.contentHash);
  manager.setEnabled(first.manifest.id, first.contentHash, true);

  const second = manager.install(source('2.0.0'));
  manager.confirm(second.manifest.id, second.contentHash);
  assert.throws(() => manager.setEnabled(second.manifest.id, second.contentHash, true), /already enabled/i);
  assert.equal(manager.list().filter((view) => view.state === 'enabled').length, 1);

  manager.setEnabled(first.manifest.id, first.contentHash, false);
  manager.setEnabled(second.manifest.id, second.contentHash, true);
  assert.equal(manager.list().find((view) => view.package.contentHash === second.contentHash)?.state, 'enabled');
  // 装配面按日志重放之后才算「已生效」（requiresRestart 才为 false），这里模拟宿主已按这份日志启动
  manager.setEvents(emitted);
  assert.deepEqual(manager.active().map((pkg) => pkg.contentHash), [second.contentHash]);
});

test('历史日志里同 id 多版本同时启用时 active 只收一个，并在 problems 里报裁剪原因', () => {
  const { manager, dataDir } = harness();
  const newer = installPluginPackage(source('2.0.0'), dataDir);
  const older = installPluginPackage(source('1.0.0'), dataDir);
  const base = { ts: new Date(0).toISOString(), visibility: 'internal' as const };
  const events: AppEvent[] = [];
  const push = (type: string, data: Record<string, unknown>): void => {
    events.push({ ...base, seq: events.length + 1, type, data } as AppEvent);
  };
  for (const pkg of [newer, older]) {
    push('plugin/installed', { id: pkg.manifest.id, version: pkg.manifest.version, contentHash: pkg.contentHash, path: pkg.rootDir, by: 'human' });
    push('plugin/enabled', { id: pkg.manifest.id, contentHash: pkg.contentHash });
  }
  manager.setEvents(events);
  assert.equal(manager.list().filter((view) => view.state === 'enabled').length, 2, '前提：历史日志允许两条同时启用');

  const active = manager.active();
  assert.equal(active.length, 1);
  const expected = [newer.contentHash, older.contentHash].sort()[0]!;
  assert.equal(active[0]?.contentHash, expected, '裁剪规则是 contentHash 码点序取首个');
  const trimmed = manager.list().find((view) => view.package.contentHash !== expected);
  assert.match((trimmed?.problems ?? []).join('\n'), /多版本|裁剪/);
  assert.equal(trimmed?.state, 'enabled', '被裁掉的包内容本身没问题，不该被标成 invalid');
});

test('扫描结果按 stat 指纹缓存：重复 list 复用同一份，内容被改后立刻重扫', () => {
  const { manager } = harness();
  const installed = manager.install(source());
  manager.confirm(installed.manifest.id, installed.contentHash);

  const first = manager.list()[0]?.package;
  const second = manager.list()[0]?.package;
  assert.equal(first, second, '指纹没变就该复用同一个扫描结果，而不是每秒重读整包');

  // 指纹必须对内容变化敏感：改掉包里的文件后，同一个包目录要立刻重新扫出 invalid
  writeFileSync(join(installed.rootDir, 'plugin.json'), JSON.stringify({
    apiVersion: 1, id: 'memory-friend', version: '2.0.0',
    engine: { irmia: '>=0.1.0-beta.12' }, contributions: { skills: [] }, permissions: [],
  }));
  const after = manager.list()[0];
  assert.equal(after?.state, 'invalid');
  assert.match(after?.problems[0] ?? '', /contentHash mismatch/i);
});
