/**
 * **发送层自检**（B 阶段的骨架判据 + 评审补的 P1/P2/P9）：抽象层的"三个不许"，加几条行为钉子。
 *
 * 这条用例存在的理由不是"测协议细节"（那在 `test/chat-transport.test.ts`），而是测**边界没被挪动**：
 *
 *   ① **Responses 那一份是完整可用的**（五个方法齐全、`protocol` 是那个字符串）；
 *   ② **Chat 那一份现在也是完整实现**（B 阶段那阵子是"每个方法都抛"的空实现，
 *      C 阶段换成真实现后就该由 ② 变成"六件齐"——空壳返回仍然是最坏的失败形态，
 *      所以"齐不齐"这条判据留着）；
 *   ③ **适配器故障的判据 = "不是 `DsClientError`"**：R2 的兜底路径要能区分"对端的错"（有 `kind`、
 *      会退避）与"我们自己的编程错误"（不是 `DsClientError` ⇒ 只许退回原始 Responses 错误）。
 *      ⇒ 不需要一个专门的错误类，这条判据由 `ds-client.ts` 的 `adapterFailureOf()` 表达；
 *   ④ **模块图能加载**：`ds-client ↔ transport` 是值依赖的环（见 `responses.ts` 文件头），
 *      两边同时 import 不炸 TDZ。**本文件的 import 顺序是刻意的（先 transport 后 ds-client）**，
 *      那正是 TDZ 的爆点——改了顺序，那个坑会在 C 阶段以"某个入口随机炸"的形状回来。
 *
 * 评审补的三条（都是**代码形状**的钉子，不是功能）：
 *
 *   · **P1**：协议实现的调用（`parseStream` / `buildRequest`）只要在 `try` 之外，一抛就会漏掉
 *     `handle.dispose()` ⇒ 静默计时器（120s）与硬顶（3h）两只闸都留在那儿。判据是
 *     **`process.getActiveResourcesInfo()` 里的 `Timeout` 数必须回到基线**。
 *   · **P2**：`StreamAccumulator.hasDeliveredContent()` 是设计 §5.4 的硬前置（"已吐字就不许换协议"）。
 *     这里钉"没吐字 = false / 吐过字 = true"，其中**只有思维链也算吐过**（不可重放）。
 *   · **P9**（用户拍的口径）：`baseUrl` **每次 send 现算** ⇒ URL 不是构造时拼死的：
 *     同一个 `DsClient` 上 heavy / light 两个端点各打各的，而"路径那一段"由协议实现给（相对路径）。
 *     （2026-10-22 改写：原来这一条靠 `applyConfig` 热更 `baseUrl` 来钉，而那个入口**全仓零调用**、
 *     已删除。现在钉的是同一件事的另一个面：**拼 URL 这件事发生在 send 那一刻**，取值口是
 *     `endpointFor(lane)`——两格端点在同一次运行里不同，就是这条判据最直接的证据。）
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';

// ⚠ 顺序刻意：先 transport、后 ds-client（TDZ 的爆点，见文件头 ④）
import { chatCompletionsTransport } from '../src/model/transport/chat-completions.ts';
import { responsesTransportParts } from '../src/model/transport/responses.ts';
import { SseFrameDecoder } from '../src/model/transport/sse.ts';
import type { ModelTransport, StreamAccumulator } from '../src/model/transport/types.ts';
import { DsClient, DsClientError } from '../src/model/ds-client.ts';

const TRANSPORT_METHODS = ['buildRequest', 'send', 'parseStream', 'parseResponse', 'readUsage'] as const;

const STREAM_CTX = { fallbackModel: 'deepseek-flash', callbacks: {}, startedAt: 0, now: () => 0 };

/** 一条 SSE 帧（形状与 `transport/sse.ts` 的 `SseFrame` 一致：`event` 字段 + `data` 里的 `type`） */
function frame(type: string, payload: Record<string, unknown>): { event: string; data: string } {
  return { event: type, data: JSON.stringify({ type, ...payload }) };
}

/** 当前进程里还活着几个 `Timeout`（漏掉 `handle.dispose()` 的那个症状） */
function activeTimeouts(): number {
  return process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
}

