/**
 * **Chat Completions 协议实现**（`ModelTransport` 的 Chat 那一份）。
 *
 * 依据：`docs/design-protocol-fallback.md` §3.1（请求体 24 行差异表）、§3.7（DeepSeek 官方 21 条
 * 硬事实逐条落点）、§3.2 / §3.3 / §3.4（流式事件 / usage / 结束原因）、§3.6（归一化）。
 *
 * ## 四条纪律（写在这里，免得后来人顺手改坏）
 *
 * 1. **不发 `reasoning`**：Chat 没有"回传思维链"这条义务（`reasoning_content` 是**响应侧**字段），
 *    且 DeepSeek 口径是上一轮的推理不进下一轮上下文。我们**只展示、不回传**（§7.2）。
 * 2. **不发 `user` / `user_id`**：字段名两边不同（Responses 叫 `user`、DeepSeek Chat 叫 `user_id`），
 *    发错名字的风险（400 全挂）大于缓存亲和的收益（单租户不需要隔离）。§3.1 第 19 行。
 * 3. **不发 `stream_options` / `tool_choice` / `frequency_penalty` / `presence_penalty`**：
 *    前两个各有一个"对端不认就 400"的面，后两个官方已废弃（§3.1 第 18/21/23 行）。
 * 4. **不发 `tools` 空数组**：与 Responses 一样"有值才发"（空数组在部分对端会被拒）。
 *
 * ## 一条有损但必须做的降级：`json_schema` → `json_object` + 一条 system 指令
 *
 * DeepSeek Chat 的 `response_format.type` **只认 `text` / `json_object`**（没有 `json_schema`）。
 * 而 5 个 light 调用点全用 `json_schema`（注入判定 / 话题 / 记忆整理×2 / 视觉）。
 * 只改成 `json_object` **不够**：官方文档明写"用 JSON 模式时必须通过 system 或 user 消息指示模型
 * 生成 JSON，否则模型可能不停输出空白字符直到 token 上限"——而 `memory-maintain` 的两条 prompt
 * 里**根本没写"输出 JSON"**（`MERGE_INSTRUCTIONS` / `DIARY_INSTRUCTIONS`）。
 * ⇒ 必须由这里补一条 system 指令（"只输出 JSON" + 紧凑 schema）。不补 = 一次 64K 的空白账单。
 *
 * ## 已知的层叠小疤（如实记）
 *
 * `hasUsableOutput` / `hasPartialOutput` 这两个**协议无关**的判据现在住在 `responses.ts`（它先落地），
 * 本文件直接 import 它们。它们本该独立成文件——那是一次纯搬迁，**不在 C 里做**
 * （C 的判据是"每接一处都重跑字节判据"，多一次搬迁就多一次风险面）。
 */

import { DsClientError } from '../ds-client.ts';
import type {
  DsIncompleteReason,
  DsInputContentPart,
  DsInputItem,
  DsOutputItem,
  DsRequest,
  DsResponse,
  DsStatus,
  DsStreamCallbacks,
  DsStreamResult,
  DsUsage,
} from '../ds-client.js';
import { hasPartialOutput, hasUsableOutput } from './responses.ts';
import type { SseFrame } from './sse.js';
import type {
  ModelTransport,
  ParseStreamContext,
  StreamAccumulator,
  TransportBuildContext,
  TransportErrorInput,
  TransportRequest,
  TransportSendContext,
} from './types.js';

/** 服务端错误正文截断（与 `ds-client.ts` 的 `ERROR_DETAIL_LIMIT` 同一个口径：2,000） */
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,128}$/u;

const ERROR_DETAIL_LIMIT = 2_000;

// ──────────────────────────────── Chat 的消息形状 ────────────────────────────────

type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

/**
 * `json_schema` 降级时补的那条 system 指令。
 *
 * 措辞要同时满足两件事：① 官方要求的"指示模型生成 JSON"；② 把**形状**告诉它（`json_object`
 * 只保证"是合法 JSON"，不保证"是我们要的那个形状"）。
 * 确定性：`JSON.stringify(schema)` 的键序来自调用点写死的字面量 ⇒ 同一份请求永远同一串字节。
 */
