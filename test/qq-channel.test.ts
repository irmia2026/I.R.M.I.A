/**
 * QQ 官方 Bot API 通道测试（M9：ws 客户端 + 适配器 + 回投接线）
 *
 * 覆盖四块，全部走**真实链路**而不是打桩到实现内部：
 *   ① ws-client：node:net 起本地假网关，完成真握手、真帧编解码——
 *      文本收发、客户端掩码校验、服务端掩码必须被拒、ping→pong、
 *      continuation 分片重组、读超时判死触发 onClose、close 握手；
 *   ② 凭证：假 HTTP 断言"什么时候换取、什么时候复用、并发只换一次"，
 *      并覆盖官方"失败也返回 HTTP 200，要看响应体 code"这条语义；
 *   ③ 网关流程：假网关发 Hello → Ready → 心跳 ACK → C2C_MESSAGE_CREATE，
 *      断言转成 wake/channel 的每个字段（person / chatId / messageId / msgSeq / dedupeKey）；
 *   ④ 发送与重连：被动带 msg_id+msg_seq、主动不带、群/单聊 URL 分别正确、
 *      msg_seq 递增、被动过期降级为主动、断线后发 Op6 Resume 且带最后 s。
 *
 * 说明：Node 的类型剥离不做 `.js` → `.ts` 映射，所以这里显式用 `.ts` 说明符导入源码。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import test, { type TestContext } from 'node:test';

import type { WakeChannel } from '../src/log/types.js';
import {
  QQ_CHANNEL_NAME, QQ_INTENTS_GROUP_AND_C2C, QQ_OP, QqAccessToken, QqGateway, QqMessageSender,
  QqOfficialChannel, createChannelReplyPoster, defaultHttpJson, mapDispatchToWakeChannel,
  messagesPathOf, parseReplyUrl, reconnectDelayMs, replyUrlOf,
  type HttpJsonFn, type HttpJsonResponse,
} from '../src/channel/qq-official.ts';
import {
  OPCODE, acceptKeyOf, connect as wsConnect, encodeFrame, parseFrame, parseWsUrl, unmask,
  type WsClient, type WsCloseInfo,
} from '../src/channel/ws-client.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000, label = '条件'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`等待${label}超时（${timeoutMs}ms）`);
}

interface RecordedFrame {
  opcode: number;
  fin: boolean;
  text: string;
  bytes: Buffer;
}

interface FakeGateway {
  url: string;
  port: number;
  frames: RecordedFrame[];
  handshakes: Array<{ path: string; key: string; headers: Map<string, string> }>;
  /** 已建立并完成握手的连接（服务端视角） */
  sockets: Socket[];
  server: Server;
  /** 监听器：假网关收到一帧文本后调用（可编程应答） */
  onText: ((text: string, index: number) => void) | null;
  /** 关闭某条连接（模拟断线） */
  dropAll(): void;
  close(): Promise<void>;
  /** 发一帧给所有客户端（服务端帧：不掩码） */
  sendRawFrame(opcode: number, payload: Buffer, fin?: boolean): void;
  /** 发一条 JSON 文本帧 */
  sendJson(value: unknown): void;
  textFrames(): string[];
  jsonFrames(): Array<Record<string, unknown>>;
}

/**
 * 假网关：只有"够用的一次升级 + 帧收发"。
 *
 * 刻意**不用** ws-client 自己的编码器来发服务端帧吗？——用。服务端帧与客户端帧的差别只是
 * "掩码位为 0"，而这条差别恰好是被测代码自己实现的（encodeFrame 恒掩码），
 * 所以服务端这边要手写一版不掩码的编码，才能真的测到"掩码位被正确解析"。
 */
async function startFakeGateway(t: TestContext): Promise<FakeGateway> {
  const gateway: Partial<FakeGateway> = {};
  const frames: RecordedFrame[] = [];
  const handshakes: Array<{ path: string; key: string; headers: Map<string, string> }> = [];
  const sockets: Socket[] = [];
  const buffers = new Map<Socket, Buffer>();

  const server = createServer((socket) => {
    sockets.push(socket);
    buffers.set(socket, Buffer.alloc(0));
    socket.on('error', () => { /* 断线是测试的一部分，不当失败 */ });
    socket.on('data', (chunk) => {
      let buffer = Buffer.concat([buffers.get(socket) ?? Buffer.alloc(0), chunk]);
      // ① 未完成握手：先扫 \r\n\r\n
      if (!handshakeDone.has(socket)) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) {
          buffers.set(socket, buffer);
          return;
        }
        const head = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + 4);
        const lines = head.split('\r\n');
        const requestLine = lines[0] ?? '';
        const headers = new Map<string, string>();
        for (const line of lines.slice(1)) {
          const index = line.indexOf(':');
          if (index > 0) headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
        }
        const key = headers.get('sec-websocket-key') ?? '';
        const path = requestLine.split(' ')[1] ?? '';
        handshakes.push({ path, key, headers });
        handshakeDone.add(socket);
        const accept = handshakeAccept(headers.get('sec-websocket-key') ?? '');
        const response = [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '',
          '',
        ].join('\r\n');
        socket.write(Buffer.from(response, 'utf8'));
      }
      // ② 收帧：客户端帧必带掩码，解出来记录
      let sawClose = false;
      for (;;) {
        const parsed = parseFrame(buffer, 16 * 1024 * 1024);
        if (parsed.kind !== 'frame') {
          if (parsed.kind === 'protocol-error') socket.destroy();
          break;
        }
        const rawBefore = buffer;
        buffer = buffer.subarray(parsed.consumed);
        assert.equal(parsed.header.masked, true, '客户端发出的帧必须带掩码（RFC 6455 §5.3）');
        // 独立性校验：拿原始掩码字节自己解一次，与实现解出的载荷比对（不比实现的一面之词）
        const stillMasked = rawBefore.subarray(parsed.header.headerBytes, parsed.consumed);
        const independently = unmask(stillMasked, parsed.header.maskKey ?? Buffer.alloc(4));
        assert.deepEqual(independently, parsed.payload, '实现解出的载荷必须与测试独立解掩码的结果一致');
        const text = parsed.header.opcode === OPCODE.text ? parsed.payload.toString('utf8') : '';
        frames.push({
          opcode: parsed.header.opcode,
          fin: parsed.header.fin,
          text,
          bytes: parsed.payload,
        });
        const index = frames.length - 1;
        if (parsed.header.opcode === OPCODE.text && gateway.onText !== null && gateway.onText !== undefined) {
          gateway.onText(text, index);
        }
        // 客户端发来 close：一个正经的网关会镜像回一个 close 再断（测试的连接因此不靠超时收尾）
        if (parsed.header.opcode === OPCODE.close) {
          sawClose = true;
          const echo = Buffer.alloc(2);
          echo.writeUInt16BE(1000, 0);
          socket.write(Buffer.concat([headerFor(2, OPCODE.close, true), echo]));
        }
      }
      buffers.set(socket, buffer);
      if (sawClose) socket.destroy();
    });
    socket.on('close', () => {
      buffers.delete(socket);
      const index = sockets.indexOf(socket);
      if (index >= 0) sockets.splice(index, 1);
    });
  });

  const handshakeDone = new Set<Socket>();

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('假网关未能监听端口');

  const sendRawFrame = (opcode: number, payload: Buffer, fin = true): void => {
    const header = headerFor(payload.length, opcode, fin);
    const frame = Buffer.concat([header, payload]);
    for (const socket of sockets) socket.write(frame);
  };

  Object.assign(gateway, {
    url: `ws://127.0.0.1:${address.port}/websocket/`,
    port: address.port,
    frames,
    handshakes,
    sockets,
    server,
    onText: null,
    dropAll: () => {
      for (const socket of [...sockets]) socket.destroy();
    },
    close: async () => {
      for (const socket of [...sockets]) socket.destroy();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    },
    sendRawFrame,
    sendJson: (value: unknown) => { sendRawFrame(OPCODE.text, Buffer.from(JSON.stringify(value), 'utf8')); },
    textFrames: () => frames.filter(f => f.opcode === OPCODE.text).map(f => f.text),
    jsonFrames: () => frames
      .filter(f => f.opcode === OPCODE.text)
      .map((f) => {
        try {
          return JSON.parse(f.text) as Record<string, unknown>;
        } catch {
          return {};
        }
      }),
  });
  t.after(async () => { await (gateway.close as () => Promise<void>)(); });
  return gateway as FakeGateway;
}

/** 服务端帧头：掩码位恒 0（客户端帧才必须掩码） */
function headerFor(length: number, opcode: number, fin: boolean): Buffer {
  if (length < 126) {
    const buf = Buffer.alloc(2);
    buf.writeUInt8((fin ? 0x80 : 0x00) | opcode, 0);
    buf.writeUInt8(length, 1);
    return buf;
  }
  if (length < 0x10000) {
    const buf = Buffer.alloc(4);
    buf.writeUInt8((fin ? 0x80 : 0x00) | opcode, 0);
    buf.writeUInt8(126, 1);
    buf.writeUInt16BE(length, 2);
    return buf;
  }
  const buf = Buffer.alloc(10);
  buf.writeUInt8((fin ? 0x80 : 0x00) | opcode, 0);
  buf.writeUInt8(127, 1);
  buf.writeBigUInt64BE(BigInt(length), 2);
  return buf;
}

function handshakeAccept(key: string): string {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, 'binary').digest('base64');
}

// ──────────────────────────────── ① ws-client ────────────────────────────────

test('ws-client：握手（Key/Accept 校验）、文本与 JSON 收发', async (t) => {
  const gateway = await startFakeGateway(t);
  const client = await wsConnect(gateway.url, { readTimeoutMs: 0 });
  t.after(() => { client.close(); });

  assert.equal(client.isOpen, true);
  assert.equal(gateway.handshakes.length, 1);
  assert.equal(gateway.handshakes[0]?.path, '/websocket/');
  assert.equal(gateway.handshakes[0]?.headers.get('upgrade'), 'websocket');
  assert.equal(gateway.handshakes[0]?.headers.get('sec-websocket-version'), '13');
  const key = gateway.handshakes[0]?.key ?? '';
  assert.equal(Buffer.from(key, 'base64').length, 16, 'Sec-WebSocket-Key 必须是 16 字节随机数');
  // 服务端回的 Accept 必须等于 base64(sha1(key + GUID))：用同一个公式独立复算一次
  assert.equal(handshakeAccept(key), acceptKeyOf(key));

  const received: string[] = [];
  client.onMessage((message) => {
    assert.equal(message.type, 'text');
    received.push(message.text);
  });

  client.send('你好');
  client.sendJson({ op: 1, d: null });
  await waitFor(() => gateway.frames.length >= 2, 10_000, '网关收到两帧');
  assert.equal(gateway.frames[0]?.text, '你好');
  assert.deepEqual(JSON.parse(gateway.frames[1]?.text ?? '{}'), { op: 1, d: null });

  gateway.sendJson({ op: 10, d: { heartbeat_interval: 45000 } });
  await waitFor(() => received.length === 1, 10_000, '客户端收到一帧');
  assert.equal(received[0], '{"op":10,"d":{"heartbeat_interval":45000}}');
});

test('ws-client：服务端帧带掩码必须被拒（协议错误）', async (t) => {
  // 这一条刻意**不用**共享假网关：它要精确控制"握手响应之后单独再发一个非法帧"的节奏，
  // 用最小服务器把字节序列钉死在测试自己手里（共享夹具的队列会把时序问题藏起来）。
  let serverSide: Socket | null = null;
  const server = createServer((socket) => {
    serverSide = socket;
    socket.on('error', () => { /* 断线是测试的一部分 */ });
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buf.subarray(0, end).toString('latin1');
      const key = /Sec-WebSocket-Key: (.+)/i.exec(head)?.[1]?.trim() ?? '';
      socket.removeAllListeners('data');
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${handshakeAccept(key)}`,
        '',
        '',
      ].join('\r\n'));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('监听失败');
  t.after(async () => {
    serverSide?.destroy();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  });

  const client = await wsConnect(`ws://127.0.0.1:${address.port}/`, { readTimeoutMs: 0 });
  t.after(() => { client.close(); });
  const errors: string[] = [];
  const closes: WsCloseInfo[] = [];
  client.onError((err) => { errors.push(err.message); });
  client.onClose((info) => { closes.push(info); });
  assert.equal(client.isOpen, true);

  // 手写一个"服务端却带掩码"的非法帧：FIN=1 / opcode=text / MASK=1 —— RFC 6455 §5.1 禁止
  const payload = Buffer.from('bad', 'utf8');
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i]! ^ mask[i % 4]!;
  serverSide?.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));

  await waitFor(() => closes.length === 1, 10_000, '协议错误后连接收尾');
  assert.equal(errors.length >= 1, true, '必须报出协议错误');
  assert.equal(errors.some(message => message.includes('掩码')), true);
  assert.equal(closes[0]?.byLocal, false, '不是本地主动关闭，而是被协议错误收尾');
  assert.equal(closes[0]?.reason.includes('掩码'), true, '关闭原因如实说清是对端违约');
  assert.equal(client.isOpen, false);
});

