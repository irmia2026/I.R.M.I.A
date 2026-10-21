/**
 * send_media（2026-10-03，官 bot 富媒体）：她发媒体的出口。
 *
 * 只测工具层的行为——白名单与字节读取在宿主（main.ts），这里用假的投递口钉住"工具把什么
 * 交给了宿主"，以及四种应当**如实报错**的情形。
 *
 * ⚠ v64（出站类＝写类）：`send_media` 开始按 `trust.mode` 判一次（`full` 档不限制路径、
 * `workspace` 档只许工作目录内），并把本机文件**读成字节**交给投递口（投递口那一层只收
 * `data\`/仓库根之内）。所以这一份里有两个 ctx：
 *   · `CTX` = 不传 `boundaryRoot`（历史默认＝把 `workspaceRoot` 当边界）⇒ 用来测"拒"；
 *   · `OPEN_CTX` = `boundaryRoot: null`（完全信任，**现场默认就是它**）⇒ 用来测"发得出去"。
 *
 * ⚠ 2026-10-17：`kind:file` 的载荷补上 `path`（校验后的绝对路径）与 `name`——
 * 少了它们，OneBot 的文件永远报"要一个本机路径"、官方上传体里没有 `file_name`（QQ 显示
 * "未命名"）。
 *
 * ⚠ 2026-10-18（review P1-11）：**四种 kind 都带 `path`**，不再只有文件类。理由不是通道需要它
 * （图/视频/语音三条路的请求字节一个字都没变），而是**投递口的凭据门只认 `path`**
 * （`channel/media-poster.ts` 的 `refuseProtected`）：只有 `kind:file` 带它时，默认的
 * `kind:image` 把 `.keys.json` 的字节交给通道，那道门一次都没跑。`name` 仍然只给文件类
 * （它会进官方 `file_name` 与 OneBot 视频段），所以"名字"那一格与从前逐字节相同。
 *
 * ⚠ 2026-10-18（review P1-09/P1-12）：读字节之前先 `stat`（超 200MB 当场拒，一个字节都不读）；
 * 媒体投递口回的平台 `messageId` 要回填进 `speak/sent`（`read_channel` 的 `·m<id>` 靠它）。
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { defaultVisibility, type AppEvent } from '../src/log/types.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';
import { RealLoop } from '../src/runtime/real-loop.ts';
import { applyOne, fold } from '../src/state/fold.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolHandlerResult } from '../src/tools/types.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { createWorkspaceMediaPoster } from '../src/channel/media-poster.ts';
import { ONEBOT_CHANNEL_NAME, oneBotMediaCall } from '../src/channel/onebot.ts';
import { QqMessageSender, type ChannelAdapter } from '../src/channel/qq-official.ts';
import {
  MESSAGE_ID_MARK,
  createAdminTools,
  type MediaRequest,
} from '../src/tools/admin.ts';
// v76：回执样板搬进常驻提示词——"它必须出现在 SELF_BRIEF 里、只出现一次"是这条红检的一半
import { SELF_BRIEF } from '../src/model/self-brief.ts';
import { tempDir } from './helpers/temp-dirs.ts';

const CTX = {
  callId: 'call-media-1',
  turn: 7,
  step: 1,
  signal: new AbortController().signal,
  workspaceRoot: process.cwd(),
} as never;

/** 完全信任那一档（`boundaryRoot: null`）：出站类不受边界约束——现场默认就是它 */
const OPEN_CTX = {
  callId: 'call-media-2',
  turn: 7,
  step: 1,
  signal: new AbortController().signal,
  workspaceRoot: process.cwd(),
  boundaryRoot: null,
} as never;

function toolkit(
  poster: ((media: MediaRequest) => void) | null,
  options: {
    mediaMaxBytes?: number;
    messageId?: string;
    failReason?: string;
    implicitTarget?: string;
    /** 本轮叫她的那个会话（显式 `to` 指向它时回执写「本会话」） */
    currentWake?: { chatType: 'c2c' | 'group'; chatId: string };
  } = {},
) {
  const seen: MediaRequest[] = [];
  const tk = createAdminTools({
    timers: new TimerStore(null),
    emit: () => {},
    // 不给 `to` 的那一支：`send_media` 发往"本轮叫她的那个会话"（v76 的回执写「本会话」）
    ...(options.implicitTarget === undefined
      ? {}
      : { replyTargetOf: () => ({ url: options.implicitTarget!, idempotencyKey: 'turn-7' }) }),
    ...(options.currentWake === undefined
      ? {}
      : {
        currentWakeChannel: () => ({
          channel: 'qq-official',
          chatType: options.currentWake!.chatType,
          chatId: options.currentWake!.chatId,
          person: options.currentWake!.chatId,
          text: '', messageId: 'm-current', msgSeq: 1,
        }),
      }),
    ...(options.mediaMaxBytes === undefined ? {} : { mediaMaxBytes: options.mediaMaxBytes }),
    ...(poster === null ? {} : {
      mediaPoster: {
        async post(_target, media) {
          seen.push(media);
          poster(media);
          if (options.failReason !== undefined) {
            return { ok: false as const, status: 400, reason: options.failReason };
          }
          return {
            ok: true as const,
            status: 200,
            ...(options.messageId === undefined ? {} : { messageId: options.messageId }),
          };
        },
      },
    }),
  });
  return { tool: tk.byName('send_media'), seen };
}

test('send_media：本机文件由**工具层读成字节**交给宿主（v64：出站要按边界判一次）', async () => {
  const { tool, seen } = toolkit(() => {});
  // v64 起 `send_media` 属**出站类＝写类**：`full` 档（`boundaryRoot: null`）不限制路径，
  // 由工具层把字节读出来交给投递口（投递口那一层只收 data\ / 仓库根之内，政策判在工具层）。
  const file = join(await tempDir('irmia-media-'), 'a.png');
  await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const result = await tool.handler({ path: file, kind: 'image', to: 'qq:c2c:USER-1' }, OPEN_CTX);
  assert.equal(result.isError, undefined, result.content);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.fileType, 1, 'image → 1');
  // 2026-10-18（P1-11）：`path` **要**交给宿主——投递口的凭据门只认它（四种 kind 都带）
  assert.equal(seen[0]?.path, file, '校验过的绝对路径一起递下去（凭据门据此判）');
  assert.equal(seen[0]?.data?.byteLength, 4, '交给宿主的是那一份字节');
  assert.match(result.content, /已发往/u);
});

