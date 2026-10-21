/**
 * **Chat Completions 适配器**（`src/model/transport/chat-completions.ts`）的判据。
 *
 * 它钉四件事，顺序对应 `docs/design-protocol-fallback.md` 的 C 阶段：
 *
 *   ① **请求形状**（§3.1 的 24 行表）：`messages` 怎么摊、`reasoning` 一条都不发、
 *      图片多一层对象、`tools` 多包一层 `function`、`developer → system`、
 *      **`json_schema` 降级成 `json_object` 并补一条 system 指令**（不补 = 吐空白到 64K）；
 *   ② **错误分类**（用户 2026-10-21 拍的口径）：同一 HTTP 400，两套协议给出**同一 `kind`/`code`**；
 *      Chat 独有的 code 落不进已知分类 ⇒ 保留原话；协议没实现 ⇒ 回退共用表；
 *   ③ **归一化对拍**（C 阶段最强的判据）：**同一份剧本，两套协议各跑一遍**，
 *      `DsStreamResult` 的正文/工具调用/usage/结束原因**逐字段相等**；
 *   ④ **六值 `finish_reason`** 与两条"最容易错"的：`aborted`（对端的，不是她的）、
 *      `insufficient_system_resource`（算力不足 ⇒ 可重试的 server 类）。
 *
 * ⚠ 有一条**不是**测出来的东西，写在这里免得被误读：本文件全部走本地 mock server，
 * 没有一次真实网络请求；对端到底怎么回，仍是设计 §10 的"未实测"。
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';

import { chatCompletionsTransport } from '../src/model/transport/chat-completions.ts';
import { responsesTransportParts } from '../src/model/transport/responses.ts';
import type { ModelTransport, TransportErrorInput } from '../src/model/transport/types.ts';
import { DsClient, DsClientError, type DsClientOptions, type DsRequest, type DsStreamResult } from '../src/model/ds-client.ts';

const IMAGE_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ──────────────────────────────── 夹具 ────────────────────────────────

/** 与字节底片同一个富夹具：input 五种 item 齐全 + 七格全给 */
const RICH: DsRequest = {
  lane: 'heavy',
  model: 'deepseek-v4-pro',
  input: [
    { type: 'message', role: 'user', content: '在吗' },
    { type: 'reasoning', content: [{ type: 'reasoning_text', text: '先看一眼日志。' }] },
    { type: 'message', role: 'assistant', content: '在。' },
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '[图片] shot.png' },
        { type: 'input_image', image_url: IMAGE_URL },
      ],
    },
    { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"file_path":"a.txt"}' },
    { type: 'function_call_output', call_id: 'call_1', output: '内容' },
    { type: 'message', role: 'developer', content: '[策略拒绝] 工具 pwsh：没开' },
  ],
  instructions: '你是 Irmia。',
  tools: [{ type: 'function', name: 'read_file', description: '只读文件', parameters: { type: 'object' } }],
  reasoning: { effort: 'high' },
  maxOutputTokens: 8192,
  text: { type: 'json_schema', name: 'verdict', schema: { type: 'object', properties: { risky: { type: 'boolean' } } } },
  temperature: 0.7,
  topP: 0.95,
};

/** 造好的一份 Chat 请求体（测试里反复要看它） */
function chatBodyOf(request: DsRequest, stream = false): Record<string, unknown> {
  const built = chatCompletionsTransport.buildRequest(request, { model: 'deepseek-v4-pro', user: 'irmia-agent', stream });
  assert.equal(built.url, '/chat/completions');
  return built.body;
}

