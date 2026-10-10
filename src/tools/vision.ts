/**
 * Irmia Agent — 视觉工具（docs/design.md §4.18「vision 基础版设计」、docs/schema.md §10）
 *
 * 两件工具：`vision_read`（读图入缓存）与 `vision_query`（查缓存）。
 *
 * 设计要点与理由：
 *   - **缓存键是内容，不是文件名**：`sha256(图片字节) + 模型 + 问题` 三者共同决定一条
 *     结果，文件落在 `data/vision-cache/<sha256>.json`（同一张图的不同问题共存于一个文件
 *     的 entries 数组里）。同一张图换个名字不会重复烧钱，换个问题才会重新调模型。
 *   - **不把全文还给调用方**：`vision_read` 只回计数摘要 + 一句话 peek，正文留在缓存里
 *     由 `vision_query` 按需取——读图是「入账」，不是「灌上下文」（§4.18 原则 4）。
 *   - **只依赖注入的 dsClient**：模型通道由宿主注入（§4.14 provider 抽象），工具内绝不
 *     new 客户端、不读环境变量，这样测试可以用 mock 精确断言「命中缓存后不再调用模型」。
 *     请求形状对齐 DS Responses 的线格式：`lane`/`model` 选路，`input` 里放 `input_text`
 *     与 `input_image`（data URL），`text.format` 用 `json_schema` 拿结构化结果。
 *     **但返回的是归一化后的 `DsResponse`（`outputItems`），不是原始 HTTP 响应体**——这一条
 *     曾经写错，代价是 `vision_read` 从上线起没有成功过一次（详见 `extractResponseText`）。
 *   - **结构化容错**：要求 json_schema，但模型可能回带代码围栏或混解释文字，因此解析走
 *     「剥离围栏 → 直接 parse → 提取首个 JSON 对象 → 全部失败则回退纯文本」四段降级，
 *     回退结果标注 `fallback: true`，绝不因为一次格式漂移就丢掉整张图的描述。
 *   - **GIF 只按静态首帧读**：零依赖下不做动图拆帧，读取时按静态图送入并注明这一点，
 *     避免模型对「动图」产生不存在的信息。
 *
 * 路径白名单复用 `./fs/path-guard.ts`（符号链接展开后再比前缀），不另起一套语义。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import type { Dirent } from 'node:fs';

import { PATH_BOUNDARY_HINT } from './boundary.ts';
import { resolveInsideRoot } from './fs/path-guard.ts';
import { FS_ERROR_CODES } from './fs/types.ts';
// 进上下文的图片型别白名单：**只有一处**（`log/types.ts`）。inline 这条路的准入判据与渲染层
// 挑图用的是同一个函数——两处各抄一份名单，必然漂成"回执说进了、请求体里没有"（2026-10-11 修）
import { CONTEXT_IMAGE_MEDIA_TYPES, contextImageMimeAllowed } from '../log/types.ts';
import type { DsReasoningEffort, DsResponse } from '../model/ds-client.ts';
import {
  TOOL_ERROR_CODES,
  ToolArgumentError,
  argsRecord,
  errorResult,
  errorResultFromThrown,
  okResult,
  optionalInteger,
  optionalString,
  type ToolContext,
  type ToolDefinition,
  type ToolHandlerResult,
} from './types.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

export const VISION_CACHE_DIR_NAME = 'vision-cache';
export const VISION_CACHE_VERSION = 1;
/** light lane 模型（§4.13：必要性门/摘要等轻量任务走 flash） */
export const DEFAULT_VISION_MODEL = 'deepseek-flash';
/** 单图字节上限：20MB（§4.18） */
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const VISION_READ_TIMEOUT_MS = 120_000;
export const VISION_QUERY_TIMEOUT_MS = 10_000;
/** 目录遍历上限，防一手无意的超大树 */
const MAX_SCAN_ENTRIES = 2_000;
const MAX_DIR_DEPTH = 6;
/** 单次 vision_read 最多处理多少张图（超了让模型分批，别把一次调用变成一小时的账单） */
const DEFAULT_MAX_PATHS = 20;
/** 问题默认文案：不指定 question 时的通用读图要求 */
export const DEFAULT_QUESTION =
  '描述这张图片。peek 用一句话概括（不超过40字）；text 给出完整描述，逐字抄录图中所有可见文字；tags 给3到8个关键词。';

