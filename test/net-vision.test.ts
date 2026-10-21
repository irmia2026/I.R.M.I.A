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

test('http_get 提取正文并按 max_chars/offset 分页续读', async () => {
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
    assert.match(first.content, /\[续读\] 已返回字符 \[0, 100\)/);
    const nextOffset = /offset=(\d+)/.exec(first.content)?.[1];
    assert.ok(nextOffset !== undefined, '截断响应必须给出续读方法');

    const rest: string[] = [];
    let offset = Number(nextOffset);
    for (let i = 0; i < 6; i += 1) {
      const page = await get.handler({ url: server.origin, max_chars: 100, offset }, ctx);
      const body = page.content.split('[正文]\n')[1] ?? '';
      const moved = /offset=(\d+)/.exec(page.content);
      rest.push(body.split('\n[续读]')[0] ?? '');
      if (moved === null) break;
      offset = Number(moved[1]);
    }
    assert.match(rest.join(''), /结束标记/, '续读应能取到正文结尾');
  } finally {
    await server.close();
  }
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
