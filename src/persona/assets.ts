/**
 * Irmia Agent — 数字资产（`MEMORIES/assets.md` + 框架聚合的事实层）
 *
 * **一个概念：数字资产。三个分类：`skill` / `mcp` / `path`**（2026-10-06 用户收窄口径）：
 * 「skill、MCP 工具、PATH 里有的东西，都已统一是数字资产。只不过**还按照 skill、mcp 这样的
 * 习惯去分类**。」
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
 *     MCP server、`PATH` 探测得到的结论。由 {withFacts} 聚合，任何一帧都不落盘、
 *     也不进她的文件。
 *   • **她的知识层（她写的）**：**什么时候用**、**怎么用**（她自己的说明文件路径）。落在
 *     `MEMORIES/assets.md`，一条 = `[分类] 名字 ｜ 一句话用途 ｜ 在哪`。
 *   于是"框架只读事实、她只写知识"，两边都不需要抄对方那一半。
 *
 * **v45 取消：框架不再替她"挑资产"**（2026-10-09 用户拍板，理由：准确率太低——他抽 18 条
 * 看过，一半合理，系统性误判是"去群里说一声"被匹到一个私有工具、"另一个实例"被匹到
 * `gh`）。原来那条**每轮一次 light 选取**（`selectAssets` / `buildAssetPickRequest` /
 * `renderAssetsLine`）连同此刻层任务卡上那一行「本任务相关资产：…」一起**删掉**了：清单**不再
 * 进她的上下文**，要用哪件由她自己照清单（与 SKILL.md）去读——那本来就是种子里写着的用法。
 *
 * 本模块现在只做四件事，全部是**机制**，没有一件是替她写内容：
 *   ① [ensureAssetsSeed]  —— 文件不存在时写一份**给未来她看的说明**（幂等；已存在一个字节都不动）；
 *   ② [parseAssets]       —— 把清单解析成条目（坏行如实跳过并计数，不编）；
 *   ③ [withFacts] 一族     —— **事实层**：就绪与否照实说，**不改写她写的"在哪"**
 *      （[factOf] / [factEntries] / [indexOf] / [probeOnPath]）；
 *   ④ [mcpIndexView]      —— **MCP 常驻索引那一屏的素材**（2026-10-10 加，用户的设计：
 *      "mcp 的存在类同 skill"，索引常驻、工具清单仍按需走 `mcp` 工具）。它读**配置面 +
 *      落盘清单缓存**，**不起任何进程**；⓷ 那一族因此重新有了生产消费者（见文件末尾那一篇）。
 *
 * **那条纪律（一个字都不许松）**：框架永远不替她写清单、不替她写用法、不替她读用法。
 * 它只做一件事——**把事实核对清楚**（有哪些、在哪、就绪没有），一个字的用法都不替她编。
 * 所以本模块里没有"生成一条资产"的函数，也永远不该有：清单里写什么、她的用法说明书放在
 * 哪个文件、什么时候读进来，都是她的决定（种子文件把这件事讲给她听）。
 *
 * **常驻的只有一行规则**（"先读说明再用，不许凭名字猜"），它在装置自述里
 * （`model/self-brief.ts` 第⑰段）——短、稳定、不吃缓存。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

import { MCP_TOOLS_CACHE_DIR, MCP_TOOLS_CACHE_VERSION, type McpServerEntry } from '../mcp/client.ts';
// `desc` 那一句的来源与判据（唯一实现：索引行与申请单校验都调它，两处不许各拼一遍）
import {
  MCP_DESC_INFERRED_LABEL, MCP_DESC_MISSING_CLAUSE, describeMcpIndexDesc, mcpServerDescOf,
} from '../mcp/description.ts';
import { memoriesDir } from './memory-maintain.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 清单文件名（与 `aliases.md` / `facts.md` 同级） */
export const ASSETS_FILE_NAME = 'assets.md';
/** 单条索引行的长度上限（字符） */
export const ASSET_TITLE_CHARS_MAX = 120;
/**
 * 那一行尾部本来是**指路**（v34 定的：`——完整清单见 MEMORIES/assets.md`）。
 *
 * **v45 起没有哪一行再引用它**（挑资产那条机制删了，见文件头）——留着它是因为这**一句话**
 * 仍然活着：它现在长在种子说明里（[ASSETS_SEED]），也是她读清单时看到的同一句；
 * 而这个常量是那句话在代码里唯一一份原样，别处要复述时照它抄，不要另写一个说法。
 */
