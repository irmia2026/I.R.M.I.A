/**
 * Irmia Agent — 编码边界测试（用户反馈："工具使用经常会有编码问题，能不能妥善全部处理？"）
 *
 * 这份文件钉的是**全仓那条唯一的字节→文本判据**（`src/util/bytes-text.ts`）以及
 * 每一个会碰到字节的边界。历史证据：`data/events/**` 里有 15,149 个 U+FFFD，
 * 归属 pwsh 14,759 / safe_read 4 / rg_search 4，最早 2026-09-30、最晚 2026-10-17
 * ——**只修 pwsh 是不够的**，别的边界还在漏。
 *
 * 约定：
 *   · 一律用**字节夹具**（`Buffer.from([0xd6,0xd0,...])`），不用字符串——字符串进不了
 *     "这份字节是不是 UTF-8"这个问题；
 *   · 正反两面都测：**解对了**与**绝不静默产出替换字符**各有用例；
 *   · 真跑的子进程用例（pwsh / hooks / 隔离任务）是**确定性命令**：子进程按 CP936
 *     直写字节，不依赖这台机器的控制台代码页是什么；
 *   · 值导入写 `.ts`（Node 的 --experimental-strip-types 只擦类型、不改写路径解析）。
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  countReplacementChars,
  createUtf8Stream,
  decodeConsoleText,
  decodeText,
  describeDecoding,
  isUtf8NoBom,
  utf8Bytes,
  utf8ConsoleEnv,
  POWERSHELL_UTF8_HEADER,
} from '../src/util/bytes-text.ts';
import { createPwshTool, type PwshToolDefinition } from '../src/tools/pwsh.ts';
import { defaultHookSpawner } from '../src/hook/hooks.ts';
import { defaultIsolatedSpawner } from '../src/tools/executor.ts';
import { createEnv, fsTools, runProcessDefault } from '../src/tools/fs/index.ts';
import type { ToolContext, ToolDefinition } from '../src/tools/types.ts';
import { tempDir } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 字节夹具 ────────────────────────────────

/** `中文` 的 GBK（cp936）字节 */
const GBK_ZHONGWEN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
/** `中文` 的 UTF-8 字节——**它同时是合法 GB18030**，是"最危险回归"的那个夹具 */
const UTF8_ZHONGWEN = Buffer.from([0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87]);
/**
 * 既不是合法 UTF-8、也不是合法 GB18030 的字节。
 *
 * ⚠ 开头**绝不能是 `ff fe` / `fe ff` / `ef bb bf`**——那三个是 BOM，命中 BOM 就定案了，
 * 这份夹具也就测不到"两档严格解码都失败"那条路（第一版就栽在这：`ff fe` 被当成 UTF-16LE，
 * 断言直接把这件事抓出来了）。
 */
const ILLEGAL_BYTES = Buffer.from([0xff, 0xff, 0x81, 0x30, 0xff, 0x0a]);

