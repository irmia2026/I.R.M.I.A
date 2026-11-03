/**
 * P1a 的 TypeScript e2e 夹具：宿主用 `--experimental-strip-types` 直接加载 `.ts`。
 * 只用"能被类型擦除"的语法（不用 enum / namespace / 参数属性）。
 */

interface EchoArgs {
  text?: string;
}

interface PluginContext {
  tools: {
    define(definition: {
      name: string;
      description: string;
      schema?: Record<string, unknown>;
      handler: (args: EchoArgs) => Promise<{ content: string }>;
    }): Promise<void>;
  };
}

export async function activate(ctx: PluginContext): Promise<void> {
  await ctx.tools.define({
    name: 'echo',
    description: '原样回显 text（TS 入口 e2e）',
    schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: async (args: EchoArgs) => ({ content: `ts:${args.text ?? ''}` }),
  });
}