function jsonInstructionOf(text: DsRequest['text']): string | null {
  if (text === undefined || text.type !== 'json_schema') return null;
  return '只输出 JSON（一个对象，不要代码围栏，不要解释文字）。字段与类型如下：\n'
    + JSON.stringify(text.schema);
}

/**
 * 一条 message item 的 content → Chat 的 content。
 *
 * ★ **图片的角色限制**（官方硬规则，2026-10-21 C-4 补）：图片**只能**放在
 * `user` / `developer` 消息里（以及 `function_call_output`）；放在 `system` / `assistant`
 * 里对端直接 400。而渲染层**只会**把图挂在 `role:'user'` 上（
 * `render.ts:2772/4998/5114` 三处），所以这条守卫在今天的生产路径上**一次都不会触发**。
 *
 * 为什么是“丢图保文”而不是“报错”：一张图摆错了位置，代价不该是**整条请求失败**（那是
 * 一整拍的信息丢失 + 一次重试）；而被丢的图不会惄不作声：渲染层的 `image/trace`
 * 与 vision 回执本来就会告诉她“这张没进/没压成”（与协议无关）。
 * 一个字节都不改写：**图片 URL 原样透传**（data URL 不重编码、不截断、不转直链）
 * ——“两套协议字节一致”就是这一行保证的。
 */
function toChatContent(
  item: Extract<DsInputItem, { type?: 'message' }>,
  role: ChatMessage['role'],
): string | ChatContentPart[] {
  if (typeof item.content === 'string') return item.content;
  const imagesAllowed = role === 'user' || role === 'system';
  const parts: ChatContentPart[] = [];
  for (const part of item.content) {
    if (part.type === 'input_image') {
      // 注意：developer 已经在调用处映射成了 system（声明在 messages 里就是 system），
      // 而官方口径里 developer 与 system 都属于“可以带图”的那一档。
      if (!imagesAllowed) continue;
      parts.push({ type: 'image_url', image_url: { url: part.image_url } });
      continue;
    }
    parts.push({ type: 'text', text: part.text });
  }
  return parts;
}
/**
 * 把 `input` 摊成 `messages`（§3.6 的确定性算法）。
 *
 * 三条规则，顺序固定：
 *   ① `instructions` 先出（**空串不出**：空的 system 消息对模型零信息，个别对端还会拒 `content:''`）；
 *   ② `json_schema` 的补丁指令紧随其后（只在需要时出现）；
 *   ③ 逐项映射；`function_call` **挂到紧邻的上一条 assistant** 上，挂不上就新开一条 `content:null`。
 *
 * **不做"相邻同角色合并"**（设计 §3.6 曾这么写，这里刻意改）：合并 assistant 正文等于用分隔符
 * **改写她说过的话**，与"历史只可遮蔽、不可改写"这条铁律冲突；而连续两条 assistant 在
 * Chat 协议里是合法的（每条 `tool_calls` 后面紧跟它自己的 `tool` 消息即可）。
 * ⇒ 差异记进设计 §4 的 parity 清单（"归一化不做合并"），并由测试钉住形状。
 */
function buildMessages(request: DsRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (request.instructions !== undefined && request.instructions !== '') {
    messages.push({ role: 'system', content: request.instructions });
  }
  const hint = jsonInstructionOf(request.text);
  if (hint !== null) messages.push({ role: 'system', content: hint });

  const pushFunctionCall = (callId: string, name: string, args: string): void => {
    const call: ChatToolCall = { id: callId, type: 'function', function: { name, arguments: args } };
    const last = messages[messages.length - 1];
    if (last !== undefined && last.role === 'assistant') {
      // 紧邻的 assistant：挂上去（`content` 保持不变——她说的那句话一个字都不动）
      if (last.tool_calls === undefined) last.tool_calls = [];
      last.tool_calls.push(call);
      return;
    }
    messages.push({ role: 'assistant', content: null, tool_calls: [call] });
  };

  if (typeof request.input === 'string') {
    messages.push({ role: 'user', content: request.input });
    return messages;
  }

  for (const item of request.input) {
    switch (item.type) {
      case undefined:
      case 'message': {
        // `developer` 落到 `system`：老兼容层不认 `developer` 这个角色（§3.1 第 6 行）
        const role = item.role === 'developer' ? 'system' : item.role;
        messages.push({ role, content: toChatContent(item, role) });
        break;
      }
      case 'function_call':
        pushFunctionCall(item.call_id, item.name, item.arguments);
        break;
      case 'function_call_output':
        messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output });
        break;
      case 'reasoning':
        // **一条都不发**（文件头纪律 1）
        break;
      default:
        break;
    }
  }
  return messages;
}