function utf16leBom(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

function utf16beBom(text: string): Buffer {
  const body = Buffer.from(text, 'utf16le');
  body.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
}

// ──────────────────────────────── 测试脚手架 ────────────────────────────────

let root = '';

before(async () => {
  root = await tempDir('irmia-enc-');
});

after(async () => {
  await removeTree(root);
});

async function removeTree(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
}

async function workspace(name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeCtx(workspaceRoot: string): ToolContext {
  return {
    callId: 'call_enc_test',
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    workspaceRoot,
  };
}

/** fs 包的最小装配：不注入探测结论 ⇒ 搜索工具按本机实际情况决定是否注册 */
async function fsToolTable(workspaceRoot: string): Promise<Map<string, ToolDefinition>> {
  const table = new Map<string, ToolDefinition>();
  const backupDir = join(workspaceRoot, '.backups');
  await fsTools(
    { register: (tool) => table.set(tool.name, tool) },
    { backupDir },
    { now: () => new Date('2026-02-01T00:00:00.000Z') },
  );
  return table;
}

/** 取工具（没注册就直接失败，别让用例静默跳过） */
function toolOf(table: Map<string, ToolDefinition>, name: string): ToolDefinition {
  const tool = table.get(name);
  assert.ok(tool !== undefined, `${name} 应当注册`);
  return tool;
}

function textOf(result: { content?: unknown; data?: unknown }): string {
  const content = (result as { content?: unknown }).content;
  return typeof content === 'string' ? content : JSON.stringify((result as { data?: unknown }).data ?? {});
}

/**
 * 一条**确定性**地按 CP936 写字节的 PowerShell 命令。
 *
 * 为什么不用 `cmd /c chcp 936 & echo 中文`：实测（`_tmp/probe-bytes.mts`）那条路在这台机器上
 * 写出来的仍是 UTF-8（`chcp` 改了控制台代码页，但 cmd 从 Unicode 命令行转字节时没跟着变），
 * 于是它**测不出**"孩子写了 GBK"这件事。直写 `[Text.Encoding]::GetEncoding(936)` 的字节
 * 才是不受环境影响的那份夹具——它模拟的正是"独立进程按自己的控制台代码页写回来"。
 */
function gbkWritingPwshCommand(text: string): string {
  const bytes = Buffer.from(new TextEncoder().encode(text)); // 不用它编码，只用长度打印做对照
  void bytes;
  return `$b=[Text.Encoding]::GetEncoding(936).GetBytes('${text}');`
    + '$s=[Console]::OpenStandardOutput();$s.Write($b,0,$b.Length);$s.Flush()';
}

// ════════════════════════════════ ① 共享解码器 ════════════════════════════════

describe('共享解码器 decodeText：全仓唯一判据', () => {
  it('GBK 字节（中文 = d6 d0 ce c4）⇒ 解对、encoding=gb18030、replaced=0、lossy=false', () => {
    const decoded = decodeText(GBK_ZHONGWEN);
    assert.equal(decoded.text, '中文');
    // 报 `gb18030` 而不是 `gbk`：WHATWG 里两者是同一张解码表（实测
    // `TextDecoder('gbk')` 与 `TextDecoder('gb18030')` 输出逐字相同），gb18030 是更全的名字
    assert.equal(decoded.encoding, 'gb18030');
    assert.equal(decoded.replaced, 0);
    assert.equal(decoded.lossy, false, '严格解码成功就没有任何损失');
  });

  it('UTF-16LE 带 BOM ⇒ 解对（BOM 是确定事实，不是推断）', () => {
    const decoded = decodeText(utf16leBom('宽字符内容'));
    assert.equal(decoded.text, '宽字符内容');
    assert.equal(decoded.encoding, 'utf16le');
    assert.equal(decoded.lossy, false);
  });

  it('UTF-16BE 带 BOM ⇒ 解对（字节对交换后按 utf16le 解）', () => {
    const decoded = decodeText(utf16beBom('宽字符内容'));
    assert.equal(decoded.text, '宽字符内容');
    assert.equal(decoded.encoding, 'utf16be');
    assert.equal(decoded.lossy, false);
  });

  it('UTF-8 内容**绝不许被误判成 GB18030**（最危险的回归）', () => {
    // e4 b8 ad e6 96 87 同时是合法 GB18030（会解成"涓枃"一类的乱码）
    // ⇒ 严格链里 UTF-8 必须先判。这条红了就是全仓每个 UTF-8 文件变乱码。
    const decoded = decodeText(UTF8_ZHONGWEN);
    assert.equal(decoded.text, '中文');
    assert.equal(decoded.encoding, 'utf8');

    const mixed = decodeText(Buffer.from('中文内容，测试 123 abc', 'utf8'));
    assert.equal(mixed.encoding, 'utf8');
    assert.equal(mixed.text, '中文内容，测试 123 abc');
    assert.equal(describeDecoding(mixed), null, '纯 UTF-8 时不该多说一个字');
  });

  it('非法字节 ⇒ 不崩、lossy=true、报得出无法映射的数量，且**产出里没有 U+FFFD**', () => {
    const decoded = decodeText(ILLEGAL_BYTES);
    assert.equal(decoded.encoding, 'latin1', '两档严格解码都失败时落 latin1 单字节映射');
    assert.equal(decoded.lossy, true);
    assert.ok(decoded.replaced > 0, `replaced 应报出无法映射的数量，实际 ${decoded.replaced}`);
    // 关键：latin1 是**单字节映射**，字节一一对应保住了，绝不产出替换字符
    assert.equal(countReplacementChars(decoded.text), 0);
    assert.equal(Buffer.from(decoded.text, 'latin1').toString('hex'), ILLEGAL_BYTES.toString('hex'),
      'latin1 兜底必须可逆：解出来的文本按 latin1 编回字节要与原字节逐字节相同');
  });

  it('UTF-8 BOM ⇒ 命中 utf8-bom；写侧判据 isUtf8NoBom 为假', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), UTF8_ZHONGWEN]);
    const decoded = decodeText(withBom);
    assert.equal(decoded.encoding, 'utf8-bom');
    assert.equal(decoded.text, '中文');
    assert.equal(isUtf8NoBom(withBom), false);
  });

  it('describeDecoding：非 UTF-8 必须说清"按什么解、多少处无法映射"', () => {
    const gb = describeDecoding(decodeText(GBK_ZHONGWEN));
    assert.notEqual(gb, null);
    assert.match(gb ?? '', /GB18030/u);
    assert.match(gb ?? '', /不是 UTF-8/u);

    const lossy = describeDecoding(decodeText(ILLEGAL_BYTES));
    assert.match(lossy ?? '', /latin1/u);
    assert.match(lossy ?? '', /\d+ 个非 ASCII 字节无法确定原字符/u);

    // subject 会拼进句首，便于对账"哪一个文件/哪一条命令"
    assert.match(describeDecoding(decodeText(GBK_ZHONGWEN), 'a.txt ') ?? '', /^a\.txt /u);
  });

  it('空字节串 ⇒ 空文本、utf8、无损（别在边界上抛）', () => {
    const decoded = decodeText(Buffer.alloc(0));
    assert.equal(decoded.text, '');
    assert.equal(decoded.encoding, 'utf8');
    assert.equal(decoded.lossy, false);
  });
});

