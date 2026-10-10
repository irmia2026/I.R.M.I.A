/**
 * read_channel 里的**她自己**（2026-10-04 用户的要求）
 * ——src/tools/admin.ts 与 src/runtime/real-loop.ts 的这条新链路
 *
 * 用户原话：「read channel 返回的结果里应该包含 bot 自己的 speak，不过不切分节省行数。
 * 方便 agent 理解自己已做的回答」。
 *
 * 三件事必须同时成立，缺一条这条能力就是错的：
 *   ① **她在那个会话说过的话真的出现在结果里**（行首 `（我）`），并按时间轴与外部消息交错；
 *   ② **不切分**：一次 speak 被 `chat-split` 切成 N 条气泡，在 read_channel 里只占**一行**、
 *      内容是发出去的整段文本——行数是这个工具的硬预算（她读一次群就吃一次上下文）；
 *   ③ **只算真发出去的那些**：投递失败 / 被拒 / 根本没接线时不算"她说过"，
 *      否则她会以为自己答过了，而群里其实一个字都没有（本仓库最贵的一类错）。
 *
 * 另外锁住 limit 的口径：这一屏的行数上限**包含她的行**（时间轴只有一条，她的行不占行就没法
 * 交错着读），但又保证"她说得多"不会把外部消息挤没——上限本身就是那道闸。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createAdminTools,
  deliveredToSid,
  mergeChannelSpeech,
  SELF_SPEAK_LABEL,
  SENT_CREDENTIAL_NOTE,
  type ChannelMessageView,
  type ChannelReader,
  type ChannelSpoken,
  type ReplyOutcome,
  type ReplyTarget,
} from '../src/tools/admin.ts';
import { setSleepForTest } from '../src/tools/admin.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import type { ToolContext } from '../src/tools/types.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const CTX: ToolContext = {
  callId: 'call_read',
  turn: 3,
  step: 1,
  signal: new AbortController().signal,
  workspaceRoot: process.cwd(),
};

/** 一条外部消息（只填断言用到的字段；sid 跟着 chatId 走，免得手写错一个就验错东西） */
function message(patch: Partial<ChannelMessageView> & { chatId: string }): ChannelMessageView {
  const chatType = patch.chatType ?? 'group';
  return {
    sid: `qq:${chatType}:${patch.chatId}`,
    channel: 'qq-official',
    chatType,
    person: 'OPENID_A',
    text: '你好',
    messageId: `m-${patch.chatId}`,
    msgSeq: 1,
    ts: '2026-10-03T09:00:00.000Z',
    ...patch,
  };
}

/** 她说出去的一段话（投递回执归并出来的那个形状） */
function spoken(patch: Partial<ChannelSpoken> = {}): ChannelSpoken {
  const ts = patch.ts ?? '2026-10-03T09:05:00.000Z';
  return {
    text: '在的',
    ts,
    parts: 1,
    seq: 100,
    atMs: Date.parse(ts),
    ...patch,
  };
}

interface Recorder {
  events: Array<{ type: string; data: unknown }>;
  emit: (type: string, data: unknown) => void;
  last(type: string): Record<string, unknown> | undefined;
  all(type: string): Array<Record<string, unknown>>;
  count(type: string): number;
}

function recorder(): Recorder {
  const events: Array<{ type: string; data: unknown }> = [];
  return {
    events,
    emit: (type, data) => { events.push({ type, data }); },
    last: (type) => [...events].reverse().find((e) => e.type === type)?.data as Record<string, unknown> | undefined,
    all: (type) => events.filter((e) => e.type === type).map((e) => e.data as Record<string, unknown>),
    count: (type) => events.filter((e) => e.type === type).length,
  };
}

function toolkit(
  reader: ChannelReader | null,
  rec: Recorder,
  options: { spoken?: readonly ChannelSpoken[]; timezone?: string } = {},
) {
  return createAdminTools({
    timers: new TimerStore(null),
    emit: rec.emit as never,
    ...(reader === null ? {} : { channelReader: reader }),
    ...(options.spoken === undefined ? {} : { channelSpokenReader: async () => options.spoken! }),
    ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
  });
}

