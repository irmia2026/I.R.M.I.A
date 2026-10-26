/**
 * 「读一个群之后，该群未读=0；直到又来新消息才重新计数」——`read_channel` 的**退出机制**
 * （src/tools/admin.ts 的 read_channel + src/channel/sessions.ts 的未读折叠）
 *
 * 用户 2026-10-24 报的 bug 原话：
 *   「这个未读要有退出机制。一旦 read_channel 过对应的群聊之后，就不把未读标签取消掉了。
 *     直到再次有未读消息。」
 * 截图（运行情况 → 外部会话）：Astrbot猫娘群 未读 418 · 清漪粉丝群 1151 · 用户的熟人小群 61 ·
 * Alife桌宠交流群 510 · IRMIA框架测试群 392 · 待认群名 26。
 *
 * 查下来的机械原因（真日志 235,585 条 / 1474 次 read_channel 对账）：界面那一栏的未读是
 * `msgSeq > readUpToSeq` 的条数，而 `channel/read` **只有一个分支会写**——"这一屏摆出了东西"。
 * 另外两条她也确实读过了的路一笔都不写：
 *   · **没有新消息**那一条（她刚确认过"这儿没有新东西"，这条确认本身就是已读）；
 *   · **翻页翻到了最新**那一页（翻旧话不该动已读，翻到最新就是读过了）。
 * 已读位不动，界面上的数就停在旧水位上——正是用户看到的"标签不消失"。
 *
 * 这一份钉住四条口径（全部走真链路：真 EventLog → 真 RealLoop 的读取口与会话簿 → 真 read_channel）：
 *   ⓐ 5 条未读 → 默认读一次 → 未读 0 → 又来 2 条 → 未读 2（"再来新消息才重新计数"）
 *   ⓑ 5 条未读 → `before` 翻到更早 → **未读保持不变**（既有设计，别改坏）
 *   ⓒ 没有新消息时读一次 → **未读 0**（2026-10-24 的新口径：确认没有新东西 = 已读）
 *   ⓓ 翻页**翻到最新** → 未读 0（同上；只翻旧话仍然一笔不写，见 ⓑ）
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { defaultVisibility, type AppEvent } from '../src/log/types.ts';
import { fold, applyOne } from '../src/state/fold.ts';
import { RealLoop } from '../src/runtime/real-loop.ts';
import { createAdminTools } from '../src/tools/admin.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { buildCatalogRegistry } from '../src/tools/catalog.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';
import type { ToolHandlerResult } from '../src/tools/types.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const TZ = 'Asia/Shanghai';
const SID = 'qq:group:G1';
const BASE = Date.parse('2026-10-24T02:00:00.000Z');

const PERSONA: PersonaAssets = {
  identity: 'IDENTITY',
  constitution: 'CONSTITUTION',
  style: 'STYLE',
  state: 'STATE',
  relationship: null,
  personaHash: 'test-hash',
  isSeed: false,
} as unknown as PersonaAssets;

function fakeDs(): DsClient {
  return {
    modelFor: (): string => 'fake',
    generate: async (): Promise<never> => { throw new Error('这一份用例不该调模型'); },
    stream: async (): Promise<never> => { throw new Error('这一份用例不该调模型'); },
  } as unknown as DsClient;
}

interface Rig {
  /** 落一条通道消息（`msgSeq` = 第 `no` 句，与平台序号同量纲）；`minutes` 决定它在时间轴上的位置 */
  write: (no: number, minutes?: number) => number;
  /** 落一条她自己说出去的话（`speak/sent`） */
  speak: (text: string, callId: string, minutes?: number) => number;
  /** 读一次；`fresh` = 换一个工具实例（模拟重启，内存态全空） */
  read: (args: Record<string, unknown>, opts?: { fresh?: boolean }) => Promise<ToolHandlerResult>;
  /** 这个会话的**未读条数**——会话簿那一份，也是界面 `GET /api/sessions` 给的那个数 */
  unread: () => Promise<number>;
  /** 已读位（会话簿折出来的 `readUpToSeq`） */
  readUpToSeq: () => Promise<number>;
  /** 这个会话到目前为止写下的每一笔 `channel/read` */
  readEvents: () => Array<{ sid: string; upToSeq: number }>;
  /** 第 `no` 句的**真实事件 seq**（翻页游标要用它） */
  seqOf: (no: number) => number;
}

