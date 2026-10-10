/**
 * Irmia Agent — 文件系工具包：只读两件（safe_read / read_blob）
 *
 * 两件工具都是 sideEffect none + parallel（design.md §4.18 工具清单）。
 * 只读不等于随便读，三条纪律：
 *   1. 一律先过 resolveInsideRoot 白名单（符号链接展开后再比，M4-1/M4-2）；
 *   2. 大文件不整读——按硬上限截断后如实告知，并指明下一步怎么拿（§4.18 五原则第 4 条）；
 *   3. blob 目录是第二白名单：blobId 只接受 64 位十六进制，path 只接受 blob 根内的相对路径。
 *
 * **v42：`list_dir` 删掉了，列目录这件事并进 `safe_read`。**
 *
 * 依据是实测（`data/events/**` 全部 `tool/call`，改前）：`list_dir` 201 次 / 5264 次总量，
 * 近 24h 仅 1 次，而它常驻 212 token（name 2 / desc 40 / params 170）——用户拍板删掉，
 * 腾出的常驻开销要给后面的 `mcp` 入口。
 *
 * 删工具**不等于删能力**，两条配套一起落地：
 *   · `safe_read` **收目录**：传目录路径就把目录内容列出来（`renderDirectoryListing`，
 *     与旧 `list_dir` 同一套渲染、同一套上限），她再也不必先猜"这是文件还是目录"——
 *     那正是历史上 13 次 `list_dir` 失败与 1 次 `safe_read` 传目录的同一个病根；
 *   · `pwsh` 的描述里补半句指路（`Get-ChildItem`），递归/隐藏/按时间排这些少数用法有出口。
 *
 * **判据一处**：列目录的渲染只有 {@link renderDirectoryListing} 一份实现。删 `list_dir` 时
 * 最该避免的就是"两个工具各写一套列目录"——那正是它当初该合并的理由。
 *
 * 名字是 safe_read 而不是 read_file：它与 safe_write / safe_edit / safe_rollback 是同一族
 * （devkit 原名）。v27 之前我们叫 read_file，那是移植时的漏改——同一族里三件叫 safe_*、
 * 一件不叫，模型看不出它们该配着用。
 */

import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';

// blob 目录名与 blobId 形状的唯一定义点在 state/blob-store.ts（写入端同源），这里只做转发
import { BLOB_DIR_NAME, BLOB_ID_PATTERN } from '../../state/blob-store.ts';
import { PATH_BOUNDARY_HINT } from '../boundary.ts';
import type { FsEnv } from './env.ts';
import { resolveGuarded } from './env.ts';
import { resolveInsideRoot } from './path-guard.ts';
import { readDirEntries } from './search-core.ts';
import {
  decodeText,
  formatBytes,
  LINE_NUMBER_WIDTH,
  looksBinary,
  splitLines,
  withLineNumbers,
  type DetectedEncoding,
} from './text-codec.ts';
import {
  ABORTED_RESULT,
  FS_ERROR_CODES,
  argsObject,
  fail,
  invalidArgs,
  ok,
  readOptionalInt,
  readOptionalString,
  readString,
  toErrorMessage,
  type ToolContext,
  type ToolDefinition,
} from './types.ts';

export { BLOB_DIR_NAME, BLOB_ID_PATTERN };

/**
 * `safe_read` 单次**解析**的字节上限：不设它就会在无人值守时把内存吃干。
 *
 * 它**不是**编辑器那一侧的上限，两者职责不同、也**不该相同**：
 *   · 这里是"一次读进内存多少"——超出的部分不解析，所以算出来的**行数只是前半截的**；
 *   · 编辑侧（`DEFAULT_MAX_EDIT_BYTES`，20 MiB）是"整个文件要不要拒绝编辑"——超了直接拒，
 *     不存在"只编辑一半"。
 *
 * ⚠ **两边数值不同本身没问题，"不同却不说明"才是问题**：8~20 MiB 的文件里，
 * `safe_read` 报的行数只覆盖前 8 MiB，而 `safe_edit` 的 `insert_at_line`/`delete_lines`
 * 是按**整文件**的行号结算的。她照一个偏小的行数去 `insert_at_line`，会插在文件中间
 * **而且不报错**（实测：16 万行的文件 `safe_read` 报 129056 行，真实 160000 行）。
 *
 * 所以这条上限**必须**在触顶时把"只读到哪、行号只在哪一段内有效"说出来——
 * 见下面 `truncatedAtLimit` 那一段与它写进回执的话。
 */
