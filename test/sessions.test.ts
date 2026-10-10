/**
 * 会话簿测试 — src/channel/sessions.ts
 *
 * 她认人、认场景全靠这份投影，所以两件事必须锁死：
 *
 *   ① **sid 与回投地址同形**：她说"发给谁"和系统"往哪发"必须指向同一个东西。
 *      两套口径的代价不是冗余，是「她以为发给了这个人、实际发到了另一个人」——
 *      这类错在日志里长得跟正常投递一模一样，最难查。
 *   ② **折叠与增量给出同一个答案**：启动时从日志全量折叠一次，之后每来一条通道消息
 *      增量并入。两条路算出不同的簿子，等于她记错了人。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CHANNEL_LABELS, CHAT_TYPE_LABELS, channelForNamespace, collectSessions,
  normalizeSid, parseAliases, parseMemberAliases, resolvePersonNameFromTables, applyAliases, parseSid,
  resolveSessionName, sessionLabelOf, sidLookupKeys, sidOf, upsertSession, type SessionEntry,
} from '../src/channel/sessions.ts';
import { replyUrlForWake } from '../src/tools/admin.ts';
import type { AppEvent, ChannelMessage, ChannelRead, WakeChannel } from '../src/log/types.ts';

function channelWake(
  data: Partial<WakeChannel['data']> & { chatId: string },
  seq: number,
  ts: string,
): AppEvent {
  return {
    seq,
    ts,
    type: 'wake/channel',
    data: {
      channel: 'qq-official',
      chatType: 'c2c',
      person: 'someone',
      text: '你好',
      messageId: `m${seq}`,
      msgSeq: 1,
      ...data,
    },
    visibility: 'model',
  } as unknown as AppEvent;
}

/** 只记账、不唤醒的那种通道消息（v32：QQ 是"手边的软件"，不是推给她的消息流） */
function channelMessage(
  data: Partial<ChannelMessage['data']> & { chatId: string },
  seq: number,
  ts: string,
): AppEvent {
  return {
    seq,
    ts,
    type: 'channel/message',
    data: {
      channel: 'qq-official',
      chatType: 'group',
      person: 'someone',
      text: '群里的一句',
      messageId: `m${seq}`,
      msgSeq: 1,
      ...data,
    },
    visibility: 'internal',
  } as unknown as AppEvent;
}

function channelRead(sid: string, upToSeq: number, seq: number, ts: string): AppEvent {
  return {
    seq,
    ts,
    type: 'channel/read',
    data: { sid, upToSeq } satisfies ChannelRead['data'],
    visibility: 'internal',
  } as unknown as AppEvent;
}

