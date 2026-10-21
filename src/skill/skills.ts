/**
 * Irmia Agent — Skill 系统（任务知识包）
 *
 * 对齐 docs/design.md §4.19「Skill（任务知识包）」与 docs/milestones.md M7-4，
 * 规范语义按 Anthropic Agent Skills 官方口径落地（实证见 docs/research-memory-skills.md）：
 *
 *   ① **扫描**：`skills/` 与 `.agents/skills/`（跨客户端约定）两个项目级根，每个子目录读 `SKILL.md`；
 *      根顺序即优先级（同名先到者生效），目录名即 skill 名。
 *   ② **frontmatter**：手写 YAML 子集解析，只有两个必填字段——`name`（小写 + 连字符、≤64 字符、
 *      必须与目录同名）与 `description`（≤1024 字符）。description 是**唯一的触发机制**：
 *      catalog 里只有名称与描述，写得不好就等于没有这个 skill。
 *   ③ **渐进披露三层**（官方数值）：catalog 每条 50-100 token 常驻 → 判断相关时模型自己用
 *      `safe_read` 读 SKILL.md 正文 → references/assets/scripts 按需。**正文永不进上下文**，
 *      这不是省 token 的花招，而是"装了 20 个 skill 只付 20 条目录成本"的前提。
 *   ④ **信任门**：新增或变更过的 skill 目录不进 catalog，直到日志里出现
 *      `skill/installed { by: 'human' }`。agent 自沉淀的 skill 写 `by: 'agent'`（记录"它会做什么"），
 *      但**同样需要人类确认**才生效——自注册零成本，不设门就是垃圾堆。
 *   ⑤ **变更检测**：确认绑定 SKILL.md 的内容哈希；确认之后内容又被改动的目录自动退回待确认状态
 *      （"变更过的 skill 等于没确认过的 skill"）。
 *
 * 为什么 catalog 是"装配进 render 的素材"而不是"从事件派生的状态"：它和 `STATE.md` 一样属于
 * **状态层**——每轮本就变化的部分（design §4.13），素材来自文件系统。事件流 → 请求的渲染确定性
 * 不受影响：同一份 catalog 文本在同一 turn 内逐字节稳定。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import type { AppEvent, SkillInstalled, Visibility } from '../log/types.js';
import { readOnlyPrefixOf } from '../tools/fs/path-guard.ts';
import { sha256Hex } from '../tools/fs/text-codec.ts';
import { estimateTokens } from '../tools/registry.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 项目级技能根（相对 baseRoot 的 posix 路径）。顺序即优先级：同名时先到者生效 */
export const DEFAULT_SKILL_ROOTS = ['skills', '.agents/skills'] as const;

export const SKILL_FILE_NAME = 'SKILL.md';

/** name：小写字母、数字与连字符（官方规范） */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const SKILL_NAME_MAX_CHARS = 64;
export const SKILL_DESCRIPTION_MAX_CHARS = 1024;

/** catalog 单条 token 预算（官方口径 50-100；这里取上界做硬门，超限截断并告警） */
export const CATALOG_ENTRY_TOKEN_BUDGET = 100;
/** catalog 总预算：约 8 条满额条目。超出的条目丢弃并告警（仍可被 safe_read 读到） */
export const CATALOG_TOTAL_TOKEN_BUDGET = 800;
/** description 过短的提示线：官方反模式是"太模糊、缺关键词" */
export const DESCRIPTION_MIN_CHARS = 20;

/** 正文按需读取的默认窗口（官方建议正文 <5000 token / 500 行） */
export const SKILL_BODY_MAX_CHARS = 40_000;

/** catalog 头部（固定文案 → 渲染确定性）：把"正文在哪、怎么读"一次说清，条目里就不再重复路径 */
export const CATALOG_HEADER =
  '[可用技能] 以下是可按需使用的技能（每条 = 名称 + 描述）。判断与当前事情相关时，'
  + '先用 safe_read 读它的正文再动手：skills/<name>/SKILL.md'
  + '（跨客户端根为 .agents/skills/<name>/SKILL.md）；references/、assets/、scripts/ 需要时再读。'
  + '正文不在本次上下文里（渐进披露），不要凭描述猜测步骤。';

