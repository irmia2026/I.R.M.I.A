/**
 * **per-lane 端点与密钥**（2026-10-21，③ 的实测判据）。
 *
 * ## 这条用例钉的是什么
 *
 * 配置本来就是逐 lane 的（`models.heavy` / `models.light` 各有 `model` / `baseUrl` /
 * `apiKeyEnv`），而 `DsClient` 从前只有**一个** `baseUrl` + **一个** `apiKey`，两处都取 heavy
 * （`main.ts` 建 client 那一拍）。后果不是"light 用错模型"，而是更难看的一种：
 *
 *   > 在设置页的 light 卡里换一个服务商 ⇒ 界面显示新端点、请求**仍旧打 heavy 的端点**
 *   > 且带的是 **heavy 的密钥**。
 *
 * 所以这里的判据只有一条，而且是**网络上能看见的那一条**：两发请求（heavy 一发、light 一发）
 * 各自落在**自己的**假服务端上，`Authorization` 各是**自己的**那把 key。
 * 断言读数是"哪个假服务端收到了什么"，不是"客户端对象里存了什么字段"——后者在
 * `baseUrl` 只被 `send()` 读一次的实现里可能全绿而线上仍旧走错（这正是病根的形状）。
 *
 * ## 四条覆盖
 *
 *   ① 两条 lane 各自打自己的端点、带自己的 key（含 model 各是自己的）；
 *   ② light 没配 key、且与 heavy **指向不同端点** ⇒ 发送前 `missing_api_key`，
 *      两个端点**一个请求都不发**（绝不把 heavy 的 key 发给另一个服务商）；
 *   ③ 协议回退的结论**按端点**分：light 的端点不认 `/responses` ⇒ 只有 light 切到 chat，
 *      heavy 仍在 responses 上（registry 是按 baseUrl 记账的，per-lane 之后这里必须分得开）；
 *   ④ 缺省（不传 light 两格）= 沿用 heavy：出厂形态与老调用点的**请求字节不变**
 *      （完整的字节判据在 `test/protocol-bytes.test.ts`，这里只钉"打到同一个端点、带同一把 key"）。
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';

import { DsClient, type DsClientError } from '../src/model/ds-client.ts';

interface Hit {
  url: string;
  authorization: string | null;
  model: string;
  body: string;
}

/** 一个只服务本用例的假端点：把每一条请求的 (路径, Authorization, model) 记下来 */
async function startMock(
  t: TestContext,
  hits: Hit[],
  handlers: {
    onResponses?: (res: ServerResponse) => void;
    onChat?: (res: ServerResponse) => void;
  } = {},
): Promise<string> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', () => {});
    res.on('error', () => {});
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let model = '';
      try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed === 'object' && parsed !== null) {
          const value = (parsed as { model?: unknown }).model;
          if (typeof value === 'string') model = value;
        }
      } catch {
        /* 正文不是 JSON 也不影响这条用例的判据 */
      }
      hits.push({
        url: req.url ?? '',
        authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : null,
        model,
        body,
      });
      if (req.url === '/responses') {
        if (handlers.onResponses !== undefined) {
          handlers.onResponses(res);
          return;
        }
        respondOk(res);
        return;
      }
      if (handlers.onChat !== undefined) {
        handlers.onChat(res);
        return;
      }
      respondOk(res);
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
 * 成功回包（非流式）。
 *
 * 这里回的是 **Responses 形状**：两条 lane 的默认协议都是 `responses`（没有探测结论
 * ⇒ `protocolFor` 返回 `'responses'`），所以第一发就成功、不会触发任何回退——
 * 于是"每个端点各收到一条"这个读数才是干净的。
 */
