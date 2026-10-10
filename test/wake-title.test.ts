/**
 * 唤醒标题（`wakeTitle`）的回归 —— 2026-10-06 修的真 bug。
 *
 * 缺陷（agent 本体伊尔弥亚实测报出）：**凡是从 QQ 官方通道来的任务，"本任务相关资产"那一行
 * 永远是空的**。根因在 `wakeTitle` 的口径：它对 `wake/channel` 退回 `renderWake`，于是"标题"
 * 是整个 `[external_event source=… person=… msg=ROBOT1.0_…]` 包裹——包裹头里的平台消息 id
 * **一个人就吃满** assets 那边的 `TASK_TITLE_MAX_CHARS = 200`，正文永远落在窗外，
 * 喂给 light 的"马上要做的事"是一串 `ROBOT1.0_…`，light 只能回 `{"picks":[]}`。
 * 实测（`data/events` 全量 632 条 `wake/channel`）：修前 **0/607** 条的正文进得了那个窗口，
 * 修后 **607/607**；同一条事件只喂正文，light 立刻挑出 gh/git/rg。
 *
 * ⚠ **那一侧（挑资产）2026-10-09 取消了**（v45，用户拍板：准确率太低）：
 * "喂给 light 的任务是不是人话"这一半**没有消费者了**，所以这里不再钉它。
 * **标题口径本身照旧要钉**——它今天仍是任务卡那一行、CLI replay 的重建、界面预览与
 * 交接笔记条目共用的那一处（少一处另写口径，就会出现"她看到的是 A、日志里记的是 B"）。
 *
 * 这份文件钉四件事（判据只紧不松）：
 *   ① 判据本身：标题**就是人写的那句话**，机器标识（`source=` / `person=` / `msg=`）不进标题；
 *   ② 判据**只在一处**：`wakeTitle`。所以它的每个消费者（此刻层任务卡、CLI replay 的重建、
 *      界面预览、交接笔记条目）拿到的是同一句话——端到端那两条从**真实请求**上验，
 *      不是验函数返回值；
 *   ③ **包裹没有被动过**：`renderWake` 仍然是那个带 `[external_event]` 边界的包裹——框里是
 *      别人说的话，这是安全语义，改标题不许碰它；
 *   ④ **GUI 手动唤醒（`wake/manual`）那条路一起钉住**：它本来就通（标题一直是那句人话），
 *      这条用例保证"修渠道那一条"没有把它改坏。
 *
 * 台子见 `test/fixtures/real-wake-rig.ts`：真 RealLoop + 真 agent-loop + 真 render，
 * **只有模型是假的**——"她那一轮到底看到了什么"只有走整条链路才证得了。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { HookRunner } from '../src/hook/hooks.ts';
import type { AppEvent } from '../src/log/types.ts';
import { NOW_LAYER_BANNER, clipTaskTitle, renderWake, wakeTitle } from '../src/model/render.ts';
import { RIG_NOW, makeRealWakeRig } from './fixtures/real-wake-rig.ts';

// ──────────────────────────────── 夹具 ────────────────────────────────

/**
 * QQ 官方通道那条消息 id 的**真实形状**：`ROBOT1.0_` + 一百多字符。
 *
 * 这里故意放到 **300+**（报出这条缺陷的人给的是这个量级）：判据必须是"**不管 id 多长**，
 * 它都不进标题"——写成"截断到 200 之前刚好放得下"就等于把判据绑在 id 的长度上，
 * 而那个长度**不由我们定**（它是平台的，明天可能更长）。
 */
const LONG_MESSAGE_ID = `ROBOT1.0_${'A'.repeat(300)}!`;
const HUMAN_SENTENCE = '弥亚小姐，去查一下I.R.M.I.A仓库的各项数据';

/** 一条事件（只为渲染层用，所以信封给最小合法形状） */
function evt(type: string, data: unknown): AppEvent {
  return {
    seq: 1,
    ts: '2026-10-06T10:00:00.000+08:00',
    type,
    data,
    visibility: 'model',
    origin: 'test/wake-title',
  } as unknown as AppEvent;
}