describe('混编码控制台缓冲 decodeConsoleText', () => {
  it('UTF-8 表格 + GBK 子进程输出共存：取"无法映射更少"的那一档，绝不放弃可读的中文', () => {
    // 真实形状：PowerShell 自己写 UTF-8（这里用纯 ASCII 代表表格/ANSI），
    // 子进程按 CP936 写回来一段中文路径。整段严格 UTF-8 会失败。
    const mixed = Buffer.concat([
      Buffer.from('--- python ---\r\nC:\\Users\\<user>', 'utf8'),
      GBK_ZHONGWEN,
      Buffer.from('\\AppData\\Local\\npm.cmd\r\n', 'utf8'),
    ]);
    const decoded = decodeConsoleText(mixed);
    assert.equal(decoded.encoding, 'gb18030', '混编码时该选能读懂中文的那条');
    assert.match(decoded.text, /^--- python ---/u, 'ASCII 部分不得被打乱');
    assert.ok(decoded.text.includes('中文'), `中文路径必须解出来，实际 ${JSON.stringify(decoded.text)}`);
    assert.equal(decoded.lossy, false);
  });

  it('正常 UTF-8 路径一个字节都不变（这条红了就是所有回执都在被改写）', () => {
    const plain = Buffer.from('中文输出正常\r\n[exit code: 0]\r\n', 'utf8');
    const decoded = decodeConsoleText(plain);
    assert.equal(decoded.encoding, 'utf8');
    assert.equal(decoded.text, plain.toString('utf8'));
    assert.equal(decoded.lossy, false);
  });
});

