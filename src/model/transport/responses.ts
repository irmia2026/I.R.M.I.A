/**
 * **Responses 协议实现**（`ModelTransport` 的 Responses 那一份）。
 *
 * ⚠ **搬运纪律（B 阶段的准入条件，用户点名）：下面是 `src/model/ds-client.ts` 的
 * `:720-1207` 与 `:1653-1673` **原样搬来**的**逐字副本**——函数体、注释、判据顺序、
 * 以及 `buildRequestBody` 里那七个键的**追加顺序**一律不许改。那个顺序就是线上字节
 * （`JSON.stringify` 的键序 = 对象插入序），改一个键的位置就等于让冻结前缀全失配。
 * 判据：`test/protocol-bytes.test.ts`（4 条夹具逐字节）＋ `test/ds-client.test.ts`（22 条解析）。
 *
 * 唯一的一处"非逐字"：`StreamAccumulator` 的**声明**搬到了 `./types.ts`（它是接口契约的一部分，
 * 两种协议的 `parseStream()` 都要返回它）；实现（`createStreamAccumulator`）仍逐字在这里。
 *
 * ⚠ **模块依赖是环**：本文件 import `DsClientError` / `ERROR_DETAIL_LIMIT` 来自 `../ds-client.ts`，
 * 而 `ds-client.ts` 又 import 本文件的 `responsesTransportParts`。它之所以安全：本文件在
 * **模块求值期**只定义函数与一个对象字面量（属性值全是函数引用），对 `ds-client.ts` 的引用
 * 全部发生在**调用期**（那时两侧都已初始化）。
 * ⇒ **纪律：不许在这里写 const / class 的求值期引用**（例如 `const LIMIT = ERROR_DETAIL_LIMIT`、
 *   `const Wire = DsClientError`）。⚠ 注意 `classifyError: classifyHttpStatus` 这种**不会**炸：
 *   函数声明是提升的（评审 P4 纠正过我一次）。
 */

import { DsClientError, ERROR_DETAIL_LIMIT, classifyHttpStatus } from '../ds-client.ts';
import type {
  DsIncompleteReason,
  DsOutputItem,
  DsRequest,
  DsResponse,
  DsStatus,
  DsStreamCallbacks,
  DsStreamResult,
  DsUsage,
} from '../ds-client.js';
import type { SseFrame } from './sse.js';
import type {
  ModelTransport,
  ParseStreamContext,
  StreamAccumulator,
  TransportBuildContext,
  TransportRequest,
  TransportErrorInput,
  TransportSendContext,
} from './types.js';
// ──────────────────────────────── 响应体读取 ────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * `usage` 的**逐字段**读数：只收这一包里真的给了（有限数字）的那几格，缺项**缺席**。
 *
 * 为什么不能把"缺项"读成 0（2026-10-18，review P1-07）：`usage` 是会**分成几包**来的——
 * 终态包可能只带 `output_tokens`、或整个 `usage` 都是缺的（断流/超时前更是什么都没有）。
 * 过去那一格是 `usage = readUsage(response['usage'])`，一次覆盖：缺的那几格连同**已经拿到**
 * 的数一起被抹成 0，账本就把一次真实花费记成 0（现场 7 拍 `interrupted` 全记 0，
 * 其中一拍思维链正文 102,534 字符 ≈ 2.5 万 token）。所以读的单位必须是"字段"，不是"整个对象"。
 */
function readUsageFields(raw: unknown): Partial<DsUsage> | null {
  const usage = asRecord(raw);
  if (usage === null) return null;
  const inputDetails = asRecord(usage['input_tokens_details']);
  const outputDetails = asRecord(usage['output_tokens_details']);
  const fields: Partial<DsUsage> = {};
  const input = usage['input_tokens'];
  if (typeof input === 'number' && Number.isFinite(input)) fields.inputTokens = input;
  const output = usage['output_tokens'];
  if (typeof output === 'number' && Number.isFinite(output)) fields.outputTokens = output;
  const cached = inputDetails?.['cached_tokens'];
  if (typeof cached === 'number' && Number.isFinite(cached)) fields.cachedTokens = cached;
  const reasoning = outputDetails?.['reasoning_tokens'];
  if (typeof reasoning === 'number' && Number.isFinite(reasoning)) fields.reasoningTokens = reasoning;
  return Object.keys(fields).length === 0 ? null : fields;
}