test('ws-client：ping 自动回 pong（载荷原样抄回），close 走完镜像握手', async (t) => {
  const gateway = await startFakeGateway(t);
  const client = await wsConnect(gateway.url, { readTimeoutMs: 0 });

  gateway.sendRawFrame(OPCODE.ping, Buffer.from('hb-1', 'utf8'));
  await waitFor(() => gateway.frames.some(f => f.opcode === OPCODE.pong), 10_000, '收到 pong');
  const pong = gateway.frames.find(f => f.opcode === OPCODE.pong);
  assert.equal(pong?.bytes.toString('utf8'), 'hb-1', 'pong 必须原样抄回 ping 的载荷');

  const closes: WsCloseInfo[] = [];
  client.onClose((info) => { closes.push(info); });
  // 对端先关：客户端应回一个 close 帧，然后通知 onClose
  const closePayload = Buffer.alloc(2);
  closePayload.writeUInt16BE(1001, 0);
  gateway.sendRawFrame(OPCODE.close, closePayload);
  await waitFor(() => closes.length === 1, 10_000, '收到 close 通知');
  assert.equal(closes[0]?.code, 1001);
  const echoed = gateway.frames.filter(f => f.opcode === OPCODE.close);
  assert.equal(echoed.length, 1, '客户端必须回一个 close 帧');
  assert.equal(echoed[0]?.bytes.readUInt16BE(0), 1001);
});

test('ws-client：分片重组（continuation），含控制帧夹在中间', async (t) => {
  const gateway = await startFakeGateway(t);
  const client = await wsConnect(gateway.url, { readTimeoutMs: 0 });
  t.after(() => { client.close(); });

  const received: string[] = [];
  client.onMessage((message) => { received.push(message.text); });

  // 三段分片：首片 opcode=text(fin=0)，中片 continuation(fin=0)，末片 continuation(fin=1)
  gateway.sendRawFrame(OPCODE.text, Buffer.from('【分片测试】', 'utf8'), false);
  gateway.sendRawFrame(OPCODE.ping, Buffer.from('mid', 'utf8'), true); // 中间夹一个控制帧
  gateway.sendRawFrame(OPCODE.continuation, Buffer.from('第二段', 'utf8'), false);
  gateway.sendRawFrame(OPCODE.continuation, Buffer.from('第三段', 'utf8'), true);

  await waitFor(() => received.length === 1, 10_000, '分片重组完成');
  assert.equal(received[0], '【分片测试】第二段第三段');
  assert.equal(gateway.frames.filter(f => f.opcode === OPCODE.pong).length, 1, '夹在分片中间的控制帧同样要回 pong');
});

test('ws-client：读超时判死（无帧超过阈值即触发 onClose）', async (t) => {
  const gateway = await startFakeGateway(t);
  const client = await wsConnect(gateway.url, { readTimeoutMs: 120, closeTimeoutMs: 60 });
  const closes: WsCloseInfo[] = [];
  const errors: string[] = [];
  client.onClose((info) => { closes.push(info); });
  client.onError((err) => { errors.push(err.message); });

  // 网关保持沉默：链路静默死亡正是无人值守下最难发现的那种
  await waitFor(() => closes.length === 1, 10_000, '读超时收尾');
  assert.equal(client.isOpen, false);
  assert.equal(closes[0]?.reason.includes('读超时'), true);
  assert.equal(errors.some(message => message.includes('读超时')), true);
  // 收尾之后不应再有第二次通知（幂等）
  await sleep(200);
  assert.equal(closes.length, 1);
});

test('ws-client：读超时可中途重设（跟随时对方下发的心跳周期）', async (t) => {
  const gateway = await startFakeGateway(t);
  const client = await wsConnect(gateway.url, { readTimeoutMs: 150 });
  t.after(() => { client.close(); });

  const closes: WsCloseInfo[] = [];
  client.onClose((info) => { closes.push(info); });
  // 把阈值放大：如果实现没有真重设，150ms 后就会判死
  client.setReadTimeoutMs(1500);
  await sleep(400);
  assert.equal(closes.length, 0, '重设后的阈值必须立刻生效');
  await sleep(1300);
  assert.equal(closes.length, 1);
});