interface ChatMessageShape {
  role: string;
  content: unknown;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

function messagesOf(body: Record<string, unknown>): ChatMessageShape[] {
  return body['messages'] as ChatMessageShape[];
}

// ──────────────────────────── ① 请求形状（§3.1 的 24 行表）────────────────────────────

test('请求形状 · 端点、四格底座与"三条不发"（user / stream_options / tool_choice）', () => {
  const body = chatBodyOf(RICH);
  assert.equal(body['model'], 'deepseek-v4-pro');
  assert.equal(body['stream'], false);
  // §3.1 第 19/23/18 行：这三格**都不发**
  assert.equal('user' in body, false, '不发 user（Chat 侧叫 user_id，发错名字风险更大）');
  assert.equal('user_id' in body, false, '也不发 user_id（单租户不需要隔离）');
  assert.equal('stream_options' in body, false, '不发 stream_options（DeepSeek 保证最后一块带 usage）');
  assert.equal('tool_choice' in body, false, '不发 tool_choice（思考模式不支持 required/指定 tool）');
  assert.equal('frequency_penalty' in body, false);
  assert.equal('presence_penalty' in body, false);
});

test('请求形状 · `instructions` → `messages[0]=system`，`developer` → `system`，`reasoning` 一条都不发', () => {
  const body = chatBodyOf(RICH);
  const messages = messagesOf(body);
  assert.equal(messages[0]!.role, 'system', '§3.1 第 2 行：人格层必须落在 messages[0]');
  assert.equal(messages[0]!.content, '你是 Irmia。');
  // developer 落到 system（老兼容层不认 developer）
  assert.ok(
    messages.some((m) => m.role === 'system' && m.content === '[策略拒绝] 工具 pwsh：没开'),
    '§3.1 第 6 行：developer 必须映射成 system',
  );
  // ★ 纪律 1：思维链一条都不发
  assert.equal(JSON.stringify(body).includes('reasoning_text'), false, '不许发 reasoning_text');
  assert.equal(JSON.stringify(body).includes('先看一眼日志'), false, '思维链正文一个字节都不许进 Chat 请求');
});

test('请求形状 · 图片多一层对象、tools 多包一层 function、工具调用挂 assistant / 工具结果走 tool 角色', () => {
  const body = chatBodyOf(RICH);
  const messages = messagesOf(body);
  // 图片：`{type:'image_url', image_url:{url}}`（§3.1 第 7 行）
  const imageMessage = messages.find(
    (m) => Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some((p) => p.type === 'image_url'),
  );
  assert.ok(imageMessage !== undefined, '带图那条消息必须在');
  assert.deepEqual(imageMessage.content, [
    { type: 'text', text: '[图片] shot.png' },
    { type: 'image_url', image_url: { url: IMAGE_URL } },
  ]);
  // tools：`{type:'function', function:{name,description,parameters}}`（§3.1 第 12 行）
  assert.deepEqual((body['tools'] as unknown[])[0], {
    type: 'function',
    function: { name: 'read_file', description: '只读文件', parameters: { type: 'object' } },
  });
  // 工具调用：挂在紧邻的 assistant 上；结果走 role:'tool'（§3.1 第 9/10 行）
  const callHost = messages.find((m) => Array.isArray(m.tool_calls));
  assert.ok(callHost !== undefined, '必须有一条 assistant 带着 tool_calls');
  assert.equal(callHost.role, 'assistant');
  assert.deepEqual(callHost.tool_calls!.map((c) => c.id), ['call_1']);
  const toolMessage = messages.find((m) => m.role === 'tool');
  assert.ok(toolMessage !== undefined);
  assert.equal(toolMessage.tool_call_id, 'call_1');
  assert.equal(toolMessage.content, '内容');
});

test('请求形状 · 思考强度 1:1 透传、上限走 max_tokens、温度两格原样', () => {
  const body = chatBodyOf(RICH);
  assert.equal(body['reasoning_effort'], 'high', '§3.7 第 5 条：DeepSeek 枚举与我们同一套，直接透传');
  assert.equal(body['max_tokens'], 8192);
  assert.equal(body['temperature'], 0.7);
  assert.equal(body['top_p'], 0.95);
  // 四个枚举值都原样过（不换算、不省略）
  for (const effort of ['none', 'low', 'high', 'max'] as const) {
    assert.equal(chatBodyOf({ lane: 'light', input: 'x', reasoning: { effort } })['reasoning_effort'], effort);
  }
});

test('★ 请求形状 · `json_schema` 必须降级成 `json_object` **并补一条 system 指令**（不补 = 空白到 64K）', () => {
  // 富夹具：有 instructions，指令排在它后面
  const withInstructions = messagesOf(chatBodyOf(RICH));
  assert.deepEqual(chatBodyOf(RICH)['response_format'], { type: 'json_object' });
  const hint = withInstructions.find((m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('risky'));
  assert.ok(hint !== undefined, 'system 指令里必须带上 schema 的字段名（否则模型不知道形状）');
  assert.ok(String(hint.content).includes('只输出 JSON'), '必须明写"只输出 JSON"（官方要求的那句）');

  // ★ memory-maintain 那两条 prompt 自己**没写**"输出 JSON" ⇒ 这条指令是唯一的保障
  const noInstructions = messagesOf(chatBodyOf({
    lane: 'light',
    input: '把流水账整理成事实',
    text: { type: 'json_schema', name: 'memory_operations', schema: { type: 'object', properties: { op: { type: 'string' } } } },
  }));
  assert.equal(noInstructions[0]!.role, 'system', '没有 instructions 时，这条指令必须成为 messages[0]');
  assert.ok(String(noInstructions[0]!.content).includes('只输出 JSON'));
  assert.equal(noInstructions[1]!.role, 'user');

  // 另外两支：`text` 不发；`json_object` 直发且**不**补指令
  const plain = chatBodyOf({ lane: 'light', input: 'x', text: { type: 'text' } });
  assert.equal('response_format' in plain, false, '`text` 是缺省值 ⇒ 不发');
  const jsonObject = chatBodyOf({ lane: 'light', input: 'x', text: { type: 'json_object' } });
  assert.deepEqual(jsonObject['response_format'], { type: 'json_object' });
  assert.equal(messagesOf(jsonObject).some((m) => m.role === 'system'), false, 'json_object 不需要补指令');
});

test('请求形状 · falsy / 空形状：空 tools 不发、空 instructions 不出 system、0 值照发', () => {
  const empty = chatBodyOf({ lane: 'light', input: 'x', instructions: '', tools: [] });
  assert.equal('tools' in empty, false, '空 tools 数组不许发（§3.1 第 12 行同 Responses 的"有值才发"）');
  assert.equal(messagesOf(empty).some((m) => m.role === 'system'), false, '空 instructions 不出 system 消息');
  const zeros = chatBodyOf({ lane: 'light', input: '', maxOutputTokens: 0, temperature: 0, topP: 0 });
  assert.equal(zeros['max_tokens'], 0);
  assert.equal(zeros['temperature'], 0);
  assert.equal(zeros['top_p'], 0);
  assert.equal(messagesOf(zeros)[0]!.content, '', '空 input 照发（不静默改写）');
});

test('请求形状 · 流式只多一个 `stream:true`（accept 头由 send 决定）', () => {
  const body = chatBodyOf(RICH, true);
  assert.equal(body['stream'], true);
  const built = chatCompletionsTransport.buildRequest(RICH, { model: 'm', user: 'u', stream: true });
  assert.equal(built.stream, true);
});

// ──────────────────────── ② 错误分类（同一 400，两套同一 code/kind）────────────────────────

function errorInput(overrides: Partial<TransportErrorInput> = {}): TransportErrorInput {
  return {
    status: 400,
    retryAfterMs: null,
    bodyText: '{"error":{"message":"bad thing","type":"invalid_request_error","code":"invalid_request_error","param":null}}',
    envelope: { message: 'bad thing', type: 'invalid_request_error', code: 'invalid_request_error', param: '' },
    ...overrides,
  };
}

test('错误分类 · 同一 HTTP 400 ⇒ 两套协议同一 `kind`/`code`/`status`/`retryable`；Chat 额外带服务端原话', () => {
  const responses = responsesTransportParts.classifyError!(errorInput());
  const chat = chatTransportClassify(errorInput());
  for (const key of ['kind', 'code', 'status', 'retryable'] as const) {
    assert.deepEqual(chat[key], responses[key], `400 的 ${key} 必须与 Responses 逐字相同（上层不分叉）`);
  }
  assert.equal(responses.kind, 'invalid');
  assert.equal(responses.code, 'http_400');
  assert.ok(chat.message.includes('bad thing'), 'Chat 侧要把服务端原话带出来（"保留原话"）');
  assert.equal(responses.message.includes('bad thing'), false, 'Responses 保持今天的措辞（一个字都不改）');
});

test('错误分类 · Chat 特有 code 落不进已知分类 ⇒ 仍按状态表，原话留在 message/detail', () => {
  const chat = chatTransportClassify(errorInput({
    status: 422,
    bodyText: '{"error":{"message":"weird provider code","code":"my_custom_code"}}',
    envelope: { message: 'weird provider code', type: '', code: 'my_custom_code', param: '' },
  }));
  assert.equal(chat.kind, 'invalid', '落不进已知分类 ⇒ 状态表说了算');
  assert.equal(chat.code, 'http_422', 'code 仍是状态码（与 Responses 同一形状）');
  assert.ok(chat.message.includes('weird provider code'), '原话必须留着');
  assert.ok((chat.detail ?? '').includes('my_custom_code'), 'detail 里保留整段正文（含那个 code）');
});

test('错误分类 · 跨状态的限流码：`rate_limit_exceeded` 塞进 400 ⇒ 仍判可重试（这是 Chat 侧的知识）', () => {
  const chat = chatTransportClassify(errorInput({
    status: 400,
    bodyText: '{"error":{"message":"slow down","code":"rate_limit_exceeded"}}',
    envelope: { message: 'slow down', type: '', code: 'rate_limit_exceeded', param: '' },
  }));
  assert.equal(chat.kind, 'rate_limited', '限流伪装成 400 时，分类要跟着 code 走（否则我们会放弃一个可重试的请求）');
  assert.equal(chat.code, 'http_400');
  assert.equal(chat.retryable, true);
});

test('错误分类 · HTML/空正文（信封取不到）⇒ 两套都按状态表，不崩', () => {
  const responses = responsesTransportParts.classifyError!(errorInput({ status: 502, bodyText: '<html>bad gateway</html>', envelope: null }));
  const chat = chatTransportClassify(errorInput({ status: 502, bodyText: '<html>bad gateway</html>', envelope: null }));
  assert.equal(responses.kind, 'server');
  assert.equal(chat.kind, 'server');
  assert.equal(chat.code, 'http_502');
});

/** `classifyError` 是可选方法；用一次断言把它"确实实现了"钉住，再调用 */
function chatTransportClassify(input: TransportErrorInput): DsClientError {
  const fn = chatCompletionsTransport.classifyError;
  assert.equal(typeof fn, 'function', 'Chat 必须实现 classifyError（用户 2026-10-21 拍）');
  return fn.call(chatCompletionsTransport, input);
}

// ──────────────────────────── 假服务端：两套协议各一条剧本 ────────────────────────────

interface Recorded {
  url: string;
  body: string;
}

/** 起一个 mock：`/responses` 与 `/chat/completions` 各按剧本回 SSE 或 JSON */
async function startDualMock(t: TestContext, sink: Recorded[], mode: 'stream' | 'json'): Promise<string> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('error', () => {});
    res.on('error', () => {});
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      sink.push({ url: req.url ?? '', body });
      const wantsStream = body.includes('"stream":true');
      if (req.url === '/responses') {
        if (!wantsStream || mode === 'json') {
          const payload = JSON.stringify({
            id: 'resp_1', status: 'completed', model: 'deepseek-flash',
            output: [
              { type: 'reasoning', id: 'rs_1', content: [{ type: 'reasoning_text', text: '想一想。' }] },
              { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: '在。' }] },
              { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'pwsh', arguments: '{"command":"date"}' },
            ],
            usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 } },
          });
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
          res.end(payload);
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const frame = (type: string, payload: unknown): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...(payload as object) })}\n\n`;
        res.write(frame('response.reasoning_text.delta', { item_id: 'rs_1', delta: '想一想。' }));
        res.write(frame('response.output_text.delta', { item_id: 'msg_1', delta: '在。' }));
        res.write(frame('response.output_item.added', {
          output_index: 2,
          item: { id: 'fc_1', type: 'function_call', status: 'in_progress', call_id: 'call_9', name: 'pwsh', arguments: '' },
        }));
        res.write(frame('response.function_call_arguments.delta', { item_id: 'fc_1', delta: '{"command":' }));
        res.write(frame('response.function_call_arguments.delta', { item_id: 'fc_1', delta: '"date"}' }));
        res.write(frame('response.completed', {
          response: {
            id: 'resp_1', status: 'completed', model: 'deepseek-flash',
            output: [
              { type: 'reasoning', id: 'rs_1', content: [{ type: 'reasoning_text', text: '想一想。' }] },
              { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: '在。' }] },
              { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'pwsh', arguments: '{"command":"date"}' },
            ],
            usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 } },
          },
        }));
        res.end();
        return;
      }
      // /chat/completions
      if (!wantsStream || mode === 'json') {
        const payload = JSON.stringify({
          id: 'chat_1', object: 'chat.completion', model: 'deepseek-flash',
          choices: [{
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant', content: '在。', reasoning_content: '想一想。',
              tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'pwsh', arguments: '{"command":"date"}' } }],
            },
          }],
          usage: {
            prompt_tokens: 100, completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 80 },
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
        res.end(payload);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
      res.write(chunk({ id: 'chat_1', model: 'deepseek-flash', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '想一想。' }, finish_reason: null }] }));
      res.write(chunk({ id: 'chat_1', model: 'deepseek-flash', choices: [{ index: 0, delta: { content: '在。' }, finish_reason: null }] }));
      // 工具调用：id/name 只在首片出现（§3.2 —— 按 index 归并的那条）
      res.write(chunk({ id: 'chat_1', model: 'deepseek-flash', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'pwsh', arguments: '' } }] }, finish_reason: null }] }));
      res.write(chunk({ id: 'chat_1', model: 'deepseek-flash', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] }, finish_reason: null }] }));
      res.write(chunk({ id: 'chat_1', model: 'deepseek-flash', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"date"}' } }] }, finish_reason: null }] }));
      // ★ DeepSeek 的真实形状：`[DONE]` 之前最后一块**同时**是终态与 usage（没有只含 usage 的独立块）
      res.write(chunk({
        id: 'chat_1', model: 'deepseek-flash',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 5 } },
      }));
      res.write('data: [DONE]\n\n');
      res.end();
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

/** 归一化：把两套协议的结果压成"能对拍的那几个字段" */
function normalized(result: DsStreamResult): Record<string, unknown> {
  return {
    text: result.text,
    reasoning: result.reasoning,
    toolCalls: result.toolCalls,
    usage: result.usage,
    status: result.status,
    interrupted: result.interrupted,
    failure: result.failure,
    incompleteReason: result.incompleteReason,
    model: result.model,
  };
}

function clientFor(baseUrl: string, transport: ModelTransport, extra: Partial<DsClientOptions> = {}): DsClient {
  // `transportOverride.responses` 就是"这条 lane 用这个传输"的注入点（协议选择在 C-3 接）
  return new DsClient({ baseUrl, apiKey: 'sk-test', user: 'irmia-deploy-01', transportOverride: { responses: transport }, ...extra });
}

// ─────────────────── ③ 归一化对拍：同一份剧本，两套协议逐字段相等 ───────────────────

test('★ 归一化对拍（流式）：两套协议的 text/reasoning/toolCalls/usage/finishReason 逐字段相等', async (t) => {
  const sink: Recorded[] = [];
  const baseUrl = await startDualMock(t, sink, 'stream');
  const request: DsRequest = { lane: 'heavy', input: '几点了' };

  const viaResponses = await clientFor(baseUrl, responsesTransportParts).stream(request, {});
  const viaChat = await clientFor(baseUrl, chatCompletionsTransport).stream(request, {});

  assert.deepEqual(normalized(viaChat), normalized(viaResponses), '归一化之后必须逐字段相等');
  // 顺带把"相等的是什么"写死，免得两边一起错
  assert.equal(viaChat.text, '在。');
  assert.equal(viaChat.reasoning, '想一想。');
  assert.deepEqual(viaChat.toolCalls, [{ callId: 'call_9', name: 'pwsh', arguments: '{"command":"date"}' }]);
  assert.deepEqual(viaChat.usage, { inputTokens: 100, outputTokens: 20, cachedTokens: 80, reasoningTokens: 5 });
  assert.equal(viaChat.status, 'completed');
  assert.equal(viaChat.failure, null);
  // 两发都只发了一条请求（**没重试**：最后一块的 usage 被正确接住，没有被误判成空回包）
  assert.equal(sink.filter((r) => r.url === '/chat/completions').length, 1);
});

test('★ 归一化对拍（非流式）：`generate()` 那条路同样逐字段相等', async (t) => {
  const sink: Recorded[] = [];
  const baseUrl = await startDualMock(t, sink, 'json');
  const request: DsRequest = { lane: 'light', input: '几点了' };
  const viaResponses = await clientFor(baseUrl, responsesTransportParts).generate(request);
  const viaChat = await clientFor(baseUrl, chatCompletionsTransport).generate(request);
  const view = (r: typeof viaChat): Record<string, unknown> => ({
    status: r.status,
    outputTypes: r.outputItems.map((i) => i.type),
    usage: r.usage,
    incompleteReason: r.incompleteReason,
  });
  assert.deepEqual(view(viaChat), view(viaResponses));
  assert.deepEqual(view(viaChat).outputTypes, ['reasoning', 'message', 'function_call']);
});

// ──────────────────────────── ④ 六值 finish_reason + 两条易错点 ────────────────────────────

/** 起一个"只回一段流、按给定 chunk 剧本"的 mock（专测结束原因） */
async function startScriptMock(t: TestContext, chunks: readonly unknown[], tail: string = 'data: [DONE]\n\n'): Promise<string> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const buffer: Buffer[] = [];
    req.on('data', (c: Buffer) => buffer.push(c));
    req.on('error', () => {});
    res.on('error', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      if (tail !== '') res.write(tail);
      res.end();
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

function chatChunk(delta: Record<string, unknown>, finish: string | null = null): unknown {
  return { id: 'chat_1', model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason: finish }] };
}

test('finish_reason 六值 · `length` ⇒ incomplete/max_output_tokens；`content_filter` ⇒ incomplete/content_filter', async (t) => {
  for (const [reason, expected] of [['length', 'max_output_tokens'], ['content_filter', 'content_filter']] as const) {
    const baseUrl = await startScriptMock(t, [chatChunk({ content: '半句' }, reason)]);
    const result = await clientFor(baseUrl, chatCompletionsTransport).stream({ lane: 'heavy', input: 'x' }, {});
    assert.equal(result.incompleteReason, expected, `${reason} 必须映射成 ${expected}`);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.failure, null, '上游说"没说完"不是失败');
  }
});

test('★ finish_reason 六值 · `aborted` 是**对端**掐的 ⇒ 必须走失败路径，且不许冒充她的 aborted', async (t) => {
  const baseUrl = await startScriptMock(t, [chatChunk({ content: '半句' }, 'aborted')]);
  const result = await clientFor(baseUrl, chatCompletionsTransport).stream({ lane: 'heavy', input: 'x' }, {});
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.code, 'upstream_aborted', '映射成我们自己的 aborted 会让 runStep 记成"她按了停"、失败不记账');
  assert.equal(result.interrupted, false, 'interrupted 只说"没收到终态"，这里终态收到了');
});

test('finish_reason 六值 · `insufficient_system_resource` ⇒ 可重试的 server 类失败', async (t) => {
  const baseUrl = await startScriptMock(t, [chatChunk({ content: '半句' }, 'insufficient_system_resource')]);
  const result = await clientFor(baseUrl, chatCompletionsTransport).stream({ lane: 'heavy', input: 'x' }, {});
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.code, 'insufficient_system_resource');
});

test('[DONE] 只是哨兵：没有 finish_reason ⇒ incomplete + stream_interrupted，不许记成"说完了"', async (t) => {
  const baseUrl = await startScriptMock(t, [chatChunk({ content: '说到一半' })]);
  const result = await clientFor(baseUrl, chatCompletionsTransport).stream({ lane: 'heavy', input: 'x' }, {});
  assert.equal(result.status, 'incomplete');
  assert.equal(result.failure?.code, 'stream_interrupted');
  assert.equal(result.text, '说到一半', '已收的部分照旧交付');
});

test('只有思维链、没有正文 ⇒ 不当成 completed（与 Responses 同一个 empty 判据）', async (t) => {
  const baseUrl = await startScriptMock(t, [chatChunk({ reasoning_content: '想了很久' }, 'stop')]);
  const result = await clientFor(baseUrl, chatCompletionsTransport).stream({ lane: 'heavy', input: 'x' }, {});
  assert.equal(result.status, 'incomplete', '没吐出正文 ⇒ 不许记成 completed');
  assert.equal(result.reasoning, '想了很久', '思维链本身照旧交付（观测用）');
  assert.equal(result.failure, null, '这不是"调用失败"，只是没有可用产出');
});

// ─────────────────── ⑤ Chat 不能比 Responses 更容易挂（P1 的回归网在 C 里再跑一次）───────────────────

test('★ P1 回归（Chat 侧）：适配器在 `parseStream` 就抛 ⇒ 定时器被清、错误原样抛出、无 unhandledRejection', async (t) => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);
  const before = process.getActiveResourcesInfo().filter((n) => n === 'Timeout').length;
  try {
    // ⭐ C-3 起累积器造在 exchange() 之后 ⇒ 先让 HTTP 那一跳成功
    const baseUrl = await startScriptMock(t, [], '');
    const client = new DsClient({
      baseUrl,
      apiKey: 'sk-test',
      transportOverride: { responses: chatCompletionsTransport },
    });
    // 今天 `chatCompletionsTransport` 已经实现了 parseStream（不再抛），所以这里**换掉它**模拟
    // "适配器内部炸了"——那正是 R2 要兜的那一类，也是 P1 定时器泄漏的触发点。
    (client as unknown as { transportOverride: { responses: ModelTransport } }).transportOverride.responses = {
      ...chatCompletionsTransport,
      parseStream: () => { throw new Error('inject: chat parseStream 崩了'); },
    };
    await assert.rejects(
      () => client.stream({ lane: 'heavy', input: 'x' }, {}),
      (error: unknown) => {
        assert.equal((error as Error).message, 'inject: chat parseStream 崩了', '错误原样抛出');
        return true;
      },
    );
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.equal(
      process.getActiveResourcesInfo().filter((n) => n === 'Timeout').length - before,
      0,
      '静默计时器与硬顶必须被清掉（P1 的回归网）',
    );
    assert.deepEqual(rejections, [], '不许有 unhandledRejection');
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 断流的口径（评审 blocker ③ + 变异守卫 M5）
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 一个"**先说半句、然后永远沉默**"的服务端：响应头 200 立刻到、推一段正文、之后一片都不再发。
 *
 * 这是静默闸（`silenceMs`）而不是"连接断了"的形状，也正是**两套协议都必须报同一个 code** 的现场。
 * 按 url 分派：`/responses` 用 Responses 的增量帧，`/chat/completions` 用 Chat 的 chunk。
 */
async function startStallMock(t: TestContext): Promise<string> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('error', () => {});
    res.on('error', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (req.url === '/responses') {
        res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({
          type: 'response.output_text.delta', item_id: 'm1', output_index: 0, delta: '前三个字',
        })}\n\n`);
      } else {
        // ⚠ 刻意**不带 usage**：断流那一拍本来就没有 usage，这正是 `usageMissing` 的现场之一
        res.write(`data: ${JSON.stringify({
          id: 'chat_1', choices: [{ index: 0, delta: { content: '前三个字' }, finish_reason: null }],
        })}\n\n`);
      }
      // 不 end()、不再写：连接挂着、一个字都不来 ⇒ 静默闸开火
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

