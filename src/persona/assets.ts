/**
 * Irmia Agent — 数字资产（`MEMORIES/assets.md` + 框架聚合的事实层）
 *
 * **一个概念：数字资产。三个分类：`skill` / `mcp` / `path`**（2026-10-06 用户收窄口径）：
 * 「skill、MCP 工具、PATH 里有的东西，都已统一是数字资产。只不过**还按照 skill、mcp 这样的
 * 习惯去分类**。由 **light loop 拿着索引清单，择机提醒**。」
 *
 * 分类**不是装饰**——它决定"怎么用"：
 *   • `skill` —— 读说明照着做（说明文件在哪由她自己写）；
 *   • `path`  —— 用 `pwsh` 跑（命令行工具）；
 *   • `mcp`   —— 走它的调用面（她读它的参数约定，或走配置里已注册的那件工具）。
 *   三者**都不进工具清单**：MCP **不新增网关工具**（用户 2026-10-06 的定调，可否决）——
 *   它是"资产"，不是一批常驻工具。
 *
 * **清单分两层，这一条是这份设计的关键**（免得她手抄一份事实、然后过期）：
 *   • **事实层（框架给的）**：有哪些、在哪、**是否就绪**——skill 目录里的技能、配置里声明的
 *     MCP server、`PATH` 探测得到的结论。由 {withFacts} 在**读清单时聚合**，任何一帧都不落盘、
 *     也不进她的文件。
 *   • **她的知识层（她写的）**：**什么时候用**、**怎么用**（她自己的说明文件路径）。落在
 *     `MEMORIES/assets.md`，一条 = `[分类] 名字 ｜ 一句话用途 ｜ 在哪`。
 *   于是"框架只读事实、她只写知识"，两边都不需要抄对方那一半。
 *
 * 本模块只做五件事，全部是**机制**，没有一件是替她写内容：
 *   ① [ensureAssetsSeed]  —— 文件不存在时写一份**给未来她看的说明**（幂等；已存在一个字节都不动）；
 *   ② [parseAssets]       —— 把清单解析成条目（坏行如实跳过并计数，不编）；
 *   ③ [withFacts]         —— 把事实层聚合上去（就绪与否照实说，**不改写她写的"在哪"**）；
 *   ④ [renderAssetsLine]  —— 把选中的 ≤3 条渲染成此刻层那**一行只读文本**（带**指路**）；
 *   ⑤ [selectAssets]      —— 一次 light 调用，从**索引清单**（她的层 + 事实层）里挑 ≤3 条相关的。
 *
 * **那条纪律（一个字都不许松）**：框架永远不替她写清单、不替她写用法、不替她读用法。
 * 它只做两件事——把清单**索引**喂给 light 做选取、把选中的 ≤3 条**如实**渲染成一行。
 * 所以本模块里没有"生成一条资产"的函数，也永远不该有：清单里写什么、她的用法说明书放在
 * 哪个文件、什么时候读进来，都是她的决定（种子文件把这件事讲给她听）。
 *
 * **为什么清单不常驻进她的上下文**：只在她被叫去干活的那一拍，由 light 挑出与本任务相关的
 * 那几条露一次面。常驻就等于每轮都在她眼前，那不再是"择机提醒"，而是又一份长期记忆
 * （也与"用法像 skill：自己读"相冲）。**常驻的只有一行规则**（"先读说明再用，不许凭名字猜"），
 * 它在装置自述里（`model/self-brief.ts` 第⑰段）——短、稳定、不吃缓存。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

import type { BudgetConsumed, Projection } from '../log/types.js';
import type { EventLog } from '../log/event-log.js';
import type { DsClient, DsRequest, DsResponse, DsTextFormat } from '../model/ds-client.js';
import { applyOne, finalizePressure } from '../state/fold.ts';
import { memoriesDir } from './memory-maintain.ts';
import { shellToolName } from '../tools/bash.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 清单文件名（与 `aliases.md` / `facts.md` 同级） */
export const ASSETS_FILE_NAME = 'assets.md';
/** 一次最多渲染几条（用户定的上限：**≤3**） */
export const ASSET_PICK_MAX = 3;
/** 喂给 light 的索引行上限（条数；清单长跑之后可能很长） */
export const ASSET_TITLE_LINES_MAX = 60;
/** 单条索引行的长度上限（字符） */
export const ASSET_TITLE_CHARS_MAX = 120;
/** 任务标题的长度上限（字符；与任务卡同一数量级就够 light 判断相关性） */
const TASK_TITLE_MAX_CHARS = 200;
/** light 调用超时（毫秒）：选取失败按"一条都不渲染"处理，绝不拖住她开工 */
export const ASSET_SELECT_TIMEOUT_MS = 8_000;
/** 事件 origin */
export const ASSETS_ORIGIN = 'persona/assets';
/** 那一行尾部永远带上的**指路**（light 漏选时她仍然有路可发现，见用户 2026-10-06 的第 5 条） */
export const ASSETS_INDEX_POINTER = '完整清单见 MEMORIES/assets.md';
/**
 * 她那一段**说明**的长度上限（字符，按**字符**切、不按字节切——中文一个字是一个字符）。
 *
 * 为什么要有这个数：说明进的是**此刻层任务卡**，而此刻层**每一步都发**——说明被整段抬进上下文，
 * 就是每步都付一次的常驻开销。实测（`data/events` 全量 111 条带 assets 的 `memory/selected`）：
 * 那一行最长 527 字符、中位 125、均值 144，其中最长那条的 335 个字符全是她写在"在哪"里的说明
 * （命令、实测结论、别走弯路——那些属于 SKILL.md 的正文，不属于这一行）。
 *
 * 60 这个数的分寸：一行提醒里一条资产给两屏不到；真要细节的**指路**就在行尾
 * （`ASSETS_INDEX_POINTER`），她照它去读全份清单、再照清单去读 SKILL.md——这条链一直在。
 * 它是**这一格内容**的额度（那一格的形状是 `名字（说明）`，名字与括注是固定字节，不计在里面）。
 *
 * **它只量"话"，不量"路"**：一处**指路**（`已在 PATH → …` / `路径：…` / 一个绝对路径）用
 * [ASSET_NAV_CHARS_MAX] 那根宽尺子——理由写在那个常量上（切半条路径 = 把这一格弄坏）。
 */
export const ASSET_NOTE_CHARS_MAX = 60;
/**
 * **指路那一截**（路径一类）的长度上限：给得比说明宽。
 *
 * 为什么不能都用 60：`已在 PATH（D:\IrmiaAgent\tools\ffmpeg\ffmpeg-8.1.1-essentials_build\bin\ffmpeg.exe）`
 * 是**一条指路**，而 Windows 上一条真路径很容易过 60 字符。指路被切成
 * `…essentials_build\…` 就**指不到任何文件**了——那不是省 token，是把这一格弄坏
 * （用户 2026-10-07 点名的正是这条：`已在 PATH → …` / `路径：…` 这一类别跟着说明一起截）。
 * 所以**路径按路径的尺子**：`ASSET_TITLE_CHARS_MAX`（120）这条索引行尺子已经跑了一阵，
 * 拿它当上限，够长到容下真路径、又仍然有界（不会把一段正文搬进来）。
 */
export const ASSET_NAV_CHARS_MAX = ASSET_TITLE_CHARS_MAX;

