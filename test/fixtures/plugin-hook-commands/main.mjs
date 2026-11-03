/**
 * `command.before` / `command.after` 夹具。
 *
 * `IRMIA_TEST_COMMAND_HOOK_MODE`:
 *   · `modify`（默认）：before 把 value 改成 `<原值>-before`，handler 应看到改后的 args；
 *   · `abort`：before 返回 `{abort:true}`，handler 与 command.after 都不该跑；
 *   · `error`：before 抛错（默认 errorPolicy=SKIP，handler 仍应按原参数执行）。
 */
const mode = process.env.IRMIA_TEST_COMMAND_HOOK_MODE ?? 'modify';

export async function activate(ctx) {
  await ctx.hooks.on('command.before', async (payload) => {
    await ctx.state.plugin.set('before', payload);
    if (mode === 'abort') return { abort: true, reason: 'fixture-abort' };
    if (mode === 'error') throw new Error('command.before boom');
    return { args: { ...payload.args, value: `${payload.args.value}-before` } };
  }, { timeoutMs: 1500, abort: true });

  // 第二个 blocking 订阅：证明登记顺序串行且能看到前一个改过的 args（链式载荷）。
  await ctx.hooks.on('command.before', async (payload) => {
    await ctx.state.plugin.set('before2', payload);
    if (mode === 'modify') return { args: { ...payload.args, value: `${payload.args.value}+second` } };
    return {};
  }, { timeoutMs: 1500, abort: true });

  await ctx.hooks.on('command.after', async (payload) => {
    await ctx.state.plugin.set('after', payload);
  });

  await ctx.commands.define({
    name: 'probe',
    description: '命名钩子测试指令',
    permission: 'all',
    args: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
    handler: async ({ args }) => {
      await ctx.state.plugin.set('handlerArgs', args);
      return { text: `probe:${String(args.value)}`, keepInContext: true };
    },
  });

  await ctx.state.plugin.set('activatedAt', new Date().toISOString());
}
