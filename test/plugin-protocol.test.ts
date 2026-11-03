/**
 * 插件平台 P1a · 行协议（`src/plugin/protocol.ts`）
 *
 * 这一组只钉**分帧与错误码**：坏 JSON 不炸宿主、半行要等下一块、超长行只报一次、
 * 响应 id 原样回带。真正的"id 关联到具体请求"由 `plugin-runtime-node.test.ts` 用两个真实
 * 工具调用覆盖（那是跨进程的行为，用假进程测等于没测）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PLUGIN_PROTOCOL_VERSION,
  PLUGIN_RPC_ERRORS,
  PluginRpcError,
  RpcLineDecoder,
  encodeRpcError,
  encodeRpcNotification,
  encodeRpcRequest,
  encodeRpcResult,
  permissionDeniedError,
  unsupportedError,
} from '../src/plugin/protocol.ts';

test('编码：请求 / 结果 / 错误 / 通知都是"一行 JSON + \\n"', () => {
  const request = encodeRpcRequest(7, 'tool.register', { name: 'echo' });
  assert.equal(request.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(request), { jsonrpc: '2.0', id: 7, method: 'tool.register', params: { name: 'echo' } });

  assert.deepEqual(JSON.parse(encodeRpcResult(7, { ok: true })), { jsonrpc: '2.0', id: 7, result: { ok: true } });
  assert.deepEqual(JSON.parse(encodeRpcError(7, PLUGIN_RPC_ERRORS.permissionDenied, 'no')), {
    jsonrpc: '2.0', id: 7, error: { code: -32001, message: 'no' },
  });
  const notification = encodeRpcNotification('plugin.ready', { protocol: 1 });
  assert.equal('id' in (JSON.parse(notification) as Record<string, unknown>), false);
  assert.equal(PLUGIN_PROTOCOL_VERSION, 1);
});

test('解码：半行等下一块，一次 push 里多帧按序返回', () => {
  const decoder = new RpcLineDecoder();
  const first = decoder.push('{"jsonrpc":"2.0","id":1,"method":"tool.invoke","params":');
  assert.deepEqual(first, []);
  const second = decoder.push('{"name":"echo"}}\n{"jsonrpc":"2.0","id":1,"result":{"content":"hi"}}\n');
  assert.equal(second.length, 2);
  assert.deepEqual(second[0], { message: { jsonrpc: '2.0', id: 1, method: 'tool.invoke', params: { name: 'echo' } } });
  assert.deepEqual(second[1], { message: { jsonrpc: '2.0', id: 1, result: { content: 'hi' } } });
});

test('坏 JSON：只产出一条 failure，解码器继续读下一行（宿主不炸）', () => {
  const decoder = new RpcLineDecoder();
  const frames = decoder.push('这不是 JSON\n{"jsonrpc":"2.0","method":"plugin.ready"}\n');
  assert.equal(frames.length, 2);
  const failure = frames[0];
  assert.ok('failure' in failure, '第一帧必须是 failure');
  assert.match(failure.failure.reason, /JSON/i);
  const second = frames[1];
  assert.ok('message' in second, '坏行之后的那一帧照旧解出来');
});

test('缺 jsonrpc / 非对象 / id 类型不对：都算协议问题，不 throw', () => {
  const decoder = new RpcLineDecoder();
  const frames = decoder.push('{"id":1,"result":{}}\n[1,2,3]\n{"jsonrpc":"2.0","id":{},"result":1}\n');
  assert.equal(frames.length, 3);
  for (const frame of frames) assert.ok('failure' in frame, JSON.stringify(frame));
});

test('一行超过上限：只报一次并丢弃到下一个换行', () => {
  const decoder = new RpcLineDecoder({ maxLineBytes: 64 });
  const tooLong = `{"jsonrpc":"2.0","id":1,"result":"${'x'.repeat(100)}"}`;
  const frames = decoder.push(`${tooLong}\n{"jsonrpc":"2.0","method":"plugin.ready"}\n`);
  assert.equal(frames.length, 2);
  const failure = frames[0];
  assert.ok('failure' in failure);
  assert.match(failure.failure.reason, /上限/);
  assert.ok('message' in frames[1]);
});

test('错误码是稳定契约：标准段与本平台语义段各自的值', () => {
  assert.equal(PLUGIN_RPC_ERRORS.parseError, -32700);
  assert.equal(PLUGIN_RPC_ERRORS.invalidRequest, -32600);
  assert.equal(PLUGIN_RPC_ERRORS.methodNotFound, -32601);
  assert.equal(PLUGIN_RPC_ERRORS.invalidParams, -32602);
  assert.equal(PLUGIN_RPC_ERRORS.internalError, -32603);
  assert.equal(PLUGIN_RPC_ERRORS.permissionDenied, -32001);
  assert.equal(PLUGIN_RPC_ERRORS.timeout, -32002);
  assert.equal(PLUGIN_RPC_ERRORS.unsupported, -32003);
  assert.equal(PLUGIN_RPC_ERRORS.pluginExited, -32004);
  assert.equal(PLUGIN_RPC_ERRORS.isolated, -32005);
});

test('权限错误与"暂不支持"的错误消息必须能指路', () => {
  const denied = permissionDeniedError('demo', 'tools.define', 'tools.define');
  assert.ok(denied instanceof PluginRpcError);
  assert.equal(denied.code, PLUGIN_RPC_ERRORS.permissionDenied);
  assert.equal(denied.category, 'denied');
  assert.match(denied.message, /demo/);
  assert.match(denied.message, /tools\.define/);
  assert.match(denied.message, /permissions/);

  const unsupported = unsupportedError('net', 'P1a 不开放');
  assert.equal(unsupported.code, PLUGIN_RPC_ERRORS.unsupported);
  assert.match(unsupported.message, /net/);
  assert.match(unsupported.message, /不支持/);
});
