/**
 * `speak/sent` 带上 `messageId` —— 让 `read_channel` 的 `（我）`那一行认得平台上的那条消息
 * （2026-10-12）
 *
 * 这件事只有一个目的：**她删得掉"自己刚发的那条"**。原先做不到，因为那个 id 在适配器里
 * 就被窄化丢掉了（`onebot.ts` 的 `createOneBotReplyPoster` 只回 `{ok, status}`），
 * 于是 `speak/sent` 里没有它、`（我）`那一行也就永远拿不到它。一手凭据是事件 77386
 * （T1308/S1）她自己写下的话：
 *
 *   > 「…`"messageId":"1739441710","msgSeq":2485`。**而我发出去的消息——speak/sent 事件里
 *   > 没有 messageId。**」
 *
 * 这一条链**跨五层**，任何一层断了这件事就静默地不成立（而"静默"正是它上一次出问题的
 * 方式），所以这里走**真链路**（真 `EventLog` + 真 `RealLoop` 的读取口 + 真 `speak` 与
 * `read_channel`），只有回投那一跳是替身。
 *
 * 钉四件事：
 *   ① 回投那一跳回来的 id 真的落进 `speak/sent`（而且一次发言只记**一个**：第一条）；
 *   ② 它真的透到 `read_channel` 的 `（我）`那一行（行尾 `·m<id>`）；
 *   ③ **反向**：回投不给 id 时那一格**整个缺席**，照旧读得出来（旧日志/旧通道的形状）；
 *   ④ **反向**：官方门那一行**不印** `·m`——它的 id 没有可操作路径（本仓没有官方门撤回），
 *      而这一条正是"按通道开关"这个判据的反面对照。
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { defaultVisibility, type AppEvent } from '../src/log/types.ts';
import { fold, applyOne } from '../src/state/fold.ts';
import { RealLoop } from '../src/runtime/real-loop.ts';
import {
  MESSAGE_ID_MARK,
  createAdminTools,
  deliveredToSid,
  setSleepForTest,
  type ReplyOutcome,
} from '../src/tools/admin.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolHandlerResult } from '../src/tools/types.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const TZ = 'Asia/Shanghai';

const PERSONA: PersonaAssets = {
  identity: 'IDENTITY',
  constitution: 'CONSTITUTION',
  style: 'STYLE',
  state: 'STATE',
  relationship: null,
  personaHash: 'test-hash',
  isSeed: false,
} as unknown as PersonaAssets;

/** 模型替身：这一份用例一次模型调用都不该发生 */
function fakeDs(): DsClient {
  return {
    modelFor: (): string => 'fake',
    generate: async (): Promise<never> => { throw new Error('这一份用例不该调模型'); },
    stream: async (): Promise<never> => { throw new Error('这一份用例不该调模型'); },
  } as unknown as DsClient;
}

interface MsgIdRig {
  write: (type: string, data: unknown) => void;
  speak: (args: Record<string, unknown>) => Promise<ToolHandlerResult>;
  read: (sid: string, limit?: number) => Promise<ToolHandlerResult>;
  /** 日志里带会话坐标的投递凭据（`deliveredToSid` 认得的那几条） */
  credentials: () => Promise<Array<Record<string, unknown>>>;
  close: () => void;
}

/**
 * 真链路测试台。
 *
 * `outcomes` 是**逐段**的回投结局（回投那一跳是唯一替身）：一次 speak 会被切成 N 段，
 * 而平台给每段各回一个 id —— 这正是"一次发言 N 个 id、这一行只记一个"那条纪律的现场。
 */
