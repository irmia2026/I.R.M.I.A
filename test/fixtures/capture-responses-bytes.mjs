/**
 * 抓 Responses 路径的**请求字节基线**（`test/fixtures/responses-request-bytes-baseline.json`）。
 *
 * 干什么：起一个本地 mock server，用**真 `DsClient`** 发七条请求（见 `BASELINE_CASES`），
 * 把服务端收到的 `{method,url,headers,body}` 原样落盘，并给每条 body 记 `bodyBytes` + `bodySha256`。
 *
 * 为什么：协议回退（`docs/design-protocol-fallback.md`）要把 Responses 的发送代码搬进
 * `ModelTransport` 实现里。**搬代码不许改一个字节的线上请求**，而"看起来一样"不算证明——
 * 唯一说得清的判据是"同一份夹具，改前改后 `JSON.stringify(body)` 逐字节相同"。
 *
 * 用法（改前抓一份、改后抓一份，逐字节 diff）：
 *   node --experimental-strip-types test/fixtures/capture-responses-bytes.mjs <out.json>
 *   # 想抓"改前那一份代码"的底片：把那时的 ds-client.ts 取出来，指给 --client
 *   git show <搬迁提交>^:src/model/ds-client.ts > tmp/pre-move-ds-client.ts
 *   node --experimental-strip-types test/fixtures/capture-responses-bytes.mjs tmp/pre.json \
 *        --client ../../tmp/pre-move-ds-client.ts
 *
 * ⚠ 刻意不写任何时间戳/端口/随机量：同一份源码，两次跑出来的 json 必须逐字节相同。
 * ⚠ `--client` **只影响去哪 import 实现**，不进 JSON 的任何一格（否则两份就不逐字节相同了）。
 * ⚠ **夹具不在这里内联**：它在 `protocol-bytes-fixture.ts`，与判据
 *   （`test/protocol-bytes.test.ts`）**共用同一份**——两边漂了，比出来的差异就分不清是
 *   "代码变了"还是"夹具变了"。
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { BASELINE_CASES } from './protocol-bytes-fixture.ts';

/** `--client <相对本文件的路径>`：默认就是现在这份实现 */
const CLIENT_SPEC = (() => {
  const index = process.argv.indexOf('--client');
  return index >= 0 ? process.argv[index + 1] : '../../src/model/ds-client.ts';
})();
const { DsClient } = await import(new URL(CLIENT_SPEC, import.meta.url).href);
if (CLIENT_SPEC !== '../../src/model/ds-client.ts') {
  // 只打到 stdout：进 JSON 里就会让"改前/改后两份逐字节相同"这条判据失效
  console.log(`[注] 本次用的是另一份实现：${CLIENT_SPEC}`);
}

function startMock(records) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      records.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: {
          accept: req.headers['accept'] ?? null,
          authorization: req.headers['authorization'] ?? null,
          contentType: req.headers['content-type'] ?? null,
        },
        body,
        bodyBytes: Buffer.byteLength(body, 'utf8'),
        bodySha256: createHash('sha256').update(body, 'utf8').digest('hex'),
      });
      // 回包：流式给终态 SSE，非流式给一份够用的 JSON（内容不在本基线的判据里）
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
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const records = [];
const { server, port } = await startMock(records);
const client = new DsClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-test', user: 'irmia-deploy-01' });

// 顺序与 `BASELINE_CASES` 一致：非流式富 / 非流式最小 / 流式富 / 流式最小
for (const item of BASELINE_CASES) {
  if (item.stream) await client.stream(item.request);
  else await client.generate(item.request);
}

server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));

const out = {
  note: 'Responses 路径的请求字节基线：url + 三个头 + body 原文（含 bodyBytes/bodySha256）。'
    + '协议回退的搬迁改前/改后必须逐字节相同；`test/protocol-bytes.test.ts` 用它当判据。',
  fixture: 'test/fixtures/capture-responses-bytes.mjs（本文件的唯一生成者）',
  capturedFrom: 'src/model/ds-client.ts @ 未改动的 main（b119e5b）',
  baseUrlShape: 'http://127.0.0.1:<随机端口>（只影响 Host 头，不进本基线的三个头）',
  requests: records,
};
const target = process.argv[2] ?? 'test/fixtures/responses-request-bytes-baseline.json';
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(`已写入 ${target}（${records.length} 条请求）`);
for (const record of records) {
  console.log(`- ${record.url} stream=${JSON.parse(record.body).stream} bytes=${record.bodyBytes} sha256=${record.bodySha256.slice(0, 16)}…`);
}