describe('流式 UTF-8 解器 createUtf8Stream（协议流用）', () => {
  it('跨块的多字节字符不会被切成两个替换字符', () => {
    const bytes = Buffer.from('中文\r\n', 'utf8');
    const stream = createUtf8Stream();
    let out = '';
    // 逐字节喂进去：最坏情况的切分（每一块都只有一个字节）
    for (const byte of bytes) out += stream.push(Buffer.from([byte]));
    out += stream.flush();
    assert.equal(out, '中文\r\n');
    assert.equal(stream.replaced, 0);
  });

  it('真写了非 UTF-8 时能数出替换字符（不装作没事）', () => {
    const stream = createUtf8Stream();
    const text = stream.push(GBK_ZHONGWEN) + stream.flush();
    assert.ok(countReplacementChars(text) > 0);
    assert.equal(stream.replaced, countReplacementChars(text));
  });
});

// ════════════════════════════════ ② 子进程边界（真跑） ════════════════════════════════

describe('子进程输出解码：pwsh 真跑 CP936 字节', () => {
  let tool: PwshToolDefinition;
  let ws = '';

  before(async () => {
    ws = await workspace('pwsh');
    tool = createPwshTool({ destructiveEnabled: true, onWarning: () => undefined });
  });

  after(async () => {
    await tool.shutdown();
  });

  it('单次执行：子进程按 CP936 直写字节 ⇒ 回执中文正确，并注明按 gb18030 解码', async () => {
    const result = await tool.handler(
      { command: gbkWritingPwshCommand('中文乱码测试'), persistent: false },
      makeCtx(ws),
    );
    const content = textOf(result);
    assert.ok(content.includes('中文乱码测试'), `GBK 字节要被解成原文，实际：${JSON.stringify(content)}`);
    assert.doesNotMatch(content, /\uFFFD/u, '回执里不许出现替换字符');
    assert.match(content, /\[编码\]/u, '非 UTF-8 时必须加一句时实说');
    assert.match(content, /gb18030/u);
  });

  it('持久会话：同一条夹具在会话里也解得对（会话与单次是两条捕获路）', async () => {
    const result = await tool.handler(
      { command: gbkWritingPwshCommand('会话里也正确') },
      makeCtx(ws),
    );
    const content = textOf(result);
    assert.ok(content.includes('会话里也正确'), `实际：${JSON.stringify(content)}`);
    assert.doesNotMatch(content, /\uFFFD/u);
    assert.match(content, /\[编码\]/u);
  });

  it('lang=python：python 直写 GBK 字节 ⇒ 回执中文正确', async () => {
    // 三档（pwsh/python/node）共用同一套捕获与解码，这条钉的是 python 那一档
    const script = [
      'import sys',
      'sys.stdout.buffer.write("python中文输出".encode("gbk"))',
      'sys.stdout.buffer.flush()',
    ].join('\n');
    const result = await tool.handler({ command: script, lang: 'python' }, makeCtx(ws));
    const content = textOf(result);
    assert.ok(content.includes('python中文输出'), `实际：${JSON.stringify(content)}`);
    assert.doesNotMatch(content, /\uFFFD/u);
  });

  it('正常 UTF-8 输出不出现 [编码] 那一段（正常路径一个字都不多说）', async () => {
    const result = await tool.handler(
      { command: 'Write-Output "中文输出正常"', persistent: false },
      makeCtx(ws),
    );
    const content = textOf(result);
    assert.ok(content.includes('中文输出正常'));
    assert.doesNotMatch(content, /\[编码\]/u);
  });
});

