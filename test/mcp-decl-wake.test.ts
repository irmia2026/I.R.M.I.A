/**
 * MCP 声明面变了 ⇒ **一次真唤醒** — src/web/server.ts 的 `mcp-save` / `mcp-remove`
 *
 * 用户原来的要求（原话）：「添加 mcp 时，就添加时**追加在上下文尾部，发起一次唤醒**，
 * 框架提示 `[发生mcp添加]` + desc + 工具全文」。接上单入口工具（`mcp`，v43）之后这条**简化成**：
 * 加/删/改 MCP 声明时发一次真唤醒，正文里说清"哪些 server 变了 / 现在一共几个 / 去哪看清单"
 * ——不再往上下文尾部塞工具全文（清单她要时自己用 `mcp` 工具看）。
 *
 * 判据不是"落了事件"，而是与 `job-wake.test.ts` **同一条纪律**：
 *   **真的起了一个 turn，且那条正文逐字出现在当轮请求体里**。
 * 这一份钉六件事：
 *   ① **事件落库 + 折投影**：`mcp-save` 之后 `wake/manual` 在盘上、且**运行期**就进了 `pending`
 *      （不是等下一次重启）——少了折投影那一格就是"日志里有、永远不起 turn"（job-wake 那条教训）；
 *   ② **真的起 turn**：跑一拍 → `turn/start` 出现；
 *   ③ **正文逐字进当轮请求体**：那一轮发给模型的请求里有她看到的那句话（连"指路"那一行）；
 *   ④ **反向：没有变更就不发**（同内容再存一次 ⇒ 零唤醒、零 turn）——每次保存都吵她一遍，
 *      这条通报很快就会变成噪音；
 *   ⑤ **合并**：连着改两笔（同一 5 秒时间片）⇒ **一条**唤醒、**一个** turn，正文里两边都列出来；
 *   ⑥ **删除也走同一条路**，而且正文说的是"删了谁 + 现在还剩几个"。
 *
 * 走**真链路**：真 EventLog + 真 fold + 真 HTTP 服务（真 config.json）+ 真 RealLoop，
 * 替身只有模型通道。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent } from '../src/log/types.ts';
import { emptyProjection } from '../src/log/types.ts';
import { RealLoop } from '../src/runtime/real-loop.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';

const TZ = 'Asia/Shanghai';
const TEST_TOKEN = 'test-token-mcp-decl-wake';
/** 夹具的时钟**冻在**这一刻：幂等时间片因此是确定的（同一个片里 ⇒ 合并成一条） */
const T0 = new Date('2026-10-09T15:00:00.000+08:00');

const PERSONA: PersonaAssets = {
  identity: 'IDENTITY',
  constitution: 'CONSTITUTION',
  style: 'STYLE',
  state: 'STATE',
  relationship: null,
  personaHash: 'test-hash',
  isSeed: false,
} as unknown as PersonaAssets;

/**
 * 模型替身：heavy 把每一次请求**逐字记下来**（"她这一轮看到了什么"就看它），
 * light 回一个空 JSON（轮首那次资产挑选；没有它 `prefetchAssetsLine` 会走异常分支）。
 */
function fakeDs(requests: unknown[]): DsClient {
  return {
    modelFor: (): string => 'fake',
    generate: async (): Promise<unknown> => ({
      status: 'completed',
      outputItems: [{ type: 'message', id: 'm1', text: '{"picks":[]}' }],
      usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, reasoningTokens: 0 },
      incompleteReason: null,
      model: 'fake-light',
      responseId: 'resp_light',
    }),
    stream: async (request: unknown): Promise<unknown> => {
      requests.push(request);
      return {
        status: 'completed',
        text: '嗯。',
        reasoning: '',
        toolCalls: [],
        outputItems: [],
        usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, reasoningTokens: 0 },
        incompleteReason: null,
        model: 'fake-heavy',
        responseId: 'resp_heavy',
        durationMs: 3,
        interrupted: false,
        failure: null,
      };
    },
  } as unknown as DsClient;
}

/**
 * 一次请求里**输入那一段的全部文本**（外层不套 JSON：Windows 路径里有反斜杠，
 * `JSON.stringify` 会把它转义成 `\\`，于是"路径在不在请求里"这种断言会因为转义而假红）。
 */
function textOfRequest(request: unknown): string {
  const input = (request as { input?: unknown }).input;
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  const parts: string[] = [];
  for (const item of input) {
    const content = (item as { content?: unknown }).content;
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
  }
  return parts.join('\n');
}

