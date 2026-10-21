/**
 * `send_media` 的宿主侧投递口：白名单 / 大小 / 字节读取三条规则。
 *
 * 这一段原来写在 main.ts 里，工具层与通道层各自有测、**中间这段胶水一次都没被执行过**——
 * 验收脚本（tools/channel-check.ts）照出来的正是这一类"写了但没人跑过"的地方。
 */
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync as writeFile } from 'node:fs';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { createWorkspaceMediaPoster } from '../src/channel/media-poster.ts';
import type { ChannelAdapter } from '../src/channel/qq-official.ts';
import { QQ_CHANNEL_NAME, QqMessageSender } from '../src/channel/qq-official.ts';
import { ONEBOT_CHANNEL_NAME, oneBotMediaCall } from '../src/channel/onebot.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

/** 假的平台 HTTP：上传给 file_info、发送给 id；记下每一次请求 */
function fakePlatform() {
  const requests: Array<{ url: string; method: string; jsonBody: unknown }> = [];
  const fn = async (input: { url: string; method: string; jsonBody?: unknown }) => {
    requests.push({ url: input.url, method: input.method, jsonBody: input.jsonBody });
    if (input.url.includes('/files')) {
      return { status: 200, text: '', body: { file_uuid: 'U1', file_info: 'FI-1', ttl: 300 } };
    }
    return { status: 200, text: '', body: { id: 'SENT-1' } };
  };
  return { fn, requests };
}

function workspace(): string {
  const root = tempDirSync("irmia-media-");
  mkdirSync(join(root, "pics"), { recursive: true });
  writeFile(join(root, "pics", "a.png"), Buffer.from([1, 2, 3, 4]));
  return root;
}

function posterFor(dataDir: string, http: { fn: unknown }) {
  const sender = new QqMessageSender({
    token: () => Promise.resolve('ACCESS'),
    http: http.fn as never,
  });
  const channel = {
    name: QQ_CHANNEL_NAME,
    start: () => {},
    stop: () => {},
    sendText: async () => ({ ok: true as const, messageId: "S", passive: false, msgSeq: 1 }),
    // 通道的活：先上传换 file_info，再按 msg_type=7 发（与 QqOfficialChannel.sendMediaTo 同形）
    sendMediaTo: async (chatType: never, chatId: string, media: never, options: never) => {
      const uploaded = await sender.uploadMedia(chatType, chatId, media);
      if (!uploaded.ok) return { ok: false as const, reason: uploaded.reason, passive: false };
      return await sender.sendMedia(chatType, chatId, uploaded.fileInfo, options);
    },
  } as unknown as ChannelAdapter;
  const channels = new Map<string, ChannelAdapter>([[QQ_CHANNEL_NAME, channel]]);
  return createWorkspaceMediaPoster({ dataDir, channels });
}

/** 只造通道表（凭据外发那几条用例要自己传 protectedPaths，用不到整只 poster 工厂） */
function channelsFor(http: { fn: unknown }): Map<string, ChannelAdapter> {
  const sender = new QqMessageSender({ token: () => Promise.resolve('ACCESS'), http: http.fn as never });
  const channel = {
    name: QQ_CHANNEL_NAME,
    start: () => {},
    stop: () => {},
    sendText: async () => ({ ok: true as const, messageId: 'S', passive: false, msgSeq: 1 }),
    sendMediaTo: async (chatType: never, chatId: string, media: never, options: never) => {
      const uploaded = await sender.uploadMedia(chatType, chatId, media);
      if (!uploaded.ok) return { ok: false as const, reason: uploaded.reason, passive: false };
      return await sender.sendMedia(chatType, chatId, uploaded.fileInfo, options);
    },
  } as unknown as ChannelAdapter;
  return new Map<string, ChannelAdapter>([[QQ_CHANNEL_NAME, channel]]);
}

