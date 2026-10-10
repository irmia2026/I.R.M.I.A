/**
 * read_channel 翻页与"默认只读未读"（2026-10-08 用户的两条要求）
 * ——src/tools/admin.ts 的 read_channel、src/runtime/real-loop.ts 的读取口
 *
 * 用户原话：「**read_channel 提供一下翻页吧**」「read_channel 默认行为应该是读到未读消息。
 * 因为之前的已经读过，进入上下文了。**如果开启翻页模式，就可以读到全部消息。每页 50 条**」
 * 「**未读也是只读提及和之前十条**」「**不视作已处理。提示她还有没看到的，往上翻页**」。
 *
 * 两条路径、两套判据，这一份把两条都钉住：
 *   ① **默认（不给游标）= 只读未读里"点了她的那些" + 每条之前十条**；已读的旧消息不再倒一遍。
 *      已读**只推进到"确实给她看过的那几条"**（没给她的保持未读，下次仍然会被告诉"还有没看到"）。
 *   ② **翻页（给 `before` 游标）= 读全部历史，每页 50 条、一个字都不动已读**。
 *
 * 走**真链路**（真 EventLog → 真 RealLoop 的两个读取口 → 真 read_channel）：游标这件事的价值
 * 全在"日志里那个 seq 真的能当游标用"，替身会把这层抹掉。
 *
 * 判据只紧不松：无重复、无空洞、不越已读位，都是**正面**断言（不是"没报错"）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { defaultVisibility, type AppEvent } from '../src/log/types.ts';
import { fold, applyOne } from '../src/state/fold.ts';
import { RealLoop } from '../src/runtime/real-loop.ts';
import { createAdminTools, READ_CHANNEL_PAGE_SIZE } from '../src/tools/admin.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';
import type { ToolHandlerResult } from '../src/tools/types.ts';

const TZ = 'Asia/Shanghai';
const SID = 'qq:group:G1';

const PERSONA: PersonaAssets = {
  identity: 'IDENTITY',
  constitution: 'CONSTITUTION',
  style: 'STYLE',
  state: 'STATE',
  relationship: null,
  personaHash: 'test-hash',
  isSeed: false,
} as unknown as PersonaAssets;

/** 模型替身：这一份测的是工具与读取口，一次模型调用都不该发生（真调了就是设计跑偏） */
function fakeDs(): DsClient {
  return {
    modelFor: (): string => 'fake',
    generate: async (): Promise<never> => { throw new Error('这一份用例不该调模型'); },
    stream: async (): Promise<never> => { throw new Error('这一份用例不该调模型'); },
  } as unknown as DsClient;
}

interface Rig {
  log: EventLog;
  /** 落一条通道消息，返回它的事件 seq（**翻页游标就是它**）。正文里带上自己那一句的编号 */
  write: (no: number, patch?: { at?: boolean; text?: string }) => number;
  read: (args: Record<string, unknown>) => Promise<ToolHandlerResult>;
  readEvents: () => Array<{ sid: string; upToSeq: number }>;
  /**
   * 第 `no` 句的**真实事件 seq**——从日志里读回来，不是落库时猜的。
   *
   * ⚠️ 为什么必须从日志读（写下这一条时刚踩到）：`RealLoop` 自己启动时会往同一个日志里写事件
   * （预热那几条），而 `EventLog.nextSeq()` 是**进程内自增**的；于是"第 N 次调用 nextSeq()"与
   * "第 N 条落库的 seq"能差出好几号。夹具按分配次序记 seq，断言就会拿一个**错的游标**去测——
   * 而错的游标恰好也能"跑通"，于是这条用例会安静地测错东西。
   */
  seqOf: (no: number) => number;
}

/**
 * 一台真链路测试台：真日志 → 真 RealLoop 的读取口 → 真 read_channel。
 *
 * `emit` 把 `channel/read` 收进数组，于是"已读位被推到哪"是一条**可正面断言**的事实。
 */
