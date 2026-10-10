/**
 * 扩展页写命令测试 — src/web/server.ts 的 skill-ignore / skill-create / mcp-test / mcp-save /
 * mcp-remove / hook-save / hook-remove
 *
 * 为什么单独一个文件而不是塞进 web-server.test.ts：这一组的断言对象不是 HTTP 契约，
 * 而是**三份落盘文件**（config.json 的 mcp.servers、data/hooks.json、data/skills-ignored.json）
 * 与一条"会真起进程"的命令。它们各自的失败模式不同（配置回滚 / 钩子条目被跳过 / 子进程没收干净），
 * 分开摆才好按主题读。
 *
 * 三条纪律（与 web-server.test.ts 同源）：
 *   1. 一个用例一个独立临时目录：这几条命令都真写文件；
 *   2. 断言首选"盘上/日志里有什么"，其次才是响应体——HTTP 层只是通道；
 *   3. **只 import 已经存在的符号**：这样把实现回退到旧版本时，这个文件仍能加载、
 *      用例会以"断言不成立"变红，而不是整个文件在导入期就炸（那叫假锁，见 review v27）。
 *
 * 本文件只碰 HTTP 与 node 标准库：验证"拿旧实现会红"时，红的理由才是可读的。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';

import { defaultConfig, type AppConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { emptyProjection, defaultVisibility } from '../src/log/types.ts';
import type { AppEvent, Projection } from '../src/log/types.js';
import { applyOne } from '../src/state/fold.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const T0 = new Date('2026-10-01T10:00:00.000Z');
/** fixture 的 now 固定为 T0：删除落点的时间戳前缀因此是确定的（与 compactTimestamp 同格式） */
const compactStamp = T0.toISOString().replace(/[:.]/gu, '-');
const TEST_TOKEN = 'test-token-expansions-01';
const FIXTURES = dirname(fileURLToPath(import.meta.url));
const FAKE_MCP = join(FIXTURES, 'fixtures', 'fake-mcp-server.mjs');
const HANG_MCP = join(FIXTURES, 'fixtures', 'hang-mcp-server.mjs');

interface Fixture {
  dir: string;
  dataDir: string;
  configPath: string;
  skillsRoot: string;
  log: EventLog;
  config: AppConfig;
  registry: ToolRegistry;
  server: WebServer;
  base: string;
  /** 服务端诊断出口收到的行（`[web] skill-remove ...` 这类留痕靠它证明） */
  logLines: string[];
  readAll(): Promise<AppEvent[]>;
  configDoc(): Record<string, unknown>;
}

/** 建一个独立的临时工程：config.json + skills/ + data/，服务端指向它们 */
async function setup(
  t: TestContext,
  options: {
    /**
     * **配置热更接线**（2026-10-11 加）：给 `true` = 这台夹具"有人接管配置变化"
     * （生产上就是 main.ts 里那个 `() => configWatcher.live`），`mcp-save` / `mcp-remove`
     * 的回执因此说 `restartRequired: false`。
     *
     * 缺省**不给**（= 没接线）是刻意的：本文件绝大多数用例关心的不是这一格，
     * 而"没接线"正是这些夹具的真实形状——回执照旧说"要重启"，不给它们添一处假话。
     * 只有专门钉这一格的用例才传 `{ configReload: true }`。
     */
    configReload?: boolean;
  } = {},
): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-ext-'));
  const dataDir = join(dir, 'data');
  const eventsDir = join(dataDir, 'events');
  const personaRoot = join(dataDir, 'persona');
  const configPath = join(dir, 'config.json');
  // 技能根基准**另开一层**：SkillManager 会在它下面找 skills/<name>/SKILL.md，
  // 直接拿工程根当基准的话，工程里的 skills/ 与 data/ 会互相看成技能目录（data 缺 SKILL.md 会被列进 rejected）
  const skillsRoot = join(dir, 'project');

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dir, 'project', 'skills'), { recursive: true });
  mkdirSync(personaRoot, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({ schemaVersion: 1 }, null, 2)}\n`, 'utf8');

  const log = await EventLog.open(eventsDir);
  const projection: Projection = emptyProjection();
  const now = (): Date => T0;
  const registry = new ToolRegistry();
  const logLines: string[] = [];

  const config = defaultConfig(dir);
  const timers = new TimerStore(join(dataDir, 'timers.json'), { now });
  const server = await startWebServer({
    log,
    projection,
    config,
    personaRoot,
    dataDir,
    timers,
    now,
    registry,
    skillsRoot,
    uiToken: TEST_TOKEN,
    configPath,
    port: 0,
    out: (line) => { logLines.push(line); },
    ...(options.configReload === true ? { configReload: () => true } : {}),
  });

  t.after(async () => {
    await server.close();
    log.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发的句柄占用：清理失败不影响断言结论 */
    }
  });

  return {
    dir,
    dataDir,
    configPath,
    skillsRoot,
    log,
    config,
    registry,
    server,
    base: server.url(),
    logLines,
    readAll: async () => {
      const out: AppEvent[] = [];
      for await (const event of log.readAll()) out.push(event);
      return out;
    },
    configDoc: () => JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>,
  };
}

interface Res {
  status: number;
  body: unknown;
  text: string;
}

async function call(fx: Fixture, path: string, input: { method?: string; body?: unknown; confirm?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { authorization: `Bearer ${TEST_TOKEN}` };
  if (input.body !== undefined) headers['content-type'] = 'application/json';
  if (input.confirm !== undefined) headers['x-confirm'] = input.confirm;
  const response = await fetch(`${fx.base}${path}`, {
    method: input.method ?? 'GET',
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

/** 命令 POST 的简写：确认短语默认与命令同名（危险操作都登记成命令名） */
async function command(fx: Fixture, name: string, body: unknown, confirm?: string): Promise<Res> {
  return await call(fx, `/api/commands/${name}`, { method: 'POST', body, confirm: confirm ?? name });
}

function errorCode(res: Res): string {
  return (res.body as { error?: { code?: string } } | null)?.error?.code ?? '';
}

/** 一条技能的 SKILL.md（frontmatter 两字段就够，name 必须与目录同名） */
function skillFile(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: "${description}"\n---\n\n正文。\n`;
}

function writeSkill(fx: Fixture, name: string, description = '这是一条用于测试的技能描述，够长以避开模糊告警'): void {
  writeSkillUnder(fx, 'skills', name, description);
}