const HARD_READ_LIMIT = 8 * 1024 * 1024;

function blobDir(env: FsEnv, ctx: ToolContext): string {
  return join(env.dataDir(ctx), BLOB_DIR_NAME);
}

type EncodingConfidence = 'certain' | 'probe' | 'fallback';

function decodeWithEncoding(
  buf: Buffer,
  requested: string | undefined,
): { text: string; encoding: DetectedEncoding; confidence: EncodingConfidence; notes: string[] } {
  if (requested === undefined || requested === 'auto') {
    const decoded = decodeText(buf);
    return { text: decoded.text, encoding: decoded.encoding, confidence: decoded.confidence, notes: decoded.notes };
  }
  const label = requested.toLowerCase();
  if (label === 'utf16be') {
    const body = buf.subarray(0, buf.length - (buf.length % 2));
    const swapped = Buffer.from(body);
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf16be', confidence: 'certain', notes: [] };
  }
  const map: Record<string, string> = {
    utf8: 'utf8',
    'utf-8': 'utf8',
    utf16le: 'utf16le',
    'utf-16le': 'utf16le',
    gbk: 'gbk',
    gb18030: 'gbk',
    latin1: 'latin1',
    binary: 'latin1',
  };
  const decoderLabel = map[label];
  if (decoderLabel === undefined) {
    const decoded = decodeText(buf);
    return {
      text: decoded.text,
      encoding: decoded.encoding,
      confidence: decoded.confidence,
      notes: [`不认识的 encoding「${requested}」，已按自动检测处理`],
    };
  }
  try {
    const text = new TextDecoder(decoderLabel).decode(buf);
    return {
      text,
      encoding: (label === 'utf-8' ? 'utf8' : label) as DetectedEncoding,
      confidence: 'certain',
      notes: [],
    };
  } catch (err) {
    return {
      text: buf.toString('utf8'),
      encoding: 'utf8',
      confidence: 'fallback',
      notes: [`按 ${requested} 解码失败（${toErrorMessage(err)}），已退回 UTF-8`],
    };
  }
}

/**
 * 按 UTF-8 字节把**单个字符串**截到上限以内，不切坏代理对（emoji / 生僻字）。
 *
 * 只在"一行本身就超过字节上限"时用得上：那时按行截断没有位置可切，只能切行内。
 * 二分而不是逐字符累加——4 MB 的行逐字符算字节是 O(n²)，会把一次 safe_read 变成几十秒。
 */
function cutToByteBudget(line: string, budget: number): string {
  if (budget <= 0) return '';
  if (Buffer.byteLength(line, 'utf8') <= budget) return line;
  let lo = 0;
  let hi = line.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    // 落在代理对中间时退一格：半个代理对编出来是替换字符，不如少一个字符
    const end = mid > 0 && mid < line.length && /[\uD800-\uDBFF]/u.test(line[mid - 1] as string) ? mid - 1 : mid;
    if (Buffer.byteLength(line.slice(0, end), 'utf8') <= budget) lo = mid;
    else hi = mid - 1;
  }
  return line.slice(0, lo);
}

// ──────────────────────────────── safe_read ────────────────────────────────