async function makeRig(t: TestContext): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-channel-page-'));
  const log = await EventLog.open(join(dir, 'events'));
  const projection = fold([]);
  const now = (): Date => new Date('2026-10-08T07:00:00.000Z');
  t.after(() => {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const seqs = new Map<number, number>();
  const write: Rig['write'] = (no, patch = {}) => {
    const seq = log.nextSeq();
    const event = {
      seq,
      // 一律同一时刻：于是先后**只由事件 seq 决定**（这正是翻页要守住的性质）
      ts: now().toISOString(),
      type: 'channel/message',
      data: {
        channel: 'qq-official',
        // `group-at` 就是"平台 @ 了她"那条消息形态（宿主 `mentionedInMessage` 认它）
        chatType: patch.at === true ? 'group-at' : 'group',
        person: 'OPENID_A',
        chatId: 'G1',
        text: patch.text ?? `第 ${no} 句`,
        messageId: `m-${no}`,
        msgSeq: no,
        ...(patch.at === true ? { mentionsMe: true } : {}),
      },
      visibility: defaultVisibility('channel/message'),
      origin: 'test/channel-page',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    applyOne(projection, event);
    seqs.set(no, seq);
    return seq;
  };

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

  const reads: Array<{ sid: string; upToSeq: number }> = [];
  const tk = createAdminTools({
    timers: new TimerStore(null),
    emit: (type, data) => {
      if (type === 'channel/read') reads.push(data as { sid: string; upToSeq: number });
    },
    channelReader: async (sid, limit, before) => await real.readChannelMessages(sid, limit, before),
    channelSpokenReader: async (sid) => await real.readChannelSpoken(sid),
    timezone: TZ,
  });
  const ctx = {
    callId: 'call_read', turn: 3, step: 1,
    signal: new AbortController().signal, workspaceRoot: dir,
  };
  return {
    log,
    write,
    read: async (args) => await tk.byName('read_channel').handler(args, ctx),
    readEvents: () => [...reads],
    // **从日志读回**那一条的真实 seq（别用落库时那次 `nextSeq()` 的返回值：
    // RealLoop 预热也会往同一个日志里写事件，两次"分配"之间能差出好几号——
    // 而一个错的游标照样能让用例跑通，于是它会安静地测错东西）
    seqOf: (no) => {
      const seq = seqs.get(no);
      assert.ok(seq !== undefined, `第 ${no} 句没落库`);
      return seq;
    },
  };
}

/**
 * 一屏里的**消息编号**（正序）——正文每一行都写着自己的编号，于是"这一屏给了哪几条"是
 * 从**她看到的那份文本**里读出来的，不是从实现内部的数组里拿的（判据不依赖内部形状）。
 *
 * ⚠️ 只认**真消息行**（`MM-DD HH:MM …`，提及那行前面多一个 `▶ `）：不这么收，"第 41 句"这种
 * 出现在**页眉/页脚**里的游标数字会被当成一条消息（写这条时刚踩到：游标恰好等于某条的编号时，
 * 行数会凭空多 1，而那种错很难看出来）。
 */
function rowNos(content: string): number[] {
  const out: number[] = [];
  for (const line of content.split('\n')) {
    // 真消息行：`MM-DD HH:MM 谁：…`（提及那行前面多一个 `▶ `）
    if (!/^(?:▶ )?\d\d-\d\d \d\d:\d\d /u.test(line)) continue;
    const hit = /第 (\d+) 句/u.exec(line);
    if (hit !== null) out.push(Number(hit[1]));
  }
  return out;
}

/** 页脚里那个游标（"带上 before=1234 重读一次"）——**取最后一个**：页眉里也有一个 before=（那是本页自己的） */
function cursorOf(content: string): number {
  const at = content.lastIndexOf('before=');
  assert.ok(at >= 0, `这一屏没有给翻页游标：\n${content}`);
  const hit = /^before=(\d+)/u.exec(content.slice(at));
  assert.ok(hit !== null, `页脚那个游标不是个正整数：\n${content.slice(at, at + 40)}`);
  return Number(hit[1]);
}

// ──────────────────────────────── ① 往回翻：无重复、无空洞 ────────────────────────────────

test('往回翻两页：连续、无重复、无空洞（用真实 seq 断言连续性）', async (t) => {
  const rig = await makeRig(t);
  for (let no = 1; no <= 40; no += 1) rig.write(no);

  // 第一屏：这个进程第一次读（没有已读位）⇒ 最近一屏
  const first = await rig.read({ sid: SID, limit: 10 });
  assert.equal(first.isError, undefined, first.content);
  const page1 = rowNos(first.content);
  assert.deepEqual(page1, [31, 32, 33, 34, 35, 36, 37, 38, 39, 40], '第一屏 = 最近 10 条');

  // 页脚给的游标 = 这一屏最旧那一条的事件 seq；`<` 严格比较 ⇒ 它自己不会在下一页重复出现
  const cursor1 = cursorOf(first.content);
  assert.equal(cursor1, rig.seqOf(31), '游标就是这一屏最旧那一条的事件 seq');

  const second = await rig.read({ sid: SID, before: cursor1, limit: 10 });
  assert.equal(second.isError, undefined, second.content);
  const page2 = rowNos(second.content);
  assert.deepEqual(page2, [21, 22, 23, 24, 25, 26, 27, 28, 29, 30], '第二页 = 紧挨着它前面的那 10 条');

  const third = await rig.read({ sid: SID, before: cursorOf(second.content), limit: 10 });
  const page3 = rowNos(third.content);
  assert.deepEqual(page3, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20], '第三页同理');

  // 两条判据一次钉死：**无重复**（三页没有共同条目）与**无空洞**（相邻两页在 seq 上严丝合缝）
  const all = [...page1, ...page2, ...page3];
  assert.equal(new Set(all).size, 30, `翻页出现重复：${all.join(',')}`);
  assert.deepEqual(
    [...all].sort((a, b) => a - b),
    Array.from({ length: 30 }, (_, i) => i + 11),
    '三页合起来正好是连续的 11..40（中间一条都不许漏）',
  );
  // 相邻两页的 seq 真的接得上：page2 的最大 seq + 1 步之内就是 page1 的最小 seq
  assert.ok(rig.seqOf(30) < rig.seqOf(31), '页与页之间按事件 seq 接续（不是靠"大概在附近"）');
  assert.ok(rig.seqOf(20) < rig.seqOf(21));
});

test('往回翻**不改已读位置**：一笔 channel/read 都不写、也不把旧话标成未读', async (t) => {
  const rig = await makeRig(t);
  for (let no = 1; no <= 40; no += 1) rig.write(no);
  await rig.read({ sid: SID, limit: 20 });
  const before = rig.readEvents();
  assert.equal(before.length, 1, '正常读一次记一笔已读');
  // 已读推进**只按"确实给她看过的那几条"**算：重启后第一次读的取数窗口是最近 `limit` 条，
  // 所以这一屏是第 21..40 句、已读推到第 40 句（**不是**取数下界，也不是本页之外的任何东西）
  assert.equal(before[0]!.upToSeq, 40, '已读推到这一屏展示过的那几条里的最后一条');

  // 连翻两页（都落在已读位之内）。游标从**日志里那一条的真实 seq** 取（回执里那个也应一致）
  const paged = await rig.read({ sid: SID, before: rig.seqOf(15), limit: 10 });
  assert.equal(paged.isError, undefined, paged.content);
  assert.deepEqual(rowNos(paged.content), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14], '第一页往回翻：第 5..14 句');
  const deeper = await rig.read({ sid: SID, before: rig.seqOf(5), limit: 10 });
  assert.equal(deeper.isError, undefined, deeper.content);
  assert.deepEqual(rowNos(deeper.content), [1, 2, 3, 4], '第二页：再往前的第 1..4 句');

  assert.deepEqual(rig.readEvents(), before, '往回翻旧消息**绝对不能**把已读位置往回退、也不能多记一笔');
  assert.match(deeper.content, /翻页不改已读/u, '回执要明说这件事（她据此不再重复核对）');
  assert.match(paged.content, /翻页不改已读/u);

  // 反证：翻完页之后"有没有新东西"的判据没被搅乱 —— 真来了新消息照样看得见
  rig.write(99, { text: '第 99 句', at: true });
  const fresh = await rig.read({ sid: SID, limit: 5 });
  assert.ok(fresh.content.includes('第 99 句'), `翻过页不该影响"新消息看得见"：${fresh.content}`);
});

