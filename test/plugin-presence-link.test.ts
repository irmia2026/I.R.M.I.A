import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('linre-presence 识别最近 read_channel(sid) 调用并自动进屋联动 wait_messages', async () => {
  const root = join(tmpdir(), 'linre-presence-link-' + Date.now());
  const eventsDir = join(root, 'events');
  mkdirSync(eventsDir, { recursive: true });

  const now = Date.now();
  const lines = [
    JSON.stringify({
      seq: 1,
      ts: new Date(now - 20_000).toISOString(),
      type: 'channel/message',
      data: { channel: 'onebot', chatType: 'group', chatId: '705463642', person: '3652971137', nickname: '妈', text: '芮扣一', messageId: 'm1' },
    }),
    JSON.stringify({
      seq: 2,
      ts: new Date(now - 5_000).toISOString(),
      type: 'tool/call',
      data: { turn: 10, step: 1, callId: 'c1', name: 'read_channel', arguments: JSON.stringify({ sid: 'onebot:group:705463642', limit: 20 }) },
    }),
  ];
  writeFileSync(join(eventsDir, '000000000001.jsonl'), lines.join('\n') + '\n', 'utf8');

  const serverPath = resolve('plugins/builtin/linre-presence/server.mjs');
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, IRMIA_DATA_DIR: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const responses = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined) {
        const resolver = responses.get(msg.id);
        if (resolver) resolver(msg);
      }
    }
  });

  const rpc = (id: number, method: string, params: Record<string, unknown>) =>
    new Promise<any>((resolvePromise, rejectPromise) => {
      const t = setTimeout(() => rejectPromise(new Error('rpc timeout ' + method)), 8000);
      responses.set(id, (msg: any) => {
        clearTimeout(t);
        resolvePromise(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  try {
    const init = await rpc(1, 'initialize', {});
    assert.ok(init.result?.serverInfo?.name === 'linre-presence');

    const waitPromise = rpc(2, 'tools/call', { name: 'wait_messages', arguments: { seconds: 2 } });
    await new Promise((r) => setTimeout(r, 250));
    const nextLine = JSON.stringify({
      seq: 3,
      ts: new Date().toISOString(),
      type: 'channel/message',
      data: { channel: 'onebot', chatType: 'group', chatId: '705463642', person: '3652971137', nickname: '妈', text: '跟进第二句', messageId: 'm2' },
    });
    writeFileSync(join(eventsDir, '000000000001.jsonl'), [...lines, nextLine].join('\n') + '\n', 'utf8');

    const waitRes = await waitPromise;
    const text = waitRes.result?.content?.[0]?.text ?? '';
    assert.equal(waitRes.result?.isError, undefined, text);
    assert.match(text, /onebot:group:705463642/u);
    assert.match(text, /跟进第二句/u);
  } finally {
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