/**
 * 一整份 `usage`（非流式那条路：一次响应就是全部事实，没有"之前拿到的数"可保留）。
 * 逐字段的实现仍然只有 {@link readUsageFields} 一处——这里只负责把缺项补成 0。
 */
function readUsage(fields: Partial<DsUsage> | null): DsUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    ...(fields ?? {}),
  };
}

/** message / reasoning 的 content 是内容块数组；纯字符串形态一并兼容 */
function readContentText(raw: unknown, blockType: 'output_text' | 'reasoning_text'): string {
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) return '';
  let text = '';
  for (const part of raw) {
    const block = asRecord(part);
    if (block === null) continue;
    if (str(block['type']) !== blockType) continue;
    text += str(block['text']);
  }
  return text;
}

function readOutputItems(raw: unknown): DsOutputItem[] {
  if (!Array.isArray(raw)) return [];
  const items: DsOutputItem[] = [];
  for (const entry of raw) {
    const item = asRecord(entry);
    if (item === null) continue;
    const id = str(item['id']);
    const type = str(item['type']);
    if (type === 'message') {
      items.push({ type: 'message', id, text: readContentText(item['content'], 'output_text') });
    } else if (type === 'reasoning') {
      items.push({ type: 'reasoning', id, text: readContentText(item['content'], 'reasoning_text') });
    } else if (type === 'function_call') {
      items.push({
        type: 'function_call',
        id,
        callId: str(item['call_id']),
        name: str(item['name']),
        arguments: str(item['arguments']),
      });
    }
  }
  return items;
}

function readIncompleteReason(raw: unknown): DsIncompleteReason | null {
  const details = asRecord(asRecord(raw)?.['incomplete_details']);
  const reason = str(details?.['reason']);
  if (reason === 'max_output_tokens' || reason === 'content_filter') return reason;
  return null;
}

/**
 * 有效输出判据：有可见文本或函数调用。**只有思维链不算产出**（§4.14 的 empty 类）。
 *
 * 为什么必须按 `type` 把 reasoning 排掉（2026-10-18，review P1-06）：reasoning 条目**也带
 * `text`**（见 `readOutputItems`），所以"有文本"那一行过去把思维链一起算成了产出 ⇒
 * `parseResponseBody` 不抛 `empty` ⇒ `generate()` 交回一个正文全空的"成功"响应，
 * `EMPTY_MAX_ATTEMPTS` 那三次重试一次都不执行，light 调用方（注入判定 / 话题 / 记忆整理）
 * 拿到的是一句空话。项目自己的口径一直是反的：`test/net-vision.test.ts` 早就钉着
 * "只有思维链、没有 message ⇒ 算空响应"。
 *
 * ⚠ 它**不**回答"这次调用收到过东西没有"——中断结算要保留已收的思维链，那条走
 * {@link hasPartialOutput}（两个问题，两个判据，见那个函数的注释）。
 */
export function hasUsableOutput(items: readonly DsOutputItem[]): boolean {
  for (const item of items) {
    if (item.type === 'function_call') return true;
    if (item.type === 'reasoning') continue;
    if (item.text.trim() !== '') return true;
  }
  return false;
}

/**
 * 中断结算判据：**收到过任何可留存的内容**（可见文本 / 函数调用 / 思维链）。
 *
 * 与 {@link hasUsableOutput} 只差 reasoning 一格，而那一格是有代价的：一条只吐了思维链
 * （实测 6.5–11 万字符）的流被断流/超时掐掉时，正文是空的，但**收到的东西不是没有**。
 * 用"有效输出"判它，`settleTransportFailure` 会把错误抛出去 ⇒ 已收的思维链一个字都不落库
 * （`message/reasoning` 交的是 `result.reasoning`），那一拍在复盘里看起来像"什么都没发生"。
 * 所以"该不该当 empty 重试"与"中断时该不该保留已收部分"必须分开。
 */
export function hasPartialOutput(items: readonly DsOutputItem[]): boolean {
  for (const item of items) {
    if (item.type === 'function_call') return true;
    if (item.text.trim() !== '') return true;
  }
  return false;
}

