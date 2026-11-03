import assert from 'node:assert/strict';
import test from 'node:test';
import { OneBotClient } from '../src/channel/onebot.ts';
import type { WsClient } from '../src/channel/ws-client.ts';

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function fakeSocket() {
  let onMessage: (message: {text: string}) => void = () => {};
  let onClose: (info: unknown) => void = () => {};
  let closed = 0;
  const socket = {
    isOpen: true,
    onMessage(fn: typeof onMessage) { onMessage = fn; },
    onError() {},
    onClose(fn: typeof onClose) { onClose = fn; },
    close() { closed++; this.isOpen = false; onClose({code: 1000, byLocal: true, reason: 'synthetic'}); },
    sendJson(value: {echo: string}) {
      queueMicrotask(() => onMessage({text: JSON.stringify({echo: value.echo, retcode: 0, data: {user_id: 7001}})}));
    },
  };
  return {
    socket: socket as unknown as WsClient,
    closed: () => closed,
    message: () => onMessage({text: JSON.stringify({post_type: 'message', message_type: 'private', sub_type: 'friend',
      self_id: 7001, user_id: 7002, message_id: 44, raw_message: 'synthetic', message: 'synthetic',
      sender: {user_id: 7002}, time: 1793318400})}),
  };
}

test('连接在 stop 后才返回：立即关闭，不重新接收消息', async () => {
  const gate = pending<WsClient>();
  const socket = fakeSocket();
  let wakes = 0;
  const client = new OneBotClient({wsUrl: 'ws://synthetic.invalid', connect: () => gate.promise, onWake: () => { wakes++; }});
  try {
    client.start(); client.stop(); gate.resolve(socket.socket); await tick();
    socket.message();
    assert.equal(socket.closed(), 1);
    assert.equal(client.snapshot().connected, false);
    assert.equal(wakes, 0);
  } finally { client.stop(); }
});

test('stop/start 后旧连接迟到不能替换新连接，旧消息也不能进入新周期', async () => {
  const first = pending<WsClient>(), second = pending<WsClient>();
  const oldSocket = fakeSocket(), newSocket = fakeSocket();
  let calls = 0, wakes = 0;
  const client = new OneBotClient({wsUrl: 'ws://synthetic.invalid', connect: () => (++calls === 1 ? first.promise : second.promise), onWake: () => { wakes++; }});
  try {
    client.start(); client.stop(); client.start();
    second.resolve(newSocket.socket); await tick();
    first.resolve(oldSocket.socket); await tick();
    assert.equal(oldSocket.closed(), 1);
    assert.equal(newSocket.closed(), 0);
    assert.equal(client.snapshot().connected, true);
    oldSocket.message(); newSocket.message();
    assert.equal(wakes, 1);
    client.stop(); newSocket.message();
    assert.equal(wakes, 1);
  } finally { client.stop(); }
});

test('旧连接失败与已排队的旧重连回调不影响新周期', async () => {
  const old = pending<WsClient>(), current = pending<WsClient>();
  const timers: Array<() => void> = [];
  let calls = 0;
  const client = new OneBotClient({wsUrl: 'ws://synthetic.invalid', connect: () => (++calls === 1 ? old.promise : current.promise),
    onWake: () => {}, setTimeoutFn: callback => { timers.push(callback); return timers.length; }, clearTimeoutFn: () => {}});
  try {
    client.start(); old.reject(new Error('synthetic connection failure')); await tick();
    assert.equal(timers.length, 1);
    client.stop(); client.start(); timers[0]!();
    assert.equal(calls, 2);
    client.stop(); current.reject(new Error('late failure')); await tick();
    assert.equal(timers.length, 1);
  } finally { client.stop(); }
});