/** 视觉工具域内错误码（风格对齐 fs 包的 FS_ERROR_CODES；参数/中断码复用顶层契约） */
export const VISION_ERROR_CODES = {
  UNSUPPORTED_TYPE: 'UNSUPPORTED_TYPE',
  TOO_LARGE: 'TOO_LARGE',
  TOO_MANY_PATHS: 'TOO_MANY_PATHS',
  READ_FAILED: 'READ_FAILED',
  MODEL_FAILED: 'MODEL_FAILED',
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  CACHE_WRITE_FAILED: 'CACHE_WRITE_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /** `inline` 直通在当前装配下不可用（没接事件出口，或配置里关掉了图片进上下文） */
  INLINE_DISABLED: 'INLINE_DISABLED',
} as const;

const IMAGE_MIME_BY_EXT = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.bmp', 'image/bmp'],
]);

/** json_schema 约束的形状（§4.18：JSON 模式 + 容错回退） */
export const VISION_RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    peek: { type: 'string', description: '一句话摘要，不超过40字' },
    text: { type: 'string', description: '完整描述，含图中所有可见文字' },
    tags: { type: 'array', items: { type: 'string' }, description: '3到8个关键词' },
  },
  required: ['peek', 'text', 'tags'],
  additionalProperties: false,
};

// ──────────────────────────────── 契约类型 ────────────────────────────────

/** 注入的模型客户端：形状对齐 §4.14 provider 抽象；工具内不 new、不读环境变量 */
export interface VisionModelClient {
  /**
   * 返回的是**归一化后的** `DsResponse`（文本在 `outputItems` 里），不是原始 HTTP 响应体。
   *
   * 这个类型曾经是 `Promise<unknown>`：实现在里面按原始形状（顶层 `output[]`）取文本，
   * 而真实客户端交回来的是 `outputItems[]`，两边对不上、`raw` 恒为空串，于是
   * `vision_read` 从上线起每一次都报 `EMPTY_RESPONSE`（视觉缓存目录因此从未被建过）。
   * 把类型写实，是为了让 mock 也必须交出真形状——这条错误就是靠 mock 形状不一致活下来的。
   */
  generate(request: VisionGenerateRequest): Promise<DsResponse>;
}

export interface VisionInputTextPart {
  type: 'input_text';
  text: string;
}

export interface VisionInputImagePart {
  type: 'input_image';
  /** data URL：`data:image/png;base64,...`（DS Responses 的 input_image 形态） */
  image_url: string;
}

/**
 * 请求体对齐 DS Responses：`lane` 决定路由（视觉一律 light），`text` 即请求 JSON 里的
 * `text.format`（`{ type:'json_schema', name, schema }`，与 model/ds-client.ts 的
 * DsTextFormat 同形，真实 provider 补上 input_image 支持后可直接消费）。
 */
export interface VisionGenerateRequest {
  lane: 'light';
  model: string;
  input: Array<{
    role: 'user';
    content: Array<VisionInputTextPart | VisionInputImagePart>;
  }>;
  text: {
    type: 'json_schema';
    name: string;
    schema: Record<string, unknown>;
  };
  /**
   * 思考强度。**视觉这一路是 light ⇒ 一律 `low`（用户的口径，2026-10-06，不提供更改）**：
   * 与 `channel/injection-judge.ts`、`channel/topic.ts`、`persona/assets.ts`、
   * `persona/memory-maintain.ts` 四处同形；另一档 heavy 一律 `high`
   * （唯一落点 `runtime/agent-loop.ts` 的 `toDsRequest`）。
   *
   * 这个字段**曾经是缺席的**（2026-10-06 补）：适配器把整个对象原样透传给 `DsClient`，
   * 于是"没写"就等于**服务端默认**（官方文档：思考模式默认打开、effort 默认 `high`）——
   * 一条本该便宜的 light 调用实际跑在 high 上，而账本上看不出来。
   * **不提供更改**：config.json 里没有、也不许长出能改它的字段；判据钉在
   * `test/thinking-effort-invariant.test.ts`（六处调用点逐个断言）。
   */
  reasoning?: { effort: DsReasoningEffort };
}