export const ASSETS_INDEX_POINTER = '完整清单见 MEMORIES/assets.md';
/**
 * 她那一段**说明**的长度上限（字符，按**字符**切、不按字节切——中文一个字是一个字符）。
 *
 * **v45 起这一格不再进她的上下文**（挑资产那条机制删了，见文件头）：下面这一整段
 * （[clipAssetNote] 与它的尺子）**没有任何生产消费者**——它连同 `renderAssetShort` 留下的，
 * 是"那一行如果重新长出来，怎么截才不把她的文件弄坏"这条口径的实现与判据
 * （`test/digital-assets.test.ts` ⑩ 那几条仍然钉着它）。**别把它当成当前行为**：
 * 今天清单原样躺在盘上，一个字都不会被截。
 *
 * 当初为什么要有这个数（口径的来源，别丢）：说明进的是**此刻层任务卡**，而此刻层**每一步都发**
 * ——说明被整段抬进上下文，就是每步都付一次的常驻开销。实测（`data/events` 全量 111 条带 assets
 * 的 `memory/selected`）：那一行最长 527 字符、中位 125、均值 144，其中最长那条的 335 个字符
 * 全是她写在"在哪"里的说明（命令、实测结论、别走弯路——那些属于 SKILL.md 的正文）。
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
 *   ④ **清单不进她的上下文、也没人替她挑**（v45，2026-10-09 用户拍板取消那条 light 选取）：
 *      要用哪一件，由她自己照这份清单去读——所以种子**不许**再许诺"干活时会收到一行挑好的"
 *      （那是一条已经取消的机制，留着就是一句假话；判据在 `test/digital-assets.test.ts` ⑧a）。
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
 \`[path]\` 用 pwsh 跑。一条一行：\`[分类] 名字 ｜ 一句话用途 ｜ 在哪\`。
 三个分类都是**可选**的：不写分类就按 \`[path]\` 算。
 「在哪」如实写：\`已在 PATH\` / \`路径：…\` / \`未安装（需要 X）\`——写了"未安装"就是没装，
 别让它看起来像有；skill 与 mcp 写名字（或它的说明文件路径）就够，**框架会自己核对**
  "这个技能在不在、这个 server 配了没有"，你不用手抄事实。
 这份清单**不在你的上下文里**（也没有谁会替你挑几条递过来）：它是你自己查的台账——
 要动手做一件事之前，先照这份清单看一眼有没有现成的东西可用，
 再照每一条的指路去读它自己的说明；看完再动手。${ASSETS_INDEX_POINTER}。
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
   * 事实层核对结论；`null`/缺省 = **没核对**（不写"未知"，那一格就只写她写的那份）。
   *
   *   • `ready`  —— 事实层证明它就在那儿（skill 目录里有这个技能 / PATH 里找得到这个命令 /
   *                 MCP server 已启动）；`detail` 可以是探测到的真实路径（**探测结论**，可以写出来）；
   *   • `missing`——**核对过**、结论是"不在"（技能不在目录里、命令不在 PATH、配置里没这个 server）
   *                 ——如实说"未找到"，**不写成"能用"**（原话如此，v45 起没有哪一行再渲染它）；
   *   • `declared`——**有话说，但结论来自她自己写的那一行**（"清单里写着未安装"）或"配置里声明了、
   *                 但是否已启动未知"：照她写的算，**不猜**；
   *   • `unknown`——**框架这一轮没有核对的依据**（读不到配置面 / 没有技能目录 / 没有探测手段）
   *                 ——既不写"未找到"，也不假装核对过（没核对就不写误导性文字）。
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
 *     ——照原文说，**能用**（"未知"不等于"用不了"）；
 *   • `unknown` = **框架这一轮根本没核对的依据**（读不到配置面 / 没有技能目录 / 没有探测手段）
 *     ——它**不许被说成"没有"**：没核过就是没核过（`isUsable` 因此把它算在"能用"那一侧）。
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

// ──────────────────── 渲染（那一行：v45 起没有生产消费者，见下） ────────────────────

/**
 * **说明字段的规矩：一行、一句话。**
 *
 * ⚠ **v45 起这一段没有生产调用点**：渲染那一行（`renderAssetsLine` / `renderAssetShort`）随
 * "框架替她挑资产"那条机制一起删了（见文件头），留下的是**这一格的截断口径本身**——
 * 连同 `test/digital-assets.test.ts` ⑩ 那几条断言（长说明截 60、畸形只取第一句、
 * 指路不切半、多字节字符不切坏、同一输入逐字节相同）。**别把它读成当前行为**：
 * 今天清单原样躺在盘上，她的文件一个字都不会被截。
 *
 * 当初为什么要有它（口径的来源，别丢）：清单里的"在哪"（她习惯写成 `说明：…`）很容易被越写
 * 越长——把**怎么用**、命令怎么拼、哪条路跑不通、实测结论、注意事项一起塞进去。那一格一旦带着
 * 命令原文进上下文，就等于**把 SKILL.md 的正文整段抬进上下文**——而此刻层是**每一步都发**的。
 *
 * 所以口径钉死在这里：**命令与细节属于 SKILL.md（她该自己去读），展示层只取一句话**；
 * 真要重开一条"给她递点什么"的路，截在这一层，不靠她自觉。
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
 *   • **事实层不进来**：这一层只在"她写的那一层"上用（事实层的结论本来就短，原样说）——
 *     `skill 目录里有它` / `已在 PATH → …` / `路径：…` / `未安装（需要 X）` 保持原样；
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
 * 这一条**现在能用**吗（`false` = 现在真的碰不到：技能删了 / 命令不在 PATH / 她写着未安装）。
 *
 * 判据只两条：事实层**核对过**说不在（`missing`），或她自己写着"未安装"。
 * **`unknown`（这一轮没核对）算能用**——没核对不等于不能用，她照自己写的那份去试是对的。
 * 曾经还有一层更严的 `renderable()`（在它之上再滤掉 `unknown`），那是给"挑出来摆在任务旁边"
 * 用的：v45 取消那条机制时它一起删了（见文件头）。现在这个判据只服务事实层的如实汇报
 * （[factOf] 那一族），不再决定任何"要不要进上下文"。
 */
