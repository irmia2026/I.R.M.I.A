/**
 * Irmia Agent — 零依赖 WebSocket 客户端（RFC 6455，docs/milestones.md M9-1）
 *
 * 为什么手写而不引库：本项目的硬约束是**只用 node: 标准库**（node:https/net/tls/crypto）。
 * 我们需要的是一个"够用于长连接收消息"的子集，而不是全套 RFC 特性：
 *
 *   • 握手：`GET <path> HTTP/1.1` + `Upgrade: websocket`，客户端 key 随机 16 字节 base64，
 *     并**逐字校验**服务端回的 `Sec-WebSocket-Accept = base64(sha1(key + GUID))`——
 *     这是唯一能证明"对端真的是 WebSocket 网关而不是某个返回 101 的中间设备"的证据；
 *   • 帧：FIN + RSV + opcode、掩码规则（**客户端发出的每一帧都必须掩码**，服务端帧必须不掩码）、
 *     载荷长度 7/16/64 位三档、文本/二进制/ping/pong/close、continuation 分片重组；
 *   • 自动 pong：收到 ping 必须原样回 pong（QQ 网关不依赖它，但这是协议义务）；
 *   • 关闭握手：收到 close 先回一个 close 再断；我方 close() 发出 close 后等对端回，
 *     超时（closeTimeoutMs）强拆。
 *
 * **断线检测（无人值守场景最关键的一条）**：WebSocket 是 TCP 之上的，网络被拔线时
 * 套接字可能既读不到 EOF 也不报错，进程就这么静默地"连着"却再也收不到消息。
 * 因此这里自带读超时：**连续 readTimeoutMs 没有收到任何帧**即判定链路已死，
 * 主动销毁套接字并走 onClose（上层据此重连）。默认值由调用方给（QQ 适配器取
 * 心跳间隔 × 2，与网关的双倍心跳宽限一致）。
 *
 * 与上层（src/channel/qq-official.ts）的边界：本文件不懂任何 QQ 语义，只吐文本帧，
 * 更不知道"心跳"是什么——心跳是应用层协议，读超时才是传输层的事。
 *
 * 约定：值导入写 `.ts`（Node 的 --experimental-strip-types 只擦类型、不改写路径解析），
 * 纯类型导入写 `.js`。
 */

import { createHash, randomBytes } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

// ──────────────────────────────── 常量 ────────────────────────────────

/** RFC 6455 §1.3 的固定 GUID：Sec-WebSocket-Accept 的魔数尾巴 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 单帧载荷上限（16MB）。超限即协议错误：不做"尽力收下"的妥协，那等于给对端一个 OOM 入口 */
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** 分片重组上限（64MB）：分片是合法的，无限分片不是 */
export const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
/** 握手响应头总长上限：防对端用超大头部把内存吃干 */
const MAX_HANDSHAKE_HEADER_BYTES = 64 * 1024;

/** opcode（RFC 6455 §5.2） */
export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

/** 关闭码：协议错误（对端发了非法帧时回它，明确告诉对端"是你坏了"） */
export const CLOSE_PROTOCOL_ERROR = 1002;
/** 关闭码：消息过大 */
export const CLOSE_TOO_BIG = 1009;
/** 关闭码：我方主动关（读到读超时/本地关闭用 1000 正常关闭，不带原因） */
export const CLOSE_NORMAL = 1000;

// ──────────────────────────────── 对外类型 ────────────────────────────────

/** 一条收下的完整消息（分片已重组）；二进制帧的 bytes 才是权威表示，text 是 UTF-8 解码结果 */
export interface WsMessage {
  type: 'text' | 'binary';
  text: string;
  bytes: Buffer;
}

/** 关闭事实：code 为 null 表示链路是被判死/强拆的（没有走完关闭握手） */
export interface WsCloseInfo {
  code: number | null;
  reason: string;
  /** 我方发起的关闭（close()）还是对端/超时导致 */
  byLocal: boolean;
}