/** 只读区前缀：技能目录是"模型可读、不可改"的资产区（design §4.19 信任门） */
export const SKILL_READ_ONLY_PREFIXES = ['skills', '.agents/skills'] as const;

// ──────────────────────────────── 类型 ────────────────────────────────

export type SkillOrigin = 'human' | 'agent';

export interface SkillMetadata {
  name: string;
  description: string;
  /** 其余 frontmatter 键（官方扩展字段本项目只记录、不解释） */
  extras: Record<string, string>;
}

export interface SkillCandidate {
  name: string;
  /** 绝对目录路径 */
  dir: string;
  /** 相对 baseRoot 的 posix 目录路径，如 `skills/daily-review` */
  relDir: string;
  /** 相对 baseRoot 的 posix SKILL.md 路径：catalog 头部给模型的读取路径 */
  skillPath: string;
  description: string;
  metadata: SkillMetadata;
  /** SKILL.md 全文的内容哈希：信任门用它识别"确认后又被改动" */
  contentHash: string;
  bytes: number;
  /** 命中的技能根（相对 baseRoot 的 posix 路径） */
  rootName: string;
  /** 正文行数（观测用：官方建议 <500 行） */
  bodyLines: number;
}

export interface SkillReject {
  dir: string;
  relDir: string;
  reason: string;
}

export interface SkillScanResult {
  candidates: SkillCandidate[];
  rejected: SkillReject[];
  roots: string[];
}

/** 信任状态：`trusted` 是唯一能进 catalog 的状态 */
export type SkillTrustState = 'trusted' | 'never-confirmed' | 'agent-proposed' | 'content-changed';

export interface SkillTrustVerdict {
  state: SkillTrustState;
  /** 人可读的说明（含下一步动作） */
  detail: string;
}

export interface SkillTrustEntry {
  by: SkillOrigin;
  path: string;
  /** 事件里记录的内容哈希；旧事件可能没有（那时只能按名字信任，并在告警里说明） */
  contentHash: string | null;
  ts: string;
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  /** 该条（含名称前缀）的 token 估算 */
  tokens: number;
  truncated: boolean;
  skillPath: string;
}

export interface SkillPending {
  name: string;
  relDir: string;
  state: SkillTrustState;
  detail: string;
}

export interface SkillCatalog {
  entries: SkillCatalogEntry[];
  /** 注入 render 状态层的文本；没有可用 skill 时为空串（该段整体不出现） */
  text: string;
  /** catalog 总估算 token（含头部固定文案） */
  tokens: number;
  warnings: string[];
  pending: SkillPending[];
  rejected: SkillReject[];
}

// ──────────────────────────────── frontmatter（YAML 子集） ────────────────────────────────

export type FrontmatterParse =
  | { ok: true; fields: Record<string, string>; body: string; bodyLines: number }
  | { ok: false; error: string };

/** 取首行 `---` 与下一个 `---` 之间的原文；无合法块返回 null */
function splitFrontmatter(text: string): { raw: string; body: string } | null {
  const normalized = text.replace(/^\uFEFF/u, '');
  const lines = normalized.split(/\r?\n/u);
  if ((lines[0] ?? '').trim() !== '---') return null;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() === '---') {
      return { raw: lines.slice(1, i).join('\n'), body: lines.slice(i + 1).join('\n') };
    }
  }
  return null;
}

/** `>` 折叠标量：相邻非空行以空格连接，空行保留为换行 */
function foldBlockLines(lines: readonly string[]): string {
  let out = '';
  for (const line of lines) {
    if (line === '') {
      out += '\n';
      continue;
    }
    out = out === '' || out.endsWith('\n') ? out + line : `${out} ${line}`;
  }
  return out;
}

/**
 * 标量清洗。顺序很重要：**先判引号、再剥行内注释**——`description: "含 # 号的值" # 注释`
 * 的反过来处理会把引号连同注释一起当成值的一部分（这是最容易被写错的一处）。
 * 未加引号的值不做冒号回退：取整段，容错优先（官方规范提醒过未加引号含冒号的值）。
 */
