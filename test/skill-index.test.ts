/**
 * **技能常驻索引的缓存保护**（2026-10-11）—— 用户这一轮的第 ③ 条判据的执行版。
 *
 * ──────────────────────────── 判据（用户原话） ────────────────────────────
 *
 * 「**skill 索引的进入和退出也要有类似 mcp 的进入和退出那样的缓存保护的机制**」
 * 「skill 索引**必须放在稳定位置** …… **一轮之内只允许变一次**」
 * 「增删 skill 时**不许**把 `instructions`/`tools` 前缀搞脏（那会全量缓存失忆）」
 * 「安装成功 → 索引**稳定地**多一行；删除 → 索引稳定地少一行；两次变更之间**不许抖动**」
 * 「同一轮内增删两次 ⇒ 索引只反映最终态且前缀序列不乱；重建（replay）与当时一致」
 *
 * 落成五条（这一整个文件就是它们）：
 *   ① **位置**：技能索引进长期记忆层（第一条 developer item）的**最前面**，MCP 索引紧随其后；
 *      只有过了信任门（`skill/installed`）的技能才在那一段里（批准前不生效）；
 *   ② **冻结**：两次重大变化之间，装一个技能 / 删一个技能**不改请求前缀**——索引段逐字节不变，
 *      `instructions` 与 `tools` 一个字节都不动（那两段才是"最大公共前缀"）；
 *   ③ **归集**：`compaction/summary` 之后用**当前**技能目录重建 ⇒ 新技能进索引、删掉的消失，
 *      而且是**追加一条新快照**（不是回改历史）；"多一行 / 少一行"是稳定的那一行；
 *   ④ **同一周期内变两次**：只落**一条**新快照，它反映**最终态**；两次归集之间的每一份请求
 *      前缀都逐字节相同（前缀序列不乱）；
 *   ⑤ **重建一致**：`skillCatalogForReplay` 读快照 ⇒ 重建出当时的同一串字节；
 *      **老日志没有 `skill/index`** ⇒ 退回当时的来源（`skillCatalogForRebuild`），不许补一段假的。
 *
 * ──────────────────────────── 为什么用真台子 ────────────────────────────
 *
 * ①②③④ 断言的是"整条链路上发生了什么"（tick → 索引同步 → 落事件 → 渲染 → 请求体），
 * 任何一层用替身搭出来测的就不是那条链路。所以用 `test/fixtures/real-wake-rig.ts`
 * （真 EventLog、真 fold、真 agent-loop、真 render、真 RealLoop 的 tick，**只有模型是假的**），
 * 与 `mcp-index.test.ts` 同一个台子——技能与 MCP 两条索引本来就必须是同一套。
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import type { AppConfig } from '../src/config/config.ts';
import type { AppEvent } from '../src/log/types.ts';
import { RENDER_VERSION, TURN_BLOCK_BANNER, NOW_LAYER_BANNER, LAYER_RULES, skillIndexOf } from '../src/model/render.ts';
import { MCP_INDEX_HEADER } from '../src/persona/assets.ts';
import { locateStep, rebuildRenderedRequest, skillCatalogForRebuild, skillCatalogForReplay } from '../src/runtime/replay.ts';
import { CATALOG_HEADER, SkillManager } from '../src/skill/skills.ts';
import { sha256Hex } from '../src/tools/fs/text-codec.ts';
import { makeRealWakeRig } from './fixtures/real-wake-rig.ts';
import type { RealWakeRig } from './fixtures/real-wake-rig.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 台子上的小工具 ────────────────────────────────

/** 一份技能的 SKILL.md（frontmatter 两字段就够；name 必须与目录同名） */
function skillText(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n正文不进请求（渐进披露第二层）。\n`;
}

/** 往技能根里写一份技能（`<dir>/skills/<name>/SKILL.md`），返回 SKILL.md 的原文 */
function writeSkill(root: string, name: string, description: string): string {
  const dir = join(root, 'skills', name);
  mkdirSync(dir, { recursive: true });
  const text = skillText(name, description);
  writeFileSync(join(dir, 'SKILL.md'), text, 'utf8');
  return text;
}

/** 写一条 `skill/installed`（**信任门的唯一凭据**；`by:'human'` 才是人批的） */
function trust(rig: RealWakeRig, name: string, text: string, by: 'human' | 'agent' = 'human'): void {
  rig.append('skill/installed', {
    name, path: `skills/${name}`, by, contentHash: sha256Hex(text),
  });
}

/** 真台子 + 真技能管理器（技能根挂在台子的临时目录上） */
async function rigWithSkills(
  options: { servers?: readonly unknown[]; stream?: Array<{ text: string }> } = {},
): Promise<RealWakeRig> {
  const rig = await makeRealWakeRig({
    skills: (baseRoot) => new SkillManager({ baseRoot, out: () => undefined }),
    ...(options.servers === undefined ? {} : {
      patchConfig: (config: AppConfig) => {
        (config.mcp as { servers: unknown[] }).servers = [...options.servers!];
      },
    }),
    stream: options.stream ?? [{ text: '好。' }, { text: '好。' }, { text: '好。' }, { text: '好。' }],
  });
  return rig;
}

/** 请求体里那段**长期记忆层**（第一条 developer item）的文字；没有那一段时给空串 */
function memoryLayerOf(request: { input?: unknown }): string {
  const items = Array.isArray(request.input) ? request.input : [];
  const first = items[0] as { role?: string; content?: unknown } | undefined;
  if (first === undefined || first.role !== 'developer') return '';
  return typeof first.content === 'string' ? first.content : '';
}

/** 请求体里那段**技能索引**（长期记忆层里以 `CATALOG_HEADER` 开头的那一段）；没有时给空串 */
function skillSegmentOf(request: { input?: unknown }): string {
  const layer = memoryLayerOf(request);
  const at = layer.indexOf(CATALOG_HEADER);
  if (at < 0) return '';
  // 段与段之间是空行（`renderMemoryLayer` 的 join('\n\n')）⇒ 取到下一个空行为止
  const rest = layer.slice(at);
  const end = rest.indexOf('\n\n');
  return end < 0 ? rest : rest.slice(0, end);
}

/** 请求体里**本轮之外**的那几段（长期记忆层 + 本轮新输入）：索引段与唤醒行都在其中 */
function stableHeadOf(input: unknown): string {
  const items = Array.isArray(input) ? input : [];
  return JSON.stringify(items.filter((item) => {
    const text = typeof (item as { content?: unknown }).content === 'string'
      ? (item as { content: string }).content
      : '';
    return !text.includes(TURN_BLOCK_BANNER) && !text.includes(NOW_LAYER_BANNER);
  }));
}

/** 台子日志里的全部事件 */
async function eventsOf(rig: RealWakeRig): Promise<AppEvent[]> {
  return [...(await rig.events())];
}

/** 一个合法形状的 server 条目（**永远不会被起**：本文件只渲染索引） */
function server(name: string, desc: string): unknown {
  return { name, command: 'definitely-not-a-real-command', args: [], desc };
}

// ──────────────────────────────── ① 位置与信任门 ────────────────────────────────

test('① 有技能时：索引段进长期记忆层的**最前面**，MCP 索引紧随其后，逐字样本', async (t) => {
  const rig = await rigWithSkills({ servers: [server('alpha', '管着一个测试用的文件树')] });
  t.after(rig.dispose);
  const alpha = writeSkill(rig.dir, 'alpha-search', '搜网页与站内内容并按相关性排序；查资料、验证事实时用。');
  trust(rig, 'alpha-search', alpha);

  rig.append('wake/manual', { note: '看看有什么' });
  await rig.tick();

  assert.equal(rig.requests.length, 1, '这一拍必须恰好发一次请求');
  const request = rig.requests[0]!.request;
  const layer = memoryLayerOf(request);
  assert.ok(
    layer.startsWith(`${LAYER_RULES.memory}\n\n${CATALOG_HEADER}`),
    `技能索引进的是长期记忆层的第一段（v56 起这层以那条分割线开头）；实际开头：${layer.slice(0, 80)}`,
  );
  // 逐字样本：改措辞就必须改这一条（与 `SkillManager.catalog()` 的输出逐字节相同）
  assert.equal(skillSegmentOf(request), [
    CATALOG_HEADER,
    '- alpha-search: 搜网页与站内内容并按相关性排序；查资料、验证事实时用。',
  ].join('\n'));
  // 位置稳定：技能在前、MCP 紧跟其后（用户 2026-10-06 的口径：skill / mcp 是同一类数字资产）
  assert.ok(
    layer.indexOf(CATALOG_HEADER) < layer.indexOf(MCP_INDEX_HEADER),
    '两段都在，且技能那段排在 MCP 那段之前',
  );

  // 快照事件：文本就是请求里那一串字节，事实只记名字/描述/token（审计用）
  const snapshot = (await eventsOf(rig)).find((event) => event.type === 'skill/index');
  assert.ok(snapshot !== undefined, '这一拍该落一条技能索引快照');
  const data = snapshot.data as { version: string; text: string; skills: Array<{ name: string; description: string }> };
  assert.equal(data.version, RENDER_VERSION, '快照的度量衡就是当前的 RENDER_VERSION');
  assert.equal(data.text, skillSegmentOf(request), '快照里那一串字节必须与请求里的逐字节相同');
  assert.deepEqual(
    data.skills.map((row) => ({ name: row.name, description: row.description })),
    [{ name: 'alpha-search', description: '搜网页与站内内容并按相关性排序；查资料、验证事实时用。' }],
  );
});

test('①b 信任门：没写过 skill/installed 的技能**不在索引里**（批准前不生效）', async (t) => {
  const rig = await rigWithSkills();
  t.after(rig.dispose);
  const alpha = writeSkill(rig.dir, 'alpha-search', '真在目录里的那个技能，已经被人批过。');
  trust(rig, 'alpha-search', alpha);
  // 只写了目录、没有信任凭据：它与"她申请了但人还没批"在索引这一层是同一件事
  writeSkill(rig.dir, 'beta-pending', '只在待确认清单里：没写过 skill/installed 就不该进 catalog。');

  rig.append('wake/manual', { note: '看看有什么' });
  await rig.tick();

  const segment = skillSegmentOf(rig.requests[0]!.request);
  assert.match(segment, /- alpha-search: /u, '过了信任门的那个要在');
  assert.equal(segment.includes('beta-pending'), false, '没过信任门的不许在');
});

test('①c 一个技能都没有：整段不出现，且**不落快照事件**（空索引与"没有"逐字节等价）', async (t) => {
  const rig = await rigWithSkills();
  t.after(rig.dispose);
  rig.append('wake/manual', { note: '没事' });
  await rig.tick();

  assert.equal(skillSegmentOf(rig.requests[0]!.request), '', '没有技能 ⇒ 整段不出现');
  const types = (await eventsOf(rig)).map((event) => event.type);
  assert.ok(!types.includes('skill/index'), '空索引不落事件（判据在 skillIndexSync 的方法头 ③）');
});

// ──────────────────────────────── ② 冻结（进入/退出都不动前缀） ────────────────────────────────

test('② 装一个技能：请求前缀逐字节不变（索引段不动，变化走尾部追加）', async (t) => {
  const rig = await rigWithSkills();
  t.after(rig.dispose);
  const alpha = writeSkill(rig.dir, 'alpha-search', '先有的那个技能：搜网页与站内内容，查资料时用。');
  trust(rig, 'alpha-search', alpha);

  rig.append('wake/manual', { note: '第一拍' });
  await rig.tick();
  const before = rig.requests[0]!.request;
  const segmentBefore = skillSegmentOf(before);
  assert.notEqual(segmentBefore, '', '第一拍就该有索引段（否则"没变"是假结论）');

  // ── "人批准装了一个技能"在生产里的形状（2026-10-11 起）：web 层写目录 + 写
  //    `skill/installed{by:'human'}` + 落一条 `wake/manual{via:'grant'}` 叫她 ──
  const beta = writeSkill(rig.dir, 'beta-new', '新批准装上的那个技能：装完还没到归集点。');
  trust(rig, 'beta-new', beta);
  rig.append('wake/manual', { note: '人批准了装技能 beta-new（via grant）', via: 'grant' });
  await rig.tick();

  assert.equal(rig.requests.length, 2, '第二拍也要发请求（否则下面那条断言没有对象）');
  const after = rig.requests[1]!.request;
  assert.equal(skillSegmentOf(after), segmentBefore, '两次归集之间，索引段必须逐字节不变');
  assert.ok(!skillSegmentOf(after).includes('beta-new'), '新装的技能不许立刻进索引（那正是"每轮现渲染"的毛病');
  // 前缀本身：长期记忆层那一条 item 逐字节相同（KV 缓存前缀靠的就是它）
  assert.equal(
    JSON.stringify((after.input as unknown[])[0]),
    JSON.stringify((before.input as unknown[])[0]),
    '长期记忆层那一条 item 必须逐字节相同',
  );
  // 两条最大的稳定前缀：`instructions` 与 `tools` —— 技能增删一个字节都不许动
  assert.equal(after.instructions, before.instructions, 'instructions 段一个字节都不许变');
  assert.equal(JSON.stringify(after.tools), JSON.stringify(before.tools), 'tools 段一个字节都不许变');
  // 这一整段里只该有一条快照（第二拍没有重建）
  assert.equal(
    (await eventsOf(rig)).filter((event) => event.type === 'skill/index').length,
    1,
    '两拍之间只该有一条技能索引快照',
  );
  // 而"装上了"这件事**在末尾**（尾部追加）：本轮的唤醒行就是那一格
  const head = stableHeadOf(after.input);
  assert.ok(head.includes('via grant') || head.includes('人批准了装技能 beta-new'), '批准那件事照旧在当轮输入里');
});

test('②b 删一个技能：请求前缀同样逐字节不变（退出与进入走同一套保护）', async (t) => {
  const rig = await rigWithSkills();
  t.after(rig.dispose);
  const alpha = writeSkill(rig.dir, 'alpha-search', '会被删掉的那个技能：搜网页与站内内容。');
  const beta = writeSkill(rig.dir, 'beta-keep', '先留着的那一个技能：做另一件事。');
  trust(rig, 'alpha-search', alpha);
  trust(rig, 'beta-keep', beta);

  rig.append('wake/manual', { note: '第一拍' });
  await rig.tick();
  const before = rig.requests[0]!.request;
  assert.match(skillSegmentOf(before), /- alpha-search: /u);

  // "人批准删掉一个技能"：目录进回收站（生产走 rename；这里删掉即可）+ 一条唤醒
  rmSync(join(rig.dir, 'skills', 'alpha-search'), { recursive: true, force: true });
  rig.append('wake/manual', { note: '人批准删掉技能 alpha-search（via grant）', via: 'grant' });
  await rig.tick();

  const after = rig.requests[1]!.request;
  assert.equal(skillSegmentOf(after), skillSegmentOf(before), '索引段必须逐字节不变（删也不许立刻改前缀）');
  assert.match(skillSegmentOf(after), /- alpha-search: /u, '归集之前它还在索引里——那是旧快照，不是它还在');
  assert.equal(JSON.stringify((after.input as unknown[])[0]), JSON.stringify((before.input as unknown[])[0]));
});

// ──────────────────────────────── ③ 归集（重大变化点重建） ────────────────────────────────

test('③ 压缩之后：索引反映现状（新技能进、删掉的出），且是**追加一条新快照**', async (t) => {
  const rig = await rigWithSkills();
  t.after(rig.dispose);
  const alpha = writeSkill(rig.dir, 'alpha-search', '先有的那个技能：搜网页与站内内容，查资料时用。');
  trust(rig, 'alpha-search', alpha);

  rig.append('wake/manual', { note: '第一拍' });
  await rig.tick();
  const before = skillSegmentOf(rig.requests[0]!.request);

  // 一次归集周期里发生两件事：装一个、删一个（生产里是两次批准）
  const beta = writeSkill(rig.dir, 'beta-new', '新批准装上的那个技能：装完还没到归集点。');
  trust(rig, 'beta-new', beta);
  rmSync(join(rig.dir, 'skills', 'alpha-search'), { recursive: true, force: true });

  // 重大变化点：compact（总结）之后那一拍 ⇒ 归集
  rig.append('compaction/summary', { coveredUpToSeq: 1, summary: '（测试用的交接笔记）' });
  rig.append('wake/manual', { note: '再来一拍' });
  await rig.tick();

  const after = skillSegmentOf(rig.requests.at(-1)!.request);
  assert.match(after, /- beta-new: /u, '归集之后新技能要进索引');
  assert.equal(after.includes('alpha-search'), false, '归集之后删掉的技能要从索引里消失');
  // "稳定地多一行 / 少一行"：行数正好是「表头 + 一个技能」
  assert.equal(after.split('\n').length, before.split('\n').length, '进一个、出一个 ⇒ 行数不变（各一行）');
  // 追加一条新快照（不许回改历史）
  const snapshots = (await eventsOf(rig)).filter((event) => event.type === 'skill/index');
  assert.equal(snapshots.length, 2, '归集那一刻追加了一条新快照（启动那条在历史里逐字节不动）');
  assert.equal((snapshots[1]!.data as { text: string }).text, after, '新快照的文本就是这一拍请求里那一串');
  // 归集之后又冻结了：下一拍不再重建
  rig.append('wake/manual', { note: '再拍一次' });
  await rig.tick();
  assert.equal(
    (await eventsOf(rig)).filter((event) => event.type === 'skill/index').length,
    2,
    '归集之后照旧冻结（不是每拍重建）',
  );
  assert.equal(skillSegmentOf(rig.requests.at(-1)!.request), after, '两次归集之间索引段逐字节不变');
});

test('③b 同一周期内增删两次：只落**一条**新快照，且它只反映最终态（前缀序列不乱）', async (t) => {
  const rig = await rigWithSkills({ stream: Array.from({ length: 6 }, () => ({ text: '好。' })) });
  t.after(rig.dispose);
  const alpha = writeSkill(rig.dir, 'alpha-keep', '一直在的那个技能：做 A 这件事。');
  const beta = writeSkill(rig.dir, 'beta-gone', '会被删掉的那个技能：做 B 这件事。');
  trust(rig, 'alpha-keep', alpha);
  trust(rig, 'beta-gone', beta);

  rig.append('wake/manual', { note: '第一拍' });
  await rig.tick();
  const firstHead = memoryLayerOf(rig.requests[0]!.request);

  // 同一个周期里两次变更（都不触发归集）
  const gamma = writeSkill(rig.dir, 'gamma-new', '新装的那个技能：做 C 这件事。');
  trust(rig, 'gamma-new', gamma);
  rmSync(join(rig.dir, 'skills', 'beta-gone'), { recursive: true, force: true });
  rig.append('wake/manual', { note: '第二拍（两次变更都发生了）' });
  await rig.tick();

  // 两次归集之间：每一份请求的长期记忆层逐字节相同（前缀序列不乱）
  assert.equal(rig.requests.length, 2);
  for (const item of rig.requests) {
    assert.equal(memoryLayerOf(item.request), firstHead, '归集之前每一拍的前缀都必须与第一拍相同');
  }

  // 归集那一刻：**一条**新快照，内容是最终态（alpha + gamma，没有 beta）
  rig.append('compaction/summary', { coveredUpToSeq: 1, summary: '（测试用的交接笔记）' });
  rig.append('wake/manual', { note: '归集之后那一拍' });
  await rig.tick();

  const snapshots = (await eventsOf(rig)).filter((event) => event.type === 'skill/index');
  assert.equal(snapshots.length, 2, '两次变更只落一条新快照（中间态一次都没有进过日志）');
  const text = (snapshots[1]!.data as { text: string }).text;
  assert.match(text, /- alpha-keep: /u);
  assert.match(text, /- gamma-new: /u);
  assert.equal(text.includes('beta-gone'), false, '删掉的那个不在最终态里');
  // 快照文本 = 那一刻真跑一遍技能系统得到的 catalog（不是这里手拼的期望值）
  const live = new SkillManager({ baseRoot: rig.dir, out: () => undefined });
  live.setTrustEvents(await eventsOf(rig));
  assert.equal(text, live.catalogText(), '归集出来的字节必须与技能系统此刻算出来的逐字节相同');
  assert.equal(skillSegmentOf(rig.requests.at(-1)!.request), text);
});

// ──────────────────────────────── ④ 重建（replay）与当时一致 ────────────────────────────────

/** 用 CLI 那条重建路把某一步重建出来（索引那一段走 `skillCatalogForReplay`） */
function replayHeadOf(rig: RealWakeRig, events: readonly AppEvent[], turn: number, step: number): string {
  const position = locateStep(events, turn, step);
  if (!position.ok) throw new Error(`定位不到 turn ${turn} step ${step}：${position.reason}`);
  const request = rebuildRenderedRequest(position, {
    persona: {
      identity: 'I', constitution: 'C', style: 'S',
      state: 'STATE', personaHash: 'h', relationship: null,
    },
    tools: [],
    timezone: 'Asia/Shanghai',
    now: position.stepStart.ts,
    skillCatalog: skillCatalogForReplay(rig.dir, events, position.stepStart.seq),
  });
  return stableHeadOf(request.input);
}

test('④ 重建：读 `skill/index` 快照 ⇒ 与当时那份请求逐字节相同（含索引那一段）', async (t) => {
  const rig = await rigWithSkills();
  t.after(rig.dispose);
  const alpha = writeSkill(rig.dir, 'alpha-search', '真在目录里的那个技能：搜网页与站内内容，查资料时用。');
  trust(rig, 'alpha-search', alpha);

  rig.append('wake/manual', { note: '看看有什么' });
  await rig.tick();
  const live = rig.requests[0]!.request;
  const events = await eventsOf(rig);
  assert.equal(
    skillSegmentOf(live).includes('alpha-search'), true,
    '运行期那一份真的把技能索引发进去了（不然后面比的是两段空）',
  );

  assert.equal(replayHeadOf(rig, events, 1, 1), stableHeadOf(live.input), '重建必须与当时逐字节一致');

  // **把技能目录删掉**之后重建：当时那一串字节在日志里 ⇒ 重建不受影响（这正是"字节只在快照上"）
  rmSync(join(rig.dir, 'skills'), { recursive: true, force: true });
  assert.equal(
    replayHeadOf(rig, events, 1, 1),
    stableHeadOf(live.input),
    '技能目录被删掉之后重建仍旧一致——索引字节只来自快照',
  );
});

test('④b 老日志（没有 skill/index 快照）⇒ 退回当时的来源，不许当成"没有技能"', async (t) => {
  const dir = tempDirSync('irmia-skill-index-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const alpha = writeSkill(dir, 'alpha-search', '老日志里的那个技能：当时是每轮现扫目录的。');
  // 老日志只有信任门凭据（没有 skill/index）：seq=1 一条 skill/installed
  const events = [{
    seq: 1, ts: '2026-10-10T00:00:00.000Z', type: 'skill/installed',
    data: { name: 'alpha-search', path: 'skills/alpha-search', by: 'human', contentHash: sha256Hex(alpha) },
    visibility: 'internal', origin: 'test',
  }] as unknown as AppEvent[];

  const viaReplay = skillCatalogForReplay(dir, events, 2);
  const viaRebuild = skillCatalogForRebuild(dir, events, 2);
  assert.equal(viaReplay, viaRebuild, '老轮次必须走回当时的来源（同一个 SkillManager + 信任事件）');
  assert.match(viaReplay, /- alpha-search: /u, '不许把"没有快照"读成"当时没有技能"');
  // 老日志的渲染结果与"改动前"逐字节相同：它由同一份 `skillCatalogForRebuild` 算出来
  assert.equal(skillIndexOf(events).seq, 0, '老日志里确实没有快照（前置条件）');

  // 有快照之后：**读快照**，哪怕技能目录此刻已经变了（快照才是当时那份字节）
  const withSnapshot = [...events, {
    seq: 2, ts: '2026-10-10T00:00:01.000Z', type: 'skill/index',
    data: { version: RENDER_VERSION, text: '[可用技能]（快照里那一版）', skills: [] },
    visibility: 'internal', origin: 'test',
  }] as unknown as AppEvent[];
  assert.equal(skillCatalogForReplay(dir, withSnapshot, 3), '[可用技能]（快照里那一版）');
  // 而"这一步之前"那一刀照旧生效：快照写在 seq=2，问 seq=2 时还看不到它
  assert.equal(skillCatalogForReplay(dir, withSnapshot, 2), viaRebuild, '本步之前的那些事件里不含这份快照');
});
