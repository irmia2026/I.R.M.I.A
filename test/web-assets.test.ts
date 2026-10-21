/**
 * 网页观测台已删除 —— `web/` 目录、`/` 静态分支、SPA 回落、MIME 表，一个都不留。
 *
 * ## 这份文件原来测什么，为什么现在测这个
 *
 * 原来它叫「前端静态资源测试」，逐条断言 `web/ops.html + app.js + app.css` 的字节
 * （关键 ID 锚点、颜色只出自 token 块、动效四处时长、768px 单断点……）。用户的口径是
 * 「web 默认关闭，我们框架不要 web」「删掉 web」——这个框架的**正式产品只有 GUI**，
 * 那 21 个文件整份删掉了，于是那些断言**没有主语了**：不是"暂时跳过"，是"被断言的东西
 * 已经不存在"。留着一个读不到文件的测试文件不叫覆盖，叫自欺。
 *
 * 所以这份文件被改写成**新行为的守卫**，而且比原来更狠一点：过去它证明"前端能拿到"，
 * 现在它要证明"**前端拿不到，而且说得出为什么**"。三条：
 *   ① 任何非 `/api`、非 `/webhook` 的路径都回 `no-web-ui` + 一句人话（不是莫名其妙的 404）；
 *   ② 磁盘上真的没有 `web/` 了（不是"服务端不指过去"，是"东西没了"）；
 *   ③ 删掉的是那张脸，不是后台：`/api/*` 与 `/webhook/*` 照常，
 *      而且**不该再吐出任何 HTML/静态字节**（连 content-type 都只能是 JSON）。
 *
 * 起真实服务、发真实请求：测的是"浏览器/脚本真拿到什么"，不是"源码里有没有某个字符串"。
 */

import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { emptyProjection } from '../src/log/types.ts';
import { ensurePersonaSeeds } from '../src/persona/loader.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const TEST_TOKEN = 'test-token-0123456789abcdef';
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** 「观测台」当年那一整套产物；每一个都必须不可达 */
const OBSERVATORY_PATHS = [
  '/',
  '/index.html',
  '/ops.html',
  '/app.js',
  '/app.css',
  '/chat.css',
  '/shell.js',
  '/shell.css',
  '/pages/_kit.js',
  '/pages/overview.js',
  '/pages/overview.css',
  '/pages/chat.js',
  '/pages/logs.js',
  '/pages/persona.js',
  '/pages/settings.js',
  '/pages/channels.js',
  '/pages/extensions.js',
] as const;

interface Rig {
  dir: string;
  dataDir: string;
  server: WebServer;
  base: string;
}

async function rig(t: TestContext): Promise<Rig> {
  const dir = tempDirSync('irmia-noweb-');
  const dataDir = join(dir, 'data');
  ensurePersonaSeeds(dataDir);
  const log = await EventLog.open(join(dataDir, 'events'));
  const server = await startWebServer({
    log,
    projection: emptyProjection(),
    config: defaultConfig(dir),
    personaRoot: join(dataDir, 'persona'),
    dataDir,
    timers: new TimerStore(join(dataDir, 'timers.json')),
    now: () => new Date('2026-02-14T10:00:00.000Z'),
    uiToken: TEST_TOKEN,
    port: 0,
    out: () => undefined,
  });
  t.after(async () => {
    await server.close();
    log.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发的句柄占用：清理失败不影响断言结论 */
    }
  });
  return { dir, dataDir, server, base: server.url() };
}

interface Res {
  status: number;
  text: string;
  contentType: string;
  body: unknown;
}

async function call(base: string, path: string, init: RequestInit = {}): Promise<Res> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, text, contentType: response.headers.get('content-type') ?? '', body };
}

function errorOf(res: Res): { code: string; message: string } {
  const body = res.body as { error?: { code?: unknown; message?: unknown } } | null;
  assert.ok(body !== null && typeof body === 'object', '错误响应必须是 JSON 对象');
  assert.ok(body.error !== undefined, '错误响应必须带 error 字段');
  return { code: String(body.error.code), message: String(body.error.message) };
}