function cleanScalar(raw: string): string {
  const value = raw.trim();

  if (value.startsWith('"')) {
    let end = -1;
    for (let i = 1; i < value.length; i += 1) {
      if (value[i] === '\\') {
        i += 1;
        continue;
      }
      if (value[i] === '"') {
        end = i;
        break;
      }
    }
    if (end !== -1) {
      return value
        .slice(1, end)
        .replace(/\\n/gu, '\n')
        .replace(/\\t/gu, '\t')
        .replace(/\\"/gu, '"')
        .replace(/\\\\/gu, '\\');
    }
  }

  if (value.startsWith("'")) {
    let end = -1;
    for (let i = 1; i < value.length; i += 1) {
      if (value[i] !== "'") continue;
      if (value[i + 1] === "'") {
        // YAML 的单引号转义是双写
        i += 1;
        continue;
      }
      end = i;
      break;
    }
    if (end !== -1) return value.slice(1, end).replace(/''/gu, "'");
  }

  const comment = value.search(/\s#/u);
  return comment === -1 ? value : value.slice(0, comment).trim();
}

/**
 * 解析 `SKILL.md` 的 frontmatter。支持的子集（够用且不引入 YAML 依赖）：
 *   • 顶层 `key: value`（顶格；缩进行归上一条的块标量）
 *   • 块标量 `|` / `>` 及其 `-`/`+` chomping（description 常用）
 *   • 单/双引号标量、`#` 注释行、空行
 * 嵌套映射与列表**不解析**：规范只要求两个标量字段，别的键按原文收进 extras。
 */
export function parseFrontmatter(text: string): FrontmatterParse {
  const split = splitFrontmatter(text);
  if (split === null) {
    return {
      ok: false,
      error: '缺少 frontmatter 块：文件必须以一行 `---` 开头、并以另一行 `---` 结束（design.md §4.19）',
    };
  }

  const fields: Record<string, string> = {};
  const lines = split.raw.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (line !== line.trimStart()) continue; // 缩进行不是顶层键（块标量已在下面整体消费）

    const colon = line.indexOf(':');
    if (colon <= 0) continue; // 不成 key: value：YAML 子集不做进一步解释，跳过
    const key = line.slice(0, colon).trim();
    if (key === '' || /\s/u.test(key)) continue;

    let value: string;
    const rawValue = line.slice(colon + 1).trim();
    const blockMatch = /^([|>])[+-]?\d*$/u.exec(rawValue);
    if (blockMatch !== null) {
      const style = blockMatch[1] ?? '|';
      const collected: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const current = lines[j] ?? '';
        if (current.trim() === '') {
          collected.push('');
          continue;
        }
        const indent = current.length - current.trimStart().length;
        if (indent === 0) break; // 回到顶层：块结束
        collected.push(current.slice(indent));
      }
      i = j - 1;
      value = style === '|' ? collected.join('\n') : foldBlockLines(collected);
    } else {
      value = cleanScalar(rawValue);
    }

    // 重复键保留首个：先写下的那行才是人想表达的那句
    if (fields[key] === undefined) fields[key] = value.trim();
  }

  const body = split.body.replace(/^\n+/u, '');
  return {
    ok: true,
    fields,
    body,
    bodyLines: body === '' ? 0 : body.split('\n').length,
  };
}

export type MetadataValidation =
  | { ok: true; metadata: SkillMetadata }
  | { ok: false; reason: string };

