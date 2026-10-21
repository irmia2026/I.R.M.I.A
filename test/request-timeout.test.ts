/**
 * 单次模型请求的**三格时限**（`src/model/ds-client.ts`，2026-10-16 加）。
 *
 * 用户原话是唯一判据：「**不要硬性掐断**，因为现代的大模型**超长思考很正常**。
 * **思考 40 分钟都有可能**。」病根是那条约 180s 的**总时限**：它从"请求发出"起跑、连收流一起算，
 * 于是一条**正在活跃输出**的流会在写到一半时被我们自己的定时器掐断（实测被掐那一刻
 * 已累积 10 万字符推理、断在半句话上），而 `timeout` 又在可重试类别里 ⇒ 掐断 → 重投 → 再撞。
 *
 * 这个文件钉四件事（前两条是用户要的，后两条是"不许把真卡死变成永远挂着"那一半）：
 *   ① **长思考不被掐**：数据一直在来，总耗时**超过硬顶**也不掐（判据是静默，不是总耗时）；
 *   ② **真静默会被掐**：开了头发完就沉默 ⇒ 到静默阈值当场中断（静默判据真的是活的）；
 *   ③ **硬顶会掐**：一直在吐字但总时长超过硬顶 ⇒ 掐，且原因与静默**分开报**；
 *   ④ 非流式（light 的 `generate()`）仍是总时限，且那条路上**超时不再盲目重发满 5 次**。
 *
 * 时限全部走构造参数（生产从 `config.models.requestTimeout` 来），所以用例里用毫秒级的
 * 小值就能把语义验全，不必真等两分钟。
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';

import {
  DsClient, DsClientError, DEFAULT_STREAM_HARD_CAP_MS, DEFAULT_STREAM_SILENCE_MS, DEFAULT_TIMEOUT_MS,
  type SleepFn,
} from '../src/model/ds-client.ts';

// ──────────────────────────────── mock server ────────────────────────────────

interface MockServer {
  url: string;
  requests: number;
  close(): Promise<void>;
}

/** 起一个只服务当前测试的 mock server（与 ds-client.test.ts 同一套手法：listen(0) 拿随机端口） */
async function startMock(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<MockServer> {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    req.on('data', () => {});
    req.on('error', () => {});
    res.on('error', () => {});
    req.on('end', () => {
      try {
        handler(req, res);
      } catch {
        /* 客户端中断后迟到的 write 会抛：吞掉，别把测试进程带崩 */
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('mock server 未能绑定端口');
  const mock: MockServer = {
    url: `http://127.0.0.1:${address.port}`,
    get requests() { return requests; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  t.after(() => mock.close());
  return mock;
}

function sseFrame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function deltaFrame(text: string): string {
  return sseFrame('response.output_text.delta', { item_id: 'msg_1', output_index: 0, delta: text });
}

const DONE_FRAME = sseFrame('response.completed', {
  response: {
    id: 'resp_1',
    status: 'completed',
    model: 'deepseek-v4-pro',
    usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5 },
  },
});

/** 记录退避时长但立即返回：测试不该真的等指数退避 */
function recordingSleep(sleeps: number[]): SleepFn {
  return async (ms: number) => { sleeps.push(ms); };
}

/** 轮询等待某个条件成立（真定时器；上限给足，失败时报清楚等的是什么） */
async function until(what: string, predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ──────────────────────────────── ① 长思考不被掐 ────────────────────────────────

test('静默判据不掐长思考：数据一直在来 ⇒ 总耗时远超旧口径 180s 也照样收完', async (t) => {
  /**
   * 这一条的构造（"超长思考"的形状，只是按毫秒缩放）：
   *   · 静默阈值 300ms、旧口径那格总时限 **150ms**（故意设得比整条流还短）；
   *   · 服务端每 60ms 吐一片、共 20 片（≈1.2s）+ 终态。
   * 旧口径下（一切按总时限算）这条流会在 150ms 被掐；新口径下它**必须**完整收完——
   * 判据换成了"多久没有数据"，而它每 60ms 就有一片（< 300ms）。
   *
   * 为什么特意把 `timeoutMs` 设得比整条流短：它就是"**总耗时**这条判据"的化身——
   * 这条用例要证的是"流式那条路**不再看**总耗时"，所以必须让总耗时远远越过那个数。
   */
  const mock = await startMock(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let sent = 0;
    const timer = setInterval(() => {
      sent += 1;
      res.write(deltaFrame('想'));
      if (sent >= 20) {
        clearInterval(timer);
        res.write(DONE_FRAME);
        res.end();
      }
    }, 60);
    res.on('close', () => clearInterval(timer));
  });

  const deltas: string[] = [];
  const client = new DsClient({
    baseUrl: mock.url, apiKey: 'sk-test',
    silenceMs: 300, hardCapMs: 30_000, timeoutMs: 150,
  });
  const started = Date.now();
  const result = await client.stream(
    { lane: 'heavy', input: '好好想 40 分钟' },
    { onTextDelta: (delta) => deltas.push(delta) },
  );
  const elapsed = Date.now() - started;

  assert.ok(elapsed > 1_000, `这条流的总耗时（${elapsed}ms）必须真的越过旧口径那格时限（150ms），用例才有意义`);
  assert.equal(result.interrupted, false, '数据一直在来 ⇒ 不该被判中断');
  assert.equal(result.failure, null, '也不该带失败原因');
  assert.equal(result.status, 'completed');
  assert.equal(result.text, '想'.repeat(20), '20 片一片不少');
  assert.equal(deltas.length, 20);
});

// ──────────────────────────────── ② 真静默会被掐 ────────────────────────────────

test('真静默会被掐：打完招呼就沉默 ⇒ 到静默阈值当场中断（已收部分保留）', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(deltaFrame('开头'));
    // 之后一片都不发（连接开着、什么都不说）——这就是"真卡死"的形状
  });

  const client = new DsClient({
    baseUrl: mock.url, apiKey: 'sk-test',
    silenceMs: 150, hardCapMs: 60_000, timeoutMs: 60_000,
  });
  const started = Date.now();
  const result = await client.stream({ lane: 'heavy', input: '说点什么' }, {});
  const elapsed = Date.now() - started;

  assert.equal(result.interrupted, true, '静默超时 = 未收到终态 ⇒ interrupted');
  // 超时是"没收到终态"，**不是**上游宣告的终态失败（`status` 那一格专指后者）：
  // 把它写成 `failed` 会让"超时"与"response.failed"在观测面上不可分（P0 的同一条根因）
  assert.equal(result.status, 'incomplete', 'status 不许把超时写成 failed');
  assert.equal(result.text, '开头', '已收到的部分要留住（M2-9 的既有语义）');
  assert.ok(result.failure !== null, '要带失败原因');
  assert.equal(result.failure?.code, 'timeout_silent', '原因要点明是**静默**那只闸');
  assert.match(result.failure?.message ?? '', /没有收到任何数据/u);
  // 掐的时机接近静默阈值（不是"永不掐"，也不是"立刻掐"）：给足调度余量
  assert.ok(elapsed >= 140 && elapsed < 1_500, `掐的时机应贴着静默阈值，实测 ${elapsed}ms`);
});

test('静默计时器**被数据重置**：来一片就重新起跳（不是"首字节时限"）', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // 每 80ms 一片、共 5 片（总 400ms），静默阈值 150ms：
    // 若计时器不重置，第 150ms 就被掐；重置的话能收完。
    let sent = 0;
    const timer = setInterval(() => {
      sent += 1;
      res.write(deltaFrame('片'));
      if (sent >= 5) {
        clearInterval(timer);
        res.write(DONE_FRAME);
        res.end();
      }
    }, 80);
    res.on('close', () => clearInterval(timer));
  });

  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test', silenceMs: 150, hardCapMs: 60_000 });
  const result = await client.stream({ lane: 'heavy', input: 'x' }, {});

  assert.equal(result.interrupted, false);
  assert.equal(result.text, '片'.repeat(5));
});

