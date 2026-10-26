/**
 * 网络与视觉工具包测试 — src/tools/net.ts + src/tools/vision.ts
 *
 * 覆盖 docs/design.md §4.10（SSRF 与路径白名单）、§4.15（外部内容边界）、
 * §4.18（http_get/post/download 与 vision 基础版规格）与 docs/schema.md §10（工具契约）。
 *
 * 关键验收点：
 *   - 私网/环回/链路本地字面 IP 与 DNS 解析结果都被拦，且拦截发生在**发起连接之前**；
 *   - 重定向逐跳复查：本机服务器 302 到私网地址必须被拦（经典绕过）；
 *   - download 的 Content-Length 预检与流式计数双上限都不会留下残留文件；
 *   - vision 缓存命中后不再调用模型（mock dsClient 计数为证）；
 *   - 模型返回非 JSON 时回退纯文本且标注 fallback。
 *
 * 本机服务器一律绑 127.0.0.1，并通过 allowedHosts 显式放行（默认策略下环回是拦死的）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_MAX_DOWNLOAD_BYTES,
  createNetTools,
  htmlToText,
  isBlockedAddress,
  sliceChars,
  type NetDeps,
} from '../src/tools/net.ts';
import { htmlToMarkdown } from '../src/tools/html-to-md.ts';
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_VISION_MODEL,
  VISION_CACHE_DIR_NAME,
  createVisionTools,
  extractResponseText,
  parseVisionResult,
  type VisionGenerateRequest,
  type VisionModelClient,
} from '../src/tools/vision.ts';
import type { ToolContext, ToolDefinition, ToolHandlerResult } from '../src/tools/types.ts';
import type { DsResponse } from '../src/model/ds-client.ts';
import { tempDir } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

async function makeTempDir(): Promise<string> {
  return tempDir('irmia-netvision-');
}

function makeCtx(workspaceRoot: string, signal?: AbortSignal): ToolContext {
  return { callId: 'call_test', turn: 1, step: 1, signal: signal ?? new AbortController().signal, workspaceRoot };
}

function toolOf(defs: ToolDefinition[], name: string): ToolDefinition {
  const found = defs.find((def) => def.name === name);
  if (found === undefined) throw new Error(`工具 ${name} 未注册（注册表：${defs.map((d) => d.name).join(',')}）`);
  return found;
}

/** 只替换 lookup / fetch 的 deps，默认实现照旧 */
function netDeps(overrides: Partial<NetDeps>): Partial<NetDeps> {
  return overrides;
}

interface LocalServer {
  /** 形如 http://127.0.0.1:PORT */
  origin: string;
  close(): Promise<void>;
}

async function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<LocalServer> {
  const server = createServer((req, res) => {
    try {
      handler(req, res);
    } catch {
      res.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      // keep-alive 连接会让 close 挂住，先全部断开
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface MockModel {
  client: VisionModelClient;
  calls: VisionGenerateRequest[];
}

/**
 * 造一份**归一化后的 DsResponse**——真实客户端（`DsClient.generate`）交回的就是这个形状，
 * 文本在 `outputItems` 里。
 *
 * 这个帮助函数的存在本身是一条教训：以前 mock 直接返回原始 HTTP 形状（`{output:[...]}`），
 * 而实现按同一个错形状取文本，两边"自洽"地错在一起，于是 `vision_read` 从上线起
 * 每一次都返回 EMPTY_RESPONSE，测试却全绿。类型收窄到 `DsResponse` 之后，
 * 再造错形状就编译不过了。
 */
function dsText(text: string): DsResponse {
  return {
    status: 'completed',
    outputItems: text === '' ? [] : [{ type: 'message', id: 'msg-1', text }],
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 },
    incompleteReason: null,
    model: 'deepseek-flash',
    responseId: 'resp-1',
    durationMs: 1,
  };
}

function makeMockModel(responder: (request: VisionGenerateRequest, index: number) => DsResponse): MockModel {
  const calls: VisionGenerateRequest[] = [];
  return {
    calls,
    client: {
      generate: async (request: VisionGenerateRequest) => {
        calls.push(request);
        return responder(request, calls.length - 1);
      },
    },
  };
}

function parseJson(result: ToolHandlerResult): Record<string, unknown> {
  const parsed: unknown = JSON.parse(result.content);
  assert.ok(typeof parsed === 'object' && parsed !== null, '工具返回的不是 JSON 对象');
  return parsed as Record<string, unknown>;
}

// ──────────────────────────── 地址判定（纯函数） ────────────────────────────

test('isBlockedAddress 覆盖私网/环回/链路本地/组播与公网反例', () => {
  for (const blocked of ['127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.equal(isBlockedAddress(blocked), true, `${blocked} 应被拦`);
  }
  for (const allowed of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '192.169.1.1', '2606:4700::1111']) {
    assert.equal(isBlockedAddress(allowed), false, `${allowed} 不应被拦`);
  }
});

test('htmlToText 剥标签、去脚本、解实体并保留标题', () => {
  const { title, text } = htmlToText(
    '<html><head><title>示例 &amp; 标题</title><script>var leak=1</script><style>.a{color:red}</style></head>' +
      '<body><h1>正文开始</h1><p>世界 &amp; 你好&nbsp;&lt;ok&gt;</p><ul><li>一</li><li>二</li></ul><!--注释--></body></html>',
  );
  assert.equal(title, '示例 & 标题');
  assert.match(text, /正文开始/);
  assert.match(text, /世界 & 你好 <ok>/);
  assert.match(text, /- 一/);
  assert.doesNotMatch(text, /var leak|color:red|注释/);
});

test('sliceChars 分页边界：续读偏移可拼回原文', () => {
  const text = 'x'.repeat(100);
  const first = sliceChars(text, 0, 40);
  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, 40);
  const second = sliceChars(text, first.nextOffset ?? 0, 40);
  const third = sliceChars(text, second.nextOffset ?? 0, 40);
  assert.equal(third.nextOffset, null);
  assert.equal(first.slice + second.slice + third.slice, text);
});

// ──────────────────────────── SSRF 拦截 ────────────────────────────

test('http_get 拦截私网/环回字面地址，且不发起任何连接', async () => {
  let fetched = 0;
  const tools = createNetTools({}, netDeps({ fetch: async () => { fetched += 1; throw new Error('不该被调用'); } }));
  const get = toolOf(tools, 'http_get');
  const ctx = makeCtx(await makeTempDir());

  for (const url of ['http://127.0.0.1:8080/x', 'http://192.168.1.10/admin', 'http://169.254.169.254/latest/meta-data/']) {
    const result = await get.handler({ url }, ctx);
    assert.equal(result.isError, true, `${url} 应被拒绝`);
    assert.equal(result.error?.code, 'SSRF_BLOCKED');
    assert.match(result.content, /私网|环回|链路本地/);
  }
  assert.equal(fetched, 0, '被拦的请求不得触网');
});

test('http_get 拦截解析到私网的域名，并且群记录里任一私网即拦', async () => {
  const tools = createNetTools(
    {},
    netDeps({
      lookup: async (host) => {
        if (host === 'internal.example') return ['10.0.0.7'];
        if (host === 'rebind.example') return ['93.184.216.34', '169.254.169.254'];
        return ['93.184.216.34'];
      },
      fetch: async () => {
        throw new Error('不该被调用');
      },
    }),
  );
  const get = toolOf(tools, 'http_get');
  const ctx = makeCtx(await makeTempDir());

  const dns = await get.handler({ url: 'http://internal.example/api' }, ctx);
  assert.equal(dns.error?.code, 'SSRF_BLOCKED');
  assert.match(dns.content, /10\.0\.0\.7/);

  const multi = await get.handler({ url: 'http://rebind.example/' }, ctx);
  assert.equal(multi.error?.code, 'SSRF_BLOCKED');
  assert.match(multi.content, /169\.254\.169\.254/);
});

test('http_get 拒绝非 http/https 协议', async () => {
  const tools = createNetTools({}, netDeps({ fetch: async () => { throw new Error('不该被调用'); } }));
  const get = toolOf(tools, 'http_get');
  const result = await get.handler({ url: 'file:///etc/passwd' }, makeCtx(await makeTempDir()));
  assert.equal(result.error?.code, 'BAD_PROTOCOL');
});

test('http_get 在已取消的调用上不触网', async () => {
  let fetched = 0;
  const controller = new AbortController();
  controller.abort();
  const tools = createNetTools({}, netDeps({ fetch: async () => { fetched += 1; return new Response('x'); } }));
  const get = toolOf(tools, 'http_get');
  const result = await get.handler({ url: 'http://8.8.8.8/' }, makeCtx(await makeTempDir(), controller.signal));
  assert.equal(result.error?.code, 'E_ABORTED');
  assert.equal(fetched, 0);
});

// ──────────────────────────── 重定向逐跳复查 ────────────────────────────

test('重定向跳转到私网域名时被逐跳复查拦下', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(302, { location: 'http://internal.example/secret' });
    res.end();
  });
  try {
    let fetched = 0;
    const tools = createNetTools(
      { allowedHosts: ['127.0.0.1'] },
      netDeps({
        lookup: async () => ['192.168.1.5'],
        fetch: async (input, init) => {
          fetched += 1;
          return fetch(input as string, init);
        },
      }),
    );
    const get = toolOf(tools, 'http_get');
    const result = await get.handler({ url: `${server.origin}/` }, makeCtx(await makeTempDir()));
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, 'SSRF_BLOCKED');
    assert.match(result.content, /重定向复查未通过/);
    assert.match(result.content, /192\.168\.1\.5/);
    assert.equal(fetched, 1, '只应请求第一跳');
  } finally {
    await server.close();
  }
});

