/**
 * Irmia Agent — MCP 的申请单：她发起、用户只在界面点批准或驳回（2026-10-11）
 *
 * 用户原话（这一篇的全部理由）：
 * 「**我希望 skill 和 mcp 都尽量是 agent 自行增删。人类用户只做审批**」
 * 「她刚加入的 obscura，**索引内容质量低**。我觉得这东西得**要求 LLM 弄懂了加的是什么、
 *  用于什么，再自主填写**才对。（或者人添加时直接填写 desc）」
 *
 * ──────────────────────────── 五步流水（每一步都指到既有形状） ────────────────────────────
 *
 * ```
 * ① 她发起   写一份**申请单**到 <dataDir>/grants/<id>.json（`mcp` 入口的回执指路）
 *            —— **她不碰 config.json 一个字节**，这是"人类只做审批"那条边界
 * ② 待批     `RealLoop.settleGrants` 每拍扫一次那个目录（与 `mcpIndexSync` 同一拍，
 *            且在认领任何输入**之前**）⇒ `grant/requested`（internal，凭据）
 *            + `human/asked{source:'system'}`（**挂起**语义，与计划审批同一个坑位）
 * ③ 用户看   界面摆出来（`GET /api/grants` → 扩展页「待批」段 / 顶层批准卡）
 * ④ 用户点   `POST /api/commands/answer {askSeq, answer:'approve' | 'reject:<理由>'}`
 *            —— **复用既有答复通道**（`plan-mode.ts` 的 `answerHuman`），不新开一条
 * ⑤ 框架执行 `resolveGrant`（本模块）：批准 ⇒ 走**既有的受校验配置写入**
 *            （写 → `loadConfig` 复核 → 失败回滚原文 → 文件锁，只改 `mcp.servers[]` 那一段）
 *            ⇒ `grant/resolved`（执行结果另记一格）+ `wake/manual{via:'grant'}` 叫她一次
 * ```
 *
 * ──────────────────── 三条边界（每一条都在代码里落着，不是文档承诺） ────────────────────
 *
 * ① **申请单不是授权。** 目录是文件系统，谁能写谁就能放一张单子进去。授权**只有**人那一次
 *    点击：没有 `human/answered` 就没有落地动作（`resolveGrant` 只被 `answerHuman` 成功之后的
 *    那条路调用，见 `web/server.ts` 的 `grant-decide`）。
 * ② **白名单两面都判，一处都不放宽。** 她发起时判一次（`parseMcpServers` → 当场给她一句能
 *    读懂的错），框架落地时**再判一次**（单子可能在盘上躺了很久，`mcp.extraLaunchers` 可能
 *    已经变了）。第二次判的落点就是 `parseMcpServers` 本身——**没有第二条路**。
 * ③ **只改 `mcp.servers[]` 那一段。** 写盘走 `withGrantConfigDoc`（与 `web/server.ts` 的
 *    `withConfigDoc` **同一套纪律**：整份文档读出改再写回、保住人写的 `$comment`、写回后
 *    `loadConfig` 复核、失败回滚原文本、整段进 `configFileLock`）。
 *
 * ──────────────────── desc 为什么是必填（用户点名的第二件事） ────────────────────
 *
 * `mcp-add` 的申请单**必须**带 `desc`（"它是干什么的"），判据在 `mcp/description.ts` 的
 * `mcpDescProblem`：空 / 抄名字 / 太短 / 太长都当场退回去，回执里**要求她先弄懂再填**。
 * 理由就一条：那句话会**一直摆在她自己的常驻索引里**（`persona/assets.ts` 的
 * `mcpIndexLineOf`），而用户这一轮抱怨的正是"索引里看不出 obscura 是干什么的"。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { loadConfig } from '../config/config.ts';
import { configFileLock } from '../config/file-lock.ts';
import { writeFileAtomicSync } from '../web/atomic.ts';
import { MCP_NAME_PATTERN, parseMcpServers, type McpServerEntry } from '../mcp/client.ts';
import { checkStdioLauncher } from '../mcp/launcher-guard.ts';
import { mcpDescProblem, sanitizeMcpDescText } from '../mcp/description.ts';
import {
  applySkillGrant, parseSkillGrantRequest, skillGrantContextOf, skillGrantHash,
  skillGrantQuestionOf, skillGrantSummaryOf,
  type SkillGrantParse, type SkillGrantRequest,
} from './skill-grant.ts';
import { humanAskSourceOf, type AppEvent, type GrantKind, type GrantRequested, type GrantResolved } from '../log/types.ts';

// ──────────────────────────────── 常量与落点 ────────────────────────────────

/** 申请单目录（她写、框架读）：`<dataDir>/grants/` */
export const GRANTS_DIR_NAME = 'grants';

/**
 * 结局目录（**框架**写、她读）：`<dataDir>/grants-resolved/<id>.json`。
 *
 * 为什么不把结局写回申请单那个文件：申请单是**她**放的，框架不碰她的文件会更干净
 * （她的文件归她）；而且"这一张单子的结局是什么"本来就是两件事——单子写的是什么、
 * 人批没批。分开放之后，"谁写的"在路径上就看得出来。
 */
export const GRANTS_RESOLVED_DIR_NAME = 'grants-resolved';

/** 申请单文件名的形状：`<id>.json`（id 由她起，也是 `human/asked` 配对的凭据） */
const GRANT_FILE_RE = /^([A-Za-z0-9_-]{1,64})\.json$/u;

/** `human/asked` 那一问的**固定开头**（判"这条提问是不是一张待批的申请单"用，见 `isGrantQuestion`） */
export const GRANT_QUESTION_PREFIX = '批准';

/**
 * 单子里的 `reason` 长度上限（字符）。
 *
 * 它是一段**不可信文本**（会进卡面、也会进她下一拍的上下文），所以既要洗净又要封顶。
 * 640 与 `DISCARD_REASON_MAX`（500）同量级：写清"为什么想加它"够用了，
 * 超出的部分**截断并留可见标记**（不像 `desc` 那样退回——理由写长了不是错误）。
 */
export const GRANT_REASON_MAX = 640;

/** 驳回理由的长度上限（人物输入，超限**报错**而不是静默截断，同 `DISCARD_REASON_MAX` 的口径） */
export const GRANT_REJECT_REASON_MAX = 500;

export type GrantRejectReason =
  | 'bad-file' | 'bad-kind' | 'bad-name' | 'bad-request' | 'desc-missing' | 'launcher'
  | 'duplicate' | 'exists' | 'not-found' | 'stale' | 'write-failed';

/** 退回诊断那一行（两支共用：技能那支的 `reason` 是自由串，所以这里是 `string`） */
export interface GrantBounce {
  id: string;
  reason: string;
  detail: string;
}

