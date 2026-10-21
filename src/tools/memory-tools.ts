/**
 * Irmia Agent — `memory_read`：**记忆工具**（按编号取 / 按自然语言查 / 按指针取）
 *
 * 形状与理由见 `src/persona/memory-access.ts` 的文件头（用户的原话、实测依据、
 * 三条职责边界都在那里）。这一层只做四件事：
 *
 *   1. **三个入口**（2026-10-15 扩参；用户原话那一版「记忆工具可以直接输入挑选出来的索引号召回
 *      单条记忆，然后也可以输入自然语言查询相关记忆」）——按参数分派，**优先级 `index` > `query` > `path+line`**：
 *        · `index`（编号）：查**当次索引**（`buildMemoryIndex(dir, { full: true })`，全量、不截断），
 *          取第 N 条 → 拿它的 `路径:行号` → **走与指针那条完全相同的读法**（同一份
 *          `readMemoryEntry`、同一份"漂了就报错"的判据）⇒ 返回那**一段正文**，不是整个文件。
 *        · `query`（自然语言）：BM25（`persona/bm25.ts`，口径见它文件头）在**全量索引**上取 top-N
 *          （默认 {@link MEMORY_QUERY_DEFAULT_N}、上限 {@link MEMORY_QUERY_MAX_N}）⇒ 只回
 *          **编号 + `路径:行号` + 分数 + 摘要**（正文要她自己按编号再取一次——省上下文；
 *          这条与推荐段的回执形态**同一口径**）。
 *        · `path` + `line`（指针）：原样保留（v42 起的那条路，一个字没改）。
 *      **为什么不新造一件工具**：这一件已经在模型清单里、已经在吃 `path`/`line`，
 *      三个入口共用一个名字 = 少一份常驻 schema（新建一件 ≥215 token，扩这三格只花 64）。
 *   2. **参数与白名单**：`path` 必须是 `MEMORIES/<文件名>` 这一种写法（索引里的指针就是这样），
 *      拼出来的绝对路径必须落在 `<dataDir>/workspace/MEMORIES/` 内。放开到任意路径就等于
 *      又造一个 `safe_read`（连同它的整篇读能力），而"反复把全文读入"正是它要治的病。
 *   3. **上限**：一次最多 {@link MEMORY_READ_MAX_LINES} 行，**超了就拒绝而不是夹取**
 *      ——夹取会让"我要读 200 行"静默变成"读到 40 行"，而多出来的那一步正是"读整篇"。
 *   4. **访问账**：读**成功**时写一条 `memory/read`（只放指针、不放正文），
 *      给 design §4.17 第 2 条的"访问强化"留数据。**只有"取到正文"的那两条入口记账**
 *      （`index` 与 `path+line`）：`query` 只回指针与摘要、没取正文，记成"被读过"是假数据。
 *
 * 副作用口径：`sideEffect: 'none'`。它**不碰任何记忆文件**（本模块只读），
 * 写出去的那一条事件是 append-only 的账，与 `memory/selected` 同级。
 *
 * ⚠ **编号的语义（判据只有一处）**：编号 = `buildMemoryIndex(dir, { full: true })` 返回数组的
 * **下标 + 1**（当次索引内的序号）。它**不许**用默认档（被 900 token 预算截断过，实测 29/178）
 * 去算——那会让编号随预算线漂。跨轮引用一律用 `路径:行号`（编号会随索引重建而变，这是设计）。
 */

import { join, normalize, sep } from 'node:path';

import {
  isMemoryPath,
  memoryDirAbs,
  readMemoryEntry,
  MEMORY_READ_DEFAULT_LINES,
  MEMORY_READ_MAX_LINES,
} from '../persona/memory-access.ts';
import { buildBm25Corpus, formatScore, rankScored, scoreBm25 } from '../persona/bm25.ts';
import { buildMemoryIndex } from '../persona/memory-injection.ts';
import type { MemoryRead } from '../log/types.ts';
import {
  ABORTED_RESULT,
  FS_ERROR_CODES,
  argsObject,
  fail,
  invalidArgs,
  ok,
  readOptionalInt,
  readString,
  type ToolContext,
  type ToolDefinition,
} from './fs/types.ts';

/** `query` 默认取几条（用户原话那一版：「N 默认 5、可传」） */
export const MEMORY_QUERY_DEFAULT_N = 5;
/** `query` 上限：再多就不是"相关记忆"，而是"把索引倒出来"了（那正是这一版要避免的） */
export const MEMORY_QUERY_MAX_N = 20;

