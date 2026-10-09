import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAllowedGroupMessage, withGroupPolicy, type GroupPolicy } from '../src/channel/group-policy.ts';
import { QQ_CHANNEL_NAME } from '../src/channel/qq-official.ts';
import { defaultConfig, loadConfig } from '../src/config/config.ts';
import type { WakeChannel } from '../src/log/types.ts';

function message(patch: Partial<WakeChannel['data']> = {}): WakeChannel['data'] {
  return { channel: QQ_CHANNEL_NAME, chatType: 'group-at', chatId: 'GROUP-A', person: 'member',
    text: 'hello', messageId: 'message-id', msgSeq: 1, ...patch };
}

const cases: Array<[string, GroupPolicy, string, boolean]> = [
  ['默认不限制', { allowedGroups: [], blockedGroups: [] }, 'GROUP-A', true],
  ['白名单内', { allowedGroups: ['GROUP-A'], blockedGroups: [] }, 'GROUP-A', true],
  ['白名单外', { allowedGroups: ['GROUP-B'], blockedGroups: [] }, 'GROUP-A', false],
  ['黑名单内', { allowedGroups: [], blockedGroups: ['GROUP-A'] }, 'GROUP-A', false],
  ['黑名单外', { allowedGroups: [], blockedGroups: ['GROUP-B'] }, 'GROUP-A', true],
  ['黑名单覆盖白名单', { allowedGroups: ['GROUP-A'], blockedGroups: ['GROUP-A'] }, 'GROUP-A', false],
];
for (const [label, policy, chatId, expected] of cases) {
  test(label, () => {
    for (const chatType of ['group', 'group-at'] as const) {
      assert.equal(isAllowedGroupMessage(message({ chatId, chatType }), policy), expected);
    }
  });
}

test('不影响私聊、频道和 OneBot（含别名）', () => {
  const policy = { allowedGroups: ['OTHER'], blockedGroups: ['GROUP-A'] };
  for (const chatType of ['c2c', 'guild', 'dm'] as const) {
    assert.equal(isAllowedGroupMessage(message({ chatType }), policy), true);
  }
  for (const channel of ['onebot', 'onebot-secondary']) {
    assert.equal(isAllowedGroupMessage(message({ channel }), policy), true);
  }
});

test('拒绝发生在下游唤醒、事件和信箱记录之前', () => {
  const stored: WakeChannel['data'][] = [];
  const receive = withGroupPolicy((data) => stored.push(data), { allowedGroups: ['GROUP-B'], blockedGroups: ['GROUP-A'] });
  receive(message());
  receive(message({ chatType: 'group', chatId: 'GROUP-C' }));
  assert.equal(stored.length, 0);
  receive(message({ chatId: 'GROUP-B' }));
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.chatId, 'GROUP-B');
});

test('首次默认配置和示例都包含空名单，缺省兼容旧配置', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-group-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const generated = await loadConfig(dir);
  assert.deepEqual(generated.config.channels.qqOfficial.allowedGroups, []);
  assert.deepEqual(generated.config.channels.qqOfficial.blockedGroups, []);
  const raw = JSON.parse(await readFile(generated.path, 'utf8'));
  assert.deepEqual(raw.channels.qqOfficial.allowedGroups, []);
  assert.deepEqual(raw.channels.qqOfficial.blockedGroups, []);
  const example = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(example.channels.qqOfficial.allowedGroups, []);
  assert.deepEqual(example.channels.qqOfficial.blockedGroups, []);
  const defaults = defaultConfig(dir);
  assert.equal(defaults.budget.turnSteps, 60);
  assert.equal(defaults.persona.compactionThresholdTokens, 100000);
});

test('解析群名单：去空白、去重、保留大小写与顺序', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-group-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'config.json'), JSON.stringify({ channels: { qqOfficial: {
    allowedGroups: [' GROUP-A ', 'GROUP-A', 'group-b'], blockedGroups: ['BLOCKED'],
  } } }));
  const config = (await loadConfig(dir)).config;
  assert.deepEqual(config.channels.qqOfficial.allowedGroups, ['GROUP-A', 'group-b']);
  assert.deepEqual(config.channels.qqOfficial.blockedGroups, ['BLOCKED']);
});

test('错误群名单明确拒绝，不静默当成允许全部', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-group-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const value of ['GROUP-A', [123], ['']]) {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ channels: { qqOfficial: { allowedGroups: value } } }));
    await assert.rejects(() => loadConfig(dir), /channels\.qqOfficial\.allowedGroups/u);
  }
});
