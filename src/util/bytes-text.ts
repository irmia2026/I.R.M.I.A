/**
 * Irmia Agent — 字节 ↔ 文本的**唯一判据**
 *
 * 中文 Windows 上"工具回执乱码"有且只有一个根因：某处把一段**不是 UTF-8 的字节**
 * 按 UTF-8 解成了 U+FFFD（替换字符）。替换发生在解码那一刻，原始字节随即消失，
 * 之后无论怎么补救都拿不回来（实测证据：`data/events/**` 里 15,149 个 U+FFFD，
 * 归属 pwsh 14,759 / safe_read 4 / rg_search 4；最早 2026-09-30、最晚 2026-10-17）。
 *
 * 所以全仓只留一条解码链、一个写侧出口、一个"为了子进程能写 UTF-8"的环境构造点：
 *
 *   读（{@link decodeText}）：BOM 定案 → **严格** UTF-8 → **严格** GB18030 → latin1 兜底并计数
 *   写（{@link utf8Bytes}）：一律 UTF-8、**永不写 BOM**
 *   子进程（{@link utf8ConsoleEnv} / {@link POWERSHELL_UTF8_HEADER}）：控制台/管道两侧都逼成 UTF-8
 *
 * **绝不静默产出 U+FFFD**：任何一次解码都带回 `replaced` / `lossy`，调用方必须能把
 * 「这份内容是按 X 解的、有 N 处无法映射」如实写进回执（见 {@link describeDecoding}）。
 * 宁可说出来，不许装作没事。
 *
 * 编码判定**不做统计猜测**（那是"看起来对、偶尔错"的来源），只做可验证判定：
 * 严格模式的 `TextDecoder` 要么给出确定文本、要么抛错，没有中间态。
 */

/** `gbk` 是 WHATWG 里 `gb18030` 解码器的别名（同一张 ICU 表），这里统一报 `gb18030` 这个更全的名字 */
export type TextEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'gb18030' | 'latin1';