/** 起一个"一定成功"的 mock server（只为 P9 的端点切换服务） */
async function startOkMock(t: TestContext, sink: string[]): Promise<string> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', () => {});
    res.on('error', () => {});
    req.on('end', () => {
      sink.push(req.url ?? '');
      const payload = JSON.stringify({
        id: 'resp_1',
        status: 'completed',
        model: 'deepseek-flash',
        output: [{ type: 'message', id: 'm1', content: [{ type: 'output_text', text: '在。' }] }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('mock server 未能绑定端口');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${address.port}`;
}

/** 把 Responses 实现的一个方法换成"一调就抛"，其余原样 */
function transportWithThrow(where: 'buildRequest' | 'parseStream', error: unknown): ModelTransport {
  const base = responsesTransportParts;
  return { ...base, [where]: (): never => { throw error; } } as ModelTransport;
}

// ────────────────────────────── ① 两份实现的基本形状 ──────────────────────────────

test('Responses 实现：`protocol === "responses"` 且五个方法齐全（搬迁后仍可用）', () => {
  assert.equal(responsesTransportParts.protocol, 'responses');
  for (const method of TRANSPORT_METHODS) {
    assert.equal(typeof responsesTransportParts[method], 'function', `Responses 实现缺方法 ${method}`);
  }
});

test('Chat 实现：已是完整的 `ModelTransport`（六件齐，含可选的 classifyError）', () => {
  assert.equal(chatCompletionsTransport.protocol, 'chat-completions');
  for (const method of TRANSPORT_METHODS) {
    assert.equal(typeof chatCompletionsTransport[method], 'function', `Chat 实现缺方法 ${method}`);
  }
  // 错误分类属于协议（用户 2026-10-21 拍）：两套错误体形状不同，但产出的错误类型同一套
  assert.equal(typeof chatCompletionsTransport.classifyError, 'function', 'Chat 必须实现 classifyError');
});

test('适配器故障的判据 = "不是 `DsClientError`"（因此不需要一个专门的错误类）', () => {
  // R2 的兜底路径要能区分两类失败：
  //   · 对端的错 —— `DsClientError`（有 kind、会被分类表退避重试）；
  //   · 我们自己的编程错误 —— **不是** `DsClientError` ⇒ 只许退回原始 Responses 错误，不许重试。
  // 这条判据由 `ds-client.ts` 的 `adapterFailureOf()` 一处表达；这里钉住"两类确实分得开"。
  const ownBug = new TypeError('adapter bug');
  assert.equal(ownBug instanceof DsClientError, false, '适配器自己的编程错误不是 DsClientError');
  assert.equal(ownBug instanceof Error, true, '但它仍然是个 Error（会带栈，排障要的就是这个）');
});

test('模块图能加载：`ds-client` 与 `transport/*` 同时 import 不炸 TDZ（值依赖是环，见 responses.ts）', () => {
  const client = new DsClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-test' });
  assert.equal(typeof client.modelFor, 'function');
  const decoder = new SseFrameDecoder();
  assert.deepEqual(decoder.push('data: {"a":1}\n\n'), [{ event: null, data: '{"a":1}' }]);
});

// ────────────────────── ② P2：hasDeliveredContent（§5.4 的硬前置）──────────────────────

test('P2 · hasDeliveredContent：没吐字 ⇒ false；吐过正文 / 只有思维链 / 有 function_call ⇒ true', () => {
  const fresh = responsesTransportParts.parseStream(STREAM_CTX);
  assert.equal(fresh.hasDeliveredContent(), false, '刚建出来还没收到任何东西 ≠ 已交付');

  const withText = responsesTransportParts.parseStream(STREAM_CTX);
  withText.apply(frame('response.output_text.delta', { item_id: 'm1', delta: '喂' }));
  assert.equal(withText.hasDeliveredContent(), true, '吐过正文 ⇒ 不可重放 ⇒ 已交付');

  // ★ 只有思维链也算"已交付"：它推给过 onReasoningDelta，删不掉、也推不回去
  const reasoningOnly = responsesTransportParts.parseStream(STREAM_CTX);
  reasoningOnly.apply(frame('response.reasoning_text.delta', { item_id: 'r1', delta: '想一想' }));
  assert.equal(reasoningOnly.hasDeliveredContent(), true, '思维链也算已交付（不可重放）');

  // 函数调用同理（哪怕参数还没来）——它与中断结算共用 `hasPartialOutput` 这一个判据
  const withCall = responsesTransportParts.parseStream(STREAM_CTX);
  withCall.apply(frame('response.output_item.added', {
    output_index: 1,
    item: { id: 'fc_1', type: 'function_call', status: 'in_progress', call_id: 'call_9', name: 'pwsh', arguments: '' },
  }));
  assert.equal(withCall.hasDeliveredContent(), true, '已经有一个 function_call 条目 ⇒ 已交付');
});

test('P2 · 只有状态帧与空增量 ⇒ 仍算"没交付"（这时换协议不会重复推送）', () => {
  const acc: StreamAccumulator = responsesTransportParts.parseStream(STREAM_CTX);
  acc.apply(frame('response.in_progress', { response: { id: 'r', status: 'in_progress' } }));
  acc.apply(frame('response.output_text.delta', { item_id: 'm1', delta: '' }));
  assert.equal(acc.hasDeliveredContent(), false, '状态帧与空增量都不是内容');
});

// ─────────────────── ③ P1：适配器在 parseStream 就抛 ⇒ 定时器必须被清掉 ───────────────────

test('P1 · 注入的假传输在 `parseStream` 就抛：定时器被清、错误原样抛出、无 unhandledRejection', async (t) => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);
  const before = activeTimeouts();
  try {
    const fault = new Error('inject: parseStream 崩了');
    // ⭐ C-3 起累积器造在 exchange() 之后（换协议后必须用新协议的解析器）
    // ⇒ “parseStream 抛”这条回归网要先让 HTTP 那一跳成功（否则先撞上的是连接错误）。
    const baseUrl = await startOkMock(t, []);
    const client = new DsClient({
      baseUrl,
      apiKey: 'sk-test',
      transportOverride: { responses: transportWithThrow('parseStream', fault) },
      // 用默认的静默/硬顶（120s / 3h）：漏掉的话这两只闸会真的挂在这儿
    });

    await assert.rejects(
      () => client.stream({ lane: 'heavy', input: 'x' }, {}),
      (error: unknown) => {
        assert.equal(error, fault, '错误必须原样抛出（B 阶段没有"原件"可退，见 adapterFailureOf 的注释）');
        return true;
      },
    );

    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.equal(
      activeTimeouts() - before,
      0,
      '静默计时器与硬顶必须被清掉（`parseStream` 曾在 `try` 之外 ⇒ finally 不执行 ⇒ 漏两只闸）',
    );
    assert.deepEqual(rejections, [], '不许有 unhandledRejection');
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('P1 · 非流式那条路同理：`buildRequest` 就抛 ⇒ 总时限计时器被清、错误原样抛出', async () => {
  const before = activeTimeouts();
  const fault = new Error('inject: buildRequest 崩了');
  const client = new DsClient({
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'sk-test',
    transportOverride: { responses: transportWithThrow('buildRequest', fault) },
    // 它不是 `DsClientError` ⇒ 一次就外抛，不会真的去退避；这个 sleep 只是兜住"万一"
    sleep: async () => {},
  });

  await assert.rejects(
    () => client.generate({ lane: 'light', input: 'x' }),
    (error: unknown) => {
      assert.equal(error, fault, '错误必须原样抛出');
      return true;
    },
  );
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(activeTimeouts() - before, 0, '总时限计时器必须被清掉');
});

// ───────────────── ④ P9：URL 在 send 那一刻由 lane 的端点拼出来（不是构造时拼死的）─────────────────

test('P9 · 同一实例两个端点：heavy 打 A、light 打 B，路径那一段不变', async (t) => {
  const hitsA: string[] = [];
  const hitsB: string[] = [];
  const baseUrlA = await startOkMock(t, hitsA);
  const baseUrlB = await startOkMock(t, hitsB);

  const client = new DsClient({ baseUrl: baseUrlA, lightBaseUrl: baseUrlB, apiKey: 'sk-test' });
  await client.generate({ lane: 'heavy', input: '第一发' });
  assert.equal(hitsA.length, 1, 'heavy 那一发必须打到 heavy 的端点');
  assert.equal(hitsB.length, 0);

  await client.generate({ lane: 'light', input: '第二发' });

  assert.equal(hitsA.length, 1, 'heavy 的端点不该再来一条');
  assert.equal(hitsB.length, 1, 'light 那一发必须打到自己的端点（拼 URL 发生在 send 那一刻）');
  assert.equal(hitsB[0], '/responses', '换的是 baseUrl，路径那一段不变');
});
