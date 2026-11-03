/**
 * 入站消息的**唯一收口**（P1b）：插件过滤链 → 聊天指令 → 原有的唤醒/信箱分流。
 *
 * 为什么要把这三步放在一个模块里：它们共享同一个"这条消息接下来去哪儿"的结论。
 * 以前 `main.ts` 的 `onChannelMessage` 只做最后一步（唤醒还是进信箱）；P1b 在它前面插了
 * 两件会改变结论的事——插件可以改写/丢弃正文，**命中的聊天指令则根本不该进她的上下文**。
 * 三处各写一份判断，迟早出现"插件说 drop 了、消息还是被 wake 了"这种自相矛盾。
 *
 * 语义（可直接抄进开发文档）：
 *   · `message.received` 由宿主侧按订阅的 filter 筛选，**按注册顺序串行**；每条 2s 超时；
 *     任何一个插件报错/超时都只影响它自己——**消息原样继续**，绝不因为插件坏了而丢用户消息。
 *   · 钩子返回值：`{text}` 改写后续处理用的正文（链式）；`{drop:true}` 这条消息不再进任何
 *     上下文（也不进信箱）；`{additionalContext}` 追加到**本次唤醒**的提示里（`wake/channel`
 *     的 `pluginContext` 字段，渲染在外部消息框外）。
 *   · 指令：正文以 `/` 开头且第一个词命中注册名/别名才算；**命中后默认不进上下文**
 *     （只回结果），只有 handler 显式返回 `{keepInContext:true}` 才继续走唤醒/信箱。
 *     参数不合 schema 时由宿主回一句用法提示（插件不自己拼文案）。
 *   · 没命中任何指令 = 照常走原有流程（与 P1a 之前逐字相同）。
 *
 * 线程模型：`main.ts` 把消息**串行**送进来（等待前一条处理完）。这样同一个会话里
 * "先到的先 wake"成立，插件也不会看到两条消息交错改写。代价是插件慢会拖住后面的消息——
 * 这是 P1b 明确的取舍（每条订阅 2s 上限，且只有真的有人订阅时才走这条路）。
 */

import type { WakeChannel } from '../log/types.js';
import type {
  PluginCommandOutcome,
  PluginCommandReply,
  PluginMessageHookOutcome,
  PluginMessageReceivedPayload,
} from '../plugin/host-services.ts';

/** 宿主插件桥（`PluginHost` 结构上满足它；测试可以给替身） */
export interface InboundPluginBridge {
  hasInboundSubscriptions(): boolean;
  hasCommands(): boolean;
  dispatchMessageReceived(input: PluginMessageReceivedPayload): Promise<PluginMessageHookOutcome>;
  runCommand(input: { text: string; message: PluginMessageReceivedPayload }): Promise<PluginCommandOutcome | null>;
}

export interface InboundPipelineDeps {
  plugins: InboundPluginBridge;
  /** 现有分流判据（`channel/inbox.ts` 的 `shouldWakeForChannelMessage`） */
  shouldWake: (data: WakeChannel['data']) => boolean;
  /** 关键词提及判据（群聊里点名也算"在叫她"） */
  isMentioned: (text: string) => boolean;
  wake: (data: WakeChannel['data']) => void;
  inbox: (data: WakeChannel['data']) => void;
  /** 指令的回话出口（文本/媒体）；第二个参数是这条入站消息（回投目标） */
  reply: (reply: PluginCommandReply, data: WakeChannel['data']) => void | Promise<void>;
  log: (line: string) => void;
  now?: () => Date;
}

export type InboundAction = 'wake' | 'inbox' | 'dropped' | 'command';

export interface InboundOutcome {
  action: InboundAction;
  /** 处理完（可能被插件改写过）的正文 */
  text: string;
  additionalContext: string;
  /** 命中的指令规范名；没命中为 null */
  command: string | null;
  /** 实际被调用的 message.received 订阅数 */
  hookMatched: number;
}

const MAX_TEXT_CHARS = 20_000;
const MAX_CONTEXT_CHARS = 10_000;

/** `wake/channel` 的宿主内部 chatType → 插件看到的 group / private */
export function pluginChatTypeOf(chatType: WakeChannel['data']['chatType']): 'group' | 'private' {
  return chatType === 'c2c' ? 'private' : 'group';
}

