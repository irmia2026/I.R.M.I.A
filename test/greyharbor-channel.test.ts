import assert from 'node:assert/strict';
import test from 'node:test';

import { GreyHarborChannel } from '../src/channel/greyharbor.ts';
import type { WsClient, WsCloseInfo, WsMessage } from '../src/channel/ws-client.ts';

class FakeWs implements WsClient {
  isOpen = true;
  readonly sent: string[] = [];
  private messageCb: ((message: WsMessage) => void) | null = null;
  private closeCb: ((info: WsCloseInfo) => void) | null = null;
  private errorCb: ((error: Error) => void) | null = null;

  send(text: string): void { this.sent.push(text); }
  sendJson(value: unknown): void { this.sent.push(JSON.stringify(value)); }
  onMessage(cb: (message: WsMessage) => void): void { this.messageCb = cb; }
  onClose(cb: (info: WsCloseInfo) => void): void { this.closeCb = cb; }
  onError(cb: (error: Error) => void): void { this.errorCb = cb; }
  setReadTimeoutMs(_ms: number): void {}
  close(_code?: number, _reason?: string): void {
    this.isOpen = false;
    this.closeCb?.({ code: 1000, reason: 'closed', byLocal: true });
  }

  emit(frame: unknown): void {
    this.messageCb?.({
      type: 'text',
      text: JSON.stringify(frame),
      bytes: Buffer.from(JSON.stringify(frame)),
    });
  }
}

test('greyharbor：welcome/events 映射、去重与 HTTP 发言', async () => {
  const socket = new FakeWs();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return {
      ok: true,
      status: 200,
      json: async () => ({ events: [], observation: {}, cursor: 0 }),
    } as Response;
  }) as typeof fetch;

  const channel = new GreyHarborChannel({
    baseUrl: 'http://127.0.0.1:3000',
    token: 'token',
    characterId: 'char-me',
    connect: async () => socket,
    fetch: fetchFn,
  });
  const incoming: unknown[] = [];
  let ready = 0;
  channel.onMessage = (event) => incoming.push(event);
  channel.onReady = () => { ready += 1; };
  channel.start();
  await new Promise((resolve) => setImmediate(resolve));

  socket.emit({
    type: 'welcome',
    characterId: 'char-me',
    cursor: 4,
    observation: {
      character: { id: 'char-me', name: '弥亚' },
      location: { id: 'loc-1', name: '灰港' },
      messages: [{ id: 'm1', fromId: 'char-other', fromName: '渡鸦', text: '你好' }],
    },
  });
  assert.equal(ready, 1);

  socket.emit({
    type: 'events',
    cursor: 7,
    events: [
      { id: 6, type: 'message.direct', message: '渡鸦给你发来一条私信。' },
      { id: 7, type: 'combat.started', message: '战斗开始。' },
    ],
  });
  assert.equal(incoming.length, 2);
  assert.deepEqual(incoming[0], {
    channel: 'greyharbor',
    chatType: 'c2c',
    person: 'char-other',
    nickname: '渡鸦',
    chatId: 'char-other',
    text: '渡鸦给你发来一条私信。',
    messageId: '6',
    msgSeq: 6,
    dedupeKey: 'greyharbor:6',
  });
  assert.equal((incoming[1] as { chatType: string }).chatType, 'group');

  socket.emit({
    type: 'events',
    cursor: 7,
    events: [{ id: 7, type: 'combat.started', message: '重复事件' }],
  });
  assert.equal(incoming.length, 2, '同 id 不重复唤醒');

  const direct = await channel.sendText('c2c', 'char-other', '在');
  assert.deepEqual(direct, { ok: true, messageId: '', passive: false, msgSeq: 0 });
  const say = await channel.sendText('group', 'loc-1', '大家好');
  assert.deepEqual(say, { ok: true, messageId: '', passive: false, msgSeq: 0 });
  assert.equal(requests.length, 2);
  assert.match(requests[0]!.url, /\/v1\/characters\/char-me\/commands$/u);
  assert.match(String(requests[0]!.init.body), /direct_message/u);
  assert.match(String(requests[1]!.init.body), /"type":"say"/u);
  channel.stop();
});