/** 指定技能根写一条技能：`.agents/skills/` 那侧也要能测（删除必须两个根都认） */
function writeSkillUnder(
  fx: Fixture,
  rootName: string,
  name: string,
  description = '这是一条用于测试的技能描述，够长以避开模糊告警',
): string {
  const dir = join(fx.skillsRoot, rootName, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillFile(name, description), 'utf8');
  return dir;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

// ──────────────────────────────── 技能：忽略落盘 + 新建骨架 ────────────────────────────────

test('skill-ignore：忽略落盘到 data/skills-ignored.json，/api/skills 一并回传', async (t) => {
  const fx = await setup(t);
  writeSkill(fx, 'demo-skill');
  writeSkill(fx, 'other-skill');

  // 忽略前：两份都在 pending 段（inCatalog=false 且 ignored=false）
  const before = await call(fx, '/api/skills');
  assert.equal(before.status, 200);
  const beforeView = before.body as { items: Array<{ name: string; ignored: boolean }>; ignored: string[] };
  assert.deepEqual(beforeView.ignored, [], '还没忽略过谁，ignored 应是空数组');
  assert.equal(beforeView.items.find((item) => item.name === 'demo-skill')?.ignored, false);

  const res = await command(fx, 'skill-ignore', { name: 'demo-skill', ignored: true });
  assert.equal(res.status, 200, res.text);
  // 落盘位置与格式：<dataDir>/skills-ignored.json = {"<name>": true}
  const file = join(fx.dataDir, 'skills-ignored.json');
  assert.ok(existsSync(file), '忽略必须落盘（不再是前端内存里的一个集合）');
  assert.deepEqual(readJson<Record<string, unknown>>(file), { 'demo-skill': true });

  const after = await call(fx, '/api/skills');
  const afterView = after.body as { items: Array<{ name: string; ignored: boolean }>; ignored: string[] };
  assert.deepEqual(afterView.ignored, ['demo-skill']);
  assert.equal(afterView.items.find((item) => item.name === 'demo-skill')?.ignored, true);
  assert.equal(afterView.items.find((item) => item.name === 'other-skill')?.ignored, false);

  // 不被忽略的技能不进那份文件：它是"人看过了"的备忘，不是技能清单
  assert.equal(Object.keys(readJson<Record<string, unknown>>(file)).length, 1);

  // 恢复：从文件里删掉
  await command(fx, 'skill-ignore', { name: 'demo-skill', ignored: false });
  assert.deepEqual(readJson<Record<string, unknown>>(file), {});
  const restored = (await call(fx, '/api/skills')).body as { items: Array<{ name: string; ignored: boolean }> };
  assert.equal(restored.items.find((item) => item.name === 'demo-skill')?.ignored, false);
});

test('skill-ignore：忽略一个扫描不到的技能名 → 404（不写僵尸记录）', async (t) => {
  const fx = await setup(t);
  const res = await command(fx, 'skill-ignore', { name: 'never-existed', ignored: true });
  assert.equal(res.status, 404, res.text);
  assert.equal(errorCode(res), 'skill-not-found');
  assert.equal(existsSync(join(fx.dataDir, 'skills-ignored.json')), false, '没写成功就不该留下一个空文件');
});

test('skill-ignore：写忽略不写事件（界面备忘不是 agent 状态）', async (t) => {
  const fx = await setup(t);
  writeSkill(fx, 'demo-skill');
  await command(fx, 'skill-ignore', { name: 'demo-skill', ignored: true });
  const events = await fx.readAll();
  assert.equal(events.length, 0, '忽略既不改能力边界也不是她的状态：事件日志里不该有任何记录');
});

test('skill-ignore：盘上的备忘留痕，但界面只看到扫得到的名字（不摆"查无此技"）', async (t) => {
  const fx = await setup(t);
  writeSkill(fx, 'demo-skill');
  writeSkill(fx, 'soon-gone');
  await command(fx, 'skill-ignore', { name: 'demo-skill', ignored: true });
  await command(fx, 'skill-ignore', { name: 'soon-gone', ignored: true });

  // 技能目录被删掉（用户自己的事）：盘上的备忘不动，界面上那一条要跟着消失
  rmSync(join(fx.skillsRoot, 'skills', 'soon-gone'), { recursive: true, force: true });
  const view = (await call(fx, '/api/skills')).body as {
    ignored: string[];
    ignoredOnDisk: string[];
    items: Array<{ name: string }>;
  };
  assert.deepEqual(view.ignored, ['demo-skill'], '界面口径：只回传扫描得到的名字');
  assert.deepEqual(
    view.ignoredOnDisk,
    ['demo-skill', 'soon-gone'],
    '盘上那份备忘只增不减（"看过了"不该因为目录暂时读不到就忘掉）；全量只给排障看',
  );
  assert.equal(view.items.some((item) => item.name === 'soon-gone'), false);

  // 恢复仍然按名字删得掉（哪怕它已经扫不到）
  await command(fx, 'skill-ignore', { name: 'soon-gone', ignored: false });
  assert.deepEqual(
    readJson<Record<string, unknown>>(join(fx.dataDir, 'skills-ignored.json')),
    { 'demo-skill': true },
  );
});

test('tool-toggle：并发发一整组也不丢更新（服务端那条性质要有用例钉着）', async (t) => {
  const fx = await setup(t);
  // 界面上的「全关」是 N 条 `tool-toggle`（现在一条一条发；并发到达也必须是安全的）。
  // 这条用例钉的是服务端那条性质：**五条并发命令一条都不许丢，也不许成片 500**。
  //
  // 它当初是红的，而且红得有信息量：
  //   `EPERM: operation not permitted, rename '…config.json.tmp.N' -> '…config.json'`，
  //   5 条里 4 条 500。根因不是"rename 撞车"这么笼统——是 `loadConfig` 的**异步读句柄还在飞**
  //   （Windows 的 `MoveFileEx(REPLACE_EXISTING)` 碰上有句柄打开的目标就回 EPERM，
  //   而这与 POSIX 的"先解除链接"语义不同）。退避重试 60ms/320ms/1s 都无效，
  //   因为那个读要等线程池回话。
  //
  // 现在由 `configFileLock` 兜住（读-改-写整段互斥），并且在**同一个临界区里**更新内存注册表
  // ——两处都做过才会绿。谁把闸拆了、或者把 `registry.setDisabled` 挪出临界区，这条先红。
  const names = ['safe_read', 'safe_write', 'pwsh', 'todo', 'speak'];
  for (const name of names) {
    fx.registry.register({
      name,
      description: '测试工具',
      parameters: { type: 'object', properties: {} },
      executionMode: 'exclusive',
      sideEffect: 'none',
      timeoutMs: 1000,
      handler: async () => ({ content: 'ok' }),
    });
  }

  const responses = await Promise.all(
    names.map((name) => command(fx, 'tool-toggle', { name, enabled: false })),
  );
  for (const [index, res] of responses.entries()) {
    assert.equal(res.status, 200, `${names[index]} 的开关应当成功：${res.text}`);
  }

  const disabled = (fx.configDoc() as { tools?: { disabled?: string[] } }).tools?.disabled ?? [];
  assert.deepEqual(
    [...disabled].sort(),
    [...names].sort(),
    '五条并发命令一条都不许丢：丢一条就是"界面上全关了、其实还开着"',
  );
  assert.deepEqual([...fx.registry.disabledNames()].sort(), [...names].sort(), '内存注册表与配置要在同一状态');
});

test('tool-toggle：并发两次之后两件工具的状态都对（防"不报错但丢更新"）', async (t) => {
  const fx = await setup(t);
  // 上一條锁的是"不许 500"。这一条锁的是更坏的一种结局：**不报错但丢更新**
  // ——两条命令各自读到同一份旧名单、各加一项，后写的那个把前一个抹掉。
  // 所以断言不看状态码，只看**两件工具是不是都进了名单**（以及内存注册表与盘上一致）。
  for (const name of ['alpha_tool', 'beta_tool']) {
    fx.registry.register({
      name,
      description: '测试工具',
      parameters: { type: 'object', properties: {} },
      executionMode: 'exclusive',
      sideEffect: 'none',
      timeoutMs: 1000,
      handler: async () => ({ content: 'ok' }),
    });
  }

  const [first, second] = await Promise.all([
    command(fx, 'tool-toggle', { name: 'alpha_tool', enabled: false }),
    command(fx, 'tool-toggle', { name: 'beta_tool', enabled: false }),
  ]);
  assert.equal(first.status, 200, first.text);
  assert.equal(second.status, 200, second.text);

  const disabled = (fx.configDoc() as { tools?: { disabled?: string[] } }).tools?.disabled ?? [];
  assert.deepEqual([...disabled].sort(), ['alpha_tool', 'beta_tool'], '两件都要在盘上，一件都不能被盖掉');
  assert.deepEqual(
    [...fx.registry.disabledNames()].sort(),
    ['alpha_tool', 'beta_tool'],
    '内存里也要两件都在（注册表更新与落盘在同一个临界区里）',
  );

  // 反方向也一样：并发打开两件，名单要清空
  const [third, fourth] = await Promise.all([
    command(fx, 'tool-toggle', { name: 'alpha_tool', enabled: true }),
    command(fx, 'tool-toggle', { name: 'beta_tool', enabled: true }),
  ]);
  assert.equal(third.status, 200, third.text);
  assert.equal(fourth.status, 200, fourth.text);
  const after = (fx.configDoc() as { tools?: { disabled?: string[] } }).tools?.disabled ?? [];
  assert.deepEqual(after, [], '两件都开回来之后名单应当为空');
  assert.deepEqual(fx.registry.disabledNames(), []);
});

test('skill-create：按规范拼出 SKILL.md 骨架，落进待确认（不写 skill/installed）', async (t) => {
  const fx = await setup(t);
  const res = await command(fx, 'skill-create', {
    name: 'morning-review',
    description: '每天早上整理昨天的进展并落一份摘要，用于回顾与交接',
  });
  assert.equal(res.status, 200, res.text);
  const body = res.body as { skillPath: string; relDir: string; needsConfirm: boolean; file: string };
  assert.equal(body.needsConfirm, true, '新目录不构成信任：界面据此摆进「待确认」');

  const file = join(fx.skillsRoot, 'skills', 'morning-review', 'SKILL.md');
  assert.ok(existsSync(file), `骨架必须落在 ${file}`);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^---\n/u, 'frontmatter 必须以一行 --- 开头');
  assert.match(text, /\nname: morning-review\n/u);
  assert.match(text, /\ndescription: "每天早上整理昨天的进展并落一份摘要，用于回顾与交接"\n/u);
  assert.ok(text.includes('## 步骤'), '骨架要给出正文的分节，别只留一句提示');

  // 回读：扫描器认下它，且它**不在 catalog**（信任门未过）
  const view = (await call(fx, '/api/skills')).body as {
    items: Array<{ name: string; inCatalog: boolean; trust: string; skillPath: string }>;
  };
  const created = view.items.find((item) => item.name === 'morning-review');
  assert.ok(created !== undefined, '新建的技能要出现在 /api/skills 的清单里');
  assert.equal(created.inCatalog, false);
  assert.equal(created.trust, 'never-confirmed');
  assert.equal(created.skillPath, 'skills/morning-review/SKILL.md');
  assert.equal(body.skillPath, 'skills/morning-review/SKILL.md');

  // 事件日志：只有 skill-confirm 才写 skill/installed，新建不写
  const events = await fx.readAll();
  assert.equal(events.filter((event) => event.type === 'skill/installed').length, 0);
});

test('skill-create：名字不合法 / 目录已存在 → 拒绝，且不动盘上的东西', async (t) => {
  const fx = await setup(t);

  const badName = await command(fx, 'skill-create', { name: '晨间总结', description: '每天整理' });
  assert.equal(badName.status, 400, badName.text);
  assert.equal(errorCode(badName), 'bad-skill-name');
  assert.equal(existsSync(join(fx.skillsRoot, 'skills', '晨间总结')), false);

  const noDesc = await command(fx, 'skill-create', { name: 'ok-name', description: '   ' });
  assert.equal(noDesc.status, 400, 'description 是唯一触发机制，不能空');
  assert.equal(existsSync(join(fx.skillsRoot, 'skills', 'ok-name')), false);

  // 已存在的目录不覆盖：那可能是一个已经确认过的技能，覆盖等于绕开信任门
  writeSkill(fx, 'demo-skill', '原有描述，一个字都不该被改掉');
  const before = readFileSync(join(fx.skillsRoot, 'skills', 'demo-skill', 'SKILL.md'), 'utf8');
  const conflict = await command(fx, 'skill-create', { name: 'demo-skill', description: '新描述' });
  assert.equal(conflict.status, 409, conflict.text);
  assert.equal(errorCode(conflict), 'skill-exists');
  assert.equal(readFileSync(join(fx.skillsRoot, 'skills', 'demo-skill', 'SKILL.md'), 'utf8'), before);
});

test('skill-confirm：确认顺带把该技能移出「已忽略」清单（两段不能同时出现同一条）', async (t) => {
  const fx = await setup(t);
  writeSkill(fx, 'demo-skill');
  await command(fx, 'skill-ignore', { name: 'demo-skill', ignored: true });
  assert.deepEqual(readJson<Record<string, unknown>>(join(fx.dataDir, 'skills-ignored.json')), { 'demo-skill': true });

  const confirmed = await command(fx, 'skill-confirm', { name: 'demo-skill' });
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.deepEqual(
    readJson<Record<string, unknown>>(join(fx.dataDir, 'skills-ignored.json')),
    {},
    '确认之后还留在已忽略清单里，界面会把它同时摆进两段',
  );
  const events = await fx.readAll();
  assert.equal(events.filter((event) => event.type === 'skill/installed').length, 1, '确认的唯一凭据仍是那条事件');
});

// ──────────────────────────────── 技能：删除（移进回收站） ────────────────────────────────

/** 删除请求的简写：短语是命令名（危险操作），调用点显式写出来，免得看不出门在哪 */
async function removeSkill(fx: Fixture, name: unknown, confirm = 'skill-remove'): Promise<Res> {
  return await call(fx, '/api/skills/remove', { method: 'POST', body: { name }, confirm });
}

