/**
 * 「这条是不是我自己发的」——两扇门各一个真 rig（2026-10-11 用户裁决的落点）
 *
 * ──────────────────────────── 这条链治的病（现场） ────────────────────────────
 *
 * 她一次 speak 的三条气泡，从**平台另一扇门**（同一实体群的 `qq-official` 那一路）被当作
 * "别人发来的消息"推回来，`person` 填的是**她自己的** openid。整条入站链路上原先没有任何一处判
 * "这条是不是我自己发的"，于是这条回声被完整地当成某个群成员说的话：落 `channel/message`
 * → 算未读 → **进群成员档案**（`data/group-members.json` 里多出一条
 * `群友C（群昵称：伊尔弥亚2号）`，与真人网友并列）。
 *
 * ──────────────────────────── 这支用例钉死四件事 ────────────────────────────
 *
 * 1. **判据真的会拦**——而且拦的是**运行期才学到的**那个标识：
 *    两扇门的"我是谁"都不是启动时就有的（OneBot 等首条事件的 `self_id`、官方等
 *    `mentions[bot]` / `/users/@me` / 回声的 `author.bot`）。用启动快照写这一层，它整个进程
 *    生命周期里都恒假（2026-10-11 复审抓到的那处"改了等于没改"），所以这里**先构造判据、
 *    后喂事件**，顺序不许反过来。
 * 2. **不落库、不注册群成员、不计未读**（三件一起）。
 * 3. **固定设计不许动**：她自己的话照旧以 `（我）` 出现在 `read_channel` 结果里——
 *    那条路是 `speak/sent` 凭据（`deliveredToSid` → `readChannelSpoken` → `renderReadBatch`），
 *    与上面那条闸**没有任何交集**。这一支是**正面**断言，不是顺带一提。
 * 4. **两侧对照**：官 Bot 那扇门（回声真的会被推回来）与 OneBot 那扇门（协议端
 *    `reportSelfMessage:false` 先挡一道，但适配器这一层的判据现在也补上了）各一组读数。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { defaultVisibility, type AppEvent, type WakeChannel } from '../src/log/types.ts';
import { applyOne, fold } from '../src/state/fold.ts';
import { RealLoop } from '../src/runtime/real-loop.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import {
  OneBotChannel, noticeDataOf, type OneBotClientOptions,
} from '../src/channel/onebot.ts';
import { botOpenidsOf, fetchBotLoginInfo, type HttpJsonFn } from '../src/channel/qq-official.ts';
import { SelfIdentity, isSelfMessage, noticeLineText } from '../src/channel/self-identity.ts';
import { channelGate, groupMemberGate } from '../src/channel/self-message-gate.ts';
import { createAdminTools } from '../src/tools/admin.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import type { ToolContext } from '../src/tools/types.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const TZ = 'Asia/Shanghai';
const PERSONA: PersonaAssets = {
  identity: 'IDENTITY', constitution: 'CONSTITUTION', style: 'STYLE', state: 'STATE',
  relationship: null, personaHash: 'test-hash', isSeed: false,
} as unknown as PersonaAssets;

const CTX: ToolContext = {
  callId: 'call_read', turn: 3, step: 1,
  signal: new AbortController().signal, workspaceRoot: process.cwd(),
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000, label = '条件'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`等待超时：${label}`);
}

// ──────────────────────────────── 假协议端（够用的一次升级 + 帧收发） ────────────────────────────────

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODE = { text: 0x1, close: 0x8 } as const;

interface FakeProtocolSide {
  url: string;
  sendJson(value: unknown): void;
  actions(): Array<Record<string, unknown>>;
  close(): Promise<void>;
}

/**
 * 一个只做三件事的假 OneBot 协议端：完成 ws 升级、能把 JSON 事件推给客户端、
 * 能看懂客户端发来的动作（`get_login_info` 可指定回不回 `user_id`）。
 *
 * 为什么不用 `test/onebot.test.ts` 里那个更完整的假 NapCat：那支要验的是握手/鉴权/重连，
 * 本文件要验的是"**适配器学到 `self_id` 之后判据会不会拦**"——把那一整台搬过来只会让
 * 这条用例的失败原因多出十几个与它无关的出口。
 */