/** 三个分类（决定"怎么用"） */
export const ASSET_KINDS = ['skill', 'mcp', 'path'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/**
 * 清单的种子（新工作区首次生成时写入；**只在文件不存在时写**）。
 *
 * 体例照 `memory-maintain.ts` 的 `ALIASES_SEED`：这是**写给未来的她看的说明**，不是模板占位。
 * 四件事必须说清（少一件她就会走偏）：
 *   ① 这份清单是干什么的、一条怎么写（三分类各是什么意思）；
 *   ② **事实不用她抄**——有哪些、在哪、就绪没有由框架聚合；她只写"什么时候用、怎么用"；
 *   ③ **用法说明书由她自己写、自己读**（框架不替她写、也不替她读）；
 *   ④ 她被叫去干活时会收到一行"本任务相关资产"（框架挑的 ≤3 条，**挑得对不对她自己判断**）。
 *
 * 三条刻意的写法：
 *   • 说明整段用 `（…）` 包住（解析时按注释跳过，见 `parseAssets`）——她随手往下写多少行都不会
 *     被当成条目；
 *   • **示例放在 ``` 围栏里**，并且围栏第一行明写"这不是条目"。围栏内的内容解析器一律不认
 *     （`inFence`），所以示例既看得见、又绝不会被当成一件真的资产——"写一条像模像样的示例，
 *     她可能就以为机器上真的装了那个东西"是这份种子最该防的误导；
 *   • 不预置任何真实条目：清单里写什么该由她自己定（她确认过的才算），机制不替她记。
 */
export const ASSETS_SEED = `# 数字资产

（这台机器上你能用的东西——**skill、MCP、PATH 里的命令，都算数字资产**，
 只是照习惯分三类写着方便：\`[skill]\` 读说明照着做、\`[mcp]\` 走它的调用面、
 \`[path]\` 用 ${shellToolName()} 跑。一条一行：\`[分类] 名字 ｜ 一句话用途 ｜ 在哪\`。
 三个分类都是**可选**的：不写分类就按 \`[path]\` 算。
 「在哪」如实写：\`已在 PATH\` / \`路径：…\` / \`未安装（需要 X）\`——写了"未安装"就是没装，
 别让它看起来像有；skill 与 mcp 写名字（或它的说明文件路径）就够，**框架会自己核对**
  "这个技能在不在、这个 server 配了没有"，你不用手抄事实。
 这份清单**不在你的上下文里**：你在被叫去干活的那一拍，会收到一行「本任务相关资产」，
 那是我从这份清单（加上框架聚合的事实）里替你挑的可能用得上的几条（最多三条）——
 挑得对不对你自己判断；要看全的就照那一行末尾的指路去读。
 每一项**怎么用**，由你自己写说明文件、自己要用的那一刻自己去读——我不替你写，也不替你读。
 清单里没写的东西不等于没有；这里只记你确认过的。）

\`\`\`text
（下面是**格式示例**，不是条目——真的记了什么，往下写在这一段之后）
[skill] 周报 ｜ 按用户的模板生成周报 ｜ MEMORIES/skills/weekly.md
[mcp] github ｜ 查 issue 与 PR ｜ 已在 config 里配好的那个 server
[path] gh ｜ 命令行管 GitHub ｜ 已在 PATH
[path] ffmpeg ｜ 转码与抽帧 ｜ 未安装（需要 winget install ffmpeg）
\`\`\`
`;

// ──────────────────────────────── 条目与解析 ────────────────────────────────

/**
 * 清单里的一条数字资产。
 *
 * `kind` / `name` / `purpose` / `where` **全部照原文来，一个字都不改写**——尤其 `where`：
 * 清单说"未安装（需要 X）"，那一行就必须写"未安装（需要 X）"（用户的要求：不许让看起来有）。
 * 事实层核对出来的结论走 [AssetFact] 那几个字段（`有` / `无`），**不覆盖** `where`。
 */
export interface TaskAsset {
  /** 分类：决定"怎么用"（缺省 `path`） */
  kind: AssetKind;
  /** 名字（也用于 light 选取时定位这一条，以及事实层核对） */
  name: string;
  /** 一句话用途（照清单原文） */
  purpose: string;
  /** 在哪：`已在 PATH` / `路径：…` / `未安装（需要 X）` / 她写的别的说法——**照原文** */
  where: string;
  /** 来源：她写的（`her`）还是框架聚合出来的事实（`fact`） */
  from?: 'her' | 'fact';
  /**
   * 事实层核对结论；`null`/缺省 = **没核对**（不写"未知"，那一行就只写她写的那份）。
   *
   *   • `ready`  —— 事实层证明它就在那儿（skill 目录里有这个技能 / PATH 里找得到这个命令 /
   *                 MCP server 已启动）；`detail` 可以是探测到的真实路径（**探测结论**，可以写出来）；
   *   • `missing`——**核对过**、结论是"不在"（技能不在目录里、命令不在 PATH、配置里没这个 server）
   *                 ——那一行会如实缀一句 `（已探测：未找到）`，且**不渲染**（见 `renderable`）；
   *   • `declared`——**有话说，但结论来自她自己写的那一行**（"清单里写着未安装"）或"配置里声明了、
   *                 但是否已启动未知"：照她写的算，**不猜**。它**能渲染**（"未知"不等于"用不了"）；
   *   • `unknown`——**框架这一轮没有核对的依据**（读不到配置面 / 没有技能目录 / 没有探测手段）
   *                 ——既不写"未找到"，也**不进那一行**（摆一条"没核过"的东西等于让"看起来有"）。
   */
  fact?: AssetFact | null;
}

export interface AssetFact {
  state: 'ready' | 'missing' | 'declared' | 'unknown';
  /** 一句话依据（探测到的真实路径、"技能目录里有"、"清单里写着未安装"…） */
  detail: string;
}

export interface AssetsDoc {
  /** 解析出来的条目（按文件顺序） */
  entries: TaskAsset[];
  /** 有字但不符合三段格式的行数（如实计数；渲染时会说明"另有 N 行格式不对"） */
  skipped: number;
}

/** 半角与全角竖线都认（她可能用中文输入法打 `｜`） */
const SEPARATOR = /\s*[|｜]\s*/u;

/** 半角与全角方括号都认 */
const KIND_PREFIX = /^[\[［]\s*(skill|mcp|path)\s*[\]］]\s*/iu;

/** 从行首摘出分类（认不出来给 null，由调用方决定缺省） */
export function readKindPrefix(line: string): AssetKind | null {
  const hit = KIND_PREFIX.exec(line.trim());
  if (hit === null) return null;
  return (hit[1] ?? '').toLowerCase() as AssetKind;
}

/**
 * 解析一条清单行。**只有名字、没有"在哪"的行按格式不对处理**（返回 null）。
 *
 * 判据（刻意从紧）：
 *   • 行首可有 `- ` / `* ` 记号，其后可有 `[skill]` / `[mcp]` / `[path]`（缺省 `path`）；
 *   • 三段及以上、用 `|` 或 `｜` 分隔；
 *   • **名字与"在哪"都非空**——缺任何一段就是坏行。
 *     "只有名字没有在哪"的条目渲染出去等于让她照一个无从下手的名字去猜（正是用户说的
 *     "不许让看起来有"），所以**不降级成一条**，而是跳过并计数。
 *   • 表格行（`| a | b |`）与代码围栏不认：围栏内的内容不当条目（说明里可能写示例）。
 */
export function parseAssetLine(raw: string): TaskAsset | null {
  const line = raw.trim();
  if (line === '' || line.startsWith('#') || line.startsWith('```')) return null;
  const withoutBullet = line.replace(/^[-*]\s+/u, '').trim();
  if (withoutBullet === '') return null;
  const kind = readKindPrefix(withoutBullet) ?? 'path';
  const body = withoutBullet.replace(KIND_PREFIX, '').trim();
  if (body === '') return null;
  const parts = body.split(SEPARATOR).map(part => part.trim());
  if (parts.length < 3) return null;
  const [name = '', purpose = '', where = ''] = parts;
  if (name === '' || where === '') return null;
  return { kind, name, purpose, where, from: 'her' };
}

/**
 * 解析整份清单。读不到文件 = 空清单（**不报错、不建文件**：这是只读那条路）。
 *
 * 三处"不是条目"的行按注释处理、**不计入 skipped**：
 *   • `#` 开头的标题（段标题）；
 *   • ``` 围栏内的内容（种子里的**格式示例**就放在围栏里——示例绝不能被当成一件真资产）；
 *   • `（…）` / `(…)` 包起来的一段说明——**跨行也认**（种子那段"这份清单是干什么的"就是
 *     这种写法，她顺着往下写多少行都算说明）。
 *
 * 为什么注释要单独分出来、不并进 skipped：坏行计数是"**你写坏了几条**"的如实汇报，
 * 而标题、说明、示例本来就不是条目——把它们数进去，她一打开清单就会看到"另有 7 行没读懂"，
 * 那是误导（那几行本来就该在那儿）。
 */
export function parseAssets(text: string): AssetsDoc {
  const entries: TaskAsset[] = [];
  let skipped = 0;
  let inFence = false;
  let inParen = false;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    // 括号说明块：开了就一直吃到配对的闭括号（她可能把说明写成好几行）
    if (inParen) {
      if (/[）)]\s*$/u.test(trimmed)) inParen = false;
      continue;
    }
    if (trimmed.startsWith('#') || trimmed.startsWith('|')) continue;
    if (/^[（(]/u.test(trimmed)) {
      // 同一行就闭合的（`（空清单）`）不算开块；否则往后吃到闭括号
      if (!/[）)]/u.test(trimmed)) inParen = true;
      continue;
    }
    const entry = parseAssetLine(trimmed);
    if (entry === null) {
      skipped += 1;
      continue;
    }
    entries.push(entry);
  }
  return { entries, skipped };
}