// ──────────────────────────── v76：回执压到极限（+ 红检） ────────────────────────────
//
// 病（审计 `_research/KV-AUDIT-2026-10-21.md` ③-2 第一条）：单条成功回执 **316–336 字符**、
// 逐字相同、只有 id 变，历史窗口里 121 条 ⇒ **39,802 字符 / 15,355 估算 token** 常驻。
// v74 的 C 只压了 `speak`/`report`，`send_media` 漏了。
//
// 修法：**样板搬进 `SELF_BRIEF` 一次**（"不必重复发送 / `read_channel` 的 `（我）` 行 /
// `·m<id>` 是平台消息 id、撤回用它"），回执只留"发了没有 + 发到哪儿 + id"。
// **红检在这里**（下面这条用例）——防 v74 记过的旧病复发：回执太短 ⇒ 她以为没发出去 ⇒ 重复发图。
// 所以判据不是"越短越好"，而是：**"已发出 N 条"这层意思必须还在**，失败那一路必须详细。

test('★ v76 红检：成功回执必须说"已发出 N 条"+`投递成功`；样板只在 SELF_BRIEF 里（防重复发图）', async () => {
  const fileName = join(await tempDir('irmia-media-v76-'), 'a.png');
  await writeFile(fileName, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  // ① 显式 to 指向**别的**会话：回执要能当场回答"发出去了没有、几条、发到哪儿、id 是什么"
  const named = toolkit(() => {}, { messageId: 'PLAT-1' });
  const explicit = await named.tool.handler({ path: fileName, kind: 'image', to: 'qq:c2c:USER-1' }, OPEN_CTX);
  assert.equal(explicit.isError, undefined, String(explicit.content));
  assert.match(String(explicit.content), /^已发出 1 条 · 投递成功 · 已发往 qq:c2c:USER-1 · id=·mPLAT-1$/u,
    `回执形状钉死（红检：少了"已发出 1 条"她就会以为没发出去）：\n${String(explicit.content)}`);
  // ② 回执里**不许**再出现样板（样板每重复一次就是每轮多付一次全价）
  assert.equal(String(explicit.content).includes('不必重复发送'), false, '样板已搬进 SELF_BRIEF，回执不再付');
  assert.equal(String(explicit.content).includes('read_channel'), false, '样板已搬进 SELF_BRIEF');
  // ③ 而样板**必须**在 SELF_BRIEF 里（只此一次；两处都写就又是两份口径）
  assert.ok(SELF_BRIEF.includes('不必重复发送'), '样板要在常驻提示词里（她读得到，且只付一次）');
  assert.ok(SELF_BRIEF.includes('（我）'), '`read_channel` 里怎么认出自己那一行，要在提示词里');
  assert.ok(SELF_BRIEF.includes('·m<id>'), '`·m<id>` 是什么，要在提示词里说清（回执只留那串 id）');
  assert.ok(SELF_BRIEF.includes('撤回'), '拿 id 干什么（撤回/核对），要在提示词里');

  // ④ 没给 to（= 本轮会话）⇒ 用"本会话"，不印一串 38 字符的 sid
  const implicit = toolkit(() => {}, { messageId: 'PLAT-2', implicitTarget: 'qq:c2c:USER-1' });
  const out = await implicit.tool.handler({ path: fileName, kind: 'image' }, OPEN_CTX);
  assert.equal(out.isError, undefined, String(out.content));
  assert.match(String(out.content), /^已发出 1 条 · 投递成功 · 本会话 · id=·mPLAT-2$/u,
    String(out.content));

  // ⑤ **显式给 to、但指的就是本轮会话** ⇒ 同样是「本会话」（不印 sid；她是回复不是主动消息）
  const atCurrent = toolkit(() => {}, {
    messageId: 'PLAT-3',
    currentWake: { chatType: 'c2c', chatId: 'USER-1' },
  });
  const same = await atCurrent.tool.handler({ path: fileName, kind: 'image', to: 'qq:c2c:USER-1' }, OPEN_CTX);
  assert.equal(same.isError, undefined, String(same.content));
  assert.match(String(same.content), /^已发出 1 条 · 投递成功 · 本会话 · id=·mPLAT-3$/u,
    `to 就是本轮会话 ⇒ 回执不许再印 sid：\n${String(same.content)}`);

  // ⑥ 失败那一路**保持详细**（原因 + 一条都没出去），不许压
  const failing = toolkit(() => {}, { failReason: '群已解散或机器人被移出' });
  const failed = await failing.tool.handler({ path: fileName, kind: 'image', to: 'qq:c2c:USER-1' }, OPEN_CTX);
  assert.equal(failed.isError, true);
  assert.match(String(failed.content), /已发出 0 条 · 发送失败：群已解散或机器人被移出/u,
    `失败要说清"一条都没出去"+ 原因：\n${String(failed.content)}`);
});

test('send_media：`workspace` 档下越界文件被拒（出站类＝写类），理由说清边界在哪', async () => {
  const { tool, seen } = toolkit(() => {});
  const dir = await tempDir('irmia-media-out-');
  const file = join(dir, 'outside.png');
  await writeFile(file, Buffer.from([1, 2, 3]));

  // ① 显式边界（生产里 `workspace` 档就是这样：`ctx.boundaryRoot` 来自 config）⇒ 措辞要说清怎么改
  const explicit = { ...(CTX as object), boundaryRoot: process.cwd() } as never;
  const denied = await tool.handler({ path: file, kind: 'image', to: 'qq:c2c:USER-1' }, explicit);
  assert.equal(denied.isError, true, `workspace 档该拒：${denied.content}`);
  assert.match(denied.content, /trust\.mode/u, '要说清怎么改');
  assert.equal(seen.length, 0, '被拒时一份都不许发出去');

  // ② 历史默认（不传 boundaryRoot）同样拒——措辞不同（没有 trust.mode 那一句），但**必须拒**
  const implicit = await tool.handler({ path: file, kind: 'image', to: 'qq:c2c:USER-1' }, CTX);
  assert.equal(implicit.isError, true, `不传 boundaryRoot 时也该拒：${implicit.content}`);
  assert.equal(seen.length, 0);
});

test('send_media：四种 kind 映到官方的 file_type；url 那条路不带 path', async () => {
  const { tool, seen } = toolkit(() => {});
  for (const [kind, fileType] of [['image', 1], ['video', 2], ['voice', 3], ['file', 4]] as const) {
    await tool.handler({ url: 'https://example.invalid/x', kind, to: 'qq:c2c:USER-1' }, CTX);
    assert.equal(seen.at(-1)?.fileType, fileType, `${kind} → ${fileType}`);
    assert.equal(seen.at(-1)?.url, 'https://example.invalid/x');
    assert.equal(seen.at(-1)?.path, undefined);
    assert.equal(seen.at(-1)?.name, undefined, '网络地址没有本机文件名，不编一个');
  }
});

test('send_media：path 与 url 必须给且只给一个（两边都不给 / 都给都拒）', async () => {
  const { tool, seen } = toolkit(() => {});
  const neither = await tool.handler({ to: 'qq:c2c:USER-1' }, CTX);
  assert.equal(neither.isError, true);
  assert.match(neither.content, /必须给且只给一个/u);
  const both = await tool.handler({ path: 'a.png', url: 'https://example.invalid/b.png', to: 'qq:c2c:USER-1' }, CTX);
  assert.equal(both.isError, true);
  assert.equal(seen.length, 0, '参数不合法就不该去发');
});

test('send_media：没接线时如实报"没有接线"，不假装发过', async () => {
  const { tool } = toolkit(null);
  const result = await tool.handler({ path: 'a.png', to: 'qq:c2c:USER-1' }, CTX);
  assert.equal(result.isError, true);
  assert.match(result.content, /没有装配媒体投递口/u);
});

test('send_media：宿主回报失败时如实转述理由（不吞）', async () => {
  const tk = createAdminTools({
    timers: new TimerStore(null),
    emit: () => {},
    mediaPoster: {
      async post() {
        return { ok: false as const, reason: '上传被拒（code=40093002 当日配额已用尽）' };
      },
    },
  });
  // v64：`full` 档才走得下去（`CTX` 那一档会先被边界拦）⇒ 这条测的是"宿主失败如实转述"
  const file = join(await tempDir('irmia-media-fail-'), 'a.png');
  await writeFile(file, Buffer.from([1]));
  const result = await tk.byName('send_media').handler({ path: file, to: 'qq:c2c:USER-1' }, OPEN_CTX);
  assert.equal(result.isError, true);
  assert.match(result.content, /40093002/u);
  assert.match(result.content, /当日配额已用尽/u);
});

// ─────────────────── 2026-10-17：`kind:file` 的两条病（OneBot 发不出 / 官方"未命名"） ───────────────────
//
// 根因同一个：v64 起 `send_media` 把本机文件**读成字节**交给投递口，`path` 与 `name` 两个字
// 从来没填进 `MediaRequest` ⇒ OneBot 的文件那条拿不到本机路径（`upload_*_file` 要路径，
// 不是消息段）、官方的上传体里没有 `file_name`（QQ 显示"未命名"）。
// **只给文件类补这两个字**：图/视频/语音那三条路是好的，载荷必须与从前逐字节相同。

test('OneBot 文件：交下去的 path 是**校验后的绝对路径**，通道终于能构造上传动作', async () => {
  const { tool, seen } = toolkit(() => {});
  const dir = await tempDir('irmia-media-onebot-');
  const file = join(dir, 'report.pdf');
  await writeFile(file, Buffer.from([0x25, 0x50, 0x44, 0x46]));
  // 相对路径进来、绝对路径出去：`workspaceRoot` 指到那个临时目录（`full` 档，v64 默认）
  const ctx = { ...(OPEN_CTX as object), workspaceRoot: dir } as never;
  const result = await tool.handler({ path: 'report.pdf', kind: 'file', to: 'onebot:c2c:10001' }, ctx);
  assert.equal(result.isError, undefined, result.content);

  const media = seen[0]!;
  assert.equal(media.fileType, 4);
  assert.equal(media.path, file, '交给通道的是**绝对**路径（不是原样相对路径）');
  assert.equal(media.name, 'report.pdf', '文件名跟着走（官方 `file_name` 的唯一来源）');
  assert.equal(media.data?.byteLength, 4, '字节照旧给（图/视频/语音与其它通道都用它）');

  // 关键：通道层不再报"要一个本机路径"——它拿到的是 `upload_private_file` 的合法入参
  const c2c = oneBotMediaCall(false, '10001', media);
  assert.ok(c2c.ok, `不该再说"要一个本机路径"：${JSON.stringify(c2c)}`);
  assert.equal(c2c.action, 'upload_private_file');
  assert.deepEqual(c2c.params, { user_id: 10001, file, name: 'report.pdf' });

  const group = oneBotMediaCall(true, '20002', media);
  assert.ok(group.ok, JSON.stringify(group));
  assert.equal(group.action, 'upload_group_file');
  assert.deepEqual(group.params, { group_id: 20002, file, name: 'report.pdf' });
});

test('OneBot 文件也走**同一道**边界：`workspace` 档下越界仍被拒，投递口一次都不调用', async () => {
  const { tool, seen } = toolkit(() => {});
  const outside = join(await tempDir('irmia-media-file-out-'), 'secret.pdf');
  await writeFile(outside, Buffer.from([1]));
  // 判据是 v64 那条（`boundaryRootFor('write', …)`）：这里只是确认"补 path"没有绕开它
  // 用**显式**边界那一档（生产里 `workspace` 档就是这样），措辞里会给出怎么改
  const explicit = { ...(CTX as object), boundaryRoot: process.cwd() } as never;
  const denied = await tool.handler({ path: outside, kind: 'file', to: 'onebot:c2c:10001' }, explicit);
  assert.equal(denied.isError, true, String(denied.content));
  assert.match(denied.content, /trust\.mode/u, '要说清怎么改');
  assert.equal(seen.length, 0, '被拒时一份载荷都不该产生（也就没有 path 外泄）');
});

test('官方通道：`name` 会被写成上传体的 `file_name`（第二次改英文名也没救的那条）', async () => {
  const { tool, seen } = toolkit(() => {});
  const dir = await tempDir('irmia-media-official-');
  const file = join(dir, '季度报告.pdf');
  await writeFile(file, Buffer.from([1, 2, 3]));
  const result = await tool.handler({ path: file, kind: 'file', to: 'qq:c2c:USER-1' }, OPEN_CTX);
  assert.equal(result.isError, undefined, result.content);
  assert.equal(seen[0]?.name, '季度报告.pdf', '交给通道的载荷里要有文件名');

  // 真发送器 + 假 HTTP：断言**真正发出去的那个请求体**（不假装调用成功，只验形状）
  const requests: Array<{ url: string; jsonBody: Record<string, unknown> }> = [];
  const sender = new QqMessageSender({
    token: () => Promise.resolve('ACCESS'),
    http: (async (input: { url: string; jsonBody?: unknown }) => {
      requests.push({ url: input.url, jsonBody: (input.jsonBody ?? {}) as Record<string, unknown> });
      return { status: 200, text: '', body: { file_uuid: 'U1', file_info: 'FI-1', ttl: 300 } };
    }) as never,
  });
  const uploaded = await sender.uploadMedia('c2c', 'USER-1', seen[0]!);
  assert.equal(uploaded.ok, true, JSON.stringify(uploaded));
  assert.equal(requests[0]?.url, 'https://api.bot.qq.com/v2/users/USER-1/files');
  assert.equal(requests[0]?.jsonBody['file_name'], '季度报告.pdf', '官方字段就叫 file_name');
  assert.equal(requests[0]?.jsonBody['file_type'], 4);
  assert.equal(typeof requests[0]?.jsonBody['file_data'], 'string', '字节照旧走 file_data');
});

test('回归：图片/视频/语音的载荷 = 字节 + 校验过的绝对路径（`name` 仍然只给文件类）', async () => {
  const { tool, seen } = toolkit(() => {});
  const dir = await tempDir('irmia-media-kinds-');
  const bytes = Buffer.from([7, 8, 9]);
  for (const [kind, fileType] of [['image', 1], ['video', 2], ['voice', 3]] as const) {
    const file = join(dir, `${kind}.bin`);
    await writeFile(file, bytes);
    await tool.handler({ path: file, kind, to: 'qq:c2c:USER-1' }, OPEN_CTX);
    // 2026-10-18（P1-11）：`path` 是**新加的那一格**（凭据门的判据）；除它之外一个字都没变——
    // `name` 仍然缺席（它会进官方 `file_name` 与 OneBot 视频段，那两条路的请求字节必须不动）。
    assert.deepEqual(seen.at(-1), { fileType, data: bytes, path: file }, `${kind} 的载荷只多出 path`);
  }
});

// ─────────────── 安全回归（2026-10-17）：`protectedPaths` 对 `send_media` 自 v64 起失效 ───────────────
//
// 时间点：v64 `da9a15e` 让工具层把本机文件读成字节，投递口于是走 `data !== undefined` 的早退
// 分支——而凭据判定（`protectedPaths`）原来只写在"只带路径"那条路上，**整条被跳过**：
// 她能把 `data/.keys.json` 原样发出去（本机到通道），而这条门正是 2026-10-05 用户点名要的。
// 判据仍然只有一处（`channel/media-poster.ts` 的 `refuseProtected`，realpath + `insideAny`），
// 修法只是把它**挪到早退之前**；三档信任都不能放宽（这道门与 `trust.mode` 无关）。

/** 真投递口 + 假 OneBot 通道：把"工具 → 投递口 → 通道"整条串起来，只记载荷、不真的发 */
function realPosterToolkit(options: {
  dataDir: string;
  protectedPaths: readonly string[];
  /** 假通道回的 messageId（缺省 '' = 给不出 id，例如文件上传那条） */
  messageId?: string;
}) {
  const seen: MediaRequest[] = [];
  const emitted: Array<{ type: string; data: Record<string, unknown> }> = [];
  const answerId = options.messageId ?? '';
  const onebot = {
    name: ONEBOT_CHANNEL_NAME,
    start: () => {},
    stop: () => {},
    sendText: async () => ({ ok: true as const, messageId: 'S', passive: false, msgSeq: 0 }),
    sendMediaTo: async (_chatType: string, _chatId: string, media: MediaRequest) => {
      seen.push(media);
      return { ok: true as const, messageId: answerId, passive: false, msgSeq: 0 };
    },
  } as unknown as ChannelAdapter;
  const channels = new Map<string, ChannelAdapter>([[ONEBOT_CHANNEL_NAME, onebot]]);
  const poster = createWorkspaceMediaPoster({
    dataDir: options.dataDir,
    workspaceRoot: process.cwd(),
    channels,
    protectedPaths: options.protectedPaths,
  });
  const tk = createAdminTools({
    timers: new TimerStore(null),
    emit: (type, data) => { emitted.push({ type, data: data as Record<string, unknown> }); },
    mediaPoster: poster,
  });
  return { tool: tk.byName('send_media'), seen, emitted };
}

test('受保护路径**三档信任都不许发**：full / workspace（显式）/ workspace（隐式）', async () => {
  const dir = await tempDir('irmia-media-protected-');
  const secret = join(dir, '.keys.json');
  const sentinel = 'SENTINEL-KEYS-0123456789';
  await writeFile(secret, sentinel);
  const { tool, seen } = realPosterToolkit({ dataDir: dir, protectedPaths: [secret] });

  const ctxs: Array<[string, Record<string, unknown>]> = [
    ['full（默认，整台电脑）', { ...(OPEN_CTX as object) }],
    ['workspace（显式边界）', { ...(CTX as object), boundaryRoot: dir }],
    ['workspace（隐式边界）', { ...(CTX as object), workspaceRoot: dir }],
  ];
  for (const [label, ctx] of ctxs) {
    const result = await tool.handler({ path: secret, kind: 'file', to: 'onebot:c2c:10001' }, ctx as never);
    assert.equal(result.isError, true, `${label} 该拒：${result.content}`);
    // 文案沿用投递口既有的那句（不另写一套）
    assert.match(result.content, /拒绝外发/u, label);
    assert.match(result.content, /本机凭据文件（受保护路径）/u, label);
    assert.match(result.content, /不会交给任何通道/u, label);
    assert.ok(!result.content.includes(sentinel), `${label}：内容不得出现在回执里`);
  }
  assert.equal(seen.length, 0, '三档加起来，凭据一次都不该到通道层');

  // 对照：同一份目录里的普通文件照旧发得出去（门只挡凭据）
  const normal = join(dir, 'report.pdf');
  await writeFile(normal, Buffer.from([1, 2, 3]));
  const ok = await tool.handler({ path: normal, kind: 'file', to: 'onebot:c2c:10001' }, OPEN_CTX);
  assert.equal(ok.isError, undefined, String(ok.content));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.path, normal);
});

