/**
 * Irmia Agent — 文件系工具包测试
 *
 * 对齐 docs/milestones.md M4-1（路径越界）/ M4-2（符号链接绕过）验收，
 * 以及 design.md §4.18 里 safe 家族的五步链语义。
 *
 * 白名单类用例刻意放在真实临时目录里跑，而不是打桩：只有让内核真的解析
 * `..`、真的跟一遍符号链接，才能证明「拒绝」不是因为路径拼错。
 */

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildMatcher,
  createEnv,
  estimateTokens,
  FS_ERROR_CODES,
  globToRegExp,
  listBackups,
  MAX_DESCRIPTION_TOKENS,
  runProcessDefault,
  splitLines,
  encodeText,
  decodeText,
  expandAliases,
  firstSegmentOf,
  fuzzyMatch,
  planEdit,
  resolveInsideRoot,
  isInside,
  BLOB_ID_PATTERN,
  fsTools,
  type DetectedEncoding,
  type ToolContext,
  type ToolDefinition,
} from '../src/tools/fs/index.ts';
import { DepsManager } from '../src/deps/manager.ts';
import { DEP_SPECS } from '../src/deps/probe.ts';

// ──────────────────────────────── 测试脚手架 ────────────────────────────────

interface Harness {
  root: string;
  outside: string;
  backupDir: string;
  ctx: ToolContext;
  tool(name: string): ToolDefinition;
  /** 工具是否注册（rg_search / es_search 都是条件注册的，断言"没注册"要用它） */
  has(name: string): boolean;
  /** 本次装配用到的探测次数（锁"一次探测"这条不变量） */
  probes(): number;
}

/**
 * 假依赖管理器的探测路由：**测试要的是"路由到哪个可执行文件"，
 * 版本号用不到**（工具首行写的是探测认定的那个命令）。
 * 非 Windows 上 fake-deps-exe 真能跑（见 ensureFakeEngineScript），
 * Windows 上退回真实探测——那时"有引擎"的用例会显式跳过。
 */
const FAKE_DEP_EXE = 'fake-deps-exe';

let fakeEnginePath: string | null = null;

/**
 * 造一个真能跑的假引擎脚本（POSIX）。为什么不用"指向一个不存在的文件"：
 * 那样 `spawn` 会 ENOENT，而"引擎可用"这条路径根本没被走到——
 * 用例会以"未返回结果"失败，看起来像实现坏了。假引擎必须在盘上、真能执行。
 */
async function ensureFakeEngineScript(): Promise<void> {
  if (process.platform === 'win32' || fakeEnginePath !== null) return;
  const root = await mkdtemp(join(tmpdir(), 'irmia-fake-engine-'));
  const path = join(root, 'fake-deps-exe');
  await writeFile(path, '#!/bin/sh\nprintf "ripgrep 15.1.0 (fake)\\n"\n', 'utf8');
  await chmod(path, 0o755);
  fakeEnginePath = path;
}

/**
 * 假依赖管理器。**绝不让测试依赖本机装没装 rg / es**：
 * 探测走注入的 runProcess（测试自己的假实现），没有注入时对 rg 退回真实探测
 * （唯一一处"允许碰真机"的地方，且只影响"调用引擎"那条用例的可用性）。
 *
 * `options.ripgrepPath / everythingPath` 的语义原样保留：`null` = 显式禁用，
 * 字符串 = 指定路径（等价于 config 里指定的第一段）。
 */
function makeFakeDeps(
  root: string,
  options: Record<string, unknown>,
  deps: Record<string, unknown>,
  counter: { n: number },
): DepsManager {
  const configPaths: DepPaths = {
    ...(typeof options['ripgrepPath'] === 'string' ? { rg: options['ripgrepPath'] as string } : {}),
    ...(typeof options['everythingPath'] === 'string' ? { es: options['everythingPath'] as string } : {}),
  };
  const disabled = {
    rg: options['ripgrepPath'] === null,
    es: options['everythingPath'] === null,
  };
  const run = deps['runProcess'] as
    | ((command: string, args: string[], opts: unknown) => Promise<{
      code: number | null; stdout: string; stderr: string; failed: boolean; timedOut: boolean;
    }>)
    | undefined;

  const probe = async (name: string): Promise<{ version: string; path: string } | null> => {
    // 显式禁用 = 不探（连计数都不加）：显式禁用的语义就是"别碰它"
    if (name === 'rg' && disabled.rg) return null;
    if (name === 'es' && disabled.es) return null;
    counter.n += 1;
    // 版本参数照依赖定义走（es 是单横线 `-version`，rg 是 `--version`）：
    // 测试替掉的只是"进程怎么跑"，不是"探测该问什么"
    const args = [...DEP_SPECS[name as 'rg' | 'es'].versionArgs()];
    if (run !== undefined) {
      const result = await run(FAKE_DEP_EXE, args, { timeoutMs: 5000 });
      return result.timedOut || result.code !== 0 ? null : { version: 'fake', path: FAKE_DEP_EXE };
    }
    if (name !== 'rg') return null;
    const command = fakeEnginePath ?? 'rg';
    const real = await runProcessDefault(command, args, { timeoutMs: 5000 });
    return real.code === 0 && /ripgrep/u.test(real.stdout) ? { version: 'fake', path: command } : null;
  };

  return new DepsManager({
    dataDir: join(root, 'data'),
    configPaths,
    ...(disabled.rg ? { ripgrepPath: null } : {}),
    ...(disabled.es ? { everythingPath: null } : {}),
    probe: async (name) => {
      const probed = await probe(name);
      const ok = probed !== null;
      return {
        name,
        status: ok ? 'ready' as const : 'missing' as const,
        path: ok ? probed.path : '',
        version: ok ? '15.1.0' : '',
        anyVersion: ok ? '15.1.0' : '',
        source: ok ? 'config' as const : null,
        dir: null,
        reason: ok ? '' : `测试环境：${name} 不可用`,
        attempts: ok ? [`test: ${probed.path}`] : [`test: ${name} 不可用`],
      };
    },
  });
}

type DepPaths = { pwsh?: string; rg?: string; es?: string };

async function makeHarness(
  options: Record<string, unknown> = {},
  deps: Record<string, unknown> = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'irmia-fs-ws-'));
  const outside = await mkdtemp(join(tmpdir(), 'irmia-fs-out-'));
  const backupDir = join(root, '.backups');
  const counter = { n: 0 };
  const manager = makeFakeDeps(root, options, deps, counter);

  // fsTools 是 async 的（两件搜索工具要探测到引擎才注册），所以装配这一步在工作台里 await 一次
  const table = new Map<string, ToolDefinition>();
  await fsTools(
    { register: (tool) => table.set(tool.name, tool) },
    { backupDir, ...options, deps: manager },
    { now: () => new Date('2026-02-01T00:00:00.000Z'), ...deps },
  );

  const lookup = (name: string): ToolDefinition => {
    const tool = table.get(name);
    assert.ok(tool !== undefined, `工具 ${name} 未注册`);
    return tool;
  };

  return {
    root,
    outside,
    backupDir,
    ctx: {
      callId: 'call-1',
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
      workspaceRoot: root,
    },
    tool: lookup,
    has: (name) => table.has(name),
    probes: () => counter.n,
  };
}

async function withHarness(
  body: (h: Harness) => Promise<void>,
  options: Record<string, unknown> = {},
  deps: Record<string, unknown> = {},
): Promise<void> {
  const har = await makeHarness(options, deps);
  try {
    await body(har);
  } finally {
    await rm(har.root, { recursive: true, force: true });
    await rm(har.outside, { recursive: true, force: true });
  }
}

async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

let rgAvailable: boolean | null = null;
async function detectRipgrep(): Promise<boolean> {
  if (rgAvailable === null) {
    const result = await runProcessDefault('rg', ['--version'], { timeoutMs: 5000 });
    rgAvailable = result.code === 0 && /ripgrep/u.test(result.stdout);
  }
  return rgAvailable;
}

// ──────────────────────────────── 纯函数单元 ────────────────────────────────

describe('text-codec', () => {
  it('splitLines 区分空文件与「一个空行」', () => {
    assert.deepEqual(splitLines('').lines, []);
    assert.deepEqual(splitLines('\n').lines, ['']);
    assert.deepEqual(splitLines('a\n').lines, ['a']);
    assert.deepEqual(splitLines('a\r\nb').lines, ['a', 'b']);
    assert.equal(splitLines('a\r\nb').eol, '\r\n');
    assert.equal(splitLines('a\r\nb').trailingNewline, false);
  });

  it('encodeText 保持 UTF-8 BOM 与 UTF-16LE', () => {
    const bom = encodeText('你好', 'utf8-bom');
    assert.equal(bom.buffer.subarray(0, 3).toString('hex'), 'efbbbf');
    assert.equal(decodeText(bom.buffer).text, '你好');
    assert.equal(decodeText(bom.buffer).encoding, 'utf8-bom');

    const utf16 = encodeText('hello', 'utf16le');
    assert.equal(utf16.buffer.subarray(0, 2).toString('hex'), 'fffe');
    assert.equal(decodeText(utf16.buffer).text, 'hello');
    assert.equal(decodeText(utf16.buffer).encoding, 'utf16le');
  });

  it('GBK 内容能被探针识别（写出时降级为 UTF-8 并说明）', () => {
    // "中文" 的 GBK 字节
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
    const decoded = decodeText(gbk);
    assert.equal(decoded.text, '中文');
    assert.equal(decoded.encoding, 'gbk');

    const encoded = encodeText('中文', 'gbk');
    assert.equal(encoded.encoding, 'utf8');
    assert.equal(encoded.notes.length, 1);
  });

  it('globToRegExp 支持 ** 与 {a,b}', () => {
    assert.ok(globToRegExp('*.ts').test('a.ts'));
    assert.ok(!globToRegExp('*.ts').test('a.js'));
    assert.ok(globToRegExp('src/**/*.{ts,js}').test('src/a/b/c.js'));
    assert.ok(globToRegExp('src/**/*.ts').test('src/a.ts'));
    assert.ok(!globToRegExp('src/**/*.ts').test('lib/a.ts'));
  });

  it('isInside 不会被同前缀目录骗过', () => {
    assert.ok(isInside('/tmp/ws', '/tmp/ws/a.ts'));
    assert.ok(isInside('/tmp/ws', '/tmp/ws'));
    assert.ok(!isInside('/tmp/ws', '/tmp/ws-evil/a.ts'));
    assert.ok(!isInside('/tmp/ws', '/tmp/other'));
  });

  it('buildMatcher 对非法正则给出可读错误', () => {
    const bad = buildMatcher('([', {});
    assert.ok('error' in bad);
    const fixed = buildMatcher('a.b', { fixedStrings: true });
    assert.ok('matcher' in fixed);
    assert.equal(fixed.matcher('xa.by')?.index, 1);
    const plain = buildMatcher('b', {});
    assert.ok('matcher' in plain);
    assert.equal(plain.matcher('abc')?.index, 1);
    assert.equal(plain.matcher('xyz'), null);
    const insensitive = buildMatcher('B', { ignoreCase: true });
    assert.ok('matcher' in insensitive);
    assert.equal(insensitive.matcher('abc')?.index, 1);
  });

  it('fuzzyMatch 要求所有行的缩进差一致', () => {
    const file = ['    a', '    b'];
    assert.equal(fuzzyMatch(file, ['  a', '  b']).length, 1);
    // 差值不一致：第二行差 2、第一行差 0，不算容错命中
    assert.equal(fuzzyMatch(file, ['    a', '  b']).length, 0);
    // 差 3 格超出容错范围
    assert.equal(fuzzyMatch(file, [' a', ' b']).length, 0);
  });

  it('planEdit 保持原文件换行风格', () => {
    const result = planEdit('a\r\nb\r\n', { mode: 'replace', old: 'b', new: 'B' });
    assert.ok(result.ok);
    assert.equal(result.text, 'a\r\nB\r\n');
  });
});

// ──────────────────────────────── 白名单 ────────────────────────────────

describe('路径白名单（M4-1 / M4-2）', () => {
  it('工作区内文件可读，越界路径被拒绝', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'inside.txt'), 'hello', 'utf8');
      await writeFile(join(h.outside, 'secret.txt'), 'TOPSECRET', 'utf8');

      const good = await h.tool('safe_read').handler({ path: 'inside.txt' }, h.ctx);
      assert.equal(good.isError, undefined);
      assert.match(good.content, /hello/u);

      for (const bad of ['../secret.txt', '../../secret.txt', join(h.outside, 'secret.txt')]) {
        const res = await h.tool('safe_read').handler({ path: bad }, h.ctx);
        assert.equal(res.isError, true, `应拒绝：${bad}`);
        assert.equal(res.error?.code, FS_ERROR_CODES.PATH_DENIED);
      }
    });
  });

  it('同前缀目录不算工作区内', async () => {
    await withHarness(async (h) => {
      const sibling = `${h.root}-evil`;
      await mkdir(sibling, { recursive: true });
      await writeFile(join(sibling, 'x.txt'), 'nope', 'utf8');
      try {
        const res = await h.tool('safe_read').handler({ path: join(sibling, 'x.txt') }, h.ctx);
        assert.equal(res.isError, true);
        assert.equal(res.error?.code, FS_ERROR_CODES.PATH_DENIED);
      } finally {
        await rm(sibling, { recursive: true, force: true });
      }
    });
  });

  it('指向工作区外的符号链接目录：读与写都被拒绝', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.outside, 'secret.txt'), 'TOPSECRET', 'utf8');
      await symlink(h.outside, join(h.root, 'link'), 'junction');
      await mkdir(join(h.outside, 'sub'), { recursive: true });

      const read = await h.tool('safe_read').handler({ path: 'link/secret.txt' }, h.ctx);
      assert.equal(read.isError, true);
      assert.equal(read.error?.code, FS_ERROR_CODES.PATH_DENIED);

      // 目标还不存在，但路径经过符号链接——必须靠 realpath 祖先解析挡住（M4-2 的关键点）
      const write = await h.tool('safe_write').handler({ path: 'link/pwn.txt', content: 'x' }, h.ctx);
      assert.equal(write.isError, true);
      assert.equal(write.error?.code, FS_ERROR_CODES.PATH_DENIED);
      await assert.rejects(readText(join(h.outside, 'pwn.txt')));
    });
  });

  it('指向工作区外的符号链接文件同样被拒绝', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.outside, 'secret.txt'), 'TOPSECRET', 'utf8');
      try {
        // Windows 上文件级 symlink 需要开发者模式或管理员权限；无权限时跳过而不是假装测过
        await symlink(join(h.outside, 'secret.txt'), join(h.root, 'file-link.txt'));
      } catch (err) {
        if (process.platform === 'win32' && (err as NodeJS.ErrnoException).code === 'EPERM') return;
        throw err;
      }
      const res = await h.tool('safe_read').handler({ path: 'file-link.txt' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.PATH_DENIED);
    });
  });

  it('工作区内的符号链接仍然可用（拒绝的是越界，不是链接本身）', async () => {
    await withHarness(async (h) => {
      await mkdir(join(h.root, 'real'), { recursive: true });
      await writeFile(join(h.root, 'real', 'a.txt'), 'inside-link', 'utf8');
      await symlink(join(h.root, 'real'), join(h.root, 'alias'), 'junction');
      const res = await h.tool('safe_read').handler({ path: 'alias/a.txt' }, h.ctx);
      assert.equal(res.isError, undefined);
      assert.match(res.content, /inside-link/u);
    });
  });

  it('Windows 保留设备名被拒绝', async () => {
    if (process.platform !== 'win32') return;
    await withHarness(async (h) => {
      const res = await h.tool('safe_read').handler({ path: 'NUL' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.PATH_DENIED);
    });
  });

  it('resolveInsideRoot 对空路径与 NUL 字节给出明确理由', async () => {
    await withHarness(async (h) => {
      const empty = await resolveInsideRoot(h.root, '   ');
      assert.equal(empty.ok, false);
      const nul = await resolveInsideRoot(h.root, 'a\0b');
      assert.equal(nul.ok, false);
      if (!nul.ok) assert.equal(nul.code, FS_ERROR_CODES.PATH_DENIED);
    });
  });
});

// ──────────────────────────────── safe_read（含目录形态） ────────────────────────────────

