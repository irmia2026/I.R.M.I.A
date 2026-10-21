/**
 * 「什么形态的图才进上下文」的判据与**回归** — src/log/types.ts + src/channel/attachment-store.ts
 *
 * 治的是什么（2026-10-07 现场，P0）：OneBot 发来的图片进了请求体，载荷却是 `data:image;base64,…`
 * ——附件的 `type` 是**段类型裸标签** `image`，被直接当 MIME 拼了进去。模型侧的回应是
 * `input[35]: You have uploaded an unsupported image …`（400），于是 turn 885~898 **每一拍**
 * 都以同一个错结束、她完全不出声，输入认领三次后进死信。
 *
 * 这个文件锁三件事：
 *   ① 判据本身：什么地址 + 什么声明 + 什么字节才算"进"（`contextImageAdmission` / `buildContextImage`）；
 *   ② **一张不合格的图不许废掉整拍**——这是今天的病根，也是这一组里最要紧的一条；
 *   ③ 不合格的图**不影响同一条消息的其他内容**（正文、别的附件照常进）。
 *
 * 判据的最终形状（四条，全部可核对）：
 *   · 地址必须 `http(s)`（模型自己取得动）或拆得开的 `data:`（内联字节）；
 *   · 声明要么是白名单 MIME（webp/png/jpeg/gif），要么是裸标签 `image`（"这是张图，格式看字节"）；
 *   · 字节到手时**字节头说了算**——认不出这四种之一就不进；
 *   · 拼 data URL 只此一处（`buildContextImage`），拼不出来就给 null、绝不硬塞。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildContextImage,
  contextImageAdmission,
  contextImageSkipText,
  sniffImageMediaType,
  type AppEvent,
  type ContextImageSkipReason,
} from '../src/log/types.ts';
import { defaultVisibility } from '../src/log/types.ts';
import { attachmentPath, ensureAttachment, readAttachmentImage, readFileImage } from '../src/channel/attachment-store.ts';
import { render } from '../src/model/render.ts';
import type { RenderImageRef, RenderedRequest } from '../src/model/render.ts';
import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { applyOne, fold } from '../src/state/fold.ts';
import { RealLoop } from '../src/runtime/real-loop.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

// ──────────────────────────── 真实字节（不再用 'png-bytes' 这种假串） ────────────────────────────

/** 合法 PNG 的文件头（8 字节签名 + IHDR 长度/类型，够让字节头判据认出来） */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR', 'latin1'),
  Buffer.alloc(9, 0),
]);
/** 合法 JPEG 头（SOI + APP0/JFIF） */
const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF\0', 'latin1'),
  Buffer.alloc(8, 0),
]);
/** 合法 GIF 头（GIF89a） */
const GIF_BYTES = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(8, 0)]);
/** 合法 WebP 头（RIFF….WEBP）——现场那张图就是这个形态 */
const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0xc4, 0x4d, 0x10, 0x00]),
  Buffer.from('WEBP', 'latin1'),
  Buffer.alloc(8, 0),
]);
/** 一张"看起来像图但格式不认"的字节（BMP：`BM`） */
const BMP_BYTES = Buffer.concat([Buffer.from('BM', 'latin1'), Buffer.alloc(16, 0)]);

function reasonsOf(url: string, mime?: string): { admitted: boolean; reason?: ContextImageSkipReason } {
  const verdict = contextImageAdmission({ url, ...(mime === undefined ? {} : { mime }) });
  return verdict.admitted ? { admitted: true } : { admitted: false, reason: verdict.reason };
}

// ──────────────────────────── ① 判据：地址形态 ────────────────────────────