test('`url` 那条路不涉及本机文件 ⇒ 不受凭据门影响（别误伤）', async () => {
  const dir = await tempDir('irmia-media-protected-url-');
  const secret = join(dir, '.keys.json');
  await writeFile(secret, 'SENTINEL-KEYS');
  const { tool, seen } = realPosterToolkit({ dataDir: dir, protectedPaths: [secret] });
  const result = await tool.handler(
    { url: 'https://example.invalid/a.pdf', kind: 'file', to: 'onebot:c2c:10001' },
    OPEN_CTX,
  );
  assert.equal(result.isError, undefined, String(result.content));
  assert.equal(seen.length, 1, '网络地址照旧交下去');
  assert.equal(seen[0]?.path, undefined, '没有本机路径 ⇒ 凭据门无从触发，也不该拦');
});

// ─────────── 2026-10-18（review P1-11）：凭据门对**四种 kind** 都生效 ───────────
//
// b8b40e5 只给 `kind:file` 补了 `path`，而投递口的凭据门（`media-poster.ts` 的 `refuseProtected`）
// 只认 `path` ⇒ 默认的 `kind:image` 把 `.keys.json` 的字节交给通道时，那道门一次都没跑。
// 现在四种 kind 都带校验过的绝对 path，判据仍然只在投递口一处（不在工具层另抄一份）。

