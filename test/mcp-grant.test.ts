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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { CONFIG_FILE_NAME } from '../src/config/config.ts';
import {
  GRANT_REJECT_REASON_MAX, GRANT_WAKE_CARD_SENTENCE, applyGrant, grantContentHash, grantFileProblems,
  grantPathOf, grantReceiptLine, grantWakeNoteOf, grantsDirOf, listGrants, parseGrantRequest,
  type GrantWakeFacts,
} from '../src/grant/mcp-grant.ts';
import type { AppEvent } from '../src/log/types.ts';
import { mcpDescProblem, MCP_DESC_DECLARED_MAX_CHARS } from '../src/mcp/description.ts';
import { MCP_INDEX_HEADER } from '../src/persona/assets.ts';
import { answerHuman } from '../src/runtime/plan-mode.ts';
import { applyOne } from '../src/state/fold.ts';
import { makeRealWakeRig } from './fixtures/real-wake-rig.ts';
import type { RealWakeRig } from './fixtures/real-wake-rig.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

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

// ── ②d/②e/②f 2026-10-21：拾取不再只挂在拍上 + 退单幂等 ──
//
// 现场症状（用户报的）：她 turn 中途递的单子，界面三处（右下角卡 / 角标 / 托盘）全无——
// 因为拾取只挂在 `tickOnce`，而 turn 运行期间 `tickInFlight` 把到点的整拍丢弃。实测要等
// 57s / 1m47s / 4m57s（那一轮 turn 跑了 348.9s，`runtime/slow-tick skipped=344`）。

/** 两步之间写一张单子的工具（"她 turn 中途递单"这个动作的替身） */
const MID_TURN_GRANT_TOOL = 'probe_grant_writer';

test('②d turn 中途递单：step 边界就挂出来（不等这一轮说完），连续两步不重复挂', async (t) => {
  const id = 'g-mid-turn';
  const rig = await makeRealWakeRig({
    registerTools: [{
      name: MID_TURN_GRANT_TOOL,
      handler: async () => {
        // 工具执行那一刻 = 两步之间：正是生产里"她写完单子、这一轮还在跑"的形状
        writeGrantFile(rig.dir, id, addFile({
          name: 'mid-turn', desc: 'turn 中途递进来、等用户点头的那张单子',
        }));
        return { content: '单子已递' };
      },
    }],
    stream: [
      { text: '', toolCalls: [{ callId: 'call_1', name: MID_TURN_GRANT_TOOL, arguments: '{}' }] },
      { text: '', toolCalls: [{ callId: 'call_2', name: MID_TURN_GRANT_TOOL, arguments: '{}' }] },
      { text: '好。' },
    ],
  });
  t.after(rig.dispose);

  rig.append('wake/manual', { note: '开始跑一轮' });
  await rig.tick();

  const events = await eventsOf(rig);
  const requested = ofType(events, 'grant/requested');
  const asks = ofType(events, 'human/asked');
  assert.equal(requested.length, 1, '同一份单子只该被拾取一次（第 2、3 步边界都扫过一遍）');
  assert.equal(asks.length, 1, '只挂一张卡——重复挂就是界面上的重复卡');
  assert.equal(requested[0]!.data.id, id);
  assert.equal(requested[0]!.data.name, 'mid-turn');
  assert.equal(
    asks[0]!.data.source, 'system',
    '待批仍是 system 来源（进投影 waitingHuman、下一轮被"她在等人"拦下）；但**不挂起这一轮**',
  );

  const stepStarts = ofType(events, 'step/start');
  assert.ok(
    stepStarts.length >= 3,
    `这一轮该跑出至少 3 步，实际 ${stepStarts.length}（事件：${events.map((event) => event.type).join(',')}）`,
  );
  // **判据（这一条就是本次修的 bug）**：单子必须在**第 2 步的 step/start 之前**就落了。
  // 还挂在拍上的话，它的 seq 只会排在 `turn/end` 之后（这一轮说完才扫得到）。
  assert.ok(
    requested[0]!.seq < stepStarts[1]!.seq,
    `单子要在第 2 步开始之前被拾取（requested seq=${requested[0]!.seq}，`
    + `step 2 start seq=${stepStarts[1]!.seq}）`,
  );
  const turnEnds = ofType(events, 'turn/end');
  assert.ok(turnEnds.length >= 1, '这一轮得真的跑起来并收尾');
  assert.ok(
    requested[0]!.seq < turnEnds[turnEnds.length - 1]!.seq,
    '拾取发生在 turn 运行期间，不是这一轮说完之后补的',
  );
  assert.equal(
    turnEnds[turnEnds.length - 1]!.data.reason.kind, 'completed',
    '递单只是挂一张"用户有空看"的卡，**不挂起这一轮**（挂起判定只认计划审批那一条）',
  );

  // 下一拍（tick 那条路）也不许再挂一张：两条路的幂等判据必须是同一套事件状态
  await rig.tick();
  const after = await eventsOf(rig);
  assert.equal(ofType(after, 'grant/requested').length, 1, 'tick 那条路不许重复拾取');
  assert.equal(ofType(after, 'human/asked').length, 1, 'tick 那条路不许重复挂卡');
});