// ──────────────────────────────── ① 合批：不切分、交错、limit 口径 ────────────────────────────────

describe('read_channel · 她自己说过的话', () => {
  test('一次 speak 切成几条气泡 → 读回来**只有一行**，内容是发出去的整段', () => {
    // 实测形状（2026-10-03 那个群）：151 字被切成 13 条气泡发出去。若读回来也占 13 行，
    // 她翻开信箱看到的全是自己刚说的话——行数才是这个工具的预算。
    const bubbles = ['当 P 沿 C 无限远离原点时', 'P 到定直线 L 的距离趋于 0', 'L 就叫 C 的渐近线'];
    const batch = mergeChannelSpeech(
      [message({ chatId: 'G1', text: '解释一下什么是渐近线', msgSeq: 7, ts: '2026-10-03T09:04:00.000Z' })],
      [spoken({ text: bubbles.join(''), parts: bubbles.length, ts: '2026-10-03T09:05:00.000Z', seq: 900 })],
      20,
    );
    assert.equal(batch.length, 2, '一条外部消息 + 她的一次发言 = 两行（不是四行）');
    assert.equal(batch[1]!.text, bubbles.join(''), '内容是发出去的那一整段，一个字不少');
  });

  test('她的行与外部消息**按时间轴交错**，行首标记占"谁"那一格', async () => {
    const rec = recorder();
    const reader: ChannelReader = async () => [
      message({ chatId: 'G1', person: '张三', text: '在吗', msgSeq: 1, ts: '2026-10-03T09:01:00.000Z' }),
      message({ chatId: 'G1', person: '李四', text: '她刚才答过了', msgSeq: 2, ts: '2026-10-03T09:06:00.000Z' }),
    ];
    const tk = toolkit(reader, rec, {
      timezone: 'UTC',
      spoken: [spoken({ text: '在的', ts: '2026-10-03T09:05:00.000Z', seq: 500 })],
    });
    const result = await tk.byName('read_channel').handler({ sid: 'qq:group:G1', limit: 20 }, CTX);

    const rows = result.content.split('\n').filter((line) => /^\d\d-\d\d \d\d:\d\d /u.test(line));
    assert.deepEqual(
      rows.map((line) => line.replace(/^\d\d-\d\d \d\d:\d\d /u, '')),
      ['张三：在吗', `${SELF_SPEAK_LABEL}：在的`, '李四：她刚才答过了'],
      `她的发言要按时间插在中间（不是附在最后）：\n${result.content}`,
    );
  });

  test('标记是 `（我）`：不是发言人昵称的样子，也不会被当成某个群友', async () => {
    // 用户自己叫"用户（OWNER）"，群友的群名片什么都能改——标记必须只由"这是她"决定。
    assert.equal(SELF_SPEAK_LABEL, '（我）');
    const rec = recorder();
    const tk = toolkit(
      async () => [message({ chatId: 'G1', ts: '2026-10-03T09:01:00.000Z' })],
      rec,
      { timezone: 'UTC', spoken: [spoken({ text: '我说过这句' })] },
    );
    const text = (await tk.byName('read_channel').handler({ sid: 'qq:group:G1' }, CTX)).content;
    assert.match(text, /（我）：我说过这句/u, `她的行要带标记：${text}`);
    // 标记不许出现在"谁"以外的地方（她自己的正文里可以有任何字，这里只查行首那一格）
    assert.equal(/^\d\d-\d\d \d\d:\d\d 我：/mu.test(text), false, '不许写成没有括号的"我："（那会被读成昵称）');
  });

  test('limit 数的是**整屏行数**：她的行也算，且她的行挤不掉全部外部消息', async () => {
    const rec = recorder();
    // 20 条外部消息（每 2 分钟一条，09:00–09:38）+ 她自己 3 次发言（奇数分钟），交错着来
    const externals = Array.from({ length: 20 }, (_, i) => message({
      chatId: 'G1', person: '张三', text: `外部第 ${i + 1} 条`, msgSeq: i + 1,
      ts: `2026-10-03T09:${String(i * 2).padStart(2, '0')}:00.000Z`,
    }));
    const spokenByHer = [11, 21, 31].map((minute) => spoken({
      text: `我说的第 ${minute} 分钟那句`, parts: 4,
      ts: `2026-10-03T09:${String(minute).padStart(2, '0')}:30.000Z`, seq: 1000 + minute,
    }));
    const tk = toolkit(
      async (sid, limit) => externals.slice(-limit),
      rec,
      { timezone: 'UTC', spoken: spokenByHer },
    );
    const result = await tk.byName('read_channel').handler({ sid: 'qq:group:G1', limit: 12 }, CTX);

    const rows = result.content.split('\n').filter((line) => /^\d\d-\d\d \d\d:\d\d /u.test(line));
    assert.equal(rows.length, 12, `一屏就是 limit 行（她的行也占）：\n${result.content}`);
    // 最近 12 件 = 外部第 11–20 条（09:20–09:38）+ 她最后两次发言（09:21:30 / 09:31:30）
    // ——她自己取回的窗口是 **12 条外部消息**，她的行插进来之后整屏仍压回 12 行，
    // 于是最早那一次发言（09:11:30）与外部第 9–10 条一起被挤出去了。这正是 limit 的既有语义。
    assert.equal(rows.filter((line) => line.includes(SELF_SPEAK_LABEL)).length, 2,
      `4 条气泡不占 4 行：\n${result.content}`);
    // 上限即那道闸：一屏 12 行不可能被她挤成 0 行外部消息（挤掉的是**更早的**件，
    // 与"limit 只取最近若干件"是同一件事——这正是用户要的"这段时间里发生了什么"）
    assert.equal(rows.filter((line) => !line.includes(SELF_SPEAK_LABEL)).length, 10);
    // 交错：她在最后一刻之前还在说话 → 最后一行是外部消息，而她的行夹在中间
    assert.equal(rows[0]!.includes(SELF_SPEAK_LABEL), false, `她的行被按时间插在中间：\n${result.content}`);
    assert.equal(rows[rows.length - 1]!.includes(SELF_SPEAK_LABEL), false);
    assert.ok(rows.findIndex((line) => line.includes(SELF_SPEAK_LABEL)) < rows.length - 1,
      '她的行不在末尾堆着（与外部消息按时间交错）');
  });

  test('窗口窄到只剩她的发言时：她的行挤不掉"更早的"外部消息（limit 是这一屏的总行数）', async () => {
    // 这条锁的是用户担心的那个反向失效：**她的发言不会把外部消息挤没**。
    // 判据不是"每屏都保证有外部消息"（她说得比谁都晚时，最近 N 件本来就都是她说的），
    // 而是"一屏就是 limit 件、不会因为她说得多而变长"——时间轴上谁在前谁留下。
    const rec = recorder();
    const externals = [message({
      chatId: 'G1', person: '张三', text: '很久以前那句', msgSeq: 1, ts: '2026-10-03T08:00:00.000Z',
    })];
    const spokenByHer = [10, 11, 12, 13, 14].map((minute) => spoken({
      text: `第 ${minute} 分钟那句`, ts: `2026-10-03T09:${minute}:00.000Z`, seq: 2000 + minute,
    }));
    const tk = toolkit(async () => externals, rec, { timezone: 'UTC', spoken: spokenByHer });
    const result = await tk.byName('read_channel').handler({ sid: 'qq:group:G1', limit: 3 }, CTX);

    const rows = result.content.split('\n').filter((line) => /^\d\d-\d\d \d\d:\d\d /u.test(line));
    assert.equal(rows.length, 3, `一屏 3 行，不会因为她连说五句变成 6 行：\n${result.content}`);
    assert.deepEqual(rows.map((line) => line.slice(12)), ['（我）：第 12 分钟那句', '（我）：第 13 分钟那句', '（我）：第 14 分钟那句']);
    // 想看更早的（含那条外部消息）就把 limit 调大——这跟 limit 既有语义一致
    const wider = await toolkit(async () => externals, recorder(), { timezone: 'UTC', spoken: spokenByHer })
      .byName('read_channel').handler({ sid: 'qq:group:G1', limit: 20 }, CTX);
    assert.ok(wider.content.includes('很久以前那句'), `调大就能看到更早的：${wider.content}`);
  });

  test('宿主没接"她说过什么"的口时照常可用（不假装她没说过，只是读不到）', async () => {
    const rec = recorder();
    const tk = toolkit(async () => [message({ chatId: 'G1' })], rec, { timezone: 'UTC' });
    const result = await tk.byName('read_channel').handler({ sid: 'qq:group:G1' }, CTX);
    assert.equal(result.isError, undefined, result.content);
    assert.equal(result.content.includes(SELF_SPEAK_LABEL), false);
    assert.match(result.content, /张三|…|OPENID|你好/u, '外部消息照旧');
  });

  test('头一行报清"这一屏几行、其中你自己的几行"', async () => {
    const rec = recorder();
    const tk = toolkit(
      async () => [message({ chatId: 'G1', ts: '2026-10-03T09:01:00.000Z' })],
      rec,
      { timezone: 'UTC', spoken: [spoken(), spoken({ ts: '2026-10-03T09:06:00.000Z', seq: 600 })] },
    );
    const text = (await tk.byName('read_channel').handler({ sid: 'qq:group:G1' }, CTX)).content;
    assert.match(text, /最近 3 条，其中你自己的发言 2 行/u, `要报清成分：${text.split('\n')[0]}`);
  });

  test('框仍是那一批的框，`count=` 跟她要的行数对得上', async () => {
    const rec = recorder();
    const tk = toolkit(
      async () => [message({ chatId: 'G1', ts: '2026-10-03T09:01:00.000Z' })],
      rec,
      { timezone: 'UTC', spoken: [spoken()] },
    );
    const text = (await tk.byName('read_channel').handler({ sid: 'qq:group:G1' }, CTX)).content;
    assert.equal(text.split('[external_event').length - 1, 1, '整批还是一个框');
    assert.equal(text.split('[/external_event]').length - 1, 1, '框要闭合');
    assert.match(text, /\[external_event source=qq-official chat=群聊 count=2\]/u, `框头与既有形状同源：${text}`);
    // 她的行在框**内**：这一批是"这个会话里发生过什么"，时间轴只有一条
    const mineAt = text.indexOf(SELF_SPEAK_LABEL);
    assert.ok(mineAt > text.indexOf('[external_event'), '她的行在框内');
    assert.ok(mineAt < text.indexOf('[/external_event]'), '她的行在框闭之前');
  });

  test('她的多行正文被压成一行（换行会破坏"一行一条"这个预算结构）', async () => {
    const rec = recorder();
    const tk = toolkit(
      async () => [message({ chatId: 'G1', ts: '2026-10-03T09:01:00.000Z' })],
      rec,
      { timezone: 'UTC', spoken: [spoken({ text: '第一行\n第二行\r\n第三行' })] },
    );
    const text = (await tk.byName('read_channel').handler({ sid: 'qq:group:G1' }, CTX)).content;
    const rows = text.split('\n').filter((line) => line.includes(SELF_SPEAK_LABEL));
    assert.equal(rows.length, 1, `换行必须压掉：\n${text}`);
    assert.match(rows[0]!, /第一行 第二行 第三行/u);
  });
});