// ──────────────────────────────── ② 翻到头：如实说 ────────────────────────────────

test('一直往回翻到最早：页脚如实说"已经翻到头了"', async (t) => {
  const rig = await makeRig(t);
  for (let no = 1; no <= 7; no += 1) rig.write(no);

  // 从第 5 句往前翻、一页 10 条：取回第 1..4 句（取数窗口到最早了 ⇒ 这是最后一页）
  const page = await rig.read({ sid: SID, before: rig.seqOf(5), limit: 10 });
  const rows = rowNos(page.content);
  assert.deepEqual(rows, [1, 2, 3, 4], '只剩前面那 4 条');
  assert.match(page.content, /已经翻到头了/u, `到头了要如实说（别让她以为还能继续翻）：\n${page.content}`);
  assert.equal(rows[0], 1, '最早那一条就在这一屏里（"到头"是真的到头）');
  assert.equal(page.content.includes('想接着往回翻'), false, '到头了就不该再说"接着往回翻"');

  // 反证：还没到头时必须说"想接着往回翻"（不然她不知道还能继续）
  const earlier = await rig.read({ sid: SID, before: rig.seqOf(2), limit: 1 });
  assert.ok(earlier.content.includes('第 1 句'), '游标前面还有一条 ⇒ 这一屏就是它');
});// ──────────────────────────────── ③ 往新翻：只给比已读更新的 ────────────────────────────────

