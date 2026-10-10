/**
 * Irmia Agent — **"正在输入"的投递口**（`speak` 开口前那一次；能力式接线，判据只有这一处）
 *
 * 用户 2026-10-11 拍板：「**只做正在输入。speak 时触发。**其他的暂时不管」。
 * 语义就一句话：她**开口说话之前**，先给通道发一个"正在输入"状态，让她看起来在打字。
 *
 * ## 为什么单独一个文件、而不是写在 `speak` 里
 *
 * 因为"哪条通道能发、哪个会话能发"是**通道侧的知识**，不是工具侧的知识。写进 `speak` 只有
 * 两种下场：按通道名 if（`if (channel === 'qq-official')`——名字会变、别名实例会漏，仓库里
 * 为这一条已经栽过四次，见 `onebot.isOneBotFamilyChannel` 的注释），或者把官方协议细节
 * （`msg_type: 6`、`input_notify`、仅单聊）泄进工具层。所以这里与 `channel/media-poster.ts`
 * 同一套成例：**工具侧只声明"我要发一个正在输入"，怎么发由通道自己说了算**。
 *
 * ## 三条判据（每一处都只有一份实现）
 *
 *   ① **认哪条通道**：`admin.parseReplyUrlAny`（与 `speak` 回投、`send_media` **同一份**——
 *      scheme → 通道名 + chatType + chatId）。这里不另造一套地址解析。
 *   ② **这条通道会不会发**：`typeof channel.sendInputNotify === 'function'`（**能力，不是名字**）。
 *      OneBot 没有这个方法 ⇒ 它上面 `speak` 照旧说话，只是没有"正在输入"这一下。
 *      这正是用户要的"**优雅跳过**，不是报错"。
 *   ③ **这个会话能不能发**：交回通道实现自己判（官方只有单聊有 `input_notify`，群聊那条路
 *      官方页压根没写 ⇒ `QqMessageSender.sendInputNotify` 里 `chatType !== 'c2c'` 就 skipped）。
 *      为什么不在这一层判 `chatType === 'c2c'`：那是**官方通道**的限制，不是"所有通道"的限制；
 *      将来某条通道在群里也能表示"正在输入"，改的应该是它自己，不是这里。
 *
 * ## 一条不可动摇的纪律：**失败绝不影响说话**
 *
 * 这个口子返回的三种结果（发成功 / 不会发 / 发失败），调用方（`speak`）的态度**完全一样**：
 * 照旧把话说出去。所以这里做两件事：
 *   • **不抛异常**——所有错误折成返回值（上层因此不需要 try/catch，也就不会有人"顺手"把它
 *     写成一个会冒泡的调用）；
 *   • **带默认超时**（`DEFAULT_INPUT_NOTIFY_TIMEOUT_MS`）——它发生在 `speak` 的第一个字
 *     出去**之前**，卡住它 = 卡住说话。超时只说明"这一下没赶上"，不是故障。
 */
import type { ChannelAdapter } from './qq-official.ts';
import { ONEBOT_CHANNEL_NAME, isOneBotFamilyChannel } from './onebot.ts';
import { parseReplyUrlAny, type ReplyTarget } from '../tools/admin.ts';

/**
 * 默认超时：**2.5 秒**。
 *
 * 为什么不是 15 秒（回投那条线）：这是一次"锦上添花"的请求，它站在 `speak` 的第一个字
 * 前面——超时预算就是"她开口前最多多等多久"的体感预算。2.5 秒是她感觉不到、而一条正常
 * 的 HTTPS 请求（同区域，实测我们发消息那条路是几十到几百毫秒）绰绰有余的量级。
 * 真撞上超时只会是"这一次没有正在输入"，绝不影响随后那几句话。
 */
export const DEFAULT_INPUT_NOTIFY_TIMEOUT_MS = 2_500;

/** 这一次"正在输入"的结果。三态分明：不会发（skipped）不是发失败（failed）。 */
export type InputNotifyPostResult =
  | { status: 'sent'; channel: string }
  /** 能力上就不发（通道没这个方法 / 这条会话类型不支持）——**预期内的静默**，不是错误 */
  | { status: 'skipped'; reason: string }
  /** 试了没成（网络、超时、平台拒）——调用方照旧说话，只是别把这一下当成"说过了" */
  | { status: 'failed'; reason: string };

