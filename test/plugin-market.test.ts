/**
 * 插件市场客户端（P1c 预留口子）· 纯逻辑测试
 *
 * 纪律：**不联网、不写仓库内文件**。所有下载都由假 fetch 提供，临时目录全部走
 * `os.tmpdir()` 下的 `tempDirSync`（进程退出时清理）。包用内存里现造的 zip
 * （store 与 deflate 两种），不依赖任何 zip 库。
 *
 * 独立可跑：`node --test --experimental-strip-types test/plugin-market.test.ts`
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { describe } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  MARKET_ERROR_CODES,
  MARKET_LIMITS,
  MarketError,
  parseMarketIndex,
  selectRelease,
  verifyAndInstall,
  type MarketFetch,
  type MarketInstallDeps,
} from '../src/plugin/market.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const ENGINE = '>=0.1.0-beta.13';
const SHA_A = 'a'.repeat(64);

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = Buffer.from(bytes);
  return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer;
}

/** 假 fetch：返回给定字节；可记录调用、可指定 HTTP 状态 */
function fakeFetch(body: Uint8Array, options: { status?: number; calls?: string[] } = {}): MarketFetch {
  const status = options.status ?? 200;
  return async (url) => {
    options.calls?.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'ERR',
      arrayBuffer: async () => toArrayBuffer(body),
    };
  };
}

// ──────────────────────────────── 内存 zip 构造 ────────────────────────────────

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

/** 造一个最小 zip（不带 CRC：市场客户端按整包 sha256 校验，不读 CRC） */
function buildZip(entries: readonly ZipEntry[], options: { deflate?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflate = options.deflate === true;
    const payload = deflate ? deflateRawSync(entry.data) : entry.data;
    const method = deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localRecord = Buffer.concat([local, name, payload]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));

    locals.push(localRecord);
    offset += localRecord.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

/** 一个能被安装器接受的最小 v2 包（plugin.json + 入口） */
function packageEntries(manifestPatch: Record<string, unknown> = {}): ZipEntry[] {
  const manifest = {
    apiVersion: 2,
    id: 'market-demo',
    version: '1.0.0',
    engine: { irmia: ENGINE },
    runtime: { type: 'node', entry: 'main.mjs' },
    permissions: ['tools.define'],
    meta: { title: '市场测试插件', desc: 'plugin-market.test.ts 用' },
    ...manifestPatch,
  };
  return [
    { name: 'plugin.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { name: 'main.mjs', data: Buffer.from('export async function activate(ctx) { ctx.log.info("market-demo"); }\n', 'utf8') },
  ];
}

function makeDeps(root: string, body: Uint8Array, patch: Partial<MarketInstallDeps> = {}): MarketInstallDeps {
  const tempDir = join(root, 'market-tmp');
  mkdirSync(tempDir, { recursive: true });
  return { dataDir: join(root, 'data'), fetch: fakeFetch(body), tempDir, ...patch };
}

// ──────────────────────────────── 索引 ────────────────────────────────

function releaseJson(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.0.0',
    apiVersion: 2,
    engine: ENGINE,
    url: 'https://market.invalid/market-demo-1.0.0.zip',
    sha256: SHA_A,
    size: 1024,
    permissions: ['tools.define'],
    runtime: 'node',
    signature: null,
    ...patch,
  };
}

function entryJson(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'market-demo',
    latest: '1.0.0',
    title: '演示插件',
    author: 'tests',
    desc: '市场客户端测试',
    versions: [releaseJson()],
    ...patch,
  };
}

function indexJson(plugins: readonly unknown[]): string {
  return JSON.stringify({ schema: 1, updatedAt: '2026-10-29T00:00:00.000Z', plugins });
}

