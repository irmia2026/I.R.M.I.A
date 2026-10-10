/**
 * 申请单（她发起 → 待批 → 用户只在界面点批准/驳回 → 框架执行 → 回执）
 *
 * 用户 2026-10-11 的原话（这一整个文件就是它）：
 * 「**我希望 skill 和 mcp 都尽量是 agent 自行增删。人类用户只做审批**」
 * 「她刚加入的 obscura，**索引内容质量低**。我觉得这东西得**要求 LLM 弄懂了加的是什么、
 *  用于什么，再自主填写**才对。（或者人添加时直接填写 desc）」
 *
 * ──────────────────────────── 四组判据，一个文件 ────────────────────────────
 *
 * ① **校验那一层**（纯函数）：`desc` 必填而且必须说清（空 / 抄名字 / 太短 / 太长四种敷衍
 *    各自退回）；白名单照旧生效（**她申请也不放宽**）；删除只要名字。
 * ② **拾取那一层**（真 RealLoop 的 tick）：她把单子写进 `data/grants/` ⇒ 下一拍挂出一条
 *    `human/asked{source:'system'}`（**挂起语义**）+ `grant/requested`（凭据）；
 *    同一件事第二张单子**当场退回、不挂第二张卡**（人只该被问一次）。
 * ③ **落地那一层**（真 `applyGrant` + 真 `answerHuman`）：批准 ⇒ 只改 `mcp.servers[]` 那一段
 *    （人的 `$comment` 与别的条目一个字都不动）⇒ 索引里看得到那句"它是干什么的"；
 *    指纹对不上 ⇒ 拒执行、一个字节不动。
 * ④ **纯函数那一层的小钉子**。
 *
 * ──────────────────────────── 为什么用真台子 ────────────────────────────
 *
 * ②③ 断言的是"整条链路上发生了什么"（tick → 事件 → 投影 → 配置 → 索引），任何一层用替身
 * 搭出来测的就不是那条链路。所以用 `test/fixtures/real-wake-rig.ts`（真 EventLog、真 fold、
 * 真 RealLoop 的 tick，**只有模型是假的**）——与 `mcp-index.test.ts` 同一个台子。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CONFIG_FILE_NAME } from '../src/config/config.ts';
import {
  GRANT_REJECT_REASON_MAX, applyGrant, grantContentHash, grantPathOf, grantsDirOf,
  parseGrantRequest,
} from '../src/grant/mcp-grant.ts';
import type { AppEvent } from '../src/log/types.ts';
import { mcpDescProblem, MCP_DESC_DECLARED_MAX_CHARS } from '../src/mcp/description.ts';
import { MCP_INDEX_HEADER } from '../src/persona/assets.ts';
import { answerHuman } from '../src/runtime/plan-mode.ts';
import { applyOne } from '../src/state/fold.ts';
import { makeRealWakeRig } from './fixtures/real-wake-rig.ts';
import type { RealWakeRig } from './fixtures/real-wake-rig.ts';

// ──────────────────────────────── 台子上的小工具 ────────────────────────────────

/** 台子的数据目录（`defaultConfig(workspace)` 的 `dataDir` 就是 `<workspace>/data`） */
function dataDirOf(workspace: string): string {
  return join(workspace, 'data');
}

function configPathOf(workspace: string): string {
  return join(workspace, CONFIG_FILE_NAME);
}

/**
 * 合法的启动器 + 一个不存在的入口脚本。
 *
 * 为什么不能拿一个瞎编的命令名（本文件第一版就是这么写的，**当场被白名单挡下来**）：
 * 申请单的 `command` 要过 `parseMcpServers` 的启动器白名单——`node` 在表里，
 * 而 `definitely-not-a-real-command` 不在。那件事本身就是判据 ①c 要钉的东西。
 * 脚本不会被真的跑：本文件只做"校验 / 拾取 / 写配置"，一个子进程都不起。
 */
const FAKE_COMMAND = 'node';
const FAKE_ARGS = ['C:\\nowhere\\not-a-real-mcp-server.js'];

