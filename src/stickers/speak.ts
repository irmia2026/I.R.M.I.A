import { argsRecord, okResult, type ToolDefinition, type ToolHandlerResult } from '../tools/types.ts';
import { parseReplyUrlAny, replyUrlForWake } from '../tools/admin.ts';
import type { ReplyTarget } from '../tools/admin.js';
import type { WakeChannel } from '../log/types.js';
import type { StickerRuntime } from './runtime.ts';
import { STICKER_TAGS } from './types.ts';

function targetOf(rawTo: string, current: WakeChannel['data'] | null, turn: number): { target: ReplyTarget; channel: string; chatType: string } | null {
  const url = rawTo === '' ? current === null ? null : replyUrlForWake(current) : rawTo;
  if (url === null) return null;
  const parsed = parseReplyUrlAny(url);
  if (!parsed.ok) return null;
  return { target: { url, idempotencyKey: `sticker-${turn}` }, channel: parsed.channel, chatType: parsed.chatType };
}

const STICKER_UNSENT_GENERIC = '这条通道不支持发图，或发送失败';

/** `active()` 的 skip reason → 给人（也给她）看的一句话。未知原因不猜，落到通用说明。 */
function stickerSkipText(reason: string | null): string {
  switch (reason) {
    case 'disabled': return '这个会话没开表情包（群聊默认关闭）';
    case 'turn-cap': return '这一轮已经发过一张表情了';
    case 'unknown-tag': return '没有这个表情标签';
    case 'no-candidates': return '库里没有这个标签的表情';
    default: return STICKER_UNSENT_GENERIC;
  }
}

function unsentNote(reason: string | null): string {
  return `（表情包没发：${stickerSkipText(reason)}）`;
}

function appendNote(result: ToolHandlerResult, note: string): ToolHandlerResult {
  return {
    ...result,
    content: result.content === '' ? note : `${result.content}\n${note}`,
  };
}

export function withStickerSpeak(
  base: ToolDefinition,
  runtime: StickerRuntime,
  currentWakeChannel: () => WakeChannel['data'] | null,
): ToolDefinition {
  const baseProperties = base.parameters['properties'];
  const properties = typeof baseProperties === 'object' && baseProperties !== null && !Array.isArray(baseProperties)
    ? baseProperties as Record<string, unknown>
    : {};
  return {
    ...base,
    description: `${base.description} 可带 sticker 附一张表情；只发图就留空 text`,
    parameters: {
      ...base.parameters,
      properties: {
        ...properties,
        sticker: {
          type: 'string',
          enum: STICKER_TAGS,
          description: `可选表情标签：${STICKER_TAGS.join('/')}。未知标签话照发、图跳过`,
        },
        stickerPos: {
          type: 'string',
          enum: ['after', 'before', 'only'],
          description: 'after 默认（先话后图）| before（先图后话）| only（只发图）',
        },
      },
      required: [],
    },
    handler: async (rawArgs, ctx): Promise<ToolHandlerResult> => {
      const args = argsRecord(rawArgs, 'speak');
      const rawSticker = args['sticker'];
      if (rawSticker === undefined) return await base.handler(rawArgs, ctx);
      const text = typeof args['text'] === 'string' ? args['text'] : '';
      const rawTo = typeof args['to'] === 'string' ? args['to'].trim() : '';
      const resolved = targetOf(rawTo, currentWakeChannel(), ctx.turn);
      let skipReason: string | null = null;
      const selection = runtime.active(
        ctx.turn,
        resolved?.chatType ?? 'c2c',
        resolved?.channel ?? '',
        rawSticker,
        (reason) => { skipReason = reason; },
      );
      const rawPosition = args['stickerPos'];
      const position = rawPosition === 'only' || text.trim() === ''
        ? 'only'
        : rawPosition === 'before' ? 'before' : 'after';
      const send = async (): Promise<boolean> => {
        if (selection === null) return false;
        return await runtime.deliver({
          ...selection,
          source: 'active',
          turn: ctx.turn,
          position,
          target: resolved?.target ?? null,
        });
      };

      // 只发图：没有任何文字回执可依托，必须把"没发出去"作为结果本身返回。
      if (text.trim() === '') {
        const sent = await send();
        return okResult(sent ? '（已发一张表情包）' : unsentNote(skipReason));
      }

      // 带文字：文字是主结果，照常交给 base.handler；表情的失败只能追加说明，
      // 不能吞掉（否则她读到的仍是一个"成功但什么都没说"的回执）。
      const before = position === 'before';
      const stickerSent = before ? await send() : null;
      const result = await base.handler(rawArgs, ctx);
      const sent = before ? stickerSent === true : await send();
      return sent ? result : appendNote(result, unsentNote(skipReason));
    },
  };
}
