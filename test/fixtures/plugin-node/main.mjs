/**
 * P1a 的 Node e2e 夹具。
 *
 * 它覆盖四件事（每件对应一条测试）：
 *   · `echo`    —— 注册工具、宿主调用、拿回结果；
 *   · `hang`    —— 永不返回（工具超时要杀进程）；
 *   · `crash`   —— 直接退出（崩溃 → 冷却重启一次 → 再崩停用）；
 *   · `tool.after` / `reply.decorate` —— 改写结果与出站文本；
 *   · `plugin.error` —— 别的插件失败时能观察到一个带 category 的载荷。
 */
export async function activate(ctx) {
  await ctx.tools.define({
    name: 'echo',
    description: '原样回显 text（e2e 用）',
    schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: async (args) => ({ content: `echo:${args?.text ?? ''}` }),
  });

  await ctx.tools.define({
    name: 'hang',
    description: '永不返回（超时用例）',
    schema: { type: 'object', properties: {} },
    handler: async () => await new Promise(() => {}),
  });

  await ctx.tools.define({
    name: 'crash',
    description: '立即退出（崩溃用例）',
    schema: { type: 'object', properties: {} },
    handler: () => { process.exit(3); },
  });

  await ctx.tools.define({
    name: 'config',
    description: '返回插件拿到的 config（schema 默认值）',
    schema: { type: 'object', properties: {} },
    handler: async () => ({ content: JSON.stringify(ctx.config) }),
  });

  // tool.after：语义是"结果已经产生、还没喂回模型之前"——这里给正文加个后缀
  await ctx.hooks.on('tool.after', (payload) => {
    if (typeof payload?.tool !== 'string' || !payload.tool.endsWith('__echo')) return null;
    return { content: `${payload.result?.content ?? ''} [after]` };
  });

  // reply.decorate：出站文本改写
  await ctx.hooks.on('reply.decorate', (payload) => ({ text: `${payload?.text ?? ''} [decorated]` }));

  // plugin.error：免权限的生命周期钩子——把最近一次错误写进插件状态，测试从盘上读
  await ctx.hooks.on('plugin.error', async (payload) => {
    await ctx.state.plugin.set('lastError', payload ?? null);
  });

  // plugin.loaded：同样免权限（它记录的是"这次进程起来了"）
  await ctx.hooks.on('plugin.loaded', async (payload) => {
    await ctx.state.plugin.set('loaded', payload?.id ?? '');
  });

  await ctx.state.plugin.set('activatedAt', new Date().toISOString());
  ctx.log.info('demo-node activated');
}