test('重定向跳转到链路本地字面地址时被拦，不读取响应体', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/iam/' });
    res.end();
  });
  try {
    const tools = createNetTools({ allowedHosts: ['127.0.0.1'] });
    const get = toolOf(tools, 'http_get');
    const result = await get.handler({ url: `${server.origin}/` }, makeCtx(await makeTempDir()));
    assert.equal(result.error?.code, 'SSRF_BLOCKED');
    assert.match(result.content, /169\.254\.169\.254/);
  } finally {
    await server.close();
  }
});

test('白名单内的正常重定向可跟随，并返回最终地址与正文', async () => {
  const target = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>终点</title></head><body><p>落地成功</p></body></html>');
  });
  const relay = await startServer((_req, res) => {
    res.writeHead(301, { location: `${target.origin}/final` });
    res.end();
  });
  try {
    const tools = createNetTools({ allowedHosts: ['127.0.0.1'] });
    const get = toolOf(tools, 'http_get');
    const result = await get.handler({ url: `${relay.origin}/start` }, makeCtx(await makeTempDir()));
    assert.equal(result.isError, undefined);
    assert.match(result.content, /\[来源\] .*\/final/);
    assert.match(result.content, /落地成功/);
    assert.match(result.content, /\[标题\] 终点/);
    assert.equal(result.additionalContext?.length, 1, '外部内容需带不可信提醒');
  } finally {
    await relay.close();
    await target.close();
  }
});

test('重定向超出跳数上限时报错而不是无限跟', async () => {
  const server = await startServer((req, res) => {
    const hop = Number(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('h') ?? '0');
    res.writeHead(302, { location: `/loop?h=${hop + 1}` });
    res.end();
  });
  try {
    const tools = createNetTools({ allowedHosts: ['127.0.0.1'], maxRedirects: 3 });
    const get = toolOf(tools, 'http_get');
    const result = await get.handler({ url: `${server.origin}/loop?h=0` }, makeCtx(await makeTempDir()));
    assert.equal(result.error?.code, 'TOO_MANY_REDIRECTS');
  } finally {
    await server.close();
  }
});

// ──────────────────────────── http_get 正文与分页 ────────────────────────────

