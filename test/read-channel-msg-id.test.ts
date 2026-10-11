/**
 * `read_channel` 每行带平台消息 id（`·m<id>`）—— **只对 OneBot 族**（2026-10-12）。
 *
 * 用户反馈的原话是"翻来翻去查 msg_id"。实测现场（报告 §1.4，事件 77368-77528 的 T1308 那一轮）：
 * 11 步里 6~7 步花在"找到那个 id"上——两次 `get_msg` 只为反查"这个 id 是谁"、两次 `pwsh`
 * 扫盘（其中一次白扫，"我的消息…: 0"）。id 明明一路都在（事件里有、宿主读出来了、
 * `ChannelMessageView.messageId` 里也有），**只有最后那个渲染函数不印它**。
 *
 * 这个文件钉四件事：
 *   ① OneBot 群里那一行**行尾带** `·m<id>`，且既有列（`▶ ` / `（我）` / 框 / 附件格）一个不动；
 *   ② **官方门一行都不印**（反面对照）——它的 id 是 117~137 字符的 `ROBOT1.0_…`，
 *      而本仓没有任何官方门撤回/删除路径 ⇒ 印它是"每行 +30.63 token 换一个没工具能用的串"；
 *   ③ 那个单元**不是既有含义的重载**：`#` 已经是"平台 message id"（别人的引用前缀 `[引用 #…]`）、
 *      裸数字是页脚游标（`before=<event seq>`）——所以 sigil 是 `·m`，且只在行尾；
 *   ④ `tools` 段零字节变化：id 要么按通道固定印、要么不印，**没有可选参数**（加参数 = 一次全 miss
 *      ≈9.6 万 token + 递 RENDER_VERSION + 用户批）。
 *
 * 为什么用 `createAdminTools` 而不是把 `renderReadBatch` 导出来单测：那个渲染器是**闭包内部**的
 * （它要用别名器、时间区、图片名额那些注入的口），导出它等于把内部形状变成契约。
 * 从工具的那一个调用点进去测，测的才是她真正读到的那一屏。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  MESSAGE_ID_MARK,
  createAdminTools,
  type ChannelMessageView,
  type ChannelReader,
} from '../src/tools/admin.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import type { ToolContext } from '../src/tools/types.ts';

const CTX: ToolContext = {
  callId: 'call_msgid',
  turn: 3,
  step: 1,
  signal: new AbortController().signal,
  workspaceRoot: process.cwd(),
};

/** 一条外部消息（**默认 OneBot 群**：这一批测的就是那条通道） */
function message(patch: Partial<ChannelMessageView> & { chatId: string }): ChannelMessageView {
  const chatType = patch.chatType ?? 'group';
  return {
    sid: `onebot:${chatType}:${patch.chatId}`,
    channel: 'onebot',
    chatType,
    person: '1269541505',
    text: '你好',
    messageId: '-754521710',
    msgSeq: 1,
    seq: 1,
    ts: '2026-10-11T16:32:00.000Z',
    ...patch,
  };
}

function toolkitWith(reader: ChannelReader) {
  return createAdminTools({
    timers: new TimerStore(null),
    emit: (() => {}) as never,
    channelReader: reader,
    timezone: 'Asia/Shanghai',
  });
}

/** 一屏读回来（sid 与夹具的 chatId 对上，`limit` 给足） */
async function readOneScreen(
  messages: readonly ChannelMessageView[],
  sid: string,
): Promise<string> {
  const tk = toolkitWith(async (_sid, limit) => messages.slice(-limit));
  const result = await tk.byName('read_channel').handler({ sid, limit: 20 }, CTX);
  assert.equal(result.isError, undefined, result.content);
  return result.content;
}