/**
 * **评审 T1 的复刻**：同一个断流剧本，两套协议各跑一遍。
 *
 * 修之前：Responses 报 `timeout_silent`（好），**Chat 报 `stream_interrupted`（错）**——
 * `chat-completions.ts` 的 `settleTransportFailure` 只是 `return build(true)`，而 `build` 在
 * `finishReason === null` 时自己造一条 `{code:'stream_interrupted'}` ⇒ **把 `error.code` 抹掉了**。
 * 那是我们唯一能指认"哪只闸掐的"的指纹：静默超时该重连、硬顶该放弃、调用方中断不该记账——
 * 三种处置完全不同，抹平之后长得一模一样。
 *
 * 断言用 `normalized()`（与第 ③ 组"归一化对拍"同一把尺）：两套协议的 `DsStreamResult` 逐字段相等。
 */
test('★③ 断流对拍（评审 T1）：两套协议都报 `timeout_silent`，且已收正文都留着', async (t) => {
  const baseUrl = await startStallMock(t);
  const options: Partial<DsClientOptions> = { silenceMs: 120, hardCapMs: 60_000, timeoutMs: 60_000 };
  const viaResponses = await clientFor(baseUrl, responsesTransportParts, options)
    .stream({ lane: 'heavy', input: '说点什么' }, {});
  const viaChat = await clientFor(baseUrl, chatCompletionsTransport, options)
    .stream({ lane: 'heavy', input: '说点什么' }, {});

  // ① 已收正文必须留着（中断结算的既有语义：`hasPartialOutput` 为真就交付已收部分）
  assert.equal(viaResponses.text, '前三个字');
  assert.equal(viaChat.text, '前三个字', 'Chat 断流也要把已收正文交出去');
  // ② ★ 指纹：是哪只闸掐的
  assert.equal(viaResponses.failure?.code, 'timeout_silent');
  assert.equal(
    viaChat.failure?.code,
    'timeout_silent',
    '★ 修之前这里是 `stream_interrupted`（`build` 把 error.code 抹掉了）',
  );
  assert.match(viaChat.failure?.message ?? '', /没有收到任何数据/u, '消息也要说清是哪只闸');
  // ③ 逐字段对齐（与"归一化对拍"同一把尺）
  assert.deepEqual(normalized(viaChat), normalized(viaResponses), '断流这一路的 DsStreamResult 必须逐字段相等');
  // ④ 对端没给 usage ⇒ 四格全 0，但账上必须说得出"这 0 是不知道"（评审 P4 的同一条链路）
  assert.equal(viaChat.usage.inputTokens, 0);
  assert.equal(viaChat.usageMissing, true, '不给 usage 的那一拍要能被认出来（`budget/consumed.usageMissing` 的来源）');
  assert.equal(viaResponses.usageMissing, true);
});

