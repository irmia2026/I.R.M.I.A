/**
 * `POST /api/models/probe` 的**接线**测试（实现核心在 test/models-probe.test.ts）。
 *
 * 这一份只钉三件在这一层才能回答的事：
 *   ① **要 Bearer**：没有会话凭据 ⇒ 401，而且上游一次都不该被打（不能拿本机网络当跳板）；
 *   ② **apiKey 缺省 = 用已存的那把**：请求头里出现的是 `data/.keys.json` 的 heavy 那把，
 *      与 `set-key` 同一个解析入口（不是界面传来的会话凭据）；
 *   ③ **没有已存密钥** ⇒ `{ok:false, code:'no-api-key'}`，不是 401、也不是 500。
 *
 * 另外顺手钉住"响应里不含 key"（这条端点的 body 里允许带一把临时密钥，它绝不能反照回来）。
 */

import assert from 'node:assert/strict';
import { createHash, scryptSync } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { writeKeysFile } from '../src/config/keys.ts';
import { EventLog } from '../src/log/event-log.ts';
import { emptyProjection } from '../src/log/types.ts';
import { ensurePersonaSeeds } from '../src/persona/loader.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { AUTH_FILE_NAME, SCRYPT_PARAMS } from '../src/web/auth.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const T0 = new Date('2026-02-14T10:00:00.000Z');
const TEST_TOKEN = 'test-session-token-0123456789abcdef';
const TEST_PASSWORD = 'test-password-0123456789';
// ⚠ 两个 key 夹具**刻意不写成 `sk-…`**：`tools/sanitize-audit.mjs` 的 `api-key` 模式抓的就是
// `sk-` 长串，而 `test/` 会同步进公开副本——夹具不该长成闸门要抓的样子（验的是"不许反照"，
// 与 key 的形状无关）。名字里带 fake/credential 是为了让人一眼看出是造的。
const STORED_KEY = 'stored-fake-credential-do-not-leak-1111';
const TYPED_KEY = 'typed-fake-credential-do-not-leak-2222';

/** 与 test/web-server.test.ts 同一份种子（一次 scrypt 约 60ms；这里只有三个用例）。 */
const TEST_SALT = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const TEST_HASH = scryptSync(TEST_PASSWORD, TEST_SALT, 32, {
  N: SCRYPT_PARAMS.N,
  r: SCRYPT_PARAMS.r,
  p: SCRYPT_PARAMS.p,
}).toString('hex');

function seedAuthFile(dataDir: string): void {
  writeFileSync(join(dataDir, AUTH_FILE_NAME), `${JSON.stringify({
    v: 1,
    scrypt: { salt: TEST_SALT.toString('hex'), ...SCRYPT_PARAMS },
    hash: TEST_HASH,
    sessions: [{
      id: 'aabbccddeeff0011',
      hash: createHash('sha256').update(TEST_TOKEN, 'utf8').digest('hex'),
      createdAt: T0.toISOString(),
      label: 'test',
    }],
  }, null, 2)}\n`, 'utf8');
}