interface WakeEvent extends AppEvent {
  type: 'wake/manual';
  data: { note: string; via?: string; person?: string; dedupeKey?: string };
}

interface McpWakeRig {
  dir: string;
  configPath: string;
  base: string;
  server: WebServer;
  /** 她这一轮发给模型的请求（"看到了什么"的唯一判据） */
  requestText: () => string;
  /**
   * **最后那一次**请求的文本（"这一轮的请求体里有什么"要用它）。
   *
   * `requestText()` 是把所有请求拼起来的，用它测"这一轮里没有 X"会假红：
   * 前面某一轮的请求里出现过 X，拼起来的那份文本里就永远有 X。
   */
  lastRequestText: () => string;
  /** 跑一拍（生产里定时器回调与这里调的是同一个方法） */
  tick: () => Promise<void>;
  /** 盘上全部事件（含折叠之后的） */
  events: () => Promise<AppEvent[]>;
  /** 盘上某类事件 */
  ofType: <T extends string>(type: T) => Promise<AppEvent[]>;
  /** 投影里那几条**还没被认领**的唤醒的类型（"它是待办的活"的判据） */
  pendingTypes: () => Promise<string[]>;
  /** 配置文档（**盘上那一份**，不是内存里的回执） */
  configDoc: () => Record<string, unknown>;
  /** 落盘一份配置（塞高级字段、或造"两个 server 都变了"的场面用） */
  writeConfig: (doc: unknown) => void;
  /** 发一条写命令（危险操作：确认短语 = 命令名，与界面同形） */
  command: (name: string, body: unknown) => Promise<{ status: number; body: unknown }>;
  /**
   * 夹具的活注册表（2026-10-11 加）：`restartRequired` 那条判据里"**确实要重启**"的一面
   * 要靠它造出来——`mcp-remove` 顺带清清掉的 `tools.disabled` 就是今天唯一接不住的字段，
   * 而那一支只有在注册表里**真有一件被禁用的 `mcp__*` 工具**时才会走到。
   */
  registry: ToolRegistry;
  /**
   * 把夹具的时钟往前推（幂等时间片是 5 秒）：
   * "同一片里只叫一次"与"过了这一片会再叫一次"两条判据都要能测，时钟就得推得动。
   */
  advanceMs: (ms: number) => void;
}

/**
 * 建一台夹具。
 *
 * `reloadWired` 决定"热更接线活没活"（`WebServerDeps.configReload` 是生产那句
 * `() => configWatcher.live`）：缺省 **true**，与生产同形——本文件绝大多数用例测的是
 * "界面刚存了配置之后发生了什么"，而生产那台实例的接线是活的。
 * 给 `false` 只为一件事：造出"确实要重启"那一面（判据见 `WebServerImpl.mcpRestartOutcome`）。
 */