/** 一条已经不存在的 server 条目（盘上那份配置里用的） */
const EXISTING_ENTRY = { name: 'existing', command: FAKE_COMMAND, args: FAKE_ARGS, desc: '原来就有的' };

/** 一张合法的 `mcp-add` 单子（各用例按需覆盖几格） */
function addFile(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'mcp-add',
    name: 'obscura',
    desc: '读本机浏览器历史与当前标签页',
    command: FAKE_COMMAND,
    args: [...FAKE_ARGS],
    reason: '想用它看本机浏览器里开着什么',
    ...extra,
  };
}

/** 把一张单子写进 `data/grants/`（**她**做的就是这个动作） */
function writeGrantFile(workspace: string, id: string, data: unknown): string {
  const dir = grantsDirOf(dataDirOf(workspace));
  mkdirSync(dir, { recursive: true });
  const path = grantPathOf(dataDirOf(workspace), id);
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');
  return path;
}

/** 台子日志里的全部事件 */
async function eventsOf(rig: RealWakeRig): Promise<AppEvent[]> {
  return [...(await rig.events())];
}

/** 按类型取事件（带收窄的过滤器） */
function ofType<T extends AppEvent['type']>(
  events: readonly AppEvent[], type: T,
): Array<Extract<AppEvent, { type: T }>> {
  return events.filter((event): event is Extract<AppEvent, { type: T }> => event.type === type);
}

