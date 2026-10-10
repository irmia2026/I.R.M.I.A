/**
 * trust 测试 — src/runtime/trust.ts
 *
 * 这个模块决定**谁能指挥她**。断言的不是"函数返回了什么"，而是几条安全性质：
 *   • 群里 @ 她一律算外部（QQ 的 openid 按场景发放，"这个群成员是不是用户"根本判不出来）
 *   • 认不出来的来源按最严处理（将来新增唤醒类型，忘了登记也不会变成漏洞）
 *   • **配置里"图方便全开"压不过信任级**——否则"用户图省事"就等于"群里谁都能使唤她"
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { sidOf } from '../src/channel/sessions.ts';
import type { AppEvent } from '../src/log/types.ts';
import {
  EXTERNAL_TOOL_ALLOWLIST, modelVisibilityFor, strictest, trustOfBatch, trustOfWake,
} from '../src/runtime/trust.ts';

const OWNER = 'owner';
const GROUP = sidOf('qq-official', 'group-at', 'GROUP_OPENID');
const OWNER_C2C = sidOf('qq-official', 'c2c', 'OWNER_OPENID');
const STRANGER_C2C = sidOf('qq-official', 'c2c', 'STRANGER_OPENID');
const FRIEND_C2C = sidOf('qq-official', 'c2c', 'FRIEND_OPENID');

const CONTACTS = new Map<string, string>([
  [OWNER_C2C, OWNER],
  [FRIEND_C2C, '小王'],
]);

function evt(type: string, data: unknown): AppEvent {
  return { seq: 1, ts: '2026-10-01T00:00:00.000Z', type, data, visibility: 'model' } as unknown as AppEvent;
}

function channelWake(sid: string): AppEvent {
  const parts = sid.split(':');
  return evt('wake/channel', {
    channel: parts[0] === 'onebot' ? 'onebot' : 'qq-official',
    chatType: parts[1],
    chatId: parts.slice(2).join(':'),
    person: 'someone',
    text: '在吗',
    messageId: 'm1',
    msgSeq: 1,
  });
}

describe('信任级 · 她自己的活动与用户的话一样可信', () => {
  test('界面消息 → owner', () => {
    assert.equal(trustOfWake(evt('wake/manual', { note: 'x' }), CONTACTS, OWNER), 'owner');
  });

  test('心跳、意图、定时器、后台任务、看门目录 → self', () => {
    for (const type of ['wake/heartbeat', 'wake/intention', 'wake/timer', 'wake/job', 'wake/file']) {
      assert.equal(trustOfWake(evt(type, {}), CONTACTS, OWNER), 'self', type);
    }
  });

  test('看门目录的外部投递 → external（内容来源在机器之外）', () => {
    assert.equal(trustOfWake(evt('wake/webhook', {}), CONTACTS, OWNER), 'external');
  });

  test('认不出来的唤醒类型 → external（安全默认）', () => {
    assert.equal(trustOfWake(evt('wake/something-new', {}), CONTACTS, OWNER), 'external');
  });
});

describe('信任级 · 通道消息按会话认人', () => {
  test('联系人表里标成用户名字的单聊 → owner', () => {
    assert.equal(trustOfWake(channelWake(OWNER_C2C), CONTACTS, OWNER), 'owner');
  });

  test('记过名字但不是用户的单聊 → trusted', () => {
    assert.equal(trustOfWake(channelWake(FRIEND_C2C), CONTACTS, OWNER), 'trusted');
  });

  test('标签里带着用户名字的单聊 → 也算 owner（真实配置就是这种写法）', () => {
    // 2026-10-04 实测的根因：联系人表里用户的单聊写的不是光秃秃的 `OWNER`，而是
    // `用户（OWNER）`（那是**写给人看**的标签）。原来这里做字符串全等，于是用户的私聊
    // 被判成 trusted，destructive 工具整批从她视线里消失——她在 QQ 里说"我没看见 send_media"
    // 就是这么来的。全等之外，标签里带用户的名字也算。
    const labeled = new Map<string, string>([[OWNER_C2C, `用户（${OWNER}）`]]);
    assert.equal(trustOfWake(channelWake(OWNER_C2C), labeled, OWNER), 'owner');

    // 容错的边界：名字不沾边的照旧 trusted / external
    const friend = new Map<string, string>([[FRIEND_C2C, '小王']]);
    assert.equal(trustOfWake(channelWake(FRIEND_C2C), friend, OWNER), 'trusted');
    assert.equal(trustOfWake(channelWake(STRANGER_C2C), labeled, OWNER), 'external');

    // owner 配成空串时不认任何人（不许空串把所有人变成用户）
    assert.equal(trustOfWake(channelWake(OWNER_C2C), labeled, '  '), 'trusted');
  });

  test('没记过名字的单聊 → external', () => {
    assert.equal(trustOfWake(channelWake(STRANGER_C2C), CONTACTS, OWNER), 'external');
  });

  test('群里 @ 她 → 一律 external，哪怕那个群是用户的', () => {
    // QQ 的 openid 按场景发放：同一个人在群里与私聊拿到的不是同一个值，
    // 所以"这个群成员就是用户"这件事**技术上判不出来**。要破例得显式配置，不做默认。
    assert.equal(trustOfWake(channelWake(GROUP), CONTACTS, OWNER), 'external');
  });

  test('群里的普通发言（没 @）同样是 external', () => {
    const plain = sidOf('qq-official', 'group', 'GROUP_OPENID');
    assert.equal(trustOfWake(channelWake(plain), CONTACTS, OWNER), 'external');
  });

  /**
   * **同一个人在不同通道上有不同的 id**（2026-10-07 对齐 OneBot 时修的那条）。
   *
   * 官方那条路给的是 32 位 openid（`qq:c2c:E7FE…`），OneBot 那条路给的是**数字 QQ 号**
   * （`onebot:c2c:2175258788`）——两个值永不相等。`real-loop.ownerIds()` 原先从联系人表里
   * 只挑 `qq:c2c:` 那一种，于是**用户在 OneBot 群里被判成 external（客人）**：
   * `tools.groupSceneHardRefusal` 打开时她会拒掉本机类工具、或者要他"报一下身份"。
   *
   * 这一批的语义是"群里先说 external，除非那个 id 被**人**声明过"——所以下面右半段的
   * `OWNER_IDS` 就是 `ownerIds()` 的产物（联系人表里标成用户名字的那些 c2c 键的第三段）。
   * 用户在哪条通道上要被认出来，就往那张表里填那一条通道的 id：身份永远由人声明。
   */
  describe('用户在多条通道上：id 不同，声明过就都算', () => {
    const ONEBOT_OWNER_QQ = '2175258788';
    const ONEBOT_GROUP = sidOf('onebot', 'group-at', '987654321');
    /** `ownerIds()` 的产物：两个通道上的用户 id 同时在集合里（这正是修好之后的样子） */
    const OWNER_IDS = new Set<string>(['OWNER_OPENID', ONEBOT_OWNER_QQ]);

    /** 把 `channelWake` 的 person 换成指定的那个人（群里说话的是谁，是这条用例的自变量） */
    function asPerson(sid: string, person: string): AppEvent {
      const event = channelWake(sid);
      return { ...event, data: { ...event.data, person } } as unknown as AppEvent;
    }

    test('QQ 官方群里用户说话（openid 那一半）→ owner', () => {
      assert.equal(
        trustOfWake(asPerson(GROUP, 'OWNER_OPENID'), CONTACTS, OWNER, OWNER_IDS),
        'owner',
      );
    });

    test('OneBot 群里用户说话（数字 QQ 号那一半）→ owner，不是 external', () => {
      assert.equal(
        trustOfWake(asPerson(ONEBOT_GROUP, ONEBOT_OWNER_QQ), CONTACTS, OWNER, OWNER_IDS),
        'owner',
        '同一张联系人表里声明过的 OneBot id 必须同样给到最高档——否则她会拒绝帮用户做事',
      );
    });

    test('OneBot 群里的陌生人仍是 external（放宽的只是"被声明过的 id"）', () => {
      assert.equal(
        trustOfWake(asPerson(ONEBOT_GROUP, '10086'), CONTACTS, OWNER, OWNER_IDS),
        'external',
      );
      // 没给 ownerIds（老调用方/没配置）时照旧从严
      assert.equal(trustOfWake(asPerson(ONEBOT_GROUP, ONEBOT_OWNER_QQ), CONTACTS, OWNER), 'external');
    });
  });
});