test('地址形态：http(s) 进；file:// 与 base64:// 一律不进（模型侧取不到），理由如实且能翻成人话', () => {
  // 现场那条 OneBot 图的形状：协议端给的 http(s) 直链 + 裸标签 `image`
  assert.deepEqual(
    reasonsOf('https://multimedia.nt.qq.com.cn/download?fileid=x&rkey=y', 'image'),
    { admitted: true },
    'http(s) + 裸标签 `image`：值得去取字节（型别由字节头定），这一条正是今晚断掉的路',
  );
  assert.deepEqual(reasonsOf('https://example.test/a.png', 'image/png'), { admitted: true });

  // file:// —— 协议端与本进程同机的路径：模型侧（服务端）取不到，进上下文只会换来 400
  assert.deepEqual(
    reasonsOf('file:///D:/qq/images/a.png', 'image'),
    { admitted: false, reason: 'not-http-url' },
  );
  assert.deepEqual(
    reasonsOf('file:///D:/qq/images/a.png', 'image/png'),
    { admitted: false, reason: 'not-http-url' },
    '地址那一条先判：file:// 连"值得去取字节"都不成立',
  );

  // base64:// —— 没解析的段（协议端的另一种写法）：同样不是模型取得动的地址
  assert.deepEqual(
    reasonsOf('base64://iVBORw0KGgo=', 'image'),
    { admitted: false, reason: 'not-http-url' },
  );
  assert.deepEqual(reasonsOf('a.jpg', 'image'), { admitted: false, reason: 'not-http-url' }, '裸文件名也不是地址');

  // 理由码必须能翻成一句人话（留痕里印的就是它）
  assert.match(contextImageSkipText('not-http-url'), /file:\/\//u);
  assert.match(contextImageSkipText('not-http-url'), /vision_read/u, '要指出改走哪条路，不能只说"不行"');
});

test('地址形态：拆得开的 data:（内联字节）进，拆不开的不进——这是 base64 那条路唯一合法的形态', () => {
  const inline = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
  assert.deepEqual(reasonsOf(inline, 'image'), { admitted: true });

  assert.deepEqual(
    reasonsOf('data:image;base64,AAAA', 'image'),
    { admitted: false, reason: 'data-url-unreadable' },
    '内联字节里声明的型别也必须是白名单之一——`image` 裸标签在这里同样不算数',
  );
  assert.deepEqual(
    reasonsOf('data:image/bmp;base64,AAAA', 'image'),
    { admitted: false, reason: 'data-url-unreadable' },
  );
  assert.deepEqual(reasonsOf('data:image/png;base64,', 'image'), { admitted: false, reason: 'data-url-unreadable' });
});

// ──────────────────────────── ② 判据：声明与字节 ────────────────────────────

test('声明那一栏：白名单 MIME 与裸标签 `image` 都算"这是张图"，明确的非白名单型别直接不进', () => {
  const url = 'https://example.test/x';
  for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'IMAGE/PNG', 'image/png; charset=binary']) {
    assert.equal(contextImageAdmission({ url, mime }).admitted, true, `${mime} 在白名单里`);
  }
  assert.equal(contextImageAdmission({ url, mime: 'image' }).admitted, true, '裸标签：格式交给字节头');
  for (const mime of ['image/bmp', 'image/tiff', 'image/svg+xml', 'application/octet-stream', '', undefined]) {
    assert.deepEqual(
      contextImageAdmission({ url, mime }).admitted,
      false,
      `${String(mime)} 不是模型认的形态，不许进（进了就是 400）`,
    );
  }
  assert.match(contextImageSkipText('unknown-media-type'), /webp\/png\/jpeg\/gif/u);
});

test('字节头认型别：png/jpeg/gif/webp 四种认得出，别的认不出（认不出就不进）', () => {
  assert.equal(sniffImageMediaType(PNG_BYTES), 'image/png');
  assert.equal(sniffImageMediaType(JPEG_BYTES), 'image/jpeg');
  assert.equal(sniffImageMediaType(GIF_BYTES), 'image/gif');
  assert.equal(sniffImageMediaType(WEBP_BYTES), 'image/webp', '现场那张图就是 RIFF….WEBP');
  assert.equal(sniffImageMediaType(BMP_BYTES), null);
  assert.equal(sniffImageMediaType(Buffer.alloc(2)), null, '太短 = 认不出，不是"猜一个"');
  assert.equal(sniffImageMediaType(undefined), null);
});

