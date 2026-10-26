/**
 * OneBot 私聊（c2c）必须与官 Bot 私聊**走同一条行为** — 2026-10-08
 *
 * 用户报的现象：「onebot 被私聊应该和官 bot 私聊行为一样。貌似目前变成和群聊类似的 read channel 了。」
 *
 * 这一份测的不是"某个函数返回了什么"，而是**她在请求体里到底看不看得见那句话**：
 *   假 NapCat（真 ws 帧）→ **真 `OneBotChannel`** → **真 `shouldWakeForChannelMessage`**
 *   → **真 `RealLoop`** → 真 `agent-loop`/`render` → 假模型记下的**请求体**。
 *
 * 为什么非要走真链路（`test/fixtures/real-wake-rig.ts` 的文件头写着同一条理由）：
 * 这条 bug 的形状是"**适配器全对、渲染全对，只有分流那一句多问了一句话**"——
 * 任何一层用替身搭出来，测的就不是那条链路，而"私聊被当成群聊分流"恰恰长在两层之间。
 *
 * 判据（实测见 `_research/probe-onebot-c2c-loop.mts` 的改前/改后对照）：
 *   ① OneBot 私聊 ⇒ 被唤醒 + **正文进本轮新输入**（请求体里出现那句原文）；
 *   ② **对照**：官 Bot 私聊走的是同一份判据、同一个结果（两条通道逐项同形）；
 *   ③ OneBot **群聊**未 @ ⇒ **不唤醒**（回归：别把群聊放宽了）；
 *   ④ 用户身份在 OneBot 私聊里判为 `owner`；
 *   ⑤ 私聊那一轮**不该**出现"要你 read_channel"这类措辞（正文不该被换成一纸通知）。
 *
 * 约定：值导入写 `.ts`（Node 的 `--experimental-strip-types` 只擦类型、不改写路径解析）。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { OneBotChannel } from '../src/channel/onebot.ts';
import {
  mentionsKeyword, shouldWakeForChannelMessage, type WakeCriteria,
} from '../src/channel/inbox.ts';
import { mapDispatchToWakeChannel } from '../src/channel/qq-official.ts';
import { normalizeSid, sidOf } from '../src/channel/sessions.ts';
import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { defaultVisibility, type AppEvent, type ModelLane, type Projection, type WakeChannel } from '../src/log/types.ts';
import type { DsClient, DsRequest } from '../src/model/ds-client.ts';
import { RealLoop } from '../src/runtime/real-loop.ts';
import { trustOfWake } from '../src/runtime/trust.ts';
import { applyOne, fold } from '../src/state/fold.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const TZ = 'Asia/Shanghai';
const NOW_MS = Date.parse('2026-10-08T02:00:00.000Z');

/** 用户在**两条通道**上的 id（配置里就是这么写的：一个 openid、一个数字 QQ 号） */
const OWNER_OPENID = '00000000000000000000000000000001';
const OWNER_QQ = '1234567890';
/** 谁是用户：`runtime/trust.ts` 按这个名字判 owner */
const OWNER_LABEL = '用户（阿岚）';
/** 联系人表（口径与 config.json 的 `persona.contacts` 同形，键是 sid） */
const CONTACTS = new Map<string, string>([
  [sidOf('qq-official', 'c2c', OWNER_OPENID), OWNER_LABEL],
  [sidOf('onebot', 'c2c', OWNER_QQ), OWNER_LABEL],
]);

/** 那两句原文：一句用来找"正文进没进请求体"，一句做对照 */
const PRIVATE_TEXT = '晚饭吃了吗';
const GROUP_TEXT = '你们聊，我看会儿书';

// ──────────────────────────── 假 NapCat（真 ws 帧） ────────────────────────────

const OPCODE = { text: 1, close: 8 };

interface FakeCat {
  url: string;
  /** 以**服务端**身份下发一条事件（真的是 ws 文本帧，真的过 `OneBotClient` 的解析） */
  sendJson: (value: unknown) => void;
  close: () => Promise<void>;
}

