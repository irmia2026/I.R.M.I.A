/**
 * Irmia Agent — 文件系工具包：搜索两件（grep / find）
 *
 * **两件都是条件注册的**（v30）：探测到引擎才把这件工具造出来，没有就不注册。
 *
 * 这条口径是用户拍的：**外部依赖由框架强制安装**（GUI 里一键装、装不了就显式提示），
 * 于是"引擎缺失"是一个**已经被告知过的环境状态**，不再需要工具层面的降级链——
 * "因为强制安装了依赖，那么可以删掉降级链了"。删掉的收益不只是少一段代码：
 * 一件"永远降级"的工具比没有这件工具更糟，模型会先想到它，然后每次都以
 * "引擎调用失败"开场，白烧一次调用与一份常驻 token（v27 对 find 的实测：
 * 5 次调用全部 fallback）。grep 这一轮补上同一条口径。
 *
 * 它原先的降级是"TS 逐行扫描"（v27 之前 find 也有一份，那时已删）。那个 fallback
 * 的坏处更隐蔽：它让"降级"看起来像成功——**同一件工具、同一种结果形状、换了个引擎**，
 * 模型完全看不出这次搜索是全盘扫出来的（慢、且不受 .gitignore 约束），
 * 于是也没人会想到去装 ripgrep。宁可它不出现。
 *
 * **但"没有时如实告知"保留**：工具不出现是注册层面的事，不能静默消失得无声无息。
 * 启动日志里会写一条（`buildFsTools` 的 onNote，见 fs/index.ts），
 * `GET /api/deps` 与设置页「外部依赖」卡片也会说清"没装 rg 会怎样 + 怎么装"。
 *
 * grep 的输出解析基于 rg 的 `--null`：路径与行内容之间是 NUL 字节，
 * 于是「Windows 路径里的 `C:\` 冒号」与「匹配文本里的冒号」都不再是歧义源。
 * 实测输出形状（rg 15.1.0）：
 *     .\a.txt<NUL>2:foo one      ← 匹配行：<行号>:<文本>
 *     .\a.txt<NUL>1-alpha        ← 上下文行：<行号>-<文本>
 * 列号不由 rg 提供，改由本模块在匹配文本上重跑一次匹配算出来，避免依赖
 * `--column` 那种「上下文行没有列号」的不对称格式。
 *
 * find 的参数取自 voidtools 官方 CLI 文档，并且**每一条都在本机 es.exe 1.1.0.38
 * 上真机冒烟过**（命令形状与实测输出见 docs/tools-audit.md §8.3）：
 *   `-n <num>` 限制结果数、`-path <path>` 限定目录、`-p` 全路径匹配、
 *   `-r <regex>` 正则、`-w` 全词、`/ad` 只目录、`/a-d` 只文件、
 *   `-sort <键>` 排序、`-csv -name -path-column -size -size-format 1 -date-modified` 详细输出。
 *
 * **关于大小写（同一个开关的两个名字，别再来一个人以为谁写错了）**：es.exe 的帮助里写的是
 *   `-i, -case  Match case`——**两个名字是同一个开关**，语义都是「区分大小写」，
 *   与 rg 的 `-i`（忽略大小写）**方向相反**。所以本工具只保留一个入参 `ignore_case`（默认 true），
 *   它为 false（= 要区分大小写）时才追加 `-i`（写成 `-case` 完全等价，实测两者行为一致）。
 *   参数名、默认值、语义与 devkit 一致，不需要兼容层，也不改名。
 *
 * 退出码 8 = Everything IPC 窗口不存在（客户端没在跑）——**如实报错，不降级**：
 * 工具既然是因为探测到引擎才注册的，静默走一遍全盘扫描只会让她以为索引还有效。
 * 另有两条实测出来的退出码：4 = `-sort` 的值不认（`Error 4: Unknown sort: bogus`）、
 * 6 = 不认识的开关（`Error 6: Unknown switch.`）——前者我们在本地就校验掉，后者不该出现。
 *
 * ──────────────────────── 真机实测的两条 es.exe 解析规则（别踩） ────────────────────────
 * ① **一个 argv 元素 = 一个搜索词**。元素里带空格不会被拆成两个词，而是被当成**整句短语**
 *    （实测：`['has space']` 命中 `has space here.txt`，`['has','space']` 命中的是
 *    `hast-util-whitespace` 那类「两个词分别都在名字里」的文件）。
 *    推论：devkit 把 `ext:<值>` 拼成 `"ext:ts <query>"` **一个** argv 送出去，
 *    Everything 收到的是短语，`ext:` 不再是过滤器 —— 实测 `['ext:ts attachment']` **0 命中**。
 *    所以本实现在这里**有意偏离 devkit 的字面写法**：`ext:<值>` 自己一个 argv 元素
 *    （`['ext:ts','attachment']` → 1 命中）。拼不拼的判据与 devkit 一致（只在非 regex 时拼）。
 * ② **`-r` 必须紧挨着模式串**。`-r` 与模式之间夹任何东西（包括 `--`）都会让正则不生效：
 *    实测 `['-r','--','index\.ts$']` 与 `['--','-r','index\.ts$']` 都是 0 命中，
 *    而 `['-r','index\.ts$']` 命中 `index.ts`。`--`（结束选项，保护以 `-`/`/` 开头的模式）
 *    因此只用在**非正则**那条路上：`['ext:ts','--','attachment']` 正常，`['--','-foo']` 不报错。
 */

import { relative } from 'node:path';

import { PATH_HINT } from '../boundary.ts';
import { effectiveBoundaryRoot } from '../boundary.ts';
import type { FsEnv } from './env.ts';
import { resolveGuarded } from './env.ts';
import { buildMatcher } from './search-core.ts';
import { formatBytes } from './text-codec.ts';
import {
  ABORTED_RESULT,
  FS_ERROR_CODES,
  argsObject,
  fail,
  invalidArgs,
  ok,
  readOptionalBool,
  readOptionalInt,
  readOptionalString,
  readString,
  type ProcessResult,
  type ToolContext,
  type ToolDefinition,
} from './types.ts';

