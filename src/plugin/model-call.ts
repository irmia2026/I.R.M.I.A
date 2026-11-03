/**
 * `ctx.model.complete` 的请求装配（唯一一处）。
 *
 * 为什么单独一个文件：这是**插件触发的一次模型调用**，和主循环、vision、话题概括一样，
 * 它必须回答"这一发用什么思考档"——`test/thinking-effort-invariant.test.ts` 的源码扫描
 * 会数 `.generate(` / `.stream(` 出现几次，新调用点要么在这张表里认领，要么就是一次逃逸。
 * 放在 main.ts 里的话，那一处适配器（vision）与这一处会挤在同一个文件里，归因分不清；
 * 拆出来后，"插件这一发轻活走 light/low、重活走 heavy/high" 由一个纯函数说清。
 */

import type { DsClient, DsRequest, DsResponse } from '../model/ds-client.ts';
import type { PluginModelReply, PluginModelRequest } from './host-services.js';

/** tier → 思考档。两档都不接受插件自己指定 effort：思考强度不是插件能调的旋钮 */
export const PLUGIN_MODEL_EFFORTS = Object.freeze({ light: 'low', heavy: 'high' } as const);

/** 插件请求 → `DsClient` 的请求形状。纯函数，可单测（档位由这里定，调用点不拼）。 */
export function pluginModelRequest(request: PluginModelRequest): DsRequest {
  return {
    lane: request.tier,
    input: request.messages.map((message) => ({
      type: 'message' as const,
      role: message.role,
      content: message.content,
    })),
    reasoning: { effort: PLUGIN_MODEL_EFFORTS[request.tier] },
    ...(request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens }),
  };
}

export interface PluginModelCallResult {
  reply: PluginModelReply;
  response: DsResponse;
}

/** 真发出去一发，并把响应原样带回来（记账由调用方做：宿主才知道 log 在哪） */
export async function completePluginModel(
  client: Pick<DsClient, 'generate'>,
  request: PluginModelRequest,
): Promise<PluginModelCallResult> {
  const response = await client.generate(pluginModelRequest(request));
  const text = response.outputItems
    .map((item) => item.type === 'message' ? item.text : '')
    .join('');
  return {
    response,
    reply: {
      text,
      model: response.model,
      usage: { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens },
    },
  };
}