async function makeRig(t: TestContext): Promise<Rig> {
  const dir = tempDirSync('irmia-unread-clear-');
  const log = await EventLog.open(join(dir, 'events'));
  const projection = fold([]);
  const now = (): Date => new Date(BASE);
  t.after(() => {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const seqs = new Map<number, number>();
  const push = (type: string, data: Record<string, unknown>, minutes: number): number => {
    const seq = log.nextSeq();
    const event = {
      seq,
      ts: new Date(BASE + minutes * 60_000).toISOString(),
      type,
      data,
      visibility: defaultVisibility(type as never),
      origin: 'test/unread-clear',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    applyOne(projection, event);
    return seq;
  };
  const write: Rig['write'] = (no, minutes = 0) => {
    const seq = push('channel/message', {
      channel: 'qq-official',
      chatType: 'group',
      person: 'OPENID_A',
      chatId: 'G1',
      text: `第 ${no} 句`,
      messageId: `m-${no}`,
      msgSeq: no,
    }, minutes);
    seqs.set(no, seq);
    return seq;
  };
  const speak: Rig['speak'] = (text, callId, minutes = 0) => push('speak/sent', {
    channel: 'reply-url', chars: text.length, sid: SID, text, spokenParts: 1, callId, turn: 7,
  }, minutes);

  const real = new RealLoop({
    log,
    dataDir: dir,
    projection,
    now,
    timezone: TZ,
    ds: fakeDs(),
    registry: new ToolRegistry(),
    persona: PERSONA,
    config: defaultConfig(dir),
    out: () => {},
    pollMs: 3_600_000,
  });
  // 预热（`warmUp` → `collectSessions`）走**真入口**：未读与已读位都是它折出来的
  await real.tickOnce();
  await real.tickOnce();

  const reads: Array<{ sid: string; upToSeq: number }> = [];
  /**
   * 工具的 `emit` —— **照生产那一口来：它同时就是"落库"**（`main.ts` 把 `emit` 接到日志写入）。
   * 只收进数组的话，测的就是空气：会话簿折的是**日志里**那条 `channel/read`。
   */
  const emit = (type: string, data: unknown): void => {
    if (type === 'channel/read') reads.push(data as { sid: string; upToSeq: number });
    const seq = log.nextSeq();
    const event = {
      seq,
      ts: now().toISOString(),
      type,
      data,
      visibility: defaultVisibility(type as never),
      origin: 'test/unread-clear',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    applyOne(projection, event);
  };
  const toolkit = (): ReturnType<typeof createAdminTools> => createAdminTools({
    timers: new TimerStore(null),
    emit,
    channelReader: async (sid, limit, before) => await real.readChannelMessages(sid, limit, before),
    channelSpokenReader: async (sid) => await real.readChannelSpoken(sid),
    channelSessions: () => real.sessionRows(),
    mentionMessage: () => null,
    timezone: TZ,
  });
  let tk = toolkit();
  const ctx = {
    callId: 'call_read', turn: 3, step: 1,
    signal: new AbortController().signal, workspaceRoot: dir,
  };
  /** 会话簿那一份（**真入口**：每拍重折；界面 `/api/sessions` 折的是同一份） */
  const row = async (): Promise<{ unread: number; readUpToSeq: number }> => {
    await real.tickOnce();
    const hit = real.sessionRows().find((it) => it.sid === SID);
    return { unread: hit?.unread ?? 0, readUpToSeq: hit?.readUpToSeq ?? 0 };
  };
  return {
    write,
    speak,
    read: async (args, opts = {}) => {
      if (opts.fresh === true) {
        await real.tickOnce();
        tk = toolkit();
      }
      return await tk.byName('read_channel').handler(args, ctx);
    },
    unread: async () => (await row()).unread,
    readUpToSeq: async () => (await row()).readUpToSeq,
    readEvents: () => [...reads],
    seqOf: (no) => {
      const seq = seqs.get(no);
      assert.ok(seq !== undefined, `第 ${no} 句没落库`);
      return seq;
    },
  };
}

// ─────────────────── ⓐ 读到最新就清零；直到又来新消息才重新计数 ───────────────────

test('ⓐ 5 条未读 → 默认读一次 → 未读 0 → 又来 2 条 → 未读 2', async (t) => {
  const rig = await makeRig(t);
  for (let no = 1; no <= 5; no += 1) rig.write(no, no);
  assert.equal(await rig.unread(), 5, '五条攒在那儿（界面那一栏该显示 5）');

  const out = await rig.read({ sid: SID, limit: 20 });
  assert.equal(out.isError, undefined, out.content);
  assert.equal(await rig.unread(), 0, '读过了 ⇒ 未读必须清零（用户要的"退出机制"）');
  assert.deepEqual(rig.readEvents().at(-1), { sid: SID, upToSeq: 5 }, '已读位推到第 5 句（那一屏的最后一条）');

  // 清零是"到此刻为止"的事实，不是"从此不再计数"：新消息照常重新攒
  rig.write(6, 6);
  rig.write(7, 6);
  assert.equal(await rig.unread(), 2, '又来 2 条 ⇒ 未读 2');
  const again = await rig.read({ sid: SID, limit: 20 });
  assert.equal(again.isError, undefined, again.content);
  assert.equal(await rig.unread(), 0, '再读一次又清零');
  assert.equal(await rig.readUpToSeq(), 7);
});

// ─────────────────── ⓑ 只翻旧话：未读一动不动（既有设计） ───────────────────

test('ⓑ 5 条未读 → `before` 翻到更早 → 未读保持不变（既有设计，别改坏）', async (t) => {
  const rig = await makeRig(t);
  for (let no = 1; no <= 10; no += 1) rig.write(no, no);
  await rig.read({ sid: SID, limit: 5 });      // 先立水位（读到第 10 句）
  assert.equal(await rig.unread(), 0);

  for (let no = 11; no <= 15; no += 1) rig.write(no, no);
  assert.equal(await rig.unread(), 5, '新来 5 条');
  const writesBefore = rig.readEvents().length;

  // 游标指在第 8 句：这一页是第 1..7 句——纯往回翻旧话
  const paged = await rig.read({ sid: SID, before: rig.seqOf(8), limit: 20 });
  assert.equal(paged.isError, undefined, paged.content);
  assert.equal(paged.content.includes('第 8 句'), false, '游标本身那条不重复出现（严格小于）');
  assert.equal(paged.content.includes('第 7 句'), true, `翻页照旧给游标之前那一段：\n${paged.content}`);
  assert.match(paged.content, /\*\*翻页不改已读\*\*/u, '没到最新的翻页要把这条口径写在回执里');
  assert.equal(await rig.unread(), 5, '**翻旧话一个字节都不许动未读**（既有设计）');
  assert.equal(rig.readEvents().length, writesBefore, '翻旧话一笔已读都不写');
});

// ─────────────────── ⓒ 没有新消息时读一次 → 未读 0（新口径） ───────────────────

test('ⓒ 没有新消息时读一次 → 未读 0（"她确认过没有新东西"本身就是已读）', async (t) => {
  const rig = await makeRig(t);
  for (let no = 1; no <= 3; no += 1) rig.write(no, no);
  await rig.read({ sid: SID, limit: 5 });      // 读到第 3 句
  assert.equal(await rig.unread(), 0);

  // ①② 造出**真实的那种错位**：又来了 2 条（未读该是 2），而她下一次读的那一屏被
  // **她自己连着说的 6 行**占满了（`incrementalWindow` 的例外：她刚发出去的凭据必须摆出来，
  // 例外**占名额**）⇒ 那一屏里一条外部消息都没有 ⇒ 已读位推不动（这是对的：那 2 条确实没给她看）。
  // 于是界面上的未读停在 2，而她下一次读得到的是「没有新消息」——用户看到的正是这个形状。
  rig.write(4, 4);
  rig.write(5, 4);
  for (let i = 0; i < 6; i += 1) rig.speak(`我说第 ${i} 段`, `call_${i}`, 10);
  assert.equal(await rig.unread(), 2, '那 2 条确实没给她看过 ⇒ 未读 2');

  const windowed = await rig.read({ sid: SID, limit: 5 });
  assert.equal(windowed.isError, undefined, windowed.content);
  assert.equal(await rig.unread(), 2, '这一屏一条外部消息都没有 ⇒ 未读照旧（不许凭空清零）');

  // ② 再读一次：这一次**确实没有新的**（水位已经越过那 2 条）——
  // 新口径：这句"没有新消息"就是一次确认，已读位必须推到"此刻最新"（第 5 句）⇒ 未读 0
  const quiet = await rig.read({ sid: SID, limit: 20 });
  assert.match(quiet.content, /^没有新消息/u, `这一支就是那句话：\n${quiet.content}`);
  assert.equal(await rig.unread(), 0, '确认过没有新东西 ⇒ 未读清零（2026-10-24 的新口径）');
  assert.deepEqual(rig.readEvents().at(-1), { sid: SID, upToSeq: 5 },
    '已读位推到"这一屏取数窗口里最新那条"（第 5 句），不是凭空乱推');

  // ③ 幂等：同一批再读一次，**不写第二笔**（事实不是草稿纸）
  const before = rig.readEvents().length;
  await rig.read({ sid: SID, limit: 20 });
  assert.equal(rig.readEvents().length, before, '同一个位置不写第二笔');
});

test('ⓒ′ 跨重启：那 2 条未读在重启后照样能被她读一次清掉（水位从日志读回来）', async (t) => {
  const rig = await makeRig(t);
  for (let no = 1; no <= 3; no += 1) rig.write(no, no);
  await rig.read({ sid: SID, limit: 5 });
  rig.write(4, 4);
  rig.write(5, 4);
  for (let i = 0; i < 6; i += 1) rig.speak(`我说第 ${i} 段`, `call_${i}`, 10);
  await rig.read({ sid: SID, limit: 5 });     // 屏被她的行占满 ⇒ 未读仍 2
  assert.equal(await rig.unread(), 2);

  // 换一个工具实例（内存态全空）：水位只能从**日志里那条 channel/read** 读回来。
  // 重启后那一屏会把这 2 条摆出来（"上次看过之后的新消息"），于是走的是默认那一支——
  // 无论走哪一支，结论必须一样：**读一次之后未读=0**。
  const after = await rig.read({ sid: SID, limit: 20 }, { fresh: true });
  assert.equal(after.isError, undefined, after.content);
  assert.equal(await rig.unread(), 0, '重启后读一次同样要清零');
  assert.equal(await rig.readUpToSeq(), 5);
  assert.equal(after.content.includes('第 5 句'), true, `那 2 条要真的摆到她眼前：\n${after.content}`);
});

// ─────────────────── ⓓ 翻页翻到了最新 → 未读 0 ───────────────────

test('ⓓ 翻页翻到最新（游标在最新之后）→ 未读 0，且回执如实说动过已读位', async (t) => {
  const rig = await makeRig(t);
  for (let no = 1; no <= 10; no += 1) rig.write(no, no);
  await rig.read({ sid: SID, limit: 5 });     // 水位到第 10 句
  for (let no = 11; no <= 15; no += 1) rig.write(no, no);
  assert.equal(await rig.unread(), 5);

  // 游标指在**最新之后**（她抄了一个过期的/更大的游标）：这一页里摆着的就是最新那几条
  const page = await rig.read({ sid: SID, before: rig.seqOf(15) + 1, limit: 20 });
  assert.equal(page.isError, undefined, page.content);
  assert.equal(page.content.includes('第 15 句'), true, `这一页要真的把最新那条摆出来：\n${page.content}`);
  assert.match(page.content, /这一页到最新了，已读位已推到 seq=15/u,
    `动过已读位就要如实说（不许一边推一边说"不改已读"）：\n${page.content}`);
  assert.equal(await rig.unread(), 0, '翻到最新 = 读过了 ⇒ 未读清零');
  assert.deepEqual(rig.readEvents().at(-1), { sid: SID, upToSeq: 15 });
});