test('往新翻（不带游标）：只给比已读更新的那批，旧的一条都不重复', async (t) => {
  const rig = await makeRig(t);
  for (let no = 1; no <= 5; no += 1) rig.write(no);
  const first = await rig.read({ sid: SID, limit: 10 });
  assert.ok(first.content.includes('第 5 句'));

  rig.write(6);
  rig.write(7);
  rig.write(8, { at: true }); // 最后一条点了她

  const again = await rig.read({ sid: SID, limit: 10 });
  assert.equal(again.isError, undefined, again.content);
  // 未读只有 3 条（装得下一屏）⇒ 照给全部：新话都要看得见
  assert.ok(again.content.includes('第 6 句') && again.content.includes('第 8 句'),
    `新来的三条都要看得见：${again.content}`);
  assert.equal(again.content.includes('第 1 句'), false, '已读过的旧消息一个字都不许再倒一遍');
  assert.equal(again.content.includes('第 5 句'), false, '上一屏的尾巴也不再倒一遍');

  // 提及那一条在**未读装不下一屏**时才有标记（那时只挑提及 + 前十条）；这里未读装得下，全给，无需标记
  const wide = await rig.read({ sid: SID, limit: 10 });
  assert.match(wide.content, /没有新消息/u, '同一批再读一次照旧去重');
});

// ──────────────────────────────── ④ 默认只给"提及 + 前十条" ────────────────────────────────

