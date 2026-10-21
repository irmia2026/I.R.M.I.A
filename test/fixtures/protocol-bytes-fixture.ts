/**
 * 协议字节比对的**共享夹具**（测试与底片生成器共用同一份，防两边漂）。
 *
 * 为什么要单独一个文件：`responses-request-bytes-baseline.json` 是"改前"的字节底片，
 * `test/protocol-bytes.test.ts` 是"改后"的判据——两边**必须用同一份请求**，否则比出来的
 * 差异分不清是"代码变了"还是"夹具变了"。所以夹具只写在这里一份：
 *   · `capture-responses-bytes.mjs`（生成底片）import 它；
 *   · `protocol-bytes.test.ts`（判据）import 它。
 *
 * ## 夹具的覆盖面（评审 P6 之后补到"truthy 与 falsy 两支都点到"）
 *
 * `buildRequestBody` 的白名单是七个 `if (x !== undefined)` 加一个"有值才发"的判断
 * （`tools.length > 0`）。**只测 truthy 形状抓不住 `if (x)` 这种变异**——评审把
 * `temperature !== undefined` 改成 truthy、把 `tools.length > 0` 删掉，四条 truthy 夹具全绿。
 * 所以下面这几条**必须同时存在**：
 *   · 富夹具：七格全给真值（正例）；
 *   · 空 `tools: []` + 空 `instructions: ''`：`tools` 必须**整键不出现**、`instructions` 必须是 `""`
 *     （抓 `tools.length > 0` 被删、抓 `!== undefined` 被改成 `if (x)`）；
 *   · 假值数值 `temperature:0 / topP:0 / maxOutputTokens:0`：三个键**必须都出现且都是 0**
 *     （同上，抓 truthy 变异）；
 *   · 空 `input: ''`：`input` 必须出现且是 `""`（抓 `input` 被改成"有值才发"）。
 *
 * ⚠ 改这个文件 = 改判据。改完必须重新生成底片、同步 `bytes`，并在提交信息里说清"为什么允许字节变"。
 * **B/C 阶段（协议回退的搬迁与适配）不许动它一个字节。**
 */

import type { DsInputItem, DsRequest } from '../../src/model/ds-client.js';

/** 1×1 透明 PNG 的 data URL：图片块在两种协议里的形状不同，这里只钉 Responses 那一份 */
export const IMAGE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 富夹具的 `input`：五种 item 齐全（`DsInputItem[]` 标注是为了让 `tsconfig.test.json` 也过） */
export const RICH_INPUT: DsInputItem[] = [
  { type: 'message', role: 'user', content: '在吗' },
  { type: 'reasoning', content: [{ type: 'reasoning_text', text: '先看一眼日志。' }] },
  { type: 'message', role: 'assistant', content: '在。' },
  {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: '[图片] shot.png' },
      { type: 'input_image', image_url: IMAGE_DATA_URL },
    ],
  },
  { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"file_path":"a.txt"}' },
  { type: 'function_call_output', call_id: 'call_1', output: '内容' },
  { type: 'message', role: 'developer', content: '[策略拒绝] 工具 pwsh（destructive）：没开' },
];

/** 富夹具：把 `buildRequestBody` 白名单里每一格都点到 */
export const RICH_REQUEST: DsRequest = {
  lane: 'heavy',
  model: 'deepseek-v4-pro',
  input: RICH_INPUT,
  instructions: '你是 Irmia。\n双层人格。',
  tools: [
    {
      type: 'function',
      name: 'read_file',
      description: '只读文件',
      parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
    },
    {
      type: 'function',
      name: 'pwsh',
      description: '跑一条 PowerShell',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  ],
  reasoning: { effort: 'high' },
  maxOutputTokens: 8192,
  text: { type: 'json_schema', name: 'verdict', schema: { type: 'object', properties: { risky: { type: 'boolean' } } } },
  temperature: 0.7,
  topP: 0.95,
};

/** 最小夹具：除 `model/input/user/stream` 四格以外一个字段都不给（缺项分支的字节也要钉） */
export const MINIMAL_REQUEST: DsRequest = { lane: 'light', input: '几点' };

/**
 * **空 `tools` + 空 `instructions`**（评审 P6）：抓 `tools.length > 0` 被删、抓 `''` 被当成"没给"。
 * 期望：`tools` **整键不出现**；`instructions` 是 `""`（它"给了，只是空"）。
 */
export const EMPTY_TOOLS_REQUEST: DsRequest = {
  lane: 'light',
  input: 'x',
  instructions: '',
  tools: [],
};

/**
 * **假值数值**（评审 P6）：抓 `!== undefined` 被改成 `if (x)`。
 * 期望：`max_output_tokens` / `temperature` / `top_p` **三个键都出现，且都是 0**。
 */
export const FALSY_NUMBERS_REQUEST: DsRequest = {
  lane: 'light',
  input: 'x',
  maxOutputTokens: 0,
  temperature: 0,
  topP: 0,
};

/** **空 `input`**（评审 P6）：抓 `input` 被改成"有值才发"。期望：`input` 出现且是 `""`。 */
export const EMPTY_INPUT_REQUEST: DsRequest = { lane: 'light', input: '' };

/** 七条请求的固定顺序：四条 truthy 形状 + 三条 falsy/空 形状 */
export type BaselineCase = { label: string; request: DsRequest; stream: boolean; bytes: number };

export const BASELINE_CASES: readonly BaselineCase[] = [
  { label: '非流式 · 富夹具', request: RICH_REQUEST, stream: false, bytes: 1_411 },
  { label: '非流式 · 最小夹具', request: MINIMAL_REQUEST, stream: false, bytes: 83 },
  { label: '流式 · 富夹具', request: RICH_REQUEST, stream: true, bytes: 1_410 },
  { label: '流式 · 最小夹具', request: MINIMAL_REQUEST, stream: true, bytes: 82 },
  { label: '非流式 · 空 tools + 空 instructions', request: EMPTY_TOOLS_REQUEST, stream: false, bytes: 96 },
  { label: '非流式 · 假值数值（全 0）', request: FALSY_NUMBERS_REQUEST, stream: false, bytes: 126 },
  { label: '非流式 · 空 input', request: EMPTY_INPUT_REQUEST, stream: false, bytes: 77 },
];

/** 底片文件（判据从它读；生成器写它） */
export const BASELINE_FILE = 'test/fixtures/responses-request-bytes-baseline.json';