/** 校验 frontmatter 的两个必填字段；dirName 是 skill 所在目录名（必须与 name 同名） */
export function validateMetadata(fields: Record<string, string>, dirName: string): MetadataValidation {
  const name = (fields['name'] ?? '').trim();
  if (name === '') {
    return { ok: false, reason: 'frontmatter 缺少必填字段 name' };
  }
  if (name.length > SKILL_NAME_MAX_CHARS) {
    return { ok: false, reason: `name 长度 ${name.length} 超过 ${SKILL_NAME_MAX_CHARS} 字符上限` };
  }
  if (!SKILL_NAME_RE.test(name)) {
    return {
      ok: false,
      reason: `name「${name}」不合规：只允许小写字母、数字与连字符（不接受大写、下划线、空格、中文）`,
    };
  }
  if (name !== dirName) {
    return {
      ok: false,
      reason: `name「${name}」与目录名「${dirName}」不一致：官方规范要求两者同名（改名请同时改目录）`,
    };
  }

  const description = (fields['description'] ?? '').trim();
  if (description === '') {
    return { ok: false, reason: 'frontmatter 缺少必填字段 description（它是唯一的触发机制）' };
  }
  if (description.length > SKILL_DESCRIPTION_MAX_CHARS) {
    return {
      ok: false,
      reason: `description 长度 ${description.length} 超过 ${SKILL_DESCRIPTION_MAX_CHARS} 字符上限`,
    };
  }

  const extras: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'name' || key === 'description') continue;
    extras[key] = value;
  }
  return { ok: true, metadata: { name, description, extras } };
}

// ──────────────────────────────── 小工具 ────────────────────────────────

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/**
 * 技能名的合规判定：合规则返回 null，否则返回一句人话（哪里不对 + 正确的是什么）。
 *
 * 为什么要一个共用入口：同一个名字有两处要被拼进路径——新建（写 `<根>/<name>/SKILL.md`）
 * 与删除（把 `<根>/<name>/` 整个搬进回收站）。两处各写一份判断，迟早有一处漏掉。
 *
 * 为什么在规范之外**显式**再挡一次路径穿越（分隔符、上跳、盘符、绝对路径）：
 * `SKILL_NAME_RE` 今天恰好也挡得住它们（官方规范的字符集本来就窄），但"能把一个目录搬走"
 * 这件事不该依赖另一个功能的规范宽度——将来有人为了别的需求放宽那条正则，第一道仍然拦得住。
 * 这一条是纪律，不是冗余：删除的能力不许被一个名字绕过去。
 */
export function skillNameProblem(name: string): string | null {
  if (name === '') return '缺少 name（技能名，如 morning-review）';
  if (name === '.' || name === '..' || name.includes('..')) {
    return `技能名「${name}」里出现了「..」：技能名只能是技能根下的**直接子目录**名，不接受上跳路径`;
  }
  if (/^[a-zA-Z]:/u.test(name)) {
    return `技能名「${name}」里出现了盘符：技能名只能是技能根下的直接子目录名，不是一条路径`;
  }
  if (/[\\/]/u.test(name)) {
    return `技能名「${name}」里不允许路径分隔符（/ 或 \\）：技能名是一个目录名，不是一条路径`;
  }
  // 分隔符检查已经覆盖了绝对路径的两种写法，这里再判一次是**有意的**冗余：
  // 上面那条规则是"字符集"，这条是"语义"——判据不同源的两次否定才算把门关上。
  if (isAbsolute(name)) {
    return `技能名「${name}」不允许绝对路径：技能名只能是技能根下的直接子目录名`;
  }
  if (!SKILL_NAME_RE.test(name)) {
    return `技能名「${name}」不合规：只允许小写字母、数字与连字符（目录名即技能名，中文/大写/空格/下划线都不行），`
      + '例如 morning-review';
  }
  return null;
}

/** 只读区判定的唯一实现点在 fs 包（path-guard），这里只复出——两份实现迟早会漂移 */
export { readOnlyPrefixOf };

/**
 * 把 description 截断到 token 预算内（二分找最长可用前缀）。
 * prefixTokens 是条目前缀（`- name: `）的估算，预算按整条计算。
 */