/** rg 的 max-filesize 默认值：8MB（单文件超过它就是"这不是源码"，跳过比读进来强） */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

// ──────────────────────────────── 公共结果形状 ────────────────────────────────

interface SearchHit {
  relPath: string;
  line: number;
  column: number;
  text: string;
  contextBefore: Array<{ line: number; text: string }>;
  contextAfter: Array<{ line: number; text: string }>;
}

function renderHits(hits: readonly SearchHit[], engineLabel: string, header: string): string {
  if (hits.length === 0) return `${engineLabel}\n${header}\n(无命中)`;
  const maxLine = hits.reduce((max, hit) => {
    const boundary = Math.max(hit.line, ...hit.contextAfter.map((c) => c.line), ...hit.contextBefore.map((c) => c.line));
    return Math.max(max, boundary);
  }, 1);
  const width = String(maxLine).length;
  const blocks = hits.map((hit) => {
    const rows: string[] = [`${hit.relPath}:${hit.line}:${hit.column}: ${hit.text}`];
    for (const ctx of hit.contextBefore) {
      rows.push(`  ${String(ctx.line).padStart(width, ' ')}| ${ctx.text}`);
    }
    rows.push(`  ${String(hit.line).padStart(width, ' ')}: ${hit.text}`);
    for (const ctx of hit.contextAfter) {
      rows.push(`  ${String(ctx.line).padStart(width, ' ')}| ${ctx.text}`);
    }
    return rows.join('\n');
  });
  return `${engineLabel}\n${header}\n\n${blocks.join('\n\n')}`;
}

function truncationNote(shown: number, limit: number): string {
  return shown >= limit ? `\n[已达上限 ${limit}：缩小 pattern、加 path/glob 或用更精确的正则]` : '';
}

/**
 * 引擎输出不是 UTF-8 时**必须说出来**的那一句（正常路径返回空串，一个字节都不多说）。
 *
 * 为什么搜索工具也要说：`rg` 把命中行的**原始字节**原样写到 stdout 里，中文 Windows 上
 * 那个文件很可能就是 GBK。整段输出按 GB18030 解出来时，命中内容是对的、而同一个缓冲区里
 * 的 UTF-8 路径会跟着一起被当成 GB18030——她看到的路径可能不是原文。**说出来比装作没事好**。
 */
function decodeNote(result: ProcessResult): string {
  const decoded = result.decode;
  if (decoded === undefined || decoded.encoding === 'utf8') return '';
  const loss = decoded.lossy ? `，其中 ${decoded.replaced} 个字符无法映射` : '';
  return `\n[编码] 引擎输出不是 UTF-8，已按 ${decoded.encoding} 解码${loss}：`
    + '上面的路径/内容里非 ASCII 部分可能与原文不同形（字节没丢，是同一份字节的另一种解读）。';
}

// ──────────────────────────────── 引擎探测结论 ────────────────────────────────

/**
 * 探测结论（由 `src/deps/` 给出）。`available` 为假时调用方**不注册**这件工具。
 *
 * 与 v27 的 `EsSearchProbeGate` 是同一个东西，只是把它从本文件搬到了框架层：
 * 结论与分派仍然是同一份判断（不会出现"注册了但一调就降级"），
 * 但"哪几个候选、什么顺序、用户指没指路径"这些事现在只有 `src/deps/probe.ts` 知道。
 */
export interface SearchEngineGate {
  available: boolean;
  /** 探测认定的可执行文件（可能是完整路径）；不可用时为空串 */
  command: string;
  /** 引擎版本标签（写进结果首行，便于排障） */
  label: string;
  /** 不可用的原因（启动日志与报告用的人话） */
  reason: string;
}

/**
 * 把依赖探测结论翻译成搜索工具的闸门结论。
 * 只吃需要的四个字段（而不是整个 `DepProbeResult`）：调用方手里可能是
 * `DependencyProbeOutcome`（管理器给的，多几个字段），少一层搬运就少一处漂移。
 */
export function searchGateOf(
  probe: { ok: boolean; path: string; version: string; reason: string },
  label: string,
): SearchEngineGate {
  if (probe.ok) {
    return {
      available: true,
      command: probe.path,
      label: `${label} ${probe.version}`.trim(),
      reason: '',
    };
  }
  return { available: false, command: '', label: '', reason: probe.reason };
}

// ──────────────────────────────── grep ────────────────────────────────

/** 解析 rg --null 输出。任何解析不了的行都丢掉，绝不让格式细节把整次搜索变成错误 */
function parseRgNullOutput(stdout: string, root: string, fallbackPath: string): SearchHit[] {
  const hits: SearchHit[] = [];
  // 上下文缓冲：同一文件的连续行先攒着，遇到匹配行再分配到前后
  interface Pending {
    file: string;
    line: number;
    text: string;
    isMatch: boolean;
  }
  const pending: Pending[] = [];

  const flush = (): void => {
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i] as Pending;
      if (!item.isMatch) continue;
      const before: Array<{ line: number; text: string }> = [];
      for (let j = i - 1; j >= 0 && pending[j]?.isMatch === false; j--) {
        const ctx = pending[j] as Pending;
        before.unshift({ line: ctx.line, text: ctx.text });
      }
      const after: Array<{ line: number; text: string }> = [];
      for (let j = i + 1; j < pending.length && pending[j]?.isMatch === false; j++) {
        const ctx = pending[j] as Pending;
        after.push({ line: ctx.line, text: ctx.text });
      }
      hits.push({
        relPath: item.file,
        line: item.line,
        column: 1,
        text: item.text,
        contextBefore: before,
        contextAfter: after,
      });
    }
    pending.length = 0;
  };

  for (const rawLine of stdout.split(/\r?\n/u)) {
    if (rawLine === '') continue;
    if (rawLine === '--') {
      flush();
      continue;
    }
    const nul = rawLine.indexOf('\0');
    let file: string;
    let rest: string;
    if (nul === -1) {
      // 单文件搜索时 rg 可能省略文件名（已加 -H，这里是兜底）
      file = fallbackPath;
      rest = rawLine;
    } else {
      file = rawLine.slice(0, nul);
      rest = rawLine.slice(nul + 1);
    }
    const parsed = /^(\d+)([:-])(.*)$/u.exec(rest);
    if (parsed === null) continue;
    const lineNo = Number(parsed[1]);
    const isMatch = parsed[2] === ':';
    const text = parsed[3] ?? '';
    const pendingFile = relative(root, file).replaceAll('\\', '/');
    const last = pending[pending.length - 1];
    if (last !== undefined && last.file !== pendingFile) flush();
    pending.push({ file: pendingFile, line: lineNo, text, isMatch });
  }
  flush();
  return hits;
}

