/**
 * 网页聊天版已删除 —— 但**它当年读的那些端点一个都没少**。
 *
 * ## 这份文件原来测什么，为什么现在测这个
 *
 * 原来它逐条断言 `web/index.html + shell.js + pages/chat.js` 的字节：对话条目的四种颜色、
 * 令牌门归壳、状态词表不进聊天页……网页整个删掉之后，那些断言的主语（那几个文件）
 * 不复存在，留着一份读不到文件的测试只是自欺。
 *
 * 但删掉一张脸**不该顺手删掉后台**。当年那一整屏内容是从这几条端点拼出来的，而 GUI 现在
 * 读的是同一批：`/api/stats/dashboard` 喂状态句、`/api/events` + SSE 喂对话与日志、
 * `/api/persona/files` 喂人格页、`/api/commands/*` 是唯一的写通道。所以这份文件改成
 * 断言**这些契约还在、还是原来那个形状**——把"页面没了"和"数据源没了"这两件事分开钉死。
 *
 * 另外钉两条这轮的行为变更：
 *   · SSE 的 `?token=` 后门关了（网页删掉之后它唯一的理由——浏览器 EventSource——
 *     也不存在了；凭据出现在 URL 里会被各处日志顺手记下来）；
 *   · `/api/events/stream` 走 Authorization 头照旧可用。
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { defaultVisibility, emptyProjection, type AppEvent } from '../src/log/types.ts';
import { ensurePersonaSeeds } from '../src/persona/loader.ts';
import { applyOne, finalizePressure } from '../src/state/fold.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const T0 = new Date('2026-02-14T10:00:00.000Z');
const TEST_TOKEN = 'test-token-0123456789abcdef';
/** 当年聊天版用过的那批数据源；一条都不能少 */
const CHAT_ENDPOINTS = [
  '/api/projection',
  '/api/stats/dashboard',
  '/api/events?limit=5',
  '/api/budget',
  '/api/persona/files',
  '/api/persona/file?path=IDENTITY.md',
  '/api/config',
  '/api/doctor',
  '/api/memory',
  '/api/skills',
  '/api/framework-notes',
] as const;

interface Rig {
  dir: string;
  dataDir: string;
  server: WebServer;
  base: string;
  append(type: string, data: unknown): AppEvent;
  headers: Record<string, string>;
}

async function rig(t: TestContext): Promise<Rig> {
  const dir = tempDirSync('irmia-chatwire-');
  const dataDir = join(dir, 'data');
  ensurePersonaSeeds(dataDir);
  const log = await EventLog.open(join(dataDir, 'events'));
  const projection = emptyProjection();
  const now = (): Date => T0;

  const append = (type: string, data: unknown): AppEvent => {
    const event = {
      seq: log.nextSeq(),
      ts: T0.toISOString(),
      type,
      data,
      visibility: defaultVisibility(type),
      origin: 'test/chat-wire',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    applyOne(projection, event);
    finalizePressure(projection, event.ts);
    return event;
  };

  const server = await startWebServer({
    log,
    projection,
    config: defaultConfig(dir),
    personaRoot: join(dataDir, 'persona'),
    dataDir,
    timers: new TimerStore(join(dataDir, 'timers.json'), { now }),
    now,
    uiToken: TEST_TOKEN,
    port: 0,
    ssePollMs: 20,
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

  return {
    dir,
    dataDir,
    server,
    base: server.url(),
    append,
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  };
}

async function getJson(base: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, { headers });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

// ──────────────────────────────── ① 数据源一条都没少 ────────────────────────────────

test('当年喂那几页的端点全部照旧 200（删的是脸，不是后台）', async (t) => {
  const r = await rig(t);
  r.append('wake/manual', { note: '让 dashboard 有东西可算' });

  for (const path of CHAT_ENDPOINTS) {
    const res = await getJson(r.base, path, r.headers);
    assert.equal(res.status, 200, `${path} 必须还在（GUI 读的是同一批）`);
    assert.notEqual(res.body, null, `${path} 必须回 JSON`);
  }
});

test('写通道照旧：那三条命令还在危险短语表里，wake 落 wake/manual', async (t) => {
  const r = await rig(t);

  for (const command of ['wake', 'review-resolve', 'answer']) {
    const response = await fetch(`${r.base}/api/commands/${command}`, {
      method: 'POST',
      headers: { ...r.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'x', answer: 'y', callId: 'c1', outcome: 'succeeded' }),
    });
    // 未知命令会 404 unknown-command；这三条要么成功要么如实报错，但**绝不能是"没这条命令"**
    const text = await response.text();
    assert.equal(text.includes('unknown-command'), false, `${command} 不该变成未知命令`);
  }

  const wake = await fetch(`${r.base}/api/commands/wake`, {
    method: 'POST',
    headers: { ...r.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ note: '界面还在用这条路' }),
  });
  assert.equal(wake.status, 200);
  assert.equal(((await wake.json()) as { type: string }).type, 'wake/manual');
});

test('对话的形状仍在：message/assistant 与 message/user 都在事件流里（页面自己不再映射）', async (t) => {
  const r = await rig(t);
  r.append('message/user', { text: '你好', source: 'manual', attachments: [] });
  r.append('message/assistant', { text: '我在。', toolCalls: [], spoke: true });

  const res = await getJson(r.base, '/api/events?limit=10', r.headers);
  const events = (res.body as { events: AppEvent[] }).events;
  assert.deepEqual(events.map((event) => event.type), ['message/user', 'message/assistant']);
  // 状态句由界面翻译，服务端只给状态机那一格（GUI 的 humanState 读它）
  const dash = await getJson(r.base, '/api/stats/dashboard', r.headers);
  assert.equal(typeof (dash.body as { state: string }).state, 'string');
  assert.equal(typeof (dash.body as { stateText: string }).stateText, 'string');
});

// ──────────────────────────────── ② SSE 契约 ────────────────────────────────

test('SSE：凭 Authorization 头照旧可用，帧字段没变（先接流、再由尾部轮询推出来）', async (t) => {
  const r = await rig(t);

  const response = await fetch(`${r.base}/api/events/stream`, { headers: r.headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/u);

  const reader = response.body!.getReader();
  t.after(() => {
    void reader.cancel();
  });

  // 接上之后再落库：实时那条路由尾部轮询推出来（补拉那条在 web-server.test.ts 里单独验）
  r.append('wake/manual', { note: '接上之后来的' });

  const decoder = new TextDecoder();
  let buffer = '';
  const frames: string[] = [];
  // 流的第一帧永远是 `retry: 3000`（SSE 重连建议），事件帧才算数
  while (frames.length < 1) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let idx = buffer.indexOf('\n\n');
    while (idx >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (frame.startsWith('event:')) frames.push(frame);
      idx = buffer.indexOf('\n\n');
    }
  }
  assert.equal(frames.length, 1, '应至少收到一帧事件');
  assert.match(frames[0]!, /^event: wake\/manual\nid: 1\n/u, '帧形状：event 名 + id + data');

  const payload = JSON.parse(frames[0]!.split('data: ')[1]!) as AppEvent;
  assert.equal(payload.seq, 1);
  assert.equal(payload.type, 'wake/manual');
  assert.equal(payload.visibility, 'model');
});

test('SSE 的 ?token= 后门已关闭（凭据只认头）', async (t) => {
  const r = await rig(t);

  const viaQuery = await getJson(r.base, `/api/events/stream?token=${TEST_TOKEN}`, {});
  assert.equal(viaQuery.status, 401, 'URL 里的凭据不再算数');

  const anon = await getJson(r.base, '/api/events/stream', {});
  assert.equal(anon.status, 401);
});