/** 两个允许根（数据目录 + 工作根）的投递口，`posterFor` 的两根版 */function posterForTwo(dataDir: string, workspaceRoot: string, http: { fn: unknown }) {
  const sender = new QqMessageSender({
    token: () => Promise.resolve('ACCESS'),
    http: http.fn as never,
  });
  const channel = {
    name: QQ_CHANNEL_NAME,
    start: () => {},
    stop: () => {},
    sendText: async () => ({ ok: true as const, messageId: "S", passive: false, msgSeq: 1 }),
    sendMediaTo: async (chatType: never, chatId: string, media: never, options: never) => {
      const uploaded = await sender.uploadMedia(chatType, chatId, media);
      if (!uploaded.ok) return { ok: false as const, reason: uploaded.reason, passive: false };
      return await sender.sendMedia(chatType, chatId, uploaded.fileInfo, options);
    },
  } as unknown as ChannelAdapter;
  const channels = new Map<string, ChannelAdapter>([[QQ_CHANNEL_NAME, channel]]);
  return createWorkspaceMediaPoster({ dataDir, workspaceRoot, channels });
}

test('工作区里的文件：读成字节交给通道层，上传 + msg_type=7 一条龙', async () => {
  const root = workspace();
  const http = fakePlatform();
  const poster = posterFor(root, http);
  const outcome = await poster.post({ url: 'qq:c2c:U-1', idempotencyKey: 't1' }, { fileType: 1, path: 'pics/a.png' });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  // 2026-10-18（review P1-12）：平台回的 messageId 必须带出投递口（过去在这里被窄化成 `{ok,status}`）
  assert.ok(outcome.ok);
  assert.equal(outcome.messageId, 'SENT-1', '通道回了 id 就要带上来（read_channel 的 ·m<id> 靠它）');
  assert.equal(http.requests[0]?.url, 'https://api.bot.qq.com/v2/users/U-1/files');
  assert.equal((http.requests[0]?.jsonBody as Record<string, unknown>)['file_name'], 'a.png', '文件名取自真实路径');
  const sent = http.requests[1]?.jsonBody as Record<string, unknown>;
  assert.equal(sent["msg_type"], 7);
  assert.deepEqual(sent['media'], { file_info: 'FI-1' });
});

test('白名单：`../` 绕出去、同前缀的兄弟目录、不存在的文件，一律拒且不发请求', async () => {
  const root = workspace();
  const http = fakePlatform();
  const poster = posterFor(root, http);
  const target = { url: 'qq:c2c:U-1', idempotencyKey: 't1' };
  const escape = await poster.post(target, { fileType: 1, path: '../outside.png' });
  assert.equal(escape.ok, false);
  assert.ok(escape.ok === false && escape.reason.includes('只能发工作区'));
  const sibling = await poster.post(target, { fileType: 1, path: `${root}-evil/x.png` });
  assert.equal(sibling.ok, false, '同前缀的兄弟目录也要挡（不是简单的 startsWith）');
  const missing = await poster.post(target, { fileType: 1, path: 'pics/none.png' });
  assert.equal(missing.ok, false);
  assert.ok(missing.ok === false && missing.reason.includes('不存在'));
  assert.equal(http.requests.length, 0, "被拒的路径一次网络都不该发");
});

test('网络地址直接透传（不去下载中转）；超过上限的文件拒掉', async () => {
  const root = workspace();
  const http = fakePlatform();
  const channels = new Map<string, ChannelAdapter>();
  const sender = new QqMessageSender({ token: () => Promise.resolve("ACCESS"), http: http.fn as never });
  const channel = {
    name: QQ_CHANNEL_NAME, start: () => {}, stop: () => {},
    sendText: async () => ({ ok: true as const, messageId: "S", passive: false, msgSeq: 1 }),
    // 通道的活：先上传换 file_info，再按 msg_type=7 发（与 QqOfficialChannel.sendMediaTo 同形）
    sendMediaTo: async (chatType: never, chatId: string, media: never, options: never) => {
      const uploaded = await sender.uploadMedia(chatType, chatId, media);
      if (!uploaded.ok) return { ok: false as const, reason: uploaded.reason, passive: false };
      return await sender.sendMedia(chatType, chatId, uploaded.fileInfo, options);
    },
  } as unknown as ChannelAdapter;
  channels.set(QQ_CHANNEL_NAME, channel);
  const tiny = createWorkspaceMediaPoster({ dataDir: root, channels, maxBytes: 2 });
  const outcome = await tiny.post({ url: 'qq:c2c:U-1', idempotencyKey: 't1' }, { fileType: 1, path: 'pics/a.png' });
  assert.equal(outcome.ok, false, '超过上限就拒（别把内存打爆）');
  assert.ok(outcome.ok === false && outcome.reason.includes('太大'));

  const poster = createWorkspaceMediaPoster({ dataDir: root, channels });
  const url = await poster.post({ url: 'qq:c2c:U-1', idempotencyKey: 't1' },
    { fileType: 1, url: 'https://example.invalid/remote.png' });
  assert.equal(url.ok, true);
  const upload = http.requests.filter((r) => r.url.includes('/files')).at(-1);
  assert.equal((upload?.jsonBody as Record<string, unknown>)['url'], 'https://example.invalid/remote.png',
    '网络地址原样交给平台（我们不做下载中转）');
});