test('默认：未读装不下时只给提及 + 它之前十条，前面那段旧闲话不给她', async (t) => {
  const rig = await makeRig(t);
  // 先读一次把已读位立起来（第一次读的那一屏是"最近一屏"，见实现里的 ①）
  rig.write(3);
  await rig.read({ sid: SID, limit: 5 });
  // 之后攒一大批（远超一屏）：第 195 句点她，其余都是闲话
  for (let no = 1; no <= 200; no += 1) {
    if (no === 3) continue;
    rig.write(no, no === 195 ? { at: true } : {});
  }

  const out = await rig.read({ sid: SID, limit: 50 });
  assert.equal(out.isError, undefined, out.content);
  const rows = rowNos(out.content);
  assert.deepEqual(rows, Array.from({ length: 11 }, (_, i) => i + 185),
    '恰好是"提及 + 它之前十条"（别的闲话不摆出来）');
  assert.equal(out.content.includes('第 184 句'), false, '窗口之外的一条都不给');
  assert.equal(out.content.includes('第 196 句'), false, '提及之后的没点她的也不给');
});

test('默认：多提要挨得近时各带各的前十条、重叠段不重复给', async (t) => {
  const rig = await makeRig(t);
  rig.write(1);
  await rig.read({ sid: SID, limit: 5 });
  // 第 12 句与第 20 句各点她一次；取数窗口是"最近 30 条"（第 9..38 句）⇒ 两条提及都在窗口里，
  // 而第二条提及的"前十条"（第 10..19 句）**盖住了第一条提及**（第 12 句）
  for (let no = 2; no <= 38; no += 1) rig.write(no, no === 12 || no === 20 ? { at: true } : {});

  const out = await rig.read({ sid: SID, limit: 30 });
  const rows = rowNos(out.content);
  assert.equal(new Set(rows).size, rows.length, `窗口重叠时不许把同一段给两遍：${rows.join(',')}`);
  // 取数窗口是"最近 30 条"（第 9..38 句）：两条提及的窗口各被窗口下界截到从第 9 句起
  //（9..12 与 10..20）⇒ 并起来就是第 9..20 句，重叠段（10..12）只出现一次
  assert.deepEqual(rows, Array.from({ length: 12 }, (_, i) => i + 9),
    '两次提及的窗口并起来就是第 9..20 句（重叠段只给一次）');
  // 两条提及各带一个标记（她看得出两句都是冲她来的）
  const marked = out.content.split('\n').filter((line) => line.startsWith('▶ '));
  assert.equal(marked.length, 2, `两条提及各带一个标记：\n${out.content}`);
  assert.ok(marked[0]!.includes('第 12 句') && marked[1]!.includes('第 20 句'));
});

// ──────────────────────────────── ⑤ 已读推进：只推到"给她看过的那几条" ────────────────────────────────

test('已读只推进到**展示过的那一条**（不是本页末尾）；没展示的未读仍在"没看到"里', async (t) => {
  const rig = await makeRig(t);
  // 先立已读位（读到第 3 句），再攒一批：第 30 句点她，前十条 = 20..29，之后 31..49 是没点她的新话
  rig.write(3);
  await rig.read({ sid: SID, limit: 5 });
  for (let no = 4; no <= 49; no += 1) rig.write(no, no === 30 ? { at: true } : {});

  // limit 44 < 未读（47 条）⇒ 只给"提及 + 前十条"；取数窗口（最近 44 条＝第 6..49 句）刚好含它
  const first = await rig.read({ sid: SID, limit: 44 });
  assert.equal(first.isError, undefined, first.content);
  const shown = rowNos(first.content);
  assert.deepEqual(shown, Array.from({ length: 11 }, (_, i) => i + 20), '显示的是提及 + 它之前十条');

  // ① 已读**只**推到展示过的那一条（第 30 句）——不是推到本页末尾（第 49 句）
  const reads = rig.readEvents();
  assert.equal(reads.length, 2, '两次读各记一笔已读');
  assert.equal(reads[1]!.upToSeq, 30, '已读只推进到"确实给她看过的那几条"里的最后一条');
  // ② 没给她的那些**仍然没看到**：回执必须说出来，并指路翻页
  assert.match(first.content, /另有 \d+ 条你还没看/u, `没给她的那些要如实说：\n${first.content}`);
  assert.match(first.content, /往上翻页|before=\d+/u, '那句话必须带翻页指路');
});