/**
 * "正在输入"的投递口（`speak` 用）。
 *
 * 返回对象而不是裸函数：与 `ReplyPoster`/`MediaPoster` 同形（工具侧那边也是接口形状）。
 */
export interface InputNotifyPoster {
  notify(target: ReplyTarget): Promise<InputNotifyPostResult>;
}

/**
 * 造一个投递口。**装了它就等于"这条链路支持正在输入"**；不装（`main.ts` 里按配置决定）
 * 就是"一句话都不发"（用户要的"可关"）。
 */
export function createInputNotifyPoster(
  channels: ReadonlyMap<string, ChannelAdapter>,
  options: { timeoutMs?: number } = {},
): InputNotifyPoster {
  const timeoutMs = options.timeoutMs ?? DEFAULT_INPUT_NOTIFY_TIMEOUT_MS;
  return {
    async notify(target: ReplyTarget): Promise<InputNotifyPostResult> {
      // ① 认地址：判据与回投/媒体**同一份**（scheme → 通道名 + chatType + chatId）
      const parsed = parseReplyUrlAny(target.url);
      if (!parsed.ok) return { status: 'skipped', reason: parsed.error };
      // 别名实例也要认出 OneBot 家族（`isOneBotFamilyChannel`）：它没有"正在输入"能力，
      // 但**必须走"优雅跳过"那条路**，而不是去 QQ 通道表里找一个不存在的名字、
      // 再把"未装配"当成失败报出去。
      const channelName = isOneBotFamilyChannel(parsed.channel) ? ONEBOT_CHANNEL_NAME : parsed.channel;
      const channel = channels.get(channelName);
      if (channel === undefined) {
        return { status: 'skipped', reason: `${channelName} 通道未装配，正在输入跳过` };
      }
      // ② 能力判据**只有这一处**：有没有那个方法，不是它叫什么名字
      const sender = channel as ChannelAdapter & {
        sendInputNotify?: (
          chatType: string,
          chatId: string,
          options?: { msgId?: string },
        ) => Promise<
          | { ok: true }
          | { ok: false; skipped: true; reason: string }
          | { ok: false; skipped: false; reason: string }
        >;
      };
      if (typeof sender.sendInputNotify !== 'function') {
        return { status: 'skipped', reason: `${channelName} 通道没有"正在输入"这条能力` };
      }
      const timerRef: { handle: NodeJS.Timeout | null } = { handle: null };
      try {
        // ③ 会话类型那一层交给通道自己判（它才知道官方给不给）。
        //    `msgId` 原样带上：有它这条才算**被动窗口**里的动作，没它会被平台当成主动消息。
        const outcome = await Promise.race([
          sender.sendInputNotify(
            parsed.chatType,
            parsed.chatId,
            target.msgId === undefined ? {} : { msgId: target.msgId },
          ),
          new Promise<never>((_resolve, reject) => {
            timerRef.handle = setTimeout(() => {
              reject(new Error(`正在输入超时（${timeoutMs}ms）`));
            }, timeoutMs);
            // ⚠️ **刻意不 unref**（与 `createChannelReplyPoster` 那处不同）：那个计时器是"回投"
            // 这条主路上的兜底，进程里总还有别的事在跑；而"正在输入"可以在**一次同步流程的
            // 最前面**被调用（测试、CLI、以及任何一条消息都不在飞的空闲时刻）——unref 之后
            // 事件循环会在计时器到点之前判空退出，那一次 `notify` 就**永远不 settle**
            // （2026-10-11 实测：用例以 "Promise resolution is still pending but the event loop
            // has already resolved" 挂掉）。多持一个 2.5 秒的引用，换的是"这个 Promise 一定有个结局"。
          }),
        ]);
        if (outcome.ok) return { status: 'sent', channel: channelName };
        return outcome.skipped === true
          ? { status: 'skipped', reason: outcome.reason }
          : { status: 'failed', reason: outcome.reason };
      } catch (err) {
        // 超时与异常都在这里收口：**对调用方永远只有"返回值"这一种形态**
        return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
      } finally {
        if (timerRef.handle !== null) clearTimeout(timerRef.handle);
      }
    },
  };
}