test('大小门对**带字节**的请求同样有效（早退不再绕过闸门，review P1-09）', async () => {
  const root = workspace();
  const http = fakePlatform();
  // 工具层递下来的形状就是 data（+ path），走的是 with-data 早退那条分支
  const tiny = createWorkspaceMediaPoster({ dataDir: root, channels: channelsFor(http), maxBytes: 4 });
  const target = { url: 'qq:c2c:U-1', idempotencyKey: 't1' };

  const exactly = await tiny.post(target, { fileType: 1, data: new Uint8Array([1, 2, 3, 4]) });
  assert.equal(exactly.ok, true, `恰好等于上限该放行：${JSON.stringify(exactly)}`);

  const before = http.requests.length;
  const tooBig = await tiny.post(target, { fileType: 1, data: new Uint8Array([1, 2, 3, 4, 5]) });
  assert.equal(tooBig.ok, false, '超过上限就拒（别把内存打爆）');
  assert.ok(tooBig.ok === false && tooBig.reason.includes('太大'), tooBig.reason);
  assert.equal(http.requests.length, before, '被拒的那条一个网络请求都不该发');
});

// ──────────────────────────────── 两个允许根（P1，2026-10-04） ────────────────────────────────
//
// 这一段治的是一个真实断链：`http_download` 落在**工作根**（仓库根）的 `workspace/` 下，
// 而这里的白名单只认 `<dataDir>`，于是**下载下来的图发不出去**（实测 t285 连撞两次）。
// 两个根都要能到，但谁在前的顺序不能反——她四天里发成的 32 次媒体路径形态是
// `workspace/tmp/irmia_selfie_*.png`，那是相对 `<dataDir>` 写的。

test('两个允许根：download 落在工作根的文件发得出去（断链接上）', async () => {
  const dataDir = workspace();
  const repoRoot = tempDirSync('irmia-repo-');
  mkdirSync(join(repoRoot, 'workspace', 'qq-images'), { recursive: true });
  writeFile(join(repoRoot, 'workspace', 'qq-images', 'dl.jpg'), Buffer.from([9, 9, 9]));

  const http = fakePlatform();
  const poster = posterForTwo(dataDir, repoRoot, http);
  const outcome = await poster.post({ url: 'qq:c2c:U-1', idempotencyKey: 't1' },
    { fileType: 1, path: 'workspace/qq-images/dl.jpg' });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal((http.requests[0]?.jsonBody as Record<string, unknown>)['file_name'], 'dl.jpg');
});

test('两个允许根：数据目录优先——同名路径下取的是她既有写法那一个', async () => {
  const dataDir = workspace();
  const repoRoot = tempDirSync('irmia-repo-');
  // 两边都有 `pics/a.png`，内容不同：谁赢由**顺序**决定，不由长短决定
  mkdirSync(join(repoRoot, 'pics'), { recursive: true });
  writeFile(join(repoRoot, 'pics', 'a.png'), Buffer.from([7, 7]));

  const http = fakePlatform();
  const poster = posterForTwo(dataDir, repoRoot, http);
  const outcome = await poster.post({ url: 'qq:c2c:U-1', idempotencyKey: 't1' }, { fileType: 1, path: 'pics/a.png' });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  // 数据目录那份是 4 字节（见 workspace()），仓库根那份是 2 字节
  const uploaded = http.requests[0]?.jsonBody as Record<string, unknown> | undefined;
  assert.equal(Buffer.byteLength(String(uploaded?.['file_data'] ?? ''), 'base64'), 4,
    '顺序固定：dataDir 先试，命中就不看第二个根');
});