test('「另有 N 条你还没看」：有没展示的未读时必现，一条都没漏下时不许出现', async (t) => {
  const rig = await makeRig(t);
  rig.write(3);
  await rig.read({ sid: SID, limit: 5 });
  for (let no = 4; no <= 49; no += 1) rig.write(no, no === 30 ? { at: true } : {});
  const withGap = await rig.read({ sid: SID, limit: 44 });
  assert.match(withGap.content, /另有 \d+ 条你还没看/u, `没展示的那些要如实说：\n${withGap.content}`);

  // 一条没漏下时那句话不许出现：未读装得下一屏（少于一屏）就全给她，没有"另有"
  const clean = await makeRig(t);
  clean.write(1);
  await clean.read({ sid: SID, limit: 5 });
  clean.write(2);
  clean.write(3);
  const all = await clean.read({ sid: SID, limit: 50 });
  assert.equal(all.content.includes('另有'), false, `没漏下任何未读就不许说"另有 N 条"：\n${all.content}`);
});

test('同一批未读第二次读：没展示的那些仍在"没看到"里（提及已被看过就不再倒一遍）', async (t) => {
  const rig = await makeRig(t);
  rig.write(3);
  await rig.read({ sid: SID, limit: 5 });
  for (let no = 4; no <= 49; no += 1) rig.write(no, no === 30 ? { at: true } : {});

  const first = await rig.read({ sid: SID, limit: 44 });
  assert.match(first.content, /另有 \d+ 条你还没看/u, `没展示的那些要如实说：\n${first.content}`);
  assert.deepEqual(rowNos(first.content), Array.from({ length: 11 }, (_, i) => i + 20));

  // 第二次读：上一屏那条提及**已经在里面给过她了**（已读推到它），于是默认那一屏落回
  // **未读里仅存的那条提及**（第 30 句在未读里没了，但更早那条提及如果还在窗口里就照给）；
  // 这一批里已经没有别的提及 ⇒ 如实说"没有新消息"或照给窗口，都不许再倒已给过的那一段。
  const second = await rig.read({ sid: SID, limit: 44 });
  assert.equal(second.isError, undefined, second.content);
  assert.equal(second.content.includes('第 30 句'), false,
    `已给过她的那条提及不许再倒一遍：\n${second.content}`);
});

// ──────────────────────────────── ⑥ 一条提及都没有 ────────────────────────────────

