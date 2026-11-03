/**
 * P1b 的两个小钩子夹具。
 *
 *   · `model.waiting`：可选 `IRMIA_TEST_WAIT_DELAY_MS` 延迟，用来证明宿主那侧确实不 await；
 *   · `channel.ready`：每收到一次就把 `readyCount` 加一并打一行日志——断线重连要能看到第二行。
 */
const waitDelayMs = Number(process.env.IRMIA_TEST_WAIT_DELAY_MS ?? '0');

export async function activate(ctx) {
  await ctx.hooks.on('model.waiting', async (payload) => {
    if (Number.isFinite(waitDelayMs) && waitDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitDelayMs));
    }
    ctx.log.info(`MODEL_WAITING ${JSON.stringify(payload ?? {})}`);
    await ctx.state.plugin.set('lastWaiting', payload ?? null);
  });
  await ctx.hooks.on('channel.ready', async (payload) => {
    ctx.log.info(`CHANNEL_READY ${JSON.stringify(payload ?? {})}`);
    const previous = (await ctx.state.plugin.get('readyCount')) ?? 0;
    await ctx.state.plugin.set('readyCount', Number(previous) + 1);
  });
}