describe('safe_read', () => {
  it('行号前缀是固定形状：右对齐 4 + │ + 空格（safe_edit 的剥除按同一个形状认）', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.txt'), 'l1\nl2\nl3\n', 'utf8');
      const res = await h.tool('safe_read').handler({ path: 'a.txt' }, h.ctx);
      assert.equal(res.isError, undefined, res.content);
      // 逐行严格比对：`   1│ l1` 是契约（宽度固定 4，1~9999 行都够，且固定宽度才好剥）。
      // 首行前面补一个 \n，这样一条断言同时覆盖"行首"与"行尾"两种位置
      const body = `\n${res.content}\n`;
      assert.ok(body.includes('\n   1│ l1\n'), `行号形状不对：\n${res.content}`);
      assert.ok(body.includes('\n   3│ l3\n'), `行号形状不对：\n${res.content}`);
    });
  });

  it('行号**没有开关**：line_numbers 参数已删，传了也不影响输出', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.txt'), 'l1\n', 'utf8');
      // v27 删掉了这个参数：行号是 safe_edit 行号寻址唯一的地址来源，不该有"关掉眼睛"的开关。
      // 传一个已不存在的参数不该让它静默改变行为（工具契约里 additionalProperties:false，
      // 但 handler 层对未知键的处置是忽略——这里锁的是"输出仍带行号"）
      const res = await h.tool('safe_read').handler({ path: 'a.txt', line_numbers: false }, h.ctx);
      assert.equal(res.isError, undefined, res.content);
      assert.match(res.content, /(^|\n)   1│ l1/u, '不管传什么，行号都必须在');
      const schema = h.tool('safe_read').parameters['properties'] as Record<string, unknown>;
      assert.equal('line_numbers' in schema, false, 'schema 里也不该再有这个参数');
    });
  });

  it('行号前缀 + offset/limit 区间', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.txt'), 'l1\nl2\nl3\nl4\nl5\n', 'utf8');
      const res = await h.tool('safe_read').handler({ path: 'a.txt', offset: 2, limit: 2 }, h.ctx);
      assert.equal(res.isError, undefined);
      assert.match(res.content, /   2│ l2/u);
      assert.match(res.content, /   3│ l3/u);
      assert.ok(!res.content.includes('l4'), 'limit 之外的行不应出现');
      assert.match(res.content, /显示 2-3/u);
    });
  });

  it('行号是**文件真实行号**，不是切片内的相对号（tail / offset 最容易错）', async () => {
    // 这一条是行号寻址能用的前提：她读 tail 拿到 `   4│ l4`，就该能拿 4 去 delete_lines；
    // 若输出的是切片相对号（1），她会删掉文件开头——静默改错文件，比报错难查得多。
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.txt'), 'l1\nl2\nl3\nl4\nl5', 'utf8');

      const tail = await h.tool('safe_read').handler({ path: 'a.txt', tail: 2 }, h.ctx);
      const tailBody = `\n${tail.content}\n`;
      assert.ok(tailBody.includes('\n   4│ l4\n'), `tail 的行号必须是 4/5：\n${tail.content}`);
      assert.ok(tailBody.includes('\n   5│ l5\n'), `tail 的行号必须是 4/5：\n${tail.content}`);
      assert.ok(!tail.content.includes('   1│ '), 'tail 不该出现相对行号 1');

      const range = await h.tool('safe_read').handler({ path: 'a.txt', offset: 3 }, h.ctx);
      assert.ok(`\n${range.content}\n`.includes('\n   3│ l3\n'), `offset 之后的行号必须从 3 起：\n${range.content}`);
      assert.ok(!range.content.includes('   1│ '), 'offset 之后不该从 1 重新数');
    });
  });

  it('head 与 tail 互斥，且各自取对端', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.txt'), 'l1\nl2\nl3\nl4\nl5', 'utf8');
      const head = await h.tool('safe_read').handler({ path: 'a.txt', head: 2 }, h.ctx);
      assert.match(head.content, /l1/u);
      assert.match(head.content, /l2/u);
      assert.ok(!head.content.includes('l3'));

      const tail = await h.tool('safe_read').handler({ path: 'a.txt', tail: 2 }, h.ctx);
      assert.match(tail.content, /l4/u);
      assert.match(tail.content, /l5/u);
      assert.ok(!tail.content.includes('l3'));

      const both = await h.tool('safe_read').handler({ path: 'a.txt', head: 1, tail: 1 }, h.ctx);
      assert.equal(both.isError, true);
      assert.equal(both.error?.code, FS_ERROR_CODES.INVALID_ARGS);
    });
  });

  it('超过单次返回行数上限时截断并给出续读指引', async () => {
    await withHarness(async (h) => {
      const lines = Array.from({ length: 500 }, (_, i) => `line-${i + 1}`).join('\n');
      await writeFile(join(h.root, 'big.txt'), lines, 'utf8');
      const res = await h.tool('safe_read').handler({ path: 'big.txt' }, h.ctx);
      assert.match(res.content, /\[截断\]/u);
      assert.match(res.content, /offset=51&limit=50/u);
    }, { maxReadLines: 50 });
  });

  /**
   * L1 会丢内容的那条（核查报告）：`safe_read` 只解析前 8 MiB，于是**行数是前半截的**，
   * 而 `safe_edit` 的 `insert_at_line`/`delete_lines` 按**整文件**行号结算。
   * 实测 160000 行的文件 `safe_read` 报 129056 行，她据此 `insert_at_line 129056`
   * 以为在追加，**实际插在文件中间且不报错**。
   *
   * 处置是"把不完整说出来"，不是"假装数完了"：头部那格改写成 `约 N 行（…未数完）`，
   * 提示里明说**行号只在前 8 MiB 内有效、别拿去 insert_at_line**。
   * 这一条就锁这两件事**必须一起出现**——缺任何一个，"偏小的行数被当总数"这条路又通了。
   */
  it('超过单次解析上限时，行数**必须标明不完整**且指出行号只在前半截内有效（L1）', async () => {
    await withHarness(async (h) => {
      // 造一个 > 8 MiB 的文本文件。行要够短、够多，才能把"数出来的比真实少"这件事放大。
      const lineText = `${'x'.repeat(63)}\n`;              // 64 字节/行
      const totalLines = Math.ceil((9 * 1024 * 1024) / 64); // > 8 MiB ⇒ 必然被截
      await writeFile(join(h.root, 'huge.txt'), lineText.repeat(totalLines), 'utf8');
      const size = (await stat(join(h.root, 'huge.txt'))).size;
      assert.ok(size > 8 * 1024 * 1024, `夹具必须是 > 8 MiB，实际 ${size}`);

      const res = await h.tool('safe_read').handler({ path: 'huge.txt' }, h.ctx);
      assert.equal(res.isError, undefined, res.content.slice(0, 400));

      // ① 头部那格不许把"半截行数"说成总数
      const header = res.content.split('\n')[0] ?? '';
      assert.match(header, /约 \d+ 行（仅前 [^）]*内，未数完）/u, `头部的行数格必须标明不完整：\n${header}`);

      // ② 行号作用域必须有明说
      assert.match(res.content, /行号只在前/u, '要说清行号的有效范围');
      assert.match(res.content, /不是全文件的行数/u, '要明说那个数不是全文件的行数');
      assert.match(res.content, /insert_at_line|delete_lines/u, '要明确警告不要拿它做行号寻址');

      // ③ 报出来的行数确实**小于**真实行数（这就是那条坑的形态，改完仍未变——变的是"说没说"）
      const reported = Number(/约 (\d+) 行/u.exec(header)?.[1] ?? '0');
      assert.ok(reported > 0, `要报一个行数：${header}`);
      assert.ok(
        reported < totalLines,
        `这一条夹具的意义就在于"报出来的比真实少"：报 ${reported} / 真实 ${totalLines}`,
      );
    });
  });

  it('文件没超过解析上限时，行数照旧是确切值（不给没超的文件加免责声明）', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'small.txt'), 'l1\nl2\nl3\n', 'utf8');
      const res = await h.tool('safe_read').handler({ path: 'small.txt' }, h.ctx);
      const header = res.content.split('\n')[0] ?? '';
      assert.match(header, /· 3 行 ·/u, `小文件的行数该是确切的：\n${header}`);
      assert.ok(!res.content.includes('未数完'), '没超上限就不该出现"未数完"');
    });
  });

  it('二进制文件被拒绝并指向 read_blob', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
      const res = await h.tool('safe_read').handler({ path: 'bin.dat' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.BINARY_FILE);
      assert.match(res.content, /read_blob/u);
    });
  });

  /**
   * 字节硬顶（A 组 #5）。旧实现只有 2000 行的上限，`maxReadBytes` **只用来加一句提示**：
   * 实测 3 行 × 1MB 的文件返回 3,145,941 字节、单个 4MB 长行返回 4,194,502 字节，
   * 两者都不带截断标记（docs/devkit-migration-audit.md §1 #5）。改成真截断之后，
   * 这两条路径都必须**带标记**且**字节数受控**——4 MB 进上下文不是"多花点钱"，是撑爆窗口。
   */
  it('按字节硬顶截断（不是只提示）：多行长内容', async () => {
    await withHarness(async (h) => {
      // 20 行 × 200 字节 = 4000+ 字节，上限 1000 字节
      const lines = Array.from({ length: 20 }, (_, i) => `line-${i + 1} ${'x'.repeat(190)}`);
      await writeFile(join(h.root, 'wide.txt'), lines.join('\n'), 'utf8');
      const res = await h.tool('safe_read').handler({ path: 'wide.txt' }, h.ctx);
      assert.equal(res.isError, undefined, res.content);

      assert.match(res.content, /\[截断\]/u, '被字节截断就必须带截断标记');
      assert.match(res.content, /单次字节上限/u, '要说清是字节上限截的，不是行数截的');
      assert.match(res.content, /\*\*这不是文件全文\*\*/u, '不许让她以为这就是全文');
      assert.match(res.content, /offset=\d+&limit=\d+/u, '必须给出怎么接着读');

      // 真正的字节数受控：正文（去掉头部与提示段）不得超过上限
      const bodyOnly = res.content.split('\n\n')[0]?.split('\n').slice(1).join('\n') ?? '';
      assert.ok(
        Buffer.byteLength(bodyOnly, 'utf8') <= 1000,
        `正文必须在 1000 字节以内，实际 ${Buffer.byteLength(bodyOnly, 'utf8')}`,
      );
    }, { maxReadBytes: 1000 });
  });

  it('按字节硬顶截断：单个 4MB 长行也照截（这是最贵的一条路径）', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'oneline.txt'), `HEAD${'y'.repeat(4 * 1024 * 1024)}`, 'utf8');
      const res = await h.tool('safe_read').handler({ path: 'oneline.txt' }, h.ctx);
      assert.equal(res.isError, undefined);
      assert.match(res.content, /\[截断\]/u);
      assert.ok(
        Buffer.byteLength(res.content, 'utf8') < 20_000,
        `单行 4MB 的文件绝不能整行回来；实际 ${Buffer.byteLength(res.content, 'utf8')} 字节`,
      );
      // 至少给她看到开头：什么都不返回比返回一个被切掉的行更难处理
      assert.match(res.content, /HEAD/u);
    }, { maxReadBytes: 4096 });
  });

  it('UTF-8 BOM 与 UTF-16LE 都能正确解码', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'bom.txt'), encodeText('中文内容', 'utf8-bom').buffer);
      const bom = await h.tool('safe_read').handler({ path: 'bom.txt' }, h.ctx);
      assert.match(bom.content, /utf8-bom/u);
      assert.match(bom.content, /中文内容/u);

      await writeFile(join(h.root, 'u16.txt'), encodeText('宽字符', 'utf16le').buffer);
      const u16 = await h.tool('safe_read').handler({ path: 'u16.txt' }, h.ctx);
      assert.match(u16.content, /utf16le/u);
      assert.match(u16.content, /宽字符/u);
    });
  });

  it('目标是目录时**直接列出目录内容**（v42：list_dir 已并入这里，不再指路到别处）', async () => {
    await withHarness(async (h) => {
      await mkdir(join(h.root, 'sub'), { recursive: true });
      await writeFile(join(h.root, 'sub', 'inside.txt'), 'x', 'utf8');
      const res = await h.tool('safe_read').handler({ path: 'sub' }, h.ctx);
      // 从前这里是一句「…是目录；查看目录内容请用 list_dir」——工具一删，那句话就指向一个
      // 不存在的工具（她照做只会拿到"未知工具"）。现在同一个调用直接给结果。
      assert.equal(res.isError, undefined, res.content);
      assert.equal(res.error?.code, undefined);
      assert.match(res.content, /^sub\/ · 目录 0 个 \/ 文件 1 个 · depth=1/u);
      assert.match(res.content, /\[F\] inside\.txt/u);
    });
  });

  it('缺少 path 时给出参数提示而不是崩溃', async () => {
    await withHarness(async (h) => {
      const res = await h.tool('safe_read').handler({}, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.INVALID_ARGS);
      const notObject = await h.tool('safe_read').handler('src/main.ts', h.ctx);
      assert.equal(notObject.isError, true);
    });
  });
});

describe('safe_read 的目录形态（v42：list_dir 并入这里）', () => {
  it('列出类型、大小与时间，depth 控制递归', async () => {
    await withHarness(async (h) => {
      await mkdir(join(h.root, 'pkg/nested'), { recursive: true });
      await writeFile(join(h.root, 'pkg/a.ts'), 'x', 'utf8');
      await writeFile(join(h.root, 'pkg/nested/b.ts'), 'yy', 'utf8');

      const flat = await h.tool('safe_read').handler({ path: 'pkg' }, h.ctx);
      assert.match(flat.content, /\[F\] a\.ts/u);
      assert.match(flat.content, /\[D\] nested\//u);
      assert.ok(!flat.content.includes('b.ts'), 'depth=1 不应下探');

      const deep = await h.tool('safe_read').handler({ path: 'pkg', depth: 2 }, h.ctx);
      assert.match(deep.content, /nested\/b\.ts/u);
      // depth 是旧 list_dir 使用率最高的非默认参数（实测 136/201），口径一个字不改：上限 5
      const over = await h.tool('safe_read').handler({ path: 'pkg', depth: 9 }, h.ctx);
      assert.equal(over.isError, true);
      assert.equal(over.error?.code, FS_ERROR_CODES.INVALID_ARGS);
    });
  });

  it('条数上限复用 limit，超量如实截断并给"怎么缩小范围"的指路', async () => {
    await withHarness(async (h) => {
      for (let i = 0; i < 8; i += 1) await writeFile(join(h.root, `f${i}.txt`), 'x', 'utf8');
      const res = await h.tool('safe_read').handler({ path: '.', limit: 3 }, h.ctx);
      assert.equal(res.isError, undefined, res.content);
      assert.match(res.content, /已截断：上限 3 条/u);
      // 指路要可执行：缩小 path / 调小 depth / 两件搜索工具 / pwsh 的 Get-ChildItem
      assert.match(res.content, /rg_search/u);
      assert.match(res.content, /es_search/u);
      assert.match(res.content, /Get-ChildItem/u);
      const rows = res.content.split('\n').filter((line) => /^\[(D|F|L|\?)\] /u.test(line));
      assert.equal(rows.length, 3, 'limit 就是这一次列目录的条数上限');
    });
  });

  it('不跟进指向目录的符号链接', async () => {
    await withHarness(async (h) => {
      await mkdir(join(h.root, 'real'), { recursive: true });
      await writeFile(join(h.root, 'real/deep.txt'), 'x', 'utf8');
      await symlink(join(h.root, 'real'), join(h.root, 'alias'), 'junction');
      const res = await h.tool('safe_read').handler({ path: '.', depth: 3 }, h.ctx);
      assert.match(res.content, /\[L\] alias/u);
      assert.ok(!res.content.includes('alias/deep.txt'), '符号链接目录不应被展开');
    });
  });

  it('head/tail/offset 对目录不适用时**说出口**（不静默假装生效）', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'only.txt'), 'x', 'utf8');
      const res = await h.tool('safe_read').handler({ path: '.', head: 2 }, h.ctx);
      assert.equal(res.isError, undefined, res.content);
      assert.match(res.content, /head\/tail\/offset 对目录不适用/u);
    });
  });
});

// ──────────────────────────────── rg_search / es_search ────────────────────────────────