export interface WsClient {
  /** 发一条文本帧（载荷空串也发，空文本是合法消息） */
  send(text: string): void;
  /** 发一条 JSON 文本帧（对象序列化，undefined 成员会被 JSON.stringify 丢掉） */
  sendJson(value: unknown): void;
  onMessage(cb: (message: WsMessage) => void): void;
  /** 关闭回调：**至多触发一次**，无论关闭是对方发起、读超时判死还是我方差掉 */
  onClose(cb: (info: WsCloseInfo) => void): void;
  /** 协议层异常（非法帧/校验失败）；不是关闭事件，关闭仍会经 onClose 送达 */
  onError(cb: (err: Error) => void): void;
  /** 已连上并完成升级（false 表示已断开或正在断） */
  readonly isOpen: boolean;
  /**
   * 重设读超时（毫秒）。存在的理由：读超时应当跟随对方下发的节奏——
   * QQ 网关在 Hello 里给 heartbeat_interval，宽限就是它的两倍；
   * 而 Hello 是在连接之后才收到的，所以阈值必须能在连接中途改动。
   */
  setReadTimeoutMs(ms: number): void;
  /** 关闭：先发 close 帧等对端回，closeTimeoutMs 内没等到就强拆。幂等 */
  close(code?: number, reason?: string): void;
}

export interface WsConnectOptions {
  /** 读超时（毫秒）：连续这么久没收到任何帧即判链路已死。0 表示不检测 */
  readTimeoutMs?: number;
  /** 关闭握手等待（毫秒），默认 3000 */
  closeTimeoutMs?: number;
  /** 握手超时（毫秒），默认 10000 */
  handshakeTimeoutMs?: number;
  /** 单帧上限 */
  maxFrameBytes?: number;
  /** 分片重组上限 */
  maxMessageBytes?: number;
  /** 诊断输出（可选）；不打日志也能正常工作 */
  onDebug?: (line: string) => void;
  /**
   * 显式禁用 TLS（测试用：本地假网关是明文 ws://）。
   * 真实网关一律 wss://，本开关绝不在生产路径上使用。
   */
  insecure?: boolean;
}

// ──────────────────────────────── 帧编解码（导出供测试复用） ────────────────────────────────

/**
 * 编一帧。客户端发出的帧**必须**掩码（RFC 6455 §5.3），所以这里恒加密钥；
 * 掩码密钥用 crypto 随机 4 字节——同一个密钥连用会显著削弱掩码的意义。
 */
export function encodeFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header.writeUInt8((fin ? 0x80 : 0x00) | (opcode & 0x0f), 0);
    header.writeUInt8(0x80 | length, 1);
  } else if (length < 0x10000) {
    header = Buffer.alloc(4);
    header.writeUInt8((fin ? 0x80 : 0x00) | (opcode & 0x0f), 0);
    header.writeUInt8(0x80 | 126, 1);
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header.writeUInt8((fin ? 0x80 : 0x00) | (opcode & 0x0f), 0);
    header.writeUInt8(0x80 | 127, 1);
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = randomBytes(4);
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) {
    masked[i] = payload[i]! ^ mask[i % 4]!;
  }
  return Buffer.concat([header, mask, masked]);
}

/** close 帧载荷：2 字节大端码 + UTF-8 原因 */
export function encodeClosePayload(code: number, reason: string): Buffer {
  const body = Buffer.from(reason, 'utf8');
  const head = Buffer.alloc(2);
  head.writeUInt16BE(code, 0);
  return Buffer.concat([head, body]);
}

interface FrameHeader {
  fin: boolean;
  /** 保留位（RSV1/2/3）：本实现不协商任何扩展，非零即协议错误 */
  rsv: number;
  opcode: number;
  masked: boolean;
  maskKey: Buffer | null;
  length: number;
  headerBytes: number;
}

export type FrameParse =
  | { kind: 'frame'; header: FrameHeader; payload: Buffer; consumed: number }
  | { kind: 'need-more' }
  | { kind: 'protocol-error'; message: string; code: number };

/**
 * 从缓冲区头部解一帧。返回 need-more 表示数据还没到齐（TCP 分段是常态，不是异常）。
 *
 * 校验点与理由：
 *   • 三位长度档位必须自洽（126 档的值不得 <126，127 档不得 <65536）——否则是对端编码器坏了，
 *     而放行会让"长度"这件事失去唯一解释；
 *   • 服务端帧**不得**掩码（RFC 6455 §5.1）；
 *   • 64 位长度必须落在 JS 安全整数内，且不超过单帧上限。
 */
