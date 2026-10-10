/**
 * 「正在输入」（`msg_type: 6` + `input_notify`）—— 用户 2026-10-11 拍板的那一件
 *
 * 口径：**她每次 speak 真正开口之前**，先给通道发一个"正在输入"状态。四条纪律，逐条有用例：
 *   ① **单聊 speak ⇒ 发一次，且在说话之前**（顺序是语义的一部分：先看到"正在输入"，再看到话）；
 *   ② **群聊 ⇒ 不发**（官方只有单聊接口列了 `msg_type: 6`；群里那条路如实跳过、不是报错）；
 *   ③ **关掉开关 ⇒ 一个请求都不发**（判据在接线层：不装口子）；
 *   ④ **失败/超时 ⇒ speak 照旧成功**（不许把失败传染给她，也不许变慢）。
 *
 * 另外三条容易被漏掉的边界也在里面：一次 speak **至多一次**（不是每段一条）、
 * `msg_id` 照带（有它这条才算被动窗口里的动作）、**不碰 `msg_seq` 计数器**（那个号是被动回复
 * 4 次窗口往下数的凭据——见 `sendInputNotify` 那段注释，这是本次改动最要紧的一条）。
 *
 * 说明：Node 的类型剥离不做 `.js` → `.ts` 映射，所以这里显式用 `.ts` 说明符导入源码。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  QQ_CHANNEL_NAME, QqOfficialChannel,
  type HttpJsonFn, type HttpJsonResponse,
} from '../src/channel/qq-official.ts';
import {
  DEFAULT_INPUT_NOTIFY_TIMEOUT_MS, createInputNotifyPoster,
} from '../src/channel/input-notify.ts';
import { ONEBOT_CHANNEL_NAME } from '../src/channel/onebot.ts';
import type { ChannelAdapter } from '../src/channel/qq-official.js';
import { createAdminTools, setSleepForTest, type InputNotifyPostResult } from '../src/tools/admin.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { TimerStore } from '../src/wake/timer-store.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

interface RecordedHttp {
  fn: HttpJsonFn;
  /** 按发生顺序记下每一次出站请求（**顺序本身**就是被测的东西之一） */
  requests: Array<{ method: string; url: string; jsonBody: Record<string, unknown> }>;
}

/**
 * 假 HTTP：只认两种应答——取 token，以及"这条消息类的请求"。
 *
 * `onMessage` 让用例决定每一条消息请求回什么（失败路径就靠它），返回 null = 用默认成功应答。
 */
function makeFakeHttp(
  onMessage?: (body: Record<string, unknown>, index: number) => HttpJsonResponse | null,
): RecordedHttp {
  const requests: RecordedHttp['requests'] = [];
  const fn: HttpJsonFn = async (input) => {
    const body = (input.jsonBody ?? {}) as Record<string, unknown>;
    if (input.url.includes('getAppAccessToken')) {
      return { status: 200, text: '', body: { access_token: 'ACCESS', expires_in: 7200 } };
    }
    const index = requests.length;
    requests.push({ method: input.method, url: input.url, jsonBody: body });
    const custom = onMessage?.(body, index);
    if (custom !== undefined && custom !== null) return custom;
    return { status: 200, text: JSON.stringify({ id: 'SENT-1' }), body: { id: 'SENT-1' } };
  };
  return { fn, requests };
}

/** 一台只装着假 HTTP 的官方通道（凭证也走同一个假 HTTP） */
function makeChannel(http: RecordedHttp): QqOfficialChannel {
  return new QqOfficialChannel({
    appId: 'APP',
    clientSecret: 'SECRET',
    http: http.fn,
    log: { info: () => {}, warn: () => {} },
  });
}

function messageRequests(http: RecordedHttp): RecordedHttp['requests'] {
  return http.requests.filter((request) => request.url.includes('/messages'));
}

// ──────────────────────── ① 通道层：请求体逐字正确 ────────────────────────

test('通道：单聊「正在输入」= msg_type:6 + input_notify{1,60}，地址就是单聊发消息那一条', async () => {
  const http = makeFakeHttp();
  const channel = makeChannel(http);
  const outcome = await channel.sendInputNotify('c2c', 'USER-9', { msgId: 'MSG-7' });

  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  // 通道那一层的观测读数（"她怎么不显示正在输入"的唯一只读答案）
  assert.deepEqual(channel.snapshot().inputNotify, { attempts: 1, sent: 1, failed: 0 });
  const request = messageRequests(http)[0];
  assert.equal(request?.method, 'POST');
  assert.equal(request?.url, 'https://api.bot.qq.com/v2/users/USER-9/messages');
  // 官方示例体（《发送单聊消息》页）：`{msg_type: 6, input_notify: {input_type: 1, input_second: 60}, msg_id, msg_seq}`
  // ——逐字照抄，只少一个 `msg_seq`（见下一条用例：那个号不许被这一次吃掉）。
  assert.deepEqual(request?.jsonBody, {
    msg_type: 6,
    input_notify: { input_type: 1, input_second: 60 },
    msg_id: 'MSG-7',
  });
});

