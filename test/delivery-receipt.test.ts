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
import { rmSync } from 'node:fs';
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
  SPEAK_TEXT_SUGGESTED_MAX,
  type ReplyOutcome,
} from '../src/tools/admin.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolHandlerResult } from '../src/tools/types.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

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
  options: { outcome: ReplyOutcome; session?: string | null; outcomes?: ReplyOutcome[] },
): Promise<ReceiptRig> {
  const dir = tempDirSync('irmia-receipt-');
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
        // `outcomes` 逐段决定成败（半路失败那一路靠它）：第 n 次调用取第 n 项，缺项退回 `outcome`
        return options.outcomes?.[posted.length - 1] ?? options.outcome;
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

// ──────────────────────────────── ① speak：目标与成功回执 ────────────────────────────────

test('speak 成功：逐字 `已投递`，正文与投递凭据仍完整', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, { outcome: { ok: true, status: 200 } });
  rig.write('channel/message', {
    channel: 'qq-official', chatType: 'group', person: 'OPENID_A', chatId: 'G1',
    text: '结果出来了吗', messageId: 'm1', msgSeq: 1,
  });
  const said = '长任务跑完了，共 42 个文件';
  const out = await rig.speak({ to: SID, text: said });
  assert.equal(out.isError, undefined, out.content);
  assert.deepEqual(out.content.split('\n').filter(line => line !== ''), ['- 已投递'], out.content);

  assert.equal(rig.posted.length, 2, '这一段被切成两条气泡发出去（逗号处断开）');
  const outbound = rig.posted.join('');
  assert.equal(outbound, '长任务跑完了共 42 个文件');
  const credentials = await rig.credentials();
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0]?.['sid'], SID);
  assert.equal(credentials[0]?.['text'], outbound);
  const view = await rig.read(SID, 10);
  const mineRow = view.content.split('\n').find((line) => line.includes('（我）'));
  assert.ok(mineRow !== undefined && mineRow.includes(outbound), view.content);
});

test('speak 的 25/26 字边界不再产生软提醒：两侧都只回 `已投递`', async (t) => {
  useNoSleep(t);
  for (const length of [SPEAK_TEXT_SUGGESTED_MAX, SPEAK_TEXT_SUGGESTED_MAX + 1]) {
    const rig = await makeRig(t, { outcome: { ok: true, status: 200 } });
    const out = await rig.speak({ to: SID, text: '啊'.repeat(length) });
    assert.equal(out.isError, undefined, out.content);
    assert.deepEqual(out.content.split('\n').filter(line => line !== ''), ['- 已投递'], out.content);
    assert.doesNotMatch(out.content, /成功|失败|超25字|字限制/u);
  }
});

test('speak 缺少或留空 to：参数错误，且不写发言、不发网络、不落投递凭据', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, { outcome: { ok: true, status: 200 } });
  for (const args of [{ text: '在的' }, { text: '在的', to: '' }, { text: '在的', to: '  ' }]) {
    const out = await rig.speak(args);
    assert.equal(out.isError, true, out.content);
    assert.match(out.content, /to/u);
  }
  assert.deepEqual(rig.posted, []);
  assert.deepEqual(await rig.credentials(), []);
  const events = [];
  for await (const event of rig.log.readAll()) events.push(event);
  assert.equal(events.some(event => event.type === 'message/assistant' || event.type === 'speak/sent'), false);
});

// ──────────────────────────────── ② speak：未投递 ────────────────────────────────

test('speak 未投递（权限类）：`未投递，没有权限（平台拒绝），不必重试`', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, { outcome: { ok: false, reason: 'HTTP 400 code=40034105 主动消息失败, 无权限' } });
  const out = await rig.speak({ to: SID, text: '在的' });
  assert.equal(out.isError, undefined, out.content);
  assert.deepEqual(out.content.split('\n').filter(line => line !== ''),
    ['- 未投递，没有权限（平台拒绝），不必重试'], out.content);
  assert.doesNotMatch(out.content, /HTTP|40034105|不必重复发送/u);
  assert.deepEqual(await rig.credentials(), []);
});

