import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';

import { OPCODE, acceptKeyOf, parseFrame } from '../src/channel/ws-client.ts';
import { runMain, type MainHandle } from '../src/main.ts';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new Error('本地监听失败'));
      else resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

function wsFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const head = payload.length < 126 ? Buffer.from([0x80 | OPCODE.text, payload.length]) : Buffer.from([0x80 | OPCODE.text, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

async function startNapCat() {
  const sockets = new Set<Socket>();
  const actions: Array<Record<string, unknown>> = [];
  const server = createNetServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    const send = (value: unknown) => socket.write(wsFrame(JSON.stringify(value)));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + 4);
        const key = /sec-websocket-key:\s*([^\r\n]+)/iu.exec(head)?.[1]?.trim() ?? '';
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKeyOf(key)}\r\n\r\n`);
        upgraded = true;
      }
      for (;;) {
        const parsed = parseFrame(buffer, 16 * 1024 * 1024);
        if (parsed.kind !== 'frame') break;
        buffer = buffer.subarray(parsed.consumed);
        if (parsed.header.opcode === OPCODE.close) {
          socket.end();
          return;
        }
        if (parsed.header.opcode !== OPCODE.text) continue;
        const call = JSON.parse(parsed.payload.toString('utf8')) as Record<string, unknown>;
        actions.push(call);
        const messageId = call['action'] === 'get_login_info' ? 900 : actions.length + 100;
        send({
          status: 'ok', retcode: 0, echo: call['echo'],
          data: call['action'] === 'get_login_info' ? { user_id: 900, nickname: 'smoke' } : { message_id: messageId },
        });
      }
    });
  });
  const port = await listen(server);
  return {
    url: `ws://127.0.0.1:${port}`,
    actions,
    send: (value: unknown) => {
      for (const socket of sockets) socket.write(wsFrame(JSON.stringify(value)));
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await close(server);
    },
  };
}

async function startModel() {
  let streamCalls = 0;
  let generateCalls = 0;
  let taggingCalls = 0;
  let judgeCalls = 0;
  const requestPaths: string[] = [];
  const server = createServer((req, res) => {
    requestPaths.push(`${req.method} ${req.url}`);
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url !== '/v1/chat/completions' && req.url !== '/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const request = JSON.parse(raw) as { stream?: boolean };
      if (request.stream !== true) {
        generateCalls += 1;
        const tagging = raw.includes('只看这张图片本身');
        if (tagging) taggingCalls += 1;
        else judgeCalls += 1;
        const content = tagging
          ? JSON.stringify({ tags: ['开心'], intensity: 'obvious', confidence: 0.97, note: '微笑的测试贴纸' })
          : JSON.stringify({ risky: false, reason: '本地冒烟的普通发言', quotes: [] });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'smoke-light', model: 'smoke-model',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
          usage: { prompt_tokens: 30, completion_tokens: 12 },
        }));
        return;
      }
      streamCalls += 1;
      const first = streamCalls === 1;
      if (streamCalls > 2) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'unexpected-call', message: '冒烟只允许两次 heavy 调用' } }));
        return;
      }
      const chunk = (value: unknown) => `data: ${JSON.stringify({ id: `smoke-heavy-${streamCalls}`, model: 'smoke-model', ...value as object })}\n\n`;
      let output = '';
      if (first) {
        const args = JSON.stringify({ text: '来啦', sticker: '开心', stickerPos: 'after', to: 'onebot:c2c:123' });
        output += chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'smoke-speak', type: 'function', function: { name: 'speak', arguments: args } }] }, finish_reason: null }] });
        output += chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 10 } });
      } else {
        output += chunk({ choices: [{ index: 0, delta: { content: '发好了' }, finish_reason: null }] });
        output += chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 3 } });
      }
      output += 'data: [DONE]\n\n';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(output);
    });
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    counts: () => ({ generateCalls, taggingCalls, judgeCalls, streamCalls }),
    paths: () => [...requestPaths],
    close: async () => await close(server),
  };
}

async function jsonCall(base: string, method: string, path: string, body?: unknown, token?: string): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} => ${response.status}: ${text}`);
  return text === '' ? null : JSON.parse(text);
}

async function waitFor(label: string, read: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} 超时`);
}