test('通道：**不碰 msg_seq 计数器**（它是被动回复窗口往下数的凭据）', async () => {
  // 这条是本次改动最要紧的边界：如果"正在输入"也去要一个号，后面那几条正文的编号会被
  // 整体往后推——而被动窗口只有 4 次，那等于**一个状态通知偷偷吃掉一次说话的机会**。
  const http = makeFakeHttp();
  const channel = makeChannel(http);

  await channel.sendInputNotify('c2c', 'USER-9', { msgId: 'MSG-7' });
  assert.equal('msg_seq' in (messageRequests(http)[0]?.jsonBody ?? {}), false,
    '不带 msg_seq：官方"不填默认是 1"，而正文那一条的序号由 sendText 自己的计数器说了算');

  // 紧接着发两条正文：它们的号必须是 2、3（第一条被动回复天然是 1 的既有口径），
  // 即"正在输入"没有把计数器推动过。
  await channel.sendText('c2c', 'USER-9', '第一句', { msgId: 'MSG-7' });
  await channel.sendText('c2c', 'USER-9', '第二句', { msgId: 'MSG-7' });
  const seqs = messageRequests(http).slice(1).map((request) => request.jsonBody['msg_seq']);
  assert.deepEqual(seqs, [2, 3], '正在输入不许让正文的序号错位');
});