describe('sid · 与回投地址同形', () => {
  test('sidOf 与 replyUrlForWake 逐字节相同（一份标识两处用）', () => {
    const wake = { channel: 'qq-official', chatType: 'c2c' as const, chatId: 'OPENID_A' };
    assert.equal(sidOf(wake.channel, wake.chatType, wake.chatId), replyUrlForWake(wake));
    assert.equal(sidOf('qq-official', 'c2c', 'OPENID_A'), 'qq:c2c:OPENID_A');

    const onebot = { channel: 'onebot', chatType: 'group-at' as const, chatId: '12345' };
    assert.equal(sidOf(onebot.channel, onebot.chatType, onebot.chatId), replyUrlForWake(onebot));
    assert.equal(sidOf('onebot', 'group-at', '12345'), 'onebot:group:12345');
  });

  test('会话身份归一：群里 @ 过的与非 @ 的是**同一个会话**（2026-10-02 用户拍板）', () => {
    // 归一之前这两条会裂成 `qq:group:G1` 与 `qq:group-at:G1` 两个会话，代价是三件事一起歪：
    // 联系人表里给群起的名字只贴一份、关注只覆盖 @ 的那一份、清单里同一个群出现两行。
    assert.equal(sidOf('qq-official', 'group', 'G1'), sidOf('qq-official', 'group-at', 'G1'));
    assert.equal(sidOf('qq-official', 'group-at', 'G1'), 'qq:group:G1');
    // 单聊与频道不受影响（它们本来就只有一种写法）
    assert.equal(sidOf('qq-official', 'c2c', 'X'), 'qq:c2c:X');
    assert.equal(sidOf('qq-official', 'guild', 'C1'), 'qq:guild:C1');
  });

  test('normalizeSid：把旧记录里的 group-at 读成同一个会话（改口径不作废人写下的东西）', () => {
    assert.equal(normalizeSid('qq:group-at:G1'), 'qq:group:G1');
    assert.equal(normalizeSid('qq:group:G1'), 'qq:group:G1');
    assert.equal(normalizeSid('qq:c2c:X'), 'qq:c2c:X');
    assert.equal(normalizeSid('不是 sid'), '不是 sid', '形态不认得就原样返回，不猜');
    // 查名字时两种写法都试（旧联系人表、旧别名表都还认得）
    assert.deepEqual(sidLookupKeys('qq:group:G1'), ['qq:group:G1', 'qq:group-at:G1']);
    assert.deepEqual(sidLookupKeys('qq:c2c:X'), ['qq:c2c:X']);
  });

  test('parseSid 是 sidOf 的逆（含 chatId 里出现冒号的坏数据）', () => {
    assert.deepEqual(parseSid('qq:c2c:OPENID_A'), { namespace: 'qq', chatType: 'c2c', chatId: 'OPENID_A' });
    assert.deepEqual(parseSid('onebot:group-at:12345'), {
      namespace: 'onebot', chatType: 'group-at', chatId: '12345',
    });
    // chatId 里带冒号：整段留给 chatId，不丢字符（外部数据不可信，但不该被悄悄改）
    assert.equal(parseSid('qq:c2c:a:b')?.chatId, 'a:b');
  });

  test('parseSid 拒绝坏形态（不猜）', () => {
    for (const bad of ['', 'qq', 'qq:c2c', 'qq:c2c:', ':c2c:x', 'qq::x']) {
      assert.equal(parseSid(bad), null, `「${bad}」应判为非法`);
    }
  });

  test('命名空间反查通道名', () => {
    assert.equal(channelForNamespace('qq'), 'qq-official');
    assert.equal(channelForNamespace('onebot'), 'onebot');
  });

  test('显示名共用一套词（与 GUI 频道页同一张表）', () => {
    assert.equal(sessionLabelOf({ channel: 'qq-official', chatType: 'c2c' }), 'QQ 官方 Bot API · 单聊');
    assert.equal(sessionLabelOf({ channel: 'onebot', chatType: 'group-at' }), 'OneBot 11 · 群聊@');
    assert.equal(CHANNEL_LABELS['qq-official'], 'QQ 官方 Bot API');
    assert.equal(CHAT_TYPE_LABELS['group-at'], '群聊@');
  });
});