// ──────────────────────────────── ① 不可达 ────────────────────────────────

test('观测台的每一条路径都不可达：404 + no-web-ui + 一句人话', async (t) => {
  const r = await rig(t);

  for (const path of OBSERVATORY_PATHS) {
    const res = await call(r.base, path);
    assert.equal(res.status, 404, `${path} 不该再拿到任何东西`);
    assert.equal(errorOf(res).code, 'no-web-ui', `${path} 的错误码要说明"这儿没有网页"`);
    assert.equal(
      errorOf(res).message,
      '本框架不提供网页界面；桌面界面请用 GUI。',
      `${path} 要回一句人话，而不是让人以为是服务没起来`,
    );
  }
});

test('不再吐任何静态字节：content-type 只有 JSON，HTML/JS/CSS 一次都不出现', async (t) => {
  const r = await rig(t);

  for (const path of OBSERVATORY_PATHS) {
    const res = await call(r.base, path);
    assert.match(res.contentType, /application\/json/u, `${path} 的 content-type 只能是 JSON`);
    assert.doesNotMatch(res.contentType, /text\/html|text\/css|javascript/u);
    assert.doesNotMatch(res.text, /<!doctype|<html|<script|<link/iu, `${path} 不该回任何 HTML`);
  }
});

test('工作目录里就算摆着 index.html，也不会被服务出去（没有"读文件"这条路了）', async (t) => {
  const r = await rig(t);
  // 过去 `/` 会落到 `<cwd>/web/index.html`；现在连 cwd 下的同名文件都不该被看见
  writeFileSync(join(r.dir, 'index.html'), '<!doctype html><title>假的观测台</title>', 'utf8');

  const res = await call(r.base, '/');
  assert.equal(res.text.includes('假的观测台'), false);
  assert.equal(res.status, 404);
  assert.equal(errorOf(res).code, 'no-web-ui');
});

test('深链与杂路径一视同仁：hash 路由的 /events、/chat 也是 no-web-ui（没有 SPA 回落）', async (t) => {
  const r = await rig(t);

  for (const path of ['/events', '/chat', '/logs', '/settings/persona', '/nope.txt', '/favicon.ico']) {
    const res = await call(r.base, path);
    assert.equal(res.status, 404, `${path} 过去会回落到 index.html，现在必须说实话`);
    assert.equal(errorOf(res).code, 'no-web-ui');
  }
});

test('非 GET 也走同一条答复：不再有"静态资源只接受 GET/HEAD"的 405', async (t) => {
  const r = await rig(t);

  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await call(r.base, '/index.html', {
      method,
      ...(method === 'POST' ? { body: 'x' } : {}),
    });
    assert.equal(res.status, 404, `${method} /index.html`);
    assert.equal(errorOf(res).code, 'no-web-ui');
  }
});

test('URL 里的安全形状不再是问题：编码点段 / 空字节都落在同一条 no-web-ui 上', async (t) => {
  const r = await rig(t);
  writeFileSync(join(r.dir, 'secret.txt'), '不该被读到\n', 'utf8');

  // 过去这里有一整套"防路径穿越"（403）；没有读文件这条路之后，它连同攻击面一起消失了。
  // 断言保留下来，因为它保证的是**结果**：不管拦在哪一层，secret 都不能出现在响应里。
  for (const path of ['/%2e%2e%2fsecret.txt', '/../../secret.txt', '/%00', '/web/../index.html']) {
    const res = await call(r.base, path);
    assert.equal(res.text.includes('不该被读到'), false, `${path} 不能读到 web/ 之外的文件`);
    assert.equal(res.status, 404, `${path} 应回 no-web-ui`);
  }
});

// ──────────────────────────────── ② 磁盘上真的没了 ────────────────────────────────