describe('parseMarketIndex', () => {
  test('合法索引：字段原样读出，签名只是预留（null）', () => {
    const parsed = parseMarketIndex(indexJson([entryJson()]));
    assert.deepEqual(parsed.problems, []);
    assert.equal(parsed.index.schema, 1);
    assert.equal(parsed.index.updatedAt, '2026-10-29T00:00:00.000Z');
    const plugin = parsed.index.plugins[0]!;
    assert.equal(plugin.id, 'market-demo');
    assert.equal(plugin.latest, '1.0.0');
    assert.equal(plugin.title, '演示插件');
    const release = plugin.versions[0]!;
    assert.equal(release.version, '1.0.0');
    assert.equal(release.apiVersion, 2);
    assert.equal(release.engine, ENGINE);
    assert.equal(release.runtime, 'node');
    assert.equal(release.size, 1024);
    assert.equal(release.sha256, SHA_A);
    assert.equal(release.signature, null);
    assert.deepEqual([...release.permissions], ['tools.define']);
  });

  test('sha256 大写按小写归一；签名非空时原样带着（当前不验证）', () => {
    const parsed = parseMarketIndex(indexJson([
      entryJson({ versions: [releaseJson({ sha256: SHA_A.toUpperCase(), signature: 'not-verified-yet' })] }),
    ]));
    const release = parsed.index.plugins[0]!.versions[0]!;
    assert.equal(release.sha256, SHA_A);
    assert.equal(release.signature, 'not-verified-yet');
  });

  test('坏条目逐条报错，合法条目与合法版本照常保留', () => {
    const plugins = [
      entryJson(),
      entryJson({ id: 'Bad_ID' }),
      entryJson({
        id: 'bad-fields',
        versions: [releaseJson({
          version: '1.0',
          apiVersion: 3,
          engine: 'latest',
          url: 'ftp://market.invalid/x.zip',
          sha256: 'xyz',
          size: 0,
          permissions: ['shell'],
          runtime: 'ruby',
        })],
      }),
      entryJson({ id: 'half-good', versions: [releaseJson(), releaseJson({ version: '1.1.0', sha256: 'not-a-hash' })] }),
      entryJson({ id: 'market-demo' }),
      { ...entryJson({ id: 'unknown-field' }), extra: true },
    ];
    const parsed = parseMarketIndex(indexJson(plugins));
    const paths = parsed.problems.map((problem) => problem.path);
    assert.ok(paths.includes('plugins[1].id'), '非法 id 要定位到字段');
    for (const field of ['version', 'apiVersion', 'engine', 'url', 'sha256', 'size', 'runtime']) {
      assert.ok(paths.includes(`plugins[2].versions[0].${field}`), `缺 ${field} 的逐条报错`);
    }
    assert.ok(paths.some((path) => path.startsWith('plugins[2].versions[0].permissions')));
    assert.ok(paths.includes('plugins[3].versions[1].sha256'), '坏版本只丢自己，不丢整个插件');
    assert.ok(paths.includes('plugins[4].id'), '重复 id 要报');
    assert.ok(paths.includes('plugins[5].extra'), '未知字段要报');
    assert.ok(parsed.problems.every((problem) => problem.code === MARKET_ERROR_CODES.entryInvalid));
    assert.deepEqual(parsed.index.plugins.map((plugin) => plugin.id), ['market-demo', 'half-good']);
    assert.equal(parsed.index.plugins[1]!.versions.length, 1);
  });

  test('latest 指向不存在的版本：报问题但插件仍可用（回退到最高兼容版本）', () => {
    const parsed = parseMarketIndex(indexJson([entryJson({ latest: '9.9.9' })]));
    assert.ok(parsed.problems.some((problem) => problem.path === 'plugins[0].latest'));
    assert.equal(parsed.index.plugins[0]!.latest, undefined);
    assert.equal(parsed.index.plugins[0]!.versions.length, 1);
  });

  test('整份索引不可用才抛：非 JSON / schema 不是 1 / 未知字段 / plugins 不是数组', () => {
    for (const raw of [
      'not json',
      JSON.stringify({ schema: 2, plugins: [] }),
      JSON.stringify({ schema: 1 }),
      JSON.stringify({ schema: 1, plugins: [], extra: true }),
    ]) {
      assert.throws(
        () => parseMarketIndex(raw),
        (error: unknown) => error instanceof MarketError && error.code === MARKET_ERROR_CODES.indexInvalid,
      );
    }
  });

  test('索引超过 2MB：拒绝且错误信息带实际大小', () => {
    const oversized = 'x'.repeat(MARKET_LIMITS.maxIndexBytes + 1);
    assert.throws(
      () => parseMarketIndex(oversized),
      (error: unknown) => error instanceof MarketError
        && error.code === MARKET_ERROR_CODES.indexTooLarge
        && error.message.includes(String(oversized.length)),
    );
  });

  test('索引里声明超过 8MB 的包：该版本被逐条拒收，信息带实际大小', () => {
    const tooBig = MARKET_LIMITS.maxPackageBytes + 1;
    const parsed = parseMarketIndex(indexJson([entryJson({ versions: [releaseJson({ size: tooBig })] })]));
    const problem = parsed.problems.find((item) => item.path === 'plugins[0].versions[0].size');
    assert.ok(problem !== undefined);
    assert.ok(problem.message.includes(String(tooBig)));
    assert.equal(parsed.index.plugins.length, 0);
  });
});