export function isUsable(entry: TaskAsset): boolean {
  if (entry.fact?.state === 'missing') return false;
  return !NOT_INSTALLED.test(entry.where);
}

// ──────────────────── MCP 常驻索引（2026-10-10：事实层重新有了消费者） ────────────────────

/**
 * 本模块**为什么会重新长出一个生产消费者**（写在最前面，免得下一轮又把它读成"没人用"）：
 *
 * v45（2026-10-09）取消「light 选取资产」之后，事实层那一族（[factOf] / [factEntries] /
 * [indexOf] / [probeOnPath]）一度**一个生产调用点都没有**（用户问过这件事）。2026-10-10
 * 用户给的设计又把这条路接了回来：**MCP 要有一份常驻索引在上下文里**（与技能 catalog
 * 同类同位），而这份索引的**事实来源**正是这里——"配置里声明了哪些 server"就是
 * `[mcp]` 那一格的事实（[AssetFactSource.mcp]），不是另造一份判据。
 *
 * 两处刻意复用、一处刻意不碰：
 *   • `[mcp]` 那一格的**就绪措辞**由 [factOf] 给（`已配置（是否已启动未知）` 那一族，
 *     唯一实现）——本模块**不另写一份**"这个 server 起没起"的说法；
 *   • 事实条目的**生成**走 [factEntries]（她的清单一栏为空：这段索引讲的是配置面的事实，
 *     不是她写的知识层）——于是"事实条目长什么样"仍然只有一处实现；
 *   • **不碰** `probeOnPath` 那条路：MCP 索引不需要 `[path]` 探测（一个子进程都不起，
 *     这是用户的口径"别去起进程"）。它仍然是"没消费者"的那一格，谁要重开 PATH 核对
 *     再来接它（`real-loop` 的 `probeAssetPath` 注入点也还留着）。
 */