async function startFakeProtocolSide(
  t: TestContext,
  options: { loginInfoUserId?: string | null } = {},
): Promise<FakeProtocolSide> {
  const server: Server = createHttpServer();
  const sockets: Socket[] = [];

  server.on('upgrade', (req, socket: Socket) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + WS_MAGIC).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.push(socket);
    socket.on('error', () => {});
  });

  const frameOf = (text: string): Buffer => {
    const payload = Buffer.from(text, 'utf8');
    const header = payload.length < 126
      ? Buffer.from([0x80 | OPCODE.text, payload.length])
      : Buffer.concat([Buffer.from([0x80 | OPCODE.text, 126]), (() => {
          const b = Buffer.alloc(2); b.writeUInt16BE(payload.length); return b;
        })()]);
    return Buffer.concat([header, payload]);
  };
  const sendJson = (value: unknown): void => {
    const frame = frameOf(JSON.stringify(value));
    for (const socket of sockets) socket.write(frame);
  };

  // 客户端帧解出来只为一件事：`get_login_info` 的回执（动作名 + echo）
  const actions: Array<Record<string, unknown>> = [];
  server.on('upgrade', (_req, socket: Socket) => {
    socket.on('data', (chunk: Buffer) => {
      // 极简解帧：只处理"带掩码的单帧文本"（客户端只会发这种）
      let offset = 2;
      const length = chunk[1]! & 0x7f;
      if (length === 126) offset = 4;
      const masked = (chunk[1]! & 0x80) !== 0;
      const mask = masked ? chunk.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      const payload = chunk.subarray(offset, offset + length);
      const text = mask === null
        ? payload.toString('utf8')
        : (() => {
            const out = Buffer.alloc(payload.length);
            for (let i = 0; i < payload.length; i += 1) out[i] = payload[i]! ^ mask[i % 4]!;
            return out.toString('utf8');
          })();
      let call: Record<string, unknown>;
      try { call = JSON.parse(text) as Record<string, unknown>; } catch { return; }
      actions.push(call);
      if (call['action'] === 'get_login_info') {
        const userId = options.loginInfoUserId === undefined ? '1234567891' : options.loginInfoUserId;
        sendJson({
          status: 'ok', retcode: 0, echo: call['echo'],
          data: userId === null ? {} : { user_id: userId, nickname: '伊尔弥亚2号' },
        });
      } else if (call['echo'] !== undefined) {
        sendJson({ status: 'ok', retcode: 0, data: {}, echo: call['echo'] });
      }
    });
  });

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('假协议端未能监听端口');

  t.after(() => { for (const socket of sockets) socket.destroy(); });
  return {
    url: `ws://127.0.0.1:${address.port}`,
    sendJson,
    actions: () => actions,
    close: async () => {
      for (const socket of [...sockets]) socket.destroy();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    },
  };
}

// ──────────────────────────────── ① 判据本身：运行期学到才算数 ────────────────────────────────

test('判据只认"此刻知道"的那些：学到之前放行、学到之后拦住（这就是那处"改了等于没改"）', () => {
  const learned = new Set<string>();
  const self = new SelfIdentity([() => [...learned]]);
  const echo = { channel: 'qq-official', person: '00000000000000000000000000000003' };

  // 学到之前：**放行**（认不出自己时宁可让一次回声漏进来，也绝不丢掉别人的话）
  assert.equal(isSelfMessage(echo, self), false, '还不知道自己是谁时不许误拦');

  // "运行期学到了"——走的是与 main.ts 完全相同的两条腿：现读口（provider）+ 推送口（add）
  learned.add('00000000000000000000000000000003');
  assert.equal(isSelfMessage(echo, self), true, '现读口必须让"刚学到的"当场算数（不能是启动快照）');
  assert.deepEqual(self.values(), ['00000000000000000000000000000003']);

  // 推送口那条腿：不经过 provider 也认
  const pushed = new SelfIdentity();
  assert.equal(isSelfMessage({ person: '1234567891' }, pushed), false);
  pushed.add('1234567891');
  assert.equal(isSelfMessage({ person: '1234567891' }, pushed), true);

  // 空 person / 空白：不认（畸形事件不该被"当成自己"静默吞掉）
  assert.equal(isSelfMessage({ person: '' }, pushed), false);
  assert.equal(isSelfMessage({}, pushed), false);
  assert.equal(pushed.add('   '), false, '空白不许进集合');
});