// ──────────────────────────────── 响应体读取 ────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * usage 读数（**逐字段**：缺项缺席，不许补 0——与 `ds-client.ts` 的 `readUsageFields` 同一条纪律）。
 *
 * 位置与 Responses 完全不同（§3.3）：`prompt_tokens` / `completion_tokens` /
 * 缓存命中**三个可能的位置**（`prompt_tokens_details.cached_tokens`、
 * `prompt_cache_hit_tokens`、以及它自己）/ `completion_tokens_details.reasoning_tokens`。
 */
function readUsageFields(raw: unknown): Partial<DsUsage> | null {
  const usage = asRecord(raw);
  if (usage === null) return null;
  const fields: Partial<DsUsage> = {};
  const input = num(usage['prompt_tokens']);
  if (input !== null) fields.inputTokens = input;
  const output = num(usage['completion_tokens']);
  if (output !== null) fields.outputTokens = output;
  const details = asRecord(usage['prompt_tokens_details']);
  const cached = num(details?.['cached_tokens']) ?? num(usage['prompt_cache_hit_tokens']);
  if (cached !== null) fields.cachedTokens = cached;
  const outputDetails = asRecord(usage['completion_tokens_details']);
  const reasoning = num(outputDetails?.['reasoning_tokens']);
  if (reasoning !== null) fields.reasoningTokens = reasoning;
  return Object.keys(fields).length === 0 ? null : fields;
}

function readUsage(raw: unknown): DsUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    ...(raw ?? {}),
  };
}

/**
 * `finish_reason` 六值 → 我们的终态（§3.4 那张表，**一个都不许漏**）。
 *
 * 两处最容易错：
 *   · `aborted` 是**对端**把生成掐了，不是"她按了停" ⇒ 必须走**失败**路径
 *     （映射成我们自己的 `aborted` 会让 `runStep` 记成 `{kind:'aborted'}`、失败不记账）；
 *   · `insufficient_system_resource` 是"对端算力不够"，归 `server` 类（可重试）。
 */
function terminalOf(finishReason: string): {
  status: DsStatus;
  incompleteReason: DsIncompleteReason | null;
  failure: { code: string; message: string } | null;
} {
  switch (finishReason) {
    case 'stop':
    case 'tool_calls':
      return { status: 'completed', incompleteReason: null, failure: null };
    case 'length':
      return { status: 'incomplete', incompleteReason: 'max_output_tokens', failure: null };
    case 'content_filter':
      return { status: 'incomplete', incompleteReason: 'content_filter', failure: null };
    case 'insufficient_system_resource':
      return {
        status: 'failed',
        incompleteReason: null,
        failure: { code: 'insufficient_system_resource', message: '对端算力不足，生成被打断（可重试）' },
      };
    case 'aborted':
      return {
        status: 'failed',
        incompleteReason: null,
        failure: { code: 'upstream_aborted', message: '对端中断了这次生成（不是调用方中断）' },
      };
    default:
      return {
        status: 'failed',
        incompleteReason: null,
        failure: { code: `finish_reason:${finishReason}`, message: `未识别的结束原因：${finishReason}` },
      };
  }
}

/** 三类产出按**固定顺序**（reasoning → message → function_call）拼成 `DsOutputItem[]` */
function itemsOf(content: string, reasoning: string, toolCalls: readonly ChatToolCall[]): DsOutputItem[] {
  const items: DsOutputItem[] = [];
  if (reasoning !== '') items.push({ type: 'reasoning', id: 'chat_reasoning', text: reasoning });
  if (content !== '') items.push({ type: 'message', id: 'chat_message', text: content });
  for (const [index, call] of toolCalls.entries()) {
    items.push({
      type: 'function_call',
      id: `chat_tool_${index}`,
      callId: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    });
  }
  return items;
}

