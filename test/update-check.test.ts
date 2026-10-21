/**
 * 更新检测器（`src/update/check.ts`）—— **十种服务端行为**的读数。
 *
 * 纪律（与 docs/update-check.md §4 同源）：
 *   · **一律打本地假服务器**（`127.0.0.1` 随机端口），不碰 `irmia.me`；
 *   · 每种行为断言两件事：**结论**（status/reason）与**请求本身**（只 GET 一次、URL 没有
 *     query、UA 是固定常量、没有 cookie/authorization）；
 *   · 失败（404/500/坏 JSON/字段缺失/超时/`_pending`）一律 `unknown` —— "这次没查到"，
 *     **不是错误**（本模块的契约就是永不抛）。
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';

import {
  DEFAULT_UPDATE_USER_AGENT,
  checkForUpdate,
  compareVersions,
  isNewerVersion,
  parseVersion,
  sanitizeEndpoint,
} from '../src/update/check.ts';

// ──────────────────────────────── 假服务器 ────────────────────────────────

interface Caught {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

interface FakeServer {
  /** 每次换一个随机端口；路径固定为站点那一条，便于断言 query 为空 */
  endpoint: string;
  requests: Caught[];
  close: () => Promise<void>;
}

/** 起一个只被本用例用的 HTTP 服务：handler 决定"服务端这一种行为"长什么样 */
async function startFake(
  handler: (req: { method: string; url: string }, res: import('node:http').ServerResponse) => void,
): Promise<FakeServer> {
  const requests: Caught[] = [];
  const server: Server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    handler({ method: req.method ?? '', url: req.url ?? '' }, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}/releases/latest.json`,
    requests,
    close: async () => {
      // 超时那一条会留一个悬挂连接：先掐掉，否则 close() 永远不返回
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 一份形状正确的 manifest（各用例只覆盖自己关心的那格） */
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    channel: 'beta',
    version: '0.1.0-beta.13',
    publishedAt: '2026-10-21T00:00:00.000Z',
    notesUrl: 'https://irmia.me/releases/beta/',
    minimumVersion: null,
    platforms: [
      {
        os: 'win32',
        arch: 'x64',
        kind: 'installer',
        url: 'https://irmia.me/releases/beta/irmia-0.1.0-beta.13-setup.exe',
        size: 45_000_000,
        sha256: 'a'.repeat(64),
      },
    ],
    ...overrides,
  };
}

const CURRENT = '0.1.0-beta.12';

/** 跑一次检测：打的是本地假服务器，返回结论 + 有没有多余请求 */
async function checkOnce(
  handler: Parameters<typeof startFake>[0],
  options: { channel?: 'beta' | 'stable'; currentVersion?: string; timeoutMs?: number } = {},
): Promise<{ result: Awaited<ReturnType<typeof checkForUpdate>>; server: FakeServer }> {
  const server = await startFake(handler);
  try {
    const result = await checkForUpdate({
      currentVersion: options.currentVersion ?? CURRENT,
      channel: options.channel ?? 'beta',
      endpoint: server.endpoint,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    return { result, server };
  } finally {
    await server.close();
  }
}

/**
 * 同 [checkOnce]，但**对"本机偶发连不上"重试一次**。
 *
 * 为什么只重试 `unknown/network`：全量 `npm test`（`--test-concurrency=2`）时见过两次
 * `fetch failed`（本文件的两次 + `web-server.test.ts` 的一次，都是本机回环），单跑全绿。
 * 那是负载下的一次性连接失败，不是检测器的判据——但**测试不该因此变红**：第二次仍然连不上
 * 才是真的有问题。`timeout` 不重试（那会掩盖"服务端不响应"这条用例的意图）。
 */
async function checkAgainst(
  handler: Parameters<typeof startFake>[0],
  options: { channel?: 'beta' | 'stable'; currentVersion?: string; timeoutMs?: number } = {},
): Promise<{ result: Awaited<ReturnType<typeof checkForUpdate>>; server: FakeServer }> {
  const first = await checkOnce(handler, options);
  if (first.result.status === 'unknown' && first.result.reason === 'network') {
    return await checkOnce(handler, options);
  }
  return first;
}

function json(payload: unknown): Parameters<typeof startFake>[0] {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
}

// ──────────────────────────────── ① 有新版本 ────────────────────────────────

describe('检测结论：十种服务端行为', () => {
  test('① 有新版本 ⇒ available + 下载地址/notes（只 GET 一次）', async () => {
    const { result, server } = await checkAgainst(json(manifest()));
    assert.deepEqual(
      [result.status, result.latest, result.reason],
      ['available', '0.1.0-beta.13', 'newer'],
    );
    assert.equal(
      result.downloadUrl,
      'https://irmia.me/releases/beta/irmia-0.1.0-beta.13-setup.exe',
    );
    assert.equal(result.notesUrl, 'https://irmia.me/releases/beta/');
    assert.deepEqual(result.platforms, [{
      os: 'win32', arch: 'x64', kind: 'installer',
      url: 'https://irmia.me/releases/beta/irmia-0.1.0-beta.13-setup.exe', pending: false,
    }], '平台清单原样带出去（GUI 下载入口按它分流）');
    assert.deepEqual(result.mirrors, [{ provider: 'pending' }], '站点还没给网盘 ⇒ pending');

    assert.equal(server.requests.length, 1, '一次检测只发一个请求');
    const request = server.requests[0];
    assert.ok(request !== undefined);
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/releases/latest.json', 'URL 里不许出现任何 query');
    assert.equal(request.headers['user-agent'], DEFAULT_UPDATE_USER_AGENT, 'UA 是固定常量');
    assert.equal(request.headers.cookie, undefined, '不带 cookie');
    assert.equal(request.headers.authorization, undefined, '不带任何凭据');
  });

  test('② 无更新（最新版 == 当前版）⇒ none / up-to-date', async () => {
    const { result } = await checkAgainst(json(manifest({ version: CURRENT })));
    assert.deepEqual([result.status, result.reason], ['none', 'up-to-date']);
    assert.equal(result.latest, CURRENT);
  });

  test('③ 通道不匹配（请求 beta，manifest 说 stable）⇒ none / channel-mismatch', async () => {
    const { result } = await checkAgainst(json(manifest({ channel: 'stable' })));
    assert.deepEqual([result.status, result.reason], ['none', 'channel-mismatch']);
    assert.equal(result.latest, '0.1.0-beta.13', '结论是"不算更新"，但版本号照实给');
  });

  test('④ minimumVersion 触发 required（当前低于最低可用版）', async () => {
    const { result } = await checkAgainst(json(manifest({
      version: '0.1.0-beta.14',
      minimumVersion: '0.1.0-beta.13',
    })));
    assert.deepEqual([result.status, result.reason], ['required', 'below-minimum']);
    assert.equal(result.minimumVersion, '0.1.0-beta.13');
    assert.equal(result.latest, '0.1.0-beta.14');
  });

  test('⑤ 本机对应产物 _pending ⇒ unknown / pending（这次没查到）', async () => {
    const { result } = await checkAgainst(json(manifest({
      platforms: [{
        os: 'win32',
        arch: 'x64',
        kind: 'installer',
        url: 'https://irmia.me/releases/beta/irmia-setup.exe',
        size: 1,
        sha256: 'b'.repeat(64),
        _pending: true,
      }],
    })));
    assert.deepEqual([result.status, result.reason], ['unknown', 'pending']);
    assert.equal(result.downloadUrl, undefined, '_pending 的产物不给出可点地址');
  });

  test('⑥ 404 ⇒ unknown / http-404', async () => {
    const { result } = await checkAgainst((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
    assert.deepEqual([result.status, result.reason], ['unknown', 'http-404']);
  });

  test('⑦ 500 ⇒ unknown / http-500', async () => {
    const { result } = await checkAgainst((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
    });
    assert.deepEqual([result.status, result.reason], ['unknown', 'http-500']);
  });

  test('⑧ 超时 ⇒ unknown / timeout（8 秒上限的测试版：80ms）', async () => {
    const { result } = await checkAgainst(() => {
      // 故意不响应：客户端只能等到自己的时限
    }, { timeoutMs: 80 });
    assert.deepEqual([result.status, result.reason], ['unknown', 'timeout']);
  });

  test('⑨ 坏 JSON ⇒ unknown / bad-json', async () => {
    const { result } = await checkAgainst((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"schema":1,"version":');
    });
    assert.deepEqual([result.status, result.reason], ['unknown', 'bad-json']);
  });

  test('⑩ 字段缺失（没有 version）⇒ unknown / bad-shape', async () => {
    const broken = manifest();
    delete broken['version'];
    const { result } = await checkAgainst(json(broken));
    assert.deepEqual([result.status, result.reason], ['unknown', 'bad-shape']);
  });
});

// ──────────────────────────────── 通道 / 平台 / 版本 ────────────────────────────────

describe('stable 通道与预发布', () => {
  test('stable 请求遇到 -beta.N ⇒ none / prerelease（不把 beta 当更新）', async () => {
    const { result } = await checkAgainst(
      json(manifest({ channel: 'stable', version: '0.1.0-beta.13' })),
      { channel: 'stable' },
    );
    assert.deepEqual([result.status, result.reason], ['none', 'prerelease']);
  });

  test('stable 请求遇到正式版 0.1.1 ⇒ available', async () => {
    const { result } = await checkAgainst(
      json(manifest({ channel: 'stable', version: '0.1.1' })),
      { channel: 'stable' },
    );
    assert.deepEqual([result.status, result.reason], ['available', 'newer']);
  });

  test('站点版本比当前还旧 ⇒ none / older-than-current（回滚/端点配错时不提示升级）', async () => {
    const { result } = await checkAgainst(json(manifest({ version: '0.1.0-beta.11' })));
    assert.deepEqual([result.status, result.reason], ['none', 'older-than-current']);
  });

  test('没有匹配本机平台的产物 ⇒ 仍是 available，但不给下载地址', async () => {
    const { result } = await checkAgainst(json(manifest({
      platforms: [{
        os: 'linux', arch: 'x64', kind: 'installer', url: 'https://irmia.me/linux.AppImage', size: 1, sha256: 'c'.repeat(64),
      }],
    })));
    assert.equal(result.status, 'available');
    assert.equal(result.downloadUrl, undefined);
    assert.equal(result.notesUrl, 'https://irmia.me/releases/beta/', '人还能点「查看」去发布页');
  });

  test('产物优先级 installer > portable > update', async () => {
    const { result } = await checkAgainst(json(manifest({
      platforms: [
        { os: 'windows', arch: 'amd64', kind: 'update', url: 'https://irmia.me/update.zip', size: 1, sha256: 'd'.repeat(64) },
        { os: 'win32', arch: 'x64', kind: 'portable', url: 'https://irmia.me/portable.zip', size: 1, sha256: 'e'.repeat(64) },
        { os: 'win32', arch: 'x64', kind: 'installer', url: 'https://irmia.me/setup.exe', size: 1, sha256: 'f'.repeat(64) },
      ],
    })));
    assert.equal(result.downloadUrl, 'https://irmia.me/setup.exe');
  });

  test('待上传的产物可以还没有地址：照样带出去（GUI 灰掉标「待上传」）', async () => {
    const { result } = await checkAgainst(json(manifest({
      platforms: [
        { os: 'win32', arch: 'x64', kind: 'installer', url: 'https://irmia.me/setup.exe', size: 1, sha256: 'a'.repeat(64) },
        { os: 'linux', arch: 'x64', kind: 'installer', _pending: true },
      ],
    })));
    assert.equal(result.status, 'available');
    assert.deepEqual(result.platforms?.[1], {
      os: 'linux', arch: 'x64', kind: 'installer', url: '', pending: true,
    });
  });

  test('网盘分流：baidu 带地址与提取码；quark 没有地址 ⇒ 丢掉；没给 mirrors ⇒ 一条 pending', async () => {
    const withMirrors = await checkAgainst(json(manifest({
      mirrors: [
        { provider: 'baidu', url: 'https://pan.baidu.com/s/abc', code: 'x7k2' },
        { provider: 'quark' },
        { provider: 'unknown-provider' },
      ],
    })));
    assert.deepEqual(withMirrors.result.mirrors, [
      { provider: 'baidu', url: 'https://pan.baidu.com/s/abc', code: 'x7k2' },
    ]);

    const without = await checkAgainst(json(manifest()));
    assert.deepEqual(without.result.mirrors, [{ provider: 'pending' }]);
  });
});

describe('语义化版本比较（含 -beta.N）', () => {
  test('beta.12 < beta.13（数字段按数值，不按字典序）', () => {
    assert.equal(compareVersions(parseVersion('0.1.0-beta.12')!, parseVersion('0.1.0-beta.13')!), -1);
    assert.equal(compareVersions(parseVersion('0.1.0-beta.2')!, parseVersion('0.1.0-beta.10')!), -1);
  });

  test('预发布 < 同号正式版；正式版 > 预发布', () => {
    assert.equal(compareVersions(parseVersion('0.1.0-beta.12')!, parseVersion('0.1.0')!), -1);
    assert.equal(compareVersions(parseVersion('0.1.0')!, parseVersion('0.1.0-beta.12')!), 1);
  });

  test('major/minor/patch 依次优先；beta.1 < beta.1.1（前缀短的低）', () => {
    assert.equal(compareVersions(parseVersion('0.2.0')!, parseVersion('0.1.9')!), 1);
    assert.equal(compareVersions(parseVersion('1.0.0')!, parseVersion('0.9.9')!), 1);
    assert.equal(compareVersions(parseVersion('0.1.0-beta.1')!, parseVersion('0.1.0-beta.1.1')!), -1);
  });

  test('解析只认 X.Y.Z：`0.2` 不被猜成 0.2.0', () => {
    assert.equal(parseVersion('0.2'), null);
    assert.equal(parseVersion('v0.1.0-beta.12')?.minor, 1, '允许前缀 v');
    assert.equal(isNewerVersion('0.1.0-beta.13', CURRENT), true);
    assert.equal(isNewerVersion(CURRENT, CURRENT), false);
    assert.equal(isNewerVersion('not-a-version', CURRENT), false, '解析不了 ⇒ 不声称有更新');
  });

  test('坏形状不进判定：URL 不合法 ⇒ unknown / bad-endpoint', async () => {
    const result = await checkForUpdate({
      currentVersion: CURRENT,
      channel: 'beta',
      endpoint: 'not a url',
    });
    assert.deepEqual([result.status, result.reason], ['unknown', 'bad-endpoint']);
  });
});

describe('隐私边界：端点脱敏与固定 UA', () => {
  test('sanitizeEndpoint 只留 protocol//host/path（query/fragment/userinfo 全丢）', () => {
    assert.equal(
      sanitizeEndpoint('https://user:pass@example.com/releases/latest.json?token=secret#frag'),
      'https://example.com/releases/latest.json',
    );
    assert.equal(sanitizeEndpoint('https://example.com'), 'https://example.com/');
    assert.equal(sanitizeEndpoint('not a url'), '');
  });

  test('固定 UA 里没有任何机器/人/实例标识', () => {
    assert.equal(DEFAULT_UPDATE_USER_AGENT, 'IrmiaAgentUpdateCheck/1');
    assert.equal(/[0-9a-f]{8,}/u.test(DEFAULT_UPDATE_USER_AGENT), false);
  });

  test('status 只有四种取值（没有"error"这条路）', async () => {
    const seen: unknown[] = [];
    const available = await checkAgainst(json(manifest()));
    const none = await checkAgainst(json(manifest({ version: CURRENT })));
    const required = await checkAgainst(json(manifest({ minimumVersion: '9.0.0' })));
    const unknown = await checkAgainst((_req, res) => {
      res.writeHead(502);
      res.end('bad gateway');
    });
    seen.push(available.result.status, none.result.status, required.result.status, unknown.result.status);
    assert.deepEqual(seen, ['available', 'none', 'required', 'unknown']);
  });
});