test('两道门共用同一个判据对象：任何人往它里面推一次，两扇门同时生效', () => {
  // 现象①是"官方那扇门的回声"引起的，而 OneBot 那扇门今天是靠协议端配置挡着（侥幸没触发）。
  // 判据只有一份 ⇒ 两扇门不可能出现"一边拦住了、另一边没拦"。
  const self = new SelfIdentity();
  assert.equal(groupMemberGate({ person: 'X' }, self), false);
  self.add('X');
  assert.equal(groupMemberGate({ person: 'X' }, self), true);});

// ──────────────────────────────── ② 官 Bot 那扇门（真 rig） ────────────────────────────────

test('官 Bot：回声的 openid 是**运行期学到**的，学到之后它不再落库、不再算群成员', async (t) => {
  const dir = tempDirSync('irmia-self-gate-');
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });

  // 判据先造好（**空集**：与 main.ts 的时序一致——通道先建、判据随后，事件最后到）
  const learned: string[] = [];
  const self = new SelfIdentity([() => learned]);

  // 平台推来一条"群里有人 @ 了她"的事件 ⇒ 适配器从 `mentions[bot]` 里学到**自己的 openid**
  const GROUP_OPENID = '00000000000000000000000000000002';
  const SELF_OPENID = '00000000000000000000000000000003';
  const groupEvent = {
    id: 'ROBOT1.0_inbound',
    group_openid: GROUP_OPENID,
    author: { member_openid: '00000000000000000000000000000001', username: '阿岚', member_role: 'owner' },
    content: '<qqbot-at-user id="' + SELF_OPENID + '" /> 在吗',
    timestamp: '2026-10-10T16:46:00.000Z',
    mentions: [{ id: SELF_OPENID, bot: true }],
  };
  assert.deepEqual(botOpenidsOf(groupEvent), [SELF_OPENID], '官方那条 @ 我的事件里带着"我自己是谁"');
  for (const id of botOpenidsOf(groupEvent)) learned.push(id);

  // 同 5 秒内，她自己那条 speak 从**另一扇门**被推回来（现象①的逐字形状）
  const echo: WakeChannel['data'] = {
    channel: 'qq-official', chatType: 'group', person: SELF_OPENID,
    nickname: '伊尔弥亚2号', chatId: GROUP_OPENID, text: '那条重复的撤了',
    messageId: 'ROBOT1.0_echo', msgSeq: 77547,
  };

  // ── 三件事一起不做 ──
  const log = await EventLog.open(join(dir, 'events'));
  t.after(() => { log.close(); });
  const projection = fold([]);
  const append = (type: string, data: unknown): AppEvent => {
    const event = {
      seq: log.nextSeq(), ts: '2026-10-10T16:46:29.922Z', type, data,
      visibility: defaultVisibility(type), origin: 'test/self-message-gate',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    applyOne(projection, event);
    return event;
  };

  // ① 判据拦得住（**运行期学到的**那个 openid）
  assert.equal(channelGate(echo, self), true, '这就是那条回声：认出是自己发的 ⇒ 宿主那一层整条丢掉');
  // ② 就算它走到了"注册群成员"那一层（历史事件重折那条路），第二道防线也拦得住
  assert.equal(groupMemberGate({ ...echo, chatType: 'group-at', mentionsMe: true }, self), true,
    '第二道防线读的是**同一个**判据对象');

  // ③ 不计未读：回声根本没落库 ⇒ 会话簿里没有这个会话、更谈不上未读
  const loop = new RealLoop({
    log, dataDir: dir, projection, now: () => new Date('2026-10-10T16:47:00.000Z'),
    timezone: TZ, ds: ({ modelFor: () => 'fake-model' }) as unknown as DsClient,
    registry: new ToolRegistry(), persona: PERSONA, config: defaultConfig(dir),
    out: () => {}, pollMs: 3_600_000, selfMessages: self,
  });
  t.after(() => { loop.stop(); });
  await loop.tickOnce();
  assert.deepEqual(loop.sessions(), [], '她自己的回声不该在任何会话簿里留下条数/未读');

  // ── 固定设计：她自己的话照旧看得见（走的是完全另一条路） ──
  const rec = {
    events: [] as Array<{ type: string; data: unknown }>,
    emit(type: string, data: unknown): void { rec.events.push({ type, data }); },
  };
  const spoken = [{ text: '那条重复的撤了退群不可逆你点哪个群我就退', ts: '2026-10-10T16:46:39.453Z', parts: 3, seq: 900, atMs: Date.parse('2026-10-10T16:46:39.453Z') }];
  const messages = [{
    sid: `qq:group:${GROUP_OPENID}`, channel: 'qq-official', chatType: 'group' as const, chatId: GROUP_OPENID,
    person: '00000000000000000000000000000001', nickname: '阿岚', text: '你点哪个群我就退',
    messageId: 'm-1', msgSeq: 3, seq: 901, ts: '2026-10-10T16:46:40.000Z',
  }];
  const tk = createAdminTools({
    timers: new TimerStore(null), emit: rec.emit as never,
    channelReader: async () => messages,
    channelSpokenReader: async () => spoken,
    selfIds: () => self.values(),
    timezone: 'UTC',
    resolvePersonName: (person) => (person === '00000000000000000000000000000001' ? '用户（阿岚）' : null),
  });
  const out = await tk.byName('read_channel').handler({ sid: `qq:group:${GROUP_OPENID}`, limit: 20 }, CTX);
  assert.match(out.content, /（我）：那条重复的撤了退群不可逆你点哪个群我就退/u,
    `固定设计：她自己的话要照旧以 （我） 出现：\n${out.content}`);
  assert.equal(out.content.includes('群友C'), false, '她不该在群友那一档里出现');
});