function parseResponseBody(text: string, model: string): Omit<DsResponse, 'durationMs'> {
  if (text.trim() === '') {
    throw new DsClientError({ kind: 'empty', code: 'empty_body', message: '响应体为空（200 但无内容）', status: 200 });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    // 非空但非法 JSON：服务端瞬时损坏，可退避重试，不能当 invalid（不是我们的请求错）
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
  const statusRaw = str(body['status']);
  if (statusRaw === 'failed') {
    const err = asRecord(body['error']);
    const code = str(err?.['code']);
    const message = str(err?.['message']);
    throw new DsClientError({
      kind: 'server',
      code: code === '' ? 'response_failed' : code,
      message: message === '' ? '响应状态 failed' : `响应状态 failed：${message}`,
      status: 200,
    });
  }
  if (statusRaw !== 'completed' && statusRaw !== 'incomplete') {
    throw new DsClientError({
      kind: 'server',
      code: 'bad_status',
      message: `非终态响应状态：${statusRaw === '' ? '(缺失)' : statusRaw}`,
      status: 200,
    });
  }
  const outputItems = readOutputItems(body['output']);
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
    status: statusRaw,
    outputItems,
    usage: readUsage(usageFields),
    // **对端没给 usage**（连一个字段都没给）⇒ 四格是补出来的 0，不是真值。
    // 这一格进 `budget/consumed.usageMissing`，回答"这笔账为什么是 0"（设计 §6.2 / §9.3#20）。
    ...(usageFields === null ? { usageMissing: true as const } : {}),
    incompleteReason: readIncompleteReason(body),
    model: str(body['model']) === '' ? model : str(body['model']),
    responseId: str(body['id']) === '' ? null : str(body['id']),
  };
}

// ──────────────────────────────── 流式累积 ────────────────────────────────

interface MutableItem {
  id: string;
  kind: 'message' | 'reasoning' | 'function_call';
  text: string;
  callId: string;
  name: string;
  args: string;
}


/**
 * 流式事件状态机。两类权威源：增量事件（delta，实时）与终态 response 对象（完整）。
 * 终态里带 output 列表时以它为准覆盖累积结果——终态是服务端的最终口径，
 * 增量只用于"边收边推"与终态缺失时的兜底（对齐 M2-9：中断后保留已推送部分）。
 */