export function createSafeReadTool(env: FsEnv): ToolDefinition {
  return {
    name: 'safe_read',
    description:
      '读取文本文件，**每行都带真实行号前缀**（`  12│ 内容`，safe_edit 的三种模式都认这个行号）。' +
      `offset/limit 取区间、head/tail 取两端。传目录则列目录。`
      + `自动检测编码（BOM/UTF-8/GBK）。只读。${PATH_BOUNDARY_HINT}。`,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件或目录路径：相对工作根或绝对路径；MEMORIES/ 与 diary/ 会自动落到记忆目录。'
            + `传目录时列出里面的条目（类型/大小/修改时间，见 depth 与 limit）。${PATH_BOUNDARY_HINT}`,
        },
        offset: { type: 'integer', description: '起始行号，1-based，默认 1（0 与 1 等价，都表示从头）' },
        limit: { type: 'integer', description: '最多返回多少行，默认全部（受上限保护）；path 是目录时＝最多列多少条，默认 200' },
        head: { type: 'integer', description: '只读前 N 行，与 offset/limit/tail 互斥（目录不适用）' },
        tail: { type: 'integer', description: '只读后 N 行，与 offset/limit/head 互斥（目录不适用）' },
        depth: { type: 'integer', description: 'path 是目录时的递归层数：1 只列直接子项，默认 1，上限 5' },
        encoding: {
          type: 'string',
          enum: ['auto', 'utf8', 'utf16le', 'utf16be', 'gbk', 'latin1'],
          description: '强制指定编码，默认 auto 自动检测',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        encoding: { type: 'string' },
        total_lines: { type: 'integer' },
        shown: { type: 'string' },
        content: { type: 'string' },
        truncated: { type: 'boolean' },
      },
    },
    executionMode: 'parallel',
    sideEffect: 'none',
    timeoutMs: 10_000,
    async handler(rawArgs: unknown, ctx: ToolContext) {
      const args = argsObject(rawArgs, 'safe_read');
      if (args === null) return invalidArgs('safe_read', '期望一个对象，例如 {"path": "src/main.ts"}');
      const pathInput = readString(args, 'path');
      if (pathInput === null || pathInput === '') return invalidArgs('safe_read', '缺少 path');

      // offset 的语义：**起始行号，1-based**（不是 devkit 的"hex 字节偏移"）。
      //
      // 为什么保留行号语义、不改名：本仓库 `offset` 的行内坐标是**处处一致**的
      // ——`safe_read` 的 offset / `limit` 与 `head`/`tail`、`safe_edit` 的
      // `insert_at_line`/`delete_lines` 行号、`withLineNumbers` 印出来的真实行号
      // 共用同一套地址（read-tools.ts 的模块注释第 3 条、design.md:778）。
      // 改成字节偏移会把这条唯一的"读→改"地址链拆成两套坐标，而 `read_blob` 已经
      // 是字节坐标了（它服务的是工具结果外置后的回读），两件工具同名不同根正是
      // 模型最容易算错的地方。devkit 那边 `offset` 只服务 `mode=hex`，它的行寻址
      // 用的是另一个参数 `start_line`（`tools/safe_read.py:661,677`）——本仓库没有
      // hex 模式，所以**没有**这个同名冲突面。改名（offset → start_line）留给用户拍板：
      // 它要动 skills/ 与文档里的既有写法，收益只是"与源同名"，不是修 bug。
      //
      // 但 `offset: 0` 必须收下：devkit 的 `start_line` 默认就是 0、0 表示"从头"
      // （`_registry.py:1194-1263`），模型照那边的习惯回填 `offset: 0` 时本地会当场
      // 报"必须是 >= 1 的整数"（docs/devkit-migration-audit.md §3.1 #9）——同一个意思
      // 在两处一个合法一个报错，是纯心智负担。所以这里**最小仍是 0，0 归一成 1**。
      const offsetRes = readOptionalInt(args, 'offset', 0, Number.MAX_SAFE_INTEGER);
      if ('error' in offsetRes) return invalidArgs('safe_read', offsetRes.error);
      const limitRes = readOptionalInt(args, 'limit', 1, 200_000);
      if ('error' in limitRes) return invalidArgs('safe_read', limitRes.error);
      const headRes = readOptionalInt(args, 'head', 1, 200_000);
      if ('error' in headRes) return invalidArgs('safe_read', headRes.error);
      const tailRes = readOptionalInt(args, 'tail', 1, 200_000);
      if ('error' in tailRes) return invalidArgs('safe_read', tailRes.error);
      const depthRes = readOptionalInt(args, 'depth', DIR_DEPTH_MIN, DIR_DEPTH_MAX);
      if ('error' in depthRes) return invalidArgs('safe_read', depthRes.error);

      const head = headRes.value;
      const tail = tailRes.value;
      const offset = offsetRes.value;
      const limit = limitRes.value;
      if (head !== undefined && tail !== undefined) {
        return invalidArgs('safe_read', 'head 与 tail 互斥，只能给一个');
      }
      if ((head !== undefined || tail !== undefined) && (offset !== undefined || limit !== undefined)) {
        return invalidArgs('safe_read', 'head/tail 与 offset/limit 互斥；要区间就用 offset+limit，要两端就只用 head 或 tail');
      }

      // v42：**目录也收**（`allowDirectory`）。从前这里是一句「是目录；查看目录内容请用 list_dir」，
      // 而 list_dir 已经删掉——列目录这件事现在归这里，所以再把它挡回去就是"指路到不存在的工具"。
      const guarded = await resolveGuarded(env, ctx, pathInput, {
        purpose: 'safe_read',
        allowDirectory: true,
      });
      if (!guarded.ok) return fail(guarded.code, guarded.reason);

      let info;
      try {
        info = await stat(guarded.path);
      } catch (err) {
        return fail(FS_ERROR_CODES.IO_ERROR, `无法读取 ${guarded.path}：${toErrorMessage(err)}`);
      }
      if (ctx.signal.aborted) return ABORTED_RESULT;

      // ── 目录分支：走列目录，不再往下进行号那一套 ──
      //
      // offset/head/tail/encoding 对目录没有意义（不静默假装生效：head/tail 给了就在回执里说清），
      // 只有 `limit` 兼职"最多列多少条"——这是 0 成本复用（`limit` 本来就是"这次回执的上限"，
      // 实测旧 `list_dir` 的 `max_entries` 43 次里绝大多数是**调小**：40/60/80），
      // 于是不必再为它添一个常驻参数。
      //
      // depth 是新添的那一个参数（22 token）：实测 `list_dir` 201 次调用里 `depth` 出现 **136 次**
      // （2 层 87 / 1 层 46 / 3 层 3），是它使用率最高的非默认参数——递归这一轴没有同形替代
      // （pwsh 的 Get-ChildItem -Recurse 不给类型/大小/修改时间这三格，也没有条数上限）。
      if (info.isDirectory()) {
        const listing = await renderDirectoryListing(guarded.path, guarded.relPath, {
          ...(depthRes.value === undefined ? {} : { depth: depthRes.value }),
          ...(limit === undefined ? {} : { maxEntries: limit }),
          signal: ctx.signal,
        });
        if (listing.aborted) return ABORTED_RESULT;
        const ignored = head !== undefined || tail !== undefined || offset !== undefined
          ? '\n[提示] head/tail/offset 对目录不适用（它们只在读文件时生效）：列目录的条数用 limit，层数用 depth。'
          : '';
        return ok(listing.content + ignored);
      }

      const size = info.size;

      const readLen = Math.min(size, HARD_READ_LIMIT);
      let buf: Buffer;
      try {
        const handle = await open(guarded.path, 'r');
        try {
          buf = Buffer.allocUnsafe(readLen);
          const read = await handle.read(buf, 0, readLen, 0);
          buf = buf.subarray(0, read.bytesRead);
        } finally {
          await handle.close();
        }
      } catch (err) {
        return fail(FS_ERROR_CODES.IO_ERROR, `读取 ${guarded.path} 失败：${toErrorMessage(err)}`);
      }

      const requestedEncoding = readOptionalString(args, 'encoding');
      if (looksBinary(buf) && requestedEncoding === undefined) {
        return fail(
          FS_ERROR_CODES.BINARY_FILE,
          `${guarded.relPath} 看起来是二进制文件（含 NUL 字节），safe_read 只处理文本。` +
            '若确实要看字节，请用 read_blob 并指定 encoding:"base64"。',
        );
      }

      const decoded = decodeWithEncoding(buf, requestedEncoding);
      const split = splitLines(decoded.text);
      const totalLines = split.lines.length;

      // ── 只解析了前 HARD_READ_LIMIT 字节时，**行数是"前半截的"** ──
      //
      // 这是会真丢内容的那个坑（核查报告 L1）：`totalLines` 是照**已读进来的字节**数出来的，
      // 文件更大时它偏小；而 `safe_edit` 的 `insert_at_line`/`delete_lines` 按**整文件**
      // 行号结算。实测 160000 行的文件这里报 129056 行，她据此 `insert_at_line 129056`
      // 以为在追加，**实际插在文件中间且不报错**；更糟的是编辑回执里同时印着
      // "原文件共 160000 行"与"在第 129056 行之后插入"，两句互相矛盾却不指出。
      //
      // 处置（判据只紧不松）：把"行数不完整"变成回执里**不可能漏看**的一件事——
      // ① 头部那格直接改写成 `约 N 行（仅前 X 内，未数完）`，她不会把 N 当总数；
      // ② 提示里明说**行号只在前 X 内有效**，并明说不要拿它去 insert_at_line/delete_lines。
      // 不给"假装数完"留任何形状。
      const truncatedAtLimit = size > readLen;

      // 区间决议：head/tail 优先于 offset/limit（互斥已在上方挡住混用）
      // 0 与 1 等价：都表示"从头"（devkit 的 start_line=0 就是这个意思）
      let startLine = offset === undefined || offset === 0 ? 1 : offset;
      let endLine: number;
      if (head !== undefined) {
        startLine = 1;
        endLine = Math.min(head, totalLines);
      } else if (tail !== undefined) {
        startLine = Math.max(1, totalLines - tail + 1);
        endLine = totalLines;
      } else {
        const start = Math.min(startLine, Math.max(1, totalLines));
        startLine = start;
        endLine = limit === undefined ? totalLines : Math.min(totalLines, start + limit - 1);
      }
      if (totalLines === 0) {
        startLine = 0;
        endLine = 0;
      }

      const slice = totalLines === 0 ? [] : split.lines.slice(startLine - 1, endLine);
      const lineLimit = env.maxReadLines;
      const beyondLineLimit = slice.length > lineLimit;
      const lineWindow = beyondLineLimit ? slice.slice(0, lineLimit) : slice;

      // ── 字节硬顶（P0）：行数上限挡不住"一行 4MB" ──
      //
      // 旧实现只有 2000 行的上限，`env.maxReadBytes`（默认 256 KiB）**只用来加一句提示**，
      // 不参与截断：实测 3 行 × 1MB 的文件返回 3,145,941 字节、单个 4MB 长行返回 4,194,502
      // 字节，两者都不带截断标记（docs/devkit-migration-audit.md §1 #5）。
      // devkit 的对应常量是 `MAX_BYTES_PER_CALL = 128 * 1024`（`tools/safe_read.py:44`），
      // 在**完整行边界**上截断并给 `truncated` + `next_call`。
      //
      // 为什么这条同时是"省 token"的关键：4 MB 进上下文不是"多花点钱"，是那一次调用本身
      // 就把窗口撑爆，后面所有步骤都在为它让路。停在一行边界上，模型还能用续读参数接着拿。
      const byteLimit = env.maxReadBytes;
      const numbered = withLineNumbers(lineWindow, startLine);
      // 行号前缀（`   1│ `，宽 4 右对齐 + │ + 空格）也占字节，按 UTF-8 数进去：
      // 判据必须是"**真正要发出去的字节**"，否则每行都少算几字节，攒起来正好越界。
      const prefixBytes = LINE_NUMBER_WIDTH + Buffer.byteLength('│ ', 'utf8');
      const shownNumbered: string[] = [];
      let bodyBytes = 0;
      let beyondByteLimit = false;
      for (const line of numbered) {
        // 至少留一行：一行本身就超限时也要给她看到开头（并如实说明被截了多少），
        // "什么都不返回"比"返回一个被切掉的行"更难处理。
        const lineBytes = Buffer.byteLength(line, 'utf8') + prefixBytes + 1;
        if (shownNumbered.length > 0 && bodyBytes + lineBytes > byteLimit) {
          beyondByteLimit = true;
          break;
        }
        shownNumbered.push(line);
        bodyBytes += lineBytes;
        if (bodyBytes > byteLimit) {
          beyondByteLimit = true;
          break;
        }
      }
      const shown = shownNumbered;
      const shownEnd = startLine === 0 ? 0 : startLine + shown.length - 1;

      // 行号是**无条件**的，没有开关：它是 safe_edit 行号寻址（insert_at_line / delete_lines）
      // 唯一的地址来源。给模型一个 line_numbers:false 就等于给一个"关掉自己眼睛"的按钮，
      // 而唯一的收益是省几个 token——参数本身也是常驻开销，所以这里只做减法（v27 删掉了它）。
      let body = shown.join('\n');

      // 上面那个循环保证"至少留一行"，所以**第一行本身就超限**时它整行都在（可能 4 MB）。
      // 这一段把它切到预算内：按行截断在"一行就是整个文件"时没有位置可切，但"什么都不返回"
      // 或"返回 4 MB"都不可接受——后者正是这条修复要治的那个病（实测旧实现单行 4MB 照回）。
      if (beyondByteLimit && shown.length === 1 && Buffer.byteLength(body, 'utf8') > byteLimit) {
        body = cutToByteBudget(body, byteLimit);
      }

      const truncated = size > readLen || beyondLineLimit || beyondByteLimit || shown.length < slice.length;
      // 行数那格：**没数完就绝不说成总数**（`约` + `仅前 X 内` + `未数完` 三处一起说）。
      // 这一格是 edit 侧行号寻址的地址来源，它说错就是"她照着改错行"。
      const linesCell = truncatedAtLimit
        ? `约 ${totalLines} 行（仅前 ${formatBytes(readLen)} 内，未数完）`
        : `${totalLines} 行`;
      const header =
        `${guarded.relPath} · ${decoded.encoding}（${decoded.confidence}） · ${formatBytes(size)} · ` +
        `${linesCell} · 显示 ${startLine}-${shownEnd}`;

      const hints: string[] = [];
      for (const note of decoded.notes) hints.push(`编码说明：${note}`);
      if (truncatedAtLimit) {
        // 这条与上面那个 `linesCell` 是**一对**：一个改头部、一个说清后果。缺任何一个，
        // "把偏小的行数当总数"这条路就又通了。
        hints.push(
          `文件 ${formatBytes(size)} 超过单次解析上限 ${formatBytes(HARD_READ_LIMIT)}，只解析了前 ${formatBytes(readLen)}：`
            + `**上面那个行数只是前 ${formatBytes(readLen)} 内的行数，不是全文件的行数**。`
            + `因此**本次回显的行号只在前 ${formatBytes(readLen)} 内有效**——`
            + '不要拿它去 insert_at_line / delete_lines（编辑器按**整文件**行号结算，靠后的行号会对不上，'
            + '而且不会报错）。要动这么大的文件：先用 rg_search 定位，再按定位到的**区间**读；'
            + '确实要整篇处理时由人在外部编辑器里做。',
        );
      }
      if (beyondLineLimit) {
        hints.push(
          `本次区间共 ${slice.length} 行，超过单次返回上限 ${lineLimit} 行，已截断到前 ${lineLimit} 行；` +
            `继续读请用 offset=${shownEnd + 1}&limit=${lineLimit}。`,
        );
      }
      if (beyondByteLimit) {
        // 说清三件事：被截了、截在多少字节、怎么接着读。少任何一件，模型都会以为这就是全文。
        hints.push(
          `本次返回内容已达单次字节上限 ${formatBytes(byteLimit)}（返回 ${formatBytes(bodyBytes)}），` +
            `**这不是文件全文**——只发到第 ${shownEnd} 行就停了（该行可能也被切短）。` +
            `继续读请用 offset=${shownEnd + 1}&limit=${lineLimit}，或用 rg_search 定位后只取那一小段。`,
        );
      }
      if (!beyondByteLimit && size > env.maxReadBytes) {
        hints.push(`提示：文件较大（${formatBytes(size)}），若这是外置的工具结果，用 read_blob 分页取更省上下文。`);
      }
      if (totalLines > 0 && shownEnd < totalLines) {
        hints.push(`文件还有 ${totalLines - shownEnd} 行未显示。`);
      }
      if (decoded.confidence === 'fallback') {
        hints.push('编码探针未能确定编码，内容可能显示为乱码；可传 encoding 参数强制指定。');
      }

      const content = truncated
        ? `${header} [截断]\n${body}${hints.length === 0 ? '' : `\n\n[续读提示]\n${hints.map((h) => `· ${h}`).join('\n')}`}`
        : `${header}\n${body}${hints.length === 0 ? '' : `\n\n[提示]\n${hints.map((h) => `· ${h}`).join('\n')}`}`;
      return ok(content, hints);
    },
  };
}

