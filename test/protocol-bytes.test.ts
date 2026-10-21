/**
 * **Responses 路径的请求字节不许变**（协议回退搬迁的准入条件 R1）。
 *
 * ## 这条用例钉的是什么
 *
 * `docs/design-protocol-fallback.md` 要把"怎么发一份 Responses 请求"从 `ds-client.ts` 搬进
 * `ModelTransport` 的实现（`src/model/transport/responses.ts`）。搬代码最容易发生的不是逻辑错，
 * 而是**字节错**：改个变量名顺手调了键序、把条件追加写成展开、把 `??` 写成 `||`……
 * 这些都不会让任何既有用例变红（它们断言的是解析结果，不是线上字节），却会让**每一发的
 * 请求体变一个字节** ⇒ 冻结前缀全失配 ⇒ 一次全 miss（≈9.6 万 token 那种事故）。
 *
 * 所以判据只有一条，且**只有这条**：同一份夹具（`protocol-bytes-fixture.ts`），
 * 搬迁前后 `JSON.stringify(body)` **逐字节相同**，`url` 与三个头相同。
 * 底片是 `responses-request-bytes-baseline.json`（**用搬迁前那份代码抓的**，含 `bodyBytes` +
 * `bodySha256`；生成器支持 `--client` 指回旧文件，见它的文件头）。
 *
 * ## 覆盖边界（评审 P6 要求写清）
 *
 * 七条夹具**不是随机挑的**，它们分别钉住"有值才发"的两支与七个 `!== undefined` 的两支：
 *
 * | 夹具 | 钉住的变异 |
 * |---|---|
 * | 富夹具（四条，含流式） | 正例：七格全给真值 |
 * | 空 `tools: []` + 空 `instructions: ''` | 删掉 `tools.length > 0` ⇒ 会多出 `"tools":[]`；把 `''` 当"没给" ⇒ 少 `"instructions":""` |
 * | 假值数值（`temperature:0 / topP:0 / maxOutputTokens:0`） | 把 `!== undefined` 改成 `if (x)` ⇒ 三个键全丢 |
 * | 空 `input: ''` | 把 `input` 改成"有值才发" ⇒ 少 `"input":""` |
 *
 * **没有覆盖的**（如实说）：`reasoning.effort` 的其余三个枚举值（`none` / `low` / `max`）、
 * `text.format` 的 `text` / `json_object` 两支、`tools` 里多个函数的顺序。它们都是"值不同、
 * 结构相同"的形状，改代码很难只错一支——真错了会在别的用例上先红。
 *
 * ## 两条判据、两个方向
 *
 *   ① **自洽**：底片里每条 body 的 `bodySha256` / `bodyBytes` 必须与 body 原文对得上
 *      ——防"有人为了让测试变绿去改底片"（改了这里会先红）；
 *   ② **比对**：现在真发出去的 body 必须 = 底片里那一条（逐字节 + sha256 + 字节数三重）。
 *
 * ## 它为什么必须在搬迁**之前**先绿
 *
 * 先绿才叫"基准"。搬完再补，红了也分不清是搬错了还是底片本来就错。
 * 这一条对应用户给的顺序：**先把底片变成判据，再动任何一行**。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { DsClient } from '../src/model/ds-client.ts';
import { BASELINE_CASES, BASELINE_FILE } from './fixtures/protocol-bytes-fixture.ts';

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface BaselineRequest {
  method: string;
  url: string;
  headers: { accept: string | null; authorization: string | null; contentType: string | null };
  body: string;
  bodyBytes: number;
  bodySha256: string;
}

/**
 * 底片路径按**本文件所在目录**解析（评审 P8）：全仓其余读夹具的用例都用 `import.meta.dirname`，
 * 只有我这一处用了"仓库根相对路径"——那会让"从别的 cwd 单跑这个文件"直接 ENOENT。
 * 判据：`cd %TEMP% && node --test <本文件绝对路径>` 必须绿（读数是 7/7）。
 */