describe('rg_search（条件注册）', () => {
  it('探测不到 ripgrep 时**根本不注册**（v30 删掉了 TS 降级链）', async () => {
    await withHarness(async (h) => {
      assert.equal(h.has('rg_search'), false, '没有 ripgrep 就不该有这件工具');
      // 同一台机器上其余工具一件都不能少：条件注册只针对引擎那两件
      for (const name of ['safe_read', 'read_blob', 'safe_edit', 'safe_write']) {
        assert.equal(h.has(name), true, `${name} 不该被连坐`);
      }
    }, { ripgrepPath: null });
  });

  it('有引擎时调用它并标注 engine（解析与形状都不变）', async () => {
    await ensureFakeEngineScript();
    if (fakeEnginePath === null) return; // Windows：没有可执行的假引擎，跳过（本机真装 rg 时由下面的用例覆盖）
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'const a = 1;\n// TODO fix\nconst b = 2;\n', 'utf8');
      const res = await h.tool('rg_search').handler({ pattern: 'TODO', context: 1 }, h.ctx);
      assert.match(res.content, /^engine: ripgrep/u);
      assert.match(res.content, /a\.ts:2:4/u);
      // 上下文行与匹配行同形：前一行带行号管道符，命中行带冒号
      assert.match(res.content, /1\| const a = 1;/u);
      assert.match(res.content, /2: \/\/ TODO fix/u);
    });
  });

  // Windows 上假引擎跑不起来（本仓库的开发机就是 Windows），这条用例退回真实 rg；
  // 它锁的是**解析形状**（--null 输出、上下文行、列号重算），与引擎真假无关
  it('本机真装 rg 时：解析形状与上面一致', async () => {
    if (fakeEnginePath !== null) return; // 已经由假引擎覆盖过
    if (!await detectRipgrep()) return;
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'const a = 1;\n// TODO fix\nconst b = 2;\n', 'utf8');
      const res = await h.tool('rg_search').handler({ pattern: 'TODO', context: 1 }, h.ctx);
      assert.match(res.content, /^engine: ripgrep/u);
      assert.match(res.content, /a\.ts:2:4/u);
      assert.match(res.content, /2: \/\/ TODO fix/u);
    });
  });

  it('探测是逐件一次的：装配后不再探，handler 也不探', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.txt'), 'hit\n', 'utf8');
      // rg 显式禁用（不探），es 自动探测且本机没有（一次探测）
      assert.equal(h.has('rg_search'), false);
      assert.equal(h.has('es_search'), false);
      assert.equal(h.probes(), 1, '两件工具只该付一次探测（禁用的那件连探都不探）');
    }, { ripgrepPath: null });
  });

  it('非法正则被拒绝', async () => {
    await ensureFakeEngineScript();
    if (fakeEnginePath === null) return;
    await withHarness(async (h) => {
      const res = await h.tool('rg_search').handler({ pattern: '([' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.INVALID_ARGS);
    });
  });

  it('max_results 截断并提示', async () => {
    await ensureFakeEngineScript();
    if (fakeEnginePath === null) return;
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.txt'), Array.from({ length: 20 }, () => 'hit').join('\n'), 'utf8');
      const res = await h.tool('rg_search').handler({ pattern: 'hit', max_results: 3 }, h.ctx);
      assert.match(res.content, /\[已达上限 3/u);
    });
  });

  it('搜索范围越界被拒绝', async () => {
    await ensureFakeEngineScript();
    if (fakeEnginePath === null) return;
    await withHarness(async (h) => {
      const res = await h.tool('rg_search').handler({ pattern: 'x', path: '../' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.PATH_DENIED);
    });
  });

  /**
   * P3：实测她 11 次把**文件路径**喂给 rg_search，全部被"不是目录"挡回去
   * （占这件工具 16 次失败里的 11 次，docs/tools-audit.md §2.2）——而 `rg` 本来就吃文件操作数。
   *
   * 用假引擎而不是本机真 rg：这条锁的是"文件操作数被原样交出去、结果能解析"，
   * 装没装 rg 都该跑。`runProcess` 注入同时管探测与搜索（与 es_search 那两条同一套路）。
   */
  it('path 给单个文件也吃得下：传文件只搜它，传目录照旧递归（P3）', async () => {
    /** 每次 runProcess 的实参（探测 + 搜索都记，最后一条就是这次搜索） */
    const calls: string[][] = [];
    const fakeRg = async (command: string, args: string[]): Promise<{
      code: number | null; stdout: string; stderr: string; failed: boolean; timedOut: boolean;
    }> => {
      calls.push([command, ...args]);
      if (args.includes('--version')) {
        return { code: 0, stdout: 'ripgrep 15.1.0 (fake)\n', stderr: '', failed: false, timedOut: false };
      }
      // `--null` 的输出形状：`<路径>NUL<行号>:<文本>`。
      // 假引擎不做真递归：操作数看着是文件就回它自己，是目录就回它里面的 b.ts
      //（真实 rg 在目录下命中的也是**文件**；这条用例锁的是"操作数被原样交出去"，不是递归本身）
      const operand = args[args.length - 1] ?? '';
      const hitFile = operand.toLowerCase().endsWith('a.ts') ? operand : join(operand, 'b.ts');
      return { code: 0, stdout: `${hitFile}\u00002:hit here\n`, stderr: '', failed: false, timedOut: false };
    };

    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'one\nhit here\n', 'utf8');
      await mkdir(join(h.root, 'sub'), { recursive: true });
      await writeFile(join(h.root, 'sub', 'b.ts'), 'one\nhit here\n', 'utf8');

      // ① 传文件：不再被拒，且交给 rg 的最后一个实参就是那个文件本身（不是它的父目录）。
      //    比较用**大小写无关**：path-guard 交出去的是 realpath 规范化后的路径，
      //    而 TEMP 在 Windows 上大小写与 mkdtemp 拿到的写法未必一致。
      const file = await h.tool('rg_search').handler({ pattern: 'hit', path: 'a.ts' }, h.ctx);
      assert.equal(file.isError, undefined, file.content);
      assert.match(file.content, /a\.ts:2:1: hit here/u);
      assert.equal(
        calls.at(-1)?.at(-1)?.toLowerCase(),
        join(h.root, 'a.ts').toLowerCase(),
        '文件操作数要原样交给 rg——这是 rg 的基本用法',
      );

      // ② 传目录：行为一个字不改，照旧递归（原来是目录、现在还是目录）
      const dir = await h.tool('rg_search').handler({ pattern: 'hit', path: 'sub' }, h.ctx);
      assert.equal(dir.isError, undefined, dir.content);
      assert.match(dir.content, /sub\/b\.ts:2:1: hit here/u);
      assert.equal(calls.at(-1)?.at(-1)?.toLowerCase(), join(h.root, 'sub').toLowerCase(), '目录照旧原样交给 rg');
    }, { ripgrepPath: 'C:\\fake\\rg.exe' }, { runProcess: fakeRg });
  });
});

describe('es_search（条件注册）', () => {
  it('探测不到 es.exe 时**根本不注册**（旧实现里它永远在，且每次都 fallback）', async () => {
    await withHarness(async (h) => {
      assert.equal(h.has('es_search'), false, '没有 es.exe 就不该有这件工具');
      // 同一台机器上其余工具一件都不能少：条件注册只针对这一件
      for (const name of ['safe_read', 'read_blob', 'safe_edit']) {
        assert.equal(h.has(name), true, `${name} 不该被连坐`);
      }
    }, { everythingPath: null });
  });

  it('探测到 es.exe 才注册；调用走引擎而不是 fallback', async () => {
    // 注入一个假的 es.exe：注册探测（`-version`）与正式调用各答一次。
    // 这条用例锁的是"探测结论 → 注册 → handler 分派"这三步用的是同一份判断
    const calls: string[][] = [];
    // es 返回的是绝对路径，而工作区根要到 makeHarness 里才知道——用一个可变引用把它接上
    const ws = { root: '' };
    const fakeEs = async (command: string, args: string[]): Promise<Record<string, unknown>> => {
      calls.push([command, ...args]);
      if (args.includes('-version')) {
        return { code: 0, stdout: '1.1.0.27', stderr: '', failed: false, timedOut: false };
      }
      return {
        code: 0,
        stdout: `${join(ws.root, 'src', 'alpha.test.ts')}\r\n`,
        stderr: '',
        failed: false,
        timedOut: false,
      };
    };
    await withHarness(async (h) => {
      ws.root = h.root;
      assert.equal(h.has('es_search'), true, '探到 es.exe 就该注册');
      // 描述预算是硬门（design §4.18 / registry.ts 的 MAX_DESCRIPTION_TOKENS）：这一件是
      // **条件注册**的，没装 es.exe 的机器上 `tool-catalog` 那条 `problems` 断言根本看不到它，
      // 所以这里在"它确实注册了"的这条用例里直接锁一次——参数加到 10 个，描述仍要压得住。
      const descTokens = estimateTokens(h.tool('es_search').description);
      assert.ok(
        descTokens < MAX_DESCRIPTION_TOKENS,
        `es_search 的描述 ${descTokens} token，超过硬门 ${MAX_DESCRIPTION_TOKENS}（超了会静默少一件工具）`,
      );
      const result = await h.tool('es_search').handler({ pattern: '*.test.ts' }, h.ctx);
      assert.equal(result.isError, undefined, result.content);
      assert.match(result.content, /^engine: everything \(es (fake|15\.1\.0)\)/u);
      assert.ok(!result.content.includes('fallback'), '探到引擎就不该再走 fallback');
      assert.match(result.content, /src\/alpha\.test\.ts/u, '绝对路径要转成工作区相对路径');
      // es 的注册探测是 `-version`；rg 的探测（`--version`）会先出现在同一个假实现里，
      // 所以这里按参数筛出 es 那一次，而不是假设它是第一个
      const versionCalls = calls.filter((call) => call.includes('-version'));
      assert.equal(versionCalls.length, 1, `es 的探测只该发生一次：${JSON.stringify(calls)}`);
      // 三次调用 = rg 探测 + es 探测 + 这一次搜索。**探测各一次**就是这条用例要锁的不变量：
      // 旧实现里 es 的 5 个候选会各来一次，而这个假实现会看到 5 次 `-version`
      assert.equal(calls.length, 3, `调用序列不符：${JSON.stringify(calls)}`);
      // `-n 100`：es_search 的 max_results 默认值**保持 100**（与源同值，`tools/es_search.py:206`）。
      // 本次只把它的**下界**从 1 放宽到 0（`max_results:0` = 只统计），默认值一个字没动
      assert.match(calls[2]?.join(' ') ?? '', /-n 100 -path /u, '第三次必须是那次搜索本身');
    }, { everythingPath: 'C:\\fake\\es.exe' }, { runProcess: fakeEs });
  });

  it('调用超时如实报错，不降级成"我们自己扫一遍"', async () => {
    // 与退出码 8 那条同一条口径：工具是因为探测到引擎才注册的，
    // 超时之后换一条自己的扫描路，只会让"结果看起来是成功的"却不说明它换了引擎。
    await withHarness(async (h) => {
      const res = await h.tool('es_search').handler({ pattern: 'a.txt', detail: 'full', regex: true }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.SEARCH_FAILED);
      assert.match(res.content, /调用超时/u);
      assert.match(res.content, /rg_search/u, '拒绝时要给出替代路径');
    }, { everythingPath: 'C:\\fake\\es.exe' }, {
      runProcess: async (_command: string, args: string[]) => (args.includes('-version')
        ? { code: 0, stdout: '1.1.0.38', stderr: '', failed: false, timedOut: false }
        : { code: null, stdout: '', stderr: '', failed: true, timedOut: true }),
    });
  });

  it('引擎在、客户端没跑（退出码 8）时如实报错，不静默降级成扫描', async () => {
    await withHarness(async (h) => {
      const res = await h.tool('es_search').handler({ pattern: 'a.txt' }, h.ctx);
      assert.equal(res.isError, true);
      assert.match(res.content, /Everything 客户端没有在运行/u);
      assert.match(res.content, /rg_search/u, '拒绝时要给出替代路径');
    }, { everythingPath: 'C:\\fake\\es.exe' }, {
      runProcess: async (_command: string, args: string[]) => (args.includes('-version')
        ? { code: 0, stdout: '1.1.0.27', stderr: '', failed: false, timedOut: false }
        : { code: 8, stdout: '', stderr: 'Everything IPC unavailable', failed: false, timedOut: false }),
    });
  });
});

// ──────────────────── es_search 的引擎实参映射（对齐 devkit 的参数面） ────────────────────
//
// 这一组锁的是**参数 → es.exe 实参**那一层：devkit 的 `es_search`（`tools/es_search.py`）
// 有 9 个参数，我们的封装曾经只有 5 个 —— 用户原话是「es.exe 是个强大的工具，
// 我不希望被我们的封装毁了」，「至少要达到原 irmia_devkit_open 的水平」。
// 所以每一条映射都逐条断言**完整实参数组**（而不是"包含某个开关"）：
// 顺序与拼法错了，真机上就是"开关在、结果不对"——那是冒烟看不出来的那类坏。
//
// 实参形状**都在本机 es.exe 1.1.0.38 上真机冒烟过**（docs/tools-audit.md §3.4 有命令与输出）。
// 两条实测规则直接决定了这里的拼装顺序：
//   ① `-r` 必须**紧挨着**模式串（中间夹 `--` 或别的开关 → 正则静默失效，0 命中）；
//   ② 一个 argv 元素 = 一个搜索词：`ext:<值>` 必须自己一个元素，拼成一个字符串会被当短语，
//      `ext:` 过滤器失效（devkit 的字面写法 `"ext:ts <query>"` 实测 0 命中，这里有意偏离）。

/** 假 es.exe：`-version` 走探测，其余把实参记进 `calls` 并按 `respond` 作答 */
function makeFakeEs(
  calls: string[][],
  respond: (args: string[]) => string,
): (command: string, args: string[]) => Promise<Record<string, unknown>> {
  return async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (args.includes('-version')) {
      return { code: 0, stdout: '1.1.0.38', stderr: '', failed: false, timedOut: false };
    }
    return { code: 0, stdout: respond(args), stderr: '', failed: false, timedOut: false };
  };
}

/**
 * 探测调用（rg 的是 `--version`、es 的是 `-version`）——两者都不算搜索。
 * 少滤掉一个，断言就会数到装配期那一次探测上（本仓库里 rg 与 es 同在一台装配里探测）。
 */
function isProbeCall(call: string[]): boolean {
  return call.some((arg) => arg === '-version' || arg === '--version');
}

/**
 * 取这次搜索的实参（探测那次不算），并把工作根换成 `<ROOT>`。
 * 换掉是必要的：path-guard 交出去的是 **realpath** 规范化后的路径，
 * 而 Windows 上 TEMP 的大小写与 mkdtemp 拿到的写法未必一致（既有用例踩过同一个坑）。
 */
function esArgvOf(calls: string[][], root: string): string[] {
  const search = calls.filter((call) => !isProbeCall(call)).at(-1) ?? [];
  return search.slice(1).map((arg) => (arg.toLowerCase() === root.toLowerCase() ? '<ROOT>' : arg));
}

