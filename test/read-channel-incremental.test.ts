/**
 * read_channel **默认 = 增量**（2026-10-17 用户的两条口径）——src/tools/admin.ts 的 read_channel
 *
 * 用户原话两条：
 *  ① 「`read_channel` **应当默认只展示上次查看以来的新消息**。**如果上次以来没有新消息就不展示**。
 *     **除非她自己填参数翻历史**。不然每次读取都是大量输入。」
 *  ② 「然后她还有**以为有人在前面 at 了自己**的问题。考虑一下**标识提及消息更明显一点**。
 *     起码要让她**看懂，不再往前翻了**。」
 *
 * 这一份钉住的就是这两条，正反两面都断言：
 *   ① **增量**：有 3 条新的 ⇒ 只给这 3 条；一条没有 ⇒ 一句话（**并且断言它很短**）；
 *   ② **跨重启**：水位从**日志**读回来（换一个工具实例、内存态全空，仍然知道"上次看到哪"）；
 *   ③ **翻历史**：给 `before` 照旧给那一页，**一笔已读都不写**（未读那笔账不受影响）；
 *   ④ **提及**：行首 `▶ ` + 行尾相对年龄；**旧提及（水位之内）必须被点명"不是新消息"**，
 *      且**不许算进"新的 N 条"**；
 *   ⑤ **页脚游标**：她四天前那句老发言**不许**再当页脚游标（那是"她往前翻"的机械原因）。
 *
 * 走**真链路**（真 EventLog → 真 RealLoop 的读取口与 `sessionRows()` → 真 read_channel），
 * 因为"水位跨重启成立"这件事的价值全在"日志里那条 `channel/read` 真的折得回来"，
 * 替身会把这层整个抹掉。
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
import { MAX_DESCRIPTION_TOKENS, estimateTokens } from '../src/tools/registry.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';
import type { ToolHandlerResult } from '../src/tools/types.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const TZ = 'Asia/Shanghai';
const SID = 'qq:group:G1';
const BASE = Date.parse('2026-10-17T02:00:00.000Z');

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
  /** 落一条通道消息；`at` 是它离基准时刻的**分钟数**（负数 = 更早） */
  write: (no: number, patch?: { at?: boolean; minutes?: number }) => number;
  /** 落一条她自己说出去的话（`speak/sent`；这道闸见 `deliveredToSid`） */
  speak: (text: string, callId: string, minutes?: number) => number;
  /**
   * 读一次。`fresh` = **换一个工具实例**（内存态全空）——用来模拟**重启**：
   * 进程里的 `readState` 没了，只剩日志里那条 `channel/read`。
   */
  read: (args: Record<string, unknown>, opts?: { fresh?: boolean }) => Promise<ToolHandlerResult>;
  /** 这个会话的**未读条数**（会话簿那一份，宿主算的；未读那笔账不该被这一版改动碰到） */
  unread: () => Promise<number>;
  /**
   * 「**这一轮就是它在叫她**」——把那条 @ 她的消息摆成宿主会递给工具的那一份
   *（`mentionMessage()`：`{sid, messageId}`）。不设就是"这一轮没人叫她"。
   */
  call: (messageId: string | null) => void;
  readEvents: () => Array<{ sid: string; upToSeq: number }>;
  /** 第 `no` 句的**真实事件 seq**（从本夹具落库时记下的那一份里查） */
  seqOf: (no: number) => number;
  /** 页脚/正文里最后一个 `before=` 游标 */
  cursorOf: (content: string) => number;
}

function rowNos(content: string): number[] {
  const out: number[] = [];
  for (const line of content.split('\n')) {
    if (!/^(?:▶ )?\d\d-\d\d \d\d:\d\d /u.test(line)) continue;
    const hit = /第 (\d+) 句/u.exec(line);
    if (hit !== null) out.push(Number(hit[1]));
  }
  return out;
}

