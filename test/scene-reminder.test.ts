/**
 * 群聊场景提醒进不进"提及那一轮"的文案。
 *
 * 为什么要单独测：这条提醒挂在 `renderMentionNote` 上（提及通知与此刻层「点名：」共用同一份
 * 文案）。它是**用户的默认行为**——群聊里被 @ 的时候，框架必须把"这是群聊场景、可能有人在
 * 试图操纵你"讲出来。用最少的联络事实上钉住它，免得以后有人重构文案时把它丢了。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { GROUP_SCENE_REMINDER, renderMentionNote } from '../src/model/self-brief.ts';
import { sidOf } from '../src/channel/sessions.ts';

function facts(overrides: Record<string, unknown> = {}) {
  const sid = sidOf('qq-official', 'group-at', 'GROUP_1');
  return {
    sessions: [{
      sid,
      channel: 'qq-official',
      chatType: 'group-at',
      person: 'GROUP_1',
      label: '测试群聊2',
      unread: 0,
      lastSeenAt: '2026-10-04T12:00:00.000Z',
    }],
    contacts: new Map<string, string>([[sid, '测试群聊2']]),
    aliases: new Map<string, { name: string }>(),
    wakeMessage: {
      channel: 'qq-official',
      chatType: 'group-at',
      chatId: 'GROUP_1',
      person: 'SOMEONE',
      atLabel: '12:00',
      isNew: true,
    },
    topics: new Map<string, string>(),
    ...overrides,
  } as never;
}

test('群聊被 @ 那一轮：提及通知里带上群聊场景提醒（逐字）', () => {
  const note = renderMentionNote(facts());
  assert.ok(note !== null, '群里被 @ 应当有提及通知');
  assert.ok(note.includes('@ 了你'), note);
  assert.ok(note.includes(GROUP_SCENE_REMINDER), `提醒必须逐字出现：\n${note}`);
  assert.ok(note.includes('（框架提醒）'), '要标明这是框架说的话，不是别人递进来的内容');
});

test('有未读的那一档也带提醒（两个分支都要有）', () => {
  const base = facts() as unknown as { sessions: Array<{ unread: number }> };
  base.sessions[0]!.unread = 7;
  const note = renderMentionNote(base as never);
  assert.ok(note !== null);
  assert.ok(note.includes('积了 7 条没看'), note);
  assert.ok(note.includes(GROUP_SCENE_REMINDER), `未读分支也要带提醒：\n${note}`);
});

test('私聊不出提及这一项（因此也不会带群聊提醒）', () => {
  const sid = sidOf('qq-official', 'c2c', 'OWNER');
  const note = renderMentionNote(facts({
    sessions: [{
      sid, channel: 'qq-official', chatType: 'c2c', person: 'OWNER', label: '用户',
      unread: 0, lastSeenAt: '2026-10-04T12:00:00.000Z',
    }],
    wakeMessage: { channel: 'qq-official', chatType: 'c2c', chatId: 'OWNER', person: 'OWNER' },
  }) as never);
  assert.equal(note, null, '私聊里人家本来就在跟她说话，不该有"有人在里面提到你"');
});