/** 一条 QQ 官方通道的单聊消息（形状与 `channel/qq-official.ts` 归一化后的 `WakeChannel` 一致） */
function channelWake(text: string, messageId = LONG_MESSAGE_ID): AppEvent {
  return evt('wake/channel', {
    channel: 'qq-official',
    chatType: 'c2c',
    person: 'E7FEC35E951B5CCF8BA66793BF6B1314',
    chatId: 'E7FEC35E951B5CCF8BA66793BF6B1314',
    text,
    messageId,
    msgSeq: 1,
    dedupeKey: messageId,
  });
}

/**
 * 落一份清单（路径与生产一致：`<dataDir>/workspace/MEMORIES/assets.md`）。
 *
 * v45（2026-10-09 取消「light 选取资产」）之后，这一份**没有任何东西会去读它**：这条用例留着
 * 它是为了钉住"清单在盘上、而请求体里一个字都没有"（清单从不常驻）。所以这里连
 * `probeAssetPath` 覆盖点也不必给了——事实层已经不在这一拍上跑。
 */
function writeAssets(rig: { dir: string }, content: string): void {
  const dir = join(rig.dir, 'data', 'workspace', 'MEMORIES');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'assets.md'), content, 'utf8');
}

const ONE_ASSET = ['# 数字资产', '', '- [path] gh ｜ 命令行管 GitHub ｜ 已在 PATH'].join('\n');

/** 注入判定的回包（`wake/channel` 的每一轮都会先判一次，见 real-loop 的 judgeChannelWakes） */
const NO_RISK = '{"risky":false,"reason":"普通请求，没有指挥她的迹象","quotes":[]}';

/** 一次请求的此刻层那一段文本（按段头认层，与 render 自己的做法一致） */
function nowLayerOf(request: { input?: unknown }): string {
  const items = Array.isArray(request.input) ? request.input : [];
  for (const item of items) {
    const content = (item as { content?: unknown }).content;
    if (typeof content === 'string' && content.includes(NOW_LAYER_BANNER)) return content;
  }
  return '';
}

/** 任务卡上「当前任务：」那一段（到 `（turn ` 为止） */
function cardTitleOf(request: { input?: unknown }): string {
  return nowLayerOf(request).split('当前任务：')[1]?.split('（turn ')[0] ?? '';
}

/**
 * 界面预览那条路（`src/web/server.ts` 的 `buildReplay`）——**与页面同一个入口**。
 *
 * 动态 import：那个模块很大，只有真要比"逐字节相同"的用例才值得把它拉起来
 * （与 `test/channel-wire.test.ts` 的做法一致）。
 */
async function previewRequestOf(rig: { dir: string }, turn: number, step: number): Promise<{ input?: unknown }> {
  const { buildReplay } = await import('../src/web/server.ts');
  const { readEventsReadOnly } = await import('../src/log/read-only.ts');
  const { defaultConfig } = await import('../src/config/config.ts');
  const { ToolRegistry } = await import('../src/tools/registry.ts');
  const { events } = readEventsReadOnly(join(rig.dir, 'data', 'events'));
  return buildReplay({
    events,
    turn,
    step,
    personaRoot: join(rig.dir, 'data', 'persona'),
    config: defaultConfig(rig.dir),
    registry: new ToolRegistry(),
  }).request;
}

// ──────────────────── ① 判据：标题是人话，机器标识不进标题 ────────────────────

test('① 300+ 字符的 ROBOT1.0_ 消息 id：标题是那句人话，不含任何机器标识', () => {
  const wake = channelWake(HUMAN_SENTENCE);
  const title = wakeTitle(wake);

  assert.equal(title, HUMAN_SENTENCE, `标题该是正文本身：${JSON.stringify(title)}`);
  // 逐项钉住"哪些东西不许进来"——只断言"不含 id"会让判据随实现漂
  for (const banned of ['ROBOT1.0_', '[external_event', '[/external_event]', 'source=', 'msg=', 'person=', 'chat=']) {
    assert.equal(title.includes(banned), false, `标题里不许有 ${banned}：${title}`);
  }
  assert.equal(title.includes('E7FEC35E951B5CCF8BA66793BF6B1314'), false, 'openid 也不进标题');

  // 任务卡那一行会把它裁到 80 字：裁完**正文照样看得见**（裁掉的是她自己的话的后半截，不是 id）
  const clipped = clipTaskTitle(title);
  assert.equal(clipped.includes('I.R.M.I.A'), true, `任务卡标题裁完仍看得见正文：${clipped}`);
  assert.equal(clipped.includes('ROBOT1.0_'), false, '裁完更不该出现 id');
});