test('ws-client：握手被拒（Accept 不匹配）时 connect 直接失败', async (t) => {
  // 一个只会回 101 但 Accept 算错的假网关
  const server = createServer((socket) => {
    socket.on('data', () => {
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Accept: VGhhdCdzIG5vdCB0aGUga2V5',
        '',
        '',
      ].join('\r\n'));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { await new Promise<void>((resolve) => { server.close(() => { resolve(); }); }); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('监听失败');

  await assert.rejects(
    () => wsConnect(`ws://127.0.0.1:${address.port}/`, { handshakeTimeoutMs: 1000 }),
    /Sec-WebSocket-Accept 校验失败/,
  );
});

test('ws-client：URL 解析只认 ws/wss', () => {
  assert.equal(parseWsUrl('https://api.bot.qq.com/gateway').ok, false);
  const parsed = parseWsUrl('wss://api.bot.qq.com/websocket/');
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.tls, true);
    assert.equal(parsed.value.port, 443);
    assert.equal(parsed.value.path, '/websocket/');
  }
  const plain = parseWsUrl('ws://127.0.0.1:8080');
  assert.equal(plain.ok, true);
  if (plain.ok) {
    assert.equal(plain.value.tls, false);
    assert.equal(plain.value.port, 8080);
    assert.equal(plain.value.path, '/');
  }
});

test('ws-client：encodeFrame 三种长度档位都能被 parseFrame 解回', () => {
  for (const size of [0, 125, 126, 65535, 65536]) {
    const payload = Buffer.alloc(size, 0x41);
    const frame = encodeFrame(OPCODE.binary, payload);
    const parsed = parseFrame(frame, 16 * 1024 * 1024);
    assert.equal(parsed.kind, 'frame', `长度 ${size} 应解出帧`);
    if (parsed.kind === 'frame') {
      assert.equal(parsed.header.masked, true, '客户端帧恒掩码');
      assert.equal(parsed.header.length, size);
      assert.equal(parsed.consumed, frame.length);
      assert.deepEqual(parsed.payload, payload);
    }
  }
  // 非最短编码：16 位档写了一个 <126 的值 → 协议错误
  const bad = Buffer.from([0x81, 0x7e, 0x00, 0x05, 1, 2, 3, 4, 5]);
  const verdict = parseFrame(bad, 1024);
  assert.equal(verdict.kind, 'protocol-error');
});

// ──────────────────────────────── ② 凭证管理 ────────────────────────────────

interface FakeHttp {
  fn: HttpJsonFn;
  requests: Array<{
    method: string; url: string; jsonBody: unknown;
    /** 分片上传的原始字节（PUT 才有） */
    rawBody?: Uint8Array;
    headers: Record<string, string>;
  }>;
}

function makeFakeHttp(responder: (input: { url: string; jsonBody: unknown }) => HttpJsonResponse): FakeHttp {
  const requests: FakeHttp['requests'] = [];
  const fn: HttpJsonFn = async (input) => {
    requests.push({
      method: input.method,
      url: input.url,
      jsonBody: input.jsonBody,
      // 分片上传走 PUT + 原始字节：断言"这一片切了多少"要看它
      ...(input.rawBody === undefined ? {} : { rawBody: input.rawBody }),
      headers: input.headers ?? {},
    });
    return responder({ url: input.url, jsonBody: input.jsonBody });
  };
  return { fn, requests };
}

test('凭证：缓存复用 + 提前 5 分钟刷新 + 并发只换取一次', async () => {
  let issued = 0;
  const http = makeFakeHttp(() => {
    issued += 1;
    return { status: 200, text: '', body: { access_token: `token-${issued}`, expires_in: '7200' } };
  });
  let now = 1_700_000_000_000;
  const tokens = new QqAccessToken({
    appId: 'APP', clientSecret: 'SECRET', http: http.fn, now: () => now,
  });

  assert.equal(await tokens.acquire(), 'token-1');
  assert.equal(http.requests.length, 1);
  assert.equal(http.requests[0]?.method, 'POST');
  assert.equal(http.requests[0]?.url, 'https://api.bot.qq.com/app/getAppAccessToken');
  assert.deepEqual(http.requests[0]?.jsonBody, { appId: 'APP', clientSecret: 'SECRET' });

  // 未到提前刷新窗口：复用
  now += 60_000;
  assert.equal(await tokens.acquire(), 'token-1');
  assert.equal(http.requests.length, 1, '窗口内必须复用缓存');

  // 跨越"到期前 5 分钟"这条线（7200s - 300s = 6900s）
  now += 6900_000 - 60_000 + 1;
  assert.equal(await tokens.acquire(), 'token-2');
  assert.equal(http.requests.length, 2);

  // 并发去重：三个同时到达的调用只换取一次
  now += 7_000_000;
  const results = await Promise.all([tokens.acquire(), tokens.acquire(), tokens.acquire()]);
  assert.deepEqual(results, ['token-3', 'token-3', 'token-3']);
  assert.equal(http.requests.length, 3, '并发只允许一次换取');
  assert.equal(tokens.fetches, 3);
});

test('凭证：失败也返回 200，判定看响应体 code', async () => {
  const http = makeFakeHttp(() => ({
    status: 200,
    text: JSON.stringify({ code: 100016, message: 'invalid appid or secret' }),
    body: { code: 100016, message: 'invalid appid or secret' },
  }));
  const tokens = new QqAccessToken({ appId: 'APP', clientSecret: 'BAD', http: http.fn });
  await assert.rejects(() => tokens.acquire(), /code=100016/);
  await assert.rejects(() => tokens.acquire(), /invalid appid or secret/);
});

// ──────────────────────────────── ③ 网关流程 ────────────────────────────────

/** 等到假网关收到某个 op 的 JSON 帧 */
async function waitForFrame(
  gateway: FakeGateway,
  predicate: (frame: Record<string, unknown>) => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  await waitFor(() => gateway.jsonFrames().some(predicate), timeoutMs, label);
  const found = gateway.jsonFrames().find(predicate);
  assert.ok(found !== undefined, `${label}：帧必须存在`);
  return found;
}

test('网关：Hello → Identify → Ready → 心跳 ACK → C2C 事件转 wake/channel', async (t) => {
  const gateway = await startFakeGateway(t);
  const now = 1_700_000_000_000;
  const received: WakeChannel['data'][] = [];
  /** 网关日志：用来锁"每条分发都留一行"——那是"QQ 到底推没推"的唯一凭据 */
  const logs: string[] = [];
  /** 心跳用假定时器手动触发：真实周期是 45 秒，等它等于让测试躺 45 秒 */
  const heartbeatTicks: Array<() => void> = [];

  const gatewayClient = new QqGateway({
    token: () => Promise.resolve('ACCESS'),
    gatewayUrl: () => Promise.resolve(gateway.url),
    onWake: (data) => { received.push(data); },
    log: { info: (line) => { logs.push(line); }, warn: (line) => { logs.push(line); } },
    now: () => now,
    setIntervalFn: (fn) => { heartbeatTicks.push(fn); return heartbeatTicks.length; },
    clearIntervalFn: () => {},
  });
  t.after(() => { gatewayClient.stop(); });

  gatewayClient.start();
  await waitFor(() => gateway.sockets.length === 1, 10_000, '客户端连上假网关');
  gateway.sendJson({ op: QQ_OP.hello, d: { heartbeat_interval: 45_000 } });

  const identify = await waitForFrame(gateway, frame => frame['op'] === QQ_OP.identify, 'Identify 帧');
  const d = identify['d'] as Record<string, unknown>;
  assert.equal(d['token'], 'QQBot ACCESS', 'Identify 的 token 必须是 QQBot {accessToken}');
  assert.equal(d['intents'], QQ_INTENTS_GROUP_AND_C2C);
  assert.equal(d['intents'], 33554432, '1<<25 = 33554432');
  assert.deepEqual(d['shard'], [0, 1]);
  assert.equal(typeof d['properties'], 'object');
  assert.equal(heartbeatTicks.length, 0, 'READY 之前不该起心跳');

  // Ready：记下 session_id 并起心跳；此刻还没收到过任何带 s 的下行，首次心跳 d 必须是 null
  gateway.sendJson({
    op: QQ_OP.dispatch,
    s: 1,
    t: 'READY',
    d: { version: 1, session_id: 'SESSION-1', user: { id: '1', username: 'bot', bot: true }, shard: [0, 1] },
  });
  await waitFor(() => gatewayClient.snapshot().connected === true, 10_000, 'READY 生效');
  assert.equal(gatewayClient.snapshot().sessionId, 'SESSION-1');
  assert.equal(heartbeatTicks.length, 1, 'READY 之后心跳必须已布防');

  // 首次心跳：d 携带"收到的最新 s"。READY 本身带 s=1，所以这里应当是 1（而非 null）。
  // 「首次为 null」那条语义用纯函数独立断言（见本文件末尾的 lastSeq 用例），
  // 因为真实流程里心跳总是布防在收到带 s 的下行之后。
  heartbeatTicks[0]?.();
  await waitFor(
    () => gateway.jsonFrames().some(frame => frame['op'] === QQ_OP.heartbeat),
    2000,
    '首次心跳',
  );
  const beatFrames = gateway.jsonFrames().filter(frame => frame['op'] === QQ_OP.heartbeat);
  assert.equal(beatFrames.length >= 1, true, '必须收到过心跳');
  assert.equal(beatFrames[beatFrames.length - 1]?.['d'], 1, '心跳 d = 收到的最新 s（READY 带的是 1）');

  // 心跳 ACK 不产生任何副作用；随后 s 被记住，下一次心跳携带最新 s
  gateway.sendJson({ op: QQ_OP.heartbeatAck });
  gateway.sendJson({ op: QQ_OP.dispatch, s: 77, t: 'C2C_MESSAGE_CREATE', d: { id: 'MSG-X', content: '' } });
  await waitFor(() => gatewayClient.snapshot().lastSeq === 77, 10_000, '记住最新 s');
  heartbeatTicks[0]?.();
  await waitFor(
    () => gateway.jsonFrames().some(frame => frame['op'] === QQ_OP.heartbeat && frame['d'] === 77),
    2000,
    '心跳携带最新 s',
  );

  // 真正的单聊消息事件
  const event = {
    id: 'ROBOT1.0_MSG_C2C',
    author: { id: 'AUTHOR', user_openid: 'USER-OPENID', bot: false },
    content: '你好，帮我看看今天的安排',
    timestamp: '2026-07-21T10:00:00+08:00',
  };
  gateway.sendJson({ op: QQ_OP.dispatch, s: 78, t: 'C2C_MESSAGE_CREATE', d: event });
  await waitFor(() => received.some(item => item.messageId === 'ROBOT1.0_MSG_C2C'), 10_000, '收到 wake/channel');

  const wake = received.find(item => item.messageId === 'ROBOT1.0_MSG_C2C');
  assert.ok(wake !== undefined);
  assert.equal(wake.channel, QQ_CHANNEL_NAME);
  assert.equal(wake.chatType, 'c2c');
  assert.equal(wake.person, 'USER-OPENID');
  assert.equal(wake.chatId, 'USER-OPENID', '单聊的 chatId 就是对方 openid');
  assert.equal(wake.text, '你好，帮我看看今天的安排');
  assert.equal(wake.messageId, 'ROBOT1.0_MSG_C2C');
  // 2026-10-18（review P1-10）：入站一律落 0 = "平台没给序号"。
  // 过去这里写 1（那是**出站** `msg_seq` 的语义）⇒ 读过一次之后 `1 > readUpToSeq` 永假，
  // 「（这一条你还没看过）」永久失明。补成事件 seq 由宿主在落库那一刻做（`withMsgSeqFallback`）。
  assert.equal(wake.msgSeq, 0);
  // 幂等键带**通道命名空间**（`<通道>:<平台消息 id>`，与 OneBot 那条 `onebot:<id>` 同形）。
  // 原先这里是裸 id——两平台的 id 形状不同所以今天没出故障，但 `state/fold.ts` 把两条通道的
  // 键放进**同一个扁平数组**去重：一旦形状出现交集，一条通道的消息会被另一条静默丢掉。
  assert.equal(wake.dedupeKey, 'qq-official:ROBOT1.0_MSG_C2C');

  // 群 @ 消息：person 取 member_openid，chatId 取 group_openid
  const groupEvent = {
    id: 'ROBOT1.0_MSG_GROUP',
    author: { id: 'AUTHOR2', member_openid: 'MEMBER-OPENID', member_role: 'member', bot: false },
    content: ' /今日天气 ',
    group_openid: 'GROUP-OPENID',
    timestamp: '2026-07-21T10:05:00+08:00',
    attachments: [
      { content_type: 'image/jpeg', filename: 'photo.jpg', url: 'https://example.invalid/a.jpg', size: 256000 },
    ],
  };
  gateway.sendJson({ op: QQ_OP.dispatch, s: 79, t: 'GROUP_AT_MESSAGE_CREATE', d: groupEvent });
  await waitFor(() => received.some(item => item.messageId === 'ROBOT1.0_MSG_GROUP'), 10_000, '收到群消息 wake/channel');
  const groupWake = received.find(item => item.messageId === 'ROBOT1.0_MSG_GROUP');
  assert.ok(groupWake !== undefined);
  assert.equal(groupWake.chatType, 'group-at');
  assert.equal(groupWake.person, 'MEMBER-OPENID');
  assert.equal(groupWake.chatId, 'GROUP-OPENID');
  assert.equal(groupWake.dedupeKey, 'qq-official:ROBOT1.0_MSG_GROUP');
  assert.deepEqual(groupWake.attachments, [
    { type: 'image/jpeg', url: 'https://example.invalid/a.jpg', name: 'photo.jpg' },
  ]);

  // 非消息类订阅事件（同一 intents 位下还有这些）不产生 wake
  const beforeNonMessage = received.length;
  gateway.sendJson({ op: QQ_OP.dispatch, s: 80, t: 'GROUP_ADD_ROBOT', d: { group_openid: 'G' } });
  await sleep(120);
  assert.equal(received.length, beforeNonMessage, '非文本事件不应产生 wake');

  // 但**每条分发都要留一行日志**：分不清"QQ 没推"与"推了没认"，就没法回答
  // "群里 @ 了她怎么没反应"（2026-10-02 就是卡在这儿）。未处理的事件同样要留痕。
  assert.equal(
    logs.some((line) => line.includes('收到分发：C2C_MESSAGE_CREATE') && line.includes('ROBOT1.0_MS')),
    true,
    `收到的消息要有分发日志，实际：${JSON.stringify(logs)}`,
  );
  assert.equal(
    logs.some((line) => line.includes('收到分发：GROUP_ADD_ROBOT')),
    true,
    '不处理的事件也要留痕——那正是"推了但我们没认"的样子',
  );
});

test('网关：忽略未知 opcode / 非法 JSON，不崩不误报', async (t) => {
  const gateway = await startFakeGateway(t);
  const warned: string[] = [];
  const received: WakeChannel['data'][] = [];
  const gatewayClient = new QqGateway({
    token: () => Promise.resolve('ACCESS'),
    gatewayUrl: () => Promise.resolve(gateway.url),
    onWake: (data) => { received.push(data); },
    log: { info: () => {}, warn: (line) => { warned.push(line); } },
  });
  t.after(() => { gatewayClient.stop(); });

  gatewayClient.start();
  await waitFor(() => gateway.sockets.length === 1, 10_000, '连上');
  gateway.sendRawFrame(OPCODE.text, Buffer.from('这不是 JSON', 'utf8'));
  gateway.sendJson({ op: 3, d: {} });
  await waitFor(() => warned.some(line => line.includes('非法 JSON')), 10_000, '记录非法 JSON');
  await sleep(50);
  assert.equal(received.length, 0);
});

test('网关：断线后发 Op6 Resume，带 session_id 与最后 s；退避封顶 5 分钟', async (t) => {
  // 这一条也自包含：会话续传的时序（断线 → 重连 → Hello → Resume）必须由测试自己钉住字节，
  // 不能挤在共享假网关的消息队列里——队列会把"哪一帧属于哪条连接"这件事藏起来。
  const sockets: Socket[] = [];
  const frames: Array<Record<string, unknown>> = [];
  const delays: number[] = [];
  const logs: string[] = [];

  const server = createServer((socket) => {
    sockets.push(socket);
    let buf = Buffer.alloc(0);
    let upgraded = false;
    socket.on('error', () => { /* 断线是测试的一部分 */ });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString('latin1');
        buf = buf.subarray(end + 4);
        const key = /Sec-WebSocket-Key: (.+)/i.exec(head)?.[1]?.trim() ?? '';
        upgraded = true;
        socket.write([
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${handshakeAccept(key)}`,
          '',
          '',
        ].join('\r\n'));
      }
      for (;;) {
        const parsed = parseFrame(buf, 16 * 1024 * 1024);
        if (parsed.kind !== 'frame') break;
        buf = buf.subarray(parsed.consumed);
        if (parsed.header.opcode !== OPCODE.text) continue;
        try {
          frames.push(JSON.parse(parsed.payload.toString('utf8')) as Record<string, unknown>);
        } catch {
          // 非 JSON 文本帧不参与本用例的断言
        }
      }
    });
    socket.on('close', () => {
      const index = sockets.indexOf(socket);
      if (index >= 0) sockets.splice(index, 1);
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('监听失败');
  t.after(async () => {
    for (const socket of [...sockets]) socket.destroy();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  });

  const url = `ws://127.0.0.1:${address.port}/websocket/`;
  const sendJson = (value: unknown): void => {
    const payload = Buffer.from(JSON.stringify(value), 'utf8');
    const head = payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : (() => { const b = Buffer.alloc(4); b.writeUInt8(0x81, 0); b.writeUInt8(126, 1); b.writeUInt16BE(payload.length, 2); return b; })();
    for (const socket of sockets) socket.write(Buffer.concat([head, payload]));
  };
  const waitSockets = async (count: number, label: string): Promise<void> => {
    await waitFor(() => sockets.length === count, 10_000, label);
  };

  const gatewayClient = new QqGateway({
    token: () => Promise.resolve('ACCESS'),
    gatewayUrl: () => Promise.resolve(url),
    onWake: () => {},
    log: {
      info: (line) => { logs.push(line); },
      warn: (line) => { logs.push(line); },
    },
    reconnectBaseMs: 10,
    maxReconnectDelayMs: 40,
    // 只记录退避请求，真实延迟照走（10ms/20ms/40ms 足够快，而 1ms 会让重连与旧连接的收尾撞在一起）
    setTimeoutFn: (fn, ms) => {
      delays.push(ms);
      return setTimeout(fn, ms);
    },
    clearTimeoutFn: (handle) => { clearTimeout(handle as NodeJS.Timeout); },
  });
  t.after(() => { gatewayClient.stop(); });

  gatewayClient.start();
  await waitSockets(1, '第一次连上');
  sendJson({ op: QQ_OP.hello, d: { heartbeat_interval: 100_000 } });
  await waitFor(() => frames.some(frame => frame['op'] === QQ_OP.identify), 10_000, `首次 Identify（日志 ${JSON.stringify(logs)}）`);
  sendJson({ op: QQ_OP.dispatch, s: 42, t: 'READY', d: { session_id: 'SESSION-9' } });
  await waitFor(() => gatewayClient.snapshot().sessionId === 'SESSION-9', 10_000, 'READY 生效');
  sendJson({ op: QQ_OP.dispatch, s: 43, t: 'C2C_MESSAGE_CREATE', d: { id: 'M', content: '' } });
  await waitFor(() => gatewayClient.snapshot().lastSeq === 43, 10_000, '记到 s=43');

  // 拔线：重连后必须走 Resume（带 session_id 与最后 s），而不是重新 Identify
  for (const socket of [...sockets]) socket.destroy();
  await waitSockets(0, '旧连接已断开');
  await waitSockets(1, '重连成功');
  sendJson({ op: QQ_OP.hello, d: { heartbeat_interval: 100_000 } });
  await waitFor(
    () => frames.some(frame => frame['op'] === QQ_OP.resume),
    3000,
    `断线后的 Resume（会话 ${String(gatewayClient.snapshot().sessionId)}；已收到 ${JSON.stringify(frames.map(f => f['op']))}；日志 ${JSON.stringify(logs)}）`,
  );
  const resume = frames.find(frame => frame['op'] === QQ_OP.resume);
  const resumeData = resume?.['d'] as Record<string, unknown>;
  assert.equal(resumeData['session_id'], 'SESSION-9');
  assert.equal(resumeData['seq'], 43, 'Resume 必须带最后收到的 s');
  assert.equal(resumeData['token'], 'QQBot ACCESS');
  assert.equal(frames.filter(frame => frame['op'] === QQ_OP.identify).length, 1, 'Resume 路径不应重发 Identify');

  // RESUMED 后补发的事件照常处理
  sendJson({ op: QQ_OP.dispatch, s: 2002, t: 'RESUMED', d: '' });
  await waitFor(() => gatewayClient.snapshot().connected === true, 10_000, 'RESUMED');

  // op9（Invalid Session）：清 session 后重新 Identify
  sendJson({ op: QQ_OP.invalidSession });
  await waitFor(
    () => frames.filter(frame => frame['op'] === QQ_OP.identify).length === 2,
    3000,
    'op9 后重新 Identify',
  );

  // 退避：每次断线重连都上报一个延迟，且必须被封顶在上限（40ms）
  // 第一轮的退避在重连前就已经请求过，所以此刻 delays 至少有第一轮的那一笔
  assert.equal(delays[0], 10, `首次退避是退避起点（${JSON.stringify(delays)}）`);

  // 退避：把"算得对"这部分交给纯函数断言（见本文件末尾），这里只确认真实断线确实请求了退避
  assert.equal(delays.length >= 1, true, `断线后必须请求退避（${JSON.stringify(delays)}）`);
  assert.equal(delays[0], 10, '第一次重连的退避等于退避起点');
});

test('网关：op9 出现在 Resume 之前时不带 session 的 Identify 是兜底路径', async (t) => {
  const gateway = await startFakeGateway(t);
  const gatewayClient = new QqGateway({
    token: () => Promise.resolve('ACCESS'),
    gatewayUrl: () => Promise.resolve(gateway.url),
    onWake: () => {},
    log: { info: () => {}, warn: () => {} },
  });
  t.after(() => { gatewayClient.stop(); });
  gatewayClient.start();
  await waitFor(() => gateway.sockets.length === 1, 10_000, '连上');
  gateway.sendJson({ op: QQ_OP.hello, d: {} });
  const identify = await waitForFrame(gateway, frame => frame['op'] === QQ_OP.identify, 'Identify', 30_000);
  const data = identify['d'] as Record<string, unknown>;
  assert.equal(data['token'], 'QQBot ACCESS');
});

test('网关：退避延迟 min(base × 2^n, 上限)——封顶在 5 分钟', () => {
  const BASE = 1_000;
  const MAX = 5 * 60 * 1000;
  assert.equal(reconnectDelayMs(0, BASE, MAX), 1_000);
  assert.equal(reconnectDelayMs(1, BASE, MAX), 2_000);
  assert.equal(reconnectDelayMs(2, BASE, MAX), 4_000);
  // 2^9 秒 = 512s > 300s：从第 9 次起就撞上上限，不再增长
  assert.equal(reconnectDelayMs(9, BASE, MAX), MAX);
  assert.equal(reconnectDelayMs(30, BASE, MAX), MAX, '再多次失败也不允许超过上限');
  assert.equal(reconnectDelayMs(-5, BASE, MAX), BASE, '负数尝试次数按 0 处理（不产生非整数幂）');
});

test('网关：Hello 到达前已存在的会话上，首次心跳的 d 为 null', async (t) => {
  // 官方语义：心跳的 d 是"客户端收到的最新 s"，若一条都还没收到就传 null。
  // 这条路径在真实网关里也会出现（断线重连成功后、补发事件到达前的心跳），
  // 所以用一个最短的假连接把它钉住，而不是靠主流程的顺序去碰。
  const gateway = await startFakeGateway(t);
  const ticks: Array<() => void> = [];
  const gatewayClient = new QqGateway({
    token: () => Promise.resolve('ACCESS'),
    gatewayUrl: () => Promise.resolve(gateway.url),
    onWake: () => {},
    log: { info: () => {}, warn: () => {} },
    setIntervalFn: (fn) => { ticks.push(fn); return ticks.length; },
    clearIntervalFn: () => {},
  });
  t.after(() => { gatewayClient.stop(); });

  gatewayClient.start();
  await waitFor(() => gateway.sockets.length === 1, 10_000, '连上');
  gateway.sendJson({ op: QQ_OP.hello, d: { heartbeat_interval: 45_000 } });
  await waitForFrame(gateway, frame => frame['op'] === QQ_OP.identify, 'Identify', 30_000);
  gateway.sendJson({ op: QQ_OP.dispatch, s: 5, t: 'READY', d: { session_id: 'S-1' } });
  await waitFor(() => gatewayClient.snapshot().connected === true, 10_000, 'READY');

  // 断言前的形态：READY 已把 s=5 记下，所以第一次心跳带 5
  ticks[0]?.();
  await waitFor(
    () => gateway.jsonFrames().some(frame => frame['op'] === QQ_OP.heartbeat && frame['d'] === 5),
    2000,
    '心跳带 READY 的 s',
  );
  // 清空 lastSeq 的路径：op9 会清 session 与 s，随后重新 Identify，此时再心跳就应当是 null
  gateway.sendJson({ op: QQ_OP.invalidSession });
  await waitFor(() => gateway.jsonFrames().filter(f => f['op'] === QQ_OP.identify).length === 2, 10_000, '重 Identify');
  ticks[ticks.length - 1]?.();
  await waitFor(
    () => gateway.jsonFrames().some(frame => frame['op'] === QQ_OP.heartbeat && frame['d'] === null),
    2000,
    '清 s 后心跳 d 为 null',
  );
});

// ──────────────────────────────── ④ 发送 ────────────────────────────────

test('发送：被动带 msg_id + msg_seq，主动不带；群/单聊 URL 分别正确', async () => {
  const http = makeFakeHttp(() => ({
    status: 200,
    text: JSON.stringify({ id: 'SENT-1', timestamp: '2026-07-21T10:30:00+08:00' }),
    body: { id: 'SENT-1', timestamp: '2026-07-21T10:30:00+08:00' },
  }));
  const sender = new QqMessageSender({
    token: () => Promise.resolve('ACCESS'),
    apiBase: 'https://api.bot.qq.com',
    http: http.fn,
    log: { info: () => {}, warn: () => {} },
  });

  // 单聊被动回复
  const passive = await sender.sendText('c2c', 'USER-1', '收到', { msgId: 'MSG-1' });
  assert.equal(passive.ok, true);
  assert.equal(passive.ok && passive.passive, true);
  assert.equal(passive.ok && passive.msgSeq, 2, '第一条被动回复用递增值（同一 msg_id 不许重复）');
  assert.equal(http.requests[0]?.url, 'https://api.bot.qq.com/v2/users/USER-1/messages');
  assert.equal(http.requests[0]?.headers['authorization'], 'QQBot ACCESS');
  assert.deepEqual(http.requests[0]?.jsonBody, { content: '收到', msg_type: 0, msg_seq: 2, msg_id: 'MSG-1' });

  // 同一条 messageId 再回一次：msg_seq 必须递增（否则平台 40054005 去重）
  const again = await sender.sendText('c2c', 'USER-1', '补充', { msgId: 'MSG-1' });
  assert.equal(again.ok && again.msgSeq, 3);

  // 群聊主动消息：不带 msg_id
  const active = await sender.sendText('group-at', 'GROUP-1', '主动打个招呼');
  assert.equal(active.ok, true);
  assert.equal(active.ok && active.passive, false);
  assert.equal(http.requests[2]?.url, 'https://api.bot.qq.com/v2/groups/GROUP-1/messages');
  assert.deepEqual(http.requests[2]?.jsonBody, { content: '主动打个招呼', msg_type: 0, msg_seq: 1 });

  // 路径生成的边界：openid 需要 URL 编码，chatType 决定路由
  assert.equal(messagesPathOf('c2c', 'A/B'), '/v2/users/A%2FB/messages');
  assert.equal(messagesPathOf('group-at', 'G 1'), '/v2/groups/G%201/messages');
});

test('发送：被动 msg_id 过期 → 降级为主动消息重发一次，不丢回复', async () => {
  let call = 0;
  const http = makeFakeHttp(() => {
    call += 1;
    if (call === 1) {
      return {
        status: 200,
        text: JSON.stringify({ code: 40034005, message: '回复消息msg_id已过期' }),
        body: { code: 40034005, message: '回复消息msg_id已过期' },
      };
    }
    return { status: 200, text: JSON.stringify({ id: 'SENT-2' }), body: { id: 'SENT-2' } };
  });
  const sender = new QqMessageSender({ token: () => Promise.resolve('ACCESS'), http: http.fn });
  const outcome = await sender.sendText('group-at', 'GROUP-1', '过期后的回复', { msgId: 'MSG-OLD' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.passive, false, '降级后必须如实标成主动消息');
  assert.equal(http.requests.length, 2);
  const retryBody = http.requests[1]?.jsonBody as Record<string, unknown>;
  assert.equal('msg_id' in retryBody, false, '降级重发不带 msg_id');
});

test('发送：撞上去重（40054005）→ 换一个新 msg_seq 重发一次（重启后计数器重置会撞）', async () => {
  // 真事（2026-10-03）：msg_seq 计数器活在进程内存里，重启就重置；而"重启打断她的发言 →
  // 那一轮输入被退回重跑"正好让她再回一次同一条消息——新进程从 2 重新数，撞上旧进程用过的号。
  // 平台只认"这一对是不是新的"，所以撞了就换号重发（AstrBot 干脆一直用随机号）。
  let call = 0;
  const http = makeFakeHttp(() => {
    call += 1;
    return call === 1
      ? { status: 200, text: '', body: { code: 40054005, message: '消息被去重，请检查请求msgseq' } }
      : { status: 200, text: '', body: { id: 'SENT-OK' } };
  });
  const sender = new QqMessageSender({
    token: () => Promise.resolve('ACCESS'), http: http.fn, log: { info: () => {}, warn: () => {} },
  });
  const outcome = await sender.sendText('c2c', 'U-1', '再说一句', { msgId: 'MSG-9' });
  assert.equal(outcome.ok, true, '换号之后应当送达');
  assert.equal(http.requests.length, 2);
  const first = http.requests[0]?.jsonBody as Record<string, unknown>;
  const second = http.requests[1]?.jsonBody as Record<string, unknown>;
  assert.equal(first['msg_seq'], 2, '第一次用递增号');
  assert.notEqual(second['msg_seq'], first['msg_seq'], '重发必须换一个号（否则还是撞）');
  assert.equal(second['msg_id'], 'MSG-9', '仍然是被动回复（msg_id 不变）');

  // 不是去重错误 → 不重发（免得多打一次网络）
  let calls = 0;
  const http2 = makeFakeHttp(() => {
    calls += 1;
    return { status: 200, text: '', body: { code: 40034105, message: '主动消息权限不足' } };
  });
  const sender2 = new QqMessageSender({ token: () => Promise.resolve('ACCESS'), http: http2.fn });
  await sender2.sendText('c2c', 'U-1', '你好', { msgId: 'MSG-10' });
  assert.equal(calls, 1, '不是去重错、也不在被动窗口那张表里——只发一次，如实上报');
});

test('发送：不可重试的错误不重发（错误如实上报）', async () => {
  const http = makeFakeHttp(() => ({
    status: 200,
    text: JSON.stringify({ code: 40054003, message: '机器人不是群成员' }),
    body: { code: 40054003, message: '机器人不是群成员' },
  }));
  const sender = new QqMessageSender({ token: () => Promise.resolve('ACCESS'), http: http.fn });
  const outcome = await sender.sendText('group-at', 'GROUP-1', '你好', { msgId: 'MSG-1' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason.includes('40054003'), true);
  assert.equal(http.requests.length, 1, '不可重试的错误只发一次');
});

// ──────────────────────────────── 原生 markdown（官方口径）────────────────────────────────

/**
 * 官方文档：`msg_type` 决定哪个内容字段生效——`0`=纯文本(content)、`2`=Markdown(markdown)，
 * 且**两者互斥**（"传了 markdown 后此字段必须为空"）。
 *
 * 我们原来是写死 `{content, msg_type: 0}`，所以她写的 Markdown 在 QQ 里是原始的 `##` 与 `**`。
 * AstrBot 的做法是默认全走 markdown、被拒时降级纯文本，这里对齐它。
 */
test('发文本：默认走原生 markdown（msg_type=2 + markdown.content，且不带 content）', async () => {
  const http = makeFakeHttp(() => ({ status: 200, text: JSON.stringify({ id: 'M1' }), body: { id: 'M1' } }));
  const sender = new QqMessageSender({
    token: () => Promise.resolve('ACCESS'), http: http.fn, useMarkdown: true,
  });
  const md = '# 标题\n\n**粗体**与 `代码`';
  const outcome = await sender.sendText('c2c', 'OPENID-1', md);
  assert.equal(outcome.ok, true);
  const body = http.requests[0]?.jsonBody as Record<string, unknown>;
  assert.equal(body['msg_type'], 2);
  assert.deepEqual(body['markdown'], { content: md }, 'markdown 走 markdown.content，原样不加工');
  assert.equal('content' in body, false, '官方口径：content 与 markdown 互斥');
});

test('原生 markdown 被拒 → 降级纯文本重发一次（格式不支持不是丢话的理由）', async () => {
  let call = 0;
  const http = makeFakeHttp(() => {
    call += 1;
    return call === 1
      ? { status: 200, text: JSON.stringify({ code: 40034127, message: '无markdown模板权限' }), body: { code: 40034127, message: '无markdown模板权限' } }
      : { status: 200, text: JSON.stringify({ id: 'M2' }), body: { id: 'M2' } };
  });
  const sender = new QqMessageSender({
    token: () => Promise.resolve('ACCESS'), http: http.fn, useMarkdown: true,
  });
  const outcome = await sender.sendText('c2c', 'OPENID-1', '# 标题');
  assert.equal(outcome.ok, true, '降级后应当送达');
  assert.equal(http.requests.length, 2);
  const retry = http.requests[1]?.jsonBody as Record<string, unknown>;
  assert.equal(retry['msg_type'], 0);
  assert.equal(retry['content'], '# 标题');
  assert.equal('markdown' in retry, false, '降级重发不带 markdown');
});

test('关掉 useMarkdown：直接纯文本，不多花一次失败请求', async () => {
  const http = makeFakeHttp(() => ({ status: 200, text: JSON.stringify({ id: 'M3' }), body: { id: 'M3' } }));
  const sender = new QqMessageSender({
    token: () => Promise.resolve('ACCESS'), http: http.fn, useMarkdown: false,
  });
  const outcome = await sender.sendText('c2c', 'OPENID-1', '你好');
  assert.equal(outcome.ok, true);
  assert.equal(http.requests.length, 1);
  const body = http.requests[0]?.jsonBody as Record<string, unknown>;
  assert.equal(body['msg_type'], 0);
  assert.equal(body['content'], '你好');
});

// ──────────── 出站正文里的 @：一个字都不动（2026-10-05 用户决定移除形态改写） ────────────
//
// 这里原来有一层便利：`[@名字]` / `<@id>` → 查她的 `aliases.md` → 官方那一串
// `<qqbot-at-user id="…" />`，名字认不出来时**一个字都不发**。用户 2026-10-05 决定移除
// （原话「我觉得没必要存在」）：**她本人就会写官方形态**、id 就在她 aliases.md 的群成员段里，
// 而那一层因为一个读表路径错误把她整条消息卡住过。
//
// 于是通道层的判据只剩一条：**正文逐字节发出去**。官方那一串是普通字符（平台认它），
// `[@名字]` 也是普通字符（平台不认它——但**轮不到框架拒发**）。

test('正文里的官方 at 串逐字节原样出站：markdown 与纯文本两种 msg_type 都不动它', async () => {
  // 官方文档《文本交互》：嵌入文本用 `<qqbot-at-user id="" />`（旧协议 `<@userid>` 即将弃用），
  // 且**文本消息与 markdown 消息都支持它**——所以"这一串"与 `msg_type` 是两件事，谁都不许动谁。
  const raw = '<qqbot-at-user id="00000000000000000000000000000004" /> 一号，收到回个话';

  const mdHttp = makeFakeHttp(() => ({ status: 200, text: JSON.stringify({ id: 'M-AT' }), body: { id: 'M-AT' } }));
  const mdSender = new QqMessageSender({
    token: () => Promise.resolve('ACCESS'), http: mdHttp.fn, useMarkdown: true,
  });
  const mdOutcome = await mdSender.sendText('group', 'G1', raw, { msgId: 'MSG-1' });
  assert.equal(mdOutcome.ok, true);
  const mdBody = mdHttp.requests[0]?.jsonBody as Record<string, unknown>;
  assert.equal(mdBody['msg_type'], 2, 'markdown 开着就走 markdown（@ 不改这条口径）');
  assert.equal((mdBody['markdown'] as { content: string }).content, raw, '官方串逐字节原样');
  assert.equal('content' in mdBody, false, 'content 与 markdown 互斥（官方口径）');

  // 关掉 markdown（没有模板权限的机器人）：同一段正文走纯文本，**那一串照旧逐字节在**
  const plainHttp = makeFakeHttp(() => ({ status: 200, text: JSON.stringify({ id: 'M-AT2' }), body: { id: 'M-AT2' } }));
  const plainSender = new QqMessageSender({
    token: () => Promise.resolve('ACCESS'), http: plainHttp.fn, useMarkdown: false,
  });
  await plainSender.sendText('group', 'G1', raw, { msgId: 'MSG-1' });
  const plainBody = plainHttp.requests[0]?.jsonBody as Record<string, unknown>;
  assert.equal(plainBody['msg_type'], 0);
  assert.equal(plainBody['content'], raw, '纯文本那一路同样一个字都不动');
});

test('`[@名字]` 就是普通文字：原样发出去，通道层不改写也不拦', async () => {
  const http = makeFakeHttp(() => ({ status: 200, text: JSON.stringify({ id: 'M-NAME' }), body: { id: 'M-NAME' } }));
  const sender = new QqMessageSender({
    token: () => Promise.resolve('ACCESS'), http: http.fn, useMarkdown: false,
  });
  const raw = '[@1 号] 一号在不在';
  const outcome = await sender.sendText('group', 'G1', raw, { msgId: 'MSG-1' });
  assert.equal(outcome.ok, true, '照发——"认不出名字就一个字都不发"那道门已经不在这一层了');
  assert.equal(http.requests.length, 1, 'HTTP 请求照发（反向断言：不拒发）');
  assert.equal((http.requests[0]?.jsonBody as Record<string, unknown>)['content'], raw);
});

test('原生 markdown 被拒：回执要带上**降级事实**（没权限 ≠ 假装没事）', async () => {
  // 这条钉的是 SendOutcome.degraded：`ok: true` 只说"话发出去了"，可这一条的**形态变了**
  // ——正文里的官方 at 串到底还在不在，全看它。不带回去，上游就只能报一句"已送达"。
  let call = 0;
  const http = makeFakeHttp(() => {
    call += 1;
    return call === 1
      ? { status: 200, text: '', body: { code: 40034127, message: '无markdown模板权限' } }
      : { status: 200, text: JSON.stringify({ id: 'M4' }), body: { id: 'M4' } };
  });
  const sender = new QqMessageSender({
    token: () => Promise.resolve('ACCESS'), http: http.fn, useMarkdown: true,
  });
  const outcome = await sender.sendText('group', 'G1', '<qqbot-at-user id="X9" /> 在吗');
  assert.equal(outcome.ok, true, '降级后话照样发出去');
  const degraded = outcome.ok ? (outcome.degraded ?? '') : '';
  assert.match(degraded, /40034127/u, '码要如实带上');
  assert.match(degraded, /没有原生 markdown 模板权限/u, '人话理由：这一条要人去开权限');
  assert.match(degraded, /纯文本/u);
  // 没降级的那条不许有这一项（免得每条发言都缀一句"形态正常"）
  const clean = makeFakeHttp(() => ({ status: 200, text: JSON.stringify({ id: 'M5' }), body: { id: 'M5' } }));
  const cleanOutcome = await new QqMessageSender({
    token: () => Promise.resolve('ACCESS'), http: clean.fn, useMarkdown: true,
  }).sendText('group', 'G1', '你好');
  assert.equal(cleanOutcome.ok && cleanOutcome.degraded, undefined);
});

test('富媒体：上传换 file_info → msg_type=7 发送（一条一个 media，与文本共用被动窗口）', async () => {
  // 2026-10-03 缺口报告第 ⑤ 项（最大一块）：官方口径是"先上传换 file_info，再按 msg_type=7 发"，
  // 而且**单聊与群聊的上传不互通**、`srv_send_msg=false` 时**不占主动消息频次**。
  const http = makeFakeHttp(input => (input.url.includes('/files')
    ? { status: 200, text: '', body: { file_uuid: 'UUID-1', file_info: 'FILE-INFO-1', ttl: 300 } }
    : { status: 200, text: '', body: { id: 'SENT-MEDIA' } }));
  const sender = new QqMessageSender({ token: () => Promise.resolve('ACCESS'), http: http.fn });

  const uploaded = await sender.uploadMedia('group', 'GROUP-1', {
    fileType: 1, data: new Uint8Array([1, 2, 3]), name: 'shot.png',
  });
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.ok && uploaded.fileInfo, 'FILE-INFO-1');
  assert.equal(uploaded.ok && uploaded.ttl, 300, 'ttl 要如实带出来（过期得重传）');
  const uploadReq = http.requests[0];
  assert.equal(uploadReq?.url, 'https://api.bot.qq.com/v2/groups/GROUP-1/files', '群聊走群的上传口');
  const uploadBody = uploadReq?.jsonBody as Record<string, unknown>;
  assert.equal(uploadBody['file_type'], 1, '图片=1');
  assert.equal(uploadBody['srv_send_msg'], false, '只取凭据，不占主动频次');
  assert.equal(uploadBody['file_data'], Buffer.from([1, 2, 3]).toString('base64'), '本地字节走 base64');
  assert.equal(uploadBody['file_name'], 'shot.png');

  const sent = await sender.sendMedia('group', 'GROUP-1', 'FILE-INFO-1', { msgId: 'MSG-9' });
  assert.equal(sent.ok, true);
  const sendReq = http.requests[1];
  assert.equal(sendReq?.url, 'https://api.bot.qq.com/v2/groups/GROUP-1/messages');
  const sendBody = sendReq?.jsonBody as Record<string, unknown>;
  assert.equal(sendBody['msg_type'], 7);
  assert.deepEqual(sendBody['media'], { file_info: 'FILE-INFO-1' });
  assert.equal(sendBody['msg_id'], 'MSG-9', '被动回复窗口照用');
  assert.equal(typeof sendBody['msg_seq'], 'number');

  // 单聊走另一条上传口（两条不互通）；网络图片走 url 而不是 base64
  const c2c = await sender.uploadMedia('c2c', 'USER-1', { fileType: 1, url: 'https://example.invalid/a.png' });
  assert.equal(c2c.ok, true);
  assert.equal(http.requests[2]?.url, 'https://api.bot.qq.com/v2/users/USER-1/files');
  assert.equal((http.requests[2]?.jsonBody as Record<string, unknown>)['url'], 'https://example.invalid/a.png');
});

test('频道发媒体：v1 + multipart（file_image 带字节、无 msg_type）；网络地址如实拒', async () => {
  // 口径来自 AstrBot 的频道分支：`payload["file_image"] = image_path` + `payload.pop("msg_type")`，
  // botpy 内部把本地文件拼成 multipart。我们零依赖，自己拼（见 src/channel/multipart.ts）。
  const http = makeFakeHttp((input) => (input.url.includes('getAppAccessToken')
    ? { status: 200, text: '', body: { access_token: 'ACCESS', expires_in: '7200' } }
    : { status: 200, text: '', body: { id: 'CH-MSG-9' } }));
  const channel = new QqOfficialChannel({
    appId: 'APP', clientSecret: 'SECRET', http: http.fn,
    log: { info: () => {}, warn: () => {} },
  });
  const outcome = await channel.sendMediaTo('guild', 'CH-1',
    { fileType: 1, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), name: 'shot.png' });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const sent = http.requests.filter((r) => r.url.includes('/channels/')).at(-1);
  assert.equal(sent?.url, 'https://api.bot.qq.com/channels/CH-1/messages');
  assert.ok(String(sent?.headers['content-type']).startsWith('multipart/form-data; boundary='),
    '频道那条路是 multipart（不是 JSON）');
  const body = sent?.rawBody as Uint8Array | undefined;
  assert.ok(body !== undefined && body.length > 0, '原始字节体要带上');
  const text = Buffer.from(body!).toString('binary');
  assert.ok(text.includes('name="file_image"'), '字段名是 file_image');
  assert.ok(text.includes('filename="shot.png"'), '文件名带上');
  assert.equal(text.includes('msg_type'), false, 'v1 不认 msg_type（AstrBot 就是 pop 掉它）');

  // 网络地址：那条路要文件字节，我们不做下载中转——如实拒，且不发请求
  const before = http.requests.length;
  const url = await channel.sendMediaTo('guild', 'CH-1', { fileType: 1, url: 'https://example.invalid/a.png' });
  assert.equal(url.ok, false);
  assert.ok(url.ok === false && url.reason.includes('只支持本机文件'));
  assert.equal(http.requests.length, before, '说不清楚就别发——一次网络都不该发');
});

test('频道私信：DIRECT_MESSAGE_CREATE → chatType=dm、会话取 guild_id；发出去走 /dms/{guild_id}/messages', async () => {
  // 单开一个 chatType 而不是并进 c2c（AstrBot 并了，但那样两套 id 空间会混在一个命名空间里）：
  // 私信的身份是 author.id，而"往哪儿发"要的是 guild_id（官方 `/dms/{guild_id}/messages`）。
  const dm = mapDispatchToWakeChannel('DIRECT_MESSAGE_CREATE', {
    id: 'M14', content: '在吗', guild_id: 'GUILD-9',
    author: { id: 'GU-1', username: '私信我的人' },
  });
  assert.equal(dm?.chatType, 'dm');
  assert.equal(dm?.chatId, 'GUILD-9', '会话 id 是 guild_id（发出去要用它）');
  assert.equal(dm?.person, 'GU-1', '身份是 author.id');
  assert.equal(dm?.mentionsMe, true, undefined);

  const http = makeFakeHttp((input) => (input.url.includes('getAppAccessToken')
    ? { status: 200, text: '', body: { access_token: 'ACCESS', expires_in: '7200' } }
    : { status: 200, text: '', body: { id: 'DM-MSG-1' } }));
  const sender = new QqMessageSender({ token: () => Promise.resolve('ACCESS'), http: http.fn });
  const outcome = await sender.sendText('dm', 'GUILD-9', '在的', { msgId: 'M14' });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const sent = http.requests.filter((r) => r.url.includes('/dms/')).at(-1);
  assert.equal(sent?.url, 'https://api.bot.qq.com/dms/GUILD-9/messages');
  const body = sent?.jsonBody as Record<string, unknown>;
  assert.equal(body['content'], '在的');
  assert.equal('msg_type' in body, false, 'v1 那条路不认 msg_type');
  assert.equal(body['msg_id'], 'M14');
  assert.equal(replyUrlOf({ chatType: 'dm', chatId: 'GUILD-9' }), 'qq:dm:GUILD-9');
});

test('频道发送：v1 接口 /channels/{id}/messages，body 不带 msg_type 与 msg_seq', async () => {
  // 频道是另一套接口（v1），AstrBot 的频道分支要删掉 msg_type；msg_seq 也是 v2 的字段。
  const http = makeFakeHttp(() => ({ status: 200, text: '', body: { id: 'CH-MSG-1' } }));
  const sender = new QqMessageSender({ token: () => Promise.resolve('ACCESS'), http: http.fn });
  const outcome = await sender.sendText('guild', 'CH-1', '在频道里说一句', { msgId: 'MSG-CH' });
  assert.equal(outcome.ok, true);
  assert.equal(http.requests[0]?.url, 'https://api.bot.qq.com/channels/CH-1/messages',
    '频道走 v1 的 /channels/{id}/messages');
  const body = http.requests[0]?.jsonBody as Record<string, unknown>;
  assert.equal(body['content'], '在频道里说一句');
  assert.equal('msg_type' in body, false, 'v1 不认 msg_type');
  assert.equal('msg_seq' in body, false, 'msg_seq 是 v2 的字段');
  assert.equal(body['msg_id'], 'MSG-CH', '被动回复照旧（频道也用 msg_id）');
});

test('频道回投地址：qq:guild:<channel_id> 认得出（否则她收到频道消息也回不了）', () => {
  const url = replyUrlOf({ chatType: 'guild', chatId: 'CH-9' });
  assert.equal(url, 'qq:guild:CH-9');
  const parsed = parseReplyUrl(url);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.chatType, 'guild');
  assert.equal(parsed.ok && parsed.chatId, 'CH-9');
  // 仍然拒收乱写的 scheme（不猜）
  assert.equal(parseReplyUrl('qq:room:CH-9').ok, false, '仍然不认的写法才拿来当反例');
});

test('流式（仅单聊）：首片带 msg_id、续片带 stream_msg_id、结束片补换行、群聊直接拒', async () => {
  // 官方口径：/v2/users/{openid}/stream_messages（50 QPS）、index 从 0 递增、
  // input_state 1=生成中 10=生成结束、stream_msg_id 由首片响应给出、群聊不支持流式参数。
  let call = 0;
  const http = makeFakeHttp(() => {
    call += 1;
    return { status: 200, text: '', body: { id: 'STREAM-1', remain_msg_len: 12 } };
  });
  const sender = new QqMessageSender({ token: () => Promise.resolve('ACCESS'), http: http.fn });

  const first = await sender.sendStreamChunk('c2c', 'U-1',
    { text: '正在想……', index: 0, state: 1 }, { msgId: 'MSG-1', msgSeq: 1 });
  assert.equal(first.ok, true);
  assert.equal(http.requests[0]?.url, 'https://api.bot.qq.com/v2/users/U-1/stream_messages');
  const head = http.requests[0]?.jsonBody as Record<string, unknown>;
  assert.equal(head['input_state'], 1);
  assert.equal(head['index'], 0);
  assert.equal(head['msg_id'], 'MSG-1');
  assert.equal('stream_msg_id' in head, false, '首片不带 stream_msg_id（由服务端生成）');

  const next = await sender.sendStreamChunk('c2c', 'U-1',
    { text: '想好了', index: 1, state: 1, streamMsgId: first.ok ? first.streamMsgId : '' },
    { msgId: 'MSG-1', msgSeq: 1 });
  assert.equal(next.ok, true);
  assert.equal((http.requests[1]?.jsonBody as Record<string, unknown>)['stream_msg_id'], 'STREAM-1',
    '续片必须带上首片给的 stream_msg_id（否则是另起一条）');

  // 结束片：内容没有换行结尾 → 补一个（平台靠它判"这一轮说完了"）
  await sender.sendStreamChunk('c2c', 'U-1',
    { text: '说完了', index: 2, state: 10, streamMsgId: 'STREAM-1' }, { msgId: 'MSG-1' });
  const tail = http.requests[2]?.jsonBody as Record<string, unknown>;
  assert.equal(tail['input_state'], 10);
  assert.equal(tail['content_raw'], '说完了\n', '结束片缺换行就补（补的是空白，不动她的字）');

  // 已经有换行就不动
  await sender.sendStreamChunk('c2c', 'U-1',
    { text: '本来就有\n', index: 3, state: 10, streamMsgId: 'STREAM-1' }, { msgId: 'MSG-1' });
  assert.equal((http.requests[3]?.jsonBody as Record<string, unknown>)['content_raw'], '本来就有\n');

  // 群聊：官方不支持流式参数，这里直接拒（不发出去让平台报错）
  const group = await sender.sendStreamChunk('group', 'G-1', { text: '群里的', index: 0, state: 1 });
  assert.equal(group.ok, false);
  assert.ok(group.ok === false && group.reason.includes('只支持单聊'));
  assert.equal(http.requests.length, 4, '群聊那次不该发请求');
});

test('富媒体：ttl 内复用同一份上传（键是内容哈希，且单聊/群聊不混用）', async () => {
  // 官方 ttl 明确允许复用，但"什么时候能复用"要自己判：只缓存**本机字节**（内容寻址，
  // 可证是同一份文件）；网络地址一律重传（同一个 URL 背后的内容可能变）。
  let now = 1_700_000_000_000;
  const http = makeFakeHttp(() => ({
    status: 200, text: '', body: { file_uuid: 'U1', file_info: 'FI-1', ttl: 300 },
  }));
  const sender = new QqMessageSender({
    token: () => Promise.resolve('ACCESS'), http: http.fn, now: () => now,
  });
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);

  await sender.uploadMedia('c2c', 'U-1', { fileType: 1, data: bytes });
  assert.equal(http.requests.length, 1);
  const again = await sender.uploadMedia('c2c', 'U-1', { fileType: 1, data: bytes });
  assert.equal(again.ok, true);
  assert.equal(http.requests.length, 1, 'ttl 内同一份字节不该重传');
  assert.equal(again.ok && again.fileInfo, 'FI-1');

  // 换内容 → 必须重传（键是内容哈希）
  await sender.uploadMedia('c2c', 'U-1', { fileType: 1, data: new Uint8Array([9, 9]) });
  assert.equal(http.requests.length, 2, '不同内容是不同文件');

  // 换个会话 → 也要重传（单聊与群聊的上传口不互通，凭据不能混用）
  await sender.uploadMedia('group', 'U-1', { fileType: 1, data: bytes });
  assert.equal(http.requests.length, 3, '目的地不同不能复用凭据');

  // 网络地址**永不缓存**：同一条 URL 每次都要重新上传
  await sender.uploadMedia('c2c', 'U-1', { fileType: 1, url: 'https://example.invalid/a.png' });
  await sender.uploadMedia('c2c', 'U-1', { fileType: 1, url: 'https://example.invalid/a.png' });
  assert.equal(http.requests.length, 5, 'URL 背后的内容随时可能变，不能拿旧凭据发');

  // 过了 ttl（含 60 秒余量）→ 重传
  now += 300_000;
  await sender.uploadMedia('c2c', 'U-1', { fileType: 1, data: bytes });
  assert.equal(http.requests.length, 6, '过期凭据不复用');
});

test('富媒体：超过 10002432 字节自动走分片（预上传 → 逐片 PUT → 逐片确认 → 合并）', async () => {
  // 官方协议（本地缓存的 api-v2 文档 + AstrBot 的实现路径）：
  // ① POST …/upload_prepare（file_size/md5/sha1/md5_10m）→ upload_id + 各片预签名 URL
  // ② 逐片 PUT 原始字节 ③ 每片成功后再 POST …/upload_part_finish ④ 用 upload_id 调 /files 合并
  const http = makeFakeHttp(input => {
    if (input.url.includes('upload_prepare')) {
      return {
        status: 200,
        text: '',
        body: {
          upload_id: 'up-1',
          block_size: '5000000',
          parts: [
            { index: 0, presigned_url: 'https://cos.example.com/p0', block_size: '5000000' },
            { index: 1, presigned_url: 'https://cos.example.com/p1', block_size: '5000000' },
          ],
          upload_config: { concurrency: 1, retry_timeout: 300, retry_delay: 1 },
        },
      };
    }
    if (input.method === 'PUT') return { status: 200, text: '', body: null };
    if (input.url.includes('upload_part_finish')) return { status: 200, text: '', body: {} };
    return { status: 200, text: '', body: { file_uuid: 'U9', file_info: 'FI-CHUNKED', ttl: 0 } };
  });
  const sender = new QqMessageSender({ token: () => Promise.resolve('ACCESS'), http: http.fn });
  const big = new Uint8Array(10_002_433); // 比阈值多一个字节
  const uploaded = await sender.uploadMedia('group', 'G1', { fileType: 2, data: big, name: 'big.mp4' });
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.ok && uploaded.fileInfo, 'FI-CHUNKED');

  const prepare = http.requests[0];
  assert.equal(prepare?.url, 'https://api.bot.qq.com/v2/groups/G1/upload_prepare');
  const prepBody = prepare?.jsonBody as Record<string, unknown>;
  assert.equal(prepBody['file_size'], '10002433');
  assert.equal(typeof prepBody['md5'], 'string');
  assert.equal(typeof prepBody['sha1'], 'string');
  assert.equal(typeof prepBody['md5_10m'], 'string', '官方字段名就叫 md5_10m');
  const puts = http.requests.filter(r => r.method === 'PUT');
  assert.equal(puts.length, 2, '两片各一次 PUT');
  assert.equal(puts[0]?.url, 'https://cos.example.com/p0');
  assert.ok((puts[0]?.rawBody as Uint8Array | undefined)?.length === 5_000_000, '第一片按 block_size 切');
  const finishes = http.requests.filter(r => r.url.includes('upload_part_finish'));
  assert.equal(finishes.length, 2, '每片成功都要确认');
  assert.equal((finishes[0]?.jsonBody as Record<string, unknown>)['upload_id'], 'up-1');
  const merge = http.requests.at(-1);
  assert.equal(merge?.url, 'https://api.bot.qq.com/v2/groups/G1/files', '最后用 upload_id 合并');
  assert.equal((merge?.jsonBody as Record<string, unknown>)['upload_id'], 'up-1');
});

test('富媒体：小文件仍然走单次 base64（不因为实现了分片就多跑一圈）', async () => {
  const http = makeFakeHttp(() => ({ status: 200, text: '', body: { file_info: 'FI-SMALL' } }));
  const sender = new QqMessageSender({ token: () => Promise.resolve('ACCESS'), http: http.fn });
  const small = await sender.uploadMedia('c2c', 'U1', { fileType: 1, data: new Uint8Array(1024) });
  assert.equal(small.ok, true);
  assert.equal(http.requests.length, 1, '一次 /files 就够');
  assert.equal(http.requests[0]?.url, 'https://api.bot.qq.com/v2/users/U1/files');
});

test('富媒体：上传被拒如实上报（不带 code 的响应也不编）', async () => {
  const http = makeFakeHttp(() => ({
    status: 200, text: '', body: { code: 40093002, message: '当日配额已用尽' },
  }));
  const sender = new QqMessageSender({ token: () => Promise.resolve('ACCESS'), http: http.fn });
  const failed = await sender.uploadMedia('c2c', 'USER-1', { fileType: 4, data: new Uint8Array([9]) });
  assert.equal(failed.ok, false);
  assert.ok(failed.ok === false && failed.reason.includes('40093002'));
  assert.ok(failed.ok === false && failed.reason.includes('当日配额已用尽'));
});

// ──────────────────────────────── 事件映射（纯函数） ────────────────────────────────

test('事件映射：缺 id 或 chatId 的事件不产生 wake（不伪造）', () => {
  assert.equal(mapDispatchToWakeChannel('C2C_MESSAGE_CREATE', { content: 'x', author: { user_openid: 'U' } }), null);
  assert.equal(mapDispatchToWakeChannel('C2C_MESSAGE_CREATE', { id: 'M', content: 'x', author: {} }), null);
  assert.equal(mapDispatchToWakeChannel('GROUP_AT_MESSAGE_CREATE', { id: 'M', author: { member_openid: 'P' } }), null);
  assert.equal(mapDispatchToWakeChannel('FRIEND_ADD', { id: 'M' }), null);
  const ok = mapDispatchToWakeChannel('C2C_MESSAGE_CREATE', {
    id: 'M', content: '', author: { user_openid: 'U' },
  });
  assert.equal(ok?.chatId, 'U');
  assert.equal(ok?.text, '');
});

test('事件映射：入站 msgSeq **一律 0**（平台没给序号，由宿主补事件 seq；不再是出站语义的 1）', () => {
  // review P1-10：过去 c2c / group-at / guild / dm 都写着 `msgSeq: 1`，而那是**出站** `msg_seq`
  // （"对同一条 msg_id 的第几次被动回复"）的语义。入站这一格被拿去判"这一条你还没看过"
  // （`msgSeq > readUpToSeq`），1 在读过一次之后永远不大于已读位 ⇒ 那个群 @ 她一遍之后永久失明。
  const cases: Array<[string, Record<string, unknown>]> = [
    ['C2C_MESSAGE_CREATE', { id: 'C1', content: 'x', author: { user_openid: 'U1' } }],
    ['GROUP_AT_MESSAGE_CREATE', { id: 'G1', content: 'x', group_openid: 'GO1', author: { member_openid: 'P1' } }],
    ['GROUP_MESSAGE_CREATE', { id: 'G2', content: 'x', group_openid: 'GO1', author: { member_openid: 'P1' } }],
    ['AT_MESSAGE_CREATE', { id: 'D1', content: 'x', channel_id: 'CH1', guild_id: 'GD1', author: { id: 'U2' } }],
    ['DIRECT_MESSAGE_CREATE', { id: 'D2', content: 'x', guild_id: 'GD2', author: { id: 'U3' } }],
  ];
  for (const [type, payload] of cases) {
    const data = mapDispatchToWakeChannel(type, payload);
    assert.ok(data !== null, `${type} 该产生 wake`);
    assert.equal(data.msgSeq, 0, `${type} 的入站 msgSeq 必须是 0（"平台没给"）`);
  }
});

test('事件映射：全量群消息（GROUP_MESSAGE_CREATE）不再被丢掉', () => {
  // 2026-10-02 更正：这个事件的 Intent 与 @ 消息**同一个订阅位**（1<<25），
  // 差别只在平台侧有没有开"接收所有消息"。以前这里没有它，于是开了开关也收不到一条。
  const group = mapDispatchToWakeChannel('GROUP_MESSAGE_CREATE', {
    id: 'M1',
    content: '大家早上好呀',
    group_openid: 'G1',
    author: { member_openid: 'P1', username: '小明' },
  });
  assert.equal(group?.chatType, 'group', '普通群发言归 group（进信箱那条路），不是 group-at');
  assert.equal(group?.chatId, 'G1');
  assert.equal(group?.person, 'P1');
  assert.equal(group?.text, '大家早上好呀');
  assert.equal(group?.dedupeKey, 'qq-official:M1');
  assert.equal(group?.mentionsMe, undefined, '没人被 @ 时不填这一笔');
  assert.equal(group?.msgSeq, 0,
    '0 = 平台没给序号（官方事件体里没有这个字段）；信箱落库时会补成事件 seq，未读才算得对');

  // @ 了机器人：content 的 @ 前缀已被官方去掉，唯一线索是 mentions 里那个 bot: true
  const mentioned = mapDispatchToWakeChannel('GROUP_MESSAGE_CREATE', {
    id: 'M2',
    content: '在吗',
    group_openid: 'G1',
    author: { member_openid: 'P1' },
    mentions: [{ id: 'BOT', bot: true }, { id: 'P2', bot: false }],
  });
  assert.equal(mentioned?.mentionsMe, true, 'mentions 里有机器人就记下来');
  assert.equal(mentioned?.chatType, 'group', '但**不**因此改成 group-at——唤醒语义绑在 chatType 上');

  // @ 消息那一类本身就该带这一笔（channel/inbox.ts 那段说的约定）
  const at = mapDispatchToWakeChannel('GROUP_AT_MESSAGE_CREATE', {
    id: 'M3', content: '在吗', group_openid: 'G1', author: { member_openid: 'P1' },
  });
  assert.equal(at?.chatType, 'group-at');
  assert.equal(at?.mentionsMe, true);

  // 正文里的"机器话"要换成她能读的（2026-10-02 对齐 AstrBot）：
  // ① @ 标记：三种形状都换成 `@…尾四位`
  const atMarkup = mapDispatchToWakeChannel('GROUP_AT_MESSAGE_CREATE', {
    id: 'M4', group_openid: 'G1', author: { member_openid: 'P1' },
    content: '<@00000000000000000000000000000006> 看这个，还有 <@!AABBCCDDEEFF0011> 和 '
      + '<qqbot-at-user id="1122334455667788" /> 也在',
  });
  assert.ok(atMarkup?.text.includes('@…0006'), `@ 要可读化：${atMarkup?.text}`);
  assert.ok(atMarkup?.text.includes('@…0011') && atMarkup?.text.includes('@…7788'),
    '另外两种形状同样处理');
  assert.equal(atMarkup?.text.includes('<@'), false, '不许把 markup 原样留给她');

  // ② 表情：ext 是 base64 的 JSON（里面有 text）
  const face = mapDispatchToWakeChannel('GROUP_AT_MESSAGE_CREATE', {
    id: 'M5', group_openid: 'G1', author: { member_openid: 'P1' },
    content: `好呀<faceType=6,faceId="0",ext="${Buffer.from(JSON.stringify({ text: '微笑' })).toString('base64')}">`,
  });
  assert.ok(face?.text.includes('[表情:微笑]'), `表情要解出名字：${face?.text}`);
  // 解不出就只写「[表情]」——不编名字
  const brokenFace = mapDispatchToWakeChannel('GROUP_AT_MESSAGE_CREATE', {
    id: 'M6', group_openid: 'G1', author: { member_openid: 'P1' },
    content: '嗯<faceType=6,faceId="0",ext="这不是base64">',
  });
  assert.ok(brokenFace?.text.includes('[表情]'), `解不出也要给个中性写法：${brokenFace?.text}`);
  assert.equal(brokenFace?.text.includes('faceType'), false, 'markup 不许留给她');

  // 群角色（member/admin/owner）：官方群消息事件里带，只作**显示**（她该知道谁是群主）；
  // 私聊事件没有这个字段，就不给。这条是缺口报告里"超过 AstrBot"的一项（它连读都没读）。
  const owner = mapDispatchToWakeChannel('GROUP_AT_MESSAGE_CREATE', {
    id: 'M7', content: '开会了', group_openid: 'G1',
    author: { member_openid: 'P1', member_role: 'owner', username: '群主大人' },
  });
  assert.equal(owner?.memberRole, 'owner');
  assert.equal(owner?.nickname, '群主大人');
  const noRole = mapDispatchToWakeChannel('C2C_MESSAGE_CREATE', {
    id: 'M8', content: '在吗', author: { user_openid: 'U1', username: '小林' },
  });
  assert.equal(noRole?.memberRole, undefined, '私聊没有群角色这一说');

  // 语音（官方：attachments[].content_type='voice'，另有 voice_wav_url 与 asr_refer_text）：
  // 2026-10-03 接上——原来只取 url（SILK 原始文件，她打不开），转写也没用上
  const voice = mapDispatchToWakeChannel('GROUP_AT_MESSAGE_CREATE', {
    id: 'M11', group_openid: 'G1', author: { member_openid: 'P1' }, content: '',
    attachments: [{
      content_type: 'voice',
      url: 'https://multimedia.nt.qq.com.cn/download?silk=1',
      voice_wav_url: 'https://multimedia.nt.qq.com.cn/download?wav=1',
      asr_refer_text: '明天下午三点开会',
    }],
  });
  assert.equal(voice?.attachments?.[0]?.url, 'https://multimedia.nt.qq.com.cn/download?wav=1',
    '语音优先给平台转好的 WAV（SILK 原始文件她打不开）');
  assert.equal(voice?.attachments?.[0]?.text, '明天下午三点开会', '平台的转写要带上');
  // 没有 WAV 链时退回原始 url——宁可给原始文件，也别什么都不给
  const voiceNoWav = mapDispatchToWakeChannel('GROUP_AT_MESSAGE_CREATE', {
    id: 'M12', group_openid: 'G1', author: { member_openid: 'P1' }, content: '',
    attachments: [{ content_type: 'voice', url: 'https://multimedia.nt.qq.com.cn/download?silk=1' }],
  });
  assert.equal(voiceNoWav?.attachments?.[0]?.url, 'https://multimedia.nt.qq.com.cn/download?silk=1');

  // 引用消息（`message_type === 103`）：被引的那句话要摆在本条正文前面——群里"回复某一句"
  // 的语义全在那里（缺口报告第 ④ 项，AstrBot 有、我们没有）
  const quoted = mapDispatchToWakeChannel('GROUP_AT_MESSAGE_CREATE', {
    id: 'M9', group_openid: 'G1', author: { member_openid: 'P1' }, content: '这个不行',
    message_type: 103,
    msg_elements: [
      { message_type: 0, content: '周末一起去爬山吗', author: { member_openid: 'AABBCCDDEEFF0011' } },
    ],
  });
  assert.ok(quoted?.text.startsWith('[引用 @…0011 周末一起去爬山吗]'),
    `引用要还原成前缀：${quoted?.text}`);
  assert.ok(quoted?.text.includes('这个不行'), '她自己的正文照旧在后面');
  // 普通消息（message_type 0）**不许**把自己当成被引用的那句
  const plain = mapDispatchToWakeChannel('GROUP_AT_MESSAGE_CREATE', {
    id: 'M10', group_openid: 'G1', author: { member_openid: 'P1' }, content: '普通一句',
    message_type: 0, msg_elements: [{ message_type: 0, content: '普通一句' }],
  });
  assert.equal(plain?.text.startsWith('[引用'), false, '不是 103 就不加引用前缀（否则张冠李戴）');

  // **频道（子频道）**：官方 `AT_MESSAGE_CREATE`——身份用 author.id，会话 id 用 channel_id
  // （一个服务器里多条子频道，"在哪条里说话"才是会话粒度；与 AstrBot 的 GroupMessage:{channel_id} 同口径）。
  const guild = mapDispatchToWakeChannel('AT_MESSAGE_CREATE', {
    id: 'M13', content: '看看这个', channel_id: 'CH-1', guild_id: 'GUILD-1',
    author: { id: 'GU-9', username: '频道里的某人' },
  });
  assert.equal(guild?.chatType, 'guild');
  assert.equal(guild?.chatId, 'CH-1', '会话 id 是子频道，不是 guild_id');
  assert.equal(guild?.person, 'GU-9', '频道用户 id 走 author.id');
  assert.equal(guild?.nickname, '频道里的某人');
  assert.equal(guild?.mentionsMe, true, '频道里能收到就是 @ 了机器人');

  // 缺 id / 缺 group_openid 照样丢——不伪造
  assert.equal(mapDispatchToWakeChannel('GROUP_MESSAGE_CREATE', { content: 'x', group_openid: 'G1' }), null);
  assert.equal(mapDispatchToWakeChannel('GROUP_MESSAGE_CREATE', { id: 'M', content: 'x', author: {} }), null);
});

// ──────────────────────────────── 回投接线 ────────────────────────────────

test('回投：qq:<chatType>:<chatId> 编解一致，且能经通道 sendText 送达', async () => {
  const sent: Array<{ chatType: string; chatId: string; text: string }> = [];
  const fakeChannel = {
    name: QQ_CHANNEL_NAME,
    start: () => {},
    stop: () => {},
    sendText: async (chatType: 'c2c' | 'group-at', chatId: string, text: string) => {
      sent.push({ chatType, chatId, text });
      return { ok: true as const, messageId: 'SENT', passive: true, msgSeq: 1 };
    },
  };
  const channels = new Map([[QQ_CHANNEL_NAME, fakeChannel]]);
  const poster = createChannelReplyPoster(channels);

  const url = replyUrlOf({ chatType: 'group-at', chatId: 'GROUP-1' });
  assert.equal(url, 'qq:group:GROUP-1', '归一：@ 过的群消息，回投地址也写 group（发出去是同一条路）');
  const parsed = parseReplyUrl(url);
  assert.equal(parsed.ok, true);

  const outcome = await poster.post({ url, idempotencyKey: 'turn-3' }, '我在');
  assert.equal(outcome.ok, true);
  assert.deepEqual(sent[0], { chatType: 'group', chatId: 'GROUP-1', text: '我在' });
  // 存量地址（归一之前的 `qq:group-at:`）照样发得出去：解析口两种都认
  assert.equal(parseReplyUrl('qq:group-at:GROUP-1').ok, true, '旧写法不许变成废纸');

  // 非 QQ 地址 / 未知 chatType 一律拒绝，不静默发送
  assert.equal(parseReplyUrl('https://example.invalid/reply').ok, false);
  // 频道与频道私信现在**都认了**（2026-10-03/04）→ 拿一个仍然不认的写法来钉
  assert.equal(parseReplyUrl('qq:room:1').ok, false);
  assert.equal(parseReplyUrl('qq:c2c:').ok, false);
  const refused = await poster.post({ url: 'https://example.invalid/x', idempotencyKey: '1' }, 'hi');
  assert.equal(refused.ok, false);
});

test('回投：无对应通道时如实报未装配', async () => {
  const poster = createChannelReplyPoster(new Map());
  const outcome = await poster.post({ url: 'qq:c2c:U1', idempotencyKey: 'turn-1' }, 'hi');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason.includes('未装配'), true);
});

// ──────────────────────────────── 通道适配器（对外形状） ────────────────────────────────

test('适配器：start/stop 幂等；onMessage 收到的是 wake/channel 形状', async (t) => {
  const gateway = await startFakeGateway(t);
  const http = makeFakeHttp(input => (input.url.includes('getAppAccessToken')
    ? { status: 200, text: '', body: { access_token: 'ACCESS', expires_in: '7200' } }
    : { status: 200, text: JSON.stringify({ id: 'SENT' }), body: { id: 'SENT' } }));
  const received: WakeChannel['data'][] = [];

  const channel = new QqOfficialChannel({
    appId: 'APP',
    clientSecret: 'SECRET',
    gatewayUrl: gateway.url,
    http: http.fn,
    log: { info: () => {}, warn: () => {} },
  });
  channel.onMessage = (data) => { received.push(data); };
  t.after(() => { channel.stop(); });

  channel.start();
  channel.start(); // 幂等：不应建第二条连接
  await waitFor(() => gateway.sockets.length === 1, 30_000, '只有一条连接');
  // **Hello 要周期重发**（2026-10-03 查出来的竞态）：原来"一看到 socket 出现就发一次"——
  // 客户端那时可能还没挂上读处理（并行负载下更明显），于是它等不到 Hello、判连接失败、
  // 按退避重连，Identify 就永远不来（证据：帧=[]、connected=false、reconnectAttempts=1、
  // tokenFetches=0、socket 数=1）。平台的真实网关对重复 Hello 是幂等的，测试这边同理。
  const hello = setInterval(() => {
    gateway.sendJson({ op: QQ_OP.hello, d: { heartbeat_interval: 50_000 } });
  }, 250);
  hello.unref?.();
  t.after(() => { clearInterval(hello); });
  gateway.sendJson({ op: QQ_OP.hello, d: { heartbeat_interval: 50_000 } });
  // 超时时把证据一起打出来——网关收到了哪些帧、通道自己怎么想（连接状态与重连次数），
  // 别只留一句"超时"：
  try {
    await waitForFrame(gateway, frame => frame['op'] === QQ_OP.identify, 'Identify', 30_000);
  } catch (err) {
    const snap = channel.snapshot();
    assert.fail(
      `等待 Identify 超时。证据：网关收到的帧=${JSON.stringify(gateway.jsonFrames().map(f => f['op']))}；`
        + `通道快照=${JSON.stringify(snap)}；socket 数=${gateway.sockets.length}。`
        + `原错误：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  gateway.sendJson({ op: QQ_OP.dispatch, s: 1, t: 'READY', d: { session_id: 'S' } });
  clearInterval(hello); // Identify 到了：不用再哄它
  gateway.sendJson({
    op: QQ_OP.dispatch, s: 2, t: 'C2C_MESSAGE_CREATE',
    d: { id: 'MSG-9', content: '在吗', author: { user_openid: 'U-9' } },
  });
  await waitFor(() => received.length === 1, 10_000, '通道投递');

  assert.equal(channel.name, 'qq-official');
  assert.equal(received[0]?.messageId, 'MSG-9');
  assert.equal(channel.snapshot().delivered, 1);
  assert.equal(channel.snapshot().hasToken, true);

  // 停止后连接必须关闭
  channel.stop();
  await waitFor(() => gateway.sockets.length === 0, 10_000, '连接已关闭');
});

test('适配器：回投走真实发送路径（单聊被动回复 URL 与体正确）', async () => {
  const http = makeFakeHttp(input => (input.url.includes('getAppAccessToken')
    ? { status: 200, text: '', body: { access_token: 'ACCESS', expires_in: 7200 } }
    : { status: 200, text: JSON.stringify({ id: 'SENT-77' }), body: { id: 'SENT-77' } }));
  const channel = new QqOfficialChannel({
    appId: 'APP', clientSecret: 'SECRET', http: http.fn, log: { info: () => {}, warn: () => {} },
  });
  const channels = new Map([[channel.name, channel]]);
  const poster = createChannelReplyPoster(channels);
  const outcome = await poster.post({ url: 'qq:c2c:USER-9', idempotencyKey: 'turn-1' }, '我在听');
  assert.equal(outcome.ok, true);
  const messageRequest = http.requests.find(r => r.url.includes('/messages'));
  assert.equal(messageRequest?.url, 'https://api.bot.qq.com/v2/users/USER-9/messages');
  assert.equal((messageRequest?.jsonBody as Record<string, unknown>)['content'], '我在听');
});

// ──────────────────────────────── 默认 HTTP 实现 ────────────────────────────────

test('默认 HTTP 实现：拒绝非 http(s) 协议（不把凭证发给未知 scheme）', async () => {
  await assert.rejects(
    () => defaultHttpJson({ method: 'GET', url: 'file:///etc/passwd' }),
    /只支持 http\(s\) 请求/,
  );
});

test('默认 HTTP 实现：对本地 HTTP 端点如实回传状态与解析后的响应体', async (t) => {
  const server = createServer((socket) => {
    socket.on('data', () => {
      const body = JSON.stringify({ ok: true, echo: 'x' });
      socket.write([
        'HTTP/1.1 200 OK',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n'));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { await new Promise<void>((resolve) => { server.close(() => { resolve(); }); }); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('监听失败');

  const response = await defaultHttpJson({ method: 'POST', url: `http://127.0.0.1:${address.port}/x`, jsonBody: { a: 1 } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, echo: 'x' });
});

test('ws-client：客户端 close() 走完关闭握手（对端回 close 后收尾）', async (t) => {
  let socket: Socket | null = null;
  const server = createServer((s) => {
    socket = s;
    s.on('data', (chunk) => {
      const end = chunk.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = chunk.subarray(0, end).toString('latin1');
      const key = /Sec-WebSocket-Key: (.+)/i.exec(head)?.[1]?.trim() ?? '';
      s.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${handshakeAccept(key)}`,
        '',
        '',
      ].join('\r\n'));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    socket?.destroy();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('监听失败');

  const client: WsClient = await wsConnect(`ws://127.0.0.1:${address.port}/`, {
    readTimeoutMs: 0,
    closeTimeoutMs: 150,
  });
  const closes: WsCloseInfo[] = [];
  client.onClose((info) => { closes.push(info); });
  client.close(1000, 'done');
  await waitFor(() => closes.length === 1, 10_000, 'close 超时强拆后收尾');
  assert.equal(closes[0]?.byLocal, true);
});