test('skill-remove：缺 X-Confirm 或短语写错 → 400 拒绝，技能目录还在原处', async (t) => {
  const fx = await setup(t);
  const dir = writeSkillUnder(fx, 'skills', 'demo-skill');

  // ① 头整个缺失
  const missing = await call(fx, '/api/skills/remove', { method: 'POST', body: { name: 'demo-skill' } });
  assert.equal(missing.status, 400, missing.text);
  assert.equal(errorCode(missing), 'confirm-required');
  assert.match((missing.body as { error: { message: string } }).error.message, /skill-remove/u);

  // ② 短语写错（拿了邻居 hook-remove 的短语）：也必须拒
  const wrong = await removeSkill(fx, 'demo-skill', 'hook-remove');
  assert.equal(wrong.status, 400, wrong.text);
  assert.equal(errorCode(wrong), 'confirm-required');

  assert.ok(existsSync(join(dir, 'SKILL.md')), '被拒的请求不许动盘上的东西');
  assert.equal(existsSync(join(fx.dataDir, 'trash')), false, '被拒的请求连回收站都不该建');
});

test('skill-remove：正常删除把目录移进 data/trash/<时间戳>-<名字>/，内容一个字节不改', async (t) => {
  const fx = await setup(t);
  const dir = writeSkillUnder(fx, 'skills', 'demo-skill', '删了要能捞回来的那条技能描述');
  const before = readFileSync(join(dir, 'SKILL.md'), 'utf8');

  const res = await removeSkill(fx, 'demo-skill');
  assert.equal(res.status, 200, res.text);
  const body = res.body as { relDir: string; rootName: string; movedTo: string; restore: string };
  assert.equal(body.relDir, 'skills/demo-skill');
  assert.equal(body.rootName, 'skills');

  // ① 原处真的没了（不是"复制一份进回收站，原目录还留着"）
  assert.equal(existsSync(dir), false, '删完 skills/ 下不该还有这个目录');
  // ② 回收站里找得到，且内容完整
  const park = join(fx.dataDir, 'trash', `${compactStamp}-demo-skill`);
  assert.equal(body.movedTo, park);
  assert.equal(readFileSync(join(park, 'SKILL.md'), 'utf8'), before, '回收站里必须是原件，不许改写');
  assert.equal(dirname(park), join(fx.dataDir, 'trash'));
  assert.equal(basename(park), `${compactStamp}-demo-skill`, '落点名 = <紧凑时间戳>-<技能名>');
  assert.match(body.restore, /恢复/u, '响应要带上"怎么捞回来"，否则人只看到一个搬走的路径');

  // ③ 界面那条线立刻跟着变（扫描每次现扫，不缓存）
  const view = (await call(fx, '/api/skills')).body as { items: Array<{ name: string }> };
  assert.equal(view.items.some((item) => item.name === 'demo-skill'), false, '删完 /api/skills 里不该还有它');
  // ④ 留痕：一行 web 日志；但**不写事件**（schema 里没有"技能已删除"这种类型，塞近似事件就是脏数据）
  assert.ok(
    fx.logLines.some((line) => line.includes('skill-remove') && line.includes('skills/demo-skill')),
    `删除要在诊断日志里留一行，实际收到：${JSON.stringify(fx.logLines)}`,
  );
  assert.equal(
    (await fx.readAll()).filter((event) => event.type.startsWith('skill/')).length,
    0,
    '删除不写事件',
  );
});

test('skill-remove：两个技能根都认（.agents/skills/ 放的技能也删得掉）', async (t) => {
  const fx = await setup(t);
  const dir = writeSkillUnder(fx, '.agents/skills', 'cross-client-skill');

  const res = await removeSkill(fx, 'cross-client-skill');
  assert.equal(res.status, 200, res.text);
  const body = res.body as { relDir: string; rootName: string; movedTo: string };
  assert.equal(body.rootName, '.agents/skills');
  assert.equal(body.relDir, '.agents/skills/cross-client-skill');
  assert.equal(existsSync(dir), false);
  assert.ok(existsSync(join(body.movedTo, 'SKILL.md')), '第二个根里的技能也要真进回收站');
});

test('skill-remove：同名技能在两个根里时删第一个根那份，另一个根那份不动', async (t) => {
  const fx = await setup(t);
  const first = writeSkillUnder(fx, 'skills', 'shadowed-skill', '根顺序在先的那一份，删除只该动它');
  const second = writeSkillUnder(fx, '.agents/skills', 'shadowed-skill', '根顺序在后：优先级低，但不该被顺手删掉');

  const res = await removeSkill(fx, 'shadowed-skill');
  assert.equal(res.status, 200, res.text);
  const body = res.body as { relDir: string; rootName: string };
  assert.equal(body.relDir, 'skills/shadowed-skill', '根顺序即优先级：先声明的根先命中（与 scan 同源）');
  assert.equal(existsSync(first), false);
  assert.ok(existsSync(join(second, 'SKILL.md')), '另一个根里那份是**另一条**技能，绝不能被顺手搬走');
});

test('skill-remove：路径穿越的名字一律拒绝，根外的东西一个都没被动过', async (t) => {
  const fx = await setup(t);
  // 根外的"诱饵"：如果哪天有人把名字直接拼成路径，这份文件就是第一个被搬走的东西
  const outside = join(fx.dir, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'SKILL.md'), '根外的文件，绝不该被这次删除碰到\n', 'utf8');
  const legit = writeSkillUnder(fx, 'skills', 'real-skill');

  const names = ['../outside', '..\\outside', 'a/b', 'nested/../real-skill', '..', '.', 'C:\\Windows', '/etc/passwd', 'skills/real-skill'];
  for (const name of names) {
    const res = await removeSkill(fx, name);
    assert.equal(res.status, 400, `名字 ${JSON.stringify(name)} 应当被拒：${res.text}`);
    assert.equal(errorCode(res), 'bad-skill-name', `名字 ${JSON.stringify(name)} 的错误码要指出是名字问题`);
  }

  assert.ok(existsSync(join(outside, 'SKILL.md')), '根外的诱饵必须原封不动');
  assert.ok(existsSync(join(legit, 'SKILL.md')), '被点名的真技能也不许被搬走（请求根本没提到它）');
  assert.equal(existsSync(join(fx.dataDir, 'trash')), false, '穿越被拒时不该建回收站');
});

test('skill-remove：名字不存在 → 404 说清去哪找，且零副作用', async (t) => {
  const fx = await setup(t);
  const legit = writeSkillUnder(fx, 'skills', 'demo-skill');

  const res = await removeSkill(fx, 'never-existed');
  assert.equal(res.status, 404, res.text);
  assert.equal(errorCode(res), 'skill-not-found');
  const message = (res.body as { error: { message: string } }).error.message;
  assert.match(message, /never-existed/u);
  assert.match(message, /skills/u, '错误信息要说清"两个根都找过了"，否则人不知道该去哪核對');

  assert.ok(existsSync(join(legit, 'SKILL.md')), '别人的技能不许受影响');
  assert.equal(existsSync(join(fx.dataDir, 'trash')), false);
});

test('skill-remove：回收站里已有同一份 → 409 拒绝，第二次一个文件都不动', async (t) => {
  const fx = await setup(t);
  writeSkillUnder(fx, 'skills', 'demo-skill');
  assert.equal((await removeSkill(fx, 'demo-skill')).status, 200);
  // 人又建了一个同名的（fixture 的 now 固定，落点时间戳相同 → 必然撞上）
  const rebuilt = writeSkillUnder(fx, 'skills', 'demo-skill');

  const second = await removeSkill(fx, 'demo-skill');
  assert.equal(second.status, 409, second.text);
  assert.equal(errorCode(second), 'trash-conflict');
  assert.ok(existsSync(join(rebuilt, 'SKILL.md')), '撞上已有那份时，新的这份留在原处（宁可让人多看一眼）');
  assert.equal(
    readdirSync(join(fx.dataDir, 'trash')).length,
    1,
    '回收站里仍然只有第一次那一份，没有被覆盖',
  );
});

test('skill-remove：写坏的技能目录（缺 SKILL.md）也清得掉', async (t) => {
  const fx = await setup(t);
  // 扫描器会把它列进 rejected（没有 SKILL.md），但它正是最该被清掉的那一类
  const broken = join(fx.skillsRoot, 'skills', 'broken-skill');
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, 'notes.txt'), '半成品\n', 'utf8');

  const res = await removeSkill(fx, 'broken-skill');
  assert.equal(res.status, 200, res.text);
  assert.equal(existsSync(broken), false);
  assert.ok(existsSync(join((res.body as { movedTo: string }).movedTo, 'notes.txt')), '整个目录一起搬走');
});

test('skill-remove：写口在这条线上的形状——POST /api/skills/remove，GET 与 /api/commands 同门', async (t) => {
  const fx = await setup(t);
  writeSkillUnder(fx, 'skills', 'demo-skill');

  // 方法不对是 405（"地址存在，只是不接受 GET"），不是 404
  const got = await call(fx, '/api/skills/remove');
  assert.equal(got.status, 405, got.text);
  assert.equal(errorCode(got), 'method-not-allowed');
  assert.ok(existsSync(join(fx.skillsRoot, 'skills', 'demo-skill', 'SKILL.md')));

  // 同一个命令名在 /api/commands 那条老通道上也通（与 hook-remove 同姿势），实现是同一份
  const viaCommands = await command(fx, 'skill-remove', { name: 'demo-skill' });
  assert.equal(viaCommands.status, 200, viaCommands.text);
  assert.equal(existsSync(join(fx.skillsRoot, 'skills', 'demo-skill')), false);
  assert.ok(existsSync(join(fx.dataDir, 'trash', `${compactStamp}-demo-skill`, 'SKILL.md')));
});

// ──────────────────────────────── MCP：写配置 / 真起进程试一次 ────────────────────────────────

