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

// ──────────────────────────────── ① speak：成功 ────────────────────────────────

test('speak 成功（正文 ≤25 字）：回执就四个字 `发送成功`，别的一概不印', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, { outcome: { ok: true, status: 200 } });
  // 会话里先得有过话，`read_channel` 才不会先撞"这个会话里没有取到消息"那条早退
  rig.write('channel/message', {
    channel: 'qq-official', chatType: 'group', person: 'OPENID_A', chatId: 'G1',
    text: '结果出来了吗', messageId: 'm1', msgSeq: 1,
  });
  const said = '长任务跑完了，共 42 个文件';
  assert.ok([...said].length <= SPEAK_TEXT_SUGGESTED_MAX, '夹具前提：正文 ≤25 字');
  const out = await rig.speak({ text: said });
  assert.equal(out.isError, undefined, out.content);

  /**
   * v74（用户 2026-10-20 的**最终口径**）：成功回执按**她发出去的正文长度**分两态，
   * 除此之外**一个多余字都不印**——不印坐标、不回显正文、不印"不必重复发送"、
   * 成功时不印"主动推送：跳过"。这里钉的是"≤25 字"那一态：逐字 `发送成功`。
   */
  const lines = out.content.split('\n').filter(line => line !== '');
  assert.deepEqual(lines, ['- 发送成功'], `成功回执逐字就是这一行：\n${out.content}`);
  assert.ok([...out.content.trim()].length <= 25, `整条回执 ≤25 字符（runes）：${[...out.content].length}`);
  // ③ 送出的是哪一句：锚点引的是**实际出站的字节**（切分之后的那些段拼起来）
  assert.equal(rig.posted.length, 2, '这一段被切成两条气泡发出去（逗号处断开）');
  const outbound = rig.posted.join('');
  assert.equal(outbound, '长任务跑完了共 42 个文件', '出站字节 = 逗号摘掉后的两段拼起来');

  // 凭据是真的：真日志里有一条带 sid + text 的 speak/sent，且 read_channel 里读得到同一份字节
  const credentials = await rig.credentials();
  assert.equal(credentials.length, 1, '成功投递 ⇒ 恰好一条带会话坐标的凭据');
  assert.equal(credentials[0]?.['sid'], SID);
  assert.equal(credentials[0]?.['text'], outbound, '凭据里的正文与出站字节逐字相同');
  const view = await rig.read(SID, 10);
  const mineRow = view.content.split('\n').find((line) => line.includes('（我）'));
  assert.ok(mineRow !== undefined && mineRow.includes(outbound),
    `原话在 read_channel 里读得回来（回执不再回显，但事实有去处）：\n${view.content}`);
});

test('speak 成功但正文 >25 字：`成功，但超25字限制（N 字）`（不是失败）；边界 25/26 分得开', async (t) => {
  useNoSleep(t);
  // 正好 25 字 ⇒ 仍是 `发送成功`
  const rig25 = await makeRig(t, { outcome: { ok: true, status: 200 } });
  const exact = '啊'.repeat(SPEAK_TEXT_SUGGESTED_MAX);
  assert.equal([...exact].length, 25);
  const out25 = await rig25.speak({ text: exact });
  assert.deepEqual(out25.content.split('\n').filter(line => line !== ''), ['- 发送成功'], out25.content);

  // 26 字 ⇒ 超限提示（正文两个字：中文一个字算 1，不是字节）
  const rig26 = await makeRig(t, { outcome: { ok: true, status: 200 } });
  const over = '啊'.repeat(SPEAK_TEXT_SUGGESTED_MAX + 1);
  const out26 = await rig26.speak({ text: over });
  assert.deepEqual(out26.content.split('\n').filter(line => line !== ''),
    ['- 成功，但超25字限制（26 字）'], out26.content);
  assert.equal(out26.content.includes('失败'), false, '超限不是失败');
  assert.equal(out26.content.includes('不必重复发送'), false, '成功那格不印判据（搬进描述）');
});

// ──────────────────────────────── ② speak：失败 ────────────────────────────────

test('speak 失败（权限类）：逐字 `失败，没有权限（平台拒绝），不必重试`——不印英文原文/栈', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, { outcome: { ok: false, reason: 'HTTP 400 code=40034105 主动消息失败, 无权限' } });
  const out = await rig.speak({ text: '在的' });
  assert.equal(out.isError, undefined, `失败是投递事实，不是参数错：${out.content}`);

  assert.deepEqual(out.content.split('\n').filter(line => line !== ''),
    ['- 失败，没有权限（平台拒绝），不必重试'], out.content);
  assert.equal(out.content.includes('不必重复发送'), false, '失败不许出现成功判据');
  assert.equal(out.content.includes('HTTP'), false, '不许印英文原文/内部细节');
  assert.equal(out.content.includes('40034105'), false, '不许印平台错误码');
  assert.deepEqual(await rig.credentials(), [], '失败 ⇒ 一条带会话坐标的凭据都不许落');
});

test('speak 失败（网络类）：`失败，网络或对端问题，可稍后再试`——与权限类分得开', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, { outcome: { ok: false, reason: 'ETIMEDOUT' } });
  const out = await rig.speak({ text: '在的' });
  assert.deepEqual(out.content.split('\n').filter(line => line !== ''),
    ['- 失败，网络或对端问题，可稍后再试'], out.content);
  assert.equal(out.content.includes('不必重试'), false, '这一侧不许说成"不必重试"（那是另一种判断）');
  assert.equal(out.content.includes('不必重复发送'), false, out.content);
});