// ──────────────────────────────── 列目录（唯一实现） ────────────────────────────────

const KIND_LABEL: Record<string, string> = {
  directory: '[D]',
  file: '[F]',
  symlink: '[L]',
  other: '[?]',
};

/** 递归层数：默认 1（只列直接子项）、上限 5 —— 与旧 `list_dir` 的 `depth` 同口径 */
export const DIR_DEPTH_MIN = 1;
export const DIR_DEPTH_DEFAULT = 1;
export const DIR_DEPTH_MAX = 5;
/** 条数：默认 200、上限 5000 —— 与旧 `list_dir` 的 `max_entries` 同口径 */
export const DIR_ENTRIES_DEFAULT = 200;
export const DIR_ENTRIES_MAX = 5000;

export interface DirListingOptions {
  /** 递归层数，1..{@link DIR_DEPTH_MAX}，默认 {@link DIR_DEPTH_DEFAULT} */
  depth?: number;
  /** 最多返回多少条，默认 {@link DIR_ENTRIES_DEFAULT}、上限 {@link DIR_ENTRIES_MAX} */
  maxEntries?: number;
  /** 是否列出以 `.` 开头的条目，默认 false（与旧 `list_dir` 的默认一致，见下方注释） */
  includeHidden?: boolean;
  /** 中断信号：遍历在每个条目边界查一次（design.md §4.5） */
  signal?: AbortSignal;
}

