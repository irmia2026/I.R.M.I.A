/**
 * webhook 专用凭据测试 — src/web/webhook-secret.ts + `src/web/server.ts` 的 `/webhook/*` 与
 * `POST /api/commands/regenerate-webhook-token`（B9，2026-10）
 *
 * 这一项要解决的事只有一句话：**外部系统投东西时，不该拿一份界面会话凭据**。所以这份文件
 * 逐条钉死"谁认哪条通道"，而不是只测"能不能投递"：
 *
 *   ① 专用凭据能投递（落 `wake/webhook`，敏感头照旧抹掉）；
 *   ② 它**只够投递**：拿它打 `/api/*` 一律 401（最小权限的方向是单向的）；
 *   ③ 会话凭据对 `/webhook/*` 是 401 —— 收窄生效（迁移期那份 `.ui-token` 同样不放行）；
 *   ④ 轮换：新值可用、**旧值当场 401**，并落一条 `auth/webhook-token-rotated` 事实；
 *   ⑤ 盘上只有 sha256：明文 token 与哈希都不出现在事件、诊断输出与凭据文件里（除了哈希本身）；
 *   ⑥ 没生成过时 `/webhook/*` **一律 401**（不自动生成，也绝不"先放行"）；
 *   ⑦ 生成是一次危险操作（X-Confirm 短语 = 命令名），且状态读端点只报"配没配"，不吐凭据。
 *
 * 两条纪律照 web-auth.test.ts：一个用例一个独立临时目录；断言首选"盘上/日志里有什么"，
 * 其次才是响应体——HTTP 层只是通道。
 */

import assert from 'node:assert/strict';
import { createHash, scryptSync } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { emptyProjection, type AppEvent } from '../src/log/types.ts';
import { ensurePersonaSeeds } from '../src/persona/loader.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { AUTH_FILE_NAME, SCRYPT_PARAMS, UI_TOKEN_FILE } from '../src/web/auth.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';
import {
  WEBHOOK_SECRET_BYTES, WEBHOOK_SECRET_FILE_NAME, WebhookSecretStore,
} from '../src/web/webhook-secret.ts';
import { registerTempDir, tempDirSync } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const T0 = new Date('2026-02-14T10:00:00.000Z');
const SESSION_TOKEN = 'ui-session-token-0123456789abcdef';
const LEGACY_TOKEN = 'legacy-token-0123456789abcdef';
const PASSWORD = 'irmia-local-pw';

/** 整份文件共用一次 scrypt：夹具的差别只在数据目录，凭据形状完全一样（同 web-server.test.ts） */
const SALT = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const HASH = scryptSync(PASSWORD, SALT, 32, {
  N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p,
}).toString('hex');

/** 铺一份"已经设过密码 + 有一条已知会话"的凭据文件（形状同 web/auth.ts 的 AuthFileV1） */
function seedAuthFile(dataDir: string): void {
  writeFileSync(join(dataDir, AUTH_FILE_NAME), `${JSON.stringify({
    v: 1,
    scrypt: { salt: SALT.toString('hex'), ...SCRYPT_PARAMS },
    hash: HASH,
    sessions: [{
      id: 'aabbccddeeff0011',
      hash: createHash('sha256').update(SESSION_TOKEN, 'utf8').digest('hex'),
      createdAt: T0.toISOString(),
      label: 'test',
    }],
  }, null, 2)}\n`, 'utf8');
}

interface Rig {
  dir: string;
  dataDir: string;
  server: WebServer;
  base: string;
  /** 界面会话凭据（有效）：它在这条通道上必须被拒 */
  session: string;
  printed: string[];
  secretFile(): string;
  readAll(): Promise<AppEvent[]>;
}