test('mcp-save：写入 config.mcp.servers，界面上的 enabled 落成配置里的 disabled', async (t) => {
  const fx = await setup(t);

  const added = await command(fx, 'mcp-save', {
    name: 'filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    env: { ROOT: 'D:/work' },
    enabled: true,
  });
  assert.equal(added.status, 200, added.text);
  const doc = fx.configDoc() as { mcp?: { servers?: Array<Record<string, unknown>> } };
  const servers = doc.mcp?.servers ?? [];
  assert.equal(servers.length, 1);
  assert.equal(servers[0]?.['name'], 'filesystem');
  assert.equal(servers[0]?.['command'], 'npx');
  assert.deepEqual(servers[0]?.['args'], ['-y', '@modelcontextprotocol/server-filesystem']);
  assert.deepEqual(servers[0]?.['env'], { ROOT: 'D:/work' });
  assert.equal('disabled' in (servers[0] ?? {}), false, 'enabled: true = 配置里不出现 disabled 这个键');
  /**
   * **`restartRequired` 的判据（2026-10-11 改成"按净效果给"）**：这一格回答的是
   * "这次改动**在活进程里生效了吗**"——没生效才回 `true`。所以判据有两个输入：
   * **① 净效果**（这次写命令真的动过什么没有）× **② 写下的字段活进程接不接得住**
   * （`classifyConfigField(field) === 'hot'`，名单在 `src/config/watcher.ts` 的
   * `HOT_RELOAD_FIELDS`）。两个输入都不在界面、也不在这里判：**唯一那一处在
   * `WebServerImpl.mcpRestartOutcome` 的方法头**（那一节也是"将来加了不走热更的字段
   * 要登记的地方"）。
   *
   * 本用例：`mcp-save` 加的是一条真声明（净效果 = `added`，不是"什么都没改"）
   * **且**这份夹具没有接热更（`setup` 缺省不传 `configReload`，等于"内嵌方 / 夹具 / 停掉
   * watcher 之后"那种形状）⇒ 活进程里没人接管 ⇒ `true`。
   * ⚠️ 但要说清：**这一支在生产上今天是不可达的**（`main.ts` 递的就是 `() => configWatcher.live`，
   * 常驻实例里恒为 true）。今天唯一一条**接线活着却仍要重启**的活路径是"顺带写了
   * `tools.disabled`"（`mcp-remove` 清禁用名单那一支），钉在下面 `mcp-remove：删服务并清掉…` 里。
   * **三面各钉一条**：这一条=有改动·没人接住；下一条=有改动·接住了；再下一条=接住了但有一格接不住。
   */
  const addedBody = added.body as { restartRequired?: boolean; effect?: string; restartNote?: string };
  assert.equal(addedBody.effect, 'updated', '这次是真改动（新加一条声明）⇒ 净效果不是"没改"');
  assert.equal(
    addedBody.restartRequired,
    true,
    '本进程没接配置热更 ⇒ 盘上变了而活进程一字未动，如实说要重启',
  );
  assert.match(String(addedBody.restartNote), /重启主进程才生效/u,
    `要重启就得给理由：${String(addedBody.restartNote)}`);

  // 改：只动传进来的字段，其余原样保留
  const edited = await command(fx, 'mcp-save', {
    name: 'filesystem',
    command: 'node',
    args: ['server.mjs'],
    env: {},
    enabled: false,
  });
  assert.equal(edited.status, 200, edited.text);
  const after = (fx.configDoc() as { mcp: { servers: Array<Record<string, unknown>> } }).mcp.servers;
  assert.equal(after.length, 1, '同名是编辑而不是新增');
  assert.equal(after[0]?.['command'], 'node');
  assert.equal(after[0]?.['disabled'], true, 'enabled: false 落成配置里的 disabled: true');

  // 未在界面上暴露的字段不该被顺手抹掉（编辑一个服务不等于重置它）
  const doc2 = fx.configDoc() as { mcp: { servers: Array<Record<string, unknown>> } };
  doc2.mcp.servers[0]!['cwd'] = 'D:/work';
  doc2.mcp.servers[0]!['toolDefaults'] = { sideEffect: 'none' };
  writeFileSync(fx.configPath, `${JSON.stringify(doc2, null, 2)}\n`, 'utf8');
  await command(fx, 'mcp-save', { name: 'filesystem', command: 'node', args: ['server.mjs'], env: {}, enabled: true });
  const kept = (fx.configDoc() as { mcp: { servers: Array<Record<string, unknown>> } }).mcp.servers[0]!;
  assert.equal(kept['cwd'], 'D:/work', 'cwd 这类高级设置要原样保留');
  assert.deepEqual(kept['toolDefaults'], { sideEffect: 'none' });
});

test('mcp-save：热更接住了 ⇒ 回执说"已生效、不必重启"（同一判据的另一面）', async (t) => {
  // 与上一条**同一判据的另一面**：这次有真改动（净效果 = added），而写下的字段只有
  // `mcp.servers`——它是热更字段、接线又是活的（生产上 `main.ts` 把 `() => configWatcher.live`
  // 递给服务端）⇒ **写盘即生效**，回执不许再喊重启（判据见 `WebServerImpl.mcpRestartOutcome`）。
  const fx = await setup(t, { configReload: true });

  const added = await command(fx, 'mcp-save', {
    name: 'filesystem',
    command: 'node',
    args: ['server.mjs'],
    enabled: true,
  });
  assert.equal(added.status, 200, added.text);
  const addedBody = added.body as {
    restartRequired?: boolean; effect?: string; restartNote?: string;
  };
  assert.equal(addedBody.effect, 'updated', '这次是真改动（不是"什么都没改"那一支）');
  assert.equal(
    addedBody.restartRequired,
    false,
    '声明面写盘即生效 ⇒ 不必重启（回执不许再让人白重启一次）',
  );
  // 那一格**不许只是 false**：`false` 也要有一句能摆在人眼前的话（界面原样接在 toast 后面）
  assert.match(String(addedBody.restartNote), /已生效/u, `false 也要说人话：${String(addedBody.restartNote)}`);

  // 删服务走**同一个判据**（同一个 `mcpRestartOutcome()`）：也不该说"要重启"
  const removed = await command(fx, 'mcp-remove', { name: 'filesystem' });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(
    (removed.body as { restartRequired?: boolean }).restartRequired,
    false,
    '删服务同样走声明面热更（判据只有一处，两处不许各写一遍）',
  );
});

test('mcp-save：同内容再存一次 ⇒ 净效果为零，接线活不活都不必重启', async (t) => {
  // 判据的第一个输入是**净效果**：按一下"保存"而值本来就是这样 ⇒ 没有要生效的东西。
  // 这一条**故意用没接线的夹具**：那是"要重启"那一侧最容易误伤的形状——
  // 若只按"接线活没活"给这一格，一次什么都没改的保存也会叫人去重启。
  const fx = await setup(t);
  await command(fx, 'mcp-save', { name: 'same', command: 'node', args: ['a.mjs'], enabled: true });
  const again = await command(fx, 'mcp-save', { name: 'same', command: 'node', args: ['a.mjs'], enabled: true });
  assert.equal(again.status, 200, again.text);
  const body = again.body as {
    restartRequired?: boolean; effect?: string; restartNote?: string; changedServers?: string[];
  };
  assert.deepEqual(body.changedServers, [], '声明面逐字段相同');
  assert.equal(body.effect, 'unchanged', '净效果为零 ⇒ 这一格要如实说"没改动"，不许说成"已生效"');
  assert.equal(body.restartRequired, false, '没有要生效的东西 ⇒ 不必重启（哪怕这台实例没接热更）');
  assert.match(String(body.restartNote), /没有改动任何东西/u,
    `理由要说"没改"：${String(body.restartNote)}`);
});

test('mcp-save：字段不合法 → 400；配置校验失败 → 回滚原文件', async (t) => {
  const fx = await setup(t);
  const original = readFileSync(fx.configPath, 'utf8');

  assert.equal((await command(fx, 'mcp-save', { command: 'npx' })).status, 400, '缺 name');
  assert.equal((await command(fx, 'mcp-save', { name: 'x' })).status, 400, '缺 command');
  assert.equal(
    (await command(fx, 'mcp-save', { name: 'x', command: 'npx', args: [1, 2] })).status,
    400,
    'args 必须是字符串数组',
  );
  assert.equal(
    (await command(fx, 'mcp-save', { name: 'x', command: 'npx', env: { A: 1 } })).status,
    400,
    'env 必须是"变量名 → 字符串值"',
  );
  assert.equal(
    (await command(fx, 'mcp-save', { name: 'bad name!', command: 'npx' })).status,
    400,
    'server 名要匹配 ^[A-Za-z0-9_-]{1,128}$（只允许字母、数字、- 与 _）',
  );
  assert.equal(readFileSync(fx.configPath, 'utf8'), original, '被拒的写入一个字节都不该落盘');
});

