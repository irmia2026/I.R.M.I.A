/**
 * Irmia Agent — **400 飞行记录器**（服务端拒了这份请求时，把现场留成事件）
 *
 * 要解决的问题（2026-10-22 用户点名的观测缺口）：**每一次 400 都只能靠 replay 反推**。
 * replay 能重建请求，但它回答不了三个问题：
 *   · **是哪一发**被拒的（第几轮第几步、哪条 `request_id`）；
 *   · 那一发的**规模**（一共几条 item、历史几条、历史前段的哈希）；
 *   · 「最后一条 user 之后」那一段**长什么样**（v74–v77 的 400 全都出在这一段的形状上：
 *     裸 assistant 紧跟 user、思维链缺、`fc` 与 `out` 交错……）。
 * 这些都是**请求字节本身**的事实，不在任何已有事件里。所以本模块把它们提炼成一条
 * `model/reject-record`（internal，见 `log/types.ts` 的 `ModelRejectRecord`）。
 *
 * 三条硬纪律：
 *   ① **只写事件，不动请求**：本模块只从**已经造好的 `input`** 里读，一个字节都不改
 *      `render.ts` / `ds-client.ts` 的请求装配 ⇒ `src/model/render.ts` 的 diff 必须为空；
 *   ② **脱敏**（`rejectPreviewOf`）：预览 ≤ {@link REJECT_PREVIEW_CHARS} 字符、**不含图片 base64**、
 *      不含 token / 密钥 / 绝对路径。图片只留一个 `[image]` 占位——一张图 20 万字，记进去
 *      就是往日志里灌垃圾，而它是不是图片从 `type` 那一格已经读得出来；
 *   ③ **纯函数**：同一份请求 + 同一份日志永远得到同一条记录（重放/用例可以逐字段对拍）。
 *
 * 一句话分工：**事件是账**（`model/reject-record`），**请求是真相**（那份 input）。记录器
 * 不重算任何渲染口径——`shape` 里的两个历史读数直接取 `RenderedRequest.context`（渲染层的
 * 副产物，唯一来源），本模块只做"取哪几格、怎么截、怎么脱敏"。
 */

import type { ContextBreakdown } from './context-audit.js';
import type { InputItem } from './render.js';
import type { AppEvent, RejectRegionEntry } from '../log/types.js';

// ──────────────────────────────── 常量 ────────────────────────────────

/**
 * 「最后一条 user 之后」那一段最多记几条（用户定的 12）。
 *
 * 为什么是 12：实测一次正常 step 的区段通常是 2–6 条（assistant + reasoning + 几个 tool）；
 * 12 条已经盖住"一步里最多几个工具调用"的常见形状，而它出圈时说明**这一段本身异常**——
 * 那正是要留证的时刻。再多就是整段历史，而整段历史 replay 重建得出来。
 */
export const REJECT_REGION_MAX_ITEMS = 12;

/**
 * 单条预览的字符上限（用户定的 40）。
 *
 * 取 40 的理由：够认出"这是哪一句 / 哪个工具 / 哪个参数的开头"，又短到一条记录装得下
 * 12 条预览（12 × 40 ≈ 480 字符，整条事件 ~1KB）。它**不是**正文摘要，是**指纹级**的线索：
 * 要读正文就去看 `tool/call` / `message/assistant` 的原文（`seq` 能指过去）。
 */
export const REJECT_PREVIEW_CHARS = 40;

/** 预览里的占位符（一处定义，用例与读日志的人认的就是这几个字面量） */
const PLACEHOLDER = {
  image: '[image]',
  path: '[path]',
  token: '[token]',
  binary: '[binary]',
} as const;

// ──────────────────────────────── 判据：这一次算不算"服务端拒了请求" ────────────────────────────────

/** 认出来的一次服务端拒绝（只取记录器要的那三格） */
export interface ServerRejection {
  /** 错误码（`DsClientError.code`；今天的 400 是 `http_400`） */
  code: string;
  /** 服务端原话（已按 `ERROR_DETAIL_LIMIT` 截断过的 `detail`） */
  detail: string | null;
  /** HTTP 状态（没有传输层时可能为 null） */
  status: number | null;
}