async function makeRig(t: TestContext): Promise<Rig> {
  const dir = tempDirSync('irmia-channel-incr-');
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
      origin: 'test/channel-incr',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    applyOne(projection, event);
    return seq;
  };
  const write: Rig['write'] = (no, patch = {}) => {
    const seq = push('channel/message', {
      channel: 'qq-official',
      // `group-at` = 平台 @ 了她（宿主 `mentionedInMessage` 认它）
      chatType: patch.at === true ? 'group-at' : 'group',
      person: 'OPENID_A',
      chatId: 'G1',
      text: `第 ${no} 句`,
      messageId: `m-${no}`,
      msgSeq: no,
      ...(patch.at === true ? { mentionsMe: true } : {}),
    }, patch.minutes ?? 0);
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
  // 预热（`warmUp` → `collectSessions`）走**真入口**：水位那条账就是它折出来的
  await real.tickOnce();
  await real.tickOnce();

  const reads: Array<{ sid: string; upToSeq: number }> = [];
  /**
   * 工具的 `emit` —— **照生产那一口来：它同时就是"落库"**（`main.ts` 把 `emit` 接到日志写入）。
   *
   * 为什么这一份用例必须真落库（别的 read_channel 用例只收进数组就够）：这一份要验的正是
   * 「已读位**跨重启**成立」，而那个前提就是"那条 `channel/read` 真的在日志里"——
   * 只收进数组的话，测的是空气。
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
      origin: 'test/channel-incr',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    applyOne(projection, event);
  };
  /** 「这一轮叫她的那条」（宿主那一格：`mentionMessage`）。`null` = 这一轮没人叫她 */
  let mention: { sid: string; messageId: string } | null = null;
  /**
   * 造一个工具实例。**每调一次都是一份全新的内存态**（`fresh` 就是靠它模拟重启）：
   * 只有 `channelSessions` 那一格会把**日志里的**已读位带进来。
   */
  const toolkit = (): ReturnType<typeof createAdminTools> => createAdminTools({
    timers: new TimerStore(null),
    emit,
    channelReader: async (sid, limit, before) => await real.readChannelMessages(sid, limit, before),
    channelSpokenReader: async (sid) => await real.readChannelSpoken(sid),
    channelSessions: () => real.sessionRows(),
    mentionMessage: () => mention,
    timezone: TZ,
  });
  let tk = toolkit();
  const ctx = {
    callId: 'call_read', turn: 3, step: 1,
    signal: new AbortController().signal, workspaceRoot: dir,
  };
  return {
    write,
    speak,
    read: async (args, opts = {}) => {
      if (opts.fresh === true) {
        // 「重启」= 宿主先按日志把会话簿折回来（真实链路里就是启动那一次 `warmUp`），
        // 再换一个**内存态全空**的工具实例
        await real.tickOnce();
        tk = toolkit();
      }
      return await tk.byName('read_channel').handler(args, ctx);
    },
    unread: async () => {
      // 会话簿那一份未读：**真入口**（每拍重折），与此刻层清单读的是同一个数
      await real.tickOnce();
      return real.sessionRows().find((it) => it.sid === SID)?.unread ?? 0;
    },
    call: (messageId) => { mention = messageId === null ? null : { sid: SID, messageId }; },
    readEvents: () => [...reads],
    seqOf: (no) => {
      const seq = seqs.get(no);
      assert.ok(seq !== undefined, `第 ${no} 句没落库`);
      return seq;
    },
    cursorOf: (content) => {
      const at = content.lastIndexOf('before=');
      assert.ok(at >= 0, `这一屏没有给翻页游标：\n${content}`);
      const hit = /^before=(\d+)/u.exec(content.slice(at));
      assert.ok(hit !== null, `那个游标不是个正整数：\n${content.slice(at, at + 40)}`);
      return Number(hit[1]);
    },
  };
}

/** 她自己的那一行（`（我）`）——用来断言"没摆下的那些"翻得回来 */
const MINE = '（我）';