// ──────────────────────────────── 版本选择 ────────────────────────────────

function selectionIndex(): string {
  return indexJson([
    entryJson({
      latest: '2.0.0-beta.1',
      versions: [
        releaseJson({ version: '1.0.0', engine: '>=0.1.0-beta.10' }),
        releaseJson({ version: '1.1.0', engine: '>=0.1.0-beta.13' }),
        releaseJson({ version: '2.0.0-beta.1', engine: '>=0.1.0-beta.20' }),
      ],
    }),
  ]);
}

describe('selectRelease', () => {
  test('指定版本：命中就返回那一条', () => {
    const parsed = parseMarketIndex(selectionIndex());
    const result = selectRelease(parsed.index, 'market-demo', { version: '1.0.0', engine: '0.1.0-beta.13' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.release.version, '1.0.0');
    assert.deepEqual(result.skipped, []);
  });

  test('不指定版本：优先 latest；latest 的 engine 不兼容时跳到最高的兼容版本并如实列出被跳过的', () => {
    const parsed = parseMarketIndex(selectionIndex());
    const result = selectRelease(parsed.index, 'market-demo', { engine: '0.1.0-beta.13' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.release.version, '1.1.0', '2.0.0-beta.1 需要 >=0.1.0-beta.20，应被跳过');
    assert.deepEqual(result.skipped.map((release) => release.version), ['2.0.0-beta.1']);
  });

  test('latest 字段优先于"最高版本"', () => {
    const parsed = parseMarketIndex(indexJson([entryJson({ latest: '1.0.0', versions: [releaseJson({ version: '1.0.0' }), releaseJson({ version: '1.1.0' })] })]));
    const result = selectRelease(parsed.index, 'market-demo');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.release.version, '1.0.0');
  });

  test('没有 latest 时按 SemVer 取最高（prerelease 低于同核心版本）', () => {
    const parsed = parseMarketIndex(indexJson([entryJson({
      latest: undefined,
      versions: [
        releaseJson({ version: '1.0.0-beta.1' }),
        releaseJson({ version: '1.0.0' }),
        releaseJson({ version: '0.9.0' }),
      ],
    })]));
    const result = selectRelease(parsed.index, 'market-demo');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.release.version, '1.0.0');
  });

  test('engine 不兼容：结构化失败，原因里同时有要求与当前版本', () => {
    const parsed = parseMarketIndex(selectionIndex());
    const result = selectRelease(parsed.index, 'market-demo', { version: '2.0.0-beta.1', engine: '0.1.0-beta.13' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, MARKET_ERROR_CODES.engineIncompatible);
    assert.match(result.message, />=0\.1\.0-beta\.20/);
    assert.match(result.message, /0\.1\.0-beta\.13/);
    assert.equal(result.plugin?.id, 'market-demo');
  });

  test('全部版本都不兼容：失败里逐个点名', () => {
    const parsed = parseMarketIndex(selectionIndex());
    const result = selectRelease(parsed.index, 'market-demo', { engine: '0.1.0-beta.1' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, MARKET_ERROR_CODES.engineIncompatible);
    assert.match(result.message, /1\.0\.0 需要 >=0\.1\.0-beta\.10/);
    assert.match(result.message, /1\.1\.0 需要 >=0\.1\.0-beta\.13/);
  });

  test('插件 / 版本不存在：返回结构化结果而不是抛', () => {
    const parsed = parseMarketIndex(selectionIndex());
    const missingPlugin = selectRelease(parsed.index, 'nope');
    assert.equal(missingPlugin.ok, false);
    if (!missingPlugin.ok) assert.equal(missingPlugin.code, MARKET_ERROR_CODES.pluginNotFound);

    const missingVersion = selectRelease(parsed.index, 'market-demo', { version: '3.0.0' });
    assert.equal(missingVersion.ok, false);
    if (!missingVersion.ok) {
      assert.equal(missingVersion.code, MARKET_ERROR_CODES.versionNotFound);
      assert.match(missingVersion.message, /1\.0\.0/);
    }
  });

  test('当前宿主版本不是合法 SemVer：报 invalidEngine', () => {
    const parsed = parseMarketIndex(selectionIndex());
    const result = selectRelease(parsed.index, 'market-demo', { version: '1.0.0', engine: 'latest' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, MARKET_ERROR_CODES.invalidEngine);
  });
});

// ──────────────────────────────── 下载 + 安装 ────────────────────────────────

describe('verifyAndInstall', () => {
  test('响应流超过 8MB 时立即取消；不调用 arrayBuffer，也不读后续块', async () => {
    const root = tempDirSync('irmia-market-stream-limit-');
    let reads = 0;
    let cancelled = false;
    let released = false;
    const chunk = Buffer.alloc(64 * 1024, 7);
    const deps = makeDeps(root, Buffer.alloc(0), { fetch: async () => ({
      ok: true, status: 200,
      body: { getReader: () => ({
        read: async () => { reads += 1; return { done: false, value: chunk }; },
        cancel: async () => { cancelled = true; },
        releaseLock: () => { released = true; },
      }) },
      arrayBuffer: async () => { throw new Error('streaming responses must not use arrayBuffer'); },
    }) });
    await assert.rejects(verifyAndInstall(deps, {
      url: 'https://market.invalid/stream.zip', sha256: SHA_A, size: 1,
    }), (error: unknown) => error instanceof MarketError && error.code === MARKET_ERROR_CODES.packageTooLarge);
    assert.equal(reads, MARKET_LIMITS.maxPackageBytes / chunk.length + 1);
    assert.equal(cancelled, true);
    assert.equal(released, true);
    assert.deepEqual(readdirSync(deps.tempDir), []);
    assert.equal(existsSync(join(deps.dataDir, 'plugins', 'packages')), false);
  });

  test('真实下载越过限额会关闭连接，服务器不会发完整个有限大响应', async (t) => {
    const root = tempDirSync('irmia-market-stream-http-');
    const total = MARKET_LIMITS.maxPackageBytes * 3;
    const chunk = Buffer.alloc(64 * 1024, 7);
    let sent = 0;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
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
    const deps = makeDeps(root, Buffer.alloc(0), { fetch: globalThis.fetch, timeoutMs: 5_000 });
    await assert.rejects(verifyAndInstall(deps, {
      url: `http://127.0.0.1:${address.port}/large`, sha256: SHA_A, size: 1,
    }), (error: unknown) => error instanceof MarketError && error.code === MARKET_ERROR_CODES.packageTooLarge);
    await closed;
    assert.ok(sent < total, `server sent ${sent} bytes; cancellation must precede ${total}`);
    assert.deepEqual(readdirSync(deps.tempDir), []);
    assert.equal(existsSync(join(deps.dataDir, 'plugins', 'packages')), false);
  });

  test('流式正常包保留大小与哈希校验，读完释放 reader', async () => {
    const root = tempDirSync('irmia-market-stream-ok-');
    const bytes = buildZip(packageEntries());
    let reads = 0;
    let released = false;
    const deps = makeDeps(root, bytes, { fetch: async () => ({
      ok: true, status: 200,
      body: { getReader: () => ({
        read: async () => ++reads === 1 ? { done: false, value: bytes } : { done: true },
        cancel: async () => {},
        releaseLock: () => { released = true; },
      }) },
      arrayBuffer: async () => { throw new Error('stream should be used'); },
    }) });
    const installed = await verifyAndInstall(deps, {
      url: 'https://market.invalid/ok.zip', sha256: sha256(bytes), size: bytes.length,
    });
    assert.equal(installed.manifest.id, 'market-demo');
    assert.equal(released, true);
    assert.deepEqual(readdirSync(deps.tempDir), []);
  });

  test('取消信号会中止不响应的 reader 并释放临时目录', async () => {
    const root = tempDirSync('irmia-market-stream-abort-');
    const controller = new AbortController();
    let cancelled = false;
    const deps = makeDeps(root, Buffer.alloc(0), { fetch: async () => ({
      ok: true, status: 200,
      body: { getReader: () => ({
        read: async () => await new Promise<never>(() => {}),
        cancel: async () => { cancelled = true; },
        releaseLock: () => {},
      }) },
      arrayBuffer: async () => { throw new Error('stream should be used'); },
    }) });
    const timer = setTimeout(() => { controller.abort(); }, 20);
    try {
      await assert.rejects(verifyAndInstall(deps, {
        url: 'https://market.invalid/slow.zip', sha256: SHA_A, size: 1, signal: controller.signal,
      }), (error: unknown) => error instanceof MarketError && error.code === MARKET_ERROR_CODES.aborted);
    } finally { clearTimeout(timer); }
    assert.equal(cancelled, true);
    assert.deepEqual(readdirSync(deps.tempDir), []);
  });

  test('ZIP 大小写别名、保留名和文件/目录冲突全部拒绝，失败不留包', async () => {
    const cases: ZipEntry[][] = [
      [{ name: 'MAIN.MJS', data: Buffer.from('replacement') }],
      [{ name: 'Assets/a.txt', data: Buffer.from('a') }, { name: 'assets/b.txt', data: Buffer.from('b') }],
      [{ name: 'x', data: Buffer.from('file') }, { name: 'x/child.txt', data: Buffer.from('child') }],
      [{ name: 'x/child.txt', data: Buffer.from('child') }, { name: 'x', data: Buffer.from('file') }],
      [{ name: 'con.txt', data: Buffer.from('device') }],
      [{ name: 'dir/LPT1', data: Buffer.from('device') }],
      [{ name: 'con .txt', data: Buffer.from('device') }],
      [{ name: 'main.mjs.', data: Buffer.from('alias') }],
      [{ name: 'main.mjs ', data: Buffer.from('alias') }],
      [{ name: 'dir/.. /child.txt', data: Buffer.from('alias') }],
      [{ name: 'bad?.txt', data: Buffer.from('invalid') }],
      [{ name: 'é.txt', data: Buffer.from('nfc') }, { name: 'e\u0301.txt', data: Buffer.from('nfd') }],
    ];
    for (const entries of cases) {
      const root = tempDirSync('irmia-market-portable-paths-');
      const bytes = buildZip([...packageEntries(), ...entries]);
      const deps = makeDeps(root, bytes);
      await assert.rejects(verifyAndInstall(deps, {
        url: 'https://market.invalid/paths.zip', sha256: sha256(bytes), size: bytes.length,
      }), (error: unknown) => error instanceof MarketError && error.code === MARKET_ERROR_CODES.archiveInvalid,
      entries.map((entry) => entry.name).join(' / '));
      assert.deepEqual(readdirSync(deps.tempDir), []);
      assert.equal(existsSync(join(deps.dataDir, 'plugins', 'packages')), false);
    }
  });

  test('ZIP 先出现目录内文件，再出现同名显式目录时可正常安装', async () => {
    const root = tempDirSync('irmia-market-explicit-directory-');
    const bytes = buildZip([...packageEntries(),
      { name: 'assets/a.txt', data: Buffer.from('asset') },
      { name: 'assets/', data: Buffer.alloc(0) },
    ]);
    const installed = await verifyAndInstall(makeDeps(root, bytes), {
      url: 'https://market.invalid/paths.zip', sha256: sha256(bytes), size: bytes.length,
    });
    assert.equal(readFileSync(join(installed.rootDir, 'assets', 'a.txt'), 'utf8'), 'asset');
  });

  test('正常安装：校长度与 sha256 → 落到 plugins/packages/<id>/<hash>/，临时目录清空', async () => {
    const root = tempDirSync('irmia-market-install-');
    const bytes = buildZip(packageEntries());
    const deps = makeDeps(root, bytes);
    const result = await verifyAndInstall(deps, {
      id: 'market-demo',
      version: '1.0.0',
      url: 'https://market.invalid/market-demo-1.0.0.zip',
      sha256: sha256(bytes),
      size: bytes.length,
    });
    assert.equal(result.manifest.id, 'market-demo');
    assert.equal(result.manifest.version, '1.0.0');
    assert.equal(result.rootDir, join(deps.dataDir, 'plugins', 'packages', 'market-demo', result.contentHash));
    assert.match(result.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(existsSync(join(result.rootDir, 'plugin.json')), true);
    assert.equal(existsSync(join(result.rootDir, 'main.mjs')), true);
    assert.match(readFileSync(join(result.rootDir, 'main.mjs'), 'utf8'), /activate/);
    assert.deepEqual(readdirSync(deps.tempDir), [], '成功路径也不能留下临时目录');
  });

  test('deflate 压缩的 zip 同样能装（覆盖 inflate 分支）', async () => {
    const root = tempDirSync('irmia-market-deflate-');
    const bytes = buildZip(packageEntries(), { deflate: true });
    const deps = makeDeps(root, bytes);
    const result = await verifyAndInstall(deps, {
      url: 'https://market.invalid/market-demo-1.0.0.zip',
      sha256: sha256(bytes),
      size: bytes.length,
    });
    assert.equal(result.manifest.id, 'market-demo');
  });

  test('sha256 不匹配：拒绝，临时目录清理干净，插件包目录一个字节都不多', async () => {
    const root = tempDirSync('irmia-market-hash-');
    const bytes = buildZip(packageEntries());
    const deps = makeDeps(root, bytes);
    await assert.rejects(
      verifyAndInstall(deps, { url: 'https://market.invalid/x.zip', sha256: SHA_A, size: bytes.length }),
      (error: unknown) => error instanceof MarketError
        && error.code === MARKET_ERROR_CODES.hashMismatch
        && /sha256/i.test(error.message),
    );
    assert.deepEqual(readdirSync(deps.tempDir), []);
    assert.equal(existsSync(join(deps.dataDir, 'plugins', 'packages')), false);
  });

  test('size 不匹配：拒绝且信息带声明值与实际值', async () => {
    const root = tempDirSync('irmia-market-size-');
    const bytes = buildZip(packageEntries());
    const deps = makeDeps(root, bytes);
    await assert.rejects(
      verifyAndInstall(deps, { url: 'https://market.invalid/x.zip', sha256: sha256(bytes), size: bytes.length + 1 }),
      (error: unknown) => error instanceof MarketError
        && error.code === MARKET_ERROR_CODES.sizeMismatch
        && error.message.includes(String(bytes.length + 1))
        && error.message.includes(String(bytes.length)),
    );
    assert.deepEqual(readdirSync(deps.tempDir), []);
    assert.equal(existsSync(join(deps.dataDir, 'plugins', 'packages')), false);
  });

  test('实际下载超过 8MB：拒绝，信息带实际大小', async () => {
    const root = tempDirSync('irmia-market-too-large-');
    // 索引声明 8MB（合法），服务器却多吐 1 字节：按**实际**字节数拒。
    const oversized = Buffer.alloc(MARKET_LIMITS.maxPackageBytes + 1, 7);
    const deps = makeDeps(root, oversized);
    await assert.rejects(
      verifyAndInstall(deps, {
        url: 'https://market.invalid/x.zip',
        sha256: SHA_A,
        size: MARKET_LIMITS.maxPackageBytes,
      }),
      (error: unknown) => error instanceof MarketError
        && error.code === MARKET_ERROR_CODES.packageTooLarge
        && error.message.includes(String(oversized.length)),
    );
    assert.deepEqual(readdirSync(deps.tempDir), []);
  });

  test('索引声明超过 8MB：还没下载就拒绝（fetch 不会被调用）', async () => {
    const root = tempDirSync('irmia-market-declared-large-');
    const calls: string[] = [];
    const deps = makeDeps(root, Buffer.from('never fetched'), { fetch: fakeFetch(Buffer.from('x'), { calls }) });
    await assert.rejects(
      verifyAndInstall(deps, {
        url: 'https://market.invalid/x.zip',
        sha256: SHA_A,
        size: MARKET_LIMITS.maxPackageBytes + 1,
      }),
      (error: unknown) => error instanceof MarketError
        && error.code === MARKET_ERROR_CODES.packageTooLarge
        && error.message.includes(String(MARKET_LIMITS.maxPackageBytes + 1)),
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(readdirSync(deps.tempDir), []);
  });

  test('HTTP 非 2xx：报下载失败', async () => {
    const root = tempDirSync('irmia-market-http-');
    const bytes = buildZip(packageEntries());
    const deps = makeDeps(root, bytes, { fetch: fakeFetch(bytes, { status: 503 }) });
    await assert.rejects(
      verifyAndInstall(deps, { url: 'https://market.invalid/x.zip', sha256: sha256(bytes), size: bytes.length }),
      (error: unknown) => error instanceof MarketError
        && error.code === MARKET_ERROR_CODES.downloadFailed
        && error.message.includes('503'),
    );
  });

  test('下载被取消 / 超时：报 aborted，且超时信号确实注入给了 fetch', async () => {
    const root = tempDirSync('irmia-market-abort-');
    let seenSignal: AbortSignal | undefined;
    const deps = makeDeps(root, Buffer.alloc(0), {
      timeoutMs: 50,
      fetch: async (_url, init) => {
        seenSignal = init.signal;
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
    });
    await assert.rejects(
      verifyAndInstall(deps, { url: 'https://market.invalid/x.zip', sha256: SHA_A, size: 16 }),
      (error: unknown) => error instanceof MarketError && error.code === MARKET_ERROR_CODES.aborted,
    );
    assert.ok(seenSignal instanceof AbortSignal, 'timeoutMs 应该变成 fetch 的 signal');
    assert.deepEqual(readdirSync(deps.tempDir), []);
  });

  test('包里的 id / version 与索引条目对不上：拒绝（即使包本身合法）', async () => {
    const root = tempDirSync('irmia-market-mismatch-');
    const bytes = buildZip(packageEntries());
    const deps = makeDeps(root, bytes);
    await assert.rejects(
      verifyAndInstall(deps, {
        id: 'other-plugin',
        url: 'https://market.invalid/x.zip',
        sha256: sha256(bytes),
        size: bytes.length,
      }),
      (error: unknown) => error instanceof MarketError && error.code === MARKET_ERROR_CODES.packageMismatch,
    );
    assert.deepEqual(readdirSync(deps.tempDir), []);
    assert.equal(existsSync(join(deps.dataDir, 'plugins', 'packages')), false);
  });

  test('包根没有 plugin.json：报 archive 错误，不落盘', async () => {
    const root = tempDirSync('irmia-market-no-manifest-');
    const bytes = buildZip([{ name: 'main.mjs', data: Buffer.from('export const x = 1;\n') }]);
    const deps = makeDeps(root, bytes);
    await assert.rejects(
      verifyAndInstall(deps, { url: 'https://market.invalid/x.zip', sha256: sha256(bytes), size: bytes.length }),
      (error: unknown) => error instanceof MarketError
        && error.code === MARKET_ERROR_CODES.archiveInvalid
        && /plugin\.json/.test(error.message),
    );
    assert.deepEqual(readdirSync(deps.tempDir), []);
    assert.equal(existsSync(join(deps.dataDir, 'plugins', 'packages')), false);
  });

  test('zip 里的路径逃逸（../evil）：拒绝且不写目标目录之外', async () => {
    const root = tempDirSync('irmia-market-traversal-');
    const bytes = buildZip([
      ...packageEntries(),
      { name: '../evil.txt', data: Buffer.from('escaped') },
    ]);
    const deps = makeDeps(root, bytes);
    await assert.rejects(
      verifyAndInstall(deps, { url: 'https://market.invalid/x.zip', sha256: sha256(bytes), size: bytes.length }),
      (error: unknown) => error instanceof MarketError && error.code === MARKET_ERROR_CODES.archiveInvalid,
    );
    assert.equal(existsSync(join(root, 'evil.txt')), false);
    assert.deepEqual(readdirSync(deps.tempDir), []);
  });

  test('package-store 拒绝的包（清单不合法）→ install-failed，临时目录仍清空', async () => {
    const root = tempDirSync('irmia-market-bad-manifest-');
    const bytes = buildZip(packageEntries({ permissions: ['shell'] }));
    const deps = makeDeps(root, bytes);
    await assert.rejects(
      verifyAndInstall(deps, { url: 'https://market.invalid/x.zip', sha256: sha256(bytes), size: bytes.length }),
      (error: unknown) => error instanceof MarketError && error.code === MARKET_ERROR_CODES.installFailed,
    );
    assert.deepEqual(readdirSync(deps.tempDir), []);
    assert.equal(existsSync(join(deps.dataDir, 'plugins', 'packages')), false);
  });
});