test('通道：群聊「正在输入」如实跳过 —— 不是失败、也不发出去', async () => {
  for (const chatType of ['group', 'group-at'] as const) {
    const http = makeFakeHttp();
    const channel = makeChannel(http);
    const outcome = await channel.sendInputNotify(chatType, 'GROUP-1', { msgId: 'MSG-7' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.skipped, true, `${chatType} 必须是 skipped`);
    assert.equal(messageRequests(http).length, 0, '一次请求都不许发出去（官方群聊页没这个能力）');
    // 群里那条路是合法的"不发"：**不许**被算成 attempts（否则读数会把"跳过"读成"试过没成"）
    assert.deepEqual(channel.snapshot().inputNotify, { attempts: 0, sent: 0, failed: 0 });
  }
});

test('通道：没有被动窗口时不带 msg_id（那条会被平台当成主动消息，不能悄悄发）', async () => {
  const http = makeFakeHttp();
  const channel = makeChannel(http);
  await channel.sendInputNotify('c2c', 'USER-9');
  assert.deepEqual(messageRequests(http)[0]?.jsonBody, {
    msg_type: 6,
    input_notify: { input_type: 1, input_second: 60 },
  });
});

test('通道：平台拒绝/网络异常都折成 ok:false（不抛异常——调用方不必写 try/catch）', async () => {
  // ① 平台明确拒绝
  const refused = makeFakeHttp(() => ({
    status: 200,
    text: JSON.stringify({ code: 40034128, message: '被动回复时间或次数超限' }),
    body: { code: 40034128, message: '被动回复时间或次数超限' },
  }));
  const channelA = makeChannel(refused);
  const a = await channelA.sendInputNotify('c2c', 'USER-9', { msgId: 'MSG-7' });
  assert.equal(a.ok, false);
  assert.equal(a.ok === false && a.skipped, false, '平台拒了 = failed，不是 skipped');
  assert.match(a.ok === false ? a.reason : '', /40034128/);
  assert.deepEqual(channelA.snapshot().inputNotify, { attempts: 1, sent: 0, failed: 1 });

  // ② 网络层直接抛
  const throwing: RecordedHttp = {
    requests: [],
    fn: async (input) => {
      if (input.url.includes('getAppAccessToken')) {
        return { status: 200, text: '', body: { access_token: 'ACCESS', expires_in: 7200 } };
      }
      throw new Error('ECONNRESET');
    },
  };
  const b = await makeChannel(throwing).sendInputNotify('c2c', 'USER-9', { msgId: 'MSG-7' });
  assert.equal(b.ok, false);
  assert.match(b.ok === false ? b.reason : '', /ECONNRESET/);
});

// ──────────────────── ② 接线层：能力判据一处、优雅跳过 ────────────────────

/** 只有 sendText 的通道（复刻 OneBot 的形状：没有 sendInputNotify） */
function textOnlyChannel(name: string): ChannelAdapter {
  return {
    name,
    start: () => {},
    stop: () => {},
    sendText: async () => ({ ok: true, messageId: 'SENT', passive: true, msgSeq: 1 }),
  };
}

test('接线：OneBot 没有这条能力 ⇒ 优雅跳过（不是报错、也不去 QQ 通道表里找人）', async () => {
  const poster = createInputNotifyPoster(new Map([[ONEBOT_CHANNEL_NAME, textOnlyChannel(ONEBOT_CHANNEL_NAME)]]));
  const result = await poster.notify({ url: 'onebot:c2c:12345', idempotencyKey: 'turn-1' });
  assert.equal(result.status, 'skipped');
  assert.match(result.status === 'skipped' ? result.reason : '', /没有"正在输入"这条能力/);
});

test('接线：通道未装配 ⇒ 跳过（不当成"发失败了"）', async () => {
  const poster = createInputNotifyPoster(new Map());
  const result = await poster.notify({ url: 'qq:c2c:USER-9', idempotencyKey: 'turn-1' });
  assert.equal(result.status, 'skipped');
  assert.match(result.status === 'skipped' ? result.reason : '', /未装配/);
});

test('接线：群里跳过 —— 判据在通道自己手里（接线层不写 chatType 的 if）', async () => {
  // 用一个"会发但只对单聊发"的通道替身：接线层照旧把请求转过去，答案由它给。
  const asked: Array<{ chatType: string; chatId: string; msgId?: string }> = [];
  const channel: ChannelAdapter = {
    ...textOnlyChannel(QQ_CHANNEL_NAME),
    sendInputNotify: async (chatType, chatId, options) => {
      asked.push({ chatType, chatId, ...(options?.msgId === undefined ? {} : { msgId: options.msgId }) });
      return chatType === 'c2c'
        ? { ok: true, messageId: 'SENT' }
        : { ok: false, skipped: true, reason: '官方只有单聊支持"正在输入"' };
    },
  };
  const poster = createInputNotifyPoster(new Map([[QQ_CHANNEL_NAME, channel]]));

  const c2c = await poster.notify({ url: 'qq:c2c:USER-9', idempotencyKey: 't', msgId: 'MSG-7' });
  assert.deepEqual(c2c, { status: 'sent', channel: QQ_CHANNEL_NAME });
  const group = await poster.notify({ url: 'qq:group:GROUP-1', idempotencyKey: 't', msgId: 'MSG-7' });
  assert.equal(group.status, 'skipped');
  // msgId 必须原样带过去：没有它这一条会被平台当成主动消息
  assert.deepEqual(asked, [
    { chatType: 'c2c', chatId: 'USER-9', msgId: 'MSG-7' },
    { chatType: 'group', chatId: 'GROUP-1', msgId: 'MSG-7' },
  ]);
});

test('接线：超时 ⇒ failed（默认 2.5s 那条线真的在管着）', async () => {
  const channel: ChannelAdapter = {
    ...textOnlyChannel(QQ_CHANNEL_NAME),
    // 永不 resolve：这正是"外部实现不可信"那条兜底要挡的东西
    sendInputNotify: () => new Promise(() => {}),
  };
  const poster = createInputNotifyPoster(new Map([[QQ_CHANNEL_NAME, channel]]), { timeoutMs: 30 });
  const result = await poster.notify({ url: 'qq:c2c:USER-9', idempotencyKey: 't' });
  assert.equal(result.status, 'failed');
  assert.match(result.status === 'failed' ? result.reason : '', /超时（30ms）/);
  assert.ok(DEFAULT_INPUT_NOTIFY_TIMEOUT_MS >= 1_000, '默认预算不该被改成"比一次网络往返还短"');
});

// ──────────────────── ③ speak：触发点、可关、失败不传染 ────────────────────

interface SpeakRig {
  dir: string;
  ctx: ToolContext;
}

function makeRig(name: string): SpeakRig {
  const dir = mkdtempSync(join(tmpdir(), `irmia-inputnotify-${name}-`));
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    ctx: {
      callId: 'call_typing',
      turn: 7,
      step: 1,
      signal: new AbortController().signal,
      workspaceRoot: dir,
    },
  };
}

