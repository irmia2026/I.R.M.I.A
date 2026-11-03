import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { InboundPipeline } from '../src/channel/inbound.ts';
import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { defaultVisibility, emptyProjection, type AppEvent, type WakeChannel } from '../src/log/types.ts';
import { PluginManager } from '../src/plugin/manager.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';
import { installPluginPackage } from '../src/plugin/package-store.ts';
import { createHarness, PLUGIN_FIXTURES, type Harness } from './helpers/plugin-runtime-harness.ts';

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
  for (const name of ['plugin-install', 'plugin-confirm', 'plugin-enable', 'plugin-disable', 'plugin-uninstall']) {
    const res = await command(fx, name, {});
    assert.equal(res.status, 501, res.text);
    assert.equal(res.body.error.code, 'not-implemented');
  }
});

test('所有插件写命令都沿用 UI 鉴权与项目确认短语', async (t) => {
  const fx = await setup(t);
  const unauthenticated = await fetch(`${fx.server.url()}/api/plugins`);
  assert.equal(unauthenticated.status, 401);
  for (const name of ['plugin-install', 'plugin-confirm', 'plugin-enable', 'plugin-disable', 'plugin-uninstall']) {
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
  // P1a：视图要能说清"它要什么权限、跑的是什么运行时、现在有没有进程"
  assert.deepEqual(listed.body.items[0].permissions, ['filesystem.read']);
  assert.equal(listed.body.items[0].runtime.type, 'declarative', 'apiVersion 1 的包缺省 declarative');
  assert.equal(listed.body.items[0].pid, null);
  assert.equal(listed.body.items[0].uptimeMs, 0);
});

test('plugin-uninstall：同族确认短语、删包目录、落事件，且不需要重启宿主', async (t) => {
  const fx = await setup(t);
  const installed = fx.manager!.install(fx.source);
  fx.manager!.confirm('demo', installed.contentHash);
  const response = await command(fx, 'plugin-uninstall', { id: 'demo', contentHash: installed.contentHash });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.restartRequired, false);
  assert.equal(response.body.uninstalled.contentHash, installed.contentHash);
  assert.equal(existsSync(installed.rootDir), false, '包目录必须删掉');
  assert.deepEqual(fx.manager!.list(), []);
  assert.deepEqual((await fx.events()).map((event) => event.type), ['plugin/installed', 'plugin/uninstalled']);
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

// ──────────────────────────────── P1b：聊天指令（ctx.commands.define） ────────────────────────────────
//
// 这一半与上面的 HTTP 命令无关（同名文件：上面的 plugin-* 是"界面命令"，这里是"聊天指令"）。
// 真子进程 + 真宿主：指令定义从 IRMIA_TEST_COMMANDS 读，执行/权限/参数校验全在宿主侧。

interface CommandDef {
  name: string;
  aliases?: string[];
  description?: string;
  permission?: 'admin' | 'all';
  args?: Record<string, unknown>;
  reply?: string;
  keepInContext?: boolean;
  mode?: 'throw' | 'hang';
}

function commandState(harness: Harness): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(join(harness.dataDir, 'plugins', 'state', 'demo-commands.json'), 'utf8')) as {
      plugin?: Record<string, unknown>;
    };
    return parsed.plugin ?? {};
  } catch {
    return {};
  }
}

interface CommandRig {
  harness: Harness;
  pipeline: InboundPipeline;
  wakes: WakeChannel['data'][];
  inbox: WakeChannel['data'][];
  replies: Array<{ text?: string }>;
}

async function commandRig(
  t: TestContext,
  definitions: CommandDef[],
  options: { isOwnerMessage?: (message: { senderId: string }) => boolean; shouldWake?: boolean } = {},
): Promise<CommandRig> {
  const harness = await createHarness({
    fixture: 'plugin-commands',
    env: { IRMIA_TEST_COMMANDS: JSON.stringify(definitions) },
    ...(options.isOwnerMessage === undefined ? {} : { isOwnerMessage: options.isOwnerMessage as never }),
  });
  t.after(async () => { await harness.dispose(); });
  await harness.start();
  const wakes: WakeChannel['data'][] = [];
  const inbox: WakeChannel['data'][] = [];
  const replies: Array<{ text?: string }> = [];
  const pipeline = new InboundPipeline({
    plugins: harness.host,
    shouldWake: () => options.shouldWake ?? true,
    isMentioned: () => false,
    wake: (data) => { wakes.push(data); },
    inbox: (data) => { inbox.push(data); },
    reply: async (reply) => { replies.push(reply as { text?: string }); },
    log: () => {},
    now: () => new Date('2026-10-29T12:00:00.000Z'),
  });
  return { harness, pipeline, wakes, inbox, replies };
}

function inbound(text: string): WakeChannel['data'] {
  return {
    channel: 'onebot', chatType: 'c2c', person: 'user-1', chatId: 'user-1',
    text, messageId: `m-${text.length}`, msgSeq: 1,
  };
}

test('聊天指令：/ping 命中 → 回话且不进她的上下文；别名同样生效', async (t) => {
  const rig = await commandRig(t, [{ name: 'ping', aliases: ['p'], reply: 'pong' }]);
  const hit = await rig.pipeline.handle(inbound('/ping'));
  assert.equal(hit.action, 'command');
  assert.equal(hit.command, 'ping');
  assert.deepEqual(rig.replies, [{ text: 'pong' }]);
  assert.deepEqual(rig.wakes, [], '指令命中后不许唤醒她');
  assert.deepEqual(rig.inbox, [], '指令也不进信箱');

  const alias = await rig.pipeline.handle(inbound('/p'));
  assert.equal(alias.action, 'command');
  assert.deepEqual(rig.replies, [{ text: 'pong' }, { text: 'pong' }]);
});