test('buildContextImage：型别与 data URL 前缀**逐字一致**，字节头优先于声明', () => {
  const png = buildContextImage(PNG_BYTES, 'image');
  assert.equal(png?.mediaType, 'image/png', '声明是裸标签时，型别由字节头说了算——这就是今晚那条病的解药');
  assert.equal(png?.dataUrl, `data:image/png;base64,${PNG_BYTES.toString('base64')}`);
  assert.ok(png !== null && png.dataUrl.startsWith(`data:${png.mediaType};base64,`));

  const webp = buildContextImage(WEBP_BYTES, 'image');
  assert.equal(webp?.mediaType, 'image/webp');

  // 声明说 jpeg、字节头说 png：以字节为准（声明是适配器填的，字节是服务端要读的）
  assert.equal(buildContextImage(PNG_BYTES, 'image/jpeg')?.mediaType, 'image/png');

  // 两边都说不出白名单型别：**不拼**（NaN 一个都不许进请求体）
  assert.equal(buildContextImage(BMP_BYTES, 'image/bmp'), null);
  assert.equal(buildContextImage(BMP_BYTES, 'image'), null, '裸标签 + 认不出的字节 = 不进');
});

// ──────────────────────────── ③ 最后一米：附件仓库 ────────────────────────────

async function startHost(body: Buffer): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('readAttachmentImage：声明是裸标签 `image`、字节是 webp ⇒ 进，且前缀是 data:image/webp', async (t) => {
  const dataDir = tempDirSync('irmia-admit-');
  const host = await startHost(WEBP_BYTES);
  t.after(async () => { await host.close(); rmSync(dataDir, { recursive: true, force: true }); });

  const url = `${host.origin}/a.png`;
  const fetched = await ensureAttachment(dataDir, url);
  assert.equal(fetched.outcome, 'fetched');

  const read = readAttachmentImage(dataDir, { source: 'remote', key: url, mime: 'image' });
  assert.equal(read.ok, true, '这一段字节是模型认的 webp，就该进');
  assert.equal(read.ok && read.image.mediaType, 'image/webp');
  assert.ok(read.ok && read.image.dataUrl.startsWith('data:image/webp;base64,'));
  assert.ok(
    read.ok && !read.image.dataUrl.startsWith('data:image;base64,'),
    '**不许**再出现 data:image;base64,——那正是今晚那一串 400',
  );
});

test('readAttachmentImage：认不出的字节不进，理由说得清（不是静默丢弃）', async (t) => {
  const dataDir = tempDirSync('irmia-admit-');
  const host = await startHost(BMP_BYTES);
  t.after(async () => { await host.close(); rmSync(dataDir, { recursive: true, force: true }); });

  const url = `${host.origin}/a.bmp`;
  await ensureAttachment(dataDir, url);
  const read = readAttachmentImage(dataDir, { source: 'remote', key: url, mime: 'image' });
  assert.deepEqual(read, { ok: false, reason: 'unknown-media-type' });

  const missing = readAttachmentImage(dataDir, { source: 'remote', key: `${host.origin}/never.png`, mime: 'image' });
  assert.deepEqual(missing, { ok: false, reason: 'no-local-bytes' }, '没字节 = 这一轮不进（不是错误）');
  assert.match(contextImageSkipText('no-local-bytes'), /直链已经过期|还没下载/u);
});

// ──────────────────────────── ④ 回归：一张图不许废掉整拍 ────────────────────────────

interface RigOptions {
  loadImage?: ((ref: RenderImageRef) => { mediaType: string; dataUrl: string } | null) | null;
  maxContextImages?: number;
}

/** 与运行期同一条渲染路径（`render`）：事件流 + 唤醒那一条 → 请求体 */
function renderOnce(events: AppEvent[], options: RigOptions = {}): RenderedRequest {
  return render({
    events,
    persona: { identity: 'i', constitution: 'c', style: 's', state: '' },
    tools: [],
    wakeEvent: null,
    taskCard: null,
    now: '2026-10-07T03:20:00.000Z',
    timezone: 'Asia/Shanghai',
    model: 'deepseek-v4-pro',
    lane: 'heavy',
    contact: null,
    mentionNotice: null,
    machine: null,
    usage: null,
    asks: null,
    injection: null,
    loadImage: options.loadImage ?? null,
    maxContextImages: options.maxContextImages ?? 2,
    softHint: null,
    memoryIndex: null,
    skillCatalog: null,
    turnBlock: null,
    stateBytes: null,
    stateBudgetBytes: null,
  });
}

function oneBotEvent(seq: number, attachments: Array<{ type: string; url?: string; name?: string }>): AppEvent {
  return {
    seq,
    ts: '2026-10-07T03:19:00.000Z',
    type: 'wake/channel',
    data: {
      channel: 'onebot',
      chatType: 'group-at',
      person: '10001',
      chatId: '123456780',
      text: '看看这两张，第二张是重点',
      messageId: `m${seq}`,
      msgSeq: seq,
      dedupeKey: `onebot:m${seq}`,
      attachments,
    },
    visibility: defaultVisibility('wake/channel'),
    origin: 'test/context-image',
  } as unknown as AppEvent;
}

