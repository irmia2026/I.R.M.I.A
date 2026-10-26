/**
 * 模型探测（`src/model/probe.ts`）—— 用**本地真 HTTP 假服务器**钉住八条契约：
 *
 *   ① 正常：模型清单去重升序 + 两套协议各探一次（请求体逐字对拍）；
 *   ② 没有 `/models`（404）⇒ `no-models-endpoint`；
 *   ③ 401 ⇒ `unauthorized`；
 *   ④ 12 秒总时限（用例调小）⇒ `unreachable`；
 *   ⑤ 只有 Chat 通 ⇒ `responses.supported=false`，推荐仍然给第一个模型；
 *   ⑥ `data: []` ⇒ `ok:true` + `models: []` + `recommended:null` + 警告；
 *   ⑦ baseUrl 带尾斜杠 / 带路径 ⇒ 请求打到 `/v1/models`（不出现 `//`）；
 *   ⑧ 三类失败的消息里都**不含 key**（字符串断言）。
 *
 * 另外两条边界单独立案（不在用户点名的那八条里，但同一份契约的一部分）：
 *   · 两套协议都失败 ⇒ 仍然回 `latencyMs` 与 `status`；
 *   · 502/500 这种"端点回了话但不是模型清单"⇒ `probe-failed`，不冒充"没有 /models"。
 *
 * 假服务器的形状照真实供应商抄：`GET /models` 回 `{data:[{id}]}`，两套协议各回 200/404/500。
 * 探测本身只读：用例除了断言请求形状，也断言**没有**发出第四条请求。
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import test, { type TestContext } from 'node:test';

import { probeModels, type ModelProbeSuccess, type ProtocolProbeResult } from '../src/model/probe.ts';

/**
 * 故意带一个可搜索的标记：任何一处把它写进响应/错误，`JSON.stringify` 断言就会红。
 *
 * ⚠ 形状**刻意不是** `sk-…`：那会撞上 `tools/sanitize-audit.mjs` 的 `api-key` 结构性模式
 * （`test/` 会同步进公开副本）——脱敏闸门要抓的正是 `sk-` 长串，夹具不该长成它要抓的样子。
 * 这条用例验的是"key 不许泄漏"，与"key 长什么样"无关。
 */
const KEY = 'probe-fake-credential-do-not-leak-9f3c';
const MODEL = 'alpha-model';

interface SeenRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface Reply {
  status?: number;
  body?: string;
  /** 永不响应（超时用例）。收尾时由 closeAllConnections 放掉。 */
  hang?: boolean;
}

interface FakeProvider {
  base: string;
  seen: SeenRequest[];
  route(path: string, reply: Reply): void;
}

/** 起一个本地 HTTP 假供应商；每个用例一个，收尾时强关（含挂住的连接）。 */
async function startProvider(t: TestContext): Promise<FakeProvider> {
  const routes = new Map<string, Reply>();
  const seen: SeenRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://placeholder');
      seen.push({
        method: req.method ?? '',
        path: url.pathname,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const reply = routes.get(url.pathname) ?? { status: 404, body: '{}' };
      if (reply.hang === true) return;
      res.statusCode = reply.status ?? 200;
      res.setHeader('content-type', 'application/json');
      // 不让客户端连接池留下 keep-alive 连接：每个用例一个临时端口，端口会被系统复用，
      // 上一条用例遗留的空闲 socket 落到同一个 origin 上时，下一条会偶发 ECONNRESET
      // （全量跑时实测撞过：404 那条偶发读成 unreachable）。
      res.setHeader('connection', 'close');
      res.end(reply.body ?? '{}');
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('假供应商没拿到端口');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  return {
    base: `http://127.0.0.1:${address.port}`,
    seen,
    route: (path, reply) => {
      routes.set(path, reply);
    },
  };
}

function modelsBody(ids: string[]): string {
  return JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });
}

function assertNoKey(result: unknown, where: string): void {
  const text = JSON.stringify(result);
  assert.equal(text.includes(KEY), false, `${where}：响应/错误里不许出现 key`);
  assert.equal(text.includes(encodeURIComponent(KEY)), false, `${where}：编码后的 key 也不许出现`);
}

/** 两套协议请求体的**逐字**契约（少一个字段、多一个字段都算破了线上形状）。 */
function assertProbeBodies(provider: FakeProvider): void {
  const responses = provider.seen.find((entry) => entry.path === '/responses');
  assert.ok(responses !== undefined, '应当向 /responses 发过一次最小请求');
  assert.equal(responses.method, 'POST');
  assert.deepEqual(JSON.parse(responses.body), {
    model: MODEL,
    input: [{ role: 'user', content: 'hi' }],
    max_output_tokens: 1,
    stream: false,
  });
  const chat = provider.seen.find((entry) => entry.path === '/chat/completions');
  assert.ok(chat !== undefined, '应当向 /chat/completions 发过一次最小请求');
  assert.equal(chat.method, 'POST');
  assert.deepEqual(JSON.parse(chat.body), {
    model: MODEL,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 1,
    stream: false,
  });
  // 两条协议请求都带着同一把 Bearer（头里，不在 URL 里）
  assert.equal(responses.headers.authorization, `Bearer ${KEY}`);
  assert.equal(chat.headers.authorization, `Bearer ${KEY}`);
}