/** 请求体里那段 MCP 索引（与 `mcp-index.test.ts` 同一把尺子） */
function mcpSegmentOf(request: { input?: unknown }): string {
  const items = Array.isArray(request.input) ? request.input : [];
  const first = items[0] as { role?: string; content?: unknown } | undefined;
  if (first === undefined || first.role !== 'developer') return '';
  const layer = typeof first.content === 'string' ? first.content : '';
  const at = layer.indexOf(MCP_INDEX_HEADER);
  if (at < 0) return '';
  const rest = layer.slice(at);
  const end = rest.indexOf('\n\n');
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * 一份最小但**合法**的配置（盘上那份；`mcp` 段整个不存在——现场那份就是这样）。
 *
 * `schemaVersion` 必须是**数字 1**：`loadConfig` 会复核写回的那份文档，字符串 `"1"` 会被当场
 * 判错、配置被回滚（本文件第一版就是那么写的，于是"批准"那几条一路 `failed`——**这是那段
 * 校验在正常工作**，不是它的毛病）。
 */
function writeBareConfig(workspace: string, extra: Record<string, unknown> = {}): string {
  const text = `${JSON.stringify({ $comment: '人写的注释，谁也不许抹掉', schemaVersion: 1, ...extra }, null, 2)}\n`;
  writeFileSync(configPathOf(workspace), text, 'utf8');
  return text;
}

// ──────────────────────────────── ① 校验那一层 ────────────────────────────────

test('① desc 必填：空 / 抄名字 / 太短 / 太长，四种敷衍各自退回（理由要能照着改）', () => {
  const empty = parseGrantRequest(addFile({ desc: '' }));
  assert.equal(empty.ok, false);
  assert.equal(empty.ok === false ? empty.reason : '', 'desc-missing');
  assert.match(empty.ok === false ? empty.detail : '', /索引/u, '退回的理由要说清"这句话会摆在索引里"');

  const echo = parseGrantRequest(addFile({ desc: 'obscura' }));
  assert.equal(echo.ok, false);
  assert.match(echo.ok === false ? echo.detail : '', /同义反复/u);

  const short = parseGrantRequest(addFile({ desc: '看网页' }));
  assert.equal(short.ok, false, '四个字以下不算"说清了它是干什么的"');

  const long = parseGrantRequest(addFile({ desc: '这是一句很长的描述'.repeat(30) }));
  assert.equal(long.ok, false);
  assert.match(long.ok === false ? long.detail : '', new RegExp(`超过 ${MCP_DESC_DECLARED_MAX_CHARS} 个字`, 'u'));

  // 缺 desc 那一格与空串同罪（都是"没弄懂就递单子"）
  const missing = parseGrantRequest(addFile({ desc: undefined }));
  assert.equal(missing.ok, false);
});

test('①b 合格的单子 ⇒ 规范化（desc 洗净成一行），指纹只认要落地的那五格', () => {
  const parsed = parseGrantRequest(addFile({
    desc: '  读本机浏览器\n历史与当前标签页  ',
    reason: '想看看\n她在浏览器里开着什么',
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.request.desc, '读本机浏览器 历史与当前标签页', '换行必须被压成一行（索引里一行一个 server）');
  assert.equal(parsed.request.reason, '想看看 她在浏览器里开着什么');

  // 与**逐字同一张单子**（desc 里那两个多余的空格也算不同）比：理由不进指纹
  // ——改一句"为什么想做"不该让这张单子作废（要落地的那份声明没变）
  const same = parseGrantRequest(addFile({ desc: '读本机浏览器 历史与当前标签页', reason: '另一个理由' }));
  assert.equal(same.ok, true);
  if (!same.ok) return;
  assert.equal(grantContentHash(same.request), grantContentHash(parsed.request), 'reason 不进指纹');
  // 而 desc 变了 ⇒ 指纹必须变（那句话是要落地的东西的一部分）
  const changed = parseGrantRequest(addFile({ desc: '读本机浏览器历史，别的都不读' }));
  assert.equal(changed.ok, true);
  if (!changed.ok) return;
  assert.notEqual(grantContentHash(changed.request), grantContentHash(parsed.request));
});

test('①c 白名单不因为她申请就放宽：内联执行被挡（理由指到那一格）', () => {
  const parsed = parseGrantRequest(addFile({ command: 'python', args: ['-c', 'print(1)'] }));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok === false ? parsed.reason : '', 'launcher');
  assert.match(parsed.ok === false ? parsed.detail : '', /command/u, '理由要指到哪一格（照 parseMcpServers 的原话）');

  // 连"表里没有的命令名"也进不来——**这是本文件第一版自己踩到的那个坑**，
  // 所以它值得一条判据：她申请一个不存在/不放行的启动器，当场被挡。
  const unknown = parseGrantRequest(addFile({ command: 'definitely-not-a-real-command', args: [] }));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.ok === false ? unknown.reason : '', 'launcher');
  assert.match(unknown.ok === false ? unknown.detail : '', /白名单/u);
});

test('①d 删除只要名字：desc 可以不写', () => {
  const parsed = parseGrantRequest({ kind: 'mcp-remove', name: 'obscura', reason: '不用了' });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.request.desc, '');
  assert.equal(grantContentHash(parsed.request), '', '删除没有"内容"可言 ⇒ 指纹是空串');
});

// ──────────────────────────────── ② 拾取那一层 ────────────────────────────────

test('② 她把单子写进 data/grants/ ⇒ 下一拍挂出一条待批（system 来源 = 挂起语义）', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  writeGrantFile(rig.dir, 'g-1', addFile());

  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();

  const events = await eventsOf(rig);
  const asks = ofType(events, 'human/asked');
  assert.equal(asks.length, 1, '这一拍该挂出恰好一条提问');
  assert.equal(asks[0]!.data.source, 'system', '待批走**挂起**语义（与计划审批同一条），不是她自己的提问');
  assert.match(asks[0]!.data.question, /批准加一个 MCP server「obscura」/u);
  assert.match(asks[0]!.data.context, /它会做什么：读本机浏览器历史与当前标签页/u, '卡面上第一句就是"它是干什么的"');
  assert.match(asks[0]!.data.context, /不点会怎样/u);

  const requested = ofType(events, 'grant/requested');
  assert.equal(requested.length, 1);
  assert.equal(requested[0]!.data.id, 'g-1');
  assert.equal(requested[0]!.data.kind, 'mcp-add');
  assert.equal(requested[0]!.data.askSeq, asks[0]!.seq, '凭据里必须记着挂在哪条提问上（否则配不上卡）');
  assert.equal(requested[0]!.data.desc, '读本机浏览器历史与当前标签页');
  assert.equal(requested[0]!.visibility, 'internal', '凭据是 internal：给她看的是那条唤醒');

  // 幂等：再跑一拍不许重复挂
  rig.append('wake/manual', { note: '再来一拍' });
  await rig.tick();
  const after = await eventsOf(rig);
  assert.equal(ofType(after, 'human/asked').length, 1, '同一张单子不许挂第二张卡（幂等靠事件状态）');
  assert.equal(ofType(after, 'grant/requested').length, 1);
});

