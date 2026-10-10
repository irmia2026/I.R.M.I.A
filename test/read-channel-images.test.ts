/**
 * `read_channel` 的图片策略（2026-10-11 用户拍板的那三条）——src/tools/admin.ts 的 read_channel、
 * src/runtime/real-loop.ts 的读取口
 *
 * 用户拍板的三条（我提的方案，他回"这条决策不错。采纳。"）：
 *   ① **默认纯文字 + 给足引用**：读会话时图片不装配进上下文，但那一行必须带上**可用的引用**
 *      （这里是图片地址），让她能自己 `vision_read` 去看；顺手说清那是临时直链、怎么取；
 *   ② **例外**：那条消息**点名她的**（@她 / 回复她 / 私聊）⇒ 按现有准入把图带进上下文
 *      （`contextImageAdmission` · `vision.imagesToContext` · `maxContextImages`），进不去如实写原因；
 *   ③ **硬上限**：一次读最多带 N 张（N = `READ_CHANNEL_CONTEXT_IMAGE_MAX`，见 real-loop 的注释），
 *      超了如实说"还有 k 张没带"。
 *
 * 走**真链路**（真 EventLog → 真 RealLoop 的读取口 → 真 read_channel → 真 render 请求体）：
 * "图到底进没进上下文"这件事只有从**请求体**那一侧才看得准——工具结果是文本，
 * 而注入靠的是 `image/attached` 事件（渲染层 `imagesOf` → `input_image`）。
 *
 * 三条刻意的构造：
 *   · 被读的消息落成 `channel/message`（信箱那条，**internal ⇒ 渲染层根本不看它**），
 *     于是"请求体里出现了图"只可能是 read_channel 这一次装配带进来的——判据不与他人共享
 *     （②的第二个用例补上 `wake/channel` 那种生产形态）；
 *   · 工具的 `emit` 与 `main.ts` 那个**逐字同形**（可见性省略时按 internal 落库），
 *     所以"工具层忘了显式给 model"这类错在这里会当场红——那正是 ② 那条路唯一会静默失效的地方；
 *   · 字节由 `ensureAttachment`（**预热用的同一个函数**）备好：这一份测的是"读会话时装配没装配"，
 *     预热那条路由 test/attachment-prewarm.test.ts 钉着，不在这里重测。
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  CONTEXT_IMAGE_HARD_BYTES,
  attachmentPath,
  ensureAttachment,
  readAttachmentImage,
  readFileImage,
} from '../src/channel/attachment-store.ts';
import { defaultConfig, type AppConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { contextImageSkipText, defaultVisibility, type AppEvent, type Visibility } from '../src/log/types.ts';
import { render, type RenderImageRef, type RenderedRequest } from '../src/model/render.ts';
import { RealLoop } from '../src/runtime/real-loop.ts';
import { applyOne, fold } from '../src/state/fold.ts';
import { createAdminTools, type ChannelMessageView } from '../src/tools/admin.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';

const TZ = 'Asia/Shanghai';
/** 私聊的会话：`imageAimedAtHer` 对 c2c **无条件**算"冲她来的"（与唤醒判据同源） */
const C2C = 'qq:c2c:U1';
/** 群聊的会话：只有 @ / 提及才算 */
const GROUP = 'qq:group:G1';

/** 合法 PNG 的文件头（8 字节签名 + IHDR 长度/类型，够让字节头判据认出来） */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR', 'latin1'),
  Buffer.alloc(9, 0),
]);
/** 一张"看起来像图、型别却不在模型白名单里"的字节（BMP）——准入失败那条路用它 */
const BMP_BYTES = Buffer.concat([Buffer.from('BM', 'latin1'), Buffer.alloc(16, 0)]);

const PERSONA: PersonaAssets = {
  identity: 'IDENTITY',
  constitution: 'CONSTITUTION',
  style: 'STYLE',
  state: 'STATE',
  relationship: null,
  personaHash: 'test-hash',
  isSeed: false,
} as unknown as PersonaAssets;

/** 模型替身：这一份测的是读取口、工具与渲染，一次模型调用都不该发生 */
function fakeDs(): DsClient {
  return {
    modelFor: (): string => 'fake',
    generate: async (): Promise<never> => { throw new Error('这一份用例不该调模型'); },
    stream: async (): Promise<never> => { throw new Error('这一份用例不该调模型'); },
  } as unknown as DsClient;
}

