/**
 * 「**我做过**」—— `src/channel/self-action.ts` / `tools/mcp-entry.ts` / `tools/catalog.ts`
 * / `runtime/real-loop.ts` / `tools/admin.ts` 这一条链
 *
 * ──────────────────────────── 这条链治的病 ────────────────────────────
 *
 * 平台**不对机器人自己发起的动作发 notice**（`set_group_whole_ban` 那条实测回执甚至是
 * `data: null`）。于是"我设过全员禁言"在她那儿**一个字都不存在**：`read_channel` 只摆
 * 别人的话与群里的动静，她的动作两样都不是（诊断报告 §3.2 的原话：只能靠她自己记进
 * `MEMORIES/facts.md`）。
 *
 * ──────────────────────────── 六件事，缺一条这条能力就是错的 ────────────────────────────
 *
 *   ① **正**：一次真执行 ⇒ **恰好多一条** `channel/self-action`，且 `read_channel` 里多**那一行逐字**；
 *   ② **反**（查询类）：`get_*` 一件都不许记——查一眼群列表不是"做过一件事"；
 *   ③ **反**（被拦的）：destructive 门 / 名字核对拦下的调用**没有回执** ⇒ 0 条（没执行就没发生）；
 *   ④ **反**（归不到会话 / 不是群里的）：`delete_msg` / `send_like` / `set_group_add_request` ⇒ 0 条；
 *   ⑤ **失败如实**：回执体 `ok:false` 与 `status:'error'` 都记 `failed`，行里写 `（回执失败：…）`；
 *   ⑥ **不认识的动作只摆协议原名**（绝不编一个像样的中文动作名）。
 *
 * 用真 `EventLog` + 真 `RealLoop` + 真 `createMcpEntryTool` + 真 `read_channel`：这条链的价值
 * 就在"回执那一刻写下去的东西，她下一次翻会话时读得回来"——替身会把这层抹掉。
 * 唯一的假件是 **MCP client**（那台 server 是别人的进程）：回执的字节由用例逐字给，
 * 形状照实测的那一条（`data: null` 的成功回执与 `ok:false` 的业务失败回执）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { defaultVisibility, type AppEvent } from '../src/log/types.ts';
import { applyOne, fold } from '../src/state/fold.ts';
import { RealLoop } from '../src/runtime/real-loop.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import {
  actionRecordOf, recordSelfAction, selfActionLineText, type SelfActionReceipt,
} from '../src/channel/self-action.ts';
import { createMcpEntryTool } from '../src/tools/mcp-entry.ts';
import { createAdminTools, SELF_SPEAK_LABEL, type AdminEventEmitter } from '../src/tools/admin.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import type { McpToolInfo } from '../src/mcp/client.ts';
import type { ToolContext, ToolHandlerResult } from '../src/tools/types.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';

const TZ = 'Asia/Shanghai';
const PERSONA: PersonaAssets = {
  identity: 'IDENTITY', constitution: 'CONSTITUTION', style: 'STYLE', state: 'STATE',
  relationship: null, personaHash: 'test-hash', isSeed: false,
} as unknown as PersonaAssets;
const CTX: ToolContext = {
  callId: 'call_ban', turn: 1318, step: 3,
  signal: new AbortController().signal, workspaceRoot: process.cwd(),
};

const GROUP = '705463642';
const SID = `onebot:group:${GROUP}`;
const OTHER_SID = 'onebot:group:953245617';
const GROUP_NAME = 'I.R.M.I.A 内测群';

/** OneBot 成功回执的**真形状**（`set_group_whole_ban` 实测就是 `data: null`，报告 §3.2） */
const OK_RECEIPT = '{\n  "ok": true,\n  "action": "set_group_whole_ban",\n  "transport": "http",\n  "data": null\n}';
/** 业务失败：**协议层通了**（`status` 仍是 ok），只有回执体说没成 */
const BAD_RECEIPT = '{\n  "ok": false,\n  "action": "set_group_whole_ban",\n  "reason": "权限不足"\n}';

// ──────────────────────────────── 测试台 ────────────────────────────────

