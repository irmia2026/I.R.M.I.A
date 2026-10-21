/**
 * Irmia Agent — QQ 官方 Bot 的 **Webhook 接入**（另一半：纯逻辑，不起端口）
 *
 * 为什么单独一个文件、且只做纯函数：官方 webhook 这条路的**正确性全在这三件事**上——
 *   • **Ed25519 验签**（`X-Signature-Ed25519` + `X-Signature-Timestamp`，签的是 `timestamp + body`）；
 *   • **opcode 13 的地址验证**握手（平台来验我们是不是真的活着，必须原样回 `plain_token` + 签名）；
 *   • **事件 id 去重**（官方明说同一个 `id` 可能重复推送；AstrBot 用 60 秒 TTL 的 seen 表）。
 * 这三件事都可以在没有 socket 的情况下测死。HTTP 监听怎么接（端口、路径、反代）是配置决定，
 * 留给宿主那一层——**逻辑放在这里，接线放在那里**。
 *
 * 与 WS 那条路的关系：二选一，不是叠加。同一条通道同时开 WS 与 webhook，平台会把事件推两次
 * （除非各自的去重都开着）——所以宿主要么走这条、要么走那条。
 */

import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, createHash } from 'node:crypto';

/** 官方事件 opcode（webhook 回调体里的 `op`） */
export const QQ_WEBHOOK_OP = {
  /** 事件推送 */
  dispatch: 0,
  /** 平台来验证回调地址（需要我们回签名） */
  urlVerify: 13,
} as const;

/** 去重窗口：官方说同一 id 可能重推，60 秒足够覆盖重试（与 AstrBot 同口径） */
export const WEBHOOK_DEDUPE_TTL_MS = 60_000;

/**
 * 把 bot secret 变成 Ed25519 的 32 字节种子。
 *
 * 官方口径是"用 secret 做种子"，但没有规定 secret 必须 32 字节——所以短的**重复填充**、
 * 长的**取哈希**：两种情况都得到确定的 32 字节，且同样的 secret 永远给同样的密钥
 *（跨进程一致是硬要求：平台签的跟我们验的必须是同一把）。
 */
export function ed25519SeedOf(secret: string): Buffer {
  const bytes = Buffer.concat([Buffer.from(secret, 'utf8'), Buffer.from('irmia-qq-webhook', 'utf8')]);
  if (bytes.length === 32) return bytes;
  if (bytes.length < 32) {
    // 重复填充到 32 字节（AstrBot 的做法）
    const filled = Buffer.alloc(32);
    for (let i = 0; i < 32; i += 1) filled[i] = bytes[i % bytes.length]!;
    return filled;
  }
  return createHash('sha256').update(bytes).digest();
}

/** PKCS8 头（Ed25519 私钥的固定前缀）：Node 没有"从裸种子建私钥"的入口，所以要自己包一层 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** 从 secret 造出签名用的私钥对象 */
export function privateKeyOf(secret: string) {
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, ed25519SeedOf(secret)]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/** 从 secret 造出验签用的公钥对象（就是私钥那一半，Node 自己导） */
export function publicKeyOf(secret: string) {
  return createPublicKey(privateKeyOf(secret));
}

/** 签名体（官方口径：`timestamp + body`，timestamp 是字符串、body 是原始字节） */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  const message = Buffer.concat([Buffer.from(timestamp, 'utf8'), Buffer.from(body, 'utf8')]);
  return cryptoSign(null, message, privateKeyOf(secret)).toString('hex');
}

/**
 * 验签。**任何一步不合法都返回 false**：平台的头少了、hex 坏了、签不上，全按"不是平台发的"处理。
 * 调用方拿到 false 就应当丢掉这条请求——不要"先处理再验签"。
 */
export function verifyWebhookSignature(input: {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  body: string;
}): boolean {
  const { secret, timestamp, signature, body } = input;
  if (timestamp === undefined || signature === undefined || signature === '') return false;
  let raw: Buffer;
  try {
    raw = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  if (raw.length !== 64) return false; // Ed25519 签名恒为 64 字节
  const message = Buffer.concat([Buffer.from(timestamp, 'utf8'), Buffer.from(body, 'utf8')]);
  try {
    return cryptoVerify(null, message, publicKeyOf(secret), raw);
  } catch {
    return false;
  }
}

/** 地址验证（opcode 13）的应答体：官方要求原样回 `plain_token` + 我们算的签名 */
export function urlVerifyResponse(
  secret: string,
  payload: { plain_token?: unknown; event_ts?: unknown },
): { plain_token: string; signature: string } | null {
  const token = typeof payload.plain_token === 'string' ? payload.plain_token : '';
  const ts = typeof payload.event_ts === 'string' ? payload.event_ts : String(payload.event_ts ?? '');
  if (token === '' || ts === '') return null;
  return { plain_token: token, signature: signWebhook(secret, ts, token) };
}

/**
 * 事件 id 去重（懒淘汰：每次 `seen` 顺手把过期的清掉——发送是长跑进程，
 * 不能让这张表只涨不落）。
 */
export class WebhookDedupe {
  private readonly seenAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? WEBHOOK_DEDUPE_TTL_MS;
  }

  /** 这条事件 id 见过吗？没见过就记下并返回 false（调用方据此决定"处理还是丢掉"） */
  seen(eventId: string): boolean {
    const now = this.now();
    for (const [key, at] of this.seenAt) {
      if (now - at >= this.ttlMs) this.seenAt.delete(key);
      else break; // Map 保持插入序：遇到第一个没过期的就可以停
    }
    if (this.seenAt.has(eventId)) return true;
    this.seenAt.set(eventId, now);
    return false;
  }

  /** 便于观测（测试与状态快照用） */
  get size(): number {
    return this.seenAt.size;
  }
}
