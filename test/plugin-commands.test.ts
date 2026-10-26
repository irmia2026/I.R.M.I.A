import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { defaultVisibility, emptyProjection, type AppEvent } from '../src/log/types.ts';
import { PluginManager } from '../src/plugin/manager.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const TOKEN = 'plugin-api-test-token';
const NOW = new Date('2026-10-24T00:00:00.000Z');

interface Fixture {
  dir: string;
  dataDir: string;
  source: string;
  manager?: PluginManager;
  server: WebServer;
  events(): Promise<AppEvent[]>;
}

async function setup(t: TestContext, withManager = true): Promise<Fixture> {
  const dir = tempDirSync('irmia-plugin-http-');
  const dataDir = join(dir, 'data');
  const source = join(dir, 'source');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({
    apiVersion: 1, id: 'demo', version: '1.2.3', engine: { irmia: '>=0.1.0-beta.12' },
    contributions: { skills: ['skills'], hooks: 'hooks.json' }, permissions: ['filesystem.read'],
  }));
  mkdirSync(join(source, 'skills'));
  writeFileSync(join(source, 'hooks.json'), '{"hooks":[]}');
  const log = await EventLog.open(join(dataDir, 'events'));
  let manager: PluginManager | undefined;
  if (withManager) {
    manager = new PluginManager(dataDir, (type, data) => {
      const event = { seq: log.nextSeq(), ts: NOW.toISOString(), type, data, visibility: defaultVisibility(type) } as AppEvent;
      log.append(event, { sync: true });
    });
  }
  const server = await startWebServer({
    log, projection: emptyProjection(), config: defaultConfig(dir), personaRoot: join(dataDir, 'persona'),
    dataDir, timers: new TimerStore(join(dataDir, 'timers.json'), { now: () => NOW }), now: () => NOW,
    uiToken: TOKEN, port: 0, ...(manager === undefined ? {} : { plugins: manager }),
  });
  t.after(async () => {
    await server.close();
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir, dataDir, source, manager, server,
    events: async () => {
      const events: AppEvent[] = [];
      for await (const event of log.readAll()) events.push(event);
      return events;
    },
  };
}