/** 一条申请单在盘上的样子（**她写的那个文件**；字段校验见 [parseGrantRequest]） */
export interface GrantRequestFile {
  kind: GrantKind;
  name: string;
  desc?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  reason?: string;
}

/** 校验通过的申请单（**规范化之后**的那一份：字段裁好、理由洗净封顶） */
export interface GrantRequest {
  kind: GrantKind;
  name: string;
  desc: string;
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  disabled: boolean;
  reason: string;
}

export type GrantParse =
  | { ok: true; request: GrantRequest }
  | { ok: false; reason: GrantRejectReason; detail: string };

/**
 * 一条申请单是**哪一支**（2026-10-11 第二笔：技能那一支与 MCP 同一套形状、同一个信箱）。
 *
 * 为什么要这个判别函数而不是让调用点各自 `startsWith('skill-')`：`kind` 的合法取值只有这四格，
 * 而"哪一支"决定**用哪份校验器**——两处各判一次，加第五种 kind 时必有一处漏掉。
 */
export function grantBranchOf(kind: unknown): 'mcp' | 'skill' | null {
  if (kind === 'mcp-add' || kind === 'mcp-remove') return 'mcp';
  if (kind === 'skill-install' || kind === 'skill-remove') return 'skill';
  return null;
}

// ──────────────────────────────── 落点工具 ────────────────────────────────

export function grantsDirOf(dataDir: string): string {
  return join(dataDir, GRANTS_DIR_NAME);
}

export function grantsResolvedDirOf(dataDir: string): string {
  return join(dataDir, GRANTS_RESOLVED_DIR_NAME);
}

/**
 * 那张申请单在盘上的落点。
 *
 * ⚠ **本进程（框架）不写这个路径**——它是她被指路去写的地方（`mcp` 入口的回执里逐字给出）。
 * 这个函数存在的理由是**指路要一致**：回执里那句、管理面列出待批时那句、排障时读的那句，
 * 必须是同一串路径（三处各拼一遍迟早漂移）。
 */
export function grantPathOf(dataDir: string, id: string): string {
  return join(grantsDirOf(dataDir), `${id}.json`);
}

export function grantResolvedPathOf(dataDir: string, id: string): string {
  return join(grantsResolvedDirOf(dataDir), `${id}.json`);
}