test('聊天指令：args schema 校验失败时回宿主用法文案，handler 一次都不跑', async (t) => {
  const rig = await commandRig(t, [{
    name: 'echo',
    args: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    reply: '不该出现',
  }]);
  const hit = await rig.pipeline.handle(inbound('/echo'));
  assert.equal(hit.action, 'command');
  assert.equal(rig.replies.length, 1);
  assert.equal(rig.replies[0]?.text, '缺少参数 text。用法：/echo <text>');
  assert.equal(commandState(rig.harness)['lastCommand'], undefined, '参数没通过校验就不该调用 handler');

  // 参数合法时才跑 handler，且整段 rest（含空格）作为一个 string 参数
  const ok = await rig.pipeline.handle(inbound('/echo 你好 世界'));
  assert.equal(ok.action, 'command');
  assert.equal(rig.replies[1]?.text, '不该出现');
  const last = commandState(rig.harness)['lastCommand'] as Record<string, unknown>;
  assert.deepEqual(last['args'], { text: '你好 世界' });
});

test('聊天指令：admin 指令拒非用户；用户由宿主 isOwnerMessage 判定', async (t) => {
  const rig = await commandRig(t, [{ name: 'secret', permission: 'admin', reply: '用户好' }], {
    isOwnerMessage: (message) => message.senderId === 'owner-1',
  });
  const guest = await rig.pipeline.handle({ ...inbound('/secret'), person: 'guest-1', chatId: 'guest-1' });
  assert.equal(guest.action, 'command');
  assert.equal(rig.replies[0]?.text, '只有用户可以使用 /secret。');
  assert.deepEqual(rig.wakes, []);

  const owner = await rig.pipeline.handle({ ...inbound('/secret'), person: 'owner-1', chatId: 'owner-1' });
  assert.equal(owner.action, 'command');
  assert.equal(rig.replies[1]?.text, '用户好');
});

test('聊天指令：重名与别名冲突都拒绝后者（不静默覆盖）；宿主内置指令永远赢', async (t) => {
  const duplicateName = await createHarness({
    fixture: 'plugin-commands',
    env: { IRMIA_TEST_COMMANDS: JSON.stringify([{ name: 'ping' }, { name: 'PING' }]) },
  });
  t.after(async () => { await duplicateName.dispose(); });
  await assert.rejects(duplicateName.start(), /已被.*注册|拒绝覆盖/);

  const duplicateAlias = await createHarness({
    fixture: 'plugin-commands',
    env: { IRMIA_TEST_COMMANDS: JSON.stringify([{ name: 'ping', aliases: ['p'] }, { name: 'pong', aliases: ['p'] }]) },
  });
  t.after(async () => { await duplicateAlias.dispose(); });
  await assert.rejects(duplicateAlias.start(), /已被.*注册|拒绝覆盖/);

  const builtin = await createHarness({
    fixture: 'plugin-commands',
    env: { IRMIA_TEST_COMMANDS: JSON.stringify([{ name: 'compact' }]) },
  });
  t.after(async () => { await builtin.dispose(); });
  await assert.rejects(builtin.start(), /内置指令/);
});

test('聊天指令：两个插件抢同一个名字时，后起的那个启动失败（跨插件冲突不静默覆盖）', async (t) => {
  const harness = await createHarness({
    fixture: 'plugin-commands',
    env: { IRMIA_TEST_COMMANDS: JSON.stringify([{ name: 'ping', reply: 'pong' }]) },
  });
  t.after(async () => { await harness.dispose(); });
  await harness.start();

  const source = tempDirSync('irmia-plugin-commands-b-');
  cpSync(join(PLUGIN_FIXTURES, 'plugin-commands'), source, { recursive: true });
  const manifestPath = join(source, 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, id: 'demo-commands-b' }, null, 2));
  const second = installPluginPackage(source, harness.dataDir);
  await assert.rejects(harness.host.startPackage(second), /已被插件 demo-commands|拒绝覆盖/);
});

test('聊天指令：没命中 = 照常进上下文；keepInContext=true 时命中也不拦', async (t) => {
  const rig = await commandRig(t, [
    { name: 'ping', reply: 'pong' },
    { name: 'keep', reply: '同时回话', keepInContext: true },
  ]);
  const miss = await rig.pipeline.handle(inbound('/nope 随便说点什么'));
  assert.equal(miss.action, 'wake');
  assert.equal(rig.wakes[0]?.text, '/nope 随便说点什么');

  const keep = await rig.pipeline.handle(inbound('/keep'));
  assert.equal(keep.action, 'wake', 'handler 显式 keepInContext 时继续进上下文');
  assert.equal(rig.wakes[1]?.text, '/keep');
  assert.equal(rig.replies[0]?.text, '同时回话');
});

test('聊天指令：handler 报错回宿主文案、不进上下文（不泄露插件内部细节）', async (t) => {
  const rig = await commandRig(t, [{ name: 'boom', mode: 'throw' }]);
  const hit = await rig.pipeline.handle(inbound('/boom'));
  assert.equal(hit.action, 'command');
  assert.equal(rig.replies[0]?.text, '/boom 执行失败，请稍后再试。');
  assert.equal(rig.replies[0]?.text?.includes('command boom'), false);
  assert.deepEqual(rig.wakes, []);
});