async function makeRig(t: TestContext, reloadWired = true): Promise<McpWakeRig> {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-mcp-decl-wake-'));
  const dataDir = join(dir, 'data');
  const configPath = join(dir, 'config.json');
  mkdirSync(dataDir, { recursive: true });
  // 与界面里"从零开始"那份一样：只有 schemaVersion，`mcp` 段根本还没写过
  writeFileSync(configPath, `${JSON.stringify({ schemaVersion: 1 }, null, 2)}\n`, 'utf8');

  const log = await EventLog.open(join(dataDir, 'events'));
  // **与生产同一份装配**（main.ts）：服务端与循环共用**同一个**投影对象，
  // 于是 `appendSync` 折进去的那条唤醒，`tickOnce` 当场看得见（少这一格就是"只落盘、不起 turn"）
  const projection = emptyProjection();
  // 时钟**从** T0 起，但推得动（见 `advanceMs`）：幂等时间片那两条判据都要测
  let clockMs = T0.getTime();
  const now = (): Date => new Date(clockMs);
  const requests: unknown[] = [];
  const registry = new ToolRegistry();
  const config = defaultConfig(dir);
  const server = await startWebServer({
    log,
    projection,
    config,
    personaRoot: join(dataDir, 'persona'),
    dataDir,
    timers: new TimerStore(join(dataDir, 'timers.json'), { now }),
    now,
    registry,
    uiToken: TEST_TOKEN,
    configPath,
    port: 0,
    out: () => {},
    // **与生产同形的热更接线**（2026-10-11 加）：main.ts 递给服务端的就是这一句
    // （`() => configWatcher.live`）。缺省 true ⇒ `restartRequired` 落在"声明面写盘即生效"
    // 那一侧；`makeRig(t, false)` 造另一侧（判据见 `WebServerDeps.configReload`）。
    configReload: () => reloadWired,
  });
  const loop = new RealLoop({
    log,
    dataDir,
    projection,
    now,
    timezone: TZ,
    ds: fakeDs(requests),
    registry,
    persona: PERSONA,
    config,
    out: () => {},
    pollMs: 3_600_000,
  });
  t.after(async () => {
    loop.stop();
    await server.close();
    log.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发的句柄占用：清理失败不影响断言结论 */
    }
  });

  const events = async (): Promise<AppEvent[]> => {
    log.flush();
    const out: AppEvent[] = [];
    for await (const event of log.readAll()) out.push(event);
    return out;
  };
  const configDoc = (): Record<string, unknown> =>
    JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;

  return {
    dir,
    configPath,
    base: server.url(),
    server,
    requestText: () => requests.map(textOfRequest).join('\n'),
    lastRequestText: () => (requests.length === 0 ? '' : textOfRequest(requests[requests.length - 1])),
    tick: async () => { await loop.tickOnce(); },
    events,
    ofType: async <T extends string>(type: T): Promise<AppEvent[]> =>
      (await events()).filter((event) => event.type === type),
    pendingTypes: async () => {
      const out: string[] = [];
      for (const item of projection.pending) {
        const event = log.get(item.wakeSeq);
        if (event !== null) out.push(event.type);
      }
      return out;
    },
    configDoc,
    writeConfig: (doc: unknown) => { writeFileSync(configPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8'); },
    command: async (name, body) => {
      const response = await fetch(`${server.url()}/api/commands/${name}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          'content-type': 'application/json',
          'x-confirm': name,
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed };
    },
    advanceMs: (ms: number) => { clockMs += ms; },
    registry,
  };
}

/** 盘上全部 `wake/manual` 里 `via === 'mcp'` 的那些（MCP 通报的唯一判据） */
async function mcpWakes(rig: McpWakeRig): Promise<WakeEvent[]> {
  return (await rig.ofType('wake/manual'))
    .filter((event): event is WakeEvent => (event as WakeEvent).data.via === 'mcp');
}

// ──────────────────────── ① 加一个 server：事件 + pending + 真 turn + 正文进请求 ────────────────────────

test('mcp-save 加服务：落一条真唤醒、跑一拍起 turn、正文逐字进当轮请求体', async (t) => {
  const rig = await makeRig(t);
  const res = await rig.command('mcp-save', {
    name: 'filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    env: { ROOT: 'D:/work' },
    enabled: true,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  // ① 事件落库：一条 `wake/manual`，带 via 标记（界面据此走框架卡片，不当成用户说的话）
  const wakes = await mcpWakes(rig);
  assert.equal(wakes.length, 1, `加一个 server ⇒ 正好一条唤醒（不连发）：${JSON.stringify(wakes)}`);
  const wake = wakes[0]!;
  assert.equal(wake.visibility, 'model', '它要进她的上下文（internal 的那条她看不见）');
  assert.equal(wake.data.via, 'mcp');
  assert.equal(wake.data.person, undefined, '用户没开口，不带人（带了就会把关系档案注进这一轮）');

  // 正文四件事都在：变了什么 / 现在几个 / 去哪看清单
  assert.ok(wake.data.note.includes('加了 filesystem'), `要点名是哪个 server：${wake.data.note}`);
  assert.ok(wake.data.note.includes('现在一共 1 个'), '要说清现在一共几个');
  assert.ok(wake.data.note.includes('`mcp` 工具'), '要指一条**能用**的路（清单在 mcp 工具里）');
  assert.ok(wake.data.note.includes('不带 server'), '"不带 server 看有哪些"这一句要在');

  // ① 反向：还没跑拍时，不许已经有 turn（否则这条用例测不出"真唤醒"）
  assert.equal((await rig.ofType('turn/start')).length, 0, '"落了事件"本身不是唤醒');
  assert.deepEqual(await rig.pendingTypes(), ['wake/manual'], '它是**待办的活**，不是一条躺着的通知');

  // ② 真唤醒：跑一拍 → 真 turn
  await rig.tick();
  const types = (await rig.events()).map((event) => event.type);
  assert.equal(types.includes('turn/start'), true, 'MCP 声明变了必须真的起一个 turn');
  assert.equal(types.includes('input/claimed'), true, '那条唤醒要被这一轮认领掉（不留在队列里反复叫）');

  // ③ 正文真的进了**当轮请求体**
  const text = rig.requestText();
  assert.ok(text.includes('你手边的 MCP 声明改了：加了 filesystem。现在一共 1 个。'),
    `唤醒正文必须逐字进她这一轮的请求：\n${text.slice(-1200)}`);
  assert.ok(text.includes('要看工具清单就用 `mcp` 工具（不带 server 看有哪些 server）。'),
    '指路那一行也要在（她要能自己去捞清单）');
  assert.deepEqual(await rig.pendingTypes(), [], '这一轮认领完 ⇒ 队列清空');

  // 回执里如实说"叫没叫她"（人在界面上会问这一句）
  const body = res.body as { changedServers?: string[]; wake?: string };
  assert.deepEqual(body.changedServers, ['filesystem']);
  assert.ok((body.wake ?? '').includes('已按既有那条真唤醒路径'), `回执要说清走了哪条路：${String(body.wake)}`);
});

// ──────────────────────── ② 反向：没有变更 ⇒ 不发（别每次保存都吵她） ────────────────────────

test('反向：声明面没变就不发——同内容再存一次 ⇒ 零新唤醒、零新 turn', async (t) => {
  const rig = await makeRig(t);
  const payload = {
    name: 'filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    env: { ROOT: 'D:/work' },
    enabled: true,
  };
  await rig.command('mcp-save', payload);
  await rig.tick();
  const wakesAfterFirst = (await mcpWakes(rig)).length;
  const turnsAfterFirst = (await rig.ofType('turn/start')).length;
  assert.equal(wakesAfterFirst, 1);
  assert.equal(turnsAfterFirst, 1);

  // 同一个 payload 再存一次（界面上"点了保存但什么都没改"就是这个形状）
  const again = await rig.command('mcp-save', payload);
  assert.equal(again.status, 200, '保存本身照旧成功（只是不叫她）');
  assert.equal((await mcpWakes(rig)).length, wakesAfterFirst, '声明面没变 ⇒ 不许再落一条唤醒');
  assert.equal((again.body as { changedServers?: string[] }).changedServers?.length, 0);
  assert.ok(((again.body as { wake?: string }).wake ?? '').includes('没叫她'),
    `回执要如实说没叫：${String((again.body as { wake?: string }).wake)}`);

  await rig.tick();
  assert.equal((await rig.ofType('turn/start')).length, turnsAfterFirst, '没有唤醒 ⇒ 起不了新 turn');

  // **切过去再切回来也算没变**（净效果为零）：这条是"别按按钮次数说话"的判据
  await rig.command('mcp-save', { ...payload, enabled: false });
  await rig.command('mcp-save', { ...payload, enabled: true });
  await rig.tick();
  assert.equal((await rig.ofType('turn/start')).length, turnsAfterFirst + 1,
    '两次真改动落在同一个 5 秒时间片里 ⇒ 只叫一次（一条唤醒 = 一个 turn）');
});

// ──────────────────────── ③ 合并：同一次保存 / 同一时间片只叫一次 ────────────────────────

test('合并：同一时间片里连着改同一个 server ⇒ 只起一个 turn（日志留痕，但只叫一声）', async (t) => {
  const rig = await makeRig(t);
  await rig.command('mcp-save', { name: 'alpha', command: 'node', args: ['a.mjs'], enabled: true });
  await rig.tick();
  const turnsBefore = (await rig.ofType('turn/start')).length;

  // 界面上连着点两下（先停用再启用）：两笔都是真改动，但落在**同一个 5 秒时间片**里。
  // 后一笔的幂等键与前一笔记相同（键算的是"动了哪些 server"，不是那句会变的正文）。
  //
  // ⚠️ 两条 `wake/manual` **都会落进日志**（appendSync 是"写日志 + 折投影"，写日志那一步
  // 不看幂等键——幂等是 fold 的事）。所以"合并没有合并"的判据不是"日志里有几条"，
  // 而是**起了几个 turn / 她的请求体里有几句**：第二笔撞上幂等窗口 ⇒ 不进 pending ⇒ 没有第二个 turn。
  await rig.command('mcp-save', { name: 'alpha', command: 'node', args: ['a.mjs'], enabled: false });
  await rig.command('mcp-save', { name: 'alpha', command: 'node', args: ['a.mjs'], enabled: true });
  const wakes = await mcpWakes(rig);
  assert.equal(wakes[wakes.length - 1]!.data.dedupeKey, wakes[wakes.length - 2]!.data.dedupeKey,
    '两笔的幂等键必须相同（键算的是"动了哪些 server"+时间片，不是那句会变的正文）');
  // **合并的判据是队列**：两条事件都落了日志（写日志不看幂等键），但折叠之后队列里只该有**一条**。
  assert.deepEqual(await rig.pendingTypes(), ['wake/manual'],
    '同一个幂等键的第二条不进队列（这就是"只叫一声"的落点）');

  // 写命令本身不起 turn（要跑一拍才起），而且这一拍只应起**一个**
  assert.equal((await rig.ofType('turn/start')).length, turnsBefore, '写命令本身不起 turn');
  await rig.tick();
  assert.equal((await rig.ofType('turn/start')).length, turnsBefore + 1,
    '两笔落在同一时间片 ⇒ 只起一个 turn（"真唤醒"不许变成"连着叫醒两次"）');
  const text = rig.lastRequestText();
  assert.ok(text.includes('你手边的 MCP 声明改了：改了 alpha。现在一共 1 个。'),
    `留下的那条正文要逐字进请求体：\n${text.slice(-1200)}`);
  assert.deepEqual(await rig.pendingTypes(), [], '这一轮认领完 ⇒ 队列清空');
  // 这一轮的**输入段**（帧尾的"本轮固定块"之前那一段）里只有那一条通报；
  // 帧尾之后是环境层与状态层，那里再出现同一条属于"本轮输入被重述一遍"的既有版式。
  const inputPart = text.split('以下为框架提供的本轮固定块')[0] ?? '';
  // 输入段里按**逐字正文**去看，出现的通报只有两种：上一轮那条"加了 alpha"与本轮这条"改了 alpha"。
  // （同一条正文在输入段里出现两次是既有的版式：它在上下文里，同时又是这一轮的任务卡/输入镜像。
  //  所以这里数的是**有哪几种**，而不是**有几行**——"被合并掉的那一笔也在"才是要防的事。）
  const notes = new Set(
    inputPart.match(/你手边的 MCP 声明改了：[^\n]*/gu) ?? [],
  );
  assert.deepEqual([...notes].sort(), [
    '你手边的 MCP 声明改了：加了 alpha。现在一共 1 个。',
    '你手边的 MCP 声明改了：改了 alpha。现在一共 1 个。',
  ], `输入段里只该有这两种通报：\n${inputPart.slice(-800)}`);

  // 通报名点是"改了 alpha"（不是"加了/删了"）：两笔之间那个中间态（停用）没有被通报，
  // 但**盘上现在是启用**——她去读配置时读到的是最新事实，通报只说"它变了"。
  const kept = (rig.configDoc() as { mcp: { servers: Array<Record<string, unknown>> } }).mcp.servers[0]!;
  assert.equal(kept['disabled'], undefined, '盘上那份是最后一次写命令的结果（启用）');
});

// ──────────────────────── ③b 合并的边界：不同时间片的两次编辑各叫一次 ────────────────────────

test('两次编辑落在不同时间片 ⇒ 各发一条通报（合并是"同一片里算一次"，不是"永远只叫一次"）', async (t) => {
  const rig = await makeRig(t);
  await rig.command('mcp-save', { name: 'alpha', command: 'node', args: ['a.mjs'], enabled: true });
  await rig.tick();
  const wakesBefore = (await mcpWakes(rig)).length;

  await rig.command('mcp-save', { name: 'beta', command: 'node', args: ['b.mjs'], enabled: true });
  rig.advanceMs(6_000);
  await rig.command('mcp-save', { name: 'gamma', command: 'node', args: ['c.mjs'], enabled: true });
  // 两笔改的是两件事、落在两个时间片 ⇒ 两条通报（它们不是"同一次保存"）。
  // 至于它们会不会落进**同一个 turn**：那是唤醒门/认领那套既有语义的事（同一拍里两条都到
  // ⇒ 一趟 turn 把它们一起认领掉），不是这条通报该管的事——所以这里断言的是通报条数与正文。
  const wakes = await mcpWakes(rig);
  assert.equal(wakes.length, wakesBefore + 2, '两个时间片、两次改动 ⇒ 两条通报');

  await rig.tick();
  const text = rig.lastRequestText();
  assert.ok(text.includes('你手边的 MCP 声明改了：加了 gamma。现在一共 3 个。'),
    `后一笔的正文要逐字进她这一轮的请求体：\n${text.slice(-1200)}`);
  assert.ok(text.includes('你手边的 MCP 声明改了：加了 beta。现在一共 2 个。'),
    '前一笔那条照旧留在这一轮的上下文里（她刚看过的通报不该凭空消失）');
  assert.deepEqual(await rig.pendingTypes(), [], '两条都认领掉了（不留在队列里反复叫）');
});

// ──────────────────────── ④ 删除：同一条路，正文说"删了谁 + 还剩几个" ────────────────────────

test('mcp-remove 删服务：也发一次真唤醒，正文说清删了谁、现在还剩几个', async (t) => {
  const rig = await makeRig(t);
  await rig.command('mcp-save', { name: 'demo', command: 'node', args: ['server.mjs'], enabled: true });
  await rig.command('mcp-save', { name: 'keep', command: 'node', args: ['other.mjs'], enabled: true });
  await rig.tick();

  const res = await rig.command('mcp-remove', { name: 'demo' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const wakes = await mcpWakes(rig);
  const removal = wakes.find((event) => event.data.note.includes('删了'));
  assert.ok(removal !== undefined, `删除也要叫她一次：${JSON.stringify(wakes.map((w) => w.data.note))}`);
  assert.ok(removal.data.note.includes('删了 demo'), removal.data.note);
  assert.ok(removal.data.note.includes('现在一共 1 个'), `要说清现在还剩几个：${removal.data.note}`);

  await rig.tick();
  const text = rig.requestText();
  assert.ok(text.includes('你手边的 MCP 声明改了：删了 demo。现在一共 1 个。'),
    `删除那条正文要逐字进请求体：\n${text.slice(-1200)}`);
});

// ──────────────────────── ⑤ 极端：删到一个都不剩 / 高级字段与空袋子怎么算 ────────────────────────

test('删到一个都不剩时说"现在一个都没有了"；高级字段变了算改、省略它不算改、空 env 不算改', async (t) => {
  const rig = await makeRig(t);
  // 每一笔真改动都推过一个时间片：这一条测的是**声明面怎么比**，不是合并
  //（合并那两条判据在 ②/③ 里，时钟不推的情形正好由它们压着）
  rig.advanceMs(6_000);
  await rig.command('mcp-save', { name: 'only', command: 'node', args: ['a.mjs'], enabled: true });
  rig.advanceMs(6_000);
  await rig.command('mcp-remove', { name: 'only' });
  const wakes = await mcpWakes(rig);
  assert.equal(wakes.length, 2, '加一条 + 删一条 = 两条通报（同一时间片里才会合并）');
  const last = wakes[wakes.length - 1]!;
  assert.ok(last.data.note.includes('删了 only'), last.data.note);
  assert.ok(last.data.note.includes('现在一个都没有了'),
    `一个都不剩时不许写"一共 0 个"（那读起来像故障码）：${last.data.note}`);

  // ① 盘上那份被手工改过（args 里多了一个 `--flag`）⇒ 界面这次保存把它改回来**也是**一次真改动：
  //    声明面与之前不同，她手上的印象就得跟上（"谁改的"不重要，事实是它变了）。
  await rig.command('mcp-save', { name: 'adv', command: 'node', args: ['a.mjs'], enabled: true });
  await rig.tick();
  const doc = rig.configDoc() as { mcp: { servers: Array<Record<string, unknown>> } };
  const advEntry = doc.mcp.servers.find((item) => item['name'] === 'adv');
  assert.ok(advEntry !== undefined, '刚存进去的那条要在盘上');
  advEntry['args'] = ['a.mjs', '--flag'];
  advEntry['cwd'] = 'D:/work';
  rig.writeConfig(doc);
  const wakesBeforeAdv = (await mcpWakes(rig)).length;
  rig.advanceMs(6_000);
  const advRes = await rig.command('mcp-save', { name: 'adv', command: 'node', args: ['a.mjs'], enabled: true });
  const wakesAfterAdv = await mcpWakes(rig);
  assert.equal(wakesAfterAdv.length, wakesBeforeAdv + 1, '盘上那份声明变了就是声明变了');
  assert.ok(wakesAfterAdv[wakesAfterAdv.length - 1]!.data.note.includes('改了 adv'),
    wakesAfterAdv[wakesAfterAdv.length - 1]!.data.note);
  assert.deepEqual((advRes.body as { changedServers?: string[] }).changedServers, ['adv'],
    '回执里的改动列表也要点名是哪一个');
  await rig.tick();

  // ② **没在界面上暴露、又没写进 payload 的**字段（cwd / toolDefaults）原样保留：
  //    保留之后的声明面与之前逐字段相同 ⇒ 不叫她（"保存"不等于"变了"，这是这条通报不变成噪音的关键）。
  rig.advanceMs(6_000);
  const turnsBefore = (await rig.ofType('turn/start')).length;
  const same = await rig.command('mcp-save', { name: 'adv', command: 'node', args: ['a.mjs'], enabled: true });
  assert.equal((await mcpWakes(rig)).length, wakesAfterAdv.length, '"原样保留"不许被算成"改了"');
  assert.deepEqual((same.body as { changedServers?: string[] }).changedServers, []);
  await rig.tick();
  assert.equal((await rig.ofType('turn/start')).length, turnsBefore, '没有变更 ⇒ 没有新 turn');
  const kept = (rig.configDoc() as { mcp: { servers: Array<Record<string, unknown>> } }).mcp.servers
    .find((item) => item['name'] === 'adv')!;
  assert.equal(kept['cwd'], 'D:/work', '界面没暴露的字段照旧原样保留（这条纪律没被这条改动碰到）');
  assert.equal(kept['env'], undefined, '没碰过的字段也不许被顺手添上（界面上没有它）');

  // ③ `env: {}` 与"没有 env"是同一个声明（界面上每次添加都带一个空袋子）：
  //    差这一条就会每点一次保存都白叫一声。
  rig.advanceMs(6_000);
  const beforeEmptyEnv = (await mcpWakes(rig)).length;
  await rig.command('mcp-save', { name: 'adv', command: 'node', args: ['a.mjs'], env: {}, enabled: true });
  assert.equal((await mcpWakes(rig)).length, beforeEmptyEnv,
    '空 env 与没有 env 是同一个声明（否则界面上每点一次保存都会白叫一声）');
});

// ──────────────────────── ⑥ 不许把一次成功的写盘变成 500（唤醒是通报，不是写命令的前置） ────────────────────────

test('没有变更时那两格回执：改变动列表为空，且理由说的是"没变"而不是"被幂等吞了"', async (t) => {
  const rig = await makeRig(t);
  const first = await rig.command('mcp-save', { name: 'solo', command: 'node', args: ['a.mjs'], enabled: true });
  assert.equal(first.status, 200);
  const second = await rig.command('mcp-save', { name: 'solo', command: 'node', args: ['a.mjs'], enabled: true });
  const body = second.body as {
    changedServers?: string[]; wake?: string; restartRequired?: boolean; effect?: string; restartNote?: string;
  };
  assert.deepEqual(body.changedServers, []);
  /**
   * **`restartRequired` 的判据（2026-10-11 改口径）**：这一格回答的是
   * "这次改动**在活进程里生效了吗**"——没生效才回 `true`。
   *
   * 本用例钉的是它的**第一格：净效果为零**。同内容再存一次，盘上那份与原来逐字段相同
   * （`effect === 'unchanged'`、`changedServers` 为空）⇒ **没有要生效的东西**，
   * 于是接线活没活都不该喊重启（接线活着也喊，就是为一次"什么都没改"的保存叫人多按一次）。
   * 判据在三处成一条线：`WebServerImpl.mcpRestartOutcome` 的第一种情形（方法头就是判据那一处）、
   * 界面 `extensions_page.dart` 的 `_mcpWriteOutcome`（`effect == 'unchanged'` 先说"没有改动"）。
   *
   * ⚠️ 旧判据（"回执里那句要重启的话不许因为这条改动丢掉"，`assert.equal(..., true)`）已经作废：
   * 它是热更落地**之前**的事实，留着就是让人为一次已生效（或压根没发生）的改动去重启。
   * 两面各有一条用例：**这一条钉"没有要生效的东西"**，
   * 下面那条 `确实要重启那一面` 钉"有改动、而活进程里没人接住"。
   */
  assert.equal(body.effect, 'unchanged', '净效果为零（同内容再存一次）⇒ 这一格必须如实说"没改动"');
  assert.equal(body.restartRequired, false, '没有要生效的东西 ⇒ 不必重启（接线活着也一样，别为一次空保存叫人重启）');
  assert.match(String(body.restartNote), /没有改动任何东西/u, `理由要说"没改"，而不是别的：${String(body.restartNote)}`);
  assert.equal(body.wake, '这次声明面没变，没叫她');

  // 盘上确实只有一条声明（"没变"是真结论，不是没写进去）
  const doc = rig.configDoc() as { mcp: { servers: Array<Record<string, unknown>> } };
  assert.equal(doc.mcp.servers.length, 1);
});

test('确实要重启那一面：有改动、而活进程里没人接住 ⇒ 如实回 true 并说清为什么', async (t) => {
  // 接线**没活**（`configReload: () => false`）：那一刻配置写了、活进程一字未动。
  // 这一支在**生产上今天是不可达的**（main.ts 递的就是 `() => configWatcher.live`，
  // 常驻实例里恒为 true）——它可测的等价物是"夹具 / 内嵌方 / `stop()` 之后"，
  // 也正是 `test/extensions-commands.test.ts` 里那批夹具的真实形状。
  const rig = await makeRig(t, false);
  const res = await rig.command('mcp-save', { name: 'orphan', command: 'node', args: ['a.mjs'], enabled: true });
  assert.equal(res.status, 200, '接线没活**不是**写命令的失败条件：盘照写');
  const body = res.body as { restartRequired?: boolean; restartNote?: string; effect?: string };
  /**
   * 判据在这里只认一件事：**这次改动到底生效了没有**。
   * 写盘是真的（下面读盘复核），但本进程里没有任何人接管配置变化 ⇒ `restartRequired: true`，
   * 且**理由要说出来**（"没人在本进程里接管"），不能只丢一个 `true` 让人猜。
   */
  assert.equal(body.effect, 'updated', '这次是真改动（不是 unchanged），所以才有"要不要重启"这个问题');
  assert.equal(body.restartRequired, true, '盘上变了、活进程一字未动 ⇒ 必须如实说要重启');
  assert.match(String(body.restartNote), /重启主进程才生效/u, `那一格必须给理由：${String(body.restartNote)}`);
  assert.match(String(body.restartNote), /没人在本进程里接管|热更接线没活/u,
    `理由要说清是"没人接住"这一类，而不是别的：${String(body.restartNote)}`);
  // 盘上那份**确实**写进去了：这一条与"要重启"不矛盾——它说的正是"盘上有了、进程还没跟上"
  const doc = rig.configDoc() as { mcp: { servers: Array<Record<string, unknown>> } };
  assert.equal(doc.mcp.servers.length, 1, '断言的是"盘上写了但没人接管"，不是"没写进去"');
});

// ──────────────────────── ⑥b 确实要重启的另一条路：顺带写下的字段不在热更名单里 ────────────────────────

test('确实要重启（第二支）：接线活着，但顺带写的 tools.disabled 不在热更名单里 ⇒ 点名那一格', async (t) => {
  // 这是**今天唯一一条接线活着、却仍然要重启的活路径**，也是判据注册表里唯一一条：
  // `mcp-remove` 删一条声明时会顺带清掉 `tools.disabled` 里指向它的条目，而那一格是
  // **工具装配参数**（不进 `HOT_RELOAD_FIELDS`，池的 `applyDeclarations` 不管它）
  // ⇒ 盘上那份名单要重启才与运行中的注册表一致。
  const rig = await makeRig(t);
  await rig.command('mcp-save', { name: 'demo', command: 'node', args: ['server.mjs'], enabled: true });
  // 注册一件 `mcp__demo__*` 工具并**关掉它**——`tool-toggle` 写的就是 `tools.disabled`
  // （它自己的口径照旧是"要重启才装配"，本用例不替它改口径）
  rig.registry.register({
    name: 'mcp__demo__echo',
    description: 'MCP 回显',
    parameters: { type: 'object', properties: {} },
    executionMode: 'exclusive',
    sideEffect: 'destructive',
    timeoutMs: 1000,
    handler: async () => ({ content: 'ok' }),
  });
  const toggled = await rig.command('tool-toggle', { name: 'mcp__demo__echo', enabled: false });
  assert.equal(toggled.status, 200, JSON.stringify(toggled.body));

  const removed = await rig.command('mcp-remove', { name: 'demo' });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const body = removed.body as {
    restartRequired?: boolean; restartNote?: string; appliedFields?: string[]; prunedDisabledTools?: string[];
  };
  assert.deepEqual(body.prunedDisabledTools, ['mcp__demo__echo'], '这一支的前提：真清掉了一条禁用条目');
  assert.deepEqual(body.appliedFields, ['mcp.servers', 'tools.disabled'],
    '回执要能看出"这次写了哪两格"——`tools.disabled` 在里面就是要重启的原因');
  assert.equal(body.restartRequired, true, '`tools.disabled` 接不住 ⇒ 即使接线活着也要重启');
  assert.match(String(body.restartNote), /tools\.disabled/u, `点名是哪一格接不住：${String(body.restartNote)}`);
  assert.match(String(body.restartNote), /禁用名单/u, `理由要说人话（不是只丢一个字段名）：${String(body.restartNote)}`);
  // 盘上那两格都真的落了
  const doc = rig.configDoc() as { mcp?: { servers?: unknown[] }; tools?: { disabled?: string[] } };
  assert.equal((doc.mcp?.servers ?? []).length, 0, '声明删掉了');
  assert.deepEqual(doc.tools?.disabled, [], '禁用名单也清了（这正是要重启的那一格）');
});