interface SeenUpstream {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** 上游假供应商：`/models` 回一个模型，两套协议都回 200。 */
async function startUpstream(t: TestContext): Promise<{ base: string; seen: SeenUpstream[] }> {
  const seen: SeenUpstream[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://placeholder');
      seen.push({
        method: req.method ?? '',
        path: url.pathname,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.setHeader('content-type', 'application/json');
      res.setHeader('connection', 'close');
      if (url.pathname === '/models') {
        res.end(JSON.stringify({ data: [{ id: 'probe-web-model' }] }));
        return;
      }
      if (url.pathname === '/responses') {
        res.end('{"id":"resp_1"}');
        return;
      }
      if (url.pathname === '/chat/completions') {
        res.end('{"choices":[]}');
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('上游假供应商没拿到端口');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  return { base: `http://127.0.0.1:${address.port}`, seen };
}

interface WebFixture {
  server: WebServer;
  base: string;
  dataDir: string;
  upstream: { base: string; seen: SeenUpstream[] };
}

async function setupWeb(t: TestContext, options: { storedKey?: string | undefined } = {}): Promise<WebFixture> {
  const dir = tempDirSync('irmia-probe-web-');
  const dataDir = join(dir, 'data');
  mkdirSync(join(dataDir, 'events'), { recursive: true });
  seedAuthFile(dataDir);
  ensurePersonaSeeds(dataDir);
  if (options.storedKey !== undefined) await writeKeysFile(dataDir, { heavy: options.storedKey });
  const log = await EventLog.open(join(dataDir, 'events'));
  const config = defaultConfig(dir);
  const timers = new TimerStore(join(dataDir, 'timers.json'), { now: () => T0 });
  const upstream = await startUpstream(t);
  const server = await startWebServer({
    log,
    projection: emptyProjection(),
    config,
    personaRoot: join(dataDir, 'persona'),
    dataDir,
    timers,
    now: () => T0,
    uiToken: null,
    configPath: join(dir, 'config.json'),
    port: 0,
    out: () => undefined,
  });
  t.after(async () => {
    await server.close();
    log.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发的句柄占用：不影响断言 */
    }
  });
  return { server, base: server.url(), dataDir, upstream };
}

function payload(baseUrl: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { lane: 'heavy', baseUrl, ...extra };
}

test('没有 Bearer ⇒ 401，且上游一次都不被打', async (t) => {
  const fx = await setupWeb(t);
  const response = await fetch(`${fx.base}/api/models/probe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload(fx.upstream.base)),
  });
  assert.equal(response.status, 401);
  const body = await response.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, 'unauthorized');
  assert.equal(fx.upstream.seen.length, 0, '认证没过就不该替调用方去探外部端点');
});

test('apiKey 缺省 ⇒ 用已存的那把；显式传则以显式那把为准（两者都不回显）', async (t) => {
  const fx = await setupWeb(t, { storedKey: STORED_KEY });

  const stored = await fetch(`${fx.base}/api/models/probe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify(payload(`${fx.upstream.base}/`)),
  });
  assert.equal(stored.status, 200);
  const storedBody = await stored.json() as { ok?: boolean; models?: string[]; recommended?: string | null };
  assert.equal(storedBody.ok, true);
  assert.deepEqual(storedBody.models, ['probe-web-model']);
  assert.equal(storedBody.recommended, 'probe-web-model');
  // 第一次上游请求就是 /models，头里是**盘上那把**，不是界面会话凭据
  assert.equal(fx.upstream.seen[0]?.path, '/models');
  assert.equal(fx.upstream.seen[0]?.headers.authorization, `Bearer ${STORED_KEY}`);

  const typed = await fetch(`${fx.base}/api/models/probe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify(payload(fx.upstream.base, { apiKey: TYPED_KEY })),
  });
  assert.equal(typed.status, 200);
  const typedText = await typed.text();
  assert.equal(typedText.includes(TYPED_KEY), false, '临时密钥不许反照进响应');
  assert.equal(typedText.includes(STORED_KEY), false, '已存密钥更不许反照进响应');
  // 第二次探测的三次上游请求都该带显式那把
  const secondRound = fx.upstream.seen.slice(3);
  assert.equal(secondRound.length, 3);
  for (const call of secondRound) {
    assert.equal(call.headers.authorization, `Bearer ${TYPED_KEY}`);
  }
});

test('没有已存密钥且 body 没带 ⇒ {ok:false, code:"no-api-key"}（不是 401）', async (t) => {
  const fx = await setupWeb(t);
  const response = await fetch(`${fx.base}/api/models/probe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify(payload(fx.upstream.base)),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { ok?: boolean; code?: string; message?: string };
  assert.equal(body.ok, false);
  assert.equal(body.code, 'no-api-key');
  assert.equal(String(body.message).includes('API Key'), true);
  assert.equal(fx.upstream.seen.length, 0, '没有密钥就不该发请求');
});