/** 落盘的缓存条目 */
export interface VisionCacheEntry {
  /** 确定性 id：sha256 前缀 + (模型+问题) 哈希前缀，可被 vision_query 直接引用 */
  result_id: string;
  sha256: string;
  model: string;
  question: string;
  /** 首次读入时的相对路径（同一张图换名字命中缓存时保留首次记录） */
  filename: string;
  peek: string;
  text: string;
  tags: string[];
  createdAt: string;
  bytes: number;
  mime: string;
  /** 附加说明（如 GIF 仅首帧） */
  note?: string;
  /** 结构化解析失败、回退纯文本 */
  fallback?: boolean;
}

export interface VisionToolsOptions {
  /** 必填：模型通道由宿主注入 */
  dsClient: VisionModelClient;
  /** data 目录；缓存落 `<dataDir>/vision-cache/` */
  dataDir: string;
  model?: string;
  maxImageBytes?: number;
  maxPaths?: number;
  /** 时钟注入点（测试确定性用），默认 new Date() */
  clock?: () => Date;
  /**
   * 事件写入口：`inline` 模式要把图片放进上下文，靠写一条 `image/attached` 事件实现
   * （工具结果只能是文本，塞不下图片）。不配 = `inline` 参数不可用，如实报错。
   */
  emit?: (type: 'image/attached', data: { key: string; mime: string; name?: string }) => void;
  /**
   * 图片直通是否开启（`config.vision.imagesToContext`）。关掉时 `inline` 不假装成功——
   * 那条事件写了也不会被渲染层注入，只会让她以为"我看过了"。
   */
  imagesToContext?: boolean;
}

// ──────────────────────────────── 辅助函数 ────────────────────────────────

/** 扩展名 → MIME；非图片返回 null */
export function imageMimeOf(pathOrName: string): string | null {
  const lower = pathOrName.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return null;
  return IMAGE_MIME_BY_EXT.get(lower.slice(dot)) ?? null;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 确定性结果 id：内容决定前段，(模型+问题) 决定后段 */
export function visionResultId(sha256: string, model: string, question: string): string {
  const keyHash = sha256Hex(`${model}\u0000${question}`).slice(0, 8);
  return `${sha256.slice(0, 12)}-${keyHash}`;
}

/** 首个非空行，压到 n 字符：peek 兜底用 */
function firstMeaningfulLine(raw: string, maxChars: number): string {
  const line = raw.trim().split('\n').find((candidate) => candidate.trim() !== '') ?? '';
  const trimmed = line.trim().replace(/\s+/g, ' ');
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}…`;
}

/** 剥离 ```json ... ``` 围栏（模型最常见的格式漂移） */
export function stripCodeFence(raw: string): string {
  const match = /^\s*```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(raw);
  return match?.[1] ?? raw;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从夹杂解释文字的回复里抠出第一个花括号平衡块 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) break;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').join('\n').trim();
  }
  return '';
}

function toTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    const tags: string[] = [];
    for (const item of value) {
      if (typeof item === 'string' && item.trim() !== '') tags.push(item.trim());
      else if (typeof item === 'number') tags.push(String(item));
    }
    return tags.slice(0, 12);
  }
  if (typeof value === 'string') {
    return value
      .split(/[,，;；\s]+/)
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '')
      .slice(0, 12);
  }
  return [];
}

/**
 * 结构化结果解析（四段降级）：围栏剥离 → 直接 parse → 抠首个 JSON 对象 → 回退纯文本。
 * 回退时 peek 取首个非空行、text 取全文，并在条目上标 fallback，模型能看出这是原始文本。
 */
export function parseVisionResult(raw: string): { peek: string; text: string; tags: string[]; fallback: boolean } {
  const trimmed = raw.trim();
  const candidates = [stripCodeFence(trimmed)];
  const extracted = extractFirstJsonObject(trimmed);
  if (extracted !== null) candidates.push(extracted);

  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    const peek = toText(record['peek']) || toText(record['summary']) || toText(record['title']);
    const text = toText(record['text']) || toText(record['description']) || toText(record['content']);
    const tags = toTags(record['tags'] ?? record['keywords']);
    if (peek === '' && text === '') continue;
    const finalPeek = peek === '' ? firstMeaningfulLine(text, 60) : peek;
    return { peek: finalPeek, text: text === '' ? peek : text, tags, fallback: false };
  }

  return { peek: firstMeaningfulLine(trimmed, 60), text: trimmed, tags: [], fallback: true };
}

