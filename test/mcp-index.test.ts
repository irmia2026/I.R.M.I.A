/**
 * MCP 常驻索引（v46）—— 用户 2026-10-10 那三条判据的执行版。
 *
 * ──────────────────────────── 设计（用户原话，逐字） ────────────────────────────
 *
 * 「虽然有了入口，但是**还是需要有对应的索引存在**。**mcp 的存在类同 skill**。不过**入口不是
 *  自己读而是我们的统一 mcp 工具**。」
 * 「**增删进入上下文的方式依然还是。追加在末，固定位置，直到上下文重大变化时归集到正确的
 *  索引位置。**」
 *
 * 落成四条判据，**这一整个文件就是它们**：
 *   ① **索引常驻**：与技能 catalog 同源同位（请求头部那段长期记忆层，紧挨着它），每个 server
 *      一行——名字 + 启用/停用 + 工具数（**标明来源**）+ 一句"要看工具就调 mcp 工具"；
 *      **一个工具名都不在这段里**（那会把清单搬回常驻，v43 的披露式入口就白做了）；
 *      空的时候**整段不出现**（与技能 catalog 的 null 语义一致）。
 *   ② **冻结**：两次重大变化之间，**加一个 server 不改请求前缀**（正面断言：索引段字节不变，
 *      而那件事走尾部追加）。判据的判据：索引只从日志里那条 `mcp/index` 快照读。
 *   ③ **归集**：压缩 / reset（`compaction/summary`）之后，索引用**当前配置**重建 ⇒
 *      新加的 server 出现在索引里，"尾部那条追加"不再是唯一知道有它的地方。
 *   ④ **旧日志重放不失真**：老轮次没有这一段时**不许被补写**（缺省即整段不出现）；
 *      带这一段的新轮次，`replay` 重建出**同一串字节**。
 *
 * ──────────────────────────── 为什么用真 RealLoop ────────────────────────────
 *
 * 前三条都是"整条链路上发生了什么"（轮首同步 → 落事件 → 渲染 → 请求体），任何一层用替身
 * 搭出来，测的就不是那条链路。所以这里用 `test/fixtures/real-wake-rig.ts`（真 EventLog、
 * 真 fold、真 agent-loop、真 render、真 RealLoop 的 tick，**只有模型是假的**）——
 * 与 `heartbeat-real-wake.test.ts` 同一个台子。
 *
 * ⚠️ **台子的那个已知盲区照旧**（`render.ts` 的 v43/v44 那两篇记过）：它交给 RealLoop 的
 * 注册表默认是空的 ⇒ 请求体里 `tools` 是 `[]`。这一版断言的是**索引段**，与工具清单无关，
 * 所以不补 `registerTools`（那会改掉指纹基线，与本版无关）。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEFAULT_DATA_DIR_NAME, defaultConfig } from '../src/config/config.ts';
import type { AppConfig } from '../src/config/config.ts';
import type { AppEvent } from '../src/log/types.ts';
import { MCP_TOOLS_CACHE_DIR, MCP_TOOLS_CACHE_VERSION } from '../src/mcp/client.ts';
import { RENDER_VERSION } from '../src/model/render.ts';
import { MCP_INDEX_HEADER, MCP_INDEX_DESC_CLAUSE_VERSION, mcpIndexView } from '../src/persona/assets.ts';
import { locateStep, rebuildRenderedRequest } from '../src/runtime/replay.ts';
import { makeRealWakeRig } from './fixtures/real-wake-rig.ts';
import type { RealWakeRig } from './fixtures/real-wake-rig.ts';

/** 台子的数据目录（`defaultConfig(dir)` 的 `dataDir` 就是 `<dir>/data`） */
function dataDirOf(workspace: string): string {
  return join(workspace, DEFAULT_DATA_DIR_NAME);
}

/** 一个 server 的配置（判据只关心名字 / disabled / desc；命令随便给一个不存在的——**永远不会被起**） */
function server(name: string, extra: { disabled?: boolean; desc?: string } = {}): unknown {
  return {
    name,
    command: 'definitely-not-a-real-command',
    args: [],
    ...(extra.disabled === true ? { disabled: true } : {}),
    ...(extra.desc === undefined ? {} : { desc: extra.desc }),
  };
}

/** 往配置里放几个 server（`patchConfig` 在 RealLoop 构造**之前**跑，与生产"改配置 + 重启"同形） */
function withServers(names: readonly string[]): (config: AppConfig) => void {
  return withServerDefs(names.map((name) => server(name)));
}