test('① 附带：没有正文时如实说（纯图片/表情包），不写"（空消息）"这种假话', () => {
  const image = evt('wake/channel', {
    channel: 'qq-official', chatType: 'c2c', person: 'OPENID', chatId: 'OPENID',
    text: '', messageId: LONG_MESSAGE_ID, msgSeq: 1,
    attachments: [{ type: 'image/jpeg', url: 'https://example.invalid/x?rkey=secret', name: 'A.jpg' }],
  });
  assert.equal(wakeTitle(image), '（发了 1 个附件，没写字）');

  const blank = evt('wake/channel', {
    channel: 'qq-official', chatType: 'c2c', person: 'OPENID', chatId: 'OPENID',
    text: '   ', messageId: LONG_MESSAGE_ID, msgSeq: 1,
  });
  assert.equal(wakeTitle(blank), '（空消息）', '真的一条空消息才说"空消息"');
});

test('① 附带：多行正文压成一行——标题是**一行**摘要（与 wake/manual 同口径）', () => {
  const multi = channelWake('帮我搜一下三门齐开是什么\n顺便看看第二行会不会把任务卡撑断');
  const title = wakeTitle(multi);
  assert.equal(title.includes('\n'), false, `标题不许带换行：${JSON.stringify(title)}`);
  assert.equal(title, '帮我搜一下三门齐开是什么 顺便看看第二行会不会把任务卡撑断');
});

test('① 附带：别的唤醒类型口径不变（定时器/心跳/后台任务本来就没有包裹）', () => {
  assert.equal(
    wakeTitle(evt('wake/heartbeat', { quietSeconds: 600, idleTicks: 1, pressure: 0.05, probability: 0.4, roll: 0.2 })),
    '[system] 已安静 10 分钟。（心跳自省：无事发生是常态，看一眼待办与意图，没事就接着睡）',
  );
  assert.equal(
    // v41 起后台任务的标题是**一行摘要**（命令 + 退出码）：正文（多行输出）在 `renderWake` 里，
    // 不能进标题——任务卡那一行与 assets 的 200 字窗口都只装得下一行。
    wakeTitle(evt('wake/job', { jobId: 'job-1', command: 'npm run build', exitCode: 0 })),
    '[后台任务完成] job-1：npm run build（退出码 0）',
  );
  assert.equal(
    wakeTitle(evt('wake/timer', { timerId: 't1', scheduledAt: '2026-10-06T10:00:00.000Z', payload: { note: '提醒我喝水' } })),
    '[定时器触发] 提醒我喝水（计划时刻 2026-10-06T10:00:00.000Z）',
  );
});

// ──────────── ② 包裹没被动过：renderWake 仍然是那个带边界的包裹 ────────────

test('② 改的是标题，不是包裹：renderWake 照旧带 [external_event] 边界（安全语义不许动）', () => {
  const wake = channelWake(HUMAN_SENTENCE);
  const block = renderWake(wake);

  assert.equal(block.startsWith('[external_event source=qq-official chat=私聊'), true, `包裹头照旧：${block.slice(0, 80)}`);
  assert.equal(block.endsWith('[/external_event]'), true, '闭标签不许少——少一个就等于把边界打开了');
  assert.ok(block.includes(`msg=${LONG_MESSAGE_ID}#1`), '消息 id 仍在包裹里（她要按它去查原始记录）');
  assert.ok(block.includes(HUMAN_SENTENCE), '正文当然也在包裹里');
  // 同一个事件：给模型看的是包裹，给人看的是那句话——两件事，两个出口
  assert.notEqual(renderWake(wake), wakeTitle(wake));
});

