/**
 * **就绪态**那条契约 —— `GET /api/health` + "未就绪期 503" + 端口早绑的交接。
 *
 * 事故（2026-10-26，`data/restart-worker.log`）：
 * ```
 * [结束] ok=False backendPid=24616 port=timeout … reason=port-not-ready
 * ```
 * 后端冷启动 35–42 秒才 listen，而拉起器等 32 秒必然超时。修法是"端口先 bind、重活后干"，
 * 而这要求 HTTP 层在**没就绪**那半分钟里明确答话。这一份钉的就是那几条判据：
 *
 *   ① 未就绪：`/api/health` = starting（带 phase/port/pid/uptimeMs），其余 `/api` = 503 starting；
 *      未认证的探测拿到的也必须是 503（不是 401）——"还没起好"不许被读成"你没登录"；
 *   ② 就绪后：`/api/health` = ready，`/api/sessions` 照常（200 + 真数据）；
 *   ③ 认证端点在**就绪后**与改前一致（`/api/auth/state` + 登录那两条走真服务）；
 *      未就绪期只放行"公开事实"那一条 —— 写端点要落 `auth/password-set` 事实，而事实表
 *      （事件日志）那时候还不存在，所以它落在 503 上（不是挂住、也不是假装成功）；
 *   ④ 端口早绑 → 真服务**接管同一个 socket**（不重 bind、不换端口），health 与数据路由
 *      在同一个端口上一前一后地工作。
 *
 * 两种装配都要验：`preflight` 单独那段（生产里就绪前唯一在答话的东西），以及
 * `startWebServer({ startup })` 这条带就绪闸的真路由（防御性那条：将来有人把装配顺序
 * 改回去，它照样不许把未就绪的请求当就绪处理）。
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { emptyProjection } from '../src/log/types.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { AuthStore } from '../src/web/auth.ts';
import { StartupState, startPreflightServer, type PreflightServer } from '../src/web/preflight.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const PASSWORD = 'health-test-password-0123';

/** 每个夹具都有的那几样 */
interface Base {
  dataDir: string;
  auth: AuthStore;
  token: string;
  now: () => Date;
  /** 收尾用（临时目录里的日志句柄等） */
  cleanup: () => void;
}

async function base(t: TestContext, options: { initialized: boolean }): Promise<Base> {
  const dir = tempDirSync('irmia-health-');
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const now = (): Date => new Date('2026-02-14T10:00:00.000Z');
  const auth = new AuthStore({ dataDir, now, out: () => {} });
  let token = '';
  if (options.initialized) {
    const issued = await auth.setup(PASSWORD);
    assert.equal(issued.ok, true, '夹具设密码失败（scrypt 一次）');
    if (!issued.ok) throw new Error('夹具设密码失败');
    token = issued.token;
  }
  t.after(() => {
    // 无句柄要收：AuthStore 是同步读写，临时目录留给系统清
  });
  return { dataDir, auth, token, now, cleanup: () => {} };
}

// ──────────────────── A. 只有 preflight（生产里就绪前唯一在答话的那一层） ────────────────────

async function preflightOnly(
  t: TestContext,
  options: { initialized: boolean },
): Promise<{ baseUrl: string; preflight: PreflightServer; state: StartupState; token: string }> {
  const b = await base(t, options);
  let bound = 0;
  const state = new StartupState({ port: () => bound, now: () => b.now().getTime() });
  // 认证事实用假的一份：preflight 对 `/api/auth/state` 只读这一个布尔
  const preflight = await startPreflightServer({
    port: 0,
    state,
    auth: { initialized: options.initialized },
    out: () => {},
  });
  bound = preflight.portOf();
  t.after(() => preflight.close());
  return { baseUrl: `http://127.0.0.1:${bound}`, preflight, state, token: b.token };
}

// ──────────────────── B. 真路由 + 未就绪闸（不带早绑，验证那条防御性判据） ────────────────────

interface RealServer {
  base: string;
  server: WebServer;
  startup: StartupState;
  token: string;
}