test('mcp-remove：删服务并清掉指向它的禁用名单条目', async (t) => {
  // **这一条同时是"确实要重启"那一面的活证据**（判据见 `WebServerImpl.mcpRestartOutcome`）：
  // 夹具**接了**热更（`configReload: true`，与生产同形），可这一支仍然要回 `true`——
  // 因为 `mcp-remove` 会**顺带**写 `tools.disabled`，而那一格**不在热更名单里**
  // （它是工具装配参数，池的 `applyDeclarations` 不管它）⇒ 盘上那份停用名单要重启才与
  // 运行中的注册表一致。这也是**今天唯一一条接线活着却仍要重启的活路径**。
  const fx = await setup(t, { configReload: true });
  await command(fx, 'mcp-save', { name: 'demo', command: 'node', args: ['server.mjs'], enabled: true });
  await command(fx, 'mcp-save', { name: 'keep', command: 'node', args: ['other.mjs'], enabled: true });

  // 注册表里放两件 MCP 工具与一件内置工具，只关掉其中一件 MCP 工具
  const registry = fx.registry;
  registry.register({
    name: 'mcp__demo__echo',
    description: 'MCP 回显',
    parameters: { type: 'object', properties: {} },
    executionMode: 'exclusive',
    sideEffect: 'destructive',
    timeoutMs: 1000,
    handler: async () => ({ content: 'ok' }),
  });
  registry.register({
    name: 'mcp__keep__echo',
    description: 'MCP 回显（另一个服务）',
    parameters: { type: 'object', properties: {} },
    executionMode: 'exclusive',
    sideEffect: 'destructive',
    timeoutMs: 1000,
    handler: async () => ({ content: 'ok' }),
  });
  registry.setDisabled(['mcp__demo__echo', 'mcp__keep__echo']);

  const res = await command(fx, 'mcp-remove', { name: 'demo' });
  assert.equal(res.status, 200, res.text);
  const body = res.body as {
    servers: string[]; prunedDisabledTools: string[]; restartRequired?: boolean;
    restartNote?: string; appliedFields?: string[];
  };
  assert.deepEqual(body.servers, ['keep'], '要删的那条真的从数组里消失了');
  assert.deepEqual(body.prunedDisabledTools, ['mcp__demo__echo']);
  assert.deepEqual(registry.disabledNames(), ['mcp__keep__echo'], '别的服务的禁用条目不许被连坐');
  assert.deepEqual(
    (fx.configDoc() as { tools?: { disabled?: string[] } }).tools?.disabled,
    ['mcp__keep__echo'],
    '清掉的名单要写回配置',
  );
  // —— 判据那一格：写了两格字段，其中 `tools.disabled` 接不住 ⇒ 如实回 true 并点名它 ——
  assert.deepEqual(body.appliedFields, ['mcp.servers', 'tools.disabled'],
    '回执要能看出"这次写了哪两格"：`tools.disabled` 在里面就是要重启的原因');
  assert.equal(body.restartRequired, true,
    '接线活着，但顺带写的 tools.disabled 不在热更名单里 ⇒ 仍然要重启（今天唯一一条这样的活路径）');
  assert.match(String(body.restartNote), /tools\.disabled/u,
    `要重启就得点名是哪一格接不住：${String(body.restartNote)}`);
  assert.match(String(body.restartNote), /名单/u,
    `理由要说到"禁用名单/停用名单"这一层，不能只丢一个字段名：${String(body.restartNote)}`);

  // 删一个不存在的：404（不静默成功）
  const missing = await command(fx, 'mcp-remove', { name: 'nope' });
  assert.equal(missing.status, 404, missing.text);
  assert.equal(errorCode(missing), 'mcp-server-not-found');
});

test('mcp-test：真拉起 MCP 进程、握手、取回工具清单，然后按关机序列收掉它', async (t) => {
  const fx = await setup(t);
  const marker = join(fx.dir, 'mcp-marker');
  const res = await command(fx, 'mcp-test', {
    name: 'probe',
    command: process.execPath,
    args: [FAKE_MCP],
    env: { FAKE_MCP_MARKER_DIR: marker },
  });
  assert.equal(res.status, 200, res.text);
  const body = res.body as {
    ok: boolean;
    reason: string | null;
    tools: Array<{ name: string; description: string }>;
    protocolVersion: string | null;
    serverInfo: { name: string } | null;
    shutdownStages: string[];
    failureKind: string | null;
  };
  assert.equal(body.ok, true, `测试连接应成功：${body.reason ?? ''}`);
  assert.deepEqual(
    body.tools.map((tool) => tool.name),
    ['echo', 'big', 'fail', 'slow'],
    '取回来的就是 tools/list 的清单（这是"它到底能做什么"的唯一实测答案）',
  );
  assert.ok(body.tools[0]!.description.length > 0, '工具描述也要带上（界面展开时要摆）');
  assert.equal(body.protocolVersion, '2025-06-18');
  assert.equal(body.serverInfo?.name, 'fake-mcp', 'server 自报的身份与配置里的名字是两回事');
  assert.ok(body.shutdownStages.includes('exited'), `测试完必须把进程收掉：${body.shutdownStages.join(' → ')}`);

  // 关键纪律：**不写事件**。往日志里写一条 started，扩展页此后就会显示"已运行"，
  // 而它只是个测试留下的残影——事件日志是唯一真相源。
  const events = await fx.readAll();
  assert.equal(events.filter((event) => event.type.startsWith('mcp/')).length, 0);
  assert.equal(events.length, 0);

  // 进程真的被收掉了：夹具日志里应当有 stdin-end 与 exit
  const journal = readFileSync(join(marker, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (JSON.parse(line) as { t: string }).t);
  assert.ok(journal.includes('initialize'), '握手确实发出去过');
  assert.ok(journal.includes('exit'), `子进程应当已经退出：${journal.join(',')}`);
});

test('mcp-test：命令不存在 → 如实报"起不来"，主进程照常活着', async (t) => {
  const fx = await setup(t);
  // 命令名要过**启动器白名单**（`src/mcp/launcher-guard.ts`，2026-10-09 加）：这一条要验的是
  // "spawn 失败如实回报"，不是"白名单挡不挡得住"（那条有自己的用例）。
  // ⇒ 用一个**白名单内**的启动器名 + 一个**一定不存在**的绝对路径：白名单放行、spawn 失败。
  const missing = join(fx.dir, process.platform === 'win32' ? 'mcp-server.exe' : 'mcp-server');
  const res = await command(fx, 'mcp-test', { name: 'nope', command: missing });
  assert.equal(res.status, 200, '测试失败不是 HTTP 错误：结果本身是"连不上"');
  const body = res.body as { ok: boolean; reason: string | null; failureKind: string | null };
  assert.equal(body.ok, false);
  assert.equal(body.failureKind, 'spawn');
  assert.match(body.reason ?? '', /(进程|命令)/u, `失败要给原因：${body.reason ?? ''}`);

  // 而"白名单外的启动器"是另一条路：**400 + 一句能照做的话**（这里只钉"不是 200 也不是崩"）
  const rejected = await command(fx, 'mcp-test', { name: 'nope', command: 'definitely-not-a-real-binary' });
  assert.equal(rejected.status, 400, '白名单外的启动器要在配置校验那一层就被拒，不是起进程再失败');

  // 主进程照常服务（这条命令绝不允许把服务带崩）
  const after = await call(fx, '/api/mcp');
  assert.equal(after.status, 200);
});

test('mcp-test：Windows 上 `npx` 的测试回执是一句**能照做**的话（不是裸 ENOENT）', async (t) => {
  if (process.platform !== 'win32') return; // 非 Windows 上 npx 是真能起的
  const fx = await setup(t);
  // 界面「添加 MCP 服务」那一格以前被人照着填 `npx -y <包>`（出厂注释也那么写过）。
  // 这一条验的是：**测试连接这条回执**也要拿到那句诊断，而不是"进程已退出（code=null）"。
  const res = await command(fx, 'mcp-test', {
    name: 'npxsrv',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
  });
  assert.equal(res.status, 200, res.text);
  const body = res.body as { ok: boolean; reason: string | null; failureKind: string | null };
  assert.equal(body.ok, false);
  assert.equal(body.failureKind, 'spawn', '失败发生在"起进程"那一格');
  assert.match(body.reason ?? '', /在 Windows 上起不来/u, `要说清为什么：${body.reason ?? ''}`);
  assert.match(body.reason ?? '', /node <绝对路径>\/cli\.js/u, '要给出路（能照做的那三条）');
  assert.match(body.reason ?? '', /没有为它留下任何进程/u, '要说清判在起进程之前');
});

test('mcp-test：握手超时 → 到点即杀，绝不留后台进程', async (t) => {
  const fx = await setup(t);
  const journal = join(fx.dir, 'hang.jsonl');
  const res = await command(fx, 'mcp-test', {
    name: 'hang',
    command: process.execPath,
    args: [HANG_MCP, journal],
    timeoutMs: 800,
  });
  assert.equal(res.status, 200, res.text);
  const body = res.body as {
    ok: boolean;
    failureKind: string | null;
    reason: string | null;
    timeoutMs: number;
    shutdownStages: string[];
  };
  assert.equal(body.ok, false);
  assert.equal(body.failureKind, 'timeout');
  assert.equal(body.timeoutMs, 800);
  assert.match(body.reason ?? '', /超时/u, `超时要给原因：${body.reason ?? ''}`);
  // 关机序列走到底：那个 server 故意不响应 stdin 关闭，所以必然经过信号那一级才收掉。
  // 「收掉了」的凭据是 exited —— 只有它证明这条命令没有留下后台进程。
  assert.ok(
    body.shutdownStages.includes('exited'),
    `超时之后必须杀掉它：${body.shutdownStages.join(' → ')}`,
  );
  assert.ok(
    body.shutdownStages.includes('sigterm') || body.shutdownStages.includes('sigkill'),
    `它不响应 stdin 关闭，所以必须动过信号：${body.shutdownStages.join(' → ')}`,
  );

  // 那个卡住的 server 确实收到过 initialize（说明超时发生在握手上，不是别的地方）
  const marks = readFileSync(journal, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { t: string; method?: string | null; pid?: number });
  assert.ok(marks.some((mark) => mark.method === 'initialize'), '握手请求确实发出去过');
  // 进程真的没了：PID 已经不接受信号（强杀不会给它留下写日志的机会，所以只能从外面看）
  const pid = marks[0]?.pid;
  if (typeof pid === 'number') {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `那个卡住的 server（pid ${pid}）必须已经退出`);
  }

  // 服务照常
  assert.equal((await call(fx, '/api/mcp')).status, 200);
});

test('mcp-test：超时参数被夹在上下限之间（不许挂住这条 HTTP 请求）', async (t) => {
  const fx = await setup(t);
  const tooSmall = await command(fx, 'mcp-test', {
    name: 'probe',
    command: process.execPath,
    args: [FAKE_MCP],
    timeoutMs: 1,
  });
  assert.equal(tooSmall.status, 200, tooSmall.text);
  assert.ok(
    (tooSmall.body as { timeoutMs: number }).timeoutMs >= 500,
    '下限 500ms：再小就等于必然超时，那种"测试"没有意义',
  );
});

test('/api/mcp：视图带上 env / 工具描述 / 运行计数（界面要用）', async (t) => {
  const fx = await setup(t);
  await command(fx, 'mcp-save', {
    name: 'demo',
    command: 'node',
    args: ['server.mjs'],
    env: { ROOT: 'D:/work' },
    enabled: true,
  });
  const view = (await call(fx, '/api/mcp')).body as {
    servers: Array<{ name: string; env: Record<string, string>; disabled: boolean; runningNow: boolean; command: string }>;
    runningCount: number;
  };
  assert.equal(view.servers.length, 1);
  assert.deepEqual(view.servers[0]?.env, { ROOT: 'D:/work' });
  assert.equal(view.servers[0]?.disabled, false);
  assert.equal(view.servers[0]?.runningNow, false, '日志里没有它的启动记录，"在跑"就不能成立');
  assert.equal(view.runningCount, 0);

  // 日志里有启动事件才算在跑（pid 是当时那个进程的，不能当判据）
  const started: AppEvent = {
    seq: fx.log.nextSeq(),
    ts: T0.toISOString(),
    type: 'mcp/server-started',
    data: { name: 'demo', pid: 4242, tools: [] },
    visibility: defaultVisibility('mcp/server-started'),
    origin: 'test',
  } as unknown as AppEvent;
  fx.log.append(started, { sync: true });
  applyOne(emptyProjection(), started);
  const after = (await call(fx, '/api/mcp')).body as {
    servers: Array<{ runningNow: boolean }>;
    runningCount: number;
  };
  assert.equal(after.servers[0]?.runningNow, true);
  assert.equal(after.runningCount, 1);
});