// ──────────────────────────────── ② 投递回执：只有发出去的才算 ────────────────────────────────

describe('speak · 投递回执里带上"她说了什么"', () => {
  /** 只接线三路里必要的那两路（回投实现由用例给） */
  function speakToolkit(
    rec: Recorder,
    poster: (target: ReplyTarget, text: string) => Promise<ReplyOutcome>,
    target: ReplyTarget | null = { url: 'qq:group:G1', idempotencyKey: 'turn-3' },
  ) {
    return createAdminTools({
      timers: new TimerStore(null),
      emit: rec.emit as never,
      replyTargetOf: () => target,
      replyPoster: { post: poster },
    });
  }

  test('整段发出去 → 回执带完整文本与气泡数（切分是投递的属性，内容仍是一整段）', async (t) => {
    const rec = recorder();
    const posted: string[] = [];
    setSleepForTest(async () => {});
    t.after(() => { setSleepForTest(null); });
    const tk = speakToolkit(rec, async (_target, text) => { posted.push(text); return { ok: true, status: 200 }; });

    const spoken = '长任务跑完了，共 42 个文件。';
    const result = await tk.byName('speak').handler({ text: spoken }, CTX);
    assert.equal(result.isError, undefined, result.content);
    assert.ok(posted.length > 1, '这段话本来就该被切成多条气泡（否则这条用例没测到东西）');

    const receipts = rec.all('speak/sent').filter((data) => data['channel'] === 'reply-url');
    assert.equal(receipts.length, 1, '一次发言只有一条"IM 那一路走通了"的回执');
    const receipt = receipts[0]!;
    assert.equal(receipt['sid'], 'qq:group:G1', 'sid = 发给哪个会话（read_channel 靠它归位）');
    assert.equal(receipt['text'], '长任务跑完了共 42 个文件', '整段文本；句末标点被切分摘掉了，这是发出去的原样');
    assert.equal(receipt['spokenParts'], posted.length, '气泡数要与真发出去的条数一致');
    assert.equal(receipt['callId'], 'call_read', 'callId = 哪一次工具调用（read_channel 按它把一次 speak 归成一行）');
    assert.equal(receipt['turn'], 3, 'turn 号：复盘用，也兜住旧事件没有 callId 的情形');
  });

  test('投递失败 → **不算她说过**（没有那条回执，read_channel 里也就没有这一句）', async () => {
    const rec = recorder();
    const tk = speakToolkit(rec, async () => ({ ok: false, reason: '回投被拒：HTTP 403' }));
    const result = await tk.byName('speak').handler({ text: '你好' }, CTX);
    assert.equal(result.isError, undefined, result.content);
    assert.match(result.content, /投递失败/u);
    assert.equal(rec.all('speak/sent').some((data) => data['text'] !== undefined), false,
      '没发出去就没有带文本的回执——否则她会以为自己答过了，而群里一个字都没有');
  });

  test('这一轮没有 IM 会话可发 → 同样不写"她说过"（只落本机对话流那条）', async () => {
    const rec = recorder();
    const tk = speakToolkit(rec, async () => ({ ok: true, status: 200 }), null);
    const result = await tk.byName('speak').handler({ text: '你好' }, CTX);
    assert.match(result.content, /没有 IM 会话可发/u);
    const channels = rec.all('speak/sent').map((data) => data['channel']);
    assert.deepEqual(channels, ['log'], '只有本机对话流那一路（它不代表话到了那个会话）');
    assert.equal(rec.all('speak/sent').some((data) => data['text'] !== undefined), false);
  });

  test('中途被打断：只记**已经吐出去**的那几条，一个字都不多记', async (t) => {
    const rec = recorder();
    const posted: string[] = [];
    // 等待本身换成立即返回（用例不花那几十秒），但**插话基准照给**——判"有没有被打断"的是
    // 那个计数，不是等待本身（`ctx.interruptEpoch` 给了，speak 才会在每段之间回头看一眼）。
    setSleepForTest(async () => {});
    t.after(() => { setSleepForTest(null); });
    // 第二段发出去之后"人又开口了"：第三段起不再发（与 speak 的插话语义一致）
    let epoch = 0;
    const tk = createAdminTools({
      timers: new TimerStore(null),
      emit: rec.emit as never,
      replyTargetOf: () => ({ url: 'qq:group:G1', idempotencyKey: 'turn-3' }),
      replyPoster: {
        post: async (_target, text) => {
          posted.push(text);
          if (posted.length === 2) epoch = 1;
          return { ok: true, status: 200 };
        },
      },
      userSpoke: () => (epoch === 1 ? { text: '等一下', wakeSeq: 77 } : null),
    });
    const ctx: ToolContext = { ...CTX, interruptEpoch: () => epoch };

    const result = await tk.byName('speak').handler({ text: '第一句在这里，第二句在这里，第三句在这里。' }, ctx);
    assert.match(result.content, /发言被打断/u, result.content);
    assert.equal(posted.length, 2, '第二段之后被打断（否则这条用例没测到打断）');

    const receipts = rec.all('speak/sent').filter((data) => data['channel'] === 'reply-url');
    assert.equal(receipts.length, 1, '打断也要留下"说出去过什么"的凭据（那几条收不回来）');
    assert.equal(receipts[0]!['text'], posted.join(''), '只记送成的那些');
    assert.equal(receipts[0]!['spokenParts'], 2);
  });
});