// ──────────── ③ 端到端：渠道来的任务 ⇒ 资产那一行真的渲染出来 ────────────

test('③ 渠道唤醒端到端：她的任务卡标题是那句人话（v45 起不再有资产那一行）', async (t) => {
  // 这一条原来还顺带钉"资产那一行真的进请求 + 喂给 light 的任务是人话"。
  // **v45（2026-10-09 用户拍板取消「light 选取资产」这条机制）之后那两半没有了**：
  // 这一拍只剩「判注入（light）→ 她自己的主力车道」，所以断言跟着换成"标题仍然是那句话、
  // 而且机器标识一个都不许进上下文"。资产那一侧的新判据在 `test/digital-assets.test.ts` ①。
  const rig = await makeRealWakeRig({
    // 渠道那一拍只有注入判定那一次 light（挑资产那一次已经取消）
    generate: [{ outputItems: [{ type: 'message', text: NO_RISK }] }],
    stream: [{ text: '', toolCalls: [] }],
  });
  t.after(rig.dispose);
  writeAssets(rig, ONE_ASSET);

  rig.append('wake/channel', {
    channel: 'qq-official',
    chatType: 'c2c',
    person: 'E7FEC35E951B5CCF8BA66793BF6B1314',
    chatId: 'E7FEC35E951B5CCF8BA66793BF6B1314',
    text: HUMAN_SENTENCE,
    messageId: LONG_MESSAGE_ID,
    msgSeq: 1,
    dedupeKey: LONG_MESSAGE_ID,
  });
  await rig.tick();

  assert.deepEqual(
    rig.requests.map(item => item.lane),
    ['light', 'heavy'],
    '渠道那一拍：先判注入（light），再走她自己的主力车道（挑资产那一次已经取消）',
  );

  // ③a 她那一拍的任务卡标题就是那句话（不是 `ROBOT1.0_…` 那串包裹）
  const heavy = rig.requests[1]!.request;
  assert.equal(cardTitleOf(heavy), HUMAN_SENTENCE, '任务卡标题是那句人话——wakeTitle 那一处口径');
  assert.equal(nowLayerOf(heavy).includes('ROBOT1.0_'), false, '此刻层里不许出现消息 id');
  assert.equal(nowLayerOf(heavy).includes('本任务相关资产'), false, 'v45 起任务卡上不再有那一行');

  // ③b 记忆索引那条账照旧（它跟资产无关），而且**不再带 assets 那一格**
  const selected = (await rig.events()).filter(event => event.type === 'memory/selected');
  assert.equal(selected.length, 1, '轮首该写一条记忆注入账');
  assert.equal((selected[0]!.data as { assets?: string }).assets, undefined,
    'v45 起运行期不再产生那一格（旧日志里那些仍然读得回来，见 replay 的 v34 用例）');
});

// ──────────── ④ GUI 手动唤醒那条路：标题口径一样（v45 起不挑资产） ────────────

test('④ GUI 手动唤醒（wake/manual）端到端：任务卡标题就是他打的那句话', async (t) => {
  const rig = await makeRealWakeRig({
    // 手动唤醒**不判注入**（judgeChannelWakes 只认 wake/channel），v45 起也不挑资产 ——
    // 所以这一拍**一次 light 都不发**：`generate` 一条脚本都不给，多调一次就抛。
    stream: [{ text: '', toolCalls: [] }],
  });
  t.after(rig.dispose);
  writeAssets(rig, ONE_ASSET);

  // 界面聊天框打的话就是一条 wake/manual（见 src/web/server.ts 的 wake 动作）
  rig.append('wake/manual', { note: '把 GitHub 上那个仓库的数据查一下', person: '用户', dedupeKey: 'k1' });
  await rig.tick();

  assert.deepEqual(rig.requests.map(item => item.lane), ['heavy'], '手动那一拍只剩她自己的主力车道（不再挑资产）');
  const heavy = rig.requests[0]!.request;
  assert.equal(cardTitleOf(heavy), '把 GitHub 上那个仓库的数据查一下');
  assert.equal(nowLayerOf(heavy).includes('本任务相关资产'), false, '任务卡上不再有那一行');
});