test('两个允许根也不会让 `../` 变宽：每个候选都必须落在它自己的根内', async () => {
  const dataDir = join(workspace(), 'inner');
  mkdirSync(dataDir, { recursive: true });
  const repoRoot = tempDirSync('irmia-repo-');
  writeFile(join(repoRoot, 'outside.png'), Buffer.from([1]));

  const http = fakePlatform();
  const poster = posterForTwo(dataDir, repoRoot, http);
  // 从 dataDir 往上爬一层正好落在 repoRoot 里 —— 但候选必须落在**它自己的根**内，所以仍旧拒
  const escape = await poster.post({ url: 'qq:c2c:U-1', idempotencyKey: 't1' },
    { fileType: 1, path: '../../outside.png' });
  assert.equal(escape.ok, false, '允许根变多了，能绕出去的地方一点没多');
  assert.ok(escape.ok === false && escape.reason.includes('只能发工作区'));
  assert.equal(http.requests.length, 0);
});

test('两个根都找不到时，回执要把找过的地方摆出来（不诚实的"不存在"她没法修）', async () => {
  const dataDir = workspace();
  const repoRoot = tempDirSync('irmia-repo-');
  const http = fakePlatform();
  const poster = posterForTwo(dataDir, repoRoot, http);
  const outcome = await poster.post({ url: 'qq:c2c:U-1', idempotencyKey: 't1' },
    { fileType: 1, path: 'workspace/tmp/nope.png' });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.ok === false && outcome.reason.includes('不存在'));
  assert.ok(outcome.ok === false && outcome.reason.includes(dataDir), '要找过的两个候选都摆出来');
  assert.ok(outcome.ok === false && outcome.reason.includes(repoRoot));
});

test('不传 workspaceRoot 时行为与从前一字不差（老调用点不受影响）', async () => {
  const root = workspace();
  const http = fakePlatform();
  // 只有一个根：仓库根那种路径仍然发不出去
  const poster = posterFor(root, http);
  const outcome = await poster.post({ url: 'qq:c2c:U-1', idempotencyKey: 't1' },
    { fileType: 1, path: 'workspace/qq-images/dl.jpg' });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.ok === false && outcome.reason.includes('文件不存在'),
    '单根时"找不到"就是找不到，且不要多嘴列候选');
});

// ──────────────────────────────── 凭据不外发（受保护路径，2026-10-05） ────────────────────────────────
//
// 用户点名的那件事：允许根里放着 `data/.keys.json`，于是"把密钥发给通道"曾经是成立的。
// 口径要分清——**不是**限制她能读（`trust.mode = 'full'` 下她本来就能读），挡的是**发出去**：
// 读到本机文件与把密钥交给第三方是两件事。名单与 fs 写入口用同一份（装配层传进来），
// 判定复用 fs/path-guard 的 `insideAny`，识别发生在**读字节之前**。

/** 造一份带凭据的数据目录：`data/.keys.json` 等，内容都是可被搜出来的哨兵串 */
function dataDirWithSecrets(): { dataDir: string; secrets: Record<string, string> } {
  const dataDir = workspace();
  const secrets: Record<string, string> = {
    '.keys.json': 'SENTINEL-KEYS-0123456789',
    '.auth.json': 'SENTINEL-AUTH-0123456789',
    '.webhook-secret.json': 'SENTINEL-WEBHOOK-0123456789',
    '.ui-token': 'SENTINEL-UITOKEN-0123456789',
  };
  for (const [name, content] of Object.entries(secrets)) {
    writeFile(join(dataDir, name), content);
  }
  return { dataDir, secrets };
}

function protectedPathsOf(dataDir: string): string[] {
  return ['.keys.json', '.auth.json', '.webhook-secret.json', '.ui-token'].map((n) => join(dataDir, n));
}