function createStreamAccumulator(
  fallbackModel: string,
  callbacks: DsStreamCallbacks,
  startedAt: number,
  now: () => number,
): StreamAccumulator {
  const items = new Map<string, MutableItem>();
  let order: string[] = [];
  let status: DsStatus = 'incomplete';
  let usage: DsUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 };
  let incompleteReason: DsIncompleteReason | null = null;
  let model: string | null = null;
  let responseId: string | null = null;
  let terminal = false;
  let failure: { code: string; message: string } | null = null;
  /**
   * 这一发**有没有从对端拿到过 usage**（任何一个字段都算）。
   *
   * 与 `usage` 四格分开记的理由：断流/超时的那一拍常常一个 usage 字段都没有 ⇒ 四格全 0，
   * 而那 0 **不是真值**（真实花费 > 0）。这一格就是"预算少算"的判据（设计 §6.2 / §9.3#20）：
   * 它进 `DsStreamResult.usageMissing`，再由五处 `budget/consumed` 写入点落成 `usageMissing: true`。
   */
  let sawUsage = false;

  /**
   * 用量**逐字段累积**（2026-10-18，review P1-07）：只覆盖这一帧真的给了的那几格。
   *
   * 为什么不整份覆盖：`usage` 可能分几包到、也可能整份缺席。整份覆盖时"这一包没带
   * `input_tokens`"会被读成"input 是 0"，把之前已经拿到的数一起抹掉（细节见
   * {@link readUsageFields}）。
   */
  function absorbUsage(raw: unknown): void {
    const fields = readUsageFields(raw);
    if (fields === null) return;
    sawUsage = true;
    usage = { ...usage, ...fields };
  }

  function ensure(key: string, kind: MutableItem['kind'], seed: Record<string, unknown> | null): MutableItem {
    let item = items.get(key);
    if (item === undefined) {
      item = {
        id: str(seed?.['id']) === '' ? key : str(seed?.['id']),
        kind,
        text: '',
        callId: str(seed?.['call_id']),
        name: str(seed?.['name']),
        args: '',
      };
      items.set(key, item);
      order.push(key);
    }
    return item;
  }

  /** 事件里定位条目：优先 item_id，其次 output_index 兜底（两者都缺时按类别并入单条） */
  function keyOf(payload: Record<string, unknown>, kind: MutableItem['kind']): string {
    const itemId = str(payload['item_id']);
    if (itemId !== '') return itemId;
    const outputIndex = payload['output_index'];
    if (typeof outputIndex === 'number') return `#${outputIndex}`;
    const callId = str(payload['call_id']);
    if (callId !== '') return callId;
    return `#${kind}`;
  }

  function absorbItem(raw: unknown, authoritative: boolean): void {
    const item = asRecord(raw);
    if (item === null) return;
    const kindRaw = str(item['type']);
    if (kindRaw !== 'message' && kindRaw !== 'reasoning' && kindRaw !== 'function_call') return;
    const key = str(item['id']) === '' ? `#${kindRaw}` : str(item['id']);
    const target = ensure(key, kindRaw, item);
    if (kindRaw === 'function_call') {
      const callId = str(item['call_id']);
      const name = str(item['name']);
      const args = str(item['arguments']);
      if (callId !== '') target.callId = callId;
      if (name !== '') target.name = name;
      if (args !== '' || authoritative) target.args = args;
      return;
    }
    const blockType = kindRaw === 'message' ? 'output_text' : 'reasoning_text';
    const text = readContentText(item['content'], blockType);
    if (text !== '' || authoritative) target.text = text;
  }

  function replaceFromItems(list: readonly DsOutputItem[]): void {
    items.clear();
    order = [];
    for (const item of list) {
      const key = item.id === '' ? `#${item.type}` : item.id;
      if (item.type === 'function_call') {
        items.set(key, { id: key, kind: 'function_call', text: '', callId: item.callId, name: item.name, args: item.arguments });
      } else {
        items.set(key, {
          id: key,
          kind: item.type,
          text: item.text,
          callId: '',
          name: '',
          args: '',
        });
      }
      order.push(key);
    }
  }

  function apply(frame: SseFrame): void {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = asRecord(JSON.parse(frame.data));
    } catch {
      payload = null; // 单帧坏死不该打断整条流
    }
    if (payload === null) return;
    const type = str(payload['type']) === '' ? (frame.event ?? '') : str(payload['type']);
    callbacks.onEvent?.({ type, payload });
    // 这一帧带了 `response` 就先把它的 `usage` 逐字段收下——**每一帧都收**，不只是终态：
    // 这样"收到过一部分用量之后才被掐断"的流也能把已拿到的数带出去（见 absorbUsage）。
    const frameResponse = asRecord(payload['response']);
    if (frameResponse !== null) absorbUsage(frameResponse['usage']);

    switch (type) {
      case 'response.output_item.added':
        absorbItem(payload['item'], false);
        return;
      case 'response.output_item.done':
        absorbItem(payload['item'], true);
        return;
      case 'response.output_text.delta': {
        const item = ensure(keyOf(payload, 'message'), 'message', payload);
        const delta = str(payload['delta']);
        item.text += delta;
        if (delta !== '') callbacks.onTextDelta?.(delta);
        return;
      }
      case 'response.output_text.done': {
        const item = ensure(keyOf(payload, 'message'), 'message', payload);
        const text = str(payload['text']);
        if (text !== '') item.text = text;
        return;
      }
      case 'response.reasoning_text.delta': {
        const item = ensure(keyOf(payload, 'reasoning'), 'reasoning', payload);
        const delta = str(payload['delta']);
        item.text += delta;
        if (delta !== '') callbacks.onReasoningDelta?.(delta);
        return;
      }
      case 'response.reasoning_text.done': {
        const item = ensure(keyOf(payload, 'reasoning'), 'reasoning', payload);
        const text = str(payload['text']);
        if (text !== '') item.text = text;
        return;
      }
      case 'response.function_call_arguments.delta': {
        const item = ensure(keyOf(payload, 'function_call'), 'function_call', payload);
        const delta = str(payload['delta']);
        item.args += delta;
        const callId = str(payload['call_id']);
        if (callId !== '') item.callId = callId;
        const name = str(payload['name']);
        if (name !== '') item.name = name;
        callbacks.onFunctionCallDelta?.({ callId: item.callId, name: item.name, argumentsDelta: delta });
        return;
      }
      case 'response.function_call_arguments.done': {
        const item = ensure(keyOf(payload, 'function_call'), 'function_call', payload);
        const args = str(payload['arguments']);
        if (args !== '') item.args = args;
        return;
      }
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        const response = asRecord(payload['response']);
        if (response !== null) {
          const statusRaw = str(response['status']);
          if (statusRaw === 'completed' || statusRaw === 'incomplete' || statusRaw === 'failed') status = statusRaw;
          // `usage` 在上面已经按帧逐字段收过了（**不再整份覆盖**，见 absorbUsage / P1-07）
          incompleteReason = readIncompleteReason(response);
          model = str(response['model']) === '' ? null : str(response['model']);
          responseId = str(response['id']) === '' ? null : str(response['id']);
          const list = readOutputItems(response['output']);
          if (list.length > 0) replaceFromItems(list);
          const err = asRecord(response['error']);
          if (err !== null) {
            failure = {
              code: str(err['code']) === '' ? 'response_failed' : str(err['code']),
              message: str(err['message']),
            };
          }
        }
        if (type === 'response.incomplete' && status === 'completed') status = 'incomplete';
        if (type === 'response.failed' && status !== 'failed') status = 'failed';
        if (status === 'completed' && !hasUsableOutput(collectOutputItems())) status = 'incomplete';
        terminal = true;
        return;
      }
      default:
        return;
    }
  }

  function collectOutputItems(): DsOutputItem[] {
    const list: DsOutputItem[] = [];
    for (const key of order) {
      const item = items.get(key);
      if (item === undefined) continue;
      if (item.kind === 'function_call') {
        list.push({ type: 'function_call', id: item.id, callId: item.callId, name: item.name, arguments: item.args });
      } else {
        list.push({ type: item.kind, id: item.id, text: item.text });
      }
    }
    return list;
  }

  function build(interrupted: boolean): DsStreamResult {
    const outputItems = collectOutputItems();
    let text = '';
    let reasoning = '';
    const toolCalls: Array<{ callId: string; name: string; arguments: string }> = [];
    for (const item of outputItems) {
      if (item.type === 'message') text += item.text;
      else if (item.type === 'reasoning') reasoning += item.text;
      else toolCalls.push({ callId: item.callId, name: item.name, arguments: item.arguments });
    }
    /**
     * **失败判据的单一出口**（契约见 `DsStreamResult.failure` 的注释）：正常收尾才允许是 null。
     *
     * 两个补洞点都只在这里、且只有这一处：
     *   · 上游 `response.failed` 但没带 `error` 对象（真实 SSE 里见过只有 status 的包）；
     *   · 流在终态事件之前就结束了（干净 EOF 也算——循环层对它的处置与断流同一条）。
     * 补出来的一定有码有文，所以循环层不需要任何 fallback 判据。
     */
    const normallyEnded = !interrupted && status !== 'failed';
    const failureOut = failure ?? (normallyEnded
      ? null
      : status === 'failed'
        ? { code: 'response_failed', message: '上游响应状态 failed（终态事件里没带错误详情）' }
        : { code: 'stream_interrupted', message: '流在收到终态事件之前结束（未拿到完整响应）' });
    return {
      status,
      text,
      reasoning,
      toolCalls,
      outputItems,
      usage,
      // **对端一个 usage 字段都没给** ⇒ 四格是补出来的 0（不是真值）。有就不写这一格。
      ...(sawUsage ? {} : { usageMissing: true as const }),
      incompleteReason,
      model: model ?? (fallbackModel === '' ? null : fallbackModel),
      responseId,
      durationMs: now() - startedAt,
      interrupted,
      failure: failureOut,
    };
  }

  return {
    apply,
    finish: () => build(!terminal),
    settleTransportFailure: (error: DsClientError): DsStreamResult => {
      // 判据是"收到过任何可留存的内容"（含思维链），**不是**"有有效输出"：见 hasPartialOutput
      // ——只有思维链的那一拍也要把已收正文交出去，而不是把错误抛掉。
      if (hasPartialOutput(collectOutputItems())) {
        // 断流/超时/调用方中断都**没有上游终态可报** ⇒ status 保持 `'incomplete'`。
        // 刻意不写 `'failed'`：那个值专指上游终态失败（见 `DsStreamResult.status` 的注释），
        // 混用会让"超时"和"上游宣告失败"在观测面上不可分。失败原因只走 `failure`。
        status = 'incomplete';
        failure = { code: error.code, message: error.message };
        return build(true);
      }
      throw error;
    },
    /**
     * 协议回退的硬前置（设计 §5.4）：**已交付就不许换协议**。
     *
     * 判据复用 `hasPartialOutput`（"收到过任何可留存的内容"：正文 / 函数调用 / 思维链），
     * 与中断结算**同一个函数**——两处若是两套判据，迟早在"只吐了思维链"那种边界上分叉：
     * 一处认为"收到过"、另一处认为"没有"，于是要么重复推送、要么把已收的东西丢掉。
     */
    hasDeliveredContent: (): boolean => hasPartialOutput(collectOutputItems()),
  };
}
// ──────────────────────────────── 请求体（**逐字搬自** ds-client.ts:1653-1673）────────────────────────────────