test('④ 附带：手动唤醒的标题口径没变（空输入仍然是"（空消息）"）', () => {
  assert.equal(wakeTitle(evt('wake/manual', { note: '看一眼日志' })), '看一眼日志');
  assert.equal(wakeTitle(evt('wake/manual', { note: '看看这个\n第二行' })), '看看这个 第二行');
  assert.equal(wakeTitle(evt('wake/manual', { note: '   ' })), '（空消息）');
});

// ──────────── ⑤ 界面预览与运行期同源（同一处口径 ⇒ 同一串字节） ────────────

test('⑤ 界面预览的标题与运行期同一个口径：都出自 wakeTitle，不会一边人话一边包裹', async (t) => {
  const rig = await makeRealWakeRig({
    // 渠道那一拍只有注入判定那一次 light（v45 起挑资产那一次没有了）
    generate: [{ outputItems: [{ type: 'message', text: NO_RISK }] }],
    stream: [{ text: '', toolCalls: [] }],
  });
  t.after(rig.dispose);
  writeAssets(rig, ONE_ASSET);

  const wake = rig.append('wake/channel', {
    channel: 'qq-official', chatType: 'c2c', person: 'E7FEC35E951B5CCF8BA66793BF6B1314',
    chatId: 'E7FEC35E951B5CCF8BA66793BF6B1314', text: HUMAN_SENTENCE,
    messageId: LONG_MESSAGE_ID, msgSeq: 1, dedupeKey: LONG_MESSAGE_ID,
  });
  await rig.tick();

  // 界面的预览（`buildReplay`）与 CLI 的重建都走 `deriveRequest` → `wakeTitle` 那一处口径；
  // 这里比的是**两串真实字节**——两处只要有一处另写口径，这一条就会红。
  const live = cardTitleOf(rig.requests[1]!.request);
  assert.equal(clipTaskTitle(wakeTitle(wake)), live, '预览侧与运行期侧必须是同一串字节');
  assert.equal(live, HUMAN_SENTENCE);
  assert.equal(
    cardTitleOf(await previewRequestOf(rig, 1, 1)),
    live,
    '界面预览那一侧的任务卡标题与运行期逐字节相同',
  );
});

// ──────────── ⑥ 提及那一轮：三条渲染路径的标题逐字节相同 ────────────

test('⑥ 提及那一轮：任务卡标题在运行期与界面预览里**逐字节相同**，且是那句通知（不是正文）', async (t) => {
  const rig = await makeRealWakeRig({
    // 群里被 @ 的那一轮只会跑注入判定那一次 light（没有资产清单，不挑资产）
    generate: [{ outputItems: [{ type: 'message', text: NO_RISK }] }],
    stream: [{ text: '', toolCalls: [] }],
  });
  t.after(rig.dispose);

  const BODY = '弥亚小姐不会在偷偷看吧';
  rig.append('wake/channel', {
    channel: 'qq-official', chatType: 'group', chatId: 'G001', person: 'OPENID-C',
    text: BODY, messageId: 'msg-mention-1', msgSeq: 1, mentionsMe: true,
  });
  await rig.tick();

  const heavy = rig.requests.find(item => item.lane === 'heavy');
  assert.ok(heavy !== undefined, '她那一拍该发一次请求（否则下面比的是空）');
  const live = cardTitleOf(heavy.request);
  assert.ok(live.includes('提到了你'), `提及那一轮的标题是那句通知：${live}`);
  assert.equal(live.includes(BODY), false, 'v28：正文不进她的上下文——标题里也不行');
  // **盖章那两小段必须在**：它们是她真正看到的那句通知的一部分。收敛之前，运行期的任务卡标题
  // 用的是没盖章的 contact，正好缺这两段（同一个东西两个说法）；这条断言就是钉它的。
  assert.ok(live.includes('这一条你还没看过'), `标题取的是盖章版通知：${live}`);

  const preview = cardTitleOf(await previewRequestOf(rig, 1, 1));
  assert.ok(preview !== '', '预览的任务卡标题必须存在（否则这条断言什么也没锁）');
  assert.equal(preview, live, `运行期与界面预览的任务卡标题必须逐字节相同：\n预览=${preview}\n当时=${live}`);
  assert.equal(preview.includes(BODY), false, '预览里同样不许出现正文原文');
});