/** 同上，但给的是**完整的条目**（要带 `desc` 的那几条走这里——v48 起索引行里有那一截） */
function withServerDefs(defs: readonly unknown[]): (config: AppConfig) => void {
  return (config) => {
    (config.mcp as { servers: unknown[] }).servers = [...defs];
  };
}

/** 造一份落盘工具清单缓存（**池写它的那几格**：version / server / tools / fetchedAtMs） */
function writeToolsCacheInto(cacheRoot: string, name: string, tools: string[], fetchedAtMs: number): void {
  const dir = join(cacheRoot, MCP_TOOLS_CACHE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({
    version: MCP_TOOLS_CACHE_VERSION,
    server: name,
    fingerprint: 'test-fingerprint',
    fetchedAtMs,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    listSummary: { pages: 1, tools: tools.length, truncated: false, nextCursor: null },
    tools: tools.map((toolName) => ({ name: toolName, description: `${toolName} 的说明` })),
  }), 'utf8');
}

/**
 * 同上，但**自报的描述里不含工具名**。
 *
 * 为什么需要这么一份（v48 实测发现的）：`desc` 缺失时索引行会用"它自报的第一句工具描述"兜底
 * （带标注"据它自报的工具描述"）。而那个兜底**不该把工具名带进常驻索引**——工具清单是披露式的
 * （只在 `mcp` 工具被调用时以工具结果进上下文），索引里一个工具名都不该有。
 * 缓存里写 `secret_tool_name 的说明` 时，兜底那句话恰好把名字捎了进来
 * （见 ①b 的判据）——所以那条用例要的是这一份缓存，而不是"把兜底关掉"。
 */
function writeToolsCacheNoNameInDesc(
  cacheRoot: string, name: string, tools: string[], fetchedAtMs: number,
): void {
  const dir = join(cacheRoot, MCP_TOOLS_CACHE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({
    version: MCP_TOOLS_CACHE_VERSION,
    server: name,
    fingerprint: 'test-fingerprint',
    fetchedAtMs,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    listSummary: { pages: 1, tools: tools.length, truncated: false, nextCursor: null },
    tools: tools.map((toolName) => ({ name: toolName, description: '读本机浏览器历史与当前标签页。' })),
  }), 'utf8');
}

/** 台子那一路：缓存落在**数据目录**里（`<工作区>/data/mcp-cache/…`，与生产同形） */
function writeToolsCache(workspace: string, name: string, tools: string[], fetchedAtMs: number): void {
  writeToolsCacheInto(dataDirOf(workspace), name, tools, fetchedAtMs);
}

/** 请求体里那段**长期记忆层**（第一条 developer item）的文字；没有那一段时给空串 */
function memoryLayerOf(request: { input?: unknown }): string {
  const items = Array.isArray(request.input) ? request.input : [];
  const first = items[0] as { role?: string; content?: unknown } | undefined;
  if (first === undefined || first.role !== 'developer') return '';
  return typeof first.content === 'string' ? first.content : '';
}

/** 请求体里那段 **MCP 索引**（长期记忆层里以表头开头的那一段）；没有时给空串 */
function mcpSegmentOf(request: { input?: unknown }): string {
  const layer = memoryLayerOf(request);
  const at = layer.indexOf('[MCP server]');
  if (at < 0) return '';
  // 段与段之间是空行（`renderMemoryLayer` 的 join('\n\n')）⇒ 取到下一个空行为止
  const rest = layer.slice(at);
  const end = rest.indexOf('\n\n');
  return end < 0 ? rest : rest.slice(0, end);
}

/** 台子上跑一拍（真 `tickOnce`：ensureReady → 索引同步 → … → 认领 → turn） */
async function tick(rig: RealWakeRig): Promise<void> {
  await rig.tick();
}

/** 把台子日志里的全部事件读出来 */
async function eventsOf(rig: RealWakeRig): Promise<AppEvent[]> {
  const events: AppEvent[] = [];
  for await (const event of rig.log.readAll()) events.push(event);
  return events;
}

/**
 * 用 CLI 那条重建路把 `(turn, step)` 重建出来（**同一份 `deriveRequest`**，见 replay.ts）。
 *
 * 这里刻意不传 `dataDir`/`memoryIndex`：那两样是"从盘上读现在这份"的有损来源，
 * 与本次要验的**索引段**无关；少传它们，断言就只盯索引那一处。
 */