async function realServer(t: TestContext): Promise<RealServer> {
  const b = await base(t, { initialized: true });
  const log = await EventLog.open(join(b.dataDir, 'events'));
  const timers = new TimerStore(join(b.dataDir, 'timers.json'), { now: b.now });
  const config = defaultConfig(b.dataDir);
  const configPath = join(b.dataDir, 'config.json');
  writeFileSync(configPath, `${JSON.stringify({ schemaVersion: 1 }, null, 2)}\n`, 'utf8');
  let boundPort = 0;
  const startup = new StartupState({ port: () => boundPort, now: () => b.now().getTime() });
  const server = await startWebServer({
    log,
    projection: emptyProjection(),
    config,
    personaRoot: join(b.dataDir, 'persona'),
    dataDir: b.dataDir,
    timers,
    now: b.now,
    auth: b.auth,
    port: 0,
    configPath,
    out: () => {},
    startup,
  });
  boundPort = server.port();
  t.after(async () => {
    await server.close();
    log.close();
  });
  return { base: server.url(), server, startup, token: b.token };
}

// ──────────────────── 小工具 ────────────────────

async function getJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // 非 JSON 就原样给回来：断言自己决定怎么读
  }
  return { status: res.status, body };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object', `期望一个 JSON 对象，拿到：${String(value)}`);
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

// ──────────────────────── ① 未就绪：health=starting、其余 503 ────────────────────────

test('① 未就绪期：/api/health=starting，其余 /api=503 starting（答话，不是挂住）', async (t) => {
  const f = await preflightOnly(t, { initialized: true });

  const health = await getJson(`${f.baseUrl}/api/health`);
  assert.equal(health.status, 200, 'health 不需要凭据，未就绪也照常 200');
  const reading = asRecord(health.body);
  assert.equal(reading['status'], 'starting');
  assert.equal(reading['phase'], 'events', '端口 bind 之后的第一段是折事件');
  assert.equal(reading['port'], f.preflight.portOf(), 'port 必须是**真在听**的那个');
  assert.equal(reading['pid'], process.pid);
  assert.equal(typeof reading['uptimeMs'], 'number');
  assert.ok((reading['uptimeMs'] as number) >= 0);

  const sessions = await getJson(`${f.baseUrl}/api/sessions`);
  assert.equal(sessions.status, 503);
  const body = asRecord(sessions.body);
  assert.equal(body['starting'], true);
  assert.equal(body['phase'], 'events');
  assert.equal(asRecord(body['error'])['code'], 'starting', '错误形状与其余 /api 同一条（{error:{code,message}}）');

  // 写命令同样 503：不许出现"未就绪但命令已经落地"的半截状态
  const wake = await getJson(`${f.baseUrl}/api/commands/wake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  });
  assert.equal(wake.status, 503);
  assert.equal(asRecord(wake.body)['starting'], true);
});

test('①b 阶段往前推：events → channels → mcp 跟着走，且不许往回退', async (t) => {
  const f = await preflightOnly(t, { initialized: true });
  const phaseOf = async (): Promise<unknown> => asRecord((await getJson(`${f.baseUrl}/api/health`)).body)['phase'];

  assert.equal(await phaseOf(), 'events');
  f.state.setPhase('channels');
  assert.equal(await phaseOf(), 'channels');
  f.state.setPhase('mcp');
  assert.equal(await phaseOf(), 'mcp');
  f.state.setPhase('events'); // 晚到的旧播报不许把读数打回去
  assert.equal(await phaseOf(), 'mcp', '阶段只许往前走');
});

test('①c 真路由上的同一条闸：未就绪时未认证的探测拿到 503（不是 401）', async (t) => {
  const f = await realServer(t);
  // 界面进门时的第一次空手探测：401 会被读成"该登录"，而真相是"后端还在起"
  const probe = await getJson(`${f.base}/api/projection`);
  assert.equal(probe.status, 503);
  assert.equal(asRecord(probe.body)['starting'], true);

  const health = asRecord((await getJson(`${f.base}/api/health`)).body);
  assert.equal(health['status'], 'starting');
  assert.equal(health['port'], f.server.port());
});

// ──────────────────────── ② 就绪后：完全回到改前的行为 ────────────────────────

test('② 就绪后：health=ready、/api/sessions 正常、认证端点照旧', async (t) => {
  const f = await realServer(t);
  f.startup.markReady();

  const health = asRecord((await getJson(`${f.base}/api/health`)).body);
  assert.equal(health['status'], 'ready');
  assert.equal(health['phase'], 'ready');

  const sessions = await getJson(`${f.base}/api/sessions`, {
    headers: { authorization: `Bearer ${f.token}` },
  });
  assert.equal(sessions.status, 200, '就绪之后数据路由照常（不许把中间件的语义带给已就绪请求）');

  // 认证门：公开事实照旧，登录照旧签发会话
  const state = await getJson(`${f.base}/api/auth/state`);
  assert.equal(state.status, 200);
  assert.equal(asRecord(state.body)['initialized'], true);

  const login = await getJson(`${f.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, label: 'test' }),
  });
  assert.equal(login.status, 200, '就绪后登录必须还能用（认证门一个字都没动）');
  assert.equal(typeof asRecord(login.body)['token'], 'string');
});

