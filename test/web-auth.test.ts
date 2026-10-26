/**
 * 本地认证测试 — src/web/auth.ts + `src/web/server.ts` 的 `/api/auth/*`
 *
 * 覆盖的每一条都对着一句用户的口径（「不需要 token，首次启动的时候要求用户设置密码就行了」）：
 *
 *   ① **首次启动 = 待初始化**：没凭据文件时 `/api/*` 全部 401 且明说"还没设密码"，
 *      **只放行 `POST /api/auth/setup` 这一条**；
 *   ② 设完密码**立刻就是登录态**（当场签发会话），人不必再输一遍；
 *   ③ 登录 → 会话凭据 → 之后 `/api/*` 用它；**错密码 401**；
 *   ④ 会话**可撤销**：登出 / 改密码踢掉全部旧会话；
 *   ⑤ **退避**：连续失败延迟增长，但**不硬锁**（硬锁 = 任何人失败 N 次就能把用户关在门外）；
 *   ⑥ **迁移**：老实例的 `data/.ui-token` 在设密码之前照旧可用，设完当场作废并从盘上删掉，
 *      并落一条 `auth/password-set` 事实事件（谁在什么时候设的、旧 token 已停用）；
 *   ⑦ **明文绝不落盘、绝不进日志**：盘上只有 scrypt 派生键与会话哈希，日志里连会话串的
 *      影子都不该有。
 *
 * **`/webhook/*` 不在这份文件里**（B9，2026-10）：那条通道有自己的专用凭据
 * （`data/.webhook-secret.json`），界面的会话凭据与 `.ui-token` 在那里一律 401。
 * 它的生成/轮换/收窄口径单独立案在 `test/webhook-secret.test.ts`；这里只保留一条
 * "它不共用界面那套错误码"的钉子。
 *
 * 两条纪律：
 *   · 每个用例一个独立临时目录（凭据文件是真的会写盘的）；
 *   · 断言首选"盘上/日志里有什么"，其次才是响应体——HTTP 层只是通道。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { emptyProjection, type AppEvent } from '../src/log/types.ts';
import { ensurePersonaSeeds } from '../src/persona/loader.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import {
  AUTH_FILE_NAME, AuthStore, BACKOFF_MAX_MS, PASSWORD_MIN_LEN, SCRYPT_PARAMS, SCRYPT_SALT_BYTES,
  SESSION_BYTES, UI_TOKEN_FILE, passwordProblem, readLegacyToken,
} from '../src/web/auth.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const T0 = new Date('2026-02-14T10:00:00.000Z');
const LEGACY_TOKEN = 'legacy-token-0123456789abcdef';
const GOOD_PASSWORD = 'irmia-local-pw';

interface Rig {
  dir: string;
  dataDir: string;
  log: EventLog;
  server: WebServer;
  base: string;
  auth: AuthStore;
  printed: string[];
  readAll(): Promise<AppEvent[]>;
}

async function rig(
  t: TestContext,
  options: { legacyToken?: string | null } = {},
): Promise<Rig> {
  const dir = tempDirSync('irmia-auth-');
  const dataDir = join(dir, 'data');
  ensurePersonaSeeds(dataDir);
  if (options.legacyToken !== undefined && options.legacyToken !== null) {
    writeFileSync(join(dataDir, UI_TOKEN_FILE), `${options.legacyToken}\n`, 'utf8');
  }

  const log = await EventLog.open(join(dataDir, 'events'));
  const printed: string[] = [];
  const server = await startWebServer({
    log,
    projection: emptyProjection(),
    config: defaultConfig(dir),
    personaRoot: join(dataDir, 'persona'),
    dataDir,
    timers: new TimerStore(join(dataDir, 'timers.json')),
    now: () => T0,
    // `legacyToken: null` 显式表示"这个实例没有旧 token"，不受磁盘上碰巧存在的文件影响
    ...(options.legacyToken === undefined ? {} : { uiToken: options.legacyToken }),
    port: 0,
    out: (line) => printed.push(line),
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
    log,
    server,
    base: server.url(),
    auth: server.auth,
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
  headers: Headers;
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
  return { status: response.status, body, text, headers: response.headers };
}

function errorOf(res: Res): { code: string; message: string } {
  const body = res.body as { error?: { code?: unknown; message?: unknown } } | null;
  assert.ok(body !== null && typeof body === 'object', '错误响应必须是 JSON 对象');
  assert.ok(body.error !== undefined, '错误响应必须带 error 字段');
  return { code: String(body.error.code), message: String(body.error.message) };
}

function tokenOf(res: Res): string {
  const body = res.body as { token?: unknown };
  assert.equal(typeof body.token, 'string', '签发响应里必须带会话凭据');
  return body.token as string;
}

function authFile(dataDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dataDir, AUTH_FILE_NAME), 'utf8')) as Record<string, unknown>;
}

/** 直连 AuthStore（不起 HTTP）：参数、哈希、退避这些事在那一层验更准、更快 */
function store(dataDir: string, now: () => Date, legacyToken: string | null = null): AuthStore {
  return new AuthStore({ dataDir, now, legacyToken });
}