describe('es_search 的引擎实参映射（逐条对齐 devkit）', () => {
  /** 每条用例：参数 → 期望的完整实参数组（`<ROOT>` 会被换成本次工作根） */
  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    ['默认（只列路径）', { pattern: '*.ts' }, ['-n', '100', '-path', '<ROOT>', '--', '*.ts']],
    ['regex=true', { pattern: '^index\\.ts$', regex: true }, ['-n', '100', '-path', '<ROOT>', '-r', '^index\\.ts$']],
    ['regex=false（字面量）', { pattern: '*.ts', regex: false }, ['-n', '100', '-path', '<ROOT>', '--', '*.ts']],
    ['whole_word=true', { pattern: 'index', whole_word: true }, ['-n', '100', '-path', '<ROOT>', '-w', '--', 'index']],
    ['file_type=file', { pattern: '*.ts', file_type: 'file' }, ['-n', '100', '-path', '<ROOT>', '/a-d', '--', '*.ts']],
    ['file_type=folder', { pattern: 'src', file_type: 'folder' }, ['-n', '100', '-path', '<ROOT>', '/ad', '--', 'src']],
    ['file_type=all（不加属性开关）', { pattern: '*.ts', file_type: 'all' }, ['-n', '100', '-path', '<ROOT>', '--', '*.ts']],
    ['ext=ts（自己一个搜索词）', { pattern: 'config', ext: 'ts' }, ['-n', '100', '-path', '<ROOT>', 'ext:ts', '--', 'config']],
    // devkit 同一条判据：`if ext and not regex`
    ['regex=true 时 ext 不拼', { pattern: '^index', regex: true, ext: 'ts' }, ['-n', '100', '-path', '<ROOT>', '-r', '^index']],
    ['ext 空串 = 不过滤', { pattern: 'config', ext: '' }, ['-n', '100', '-path', '<ROOT>', '--', 'config']],
    ['max_results=5', { pattern: '*.ts', max_results: 5 }, ['-n', '5', '-path', '<ROOT>', '--', '*.ts']],
    ['match_path=true', { pattern: 'tools\\fs', match_path: true }, ['-n', '100', '-path', '<ROOT>', '-p', '--', 'tools\\fs']],
    ['ignore_case=false → -i（区分大小写）', { pattern: '*.TS', ignore_case: false }, ['-n', '100', '-path', '<ROOT>', '-i', '--', '*.TS']],
    ['ignore_case=true（默认，不加 -i）', { pattern: '*.ts', ignore_case: true }, ['-n', '100', '-path', '<ROOT>', '--', '*.ts']],
    ['detail=paths（默认，不加 CSV 组）', { pattern: '*.ts', detail: 'paths' }, ['-n', '100', '-path', '<ROOT>', '--', '*.ts']],
    [
      'detail=full → CSV 那一组',
      { pattern: '*.ts', detail: 'full' },
      ['-n', '100', '-path', '<ROOT>', '-csv', '-name', '-path-column', '-size', '-size-format', '1', '-date-modified', '--', '*.ts'],
    ],
    [
      '全开关一起（顺序就是这个顺序）',
      { pattern: 'index', max_results: 7, file_type: 'file', ignore_case: false, match_path: true, whole_word: true, sort_by: 'date_modified', detail: 'full', ext: 'ts' },
      ['-n', '7', '-path', '<ROOT>', '/a-d', '-i', '-p', '-w', '-sort', 'date-modified', '-csv', '-name', '-path-column', '-size', '-size-format', '1', '-date-modified', 'ext:ts', '--', 'index'],
    ],
  ];

  for (const [label, args, expected] of cases) {
    it(`实参映射：${label}`, async () => {
      const calls: string[][] = [];
      await withHarness(
        async (h) => {
          const res = await h.tool('es_search').handler(args, h.ctx);
          assert.equal(res.isError, undefined, `${label} 不该失败：${res.content}`);
          assert.deepEqual(esArgvOf(calls, h.root), expected, `${label} 的实参形状不符`);
        },
        { everythingPath: 'C:\\fake\\es.exe' },
        { runProcess: makeFakeEs(calls, () => '') },
      );
    });
  }

  it('sort_by 八个键 → 八个 es.exe 值（含 ext→extension / date_*→date-* / run_count→run-count）', async () => {
    // 这张表是 devkit 的 `SORT_MAP`（tools/es_search.py:30-39）逐键抄的。
    // 八个值都在本机 es.exe 1.1.0.38 上冒烟过（值不认时它退 4 并说 Unknown sort）。
    const map: Array<[string, string]> = [
      ['name', 'name'],
      ['path', 'path'],
      ['size', 'size'],
      ['ext', 'extension'],
      ['date_created', 'date-created'],
      ['date_modified', 'date-modified'],
      ['date_accessed', 'date-accessed'],
      ['run_count', 'run-count'],
    ];
    for (const [key, esValue] of map) {
      const calls: string[][] = [];
      await withHarness(
        async (h) => {
          const res = await h.tool('es_search').handler({ pattern: '*.ts', sort_by: key }, h.ctx);
          assert.equal(res.isError, undefined, `sort_by=${key} 不该失败：${res.content}`);
          const argv = esArgvOf(calls, h.root);
          const at = argv.indexOf('-sort');
          assert.notEqual(at, -1, `sort_by=${key} 必须给 -sort`);
          assert.equal(argv[at + 1], esValue, `sort_by=${key} → ${esValue}`);
        },
        { everythingPath: 'C:\\fake\\es.exe' },
        { runProcess: makeFakeEs(calls, () => '') },
      );
    }
  });

  it('枚举值非法 ⇒ 明确的参数错，且消息里给出合法取值', async () => {
    const calls: string[][] = [];
    await withHarness(
      async (h) => {
        const bad: Array<[Record<string, unknown>, RegExp]> = [
          [{ pattern: 'x', file_type: 'dirs' }, /file_type 只能是 all \/ file \/ folder/u],
          [{ pattern: 'x', sort_by: 'modified' }, /sort_by 只能是 name \/ path \/ size \/ ext \/ date_created \/ date_modified \/ date_accessed \/ run_count/u],
          [{ pattern: 'x', detail: 'files' }, /detail 只能是 paths \/ full/u],
        ];
        for (const [args, pattern] of bad) {
          const res = await h.tool('es_search').handler(args, h.ctx);
          assert.equal(res.isError, true, `${JSON.stringify(args)} 该被拒`);
          assert.equal(res.error?.code, FS_ERROR_CODES.INVALID_ARGS);
          assert.match(res.content, pattern, `错误消息要说清合法取值：${res.content}`);
        }
        // 参数错就**一个进程都不许起**（探测那次不算）：非法值绝不能被拼进实参、
        // 换来一句 es.exe 的退出码 4——那是"把校验责任推给引擎"，错误信息也远不如本地这句。
        assert.equal(calls.filter((call) => !isProbeCall(call)).length, 0);
      },
      { everythingPath: 'C:\\fake\\es.exe' },
      { runProcess: makeFakeEs(calls, () => '') },
    );
  });
});

describe("es_search 的 detail:'full'（devkit 能拿到的一条都不少）", () => {
  /**
   * 真 CSV 夹具：**逐字照本机 es.exe 1.1.0.38 的 `-csv` 输出形状**（尺寸/时间都来自真机冒烟）——
   * 表头 `Name,Path,Size,Date Modified`、名字与路径带引号而数字与时间不带、
   * **目录的 Size 是空串**、名字里带逗号时也靠引号包住（这条正是"按逗号切"会切错的地方）。
   */
  function csvFixture(root: string): string {
    return [
      'Name,Path,Size,Date Modified',
      `"admin.ts","${join(root, 'src', 'tools')}",136388,2026/10/5 23:26:09`,
      `"agent-loop.ts","${join(root, 'src', 'runtime')}",82990,2026/10/5 17:26:20`,
      `"comma,name.ts","${join(root, 'src', 'weird')}",1024,2026/10/4 15:29:28`,
      `"tools","${join(root, 'src')}",,2026/10/3 1:02:03`,
    ].join('\r\n');
  }

  it('解析出每条的名称/大小/修改时间，头部给总数与总大小，路径仍是工作根相对', async () => {
    const calls: string[][] = [];
    // 假引擎要回**工作根之下**的路径：relative() 才解得出相对路径（工作根装配时才存在，用引用接上）
    const ws = { root: '' };
    await withHarness(
      async (h) => {
        ws.root = h.root;
        const res = await h.tool('es_search').handler({ pattern: '*.ts', detail: 'full' }, h.ctx);
        assert.equal(res.isError, undefined, res.content);
        assert.match(res.content, /^engine: everything \(es /u, '首行仍是 engine');
        assert.match(res.content, /模式 `\*\.ts` · 命中 4 个/u, `头部要有命中数：\n${res.content}`);
        // 总大小 = 136388 + 82990 + 1024（目录那一行没有大小，不参与）
        assert.match(res.content, /共 215\.2 KB/u, `头部要有总大小：\n${res.content}`);
        // 每条：大小 · 修改时间 · 相对路径
        assert.match(res.content, /133\.2 KB · 2026\/10\/5 23:26:09 · src\/tools\/admin\.ts/u, res.content);
        assert.match(res.content, /81\.0 KB · 2026\/10\/5 17:26:20 · src\/runtime\/agent-loop\.ts/u, res.content);
        // 名字里带逗号的那条：CSV 引号解析对了才可能出现完整名字
        assert.match(res.content, /1\.0 KB · 2026\/10\/4 15:29:28 · src\/weird\/comma,name\.ts/u, res.content);
        // 目录没有大小 → 给 `-`（不编一个 0 B 出来），也不进总大小
        assert.match(res.content, /- · 2026\/10\/3 1:02:03 · src\/tools/u, res.content);
        // 相对路径：绝不能出现工作根的绝对路径
        assert.ok(!res.content.includes(h.root), `路径要相对工作根：\n${res.content}`);
        // 实参里必须有 CSV 那一组（真机上这一组就是"详细信息"的唯一来源）
        const argv = esArgvOf(calls, h.root);
        for (const flag of ['-csv', '-name', '-path-column', '-size', '-size-format', '1', '-date-modified']) {
          assert.ok(argv.includes(flag), `detail:'full' 必须给 ${flag}：${argv.join(' ')}`);
        }
      },
      { everythingPath: 'C:\\fake\\es.exe' },
      { runProcess: makeFakeEs(calls, () => csvFixture(ws.root)) },
    );
  });

  it('无命中时只给表头那一行：命中 0、无数据行、不报错', async () => {
    const calls: string[][] = [];
    await withHarness(
      async (h) => {
        const res = await h.tool('es_search').handler({ pattern: 'zzz', detail: 'full' }, h.ctx);
        assert.equal(res.isError, undefined, res.content);
        assert.match(res.content, /命中 0 个/u);
        assert.match(res.content, /\(无命中\)/u);
        assert.ok(!res.content.includes('共 '), '没有条目就没有"总大小"可给');
      },
      { everythingPath: 'C:\\fake\\es.exe' },
      // 真机上无命中时 es.exe 只回表头一行（实测 S14）
      { runProcess: makeFakeEs(calls, () => 'Name,Path,Size,Date Modified') },
    );
  });

  it("detail:'paths'（默认）仍只列相对路径，不带大小与时间（省上下文的那一档）", async () => {
    const calls: string[][] = [];
    const ws = { root: '' };
    await withHarness(
      async (h) => {
        ws.root = h.root;
        const res = await h.tool('es_search').handler({ pattern: '*.ts' }, h.ctx);
        assert.equal(res.isError, undefined, res.content);
        assert.match(res.content, /src\/alpha\.ts/u);
        assert.match(res.content, /src\/beta\.ts/u);
        // 默认档只列路径：正文行里不许出现 full 档的 `大小 · 时间 · 路径` 形状
        const body = res.content.split(/\n{2,}/u).at(-1) ?? '';
        assert.ok(!body.includes(' · '), `默认档只列路径：\n${res.content}`);
        assert.ok(!res.content.includes(h.root), '路径要相对工作根');
        assert.ok(!esArgvOf(calls, h.root).includes('-csv'), '默认档不该付 CSV 那组开关');
      },
      { everythingPath: 'C:\\fake\\es.exe' },
      {
        // 真机默认档就是"每行一个绝对路径"（实测 S1）
        runProcess: makeFakeEs(calls, () =>
          `${join(ws.root, 'src', 'alpha.ts')}\r\n${join(ws.root, 'src', 'beta.ts')}\r\n`),
      },
    );
  });
});

// ──────────────────────────────── read_blob ────────────────────────────────

describe('read_blob', () => {
  it('按 offset/limit 分页，且给出续读指引', async () => {
    await withHarness(async (h) => {
      const blobId = 'a'.repeat(64);
      const blobs = join(h.root, 'data', 'blobs');
      await mkdir(blobs, { recursive: true });
      await writeFile(join(blobs, blobId), 'ABCDEFGHIJ', 'utf8');

      const page1 = await h.tool('read_blob').handler({ blobId, offset: 0, limit: 4 }, h.ctx);
      assert.equal(page1.isError, undefined);
      assert.match(page1.content, /ABCD/u);
      assert.match(page1.content, /续读：offset=4&limit=4/u);

      const page2 = await h.tool('read_blob').handler({ blobId, offset: 4, limit: 6 }, h.ctx);
      assert.match(page2.content, /EFGHIJ/u);
      assert.match(page2.content, /已到末尾/u);
      assert.ok(!page2.content.includes('续读'));
    });
  });

  it('blobId 格式非法 / blob 不存在 / offset 越界都有明确错误码', async () => {
    await withHarness(async (h) => {
      const bad = await h.tool('read_blob').handler({ blobId: 'zz' }, h.ctx);
      assert.equal(bad.error?.code, FS_ERROR_CODES.INVALID_ARGS);
      assert.ok(BLOB_ID_PATTERN.test('a'.repeat(64)));

      const missing = await h.tool('read_blob').handler({ blobId: 'b'.repeat(64) }, h.ctx);
      assert.equal(missing.error?.code, FS_ERROR_CODES.NOT_FOUND);

      const blobs = join(h.root, 'data', 'blobs');
      await mkdir(blobs, { recursive: true });
      await writeFile(join(blobs, 'c'.repeat(64)), 'short', 'utf8');
      const past = await h.tool('read_blob').handler({ blobId: 'c'.repeat(64), offset: 99 }, h.ctx);
      assert.equal(past.error?.code, FS_ERROR_CODES.INVALID_ARGS);
    });
  });

  it('path 不能逃出 blob 根', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'outside-blob.txt'), 'x', 'utf8');
      const res = await h.tool('read_blob').handler({ path: '../../outside-blob.txt' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.PATH_DENIED);
    });
  });
});

// ──────────────────────────────── safe_edit ────────────────────────────────