async function flutterScreenshot(base: string, token: string): Promise<void> {
  const command = process.platform === 'win32' ? 'flutter.bat' : 'flutter';
  const child = spawn(command, ['test', 'test/stickers_panel_test.dart', '--plain-name', '真机冒烟', '--update-goldens'], {
    cwd: join(repo, 'gui'),
    env: { ...process.env, IRMIA_SMOKE_BASE_URL: base, IRMIA_SMOKE_TOKEN: token },
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  const code = await new Promise<number>((resolve) => child.once('close', resolve));
  writeFileSync(join(repo, 'tmp', 'stage5-gui-smoke.log'), output, 'utf8');
  if (code !== 0) throw new Error(`GUI 冒烟失败（${code}），见 tmp/stage5-gui-smoke.log`);
}

let handle: MainHandle | null = null;
let model: Awaited<ReturnType<typeof startModel>> | null = null;
let napcat: Awaited<ReturnType<typeof startNapCat>> | null = null;
const lines: string[] = [];
const root = mkdtempSync(join(tmpdir(), 'irmia-sticker-smoke-'));
try {
  model = await startModel();
  napcat = await startNapCat();
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(root, 'local'), { recursive: true });
  mkdirSync(join(root, 'roaming'), { recursive: true });
  process.env.LOCALAPPDATA = join(root, 'local');
  process.env.APPDATA = join(root, 'roaming');
  process.env.IRMIA_SMOKE_MODEL_KEY = 'local-smoke-not-a-real-key';
  process.env.IRMIA_AFFECT_ENABLED = '0';
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    dataDir,
    models: {
      heavy: { model: 'smoke-model', baseUrl: model.url, apiKeyEnv: 'IRMIA_SMOKE_MODEL_KEY', protocol: 'chat-completions' },
      light: { model: 'smoke-model', baseUrl: model.url, apiKeyEnv: 'IRMIA_SMOKE_MODEL_KEY', protocol: 'chat-completions' },
    },
    channels: { onebot: { enabled: true, wsUrl: napcat.url, stickers: false } },
    persona: { owner: '用户', memoryEnabled: false, contacts: { 'onebot:c2c:123': '用户' } },
    affect: { enabled: false, evaluatorEnabled: false },
    stickers: { enabled: true, harvest: { enabled: false, probability: 0.15 }, tagging: { enabled: true, maxPerHour: 20, concurrency: 1 } },
    speak: { typingEffect: false },
    update: { enabled: false },
    plugins: { marketEnabled: false },
    web: { host: '127.0.0.1', port: await freePort() },
  }, null, 2));
  handle = await runMain({ dataDir, configPath, port: 0, installSignalHandlers: false, out: (line) => lines.push(line) });
  if (handle.webServer === null) throw new Error('临时实例没有启动 Web 服务');
  const base = handle.webServer.url();
  const auth = await jsonCall(base, 'POST', '/api/auth/setup', { password: 'sticker-smoke-only', label: 'local-smoke' });
  const token = auth.token as string;
  assert.equal(typeof token, 'string');
  const uploaded = await jsonCall(base, 'POST', '/api/stickers', { mime: 'image/png', data: PNG.toString('base64') }, token);
  const uploadEvents = await jsonCall(base, 'GET', '/api/stickers/events', undefined, token);
  writeFileSync(join(repo, 'tmp', 'stage5-upload-receipt.json'), `${JSON.stringify({ uploaded, events: uploadEvents.items }, null, 2)}\n`);
  const id = uploaded.entry.id as string;
  assert.equal(uploaded.entry.status, 'pending');
  assert.deepEqual(uploaded.entry.tags, ['开心']);
  const approved = await jsonCall(base, 'PATCH', `/api/stickers/${id}`, { status: 'approved', tags: ['开心'], intensity: 'obvious' }, token);
  assert.equal(approved.entry.status, 'approved');
  const image = await fetch(`${base}/api/stickers/${id}/image`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(image.status, 200);
  assert.equal(Buffer.from(await image.arrayBuffer()).equals(PNG), true);

  napcat.send({
    post_type: 'message', message_type: 'private', user_id: 123, self_id: 900, message_id: 42,
    raw_message: '发个开心表情', message: '发个开心表情', sender: { user_id: 123, nickname: '用户' },
    time: Math.floor(Date.now() / 1000),
  });
  let sent: any = null;
  await waitFor('speak 与 sticker/sent', async () => {
    const events = await jsonCall(base, 'GET', '/api/stickers/events', undefined, token);
    sent = events.items.find((event: any) => event.type === 'sticker/sent' && event.data.source === 'active');
    return sent !== undefined;
  });
  assert.equal(sent.data.stickerId, id);
  assert.equal(sent.data.position, 'after');
  const deliveries = napcat.actions.filter((call) => call['action'] === 'send_private_msg');
  assert.equal(deliveries.length, 2);
  assert.equal(typeof (deliveries[0]!['params'] as any).message, 'string');
  assert.ok(Array.isArray((deliveries[1]!['params'] as any).message));
  assert.equal((deliveries[1]!['params'] as any).message[0].type, 'image');
  const inventory = await jsonCall(base, 'GET', '/api/stickers', undefined, token);
  assert.equal(inventory.counts.approved, 1);
  assert.equal(inventory.counts.sentToday, 1);
  assert.equal(inventory.tags['开心'], 1);
  assert.deepEqual(model.counts(), { generateCalls: 2, taggingCalls: 1, judgeCalls: 1, streamCalls: 2 });

  await flutterScreenshot(base, token);
  const screenshot = readFileSync(join(repo, 'tmp', 'sticker-smoke-panel.png'));
  assert.ok(screenshot.length > 1000);
  const evidence = {
    ok: true,
    backend: base,
    upload: { id, statusAfterTagging: uploaded.entry.status, statusAfterReview: approved.entry.status },
    sent: sent.data,
    deliveries: deliveries.map((call) => ({ action: call['action'], kind: typeof (call['params'] as any).message === 'string' ? 'text' : 'image' })),
    modelCalls: model.counts(),
    inventory: inventory.counts,
    guiScreenshot: 'tmp/sticker-smoke-panel.png',
    externalModel: false,
    temporaryData: true,
  };
  writeFileSync(join(repo, 'tmp', 'sticker-smoke-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(join(repo, 'tmp', 'stage5-backend-smoke.log'), `${lines.join('\n')}\n`);
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  writeFileSync(join(repo, 'tmp', 'stage5-backend-smoke.log'), `${lines.join('\n')}\n`);
  if (model !== null) writeFileSync(join(repo, 'tmp', 'stage5-model-count.json'), `${JSON.stringify({ ...model.counts(), paths: model.paths() })}\n`);
  if (handle !== null) await handle.stop('shutdown', 'sticker smoke complete');
  if (model !== null) await model.close();
  if (napcat !== null) await napcat.close();
  rmSync(root, { recursive: true, force: true });
}