describe('会话簿 · 折叠', () => {
  test('按最后说话时间倒序，同一会话累计条数', () => {
    const entries = collectSessions([
      channelWake({ chatId: 'A', person: '甲', text: '第一条' }, 1, '2026-10-01T00:00:00.000Z'),
      channelWake({ chatId: 'B', person: '乙', text: '另一处' }, 2, '2026-10-01T00:01:00.000Z'),
      channelWake({ chatId: 'A', person: '甲', text: '又说了一句' }, 3, '2026-10-01T00:02:00.000Z'),
    ]);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.chatId, 'A', '最后说话的排最前');
    assert.equal(entries[0]?.messages, 2);
    assert.equal(entries[0]?.lastText, '又说了一句', '最近一条覆盖前一条');
    assert.equal(entries[0]?.lastSeenAt, '2026-10-01T00:02:00.000Z');
    assert.equal(entries[1]?.chatId, 'B');
  });

  test('群与私聊是不同会话（同一个人的两个身份不该混）', () => {
    const entries = collectSessions([
      channelWake({ chatId: 'G1', chatType: 'group-at', person: '甲', text: '群里说话' }, 1, '2026-10-01T00:00:00.000Z'),
      channelWake({ chatId: 'P1', chatType: 'c2c', person: '甲', text: '私聊说话' }, 2, '2026-10-01T00:01:00.000Z'),
    ]);
    assert.equal(entries.length, 2, '同一个人在不同场景是两个会话');
    assert.deepEqual(entries.map((e) => e.sid).sort(), ['qq:c2c:P1', 'qq:group:G1']);
  });

  test('同一个群的 @ 与非 @ 折成**一行**（归一的直接效果）', () => {
    const entries = collectSessions([
      channelMessage({ chatId: 'G9', chatType: 'group', person: '甲', text: '闲话' }, 1, '2026-10-01T00:00:00.000Z'),
      channelWake({ chatId: 'G9', chatType: 'group-at', person: '甲', text: '@她' }, 2, '2026-10-01T00:01:00.000Z'),
      channelMessage({ chatId: 'G9', chatType: 'group', person: '乙', text: '接着聊' }, 3, '2026-10-01T00:02:00.000Z'),
    ]);
    assert.equal(entries.length, 1, '一个群只有一个会话');
    assert.equal(entries[0]?.sid, 'qq:group:G9');
    assert.equal(entries[0]?.messages, 3, '来过多少条照旧全算');
    assert.equal(entries[0]?.chatType, 'group', '会话的类型是"这是个什么会话"，不是"这一条 @ 没 @ 我"');
  });

  test('非通道事件一律不进簿子', () => {
    const other = { seq: 9, ts: '2026-10-01T00:00:00.000Z', type: 'wake/manual', data: { note: 'x' }, visibility: 'model' };
    assert.deepEqual(collectSessions([other as unknown as AppEvent]), []);
  });

  test('lastText 压成一行并截断（她要认人，不需要全文）', () => {
    const long = '这是一段很长的消息'.repeat(20);
    const entries = collectSessions([channelWake({ chatId: 'A', text: `第一行\n第二行 ${long}` }, 1, '2026-10-01T00:00:00.000Z')]);
    assert.equal(entries[0]?.lastText.includes('\n'), false, '换行要压平');
    assert.ok((entries[0]?.lastText.length ?? 0) <= 61);
  });
});

describe('会话簿 · 名字从哪来', () => {
  test('优先级：框架联系人表 > 她的别名 > 她自己贴的 label > openid', () => {
    const entry = { sid: 'qq:c2c:X', label: '她贴的', person: 'OPENID' };
    // 人声明的事实最优先：一个认错用户的 agent，后面所有判断都是歪的
    assert.equal(resolveSessionName(entry, new Map([['qq:c2c:X', '用户']]), new Map([['qq:c2c:X', '她认的']])), '用户');
    assert.equal(resolveSessionName(entry, undefined, new Map([['qq:c2c:X', '她认的']])), '她认的');
    assert.equal(resolveSessionName(entry, undefined, undefined), '她贴的');
    assert.equal(resolveSessionName({ ...entry, label: null }, undefined, undefined), 'OPENID');
  });

  test('别名表解析：一行一条 `sid = 名字`，坏行跳过（不猜）', () => {
    const aliases = parseAliases([
      '# 身份别名',
      '',
      '- qq:c2c:X = 用户（OWNER）',
      'qq:group-at:G = 技术群',
      '这不是别名',
      'no-colon = 名字',
      'qq:c2c:Y =',
      '',
    ].join('\n'));
    assert.deepEqual(aliases.get('qq:c2c:X'), { name: '用户', note: 'OWNER' }, '列表写法也认；括号里是备注');
    assert.deepEqual(aliases.get('qq:group-at:G'), { name: '技术群' });
    assert.equal(aliases.size, 2, '无等号、键不带冒号、名字为空的都跳过');
  });

  test('别名里的备注：名字只取第一个括号之前，备注整段留着', () => {
    // 用户实测踩到的那一行（形如 aliases.md 第 10 行）：名字 + 口径一起写在等号右边，
    // 读取侧原来把整串当名字 → 界面那格窄、光标被顶到末尾，人看到的是备注的尾巴
    const line = 'qq:group:0AE5 = IRMIA框架测试群（10-04 18:15 用户拉我进来；**群友多是他的网友**——口径：不透露用户的私事，看情况淡着）';
    assert.deepEqual(parseAliases(line).get('qq:group:0AE5'), {
      name: 'IRMIA框架测试群',
      note: '10-04 18:15 用户拉我进来；**群友多是他的网友**——口径：不透露用户的私事，看情况淡着',
    });
  });

  test('空别名表与缺文件同样处理：不报错，退回 openid', () => {
    assert.equal(parseAliases('').size, 0);
    assert.equal(applyAliases([], new Map()).length, 0);
  });
});