test('http_get 提取正文并按 max_chars/offset 分页续读（回执报真实总量 + 两条路）', async () => {
  const payload = `起始标记${'甲'.repeat(300)}结束标记`;
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><body><p>${payload}</p></body></html>`);
  });
  try {
    const tools = createNetTools({ allowedHosts: ['127.0.0.1'] });
    const get = toolOf(tools, 'http_get');
    const ctx = makeCtx(await makeTempDir());

    const first = await get.handler({ url: server.origin, max_chars: 100 }, ctx);
    assert.match(first.content, /起始标记/);
    // S3：截断回执必须报**真实总量**（共 N 字节 / 已给 M / 还有 K），不是只说"继续用 offset=N"
    const trunc = /\[续读\] 共 (\d+) 字节 \/ 正文 (\d+) 字 \/ 已给 (\d+) 字 \/ 还有 (\d+) 字未读/.exec(first.content);
    assert.ok(trunc !== null, `截断回执的格式不对：${first.content}`);
    const totalBytes = Number(trunc[1]);
    const totalChars = Number(trunc[2]);
    const given = Number(trunc[3]);
    const rest = Number(trunc[4]);
    assert.equal(given, 100, '本次给到的是 max_chars');
    assert.equal(given + rest, totalChars, '已给 + 还有 = 正文总量（三格必须自洽）');
    assert.ok(totalBytes > totalChars, `字节数应是响应体真实字节（${totalBytes}）`);
    // 两条路都要给她：① offset 续读 ② 把 max_chars 提上去一次取完（并印出上限）
    const routes = /\[怎么继续\] ① offset=(\d+) 接着读；② 把 max_chars 提到 (\d+) 一次取完（上限 (\d+)/.exec(first.content);
    assert.ok(routes !== null, `续读的两条路都要写清楚：${first.content}`);
    assert.equal(Number(routes[1]), 100);
    assert.equal(Number(routes[2]), totalChars);
    assert.equal(Number(routes[3]), 500_000);

    const rest2: string[] = [];
    let offset = Number(routes[1]);
    for (let i = 0; i < 6; i += 1) {
      const page = await get.handler({ url: server.origin, max_chars: 100, offset }, ctx);
      const body = page.content.split('[正文]\n')[1] ?? '';
      rest2.push(body.split('\n[续读]')[0] ?? '');
      const moved = /offset=(\d+) 接着读/.exec(page.content);
      if (moved === null) break;
      offset = Number(moved[1]);
    }
    assert.match(rest2.join(''), /结束标记/, '续读应能取到正文结尾');
  } finally {
    await server.close();
  }
});

test('max_chars 硬上限仍在：要超过上限直接报参数错（一次给太多打爆上下文的那条顾虑）', async () => {
  const tools = createNetTools({ allowedHosts: ['127.0.0.1'] });
  const get = toolOf(tools, 'http_get');
  const result = await get.handler({ url: 'http://127.0.0.1:1/', max_chars: 600_000 }, makeCtx(await makeTempDir()));
  assert.equal(result.isError, true);
  assert.match(result.content, /500000|500_000/u);
});

test('http_get 对 4xx 记为工具错误但保留正文信息', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('没有这个页面');
  });
  try {
    const tools = createNetTools({ allowedHosts: ['127.0.0.1'] });
    const get = toolOf(tools, 'http_get');
    const result = await get.handler({ url: server.origin }, makeCtx(await makeTempDir()));
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, 'HTTP_404');
    assert.match(result.content, /没有这个页面/);
  } finally {
    await server.close();
  }
});

test('http_get 对二进制响应只回元信息，不把字节灌进上下文', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
  try {
    const tools = createNetTools({ allowedHosts: ['127.0.0.1'] });
    const get = toolOf(tools, 'http_get');
    const result = await get.handler({ url: server.origin }, makeCtx(await makeTempDir()));
    assert.match(result.content, /二进制内容/);
    assert.match(result.content, /http_download/);
  } finally {
    await server.close();
  }
});

// ──────────────────────────── http_get 抽取器接线（v79） ────────────────────────────

test('http_get 走 Markdown 抽取：行内标签不被拆成空格（asyncio.sleep 抓得到）', async () => {
  // docs.python.org 的真实形状：python 把函数名切成多个 <span>
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<html><head><title>asyncio 文档</title></head><body><h1>Sleeping</h1>'
      + '<p>协程用 <span>asyncio.</span><span>sleep</span>(delay, result=None) 睡一会儿。</p>'
      + '<pre class="language-python"><code>await asyncio.sleep(1)</code></pre></body></html>',
    );
  });
  try {
    const tools = createNetTools({ allowedHosts: ['127.0.0.1'] });
    const get = toolOf(tools, 'http_get');
    const result = await get.handler({ url: server.origin }, makeCtx(await makeTempDir()));
    assert.match(result.content, /asyncio\.sleep\(delay, result=None\)/u, '行内 token 必须原样连在一起');
    assert.doesNotMatch(result.content, /asyncio\.\s+sleep/u, '这正是旧 htmlToText 的致命缺陷（标签换成空格）');
    assert.match(result.content, /^# Sleeping$/mu, 'Markdown 结构（标题）要留着');
    assert.match(result.content, /```python\nawait asyncio\.sleep\(1\)\n```/u, '代码块要留着');
  } finally {
    await server.close();
  }
});

test('抽取器抽空时回落到 htmlToText（那条 20 行老路径还在，不许被删掉）', async () => {
  // 整页唯一的文字落在一个被判为样板的块里：新抽取器给空 ⇒ 必须回落老路径，否则她什么也拿不到
  const html = '<html><head><title>只有评论</title></head><body><div class="comment">评论区里的文字</div></body></html>';
  assert.equal(htmlToMarkdown(html), '', '夹具前提：新抽取器在这一页上确实返回空');
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  try {
    const tools = createNetTools({ allowedHosts: ['127.0.0.1'] });
    const get = toolOf(tools, 'http_get');
    const result = await get.handler({ url: server.origin }, makeCtx(await makeTempDir()));
    assert.match(result.content, /评论区里的文字/, '抽空必须回落 htmlToText，而不是回一个空正文');
    assert.match(result.content, /\[标题\] 只有评论/u);
  } finally {
    await server.close();
  }
});

test('诊断 ①：正文为空但页面是 SPA 壳 ⇒ 说清"要 JS"并点名 obscura.browser_markdown / playwright.browser_snapshot', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>单页应用</title></head><body><div id="root"></div>'
      + '<script src="/assets/app.js"></script></body></html>');
  });
  try {
    const tools = createNetTools({ allowedHosts: ['127.0.0.1'] });
    const get = toolOf(tools, 'http_get');
    const result = await get.handler({ url: server.origin }, makeCtx(await makeTempDir()));
    assert.match(result.content, /\[诊断\]/u);
    assert.match(result.content, /JavaScript/u);
    assert.match(result.content, /`obscura` 的 `browser_markdown`/u, '下一步必须点名到真实注册名');
    assert.match(result.content, /`playwright` 的 `browser_snapshot`/u);
    assert.doesNotMatch(result.content, /浏览器工具/u, '不许再写"浏览器工具"这种模糊说法（等于把选哪件丢回给她）');
    assert.doesNotMatch(result.content, /（正文为空）/u, '不许再只回「（正文为空）」');
  } finally {
    await server.close();
  }
});

test('诊断 ②：空正文（不是 SPA）⇒ 一句人话 + 下一步，仍点名两件真实工具', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>空</title></head><body><p></p><div></div></body></html>');
  });
  try {
    const tools = createNetTools({ allowedHosts: ['127.0.0.1'] });
    const get = toolOf(tools, 'http_get');
    const result = await get.handler({ url: server.origin }, makeCtx(await makeTempDir()));
    assert.match(result.content, /\[诊断\] 抽取后正文为空/u);
    assert.match(result.content, /`obscura` 的 `browser_markdown`/u);
    assert.match(result.content, /`playwright` 的 `browser_snapshot`/u);
    assert.doesNotMatch(result.content, /浏览器工具/u);
    assert.match(result.content, /http_download/u, '先核对原始字节这一条也要给她');
    assert.doesNotMatch(result.content, /（正文为空）/u);
  } finally {
    await server.close();
  }
});

test('诊断 ③：403 ⇒ 说清是站点拒绝、给出 referer/cookie 与两件真实浏览器工具', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Forbidden</title><body><h1>Forbidden</h1><p>拒绝访问</p></body></html>');
  });
  try {
    const tools = createNetTools({ allowedHosts: ['127.0.0.1'] });
    const get = toolOf(tools, 'http_get');
    const result = await get.handler({ url: server.origin }, makeCtx(await makeTempDir()));
    assert.equal(result.error?.code, 'HTTP_403');
    assert.match(result.content, /\[诊断\] 站点回了 403/u);
    assert.match(result.content, /headers/u, '先给"用 headers 带 referer/cookie 再试一次"这条路');
    assert.match(result.content, /`obscura` 的 `browser_markdown`/u);
    assert.match(result.content, /`playwright` 的 `browser_snapshot`/u);
    assert.doesNotMatch(result.content, /浏览器工具/u);
  } finally {
    await server.close();
  }
});

// ──────────────────────────── http_get 编码：读 <meta charset>、有损必须承认 ────────────────────────────

/** 用 ASCII 外壳包一段**原始字节**（模拟站点按 big5/shift_jis 直出，响应头里没写 charset） */
function encodedPage(metaCharset: string, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`<html><head><meta charset="${metaCharset}"><title>enc</title></head><body><p>`, 'latin1'),
    payload,
    Buffer.from('</p></body></html>', 'latin1'),
  ]);
}

/** Big5「中文」；Shift_JIS「中文」 */
const BIG5_ZHONGWEN = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]);
const SJIS_ZHONGWEN = Buffer.from([0x92, 0x86, 0x95, 0xb6]);
/** 0x81 在两套编码里都是非法字节 ⇒ 宽松解码会出替换字符（有损） */
const INVALID_BYTE = Buffer.from([0x81]);

test('读 HTML 的 <meta charset>：头里没写 charset 时按 big5 解出中文，且不谎报有损', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(encodedPage('big5', BIG5_ZHONGWEN));
  });
  try {
    const tools = createNetTools({ allowedHosts: ['127.0.0.1'] });
    const get = toolOf(tools, 'http_get');
    const result = await get.handler({ url: server.origin }, makeCtx(await makeTempDir()));
    assert.match(result.content, /中文/u, '按 <meta charset> 解出的中文要正确');
    assert.match(result.content, /\[编码\] 按 HTML `<meta charset>` 声明的 big5 解码，无替换字符/u);
    assert.doesNotMatch(result.content, /可能有损/u, '无损时不许乱写有损');
  } finally {
    await server.close();
  }
});

test('编码有损必须承认：声明 big5 却解出替换字符 ⇒ 回执写「可能有损」，不许替它背书', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(encodedPage('big5', Buffer.concat([BIG5_ZHONGWEN, INVALID_BYTE])));
  });
  try {
    const tools = createNetTools({ allowedHosts: ['127.0.0.1'] });
    const get = toolOf(tools, 'http_get');
    const result = await get.handler({ url: server.origin }, makeCtx(await makeTempDir()));
    assert.match(result.content, /\[编码\] .*big5.*解码/u);
    assert.match(result.content, /可能有损/u, '出现替换字符就必须承认可能有损');
    assert.match(result.content, /1 处无法映射/u);
  } finally {
    await server.close();
  }
});

test('编码有损（Shift_JIS 夹具）：同一判据在另一套编码上也成立', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(encodedPage('shift_jis', Buffer.concat([SJIS_ZHONGWEN, INVALID_BYTE])));
  });
  try {
    const tools = createNetTools({ allowedHosts: ['127.0.0.1'] });
    const get = toolOf(tools, 'http_get');
    const result = await get.handler({ url: server.origin }, makeCtx(await makeTempDir()));
    assert.match(result.content, /可能有损/u);
    assert.match(result.content, /shift_jis/u);
  } finally {
    await server.close();
  }
});

// ──────────────────────────── http_get 请求头：正常浏览器风格 ────────────────────────────

test('默认请求头是正常浏览器风格（UA + accept-language），headers 参数可逐项覆盖', async () => {
  const seen: Record<string, string | string[] | undefined>[] = [];
  const server = await startServer((req, res) => {
    seen.push({ ...req.headers });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body><p>ok</p></body></html>');
  });
  try {
    const tools = createNetTools({ allowedHosts: ['127.0.0.1'] });
    const get = toolOf(tools, 'http_get');
    const ctx = makeCtx(await makeTempDir());
    await get.handler({ url: server.origin }, ctx);
    await get.handler({ url: server.origin, headers: { 'user-agent': 'custom/1.0', referer: 'https://ref.example/' } }, ctx);

    assert.match(String(seen[0]?.['user-agent']), /^Mozilla\/5\.0 /u, '旧的自报名 IrmiaAgent/0.1 自己在招 403');
    assert.equal(seen[0]?.['accept-language'], 'zh-CN,zh;q=0.9,en;q=0.8');
    assert.equal(seen[1]?.['user-agent'], 'custom/1.0', 'headers 参数优先');
    assert.equal(seen[1]?.['referer'], 'https://ref.example/');
  } finally {
    await server.close();
  }
});

test('JSON / 纯文本原样返回，不做 Markdown 改写（也不压空白：JSON 是要被解析的）', async () => {
  const server = await startServer((req, res) => {
    if (req.url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"ok":true,"name":"中文","n":1,"spaced":"x  y"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('第一行\n第二行  with   spaces\n');
  });
  try {
    const tools = createNetTools({ allowedHosts: ['127.0.0.1'] });
    const get = toolOf(tools, 'http_get');
    const ctx = makeCtx(await makeTempDir());
    const json = await get.handler({ url: `${server.origin}/json` }, ctx);
    assert.match(json.content, /\{"ok":true,"name":"中文","n":1,"spaced":"x  y"\}/u, 'JSON 一个字节都不该被动');
    const text = await get.handler({ url: `${server.origin}/text` }, ctx);
    assert.match(text.content, /第一行\n第二行  with   spaces/u, '纯文本的连续空格也是内容');
  } finally {
    await server.close();
  }
});

// ──────────────────────────── 诊断里的工具名：必须真实存在（防名字漂） ────────────────────────────

/**
 * 这一条守的是"**回执点名的工具真的存在**"。
 *
 * 为什么需要它（2026-10-23 用户核出来的）：三段 `[诊断]` 里原先写「`playwright` 的浏览器工具」——
 * 而 `playwright` 的 25 件里**没有**名叫"浏览器工具"的那一件，宿主真正该调的是 `browser_snapshot`
 * （`obscura` 那侧则是 `browser_markdown`）。文案里指一件**不存在**的工具，比不指更糟：
 * 她会照着名字去找、找不到，然后回到重试的老路——那正是这三句要治的病。
 *
 * 判据**不抄名字**（抄一份就又多一个会漂的地方）：直接读 `data/mcp-cache/<server>.json` 的
 * `tools[].name` 作为权威名字集合，然后把回执里 `[诊断]` 那一行的两件事都核一遍：
 *   ① 每个「\`<server>\` 的 \`<tool>\`」配对 ⇒ `<tool>` 必须在该 server 的名字集合里；
 *   ② 任何 `` `browser_*` `` 反引号 token ⇒ 必须在**全体**名字集合里。
 * 名字改了、或谁记错了 ⇒ 当场红。⚠ 这条用例读的是本机缓存（`data/` 不入库）：缓存缺失时
 * **红**是**前提不成立**的信号（读不到名字集合就无法核对），不是文案坏了。
 */
test('三段诊断点名的 MCP 工具必须真实存在（拿 data/mcp-cache 的名字集合核，防名字漂）', async () => {
  const cacheDir = join('data', 'mcp-cache');
  const files = (await readdir(cacheDir).catch(() => [] as string[])).filter((name) => name.endsWith('.json'));
  assert.ok(
    files.length > 0,
    `读不到 ${cacheDir}/*.json —— 这条用例的前提是"MCP 缓存里有真实工具名"。`
    + '先让至少一个 MCP server 起过一次（缓存由宿主写），再跑这条；不要改成"读不到就跳过"。',
  );
  const namesOf = new Map<string, Set<string>>();
  const allNames = new Set<string>();
  for (const file of files) {
    const doc = JSON.parse(await readFile(join(cacheDir, file), 'utf8')) as {
      server?: string;
      tools?: { name?: unknown }[];
    };
    const server = (doc.server ?? file.replace(/\.json$/u, '')).toLowerCase();
    const names = new Set(
      (doc.tools ?? []).map((tool) => tool.name).filter((name): name is string => typeof name === 'string'),
    );
    namesOf.set(server, names);
    for (const name of names) allNames.add(name);
  }

  // 三段诊断的真身：照 ①②③ 的夹具各取一份回执，再从回执里切出 `[诊断]` 那一行
  const cases: { key: string; make: (get: ToolDefinition) => Promise<string> }[] = [
    {
      key: '403',
      make: async (get) => {
        const server = await startServer((_req, res) => {
          res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<html><body><h1>Forbidden</h1></body></html>');
        });
        try {
          return (await get.handler({ url: server.origin }, makeCtx(await makeTempDir()))).content;
        } finally {
          await server.close();
        }
      },
    },
    {
      key: 'SPA 壳',
      make: async (get) => {
        const server = await startServer((_req, res) => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<html><body><div id="root"></div><script src="/a.js"></script></body></html>');
        });
        try {
          return (await get.handler({ url: server.origin }, makeCtx(await makeTempDir()))).content;
        } finally {
          await server.close();
        }
      },
    },
    {
      key: '空正文',
      make: async (get) => {
        const server = await startServer((_req, res) => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<html><body><p></p><div></div></body></html>');
        });
        try {
          return (await get.handler({ url: server.origin }, makeCtx(await makeTempDir()))).content;
        } finally {
          await server.close();
        }
      },
    },
  ];

  const get = toolOf(createNetTools({ allowedHosts: ['127.0.0.1'] }), 'http_get');
  for (const item of cases) {
    const receipt = await item.make(get);
    const diagnosis = receipt.split('\n').find((line) => line.startsWith('[诊断]'));
    assert.ok(diagnosis !== undefined, `${item.key} 的回执里没有 [诊断] 那一行：${receipt}`);

    // ① 「`server` 的 `tool`」配对：tool 必须在该 server 的名字集合里
    const pairs = [...diagnosis.matchAll(/`([a-z0-9._-]+)` 的 `([a-z0-9_]+)`/gu)];
    assert.ok(pairs.length >= 2, `${item.key} 的诊断要点名两件真实工具（obscura / playwright 各一件）：${diagnosis}`);
    for (const [, server = '', tool = ''] of pairs) {
      const names = namesOf.get(server.toLowerCase());
      assert.ok(names !== undefined, `${item.key} 的诊断点名了 server "${server}"，但 data/mcp-cache 里没有它的缓存`);
      assert.ok(
        names.has(tool),
        `${item.key} 的诊断点名 \`${server}\` 的 \`${tool}\`，但该 server 的 ${names.size} 件里没有这个名字`
        + `（真名见 data/mcp-cache/${server}.json 的 tools[].name）`,
      );
    }

    // ② 任何 `browser_*` 反引号 token 都必须是真实的 MCP 工具名
    for (const [, token = ''] of diagnosis.matchAll(/`(browser_[a-z0-9_]+)`/gu)) {
      assert.ok(
        allNames.has(token),
        `${item.key} 的诊断写了 \`${token}\`，但 data/mcp-cache 的全部 ${allNames.size} 个工具名里没有它`,
      );
    }
    assert.doesNotMatch(diagnosis, /浏览器工具/u, `${item.key} 的诊断不许写"浏览器工具"（模糊说法等于没指名）`);
  }
});

// ──────────────────────────── http_post / download 默认关 ────────────────────────────

test('http_post 与 http_download 默认不注册，需显式开启', () => {
  const defaults = createNetTools().map((tool) => tool.name);
  assert.deepEqual(defaults, ['http_get']);

  const opened = createNetTools({ enablePost: true, enableDownload: true }).map((tool) => tool.name);
  assert.deepEqual(opened, ['http_get', 'http_post', 'http_download']);

  const post = toolOf(createNetTools({ enablePost: true }), 'http_post');
  assert.equal(post.sideEffect, 'destructive');
  assert.equal(post.executionMode, 'parallel');
  assert.equal(toolOf(createNetTools(), 'http_get').sideEffect, 'none');
});

test('http_post 发送 JSON 体并回读响应', async () => {
  const received: { body: string; contentType: string | undefined }[] = [];
  const server = await startServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ body: Buffer.concat(chunks).toString('utf8'), contentType: req.headers['content-type'] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  try {
    const tools = createNetTools({ allowedHosts: ['127.0.0.1'], enablePost: true });
    const post = toolOf(tools, 'http_post');
    const result = await post.handler({ url: server.origin, body: { hello: '世界' } }, makeCtx(await makeTempDir()));
    assert.equal(result.isError, undefined);
    assert.equal(received.length, 1);
    assert.equal(received[0]?.body, '{"hello":"世界"}');
    assert.equal(received[0]?.contentType, 'application/json');
    assert.match(result.content, /"ok":true/);
  } finally {
    await server.close();
  }
});

// ──────────────────────────── http_download ────────────────────────────

test('http_download 落盘成功并把文件写全', async () => {
  const payload = Buffer.from('Irmia 下载测试内容'.repeat(50), 'utf8');
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(payload.byteLength) });
    res.end(payload);
  });
  const workspace = await makeTempDir();
  try {
    const tools = createNetTools({ allowedHosts: ['127.0.0.1'], enableDownload: true });
    const download = toolOf(tools, 'http_download');
    const result = await download.handler({ url: server.origin, dest_path: 'out/data.bin' }, makeCtx(workspace));
    assert.equal(result.isError, undefined);
    assert.match(result.content, /\[已保存\]/);
    const written = await readFile(join(workspace, 'out', 'data.bin'));
    assert.equal(written.byteLength, payload.byteLength);
    assert.deepEqual(written, payload);
  } finally {
    await server.close();
  }
});

test('http_download 流式计数超限即中止并清理残留', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.alloc(4096, 7));
  });
  const workspace = await makeTempDir();
  try {
    const tools = createNetTools({ allowedHosts: ['127.0.0.1'], enableDownload: true, maxDownloadBytes: 1024 });
    const download = toolOf(tools, 'http_download');
    const result = await download.handler({ url: server.origin, dest_path: 'big.bin' }, makeCtx(workspace));
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, 'TOO_LARGE');
    assert.match(result.content, /超过上限 1024 字节/);
    assert.deepEqual(await readdir(workspace), [], '不得留下目标文件或 .part 残留');
  } finally {
    await server.close();
  }
});

test('http_download 用 Content-Length 预检在下载前中止', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '999999' });
    res.end(Buffer.alloc(16));
  });
  const workspace = await makeTempDir();
  try {
    const tools = createNetTools({ allowedHosts: ['127.0.0.1'], enableDownload: true, maxDownloadBytes: 1024 });
    const download = toolOf(tools, 'http_download');
    const result = await download.handler({ url: server.origin, dest_path: 'pre.bin' }, makeCtx(workspace));
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, 'TOO_LARGE');
    assert.match(result.content, /Content-Length 999999 字节超过上限/);
    assert.deepEqual(await readdir(workspace), []);
  } finally {
    await server.close();
  }
});

test('http_download 拒绝越界路径（含 ../ 与绝对路径）', async () => {
  const workspace = await makeTempDir();
  const tools = createNetTools({ allowedHosts: ['127.0.0.1'], enableDownload: true });
  const download = toolOf(tools, 'http_download');
  const ctx = makeCtx(workspace);

  for (const dest of ['../escape.bin', join(tmpdir(), 'escape-absolute.bin'), 'sub/../../escape.bin']) {
    const result = await download.handler({ url: 'http://127.0.0.1:1/x', dest_path: dest }, ctx);
    assert.equal(result.isError, true, `${dest} 应被拒绝`);
    assert.equal(result.error?.code, 'E_UNSAFE_PATH');
  }
});

test('默认下载上限常量是 500MB', () => {
  assert.equal(DEFAULT_MAX_DOWNLOAD_BYTES, 500 * 1024 * 1024);
});

// ──────────────────────────── vision_read ────────────────────────────

test('vision_read 缓存命中后不再调用模型（同图同问题）', async () => {
  const workspace = await makeTempDir();
  await mkdir(join(workspace, 'pics'), { recursive: true });
  await writeFile(join(workspace, 'pics', 'cat.png'), Buffer.from('fake-png-bytes'));
  const dataDir = await makeTempDir();

  const mock = makeMockModel(() =>
    dsText(JSON.stringify({ peek: '一只橘猫', text: '一只橘猫躺在窗台上，窗外有树。', tags: ['猫', '室内'] })));
  const tools = createVisionTools({ dsClient: mock.client, dataDir, clock: () => new Date('2026-09-30T10:00:00.000Z') });
  const read = toolOf(tools, 'vision_read');
  const ctx = makeCtx(workspace);

  const first = parseJson(await read.handler({ paths: ['pics/cat.png'] }, ctx));
  assert.equal(first['fresh'], 1);
  assert.equal(first['cached'], 0);
  assert.equal(mock.calls.length, 1);

  const second = parseJson(await read.handler({ paths: ['pics/cat.png'] }, ctx));
  assert.equal(second['fresh'], 0);
  assert.equal(second['cached'], 1);
  assert.equal(mock.calls.length, 1, '命中缓存不得再调模型');

  const otherQuestion = parseJson(await read.handler({ paths: ['pics/cat.png'], question: '窗外有什么？' }, ctx));
  assert.equal(otherQuestion['fresh'], 1);
  assert.equal(mock.calls.length, 2, '换问题 = 换缓存键，需重新调用');
});

test('vision_read 请求形状：light 模型 + input_image + json_schema', async () => {
  const workspace = await makeTempDir();
  await writeFile(join(workspace, 'a.png'), Buffer.from('aaa'));
  const dataDir = await makeTempDir();
  const mock = makeMockModel(() => dsText('{"peek":"p","text":"t","tags":["tag"]}'));
  const read = toolOf(createVisionTools({ dsClient: mock.client, dataDir }), 'vision_read');

  await read.handler({ paths: ['a.png'], question: '这是什么？' }, makeCtx(workspace));
  const request = mock.calls[0];
  assert.ok(request !== undefined);
  assert.equal(request.lane, 'light');
  assert.equal(request.model, DEFAULT_VISION_MODEL);
  const content = request.input[0]?.content ?? [];
  assert.equal(content[0]?.type, 'input_text');
  const image = content[1];
  assert.equal(image?.type, 'input_image');
  assert.match(image?.type === 'input_image' ? image.image_url : '', /^data:image\/png;base64,YWFh$/);
  assert.equal(request.text.type, 'json_schema');
  assert.equal(request.text.name, 'vision_result');
  assert.deepEqual(request.text.schema['required'], ['peek', 'text', 'tags']);
});

test('vision_read 结构化结果容错：围栏 JSON、夹杂解释、纯文本回退', async () => {
  const workspace = await makeTempDir();
  const dataDir = await makeTempDir();
  await writeFile(join(workspace, 'fenced.png'), Buffer.from('f'));
  await writeFile(join(workspace, 'chatty.jpg'), Buffer.from('c'));
  await writeFile(join(workspace, 'plain.webp'), Buffer.from('p'));

  const responses = [
    '```json\n{"peek":"围栏内","text":"围栏里的 JSON","tags":["a","b"]}\n```',
    '分析如下：{"peek":"夹杂","text":"夹杂解释的 JSON","tags":"标签1,标签2"} 完毕。',
    '这是一张纯文本描述，没有 JSON。',
  ];
  const mock = makeMockModel((_request, index) => dsText(responses[index] ?? ''));
  const read = toolOf(createVisionTools({ dsClient: mock.client, dataDir }), 'vision_read');
  const ctx = makeCtx(workspace);

  const fenced = parseJson(await read.handler({ paths: ['fenced.png'] }, ctx));
  const fencedItem = (fenced['images'] as Record<string, unknown>[])[0];
  assert.equal(fencedItem?.['peek'], '围栏内');
  assert.deepEqual(fencedItem?.['tags'], ['a', 'b']);
  assert.equal(fencedItem?.['fallback'], undefined);

  const chatty = parseJson(await read.handler({ paths: ['chatty.jpg'] }, ctx));
  const chattyItem = (chatty['images'] as Record<string, unknown>[])[0];
  assert.equal(chattyItem?.['peek'], '夹杂');
  assert.deepEqual(chattyItem?.['tags'], ['标签1', '标签2']);

  const plain = parseJson(await read.handler({ paths: ['plain.webp'] }, ctx));
  const plainItem = (plain['images'] as Record<string, unknown>[])[0];
  assert.equal(plainItem?.['fallback'], true);
  assert.match(String(plainItem?.['peek']), /纯文本描述/);

  // 回退结果也要能从缓存里取回全文
  const query = toolOf(createVisionTools({ dsClient: mock.client, dataDir }), 'vision_query');
  const full = parseJson(
    await query.handler({ result_id: String(plainItem?.['result_id']) }, ctx),
  );
  assert.match(String(full['text']), /没有 JSON/);
});

test('vision_read 拒绝超大图片（上限常量 20MB）并不调模型', async () => {
  const workspace = await makeTempDir();
  const dataDir = await makeTempDir();
  await writeFile(join(workspace, 'big.png'), Buffer.alloc(4096));
  const mock = makeMockModel(() => dsText('unused'));
  const read = toolOf(createVisionTools({ dsClient: mock.client, dataDir, maxImageBytes: 1024 }), 'vision_read');

  const summary = parseJson(await read.handler({ paths: ['big.png'] }, makeCtx(workspace)));
  const item = (summary['images'] as Record<string, unknown>[])[0];
  const error = item?.['error'] as Record<string, unknown> | undefined;
  assert.equal(error?.['code'], 'TOO_LARGE');
  assert.equal(summary['failed'], 1);
  assert.equal(mock.calls.length, 0);
  assert.equal(DEFAULT_MAX_IMAGE_BYTES, 20 * 1024 * 1024);
});

test('vision_read 目录遍历只收图片扩展名，GIF 标注仅首帧', async () => {
  const workspace = await makeTempDir();
  const dataDir = await makeTempDir();
  await mkdir(join(workspace, 'album', 'sub'), { recursive: true });
  await writeFile(join(workspace, 'album', 'b.jpg'), Buffer.from('b'));
  await writeFile(join(workspace, 'album', 'sub', 'a.gif'), Buffer.from('g'));
  await writeFile(join(workspace, 'album', 'notes.txt'), 'not an image');

  const mock = makeMockModel(() => dsText('{"peek":"p","text":"t","tags":[]}'));
  const read = toolOf(createVisionTools({ dsClient: mock.client, dataDir }), 'vision_read');
  const summary = parseJson(await read.handler({ paths: ['album'] }, makeCtx(workspace)));

  assert.equal(summary['total'], 2);
  assert.equal(summary['skipped_non_image'], 1);
  assert.equal(mock.calls.length, 2);
  const images = summary['images'] as Record<string, unknown>[];
  const gif = images.find((item) => String(item['filename']).endsWith('.gif'));
  assert.ok(gif !== undefined, '目录里的 gif 应被收集');
  assert.match(String(gif['note']), /GIF 仅首帧/);
  const gifRequest = mock.calls[1];
  assert.match(gifRequest?.input[0]?.content[1]?.type === 'input_image' ? gifRequest.input[0].content[1].image_url : '', /^data:image\/gif;base64,/);
});

test('vision_read：路径越界不再被边界拒（v64 读类），非图片扩展名照旧拒', async () => {
  const workspace = await makeTempDir();
  const dataDir = await makeTempDir();
  await writeFile(join(workspace, 'note.txt'), 'x');
  const mock = makeMockModel(() => dsText('{}'));
  const read = toolOf(createVisionTools({ dsClient: mock.client, dataDir }), 'vision_read');
  const ctx = makeCtx(workspace);

  // v64：`vision_read` 属**读类** ⇒ `trust.mode` 不管它；这条路径不存在，所以按"文件不存在"报，
  // 但**不许**再出现边界拒绝那一条（那是旧口径的产物）
  const escape = await read.handler({ paths: ['../outside.png'] }, ctx);
  assert.notEqual(escape.error?.code, 'E_UNSAFE_PATH', '读类不该再有边界拒绝这条路');

  const unsupported = await read.handler({ paths: ['note.txt'] }, ctx);
  assert.equal(unsupported.error?.code, 'UNSUPPORTED_TYPE');

  const missing = await read.handler({ paths: ['nope.png'] }, ctx);
  assert.equal(missing.error?.code, 'E_NOT_FOUND');
  assert.equal(mock.calls.length, 0);
});

test('vision_read 模型失败与空响应被记为条目错误，不写缓存', async () => {
  const workspace = await makeTempDir();
  const dataDir = await makeTempDir();
  await writeFile(join(workspace, 'x.png'), Buffer.from('x'));
  const failing: VisionModelClient = {
    generate: async () => {
      throw new Error('模型不可用');
    },
  };
  const read = toolOf(createVisionTools({ dsClient: failing, dataDir }), 'vision_read');
  const summary = parseJson(await read.handler({ paths: ['x.png'] }, makeCtx(workspace)));
  const item = (summary['images'] as Record<string, unknown>[])[0];
  const error = item?.['error'] as Record<string, unknown> | undefined;
  assert.equal(error?.['code'], 'MODEL_FAILED');
  await assert.rejects(readdir(join(dataDir, VISION_CACHE_DIR_NAME)), '失败不应写缓存');

  const empty = makeMockModel(() => dsText(''));
  const readEmpty = toolOf(createVisionTools({ dsClient: empty.client, dataDir }), 'vision_read');
  const emptySummary = parseJson(await readEmpty.handler({ paths: ['x.png'] }, makeCtx(workspace)));
  const emptyItem = (emptySummary['images'] as Record<string, unknown>[])[0];
  assert.equal((emptyItem?.['error'] as Record<string, unknown> | undefined)?.['code'], 'EMPTY_RESPONSE');
});

// ──────────────────────────── vision_read · inline 直通 ────────────────────────────

test('vision_read 的 inline：写 image/attached 把原图放进上下文，不再调视觉模型', async () => {
  // 用户要的"两条途径"里的第二条：默认那条是转述（文字描述、可检索），
  // inline 这条是"我要自己看原图"。工具结果塞不下图片，所以它靠写一条事件达成。
  const workspace = await makeTempDir();
  const dataDir = await makeTempDir();
  await writeFile(join(workspace, 'pic.png'), Buffer.from('png-bytes'));
  const emitted: Array<{ type: string; data: Record<string, unknown> }> = [];
  const mock = makeMockModel(() => dsText('inline 不该走到这里'));
  const read = toolOf(
    createVisionTools({
      dsClient: mock.client,
      dataDir,
      emit: (type, data) => { emitted.push({ type, data: data as Record<string, unknown> }); },
      imagesToContext: true,
    }),
    'vision_read',
  );

  const result = parseJson(await read.handler({ paths: ['pic.png'], inline: true }, makeCtx(workspace)));
  assert.equal(result['inline'], true);
  assert.deepEqual(result['attached'], ['pic.png']);
  assert.equal(emitted.length, 1, '一张图一条事件');
  assert.equal(emitted[0]?.type, 'image/attached');
  assert.equal(emitted[0]?.data['key'], 'pic.png', 'key 是工作目录内的路径：渲染层靠它读本地字节');
  assert.equal(emitted[0]?.data['mime'], 'image/png');
  assert.equal(emitted[0]?.data['name'], 'pic.png');
  assert.equal(mock.calls.length, 0, 'inline 是直通：再调一次视觉模型就是白花钱');
  assert.match(result['hint'] as string, /放进你的上下文/);

  // 不写缓存：缓存是"转述"的产物，直通没有转述可存
  await assert.rejects(readdir(join(dataDir, VISION_CACHE_DIR_NAME)));
});

test('vision_read 的 inline：没开图片直通时如实报不可用，不写一条没人看的事件', async () => {
  const workspace = await makeTempDir();
  const dataDir = await makeTempDir();
  await writeFile(join(workspace, 'pic.png'), Buffer.from('png-bytes'));
  const emitted: unknown[] = [];
  const read = toolOf(
    createVisionTools({
      dsClient: makeMockModel(() => dsText('{}')).client,
      dataDir,
      emit: (type, data) => { emitted.push({ type, data }); },
      imagesToContext: false,
    }),
    'vision_read',
  );

  const result = await read.handler({ paths: ['pic.png'], inline: true }, makeCtx(workspace));
  assert.equal(result.isError, true);
  assert.match(result.content, /inline 现在不通/);
  assert.equal(emitted.length, 0, '写了也不会被渲染层注入——那种"假成功"会让她以为她看过了');
});

// ──────────────────────────── vision_query ────────────────────────────

test('vision_query 支持关键词 AND、文件名、recent、分页与全文取回', async () => {
  const workspace = await makeTempDir();
  const dataDir = await makeTempDir();
  await writeFile(join(workspace, 'cat.png'), Buffer.from('cat-bytes'));
  await writeFile(join(workspace, 'invoice.jpg'), Buffer.from('invoice-bytes'));
  await writeFile(join(workspace, 'dog.png'), Buffer.from('dog-bytes'));

  const answers: Record<string, unknown> = {
    'cat-bytes': { peek: '一只橘猫趴在窗台', text: '室内场景，一只橘猫趴在窗台上，窗外有树。', tags: ['猫', '室内'] },
    'invoice-bytes': { peek: '一张发票照片', text: '一张增值税发票，金额 1200 元，抬头为示例公司。', tags: ['发票', '金额'] },
    'dog-bytes': { peek: '一只狗在草地', text: '户外场景，一只棕色狗在草地上奔跑。', tags: ['狗', '户外'] },
  };
  const mock = makeMockModel((request) => {
    const imageUrl = request.input[0]?.content[1];
    const base64 = imageUrl?.type === 'input_image' ? imageUrl.image_url.split('base64,')[1] ?? '' : '';
    const decoded = Buffer.from(base64, 'base64').toString('utf8');
    return dsText(JSON.stringify(answers[decoded] ?? { peek: '未知', text: '', tags: [] }));
  });
  const clockTimes = ['2026-09-30T10:00:00.000Z', '2026-09-30T11:00:00.000Z', '2026-09-30T12:00:00.000Z'];
  let tick = 0;
  const tools = createVisionTools({
    dsClient: mock.client,
    dataDir,
    clock: () => new Date(clockTimes[Math.min(tick++, clockTimes.length - 1)] ?? '2026-09-30T12:00:00.000Z'),
  });
  const read = toolOf(tools, 'vision_read');
  const query = toolOf(tools, 'vision_query');
  const ctx = makeCtx(workspace);

  await read.handler({ paths: ['cat.png', 'invoice.jpg', 'dog.png'] }, ctx);
  assert.equal(mock.calls.length, 3);

  const both = parseJson(await query.handler({ query: '猫 室内' }, ctx));
  assert.equal(both['total'], 1);
  assert.deepEqual((both['items'] as Record<string, unknown>[])[0]?.['tags'], ['猫', '室内']);

  const excluded = parseJson(await query.handler({ query: '猫 户外' }, ctx));
  assert.equal(excluded['total'], 0, '空格式匹配：并非全部关键词命中就应排除');

  const byName = parseJson(await query.handler({ filename: 'invoice' }, ctx));
  assert.equal(byName['total'], 1);
  assert.match(String((byName['items'] as Record<string, unknown>[])[0]?.['filename']), /invoice\.jpg/);

  const recent = parseJson(await query.handler({ recent: 2 }, ctx));
  assert.equal(recent['total'], 2);
  // 读入顺序按文件名升序（cat 10:00 → dog 11:00 → invoice 12:00），最近的是 invoice
  assert.equal((recent['items'] as Record<string, unknown>[])[0]?.['peek'], '一张发票照片', 'recent 按读入时间倒序');

  const page1 = parseJson(await query.handler({ limit: 2, offset: 0 }, ctx));
  const page2 = parseJson(await query.handler({ limit: 2, offset: 2 }, ctx));
  assert.equal((page1['items'] as unknown[]).length, 2);
  assert.equal((page2['items'] as unknown[]).length, 1);
  assert.equal(page2['total'], 3);

  const firstId = String((page1['items'] as Record<string, unknown>[])[0]?.['result_id']);
  const full = parseJson(await query.handler({ result_id: firstId }, ctx));
  assert.equal(full['result_id'], firstId);
  assert.match(String(full['text']), /发票/);
  assert.equal(full['question'] !== undefined, true);

  const missingId = await query.handler({ result_id: 'deadbeef-cafe' }, ctx);
  assert.equal(missingId.error?.code, 'E_NOT_FOUND');
});

test('vision_query 在缓存目录缺失时返回空列表而不是报错', async () => {
  const dataDir = await makeTempDir();
  const workspace = await makeTempDir();
  const mock = makeMockModel(() => dsText('{}'));
  const query = toolOf(createVisionTools({ dsClient: mock.client, dataDir }), 'vision_query');
  const result = await query.handler({}, makeCtx(workspace));
  assert.equal(result.isError, undefined);
  const parsed = parseJson(result);
  assert.equal(parsed['total'], 0);
  assert.deepEqual(parsed['items'], []);
});

test('vision 缓存文件写的是内容 SHA256 命名的 JSON 信封', async () => {
  const workspace = await makeTempDir();
  const dataDir = await makeTempDir();
  await writeFile(join(workspace, 'x.png'), Buffer.from('content-x'));
  const mock = makeMockModel(() => dsText('{"peek":"p","text":"t","tags":[]}'));
  const read = toolOf(createVisionTools({ dsClient: mock.client, dataDir }), 'vision_read');
  await read.handler({ paths: ['x.png'], question: 'q1' }, makeCtx(workspace));

  const names = await readdir(join(dataDir, VISION_CACHE_DIR_NAME));
  assert.equal(names.length, 1);
  const name = names[0] ?? '';
  assert.match(name, /^[0-9a-f]{64}\.json$/);
  const envelope: unknown = JSON.parse(await readFile(join(dataDir, VISION_CACHE_DIR_NAME, name), 'utf8'));
  const record = envelope as { version?: unknown; sha256?: unknown; entries?: unknown[] };
  assert.equal(record.version, 1);
  assert.equal(`${String(record.sha256)}.json`, name);
  assert.equal(record.entries?.length, 1);
});

// ──────────────────────────── 纯函数补充 ────────────────────────────

test('extractResponseText 兼容 Responses 与 OpenAI 两种响应形状', () => {
  assert.equal(extractResponseText({ output_text: ' 直取 ' }), '直取');
  assert.equal(
    extractResponseText({ output: [{ content: [{ type: 'output_text', text: '第一段' }, { type: 'output_text', text: '第二段' }] }] }),
    '第一段\n第二段',
  );
  assert.equal(extractResponseText({ choices: [{ message: { content: '兼容形状' } }] }), '兼容形状');
  assert.equal(extractResponseText(null), '');
});

test('extractResponseText 认归一化 DsResponse：只取 message，不把思维链当答案', () => {
  // 真实客户端交回的就是这个形状。以前这一支不存在，于是 vision_read 恒 EMPTY_RESPONSE——
  // 图片明明送到了模型、HTTP 200、模型也答了，本地却取回空串。
  assert.equal(extractResponseText(dsText('模型的回答')), '模型的回答');
  assert.equal(
    extractResponseText({
      status: 'completed',
      outputItems: [
        { type: 'reasoning', id: 'r1', text: '我先想想……（思维链不该进结果）' },
        { type: 'message', id: 'm1', text: '真正的回答' },
      ],
    }),
    '真正的回答',
    'reasoning 项里也有 text 字段，混进来会污染 json_schema 的结构化解析',
  );
  // 只有思维链、没有 message：算空响应，不能拿思维链顶包
  assert.equal(
    extractResponseText({ outputItems: [{ type: 'reasoning', id: 'r1', text: '只有思考' }] }),
    '',
  );
  // 归一化形状在没有可用文本时，仍能落回下面的兼容分支
  assert.equal(extractResponseText({ outputItems: [], output_text: ' 兜底 ' }), '兜底');
});

test('parseVisionResult 缺失字段时用 text 兜底 peek', () => {
  const parsed = parseVisionResult('{"text":"只有正文，没有 peek","tags":[]}');
  assert.equal(parsed.fallback, false);
  assert.equal(parsed.peek, '只有正文，没有 peek');
  assert.deepEqual(parsed.tags, []);
});
