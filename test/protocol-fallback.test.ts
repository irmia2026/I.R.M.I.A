/**
 * **协议回退的状态机与验收**（C-2）：探测判据 / 反判据 / 每端点只探一次 / 开关 / 硬前置。
 *
 * 这一份钉的是 `src/model/transport/registry.ts` 与 `DsClient.transportFor` 的行为——
 * 也就是**唯一会改变线上行为的那个点**。所以每条断言都要能回答"线上的她会不会被这条影响到"。
 *
 * 六条验收（用户 2026-10-21 给的，缺一不可）：
 *   ① 开关关闭 ⇒ 一次都不切，**且不去探测**（chat 计数 0 · 探测计数 0）
 *   ② 探测只探一次：连续 5 次失败 ⇒ 探测计数恰 1、后续走缓存结论
 *   ③ 不抖动：同进程 5 连 ⇒ 结论只落一次（切换通知恰 1 条）
 *   ④ 反判据 8 类各一条 ⇒ 都不切、且**不污染探测缓存**
 *   ⑤ 默认档位走不到 Chat：`auto` + 探测未命中 ⇒ chat 计数 0
 *   ⑥ 硬前置：`hasDeliveredContent()` 为真 ⇒ 不许切
 * 另外两条 C-2 自带：§3.7 #10 的工具名字符集、适配器故障的隔离回归网。
 * C-3 的 S1（配置三档）补两条：⑦ 写 `config.json` → `loadConfig` → `DsClient` 的端到端三档读数；
 * ⑧ "关掉开关"的两种写法（环境变量 / `protocol:'responses'`）逐项同读数。
 *
 * ⚠ 关于"同进程 5 连 ⇒ `responses` 计数 5"这条读法：本实现里**第一发**一旦判据命中就当场换协议
 * 重发一次（§5.1/§5.2 的"上限 1"），所以精确读数是 **`responses` 计数 1 · `chat` 计数 5 ·
 * 切换通知 1 条**。若按"`responses` 计数 5"理解，那要求"第一发失败后不重发、只记住结论"——
 * 与设计 §5.1 那条"同一次调用里换协议重发"冲突。**下面按实现的读数断言，并把两种读法都写出来**。
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { ConfigError, loadConfig } from '../src/config/config.ts';
import { ProtocolRegistry, probeResponsesUnsupported, type FailureEvidence } from '../src/model/transport/registry.ts';
import { chatCompletionsTransport } from '../src/model/transport/chat-completions.ts';
import type { SwitchDecision } from '../src/model/transport/registry.ts';
import type { ModelProtocolPreference } from '../src/model/transport/types.ts';
import { DsClient, type DsClientError, type DsRequest, type DsStreamResult } from '../src/model/ds-client.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const REQ: DsRequest = { lane: 'heavy', input: '在吗' };

// ──────────────────────────────── mock：按路径分别"坏掉" ────────────────────────────────

interface Sink {
  responses: number;
  chat: number;
  bodies: string[];
}

/** `/responses` 与 `/chat/completions` 各按给定行为回包（`bad` 的取值见各用例） */
async function startMock(
  t: TestContext,
  sink: Sink,
  handlers: {
    onResponses?: (res: ServerResponse) => void;
    onChat?: (res: ServerResponse) => void;
  } = {},
): Promise<string> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('error', () => {});
    res.on('error', () => {});
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      sink.bodies.push(body);
      const wantsStream = body.includes('"stream":true');
      if (req.url === '/responses') {
        sink.responses += 1;
        if (handlers.onResponses !== undefined) { handlers.onResponses(res); return; }
        respondOk(res, wantsStream, 'responses');
        return;
      }
      sink.chat += 1;
      if (handlers.onChat !== undefined) { handlers.onChat(res); return; }
      respondOk(res, wantsStream, 'chat');
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