async function rig(
  t: TestContext,
  options: {
    legacyToken?: string | null;
    webhookRate?: { capacity: number; refillPerSec: number };
    /** false = 不铺凭据文件（老实例迁移期：还没设密码，只有那份 `.ui-token`） */
    password?: boolean;
  } = {},
): Promise<Rig> {
  const dir = tempDirSync('irmia-hooksecret-');
  const dataDir = join(dir, 'data');
  ensurePersonaSeeds(dataDir);
  if (options.password !== false) seedAuthFile(dataDir);
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
    // 默认"这个实例没有旧 token"：迁移期那条路单独立案（下面 `.ui-token` 那一条）
    uiToken: options.legacyToken === undefined ? null : options.legacyToken,
    port: 0,
    out: (line) => printed.push(line),
    ...(options.webhookRate !== undefined ? { webhookRate: options.webhookRate } : {}),
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
    server,
    base: server.url(),
    session: SESSION_TOKEN,
    printed,
    secretFile: () => join(dataDir, WEBHOOK_SECRET_FILE_NAME),
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
  input: { method?: string; body?: unknown; token?: string | null; confirm?: string | null } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (input.token !== null && input.token !== undefined) headers['authorization'] = `Bearer ${input.token}`;
  if (input.confirm !== null && input.confirm !== undefined) headers['x-confirm'] = input.confirm;
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

/** 走命令生成一份凭据（这是"人按一次生成"的那条路），返回明文与元数据 */
async function mint(
  r: Rig,
  options: { token?: string; confirm?: string | null } = {},
): Promise<{ token: string; secretId: string; action: string; note: string; res: Res }> {
  const res = await call(r.base, '/api/commands/regenerate-webhook-token', {
    method: 'POST',
    token: options.token ?? r.session,
    confirm: options.confirm === undefined ? 'regenerate-webhook-token' : options.confirm,
    body: { by: 'test' },
  });
  assert.equal(res.status, 200, res.text);
  const body = res.body as { token?: unknown; secretId?: unknown; action?: unknown; note?: unknown };
  assert.equal(typeof body.token, 'string', '响应里必须带一次性明文');
  return {
    token: body.token as string,
    secretId: String(body.secretId),
    action: String(body.action),
    note: String(body.note),
    res,
  };
}

function post(r: Rig, path: string, token: string | null, body: unknown = { hello: 'world' }): Promise<Res> {
  return call(r.base, path, { method: 'POST', token, body });
}

// ──────────────────────────────── ① 生成与投递 ────────────────────────────────

test('生成专用凭据：明文只回一次，盘上只有 sha256 与一个非密钥 id', async (t) => {
  const r = await rig(t);
  assert.equal(existsSync(r.secretFile()), false, '没人要之前不该凭空多一个秘密文件');

  const minted = await mint(r);
  assert.equal(minted.action, 'generate');
  assert.match(minted.token, /^[A-Za-z0-9_-]+$/u, 'base64url：能进头、能进配置文件');
  assert.equal(Buffer.from(minted.token, 'base64url').length, WEBHOOK_SECRET_BYTES, '32 字节随机');

  const raw = readFileSync(r.secretFile(), 'utf8');
  const file = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(file['v'], 1);
  assert.equal(file['hash'], createHash('sha256').update(minted.token, 'utf8').digest('hex'), '盘上只有 sha256');
  assert.equal(file['id'], minted.secretId);
  assert.equal(file['rotatedAt'], null, '首次生成没有"被轮换"这回事');
  assert.match(String(file['id']), /^[0-9a-f]{16}$/u, 'id 不是密钥，只有 8 字节');
  assert.equal(raw.includes(minted.token), false, '明文绝不落盘');
  assert.equal(raw.includes(Buffer.from(minted.token).toString('base64')), false);

  // 明文也不许出现在诊断输出与事件里
  const dump = JSON.stringify(await r.readAll());
  assert.equal(r.printed.join('\n').includes(minted.token), false, '明文不进诊断输出');
  assert.equal(dump.includes(minted.token), false, '明文不进事件日志');
});

test('专用凭据能投递：落 wake/webhook，敏感头照旧抹掉', async (t) => {
  const r = await rig(t);
  const minted = await mint(r);

  const res = await post(r, '/webhook/deploy', minted.token, { event: 'deploy' });
  assert.equal(res.status, 200, res.text);
  assert.equal((res.body as { type: string }).type, 'wake/webhook');

  const events = await r.readAll();
  const hooks = events.filter((event) => event.type === 'wake/webhook');
  assert.equal(hooks.length, 1);
  const data = hooks[0]!.data as { path: string; headers: Record<string, string> };
  assert.equal(data.path, '/webhook/deploy');
  assert.equal(data.headers['authorization'], '[redacted]', '密钥不落日志（这条对专用凭据同样成立）');
  assert.equal(hooks[0]!.visibility, 'model');
});

test('生成是一条危险操作：X-Confirm 短语就是命令名，缺了当场 400', async (t) => {
  const r = await rig(t);

  const missing = await call(r.base, '/api/commands/regenerate-webhook-token', {
    method: 'POST', token: r.session, body: {},
  });
  assert.equal(missing.status, 400);
  assert.equal(errorOf(missing).code, 'confirm-required');
  assert.match(errorOf(missing).message, /regenerate-webhook-token/u);
  assert.equal(existsSync(r.secretFile()), false, '没点头就不该生成任何东西');

  const wrong = await call(r.base, '/api/commands/regenerate-webhook-token', {
    method: 'POST', token: r.session, confirm: 'set-key', body: {},
  });
  assert.equal(wrong.status, 400);
  assert.equal(existsSync(r.secretFile()), false);
});

test('状态读端点只报"配没配"，不吐凭据（界面靠它决定按钮写"生成"还是"重新生成"）', async (t) => {
  const r = await rig(t);

  const before = await call(r.base, '/api/webhook-secret', { token: r.session });
  assert.equal(before.status, 200);
  const b = before.body as Record<string, unknown>;
  assert.equal(b['configured'], false);
  assert.equal(b['secretId'], null);
  assert.equal(b['channel'], '/webhook/*');
  assert.match(String(b['file']), /\.webhook-secret\.json$/u);

  const minted = await mint(r);
  const after = await call(r.base, '/api/webhook-secret', { token: r.session });
  const a = after.body as Record<string, unknown>;
  assert.equal(a['configured'], true);
  assert.equal(a['secretId'], minted.secretId);
  assert.equal(a['createdAt'], T0.toISOString());
  assert.equal(after.text.includes(minted.token), false, '读端点绝不吐明文');
  assert.equal(after.text.includes(String((JSON.parse(readFileSync(r.secretFile(), 'utf8')) as { hash: string }).hash)), false, '也不吐哈希');
  assert.equal(/hash/u.test(after.text), false, '响应里连 hash 这个字段名都不该有');

  // 没认证的话它照样在门后面（与 /api/keys 同级）
  const anon = await call(r.base, '/api/webhook-secret', { token: null });
  assert.equal(anon.status, 401);
  assert.equal(errorOf(anon).code, 'unauthorized');
});

// ──────────────────────────────── ② 它只够投递 ────────────────────────────────

test('专用凭据对 /api/* 一律 401：最小权限的方向是单向的', async (t) => {
  const r = await rig(t);
  const minted = await mint(r);

  for (const path of ['/api/projection', '/api/config', '/api/events', '/api/webhook-secret']) {
    const res = await call(r.base, path, { token: minted.token });
    assert.equal(res.status, 401, `${path} 不该认 webhook 凭据`);
    assert.equal(errorOf(res).code, 'unauthorized');
    assert.equal(res.text.includes(minted.token), false);
  }

  // 写命令同样进不来（它连"读"都不够，更不谈"写"）
  const write = await call(r.base, '/api/commands/wake', {
    method: 'POST', token: minted.token, body: { note: '不该落库' },
  });
  assert.equal(write.status, 401);
  assert.deepEqual(
    (await r.readAll()).filter((event) => event.type === 'wake/manual'),
    [],
    '没落任何 wake/manual',
  );
});

// ──────────────────────────────── ③ 收窄：会话凭据不再放行 ────────────────────────────────

test('会话凭据对 /webhook/* 是 401（收窄生效），响应里说清"从今天起只认专用凭据"', async (t) => {
  const r = await rig(t);

  // 还没生成过：仍然 401，并且顺手点破"你带的是一条有效的界面会话凭据"
  const early = await post(r, '/webhook/deploy', r.session);
  assert.equal(early.status, 401);
  assert.equal(errorOf(early).code, 'webhook-token-unset');
  assert.match(errorOf(early).message, /有效的界面会话凭据/u);
  assert.match(errorOf(early).message, /只认 webhook 专用凭据/u);
  assert.match(errorOf(early).message, /regenerate-webhook-token/u, '要告诉人新凭据去哪儿拿');
  assert.deepEqual((await r.readAll()).filter((event) => event.type === 'wake/webhook'), [], '一条都不该落');

  // 生成一份之后，会话凭据照旧进不来（不是"生成前才拦"）
  await mint(r);
  const res = await post(r, '/webhook/deploy', r.session);
  assert.equal(res.status, 401);
  assert.equal(errorOf(res).code, 'unauthorized');
  assert.match(errorOf(res).message, /只认 webhook 专用凭据/u);
  assert.match(errorOf(res).message, /界面会话凭据/u);
  assert.match(errorOf(res).message, /data\/\.ui-token/u);

  // 诊断输出里认得出"这是界面会话凭据"——收窄之后最典型的现场就是老脚本还没换
  const lines = r.printed.join('\n');
  assert.match(lines, /\[webhook\] 拒绝/u);
  assert.match(lines, /有效的界面会话凭据/u);
  assert.equal(lines.includes(r.session), false, '凭据原文不进日志');
});

test('迁移期那份 data/.ui-token 同样不再放行 /webhook/*（它只够界面那条路）', async (t) => {
  // 老实例：还没设密码，手上只有那份 `.ui-token`（铺了凭据文件的话它当场就被作废了，见 auth.ts）
  const r = await rig(t, { legacyToken: LEGACY_TOKEN, password: false });

  // 迁移期：它照旧能进 /api/*（升级完打开界面不该进不去）
  const api = await call(r.base, '/api/projection', { token: LEGACY_TOKEN });
  assert.equal(api.status, 200);

  // 但 webhook 这条通道不认它
  const hook = await post(r, '/webhook/test', LEGACY_TOKEN);
  assert.equal(hook.status, 401);
  assert.equal(errorOf(hook).code, 'webhook-token-unset');
  assert.match(errorOf(hook).message, /data\/\.ui-token/u);

  // 迁移期的实例照样能生成专用凭据（还没设密码时 /api/* 认的就是旧 token），
  // 生成之后旧 token 依旧打不通 webhook —— 收窄不是"生成前才拦"
  const minted = await mint(r, { token: LEGACY_TOKEN });
  const after = await post(r, '/webhook/test', LEGACY_TOKEN);
  assert.equal(after.status, 401);
  assert.equal(errorOf(after).code, 'unauthorized');
  assert.equal((await post(r, '/webhook/test', minted.token)).status, 200, '专用凭据可用');
});

// ──────────────────────────────── ④ 轮换 ────────────────────────────────

test('轮换：新值可用、旧值当场 401（带上"上一份"这条线索），并落一条事实事件', async (t) => {
  const r = await rig(t);
  const first = await mint(r);
  assert.equal((await post(r, '/webhook/a', first.token)).status, 200);

  const second = await mint(r);
  assert.equal(second.action, 'rotate');
  assert.notEqual(second.token, first.token);
  assert.equal((second.res.body as { previousSecretId: string }).previousSecretId, first.secretId);

  const old = await post(r, '/webhook/a', first.token, { hello: 'old' });
  assert.equal(old.status, 401, '旧值当场失效');
  assert.equal(errorOf(old).code, 'unauthorized');
  assert.match(errorOf(old).message, /上一份/u, '要说出"你带的是刚被换掉的那份"，这是最有用的线索');

  assert.equal((await post(r, '/webhook/a', second.token, { hello: 'new' })).status, 200, '新值立即可用');

  // 盘上只剩新那份的哈希
  const file = JSON.parse(readFileSync(r.secretFile(), 'utf8')) as Record<string, unknown>;
  assert.equal(file['hash'], createHash('sha256').update(second.token, 'utf8').digest('hex'));
  assert.equal(file['rotatedAt'], T0.toISOString());
  assert.equal(readFileSync(r.secretFile(), 'utf8').includes(first.token), false, '旧明文从盘上消失');

  // 两条事实：generate + rotate
  const rotated = (await r.readAll()).filter((event) => event.type === 'auth/webhook-token-rotated');
  assert.equal(rotated.length, 2);
  const a = rotated[0]!.data as Record<string, unknown>;
  const b = rotated[1]!.data as Record<string, unknown>;
  assert.equal(a['action'], 'generate');
  assert.equal(a['previousSecretId'], null);
  assert.equal(b['action'], 'rotate');
  assert.equal(b['by'], 'test');
  assert.equal(b['previousSecretId'], first.secretId);
  assert.equal(b['secretId'], second.secretId);
  assert.equal(rotated[0]!.visibility, 'internal', '本机的运维事实，不该占她的上下文');
  assert.deepEqual(Object.keys(a).sort(), ['action', 'by', 'previousSecretId', 'secretId'], '事件里不带任何凭据字段');
});

test('轮换不靠重启：换完这一秒旧的就不认，新的一直认（内存与盘上同一份）', async (t) => {
  const r = await rig(t);
  const first = await mint(r);
  const second = await mint(r);

  // 旧进程内存里那份也换了 —— 不是"重启后才生效"
  assert.equal(r.server.webhookSecret.authenticate(first.token).ok, false);
  assert.equal(r.server.webhookSecret.authenticate(second.token).ok, true);
  // 而重新读盘（等价于重启）得到同一份结论
  const reopened = new WebhookSecretStore({ dataDir: r.dataDir, now: () => T0 });
  assert.equal(reopened.authenticate(first.token).ok, false);
  assert.equal(reopened.authenticate(second.token).ok, true);
});

// ──────────────────────────────── ⑤ 没生成过 = 一律 401 ────────────────────────────────

test('从没生成过：/webhook/* 一律 401（不自动生成，也不"先放行"）', async (t) => {
  const r = await rig(t);

  const anon = await post(r, '/webhook/test', null);
  assert.equal(anon.status, 401);
  assert.equal(errorOf(anon).code, 'webhook-token-unset');
  assert.match(errorOf(anon).message, /还没有生成 webhook 专用凭据/u);
  assert.match(errorOf(anon).message, /regenerate-webhook-token/u);

  // 随便给一个凭据也一样（这时候没有任何东西是对的）
  for (const bogus of [r.session, 'whatever-0123456789', '']) {
    const res = await post(r, '/webhook/test', bogus === '' ? null : bogus);
    assert.equal(res.status, 401);
  }
  assert.deepEqual((await r.readAll()).filter((event) => event.type === 'wake/webhook'), []);
  assert.equal(existsSync(r.secretFile()), false, '服务端绝不自动生成');
});

test('认证排在最前面：桶是空的也只回 401，而不是 429（未认证的请求不该消耗共享资源）', async (t) => {
  const r = await rig(t, { webhookRate: { capacity: 0, refillPerSec: 0 } });

  // 桶容量 0 = 任何请求都拿不到令牌；未认证的请求必须在碰桶之前就被拦下
  const anon = await post(r, '/webhook/a', null);
  assert.equal(anon.status, 401, '认证先于限流');
  const wrong = await post(r, '/webhook/a', 'not-the-token');
  assert.equal(wrong.status, 401);

  // 而一条**合法**的凭据会走到桶那一步，于是照实 429 —— 反过来说明桶是真在用的
  const minted = await mint(r);
  const limited = await post(r, '/webhook/a', minted.token);
  assert.equal(limited.status, 429);
  assert.equal(errorOf(limited).code, 'rate-limited');

  // 认证也先于 body 读取：带一个超限 body 的未认证请求回 401，而不是 413
  const big = await call(r.base, '/webhook/big', {
    method: 'POST', token: 'not-the-token', body: { pad: 'x'.repeat(70 * 1024) },
  });
  assert.equal(big.status, 401, '连 body 都不该被读进来');
  assert.equal(errorOf(big).code, 'unauthorized');
});

// ──────────────────────────────── ⑥ 凭据库本身（直连，不起 HTTP） ────────────────────────────────

test('凭据库：从没生成过 = unconfigured；空串与错值分得开', async (t) => {
  const dir = tempDirSync('irmia-hookstore-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new WebhookSecretStore({ dataDir: dir, now: () => T0 });

  assert.equal(store.configured, false);
  assert.equal(store.secretId, null);
  assert.equal(store.view().configured, false);
  assert.deepEqual(store.authenticate('anything'), { ok: false, reason: 'unconfigured' });

  const rotated = store.rotate('cli');
  assert.equal(rotated.ok, true);
  const token = rotated.ok ? rotated.token : '';
  assert.equal(store.configured, true);
  assert.deepEqual(store.authenticate(token), { ok: true, secretId: store.secretId });
  assert.deepEqual(store.authenticate(''), { ok: false, reason: 'missing' });
  assert.deepEqual(store.authenticate('   '), { ok: false, reason: 'missing' });
  assert.deepEqual(store.authenticate('not-the-token'), { ok: false, reason: 'invalid' });

  // 轮换之后，旧值认得出是"上一份"——但绝不放行
  const next = store.rotate();
  assert.equal(next.ok, true);
  const nextToken = next.ok ? next.token : '';
  assert.deepEqual(store.authenticate(token), { ok: false, reason: 'previous' });
  assert.deepEqual(store.authenticate(nextToken), { ok: true, secretId: store.secretId });
  // 上一份的哈希不落盘：删掉文件重启之后，那个线索就没了（它本来只是条日志线索）
  assert.equal(readFileSync(store.path, 'utf8').includes(token), false);
});

test('凭据库：文件读不懂按"还没生成"处理，但事实要说出来', async (t) => {
  const dir = tempDirSync('irmia-hookbroken-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  for (const broken of ['{ not json', '[]', '{"v":2}', '{"v":1}', '{"v":1,"id":"","hash":"x","createdAt":"t"}']) {
    writeFileSync(join(dir, WEBHOOK_SECRET_FILE_NAME), broken, 'utf8');
    const lines: string[] = [];
    const store = new WebhookSecretStore({ dataDir: dir, now: () => T0, out: (line) => lines.push(line) });
    assert.equal(store.configured, false, `${broken} 应被当成"还没生成"`);
    assert.equal(store.authenticate('anything').ok, false);
    assert.ok(lines.length >= 1, '事实要说出来，不能静默吞掉');
  }

  // 坏文件能被一次生成覆盖掉
  const store = new WebhookSecretStore({ dataDir: dir, now: () => T0 });
  const result = store.rotate();
  assert.equal(result.ok, true);
  assert.equal(new WebhookSecretStore({ dataDir: dir, now: () => T0 }).configured, true);
});

test('凭据库：写盘失败 = 不谎报成功，内存里那份也不许变（否则"这次能用、重启就失效"）', async (t) => {
  const dir = tempDirSync('irmia-hookwrite-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lines: string[] = [];
  const store = new WebhookSecretStore({ dataDir: dir, now: () => T0, out: (line) => lines.push(line) });
  const first = store.rotate();
  assert.equal(first.ok, true);
  const token = first.ok ? first.token : '';

  // 让写入必然失败：把数据目录整个挪走，再在同名位置放一个**文件**——
  // 读已经发生过了（构造时），而临时文件的 mkdir 会当场抛错。
  // ⚠ 挪走的那个目录要**单独登记/清理**：改名前登记的路径已经不存在了，只清 `dir`
  // 会在 `%TEMP%` 里留下一个 `<dir>-moved`（2026-10-21 审计现场就有这种遗留）。
  const moved = `${dir}-moved`;
  registerTempDir(moved);
  t.after(() => rmSync(moved, { recursive: true, force: true }));
  renameSync(dir, moved);
  writeFileSync(dir, 'not a directory', 'utf8');

  const failed = store.rotate();
  assert.equal(failed.ok, false);
  assert.equal(failed.ok === false ? failed.code : '', 'write-failed');
  assert.ok(lines.some((line) => line.includes('写不进去')), '失败要说出来');
  assert.equal(store.authenticate(token).ok, true, '写盘没成，旧凭据照旧有效（进程内这条路的判据没被改）');
});