test('/api/mcp：工具清单**经事件**可读（名字 + 描述），注册表为空也照样给（缺陷 ⑤）', async (t) => {
  // 修前的形状（`docs/mcp-chain-review.md` 缺陷 ⑤）：生产上池**刻意不拿注册表**
  // （拿了就把 `mcp__*` 写进 `tools` 段），而观测面只从注册表读 ⇒ 三个字段恒为空：
  // 真起过、真调过，扩展页照样写「注册工具 0 件」，每个服务卡里没有工具清单、没有描述。
  // 修后：`mcp/server-started` 的 data 带上 `[{name, description}]`（internal 事件，
  // 不进模型请求），`mcpView` 以它为准、注册表只作回退。
  const fx = await setup(t);
  await command(fx, 'mcp-save', {
    name: 'demo',
    command: 'node',
    args: ['server.mjs'],
    enabled: true,
  });
  assert.equal(fx.registry.names().filter((name) => name.startsWith('mcp__')).length, 0,
    '前提：这个夹具的注册表里一件 MCP 工具都没有（生产就是这么装配的）');

  const started: AppEvent = {
    seq: fx.log.nextSeq(),
    ts: T0.toISOString(),
    type: 'mcp/server-started',
    data: {
      name: 'demo',
      pid: 4242,
      tools: ['read', 'write'],
      toolDetails: [
        { name: 'read', description: '读一个文件（server 自报的原话）' },
        { name: 'write', description: '写一个文件（server 自报的原话）' },
      ],
    },
    visibility: defaultVisibility('mcp/server-started'),
    origin: 'test',
  } as unknown as AppEvent;
  fx.log.append(started, { sync: true });
  applyOne(emptyProjection(), started);

  const view = (await call(fx, '/api/mcp')).body as {
    servers: Array<{
      name: string;
      toolsCount: number;
      registeredTools: string[];
      toolDetails: Array<{ name: string; fullName: string; description: string }>;
      toolsSeenAt: string | null;
    }>;
    registeredCount: number;
    registeredTools: string[];
  };
  const demo = view.servers.find((server) => server.name === 'demo');
  assert.ok(demo !== undefined);
  assert.equal(demo.toolsCount, 2, `必须有 2 件（修前这里恒为 0）：${JSON.stringify(demo)}`);
  assert.deepEqual(demo.toolDetails.map((tool) => tool.name), ['read', 'write']);
  assert.deepEqual(demo.toolDetails.map((tool) => tool.fullName), ['mcp__demo__read', 'mcp__demo__write'],
    '全名要按 `mcp__{server}__{tool}` 合成（界面拿它对照日志与配置）');
  assert.match(demo.toolDetails[0]?.description ?? '', /读一个文件/u, '描述必须来自事件，不许留空');
  assert.equal(demo.toolsSeenAt, T0.toISOString(), '要能说出"这份清单是哪一刻看到的"');
  // 顶层那两个数：注册表为空时以事件里那份为准——页头写"0 件"而卡片里列着工具是自相矛盾
  assert.equal(view.registeredCount, 2);
  assert.deepEqual([...view.registeredTools].sort(), ['mcp__demo__read', 'mcp__demo__write']);

  // 旧日志（没有 `toolDetails` 那一格）也读得动：退回名字那一档、描述留空，不许读崩
  const legacy = await setup(t);
  await command(legacy, 'mcp-save', { name: 'old', command: 'node', args: ['server.mjs'], enabled: true });
  const legacyEvent: AppEvent = {
    seq: legacy.log.nextSeq(),
    ts: T0.toISOString(),
    type: 'mcp/server-started',
    data: { name: 'old', pid: 1, tools: ['echo'] },
    visibility: defaultVisibility('mcp/server-started'),
    origin: 'test',
  } as unknown as AppEvent;
  legacy.log.append(legacyEvent, { sync: true });
  applyOne(emptyProjection(), legacyEvent);
  const oldView = (await call(legacy, '/api/mcp')).body as {
    servers: Array<{ name: string; toolsCount: number; toolDetails: Array<{ name: string; description: string }> }>;
  };
  const old = oldView.servers.find((server) => server.name === 'old');
  assert.equal(old?.toolsCount, 1, '旧形状（只有名字）照样要数得出来');
  assert.equal(old?.toolDetails.length, 1);
  assert.equal(old?.toolDetails[0]?.name, 'echo');
  assert.equal(old?.toolDetails[0]?.description, '', '描述留空，但不许臆造');
});

test('/api/mcp：资源观测可读（启动耗时 / RSS / 在飞峰值 / 最近一次回收时间）—— 2026-10-10 加', async (t) => {
  // 判据（docs/multi-mcp-orchestration.md L1 缺口 ⑤）：用户这一轮的原问题里有"谁在吃内存、
  // 冷启动到底多慢、回收救回多少"。池把这三笔账落进 internal 事件（不进请求、零缓存代价），
  // `/api/mcp` 从事件折出来——**没有事件就不许编**（空 = 还没采到）。
  const fx = await setup(t);
  await command(fx, 'mcp-save', { name: 'demo', command: 'node', args: ['server.mjs'], enabled: true });

  const append = (type: string, data: unknown): void => {
    const event: AppEvent = {
      seq: fx.log.nextSeq(),
      ts: T0.toISOString(),
      type,
      data,
      visibility: defaultVisibility(type),
      origin: 'test',
    } as unknown as AppEvent;
    fx.log.append(event, { sync: true });
    applyOne(emptyProjection(), event);
  };

  append('mcp/server-started', {
    name: 'demo', pid: 4242, tools: ['read'], toolDetails: [{ name: 'read', description: '读文件' }], startMs: 812,
  });
  append('mcp/server-resource', {
    name: 'demo', pid: 4242, sampledAtMs: T0.getTime() + 50, rssMb: 46.5, rssSource: 'tasklist',
    startMs: 812, inFlightPeak: 1,
  });

  const running = (await call(fx, '/api/mcp')).body as {
    servers: Array<{
      name: string; lastStartMs: number | null; rssMb: number | null; rssSource: string | null;
      rssSampledAt: string | null; uptimeMs: number | null; inFlightPeak: number | null;
      lastReclaimedAt: string | null;
    }>;
  };
  const demo = running.servers.find((server) => server.name === 'demo');
  assert.equal(demo?.lastStartMs, 812, '冷启动耗时读得到（这一格答"到底多慢"）');
  assert.equal(demo?.rssMb, 46.5, 'RSS 读得到');
  assert.equal(demo?.rssSource, 'tasklist', '采样来源如实带出（没采到与 0 MB 分得开）');
  assert.equal(demo?.rssSampledAt, new Date(T0.getTime() + 50).toISOString());
  assert.equal(demo?.lastReclaimedAt, null, '还没回收过 ⇒ 这一格是空，不许编一个时刻');

  // 回收：活多久 + 峰值 + 最后采到的 RSS + 回收时刻
  append('mcp/server-stopped', {
    name: 'demo', reason: 'idle-reclaim', uptimeMs: 300_000, inFlightPeak: 1, rssMb: 46.5,
  });
  const stopped = (await call(fx, '/api/mcp')).body as {
    servers: Array<{ name: string; uptimeMs: number | null; lastReclaimedAt: string | null; runningNow: boolean }>;
  };
  const gone = stopped.servers.find((server) => server.name === 'demo');
  assert.equal(gone?.uptimeMs, 300_000, '上一个进程活了多久（与回收理由一起才读得出"是空闲回收还是起来就崩"）');
  assert.equal(gone?.lastReclaimedAt, T0.toISOString(), '最近一次回收时间 = 那条 stopped 事件的 ts');
  assert.equal(gone?.runningNow, false);

  // 旧日志（那几格都没有）照样读得动：一律 null，不许读崩、也不许编
  const legacy = await setup(t);
  await command(legacy, 'mcp-save', { name: 'old', command: 'node', args: ['server.mjs'], enabled: true });
  const legacyEvent: AppEvent = {
    seq: legacy.log.nextSeq(),
    ts: T0.toISOString(),
    type: 'mcp/server-started',
    data: { name: 'old', pid: 1, tools: ['echo'] },
    visibility: defaultVisibility('mcp/server-started'),
    origin: 'test',
  } as unknown as AppEvent;
  legacy.log.append(legacyEvent, { sync: true });
  applyOne(emptyProjection(), legacyEvent);
  const oldView = (await call(legacy, '/api/mcp')).body as {
    servers: Array<{ name: string; lastStartMs: number | null; rssMb: number | null; uptimeMs: number | null }>;
  };
  const old = oldView.servers.find((server) => server.name === 'old');
  assert.equal(old?.lastStartMs, null);
  assert.equal(old?.rssMb, null);
  assert.equal(old?.uptimeMs, null);
});

