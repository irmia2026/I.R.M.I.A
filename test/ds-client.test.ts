/**
 * DeepSeek Responses API 客户端测试（src/model/ds-client.ts）
 *
 * 全部走本地 node:http mock server：不发真实网络请求、不需要 API key。
 * 覆盖：正常响应解析（含 cached_tokens）、SSE 增量与终态、429 尊重 Retry-After 的退避、
 * 400 不重试、200 空内容计 empty（有限 3 次）、超时分类、连接失败计 network、
 * 流中断保留已收部分（对齐 milestones M2-9）、withRetry 退避曲线与 attempts 标注。
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';

import {
  DEFAULT_MAX_RETRY_AFTER_MS,
  DsClient,
  DsClientError,
  SseFrameDecoder,
  backoffDelayMs,
  hasPartialOutput,
  hasUsableOutput,
  parseRetryAfter,
  withRetry,
  type DsOutputItem,
  type SleepFn,
} from '../src/model/ds-client.ts';

// ──────────────────────────────── mock server ────────────────────────────────

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: Record<string, unknown> | null;
}

interface MockServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/** 起一个只服务当前测试的 mock server；listen(0) 拿随机端口，避免测试间打架 */
async function startMock(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>,
): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', () => {});
    res.on('error', () => {});
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let json: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          json = parsed as Record<string, unknown>;
        }
      } catch {
        json = null;
      }
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, json });
      // 客户端超时/中断后连接已毁，处理器里迟到的 write 会抛错：吞掉它，别把测试进程带崩
      void Promise.resolve()
        .then(() => handler(req, res, body))
        .catch(() => {});
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('mock server 未能绑定端口');

  const mock: MockServer = {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  t.after(() => mock.close());
  return mock;
}

function jsonBody(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** 记录退避时长但立即返回：测试不该真的等指数退避 */
function recordingSleep(sleeps: number[]): SleepFn {
  return async (ms: number) => {
    sleeps.push(ms);
  };
}

function sseFrame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

const COMPLETE_RESPONSE = {
  id: 'resp_1',
  object: 'response',
  created_at: 1_770_000_000,
  status: 'completed',
  model: 'deepseek-v4-pro',
  output: [
    {
      type: 'reasoning',
      id: 'rs_1',
      status: 'completed',
      content: [{ type: 'reasoning_text', text: '先看一眼日志。' }],
    },
    {
      type: 'message',
      id: 'msg_1',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '我在。' }],
    },
    {
      type: 'function_call',
      id: 'fc_1',
      status: 'completed',
      call_id: 'call_1',
      name: 'read_file',
      arguments: '{"file_path":"a.txt"}',
    },
  ],
  usage: {
    input_tokens: 1200,
    input_tokens_details: { cached_tokens: 1024 },
    output_tokens: 88,
    output_tokens_details: { reasoning_tokens: 40 },
  },
};

// ──────────────────────────────── 正常响应 ────────────────────────────────

test('generate 解析响应：三类 output item、usage 与 cached_tokens、请求字段与 Bearer 头', async (t) => {
  const mock = await startMock(t, (_req, res) => jsonBody(res, 200, COMPLETE_RESPONSE));

  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test', user: 'irmia-deploy-01' });
  const response = await client.generate({
    lane: 'heavy',
    instructions: '你是 Irmia。',
    input: [{ role: 'user', content: '在吗' }],
    tools: [{ type: 'function', name: 'read_file', description: '只读文件', parameters: { type: 'object' } }],
    reasoning: { effort: 'high' },
    maxOutputTokens: 4096,
    text: { type: 'json_object' },
  });

  assert.equal(response.status, 'completed');
  assert.equal(response.incompleteReason, null);
  assert.equal(response.responseId, 'resp_1');
  assert.equal(response.model, 'deepseek-v4-pro');
  assert.deepEqual(
    response.outputItems.map((item) => item.type),
    ['reasoning', 'message', 'function_call'],
  );

  const message = response.outputItems[1];
  assert.ok(message?.type === 'message');
  assert.equal(message.text, '我在。');
  const call = response.outputItems[2];
  assert.ok(call?.type === 'function_call');
  assert.equal(call.callId, 'call_1');
  assert.equal(call.name, 'read_file');
  assert.equal(call.arguments, '{"file_path":"a.txt"}');

  // cached_tokens 必须从 input_tokens_details 里精确取到，而不是被当成未知字段丢掉
  assert.deepEqual(response.usage, {
    inputTokens: 1200,
    outputTokens: 88,
    cachedTokens: 1024,
    reasoningTokens: 40,
  });
  assert.ok(response.durationMs >= 0);

  const sent = mock.requests[0];
  assert.equal(sent?.method, 'POST');
  assert.equal(sent?.url, '/responses');
  assert.equal(sent?.headers['authorization'], 'Bearer sk-test');
  assert.equal(sent?.json?.['model'], 'deepseek-v4-pro');
  assert.equal(sent?.json?.['user'], 'irmia-deploy-01');
  assert.equal(sent?.json?.['stream'], false);
  assert.equal(sent?.json?.['max_output_tokens'], 4096);
  assert.deepEqual(sent?.json?.['reasoning'], { effort: 'high' });
  assert.deepEqual(sent?.json?.['text'], { format: { type: 'json_object' } });
  assert.equal(sent?.json?.['instructions'], '你是 Irmia。');
  assert.deepEqual(sent?.json?.['input'], [{ role: 'user', content: '在吗' }]);
});

