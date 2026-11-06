import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config/config.ts';
import {
  collectStatusLines, cpuUsagePercent, createStatusCommand, formatDuration,
  matchesStatusCommand, type CpuTimes, type StatusForwardSender,
} from '../src/channel/status-command.ts';
import { oneBotForwardNodes } from '../src/channel/onebot.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG = { users: ['3652971137', '10000'], triggers: ['sts', '状态'] };

test('匹配：白名单用户 + 整句完全相等（trim 后），子串不命中', () => {
  assert.equal(matchesStatusCommand({ person: '3652971137', text: 'sts' }, CONFIG), true);
  assert.equal(matchesStatusCommand({ person: '3652971137', text: '  sts  ' }, CONFIG), true, '首尾空格应被 trim');
  assert.equal(matchesStatusCommand({ person: '3652971137', text: '状态' }, CONFIG), true, '多个触发词都认');
  assert.equal(matchesStatusCommand({ person: '3652971137', text: 'status' }, CONFIG), false, '子串不算命中');
  assert.equal(matchesStatusCommand({ person: '3652971137', text: 'sts now' }, CONFIG), false);
  assert.equal(matchesStatusCommand({ person: '3652971138', text: 'sts' }, CONFIG), false, '非白名单用户');
  assert.equal(matchesStatusCommand({ person: '', text: 'sts' }, CONFIG), false);
});

test('formatDuration：天/小时/分/秒三档', () => {
  assert.equal(formatDuration(0), '0分0秒');
  assert.equal(formatDuration(200), '3分20秒');
  assert.equal(formatDuration(4 * 3600 + 12 * 60), '4小时12分');
  assert.equal(formatDuration(3 * 86400 + 4 * 3600), '3天4小时');
  assert.equal(formatDuration(-5), '0分0秒', '负数不编造');
});

const core = (idle: number, busy: number): { times: CpuTimes } => ({
  times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
});

test('cpuUsagePercent：两次采样的全核差分', () => {
  // 双核：每核 Δtotal=100，Δidle 分别为 50/100 → 占用 (200−150)/200 = 25%
  const before = [core(0, 0), core(0, 0)];
  const after = [core(50, 50), core(100, 0)];
  assert.equal(cpuUsagePercent(before, after), 25);
  assert.equal(cpuUsagePercent([core(0, 0)], [core(0, 100)]), 100, '全忙 = 100%');
  assert.equal(cpuUsagePercent([core(100, 0)], [core(200, 0)]), 0, '全闲 = 0%');
  assert.equal(cpuUsagePercent([], []), 0, '无核（假数据）不编造');
  assert.equal(cpuUsagePercent([core(10, 10)], [core(10, 10)]), 0, '无时间流动 = 0%');
});