/** 非流式整包解析（`generate()` 那条路：5 个 light 调用点 + vision） */
function parseResponseBody(text: string, model: string): Omit<DsResponse, 'durationMs'> {
  if (text.trim() === '') {
    throw new DsClientError({ kind: 'empty', code: 'empty_body', message: '响应体为空（200 但无内容）', status: 200 });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new DsClientError({
      kind: 'server',
      code: 'bad_json',
      message: '响应不是合法 JSON',
      status: 200,
      detail: text.slice(0, ERROR_DETAIL_LIMIT),
      cause: error,
    });
  }
  const body = asRecord(json);
  if (body === null) {
    throw new DsClientError({ kind: 'server', code: 'bad_shape', message: '响应不是 JSON 对象', status: 200 });
  }
  const envelope = asRecord(body['error']);
  if (envelope !== null) {
    throw new DsClientError({
      kind: 'server',
      code: str(envelope['code']) === '' ? 'response_failed' : str(envelope['code']),
      message: `响应带 error：${str(envelope['message'])}`,
      status: 200,
      detail: text.slice(0, ERROR_DETAIL_LIMIT),
    });
  }
  const choice = asRecord(Array.isArray(body['choices']) ? body['choices'][0] : null);
  if (choice === null) {
    throw new DsClientError({
      kind: 'server',
      code: 'bad_shape',
      message: '响应缺 choices[0]',
      status: 200,
      detail: text.slice(0, ERROR_DETAIL_LIMIT),
    });
  }
  const message = asRecord(choice['message']) ?? {};
  const content = str(message['content']);
  const reasoning = str(message['reasoning_content']);
  const toolCalls: ChatToolCall[] = [];
  if (Array.isArray(message['tool_calls'])) {
    for (const raw of message['tool_calls']) {
      const call = asRecord(raw);
      const fn = asRecord(call?.['function']);
      if (call === null || fn === null) continue;
      toolCalls.push({
        id: str(call['id']),
        type: 'function',
        function: { name: str(fn['name']), arguments: str(fn['arguments']) },
      });
    }
  }
  const terminal = terminalOf(str(choice['finish_reason']));
  if (terminal.failure !== null) {
    throw new DsClientError({
      kind: 'server',
      code: terminal.failure.code,
      message: terminal.failure.message,
      status: 200,
      detail: text.slice(0, ERROR_DETAIL_LIMIT),
    });
  }
  const outputItems = itemsOf(content, reasoning, toolCalls);
  if (!hasUsableOutput(outputItems)) {
    throw new DsClientError({
      kind: 'empty',
      code: 'empty_output',
      message: '响应无可用输出（无文本、无函数调用）',
      status: 200,
    });
  }
  const usageFields = readUsageFields(body['usage']);
  return {
    status: terminal.status,
    outputItems,
    usage: readUsage(usageFields),
    // **对端没给 usage** ⇒ 四格是补出来的 0，不是真值（口径同 `responses.ts` 的同一格）
    ...(usageFields === null ? { usageMissing: true as const } : {}),
    incompleteReason: terminal.incompleteReason,
    model: str(body['model']) === '' ? model : str(body['model']),
    responseId: str(body['id']) === '' ? null : str(body['id']),
  };
}

// ──────────────────────────────── 流式状态机 ────────────────────────────────

interface ToolAccumulator {
  id: string;
  name: string;
  args: string;
}

