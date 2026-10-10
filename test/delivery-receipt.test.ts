/**
 * 出站回执要能当判据用（2026-10-08 用户的口径）
 * ——src/tools/admin.ts 的 `speak` / `report` 两条路
 *
 * 用户原话：「**speak 和 report 工具发送成功的回执应该明确，成功投递，不必重复发送**」
 * 「**失败/被拒 ⇒ 明说不必重试或说明为什么可以重试**」。她**是靠这段文字决定要不要再发的**，
 * 所以回执不能只有一个"ok"——三件事必须同时在：
 *   ① **投递到了哪里**（哪个会话 / 只到了本机）；
 *   ② **"不必重复发送"这几个字**（成功那一侧；失败那一侧**不许**出现，且要给"还要不要试"的判断）；
 *   ③ **送出的是哪一句**（可核对的锚点——引的是**实际出站的字节**）。
 *
 * 走**真链路**：真 EventLog + 真 RealLoop 的读取口 + 真 `speak` / `report` / `read_channel`，
 * 替身只有回投那一跳（假 poster）与模型通道。锚点这件事只有在真链路上才验得了——
 * 回执引的那句话与 `read_channel` 里 `（我）` 那一行必须是**同一份字节**。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { defaultVisibility, type AppEvent } from '../src/log/types.ts';
import { fold, applyOne } from '../src/state/fold.ts';
import { RealLoop } from '../src/runtime/real-loop.ts';
import {
  createAdminTools,
  deliveredToSid,
  SENT_CREDENTIAL_NOTE,
  setSleepForTest,
  type ReplyOutcome,
} from '../src/tools/admin.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolHandlerResult } from '../src/tools/types.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';

const TZ = 'Asia/Shanghai';
const SID = 'qq:group:G1';

const PERSONA: PersonaAssets = {
  identity: 'IDENTITY',
  constitution: 'CONSTITUTION',
  style: 'STYLE',
  state: 'STATE',
  relationship: null,
  personaHash: 'test-hash',
  isSeed: false,
} as unknown as PersonaAssets;

/** 模型替身：这一份用例一次模型调用都不该发生（真调了就是设计跑偏） */
function fakeDs(): DsClient {
  return {
    modelFor: (): string => 'fake',
    generate: async (): Promise<never> => { throw new Error('这一份用例不该调模型'); },
    stream: async (): Promise<never> => { throw new Error('这一份用例不该调模型'); },
  } as unknown as DsClient;
}

interface ReceiptRig {
  log: EventLog;
  /** 假回投真的收到的那几段（出站字节） */
  posted: string[];
  /** 往真日志里落一条外部消息（`read_channel` 的"这个会话里有话"要有它） */
  write: (type: string, data: unknown) => void;
  speak: (args: Record<string, unknown>) => Promise<ToolHandlerResult>;
  report: (args: Record<string, unknown>) => Promise<ToolHandlerResult>;
  read: (sid: string, limit?: number) => Promise<ToolHandlerResult>;
  /** 日志里带会话坐标的投递凭据（`deliveredToSid` 认得的那几条） */
  credentials: () => Promise<Array<Record<string, unknown>>>;
}

/**
 * 真链路测试台。
 *
 * `outcome` 决定回投那一跳成不成（唯一替身）；`session: null` = 这一轮没有可回投的会话
 * （本机那一拍）。事件走**与 main.ts 同一个写入口**（落库 + 当场折进投影），
 * 于是"凭据在不在"这件事是从真日志里读回来的。
 */