/**
 * `error` 是不是**一次服务端拒绝**（`http_400`）。
 *
 * 判据两条，**任一**成立：
 *   · `code === 'http_400'` —— `classifyHttpStatus` 那张表的口径（两套协议产出的 code 同字面，
 *     见 `transport/chat-completions.ts` 的 `classifyError`）；
 *   · `status === 400` —— HTTP 状态本身。留这一条是因为 code 是**我们**拼的（`http_${status}`），
 *     而"服务端回了 400"是**对端**说的；将来某条协议换了 code 口径，状态这条还能兜住。
 *
 * 刻意**结构性判断**（不 `instanceof DsClientError`）：记录器只认这几格字段，测试替身与
 * 子代理链的假客户端照样能触发它；而 `instanceof` 会把"记录"这件事绑死在具体错误类上
 * ——那不是这个模块该有的知识。
 *
 * **只认 400**：5xx/429/超时都不是"这份请求被拒"（它们重发可能就好了），别的 4xx（401/404）
 * 是**配置**错（端点/密钥），与"请求形状"无关。把它们也记进来只会把这张账读成噪声。
 */
export function serverRejectionOf(error: unknown): ServerRejection | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as { code?: unknown; detail?: unknown; status?: unknown };
  const status = typeof record.status === 'number' ? record.status : null;
  const codeRaw = typeof record.code === 'string' && record.code !== '' ? record.code : null;
  const code = codeRaw ?? (status === null ? null : `http_${status}`);
  if (code !== 'http_400' && status !== 400) return null;
  return {
    code: code ?? 'http_400',
    detail: typeof record.detail === 'string' && record.detail !== '' ? record.detail : null,
    status,
  };
}

// ──────────────────────────────── 脱敏 ────────────────────────────────

/**
 * 图片 data URL（`data:image/png;base64,iVBORw0…`）。
 *
 * **在别的规则之前替换**：base64 里会出现 `+` `/` `=`，长的还会跨很多行；先把它整段吃掉，
 * 后面的 token / 路径规则就不会在一段图片字节上误伤（也不会把它当"长二进制"再切一次）。
 */
const DATA_URL_RE = /data:[a-z0-9.+-]{1,64}\/[a-z0-9.+-]{1,64}(?:;[a-z0-9=.+-]{1,64})*;base64,[a-z0-9+/=\s]{16,}/giu;

/**
 * 密钥 / 令牌（三种最常见形态）。
 *
 * 为什么不追求"覆盖所有密钥形态"：预览只有 40 字符，而这条账的读者是**本机的用户**；
 * 规则的目标是"别把一眼可用的凭据写进长期日志"，不是做 DLP。宁可多替换一点
 * （`sk-` 开头的普通单词也会被替掉），也不许漏一条 `sk-…` 明文。
 */
const SECRET_RES: readonly RegExp[] = [
  /\b(?:sk|pk|rk|ak)[-_][A-Za-z0-9_-]{6,}\b/gu,          // OpenAI/DeepSeek 系密钥
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,                    // GitHub token
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu,                // Authorization 头
  /\b[A-Fa-f0-9]{40,}\b/gu,                              // 长十六进制（sha1 以上的密钥/哈希形态）
];

/**
 * 绝对路径（Windows 盘符 / UNC、POSIX 常见根）。
 *
 * 为什么不记路径：预览会进**长期日志**，而路径里带着本机的用户名、工作目录结构；
 * "这条消息提到了哪个文件"对这份账没有信息量（要查就按 `seq` 去看原文）。
 */