// ──────────────────────────────── SSE 流式 ────────────────────────────────

test('stream 增量回调与终态：分块到达的 delta 也能正确拼接', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    // 故意把第一个 delta 切在 JSON 中间，验证跨 chunk 分帧
    const first = sseFrame('response.output_text.delta', { item_id: 'msg_1', output_index: 0, delta: '你' });
    res.write(first.slice(0, 12));
    res.write(first.slice(12));
    res.write(sseFrame('response.output_text.delta', { item_id: 'msg_1', output_index: 0, delta: '好' }));
    res.write(sseFrame('response.output_text.delta', { item_id: 'msg_1', output_index: 0, delta: '，世界' }));
    res.write(sseFrame('response.output_text.done', { item_id: 'msg_1', text: '你好，世界' }));
    res.write(
      sseFrame('response.output_item.added', {
        output_index: 1,
        item: { id: 'fc_1', type: 'function_call', status: 'in_progress', call_id: 'call_9', name: 'pwsh', arguments: '' },
      }),
    );
    res.write(sseFrame('response.function_call_arguments.delta', { item_id: 'fc_1', delta: '{"command":' }));
    res.write(sseFrame('response.function_call_arguments.delta', { item_id: 'fc_1', delta: '"date"}' }));
    res.write(
      sseFrame('response.completed', {
        response: {
          id: 'resp_stream',
          status: 'completed',
          model: 'deepseek-flash',
          output: [
            { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: '你好，世界' }] },
            { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'pwsh', arguments: '{"command":"date"}' },
          ],
          usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 8 }, output_tokens: 5 },
        },
      }),
    );
    res.end();
  });

  const deltas: string[] = [];
  const seen: string[] = [];
  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test', lightModel: 'deepseek-flash' });
  const result = await client.stream(
    { lane: 'light', instructions: '短答', input: '几点' },
    { onTextDelta: (delta) => deltas.push(delta), onEvent: (event) => seen.push(event.type) },
  );

  assert.deepEqual(deltas, ['你', '好', '，世界']);
  assert.equal(result.text, '你好，世界');
  assert.equal(result.status, 'completed');
  assert.equal(result.interrupted, false);
  assert.equal(result.failure, null);
  assert.equal(result.responseId, 'resp_stream');
  assert.equal(result.model, 'deepseek-flash');
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, cachedTokens: 8, reasoningTokens: 0 });
  assert.deepEqual(result.toolCalls, [{ callId: 'call_9', name: 'pwsh', arguments: '{"command":"date"}' }]);
  assert.ok(seen.includes('response.output_text.delta'));
  assert.ok(seen.includes('response.completed'));
  assert.equal(mock.requests[0]?.json?.['stream'], true);
  assert.equal(mock.requests[0]?.headers['accept'], 'text/event-stream');
});

test('SSE 分帧器：容忍孤立 CR 与缺尾空行的最后一帧', () => {
  const decoder = new SseFrameDecoder();
  assert.deepEqual(decoder.push('data: {"a":1}\r\n\r\n'), [{ event: null, data: '{"a":1}' }]);
  assert.deepEqual(decoder.push('data: {"b":2}\r\r'), [{ event: null, data: '{"b":2}' }]);
  assert.deepEqual(decoder.push('event: x\ndata: {"c":3}'), []);
  assert.deepEqual(decoder.flush(), [{ event: 'x', data: '{"c":3}' }]);
  assert.deepEqual(decoder.flush(), []);
});