export function parseFrame(buffer: Buffer, maxFrameBytes: number): FrameParse {
  if (buffer.length < 2) return { kind: 'need-more' };
  const b0 = buffer.readUInt8(0);
  const b1 = buffer.readUInt8(1);
  const fin = (b0 & 0x80) !== 0;
  const rsv = (b0 & 0x70) >> 4;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let length = b1 & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return { kind: 'need-more' };
    length = buffer.readUInt16BE(offset);
    offset += 2;
    if (length < 126) {
      return { kind: 'protocol-error', message: `16 位长度档写了最小值 ${length}（非最短编码）`, code: CLOSE_PROTOCOL_ERROR };
    }
  } else if (length === 127) {
    if (buffer.length < offset + 8) return { kind: 'need-more' };
    const big = buffer.readBigUInt64BE(offset);
    offset += 8;
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      return { kind: 'protocol-error', message: '64 位长度超出安全整数范围', code: CLOSE_TOO_BIG };
    }
    length = Number(big);
    if (length < 0x10000) {
      return { kind: 'protocol-error', message: `64 位长度档写了最小值 ${length}（非最短编码）`, code: CLOSE_PROTOCOL_ERROR };
    }
  }
  if (length > maxFrameBytes) {
    return { kind: 'protocol-error', message: `单帧 ${length} 字节超过上限 ${maxFrameBytes}`, code: CLOSE_TOO_BIG };
  }
  let maskKey: Buffer | null = null;
  if (masked) {
    if (buffer.length < offset + 4) return { kind: 'need-more' };
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return { kind: 'need-more' };
  const raw = buffer.subarray(offset, offset + length);
  // 解掩码必须在**拷贝**上做：raw 是共享底层内存的视图，就地异或会污染还没消费的后续字节
  const payload = maskKey === null ? Buffer.from(raw) : unmask(raw, maskKey);
  return {
    kind: 'frame',
    header: { fin, rsv, opcode, masked, maskKey, length, headerBytes: offset },
    payload,
    consumed: offset + length,
  };
}

/** 解掩码（导出：假网关/压测端要解客户端帧，测试与实现共用同一份规则） */
export function unmask(raw: Buffer, key: Buffer): Buffer {
  const out = Buffer.allocUnsafe(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw[i]! ^ key[i % 4]!;
  return out;
}

// ──────────────────────────────── 握手 ────────────────────────────────

/** Sec-WebSocket-Accept 的期望值：base64(sha1(key + GUID)) */
export function acceptKeyOf(key: string): string {
  return createHash('sha1').update(`${key}${WS_GUID}`, 'binary').digest('base64');
}

interface UpgradeTarget {
  tls: boolean;
  host: string;
  port: number;
  /** 请求行里的路径（含查询串），至少 "/" */
  path: string;
}

export type UrlParse = { ok: true; value: UpgradeTarget } | { ok: false; error: string };

/** 解析 ws:// 或 wss:// URL。只接受这两种 scheme——http(s) 是调用方的错误，不做猜测转换 */
export function parseWsUrl(input: string): UrlParse {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: `不是合法 URL：${input}` };
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return { ok: false, error: `只支持 ws:// 或 wss://（收到 ${url.protocol}）` };
  }
  const tls = url.protocol === 'wss:';
  const port = url.port === '' ? (tls ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, error: `端口非法：${url.port}` };
  }
  if (url.hostname === '') return { ok: false, error: '主机名为空' };
  return {
    ok: true,
    value: { tls, host: url.hostname, port, path: `${url.pathname}${url.search}` || '/' },
  };
}

interface HandshakeResult {
  socket: Socket;
  /** 握手响应之后同包 / 之后到达的字节（可能已经是第一帧的开头） */
  rest: Buffer;
}

/**
 * 建连并完成升级握手。
 *
 * **严格串行化**：容器在"升级握手还没完成"期间只挂一个 data 监听器（即本函数），
 * 静态监听器只处理 error/close；握手函数返回时它会把 data 监听摘掉、把剩余字节交回调用方。
 * 不这么做的话，握手响应的尾部字节会在"收帧解析器还没就位"时被丢掉——
 * 而那一小段很可能正是 READY 事件的前半帧（实测网关节奏就是握手响应 + 第一帧同包）。
 */