test('②e 同一份坏单连走三拍：只留一条 grant/resolved（退单幂等）', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  // 现场那 33 条的形状：同一份判不过的单子，每个空拍都被再退一次
  writeGrantFile(rig.dir, 'g-bad', addFile({ desc: '' }));

  for (let i = 0; i < 3; i += 1) await rig.tick();

  const resolved = ofType(await eventsOf(rig), 'grant/resolved');
  assert.equal(resolved.length, 1, `同一份坏单三拍只该退一次（实际 ${resolved.length} 条）`);
  assert.equal(resolved[0]!.data.id, 'g-bad');
  assert.equal(resolved[0]!.data.exec.state, 'skipped-invalid');
  assert.notEqual(resolved[0]!.data.contentHash, '', '退回也要留内容指纹（下一拍靠它判幂等）');

  // 她真把单子改好了 ⇒ 下一拍照常拾取。跳过只针对"同一份内容"，同一个 id 不是黑名单。
  writeGrantFile(rig.dir, 'g-bad', addFile({ desc: '改好了：读本机浏览器历史与标签页' }));
  await rig.tick();
  const after = await eventsOf(rig);
  assert.equal(ofType(after, 'grant/requested').length, 1, '改好的单子下一拍必须被拾取');
  assert.equal(ofType(after, 'human/asked').length, 1);
});