function buildRequestBody(
  request: DsRequest,
  model: string,
  user: string,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    input: request.input,
    user,
    stream,
  };
  if (request.instructions !== undefined) body['instructions'] = request.instructions;
  if (request.tools !== undefined && request.tools.length > 0) body['tools'] = request.tools;
  if (request.reasoning !== undefined) body['reasoning'] = { effort: request.reasoning.effort };
  if (request.maxOutputTokens !== undefined) body['max_output_tokens'] = request.maxOutputTokens;
  if (request.text !== undefined) body['text'] = { format: request.text };
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  if (request.topP !== undefined) body['top_p'] = request.topP;
  return body;
}
// ──────────────────────────────── 传输实现（ModelTransport 的 Responses 那一份）────────────────────────────────

/**
 * `buildRequest()`：**函数体一个字都没改**，只把 `(request, model, user, stream)` 这四格
 * 从 `ctx` 里取出来。键序仍然是 `buildRequestBody` 里那七行 —— 那七行就是字节。
 */
function buildRequest(request: DsRequest, ctx: TransportBuildContext): TransportRequest {
  return {
    url: `/responses`,
    body: buildRequestBody(request, ctx.model, ctx.user, ctx.stream),
    stream: ctx.stream,
  };
}

/**
 * `send()`：**只做 fetch 与三个头**——超时、静默、重试、错误分类**一概不在这里**。
 *
 * 为什么不把 `try/catch` 也搬进来（2026-10-21，B 阶段刻意如此）：超时语义（静默 / 硬顶 / 总时限）
 * 与 `RequestHandle` 是**协议无关**的那一半，它留在 `DsClient` 里，两个协议实现就都不可能
 * 偷偷改掉它。⇒ 适配器能抛的只有"自己的代码写错了"，那正是 R2 要隔离的那一类。
 */
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