function rebuildTurnOne(events: readonly AppEvent[]): string {
  const position = locateStep(events, 1, 1);
  // 用 if 而不是 `assert.equal` 收窄：`assert.equal` 的签名把它推成 never，后面读 `reason` 就编不过
  if (!position.ok) throw new Error(`定位不到 turn 1 step 1：${position.reason}`);
  const request = rebuildRenderedRequest(position, {
    persona: {
      identity: 'I', constitution: 'C', style: 'S',
      state: 'STATE', personaHash: 'h', relationship: null,
    },
    tools: [],
    timezone: 'Asia/Shanghai',
    now: position.stepStart.ts,
  });
  return stableHeadOf(request.input);
}

/**
 * 请求体里**本轮之外**的那几段（长期记忆层 + 本轮新输入）：索引段与唤醒行都在其中。
 *
 * 为什么不直接比整个 `input`：这条用例要钉的是"索引那一段从事件重建得回来"，
 * 而本轮固定块与此刻层里还有**别的**"只能取现在这份"的来源（STATE/记忆索引文件、磁盘余量、
 * 进程 uptime）——它们本来就不在事件里，比它们等于把别处的有损重建记到这一版头上。
 * 剥掉之后剩下的那几段正好是：长期记忆层（含索引段）+ 本轮新输入（唤醒那一行）。
 */
function stableHeadOf(input: unknown): string {
  const items = Array.isArray(input) ? input : [];
  return JSON.stringify(items.filter((item) => {
    const text = typeof (item as { content?: unknown }).content === 'string'
      ? (item as { content: string }).content
      : '';
    return !text.includes('以下为框架提供的本轮固定块') && !text.includes('以下为框架提供的此刻层');
  }));
}

const CACHE_AT_MS = Date.parse('2026-02-14T09:00:00.000Z');

// ──────────────────────────────── ① 索引段本身 ────────────────────────────────

test('① 有 server 时：索引段进长期记忆层（与技能 catalog 同段素材），逐字样本', async (t) => {
  const rig = await makeRealWakeRig({
    // v48：行里那一截"它是干什么的"——`alpha` 给了声明，`beta` 没给（照实说这一格是空的）
    patchConfig: withServerDefs([server('alpha', { desc: '管着一个测试用的文件树' }), server('beta')]),
  });
  t.after(rig.dispose);
  // 两份缓存：alpha 3 件、beta 1 件（判据要的是"工具数**标明来源**"）
  writeToolsCache(rig.dir, 'alpha', ['a1', 'a2', 'a3'], CACHE_AT_MS);
  writeToolsCache(rig.dir, 'beta', ['b1'], CACHE_AT_MS);

  rig.append('wake/manual', { note: '看看有什么' });
  await tick(rig);

  assert.equal(rig.requests.length, 1, '这一拍必须恰好发一次请求');
  const layer = memoryLayerOf(rig.requests[0]!.request);
  assert.ok(
    layer.startsWith(MCP_INDEX_HEADER),
    `索引段进的是长期记忆层（input[0]）；实际开头：${layer.slice(0, 60)}`,
  );

  // ── 逐字样本（有 server 时）：改措辞就必须改这一条，不许悄悄漂 ──
  // v48：行里多了"它是干什么的"那一截。三种写法都在这一条里：
  //   · `alpha` 给了**声明** ⇒ 原样；
  //   · `beta` 没给声明，但缓存里**有它自报的工具描述** ⇒ 兜底 + 标注"（据它自报的工具描述）"；
  //   · 两处都没有那一档由 ①f/①g 钉（这里两个 server 一个有声明、一个有缓存）。
  assert.equal(mcpSegmentOf(rig.requests[0]!.request), [
    MCP_INDEX_HEADER,
    '- alpha —— 管着一个测试用的文件树 —— 启用，已见 3 件工具（来自缓存，取于 2026-02-14T09:00Z，可能过期）',
    '- beta —— b1 的说明（据它自报的工具描述） —— 启用，已见 1 件工具（来自缓存，取于 2026-02-14T09:00Z，可能过期）',
    '（要看某个 server 的工具就调 mcp 工具带上它的名字；工具名不在这段索引里。）',
  ].join('\n'));
});