/**
 * 访问账的写入口。
 *
 * 形状是"宿主给一个收完整 payload 的函数"（**含 turn**），而不是在这里自己拼：
 * 事件写库要 turn 号，而"当前是哪一轮"只有循环层知道——工具层拿到的 `ctx.turn` 是
 * 派发时给的，所以由**工具层把它交出去**、由宿主决定怎么写（与 vision 的 `emit` 同一条纪律：
 * 工具只该有"写这一种事件"的能力，不该拿到任意写权限或自己去问 turn）。
 */
export type MemoryReadRecorder = (data: MemoryRead['data']) => void;

export interface MemoryToolsOptions {
  /** 数据目录（`<dataDir>/workspace/MEMORIES/` 是记忆根） */
  dataDir: string;
  /**
   * 访问账出口。省略时不记账——但**必须**在别处把这件事说清楚，
   * 而不是让它静默变成"机制设计里有、实现里没有"（§4.17 那条病）。
   */
  onAccess?: MemoryReadRecorder | undefined;
}

/**
 * 把路径拼成记忆根下的绝对路径，并确认它真的还在根内。
 *
 * 判据放在这里而不是信 `isMemoryPath`：那个函数管"写法对不对"，这个管"拼出来落在哪"。
 * 两道都要——只判写法的话，`MEMORIES/../facts.md` 这种（写法上 parts 含 `..`，已被
 * `isMemoryPath` 挡掉）与将来任何别名/符号链接的变体都得再想一遍；只判落点的话，
 * 一个绝对路径会被 `join` 悄悄接到根后面。
 */
function resolveMemoryPath(dataDir: string, relPath: string): { abs: string; rel: string } | null {
  const normalized = relPath.replace(/\\/gu, '/');
  if (!isMemoryPath(normalized)) return null;
  const parts = normalized.split('/').filter((p) => p !== '' && p !== '.');
  const root = memoryDirAbs(dataDir);
  const abs = normalize(join(root, ...parts.slice(1)));
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return { abs, rel: `${parts[0]}/${parts.slice(1).join('/')}` };
}

/** 三个入口的取值（`null` = 这个入口没被指定） */
interface MemoryToolEntry {
  index: number | null;
  query: string | null;
  path: string | null;
  line: number | null;
}

/**
 * 读一条指针指向的那段正文——**`index` 与 `path+line` 两个入口共用这一处**
 * （两条路的判据必须逐字相同：从索引拿到的指针，与她自己抄来的指针，该走同一个读法、
 * 该报同一句话。分开写两份必然漂，而漂的方向是"按编号读得到、按指针读不到"这种最难查的形状）。
 */
function readByPointer(
  options: MemoryToolsOptions,
  ctx: ToolContext,
  dataDir: string,
  pathInput: string,
  line: number,
  lines: number,
): ReturnType<typeof ok> | ReturnType<typeof fail> {
  const resolved = resolveMemoryPath(dataDir, pathInput);
  if (resolved === null) {
    return fail(
      FS_ERROR_CODES.PATH_DENIED,
      `memory_read 只读 MEMORIES/ 下的记忆文件，收到的是 ${pathInput}。`
      + '它吃的是**索引里的指针**（形如 `MEMORIES/facts.md:9`）——请照抄索引里那一条。'
      + '要读别的文件用 safe_read。',
    );
  }
  if (ctx.signal.aborted) return ABORTED_RESULT;

  const result = readMemoryEntry(resolved.abs, resolved.rel, line, lines);
  if (!result.ok) {
    // 漂了/越界/文件不在：三种都**不给正文**（给了她就拿到可能对不上的记忆，而她自己不知道）
    const code = result.status === 'missing'
      ? FS_ERROR_CODES.NOT_FOUND
      : result.status === 'out-of-range'
        ? FS_ERROR_CODES.INVALID_ARGS
        : FS_ERROR_CODES.NO_MATCH;
    return fail(code, result.message);
  }

  // 访问账：**只放指针、不放正文**（与 memory/selected 同一条纪律）。
  // 记账失败绝不能影响这次读取——账是派生物，正文已经拿到了。
  try {
    options.onAccess?.({
      turn: ctx.turn,
      path: result.path,
      line: result.line,
      lines: result.lines,
      pinned: result.pinned,
    });
  } catch {
    // 静默：账写不进去不该让一次成功的读取变成失败
  }

  const head = `${result.path}:${result.line}${result.pinned ? ' **!pinned**' : ''} · `
    + `读 ${result.lines} 行 · 摘要「${result.summary}」`;
  const tail = result.nextLine === null
    ? '（已到文件末尾）'
    : `（要接着读用 line=${result.nextLine}）`;
  return ok(`${head}\n${result.text}\n${tail}`);
}