// ──────────────────────────────── ③ 硬顶会掐 ────────────────────────────────

test('硬顶会掐：一直在吐字但总时长超过硬顶 ⇒ 掐，且原因与静默**分开报**', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // 每 20ms 一片，永不结束：静默永远被喂饱 ⇒ 只有硬顶拦得住它
    const timer = setInterval(() => { res.write(deltaFrame('没完')); }, 20);
    res.on('close', () => clearInterval(timer));
  });

  const client = new DsClient({
    baseUrl: mock.url, apiKey: 'sk-test',
    silenceMs: 5_000, hardCapMs: 200, timeoutMs: 5_000,
  });
  const started = Date.now();
  const result = await client.stream({ lane: 'heavy', input: '停不下来' }, {});
  const elapsed = Date.now() - started;

  assert.equal(result.interrupted, true);
  assert.equal(result.status, 'incomplete', '硬顶也是"没收到终态"，不是上游宣告的 failed');
  assert.equal(result.failure?.code, 'timeout_hard_cap', '硬顶必须报成它自己，不能与静默混成一条');
  assert.match(result.failure?.message ?? '', /硬顶/u);
  assert.ok(elapsed >= 190 && elapsed < 1_500, `硬顶应在那 200ms 前后开火，实测 ${elapsed}ms`);
});