async function makeRig(
  t: TestContext,
  options: {
    session: string;
    /** 第 index 段（从 0 起）的回投结局；用完之后一直用最后一项 */
    outcomes: readonly ReplyOutcome[];
    /** 会话里先放一条外部消息；`null` = 不放 */
    channel?: { channel: string; chatType: string; chatId: string; messageId: string } | null;
  },
): Promise<MsgIdRig> {
  const dir = tempDirSync('irmia-msgid-');
  const log = await EventLog.open(join(dir, 'events'));
  const projection = fold([]);
  const now = (): Date => new Date('2026-10-12T15:00:00.000+08:00');
  let posted = 0;
  const real = new RealLoop({
    log,
    dataDir: dir,
    projection,
    now,
    timezone: TZ,
    ds: fakeDs(),
    registry: new ToolRegistry(),
    persona: PERSONA,
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
      origin: 'test/read-channel-spoken-id',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    applyOne(projection, event);
  };
  // 会话里先有一条别人的话：`read_channel` 才走得到渲染那一层（否则先撞"没有取到消息"早退）
  if (options.channel !== null && options.channel !== undefined) {
    emit('channel/message', {
      channel: options.channel.channel,
      chatType: options.channel.chatType,
      person: 'OPENID_A',
      chatId: options.channel.chatId,
      text: '你刚才说什么',
      messageId: options.channel.messageId,
      msgSeq: 1,
    });
  }
  const tk = createAdminTools({
    timers: new TimerStore(null),
    emit: emit as never,
    speakTyping: { typingEffect: false, charsPerMinute: 90 },
    replyTargetOf: () => ({ url: options.session, idempotencyKey: 'turn-7' }),
    replyPoster: {
      post: async (): Promise<ReplyOutcome> => {
        const outcome = options.outcomes[Math.min(posted, options.outcomes.length - 1)]!;
        posted += 1;
        return outcome;
      },
    },
    channelReader: async (sid, limit, before) => await real.readChannelMessages(sid, limit, before),
    channelSpokenReader: async (sid) => await real.readChannelSpoken(sid),
    timezone: TZ,
  });
  const ctx = {
    callId: 'call_send', turn: 7, step: 1,
    signal: new AbortController().signal, workspaceRoot: dir,
  };
  t.after(() => { real.stop(); log.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    write: emit,
    speak: async (args) => await tk.byName('speak').handler(args, ctx),
    read: async (sid, limit = 10) => await tk.byName('read_channel').handler({ sid, limit }, ctx),
    credentials: async () => {
      log.flush();
      const out: Array<Record<string, unknown>> = [];
      for await (const event of log.readAll()) {
        if (event.type !== 'speak/sent') continue;
        if (deliveredToSid(event.data as Record<string, unknown>) !== null) {
          out.push(event.data as Record<string, unknown>);
        }
      }
      return out;
    },
    close: () => { real.stop(); log.close(); },
  };
}

function useNoSleep(t: TestContext): void {
  setSleepForTest(async () => {});
  t.after(() => { setSleepForTest(null); });
}

// ──────────────────────────────── ① 正向：id 一路透到那一行 ────────────────────────────────

test('OneBot：回投回来的 id 落进 speak/sent，`（我）`那一行行尾就带 `·m<id>`', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, {
    session: 'onebot:group:G1',
    // 这一段会被切成 2 条气泡（逗号处断开）⇒ 平台各回一个 id。这一屏只该出现**第一个**。
    outcomes: [
      { ok: true, status: 200, messageId: '-1283734959' },
      { ok: true, status: 200, messageId: '-1697618325' },
    ],
    channel: { channel: 'onebot', chatType: 'group', chatId: 'G1', messageId: '1739441710' },
  });

  const out = await rig.speak({ text: '长任务跑完了，共 42 个文件' });
  assert.equal(out.isError, undefined, out.content);

  // ① 凭据里真的有它（这是原先缺掉的那一格）
  const credentials = await rig.credentials();
  assert.equal(credentials.length, 1, '一次发言一条"IM 那一路走通了"的凭据');
  assert.equal(credentials[0]?.['messageId'], '-1283734959',
    '记的是**第一条**气泡的 id（一行只有一个行尾位置，锚落在她开口的第一条上）');

  // ② 真读回来：`（我）`那一行带着它
  const view = await rig.read('onebot:group:G1', 10);
  assert.equal(view.isError, undefined, view.content);
  const mineRow = view.content.split('\n').find((line) => line.includes('（我）'));
  assert.ok(mineRow !== undefined, `她的那一行要在：\n${view.content}`);
  assert.match(mineRow!, /·m-1283734959\s*$/u,
    `行尾要带 \`·m<第一条的 id>\`（她据此撤掉自己刚发的那条）：\n${view.content}`);
  // 别人的那一行也带（同一屏、同一形态）
  assert.match(view.content, /你刚才说什么·m1739441710/u,
    `别人的行照旧带 id（\`·m\` 与正文紧贴）：\n${view.content}`);
  // 说明那一句整屏一次，且把"你自己发的也在内"说清
  assert.equal(view.content.split('平台消息 id').length - 1, 1, '那句说明整屏只出现一次');
  assert.ok(view.content.includes('和你自己发的都在内'),
    `说明要涵盖她自己的行（否则她会以为那一格只对别人的话有意义）：\n${view.content}`);
});