export function createMemoryReadTool(options: MemoryToolsOptions): ToolDefinition {
  const dataDir = options.dataDir;
  return {
    name: 'memory_read',
    // 描述 <100 token 是硬门（registry.ts 的 MAX_DESCRIPTION_TOKENS，超了整件不注册）。
    // 2026-10-15 扩三个入口时这里**只加了一句半**，靠的是把三个入口写成并列短句、
    // 且与参数描述**不重复**（"编号是当次索引的序号"这句必须在，它是判据不是废话：
    // 编号会随索引重建而变，跨轮引用要用 `路径:行号`）。
    description:
      '读记忆索引里的条目，三个入口任选其一——index：给编号取那一条正文；'
      + 'query：给一句话，按 BM25 从全量索引挑最相关的几条（默认 5，只给编号+摘要+分数，'
      + '要正文再按 index 取）；path+line：给索引里的指针。'
      + '编号是当次索引的序号，跨轮引用请用 `路径:行号`。查不到就说没有相关的。',
    parameters: {
      type: 'object',
      properties: {
        // ── 三个入口（2026-10-15）──────────────────────────────────────────────
        // 参数描述**不进单件描述那份预算**，但**进清单总量**（catalogTokens 量的就是全段 JSON），
        // 所以这几格也按"一句话、不重复"写：`index` 与 `n` 的默认值/语义各写一遍就够。
        index: { type: 'integer', description: '编号（1-based，见推荐段或 INDEX.md）' },
        query: { type: 'string', description: '自然语言查询，如 "用户喝什么茶"' },
        n: { type: 'integer', description: `query 取几条，默认 ${MEMORY_QUERY_DEFAULT_N}，上限 ${MEMORY_QUERY_MAX_N}` },
        // ── 指针那条路（v42 起；两格的措辞跟着总量预算收过一轮，判据一个字没删）──
        path: { type: 'string', description: '路径，如 "MEMORIES/facts.md"（限 MEMORIES/ 下）' },
        line: { type: 'integer', description: '行号（1-based），照抄索引' },
        lines: { type: 'integer', description: `读几行，默认 ${MEMORY_READ_DEFAULT_LINES}，最多 ${MEMORY_READ_MAX_LINES}` },
      },
      // ⚠ **`required` 是空的**（2026-10-15 用户裁决，改掉原来那个 `['path','line']`）。
      //
      // 为什么必须空着（这条不是洁癖，是**流量**问题）：三个入口是"任选其一"，
      // 而 `required: ['path','line']` 会让**照 schema 办事的模型**认为"这两个必须先给"——
      // 于是 `index` / `query` 这两个新入口**可能永远吃不到流量**（她不会去用一件"参数填不全"的工具）。
      // 描述里那句"三个入口任选其一"与 `required` 打架时，模型通常信 `required`。
      //
      // 为什么**不上 `oneOf`**：那一串（三个分支各写一遍属性）的常驻代价远大于它治的事
      // ——而"择一"的判据本来就落在 handler 里那一段（都不给 / 只给 path 不给 line，
      // 都会得到一句**指路**的参数错，见下面 `entry` 那一段后面的三个分支）。
      // 代价是"零参数调用"不再被 schema 拦下 ⇒ 它落到运行时那一句报错上（那条用例钉着逐字文案）。
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string' },
        path: { type: 'string' },
        line: { type: 'integer' },
        lines: { type: 'integer' },
        summary: { type: 'string' },
        pinned: { type: 'boolean' },
        content: { type: 'string' },
      },
    },
    executionMode: 'parallel',
    sideEffect: 'none',
    timeoutMs: 10_000,
    async handler(rawArgs: unknown, ctx: ToolContext) {
      const args = argsObject(rawArgs, 'memory_read');
      if (args === null) {
        return invalidArgs(
          'memory_read',
          '期望一个对象，例如 {"index": 12} / {"query": "用户喝什么茶"} / '
          + '{"path": "MEMORIES/facts.md", "line": 9}',
        );
      }

      // ── 解参数：三个入口各自可选，**择一的判据在下面对** ──────────────────────
      const indexRes = readOptionalInt(args, 'index', 1, Number.MAX_SAFE_INTEGER);
      if ('error' in indexRes) return invalidArgs('memory_read', indexRes.error);
      const nRes = readOptionalInt(args, 'n', 1, MEMORY_QUERY_MAX_N);
      if ('error' in nRes) {
        return invalidArgs('memory_read', `n 只能是 1~${MEMORY_QUERY_MAX_N} 的整数。`);
      }
      const pathInput = readString(args, 'path');
      // line 的合法下界是 1：索引里的行号是 1-based，给 0 说明它把"没指定"和"第一行"混了
      const lineRes = readOptionalInt(args, 'line', 1, Number.MAX_SAFE_INTEGER);
      if ('error' in lineRes) return invalidArgs('memory_read', lineRes.error);
      const linesRes = readOptionalInt(args, 'lines', 1, MEMORY_READ_MAX_LINES);
      if ('error' in linesRes) {
        return invalidArgs(
          'memory_read',
          `lines 只能是 1~${MEMORY_READ_MAX_LINES} 的整数——一次读更多就等于"读整篇"，`
          + '那正是这件工具要避免的。要看全文请用 safe_read，并想清楚为什么需要整篇。',
        );
      }
      const lines = linesRes.value ?? MEMORY_READ_DEFAULT_LINES;
      const queryRaw = readString(args, 'query');
      const query = queryRaw === null ? null : queryRaw.trim();

      const entry: MemoryToolEntry = {
        index: indexRes.value ?? null,
        query: query === '' ? null : query,
        path: pathInput === null || pathInput === '' ? null : pathInput,
        line: lineRes.value ?? null,
      };

      // ── 入口一：按编号取那一条（最高优先级）────────────────────────────────
      if (entry.index !== null) {
        const all = buildMemoryIndex(dataDir, { full: true }).entries;
        const hit = all[entry.index - 1];
        if (hit === undefined) {
          // **如实报错，不许编**：越界时给出真实范围与出路（她多半是拿了个旧编号）
          return fail(
            FS_ERROR_CODES.INVALID_ARGS,
            `编号 ${entry.index} 不存在：当次索引一共 ${all.length} 条（合法范围 1~${all.length}）。`
            + '编号会随索引重建而变——跨轮引用请用 `路径:行号`（推荐段与 INDEX.md 里都写着）。',
          );
        }
        return readByPointer(options, ctx, dataDir, hit.path, hit.line, lines);
      }

      // ── 入口二：自然语言查（BM25 在全量索引上取 top-N）────────────────────
      if (entry.query !== null) {
        const n = nRes.value ?? MEMORY_QUERY_DEFAULT_N;
        const all = buildMemoryIndex(dataDir, { full: true }).entries;
        if (all.length === 0) {
          return ok('记忆索引现在是空的（她还没写过任何记忆）——没有相关的。');
        }
        const corpus = buildBm25Corpus(all.map((e) => `${e.path} ${e.summary}`));
        const ranked = rankScored(
          scoreBm25(corpus, entry.query),
          (i) => `${all[i]?.path ?? ''}:${all[i]?.line ?? 0}`,
        ).slice(0, n);
        if (ranked.length === 0) {
          // **不许编**：一个词都对不上就直说，并给出路
          return ok(
            `没有相关的：「${entry.query}」在当次索引（${all.length} 条）里一个词都对不上。`
            + '换个说法再试，或者用 safe_read 看 MEMORIES/ 目录里有哪些文件。',
          );
        }
        const rows = ranked.map((hit) => {
          const e = all[hit.index];
          if (e === undefined) return '';
          const pinned = e.pinned ? ' **!pinned**' : '';
          return `${hit.index + 1}. \`${e.path}:${e.line}\`${pinned} `
            + `分数=${formatScore(hit.score)} ${e.summary}`;
        }).filter((row) => row !== '');
        return ok(
          `${rows.join('\n')}\n（共 ${all.length} 条里挑出 ${rows.length} 条；`
          + '这是按相关度排的，不一定都对。要哪条的正文就用它的编号调 memory_read）',
        );
      }

      // ── 入口三：按指针取（v42 起那条路，判据一个字没改）──────────────────
      if (entry.path === null) {
        return invalidArgs(
          'memory_read',
          '要给三个入口里的一个：`index`（编号）/ `query`（一句话）/ `path`+`line`（索引里的指针）。',
        );
      }
      if (entry.line === null) {
        return invalidArgs('memory_read', '缺少 line；索引里那条指针的行号要照抄，不要自己推算');
      }
      return readByPointer(options, ctx, dataDir, entry.path, entry.line, lines);
    },
  };
}
