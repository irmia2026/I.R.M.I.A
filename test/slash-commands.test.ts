/**
 * `/compact` 与 `/handoff` 的解析（B1 的第一步：只解析，不接线）。
 *
 * 钉的是"什么算指令、什么不算"——这几条边界就是这一项的全部风险所在：
 * 认宽了会把随口一句话当成"压缩上下文"，认窄了人打了半天没反应。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPACT_RECEIPT,
  HANDOFF_RECEIPT,
  parseSlashCommand,
} from '../src/runtime/slash-commands.ts';

test('两个指令都认，大小写不敏感', () => {
  assert.deepEqual(parseSlashCommand('/compact'), { kind: 'compact', name: 'compact', argument: '' });
  assert.deepEqual(parseSlashCommand('/handoff'), { kind: 'handoff', name: 'handoff', argument: '' });
  assert.equal(parseSlashCommand('/Compact')?.kind, 'compact');
  assert.equal(parseSlashCommand('/HANDOFF')?.kind, 'handoff');
});

test('首尾空白不影响；后面那句话是理由，不是别的东西', () => {
  assert.equal(parseSlashCommand('  /compact  ')?.kind, 'compact');
  const withReason = parseSlashCommand('/compact 上下文太长了，接下来要干长活');
  assert.equal(withReason?.kind, 'compact');
  assert.equal(withReason?.argument, '上下文太长了，接下来要干长活');
});

test('全角斜杠也认（中文输入法下打出全角是常事）', () => {
  assert.equal(parseSlashCommand('／compact')?.kind, 'compact');
  assert.equal(parseSlashCommand('／handoff 换班')?.argument, '换班');
});

test('一句话中间出现的不算——那是在谈论这个功能，不是在用它', () => {
  assert.equal(parseSlashCommand('我说的是 /compact 那个功能'), null);
  assert.equal(parseSlashCommand('这个 /handoff 是干嘛的？'), null);
  assert.equal(parseSlashCommand('先 /compact 一下'), null);
});

test('认不出来的斜杠词明确报回去，不当普通消息', () => {
  const unknown = parseSlashCommand('/clear');
  assert.equal(unknown?.kind, 'unknown');
  assert.equal(unknown?.name, 'clear', '要点名回话：让用户知道哪个词不认');
  // 打错字也要报回去（`/compcat` 形状像指令词，只是不在名单里）——这正是最容易 silently 吃掉的一种
  assert.equal(parseSlashCommand('/compcat')?.kind, 'unknown');
  // 单独一个斜杠、或空串：不是指令，也不是"不认识的指令"（没人会这么打）
  assert.equal(parseSlashCommand('/'), null);
  assert.equal(parseSlashCommand(''), null);
  assert.equal(parseSlashCommand('   '), null);
});

test('普通消息一律不认（别把她的日常输入吃掉）', () => {
  assert.equal(parseSlashCommand('今天几号'), null);
  // 以路径/网址开头的正常消息**不是**指令：形状就不像指令词，连"不认识的指令"都不该报
  // （否则用户贴一个 `/home/user/...` 会被回一句"没有这个指令 home/user"）
  assert.equal(parseSlashCommand('/home/user 这个路径'), null);
  assert.equal(parseSlashCommand('/tmp/a.txt'), null);
  assert.equal(parseSlashCommand('http://example.com'), null);
  assert.equal(parseSlashCommand('/compact.md'), null, '带点的也不是指令词');
});

test('收据文案必须说清"不可逆"与"原文还在"，且不出现价格字样', () => {
  // 这两句是人按下去之后唯一的解释来源：说错了比不说更糟
  assert.match(COMPACT_RECEIPT, /不可逆/u);
  assert.match(COMPACT_RECEIPT, /日志/u, '要说清原文还在日志里（否则人以为被删了）');
  assert.match(HANDOFF_RECEIPT, /下一个 turn/u);
  for (const text of [COMPACT_RECEIPT, HANDOFF_RECEIPT]) {
    assert.equal(/[元$€£]|价格|费用|花费|计费|美元|人民币/u.test(text), false, '用户明确不要计价');
  }
});
