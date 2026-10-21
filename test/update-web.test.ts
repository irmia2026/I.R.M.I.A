/**
 * 对外出口：`GET /api/update` 与 `POST /api/update/check`（`src/web/server.ts`）。
 *
 * 这份用例钉住的是**界面看到的那份数据**（不是检测器本身，那个在 update-check.test.ts）：
 *   · 认证闸照旧（没有 Bearer ⇒ 401）；
 *   · GET 返回状态、上次检查时间、下次允许时间（`docs/update-check.md` §3 的样例）；
 *   · POST 是**手动检查**（无视节流），方法不对 ⇒ 405；
 *   · 没注入 UpdateService ⇒ 501（不返回一份"看起来正常"的空状态）。
 *
 * 检测打的是 `127.0.0.1` 随机端口的假服务器，不碰真站。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { emptyProjection } from '../src/log/types.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { AuthStore } from '../src/web/auth.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';
import { UpdateService } from '../src/update/service.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const PASSWORD = 'test-password-0123456789';

interface Fixture {
  dataDir: string;
  configPath: string;
  server: WebServer;
  base: string;
  token: string;
  update: UpdateService;
  requests: () => number;
  sha256: (path: string) => string;
  close: () => Promise<void>;
}

/** 起一台本地假站点（只回答 latest.json） */
async function fakeSite(): Promise<{ endpoint: string; requests: () => number; close: () => Promise<void> }> {
  let count = 0;
  const server = createServer((_req, res) => {
    count += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      schema: 1,
      channel: 'beta',
      version: '0.1.0-beta.13',
      notesUrl: 'https://irmia.me/releases/beta/',
      minimumVersion: null,
      platforms: [{
        os: 'win32', arch: 'x64', kind: 'installer',
        url: 'https://irmia.me/releases/beta/setup.exe', size: 1, sha256: 'a'.repeat(64),
      }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}/releases/latest.json`,
    requests: () => count,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function setup(t: TestContext, options: { withUpdate: boolean } = { withUpdate: true }): Promise<Fixture> {
  const dir = tempDirSync('irmia-update-web-');
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const log = await EventLog.open(join(dataDir, 'events'));
  const now = (): Date => new Date('2026-10-22T00:00:00.000Z');
  const config = defaultConfig(dir);
  const timers = new TimerStore(join(dataDir, 'timers.json'), { now });

  const auth = new AuthStore({ dataDir, now, out: () => {} });
  const issued = await auth.setup(PASSWORD);
  assert.equal(issued.ok, true);
  if (!issued.ok) throw new Error('夹具设密码失败');

  // 真实形状的 config.json（带 `$comment`：切通道必须保住注释，其余键逐字不变）
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, `${JSON.stringify({
    $comment: ['手写注释：切通道必须保住它'],
    schemaVersion: 1,
    budget: { softRatio: 0.8 },
    update: { channel: 'beta' },
  }, null, 2)}\n`, 'utf8');
  const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

  const site = await fakeSite();
  const update = new UpdateService({
    dataDir,
    currentVersion: '0.1.0-beta.12',
    enabled: true,
    channel: 'beta',
    endpoint: site.endpoint,
    now,
    emit: () => {},
    out: () => {},
  });

  const server = await startWebServer({
    log,
    projection: emptyProjection(),
    config,
    personaRoot: join(dataDir, 'persona'),
    dataDir,
    timers,
    now,
    auth,
    uiToken: null,
    port: 0,
    ssePollMs: 20,
    out: () => {},
    configPath,
    ...(options.withUpdate ? { update } : {}),
  });

  const close = async (): Promise<void> => {
    await server.close();
    await site.close();
    log.close();
  };
  t.after(close);

  return {
    dataDir,
    configPath,
    server,
    base: server.url(),
    token: issued.token,
    update,
    requests: site.requests,
    sha256,
    close,
  };
}

interface Res {
  status: number;
  body: unknown;
}

async function call(base: string, path: string, init: RequestInit = {}, token?: string): Promise<Res> {
  const headers = new Headers(init.headers);
  if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    // 非 JSON 保持原文
  }
  return { status: res.status, body };
}

test('GET /api/update：没查过也给一份可显示的现状（status unknown / never-checked）', async (t) => {
  const fx = await setup(t);
  const res = await call(fx.base, '/api/update', {}, fx.token);
  assert.equal(res.status, 200);
  const view = res.body as Record<string, unknown>;
  assert.equal(view['enabled'], true);
  assert.equal(view['channel'], 'beta');
  assert.equal(view['currentVersion'], '0.1.0-beta.12');
  assert.equal(view['status'], 'unknown');
  assert.equal(view['reason'], 'never-checked');
  assert.equal(view['checkedAt'], null);
  assert.equal(view['nextAllowedAt'], null);
  assert.equal(view['intervalHours'], 12);
  assert.equal(view['dismissible'], true);
  assert.equal(view['endpoint'], fx.update.view().endpoint);
  assert.deepEqual(view['platforms'], [], '还没查过：没有平台清单（不是编一份出来）');
  assert.deepEqual(view['mirrors'], [{ provider: 'pending' }], '网盘未就绪：只有一条 pending');
  assert.match(String(view['releasesUrl']), /^http:\/\/127\.0\.0\.1:\d+\/releases\/$/);
});

test('POST /api/update/check：手动检查立刻发请求，GET 随后能看到 checkedAt / nextAllowedAt / latestVersion', async (t) => {
  const fx = await setup(t);
  const before = await call(fx.base, '/api/update', {}, fx.token);
  assert.equal((before.body as Record<string, unknown>)['checkedAt'], null);

  const run = await call(fx.base, '/api/update/check', { method: 'POST' }, fx.token);
  assert.equal(run.status, 200);
  const outcome = run.body as Record<string, unknown>;
  assert.equal(outcome['performed'], true);
  assert.equal(fx.requests(), 1, '手动检查真的打了一次假站点');
  const view = outcome['view'] as Record<string, unknown>;
  assert.equal(view['status'], 'available');
  assert.equal(view['latestVersion'], '0.1.0-beta.13');
  assert.equal(typeof view['checkedAt'], 'string');
  assert.equal(typeof view['nextAllowedAt'], 'string');
  assert.equal(
    Date.parse(view['nextAllowedAt'] as string) - Date.parse(view['checkedAt'] as string),
    12 * 60 * 60 * 1000,
    '下次允许时间 = 这次检查 + 12 小时',
  );

  const after = await call(fx.base, '/api/update', {}, fx.token);
  const current = after.body as Record<string, unknown>;
  assert.equal(current['status'], 'available');
  assert.equal(current['latestVersion'], '0.1.0-beta.13');
  assert.deepEqual(current['downloadUrl'], 'https://irmia.me/releases/beta/setup.exe');
  assert.deepEqual(current['notesUrl'], 'https://irmia.me/releases/beta/');
  assert.deepEqual(current['platforms'], [{
    os: 'win32', arch: 'x64', kind: 'installer',
    url: 'https://irmia.me/releases/beta/setup.exe', pending: false,
  }], '平台清单原样带出去（GUI 的下载入口按它分流）');
  assert.deepEqual(current['mirrors'], [{ provider: 'pending' }], '站点还没给网盘 ⇒ pending');
});

test('POST /api/update/check：错误方法 ⇒ 405（地址存在，只是不接受 GET）', async (t) => {
  const fx = await setup(t);
  const res = await call(fx.base, '/api/update/check', { method: 'GET' }, fx.token);
  assert.equal(res.status, 405);
  assert.equal(((res.body as Record<string, unknown>)['error'] as Record<string, unknown>)['code'], 'method-not-allowed');
});

test('认证：不带 Bearer ⇒ 401（两条端点都在闸后面）', async (t) => {
  const fx = await setup(t);
  const read = await call(fx.base, '/api/update');
  assert.equal(read.status, 401);
  const run = await call(fx.base, '/api/update/check', { method: 'POST' });
  assert.equal(run.status, 401);
  assert.equal(fx.requests(), 0, '没认证就没有任何外部请求');
});

test('没注入 UpdateService ⇒ 两条都 501（不返回一份看起来正常的空状态）', async (t) => {
  const fx = await setup(t, { withUpdate: false });
  const read = await call(fx.base, '/api/update', {}, fx.token);
  assert.equal(read.status, 501);
  assert.equal(((read.body as Record<string, unknown>)['error'] as Record<string, unknown>)['code'], 'not-implemented');
  const run = await call(fx.base, '/api/update/check', { method: 'POST' }, fx.token);
  assert.equal(run.status, 501);
  const channel = await call(fx.base, '/api/update/channel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'stable' }),
  }, fx.token);
  assert.equal(channel.status, 501);
});

// ──────────────────────────────── 切通道（写 config.json） ────────────────────────────────

interface ChannelRes {
  ok?: boolean;
  channel?: string;
  written?: boolean;
  appliedImmediately?: boolean;
  restartRequired?: boolean;
  performed?: boolean;
  view?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

async function switchChannel(fx: Fixture, body: unknown): Promise<{ status: number; res: ChannelRes }> {
  const out = await call(fx.base, '/api/update/channel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, fx.token);
  return { status: out.status, res: out.body as ChannelRes };
}

test('切通道：合法值 ⇒ 写盘（保注释）+ 清节流 + 立刻查一次，结果一并返回', async (t) => {
  const fx = await setup(t);
  // 先手动查一次：节流窗口被点上（12h 内自动检查会被挡）
  const first = await call(fx.base, '/api/update/check', { method: 'POST' }, fx.token);
  assert.equal(first.status, 200);
  assert.equal(fx.requests(), 1);

  const beforeText = readFileSync(fx.configPath, 'utf8');
  const beforeSha = fx.sha256(fx.configPath);

  const { status, res } = await switchChannel(fx, { channel: 'stable' });
  assert.equal(status, 200);
  assert.equal(res.ok, true);
  assert.equal(res.channel, 'stable');
  assert.equal(res.written, true, '值变了，确实写了盘');
  assert.equal(res.appliedImmediately, true);
  assert.equal(res.restartRequired, false);
  assert.equal(res.performed, true, '切完立刻查了一次（清掉节流）');
  assert.equal(fx.requests(), 2, '节流被清掉：这次没有沿用 12h 窗口');
  assert.equal((res.view ?? {})['channel'], 'stable');
  assert.equal((res.view ?? {})['status'], 'none', '假站点只说 beta：stable 通道下是 channel-mismatch');
  assert.equal((res.view ?? {})['reason'], 'channel-mismatch');

  const afterText = readFileSync(fx.configPath, 'utf8');
  assert.notEqual(fx.sha256(fx.configPath), beforeSha, '写了盘，sha256 必须变');
  const after = JSON.parse(afterText) as Record<string, unknown>;
  assert.deepEqual(after['$comment'], ['手写注释：切通道必须保住它'], '注释键逐字保住');
  assert.deepEqual(after['budget'], { softRatio: 0.8 }, '其余键逐字不变');
  assert.deepEqual(after['update'], { channel: 'stable' }, '只有这一格变了');
  assert.equal(afterText.includes('"channel": "beta"'), false, '旧值不再出现在文件里');
  assert.ok(beforeText.includes('"channel": "beta"'));
});

test('切通道：值本来就相同 ⇒ 不写盘（sha256 不变）但仍清节流并查一次', async (t) => {
  const fx = await setup(t);
  const beforeSha = fx.sha256(fx.configPath);
  // 第一次：beta → beta（盘上本来就是 beta）
  const first = await switchChannel(fx, { channel: 'beta' });
  assert.equal(first.status, 200);
  assert.equal(first.res.written, false, '值没变 ⇒ 一个字节都不写');
  assert.equal(fx.sha256(fx.configPath), beforeSha, '文件 sha256 必须不变');
  assert.equal(fx.requests(), 1, '仍然要查一次（清节流 + 立即查）');

  // 第二次：盘上已经是 stable ⇒ 再切一次同样是"不写盘"
  const toStable = await switchChannel(fx, { channel: 'stable' });
  assert.equal(toStable.res.written, true);
  const stableSha = fx.sha256(fx.configPath);
  const again = await switchChannel(fx, { channel: 'stable' });
  assert.equal(again.status, 200);
  assert.equal(again.res.written, false);
  assert.equal(fx.sha256(fx.configPath), stableSha, '同值再切：sha256 不变');
  assert.equal(fx.requests(), 3, '两次"同值"也各查了一次（节流被清掉）');
});

test('切通道：非法值 ⇒ 400，不写盘、不查（绝不回退到默认值）', async (t) => {
  const fx = await setup(t);
  const beforeSha = fx.sha256(fx.configPath);
  const { status, res } = await switchChannel(fx, { channel: 'gamma' });
  assert.equal(status, 400);
  assert.equal(res.error?.code, 'invalid-channel');
  assert.equal(fx.sha256(fx.configPath), beforeSha, '非法值一个字节都不写');
  assert.equal(fx.requests(), 0, '非法值不发外部请求');

  const missing = await switchChannel(fx, {});
  assert.equal(missing.status, 400);
  assert.equal(fx.sha256(fx.configPath), beforeSha);
});

test('切通道：body 多带字段 ⇒ 400（只接受 channel 这一格）', async (t) => {
  const fx = await setup(t);
  const beforeSha = fx.sha256(fx.configPath);
  const { status, res } = await switchChannel(fx, { channel: 'stable', endpoint: 'https://evil.example/x.json' });
  assert.equal(status, 400);
  assert.equal(res.error?.code, 'unexpected-field');
  assert.equal(fx.sha256(fx.configPath), beforeSha);
  assert.equal(fx.requests(), 0);
});

test('切通道：写后配置校验失败 ⇒ 400 + 回滚（文件逐字回到原样）', async (t) => {
  const fx = await setup(t);
  // 造一份"过不了 loadConfig"的配置：budget.softRatio 必须在 (0,1]
  const broken = `${JSON.stringify({
    $comment: ['坏配置也必须在回滚后原样回来'],
    schemaVersion: 1,
    budget: { softRatio: 8 },
    update: { channel: 'beta' },
  }, null, 2)}\n`;
  writeFileSync(fx.configPath, broken, 'utf8');
  const beforeSha = fx.sha256(fx.configPath);

  const { status } = await switchChannel(fx, { channel: 'stable' });
  assert.equal(status, 400);
  assert.equal(fx.sha256(fx.configPath), beforeSha, '回滚后与写入前逐字相同');
  assert.equal(readFileSync(fx.configPath, 'utf8'), broken);
  assert.equal(fx.requests(), 0, '写盘失败 ⇒ 运行期也不切、不查');
});

test('切通道：错误方法 ⇒ 405；没认证 ⇒ 401', async (t) => {
  const fx = await setup(t);
  const wrong = await call(fx.base, '/api/update/channel', { method: 'GET' }, fx.token);
  assert.equal(wrong.status, 405);
  const noAuth = await call(fx.base, '/api/update/channel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'stable' }),
  });
  assert.equal(noAuth.status, 401);
  assert.equal(fx.requests(), 0);
});