// ──────────────────────────────── ③ OneBot 那扇门（真 rig：假协议端 + 真适配器） ────────────────────────────────

test('OneBot：self_id 是**首条事件**教的（不是启动时就知道），学到之后回声不落库、不注册成员', async (t) => {
  const fake = await startFakeProtocolSide(t);
  const channel = new OneBotChannel({ wsUrl: fake.url, log: { info: () => {}, warn: () => {} } });

  // 判据先造好（**空集**），现读口对着真适配器
  const self = new SelfIdentity([() => channel.selfIds()]);
  const seen: string[] = [];
  channel.setSelfIdListener((id) => { seen.push(id); self.add(id); });

  const delivered: WakeChannel['data'][] = [];
  channel.onMessage = (data) => { delivered.push(data); };
  /**
   * ⚠ **这一行必须在 `start()` 之前**（而且这正是这支用例存在的理由）：
   * 判据若写成"启动时拷一份 `selfIds()`"，它拿到的是**空集**——而 OneBot 的机器人 QQ 号
   * 要等 WS 打开、甚至首条事件里的 `self_id` 才知道。启动快照 ⇒ 这一层整个进程生命周期恒假。
   */
  assert.deepEqual(channel.selfIds(), [], '连上之前它还不知道自己是谁（这正是不许用启动快照的理由）');
  channel.start();
  t.after(() => { channel.stop(); void fake.close(); });
  await waitFor(() => channel.snapshot().connected, 8000, 'OneBot 链路握手完成');

  // 协议端推来**第一条消息事件**：`self_id` 就在这里（这条链路里"我是谁"的唯一权威来源）
  const BOT_QQ = '1234567891';
  fake.sendJson({
    post_type: 'message', message_type: 'group', self_id: BOT_QQ,
    group_id: 123456782, user_id: '1234567892', message_id: 555001, message_seq: 11,
    sender: { user_id: '1234567892', nickname: 'Kalo' },
    raw_message: '在吗', message: [{ type: 'text', data: { text: '在吗' } }],
  });
  await waitFor(() => channel.selfIds().length > 0, 8000, '适配器学到 self_id');
  assert.deepEqual(channel.selfIds(), [BOT_QQ], 'self_id 来自事件本身（不是硬编码）');
  assert.equal(seen.includes(BOT_QQ), true, '学到的那一刻要**报给宿主**（推送口）');

  // 现在协议端把她自己的那条推回来（`reportSelfMessage` 打开时的形状；本机是 false，所以这条
  // 只有在"哪天打开了"时才真会发生——判据补上之后那一天也不会出问题）
  const echo: WakeChannel['data'] = {
    channel: 'onebot', chatType: 'group', person: BOT_QQ, chatId: '123456782',
    text: '那条重复的撤了', messageId: '555002', msgSeq: 12,
  };
  assert.equal(channelGate(echo, self), true, 'OneBot 侧：认出是自己发的 ⇒ 不落库（哪怕协议端哪天开始上报）');
  assert.equal(groupMemberGate({ ...echo, chatType: 'group-at', mentionsMe: true }, self), true,
    'OneBot 侧：也不会被注册成群友');
  // 群里**别人**的话照旧放行（不许因为认自己而误伤别人）
  assert.equal(channelGate({ ...echo, person: '1234567892' }, self), false, '别人的话一个字都不许拦');
  // 落库口的数据也照旧到（"别人的话"那条路没被这条闸影响）
  await waitFor(() => delivered.some((item) => item.person === '1234567892'), 8000, 'Kalo 那条投给宿主');
  assert.ok(delivered.some((item) => item.person === '1234567892'), 'Kalo 那条照常投给宿主');
});