export function clipDescription(
  prefixTokens: number,
  description: string,
  budget: number,
): { text: string; tokens: number; truncated: boolean } {
  if (prefixTokens + estimateTokens(description) <= budget) {
    return { text: description, tokens: prefixTokens + estimateTokens(description), truncated: false };
  }
  let lo = 0;
  let hi = description.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = `${description.slice(0, mid)}…`;
    if (prefixTokens + estimateTokens(candidate) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const text = lo <= 0 ? '…' : `${description.slice(0, lo)}…`;
  return { text, tokens: prefixTokens + estimateTokens(text), truncated: true };
}

// ──────────────────────────────── 管理面 ────────────────────────────────

export interface SkillManagerOptions {
  /** 技能根基准目录，默认 process.cwd()（技能是项目级资产，与 workspace/ 同级） */
  baseRoot?: string;
  /** 技能根（相对 baseRoot 的 posix 路径），默认 DEFAULT_SKILL_ROOTS */
  rootNames?: readonly string[];
  /** catalog 单条 token 预算，默认 CATALOG_ENTRY_TOKEN_BUDGET */
  catalogEntryTokens?: number;
  /** catalog 总 token 预算，默认 CATALOG_TOTAL_TOKEN_BUDGET */
  catalogTotalTokens?: number;
  /** 诊断出口：告警按内容去重，同一句只打一次 */
  out?: (line: string) => void;
  now?: () => Date;
  /** 事件写入通道（落库由宿主负责）；不配则只生成负载、不写日志 */
  emit?: (type: string, data: unknown, visibility: Visibility) => void;
}

/**
 * 技能管理器：扫描 → 校验 → 信任门 → catalog。
 *
 * 刻意不持有日志：信任事件的真相源是事件日志，本模块只**折叠**它（`setTrustEvents` /
 * `applyTrustEvent`）。写事件走 `emit`（由宿主注入，与 real-loop 的 appendSync 同构），
 * 这样单元测试可以完全不碰文件系统与日志。
 */
export class SkillManager {
  private readonly baseRoot: string;
  private readonly rootNames: readonly string[];
  private readonly entryTokens: number;
  private readonly totalTokens: number;
  private readonly out: (line: string) => void;
  private readonly now: () => Date;
  private readonly emit: ((type: string, data: unknown, visibility: Visibility) => void) | null;
  /** name → 最近一条 skill/installed（后写覆盖先写：与 fold 的"状态取最新"同口径） */
  private readonly trust = new Map<string, SkillTrustEntry>();
  private readonly reported = new Set<string>();

  constructor(options: SkillManagerOptions = {}) {
    this.baseRoot = options.baseRoot ?? process.cwd();
    this.rootNames = options.rootNames ?? DEFAULT_SKILL_ROOTS;
    this.entryTokens = Math.max(1, Math.trunc(options.catalogEntryTokens ?? CATALOG_ENTRY_TOKEN_BUDGET));
    this.totalTokens = Math.max(0, Math.trunc(options.catalogTotalTokens ?? CATALOG_TOTAL_TOKEN_BUDGET));
    this.out = options.out ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
    this.emit = options.emit ?? null;
  }

  /** 技能根绝对路径（按优先级） */
  get roots(): string[] {
    return this.rootNames.map((name) => join(this.baseRoot, name));
  }

  /** 只读区前缀（相对工具白名单根的 posix 路径）：技能目录可读、不可写 */
  get readOnlyPrefixes(): string[] {
    return [...this.rootNames];
  }

  /** 去重诊断：同一句话只输出一次，避免每轮 turn 刷屏 */
  private report(line: string): void {
    if (this.reported.has(line)) return;
    this.reported.add(line);
    this.out(line);
  }

  /** 扫描两个技能根：目录名即 skill 名，读 SKILL.md → 解析 frontmatter → 校验 */
  scan(): SkillScanResult {
    const candidates: SkillCandidate[] = [];
    const rejected: SkillReject[] = [];
    const claimed = new Map<string, string>();

    for (const rootName of this.rootNames) {
      const root = join(this.baseRoot, rootName);
      let entries: string[];
      try {
        entries = readdirSync(root).slice().sort(); // 目录名升序：扫描结果确定性
      } catch {
        continue; // 根不存在：不是错误，只是没有这类技能
      }
      for (const entry of entries) {
        if (entry.startsWith('.')) continue; // 隐藏目录不是 skill
        const dir = join(root, entry);
        const relDir = toPosix(relative(this.baseRoot, dir));
        let isDir = false;
        try {
          isDir = statSync(dir).isDirectory();
        } catch {
          continue;
        }
        if (!isDir) {
          rejected.push({ dir, relDir, reason: '不是目录：skill 必须是 `<根>/<name>/` 这样的子目录' });
          continue;
        }

        const file = join(dir, SKILL_FILE_NAME);
        let text: string;
        try {
          text = readFileSync(file, 'utf8');
        } catch {
          rejected.push({ dir, relDir, reason: `目录内没有 ${SKILL_FILE_NAME}` });
          continue;
        }

        const parsed = parseFrontmatter(text);
        if (!parsed.ok) {
          rejected.push({ dir, relDir, reason: parsed.error });
          continue;
        }
        const validated = validateMetadata(parsed.fields, entry);
        if (!validated.ok) {
          rejected.push({ dir, relDir, reason: validated.reason });
          continue;
        }

        const prior = claimed.get(validated.metadata.name);
        if (prior !== undefined) {
          rejected.push({
            dir,
            relDir,
            reason: `与 ${prior} 同名：根顺序即优先级，先到者生效（同名冲突以先声明的根为准）`,
          });
          continue;
        }
        claimed.set(validated.metadata.name, relDir);

        candidates.push({
          name: validated.metadata.name,
          dir,
          relDir,
          skillPath: `${relDir}/${SKILL_FILE_NAME}`,
          description: validated.metadata.description,
          metadata: validated.metadata,
          contentHash: sha256Hex(text),
          bytes: Buffer.byteLength(text, 'utf8'),
          rootName,
          bodyLines: parsed.bodyLines,
        });
      }
    }

    return { candidates, rejected, roots: this.roots };
  }

  /**
   * 技能目录的物理位置：两个技能根里**第一个**存在同名目录的那个（根顺序即优先级，与 scan 同源）。
   *
   * 与 scan 的区别有两点，都是刻意的：
   *   · **不读 SKILL.md、不要求 frontmatter 合法**：删除要能清掉一个写坏了的目录
   *     （缺 SKILL.md、name 与目录不同名……这些恰恰是最该被清理的一类，scan 却把它们列进 rejected）；
   *   · **两个根都找**：只认第一个根是最容易漏的一处——放在 `.agents/skills/` 下的技能，
   *     界面上看得见，却会"删不掉"。根列表来自构造参数，所以删除与扫描看到的是同两根。
   *
   * 名字的安全性由调用方先过 `skillNameProblem`：这里只回答"它在哪"，不负责判定名字。
   */
  locate(name: string): { dir: string; relDir: string; rootName: string } | null {
    for (const rootName of this.rootNames) {
      const dir = join(this.baseRoot, rootName, name);
      try {
        if (statSync(dir).isDirectory()) {
          return { dir, relDir: toPosix(relative(this.baseRoot, dir)), rootName };
        }
      } catch {
        continue; // 这个根里没有：换下一个根（"没有"不是错误）
      }
    }
    return null;
  }

  /** 从日志（或任意事件序列）重建信任表：按 seq 升序折叠，后写覆盖先写 */
  setTrustEvents(events: readonly AppEvent[]): void {
    this.trust.clear();
    const installed = events
      .filter((event): event is AppEvent & { type: 'skill/installed' } => event.type === 'skill/installed')
      .sort((a, b) => a.seq - b.seq);
    for (const event of installed) this.recordTrust(event);
  }

  /** 运行期增量折入一条事件；返回是否消费（非 skill/installed 事件一律 false） */
  applyTrustEvent(event: AppEvent): boolean {
    if (event.type !== 'skill/installed') return false;
    this.recordTrust(event);
    return true;
  }

  private recordTrust(event: AppEvent & { type: 'skill/installed' }): void {
    const data = event.data as SkillInstalled['data'];
    const raw = (data as { contentHash?: unknown }).contentHash;
    this.trust.set(data.name, {
      by: data.by,
      path: data.path,
      contentHash: typeof raw === 'string' && raw !== '' ? raw : null,
      ts: event.ts,
    });
  }

  /** 信任裁决：只有 `trusted` 进 catalog。contentHash 缺省表示"不检测变更"（旧事件兼容） */
  trustOf(name: string, contentHash?: string): SkillTrustVerdict {
    const entry = this.trust.get(name);
    if (entry === undefined) {
      return {
        state: 'never-confirmed',
        detail: '从未确认：新出现的技能目录不会自动生效，需要写入 skill/installed { by: "human" } 后才进索引',
      };
    }
    if (entry.by === 'agent') {
      return {
        state: 'agent-proposed',
        detail: `由 agent 自沉淀（${entry.ts}）：自注册不构成信任，仍需人类确认后才进索引`,
      };
    }
    if (entry.contentHash !== null && contentHash !== undefined && entry.contentHash !== contentHash) {
      return {
        state: 'content-changed',
        detail: '确认之后内容又被改动：变更即失效，需要重新确认后才进索引',
      };
    }
    return { state: 'trusted', detail: `已由 human 确认（${entry.ts}）` };
  }

  /** 未进 catalog 的技能：给人类确认界面/CLI 用的待办面 */
  pending(candidates?: readonly SkillCandidate[]): SkillPending[] {
    const list = candidates ?? this.scan().candidates;
    const out: SkillPending[] = [];
    for (const candidate of list) {
      const verdict = this.trustOf(candidate.name, candidate.contentHash);
      if (verdict.state === 'trusted') continue;
      out.push({ name: candidate.name, relDir: candidate.relDir, state: verdict.state, detail: verdict.detail });
    }
    return out;
  }

  /**
   * 生成 catalog（渐进披露第一层）：只收信任门放行的 skill，每条截断到单条预算，
   * 总量受总预算约束。返回的 `warnings` 同时按内容去重打到诊断出口。
   */
  catalog(): SkillCatalog {
    const scan = this.scan();
    const entries: SkillCatalogEntry[] = [];
    const warnings: string[] = [];
    const pending: SkillPending[] = [];

    for (const candidate of scan.candidates) {
      if (candidate.description.length < DESCRIPTION_MIN_CHARS) {
        warnings.push(
          `skill ${candidate.name}：description 只有 ${candidate.description.length} 字符，`
          + '过于模糊会永远不会被想起（description 是唯一触发机制：写清能力 + 触发场景 + 关键词）',
        );
      }
      const verdict = this.trustOf(candidate.name, candidate.contentHash);
      if (verdict.state !== 'trusted') {
        pending.push({ name: candidate.name, relDir: candidate.relDir, state: verdict.state, detail: verdict.detail });
        continue;
      }
      const prefixTokens = estimateTokens(`- ${candidate.name}: `);
      const clipped = clipDescription(prefixTokens, candidate.description, this.entryTokens);
      if (clipped.truncated) {
        warnings.push(
          `skill ${candidate.name}：catalog 条目估算 ${prefixTokens + estimateTokens(candidate.description)} token，`
          + `超过单条预算 ${this.entryTokens}，已截断为 ${clipped.tokens} token`
          + '（design §4.19：catalog 每条 50-100 token 常驻，请精简 description）',
        );
      }
      entries.push({
        name: candidate.name,
        description: clipped.text,
        tokens: clipped.tokens,
        truncated: clipped.truncated,
        skillPath: candidate.skillPath,
      });
    }

    for (const item of pending) {
      warnings.push(`skill ${item.name}（${item.relDir}）未进 catalog：${item.detail}`);
    }
    for (const item of scan.rejected) {
      warnings.push(`skill 目录 ${item.relDir} 被拒绝：${item.reason}`);
    }

    // 总预算：按 name 升序取前 N 条（确定性），其余丢弃但仍可被 safe_read 读到
    const kept: SkillCatalogEntry[] = [];
    const dropped: string[] = [];
    let used = 0;
    for (const entry of entries) {
      if (used + entry.tokens > this.totalTokens) {
        dropped.push(entry.name);
        continue;
      }
      used += entry.tokens;
      kept.push(entry);
    }
    if (dropped.length > 0) {
      warnings.push(
        `catalog 总预算 ${this.totalTokens} token 已满，以下技能未进索引：${dropped.join('、')}`
        + '（不影响它们被 safe_read 读到；要进索引请精简已有 description）',
      );
    }

    const text = kept.length === 0 ? '' : [CATALOG_HEADER, ...kept.map((e) => `- ${e.name}: ${e.description}`)].join('\n');
    for (const warning of warnings) this.report(`[技能] ${warning}`);

    return {
      entries: kept,
      text,
      tokens: kept.length === 0 ? 0 : estimateTokens(text),
      warnings,
      pending,
      rejected: scan.rejected,
    };
  }

  /** 注入 render 状态层的文本（没有可用技能时为空串，render 侧该段整体不出现） */
  catalogText(): string {
    return this.catalog().text;
  }

  /** 渐进披露第二层：正文按需读取（模型用 safe_read 走白名单；这里是宿主/CLI 的便利入口） */
  readBody(name: string, maxChars: number = SKILL_BODY_MAX_CHARS): string | null {
    const candidate = this.scan().candidates.find((item) => item.name === name);
    if (candidate === undefined) return null;
    let text: string;
    try {
      text = readFileSync(join(candidate.dir, SKILL_FILE_NAME), 'utf8');
    } catch {
      return null;
    }
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n\n[正文已截断：共 ${text.length} 字符，超过本次窗口 ${maxChars}；`
      + `请用 safe_read 的 offset/limit 分段读 ${candidate.skillPath}]`;
  }

  /**
   * 生成 `skill/installed` 事件负载（纯函数，供宿主落库）。
   * 找不到候选（目录不存在或 frontmatter 非法）时返回 null，绝不写一条指向空气的确认。
   */
  buildInstalledData(name: string, by: SkillOrigin): SkillInstalled['data'] | null {
    const candidate = this.scan().candidates.find((item) => item.name === name);
    if (candidate === undefined) return null;
    return { name: candidate.name, path: candidate.relDir, by, contentHash: candidate.contentHash };
  }

  /**
   * 记录一次安装/确认：写 `skill/installed` 事件（信任门的唯一凭据）并增量折入本地信任表。
   * `by: 'agent'`（自沉淀）与 `by: 'human'`（人类确认）走同一条通道——区别只在裁决口径。
   */
  install(name: string, by: SkillOrigin): SkillInstalled['data'] | null {
    const data = this.buildInstalledData(name, by);
    if (data === null) {
      this.report(`[技能] 无法记录 ${name}：目录不存在、frontmatter 非法或不在技能根内`);
      return null;
    }
    const event: AppEvent & { type: 'skill/installed' } = {
      seq: 0,
      ts: this.now().toISOString(),
      type: 'skill/installed',
      data,
      visibility: 'internal',
      origin: 'skill/skills',
    };
    if (this.emit !== null) this.emit('skill/installed', data, 'internal');
    this.recordTrust(event);
    this.report(
      by === 'human'
        ? `[技能] ${name} 已由 human 确认，进入 catalog（内容哈希 ${data.contentHash?.slice(0, 8) ?? '?'}）`
        : `[技能] ${name} 已记为由 agent 自沉淀；仍需人类确认后才进 catalog（防垃圾自注册）`,
    );
    return data;
  }

  /** 人类确认（信任门放行动作） */
  confirm(name: string): SkillInstalled['data'] | null {
    return this.install(name, 'human');
  }

  /** 启动期的诊断清单：拒绝原因 + 待确认清单，供宿主在启动摘要里说一次 */
  startupWarnings(): string[] {
    const scan = this.scan();
    const lines: string[] = [];
    for (const item of scan.rejected) lines.push(`[技能] 目录 ${item.relDir} 被拒绝：${item.reason}`);
    for (const item of this.pending(scan.candidates)) {
      lines.push(`[技能] ${item.name}（${item.relDir}）未进 catalog：${item.detail}`);
    }
    for (const item of scan.candidates) {
      const verdict = this.trustOf(item.name, item.contentHash);
      if (verdict.state === 'trusted') lines.push(`[技能] ${item.name} 已生效（${item.relDir}）`);
    }
    return lines;
  }
}
