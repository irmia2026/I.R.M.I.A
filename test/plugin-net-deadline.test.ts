import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { pluginNetFetch } from '../src/plugin/net-fetch.ts';
import { PluginRpcError } from '../src/plugin/protocol.ts';

test('网络总期限覆盖 DNS；迟到的解析拒绝不会成为未处理异常', async () => {
  let resolveLookup!: () => void;
  let finished = false;
  const logs: string[] = [];
  const lookupGate = new Promise<void>((resolve) => { resolveLookup = resolve; });
  const pending = pluginNetFetch({
    input: { url: 'https://audit.invalid/' }, allow: ['audit.invalid'],
    allowInsecureLoopbackHttp: false, label: 'deadline-test', log: (line) => { logs.push(line); },
    timeoutMs: 25,
    lookup: async () => { await lookupGate; finished = true; throw new Error('late DNS failure'); },
  });
  await assert.rejects(pending, (error: unknown) => error instanceof PluginRpcError
    && error.code === -32006 && error.data?.['reason'] === 'timeout');
  assert.equal(finished, false, '必须在 DNS 完成之前返回超时');
  resolveLookup();
  await delay(10);
  assert.equal(finished, true, '确实消费迟到的 DNS 拒绝');
  assert.equal(logs.length, 1, '不能在迟到结果后再写一条失败或发请求');
});

test('网络总期限到达后取消正在收响应的连接', async (t) => {
  let closed = false;
  const server = createServer((_req, response) => {
    response.on('close', () => { closed = true; });
    response.writeHead(200);
    response.write('partial');
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => { resolve(); }); }); });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  await assert.rejects(pluginNetFetch({
    input: { url: `http://127.0.0.1:${address.port}/` }, allow: ['127.0.0.1'],
    allowInsecureLoopbackHttp: true, label: 'deadline-test', log: () => {}, timeoutMs: 100,
  }), (error: unknown) => error instanceof PluginRpcError && error.data?.['reason'] === 'timeout');
  for (let i = 0; i < 20 && !closed; i += 1) await delay(10);
  assert.equal(closed, true, '超时必须断开真实响应流，不能继续接收');
});

test('DNS 在期限内失败仍报告 DNS 原因，不混为超时', async () => {
  await assert.rejects(pluginNetFetch({
    input: { url: 'https://audit.invalid/' }, allow: ['audit.invalid'],
    allowInsecureLoopbackHttp: false, label: 'deadline-test', log: () => {}, timeoutMs: 1000,
    lookup: async () => { throw new Error('synthetic DNS failure'); },
  }), (error: unknown) => error instanceof PluginRpcError && error.data?.['reason'] === 'dns');
});

test('重定向只读取 Location，立即关闭无须消费的旧响应', async (t) => {
  let redirectClosed = false;
  const server = createServer((req, response) => {
    if (req.url === '/redirect') {
      response.on('close', () => { redirectClosed = true; });
      response.writeHead(302, { location: '/final' });
      response.write('redirect body kept open');
    } else response.end('done');
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => { resolve(); }); }); });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const result = await pluginNetFetch({
    input: { url: `http://127.0.0.1:${address.port}/redirect` }, allow: ['127.0.0.1'],
    allowInsecureLoopbackHttp: true, label: 'redirect-test', log: () => {}, timeoutMs: 1000,
  });
  assert.equal(result.body.data, 'done');
  for (let i = 0; i < 20 && !redirectClosed; i += 1) await delay(10);
  assert.equal(redirectClosed, true, '成功跟随重定向后不能遗留仍在读正文的旧连接');
});

test('非法 HTTP 头在发请求前拒绝，不遗留构造请求失败的计时器', async () => {
  for (const value of ['bad\0header', 'non-latin-\u4e2d']) {
    await assert.rejects(pluginNetFetch({
      input: { url: 'https://audit.invalid/', init: { headers: { 'x-test': value } } },
      allow: ['audit.invalid'], allowInsecureLoopbackHttp: false, label: 'header-test', log: () => {}, timeoutMs: 50,
    }), (error: unknown) => error instanceof PluginRpcError && error.code === -32602);
  }
});