test('/api/mcp：工具清单与进程状态解耦（回收后仍列得出名字 + 清单时刻 + 年龄）—— 2026-10-10 加', async (t) => {
  // 用户这一轮的原话："mcp 卡片要显示 server 和工具名称"。挡在这句话前面的不是接口没数据，
  // 而是**回收即清空**：生产上池空闲 5 分钟就回收（`idle-reclaim`），而清单只在启动那一刻进日志，
  // 于是人点开扩展页时最常看到的状态恰恰是"已停止 + 0 件"——工具名一个都不剩。
  //
  // 这一条钉三件事：
  //   ① `toolList` 在回收之后**照样给**（连同描述），`toolDetails`/`toolsCount`/`registeredTools`
  //      与它同源（三个字段一起改口径：只改一个就会出现"卡片里列着工具、页头写着 0 件"）；
  //   ② `toolsFrom` 说清这份清单是 `live` 还是 `cached`，`toolsListAt` 给出清单时刻、
  //      `toolsAgeMs` 给出"多久以前"（按夹具的 now 算，可复现）；
  //   ③ "起来过、一件工具都没给"（`toolsQuery = 'empty'`）与"从没起来过"（`toolsQuery = null`、
  //      `state = never-started`）在接口上分得开——界面那两句空态就是靠这个分开的。
  const fx = await setup(t);
  await command(fx, 'mcp-save', { name: 'demo', command: 'node', args: ['server.mjs'], enabled: true });

  const append = (type: string, data: unknown, ts: Date = T0): void => {
    const event: AppEvent = {
      seq: fx.log.nextSeq(),
      ts: ts.toISOString(),
      type,
      data,
      visibility: defaultVisibility(type),
      origin: 'test',
    } as unknown as AppEvent;
    fx.log.append(event, { sync: true });
    applyOne(emptyProjection(), event);
  };

  append('mcp/server-started', {
    name: 'demo', pid: 4242, tools: ['read'], toolDetails: [{ name: 'read', description: '读文件' }], startMs: 812,
  });

  interface ServerRow {
    name: string; state: string; toolsCount: number;
    toolDetails: Array<{ name: string }>;
    toolList: Array<{ name: string; fullName: string; description: string }>;
    toolsListAt: string | null; toolsFrom: string; toolsQuery: string | null; toolsAgeMs: number | null;
    toolsSeenAt: string | null;
  }
  const readOne = async (fixture: Fixture): Promise<ServerRow | undefined> => {
    const view = (await call(fixture, '/api/mcp')).body as { servers: ServerRow[] };
    return view.servers.find((server) => server.name === 'demo');
  };

  const live = await readOne(fx);
  assert.equal(live?.toolsFrom, 'live', '最后一条日志是"起来了" ⇒ 这份清单是此刻的');
  assert.equal(live?.toolsQuery, 'ok');
  assert.deepEqual(live?.toolList.map((tool) => tool.name), ['read']);
  assert.equal(live?.toolList[0]?.description, '读文件', '描述要跟着清单一起给（界面那一栏就吃它）');
  assert.equal(live?.toolsListAt, T0.toISOString());
  assert.equal(live?.toolsAgeMs, 0, '夹具的 now = T0 ⇒ 清单刚看到，年龄 0');

  // 回收：清单跟着上一次启动留着，但来源改成 cached（进程状态与清单是两件事实）。
  // 这一条的 ts 比清单晚一小时：证明"这份清单是何时的"跟着**清单**走，不跟着回收那一刻走。
  append('mcp/server-stopped', { name: 'demo', reason: 'idle-reclaim', uptimeMs: 300_000 },
    new Date(T0.getTime() + 3_600_000));
  const cached = await readOne(fx);
  assert.equal(cached?.state, 'stopped');
  assert.deepEqual(cached?.toolList.map((tool) => tool.name), ['read'],
    '回收之后"它给过什么"仍然读得到（这一格就是用户要的工具名）');
  assert.equal(cached?.toolsFrom, 'cached', '同时必须说得出这份清单不是此刻的');
  assert.equal(cached?.toolsQuery, 'ok', '问过了就是问过了，回收不改这件事');
  assert.deepEqual(cached?.toolDetails.map((tool) => tool.name), ['read'],
    '`toolDetails` 也留着（它答"日志里看到过什么"）：清空它换不来诚实，只让人以为"它没有工具"');
  assert.equal(cached?.toolsCount, 1,
    '件数与 `toolList` 同源（不然卡片里列着 1 件、页头写着 0 件，这一页就没人信了）');
  assert.equal(cached?.toolsListAt, T0.toISOString(),
    '清单时刻跟着**清单**走（不是回收那一刻）：不然"这份清单多旧"就被答成了"多久前回收的"');
  assert.equal(cached?.toolsAgeMs, 0,
    '年龄按**夹具的 now** 算（那个时钟恒等于 T0）⇒ 0；真实环境里它就是这个数与清单时刻的距离');

  // "起来过、一件工具都没给" ⟷ "从没起来过"：两种空必须分得开
  const quiet = await setup(t);
  await command(quiet, 'mcp-save', { name: 'demo', command: 'node', args: ['server.mjs'], enabled: true });
  const quietEvent: AppEvent = {
    seq: quiet.log.nextSeq(),
    ts: T0.toISOString(),
    type: 'mcp/server-started',
    data: { name: 'demo', pid: 7, tools: [], toolDetails: [] },
    visibility: defaultVisibility('mcp/server-started'),
    origin: 'test',
  } as unknown as AppEvent;
  quiet.log.append(quietEvent, { sync: true });
  applyOne(emptyProjection(), quietEvent);
  const empty = await readOne(quiet);
  assert.equal(empty?.toolsQuery, 'empty', '握手过了、tools/list 回了空 ⇒ 是"它当前不提供工具"');
  assert.equal(empty?.toolsFrom, 'none');
  assert.deepEqual(empty?.toolList, []);
  assert.equal(empty?.toolsSeenAt, T0.toISOString(),
    '这一格现在只答"拉到过没有"：拉到过就给时刻（老语义还要求清单非空，两种空在那格上分不开）');

  const never = await setup(t);
  await command(never, 'mcp-save', { name: 'demo', command: 'node', args: ['server.mjs'], enabled: true });
  const cold = await readOne(never);
  assert.equal(cold?.state, 'never-started');
  assert.equal(cold?.toolsQuery, null, '没起来过就不写这一格——"没问过"由 state 那一格说');
  assert.equal(cold?.toolsFrom, 'none');
  assert.equal(cold?.toolsListAt, null);
  assert.equal(cold?.toolsAgeMs, null, '没有清单就没有年龄，不许编一个 0');
});

test('/api/mcp：工具清单的兼容面——旧后端（没有 toolList）与旧日志（只有 tools 名字）', async (t) => {
  // 界面与主进程是**两个可执行文件**：界面先升、后端还跑着上一版 dist 是常态，
  // 所以"新字段不在"这种情况必须按数据缺格读（界面那一侧照 `toolDetails` 回退，见
  // gui/lib/pages/extensions_page.dart 的 `_McpTools`）。这一条钉后端这一侧的两档：
  //   ① 旧日志的启动事件只有 `tools`（没有 `toolDetails`）⇒ 名字照样进 `toolList`，描述留空；
  //   ② 回收不把 `toolsSeenAt`（清单时刻）一起清掉——它是这份清单唯一的"是何时的答案"。
  const fx = await setup(t);
  await command(fx, 'mcp-save', { name: 'old', command: 'node', args: ['server.mjs'], enabled: true });
  const append = (type: string, data: unknown, ts: Date = T0): void => {
    const event: AppEvent = {
      seq: fx.log.nextSeq(),
      ts: ts.toISOString(),
      type,
      data,
      visibility: defaultVisibility(type),
      origin: 'test',
    } as unknown as AppEvent;
    fx.log.append(event, { sync: true });
    applyOne(emptyProjection(), event);
  };
  append('mcp/server-started', { name: 'old', pid: 1, tools: ['echo'] });

  interface Row {
    toolList: Array<{ name: string; description: string; fullName: string }>;
    toolsFrom: string; toolsQuery: string | null; toolsListAt: string | null; toolsSeenAt: string | null;
  }
  const readOne = async (): Promise<Row | undefined> => {
    const view = (await call(fx, '/api/mcp')).body as { servers: Row[] };
    return view.servers.find((server) => server.name === 'old');
  };

  const first = await readOne();
  assert.deepEqual(first?.toolList.map((tool) => tool.name), ['echo'], '旧形状只有名字，照样列得出来');
  assert.equal(first?.toolList[0]?.description, '', '描述留空，但不许臆造');
  assert.equal(first?.toolList[0]?.fullName, 'mcp__old__echo', '全名按 `mcp__{server}__{tool}` 合成');
  assert.equal(first?.toolsQuery, 'ok');

  append('mcp/server-stopped', { name: 'old', reason: 'crashed' }, T0);
  const afterStop = await readOne();
  assert.equal(afterStop?.toolsFrom, 'cached');
  assert.deepEqual(afterStop?.toolList.map((tool) => tool.name), ['echo']);
  assert.equal(afterStop?.toolsListAt, T0.toISOString(),
    '清单时刻不许被回收清掉——没有它，那份清单就成了一句没有出处的断言');
});

// ──────────────────────────────── Hooks：人可写、agent 仍只读 ────────────────────────────────
test('hook-save：写 data/hooks.json，条目过与装配侧同一把尺子', async (t) => {
  const fx = await setup(t);
  const file = join(fx.dataDir, 'hooks.json');

  const added = await command(fx, 'hook-save', {
    hook: 'PreToolUse',
    matcher: 'pwsh|safe_edit',
    command: 'node scripts/check.mjs',
    timeoutMs: 5000,
    enabled: true,
  });
  assert.equal(added.status, 200, added.text);
  assert.ok(existsSync(file), '钩子配置必须落盘');
  const entries = readJson<Array<Record<string, unknown>>>(file);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.['hook'], 'PreToolUse');
  assert.equal(entries[0]?.['matcher'], 'pwsh|safe_edit');
  assert.equal(entries[0]?.['timeoutMs'], 5000);

  // 非法条目：与启动时装配用的是同一把尺子（界面写得进、启动时被跳过是最难查的故障）
  const badHook = await command(fx, 'hook-save', { hook: 'NoSuchPoint', matcher: 'x', command: 'y' });
  assert.equal(badHook.status, 400, badHook.text);
  assert.equal(errorCode(badHook), 'hook-invalid');
  const badRegex = await command(fx, 'hook-save', { hook: 'Wake', matcher: '([', command: 'y' });
  assert.equal(badRegex.status, 400, badRegex.text);
  assert.equal(readJson<unknown[]>(file).length, 1, '被拒的条目一个都不许进去');

  // 编辑：带 index 就地改
  const edited = await command(fx, 'hook-save', {
    index: 0,
    hook: 'PostToolUse',
    matcher: 'pwsh',
    command: 'node after.mjs',
    timeoutMs: 1000,
    enabled: false,
  });
  assert.equal(edited.status, 200, edited.text);
  const afterEdit = readJson<Array<Record<string, unknown>>>(file);
  assert.equal(afterEdit.length, 1);
  assert.equal(afterEdit[0]?.['hook'], 'PostToolUse');
  assert.equal(afterEdit[0]?.['enabled'], false, '停用 = 留在文件里但不装配');

  // 索引越界：409（"改错一条"比"报错"难查得多）
  const stale = await command(fx, 'hook-save', { index: 7, hook: 'Wake', matcher: 'timer', command: 'y' });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(errorCode(stale), 'hook-index-stale');
});