function fakeProbe(overrides: Partial<Parameters<typeof collectStatusLines>[0]> = {}) {
  return {
    cpus: () => [
      { model: 'Fake CPU 6800H', times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
      { model: 'Fake CPU 6800H', times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
    ],
    totalmem: () => 16 * 1024 * 1024 * 1024,
    freemem: () => 8 * 1024 * 1024 * 1024,
    uptime: () => 90061,
    drive: (letter: string) => letter === 'C'
      ? { sizeBytes: 500 * 1024 * 1024 * 1024, freeBytes: 200 * 1024 * 1024 * 1024 }
      : null,
    ...overrides,
  };
}

test('collectStatusLines：系统行齐全，盘只报存在的', async () => {
  const slept: number[] = [];
  const lines = await collectStatusLines(fakeProbe(), async (ms) => { slept.push(ms); });
  assert.deepEqual(slept, [350], '采两拍 CPU，中间睡一拍');
  assert.equal(lines.length, 4);
  assert.match(lines[0]!, /Fake CPU 6800H（2 线程）占用 0%/);
  assert.match(lines[1]!, /内存：8\.0 \/ 16\.0 GB（50%）/);
  assert.match(lines[2]!, /磁盘（C:）：剩 200\.0 \/ 共 500\.0 GB/);
  assert.equal(lines[3], '开机：1天1小时');
});

test('createStatusCommand.match 只认 onebot 通道', () => {
  const cmd = createStatusCommand({ config: CONFIG, probe: fakeProbe(), sleep: async () => {} });
  assert.equal(cmd.match({ channel: 'onebot', chatType: 'c2c', chatId: '3652971137', person: '3652971137', text: 'sts' }), true);
  assert.equal(cmd.match({ channel: 'qq-official', chatType: 'c2c', chatId: '3652971137', person: '3652971137', text: 'sts' }), false);
});

test('handle：合并转发成功不走兜底；失败降级纯文本并记账', async () => {
  const logs: string[] = [];
  const cmd = createStatusCommand({
    config: CONFIG, probe: fakeProbe(), sleep: async () => {}, write: (line) => logs.push(line),
    extraLines: () => ['Irmia：0.1.0-test'],
  });
  const data = { channel: 'onebot', chatType: 'c2c', chatId: '3652971137', person: '3652971137', text: 'sts' };

  const calls: Array<Record<string, unknown>> = [];
  const okSender: StatusForwardSender = {
    sendForward: async (chatType, chatId, lines) => { calls.push({ kind: 'forward', chatType, chatId, lines }); return { ok: true }; },
    sendText: async () => { calls.push({ kind: 'text' }); return { ok: true }; },
  };
  await cmd.handle(data, okSender);
  assert.equal(calls.length, 1, '成功只发一次');
  assert.equal(calls[0]!.kind, 'forward');
  assert.equal((calls[0]!.lines as string[]).at(-1), 'Irmia：0.1.0-test', '宿主补充行在最后');
  assert.match(logs.at(-1)!, /合并转发 5 条/);

  calls.length = 0; logs.length = 0;
  const badSender: StatusForwardSender = {
    sendForward: async () => ({ ok: false, reason: 'unsupported action' }),
    sendText: async (chatType, chatId, text) => { calls.push({ kind: 'text', text }); return { ok: true }; },
  };
  await cmd.handle(data, badSender);
  assert.deepEqual(calls.map((c) => c.kind), ['text'], '转发被拒后降级纯文本');
  assert.match(String(calls[0]!.text), /CPU：.*\n/);
  assert.match(logs.at(-1)!, /unsupported action.*降级纯文本/);
});

test('oneBotForwardNodes：OneBot 11 节点形状', () => {
  const nodes = oneBotForwardNodes(['a', 'b'], { name: 'Irmia', uin: '1018168937' });
  assert.deepEqual(nodes, [
    { type: 'node', data: { name: 'Irmia', uin: '1018168937', content: [{ type: 'text', data: { text: 'a' } }] } },
    { type: 'node', data: { name: 'Irmia', uin: '1018168937', content: [{ type: 'text', data: { text: 'b' } }] } },
  ]);
});

test('config：statusCommand 解析——合法收下，非法报错，缺省关闭', async () => {
  const dir = tempDirSync('irmia-status-cfg-');
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    channels: { onebot: { statusCommand: { users: ['3652971137'], triggers: ['sts', '状态'] } } },
  }));
  const parsed = (await loadConfig(dir)).config;
  assert.deepEqual(parsed.channels.onebot.statusCommand, { users: ['3652971137'], triggers: ['sts', '状态'] });

  // 缺省 = 关闭
  const dir2 = tempDirSync('irmia-status-cfg-');
  mkdirSync(join(dir2, 'data'), { recursive: true });
  writeFileSync(join(dir2, 'config.json'), JSON.stringify({ channels: {} }));
  assert.equal((await loadConfig(dir2)).config.channels.onebot.statusCommand, undefined);

  // 空数组 = 配置错（"配了却不生效"不如直接报错）
  const dir3 = tempDirSync('irmia-status-cfg-');
  mkdirSync(join(dir3, 'data'), { recursive: true });
  writeFileSync(join(dir3, 'config.json'), JSON.stringify({
    channels: { onebot: { statusCommand: { users: [], triggers: ['sts'] } } },
  }));
  await assert.rejects(() => loadConfig(dir3), /users 不允许为空数组/);

  // QQ 号形态校验
  const dir4 = tempDirSync('irmia-status-cfg-');
  mkdirSync(join(dir4, 'data'), { recursive: true });
  writeFileSync(join(dir4, 'config.json'), JSON.stringify({
    channels: { onebot: { statusCommand: { users: ['abc'], triggers: ['sts'] } } },
  }));
  await assert.rejects(() => loadConfig(dir4), /5~13 位数字/);
});