test('speak 半路失败：`失败，已发出 1/2 条；<原因>`（一条信息一行，不复述流程）', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, {
    outcome: { ok: true, status: 200 },
    // 两段：第一段真发出去，第二段被拒 ⇒ 半路失败（sent=1 / total=2）
    outcomes: [
      { ok: true, status: 200 },
      { ok: false, reason: 'HTTP 400 code=40034105 主动消息失败, 无权限' },
    ],
  });
  const out = await rig.speak({ text: '长任务跑完了，共 42 个文件' });
  assert.equal(out.isError, undefined, out.content);

  assert.deepEqual(out.content.split('\n').filter(line => line !== ''),
    ['- 失败，已发出 1/2 条；没有权限（平台拒绝），不必重试'], out.content);
  assert.equal(out.content.includes('不必重复发送'), false, '半路失败也不许出现成功判据');
  assert.equal(out.content.includes('第 2 条起'), false, '不再复述流程账（v74 口径）');
  assert.equal(rig.posted.length, 2, '两段都试过（第一段成、第二段被拒）');
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

test('speak 的超 25 字线**没有被顺手改坏**：40 字（能成功的最长一句）仍是 `成功，但超25字限制（40 字）`', async (t) => {
  useNoSleep(t);
  // 25/26 的边界由上面那条 `speak >25 字` 用例钉着；这里补 40（`SPEAK_TEXT_MAX` 硬门）这一侧。
  /**
   * 40 字 ⇒ 仍旧是这条超限提示（不是失败、不是 `发送成功`）。
   *
   * ⚠ 验收里"speak 250 字 ⇒ 仍是 `成功，但超25字限制（250 字）`"在现口径下**不可能**：
   * speak 头上有 40 字**硬门**（2026-10-05 用户定的"超过直接拒绝、一个字不发"），
   * 250 字根本到不了成功那一支（下面第二段钉着它被拒的原话）。所以这条超 25 字线的
   * **成功区间只有 26–40 字**——要让它出现在 250 字上，得先动那道硬门，那是另一条口径。
   */
  const rig40 = await makeRig(t, { outcome: { ok: true, status: 200 } });
  const forty = '啊'.repeat(40);
  const out40 = await rig40.speak({ text: forty });
  assert.deepEqual(out40.content.split('\n').filter(line => line !== ''),
    ['- 成功，但超25字限制（40 字）'], out40.content);
  assert.equal(out40.content.includes('失败'), false, '超限不是失败');

  // 250 字：先被 40 字硬门退回（一个字不发），回执里**不出现**那条超限提示
  const rig250 = await makeRig(t, { outcome: { ok: true, status: 200 } });
  const out250 = await rig250.speak({ text: '啊'.repeat(250) });
  assert.equal(out250.isError, true, `250 字必须走硬门（不是成功回执）：${out250.content}`);
  assert.match(out250.content, /超过 speak 的上限（一次至多 40 字）/u, out250.content);
  assert.equal(out250.content.includes('成功，但超'), false, '没发出去就不许有"成功"字样');
  assert.equal(rig250.posted.length, 0, '硬门在进 speak 之前，一段都不发');
});

test('report 失败：与 speak 同一句 `失败，<原因>`（中文、能判断下一步）', async (t) => {
  useNoSleep(t);
  const rig = await makeRig(t, { outcome: { ok: false, reason: '回投被拒：HTTP 403 主动消息无权限' } });
  const out = await rig.report({ text: '这一篇发不出去', to: SID });
  assert.equal(out.isError, undefined, out.content);
  assert.deepEqual(out.content.split('\n').filter(line => line !== ''),
    ['- 失败，没有权限（平台拒绝），不必重试'], out.content);
  assert.equal(out.content.includes('不必重复发送'), false, out.content);
  assert.equal(out.content.includes('这一篇发不出去'), false, '失败不回显正文（回执进历史，逐轮重发）');
  assert.equal(out.content.includes('403'), false, '不印英文原文/内部码');
  assert.equal(/[0-9]/u.test(out.content), false, '失败那一行不数字数（长度不是 report 的判据）');
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
    // 2026-10-20（用户实测「这种不能继续缩吗」）：这一句从三段压成**一行**——
    // **三个信息点一个不少**，判据就是下面三处子串：
    //   ① 跳过 + 原因（本轮没有 IM 会话可发）
    //   ② 只在本机对话流、≠他收到（他那边一个字都没有）
    //   ③ 要发到那边就带 `to`
    assert.match(out.content, /投递：本轮没有 IM 会话可发（跳过）/u, `① 跳过与原因 —— ${name}：${out.content}`);
    assert.match(out.content, /只落在本机对话流，不等于他收到了/u,
      `② 只在本机、不等于他收到 —— ${name}：${out.content}`);
    assert.match(out.content, /要发到那边，带 `to` 再发一次/u, `③ 给出去路 —— ${name}：${out.content}`);
    // 压掉的两句是 ② 的另一面（"人在界面能看见" = 界面就是这条流；"下一轮看不到这一篇" =
    // 没到那边自然读不回来）：同一层意思不再说两遍——用户问的就是这个。
    assert.equal(out.content.includes('人在界面能看见'), false, `${name}：同一件事只留一句：\n${out.content}`);
    assert.equal(out.content.includes('不会看到这一篇'), false, `${name}：同一件事只留一句：\n${out.content}`);
    assert.equal(out.content.includes('不必重复发送'), false,
      `${name}：本机那一份不是"投递成功到会话"，不许给她不必再发的判据：\n${out.content}`);
  }
  assert.deepEqual(rig.posted, [], '没有会话坐标 ⇒ 一次回投都不该发生');
  assert.deepEqual(await rig.credentials(), [], '没有坐标就没有凭据（本机那条不代表到了那边）');
});