test('①b 一个工具名都不许出现在索引段里（清单仍然按需，走 mcp 工具）', async (t) => {
  const rig = await makeRealWakeRig({
    // 这个 server **没有** desc ⇒ 走"它自报的工具描述"那一档兜底。
    // 而缓存里那句描述里**不含工具名**（`writeToolsCacheNoNameInDesc`）——于是这一条
    // 验的是"索引里没有工具名"这件正事，而不是被兜底那句话捎进来的名字带偏。
    patchConfig: withServerDefs([server('alpha', { desc: '读本机浏览器历史与当前标签页' })]),
  });
  t.after(rig.dispose);
  writeToolsCacheNoNameInDesc(dataDirOf(rig.dir), 'alpha', ['secret_tool_name'], CACHE_AT_MS);
  rig.append('wake/manual', { note: '看看有什么' });
  await tick(rig);

  const segment = mcpSegmentOf(rig.requests[0]!.request);
  assert.notEqual(segment, '', '这一段必须在（否则下面那条断言什么都没测到）');
  assert.ok(!segment.includes('secret_tool_name'), '索引里出现工具名 = 把清单搬回常驻，披露式入口白做');
  assert.match(segment, /调 mcp 工具/, '指路那一句必须在（她得知道工具去哪儿看）');
});

test('①b2 兜底那一档只取**第一句**（自报的工具描述可能是一整段，索引里只要那一句概述）', async (t) => {
  const rig = await makeRealWakeRig({ patchConfig: withServers(['alpha']) });
  t.after(rig.dispose);
  const dir = join(dataDirOf(rig.dir), MCP_TOOLS_CACHE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'alpha.json'), JSON.stringify({
    version: MCP_TOOLS_CACHE_VERSION,
    server: 'alpha',
    fingerprint: 'test-fingerprint',
    fetchedAtMs: CACHE_AT_MS,
    fetchedAt: new Date(CACHE_AT_MS).toISOString(),
    listSummary: { pages: 1, tools: 1, truncated: false, nextCursor: null },
    tools: [{
      name: 't1',
      description: '读本机浏览器历史与当前标签页。调用时可以指定 --since 参数，默认只看最近一天，'
        + '也可以传 --all 把全部历史都读出来。',
    }],
  }), 'utf8');
  rig.append('wake/manual', { note: '看看有什么' });
  await tick(rig);

  const segment = mcpSegmentOf(rig.requests[0]!.request);
  assert.match(segment, /读本机浏览器历史与当前标签页。（据它自报的工具描述）/u);
  assert.ok(
    !segment.includes('--since'),
    '只取第一句：把一整段工具说明搬进常驻索引，既挤别的行，也把"怎么调用它"塞进一个只回答"有哪些 server"的地方',
  );
});

test('①c 空配置：**整段不出现**（与技能 catalog 的 null 语义一致），且不落快照事件', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  rig.append('wake/manual', { note: '没事' });
  await tick(rig);

  assert.equal(mcpSegmentOf(rig.requests[0]!.request), '', '没有 server ⇒ 整段不出现');
  assert.equal(memoryLayerOf(rig.requests[0]!.request), '', '记忆层里一个字都没有（与 v45 逐字节相同）');
  const types = (await eventsOf(rig)).map((event) => event.type);
  assert.ok(!types.includes('mcp/index'), '空索引不落事件（判据在 mcpIndexSync 的方法头：写了只是噪音）');
});

test('①d 停用的 server：仍在段里，但**一眼可分**（分组 + 行上写明"已停用"）', async (t) => {
  const rig = await makeRealWakeRig({
    patchConfig: (config) => {
      (config.mcp as { servers: unknown[] }).servers = [server('alpha'), server('beta', { disabled: true })];
    },
  });
  t.after(rig.dispose);
  writeToolsCache(rig.dir, 'alpha', ['a1'], CACHE_AT_MS);
  writeToolsCache(rig.dir, 'beta', ['b1', 'b2'], CACHE_AT_MS);
  rig.append('wake/manual', { note: '看看' });
  await tick(rig);

  const segment = mcpSegmentOf(rig.requests[0]!.request);
  assert.match(segment, /- alpha —— a1 的说明（据它自报的工具描述） —— 启用，已见 1 件工具/);
  assert.match(segment, /- beta —— b1 的说明（据它自报的工具描述） —— 已停用，/);
  assert.ok(segment.includes('已停用'), '停用要在段里说得出来（用户点名的那一格）');
  // 停用的那个**不读缓存**：它连进程都不会起，工具数没有意义（行上写"还没拉过"）
  assert.match(segment, /- beta —— b1 的说明（据它自报的工具描述） —— 已停用，工具清单还没拉过/, '停用那一行不许报工具数');
});