/**
 * 一个真链路的小台子：真日志 + 真循环 + 真 MCP 入口（假 client）+ 真 `read_channel`。
 *
 * 「我做过」的落库口接的是**生产那一份** `recordSelfAction`（`catalog.ts` 里逐字同一行），
 * 所以这里验的不是"照实现再写一遍"的影子。
 */
interface Bench {
  dir: string;
  log: EventLog;
  loop: RealLoop;
  /** 事件里那些 `channel/self-action`（她"做过"的） */
  actions: () => Array<Record<string, unknown>>;
  /** 装配好的 `mcp` 入口工具（回执走真链路） */
  entry: { handler: (args: unknown, ctx: ToolContext) => Promise<ToolHandlerResult> };
  /** `read_channel` 读回来的一屏（消息/动静都空，只摆她自己的动作） */
  read: (options?: { sid?: string; name?: string | null }) => Promise<string>;
  /**
   * **重建一个循环并等它预热完**（= 重启）：会话簿是 `warmUp` 从日志折出来的，运行期那一拍
   * 不重折它。要断言"这个群出现了/未读是 0"就得走重启那一条路——与 `restart-group-members`
   * 同一个成例（日志与投影共用，跨重启的东西重新折一遍）。`tickOnce` 会 await 预热。
   */
  afterRestart: () => Promise<RealLoop>;
  /** 送给 TearDown 的收尾 */
  teardown: () => void;
}

async function makeBench(t: TestContext, options: {
  /** MCP client 的回执（默认一条成功回执） */
  reply?: ToolHandlerResult;
  /** 危险动作开关（默认全开） */
  destructive?: () => unknown;
  /** 清单（默认只有那一件写工具） */
  tools?: McpToolInfo[];
  /** 清单来源报不报 `live`（名字核对那道闸生效的条件） */
  liveList?: boolean;
} = {}): Promise<Bench> {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-self-action-'));
  const log = await EventLog.open(join(dir, 'events'));
  const projection = fold([]);
  let stored: Array<Record<string, unknown>> = [];
  let at = Date.parse('2026-10-10T18:56:36.827Z');

  const append = (type: string, data: unknown): AppEvent => {
    const event = {
      seq: log.nextSeq(), ts: new Date(at).toISOString(), type, data,
      visibility: defaultVisibility(type), origin: 'test/self-action-receipt',
    } as unknown as AppEvent;
    at += 1000;
    log.append(event, { sync: true });
    applyOne(projection, event);
    return event;
  };

  const emit: AdminEventEmitter = (type, data, visibility) => { append(type, data); void visibility; };
  const tools = options.tools ?? [{ name: 'set_group_whole_ban', description: '开或关全员禁言' }];
  const entry = createMcpEntryTool({
    // 唯一的假件：那台 server 是别人的进程。清单与属性形状照真池给。
    client: {
      status: () => [{
        name: 'onebot11-mcp', ready: true, disabled: false, tools,
        starts: 1, consecutiveFailures: 0, backoffUntilMs: null, protocolErrors: 0,
      }],
      listTools: async (_server, listOptions) => {
        if (options.liveList !== false) listOptions?.onSource?.({ source: 'live' });
        return tools;
      },
      resolveAttributes: () => ({ sideEffect: 'destructive' }),
      callTool: async (): Promise<ToolHandlerResult> => options.reply ?? { content: OK_RECEIPT },
    },
    destructiveEnabled: options.destructive ?? (() => true),
    blobOffload: { dataDir: dir },
    // **生产那一条**：`catalog.ts` 里就是这一行
    onReceipt: (receipt) => { recordSelfAction(receipt, emit); },
  });

  const loop = new RealLoop({
    log, dataDir: dir, projection, now: () => new Date(at),
    timezone: TZ, ds: ({ modelFor: () => 'fake-model' }) as unknown as DsClient,
    registry: new ToolRegistry(), persona: PERSONA, config: defaultConfig(dir),
    out: () => {}, pollMs: 3_600_000,
  });
  const makeLoop = (): RealLoop => new RealLoop({
    log, dataDir: dir, projection, now: () => new Date(at),
    timezone: TZ, ds: ({ modelFor: () => 'fake-model' }) as unknown as DsClient,
    registry: new ToolRegistry(), persona: PERSONA, config: defaultConfig(dir),
    out: () => {}, pollMs: 3_600_000,
  });

  const teardown = (): void => { loop.stop(); log.close(); rmSync(dir, { recursive: true, force: true }); };
  t.after(teardown);

  return {
    dir, log, loop,
    teardown,
    afterRestart: async () => {
      const fresh = makeLoop();
      // `tickOnce` 会 await `warmUp`（那里才折会话簿）——不 await 的话读到的永远是空簿
      await fresh.tickOnce();
      return fresh;
    },
    actions: () => stored,
    entry: { handler: (args, ctx) => entry.handler(args, ctx) },
    read: async (readOptions = {}) => {
      // 读口全量扫日志（不需要会话簿），所以这里不依赖 tick——会话簿那一格单独用 afterRestart 验
      const acts = await loop.readChannelActions(readOptions.sid ?? SID, 20);
      stored = acts.map((item) => ({ ...item }) as Record<string, unknown>);
      const tk = createAdminTools({
        timers: new TimerStore(null), emit: () => {},
        // 这一屏**只有她的动作**：消息、动静、发言都空——正是"只做过事、没人说过话"的形状
        channelReader: async () => [],
        channelSpokenReader: async () => [],
        channelNoticeReader: async () => [],
        channelSelfActionReader: async (sid, limit, before) => await loop.readChannelActions(sid, limit, before),
        timezone: 'UTC',
        resolveChannelName: (sid) => (sid === SID ? (readOptions.name ?? GROUP_NAME) : null),
      });
      const out = await tk.byName('read_channel').handler({ sid: readOptions.sid ?? SID, limit: 20 }, CTX);
      return out.content;
    },
  };
}