/**
 * 发言人（`person`）→ 名字 —— src/channel/sessions.ts 的 `resolvePersonNameFromTables`
 *
 * 这一组锁的是 2026-10-11 修的那处缺口：她在 `aliases.md` 的 `# 群成员` 段里按段头那句
 * "只在认人时用"写下 `1269541505 = OWNER（用户）`，而框架原来只查合成出来的
 * `qq:c2c:<id>` / `onebot:c2c:<id>` 两个键——**她写在正确位置的身份声明一个字都没被看见**，
 * 于是用户第一次在 OneBot 群里露面时，那一行显示成机器发的一次性占位名「群友A（群昵称：用户）」，
 * 她当众回他"这会儿光一串号我还认不了你"（现场见 data/events 的 seq 41686 / 41733）。
 */
describe('发言人 → 名字 · 人写的三处', () => {
  const QQ = '1269541505';
  const OWNER = '用户（OWNER）';

  test('只有群成员别名（裸 id）也能认出来：这是原来断掉的那一档', () => {
    const memberAliases = parseMemberAliases(`# 该群成员\n${QQ} = OWNER（用户）（02:27 GUI 亲口认领）`);
    assert.equal(typeof memberAliases.get(QQ), 'object', '成员那一段进的是**另一张表**，不是会话表');
    assert.equal(parseAliases(`${QQ} = OWNER（用户）`).size, 0, '同一行不该进会话别名表（键不是 sid）');
    assert.equal(resolvePersonNameFromTables(QQ, undefined, undefined, memberAliases), 'OWNER');
  });

  test('权威顺序：联系人表 > 她会话别名 > 她群成员别名；查不到就 null（不编名字）', () => {
    const c2c = new Map([[`onebot:c2c:${QQ}`, '她会话里认的']]);
    const memberAliases = new Map([[QQ, { name: '她群成员段认的' }]]);
    // ① 联系人表（人声明的事实）压过她自己写的两处
    assert.equal(resolvePersonNameFromTables(QQ, new Map([[`onebot:c2c:${QQ}`, OWNER]]), c2c, memberAliases), OWNER);
    // ② 会话别名（更具体：那条记录说的是"这个人从这扇单聊门来过"）压过群成员段
    assert.equal(resolvePersonNameFromTables(QQ, undefined, c2c, memberAliases), '她会话里认的');
    assert.equal(resolvePersonNameFromTables(QQ, undefined, undefined, memberAliases), '她群成员段认的');
    // ③ 三处都没有 = null——占位名那一档**不在这里**（它要读盘，由 real-loop 接在最后）
    assert.equal(resolvePersonNameFromTables(QQ, undefined, undefined, undefined), null);
    assert.equal(resolvePersonNameFromTables('', new Map([[`onebot:c2c:${QQ}`, OWNER]]), undefined, undefined), null,
      '空 person 不查表');
    // ④ 空白名字当没有（不许把空格当名字）
    assert.equal(resolvePersonNameFromTables(QQ, undefined, undefined, new Map([[QQ, { name: '   ' }]])), null);
  });

  test('两条通道的 id 各自命中：官方 openid 与 OneBot QQ 号都能查', () => {
    const contacts = new Map([
      ['qq:c2c:E7FEC35E951B5CCF8BA66793BF6B1314', OWNER],
      [`onebot:c2c:${QQ}`, OWNER],
    ]);
    assert.equal(resolvePersonNameFromTables('E7FEC35E951B5CCF8BA66793BF6B1314', contacts, undefined, undefined), OWNER);
    assert.equal(resolvePersonNameFromTables(QQ, contacts, undefined, undefined), OWNER);
  });

  test('成员别名的解析口径与会话别名逐字对称（同一份文件、同一个 `裸 id = 名字`）', () => {
    const text = [
      '# 身份别名',
      'qq:c2c:E7FE = OWNER（用户）',
      '# 该群成员（openid，不是 sid；只在认人时用）',
      '- 1269541505 = **OWNER（用户）**——GUI 亲口认领那次',
      'B01F025D72D3B2075F49EFB08297D105 = 1 号',
      '这不是别名',
    ].join('\n');
    const members = parseMemberAliases(text);
    // 名字 = 第一个括号之前那一段（`splitAliasNote` 的既有口径，与会话别名**同一个**解析）。
    // 注意她那种 `**OWNER（用户）**` 的写法：粗体标记夹着括号时，`用户）**` 会落进备注
    // ——这不是这一版引入的，`parseAliases` 一直如此；两张表口径一致才是这里要钉的事。
    assert.deepEqual(members.get('1269541505'), { name: 'OWNER', note: '用户）**——GUI 亲口认领那次' });
    assert.deepEqual(members.get('B01F025D72D3B2075F49EFB08297D105'), { name: '1 号' });
    assert.equal(members.size, 2, 'sid 那类键不进成员表；坏行照旧跳过');
    assert.equal(parseAliases(text).size, 1, '两张表互补：会话表只收 sid 那类键');
  });
});