/**
 * Responses 的错误分类 = **今天那套**：HTTP 状态 + 服务端信封。
 *
 * 它**逐字复用** `classifyHttpStatus`（§4.14 那张表，`ds-client.ts` 里唯一一份），所以在
 * "同一 HTTP 400 ⇒ 同一 `kind`/`code`"这条验收上，Responses 这一侧天然是基准。
 * 信封在这里**不参与判定**（今天的 `code` 恒是 `http_<状态>`）——它已经在 `bodyText` 里，
 * 原样进 `detail`，指纹判据（`isReasoningEchoRejection`）照旧能读到。
 *
 * ⚠ 写成函数引用而不是把 `classifyHttpStatus` 直接当属性值：两者其实**都安全**
 * （`function` 声明提升），但保持"transport 对 ds-client 的引用都发生在调用期"这条纪律一致，
 * 后来人不会在别的行上手滑（真正危险的是 `const` / `class` 的求值期引用，见 §8.3.2）。
 */
function classifyError(input: TransportErrorInput): DsClientError {
  return classifyHttpStatus(input.status, { retryAfterMs: input.retryAfterMs, detail: input.bodyText });
}

/** 一个完整的 Responses 实现（含错误分类）。 */
export const responsesTransportParts: ModelTransport = {
  protocol: 'responses',
  buildRequest,
  send,
  parseStream: (ctx: ParseStreamContext): StreamAccumulator =>
    createStreamAccumulator(ctx.fallbackModel, ctx.callbacks, ctx.startedAt, ctx.now),
  parseResponse: (text: string, model: string): Omit<DsResponse, 'durationMs'> => parseResponseBody(text, model),
  readUsage: (raw: unknown): Partial<DsUsage> | null => readUsageFields(raw),
  classifyError,
};