const PATH_RES: readonly RegExp[] = [
  /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\?)+/gu,
  /\\\\[^\s"',;]+/gu,
  /\/(?:Users|home|root|var|tmp|opt|etc|mnt|Volumes)\/[^\s"',;:)]+/gu,
];

/** 一大段"像 base64 一样密"的字符（≥120 且无空白）：多半是二进制/图片的残片 */
const BLOB_RE = /[A-Za-z0-9+/=_-]{120,}/gu;

/**
 * 任意一段文字 → **脱敏后的单行预览（≤ {@link REJECT_PREVIEW_CHARS} 字符）**。
 *
 * 顺序即安全边界，别调换：
 *   ① 图片 data URL → `[image]`（它最长、且会把后面的规则带偏）；
 *   ② 绝对路径 → `[path]`；
 *   ③ 密钥 → `[token]`；
 *   ④ 长二进制残片 → `[binary]`（**放在路径/密钥之后**：它会把没被认出来的长串一起吃掉，
 *      先做它就会把 `sk-…` 也变成 `[binary]`，读日志时分不清"是密钥"还是"是图片"）；
 *   ⑤ 换行 / 连续空白压成一个空格（预览必须是单行：日志是 JSONL，多行会被读成一堆碎行）；
 *   ⑥ **最后**才截 40 字符——先截再脱敏会把 `sk-xxxxx` 截成 `sk-xx` 这种"半截密钥"，
 *      脱敏规则就认不出它了。
 */
export function rejectPreviewOf(text: string): string {
  let out = text.replace(DATA_URL_RE, PLACEHOLDER.image);
  for (const pattern of PATH_RES) out = out.replace(pattern, PLACEHOLDER.path);
  for (const pattern of SECRET_RES) out = out.replace(pattern, PLACEHOLDER.token);
  out = out.replace(BLOB_RE, PLACEHOLDER.binary);
  // 控制字符（含 \n \r \t）与连续空白 → 单个空格；trim 掉首尾（预览不该以空格开头）
  out = out.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return out.slice(0, REJECT_PREVIEW_CHARS);
}

// ──────────────────────────────── 区段 ────────────────────────────────

/**
 * `input` 里**最后一条 user 消息**的下标（没有 ⇒ -1）。
 *
 * 与 `render.ts` 的 `reasoningRegionStartOf` / `assertReasoningEchoIntegrity` 同一判据
 * （"最后一条 user 之后"是服务端校验的边界）——这里刻意只重算这一个下标，不 import 渲染层的
 * 内部函数：本模块吃的是**已经造好的 input**，判据就是它的字节。
 */
function lastUserIndex(input: readonly InputItem[]): number {
  let last = -1;
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (item !== undefined && item.type === 'message' && item.role === 'user') last = index;
  }
  return last;
}

/** 一条 item 的**文字**部分（图片只留一个占位，绝不带 base64） */
function previewOfItem(item: InputItem): string {
  switch (item.type) {
    case 'message': {
      if (typeof item.content === 'string') return rejectPreviewOf(item.content);
      const parts: string[] = [];
      for (const part of item.content) {
        if (part.type === 'input_image') parts.push(PLACEHOLDER.image);
        else parts.push(part.text);
      }
      return rejectPreviewOf(parts.join(' '));
    }
    case 'reasoning': {
      return rejectPreviewOf(item.content.map(part => part.text).join(''));
    }
    case 'function_call': {
      return rejectPreviewOf(`${item.name} ${item.arguments}`.trim());
    }
    case 'function_call_output': {
      return rejectPreviewOf(item.output);
    }
    default: return '';
  }
}

/** 工具 item 的 `seq` 来源：`call_id` 在事件里是**唯一**的（`tool/call` / `tool/result` 各一张） */
function toolSeqs(events: readonly AppEvent[]): { calls: Map<string, number>; results: Map<string, number> } {
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'tool/call') calls.set(event.data.callId, event.seq);
    else if (event.type === 'tool/result') results.set(event.data.callId, event.seq);
  }
  return { calls, results };
}

/**
 * 「最后一条 user 之后」那一段 → 事件里的 `region`。
 *
 * 取值：**区段的前 {@link REJECT_REGION_MAX_ITEMS} 条**（不是最后 12 条）。
 * 为什么保留开头：v74–v77 的 400 全都出在**区的第一格**（assistant 正文紧跟 user、裸 `fc`
 * 起段、思维链缺），截掉开头正好截掉了答案。条数超了记 `truncated: true`——它是"这一段
 * 比账里这 12 条更长"的**事实**，不是"剩下的不重要"的判断。
 *
 * `seq` 只在**能精确对上**时写：`function_call` / `function_call_output` 凭 `call_id` 找
 * `tool/call` / `tool/result`；其余 item（message / reasoning）在渲染层会被合并、改写、
 * 补回，事件与 item 不是一一对应 ⇒ **宁可不写，也不猜一个看起来对的 seq**（读的一侧必须
 * 按"没有 seq = 指不回去"理解，见 `RejectRegionEntry.seq`）。
 */
