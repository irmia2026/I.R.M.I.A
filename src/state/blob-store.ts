/**
 * Irmia Agent — 大结果 blob 存储（docs/schema.md §4 / §11、docs/design.md §4.12）
 *
 * `data/blobs/<sha256>` 是**内容寻址**的大工具结果外置区，三条性质：
 *   1. **天然去重**：文件名即内容哈希，同一内容永远只落一份；
 *   2. **不可变**：同名必然同内容，命中已有文件即跳过，永不原地改写；
 *   3. **不可删**：它是 `events/` 之外唯一无法从日志重建的数据（operations.md §4），
 *      备份面 = `events/` + `blobs/` + `persona/` + `config.toml`。
 *
 * 阈值口径（schema §4 的字段注释）：估算 token 超阈值才外置，事件的 `content` 只留头部预览，
 * 全文靠 `contentRef.blobId` 取回（模型侧**直接用 `safe_read` 读 `data/blobs/<blobId>`**：v64 删掉 `read_blob` 之后那条路只此一条，见 tools/fs/read-tools.ts）。
 * token 估算与 `tools/registry.ts` **同一份实现**（2026-10-06 收口）：以前这里另有一份
 * "ASCII 4 字符/token + 非 ASCII 1 字符/token"的启发式，而交接笔记与工具描述预算用的是
 * 中文 1.5 字/token 那份——同一个结果在两条路上量出两个"多少 token"，判据迟早分岔。
 *
 * **单条上限（2026-10-06 加）**：{@link DEFAULT_BLOB_THRESHOLD_TOKENS} 与
 * {@link DEFAULT_BLOB_MAX_BYTES} 一起构成"一条回执最多进多少上下文"的硬上限，超出即外置
 * （落盘 + 头部预览 + `contentRef` 指针）。**只在这个时刻定形一次**：事件一旦写下，
 * 后续任何维护都不再回来把它剪短——先例是 reasonix 的 `truncateToolOutput`：
 * "The bounded form is stable for the message lifetime and is never re-truncated by later
 * maintenance."。"扫历史、发现超限、再剪一次"那条路**本仓没有，也不许有**：那会让可见前缀
 * 每轮都变，缓存永远命不中（那正是 reasonix 1.x `tool_result_snip_ratio` 的历史事故，
 * 他们 2.x 把整条路删掉了："Removing mid-session prune/snip reduces unintended cache breaks"）。
 *
 * 零外部依赖：只用 node: 标准库（token 估算也是零依赖的字符权重启发式）。
 */

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { estimateTokens } from '../tools/registry.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** blob 根目录名（唯一定义点：写入端与 `safe_read` 的读法都从这里认这个目录名） */
export const BLOB_DIR_NAME = 'blobs';
/** blobId 形状：sha256 的小写十六进制。写入端与读取端共用同一条判据 */
export const BLOB_ID_PATTERN = /^[0-9a-f]{64}$/u;
/**
 * 默认外置阈值：估算 21k token。
 *
 * 21k 这个数的来处（2026-10-06，用户核定）：AstrBot 的单条回执上限是 27,500 estimated token
 * （相对 128K 窗口约 21%），而我们的现场阈值是 100K ⇒ 同比例约 21,000。**只抄结构、不照搬
 * 数字**那一条照办：按我们自己的窗口定。
 *
 * **已知偏差，必须说清**：`estimateTokens` 系统性**低估 1.5~1.7×**（英文约 4 字符/token
 * 基本准，中文按 1.5 字/token 折算、实测偏低）。所以"估算 21k"对应的**真实**可见量大约在
 * 21k（纯 ASCII）~ 32k（纯中文）之间。要压到"真实 21k"就得把估算门槛定在 13k 上下，
 * 但那样纯 ASCII 的长输出（日志、diff —— 最该原样看见的那一类）会被砍掉一半。取舍是
 * **按估算值 21k 定，接受真实量最高约 32k（窗口的 32%）**，并用下面那条字节上限兜住中文的极端情形。
 */
export const DEFAULT_BLOB_THRESHOLD_TOKENS = 21_000;
/**
 * 默认字节上限：64 KiB。
 *
 * 为什么除了 token 上限还要一条字节上限：`estimateTokens` 对中文的低估倍数最大，于是
 * "估算 21k"的纯中文能到约 3.1 万字符 = 约 9.4 万字节。按码点取前 64 KiB，给中文那条路
 * 钉一个看得见的界。两者**取小**：谁先到就按谁定形（判据在 {@link offloadIfLarge}）。
 */
export const DEFAULT_BLOB_MAX_BYTES = 64 * 1024;
/** 默认头部预览长度：2000 字符 */
export const DEFAULT_BLOB_PREVIEW_CHARS = 2000;

// ──────────────────────────────── 对外类型 ────────────────────────────────

