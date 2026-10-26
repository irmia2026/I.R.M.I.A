/**
 * 扫码创建 QQ 官方 Bot —— **端点那一层**（`/api/channels/qq-official/bind/*` 与 `qq-token-test`）。
 *
 * 验的是用户那几句话落到 HTTP 上的形状：
 *   · **都要鉴权**：没有会话凭据一律 401（与 `/api/*` 同一道闸，不另开小门）；
 *   · `POST .../bind/start` 回 `{taskId, url}`，url 就是**二维码内容**
 *     （`https://q.qq.com/qqbot/openclaw/connect.html?task_id=…&source=irmia&_wv=2`）；
 *   · `GET .../bind/status` 在成功后带 `appId`，并且**那一刻**凭据已经写进 `data/.keys.json`、
 *     `channels.qqOfficial.enabled` 已经置 true（与手填 AppID/AppSecret 走同一条落盘路径）；
 *   · **secret 不回显**：响应体、诊断输出、事件日志里都不许出现它；
 *   · `POST /api/commands/qq-token-test` 真去换一次 access_token，失败回中文原因；
 *   · 方法不对是 405，start 打不通是 502（对端失败）而不是 400（请求不合法）。
 *
 * 外网一律由伪 HTTP 顶替（`WebServerDeps.qqBindHttp`）：这里要验的是"三步的顺序、
 * 落盘与回执"，不是"今天 q.qq.com 通不通"。协议与状态机本身在 `test/qq-bind.test.ts`。
 */

import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { KEYS_FILE_NAME, writeKeysFile } from '../src/config/keys.ts';
import { EventLog } from '../src/log/event-log.ts';
import { emptyProjection, type AppEvent } from '../src/log/types.ts';
import { ensurePersonaSeeds } from '../src/persona/loader.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';
import {
  QQ_BIND_NONCE_BYTES,
  QQ_BIND_TAG_BYTES,
  type QqBindHttp,
  type QqBindHttpRequest,
} from '../src/channel/qq-bind.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const T0 = new Date('2026-02-14T10:00:00.000Z');
const TOKEN = 'test-session-token-qq-bind-0123456789';
const APP_ID = '10240001';
const CLIENT_SECRET = 'fake-client-secret';

const CONFIG_TEXT = `${JSON.stringify({
  $comment: ['手写注释：扫码落盘必须保住它'],
  schemaVersion: 1,
  channels: { qqOfficial: { enabled: false } },
}, null, 2)}\n`;

/** 按官方布局加密一段 secret（fake 服务端用它造 `bot_encrypt_secret`） */
function encryptSecret(plain: string, keyB64: string): string {
  const nonce = randomBytes(QQ_BIND_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), nonce, {
    authTagLength: QQ_BIND_TAG_BYTES,
  });
  const body = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64');
}

/** 伪 QQ：三步 + 换 token，按脚本回答并把请求记下来 */
class FakeQq {
  readonly requests: QqBindHttpRequest[] = [];
  readonly keys: string[] = [];
  statuses: number[] = [];
  createFails = false;
  tokenBody: Record<string, unknown> | null = null;
  createCount = 0;
  pollCount = 0;
  tokenCount = 0;

  http: QqBindHttp = async (request) => {
    this.requests.push(request);
    if (request.url.includes('create_bind_task')) {
      this.createCount += 1;
      if (this.createFails) throw new Error('连不上 QQ 的接口（fake）：getaddrinfo ENOTFOUND');
      const key = (request.jsonBody as { key?: string }).key ?? '';
      this.keys.push(key);
      return { status: 200, text: '', body: { data: { task_id: `T${this.createCount}` } } };
    }
    if (request.url.includes('poll_bind_result')) {
      const status = this.statuses[Math.min(this.pollCount, Math.max(0, this.statuses.length - 1))] ?? 0;
      this.pollCount += 1;
      return {
        status: 200,
        text: '',
        body: {
          data: {
            status,
            ...(status === 2
              ? {
                bot_appid: APP_ID,
                bot_encrypt_secret: encryptSecret(CLIENT_SECRET, this.keys[this.keys.length - 1] ?? ''),
                user_openid: 'user-openid-1',
              }
              : {}),
          },
        },
      };
    }
    if (request.url.includes('getAppAccessToken')) {
      this.tokenCount += 1;
      return { status: 200, text: '', body: this.tokenBody ?? { access_token: 'fake-token', expires_in: 7200 } };
    }
    throw new Error(`fake 不认识这个地址：${request.url}`);
  };
}

