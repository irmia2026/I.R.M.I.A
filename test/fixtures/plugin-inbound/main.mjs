/**
 * P1b 的 `message.received` 夹具。
 *
 * 过滤条件与行为从环境变量读（测试要按用例换 filter，而 ctx.hooks.on 的 filter 是
 * 订阅期定死的）。**过滤本身在宿主侧**——这个夹具只负责证明"没匹配到的消息它一次都没收到"。
 *
 *   IRMIA_TEST_INBOUND_FILTER        单个过滤对象
 *   IRMIA_TEST_INBOUND_FILTERS       多个过滤对象（数组；用来钉串行顺序）
 *   IRMIA_TEST_INBOUND_NO_FILTER=1   故意不传 filter（宿主必须拒绝订阅）
 *   IRMIA_TEST_INBOUND_MODE          rewrite | drop | context | throw | hang | observe
 */
const mode = process.env.IRMIA_TEST_INBOUND_MODE ?? 'rewrite';
const noFilter = process.env.IRMIA_TEST_INBOUND_NO_FILTER === '1';
const filtersRaw = process.env.IRMIA_TEST_INBOUND_FILTERS;
const singleRaw = process.env.IRMIA_TEST_INBOUND_FILTER;
const filters = filtersRaw !== undefined
  ? JSON.parse(filtersRaw)
  : [singleRaw === undefined ? { permission: 'all' } : JSON.parse(singleRaw)];
const marker = (index) => `[${process.env.IRMIA_PLUGIN_ID ?? 'plugin'}:${index}]`;

export async function activate(ctx) {
  let callCount = 0;
  for (let index = 0; index < filters.length; index += 1) {
    const handler = async (payload) => {
      callCount += 1;
      await ctx.state.plugin.set('calls', callCount);
      await ctx.state.plugin.set('last', payload);
      if (mode === 'throw') throw new Error('inbound boom');
      if (mode === 'hang') await new Promise(() => {});
      if (mode === 'drop') return { drop: true };
      if (mode === 'context') return { additionalContext: `ctx:${marker(index)}` };
      if (mode === 'observe') return undefined;
      return { text: `${payload?.text ?? ''} ${marker(index)}` };
    };
    if (noFilter) {
      // 宿主必须拒绝：message.received 没有过滤条件就是"读所有消息"，不能是默认值
      await ctx.hooks.on('message.received', handler);
    } else {
      await ctx.hooks.on('message.received', handler, filters[index]);
    }
  }
  await ctx.state.plugin.set('activatedAt', new Date().toISOString());
}