function createStreamAccumulator(
  fallbackModel: string,
  callbacks: DsStreamCallbacks,
  startedAt: number,
  now: () => number,
): StreamAccumulator {
  let text = '';
  let reasoning = '';
  const tools = new Map<number, ToolAccumulator>();
  let usage: DsUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 };
  let finishReason: string | null = null;
  let model: string | null = null;
  let responseId: string | null = null;
  /** 收到过 `data: [DONE]`（只是"流结束了"的哨兵，**不等于**收到终态） */
  let sawDone = false;
  /** 这一发有没有从对端拿到过 usage（口径与 `responses.ts` 的 `sawUsage` 逐字相同） */
  let sawUsage = false;
  /**
   * 传输层失败时的**强制口径**（与 `responses.ts` 的 `failure` 那一格逐字段对齐）。
   *
   * ★ 2026-10-21 修（评审 blocker ③）：`settleTransportFailure` 原来只是 `return build(true)`，
   * 而 `build` 在 `finishReason === null` 时**自己造**一条 `{code:'stream_interrupted'}` ⇒
   * 断流那一路把 `error.code`（`timeout_silent` / `timeout_hard_cap` / `ECONNRESET`…）**整个抹掉了**。
   * 那是我们唯一能指认"哪只闸掐的"的指纹：静默超时该重连、硬顶该放弃、调用方中断不该记账，
   * 三种处置完全不同，而抹成 `stream_interrupted` 之后它们长得一模一样。
   */
  let settleFailure: { code: string; message: string } | null = null;

  function absorbUsage(raw: unknown): void {
    const fields = readUsageFields(raw);
    if (fields === null) return;
    sawUsage = true;
    usage = { ...usage, ...fields };
  }

  function toolAt(index: number, seedId: string, seedName: string): ToolAccumulator {
    let tool = tools.get(index);
    if (tool === undefined) {
      tool = { id: seedId, name: seedName, args: '' };
      tools.set(index, tool);
    }
    return tool;
  }

  function collectToolCalls(): ChatToolCall[] {
    const indices = [...tools.keys()].sort((a, b) => a - b);
    const calls: ChatToolCall[] = [];
    for (const index of indices) {
      const tool = tools.get(index);
      if (tool === undefined) continue;
      if (tool.name === '' && tool.args === '') continue;
      calls.push({ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.args } });
    }
    return calls;
  }

  function collectItems(): DsOutputItem[] {
    return itemsOf(text, reasoning, collectToolCalls());
  }

  function apply(frame: SseFrame): void {
    if (frame.data === '[DONE]') {
      sawDone = true;
      callbacks.onEvent?.({ type: '[DONE]', payload: null });
      return;
    }
    let payload: Record<string, unknown> | null = null;
    try {
      payload = asRecord(JSON.parse(frame.data));
    } catch {
      payload = null; // 单帧坏死不该打断整条流
    }
    if (payload === null) return;
    callbacks.onEvent?.({ type: 'chat.completion.chunk', payload });
    if (typeof payload['model'] === 'string') model = payload['model'];
    if (typeof payload['id'] === 'string') responseId = payload['id'];
    // usage 可能在任意一块（DeepSeek：`[DONE]` 之前最后一块带完整用量、其余为 null）
    // ⇒ 逐字段收；`null` 直接跳过（不许把 null 读成 0，那会把先拿到的数抹掉）
    if (payload['usage'] !== null && payload['usage'] !== undefined) absorbUsage(payload['usage']);

    const choices = Array.isArray(payload['choices']) ? payload['choices'] : [];
    const choice = asRecord(choices[0]);
    if (choice === null) return; // 只带 usage 的块（部分兼容层会这么发）
    const delta = asRecord(choice['delta']);
    if (delta !== null) {
      const contentDelta = str(delta['content']);
      if (contentDelta !== '') {
        text += contentDelta;
        callbacks.onTextDelta?.(contentDelta);
      }
      const reasoningDelta = str(delta['reasoning_content']);
      if (reasoningDelta !== '') {
        reasoning += reasoningDelta;
        callbacks.onReasoningDelta?.(reasoningDelta);
      }
      if (Array.isArray(delta['tool_calls'])) {
        for (const raw of delta['tool_calls']) {
          const part = asRecord(raw);
          if (part === null) continue;
          const index = num(part['index']) ?? 0;
          const fn = asRecord(part['function']);
          const idPart = str(part['id']);
          const namePart = str(fn?.['name']);
          // ⚠ `id` / `name` **只在首片出现**，后续片缺失 ⇒ 必须按 index 归并、把首片的值留住；
          //    拿"每一片都覆盖"去写会把 callId 落成空串（工具结果就配不上对了）。
          const tool = toolAt(index, idPart, namePart);
          if (idPart !== '') tool.id = idPart;
          if (namePart !== '') tool.name = namePart;
          const argsDelta = str(fn?.['arguments']);
          tool.args += argsDelta;
          callbacks.onFunctionCallDelta?.({ callId: tool.id, name: tool.name, argumentsDelta: argsDelta });
        }
      }
    }
    const reason = choice['finish_reason'];
    if (typeof reason === 'string' && reason !== '') finishReason = reason;
  }

  function build(interrupted: boolean): DsStreamResult {
    const outputItems = collectItems();
    const toolCalls: Array<{ callId: string; name: string; arguments: string }> = [];
    for (const item of outputItems) {
      if (item.type === 'function_call') {
        toolCalls.push({ callId: item.callId, name: item.name, arguments: item.arguments });
      }
    }
    // 终态口径先算出来（与 Responses 的 `build` 同一条顺序：先取终态，再让"传输层失败"覆盖）
    const terminal = finishReason === null ? null : terminalOf(finishReason);
    let status: DsStatus;
    let incompleteReason: DsIncompleteReason | null = terminal?.incompleteReason ?? null;
    let failure: { code: string; message: string } | null = null;
    if (settleFailure !== null) {
      // 断流/超时/调用方中断都**没有上游终态可报** ⇒ status 恒 `incomplete`（与 Responses 逐字段对齐：
      // 那里也是 `status='incomplete'` + `failure={code:error.code, message:error.message}`）。
      // `failure` 用**原始 code**：`timeout_silent` / `timeout_hard_cap` / `ECONNRESET` 是排障指纹，
      // 抹成 `stream_interrupted` 会让"静默掐的"和"对端断的"长得一模一样（评审 blocker ③）。
      status = 'incomplete';
      failure = settleFailure;
    } else if (terminal === null) {
      // 没拿到 `finish_reason`：`[DONE]` 也只是"流结束"，**不是**终态（设计 §3.1 第 24 行）
      status = 'incomplete';
      failure = {
        code: 'stream_interrupted',
        message: sawDone
          ? '流以 [DONE] 结束但没有 finish_reason（未拿到完整响应）'
          : '流在收到终态之前结束（未拿到完整响应）',
      };
    } else {
      status = terminal.status;
      failure = terminal.failure;
    }
    if (status === 'completed' && !hasUsableOutput(outputItems)) status = 'incomplete';
    return {
      status,
      text,
      reasoning,
      toolCalls,
      outputItems,
      usage,
      // **对端一个 usage 字段都没给** ⇒ 四格是补出来的 0，不是真值（口径同 Responses）
      ...(sawUsage ? {} : { usageMissing: true as const }),
      incompleteReason,
      model: model ?? (fallbackModel === '' ? null : fallbackModel),
      responseId,
      durationMs: now() - startedAt,
      interrupted,
      failure,
    };
  }

  return {
    apply,
    finish: () => build(finishReason === null),
    settleTransportFailure: (error: DsClientError): DsStreamResult => {
      if (hasPartialOutput(collectItems())) {
        // 判据是"收到过任何可留存的内容"（含思维链），**不是**"有有效输出"：见 `hasPartialOutput`
        // ——只有思维链的那一拍也要把已收正文交出去，而不是把错误抛掉。
        settleFailure = { code: error.code, message: error.message };
        return build(true);
      }
      throw error;
    },
    hasDeliveredContent: (): boolean => hasPartialOutput(collectItems()),
  };
}