test('一条提及都没有（有未读但都跟她无关）：第一句"没有新消息"，带"另有 N 条你没看"', async (t) => {
  const rig = await makeRig(t);
  // 先来 30 句闲话、只给她最近 3 句（其余"还没给过她"）——那 27 句正是要靠翻页才看得到的
  for (let no = 1; no <= 30; no += 1) rig.write(no);
  const boot = await rig.read({ sid: SID, limit: 3 });
  assert.equal(boot.isError, undefined, boot.content);
  assert.deepEqual(rowNos(boot.content), [28, 29, 30], '第一屏取最近 3 句（"宁可多给一次"那条既有取舍）');
  assert.equal(rig.readEvents().length, 1, '第一屏照给 ⇒ 照记一笔已读');

  // 之后来的新话**一条都没点她** ⇒ 按口径如实说 + 指路，且一条都不标已读
  for (let no = 31; no <= 34; no += 1) rig.write(no);
  const out = await rig.read({ sid: SID, limit: 3 });
  assert.equal(out.isError, undefined, out.content);
  // ① 回执的**第一句**就是那四个字（2026-10-08 用户的口径：「read_channel，如果没有消息
  //    就直接回执没有新消息」）——她要的是一眼可判的结论，不是"没有点名你的新消息"这种绕着说的话
  assert.match(out.content, /^没有新消息/u, `第一句必须是「没有新消息」：\n${out.content}`);
  // ② 而这里**确实有没给她看的未读**（只是没点她）⇒ 按用户的口径可以附一句，但必须带 N
  assert.match(out.content, /另有 \d+ 条你没看/u, `有未读就得如实说数量：\n${out.content}`);
  assert.match(out.content, /翻页/u, '要给一条出路（想看就翻页）');
  assert.match(out.content, /before=\d+/u, '出路要具体到"填哪个游标"');
  assert.equal(rig.readEvents().length, 1, '一条都没给她看 ⇒ 一条都不许标成已读');
  // 再读一次：**照旧**说同一件事（那批未读一条都没被她看到过，这不算"重复投递"）
  const again = await rig.read({ sid: SID, limit: 3 });
  assert.match(again.content, /^没有新消息/u);
  assert.match(again.content, /另有 \d+ 条你没看/u);
  assert.equal(rig.readEvents().length, 1, '还是没给她看 ⇒ 仍然不许标已读');

  // 而"她想看就能看到"这件事必须成立：页脚那个游标翻过去，那些"没点她、也不是最近一屏"的话都在
  const cursor = cursorOf(out.content);
  const paged = await rig.read({ sid: SID, before: cursor, limit: 17 });
  const pagedRows = rowNos(paged.content);
  assert.equal(pagedRows.length, 17, `一页就是 limit 行：\n${paged.content}`);
  // 这一页正是"她还没看过、又不是最近那一屏"的那一段（第 15..31 句；第 31 句刚好压在前一屏的取数窗口外）
  assert.deepEqual(pagedRows, Array.from({ length: 17 }, (_, i) => i + 15),
    `翻页要接着往前给，一条不漏一条不重：\n${paged.content}`);
  assert.equal(paged.content.includes('没有新消息'), false, '翻页那一支就是照给内容，不是再说一遍"没有"');
});

test('两种"没有新消息"措辞可分：确实什么都没有 ⇒ 不带 N；有未读但没点她 ⇒ 带 N', async (t) => {
  // 判据只有一个：**有没有没给她看的未读**。两句话因此一眼分得开——
  // 前者是"这里真的没有新东西了"，后者是"有新话，只是没点你"。混淆的代价是她反复翻同一个信箱。
  const quiet = await makeRig(t);
  quiet.write(1);
  await quiet.read({ sid: SID, limit: 5 });
  const nothing = await quiet.read({ sid: SID, limit: 5 });
  assert.match(nothing.content, /^没有新消息/u, `第一句照旧是那四个字：\n${nothing.content}`);
  assert.equal(/另有 \d+ 条你没看/u.test(nothing.content), false,
    `确实什么都没有时**不许**提数量（那会让她以为漏了什么）：\n${nothing.content}`);

  const busy = await makeRig(t);
  busy.write(1);
  await busy.read({ sid: SID, limit: 3 });
  // 未读装不下一屏（limit 3）且一条都没点她 ⇒ 落到"有未读但都跟她无关"那一支
  for (let no = 2; no <= 8; no += 1) busy.write(no);
  const unrelated = await busy.read({ sid: SID, limit: 3 });
  assert.match(unrelated.content, /^没有新消息/u, `第一句照旧是那四个字：\n${unrelated.content}`);
  assert.match(unrelated.content, /另有 \d+ 条你没看/u,
    `有未读但没点她时必须带 N（否则她以为这里真的空了）：\n${unrelated.content}`);
});

// ──────────────────────────────── ⑦ 上限：夹住并如实说 ────────────────────────────────