/** 清单文件的绝对路径 */
export function assetsFile(dataDir: string): string {
  return join(memoriesDir(dataDir), ASSETS_FILE_NAME);
}

/**
 * 读清单（**只有她那一层**）。**文件不存在 = null**（不抛，也不创建文件）。
 *
 * 为什么"不存在"要单独分出来：调用方据此判断"这一轮要不要花一次 light"——
 * 没有清单就没得挑，那一次调用一次都不该发（用户对用度的口径：不做无意义的调用）。
 */
export function readAssets(dataDir: string): AssetsDoc | null {
  const path = assetsFile(dataDir);
  if (!existsSync(path)) return null;
  try {
    return parseAssets(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 首启初始化：清单文件不存在时写入 [ASSETS_SEED]。
 *
 * **幂等**：已存在的文件一个字节都不动（它是她的资产，机制只负责让结构存在）。
 * 由 `ensureMemorySeeds` 调用（新工作区首次生成时），所以既有工作区**不会**因为这次改动
 * 凭空多出一个文件——盘上那份要不要建，是她自己的事（种子里的说明会告诉她这件事）。
 */
export function ensureAssetsSeed(dataDir: string): boolean {
  const path = assetsFile(dataDir);
  if (existsSync(path)) return false;
  mkdirSync(memoriesDir(dataDir), { recursive: true });
  writeFileSync(path, ASSETS_SEED, 'utf8');
  return true;
}

// ──────────────────────────────── 事实层（框架聚合） ────────────────────────────────

/**
 * 事实层的三个来源。**都由宿主算好递进来**（本模块不读 config、不认识 SkillManager）：
 *   • `skills`   —— skill 目录里现有哪些技能（`SkillManager.catalogText()` 的结论或名字表）；
 *   • `mcp`      —— 配置里声明了哪些 MCP server、哪些已经起来了；
 *   • `probePath`—— `[path]` 条目的就绪探测（查 PATH）。
 *
 * 为什么要"宿主算好"：与 render 的 `contact` / `machine` 同一条纪律——读盘与读配置是宿主的事，
 * 本模块只负责"把她写的那一层与事实对起来、如实说"。
 */
export interface AssetFactSource {
  /**
   * 现有技能名（大小写不敏感匹配）。`undefined` = **这一轮没有技能目录可核对**
   * （子代理、诊断、测试场景）——那时如实写"没有技能目录可核对"，绝不假装核对过；
   * `[]` = 核对过，技能目录是空的（那是"确实没有"，与"没核对"是两件事）。
   */
  skills?: readonly string[] | undefined;
  /**
   * **配置里声明的** MCP server（名字 + 可选的"是否已启动"）。
   *
   * `undefined` = **这一轮读不到配置面**（子代理、诊断、测试场景）：那时 `[mcp]` 条目如实写
   * "没有 MCP 配置可核对"，**绝不**写"配置里没有这个 server"——读不到与"确实没有"是两件事，
   * 把前者说成后者就是假话（用户 2026-10-06 特意点名的那条：宁可少一格，不可写误导性文字）。
   *
   * `[]` = 核对过，配置里一个 server 都没声明（那是"确实没有"）。
   *
   * `ready` **可选**：主循环**看不到运行期状态**（`McpClientPool` 归宿主，real-loop 没有它），
   * 所以生产上给的是"只有名字"的那一份 ⇒ 就绪情况如实写成
   * **"已配置（是否已启动未知）"**，不写成"就绪"也不写成"未找到"。
   */
  mcp?: readonly { name: string; ready?: boolean }[] | undefined;
  /** `[path]` 条目的探测：给了才探测（不给 = 不核对，照她写的算） */
  probePath?: ((command: string) => { found: boolean; path?: string }) | undefined;
}

/** 她自己在清单里明说"未安装"的写法（这时**不探测**：她的话优先，不猜） */
const NOT_INSTALLED = /未安装|没装|not\s+installed/iu;
const ON_PATH = /已在\s*PATH|在\s*PATH/iu;

/**
 * 把清单里那条命令从"她写的在哪"里取出来（探测用）。
 *
 * 只认两种写法：`已在 PATH` / `路径：<path>`。取不出来就不探测——绝不拿一整句话去当命令名试。
 */
export function commandOf(asset: TaskAsset): string | null {
  const where = asset.where.trim();
  const explicit = /路径\s*[:：]\s*(.+)$/u.exec(where);
  if (explicit !== null) return (explicit[1] ?? '').trim().replace(/^["'`]|["'`]$/gu, '');
  if (ON_PATH.test(where)) return asset.name.trim();
  return null;
}

/**
 * 事实层核对一条（**只对 `skill` / `mcp` / `path` 各用各的办法，不混用**）：
 *
 *   • 她自己在清单里写了"未安装" ⇒ `declared`（**照她写的算，不去探测**：
 *     她说没装就是没装，框架不替她改口；那一行照原文写"未安装"）；
 *   • `skill` ⇒ 技能目录里有这个名字就是 `ready`，没有就是 `missing`（**这是关键的一条**：
 *     技能被删掉之后，她清单里那条会如实显示"已探测：未找到"，而不是一直看着像有）；
 *   • `mcp`  ⇒ **读得到配置面**才判：声明里有这个名字 ⇒ 有运行期状态就照它写，**没有就写
 *     "已配置（是否已启动未知）"**（主循环拿不到 `McpClientPool`，那一格就是不可知）；
 *     声明里没有 ⇒ `missing`（"确实没配"）。**读不到配置面 ⇒ `unknown` + "没有 MCP 配置可核对"**
 *     ——读不到与确实没有是两件事，把前者说成后者就是假话（用户 2026-10-06 点名的那条）；
 *   • `path` ⇒ 有探测手段就探（找得到给真实路径，找不到给 `missing`）；没有探测手段
 *     （测试、子代理、诊断场景）就是 `unknown`——**没核对就不假装核对过，也不写误导性文字**。
 *
 * ⚠️ `unknown` 与 `declared` 的分别（v34 接线时补的，别把它们合回去）：
 *   • `declared` = **有话说**，只是结论来自她自己写的那一行（"清单里写着未安装""已配置（是否已启动未知）"）
 *     ——那一行照原文渲染，**能用**（"未知"不等于"用不了"）；
 *   • `unknown` = **框架这一轮根本没核对的依据**（读不到配置面 / 没有技能目录 / 没有探测手段）
 *     ——它**不进那一行**：摆在任务旁边只会让她以为"这条核过了"。判据在 `renderable`。
 */
export function factOf(asset: TaskAsset, source: AssetFactSource): AssetFact {
  if (NOT_INSTALLED.test(asset.where)) return { state: 'declared', detail: '清单里写着未安装' };
  const name = asset.name.trim().toLowerCase();
  if (asset.kind === 'skill') {
    const skills = source.skills;
    if (skills === undefined) return { state: 'unknown', detail: '这一轮没有技能目录可核对' };
    const hit = skills.some(skill => skill.trim().toLowerCase() === name);
    return hit
      ? { state: 'ready', detail: '技能目录里有它' }
      : { state: 'missing', detail: '技能目录里没有它' };
  }
  if (asset.kind === 'mcp') {
    const servers = source.mcp;
    if (servers === undefined) return { state: 'unknown', detail: '这一轮读不到 MCP 配置面' };
    const hit = servers.find(server => server.name.trim().toLowerCase() === name);
    if (hit === undefined) return { state: 'missing', detail: '配置里没有这个 server' };
    // 就绪情况**不可知就如实说不可知**：声明在配置里 ≠ 进程起来了。
    if (hit.ready === true) return { state: 'ready', detail: 'server 已启动' };
    if (hit.ready === false) return { state: 'declared', detail: '已配置（未启动）' };
    return { state: 'declared', detail: '已配置（是否已启动未知）' };
  }
  const command = commandOf(asset);
  if (command === null) return { state: 'declared', detail: '清单里的"在哪"不是路径、也没说在 PATH' };
  const probe = source.probePath;
  if (probe === undefined) return { state: 'unknown', detail: '这一轮没有探测 PATH' };
  const result = probe(command);
  return result.found
    ? { state: 'ready', detail: result.path === undefined ? `PATH 里有 ${command}` : result.path }
    : { state: 'missing', detail: `PATH 里没有 ${command}` };
}

/** 把事实层聚合到她那一层上（**只在内存里**；一个字节都不写回她的文件） */
export function withFacts(entries: readonly TaskAsset[], source: AssetFactSource): TaskAsset[] {
  return entries.map(entry => ({ ...entry, fact: factOf(entry, source) }));
}

/**
 * 把框架的事实层折成条目，并用**她那一层**去重（她写过的不再重复出现）。
 *
 * 为什么会有这一层：用户要的是"**别要求她手抄事实**"——有哪些技能、配了哪些 MCP server、
 * PATH 里有什么，框架自己知道，就该自己列出来；她只需要在"要用"的时候写清"什么时候用、怎么用"。
 * 两条边界：
 *   • **事实条目的"在哪"是框架探测到的真实结论**（不是她写的），所以那一行直接写它；
 *   • 名字已经被她写过（同分类）就不再列——**她的那一层优先**（她写了说明文件路径，
 *     那比她没写更有用），事实层只补她没提过的。
 */
export function factEntries(source: AssetFactSource, hers: readonly TaskAsset[]): TaskAsset[] {
  const owned = new Set(hers.map(entry => `${entry.kind}:${entry.name.trim().toLowerCase()}`));
  const out: TaskAsset[] = [];
  const push = (entry: TaskAsset): void => {
    if (owned.has(`${entry.kind}:${entry.name.trim().toLowerCase()}`)) return;
    out.push(entry);
  };
  for (const skill of source.skills ?? []) {
    push({ kind: 'skill', name: skill, purpose: '技能（读了它的说明再用）', where: 'skill 目录里有它', from: 'fact', fact: { state: 'ready', detail: '技能目录里有它' } });
  }
  for (const server of source.mcp ?? []) {
    // 事实条目的"在哪"必须是**框架真知道的那点事**：声明在配置里（就绪与否未知就写未知）
    const where = server.ready === true
      ? 'server 已启动'
      : server.ready === false ? '已配置（未启动）' : '已配置（是否已启动未知）';
    push({
      kind: 'mcp',
      name: server.name,
      purpose: 'MCP server（她在配置里声明的）',
      where,
      from: 'fact',
      fact: { state: 'declared', detail: where },
    });
  }
  return out;
}

/** 她那一层 + 事实层 = 喂给 light 的索引（也用于渲染前的核对） */
export function indexOf(hers: readonly TaskAsset[], source: AssetFactSource): TaskAsset[] {
  return [...withFacts(hers, source), ...factEntries(source, hers)];
}

/**
 * 本机 `PATH` 上找一条命令（`[path]` 条目的就绪探测）。
 *
 * 判据只认两件事，不跑子进程（不花钱、不阻塞、不因为 PATH 里某个目录读不到就炸）：
 *   • 给的是绝对路径 ⇒ 看它是不是一个存在的文件；
 *   • 否则按 `PATH` 逐个目录找 `名字` + `PATHEXT` 里的每个后缀。
 *
 * `lookup` 可注入（测试与只读场景用）；缺省读本进程的 `process.env`——**这是宿主的能力**，
 * 所以它不在渲染层、也不在纯函数里，只在"要干活的那一拍"被调一次。
 */
export function probeOnPath(
  command: string,
  env: { PATH?: string | undefined; PATHEXT?: string | undefined } = process.env,
): { found: boolean; path?: string } {
  const name = command.trim().replace(/^["'`]|["'`]$/gu, '');
  if (name === '') return { found: false };
  if (isAbsolute(name)) {
    return existsSync(name) && isFile(name) ? { found: true, path: name } : { found: false };
  }
  // 后缀判定按**正斜杠**来：`extname` 不把 `\` 当分隔符，`D:\Tools\a\obscura.exe` 在它眼里
  // 整串都是"文件名"——那样就会去找 `obscura.exe.EXE`，一条真实存在的绝对路径被报成"未找到"。
  const exts = extname(name.replace(/\\/gu, '/')) === ''
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(part => part.trim() !== '')
    : [''];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    const base = dir.trim().replace(/^"|"$/gu, '');
    if (base === '') continue;
    for (const ext of exts) {
      const candidate = join(base, `${name}${ext}`);
      if (existsSync(candidate) && isFile(candidate)) return { found: true, path: candidate };
    }
  }
  return { found: false };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// ──────────────────────────────── 渲染（那一行） ────────────────────────────────

/**
 * **说明字段的规矩：一行、一句话。**
 *
 * 这条是**展示层**的纪律，写在代码里的理由是它防的是一种会反复犯的错：
 * 清单里的"在哪"（她习惯写成 `说明：…`）很容易被越写越长——把**怎么用**、命令怎么拼、
 * 哪条路跑不通、实测结论、注意事项一起塞进去。那一格一旦带着命令原文进那一行，就等于
 * **把 SKILL.md 的正文整段抬进上下文**——而此刻层是**每一步都发**的，这笔开销每步都付。
 *
 * 所以口径钉死在这里：**命令与细节属于 SKILL.md（她该自己去读），展示层只取一句话**。
 * 将来真有人在清单里塞命令，这一行也不会把整段抬进上下文——截在展示层，不靠她自觉。
 *
 * 这一条**不改她的文件**（`MEMORIES/assets.md` 是她的资产，框架不替她写、不替她改）：
 * 截的是渲染出来的那几个字节，落盘的清单一个字符都没动。
 */

/**
 * 她写说明时的引导词（`说明：…` / `说明:…`：这一格是在**指路**，不是在讲细节）。
 *
 * 只认第一个分隔符（`（` / `(` / `。`）之前的那一小截——**指路 = 那个路径**，
 * 后头的括注与句子都是**细节**（属于 SKILL.md 正文）。她写的
 * `说明：MEMORIES/skills/<技能名>/SKILL.md（正文同目录 <脚本>；…）`
 * 因此只留 `MEMORIES/skills/<技能名>/SKILL.md`。
 */
const NOTE_POINTER = /^说明\s*[:：]\s*([^（(。]*)/u;

/** 真正的句末（**冒号与逗号不算**——`要跑这个：` 那种切出来是个没用的残句，见 [isSentenceEnd]） */
const SENTENCE_DOT = /[。！？!?]/u;
/** 次要停顿（分号类）。只在没有句末标点时兜底——她一句话里连写三段时，切在第一段更像话 */
const SENTENCE_STOP = /[；;]/u;

/** 收尾符号（右引号/右括号一类）——切在句末标点上时往后一起收，别在段中留一个孤零零的引号 */
const CLOSER = /[」』”’"）)】\]]/u;

/** 收尾标点（句号/逗号/分号/冒号类）。`…` 不叠在它们后面——本来就是个中止符，再叠一个就是怪相 */
const CLIP_TAIL = /[。．.，,、；;：:]+$/u;

/**
 * 这个字符能不能当**切点**（切完就是第一句）。
 *
 * 两级判据：
 *   • **句末**（`。！？` 与半角 `!?`）——一定切；`：` 与 `，` **不切**：
 *     `要跑这个：\`pwsh …\`` 切在冒号上只剩一个没有宾语的残句（她还以为那就是全部说明），
 *     而 `：` 后头那一段正是这一句的内容；
 *   • 一个句末标点都没有时，退到**分号**（`；`）——她一句话里连写两段时，切在第一段更像话。
 *
 * 另一条不能省的：**反引号包起来的命令整段跳过**——命令里带 `.` / `。`
 * （`` pwsh -File x.ps1 ``）时按句末切会把命令切成两半，比不切更坏。反引号成对出现，
 * 所以数到奇数个就说明"当前在命令里"。这一条只影响切点判定，不改动任何字节。
 */
function isSentenceEnd(text: string, index: number): boolean {
  const char = text[index] ?? '';
  if (!SENTENCE_DOT.test(char) && !SENTENCE_STOP.test(char)) return false;
  let ticks = 0;
  for (let i = 0; i < index; i += 1) if (text[i] === '`') ticks += 1;
  return ticks % 2 === 0;
}

/**
 * 取**第一句**（一个句末标点都没有就整段返回）。
 *
 * 判据是用户 2026-10-07 定的三条**畸形**：说明里**含换行**、或**括号不闭合**、或**含反引号
 * 包起来的命令**（`` `…` ``）⇒ 只取第一句，**并如实**（末尾那半句 `…` 就够；
 * **不伪造内容**——截出来是什么就是什么，绝不替她补一个"完整的说法"）。
 *
 * 前两条由调用方在 [clipAssetNote] 里判（先判后切，见那里的注释）；这一条只管"哪儿算一句"。
 */
function firstSentence(text: string): string {
  const dot = sentenceCut(text, SENTENCE_DOT);
  if (dot !== null) return text.slice(0, dot);
  const stop = sentenceCut(text, SENTENCE_STOP);
  return stop === null ? text : text.slice(0, stop);
}

/** 按给定标点类找第一个切点（含它后头跟的收尾符号；找不到给 null） */
function sentenceCut(text: string, marks: RegExp): number | null {
  for (let i = 0; i < text.length; i += 1) {
    if (!marks.test(text[i] ?? '') || !isSentenceEnd(text, i)) continue;
    let end = i + 1;
    while (end < text.length && CLOSER.test(text[end] ?? '')) end += 1;
    return end;
  }
  return null;
}

/**
 * 说明文本**归一成"一行、一句话"**（纯函数、确定性：同一输入永远同一串字节，重放逐字节可重建）。
 *
 * 顺序是有讲究的（别调换）：
 *   ① 先取**第一行**（有换行 ⇒ 只留第一行：多行说明是"畸形"的第一条判据，她自己写的时候
 *      也确实是"一行一句话"）；
 *   ② 再把换行/制表/Tab 全压成空格（**这一行永远是一行**，也顺手兜住 `\r` 与别的空白）；
 *   ③ `说明：…` 那一格**只取指路**（[NOTE_POINTER]）——她那一格的本意是"细节在哪、你自己去读"，
 *      后头的括注（`正文同目录 <脚本>`）、实测结论、命令都是**细节**；
 *      取出来的那个路径**就到此为止**（它是"路"，不是"话"——不再按句末切它，
 *      路径里真有个 `。` 时切成两半就指不到任何文件了）；
 *   ④ 剩下的**话**再判畸形：**含反引号命令**（`` `…` ``）或**括号不闭合** ⇒ 只取**第一句**
 *      （**只切一刀**，切完就是原话的前缀，一个字都不改）；
 *   ⑤ 最后按**字符**（不是字节）截断并缀 `…`——**这一步对每一条都执行**（按行的规矩：
 *      说明 ≤60），所以"取第一句"取出来的长句照样会被收进 60 里。
 *
 * 五处"不越界"的分寸：
 *   • **事实层不进来**：调用方只在"她写的那一层"上调它（见 [renderAssetShort]）——
 *     `skill 目录里有它` / `已在 PATH → …` / `路径：…` / `未安装（需要 X）` 本来就短，保持原样；
 *   • **指路不切半**：见第③步；这也是这一格与"话"分开处理的原因；
 *   • **路宽话窄**：一截**指路**（一个路径）用 [ASSET_NAV_CHARS_MAX]，其余的话用 [ASSET_NOTE_CHARS_MAX]
 *     ——判据在 [looksLikePath]（它只看形状，不猜内容）；
 *   • **括注不吞**：截断后如果末尾悬着一个**没闭合的左括号**，就把那一小截摘掉
 *     （`（说明：skills/x/SKILL.md` ⇒ `说明：skills/x/SKILL.md`），
 *     免得那一行最后长出一个永远不闭合的括号（**不替她补一个闭括号**：那是编）；
 *   • **不叠 `…`**：末尾已经落在标点（句号、逗号、分号类）上时不再缀 `…`，也不叠第二个 `…`。
 */
export function clipAssetNote(text: string, max = ASSET_NOTE_CHARS_MAX): string {
  const firstLine = text.split(/\r?\n/u, 1)[0] ?? '';
  const flat = firstLine.replace(/\s+/gu, ' ').trim();
  if (flat === '') return '';
  const pointer = NOTE_POINTER.exec(flat);
  if (pointer !== null) {
    const target = (pointer[1] ?? '').trim();
    // 指路取出来了就以它为准（`说明：` 与后头的细节都不进这一行）——**只留路径本身**，
    // 因为"细节在哪"才是那一格要回答的事（她照着它去读 SKILL.md）。
    if (target !== '') return clipFlat(target, ASSET_NAV_CHARS_MAX);
  }
  const body = flat.includes('`') || bracketsBalanced(flat) === false ? firstSentence(flat) : flat;
  return clipFlat(body, looksLikePath(body) ? ASSET_NAV_CHARS_MAX : max);
}

/**
 * 这一截看着像**一条路径**吗（决定用哪根尺子：路宽、话窄）。
 *
 * 判据只认**形状**，不猜内容（也不读文件系统——本模块是纯函数的，读盘是宿主的事）。
 * 只有当这一截**整体就是一条指路**时才算"路"：
 *   • **裸路径**：没有空白，且（带盘符 `D:\…`、UNC `\\…`、以 `/` 开头，或含 `/`·`\`）；
 *   • **量词 + 路径**：`已在 PATH（D:\…）` / `路径：D:\…` 这种——把量词摘掉之后剩下的整串
 *     是一条裸路径。她写"在哪"最常用的就是这两种写法，所以得认。
 *
 * 为什么判据收得这么紧（**别放宽**）：只要一段**话**里出现过路径就给它 120 字符的额度，
 * 等于让"命令 + 细节"从这条路绕回来——实测那条 335 字符的说明里就有
 * `"<repo>\skills\anysearch\scripts\anysearch_cli.ps1"`。
 * 判据一宽，最该被截的那一类恰好豁免，这一版就白改了。
 * 反过来，真路径里极少带空格（带空格的那些本来就该用引号，展示层不负责解引用）。
 */
function looksLikePath(text: string): boolean {
  const flat = text.trim();
  if (flat === '') return false;
  if (isBarePath(flat)) return true;
  // 量词 + 路径：`已在 PATH（…）` / `路径：…` —— 只认这两个引导词，摘掉后必须整体是一条裸路径
  const qualified = /^(?:已在\s*PATH\s*[（(]|路径\s*[:：]\s*)([\s\S]*?)[）)]?$/u.exec(flat);
  if (qualified === null) return false;
  return isBarePath((qualified[1] ?? '').trim());
}

/** 一整串就是一条路径（没有空白、有路径形状） */
function isBarePath(text: string): boolean {
  if (text === '' || /\s/u.test(text)) return false;
  if (/[A-Za-z]:[\\/]/u.test(text) || text.startsWith('\\\\') || text.startsWith('/')) return true;
  return /[\\/]/u.test(text);
}

/** 半角与全角括号都算（她的清单里两种都出现过） */
function bracketsBalanced(text: string): boolean {
  let depth = 0;
  for (const char of text) {
    if (char === '（' || char === '(') depth += 1;
    else if (char === '）' || char === ')') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * 一行文本的硬截断（按字符数；超了才缀 `…`，且不叠在标点后面）。
 *
 * `…` **算在额度里**：结果是**至多** `max` 个字符（先留一格给省略号再切）——
 * 不然"≤60"这条判据会变成"≤61"，测试与报告里那个数就对不上了。
 */
function clipFlat(text: string, max: number): string {
  const flat = text.trim();
  if ([...flat].length <= max) return flat;
  const head = [...flat].slice(0, Math.max(1, max - 1)).join('').trimEnd();
  const trimmed = head.replace(CLIP_TAIL, '');
  if (trimmed !== head) return trimmed;
  return head.endsWith('…') ? head : `${head}…`;
}

/** 末尾悬着的**没闭合**的左括号：连它前面那一小截一起摘掉（`（说明：x` ⇒ `说明：x`） */
const DANGLING_OPEN = /[（(][^）)]*$/u;

/** 括注末尾如果悬着一个没闭合的左括号，把那一截摘掉（摘不动就原样留着，绝不编一个闭括号） */
function withoutDanglingOpen(text: string): string {
  const hit = DANGLING_OPEN.exec(text);
  if (hit === null) return text;
  if (hit[0].length >= text.length) return text;
  return text.slice(0, hit.index).replace(/[；;，,、\s]+$/u, '').trimEnd();
}

/**
 * 清单里"名字 ｜ 用途 ｜ 在哪"里的**名字 + 在哪**（用途不进这一行：给 light 判断相关性用，
 * 摆在上下文里只会变长，而她要看的是"这东西在哪、到底有没有"）。
 *
 * **她那一段照原文**——不做任何美化：清单写"未安装（需要 X）"，这一行就写"未安装（需要 X）"。
 * 用户的要求是"不许让看起来有"，所以这里连"（路径）"这种括注都不替她加。
 * 唯一的加工是上面那条**说明规矩**：`说明：…` 取指路那一截、整格归一成一行一句话、
 * 截到 [ASSET_NOTE_CHARS_MAX]（**她写的东西一个字都没被改**，只是没被整段抬进上下文）。
 *
 * **事实层那几条走的是另一条路**（`from === 'fact'` 那一条分支）：原文照旧、**不截不切**——
 * `skill 目录里有它` / `已在 PATH → …` / `路径：…` / `未安装（需要 X）` 本来就短，
 * 而它们每一句都是"就绪与否"的**结论**，截掉半句就是误导（"不许让看起来有"的反面）。
 * 这也是为什么它**排在最前面**：事实层一个字都不该被这一版的规矩碰到。
 *
 * 事实层的核对结论**只做两件事**（都不改原文）：
 *   • `missing` ⇒ 缀一句 `已探测：未找到`（它现在真的不在了——技能被删、命令被卸）；
 *   • `ready` 且探测到了**真实路径**（`[path]` 那种）⇒ 把真实路径也给她（她要照它去跑）。
 */
export function renderAssetShort(entry: TaskAsset): string {
  const fact = entry.fact ?? null;
  // 事实条目（`factEntries` 折出来的那几条）：**框架自己的结论，原样**——不截不切，排在最前
  if (entry.from === 'fact') return `${entry.name}（${entry.where}）`;
  if (fact?.state === 'missing') return `${entry.name}（${entry.where}；已探测：未找到）`;
  const note = clipAssetNote(entry.where);
  if (fact?.state === 'ready' && entry.kind === 'path'
    && /[\\/]/u.test(fact.detail) && !entry.where.includes(fact.detail)) {
    return `${entry.name}（${note} → ${fact.detail}）`;
  }
  return withoutDanglingOpen(`${entry.name}（${note}）`);
}

/**
 * 此刻层任务卡里那一行（**只读**：不动她的 todo，也不产生任何"已读/已选"状态）。
 *
 * 形状（用户 2026-10-06 定的，除条目外**必须带指路**）：
 *   `本任务相关资产：Obscura（D:\…\obscura.exe）· gh（已在 PATH）——完整清单见 MEMORIES/assets.md`
 *
 * **指路那一句不能省**（用户的第 5 条）：light 只挑 ≤3 条，漏选是常态；没有指路，
 * "漏选"就等于"她不知道有这个"。有了它，她随时能自己去读全份清单——这一行是**提醒**，不是清单。
 *
 * **能渲染的才渲染**（判据在 `renderable`，v34 接线时收窄过）：
 *   • 事实层**核对过、结论是"不在"**（`missing`）⇒ 滤掉：一条"现在真的用不了"的东西摆在任务旁边
 *     只会误导（她会去试、然后撞墙）；
 *   • 她自己写着**未安装** ⇒ 滤掉（同上）；
 *   • 框架**这一轮没核对的依据**（`unknown`：读不到 MCP 配置面 / 没有技能目录 / 没有探测手段）
 *     ⇒ 也滤掉——**不写误导性文字**（用户的原话："读不到配置面就整格留空并不渲染"）。
 *     注意这与"就绪不可知"不是一回事：「已配置（是否已启动未知）」是 `declared`，**能渲染**
 *     （那是有话说，只是不知道起没起）；`unknown` 是"我这一轮压根没核过"。
 *   先滤掉再截前三条——截断之后仍然 ≤3，且**每条都是能给她看的那一类**。滤空了整行不出现。
 *
 * 没有可选条目时返回空串（整行不出现——不写"暂无"、不写"0 条"）：
 * 那一行只在"真的挑出了能给她的东西"时才存在，否则它只是每轮多付一次的前缀噪音。
 *
 * 坏行计数（`skipped`）只在**真有坏行**时缀一句——她在维护这份清单，知道"有几行我没读懂"
 * 比让她以为"清单就这几条"要好；但也不能让它变成每轮都挂着的一句话。
 *
 * **每一条的"说明"在这里被收成一行一句话**（v39，2026-10-07；规矩与判据全在 [clipAssetNote] 上）：
 * 那一格是**指路**，不是 SKILL.md 的正文——命令与细节由她自己照指路去读。
 * 这一层不改她的文件（`MEMORIES/assets.md` 一个字节都不动），只决定**进上下文的那几个字节**。
 */
export function renderAssetsLine(entries: readonly TaskAsset[], skipped = 0): string {
  const usable = entries.filter(entry => entry.name !== '' && renderable(entry));
  const picked = usable.slice(0, ASSET_PICK_MAX);
  if (picked.length === 0) return '';
  const list = picked.map(renderAssetShort).join(' · ');
  const rest = skipped > 0 ? `（清单里另有 ${skipped} 行没读懂，格式是「[分类] 名字 ｜ 用途 ｜ 在哪」）` : '';
  return `本任务相关资产：${list}${rest}——${ASSETS_INDEX_POINTER}`;
}

/**
 * 这一条**现在能用**吗（`false` = 现在真的碰不到：技能删了 / 命令不在 PATH / 她写着未安装）。
 *
 * 与 [renderable] 的分别：`unknown`（这一轮没核对）**算能用**——没核对不等于不能用，
 * 她照自己写的那份去试是对的；只是它不该进那一行提示（见 `renderable`）。
 * 判据只两条：事实层**核对过**说不在（`missing`），或她自己写着"未安装"。
 */
export function isUsable(entry: TaskAsset): boolean {
  if (entry.fact?.state === 'missing') return false;
  return !NOT_INSTALLED.test(entry.where);
}

/**
 * 这一条能不能进**那一行提示**（此刻层任务卡上的一行）。
 *
 * 在 [isUsable] 之上再收一道：`unknown`（框架这一轮没有核对的依据）也不进——
 * 用户的口径是"读不到配置面就整格留空并不渲染（不要写误导性文字）"。
 * 把一条"我压根没核过"的东西摆在她的任务旁边，等于让她以为框架已经确认过它。
 */
export function renderable(entry: TaskAsset): boolean {
  return isUsable(entry) && entry.fact?.state !== 'unknown';
}

// ──────────────────────────────── 选取（一次 light） ────────────────────────────────

/** light 回包的形状：只要**序号**，不要它改写我的清单 */
const PICK_SCHEMA = {
  type: 'object',
  properties: {
    picks: { type: 'array', items: { type: 'integer' } },
  },
  required: ['picks'],
  additionalProperties: false,
} as const;

export const ASSET_PICK_INSTRUCTIONS = [
  '下面是一台机器上可用资产的**索引**（编号 ｜ 分类 ｜ 名字 ｜ 用途 ｜ 就绪情况），以及这台机器',
  `伙伴马上要做的一件事。分类的含义：[skill] 读说明照着做、[mcp] 走它的调用面、[path] 用 ${shellToolName()} 跑。`,
  '挑出**做这件事可能用得上**的资产编号，最多 3 个，按相关度从高到低。',
  '纪律：',
  '1. 只挑真的相关的；拿不准就不挑——挑错会让她去用一件不对的东西，比不挑更坏。',
  '2. 标着"已探测：未找到"或"未安装"的**不要挑**（它现在用不了）。',
  '3. 一条都不相关就返回空数组；只输出编号，不要输出名字，也不要改写索引。',
].join('\n');

/** 容错取 JSON（与 injection-judge / 记忆整理同口径的宽松解析） */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const body = fenced === null ? trimmed : (fenced[1] ?? '').trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function textFromOutputs(response: DsResponse): string {
  let text = '';
  for (const item of response.outputItems) {
    if (item.type === 'message') text += item.text;
  }
  return text;
}

/** 从回包里取序号（去重、越界丢弃、按模型给的顺序、截到上限） */
export function readPicks(payload: unknown, total: number): number[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const raw = (payload as Record<string, unknown>)['picks'];
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const item of raw) {
    const value = typeof item === 'number' ? item : Number.parseInt(String(item), 10);
    if (!Number.isInteger(value) || value < 1 || value > total) continue;
    if (out.includes(value)) continue;
    out.push(value);
    if (out.length >= ASSET_PICK_MAX) break;
  }
  return out;
}

/** 一条索引行（**廉价**：编号 + 分类 + 名字 + 用途 + 就绪情况，不给正文） */
export function assetIndexLine(entry: TaskAsset, index: number): string {
  // **用不了的当场标出来**（事实层核对过说不在，或她自己写着"未安装"）：light 才知道不该挑它
  // ——挑了也会被渲染层滤掉，白白占掉三个名额里的一个。
  // `unknown`（这一轮没核对）**不标**：没核对不是"没有"，标了就是编。
  const unusable = !isUsable(entry);
  const why = entry.fact?.state === 'missing'
    ? entry.fact.detail
    : (NOT_INSTALLED.test(entry.where) ? '清单里写着未安装' : '');
  const state = unusable ? `⚠ ${why === '' ? '现在用不了' : why}` : (entry.fact?.detail ?? '');
  const tail = state === '' ? '' : ` ｜ ${clip(state, 60)}`;
  return `${index} ｜ [${entry.kind}] ${clip(entry.name, 40)} ｜ ${clip(entry.purpose, ASSET_TITLE_CHARS_MAX)}${tail}`;
}

/** 索引清单 → 喂给 light 的标题行 */
export function assetTitleLines(entries: readonly TaskAsset[]): string[] {
  return entries.slice(0, ASSET_TITLE_LINES_MAX).map((entry, i) => assetIndexLine(entry, i + 1));
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** 一次选取的结果（给调用方写账、给测试断言） */
export interface AssetSelection {
  /** 选中的条目（≤ [ASSET_PICK_MAX]，按相关度） */
  entries: TaskAsset[];
  /** 选取理由：'none' 没清单/空清单（**没有发请求**）· 'model' 走了 light · 'failed' light 失败 */
  by: 'none' | 'model' | 'failed';
  /** 清单里的坏行数（原样带给渲染层） */
  skipped: number;
  /** light 是否真的发了请求（测试断言"闲聊那一拍不选"就数它） */
  called: boolean;
}

export interface SelectAssetsOptions {
  ds: Pick<DsClient, 'generate' | 'modelFor'>;
  /** 任务标题（本轮唤醒那句话的人读摘要，与任务卡同一个来源） */
  task: string;
  /** 事实层（宿主聚合）：技能目录、MCP 声明、PATH 探测 */
  facts?: AssetFactSource;
  log?: EventLog | null;
  projection?: Projection | null;
  now?: () => Date;
  turn?: number;
  timeoutMs?: number;
  out?: (line: string) => void;
}

/**
 * 从索引清单里挑 ≤3 条与本任务相关的资产（**一次 light 调用**）。
 *
 * 三条分寸：
 *   • **没有清单、清单里一条都没有 → 一次请求都不发**（返回 `by:'none'`）。这是"清单不存在
 *     就不渲染、不报错"那条要求的实现：判据在发请求之前，而不是让模型去挑一份空清单。
 *   • **失败即空**（`by:'failed'`）：选取不可用时她照样开工，只是这一轮没有那一行提示——
 *     绝不把它变成"开不了口"的前置条件（与 injection-judge 同一条分寸）。
 *   • 记账与别的 light 调用**同一份口径**（`budget/consumed{lane:'light'}`）：失败也记，
 *     否则 light 通道坏了 failStreak 永远是 0。
 */
export async function selectAssets(dataDir: string, opts: SelectAssetsOptions): Promise<AssetSelection> {
  const doc = readAssets(dataDir);
  const facts = opts.facts ?? {};
  // 她那一层为空时**仍然要看事实层**：技能与 MCP 是框架知道的，她没抄过也该被提醒到。
  const index = indexOf(doc?.entries ?? [], facts);
  if (index.length === 0) {
    return { entries: [], by: 'none', skipped: doc?.skipped ?? 0, called: false };
  }
  const startedAt = (opts.now ?? (() => new Date()))().getTime();
  let response: DsResponse | null = null;
  try {
    response = await opts.ds.generate({
      ...buildAssetPickRequest(index, opts.task),
      signal: AbortSignal.timeout(opts.timeoutMs ?? ASSET_SELECT_TIMEOUT_MS),
    });
    const indexes = readPicks(extractJson(textFromOutputs(response)), index.length);
    const picked = indexes
      .map(i => index[i - 1])
      .filter((entry): entry is TaskAsset => entry !== undefined);
    account(opts, response, 'completed', startedAt);
    return { entries: picked, by: 'model', skipped: doc?.skipped ?? 0, called: true };
  } catch (err) {
    account(opts, response, 'failed', startedAt);
    (opts.out ?? (() => undefined))(
      `[数字资产] 选取失败，这一轮不渲染那一行：${err instanceof Error ? err.message : String(err)}`,
    );
    return { entries: [], by: 'failed', skipped: doc?.skipped ?? 0, called: true };
  }
}

/** light 账（lane=light，与 injection-judge / 记忆整理同口径） */
function account(
  opts: SelectAssetsOptions,
  response: DsResponse | null,
  finishReason: 'completed' | 'failed',
  startedAtMs: number,
): void {
  const log = opts.log ?? null;
  const projection = opts.projection ?? null;
  if (log === null || projection === null) return;
  const usage = response?.usage ?? null;
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const cacheHitTokens = Math.max(0, Math.min(usage?.cachedTokens ?? 0, inputTokens));
  const now = opts.now ?? (() => new Date());
  const event: BudgetConsumed = {
    seq: log.nextSeq(),
    ts: now().toISOString(),
    type: 'budget/consumed',
    data: {
      turn: opts.turn ?? 0,
      step: 0,
      lane: 'light',
      model: response?.model ?? (typeof opts.ds.modelFor === 'function' ? opts.ds.modelFor('light') : 'assets'),
      inputTokens,
      outputTokens,
      cacheHitTokens,
      cacheMissTokens: Math.max(0, inputTokens - cacheHitTokens),
      // 思维链 token：**每次都写**（没产思维链就是 0），见 log/types.ts 的字段注释
      reasoningTokens: usage?.reasoningTokens ?? 0,
      durationMs: Math.max(0, now().getTime() - startedAtMs),
      retryCount: 0,
      finishReason,
      tokensTodayAccum: projection.budget.tokensToday + inputTokens + outputTokens,
    },
    visibility: 'internal',
    origin: ASSETS_ORIGIN,
  };
  log.append(event, { sync: false });
  applyOne(projection, event);
  finalizePressure(projection, event.ts);
}

/** 选取请求体的**唯一**构造点（诊断/测试要断言"喂给 light 的是什么"时不必重抄一遍） */
export function buildAssetPickRequest(entries: readonly TaskAsset[], task: string): DsRequest {
  return {
    lane: 'light',
    input: [
      ASSET_PICK_INSTRUCTIONS,
      '',
      '可用资产索引：',
      assetTitleLines(entries).join('\n'),
      '',
      `马上要做的事：${clip(task, TASK_TITLE_MAX_CHARS) || '（没写标题）'}`,
    ].join('\n'),
    text: { type: 'json_schema', name: 'asset_picks', schema: PICK_SCHEMA } as DsTextFormat,
    // 思考强度：**用户的口径（2026-10-06）—— light 一律 `low`，不提供更改**
    // （另一档 heavy 一律 `high`，唯一落点是 `runtime/agent-loop.ts` 的 `toDsRequest`）。
    // **别给这里加配置项**：config.json 里没有、也不许长出能改它的字段——
    // 判据钉在 `test/thinking-effort-invariant.test.ts`（想加旋钮，那条测试要先红）。
    reasoning: { effort: 'low' },
  };
}