test('speak 未投递（网络类）：`未投递，网络或对端问题，可稍后再试`', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, { outcome: { ok: false, reason: 'ETIMEDOUT' } });
  const out = await rig.speak({ to: SID, text: '在的' });
  assert.deepEqual(out.content.split('\n').filter(line => line !== ''),
    ['- 未投递，网络或对端问题，可稍后再试'], out.content);
  assert.doesNotMatch(out.content, /不必重试|不必重复发送/u);
});

test('speak 半路未投递：保留已发出的段数与中文原因', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, {
    outcome: { ok: true, status: 200 },
    outcomes: [
      { ok: true, status: 200 },
      { ok: false, reason: 'HTTP 400 code=40034105 主动消息失败, 无权限' },
    ],
  });
  const out = await rig.speak({ to: SID, text: '长任务跑完了，共 42 个文件' });
  assert.equal(out.isError, undefined, out.content);
  assert.deepEqual(out.content.split('\n').filter(line => line !== ''),
    ['- 未投递，已发出 1/2 条；没有权限（平台拒绝），不必重试'], out.content);
  assert.equal(rig.posted.length, 2);
});

// ──────────────────────────────── ③ report：成功 / 失败（同款） ────────────────────────────────

test('report 成功：回执**固定** `发送成功`——report 没有 25 字建议线（5 字与 1293 字一个样）', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, { outcome: { ok: true, status: 200 } });
  rig.write('channel/message', {
    channel: 'qq-official', chatType: 'group', person: 'OPENID_A', chatId: 'G1',
    text: '报告跑得怎么样了', messageId: 'm1', msgSeq: 1,
  });

  // ① 短正文（5 字）⇒ 逐字 `发送成功`
  const shortOut = await rig.report({ text: '进度如下', to: SID });
  assert.equal(shortOut.isError, undefined, shortOut.content);
  assert.deepEqual(shortOut.content.split('\n').filter(line => line !== ''), ['- 发送成功'], shortOut.content);

  /**
   * ② 长正文（**正好 1293 字**——用户 2026-10-21 截图实证的那个数）⇒ **仍然只有** `发送成功`。
   *
   * report 是发长文的那一件（desc 写着"不限长"、`REPORT_TEXT_MAX` 六万四）；25 字是 `speak` 的
   * **聊天风格目标**，只属于 speak。v74 那句"report 照 speak 一样"管的是**回执格式**
   * （短、不印坐标、不回显正文、不印"不必重复发送"），**不是数值也一样**。
   * 旧账：照搬两态时，1293 字的报告被回执判成"超25字限制"——这条回执会被后续每个请求读回，
   * 等于每轮都在告诉她"你的报告超限了"，是**假话**。
   */
  const head = '# 进度\n\n- 42 个文件已处理，剩下 3 个在排队。\n';
  const padUnit = '明细逐条核过，没有阻塞项。';
  const need = 1293 - [...head].length;
  const pad = padUnit.repeat(Math.ceil(need / [...padUnit].length)).slice(0, need);
  const longBody = head + pad;
  assert.equal([...longBody].length, 1293, '夹具必须正好 1293 字（runes）');
  const longOut = await rig.report({ text: longBody, to: SID });
  assert.equal(longOut.isError, undefined, longOut.content);
  assert.deepEqual(longOut.content.split('\n').filter(line => line !== ''),
    ['- 发送成功'], `1293 字的报告回执逐字也是这一行：\n${longOut.content}`);
  // `SPEAK_TEXT_SUGGESTED_MAX` 相关字样在这条回执里出现 **0 次**：数值、`超`、`字限制`、`字数`都不许有
  for (const ghost of ['超', '字限制', '字数', String(SPEAK_TEXT_SUGGESTED_MAX)]) {
    assert.equal(longOut.content.includes(ghost), false,
      `report 的回执不许出现「${ghost}」（那条线只属于 speak）：\n${longOut.content}`);
  }
  assert.equal(longOut.content.includes('不必重复发送'), false, '判据搬进 SELF_BRIEF/描述，不再每轮回执付');
  assert.equal(longOut.content.includes(SENT_CREDENTIAL_NOTE), false, '不再印整句凭据');
  assert.equal(longOut.content.includes('42 个文件已处理'), false, '整篇不许抄进回执（回执进历史，那是每轮重发）');

  // ③ 出站还是原文：两次 report 各一条、逐字节（长正文不截断、不改写）
  assert.equal(rig.posted.length, 2, 'report 整段一条，不切分');
  assert.equal(rig.posted[0], '进度如下', '短正文逐字节出站');
  assert.equal(rig.posted[1], longBody, '1293 字逐字节出站（report 本来就不限长）');

  // ④ 凭据读得回来（与 speak 同一折）：两篇都落了带会话坐标的凭据，正文在 `read_channel` 里读得到
  assert.equal((await rig.credentials()).length, 2, '两篇 report 各落一条"发出去过"的凭据');
  const view = await rig.read(SID, 10);
  assert.ok(view.content.split('\n').some((line) => line.includes('（我）') && line.includes('42 个文件已处理')),
    `她 report 的那一篇要读得回来：\n${view.content}`);
});