describe('子进程输出解码：钩子与隔离任务', () => {
  it('钩子：子进程写 GBK 字节 ⇒ onStdout 拿到的是中文（不是替换字符）', async () => {
    const ws = await workspace('hook');
    const proc = defaultHookSpawner({
      // 用 node 直写原始字节：不受 shell 的代码页影响，夹具是确定的
      command: `${JSON.stringify(process.execPath)} -e "process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4]))"`,
      cwd: ws,
      env: process.env,
    });
    let out = '';
    proc.onStdout((chunk) => {
      out += chunk;
    });
    const code = await new Promise<number | null>((resolve) => {
      proc.onClose((value) => resolve(value));
      proc.endInput();
    });
    assert.equal(code, 0);
    assert.equal(out, '中文');
  });

  it('隔离任务：子进程写 GBK 字节 ⇒ onData 拿到的是中文', async () => {
    const ws = await workspace('isolated');
    const proc = defaultIsolatedSpawner({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4]))'],
      cwd: ws,
    });
    const chunks: string[] = [];
    proc.onData((chunk, stream) => {
      if (stream === 'stdout') chunks.push(chunk);
    });
    await new Promise<number | null>((resolve) => proc.onClose(resolve));
    assert.equal(chunks.join(''), '中文');
  });

  it('引擎输出（rg/es 那条路）：runProcessDefault 解对并报出编码读数', async () => {
    const ws = await workspace('engine');
    const result = await runProcessDefault(
      process.execPath,
      ['-e', 'process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4]))'],
      { timeoutMs: 10_000, cwd: ws },
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '中文');
    assert.equal(result.decode?.encoding, 'gb18030');
    assert.equal(result.decode?.lossy, false);
  });

  it('引擎输出：合法 UTF-8 时 decode.encoding 是 utf8（搜索回执不因此多一句话）', async () => {
    const ws = await workspace('engine-utf8');
    const result = await runProcessDefault(
      process.execPath,
      ['-e', 'process.stdout.write("中文")'],
      { timeoutMs: 10_000, cwd: ws },
    );
    assert.equal(result.stdout, '中文');
    assert.equal(result.decode?.encoding, 'utf8');
    assert.equal(result.decode?.lossy, false);
  });
});

// ════════════════════════════════ ③ 文件读写边界 ════════════════════════════════

describe('文件读写边界：safe_read / safe_write', () => {
  it('safe_read 读 GBK 文本文件 ⇒ 内容正确，且回执注明编码与编码说明', async () => {
    const ws = await workspace('read-gbk');
    await writeFile(join(ws, 'gbk.txt'), GBK_ZHONGWEN);
    const table = await fsToolTable(ws);
    const result = await toolOf(table, 'safe_read').handler({ path: 'gbk.txt' }, makeCtx(ws));
    const content = textOf(result);
    assert.match(content, /中文/u, `GBK 文件要读出原文，实际：${JSON.stringify(content)}`);
    assert.match(content, /gb18030/u, '回执头部必须注明实际用的编码');
    assert.match(content, /原文件不是 UTF-8/u, '编码说明要把"这不是 UTF-8"说出来');
    assert.doesNotMatch(content, /\uFFFD/u);
  });

  it('safe_read 读 UTF-8 文件 ⇒ 不误判成 GB18030（正常路径不提编码说明）', async () => {
    const ws = await workspace('read-utf8');
    await writeFile(join(ws, 'utf8.txt'), Buffer.from('中文内容正常\n', 'utf8'));
    const table = await fsToolTable(ws);
    const result = await toolOf(table, 'safe_read').handler({ path: 'utf8.txt' }, makeCtx(ws));
    const content = textOf(result);
    assert.match(content, /中文内容正常/u);
    assert.match(content, /· utf8（probe）/u, '头部报的编码必须是 utf8');
    assert.doesNotMatch(content, /编码说明/u);
  });

  it('safe_read 读非法字节文件 ⇒ 不崩、回执说清"多少处无法映射"', async () => {
    const ws = await workspace('read-illegal');
    await writeFile(join(ws, 'weird.bin.txt'), ILLEGAL_BYTES);
    const table = await fsToolTable(ws);
    const result = await toolOf(table, 'safe_read').handler({ path: 'weird.bin.txt' }, makeCtx(ws));
    const content = textOf(result);
    assert.match(content, /无法映射/u, `必须说清损失，实际：${JSON.stringify(content)}`);
    assert.match(content, /latin1/u);
    assert.doesNotMatch(content, /\uFFFD/u, '宁可用单字节映射，也不产出替换字符');
  });

  it('safe_read 读 UTF-16LE 带 BOM 文件 ⇒ 解对并注明 utf16le', async () => {
    const ws = await workspace('read-utf16');
    await writeFile(join(ws, 'u16.txt'), utf16leBom('宽字符文件'));
    const table = await fsToolTable(ws);
    const result = await toolOf(table, 'safe_read').handler({ path: 'u16.txt' }, makeCtx(ws));
    assert.match(textOf(result), /宽字符文件/u);
  });

  it('safe_write 写出去的是 **UTF-8 无 BOM**（逐字节断言）', async () => {
    const ws = await workspace('write-utf8');
    const table = await fsToolTable(ws);
    const result = await toolOf(table, 'safe_write').handler(
      { path: 'new.txt', content: '中文内容 abc' },
      makeCtx(ws),
    );
    const content = textOf(result);
    assert.equal((result as { isError?: boolean }).isError, undefined, content);
    assert.match(content, /已写入/u, content);

    const bytes = await readFile(join(ws, 'new.txt'));
    // ① 不许有 BOM
    assert.notEqual(bytes.subarray(0, 3).toString('hex'), 'efbbbf', '写侧一律无 BOM');
    // ② 必须逐字节等于 UTF-8 编码结果（不是"看起来像"，是同一份字节）
    assert.equal(bytes.toString('hex'), Buffer.from('中文内容 abc', 'utf8').toString('hex'));
    assert.equal(isUtf8NoBom(bytes), true);
  });

  it('safe_write 覆盖一个 GBK 文件 ⇒ 改存 UTF-8 并在回执里说清"，而不是写坏字节', async () => {
    const ws = await workspace('write-gbk');
    await writeFile(join(ws, 'gbk.txt'), GBK_ZHONGWEN);
    const table = await fsToolTable(ws);
    const result = await toolOf(table, 'safe_write').handler(
      { path: 'gbk.txt', content: '新的中文', overwrite: true },
      makeCtx(ws),
    );
    const content = textOf(result);
    assert.match(content, /GB18030|GBK/u, '编码降级说明必须回给模型');
    const bytes = await readFile(join(ws, 'gbk.txt'));
    assert.equal(bytes.toString('hex'), Buffer.from('新的中文', 'utf8').toString('hex'));
    assert.equal(isUtf8NoBom(bytes), true);
  });

  it('编码写侧出口 utf8Bytes：中文/emoji 都是无 BOM 的 UTF-8', () => {
    for (const text of ['中文', '😀 emoji', '']) {
      const bytes = utf8Bytes(text);
      assert.equal(isUtf8NoBom(bytes), true);
      assert.equal(decodeText(bytes).text, text);
    }
  });
});