// ──────────────────────────────── ①e~①g：那一句"它是干什么的"（v48） ────────────────────────────────

test('①e 带 desc 的 server ⇒ 索引里看得到那句话（用户这一轮点名的那一件）', async (t) => {
  const rig = await makeRealWakeRig({
    patchConfig: withServerDefs([server('obscura', { desc: '读本机浏览器历史与当前标签页' })]),
  });
  t.after(rig.dispose);
  rig.append('wake/manual', { note: '看看有什么' });
  await tick(rig);

  const segment = mcpSegmentOf(rig.requests[0]!.request);
  assert.match(
    segment,
    /- obscura —— 读本机浏览器历史与当前标签页 —— 启用，/u,
    'desc 必须出现在索引的那一行里——"看不出它是干什么的"正是用户报的那件事',
  );
  // 快照里也记着这一句与它的来源（事后要能回答"当时索引里为什么写的是这句话"）
  const snapshot = (await eventsOf(rig)).find((event) => event.type === 'mcp/index');
  assert.ok(snapshot !== undefined, '这一拍该落一条快照');
  const rows = (snapshot.data as { servers: Array<{ name: string; desc?: string; descFrom?: string }> }).servers;
  assert.deepEqual(
    rows.map((row) => ({ name: row.name, desc: row.desc, descFrom: row.descFrom })),
    [{ name: 'obscura', desc: '读本机浏览器历史与当前标签页', descFrom: 'config' }],
  );
});

test('①f 不带 desc ⇒ **照实说这一格是空的**，绝不编一句（也不拿名字凑）', async (t) => {
  const rig = await makeRealWakeRig({ patchConfig: withServers(['alpha']) });
  t.after(rig.dispose);
  rig.append('wake/manual', { note: '看看有什么' });
  await tick(rig);

  const segment = mcpSegmentOf(rig.requests[0]!.request);
  assert.match(segment, /- alpha —— （配置里没写它做什么） —— 启用，/u);
  // 三条"别编"的判据：不许把名字当描述、不许写"0 件"、不许说成"没有描述就是没有用途"
  assert.ok(!/- alpha —— alpha/u.test(segment), '拿名字凑一句同义反复 = 编');
  assert.ok(segment.includes('配置里没写它做什么'), '要**照实**说这一格是空的（那一截不许省掉）');
});

test('①g 老配置（没有 desc 这一格）不许崩：同一份配置照旧渲染出整段索引', async (t) => {
  // 这一条是"老配置"的等价形状：`withServers` 造出来的条目**根本没有 desc 键**，
  // 而且**一个缓存文件都没有** ⇒ 那一截照实写"配置里没写它做什么"（三种写法里最省的一档）
  const rig = await makeRealWakeRig({ patchConfig: withServers(['alpha', 'beta']) });
  t.after(rig.dispose);
  rig.append('wake/manual', { note: '看看有什么' });
  await tick(rig);

  const segment = mcpSegmentOf(rig.requests[0]!.request);
  assert.notEqual(segment, '', '老配置照旧有整段索引（不许因为缺 desc 就整段消失）');
  assert.equal(segment.match(/配置里没写它做什么/gu)?.length, 2, '两条都照实说这一格是空的');
  // 而一旦有缓存，同一台 server 就换成"它自报的那一句 + 标注"（判据在 description.ts 的文件头）
  writeToolsCache(rig.dir, 'alpha', ['a1'], CACHE_AT_MS);
  rig.append('compaction/summary', { coveredUpToSeq: 1, summary: '（测试用的交接笔记）' });
  rig.append('wake/manual', { note: '再来一拍' });
  await tick(rig);
  const later = mcpSegmentOf(rig.requests.at(-1)!.request);
  assert.match(later, /- alpha —— a1 的说明（据它自报的工具描述） —— 启用，/u);
  assert.equal(later.match(/配置里没写它做什么/gu)?.length, 1, 'beta 还是那条"没写"');
});

// ──────────────────────────────── ② 冻结（索引字节不变） ────────────────────────────────