/**
 * 这一版索引里**一个 server** 的四格事实（**写进事件的那一份**，见 `log/types.ts` 的
 * [McpIndexEntry]）。刻意与"渲染出来的那一行"分开：日后要改措辞不必动事件里的数。
 */
export interface McpIndexServerFacts {
  name: string;
  /** 配置里写着 `disabled: true`（保留条目但不起进程，**调用也不会拉起它**） */
  disabled: boolean;
  /** 那一刻知道的工具数；`toolsFrom === 'none'` 时是 0（**别读成"它一件工具都没有"**） */
  tools: number;
  /** 这个数从哪来：`live` = 活连接刚拉的 / `cache` = 落盘清单缓存（可能过期）/ `none` = 都没有 */
  toolsFrom: 'live' | 'cache' | 'none';
  /** `toolsFrom === 'cache'` 时那份清单的取回时刻（epoch ms），其余为 null */
  cachedAtMs: number | null;
  /**
   * **这个 server 是干什么的**那一句（2026-10-11 加，用户点名的"索引内容质量低"那一笔）。
   *
   * 来源与判据在 `mcp/description.ts`（唯一实现）：声明（`config.mcp.servers[].desc`）优先，
   * 落盘清单缓存里 server 自报的第一句工具描述**兜底**——后者是**推断**，
   * 渲染时**必须带标注**（`MCP_DESC_INFERRED_LABEL`）。
   * 两处都没有时是空串，渲染照实写 [MCP_DESC_MISSING_CLAUSE]（**不编一句出来**）。
   */
  desc: string;
  /** 上面那句话是哪来的：`config` 声明 / `cache` 推断 / `none` 两处都没有 */
  descFrom: 'config' | 'cache' | 'none';
}

/** 这一段索引与它的事实（**文本与事实一起交出去**：事件里两样都要落） */
export interface McpIndexView {
  /** 逐字节进请求的那段文字；**空串 = 整段不出现**（与技能 catalog 的 null/空语义一致） */
  text: string;
  servers: McpIndexServerFacts[];
  /** 上面那段文字是按哪一版**行模板**拼的（写进 `mcp/index` 快照，判"该不该重建"用） */
  descClauseVersion: number;
}

/**
 * **索引行模板的版本**（2026-10-11 加）。给索引行补一截时就 +1，**并且同批递 `RENDER_VERSION`**
 * （请求体字节真的变了）。
 *
 * 为什么要单独一个版本号，而不是只认 `RENDER_VERSION`：两者回答的是**两个问题**——
 *   • `RENDER_VERSION`（`render.ts`）= "这一串字节是哪一代**渲染模板**写下的"；
 *   • 本常量 = "这一**行**是怎么拼的"。
 * 绝大多数时候它们一起变，但"只动行模板"的那类改动（这一版给行尾补 `desc` 那一截就是）
 * 若只认前者，`mcpIndexSync` 就得靠"快照的 version ≠ 当前 RENDER_VERSION"来判断——
 * 那在**这一版自己的生命周期里**也成立（旧快照确实是 v47），于是**每一拍都会重建一次索引**，
 * 索引那一段就变成每轮都变的字节（正是 v46 花了一整版躲开的那件事）。
 * 有了本常量，判据变成"快照的行模板版本 ≠ 当前"⇒ **只重建一次**，之后照旧冻结。
 *
 * 版本 1 = 行里**没有** `desc` 那一截（`- name —— 状态，工具数`，即 2026-10-11 之前那一版）。
 * 缺这一格的老快照因此按 1 算：**该重建**（那一行正是用户抱怨的那一行），重建之后就冻结。
 */
export const MCP_INDEX_DESC_CLAUSE_VERSION = 2;

