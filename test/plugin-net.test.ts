/**
 * 插件平台 P1b · `ctx.net.fetch`（宿主网络代理）
 *
 * 这一组全部是**真子进程 + 真本地 HTTP server**：插件进程里没有 fetch，只有 JSON-RPC；
 * 白名单、SSRF、重定向、截断都发生在宿主侧——用假进程测等于什么都没测。
 *
 * 覆盖的判据（与需求逐条对应）：
 *   · 白名单放行（且显式写 IP 时允许访问本机回环——这是唯一的内网豁免写法）；
 *   · 没写 `net.allow` = 全拒；
 *   · 白名单里的域名解析到回环/私有地址 → 拒（SSRF）；
 *   · 重定向到白名单外的主机 → 拒（每一跳重新过判据）；
 *   · 8MB 截断；
 *   · http 默认拒、file:/data: 一律拒；
 *   · 日志去掉 URL 的 query。
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';

import { blockedAddressReason, isHostAllowed, pluginNetFetch } from '../src/plugin/net-fetch.ts';
import { createHarness, type Harness } from './helpers/plugin-runtime-harness.ts';

async function startFixtureServer(t: TestContext): Promise<{ port: number; server: Server }> {
  const server = createServer((request, response) => {
    const url = request.url ?? '/';
    if (url.startsWith('/hello')) {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-secret': 'not-returned' });
      response.end(JSON.stringify({ ok: true, path: url.split('?')[0] }));
      return;
    }
    if (url.startsWith('/big')) {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(Buffer.alloc(9 * 1024 * 1024, 'x'));
      return;
    }
    if (url.startsWith('/redirect-out')) {
      response.writeHead(302, { location: `http://localhost:${port}/hello` });
      response.end();
      return;
    }
    if (url.startsWith('/redirect-in')) {
      response.writeHead(302, { location: '/hello?from=redirect' });
      response.end();
      return;
    }
    if (url.startsWith('/loop')) {
      response.writeHead(302, { location: '/loop' });
      response.end();
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('missing');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { resolve(); });
  });
  const port = (server.address() as AddressInfo).port;
  t.after(async () => { await new Promise<void>((resolve) => { server.close(() => { resolve(); }); }); });
  return { port, server };
}

function tracked(t: TestContext, harness: Harness): Harness {
  t.after(async () => { await harness.dispose(); });
  return harness;
}

interface FetchSummary {
  ok: boolean;
  code: number | null;
  message?: string;
  result?: {
    status: number;
    headers: Record<string, string>;
    kind: string;
    length: number;
    truncated: boolean;
    redirects: number;
    url: string;
    data?: string;
  };
}

async function fetchThroughPlugin(harness: Harness, url: string, init?: unknown): Promise<FetchSummary> {
  const result = await harness.callTool('demo-net__fetch', init === undefined ? { url } : { url, init });
  assert.equal(result.isError, undefined, `工具本身不该报错：${result.content}`);
  return JSON.parse(result.content) as FetchSummary;
}

test('白名单放行：显式写 IP 的条目允许访问本机回环；响应头只留安全子集；日志隐去 query', async (t) => {
  const { port } = await startFixtureServer(t);
  const harness = tracked(t, await createHarness({
    fixture: 'plugin-net',
    manifest: { net: { allow: ['127.0.0.1'] } },
    netAllowInsecureLoopbackHttp: true,
  }));
  await harness.start();

  const secret = 'top-secret-token';
  const fetched = await fetchThroughPlugin(harness, `http://127.0.0.1:${port}/hello?token=${secret}`);
  assert.equal(fetched.ok, true, JSON.stringify(fetched));
  assert.equal(fetched.result?.status, 200);
  assert.equal(fetched.result?.kind, 'text');
  assert.match(fetched.result?.data ?? '', /"ok":true/);
  assert.equal(fetched.result?.truncated, false);
  assert.equal(fetched.result?.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(fetched.result?.headers['x-secret'], undefined, '不在安全子集里的响应头不能给插件');

  // 日志：一次调用一条，URL 的 query 必须隐去
  const logLines = harness.writes.filter((line) => line.includes('net.fetch'));
  assert.ok(logLines.length >= 1, `至少要有一条 net.fetch 日志：${harness.writes.join(' | ')}`);
  assert.equal(harness.writes.some((line) => line.includes(secret)), false, '完整 query 不许进日志');
  assert.equal(logLines.some((line) => line.includes('?<已隐去>')), true);
  assert.equal(logLines.some((line) => line.includes('-> 200')), true);

  const allow = await harness.callTool('demo-net__allow', {});
  assert.deepEqual(JSON.parse(allow.content), ['127.0.0.1']);
});

test('没写 net.allow = 全拒：错误码 -32006，点名主机与 net.allow', async (t) => {
  const { port } = await startFixtureServer(t);
  const harness = tracked(t, await createHarness({
    fixture: 'plugin-net',
    manifest: { net: { allow: [] } },
    netAllowInsecureLoopbackHttp: true,
  }));
  await harness.start();
  const fetched = await fetchThroughPlugin(harness, `http://127.0.0.1:${port}/hello`);
  assert.equal(fetched.ok, false);
  assert.equal(fetched.code, -32006);
  assert.match(fetched.message ?? '', /net\.allow/);
  assert.match(fetched.message ?? '', /127\.0\.0\.1/);
});

test('SSRF：白名单里的域名解析到回环地址也拒（域名永远不享受"显式 IP"豁免）', async (t) => {
  const { port } = await startFixtureServer(t);
  const harness = tracked(t, await createHarness({
    fixture: 'plugin-net',
    manifest: { net: { allow: ['localhost'] } },
    netAllowInsecureLoopbackHttp: true,
  }));
  await harness.start();
  const fetched = await fetchThroughPlugin(harness, `http://localhost:${port}/hello`);
  assert.equal(fetched.ok, false);
  assert.equal(fetched.code, -32006);
  assert.match(fetched.message ?? '', /解析到|回环|内网|保留/);
  assert.equal(fetched.result, undefined);
});

test('重定向：每一跳重新过白名单，跨白名单的 Location 直接拒', async (t) => {
  const { port } = await startFixtureServer(t);
  const harness = tracked(t, await createHarness({
    fixture: 'plugin-net',
    manifest: { net: { allow: ['127.0.0.1'] } },
    netAllowInsecureLoopbackHttp: true,
  }));
  await harness.start();
  const fetched = await fetchThroughPlugin(harness, `http://127.0.0.1:${port}/redirect-out`);
  assert.equal(fetched.ok, false);
  assert.equal(fetched.code, -32006);
  assert.match(fetched.message ?? '', /localhost/);
  assert.match(fetched.message ?? '', /net\.allow/);
});

test('重定向：同主机内部跳转照常跟随（相对 Location 也解析）', async (t) => {
  const { port } = await startFixtureServer(t);
  const harness = tracked(t, await createHarness({
    fixture: 'plugin-net',
    manifest: { net: { allow: ['127.0.0.1'] } },
    netAllowInsecureLoopbackHttp: true,
  }));
  await harness.start();
  const fetched = await fetchThroughPlugin(harness, `http://127.0.0.1:${port}/redirect-in`);
  assert.equal(fetched.ok, true, JSON.stringify(fetched));
  assert.equal(fetched.result?.status, 200);
  assert.equal(fetched.result?.redirects, 1);
});

test('重定向：最多 3 跳，环状重定向直接拒（不会无限跟）', async (t) => {
  const { port } = await startFixtureServer(t);
  const harness = tracked(t, await createHarness({
    fixture: 'plugin-net',
    manifest: { net: { allow: ['127.0.0.1'] } },
    netAllowInsecureLoopbackHttp: true,
  }));
  await harness.start();
  const fetched = await fetchThroughPlugin(harness, `http://127.0.0.1:${port}/loop`);
  assert.equal(fetched.ok, false);
  assert.equal(fetched.code, -32006);
  assert.match(fetched.message ?? '', /重定向超过 3 次/);
});

test('8MB 截断：超出部分丢掉并如实标 truncated', async (t) => {
  const { port } = await startFixtureServer(t);
  const harness = tracked(t, await createHarness({
    fixture: 'plugin-net',
    manifest: { net: { allow: ['127.0.0.1'] } },
    netAllowInsecureLoopbackHttp: true,
  }));
  await harness.start();
  const fetched = await fetchThroughPlugin(harness, `http://127.0.0.1:${port}/big`);
  assert.equal(fetched.ok, true, JSON.stringify(fetched));
  assert.equal(fetched.result?.status, 200);
  assert.equal(fetched.result?.truncated, true);
  assert.equal(fetched.result?.kind, 'text');
  assert.ok((fetched.result?.length ?? 0) <= 8 * 1024 * 1024, `截断后长度 ${fetched.result?.length}`);
  assert.ok((fetched.result?.length ?? 0) >= 8 * 1024 * 1024 - 64 * 1024, '应尽量读满 8MB');
});

test('http 默认拒：开关没开时只允许 https（错误要说清这一条）', async (t) => {
  const { port } = await startFixtureServer(t);
  const harness = tracked(t, await createHarness({
    fixture: 'plugin-net',
    manifest: { net: { allow: ['127.0.0.1'] } },
  }));
  await harness.start();
  const fetched = await fetchThroughPlugin(harness, `http://127.0.0.1:${port}/hello`);
  assert.equal(fetched.ok, false);
  assert.equal(fetched.code, -32006);
  assert.match(fetched.message ?? '', /https/);
  assert.match(fetched.message ?? '', /http/);
});

test('非 2xx 不抛异常：404 如实返回 status，插件自己判断', async (t) => {
  const { port } = await startFixtureServer(t);
  const harness = tracked(t, await createHarness({
    fixture: 'plugin-net',
    manifest: { net: { allow: ['127.0.0.1'] } },
    netAllowInsecureLoopbackHttp: true,
  }));
  await harness.start();
  const fetched = await fetchThroughPlugin(harness, `http://127.0.0.1:${port}/missing`);
  assert.equal(fetched.ok, true, JSON.stringify(fetched));
  assert.equal(fetched.result?.status, 404);
  assert.equal(fetched.result?.data, 'missing');
});

test('非 http(s) 协议一律拒：file:/data: 连白名单都不看', async (t) => {
  const harness = tracked(t, await createHarness({
    fixture: 'plugin-net',
    manifest: { net: { allow: ['127.0.0.1'] } },
    netAllowInsecureLoopbackHttp: true,
  }));
  await harness.start();
  for (const url of ['file:///C:/Windows/win.ini', 'data:text/plain,hi']) {
    const fetched = await fetchThroughPlugin(harness, url);
    assert.equal(fetched.ok, false, url);
    assert.equal(fetched.code, -32006);
    assert.match(fetched.message ?? '', /https|file:|data:/);
  }
});

test('纯判据：通配符只匹配子域；私网/回环/保留段逐条被认出', () => {
  assert.equal(isHostAllowed('api.example.com', ['api.example.com']), true);
  assert.equal(isHostAllowed('a.example.com', ['*.example.com']), true);
  assert.equal(isHostAllowed('a.b.example.com', ['*.example.com']), true);
  assert.equal(isHostAllowed('example.com', ['*.example.com']), false, '通配不匹配主域');
  assert.equal(isHostAllowed('evil-example.com', ['*.example.com']), false, '后缀不能跨 label 边界');
  assert.equal(isHostAllowed('API.EXAMPLE.COM', ['api.example.com']), true, '匹配大小写不敏感');
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '0.0.0.0', '224.0.0.1']) {
    assert.notEqual(blockedAddressReason(address), null, `${address} 必须被拒`);
  }
  for (const address of ['::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.notEqual(blockedAddressReason(address), null, `${address} 必须被拒`);
  }
  assert.equal(blockedAddressReason('1.1.1.1'), null);
  assert.equal(blockedAddressReason('2606:4700:4700::1111'), null);
});

test('宿主入口：没声明 net 时直接 -32001（权限门先于网络策略）', async (t) => {
  const harness = tracked(t, await createHarness({
    fixture: 'plugin-net',
    manifest: { permissions: ['tools.define'], net: { allow: [] } },
  }));
  await harness.start();
  const fetched = await fetchThroughPlugin(harness, 'https://example.com/');
  assert.equal(fetched.ok, false);
  assert.equal(fetched.code, -32001);
  assert.match(fetched.message ?? '', /net/);
  assert.match(fetched.message ?? '', /权限|permissions/);
});

test('pluginNetFetch 直接调用：拒绝日志也只写去掉 query 的 URL', async () => {
  const lines: string[] = [];
  const result = await pluginNetFetch({
    input: { url: 'https://example.com/path?secret=abc' },
    allow: [],
    allowInsecureLoopbackHttp: false,
    label: 'unit@deadbeef',
    log: (line) => { lines.push(line); },
    now: () => 1_000,
  }).then(() => null, (error: unknown) => error as Error);
  assert.ok(result instanceof Error);
  assert.match(result.message, /net\.allow/);
  assert.equal(lines.some((line) => line.includes('secret=abc')), false, '拒绝日志也不能带 query');
  assert.equal(lines.some((line) => line.includes('?<已隐去>')), true);
});
