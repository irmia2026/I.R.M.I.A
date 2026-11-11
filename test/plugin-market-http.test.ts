/**
 * 插件市场的 **HTTP 面**（`GET /api/plugins/market*` + `POST /api/commands/plugin-market-install`）。
 *
 * 纪律：**不联网、不读仓库外的东西**。索引与包都由假 fetch 提供，临时工程走
 * `test/helpers/temp-dirs.ts`；包是内存里现造的 zip（store，不依赖 zip 库）。
 * 这条用例同时钉住四件事：
 *   ① 取索引的受控网络（缓存 / 刷新 / 2MB / 超时 / 非 2xx / 同源重定向）；
 *   ② 单插件审阅（permissions + net + engine 兼容性）；
 *   ③ 安装只认索引里的 id+version（body 里的 url/sha256 一律拒绝），sha256 不符不落包；
 *   ④ 安装完成后仍是 untrusted，且索引与包内 net 不一致时安装仍成、审阅里显眼标出。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { AGENT_VERSION } from '../src/main.ts';
import { EventLog } from '../src/log/event-log.ts';
import { defaultVisibility, emptyProjection, type AppEvent } from '../src/log/types.ts';
import { PluginManager } from '../src/plugin/manager.ts';
import {
  MARKET_LIMITS, parseMarketIndex,
} from '../src/plugin/market.ts';
import { PluginMarketClient, type MarketHttpFetch, type MarketHttpResponse } from '../src/plugin/market-http.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const TOKEN = 'market-http-test-token';
const NOW = new Date('2026-10-29T00:00:00.000Z');
const INDEX_URL = 'https://market.test/plugins/index.json';
const PACKAGE_URL = 'https://market.test/plugins/market-demo/1.0.0.zip';
const ENGINE = '>=0.1.0-beta.1';

// ──────────────────────────────── 内存 zip ────────────────────────────────

interface ZipEntry { readonly name: string; readonly data: Buffer }

/** 造一个最小 store-zip（市场客户端不读 CRC，整包 sha256 才是判据） */
function buildZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const record = Buffer.concat([local, name, entry.data]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    locals.push(record);
    offset += record.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, eocd]);
}

function manifestOf(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: 2,
    id: 'market-demo',
    version: '1.0.0',
    engine: { irmia: ENGINE },
    runtime: { type: 'node', entry: 'main.mjs' },
    permissions: ['net', 'tools.define'],
    meta: { title: '市场测试插件' },
    net: { allow: ['api.example.com'] },
    ...patch,
  };
}