/** 从任意 provider 响应里取文本：归一化 DsResponse → 直取字段 → Responses output[] → OpenAI 兼容形状 */
export function extractResponseText(response: unknown): string {
  if (typeof response === 'string') return response.trim();
  if (typeof response !== 'object' || response === null) return '';
  const record = response as Record<string, unknown>;

  // ① 归一化后的 DsResponse（model/ds-client.ts）：**真实客户端返回的就是它**。
  //    只认 message 项——reasoning 项里也有 text 字段，把思维链当答案会污染结构化解析。
  const items = record['outputItems'];
  if (Array.isArray(items)) {
    const texts: string[] = [];
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue;
      const entry = item as Record<string, unknown>;
      if (entry['type'] !== 'message') continue;
      const text = entry['text'];
      if (typeof text === 'string' && text.trim() !== '') texts.push(text.trim());
    }
    if (texts.length > 0) return texts.join('\n').trim();
  }

  for (const key of ['output_text', 'text', 'content'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }

  const parts: string[] = [];
  const output = record['output'];
  if (Array.isArray(output)) {
    for (const item of output) {
      if (typeof item !== 'object' || item === null) continue;
      const content = (item as Record<string, unknown>)['content'];
      if (typeof content === 'string') parts.push(content);
      else if (Array.isArray(content)) {
        for (const chunk of content) {
          if (typeof chunk !== 'object' || chunk === null) continue;
          const text = (chunk as Record<string, unknown>)['text'];
          if (typeof text === 'string') parts.push(text);
        }
      }
    }
  }
  if (parts.length > 0) return parts.join('\n').trim();

  const choices = record['choices'];
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (typeof first === 'object' && first !== null) {
      const message = (first as Record<string, unknown>)['message'];
      if (typeof message === 'object' && message !== null) {
        const text = (message as Record<string, unknown>)['content'];
        if (typeof text === 'string') return text.trim();
      }
    }
  }
  return '';
}

// ──────────────────────────────── 缓存读写 ────────────────────────────────

function isCacheEntry(value: unknown): value is VisionCacheEntry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['result_id'] === 'string' &&
    typeof record['sha256'] === 'string' &&
    typeof record['peek'] === 'string' &&
    Array.isArray(record['tags'])
  );
}

async function readCacheEntries(path: string): Promise<VisionCacheEntry[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const parsed = tryParseJson(text);
  if (parsed === null || typeof parsed !== 'object') return [];
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  return entries.filter(isCacheEntry);
}

let tmpSeq = 0;

