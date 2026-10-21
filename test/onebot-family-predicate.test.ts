/**
 * 「这个通道是不是 OneBot 家族」—— **唯一一处判据**，四边共用（2026-10-08）。
 *
 * 为什么要有这一份测试：这条判据过去在仓库里被**硬编码写了四遍**，每处都是 `x === 'onebot'`：
 *   · `tools/admin.ts` 的 `replyUrlForWake`  ⇒ 别名实例（`onebot-b`）**回投地址造错命名空间**
 *     ⇒ 话**静默回投不出去**（没有任何报错，比投错更坏）；
 *   · `channel/sessions.ts` 的 `sidNamespaceOf` ⇒ 别名实例的会话被塞进 `qq:` 命名空间；
 *   · `channel/warn-exempt.ts` 的豁免名单 ⇒ 别名实例的"按会话豁免"永远不生效；
 *   · `channel/media-poster.ts` 的同款判定（今天不出错，但与上面那处是"同一件事的两份写法"）。
 * 通道名**可以是别名**（`OneBotClientOptions.channelName`，本仓测试用的就是 `'onebot-b'`），
 * 所以四处的判据都必须是"**是不是 OneBot 家族**"，而不是"名字等于默认名"。
 *
 * 下面的四条对应上级给的验收判据：① 默认名 · ② 别名实例 · ③ 非 OneBot 不误判 · ④ 两处同一判据。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { createMediaDispatcher } from '../src/channel/media-poster.ts';
import {
  ONEBOT_CHANNEL_NAME,
  isOneBotFamilyChannel,
  mapEventToWakeChannel,
} from '../src/channel/onebot.ts';
import { QQ_CHANNEL_NAME, type ChannelAdapter } from '../src/channel/qq-official.ts';
import { channelForNamespace, sidNamespaceOf } from '../src/channel/sessions.ts';
import { parseReplyUrlAny, replyUrlForWake } from '../src/tools/admin.ts';

/** 一条 OneBot 私聊事件（最小可用：只要有 message_id 与 user_id） */
function privateEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    post_type: 'message',
    message_type: 'private',
    message_id: 4242,
    user_id: 10001,
    raw_message: '在吗',
    ...overrides,
  };
}