// ──────── ⑦ 提及那一轮：Wake 钩子的入参 == 本轮新输入那串字节 ────────

test('⑦ 提及那一轮：Wake 钩子的入参与本轮新输入**逐字节相同**（钩子看到的就是她看到的那句）', async (t) => {
  // 钩子把 stdin 里那份上下文的 `wake.text` **原样落到盘上**——那就是"钩子入参"的逐字真相，
  // 不经过请求体、也不经过任何裁剪（比"从请求里反推"硬：不依赖 softHint 通道的长度上限）。
  const box = mkdtempSync(join(tmpdir(), 'irmia-wake-hook-seen-'));
  const seenFile = join(box, 'seen.txt');
  const script = join(box, 'echo-wake-text.mjs');
  writeFileSync(script, [
    "import { writeFileSync } from 'node:fs';",
    "let raw = '';",
    "process.stdin.on('data', (chunk) => { raw += chunk; });",
    "process.stdin.on('end', () => {",
    "  const payload = JSON.parse(raw);",
    "  writeFileSync(process.argv[2], String(payload.wake.text), 'utf8');",
    "  process.stdout.write('{}');",
    "  process.exit(0);",
    "});",
    '',
  ].join('\n'), 'utf8');
  t.after(() => rmSync(box, { recursive: true, force: true, maxRetries: 5 }));

  // 真钩子、真 spawn：脚本真的跑起来、真的读一次 stdin（`spawn` 不传 = 默认那条 shell 路）
  const hooks = new HookRunner({
    entries: [{
      hook: 'Wake',
      matcher: 'channel',
      command: `node "${script}" "${seenFile}"`,
      timeoutMs: 8_000,
    }],
    now: () => new Date(RIG_NOW),
  });

  const rig = await makeRealWakeRig({
    generate: [{ outputItems: [{ type: 'message', text: NO_RISK }] }],
    stream: [{ text: '', toolCalls: [] }],
    hooks,
  });
  t.after(rig.dispose);

  const BODY = '弥亚小姐不会在偷偷看吧';
  rig.append('wake/channel', {
    channel: 'qq-official', chatType: 'group', chatId: 'G001', person: 'OPENID-C',
    text: BODY, messageId: 'msg-mention-hook', msgSeq: 1, mentionsMe: true,
  });
  await rig.tick();

  // ① 钩子真的跑了，而且它拿到的是**盖章版**通知——这正是这次收敛修掉的那半句
  //    （收敛前钩子入参用的是没盖章的 contact，正好少这两小段）。
  const seen = readFileSync(seenFile, 'utf8');
  assert.ok(seen.includes('提到了你'), `钩子入参该是那句通知：${seen}`);
  assert.ok(seen.includes('这一条你还没看过'), `钩子入参该是盖章版通知：${seen}`);
  assert.equal(seen.includes(BODY), false, 'v28：正文不进她的上下文——钩子入参里也不行');

  // ② **逐字节相同**：钩子入参 == 请求体里"本轮新输入"那一格。
  //    按段头认层（此刻层里那份是**裁过的标题**，不是这一格），不按索引认。
  const heavy = rig.requests.find(item => item.lane === 'heavy');
  assert.ok(heavy !== undefined, '她那一拍该发一次请求');
  const items = Array.isArray(heavy.request.input) ? heavy.request.input : [];
  const newInput = items
    .map(item => String((item as { content?: unknown }).content ?? ''))
    .find(content => !content.includes(NOW_LAYER_BANNER) && content.includes('提到了你')) ?? '';
  assert.ok(newInput !== '', `请求体里该有"本轮新输入"那一格：${JSON.stringify(heavy.request.input).slice(0, 300)}`);
  assert.equal(seen, newInput, `钩子入参与本轮新输入必须逐字节相同：\n钩子=${JSON.stringify(seen)}\n请求=${JSON.stringify(newInput)}`);
});