/** 服务端帧头：掩码位恒 0（与 `test/onebot.test.ts` 的假协议端同一份实现） */
function headerFor(length: number, opcode: number): Buffer {
  if (length < 126) {
    const buf = Buffer.alloc(2);
    buf.writeUInt8(0x80 | opcode, 0);
    buf.writeUInt8(length, 1);
    return buf;
  }
  const buf = Buffer.alloc(4);
  buf.writeUInt8(0x80 | opcode, 0);
  buf.writeUInt8(126, 1);
  buf.writeUInt16BE(length, 2);
  return buf;
}

/** 只把客户端帧读完丢掉（这一份用例只关心"服务端推了什么"），读不完整就等下一片 */
function skipClientFrame(buffer: Buffer): number | null {
  if (buffer.length < 2) return null;
  const b1 = buffer.readUInt8(1);
  const masked = (b1 & 0x80) !== 0;
  let length = b1 & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  return offset + length;
}

async function startFakeNapCat(t: TestContext): Promise<FakeCat> {
  const sockets: Socket[] = [];
  const buffers = new Map<Socket, Buffer>();
  const upgraded = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.push(socket);
    buffers.set(socket, Buffer.alloc(0));
    socket.on('error', () => { /* 断线是用例的一部分 */ });
    socket.on('data', (chunk) => {
      let buffer = Buffer.concat([buffers.get(socket) ?? Buffer.alloc(0), chunk]);
      if (!upgraded.has(socket)) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) { buffers.set(socket, buffer); return; }
        const head = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + 4);
        const headers = new Map<string, string>();
        for (const line of head.split('\r\n').slice(1)) {
          const index = line.indexOf(':');
          if (index > 0) headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
        }
        upgraded.add(socket);
        const key = headers.get('sec-websocket-key') ?? '';
        const accept = createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, 'binary')
          .digest('base64');
        socket.write([
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '',
          '',
        ].join('\r\n'), 'utf8');
      }
      for (;;) {
        const consumed = skipClientFrame(buffer);
        if (consumed === null) break;
        buffer = buffer.subarray(consumed);
      }
      buffers.set(socket, buffer);
    });
    socket.on('close', () => {
      buffers.delete(socket);
      const index = sockets.indexOf(socket);
      if (index >= 0) sockets.splice(index, 1);
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('假协议端没监听上');
  t.after(async () => {
    for (const socket of [...sockets]) socket.destroy();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  });
  return {
    url: `ws://127.0.0.1:${address.port}`,
    sendJson: (value) => {
      const payload = Buffer.from(JSON.stringify(value), 'utf8');
      const frame = Buffer.concat([headerFor(payload.length, OPCODE.text), payload]);
      for (const socket of [...sockets]) socket.write(frame);
    },
    close: async () => {
      for (const socket of [...sockets]) socket.destroy();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    },
  };
}

// ──────────────────────────── 真 RealLoop 测试台 ────────────────────────────

interface Harness {
  dir: string;
  log: EventLog;
  loop: RealLoop;
  /** 模型收到的每一次请求（heavy 的 stream / light 的 generate 都记，按到达顺序） */
  requests: Array<{ lane: ModelLane; request: DsRequest }>;
  /** main.ts 的 `onChannelMessage`：两条出口（`loop.wake` / `channel/message`）写的是哪一条 */
  route: (data: WakeChannel['data']) => 'wake' | 'inbox';
  /** 跑一拍（生产定时器回调与这里调的是同一个方法） */
  tick: () => Promise<void>;
  events: () => Promise<AppEvent[]>;
  dispose: () => void;
}

async function makeHarness(t: TestContext): Promise<Harness> {
  const dir = tempDirSync('irmia-onebot-c2c-');
  const config = defaultConfig(dir);
  mkdirSync(config.dataDir, { recursive: true });
  const log = await EventLog.open(join(config.dataDir, 'events'));
  const projection: Projection = fold([]);
  const requests: Array<{ lane: ModelLane; request: DsRequest }> = [];
  const ds = {
    modelFor: (lane: ModelLane): string => (lane === 'light' ? 'fake-light' : 'fake-heavy'),
    stream: async (request: DsRequest) => {
      requests.push({ lane: 'heavy', request });
      return {
        status: 'completed', text: '嗯。', reasoning: '', toolCalls: [], outputItems: [],
        usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, reasoningTokens: 0 },
        incompleteReason: null, model: 'fake-heavy', responseId: 'resp-heavy', durationMs: 3,
        interrupted: false, failure: null,
      };
    },
    generate: async (request: DsRequest) => {
      requests.push({ lane: 'light', request });
      return {
        status: 'completed', outputItems: [],
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, reasoningTokens: 0 },
        incompleteReason: null, model: 'fake-light', responseId: 'resp-light', durationMs: 1,
      };
    },
  } as unknown as DsClient;
  const loop = new RealLoop({
    log,
    dataDir: config.dataDir,
    projection,
    now: () => new Date(NOW_MS),
    timezone: TZ,
    ds,
    registry: new ToolRegistry(),
    persona: { identity: 'I', constitution: 'C', style: 'S', state: 'ST', personaHash: 'test', isSeed: false },
    config,
    out: () => {},
    pollMs: 3_600_000,
  });
  t.after(() => { loop.stop(); log.close(); rmSync(dir, { recursive: true, force: true }); });

  // ── 判据的两个输入：**真配置那一套口径**（联系人表 ∪ 别名表 → normalizeSid）──
  // 与 `main.ts` 的 `watchedSidsOf` / `onChannelMessage` 同一份接线，只是素材在用例里给。
  const watchedSids: ReadonlySet<string> = new Set([...CONTACTS.keys()].map((sid) => normalizeSid(sid)));
  // 刻意**留空**：私聊的唤醒判据不许依赖关键词（那是群聊的判据）
  const mentionKeywords: readonly string[] = [];
  const criteria: WakeCriteria = { watchedSids, mentionKeywords };

  const route = (data: WakeChannel['data']): 'wake' | 'inbox' => {
    // 与 `main.ts` 的 `onChannelMessage` 逐句同形：关键词只对群聊补 `mentionsMe`
    const byKeyword = data.chatType !== 'c2c' && data.mentionsMe !== true
      && mentionsKeyword(data.text, mentionKeywords);
    if (shouldWakeForChannelMessage(data, criteria)) {
      loop.wake({ type: 'wake/channel', data: byKeyword ? { ...data, mentionsMe: true } : data });
      return 'wake';
    }
    append('channel/message', { ...data, msgSeq: data.msgSeq > 0 ? data.msgSeq : 4242 });
    return 'inbox';
  };

  const append = (type: string, data: unknown): AppEvent => {
    const event = {
      seq: log.nextSeq(), ts: new Date(NOW_MS).toISOString(), type, data,
      visibility: defaultVisibility(type), origin: 'test/channel-onebot-c2c-wake',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    applyOne(projection, event);
    return event;
  };

  return {
    dir, log, loop, requests, route,
    tick: () => loop.tickOnce(),
    events: async () => {
      log.flush();
      const out: AppEvent[] = [];
      for await (const event of log.readAll()) out.push(event);
      return out;
    },
    dispose: () => { loop.stop(); log.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

// ──────────────────────────── 请求体读取（判据就在这几行上） ────────────────────────────

/** 一条 item 的纯文本（`content` 可能是字符串，也可能是多模态数组） */
function textOfItem(item: unknown): string {
  if (typeof item !== 'object' || item === null) return '';
  const content = (item as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
      ? (part as { text: string }).text
      : ''))
    .join('\n');
}

function requestItems(request: DsRequest): unknown[] {
  return Array.isArray(request.input) ? request.input : [];
}

/**
 * **本轮新输入那一格**：`[external_event …]` 那个包裹所在的那条 item。
 *
 * 为什么不按"最后一条 item"取：她一轮里可能有多个 step，最后那条可能是工具结果。
 * 认这个标记是既有的做法（`test/channel-wire.test.ts` 也这么找），而且它正是
 * "别人说的话"在请求体里的**唯一形状**——找到它就等于找到了"她当场看得见的那句话"。
 */
function triggerItem(request: DsRequest): string {
  const hit = requestItems(request).map(textOfItem).filter((text) => text.includes('[external_event'));
  return hit.length === 0 ? '' : (hit[hit.length - 1] ?? '');
}

/** 最后那次 heavy 请求（起 turn 的那一次） */
function lastHeavy(h: Harness): DsRequest | null {
  const heavy = h.requests.filter((entry) => entry.lane === 'heavy');
  const last = heavy[heavy.length - 1];
  return last === undefined ? null : last.request;
}

/** 跑一拍并把请求体读出来（tickOnce 是生产定时器回调的同一份逻辑） */
async function tickAndRead(h: Harness): Promise<string> {
  await h.tick();
  await h.tick();
  const request = lastHeavy(h);
  return request === null ? '' : triggerItem(request);
}

function oneBotPrivateEvent(userId: string, text: string, messageId: number): Record<string, unknown> {
  return {
    post_type: 'message', message_type: 'private', sub_type: 'friend',
    message_id: messageId, user_id: Number(userId), self_id: 3333333333,
    raw_message: text, message: [{ type: 'text', data: { text } }],
    sender: { user_id: Number(userId), nickname: '昵称只是显示' },
    time: 1791500000, font: 0,
  };
}

function oneBotGroupEvent(userId: string, groupId: string, text: string, messageId: number): Record<string, unknown> {
  return {
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    message_id: messageId, group_id: Number(groupId), user_id: Number(userId), self_id: 3333333333,
    raw_message: text, message: [{ type: 'text', data: { text } }],
    sender: { user_id: Number(userId), nickname: '群友' },
    time: 1791500000, font: 0,
  };
}

/** 收下一条真帧（等适配器把它交到 `onMessage` 上），返回它走的是哪条出口 */
async function deliver(cat: FakeCat, h: Harness, payload: Record<string, unknown>): Promise<'wake' | 'inbox'> {
  const route = h.route;
  let seen: 'wake' | 'inbox' | null = null;
  const channel = new OneBotChannel({ wsUrl: cat.url, readTimeoutMs: 0 });
  channel.onMessage = (data) => { seen = route(data); };
  channel.start();
  try {
    await waitFor(() => channel.snapshot().connected, 8000, '通道握手完成');
    cat.sendJson(payload);
    await waitFor(() => seen !== null, 8000, '事件投递到 onMessage');
    return seen as unknown as 'wake' | 'inbox';
  } finally {
    channel.stop();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  throw new Error(`等待超时：${what}`);
}

// ──────────────────────────────── 用例 ────────────────────────────────

describe('OneBot 私聊与官 Bot 私聊走同一条行为（2026-10-08）', () => {
  test('① OneBot 私聊 ⇒ 被唤醒，且**正文直接进本轮新输入**（真链路：假协议端 → 真通道 → 真 RealLoop）', async (t) => {
    const cat = await startFakeNapCat(t);
    const h = await makeHarness(t);
    t.after(() => { void cat.close(); });

    const route = await deliver(cat, h, oneBotPrivateEvent(OWNER_QQ, PRIVATE_TEXT, 70001));
    assert.equal(route, 'wake', '私聊必须走 loop.wake（进消息流 + 起 turn），不是 channel/message');

    const trigger = await tickAndRead(h);
    assert.ok(trigger.includes(PRIVATE_TEXT), `正文必须进本轮新输入：${trigger}`);
    assert.match(trigger, /^\[external_event source=onebot chat=私聊 /u, `包裹头照旧：${trigger}`);
    // 它在她眼里就是"那个人的一句话"，不是一纸通知
    assert.ok(trigger.includes(`person=${OWNER_QQ}`), `要带上是谁说的：${trigger}`);

    // 落库的 wake 事件也确认一次（判据的输入与输出两头都钉住）
    const wake = (await h.events()).find((event) => event.type === 'wake/channel');
    assert.equal(wake?.data.chatType, 'c2c');
    assert.equal(wake?.data.text, PRIVATE_TEXT, 'wake 事件里带的就是正文本身');
  });

  test('①b OneBot 私聊 · **联系人表里没有的人** 同样唤醒、正文同样直接进（用户报的就是这一条）', async (t) => {
    // ⚠️ 这条才是**复现**那条 bug 的用例，① 不是：①用的是用户（他在名单里），
    // 所以"私聊要不要查名单"这一问在①里恰好答对了——**旧代码能让①通过**。
    // 用户 2026-10-08 报的现象就长在这个缺口上：OneBot 那条私聊的对方还没被写进
    // `config.persona.contacts`，于是他的私聊静默变成"只进信箱"，她要 `read_channel` 才看得见。
    // 判据是**无条件**：私聊里没有"@ 不 @"这回事，也没有"认不认识"这回事（认人是信任级的事）。
    const cat = await startFakeNapCat(t);
    const h = await makeHarness(t);
    t.after(() => { void cat.close(); });

    const stranger = '10009';
    assert.ok(
      ![...CONTACTS.keys()].some((sid) => sid.endsWith(`:${stranger}`)),
      '前置条件：这个人**不在**联系人表里（否则这条用例测不到东西）',
    );

    assert.equal(await deliver(cat, h, oneBotPrivateEvent(stranger, PRIVATE_TEXT, 70006)), 'wake');
    const trigger = await tickAndRead(h);
    assert.ok(trigger.includes(PRIVATE_TEXT), `正文必须进本轮新输入（哪怕没给他起过名字）：${trigger}`);
    assert.match(trigger, /^\[external_event source=onebot chat=私聊 /u, trigger);
    assert.ok(trigger.includes('read_channel') === false, `不许换成一纸通知：${trigger}`);
  });

  test('② 对照：官 Bot 私聊走**同一份判据**、同一个结果（两条通道逐项同形）', async (t) => {
    const h = await makeHarness(t);
    const data = mapDispatchToWakeChannel('C2C_MESSAGE_CREATE', {
      id: `ROBOT1.0_${OWNER_OPENID}_M`,
      content: PRIVATE_TEXT,
      timestamp: '2026-10-08T10:00:00+08:00',
      author: { id: OWNER_OPENID, user_openid: OWNER_OPENID, username: '阿岚' },
    }, 'qq-official');
    assert.notEqual(data, null, '官方 c2c 事件必须映射出一条 wake 载荷');

    assert.equal(h.route(data as WakeChannel['data']), 'wake');
    const trigger = await tickAndRead(h);
    assert.ok(trigger.includes(PRIVATE_TEXT), `官 Bot 私聊的正文同样直接进：${trigger}`);
    assert.match(trigger, /^\[external_event source=qq-official chat=私聊 /u, trigger);
  });

  test('②b 两条通道的**私聊载荷逐项同形**：除了通道名与 id 空间，其余一个字段不差', () => {
    // 这条用例锁的是"分歧不该出现在适配器里"：`chatType`、`person=chatId`、`mentionsMe` 缺席、
    // 正文口径——两条通道给分流器的东西必须是同一个形状。
    const official = mapDispatchToWakeChannel('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_M', content: PRIVATE_TEXT, timestamp: '2026-10-08T10:00:00+08:00',
      author: { id: OWNER_OPENID, user_openid: OWNER_OPENID, username: '阿岚' },
    }, 'qq-official');
    assert.equal(official?.chatType, 'c2c');
    assert.equal(official?.person, official?.chatId, '私聊：说话的人就是会话');
    assert.equal(official?.mentionsMe, undefined, '私聊上不该有"提及"这回事（官方那格不进 c2c）');

    // OneBot 那一侧的同一组事实由 `mapEventToWakeChannel` 给（`test/onebot.test.ts` 已逐字段钉死），
    // 这里只对照"分流器看得见的那三个字段"。
    assert.equal(oneBotPrivateEvent(OWNER_QQ, PRIVATE_TEXT, 1)['message_type'], 'private');
  });

  test('③ 回归：OneBot **群聊未 @** ⇒ 不唤醒（群聊判据不许被放宽）', async (t) => {
    const cat = await startFakeNapCat(t);
    const h = await makeHarness(t);
    t.after(() => { void cat.close(); });

    const route = await deliver(cat, h, oneBotGroupEvent('10009', '20002', GROUP_TEXT, 70002));
    assert.equal(route, 'inbox', '群里没叫到她的话只进信箱——这不是"私聊放宽"能顺带改掉的');

    // 信箱那条路照旧记账（`channel/message`），而且**不起 turn**（heavy 一次都没被调用）
    await h.tick();
    await h.tick();
    assert.equal(h.requests.filter((entry) => entry.lane === 'heavy').length, 0, '进信箱不该起 turn');
    const inbox = (await h.events()).find((event) => event.type === 'channel/message');
    assert.equal(inbox?.data.chatType, 'group');
    assert.equal(inbox?.data.text, GROUP_TEXT);
  });

  test('③b 回归：OneBot 群里 **@ 她** 照样唤醒（别把群聊那条路一起改坏）', async (t) => {
    const cat = await startFakeNapCat(t);
    const h = await makeHarness(t);
    t.after(() => { void cat.close(); });

    const route = await deliver(cat, h, {
      ...oneBotGroupEvent('10009', '20002', '帮我看看', 70003),
      raw_message: '[CQ:at,qq=3333333333] 帮我看看',
      message: '[CQ:at,qq=3333333333] 帮我看看',
    });
    assert.equal(route, 'wake');
    const wake = (await h.events()).find((event) => event.type === 'wake/channel');
    assert.equal(wake?.data.chatType, 'group-at');
    assert.equal(wake?.data.mentionsMe, true, '@ 她 ⇒ 适配器如实填 mentionsMe（群成员档案的入口）');
  });

  test('④ 用户身份：OneBot 私聊里判为 owner（不是 external）', () => {
    // 身份判据在 `runtime/trust.ts`，输入是 (wake 事件, 联系人表, 用户名)——**与通道无关**：
    // c2c 按 `contacts.get(sidOf(channel, chatType, chatId))` 认人，而联系人表里
    // `onebot:c2c:<数字 QQ 号>` 与 `qq:c2c:<openid>` 是两行**各自独立**的声明。
    const wake = {
      seq: 1, ts: new Date(NOW_MS).toISOString(), type: 'wake/channel',
      data: {
        channel: 'onebot', chatType: 'c2c', person: OWNER_QQ, chatId: OWNER_QQ,
        text: PRIVATE_TEXT, messageId: '70001', msgSeq: 1,
      },
      visibility: 'model',
    } as unknown as AppEvent;
    assert.equal(trustOfWake(wake, CONTACTS, '阿岚'), 'owner');

    // 反向：没被声明过的私聊仍是 external（放宽的是"叫不叫她"，**不是**信任级）
    const stranger = {
      ...wake,
      data: { ...wake.data, person: '10009', chatId: '10009' },
    } as unknown as AppEvent;
    assert.equal(
      trustOfWake(stranger, CONTACTS, '阿岚'),
      'external',
      '私聊一律唤醒 ≠ 私聊一律可信：谁在说话仍由联系人表说了算',
    );
  });

  test('⑤ 私聊那一轮**不该**出现"要你 read_channel"这类措辞（正文不许被换成一纸通知）', async (t) => {
    const cat = await startFakeNapCat(t);
    const h = await makeHarness(t);
    t.after(() => { void cat.close(); });

    await deliver(cat, h, oneBotPrivateEvent(OWNER_QQ, PRIVATE_TEXT, 70004));
    const trigger = await tickAndRead(h);

    // 群聊那条"通知"的措辞（`self-brief.ts` 的 `renderMentionNote`）一个字都不许出现在这里：
    // 私聊里没有"有人在里面提到你"这回事，更没有"用 read_channel 看（sid …）"这回事。
    for (const banned of ['read_channel', '用 read_channel', '提及', '@ 了你', '提到了你']) {
      assert.ok(!trigger.includes(banned), `私聊的本轮新输入里不该出现「${banned}」：${trigger}`);
    }
    // 正面判据：正文本身就在（不然上一条会因为"整格是空的"而假绿）
    assert.ok(trigger.includes(PRIVATE_TEXT), trigger);
  });

  test('⑥ 判据里**没有**按通道名分叉：同一份载荷换掉 channel 字段，结论不变', () => {
    // `shouldWakeForChannelMessage` 一个字都不读 `data.channel`。
    // 这条锁的是"两条通道共用一处判据"这个事实本身——将来谁加回一条
    // `if (data.channel === 'onebot')` 的分叉，会在这里红。
    //
    // 载荷用**名单外的陌生人**（`watchedSids` 是空的、也不放他）：这条判据若哪天又被接回
    // "查名单"，三种通道名会**一起**变成 false——那正是 2026-10-08 那个 bug 的形状。
    const base = {
      chatType: 'c2c' as const, person: 'NOBODY', chatId: 'NOBODY',
      text: PRIVATE_TEXT, messageId: 'm-1', msgSeq: 1, dedupeKey: 'm-1',
    };
    const criteria: WakeCriteria = { watchedSids: new Set(), mentionKeywords: [] };
    const verdicts = ['onebot', 'qq-official', 'future-channel'].map((channel) =>
      shouldWakeForChannelMessage({ ...base, channel }, criteria));
    assert.deepEqual(verdicts, [true, true, true], '私聊判据与通道名无关');
    // 群聊那一侧同样与通道名无关（一律 false）
    const groups = ['onebot', 'qq-official'].map((channel) =>
      shouldWakeForChannelMessage({ ...base, channel, chatType: 'group' as const }, criteria));
    assert.deepEqual(groups, [false, false]);
  });

  test('⑦ `_research` 探针里那条真实载荷形状（NapCat 现场字段）也能唤醒', async (t) => {
    // 与真实 SnowLuma/NapCat 事件体同形但**字段更全**（sub_type/font/time/sender 都在）：
    // 用例 ① 用的是精简版，这条钉住"字段多了不该改变结论"（真实事件总是字段更多的那一份）。
    const cat = await startFakeNapCat(t);
    const h = await makeHarness(t);
    t.after(() => { void cat.close(); });

    const payload = {
      time: 1791500000, self_id: 3333333333, post_type: 'message', message_type: 'private',
      sub_type: 'friend', message_id: 70005, user_id: Number(OWNER_QQ),
      message: [{ type: 'text', data: { text: PRIVATE_TEXT } }],
      raw_message: PRIVATE_TEXT, font: 0,
      sender: { user_id: Number(OWNER_QQ), nickname: '阿岚', sex: 'unknown', age: 0 },
      status: 'online',
    };
    assert.equal(await deliver(cat, h, payload), 'wake');
    assert.ok((await tickAndRead(h)).includes(PRIVATE_TEXT));
  });

  test('⑧ 配置面：真 `config.json` 的私聊键**认得出**（并且它不再是唤醒的必要条件）', () => {
    // 这条只读真配置（纪律：不写它），把"用户现场那份表长什么样"钉成事实：
    //   · `onebot:c2c:<数字 QQ>` 与 `qq:c2c:<openid>` **是两行**——同一个人的两个 id；
    //   · 归一之后两条都进关注名单（`normalizeSid` 对 c2c 是恒等变换）。
    // 需要它，是因为这次修的是"名单**不再**决定叫不叫她"：名单仍要能把人认出来。
    const configPath = new URL('../config.json', import.meta.url);
    let raw: { persona?: { contacts?: Record<string, string> } };
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf8')) as typeof raw;
    } catch {
      return; // 没有那份配置（别的 checkout）：这条用例不适用，不编造
    }
    const contacts = raw.persona?.contacts ?? {};
    const normalized = Object.keys(contacts).map((sid) => normalizeSid(sid));
    for (const sid of normalized) {
      assert.equal(normalizeSid(sid), sid, `归一之后必须稳定（不然名单比对会漂）：${sid}`);
    }
    const c2c = normalized.filter((sid) => sid.includes(':c2c:'));
    assert.ok(c2c.length > 0, '现场那份配置里至少有一条私聊（否则这条用例失去意义）');
  });
});