// ════════════════════════════════ ④ 中文路径 ════════════════════════════════

describe('中文路径：safe_read 与 pwsh', () => {
  it('safe_read 能读到中文路径下的文件', async () => {
    const ws = await workspace('cjk-path');
    const dir = join(ws, '中文目录', '子目录');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '内容.txt'), Buffer.from('路径里有中文也没问题\n', 'utf8'));
    const table = await fsToolTable(ws);
    const result = await toolOf(table, 'safe_read').handler(
      { path: '中文目录/子目录/内容.txt' },
      makeCtx(ws),
    );
    assert.match(textOf(result), /路径里有中文也没问题/u);
  });

  it('pwsh 能在中文路径的工作目录里执行并读文件', async () => {
    const ws = await workspace('cjk-pwsh');
    const dir = join(ws, '中文工作目录');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '样例.txt'), Buffer.from('中文内容被读到\n', 'utf8'));
    const tool = createPwshTool({ destructiveEnabled: true, onWarning: () => undefined });
    try {
      const result = await tool.handler(
        { command: 'Get-Content -LiteralPath "样例.txt" -Raw', workdir: dir, persistent: false },
        makeCtx(ws),
      );
      const content = textOf(result);
      assert.match(content, /中文内容被读到/u, `实际：${JSON.stringify(content)}`);
    } finally {
      await tool.shutdown();
    }
  });
});

// ════════════════════════════════ ⑤ 子进程环境（一处可取） ════════════════════════════════