/** 入站消息 → 插件载荷（`mentionsMe` 与落库事件同源：平台 @ 或适配器如实填的 true） */
export function pluginMessageOf(data: WakeChannel['data'], at: Date): PluginMessageReceivedPayload {
  return {
    channel: data.channel,
    chatType: pluginChatTypeOf(data.chatType),
    chatId: data.chatId,
    senderId: data.person,
    senderName: data.nickname ?? '',
    text: data.text,
    mentionsMe: data.mentionsMe === true || data.chatType === 'group-at',
    mediaCount: data.attachments?.length ?? 0,
    messageId: data.messageId,
    at: at.toISOString(),
  };
}

export class InboundPipeline {
  private readonly deps: InboundPipelineDeps;
  private readonly now: () => Date;

  constructor(deps: InboundPipelineDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * 处理一条入站消息。**不 throw**：插件层的任何异常都在这里收掉，退回"原样继续"。
   * 返回值只给测试/诊断用，生产调用方不依赖它。
   */
  async handle(data: WakeChannel['data']): Promise<InboundOutcome> {
    const deps = this.deps;
    const message = pluginMessageOf(data, this.now());
    let text = data.text.slice(0, MAX_TEXT_CHARS);
    let additionalContext = '';
    let hookMatched = 0;

    // ① 插件过滤链（有订阅才走；没有订阅时连一次 await 都不多）
    if (deps.plugins.hasInboundSubscriptions()) {
      try {
        const outcome = await deps.plugins.dispatchMessageReceived({ ...message, text });
        hookMatched = outcome.matched;
        text = outcome.text.slice(0, MAX_TEXT_CHARS);
        additionalContext = outcome.additionalContext.slice(0, MAX_CONTEXT_CHARS);
        if (outcome.drop) {
          deps.log(`[插件] 入站消息被 message.received 丢弃（${data.channel}/${data.chatType}/${data.messageId}）`);
          return { action: 'dropped', text, additionalContext: '', command: null, hookMatched };
        }
      } catch (error) {
        // 兜底：host-services 已经逐条吞掉插件错误，这里防的是宿主自身 bug。
        // **方向永远是"不丢消息"**：记一笔，按原文继续。
        deps.log(`[插件] message.received 分发异常（按原文继续）：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // ② 聊天指令：命中就默认不进上下文（keepInContext 例外）
    if (deps.plugins.hasCommands() && looksLikeCommand(text)) {
      let outcome: PluginCommandOutcome | null = null;
      try {
        outcome = await deps.plugins.runCommand({ text, message: { ...message, text } });
      } catch (error) {
        deps.log(`[插件] 指令分发异常（按普通消息继续）：${error instanceof Error ? error.message : String(error)}`);
      }
      if (outcome !== null) {
        if (outcome.reply !== null) {
          try {
            await deps.reply(outcome.reply, data);
          } catch (error) {
            deps.log(`[插件] 指令回话没发出去：${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (!outcome.keepInContext) {
          deps.log(`[插件] 指令 /${outcome.command} 命中：不进她的上下文（handler ${outcome.reply === null ? '未回话' : '已回话'}）`);
          return { action: 'command', text, additionalContext, command: outcome.command, hookMatched };
        }
      }
    }

    // ③ 原有分流：改写后的正文 + 关键词提及升级 + 插件附加上下文
    const mentioned = data.chatType !== 'c2c'
      && data.mentionsMe !== true
      && deps.isMentioned(text);
    const finalData: WakeChannel['data'] = {
      ...data,
      text,
      ...(mentioned ? { mentionsMe: true } : {}),
      ...(additionalContext === '' ? {} : { pluginContext: additionalContext }),
    };
    if (deps.shouldWake(finalData)) {
      deps.wake(finalData);
      return { action: 'wake', text, additionalContext, command: null, hookMatched };
    }
    deps.inbox(finalData);
    return { action: 'inbox', text, additionalContext, command: null, hookMatched };
  }
}

/** 便宜的前置判据：是不是"斜杠开头"的形状（全角斜杠也认，与既有指令解析同一口径） */
export function looksLikeCommand(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('/') || trimmed.startsWith('／');
}