// ──────────────────────────────── ① 增量：有 3 条 ⇒ 只给这 3 条 ────────────────────────────────

test('有 3 条新消息 ⇒ 只给这 3 条（不再把之前的旧话一起倒一遍）', async (t) => {
  const rig = await makeRig(t);
  for (let no = 1; no <= 30; no += 1) rig.write(no);
  // 第一次读：**没有水位**（日志里一条 `channel/read` 都没有）⇒ 走既有的"宁可多给一次"
  const boot = await rig.read({ sid: SID, limit: 5 });
  assert.equal(boot.isError, undefined, boot.content);
  assert.deepEqual(rowNos(boot.content), [26, 27, 28, 29, 30], '第一次读给最近一屏（既有取舍，不是这一版改的）');

  // 之后只来 3 条 ⇒ 默认那一屏**只给这 3 条**
  rig.write(31, { minutes: 1 });
  rig.write(32, { minutes: 1 });
  rig.write(33, { minutes: 1 });
  const out = await rig.read({ sid: SID, limit: 20 });
  assert.equal(out.isError, undefined, out.content);
  assert.deepEqual(rowNos(out.content), [31, 32, 33], `只给新来的那 3 条：\n${out.content}`);
  for (const old of ['第 30 句', '第 29 句', '第 26 句']) {
    assert.equal(out.content.includes(old), false, `旧话一个字都不许再倒：${old}\n${out.content}`);
  }
  assert.match(out.content, /上次看过之后 3 条新的/u, `头一行要说清这是增量：\n${out.content}`);
});

// ──────────────────────────────── ② 增量：一条没有 ⇒ 一句话（且很短） ────────────────────────────────

test('一条新的都没有 ⇒ 只有一句"没有新消息"（断言回执很短、且没有那个框）', async (t) => {
  const rig = await makeRig(t);
  rig.write(1);
  await rig.read({ sid: SID, limit: 5 });
  const out = await rig.read({ sid: SID, limit: 20 });
  assert.match(out.content, /^没有新消息/u, `第一句必须是那四个字：\n${out.content}`);
  assert.equal(out.content.includes('[external_event'), false, `不许返回一大段旧内容：\n${out.content}`);
  assert.ok(out.content.length < 300,
    `这条回执要短（旧口径下这类调用中位 759 字、最大 8182 字）：实际 ${out.content.length} 字\n${out.content}`);
  assert.equal(rowNos(out.content).length, 0, '一条消息行都不许有');
});

// ──────────────────────────────── ③ 跨重启：水位从日志读回来 ────────────────────────────────

test('跨重启：换一个实例（内存态全空）仍然只给"上次查看之后"的', async (t) => {
  const rig = await makeRig(t);
  for (let no = 1; no <= 10; no += 1) rig.write(no);
  await rig.read({ sid: SID, limit: 10 });
  assert.equal(rig.readEvents().length, 1, '第一次读写下了一笔已读（那就是持久的水位）');

  rig.write(11, { minutes: 1 });
  rig.write(12, { minutes: 1 });

  const after = await rig.read({ sid: SID, limit: 20 }, { fresh: true });
  assert.equal(after.isError, undefined, after.content);
  assert.deepEqual(rowNos(after.content), [11, 12],
    `重启后第一次读也只给新的（水位是日志里那一笔）：\n${after.content}`);
  assert.equal(after.content.includes('第 10 句'), false, '旧话不许因为"重启了"就再倒一遍');
  assert.equal(after.content.includes('第一次读它'), false, '它**不是**第一次读——水位读回来了');
});

test('跨重启：没有新消息时也只有一句话（不因为重启就换回一整屏）', async (t) => {
  const rig = await makeRig(t);
  for (let no = 1; no <= 20; no += 1) rig.write(no);
  await rig.read({ sid: SID, limit: 20 });
  const after = await rig.read({ sid: SID, limit: 20 }, { fresh: true });
  assert.match(after.content, /^没有新消息/u, `重启后也不许换回一整屏旧内容：\n${after.content}`);
  assert.equal(after.content.includes('[external_event'), false, `不许有框：\n${after.content}`);
});