describe('会话簿 · 增量与折叠同口径', () => {
  test('逐条 upsert 与一次性 collectSessions 结果完全一致', () => {
    const events: AppEvent[] = [
      channelWake({ chatId: 'A', person: '甲', text: '一' }, 1, '2026-10-01T00:00:00.000Z'),
      channelWake({ chatId: 'B', person: '乙', text: '二' }, 2, '2026-10-01T00:01:00.000Z'),
      channelWake({ chatId: 'A', person: '甲', text: '三' }, 3, '2026-10-01T00:02:00.000Z'),
      channelWake({ chatId: 'C', person: '丙', text: '四' }, 4, '2026-10-01T00:03:00.000Z'),
    ];
    let book: SessionEntry[] = [];
    for (const event of events) book = upsertSession(book, event);
    assert.deepEqual(book, collectSessions(events), '启动折叠与运行期增量必须是同一个答案');
  });

  test('upsert 非通道事件：簿子不变（不是清空）', () => {
    const book = collectSessions([channelWake({ chatId: 'A', text: '在' }, 1, '2026-10-01T00:00:00.000Z')]);
    const manual = { seq: 2, ts: '2026-10-01T00:01:00.000Z', type: 'wake/manual', data: { note: 'x' }, visibility: 'model' };
    assert.deepEqual(upsertSession(book, manual as unknown as AppEvent), book);
  });

  test('空簿子起步也能长出来', () => {
    const book = upsertSession([], channelWake({ chatId: 'A', text: '第一次来' }, 1, '2026-10-01T00:00:00.000Z'));
    assert.equal(book.length, 1);
    assert.equal(book[0]?.messages, 1);
  });
});

// ──────────────────────────────── 未读（v32） ────────────────────────────────