describe('safe_edit', () => {
  // 这一组治的是**运行期回执里的死名字**（v42 收尾）：`list_dir` 在 334cf4c 删掉了，
  // 但这句「是目录」的拒绝（`path-guard.ts` 的 NOT_A_FILE 出口，safe_edit / safe_write /
  // multi_edit / read_blob 共用）起初还留着「行为与原来的 list_dir 一致」这种等价说明。
  // 删掉它的理由不是洁癖：她历史里调过 `list_dir` **201 次**，回执里出现这个名字就等于
  // 把那个选项重新摆到她面前——**对模型来说，提到名字就是可选项**，她下一个动作就是再发
  // 一次（然后拿到"未知工具"）。所以这里既锁**正向**措辞，也锁**名字不许回来**。
  describe('目标是目录时的拒绝（v42 收尾：回执里不许再出现 list_dir）', () => {
    it('safe_edit 传目录：拒绝的理由指 safe_read / pwsh，且一个字都不提 list_dir', async () => {
      await withHarness(async (h) => {
        await mkdir(join(h.root, 'pkg'), { recursive: true });
        await writeFile(join(h.root, 'pkg', 'a.ts'), 'const a = 1;\n', 'utf8');

        const res = await h.tool('safe_edit').handler(
          { path: 'pkg', old: 'const a = 1;', new: 'const a = 2;' },
          h.ctx,
        );
        assert.equal(res.isError, true, 'safe_edit 只处理文件，传目录必须拒绝');
        assert.equal(res.error?.code, FS_ERROR_CODES.NOT_A_FILE);

        // 正向：出路要具体到"怎么调"——`safe_read` 收目录，`depth` / `limit` 是它的两个旋钮；
        // 递归 / 隐藏项 / 按修改时间排这三件 safe_read 不做，归 `pwsh` 的 Get-ChildItem。
        for (const [needle, why] of [
          ['是目录', '要说清被拒的是目录这件事本身'],
          ['safe_read', '列目录的出口是 safe_read（传目录即列目录）'],
          ['depth', '递归要看 depth，这个参数名必须说出口'],
          ['limit', '条数上限要看 limit，这个参数名必须说出口'],
          ['Get-ChildItem', '递归/隐藏/按时间排归 pwsh，这三件 safe_read 不做'],
        ] as const) {
          assert.ok(res.content.includes(needle), `回执里必须出现「${needle}」（${why}）：\n${res.content}`);
        }
        // 方向别反了：safe_read 是出路，不是"别用它"
        assert.doesNotMatch(res.content, /别用 safe_read/u);

        // 反向：`list_dir` 已经删了（v42 并入 safe_read），回执里**一个字符都不许有**这名字。
        // 连"与原来的 list_dir 行为一致"这种等价说明也不行——等价说明正是它上次活下来的方式。
        assert.doesNotMatch(
          res.content,
          /list_dir/u,
          '`list_dir` 在 v42 删了、回执里也不许再出现：提到名字就是可选项，她会再发一次拿到"未知工具"',
        );
      });
    });

    it('safe_write 与 multi_edit 共用同一个出口：三条路的拒绝措辞都不含 list_dir', async () => {
      await withHarness(async (h) => {
        await mkdir(join(h.root, 'pkg'), { recursive: true });

        const write = await h.tool('safe_write').handler({ path: 'pkg', content: 'x' }, h.ctx);
        assert.equal(write.error?.code, FS_ERROR_CODES.NOT_A_FILE, write.content);

        const multi = await h.tool('multi_edit').handler(
          { edits: [{ file: 'pkg', old: 'a', new: 'b' }] },
          h.ctx,
        );
        assert.equal(multi.isError, true, multi.content);

        for (const [name, text] of [['safe_write', write.content], ['multi_edit', multi.content]] as const) {
          assert.ok(/是目录/u.test(text), `${name} 要沿用那句"是目录"的拒绝`);
          assert.doesNotMatch(text, /list_dir/u, `${name} 的回执里不许出现已删的 list_dir`);
        }
      });
    });

    it('出口本身（resolveInsideRoot）的 reason 也不含 list_dir（堵住"绕过工具层加回来"）', async () => {
      await withHarness(async (h) => {
        await mkdir(join(h.root, 'pkg'), { recursive: true });
        const guarded = await resolveInsideRoot(h.root, 'pkg', { purpose: 'safe_edit' });
        assert.equal(guarded.ok, false);
        assert.equal(guarded.ok === false ? guarded.code : '', FS_ERROR_CODES.NOT_A_FILE);
        const reason = guarded.ok === false ? guarded.reason : '';
        assert.ok(reason.includes('safe_read'), `理由要指向 safe_read：${reason}`);
        assert.doesNotMatch(reason, /list_dir/u, `出口的 reason 里不许出现已删的 list_dir：${reason}`);
      });
    });
  });

  // ── 行号前缀防呆（v27） ──
  //
  // 这一组锁的是「行号寻址」能用起来的前提：safe_read 的输出带 `  12│ ` 前缀，
  // 模型整段抄进 old 是**必然**会发生的事（实测它抄过一次之后就该一直被兜住）。
  // 没有这层剥除，read 端给了行号反而让编辑端更容易失败——比不给行号更糟。

  it('old/new 都带 safe_read 行号前缀时自动剥除后替换', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
      const res = await h.tool('safe_edit').handler({
        path: 'a.ts',
        old: '   2│ const b = 2;',
        new: '   2│ const b = 42;',
      }, h.ctx);
      assert.equal(res.isError, undefined, res.content);
      assert.match(res.content, /已自动剥除 old\/new 上的 safe_read 行号前缀/u, '要告诉她剥过了');
      assert.equal(await readText(join(h.root, 'a.ts')), 'const a = 1;\nconst b = 42;\n');
    });
  });

  it('new 是模型自己敲的（不带前缀）也照剥 old：剥除只由 old 决定', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
      const res = await h.tool('safe_edit').handler({
        path: 'a.ts',
        old: '   2│ const b = 2;',
        new: 'const b = 42;',
      }, h.ctx);
      assert.equal(res.isError, undefined, res.content);
      assert.equal(await readText(join(h.root, 'a.ts')), 'const a = 1;\nconst b = 42;\n');
    });
  });

  it('多行 old 全带前缀时一起剥（逐行剥，不是只剥第一行）', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'function f() {\n  const y = 2;\n  return y;\n}\n', 'utf8');
      const res = await h.tool('safe_edit').handler({
        path: 'a.ts',
        old: '   2│   const y = 2;\n   3│   return y;',
        new: '   2│   const y = 3;\n   3│   return y;',
      }, h.ctx);
      assert.equal(res.isError, undefined, res.content);
      assert.equal(await readText(join(h.root, 'a.ts')), 'function f() {\n  const y = 3;\n  return y;\n}\n');
    });
  });

  it('文件里**字面**含 `数字│` 的内容：精确匹配优先，一个字节都不剥', async () => {
    // 这是"顺序"那条纪律的回归锁：剥除只在精确匹配失败之后发生。
    // 若把剥除挪到前面，这段本来能精确命中的内容会被改坏。
    await withHarness(async (h) => {
      const original = 'a\n12│ 这是正文的一部分\nb\n';
      await writeFile(join(h.root, 'a.txt'), original, 'utf8');
      const res = await h.tool('safe_edit').handler({
        path: 'a.txt',
        old: '12│ 这是正文的一部分',
        new: '12│ 改过了',
      }, h.ctx);
      assert.equal(res.isError, undefined, res.content);
      assert.ok(!res.content.includes('已自动剥除'), `精确命中就不该走剥除：${res.content}`);
      assert.equal(await readText(join(h.root, 'a.txt')), 'a\n12│ 改过了\nb\n');
    });
  });

  it('只有一部分行带前缀时不剥（宁可不改，也不猜哪些前缀是内容）', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
      const res = await h.tool('safe_edit').handler({
        path: 'a.ts',
        old: '   2│ const b = 2;',
        // new 半带不带：没有判据知道 `const a = 1;` 那行是不是也该带前缀
        new: '   2│ const b = 42;\nconst c = 3;',
      }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.NO_MATCH);
      assert.equal(await readText(join(h.root, 'a.ts')), 'const a = 1;\nconst b = 2;\n', '文件不该被动过');
    });
  });

  it('精确替换并留下备份', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'export const A = 1;\nexport const B = 2;\n', 'utf8');
      const res = await h.tool('safe_edit').handler({ path: 'a.ts', old: 'const B = 2;', new: 'const B = 42;' }, h.ctx);
      assert.equal(res.isError, undefined);
      assert.match(res.content, /精确替换 1 处/u);
      assert.match(res.content, /语法检查通过/u);
      assert.equal(await readText(join(h.root, 'a.ts')), 'export const A = 1;\nexport const B = 42;\n');

      const backups = await listBackups(h.backupDir, h.root, join(h.root, 'a.ts'));
      assert.equal(backups.length, 1);
      const restored = await readFile(backups[0]!.path, 'utf8');
      assert.match(restored, /const B = 2;/u);
    });
  });

  it('多匹配不给 occurrence 时列出全部位置并拒绝', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'const x = 1;\nconst y = 2;\n', 'utf8');
      const res = await h.tool('safe_edit').handler({ path: 'a.ts', old: 'const', new: 'let' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.AMBIGUOUS_MATCH);
      assert.match(res.content, /1:1/u);
      assert.match(res.content, /2:1/u);
      assert.equal(await readText(join(h.root, 'a.ts')), 'const x = 1;\nconst y = 2;\n');
    });
  });

  it('occurrence 与 replace_all 都能消歧', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'const x = 1;\nconst y = 2;\n', 'utf8');
      const one = await h.tool('safe_edit').handler({ path: 'a.ts', old: 'const', new: 'let', occurrence: 2 }, h.ctx);
      assert.equal(one.isError, undefined);
      assert.equal(await readText(join(h.root, 'a.ts')), 'const x = 1;\nlet y = 2;\n');

      const all = await h.tool('safe_edit').handler({ path: 'a.ts', old: 'const', new: 'var', replace_all: true }, h.ctx);
      assert.equal(all.isError, undefined);
      assert.equal(await readText(join(h.root, 'a.ts')), 'var x = 1;\nlet y = 2;\n');
    });
  });

  it('缩进差一到两格时容错命中，并把 new 的缩进校正回文件风格', async () => {
    await withHarness(async (h) => {
      const original = 'function f() {\n    const x = 1;\n    return x;\n}\n';
      await writeFile(join(h.root, 'a.ts'), original, 'utf8');
      // 模型抄来的 old 少了 2 格缩进
      const res = await h.tool('safe_edit').handler(
        { path: 'a.ts', old: '  const x = 1;\n  return x;', new: '  const y = 2;\n  return y;' },
        h.ctx,
      );
      assert.equal(res.isError, undefined);
      assert.match(res.content, /缩进容错替换/u);
      assert.match(res.content, /\+2 格/u);
      assert.equal(await readText(join(h.root, 'a.ts')), 'function f() {\n    const y = 2;\n    return y;\n}\n');
    });
  });

  it('缩进差超过两格不算容错命中', async () => {
    await withHarness(async (h) => {
      const original = 'function f() {\n      const x = 1;\n      return x;\n}\n';
      await writeFile(join(h.root, 'a.ts'), original, 'utf8');
      // 多行 old 且零缩进：精确匹配必然落空，只能靠缩进容错——而 6 格差超出 1-2 格的范围
      const res = await h.tool('safe_edit').handler(
        { path: 'a.ts', old: 'const x = 1;\nreturn x;', new: 'const y = 2;\nreturn y;' },
        h.ctx,
      );
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.NO_MATCH);
      assert.equal(await readText(join(h.root, 'a.ts')), original);
    });
  });

  it('语法检查失败时不落盘（回滚语义：文件保持原样）', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'bad.ts'), 'const ok = 1;\n', 'utf8');
      const res = await h.tool('safe_edit').handler({ path: 'bad.ts', old: 'const ok = 1;', new: 'const ok: = ;' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.SYNTAX_ERROR);
      assert.equal(await readText(join(h.root, 'bad.ts')), 'const ok = 1;\n');
    });
  });

  it('JSON 语法失败也被拦下', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'c.json'), '{\n  "a": 1\n}\n', 'utf8');
      const res = await h.tool('safe_edit').handler({ path: 'c.json', old: '"a": 1', new: '"a": ,' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.SYNTAX_ERROR);
      assert.equal(await readText(join(h.root, 'c.json')), '{\n  "a": 1\n}\n');
    });
  });

  /**
   * **这一条原先钉错了。**
   *
   * 旧断言写的是 `one\ninserted\ntwo\nthree\n`——即 `line:2` = "插到第 2 行**之前**"。
   * 那是本仓库自己的实现，与源仓库 devkit 相反：那边的判据是"插在第 `line` 行**之后**"，
   * 同一入参的结果是 `one\ntwo\ninserted\nthree\n`（`tools/safe_edit.py:96,289-295`，
   * 审计方把那段逐行代入验算过，见 docs/devkit-migration-audit.md §5 第 4 步）。
   * 于是这条断言把"方向反了"锁成了正确行为（同报告 §2 第一行）。
   *
   * 现在判据**取自源仓库**：`line:2` → 落在第 2 行之后；`line:0` → 文件开头；
   * 越界报错（下一条用例）。
   */
  it('insert_at_line 插在第 line 行**之后**（line=0 = 文件开头），delete_lines 按闭区间删', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
      const ins = await h.tool('safe_edit').handler(
        { path: 'a.txt', mode: 'insert_at_line', line: 2, new: 'inserted' },
        h.ctx,
      );
      assert.equal(ins.isError, undefined, ins.content);
      // 源仓库同一入参的结果（方向：之后）
      assert.equal(await readText(join(h.root, 'a.txt')), 'one\ntwo\ninserted\nthree\n');

      // line=0 = 插到文件最前面
      const atTop = await h.tool('safe_edit').handler(
        { path: 'a.txt', mode: 'insert_at_line', line: 0, new: 'header' },
        h.ctx,
      );
      assert.equal(atTop.isError, undefined, atTop.content);
      assert.equal(await readText(join(h.root, 'a.txt')), 'header\none\ntwo\ninserted\nthree\n');

      const del = await h.tool('safe_edit').handler(
        { path: 'a.txt', mode: 'delete_lines', start_line: 1, end_line: 2 },
        h.ctx,
      );
      assert.equal(del.isError, undefined, del.content);
      assert.equal(await readText(join(h.root, 'a.txt')), 'two\ninserted\nthree\n');
    });
  });

  it('文件不存在时指向 safe_write', async () => {
    await withHarness(async (h) => {
      const res = await h.tool('safe_edit').handler({ path: 'nope.ts', old: 'a', new: 'b' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.NOT_FOUND);
      assert.match(res.content, /safe_write/u);
    });
  });

  /**
   * 锁测试：**先删后插 ≠ 替换第 N 行**（2026-10-05，用户点名要摆到明面上）。
   *
   * 为什么要有这一条：两个行模式的方向**不同**，而且两句各自都对——`delete_lines 2-2`
   * 删的是第 2 行（闭区间含两端），`insert_at_line line=2` 插在第 2 行**之后**。
   * 于是最自然的那种写法（"把第 2 行换成新内容"）会**静默错位**：删掉第 2 行之后，
   * 原第 3 行顶上来成了第 2 行，"插在第 2 行之后"就落到了它下面——两次调用都返回成功，
   * 内容却多了一行、位置也错了。这一条把**那对组合的结果**钉死，反例写进断言而不是注释里。
   *
   * 方向**不改**（两句都按 devkit 的 `tools/safe_edit.py` 逐字对齐，改动它等于把核对过的
   * 差异反着改回去）。正路是 `mode: 'replace'` + `old`/`new`：按文本匹配，与行号无关，
   * 也没有"第几行之后"这种话。这条用例的后半段把正路一起钉住。
   */
  it('锁：先 delete_lines 再 insert_at_line 拼不出「替换第 N 行」（反例），替换要走 old/new', async () => {
    await withHarness(async (h) => {
      const file = join(h.root, 'lines.txt');
      const original = 'L1\nL2\nL3\n';
      await writeFile(file, original, 'utf8');

      // ① 反例：她以为的"替换第 2 行" = 删 2-2 再插 line=2
      const del = await h.tool('safe_edit').handler(
        { path: 'lines.txt', mode: 'delete_lines', start_line: 2, end_line: 2 },
        h.ctx,
      );
      assert.equal(del.isError, undefined, del.content);
      assert.equal(await readText(file), 'L1\nL3\n', 'delete_lines 2-2 删的就是第 2 行（含两端）');

      const ins = await h.tool('safe_edit').handler(
        { path: 'lines.txt', mode: 'insert_at_line', line: 2, new: 'NEW' },
        h.ctx,
      );
      assert.equal(ins.isError, undefined, ins.content);
      // 两次都"成功"，结果却是 NEW 落到原第 3 行之后——错位是静默的，这就是这条锁的意义
      assert.equal(await readText(file), 'L1\nL3\nNEW\n', '不是 L1\\nNEW\\nL3\\n：插入方向是"第 N 行之后"');

      // ② 正路：替换第 2 行用 replace + old/new（该行原文抄进 old）
      await writeFile(file, original, 'utf8');
      const rep = await h.tool('safe_edit').handler(
        { path: 'lines.txt', old: 'L2', new: 'NEW' },
        h.ctx,
      );
      assert.equal(rep.isError, undefined, rep.content);
      assert.equal(await readText(file), 'L1\nNEW\nL3\n');

      // ③ 描述里必须把这句话说出来（模型看不到注释，只看得到描述与参数 schema）
      const tool = h.tool('safe_edit');
      assert.match(tool.description, /插第 line 行后/u, 'insert_at_line 的方向要在工具描述里');
      assert.match(tool.description, /含两端/u, 'delete_lines 的闭区间要在工具描述里');
      assert.match(tool.description, /拼不出替换/u, '要明说这两者拼不出替换');
      assert.match(tool.description, /old\/new/u, '要指过去替换的正路');
      // 工具描述被压在 <60 token（tool-catalog.test.ts 的门禁），所以例子与理由落在
      // `mode` 参数的描述里——那一格模型同样每次请求都看得到，而且不占描述预算
      const mode = (tool.parameters['properties'] as Record<string, Record<string, unknown>>)['mode'];
      const modeText = String(mode?.['description'] ?? '');
      assert.match(modeText, /删 2-2 再插 line:2/u, 'mode 描述里要给出那个错位的具体例子');
      assert.match(modeText, /替换第 N 行/u);
    });
  });
});

// ──────────────────────────────── safe_write / safe_rollback ────────────────────────────────