describe('read_channel · 每行带平台消息 id（只对 OneBot 族）', () => {
  test('OneBot 群：那一行**行尾**是 `·m<id>`，既有列一个不动', async () => {
    const screen = await readOneScreen([
      message({ chatId: 'G1', person: '甲', text: '显卡降价了', messageId: '-754521710', msgSeq: 1, seq: 100 }),
      message({ chatId: 'G1', person: '乙', text: '真的假的', messageId: '1762848739', msgSeq: 2, seq: 101 }),
    ], 'onebot:group:G1');

    // 逐字：`时间 谁：正文·m<id>`（中圆点无空格、紧贴正文尾部——它就是行尾那一格）
    assert.ok(screen.includes('10-12 00:32 甲：显卡降价了·m-754521710'),
      `id 要在行尾、且紧贴正文（不占既有列）：\n${screen}`);
    // **正数也要印**：OneBot 实测 4238 负 / 4256 正，不能假设都是负数
    assert.ok(screen.includes('乙：真的假的·m1762848739'),
      `正 id 同样要印（实测正负都有）：\n${screen}`);
    // 既有列：整批仍是一个框、`▶ ` 仍在行首、`（我）` 仍占"谁"那一格的位置
    assert.equal(screen.split('[external_event').length - 1, 1, '整批一个框这条不许被顺手改掉');
    assert.equal(screen.split('[/external_event]').length - 1, 1);
    // 没有 `#` 形态的 id（那是"别人的引用前缀"的符号，见上面文件头 ③）
    assert.equal(screen.includes('#-754521710'), false,
      `不许用 # 当 id sigil（# 已经是"平台 message id"的引用前缀含义）：\n${screen}`);
  });

  test('**反向**：官方门一行都不印（它的 id 没有可操作路径，印了是纯开销）', async () => {
    const official = await readOneScreen([
      message({
        chatId: 'A1B2C3', channel: 'qq-official', sid: 'qq:group:A1B2C3',
        person: 'OPENID_A', text: '群里的闲话',
        messageId: 'ROBOT1.0_YdytPHtQblDR7wktdBM-ejPElZkxNa4hYly4FMJFnQG0xUaafwmchbNxooxr14Uc5YtDoub8-rQNkmGkvKf7nb3ngGb.Wl-sLP-ZQpRmBmM!',
        msgSeq: 3, seq: 200,
      }),
    ], 'qq:group:A1B2C3');

    assert.ok(official.includes('群里的闲话'), `正文照给：\n${official}`);
    assert.equal(official.includes(MESSAGE_ID_MARK), false,
      `官方门不许印 id（本仓没有官方门的撤回/删除路径）：\n${official}`);
    assert.equal(official.includes('ROBOT1.0_'), false,
      `那串 117~137 字符的 token 一个字节都不该进这一屏：\n${official}`);
    // 说明那一句跟着 id 一起缺席：一个都没印就不解释一个没出现的东西
    assert.equal(official.includes('平台消息 id'), false,
      `没印 id 的一屏不该出现那句说明：\n${official}`);
  });

  test('**反向**：`get_*` 查询类没有副作用——读一屏不许冒出一个新概念（证明这是渲染、不是写）', async () => {
    // 这条钉的是"我只动了渲染"：同一批数据读两遍，逐字节一致（没有计数、没有一次性状态、
    // 没有"第一次印 id 第二次不印"那种隐式开关）。
    const messages = [
      message({ chatId: 'G1', person: '甲', text: '第一句', messageId: '111', msgSeq: 1, seq: 100 }),
      message({ chatId: 'G1', person: '乙', text: '第二句', messageId: '222', msgSeq: 2, seq: 101 }),
    ];
    const first = await readOneScreen(messages, 'onebot:group:G1');
    const second = await readOneScreen(messages, 'onebot:group:G1');
    assert.equal(first, second, '同一个输入两次读出**逐字节一致**的一屏（渲染没有一次性状态）');
    // 说明句只说一次（不是每行一句）：行数才是这个工具的硬预算
    assert.equal(first.split('平台消息 id').length - 1, 1, '那句说明整屏只出现一次');
  });

  test('**反向**：她的发言那一行不印 id（旧日志没有 id，读起来照旧）', async () => {
    // `ChannelSpoken` 是**另一类**行（`（我）`）。这一条测的是：`·m` 只跟外部消息那一行绑，
    // 而且宿主没给 `messageId` 时（旧日志 / 还没补上那一刀）这一屏**照旧读得出来**。
    const tk = createAdminTools({
      timers: new TimerStore(null),
      emit: (() => {}) as never,
      channelReader: async (_sid, limit) => [
        message({ chatId: 'G1', person: '甲', text: '别人说的', messageId: '-999', msgSeq: 1, seq: 100 }),
      ].slice(-limit),
      channelSpokenReader: async () => [
        { text: '我说的', ts: '2026-10-11T16:33:00.000Z', parts: 1, seq: 101, atMs: 0 },
      ],
      timezone: 'Asia/Shanghai',
    });
    const result = await tk.byName('read_channel').handler({ sid: 'onebot:group:G1' }, CTX);
    assert.equal(result.isError, undefined, result.content);
    assert.match(result.content, /（我）：我说的/u, `她那行照旧：\n${result.content}`);
    assert.equal(result.content.includes('我说的·m'), false,
      `她的行尾不许缀 id（这一刀没做——她的 id 在 speak/sent 里，见另一件事）：\n${result.content}`);
    // 别人的那行**照旧印**：这一条不是"把整屏关掉"
    assert.ok(result.content.includes('别人说的·m-999'), `别人的行仍然带 id：\n${result.content}`);
  });

  test('空 id 就不摆那个单元（宁可少一格，也不摆一个像 id 的坑）', async () => {
    const screen = await readOneScreen([
      message({ chatId: 'G1', person: '甲', text: '没有 id 的一条', messageId: '', msgSeq: 1, seq: 100 }),
    ], 'onebot:group:G1');
    assert.ok(screen.includes('甲：没有 id 的一条'), `正文照给：\n${screen}`);
    // 行尾不许留下一个孤零零的 sigil：`…一条·m` 会让她照着它去调工具
    assert.equal(/没有 id 的一条·m\s*$/mu.test(screen), false, `不许印空的 id 单元：\n${screen}`);
  });

  test('别名实例（`onebot-b`）同样印——判据是全仓那一个 `isOneBotFamilyChannel`', async () => {
    // 判据不另写一遍的**可观测后果**：别名实例也算 OneBot 家族（`isOneBotFamilyChannel` 覆盖
    // `onebot-<后缀>`）。这里顺带证明"用的是那一个函数"而不是手写 `channel === 'onebot'`。
    const screen = await readOneScreen([
      message({
        chatId: 'G9', channel: 'onebot-b', sid: 'onebot-b:group:G9',
        person: '丙', text: '别名实例的群', messageId: '-424242', msgSeq: 1, seq: 300,
      }),
    ], 'onebot-b:group:G9');
    assert.ok(screen.includes('别名实例的群·m-424242'),
      `别名实例也要印（判据是 isOneBotFamilyChannel，不是 channel === 'onebot'）：\n${screen}`);
  });
});