export interface BlobWriteResult {
  /** 内容哈希（64 位小写十六进制），即 data/blobs/ 下的文件名 */
  blobId: string;
  /** 内容字节数（UTF-8）。它是 `contentRef.bytes` 的来源，与字符数不是一回事 */
  bytes: number;
  /** true = 命中已有文件，本次没有写盘（去重生效） */
  deduped: boolean;
}

/**
 * 大结果外置选项。`agent-loop` 的 `blobOffload` 直接用它，三个上限都可覆盖：
 * 测试要低成本构造"超大结果"，生产要按模型上下文窗口调。
 */
export interface BlobOffloadOptions {
  /** 数据根目录：blob 落在 <dataDir>/blobs/ */
  dataDir: string;
  /** 外置阈值（估算 token），默认 {@link DEFAULT_BLOB_THRESHOLD_TOKENS} */
  thresholdTokens?: number;
  /** 字节上限（UTF-8），默认 {@link DEFAULT_BLOB_MAX_BYTES}；与 token 阈值**取小** */
  maxBytes?: number;
  /** 头部预览字符数，默认 {@link DEFAULT_BLOB_PREVIEW_CHARS} */
  previewChars?: number;
}

/** 外置结果：`contentRef` 存在即表示"事件的 content 只是预览" */
export interface BlobOffloadOutcome {
  content: string;
  contentRef?: { blobId: string; bytes: number };
}