test('磁盘上不再有 web/ 目录（不是"服务端不指过去"，是东西没了）', () => {
  assert.equal(existsSync(join(REPO_ROOT, 'web')), false, 'web/ 应已整个删除（21 个文件）');
  assert.equal(existsSync(join(REPO_ROOT, 'web', 'index.html')), false);
  assert.equal(existsSync(join(REPO_ROOT, 'web', 'ops.html')), false);
  assert.equal(existsSync(join(REPO_ROOT, 'web', 'pages')), false);

  // 当年给网页版写的无头冒烟脚本也一并删掉了：它的入口就是那些文件
  assert.equal(existsSync(join(REPO_ROOT, 'scripts', 'smoke-web.mjs')), false);
});

test('服务端不再有静态服务那段代码的入口（WEB_DIR_NAME / ensureUiToken 都没了）', async () => {
  const server = await import('../src/web/server.ts');
  assert.equal('WEB_DIR_NAME' in server, false, 'WEB_DIR_NAME 应随静态分支一起删除');
  assert.equal('ensureUiToken' in server, false, '生成 UI token 那条路应已删除（改成密码）');
  assert.equal('UI_TOKEN_BYTES' in server, false);
  // 工厂与启动入口照旧（宿主与测试都从这两个进去）
  assert.equal(typeof server.createWebServer, 'function');
  assert.equal(typeof server.startWebServer, 'function');
  // 认证库挂在 WebServer 上（宿主据此问"设过密码没有"），而不再是 token/tokenCreated 那对字段
  assert.equal('instanceIdOf' in server, true, '实例标识的计算只此一份');
});

// ──────────────────────────────── ③ 删的是脸，不是后台 ────────────────────────────────

test('/api/* 照常：带凭据就能读（删掉的是那张网页脸，不是后台）', async (t) => {
  const r = await rig(t);

  const projection = await call(r.base, '/api/projection', {
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  assert.equal(projection.status, 200);
  assert.equal((projection.body as { lastSeq: number }).lastSeq, 0);

  const dashboard = await call(r.base, '/api/stats/dashboard', {
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  assert.equal(dashboard.status, 200);

  const config = await call(r.base, '/api/config', {
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  assert.equal(config.status, 200);

  const command = await call(r.base, '/api/commands/wake', {
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ note: '界面还在用这条路' }),
  });
  assert.equal(command.status, 200);
  assert.equal((command.body as { type: string }).type, 'wake/manual');
});

test('/api/* 仍然是 401 而不是 404：门还在，只是换成了密码那套', async (t) => {
  const r = await rig(t);

  const anon = await call(r.base, '/api/projection');
  assert.equal(anon.status, 401, '绝不能让"没网页"顺手把 API 也一起变成 404');
  assert.match(anon.contentType, /application\/json/u);
});

test('/webhook/* 照常（通道靠它）：带专用凭据 POST 落 wake/webhook', async (t) => {
  const r = await rig(t);

  // 专用凭据（B9）：这条通道**只认它**。老实例迁移期还没设密码，但 /api/* 认那份 `.ui-token`，
  // 所以生成这一步现在就能走通；生成之后 webhook 用新凭据，而 `.ui-token` 在那条通道上仍是 401。
  const minted = await call(r.base, '/api/commands/regenerate-webhook-token', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      'content-type': 'application/json',
      'x-confirm': 'regenerate-webhook-token',
    },
    body: JSON.stringify({ by: 'test' }),
  });
  assert.equal(minted.status, 200, minted.text);
  const hookToken = (minted.body as { token: string }).token;

  const res = await call(r.base, '/webhook/test', {
    method: 'POST',
    headers: { authorization: `Bearer ${hookToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  });
  assert.equal(res.status, 200);
  assert.equal((res.body as { type: string }).type, 'wake/webhook');

  const anon = await call(r.base, '/webhook/test', { method: 'POST', body: '{}' });
  assert.equal(anon.status, 401, 'webhook 一样要凭据');

  const legacy = await call(r.base, '/webhook/test', {
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'again' }),
  });
  assert.equal(legacy.status, 401, '收窄：`.ui-token`（界面的凭据）不再能打 webhook');
});