function packageBodyOf(manifestPatch: Record<string, unknown> = {}): Buffer {
  return buildZip([
    { name: 'plugin.json', data: Buffer.from(JSON.stringify(manifestOf(manifestPatch), null, 2), 'utf8') },
    { name: 'main.mjs', data: Buffer.from('export async function activate(ctx) { ctx.log.info("market-demo"); }\n', 'utf8') },
  ]);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface MarketPair {
  readonly index: string;
  readonly body: Buffer;
  readonly release: Record<string, unknown>;
}

function marketPair(options: {
  manifest?: Record<string, unknown>;
  release?: Record<string, unknown>;
  entry?: Record<string, unknown>;
} = {}): MarketPair {
  const body = packageBodyOf(options.manifest);
  const release = {
    version: '1.0.0',
    apiVersion: 2,
    engine: ENGINE,
    url: PACKAGE_URL,
    sha256: sha256(body),
    size: body.length,
    permissions: ['net', 'tools.define'],
    net: ['api.example.com'],
    runtime: 'node',
    signature: null,
    ...options.release,
  };
  const index = JSON.stringify({
    schema: 1,
    updatedAt: '2026-10-29T00:00:00.000Z',
    plugins: [{ id: 'market-demo', latest: '1.0.0', title: '演示插件', author: 'tests', desc: '市场 HTTP 面测试', versions: [release], ...options.entry }],
  });
  return { index, body, release };
}

// ──────────────────────────────── 假市场 ────────────────────────────────

interface MarketState {
  indexText: string;
  indexStatus: number;
  indexStatusText: string;
  indexHeaders: Record<string, string>;
  indexHang: boolean;
  packageBody: Buffer;
  packageStatus: number;
  indexCalls: number;
  packageCalls: number;
}

interface Fixture {
  dir: string;
  dataDir: string;
  source: string;
  manager: PluginManager;
  server: WebServer;
  state: MarketState;
  clock: { now: Date };
  call(path: string, body?: unknown, confirm?: string): Promise<{ status: number; text: string; body: any }>;
}

function httpResponse(body: Uint8Array | string, options: {
  status?: number; statusText?: string; headers?: Record<string, string>; url: string;
}): MarketHttpResponse {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  return {
    ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    url: options.url,
    headers: { get: (name: string) => options.headers?.[name.toLowerCase()] ?? null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

function fakeMarket(state: MarketState): MarketHttpFetch {
  return async (url, init) => {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    const isIndex = parsed !== null && parsed.origin === new URL(INDEX_URL).origin && parsed.pathname === '/plugins/index.json';
    if (isIndex) {
      state.indexCalls += 1;
      // 同源重定向用例：第一跳 302，第二跳就按正常索引回 200（真实站点也是这么收尾的）
      const status = state.indexStatus === 302 && state.indexCalls > 1 ? 200 : state.indexStatus;
      if (state.indexHang) {
        return await new Promise<MarketHttpResponse>((_resolve, reject) => {
          const signal = init.signal;
          const abort = (): void => {
            const error = new Error('The operation was aborted due to timeout');
            error.name = 'TimeoutError';
            reject(error);
          };
          if (signal?.aborted === true) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return httpResponse(state.indexText, {
        status,
        statusText: state.indexStatusText,
        headers: state.indexHeaders,
        url,
      });
    }
    if (url === PACKAGE_URL) {
      state.packageCalls += 1;
      return httpResponse(state.packageBody, { status: state.packageStatus, url });
    }
    return httpResponse('not found', { status: 404, statusText: 'Not Found', url });
  };
}

// ──────────────────────────────── 夹具 ────────────────────────────────

async function setup(t: TestContext, options: {
  marketEnabled?: boolean;
  pair?: MarketPair;
  timeoutMs?: number;
  clock?: { now: Date };
} = {}): Promise<Fixture> {
  const dir = tempDirSync('irmia-plugin-market-http-');
  const dataDir = join(dir, 'data');
  const source = join(dir, 'source');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(source, { recursive: true });
  const pair = options.pair ?? marketPair();
  const state: MarketState = {
    indexText: pair.index,
    indexStatus: 200,
    indexStatusText: 'OK',
    indexHeaders: { 'content-type': 'application/json' },
    indexHang: false,
    packageBody: pair.body,
    packageStatus: 200,
    indexCalls: 0,
    packageCalls: 0,
  };
  const clock = options.clock ?? { now: new Date(NOW) };
  const log = await EventLog.open(join(dataDir, 'events'));
  const manager = new PluginManager(dataDir, (type, data) => {
    const event = { seq: log.nextSeq(), ts: clock.now.toISOString(), type, data, visibility: defaultVisibility(type) } as AppEvent;
    log.append(event, { sync: true });
  });
  const config = defaultConfig(dir);
  config.plugins = {
    marketEnabled: options.marketEnabled ?? true,
    marketIndexUrl: INDEX_URL,
  };
  const server = await startWebServer({
    log,
    projection: emptyProjection(),
    config,
    personaRoot: join(dataDir, 'persona'),
    dataDir,
    timers: new TimerStore(join(dataDir, 'timers.json'), { now: () => clock.now }),
    now: () => clock.now,
    uiToken: TOKEN,
    port: 0,
    plugins: manager,
    marketFetch: fakeMarket(state),
    ...(options.timeoutMs === undefined ? {} : { marketTimeoutMs: options.timeoutMs }),
  });
  t.after(async () => {
    await server.close();
    log.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 偶发句柄占用：清理失败不改变结论 */
    }
  });
  return {
    dir, dataDir, source, manager, server, state, clock,
    async call(path, body, confirm) {
      const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
      if (confirm !== undefined) headers['x-confirm'] = confirm;
      const response = await fetch(`${server.url()}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, text, body: JSON.parse(text) as any };
    },
  };
}

// ──────────────────────────────── 索引解析：net ────────────────────────────────

test('索引 net：不合法项逐条报 MarketProblem，不拖垮整份索引', () => {
  const release = {
    version: '1.0.0', apiVersion: 2, engine: '>=0.1.0-beta.1', url: PACKAGE_URL,
    sha256: 'a'.repeat(64), size: 128, permissions: [], runtime: 'node', signature: null,
    net: ['api.example.com', 'bad host', 42, '*.'],
  };
  const parsed = parseMarketIndex(JSON.stringify({
    schema: 1,
    plugins: [
      { id: 'bad-net', versions: [release] },
      { id: 'good', versions: [{ ...release, net: ['ok.example.com', '*.cdn.example.com', '127.0.0.1'] }] },
    ],
  }));
  const netProblems = parsed.problems.filter((problem) => problem.path.includes('.net'));
  assert.deepEqual(netProblems.map((problem) => problem.path), [
    'plugins[0].versions[0].net.[1]',
    'plugins[0].versions[0].net.[2]',
    'plugins[0].versions[0].net.[3]',
  ]);
  assert.ok(netProblems.every((problem) => problem.code === 'market-entry-invalid'));
  assert.deepEqual(parsed.index.plugins.map((plugin) => plugin.id), ['good'], '坏条目只丢自己');
  assert.deepEqual(parsed.index.plugins[0]!.versions[0]!.net, ['ok.example.com', '*.cdn.example.com', '127.0.0.1']);
});

// ──────────────────────────────── GET：索引 ────────────────────────────────

test('GET /api/plugins/market：正常索引、5 分钟缓存、refresh=1 强制刷新', async (t) => {
  const fx = await setup(t);
  const first = await fx.call('/api/plugins/market');
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.schema, 1);
  assert.equal(first.body.updatedAt, '2026-10-29T00:00:00.000Z');
  assert.equal(first.body.cached, false);
  assert.equal(first.body.plugins.length, 1);
  const plugin = first.body.plugins[0];
  assert.equal(plugin.id, 'market-demo');
  assert.equal(plugin.title, '演示插件');
  assert.deepEqual(plugin.versions[0].permissions, ['net', 'tools.define']);
  assert.deepEqual(plugin.versions[0].net, ['api.example.com']);
  assert.equal(plugin.versions[0].runtime, 'node');
  assert.equal(plugin.versions[0].url, PACKAGE_URL);
  assert.equal(fx.state.indexCalls, 1);

  const cached = await fx.call('/api/plugins/market');
  assert.equal(cached.status, 200);
  assert.equal(cached.body.cached, true);
  assert.equal(fx.state.indexCalls, 1, 'TTL 内必须命中缓存');

  const refreshed = await fx.call('/api/plugins/market?refresh=1');
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.cached, false);
  assert.equal(fx.state.indexCalls, 2);

  // 越过 5 分钟 ⇒ 下一次普通读取自己失效
  fx.clock.now = new Date(NOW.getTime() + 5 * 60 * 1000 + 1);
  const expired = await fx.call('/api/plugins/market');
  assert.equal(expired.status, 200);
  assert.equal(expired.body.cached, false);
  assert.equal(fx.state.indexCalls, 3);
});

test('GET /api/plugins/market：索引超过 2MB 被拒，原因带实际字节数', async (t) => {
  const fx = await setup(t);
  fx.state.indexText = 'x'.repeat(MARKET_LIMITS.maxIndexBytes + 1);
  const response = await fx.call('/api/plugins/market');
  assert.equal(response.status, 502, response.text);
  assert.equal(response.body.error.code, 'market-index-too-large');
  assert.match(response.body.error.message, new RegExp(String(MARKET_LIMITS.maxIndexBytes + 1)));
  assert.equal(fx.state.indexCalls, 1);
});

test('索引流越过 2MB 就取消且停止读取，不进入 arrayBuffer 兼容分支', async () => {
  const dir = tempDirSync('irmia-market-index-stream-');
  const chunk = Buffer.alloc(64 * 1024, 7);
  let reads = 0;
  let cancelled = false;
  const client = new PluginMarketClient({ dataDir: dir, plugins: { marketEnabled: true, marketIndexUrl: INDEX_URL }, fetch: async () => ({
    ok: true, status: 200,
    body: { getReader: () => ({
      read: async () => { reads += 1; return { done: false, value: chunk }; },
      cancel: async () => { cancelled = true; },
      releaseLock: () => {},
    }) },
    arrayBuffer: async () => { throw new Error('stream should be used'); },
  }) });
  const result = await client.indexView();
  assert.equal(result.status, 502);
  assert.equal((result.body as any).error.code, 'market-index-too-large');
  assert.equal(reads, MARKET_LIMITS.maxIndexBytes / chunk.length + 1);
  assert.equal(cancelled, true);
});

test('索引 Content-Length 已超限时取消响应体，零读取即拒绝', async () => {
  const dir = tempDirSync('irmia-market-index-header-');
  let cancelled = false;
  const client = new PluginMarketClient({ dataDir: dir, plugins: { marketEnabled: true, marketIndexUrl: INDEX_URL }, fetch: async () => ({
    ok: true, status: 200,
    headers: { get: () => String(MARKET_LIMITS.maxIndexBytes + 1) },
    body: {
      getReader: () => { throw new Error('oversized declared response must not be read'); },
      cancel: async () => { cancelled = true; },
    },
    arrayBuffer: async () => { throw new Error('body must not be buffered'); },
  }) });
  const result = await client.indexView();
  assert.equal(result.status, 502);
  assert.equal((result.body as any).error.code, 'market-index-too-large');
  assert.equal(cancelled, true);
});

test('真实索引无 Content-Length 时，越过 2MB 即关闭连接而非收完 6MB', async (t) => {
  const dir = tempDirSync('irmia-market-index-http-stream-');
  const total = MARKET_LIMITS.maxIndexBytes * 3;
  const chunk = Buffer.alloc(64 * 1024, 7);
  let sent = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    const timer = setInterval(() => {
      sent += chunk.length;
      response.write(chunk);
      if (sent >= total) { clearInterval(timer); response.end(); }
    }, 2);
    response.on('close', () => { clearInterval(timer); resolveClosed(); });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => resolve()); }); });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const client = new PluginMarketClient({
    dataDir: dir,
    plugins: { marketEnabled: true, marketIndexUrl: `http://127.0.0.1:${address.port}/index.json` },
    timeoutMs: 5_000,
  });
  const result = await client.indexView();
  assert.equal(result.status, 502);
  assert.equal((result.body as any).error.code, 'market-index-too-large');
  await closed;
  assert.ok(sent < total, `server sent ${sent} bytes; cancellation must precede ${total}`);
});

test('GET /api/plugins/market：取索引超时返回 504，且确实给 fetch 注入了 signal', async (t) => {
  const fx = await setup(t, { timeoutMs: 30 });
  fx.state.indexHang = true;
  const response = await fx.call('/api/plugins/market');
  assert.equal(response.status, 504, response.text);
  assert.equal(response.body.error.code, 'market-aborted');
  assert.match(response.body.error.message, /超时/u);
});

test('GET /api/plugins/market：上游非 2xx 原样说明（不改写成成功/空列表）', async (t) => {
  const fx = await setup(t);
  fx.state.indexStatus = 503;
  fx.state.indexStatusText = 'Service Unavailable';
  const response = await fx.call('/api/plugins/market');
  assert.equal(response.status, 502, response.text);
  assert.equal(response.body.error.code, 'market-download-failed');
  assert.match(response.body.error.message, /503/u);
  assert.match(response.body.error.message, /Service Unavailable/u);
});

test('GET /api/plugins/market：跨源重定向被拒；同源重定向照常跟随', async (t) => {
  const cross = await setup(t);
  cross.state.indexStatus = 302;
  cross.state.indexStatusText = 'Found';
  cross.state.indexHeaders = { location: 'https://evil.test/plugins/index.json' };
  const rejected = await cross.call('/api/plugins/market');
  assert.equal(rejected.status, 502, rejected.text);
  assert.equal(rejected.body.error.code, 'market-download-failed');
  assert.match(rejected.body.error.message, /不同源/u);
  assert.equal(cross.state.indexCalls, 1, '跨源重定向在读到响应体之前就被拒');

  const same = await setup(t);
  same.state.indexStatus = 302;
  same.state.indexStatusText = 'Found';
  same.state.indexHeaders = { location: `${INDEX_URL}?from=redirect` };
  const followed = await same.call('/api/plugins/market');
  assert.equal(followed.status, 200, followed.text);
  assert.equal(followed.body.plugins[0].id, 'market-demo');
});

test('市场关闭时 GET 返回 501 并说明原因', async (t) => {
  const fx = await setup(t, { marketEnabled: false });
  const response = await fx.call('/api/plugins/market');
  assert.equal(response.status, 501, response.text);
  assert.equal(response.body.error.code, 'market-disabled');
  assert.match(response.body.error.message, /marketEnabled/u);
  assert.equal(fx.state.indexCalls, 0, '关掉时一个请求都不发');
});

// ──────────────────────────────── GET：单插件 ────────────────────────────────

test('GET /api/plugins/market/<id>：版本列表带 permissions / net / 兼容性', async (t) => {
  const fx = await setup(t);
  const response = await fx.call('/api/plugins/market/market-demo');
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.id, 'market-demo');
  assert.equal(response.body.compatible, true);
  assert.equal(response.body.compatibleVersion, '1.0.0');
  assert.equal(response.body.versions.length, 1);
  assert.equal(response.body.versions[0].compatible, true);
  assert.equal(response.body.versions[0].compatibility, null);
  assert.deepEqual(response.body.versions[0].permissions, ['net', 'tools.define']);
  assert.deepEqual(response.body.versions[0].net, ['api.example.com']);
  assert.equal(response.body.review.basis, 'index');
  assert.deepEqual(response.body.review.permissions, ['net', 'tools.define']);
  assert.deepEqual(response.body.review.net, ['api.example.com']);
});

test('GET /api/plugins/market/<id>：不存在 → 404', async (t) => {
  const fx = await setup(t);
  const response = await fx.call('/api/plugins/market/nope');
  assert.equal(response.status, 404, response.text);
  assert.equal(response.body.error.code, 'market-plugin-not-found');
});

test('GET /api/plugins/market/<id>：engine 不兼容时逐版本说明，仍返回 200 供人看', async (t) => {
  const pair = marketPair({ release: { engine: '>=9.0.0' } });
  const fx = await setup(t, { pair });
  const response = await fx.call('/api/plugins/market/market-demo');
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.compatible, false);
  assert.equal(response.body.compatibleVersion, null);
  assert.equal(response.body.versions[0].compatible, false);
  assert.match(response.body.versions[0].compatibility, />=9\.0\.0/u);
  assert.ok(response.body.versions[0].compatibility.includes(AGENT_VERSION));
  assert.equal(response.body.selection.code, 'market-engine-incompatible');
});

// ──────────────────────────────── POST：安装 ────────────────────────────────

test('plugin-market-install：缺 X-Confirm 被拒；未登记 id 被拒且不下载包', async (t) => {
  const fx = await setup(t);
  const missing = await fx.call('/api/commands/plugin-market-install', { id: 'market-demo' });
  assert.equal(missing.status, 400, missing.text);
  assert.equal(missing.body.error.code, 'confirm-required');
  assert.match(missing.body.error.message, /plugin-market-install/u);

  const unknown = await fx.call('/api/commands/plugin-market-install', { id: 'nope' }, 'plugin-market-install');
  assert.equal(unknown.status, 404, unknown.text);
  assert.equal(unknown.body.error.code, 'market-plugin-not-found');
  assert.equal(fx.state.packageCalls, 0, '未登记 id 连包地址都不该碰');
});

test('plugin-market-install：body 里塞 url / sha256 一律拒绝（URL 与哈希只从索引取）', async (t) => {
  const fx = await setup(t);
  for (const extra of [{ url: 'https://evil.test/x.zip' }, { sha256: 'b'.repeat(64) }, { size: 1 }]) {
    const response = await fx.call(
      '/api/commands/plugin-market-install',
      { id: 'market-demo', ...extra },
      'plugin-market-install',
    );
    assert.equal(response.status, 400, response.text);
    assert.equal(response.body.error.code, 'market-request-invalid');
    assert.match(response.body.error.message, new RegExp(Object.keys(extra)[0]!));
  }
  assert.equal(fx.state.packageCalls, 0);
});

test('plugin-market-install：sha256 不匹配被拒，且包目录一个字节都不落', async (t) => {
  const pair = marketPair({ release: { sha256: 'a'.repeat(64) } });
  const fx = await setup(t, { pair });
  const response = await fx.call(
    '/api/commands/plugin-market-install',
    { id: 'market-demo' },
    'plugin-market-install',
  );
  assert.equal(response.status, 400, response.text);
  assert.equal(response.body.error.code, 'market-hash-mismatch');
  assert.match(response.body.error.message, /sha256/u);
  assert.equal(fx.state.packageCalls, 1);
  assert.equal(existsSync(join(fx.dataDir, 'plugins', 'packages')), false, '校验失败不得落包');
});

test('plugin-market-install：正常安装 → untrusted + 回执字段齐全；confirm 之前不能 enable', async (t) => {
  const fx = await setup(t);
  const response = await fx.call(
    '/api/commands/plugin-market-install',
    { id: 'market-demo' },
    'plugin-market-install',
  );
  assert.equal(response.status, 200, response.text);
  const body = response.body;
  assert.equal(body.ok, true);
  assert.match(body.contentHash, /^[a-f0-9]{64}$/u);
  assert.equal(body.plugin.state, 'untrusted');
  assert.equal(body.plugin.marketId, 'market-demo');
  assert.equal(body.plugin.marketVersion, '1.0.0');
  assert.deepEqual(body.permissions, ['net', 'tools.define']);
  assert.deepEqual(body.net, ['api.example.com']);
  assert.equal(body.runtime, 'node');
  assert.equal(body.restartRequired, false);
  assert.equal(body.market.id, 'market-demo');
  assert.equal(body.market.version, '1.0.0');
  assert.equal(body.review.basis, 'package');
  assert.equal(body.review.netMismatch, false);
  assert.deepEqual(body.review.packageNet, ['api.example.com']);
  assert.match(body.next, /plugin-confirm/u);
  assert.equal(existsSync(join(fx.dataDir, 'plugins', 'packages', 'market-demo', body.contentHash, 'plugin.json')), true);

  // 安装后仍是 untrusted：直接 enable 必须被拒（确认是另一条命令）
  const enableBefore = await fx.call(
    '/api/commands/plugin-enable',
    { id: 'market-demo', contentHash: body.contentHash },
    'plugin-enable',
  );
  assert.equal(enableBefore.status, 400, enableBefore.text);
  assert.equal(enableBefore.body.error.code, 'plugin-error');
  assert.match(enableBefore.body.error.message, /confirm/u);

  const listed = await fx.call('/api/plugins');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items[0].state, 'untrusted');
  assert.deepEqual(listed.body.items[0].permissions, ['net', 'tools.define']);
  assert.deepEqual(listed.body.items[0].net, ['api.example.com']);
  assert.equal(listed.body.items[0].runtime.type, 'node');
  assert.equal(listed.body.items[0].marketId, 'market-demo');
  assert.equal(listed.body.items[0].marketVersion, '1.0.0');

  const confirmed = await fx.call(
    '/api/commands/plugin-confirm',
    { id: 'market-demo', contentHash: body.contentHash },
    'plugin-confirm',
  );
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.equal(confirmed.body.plugin.state, 'disabled');
  const enabled = await fx.call(
    '/api/commands/plugin-enable',
    { id: 'market-demo', contentHash: body.contentHash },
    'plugin-enable',
  );
  assert.equal(enabled.status, 200, enabled.text);
  assert.equal(enabled.body.plugin.state, 'enabled');
});

test('plugin-market-install：索引 net 与包内 net.allow 不一致 → 安装仍成，但审阅里显眼标出', async (t) => {
  const pair = marketPair({
    manifest: { permissions: ['net'], net: { allow: ['other.example.com'] } },
    release: { permissions: ['net'], net: ['api.example.com'] },
  });
  const fx = await setup(t, { pair });
  const response = await fx.call(
    '/api/commands/plugin-market-install',
    { id: 'market-demo' },
    'plugin-market-install',
  );
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.plugin.state, 'untrusted');
  assert.deepEqual(response.body.net, ['other.example.com'], '执行期以包内清单为准');
  assert.deepEqual(response.body.review.indexNet, ['api.example.com']);
  assert.deepEqual(response.body.review.packageNet, ['other.example.com']);
  assert.equal(response.body.review.netMismatch, true);
  assert.equal(response.body.review.permissionsMismatch, false);
  assert.ok(response.body.review.warnings.some((line: string) => line.includes('不一致')), response.text);
  assert.ok(response.body.review.warnings.some((line: string) => line.includes('包内为准')), response.text);
});

test('市场关闭时安装命令返回 501，且不下载包', async (t) => {
  const fx = await setup(t, { marketEnabled: false });
  const response = await fx.call(
    '/api/commands/plugin-market-install',
    { id: 'market-demo' },
    'plugin-market-install',
  );
  assert.equal(response.status, 501, response.text);
  assert.equal(response.body.error.code, 'market-disabled');
  assert.equal(fx.state.packageCalls, 0);
});
