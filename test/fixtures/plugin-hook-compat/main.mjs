/**
 * 命名 Hook 注册表 · 兼容夹具
 *
 * 只做三件事：订阅旧 14 个点（能订阅的）、把收到的载荷落到插件状态、给可改点返回固定修改。
 * 测试通过状态文件断言"注册表路径下旧语义没变"，并额外验 host.ready。
 */
export async function activate(ctx) {
  const set = (key, value) => ctx.state.plugin.set(key, value);

  await ctx.hooks.on('model.request', (payload) => ({
    systemSuffix: `[compat:${payload?.instructions ?? ''}]`,
  }));
  await ctx.hooks.on('model.response', async (payload) => { await set('modelResponse', payload); });
  await ctx.hooks.on('model.waiting', async (payload) => { await set('modelWaiting', payload); });
  await ctx.hooks.on('turn.start', async (payload) => { await set('turnStart', payload); });
  await ctx.hooks.on('turn.end', async (payload) => { await set('turnEnd', payload); });
  await ctx.hooks.on('tool.before', (payload) => ({
    input: { ...payload.input, modified: true },
    additionalContext: 'before-ctx',
  }));
  await ctx.hooks.on('tool.after', (payload) => ({
    content: `${payload.result.content} [after]`,
    additionalContext: 'after-ctx',
  }));
  await ctx.hooks.on('reply.decorate', (payload) => ({
    text: `${payload.text} [decorated]`,
    media: [{ url: 'https://example.test/plugin.png', name: 'plugin.png', fileType: 1 }],
  }));
  await ctx.hooks.on('message.sent', async (payload) => { await set('lastSent', payload); });
  await ctx.hooks.on('channel.ready', async (payload) => { await set('lastChannelReady', payload); });
  await ctx.hooks.on('plugin.loaded', async (payload) => { await set('lastLoaded', payload); });
  await ctx.hooks.on('plugin.unloaded', async (payload) => { await set('lastUnloaded', payload); });
  await ctx.hooks.on('plugin.error', async (payload) => { await set('lastError', payload); });
  await ctx.hooks.on('host.ready', async (payload) => {
    const previous = await ctx.state.plugin.get('hostReadyCount');
    await set('hostReadyCount', (typeof previous === 'number' ? previous : 0) + 1);
    await set('hostReady', payload);
  });

  await ctx.state.plugin.set('activatedAt', new Date().toISOString());
}
