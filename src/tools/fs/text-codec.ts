/**
 * Irmia Agent — 文件系工具包：编码检测与文本处理
 *
 * **判定链本身已收口到 `src/util/bytes-text.ts`（全仓唯一解码器）**：这个文件只负责
 * 文件系工具需要的那层包装（`confidence` 口径、`looksBinary`、行处理与 glob）。
 * 判定顺序（BOM → 严格 UTF-8 → 严格 GB18030 → latin1 兜底）写在那边，不在这里重复实现
 * ——两处各写一套的结果就是"读写两侧对同一个文件给出不同编码"。
 *
 * 二进制判定独立于编码：含 NUL 字节且没有 UTF-16/32 BOM 的，一律不当作文本。
 */

import { createHash } from 'node:crypto';

import {
  decodeText as decodeBytes,
  describeDecoding,
  type TextEncoding,
} from '../../util/bytes-text.ts';

/**
 * 检测结果里的编码名。
 *
 * `gb18030` 是**检测输出**（WHATWG 里 `gbk` 就是 `gb18030` 解码器的别名，报更全的那个名字）；
 * `gbk` 保留为**输入别名**——`safe_read` 的 `encoding` 参数枚举里就是它（改那个枚举会动
 * 工具描述，属于另一件事），写入时两者等价。
 */
export type DetectedEncoding = TextEncoding | 'gbk';

export interface DecodedText {
  text: string;
  encoding: TextEncoding;
  /** BOM 命中的是确定事实；后两条是探针推断 */
  confidence: 'certain' | 'probe' | 'fallback';
  /** 探针失败链，用于给模型解释为什么可能显示成乱码 */
  notes: string[];
  /** 无法映射的字符数（0 = 字节到字符一一对应）；见 `util/bytes-text.ts` 的 DecodedText */
  replaced: number;
  /** `replaced > 0`：这份文本不是原字节的忠实还原，回执里必须说出来 */
  lossy: boolean;
}