async function makeRig(
  t: TestContext,
  options: { outcome: ReplyOutcome; session?: string | null },
): Promise<ReceiptRig> {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-receipt-'));
  const log = await EventLog.open(join(dir, 'events'));
  const projection = fold([]);
  const now = (): Date => new Date('2026-10-08T15:00:00.000+08:00');
  const session = options.session === undefined ? SID : options.session;
  const posted: string[] = [];
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
  t.after(() => {
    real.stop();
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const emit = (type: string, data: unknown): void => {
    const event = {
      seq: log.nextSeq(),
      ts: now().toISOString(),
      type,
      data,
      visibility: defaultVisibility(type),
      origin: 'test/delivery-receipt',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    applyOne(projection, event);
  };
  const tk = createAdminTools({
    timers: new TimerStore(null),
    emit: emit as never,
    // 打字节奏关掉：这一份测的是回执文案与凭据，不该真等（真等也只是白花时间）
    speakTyping: { typingEffect: false, charsPerMinute: 90 },
    ...(session === null
      ? {}
      : { replyTargetOf: () => ({ url: session, idempotencyKey: 'turn-7' }) }),
    replyPoster: {
      post: async (_target, text) => {
        posted.push(text);
        return options.outcome;
      },
    },
    // 读取口接真 RealLoop：凭据读不读得回来，只有那条路答得了
    channelReader: async (sid, limit, before) => await real.readChannelMessages(sid, limit, before),
    channelSpokenReader: async (sid) => await real.readChannelSpoken(sid),
    timezone: TZ,
  });
  const ctx = {
    callId: 'call_send', turn: 7, step: 1,
    signal: new AbortController().signal, workspaceRoot: dir,
  };
  return {
    log,
    posted,
    write: emit,
    speak: async (args) => await tk.byName('speak').handler(args, ctx),
    report: async (args) => await tk.byName('report').handler(args, ctx),
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
  };
}

function useNoSleep(t: TestContext): void {
  setSleepForTest(async () => {});
  t.after(() => { setSleepForTest(null); });
}

// ──────────────────────────────── ① speak：成功 ────────────────────────────────

test('speak 成功：回执说清"到了哪个会话、送出的是哪一句"，并逐字给出"不必重复发送"', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, { outcome: { ok: true, status: 200 } });
  // 会话里先得有过话，`read_channel` 才不会先撞"这个会话里没有取到消息"那条早退
  rig.write('channel/message', {
    channel: 'qq-official', chatType: 'group', person: 'OPENID_A', chatId: 'G1',
    text: '结果出来了吗', messageId: 'm1', msgSeq: 1,
  });
  const out = await rig.speak({ text: '长任务跑完了，共 42 个文件' });
  assert.equal(out.isError, undefined, out.content);

  // ① 投递到哪里：既有那一行照旧（会话坐标），并且与假回投真的收到的目标同一个
  assert.match(out.content, /已发往|投递：已送达/u, out.content);
  assert.match(out.content, /qq:group:G1/u, `回执要点明会话坐标：\n${out.content}`);
  // ② 用户点名的那四个字（逐字）
  assert.ok(out.content.includes('不必重复发送'), `成功回执必须逐字给出这四个字：\n${out.content}`);
  assert.ok(out.content.includes(SENT_CREDENTIAL_NOTE),
    `与 report 共用的那一句必须原样在（判据只有一处）：\n${out.content}`);
  // ③ 送出的是哪一句：锚点引的是**实际出站的字节**（切分之后的那些段拼起来）
  assert.equal(rig.posted.length, 2, '这一段被切成两条气泡发出去（逗号处断开）');
  const outbound = rig.posted.join('');
  assert.equal(outbound, '长任务跑完了共 42 个文件', '出站字节 = 逗号摘掉后的两段拼起来');
  assert.ok(out.content.includes(`「${outbound}」`),
    `锚点要引实际出站的那一串（可核对）：\n${out.content}`);
  assert.match(out.content, /送出的就是这一句（可核对）/u, out.content);

  // 凭据是真的：真日志里有一条带 sid + text 的 speak/sent，且 read_channel 里读得到同一份字节
  const credentials = await rig.credentials();
  assert.equal(credentials.length, 1, '成功投递 ⇒ 恰好一条带会话坐标的凭据');
  assert.equal(credentials[0]?.['sid'], SID);
  assert.equal(credentials[0]?.['text'], outbound, '凭据里的正文与出站字节逐字相同');
  const view = await rig.read(SID, 10);
  const mineRow = view.content.split('\n').find((line) => line.includes('（我）'));
  assert.ok(mineRow !== undefined && mineRow.includes(outbound),
    `锚点指向的那一行真的读得回来（她据它核对）：\n${view.content}`);
});

// ──────────────────────────────── ② speak：失败 ────────────────────────────────

test('speak 失败：**不许**出现"不必重复发送"，要说清失败、原因、以及"还要不要试"', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, { outcome: { ok: false, reason: 'HTTP 400 code=40034105 主动消息失败, 无权限' } });
  const out = await rig.speak({ text: '在的' });
  assert.equal(out.isError, undefined, `失败是投递事实，不是参数错：${out.content}`);

  assert.equal(out.content.includes('不必重复发送'), false,
    `没发出去就不许给她"已送达"的判据：\n${out.content}`);
  assert.equal(out.content.includes(SENT_CREDENTIAL_NOTE), false, '凭据那一句整句都不该在');
  assert.match(out.content, /失败/u, out.content);
  assert.match(out.content, /40034105|无权限/u, '原因要如实写出来（她据此换个方式）');
  assert.match(out.content, /不必重试/u, `权限类要明说"不必重试"：\n${out.content}`);
  // 对话流那一份照旧在（那不代表外面收到了）
  assert.match(out.content, /日志\/前端/u, out.content);
  assert.deepEqual(await rig.credentials(), [], '失败 ⇒ 一条带会话坐标的凭据都不许落');
});

test('speak 失败（网络类）：说清"可以稍后再试"——与权限类分得开', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, { outcome: { ok: false, reason: 'ETIMEDOUT' } });
  const out = await rig.speak({ text: '在的' });
  assert.match(out.content, /可稍后再试/u, `网络类要给出"可以再试"的判断：\n${out.content}`);
  assert.equal(out.content.includes('不必重试'), false, '这一侧不许说成"不必重试"（那是另一种判断）');
  assert.equal(out.content.includes('不必重复发送'), false, out.content);
});