function openSocket(url: UpgradeTarget, options: WsConnectOptions): Promise<HandshakeResult> {
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
  return new Promise<HandshakeResult>((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const expected = acceptKeyOf(key);
    const hostHeader = url.port === (url.tls ? 443 : 80) ? url.host : `${url.host}:${url.port}`;
    const request = [
      `GET ${url.path} HTTP/1.1`,
      `Host: ${hostHeader}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n');
    const requestBytes = Buffer.from(request, 'utf8');

    const socket: Socket = url.tls
      ? tlsConnect({ host: url.host, port: url.port, servername: url.host })
      : netConnect({ host: url.host, port: url.port });
    socket.setNoDelay(true);

    let buffer = Buffer.alloc(0);
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onCloseBeforeOpen);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    };
    const succeed = (rest: Buffer): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ socket, rest });
    };

    const onError = (err: Error): void => {
      fail(new Error(`WebSocket 连接失败（${url.host}:${url.port}）：${err.message}`));
    };
    const onCloseBeforeOpen = (): void => {
      fail(new Error(`WebSocket 在握手完成前被关闭（${url.host}:${url.port}）`));
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_HANDSHAKE_HEADER_BYTES) {
        fail(new Error('握手响应头超过 64KB，判定对端异常'));
        return;
      }
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buffer.subarray(0, end).toString('latin1');
      const rest = buffer.subarray(end + 4);
      const verdict = checkHandshake(head, expected);
      if (verdict !== null) {
        fail(new Error(verdict));
        return;
      }
      succeed(Buffer.from(rest));
    };

    const timer = setTimeout(() => {
      fail(new Error(`WebSocket 握手超时（${handshakeTimeoutMs}ms）`));
    }, handshakeTimeoutMs);

    socket.once(url.tls ? 'secureConnect' : 'connect', () => {
      socket.write(requestBytes);
    });
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onCloseBeforeOpen);
  });
}

/** 校验升级响应。返回 null 表示通过，否则返回拒因（人类可读，含对端实际给了什么） */
function checkHandshake(head: string, expectedAccept: string): string | null {
  const lines = head.split('\r\n');
  const statusLine = lines[0] ?? '';
  if (!/^HTTP\/1\.[01] 101\b/.test(statusLine)) {
    return `升级被拒：${statusLine === '' ? '空状态行' : statusLine}`;
  }
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
  }
  if ((headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
    return `升级响应缺少 Upgrade: websocket（收到 ${headers.get('upgrade') ?? '无'}）`;
  }
  const connection = headers.get('connection') ?? '';
  if (!connection.toLowerCase().split(',').map(part => part.trim()).includes('upgrade')) {
    return `升级响应缺少 Connection: Upgrade（收到 ${connection === '' ? '无' : connection}）`;
  }
  const accept = headers.get('sec-websocket-accept');
  if (accept === undefined) return '升级响应缺少 Sec-WebSocket-Accept';
  if (accept !== expectedAccept) {
    return `Sec-WebSocket-Accept 校验失败（期望 ${expectedAccept}，收到 ${accept}）：对端不是 RFC6455 网关`;
  }
  return null;
}

// ──────────────────────────────── 客户端 ────────────────────────────────

class WsClientImpl implements WsClient {
  private readonly socket: Socket;
  private readonly debug: (line: string) => void;
  private readonly maxFrameBytes: number;
  private readonly maxMessageBytes: number;
  private readTimeoutMs: number;
  private readonly closeTimeoutMs: number;

  /** 未消费的字节（TCP 分段与关包粘连都在这里拼回完整帧） */
  private buffer: Buffer;
  /** 分片重组：第一片的 opcode 与已收载荷 */
  private fragmentOpcode: number | null = null;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;

  private open = true;
  private closedNotified = false;
  private localCloseSent = false;
  private lastFrameAt: number;
  private readTimer: NodeJS.Timeout | null = null;
  private closeTimer: NodeJS.Timeout | null = null;

  private messageCb: ((message: WsMessage) => void) | null = null;
  private closeCb: ((info: WsCloseInfo) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;

  constructor(socket: Socket, rest: Buffer, options: WsConnectOptions) {
    this.socket = socket;
    this.buffer = rest;
    this.debug = options.onDebug ?? (() => {});
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.readTimeoutMs = options.readTimeoutMs ?? 0;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 3000;
    this.lastFrameAt = Date.now();

    socket.on('data', (chunk: Buffer) => { this.feed(chunk); });
    socket.on('error', (err: Error) => { this.noteError(err); });
    socket.on('close', () => { this.settleClose(false); });
    socket.resume();

    this.armReadTimer();
    // 握手响应与第一帧同包时，rest 里已经有数据：直接解，不等下一次 data 事件
    if (this.buffer.length > 0) this.drain();
  }

  get isOpen(): boolean {
    return this.open;
  }

  send(text: string): void {
    this.writeFrame(OPCODE.text, Buffer.from(text, 'utf8'));
  }

  sendJson(value: unknown): void {
    this.send(JSON.stringify(value));
  }

  onMessage(cb: (message: WsMessage) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: (info: WsCloseInfo) => void): void {
    this.closeCb = cb;
  }

  onError(cb: (err: Error) => void): void {
    this.errorCb = cb;
  }

  setReadTimeoutMs(ms: number): void {
    if (ms <= 0 || ms === this.readTimeoutMs) return;
    this.readTimeoutMs = ms;
    // 重排定时器并把"最后一次收帧"当作起点：阈值变大时立刻生效而不是等满一个旧周期
    this.lastFrameAt = Date.now();
    if (this.readTimer !== null) {
      clearInterval(this.readTimer);
      this.readTimer = null;
    }
    this.armReadTimer();
  }

  close(code: number = CLOSE_NORMAL, reason = ''): void {
    if (this.closedNotified) return;
    if (this.localCloseSent) return;
    this.localCloseSent = true;
    const payload = encodeClosePayload(code, reason);
    if (this.open) this.writeFrame(OPCODE.close, payload);
    // 等对端回 close；等不到就强拆——否则一个不守规矩的网关能让 close() 永远不返回
    this.closeTimer = setTimeout(() => {
      this.debug('[ws] 关闭握手超时，强拆套接字');
      this.destroy();
    }, this.closeTimeoutMs);
    this.closeTimer.unref?.();
  }

  // ── 收帧 ──

  private feed(chunk: Buffer): void {
    if (this.closedNotified) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  private drain(): void {
    for (;;) {
      if (this.closedNotified) return;
      const parsed = parseFrame(this.buffer, this.maxFrameBytes);
      if (parsed.kind === 'need-more') return;
      if (parsed.kind === 'protocol-error') {
        this.noteError(new Error(`WebSocket 协议错误：${parsed.message}`));
        this.failConnection(parsed.code, parsed.message);
        return;
      }
      this.buffer = this.buffer.subarray(parsed.consumed);
      this.lastFrameAt = Date.now();
      if (!this.handleFrame(parsed.header, parsed.payload)) return;
    }
  }

  /** 返回 false 表示本帧导致连接收尾（停止继续解析） */
  private handleFrame(header: FrameHeader, payload: Buffer): boolean {
    // 保留位非零：本实现不协商任何扩展，收到即协议错误（RFC 6455 §5.2 的 MUST）
    if (header.rsv !== 0) {
      this.failConnection(CLOSE_PROTOCOL_ERROR, `RSV 保留位非零（RSV=${header.rsv}），本连接未协商扩展`);
      return false;
    }
    // 服务端帧不得掩码（RFC 6455 §5.1）：客户端只解析服务端帧，所以这里恒须 masked=false。
    // 放行一个带掩码的"服务端帧"等于把帧格式的解释权交给对端，后续解析全不可信。
    if (header.masked) {
      this.failConnection(CLOSE_PROTOCOL_ERROR, '收到的服务端帧带了掩码位（违反 RFC 6455 §5.1）');
      return false;
    }
    switch (header.opcode) {
      case OPCODE.ping:
        // 原样回 pong：ping 的载荷必须被回应方抄回去，应用层不做任何解读
        this.writeFrame(OPCODE.pong, payload);
        return true;
      case OPCODE.pong:
        return true;
      case OPCODE.close: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : null;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        this.debug(`[ws] 收到 close：code=${code ?? '无'} reason=${reason === '' ? '无' : reason}`);
        if (!this.localCloseSent) {
          // 对端先关：回一个同样的 close 码，然后由对端断链（RFC 6455 §5.5.1 的镜像规则）
          this.localCloseSent = true;
          this.writeFrame(OPCODE.close, encodeClosePayload(code ?? CLOSE_NORMAL, ''));
        }
        this.closeCode = code;
        this.closeReason = reason;
        this.destroy();
        return false;
      }
      case OPCODE.continuation:
        return this.handleFragment(header, payload);
      case OPCODE.text:
      case OPCODE.binary:
        if (this.fragmentOpcode !== null) {
          this.failConnection(CLOSE_PROTOCOL_ERROR, '分片未结束时收到了新的数据帧');
          return false;
        }
        if (header.fin) {
          this.emitMessage(header.opcode, payload);
          return true;
        }
        this.fragmentOpcode = header.opcode;
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
        return true;
      default:
        this.failConnection(CLOSE_PROTOCOL_ERROR, `未知 opcode 0x${header.opcode.toString(16)}`);
        return false;
    }
  }

  private handleFragment(header: FrameHeader, payload: Buffer): boolean {
    if (this.fragmentOpcode === null) {
      this.failConnection(CLOSE_PROTOCOL_ERROR, '收到了没有起始片的 continuation 帧');
      return false;
    }
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > this.maxMessageBytes) {
      this.failConnection(CLOSE_TOO_BIG, `分片消息超过上限 ${this.maxMessageBytes}`);
      return false;
    }
    this.fragments.push(payload);
    if (!header.fin) return true;
    const opcode = this.fragmentOpcode;
    const whole = Buffer.concat(this.fragments, this.fragmentBytes);
    this.fragmentOpcode = null;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.emitMessage(opcode, whole);
    return true;
  }

  private emitMessage(opcode: number, payload: Buffer): void {
    const message: WsMessage = {
      type: opcode === OPCODE.text ? 'text' : 'binary',
      text: payload.toString('utf8'),
      bytes: payload,
    };
    try {
      this.messageCb?.(message);
    } catch (err) {
      // 上层回调抛错绝不能把连接层带崩：它只是消费者
      this.noteError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ── 发帧与收尾 ──

  private writeFrame(opcode: number, payload: Buffer): void {
    if (!this.open) return;
    try {
      this.socket.write(encodeFrame(opcode, payload));
    } catch (err) {
      this.noteError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private closeCode: number | null = null;
  private closeReason = '';

  /** 协议错误/读超时收尾：明确告诉对端原因（能发就发），然后强拆 */
  private failConnection(code: number, reason: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    // 协议错误必须经 onError 报出来：它是"对端违约"的事实，只体现在关闭码里会被上层当成普通断线
    this.noteError(new Error(`WebSocket 协议错误：${reason}`));
    if (!this.localCloseSent && this.open) {
      this.localCloseSent = true;
      this.writeFrame(OPCODE.close, encodeClosePayload(code, reason));
    }
    this.destroy();
  }

  private destroy(): void {
    if (this.readTimer !== null) {
      clearTimeout(this.readTimer);
      this.readTimer = null;
    }
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    if (this.open) {
      this.open = false;
      this.socket.destroy();
    }
    // 默认不是本地主动关：协议错误/读超时也走 destroy，它们的语义是"链路被判死"
    // 而不是"我关的"（上层据此区分要不要重连）
    this.settleClose(this.localCloseSent && this.closeCode === null);
  }

  private noteError(err: Error): void {
    this.debug(`[ws] 错误：${err.message}`);
    try {
      this.errorCb?.(err);
    } catch {
      // 错误回调自己抛错就到此为止：再往上没有消费者了
    }
  }

  /** 读超时：连续 readTimeoutMs 无帧即判链路已死。无人值守下这是唯一的"半开连接"出口 */
  private armReadTimer(): void {
    if (this.readTimeoutMs <= 0) return;
    const tick = Math.max(250, Math.min(this.readTimeoutMs, 5000));
    this.readTimer = setInterval(() => {
      if (!this.open) return;
      const idle = Date.now() - this.lastFrameAt;
      if (idle < this.readTimeoutMs) return;
      // 不主动关帧：链路已经死了，写出去也到不了对端，直接判死并通知上层重连
      this.closeReason = `读超时：${idle}ms 未收到任何帧（阈值 ${this.readTimeoutMs}ms）`;
      this.noteError(new Error(`WebSocket ${this.closeReason}`));
      this.destroy();
    }, tick);
    // 读超时定时器是链路存活的监视器，不该单独维持进程存活
    this.readTimer.unref?.();
  }

  private settleClose(byLocal: boolean): void {    if (this.closedNotified) return;
    this.closedNotified = true;
    if (this.readTimer !== null) {
      clearTimeout(this.readTimer);
      this.readTimer = null;
    }
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.open = false;
    this.debug(`[ws] 连接收尾：code=${this.closeCode ?? '无'} reason=${this.closeReason === '' ? '无' : this.closeReason}`);
    try {
      this.closeCb?.({ code: this.closeCode, reason: this.closeReason, byLocal });
    } catch {
      // 关闭回调抛错同理：没有更上层可以报告了
    }
  }
}

/**
 * 连一个 WebSocket 端点并完成升级握手。
 * 失败（URL 非法、TCP/TLS 失败、握手被拒、Accept 校验不过）一律 reject，不留半开的客户端。
 */
export async function connect(url: string, options: WsConnectOptions = {}): Promise<WsClient> {
  const parsed = parseWsUrl(url);
  if (!parsed.ok) throw new Error(`WebSocket 地址非法：${parsed.error}`);
  const target = options.insecure === true ? { ...parsed.value, tls: false } : parsed.value;
  const opened = await openSocket(target, options);
  return new WsClientImpl(opened.socket, opened.rest, options);
}
