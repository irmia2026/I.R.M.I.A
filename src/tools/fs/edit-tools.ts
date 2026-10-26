/**
 * Irmia Agent — 文件系工具包：写工具四件
 * （safe_edit / safe_write / safe_rollback / multi_edit）
 *
 * 四件全是 destructive + exclusive + 30s（multi_edit 60s），对齐 design.md §4.18。
 * destructive 的含义不是「危险」，而是「崩溃后不可自动重试，必须转人工」——
 * 所以每一次落盘之前都先把原文备好，任何一步失败都能退回去。
 *
 * 白名单纪律（§4.10 第 1 条 + M4-1/M4-2 验收）：写路径先 resolve、再 realpath、
 * 再比前缀，符号链接指向工作区外一律拒绝。
 */

import { createBackup, listBackups, readBackup } from './backup.ts';
import { PATH_HINT } from '../boundary.ts';
import type { FsEnv } from './env.ts';
import { resolveGuarded } from './env.ts';
import {
  atomicWrite,
  describeVerdict,
  guardedWrite,
  parseEditRequest,
  parseEditRequestFromUnknown,
  planEdit,
  readTargetFile,
  type WriteTarget,
} from './edit-core.ts';
import { insideAny, readOnlyPrefixOfWrite } from './path-guard.ts';
import { decodeText, encodeText, formatBytes, previewLine, type DetectedEncoding } from './text-codec.ts';
import {
  ABORTED_RESULT,
  FS_ERROR_CODES,
  argsObject,
  fail,
  invalidArgs,
  isRecord,
  ok,
  readOptionalBool,
  readOptionalString,
  readString,
  toErrorMessage,
  type ToolContext,
  type ToolDefinition,
} from './types.ts';

/** 把读到的文件内容解码成文本，同时保留编码判定（写回时要按原编码落盘） */
function decodeTarget(buffer: Buffer): { text: string; encoding: DetectedEncoding } {
  const decoded = decodeText(buffer);
  return { text: decoded.text, encoding: decoded.encoding };
}

function backupLine(name: string, created: boolean): string {
  return created ? `备份：新建前无原文件（回滚将删除该文件），快照名 ${name}` : `备份：${name}`;
}

/**
 * 版本快照（design §4.22 的 `data/.versions/`）的一行交代。
 *
 * 快照是**只增不改**的内容寻址库，与 backups/ 的"最近 N 份"是两件事：前者回答
 * 「昨天那个版本还在不在」（文件级 undo 的依据，M8-9），后者回答「刚才改坏了怎么退回去」。
 * 失败必须说出来——文件已经写入是事实，少的只是 undo 历史里的一版，而这件事只有报出来才有人管。
 */
function snapshotLine(warnings: readonly string[] | undefined): string {
  if (warnings === undefined || warnings.length === 0) {
    return '版本库：本次内容已留快照（data/.versions/workspace/，跨日留存，只增不改）。';
  }
  return snapshotWarningText(warnings);
}

/** 快照写失败那一段的**唯一实现**（两个调用点逐字同一份：这是"文件已写入但 undo 缺一版"的判据） */
function snapshotWarningText(warnings: readonly string[]): string {
  return `注意：${warnings.join('、')} 的版本快照写入失败——文件已写入，但 data/.versions/ 里没有这一版`
    + '（文件级 undo 会缺这一个版本；backups/ 的写入前快照不受影响）。';
}

/**
 * `safe_edit` 那一支的快照行：**只在失败时出现**（成功那句已并进 `undoLine` 压过的一行里）。
 *
 * 为什么两处不共用一个返回值：`safe_write` 的回执没有 `undoLine` 那一行，它仍需要"本次内容
 * 已留快照"这句交代；而 `safe_edit` 的那三行固定尾巴在 2026-10-20 压成了一行（R3），
 * 再各说一遍就是同一件事写两遍。失败那一段**两个工具逐字相同**，抽成一份。
 */
function snapshotWarningOnly(warnings: readonly string[] | undefined): string {
  return warnings === undefined || warnings.length === 0 ? '' : snapshotWarningText(warnings);
}