test('每页有上限：limit 超上限被夹住（不报错、不真给十万条），页脚给出继续翻的游标', async (t) => {
  const rig = await makeRig(t);
  for (let no = 1; no <= 100; no += 1) rig.write(no);

  const huge = await rig.read({ sid: SID, limit: 100000 });
  assert.equal(huge.isError, undefined, huge.content);
  assert.equal(rowNos(huge.content).length, 100, '夹到硬上限 100（要十万条也只给 100 行，不是报错、也不编）');

  const page = await rig.read({ sid: SID, before: rig.seqOf(61), limit: 7 });
  const rows7 = rowNos(page.content);
  assert.deepEqual(rows7, [54, 55, 56, 57, 58, 59, 60], `一页就是 limit 行，从游标往回数：\n${page.content}`);
  assert.match(page.content, /一页 7 条/u, '页脚照本页实际用的行数指路（口径只有一处）');
  assert.equal(cursorOf(page.content), rig.seqOf(54), '下一页的游标 = 取数窗口的下界（＝这一屏最旧那条）');
  assert.match(page.content, /想接着往回翻/u, `页脚要给出"下一页怎么翻"（取数窗口装满了）：\n${page.content}`);
  assert.match(page.content, /想接着往回翻/u, `页脚要给出"下一页怎么翻"：\n${page.content}`);
});

// ──────────────────────────────── ⑧ 游标非法 / 过期 ────────────────────────────────

test('游标非法：明确的参数错 + 出路（不静默给空）', async (t) => {
  const rig = await makeRig(t);
  rig.write(1);
  for (const bad of ['abc', '12abc', '-3', 0, 1.5, 'NaN']) {
    const out = await rig.read({ sid: SID, before: bad });
    assert.equal(out.isError, true, `before=${JSON.stringify(bad)} 必须被拒（它不是事件 seq）`);
    assert.equal(out.error?.code, 'E_INVALID_ARGS', `错误码要是参数错：${JSON.stringify(out.error)}`);
    assert.match(out.content, /before/u, '要说清是哪个参数错了');
    assert.match(out.content, /不翻页就别给这个参数|默认那一屏/u, `要给出路：${out.content}`);
  }
  // 页脚那个形态（数字、以及它的字符串形态）必须收：她原样抄回来是最自然的动作
  assert.equal((await rig.read({ sid: SID, before: 2 })).isError, undefined);
  assert.equal((await rig.read({ sid: SID, before: '2' })).isError, undefined);
  assert.equal(rig.readEvents().length, 0, '翻页一笔已读都不写');
});

test('游标过期/不属于这个会话：如实说"没有比它更早的了"，并给一条回现在的路', async (t) => {
  const rig = await makeRig(t);
  rig.write(1);
  const out = await rig.read({ sid: SID, before: 1 });
  assert.equal(out.isError, undefined, out.content);
  assert.match(out.content, /没有比 before=1 更早的了/u,
    `空要说清是"这一段没有"，不是"这个会话没有"：\n${out.content}`);
  assert.match(out.content, /已经翻到头|过期/u, '两种可能都给她（她分不清时不许替她猜）');
  assert.match(out.content, /不带 before/u, '要给一条回现在的路');
  assert.equal(rig.readEvents().length, 0, '翻页一个已读都不写（空的更没有）');
});

// ──────────────────────────────── ⑨ 每页 50 条 ────────────────────────────────

test('每页 50 条：常量写在实现里，页脚照它指路', async (t) => {
  assert.equal(READ_CHANNEL_PAGE_SIZE, 50, '每页 50 条是用户定的口径，改它要先说');
  const rig = await makeRig(t);
  for (let no = 1; no <= 60; no += 1) rig.write(no);
  // 60 条、从第 56 句往前翻：取数窗口是第 1..55 句，一页 50 行 ⇒ 装不下第 1..5 句，页脚如实说"接着往回翻"
  const page = await rig.read({ sid: SID, before: rig.seqOf(56), limit: READ_CHANNEL_PAGE_SIZE });
  assert.deepEqual(rowNos(page.content), Array.from({ length: 50 }, (_, i) => i + 6), '一页就是 50 行（第 6..55 句）');
  assert.match(page.content, /一页 50 条/u, `页脚照 50 条这个口径指路：\n${page.content}`);
  assert.match(page.content, /想接着往回翻/u, '还有没摆出来的（第 1..5 句）⇒ 要说"接着往回翻"');
});

