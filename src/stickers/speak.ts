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
      const selection = runtime.active(
        ctx.turn,
        resolved?.chatType ?? 'c2c',
        resolved?.channel ?? '',
        rawSticker,
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

      // 纯表情：发送与否都不进回执；发送失败只留内部 sticker/skipped 事件。
      if (text.trim() === '') {
        await send();
        return okResult('');
      }

      // 带文字：文字是唯一回执；表情成功/失败/跳过都不追加任何说明。
      const before = position === 'before';
      if (before) await send();
      const result = await base.handler(rawArgs, ctx);
      if (!before) await send();
      return result;
    },
  };
}