/** 请求体里所有 input_image 的 image_url（顺序即进上下文的那一张张） */
function imageUrls(r: RenderedRequest): string[] {
  const out: string[] = [];
  for (const item of r.input) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) if (part.type === 'input_image') out.push(part.image_url);
  }
  return out;
}

/** 请求体的文本视图（正文那一行有没有进去，用它断言） */
function allText(r: RenderedRequest): string {
  return JSON.stringify(r.input);
}

// ──────────────────────────── 运行期那一拍（预热 + 留痕） ────────────────────────────

interface LoopRig {
  dir: string;
  loop: () => RealLoop;
  write: (type: string, data: unknown) => AppEvent;
  /** 留痕（`out` 回调收到的那一行行） */
  trace: () => string;
  /** 那张图有没有落到 `blobs/images/<sha256(url)>` */
  landed: (url: string) => boolean;
}

/** 与 `attachment-prewarm.test.ts` 同形的隔离实例：自己的 dataDir、自己的事件日志 */
async function makeLoopRig(t: test.TestContext): Promise<LoopRig> {
  const dir = tempDirSync('irmia-admit-loop-');
  const log = await EventLog.open(join(dir, 'events'));
  const projection = fold([]);
  const now = (): Date => new Date('2026-10-07T03:20:00.000Z');
  const lines: string[] = [];
  const loop = new RealLoop({
    log,
    dataDir: dir,
    projection,
    now,
    timezone: 'Asia/Shanghai',
    ds: { modelFor: () => 'fake-model' } as unknown as DsClient,
    registry: new ToolRegistry(),
    persona: {
      identity: 'IDENTITY', constitution: 'CONSTITUTION', style: 'STYLE', state: 'STATE',
      relationship: null, personaHash: 'test-hash', isSeed: false,
    } as unknown as PersonaAssets,
    config: defaultConfig(dir),
    out: (line: string) => { lines.push(line); },
    pollMs: 3_600_000,
  });
  t.after(() => {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    loop: () => loop,
    write: (type, data) => {
      const event = {
        seq: log.nextSeq(),
        ts: now().toISOString(),
        type,
        data,
        visibility: defaultVisibility(type as AppEvent['type']),
        origin: 'test/context-image',
      } as unknown as AppEvent;
      log.append(event, { sync: true });
      applyOne(projection, event);
      return event;
    },
    trace: () => lines.join('\n'),
    landed: (url) => existsSync(attachmentPath(dir, url)),
  };
}

test('回归（今晚的病）：一条含"进不了"图片的消息，不许让整拍失败——非法载荷一个都不许进请求体', async (t) => {
  const dataDir = tempDirSync('irmia-admit-');
  const host = await startHost(PNG_BYTES);
  t.after(async () => { await host.close(); rmSync(dataDir, { recursive: true, force: true }); });

  const goodUrl = `${host.origin}/good.png`;
  await ensureAttachment(dataDir, goodUrl);

  // 运行期那个 loader 的**同一段逻辑**（real-loop 注入的就是它）
  const readByKey = (ref: RenderImageRef): { mediaType: string; dataUrl: string } | null => {
    const read = readAttachmentImage(dataDir, ref, 1_500_000);
    return read.ok ? read.image : null;
  };

  const event = oneBotEvent(1, [
    // 不可进：协议端只给了本机路径（模型侧取不到）
    { type: 'image', name: 'local.png', url: 'file:///D:/qq/tmp/local.png' },
    // 可进：真直链 + 真字节
    { type: 'image', name: 'good.png', url: goodUrl },
    // 不可进：明确声明了一个我们没有转换器的型别
    { type: 'image/bmp', name: 'old.bmp', url: 'https://example.test/old.bmp' },
  ]);

  // 这一拍**不许抛**——渲染层从前会把 `data:image;base64,…` 拼出来交给模型，模型 400，
  // 于是每一拍都失败、输入进死信。现在非法的那两张连挑都不挑。
  const request = renderOnce([event], { loadImage: readByKey });
  const urls = imageUrls(request);

  assert.equal(urls.length, 1, `只有那一张合格的图该进上下文，实际进了 ${urls.length} 张`);
  assert.ok(urls[0]?.startsWith('data:image/png;base64,'), `前缀必须是模型认的形态：${urls[0]?.slice(0, 32)}`);
  for (const url of urls) {
    assert.ok(/^data:image\/(png|jpeg|gif|webp);base64,/u.test(url),
      `请求体里不许出现非白名单的图片型别：${url.slice(0, 48)}…`);
  }
  assert.equal(allText(request).includes('data:image;base64,'), false, '**`data:image;base64,` 一个字符都不许再有**');
});

test('回归：不可进的图**不影响**同一条消息的其他内容进上下文（正文、别的附件、别的消息）', async (t) => {
  const dataDir = tempDirSync('irmia-admit-');
  const host = await startHost(JPEG_BYTES);
  t.after(async () => { await host.close(); rmSync(dataDir, { recursive: true, force: true }); });

  const goodUrl = `${host.origin}/good.jpg`;
  await ensureAttachment(dataDir, goodUrl);
  const readByKey = (ref: RenderImageRef): { mediaType: string; dataUrl: string } | null => {
    const read = readAttachmentImage(dataDir, ref, 1_500_000);
    return read.ok ? read.image : null;
  };

  const withBad = oneBotEvent(1, [
    { type: 'image', name: 'nope.webp', url: 'base64://iVBORw0KGgo=' },
    { type: 'file', name: 'report.pdf', url: `${host.origin}/r.pdf` },
    { type: 'image', name: 'good.jpg', url: goodUrl },
  ]);
  const plain = oneBotEvent(2, [{ type: 'image', name: 'x.png', url: 'file:///D:/qq/x.png' }]);

  const request = renderOnce([withBad, plain], { loadImage: readByKey });
  const text = allText(request);
  assert.match(text, /看看这两张，第二张是重点/u, '正文照常进上下文');
  assert.match(text, /\[image: nope\.webp\]/u, '进不了的那张，附件事实（文件名）照旧在——不静默丢弃');
  assert.match(text, /base64:\/\/iVBORw0KGgo=/u, '地址照旧摆出来（她要用就 vision_read / http_download）');
  assert.match(text, /\[file: report\.pdf\]/u, '非图附件照旧');
  assert.equal(imageUrls(request).length, 1, '两张不可进的图不该占掉名额，也不该把合格那张挤掉');
});

test('回归：全是不可进的图 ⇒ 那条消息退回纯文字形态（不是空壳、不是抛错）', async (t) => {
  const dataDir = tempDirSync('irmia-admit-');
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const readByKey = (ref: RenderImageRef): { mediaType: string; dataUrl: string } | null => {
    const read = readAttachmentImage(dataDir, ref, 1_500_000);
    return read.ok ? read.image : null;
  };

  const event = oneBotEvent(1, [
    { type: 'image', name: 'a.png', url: 'file:///D:/qq/a.png' },
    { type: 'image', name: 'b.png', url: 'base64://AAAA' },
  ]);
  const request = renderOnce([event], { loadImage: readByKey });
  assert.deepEqual(imageUrls(request), [], '一张都不该进');
  const item = request.input.find((i) => i.type === 'message' && typeof i.content === 'string'
    && i.content.includes('看看这两张'));
  assert.ok(item !== undefined, '正文必须还在（退回纯文字，而不是整条消息消失）');
});

// ──────────────────────────── ⑤ 她自己的那条路（vision_read 的 inline） ────────────────────────────

/**
 * `vision_read(inline:true)` 走的是 `image/attached` 事件 + 工作目录内的文件（**不经过附件仓库**）。
 * 它会不会也塞同样的非法载荷？答案是"同一条收口"：
 *   · `mime` 来自文件**扩展名**（vision.ts 的 `imageMimeOf`，白名单里含 bmp）；
 *   · 进请求体的型别仍由 `buildContextImage` 按**字节头**定——扩展名与字节对不上时以字节为准；
 *   · 字节头认不出（bmp、或坏文件）⇒ 这条图**不进上下文**，那行 `[图片] 名字` 照旧在文本里。
 */
test('vision_read 那条路：ext/image 一路同源——png 进、bmp 不进（同一条收口，不是第二套判据）', async (t) => {
  const dataDir = tempDirSync('irmia-admit-file-');
  const workspace = join(dataDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'pic.png'), PNG_BYTES);
  writeFileSync(join(workspace, 'old.bmp'), BMP_BYTES);
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  // real-loop 注入的那段逻辑（`source === 'file'` 那一支）
  const readByKey = (ref: RenderImageRef): { mediaType: string; dataUrl: string } | null => {
    const read = readFileImage(join(workspace, ref.key), ref.mime, 1_500_000);
    return read.ok ? read.image : null;
  };
  const attached = (key: string, mime: string, seq: number): AppEvent => ({
    seq,
    ts: '2026-10-07T03:19:30.000Z',
    type: 'image/attached',
    data: { key, mime, name: key },
    visibility: defaultVisibility('image/attached'),
    origin: 'test/context-image',
  } as unknown as AppEvent);

  const png = renderOnce([attached('pic.png', 'image/png', 1)], { loadImage: readByKey });
  assert.deepEqual(
    imageUrls(png).map((u) => u.slice(0, 22)),
    ['data:image/png;base64,'],
    '她要求看的那张 png 照旧进上下文',
  );

  // 扩展名与字节对不上（声明 png、字节其实是 bmp）：**前缀仍是一个完整媒体型别**——
  // `data:image;base64,` 那种"没有子型别"的形状在这一条路上不可能出现（拼装只此一处）。
  // 注意这里**没有**做"字节与声明必须同族"的强校验：那要一个完整的图片解码器，
  // 我们只有四个 magic number（见 buildContextImage 的注释，这条边界不装作更强）。
  const mismatched = renderOnce([attached('pic.png', 'image/png', 2)], {
    loadImage: (ref: RenderImageRef) => {
      const read = readFileImage(join(workspace, 'old.bmp'), ref.mime, 1_500_000);
      return read.ok ? read.image : null;
    },
  });
  for (const url of imageUrls(mismatched)) {
    assert.match(url, /^data:image\/(png|jpeg|gif|webp);base64,/u, '前缀必须是完整且白名单内的媒体型别');
  }

  const bmp = renderOnce([attached('old.bmp', 'image/bmp', 3)], { loadImage: readByKey });
  assert.deepEqual(imageUrls(bmp), [], 'bmp 在 vision.ts 的扩展名表里，但不在模型认的白名单里');
  assert.match(allText(bmp), /\[图片\] old\.bmp/u, '不进上下文也要留下那行事实（她改用转述那条路）');
});