// ──────────────────────────────── ① 待初始化 ────────────────────────────────

test('首次启动 = 待初始化：/api/* 一律 401 且明说"还没设密码"', async (t) => {
  const r = await rig(t, { legacyToken: null });
  assert.equal(r.auth.initialized, false);
  assert.equal(existsSync(join(r.dataDir, AUTH_FILE_NAME)), false, '没人设密码就不该有凭据文件');
  assert.equal(existsSync(join(r.dataDir, UI_TOKEN_FILE)), false, '新实例也不该自动生成旧 token');

  for (const path of ['/api/projection', '/api/config', '/api/events', '/api/stats/dashboard']) {
    const res = await call(r.base, path);
    assert.equal(res.status, 401, `${path} 在待初始化态必须是 401`);
    assert.equal(errorOf(res).code, 'auth-uninitialized', `${path} 要说清是"还没设密码"`);
    assert.match(errorOf(res).message, /还没设密码/u);
    assert.match(errorOf(res).message, /界面/u, '要告诉人去哪儿设');
  }
});

test('待初始化态只放行"设置密码"：写命令也进不来（不是只有读端点关门）', async (t) => {
  const r = await rig(t, { legacyToken: null });

  const write = await call(r.base, '/api/commands/wake', {
    method: 'POST', body: { note: '不该落库' },
  });
  assert.equal(write.status, 401);
  assert.equal(errorOf(write).code, 'auth-uninitialized');

  const hook = await call(r.base, '/webhook/test', { method: 'POST', body: { hello: 1 } });
  assert.equal(hook.status, 401, 'webhook 也在同一道闸后面');
  // 但它报的是**自己那句**：这条通道只认专用凭据，与"界面还没设密码"无关（B9）。
  // 生成与轮换的完整口径在 test/webhook-secret.test.ts，这里只钉住"它不共用界面那套错误码"。
  assert.equal(errorOf(hook).code, 'webhook-token-unset');
  assert.match(errorOf(hook).message, /webhook 专用凭据/u);

  assert.deepEqual(await r.readAll(), [], '一条事件都不该落（门没开，谁也没进来）');
});

test('待初始化态：连"设置密码"以外的 auth 端点也不放行（login/logout/password 全 401）', async (t) => {
  const r = await rig(t, { legacyToken: null });

  const login = await call(r.base, '/api/auth/login', { method: 'POST', body: { password: GOOD_PASSWORD } });
  assert.equal(login.status, 401);
  assert.equal(errorOf(login).code, 'auth-uninitialized');

  const logout = await call(r.base, '/api/auth/logout', { method: 'POST', body: {} });
  assert.equal(logout.status, 401);
  assert.equal(errorOf(logout).code, 'auth-uninitialized');

  const change = await call(r.base, '/api/auth/password', {
    method: 'POST', body: { oldPassword: 'x', password: GOOD_PASSWORD },
  });
  assert.equal(change.status, 401);
  assert.equal(errorOf(change).code, 'auth-uninitialized');
});

test('公开状态端点：未初始化时回 false，且不需要任何凭据（也不多给任何事实）', async (t) => {
  const r = await rig(t, { legacyToken: null });

  // 空手问：这是界面在"还没有凭据"那一刻唯一能做的事
  const anon = await call(r.base, '/api/auth/state');
  assert.equal(anon.status, 200, anon.text);
  assert.deepEqual(anon.body, { initialized: false }, '只回答一个布尔，别的一律不给');
  assert.deepEqual(Object.keys(anon.body as object), ['initialized'], '响应体里不许出现凭据、instance、会话条数');

  // 带一张乱写的凭据也一样：这条端点根本不看凭据（不会因为它"错"而 401）
  const withJunk = await call(r.base, '/api/auth/state', { token: 'not-a-session-token' });
  assert.equal(withJunk.status, 200);
  assert.deepEqual(withJunk.body, { initialized: false });

  // 方法不对是 405（"这个地址存在，只是不接受 POST"），不是 404 也不是 401
  const post = await call(r.base, '/api/auth/state', { method: 'POST', body: {} });
  assert.equal(post.status, 405);
  assert.equal(errorOf(post).code, 'method-not-allowed');

  // 它不落事件：问一次状态不是一次"进门/换锁"
  assert.deepEqual(await r.readAll(), []);
});