/**
 * `safe_edit` 回执的最后一行 —— 原来是三行固定尾巴，压成一行（2026-10-20，R3）。
 *
 * 三行逐字是（括号里是审计实测的命中率）：
 *   `版本库：本次内容已留快照（data/.versions/workspace/，跨日留存，只增不改）。`（93.2%）
 *   `如需撤销，用 safe_rollback 指定该文件（默认回到最近一次备份）。`（93.2%）
 *   `语法检查跳过：扩展名 .md 没有可用的零依赖语法检查器，已跳过`（91.5%）
 * 合计 63 token/条，而三件事各只剩一句结论：
 *   ① 有一版快照可退（`快照已留`）——路径与"跨日留存只增不改"是常驻知识，不必每条回执重说；
 *   ② **退路是哪个工具**（`撤销用 safe_rollback`）——这一格不能省，它是"下一步动作"；
 *   ③ **这一档没查过语法**（`语法未查：.md 无零依赖检查器`）——**最不能省的一格**：
 *      省掉它，她会当成查过了（审计 R3 的风险栏点名这一条）。所以是"压短"，不是"删掉"。
 *
 * `snapshotFailed` 时**不写"快照已留"**：那一句与下面那条失败警告正面冲突，而失败那一条
 * 必须逐字留着（"文件已写入但没有这一版"只有报出来才有人管）。两个字段各管一个事实。
 */
function undoLine(input: { skippedReason: string | undefined; snapshotFailed: boolean }): string {
  const parts = [
    input.snapshotFailed ? '' : '快照已留',
    '撤销用 safe_rollback',
    input.skippedReason === undefined ? '' : `语法未查：${input.skippedReason}`,
  ].filter((part) => part !== '');
  return `（${parts.join(' · ')}）`;
}

// ──────────────────────────────── safe_edit ────────────────────────────────