async function call(fx: Fixture, path: string, body?: unknown, confirm?: string) {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (confirm !== undefined) headers['x-confirm'] = confirm;
  const response = await fetch(`${fx.server.url()}${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as any };
}

async function command(fx: Fixture, name: string, body: unknown, confirm: string | undefined = name) {
  return await call(fx, `/api/commands/${name}`, body, confirm);
}

test('缺少 PluginManager 时读写接口都清晰返回 501', async (t) => {
  const fx = await setup(t, false);
  const listed = await call(fx, '/api/plugins');
  assert.equal(listed.status, 501);
  assert.equal(listed.body.error.code, 'not-implemented');
  for (const name of ['plugin-install', 'plugin-confirm', 'plugin-enable', 'plugin-disable']) {
    const res = await command(fx, name, {});
    assert.equal(res.status, 501, res.text);
    assert.equal(res.body.error.code, 'not-implemented');
  }
});

test('所有插件写命令都沿用 UI 鉴权与项目确认短语', async (t) => {
  const fx = await setup(t);
  const unauthenticated = await fetch(`${fx.server.url()}/api/plugins`);
  assert.equal(unauthenticated.status, 401);
  for (const name of ['plugin-install', 'plugin-confirm', 'plugin-enable', 'plugin-disable']) {
    const res = await call(fx, `/api/commands/${name}`, {});
    assert.equal(res.status, 400, res.text);
    assert.equal(res.body.error.code, 'confirm-required');
    assert.match(res.body.error.message, new RegExp(name));
  }
});

test('安装不授予信任，确认和启停返回最新状态且启停要求重启', async (t) => {
  const fx = await setup(t);
  const installed = await command(fx, 'plugin-install', { sourceDir: fx.source });
  assert.equal(installed.status, 200, installed.text);
  assert.equal(installed.body.ok, true);
  assert.equal(installed.body.plugin.state, 'untrusted');
  assert.equal(installed.body.plugin.package.manifest.version, '1.2.3');
  assert.equal(installed.body.plugin.package.manifest.contributions.skills[0], 'skills');
  const { id } = installed.body.plugin.package.manifest;
  const hash = installed.body.plugin.package.contentHash;
  assert.deepEqual((await fx.events()).map((event) => event.type), []);

  const confirmed = await command(fx, 'plugin-confirm', { id, contentHash: hash });
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.equal(confirmed.body.plugin.state, 'disabled');
  const enabled = await command(fx, 'plugin-enable', { id, contentHash: hash });
  assert.equal(enabled.status, 200, enabled.text);
  assert.equal(enabled.body.restartRequired, true);
  assert.equal(enabled.body.plugin.state, 'enabled');
  assert.equal(enabled.body.plugin.requiresRestart, true);
  assert.equal((await command(fx, 'plugin-confirm', { id, contentHash: hash })).status, 200);
  // 宿主已经按这份日志装配过一次（等价于重启后重放）：在此基础上重复启用同一条，
  // 运行面一点没变，回执就不该再说「要重启」
  fx.manager!.setEvents(await fx.events());
  const duplicateEnable = await command(fx, 'plugin-enable', { id, contentHash: hash });
  assert.equal(duplicateEnable.status, 200);
  assert.equal(duplicateEnable.body.restartRequired, false);
  assert.equal(duplicateEnable.body.plugin.requiresRestart, false);
  assert.deepEqual((await fx.events()).map((event) => event.type), ['plugin/installed', 'plugin/enabled']);
  const disabled = await command(fx, 'plugin-disable', { id, contentHash: hash });
  assert.equal(disabled.status, 200, disabled.text);
  assert.equal(disabled.body.restartRequired, true);
  assert.equal(disabled.body.plugin.state, 'disabled');
  assert.deepEqual((await fx.events()).map((event) => event.type), ['plugin/installed', 'plugin/enabled', 'plugin/disabled']);

  const listed = await call(fx, '/api/plugins');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items.length, 1);
  assert.equal(listed.body.items[0].package.manifest.id, 'demo');
  assert.equal(listed.body.items[0].state, 'disabled');
  assert.deepEqual(listed.body.items[0].problems, []);
});

test('相对路径和非法包被安全拒绝，不写事件', async (t) => {
  const fx = await setup(t);
  const relative = await command(fx, 'plugin-install', { sourceDir: 'source' });
  assert.equal(relative.status, 400);
  assert.equal(relative.body.error.code, 'invalid-source');
  const networkPath = await command(fx, 'plugin-install', { sourceDir: '\\\\server\\share\\plugin' });
  assert.equal(networkPath.status, 400);
  assert.equal(networkPath.body.error.code, 'invalid-source');
  const invalidSource = join(fx.dir, 'invalid');
  mkdirSync(invalidSource);
  writeFileSync(join(invalidSource, 'plugin.json'), '{bad json');
  const invalid = await command(fx, 'plugin-install', { sourceDir: invalidSource });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'plugin-error');
  assert.deepEqual(await fx.events(), []);
});

test('错误 hash 不会确认或启停其他内容', async (t) => {
  const fx = await setup(t);
  const installed = fx.manager!.install(fx.source);
  for (const name of ['plugin-confirm', 'plugin-enable', 'plugin-disable']) {
    const res = await command(fx, name, { id: installed.manifest.id, contentHash: '0'.repeat(64) });
    assert.equal(res.status, 400, res.text);
    assert.equal(res.body.error.code, 'plugin-error');
  }
  assert.equal(fx.manager!.list()[0]?.state, 'untrusted');
  assert.deepEqual(await fx.events(), []);
});

test('GET 原样报告 circuit 隔离原因、贡献、次数和 retryAt', async (t) => {
  const fx = await setup(t);
  const installed = fx.manager!.install(fx.source);
  fx.manager!.confirm('demo', installed.contentHash);
  fx.manager!.setEnabled('demo', installed.contentHash, true);
  fx.manager!.quarantine({
    pluginId: 'demo', contentHash: installed.contentHash, contributionKind: 'hook', contributionName: 'PreToolUse',
    category: 'timeout', message: 'hook timed out',
  }, 3, '2026-10-24T00:00:30.000Z', NOW.toISOString());
  const listed = await call(fx, '/api/plugins');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items[0].state, 'quarantined');
  assert.deepEqual(listed.body.items[0].circuit, {
    state: 'quarantined', contributionKind: 'hook', contributionName: 'PreToolUse', category: 'timeout',
    count: 3, retryAt: '2026-10-24T00:00:30.000Z', lastError: 'hook timed out', strikes: 1,
  });
  assert.equal(JSON.stringify(listed.body).includes('hook timed out'), true);
});