describe('会话簿 · 两种事件与未读', () => {
  test('channel/message 同样进簿子（不叫她的那些也得记着）', () => {
    // 只认 wake/channel 的话，"群里积了多少条"这件事根本算不出来——而它正是
    // "她可以选择看不看"唯一的事实依据。两种事件共用一份折叠（见 sessions.ts）就是这个理由。
    const entries = collectSessions([
      channelMessage({ chatId: 'G1', person: '张三', text: '普通发言' }, 1, '2026-10-01T00:00:00.000Z'),
      channelMessage({ chatId: 'G1', person: '李四', text: '又一句' }, 2, '2026-10-01T00:01:00.000Z'),
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.sid, 'qq:group:G1');
    assert.equal(entries[0]?.messages, 2, '条数与 wake/channel 同一套累计');
    assert.equal(entries[0]?.lastText, '又一句');
  });

  test('信箱的未读：msgSeq 用事件 seq 时才数得对（读一次归零，再来再涨）', () => {
    // 这条锁的是 main.ts 那个 `appendWithSeq` 依赖的契约：平台给不出真序号时（OneBot 没 @ 的
    // 群消息填 0、官方全量群消息的事件体里没有这个字段），落库时把 **msgSeq 补成事件 seq**。
    // 不补的话每一条都是 0，`msgSeq > readUpToSeq` 永远不成立——她读一次之后未读永远是 0，
    // 于是"某群积累了 N 条"再也显示不出来，正好把这个信箱废掉。
    const sid = 'qq:group:G1';
    const three = collectSessions([
      channelMessage({ chatId: 'G1', msgSeq: 101 }, 101, '2026-10-01T00:00:00.000Z'),
      channelMessage({ chatId: 'G1', msgSeq: 102 }, 102, '2026-10-01T00:01:00.000Z'),
      channelMessage({ chatId: 'G1', msgSeq: 103 }, 103, '2026-10-01T00:02:00.000Z'),
    ]);
    assert.equal(three[0]?.unread, 3, '三条没看就是三条');

    // 她读了一次（upToSeq = 读到的那条）
    const afterRead = collectSessions([
      channelMessage({ chatId: 'G1', msgSeq: 101 }, 101, '2026-10-01T00:00:00.000Z'),
      channelMessage({ chatId: 'G1', msgSeq: 102 }, 102, '2026-10-01T00:01:00.000Z'),
      channelMessage({ chatId: 'G1', msgSeq: 103 }, 103, '2026-10-01T00:02:00.000Z'),
      channelRead(sid, 103, 104, '2026-10-01T00:03:00.000Z'),
    ]);
    assert.equal(afterRead[0]?.unread, 0, '读到 103 之后没有新的');

    // 再来两条新的：未读要重新涨起来
    const later = collectSessions([
      channelMessage({ chatId: 'G1', msgSeq: 101 }, 101, '2026-10-01T00:00:00.000Z'),
      channelRead(sid, 101, 102, '2026-10-01T00:03:00.000Z'),
      channelMessage({ chatId: 'G1', msgSeq: 103 }, 103, '2026-10-01T00:04:00.000Z'),
      channelMessage({ chatId: 'G1', msgSeq: 104 }, 104, '2026-10-01T00:05:00.000Z'),
    ]);
    assert.equal(later[0]?.unread, 2, '读过之后又来两条');
  });

  test('两种事件混在同一个会话里：条数与最后一条一起累加', () => {
    const entries = collectSessions([
      channelWake({ chatId: 'G1', chatType: 'group-at', person: '张三', text: '在吗' }, 1, '2026-10-01T00:00:00.000Z'),
      // 同一个会话必须是**同一个 chatType**（sid 里含它）：群聊@ 与群聊全量是两个会话，
      // 这不是实现细节而是语义——她"要不要理"的判据之一就是"这是点我的名还是群里的闲话"
      channelMessage({ chatId: 'G1', chatType: 'group-at', person: '李四', text: '他问你在不在' }, 2, '2026-10-01T00:01:00.000Z'),
    ]);
    assert.equal(entries.length, 1, '同群同 chatType 是一个会话');
    assert.equal(entries[0]?.messages, 2);
    assert.equal(entries[0]?.lastText, '他问你在不在');
  });

  test('未读 = msgSeq 大于已读位置的条数（没读过时全都算没看）', () => {
    const entries = collectSessions([
      channelMessage({ chatId: 'G1', msgSeq: 1 }, 1, '2026-10-01T00:00:00.000Z'),
      channelMessage({ chatId: 'G1', msgSeq: 2 }, 2, '2026-10-01T00:01:00.000Z'),
      channelMessage({ chatId: 'G1', msgSeq: 3 }, 3, '2026-10-01T00:02:00.000Z'),
    ]);
    assert.equal(entries[0]?.readUpToSeq, 0);
    assert.equal(entries[0]?.unread, 3, '一条都没读过时，全部算没看');
  });

  test('channel/read 把已读位置推高、未读归零', () => {
    const entries = collectSessions([
      channelMessage({ chatId: 'G1', msgSeq: 1 }, 1, '2026-10-01T00:00:00.000Z'),
      channelMessage({ chatId: 'G1', msgSeq: 2 }, 2, '2026-10-01T00:01:00.000Z'),
      channelRead('qq:group:G1', 2, 3, '2026-10-01T00:02:00.000Z'),
    ]);
    assert.equal(entries[0]?.readUpToSeq, 2);
    assert.equal(entries[0]?.unread, 0, '读到第 2 条 = 前两条都看过了');
  });

  test('已读之后来的新消息重新计入未读（读位只增不减）', () => {
    const entries = collectSessions([
      channelMessage({ chatId: 'G1', msgSeq: 1 }, 1, '2026-10-01T00:00:00.000Z'),
      channelRead('qq:group:G1', 1, 2, '2026-10-01T00:01:00.000Z'),
      channelMessage({ chatId: 'G1', msgSeq: 2 }, 3, '2026-10-01T00:02:00.000Z'),
      // 一条更早的已读记录（重放、或她回头又读了一段）：不许把未读弹回来
      channelRead('qq:group:G1', 1, 4, '2026-10-01T00:03:00.000Z'),
    ]);
    assert.equal(entries[0]?.readUpToSeq, 1, '读位只增不减');
    assert.equal(entries[0]?.unread, 1, '第 2 条还没看');
  });

  test('读位记在一个没来过的会话上：什么也不做（不凭空造会话）', () => {
    const entries = collectSessions([channelRead('qq:group:NEVER', 5, 1, '2026-10-01T00:00:00.000Z')]);
    assert.deepEqual(entries, [], '无主的读位不该让外部会话清单冒出一个"没说过话的会话"');
  });

  test('只认这两种通道事件与读位：别的 internal 事件一律不进簿子', () => {
    const other = {
      seq: 9, ts: '2026-10-01T00:00:00.000Z', type: 'channel/topic',
      data: { sid: 'qq:group:G1', topic: '在聊显卡', fromSeq: 1, toSeq: 2, count: 2 },
      visibility: 'internal',
    };
    assert.deepEqual(collectSessions([other as unknown as AppEvent]), [], '话题不是消息，不该长出会话');
  });

  test('逐条 upsert 与一次性 collectSessions 对未读给出同一个答案', () => {
    // 这条是 v32 最容易悄悄坏掉的地方：启动时折叠（走 collect）与运行期逐条并入（走 upsert）
    // 要是各算一套未读，重启前后她看到的数字就变了——而"她记错了别人说过几句"没人查得出来。
    const events: AppEvent[] = [
      channelMessage({ chatId: 'G1', msgSeq: 1 }, 1, '2026-10-01T00:00:00.000Z'),
      channelWake({ chatId: 'G2', chatType: 'group-at', msgSeq: 1 }, 2, '2026-10-01T00:01:00.000Z'),
      channelRead('qq:group:G1', 1, 3, '2026-10-01T00:02:00.000Z'),
      channelMessage({ chatId: 'G1', msgSeq: 2 }, 4, '2026-10-01T00:03:00.000Z'),
      channelMessage({ chatId: 'G2', chatType: 'group-at', msgSeq: 2 }, 5, '2026-10-01T00:04:00.000Z'),
    ];
    let book: SessionEntry[] = [];
    for (const event of events) book = upsertSession(book, event);
    assert.deepEqual(book, collectSessions(events), '启动折叠与运行期增量必须是同一个答案');
    assert.deepEqual(
      book.map((entry) => [entry.sid, entry.unread, entry.readUpToSeq, entry.messages]),
      // G2：第 1 条是**唤醒**（她当场看到了，不算积累）、第 2 条进信箱 → 未读 1，但总数仍是 2
      // G1：读位推到第 1 条，之后又来一条进信箱 → 未读 1
      [['qq:group:G2', 1, 0, 2], ['qq:group:G1', 1, 1, 2]],
      '未读只数进信箱的那些；唤醒过的那条她当场看过，不再算积累',
    );
  });

  test('upsert 认 channel/read：读完归零（运行期那条路也要生效）', () => {
    let book = upsertSession([], channelMessage({ chatId: 'G1', msgSeq: 1 }, 1, '2026-10-01T00:00:00.000Z'));
    assert.equal(book[0]?.unread, 1);
    book = upsertSession(book, channelRead('qq:group:G1', 1, 2, '2026-10-01T00:01:00.000Z'));
    assert.equal(book[0]?.unread, 0);
  });
});