test('流中断：保留已收部分并标 interrupted，不抛错（M2-9）', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sseFrame('response.output_text.delta', { item_id: 'msg_1', delta: '前半' }));
    // 把已写的两帧推出去再砸连接：模拟模型侧到一半断流
    setTimeout(() => res.socket?.destroy(), 30);
  });

  const deltas: string[] = [];
  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test', timeoutMs: 5_000 });
  const result = await client.stream(
    { lane: 'heavy', input: '说点什么' },
    { onTextDelta: (delta) => deltas.push(delta) },
  );

  assert.deepEqual(deltas, ['前半']);
  assert.equal(result.text, '前半');
  assert.equal(result.interrupted, true);
  assert.notEqual(result.status, 'completed');
  assert.ok(result.failure !== null);
});

// ──────────────────────── 终态失败（response.failed） ────────────────────────

/**
 * P0（2026-10-17 修）：`response.failed` 是**上游宣告的终态失败**，不是"成功收尾"。
 *
 * 客户端的合同（循环层只认这一格，见 `DsStreamResult.failure` 的注释）：
 * **`failure !== null` ⇔ 这次调用没有正常收尾**。所以这里钉的是判据落地，不是文案：
 *   · `status` 是上游说的 failed，`interrupted` 是 false（终态事件明明收到了）；
 *   · `failure` 必须非 null、码文来自终态事件里的 error；
 *   · 已收的正文、半截调用、usage 一样都不许因为"失败"就被丢掉——客户端如实交付，
 *     丢不丢 toolCalls 是循环层的纪律（`agent-loop.test.ts` 那一侧钉）。
 */
test('response.failed：终态失败必须落进 failure，已收部分与 usage 照留', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sseFrame('response.output_text.delta', { item_id: 'msg_1', output_index: 0, delta: '我先看' }));
    res.write(
      sseFrame('response.output_item.added', {
        output_index: 1,
        item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '' },
      }),
    );
    res.write(sseFrame('response.function_call_arguments.delta', { item_id: 'fc_1', delta: '{"file_pa' }));
    res.write(
      sseFrame('response.failed', {
        response: {
          id: 'resp_failed',
          status: 'failed',
          model: 'deepseek-v4-pro',
          error: { code: 'server_error', message: '上游在这次生成里崩了' },
          usage: {
            input_tokens: 321,
            input_tokens_details: { cached_tokens: 300 },
            output_tokens: 21,
            output_tokens_details: { reasoning_tokens: 7 },
          },
        },
      }),
    );
    res.end();
  });

  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test' });
  const result = await client.stream({ lane: 'heavy', input: '看日志' }, {});

  assert.equal(result.status, 'failed', '上游自己报的终态是 failed');
  assert.equal(result.interrupted, false, '终态事件收到了 ⇒ 不是"没收到终态"');
  assert.deepEqual(
    result.failure,
    { code: 'server_error', message: '上游在这次生成里崩了' },
    '失败判据必须落在 failure 上（非 null）',
  );
  assert.equal(result.text, '我先看', '已推送的正文照样交付');
  assert.deepEqual(result.toolCalls, [{ callId: 'call_1', name: 'read_file', arguments: '{"file_pa' }]);
  assert.deepEqual(result.usage, { inputTokens: 321, outputTokens: 21, cachedTokens: 300, reasoningTokens: 7 });
});

test('response.failed 没带 error 对象：failure 仍然非 null（补一条有码有文的原因）', async (t) => {
  // 真实 SSE 里出现过只有 status 的失败包：判据不许因此变成"成功"
  const mock = await startMock(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sseFrame('response.failed', { response: { id: 'resp_bare', status: 'failed', usage: {} } }));
    res.end();
  });

  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test' });
  const result = await client.stream({ lane: 'heavy', input: 'x' }, {});

  assert.equal(result.status, 'failed');
  assert.equal(result.interrupted, false);
  assert.equal(result.failure?.code, 'response_failed');
  assert.match(result.failure?.message ?? '', /failed/u);
});