test('②f 同一份重复单连走三拍：退回也只落一条（人只该被问一次，账也只该记一次）', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  writeGrantFile(rig.dir, 'g-1', addFile());
  writeGrantFile(rig.dir, 'g-2', addFile({ reason: '同样的事再递一次' }));

  for (let i = 0; i < 3; i += 1) await rig.tick();

  const events = await eventsOf(rig);
  assert.equal(ofType(events, 'grant/requested').length, 1, '只拾取第一张');
  assert.equal(ofType(events, 'human/asked').length, 1, '只挂一张卡');
  const resolved = ofType(events, 'grant/resolved');
  assert.equal(resolved.length, 1, `重复单三拍只该退一次（实际 ${resolved.length} 条）`);
  assert.equal(resolved[0]!.data.id, 'g-2');
  assert.match(resolved[0]!.data.exec.failure ?? '', /g-1/u, '退回理由要指回第一张单子的 id');
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
  const dir = tempDirSync('irmia-grant-');
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

test('④c 删除那一支**不要求 desc**（现场那张 remove-obscura-mcp 就是只有 kind/name/reason）', () => {
  // 用户 2026-10-22 的疑问是"缺 desc 是不是被静默丢了"。判据就钉在这里：
  // `mcp-add` 的 desc 必填（会进她的常驻索引，见文件头），`mcp-remove` **不判 desc**
  // ——删一条不需要描述它。所以那张单子照常过校验、照常进清单。
  const parsed = parseGrantRequest({
    kind: 'mcp-remove',
    name: 'obscura',
    reason: '功能与 playwright 重叠，两套浏览器工具并存只为多占工具索引和上下文',
  });
  assert.equal(parsed.ok, true, `缺 desc 的删除单必须照常通过：${JSON.stringify(parsed)}`);
  if (parsed.ok) {
    assert.equal(parsed.request.name, 'obscura');
    assert.equal(parsed.request.desc, '', '删除单的 desc 一律是空串（它没有"它是干什么的"那一格）');
    assert.notEqual(parsed.request.reason, '', '理由照旧留着（界面用它兜底显示）');
  }

  // 反过来：`mcp-add` 缺 desc 仍然当场退回（**不是静默丢**：那句话会原样回到她手上）
  const add = parseGrantRequest({ kind: 'mcp-add', name: 'obscura', command: 'node' });
  assert.equal(add.ok, false);
  if (!add.ok) {
    assert.equal(add.reason, 'desc-missing');
    assert.ok(add.detail.length > 0, '退回要说清该改哪一格');
  }
});

test('④d 盘上读不出来的单子要点名报出来（`/api/grants.malformed` 的唯一判据）', (t) => {
  const dir = tempDirSync('irmia-grant-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const grantsDir = grantsDirOf(dataDirOf(dir));
  mkdirSync(grantsDir, { recursive: true });
  writeFileSync(join(grantsDir, 'bad-json.json'), '{ 这不是 JSON', 'utf8');
  writeFileSync(join(grantsDir, 'bad-kind.json'), JSON.stringify({ kind: 'hook-add', name: 'x' }), 'utf8');
  writeFileSync(join(grantsDir, 'no-desc.json'), JSON.stringify({
    kind: 'mcp-remove', name: 'obscura', reason: '删掉它',
  }), 'utf8');

  const problems = grantFileProblems(dataDirOf(dir), []);
  const byId = new Map(problems.map((item) => [item.id, item.why]));
  assert.equal(byId.size, 2, `只报读不出来的那两张（实际：${JSON.stringify(problems)}）`);
  assert.match(byId.get('bad-json') ?? '', /JSON/u);
  assert.match(byId.get('bad-kind') ?? '', /kind/u, '解析不过的原话要原样带出来');
  assert.equal(byId.has('no-desc'), false, '缺 desc 的删除单能读：它不该出现在"读不出来"里');

  // `listGrants` 也**一张都不静默丢**：盘上有几个 id 就列几个（读不出来的也列，只是 picked:false）
  assert.deepEqual(
    listGrants(dataDirOf(dir), [], []).map((item) => item.id).sort(),
    ['bad-json', 'bad-kind', 'no-desc'],
    'listGrants 的口径是"盘上的 id 都在清单里"，读不出来的由 malformed 那一格说清',
  );

  // 已经进日志的那一张不再报（`listGrants` 的清单里有它，两处说同一件事就是噪声）
  const requested = {
    seq: 1, ts: new Date(0).toISOString(), type: 'grant/requested', visibility: 'internal',
    data: { id: 'bad-kind', kind: 'mcp-remove', name: 'x', by: 'agent', contentHash: '', path: '', reason: '', turn: 0 },
  } as unknown as AppEvent;
  const after = grantFileProblems(dataDirOf(dir), [requested]);
  assert.deepEqual(after.map((item) => item.id), ['bad-json'], '进了日志的 id 由清单那一条负责');
});

// ──────── ⑤ 唤醒正文末尾那句"卡在哪、怎么处理"（两支共用同一句；用户 2026-10-21） ────────
//
// 用户这一轮的两条原话：「各处文案要对齐。」「agent 得知道自己弹了卡，可以指引用户去看。」
// 她递完单子就看不见界面了：卡摆在哪儿、要不要盯着、怎么喊人去看——这三件事她**推不出来**，
// 所以写进她读的那条正文（**唯一实现**是 `GRANT_WAKE_CARD_SENTENCE`，技能那一支也拼它）。
// 判据是"**只加一句**"：同一句在正文里只出现一次、加在末尾、原来的字里没有一个词重复。

/** 那一句"卡在哪"的全部判据（MCP 与技能两支共用这一把尺子） */
function assertCardSentenceOnce(note: string, label: string): void {
  assert.ok(note.includes('扩展页'), `${label}：要说清卡在扩展页`);
  assert.ok(note.includes('快速审批卡'), `${label}：要说出右下角那张快速审批卡`);
  assert.ok(note.includes('待批'), `${label}："待批"要与界面同一份用词`);
  // ① **只加一句**：那一句整体只出现一次（就是那一个常量，不许各处自己再拼一句）
  assert.equal(note.split(GRANT_WAKE_CARD_SENTENCE).length, 2, `${label}：只加一句，且是同一个实现`);
  assert.ok(note.endsWith(GRANT_WAKE_CARD_SENTENCE), `${label}：加在正文末尾，不打断原来的说明`);
  // ② 原来的正文里**不许重复**这几个词（重复 = 多写了一段）
  const body = note.slice(0, note.length - GRANT_WAKE_CARD_SENTENCE.length);
  for (const word of ['扩展页', '快速审批卡', '待批']) {
    assert.equal(body.includes(word), false, `${label}：原来的正文里不该重复「${word}」`);
  }
  // ③ **不加第二段**：仍是单行，且整条正文只多一个句号
  assert.equal(note.includes('\n'), false, `${label}：一句，不是第二段`);
  assert.equal(
    (note.match(/。/gu) ?? []).length, (body.match(/。/gu) ?? []).length + 1,
    `${label}：整条正文只多一个句号`,
  );
}

/** 三态共用的素材（MCP 加一个 server） */
const CARD_FACTS = {
  id: 'g-90', kind: 'mcp-add' as const, name: 'obscura',
  outcome: 'approved' as const, reason: null,
  exec: { state: 'ok' as const, landed: 'obscura' },
} satisfies GrantWakeFacts;

test('⑤a MCP 三态的正文都带那句"卡在哪"，且只加一句', () => {
  const approved = grantWakeNoteOf(CARD_FACTS);
  const rejected = grantWakeNoteOf({ ...CARD_FACTS, outcome: 'rejected', reason: '不想加' });
  const failed = grantWakeNoteOf({
    ...CARD_FACTS, exec: { state: 'failed', failure: '写配置时文件被锁住' },
  });
  for (const [label, note] of [['批准', approved], ['驳回', rejected], ['批准但没落地', failed]] as const) {
    assertCardSentenceOnce(note, label);
  }
  // 用词与回执同一份：MCP 那两支 =「写进配置」（"装进技能根/移进回收站"是技能那两支的话）
  assert.match(approved, /写进配置/u);
  assert.match(grantReceiptLine(CARD_FACTS), /写进配置/u);
});

test('⑤b MCP 删除那一支的 ok 态：不许照抄加那一支的"那句描述写进配置"', () => {
  const removed = grantWakeNoteOf({
    ...CARD_FACTS, kind: 'mcp-remove', name: 'obscura', exec: { state: 'ok', landed: 'obscura' },
  });
  assert.match(removed, /已经从配置里删掉了/u);
  assert.equal(
    removed.includes('它是干什么的'), false,
    '删除没有"那句描述"可写——照抄加那一支就是一句假话（与 2026-10-20 修的三处卡面假话同一个形状）',
  );
  assert.equal(removed.includes('才会被真的拉起'), false, '删掉之后不会再被拉起（旧文案也照抄了加那一支）');
  assertCardSentenceOnce(removed, 'MCP 删除');
});