export function rejectRegionOf(
  input: readonly InputItem[],
  options: { events?: readonly AppEvent[]; maxItems?: number } = {},
): { region: RejectRegionEntry[]; truncated: boolean } {
  const maxItems = Math.max(1, options.maxItems ?? REJECT_REGION_MAX_ITEMS);
  const tail = input.slice(lastUserIndex(input) + 1);
  const seqs = toolSeqs(options.events ?? []);
  const kept = tail.slice(0, maxItems);
  const region = kept.map((item): RejectRegionEntry => {
    const entry: RejectRegionEntry = { type: item.type, preview: previewOfItem(item) };
    if (item.type === 'message') entry.role = item.role;
    const seq = item.type === 'function_call'
      ? seqs.calls.get(item.call_id)
      : (item.type === 'function_call_output' ? seqs.results.get(item.call_id) : undefined);
    if (seq !== undefined) entry.seq = seq;
    return entry;
  });
  return { region, truncated: tail.length > maxItems };
}

// ──────────────────────────────── 记录 ────────────────────────────────

/** 记录器要的现场（全部来自**已经造好的那一发**，本模块不重新渲染） */
export interface RejectRecordArgs {
  turn: number;
  step: number;
  code: string;
  /** 服务端原话（`DsClientError.detail`）；从这里取 `request_id` */
  detail: string | null;
  /** 被拒的那一份请求的 input（`RenderedRequest.input`，**就是发出去的字节**） */
  input: readonly InputItem[];
  /** 渲染层给出的归因事实（`RenderedRequest.context`）：只取 input/history 两格 */
  context: Pick<ContextBreakdown, 'input' | 'history'>;
  /** 本步之前的事件快照（只用来给工具 item 对 `seq`；缺了就不写 `seq`） */
  events?: readonly AppEvent[];
}

/**
 * 组一条 `model/reject-record` 的负载（事件形状见 `log/types.ts` 的 `ModelRejectRecord`）。
 *
 * 三处口径写死在这里，读日志的人不必再猜：
 *   · `shape.items` = **这一发实际有几个 input item**（数的是 `input.length`，不是渲染层的
 *     `context.input.items`——万一两者不一致，账要按**真发出去的字节**记）；
 *   · `shape.historyItems` / `shape.headHash` = 渲染层的 `context.history`（唯一来源，本模块
 *     不重算：历史段怎么切只有 `render.ts` 知道）；
 *   · `requestId` = 服务端原话里的 `request_id`（对不上就是 `null`，**绝不编**）。
 */
export function rejectRecordOf(args: RejectRecordArgs): {
  turn: number;
  step: number;
  code: string;
  requestId: string | null;
  shape: { items: number; historyItems: number; headHash: string };
  region: RejectRegionEntry[];
  truncated?: true;
} {
  const { region, truncated } = rejectRegionOf(args.input, args.events === undefined ? {} : { events: args.events });
  return {
    turn: args.turn,
    step: args.step,
    code: args.code,
    requestId: requestIdOf(args.detail),
    shape: {
      items: args.input.length,
      historyItems: args.context.history.items,
      headHash: args.context.history.headHash,
    },
    region,
    ...(truncated ? { truncated: true as const } : {}),
  };
}

/**
 * 服务端原话里的 `request_id`（`000000136342.jsonl` 那批 400 的形状：
 * `… must be passed back to the API. (request_id: 1aef174c-62bc-496b-bc40-6ee8cf06f067)`）。
 *
 * 三条形态都认：
 *   · 裸的 `(request_id: xxx)` / `request-id=xxx`（信封的 message 里）；
 *   · JSON 里的 `"request_id":"xxx"`（有的兼容层把它放在顶层）；
 *   · 进日志前被**二次转义**过的 `request_id\\": \\"xxx`（`detail` 是原始响应体，信封里
 *     可能又套了一层 JSON 串）。
 *
 * 取值字符集刻意收窄（`[A-Za-z0-9._:-]`，≤128）：`request_id` 是服务端给的标识，不该带
 * 空格/引号/路径；收窄之后它不可能把后面半句话一起吞进来。
 * 认不出就返回 `null`——**不猜**（与"没有 seq 就不写"同一条纪律）。
 */
export function requestIdOf(detail: string | null | undefined): string | null {
  if (typeof detail !== 'string' || detail === '') return null;
  const match = /request[_-]?id\W{0,8}([A-Za-z0-9][A-Za-z0-9._:-]{0,127})/iu.exec(detail);
  return match === null ? null : match[1] ?? null;
}