/**
 * 这份索引的**表头**（固定文案，与技能 catalog 的 `CATALOG_HEADER` 同一体例）。
 *
 * 三件事必须一次说清，少一件她就得靠猜：
 *   ① 这是**有哪些 server**（不是"有哪些工具"）——工具清单按需，见 `mcp` 工具；
 *   ② 要看/要调**都走 `mcp` 工具**（用户 2026-10-10 的原话：「入口不是自己读而是我们的统一
 *      mcp 工具」）；所以这一段里**一个工具名都没有**（有名字就等于把清单搬回常驻）；
 *   ③ 这一屏是**一次快照**（她得知道它可能不是此刻的现状——加删 server 之后的通报走的是
 *      后来那条追加，要拿最新的就调 `mcp` 工具现问）。
 */
export const MCP_INDEX_HEADER =
  '[MCP server] 配置里声明的 MCP server（每条 = 名字 + 启用状态 + 已见工具数）。'
  + '要调 MCP：用 mcp 工具——不带 server 看全部，带 server 看它的工具，server + tool 就是调用；'
  + '这一屏是**上一次快照**，加删 server 之后以框架的通报或 mcp 工具现问的为准。';

/** 表头之后那一句指路（与技能 catalog 尾句同一做法：把"下一步做什么"写死在固定文案里） */
const MCP_INDEX_POINTER = '（要看某个 server 的工具就调 mcp 工具带上它的名字；工具名不在这段索引里。）';

/**
 * 停用那一组的组头。**为什么要分组**：停用与启用**在索引里必须一眼可分**——用户要的判据是
 * "名字 + 启用/停用"，而"每行都缀一句状态"在十个 server 时很难扫；分组把这件事变成一个位置。
 */
const MCP_INDEX_DISABLED_HEADER = '（下面是配置里留着、但**已停用**的：不起进程，调用也不会拉起它）';

/**
 * 落盘工具清单缓存里那份形状（`<dataDir>/mcp-cache/<server>.json`）。
 *
 * ⚠️ 这里**只读它认得的那三格**（`version` / `server` / `tools`），其余一格不碰：
 * 缓存是**加速器**（池自己的注释如此），认不出来就当"没有缓存"，绝不因为解析不了就报错——
 * 一段索引不值得让进程多一句告警。`fingerprint` **刻意不校验**：那要重算 server 指纹
 * （命令/参数/cwd/env 的散列），属于池的内部口径（`client.ts` 的 `entryFingerprint`），
 * 本模块重写一遍就是第二份实现（而且这份索引**本来就不声称"这就是此刻的清单"**——
 * 它把"来自缓存、可能过期"写在那一行里）。
 */
interface CachedToolsShape {
  fetchedAtMs: number | null;
  tools: number;
}

/** 认一份缓存文件（认不出给 null；**永不抛**） */
function readToolsCacheFile(path: string): CachedToolsShape | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  // 版本对不上就当没有：缓存格式变了之后，旧文件的 `tools` 未必还是那个意思
  if (record['version'] !== MCP_TOOLS_CACHE_VERSION) return null;
  if (typeof record['server'] !== 'string' || record['server'].trim() === '') return null;
  if (!Array.isArray(record['tools'])) return null;
  const fetchedAtMs = record['fetchedAtMs'];
  return {
    fetchedAtMs: typeof fetchedAtMs === 'number' && Number.isFinite(fetchedAtMs) ? fetchedAtMs : null,
    tools: record['tools'].length,
  };
}

/**
 * 那一行里的"工具数"那一截（**来源必须写在行上**，见 [MCP_INDEX_HEADER]）。
 *
 * 三种来源说三种话，**没有一个字是猜的**：
 *   • 有缓存 ⇒ `已见 N 件工具（来自缓存，可能过期）`——"已见"是缓存文件的措辞（它记的是
 *     那一次拉到的份数），"可能过期"是用户给缓存定的口径（`mcp-entry` 的回执也这么说）；
 *   • 活连接有清单（`live`）⇒ `已见 N 件工具（本次运行拉到的）`；
 *   • 都没有（`none`）⇒ `工具清单还没拉过（要看就调 mcp 工具）`——**不写"0 件"**：
 *     "还没看过"与"它一件都没有"是两件事，写错那一格就是假话（事实层那条纪律）。
 */