test('凭据文件一律不外发：拒绝、不发请求、回执里不含文件内容', async () => {
  const { dataDir, secrets } = dataDirWithSecrets();
  const http = fakePlatform();
  const poster = createWorkspaceMediaPoster({
    dataDir,
    channels: channelsFor(http),
    protectedPaths: protectedPathsOf(dataDir),
  });
  const target = { url: 'qq:c2c:U-1', idempotencyKey: 't1' };

  for (const [name, sentinel] of Object.entries(secrets)) {
    const outcome = await poster.post(target, { fileType: 4, path: name });
    assert.equal(outcome.ok, false, `${name} 不该发得出去`);
    assert.ok(outcome.ok === false && outcome.reason.includes('本机凭据文件'), outcome.reason);
    assert.ok(outcome.ok === false && outcome.reason.includes('设置页'), '拒绝理由要给出路');
    // 两件都要紧：① 内容没跟着回执漏出去 ② 连文件名之外的字节都没被读进上传请求
    assert.ok(!JSON.stringify(outcome).includes(sentinel), `${name} 的内容不得出现在回执里`);
  }
  assert.equal(http.requests.length, 0, '被拒的凭据一次网络都不该发');
});

test('凭据文件：**带字节**的请求也在早退前被拒（v64 起 `send_media` 走的就是这条）', async () => {
  const { dataDir, secrets } = dataDirWithSecrets();
  const http = fakePlatform();
  const poster = createWorkspaceMediaPoster({
    dataDir,
    channels: channelsFor(http),
    protectedPaths: protectedPathsOf(dataDir),
  });
  const target = { url: 'qq:c2c:U-1', idempotencyKey: 't1' };
  for (const [name, sentinel] of Object.entries(secrets)) {
    // 工具层的真实形状：`data`（字节）+ 校验过的绝对 `path` 一起下来 ⇒ 走 with-data 早退分支
    const outcome = await poster.post(target, {
      fileType: 4,
      path: join(dataDir, name),
      data: new Uint8Array(Buffer.from(sentinel)),
      name,
    });
    assert.equal(outcome.ok, false, `${name} 不该发得出去（带字节那条）`);
    assert.ok(outcome.ok === false && outcome.reason.includes('本机凭据文件'), outcome.reason);
    assert.ok(!JSON.stringify(outcome).includes(sentinel), `${name} 的内容不得出现在回执里`);
  }
  assert.equal(http.requests.length, 0, '被拒的凭据一次网络都不该发（早退那条也一样）');
});

test('凭据判定在早退前也读 realpath：目录联接**带字节**同样绕不过去', async () => {
  const { dataDir } = dataDirWithSecrets();
  const http = fakePlatform();
  const poster = createWorkspaceMediaPoster({
    dataDir,
    channels: channelsFor(http),
    protectedPaths: protectedPathsOf(dataDir),
  });
  const link = join(dataDir, 'workspace2', 'link-to-data');
  mkdirSync(join(dataDir, 'workspace2'), { recursive: true });
  try {
    symlinkSync(dataDir, link, 'junction');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return; // 无权限时跳过，而不是假装测过
    throw err;
  }
  const outcome = await poster.post({ url: 'qq:c2c:U-1', idempotencyKey: 't1' }, {
    fileType: 4,
    path: join(link, '.keys.json'),
    data: new Uint8Array([1, 2, 3]),
  });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.ok === false && outcome.reason.includes('本机凭据文件'), outcome.reason);
  assert.equal(http.requests.length, 0);
});