// ──────────────────────────────── ④ 翻历史：照给那一页，且不标已读 ────────────────────────────────

test('给 before 翻历史：照旧给那一页，**一笔已读都不写**、未读也不受影响', async (t) => {
  const rig = await makeRig(t);
  for (let no = 1; no <= 40; no += 1) rig.write(no);
  await rig.read({ sid: SID, limit: 10 });
  const beforeUnread = await rig.unread();
  const eventsBefore = rig.readEvents().length;

  const page = await rig.read({ sid: SID, before: rig.seqOf(31), limit: 10 });
  assert.deepEqual(rowNos(page.content), [21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
    `翻页照旧给游标之前那一段：\n${page.content}`);
  assert.match(page.content, /\*\*翻页不改已读\*\*/u, '翻页那一支要把这条口径写在回执里');
  assert.equal(rig.readEvents().length, eventsBefore, '翻历史**一笔已读都不写**');
  assert.equal(await rig.unread(), beforeUnread, '未读那笔账不受翻历史影响');

  // 翻完之后再读一次默认那一屏：仍然只给"上次查看之后"的（翻历史不动水位）
  rig.write(41, { minutes: 1 });
  const out = await rig.read({ sid: SID, limit: 20 });
  assert.deepEqual(rowNos(out.content), [41], `翻历史不许把水位往后带或往前带：\n${out.content}`);
});

// ──────────────────────────────── ⑤ 提及：显式标记 + 相对年龄 + 旧提及 ────────────────────────────────

test('提及行：行首 ▶ + 行尾相对年龄（新提及不带"不是新消息"）', async (t) => {
  const rig = await makeRig(t);
  rig.write(1);
  await rig.read({ sid: SID, limit: 5 });
  rig.write(2, { at: true, minutes: 3 });
  rig.write(3, { minutes: 3 });

  const out = await rig.read({ sid: SID, limit: 20 });
  const marked = out.content.split('\n').filter((line) => line.startsWith('▶ '));
  assert.equal(marked.length, 1, `点了她的那条要带标记：\n${out.content}`);
  assert.ok(marked[0]!.includes('第 2 句'));
  assert.match(marked[0]!, /【这条提及是.+的】/u, `行尾要有相对年龄：${marked[0]}`);
  assert.equal(marked[0]!.includes('不是新消息'), false, '它是**新的**，不许被说成旧提及');
  // 框外那句话要把这两个符号解释一次（新符号必须说清，否则她会猜）
  assert.match(out.content, /行首 ▶ 是"这一条点了你"/u, `要解释那个标记：\n${out.content}`);
});

test('旧提及（水位之内）：明写"不是新消息"，且**不算进"新的 N 条"**', async (t) => {
  const rig = await makeRig(t);
  // 第 7 句是那条 @ 她的消息；先把它读过去（水位推到它之后 ⇒ 它是"旧提及"）
  for (let no = 1; no <= 8; no += 1) rig.write(no, no === 7 ? { at: true } : {});
  await rig.read({ sid: SID, limit: 8 });
  assert.equal(rig.readEvents().length, 1, '第一次读把水位推到第 8 句');

  // 之后来了 2 条新的（都没点她）
  rig.write(9, { minutes: 1 });
  rig.write(10, { minutes: 1 });

  // 而**这一轮就是第 7 句在叫她**（它是旧提及：压在水位之内，宿主仍把它的 id 递进来）
  rig.call('m-7');
  const out = await rig.read({ sid: SID, limit: 20 }, { fresh: true });
  assert.equal(out.isError, undefined, out.content);

  // ① 新的两条照给；旧提及那一条也在（它是**这一轮叫她的那条**，不给就等于白叫）
  assert.deepEqual(rowNos(out.content), [7, 9, 10],
    `新消息 + 叫她的那条旧提及：\n${out.content}`);
  // ② 那一条必须**在同一行**写明它是旧的
  const staleRow = out.content.split('\n').find((line) => line.startsWith('▶ ')) ?? '';
  assert.ok(staleRow.includes('第 7 句'), `旧提及要带标记：\n${out.content}`);
  assert.match(staleRow, /不是新消息/u, `旧提及必须在同一行点明：${staleRow}`);
  // ③ 它**不算进"新的 N 条"**（头一行只报 2 条）
  assert.match(out.content, /上次看过之后 2 条新的/u,
    `旧提及不许被算成新消息：\n${out.content}`);
  assert.equal(out.content.includes('上次看过之后 3 条'), false, '3 = 把旧提及也算进去了');
  // ④ 框外那句说明要说清"不是新消息"是什么意思（她据此判断要不要往前翻）
  assert.match(out.content, /不要当成刚有人叫你/u, `要解释那一格：\n${out.content}`);
});

test('这一轮没人叫她、也没有新消息 ⇒ 照旧一句话（旧提及不会自己冒出来）', async (t) => {
  const rig = await makeRig(t);
  for (let no = 1; no <= 8; no += 1) rig.write(no, no === 7 ? { at: true } : {});
  await rig.read({ sid: SID, limit: 8 });
  const out = await rig.read({ sid: SID, limit: 20 }, { fresh: true });
  assert.match(out.content, /^没有新消息/u, `没人叫她、也没有新的 ⇒ 一句话：\n${out.content}`);
  assert.equal(out.content.includes('第 7 句'), false,
    `旧提及不许因为"曾经点过她"就每次冒出来：\n${out.content}`);
});

// ──────────────────────────────── ⑥ 页脚游标：不许被她几天前的发言毒到 ────────────────────────────────

test('页脚游标：她四天前那句老发言不许再当游标（取数窗口的最旧一条才是）', async (t) => {
  const rig = await makeRig(t);
  // 四天前她在群里说过一句（`readChannelSpoken` 给的是**全部**，无窗口——这正是毒源）
  const oldSpeechSeq = rig.speak('四天前我说过的那一句', 'call_old', -4 * 24 * 60);
  // 之后攒一批消息（她上次看到第 5 句）
  for (let no = 1; no <= 5; no += 1) rig.write(no, { minutes: -3 * 24 * 60 });
  await rig.read({ sid: SID, limit: 5 });
  for (let no = 6; no <= 25; no += 1) rig.write(no, { minutes: -1 });

  const out = await rig.read({ sid: SID, limit: 20 });
  assert.equal(out.isError, undefined, out.content);
  const cursor = rig.cursorOf(out.content);
  assert.notEqual(cursor, oldSpeechSeq,
    `页脚不许指到她四天前那句发言上（那是"她往前翻"的机械原因）：\n${out.content}`);
  assert.notEqual(cursor, oldSpeechSeq + 1, '也不许指到它旁边那一位');
  // 游标要落在**取数窗口**里（这一次宿主交给这一屏的那 20 条消息的最旧一条）
  assert.equal(cursor, rig.seqOf(6), `游标该是取数窗口最旧那条（第 6 句）：\n${out.content}`);
  assert.ok(cursor > oldSpeechSeq, '游标必须在她的老发言**之后**');
  // 而那个游标翻过去，接得上（第 5 句及更早都在）
  const page = await rig.read({ sid: SID, before: cursor, limit: 10 });
  assert.ok(rowNos(page.content).includes(5), `那个游标要接得上：\n${page.content}`);
});

// ──────────────────── ⑦ 描述：一句都不许停在旧口径上（说明与行为必须同源） ────────────────────

/**
 * **这一条钉的是"说明与行为不符"这个病害本身**（2026-10-17 v67）。
 *
 * 行为在 `fceeffe` 已换成"默认只给「上次查看之后」的新消息"，而 `description` 还停在
 * 2026-10-08 那版（"默认只给未读里点你的那些和它们之前十条"）。为什么这算缺陷而不算"文字陈旧"：
 * **她只能靠描述理解这条能力**（她看不到实现），一句错的描述会让她按旧口径去猜"为什么没给全"，
 * 然后往前翻——正是 `fceeffe` 要治的那件事。
 *
 * 判据按**字**钉（不是"描述里提到了增量"这种可解释的松口径），四件事各一条：
 *   (a) 默认 = "上次查看之后"，且"没有就明说"；
 *   (b) 翻历史要**她自己填参数**（`before`），且**翻历史不改已读**；
 *   (c) 提及行带 `▶` 与相对时间、**旧的写明"不是新消息"**；
 *   (d) **看过的标已读**。
 * 另加两条：**旧口径那半句一个字节都不许留**（留着就是这次没改干净），以及**单件 ≤100 的硬门**
 * ——它不是修辞：超了 `register` 会抛错、这一件**静默消失**（`registry.ts` 的
 * `MAX_DESCRIPTION_TOKENS`，`test/tool-catalog.test.ts` 那一条守的就是这个后果）。
 */
test('⑦ v67 描述与行为一致：默认=增量 · 翻历史不改已读 · 提及带 ▶ 与相对时间 · 看过的标已读', async () => {
  // 判据从**注册表里那一份**上取（与 `test/tool-catalog.test.ts` 同源）：她看到的描述就是它。
  // ⚠ 这一条**不走那一台事件日志的夹具**（与 ①~⑥ 不同）：它量的是清单里的字节，
  // 建一个 `makeRig` 再不用它，等于给这一条白搭一套日志与 RealLoop。
  const { registry, problems } = await buildCatalogRegistry({
    dataDir: 'data',
    timers: new TimerStore(null),
    emit: () => {},
    destructiveEnabled: true,
  });
  assert.deepEqual(problems, [], `工具因描述超预算被跳过：${problems.join('；')}`);
  const tool = registry.get('read_channel');
  assert.ok(tool !== null, 'read_channel 不在清单里（被跳过了？见上一条）');
  const description = tool.description;
  const params = tool.parameters['properties'] as {
    before: { description: string };
    sid: { description: string };
  };

  // (a) 默认那一屏是"上次查看之后"的增量 + "没有就明说"
  assert.match(description, /默认只给\*\*上次查看之后\*\*的新消息/u,
    `默认口径必须按字写清（旧口径那半句就是在这里骗她的）：${description}`);
  assert.match(description, /没有就明说/u, `"一条都没有"时回一句话也要写在描述里：${description}`);
  // (b) 翻历史 = 她自己给参数，且**不改已读**——两句都要在（各钉一处，少一句就是少一条边界）
  assert.match(description, /想看更早的自己给 before/u, `翻历史是"她自己填参数"这件事要说清：${description}`);
  assert.match(description, /翻历史不改已读/u, `"翻旧的不动已读"是这条工具唯一的只读路径，必须在描述里`);
  assert.match(params.before.description, /不改已读/u, 'before 的参数描述里也要有同一条口径（她两个都看得到）');
  // (c) 提及行的两个符号 + 旧提及的定性
  assert.match(description, /提及行带 ▶ 与相对时间/u, `提及怎么认（▶ + 相对时间）要在描述里：${description}`);
  assert.match(description, /旧的写明"不是新消息"/u,
    `旧提及会被误当成"刚有人叫我"——这一句就是治它的（措辞与框外那句同源）：${description}`);
  // (d) 看过的标已读（这条原来就有，改动不许把它弄丢）
  assert.match(description, /看过的标记已读/u, `"看过的标已读"不许在改写里丢掉：${description}`);
  // 既有的两句不许被顺手改掉：她自己的发言在里面、不给 sid 就是列会话簿
  assert.match(description, /也包括你自己说过的/u, `她自己的发言仍在里面：${description}`);
  assert.match(description, /（我）/u, '要告诉她怎么认那一行（行首那个 `（我）` 是全角括号）');
  assert.match(description, /不给 sid 则列出全部会话/u, `"不给 sid = 列会话簿"这一支要留着：${description}`);
  // **旧口径一个字节都不许留**：留着就是这次没改干净（行为早换了）
  assert.equal(description.includes('之前十条'), false, `旧口径那半句必须删净：${description}`);
  assert.equal(description.includes('未读里'), false, `旧口径的判据说法也不许留：${description}`);
  // 描述是**单行**：换行会让这一份字节带上一处没人预期的空白
  assert.equal(description.includes('\n'), false, '描述里不许出现换行');
  // 单件 token ≤100（硬门）——这一次改动的代价读数就落在这里
  const tokens = estimateTokens(description);
  assert.ok(tokens <= MAX_DESCRIPTION_TOKENS,
    `read_channel 描述 ${tokens} token，超过硬门 ${MAX_DESCRIPTION_TOKENS}：超了不是"长一点"，是这件工具静默消失`);
  assert.equal(tokens, 90,
    `这一次（v67）的代价是 84 → 90：数字变了就同批把 render.ts 的 v67 那一篇与这里一起改准（现在 ${tokens}）`);

  // 整段 `tools` 的两口径：① 代码口径（**唯一的门**）；② 运行期口径 = ① ＋ `mcp` 那一件 110
  const specs = registry.listForModel({ includeDestructive: true });
  assert.equal(specs.length, 22, `代码口径的件数变了（22 = 运行期 23 − mcp）：${specs.length}`);
  const catalogTotal = registry.catalogTokens({ includeDestructive: true });
  // v79（2026-10-23）：**5323 → 5366（+43）**——`http_get` 描述 **54 → 86（+32）**
  // ＋ `url` 参数 +7（私网/环回被 SSRF 拒绝）＋ `max_chars` 参数 +4（印出 500000 上限）。
  // v80（2026-10-23）：`read_channel` 翻页一页的条数 50 → 15 ⇒ **5366，未动**（等宽替换：`before` /
  // `limit` 两个参数描述里各换一个两位数，`estimateTokens` 那把尺一分不差）。件数仍是 22。
  // 要动这个数就同批复测 `docs/design.md §4.18` 与 `render.ts` 的 **v80** 那一篇。
  assert.equal(catalogTotal, 5366,
    `整段 tools 的代码口径变了（v79 实测 5366 = v74 的 5323 + 43 [http_get 描述 +32 / url +7 /`
    + ` max_chars +4]；件数仍是 22）：`
    + `要动这个数就同批复测 docs/design.md §4.18 与 render.ts 的 v79 那一篇（现在 ${catalogTotal}）`);
  assert.ok(5500 - catalogTotal >= 30, `上界 5500 只剩 ${5500 - catalogTotal}（判据 ≥30）`);
  assert.equal(catalogTotal + 110, 5476, '运行期口径（+ mcp 110，推算值）');
  // 单件那一件：描述 90 ＋ sid 参数 39 ＋ 名字 4
  assert.equal(
    estimateTokens(tool.name) + tokens + estimateTokens(JSON.stringify(tool.parameters) ?? ''),
    253,
    'read_channel 整件变了（v66 的 247 → 253）',
  );
  // 「离硬门不足 10 token 就红」那条线：这次把余量定在正好 10（判据是 `< 10` ⇒ 不红）
  assert.equal(MAX_DESCRIPTION_TOKENS - tokens, 10,
    `余量必须是 10 或更多：${MAX_DESCRIPTION_TOKENS} − ${tokens} = ${MAX_DESCRIPTION_TOKENS - tokens}`);
});
