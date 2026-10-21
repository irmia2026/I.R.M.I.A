/**
 * **协议留痕**（C-3 第 1/2 件）的判据。
 *
 * 钉五组事：
 *   ① `model/protocol` 是**登记过的 internal 事件**（不是靠兜底）——她不该读到它；
 *   ② 切换之后**每一拍**的调用结果都带 `protocol`（`budget/consumed.protocol` 的唯一来源），
 *      没切过带 `'responses'`，没走传输层的调用点则**没有这一格**（缺省 = 不知道，不瞎填）；
 *   ③ 开关关闭 ⇒ **0 条切换通知**（与 C-2 的计数断言并列，两处都要绿）；
 *   ④–⑦ `budget/consumed.protocol` 的**五处自记账写入点**（`injection-judge` / `topic` /
 *      `memory-maintain` / vision 账 / `agent-loop.failStep`）逐处都要：切过带
 *      `chat-completions`、没切过带 `responses`、拿不到协议时**这一格不出现**（不是 null、
 *      不是空串）。`failStep` 那一处在 `test/agent-loop.test.ts`（它要整条 loop）；
 *   ⑧ `DsClient.lastProtocol`（`failStep` 唯一的口）：没发过 = `null`，失败那一发记的
 *      是**实际协议**（含回退后的 chat）。
 *
 * ④⑤ 用的是**真 `DsClient` + 假服务端**（404 ⇒ 切 Chat），所以"切过之后带 chat-completions"
 * 在它们身上是端到端的；⑥⑦ 用"回包里就带那一格"的替身，判的是**写入点会不会照抄**
 * （切换 ⇒ 结果带 chat 那一跳由 ② 与 ④⑤ 钉）。
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { InjectionJudge } from '../src/channel/injection-judge.ts';
import { TopicSummarizer } from '../src/channel/topic.ts';
import { EventLog } from '../src/log/event-log.ts';
import {
  EVENT_VISIBILITY, defaultVisibility, emptyProjection,
  type AppEvent, type BudgetConsumed, type ModelProtocolSwitched, type Projection,
} from '../src/log/types.ts';
import { appendProtocolSwitch, appendVisionConsumption } from '../src/main.ts';
import { DsClient, type DsResponse } from '../src/model/ds-client.ts';
import { ProtocolRegistry, type SwitchDecision } from '../src/model/transport/registry.ts';
import { maintainMemory } from '../src/persona/memory-maintain.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const NOW = new Date('2026-10-21T10:00:00.000+08:00');

/**
 * 假服务端：`/responses` 的行为由 `onResponses` 决定，`/chat/completions` 缺省回一份**成功**的
 * chat 回包（`onChat` 给了就按它来）。四个 `/responses` 形状（正常 / 404 / 500）都是**真实**
 * 的 HTTP 响应，回退判据走的是 `registry` 那一套（不是在测试里手写的分支）。
 */