function toolsClauseOf(server: McpIndexServerFacts): string {
  if (server.toolsFrom === 'cache') {
    const when = server.cachedAtMs === null ? '' : `，取于 ${isoMinute(server.cachedAtMs)}Z`;
    return `已见 ${server.tools} 件工具（来自缓存${when}，可能过期）`;
  }
  if (server.toolsFrom === 'live') return `已见 ${server.tools} 件工具（本次运行拉到的）`;
  return '工具清单还没拉过（要看就调 mcp 工具）';
}

/** `2026-10-10T03:12`（UTC，分钟精度）：给人看够用，且**与渲染时刻无关**（值来自缓存文件） */
function isoMinute(ms: number): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toISOString().slice(0, 16);
}

/** 一段索引里 server 那一行的措辞（**唯一实现**：文本与测试引用同一处） */
export function mcpIndexLineOf(server: McpIndexServerFacts): string {
  const status = server.disabled ? '已停用' : '启用';
  return `- ${server.name} —— ${descClauseOf(server)} —— ${status}，${toolsClauseOf(server)}`;
}

/**
 * 那一行里"它是干什么的"那一截（2026-10-11 加，用户点名的"索引内容质量低"那一笔）。
 *
 * 三种写法，**没有一种会编**（判据在 `mcp/description.ts`，这里只负责摆）：
 *   • 声明那句 ⇒ 原样（超长已在 `describeMcpIndexDesc` 里**可见地**截断）；
 *   • 推断那句 ⇒ 后面**必须**跟一句"据它自报的工具描述"（不标注就等于假造一条声明）；
 *   • 都没有   ⇒ [MCP_DESC_MISSING_CLAUSE]——**照实说这一格是空的**，而不是把这一截省掉：
 *     省掉之后索引读起来与改动之前逐字相同（那正是用户抱怨的那一行），
 *     而写上它，人一眼就看得出"该补的是这一格"。
 *
 * **停用的 server 照旧有这一截**：描述讲的是"它是什么"，与"现在起不起进程"无关；
 * 而"已停用"那一格由组头与行上的状态词承担（见 [MCP_INDEX_DISABLED_HEADER]）。
 *
 * 事实里那句**已经是截断过的**（`mcpIndexView` 造事实时就过 `describeMcpIndexDesc`）：
 * 同一份事实因此既能拼出这一行，又能在事件里如实记下"当时写进索引的就是这一句"。
 */
function descClauseOf(server: McpIndexServerFacts): string {
  if (server.desc === '' || server.descFrom === 'none') return MCP_DESC_MISSING_CLAUSE;
  return server.descFrom === 'cache' ? `${server.desc}${MCP_DESC_INFERRED_LABEL}` : server.desc;
}

/**
 * 从"配置面 + 落盘清单缓存"造这一段索引（**一个子进程都不起**，用户的口径）。
 *
 * 三个约束是硬的，改这一版时别松：
 *   ① **不读活连接、不起进程**：`McpClientPool` 归宿主（`main.ts`），本模块与 `real-loop`
 *      都拿不到它；而去起进程只为数一下工具数，正是用户点名不许的那件事。所以"工具数"
 *      只有两个来源：**落盘缓存**（池每次真拉到清单时写的）与"都没有"。
 *   ② **顺序确定**：按配置里的声明顺序（启用的一组在前、停用的一组在后）。配置是启动期
 *      读一次的东西 ⇒ 同一份配置渲染出同一串字节（缓存那段"取于"的时刻也来自文件、
 *      不来自时钟）⇒ 重放与运行期得到同一份。
 *   ③ **一个工具名都不许出现**：这一段回答"有哪些 server"，工具清单按需（`mcp` 工具）。
 *      往这里加工具名等于把披露式入口的价值整个抹掉（v43 那一版的红线）。
 *
 * `servers` 为空 ⇒ `text` 是空串（渲染层整段不出现）。**注意**：调用方（`real-loop` 的
 * `mcpIndexSync`）在空串时**不写快照事件**——"没有 server"这件事不需要一条事件来记，
 * 而写了它反而会让 `heartbeat-real-wake` 那类"事件序列逐字相同"的基线无故多一条。
 */