test('speak 40 字仍只回 `已投递`；250 字照旧撞硬门且一字不发', async (t) => {
  useNoSleep(t);
  const rig40 = await makeRig(t, { outcome: { ok: true, status: 200 } });
  const out40 = await rig40.speak({ to: SID, text: '啊'.repeat(40) });
  assert.deepEqual(out40.content.split('\n').filter(line => line !== ''), ['- 已投递'], out40.content);
  assert.doesNotMatch(out40.content, /成功|失败|字限制/u);

  const rig250 = await makeRig(t, { outcome: { ok: true, status: 200 } });
  const out250 = await rig250.speak({ to: SID, text: '啊'.repeat(250) });
  assert.equal(out250.isError, true, out250.content);
  assert.match(out250.content, /超过 speak 的上限（一次至多 40 字）/u);
  assert.doesNotMatch(out250.content, /成功，但超/u);
  assert.deepEqual(rig250.posted, []);
});

test('report 失败保持 `失败，<原因>`：中文、能判断下一步', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, { outcome: { ok: false, reason: '回投被拒：HTTP 403 主动消息无权限' } });
  const out = await rig.report({ text: '这一篇发不出去', to: SID });
  assert.equal(out.isError, undefined, out.content);
  assert.deepEqual(out.content.split('\n').filter(line => line !== ''),
    ['- 失败，没有权限（平台拒绝），不必重试'], out.content);
  assert.equal(out.content.includes('不必重复发送'), false);
  assert.equal(out.content.includes('这一篇发不出去'), false);
  assert.equal(out.content.includes('403'), false);
  assert.equal(/[0-9]/u.test(out.content), false);
  assert.deepEqual(await rig.credentials(), []);
});

// ──────────────────────────────── ④ report 同样强制目标 ────────────────────────────────

test('report 缺少或留空 to：参数错误，不写发言、不投递、不落凭据', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, { outcome: { ok: true, status: 200 }, session: null });
  for (const args of [{ text: '只在对话流里' }, { text: '只在对话流里', to: '' }, { text: '只在对话流里', to: '  ' }]) {
    const out = await rig.report(args);
    assert.equal(out.isError, true, out.content);
    assert.match(out.content, /to/u);
  }
  assert.deepEqual(rig.posted, []);
  assert.deepEqual(await rig.credentials(), []);
  const events = [];
  for await (const event of rig.log.readAll()) events.push(event);
  assert.equal(events.some(event => event.type === 'message/assistant' || event.type === 'speak/sent'), false);
});