describe('safe_write / safe_rollback', () => {
  it('新建文件会自动创建父目录', async () => {
    await withHarness(async (h) => {
      const res = await h.tool('safe_write').handler(
        { path: 'deep/nested/new.ts', content: 'export const N = 1;\n' },
        h.ctx,
      );
      assert.equal(res.isError, undefined);
      assert.match(res.content, /新建文件/u);
      assert.equal(await readText(join(h.root, 'deep/nested/new.ts')), 'export const N = 1;\n');
    });
  });

  it('语法不合法的内容被拒绝，不产生文件', async () => {
    await withHarness(async (h) => {
      const res = await h.tool('safe_write').handler({ path: 'broken.ts', content: 'const a: = ;' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.SYNTAX_ERROR);
      await assert.rejects(readText(join(h.root, 'broken.ts')));
    });
  });

  /**
   * 覆盖门（A 组之后新修的一条，判据取自源 `tools/safe_write.py:137-161`）。
   *
   * 它挡的是**最贵的那类失误**：模型想"改一部分"，却拿 `safe_write` 把整篇抹掉。
   * 源的做法是**默认不写**，返回 proposal + 现有文件预览 + 明确的下一步；
   * 真要整体覆盖必须显式给 `overwrite: true`。
   */
  it('已存在的文件默认**拒绝整体覆盖**：不写、给预览、说清下一步', async () => {
    await withHarness(async (h) => {
      const original = 'export const A = 1;\nexport const B = 2;\n';
      await writeFile(join(h.root, 'exist.ts'), original, 'utf8');

      const res = await h.tool('safe_write').handler(
        { path: 'exist.ts', content: 'export const ONLY = 9;\n' },
        h.ctx,
      );
      // ① 拒了（而且是"文件已存在"这个理由，不是别的）
      assert.equal(res.isError, true, `已存在文件默认必须拒绝覆盖：${res.content}`);
      assert.equal(res.error?.code, FS_ERROR_CODES.FILE_EXISTS);
      // ② 一个字都没写——这是这条门存在的全部意义
      assert.equal(await readText(join(h.root, 'exist.ts')), original, '拒绝就一个字节都不许动');
      // ③ 说清现状：大小 + 现有内容预览（她要能判断"这是不是我想覆盖的那个文件"）
      assert.match(res.content, /已存在/u);
      assert.match(res.content, /export const A = 1;/u, '要给出**现有内容**的预览');
      // ④ 说清下一步怎么走（两条路都要给：改局部 / 真要整体覆盖）
      assert.match(res.content, /safe_edit/u, '要指向局部修改这条路');
      assert.match(res.content, /overwrite/u, '要告诉她整体覆盖需要显式开关');
    });
  });

  it('给了 overwrite:true 才真覆盖，且覆盖前留备份', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'exist.ts'), 'export const A = 1;\n', 'utf8');
      const res = await h.tool('safe_write').handler(
        { path: 'exist.ts', content: 'export const A = 2;\n', overwrite: true },
        h.ctx,
      );
      assert.equal(res.isError, undefined, res.content);
      assert.equal(await readText(join(h.root, 'exist.ts')), 'export const A = 2;\n');
      assert.match(res.content, /已覆盖/u);

      // 覆盖前留了备份，所以这一步可撤销（与源"会先备份，可回滚"同义）
      const back = await h.tool('safe_rollback').handler({ path: 'exist.ts' }, h.ctx);
      assert.equal(back.isError, undefined, back.content);
      assert.equal(await readText(join(h.root, 'exist.ts')), 'export const A = 1;\n');
    });
  });

  it('overwrite:false 与省略同义；新建文件不受这道门影响', async () => {
    await withHarness(async (h) => {
      // 省略 = 默认 false：拒绝
      await writeFile(join(h.root, 'x.txt'), 'old\n', 'utf8');
      const omitted = await h.tool('safe_write').handler({ path: 'x.txt', content: 'new\n' }, h.ctx);
      assert.equal(omitted.error?.code, FS_ERROR_CODES.FILE_EXISTS);
      // 显式 false：同义
      const explicit = await h.tool('safe_write').handler(
        { path: 'x.txt', content: 'new\n', overwrite: false },
        h.ctx,
      );
      assert.equal(explicit.error?.code, FS_ERROR_CODES.FILE_EXISTS);
      assert.equal(await readText(join(h.root, 'x.txt')), 'old\n');

      // 目标不存在时照旧新建——这道门只挡"覆盖"，不挡"创建"
      const fresh = await h.tool('safe_write').handler({ path: 'fresh.txt', content: 'hi\n' }, h.ctx);
      assert.equal(fresh.isError, undefined, fresh.content);
      assert.equal(await readText(join(h.root, 'fresh.txt')), 'hi\n');
    });
  });

  it('overwrite 不是布尔值时报参数错（描述与实现必须一致）', async () => {
    await withHarness(async (h) => {
      const res = await h.tool('safe_write').handler(
        { path: 'y.txt', content: 'x\n', overwrite: 'yes' },
        h.ctx,
      );
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.INVALID_ARGS);
    });
  });

  /**
   * **这一条原先钉错了。**
   *
   * 旧断言写的是：对**已存在**的 `a.ts` 直接 `safe_write({path, content})` 就覆盖成功
   * （`await h.tool('safe_write').handler({path:'a.ts', content:'…'})` 之后文件变成新内容）。
   * 那是本仓库自己的实现，与源仓库 devkit 相反：那边 `safe_write` 有 `overwrite`
   * （**默认 false**），文件已存在且没给 `overwrite=true` 时**返回 proposal + 现有文件预览，
   * 不写**（`tools/safe_write.py:137-161`、`_registry.py:1755-1759`）。审计把这条判成
   * "S1 覆盖门缺失"并指出断言把它锁死了（docs/devkit-migration-audit.md §1 #3 与 §2）。
   *
   * 现在判据**取自源**：本用例改成显式 `overwrite: true` —— 它要验的本来是
   * "**覆盖**前备份、safe_rollback 能恢复"这条链路，而"默认拒绝覆盖"归下面那条新用例。
   * 给上开关之后，这一条验的东西一个字没变，只是不再依赖"默认就许覆盖"这个错误前提。
   */
  it('覆盖前备份，safe_rollback 能恢复，且回滚本身可回滚（覆盖需显式 overwrite:true）', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'export const V = 1;\n', 'utf8');
      await h.tool('safe_write').handler(
        { path: 'a.ts', content: 'export const V = 2;\n', overwrite: true },
        h.ctx,
      );
      assert.equal(await readText(join(h.root, 'a.ts')), 'export const V = 2;\n');

      const listed = await h.tool('safe_rollback').handler({ path: 'a.ts', list: true }, h.ctx);
      assert.match(listed.content, /备份/u);

      const back = await h.tool('safe_rollback').handler({ path: 'a.ts' }, h.ctx);
      assert.equal(back.isError, undefined);
      assert.equal(await readText(join(h.root, 'a.ts')), 'export const V = 1;\n');
      assert.match(back.content, /已回滚到备份/u);

      // 回滚前的状态被快照，所以还能「回滚回去」
      const again = await h.tool('safe_rollback').handler({ path: 'a.ts' }, h.ctx);
      assert.equal(again.isError, undefined);
      assert.equal(await readText(join(h.root, 'a.ts')), 'export const V = 2;\n');
    });
  });

  it('没有备份时给出可操作的理由', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'fresh.ts'), 'x', 'utf8');
      const res = await h.tool('safe_rollback').handler({ path: 'fresh.ts' }, h.ctx);
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.NO_BACKUP);
      assert.match(res.content, /safe_edit/u);
    });
  });

  it('每文件只保留最近 10 份备份', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.txt'), 'v0\n', 'utf8');
      const tool = h.tool('safe_write');
      for (let i = 1; i <= 15; i++) {
        // 这一条验的是**备份保留策略**（每文件最近 10 份），所以每次都显式覆盖：
        // 覆盖门（默认拒绝覆盖已存在文件）见 safe_write 那组用例。
        const res = await tool.handler({ path: 'a.txt', content: `v${i}\n`, overwrite: true }, h.ctx);
        assert.equal(res.isError, undefined);
      }
      const backups = await listBackups(h.backupDir, h.root, join(h.root, 'a.txt'));
      assert.equal(backups.length, 10);
    });
  });
});

// ──────────────────────────────── multi_edit ────────────────────────────────

describe('multi_edit', () => {
  it('跨文件成功且逐文件报告', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'const oldName = 1;\n', 'utf8');
      await writeFile(join(h.root, 'b.ts'), 'export { oldName };\n', 'utf8');
      const res = await h.tool('multi_edit').handler(
        {
          edits: [
            { file: 'a.ts', old: 'oldName', new: 'newName' },
            { file: 'b.ts', old: 'oldName', new: 'newName' },
          ],
        },
        h.ctx,
      );
      assert.equal(res.isError, undefined);
      assert.match(res.content, /2 处编辑 \/ 2 个文件/u);
      assert.equal(await readText(join(h.root, 'a.ts')), 'const newName = 1;\n');
      assert.equal(await readText(join(h.root, 'b.ts')), 'export { newName };\n');
    });
  });

  it('任一处找不到就一个字节都不写', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'const A = 1;\n', 'utf8');
      await writeFile(join(h.root, 'b.ts'), 'const B = 1;\n', 'utf8');
      const res = await h.tool('multi_edit').handler(
        {
          edits: [
            { file: 'a.ts', old: 'const A', new: 'const Z' },
            { file: 'b.ts', old: 'NOT_PRESENT', new: 'x' },
          ],
        },
        h.ctx,
      );
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.NO_MATCH);
      assert.equal(await readText(join(h.root, 'a.ts')), 'const A = 1;\n');
      assert.equal(await readText(join(h.root, 'b.ts')), 'const B = 1;\n');
    });
  });

  it('任一处语法检查不过就整体不写', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'export const A = 1;\n', 'utf8');
      await writeFile(join(h.root, 'b.ts'), 'export const B = 1;\n', 'utf8');
      const res = await h.tool('multi_edit').handler(
        {
          edits: [
            { file: 'a.ts', old: 'const A = 1;', new: 'const A = 2;' },
            { file: 'b.ts', old: 'const B = 1;', new: 'const B: = 1;' },
          ],
        },
        h.ctx,
      );
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.SYNTAX_ERROR);
      assert.equal(await readText(join(h.root, 'a.ts')), 'export const A = 1;\n');
      assert.equal(await readText(join(h.root, 'b.ts')), 'export const B = 1;\n');
    });
  });

  it('同一文件的多个 edits 按顺序叠加', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
      const res = await h.tool('multi_edit').handler(
        {
          edits: [
            { file: 'a.ts', old: 'const a = 1;', new: 'let a = 1;' },
            { file: 'a.ts', old: 'let a = 1;', new: 'let a = 3;' },
          ],
        },
        h.ctx,
      );
      assert.equal(res.isError, undefined);
      assert.equal(await readText(join(h.root, 'a.ts')), 'let a = 3;\nconst b = 2;\n');
    });
  });

  it('edits 为空或越界文件被拒绝', async () => {
    await withHarness(async (h) => {
      const empty = await h.tool('multi_edit').handler({ edits: [] }, h.ctx);
      assert.equal(empty.error?.code, FS_ERROR_CODES.INVALID_ARGS);
      const escape = await h.tool('multi_edit').handler(
        { edits: [{ file: '../evil.ts', old: 'a', new: 'b' }] },
        h.ctx,
      );
      assert.equal(escape.error?.code, FS_ERROR_CODES.PATH_DENIED);
    });
  });
});

// ──────────────────────────────── 注册契约 ────────────────────────────────

/**
 * 注册契约专用：一个"哪些引擎可用"由参数决定的假管理器。
 *
 * 这两条用例必须在**任意一台机器上**给出同一份清单（本机有没有 rg 是偶然的），
 * 所以探测结果直接给定，既不碰进程也不碰文件系统。
 */
function stubDeps(available: { rg: boolean; es: boolean }): DepsManager {
  return new DepsManager({
    dataDir: join(tmpdir(), 'irmia-stub-deps'),
    probe: async (name) => (available[name as 'rg' | 'es'] === true
      ? {
        name,
        status: 'ready' as const,
        path: `C:\\fake\\${name}.exe`,
        version: name === 'rg' ? '15.1.0' : '1.1.0.38',
        anyVersion: name === 'rg' ? '15.1.0' : '1.1.0.38',
        source: 'config' as const,
        dir: null,
        reason: '',
        attempts: ['test: 固定结论'],
      }
      : {
        name,
        status: 'missing' as const,
        path: '',
        version: '',
        anyVersion: '',
        source: null,
        dir: null,
        reason: `测试：${name} 不可用`,
        attempts: [`test: ${name} 不可用`],
      }),
  });
}