/** 测试与宿主注入点：默认全部走 node: 标准库的真实实现 */
export interface BlobStoreDeps {
  mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
  /** 目标不存在返回 null（外置路径的正常分支，不是异常） */
  statOrNull(path: string): Promise<{ size: number } | null>;
  /** 以 wx 排他创建 tmp 并写入；绝不覆盖任何已有文件 */
  createExclusive(path: string, data: Buffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
  readFile(path: string): Promise<Buffer>;
}

// ──────────────────────────────── 默认依赖 ────────────────────────────────

function hasCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const defaultDeps: BlobStoreDeps = {
  mkdir: async (path, options) => mkdir(path, options),
  statOrNull: async (path) => {
    try {
      const info = await stat(path);
      return { size: info.size };
    } catch (err) {
      if (hasCode(err, 'ENOENT')) return null;
      throw err;
    }
  },
  createExclusive: async (path, data) => {
    const handle = await open(path, 'wx');
    try {
      await handle.writeFile(data);
      // 先让数据落盘再 rename：否则存在「名字已就位、内容仍在页缓存」的窗口
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename: async (from, to) => {
    await rename(from, to);
  },
  rm: async (path, options) => {
    await rm(path, { force: options?.force ?? false });
  },
  readFile: (path) => readFile(path),
};

/** tmp 文件名的进程内唯一序号：同进程并发写不会互相踩到对方的 tmp */
let tmpSeq = 0;

// ──────────────────────────────── 阈值判定 ────────────────────────────────

/**
 * token 估算：**转发** `tools/registry.ts` 那一份（中文约 1.5 字/token、英文约 4 字符/token）。
 *
 * 为什么不再自己写一份（2026-10-06 收口）：这里原来是"ASCII 4 字符/token + 非 ASCII
 * 1 字符/token"的另一套口径，于是同一个工具结果在"要不要外置"这条路上是按 A 量的、
 * 在交接笔记预算与工具描述预算那两条路上是按 B 量的。两套口径不会报错，只会让
 * "这条结果算不算大"在两个地方有两个答案。
 *
 * 保留这个名字继续导出：它是本模块对外的既有接口（测试与调用点按它 import）。
 */
export { estimateTokens };

/**
 * 按**字节**预算取最长前缀（码点粒度，不切断代理对）。
 *
 * 为什么按码点而不是 `slice`：UTF-8 字节边界与 UTF-16 码元边界不重合，`String.slice`
 * 会切出半个代理对（emoji 变问号）；按码点累加则天然对齐。
 */
function takeBytes(text: string, budgetBytes: number): string {
  if (budgetBytes <= 0) return '';
  let bytes = 0;
  let out = '';
  for (const ch of text) {
    const cost = Buffer.byteLength(ch, 'utf8');
    if (bytes + cost > budgetBytes) break;
    bytes += cost;
    out += ch;
  }
  return out;
}

// ──────────────────────────────── 路径与哈希 ────────────────────────────────

/** blob 根目录：<dataDir>/blobs */
export function blobDirOf(dataDir: string): string {
  return join(dataDir, BLOB_DIR_NAME);
}

/** 内容的 sha256 十六进制（blobId 的唯一计算点） */
export function blobIdOf(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** blob 的绝对路径。blobId 必须已校验（见 BLOB_ID_PATTERN） */
export function blobPathOf(dataDir: string, blobId: string): string {
  return join(blobDirOf(dataDir), blobId);
}

// ──────────────────────────────── 写入 ────────────────────────────────

/**
 * 内容寻址写。返回 `{ blobId, bytes, deduped }`：
 *   - 目标已存在 → `deduped: true`，一个字节都不写（这就是"天然去重"）；
 *   - 不存在 → 写 `blobs/<blobId>.tmp.<pid>.<n>` 再 rename 到最终名字：
 *     内容哈希做文件名，rename 到已存在目标只会覆盖成本内容相同的文件，永远安全。
 *
 * `bytes` 恒为传入内容的 UTF-8 字节数（不取盘上文件大小）：若盘上同名文件被外部改写，
 * 那是 doctor 的完整性检查该报的事（operations.md §6），这里不修补、不静默采信坏内容。
 * 写盘失败**会抛出**：外置失败必须让调用方看见，否则全文就丢了。
 */
export async function writeBlob(
  dataDir: string,
  content: string | Buffer,
  deps: Partial<BlobStoreDeps> = {},
): Promise<BlobWriteResult> {
  const d: BlobStoreDeps = { ...defaultDeps, ...deps };
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const blobId = blobIdOf(buf);
  const bytes = buf.byteLength;
  const dir = blobDirOf(dataDir);
  const path = join(dir, blobId);

  await d.mkdir(dir, { recursive: true });

  const existing = await d.statOrNull(path);
  if (existing !== null) return { blobId, bytes, deduped: true };

  tmpSeq += 1;
  const tmp = `${path}.tmp.${process.pid}.${tmpSeq}`;
  try {
    await d.createExclusive(tmp, buf);
    await d.rename(tmp, path);
  } catch (err) {
    try {
      await d.rm(tmp, { force: true });
    } catch {
      /* tmp 清理失败不留痕：下一次写入用新名字重建 */
    }
    throw new Error(`写入 blob ${path} 失败：${toErrorMessage(err)}`);
  }
  return { blobId, bytes, deduped: false };
}

// ──────────────────────────────── 读取 ────────────────────────────────

/**
 * 按 blobId 读全文。模型侧读全文走 `read_blob` 工具（带分页与白名单），
 * 这里给的是库内路径：doctor 的引用完整性检查、测试断言、复盘脚本用。
 */
export async function readBlob(
  dataDir: string,
  blobId: string,
  deps: Partial<Pick<BlobStoreDeps, 'readFile'>> = {},
): Promise<Buffer> {
  if (!BLOB_ID_PATTERN.test(blobId)) {
    throw new Error(`blobId 必须是 64 位小写十六进制 sha256，收到 ${blobId}`);
  }
  const d = { readFile: deps.readFile ?? defaultDeps.readFile };
  const path = blobPathOf(dataDir, blobId);
  try {
    return await d.readFile(path);
  } catch (err) {
    if (hasCode(err, 'ENOENT')) {
      throw new Error(`blob 不存在：${path}（blobs/ 是不可删目录，缺失说明它被删或被换过机器）`);
    }
    throw new Error(`读取 blob ${path} 失败：${toErrorMessage(err)}`);
  }
}

// ──────────────────────────────── 外置判定 ────────────────────────────────

/**
 * 超上限则外置：写 blob（先落盘，再返回预览）。**调用方必须先把事件写完再继续**——
 * `tool/result` 事件里只有预览，blob 没落盘就写事件等于丢全文。
 *
 * **两个上限取小**：估算 token 超过 `thresholdTokens`，**或** UTF-8 字节超过 `maxBytes`，
 * 任一命中就外置（中文的低估倍数最大，字节上限是给它钉的那条界）。
 *
 * 返回的 `content` 是纯粹的头部切片（不加省略号装饰）：补"去哪里取全文"的提示是
 * 渲染层的事（model/render.ts 会在预览后追加 `[完整结果 N 字节，可用 read_blob 取：id]`），
 * 两处都加就会出现重复提示。
 *
 * **纯函数**：同一个 `content` + 同一组上限，任何时刻得到同一份可见字节与同一个 `blobId`
 * （内容寻址）——重放逐字节重建靠的就是这一条。落盘失败**会抛出**：外置失败必须让调用方
 * 看见，不能悄悄退化成"只剩预览"（那就是丢全文）。
 */
export async function offloadIfLarge(
  content: string,
  options: BlobOffloadOptions,
  deps: Partial<BlobStoreDeps> = {},
): Promise<BlobOffloadOutcome> {
  const threshold = Math.max(0, options.thresholdTokens ?? DEFAULT_BLOB_THRESHOLD_TOKENS);
  const maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_BLOB_MAX_BYTES);
  const overTokens = estimateTokens(content) > threshold;
  const overBytes = Buffer.byteLength(content, 'utf8') > maxBytes;
  if (!overTokens && !overBytes) return { content };

  const written = await writeBlob(options.dataDir, content, deps);
  const previewChars = Math.max(0, Math.trunc(options.previewChars ?? DEFAULT_BLOB_PREVIEW_CHARS));
  // 预览同时受 `previewChars`（字符）与 `maxBytes` 管：字节上限比预览长度还小时按字节切
  const byChars = [...content].slice(0, previewChars).join('');
  const preview = takeBytes(byChars, maxBytes);
  return {
    content: preview,
    contentRef: { blobId: written.blobId, bytes: written.bytes },
  };
}