export interface DirListing {
  /** 完整回执正文（头部 + 逐条 + 截断说明） */
  content: string;
  /** 是否因为条数上限被截断（如实告知，不假装列完了） */
  truncated: boolean;
  /** 遍历途中被中断（调用方应当回 ABORTED_RESULT，而不是把这个当成功） */
  aborted: boolean;
}

/**
 * 列目录的**唯一渲染实现**。
 *
 * v42 删掉 `list_dir` 之后，它是唯一的列目录出口（`safe_read` 传目录时走它）。**「只许有一处
 * 实现」是这次删除的判据本身**：删 `list_dir` 的意义就是不要再有"两个工具各写一套列目录"——
 * 两份实现立刻会分叉成"同一个目录、两件工具给出两种形状"，而历史上 13 次 `list_dir` 失败与
 * 1 次 `safe_read` 传目录，病根正是"文件还是目录要先猜对工具"。
 *
 * 所以这里**只认路径与选项，不认工具名**：谁调都一样。
 *
 * 行为逐项对齐旧 `list_dir`（口径不新造）：`[D]/[F]/[L]/[?]` 四种标记、文件才有大小、
 * 修改时间取 ISO、目录名带尾 `/`、按 `localeCompare` 排名字、默认**不列隐藏条目**
 * （依据 devkit 的同名参数 `show_hidden` 默认 False，`tools/dir_list.py:11-13`）、
 * 符号链接不跟进（不会成环，见 `readDirEntries` 的 kind 判定）。
 */