describe('子进程的 UTF-8 控制台环境：只有一处定义', () => {
  it('utf8ConsoleEnv 给出 python 侧的 UTF-8 变量，且不改动别的变量', () => {
    const env = utf8ConsoleEnv({ FOO: 'bar' });
    assert.equal(env['PYTHONIOENCODING'], 'utf-8');
    assert.equal(env['PYTHONUTF8'], '1');
    assert.equal(env['FOO'], 'bar');
  });

  it('PowerShell 侧那几条设置从同一处取（含 chcp 65001 与两个 Encoding 赋值）', () => {
    const joined = POWERSHELL_UTF8_HEADER.join('\n');
    assert.match(joined, /\[Console\]::OutputEncoding=\[Text\.Encoding\]::UTF8/u);
    assert.match(joined, /\[Console\]::InputEncoding=\[Text\.Encoding\]::UTF8/u);
    assert.match(joined, /\$OutputEncoding=\[Text\.Encoding\]::UTF8/u);
    assert.match(joined, /chcp 65001/u);
  });
});

// ════════════════════════════════ ⑥ HTTP 边界 ════════════════════════════════

describe('HTTP 边界：响应体解码', () => {
  it('头里没写 charset 的 GBK 页面 ⇒ 按 GB18030 解出正文，不再一片替换字符', async () => {
    const { decodeBodyWithInfo } = await import('../src/tools/net.ts');
    const info = decodeBodyWithInfo(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), 'text/html');
    assert.equal(info.text, '中文');
    assert.equal(info.encoding, 'gb18030');
    assert.equal(info.lossy, false);
  });

  it('头里写了 charset=gbk ⇒ 按站点声明解（站点声明优先于探测）', async () => {
    const { decodeBodyWithInfo } = await import('../src/tools/net.ts');
    const info = decodeBodyWithInfo(GBK_ZHONGWEN, 'text/plain; charset=gbk');
    assert.equal(info.text, '中文');
    assert.equal(info.encoding, 'gbk');
    assert.equal(info.lossy, false);
  });

  it('合法 UTF-8 页面 ⇒ 一个字都不改', async () => {
    const { decodeBodyWithInfo } = await import('../src/tools/net.ts');
    const info = decodeBodyWithInfo(UTF8_ZHONGWEN, 'text/html');
    assert.equal(info.text, '中文');
    assert.equal(info.encoding, 'utf8');
  });

  it('v79：没有响应头时读 HTML 的 <meta charset>（此前只信 header）', async () => {
    const { decodeBodyWithInfo } = await import('../src/tools/net.ts');
    // Big5 的「中文」+ 一段 `<meta charset="big5">` 外壳（声明本身是 ASCII）
    const head = Buffer.from('<html><head><meta charset="big5"></head><body>', 'latin1');
    const info = decodeBodyWithInfo(Buffer.concat([head, Buffer.from([0xa4, 0xa4, 0xa4, 0xe5])]), 'text/html');
    assert.equal(info.encoding, 'big5');
    assert.equal(info.source, 'meta', '编码名要如实标出来自 HTML 声明，而不是"判出来的"');
    assert.equal(info.lossy, false);
    assert.ok(info.text.includes('中文'));
  });

  it('v79：站点声明的编码解不出来时说真话（不谎称"谁都没声明"）', async () => {
    const { decodeBodyWithInfo } = await import('../src/tools/net.ts');
    // 头里写了一个 Node 不认识的 charset 标签 ⇒ 只能走判定链，但"声明过"这件事必须留在读数里
    const info = decodeBodyWithInfo(GBK_ZHONGWEN, 'text/html; charset=bogus-enc');
    assert.equal(info.encoding, 'gb18030');
    assert.equal(info.source, 'judged');
    assert.equal(info.declared, 'bogus-enc');
  });
});

// ════════════════════════════════ ⑧ 归档成员名 ════════════════════════════════

/**
 * 造一个最小 zip（只有一个 STORE 成员）。
 *
 * 为什么要自己拼：我们要测的正是"成员名的**原始字节**不是 UTF-8"这件事，
 * 而任何 zip 库都会替我们决定编码——那就测不到那条边界了。
 * 本仓的 `readZipEntries` 不校验 CRC，所以这里给 0 即可（结构完整、内容自洽）。
 */