test('② 两次重大变化之间：加一个 server **不改请求前缀**（索引段逐字节不变，走的是尾部追加）', async (t) => {
  const rig = await makeRealWakeRig({ patchConfig: withServers(['alpha']) });
  t.after(rig.dispose);
  writeToolsCache(rig.dir, 'alpha', ['a1'], CACHE_AT_MS);

  rig.append('wake/manual', { note: '第一拍' });
  await tick(rig);
  const before = rig.requests[0]!.request;
  const segmentBefore = mcpSegmentOf(before);

  // ── "加一个 server"：配置对象变了（生产的真实路径是改 config.json + 重启；这里直接改那份
  //    对象，因为**运行期配置本来就不会变**——所有字段都要重启才生效，见 config/watcher.ts）──
  (rig.loop as unknown as { deps: { config: AppConfig } }).deps.config.mcp.servers = [
    server('alpha'), server('beta'),
  ] as never;
  writeToolsCache(rig.dir, 'beta', ['b1', 'b2'], CACHE_AT_MS);
  // 而"声明面被改"这件事在上下文里的样子**照旧是尾部追加**：一条真唤醒（via='mcp'）
  rig.append('wake/manual', { note: 'MCP 声明面变了：新增 server beta', via: 'mcp' });
  await tick(rig);

  assert.equal(rig.requests.length, 2, '第二拍也要发请求（否则下面那条断言没有对象）');
  const after = rig.requests[1]!.request;
  const segmentAfter = mcpSegmentOf(after);

  assert.notEqual(segmentBefore, '', '第一拍就该有索引段（否则"没变"是假结论）');
  assert.equal(segmentAfter, segmentBefore, '两次重大变化之间，索引段必须逐字节不变');
  assert.ok(!segmentAfter.includes('beta'), '新加的 server 不许立刻进索引（那正是"每轮现渲染"的毛病');

  // 前置条件：那一拍的**前缀**（长期记忆层那一条 item）逐字节相同 —— 索引段就在它里面
  assert.equal(
    JSON.stringify((after.input as unknown[])[0]),
    JSON.stringify((before.input as unknown[])[0]),
    '长期记忆层那一条 item 必须逐字节相同（KV 缓存前缀靠的就是它）',
  );
  const types = (await eventsOf(rig)).map((event) => event.type);
  assert.equal(types.filter((type) => type === 'mcp/index').length, 1, '这一整段里只该有一条索引快照');
  // 而"声明变了"这件事**在末尾**（固定位置：追加在末）——本轮的唤醒行就是那一格
  const head = stableHeadOf(after.input);
  assert.ok(
    head.includes('新增 server beta'),
    '声明变更的正文照旧在**当轮输入**里（尾部追加，不动索引那一格）',
  );
});

// ──────────────────────────────── ③ 归集（重大变化点重建） ────────────────────────────────

test('③ 压缩之后：索引反映现状（新加的 server 出现在索引里），且是**追加一条新快照**', async (t) => {
  const rig = await makeRealWakeRig({ patchConfig: withServers(['alpha']) });
  t.after(rig.dispose);
  writeToolsCache(rig.dir, 'alpha', ['a1'], CACHE_AT_MS);

  rig.append('wake/manual', { note: '第一拍' });
  await tick(rig);
  const firstSegment = mcpSegmentOf(rig.requests[0]!.request);

  // 加一个 server，并**模拟一次上下文重大变化**——自动压缩与界面 reset 写的都是这一条事件
  //（遮蔽点由它唯一确定），所以它就是"重大变化点"在本仓库里的唯一凭据。
  (rig.loop as unknown as { deps: { config: AppConfig } }).deps.config.mcp.servers = [
    server('alpha'), server('beta'),
  ] as never;
  writeToolsCache(rig.dir, 'beta', ['b1', 'b2'], CACHE_AT_MS);
  rig.append('compaction/summary', { coveredUpToSeq: 1, summary: '（测试用的交接笔记）' });

  rig.append('wake/manual', { note: '压过之后' });
  await tick(rig);

  const segment = mcpSegmentOf(rig.requests.at(-1)!.request);
  assert.notEqual(segment, firstSegment, '重大变化点之后索引必须换一版');
  assert.match(
    segment,
    /- beta —— b1 的说明（据它自报的工具描述） —— 启用，已见 2 件工具（来自缓存/,
    '新加的 server 出现在索引里 = 归集完成了（此前只有尾部那条追加知道有它）',
  );
  const counts = (await eventsOf(rig)).filter((event) => event.type === 'mcp/index').length;
  assert.equal(counts, 2, '归集是**追加一条新快照**，不是改写旧的那条（历史只增不改）');
});