// ──────────────────────────────── ② 反向：给不出 id 时照旧 ────────────────────────────────

test('**反向**：回投不给 id ⇒ 那一格整个缺席，`（我）`那一行照旧读得出来', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, {
    session: 'onebot:group:G1',
    // 旧通道 / 协议端不回 id：`SendOutcome.messageId` 是空串 ⇒ 通道层就不带这一格
    outcomes: [{ ok: true, status: 200 }],
    channel: { channel: 'onebot', chatType: 'group', chatId: 'G1', messageId: '1739441710' },
  });
  await rig.speak({ text: '在的' });

  const credentials = await rig.credentials();
  assert.equal(credentials.length, 1, '话照样发出去了，凭据照样有');
  assert.equal('messageId' in (credentials[0] ?? {}), false,
    '给不出 id 就**整个键缺席**（不是 `messageId: undefined`、更不是空串）');

  const view = await rig.read('onebot:group:G1', 10);
  const mineRow = view.content.split('\n').find((line) => line.includes('（我）'));
  assert.ok(mineRow !== undefined && mineRow.includes('在的'),
    `旧形状照旧读得出来（少一格而已）：\n${view.content}`);
  assert.equal(mineRow!.includes(MESSAGE_ID_MARK), false,
    `她的行尾不许留一个孤零零的 sigil：\n${view.content}`);
  // 别人的那一行仍然带（这一条不是"把整屏关掉"）
  assert.match(view.content, /你刚才说什么·m1739441710/u, `别人的行不受影响：\n${view.content}`);
});

// ──────────────────────────────── ③ 反面对照：官方门不印 ────────────────────────────────

test('**反向**：官方门那一行不印 `·m`（id 不可操作 ⇒ 印了是纯开销）', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, {
    session: 'qq:group:A1B2C3',
    // 官方门也把 id 带回来了（`SendOutcome.messageId` 一直有）——**记下来**，但不印
    outcomes: [{
      ok: true,
      status: 200,
      messageId: 'ROBOT1.0_YdytPHtQblDR7wktdBM-ejPElZkxNa4hYly4FMJFnQG0xUaafwmchbNxooxr14Uc5YtDoub8-rQNkmGkvKf7nb3ngGb.Wl-sLP-ZQpRmBmM!',
    }],
    channel: { channel: 'qq-official', chatType: 'group', chatId: 'A1B2C3', messageId: 'm-official-1' },
  });
  await rig.speak({ text: '在的' });

  // **记下来**是对的（日志只增不改：今天没有撤回路径，不等于将来也没有）
  const credentials = await rig.credentials();
  assert.equal(credentials[0]?.['messageId']?.toString().startsWith('ROBOT1.0_'), true,
    '官方门的 id 照样要落进凭据（可操作路径将来可能长出来，而日志推不回去）');

  // **但不印**：这一屏一个 `·m` 都不该有，那串 117~137 字符的 token 一个字节都不该进上下文
  const view = await rig.read('qq:group:A1B2C3', 10);
  assert.ok(view.content.includes('在的'), `正文照旧：\n${view.content}`);
  assert.equal(view.content.includes(MESSAGE_ID_MARK), false,
    `官方门不许印 \`·m\`：\n${view.content}`);
  assert.equal(view.content.includes('ROBOT1.0_'), false,
    `那串 token 不该进这一屏：\n${view.content}`);
  assert.equal(view.content.includes('平台消息 id'), false,
    `没印 id 的一屏不该出现那句说明：\n${view.content}`);
});