test('同一份名单之外的普通文件**带字节**照旧发得出去（门只挡凭据，不挡媒体）', async () => {
  const { dataDir } = dataDirWithSecrets();
  const http = fakePlatform();
  const poster = createWorkspaceMediaPoster({
    dataDir,
    channels: channelsFor(http),
    protectedPaths: protectedPathsOf(dataDir),
  });
  const outcome = await poster.post({ url: 'qq:c2c:U-1', idempotencyKey: 't1' }, {
    fileType: 4,
    path: join(dataDir, 'pics', 'a.png'),
    data: new Uint8Array([1, 2, 3, 4]),
    name: 'a.png',
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(http.requests.length, 2, '上传 + 发送各一次');
});

test('同一份名单之外的普通文件照旧发得出去（门只挡凭据，不挡媒体）', async () => {
  const { dataDir } = dataDirWithSecrets();
  const http = fakePlatform();
  const poster = createWorkspaceMediaPoster({
    dataDir,
    channels: channelsFor(http),
    protectedPaths: protectedPathsOf(dataDir),
  });
  const outcome = await poster.post({ url: 'qq:c2c:U-1', idempotencyKey: 't1' },
    { fileType: 1, path: 'pics/a.png' });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(http.requests.length, 2, '上传 + 发送各一次');
});

test('目录联接指向凭据目录：绕不过去（判定读的是 realpath，不是字符串）', async () => {
  const { dataDir } = dataDirWithSecrets();
  const http = fakePlatform();
  const poster = createWorkspaceMediaPoster({
    dataDir,
    channels: channelsFor(http),
    protectedPaths: protectedPathsOf(dataDir),
  });
  const link = join(dataDir, 'workspace', 'link-to-data');
  mkdirSync(join(dataDir, 'workspace'), { recursive: true });
  try {
    // Windows 上 junction 不需要管理员权限（与 fs-tools 的符号链接用例同一手法）
    symlinkSync(dataDir, link, 'junction');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return; // 无权限时跳过，而不是假装测过
    throw err;
  }
  // 字符串层看它是 `data/workspace/link-to-data/.keys.json`（在允许根内），
  // 展开后才是真正要读的 `<dataDir>/.keys.json`
  const outcome = await poster.post({ url: 'qq:c2c:U-1', idempotencyKey: 't1' },
    { fileType: 4, path: 'workspace/link-to-data/.keys.json' });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.ok === false && outcome.reason.includes('本机凭据文件'), outcome.reason);
  assert.equal(http.requests.length, 0);
});

// ──────────────────────── OneBot 也能发媒体（2026-10-07 对齐两条通道） ────────────────────────
//
// 这一段治的是报告 §3.1/§1.2 的那条：`send_media` 在 OneBot 上**根本不存在**
// （`main.ts` 只在 `qqChannel !== null` 时装配 mediaPoster，`qq-official.ts` 的工厂只认
// `qq:` 前缀与 `QQ_CHANNEL_NAME`）。现在分派按**回投地址的 scheme** 走，而"发不发得了"
// 由通道自己声明（有没有 `sendMediaTo`）。
//
// 注意这几条只验**构造**（动作名、参数名、段类型、来源形态）——没有真的协议端可连，
// 见提交说明的"未实测"。

describe('媒体投递 · OneBot 那条路（段构造与分派）', () => {
  test('图片：网络地址走消息段（send_group_msg + type:image，不构造 CQ 码数组）', () => {
    const call = oneBotMediaCall(true, '20002', { fileType: 1, url: 'https://example.invalid/a.png' });
    assert.equal(call.ok, true);
    assert.ok(call.ok);
    assert.equal(call.action, 'send_group_msg');
    assert.deepEqual(call.params, {
      group_id: 20002,
      message: [{ type: 'image', data: { file: 'https://example.invalid/a.png' } }],
    });
    assert.equal(call.returnsMessageId, true, '消息段那条会回 message_id');
  });

  test('本机字节：`base64://` 交给协议端（它认这种来源），不往盘上写临时文件', () => {
    const call = oneBotMediaCall(false, '10001', { fileType: 1, data: new Uint8Array([1, 2, 3]) });
    assert.ok(call.ok);
    assert.equal(call.action, 'send_private_msg');
    const segment = (call.params['message'] as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual(segment, { type: 'image', data: { file: 'base64://AQID' } });
  });

  test('四类媒体各自映到 OneBot 的形态：图/视频/语音是消息段，文件是上传动作', () => {
    const video = oneBotMediaCall(true, '20002', { fileType: 2, url: 'https://x/v.mp4', name: 'v.mp4' });
    assert.ok(video.ok);
    assert.deepEqual(video.params['message'], [{ type: 'video', data: { file: 'https://x/v.mp4', name: 'v.mp4' } }]);
    const voice = oneBotMediaCall(true, '20002', { fileType: 3, url: 'https://x/v.silk' });
    assert.ok(voice.ok);
    assert.deepEqual(voice.params['message'], [{ type: 'record', data: { file: 'https://x/v.silk' } }]);
    // 文件：OneBot 11 里这是**独立动作**，不是消息段（协议端的 `file` 段只承接入站）
    const file = oneBotMediaCall(true, '20002', { fileType: 4, path: 'D:/tmp/report.pdf', name: '报告.pdf' });
    assert.ok(file.ok);
    assert.equal(file.action, 'upload_group_file');
    assert.deepEqual(file.params, { group_id: 20002, file: 'D:/tmp/report.pdf', name: '报告.pdf' });
    assert.equal(file.returnsMessageId, false, '上传文件那条回的是 file_id，不是 message_id');
    const privateFile = oneBotMediaCall(false, '10001', { fileType: 4, path: 'D:/tmp/a.zip' });
    assert.ok(privateFile.ok);
    assert.equal(privateFile.action, 'upload_private_file');
  });

  test('发不出去的两条如实说：文件类没有本机路径、媒体什么都没有', () => {
    const noPath = oneBotMediaCall(true, '20002', { fileType: 4, url: 'https://x/a.zip' });
    assert.equal(noPath.ok, false);
    assert.ok(noPath.ok === false && noPath.reason.includes('本机路径'), noPath.reason);
    const empty = oneBotMediaCall(true, '20002', { fileType: 1 });
    assert.equal(empty.ok, false);
    assert.ok(empty.ok === false && empty.reason.includes('发不出去'));
  });

  test('分派：`onebot:` 地址交给 OneBot 通道的 sendMediaTo（不再按通道名写死）', async () => {
    const root = workspace();
    const seen: Array<{ chatType: string; chatId: string; media: unknown }> = [];
    const onebot = {
      name: ONEBOT_CHANNEL_NAME, start: () => {}, stop: () => {},
      sendText: async () => ({ ok: true as const, messageId: 'S', passive: false, msgSeq: 0 }),
      sendMediaTo: async (chatType: string, chatId: string, media: unknown) => {
        seen.push({ chatType, chatId, media });
        return { ok: true as const, messageId: 'M-1', passive: false, msgSeq: 0 };
      },
    } as unknown as ChannelAdapter;
    const channels = new Map<string, ChannelAdapter>([[ONEBOT_CHANNEL_NAME, onebot]]);
    const poster = createWorkspaceMediaPoster({ dataDir: root, channels });
    const outcome = await poster.post(
      { url: 'onebot:group:20002', idempotencyKey: 't1' },
      { fileType: 1, path: 'pics/a.png' },
    );
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    // 2026-10-18（review P1-12）：OneBot 的 `sendMediaTo` 回的 messageId 同样要带出投递口
    assert.ok(outcome.ok);
    assert.equal(outcome.messageId, 'M-1');
    assert.deepEqual(seen.map((s) => [s.chatType, s.chatId]), [['group', '20002']]);
    // 字节是宿主读的（工具层只递路径）——OneBot 那条路把它变成 base64，见上面那条用例
    const media = seen[0]?.media as { data?: Uint8Array; name?: string };
    assert.deepEqual([...(media.data ?? [])], [1, 2, 3, 4]);
    assert.equal(media.name, 'a.png');
  });

  test('通道没有 sendMediaTo：如实说清是哪条通道，不假装发过', async () => {
    const root = workspace();
    const mute = {
      name: ONEBOT_CHANNEL_NAME, start: () => {}, stop: () => {},
      sendText: async () => ({ ok: true as const, messageId: 'S', passive: false, msgSeq: 0 }),
    } as unknown as ChannelAdapter;
    const poster = createWorkspaceMediaPoster({
      dataDir: root,
      channels: new Map<string, ChannelAdapter>([[ONEBOT_CHANNEL_NAME, mute]]),
    });
    const outcome = await poster.post({ url: 'onebot:c2c:10001', idempotencyKey: 't1' },
      { fileType: 1, url: 'https://example.invalid/a.png' });
    assert.equal(outcome.ok, false);
    assert.ok(outcome.ok === false && outcome.reason.includes(ONEBOT_CHANNEL_NAME), outcome.reason);
    assert.ok(outcome.ok === false && outcome.reason.includes('不支持发媒体'));
  });

  test('回投地址不是回投地址：如实报错，不去猜通道', async () => {
    const root = workspace();
    const poster = createWorkspaceMediaPoster({
      dataDir: root,
      channels: new Map<string, ChannelAdapter>([[ONEBOT_CHANNEL_NAME,
        { name: ONEBOT_CHANNEL_NAME, start: () => {}, stop: () => {},
          sendText: async () => ({ ok: true as const, messageId: 'S', passive: false, msgSeq: 0 }) } as unknown as ChannelAdapter]]),
    });
    const outcome = await poster.post({ url: 'nonsense', idempotencyKey: 't1' }, { fileType: 1, path: 'pics/a.png' });
    assert.equal(outcome.ok, false);
  });
});