export function mcpIndexView(
  servers: readonly McpServerEntry[],
  dataDir: string,
): McpIndexView {
  if (servers.length === 0) return { text: '', servers: [], descClauseVersion: MCP_INDEX_DESC_CLAUSE_VERSION };

  // 事实层那一格的素材：**只有名字**（`ready` 我们看不到——池归宿主，这一格如实写"未知"，
  // 由 [factOf] 的既有措辞承担："已配置（是否已启动未知）"）。停用的条目**不进**这一份：
  // 它不是"一个可以核对的 server"，它是"配置里留着但不起进程"——那一行由本段自己说。
  const live = servers.filter((entry) => entry.disabled !== true);
  const source: AssetFactSource = { mcp: live.map((entry) => ({ name: entry.name })) };

  const facts: McpIndexServerFacts[] = servers.map((entry) => {
    const disabled = entry.disabled === true;
    const cached = disabled || entry.toolsCache === false
      ? null
      : readToolsCacheFile(join(dataDir, MCP_TOOLS_CACHE_DIR, `${entry.name}.json`));
    // "它是干什么的"那一句（2026-10-11 加）：声明优先、缓存兜底，**取不到就空着**。
    // 事实里存的是**渲染要用的那一份**（截断已经过 `describeMcpIndexDesc`）——
    // 同一份事实因此既拼得出这一行，又能在事件里如实记下"当时索引里写的就是这一句"。
    const declared = mcpServerDescOf(entry, dataDir);
    const indexDesc = describeMcpIndexDesc(declared);
    const descText = indexDesc.kind === 'none' ? '' : indexDesc.text;
    return {
      name: entry.name,
      disabled,
      tools: cached?.tools ?? 0,
      toolsFrom: cached === null ? 'none' : 'cache',
      cachedAtMs: cached?.fetchedAtMs ?? null,
      desc: descText,
      // 三态只认 `describeMcpIndexDesc` 的那两种来源：`absent` 归 `none`
      // （"声明与缓存都没有"与"渲染出来是空的"在索引这一层是同一件事）
      descFrom: descText === '' ? 'none' : (declared.source === 'cache' ? 'cache' : 'config'),
    };
  });

  // 事实层那一次走查（`factEntries`）：它把 `[mcp]` 那一格的**事实条目**造出来，
  // 而"起没起、配没配"的措辞只有那一处实现。这一版里它不再只是"造好了没人看"：
  // 下面的 `enabled` / `disabledLines` 两句分别用它给出的结论（见各自的注释）。
  const factRows = factEntries(source, []);

  const enabled = facts.filter((row) => !row.disabled);
  const disabled = facts.filter((row) => row.disabled);

  const lines: string[] = [MCP_INDEX_HEADER];
  if (enabled.length > 0) {
    lines.push(...enabled.map((row) => mcpIndexLineOf(row)));
  } else {
    // 一个启用的都没有（全停用）：**如实说**，不写"（空）"——"空"会被读成"没有 server"，
    // 而真相是"有几个、全都停用了"（下面那一段会把它们列出来）。
    lines.push(`（配置里的 ${facts.length} 个 server 全都是停用状态）`);
  }
  if (disabled.length > 0) {
    lines.push(MCP_INDEX_DISABLED_HEADER);
    lines.push(...disabled.map((row) => mcpIndexLineOf(row)));
  }
  // 事实层那一格本轮核对出来的结论：**只在"配置面读不到"时才有话说**
  // （`AssetFactSource.mcp === undefined` 那一支，detail 是"这一轮读不到 MCP 配置面"）。
  // 这一版永远读得到（素材就是配置本身）⇒ 正常情况下这一句根本不出现；留着它是因为
  // 判据只有一处实现——"没核对就不许说没有"这句纪律由 `factOf` 说了算，不由本段重新判。
  const unknown = factRows.find((row) => row.fact?.state === 'unknown');
  if (unknown !== undefined) lines.push(`（${unknown.fact?.detail ?? '这一轮没有可核对的事实'}）`);
  lines.push(MCP_INDEX_POINTER);

  return { text: lines.join('\n'), servers: facts, descClauseVersion: MCP_INDEX_DESC_CLAUSE_VERSION };
}