export interface DecodedText {
  /** 解出来的文本（latin1 兜底时是单字节映射，字节一一对应、可反向还原） */
  text: string;
  encoding: TextEncoding;
  /**
   * **无法映射的字符数**（0 = 字节到字符一一对应）。
   *
   * 前四档（UTF-8/UTF-16/GB18030 严格解码成功）恒为 0；
   * latin1 兜底时它计的是"非 ASCII 字节数"——那些字节的原始字符**无法确定**，
   * 单字节映射只是保住了字节，不是认出了字符。
   */
  replaced: number;
  /** `replaced > 0`：这份文本不是原字节的忠实还原，回执里必须说出来 */
  lossy: boolean;
  /** 判定链的人话（为什么最后落在这一档），给回执/日志用 */
  notes: string[];
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

function toBuffer(input: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

function hasPrefix(buf: Buffer, prefix: Buffer): boolean {
  return buf.length >= prefix.length && buf.subarray(0, prefix.length).equals(prefix);
}

/** 严格解码探针：编码不支持或字节非法都返回 null，**绝不抛** */
function tryStrictDecode(buf: Buffer, label: string): string | null {
  try {
    return new TextDecoder(label, { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** 数一段文本里的替换字符（非严格解码之后唯一的诚实读数） */
export function countReplacementChars(text: string): number {
  let n = 0;
  for (const ch of text) if (ch === '\uFFFD') n += 1;
  return n;
}

/** 非 ASCII 字节数：latin1 兜底时"无法确定原字符"的字节计数 */
function countNonAsciiBytes(buf: Buffer): number {
  let n = 0;
  for (const byte of buf) if (byte >= 0x80) n += 1;
  return n;
}

/**
 * 字节 → 文本。**全仓唯一入口**。
 *
 * 顺序固定（换顺序等于换语义，别改）：
 *   1. BOM 定案：UTF-8 / UTF-16LE / UTF-16BE —— BOM 是确定事实，不是推断；
 *   2. 严格 UTF-8 —— 能过就是 UTF-8。**这条必须在前**：UTF-8 中文的字节
 *      有很大概率也是合法 GBK，反过来判会让所有 UTF-8 文件变成乱码（最危险的回归）；
 *   3. 严格 GB18030 —— 中文 Windows 文本文件的高频来源，比 GBK 更全（四字节区）；
 *   4. latin1 单字节映射兜底 —— **永不抛、永不产出 U+FFFD**，并如实报"有 N 处无法映射"。
 */
export function decodeText(input: Buffer | Uint8Array): DecodedText {
  const buf = toBuffer(input);

  if (hasPrefix(buf, UTF8_BOM)) {
    const body = buf.subarray(UTF8_BOM.length);
    const strict = tryStrictDecode(body, 'utf-8');
    if (strict !== null) {
      return { text: strict, encoding: 'utf8-bom', replaced: 0, lossy: false, notes: ['文件带 UTF-8 BOM'] };
    }
    // BOM 说是 UTF-8 但内容有非法字节：不改成别的编码（BOM 是更强的证据），只如实报损
    const lenient = body.toString('utf8');
    const replaced = countReplacementChars(lenient);
    return {
      text: lenient,
      encoding: 'utf8-bom',
      replaced,
      lossy: replaced > 0,
      notes: ['文件带 UTF-8 BOM', `BOM 之后有 ${replaced} 处字节不是合法 UTF-8`],
    };
  }

  if (hasPrefix(buf, UTF16LE_BOM)) {
    const body = buf.subarray(UTF16LE_BOM.length, buf.length - ((buf.length - UTF16LE_BOM.length) % 2));
    const text = body.toString('utf16le');
    const replaced = countReplacementChars(text);
    return {
      text,
      encoding: 'utf16le',
      replaced,
      lossy: replaced > 0,
      notes: replaced > 0 ? [`UTF-16LE 里有 ${replaced} 个孤立代理项`] : ['文件带 UTF-16LE BOM'],
    };
  }

  if (hasPrefix(buf, UTF16BE_BOM)) {
    // Node 没有 utf16be，按字节对交换后借 utf16le 解；奇数长度丢末字节（半个码元不成字）
    const body = buf.subarray(UTF16BE_BOM.length, buf.length - ((buf.length - UTF16BE_BOM.length) % 2));
    const swapped = Buffer.from(body);
    swapped.swap16();
    const text = swapped.toString('utf16le');
    const replaced = countReplacementChars(text);
    return {
      text,
      encoding: 'utf16be',
      replaced,
      lossy: replaced > 0,
      notes: replaced > 0 ? [`UTF-16BE 里有 ${replaced} 个孤立代理项`] : ['文件带 UTF-16BE BOM'],
    };
  }

  const utf8 = tryStrictDecode(buf, 'utf-8');
  if (utf8 !== null) {
    return { text: utf8, encoding: 'utf8', replaced: 0, lossy: false, notes: [] };
  }

  const notes: string[] = ['严格 UTF-8 解码失败'];
  const gb = tryStrictDecode(buf, 'gb18030');
  if (gb !== null) {
    return {
      text: gb,
      encoding: 'gb18030',
      replaced: 0,
      lossy: false,
      notes: [...notes, '按 GB18030（含 GBK/CP936）严格解码成功：原文件不是 UTF-8'],
    };
  }

  const unmapped = countNonAsciiBytes(buf);
  // latin1 是**单字节映射**：一个字节一个码位，永不失败、永不产出 U+FFFD。
  // 代价是非 ASCII 字符的"原字符"无从确定——所以要报 lossy + 无法映射的字节数。
  return {
    text: buf.toString('latin1'),
    encoding: 'latin1',
    replaced: unmapped,
    lossy: unmapped > 0,
    notes: [...notes, 'GB18030 严格解码也失败', `已退到 latin1 单字节映射：${unmapped} 个非 ASCII 字节无法确定原字符`],
  };
}

/**
 * 解码结果 → 给回执/日志的一句实话。**纯 UTF-8 返回 null**（正常路径一个字都不多说）。
 *
 * `subject` 是被解码的对象（文件名、命令名、URL），拼在句首方便对账。
 */
export function describeDecoding(decoded: DecodedText, subject?: string): string | null {
  const what = subject === undefined || subject === '' ? '这份内容' : subject;
  if (decoded.encoding === 'utf8') return null;
  const loss = decoded.lossy ? `，其中 ${decoded.replaced} 处无法映射` : '';
  switch (decoded.encoding) {
    case 'gb18030':
      return `${what}按 GB18030 解码（原字节不是 UTF-8${loss}）`;
    case 'latin1':
      return `${what}既不是 UTF-8 也不是 GB18030，已按 latin1 单字节映射解出（${decoded.replaced} 个非 ASCII 字节无法确定原字符）`;
    case 'utf8-bom':
      return decoded.lossy
        ? `${what}带 UTF-8 BOM，BOM 之后有 ${decoded.replaced} 处字节不是合法 UTF-8`
        : `${what}带 UTF-8 BOM（写入时会去掉 BOM，改存无 BOM 的 UTF-8）`;
    case 'utf16le':
    case 'utf16be':
      return `${what}按 ${decoded.encoding.toUpperCase()}（带 BOM）解码${loss}`;
    default:
      return null;
  }
}

/**
 * latin1 兜底"可还原"吗——能的话调用方可以安全地做一次文本变换再写回。
 *
 * 判据：解出来的文本再按 latin1 编回字节，是否与原字节逐字节相同。
 * 不可还原的（含 U+FFFD 或超出 latin1 的字符）就别拿它做往返。
 */
export function isLatin1RoundTrippable(buf: Buffer, decoded: DecodedText): boolean {
  if (decoded.encoding !== 'latin1') return false;
  return Buffer.from(decoded.text, 'latin1').equals(buf);
}

/**
 * 流式 UTF-8 解码器：**用于协议流**（MCP 的 JSON-RPC 帧、协议端的逐行日志）。
 *
 * 为什么这些地方不做编码探测：MCP 的规范就是 UTF-8，协议端（Node 程序）也写 UTF-8。
 * 这类流的正确需求不是"猜编码"，而是**别把跨块的多字节字符切成两半**——
 * 一个 `TextDecoder(..., {stream: true})` 就够了，它在内部留住未成句的字节。
 *
 * `replaced` 仍然计数：万一某个 server 真写了非 UTF-8，调用方至少能发现"这帧里有替换字符"。
 */
export interface Utf8Stream {
  push(bytes: Buffer | Uint8Array): string;
  flush(): string;
  /** 目前为止被替换掉的字符数（0 表示这一路字节一直是合法 UTF-8） */
  readonly replaced: number;
}

export function createUtf8Stream(): Utf8Stream {
  const decoder = new TextDecoder('utf-8');
  let replaced = 0;
  const absorb = (text: string): string => {
    replaced += countReplacementChars(text);
    return text;
  };
  return {
    push(bytes: Buffer | Uint8Array): string {
      return absorb(decoder.decode(toBuffer(bytes), { stream: true }));
    },
    flush(): string {
      return absorb(decoder.decode());
    },
    get replaced(): number {
      return replaced;
    },
  };
}

/**
 * 子进程/控制台输出用：在 {@link decodeText} 之上补一档"**混编码缓冲区**"的处理。
 *
 * 为什么文件不需要这一档、而控制台需要：一个文件只有一种编码，所以严格链是对的；
 * 但一条命令的输出可能**混着两种来源**——PowerShell 自己写的 UTF-8（表格/ANSI）与
 * 子进程按控制台代码页写的 GBK（`C:\Users\<中文名>` 这种）。这时严格 UTF-8 会失败，
 * 严格 GB18030 也可能失败，直接掉到 latin1 就把本该能读的中文全变成单字节映射。
 *
 * 判据是 **"谁留下的无法映射字符更少"**（不是猜内容）：三种解读各算一个数——
 * UTF-8 的替换字符数、GB18030 的替换字符数、latin1 的非 ASCII 字节数——取最小的那个。
 * 正常路径（合法 UTF-8）一个字节都不变，因为第 1 步就返回了。
 */
export function decodeConsoleText(input: Buffer | Uint8Array): DecodedText {
  const buf = toBuffer(input);
  const strict = decodeText(buf);
  // BOM / 合法 UTF-8 / 合法 GB18030 都已在严格链里定案（replaced 必为 0）
  if (strict.encoding !== 'latin1') return strict;

  const notes = [...strict.notes];
  let best: DecodedText = strict;
  let bestCost = strict.replaced;

  const utf8 = buf.toString('utf8');
  const utf8Cost = countReplacementChars(utf8);
  if (utf8Cost < bestCost) {
    best = {
      text: utf8,
      encoding: 'utf8',
      replaced: utf8Cost,
      lossy: utf8Cost > 0,
      notes: [...notes, '严格 UTF-8 失败，但按 UTF-8 解只有少数替换字符（混编码输出）'],
    };
    bestCost = utf8Cost;
  }

  const gb = relaxedDecode(buf, 'gb18030');
  if (gb !== null) {
    const gbCost = countReplacementChars(gb);
    if (gbCost < bestCost) {
      best = {
        text: gb,
        encoding: 'gb18030',
        replaced: gbCost,
        lossy: gbCost > 0,
        notes: [...notes, '严格 GB18030 失败，但按 GB18030 解只有少数替换字符（混编码输出）'],
      };
    }
  }
  return best;
}

/** 非严格解码：编码不支持时返回 null，字节非法则换成替换字符（配合计数使用） */
function relaxedDecode(buf: Buffer, label: string): string | null {
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return null;
  }
}

// ──────────────────────────────── 写侧 ────────────────────────────────

/**
 * 文本 → 字节。**写侧唯一出口**：一律 UTF-8、**无 BOM**。
 *
 * 为什么写侧不给选择：BOM 只有一个用途（让"猜编码"的程序认出来），而我们读的一侧
 * 已经是确定判定，不需要它；反过来 BOM 会污染 `rg` 命中、JSON 解析、diff 和字节断言。
 * 原文件若是 UTF-16/UTF-8-BOM，`text-codec.encodeText` 才按原编码写回（那是"保持原样"，
 * 属于另一件事，不在这里开口子）。
 */
export function utf8Bytes(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

/** 写侧自检：这段字节是不是"UTF-8 且无 BOM"（用例与写盘前断言共用一条判据） */
export function isUtf8NoBom(buf: Buffer): boolean {
  if (hasPrefix(buf, UTF8_BOM)) return false;
  return tryStrictDecode(buf, 'utf-8') !== null;
}

// ──────────────────────────────── 子进程的控制台环境 ────────────────────────────────

/**
 * PowerShell 侧的三条设置（**唯一一处**，`tools/pwsh.ts` 的 SCRIPT_HEADER 从这里取）。
 *
 * 三条各管一段，缺一段就还有 U+FFFD（2026-10-16/10-17 实测）：
 *   · `[Console]::OutputEncoding` —— PowerShell 自己往**控制台句柄**写的那条路；
 *   · `$OutputEncoding` / `[Console]::InputEncoding` —— 与外部程序之间的**管道两侧**；
 *   · `chcp 65001` —— 控制台**代码页**本身。子进程继承的是它，不是 .NET 属性；
 *     中文 Windows 上默认 936（GBK），这就是历史回执里那一大片替换字符的来源。
 *
 * 三条都设仍然留一手：捕获层存原始字节、读数时按 {@link decodeText} 判一遍
 * ——**不猜内容，只保证字节不丢**。
 */
export const POWERSHELL_UTF8_HEADER: readonly string[] = [
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  '$OutputEncoding=[Text.Encoding]::UTF8',
  '[Console]::InputEncoding=[Text.Encoding]::UTF8',
  'chcp 65001 > $null',
];

/**
 * 非 PowerShell 子进程的"请写 UTF-8"环境（**唯一一处**，别在每条 spawn 里自己拼）。
 *
 * `PYTHONIOENCODING` / `PYTHONUTF8` 只影响 Python（这台机器上 python 的 stdout 默认走
 * 控制台代码页 936，`print("中文")` 出来的就是 GBK 字节）；对 node / rg / es 是无害的
 * 陌生变量，不会被读。
 *
 * ⚠ **这里只管"请它按 UTF-8 写"**，管不到它不听话——所以每条 spawn 的输出仍要走
 * {@link decodeText} 判一遍。声明与兜底是两道门，不是二选一。
 */
export function utf8ConsoleEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
}