test('③b 归集只发生在重大变化点：连跑三拍（没有压缩）只写一条快照、索引段是同一串字节', async (t) => {
  const rig = await makeRealWakeRig({ patchConfig: withServers(['alpha']) });
  t.after(rig.dispose);
  writeToolsCache(rig.dir, 'alpha', ['a1'], CACHE_AT_MS);
  for (const note of ['一', '二', '三']) {
    rig.append('wake/manual', { note });
    await tick(rig);
  }
  assert.equal(rig.requests.length, 3);
  const segments = rig.requests.map((item) => mcpSegmentOf(item.request));
  assert.equal(new Set(segments).size, 1, '三拍的索引段必须是同一串字节');
  const counts = (await eventsOf(rig)).filter((event) => event.type === 'mcp/index').length;
  assert.equal(counts, 1, '没有重大变化就不重建');
});

// ──────────────────────────────── ④ 重放不失真 ────────────────────────────────

test('④ 带索引段的新轮次：重建出**同一串字节**（那一段取自事件，不是拿现在的配置现算）', async (t) => {
  const rig = await makeRealWakeRig({ patchConfig: withServers(['alpha']) });
  t.after(rig.dispose);
  writeToolsCache(rig.dir, 'alpha', ['a1'], CACHE_AT_MS);
  rig.append('wake/manual', { note: '一拍' });
  await tick(rig);

  const live = stableHeadOf(rig.requests[0]!.request.input);
  assert.ok(live.includes('[MCP server]'), '这一份里确实有索引段（否则下面那条是空转）');
  assert.equal(rebuildTurnOne(await eventsOf(rig)), live, '重建必须逐字节等于当时那一份');
});

test('④b 旧轮次（日志里没有 mcp/index）：**不许被补写**那一段 —— 重建结果里一个字都没有', async (t) => {
  const rig = await makeRealWakeRig({ patchConfig: withServers(['alpha']) });
  t.after(rig.dispose);
  writeToolsCache(rig.dir, 'alpha', ['a1'], CACHE_AT_MS);
  rig.append('wake/manual', { note: '一拍' });
  await tick(rig);

  // 把快照从**重建用的事件流**里摘掉 = "这一轮是升级前的老日志"。
  // （不删盘上那条事件——历史只增不改；这条用例测的正是"读的一侧遇到没有它的日志会怎样"。）
  const all = await eventsOf(rig);
  const without = all.filter((event) => event.type !== 'mcp/index');
  assert.equal(without.length, all.length - 1, '确实摘掉了一条');

  const text = rebuildTurnOne(without);
  assert.ok(!text.includes('[MCP server]'), '老轮次不许被补写索引段');
  assert.ok(!text.includes('alpha'), '也不许拿现在的配置去补（那会改写历史）');
});

// ──────────────────────────────── ⑤ 纯函数那一层 ────────────────────────────────

test('⑤ 没有任何 server ⇒ 文本是空串（渲染层据此整段不出现）', () => {
  const view = mcpIndexView([], 'nowhere');
  assert.equal(view.text, '');
  assert.deepEqual(view.servers, []);
});

