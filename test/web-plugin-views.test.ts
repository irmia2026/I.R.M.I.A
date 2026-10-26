/**
 * 管理视图必须看得见插件贡献（评审 #9），MCP 探测宿主上报的版本必须取版本真源（评审 #12-b）。
 *
 * 为什么直接调私有视图：这两条缺陷都不在路由层——`/api/skills` 与 `/api/mcp` 只是把
 * `skillsView()` / `mcpView()` 的返回体转手发出去。直调视图能钉住"插件贡献在不在"这一件事，
 * 不必为它铺一套 HTTP 夹具；唯一走 HTTP 的是 §12-b：那条链路的价值就在"真拉起一个 MCP 进程、
 * 看它收到的 clientInfo"，绕开路由反而验不到。
 *
 * 三组断言：
 *   ① 注入 `pluginRuntime` ⇒ 插件技能进扫描与 catalog、插件 MCP server 带 source/pluginId/contentHash；
 *   ② 不注入 ⇒ 两个视图与接插件之前一致（只扫内置两根、只列 config.json 的声明，且不报错）；
 *   ③ 插件与内置重名 ⇒ 内置优先、插件那条跳过并在 problems 里说清（不整页失败）。
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { emptyProjection } from '../src/log/types.ts';
import type { PluginRuntimeComposition } from '../src/plugin/runtime.ts';
import { AGENT_VERSION } from '../src/version.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const TOKEN = 'web-plugin-views-token';
const NOW = new Date('2026-10-26T00:00:00.000Z');
const FAKE_MCP = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

/**
 * 私有视图的直调口。`as any` 只收敛在这一处：视图是类里的 private，
 * 而它们的返回体正是这两个接口对外的形状——没有别的路能钉住"返回体里有没有插件那一格"。
 */
interface PrivateViews {
  skillsView: (options?: { rescan?: boolean }) => Promise<Record<string, unknown>>;
  mcpView: () => Promise<Record<string, unknown>>;
}
const viewsOf = (server: WebServer): PrivateViews => server as unknown as PrivateViews;

interface Fixture {
  dir: string;
  dataDir: string;
  skillsRoot: string;
  pluginSkillsRoot: string;
  server: WebServer;
}

/** 写一个合法的技能目录：frontmatter 的 name 必须与目录名一致（SkillManager 的硬要求） */
function writeSkill(root: string, name: string, description: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, 'utf8');
}

/**
 * 一份最小的插件运行组合面：只放 `skillsView` / `mcpView` 真读的那几格。
 *
 * 刻意不经过 PluginManager 装一个真包：那会把用例拖进安装/信任状态机（由别的用例负责），
 * 而这里要钉的是"视图会不会把组合面里已有的贡献摆出来"。
 */
function compositionOf(pluginSkillsRoot: string): PluginRuntimeComposition {
  return {
    packages: [{ manifest: { id: 'demo' }, contentHash: 'hash-demo' }],
    revision: 'revision-demo',
    skillRoots: [{ dir: pluginSkillsRoot, rootName: 'plugin-package/skills', packageHash: 'hash-demo' }],
    hookEntries: [],
    mcpServers: [{ name: 'demo__chat', command: 'node', args: ['chat.mjs'] }],
    warnings: [],
  } as unknown as PluginRuntimeComposition;
}