// ──────────────────────────── 一台真直链服务器（字节真取得到） ────────────────────────────

interface Host { origin: string; close: () => Promise<void> }

/** 任何路径都回同一份字节：于是"型别"这条判据由**字节头**说了算（与生产同一条路） */
async function startHost(bytes: Buffer): Promise<Host> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(bytes);
  });
  await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => { await new Promise<void>((done) => { server.close(() => done()); }); },
  };
}

// ──────────────────────────── 真链路测试台 ────────────────────────────

interface WriteArgs {
  sid: string;
  messageId: string;
  /** 正文：两份用例里它自带编号（`第 N 句`），断言那一行时靠它认 */
  text: string;
  imageUrl: string;
  /** 附件声明（默认 png；测"字节头说了算"时故意写错） */
  type?: string;
  /** 落成 `wake/channel`（生产里"点名她"的消息就是这种形态）而不是信箱那条 */
  wake?: boolean;
}

interface Rig {
  dir: string;
  config: AppConfig;
  /** 落一条通道消息；返回它的事件（seq 已分配、已折进投影） */
  write: (args: WriteArgs) => AppEvent;
  /** 真 read_channel 的那一屏文本 */
  read: (args: Record<string, unknown>) => Promise<string>;
  /** 读取口（`channelReader` 背后那个）——测"事实的形状"时直取 */
  view: (sid: string, limit: number) => Promise<readonly ChannelMessageView[]>;
  /** 工具层写下去的事件（`channel/read` 与 `image/attached` 都在里面） */
  emitted: AppEvent[];
  /** 与运行期同一条渲染路径造出来的请求体 */
  request: () => RenderedRequest;
}