/**
 * **评审变异 M5**：把 Chat 的 `settleTransportFailure` 改成一味 `throw`（丢掉已收正文）⇒ 修之前 **46/46 全绿**。
 *
 * 这一条不依赖上一条的"对拍"，它单独钉住两件事：
 *   ① 已收正文**不许丢**（`stream()` 必须**返回**结果，不是抛错）；
 *   ② `failure.code` 必须是**原始的** `timeout_silent`（不是 `stream_interrupted`）。
 * 变异之后的表现：`client.stream(...)` 变成一个 reject ⇒ 本用例当场红。
 */
test('★⑨-M5 变异守卫：Chat 断流改成一味 throw ⇒ 本用例红（保留已收正文 + 保留 code）', async (t) => {
  const baseUrl = await startStallMock(t);
  const result = await clientFor(baseUrl, chatCompletionsTransport, { silenceMs: 120, hardCapMs: 60_000 })
    .stream({ lane: 'heavy', input: '说点什么' }, {});

  assert.equal(result.text, '前三个字', '★ 已收正文必须交出去（改成一味 throw 就把它丢了）');
  assert.equal(result.interrupted, true, '没收到终态 ⇒ interrupted');
  assert.equal(result.status, 'incomplete', '断流没有上游终态可报，不许写成 failed');
  assert.equal(result.failure?.code, 'timeout_silent', '★ code 必须是原始的（不是 stream_interrupted）');
});