test('⑤b 缓存读不出来（没有 / 坏 JSON / 版本不对）⇒ 如实说"还没拉过"，不写"0 件"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-mcp-index-'));
  try {
    const broken = join(dir, MCP_TOOLS_CACHE_DIR);
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'broken.json'), '{ 这不是 JSON', 'utf8');
    writeFileSync(join(broken, 'oldver.json'), JSON.stringify({
      version: MCP_TOOLS_CACHE_VERSION + 1, server: 'oldver', tools: [{ name: 'x' }],
    }), 'utf8');

    const view = mcpIndexView([
      { name: 'broken', command: 'x' },
      { name: 'oldver', command: 'x' },
      { name: 'absent', command: 'x' },
    ], dir);
    assert.ok(!view.text.includes('0 件'), '"还没拉过"与"它一件都没有"是两件事，不许混');
    assert.equal(view.text.match(/工具清单还没拉过/gu)?.length, 3);
    assert.deepEqual(view.servers.map((row) => row.toolsFrom), ['none', 'none', 'none']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑤c 同一份输入渲染出同一串字节（纯函数、不读时钟）：重建与运行期因此可比', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-mcp-index-'));
  try {
    writeToolsCacheInto(dir, 'alpha', ['a1', 'a2'], CACHE_AT_MS);
    const servers = [{ name: 'alpha', command: 'x' }];
    const first = mcpIndexView(servers, dir);
    const second = mcpIndexView(servers, dir);
    assert.equal(first.text, second.text);
    assert.deepEqual(first.servers, second.servers);
    // 快照里记的是**那一刻的数**（工具数 2、来源缓存、取回时刻来自文件而不是时钟）
    // v48 起多两格：那一句"它是干什么的"与它的来源。这一份缓存里**有**它自报的描述
    // （`writeToolsCacheInto` 写的是 `<名字> 的说明`）⇒ 那一档是"推断"（`descFrom: 'cache'`），
    // 而声明那一路（`descFrom: 'config'`）由 ①e 钉。
    assert.deepEqual(first.servers, [
      {
        name: 'alpha', disabled: false, tools: 2, toolsFrom: 'cache', cachedAtMs: CACHE_AT_MS,
        desc: 'a1 的说明', descFrom: 'cache',
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑤d 快照的版本号跟着 RENDER_VERSION（模板换代 ⇒ 旧快照当场重建，这一条钉住那处耦合）', async (t) => {
  const rig = await makeRealWakeRig({ patchConfig: withServers(['alpha']) });
  t.after(rig.dispose);
  rig.append('wake/manual', { note: '一拍' });
  await tick(rig);
  const snapshot = (await eventsOf(rig)).find((event) => event.type === 'mcp/index');
  assert.ok(snapshot !== undefined, '这一拍该落一条快照');
  assert.equal(snapshot.data.version, RENDER_VERSION);
  // v48：**行模板**版本与 RENDER_VERSION 分开记（理由见 `MCP_INDEX_DESC_CLAUSE_VERSION`）：
  // 只认后者的话，这一版自己的生命周期里"快照 version ≠ 当前 RENDER_VERSION"会一直成立
  // ⇒ 每拍重建一次索引。所以这一格必须一起落、且必须等于当前值。
  assert.equal(snapshot.data.descClauseVersion, MCP_INDEX_DESC_CLAUSE_VERSION);
  assert.equal(snapshot.visibility, 'internal', '快照本身是 internal：进上下文的是渲染出来的那一段');
});

test('⑤e 没有 descClauseVersion 的**老快照**：当作第 0 版 ⇒ 该重建（行模板换了代）', async (t) => {
  const rig = await makeRealWakeRig({ patchConfig: withServers(['alpha']) });
  t.after(rig.dispose);
  rig.append('wake/manual', { note: '一拍' });
  await tick(rig);
  const first = (await eventsOf(rig)).find((event) => event.type === 'mcp/index');
  assert.ok(first !== undefined, '这一拍该落一条快照');

  /**
   * 把**盘上**那条快照改回老形状（没有 `descClauseVersion`）——这是"升级上来的日志"的样子。
   *
   * 为什么必须落到文件上、而不是改内存里那条事件对象：`EventLog.get(seq)` 在内存视图里
   * 查得到就先用它（实测确认过：改内存那份之后，下一拍的同步仍然读到带这一格的版本）。
   * 真升级路径上那个字段**本来就不在盘上**，所以只有改写分片才是等价的模拟。
   */
  const shardDir = join(dataDirOf(rig.dir), 'events');
  const shard = readdirSync(shardDir).filter((name) => name.endsWith('.jsonl')).sort().at(-1);
  assert.ok(shard !== undefined, '日志分片该在（否则这条断言什么都没测到）');
  const shardPath = join(shardDir, shard!);
  const lines = readFileSync(shardPath, 'utf8').split('\n');
  let patched = 0;
  const next = lines.map((line) => {
    if (!line.includes('"mcp/index"')) return line;
    const parsed = JSON.parse(line) as { data: Record<string, unknown> };
    delete parsed.data['descClauseVersion'];
    patched += 1;
    return JSON.stringify(parsed);
  });
  assert.equal(patched, 1, '该改到恰好一条索引快照');
  writeFileSync(shardPath, next.join('\n'), 'utf8');

  rig.append('wake/manual', { note: '再来一拍' });
  await tick(rig);
  const count = (await eventsOf(rig)).filter((event) => event.type === 'mcp/index').length;
  assert.equal(count, 2, '缺那一格的老快照 ⇒ 重建一次');

  rig.append('wake/manual', { note: '第三拍' });
  await tick(rig);
  const count3 = (await eventsOf(rig)).filter((event) => event.type === 'mcp/index').length;
  assert.equal(count3, 2, '重建过一次之后就照旧冻结（这一条挡住"每拍都重建"那个毛病）');
});