// ──────────────────────────────── ③ report：成功 / 失败（同款） ────────────────────────────────

test('report 成功：回执与 speak 同款（锚点 + 那句凭据），长文只引开头并说清全文多少字', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, { outcome: { ok: true, status: 200 } });
  rig.write('channel/message', {
    channel: 'qq-official', chatType: 'group', person: 'OPENID_A', chatId: 'G1',
    text: '报告跑得怎么样了', messageId: 'm1', msgSeq: 1,
  });
  const body = '# 进度\n\n- 42 个文件已处理\n- 剩下 3 个在排队';
  const out = await rig.report({ text: body, to: SID });
  assert.equal(out.isError, undefined, out.content);

  assert.ok(out.content.includes('不必重复发送'), `report 成功也要有这四个字：\n${out.content}`);
  assert.ok(out.content.includes(SENT_CREDENTIAL_NOTE), '与 speak 逐字共用同一句');
  assert.match(out.content, /送出的就是这一篇（可核对）/u, out.content);
  assert.ok(out.content.includes('42 个文件已处理'), `锚点要引到正文：\n${out.content}`);
  assert.equal(rig.posted.length, 1, 'report 整段一条，不切分');
  assert.equal(rig.posted[0], body, '出站的就是原文（逐字节）');

  // 长文：锚点截到 40 字并**如实说**全文多少字（她据此知道回执里只是一截）。
  // 那个数用**原文的中文计字**——与上面那条 `日志/前端：已记录 N 字` 是同一把尺，
  // 两处各算一次会出现 68/67 并存（`sentAnchorNote` 的注释里记着为什么刻意分开）。
  const long = `第 ${'长'.repeat(60)} 篇`;
  const longOut = await rig.report({ text: long, to: SID });
  assert.equal(longOut.isError, undefined, longOut.content);
  assert.match(longOut.content, /这里只引开头/u, `截了就要说清：\n${longOut.content}`);
  assert.match(longOut.content, new RegExp(`全文 ${long.length} 字`, 'u'),
    `锚点报的字数要与日志那一行同源（都是 ${long.length}）：\n${longOut.content}`);
  assert.equal(longOut.content.includes(long), false, '整篇不许抄进回执（回执进历史，那是每轮重发）');

  // 凭据读得回来（与 speak 同一折）
  const view = await rig.read(SID, 10);
  assert.ok(view.content.split('\n').some((line) => line.includes('（我）') && line.includes('42 个文件已处理')),
    `她 report 的那一篇要读得回来：\n${view.content}`);
});

test('report 失败：也确实给"还要不要试"的判断（这条以前只报原因）', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, { outcome: { ok: false, reason: '回投被拒：HTTP 403 主动消息无权限' } });
  const out = await rig.report({ text: '这一篇发不出去', to: SID });
  assert.equal(out.isError, undefined, out.content);
  assert.equal(out.content.includes('不必重复发送'), false, out.content);
  assert.match(out.content, /失败/u, out.content);
  assert.match(out.content, /403/u, out.content);
  assert.match(out.content, /不必重试/u, `失败要给出判断（与 speak 同源）：\n${out.content}`);
  assert.match(out.content, /不等于他收到了/u, '要点明"本机那一段不算送达"');
  assert.deepEqual(await rig.credentials(), [], '失败 ⇒ 不落凭据');
});

// ──────────────────────────────── ④ 没有可发的会话：不许含糊成"成功了" ────────────────────────────────

test('没有 IM 会话可发（speak 与 report 同一句）：只到了本机，且**不许**出现"不必重复发送"', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, { outcome: { ok: true, status: 200 }, session: null });
  const speakOut = await rig.speak({ text: '在的' });
  const reportOut = await rig.report({ text: '只在对话流里' });
  for (const [name, out] of [['speak', speakOut], ['report', reportOut]] as const) {
    assert.equal(out.isError, undefined, out.content);
    assert.match(out.content, /没有 IM 会话可发/u, `${name}：${out.content}`);
    assert.match(out.content, /对话流里了，人在界面能看见/u, `${name}：${out.content}`);
    assert.match(out.content, /不会看到这一篇/u, `${name} 要说清下一轮她会看到什么：${out.content}`);
    assert.match(out.content, /带 `to` 再发一次/u, `${name} 要给出去路：${out.content}`);
    assert.equal(out.content.includes('不必重复发送'), false,
      `${name}：本机那一份不是"投递成功到会话"，不许给她不必再发的判据：\n${out.content}`);
  }
  assert.deepEqual(rig.posted, [], '没有会话坐标 ⇒ 一次回投都不该发生');
  assert.deepEqual(await rig.credentials(), [], '没有坐标就没有凭据（本机那条不代表到了那边）');
});