export function createGrepTool(env: FsEnv, gate: SearchEngineGate): ToolDefinition {
  return {
    // 名字：`grep` → **`grep`**（用户 2026-10-13 的裁决「名字不误导，desc 才算」那一批）。
    // 与 `find` 成对：`grep` 按**内容**、`find` 按**文件名**——这两个动词她本来就熟，
    // 而旧名 `grep` 把引擎名写进了工具名（换个引擎就该改名，名字也就跟着骗人）。
    name: 'grep',
    // path 那句是 P3 的正面修法：描述说清"文件也吃得下"，她就不必先猜对工具。
    // 实测依据：11 次把文件路径喂进来、被"不是目录"挡回去（docs/tools-audit.md §2.2），
    // 而 `rg` 本来就吃文件操作数——挡它的是我们自己多要的那一道 requireDirectory。
    //
    // 描述口径（用户 2026-10-13：「agent 应该看到 desc 之后就立马知道它是做什么的」）：
    // 第一句＝**动作 + 对象**；然后三件写清——**范围/默认**（仓库根，可用 path 换）、
    // **路径按什么算**（相对仓库根）、**最容易踩错的那条边界**（默认不区分大小写）。
    // **不解释实现**：原来那句"由 ripgrep 引擎执行"删掉了（引擎名对"它做什么"没有帮助）。
    description:
      '用 ripgrep 搜文件内容（不是文件名）。给目录递归搜、给文件只搜它（路径相对仓库根）；'
      + '默认不区分大小写（要区分传 case_sensitive）；定位后用 safe_read 读区间。'
      // v64（她的实测，本机复核过）：`rg` **不做编码嗅探** ⇒ 非 UTF-8（GBK 等）的文件搜不到
      // ——`0 命中`不等于`没有`。用户的裁决：**不追平**（给 rg 加逐文件嗅探代价大、收益低），写明真相即可。
      // ⚠ 长度：这一件贴着**单件 100 token 的预算**（`MAX_DESCRIPTION_TOKENS`）——写短句，别展开。
      + '只搜 UTF-8：非 UTF-8 文件搜不到，0 命中不等于没有。' + PATH_HINT + '。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式（默认）或字面量（fixed_strings=true）' },
        path: { type: 'string', description: '搜索范围：目录（递归）或单个文件；默认仓库根' },
        glob: { type: 'string', description: '文件名过滤，如 "*.ts" 或 "src/**/*.{ts,js}"；多个用逗号分隔' },
        context: { type: 'integer', description: '每条命中前后各带几行上下文，默认 0，上限 20' },
        max_results: { type: 'integer', description: '最多返回多少条命中，默认 40' },
        // 边界那条：默认值写在这里，描述**只**说"要区分就传 true"（不再拿引擎名做参照物）
        case_sensitive: { type: 'boolean', description: '区分大小写，默认 false' },
        fixed_strings: { type: 'boolean', description: '把 pattern 当字面量而不是正则，默认 false' },
        max_file_bytes: { type: 'integer', description: '跳过大于该字节数的文件，默认 8388608' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    executionMode: 'parallel',
    sideEffect: 'none',
    timeoutMs: 15_000,
    async handler(rawArgs: unknown, ctx: ToolContext) {
      const args = argsObject(rawArgs, 'grep');
      if (args === null) return invalidArgs('grep', '期望一个对象，例如 {"pattern": "TODO", "glob": "*.ts"}');
      const pattern = readString(args, 'pattern');
      if (pattern === null || pattern === '') return invalidArgs('grep', '缺少 pattern');

      const ctxRes = readOptionalInt(args, 'context', 0, 20);
      if ('error' in ctxRes) return invalidArgs('grep', ctxRes.error);
      const maxRes = readOptionalInt(args, 'max_results', 1, 1000);
      if ('error' in maxRes) return invalidArgs('grep', maxRes.error);
      const sizeRes = readOptionalInt(args, 'max_file_bytes', 1024, 512 * 1024 * 1024);
      if ('error' in sizeRes) return invalidArgs('grep', sizeRes.error);
      const contextLines = ctxRes.value ?? 0;
      const maxResults = maxRes.value ?? 40;
      const maxFileBytes = sizeRes.value ?? MAX_FILE_BYTES;
      // 参数名与默认值都照 devkit：那边是 `case_sensitive`，默认 false = **不区分大小写**
      // （`_registry.py:583-605`、`tools/rg_search.py:244-252`）。旧实现是 `ignore_case`
      // 默认 false = 区分大小写，方向正好相反——默认值翻转会**静默改变召回**，
      // 所以这里连参数名一起换成源的名字：`case_sensitive` 的默认值写在名字里（false 即"不敏感"），
      // 而 `ignore_case` 这个名字配 false 读起来像"不忽略=敏感"，两套读法都有理，正是要消除的歧义。
      const caseSensitive = readOptionalBool(args, 'case_sensitive') ?? false;
      const ignoreCase = !caseSensitive;
      const fixedStrings = readOptionalBool(args, 'fixed_strings') ?? false;
      const globArg = readOptionalString(args, 'glob');

      const pathInput = readOptionalString(args, 'path') ?? '.';
      // **目录与单个文件都收**（P3）：传目录照旧递归搜，传文件就只搜那一个文件——
      // 这正是 rg 的基本用法，`--with-filename` 已经在，单文件的命中照样带文件名。
      // 旧口径要的是 `requireDirectory: true`（只收目录），把"文件操作数"整个挡在门外：
      // 实测 11 次传文件被拒，占它 16 次失败里的 11 次（docs/tools-audit.md §2.2）。
      const target = await resolveGuarded(env, ctx, pathInput, {
        purpose: 'grep',
        access: 'read',
        allowDirectory: true,
      });
      if (!target.ok) return fail(target.code, target.reason);
      const searchRoot = target.path;

      const matcherResult = buildMatcher(pattern, { ignoreCase, fixedStrings });
      if ('error' in matcherResult) return invalidArgs('grep', matcherResult.error);
      const matcher = matcherResult.matcher;
      if (ctx.signal.aborted) return ABORTED_RESULT;

      const globs = globArg === undefined ? [] : globArg.split(',').map((g) => g.trim()).filter((g) => g !== '');
      const rgArgs = [
        '--line-number',
        '--no-heading',
        '--with-filename',
        '--null',
        '--color', 'never',
        '--context', String(contextLines),
        '--max-filesize', String(maxFileBytes),
        '--no-messages',
      ];
      if (ignoreCase) rgArgs.push('--ignore-case');
      if (fixedStrings) rgArgs.push('--fixed-strings');
      for (const glob of globs) rgArgs.push('--glob', glob);
      rgArgs.push('--', pattern, searchRoot);

      const result: ProcessResult = await env.deps.runProcess(gate.command, rgArgs, {
        timeoutMs: 14_000,
        signal: ctx.signal,
      });
      if (ctx.signal.aborted) return ABORTED_RESULT;

      // 退出码 0=有命中，1=无命中，2=出错。出错**不再降级**（v30 删掉了 TS 扫描那条路）：
      // 工具是因为探测到引擎才注册的，这时换成"我们自己扫一遍"只会让结果换个来源而看不出来。
      // 如实报错 + 给出路（装/修 ripgrep），比一个换了引擎的"成功"结果诚实。
      if (result.timedOut || (result.failed && result.code === null) || (result.code !== 0 && result.code !== 1)) {
        const why = result.timedOut
          ? '调用超时'
          : result.failed && result.code === null
            ? result.stderr.trim() || '无法启动'
            : result.stderr.trim() || `退出码 ${result.code ?? 'null'}`;
        return fail(
          FS_ERROR_CODES.SEARCH_FAILED,
          `ripgrep 未返回结果：${why}（引擎 ${gate.command}）。`
          + '请确认它在设置页「外部依赖」里显示为已就绪；按文件名找用 find，'
          + '或先 safe_read 那个目录看结构（传目录即列目录）。',
        );
      }

      const hits = parseRgNullOutput(result.stdout, ctx.workspaceRoot, searchRoot);
      for (const hit of hits) {
        const hit2 = matcher(hit.text);
        hit.column = hit2 === null ? 1 : hit2.index + 1;
      }
      const limited = hits.slice(0, maxResults);
      const engine = `engine: ripgrep (${gate.label})`;
      const header =
        `模式 ${'`'}${pattern}${'`'} · 命中 ${hits.length} 处 / 文件 ${new Set(hits.map((h) => h.relPath)).size} 个 · ` +
        `context=${contextLines}${ignoreCase ? ' · 忽略大小写' : ' · 区分大小写'}${fixedStrings ? ' · 字面量' : ''}`;
      return ok(renderHits(limited, engine, header) + truncationNote(limited.length, maxResults) + decodeNote(result));
    },
  };
}

