/**
 * Webhook 接入（QQ 官方）的纯逻辑：Ed25519 验签 / opcode 13 握手 / 事件去重。
 *
 * 官方口径（研究那一路逐页读过）：
 *   • 头 `X-Signature-Ed25519` 与 `X-Signature-Timestamp`，签的是 `timestamp + body`；
 *   • opcode 13 是"平台验证回调地址"，要原样回 `plain_token` + 我们算的签名；
 *   • 同一个事件 `id` 可能重复推送，要按 id 去重（AstrBot 用 60 秒 TTL）。
 * 这里只测纯逻辑；HTTP 监听那层是配置决定，不在这份用例里。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WebhookDedupe,
  ed25519SeedOf,
  signWebhook,
  urlVerifyResponse,
  verifyWebhookSignature,
} from '../src/channel/qq-webhook.ts';

const SECRET = 'test-secret-please-rotate';
const BODY = JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'MSG-1' } });

test('验签：自己签的自己验得过；改一个字节就过不去', () => {
  const ts = '1750000000';
  const signature = signWebhook(SECRET, ts, BODY);
  assert.equal(signature.length, 128, 'Ed25519 签名是 64 字节 → 128 个 hex 字符');
  assert.equal(verifyWebhookSignature({ secret: SECRET, timestamp: ts, signature, body: BODY }), true);

  // 换密钥、改 body、改 timestamp、坏 hex：一律 false（不抛）
  assert.equal(verifyWebhookSignature({ secret: 'other', timestamp: ts, signature, body: BODY }), false);
  assert.equal(verifyWebhookSignature({ secret: SECRET, timestamp: ts, signature, body: `${BODY} ` }), false);
  assert.equal(verifyWebhookSignature({ secret: SECRET, timestamp: '1750000001', signature, body: BODY }), false);
  assert.equal(verifyWebhookSignature({ secret: SECRET, timestamp: ts, signature: 'zz', body: BODY }), false);
  assert.equal(verifyWebhookSignature({ secret: SECRET, timestamp: undefined, signature, body: BODY }), false);
  assert.equal(verifyWebhookSignature({ secret: SECRET, timestamp: ts, signature: undefined, body: BODY }), false);
  // 长度不对（32 字节的 hex）也拒：Ed25519 签名恒为 64 字节
  assert.equal(verifyWebhookSignature({ secret: SECRET, timestamp: ts, signature: 'ab'.repeat(32), body: BODY }), false);
});

test('种子口径：同一个 secret 永远给同一把密钥（跨进程一致是硬要求）', () => {
  assert.equal(ed25519SeedOf(SECRET).length, 32);
  assert.deepEqual(ed25519SeedOf(SECRET), ed25519SeedOf(SECRET));
  assert.notDeepEqual(ed25519SeedOf(SECRET), ed25519SeedOf(`${SECRET}x`));
  // 长 secret 走哈希、短 secret 走重复填充：两种都要稳定在 32 字节
  assert.equal(ed25519SeedOf('x'.repeat(200)).length, 32);
  assert.equal(ed25519SeedOf('short').length, 32);
});

test('opcode 13：地址验证要原样回 plain_token + 我们算的签名', () => {
  const token = 'PLAIN-TOKEN-1';
  const ts = '1750000123';
  const reply = urlVerifyResponse(SECRET, { plain_token: token, event_ts: ts });
  assert.ok(reply !== null);
  assert.equal(reply!.plain_token, token);
  // 平台会拿它自己的公钥验：这里用同一套算法验回去
  assert.equal(
    verifyWebhookSignature({ secret: SECRET, timestamp: ts, signature: reply!.signature, body: token }),
    true,
  );
  // 缺 token 或时间戳 → 不做（宁可不应答，也不回一个瞎编的签名）
  assert.equal(urlVerifyResponse(SECRET, { plain_token: '', event_ts: ts }), null);
  assert.equal(urlVerifyResponse(SECRET, { plain_token: token }), null);
});

test('去重：同一个事件 id 第二次算重复；过了 TTL 又算新的（懒淘汰）', () => {
  let now = 1_700_000_000_000;
  const dedupe = new WebhookDedupe({ now: () => now, ttlMs: 60_000 });
  assert.equal(dedupe.seen('E1'), false, '第一次：处理');
  assert.equal(dedupe.seen('E1'), true, '第二次：丢掉（官方明说会重推）');
  assert.equal(dedupe.seen('E2'), false);
  assert.equal(dedupe.size, 2);
  now += 59_000;
  assert.equal(dedupe.seen('E1'), true, 'TTL 内仍然算重复');
  now += 61_000;
  assert.equal(dedupe.seen('E1'), false, '过了 TTL：当成新事件（重推不会拖这么久）');
  assert.equal(dedupe.size, 1, '过期的条目被顺手清掉（长跑进程不能只涨不落）');
});