/** 一次 speak 的公共装配：记录"什么时候发生了什么"，顺序本身就是断言对象 */
function speakToolkit(input: {
  dir: string;
  target: { url: string; idempotencyKey: string; msgId?: string } | null;
  timeline: string[];
  notify?: (target: { url: string; idempotencyKey: string; msgId?: string }) => Promise<InputNotifyPostResult>;
}): ReturnType<typeof createAdminTools> {
  return createAdminTools({
    timers: new TimerStore(null),
    emit: (type, data) => {
      if (type === 'message/assistant') input.timeline.push(`log:${(data as { text: string }).text}`);
    },
    personaRoot: join(input.dir, 'persona'),
    ...(input.target === null ? {} : { replyTargetOf: () => input.target as NonNullable<typeof input.target> }),
    replyPoster: {
      async post(_target, text) {
        input.timeline.push(`im:${text}`);
        return { ok: true, status: 200 };
      },
    },
    ...(input.notify === undefined ? {} : { inputNotify: { notify: input.notify } }),
  });
}

test('speak①：单聊 ⇒ 发一次「正在输入」，且在**第一个字**出去之前', async (t) => {
  const rig = makeRig('c2c');
  t.after(() => { rmSync(rig.dir, { recursive: true, force: true }); });
  const timeline: string[] = [];
  const toolkit = speakToolkit({
    dir: rig.dir,
    target: { url: 'qq:c2c:USER-9', idempotencyKey: 'turn-7', msgId: 'MSG-7' },
    timeline,
    notify: async (target) => {
      timeline.push(`typing:${target.url}:${target.msgId ?? ''}`);
      return { status: 'sent', channel: QQ_CHANNEL_NAME };
    },
  });
  setSleepForTest(async (ms) => { timeline.push(`sleep:${ms}`); });
  t.after(() => { setSleepForTest(null); });

  const result = await toolkit.byName('speak').handler({ text: '甲乙丙丁戊，己庚辛壬癸子' }, rig.ctx);

  assert.equal(result.isError, undefined, result.content);
  assert.deepEqual(timeline, [
    'typing:qq:c2c:USER-9:MSG-7',       // ← 先亮"正在输入"
    'sleep:3333', 'log:甲乙丙丁戊', 'im:甲乙丙丁戊',
    'sleep:4000', 'log:己庚辛壬癸子', 'im:己庚辛壬癸子',
  ], '「正在输入」必须在打字停顿与第一个字之前，且一次 speak 只发一次（不是每段一条）');
});

test('speak②：群聊 ⇒ 一次都不发（通道那条路不接，speak 照旧说完）', async (t) => {
  const rig = makeRig('group');
  t.after(() => { rmSync(rig.dir, { recursive: true, force: true }); });
  const timeline: string[] = [];
  const toolkit = speakToolkit({
    dir: rig.dir,
    target: { url: 'qq:group:GROUP-1', idempotencyKey: 'turn-7', msgId: 'MSG-7' },
    timeline,
    notify: async () => ({ status: 'skipped', reason: '官方只有单聊支持"正在输入"' }),
  });
  setSleepForTest(async () => {});
  t.after(() => { setSleepForTest(null); });

  const result = await toolkit.byName('speak').handler({ text: '甲乙丙丁戊，己庚辛壬癸子' }, rig.ctx);

  assert.equal(result.isError, undefined, result.content);
  // 群里那一条话照旧发全（跳过"正在输入"不许影响发言）
  assert.deepEqual(timeline.filter(line => line.startsWith('im:')), ['im:甲乙丙丁戊', 'im:己庚辛壬癸子']);
  // **skipped 是预期内的静默**：回执里一个字都不提它（不进她的回执、也不改投递结论）
  assert.doesNotMatch(result.content, /正在输入/);
});

test('speak③：关掉开关（不装口子）⇒ 一个请求都不发，speak 结果逐字不变', async (t) => {
  const rig = makeRig('off');
  t.after(() => { rmSync(rig.dir, { recursive: true, force: true }); });
  const timeline: string[] = [];
  // 不传 inputNotify = main.ts 里 `config.speak.inputNotify=false` 那一支
  const toolkit = speakToolkit({
    dir: rig.dir,
    target: { url: 'qq:c2c:USER-9', idempotencyKey: 'turn-7', msgId: 'MSG-7' },
    timeline,
  });
  setSleepForTest(async () => {});
  t.after(() => { setSleepForTest(null); });

  const result = await toolkit.byName('speak').handler({ text: '甲乙丙丁戊，己庚辛壬癸子' }, rig.ctx);

  assert.equal(result.isError, undefined, result.content);
  assert.deepEqual(timeline, ['log:甲乙丙丁戊', 'im:甲乙丙丁戊', 'log:己庚辛壬癸子', 'im:己庚辛壬癸子'],
    '连一次 typing 都没有——"关掉"在接线层就断了，工具层不知道有开关这回事');
});