test('②b 同一件事第二张单子：**当场退回、不挂第二张卡**（人只该被问一次）', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  writeGrantFile(rig.dir, 'g-1', addFile());
  writeGrantFile(rig.dir, 'g-2', addFile({ reason: '换个说法再来一次' }));

  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();

  const events = await eventsOf(rig);
  assert.equal(ofType(events, 'human/asked').length, 1, '只挂一张卡');
  assert.equal(ofType(events, 'grant/requested').length, 1, '只拾取一张单子');
  const resolved = ofType(events, 'grant/resolved');
  assert.equal(resolved.length, 1, '第二张当场退回（落一条结局）');
  assert.equal(resolved[0]!.data.id, 'g-2');
  assert.equal(resolved[0]!.data.exec.state, 'skipped-invalid');
  assert.match(resolved[0]!.data.exec.failure ?? '', /g-1/u, '退回理由要指回第一张单子的 id');
});

test('②c 判不过的单子：不挂卡、当场退回，文件原样留在盘上', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  writeGrantFile(rig.dir, 'g-bad', addFile({ desc: '' }));
  writeGrantFile(rig.dir, 'g-broken', '{ 这不是 JSON');

  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();

  const events = await eventsOf(rig);
  assert.equal(ofType(events, 'human/asked').length, 0, '点不动的卡不许挂出来（那会把队列堵住）');
  assert.equal(ofType(events, 'grant/requested').length, 0);
  const resolved = ofType(events, 'grant/resolved');
  assert.equal(resolved.length, 2, '两张各自落一条结局');
  assert.ok(resolved.every((event) => event.data.exec.state === 'skipped-invalid'));
  // 单子不许被框架删掉（那是她的东西）
  assert.ok(readFileSync(grantPathOf(dataDirOf(rig.dir), 'g-bad'), 'utf8').includes('"kind"'));
});

// ──────────────────────────────── ③ 落地那一层 ────────────────────────────────

test('③ 批准 ⇒ 只改 mcp.servers[] 那一段（人的 $comment 与别的条目一个字不动）', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  // 盘上的配置：一条人写的注释 + 一条已经存在的 server（**它必须原样保留**）
  writeBareConfig(rig.dir, {
    mcp: { servers: [{ name: 'existing', command: FAKE_COMMAND, desc: '原来就有的' }] },
  });

  writeGrantFile(rig.dir, 'g-1', addFile());
  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();

  const events = await eventsOf(rig);
  const askSeq = ofType(events, 'human/asked')[0]!.seq;
  const requested = ofType(events, 'grant/requested')[0]!;

  const outcome = answerHuman({
    events,
    answer: 'approve',
    by: 'human',
    askSeq,
    now: new Date(),
    write: (type, data, visibility) => rig.append(type, data).seq + (visibility === 'internal' ? 0 : 0),
  });
  assert.equal(outcome.ok, true, '答复这一格必须先成功（它是"人批准过"的唯一凭据）');

  const applied = await applyGrant({
    dataDir: dataDirOf(rig.dir),
    configPath: configPathOf(rig.dir),
    id: 'g-1',
    requestedHash: requested.data.contentHash,
  });
  assert.equal(applied.state, 'ok');
  assert.equal(applied.landed, 'obscura');

  const doc = JSON.parse(readFileSync(configPathOf(rig.dir), 'utf8')) as Record<string, unknown>;
  assert.equal(doc['$comment'], '人写的注释，谁也不许抹掉', '$comment 必须原样保留');
  const servers = (doc['mcp'] as { servers: Array<Record<string, unknown>> }).servers;
  assert.equal(servers.length, 2, '新增一条，不是替换整段');
  assert.deepEqual(servers[0], { name: 'existing', command: FAKE_COMMAND, desc: '原来就有的' });
  assert.deepEqual(servers[1], {
    name: 'obscura',
    command: FAKE_COMMAND,
    args: [...FAKE_ARGS],
    desc: '读本机浏览器历史与当前标签页',
  }, '新建的那一条要带上那句"它是干什么的"——索引里就靠它');
});