export async function renderDirectoryListing(
  dir: string,
  relPath: string,
  options: DirListingOptions = {},
): Promise<DirListing> {
  const depth = options.depth ?? DIR_DEPTH_DEFAULT;
  const maxEntries = Math.min(options.maxEntries ?? DIR_ENTRIES_DEFAULT, DIR_ENTRIES_MAX);
  const includeHidden = options.includeHidden ?? false;
  const signal = options.signal;

  const lines: string[] = [];
  let truncated = false;
  let aborted = false;
  let dirCount = 0;
  let fileCount = 0;

  const walk = async (target: string, level: number, relPrefix: string): Promise<void> => {
    if (truncated || aborted) return;
    if (signal?.aborted === true) {
      aborted = true;
      return;
    }
    let entries = await readDirEntries(target);
    if (entries === null) {
      lines.push(`(无法读取目录) ${relPrefix}`);
      return;
    }
    if (!includeHidden) entries = entries.filter((entry) => !entry.name.startsWith('.'));
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (lines.length >= maxEntries) {
        truncated = true;
        return;
      }
      const label = KIND_LABEL[entry.kind] ?? '[?]';
      const size = entry.kind === 'file' ? formatBytes(entry.size) : '-';
      const when = entry.mtimeMs === 0 ? '-' : new Date(entry.mtimeMs).toISOString();
      const suffix = entry.kind === 'directory' ? '/' : '';
      if (entry.kind === 'directory') dirCount += 1;
      else fileCount += 1;
      lines.push(`${label} ${relPrefix}${entry.name}${suffix}  ${size}  ${when}`);
      if (entry.kind === 'directory' && level < depth) {
        await walk(entry.path, level + 1, `${relPrefix}${entry.name}/`);
      }
    }
  };

  await walk(dir, 1, '');
  if (aborted) return { content: '', truncated, aborted };

  const header =
    `${relPath === '' ? '.' : relPath}/ · 目录 ${dirCount} 个 / 文件 ${fileCount} 个 · depth=${depth}`;
  const body = lines.length === 0 ? '(空目录)' : lines.join('\n');
  // 截断说明要**可执行**：说清被截了多少、以及三条真的能缩小范围的路（这是"把上限说出口"
  // 与"指路"的同一句话，不是客套）。旧 list_dir 只说了"缩小范围或用 rg_search/es_search"。
  const tailNote = truncated
    ? `\n[已截断：上限 ${maxEntries} 条（同层按名称排序）。缩小 path、调小 depth，`
      + '或用 rg_search（按内容）/es_search（按文件名）精确定位；'
      + '要按修改时间或大小排序、要看隐藏项（.env 这类），用 pwsh 的 Get-ChildItem。]'
    : '';
  return { content: `${header}\n${body}${tailNote}`, truncated, aborted };
}