test('设过密码之后：公开状态端点回 true（错的凭据也不影响它）', async (t) => {
  const r = await rig(t, { legacyToken: null });

  const before = await call(r.base, '/api/auth/state');
  assert.deepEqual(before.body, { initialized: false });

  const setup = await call(r.base, '/api/auth/setup', {
    method: 'POST', body: { password: GOOD_PASSWORD, label: 'gui' },
  });
  assert.equal(setup.status, 200, setup.text);

  const after = await call(r.base, '/api/auth/state');
  assert.equal(after.status, 200);
  assert.deepEqual(after.body, { initialized: true });

  const withJunk = await call(r.base, '/api/auth/state', { token: 'not-a-session-token' });
  assert.equal(withJunk.status, 200, '凭据对不对不影响这条端点：它不看凭据');
  assert.deepEqual(withJunk.body, { initialized: true });
});

test('设置密码：成功即登录（当场给会话），随后 /api/* 立刻可用', async (t) => {
  const r = await rig(t, { legacyToken: null });

  const setup = await call(r.base, '/api/auth/setup', {
    method: 'POST', body: { password: GOOD_PASSWORD, label: 'gui' },
  });
  assert.equal(setup.status, 200, setup.text);
  const token = tokenOf(setup);
  assert.equal(typeof (setup.body as { sessionId: unknown }).sessionId, 'string');
  assert.match(String((setup.body as { instance: unknown }).instance), /^127\.0\.0\.1:\d+#[0-9a-f]{16}$/u);

  const projection = await call(r.base, '/api/projection', { token });
  assert.equal(projection.status, 200, '设完密码就是登录态，不该再让人输一遍');
  const view = projection.body as { lastSeq: number; pending: unknown[] };
  // 唯一那条事件就是这次设密码落下的 auth/password-set 事实
  assert.equal(view.lastSeq, 1);
  assert.deepEqual(view.pending, []);
});

test('设置密码：太短当场 400（不写盘、不签发）', async (t) => {
  const r = await rig(t, { legacyToken: null });

  const short = await call(r.base, '/api/auth/setup', { method: 'POST', body: { password: 'abc' } });
  assert.equal(short.status, 400);
  assert.equal(errorOf(short).code, 'password-too-weak');
  assert.match(errorOf(short).message, new RegExp(`${PASSWORD_MIN_LEN} 位`, 'u'));
  assert.equal(existsSync(join(r.dataDir, AUTH_FILE_NAME)), false, '失败不该留下半份凭据');
  assert.equal(r.auth.initialized, false);
});

test('设置密码：设过之后再设是 409（"重置密码"必须是物理接触那份文件，不能是一个网络请求）', async (t) => {
  const r = await rig(t, { legacyToken: null });
  const first = await call(r.base, '/api/auth/setup', { method: 'POST', body: { password: GOOD_PASSWORD } });
  assert.equal(first.status, 200);

  const again = await call(r.base, '/api/auth/setup', { method: 'POST', body: { password: 'someone-else-pw' } });
  assert.equal(again.status, 409);
  assert.equal(errorOf(again).code, 'already-initialized');
  assert.match(errorOf(again).message, /\.auth\.json/u, '要告诉人恢复路径是删文件重启');

  // 原密码照旧能登（没人被"第二次 setup"顶掉）
  const login = await call(r.base, '/api/auth/login', { method: 'POST', body: { password: GOOD_PASSWORD } });
  assert.equal(login.status, 200);
});

// ──────────────────────────────── ② 凭据文件形状 ────────────────────────────────

test('凭据文件形状：v/scrypt{salt,N,r,p}/hash/sessions，且**明文绝不落盘**', async (t) => {
  const r = await rig(t, { legacyToken: null });
  const setup = await call(r.base, '/api/auth/setup', {
    method: 'POST', body: { password: GOOD_PASSWORD, label: 'gui' },
  });
  const token = tokenOf(setup);

  const file = authFile(r.dataDir);
  assert.equal(file['v'], 1);
  assert.deepEqual(file['scrypt'], {
    salt: (file['scrypt'] as { salt: string }).salt,
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  const salt = (file['scrypt'] as { salt: string }).salt;
  assert.match(salt, new RegExp(`^[0-9a-f]{${SCRYPT_SALT_BYTES * 2}}$`, 'u'), 'salt 是 16 字节 hex');
  assert.match(String(file['hash']), /^[0-9a-f]{64}$/u, 'scrypt 派生键 32 字节 hex');

  const sessions = file['sessions'] as Array<Record<string, unknown>>;
  assert.equal(sessions.length, 1, '设完密码就有一条会话');
  assert.equal(sessions[0]!['label'], 'gui');
  assert.match(String(sessions[0]!['hash']), /^[0-9a-f]{64}$/u, '会话只存 sha256');
  assert.match(String(sessions[0]!['id']), /^[0-9a-f]{16}$/u, 'id 不是密钥，只有 8 字节');

  // 最要紧的一条：整份文件里**一个字面量的密码与会话串**都不许有
  const raw = readFileSync(join(r.dataDir, AUTH_FILE_NAME), 'utf8');
  assert.equal(raw.includes(GOOD_PASSWORD), false, '明文密码绝不落盘');
  assert.equal(raw.includes(token), false, '会话凭据原文绝不落盘');
  assert.equal(raw.includes(Buffer.from(GOOD_PASSWORD).toString('base64')), false);
});

test('凭据文件写入是原子的：不留 .tmp 残骸，JSON 可解析', async (t) => {
  const r = await rig(t, { legacyToken: null });
  await call(r.base, '/api/auth/setup', { method: 'POST', body: { password: GOOD_PASSWORD } });
  const login = await call(r.base, '/api/auth/login', { method: 'POST', body: { password: GOOD_PASSWORD } });
  assert.equal(login.status, 200);

  const { readdirSync } = await import('node:fs');
  const leftovers = readdirSync(r.dataDir).filter((name) => name.includes('.tmp.'));
  assert.deepEqual(leftovers, [], '临时文件必须被 rename 掉，不能留在数据目录里');
  assert.equal((authFile(r.dataDir)['sessions'] as unknown[]).length, 2);
});

test('日志里不出现密码，也不出现完整会话凭据', async (t) => {
  const r = await rig(t, { legacyToken: null });
  const setup = await call(r.base, '/api/auth/setup', { method: 'POST', body: { password: GOOD_PASSWORD } });
  const token = tokenOf(setup);

  const lines = r.printed.join('\n');
  assert.equal(lines.includes(GOOD_PASSWORD), false, '日志里不许有密码');
  assert.equal(lines.includes(token), false, '日志里不许有完整会话凭据');
  assert.match(lines, /已设置密码/u, '但事实要说出来（人得知道门装上了）');

  // 事件日志同理
  const events = await r.readAll();
  const dump = JSON.stringify(events);
  assert.equal(dump.includes(GOOD_PASSWORD), false);
  assert.equal(dump.includes(token), false);
});

// ──────────────────────────────── ③ 登录 ────────────────────────────────

test('登录：对密码签发新会话；错密码 401 bad-password', async (t) => {
  const r = await rig(t, { legacyToken: null });
  await call(r.base, '/api/auth/setup', { method: 'POST', body: { password: GOOD_PASSWORD } });

  const ok = await call(r.base, '/api/auth/login', { method: 'POST', body: { password: GOOD_PASSWORD } });
  assert.equal(ok.status, 200);
  const token = tokenOf(ok);
  const projection = await call(r.base, '/api/projection', { token });
  assert.equal(projection.status, 200);

  const bad = await call(r.base, '/api/auth/login', { method: 'POST', body: { password: 'not-the-password' } });
  assert.equal(bad.status, 401);
  assert.equal(errorOf(bad).code, 'bad-password');
  assert.match(errorOf(bad).message, /密码不对/u);
  assert.equal(errorOf(bad).message.includes(GOOD_PASSWORD), false);

  // 错密码不该把已签发的会话弄坏
  const stillOk = await call(r.base, '/api/projection', { token });
  assert.equal(stillOk.status, 200);
});

test('会话凭据是 32 字节随机（base64url），两条互不相同', async (t) => {
  const r = await rig(t, { legacyToken: null });
  const a = tokenOf(await call(r.base, '/api/auth/setup', { method: 'POST', body: { password: GOOD_PASSWORD } }));
  const b = tokenOf(await call(r.base, '/api/auth/login', { method: 'POST', body: { password: GOOD_PASSWORD } }));

  assert.notEqual(a, b);
  for (const token of [a, b]) {
    assert.equal(Buffer.from(token, 'base64url').length, SESSION_BYTES, '32 字节');
    assert.match(token, /^[A-Za-z0-9_-]+$/u, 'base64url：能进头、能进文件、不带需要转义的字符');
  }
});

test('无凭据 / 错凭据：401 unauthorized，且与"还没设密码"分得开', async (t) => {
  const r = await rig(t, { legacyToken: null });
  await call(r.base, '/api/auth/setup', { method: 'POST', body: { password: GOOD_PASSWORD } });

  const anon = await call(r.base, '/api/projection');
  assert.equal(anon.status, 401);
  assert.equal(errorOf(anon).code, 'unauthorized', '设过密码之后就不该再说"还没设密码"');

  const wrong = await call(r.base, '/api/projection', { token: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
  assert.equal(wrong.status, 401);
  assert.equal(errorOf(wrong).code, 'unauthorized');
  assert.match(errorOf(wrong).message, /重新登录/u);
});

test('会话在重启后仍然有效（凭据在盘上，不在内存里）', async (t) => {
  const r = await rig(t, { legacyToken: null });
  const token = tokenOf(await call(r.base, '/api/auth/setup', { method: 'POST', body: { password: GOOD_PASSWORD } }));

  // 直接拿同一份数据目录新建一个 AuthStore —— 等价于"进程重启后再读一次盘"
  const reopened = store(r.dataDir, () => T0);
  assert.equal(reopened.initialized, true);
  const verdict = reopened.authenticate(token);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ok && verdict.via, 'session');
});

// ──────────────────────────────── ④ 登出 / 改密码 ────────────────────────────────

test('登出：撤销当前会话（之后它 401），别的会话不受影响', async (t) => {
  const r = await rig(t, { legacyToken: null });
  const a = tokenOf(await call(r.base, '/api/auth/setup', { method: 'POST', body: { password: GOOD_PASSWORD } }));
  const b = tokenOf(await call(r.base, '/api/auth/login', { method: 'POST', body: { password: GOOD_PASSWORD } }));

  const out = await call(r.base, '/api/auth/logout', { method: 'POST', token: a, body: {} });
  assert.equal(out.status, 200);

  const after = await call(r.base, '/api/projection', { token: a });
  assert.equal(after.status, 401, '登出的那条会话立刻失效');
  assert.equal(errorOf(after).code, 'unauthorized');

  const other = await call(r.base, '/api/projection', { token: b });
  assert.equal(other.status, 200, '登出只撤自己那一条');
});

test('登出是幂等的：同一条再撤一次也不报错（结果一致就是成功）', async (t) => {
  const r = await rig(t, { legacyToken: null });
  const token = tokenOf(await call(r.base, '/api/auth/setup', { method: 'POST', body: { password: GOOD_PASSWORD } }));
  assert.equal((await call(r.base, '/api/auth/logout', { method: 'POST', token, body: {} })).status, 200);
  // 第二次已经没有这条会话了，Bearer 先被闸拦下来 —— 401 是"你手上这张票已经不作数"，
  // 不是"服务器坏了"，这正是客户端该据此回登录态的信号
  const second = await call(r.base, '/api/auth/logout', { method: 'POST', token, body: {} });
  assert.equal(second.status, 401);
});

test('改密码：旧密码必须对；成功后**全部旧会话失效**，并当场给一条新会话', async (t) => {
  const r = await rig(t, { legacyToken: null });
  const tokenA = tokenOf(await call(r.base, '/api/auth/setup', { method: 'POST', body: { password: GOOD_PASSWORD } }));
  const tokenB = tokenOf(await call(r.base, '/api/auth/login', { method: 'POST', body: { password: GOOD_PASSWORD } }));

  const wrongOld = await call(r.base, '/api/auth/password', {
    method: 'POST', token: tokenA, body: { oldPassword: 'nope', password: 'brand-new-password' },
  });
  assert.equal(wrongOld.status, 401);
  assert.equal(errorOf(wrongOld).code, 'bad-password');
  // 失败不改任何东西
  assert.equal((await call(r.base, '/api/projection', { token: tokenA })).status, 200);

  const changed = await call(r.base, '/api/auth/password', {
    method: 'POST', token: tokenA, body: { oldPassword: GOOD_PASSWORD, password: 'brand-new-password' },
  });
  assert.equal(changed.status, 200, changed.text);
  const tokenC = tokenOf(changed);
  assert.notEqual(tokenC, tokenA);

  for (const [name, token] of [['A', tokenA], ['B', tokenB]] as const) {
    const res = await call(r.base, '/api/projection', { token });
    assert.equal(res.status, 401, `旧会话 ${name} 必须失效（"改密码 → 所有会话失效"）`);
  }
  assert.equal((await call(r.base, '/api/projection', { token: tokenC })).status, 200, '新会话当场可用');

  // 新密码能登、旧密码不能
  assert.equal(
    (await call(r.base, '/api/auth/login', { method: 'POST', body: { password: 'brand-new-password' } })).status,
    200,
  );
  assert.equal(
    (await call(r.base, '/api/auth/login', { method: 'POST', body: { password: GOOD_PASSWORD } })).status,
    401,
  );
});

test('改密码会落一条 auth/password-set 事实（action=change、失效了几条会话）', async (t) => {
  const r = await rig(t, { legacyToken: null });
  const token = tokenOf(await call(r.base, '/api/auth/setup', { method: 'POST', body: { password: GOOD_PASSWORD } }));
  await call(r.base, '/api/auth/login', { method: 'POST', body: { password: GOOD_PASSWORD } });
  await call(r.base, '/api/auth/password', {
    method: 'POST', token, body: { oldPassword: GOOD_PASSWORD, password: 'another-good-password', label: 'gui' },
  });

  const changes = (await r.readAll()).filter((event) => event.type === 'auth/password-set');
  assert.equal(changes.length, 2, '设一次 + 改一次，两条事实');
  const first = changes[0]!.data as { action: string; by: string; sessionsRevoked: number };
  const second = changes[1]!.data as { action: string; by: string; sessionsRevoked: number };
  assert.equal(first.action, 'setup');
  assert.equal(second.action, 'change');
  assert.equal(second.by, 'gui');
  assert.equal(second.sessionsRevoked, 2, '改密码前有两条会话，都被踢掉');

  // internal：这是本机的运维事实，不该占她的上下文
  assert.equal(changes[0]!.visibility, 'internal');
});

// ──────────────────────────────── ⑤ 退避 ────────────────────────────────

test('退避的时间表：第 1 次不罚，之后 500→1s→2s→4s→8s 封顶', async (t) => {
  const dir = tempDirSync('irmia-backoff-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // 睡眠被换成记账函数：被测的是**时间表**，不是"真的睡了多久"（那既慢又不准）
  const waits: number[] = [];
  const s = new AuthStore({
    dataDir: dir,
    now: () => T0,
    legacyToken: null,
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  await s.setup(GOOD_PASSWORD);

  for (let attempt = 0; attempt < 8; attempt++) await s.login('definitely-wrong');

  assert.deepEqual(
    waits,
    [0, 0, 500, 1000, 2000, 4000, 8000, 8000],
    '每一次"验之前先等多久"：第 1、2 次不罚（打错一次是人之常情），之后指数增长、8 秒封顶',
  );
  assert.equal(s.backoffMs(), BACKOFF_MAX_MS);
});

test('退避：不硬锁 —— 成功一次清零，停手够久也清零（否则任何人失败 N 次就能把用户关在门外）', async (t) => {
  const dir = tempDirSync('irmia-backoff-decay-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let nowMs = T0.getTime();
  const s = new AuthStore({
    dataDir: dir,
    now: () => new Date(nowMs),
    legacyToken: null,
    wait: async () => {},
  });
  await s.setup(GOOD_PASSWORD);

  for (let i = 0; i < 6; i++) await s.login('wrong-again');
  assert.equal(s.backoffMs(), BACKOFF_MAX_MS, '连到封顶');

  // ① 正确密码照样能进（退避只是"慢一点"，从来不是"进不来"）
  const good = await s.login(GOOD_PASSWORD);
  assert.equal(good.ok, true, '退避不能变成"猜错几次就永久锁死"');
  assert.equal(s.backoffMs(), 0, '成功一次清零');

  // ② 停手够久也清零：攻击者一停手就得从头爬一遍指数
  for (let i = 0; i < 6; i++) await s.login('wrong-again');
  assert.equal(s.backoffMs(), BACKOFF_MAX_MS);
  nowMs += 10 * 60_000; // 超过 BACKOFF_DECAY_MS（5 分钟）
  assert.equal(s.backoffMs(), 0, '停手足够久，计数清零');
});

test('退避：登录失败会带上 retry-after（人要知道"还要等几秒"，而不是对着转圈猜）', async (t) => {
  const r = await rig(t, { legacyToken: null });
  await call(r.base, '/api/auth/setup', { method: 'POST', body: { password: GOOD_PASSWORD } });

  const first = await call(r.base, '/api/auth/login', { method: 'POST', body: { password: 'wrong-1' } });
  assert.equal(first.status, 401);
  assert.equal(Number(first.headers.get('retry-after')), 0, '第 1 次失败不罚（0.5s 向上取整前是 0）');

  const second = await call(r.base, '/api/auth/login', { method: 'POST', body: { password: 'wrong-2' } });
  assert.equal(second.status, 401);
  assert.equal(Number(second.headers.get('retry-after')), 1, '第 2 次失败起告诉人还要等 1 秒');
  assert.equal(errorOf(second).message.includes('scrypt'), false, '不泄露实现细节');
});

// ──────────────────────────────── ⑥ 迁移与回退 ────────────────────────────────

test('迁移：设密码之前，老实例的 data/.ui-token 照旧能进 /api/*', async (t) => {
  const r = await rig(t, { legacyToken: LEGACY_TOKEN });
  assert.equal(r.auth.legacyTokenActive, true);

  const res = await call(r.base, '/api/projection', { token: LEGACY_TOKEN });
  assert.equal(res.status, 200, '升级完立刻打开界面不该进不去');

  const wrong = await call(r.base, '/api/projection', { token: 'not-the-legacy-token-0000' });
  assert.equal(wrong.status, 401);
});

test('迁移：设完密码 → 旧 token 当场作废（401），文件从盘上删掉，并落一条事实事件', async (t) => {
  const r = await rig(t, { legacyToken: LEGACY_TOKEN });

  const setup = await call(r.base, '/api/auth/setup', {
    method: 'POST', body: { password: GOOD_PASSWORD, label: 'gui' },
  });
  assert.equal(setup.status, 200);
  const session = tokenOf(setup);

  const old = await call(r.base, '/api/projection', { token: LEGACY_TOKEN });
  assert.equal(old.status, 401, '设完密码后旧 token 必须作废');
  assert.equal(errorOf(old).code, 'unauthorized');

  assert.equal(existsSync(join(r.dataDir, UI_TOKEN_FILE)), false, '不再是有效的秘密，就不该留在盘上');
  assert.equal(r.auth.legacyTokenActive, false);

  // 会话照旧能用（作废的是旧 token，不是把人也一起关出去）
  assert.equal((await call(r.base, '/api/projection', { token: session })).status, 200);

  const events = (await r.readAll()).filter((event) => event.type === 'auth/password-set');
  assert.equal(events.length, 1);
  const data = events[0]!.data as { action: string; by: string; legacyTokenDisabled: boolean };
  assert.equal(data.action, 'setup');
  assert.equal(data.by, 'gui');
  assert.equal(data.legacyTokenDisabled, true, '这条事实必须写下来：旧 token 已停用');
});

test('迁移：旧 token 不是"会话"，所以它撤不了也改不了密码（如实 409，不假装成功）', async (t) => {
  const r = await rig(t, { legacyToken: LEGACY_TOKEN });

  const logout = await call(r.base, '/api/auth/logout', { method: 'POST', token: LEGACY_TOKEN, body: {} });
  assert.equal(logout.status, 409);
  assert.equal(errorOf(logout).code, 'legacy-token');

  const change = await call(r.base, '/api/auth/password', {
    method: 'POST', token: LEGACY_TOKEN, body: { oldPassword: LEGACY_TOKEN, password: 'new-password-here' },
  });
  assert.equal(change.status, 409);
  assert.equal(errorOf(change).code, 'legacy-token');
  assert.equal(r.auth.initialized, false, '一次都没真改');
});

test('迁移：启动时发现"已设密码 + 旧 token 还在"，就把旧 token 作废（不留两条能进的路）', async (t) => {
  const dir = tempDirSync('irmia-legacy-boot-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, UI_TOKEN_FILE), `${LEGACY_TOKEN}\n`, 'utf8');

  const first = new AuthStore({ dataDir: dir, now: () => T0 });
  await first.setup(GOOD_PASSWORD);

  // 手工把旧 token 文件放回去（模拟"有人从备份里恢复了一份"）
  writeFileSync(join(dir, UI_TOKEN_FILE), `${LEGACY_TOKEN}\n`, 'utf8');
  const second = new AuthStore({ dataDir: dir, now: () => T0 });
  assert.equal(second.initialized, true);
  assert.equal(second.legacyTokenActive, false, '启动时就该把那条路掐掉');
  assert.equal(second.authenticate(LEGACY_TOKEN).ok, false);
  assert.equal(existsSync(join(dir, UI_TOKEN_FILE)), false);
});

// ──────────────────────────────── ⑦ 凭据文件坏掉怎么办 ────────────────────────────────

test('凭据文件读不懂 → 按"还没设密码"处理（恢复路径就是删文件重启，不能把人永久锁在外）', async (t) => {
  const dir = tempDirSync('irmia-broken-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  for (const broken of ['{ not json', '[]', '{"v":2}', '{"v":1}', '{"v":1,"scrypt":{},"hash":""}']) {
    writeFileSync(join(dir, AUTH_FILE_NAME), broken, 'utf8');
    const lines: string[] = [];
    const s = new AuthStore({ dataDir: dir, now: () => T0, out: (line) => lines.push(line) });
    assert.equal(s.initialized, false, `${broken} 应被当成"还没设密码"`);
    assert.equal(s.authenticate('anything').ok, false);
    assert.ok(lines.length >= 1, '事实要说出来，不能静默吞掉');
  }

  // 坏文件能被一次新的 setup 覆盖掉（人重新设一次密码就恢复）
  const s = new AuthStore({ dataDir: dir, now: () => T0 });
  const result = await s.setup(GOOD_PASSWORD);
  assert.equal(result.ok, true);
  assert.equal(new AuthStore({ dataDir: dir, now: () => T0 }).initialized, true);
});

test('凭据文件里的 scrypt 参数被校验过范围（防"改一份 JSON 就把下次登录打死"）', async (t) => {
  const dir = tempDirSync('irmia-params-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const evil = [
    { N: 1 << 26, r: 8, p: 1 },  // 内存炸弹：N 大得离谱
    { N: 3, r: 8, p: 1 },        // N 不是 2 的幂
    { N: 16_384, r: 0, p: 1 },   // r 非法
    { N: 16_384, r: 8, p: 999 }, // p 非法
  ];
  for (const params of evil) {
    writeFileSync(join(dir, AUTH_FILE_NAME), JSON.stringify({
      v: 1, scrypt: { salt: 'ab'.repeat(16), ...params }, hash: 'cd'.repeat(32), sessions: [],
    }), 'utf8');
    const s = new AuthStore({ dataDir: dir, now: () => T0, out: () => undefined });
    assert.equal(s.initialized, false, `${JSON.stringify(params)} 必须被拒`);
  }
});

test('坏会话逐条丢弃，不让一条脏数据把用户挡在门外', async (t) => {
  const dir = tempDirSync('irmia-badsession-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = new AuthStore({ dataDir: dir, now: () => T0, legacyToken: null });
  const issued = await s.setup(GOOD_PASSWORD);
  assert.equal(issued.ok, true);
  const token = issued.ok ? issued.token : '';

  // 往 sessions 里塞三条脏数据，把好会话挤到中间
  const file = JSON.parse(readFileSync(join(dir, AUTH_FILE_NAME), 'utf8')) as { sessions: unknown[] };
  const good = file.sessions[0];
  file.sessions = [null, 'nope', { id: 'x' }, good, { id: '', hash: '', createdAt: '' }];
  writeFileSync(join(dir, AUTH_FILE_NAME), JSON.stringify(file), 'utf8');

  const reopened = new AuthStore({ dataDir: dir, now: () => T0, legacyToken: null });
  assert.equal(reopened.initialized, true);
  assert.equal(reopened.sessionCount, 1, '只留下形状正确的那一条');
  assert.equal(reopened.authenticate(token).ok, true, '好会话照旧能用');
});

test('会话数有上限：越登越多会被 FIFO 淘汰（长期无人值守不该越攒越厚）', async (t) => {
  const dir = tempDirSync('irmia-sessioncap-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = new AuthStore({ dataDir: dir, now: () => T0, legacyToken: null });
  const first = await s.setup(GOOD_PASSWORD);
  const firstToken = first.ok ? first.token : '';

  let last = '';
  for (let i = 0; i < 60; i++) {
    const issued = await s.login(GOOD_PASSWORD, `client-${i}`);
    assert.equal(issued.ok, true);
    last = issued.ok ? issued.token : '';
  }
  assert.ok(s.sessionCount <= 32, `会话数应被夹住，实际 ${s.sessionCount}`);
  assert.equal(s.authenticate(last).ok, true, '最新那条一定在');
  assert.equal(s.authenticate(firstToken).ok, false, '最老的被淘汰');
});

// ──────────────────────────────── ⑧ 密码强度的口径 ────────────────────────────────

test('passwordProblem 的口径：太短/太长/全空白都要说人话', () => {
  assert.equal(passwordProblem(GOOD_PASSWORD), null);
  assert.match(String(passwordProblem('abc')), /至少 6 位/u);
  assert.match(String(passwordProblem('x'.repeat(500))), /最长 200 位/u);
  assert.match(String(passwordProblem('      ')), /空白/u);
  assert.equal(passwordProblem('123456'), null, '本地门锁不搞复杂度花活：长度是唯一硬指标');
});