test('流在终态事件前干净结束：failure 非 null（没有正常收尾就不许是 null）', async (t) => {
  // 连接正常关闭、但服务端一个终态事件都没发：不是"成功"，也不是上游宣告的 failed
  const mock = await startMock(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sseFrame('response.output_text.delta', { item_id: 'msg_1', delta: '说到一半' }));
    res.end();
  });

  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test' });
  const result = await client.stream({ lane: 'heavy', input: 'x' }, {});

  assert.equal(result.interrupted, true);
  assert.equal(result.status, 'incomplete', '没有终态可报 ⇒ status 不许写成 failed');
  assert.equal(result.failure?.code, 'stream_interrupted');
  assert.equal(result.text, '说到一半');
});

// ──────────────────────────────── 错误分类 ────────────────────────────────

test('429 尊重 Retry-After：退避取服务端提示，第三次成功', async (t) => {
  let attempt = 0;
  const mock = await startMock(t, (_req, res) => {
    attempt += 1;
    if (attempt <= 2) {
      res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
      res.end('{"error":{"message":"rate limited"}}');
      return;
    }
    jsonBody(res, 200, COMPLETE_RESPONSE);
  });

  const sleeps: number[] = [];
  const retries: number[] = [];
  const client = new DsClient({
    baseUrl: mock.url,
    apiKey: 'sk-test',
    maxAttempts: 5,
    sleep: recordingSleep(sleeps),
    onRetry: (info) => retries.push(info.delayMs),
  });
  const response = await client.generate({ lane: 'heavy', input: '在吗' });

  assert.equal(response.status, 'completed');
  assert.equal(mock.requests.length, 3);
  assert.deepEqual(sleeps, [1_000, 1_000], 'Retry-After 优先于 base·2^(n-1)=500ms');
  assert.deepEqual(retries, [1_000, 1_000]);
  assert.equal(client.failStreak, 0, '成功即清零连续失败计数');
});

test('400 不重试：直接抛 invalid 并带 consecutiveFailures', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"input is too long"}}');
  });

  const sleeps: number[] = [];
  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test', sleep: recordingSleep(sleeps) });

  await assert.rejects(
    () => client.generate({ lane: 'heavy', input: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof DsClientError);
      assert.equal(error.kind, 'invalid');
      assert.equal(error.status, 400);
      assert.equal(error.retryable, false);
      assert.equal(error.attempts, 1);
      assert.equal(error.consecutiveFailures, 1);
      assert.match(error.detail ?? '', /input is too long/);
      return true;
    },
  );

  assert.equal(mock.requests.length, 1, '同样的请求重试必然同样失败');
  assert.deepEqual(sleeps, []);
  assert.equal(client.failStreak, 1);
});

test('200 空内容计 empty：有限重试 3 次后外抛', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    jsonBody(res, 200, {
      id: 'resp_empty',
      status: 'completed',
      output: [],
      usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0 },
    });
  });

  const sleeps: number[] = [];
  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test', sleep: recordingSleep(sleeps) });

  await assert.rejects(
    () => client.generate({ lane: 'light', input: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof DsClientError);
      assert.equal(error.kind, 'empty');
      assert.equal(error.retryable, true);
      assert.equal(error.attempts, 3, 'empty 收紧到 3 次，之后走降级链');
      return true;
    },
  );

  assert.equal(mock.requests.length, 3);
  assert.equal(sleeps.length, 2);
});

test('超时分类为 timeout 并按 maxAttempts 退避', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    const timer = setTimeout(() => {
      jsonBody(res, 200, COMPLETE_RESPONSE);
    }, 300);
    timer.unref();
  });

  const sleeps: number[] = [];
  const client = new DsClient({
    baseUrl: mock.url,
    apiKey: 'sk-test',
    timeoutMs: 60,
    maxAttempts: 2,
    sleep: recordingSleep(sleeps),
  });

  await assert.rejects(
    () => client.generate({ lane: 'heavy', input: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof DsClientError);
      assert.equal(error.kind, 'timeout');
      assert.equal(error.retryable, true);
      assert.equal(error.attempts, 2);
      return true;
    },
  );

  assert.equal(mock.requests.length, 2);
  assert.equal(sleeps.length, 1);
});