/** 统一的「写 tmp + rename 覆盖」规则（schema §11），旧文件保持完整直到新文件就位 */
async function writeCacheEntries(cacheDir: string, sha256: string, entries: VisionCacheEntry[]): Promise<void> {
  const path = join(cacheDir, `${sha256}.json`);
  await mkdir(cacheDir, { recursive: true });
  tmpSeq += 1;
  const tmp = `${path}.tmp.${process.pid}.${tmpSeq}`;
  const body = `${JSON.stringify({ version: VISION_CACHE_VERSION, sha256, entries })}\n`;
  try {
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** 递归收集图片；顺序按名字排序，保证同一目录两次调用落到同一序列（可复盘） */
async function collectImages(dir: string, out: string[], skipped: string[], depth = 0): Promise<void> {
  if (depth > MAX_DIR_DEPTH || out.length >= MAX_SCAN_ENTRIES) return;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= MAX_SCAN_ENTRIES) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectImages(full, out, skipped, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    if (imageMimeOf(entry.name) === null) skipped.push(full);
    else out.push(full);
  }
}

function posixRelative(root: string, path: string): string {
  return relative(root, path).split('\\').join('/');
}

// ──────────────────────────────── 工具实现 ────────────────────────────────

type VisionReadItem =
  | {
      filename: string;
      result_id: string;
      peek: string;
      tags: string[];
      bytes: number;
      cached: boolean;
      note?: string;
      fallback?: boolean;
    }
  | { filename: string; error: { code: string; message: string } };

export function createVisionTools(options: VisionToolsOptions): ToolDefinition[] {
  const model = options.model ?? DEFAULT_VISION_MODEL;
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
  const clock = options.clock ?? (() => new Date());
  const cacheDir = join(options.dataDir, VISION_CACHE_DIR_NAME);

  /**
   * 路径解析：先探类型（文件/目录），再过白名单；越界优先于不存在报告，
   * 返回的 `path` 才是读写用的路径（已展开符号链接的祖先）。
   */
  async function resolveTarget(
    ctx: ToolContext,
    raw: string,
  ): Promise<{ ok: true; path: string; isDirectory: boolean } | { ok: false; result: ToolHandlerResult }> {
    const probe = isAbsolute(raw) ? raw : join(ctx.workspaceRoot, raw);
    let kind: 'file' | 'directory' | 'missing' = 'missing';
    try {
      kind = (await stat(probe)).isDirectory() ? 'directory' : 'file';
    } catch {
      kind = 'missing';
    }
    // 边界与 fs 工具族同一份（`ctx.boundaryRoot` 三态原样传，判读只归 boundary.ts）
    const guard = await resolveInsideRoot(
      ctx.workspaceRoot,
      raw,
      {
        ...(kind === 'directory'
          ? { requireDirectory: true, purpose: 'vision_read' }
          : { allowMissing: true, purpose: 'vision_read' }),
        ...(ctx.boundaryRoot === undefined ? {} : { boundaryRoot: ctx.boundaryRoot }),
      },
    );
    if (!guard.ok) return { ok: false, result: errorResult(`路径被拒绝：${guard.reason}`, guard.code) };
    if (kind === 'missing') {
      return { ok: false, result: errorResult(`路径不存在或不可读：${raw}`, FS_ERROR_CODES.NOT_FOUND) };
    }
    return { ok: true, path: guard.path, isDirectory: kind === 'directory' };
  }

  const visionRead: ToolDefinition = {
    name: 'vision_read',
    description:
      '读图入缓存：图片路径（png/jpg/webp/gif/bmp，目录递归），逐张读成 peek/text/tags 落 '
      + 'data/vision-cache/（SHA256 为键，命中不重读）。只回计数与 peek，全文用 vision_query 取。'
      + 'inline:true 时原图进上下文。',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: `图片文件或目录路径（相对工作根），目录会递归收集图片；GIF 只取首帧。${PATH_BOUNDARY_HINT}`,
        },
        question: { type: 'string', description: '针对这批图片的问题；不传则用通用描述要求' },
        inline: {
          type: 'boolean',
          description:
            'true = 不转述，把原图直接放进你的上下文（你自己看）。默认 false 走转述（省 token、'
            + '结果可检索）。只在你确实需要看清画面细节时用——比如表情包、截图、要看笔迹或版式。',
        },
      },
      required: ['paths'],
      additionalProperties: false,
    },
    executionMode: 'parallel',
    sideEffect: 'none',
    timeoutMs: VISION_READ_TIMEOUT_MS,
    handler: async (args, ctx) => {
      if (ctx.signal.aborted) return errorResult('调用已被取消，未读取任何图片。', TOOL_ERROR_CODES.aborted);
      const a = argsRecord(args, 'vision_read');
      const rawPaths = a['paths'];
      if (!Array.isArray(rawPaths)) {
        return errorResultFromThrown(new ToolArgumentError('paths', 'paths 必须是字符串数组'), VISION_ERROR_CODES.INTERNAL_ERROR);
      }
      const paths = rawPaths.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
      if (paths.length === 0) {
        return errorResultFromThrown(new ToolArgumentError('paths', 'paths 至少需要一个非空路径'), VISION_ERROR_CODES.INTERNAL_ERROR);
      }

      return (async (): Promise<ToolHandlerResult> => {
        const question = optionalString(a, 'question', { maxLength: 4_096 }) ?? DEFAULT_QUESTION;

        const files: string[] = [];
        const skipped: string[] = [];
        for (const raw of paths) {
          const target = await resolveTarget(ctx, raw);
          if (!target.ok) return target.result;
          if (target.isDirectory) {
            await collectImages(target.path, files, skipped);
            continue;
          }
          if (imageMimeOf(target.path) === null) {
            return errorResult(
              `不支持的图片扩展名：${raw}（支持 png/jpg/jpeg/webp/gif/bmp）`,
              VISION_ERROR_CODES.UNSUPPORTED_TYPE,
            );
          }
          files.push(target.path);
        }

        const unique = [...new Set(files)].sort();
        if (unique.length > maxPaths) {
          return errorResult(
            `本次请求 ${unique.length} 张图，超过单次上限 ${maxPaths} 张。请分批调用。`,
            VISION_ERROR_CODES.TOO_MANY_PATHS,
          );
        }

        // ── inline：不做转述，把原图直接放进上下文 ──
        //
        // 工具结果是文本，塞不下图片，所以走一条 `image/attached` 事件：渲染层看到它就把
        // 本地字节作为 input_image 注入（见 render.ts 的 imagesOf）。这也是"图片两条途径"
        // 里的第二条——默认那条是转述，这一条是她明确说"我要自己看"时才走。
        if (a['inline'] === true) {
          if (options.emit === undefined || options.imagesToContext !== true) {
            return errorResult(
              'inline 现在不通：图片直通没开（config.vision.imagesToContext）。'
              + '省略 inline 走转述，它会给你一段文字描述。',
              VISION_ERROR_CODES.INLINE_DISABLED,
            );
          }
          const attached: string[] = [];
          /**
           * 扩展名认得出、**载荷却进不去上下文**的那些（`.bmp` / `.tiff` 之类）。
           *
           * 为什么要单独攒一份（2026-10-11 修的一处"说了做了、其实没做"）：进上下文的型别
           * 白名单只有 png/jpeg/gif/webp（`CONTEXT_IMAGE_MEDIA_TYPES`），而 `imageMimeOf`
           * 认得 `image/bmp`——原先 inline 只看扩展名就把事件写下去，渲染层（`imagesOf` 的
           * `contextImageMimeAllowed`）当场丢掉它，**而回执照旧说"图片已放进你的上下文"**。
           * 实测：事件 1 条、请求体 input_image = 0。现在这一类不写事件，理由与出路进回执。
           */
          const notAdmitted: Array<{ file: string; mime: string }> = [];
          for (const file of unique) {
            const mime = imageMimeOf(file);
            if (mime === null) continue;
            const rel = posixRelative(ctx.workspaceRoot, file);
            // 判据**只此一处**：与渲染层挑图用的同一个函数（不在本文件另抄一份白名单）
            if (!contextImageMimeAllowed(mime)) {
              notAdmitted.push({ file: rel, mime });
              continue;
            }
            options.emit('image/attached', {
              key: rel,
              mime,
              ...(basename(file) === '' ? {} : { name: basename(file) }),
            });
            attached.push(rel);
          }
          if (attached.length === 0) {
            // 一张都没进去时**不许**说"已放进上下文"：说清是哪一张、为什么、以及她还能走哪条路
            if (notAdmitted.length > 0) {
              return errorResult(
                notAdmitted.map(({ file, mime }) => `${file} 是 ${mime}，进不去上下文`).join('；')
                + `（模型只认 ${CONTEXT_IMAGE_MEDIA_TYPES.map((t) => t.replace(/^image\//u, '')).join('/')}）——`
                + '要看它就走转述（省略 inline，会给一段文字描述），'
                + '或者先把它转成 png/jpeg 再 inline。',
                VISION_ERROR_CODES.UNSUPPORTED_TYPE,
              );
            }
            return errorResult('没有可放进上下文的图片。', VISION_ERROR_CODES.UNSUPPORTED_TYPE);
          }
          return okResult(JSON.stringify({
            inline: true,
            attached,
            // 部分进不去时如实列出来（进得去的那几张照旧，别让"少了一张"只能靠对路径才发现）
            ...(notAdmitted.length === 0 ? {} : { skipped: notAdmitted }),
            hint: '图片已放进你的上下文——直接看，不用再读一遍文件。'
              + '转述（省略 inline）会把描述写进缓存，将来能按关键词检索；直通不进缓存。'
              + (notAdmitted.length === 0
                ? ''
                : `（另有 ${notAdmitted.length} 张没进去：型别不在模型认的名单里，见 skipped——`
                  + '要看它们就改用转述。）'),
          }));
        }

        const items: VisionReadItem[] = [];
        let cachedCount = 0;
        let freshCount = 0;

        for (const file of unique) {
          const filename = posixRelative(ctx.workspaceRoot, file);
          let bytes: Buffer;
          try {
            const info = await stat(file);
            if (info.size > maxImageBytes) {
              items.push({
                filename,
                error: {
                  code: VISION_ERROR_CODES.TOO_LARGE,
                  message: `图片 ${info.size} 字节超过上限 ${maxImageBytes} 字节，已跳过`,
                },
              });
              continue;
            }
            bytes = await readFile(file);
          } catch (err) {
            items.push({
              filename,
              error: {
                code: VISION_ERROR_CODES.READ_FAILED,
                message: err instanceof Error ? err.message : String(err),
              },
            });
            continue;
          }
          if (bytes.byteLength > maxImageBytes) {
            items.push({
              filename,
              error: {
                code: VISION_ERROR_CODES.TOO_LARGE,
                message: `图片 ${bytes.byteLength} 字节超过上限 ${maxImageBytes} 字节，已跳过`,
              },
            });
            continue;
          }

          const sha256 = sha256Hex(bytes);
          const mime = imageMimeOf(file) ?? 'application/octet-stream';
          const resultId = visionResultId(sha256, model, question);
          const entries = await readCacheEntries(join(cacheDir, `${sha256}.json`));
          const hit = entries.find((entry) => entry.result_id === resultId);
          if (hit !== undefined) {
            cachedCount += 1;
            items.push({
              filename,
              result_id: hit.result_id,
              peek: hit.peek,
              tags: hit.tags,
              bytes: hit.bytes,
              cached: true,
              ...(hit.note === undefined ? {} : { note: hit.note }),
            });
            continue;
          }

          const note = mime === 'image/gif' ? 'GIF 仅首帧：按静态图读取，动图后续帧未分析' : undefined;

          const request: VisionGenerateRequest = {
            lane: 'light',
            model,
            input: [
              {
                role: 'user',
                content: [
                  { type: 'input_text', text: question },
                  { type: 'input_image', image_url: `data:${mime};base64,${bytes.toString('base64')}` },
                ],
              },
            ],
            text: { type: 'json_schema', name: 'vision_result', schema: VISION_RESULT_SCHEMA },
            // 思考强度：**用户的口径（2026-10-06）—— light 一律 `low`，不提供更改**。
            // 这一行不是随手选的：补上之前它是**缺席**的，而缺席 = 服务端默认 `high`
            // （官方文档），也就是每张图都在最贵的档上想。**别给这里加配置项**——
            // 判据钉在 `test/thinking-effort-invariant.test.ts`（六处调用点逐个断言）。
            reasoning: { effort: 'low' },
          };

          let raw: string;
          try {
            const response = await options.dsClient.generate(request);
            raw = extractResponseText(response);
          } catch (err) {
            items.push({
              filename,
              error: {
                code: ctx.signal.aborted ? TOOL_ERROR_CODES.aborted : VISION_ERROR_CODES.MODEL_FAILED,
                message: err instanceof Error ? err.message : String(err),
              },
            });
            continue;
          }
          if (raw === '') {
            items.push({
              filename,
              error: { code: VISION_ERROR_CODES.EMPTY_RESPONSE, message: '模型返回空内容，未写缓存' },
            });
            continue;
          }

          const parsed = parseVisionResult(raw);
          const record: VisionCacheEntry = {
            result_id: resultId,
            sha256,
            model,
            question,
            filename,
            peek: parsed.peek,
            text: parsed.text,
            tags: parsed.tags,
            createdAt: clock().toISOString(),
            bytes: bytes.byteLength,
            mime,
            ...(note === undefined ? {} : { note }),
            ...(parsed.fallback ? { fallback: true } : {}),
          };
          try {
            await writeCacheEntries(cacheDir, sha256, [
              ...entries.filter((entry) => entry.result_id !== resultId),
              record,
            ]);
          } catch (err) {
            items.push({
              filename,
              error: {
                code: VISION_ERROR_CODES.CACHE_WRITE_FAILED,
                message: err instanceof Error ? err.message : String(err),
              },
            });
            continue;
          }
          freshCount += 1;
          items.push({
            filename,
            result_id: record.result_id,
            peek: record.peek,
            tags: record.tags,
            bytes: record.bytes,
            cached: false,
            ...(note === undefined ? {} : { note }),
            ...(parsed.fallback ? { fallback: true } : {}),
          });
        }

        const failed = items.filter((item) => 'error' in item).length;
        const summary = {
          total: items.length,
          fresh: freshCount,
          cached: cachedCount,
          failed,
          skipped_non_image: skipped.length,
          model,
          question,
          cache_dir: `${VISION_CACHE_DIR_NAME}/`,
          images: items,
          hint:
            failed > 0
              ? '失败项见 images[].error；缓存写入失败的图片下次调用会重试。全文用 vision_query(result_id=...) 取。'
              : '全文用 vision_query(result_id=...) 取，可按关键词/文件名/recent 检索。',
        };
        return okResult(JSON.stringify(summary));
      })().catch((err: unknown) => errorResultFromThrown(err, VISION_ERROR_CODES.INTERNAL_ERROR));
    },
  };

  const visionQuery: ToolDefinition = {
    name: 'vision_query',
    description:
      '查视觉缓存：query 关键词（空格式，全部关键词都命中才算）／filename 子串／recent N 取最近，返回 result_id、filename、peek、tags 列表；给 result_id 则返回该条全文。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，空格分隔；全部命中（AND 子串匹配 peek/text/tags/文件名）' },
        filename: { type: 'string', description: '文件名子串过滤' },
        recent: { type: 'integer', description: '只取最近 N 条（按读入时间倒序）' },
        offset: { type: 'integer', description: '分页偏移，默认 0' },
        limit: { type: 'integer', description: '本次返回条数，默认 20，最大 100' },
        result_id: { type: 'string', description: '给定则返回该条完整内容（含 text 全文）' },
      },
      additionalProperties: false,
    },
    executionMode: 'parallel',
    sideEffect: 'none',
    timeoutMs: VISION_QUERY_TIMEOUT_MS,
    handler: async (args, ctx) => {
      if (ctx.signal.aborted) return errorResult('调用已被取消，未查询缓存。', TOOL_ERROR_CODES.aborted);
      try {
        const a = argsRecord(args, 'vision_query');
        const resultId = optionalString(a, 'result_id', { maxLength: 128 });
        const query = optionalString(a, 'query', { maxLength: 4_096 });
        const filenameFilter = optionalString(a, 'filename', { maxLength: 1_024 });
        const recent = optionalInteger(a, 'recent', 0, { min: 1, max: 10_000 });
        const offset = optionalInteger(a, 'offset', 0, { min: 0 });
        const limit = Math.min(optionalInteger(a, 'limit', 20, { min: 1, max: 100 }), 100);

        let names: string[];
        try {
          names = await readdir(cacheDir);
        } catch {
          return okResult(
            JSON.stringify({
              total: 0,
              offset,
              limit,
              items: [],
              hint: '视觉缓存目录还不存在（尚未成功执行过 vision_read）。',
            }),
          );
        }

        const all: VisionCacheEntry[] = [];
        for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
          all.push(...(await readCacheEntries(join(cacheDir, name))));
        }

        if (resultId !== null && resultId !== undefined) {
          const found = all.find((entry) => entry.result_id === resultId);
          if (found === undefined) {
            return errorResult(
              `缓存里没有 result_id=${resultId} 的结果。先用 vision_query 列表确认 id。`,
              FS_ERROR_CODES.NOT_FOUND,
            );
          }
          return okResult(JSON.stringify(found));
        }

        const keywords = (query ?? '')
          .split(/\s+/)
          .map((keyword) => keyword.trim().toLowerCase())
          .filter((keyword) => keyword !== '');
        let filtered = all.filter((entry) => {
          if (filenameFilter !== undefined && !entry.filename.toLowerCase().includes(filenameFilter.toLowerCase())) {
            return false;
          }
          if (keywords.length === 0) return true;
          const haystack = `${entry.peek}\n${entry.text}\n${entry.tags.join(' ')}\n${entry.filename}`.toLowerCase();
          return keywords.every((keyword) => haystack.includes(keyword));
        });

        // 排序确定性：读入时间倒序，同刻按 result_id 升序（与 §4.13 渲染确定性同一原则）
        filtered = filtered.sort((x, y) => {
          if (x.createdAt !== y.createdAt) return x.createdAt < y.createdAt ? 1 : -1;
          return x.result_id.localeCompare(y.result_id);
        });
        if (recent > 0) filtered = filtered.slice(0, recent);

        const page = filtered.slice(offset, offset + limit);
        return okResult(
          JSON.stringify({
            total: filtered.length,
            offset,
            limit,
            items: page.map((entry) => ({
              result_id: entry.result_id,
              filename: entry.filename,
              peek: entry.peek,
              tags: entry.tags,
              createdAt: entry.createdAt,
              model: entry.model,
              ...(entry.note === undefined ? {} : { note: entry.note }),
              ...(entry.fallback === true ? { fallback: true } : {}),
            })),
            hint:
              page.length === 0
                ? '没有命中。换个关键词，或不带参数列出全部（可配 recent/limit）。'
                : '用 result_id=<id> 取单条全文。',
          }),
        );
      } catch (err) {
        return errorResultFromThrown(err, VISION_ERROR_CODES.INTERNAL_ERROR);
      }
    },
  };

  return [visionRead, visionQuery];
}