test('受保护路径：**四种 kind** 一律拒（默认的 image 也在门内）', async () => {
  const dir = await tempDir('irmia-media-protected-kinds-');
  const secret = join(dir, '.keys.json');
  const sentinel = 'SENTINEL-KEYS-KINDS-0123456789';
  await writeFile(secret, sentinel);
  const { tool, seen } = realPosterToolkit({ dataDir: dir, protectedPaths: [secret] });

  for (const kind of ['image', 'video', 'voice', 'file'] as const) {
    const result = await tool.handler({ path: secret, kind, to: 'onebot:c2c:10001' }, OPEN_CTX);
    assert.equal(result.isError, true, `${kind} 该拒：${String(result.content)}`);
    assert.match(String(result.content), /拒绝外发/u, kind);
    assert.match(String(result.content), /本机凭据文件（受保护路径）/u, kind);
    assert.ok(!String(result.content).includes(sentinel), `${kind}：内容不得出现在回执里`);
  }
  assert.equal(seen.length, 0, '四种 kind 加起来，凭据一次都不许到通道层');

  // 对照：同一目录里的普通图照旧发得出去（门只挡凭据，不挡媒体）
  const picture = join(dir, 'a.png');
  await writeFile(picture, Buffer.from([1, 2, 3]));
  const ok = await tool.handler({ path: picture, kind: 'image', to: 'onebot:c2c:10001' }, OPEN_CTX);
  assert.equal(ok.isError, undefined, String(ok.content));
  assert.equal(seen.length, 1);
});