// ──────────────────────────────── 错误分类（协议自己的知识）────────────────────────────────

/**
 * Chat 的错误分类：**种类仍由 HTTP 状态决定**（与 Responses 同一张 §4.14 表），
 * 但把服务端自己的话带出来，并认几个"跨状态"的已知 code。
 *
 * 为什么种类不交给信封 code：`code` 是各家的自由文本（DeepSeek 的 400 回
 * `invalid_request_error`，别家可能回 `invalid_request` / `bad_request`……）；用它决定 `kind`
 * 会让同一个 HTTP 状态在两套协议里判成两类，而"上层/回执/日志不分叉"是这条接口的前提。
 * ⇒ `kind` = 状态表；`code` = `http_<状态>`（**与 Responses 逐字相同**，这就是"同一 400 同一 code"
 *    那条验收的落点）；信封里的 `message` **原样进 `message`/`detail`**（"落不进已知分类就保留原话"）。
 *
 * 唯一的例外是下面这张**跨状态码表**：极少数兼容层把"限流/额度"塞进 400/403 回。
 * 命中就按它升级 `kind`（可重试 vs 不可重试差很多）；没命中一律回落到状态表。
 */
const KIND_OVERRIDES: ReadonlyMap<string, 'rate_limited'> = new Map([
  ['rate_limit_exceeded', 'rate_limited'],
  ['rate_limit_error', 'rate_limited'],
  ['insufficient_quota', 'rate_limited'],
  ['too_many_requests', 'rate_limited'],
]);