async function startMock(
  t: TestContext,
  onResponses: (res: ServerResponse) => void,
  onChat?: (res: ServerResponse) => void,
): Promise<string> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('error', () => {});
    res.on('error', () => {});
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.url === '/responses') { onResponses(res); return; }
      if (onChat !== undefined) { onChat(res); return; }
      const payload = JSON.stringify({
        id: 'chat_1', model: 'deepseek-flash',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '在。' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('mock 未绑定端口');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${address.port}`;
}

/** `/responses` 正常：形状合法的 Responses 回包（就是"没切过"那一档） */
function responsesOk(res: ServerResponse): void {
  const payload = JSON.stringify({
    id: 'r1', status: 'completed', model: 'deepseek-flash',
    output: [{
      type: 'message', id: 'm1',
      // 一句话同时满足注入判定与话题概括（两份用例共用这一个回包）
      content: [{ type: 'output_text', text: '{"risky":false,"reason":"闲聊","quotes":[],"topic":"闲聊"}' }],
    }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** `/responses` 不存在：404 + HTML 落地页 ⇒ §2.2 的 P1/P2 命中，合规切一次 Chat */
function responsesMissing(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>404</title>');
}

/** `/responses` 服务端坏了：500（反判据，**不许**切）——给 `lastProtocol` 那一条用 */
function responsesBroken(res: ServerResponse): void {
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: '上游炸了', type: 'server_error', param: '', code: 'boom' } }));
}

/** chat 也坏了：500（服务端类，`stream()` 不内层重试 ⇒ 直接抛给调用方） */
function chatBroken(res: ServerResponse): void {
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'chat 也炸了', type: 'server_error', param: '', code: 'boom' } }));
}

/** 真日志 + 空投影（`budget/consumed` 的写入点要一个真 `EventLog` 才落得下去） */
async function openLog(t: TestContext, prefix: string): Promise<{ log: EventLog; projection: Projection; dir: string }> {
  const dir = tempDirSync(prefix);
  const log = await EventLog.open(join(dir, 'events'));
  t.after(() => {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { log, projection: emptyProjection(), dir };
}

async function consumedOf(log: EventLog): Promise<BudgetConsumed[]> {
  const out: BudgetConsumed[] = [];
  for await (const event of log.readAll()) {
    if (event.type === 'budget/consumed') out.push(event as BudgetConsumed);
  }
  return out;
}

/** 一份"回包里带不带 protocol 由参数决定"的 `DsResponse`（判据是写入点照抄，不是它从哪来） */
function dsResponse(protocol?: 'responses' | 'chat-completions'): DsResponse {
  return {
    status: 'completed',
    outputItems: [{ type: 'message', id: 'm1', text: '{"risky":false,"reason":"闲聊","quotes":[],"topic":"闲聊"}' }],
    usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, reasoningTokens: 0 },
    incompleteReason: null,
    model: 'fake-light',
    responseId: 'resp_1',
    durationMs: 3,
    ...(protocol === undefined ? {} : { protocol }),
  };
}

/** 测试替身：`generate()` 交一份固定回包（**没有** `lastProtocol` 那种扩展） */
function fakeSummarizer(protocol?: 'responses' | 'chat-completions'): DsClient {
  return {
    modelFor: (): string => 'fake-light',
    generate: async (): Promise<DsResponse> => dsResponse(protocol),
  } as unknown as DsClient;
}

test('① `model/protocol` 在可见性表里显式登记为 internal（不靠 defaultVisibility 兜底）', () => {
  assert.equal(EVENT_VISIBILITY['model/protocol'], 'internal');
  assert.equal(defaultVisibility('model/protocol'), 'internal');
});

test('② 调用结果带 protocol：没切过 = responses；切过之后每一拍 = chat-completions', async (t) => {
  const ok = await startMock(t, (res) => {
    const payload = JSON.stringify({
      id: 'r1', status: 'completed', model: 'deepseek-flash',
      output: [{ type: 'message', id: 'm1', content: [{ type: 'output_text', text: '在。' }] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  });
  const normal = new DsClient({ baseUrl: ok, apiKey: 'sk-test' });
  assert.equal((await normal.generate({ lane: 'light', input: 'x' })).protocol, 'responses');

  const switchable = await startMock(t, (res) => {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>404</title>');
  });
  const client = new DsClient({ baseUrl: switchable, apiKey: 'sk-test' });
  assert.equal((await client.generate({ lane: 'light', input: 'x' })).protocol, 'chat-completions', '切过之后带上实际协议');
  assert.equal((await client.generate({ lane: 'light', input: 'y' })).protocol, 'chat-completions', '每一拍都带');
});

test('③ 开关关闭 ⇒ 0 条切换通知（与 C-2 的计数断言并列）', async (t) => {
  const baseUrl = await startMock(t, (res) => {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>404</title>');
  });
  const registry = new ProtocolRegistry({ disabled: true });
  const client = new DsClient({ baseUrl, apiKey: 'sk-test', registry, disableChatFallback: true });
  let notices = 0;
  client.subscribeProtocol(() => { notices += 1; });
  await assert.rejects(() => client.generate({ lane: 'heavy', input: 'x' }));
  assert.equal(notices, 0, '开关关闭 ⇒ 一条 `model/protocol` 都不许落');
});

// ─────────── ④–⑦ `budget/consumed.protocol` 的五处自记账写入点 ───────────

/**
 * 一条消息事件（话题概括的输入）。只被 `summarize()` 读来渲染提示词，**不进日志**。
 * 形状与 `test/injection-judge.test.ts` 的 `msg()` 逐字同形（那边测的是概括逻辑本身）。
 */
function msg(seq: number, person: string, text: string): AppEvent {
  return {
    seq,
    ts: NOW.toISOString(),
    type: 'channel/message',
    data: { channel: 'qq-official', chatType: 'group', person, chatId: 'G1', text, messageId: `m${seq}`, msgSeq: 1 },
    visibility: 'internal',
  } as unknown as AppEvent;
}

test('④ injection-judge 的账带实际协议（真客户机切过 = chat / 没切过 = responses / 替身没有就不写）', async (t) => {
  // ① 切过：`/responses` 404 + HTML ⇒ 真回退，回包 protocol = chat-completions
  const switching = await startMock(t, responsesMissing);
  {
    const { log, projection } = await openLog(t, 'irmia-proto-judge-chat-');
    const ds = new DsClient({ baseUrl: switching, apiKey: 'sk-test' });
    await new InjectionJudge({ ds, now: () => NOW, log, projection, turn: 1 }).judge('今天天气不错');
    const consumed = await consumedOf(log);
    assert.equal(consumed.length, 1, '判定真发了一次请求 ⇒ 恰好一条账');
    assert.equal(consumed[0]!.data.protocol, 'chat-completions', '切过之后这一格必须是**实际**协议');
  }

  // ② 没切过：`/responses` 正常 ⇒ responses
  const normal = await startMock(t, responsesOk);
  {
    const { log, projection } = await openLog(t, 'irmia-proto-judge-resp-');
    const ds = new DsClient({ baseUrl: normal, apiKey: 'sk-test' });
    await new InjectionJudge({ ds, now: () => NOW, log, projection, turn: 1 }).judge('今天天气不错');
    assert.equal((await consumedOf(log))[0]!.data.protocol, 'responses');
  }

  // ③ 拿不到：测试替身的回包没有 protocol ⇒ **这一格不出现**（不是 null、不是空串）
  {
    const { log, projection } = await openLog(t, 'irmia-proto-judge-none-');
    await new InjectionJudge({ ds: fakeSummarizer(), now: () => NOW, log, projection, turn: 1 }).judge('今天天气不错');
    const entry = (await consumedOf(log))[0]!;
    assert.equal('protocol' in entry.data, false, '不知道就不写——绝不默认成 responses');
    assert.equal(entry.data.protocol, undefined);
  }
});

test('⑤ topic 的账带实际协议（真客户机切过 = chat / 没切过 = responses / 替身没有就不写）', async (t) => {
  const messages = [msg(1, 'u1', '显卡又降价了'), msg(2, 'u2', '想换一张')];

  const switching = await startMock(t, responsesMissing);
  {
    const { log, projection } = await openLog(t, 'irmia-proto-topic-chat-');
    const ds = new DsClient({ baseUrl: switching, apiKey: 'sk-test' });
    await new TopicSummarizer({ ds, now: () => NOW, log, projection, turn: 1 }).summarize('qq:group:G1', messages);
    const consumed = await consumedOf(log);
    assert.equal(consumed.length, 1);
    assert.equal(consumed[0]!.data.protocol, 'chat-completions');
  }

  const normal = await startMock(t, responsesOk);
  {
    const { log, projection } = await openLog(t, 'irmia-proto-topic-resp-');
    const ds = new DsClient({ baseUrl: normal, apiKey: 'sk-test' });
    await new TopicSummarizer({ ds, now: () => NOW, log, projection, turn: 1 }).summarize('qq:group:G1', messages);
    assert.equal((await consumedOf(log))[0]!.data.protocol, 'responses');
  }

  {
    const { log, projection } = await openLog(t, 'irmia-proto-topic-none-');
    await new TopicSummarizer({ ds: fakeSummarizer(), now: () => NOW, log, projection, turn: 1 })
      .summarize('qq:group:G1', messages);
    assert.equal('protocol' in (await consumedOf(log))[0]!.data, false);
  }
});

test('⑥ memory-maintain 的两条 light 账都带协议（合并 + 日记；替身没有就不写）', async (t) => {
  /** 走一次 `maintainMemory`（`force` ⇒ 没有到期 episode 也会真发两次请求：合并 + 日记） */
  const run = async (protocol?: 'responses' | 'chat-completions'): Promise<BudgetConsumed[]> => {
    const { log, projection, dir } = await openLog(t, 'irmia-proto-memory-');
    const ds = {
      modelFor: (): string => 'fake-light',
      // 一份回包同时满足两边：合并读 `operations`/`summary`，日记读 `diary`
      generate: async (): Promise<DsResponse> => ({
        ...dsResponse(protocol),
        outputItems: [{
          type: 'message', id: 'm-memory',
          text: '{"operations":[],"summary":"","diary":"今天没什么。"}',
        }],
      }),
    } as unknown as DsClient;
    const result = await maintainMemory(join(dir, 'data'), {
      ds, now: () => NOW, log, projection, turn: 3, force: true,
    });
    assert.equal(result.lightCalls, 2, 'force 且无到期 episode ⇒ 合并一次 + 日记一次');
    return await consumedOf(log);
  };

  const chatted = await run('chat-completions');
  assert.equal(chatted.length, 2, '两次 light 调用各一条账');
  for (const entry of chatted) assert.equal(entry.data.protocol, 'chat-completions');
  assert.equal((await run('responses'))[0]!.data.protocol, 'responses');
  for (const entry of await run()) {
    assert.equal('protocol' in entry.data, false, '失败/替身那一路拿不到协议 ⇒ 不写这一格');
  }
});

test('⑦ vision 的账（宿主写在 main.ts 的那一处）带实际协议；拿不到就不写', async (t) => {
  const { log, projection } = await openLog(t, 'irmia-proto-vision-');
  // 这一处是 `runMain` 里的独立写入点（`origin:'tools/vision'`），2026-10-21 抽成模块级函数以便直测
  appendVisionConsumption({ log, projection, now: () => NOW }, dsResponse('chat-completions'), 7, 3);
  appendVisionConsumption({ log, projection, now: () => NOW }, dsResponse(undefined), 7, 4);

  const consumed = await consumedOf(log);
  assert.equal(consumed.length, 2);
  assert.equal(consumed[0]!.data.protocol, 'chat-completions');
  assert.equal(consumed[0]!.origin, 'tools/vision', 'vision 的钱由这一处记（origin 是唯一一格）');
  assert.equal(consumed[1]!.data.step, 4);
  assert.equal('protocol' in consumed[1]!.data, false, '拿不到协议 ⇒ 字段不出现（不是 null、不是空串）');
});

// ─────────── ⑧ `failStep` 的唯一来源：`DsClient.lastProtocol` ───────────

test('⑧ `DsClient.lastProtocol`：没发过 = null；失败那一发记的是实际协议（含回退后的 chat）', async (t) => {
  const ok = await startMock(t, responsesOk);
  assert.equal(new DsClient({ baseUrl: ok, apiKey: 'sk-test' }).lastProtocol, null, '一发都没发过 ⇒ null');

  // 没切过、`/responses` 500 ⇒ 实际用的是 responses
  const broken = await startMock(t, responsesBroken);
  const normalClient = new DsClient({ baseUrl: broken, apiKey: 'sk-test' });
  await assert.rejects(() => normalClient.stream({ lane: 'heavy', input: 'x' }));
  assert.equal(normalClient.lastProtocol, 'responses', '这一发真发出去了，用的是 responses');

  // 切过：`/responses` 404 ⇒ 第二发打到 chat，chat 也 500 ⇒ 抛错时记的是 chat
  const switching = await startMock(t, responsesMissing, chatBroken);
  const switchedClient = new DsClient({ baseUrl: switching, apiKey: 'sk-test' });
  await assert.rejects(() => switchedClient.stream({ lane: 'heavy', input: 'x' }));
  assert.equal(switchedClient.lastProtocol, 'chat-completions', '回退后的那一发才是"最近一次实际协议"');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 两个"账本答不出"的洞（评审 P4 / P5）——每一条都要能在事件里读到答案
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────── ⑤ `model/protocol` 少 `model`、`evidence` 少 `url` ───────────

/**
 * 评审 P5：设计 §6.2 的事件声明里明明有 `model: string` 与 `evidence.url`，实现里两格都没有。
 *
 * 后果是可观测性上的硬伤：`criterion` + `status` 只回答"这个**端点**不支持 Responses"，
 * 答不出"**哪个 baseUrl**"（而 `unavailable` 那一档最常见的原因就是 baseUrl 填错），
 * 也答不出"**哪条 lane 的哪个模型**"（同一端点上 heavy/light 可是两个模型）。
 *
 * 这一条分两跳钉：
 *   ① 客户端交出来的 `SwitchDecision` 里就有这两格（真回退现场：404 + HTML）；
 *   ② 落库那一跳（`main.ts` 的 `appendProtocolSwitch`，2026-10-21 抽成模块级函数就是为了可测）
 *      **原样照抄**进事件——不是"调用方记得补"。
 */
test('⑤ `model/protocol` 事件带 `model` 与 `evidence.url`（账本要答得出"哪个 baseUrl 不支持"）', async (t) => {
  // ① 真回退：`/responses` 404 + HTML ⇒ 结论里两格都在
  const baseUrl = await startMock(t, responsesMissing);
  const client = new DsClient({ baseUrl, apiKey: 'sk-test' });
  const decisions: SwitchDecision[] = [];
  client.subscribeProtocol((d) => decisions.push(d));
  await client.generate({ lane: 'heavy', input: 'x' });

  assert.equal(decisions.length, 1);
  const decision = decisions[0]!;
  assert.equal(decision.model, 'deepseek-v4-pro', '① 结论里带模型（heavy 的默认模型）');
  assert.equal(decision.evidence.url, baseUrl, '① 结论里带端点');
  assert.equal(decision.evidence.status, 404);
  assert.equal(decision.evidence.errorCode, 'http_404');

  // ② 落库那一跳照抄（同一个 decision 交给 main.ts 的那个函数）
  const { log } = await openLog(t, 'irmia-proto-event-');
  appendProtocolSwitch({ log, now: () => NOW }, decision);
  const written: ModelProtocolSwitched[] = [];
  for await (const event of log.readAll()) {
    if (event.type === 'model/protocol') written.push(event as ModelProtocolSwitched);
  }
  assert.equal(written.length, 1);
  const data = written[0]!.data;
  assert.equal(data.model, 'deepseek-v4-pro', '★ 事件里有 model（修之前没有这一格）');
  assert.equal(data.evidence.url, baseUrl, '★ 事件证据里有 url（修之前没有这一格）');
  assert.equal(data.lane, 'heavy');
  assert.equal(data.from, 'responses');
  assert.equal(data.to, 'chat-completions');
  assert.equal(data.criterion, 'http_404');
  assert.equal(data.evidence.status, 404);
  assert.equal(written[0]!.visibility, 'internal', '她读不到它（internal）');
});

// ─────────── ④ `usageMissing`：四格全 0 时，账要说得出"这 0 是不知道" ───────────

/**
 * 评审 P4：`usageMissing` **完全没实现**（全仓 0 处）。对端不给 usage 时四格全 0，而日志里
 * 没有任何一处说"对端没给 usage" ⇒ "预算少算"这个问句永远答不了（设计 §6.2 / §9.3#20）。
 *
 * 这一条钉两跳：
 *   ① 传输层：真客户端 + 真 mock，chat 流**不给 usage** ⇒ `DsStreamResult.usageMissing === true`
 *      （给了 usage 的那一发**不许**有这一格）；
 *   ② 账本：写入点照抄（这里用 `channel/topic.ts`；`agent-loop.accountStep` 那一条在
 *      `test/agent-loop.test.ts`——它要整条 loop）。⚠ 那两处原来有一条"全 0 且不失败就不记账"
 *      的护栏，它会让这一格**永远写不出来**；例外条件（`usageMissing === true` 时必须留痕）
 *      与理由写在那两个 `account()` 里。
 */
test('④ `usageMissing`：对端不给 usage ⇒ 结果带这一格、账上落 `usageMissing: true`', async (t) => {
  /** chat 流：给不给 usage 由参数决定（其余形状逐字节相同，差异只有那一格） */
  const chatStream = (res: ServerResponse, withUsage: boolean): void => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { content: '在。' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: 'c1',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      ...(withUsage ? { usage: { prompt_tokens: 10, completion_tokens: 5 } } : {}),
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  };

  // ① 传输层：chat 流最后一块**不带 usage**（兼容层常见形态）
  const noUsage = await startMock(t, responsesMissing, (res) => chatStream(res, false));
  const missing = await new DsClient({ baseUrl: noUsage, apiKey: 'sk-test' })
    .stream({ lane: 'heavy', input: 'x' }, {});
  assert.equal(missing.protocol, 'chat-completions');
  assert.deepEqual(missing.usage, { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 });
  assert.equal(missing.usageMissing, true, '★ 修之前这一格不存在 ⇒ 账上只能看见四个 0');

  // 反面：给了 usage 的那一发**不许**带这一格（只增不改：事件形状与从前逐字节相同）
  const withUsage = await new DsClient({ baseUrl: await startMock(t, responsesMissing, (res) => chatStream(res, true)), apiKey: 'sk-test' })
    .stream({ lane: 'heavy', input: 'x' }, {});
  assert.equal(withUsage.usage.inputTokens, 10);
  assert.equal(withUsage.usageMissing, undefined, '有 usage ⇒ 这一格不出现（不是 false）');

  // ② 账本：写入点照抄（主题概括那一处）
  const messages = [msg(1, 'u1', '显卡又降价了'), msg(2, 'u2', '想换一张')];
  {
    const { log, projection } = await openLog(t, 'irmia-proto-usage-missing-');
    await new TopicSummarizer({
      ds: {
        modelFor: (): string => 'fake-light',
        generate: async (): Promise<DsResponse> => ({
          ...dsResponse(),
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 },
          usageMissing: true,
        }),
      } as unknown as DsClient,
      now: () => NOW, log, projection, turn: 1,
    }).summarize('qq:group:G1', messages);

    const consumed = await consumedOf(log);
    assert.equal(consumed.length, 1, '★ 全 0 本来不记账，但"对端没给 usage"必须留痕');
    assert.equal(consumed[0]!.data.usageMissing, true, '★ 账上要说得清这 0 是不知道');
    assert.equal(consumed[0]!.data.inputTokens, 0);
    assert.equal(consumed[0]!.data.outputTokens, 0);
  }

  {
    // 反面：正常回包（有 usage）⇒ 这一格不出现（老事件形状不变）
    const { log, projection } = await openLog(t, 'irmia-proto-usage-present-');
    await new TopicSummarizer({ ds: fakeSummarizer(), now: () => NOW, log, projection, turn: 1 })
      .summarize('qq:group:G1', messages);
    const entry = (await consumedOf(log))[0]!;
    assert.equal('usageMissing' in entry.data, false, '有 usage ⇒ 不写这一格');
  }
});