test('③b 批准之后索引里就能看到那句话（下一次重大变化点用配置重建索引）', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  writeBareConfig(rig.dir);
  writeGrantFile(rig.dir, 'g-1', addFile());
  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();

  const requested = ofType(await eventsOf(rig), 'grant/requested')[0]!;
  const applied = await applyGrant({
    dataDir: dataDirOf(rig.dir),
    configPath: configPathOf(rig.dir),
    id: 'g-1',
    requestedHash: requested.data.contentHash,
  });
  assert.equal(applied.state, 'ok');

  // 落地之后把配置热更进那台台子（生产上这一步是 ConfigWatcher 做的；台子上没有它），
  // 再模拟一次"上下文重大变化"——索引就是在那一点用**当前配置**重建的
  const loop = rig.loop as unknown as { deps: { config: { mcp: { servers: unknown[] } } } };
  loop.deps.config.mcp.servers = [{
    name: 'obscura', command: FAKE_COMMAND, desc: '读本机浏览器历史与当前标签页',
  }];
  rig.append('compaction/summary', { coveredUpToSeq: 1, summary: '（测试用的交接笔记）' });
  rig.append('wake/manual', { note: '压过之后' });
  await rig.tick();

  const segment = mcpSegmentOf(rig.requests.at(-1)!.request);
  assert.match(
    segment,
    /- obscura —— 读本机浏览器历史与当前标签页 —— 启用，/u,
    '批准的落地结果要真的进她的常驻索引（用户这一轮抱怨的那一行，至此闭环）',
  );
});

test('③c 指纹对不上（单子在审阅期间被改过）⇒ 拒执行，配置一个字节都不动', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  const before = writeBareConfig(rig.dir);
  writeGrantFile(rig.dir, 'g-1', addFile());
  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();
  const requested = ofType(await eventsOf(rig), 'grant/requested')[0]!;

  // 她在人看这张单子的期间把 desc 改了（内容指纹因此变了）
  writeGrantFile(rig.dir, 'g-1', addFile({ desc: '改成另一句话' }));

  const applied = await applyGrant({
    dataDir: dataDirOf(rig.dir),
    configPath: configPathOf(rig.dir),
    id: 'g-1',
    requestedHash: requested.data.contentHash,
  });
  assert.equal(applied.state, 'skipped-stale');
  assert.equal(readFileSync(configPathOf(rig.dir), 'utf8'), before, '拒执行 = 一个字节都不改');
});

test('③d 驳回：理由进 human/answered（她读得到那句话），配置不动', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  const before = writeBareConfig(rig.dir);
  writeGrantFile(rig.dir, 'g-1', addFile());
  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();

  const askSeq = ofType(await eventsOf(rig), 'human/asked')[0]!.seq;
  const reason = '这个 server 会读我的浏览记录，我不想让它常驻';
  assert.ok(reason.length <= GRANT_REJECT_REASON_MAX);
  const outcome = answerHuman({
    events: await eventsOf(rig),
    answer: `reject:${reason}`,
    by: 'human',
    askSeq,
    now: new Date(),
    write: (type, data) => rig.append(type, data).seq,
  });
  assert.equal(outcome.ok, true);

  const answered = ofType(await eventsOf(rig), 'human/answered')[0]!;
  assert.equal(answered.data.answer, `reject:${reason}`, '理由原样进 human/answered');
  assert.equal(answered.data.askSeq, askSeq, '精确配对（台面上可能还有别人）');
  assert.equal(readFileSync(configPathOf(rig.dir), 'utf8'), before, '驳回一个字都不写配置');
});