/** 建一个独立临时工程：config.json（可含一条与插件重名的内置声明）+ 内置技能根 + 插件技能根 */
async function setup(t: TestContext, options: { plugin?: boolean; conflict?: boolean } = {}): Promise<Fixture> {
  const dir = tempDirSync('irmia-web-plugin-views-');
  const dataDir = join(dir, 'data');
  const personaRoot = join(dataDir, 'persona');
  const skillsRoot = join(dir, 'project');
  const configPath = join(dir, 'config.json');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(personaRoot, { recursive: true });
  mkdirSync(join(skillsRoot, 'skills'), { recursive: true });

  writeSkill(join(skillsRoot, 'skills'), 'builtin-skill', '内置技能根里的技能（本用例不写信任事件 ⇒ 不进 catalog）');

  const pluginSkillsRoot = join(dir, 'plugin-package', 'skills');
  writeSkill(pluginSkillsRoot, 'plugin-skill', '插件包带进来的技能（整包已确认 ⇒ 直接进 catalog）');

  const configServers: Array<Record<string, unknown>> = [{ name: 'builtin', command: 'node', args: [] }];
  if (options.conflict === true) configServers.push({ name: 'demo__chat', command: 'node', args: ['builtin-chat.mjs'] });
  writeFileSync(
    configPath,
    `${JSON.stringify({ schemaVersion: 1, mcp: { servers: configServers } }, null, 2)}\n`,
    'utf8',
  );

  const log = await EventLog.open(join(dataDir, 'events'));
  const server = await startWebServer({
    log,
    projection: emptyProjection(),
    config: defaultConfig(dir),
    personaRoot,
    dataDir,
    timers: new TimerStore(join(dataDir, 'timers.json'), { now: () => NOW }),
    now: () => NOW,
    skillsRoot,
    uiToken: TOKEN,
    configPath,
    port: 0,
    ...(options.plugin === true ? { pluginRuntime: () => compositionOf(pluginSkillsRoot) } : {}),
  });
  t.after(async () => {
    await server.close();
    log.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发的句柄占用：清理失败不改变断言结论 */
    }
  });
  return { dir, dataDir, skillsRoot, pluginSkillsRoot, server };
}

// ──────────────────────────────── ① §9 · skillsView ────────────────────────────────

test('skillsView：插件技能根接进来，插件技能直接进 catalog（评审 #9）', async (t) => {
  const fx = await setup(t, { plugin: true });
  const view = await viewsOf(fx.server).skillsView();
  const items = view.items as Array<Record<string, unknown>>;
  assert.deepEqual(
    items.map((item) => String(item.name)).sort(),
    ['builtin-skill', 'plugin-skill'],
    '插件技能根必须参与扫描',
  );

  const pluginItem = items.find((item) => item.name === 'plugin-skill');
  assert.ok(pluginItem !== undefined, '插件贡献的技能没进扫描结果');
  assert.equal(pluginItem['rootName'], 'plugin-package/skills', 'rootName 要能指回插件根');
  assert.equal(typeof pluginItem['contentHash'], 'string', '每条仍带着自己的内容哈希（技能文件那一份）');
  assert.equal(pluginItem['trust'], 'trusted', '整包已确认的技能不该再要求单独确认');
  assert.equal(pluginItem['inCatalog'], true);

  const entries = view.entries as Array<{ name: string }>;
  assert.deepEqual(entries.map((entry) => entry.name), ['plugin-skill'], '插件技能必须真进 catalog');

  assert.deepEqual(view.pluginRoots, [{
    rootName: 'plugin-package/skills',
    dir: fx.pluginSkillsRoot,
    packageHash: 'hash-demo',
  }], '返回体要能看出哪些技能根来自插件');
  assert.ok((view.roots as string[]).includes(fx.pluginSkillsRoot), '扫描根清单里要有插件根');
});

test('skillsView：未注入 pluginRuntime 时只扫内置两根（与今日一致）', async (t) => {
  const fx = await setup(t);
  const view = await viewsOf(fx.server).skillsView();
  assert.deepEqual(
    (view.items as Array<Record<string, unknown>>).map((item) => item.name),
    ['builtin-skill'],
    '没有组合面时不许冒出插件技能',
  );
  assert.deepEqual(view.entries, [], '内置技能没有信任事件 ⇒ 照旧不进 catalog');
  assert.deepEqual(view.pluginRoots, [], '没注入时这一格是空数组，不是 undefined/501');
  // 内置技能没被信任 ⇒ catalog 照旧给一条 pending 警告；关键是**没有**插件那一侧的任何字
  assert.ok(
    (view.warnings as string[]).every((line) => !line.includes('plugin-skill')),
    '未注入组合面时警告里不该出现插件技能',
  );
  assert.equal((view.roots as string[]).length, 2, '两个内置根（不存在的那一个也在清单里，这是既有口径）');
});

// ──────────────────────────────── ② §9 · mcpView ────────────────────────────────