test('`url` 只收 http(s)：`file:` / 盘符 / `data:` 形态一律拒（协议端会照它去读盘）', async () => {
  const dir = await tempDir('irmia-media-url-scheme-');
  const secret = join(dir, '.keys.json');
  await writeFile(secret, 'SENTINEL-KEYS');
  const { tool, seen } = realPosterToolkit({ dataDir: dir, protectedPaths: [secret] });

  const localForms = [
    `file:///${secret.replaceAll('\\', '/')}`, // OneBot 的 `file` 字段会把它当本机路径
    secret,                                    // 盘符形态（`new URL` 认成 `c:`/`d:` 协议）
    'data:application/json;base64,e30=',       // 夹带的字节
  ];
  for (const url of localForms) {
    const result = await tool.handler({ url, kind: 'image', to: 'onebot:c2c:10001' }, OPEN_CTX);
    assert.equal(result.isError, true, `该拒：${url}`);
    assert.match(String(result.content), /只接受 http\(s\)/u, url);
  }
  assert.equal(seen.length, 0, '被拒的 url 一次都不该到通道层');

  // 反面：正常的网络地址照旧
  const ok = await tool.handler(
    { url: 'https://example.invalid/a.png', kind: 'image', to: 'onebot:c2c:10001' },
    OPEN_CTX,
  );
  assert.equal(ok.isError, undefined, String(ok.content));
  assert.equal(seen.length, 1);
});

// ─────────── 2026-10-18（review P1-09）：200MB 闸门在**读之前** ───────────
//
// 投递口那道大小门只认 `path`，而 v64 起工具层递的是 `data`（早了退）⇒ 整份文件先进内存、
// 闸门一次都没跑。现在工具层先 `stat`：超限当场拒，一个字节都不读。
//
// ⚠ 2026-10-21（外部审计定位的 7.81GB 源头）：这条用例原来把 `backup.iso` `truncate` 到
// `MEDIA_MAX_BYTES + 1`，注释写着"稀疏文件、NTFS 按需分配、不会真占 200MB"——**实测是假的**：
// NTFS 的 `SetEndOfFile` 会真分配那 200MB，一条用例一次、且从不删 ⇒ `%TEMP%` 里 1297 个
// `irmia-media-*` 全是它留下的。现在上限可注入（`AdminToolsOptions.mediaMaxBytes`），
// 用 **1KB** 的上限钉同一条判据：`> cap` 拒、`== cap` 放行（两侧都测得起，因为只有 1KB）。

const MEDIA_CAP_FOR_TEST = 1024;

test('超过上限的文件：读之前就拒（投递口一次都不调用）；`== cap` 放行', async () => {
  const { tool, seen } = toolkit(() => {}, { mediaMaxBytes: MEDIA_CAP_FOR_TEST });
  const dir = await tempDir('irmia-media-huge-');
  const over = join(dir, 'backup.iso');
  // 真写 1KB+1 字节（不 truncate 到 200MB：那条路在 NTFS 上会真分配 200MB）
  await writeFile(over, Buffer.alloc(MEDIA_CAP_FOR_TEST + 1));

  const result = await tool.handler({ path: over, kind: 'file', to: 'onebot:c2c:10001' }, OPEN_CTX);
  assert.equal(result.isError, true, String(result.content));
  assert.match(String(result.content), /超过单文件上限/u);
  assert.ok(String(result.content).includes(String(MEDIA_CAP_FOR_TEST)), '要把上限的数值说出来');
  assert.equal(seen.length, 0, '被拒的载荷一个都不该到投递口（也就没有整份读进内存）');

  // 边界另一侧：正好等于上限 ⇒ 放行（这条以前测不起，因为 `== 200MB` 要真读 200MB）
  const atCap = join(dir, 'exact.bin');
  await writeFile(atCap, Buffer.alloc(MEDIA_CAP_FOR_TEST));
  const okAtCap = await tool.handler({ path: atCap, kind: 'file', to: 'onebot:c2c:10001' }, OPEN_CTX);
  assert.equal(okAtCap.isError, undefined, String(okAtCap.content));
  assert.equal(seen.length, 1, '`== cap` 必须在放行那一侧');
  assert.equal(seen[0]?.data?.byteLength, MEDIA_CAP_FOR_TEST);
});