test('① 正常：models 去重升序 + 两套协议各探一次 + 推荐当前配置的模型', async (t) => {
  const provider = await startProvider(t);
  provider.route('/models', {
    body: modelsBody(['zeta-model', 'alpha-model', 'zeta-model', '']),
  });
  provider.route('/responses', { body: '{"id":"resp_1"}' });
  provider.route('/chat/completions', { body: '{"choices":[]}' });

  const result = await probeModels({ baseUrl: `${provider.base}/`, apiKey: KEY, model: MODEL });
  assert.ok(result.ok, '正常端点应当成功');
  const ok: ModelProbeSuccess = result;

  assert.deepEqual(ok.models, ['alpha-model', 'zeta-model'], '去重 + 按字典序升序');
  assert.equal(typeof ok.modelsLatencyMs, 'number');
  assert.ok(ok.modelsLatencyMs >= 0);
  assert.deepEqual(
    { supported: ok.responses.supported, status: ok.responses.status },
    { supported: true, status: 200 },
    'Responses 通了',
  );
  assert.deepEqual(
    { supported: ok.chat.supported, status: ok.chat.status },
    { supported: true, status: 200 },
    'Chat 通了',
  );
  assert.ok(ok.responses.latencyMs >= 0 && ok.chat.latencyMs >= 0);
  assert.equal(ok.recommended, MODEL, '两套协议都通且当前配置的模型在列表里 ⇒ 推荐它');
  assert.deepEqual(ok.warnings, [], '没有警告');

  assertProbeBodies(provider);
  // 只该有三次请求：/models + 两条协议；没有第四条
  assert.equal(provider.seen.length, 3, `不该有别的请求（实际：${provider.seen.map((s) => s.path).join(', ')}）`);
  assert.equal(provider.seen[0]?.path, '/models');
  assert.equal(provider.seen[0]?.headers.authorization, `Bearer ${KEY}`);
  assertNoKey(result, '正常探测');
});

test('② 没有 /models（404）⇒ no-models-endpoint，且不再探协议', async (t) => {
  const provider = await startProvider(t);
  provider.route('/models', { status: 404, body: '{"error":{"message":"not found"}}' });

  const result = await probeModels({ baseUrl: provider.base, apiKey: KEY, model: MODEL });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'no-models-endpoint');
  assert.match(result.message, /没有 \/models/u);
  assert.match(result.message, /模型名只能手填/u);
  assert.equal(provider.seen.filter((entry) => entry.path === '/responses').length, 0, '拿不到清单就不探协议');
  assertNoKey(result, '404');
});

test('③ 401 ⇒ unauthorized（与"没有 /models"分开）', async (t) => {
  const provider = await startProvider(t);
  provider.route('/models', { status: 401, body: '{"error":{"message":"invalid api key"}}' });

  const result = await probeModels({ baseUrl: provider.base, apiKey: KEY, model: MODEL });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'unauthorized');
  assert.match(result.message, /HTTP 401/u);
  assertNoKey(result, '401');
});