test('默认值就是三格时限的出厂口径（120s 静默 / 3h 硬顶 / 180s 非流式）', () => {
  const client = new DsClient({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test' });
  assert.equal(client.silenceMs, 120_000);
  assert.equal(client.silenceMs, DEFAULT_STREAM_SILENCE_MS);
  assert.equal(client.hardCapMs, 10_800_000);
  assert.equal(client.hardCapMs, DEFAULT_STREAM_HARD_CAP_MS);
  assert.equal(client.timeoutMs, 180_000);
  assert.equal(client.timeoutMs, DEFAULT_TIMEOUT_MS);
  // 硬顶必须比静默宽：反过来的话静默永远没机会开火（配置层那条交叉校验同一个判据）
  assert.ok(client.hardCapMs > client.silenceMs);
});

// ──────────────────────────────── ④ 非流式：超时不再盲目重发 ────────────────────────────────

test('非流式超时：**最多重发一次**（不是默认的 5 次），失败时带可读原因', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    // 收下请求但永不回应：必然撞总时限
    res.writeHead(200, { 'content-type': 'application/json' });
    void res;
  });

  const sleeps: number[] = [];
  const client = new DsClient({
    baseUrl: mock.url, apiKey: 'sk-test',
    timeoutMs: 60,
    // 默认 maxAttempts = 5：收紧之前这里会看到 5 次请求、4 次退避
    sleep: recordingSleep(sleeps),
  });

  await assert.rejects(
    () => client.generate({ lane: 'light', input: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof DsClientError);
      assert.equal(error.kind, 'timeout');
      assert.equal(error.attempts, 2, '超时型失败只给一次重试机会');
      return true;
    },
  );

  assert.equal(mock.requests, 2, '同一个必然超时的请求不许原样重发满 5 次');
  assert.deepEqual(sleeps, [500], '那一次重试是**带退避**的（baseDelayMs=500 → 第 1 次 500ms）');
});

test('非流式时限可配：改小立刻生效（`models.nonStreamTimeoutMs` 的落点）', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    setTimeout(() => {
      try { res.end(JSON.stringify({ id: 'r', status: 'completed', output: [], usage: {} })); } catch { /* 已断 */ }
    }, 400);
  });

  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test', timeoutMs: 50, maxAttempts: 1 });
  await assert.rejects(
    () => client.generate({ lane: 'light', input: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof DsClientError);
      assert.equal(error.kind, 'timeout');
      return true;
    },
  );
  // 三格时限是**构造期参数**（`DsClient` 没有热更入口，见 `DsClientOptions` 顶部那段
  // "配置的生命周期"）：这条只验"收得下、存得住"——宿主传什么，客户端就按什么跑。
  const tuned = new DsClient({
    baseUrl: mock.url, apiKey: 'sk-test', silenceMs: 1_234, hardCapMs: 5_678, timeoutMs: 90,
  });
  assert.equal(tuned.silenceMs, 1_234);
  assert.equal(tuned.hardCapMs, 5_678);
  assert.equal(tuned.timeoutMs, 90);
});

// ⑤ 静默与硬顶**都不许把正常结束的流误判**
test('正常结束的流一次都不该被掐（含"响应头早到、正文慢慢来"那一种）', async (t) => {
  const mock = await startMock(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // 响应头立刻到、正文等 120ms 才来第一片：静默阈值 200ms ⇒ 不该被掐
    // （响应头到达本身也是一次 noteData，见 ds-client.stream）
    setTimeout(() => {
      res.write(deltaFrame('慢但活着'));
      res.write(DONE_FRAME);
      res.end();
    }, 120);
  });

  const client = new DsClient({ baseUrl: mock.url, apiKey: 'sk-test', silenceMs: 200, hardCapMs: 5_000 });
  const result = await client.stream({ lane: 'heavy', input: 'x' }, {});
  assert.equal(result.interrupted, false);
  assert.equal(result.text, '慢但活着');
});

test('until 辅助函数本身可用（防止上面几条的等待逻辑悄悄失效）', async () => {
  let flag = false;
  setTimeout(() => { flag = true; }, 20);
  await until('flag 被置位', () => flag);
  assert.equal(flag, true);
});