test('连接失败分类为 network（不空烧重试）', async (t) => {
  const probe = await startMock(t, (_req, res) => jsonBody(res, 200, {}));
  const port = Number(new URL(probe.url).port);
  await probe.close(); // 端口就此空着：连接必然被拒

  const sleeps: number[] = [];
  const client = new DsClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'sk-test',
    maxAttempts: 1,
    timeoutMs: 2_000,
    sleep: recordingSleep(sleeps),
  });

  await assert.rejects(
    () => client.generate({ lane: 'light', input: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof DsClientError);
      assert.equal(error.kind, 'network');
      assert.equal(error.retryable, true, 'network 可退避，但需上层触发网络可用性探测');
      assert.equal(error.attempts, 1);
      return true;
    },
  );
  assert.deepEqual(sleeps, []);
});

test('调用方中断分类为 aborted，不计入连续失败', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    const timer = setTimeout(() => jsonBody(res, 200, COMPLETE_RESPONSE), 300);
    timer.unref();
  });

  const controller = new AbortController();
  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test', timeoutMs: 5_000 });
  setTimeout(() => controller.abort(), 20).unref();

  await assert.rejects(
    () => client.generate({ lane: 'heavy', input: 'x', signal: controller.signal }),
    (error: unknown) => {
      assert.ok(error instanceof DsClientError);
      assert.equal(error.kind, 'aborted');
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(client.failStreak, 0, '中断不是模型失败');
});

// ──────────────────────────────── 退避封装 ────────────────────────────────

test('withRetry 按 2 倍指数退避并在耗尽时标注 attempts', async () => {
  const sleeps: number[] = [];
  let calls = 0;

  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw new DsClientError({ kind: 'server', message: '500', status: 500 });
        },
        { maxAttempts: 3, baseDelayMs: 1_000, sleep: recordingSleep(sleeps), lane: 'heavy' },
      ),
    (error: unknown) => {
      assert.ok(error instanceof DsClientError);
      assert.equal(error.kind, 'server');
      assert.equal(error.attempts, 3);
      return true;
    },
  );

  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1_000, 2_000]);
});

test('退避曲线与 Retry-After 解析的边界', () => {
  assert.equal(backoffDelayMs(1, 500, 30_000, null), 500);
  assert.equal(backoffDelayMs(3, 500, 30_000, null), 2_000);
  assert.equal(backoffDelayMs(9, 500, 30_000, null), 30_000, '指数部分必须封顶');
  assert.equal(backoffDelayMs(1, 500, 30_000, 8_000), 8_000, '服务端提示优先');
  assert.equal(backoffDelayMs(5, 500, 30_000, 1_000), 8_000, '提示短于曲线时取曲线');
  // 2026-10-18（review P1-08）：服务端提示**有上限**——3600 秒不许变成一小时的死等
  assert.equal(DEFAULT_MAX_RETRY_AFTER_MS, 60_000);
  assert.equal(backoffDelayMs(1, 500, 30_000, 3_600_000), 60_000, 'Retry-After 超过上限就按上限睡');
  assert.equal(backoffDelayMs(1, 500, 30_000, 3_600_000, 5_000), 5_000, '上限可由调用方收紧');
  assert.equal(backoffDelayMs(1, 500, 30_000, 20_000), 20_000, '没超上限时原样尊重提示');

  assert.equal(parseRetryAfter('3'), 3_000);
  assert.equal(parseRetryAfter(' 12 '), 12_000);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('soon'), null);
  assert.equal(parseRetryAfter(new Date(Date.now() - 5_000).toUTCString()), 0, '过去时间归 0');
});

// ─────────────── review P1-06：只有思维链不算产出（两个判据） ───────────────

/** 造一条只有思维链的输出（`reasoning` 条目**也带 text**，这正是过去被误判成产出的形状） */
const REASONING_ONLY: DsOutputItem[] = [{ type: 'reasoning', id: 'rs_1', text: '先看一眼日志，再想想。' }];

test('hasUsableOutput：只有思维链 ⇒ **不是**可用产出；hasPartialOutput 认它（中断要留）', () => {
  assert.equal(hasUsableOutput(REASONING_ONLY), false, '思维链不是产出（§4.14 的 empty 类）');
  assert.equal(hasPartialOutput(REASONING_ONLY), true, '但中断结算要把它当"已收到的内容"留住');
  // 反面：有正文 / 有函数调用 ⇒ 两个判据都认
  const withText: DsOutputItem[] = [{ type: 'message', id: 'm', text: '我在。' }];
  const withCall: DsOutputItem[] = [{ type: 'function_call', id: 'fc', callId: 'c', name: 'pwsh', arguments: '{}' }];
  for (const items of [withText, withCall]) {
    assert.equal(hasUsableOutput(items), true);
    assert.equal(hasPartialOutput(items), true);
  }
  // 空白正文同样不算产出
  assert.equal(hasUsableOutput([{ type: 'message', id: 'm', text: '   ' }]), false);
});