function minimalZip(entryNameBytes: Buffer, payload: Buffer): Buffer {
  const crc = 0;
  const centralHeader = (nameLength: number, size: number, offset: number): Buffer => {
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); // 目录项签名
    head.writeUInt16LE(20, 4); // version made by
    head.writeUInt16LE(20, 6); // version needed
    head.writeUInt16LE(0, 8); // flags（**不置 UTF-8 位**，这正是真实形状）
    head.writeUInt16LE(0, 10); // method = STORE
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(size, 20); // compressed
    head.writeUInt32LE(size, 24); // uncompressed
    head.writeUInt16LE(nameLength, 28);
    head.writeUInt16LE(0, 30); // extra
    head.writeUInt16LE(0, 32); // comment
    head.writeUInt32LE(offset, 42);
    return head;
  };
  const localHeader = (nameLength: number, size: number): Buffer => {
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); // 本地头签名
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0, 6); // flags
    head.writeUInt16LE(0, 8); // STORE
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(size, 18);
    head.writeUInt32LE(size, 22);
    head.writeUInt16LE(nameLength, 26);
    head.writeUInt16LE(0, 28);
    return head;
  };

  const local = Buffer.concat([localHeader(entryNameBytes.length, payload.length), entryNameBytes, payload]);
  const central = Buffer.concat([centralHeader(entryNameBytes.length, payload.length, 0), entryNameBytes]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // 目录结尾签名
  eocd.writeUInt16LE(1, 8); // 本盘条目数
  eocd.writeUInt16LE(1, 10); // 总条目数
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16); // 目录起点
  eocd.writeUInt16LE(0, 20); // 注释长度
  return Buffer.concat([local, central, eocd]);
}

describe('归档成员名：zip 里的名字不一定是 UTF-8', () => {
  it('GBK 成员名 ⇒ 解成原文（不再是一片替换字符）', async () => {
    const { readZipEntries } = await import('../src/deps/install.ts');
    const zip = minimalZip(GBK_ZHONGWEN, Buffer.from('payload', 'utf8'));
    const read = readZipEntries(zip);
    assert.equal(read.ok, true, read.ok ? '' : read.error);
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0]?.name, '中文', `实际 ${JSON.stringify(read.entries[0]?.name)}`);
  });

  it('ASCII 成员名一个字都不变（正常路径）', async () => {
    const { readZipEntries } = await import('../src/deps/install.ts');
    const zip = minimalZip(Buffer.from('bin/tool.exe', 'utf8'), Buffer.from('x', 'utf8'));
    const read = readZipEntries(zip);
    assert.equal(read.entries[0]?.name, 'bin/tool.exe');
  });
});

// ════════════════════════════════ ⑦ 日志落盘 ════════════════════════════════

describe('日志落盘：事件日志永 UTF-8 无 BOM', () => {
  it('EventLog 写出的行是 UTF-8 且没有 BOM（读回来逐字节对得上）', async () => {
    const { EventLog } = await import('../src/log/event-log.ts');
    const ws = await workspace('eventlog');
    const eventsDir = join(ws, 'events');
    await mkdir(eventsDir, { recursive: true });
    const log = await EventLog.open(eventsDir);
    try {
      log.append({
        seq: 1,
        ts: '2026-10-18T00:00:00.000Z',
        type: 'message/user',
        data: { text: '中文写入 ✅ 与引号 "x"' },
        visibility: 'model',
      } as never, { sync: true });
    } finally {
      log.close();
    }

    const bytes = await readFile(join(eventsDir, '000000000001.jsonl'));
    assert.notEqual(bytes.subarray(0, 3).toString('hex'), 'efbbbf', '事件日志不许带 BOM');
    assert.equal(isUtf8NoBom(bytes), true);
    const text = bytes.toString('utf8');
    assert.match(text, /中文写入/u);
    assert.doesNotMatch(text, /\uFFFD/u);
    // 逐字节可逆：JSON 里的中文就是那串 UTF-8 字节，没有被转义成别的形态或被替换
    assert.ok(text.includes('中文写入 ✅'), `多字节负载要原样落盘，实际 ${JSON.stringify(text)}`);
  });
});