/** 申请单目录在不在（`mcp` 入口的回执要给出一个**确定存在**的路径） */
export function ensureGrantsDir(dataDir: string): string | null {
  try {
    const dir = grantsDirOf(dataDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

// ──────────────────────────────── 洗净 ────────────────────────────────

/** 把一段不可信文本压成一行并封顶（超长**可见地**截断，绝不静默吞掉） */
export function sanitizeGrantLine(raw: string, max: number): string {
  const flat = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/[\s\u3000\u00a0]+/gu, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * 幂等键（与 `web/server.ts` / `main.ts` 里那个同名私有函数**逐字同形**）。
 *
 * 为什么在这里抄一份而不是导出那两处的一处：那两处各自是模块私有的（`main.ts` 的
 * `contentKey` 与 `web/server.ts` 的 `contentKey` 本来就抄了两遍）。它只有三行、**判据只有
 * "同一件事只叫一次"**，而跨模块把它抽出去要动两个文件的公开面——与本轮改动无关。
 * 若哪天它真成了第四份，那时再抽。
 */
function contentKey(prefix: string, text: string): string {
  return `${prefix}-${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)}`;
}

// ──────────────────────────────── 解析与校验 ────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * 校验一张申请单（**唯一实现**：拾取时调它，落地前再调一次）。
 *
 * 两条纪律：
 *   • **判据只有一处**：`mcp-add` 的 command/args/env 原样过 `parseMcpServers`
 *     （启动器白名单、禁内联执行、控制字符四层全部照旧生效）——**不因为她申请就放宽**；
 *   • **两面都判**（见文件头边界 ②）：这里的第二次判不是重复劳动，因为单子可能在盘上躺了很久。
 *
 * `desc` 是**必填**且要过 `mcpDescProblem`（用户点名的第二件事）——它对 `mcp-add` 判、
 * 对 `mcp-remove` 不判（删掉一个 server 不需要描述它）。
 */
export function parseGrantRequest(raw: unknown): GrantParse | SkillGrantParse {
  const record = asRecord(raw);
  if (record === null) return { ok: false, reason: 'bad-file', detail: '申请单的顶层必须是一个 JSON 对象' };
  // **两支共用同一个信箱与同一条审批通道**，只有校验器不同（2026-10-11 第二笔加技能那一支）。
  // 判别只此一处（`grantBranchOf`）：调用点各自 startsWith 一次，加第五种 kind 时必漏一处。
  const branch = grantBranchOf(record['kind']);
  if (branch === 'skill') return parseSkillGrantRequest(record);
  if (branch === null) {
    return {
      ok: false,
      reason: 'bad-kind',
      detail: 'kind 只能是 "mcp-add" / "mcp-remove" / "skill-install" / "skill-remove"，收到 '
        + `${typeof record['kind'] === 'string' ? `"${record['kind']}"` : String(record['kind'])}`,
    };
  }
  return parseMcpGrantRequest(record);
}

/** MCP 那一支的校验器（`parseGrantRequest` 按 `kind` 分派到它） */
export function parseMcpGrantRequest(record: Record<string, unknown>): GrantParse {
  const kindRaw = record['kind'];
  if (kindRaw !== 'mcp-add' && kindRaw !== 'mcp-remove') {
    return {
      ok: false,
      reason: 'bad-kind',
      detail: 'kind 只能是 "mcp-add" 或 "mcp-remove"，收到 '
        + `${typeof kindRaw === 'string' ? `"${kindRaw}"` : String(kindRaw)}`,
    };
  }
  const kind: GrantKind = kindRaw;

  const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
  if (!MCP_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      reason: 'bad-name',
      detail: 'name 必须匹配 ^[A-Za-z0-9_-]{1,128}$（只允许字母、数字、- 与 _），收到 '
        + `${typeof record['name'] === 'string' ? `"${record['name']}"` : String(record['name'])}`,
    };
  }

  const reasonRaw = typeof record['reason'] === 'string' ? record['reason'] : '';
  const reason = sanitizeGrantLine(reasonRaw, GRANT_REASON_MAX);
  const disabled = record['enabled'] === false;

  if (kind === 'mcp-remove') {
    // 删除：**只带名字**。多带的字段一律忽略（不报错——她的单子上多写一格不该让整件事作废），
    // 但落地那一步只按名字删那一条。
    return {
      ok: true,
      request: { kind, name, desc: '', command: '', args: [], env: {}, disabled: false, reason },
    };
  }

  const descRaw = typeof record['desc'] === 'string' ? record['desc'] : '';
  const descProblem = mcpDescProblem(name, descRaw);
  if (descProblem !== null) return { ok: false, reason: 'desc-missing', detail: descProblem };

  const command = typeof record['command'] === 'string' ? record['command'].trim() : '';
  if (command === '') {
    return { ok: false, reason: 'bad-request', detail: 'mcp-add 的 command 必须是非空字符串（要拉起的可执行程序）' };
  }
  const argsRaw = record['args'];
  let args: string[] = [];
  if (argsRaw !== undefined && argsRaw !== null) {
    if (!Array.isArray(argsRaw) || argsRaw.some((item) => typeof item !== 'string')) {
      return { ok: false, reason: 'bad-request', detail: 'args 必须是字符串数组（一行一个参数）' };
    }
    args = argsRaw as string[];
  }
  const envRaw = record['env'];
  let env: Record<string, string> = {};
  if (envRaw !== undefined && envRaw !== null) {
    const envRecord = asRecord(envRaw);
    if (envRecord === null || Object.values(envRecord).some((value) => typeof value !== 'string')) {
      return { ok: false, reason: 'bad-request', detail: 'env 必须是"变量名 → 字符串值"的对象' };
    }
    env = envRecord as Record<string, string>;
  }

  // ── 与界面那条路**同一把尺子**（`mcp-save` 落盘时走的就是这个函数）──
  //
  // 她申请时判一次：白名单、禁内联执行（`python -c` / `node -e` / `docker --network host`）、
  // args/env 里的控制字符，四层全部照旧生效。抛出来的 `McpConfigError` 自带下标定位，
  // 原样当 detail 回给她——**那句话就是她该读到的东西**（不必我们再译一遍）。
  const draft: Record<string, unknown> = { name, command };
  if (args.length > 0) draft['args'] = args;
  if (Object.keys(env).length > 0) draft['env'] = env;
  if (disabled) draft['disabled'] = true;
  draft['desc'] = sanitizeMcpDescText(descRaw);
  try {
    parseMcpServers([draft], 'grants.draft');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const launcher = /\.command/u.test(message) && /白名单|内联|启动器|放行/u.test(message);
    return { ok: false, reason: launcher ? 'launcher' : 'bad-request', detail: message };
  }

  return {
    ok: true,
    request: {
      kind, name,
      // 洗净之后再存（与 `parseMcpServers` 里那一格同一条口径：这一句会逐字节进索引）
      desc: sanitizeMcpDescText(descRaw),
      command, args, env, disabled, reason,
    },
  };
}

/**
 * 一张申请单的**内容指纹**：批准那一刻要重算一次（与 `grant/requested` 里那份比）。
 *
 * 五格进散列：`name` / `command` / `args` / `env` / `desc`。**刻意不含 `reason`**：
 * 理由是"她为什么想加它"，改一句理由不该让这张单子作废（而"要落地的那份声明"变了才该）。
 * 删除类没有内容可言 ⇒ 空串（判据是"这条还在不在"，那由落地的第二次复核负责）。
 */
export function grantContentHash(request: GrantRequest): string {
  if (request.kind !== 'mcp-add') return '';
  return contentKey('mcp-grant', JSON.stringify([
    request.name, request.command, [...request.args], request.env, request.desc,
  ]));
}

// ──────────────────────────────── 卡面（人看到的那两段话） ────────────────────────────────

/** `grantContentHash` 的两支入口（MCP 那支是它自己，技能那支在 `skill-grant.ts`） */
export function isMcpRequest(request: GrantRequest | SkillGrantRequest): request is GrantRequest {
  return request.kind === 'mcp-add' || request.kind === 'mcp-remove';
}

export function isSkillRequest(request: GrantRequest | SkillGrantRequest): request is SkillGrantRequest {
  return request.kind === 'skill-install' || request.kind === 'skill-remove';
}

/** 一张单子的内容指纹（按支分派；判据与理由各在各自那一份里） */
export function grantHashOf(request: GrantRequest | SkillGrantRequest): string {
  return isSkillRequest(request) ? skillGrantHash(request) : grantContentHash(request);
}

/** 人看到的那个问题（按支分派：`grantQuestionOf` / `skillGrantQuestionOf`） */
export function grantQuestionOfAny(request: GrantRequest | SkillGrantRequest): string {
  return isSkillRequest(request) ? skillGrantQuestionOf(request) : grantQuestionOf(request);
}

/** 卡面上那段上下（按支分派） */
export function grantContextOfAny(request: GrantRequest | SkillGrantRequest): string {
  return isSkillRequest(request) ? skillGrantContextOf(request) : grantContextOf(request);
}

/** `grantQuestionOf`：人看到的那个问题（**一进制**：事件、界面、回执读同一串字节） */
export function grantQuestionOf(request: GrantRequest): string {
  return request.kind === 'mcp-add'
    ? `${GRANT_QUESTION_PREFIX}加一个 MCP server「${request.name}」？`
    : `${GRANT_QUESTION_PREFIX}从配置里删掉 MCP server「${request.name}」？`;
}

/** 一条 `human/asked` 是不是一张待批申请单（判据只有这一处：固定开头，见 [GRANT_QUESTION_PREFIX]） */
export function isGrantQuestion(question: string): boolean {
  return question.startsWith(`${GRANT_QUESTION_PREFIX}加一个 MCP server「`)
    || question.startsWith(`${GRANT_QUESTION_PREFIX}从配置里删掉 MCP server「`);
}

/**
 * 那条命令**现在**过不过白名单（卡面"风险点"那一行的素材）。
 *
 * **不自己复写判据**：放行与否的唯一实现是 `checkStdioLauncher`——它给 `null` 就是放行，
 * 给一句话就是"为什么起不来"（那句话直接进卡面）。这里只把结论翻成一句给人看的话。
 *
 * 它同时是**第二次判**的落点之一（见文件头边界 ②）：`applyGrant` 在真写盘之前也会再问一次。
 */
export function launcherNoteOf(request: GrantRequest): string | null {
  if (request.kind !== 'mcp-add') return null;
  const problem = checkStdioLauncher(
    request.command,
    [...request.args],
    Object.keys(request.env).length === 0 ? undefined : request.env,
  );
  if (problem !== null) return `它的启动器**过不了白名单**（${problem}）——批准了也起不来。`;
  if (Object.keys(request.env).length > 0) {
    return '它会拿到单子里写的那几个环境变量，而 MCP 进程**不受 trust.mode 约束**'
      + '（它可以碰这台机器上任何它有权限碰的东西）。';
  }
  return null;
}

/**
 * 卡面上那段上下（`human/asked.context`，也是界面那一段的同一份素材）。
 *
 * **每一个字都是框架算出来的**（她的原话只出现在"她写的理由"那一行，而且已洗净）：
 * 这条纪律与人格提案、`ask_human` 那两条同源（design §6 防伪——不许她自定义卡面上的话）。
 *
 * 四段固定顺序：它会做什么 / 合成什么样 / 风险点 / 不点会怎样。
 * `desc` 那一句摆在最前（"它是干什么的"是决定要不要批的第一件事），
 * 后面才是命令与风险——用户这一轮抱怨的正是"审批时看不出它是干什么的"。
 */
export function grantContextOf(request: GrantRequest): string {
  const lines: string[] = [];
  if (request.kind === 'mcp-add') {
    lines.push(`它会做什么：${request.desc}`);
    const argv = [request.command, ...request.args].join(' ');
    lines.push(`启动：${argv}${request.disabled ? '（单子里写着停用：加进去但不起进程）' : ''}`);
    const envKeys = Object.keys(request.env);
    if (envKeys.length > 0) {
      // **只给变量名，绝不回显值**（值里可能有密钥——与 `/api/keys` 同一口径）
      lines.push(`它还会拿到这几个环境变量（值不回显）：${envKeys.join('、')}`);
    }
    const risk = launcherNoteOf(request);
    if (risk !== null) lines.push(`风险点：${risk}`);
    lines.push(
      '批准之后：只改 config.json 的 mcp.servers[] 那一段（写回后立刻校验，失败回滚原文件）；'
      + '她的常驻索引里从下一次重大变化起会出现上面那句"它会做什么"。'
      + 'MCP 池在启动期建好 ⇒ 重启主进程之后才真的拉起它。',
    );
  } else {
    lines.push(
      `它会删掉：config.json 的 mcp.servers[] 里名为「${request.name}」的那一条`
      + '（其余字段与别的 server 一条都不动）。',
    );
    lines.push(
      '批准之后：走同一条受校验的配置写入（写回后立刻校验，失败回滚原文件）。'
      + '重启主进程之后她的 mcp 工具里不再有它。',
    );
  }
  if (request.reason !== '') lines.push(`她写的理由：${request.reason}`);
  lines.push('不点会怎样：超时只落一条「未批准、未拒绝」的事实，这张单子原地不动，你回来照样能批。');
  return lines.join('\n');
}

// ──────────────────────────────── 读盘 ────────────────────────────────

/** 一张申请单在盘上的样子 + 它的结局（`GET /api/grants` 与界面待批段的素材） */
export interface GrantListItem {
  id: string;
  kind: GrantKind;
  name: string;
  desc: string;
  command: string;
  args: readonly string[];
  envKeys: readonly string[];
  disabled: boolean;
  /** 技能那一支：`scripts/` 下那些**可执行内容**的名字（MCP 那一支恒为空） */
  scriptNames: readonly string[];
  /** 技能那一支：随包带几个文件（MCP 那一支恒为 0） */
  fileCount: number;
  reason: string;
  question: string;
  context: string;
  /** 挂着它的是哪一条 `human/asked`（事件里那一格；老事件缺它时为 null） */
  askSeq: number | null;
  /** 那张卡超时了没有（`human/expired` 折出来的；超时**不是决定**，卡照旧有效） */
  expiredAt: string | null;
  /** 她递单子的时刻（`grant/requested.ts`；还没被拾取时为 null） */
  requestedAt: string | null;
  /** 已经落地的结局（还没答复时为 null） */
  outcome: 'approved' | 'rejected' | null;
  outcomeAt: string | null;
  /** 驳回了的话，人写的那句理由（**允许为空**：留空时说"人没给理由"是她的回执那一侧的事） */
  rejectReason: string | null;
  exec: { state: string; failure?: string; landed?: string } | null;
  /**
   * 单子**已经落地成 `grant/requested`** 了吗。
   *
   * `false` = 盘上有文件、日志里还没有那条事件（她刚写完的那一小段窗口，或它压根没通过校验）。
   * 这一格刻意**不去读那个文件**：管理面只报"日志里有什么"，读单子内容是拾取那一步的事
   * ——两处都读，就会出现"界面说他批的是 A、日志说批的是 B"。
   */
  picked: boolean;
}

/** 读一份申请单文件（**永不抛**：读不动就是"这一份不算数"，由调用方如实说） */
export function readGrantFile(dataDir: string, id: string): { raw: unknown; text: string } | null {
  try {
    const text = readFileSync(grantPathOf(dataDir, id), 'utf8');
    return { raw: JSON.parse(text) as unknown, text };
  } catch {
    return null;
  }
}

/** 目录里的申请单 id（读不到目录 = 一张都没有，不是错误） */
export function grantIdsOnDisk(dataDir: string): string[] {
  try {
    return readdirSync(grantsDirOf(dataDir))
      .map((name) => GRANT_FILE_RE.exec(name)?.[1])
      .filter((id): id is string => id !== undefined)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 把日志里的 `grant/*` 两条事件与盘上的单子对起来，给出**管理面要的那一份清单**。
 *
 * 判据取事件（`grant/requested` 是"她递过这张单子"的唯一凭据），盘上那份只用来补
 * "还没被拾取"那一段窗口。**一条都不编**：`picked: false` 的那些只有 id，内容一格不猜
 * （要说什么都得先有事件——那条事件才是"申请的是什么"的凭据）。
 *
 * 排序：**还没答复的在前**（按递单先后），已答复的在后（按结局先后）——界面上
 * 人最该先看到的就是等他点头的那几张。
 */
export function listGrants(
  dataDir: string,
  events: readonly AppEvent[],
  asks: readonly { seq: number; question: string; at: string; expiredAt: string | null }[],
): GrantListItem[] {
  const requested = new Map<string, GrantRequested>();
  const resolved = new Map<string, GrantResolved>();
  for (const event of events) {
    if (event.type === 'grant/requested') requested.set(event.data.id, event);
    else if (event.type === 'grant/resolved') resolved.set(event.data.id, event);
  }
  const ids = [...new Set([...requested.keys(), ...grantIdsOnDisk(dataDir)])];

  const out: GrantListItem[] = ids.map((id) => {
    const event = requested.get(id) ?? null;
    const done = resolved.get(id) ?? null;
    const askSeq = event === null ? null : event.data.askSeq;
    const askRow = askSeq === null ? null : asks.find((item) => item.seq === askSeq) ?? null;
    return {
      id,
      kind: event?.data.kind ?? 'mcp-add',
      name: event?.data.name ?? id,
      // 那一句"它是干什么的"：MCP 用 `desc`、技能用 frontmatter 的 `description`
      // ——两支在界面上是**同一个位置**（标题下面第一句），所以在这里合成一格。
      // 界面因此不必按 kind 分叉去读两个字段名（一处口径）。
      desc: (event?.data.desc ?? '') !== '' ? event!.data.desc! : (event?.data.skillDescription ?? ''),
      command: event?.data.command ?? '',
      args: event?.data.args ?? [],
      envKeys: event?.data.envKeys ?? [],
      disabled: event?.data.disabled === true,
      // 技能那一支的风险点（`scripts/` 下那些**可执行内容**）：单独一格给界面，
      // 让它能像 MCP 的命令那样**单列一行**（方案稿 D8：那是装技能最要紧的一句话）
      scriptNames: event?.data.skillScriptNames ?? [],
      fileCount: event?.data.skillFileCount ?? 0,
      reason: event?.data.reason ?? '',
      question: event?.data.question ?? '',
      context: event?.data.context ?? '',
      askSeq,
      expiredAt: askRow?.expiredAt ?? null,
      requestedAt: event?.ts ?? null,
      outcome: done?.data.outcome ?? null,
      outcomeAt: done?.ts ?? null,
      rejectReason: done?.data.reason ?? null,
      exec: done === null ? null : { ...done.data.exec },
      picked: event !== null,
    };
  });

  out.sort((a, b) => {
    const aDone = a.outcome === null ? 0 : 1;
    const bDone = b.outcome === null ? 0 : 1;
    if (aDone !== bDone) return aDone - bDone;
    return (a.requestedAt ?? '').localeCompare(b.requestedAt ?? '') || a.id.localeCompare(b.id);
  });
  return out;
}

// ──────────────────────────────── 拾取（②：她递的单子变成一条待批） ────────────────────────────────

/** 拾取结果（`settleGrants` 的返回：进了几条、退回了哪几条、哪些还在等人点头） */
export interface SettleGrantsResult {
  /** 这一拍新挂出来的申请单（写完 `human/asked` 的那些） */
  raised: GrantRequested[];
  /** 这一拍**当场退回**的（没通过校验，或同一件事已经有一张在等人点头） */
  bounced: GrantBounce[];
  /** 台面上还等着人点头的申请单 id（回复或超时之后才出队，这里只如实报"有几张挂着"） */
  open: string[];
}

/**
 * 拾取一轮：把 `data/grants/` 里**还没进过日志**的单子变成待批。
 *
 * 由 `RealLoop.settleGrants` 在每一拍调用（在认领任何输入**之前**，与 `mcpIndexSync` 同拍）。
 *
 * ──────────────────── 四条判据（每一条都对应一种真实的坏形状） ────────────────────
 *
 * ① **幂等靠事件状态**，不靠内存记账：已有一条 `grant/requested{id}` 的单子**跳过**
 *    （进程重启、目录被重复扫到，都不会再挂一张）。
 * ② **同一件事只问一次**（照 `plan-mode.ts` 那句「人只该被问一次」）：同一时刻同一个
 *    `kind+name` 只允许一张未决申请单。第二张**当场退回**（`grant/resolved` +
 *    `outcome:'rejected'`），理由里带上第一张的 id——**不给它挂卡**：挂上去就是让人
 *    对同一件事点两次头，而那两次点头之间配置只会变一次。
 * ③ **判不过的单子当场退回，不挂卡**：一张点不动的卡会把整条队列堵住（人点它只会拿到
 *    一句错），而她自己也不知道哪里写错了——退回时把 `parseGrantRequest` 的那句话原样给她。
 * ④ **`human/asked` 用 `source: 'system'`**（挂起语义，与计划审批同一条）。提问与上下文
 *    由本模块拼（`grantQuestionOf` / `grantContextOf`），**一个字都不来自她的原话**
 *    （除了"她写的理由"那一行，且已洗净）。
 *
 * 返回的这一份只用于诊断与测试（生产调用点不需要它）。
 */
export function settleGrants(input: {
  dataDir: string;
  events: readonly AppEvent[];
  /** 台面上还没答复的 `human/asked`（投影里的那一份；判"同一件事只问一次"用） */
  openAsks: readonly { seq: number; question: string; at: string; expiredAt: string | null }[];
  /** 事件写入通道（调用方保证 `sync: true`）。返回新事件的 seq */
  write: (type: string, data: unknown) => number;
  /** 这一拍是第几个 turn（`human/asked.turn` 那一格；没有 turn 时给 0） */
  turn: number;
}): SettleGrantsResult {
  const seen = new Set<string>();
  const done = new Set<string>();
  /** 还没答复的申请单：`kind|name` → id（判"同一件事只问一次"） */
  const openByKey = new Map<string, string>();
  const resolvedIds = new Set<string>();
  for (const event of input.events) {
    if (event.type === 'grant/requested') {
      seen.add(event.data.id);
      openByKey.set(`${event.data.kind}|${event.data.name}`, event.data.id);
    } else if (event.type === 'grant/resolved') {
      resolvedIds.add(event.data.id);
      done.add(event.data.id);
      const key = `${event.data.kind}|${event.data.name}`;
      if (openByKey.get(key) === event.data.id) openByKey.delete(key);
    }
  }
  // 台面上还挂着的（那一条 `human/asked` 还在投影里）才算"未决"——答复过/超时出队的都要放掉
  for (const [key, id] of [...openByKey]) {
    const event = input.events.find(
      (item): item is GrantRequested => item.type === 'grant/requested' && item.data.id === id,
    );
    const stillOpen = event !== undefined
      && input.openAsks.some((ask) => ask.seq === event.data.askSeq);
    if (!stillOpen) openByKey.delete(key);
  }

  const result: SettleGrantsResult = { raised: [], bounced: [], open: [...openByKey.values()] };

  for (const id of grantIdsOnDisk(input.dataDir)) {
    if (seen.has(id)) continue;
    const file = readGrantFile(input.dataDir, id);
    if (file === null) {
      // 读不动（半截文件 / JSON 坏了）：**不挂卡**（挂一张点不动的卡没有意义），当场退回。
      // 文件原样留在盘上（那是她的东西，框架不删）——下一拍若她写全了，照样会被拾取。
      input.write('grant/resolved', {
        id, askSeq: 0, kind: 'mcp-add', name: id, outcome: 'rejected', by: 'framework',
        reason: null, contentHash: '',
        exec: { state: 'skipped-invalid', failure: `申请单读不动或不是合法 JSON：${grantPathOf(input.dataDir, id)}` },
      } satisfies GrantResolved['data']);
      result.bounced.push({ id, reason: 'bad-file', detail: '申请单读不动或不是合法 JSON' });
      continue;
    }
    const parsed = parseGrantRequest(file.raw);
    if (!parsed.ok) {
      input.write('grant/resolved', {
        id, askSeq: 0, kind: 'mcp-add', name: id, outcome: 'rejected', by: 'framework',
        reason: null, contentHash: '',
        exec: { state: 'skipped-invalid', failure: parsed.detail },
      } satisfies GrantResolved['data']);
      // `reason` 那一格两支各有自己的取值集合（MCP 那支是 `GrantRejectReason`，技能那支是自由串）
      // ⇒ 诊断那一行按 `string` 收，不做无谓收窄
      result.bounced.push({ id, reason: String(parsed.reason), detail: parsed.detail });
      continue;
    }
    const request = parsed.request;
    const key = `${request.kind}|${request.name}`;
    const existing = openByKey.get(key);
    if (existing !== undefined && existing !== id) {
      // ② 同一件事只问一次：**不挂第二张卡**，当场退回并指回第一张
      const detail = `同一件事已经有一张单子在等人点头了（id=${existing}）：`
        + '不要重复递单，人只该被问一次。要改内容就先把那一张撤掉（删掉它的文件）再递一张新的。';
      input.write('grant/resolved', {
        id, askSeq: 0, kind: request.kind, name: request.name, outcome: 'rejected', by: 'framework',
        reason: null, contentHash: grantHashOf(request),
        exec: { state: 'skipped-invalid', failure: detail },
      } satisfies GrantResolved['data']);
      result.bounced.push({ id, reason: 'duplicate', detail });
      continue;
    }

    const question = grantQuestionOfAny(request);
    const context = grantContextOfAny(request);
    const askSeq = input.write('human/asked', {
      question,
      context,
      turn: input.turn,
      // **系统来源**：挂起语义（与计划审批同一条）。设计 §6：这一支才是"等她点头"，
      // 她自己问的那些 (`source: 'agent'`) 不挂起。
      source: humanAskSourceOf({ source: 'system' }),
    });
    const data: GrantRequested['data'] = {
      id, kind: request.kind, name: request.name, by: 'agent',
      contentHash: grantHashOf(request),
      path: grantPathOf(input.dataDir, id),
      reason: request.reason,
      turn: input.turn,
      question,
      context,
      // MCP 那几格（技能那一支留空 —— 事件形状共用一份，见 `GrantRequested` 的注释）
      desc: isMcpRequest(request) ? request.desc : '',
      command: isMcpRequest(request) ? request.command : '',
      args: isMcpRequest(request) ? [...request.args] : [],
      envKeys: isMcpRequest(request) ? Object.keys(request.env) : [],
      disabled: isMcpRequest(request) ? request.disabled : false,
      // 技能那几格（摘要进事件、正文与文件**不进**：内容在申请单那份文件里）
      ...(isSkillRequest(request) ? skillGrantSummaryOf(request) : {}),
      askSeq,
    };
    input.write('grant/requested', data satisfies GrantRequested['data']);
    const raised = {
      // 只填诊断用得到的那几格（完整事件由日志持有）
      seq: askSeq, ts: '', visibility: 'internal', type: 'grant/requested', data,
    } as GrantRequested;
    result.raised.push(raised);
    result.open.push(id);
    openByKey.set(key, id);
  }
  return result;
}

// ──────────────────────────────── 落地（**批准之后**才走这里） ────────────────────────────────

/**
 * 在**整份 config.json 文档**上做一次受校验的修改（与 `web/server.ts` 的 `withConfigDoc`
 * **同一套纪律**，一字不差：整份读出改再写回、保住人写的 `$comment`、写回后 `loadConfig`
 * 复核、失败回滚原文本、整段进 `configFileLock`）。
 *
 * 为什么这里又写了一份而不是把 `web/server.ts` 那个 `private` 方法搬出来共用：
 * 它是 `IrmiaWebServer` 的私有方法（要 `this.configPath`），而这条通道的调用方在
 * **服务端命令处理里**——共用就得先把那个类拆开，代价远大于这 30 行。
 * ⚠ **锁是同一个**（`configFileLock` 从 `web/server.ts` 导入，那个实例就是 `withConfigDoc`
 * 用的那一个）：两条路因此排在**同一个队列**里，不存在"两个锁各写各的"那个经典洞。
 * ⇒ 改动这里时请对照 `web/server.ts` 的 `withConfigDoc`，两处的纪律必须一起改。
 */
export async function withGrantConfigDoc(
  configPath: string,
  mutate: (doc: Record<string, unknown>) => void,
): Promise<void> {
  await configFileLock(async () => {
    let original: string;
    try {
      original = readFileSync(configPath, 'utf8');
    } catch (err) {
      throw new Error(`读不到配置文件 ${configPath}：${err instanceof Error ? err.message : String(err)}`);
    }
    let doc: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(original);
      const record = asRecord(parsed);
      if (record === null) throw new Error('顶层不是 JSON 对象');
      doc = record;
    } catch (err) {
      throw new Error(`配置文件不是合法 JSON，拒绝在其上做修改：${err instanceof Error ? err.message : String(err)}`);
    }

    mutate(doc);
    writeFileAtomicSync(configPath, `${JSON.stringify(doc, null, 2)}\n`);
    try {
      // 写回后**立刻复核**：MCP 配置写错会让下次启动整个配置校验失败（`parseMcpServers` 类型不对就抛），
      // 把非法值留在盘上等于"起不来"。失败 ⇒ 回滚原文本（一个字都不留）。
      await loadConfig(join(configPath, '..'));
    } catch (err) {
      writeFileAtomicSync(configPath, original);
      throw new Error(`配置校验失败，已回滚到改动前的版本：${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/**
 * 那一段 `mcp.servers[]` 的**就地改**（`withGrantConfigDoc` 的 mutate）。
 *
 * 两条分寸与 `mcp-save` / `mcp-remove` 完全一致：
 *   • **就地改活数组**（`splice` / `push`）而不是"换一个新数组"——回滚语义依赖它，
 *     而且新增一条时**不动别的条目**（未在界面上暴露的字段 cwd / toolDefaults / tools
 *     一个都不许顺手抹掉）；
 *   • **没有 `servers` 数组时新建一个**（老配置里可能压根没有 `mcp` 段——现场那份就没有）。
 *
 * 返回 true = 真的改了（新增成功 / 删掉了一条），false = 无事可做（已有同名 / 本来就没有）。
 */
export function applyGrantToConfigDoc(doc: Record<string, unknown>, request: GrantRequest): boolean {
  const mcp = asRecord(doc['mcp']);
  const section: Record<string, unknown> = mcp ?? {};
  if (mcp === null) doc['mcp'] = section;
  const rawServers = section['servers'];
  const servers: unknown[] = Array.isArray(rawServers) ? rawServers : [];
  if (!Array.isArray(rawServers)) section['servers'] = servers;

  const index = servers.findIndex((item) => asRecord(item)?.['name'] === request.name);
  if (request.kind === 'mcp-add') {
    // 已经有一条同名的 ⇒ **不覆盖**（她的申请单不是"编辑"通道：覆盖会把她没在单子里写的
    // 那几格——cwd / toolDefaults / tools / 超时——一起抹掉，而单子里根本没有那几格）。
    if (index >= 0) return false;
    const entry: Record<string, unknown> = { name: request.name, command: request.command };
    if (request.args.length > 0) entry['args'] = [...request.args];
    if (Object.keys(request.env).length > 0) entry['env'] = { ...request.env };
    if (request.disabled) entry['disabled'] = true;
    entry['desc'] = request.desc;
    servers.push(entry);
    return true;
  }
  if (index < 0) return false;
  servers.splice(index, 1);
  return true;
}

/** 落地结果（`grant/resolved.exec` 那一格；`not-applicable` = 驳回了，压根没有执行这一步） */
export interface GrantApplyResult {
  state: 'ok' | 'failed' | 'skipped-stale' | 'skipped-invalid' | 'not-applicable';
  failure?: string;
  landed?: string;
}

/**
 * 把一张**获准**的申请单落地。
 *
 * 顺序是判据（**判在前、写在后**）：
 *   ① 重新读出单子（**以盘上那一份为准**——它在审阅期间可能被改过）；
 *   ② 校验（第二次过白名单，见文件头边界 ②）；
 *   ③ **重算指纹**并与她发起时那份比 ⇒ 不一致就 `skipped-stale`（照人格提案的
 *      `stale-proposal` 那条 409）；
 *   ④ 写盘（`withGrantConfigDoc` + `applyGrantToConfigDoc`，只改 `mcp.servers[]` 那一段）；
 *   ⑤ 回读一次确认（"它真的在 / 真的没了"）。
 */
export async function applyGrant(input: {
  dataDir: string;
  configPath: string;
  id: string;
  /** `grant/requested.contentHash` 那一格（她发起时算的那份指纹） */
  requestedHash: string;
  /**
   * 技能那一支的落地根（`skills/` 的基准目录 = 项目根）。
   *
   * 为什么由调用方给：这一层（`mcp-grant.ts`）不该知道"技能根在哪"——那是装配点的事，
   * 而且它与 `config.json` 那条路完全无关。不给 + 单子是技能那一支 ⇒ `failed`，并说清楚
   * （**不编一个根出来**：写错地方比不写坏得多）。
   */
  skillsRoot?: string;
  /** "现在几点"（回收站那一格时间戳用）；缺省走系统时钟 */
  now?: () => Date;
}): Promise<GrantApplyResult> {
  const file = readGrantFile(input.dataDir, input.id);
  if (file === null) {
    return {
      state: 'skipped-invalid',
      failure: `申请单不在了或读不动：${grantPathOf(input.dataDir, input.id)}。`
        + '（单子可能被撤掉了，也可能从来就没写全。）这次批准没有改任何配置。',
    };
  }
  const parsed = parseGrantRequest(file.raw);
  if (!parsed.ok) {
    return { state: 'skipped-invalid', failure: `申请单现在过不了校验，拒绝执行：${parsed.detail}` };
  }
  const request = parsed.request;

  // ── 指纹（两支共用同一条纪律，各用各的散列）──
  const hash = grantHashOf(request);
  if (input.requestedHash !== '' && hash !== input.requestedHash) {
    return {
      state: 'skipped-stale',
      failure: '这份申请单的内容在你看它的期间被改过（内容指纹对不上），所以**没有**落地。'
        + '如果那份改动是你要的，请让她照现在的样子重发一张单子。',
    };
  }

  // ── 技能那一支：走 `skill-grant.ts`（建目录 / 写 SKILL.md / 回收站那条既有语义）──
  if (isSkillRequest(request)) {
    if (input.skillsRoot === undefined) {
      return {
        state: 'failed',
        failure: '技能那一支要落地，但调用方没有给技能根（`skillsRoot`）：这次批准没有动任何文件。',
      };
    }
    return applySkillGrant({
      dataDir: input.dataDir,
      baseRoot: input.skillsRoot,
      request,
      now: input.now ?? (() => new Date()),
    });
  }

  let already: 'exists' | 'not-found' | null = null;
  try {
    let changed = false;
    await withGrantConfigDoc(input.configPath, (doc) => {
      const raw = asRecord(doc['mcp'])?.['servers'];
      const before = Array.isArray(raw) ? raw : [];
      const exists = before.some((item) => asRecord(item)?.['name'] === request.name);
      if (request.kind === 'mcp-add' && exists) { already = 'exists'; return; }
      if (request.kind === 'mcp-remove' && !exists) { already = 'not-found'; return; }
      changed = applyGrantToConfigDoc(doc, request);
    });
    if (!changed) {
      if (already === 'exists') {
        return {
          state: 'skipped-invalid',
          failure: `config.json 的 mcp.servers[] 里**已经有一条**叫「${request.name}」的了：这次批准没有覆盖它`
            + '（申请单不是编辑通道——覆盖会把它没写进单子里的那几格一起抹掉）。要看现状走界面「扩展 → MCP」。',
        };
      }
      if (already === 'not-found') {
        return {
          state: 'skipped-invalid',
          failure: `config.json 的 mcp.servers[] 里**没有**叫「${request.name}」的条目了：这次批准没有改任何东西`
            + '（可能已经有人删过，或它本来就不在那份配置里）。',
        };
      }
      return { state: 'failed', failure: `写 config.json 时没有产生任何改动（${request.kind}「${request.name}」）——配置未被修改。` };
    }
  } catch (err) {
    return { state: 'failed', failure: err instanceof Error ? err.message : String(err) };
  }

  // 回读一次：盘上现在是什么（`withGrantConfigDoc` 已经在写回后 `loadConfig` 复核过，
  // 这一跳是"真落地了没有"的最后一道自查；读不动不算失败——写盘那一步已经成功了）
  const landed = readConfiguredServerNames(input.configPath);
  if (landed !== null) {
    const present = landed.includes(request.name);
    if (request.kind === 'mcp-add' && !present) {
      return { state: 'failed', failure: `写盘成功但回读时 mcp.servers[] 里没有「${request.name}」——配置可能被并发改过，请重看一眼。` };
    }
    if (request.kind === 'mcp-remove' && present) {
      return { state: 'failed', failure: `写盘成功但回读时 mcp.servers[] 里**还有**「${request.name}」——配置可能被并发改过，请重看一眼。` };
    }
  }
  return { state: 'ok', landed: request.name };
}

/** 盘上那份 `mcp.servers[].name`（读不动给 null，不编） */
export function readConfiguredServerNames(configPath: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    const servers = asRecord(asRecord(parsed)?.['mcp'])?.['servers'];
    if (!Array.isArray(servers)) return [];
    return servers
      .map((item) => asRecord(item)?.['name'])
      .filter((name): name is string => typeof name === 'string');
  } catch {
    return null;
  }
}

/** 盘上那条 server 声明（落地之后把它的 `desc` 回读出来给她看：索引里会多哪一句话） */
export function readConfiguredServer(configPath: string, name: string): McpServerEntry | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    const servers = asRecord(asRecord(parsed)?.['mcp'])?.['servers'];
    return parseMcpServers(servers).find((entry) => entry.name === name) ?? null;
  } catch {
    return null;
  }
}

// ──────────────────────────────── 结局：落盘 + 回执 + 唤醒 ────────────────────────────────

/**
 * 把结局写一份到她读得到的地方：`<dataDir>/grants-resolved/<id>.json`。
 *
 * **这条写入永远不许影响决定本身**（与 `wakeForMcpChange` 的"发不出去不许把成功的落地
 * 变成 500"同一条纪律）：写不动就返回 false，由调用方在回执里如实说"那一份没写上"。
 */
export function writeGrantOutcome(dataDir: string, payload: Record<string, unknown>): boolean {
  try {
    mkdirSync(grantsResolvedDirOf(dataDir), { recursive: true });
    const id = typeof payload['id'] === 'string' ? payload['id'] : 'unknown';
    writeFileSync(grantResolvedPathOf(dataDir, id), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** `wake/manual` 那一句 note 的素材（**她读到的第一句**：批了还是驳了、落地了没有） */
export interface GrantWakeFacts {
  id: string;
  kind: GrantKind;
  name: string;
  outcome: 'approved' | 'rejected';
  /** 人写的驳回理由（**允许为空**：那时照实说"没给理由"，不许编一句） */
  reason: string | null;
  exec: GrantExecFacts;
}

export interface GrantExecFacts {
  state: 'ok' | 'failed' | 'skipped-stale' | 'skipped-invalid' | 'not-applicable';
  failure?: string;
  landed?: string;
}

/** 被她读的那句话（人类写的理由已洗净：它进的是**一行**上下文） */
export function grantWakeNoteOf(facts: GrantWakeFacts): string {
  const what = facts.kind === 'mcp-add' ? `加 MCP server「${facts.name}」` : `删 MCP server「${facts.name}」`;
  if (facts.outcome === 'rejected') {
    // 驳回：三件事都要说清（①这是人的决定 ②他没写理由也别当成"没人理" ③下一步怎么做）
    const reason = facts.reason === null || facts.reason === ''
      ? '他**没有写理由**——这是他的决定，不是没人理你。'
      : `他写的理由是：「${facts.reason}」。`;
    return `你那张申请单（${what}，id=${facts.id}）**被驳回了**。${reason}`
      + '这是否决，不要再自行去做这件事；要再提，先把理由里的问题解决掉，或者换个做法重提一张单子。';
  }
  if (facts.exec.state === 'ok') {
    return `你那张申请单（${what}，id=${facts.id}）**已被批准并且执行成功**：`
      + `那一句"它是干什么的"已经和它一起写进 config.json 的 mcp.servers[]（${facts.exec.landed ?? facts.name}）。`
      + 'MCP 池在启动期建好 ⇒ **下次重启进程之后**它才会被真的拉起；在那之前 mcp 工具里看不到它。'
      + '你的常驻索引不会立刻改字节（索引只在重大变化点归集，加删 server 走的是尾部追加）。';
  }
  return `你那张申请单（${what}，id=${facts.id}）**已被批准，但执行没有成功**：`
    + `${facts.exec.failure ?? '框架没给出原因。'}`
    + '这不是"被驳回"，也不是"已经装好了"——要接着办就看上面那句原因，改好之后再提一张单子。';
}

/**
 * 叫醒她一次（**真唤醒**：与 `wakeForMcpChange` 同一条路、同一条纪律）。
 *
 * 三处与那条逐字同款的分寸：
 *   • 走 `appendSync('wake/manual', …, 'model')`——与界面聊天框、`/dream`、webhook 转发
 *     同一条路（同一套认领、幂等、崩溃恢复），一处新机制都没有；
 *   • **刻意不带 `person`**：人点了一下按钮，但他没有开口——带上人就会把关系档案注进这一轮；
 *   • **发不出去不许把一次成功的落地变成 500**：`appendSync` 抛错时留一行诊断、返回 null，
 *     由调用方在回执里如实说"叫没叫上"。
 *
 * 幂等键用**决定的身份**（`grant-<id>-<outcome>`）+ 5 秒时间片：同一个决定重复发只会到一次，
 * 而"两个不同的决定"各自都该到（与 `wakeForMcpChange` 那条"5 秒内所有改动并成一条"不同——
 * 这里 5 秒只是挡住客户端重试）。
 */
export function wakeForGrant(input: {
  facts: GrantWakeFacts;
  nowMs: number;
  append: (data: { note: string; via: 'grant'; dedupeKey: string }) => number;
  onError: (message: string) => void;
}): number | null {
  try {
    return input.append({
      note: grantWakeNoteOf(input.facts),
      via: 'grant',
      dedupeKey: contentKey(
        'grant',
        `${Math.floor(input.nowMs / 5000)}:${input.facts.id}:${input.facts.outcome}`,
      ),
    });
  } catch (err) {
    input.onError(err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * 一条申请单的结果**回给她的那几格**（回执里那一行）。
 *
 * 它是人写的话（驳回理由）与框架算的事实（执行结果）拼起来的**一行**，
 * 所以理由已经洗净（`sanitizeGrantLine`）——它会进她下一拍的上下文。
 */
export function grantReceiptLine(facts: GrantWakeFacts): string {
  if (facts.outcome === 'rejected') {
    return facts.reason === null || facts.reason === ''
      ? '人驳回了这张申请单，没有给理由。'
      : `人驳回了这张申请单，理由是：${facts.reason}`;
  }
  if (facts.exec.state === 'ok') return '人批准了，框架已经写进配置。';
  return `人批准了，但框架执行没成功：${facts.exec.failure ?? '（没有原因）'}`;
}