interface Rig {
  dir: string;
  dataDir: string;
  configPath: string;
  base: string;
  token: string;
  fake: FakeQq;
  printed: string[];
  readAll(): Promise<AppEvent[]>;
}

async function rig(t: TestContext): Promise<Rig> {
  const dir = tempDirSync('irmia-qqbind-api-');
  const dataDir = join(dir, 'data');
  const configPath = join(dir, 'config.json');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(configPath, CONFIG_TEXT, 'utf8');
  ensurePersonaSeeds(dataDir);

  const log = await EventLog.open(join(dataDir, 'events'));
  const printed: string[] = [];
  const fake = new FakeQq();
  const server: WebServer = await startWebServer({
    log,
    projection: emptyProjection(),
    config: defaultConfig(dataDir),
    personaRoot: join(dataDir, 'persona'),
    dataDir,
    timers: new TimerStore(join(dataDir, 'timers.json')),
    now: () => T0,
    // 旧 token（迁移期那份）足够当"有会话凭据"用：这条用例验的不是认证那套（那在 web-auth）
    uiToken: TOKEN,
    configPath,
    port: 0,
    out: (line) => printed.push(line),
    qqBindHttp: fake.http,
    // 用例不真等 2 秒：不起后台定时器，完全由 status 端点驱动
    qqBindTiming: { pollIntervalMs: 0, timeoutMs: 60_000 },
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

  return {
    dir,
    dataDir,
    configPath,
    base: server.url(),
    token: TOKEN,
    fake,
    printed,
    readAll: async () => {
      const out: AppEvent[] = [];
      for await (const event of log.readAll()) out.push(event);
      return out;
    },
  };
}

interface Res {
  status: number;
  body: unknown;
  text: string;
}

async function call(
  base: string,
  path: string,
  input: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (input.token !== null && input.token !== undefined) headers['authorization'] = `Bearer ${input.token}`;
  const payload = input.body === undefined ? undefined : JSON.stringify(input.body);
  if (payload !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method: input.method ?? 'GET',
    headers,
    ...(payload !== undefined ? { body: payload } : {}),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

function errorOf(res: Res): { code: string; message: string } {
  const body = res.body as { error?: { code?: unknown; message?: unknown } } | null;
  assert.ok(body !== null && typeof body === 'object', '错误响应必须是 JSON 对象');
  return { code: String(body.error?.code), message: String(body.error?.message) };
}

function keysFile(dataDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dataDir, KEYS_FILE_NAME), 'utf8')) as Record<string, unknown>;
}

// ──────────────────────────────── 鉴权 ────────────────────────────────

test('扫码两条端点都要鉴权：没有会话凭据一律 401，且一个外部请求都不发', async (t) => {
  const r = await rig(t);
  for (const [method, path] of [
    ['POST', '/api/channels/qq-official/bind/start'],
    ['GET', '/api/channels/qq-official/bind/status'],
  ] as const) {
    const res = await call(r.base, path, { method });
    assert.equal(res.status, 401, `${method} ${path} 必须过认证闸`);
    // 夹具用的是迁移期旧 token（没跑 scrypt 设密码），所以门回的是 `auth-uninitialized`；
    // 设过密码的实例回 `unauthorized`。两种都是"没进来"，这里只钉"401 且不放到外面去"。
    assert.ok(
      ['auth-uninitialized', 'unauthorized'].includes(errorOf(res).code),
      `401 的错误码要说清是哪一扇门，收到 ${errorOf(res).code}`,
    );
  }
  assert.equal(r.fake.createCount, 0, '门都没进，不许替谁去建任务');
  assert.deepEqual(await r.readAll(), []);
});

// ──────────────────────────────── start ────────────────────────────────

test('start：回 taskId + 二维码 url（形状由官方页面自己认）', async (t) => {
  const r = await rig(t);

  // 还没扫过：status 是 idle（不是错误，也不假装在等）
  const idle = await call(r.base, '/api/channels/qq-official/bind/status', { token: r.token });
  assert.equal(idle.status, 200, idle.text);
  assert.equal((idle.body as { status?: unknown }).status, 'idle');

  const start = await call(r.base, '/api/channels/qq-official/bind/start', {
    method: 'POST', token: r.token, body: {},
  });
  assert.equal(start.status, 200, start.text);
  const body = start.body as { ok?: unknown; taskId?: unknown; url?: unknown };
  assert.equal(body.ok, true);
  assert.equal(body.taskId, 'T1');
  assert.equal(
    body.url,
    'https://q.qq.com/qqbot/openclaw/connect.html?task_id=T1&source=irmia&_wv=2',
    '二维码内容就是交给系统浏览器打开的那个地址',
  );
  assert.equal(r.fake.requests.length, 1, 'start 只打第 1 步');
  assert.equal(Buffer.from(r.fake.keys[0] ?? '', 'base64').length, 32, 'key 是 32 随机字节');
});

// ──────────────────────────────── status → 成功落盘 ────────────────────────────────

test('status：pending → 成功带 appId，凭据已写进 data/.keys.json、通道已启用（注释还在）', async (t) => {
  const r = await rig(t);
  r.fake.statuses = [0, 2];

  await call(r.base, '/api/channels/qq-official/bind/start', { method: 'POST', token: r.token, body: {} });

  const pending = await call(r.base, '/api/channels/qq-official/bind/status', { token: r.token });
  assert.equal(pending.status, 200, pending.text);
  assert.equal((pending.body as { status?: unknown }).status, 'pending');
  assert.equal(keysFileExists(r.dataDir), false, '还没成功：一个字节都不许写盘');

  const success = await call(r.base, '/api/channels/qq-official/bind/status', { token: r.token });
  assert.equal(success.status, 200, success.text);
  const view = success.body as {
    status?: unknown; appId?: unknown; saved?: unknown; enabled?: unknown;
    connection?: { ok?: unknown; expiresIn?: unknown };
  };
  assert.equal(view.status, 'success');
  assert.equal(view.appId, APP_ID, '成功之后界面要能显示 AppID');
  assert.equal(view.saved, true, '成功那一刻就该写好盘：不许让人再点一次保存');
  assert.equal(view.enabled, true);
  assert.equal(view.connection?.ok, true, '自动跑的那次连接测试');
  assert.equal(view.connection?.expiresIn, 7200);

  // ① 凭据落在 data/.keys.json（与手填 AppID/AppSecret 同一条 set-key 路径、同一对键名）
  assert.deepEqual(keysFile(r.dataDir), { qqAppId: APP_ID, qqClientSecret: CLIENT_SECRET });

  // ② 通道启用写进 config.json（withConfigDoc 那条路：人写的注释要保住）
  const config = JSON.parse(readFileSync(r.configPath, 'utf8')) as {
    $comment?: unknown; channels?: { qqOfficial?: { enabled?: unknown } };
  };
  assert.deepEqual(config.$comment, ['手写注释：扫码落盘必须保住它'], '$comment 不许被写丢');
  assert.equal(config.channels?.qqOfficial?.enabled, true);

  // ③ 连接测试用的是**刚写进去**的那两把凭据
  const tokenRequest = r.fake.requests.find((req) => req.url.includes('getAppAccessToken'));
  assert.ok(tokenRequest !== undefined, '成功之后要自动换一次 token');
  assert.deepEqual(tokenRequest?.jsonBody, { appId: APP_ID, clientSecret: CLIENT_SECRET });

  // ④ secret 绝不回显：响应体、诊断输出、事件日志三处都查一遍
  assert.equal(success.text.includes(CLIENT_SECRET), false, '响应体不许回显 AppSecret');
  assert.equal(r.printed.join('\n').includes(CLIENT_SECRET), false, '诊断输出不许有 AppSecret');
  assert.equal(JSON.stringify(await r.readAll()).includes(CLIENT_SECRET), false, '事件日志不许有 AppSecret');
  assert.match(r.printed.join('\n'), /AppID 10240001/u, '但 AppID（不是密钥）要说出来，排障时有用');

  // ⑤ 再问一次还是 success，且**不重复写盘**（配置只变了一次）
  const again = await call(r.base, '/api/channels/qq-official/bind/status', { token: r.token });
  assert.equal((again.body as { status?: unknown }).status, 'success');
  const changes = (await r.readAll()).filter((event) => event.type === 'config/changed');
  assert.equal(changes.length, 1, '同一轮扫码只该写一次配置');
});

test('status：过期（3 → 自动重建一次 → 再 3）回 expired，不写任何凭据', async (t) => {
  const r = await rig(t);
  r.fake.statuses = [3, 3];

  await call(r.base, '/api/channels/qq-official/bind/start', { method: 'POST', token: r.token, body: {} });
  const first = await call(r.base, '/api/channels/qq-official/bind/status', { token: r.token });
  const rebuilt = first.body as { status?: unknown; taskId?: unknown; url?: unknown };
  assert.equal(rebuilt.status, 'pending', '第一次过期是自动重建，不是直接结束');
  assert.equal(rebuilt.taskId, 'T2');
  assert.match(String(rebuilt.url), /task_id=T2/u);

  const second = await call(r.base, '/api/channels/qq-official/bind/status', { token: r.token });
  const expired = second.body as { status?: unknown; reason?: unknown };
  assert.equal(expired.status, 'expired');
  assert.match(String(expired.reason), /过期/u);
  assert.equal(keysFileExists(r.dataDir), false, '过期就是没绑上：一个字节都不写');
});

// ──────────────────────────────── start 失败 ────────────────────────────────

test('start 打不通对端 ⇒ 502 + 中文人话（不是 400：请求本身没写错）', async (t) => {
  const r = await rig(t);
  r.fake.createFails = true;
  const res = await call(r.base, '/api/channels/qq-official/bind/start', {
    method: 'POST', token: r.token, body: {},
  });
  assert.equal(res.status, 502);
  assert.equal(errorOf(res).code, 'qq-bind-start-failed');
  assert.match(errorOf(res).message, /连不上 QQ 的接口/u);
});

// ──────────────────────────────── 连接测试 ────────────────────────────────

test('qq-token-test：用盘上那份凭据真换 token；失败回中文原因，且不回显 secret', async (t) => {
  const r = await rig(t);
  await writeKeysFile(r.dataDir, { qqAppId: APP_ID, qqClientSecret: CLIENT_SECRET });

  const ok = await call(r.base, '/api/commands/qq-token-test', { method: 'POST', token: r.token, body: {} });
  assert.equal(ok.status, 200, ok.text);
  const okBody = ok.body as { ok?: unknown; expiresIn?: unknown };
  assert.equal(okBody.ok, true);
  assert.equal(okBody.expiresIn, 7200);

  // 失败：官方是 HTTP 200 + 响应体 code ⇒ 必须按响应体判，并把 code 说出来
  r.fake.tokenBody = { code: 100016, message: 'invalid appid or secret' };
  const failed = await call(r.base, '/api/commands/qq-token-test', { method: 'POST', token: r.token, body: {} });
  assert.equal(failed.status, 200, '连不上是"结果"，不是 HTTP 错误');
  const failedBody = failed.body as { ok?: unknown; error?: unknown };
  assert.equal(failedBody.ok, false);
  assert.match(String(failedBody.error), /换取 access_token 失败/u);
  assert.match(String(failedBody.error), /code=100016/u);
  assert.equal(failed.text.includes(CLIENT_SECRET), false, '失败原因里不许夹带 secret');

  // 允许测试**还没保存**的那两把（人刚敲完就点测试）；值只在这次请求里用，不回显
  const typed = await call(r.base, '/api/commands/qq-token-test', {
    method: 'POST', token: r.token, body: { appId: '999', clientSecret: 'typed-secret' },
  });
  assert.equal((typed.body as { ok?: unknown }).ok, false, 'fake 的默认回包没有 access_token 时就是失败');
  const last = r.fake.requests.filter((req) => req.url.includes('getAppAccessToken')).at(-1);
  assert.deepEqual(last?.jsonBody, { appId: '999', clientSecret: 'typed-secret' });
  assert.equal(typed.text.includes('typed-secret'), false);
});

// ──────────────────────────────── 方法 ────────────────────────────────

test('方法不对是 405（地址存在，只是不接受这个方法）', async (t) => {
  const r = await rig(t);
  const getStart = await call(r.base, '/api/channels/qq-official/bind/start', { token: r.token });
  assert.equal(getStart.status, 405);
  assert.equal(errorOf(getStart).code, 'method-not-allowed');

  const postStatus = await call(r.base, '/api/channels/qq-official/bind/status', {
    method: 'POST', token: r.token, body: {},
  });
  assert.equal(postStatus.status, 405);
  assert.equal(errorOf(postStatus).code, 'method-not-allowed');
});

// ──────────────────────────────── 小工具 ────────────────────────────────

function keysFileExists(dataDir: string): boolean {
  try {
    return readFileSync(join(dataDir, KEYS_FILE_NAME), 'utf8').trim() !== '';
  } catch {
    return false;
  }
}