test('generate：200 完成但只吐思维链 ⇒ 按 empty 走满 3 次重试（不再交回"空串成功"）', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    jsonBody(res, 200, {
      id: 'resp_reasoning_only',
      status: 'completed',
      output: [{ type: 'reasoning', id: 'rs_1', content: [{ type: 'reasoning_text', text: '想了很久，一个字没说。' }] }],
      usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 300 },
    });
  });

  const sleeps: number[] = [];
  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test', sleep: recordingSleep(sleeps) });

  await assert.rejects(
    () => client.generate({ lane: 'light', input: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof DsClientError);
      assert.equal(error.kind, 'empty', '只有思维链 = 空回包，不是"有产出"');
      assert.equal(error.code, 'empty_output');
      assert.equal(error.attempts, 3, 'EMPTY_MAX_ATTEMPTS 那三次重试必须真的跑');
      return true;
    },
  );
  assert.equal(mock.requests.length, 3);
  assert.equal(sleeps.length, 2);
});

test('stream：终态只有思维链 ⇒ status 落 incomplete（不再是 completed）；正常带正文的一条不受影响', async (t) => {
  let phase = 0;
  const mock = await startMock(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (phase === 0) {
      res.write(sseFrame('response.reasoning_text.delta', { item_id: 'rs_1', delta: '想了很久。' }));
      res.write(sseFrame('response.completed', {
        response: {
          id: 'resp_r', status: 'completed',
          output: [{ type: 'reasoning', id: 'rs_1', content: [{ type: 'reasoning_text', text: '想了很久。' }] }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }));
    } else {
      res.write(sseFrame('response.output_text.delta', { item_id: 'msg_1', delta: '我在。' }));
      res.write(sseFrame('response.completed', {
        response: {
          id: 'resp_t', status: 'completed',
          output: [{ type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: '我在。' }] }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }));
    }
    res.end();
  });

  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test' });
  const reasoningOnly = await client.stream({ lane: 'heavy', input: 'x' }, {});
  assert.equal(reasoningOnly.status, 'incomplete', '没吐出正文 ⇒ 不许记成 completed');
  assert.equal(reasoningOnly.text, '');
  assert.equal(reasoningOnly.reasoning, '想了很久。', '思维链本身照旧交付（观测用）');
  assert.equal(reasoningOnly.failure, null, '这不是"调用失败"，只是没有可用产出');

  phase = 1;
  const normal = await client.stream({ lane: 'heavy', input: 'x' }, {});
  assert.equal(normal.status, 'completed', '有正文的一条照旧 completed（不误伤）');
});

test('中断且**只有思维链**：照旧把已收部分交出去（不抛错、思维链不丢）', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sseFrame('response.reasoning_text.delta', { item_id: 'rs_1', delta: '想了六万五千字…' }));
    setTimeout(() => res.socket?.destroy(), 30);
  });

  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test' });
  const result = await client.stream({ lane: 'heavy', input: 'x' }, {});
  assert.equal(result.interrupted, true);
  assert.equal(result.text, '', '没有正文');
  assert.equal(result.reasoning, '想了六万五千字…', '已收的思维链必须留住（中断结算用 hasPartialOutput）');
  assert.ok(result.failure !== null, '失败原因照旧给出');
});

// ─────────────── review P1-07：usage **逐字段**累积，缺项不抹掉已拿到的数 ───────────────