test('目录不是文件：同样在读之前拒（不把 ENOTDIR/EISDIR 当成"读不到"）', async () => {
  const { tool, seen } = toolkit(() => {});
  const dir = await tempDir('irmia-media-dir-');
  const result = await tool.handler({ path: dir, kind: 'file', to: 'onebot:c2c:10001' }, OPEN_CTX);
  assert.equal(result.isError, true, String(result.content));
  assert.match(String(result.content), /不是一个文件/u);
  assert.equal(seen.length, 0);
});

// ─────────── 2026-10-18（review P1-12）：平台 messageId 回填到凭据里 ───────────
//
// 通道层过去在 `createChannelMediaPoster` 里把 `SendOutcome.messageId` 窄化掉 ⇒
// `speak/sent` 没有 id ⇒ `read_channel` 的（我）行没有 `·m<id>` ⇒ OneBot 的图/视频/语音撤不掉。

test('媒体回执带平台 messageId：`speak/sent` 里看得见它', async () => {
  const dir = await tempDir('irmia-media-id-');
  const { tool, seen, emitted } = realPosterToolkit({
    dataDir: dir,
    protectedPaths: [],
    messageId: 'PLAT-IMG-77',
  });
  const file = join(dir, 'a.png');
  await writeFile(file, Buffer.from([1, 2, 3]));

  const result = await tool.handler({ path: file, kind: 'image', to: 'onebot:c2c:10001' }, OPEN_CTX);
  assert.equal(result.isError, undefined, String(result.content));
  assert.equal(seen.length, 1);

  const sent = emitted.find(event => event.type === 'speak/sent');
  assert.ok(sent !== undefined, '发成功必须落一条 speak/sent 凭据');
  assert.equal(sent.data['channel'], 'reply-url', '只有这一档才算"真送进了会话"');
  assert.equal(sent.data['messageId'], 'PLAT-IMG-77', '平台 id 必须一路传到凭据里（否则撤不掉）');
  assert.match(String(sent.data['text']), /［图］/u);
});

test('通道给不出 id（文件上传那条只回 file_id）：这一格**缺席**，不是空串', async () => {
  const dir = await tempDir('irmia-media-no-id-');
  const { tool, seen, emitted } = realPosterToolkit({
    dataDir: dir,
    protectedPaths: [],
    messageId: '',
  });
  const file = join(dir, 'report.pdf');
  await writeFile(file, Buffer.from([1, 2, 3]));

  const result = await tool.handler({ path: file, kind: 'file', to: 'onebot:c2c:10001' }, OPEN_CTX);
  assert.equal(result.isError, undefined, String(result.content));
  assert.equal(seen.length, 1);

  const sent = emitted.find(event => event.type === 'speak/sent');
  assert.ok(sent !== undefined);
  assert.equal('messageId' in sent.data, false, '空 id 落成缺席（与 deliverToSession 的兜底同一条）');
});

// ─────────── 2026-10-19（现场）：回执里要有平台 id；拿不到就要当场说破 ───────────
//
// 现场原话（逐字）：「撤回要有平台的 message id。我发图走的是 `send_media`，**回执只说
// "投递成功"，平台返回的 message_id 框架没记下来**；回头翻聊天记录，**我自己发的消息那行
// 也只有 `［图］`，没有 `·m` 那串**。协议端 `get_group_msg_history` 拉了一遍，**它不返回
// bot 自己发的消息** ⇒ id 拿不到，撤回窗口 2 分钟就空过了。」
//
// 所以这一段同时钉三层，缺一层她那张图就还是撤不掉：
//   ① **回执**（她读得到的那一眼）：拿得到 id 时明写 `·m<id>`、并说清它是什么；
//   ② **事件**（`speak/sent.messageId`）：`read_channel` 的（我）行靠它——协议端历史不返回
//      bot 自己的消息，所以这一条是那行 id 的**唯一**来源；
//   ③ **反证**：通道给不出 id 时回执必须说"没返回 id、撤回可能做不到"，不许沉默
//      （「先答应再发现做不到」正是从沉默里长出来的）。
//
// 走真链路（真 `EventLog` + 真 `RealLoop` 的读取口 + 真 `read_channel`），只有通道那一跳是替身。

const RIG_TZ = 'Asia/Shanghai';

const RIG_PERSONA: PersonaAssets = {
  identity: 'IDENTITY',
  constitution: 'CONSTITUTION',
  style: 'STYLE',
  state: 'STATE',
  relationship: null,
  personaHash: 'test-hash',
  isSeed: false,
} as unknown as PersonaAssets;

/** 模型替身：这一段一次模型调用都不该发生 */
function deadDs(): DsClient {
  return {
    modelFor: (): string => 'fake',
    generate: async (): Promise<never> => { throw new Error('这一份用例不该调模型'); },
    stream: async (): Promise<never> => { throw new Error('这一份用例不该调模型'); },
  } as unknown as DsClient;
}

interface MediaIdRig {
  dir: string;
  /** 直接写一条事件（用它手搓"老版本形状"的凭据） */
  write: (type: string, data: unknown) => void;
  send: (args: Record<string, unknown>) => Promise<ToolHandlerResult>;
  read: (sid: string, limit?: number) => Promise<ToolHandlerResult>;
  /** 日志里那些"真送进了会话"的投递凭据（`deliverToSession` 写的那几条） */
  credentials: () => Promise<Array<Record<string, unknown>>>;
}

/**
 * 真链路测试台。
 *
 * 与上面那些只用假投递口的用例不同：这里 `send_media` → `speak/sent` → `read_channel`
 * 走的是**真的那一份**，因为这件事的病害恰恰是"每一层都以为自己写对了"。
 * 通道那一跳（`sendMediaTo`）是唯一的替身——`messageId` 就是这一份要控制的自变量。
 */