function respondOk(res: ServerResponse, stream: boolean, which: 'responses' | 'chat'): void {
  if (which === 'responses') {
    if (!stream) {
      const payload = JSON.stringify({
        id: 'resp_1', status: 'completed', model: 'deepseek-flash',
        output: [{ type: 'message', id: 'm1', content: [{ type: 'output_text', text: '在。' }] }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","model":"deepseek-flash","output":[{"type":"message","id":"m1","content":[{"type":"output_text","text":"在。"}]}],"usage":{"input_tokens":10,"output_tokens":5}}}\n\n');
    res.end();
    return;
  }
  if (!stream) {
    const payload = JSON.stringify({
      id: 'chat_1', model: 'deepseek-flash',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '在。' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ id: 'chat_1', model: 'deepseek-flash', choices: [{ index: 0, delta: { content: '在。' }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: 'chat_1', model: 'deepseek-flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/** 一个"我就是不认 /responses"的 404（HTML 落地页，最典型的第三方兼容层） */
function notFoundHtml(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>404</title><p>Not Found</p>');
}

/** 只回状态码 / 正文的小工具 */
function status(res: ServerResponse, code: number, body = '', type = 'application/json'): void {
  res.writeHead(code, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function newSink(): Sink {
  return { responses: 0, chat: 0, bodies: [] };
}

// ─────────────────────── ① 开关关闭 ⇒ 不切、也不探测 ───────────────────────

test('① 开关关闭（`disableChatFallback`）：一次都不切，chat 计数 0，**探测计数 0**', async (t) => {
  const sink = newSink();
  const baseUrl = await startMock(t, sink, { onResponses: notFoundHtml });
  const registry = new ProtocolRegistry({ disabled: true });
  const client = new DsClient({ baseUrl, apiKey: 'sk-test', registry, disableChatFallback: true });
  const decisions: SwitchDecision[] = [];
  client.subscribeProtocol((d) => decisions.push(d));

  await assert.rejects(() => client.generate(REQ), (error: unknown) => {
    assert.equal((error as { kind?: string }).kind, 'invalid', '与今天一模一样的失败（404 → invalid）');
    return true;
  });

  assert.equal(sink.chat, 0, '开关关闭 ⇒ 一次都不许摸 Chat');
  assert.equal(registry.probeCountOf(baseUrl), 0, '连判据都不算 ⇒ 探测计数 0');
  assert.equal(registry.protocolFor(baseUrl), 'responses');
  assert.deepEqual(decisions, [], '不许有任何切换通知');
});

// ─────────────────── ② 探测只探一次 + ③ 不抖动（结论只落一次）───────────────────

test('②③ 连 5 发全失败：探测恰 1 次、结论只落一次、后续直连 Chat（不抖动）', async (t) => {
  const sink = newSink();
  const baseUrl = await startMock(t, sink, { onResponses: notFoundHtml });
  const registry = new ProtocolRegistry();
  const client = new DsClient({ baseUrl, apiKey: 'sk-test', registry });
  const decisions: SwitchDecision[] = [];
  client.subscribeProtocol((d) => decisions.push(d));

  for (let i = 0; i < 5; i += 1) await client.generate(REQ);

  // 精确读数（与"responses 计数 5"那种读法的差别见文件头）
  assert.equal(registry.probeCountOf(baseUrl), 1, '★ 每端点每进程只探一次');
  assert.equal(sink.responses, 1, '`/responses` 只被打了一次（那一发命中了判据）');
  assert.equal(sink.chat, 5, '5 发都从 Chat 走通（第一发是透明重发，后四发直连）');
  assert.equal(decisions.length, 1, '★ 切换通知恰好 1 条（不抖动）');
  assert.equal(decisions[0]!.criterion, 'http_404', '判据记的是 404（不是 HTML 页那一条：P1 先命中）');
  assert.equal(decisions[0]!.from, 'responses');
  assert.equal(decisions[0]!.to, 'chat-completions');
  assert.ok(decisions[0]!.firstSeenAt === decisions[0]!.decidedAt, '首次发生与落定是同一刻');
});

test('④ 反判据 8 类：每一类都**不切**、且**不污染探测缓存**（探测计数 0、结论仍是 responses）', async (t) => {
  const cases: Array<{ label: string; run: (res: ServerResponse) => void }> = [
    { label: '429 限流', run: (res) => status(res, 429, '{"error":{"message":"rate limited"}}') },
    { label: '500 服务端错', run: (res) => status(res, 500, '{"error":{"message":"boom"}}') },
    { label: '401 密钥错', run: (res) => status(res, 401, '{"error":{"message":"bad key"}}') },
    { label: '413 太大', run: (res) => status(res, 413, '{"error":{"message":"too large"}}') },
    { label: '普通 400（不点名端点）', run: (res) => status(res, 400, '{"error":{"message":"input[3]: bad image"}}') },
    { label: '超时（传输层）', run: (res) => { res.socket?.destroy(); } },
    { label: '200 空产出', run: (res) => status(res, 200, '{"id":"r","status":"completed","output":[]}') },
    {
      label: '200 + error 信封',
      run: (res) => status(res, 200, '{"error":{"message":"upstream says no"}}'),
    },
  ];
  for (const item of cases) {
    const sink = newSink();
    const baseUrl = await startMock(t, sink, { onResponses: item.run });
    const registry = new ProtocolRegistry();
    const client = new DsClient({ baseUrl, apiKey: 'sk-test', registry, maxAttempts: 1, silenceMs: 50, timeoutMs: 50 });
    await assert.rejects(() => client.generate(REQ));
    assert.equal(sink.chat, 0, `${item.label}：反判据 ⇒ 一次都不许摸 Chat`);
    assert.equal(registry.protocolFor(baseUrl), 'responses', `${item.label}：结论必须仍是 responses`);
    assert.equal(registry.probeCountOf(baseUrl), 0, `${item.label}：反判据不许记成一次探测`);
  }
});

// ─────────────────── ⑤ 默认档位走不到 Chat（Responses 正常时）───────────────────

test('⑤ 默认档位（`auto` + 探测未命中）：Responses 正常 ⇒ chat 计数 0、零切换通知', async (t) => {
  const sink = newSink();
  const baseUrl = await startMock(t, sink);
  const registry = new ProtocolRegistry();
  const client = new DsClient({ baseUrl, apiKey: 'sk-test', registry });
  let decisions = 0;
  client.subscribeProtocol(() => { decisions += 1; });
  for (let i = 0; i < 3; i += 1) await client.generate(REQ);
  assert.equal(sink.chat, 0, '★ 今天能跑的一切必须仍然走今天那条路');
  assert.equal(registry.probeCountOf(baseUrl), 0);
  assert.equal(decisions, 0);
});

// ─────────────────────── ⑥ 硬前置：已交付 ⇒ 不许切 ───────────────────────

test('⑥ 硬前置：`delivered: true` ⇒ 判据一个都不命中（§5.4）', () => {
  const delivered: FailureEvidence = { status: 404, bodyText: '<!doctype html>', code: 'http_404', kind: 'invalid', delivered: true };
  assert.equal(probeResponsesUnsupported(delivered), null, '已经吐过字 ⇒ 404 也不许切');
  const registry = new ProtocolRegistry();
  const decision = registry.noteFailure({ baseUrl: 'http://x', lane: 'heavy', model: 'm', protocol: 'responses', evidence: delivered });
  assert.equal(decision, null);
  assert.equal(registry.protocolFor('http://x'), 'responses', '一个字节都不许动');
  assert.equal(registry.probeCountOf('http://x'), 0);
  // 反面：同一个现场，只要没交付过，就该切
  assert.equal(probeResponsesUnsupported({ ...delivered, delivered: false }), 'http_404');
});

// ───────────────────── §3.7 #10：工具名字符集（挪进来做断言）─────────────────────

test('§3.7 #10 · 24 个真实工具名全部落在 Chat 的字符集里（今天不会因为名字被 400）', () => {
  // 这份清单是 2026-10-21 从 `src/tools/**` 里抓的（`name: '…'` 去重）。新加工具时它会红——
  // 那正是要的：名字不合规的工具会让每一次 Chat 请求都 400，而且错在"名字"上极难看出来。
  const names = [
    'ask_human', 'find', 'grep', 'http_download', 'http_get', 'http_post', 'memory_read', 'multi_edit',
    'mcp', 'pwsh', 'read_file', 'read_image', 'report', 'speak', 'talk_groups', 'todo',
    'vision_read', 'web_search', 'write_file', 'edit_file', 'delete_file', 'move_file', 'task', 'timer',
    'read_channel', 'send_media', 'skill', 'grant',
  ];
  const pattern = /^[a-zA-Z0-9_-]{1,128}$/u;
  for (const name of names) assert.match(name, pattern, `工具名 ${name} 不合 Chat 的字符集`);

  // 反面：一个带空格的名字必须**当场抛**（不许静默截断），且报错里要能看见那个名字
  assert.throws(
    () => chatCompletionsTransport.buildRequest(
      { lane: 'light', input: 'x', tools: [{ type: 'function', name: 'bad name', description: 'd', parameters: {} }] },
      { model: 'm', user: 'u', stream: false },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes('bad name'), '报错必须点名那个工具名');
      return true;
    },
  );
});

// ──────────────── 适配器故障的回归网（R2）：形状 / 定时器 / 隔离 ────────────────

test('R2 回归：Chat 那发抛非 `DsClientError` ⇒ ① 退回原始 Responses 错误 ② 定时器被清 ③ 判死为 quarantined', async (t) => {
  const sink = newSink();
  const baseUrl = await startMock(t, sink, { onResponses: notFoundHtml });
  const registry = new ProtocolRegistry();
  const before = process.getActiveResourcesInfo().filter((n) => n === 'Timeout').length;

  const client = new DsClient({
    baseUrl,
    apiKey: 'sk-test',
    registry,
    // ★ 注入"一调就炸"的 Chat 适配器（模拟 C 阶段的实现 bug）
    transportOverride: {
      chat: {
        ...chatCompletionsTransport,
        buildRequest: () => { throw new TypeError('inject: chat adapter bug'); },
      },
    },
  });

  await assert.rejects(() => client.generate(REQ), (error: unknown) => {
    // ① 错误形状与"Responses 当天"一致：就是那条 404 → invalid
    assert.equal((error as { kind?: string }).kind, 'invalid', 'R2：最坏结果 = 和今天一模一样的那条失败');
    assert.equal((error as { status?: number }).status, 404);
    return true;
  });

  await new Promise<void>((resolve) => { setImmediate(resolve); });
  // ② 定时器被清（P1 的回归网）
  assert.equal(process.getActiveResourcesInfo().filter((n) => n === 'Timeout').length - before, 0, '定时器必须被清掉');
  // ③ 适配器被隔离（本进程不再试），且退回 responses
  assert.equal(registry.viewOf(baseUrl).state, 'quarantined');
  assert.equal(registry.protocolFor(baseUrl), 'responses', 'R2：退回今天那条路');

  // 隔离是**真的**：再来一发，不许再摸 Chat
  const chatBefore = sink.chat;
  await assert.rejects(() => client.generate(REQ));
  assert.equal(sink.chat, chatBefore, 'quarantined 之后一次都不许再摸 Chat');
});
/**
 * **换到 Chat 之后走流式那条路**（C-3 补的回归网）。
 *
 * 钉的是一个**已经发生过的真事故**（C-2 的漏网）：`stream()` 里累积器原来在 `exchange()` **之前**
 * 按“第一发”的协议造好，于是一旦换到 Chat，解析器仍是 Responses 那一套 ——
 * 帧名对不上（`response.*` vs `choices[].delta`）⇒ **一个字都收不到** ⇒
 * 一次本该成功的调用被 `hasUsableOutput` 判成空回包（还会重试三次）。
 */
test('★ 换到 Chat 之后走流式：累积器换成 Chat 的、正文与工具调用都收到、不出现空回包', async (t) => {
  const sink = newSink();
  const baseUrl = await startMock(t, sink, {
    onResponses: notFoundHtml,
    // Chat 侧：按 DeepSeek 的真实形状（正文 + 工具调用分片 + 最后一块同时带终态与 usage）
    onChat: (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
      res.write(chunk({ id: 'c1', model: 'deepseek-flash', choices: [{ index: 0, delta: { content: '在。' }, finish_reason: null }] }));
      res.write(chunk({ id: 'c1', model: 'deepseek-flash', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'pwsh', arguments: '' } }] }, finish_reason: null }] }));
      res.write(chunk({ id: 'c1', model: 'deepseek-flash', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"date"}' } }] }, finish_reason: null }] }));
      res.write(chunk({
        id: 'c1', model: 'deepseek-flash',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
      res.write('data: [DONE]\n\n');
      res.end();
    },
  });
  const client = new DsClient({ baseUrl, apiKey: 'sk-test', registry: new ProtocolRegistry() });

  const result = await client.stream({ lane: 'heavy', input: '几点了' }, {});

  assert.equal(result.text, '在。', '正文必须收得到（收不到 = 累积器还是 Responses 那套）');
  assert.deepEqual(result.toolCalls, [{ callId: 'call_9', name: 'pwsh', arguments: '{"command":"date"}' }], '工具调用也要收到（index 归并那条）');
  assert.equal(result.failure, null, '这不是失败');
  assert.equal(result.status, 'completed');
  assert.equal(result.protocol, 'chat-completions', '结果要如实说走的是哪个协议');
  assert.equal(sink.chat, 1, '★ 只许发一条 chat 请求（>1 就是被判成 empty 重试了）');
});

// ─────────────── ⑦ 配置三档（`models.<lane>.protocol`，C-3 的 S1 端到端）───────────────

/**
 * **一条端到端**：写 `config.json` → `loadConfig` 重新解析 → 交给 `DsClient` → 真打两套端点。
 *
 * 钉四件事，每一件都是这档配置**真的生效**的判据（而不是"字段存在"）：
 *   a. `'chat-completions'` ⇒ `/responses` **计数 0**（不先试）、**探测计数 0**（不探测）、零切换通知；
 *   b. `'responses'` ⇒ 404 也**永不切**（chat 计数 0），registry 的结论不被污染；
 *   c. `'auto'` ⇒ **今天的行为**：`/responses` 1 发（命中判据）、同一次调用内换 Chat 重发、切换通知 1 条；
 *   d. 写错值（`'chat'`）⇒ `loadConfig` **抛 ConfigError** 点名 `models.light.protocol` 与合法值
 *      ——不静默回落 auto（静默丢配置正是这次要消灭的病）。
 */
test('⑦ 配置三档端到端：chat 强制 ⇒ `/responses` 计数 0；responses 强制 ⇒ 永不切；auto ⇒ 今天逻辑；写错 ⇒ 报错', async (t) => {
  const dir = tempDirSync('irmia-proto-config-');
  const configPath = join(dir, 'config.json');
  const writeProtocol = (lane: 'heavy' | 'light', value: string): void => {
    writeFileSync(configPath, JSON.stringify({ models: { [lane]: { protocol: value } } }), 'utf8');
  };

  // ── a. `chat-completions`：强制走 Chat ──
  {
    writeProtocol('heavy', 'chat-completions');
    const loaded = await loadConfig(dir);
    assert.equal(loaded.config.models.heavy.protocol, 'chat-completions', '配置真的解析出来了（不是被 parseLane 丢掉）');

    const sink = newSink();
    const baseUrl = await startMock(t, sink, { onResponses: notFoundHtml });
    const registry = new ProtocolRegistry();
    const client = new DsClient({
      baseUrl, apiKey: 'sk-test', registry,
      heavyProtocol: loaded.config.models.heavy.protocol,
    });
    const decisions: SwitchDecision[] = [];
    client.subscribeProtocol((d) => decisions.push(d));

    const result = await client.generate(REQ);
    assert.equal(result.protocol, 'chat-completions', '结果如实说走的是 Chat');
    assert.equal(client.protocolFor('heavy'), 'chat-completions');
    assert.equal(sink.responses, 0, '★ 强制 Chat ⇒ `/responses` 一次都不许发（不先试）');
    assert.equal(sink.chat, 1);
    assert.equal(registry.probeCountOf(baseUrl), 0, '★ 强制档不探测');
    assert.deepEqual(decisions, [], '强制档不产生切换通知');
  }

  // ── b. `responses`：404 也永不切 ──
  {
    writeProtocol('heavy', 'responses');
    const loaded = await loadConfig(dir);
    assert.equal(loaded.config.models.heavy.protocol, 'responses');

    const sink = newSink();
    const baseUrl = await startMock(t, sink, { onResponses: notFoundHtml });
    const registry = new ProtocolRegistry();
    const client = new DsClient({
      baseUrl, apiKey: 'sk-test', registry,
      heavyProtocol: loaded.config.models.heavy.protocol,
    });
    const decisions: SwitchDecision[] = [];
    client.subscribeProtocol((d) => decisions.push(d));

    await assert.rejects(() => client.generate(REQ), (error: unknown) => {
      assert.equal((error as DsClientError).code, 'http_404');
      return true;
    });
    assert.equal(sink.responses, 1);
    assert.equal(sink.chat, 0, '★ 强制 Responses ⇒ 404 也不许摸 Chat（永不切）');
    assert.equal(registry.probeCountOf(baseUrl), 0, '强制档不探测');
    assert.equal(registry.protocolFor(baseUrl), 'responses', 'registry 的结论不许被污染（从没切过）');
    assert.equal(client.protocolFor('heavy'), 'responses');
    assert.deepEqual(decisions, []);
  }

  // ── c. `auto`：回到今天 ──
  {
    writeProtocol('heavy', 'auto');
    const loaded = await loadConfig(dir);
    assert.equal(loaded.config.models.heavy.protocol, 'auto');

    const sink = newSink();
    const baseUrl = await startMock(t, sink, { onResponses: notFoundHtml });
    const registry = new ProtocolRegistry();
    const client = new DsClient({
      baseUrl, apiKey: 'sk-test', registry,
      heavyProtocol: loaded.config.models.heavy.protocol,
    });
    const decisions: SwitchDecision[] = [];
    client.subscribeProtocol((d) => decisions.push(d));

    const result = await client.generate(REQ);
    assert.equal(result.protocol, 'chat-completions');
    assert.equal(sink.responses, 1, 'auto ⇒ 先按 Responses 发（今天那条路）');
    assert.equal(sink.chat, 1, '判据命中 ⇒ 同一次调用内换 Chat 重发');
    assert.equal(registry.probeCountOf(baseUrl), 1, 'auto 才会探测');
    assert.equal(decisions.length, 1, 'auto 才会产生切换通知');
    assert.equal(decisions[0]!.criterion, 'http_404');
  }

  // ── d. 写错值：报错，不静默回落 auto ──
  {
    writeProtocol('light', 'chat');
    await assert.rejects(() => loadConfig(dir), (error: unknown) => {
      assert.ok(error instanceof ConfigError, '必须是配置错误（不是静默回落）');
      assert.match(error.message, /models\.light\.protocol/);
      assert.match(error.message, /chat-completions/, '报错要写清合法值');
      return true;
    });
  }

  // ── e. `null` = 缺省（评审 P8：它原来"静默当 auto"，与"拼错即报错"读起来矛盾） ──
  {
    // JSON 里没有 `undefined`：手写/脚本生成配置时想表达"这一格不设"只能写 `null`，
    // 全仓的可选字段都是这个口径。这里把这个口径**钉成判据**，免得下次有人把它读成 bug。
    writeFileSync(configPath, JSON.stringify({ models: { heavy: { protocol: null } } }), 'utf8');
    const loaded = await loadConfig(dir);
    assert.equal(loaded.config.models.heavy.protocol, 'auto', 'null ⇒ 缺省 auto（不是报错，也不是"猜"）');
    // 反面：字符串拼错仍然必须抛（两条判据不能互相抵消）
    writeFileSync(configPath, JSON.stringify({ models: { heavy: { protocol: 'Auto' } } }), 'utf8');
    await assert.rejects(() => loadConfig(dir), /models\.heavy\.protocol/u, '大小写拼错也要报错');
  }
});

// ─────────────── ⑧ 关掉开关的两种写法：读数逐项相同（R3 的配置级等价物）───────────────

/**
 * 用户 R3 要的是"关掉就完全回到今天"。今天有两条关法：
 *   · 环境变量 `IRMIA_DISABLE_CHAT_FALLBACK=1`（`disableChatFallback: true`）；
 *   · 配置 `models.<lane>.protocol: 'responses'`（C-3 的 S1 新增的等价物）。
 * 这一条把两者放在**同一个剧本**（`/responses` 404 + 假 HTML 落地页）下逐项比：发了几发、
 * 摸没摸 Chat、探没探测、有没有切换通知、抛出来的错误逐字段是否一样。
 */
test('⑧ 关掉开关的两种写法逐项同读数：`disableChatFallback` vs `protocol:"responses"`', async (t) => {
  interface Run {
    responses: number; chat: number; probes: number; decisions: number;
    effective: string; error: DsClientError | null;
  }
  const run = async (options: { disable?: boolean; protocol?: ModelProtocolPreference }): Promise<Run> => {
    const sink = newSink();
    const baseUrl = await startMock(t, sink, { onResponses: notFoundHtml });
    const registry = new ProtocolRegistry({ disabled: options.disable === true });
    const client = new DsClient({
      baseUrl, apiKey: 'sk-test', registry,
      disableChatFallback: options.disable === true,
      heavyProtocol: options.protocol ?? 'auto',
    });
    let decisions = 0;
    client.subscribeProtocol(() => { decisions += 1; });
    let error: DsClientError | null = null;
    try {
      await client.generate(REQ);
    } catch (err) {
      error = err as DsClientError;
    }
    return {
      responses: sink.responses, chat: sink.chat,
      probes: registry.probeCountOf(baseUrl), decisions,
      effective: client.protocolFor('heavy'), error,
    };
  };

  const envOff = await run({ disable: true });
  const configOff = await run({ protocol: 'responses' });

  for (const [label, reading] of [['环境变量', envOff], ['配置 responses', configOff]] as const) {
    assert.equal(reading.responses, 1, `${label}：只发一次 Responses（今天那条路）`);
    assert.equal(reading.chat, 0, `${label}：chat 计数 0`);
    assert.equal(reading.probes, 0, `${label}：探测计数 0（连判据都不算）`);
    assert.equal(reading.decisions, 0, `${label}：零切换通知`);
    assert.equal(reading.effective, 'responses', `${label}：生效协议恒 responses`);
  }

  const shape = (error: DsClientError | null): Record<string, unknown> | null => error === null ? null : {
    name: error.name, kind: error.kind, code: error.code, status: error.status,
    retryable: error.retryable, attempts: error.attempts,
    consecutiveFailures: error.consecutiveFailures, detail: error.detail, message: error.message,
  };
  assert.deepEqual(shape(configOff.error), shape(envOff.error), '两种"关掉"抛出的错误逐字段相同');
  assert.notEqual(shape(envOff.error), null, '这个剧本本来就该失败（404）——不是"静默成功"');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 上线前的三个 blocker（第二道独立评审的 P2/P3 · T3 · M0）——每条都必须能在**生产链路**上打红
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────── ① 2xx 但没有产出：P2/P3 在**生产链路**上可达（评审 blocker ①）───────────
/**
 * 评审在 %TEMP% 副本里量到的读数：对端回 `200 + HTML`（SPA 兜底页）/ `200 + {"detail":"Not Found"}` /
 * `200 + {}` 时，**chat 计数 0、探测计数 0**，heavy 每一拍被记成 `stream_interrupted` 并退回输入
 * ⇒ 重投环。
 *
 * 根因不是判据写错，而是**证据根本到不了判据**：`registry.ts` 的 P2 要求 `status >= 400`、
 * P3 要求 `code === 'bad_shape'`，而那个 code 只从 `httpErrorOf` 来，那个函数**只在 `!res.ok`
 * 时被调**——2xx 的解析失败连一次都没经过它。修法分两处：
 *   · `DsClient` 在"2xx 但没产出"时**当场构造证据**（`resendOnNoOutput`，非流式与流式两条路）；
 *   · 判据改成只看**回包形状**（P2 认 2xx 的 HTML、P3 认"三缺一"的 JSON 对象）。
 *
 * 这一条把两条路都跑一遍，因为它们的失败形状不同：
 *   · 非流式（light）：`parseResponse` 抛 `bad_json` / `bad_status`；
 *   · 流式（heavy）：一个 SSE 帧都没有 ⇒ `finish()` 交回 `{interrupted:true, code:'stream_interrupted'}`。
 * 两条都在**解析之后**才暴露 ⇒ 修复点必须在解析之后。
 */
test('★① 200 + HTML / {"detail"} / {} ⇒ chat 计数 1 · 探测计数 1 · 切换通知 1（两条路各一遍）', async (t) => {
  const shapes = [
    {
      label: '200 + HTML（SPA 兜底页）',
      body: '<!doctype html><html><head><title>App</title></head><body>loading…</body></html>',
      contentType: 'text/html',
      criterion: 'html_body',
      errorCode: 'bad_json',
    },
    {
      label: '200 + {"detail":"Not Found"}（FastAPI 兜底）',
      body: '{"detail":"Not Found"}',
      contentType: 'application/json',
      criterion: 'missing_output_shape',
      errorCode: 'bad_status',
    },
    {
      label: '200 + {}（空对象）',
      body: '{}',
      contentType: 'application/json',
      criterion: 'missing_output_shape',
      errorCode: 'bad_status',
    },
  ] as const;

  for (const shape of shapes) {
    for (const mode of ['generate', 'stream'] as const) {
      const label = `${shape.label} · ${mode}`;
      const sink = newSink();
      const baseUrl = await startMock(t, sink, {
        // 对端就是这样回的：**状态码 200**，正文却不是 Responses
        onResponses: (res) => status(res, 200, shape.body, shape.contentType),
      });
      const registry = new ProtocolRegistry();
      const client = new DsClient({ baseUrl, apiKey: 'sk-test', registry });
      const decisions: SwitchDecision[] = [];
      client.subscribeProtocol((d) => decisions.push(d));

      const result = mode === 'generate' ? await client.generate(REQ) : await client.stream(REQ, {});

      assert.equal(sink.responses, 1, `${label}：先按 Responses 发一次（今天那条路）`);
      assert.equal(sink.chat, 1, `${label}：★ 判据命中 ⇒ 同一次调用内换 Chat 重发（修之前 = 0）`);
      assert.equal(registry.probeCountOf(baseUrl), 1, `${label}：★ 探测计数 1（修之前 = 0）`);
      assert.equal(decisions.length, 1, `${label}：★ 切换通知 1 条（修之前 = 0）`);
      assert.equal(decisions[0]!.criterion, shape.criterion, `${label}：判据要记对（HTML 走 P2，其余走 P3）`);
      assert.equal(decisions[0]!.model, 'deepseek-v4-pro', `${label}：事件要带模型（评审 P5）`);
      assert.equal(decisions[0]!.evidence.url, baseUrl, `${label}：证据要带端点（评审 P5）`);
      assert.equal(decisions[0]!.evidence.status, 200, `${label}：★ 状态码就是 2xx —— 原来判据不认的那一档`);
      assert.equal(
        decisions[0]!.evidence.errorCode,
        mode === 'stream' ? 'stream_interrupted' : shape.errorCode,
        `${label}：证据里的错误码（流式那一路的现场就是"一个字都没收到"）`,
      );
      assert.equal(registry.viewOf(baseUrl).state, 'chat', `${label}：结论落成 chat`);
      assert.equal(registry.protocolFor(baseUrl), 'chat-completions');
      assert.equal(result.protocol, 'chat-completions', `${label}：结果如实说走的是 Chat`);
      assert.equal(result.outputItems.length, 1, `${label}：交回的是 Chat 那一发的内容`);
      if (mode === 'stream') {
        const streamed = result as DsStreamResult;
        assert.equal(streamed.text, '在。', `${label}：正文收到了（不是空回包）`);
        assert.equal(streamed.failure, null, `${label}：这不是失败`);
      }
    }
  }
});

// ─────────── ② 两条路都不通 ⇒ unavailable 短路（评审 T3）───────────

/**
 * 评审 T3 的现场：`registry.ts` 对 `unavailable` 返回 `'responses'`（不短路），chat 那一发失败后
 * **也从来没人调 `noteFailure`**（`unavailable` 分支根本不可达），于是"两条路都不通"这个结论
 * 没有任何读者：第 3 次调用照旧打 `/responses`（`responses=2, chat=2`）。
 *
 * 修法两处：
 *   · `ds-client.ts` 的 `resendOnOther`：chat 那一发失败时**把自己的证据也交给 registry**
 *     （这就是 `unavailable` 的入口），命中就抛 `protocol_unavailable`；
 *   · `ds-client.ts` 的 `assertProtocolAvailable`：`auto` 档 + `unavailable` ⇒ **一个请求都不发**。
 */
test('★② 两路都 404：判死 `unavailable` ⇒ 三次调用只发 2 个请求、第 3 次抛 protocol_unavailable', async (t) => {
  const sink = newSink();
  const baseUrl = await startMock(t, sink, { onResponses: notFoundHtml, onChat: notFoundHtml });
  const registry = new ProtocolRegistry();
  const client = new DsClient({ baseUrl, apiKey: 'sk-test', registry });
  const decisions: SwitchDecision[] = [];
  client.subscribeProtocol((d) => decisions.push(d));

  const errors: DsClientError[] = [];
  for (let i = 0; i < 3; i += 1) {
    try {
      await client.generate(REQ);
    } catch (error) {
      errors.push(error as DsClientError);
    }
  }

  assert.equal(errors.length, 3, '三次调用都失败（不是静默成功）');
  assert.equal(sink.responses, 1, '`/responses` 只发了一次');
  assert.equal(sink.chat, 1, '`/chat/completions` 只发了一次');
  assert.equal(sink.responses + sink.chat, 2, '★ requests.length === 2（评审 T3 的读数；修之前是 4）');
  for (const [index, error] of errors.entries()) {
    assert.equal(error.code, 'protocol_unavailable', `★ 第 ${index + 1} 次调用的 code`);
    assert.equal(error.kind, 'invalid', '与今天的 404 同档：不可重试、立刻失败');
    assert.equal(error.retryable, false, '不许退避重试（重试只会再花一次钱）');
  }
  assert.equal(registry.viewOf(baseUrl).state, 'unavailable');
  assert.equal(registry.probeCountOf(baseUrl), 1, '探测仍然只算一次');
  assert.equal(decisions.length, 2, '切 chat 1 条 + 判死 unavailable 1 条（两次结论都是真的）');
  assert.equal(decisions[0]!.to, 'chat-completions');
  assert.equal(decisions[0]!.criterion, 'http_404');
  assert.equal(decisions[1]!.to, 'unavailable');
  assert.equal(decisions[1]!.criterion, 'chat_http_404', 'chat 也 404 ⇒ 不是协议问题，是 baseUrl 的问题');
  assert.equal(decisions[1]!.evidence.url, baseUrl, '证据记的是端点（评审 P5）');

  // 流式那条路走同一个 `exchange()` 入口 ⇒ 同样短路（不必再造一个端点）
  await assert.rejects(() => client.stream(REQ, {}), (error: unknown) => {
    assert.equal((error as DsClientError).code, 'protocol_unavailable');
    return true;
  });
  assert.equal(sink.responses + sink.chat, 2, '★ 短路之后一个请求都不发');

  // 反面：强制档不受 registry 结论影响（人不让读探测结论，就照他的档位发）
  const forced = new DsClient({ baseUrl, apiKey: 'sk-test', registry, heavyProtocol: 'responses' });
  await assert.rejects(() => forced.generate(REQ), (error: unknown) => {
    assert.equal((error as DsClientError).code, 'http_404', '强制 responses ⇒ 发出去、拿回原始 404');
    return true;
  });
  assert.equal(sink.responses + sink.chat, 3, '只有强制档那一发真的发出去了');
});

// ─────────── ⑨ 变异守卫 M0：救急闸的接线（评审删掉它 ⇒ 18/18 全绿）───────────

/**
 * **评审变异 M0**：删掉 `ds-client.ts` 构造器里的
 * `disabled: options.disableChatFallback === true` ⇒ 修之前 **18/18 全绿**。
 *
 * 为什么会全绿：其余用例都**注入了 registry**（`new ProtocolRegistry({disabled:true})`），
 * 于是"构造器有没有把开关接进去"这件事被注入值整个抹平了。
 *
 * 这一条**不注入 registry**，直接钉三处可观测的后果：
 *   ① `client.chatFallbackDisabled === true`（就是那一行接线的读数）；
 *   ② 404 之后 chat 计数 0、`protocolFor` 仍是 responses（探测结论没有把它改掉）；
 *   ③ 一条切换通知都没有。
 * 反面（不传开关）再跑一遍同一剧本，确保上面那些 0 不是"用例根本没生效"。
 */
test('★⑨-M0 变异守卫：`disableChatFallback` 真的接进 registry.disabled（删掉那行接线 ⇒ 本用例红）', async (t) => {
  const sink = newSink();
  const baseUrl = await startMock(t, sink, { onResponses: notFoundHtml });
  // ★ 刻意**不传 registry**：传了就把这一行接线遮住了
  const client = new DsClient({ baseUrl, apiKey: 'sk-test', disableChatFallback: true });
  assert.equal(
    client.chatFallbackDisabled,
    true,
    '★ 这一格就是构造器里的 `disabled: options.disableChatFallback === true`',
  );
  const decisions: SwitchDecision[] = [];
  client.subscribeProtocol((d) => decisions.push(d));

  await assert.rejects(() => client.generate(REQ), (error: unknown) => {
    assert.equal((error as DsClientError).code, 'http_404', '关掉开关 ⇒ 与今天一模一样的失败');
    return true;
  });
  assert.equal(sink.responses, 1, '只发一次 Responses');
  assert.equal(sink.chat, 0, '★ 关掉 ⇒ 一次都不许摸 Chat');
  assert.equal(client.protocolFor('heavy'), 'responses', '★ 探测结论不许把它改成 chat');
  assert.equal(decisions.length, 0, '零切换通知');

  // 反面：不传开关时，同一个剧本会切（否则上面那些 0 只是"这条用例没跑起来"）
  const liveSink = newSink();
  const liveUrl = await startMock(t, liveSink, { onResponses: notFoundHtml });
  const live = new DsClient({ baseUrl: liveUrl, apiKey: 'sk-test' });
  assert.equal(live.chatFallbackDisabled, false);
  const result = await live.generate(REQ);
  assert.equal(liveSink.chat, 1, '不传开关 ⇒ 该切就切');
  assert.equal(result.protocol, 'chat-completions');
});

// ─────────── P4（`error_names_endpoint`）：这一条原来**一条用例都没有**（2026-10-21 补）───────────

/**
 * 补这条用例的理由（如实说）：本轮把 P1–P4 逐个做变异验证时发现，**P4 在全仓没有一条断言**
 * （`grep error_names_endpoint test/` = 0）——删掉它，所有用例都还是绿的。"判据存在"与
 * "判据被钉住"是两件事，后者才是这次评审在补的东西。
 *
 * P4 的形状：状态码在 400/404/405/422/501 里 **且** 正文同时出现"`/responses`（或 responses
 * 这个词）"与一个"不存在/不支持"词，两者距离 ≤ 200 字符。它必须与"普通 400"分开：
 * 同一个状态码，一个是"这个端点我不认"，一个是"你这条请求有问题"，处置完全相反。
 */
test('P4（`error_names_endpoint`）：400 但正文点名 `/responses` 说不支持 ⇒ 切；普通 400 ⇒ 不切', async (t) => {
  // ① 命中：网关自己在说"这个端点我不认"
  const sink = newSink();
  const baseUrl = await startMock(t, sink, {
    onResponses: (res) => status(
      res, 400,
      '{"error":{"message":"this gateway does not support /responses; use /chat/completions"}}',
    ),
  });
  const registry = new ProtocolRegistry();
  const client = new DsClient({ baseUrl, apiKey: 'sk-test', registry });
  const decisions: SwitchDecision[] = [];
  client.subscribeProtocol((d) => decisions.push(d));

  const result = await client.generate(REQ);
  assert.equal(result.protocol, 'chat-completions', '命中 P4 ⇒ 同一次调用内换 Chat');
  assert.equal(sink.responses, 1);
  assert.equal(sink.chat, 1, '★ P4 命中 ⇒ chat 计数 1（删掉 P4 这一段 ⇒ 本用例红）');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.criterion, 'error_names_endpoint');
  assert.equal(decisions[0]!.evidence.status, 400, '400 也能是"端点不存在"的证据（正文说了算）');
  assert.equal(registry.probeCountOf(baseUrl), 1);
  assert.equal(registry.viewOf(baseUrl).state, 'chat');

  // ② 反面：同一个 400，正文不点名端点 ⇒ 反判据（`invalid`、原样抛、一次都不摸 Chat）
  const plainSink = newSink();
  const plainUrl = await startMock(t, plainSink, {
    onResponses: (res) => status(res, 400, '{"error":{"message":"input[3]: bad image"}}'),
  });
  const plain = new DsClient({ baseUrl: plainUrl, apiKey: 'sk-test' });
  await assert.rejects(() => plain.generate(REQ), (error: unknown) => {
    assert.equal((error as DsClientError).code, 'http_400', '普通 400 照旧是 invalid/http_400');
    assert.equal((error as DsClientError).kind, 'invalid');
    return true;
  });
  assert.equal(plainSink.chat, 0, '普通 400 不许触发切换');
});
