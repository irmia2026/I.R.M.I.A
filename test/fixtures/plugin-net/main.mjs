/**
 * P1b 的 `ctx.net.fetch` 夹具。
 *
 * 为什么只把**摘要**带回宿主：响应体上限 8MB，而插件 → 宿主的一帧也有 8MB 上限；
 * 把 8MB 正文原样塞回 JSON 帧会让协议层丢帧，看起来像"超时"——那是夹具制造的假故障。
 * 所以 `fetch` 返回 status / 头 / 长度 / 截断标记 / 小正文，测试要断言的都在这里。
 */
function summarize(result) {
  const data = result?.body?.data ?? '';
  const kind = result?.body?.kind ?? 'text';
  const length = kind === 'base64' ? Math.floor((data.length * 3) / 4) : Buffer.byteLength(data, 'utf8');
  return {
    status: result?.status ?? 0,
    headers: result?.headers ?? {},
    kind,
    length,
    truncated: result?.body?.truncated === true,
    redirects: result?.redirects ?? 0,
    url: result?.url ?? '',
    ...(data.length <= 4096 ? { data } : {}),
  };
}

export async function activate(ctx) {
  await ctx.tools.define({
    name: 'fetch',
    description: '经宿主代理做一次 net.fetch，并返回摘要（e2e 用）',
    schema: {
      type: 'object',
      properties: { url: { type: 'string' }, init: { type: 'object' } },
      required: ['url'],
    },
    handler: async (args) => {
      try {
        const result = await ctx.net.fetch(String(args?.url ?? ''), args?.init);
        return { content: JSON.stringify({ ok: true, result: summarize(result) }) };
      } catch (error) {
        return {
          content: JSON.stringify({
            ok: false,
            code: typeof error?.code === 'number' ? error.code : null,
            message: error instanceof Error ? error.message : String(error),
          }),
        };
      }
    },
  });
  await ctx.tools.define({
    name: 'allow',
    description: '返回插件拿到的 net.allow（只读视图）',
    schema: { type: 'object', properties: {} },
    handler: async () => ({ content: JSON.stringify([...ctx.net.allow]) }),
  });
}
