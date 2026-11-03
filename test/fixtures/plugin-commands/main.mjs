/**
 * P1b 的 `ctx.commands.define` 夹具。
 *
 * 指令定义从 `IRMIA_TEST_COMMANDS`（JSON 数组）读；每一项：
 *   { name, aliases?, description?, permission?, args?, mode?, reply? }
 *
 * mode：
 *   · `throw` —— handler 抛错（宿主必须回宿主文案，不能把异常漏给用户）；
 *   · `hang`  —— 永不返回（宿主超时路径）；
 *   · 缺省    —— 回 `reply`（或 `pong:<args>`），并可带 `keepInContext`。
 */
const definitions = JSON.parse(process.env.IRMIA_TEST_COMMANDS ?? '[]');

export async function activate(ctx) {
  for (const definition of definitions) {
    await ctx.commands.define({
      name: definition.name,
      description: definition.description ?? '测试指令',
      permission: definition.permission ?? 'all',
      ...(definition.aliases === undefined ? {} : { aliases: definition.aliases }),
      ...(definition.args === undefined ? {} : { args: definition.args }),
      handler: async ({ args, message }) => {
        await ctx.state.plugin.set('lastCommand', { name: definition.name, args, messageId: message?.messageId ?? '' });
        if (definition.mode === 'throw') throw new Error('command boom');
        if (definition.mode === 'hang') await new Promise(() => {});
        const text = definition.reply ?? `pong:${JSON.stringify(args)}`;
        return {
          text,
          ...(definition.keepInContext === true ? { keepInContext: true } : {}),
          ...(definition.media === undefined ? {} : { media: definition.media }),
        };
      },
    });
  }
}