function respondOk(res: ServerResponse): void {
  const payload = JSON.stringify({
    id: 'resp_1',
    status: 'completed',
    model: 'whatever',
    output: [{ type: 'message', id: 'm1', content: [{ type: 'output_text', text: '在。' }] }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** 一个"我就是不认 /responses"的 404（HTML 落地页，最典型的第三方兼容层） */
function notFoundHtml(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>404</title><p>Not Found</p>');
}

/** 认 chat 的端点（非流式 Chat Completions 形状） */
function respondChatOk(res: ServerResponse): void {
  const payload = JSON.stringify({
    id: 'chat_1',
    model: 'whatever',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '在。' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

test('★两条 lane 各打自己的端点、各带自己的 key（heavy 与 light 完全分开）', async (t) => {
  const heavyHits: Hit[] = [];
  const lightHits: Hit[] = [];
  const heavyBaseUrl = await startMock(t, heavyHits);
  const lightBaseUrl = await startMock(t, lightHits);

  const client = new DsClient({
    baseUrl: heavyBaseUrl,
    apiKey: 'sk-heavy-AAA',
    lightBaseUrl,
    lightApiKey: 'sk-light-BBB',
    heavyModel: 'heavy-model',
    lightModel: 'light-model',
  });

  await client.generate({ lane: 'heavy', input: '主循环这一发' });
  await client.generate({ lane: 'light', input: '轻量这一发' });

  // heavy 那一发：只在 heavy 端点上，带 heavy 的 key 与 heavy 的模型名
  assert.equal(heavyHits.length, 1, 'heavy 只该发一条');
  assert.equal(lightHits.length, 1, 'light 只该发一条');
  assert.equal(heavyHits[0]!.url, '/responses');
  assert.equal(lightHits[0]!.url, '/responses');
  assert.equal(heavyHits[0]!.authorization, 'Bearer sk-heavy-AAA', 'heavy 用 heavy 的 key');
  assert.equal(lightHits[0]!.authorization, 'Bearer sk-light-BBB', 'light 用 light 的 key（这是从前漏掉的那一半）');
  assert.equal(heavyHits[0]!.model, 'heavy-model');
  assert.equal(lightHits[0]!.model, 'light-model');
});

test('★light 没配 key、且与 heavy 不同端点 ⇒ 发送前 missing_api_key，两个端点都不发', async (t) => {
  const heavyHits: Hit[] = [];
  const lightHits: Hit[] = [];
  const heavyBaseUrl = await startMock(t, heavyHits);
  const lightBaseUrl = await startMock(t, lightHits);

  const client = new DsClient({
    baseUrl: heavyBaseUrl,
    apiKey: 'sk-heavy-AAA',
    lightBaseUrl,
    // 显式 null = "这一格没有密钥"（`lightLaneKeyPolicy` 的 `none` 档）：
    // 不借 heavy 的 key —— 两格指不同端点时那不是兜底，是把 A 家的密钥发给 B 家
    lightApiKey: null,
  });

  await assert.rejects(
    () => client.generate({ lane: 'light', input: 'x' }),
    (error: unknown) => {
      assert.equal((error as DsClientError).code, 'missing_api_key');
      assert.equal((error as DsClientError).kind, 'invalid', '不重试：发一次也是白费');
      return true;
    },
  );
  assert.equal(lightHits.length, 0, 'light 端点一个请求都不该来');
  assert.equal(heavyHits.length, 0, '更不该改道打到 heavy 的端点上');
});

test('★协议回退的结论按端点分：light 的端点不认 /responses ⇒ 只有 light 切 chat', async (t) => {
  const heavyHits: Hit[] = [];
  const lightHits: Hit[] = [];
  const heavyBaseUrl = await startMock(t, heavyHits);
  // light 的端点：404 /responses，chat 正常
  const lightBaseUrl = await startMock(t, lightHits, {
    onResponses: notFoundHtml,
    onChat: respondChatOk,
  });

  const client = new DsClient({
    baseUrl: heavyBaseUrl,
    apiKey: 'sk-heavy-AAA',
    lightBaseUrl,
    lightApiKey: 'sk-light-BBB',
  });

  await client.generate({ lane: 'heavy', input: 'heavy' });
  await client.generate({ lane: 'light', input: 'light' });

  // heavy：一条，且仍在 responses 上
  assert.equal(heavyHits.length, 1);
  assert.deepEqual(heavyHits.map((hit) => hit.url), ['/responses']);
  // light：先 /responses（404）→ 换 chat 重发一次（上限 1）
  assert.deepEqual(lightHits.map((hit) => hit.url), ['/responses', '/chat/completions']);
  // 探测结论按端点记账：light 的端点被判"不认 responses"，heavy 的端点没被牵连
  assert.equal(client.protocolFor('light'), 'chat-completions');
  assert.equal(client.protocolFor('heavy'), 'responses');
});

test('缺省（不传 light 两格）= 沿用 heavy：打到同一个端点、带同一把 key（老调用点行为不变）', async (t) => {
  const hits: Hit[] = [];
  const baseUrl = await startMock(t, hits);

  const client = new DsClient({ baseUrl, apiKey: 'sk-both-CCC' });

  await client.generate({ lane: 'light', input: 'x' });

  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.authorization, 'Bearer sk-both-CCC', '两格同端点同 key：沿用就是事实');
});

test('★配置未变时两条 lane 的**请求体逐字节相同**（per-lane 接线不改请求字节）', async (t) => {
  const hits: Hit[] = [];
  const baseUrl = await startMock(t, hits);

  // 出厂形态：两格同端点、同一把 key（模型名出厂本来就不一样，所以这里用请求级 `model`
  // 把"模型"这个变量按住——这条要钉的是"**lane 本身不进请求体**"）。
  const client = new DsClient({ baseUrl, apiKey: 'sk-same-DDD' });

  await client.generate({ lane: 'heavy', input: '同一句话', model: 'deepseek-chat' });
  await client.generate({ lane: 'light', input: '同一句话', model: 'deepseek-chat' });

  assert.equal(hits.length, 2);
  // 唯一的差别在 lane：端点/密钥在两个**头**里，body 一个字都不该差。
  // 这是"per-lane 端点/密钥接上之后，`protocol-bytes` 那份字节纪律没有被悄悄改掉"的直接判据。
  assert.deepEqual(hits[0]!.url, hits[1]!.url);
  assert.equal(hits[0]!.authorization, hits[1]!.authorization);
  assert.equal(hits[0]!.body, hits[1]!.body, '配置未变 ⇒ 两条 lane 的请求体必须逐字节相同');
});