const BASELINE_PATH = join(import.meta.dirname, BASELINE_FILE.replace(/^test\//u, ''));

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as { requests: BaselineRequest[] };

/** 第一个不同的字符位置 + 两侧上下文：红了要一眼看出差在哪，别让人去翻两串 4,000 字的 JSON */
function firstDiff(expected: string, actual: string): string {
  if (expected === actual) return '（相同）';
  const limit = Math.min(expected.length, actual.length);
  let index = 0;
  while (index < limit && expected[index] === actual[index]) index += 1;
  const from = Math.max(0, index - 40);
  return [
    `第 ${index} 个字符起不同（期望长 ${expected.length} / 实际长 ${actual.length}）`,
    `  期望 …${expected.slice(from, index + 60)}…`,
    `  实际 …${actual.slice(from, index + 60)}…`,
  ].join('\n');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 起一个只服务本条用例的 mock server；`listen(0)` 拿随机端口（端口不进底片的三个头） */
async function startMock(t: TestContext, sink: RecordedRequest[]): Promise<string> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', () => {});
    res.on('error', () => {});
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      sink.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      // 回包内容不在本用例的判据里，但必须**成功**：失败会让 DsClient 重试、多发几条请求
      if (body.includes('"stream":true')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          'event: response.completed\n'
          + 'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed",'
          + '"model":"deepseek-v4-pro","output":[{"type":"message","id":"m1",'
          + '"content":[{"type":"output_text","text":"在。"}]}],'
          + '"usage":{"input_tokens":10,"output_tokens":5}}}\n\n',
        );
        res.end();
        return;
      }
      const payload = JSON.stringify({
        id: 'resp_1',
        status: 'completed',
        model: 'deepseek-v4-pro',
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

// ────────────────────────── ① 底片自洽（改底片的人先红）──────────────────────────

test('底片自洽：七条请求的 bodyBytes / bodySha256 必须与 body 原文对得上', () => {
  assert.equal(baseline.requests.length, BASELINE_CASES.length, '底片条数与夹具表必须一致');
  assert.equal(baseline.requests.length, 7, '七条：四条 truthy 形状 + 三条 falsy/空 形状（见文件头那张表）');
  for (const [index, record] of baseline.requests.entries()) {
    const where = `底片第 ${index + 1} 条`;
    assert.equal(record.url, '/responses', `${where}：Responses 的路径只能是 /responses`);
    assert.equal(record.method, 'POST', `${where}：方法只能是 POST`);
    assert.equal(
      Buffer.byteLength(record.body, 'utf8'),
      record.bodyBytes,
      `${where}：bodyBytes 与 body 原文对不上（有人手改过底片？）`,
    );
    assert.equal(sha256(record.body), record.bodySha256, `${where}：bodySha256 与 body 原文对不上（有人手改过底片？）`);
    assert.equal(
      record.bodyBytes,
      BASELINE_CASES[index]!.bytes,
      `${where}：夹具表写的字节数（${BASELINE_CASES[index]!.bytes}）与底片（${record.bodyBytes}）不一致`,
    );
  }
  // 四条的头只有两档：非流式 application/json、流式 text/event-stream
  assert.deepEqual(
    baseline.requests.map((record) => record.headers.accept),
    [
      'application/json',
      'application/json',
      'text/event-stream',
      'text/event-stream',
      'application/json',
      'application/json',
      'application/json',
    ],
  );
});

// ────────────────────────── ② 真发一遍，逐字节比对 ──────────────────────────

for (const [index, item] of BASELINE_CASES.entries()) {
  test(`字节不变 · ${item.label}（${item.bytes} B）`, async (t) => {
    const sink: RecordedRequest[] = [];
    const baseUrl = await startMock(t, sink);
    const client = new DsClient({ baseUrl, apiKey: 'sk-test', user: 'irmia-deploy-01' });

    if (item.stream) await client.stream(item.request);
    else await client.generate(item.request);

    assert.equal(sink.length, 1, '一次调用只该发一条请求（多发 = 重试了，夹具或回包有问题）');
    const sent = sink[0]!;
    const expected = baseline.requests[index]!;

    assert.equal(sent.method, expected.method, '方法变了');
    assert.equal(sent.url, expected.url, 'URL 变了（baseUrl 后必须还是 /responses）');
    assert.equal(sent.headers['accept'], expected.headers.accept, 'accept 头变了');
    assert.equal(sent.headers['authorization'], expected.headers.authorization, 'authorization 头变了');
    assert.equal(sent.headers['content-type'], expected.headers.contentType, 'content-type 头变了');

    // ★ R1 的唯一判据：body 逐字节
    assert.equal(
      sent.body,
      expected.body,
      `请求体变了（这是"冻结前缀全失配"那个事故的形状）：\n${firstDiff(expected.body, sent.body)}`,
    );
    // 再核一遍指纹与字节数（与底片自洽那条互为交叉验证：两边都错才算漏）
    assert.equal(Buffer.byteLength(sent.body, 'utf8'), expected.bodyBytes, '请求体字节数变了');
    assert.equal(sha256(sent.body), expected.bodySha256, '请求体 sha256 变了');
  });
}