test('OneBot：`get_login_info` 是另一条来路（事件里没有 self_id 时靠它兜底），同样报给宿主', async (t) => {
  const fake = await startFakeProtocolSide(t, { loginInfoUserId: '1234567891' });
  const channel = new OneBotChannel({ wsUrl: fake.url, log: { info: () => {}, warn: () => {} } });
  const self = new SelfIdentity([() => channel.selfIds()]);
  channel.setSelfIdListener((id) => { self.add(id); });
  channel.start();
  t.after(() => { channel.stop(); void fake.close(); });
  await waitFor(() => channel.snapshot().connected, 8000, 'OneBot 链路握手完成');

  // 不带 self_id 的 lifecycle 事件会触发 `get_login_info`（见 `onMetaEvent`）
  fake.sendJson({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' });
  await waitFor(() => channel.selfIds().length > 0, 8000, 'get_login_info 兜底拿到机器人 QQ 号');
  assert.ok(fake.actions().some((call) => call['action'] === 'get_login_info'), '确实问了协议端');
  assert.equal(isSelfMessage({ channel: 'onebot', person: '1234567891' }, self), true);
});

// ──────────────────────────────── ④ 官方那侧"我是谁"的最后一个来源 ────────────────────────────────

test('官 Bot：`GET /users/@me` 探针（既有握手）取到就记、取不到如实降级不猜', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const http: HttpJsonFn = async (request) => {
    calls.push({ url: request.url, method: request.method });
    if (request.url.endsWith('/users/@me')) {
      return { status: 200, body: { id: '00000000000000000000000000000003', username: '伊尔弥亚2号' } };
    }
    return { status: 200, body: {} };
  };
  const info = await fetchBotLoginInfo({ apiBase: 'https://api.bot.qq.com', token: async () => 'T', http });
  assert.deepEqual(info, { openid: '00000000000000000000000000000003', username: '伊尔弥亚2号' });
  assert.equal(calls[0]!.url, 'https://api.bot.qq.com/users/@me');

  // 取不到（平台没给 id）⇒ **null**，绝不猜一个
  const empty = await fetchBotLoginInfo({
    apiBase: 'https://api.bot.qq.com', token: async () => 'T',
    http: async () => ({ status: 200, body: {} }),
  });
  assert.equal(empty, null, '取不到就是取不到——猜一个的后果是把别人的话当成自己的丢掉');
  // 抛了也不许把启动带崩
  const thrown = await fetchBotLoginInfo({
    apiBase: 'https://api.bot.qq.com', token: async () => 'T',
    http: async () => { throw new Error('网络不通'); },
  });
  assert.equal(thrown, null);
});

// ──────────────────────────────── ⑤ 两侧对照表（一次跑出两组读数） ────────────────────────────────

test('两侧对照：官 Bot ↔ OneBot（同一场景各一次，结论必须一致）', async (t) => {
  const rows: Array<{ side: string; echoBlocked: boolean; memberBlocked: boolean; visibleAsMe: boolean }> = [];

  // 官 Bot 侧：openid 由 @ 我的事件学到
  const qqSelf = new SelfIdentity();
  const GROUP_OPENID = '00000000000000000000000000000002';
  for (const id of botOpenidsOf({ mentions: [{ id: '00000000000000000000000000000003', bot: true }] })) qqSelf.add(id);
  const qqEcho: WakeChannel['data'] = {
    channel: 'qq-official', chatType: 'group', person: '00000000000000000000000000000003',
    chatId: GROUP_OPENID, text: '退群不可逆', messageId: 'e1', msgSeq: 1,
  };
  rows.push({
    side: 'qq-official',
    echoBlocked: channelGate(qqEcho, qqSelf),
    memberBlocked: groupMemberGate({ ...qqEcho, chatType: 'group-at', mentionsMe: true }, qqSelf),
    visibleAsMe: true, // 见 ②（（我）那一行的正面用例）
  });

  // OneBot 侧：QQ 号由 self_id 学到
  const obSelf = new SelfIdentity();
  obSelf.add('1234567891');
  const obEcho: WakeChannel['data'] = {
    channel: 'onebot', chatType: 'group', person: '1234567891',
    chatId: '123456782', text: '退群不可逆', messageId: 'e2', msgSeq: 2,
  };
  rows.push({
    side: 'onebot',
    echoBlocked: channelGate(obEcho, obSelf),
    memberBlocked: groupMemberGate({ ...obEcho, chatType: 'group-at', mentionsMe: true }, obSelf),
    visibleAsMe: true,
  });

  assert.deepEqual(rows.map((row) => row.echoBlocked), [true, true], '两侧的回声都不再落库');
  assert.deepEqual(rows.map((row) => row.memberBlocked), [true, true], '两侧都不会把自己注册成群友');
  assert.deepEqual(rows.map((row) => row.visibleAsMe), [true, true], '两侧她自己的话都照旧以 （我） 可见');
  t.diagnostic(`两侧对照：${JSON.stringify(rows)}`);
});

// ──────────────────────────────── ⑥ 端到端：notice 从适配器一路走到 read_channel 的那一行 ────────────────────────────────

/**
 * 这一支是复审点名的"只进不出"：落库与可见性都做了，但**渲染那一路没人接**——
 * 事件积在日志里、她永远看不见。判据链是四段，缺一段这些行就不存在：
 *   ① `noticeDataOf`（适配器：协议事件 → `channel/notice` 载荷）
 *   ② 宿主落成 `channel/notice` 事件（main.ts 的 `onChannelNotice`）
 *   ③ `readChannelNotices`（宿主读口，按 sid + 游标取）
 *   ④ `renderReadBatch` 里那一行（`noticeLineText` + 名字真源现查）
 * 这里把 ①③④ 用真 EventLog + 真 RealLoop + 真 admin 工具串起来跑一遍，断言**逐字**那一行。
 */
test('端到端：群里的动静从适配器走到 read_channel 的那一行（逐字）', async (t) => {
  const dir = tempDirSync('irmia-notice-e2e-');
  const log = await EventLog.open(join(dir, 'events'));
  t.after(() => { log.close(); rmSync(dir, { recursive: true, force: true }); });

  const projection = fold([]);
  const GROUP = '123456782';
  const SID = `onebot:group:${GROUP}`;
  const append = (type: string, data: unknown, ts: string): void => {
    const event = {
      seq: log.nextSeq(), ts, type, data,
      visibility: defaultVisibility(type), origin: 'test/self-message-gate',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    applyOne(projection, event);
  };

  // ① + ②：协议端推来的四条 notice，逐条走适配器的映射再落库（形状照 OneBot 11）
  const raws: Array<Record<string, unknown>> = [
    // 别人（用户）开了全员禁言：`user_id === group_id`、duration 0
    { post_type: 'notice', notice_type: 'group_ban', sub_type: 'ban', group_id: Number(GROUP), user_id: Number(GROUP), operator_id: 1234567890, duration: 0, self_id: 1234567891 },
    // 某个群成员被禁言 600 秒
    { post_type: 'notice', notice_type: 'group_ban', sub_type: 'ban', group_id: Number(GROUP), user_id: 1234567892, operator_id: 1234567890, duration: 600, self_id: 1234567891 },
    { post_type: 'notice', notice_type: 'group_admin', sub_type: 'set', group_id: Number(GROUP), user_id: 1234567892, operator_id: 1234567890, self_id: 1234567891 },
    { post_type: 'notice', notice_type: 'group_increase', sub_type: 'approve', group_id: Number(GROUP), user_id: 1234567892, operator_id: 1234567890, self_id: 1234567891 },
    { post_type: 'notice', notice_type: 'group_recall', group_id: Number(GROUP), user_id: 1234567892, operator_id: 1234567892, message_id: 555, self_id: 1234567891 },
    // 认不出的类别：**不落库**（宁可这一条没有，也不编一件没发生的事）
    { post_type: 'notice', notice_type: '不认识的类别', group_id: Number(GROUP), user_id: 1234567892, self_id: 1234567891 },
  ];
  const self = new SelfIdentity();
  self.add('1234567891');
  let at = Date.parse('2026-10-10T16:46:00.000Z');
  for (const raw of raws) {
    const data = noticeDataOf(raw, { selfId: '1234567891' });
    if (data === null) continue;
    if (noticeLineText(data, () => '', new Set(self.values())) === null) continue; // 宿主那层的形状/类别闸
    append('channel/notice', data, new Date(at).toISOString());
    at += 1000;
  }
  // 会话簿里应当有 5 条动静；**未读不许被它们推起来**（未读只数别人的话）
  const loop = new RealLoop({
    log, dataDir: dir, projection, now: () => new Date('2026-10-10T16:50:00.000Z'),
    timezone: TZ, ds: ({ modelFor: () => 'fake-model' }) as unknown as DsClient,
    registry: new ToolRegistry(), persona: PERSONA, config: defaultConfig(dir),
    out: () => {}, pollMs: 3_600_000, selfMessages: self,
  });
  t.after(() => { loop.stop(); });
  await loop.tickOnce();
  const sessions = loop.sessions();
  assert.equal(sessions.length, 1, `这个群出现在会话簿里（她从那儿知道有这么个群）：${JSON.stringify(sessions)}`);
  assert.equal(sessions[0]!.unread, 0, '群里动静**不计未读**（未读数的必须是别人的话）');
  assert.equal(sessions[0]!.messages, 0, '动静也不计入"这个会话来过多少条话"');
  assert.equal(sessions[0]!.sid, SID, '会话就是那个群');

  // ③ 宿主读口：按 sid 取得到、按游标切得动
  const notices = await loop.readChannelNotices(SID, 20);
  const kinds = notices.map((n) => n?.noticeType);
  assert.equal(notices.length, 5, `五条动静都读得回来（不认识的类别那一条没落库）：${JSON.stringify(kinds)}`);
  assert.deepEqual(kinds, ['group_ban', 'group_ban', 'group_admin', 'group_increase', 'group_recall']);
  const older = await loop.readChannelNotices(SID, 20, notices[3]!.seq);
  assert.deepEqual(older.map((n) => n.noticeType), ['group_ban', 'group_ban', 'group_admin'], '游标切得动（翻页那条路）');
  assert.deepEqual(await loop.readChannelNotices('onebot:group:999', 20), [], '不是这个会话的动静取不到');

  // ④ 渲染：与真 admin 工具同一套（消息从哪来无所谓，这里**只摆动静**）
  const rec = { events: [] as Array<{ type: string; data: unknown }>, emit(type: string, data: unknown): void { rec.events.push({ type, data }); } };
  const tk = createAdminTools({
    timers: new TimerStore(null), emit: rec.emit as never,
    // 这一屏**只有动静、一条消息都没有**（空群那种形状）——正是"messages.length === 0 就回
    // 没有新消息"那条老判据会把它吞掉的形状
    channelReader: async () => [],
    channelNoticeReader: async (sid, limit, before) => await loop.readChannelNotices(sid, limit, before),
    selfIds: () => self.values(),
    timezone: 'UTC',
    resolvePersonName: (person) => ({
      '1234567890': '用户（阿岚）',
      '1234567892': 'Kalo',
    } as Record<string, string>)[person] ?? null,
  });
  const out = await tk.byName('read_channel').handler({ sid: SID, limit: 20 }, CTX);
  assert.equal(out.isError, undefined, `read_channel 报错了：${out.content}\n${JSON.stringify(rec.events)}`);
  const rows = out.content.split('\n').filter((line) => /^\d\d-\d\d \d\d:\d\d /u.test(line));
  assert.deepEqual(rows.map((line) => line.slice(12)), [
    '[用户（阿岚） 开启了全员禁言]',
    '[用户（阿岚） 把 Kalo 禁言 600 秒]',
    '[Kalo 被设为管理员]',
    '[Kalo 加入了群聊]',
    '[Kalo 撤回了一条消息]',
  ], `群里动静要逐字摆进那一屏：\n${out.content}`);
  // 整批还是一个框（与消息同一条时间轴、同一个框）
  assert.equal(out.content.split('[external_event').length - 1, 1, '整批一个框');
  assert.equal(out.content.includes('（我）'), false, '动静不是"我说的话"——不许被渲染成 （我） 那一行');
  t.diagnostic(out.content);
});

// ──────────────────────────────── ⑦ notice 那一行（纯函数：逐字与边界） ────────────────────────────────

test('notice 数据 → 逐字一行：拿不到的不编、认不出的不猜', () => {
  const namer = (id: string): string => (id === '1234567890' ? '用户（阿岚）' : '');
  const self = new Set(['1234567891']);
  const line = (raw: Record<string, unknown>, ctxSelf = self): string | null =>
    noticeLineText(noticeDataOf(raw, { selfId: '1234567891' })!, namer, ctxSelf);

  assert.equal(line({ notice_type: 'group_ban', sub_type: 'ban', group_id: 123456782, user_id: 1234567890, operator_id: 1234567890, duration: 0 }), '[用户（阿岚） 开启了全员禁言]');
  // 全员禁言那一条的协议形状是 `user_id === group_id`（duration 为 0）——两条判据都认
  assert.equal(line({ notice_type: 'group_ban', sub_type: 'ban', group_id: 123456782, user_id: 123456782, operator_id: 1234567890, duration: 0 }), '[用户（阿岚） 开启了全员禁言]');
  assert.equal(line({ notice_type: 'group_ban', sub_type: 'lift_ban', group_id: 123456782, user_id: 1234567890, operator_id: 1234567890, duration: 0 }), '[用户（阿岚） 解除了全员禁言]');
  assert.equal(line({ notice_type: 'group_ban', sub_type: 'ban', group_id: 123456782, user_id: 999, operator_id: 1234567890, duration: 600 }), '[用户（阿岚） 把 某个群成员（…0999） 禁言 600 秒]');
  assert.equal(line({ notice_type: 'group_ban', sub_type: 'ban', group_id: 123456782, user_id: 999, duration: 600 }), '[某个群成员（…0999） 被禁言 600 秒]');
  // 拿不到 duration ⇒ **不写秒数**（不许编一个 0 或 600 出来），而且**不许**读成全员禁言
  assert.equal(line({ notice_type: 'group_ban', sub_type: 'ban', group_id: 123456782, user_id: 999 }), '[某个群成员（…0999） 被禁言]');
  assert.equal(line({ notice_type: 'group_admin', sub_type: 'set', group_id: 123456782, user_id: 999 }), '[某个群成员（…0999） 被设为管理员]');
  assert.equal(line({ notice_type: 'group_admin', sub_type: 'unset', group_id: 123456782, user_id: 1234567890 }), '[用户（阿岚） 被取消管理员]');
  assert.equal(line({ notice_type: 'group_increase', sub_type: 'approve', group_id: 123456782, user_id: 999 }), '[某个群成员（…0999） 加入了群聊]');
  assert.equal(line({ notice_type: 'group_decrease', sub_type: 'kick', group_id: 123456782, user_id: 999, operator_id: 1234567890 }), '[某个群成员（…0999） 被移出群聊]');
  assert.equal(line({ notice_type: 'group_decrease', sub_type: 'kick_me', group_id: 123456782, user_id: 1234567891 }), '[我被移出群聊]');
  assert.equal(line({ notice_type: 'group_recall', group_id: 123456782, user_id: 999, operator_id: 1234567890 }), '[用户（阿岚） 撤回了 某个群成员（…0999） 的一条消息]');
  assert.equal(line({ notice_type: 'group_recall', group_id: 123456782, user_id: 999, operator_id: 999 }), '[某个群成员（…0999） 撤回了一条消息]');
  // 认不出的类别 ⇒ **整条丢**（不编一件没发生的事）
  assert.equal(line({ notice_type: 'group_upload', group_id: 123456782, user_id: 999 }), '[某个群成员（…0999） 上传了群文件]');
  assert.equal(line({ notice_type: '不认识的类别', group_id: 123456782, user_id: 999 }), null);
  assert.equal(line({ notice_type: 'notify', sub_type: 'input_status', group_id: 123456782, user_id: 999 }), null);
  // 我自己那一条：写成"我"（自我标识是运行期学到的，所以这里现取）
  assert.equal(line({ notice_type: 'group_admin', sub_type: 'set', group_id: 123456782, user_id: 1234567891 }), '[我 被设为管理员]');
  assert.equal(line({ notice_type: 'group_admin', sub_type: 'set', group_id: 123456782, user_id: 1234567891 }, new Set()), '[某个群成员（…7891） 被设为管理员]',
    '还不知道自己是谁时照实写锚，不猜');
});