test('④ 超时（12 秒口径可注入）⇒ unreachable，消息带时限', async (t) => {
  const provider = await startProvider(t);
  provider.route('/models', { hang: true });

  const result = await probeModels({ baseUrl: provider.base, apiKey: KEY, timeoutMs: 120 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'unreachable');
  assert.match(result.message, /120 毫秒内没有响应/u);
  assertNoKey(result, '超时');
});

test('⑤ 只有 Chat 通 ⇒ Responses 标不支持，推荐仍是列表第一个', async (t) => {
  const provider = await startProvider(t);
  provider.route('/models', { body: modelsBody(['m-one', 'm-two']) });
  provider.route('/responses', { status: 404, body: '{}' });
  provider.route('/chat/completions', { body: '{"choices":[]}' });

  const result = await probeModels({ baseUrl: provider.base, apiKey: KEY, model: 'm-one' });
  assert.ok(result.ok);
  const ok: ModelProbeSuccess = result;
  assert.deepEqual(ok.models, ['m-one', 'm-two']);
  assert.equal(ok.responses.supported, false);
  assert.equal(ok.responses.status, 404);
  assert.equal(ok.chat.supported, true);
  assert.equal(ok.chat.status, 200);
  assert.equal(ok.recommended, 'm-one', 'Responses 不通、Chat 通 ⇒ 列表第一个');
  assert.equal(ok.warnings.some((line) => line.includes('不支持 Responses')), true, '要说清哪套协议不通');
});

test('⑥ models 为空数组 ⇒ ok:true / models:[] / recommended:null + 警告', async (t) => {
  const provider = await startProvider(t);
  provider.route('/models', { body: modelsBody([]) });
  provider.route('/responses', { body: '{"id":"resp_1"}' });
  provider.route('/chat/completions', { body: '{"choices":[]}' });

  // 不传 model、列表也空 ⇒ 没有可探的模型名：协议这一轮没有结论
  const result = await probeModels({ baseUrl: provider.base, apiKey: KEY });
  assert.ok(result.ok, '空列表是一个可判定的结果，不是失败');
  const ok: ModelProbeSuccess = result;
  assert.deepEqual(ok.models, []);
  assert.equal(ok.recommended, null);
  assert.equal(ok.warnings.length > 0, true);
  assert.equal(ok.warnings.some((line) => line.includes('空列表')), true);
  assert.equal(ok.responses.supported, false);
  assert.equal(ok.responses.status, null, '没有模型名 ⇒ 没发协议请求，status 是 null');
  assert.equal(provider.seen.filter((entry) => entry.path === '/responses').length, 0);
  assertNoKey(result, '空列表');
});

test('⑦ baseUrl 带尾斜杠 + 带路径 + 带 query ⇒ 路径拼对、query 落在最后', async (t) => {
  const provider = await startProvider(t);
  provider.route('/v1/models', { body: modelsBody(['m-one']) });
  provider.route('/v1/responses', { body: '{"id":"resp_1"}' });
  provider.route('/v1/chat/completions', { body: '{"choices":[]}' });

  const result = await probeModels({
    // 真实供应商常见带 api-version 一类查询参数：拼子路径时 query 必须在最后，
    // 不许出现 `?api-version=…/models` 那种"把路径塞进 query"的地址。
    baseUrl: `${provider.base}/v1/?api-version=2026-01-01`,
    apiKey: KEY,
    model: 'm-one',
  });
  assert.ok(result.ok);
  assert.deepEqual(
    provider.seen.map((entry) => entry.path),
    ['/v1/models', '/v1/responses', '/v1/chat/completions'],
    '尾斜杠只去掉一层，路径原样保留，拼接处不出现 //',
  );
  const ok: ModelProbeSuccess = result;
  assert.equal(ok.recommended, 'm-one');
});

test('⑧ 失败消息里不含 key（不可达 / 401 / 404 三类逐条断言）', async (t) => {
  const provider = await startProvider(t);

  provider.route('/models', { hang: true });
  const unreachable = await probeModels({ baseUrl: provider.base, apiKey: KEY, timeoutMs: 80 });
  assert.equal(unreachable.ok, false);
  assertNoKey(unreachable, '不可达');

  provider.route('/models', { status: 401, body: '{}' });
  const unauthorized = await probeModels({ baseUrl: provider.base, apiKey: KEY });
  assert.equal(unauthorized.ok, false);
  assertNoKey(unauthorized, '401');

  provider.route('/models', { status: 404, body: 'not-json' });
  const noEndpoint = await probeModels({ baseUrl: provider.base, apiKey: KEY });
  assert.equal(noEndpoint.ok, false);
  assertNoKey(noEndpoint, '404');

  // 消息里也不许出现请求头那种形态
  for (const result of [unreachable, unauthorized, noEndpoint]) {
    if (result.ok) continue;
    assert.equal(result.message.includes('Bearer'), false, '错误消息里不出现凭据形态');
  }
});

test('⑨ 两套协议都失败：仍然带回 latency 与 status，推荐为 null', async (t) => {
  const provider = await startProvider(t);
  provider.route('/models', { body: modelsBody(['m-one', 'm-two']) });
  provider.route('/responses', { status: 404, body: '{}' });
  provider.route('/chat/completions', { status: 500, body: '{}' });

  const result = await probeModels({ baseUrl: provider.base, apiKey: KEY, model: 'm-one' });
  assert.ok(result.ok);
  const ok: ModelProbeSuccess = result;
  const responses: ProtocolProbeResult = ok.responses;
  const chat: ProtocolProbeResult = ok.chat;
  assert.deepEqual({ supported: responses.supported, status: responses.status }, { supported: false, status: 404 });
  assert.deepEqual({ supported: chat.supported, status: chat.status }, { supported: false, status: 500 });
  assert.ok(responses.latencyMs >= 0 && chat.latencyMs >= 0, '失败也要有耗时读数');
  assert.equal(ok.recommended, null, '两套都不通 ⇒ 不推荐');
  assert.equal(ok.warnings.some((line) => line.includes('两套协议都没探通')), true);
});

test('⑩ 端点回了 500（不是"没有 /models"）⇒ probe-failed，不冒充 404 那一档', async (t) => {
  const provider = await startProvider(t);
  provider.route('/models', { status: 500, body: '{"error":{"message":"boom"}}' });

  const result = await probeModels({ baseUrl: provider.base, apiKey: KEY });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'probe-failed');
  assert.match(result.message, /HTTP 500/u);
  assertNoKey(result, '500');
});