// ──────────────────────────────── find ────────────────────────────────

/**
 * `sort_by` → es.exe `-sort <键>` 的映射表，**逐键照抄 devkit**（`tools/es_search.py:30-39`
 * 的 `SORT_MAP`）：`ext` 在 es.exe 那边叫 `extension`、`date_*` 是 `date-*` 连字符写法、
 * `run_count` 是 `run-count`。8 个键与 8 个值都在本机 es.exe 1.1.0.38 上真机冒烟过
 * （值不认时 es.exe 退 4 并打印 `Error 4: Unknown sort: <值>`）。
 *
 * 这张表是**唯一**的翻译处：参数值用下划线（模型侧好读、与 devkit 的入参同名），
 * 实参值用 es.exe 的拼法。别在别处再写一遍这两个名字。
 */
const ES_SORT_MAP = {
  name: 'name',
  path: 'path',
  size: 'size',
  ext: 'extension',
  date_created: 'date-created',
  date_modified: 'date-modified',
  date_accessed: 'date-accessed',
  run_count: 'run-count',
} as const;

type EsSortBy = keyof typeof ES_SORT_MAP;

const ES_SORT_KEYS = Object.keys(ES_SORT_MAP) as EsSortBy[];

/** `file_type` 三态 → es.exe 的属性开关；`all` 不加任何属性过滤（devkit `tools/es_search.py:260-263`） */
const ES_FILE_TYPES = ['all', 'file', 'folder'] as const;

const ES_DETAILS = ['paths', 'full'] as const;
type EsDetail = (typeof ES_DETAILS)[number];

/**
 * `detail:'full'` 的 CSV 列块（devkit `tools/es_search.py:279-289` 逐字同款）。
 * `-size-format 1` = 字节数（实测：`-size-format 0` 也回字节，但写明 1 才是契约）。
 * 实测表头恰好是 `Name,Path,Size,Date Modified`；**目录的 Size 是空串**（不是 0），
 * 所以解析时空串必须当 0 —— 否则 `Number('')` 那种写法会把目录算成"有大小"。
 */
const ES_CSV_ARGS = ['-csv', '-name', '-path-column', '-size', '-size-format', '1', '-date-modified'] as const;