test('usage 逐字段累积：终态包缺了 input 侧，也不许把先拿到的数抹成 0', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // 服务端先把输入侧的用量报出来（真实流里带 partial usage 的包就在终态之前）
    res.write(sseFrame('response.in_progress', {
      response: {
        id: 'resp_u', status: 'in_progress',
        usage: { input_tokens: 1_000, input_tokens_details: { cached_tokens: 900 } },
      },
    }));
    res.write(sseFrame('response.output_text.delta', { item_id: 'msg_1', delta: '答一句。' }));
    // 终态包**只带 output_tokens**：过去 `usage = readUsage(...)` 一次覆盖，1000/900 全变 0
    res.write(sseFrame('response.completed', {
      response: {
        id: 'resp_u', status: 'completed',
        output: [{ type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: '答一句。' }] }],
        usage: { output_tokens: 42 },
      },
    }));
    res.end();
  });

  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test' });
  const result = await client.stream({ lane: 'heavy', input: 'x' }, {});
  assert.deepEqual(result.usage, {
    inputTokens: 1_000,
    outputTokens: 42,
    cachedTokens: 900,
    reasoningTokens: 0,
  }, '逐字段取：终态没给的那几格保留先前的值，给了的照它更新');
  assert.equal(result.status, 'completed');
});

test('中断那条路：先拿到的 usage 跟着已收部分一起交出去（不再一律记 0）', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sseFrame('response.in_progress', {
      response: {
        id: 'resp_cut', status: 'in_progress',
        usage: { input_tokens: 1_200, input_tokens_details: { cached_tokens: 1_000 } },
      },
    }));
    res.write(sseFrame('response.output_text.delta', { item_id: 'msg_1', delta: '前半句' }));
    setTimeout(() => res.socket?.destroy(), 30);
  });

  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test' });
  const result = await client.stream({ lane: 'heavy', input: 'x' }, {});
  assert.equal(result.interrupted, true);
  assert.equal(result.text, '前半句');
  assert.equal(result.usage.inputTokens, 1_200, '已拿到的输入用量必须跟着走');
  assert.equal(result.usage.cachedTokens, 1_000);
  assert.equal(result.usage.outputTokens, 0, '没报过的输出就是 0（缺项不编数）');
});

// ─────────────── review P1-08：Retry-After 封顶（真按上限睡 + 标出被截断） ───────────────

test('429 带 `Retry-After: 3600`：按上限睡（不是一小时），并把"被截断"标出来', async (t) => {
  let attempt = 0;
  const mock = await startMock(t, (_req, res) => {
    attempt += 1;
    if (attempt === 1) {
      res.writeHead(429, { 'retry-after': '3600', 'content-type': 'application/json' });
      res.end('{"error":{"message":"rate limited"}}');
      return;
    }
    jsonBody(res, 200, COMPLETE_RESPONSE);
  });

  const sleeps: number[] = [];
  const infos: Array<{ delayMs: number; cappedFrom?: number }> = [];
  const client = new DsClient({
    baseUrl: mock.url,
    apiKey: 'sk-test',
    maxAttempts: 2,
    sleep: recordingSleep(sleeps),
    onRetry: (info) => {
      infos.push({
        delayMs: info.delayMs,
        ...(info.retryAfterCappedFromMs === undefined ? {} : { cappedFrom: info.retryAfterCappedFromMs }),
      });
    },
  });

  const response = await client.generate({ lane: 'heavy', input: 'x' });
  assert.equal(response.status, 'completed');
  assert.deepEqual(sleeps, [DEFAULT_MAX_RETRY_AFTER_MS], `一小时的头只许睡 ${DEFAULT_MAX_RETRY_AFTER_MS}ms`);
  assert.deepEqual(infos, [{ delayMs: DEFAULT_MAX_RETRY_AFTER_MS, cappedFrom: 3_600_000 }],
    '原值要跟着 RetryInfo 出去（装配层据此写一行日志）');

  // 反面：`Retry-After: 1` 没超上限 ⇒ 原样尊重，**不带**"被截断"那一格
  const shortAttempt = { count: 0 };
  const shortMock = await startMock(t, (_req2, res2) => {
    shortAttempt.count += 1;
    if (shortAttempt.count === 1) {
      res2.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
      res2.end('{}');
      return;
    }
    jsonBody(res2, 200, COMPLETE_RESPONSE);
  });
  const shortSleeps: number[] = [];
  let shortCapped = 0;
  const shortClient = new DsClient({
    baseUrl: shortMock.url,
    apiKey: 'sk-test',
    maxAttempts: 2,
    sleep: recordingSleep(shortSleeps),
    onRetry: (info) => { if (info.retryAfterCappedFromMs !== undefined) shortCapped += 1; },
  });
  await shortClient.generate({ lane: 'heavy', input: 'x' });
  assert.deepEqual(shortSleeps, [1_000], '没超上限的提示照旧优先于曲线');
  assert.equal(shortCapped, 0, '没截断就不许标"被截断"');
});
