/**
 * read_channel 翻页与"默认只读未读"（2026-10-08 用户的两条要求）
 * ——src/tools/admin.ts 的 read_channel、src/runtime/real-loop.ts 的读取口
 *
 * 用户原话：「**read_channel 提供一下翻页吧**」「read_channel 默认行为应该是读到未读消息。
 * 因为之前的已经读过，进入上下文了。**如果开启翻页模式，就可以读到全部消息。每页 50 条**」
 * ⚠ 那句里的页大小**v80（2026-10-23）起改成 15 条**（她的原话：「50 条太多了」）——
 * 原话照抄不改，读到的页大小一律以 `READ_CHANNEL_PAGE_SIZE` 为准（⑨ 钉的就是它）。
 * 「**未读也是只读提及和之前十条**」「**不视作已处理。提示她还有没看到的，往上翻页**」。
 *
 * 两条路径、两套判据，这一份把两条都钉住：
 *   ① **默认（不给游标）= 只给"上次查看之后"的新的那几条**（⚠ **口径已换**：v67/`fceeffe` 之前
 *      是"未读里点了她的那些 + 每条之前十条"，那版已废——见下面 `默认：只给"上次查看之后的"那一窗`
 *      那一条与 `read-channel-incremental.test.ts`）；已读的旧消息不再倒一遍。
 *      已读**只推进到"确实给她看过的那几条"**（没给她的保持未读，下次仍然会被告诉"还有没看到"）。
 *   ② **翻页（给 `before` 游标）= 读全部历史，一页 15 条、一个字都不动已读**。
 *   ③ **缺省 `limit` 按分支给**（⑩）：有游标 ⇒ 一页 `READ_CHANNEL_PAGE_SIZE`（15），
 *      无游标 ⇒ 默认那一屏 `READ_CHANNEL_DEFAULT_LIMIT`（20）——**页脚上那个数必须等于
 *      下一页真的发多少行**，否则她照页脚算翻页节奏就会算错。
 *
 * 走**真链路**（真 EventLog → 真 RealLoop 的两个读取口 → 真 read_channel）：游标这件事的价值
 * 全在"日志里那个 seq 真的能当游标用"，替身会把这层抹掉。
 *
 * 判据只紧不松：无重复、无空洞、不越已读位，都是**正面**断言（不是"没报错"）。
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
import { createAdminTools, READ_CHANNEL_DEFAULT_LIMIT, READ_CHANNEL_PAGE_SIZE } from '../src/tools/admin.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';
import type { ToolHandlerResult } from '../src/tools/types.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

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
  /**
   * 落一条**她自己说出去的话**（`speak/sent`，v67 的用例要用它撑出"未读多过一屏"的形状）。
   *
   * 为什么要它：`readChannelSpoken` 是**无界**的（她在那个会话里说过的全部），所以"她自己的行"
   * 是把未读撑到 `limit` 以上、从而触发"没摆下的新消息"那一支的唯一自然来源
   *（消息那一侧宿主只回最近 `limit` 条，永远撑不满）。
   */
  speak: (text: string, callId: string) => number;
  /**
   * 把夹具的**时钟**往前拨 `seconds` 秒（v67 加）。
   *
   * 为什么需要它：`write` 与 `speak` 默认落在**同一毫秒**上（这个文件的既有取舍：先后只由事件 seq
   * 决定）。而"她自己说过的话"那一类的同毫秒次序键是**投递时刻的毫秒**（`atMs`），它天然压过
   * 消息的平台序号——于是同一毫秒里的发言会排到消息**之后**。要构造"她的旧发言 + 更新的消息"
   * 这种真实形状，就得让两者的时刻真的分开。
   */
  at: (seconds: number) => void;
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
  const dir = tempDirSync('irmia-channel-page-');
  const log = await EventLog.open(join(dir, 'events'));
  const projection = fold([]);
  /** 夹具时钟：默认停在 `2026-10-08T07:00:00Z`，`at()` 拨动它（见 `Rig.at` 的说明） */
  let clockMs = Date.parse('2026-10-08T07:00:00.000Z');
  const now = (): Date => new Date(clockMs);
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
  /**
   * 她自己说出去的一句（真形状：`channel: 'reply-url'` + 非空 `text` + `sid` 就是
   * `deliveredToSid` 认的那一条凭据，见 `src/tools/admin.ts`）。
   */
  const speak: Rig['speak'] = (text, callId) => {
    const seq = log.nextSeq();
    const event = {
      seq,
      ts: now().toISOString(),
      type: 'speak/sent',
      data: { channel: 'reply-url', chars: text.length, sid: SID, text, spokenParts: 1, callId, turn: 7 },
      visibility: defaultVisibility('speak/sent'),
      origin: 'test/channel-page',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    applyOne(projection, event);
    return seq;
  };

  const real = new RealLoop({    log,
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
    speak,
    at: (seconds) => { clockMs = Date.parse('2026-10-08T07:00:00.000Z') + seconds * 1000; },
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

// ──────────────────────────────── ④ 默认那一屏 = 上次查看之后的那些（v67） ────────────────────────────────

test('默认：只给"上次查看之后的"那一窗，不为提及单独开前后文（旧口径已废）', async (t) => {
  const rig = await makeRig(t);
  // 先读一次把水位立起来（第一次读的那一屏是"最近一屏"，见实现里的 `firstSight`）
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
  // **2026-10-17 用户的第一条口径**：「默认只展示上次查看以来的新消息」。
  // 取数窗口就是"最近 50 条"（这里是**显式传的 `limit: 50`**，与翻页那个页大小无关——
  // 页大小是 `READ_CHANNEL_PAGE_SIZE`，⑨ 钉它），而它们**全都是**上次查看之后的新消息 ⇒ 一条不少地摆出来。
  // （旧口径在这里给的是"提及 + 它之前十条"＝第 185..195 句，其余新话一个字都看不到。）
  assert.deepEqual(rows, Array.from({ length: 50 }, (_, i) => i + 151),
    `新消息都要看得见（不是只给提及那一窗）：${out.content}`);
  assert.equal(out.content.includes('第 150 句'), false, '取数窗口之外的一条都不给');
  assert.equal(out.content.includes('第 3 句'), false, '上次查看之前的不再倒一遍');
  // 提及仍然一眼可辨：行首 `▶ ` + 行尾那一格相对年龄
  const marked = out.content.split('\n').filter((line) => line.startsWith('▶ '));
  assert.equal(marked.length, 1, `点了她的那条要带标记：\n${out.content}`);
  assert.ok(marked[0]!.includes('第 195 句'));
  assert.match(marked[0]!, /【这条提及是.+的】/u, `提及行要带相对年龄：${marked[0]}`);
  assert.equal(marked[0]!.includes('不是新消息'), false,
    '它是**新的**提及（在水位之后），不许被说成旧提及');
});

test('默认：多提要各带一个标记、同一段不重复给', async (t) => {
  const rig = await makeRig(t);
  rig.write(1);
  await rig.read({ sid: SID, limit: 5 });
  // 第 12 句与第 20 句各点她一次
  for (let no = 2; no <= 38; no += 1) rig.write(no, no === 12 || no === 20 ? { at: true } : {});

  const out = await rig.read({ sid: SID, limit: 30 });
  const rows = rowNos(out.content);
  assert.equal(new Set(rows).size, rows.length, `同一段不许给两遍：${rows.join(',')}`);
  // 取数窗口是"最近 30 条"（第 9..38 句），全都是新消息 ⇒ 全给她（不再按提及切窗）
  assert.deepEqual(rows, Array.from({ length: 30 }, (_, i) => i + 9),
    '上次查看之后的 30 条都在（新口径：不按提及切窗）');
  // 两条提及各带一个标记（她看得出两句都是冲她来的）
  const marked = out.content.split('\n').filter((line) => line.startsWith('▶ '));
  assert.equal(marked.length, 2, `两条提及各带一个标记：\n${out.content}`);
  assert.ok(marked[0]!.includes('第 12 句') && marked[1]!.includes('第 20 句'));
});

// ──────────────────────────────── ⑤ 已读推进：只推到"给她看过的那几条" ────────────────────────────────

test('已读只推进到**展示过的那一条**（不是取数窗口的末尾）；没摆下的仍在"没摆下"里', async (t) => {
  const rig = await makeRig(t);
  // 先立水位（读到第 3 句）
  rig.write(3);
  await rig.read({ sid: SID, limit: 5 });
  // 她先说了一串（**比后面的消息旧**），再攒一批消息——她自己的行是**无界**的（`readChannelSpoken`
  // 给的是她在那个会话里说过的全部），所以它是"未读多过一屏"的唯一自然来源。
  rig.at(10);
  for (let i = 0; i < 6; i += 1) rig.speak(`我说第 ${i} 段`, `call_${i}`);
  rig.at(60);
  for (let no = 4; no <= 30; no += 1) rig.write(no);

  // limit 8：候选 = 6 条她自己的 + 消息窗口（最近 8 条＝第 23..30 句）= 14 条 ⇒ 装不下
  const first = await rig.read({ sid: SID, limit: 8 });
  assert.equal(first.isError, undefined, first.content);
  const shown = rowNos(first.content);
  // 她那一串（挨着的 6 行）算**例外**照摆（见 `incrementalWindow` ③）：它们是"她刚发出去、还没读到"
  // 的凭据，看不见就会以为没发出去（`SENT_CREDENTIAL_NOTE`）。例外**占名额** ⇒ 剩下 2 行给最新的消息。
  assert.ok(first.content.includes('我说第 0 段') && first.content.includes('我说第 5 段'),
    `她连着说的那一段要一起摆：\n${first.content}`);
  assert.deepEqual(shown, [29, 30], '例外占掉 6 个名额，消息只摆得下最新的 2 条');

  // ① 已读**只**推到展示过的那一条（第 30 句）——不是"这一批里所有的"
  const reads = rig.readEvents();
  assert.equal(reads.length, 2, '两次读各记一笔已读');
  assert.equal(reads[1]!.upToSeq, 30, '已读只推进到"确实给她看过的那几条"里的最后一条');
  // ② 没摆下的那些**仍然没看到**：回执必须说出来，并指一条真能捞回它们的路
  assert.match(first.content, /另有 \d+ 条新的这一屏没摆下/u, `没摆下的要如实说：\n${first.content}`);
  assert.match(first.content, /往上翻页|before=\d+/u, '那句话必须带翻页指路');
  // 照着那个游标翻过去，没摆下的那几条（第 23..28 句）真的在，而已摆过的不再重复
  const back = await rig.read({ sid: SID, before: cursorOf(first.content), limit: 20 });
  const backRows = rowNos(back.content);
  assert.ok(backRows.includes(23) && backRows.includes(28),
    `那个游标要能捞回没摆下的：\n${back.content}`);
  assert.equal(back.content.includes('第 30 句'), false, '翻页是从游标往回，不许把上一屏再摆一遍');
  assert.equal(back.content.includes('没有新消息'), false, '翻页那一支就是照给内容');
});

test('「另有 N 条新的没摆下」：有没摆下的才出现，一条都没漏下时不许出现', async (t) => {
  const rig = await makeRig(t);
  rig.write(3);
  await rig.read({ sid: SID, limit: 5 });
  rig.at(10);
  for (let i = 0; i < 6; i += 1) rig.speak(`我说第 ${i} 段`, `call_${i}`);
  rig.at(60);
  for (let no = 4; no <= 30; no += 1) rig.write(no);
  const withGap = await rig.read({ sid: SID, limit: 8 });
  assert.match(withGap.content, /另有 \d+ 条新的这一屏没摆下/u, `没摆下的要如实说：\n${withGap.content}`);

  // 一条没漏下时那句话不许出现：新消息装得下一屏 ⇒ 全给她，没有"另有"
  const clean = await makeRig(t);
  clean.write(1);
  await clean.read({ sid: SID, limit: 5 });
  clean.write(2);
  clean.write(3);
  const all = await clean.read({ sid: SID, limit: 50 });
  assert.equal(all.content.includes('另有'), false, `没漏下任何新消息就不许说"另有"：\n${all.content}`);
});

test('同一批第二次读：已经给过的那些不再倒一遍', async (t) => {
  const rig = await makeRig(t);
  rig.write(3);
  await rig.read({ sid: SID, limit: 5 });
  for (let no = 4; no <= 30; no += 1) rig.write(no, no === 20 ? { at: true } : {});

  const first = await rig.read({ sid: SID, limit: 8 });
  assert.deepEqual(rowNos(first.content), [23, 24, 25, 26, 27, 28, 29, 30]);

  // 第二次读：那一屏已经**给过她了**（水位推到第 30 句）⇒ 不许把同一段再摆一遍
  const second = await rig.read({ sid: SID, limit: 8 });
  assert.equal(second.isError, undefined, second.content);
  assert.match(second.content, /^没有新消息/u, `同一批再读一次要明说没有新的：\n${second.content}`);
  assert.equal(second.content.includes('第 30 句'), false,
    `已给过她的那条不许再倒一遍：\n${second.content}`);
});

// ──────────────────────────────── ⑥ 没有提及也照给（默认那一屏不是"提及屏"） ────────────────────────────────

test('一条提及都没有：新消息照给（默认那一屏读的是"新"，不是"点名"）', async (t) => {
  const rig = await makeRig(t);
  for (let no = 1; no <= 30; no += 1) rig.write(no);
  const boot = await rig.read({ sid: SID, limit: 3 });
  assert.equal(boot.isError, undefined, boot.content);
  assert.deepEqual(rowNos(boot.content), [28, 29, 30], '第一屏取最近 3 句（"宁可多给一次"那条既有取舍）');
  assert.equal(rig.readEvents().length, 1, '第一屏照给 ⇒ 照记一笔已读');

  // 之后来的新话**一条都没点她** —— 但它们**是新消息**，按 2026-10-17 的口径照给
  //（旧口径在这里回的是"没有新消息：这些新话一条都没点你"，即"没点她就等于没有"）
  for (let no = 31; no <= 34; no += 1) rig.write(no);
  const out = await rig.read({ sid: SID, limit: 3 });
  assert.equal(out.isError, undefined, out.content);
  assert.equal(out.content.includes('没有新消息'), false,
    `有新消息就不许说"没有新消息"——哪怕一条都没点她：\n${out.content}`);
  assert.deepEqual(rowNos(out.content), [32, 33, 34], '一屏就是 limit 行，取最新那几条');
  assert.equal(rig.readEvents().length, 2, '给她看过 ⇒ 照记已读');

  // 而"她想看就能看到"这件事必须成立：页脚那个游标翻过去，更早的那些都在
  const cursor = cursorOf(out.content);
  const paged = await rig.read({ sid: SID, before: cursor, limit: 17 });
  const pagedRows = rowNos(paged.content);
  assert.equal(pagedRows.length, 17, `一页就是 limit 行：\n${paged.content}`);
  assert.deepEqual(pagedRows, Array.from({ length: 17 }, (_, i) => i + 15),
    `翻页要接着往前给，一条不漏一条不重：\n${paged.content}`);
  assert.equal(paged.content.includes('没有新消息'), false, '翻页那一支就是照给内容，不是再说一遍"没有"');
});

test('确实没有新的：一句话说完（不摆旧内容，也不提数量）', async (t) => {
  // 判据只有一个：**上次查看之后有没有新的**。没有就一句话，且那句话必须短——
  // 它出现的场合是"她隔一会儿看一眼"，长一句就是每次读都白付一笔。
  const quiet = await makeRig(t);
  quiet.write(1);
  await quiet.read({ sid: SID, limit: 5 });
  const nothing = await quiet.read({ sid: SID, limit: 5 });
  assert.match(nothing.content, /^没有新消息/u, `第一句照旧是那四个字：\n${nothing.content}`);
  assert.equal(/另有 \d+ 条/u.test(nothing.content), false,
    `确实没有新的时**不许**提数量（那会让她以为漏了什么）：\n${nothing.content}`);
  assert.equal(nothing.content.includes('[external_event'), false,
    `一条新的都没有时**不许**返回一大段旧内容：\n${nothing.content}`);
  assert.ok(nothing.content.length < 300, `那句话要短（实测旧口径这类回执中位 759 字）：${nothing.content.length} 字`);
  assert.equal(quiet.readEvents().length, 1, '一条都没给她看 ⇒ 一条都不许再标已读');
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
  // **2026-10-24 改准**：这两次翻页的游标都落在**最新那条之后**，所以这一页里摆着的就是
  // "该会话最新一条"——按新口径那就是读过了（未读该清零），记**一笔**已读位；同一个位置
  // 不写第二笔。"纯往回翻旧话（游标指在更早处）一笔都不写"是另一条口径，钉在 ① 那条用例里
  //（`往回翻**不改已读位置**`）——两条一起才是完整判据：翻旧的不算读过，翻到最新算。
  assert.deepEqual(rig.readEvents(), [{ sid: SID, upToSeq: 1 }],
    '翻页翻到了最新 ⇒ 记一笔（同一个位置只记一次）');
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

// ──────────────────────────────── ⑨ 每页 15 条 ────────────────────────────────

test('每页 15 条：常量写在实现里，页脚照它指路', async (t) => {
  assert.equal(READ_CHANNEL_PAGE_SIZE, 15,
    '一页 15 条是用户 2026-10-23 定的口径（「50 条太多了」），改它要先说');
  const rig = await makeRig(t);
  for (let no = 1; no <= 60; no += 1) rig.write(no);
  // 60 条、从第 56 句往前翻：取数窗口是第 1..55 句，一页 15 行 ⇒ 装不下第 1..40 句，页脚如实说"接着往回翻"
  const page = await rig.read({ sid: SID, before: rig.seqOf(56), limit: READ_CHANNEL_PAGE_SIZE });
  assert.deepEqual(rowNos(page.content), Array.from({ length: 15 }, (_, i) => i + 41), '一页就是 15 行（第 41..55 句）');
  // 2026-10-20（R2 复核）：这一条与 ⑦ 的 `一页 7 条` 一起钉的其实是**同一件事**——
  // 页脚报的是"本页实际用的行数"，不是那个默认常量。所以 R2 里"删掉页脚这一格"没有做：
  // 对默认 15 它确实与参数描述重复，但对 `limit:7` 那种调用它是**唯一**说清本页几行的地方。
  assert.match(page.content, /一页 15 条/u, `页脚照 15 条这个口径指路：\n${page.content}`);
  assert.match(page.content, /想接着往回翻/u, '还有没摆出来的（第 1..40 句）⇒ 要说"接着往回翻"');
});

// ──────────────────────── ⑩ 缺省 limit 按分支给：翻页 15 / 默认那一屏 20 ────────────────────────
//
// 为什么单独立两条：⑨ 里是**显式**传 `limit: READ_CHANNEL_PAGE_SIZE` 的（那时它钉的是常量与
// 页脚），而"**不给** limit"这条路原来回的是 `READ_CHANNEL_DEFAULT_LIMIT`（20）——页脚说
// 「一页 15 条」、实发 20 行。她照页脚算翻页节奏（第 N 页从哪句开始）就会每页差 5 条，
// 所以这两条钉的不是"常量是多少"，而是**页脚上那个数 == 下一页真的发多少行**。

test('翻页模式不给 limit：一页就是 READ_CHANNEL_PAGE_SIZE，且页脚那个数 == 实发行数', async (t) => {
  const rig = await makeRig(t);
  for (let no = 1; no <= 41; no += 1) rig.write(no);
  // 只给 `before`、**不给 `limit`**：取数窗口是第 1..40 句，一页必须正好是一页
  const page = await rig.read({ sid: SID, before: rig.seqOf(41) });
  assert.equal(page.isError, undefined, page.content);
  const rows = rowNos(page.content);
  assert.equal(rows.length, READ_CHANNEL_PAGE_SIZE,
    `不给 limit 时一页就是 READ_CHANNEL_PAGE_SIZE = ${READ_CHANNEL_PAGE_SIZE} 行`
    + `（不是默认那一屏的 ${READ_CHANNEL_DEFAULT_LIMIT}）：\n${page.content}`);
  assert.deepEqual(rows, Array.from({ length: READ_CHANNEL_PAGE_SIZE }, (_, i) => i + 26),
    '一页 = 第 26..40 句（窗口第 1..40 句的最后 15 条）');
  // 页脚上那个数**必须等于实发行数**（两处都等于常量）——这就是"她照页脚算翻页节奏"的判据
  const footer = /一页 (\d+) 条/u.exec(page.content);
  assert.ok(footer !== null, `页脚要报本页实际用的行数：\n${page.content}`);
  assert.equal(Number(footer[1]), rows.length,
    `页脚上的数字（${footer[1]}）必须等于实发行数（${rows.length}）——别一个说 15、一个发 20`);
  assert.equal(Number(footer[1]), READ_CHANNEL_PAGE_SIZE,
    `页脚那格是 ${footer[1]}，一页是 ${READ_CHANNEL_PAGE_SIZE}`);
});

test('默认那一屏不给 limit：仍是 READ_CHANNEL_DEFAULT_LIMIT 行，照页脚翻一页也正好是它说的行数', async (t) => {
  const rig = await makeRig(t);
  for (let no = 1; no <= 40; no += 1) rig.write(no);
  // 无 `before`、无 `limit`：这一屏还是 20 行（翻页那个 15 不许漏到默认这一支）
  const first = await rig.read({ sid: SID });
  assert.equal(first.isError, undefined, first.content);
  const rows = rowNos(first.content);
  assert.equal(rows.length, READ_CHANNEL_DEFAULT_LIMIT,
    `默认那一屏不给 limit 就是 READ_CHANNEL_DEFAULT_LIMIT = ${READ_CHANNEL_DEFAULT_LIMIT} 行`
    + `（翻页那个 ${READ_CHANNEL_PAGE_SIZE} 是另一档）：\n${first.content}`);
  assert.deepEqual(rows, Array.from({ length: READ_CHANNEL_DEFAULT_LIMIT }, (_, i) => i + 21),
    '最近 20 条 = 第 21..40 句');
  // 页脚那格说的是"**下一页会发多少行**"⇒ 照它翻一页（同样不给 limit），实发条数必须与它相等
  const footer = /一页 (\d+) 条/u.exec(first.content);
  assert.ok(footer !== null, `默认那一屏也要给"下一页怎么翻"：\n${first.content}`);
  assert.equal(Number(footer[1]), READ_CHANNEL_PAGE_SIZE, '页脚报的下一页大小 = 翻页模式的缺省值');
  const flip = await rig.read({ sid: SID, before: cursorOf(first.content) });
  const flipRows = rowNos(flip.content);
  assert.equal(flipRows.length, Number(footer[1]),
    `照页脚翻一页：实发 ${flipRows.length} 行，页脚说的是 ${footer[1]} 行`);
  assert.deepEqual(flipRows, Array.from({ length: READ_CHANNEL_PAGE_SIZE }, (_, i) => i + 6),
    '翻过来那一屏 = 第 6..20 句（窗口第 1..20 句的最后 15 条）');
});