export function createSafeEditTool(env: FsEnv): ToolDefinition {
  return {
    name: 'safe_edit',
    description:
      '已有文件精确替换（先备份，改坏自动回滚）。old 里抄自 safe_read 的行号前缀自动剥掉。'
      + '多匹配用 occurrence:N 或 replace_all。'
      + 'insert_at_line 插第 line 行后、delete_lines 含两端；拼不出替换，用 old/new。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `文件路径（相对或绝对）。${PATH_HINT}` },
        // mode 这一格的描述是**两个行模式的语义本身**（见下面三段注释）。为什么不写进工具描述：
        // `safe_edit` 是 `test/tool-catalog.test.ts` 里被压到 <60 token 的那六件之一，而
        // "把两个方向各写一句 + 点明拼不出替换"至少要 20 个 token——工具描述只塞得下那句
        // 结论（"insert_at_line 插第 line 行后、delete_lines 含两端；拼不出替换，用 old/new"），
        // 例子与理由放这里（参数描述不进门禁，模型每次请求同样看得到）。
        //
        // 压缩（v55，2026-10-13）：这一格原本 66 token，是本批压得最狠的一格。删掉的是**重复**
        // （"默认 replace"在 `enum` 里、"line:0=文件开头"与默认值在 `line` 那一格已各有一句）
        // 与**废话**（"1-based"由 `line`/`start_line` 那两格承担）。
        // ⚠ **那句错位例子必须留**——`test/fs-tools.test.ts` 有一条锁专门判它
        // （"mode 描述里要给出那个错位的具体例子"）：它是 2026-10-05 实测那个静默错位坑的判据本身，
        // 不是可删的废话。**两个方向的语义一个没删**：insert 是"**之后**"、delete 是"**含两端**"、
        // 替换走 replace——三条逐字保留。
        mode: {
          type: 'string',
          enum: ['replace', 'insert_at_line', 'delete_lines'],
          description:
            'insert_at_line：new 插在第 line 行**之后**（line:0=文件开头）；delete_lines：'
            + '删 start_line..end_line、**含两端**。两者拼不出「替换第 N 行」'
            + '（删 2-2 再插 line:2，new 落到原第 3 行之后），替换请走 replace + old/new。',
        },
        old: { type: 'string', description: 'replace 模式：被替换的原文（行号前缀自动剥掉）' },
        new: { type: 'string', description: 'replace 模式：新文本；insert_at_line：插入的文本' },
        // 这两格（v55，2026-10-13）：删的是重复的"与 occurrence 互斥"与括注里的默认值——
        // `replace_all` 的 `false`、`occurrence` 的 `0` 都在这里逐字写着，再括注一遍是同一件事写两遍。
        // **互斥这条边界换一处说**：`occurrence` 那一格仍写着"与 replace_all 互斥"（边界没删）。
        replace_all: { type: 'boolean', description: '替换全部匹配，默认 false（多匹配必须消歧）' },
        occurrence: { type: 'integer', description: '只替换第 N 处匹配（1-based）；0 = 未指定；与 replace_all 互斥' },
        // ── 两个行模式的语义必须各写一句，而且**不能互相推导**（2026-10-05 实测）──
        //
        // 实测的不对称：`delete_lines 2-2` 删的是**第 2 行**（闭区间、含两端），
        // 而 `insert_at_line line=2` 插在**第 2 行之后**。两句话各自都对（都与 devkit 的
        // `tools/safe_edit.py` 逐字对齐，`edit-core.ts` 里那两支就是源的写法），
        // 但**方向不同**：于是最自然的那种写法——
        //   "把第 2 行换成新内容" = 先 `delete_lines 2..2` 再 `insert_at_line line=2`——
        // 会**静默错位**：删掉第 2 行后原第 3 行变成第 2 行，"插在第 2 行之后"就落到了它后面，
        // 新内容跑到下一行下面，而回执两句话都写着"成功"。
        //
        // 三条处置，缺一条这个坑就还在：
        //   ① **不改方向**：那是刚按 devkit 对齐的行为（改动它等于把一个已核对的差异反着改回去）；
        //   ② 描述里把两个方向的语义各写一句，并点明"这两者拼不出替换"、指过去 `old`/`new`
        //      ——替换的正路是 replace 模式（把该行原文抄进 old），它按文本匹配、与行号无关；
        //   ③ 锁测试钉住那对组合的结果（`test/fs-tools.test.ts`「先删后插 ≠ 替换第 N 行」），
        //      免得将来有人"顺手"把某一支的方向改齐，把这条已经写在文档里的取舍又改回坑里。
        // `line` 这一格（v55）：原来的括注"（1-based；0 = 文件开头，越界报错）"里，前两项已由
        // `mode` 那一格说清（"第几行之后"与"line:0=文件开头"），这里只留**边界**"越界报错"。
        line: {
          type: 'integer',
          description: 'insert_at_line：插到第几行**之后**（越界报错）',
        },
        // （v55）两格各留一句：`start_line` 说"起始行、含"，`end_line` 只说"结束行、含"——
        // 原来两格都把"delete_lines 模式"写了一遍，同一件事写两遍。**含两端这条边界一个字没删。**
        start_line: { type: 'integer', description: 'delete_lines：起始行（**含**，1-based）' },
        end_line: { type: 'integer', description: '结束行（**含**，1-based）' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    sideEffect: 'destructive',
    timeoutMs: 30_000,
    async handler(rawArgs: unknown, ctx: ToolContext) {
      const args = argsObject(rawArgs, 'safe_edit');
      if (args === null) return invalidArgs('safe_edit', '期望一个对象，例如 {"path": "a.ts", "old": "x", "new": "y"}');
      const pathInput = readString(args, 'path');
      if (pathInput === null || pathInput === '') return invalidArgs('safe_edit', '缺少 path');

      const parsed = parseEditRequest(args);
      if ('error' in parsed) return invalidArgs('safe_edit', parsed.error);

      const guarded = await resolveGuarded(env, ctx, pathInput, { purpose: 'safe_edit', access: 'write' });
      if (!guarded.ok) {
        return fail(
          guarded.code,
          guarded.code === FS_ERROR_CODES.NOT_FOUND
            ? `${guarded.reason}；safe_edit 只改已存在的文件，新建文件请用 safe_write。`
            : guarded.reason,
        );
      }
      if (ctx.signal.aborted) return ABORTED_RESULT;

      const read = await readTargetFile(guarded.path, env.maxEditBytes);
      if (read.error !== undefined) {
        return fail(read.code ?? FS_ERROR_CODES.IO_ERROR, `读取 ${guarded.relPath} 失败：${read.error}`);
      }
      if (read.buffer === null) {
        return fail(FS_ERROR_CODES.NOT_FOUND, `${guarded.relPath} 不存在；新建文件请用 safe_write。`);
      }

      const decoded = decodeTarget(read.buffer);
      const plan = planEdit(decoded.text, parsed);
      if (!plan.ok) {
        const extra = plan.matches === undefined
          ? []
          : plan.matches.map((match) => `${match.line}:${match.column}  ${match.preview}`);
        return fail(
          plan.code,
          plan.message + (extra.length === 0 ? '' : `\n命中位置：\n${extra.map((line) => `  ${line}`).join('\n')}`),
        );
      }

      const target: WriteTarget = {
        path: guarded.path,
        relPath: guarded.relPath,
        inputPath: guarded.inputPath,
        text: plan.text,
        original: read.buffer,
        encoding: decoded.encoding,
      };
      const result = await guardedWrite(env, ctx, [target]);
      if (!result.ok) return fail(result.code, result.message);

      const beforeLines = decoded.text === '' ? 0 : decoded.text.split('\n').length;
      const afterLines = plan.text === '' ? 0 : plan.text.split('\n').length;
      const backup = result.backups[0];
      const verdict = result.verdicts[0];
      // 语法那一档只有两种可见状态：查过（通过）⇒ 单独一行报 checker；
      // 没查（skipped）⇒ 并进下面那条压过一行的尾巴里，写"未查"。
      const verdictOf = verdict === undefined ? undefined : verdict.verdict;
      const skippedReason = verdictOf !== undefined && verdictOf.status === 'skipped'
        ? verdictOf.reason
        : undefined;
      const snapshotFailed = result.snapshotWarnings !== undefined && result.snapshotWarnings.length > 0;
      const lines = [
        `${guarded.relPath} 已更新：${plan.summary}`,
        `行数 ${beforeLines} → ${afterLines}${plan.fuzzy ? '（缩进容错命中）' : ''}`,
        // 编码那一格（2026-10-18）：**原文件不是 UTF-8 时必须说出来**——因为写回是
        // "按原编码编回去"，而 GB18030/GBK 在零依赖运行时**没有编码器**，实际会改存 UTF-8。
        // 不说的话，下一次用别的工具（编辑器 / git / 老脚本）读同一个文件就会对不上。
        decoded.encoding === 'utf8'
          ? ''
          : `编码 ${decoded.encoding}：${encodeText(plan.text, decoded.encoding).notes.join('；')}`,
        skippedReason === undefined && verdictOf !== undefined ? describeVerdict(verdictOf) : '',
        backup === undefined ? '' : backupLine(backup.record.name, backup.created),
        undoLine({ skippedReason, snapshotFailed }),
        // 快照写失败那一段仍单独一行、**逐字保留**（`snapshotWarningOnly` 的理由见它那段注释）
        snapshotWarningOnly(result.snapshotWarnings),
      ].filter((line) => line !== '');
      return ok(lines.join('\n'));
    },
  };
}

// ──────────────────────────────── safe_write ────────────────────────────────

export function createSafeWriteTool(env: FsEnv): ToolDefinition {
  return {
    name: 'safe_write',
    description:
      '新建或整体覆盖文本文件：自动建父目录，写前做语法检查（.ts/.js/.json），失败即中止并保留原文件。' +
      '**已存在的文件默认拒绝覆盖**（返回现有内容预览）——改局部内容请用 safe_edit，' +
      '确需整体覆盖请显式给 overwrite:true（会先备份，可用 safe_rollback 恢复）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `文件路径（相对或绝对）。${PATH_HINT}` },
        content: { type: 'string', description: '完整文件内容' },
        overwrite: {
          type: 'boolean',
          // 默认值是**刻意的**，判据取自源（`_registry.py:1755-1759` 的 `default: False`、
          // 行为见 `tools/safe_write.py:137-161`）：缺省即"只许新建"，把"整篇覆盖"
          // 变成一个必须**说出口**的动作。见下面 handler 里那道门的注释。
          description: '文件已存在时是否覆盖；默认 false（不写，返回现有内容预览与下一步）',
        },
        encoding: {
          type: 'string',
          enum: ['auto', 'utf8', 'utf8-bom', 'utf16le', 'latin1'],
          description: '写入编码，默认 auto（沿用原文件编码；新文件为 utf8）',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    sideEffect: 'destructive',
    timeoutMs: 30_000,
    async handler(rawArgs: unknown, ctx: ToolContext) {
      const args = argsObject(rawArgs, 'safe_write');
      if (args === null) return invalidArgs('safe_write', '期望一个对象，例如 {"path": "a.ts", "content": ""}');
      const pathInput = readString(args, 'path');
      if (pathInput === null || pathInput === '') return invalidArgs('safe_write', '缺少 path');
      const content = readString(args, 'content');
      if (content === null) return invalidArgs('safe_write', '缺少 content（要写空文件请传 content:""）');
      const encodingArg = readOptionalString(args, 'encoding') ?? 'auto';
      // `readOptionalBool` 对非布尔值**静默当作没给**（返回 undefined）。对这一个参数不能这样：
      // `overwrite` 决定"要不要抹掉整篇"，把 'yes'/1/"true" 当成"没给"会得到一次
      // 看起来像参数错的拒绝，而真实原因是**她以为自己在说"覆盖"**——
      // 语义上这是"说了但不合法"，必须报参数错，不能悄悄降级成默认值。
      const overwriteRaw = args['overwrite'];
      if (overwriteRaw !== undefined && typeof overwriteRaw !== 'boolean') {
        return invalidArgs('safe_write', `overwrite 必须是布尔值（true/false），实际 ${JSON.stringify(overwriteRaw)}`);
      }
      const overwrite = overwriteRaw === true;

      const guarded = await resolveGuarded(env, ctx, pathInput, {
        purpose: 'safe_write',
        access: 'write',
        allowMissing: true,
      });
      if (!guarded.ok) return fail(guarded.code, guarded.reason);
      if (ctx.signal.aborted) return ABORTED_RESULT;

      // ── 只读区 / 受保护文件：**先于**体积门与覆盖门 ──
      //
      // 为什么单独在这里判一次（`guardedWrite` 第零步本来就有）：覆盖门会在"文件已存在
      // 且没给 overwrite"时先返回 FILE_EXISTS，而那会把 `data/persona/STATE.md` 这类
      // **只读资产**的真正理由（路径不许写）盖掉——模型收到"文件已存在，要不要 overwrite?"
      // 会以为"给了开关就能写"，而它其实永远不能写。**更严的判据必须先生效**。
      // 判据本身不另写一份：复用 `guardedWrite` 用的同两个来源（`readOnlyPrefixes`
      // 与 `protectedPaths`），消息也取同一份提示，避免两处口径漂移。
      const roPrefixOfWrite = readOnlyPrefixOfWrite(env.readOnlyPrefixes, guarded);
      if (roPrefixOfWrite !== null) {
        return fail(
          FS_ERROR_CODES.PATH_DENIED,
          `${guarded.relPath} 在只读区 ${roPrefixOfWrite}/ 内（模型可读、不可改）。`
          + (env.readOnlyHints[roPrefixOfWrite] ?? '要改它请走它自己的写通道，不要用通用文件工具。'),
        );
      }
      if (insideAny(env.protectedPaths, guarded.path)) {
        return fail(
          FS_ERROR_CODES.PATH_DENIED,
          `${guarded.relPath} 是受保护配置（对 agent 只读）：它定义的正是「谁能改我」，`
          + '由 agent 改写会让这道防护形同虚设，因此写入口直接拒绝。'
          + '要变更请由人修改该文件本体，重启后生效（读它不受限制）。',
        );
      }

      const read = await readTargetFile(guarded.path, env.maxEditBytes);
      if (read.error !== undefined) {
        return fail(read.code ?? FS_ERROR_CODES.IO_ERROR, `读取 ${guarded.relPath} 失败：${read.error}`);
      }

      // ── 覆盖门（照源 `tools/safe_write.py:137-161`）──
      //
      // 缺省**不覆盖已存在的文件**：返回现有内容预览 + 明确的下一步，一个字节都不写。
      // 判据取自源（那边的 `overwrite` 默认 False），理由也是源的：
      // `safe_write` 的定位是"新建"，而"整篇覆盖"是**最贵的一类失误**——模型想"改一部分"
      // 却调了 `safe_write`，一次调用就把没读过的内容全抹掉（本仓库的审计把它记成
      // docs/devkit-migration-audit.md §1 #3 的 S1 项）。旧实现无条件覆盖，等于把这道
      // 刹车拆了。**门要挡的是"没说出口的覆盖"**，不是"覆盖"本身：真要整体覆盖
      // （比如重写一份生成的配置文件），显式给 `overwrite:true` 就走下面那条正常链路
      // （备份 → 写入 → 语法检查 → 失败回滚）。
      //
      // 顺序：① 只读区/受保护（上面，更严的判据先生效）→ ② 体积门（读得到才知道
      // 文件存不存在）→ ③ 本门。反过来会让拒绝理由说谎。
      if (read.buffer !== null && !overwrite) {
        const existing = decodeTarget(read.buffer).text;
        const preview = existing
          .split('\n')
          .slice(0, 8)
          .map((line) => `    ${previewLine(line)}`);
        return fail(
          FS_ERROR_CODES.FILE_EXISTS,
          `${guarded.relPath} 已存在（${formatBytes(read.buffer.length)}），`
          + '默认不整体覆盖——本次调用没有写入任何内容。\n'
          + '现有内容前几行：\n'
          + `${preview.join('\n')}\n`
          + '下一步二选一：\n'
          + `  · 只想改其中一部分 → 用 safe_edit（给 old/new 局部替换）；\n`
          + `  · 确实要整篇重写 → 重新调 safe_write 并显式给 overwrite:true`
          + '（会先备份，之后可用 safe_rollback 退回）。',
        );
      }

      const originalEncoding: DetectedEncoding =
        read.buffer === null ? 'utf8' : decodeTarget(read.buffer).encoding;
      const requested: DetectedEncoding | null =
        encodingArg === 'utf8' || encodingArg === 'utf8-bom' || encodingArg === 'utf16le' || encodingArg === 'latin1'
          ? encodingArg
          : null;
      const encoding: DetectedEncoding = requested ?? originalEncoding;

      const target: WriteTarget = {
        path: guarded.path,
        relPath: guarded.relPath,
        inputPath: guarded.inputPath,
        text: content,
        original: read.buffer,
        encoding,
      };
      const result = await guardedWrite(env, ctx, [target]);
      if (!result.ok) return fail(result.code, result.message);

      const backup = result.backups[0];
      const verdict = result.verdicts[0];
      const notice = read.buffer === null ? '（新建文件）' : '（已覆盖，原内容已备份）';
      const lines = [
        `${guarded.relPath} 已写入${notice}`,
        `字节数 ${Buffer.byteLength(content, 'utf8')} · 编码 ${encoding}`,
        verdict === undefined ? '' : describeVerdict(verdict.verdict),
        backup === undefined ? '' : backupLine(backup.record.name, backup.created),
        snapshotLine(result.snapshotWarnings),
      ].filter((line) => line !== '');

      // 编码降级说明必须回给模型：它可能是下一次「内容看起来对但读出来不对」的线索
      const encodeNotes = encodeText(content, encoding).notes;
      return ok([...lines, ...encodeNotes.map((note) => `注意：${note}`)].join('\n'));
    },
  };
}

// ──────────────────────────────── safe_rollback ────────────────────────────────

export function createSafeRollbackTool(env: FsEnv): ToolDefinition {
  return {
    name: 'safe_rollback',
    description:
      '把文件回滚到指定或最近一次备份。回滚前会先给当前状态留快照，所以回滚本身也可回滚。' +
      'list:true 只列出备份，不做修改。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `文件路径（相对或绝对）。${PATH_HINT}` },
        backup: { type: 'string', description: '指定备份文件名（见 list:true 的输出）；省略则取最近一次' },
        list: { type: 'boolean', description: '只列出备份，不执行回滚' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    sideEffect: 'destructive',
    timeoutMs: 30_000,
    async handler(rawArgs: unknown, ctx: ToolContext) {
      const args = argsObject(rawArgs, 'safe_rollback');
      if (args === null) return invalidArgs('safe_rollback', '期望一个对象，例如 {"path": "a.ts"}');
      const pathInput = readString(args, 'path');
      if (pathInput === null || pathInput === '') return invalidArgs('safe_rollback', '缺少 path');
      const listOnly = readOptionalBool(args, 'list') ?? false;
      const wanted = readOptionalString(args, 'backup');

      const guarded = await resolveGuarded(env, ctx, pathInput, {
        purpose: 'safe_rollback',
        access: 'write',
        allowMissing: true,
      });
      if (!guarded.ok) return fail(guarded.code, guarded.reason);
      if (ctx.signal.aborted) return ABORTED_RESULT;

      const backupRoot = env.backupRoot(ctx);
      const all = await listBackups(backupRoot, ctx.workspaceRoot, guarded.path);

      if (listOnly) {
        if (all.length === 0) {
          return ok(`${guarded.relPath} 没有可用备份（备份根：${backupRoot}）`);
        }
        const rows = all.map((entry, index) => {
          const mark = index === 0 ? ' ← 最近' : '';
          return `  ${entry.name}  ${entry.bytes} B  ${entry.mtime}${mark}`;
        });
        return ok(`${guarded.relPath} 的备份（${all.length} 份，最多保留 ${env.backupKeep} 份）：\n${rows.join('\n')}`);
      }

      // 只读区（design §4.19 技能目录 / P2 的人格资产）：可读不可写，而回滚也是写操作。
      // list:true 已在上面返回（那是纯读），所以这里拦不到误伤。
      const roPrefix = readOnlyPrefixOfWrite(env.readOnlyPrefixes, guarded);
      if (roPrefix !== null) {
        return fail(
          FS_ERROR_CODES.PATH_DENIED,
          `${guarded.relPath} 在只读区 ${roPrefix}/ 内（可读、不可写）；回滚同样是写操作，被拒绝。`
          + (env.readOnlyHints[roPrefix] ?? '要改它请走它自己的写通道，不要用通用文件工具。'),
        );
      }

      if (all.length === 0) {
        return fail(
          FS_ERROR_CODES.NO_BACKUP,
          `${guarded.relPath} 没有可用备份。备份只在写工具执行时产生；若该文件从未被写工具改过，就用 safe_edit 直接改。`,
        );
      }
      const chosen = wanted === undefined || wanted === ''
        ? (all[0] as (typeof all)[number])
        : all.find((entry) => entry.name === wanted);
      if (chosen === undefined) {
        return fail(
          FS_ERROR_CODES.NO_BACKUP,
          `备份 ${wanted} 不存在。可用备份：\n${all.map((entry) => `  ${entry.name}`).join('\n')}`,
        );
      }

      const read = await readTargetFile(guarded.path, env.maxEditBytes);
      if (read.error !== undefined) {
        return fail(read.code ?? FS_ERROR_CODES.IO_ERROR, `读取 ${guarded.relPath} 失败：${read.error}`);
      }

      // 当前状态先快照：回滚本身也要可回滚，否则一次误回滚就永久丢内容
      let snapshotName = '(无需快照：文件当前不存在)';
      try {
        const snapshot = await createBackup(
          backupRoot,
          ctx.workspaceRoot,
          guarded.path,
          read.buffer,
          env.deps.now(),
          env.backupKeep,
        );
        snapshotName = snapshot.name;
      } catch (err) {
        return fail(
          FS_ERROR_CODES.WRITE_FAILED,
          `回滚前快照失败，已中止（不冒丢失当前内容的风险）：${toErrorMessage(err)}`,
        );
      }

      // 直接读备份文件内容并原子写回；不再过语法检查——回滚的语义是「回到已知状态」
      const backupContent = await readBackup(backupRoot, ctx.workspaceRoot, guarded.path, chosen.name);
      if (!backupContent.ok) return fail(FS_ERROR_CODES.NO_BACKUP, backupContent.reason);

      const restored = decodeText(backupContent.buffer);
      try {
        await atomicWrite(guarded.path, backupContent.buffer);
      } catch (err) {
        return fail(FS_ERROR_CODES.ROLLBACK_FAILED, `回滚写入失败：${toErrorMessage(err)}`);
      }

      return ok(
        [
          `${guarded.relPath} 已回滚到备份 ${chosen.name}`,
          `备份时间 ${chosen.mtime} · ${chosen.bytes} B`,
          `回滚前的当前状态已另存为快照：${snapshotName}（若回滚错了，再用 safe_rollback 指回它）`,
          `恢复内容按 ${restored.encoding} 解读。`,
        ].join('\n'),
      );
    },
  };
}

// ──────────────────────────────── multi_edit ────────────────────────────────

export function createMultiEditTool(env: FsEnv): ToolDefinition {
  return {
    name: 'multi_edit',
    description:
      '一次提交跨文件的多处替换，原子性：全部替换与语法检查都通过才落盘，任一失败则全量回滚'
      + '（落盘前自动留备份，可 safe_rollback 撤）。同一文件的多个 edits 按数组顺序叠加。'
      + '只改**已存在**的文件（新建用 safe_write）；edits 上限 200 项。',
    parameters: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          description: '编辑列表，按顺序应用；上限 200 项',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string', description: '文件路径（也可写作 filepath）；必须已存在' },
              filepath: { type: 'string', description: 'file 的别名' },
              old: { type: 'string', description: '要被替换的原文' },
              new: { type: 'string', description: '替换后的新文本' },
              replace_all: { type: 'boolean', description: '替换全部匹配，默认 false；与 occurrence 互斥' },
              occurrence: { type: 'integer', description: '只替换第 N 处匹配（1-based）；0 = 未指定（默认）' },
            },
            required: [],
            additionalProperties: false,
          },
        },
      },
      required: ['edits'],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    sideEffect: 'destructive',
    timeoutMs: 60_000,
    async handler(rawArgs: unknown, ctx: ToolContext) {
      const args = argsObject(rawArgs, 'multi_edit');
      if (args === null) return invalidArgs('multi_edit', '期望一个对象，例如 {"edits": [{"file": "a.ts", "old": "x", "new": "y"}]}');
      const rawEdits = args['edits'];
      if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
        return invalidArgs('multi_edit', 'edits 必须是非空数组');
      }
      if (rawEdits.length > 200) {
        return invalidArgs('multi_edit', `edits 最多 200 项，实际 ${rawEdits.length}；分批提交更容易定位失败点`);
      }

      // 按文件分组、组内保序：同一文件的多个编辑必须串行叠加，不能各自基于磁盘原文
      interface PendingFile {
        path: string;
        relPath: string;
        inputPath: string;
        text: string;
        encoding: WriteTarget['encoding'];
        original: Buffer | null;
        applied: number;
      }
      const files = new Map<string, PendingFile>();
      const order: string[] = [];

      for (let index = 0; index < rawEdits.length; index++) {
        const raw = rawEdits[index];
        const parsed = parseEditRequestFromUnknown(raw);
        if ('error' in parsed) return invalidArgs('multi_edit', `edits[${index}]：${parsed.error}`);
        if (!isRecord(raw)) return invalidArgs('multi_edit', `edits[${index}] 不是对象`);

        const fileInput = readString(raw, 'file') ?? readString(raw, 'filepath');
        if (fileInput === null || fileInput === '') {
          return invalidArgs('multi_edit', `edits[${index}] 缺少 file`);
        }

        let entry = files.get(fileInput);
        if (entry === undefined) {
          const guarded = await resolveGuarded(env, ctx, fileInput, { purpose: 'multi_edit', access: 'write' });
          if (!guarded.ok) {
            const hint = guarded.code === FS_ERROR_CODES.NOT_FOUND
              ? '；multi_edit 只改已存在的文件，新建文件请用 safe_write。'
              : '';
            return fail(guarded.code, `edits[${index}]（${fileInput}）被拒绝：${guarded.reason}${hint}`);
          }
          const read = await readTargetFile(guarded.path, env.maxEditBytes);
          if (read.error !== undefined) {
            return fail(read.code ?? FS_ERROR_CODES.IO_ERROR, `读取 ${guarded.relPath} 失败：${read.error}`);
          }
          if (read.buffer === null) {
            return fail(FS_ERROR_CODES.NOT_FOUND, `edits[${index}]：${guarded.relPath} 不存在；新建文件请用 safe_write。`);
          }
          const decoded = decodeTarget(read.buffer);
          entry = {
            path: guarded.path,
            relPath: guarded.relPath,
            inputPath: guarded.inputPath,
            text: decoded.text,
            encoding: decoded.encoding,
            original: read.buffer,
            applied: 0,
          };
          files.set(fileInput, entry);
          order.push(fileInput);
        }

        const plan = planEdit(entry.text, parsed);
        if (!plan.ok) {
          const extra = plan.matches === undefined
            ? ''
            : `\n命中位置：\n${plan.matches.map((m) => `  ${m.line}:${m.column}  ${m.preview}`).join('\n')}`;
          return fail(
            plan.code,
            `edits[${index}] 在 ${entry.relPath} 上失败：${plan.message}${extra}\n` +
              '本次所有编辑都已放弃（原子语义：一个失败，全部不落盘）。',
          );
        }
        entry.text = plan.text;
        entry.applied += 1;
      }

      if (ctx.signal.aborted) return ABORTED_RESULT;

      const targets: WriteTarget[] = order.map((key) => {
        const entry = files.get(key) as PendingFile;
        return {
          path: entry.path,
          relPath: entry.relPath,
          inputPath: entry.inputPath,
          text: entry.text,
          original: entry.original,
          encoding: entry.encoding,
        };
      });

      const result = await guardedWrite(env, ctx, targets);
      if (!result.ok) return fail(result.code, result.message);

      const rows = order.map((key, index) => {
        const entry = files.get(key) as PendingFile;
        const before = entry.original === null ? 0 : decodeText(entry.original).text.split('\n').length;
        const after = entry.text === '' ? 0 : entry.text.split('\n').length;
        const verdict = result.verdicts[index]?.verdict;
        return `  ${entry.relPath} · ${entry.applied} 处编辑 · 行数 ${before} → ${after} · ${verdict === undefined ? '' : describeVerdict(verdict)}`;
      });

      const backupRows = result.backups.map((backup) => `  ${backup.relPath} → ${backup.record.name}${backup.created ? '（新建前快照）' : ''}`);
      return ok(
        [
          `multi_edit 完成：${rawEdits.length} 处编辑 / ${order.length} 个文件`,
          ...rows,
          '备份：',
          ...backupRows,
          '如需撤销，对相应文件用 safe_rollback。',
        ].join('\n'),
      );
    },
  };
}