describe('OneBot 家族判据：一处判据，覆盖别名实例', () => {
  // ── ① 默认通道名 ⇒ 回投成功 ────────────────────────────────────────────────
  test('① 默认通道名 onebot ⇒ 回投地址是 onebot: 命名空间，且读得回来', () => {
    const wake = { channel: ONEBOT_CHANNEL_NAME, chatType: 'c2c' as const, chatId: '10001' };
    const url = replyUrlForWake(wake);
    assert.equal(url, 'onebot:c2c:10001');
    // "写得出去"必须与"读得回来"同一口径——`replyableWakeChannel` 那道自检用的就是这一对
    assert.deepEqual(parseReplyUrlAny(url), {
      ok: true, channel: ONEBOT_CHANNEL_NAME, chatType: 'c2c', chatId: '10001',
    });
  });

  // ── ② 别名实例 ⇒ 回投成功（这一条过去是**静默失败**的） ─────────────────────
  test('② 别名实例（真起一个带 channelName 的）：回投地址照样是 onebot: 命名空间', () => {
    // 别名实例造出来的 wake：`channel` 就是它的通道名（`OneBotClientOptions.channelName`）
    const wake = mapEventToWakeChannel(privateEvent(), { channelName: 'onebot-b' });
    assert.ok(wake, '别名实例的事件必须映射得出 wake');
    assert.equal(wake.channel, 'onebot-b', '通道名如实带着别名');

    const url = replyUrlForWake(wake);
    // 修之前这里是 `qq:c2c:10001` ⇒ 回投到 QQ 命名空间 ⇒ **发不出去，且不报错**
    assert.equal(url, 'onebot:c2c:10001', '别名实例的回投地址必须落在 onebot: 命名空间');
    const parsed = parseReplyUrlAny(url);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.chatId, '10001', '回投目标还是那个人');
  });

  test('② 续：别名实例的会话命名空间也跟着对（否则会话与官方 QQ 混在一起）', () => {
    assert.equal(sidNamespaceOf('onebot-b'), 'onebot');
    assert.equal(sidNamespaceOf(`onebot-${'x'.repeat(3)}`), 'onebot');
    // 这一条是"回投地址与 sid 同形"的既有约定（sessions.test.ts 钉过默认名那一档）
    const wake = mapEventToWakeChannel(privateEvent(), { channelName: 'onebot-b' });
    assert.ok(wake);
    assert.equal(
      `${sidNamespaceOf(wake.channel)}:${wake.chatType}:${wake.chatId}`,
      replyUrlForWake(wake),
      'sid 与回投地址必须逐字节相同（一份标识两处用）',
    );
  });

  // ── ③ 非 OneBot 通道 ⇒ 不误判 ──────────────────────────────────────────────
  test('③ 非 OneBot 通道：一个都不许判成 OneBot', () => {
    for (const name of [QQ_CHANNEL_NAME, 'qq', 'snowluma', '', 'onebo', 'onebotx', 'x-onebot']) {
      assert.equal(isOneBotFamilyChannel(name), false, `不该把 ${JSON.stringify(name)} 判成 OneBot`);
    }
    // 缺字段（老事件里没有 channel）也不能误判
    assert.equal(isOneBotFamilyChannel(undefined), false);

    // 官方 QQ 那条路的行为一个字不许变
    const qqWake = { channel: QQ_CHANNEL_NAME, chatType: 'c2c' as const, chatId: 'openid-1' };
    assert.equal(replyUrlForWake(qqWake), 'qq:c2c:openid-1');
    assert.equal(sidNamespaceOf(QQ_CHANNEL_NAME), 'qq');
  });

  test('③ 续：**别名实例的地址**要派到 OneBot 的投递口，不能派给官方 QQ', () => {
    const used: string[] = [];
    const adapter = (name: string): ChannelAdapter => ({
      name,
      start: () => {},
      stop: () => {},
      sendText: async () => ({ ok: true as const, messageId: 'M', passive: false, msgSeq: 1 }),
      sendMediaTo: async () => {
        used.push(name);
        return { ok: true as const, messageId: 'M', passive: false, msgSeq: 1 };
      },
    } as unknown as ChannelAdapter);
    const dispatcher = createMediaDispatcher(new Map([
      [ONEBOT_CHANNEL_NAME, adapter(ONEBOT_CHANNEL_NAME)],
      [QQ_CHANNEL_NAME, adapter(QQ_CHANNEL_NAME)],
    ]));

    // 别名实例造出来的地址（`onebot:` scheme）⇒ 必须走 OneBot 那一支
    return dispatcher
      .post({ url: 'onebot:c2c:10001', idempotencyKey: 'k' }, { fileType: 'image', data: 'AA==' })
      .then((outcome) => {
        assert.deepEqual(used, [ONEBOT_CHANNEL_NAME], 'OneBot 的地址只能派给 OneBot 的投递口');
        assert.equal(typeof outcome.ok, 'boolean');
      });
  });

  // ── ④ 两处走同一判据（防止下次只改一处） ────────────────────────────────────
  test('④ admin 与 media-poster 必须共用同一个谓词，都不许再写名字相等', () => {
    const root = join(import.meta.dirname, '..', 'src');
    const sites: Array<{ file: string; label: string }> = [
      { file: join(root, 'tools', 'admin.ts'), label: 'tools/admin.ts（replyUrlForWake）' },
      { file: join(root, 'channel', 'media-poster.ts'), label: 'channel/media-poster.ts' },
    ];
    for (const site of sites) {
      const text = readFileSync(site.file, 'utf8');
      assert.match(text, /isOneBotFamilyChannel\(/u, `${site.label} 必须用共用谓词`);
      // 名字相等的老写法一处都不许留（注释里的说明不算：先剥掉行注释再看）
      const code = text
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
        .join('\n');
      assert.doesNotMatch(
        code,
        /===\s*(?:ONEBOT_CHANNEL_NAME|'onebot')/u,
        `${site.label} 里还有"通道名相等"的老写法——这就是"只改了一处"的开端`,
      );
    }
    // 另外两处（同一条硬编码的第三、四份）也必须收齐
    for (const extra of ['channel/sessions.ts', 'channel/warn-exempt.ts']) {
      const text = readFileSync(join(root, extra), 'utf8');
      assert.match(text, /isOneBotFamilyChannel\(/u, `${extra} 必须用共用谓词`);
    }
  });

  test('④ 续：谓词定义的**只有一处**（不许在别处再定义一份）', () => {
    const root = join(import.meta.dirname, '..', 'src');
    for (const file of ['tools/admin.ts', 'channel/media-poster.ts', 'channel/sessions.ts', 'channel/warn-exempt.ts']) {
      const text = readFileSync(join(root, file), 'utf8');
      assert.doesNotMatch(
        text,
        /(?:function|const)\s+isOneBotFamilyChannel/u,
        `${file} 自己又定义了一份判据——必须 import 那一处`,
      );
    }
  });

  test('④ 续：sid 命名空间反查通道名今天仍丢掉别名（已知，未在本笔修）', () => {
    // 如实记一条**已知限制**，免得下一个人以为这里也修好了：
    // `channelForNamespace` 是"命名空间 → 通道名"的反查，而 sid 里的命名空间是**归一过的**
    // （`onebot-*` → `onebot`），信息已经丢了。要修得先让 sid 保留别名，那是契约改动。
    assert.equal(channelForNamespace('onebot'), ONEBOT_CHANNEL_NAME);
  });
});
