/**
 * 六个能力族的钩子各试一次订阅（清单 permissions 为空）。
 * 每个应被宿主在 `hook.subscribe` 那一刻以 -32001 拒绝；插件不因此停止激活。
 */
export async function activate(ctx) {
  const results = {};
  const probes = {
    'model.request': () => ctx.hooks.on('model.request', () => ({})),
    'turn.start': () => ctx.hooks.on('turn.start', () => {}),
    'tool.before': () => ctx.hooks.on('tool.before', () => ({})),
    'reply.decorate': () => ctx.hooks.on('reply.decorate', () => ({})),
    'message.received': () => ctx.hooks.on('message.received', () => ({}), { permission: 'all' }),
    'command.before': () => ctx.hooks.on('command.before', () => ({})),
  };
  for (const [point, probe] of Object.entries(probes)) {
    try {
      await probe();
      results[point] = { code: null, message: 'ok' };
    } catch (error) {
      results[point] = {
        code: typeof error?.code === 'number' ? error.code : null,
        message: String(error?.message ?? error),
      };
    }
  }
  ctx.log.info(`HOOK_PERMISSION_RESULTS ${JSON.stringify(results)}`);
}