async function makeMediaIdRig(
  t: TestContext,
  options: {
    session: 'onebot:group:G1';
    chatId: string;
    /** 假通道回的 id（``''`` = 通道给不出，例如 OneBot 的文件上传只回 file_id） */
    messageId: string;
  },
): Promise<MediaIdRig> {
  const dir = await tempDir('irmia-media-receipt-');
  const log = await EventLog.open(join(dir, 'events'));
  const projection = fold([]);
  const now = (): Date => new Date('2026-10-19T15:00:00.000+08:00');
  const real = new RealLoop({
    log,
    dataDir: dir,
    projection,
    now,
    timezone: RIG_TZ,
    ds: deadDs(),
    registry: new ToolRegistry(),
    persona: RIG_PERSONA,
    config: defaultConfig(dir),
    out: () => {},
    pollMs: 3_600_000,
  });
  const emit = (type: string, data: unknown): void => {
    const event = {
      seq: log.nextSeq(),
      ts: now().toISOString(),
      type,
      data,
      visibility: defaultVisibility(type),
      origin: 'test/send-media',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    applyOne(projection, event);
  };
  // 会话里先有一条别人的话：`read_channel` 才走得到渲染那一层（否则先撞"没有取到消息"早退）
  emit('channel/message', {
    channel: 'onebot',
    chatType: 'group',
    person: 'OPENID_A',
    chatId: options.chatId,
    text: '你刚才说什么',
    messageId: '1739441710',
    msgSeq: 1,
  });
  const onebot = {
    name: ONEBOT_CHANNEL_NAME,
    start: () => {},
    stop: () => {},
    sendText: async () => ({ ok: true as const, messageId: 'TEXT-1', passive: false, msgSeq: 0 }),
    // **唯一替身**：平台回的 id 由这一份用例控制
    sendMediaTo: async () => ({
      ok: true as const,
      messageId: options.messageId,
      passive: false,
      msgSeq: 0,
    }),
  } as unknown as ChannelAdapter;
  const channels = new Map<string, ChannelAdapter>([[ONEBOT_CHANNEL_NAME, onebot]]);
  const tk = createAdminTools({
    timers: new TimerStore(null),
    emit: emit as never,
    mediaPoster: createWorkspaceMediaPoster({ dataDir: dir, channels }),
    channelReader: async (sid, limit, before) => await real.readChannelMessages(sid, limit, before),
    channelSpokenReader: async (sid) => await real.readChannelSpoken(sid),
    timezone: RIG_TZ,
  });
  const ctx = {
    callId: 'call_send_media',
    turn: 7,
    step: 1,
    signal: new AbortController().signal,
    workspaceRoot: dir,
    // `full` 档：媒体出站按"写"处理，不设边界（现场默认档，见 send_media 的边界注释）
    boundaryRoot: null,
  };
  t.after(() => {
    real.stop();
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    write: emit,
    send: async (args) => await tk.byName('send_media').handler(args, ctx as never),
    read: async (sid, limit = 10) => await tk.byName('read_channel').handler({ sid, limit }, ctx as never),
    credentials: async () => {
      log.flush();
      const out: Array<Record<string, unknown>> = [];
      for await (const event of log.readAll()) {
        if (event.type === 'speak/sent') out.push(event.data as Record<string, unknown>);
      }
      return out;
    },
  };
}

// ──────────────────────────── ① 正向：id 在回执、事件、那一行三处都对得上 ────────────────────────────

test('send_media：回执带 `·m<id>`（说清它是什么）；事件与 read_channel 的（我）行是同一个 id', async (t) => {
  const rig = await makeMediaIdRig(t, {
    session: 'onebot:group:G1',
    chatId: 'G1',
    messageId: 'PLAT-IMG-77',
  });
  const file = join(rig.dir, 'a.png');
  await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const out = await rig.send({ path: file, kind: 'image', to: 'onebot:group:G1' });
  assert.equal(out.isError, undefined, out.content);
  // ① 回执：她要**当场**看得见这个 id（撤回窗口只有两分钟，等她回头翻历史就空了）
  assert.match(out.content, /已发出 1 条 · 投递成功 · /u, out.content);
  assert.match(out.content, /已发往 onebot:group:G1/u, `发到哪儿要能核对（跨会话回执印的是 sid）：\n${out.content}`);
  assert.match(out.content, /·mPLAT-IMG-77/u,
    `回执里要带平台 id（\`·m<id>\`，与 read_channel 同一形态）：\n${out.content}`);
  // v76：**"它是平台消息 id、拿它去撤回/核对"搬进了 `SELF_BRIEF` §2.1**——回执是逐轮重发的，
  // 样板放这里等于每条都付一次全价。判据从"回执里有 `平台消息 id` / `撤回`"改成
  // "提示词里有、回执里没有"（`id=` 这个前缀由提示词解释）。
  assert.ok(SELF_BRIEF.includes('平台消息 id') && SELF_BRIEF.includes('撤回'),
    '`·m<id>` 是什么、拿它做什么，要在常驻提示词里说清');
  assert.equal(out.content.includes('平台消息 id'), false,
    `样板已搬进 SELF_BRIEF，回执不再重复付：\n${out.content}`);
  assert.equal(out.content.includes('撤回'), false,
    `样板已搬进 SELF_BRIEF，回执不再重复付：\n${out.content}`);
  assert.ok(!out.content.includes('拿不到'), `拿得到 id 时不许说"拿不到"：\n${out.content}`);

  // ② 事件：`speak/sent.messageId` 与回执里那一串是同一个
  const credentials = await rig.credentials();
  assert.equal(credentials.length, 1, '发成功一条媒体 = 一条"真送进了会话"的凭据');
  assert.equal(credentials[0]?.['messageId'], 'PLAT-IMG-77',
    '平台 id 必须一路传到凭据里（read_channel 的（我）行靠它）');
  assert.match(String(credentials[0]?.['text']), /［图］/u, '媒体的凭据文本是那一行可读摘要');

  // ③ 回看：她自己发的那一行也带同一个 id ——
  //    "协议端历史不返回 bot 自己发的消息"这件事靠的正是**事件里这个 id**（不靠历史接口）
  const view = await rig.read('onebot:group:G1', 10);
  assert.equal(view.isError, undefined, view.content);
  const mineRow = view.content.split('\n').find((line) => line.includes('（我）'));
  assert.ok(mineRow !== undefined, `她的那一行要在：\n${view.content}`);
  assert.match(mineRow!, /［图］·mPLAT-IMG-77\s*$/u,
    `（我）行尾要带同一个 id（她据此撤掉自己刚发的那张图）：\n${view.content}`);
});

// ──────────────── ② 反向：通道给不出 id ⇒ 回执明说"撤回可能做不到" ────────────────

test('**反向**：通道不返回 id ⇒ 回执明说"没拿到 id、撤回可能做不到"（不是沉默、不是空串）', async (t) => {
  const rig = await makeMediaIdRig(t, {
    session: 'onebot:group:G1',
    chatId: 'G1',
    // OneBot 的文件上传那条只回 `file_id`：`SendOutcome.messageId` 是空串 ⇒ 投递口不带这一格
    messageId: '',
  });
  const file = join(rig.dir, 'report.pdf');
  await writeFile(file, Buffer.from([0x25, 0x50, 0x44, 0x46]));

  const out = await rig.send({ path: file, kind: 'file', to: 'onebot:group:G1' });
  assert.equal(out.isError, undefined, out.content);
  // 三个阶段都要出现：没拿到 / 为什么不行 / 她该怎么办
  assert.match(out.content, /没拿到平台消息 id/u,
    `拿不到就要当场说破（不许沉默）：\n${out.content}`);
  assert.match(out.content, /撤回可能做不到/u,
    `要说清后果（能不能撤），而不是只报"成功"：\n${out.content}`);
  assert.match(out.content, /不返回就别承诺能撤/u,
    `要把规矩一并告诉她（下一次发之前就判得了）：\n${out.content}`);
  assert.equal(out.content.includes(MESSAGE_ID_MARK), false,
    `没 id 时不许摆一个空的 \`·m\`（那会被读成"id 就在这儿"）：\n${out.content}`);

  // 事件层：缺席，不是空串（与 `deliverToSession` 的兜底同一条）
  const credentials = await rig.credentials();
  assert.equal(credentials.length, 1);
  assert.equal('messageId' in (credentials[0] ?? {}), false, '空 id 落成缺席');

  // 那一行照旧读得出来，只是少一格——不许因为"补不到 id"就把这一行改了样
  const view = await rig.read('onebot:group:G1', 10);
  const mineRow = view.content.split('\n').find((line) => line.includes('（我）'));
  assert.ok(mineRow !== undefined && mineRow.includes('［文件］'), `旧形状照旧：\n${view.content}`);
  assert.equal(mineRow!.includes(MESSAGE_ID_MARK), false,
    `她的那一行不许留孤零零的 sigil：\n${view.content}`);
});

// ──────────────── ③ 老事件（没有 messageId）⇒ read_channel 行格式一个字都不改 ────────────────

test('**老事件**（没有 messageId 的 speak/sent）⇒ read_channel 照旧，历史行不长出新东西', async (t) => {
  const rig = await makeMediaIdRig(t, {
    session: 'onebot:group:G1',
    chatId: 'G1',
    messageId: 'PLAT-IMG-99',
  });
  // 换写法之前日志里就是这个形状：只有 channel/chars/sid/text/spokenParts，没有 callId/turn/messageId
  rig.write('speak/sent', {
    channel: 'reply-url',
    chars: 0,
    sid: 'onebot:group:G1',
    text: '［图］',
    spokenParts: 1,
  });

  const view = await rig.read('onebot:group:G1', 10);
  const mineRow = view.content.split('\n').find((line) => line.includes('（我）'));
  assert.ok(mineRow !== undefined, `老凭据照样读得回来：\n${view.content}`);
  assert.match(mineRow!, /（我）：［图］$/u,
    `行格式与从前逐字相同（行尾不许多任何东西）：\n${view.content}`);
  assert.equal(mineRow!.includes(MESSAGE_ID_MARK), false,
    `老事件没有 id ⇒ 那一行不许出现 \`·m\`：\n${view.content}`);
  // 别人的那一行照旧带（这一条不是"把整屏关掉"）
  assert.match(view.content, /你刚才说什么·m1739441710/u, `别人的行不受影响：\n${view.content}`);
});

// ──────────────── ④ 能力披露：规矩写在她读得到的地方（**目前只在回执里**） ────────────────
//
// 「发之前先确认通道会返回 id；不返回就别承诺能撤」这句话**本来该写进 `send_media` 的
// `description`**（那是她动手之前唯一会读到的常驻文本）——**但这一版没写**，判据是仓库自己的
// 那条红线（`render.ts` 的 v67 篇 + `mcp-entry.ts:58-61`）：`description` 逐字节进 `tools` 段，
// 改它 = 现行清单换代 ⇒ **必须同批递增 `RENDER_VERSION`**（v67 就是为一句描述 +6 token 才 +1
// 的），而这一轮的任务书明说"不动 `RENDER_VERSION`，若你认为动了就停下报我"。
//
// 所以披露落在**回执**里（工具结果，只在被调用的那一次付、不进 `tools` 段）：
//   · 拿得到 id：`平台消息 id：·m<id>（与 read_channel 行尾那串同一个：要撤这条、要查这条的
//     原话，用的就是它）`；
//   · 拿不到 id：`这条**没拿到平台消息 id**：这个通道没返回 id，撤回可能做不到（判据：……。
//     发之前打算之后撤回，就先确认这一点——不返回就别承诺能撤）`。
// 两句都由 `mediaReceiptIdLine` 一处产出，上一段那两条用例逐字钉着。
// ── 2026-10-20 · v72：**描述版补丁已经落了**（用户批的最小安全版）──────────────────────────
// 落点：`src/tools/admin.ts` 的 `sendMedia.description` 末尾那一句（逐字：「想之后撤回的话，
// 发之前先确认这条通道会返回消息 id（回执里带 ·m<id> 才算）：不返回就别承诺能撤。」）。
// 代价（实测 `_research/_tmp-v72-readings.mts`，与本节原先记的预估值一致）：**51 → 82 token（+31）**，
// 单件硬门 100 仍过；代码口径 **5371 → 5405**（另含 `http_post` +2、`http_download` +1）、
// 运行期 **5481 → 5515**；同批 `RENDER_VERSION` 71 → 72，pin 见 `tool-catalog.test.ts` 文件头
// 与 `read-channel-incremental.test.ts` ⑦。