/**
 * 一屏里那些"有内容"的行，**去掉行首的短时间**（滤掉框头、页脚与指路那句话）。
 *
 * 去掉时间是为了让断言盯着那一行的**逐字**：时间那一格由 `timezone` 决定，
 * 把它留在期望里只会让用例在换时区时红，而它不在这条能力的判据之内。
 */
function rowsOf(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => /^\d\d-\d\d \d\d:\d\d /u.test(line))
    .map((line) => line.replace(/^\d\d-\d\d \d\d:\d\d /u, ''));
}

/** 一次"全员禁言"的调用参数（真链路里她递的就是这个形状） */
const BAN_ARGS = { server: 'onebot11-mcp', tool: 'set_group_whole_ban', args: { group_id: Number(GROUP), enable: true } };

// ──────────────────────────────── ① 正：真回执 ⇒ 恰好多一条 + 那一行逐字 ────────────────────────────────

test('正：一次真执行 ⇒ 恰好多一条事件，read_channel 里多那一行逐字', async (t) => {
  const bench = await makeBench(t);
  const result = await bench.entry.handler(BAN_ARGS, CTX);
  assert.equal(result.isError, undefined, result.content);

  let events: AppEvent[] = [];
  for await (const event of bench.log.readAll()) events.push(event);
  const recorded = events.filter((event) => event.type === 'channel/self-action');
  assert.equal(recorded.length, 1, '**恰好多一条**（不多不少）');

  const data = recorded[0]!.data as Record<string, unknown>;
  assert.equal(data['sid'], SID, 'sid 由 group_id 算出来（她翻那个群时才对得上）');
  assert.equal(data['action'], 'set_group_whole_ban');
  assert.equal(data['server'], 'onebot11-mcp');
  assert.equal(data['receipt'], 'ok', '回执体说 ok ⇒ ok');
  assert.equal(data['turn'], 1318, 'turn 与 tool/call 同源（复盘用）');
  assert.equal(data['callId'], 'call_ban');
  assert.deepEqual(data['params'], { enable: true });
  assert.equal(recorded[0]!.visibility, 'internal', 'internal ⇒ 不进请求体、不唤醒、不计未读');
  // 落库走的就是宿主那条口（消费侧的原话：catalog 的 emit 与 admin 的 emit 是同一件事）
  assert.equal(defaultVisibility('channel/self-action'), 'internal');

  const text = await bench.read();
  assert.deepEqual(rowsOf(text),
    [`${SELF_SPEAK_LABEL}：[全员禁言 · 开启 · ${GROUP_NAME}]（回执 ok）`],
    `目标逐字：\n${text}`);
  // 与"她说过的话"同族但不混：行首同一个标记、动作在方括号里
  assert.match(text, /（我）：\[/u, '行首是（我）、动作在方括号里（自由文本那一族不带方括号）');
});

// ──────────────────────────────── ② 反：查询类一件都不许记 ────────────────────────────────

test('反：get_* 查询类 ⇒ 0 条（查一眼群列表不是"做过一件事"）', async (t) => {
  const tools: McpToolInfo[] = [
    { name: 'get_group_list', description: '群列表' },
    { name: 'get_login_info', description: '登录号' },
    { name: 'get_msg', description: '取一条消息' },
  ];
  const bench = await makeBench(t, { tools });
  for (const tool of ['get_group_list', 'get_login_info', 'get_msg']) {
    const args: Record<string, unknown> = tool === 'get_msg' ? { message_id: 555 } : { group_id: Number(GROUP) };
    const result = await bench.entry.handler({ server: 'onebot11-mcp', tool, args }, CTX);
    assert.equal(result.isError, undefined, result.content);
  }
  // 三条查询都真调了（回执都回来了），但**一条事件都不该有**
  let count = 0;
  for await (const event of bench.log.readAll()) if (event.type === 'channel/self-action') count += 1;
  assert.equal(count, 0, '查询类一件都不记');
  // 而且这一屏照旧说"没有新消息"（不许因为查询凭空长出内容）
  assert.match(await bench.read(), /没有新消息/u);
});

// ──────────────────────────────── ③ 反：被拦下的调用 ⇒ 0 条 ────────────────────────────────

test('反：destructive 门拦下的调用**没有回执** ⇒ 0 条（"没执行"就没有发生）', async (t) => {
  let called = 0;
  const bench = await makeBench(t, {
    destructive: () => false,
    reply: { content: OK_RECEIPT },
  });
  // 把 client 的调用计数换成可观测的（同一个假件的另一份装配）
  const bench2 = await makeBench(t, { destructive: () => false });
  const result = await bench2.entry.handler(BAN_ARGS, CTX);
  assert.equal(result.isError, true, '被拦下的调用如实报错');
  assert.match(result.content, /危险动作/u, result.content);
  void called;

  let count = 0;
  for await (const event of bench2.log.readAll()) if (event.type === 'channel/self-action') count += 1;
  assert.equal(count, 0, '**没有回执 ⇒ 一条事件都不写**（位置在函数最末尾，这是结构保证）');
  // 台账：被拦下时她连"没有新消息"都该照旧（不许凭空多一行）
  assert.match(await bench2.read(), /没有新消息/u);
  void bench;
});

test('反：名字核对拦下的调用（清单里没有这件）⇒ 0 条', async (t) => {
  const bench = await makeBench(t, {
    tools: [{ name: 'get_group_list', description: '群列表' }],
    liveList: true,
  });
  const result = await bench.entry.handler(BAN_ARGS, CTX);
  assert.equal(result.isError, true);
  assert.match(result.content, /没有名为「set_group_whole_ban」的工具/u, result.content);
  let count = 0;
  for await (const event of bench.log.readAll()) if (event.type === 'channel/self-action') count += 1;
  assert.equal(count, 0, '没有发生的事不留痕');
});

// ──────────────────────────────── ④ 反：归不到会话 / 不是群会话里的事 ────────────────────────────────

test('反：delete_msg / send_like / set_group_add_request ⇒ 0 条（归不到会话或不是群里的事）', () => {
  const cases: Array<{ tool: string; args: Record<string, unknown>; why: string }> = [
    { tool: 'delete_msg', args: { message_id: 555001 }, why: '参数只有 message_id，归不到会话' },
    { tool: 'send_like', args: { user_id: 1109841333, times: 1 }, why: '不是群会话里的事' },
    { tool: 'set_group_add_request', args: { flag: 'abc', approve: true }, why: '主键是一次性 flag，不含 group_id' },
    { tool: 'set_group_ban', args: { user_id: 1109841333, duration: 600 }, why: '认识的写工具但平台没给 group_id' },
  ];
  for (const item of cases) {
    const receipt: SelfActionReceipt = {
      server: 'onebot11-mcp', tool: item.tool, args: item.args,
      status: 'ok', content: '{"ok":true}', isError: false, turn: 1, callId: 'c',
    };
    // 两道都判一次：`actionRecordOf` 是判据，`recordSelfAction` 是落库口——两个都不许写
    assert.equal(actionRecordOf(receipt), null, `${item.tool} 不该记（${item.why}）`);
    let wrote = false;
    assert.equal(recordSelfAction(receipt, () => { wrote = true; }), false, `${item.tool} 不该落库`);
    assert.equal(wrote, false);
  }
  // 反面对照：认识的写工具**且带着 group_id** ⇒ 记
  const ok = actionRecordOf({
    server: 'onebot11-mcp', tool: 'set_group_ban',
    args: { group_id: Number(GROUP), user_id: 1109841333, duration: 600 },
    status: 'ok', content: '{"ok":true}', isError: false, turn: 1, callId: 'c',
  });
  assert.notEqual(ok, null, '带着 group_id 的写操作要记');
  assert.equal(ok!.target, '1109841333', '"对谁"那一格取 user_id');
  assert.deepEqual(ok!.params, { duration: 600 }, '只留能人读的那几格');
});

// ──────────────────────────────── ⑤ 失败如实 ────────────────────────────────

test('失败如实：回执体 ok:false 与 status:error 都记 failed，行里写「回执失败：…」', async (t) => {
  // 档②：**协议层通了**（status 仍是 ok），只有回执体说没成——只看 status 会把它写成成功
  const bench = await makeBench(t, { reply: { content: BAD_RECEIPT } });
  const result = await bench.entry.handler(BAN_ARGS, CTX);
  assert.equal(result.isError, undefined, '协议层没出错：这一跳是通的');

  let events: AppEvent[] = [];
  for await (const event of bench.log.readAll()) events.push(event);
  const recorded = events.filter((event) => event.type === 'channel/self-action');
  assert.equal(recorded.length, 1, '失败也要留痕（"我试过了"是事实）');
  const data = recorded[0]!.data as Record<string, unknown>;
  assert.equal(data['receipt'], 'failed', '回执体说 ok:false ⇒ failed');
  assert.equal(data['detail'], '权限不足', '原因照抄平台给的那一句');
  assert.deepEqual(rowsOf(await bench.read()),
    [`${SELF_SPEAK_LABEL}：[全员禁言 · 开启 · ${GROUP_NAME}]（回执失败：权限不足）`]);

  // 档①：这一跳本身没走通（超时）
  const timedOut = await makeBench(t, {
    reply: { content: 'MCP 工具 set_group_whole_ban（server onebot11-mcp）超过 120000ms 未返回', isError: true },
  });
  await timedOut.entry.handler(BAN_ARGS, CTX);
  let timed: AppEvent[] = [];
  for await (const event of timedOut.log.readAll()) timed.push(event);
  const timedData = timed.filter((event) => event.type === 'channel/self-action')[0]!.data as Record<string, unknown>;
  assert.equal(timedData['receipt'], 'failed');
  assert.match(String(timedData['detail']), /未返回/u, '原因就是回执正文（人话），照抄');
  assert.deepEqual(rowsOf(await timedOut.read()),
    [`${SELF_SPEAK_LABEL}：[全员禁言 · 开启 · ${GROUP_NAME}]（回执失败：MCP 工具 set_group_whole_ban（server onebot11-mcp）超过 120000ms 未返回）`]);
});

test('失败但没有原因 ⇒ 只写「（回执失败）」，不写一个空冒号', () => {
  const noReason = actionRecordOf({
    server: 'onebot11-mcp', tool: 'set_group_kick', args: { group_id: Number(GROUP), user_id: 1109841333 },
    status: 'ok', content: '{"ok":false}', isError: false, turn: 1, callId: 'c',
  });
  assert.equal(noReason?.receipt, 'failed');
  assert.equal(
    selfActionLineText(noReason!, () => GROUP_NAME),
    `[踢出群聊 · @1109841333 · ${GROUP_NAME}]（回执失败）`,
  );
});

test('三档判据的第三档：回执走通了、平台没报错、也没有 ok 那一格 ⇒ **ok**（不替平台加戏）', () => {
  const silent = actionRecordOf({
    server: 'onebot11-mcp', tool: 'set_group_sign', args: { group_id: Number(GROUP) },
    status: 'ok', content: '（MCP 工具没有返回内容）', isError: false, turn: 1, callId: 'c',
  });
  assert.equal(silent?.receipt, 'ok', '没结论时按事实的最弱一侧说，不编一个失败出来');
  assert.equal(selfActionLineText(silent!, () => GROUP_NAME), `[群打卡 · ${GROUP_NAME}]（回执 ok）`);
});

// ──────────────────────────────── ⑥ 不认识的动作 / 名字查不到 / 参数缺 ────────────────────────────────

test('不认识的动作：**整条不记**；而万一落了库也只摆协议原名（不编中文动作名）', async (t) => {
  // 认识的（带着 group_id）但没有中文词条 ⇒ **整条不记**（如实退化：宁可少一行，不编一行）
  assert.equal(actionRecordOf({
    server: 'onebot11-mcp', tool: 'set_group_new_thing', args: { group_id: Number(GROUP) },
    status: 'ok', content: OK_RECEIPT, isError: false, turn: 1, callId: 'c',
  }), null, '不认识的写动作不记——不是记一条没有动作名的');

  const bench = await makeBench(t, { tools: [{ name: 'set_group_new_thing', description: '将来某一件' }] });
  const result = await bench.entry.handler(
    { server: 'onebot11-mcp', tool: 'set_group_new_thing', args: { group_id: Number(GROUP) } }, CTX);
  assert.equal(result.isError, undefined, '它照旧能执行（这一层不管能力，只管记不记）');
  let count = 0;
  for await (const event of bench.log.readAll()) if (event.type === 'channel/self-action') count += 1;
  assert.equal(count, 0, '真链路里也不记');

  // 渲染那一层的默认分支：真遇到没有词条的 action ⇒ **照摆协议原名**
  assert.equal(
    selfActionLineText({
      channel: 'onebot', sid: SID, action: 'set_group_mystery', server: 'onebot11-mcp',
      tool: 'set_group_mystery', receipt: 'ok',
    }, () => GROUP_NAME),
    `[set_group_mystery · ${GROUP_NAME}]（回执 ok）`,
  );
});

test('名字查不到给如实锚；参数缺的格一个字都不写', () => {
  const noDuration = actionRecordOf({
    server: 'onebot11-mcp', tool: 'set_group_ban',
    args: { group_id: Number(GROUP), user_id: 1109841333 },
    status: 'ok', content: '{"ok":true}', isError: false, turn: 1, callId: 'c',
  });
  // 名字真源给不出 ⇒ 锚（**不编群名**）；duration 没给 ⇒ **不写秒数**（不写 0、不写"未知"）
  assert.equal(selfActionLineText(noDuration!, () => null), '[禁言 · @1109841333 · 一个群聊（…3642）]（回执 ok）');
  assert.equal(selfActionLineText(noDuration!, () => GROUP_NAME), `[禁言 · @1109841333 · ${GROUP_NAME}]（回执 ok）`);
  // enable 没给 ⇒ **不说开还是关**（不编一个方向出来）
  const noEnable = actionRecordOf({
    server: 'onebot11-mcp', tool: 'set_group_whole_ban', args: { group_id: Number(GROUP) },
    status: 'ok', content: '{"ok":true}', isError: false, turn: 1, callId: 'c',
  });
  assert.equal(selfActionLineText(noEnable!, () => GROUP_NAME), `[全员禁言 · ${GROUP_NAME}]（回执 ok）`);
  // duration=0 是协议里"解除禁言"的那个值（与 notice 那一路同一判据）
  const lifted = actionRecordOf({
    server: 'onebot11-mcp', tool: 'set_group_ban',
    args: { group_id: Number(GROUP), user_id: 1109841333, duration: 0 },
    status: 'ok', content: '{"ok":true}', isError: false, turn: 1, callId: 'c',
  });
  assert.equal(selfActionLineText(lifted!, () => GROUP_NAME), `[解除禁言 · @1109841333 · ${GROUP_NAME}]（回执 ok）`);
});

test('通道名由 server 名推导：认不出就是**空串**（不编一个像样的通道名）', () => {
  const onebot = actionRecordOf({
    server: 'onebot11-mcp', tool: 'set_group_sign', args: { group_id: Number(GROUP) },
    status: 'ok', content: '{"ok":true}', isError: false, turn: 1, callId: 'c',
  });
  assert.equal(onebot?.channel, 'onebot');
  assert.equal(onebot?.sid, SID, 'sid 的命名空间跟着通道名走');
  const stranger = actionRecordOf({
    server: 'some-other-bot', tool: 'set_group_sign', args: { group_id: Number(GROUP) },
    status: 'ok', content: '{"ok":true}', isError: false, turn: 1, callId: 'c',
  });
  assert.equal(stranger?.channel, '', '推不出就如实空着（那一格只影响显示，不影响判据）');
  assert.equal(stranger?.sid, `:group:${GROUP}`, '空通道名 ⇒ sid 也如实没有前缀');
});

// ──────────────────────────────── 顺带两条：纪律与互斥 ────────────────────────────────

test('可见性 internal、不计未读、不计 messages（与 channel/notice 逐字同一条纪律）', async (t) => {
  const bench = await makeBench(t);
  await bench.entry.handler(BAN_ARGS, CTX);
  assert.equal(defaultVisibility('channel/self-action'), 'internal',
    'internal ⇒ 不进请求体 ⇒ **不必递 RENDER_VERSION**');

  // 会话簿是 `warmUp` 从日志折出来的（运行期那一拍不重折它）⇒ 走"重启一次"那条路，与
  // `restart-group-members` 同一个成例：日志与投影共用，跨重启的东西重新折一遍
  const restarted = await bench.afterRestart();
  t.after(() => { restarted.stop(); });
  const sessions = restarted.sessions();
  assert.equal(sessions.length, 1, '她做过事的那个群出现在会话簿里（她至少知道有这么个地方）');
  assert.equal(sessions[0]!.sid, SID);
  assert.equal(sessions[0]!.unread, 0, '**不计未读**（未读数的必须是别人的话）');
  assert.equal(sessions[0]!.messages, 0, '也不计入"这个会话来过多少条话"');
});

test('她自己的动作**不会**走进"她说过的话"那一支；别的群读不到', async (t) => {
  // 这一件要在清单里（否则"名字核对"那道闸会先把它拦下——那是对的行为，见③那两条用例）
  const bench = await makeBench(t, { tools: [{ name: 'set_group_leave', description: '退出指定群' }] });
  const result = await bench.entry.handler(
    { server: 'onebot11-mcp', tool: 'set_group_leave', args: { group_id: Number(GROUP) } }, CTX);
  assert.equal(result.isError, undefined, result.content);
  assert.deepEqual(await bench.loop.readChannelSpoken(SID), [], '动作不是发言（那一折只认 speak/sent）');
  const actions = await bench.loop.readChannelActions(SID, 20);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.action, 'set_group_leave');
  assert.deepEqual(await bench.loop.readChannelActions(OTHER_SID, 20), [], '别的群读不到（sid 对不上就不摆）');
  // 那一行的逐字（"退群"这条最该有：换过门/重进之后回头看，那一行是唯一的痕迹）
  assert.deepEqual(rowsOf(await bench.read()), [`${SELF_SPEAK_LABEL}：[退群 · ${GROUP_NAME}]（回执 ok）`]);
});

test('「我做过」那一行**不算未读**、也不占"还有 N 条你没看"', async (t) => {
  const bench = await makeBench(t);
  await bench.entry.handler(BAN_ARGS, CTX);
  const text = await bench.read();
  assert.equal(text.includes('另有'), false, '她自己的动作不是"你还有 N 条没看"');
  assert.equal(text.includes('没有新消息'), false, '这一屏摆出了那一行，就不是"没有新消息"');
});