async function makeRig(t: TestContext, patch: (config: AppConfig) => void = () => {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-read-images-'));
  const log = await EventLog.open(join(dir, 'events'));
  const projection = fold([]);
  const now = (): Date => new Date('2026-10-11T06:00:00.000Z');
  const config = defaultConfig(dir);
  patch(config);
  t.after(() => {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const real = new RealLoop({
    log,
    dataDir: dir,
    projection,
    now,
    timezone: TZ,
    ds: fakeDs(),
    registry: new ToolRegistry(),
    persona: PERSONA,
    config,
    out: () => {},
    pollMs: 3_600_000,
  });

  /** 落库的每一条（渲染那一侧要按 seq 正序看到同一份事件流；EventLog 没有同步的 all()） */
  const events: AppEvent[] = [];
  const emitted: AppEvent[] = [];
  const append = (event: AppEvent): AppEvent => {
    log.append(event, { sync: true });
    applyOne(projection, event);
    events.push(event);
    return event;
  };

  const tk = createAdminTools({
    timers: new TimerStore(null),
    // 与 main.ts 的那个 emit **逐字同形**：可见性省略时按 `internal` 落库（它的默认参数就是 internal）
    // ——注意**不是** `defaultVisibility(type)`。这一点是刻意的：工具层写 `image/attached` 时必须
    // 显式给 model，少了这一步事件就是 internal，渲染层不看它 ⇒ 那一行写着"已带进上下文"而请求体里
    // 空着。用例要能抓住这种静默失效，就不能在这里替它兜底。
    emit: (type: string, data: unknown, visibility?: Visibility) => {
      const event = append({
        seq: log.nextSeq(),
        ts: now().toISOString(),
        type,
        data,
        visibility: visibility ?? 'internal',
        origin: 'test/read-channel-images',
      } as unknown as AppEvent);
      emitted.push(event);
    },
    channelReader: async (sid, limit, before) => await real.readChannelMessages(sid, limit, before),
    channelSpokenReader: async (sid) => await real.readChannelSpoken(sid),
    timezone: TZ,
  });
  const ctx = {
    callId: 'call_read', turn: 4, step: 1,
    signal: new AbortController().signal, workspaceRoot: dir,
  };

  return {
    dir,
    config,
    emitted,
    write: ({ sid, messageId, text, imageUrl, type = 'image/png', wake = false }) => {
      const [, kind, chatId = ''] = sid.split(':');
      return append({
        seq: log.nextSeq(),
        ts: now().toISOString(),
        // 生产里两种形态：`wake/channel` = 叫醒她的那条（model 可见）；`channel/message` = 只记账
        // （internal，渲染层不看它）。判据（谁在点名她）与形态无关，两条路都要能读回来。
        type: wake ? 'wake/channel' : 'channel/message',
        data: {
          channel: 'qq-official',
          // `c2c` = 私聊（点名她）；`group-at` = 平台 @ 了她（同样点名她）；`group` = 没人点她
          chatType: kind === 'c2c' ? 'c2c' : wake ? 'group-at' : 'group',
          person: 'OPENID_A',
          chatId,
          text,
          messageId,
          msgSeq: 1,
          ...(wake ? { mentionsMe: true } : {}),
          attachments: [{ type, url: imageUrl, name: `${messageId}.png` }],
        },
        visibility: defaultVisibility(wake ? 'wake/channel' : 'channel/message'),
        origin: 'test/read-channel-images',
      } as unknown as AppEvent);
    },
    read: async (args) => {
      const result = await tk.byName('read_channel').handler(args, ctx);
      assert.equal(result.isError, undefined, `read_channel 不该报错：${result.content}`);
      return result.content;
    },
    view: async (sid, limit) => await real.readChannelMessages(sid, limit),
    /**
     * 与运行期同一条渲染路径（`render`）+ **real-loop 注入的那个 loader 的逐字逻辑**
     * （`real-loop.ts` 的 `agentDeps`：`source === 'file'` 走 `readFileImage`、否则
     * `readAttachmentImage`，上限都是 `CONTEXT_IMAGE_HARD_BYTES`）。
     * 换了函数就等于换了一条判据，那正是这些用例要防的事。
     */
    request: () => render({
      events,
      persona: { identity: 'i', constitution: 'c', style: 's', state: '' },
      tools: [],
      wakeEvent: null,
      taskCard: null,
      now: now().toISOString(),
      timezone: TZ,
      model: 'deepseek-v4-pro',
      lane: 'heavy',
      contact: null,
      mentionNotice: null,
      machine: null,
      usage: null,
      asks: null,
      injection: null,
      loadImage: (ref: RenderImageRef) => {
        const read = ref.source === 'file'
          ? readFileImage(
            isAbsolute(ref.key) ? ref.key : resolve(process.cwd(), ref.key),
            ref.mime,
            CONTEXT_IMAGE_HARD_BYTES,
          )
          : readAttachmentImage(dir, ref, CONTEXT_IMAGE_HARD_BYTES);
        return read.ok ? read.image : null;
      },
      maxContextImages: config.vision.maxContextImages,
      softHint: null,
      memoryIndex: null,
      skillCatalog: null,
      turnBlock: null,
      stateBytes: null,
      stateBudgetBytes: null,
    }),
  };
}

/** 请求体里所有 `input_image` 的 data URL（顺序即进上下文的那一张张） */
function imageUrls(r: RenderedRequest): string[] {
  const out: string[] = [];
  for (const item of r.input) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) if (part.type === 'input_image') out.push(part.image_url);
  }
  return out;
}

/** 那一屏里属于某条消息的那一行（正文自带编号，`第 N 句`） */
function lineOf(content: string, no: number): string {
  const line = content.split('\n').find((row) => row.includes(`第 ${no} 句`));
  assert.ok(line !== undefined, `这一屏里没有第 ${no} 句那一行：\n${content}`);
  return line;
}

/** 工具层写下去的 `image/attached` 事件 */
function attachedEvents(rig: Rig): AppEvent[] {
  return rig.emitted.filter((e) => e.type === 'image/attached');
}

/**
 * 把字节落到 `<dataDir>/blobs/images/<sha256(url)>`——**预热那条路用的同一个函数**
 * （`prewarmRecentAttachments` 就是调它；那条路本身由 test/attachment-prewarm.test.ts 钉着）。
 */
async function prewarmBytes(dir: string, url: string): Promise<void> {
  const outcome = await ensureAttachment(dir, url);
  assert.ok(outcome.outcome === 'fetched' || outcome.outcome === 'cached', `字节没落盘：${outcome.outcome}`);
}

/** 那张合格图的 data URL（请求体里该出现的就是它） */
function pngDataUrl(): string {
  return `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
}

// ──────────────────────────────── ① 默认：纯文字 + 给足引用 ────────────────────────────────

test('① 默认（没点名她）：那一行给的是**可用的地址**，一个图片事件都不写、请求体里没有图片块', async (t) => {
  const host = await startHost(PNG_BYTES);
  const rig = await makeRig(t);
  t.after(async () => { await host.close(); });

  const url = `${host.origin}/a.png`;
  await prewarmBytes(rig.dir, url);
  rig.write({ sid: GROUP, messageId: 'm1', text: '看这个 第 1 句', imageUrl: url });

  const content = await rig.read({ sid: GROUP, limit: 20 });

  // ①-a 那一行的逐字形状：图 + **地址**（她据此 http_download → vision_read）
  assert.match(lineOf(content, 1), /［图 http:\/\/127\.0\.0\.1:\d+\/a\.png］/u,
    `那一行必须带上可用引用（只有一个 ［图］ 的话她没法自己去看）：\n${content}`);
  // ①-b 整批说一次"那是临时直链、怎么取"——每行都缀一句太贵
  assert.match(content, /框里的图只给了地址：那是临时直链/u, `没说清地址会过期：\n${content}`);
  assert.match(content, /http_download/u, '要给出一条她自己能走的路');

  // ①-c 机制那一侧：一个 `image/attached` 都没写
  assert.deepEqual(attachedEvents(rig).map((e) => e.data), [], '没点名她的那些，一张都不许装配');
  // ①-d 结果那一侧：请求体里没有图片块
  assert.deepEqual(imageUrls(rig.request()), [], '默认那条路：请求体里不许出现图片');
  // ①-e 但**这张图本来是合格的**——没进上下文不是因为它不合格，而是因为这一条没点名她
  const read = readAttachmentImage(rig.dir, { source: 'remote', key: url, mime: 'image/png' }, CONTEXT_IMAGE_HARD_BYTES);
  assert.equal(read.ok, true, '字节在本地、型别也在白名单里——差别只在"点没点她"');
});

// ──────────────────────────────── ② 例外：点名她的 ⇒ 图真进请求体 ────────────────────────────────

test('② 点名她（私聊）：图片真的进请求体（input 里有 image part），那一行也如实说进去了', async (t) => {
  const host = await startHost(PNG_BYTES);
  const rig = await makeRig(t);
  t.after(async () => { await host.close(); });

  const url = `${host.origin}/c2c.png`;
  await prewarmBytes(rig.dir, url);
  // 私聊那条落成 `channel/message`（internal）：渲染层**不直接看它**，
  // 于是"请求体里有图"只可能是 read_channel 这一次装配带来的（判据干净）。
  rig.write({ sid: C2C, messageId: 'm-c2c', text: '看这张 第 3 句', imageUrl: url });

  const content = await rig.read({ sid: C2C, limit: 20 });
  assert.match(lineOf(content, 3), /（已带进上下文）/u, `私聊 = 点名她，图该带进去：\n${content}`);

  const attached = attachedEvents(rig);
  assert.equal(attached.length, 1, `私聊里那张图该写一条 image/attached：\n${content}`);
  assert.equal(attached[0]?.visibility, 'model', '可见性必须是 model，否则渲染层不看它');
  const data = attached[0]?.data as { key?: string; mime?: string };
  assert.equal(data.key, attachmentPath(rig.dir, url), 'key 指向本地那一份（与预热落盘同址）');
  assert.equal(data.mime, 'image/png', '型别取字节头认出来的那个');

  // **结果那一侧**：请求体里真有那个 image part，载荷是模型认的形态
  assert.deepEqual(imageUrls(rig.request()), [pngDataUrl()],
    '图片必须以 data URL 形态出现在请求体的 input_image 里');
});

test('② 点名她（群 @，走 `wake/channel` 那种生产形态）：同样带进去，张数仍受 maxContextImages 约束', async (t) => {
  const host = await startHost(PNG_BYTES);
  const rig = await makeRig(t);
  t.after(async () => { await host.close(); });

  const url = `${host.origin}/wake.png`;
  await prewarmBytes(rig.dir, url);
  rig.write({ sid: GROUP, messageId: 'm-wake', text: '@你 第 4 句', imageUrl: url, wake: true });

  const content = await rig.read({ sid: GROUP, limit: 20 });
  assert.match(lineOf(content, 4), /（已带进上下文）/u, `点名她的那条该带进去：\n${content}`);
  assert.equal(attachedEvents(rig).length, 1, '这一屏里就这一张，写一条');

  // 这一条消息本身是 `wake/channel`（model 可见），所以**唤醒那条路自己也会带它**：
  // 同一张图可能因此出现两遍（注入器按"最近 N 张事件"选，不按内容去重）。
  // 这里只钉住"图在请求体里"与"张数不越过 maxContextImages"两条硬性质，
  // 未去重这件事记在 real-loop 的 `prepareAimedContextImages` 注释与提交说明里。
  const urls = imageUrls(rig.request());
  assert.ok(urls.length >= 1, '图必须真的在请求体里');
  assert.ok(urls.length <= rig.config.vision.maxContextImages,
    `张数不许超过 maxContextImages（${rig.config.vision.maxContextImages}）：实际 ${urls.length}`);
  assert.deepEqual([...new Set(urls)], [pngDataUrl()], '带进去的就是那一张（形态与内容都对）');
});

// ──────────────────────────────── ③ 准入失败：如实写原因 ────────────────────────────────

test('③ 准入失败（型别不在白名单 / 地址不是 http）：那一行照实写理由、地址照旧在，且不写图片事件', async (t) => {
  const host = await startHost(BMP_BYTES);
  const rig = await makeRig(t);
  t.after(async () => { await host.close(); });

  const bmpUrl = `${host.origin}/old.bmp`;
  await prewarmBytes(rig.dir, bmpUrl);
  // 现场那种形态（OneBot）：声明是**裸标签** `image`（"这是张图，格式看字节"），
  // 而字节是 BMP ⇒ 白名单里认不出它，如实不进。声明是 `image/png` 的话反而会按声明放行
  // （`buildContextImage` 的口径：字节头优先、认不出才退回声明）——那不是这一条要测的东西。
  rig.write({ sid: C2C, messageId: 'm-bmp', text: '这张是 bmp 第 5 句', imageUrl: bmpUrl, type: 'image' });
  rig.write({ sid: C2C, messageId: 'm-local', text: '这张在本机 第 6 句', imageUrl: 'file:///D:/qq/x.png' });

  const content = await rig.read({ sid: C2C, limit: 20 });

  // 理由文案取自**留痕那一份**（`contextImageSkipText`）：两处不会各说各的
  const unknown = contextImageSkipText('unknown-media-type');
  assert.ok(lineOf(content, 5).includes(`（没带进上下文：${unknown}）`),
    `准入失败要如实写原因（与留痕同一份文案）：\n${content}`);
  assert.ok(lineOf(content, 5).includes(bmpUrl), '进不去也要把地址留在那一行上——不静默丢');
  const notHttp = contextImageSkipText('not-http-url');
  assert.ok(lineOf(content, 6).includes(`（没带进上下文：${notHttp}）`), `\n${content}`);
  assert.ok(lineOf(content, 6).includes('file:///D:/qq/x.png'), '地址照旧在');

  assert.deepEqual(attachedEvents(rig), [], '进不去的图一条事件都不许写');
  assert.deepEqual(imageUrls(rig.request()), [], '进不去的图不许出现在请求体里');
});

// ──────────────────────────────── ④ 上限：一次读最多 N 张 ────────────────────────────────

test('④ 一次读里三张图：只带 N 张（=2），超的那张如实说"没带"，请求体里正好 N 张', async (t) => {
  const host = await startHost(PNG_BYTES);
  const rig = await makeRig(t);
  t.after(async () => { await host.close(); });

  const urls = [1, 2, 3].map((n) => `${host.origin}/p${n}.png`);
  for (const [index, url] of urls.entries()) {
    await prewarmBytes(rig.dir, url);
    rig.write({ sid: C2C, messageId: `m-p${index}`, text: `第 ${10 + index} 句`, imageUrl: url });
  }

  const content = await rig.read({ sid: C2C, limit: 20 });

  assert.equal(attachedEvents(rig).length, 2, '一次读最多带 2 张（READ_CHANNEL_CONTEXT_IMAGE_MAX）');
  assert.match(lineOf(content, 10), /（已带进上下文）/u, `前两张该带（名额按时间正序发）：\n${content}`);
  assert.match(lineOf(content, 11), /（已带进上下文）/u, `\n${content}`);
  assert.match(lineOf(content, 12), /（没带进上下文：这一次读的图片名额用完了）/u,
    `超上限那张要如实说：\n${content}`);
  assert.ok(lineOf(content, 12).includes(urls[2]!), '没带的那张，地址照旧在（她还是能自己看）');
  // 整批报数：用户要的「超了如实说"还有 k 张没带"」
  assert.match(content, /其中 1 张图这次没带进上下文/u, `\n${content}`);
  assert.equal(imageUrls(rig.request()).length, 2, '请求体里正好 N 张');
});

test('④ 名额跟 `vision.maxContextImages` 走（同一套准入）：配成 1 就只带 1 张', async (t) => {
  const host = await startHost(PNG_BYTES);
  const rig = await makeRig(t, (config) => { config.vision.maxContextImages = 1; });
  t.after(async () => { await host.close(); });

  for (const n of [1, 2]) {
    const url = `${host.origin}/q${n}.png`;
    await prewarmBytes(rig.dir, url);
    rig.write({ sid: C2C, messageId: `m-q${n}`, text: `第 ${20 + n} 句`, imageUrl: url });
  }

  const content = await rig.read({ sid: C2C, limit: 20 });
  assert.equal(attachedEvents(rig).length, 1, 'maxContextImages=1 ⇒ 这一次读只带 1 张');
  assert.match(lineOf(content, 21), /（已带进上下文）/u);
  assert.match(lineOf(content, 22), /（没带进上下文：这一次读的图片名额用完了）/u);
  assert.match(content, /其中 1 张图这次没带进上下文/u, `\n${content}`);
});

test('④ 图片直通关着（imagesToContext=false）：与默认那条路逐字相同，只给地址', async (t) => {
  const host = await startHost(PNG_BYTES);
  const rig = await makeRig(t, (config) => { config.vision.imagesToContext = false; });
  t.after(async () => { await host.close(); });

  const url = `${host.origin}/off.png`;
  await prewarmBytes(rig.dir, url);
  rig.write({ sid: C2C, messageId: 'm-off', text: '第 30 句', imageUrl: url });

  const content = await rig.read({ sid: C2C, limit: 20 });
  assert.match(lineOf(content, 30), /［图 http:\/\/127\.0\.0\.1:\d+\/off\.png］/u,
    `直通关着就只给地址——不许说"已带进上下文"：\n${content}`);
  assert.doesNotMatch(lineOf(content, 30), /已带进上下文/u);
  assert.deepEqual(attachedEvents(rig), [], '一个事件都不许写');
  assert.deepEqual(imageUrls(rig.request()), [], '请求体里不该有图');
});

// ──────────────────────────── ⑤ 事实的形状（宿主那一侧的口径） ────────────────────────────

test('⑤ 读取口给的事实只长在点名她的那些消息上（私聊也算），且与图片逐个对齐', async (t) => {
  const host = await startHost(PNG_BYTES);
  const rig = await makeRig(t);
  t.after(async () => { await host.close(); });

  const url = `${host.origin}/shape.png`;
  await prewarmBytes(rig.dir, url);
  rig.write({ sid: C2C, messageId: 'm-shape', text: '一张 第 40 句', imageUrl: url });
  rig.write({ sid: GROUP, messageId: 'm-at', text: '@她 第 41 句', imageUrl: url, wake: true });
  rig.write({ sid: GROUP, messageId: 'm-noise', text: '群里没人叫她 第 42 句', imageUrl: url });

  const aimed = await rig.view(C2C, 20);
  assert.deepEqual(aimed[0]?.contextImages?.map((f) => f.state), ['ready'], '私聊那条：一张、可装配');
  assert.equal(
    aimed[0]?.contextImages?.[0]?.state === 'ready' ? aimed[0].contextImages[0].key : null,
    attachmentPath(rig.dir, url),
    'key 与预热落盘同址',
  );
  // 私聊**不是** `mentionedInMessage`（私聊里没有"提及"这回事，那个字段管的是群里的 `▶`），
  // 但它是点名她的——这正是 `imageAimedAtHer` 多出来的那一条（与唤醒判据同源）
  assert.equal(aimed[0]?.mentionsMe, undefined, '私聊不带"提及"标记：`▶` 那条口径一个字没动');

  const group = await rig.view(GROUP, 20);
  const at = group.find((m) => m.messageId === 'm-at');
  assert.equal(at?.mentionsMe, true, '群里 @ 了她：`mentionsMe` 照旧（与事实互不影响）');
  assert.deepEqual(at?.contextImages?.map((f) => f.state), ['ready'], '@ 她的那条：同样产出事实');

  const quiet = group.find((m) => m.messageId === 'm-noise');
  assert.equal(quiet?.contextImages, undefined, '没点名她的那条：**一条事实都不产出**（默认那条路）');
});