describe('fsTools 注册', () => {
  it('两个引擎都没有时注册六件（rg_search 与 es_search 都不在），且三属性符合 design.md §4.18', async () => {
    const table = new Map<string, ToolDefinition>();
    // 显式注入"两个引擎都没有"的结论：这条用例要在**任意一台机器上**给出同一份清单
    const list = await fsTools(
      { register: (tool) => table.set(tool.name, tool) },
      { deps: stubDeps({ rg: false, es: false }) },
    );
    // v42：`list_dir` 删掉之后常驻八件 → 七件（这里没装引擎，所以是六件）
    assert.deepEqual(
      list.map((tool) => tool.name),
      ['safe_read', 'read_blob', 'safe_edit', 'safe_write', 'safe_rollback', 'multi_edit'],
    );

    const expected: Record<string, [string, string, number]> = {
      safe_read: ['parallel', 'none', 10_000],
      read_blob: ['parallel', 'none', 10_000],
      safe_edit: ['exclusive', 'destructive', 30_000],
      safe_write: ['exclusive', 'destructive', 30_000],
      safe_rollback: ['exclusive', 'destructive', 30_000],
      multi_edit: ['exclusive', 'destructive', 60_000],
    };
    for (const [name, [mode, sideEffect, timeoutMs]] of Object.entries(expected)) {
      const tool = table.get(name);
      assert.ok(tool !== undefined, `${name} 未注册`);
      assert.equal(tool.executionMode, mode, `${name} executionMode`);
      assert.equal(tool.sideEffect, sideEffect, `${name} sideEffect`);
      assert.equal(tool.timeoutMs, timeoutMs, `${name} timeoutMs`);
      assert.equal(tool.parameters['type'], 'object');
      const tokens = estimateTokens(tool.description);
      assert.ok(tokens <= MAX_DESCRIPTION_TOKENS, `${name} 描述 ${tokens} token 超过预算`);
    }
  });

  it('装齐两个引擎时是八件，且两件搜索工具各自插在原位置（顺序即缓存前缀）', async () => {
    const table = new Map<string, ToolDefinition>();
    const list = await fsTools(
      { register: (tool) => table.set(tool.name, tool) },
      { deps: stubDeps({ rg: true, es: true }) },
    );
    assert.deepEqual(
      list.map((tool) => tool.name),
      ['safe_read', 'rg_search', 'es_search', 'read_blob', 'safe_edit', 'safe_write', 'safe_rollback', 'multi_edit'],
    );
    for (const name of ['rg_search', 'es_search']) {
      const tool = table.get(name);
      assert.equal(tool?.executionMode, 'parallel', `${name} executionMode`);
      assert.equal(tool?.timeoutMs, 15_000, `${name} timeoutMs`);
      assert.equal(tool?.sideEffect, 'none', `${name} sideEffect`);
    }
  });

  it('只有 rg 时是七件：条件注册是逐件的，不互相连坐', async () => {
    const table = new Map<string, ToolDefinition>();
    const list = await fsTools(
      { register: (tool) => table.set(tool.name, tool) },
      { deps: stubDeps({ rg: true, es: false }) },
    );
    assert.deepEqual(
      list.map((tool) => tool.name),
      ['safe_read', 'rg_search', 'read_blob', 'safe_edit', 'safe_write', 'safe_rollback', 'multi_edit'],
    );
  });

  it('条件注册的"不出现"会如实告知（onNote 收到理由，而不是静默少一件）', async () => {
    const notes: string[] = [];
    const table = new Map<string, ToolDefinition>();
    await fsTools(
      { register: (tool) => table.set(tool.name, tool) },
      { deps: stubDeps({ rg: false, es: false }), onNote: (line) => notes.push(line) },
    );
    // 装配期还会打一条"路径别名指向哪"（P1）——这里只关心**条件注册**那两条，
    // 所以按内容筛，而不是按条数（条数会随装配期多说一句实话而变化）
    const missing = notes.filter((line) => /未注册/u.test(line));
    assert.equal(missing.length, 2, `应当两条告知（rg 与 es 各一条），实际 ${JSON.stringify(notes)}`);
    assert.match(missing[0] ?? '', /rg_search 未注册/u);
    assert.match(missing[1] ?? '', /es_search 未注册/u);
  });

  it('enableDestructive=false 时只注册只读工具（M4-4 的注册层前提）', async () => {
    const table = new Map<string, ToolDefinition>();
    const list = await fsTools(
      { register: (tool) => table.set(tool.name, tool) },
      { deps: stubDeps({ rg: true, es: true }) },
      {},
      { enableDestructive: false },
    );
    assert.equal(list.length, 4);
    assert.ok(list.every((tool) => tool.sideEffect !== 'destructive'));
  });

  it('createEnv 从 workspaceRoot 推导数据目录', async () => {
    const root = join(tmpdir(), 'irmia-env-check');
    const env = createEnv({ dataDir: join(root, 'data') }, { now: () => new Date(0) });
    assert.equal(env.dataDir({ workspaceRoot: root }), join(root, 'data'));
    assert.equal(env.maxReadLines, 2000);
  });

  it('createEnv 从数据目录推导别名表：三个前缀各指向自己的根', async () => {
    const root = join(tmpdir(), 'irmia-env-alias');
    const env = createEnv({ dataDir: join(root, 'data') }, { now: () => new Date(0) });
    const aliases = env.pathAliases({ workspaceRoot: root });
    assert.deepEqual(
      aliases.map((a) => [a.prefix, a.root]),
      [
        ['MEMORIES', join(root, 'data', 'workspace', 'MEMORIES')],
        ['diary', join(root, 'data', 'workspace', 'diary')],
        ['persona', join(root, 'data', 'persona')],
      ],
    );
    // 别名表**刻意不含 workspace/**：仓库根真的有一个同名目录（http_download 的落点），
    // 别名它会制造歧义——那个问题归"描述说清根在哪"，不归别名表。
    assert.equal(aliases.some((a) => a.prefix.toLowerCase() === 'workspace'), false);
  });

  it('别名：首段命中且主根没有这个目标时才改写', async () => {
    const root = join(tmpdir(), 'irmia-alias-pure');
    const aliases = [{ prefix: 'MEMORIES', root: join(root, 'data', 'workspace', 'MEMORIES') }];

    assert.equal(firstSegmentOf('MEMORIES/facts.md'), 'MEMORIES');
    assert.equal(firstSegmentOf('MEMORIES'), 'MEMORIES');
    assert.equal(firstSegmentOf('facts.md'), 'facts.md');

    // 主根下没有 `MEMORIES/facts.md` ⇒ 落到别名根
    assert.equal(
      expandAliases('MEMORIES/facts.md', aliases, root),
      join(root, 'data', 'workspace', 'MEMORIES', 'facts.md'),
    );
    // 只有首段时改写就是别名根本身
    assert.equal(expandAliases('MEMORIES', aliases, root), join(root, 'data', 'workspace', 'MEMORIES'));
    // 首段不匹配：原样返回（`MEMORIES-old/` 这种兄弟名不许被误伤）
    assert.equal(expandAliases('MEMORIES-old/facts.md', aliases, root), 'MEMORIES-old/facts.md');
    assert.equal(expandAliases('notes/facts.md', aliases, root), 'notes/facts.md');
    // 绝对路径与空输入原样返回
    assert.equal(expandAliases(join(root, 'MEMORIES', 'facts.md'), aliases, root), join(root, 'MEMORIES', 'facts.md'));
    assert.equal(expandAliases('', aliases, root), '');
    // `.` / `..` 开头的相对路径不参与别名
    assert.equal(expandAliases('./MEMORIES/facts.md', aliases, root), './MEMORIES/facts.md');
    assert.equal(expandAliases('../MEMORIES/facts.md', aliases, root), '../MEMORIES/facts.md');
  });

  it('别名：主根下真的存在同名目标时一个字都不改（主根优先，别名不劫持）', async () => {
    await withHarness(async (h) => {
      // 主根里真的建一份 MEMORIES/：它必须赢，别名不许抢
      await mkdir(join(h.root, 'MEMORIES'), { recursive: true });
      await writeFile(join(h.root, 'MEMORIES', 'facts.md'), '主根那份\n', 'utf8');
      await mkdir(join(h.root, 'data', 'workspace', 'MEMORIES'), { recursive: true });
      await writeFile(join(h.root, 'data', 'workspace', 'MEMORIES', 'facts.md'), '别名那份\n', 'utf8');

      const env = createEnv({ dataDir: join(h.root, 'data') }, { now: () => new Date(0) });
      const aliases = env.pathAliases(h.ctx);
      assert.equal(expandAliases('MEMORIES/facts.md', aliases, h.root), 'MEMORIES/facts.md');

      const result = await h.tool('safe_read').handler({ path: 'MEMORIES/facts.md' }, h.ctx);
      assert.equal(result.isError, undefined);
      assert.match(result.content, /主根那份/u);
    });
  });

  it('safe_read 短前缀 MEMORIES/ 读到记忆文件（记忆索引里那条指针的写法）', async () => {
    await withHarness(async (h) => {
      const memoryDir = join(h.root, 'data', 'workspace', 'MEMORIES');
      await mkdir(memoryDir, { recursive: true });
      await writeFile(join(memoryDir, 'facts.md'), '# facts\n- 一条事实\n', 'utf8');

      // 索引里写的是 `MEMORIES/facts.md:9`；这里按同一写法取
      const result = await h.tool('safe_read').handler({ path: 'MEMORIES/facts.md' }, h.ctx);
      assert.equal(result.isError, undefined, `短前缀应当解析得到，实际：${result.content}`);
      assert.match(result.content, /一条事实/u);
      // 回执显示的相对路径是**主根**口径（可追溯、与日志里别的路径同一套写法）
      assert.match(result.content, /data[\\/]workspace[\\/]MEMORIES[\\/]facts\.md/u);
    });
  });

  it('safe_read 短前缀 MEMORIES 列出记忆目录（v42：列目录并进 safe_read）', async () => {
    await withHarness(async (h) => {
      const memoryDir = join(h.root, 'data', 'workspace', 'MEMORIES');
      await mkdir(memoryDir, { recursive: true });
      await writeFile(join(memoryDir, 'facts.md'), 'x\n', 'utf8');

      const result = await h.tool('safe_read').handler({ path: 'MEMORIES' }, h.ctx);
      assert.equal(result.isError, undefined, `短前缀应当解析得到，实际：${result.content}`);
      assert.match(result.content, /facts\.md/u);
    });
  });

  it('safe_edit 短前缀 persona/STATE.md 改到数据目录下的人格资产', async () => {
    await withHarness(async (h) => {
      const personaDir = join(h.root, 'data', 'persona');
      await mkdir(personaDir, { recursive: true });
      await writeFile(join(personaDir, 'STATE.md'), '# 状态\n心情：还行\n', 'utf8');

      const result = await h.tool('safe_edit').handler(
        { path: 'persona/STATE.md', old: '心情：还行', new: '心情：不错' },
        h.ctx,
      );
      assert.equal(result.isError, undefined, `短前缀应当解析得到，实际：${result.content}`);
      assert.equal(await readFile(join(personaDir, 'STATE.md'), 'utf8'), '# 状态\n心情：不错\n');
    });
  });

  it('safe_write 短前缀 MEMORIES/ 能在记忆目录下新建文件（allowMissing 那条路）', async () => {
    await withHarness(async (h) => {
      await mkdir(join(h.root, 'data', 'workspace', 'MEMORIES'), { recursive: true });
      const result = await h.tool('safe_write').handler(
        { path: 'MEMORIES/note.md', content: '新写的一笔\n' },
        h.ctx,
      );
      assert.equal(result.isError, undefined, `短前缀应当解析得到，实际：${result.content}`);
      assert.equal(
        await readFile(join(h.root, 'data', 'workspace', 'MEMORIES', 'note.md'), 'utf8'),
        '新写的一笔\n',
      );
    });
  });

  it('完整前缀 data/workspace/MEMORIES/ 照旧解析到主根（别名不参与）', async () => {
    await withHarness(async (h) => {
      const memoryDir = join(h.root, 'data', 'workspace', 'MEMORIES');
      await mkdir(memoryDir, { recursive: true });
      await writeFile(join(memoryDir, 'facts.md'), '完整前缀这一份\n', 'utf8');

      const env = createEnv({ dataDir: join(h.root, 'data') }, { now: () => new Date(0) });
      const full = 'data/workspace/MEMORIES/facts.md';
      assert.equal(expandAliases(full, env.pathAliases(h.ctx), h.root), full, '首段是 data，不该被改写');

      const result = await h.tool('safe_read').handler({ path: full }, h.ctx);
      assert.equal(result.isError, undefined);
      assert.match(result.content, /完整前缀这一份/u);
    });
  });

  it('别名不是绕过口：从别名根往上爬出主根仍然被拒', async () => {
    await withHarness(async (h) => {
      await mkdir(join(h.root, 'data', 'workspace', 'MEMORIES'), { recursive: true });
      // 别名改写之后仍要过白名单：爬出主根的路径一律拒绝（与直写 `..` 同一条判据）
      const escape = `MEMORIES/${'../'.repeat(20)}definitely-outside.txt`;
      const result = await h.tool('safe_read').handler({ path: escape }, h.ctx);
      assert.equal(result.isError, true, '爬出主根必须被拒');
      assert.match(result.content, /落在工作目录/u);
    });
  });

  it('两件搜索工具也走别名（短前缀的搜索范围同样解析得到）', async () => {
    await withHarness(async (h) => {
      const memoryDir = join(h.root, 'data', 'workspace', 'MEMORIES');
      await mkdir(memoryDir, { recursive: true });
      await writeFile(join(memoryDir, 'facts.md'), '- 别名里的独门词\n', 'utf8');

      // 只验"路径过得去"这一层：引擎本身在别的用例里测（这台机器上不一定装了 rg）
      const env = createEnv({ dataDir: join(h.root, 'data') }, { now: () => new Date(0) });
      const rewritten = expandAliases('MEMORIES', env.pathAliases(h.ctx), h.root);
      assert.equal(rewritten, memoryDir);
      const guarded = await resolveInsideRoot(h.root, rewritten, { purpose: 'rg_search', requireDirectory: true });
      assert.equal(guarded.ok, true, `别名改写后的路径应当过守卫：${JSON.stringify(guarded)}`);
    });
  });

  it('编码枚举覆盖设计里承诺的集合', async () => {
    const encodings: DetectedEncoding[] = ['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'gbk', 'latin1'];
    assert.equal(encodings.length, 6);
  });
});

// ──────────────────────────────── 大文件：数据丢失的防线 ────────────────────────────────

/**
 * A 组 #1（最严重的一条）：**16MB 静默截断**。
 *
 * 旧实现 `readTargetFile` 只读前 16 MiB 且**无任何标记**，然后把截断后的内容整篇写回。
 * 实测 17,825,826 字节的文件做一次 `safe_edit` → 落盘 16,777,216 字节，丢 1,048,610
 * 字节，全程 `isError=false`（docs/devkit-migration-audit.md §1 #1）。源仓库的判据是
 * "超过 `SAFE_EDIT_MAX_SIZE`（20MB）**直接拒绝**，一个字节不碰"。
 *
 * 这一组用例的**核心断言是"文件字节数不变"**——不是"返回了错误"。因为这条 bug 的
 * 危害恰恰在于"返回得像个成功"：只断言 isError 的话，一个"先截断再报错"的实现照样能过。
 * 上限经 `FsEnv.maxEditBytes` 收到 4 KiB，测的是**同一条代码路径**（20 MiB 只是默认参数值），
 * 不必在测试里造 20 MB 文件。
 */
describe('大文件防线：超上限一律拒绝，且一个字节都不动', () => {
  const SMALL_LIMIT = { maxEditBytes: 4096 };

  /** 造一个"超上限"的文本文件：合法 TS（语法检查不会先拦住它），字节数确定 */
  function oversizeContent(): string {
    return `export const BIG = 1;\n// ${'z'.repeat(6000)}\n`;
  }

  it('safe_edit / safe_write / multi_edit 全部拒绝，文件字节数不变', async () => {
    await withHarness(async (h) => {
      const content = oversizeContent();
      const target = join(h.root, 'big.ts');
      await writeFile(target, content, 'utf8');
      const before = await readFile(target);

      const edit = await h.tool('safe_edit').handler(
        { path: 'big.ts', old: 'BIG = 1', new: 'BIG = 2' },
        h.ctx,
      );
      assert.equal(edit.isError, true, 'safe_edit 必须拒绝');
      assert.equal(edit.error?.code, FS_ERROR_CODES.TOO_LARGE);
      assert.equal(await readFile(target, 'utf8'), content, 'safe_edit 之后文件内容必须一个字不变');

      // 覆盖门（见下面那组用例）会先于体积门拦下"已存在且没给 overwrite"的调用，
      // 所以这里显式给 overwrite:true —— 这一条要验的是**体积门**，不是覆盖门。
      const write = await h.tool('safe_write').handler(
        { path: 'big.ts', content: 'small\n', overwrite: true },
        h.ctx,
      );
      assert.equal(write.isError, true, 'safe_write 必须拒绝');
      assert.equal(write.error?.code, FS_ERROR_CODES.TOO_LARGE);
      assert.equal(await readFile(target, 'utf8'), content, 'safe_write 之后文件内容必须一个字不变');

      const multi = await h.tool('multi_edit').handler(
        { edits: [{ file: 'big.ts', old: 'BIG = 1', new: 'BIG = 3' }] },
        h.ctx,
      );
      assert.equal(multi.isError, true, 'multi_edit 必须拒绝');
      assert.equal(multi.error?.code, FS_ERROR_CODES.TOO_LARGE);
      assert.equal(await readFile(target, 'utf8'), content, 'multi_edit 之后文件内容必须一个字不变');

      // 最后一层：整份字节流逐字节相同（上面三条是文本比较，这条是字节比较）
      assert.deepEqual(await readFile(target), before, '字节数必须一个不差');
      assert.equal((await readFile(target)).length, Buffer.byteLength(content, 'utf8'));
    }, SMALL_LIMIT);
  });

  it('拒绝消息给全三件事：多大、上限多少、可以怎么做', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'big.ts'), oversizeContent(), 'utf8');
      const res = await h.tool('safe_edit').handler({ path: 'big.ts', old: 'BIG = 1', new: 'x' }, h.ctx);
      assert.equal(res.isError, true);
      // ① 文件多大 ② 上限多少 ③ 可以怎么做——三件缺一不可，否则模型会"再试一次"
      assert.match(res.content, /有 \d+(\.\d+)? (B|KB|MB)/u, '要说清文件多大');
      assert.match(res.content, /上限 \d+(\.\d+)? (B|KB|MB)/u, '要说清上限多少');
      assert.match(res.content, /一个字节都没动/u, '要说清没有发生任何写入');
      assert.match(res.content, /可以怎么做/u, '要给下一步的路');
    }, SMALL_LIMIT);
  });

  it('刚好等于上限的文件照常放行（门是"超过"，不是"达到"）', async () => {
    await withHarness(async (h) => {
      const body = 'export const OK = 1;\n';
      // 用注释补齐到**正好** 4096 字节
      const pad = 4096 - Buffer.byteLength(`${body}// \n`, 'utf8');
      const content = `${body}// ${'p'.repeat(pad)}\n`;
      assert.equal(Buffer.byteLength(content, 'utf8'), 4096, '构造必须精确等于上限');
      await writeFile(join(h.root, 'exact.ts'), content, 'utf8');
      const res = await h.tool('safe_edit').handler({ path: 'exact.ts', old: 'OK = 1', new: 'OK = 2' }, h.ctx);
      assert.equal(res.isError, undefined, `正好等于上限不该被拒：${res.content}`);
      assert.match(await readFile(join(h.root, 'exact.ts'), 'utf8'), /OK = 2/u);
    }, SMALL_LIMIT);
  });

  it('写入端也有一道门：改小文件但结果超上限时拒绝', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'small.txt'), 'seed\n', 'utf8');
      // 目标文件很小（读得过），但**这次要写进去的内容**超限——这道门挡的是这种情况。
      // 同样显式给 overwrite:true，免得覆盖门先把它拦掉（那样验的就不是体积门了）。
      const res = await h.tool('safe_write').handler(
        { path: 'small.txt', content: 'q'.repeat(5000), overwrite: true },
        h.ctx,
      );
      assert.equal(res.isError, true);
      assert.equal(res.error?.code, FS_ERROR_CODES.TOO_LARGE);
      assert.equal(await readFile(join(h.root, 'small.txt'), 'utf8'), 'seed\n', '原文件必须一个字不变');
    }, SMALL_LIMIT);
  });
});

// ──────────────────────────────── 参数契约与默认值（照源对齐） ────────────────────────────────

/**
 * A 组 #2 / #4 / #5 / #6 的判据集中在这里。每条的**期望值都取自源仓库**
 * （devkit，逐条注了源码位置），不是"改成当前实现的样子"。
 */