/** 读一个枚举字符串参数（照 `readOptionalInt` 的形状：非法时给一句带合法取值的说明） */
function readOptionalEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): { value: T | undefined } | { error: string } {
  const raw = args[key];
  if (raw === undefined || raw === null) return { value: undefined };
  if (typeof raw !== 'string') return { error: `${key} 必须是字符串，合法取值：${allowed.join(' / ')}` };
  const hit = allowed.find((item) => item === raw);
  if (hit === undefined) {
    return { error: `${key} 只能是 ${allowed.join(' / ')}，实际 ${JSON.stringify(raw)}` };
  }
  return { value: hit };
}

interface EsCsvItem {
  /** `Name` 列（文件名或目录名） */
  name: string;
  /** `Path` 列（所在目录，绝对路径） */
  dir: string;
  /** `Size` 列（字节；目录是空串 → 0） */
  size: number;
  /** `Size` 列是否真有值：目录是空串（实测），渲染时给 `-` 而不是编一个 `0 B` */
  sizeKnown: boolean;
  /** `Date Modified` 列（es.exe 原样给的本地时间串） */
  dateModified: string;
}

/**
 * 极简 CSV 解析（零依赖）：es.exe 的 `-csv` 只在**需要时**给字段加引号
 * （实测 `"index.ts","D:\…\src\tools\fs",11280,2026/10/4 15:29:28`：名字与路径带引号，
 * 数字与时间不带），所以"按逗号切"一定会在路径含逗号时切错。这里按 RFC4180 处理引号、
 * `""` 转义与 CRLF，够用且不必引依赖。
 */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let hasField = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
        continue;
      }
      field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      hasField = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      hasField = true;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      hasField = false;
      continue;
    }
    if (ch === '\r') continue;
    field += ch;
    hasField = true;
  }
  if (hasField || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * `-get-result-count` 的输出解成一个数（**认不出给 `null`**，调用方回落"数行数"那条老路）。
 *
 * 为什么加它（v64）：全盘成了默认范围之后，`max_results:0` 那条路原来靠"把全部命中行出来再数"
 * ——`*.md` 实测 74,527 行 / 431ms；引擎自带的计数器只回一个数，**189ms**。老版本 es.exe 没有
 * 这个开关（它会报错或回一句别的话）⇒ 判据是"整段输出就是一个非负整数"，否则回落。
 */
function parseEsCount(stdout: string): number | null {
  const text = stdout.trim();
  if (!/^\d+$/u.test(text)) return null;
  return Number(text);
}

/**
 * 把 `-csv` 输出解成结构化条目。**按表头认列**（而不是按位置猜）：es.exe 版本之间的列序
 * 或列名若有变化，这里会退回位置序，不会把 Size 当时间用。第一行是表头，要吃掉。
 */
function parseEsCsv(stdout: string): EsCsvItem[] {
  const rows = parseCsvRows(stdout).filter((row) => row.some((cell) => cell.trim() !== ''));
  if (rows.length === 0) return [];
  const header = (rows[0] as string[]).map((cell) => cell.trim().toLowerCase());
  const idx = {
    name: header.indexOf('name'),
    dir: header.indexOf('path'),
    size: header.indexOf('size'),
    date: header.indexOf('date modified'),
  };
  // 表头不是我们认识的那一行（没有 Name/Path）：那第一行就是数据，用位置序兜底
  const known = idx.name !== -1 && idx.dir !== -1;
  const items: EsCsvItem[] = [];
  for (const row of known ? rows.slice(1) : rows) {
    const name = (row[known ? idx.name : 0] ?? '').trim();
    const dir = (row[known ? idx.dir : 1] ?? '').trim();
    const rawSize = (row[known ? idx.size : 2] ?? '').trim();
    const parsedSize = Number.parseInt(rawSize, 10);
    items.push({
      name,
      dir,
      // 目录的 Size 是空串（实测）→ 0；非数字也当 0，绝不让一列脏数据把整次搜索变成错误
      size: Number.isNaN(parsedSize) ? 0 : parsedSize,
      sizeKnown: rawSize !== '' && !Number.isNaN(parsedSize),
      dateModified: (row[known ? idx.date : 3] ?? '').trim(),
    });
  }
  return items;
}

/** 条目 → 工作根相对的展示路径（与 `detail:'paths'` 同一条口径：`\`→`/`） */
function esItemPath(item: EsCsvItem, root: string): string {
  const full = item.dir === '' ? item.name : `${item.dir}\\${item.name}`;
  return relative(root, full).replaceAll('\\', '/');
}

/**
 * 这一件（当时的名字是 `es_search`）的探测闸门在 v27 就有了（当时是本文件里的 `createEsSearchProbeGate`），
 * v30 把它交给了框架层：候选清单与三段顺序（用户指定 → 自装目录 → PATH）现在只有
 * `src/deps/probe.ts` 一处知道，本文件只拿结论。上一版那 5 个候选**串行各一次 ENOENT**
 * 的代价（review v27 的 Σ-5）也随之消失——探测只做一次，结论在工具之间共享。
 *
 * handler 直接照 `gate` 分派、不再探第二次：注册结论与运行行为必须一致，
 * 否则会出现"注册时说有、执行时说没有"的自相矛盾两句话。
 *
 * 参数面按用户的验收口径**对齐 devkit 那一件**（那边还叫 `es_search`：`_devkit-open\tools\es_search.py`）：
 * `regex` / `whole_word` / `file_type` / `ext` / `sort_by` / `detail` 六项补齐后，
 * 这边能拿到的信息**不低于**那边（那边一次调用固定回结构化条目 name/path/full/size/date_modified
 * + count + total_size；这边 `detail:'full'` 同样给全，`detail:'paths'` 是省上下文的默认档）。
 */
export function createFindTool(env: FsEnv, gate: SearchEngineGate): ToolDefinition {
  return {
    // 名字：`find` → **`find`**（用户 2026-10-13 的裁决「名字不误导，desc 才算」那一批）。
    // 与 `grep` 成对：`find` 按**文件名**、`grep` 按**内容**（`find` 本来就是"找文件"的动词）。
    name: 'find',
    /**
     * **描述口径（v74 重写，2026-10-20 深夜；用户转述她自己的话：「find 的用法我也当着面认了错，
     * 真跑了十几次把参数摸清」）**。
     *
     * **依据（不是感觉，是她自己那 26 次 `tool/call name=find` 的现场）**：
     *   · turn 2932.1 / 2936.1：只传 `{ext:'ts'}` 不传 `pattern` ⇒ `参数非法——缺少 pattern`（两次）；
     *   · turn 2917.4/5：传 `type:'folder'`（该参数叫 **`file_type`**）⇒ 参数被静默忽略，
     *     她在"只要目录"的语义下拿到的是文件；
     *   · turn 2936.5：把**文件**传给 `path` ⇒ 报错才知道 find 只吃目录（要按内容搜得用 grep）；
     *   · turn 2908.2 / 2930.2 / 2931.1 / 2936.x：十几次用**绝对路径**（`C:\…` / `D:\…`）——
     *     而旧描述那句"限定范围传 path（**相对仓库根**）"是误导：绝对路径一直是对的；
     *   · turn 2930.1：用 `max_results:0` 只问数量（这条得留着，它是省上下文的正解）。
     *
     * **改法（重写，不是追加）**：第一句把分工写死（`find` 按**文件名**＝glob；`grep` 按**内容**＝rg
     * 那一档）；随后只留**会出错/会静默错**的四条：`pattern` 必填（只给 `ext` 会报错）、正则的
     * **括弧分支静默 0 命中**（v64 实测过的真坑）、`path` 可绝对、只吃目录、`file_type`（**不叫
     * `type`**）、`max_results=0` 只报数量；末尾**一行示例**。
     * **删掉**：`\d`/`[0-9]`/`{}`/`^$` 那一串"支持清单"（v64 已验证它们全认，列出来只占预算）
     * 与 `PATH_HINT`（那句"路径按仓库根算…只约束写"是六件工具共用的一份，但 `find` 只读、
     * 而且正是"相对仓库根"这一句把她引向"绝对路径不能用"的误读）。
     * **预算（实测，`estimateTokens` 同一把尺）**：改写前 **88** token（`catalogTokens` 5405）；
     * 改写后 **90**（5407，上界 5500 ⇒ 余 **93**，单件 100 门照过）。
     */
    description:
      '按文件名（glob）搜；内容用 grep。pattern 必填：* ? 通配或字面子串，regex=true 按正则'
      + '（分支别写括号，用 [ab]），匹配整个文件名；只给 ext 会报错。'
      + 'path 可绝对或相对仓库根、只吃目录（文件用 grep），不传=全盘；file_type 选 file|folder。'
      + 'max_results=0 只数数量。例：{pattern:"*.log",path:"D:/x",max_results:0}',
    parameters: {
      type: 'object',
      properties: {
        // ── 参数面压缩（v55，2026-10-13）：只删重复与废话，取值/默认值/边界一个没删 ──
        // 逐条账见 `_research/_tmp-v55-params-account.mts`。三条口径：
        //   ① 同一件事在同一件工具里不写两遍（`max_results` 的默认/上限/0 语义只在它自己那一格说）；
        //   ② 括号里的举例能用更短的写法说清就换短的（`match_path` 那对命中示例保留——它是判据本身）；
        //   ③ **不删能力、不删取值、不删边界**：`sort_by` 的 8 个取值仍在 `enum` 里，`detail` 的两档、
        //      `file_type` 的三档、`regex`/`whole_word`/`ignore_case` 的默认值全部原样保留。
        pattern: { type: 'string', description: '文件名模式，支持 * ?，如 "*.test.ts"；也吃字面子串 "config"；regex=true 按正则解释' },
        // 范围那条（v64）：**不传＝搜全盘**才是这一件的默认行为（用户：「全盘使用应该是默认行为，
        // 怎么可以设计成默认工作根呢」）。⚠ 信任范围只限工作目录那一档里，"全盘"会绕过配置里写明
        // 的限制 ⇒ 那种配置下默认仍是**边界根**（实现见 handler 里的 boundary 判据）。
        path: { type: 'string', description: '限定目录（相对仓库根）；不传＝搜全盘（只限工作目录那一档＝该根内）；只吃目录，传文件走 grep' },
        max_results: { type: 'integer', description: '最多几条，默认 100，上限 2000；0 = 只报数量' },
        // `match_path`（v55）：删掉的是"而不是只匹配名字"这句**重复**——同一句的前半句已经说了
        // "匹配整条路径"，默认值与那对命中示例（判据本身）一字未动。
        match_path: { type: 'boolean', description: 'true = 匹配整条路径，默认 false；此时分隔符写 \\（fs/index 命中 0，fs\\index 命中 1）' },
        ignore_case: { type: 'boolean', description: '忽略大小写，默认 true' },
        regex: { type: 'boolean', description: 'pattern 按正则解释，默认 false' },
        whole_word: { type: 'boolean', description: '全词匹配，默认 false' },
        file_type: { type: 'string', enum: [...ES_FILE_TYPES], description: '条目类型，默认 all（取值即 enum）' },
        ext: { type: 'string', description: '扩展名过滤，如 "ts"；只在 regex=false 时生效' },
        // `sort_by` 的取值就在同一格的 `enum` 里逐条列着 ⇒ 描述只留"它是什么"，不再重复"默认由引擎决定"
        // （那句已由 `enum` 与实参拼装那一段的注释承担）；取值一个没少。
        sort_by: { type: 'string', enum: [...ES_SORT_KEYS], description: '排序键' },
        detail: { type: 'string', enum: [...ES_DETAILS], description: 'paths（默认）只列路径；full 加大小与时间' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    executionMode: 'parallel',
    sideEffect: 'none',
    timeoutMs: 15_000,
    async handler(rawArgs: unknown, ctx: ToolContext) {
      const args = argsObject(rawArgs, 'find');
      if (args === null) return invalidArgs('find', '期望一个对象，例如 {"pattern": "*.test.ts"}');
      const pattern = readString(args, 'pattern');
      if (pattern === null || pattern === '') return invalidArgs('find', '缺少 pattern');
      // max_results 的最小值是 **0**（旧实现是 1，`max_results:0` 直接报参数错）：devkit 把
      // 0 定义为"只统计不返回列表"（`tools/es_search.py:220`、`:275-276`），它的 schema 里
      // 这个 0 是写明的默认边界之一。模型在"先探一下有多少个"的场景会真的用 0。
      const maxRes = readOptionalInt(args, 'max_results', 0, 2000);
      if ('error' in maxRes) return invalidArgs('find', maxRes.error);
      const maxResults = maxRes.value ?? 100;
      // 0 = 只要数量：引擎那条路走它自带的计数器（见下面的 `-get-result-count`），
      // 但**结果一条都不列**——这正是她传 0 时要的东西，也是它省上下文的地方。
      const countOnly = maxResults === 0;
      const matchPath = readOptionalBool(args, 'match_path') ?? false;
      const ignoreCase = readOptionalBool(args, 'ignore_case') ?? true;
      const regex = readOptionalBool(args, 'regex') ?? false;
      const wholeWord = readOptionalBool(args, 'whole_word') ?? false;
      // 三个枚举参数一律**先校验再落参**：值非法时给的是"参数错 + 合法取值"，
      // 而不是把非法值拼进 es.exe 实参、换来一句 `Error 4: Unknown sort: bogus`。
      const fileTypeRes = readOptionalEnum(args, 'file_type', ES_FILE_TYPES);
      if ('error' in fileTypeRes) return invalidArgs('find', fileTypeRes.error);
      const fileType = fileTypeRes.value ?? 'all';
      const sortRes = readOptionalEnum(args, 'sort_by', ES_SORT_KEYS);
      if ('error' in sortRes) return invalidArgs('find', sortRes.error);
      const sortBy = sortRes.value;
      const detailRes = readOptionalEnum(args, 'detail', ES_DETAILS);
      if ('error' in detailRes) return invalidArgs('find', detailRes.error);
      // max_results=0 一条都不列，这时 CSV 那组开关纯属白付：detail 一律按 paths 走
      const detail: EsDetail = countOnly ? 'paths' : (detailRes.value ?? 'paths');
      // 空串与不传同义（devkit 也是 `if ext and not regex` 的判据：空串为假 → 不拼）
      const ext = (readOptionalString(args, 'ext') ?? '').trim();

      // ──────────────── 默认范围（v64，用户 2026-10-13 的裁决） ────────────────
      // 「全盘使用应该是默认行为，怎么可以设计成默认工作根呢」⇒ **不传 path ⇒ 搜全盘**
      // （实现方式就是**不给 es.exe 传 `-path`**，不是把某个绝对路径塞进参数——那只是换个假默认）。
      // ⚠ 一处收口：`trust.mode='workspace'` 时"全盘"会绕过配置里写明的限制（配置说 A、实际做 B
      // 是仓库明令禁止的第二例）⇒ 那一档下默认仍是**边界根**；`full` 档（不设边界）才真的全盘。
      // 空串与不传**同义**（不做出第三种行为）：两者都走这里的默认。
      const pathInput = (readOptionalString(args, 'path') ?? '').trim();
      let searchRoot: string | null;
      if (pathInput === '') {
        searchRoot = effectiveBoundaryRoot(ctx); // null = 不设边界（full 档）⇒ 真·全盘
      } else {
        const guarded = await resolveGuarded(env, ctx, pathInput, {
          purpose: 'find',
          access: 'read',
          requireDirectory: true,
        });
        // 错误消息给一句出路（0 token：结果不进 tools 段，行为一个字不动）：
        // es 的实参是 `-path <dir>`，给它文件只会返回空——所以"只吃目录"这条要**拦在前面**，
        // 而 path-guard 只说"不是目录"、没有下一步。传文件进来时她要做的正是 grep（P3 之后它吃文件）。
        if (!guarded.ok) {
          return fail(
            guarded.code,
            guarded.reason
            + (guarded.code === FS_ERROR_CODES.NOT_A_DIRECTORY
              ? '；find 只按文件名搜目录，要按内容搜这个文件请用 grep（它吃文件操作数）'
              : ''),
          );
        }
        searchRoot = guarded.path;
      }
      if (ctx.signal.aborted) return ABORTED_RESULT;

      // ──────────────── 实参拼装：逐条对应 devkit 的判据（顺序按 es.exe 的实测要求） ────────────────
      // 范围那一对（`-path <dir>`）只在**有范围**时给：不给就是全盘（见上面那一段判据）。
      const scopeArgs: string[] = searchRoot === null ? [] : ['-path', searchRoot];
      const esArgs: string[] = [...scopeArgs];
      // file_type：file ⇒ `/a-d`（只文件）、folder ⇒ `/ad`（只目录）、all ⇒ 不加（源 `:260-263` 同款）
      if (fileType === 'file') esArgs.push('/a-d');
      else if (fileType === 'folder') esArgs.push('/ad');
      // `-i` 与 `-case` 是 es.exe 里**同一个开关的两个名字**（帮助原文：`-i, -case  Match case`），
      // 语义是"区分大小写"，与 rg 的 `-i` 相反；忽略大小写时不能加（源 `:265-266` 用 -case，同义）
      if (!ignoreCase) esArgs.push('-i');
      if (matchPath) esArgs.push('-p');
      if (wholeWord) esArgs.push('-w');
      if (sortBy !== undefined) esArgs.push('-sort', ES_SORT_MAP[sortBy]);
      if (detail === 'full') esArgs.push(...ES_CSV_ARGS);
      if (regex) {
        // **`-r` 必须紧挨着模式串**（实测：中间夹 `--` 或别的开关，正则就不生效、静默回 0 命中）。
        // 代价是正则档下不能再用 `--` 保护"以 - 开头的模式"——那种模式本来也不是合法正则的常见形状，
        // 真写了会让 es.exe 报 `Error 6: Unknown switch.`，如实透出。
        esArgs.push('-r', pattern);
      } else {
        // ext 判据与源同（只在非 regex 时拼），但**拼法是两个 argv 元素**：
        // 实测 `ext:ts <query>` 作为一个 argv 会被 es.exe 当整句短语，`ext:` 过滤器失效（0 命中）。
        if (ext !== '') esArgs.push(`ext:${ext}`);
        // `--` = 结束选项：保护以 `-` / `/` 开头的模式不被当开关（实测 `-foo` 会退 6，`-- -foo` 不会）
        esArgs.push('--', pattern);
      }

      const result = countOnly
        // `-get-result-count`：引擎自带的计数器，**只回一个数**（实测 189ms vs 数 74,527 行 431ms
        // ——全盘成为默认之后，这条路的行数会从千级涨到万级，值得换）。过滤器与列表档同一套
        // （`scopeArgs` + 下面那几对开关都已拼好），所以数出来的口径一致。
        ? await env.deps.runProcess(gate.command, ['-get-result-count', ...esArgs], {
            timeoutMs: 14_000,
            signal: ctx.signal,
          })
        : await env.deps.runProcess(gate.command, ['-n', String(maxResults), ...esArgs], {
            timeoutMs: 14_000,
            signal: ctx.signal,
          });
      if (ctx.signal.aborted) return ABORTED_RESULT;

      const engine = `engine: everything (${gate.label})`;
      // 头部三段固定（engine / 模式 / 命中）+ 一个按 file_type 的限定语：
      // 只要文件或只要目录时说一句，免得"命中 3 个"被读成全都在。
      const filterNote = fileType === 'file' ? '（只要文件）' : fileType === 'folder' ? '（只要目录）' : '';
      // 退出码 8 = Everything IPC 窗口不存在（客户端没在跑）。装过 es.exe 的机器上这仍然会发生
      // ——Everything 客户端退出了而 es.exe 还在。此时**不降级**：工具既然是因为探测到引擎
      // 才注册的，静默走一遍全盘扫描只会让模型误以为索引还有效（也白烧一次扫描）。
      // 如实报错 + 给出路，比一个换了引擎的"成功"结果诚实。
      // ⚠ 计数器路：老版本/异常（非 0 退出、输出不是纯数字）⇒ **回落**到"不加 -n 数 stdout 行数"
      // 那条老路（同一个数，只是慢）；回落失败才报错。
      const engineDead = result.code === 8 || /IPC|Everything search client/u.test(result.stderr);
      const counted = countOnly ? parseEsCount(result.stdout) : null;
      if (countOnly && result.code === 0 && !result.timedOut && counted !== null) {
        return ok(
          `${engine}\n模式 ${'`'}${pattern}${'`'} · 命中 ${counted} 个${filterNote}\n`
          + `（max_results=0：只统计不列条目；要看清单请传 max_results≥1）${decodeNote(result)}`,
        );
      }
      const fallback = countOnly && result.code === 0 && !result.timedOut && counted === null
        ? await env.deps.runProcess(gate.command, esArgs, { timeoutMs: 14_000, signal: ctx.signal })
        : null;
      const effective = fallback ?? result;
      if (ctx.signal.aborted) return ABORTED_RESULT;
      if (effective.timedOut || engineDead || effective.code !== 0) {
        const why = effective.timedOut
          ? '调用超时'
          : engineDead
            ? 'Everything 客户端没有在运行（退出码 8）——启动 Everything 后重试'
            : effective.stderr.trim() || `退出码 ${effective.code ?? 'null'}`;
        return fail(
          FS_ERROR_CODES.SEARCH_FAILED,
          `es.exe 未返回结果：${why}。找文件内容用 grep；按名字找且引擎不可用时，可用 safe_read 传目录逐层看。`,
        );
      }
      const stdout = effective.stdout;

      // 这里只剩**列表档**（计数档在上面那条分支里就返回了，回落那一路也从同一个出口出）；
      // `engine` / `filterNote` 在那条分支之前就拼好了，两档共用。
      // detail:'full' —— devkit 一次调用能拿到的全在这里：每条 name/size/修改时间，
      // 外加头部总大小（源 `tools/es_search.py:316-346` 的 items + total_size + count）。
      if (detail === 'full') {
        const items = parseEsCsv(stdout);
        const knownSizes = items.filter((item) => item.sizeKnown);
        const totalSize = knownSizes.reduce((sum, item) => sum + item.size, 0);
        // 目录在 es.exe 的 CSV 里**没有大小**（Size 列是空串，实测）：一个目录都没有大小时
        // 就不编一个"共 0 B"出来（那是假信息），索性不给这一段。
        const sizeNote = knownSizes.length === 0 ? '' : ` · 共 ${formatBytes(totalSize)}`;
        const truncated = items.length >= maxResults;
        const header =
          `模式 ${'`'}${pattern}${'`'} · 命中 ${items.length} 个${filterNote}${sizeNote}`
          + (truncated ? `（前 ${items.length} 项合计）` : '');
        if (items.length === 0) return ok(`${engine}\n${header}\n(无命中)${decodeNote(effective)}`);
        const body = items
          .map((item) => {
            const size = item.sizeKnown ? formatBytes(item.size) : '-';
            return `${size} · ${item.dateModified} · ${esItemPath(item, ctx.workspaceRoot)}`;
          })
          .join('\n');
        return ok(`${engine}\n${header}\n\n${body}${truncationNote(items.length, maxResults)}${decodeNote(effective)}`);
      }

      const found = stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line !== '');
      const header = `模式 ${'`'}${pattern}${'`'} · 命中 ${found.length} 个${filterNote}`;
      const limited = found.slice(0, maxResults);
      const body = limited.map((p) => relative(ctx.workspaceRoot, p).replaceAll('\\', '/')).join('\n');
      return ok(
        `${engine}\n${header}\n\n${body}${found.length === 0 ? '(无命中)' : ''}`
        + `${truncationNote(limited.length, maxResults)}${decodeNote(effective)}`,
      );
    },
  };
}

/** 供测试断言用：搜索工具必然把 engine 写在首行 */
export const ENGINE_LINE_PREFIX = 'engine: ';