// ──────────────────────────────── ②bis report · 与 speak 同一条凭据判据（2026-10-07） ────────────────
//
// 用户报的现象：「report 貌似不进 channel？她老是不知道自己的 report 已经发出去了导致重复发」。
// 根因：`report` 的正文出站**落了 `speak/sent`，但没带 `text`**；而 `readChannelSpoken` 的判据是
// "reply-url + 带文本"（没有文本就回答不了"她说过什么"）⇒ 她 report 完翻会话，自己那一篇不在。
// 修法是把判据收成一处（`deliverToSession` / `deliveredToSid`），下面几条锁的就是那一处。

describe('report · 与 speak 同一条"发出去过"的凭据', () => {
  /** 只接线投递那一路（`to` 直接给到会话，不依赖唤醒） */
  function reportToolkit(
    rec: Recorder,
    poster: (target: ReplyTarget, text: string) => Promise<ReplyOutcome>,
    target: ReplyTarget | null = { url: 'qq:group:G1', idempotencyKey: 'turn-3' },
  ) {
    return createAdminTools({
      timers: new TimerStore(null),
      emit: rec.emit as never,
      replyTargetOf: () => target,
      replyPoster: { post: poster },
    });
  }

  const REPORT = '# 汇报\n\n- 42 个文件全过\n- 3 个在排队';

  test('带 to 成功 → 凭据带 sid + **完整正文** + callId/turn（与 speak 同一种形状）', async (t) => {
    const rec = recorder();
    const posted: string[] = [];
    const tk = reportToolkit(rec, async (_t, text) => { posted.push(text); return { ok: true, status: 200 }; });
    const result = await tk.byName('report').handler({ text: REPORT, to: 'qq:group:G1' }, CTX);
    assert.equal(result.isError, undefined, result.content);

    assert.equal(posted.length, 1, 'report 不切分：整篇一次出站');
    assert.equal(posted[0], REPORT, '进请求体的就是正文原文（Markdown 原样）');

    const receipts = rec.all('speak/sent').filter((data) => data['channel'] === 'reply-url');
    assert.equal(receipts.length, 1, '一次 report 只有一条"这一跳走通了"的凭据');
    const receipt = receipts[0]!;
    assert.equal(receipt['sid'], 'qq:group:G1', 'sid = 发到哪个会话（read_channel 靠它归位）');
    assert.equal(receipt['text'], REPORT,
      '**这一条是本次修复的要害**：没有 text，read_channel 的"我说过什么"就认不出它');
    assert.equal(receipt['spokenParts'], 1, 'report 不切分：一条就是一条');
    assert.equal(receipt['callId'], 'call_read', '与 speak 同源：read_channel 按 callId 归并');
    assert.equal(receipt['turn'], 3);
    // 判据是同一个实现：把这条凭据喂回消费侧，它必须给出同一个 sid
    assert.equal(deliveredToSid(receipt as never), 'qq:group:G1',
      '产生侧与消费侧必须认同一个判据（这条断言就是"收成一处"的锁）');
  });

  test('投递失败 → **不落**成功凭据（失败就不算"她报告过"）', async (t) => {
    const rec = recorder();
    const tk = reportToolkit(rec, async () => ({ ok: false, reason: '回投被拒：HTTP 403 主动消息无权限' }));
    const result = await tk.byName('report').handler({ text: REPORT, to: 'qq:group:G1' }, CTX);
    assert.equal(result.isError, undefined, result.content);
    assert.match(result.content, /失败/u, result.content);
    assert.match(result.content, /403/u, '原因要如实写出来（她据此换个方式再试）');
    assert.equal(result.content.includes('不必重复发送'), false, '没送达就不许给她"发出去了"的判据');
    // 失败那一侧要给"还要不要试"的判断（2026-10-08 用户的口径：与"成功"明确区分，别含糊）
    assert.match(result.content, /不必重试|可稍后再试/u, `失败回执要给出重试判断：${result.content}`);

    assert.equal(rec.all('speak/sent').some((data) => deliveredToSid(data as never) !== null), false,
      '没有带 sid+text 的凭据——否则下一轮 read_channel 里会凭空多出一行"我说过"');
    // 本机对话流那条照旧（那是她与人的记录，不是"到了那个会话"）
    assert.deepEqual(rec.all('speak/sent').map((data) => data['channel']), ['log']);
  });

  test('这一轮没有可发会话 → 只落本机那条，且回执说清"下一轮看不到这一篇"', async (t) => {
    const rec = recorder();
    const tk = reportToolkit(rec, async () => ({ ok: true, status: 200 }), null);
    const result = await tk.byName('report').handler({ text: REPORT }, CTX);
    assert.match(result.content, /没有 IM 会话可发/u, result.content);
    assert.match(result.content, /不会看到这一篇/u, `没有会话坐标时必须说清她下一轮会看到什么：${result.content}`);
    assert.deepEqual(rec.all('speak/sent').map((data) => data['channel']), ['log'],
      '只有本机对话流那一条（它不代表报告到了那边）');
    assert.equal(rec.all('speak/sent').some((data) => deliveredToSid(data as never) !== null), false);
  });

  test('`deliveredToSid` 的三个条件逐条判死（判据只有这一处）', () => {
    // 认：真的送到某个会话、且带文本
    assert.equal(deliveredToSid({ channel: 'reply-url', chars: 3, sid: 'qq:group:G1', text: '在' }), 'qq:group:G1');
    // 不认：本机对话流 / 告警出口（都不代表话到了那个会话）
    assert.equal(deliveredToSid({ channel: 'log', chars: 3, sid: 'qq:group:G1', text: '在' }), null);
    assert.equal(deliveredToSid({ channel: 'notify', chars: 3, text: '在' }), null);
    // 不认：没有文本（旧日志里只有 sid 的那些回执——读不回来是"日志只增不改"的必然）
    assert.equal(deliveredToSid({ channel: 'reply-url', chars: 3, sid: 'qq:group:G1' }), null);
    assert.equal(deliveredToSid({ channel: 'reply-url', chars: 0, sid: 'qq:group:G1', text: '' }), null);
    // 不认：没有会话坐标（归不到任何一个会话）
    assert.equal(deliveredToSid({ channel: 'reply-url', chars: 3, text: '在' }), null);
  });

  test('回执里那句判据与 speak **逐字同一句**（她据它决定要不要再说一遍）', async (t) => {
    const rec = recorder();
    setSleepForTest(async () => {});
    t.after(() => { setSleepForTest(null); });
    const reportOut = (await reportToolkit(rec, async () => ({ ok: true, status: 200 }))
      .byName('report').handler({ text: REPORT, to: 'qq:group:G1' }, CTX)).content;
    const speakOut = (await reportToolkit(rec, async () => ({ ok: true, status: 200 }))
      .byName('speak').handler({ text: '在的' }, CTX)).content;
    assert.ok(reportOut.includes(SENT_CREDENTIAL_NOTE), `report 回执缺判据：${reportOut}`);
    assert.ok(speakOut.includes(SENT_CREDENTIAL_NOTE), `speak 回执缺判据：${speakOut}`);
  });
});

// ──────────────────────────────── ③ 描述：她只能靠它理解工具 ────────────────────────────────

test('工具描述里写明了"也会列出你自己说过的话"（她看不到实现）', () => {
  const tk = toolkit(null, recorder());
  const description = tk.byName('read_channel').description;
  // 2026-10-08 把这半句压短了（描述是每轮常驻开销，同一批里 timer 那边还多了一个动作要付）：
  // 判据没变——她必须从描述里知道**自己的发言也在里面**，以及怎么认那一行。
  assert.match(description, /也包括你自己说过的/u, `她只能靠描述理解这条能力：${description}`);
  assert.match(description, /（我）/u, '要告诉她怎么认那一行');
  const limit = tk.byName('read_channel').parameters.properties['limit'] as { description: string };
  assert.match(limit.description, /也占行/u, 'limit 的口径变了，描述必须跟着变（她据此决定要几行）');
});