/**
 * 预热的判据与渲染层同源（都为的是"这一张值不值得走多模态那条路"）：
 * 形态上就不可能进的图**连下都不下**——否则每拍白花一次网络与超时，还留下一行看不出所以然的失败。
 * 同时"没进"这件事必须在留痕里说得出**是哪一条判据挡的**。
 */
test('预热：形态上不可进的图不下载，并在留痕里写明是哪一条判据挡的', async (t) => {
  const rig = await makeLoopRig(t);
  const host = await startHost(PNG_BYTES);
  t.after(() => host.close());

  rig.write('wake/channel', {
    channel: 'onebot',
    chatType: 'c2c',
    person: '10001',
    chatId: '10001',
    text: '这张是本机的，那张是真直链',
    messageId: 'm-prewarm',
    msgSeq: 0,
    dedupeKey: 'onebot:m-prewarm',
    attachments: [
      { type: 'image', name: 'local.png', url: 'file:///D:/qq/tmp/local.png' },
      { type: 'image', name: 'ok.png', url: `${host.origin}/ok.png` },
    ],
  });
  await rig.loop().tickOnce();

  const trace = rig.trace();
  assert.match(trace, /\[图片\] 这张不进上下文（[^）]*file:\/\//u, `留痕要说清是地址形态那条判据挡的：\n${trace}`);
  assert.equal(
    trace.includes('file:///D:/qq/tmp/local.png'),
    true,
    '留痕里要指得出是哪一个地址（不静默丢）',
  );
  // 合格那张照旧落盘（预热的本来职责）
  assert.ok(rig.landed(`${host.origin}/ok.png`), '合格的图照旧预热落盘');
  assert.equal(rig.landed('file:///D:/qq/tmp/local.png'), false, '不可能进的那张不该留下半个文件');
});