// ──────────────────────────────── read_blob ────────────────────────────────

const BLOB_PAGE_DEFAULT = 64 * 1024;
const BLOB_PAGE_MAX = 1024 * 1024;

export function createReadBlobTool(env: FsEnv): ToolDefinition {
  return {
    name: 'read_blob',
    description:
      '分页读取 data/blobs/ 的内容寻址文件（工具大结果外置区）。' +
      '用 blobId（sha256）或 blob 根内相对路径；offset/limit 按字节。文本自动解码，二进制返回 base64。',
    parameters: {
      type: 'object',
      properties: {
        blobId: { type: 'string', description: '内容寻址 id（sha256 十六进制，64 位）' },
        path: { type: 'string', description: 'blob 根内的相对路径，与 blobId 二选一' },
        offset: { type: 'integer', description: '起始字节偏移，默认 0' },
        limit: { type: 'integer', description: '读取字节数，默认 65536，上限 1048576' },
        encoding: { type: 'string', enum: ['auto', 'utf8', 'base64'], description: '默认 auto（文本解码）' },
      },
      required: [],
      additionalProperties: false,
    },
    executionMode: 'parallel',
    sideEffect: 'none',
    timeoutMs: 10_000,
    async handler(rawArgs: unknown, ctx: ToolContext) {
      const args = argsObject(rawArgs, 'read_blob');
      if (args === null) return invalidArgs('read_blob', '期望一个对象，例如 {"blobId": "<sha256>"}');
      const blobId = readOptionalString(args, 'blobId');
      const relPath = readOptionalString(args, 'path');
      if ((blobId === undefined || blobId === '') && (relPath === undefined || relPath === '')) {
        return invalidArgs('read_blob', 'blobId 与 path 至少给一个');
      }
      const offsetRes = readOptionalInt(args, 'offset', 0, Number.MAX_SAFE_INTEGER);
      if ('error' in offsetRes) return invalidArgs('read_blob', offsetRes.error);
      const limitRes = readOptionalInt(args, 'limit', 1, BLOB_PAGE_MAX);
      if ('error' in limitRes) return invalidArgs('read_blob', limitRes.error);
      const offset = offsetRes.value ?? 0;
      const limit = limitRes.value ?? BLOB_PAGE_DEFAULT;
      const encoding = readOptionalString(args, 'encoding') ?? 'auto';

      const root = blobDir(env, ctx);
      let target: string;
      if (blobId !== undefined && blobId !== '') {
        if (!BLOB_ID_PATTERN.test(blobId)) {
          return invalidArgs('read_blob', 'blobId 必须是 64 位小写十六进制 sha256');
        }
        target = join(root, blobId);
      } else {
        const guarded = await resolveInsideRoot(root, relPath as string, { purpose: 'read_blob' });
        if (!guarded.ok) {
          return fail(
            guarded.code,
            guarded.reason,
          );
        }
        target = guarded.path;
      }

      let size: number;
      try {
        size = (await stat(target)).size;
      } catch {
        return fail(
          FS_ERROR_CODES.NOT_FOUND,
          `blob 不存在：${target}。blob 根为 ${root}；用 blobId 时请确认它来自某次工具结果的 contentRef。`,
        );
      }

      if (offset >= size && size > 0) {
        return fail(
          FS_ERROR_CODES.INVALID_ARGS,
          `offset ${offset} 超出 blob 长度 ${size}；请从 0 开始分页。`,
        );
      }

      const readLen = Math.min(limit, Math.max(0, size - offset));
      const buf = Buffer.allocUnsafe(readLen);
      try {
        const handle = await open(target, 'r');
        try {
          const read = await handle.read(buf, 0, readLen, offset);
          if (read.bytesRead !== readLen) {
            // 文件在读取期间被截断：以实际读到的为准，不假装读满
            return ok(
              `blob ${target} 在读取期间被修改（请求 ${readLen} 字节，实得 ${read.bytesRead} 字节）；请重新分页。`,
            );
          }
        } finally {
          await handle.close();
        }
      } catch (err) {
        return fail(FS_ERROR_CODES.IO_ERROR, `读取 blob 失败：${toErrorMessage(err)}`);
      }

      const asBase64 = encoding === 'base64' || (encoding === 'auto' && looksBinary(buf));
      const end = offset + readLen;
      const header = `blob ${relPath ?? blobId ?? ''} · ${formatBytes(size)} · 本次 ${offset}-${end} 字节${end < size ? '（还有后续）' : '（已到末尾）'}`;
      const bodyText = asBase64
        ? buf.toString('base64')
        : decodeText(buf).text;
      const footer = end < size ? `\n[续读：offset=${end}&limit=${limit}]` : '';
      return ok(`${header}\n${asBase64 ? '[base64]\n' : ''}${bodyText}${footer}`);
    },
  };
}