describe('信任级 · 混合批次取最严', () => {
  test('用户说话 + 群里有人 @ 她 → 按 external 算', () => {
    const batch = [evt('wake/manual', { note: 'x' }), channelWake(GROUP)];
    assert.equal(trustOfBatch(batch, CONTACTS, OWNER), 'external');
  });

  test('心跳 + 用户私聊 → 仍是 owner 档（两档同宽）', () => {
    const batch = [evt('wake/heartbeat', {}), channelWake(OWNER_C2C)];
    assert.equal(trustOfBatch(batch, CONTACTS, OWNER), 'owner');
  });

  test('strictest 的偏序：external 压得住一切，owner 与 self 同宽', () => {
    assert.equal(strictest('owner', 'external'), 'external');
    assert.equal(strictest('trusted', 'self'), 'trusted');
    assert.equal(strictest('owner', 'self'), 'owner');
  });
});

describe('信任级 · 工具可见性（安全默认压过用户配置）', () => {
  test('外部来源：只看到白名单四件，配置里全开也不行', () => {
    const v = modelVisibilityFor('external', true);
    assert.deepEqual(v, { allowOnly: EXTERNAL_TOOL_ALLOWLIST });
    assert.ok(v.allowOnly?.includes('speak'));
    // safe_read / rg_search 都不是 destructive，但它们能读到 MEMORIES/
    // 里关于用户的事——对一个从群里来的陌生人同样不该给。它们不在白名单里，这就是那条界线。
    // （v42 起列目录并进 safe_read：`list_dir` 这个名字没了，但"能不能列目录"这件事
    //  跟着 safe_read 一起被挡在白名单之外——方向是收紧。）
    for (const name of ['safe_read', 'rg_search', 'pwsh', 'safe_write', 'write_persona']) {
      assert.ok(!v.allowOnly?.includes(name), `${name} 不该给外部来源`);
    }
  });

  test('trusted：不含 destructive——配置全开也压不过', () => {
    assert.deepEqual(modelVisibilityFor('trusted', true), { includeDestructive: false });
  });

  test('用户与她自己的轮次：按配置来（用户开了就开了）', () => {
    assert.deepEqual(modelVisibilityFor('owner', true), { includeDestructive: true });
    assert.deepEqual(modelVisibilityFor('self', true), { includeDestructive: true });
    assert.deepEqual(modelVisibilityFor('owner', false), { includeDestructive: false });
    assert.deepEqual(modelVisibilityFor('owner', ['pwsh']), { includeDestructive: ['pwsh'] });
  });
});