// ──────────────────────── ③ 认证端点在未就绪期的分寸 ────────────────────────

test('③ 未就绪期：/api/auth/state 照常答；写端点落 503（事实表还没开，不许先答话后丢账）', async (t) => {
  const f = await preflightOnly(t, { initialized: true });

  const state = await getJson(`${f.baseUrl}/api/auth/state`);
  assert.equal(state.status, 200);
  assert.equal(asRecord(state.body)['initialized'], true, '公开事实不依赖任何重活');

  const setup = await getJson(`${f.baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(setup.status, 503, '设密码要落 auth/password-set 事实：日志还没开，不许先答话后丢账');
  assert.equal(asRecord(setup.body)['starting'], true);
});

test('③b 未设密码的实例：未就绪期 /api/auth/state 照样答 false（界面据此画"设置密码"那扇门）', async (t) => {
  const f = await preflightOnly(t, { initialized: false });
  const state = await getJson(`${f.baseUrl}/api/auth/state`);
  assert.equal(state.status, 200);
  assert.equal(asRecord(state.body)['initialized'], false);
});

// ──────────────────────── ④ 端口早绑 → 真服务接管同一个 socket ────────────────────────

test('④ 交接：真服务接管 preflight 那个 socket，ready 与数据路由在**同一个端口**上生效', async (t) => {
  const b = await base(t, { initialized: true });
  const log = await EventLog.open(join(b.dataDir, 'events'));
  const timers = new TimerStore(join(b.dataDir, 'timers.json'), { now: b.now });
  const config = defaultConfig(b.dataDir);
  const configPath = join(b.dataDir, 'config.json');
  writeFileSync(configPath, `${JSON.stringify({ schemaVersion: 1 }, null, 2)}\n`, 'utf8');

  let bound = 0;
  const startup = new StartupState({ port: () => bound, now: () => b.now().getTime() });
  const preflight = await startPreflightServer({
    port: 0, state: startup, auth: b.auth, out: () => {},
  });
  bound = preflight.portOf();
  const boundPort = bound;
  t.after(() => preflight.close());

  // 就绪之前：同一个端口上答的是 starting
  const before = asRecord((await getJson(`http://127.0.0.1:${boundPort}/api/health`)).body);
  assert.equal(before['status'], 'starting');
  assert.equal(before['port'], boundPort);

  const server = await startWebServer({
    log,
    projection: emptyProjection(),
    config,
    personaRoot: join(b.dataDir, 'persona'),
    dataDir: b.dataDir,
    timers,
    now: b.now,
    auth: b.auth,
    port: 0,
    configPath,
    out: () => {},
    startup,
    bootstrap: preflight,
  });
  t.after(async () => {
    await server.close();
    log.close();
  });

  assert.equal(server.port(), boundPort, '真服务不许自己再 bind 一个端口');
  assert.equal(preflight.handedOff(), true, 'listen() 之后请求已经归真路由');
  assert.equal(preflight.state.ready(), true, '交给真路由的同时就绪（health=ready 蕴含"数据路由能答"）');

  const after = asRecord((await getJson(`http://127.0.0.1:${boundPort}/api/health`)).body);
  assert.equal(after['status'], 'ready');
  assert.equal(after['port'], boundPort);

  const sessions = await getJson(`http://127.0.0.1:${boundPort}/api/sessions`, {
    headers: { authorization: `Bearer ${b.token}` },
  });
  assert.equal(sessions.status, 200, '同一个端口上，数据路由随 ready 生效');
});

test('④b preflight 的参数：port=0 时报的是系统分配的那个端口（不是 0）', async (t) => {
  const f = await preflightOnly(t, { initialized: false });
  const reading = asRecord((await getJson(`${f.baseUrl}/api/health`)).body);
  assert.ok((reading['port'] as number) > 0);
  assert.equal(reading['port'], f.preflight.portOf());
  assert.equal(f.preflight.server.listening, true, 'bind 完成 = 端口真的在听（不等重活）');
});