test('hook-remove：按 index 删除；越界 → 409', async (t) => {
  const fx = await setup(t);
  const file = join(fx.dataDir, 'hooks.json');
  await command(fx, 'hook-save', { hook: 'PreToolUse', matcher: 'a', command: 'one' });
  await command(fx, 'hook-save', { hook: 'Wake', matcher: 'b', command: 'two' });

  const removed = await command(fx, 'hook-remove', { index: 0 });
  assert.equal(removed.status, 200, removed.text);
  const entries = readJson<Array<Record<string, unknown>>>(file);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.['hook'], 'Wake');

  const stale = await command(fx, 'hook-remove', { index: 5 });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(readJson<unknown[]>(file).length, 1);
});

test('/api/hooks：回传 enabled 与两个计数，且如实标出 agent 只读的路径', async (t) => {
  const fx = await setup(t);
  await command(fx, 'hook-save', { hook: 'PreToolUse', matcher: 'a', command: 'one', enabled: true });
  await command(fx, 'hook-save', { hook: 'Wake', matcher: 'b', command: 'two', enabled: false });

  const view = (await call(fx, '/api/hooks')).body as {
    entries: Array<{ index: number; enabled: boolean; hook: string }>;
    enabledCount: number;
    disabledCount: number;
    readOnlyForAgent: string[];
    hookPoints: string[];
  };
  assert.equal(view.entries.length, 2);
  assert.deepEqual(view.entries.map((entry) => entry.index), [0, 1]);
  assert.deepEqual(view.entries.map((entry) => entry.enabled), [true, false]);
  assert.equal(view.enabledCount, 1);
  assert.equal(view.disabledCount, 1);
  assert.deepEqual(view.readOnlyForAgent, [join(fx.dataDir, 'hooks.json')], '这条边界是页面上写给人看的那句话的出处');
  assert.deepEqual(view.hookPoints, ['PreToolUse', 'PostToolUse', 'Wake']);
});

test('写钩子的入口只认人：agent 的路径守卫仍然拒绝同一份文件', async (t) => {
  const fx = await setup(t);
  const file = join(fx.dataDir, 'hooks.json');
  await command(fx, 'hook-save', { hook: 'PreToolUse', matcher: 'a', command: 'one' });

  // agent 那一侧的落点就是 guardedWrite 的"第零步之二"：与 main.ts 装配工具时注入的是同一个
  // protectedPaths（protectedHookPaths(dataDir)），所以这里直接打那条写入口，不绕道工具注册表
  // （注册表那条路要装配一整套 FsEnv 与依赖管理器，测的却不是"门在不在"）。
  const { protectedHookPaths } = await import('../src/hook/hooks.ts');
  assert.deepEqual(protectedHookPaths(fx.dataDir), [file], '要保护的就是这一份文件');
  const { createEnv } = await import('../src/tools/fs/env.ts');
  const { guardedWrite } = await import('../src/tools/fs/edit-core.ts');
  const env = createEnv({ protectedPaths: protectedHookPaths(fx.dataDir) });
  const denied = await guardedWrite(
    env,
    {} as never,
    [{ path: file, relPath: 'data/hooks.json', text: '[]' } as never],
  );
  assert.equal(denied.ok, false, 'agent 改不了"谁能改我"');
  assert.equal((denied as { code?: string }).code, 'E_UNSAFE_PATH');
  assert.match(
    (denied as { message: string }).message,
    /受保护/u,
    '拒绝理由要说清楚',
  );
  // 人的那一侧照常能用；文件内容没被 agent 改成空数组
  assert.equal(readJson<unknown[]>(file).length, 1);
});

// ──────────────────────────────── 确认短语：三条新命令都要门 ────────────────────────────────

test('确认短语：mcp-save / mcp-remove / mcp-test / hook-save / hook-remove 缺 X-Confirm 一律 400', async (t) => {
  const fx = await setup(t);
  const cases: Array<[string, unknown]> = [
    ['mcp-save', { name: 'demo', command: 'node' }],
    ['mcp-remove', { name: 'demo' }],
    ['mcp-test', { name: 'demo' }],
    ['hook-save', { hook: 'Wake', matcher: 'timer', command: 'echo hi' }],
    ['hook-remove', { index: 0 }],
  ];
  for (const [name, body] of cases) {
    const res = await call(fx, `/api/commands/${name}`, { method: 'POST', body });
    assert.equal(res.status, 400, `${name} 缺确认短语应当是 400：${res.text}`);
    assert.equal(errorCode(res), 'confirm-required', `${name} 必须登记确认短语（防误触不防人）`);
    assert.match((res.body as { error: { message: string } }).error.message, new RegExp(name, 'u'));
  }
  // 技能那两条不改变能力边界，不带短语也要能用（与 skill-confirm 同级）
  writeSkill(fx, 'demo-skill');
  assert.equal((await call(fx, '/api/commands/skill-ignore', { method: 'POST', body: { name: 'demo-skill', ignored: true } })).status, 200);
  assert.equal((await call(fx, '/api/commands/skill-create', { method: 'POST', body: { name: 'new-one', description: '一句话描述够长一些' } })).status, 200);
});

test('钩子配置的顶层形态：{"hooks":[...]} 也能就地改，其余键保留', async (t) => {
  const fx = await setup(t);
  const file = join(fx.dataDir, 'hooks.json');
  writeFileSync(file, `${JSON.stringify({ $comment: ['手写注释：别动它'], hooks: [] }, null, 2)}\n`, 'utf8');

  const res = await command(fx, 'hook-save', { hook: 'Wake', matcher: 'timer', command: 'echo hi' });
  assert.equal(res.status, 200, res.text);
  const doc = readJson<{ $comment?: string[]; hooks?: Array<Record<string, unknown>> }>(file);
  assert.deepEqual(doc.$comment, ['手写注释：别动它'], '整份文档读出来改再写回：注释键不能丢');
  assert.equal(doc.hooks?.length, 1);
  assert.equal(doc.hooks?.[0]?.['hook'], 'Wake');
});

test('钩子文件是坏 JSON 时：拒绝改它，但原文件一个字节不动', async (t) => {
  const fx = await setup(t);
  const file = join(fx.dataDir, 'hooks.json');
  const broken = '{ 这不是 JSON';
  writeFileSync(file, broken, 'utf8');
  const res = await command(fx, 'hook-save', { hook: 'Wake', matcher: 'timer', command: 'echo hi' });
  assert.equal(res.status, 400, res.text);
  assert.equal(errorCode(res), 'hooks-unreadable');
  assert.equal(readFileSync(file, 'utf8'), broken);
});

test('finalizePressure 之后的确认：写命令落一条 config/changed（可复盘）', async (t) => {
  const fx = await setup(t);
  await command(fx, 'mcp-save', { name: 'demo', command: 'node' });
  const events = await fx.readAll();
  const changed = events.filter((event) => event.type === 'config/changed');
  assert.equal(changed.length, 1, '改配置要在日志里留痕，否则事后查不出"她为什么多了一件工具"');
  assert.deepEqual((changed[0]!.data as { fields: string[] }).fields, ['mcp.servers']);
});

// ──────────────────────────────── 「她被怎么称呼」（文本提及） ────────────────────────────────

test('set-mention-keywords：写盘 + 落 config/changed + 热更回调（下一句消息就生效）', async (t) => {
  // 这条名单决定"群里不打 @ 直接喊她名字算不算在叫她"。人第一次多半填错（太宽误唤醒、
  // 太窄会漏），所以它必须是**当场能改当场能试**的：写盘之外还要热更运行期那份。
  const fx = await setup(t);
  const hot: Array<readonly string[]> = [];
  // 热更回调是装配时给的（main.ts 注入）；这里换一个能观测的实现重建一次服务端代价太大，
  // 所以直接断言"没给回调时如实说需要重启"这一半，另一半由 main.ts 的接线与 inbox 的用例覆盖
  const res = await command(fx, 'set-mention-keywords', { keywords: [' 伊尔弥亚 ', '弥亚小姐', '伊尔弥亚', ''] });
  assert.equal(res.status, 200, res.text);
  const body = res.body as { keywords: string[]; restartRequired: boolean };
  assert.deepEqual(body.keywords, ['伊尔弥亚', '弥亚小姐'], 'trim + 去重 + 丢空串');
  assert.equal(body.restartRequired, true, '没接热更回调时如实说"要重启"，不假装已生效');
  assert.deepEqual(hot, []);

  const channels = fx.configDoc()['channels'] as Record<string, unknown>;
  assert.deepEqual(channels['mentionKeywords'], ['伊尔弥亚', '弥亚小姐'], '盘上那份也写了');
});

test('set-mention-keywords：空数组是合法决定（= 只认平台的 @）', async (t) => {
  const fx = await setup(t);
  const res = await command(fx, 'set-mention-keywords', { keywords: [] });
  assert.equal(res.status, 200, res.text);
  const channels = fx.configDoc()['channels'] as Record<string, unknown>;
  assert.deepEqual(channels['mentionKeywords'], []);
});

test('set-mention-keywords：形状错一律 400，且盘上那份一个字节不动', async (t) => {
  const fx = await setup(t);
  const before = readFileSync(fx.configPath, 'utf8');
  for (const bad of [{}, { keywords: '伊尔弥亚' }, { keywords: [1] }, { keywords: ['这一串实在是太长了长到超过了二十四个字的上限所以必须被拒绝掉'] }]) {
    const res = await command(fx, 'set-mention-keywords', bad);
    assert.equal(res.status, 400, `应当拒绝：${JSON.stringify(bad)}`);
  }
  assert.equal(readFileSync(fx.configPath, 'utf8'), before, '拒绝的请求不许碰配置文件');
});