test('③e 幂等：同一张卡第二次答复 ⇒ 不许重复落地（判据是事件状态，不是内存记账）', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  writeBareConfig(rig.dir);
  writeGrantFile(rig.dir, 'g-1', addFile());
  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();

  const askSeq = ofType(await eventsOf(rig), 'human/asked')[0]!.seq;
  const outcome = answerHuman({
    events: await eventsOf(rig), answer: 'approve', by: 'human', askSeq,
    now: new Date(), write: (type, data) => rig.append(type, data).seq,
  });
  assert.equal(outcome.ok, true, '第一次批准成功');

  /**
   * **第二次点为什么不能靠 `answerHuman` 挡**（实测，`_tmp/dbg-idem.ts`）：
   * 待批这条路上的提问是 `source: 'system'`，它被认领之后那一轮会挂起；而 `answerHuman`
   * 挑答复对象的顺序里，排在"台面上还开着的提问"**之前**的是"挂起中的那次提问"
   * （`scan.waiting ?? scan.answered?.suspension`）⇒ 第二次点**照样 ok**，又写一条
   * `human/answered`。
   *
   * ⇒ 幂等的落点是**这一格自己**：`grant/resolved` 已经落过，就是"这张卡点过了"。
   * `grant-decide` 在处理之前按事件状态拦一道（`web/server.ts`）。
   * 这里钉住两半：① 那条判据的素材确实在日志里；② 它认得出"这张单子已经有结局"。
   */
  const events = await eventsOf(rig);
  const resolved = ofType(events, 'grant/resolved');
  assert.equal(resolved.length, 0, '这一条路径（手写事件）里框架那一端还没落结局');

  // 框架那一端落下结局之后，第二次点就撞在 409 的判据上
  rig.append('grant/resolved', {
    id: 'g-1', askSeq, kind: 'mcp-add', name: 'obscura', outcome: 'approved', by: 'human',
    reason: null, contentHash: '', exec: { state: 'ok', landed: 'obscura' },
  });
  const after = await eventsOf(rig);
  assert.equal(
    after.filter((event) => event.type === 'grant/resolved' && event.data.id === 'g-1').length,
    1,
    '同一张单子只可能有一条结局——`grant-decide` 就是按这一条拦下第二次点的',
  );
});

// ──────────────────────────────── ④ 纯函数那一层的小钉子 ────────────────────────────────

test('④ 单子不在盘上 ⇒ 拒执行（"她撤了单"与"从来没写过"是同一支）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-grant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dataDirOf(dir), { recursive: true });
  const applied = await applyGrant({
    dataDir: dataDirOf(dir),
    configPath: join(dir, CONFIG_FILE_NAME),
    id: 'never-written',
    requestedHash: '',
  });
  assert.equal(applied.state, 'skipped-invalid');
  assert.match(applied.failure ?? '', /申请单不在了/u);
});

test('④b desc 判据的边界（合格 / 空 / 抄名字 / 大小写 / 带后缀）', () => {
  assert.equal(mcpDescProblem('obscura', '读本机浏览器历史与当前标签页'), null);
  assert.notEqual(mcpDescProblem('obscura', 'obscura'), null);
  assert.notEqual(mcpDescProblem('obscura', 'Obscura'), null, '大小写不同也是抄名字');
  assert.notEqual(mcpDescProblem('obscura', 'obscura MCP'), null, '带个后缀还是抄名字');
  // 下界是 4 个字：以下退回，正好 4 个放行（**判据只管长度**，内容由她自己负责）
  assert.notEqual(mcpDescProblem('obscura', '看网页'), null);
  assert.equal(mcpDescProblem('obscura', '用来看网页'), null);
  assert.notEqual(
    mcpDescProblem('a', ''), mcpDescProblem('a', 'a'),
    '"空着"与"抄名字"是两种理由（她照着改的方向不一样）',
  );
});