function classifyError(input: TransportErrorInput): DsClientError {
  const envelope = input.envelope;
  const hasWords = envelope !== null && envelope.message !== '';
  const words = hasWords ? `：${envelope.message}` : '';
  const override = envelope === null ? undefined : KIND_OVERRIDES.get(envelope.code);
  if (override !== undefined && input.status >= 400 && input.status < 500) {
    return new DsClientError({
      kind: override,
      code: `http_${input.status}`,
      message: `模型接口限流（${input.status}）${words}`,
      status: input.status,
      retryAfterMs: input.retryAfterMs,
      detail: input.bodyText,
    });
  }
  if (input.status === 429) {
    return new DsClientError({
      kind: 'rate_limited',
      code: 'http_429',
      message: `模型接口限流（429）${words}`,
      status: 429,
      retryAfterMs: input.retryAfterMs,
      detail: input.bodyText,
    });
  }
  if (input.status >= 500) {
    return new DsClientError({
      kind: 'server',
      code: `http_${input.status}`,
      message: `模型接口服务端错误（${input.status}）${words}`,
      status: input.status,
      retryAfterMs: input.retryAfterMs,
      detail: input.bodyText,
    });
  }
  return new DsClientError({
    kind: 'invalid',
    code: `http_${input.status}`,
    message: `请求被拒绝（${input.status}）：重试同样的请求必然同样失败`
      + (hasWords ? `（服务端原话：${envelope.message}）` : ''),
    status: input.status,
    retryAfterMs: input.retryAfterMs,
    detail: input.bodyText,
  });
}

// ──────────────────────────────── 传输实现 ────────────────────────────────

function buildRequest(request: DsRequest, ctx: TransportBuildContext): TransportRequest {
  const body: Record<string, unknown> = {
    model: ctx.model,
    messages: buildMessages(request),
    stream: ctx.stream,
  };
  // 思考强度：DeepSeek 的枚举与我们 `DsReasoningEffort` **字面同一套** ⇒ 1:1 透传（§3.7 第 5 条）
  if (request.reasoning !== undefined) body['reasoning_effort'] = request.reasoning.effort;
  if (request.maxOutputTokens !== undefined) body['max_tokens'] = request.maxOutputTokens;
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  if (request.topP !== undefined) body['top_p'] = request.topP;
  if (request.tools !== undefined && request.tools.length > 0) {
    // §3.7 第 10 条：函数名只许 a-z A-Z 0-9 `_` `-`、≤128 字符。违了就**当场报错并点名**——
    // 静默截断/替换只会让对端回一个看不出原因的 400（而我们要靠错误正文排障）。
    for (const tool of request.tools) {
      if (!TOOL_NAME_RE.test(tool.name)) {
        throw new Error(`工具名不合 Chat 的字符集（a-z A-Z 0-9 _ -，≤128 字符）：${JSON.stringify(tool.name)}`);
      }
    }
    body['tools'] = request.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  if (request.text !== undefined) {
    // `text` 是缺省值 ⇒ 不发；`json_object` 直发；`json_schema` 降级（形状指令已在 messages 里）
    if (request.text.type === 'json_object' || request.text.type === 'json_schema') {
      body['response_format'] = { type: 'json_object' };
    }
  }
  return { url: '/chat/completions', body, stream: ctx.stream };
}

async function send(ctx: TransportSendContext, req: TransportRequest): Promise<Response> {
  return await ctx.fetchImpl(req.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ctx.apiKey}`,
      accept: req.stream ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify(req.body),
    signal: ctx.signal,
  });
}

export const chatCompletionsTransport: ModelTransport = {
  protocol: 'chat-completions',
  buildRequest,
  send,
  parseStream: (ctx: ParseStreamContext): StreamAccumulator =>
    createStreamAccumulator(ctx.fallbackModel, ctx.callbacks, ctx.startedAt, ctx.now),
  parseResponse: (text: string, model: string): Omit<DsResponse, 'durationMs'> => parseResponseBody(text, model),
  readUsage: (raw: unknown): Partial<DsUsage> | null => readUsageFields(raw),
  classifyError,
};