// ─────────────────────── 多模态（C-4 重点）：数量 / 顺序 / 字节 ───────────────────────

/**
 * ★ **同一份带图历史，两套协议归一化后图片逐项相等**。
 *
 * 三个层次都要等：① 数量（几进几出，不许丢不许加）② 顺序（先后影响"哪张是第一张"）
 * ③ 字节（`data:` URL 一个字节都不重编码）。
 *
 * 为什么这三条就够：**窗口与压缩全在渲染层**（`render.ts` 的 `IMAGE_INJECT_MAX` /
 * `pickedImageSeqs` / `.ctx.jpg` 那条路），两套协议吃的是**同一份渲染产物** ——
 * 模型看到哪几张、压成什么样，与协议无关；transport 只负责换形状。
 */
test('★ 多模态：同一份历史下，图片的数量 / 顺序 / 字节两套协议逐项相等', () => {
  const IMG_A = 'data:image/png;base64,AAAA';
  const IMG_B = 'data:image/jpeg;base64,BBBB';
  const request: DsRequest = {
    lane: 'heavy',
    input: [
      { type: 'message', role: 'user', content: '第一张' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[a]' }, { type: 'input_image', image_url: IMG_A }] },
      { type: 'message', role: 'assistant', content: '看到了。' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[b]' }, { type: 'input_image', image_url: IMG_B }] },
    ],
  };
  // Responses：图片在 `input[]` 的 item 里，形状是 {type:'input_image', image_url}
  const responsesBody = responsesTransportParts.buildRequest(request, { model: 'm', user: 'u', stream: false }).body;
  const responsesImages = (responsesBody['input'] as Array<Record<string, unknown>>)
    .flatMap((item) => (Array.isArray(item['content']) ? item['content'] as Array<Record<string, unknown>> : []))
    .filter((part) => part['type'] === 'input_image')
    .map((part) => part['image_url']);
  // Chat：图片在 `messages[].content[]` 里，形状是 {type:'image_url', image_url:{url}}
  const chatBody = chatCompletionsTransport.buildRequest(request, { model: 'm', user: 'u', stream: false }).body;
  const chatImages = messagesOf(chatBody)
    .flatMap((message) => (Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : []))
    .filter((part) => part['type'] === 'image_url')
    .map((part) => (part['image_url'] as { url?: unknown }).url);

  assert.deepEqual(chatImages, responsesImages, '①数量 ②顺序 ③字节：三层都必须一致');
  assert.deepEqual(chatImages, [IMG_A, IMG_B], '顺序就是 input 里的先后（不重排、不去重）');
});

/**
 * 官方硬规则：图片**只能**放在 `user` / `developer`（`system`）里；放 `assistant` ⇒ 对端 400。
 *
 * 渲染层只会把图挂在 `role:'user'` 上（`render.ts` 三处），所以这条守卫在生产路径上一次都不触发。
 * 这里刻意把一个图塞进 assistant，钉的是"**丢图保文，不报 400**"这个降级分寸。
 */
test('多模态 · 图片放错角色 ⇒ 丢图保文（不报 400），user 里的照旧进', () => {
  const request: DsRequest = {
    lane: 'heavy',
    input: [
      { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: '旧的那张' }, { type: 'input_image', image_url: 'data:image/png;base64,CCCC' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '新的这张' }, { type: 'input_image', image_url: 'data:image/png;base64,DDDD' }] },
    ],
  };
  const chatBody = chatCompletionsTransport.buildRequest(request, { model: 'm', user: 'u', stream: false }).body;
  const messages = messagesOf(chatBody);
  const assistant = messages.find((m) => m.role === 'assistant');
  assert.ok(assistant !== undefined);
  const assistantParts = (Array.isArray(assistant.content) ? assistant.content : []) as Array<{ type?: string }>;
  assert.equal(assistantParts.some((p) => p.type === 'image_url'), false, '★ assistant 里的图必须被丢掉（否则整条 400）');
  assert.equal(assistantParts.some((p) => p.type === 'text'), true, '但文字要保留（不该因为图丢了整条消息）');
  const user = messages.find((m) => m.role === 'user');
  assert.ok(user !== undefined);
  assert.equal((user.content as Array<{ type?: string }>).some((p) => p.type === 'image_url'), true, 'user 里的图照旧进');
  // 对照：Responses 那边原样透传（它没有这条限制）—— 这是一处"有损但刻意"
  const responsesBody = responsesTransportParts.buildRequest(request, { model: 'm', user: 'u', stream: false }).body;
  assert.equal(JSON.stringify(responsesBody).includes('CCCC'), true, 'Responses 不改写（它本来就允许这种位置）');
});