describe('参数契约与默认值（照 devkit 对齐）', () => {
  it('越界一律报错，不静默夹取：insert_at_line 的 line / delete_lines 的两端', async () => {
    await withHarness(async (h) => {
      // 造一个**合法 TS** 的目标文件：语法检查在越界校验之后才跑，但用 .txt 更直接
      await writeFile(join(h.root, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
      const unchanged = 'one\ntwo\nthree\n';

      // insert_at_line：0 ≤ line ≤ 总行数（源 safe_edit.py:243-251）
      const insOver = await h.tool('safe_edit').handler(
        { path: 'a.txt', mode: 'insert_at_line', line: 99, new: 'x' },
        h.ctx,
      );
      assert.equal(insOver.isError, true, 'line=99 于 3 行文件必须报错，不能追加到末尾');
      assert.equal(insOver.error?.code, FS_ERROR_CODES.INVALID_ARGS);
      assert.match(insOver.content, /0 ≤ line ≤ 3/u, '错误里要写清合法范围');
      assert.equal(await readText(join(h.root, 'a.txt')), unchanged, '报错就不能动文件');

      const insNeg = await h.tool('safe_edit').handler(
        { path: 'a.txt', mode: 'insert_at_line', line: -1, new: 'x' },
        h.ctx,
      );
      assert.equal(insNeg.isError, true, 'line 为负必须报错');
      assert.equal(await readText(join(h.root, 'a.txt')), unchanged);

      // delete_lines：1 ≤ start_line ≤ end_line ≤ 总行数（源 safe_edit.py:252-263）
      const delOver = await h.tool('safe_edit').handler(
        { path: 'a.txt', mode: 'delete_lines', start_line: 1, end_line: 99 },
        h.ctx,
      );
      assert.equal(delOver.isError, true, 'end_line 越界必须报错，不能"删到文件末尾为止"');
      assert.equal(delOver.error?.code, FS_ERROR_CODES.INVALID_ARGS);
      assert.match(delOver.content, /1 ≤ start_line ≤ end_line ≤ 3/u, '错误里要写清合法范围');
      assert.equal(await readText(join(h.root, 'a.txt')), unchanged, '报错就不能动文件');

      const delZero = await h.tool('safe_edit').handler(
        { path: 'a.txt', mode: 'delete_lines', start_line: 0, end_line: 1 },
        h.ctx,
      );
      assert.equal(delZero.isError, true, 'start_line=0 必须报错（行号是 1-based）');
      assert.equal(await readText(join(h.root, 'a.txt')), unchanged);

      // 边界内的两个方向都要真的能用（不是"一律报错"）
      const insLast = await h.tool('safe_edit').handler(
        { path: 'a.txt', mode: 'insert_at_line', line: 3, new: 'tail' },
        h.ctx,
      );
      assert.equal(insLast.isError, undefined, insLast.content);
      assert.equal(await readText(join(h.root, 'a.txt')), 'one\ntwo\nthree\ntail\n');

      const delAll = await h.tool('safe_edit').handler(
        { path: 'a.txt', mode: 'delete_lines', start_line: 1, end_line: 4 },
        h.ctx,
      );
      assert.equal(delAll.isError, undefined, delAll.content);
      assert.equal(await readText(join(h.root, 'a.txt')), '');
    });
  });

  it('occurrence:0 合法（= 未指定）；replace_all 与 occurrence 同时给则报错', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.txt'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n', 'utf8');

      // occurrence=0 合法：devkit 的 schema 把 `default: 0` 写明了（_registry.py:211-215），
      // 模型照默认值回填 occurrence:0 时不该当场失败（旧实现报"必须是 >= 1 的整数"）。
      // 语义 = "没指定" → 落到"多处匹配则要求消歧"那条既有判据上，而不是静默替换第一处。
      const zero = await h.tool('safe_edit').handler(
        { path: 'a.txt', old: 'const', new: 'let', occurrence: 0 },
        h.ctx,
      );
      assert.equal(zero.isError, true, 'occurrence:0 = 未指定；三处匹配时必须要求消歧');
      assert.equal(zero.error?.code, FS_ERROR_CODES.AMBIGUOUS_MATCH, `实际：${zero.content}`);

      // occurrence 为负数才是非法
      const negative = await h.tool('safe_edit').handler(
        { path: 'a.txt', old: 'const', new: 'let', occurrence: -1 },
        h.ctx,
      );
      assert.equal(negative.isError, true);
      assert.equal(negative.error?.code, FS_ERROR_CODES.INVALID_ARGS);

      // occurrence 与 replace_all 互斥（源 safe_edit.py:183-189）。
      // 旧实现**静默按 replace_all 执行、occurrence 被丢掉**，而描述里写着"互斥"
      // （审计 §1 #13 实测：{replace_all:true, occurrence:9} 成功替换全部 3 处）。
      const both = await h.tool('safe_edit').handler(
        { path: 'a.txt', old: 'const', new: 'let', replace_all: true, occurrence: 9 },
        h.ctx,
      );
      assert.equal(both.isError, true, '两个口径同时给必须报错，不能静默全替换');
      assert.equal(both.error?.code, FS_ERROR_CODES.INVALID_ARGS);
      assert.match(both.content, /不能同时使用/u);
      assert.equal(
        await readText(join(h.root, 'a.txt')),
        'const a = 1;\nconst b = 2;\nconst c = 3;\n',
        '报错就不能动文件',
      );

      // 但 occurrence:0（= 未指定）与 replace_all 并存**不算**冲突：它没在"指定第几处"
      const zeroPlusAll = await h.tool('safe_edit').handler(
        { path: 'a.txt', old: 'const', new: 'let', replace_all: true, occurrence: 0 },
        h.ctx,
      );
      assert.equal(zeroPlusAll.isError, undefined, `occurrence:0 只是"未指定"：${zeroPlusAll.content}`);
      assert.equal(await readText(join(h.root, 'a.txt')), 'let a = 1;\nlet b = 2;\nlet c = 3;\n');
    });
  });

  it('multi_edit 也收 occurrence:0，并同样拒绝 occurrence + replace_all', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.txt'), 'only-one\n', 'utf8');
      const zero = await h.tool('multi_edit').handler(
        { edits: [{ file: 'a.txt', old: 'only-one', new: 'changed', occurrence: 0 }] },
        h.ctx,
      );
      assert.equal(zero.isError, undefined, `occurrence:0 在 multi_edit 里也该合法：${zero.content}`);
      assert.equal(await readText(join(h.root, 'a.txt')), 'changed\n');

      const both = await h.tool('multi_edit').handler(
        { edits: [{ file: 'a.txt', old: 'changed', new: 'x', replace_all: true, occurrence: 2 }] },
        h.ctx,
      );
      assert.equal(both.isError, true);
      assert.equal(both.error?.code, FS_ERROR_CODES.INVALID_ARGS);
      assert.equal(await readText(join(h.root, 'a.txt')), 'changed\n');
    });
  });

  it('safe_read 的 offset:0 表示"从头"（不是参数错误）', async () => {
    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.txt'), 'l1\nl2\nl3\n', 'utf8');
      // devkit 的 start_line 默认 0、0 表示从头（_registry.py:1194-1263）。
      // 本地 offset 是行号（1-based），旧实现 offset:0 直接 E_INVALID_ARGS——
      // 同一个意思在两处一个合法一个报错，是纯心智负担。现在 0 归一成 1。
      const zero = await h.tool('safe_read').handler({ path: 'a.txt', offset: 0 }, h.ctx);
      assert.equal(zero.isError, undefined, `offset:0 不该是参数错误：${zero.content}`);
      assert.match(zero.content, /   1│ l1/u, 'offset:0 必须等价于从第 1 行开始');

      const one = await h.tool('safe_read').handler({ path: 'a.txt', offset: 1 }, h.ctx);
      assert.equal(one.content, zero.content, 'offset:0 与 offset:1 的输出必须逐字节一致');

      const negative = await h.tool('safe_read').handler({ path: 'a.txt', offset: -1 }, h.ctx);
      assert.equal(negative.isError, true, '负数仍然非法');
    });
  });

  it('safe_read 列目录默认不列隐藏条目（v42：要看隐藏项走 pwsh 的 Get-ChildItem）', async () => {
    await withHarness(async (h) => {
      await mkdir(join(h.root, 'proj'), { recursive: true });
      await writeFile(join(h.root, 'proj', 'visible.txt'), 'v', 'utf8');
      await writeFile(join(h.root, 'proj', '.secret'), 's', 'utf8');
      await writeFile(join(h.root, 'proj', '.env'), 'E=1', 'utf8');

      // 源 dir_list 是 show_hidden 默认 False（tools/dir_list.py:11-13）；审计实测
      // 本地旧默认把 `.secret` 直接列出来（§1 #28）。v42 并进 safe_read 之后**默认值不变**，
      // 但 `include_hidden` 那个开关没跟着搬过来（它 201 次里只用了 8 次）——
      // 要看隐藏项的出口是 `pwsh` 的 `Get-ChildItem -Force`（截断指路里也写了）。
      const def = await h.tool('safe_read').handler({ path: 'proj' }, h.ctx);
      assert.match(def.content, /visible\.txt/u);
      assert.ok(!def.content.includes('.secret'), `默认不该列隐藏文件：\n${def.content}`);
      assert.ok(!def.content.includes('.env'), `默认不该列隐藏文件：\n${def.content}`);
      // 隐藏项确实在盘上（不是"文件不存在"造成的假绿）
      assert.equal(await readFile(join(h.root, 'proj', '.secret'), 'utf8'), 's');
    });
  });

  /**
   * rg_search 的两个默认值（都照源）：
   * - `context` 默认 **0**（源 `tools/rg_search.py:278` 的 `context_lines` 默认 0）；
   * - 大小写默认 **不区分**（源 `case_sensitive` 默认 false，`_registry.py:583-605`）。
   *   本条同时锁**参数名**：本地旧名 `ignore_case` 默认 false = 区分大小写，方向正好相反。
   */
  it('rg_search 默认不区分大小写、context 默认 0；case_sensitive:true 才区分', async () => {
    const calls: string[][] = [];
    const fakeRg = async (command: string, args: string[]): Promise<{
      code: number | null; stdout: string; stderr: string; failed: boolean; timedOut: boolean;
    }> => {
      calls.push([command, ...args]);
      if (args.includes('--version')) {
        return { code: 0, stdout: 'ripgrep 15.1.0 (fake)\n', stderr: '', failed: false, timedOut: false };
      }
      return { code: 1, stdout: '', stderr: '', failed: false, timedOut: false }; // 1 = 无命中
    };

    await withHarness(async (h) => {
      await writeFile(join(h.root, 'a.ts'), 'const Foo = 1;\n', 'utf8');

      const def = await h.tool('rg_search').handler({ pattern: 'Foo' }, h.ctx);
      assert.equal(def.isError, undefined, def.content);
      const defArgs = calls.at(-1) ?? [];
      assert.ok(defArgs.includes('--ignore-case'), `默认必须不区分大小写：${defArgs.join(' ')}`);
      assert.equal(defArgs[defArgs.indexOf('--context') + 1], '0', 'context 默认必须是 0');
      assert.match(def.content, /忽略大小写/u, '首行标注要如实说这次是不敏感还是敏感');
      const schema = h.tool('rg_search').parameters['properties'] as Record<string, unknown>;
      assert.equal('ignore_case' in schema, false, '旧名 ignore_case 要收掉（两套读法正是歧义来源）');
      assert.equal('case_sensitive' in schema, true);

      const sensitive = await h.tool('rg_search').handler({ pattern: 'Foo', case_sensitive: true }, h.ctx);
      assert.equal(sensitive.isError, undefined, sensitive.content);
      const sensArgs = calls.at(-1) ?? [];
      assert.ok(!sensArgs.includes('--ignore-case'), `case_sensitive:true 时不能加 --ignore-case：${sensArgs.join(' ')}`);
      assert.match(sensitive.content, /区分大小写/u);
    }, { ripgrepPath: 'C:\\fake\\rg.exe' }, { runProcess: fakeRg });
  });

  it('rg_search 的 max_results 默认 40（源口径），截断提示随之', async () => {
    // 假引擎要回**真实存在**的文件：解析那一步会对每个路径做 relative(workspaceRoot, …)，
    // 编一个不存在的名字会得到工作区外的路径，命中数就恒为 0（那样测的就不是上限了）
    const ws = { root: '' };
    const fakeRg = async (_command: string, args: string[]): Promise<{
      code: number | null; stdout: string; stderr: string; failed: boolean; timedOut: boolean;
    }> => {
      if (args.includes('--version')) {
        return { code: 0, stdout: 'ripgrep 15.1.0 (fake)\n', stderr: '', failed: false, timedOut: false };
      }
      const file = join(ws.root, 'a.ts');
      const out = Array.from({ length: 60 }, (_, i) => `${file}\u0000${i + 1}:hit`).join('\n');
      return { code: 0, stdout: `${out}\n`, stderr: '', failed: false, timedOut: false };
    };
    await withHarness(async (h) => {
      ws.root = h.root;
      await writeFile(join(h.root, 'a.ts'), 'hit\n', 'utf8');
      const res = await h.tool('rg_search').handler({ pattern: 'hit' }, h.ctx);
      assert.equal(res.isError, undefined, res.content);
      // 60 条命中、默认上限 40 → 20 条被截掉，并且**要说出来**
      assert.match(res.content, /\[已达上限 40/u, `默认上限必须是 40：\n${res.content.slice(0, 400)}`);
      // 命中块首行形如 `a.ts:12:1: hit`；用行内 `hit$` 锚定，避免数到上下文行
      const listed = res.content.split('\n').filter((line) => /^a\.ts:\d+:\d+: hit$/u.test(line)).length;
      assert.equal(listed, 40, `只该列 40 条，实际 ${listed}`);
    }, { ripgrepPath: 'C:\\fake\\rg.exe' }, { runProcess: fakeRg });
  });

  it('es_search 的 max_results:0 = 只报数量不列条目（源语义），且不加 -n', async () => {
    const calls: string[][] = [];
    const ws = { root: '' };
    const fakeEs = async (command: string, args: string[]): Promise<Record<string, unknown>> => {
      calls.push([command, ...args]);
      if (args.includes('-version')) {
        return { code: 0, stdout: '1.1.0.27', stderr: '', failed: false, timedOut: false };
      }
      return {
        code: 0,
        stdout: `${join(ws.root, 'src', 'alpha.ts')}\r\n${join(ws.root, 'src', 'beta.ts')}\r\n`,
        stderr: '',
        failed: false,
        timedOut: false,
      };
    };
    await withHarness(async (h) => {
      ws.root = h.root;
      await mkdir(join(h.root, 'src'), { recursive: true });
      await writeFile(join(h.root, 'src', 'alpha.ts'), 'x', 'utf8');
      await writeFile(join(h.root, 'src', 'beta.ts'), 'x', 'utf8');

      const counted = await h.tool('es_search').handler({ pattern: '*.ts', max_results: 0 }, h.ctx);
      assert.equal(counted.isError, undefined, counted.content);
      assert.match(counted.content, /命中 2 个/u, '要报数量');
      assert.ok(!counted.content.includes('alpha.ts'), `只统计就不该列条目：\n${counted.content}`);
      assert.ok(!counted.content.includes(h.root), '更不该把绝对路径列出来');
      const countArgs = calls.at(-1) ?? [];
      assert.ok(!countArgs.includes('-n'), `max_results:0 时不该给 -n（源同判据）：${countArgs.join(' ')}`);
      // 0 = 只要数量：`detail:'full'` 那组 CSV 开关也不该付（一条都不列，CSV 解析纯属白干）
      assert.ok(!countArgs.includes('-csv'), `max_results:0 时不该付 CSV 那组：${countArgs.join(' ')}`);
      assert.equal(
        (await h.tool('es_search').handler({ pattern: '*.ts', max_results: 0, detail: 'full' }, h.ctx)).content,
        counted.content,
        'max_results:0 时 detail 不改变输出（只统计这一档没有"详细"可言）',
      );

      const listed = await h.tool('es_search').handler({ pattern: '*.ts' }, h.ctx);
      assert.match(listed.content, /src\/alpha\.ts/u, '默认（不传 max_results）照旧列条目');
      const listArgs = calls.at(-1) ?? [];
      assert.equal(listArgs[listArgs.indexOf('-n') + 1], '100', '默认值保持 100（与源同值）');
    }, { everythingPath: 'C:\\fake\\es.exe' }, { runProcess: fakeEs });
  });
});