export interface EncodeResult {
  buffer: Buffer;
  encoding: DetectedEncoding;
  /** 原编码无法表达内容时的降级说明（如 GBK 写不了某些字符） */
  notes: string[];
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

function hasPrefix(buf: Buffer, prefix: Buffer): boolean {
  return buf.length >= prefix.length && buf.subarray(0, prefix.length).equals(prefix);
}

/** 严格解码探针：编码不支持或字节非法都返回 null，绝不抛 */
function tryStrictDecode(buf: Buffer, label: string): string | null {
  try {
    return new TextDecoder(label, { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/**
 * 字节 → 文本（**委托** `src/util/bytes-text.ts`：全仓唯一解码链）。
 *
 * 这里只补两件文件系工具专有的事：
 *   · `confidence` —— BOM 是 `certain`、探针成功是 `probe`、latin1 兜底是 `fallback`；
 *   · `notes` 换成文件视角的人话（`describeDecoding`）。
 * `replaced` / `lossy` 原样透出：**回执必须能说出"按 X 解、N 处无法映射"**。
 */
export function decodeText(buf: Buffer): DecodedText {
  const decoded = decodeBytes(buf);
  const confidence: DecodedText['confidence'] =
    decoded.encoding === 'utf8-bom' || decoded.encoding === 'utf16le' || decoded.encoding === 'utf16be'
      ? 'certain'
      : decoded.encoding === 'latin1'
        ? 'fallback'
        : 'probe';
  const note = describeDecoding(decoded);
  return {
    text: decoded.text,
    encoding: decoded.encoding,
    confidence,
    notes: note === null ? decoded.notes : [...decoded.notes, note],
    replaced: decoded.replaced,
    lossy: decoded.lossy,
  };
}

/** 二进制判定：含 NUL 且无 UTF-16/32 BOM。UTF-16 文本天然含 NUL，必须先排掉 */
export function looksBinary(buf: Buffer): boolean {
  if (hasPrefix(buf, UTF16LE_BOM) || hasPrefix(buf, UTF16BE_BOM)) return false;
  const window = buf.length > 8192 ? buf.subarray(0, 8192) : buf;
  return window.includes(0);
}

/** 按 encode 参数把文本编回字节；'auto' 表示保留原始文件编码，由调用方传入回退编码 */
export function encodeText(text: string, encoding: DetectedEncoding): EncodeResult {
  switch (encoding) {
    case 'utf8-bom': {
      const body = Buffer.from(text, 'utf8');
      return { buffer: Buffer.concat([UTF8_BOM, body]), encoding, notes: [] };
    }
    case 'utf16le': {
      return {
        buffer: Buffer.concat([UTF16LE_BOM, Buffer.from(text, 'utf16le')]),
        encoding,
        notes: [],
      };
    }
    case 'utf16be': {
      const body = Buffer.from(text, 'utf16le');
      body.swap16();
      return { buffer: Buffer.concat([UTF16BE_BOM, body]), encoding, notes: [] };
    }
    case 'gbk':
    case 'gb18030': {
      // Node 的 Buffer/TextEncoder 都不支持 GBK 编码方向（只有解码方向由 ICU 提供）。
      // 与其写出一串坏字节，不如改存 UTF-8 并如实告知——这个文件之后按 UTF-8 读是一致的。
      return {
        buffer: Buffer.from(text, 'utf8'),
        encoding: 'utf8',
        notes: ['原文件是 GB18030/GBK；零依赖运行时没有 GB 系编码器，新内容改存为 UTF-8（内容无损）'],
      };
    }
    case 'latin1': {
      const probe = tryEncodeStrict(text, 'latin1');
      if (probe !== null) return { buffer: probe, encoding, notes: [] };
      return {
        buffer: Buffer.from(text, 'utf8'),
        encoding: 'utf8',
        notes: ['原文件是 latin1，但新内容超出单字节范围，已改存为 UTF-8'],
      };
    }
    default:
      return { buffer: Buffer.from(text, 'utf8'), encoding: 'utf8', notes: [] };
  }
}

function tryEncodeStrict(text: string, label: 'latin1'): Buffer | null {
  // 判据是「编解码往返一致」：latin1 丢字符时往返不等，即判为不可表达
  const encoded = Buffer.from(text, label);
  return tryStrictDecode(encoded, label) === text ? encoded : null;
}

// ──────────────────────────────── 行处理 ────────────────────────────────

export type Eol = '\n' | '\r\n' | '\r';

export interface SplitText {
  lines: string[];
  /** 文件主换行符，写回时保持一致 */
  eol: Eol;
  /** 原文是否以换行结尾（写回时保持） */
  trailingNewline: boolean;
}

export function splitLines(text: string): SplitText {
  if (text === '') return { lines: [], eol: '\n', trailingNewline: false };
  const normalized = text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
  const crlfCount = (text.match(/\r\n/gu) ?? []).length;
  const lfOnlyCount = (text.match(/(?<!\r)\n/gu) ?? []).length;
  const crOnlyCount = (text.match(/\r(?!\n)/gu) ?? []).length;
  let eol: Eol = '\n';
  if (crlfCount > 0 && crlfCount >= lfOnlyCount && crlfCount >= crOnlyCount) eol = '\r\n';
  else if (crOnlyCount > lfOnlyCount && crOnlyCount > crlfCount) eol = '\r';

  const trailingNewline = normalized.endsWith('\n');
  const body = trailingNewline ? normalized.slice(0, -1) : normalized;
  return { lines: body.split('\n'), eol, trailingNewline };
}

export function joinLines(lines: readonly string[], eol: Eol, trailingNewline: boolean): string {
  const body = lines.join(eol);
  return trailingNewline && lines.length > 0 ? body + eol : body;
}

/** 行号前缀宽度（右对齐）。与 safe_edit 的剥除正则共用同一个数 */
export const LINE_NUMBER_WIDTH = 4;

/**
 * 行号前缀：右对齐宽度 4 + `│` + 空格，例如 `  12│ const x = 1;`。
 *
 * 宽度写死 4（而不是按最大行号动态对齐）是**契约**，不是排版偏好：safe_edit 的防呆
 * 剥除要按同一个形状认前缀（模型从 safe_read 抄行号时一定会把前缀抄进 old 里），
 * 两边用同一个固定宽度，剥除规则才不需要"猜宽度"。devkit v2.6.4 用 6，我们统一到 4。
 *
 * 行号是**文件真实行号**（startLineNo 由调用方按切片起点给），不是切片内的相对号——
 * tail / offset 场景里相对号会让模型按错行去 insert_at_line / delete_lines。
 */
export function withLineNumbers(lines: readonly string[], startLineNo: number): string[] {
  if (lines.length === 0) return [];
  return lines.map((line, index) => `${String(startLineNo + index).padStart(LINE_NUMBER_WIDTH, ' ')}│ ${line}`);
}

/** 命中位置的行列（两者都是 1-based），列按 UTF-16 码元计——与编辑器显示一致 */
export interface TextPosition {
  line: number;
  column: number;
}

export function positionAt(text: string, index: number): TextPosition {
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < index && i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10) {
      line += 1;
      lastBreak = i;
    } else if (ch === 13) {
      line += 1;
      lastBreak = i;
      if (text.charCodeAt(i + 1) === 10) i += 1;
    }
  }
  return { line, column: index - lastBreak };
}

/** 一行的预览：去掉行首空白、截断到 limit 字符，便于模型在结果里直接读懂 */
export function previewLine(line: string, limit = 160): string {
  const trimmed = line.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

// ──────────────────────────────── glob ────────────────────────────────

/**
 * glob → 正则。支持 `**` `*` `?` `{a,b}` 与字符类 `[abc]`，
 * 路径分隔符统一成 `/` 后匹配。零依赖下刻意不实现完整 minimatch。
 */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.replaceAll('\\', '/');
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` 吃掉整段目录（含零段），`**` 单独出现时跨分隔符
        if (pattern[i + 2] === '/') {
          out += '(?:[^/]*/)*';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '{') {
      const close = pattern.indexOf('}', i);
      if (close !== -1) {
        const alternatives = pattern
          .slice(i + 1, close)
          .split(',')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
        out += `(?:${alternatives.join('|')})`;
        i = close + 1;
        continue;
      }
    }
    if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close !== -1) {
        const body = pattern.slice(i + 1, close).replaceAll('\\', '\\\\');
        out += `[${body}]`;
        i = close + 1;
        continue;
      }
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    i += 1;
  }
  return new RegExp(`^${out}$`, 'u');
}

/** glob 是否要匹配整个 relativize 后的路径（含分隔符） */
export function matchesGlob(glob: RegExp, relPath: string, baseName: string, patternHasSlash: boolean): boolean {
  if (glob.test(relPath)) return true;
  if (!patternHasSlash && glob.test(baseName)) return true;
  return false;
}

// ──────────────────────────────── 其他 ────────────────────────────────

export function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 时间戳：`2026-09-29T12-30-45-123Z`，字典序即时间序，可直接做备份保留排序 */
export function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/gu, '-');
}