test('speak④：发送失败 ⇒ speak 照旧成功，回执里**一个字都不提**正在输入', async (t) => {
  const rig = makeRig('fail');
  t.after(() => { rmSync(rig.dir, { recursive: true, force: true }); });
  const timeline: string[] = [];
  const toolkit = speakToolkit({
    dir: rig.dir,
    target: { url: 'qq:c2c:USER-9', idempotencyKey: 'turn-7', msgId: 'MSG-7' },
    timeline,
    notify: async () => ({ status: 'failed', reason: 'HTTP 500 code=50055002 消息发送异常' }),
  });
  setSleepForTest(async () => {});
  t.after(() => { setSleepForTest(null); });

  const result = await toolkit.byName('speak').handler({ text: '甲乙丙丁戊，己庚辛壬癸子' }, rig.ctx);

  assert.equal(result.isError, undefined, result.content);
  assert.deepEqual(timeline.filter(line => line.startsWith('im:')), ['im:甲乙丙丁戊', 'im:己庚辛壬癸子'],
    '正在输入失败了，话照样全部发出去');
  assert.match(result.content, /已送达/, '回执照旧是"送到了"');
  assert.doesNotMatch(result.content, /正在输入/, '这一下不是她的动作，回执里不许提它');
  // 留痕在**通道侧**（admin 只丢结果、不起新事件类型）：失败那一行由通道的 log.warn 扛，
  // 这里断言"它确实没往回执里漏一个字"就够了——错误码的取证在通道层那两个用例里。
});

test('speak④b：notify 抛异常 / 永不 resolve ⇒ speak 都不受影响', async (t) => {
  const rig = makeRig('throw');
  t.after(() => { rmSync(rig.dir, { recursive: true, force: true }); });
  setSleepForTest(async () => {});
  t.after(() => { setSleepForTest(null); });

  const throwing = speakToolkit({
    dir: rig.dir,
    target: { url: 'qq:c2c:USER-9', idempotencyKey: 'turn-7', msgId: 'MSG-7' },
    timeline: [],
    notify: async () => { throw new Error('boom'); },
  });
  const thrown = await throwing.byName('speak').handler({ text: '就这一句' }, rig.ctx);
  assert.equal(thrown.isError, undefined, thrown.content);
  assert.match(thrown.content, /已送达/);

  // 永不 resolve 的实现**不许把 speak 卡在开口之前**（admin 侧的硬预算）
  const hanging = speakToolkit({
    dir: rig.dir,
    target: { url: 'qq:c2c:USER-9', idempotencyKey: 'turn-7', msgId: 'MSG-7' },
    timeline: [],
    notify: () => new Promise<InputNotifyPostResult>(() => {}),
  });
  const started = Date.now();
  const stalled = await hanging.byName('speak').handler({ text: '就这一句' }, rig.ctx);
  const elapsedMs = Date.now() - started;
  assert.equal(stalled.isError, undefined, stalled.content);
  assert.match(stalled.content, /已送达/, '卡住的"正在输入"不许让它说不了话');
  assert.ok(elapsedMs < 60_000, `不许等到 speak 自己的 120s 超时（实耗 ${elapsedMs}ms）`);
});

test('speak：没有目标（本轮无回投地址）⇒ 不发；硬门退回的那次也不发', async (t) => {
  const rig = makeRig('none');
  t.after(() => { rmSync(rig.dir, { recursive: true, force: true }); });
  const asked: string[] = [];
  const toolkit = speakToolkit({
    dir: rig.dir,
    target: null,   // 没有会话可显示状态
    timeline: [],
    notify: async () => { asked.push('asked'); return { status: 'sent', channel: QQ_CHANNEL_NAME }; },
  });
  setSleepForTest(async () => {});
  t.after(() => { setSleepForTest(null); });

  const result = await toolkit.byName('speak').handler({ text: '就这一句' }, rig.ctx);
  assert.equal(result.isError, undefined, result.content);
  assert.deepEqual(asked, [], '没有目标就没有会话可以显示"正在输入"');

  // 硬门：一个字都不发的那次，也不该先亮一个"正在输入"再什么都不说
  const over = await toolkit.byName('speak').handler({ text: '字'.repeat(41) }, rig.ctx);
  assert.equal(over.isError, true);
  assert.deepEqual(asked, [], '被硬门退回时一个字都不发，更不该先亮状态');
});