test('mcpView：插件 MCP 声明并进视图，逐项标 source 与归属（评审 #9）', async (t) => {
  const fx = await setup(t, { plugin: true });
  const view = await viewsOf(fx.server).mcpView();
  const servers = view.servers as Array<Record<string, unknown>>;
  assert.deepEqual(
    servers.map((server) => String(server.name)).sort(),
    ['builtin', 'demo__chat'],
    '插件贡献的 server 必须出现在视图里',
  );

  const pluginServer = servers.find((server) => server.name === 'demo__chat');
  assert.ok(pluginServer !== undefined, '插件 MCP server 没进视图');
  assert.equal(pluginServer['source'], 'plugin');
  assert.equal(pluginServer['pluginId'], 'demo');
  assert.equal(pluginServer['contentHash'], 'hash-demo');
  assert.equal(pluginServer['state'], 'never-started', '日志里没有它的事件 ⇒ 照实说从未启动');

  const builtinServer = servers.find((server) => server.name === 'builtin');
  assert.equal(builtinServer?.['source'], 'config');
  assert.equal(builtinServer?.['pluginId'], null);

  const configured = view.configured as Array<Record<string, unknown>>;
  assert.deepEqual(configured.map((entry) => entry.name), ['builtin', 'demo__chat']);
  assert.deepEqual(configured.map((entry) => entry.source), ['config', 'plugin']);
  assert.deepEqual(view.problems, []);
});

test('mcpView：插件与内置重名 ⇒ 内置优先，插件那条跳过并报冲突（不整页失败）', async (t) => {
  const fx = await setup(t, { plugin: true, conflict: true });
  const view = await viewsOf(fx.server).mcpView();
  const servers = view.servers as Array<Record<string, unknown>>;
  const chat = servers.filter((server) => server.name === 'demo__chat');
  assert.equal(chat.length, 1, '重名在视图里只能剩一条');
  assert.equal(chat[0]?.['source'], 'config', '内置声明优先（与执行面 mergeMcpDeclarations 的拒绝方向一致）');
  assert.deepEqual(chat[0]?.['args'], ['builtin-chat.mjs'], '留下来的必须是 config.json 那一条');

  const problems = view.problems as string[];
  assert.equal(problems.length, 1, '冲突要如实报一条，不能静默');
  assert.match(problems[0]!, /demo__chat/u);
  assert.match(problems[0]!, /内置优先/u);
});

test('mcpView：未注入 pluginRuntime 时只列 config.json 的声明（与今日一致）', async (t) => {
  const fx = await setup(t);
  const view = await viewsOf(fx.server).mcpView();
  const servers = view.servers as Array<Record<string, unknown>>;
  assert.deepEqual(servers.map((server) => server.name), ['builtin']);
  assert.deepEqual((view.configured as Array<Record<string, unknown>>).map((entry) => entry.name), ['builtin']);
  assert.deepEqual(view.problems, []);
  assert.equal(servers[0]?.['source'], 'config');
});

// ──────────────────────────────── ③ §12-b · 探测宿主的 clientInfo ────────────────────────────────

test('mcp-test：探测宿主上报的 clientInfo.version = AGENT_VERSION（评审 #12-b）', async (t) => {
  const fx = await setup(t);
  const marker = join(fx.dir, 'mcp-marker');
  const response = await fetch(`${fx.server.url()}/api/commands/mcp-test`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'x-confirm': 'mcp-test',
    },
    body: JSON.stringify({
      name: 'probe',
      command: process.execPath,
      args: [FAKE_MCP],
      env: { FAKE_MCP_MARKER_DIR: marker },
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text) as { ok: boolean; reason: string | null };
  assert.equal(body.ok, true, body.reason ?? '');

  // server 侧夹具把 initialize 的 clientInfo 原样记进 marker（见 test/fixtures/fake-mcp-server.mjs）
  const journal = readFileSync(join(marker, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { t: string; clientInfo?: { name?: string; version?: string } });
  const initialize = journal.find((entry) => entry.t === 'initialize');
  assert.ok(initialize !== undefined, '握手确实发出去过');
  assert.equal(initialize.clientInfo?.name, 'irmia-agent');
  assert.equal(initialize.clientInfo?.version, AGENT_VERSION, '探测宿主自报的版本必须是 src/version.ts 那一份');
});
