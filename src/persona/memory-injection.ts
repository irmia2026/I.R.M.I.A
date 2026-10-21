/**
 * Irmia Agent — 记忆索引与注入（B2：2026-10-04；**只给索引**改于同日）
 *
 * 与 `docs/memory-injection.md` 逐条对齐。两件事，各管一段：
 *
 *   ① **索引**（`MEMORIES/INDEX.md`）：一份**指针表**——每条只有「相对路径:行号 + 一行摘要 +
 *      有没有 `!pinned`」。正文一个字都不在里面。它是机制生成的（归属写在文件头），
 *      渲染进请求的**本轮固定块**（v30 起；v29 时在长期记忆层）。
 *   ② **注入账**（`memory/selected`）：轮首写一条事件，记"这一轮注入了没有 + 当时那份索引的指纹
 *      与条数"（可重放/可审计的地基，见 docs/memory-injection.md §4）。**索引全文不落事件**。
 *
 * **正文怎么进上下文（2026-10-04 用户定稿：「只看索引，如果需要，heavy 自己去读，随后跟随
 * tool call 留在上下文」）**：机制**不再**替她挑几条正文塞进固定块。她需要哪一条，就照索引里的
 * 路径与行号 `safe_read` 现取——读回来的内容作为**工具结果**留在历史里，从此每轮都在前缀里
 * （KV 缓存天然命中），而不是每轮由机制重新编码一遍。
 *
 * 为什么这样更好（他的理由 + 代价，两边都记）：
 *   • 好处：注入的那一段从"索引 + 挑出来的正文"缩到**只有索引**；机制不必猜"哪几条相关"
 *     （那本来就该是她的判断），而且读回来的正文是**她自己按需取的**，相关性由她保证；
 *   • 代价：她得**自己想起来去读**。索引里没写的东西，她当场就是不知道——
 *     机制不再兜底"至少把置顶那几条推到她眼前"。这条取舍归用户，理由见 §5。
 *
 * 归属与边界（硬约束）：
 *   • 本模块**只读**她自己的记忆资产（`facts.md` / `jargon.md` / `style-notes.md` /
 *     `aliases.md` / `episodes/`），一个字节都不改写；
 *   • 唯一写的文件是索引自己（`INDEX.md`），且按内容**幂等**：渲染结果与盘上相同就不写盘
 *     ——"一次重启打掉一次缓存"这种冤枉事不该发生；
 *   • **不引入任何价格 / 货币 / 计费口径**（用户的明确要求）。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { estimateTokens } from '../tools/registry.ts';
import { EPISODE_DIR_NAME, MEMORY_DIR_NAME, parseEntryLine } from './memory-maintain.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 索引文件名（在 `MEMORIES/` 之下）。大写是刻意的：它是**机制生成**的资产，与她自己写的
 * 小写文件（facts.md / jargon.md …）在目录里一眼分得开。 */
export const MEMORY_INDEX_FILE = 'INDEX.md';

/**
 * 一条摘要的字符上限。
 *
 * 为什么这么短：索引待在**常驻层**——它按字符折算 token（中文约 1.5 字/token），
 * 40 字 ≈ 27 token；四十条就是 1100 token 上下的常驻开销。摘要是**钩子**不是正文：
 * 它的用途只是让她判断"要不要去读那一条"，读正文是 `safe_read` 的事。
 */
export const ENTRY_SUMMARY_MAX_CHARS = 40;

/**
 * 索引整体的 token 预算（软上限：按整条取舍，不截半句）。
 *
 * 它约束的是**常驻开销**——索引每轮都在请求里（这是"正文不进上下文"的必要代价，
 * 见 docs/memory-injection.md §7）。超出预算时先砍摘要长度、再按下面的优先级从低往高丢条目，
 * 并在尾部如实写明还有几条没展开。`!pinned` 条目**永不因为超预算被丢**：置顶的语义就是"永远在场"。
 *
 * ⚠ **它管的是白名单那一段（facts / jargon / style-notes / aliases）**（2026-10-15 起）：
 * `episodes/` 那一段走**必留专档**（见 {@link applyIndexBudget}），不计入这个数——
 * 理由是**盘上那份 `INDEX.md` 已经不进每轮注入**（注入层用的是全量那份、只印 top-6），
 * 它的"预算"其实是**文件大小**而不是每轮成本。**两段加起来**才是盘上那个文件的实际大小。
 */
export const INDEX_TOKEN_BUDGET = 900;

/**
 * 文件在索引里的出现顺序 = 注入顺序（确定性的一部分：同一份记忆永远印出同一份索引）。
 *
 * facts.md 排第一是刻意的：它是"关于世界与用户的稳定事实"，也是唯一带分区与
 * `!pinned` 标记的文件。其余三份按**用途的紧迫度**排，不按字母序——
 * 黑话（听不懂就会答错）、表达风格（答对了语气不对）、别名（认人）。
 */
const INDEX_FILES = ['facts.md', 'jargon.md', 'style-notes.md', 'aliases.md'] as const;

/**
 * episode 文件名：`YYYY-MM-DD.md`（与整理任务的 `listDueEpisodes` 同一条判据）。
 *
 * 只有这一种名字的文件进索引——她自己在 `episodes/` 里起的别的名字（草稿、临时笔记）不进来，
 * 理由是"候选集要可解释"：她看到编号 179–186 时应当能一口说出"那是 8 天的经历"。
 */
const EPISODE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/u;

/**
 * `assets.md` **不进索引**（2026-10-15 用户裁决，逐字）：
 * > 「**assets.md 不进，episodes/** 应当进**。」
 *
 * 写在这里是因为这一条**最容易被后人当成"又一次漏配"**：`assets.md` 就在 `MEMORIES/` 下、
 * 体积也不小（11 KB），看起来"没进索引"很像 bug。它不是——它是**明确的口径**。
 * 判据（报告 §7 那一栏）：`assets.md` 记的是**数字资产清单**（skill / MCP / 路径），
 * 属"装置自述"那一类，与"关于用户与世界的记忆"不是一回事；而它那 18 次读取也远少于 episodes。
 * ⇒ 要动它，先要用户点头，**不要顺手加进 {@link INDEX_FILES}**。
 */

/**
 * facts.md 的分区优先级（与 `memory-maintain.ts` 的 SECTION_ORDER 同源，但**不含归档区**）。
 *
 * 归档区的语义是"已失效 / 已过期"（`SECTION_TITLES.archive` 写着"不注入"），
 * 所以它一条都不进索引：指针指向一条已经作废的记忆，比不指还糟。
 */
const FACTS_SECTION_TITLES = ['## 置顶（pinned）', '## 约定与承诺', '## 稳定事实', '## 观察'] as const;

// ──────────────────────────────── 类型 ────────────────────────────────

/** 索引里的一条：**指针**（路径 + 行号）+ 一行摘要 + 置顶标记。没有正文。 */
export interface MemoryIndexEntry {
  /** 相对工作根的 posix 路径（如 `MEMORIES/facts.md`）——`safe_read` 的 `path` 参数就用它 */
  path: string;
  /** 条目在文件里的行号（1 起）。**与 `safe_read` 回显的行号同一口径**（它无条件带行号） */
  line: number;
  /** 一行摘要（已截断到 {@link ENTRY_SUMMARY_MAX_CHARS}） */
  summary: string;
  /** `!pinned`：永不衰减、永不归档，心跳轮与超预算时也照样注入 */
  pinned: boolean;
}

/** 一份建好的索引：条目 + 因预算被丢掉的条数（如实报告，不假装齐全） */
export interface MemoryIndex {
  entries: MemoryIndexEntry[];
  /** 预算丢掉的条数（0 = 全都在）。尾部那句"另有 N 条未展开"用它 */
  dropped: number;
}

/**
 * 单独一行"算条目"时的形状（{@link entryShapeAt} 的返回）。
 *
 * 与 {@link MemoryIndexEntry} 的区别只在**没有路径与行号**：那两样是调用方给的，
 * 不是从这一行里读出来的。分成两个类型是为了让"核对一条指针"这件事不必先编出
 * 一个假的 path/line 才能问出口。
 */
export interface MemoryEntryShape {
  /** 这一行的摘要（判据与建索引时**完全同一份**，含截断到 40 字） */
  summary: string;
  /** 这一行带不带 `!pinned` */
  pinned: boolean;
}

// ──────────────────────────────── 路径 ────────────────────────────────

/** 索引文件的绝对路径（`<dataDir>/workspace/MEMORIES/INDEX.md`） */
export function memoryIndexPath(dataDir: string): string {
  return join(dataDir, 'workspace', MEMORY_DIR_NAME, MEMORY_INDEX_FILE);
}

// ──────────────────────────────── 建索引 ────────────────────────────────

/**
 * 扫描记忆文件，建一份确定性的索引。
 *
 * 确定性来自三处（同一份记忆任何时刻建出同一份索引）：
 *   • 文件顺序固定（{@link INDEX_FILES}，facts.md 的分区顺序固定）；
 *   • 文件内按**行号升序**（时间序即文件序，persona.md §3）；
 *   • 摘要只做"取第一行 + 截断"，不做任何归纳。
 *
 * 读不到的单个文件按"没有"处理（她还没写过 jargon.md 是正常状态），不抛异常——
 * 索引是**尽力而为的目录**，不是校验器。
 */
export function buildMemoryIndex(
  dataDir: string,
  /**
   * `full: true` = **不做预算丢弃**（阶段一，2026-10-15）。
   *
   * 为什么是同一个函数上的一个开关，而不是第二个函数：两处的"什么算一条、顺序如何"
   * 必须**逐字节同一份判据**（`collectIndexEntries`），分成两个函数就有了漂的空间——
   * 而这里漂开的后果是**编号错位**（她按编号取到的是另一条记忆），不是报错。
   *
   * ⚠ **谁要用 `full: true`**（改动前先读完这几条）：
   *   · **编号**：给她的条目编号（`memory_read` 的 `index`、推荐段里那 6 条的序号）就是
   *     **这一份**的下标 +1。**不许**拿默认那一份去算编号——它被 900 token 预算截断过
   *     （实测 29/178），编号会随预算线漂，而"编号跟着索引重建变"只该由记忆文件真的变了引起。
   *   · **推荐候选集**：挑 top-6 是在全量上挑（`persona/memory-select.ts`），否则她真读过的
   *     那 61.8%（`episodes/**` 与别的不在指针表里的文件）永远进不了候选。
   *   · 默认档（`full` 省略）= 老行为**逐字节不变**：预算丢弃照旧（盘上 `INDEX.md` 的形态、
   *     `memory/selected.entries` 的规模口径都不动）。
   */
  options: { full?: boolean } = {},
): MemoryIndex {
  const entries = collectIndexEntries(dataDir);
  if (options.full === true) return { entries, dropped: 0 };
  return applyIndexBudget(entries);
}

/**
 * 预算丢弃（**唯一的实现**，2026-10-15 抽出来）：
 * 先按优先级（pinned 在前、其余按原序）算总 token，超了就**从后往前**丢非 pinned 条目。
 *
 * 为什么从后往前：索引的顺序本身就是优先级（分区优先级 + 时间序），尾部是最不该先看的那些。
 *
 * 为什么抽成导出的函数：`real-loop` 的 `memoryIndexPlan` 一次扫描要给出**两份**条目
 * （全量那份给编号与推荐候选集，预算这份给盘上 `INDEX.md` 与老读者），
 * 若那边自己再写一遍丢弃循环，两条预算线迟早漂开——而漂开的后果是**盘上索引与账目条数对不上**。
 */
export function applyIndexBudget(entries: readonly MemoryIndexEntry[]): MemoryIndex {
  // **episodes 走"必留专档"**（2026-10-15 用户裁决②）：它们排在白名单之后，而丢弃是**从尾部往前**的
  // ⇒ 不特殊处理的话它们**正好是第一批被丢的**（实测：加进去 8 条，一条都没进盘上 `INDEX.md`，
  // 文件与编号因此**不同源**——她数出 178、工具说 186。那正是这个仓库最忌讳的静默不一致）。
  // 所以先把它们摘出来、不参与丢弃循环，最后按原序接回去：
  //   · **pinned 永不丢**（老口径不变）；
  //   · **丢弃顺序仍是从尾部往前**，只是**遇到 episodes 专档就跳过**（= 专档先占位，
  //     再从剩下的非 pinned 尾部丢）；
  //   · 于是 `INDEX_TOKEN_BUDGET` 管的是**白名单那一段**，episodes 那一段是**另算的硬开销**
  //     （实测 8 条约 231 token）——这也正是"盘上那份不进每轮注入"的如实代价：
  //     它的预算是**文件大小**，不是每轮成本。
  const episodes = entries.filter(isEpisodeEntry);
  const kept = entries.filter((entry) => !isEpisodeEntry(entry));
  let dropped = 0;
  while (kept.length > 0 && estimateTokens(renderIndexEntries(kept, 0).text) > INDEX_TOKEN_BUDGET) {
    let victim = -1;
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      if (kept[i]?.pinned !== true) { victim = i; break; }
    }
    // 只剩 pinned 条目还超预算：摘要已经短到不能再短，只能照实印（置顶不许被丢）
    if (victim === -1) break;
    kept.splice(victim, 1);
    dropped += 1;
  }
  // 专档接在最后（= 白名单之后），保持 `collectIndexEntries` 给出的那一段顺序（日期倒序）
  return { entries: [...kept, ...episodes], dropped };
}

/**
 * 这一条是不是 episode 专档（`MEMORIES/episodes/<日期>.md`）。
 *
 * 判据挂在**路径**上（而不是新增一个字段）：① `MemoryIndexEntry` 的形状会被序列化进
 * `memory/selected` 事件与各界面的契约里，加字段要牵动一圈；② 生成它的只有 {@link episodeEntries}，
 * 而它只生成这个形状；③ 两处（生成与识别）依赖的是**同一个目录约定**
 * （`episodes/` 下只放 `YYYY-MM-DD.md`，判据由 {@link EPISODE_FILE_RE} 管着）⇒ 不会漂。
 */
function isEpisodeEntry(entry: MemoryIndexEntry): boolean {
  return entry.path.startsWith(`${MEMORY_DIR_NAME}/${EPISODE_DIR_NAME}/`);
}

/**
 * 扫盘收集条目（**唯一的收集实现**）：默认档（带预算）与 `full: true`（不带预算）都走它，
 * 所以两处的"什么算一条、顺序如何"永远同一份判据。
 *
 * **顺序 = 索引的顺序 = 编号的来源**，两段：
 *   ① {@link INDEX_FILES} 那 4 份（facts → jargon → style-notes → aliases，理由见那个常量）；
 *   ② **`episodes/` 那一段**（`{@link episodeEntries}`）——**接在最后、日期倒序**（新的在前）。
 *   ⚠ ② 是**追加**在①之后：现有 178 条的编号**一个都不变**（append-only）。若把它插在中间，
 *   她按编号取到的就会是另一条记忆——而"编号错位"是静默的。
 */
function collectIndexEntries(dataDir: string): MemoryIndexEntry[] {
  const memDir = join(dataDir, 'workspace', MEMORY_DIR_NAME);
  const entries: MemoryIndexEntry[] = [];
  for (const name of INDEX_FILES) {
    const text = readTextIfPresent(join(memDir, name));
    if (text === null) continue;
    const path = `${MEMORY_DIR_NAME}/${name}`;
    if (name === 'facts.md') entries.push(...factsEntries(text, path));
    else entries.push(...looseEntries(text, path));
  }
  entries.push(...episodeEntries(memDir));
  return entries;
}

/**
 * **`episodes/**` 进索引**（2026-10-15 用户裁决：「**assets.md 不进，episodes/** 应当进**」）。
 *
 * 粒度 = **一份 episode 一条**（file-level），不是"一条 bullet 一条"。判据是**实测**：
 *   · 一条 bullet 一条 ⇒ 8 份 live episode 共 **302** 条 ⇒ 每条约 17 token ⇒ **+约 5134 token**，
 *     而索引总预算只有 {@link INDEX_TOKEN_BUDGET}（900）⇒ 302 条**几乎全部落进"折叠"**，
 *     盘上 `INDEX.md` 涨到 30 KB 量级，而**注入那一层一个字都不会变多**（固定块只印 top-6）⇒ **纯亏**；
 *   · 一份一条 ⇒ **+8 条 / +约 136 token**，盘上只多 8 行。
 *   （"候选池变大 ≠ 每轮变贵"：注入层印的是 top-6 + pinned，与条目总数无关。）
 *
 * **摘要 = 该份的第一条 `- ` 条目**（经现成的 {@link summaryOf} 截到 40 字）：episode 的第 1 行是
 * `# 2026-10-14` 标题、第 2 行常是说明性的 `>` 引用，真正的"那天发生了什么"从第一条 bullet 开始。
 * 指针 = **第 1 行**（文件头）——那正是"这一天"的坐标，读下去就是那一整天。
 *
 * **三条边界**（每条都有它的理由）：
 *   · **`archive/` 不进**：与 facts.md 的归档区**同一条判据**（"已失效/已过期"不注入——
 *     指针指向一条作废的东西比不指更糟）。所以只数 `episodes/` **本级**的 `YYYY-MM-DD.md`，
 *     不递归进子目录（那里面是归档）。
 *   · **只认 `YYYY-MM-DD.md`**（与整理任务 `listDueEpisodes` 的判据同源）：别的名字（她自己起的
 *     笔记、临时文件）不进来——索引的候选集要可解释。
 *   · **日期倒序**（新的在前）：与 `INDEX_FILES` 那段的"优先级即顺序"同一个理——万一以后超预算
 *     要从尾部丢，丢的是**更旧**的那一天。
 */
function episodeEntries(memDir: string): MemoryIndexEntry[] {
  const dir = join(memDir, EPISODE_DIR_NAME);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // 她还没写过任何经历：正常状态，不是错误（与 `readTextIfPresent` 同一条口径）
    return [];
  }
  const out: MemoryIndexEntry[] = [];
  for (const name of names) {
    if (!EPISODE_FILE_RE.test(name)) continue;
    const text = readTextIfPresent(join(dir, name));
    if (text === null) continue;
    const lines = text.split(/\r?\n/u);
    // 摘要：**第一条 bullet 行**（`- ` 开头）。
    // ⚠ 不能直接用 `looseEntryAt` 扫：那个判据只跳过 `#` 与括号开头的行，`>` 引用**不算说明行**
    //   ⇒ 它会抓走 episode 开头那句"注：本日…记在 2026-10-13.md 末尾"——实测踩到。
    //   这里的判据要比它**更窄**：只要 bullet（episode 的正文本来就是 bullet 组成的）。
    let summary = '';
    for (const line of lines) {
      if (!/^-\s+/u.test(line)) continue;
      summary = summaryOf(line.replace(/^-\s+/u, ''));
      break;
    }
    if (summary === '') continue; // 一整份没有任何 bullet：不进索引（进去也只是个空钩子）
    out.push({
      path: `${MEMORY_DIR_NAME}/${EPISODE_DIR_NAME}/${name}`,
      // 指针指向**文件第 1 行**（`# YYYY-MM-DD`）：`entryShapeAt` 对 episode 认这一种形状
      line: 1,
      summary,
      pinned: false, // 经历永不置顶（`!pinned` 是 facts.md 的语义）
    });
  }
  // 日期倒序：文件名就是 `YYYY-MM-DD.md`，字典序 = 日期序（倒过来即"新的在前"）
  return out.sort((a, b) => (a.path < b.path ? 1 : a.path > b.path ? -1 : 0));
}

/**
 * 一份**空索引**（v32）：`persona.memoryEnabled = false` 时 real-loop 用它替掉"建/读一次"。
 *
 * 为什么要有这么一个显式的东西，而不是让调用方传 `''` 或者自己拼个对象：
 *   • `buildMemoryIndex` 是**读盘**的（它要扫 facts.md / episodes/ …）——关掉框架代管记忆之后，
 *     连"扫一眼"都不该发生：那既是多余的路由，也让"关掉"这件事没法从代码上读出来；
 *   • 注入与账目（`memory/selected` 的指纹与条数）必须以**同一份索引**为准。给一份空索引，
 *     两处自然都是空的（账上如实写"0 条、空指纹"），不需要在两侧各加一个 if——那样才有
 *     "账上说注入了、请求里却没有"的空间（docs/memory-injection.md §4 那条纪律）。
 *
 * 它不碰盘、也不缓存任何东西：每次调用给一份新的空索引。
 */
export function emptyMemoryIndex(): MemoryIndex {
  return { entries: [], dropped: 0 };
}

/**
 * 一行 → 它"算不算索引条目、摘要是什么"。**建索引与核对指针共用的唯一判据**。
 *
 * 为什么要抽出来：`memory_read` 拿到的是一条**可能已经漂了的指针**，它必须回答
 * "这一行现在还是一条条目吗"。若那边自己再写一遍"正则以 `- ` 开头 / 跳过标题"，
 * 两处判据迟早会漂——而漂的方向恰好是最坏的那个：**建索引时算条目、核对时不算**，
 * 于是每一条都报"指针漂了"。所以判据只有这一份，两侧都走它。
 *
 * @param pathOrName 相对工作根的 posix 路径或文件名**都可以**（`MEMORIES/facts.md` 与
 *   `facts.md` 同判）——调用方手里常常只有文件名（`readMemoryEntry` 就是这种情况）
 */
export function entryShapeAt(pathOrName: string, line: string): MemoryEntryShape | null {
  const name = pathOrName.replace(/\\/gu, '/').split('/').pop() ?? '';
  if (name === 'facts.md') return factsEntryAt(line);
  // episode：**文件头那一行**（`# YYYY-MM-DD`）就是一个条目（2026-10-15 起 episodes 进索引，
  // 指针指的就是那一行，见 `episodeEntries`）。判据挂在**文件名**上而不是靠"内容长得像"：
  // 别的文件里也可能有 `# 标题`，而只有 episode 把"文件头"当作那一天的坐标。
  if (EPISODE_FILE_RE.test(name)) return episodeEntryAt(line, name);
  return looseEntryAt(line);
}

/**
 * episode 的一行：**只有文件头那一行**算条目（`# 2026-10-14`，且日期要与文件名对上）。
 *
 * 为什么要求"与文件名对上"：`episodes/2026-10-14.md` 的第 1 行若被改成 `# 2026-10-13`（复制粘贴
 * 那种手滑），指针仍然指在第 1 行、内容却已经不是那一天了——那正是 `memory_read` 要拦的"漂了"。
 * 要求对上之后，它会如实报"指针漂了"，而不是把别的内容当结果给出去。
 */
function episodeEntryAt(line: string, fileName: string): MemoryEntryShape | null {
  const date = fileName.replace(/\.md$/u, '');
  return line.trim() === `# ${date}` ? { summary: date, pinned: false } : null;
}

/** facts.md 的一行：只在"`- ` 开头 + 摘得出正文"时算条目（与文档里的条目格式一致） */
function factsEntryAt(line: string): MemoryEntryShape | null {
  if (!/^-\s+/u.test(line)) return null;
  const entry = parseEntryLine(line);
  const summary = summaryOf(entry.body);
  if (summary === '') return null;
  return { summary, pinned: entry.pinned };
}

/** 自由格式记忆文件（jargon / style-notes / aliases）的一行：非空、非标题、非说明行 */
function looseEntryAt(line: string): MemoryEntryShape | null {
  const raw = line.trim();
  if (raw === '' || raw.startsWith('#') || raw.startsWith('（') || raw.startsWith('(')) return null;
  const body = raw.replace(/^[-*]\s+/u, '');
  const summary = summaryOf(body);
  if (summary === '') return null;
  return { summary, pinned: false };
}

/**
 * facts.md 的条目：跳过归档区，按分区优先级 + 行号升序。
 *
 * 行号是**原文件的行号**（`safe_read` 回显的就是它）：分区标题、空行、说明行都计数，
 * 所以指针指过去读到的就是那一条，不会差一行。
 */
function factsEntries(text: string, path: string): MemoryIndexEntry[] {
  const lines = text.split(/\r?\n/u);
  const out: MemoryIndexEntry[] = [];
  let sectionIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const title = FACTS_SECTION_TITLES.findIndex((t) => line.trim() === t);
    if (title !== -1) { sectionIndex = title; continue; }
    // 走到归档区（或任何别的 `##` 区）就停止收集：它后面的一切都不进索引
    if (/^##\s/u.test(line)) { sectionIndex = -1; continue; }
    if (sectionIndex === -1) continue;
    const shape = factsEntryAt(line);
    if (shape === null) continue;
    out.push({ path, line: i + 1, summary: shape.summary, pinned: shape.pinned });
  }
  return out;
}

/**
 * 其余记忆文件（jargon / style-notes / aliases）的条目：**自由格式**，一行一条。
 *
 * 它们由她自己维护，没有 facts.md 那套行内标签——所以判据只有"非空、不是标题、不是说明行"。
 * 标题与括号开头的行是给人看的说明（种子模板里那些），当条目列出只会是噪音。
 *
 * 注意**没有分区过滤**：这些文件里没有归档区，所以任意一行都可能是条目——
 * `entryShapeAt` 的核对逻辑必须与这里一致，否则"指针还成立"会被误判成"漂了"。
 */
function looseEntries(text: string, path: string): MemoryIndexEntry[] {
  const out: MemoryIndexEntry[] = [];
  const lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const shape = looseEntryAt(lines[i] ?? '');
    if (shape === null) continue;
    out.push({ path, line: i + 1, summary: shape.summary, pinned: shape.pinned });
  }
  return out;
}

/**
 * 一行摘要：取正文第一行、剥掉 `(source: …)` 归属前缀、截断到字符上限。
 *
 * 为什么剥 source：那一行里 `(source: turn 123)` 占掉一半位置却没有检索价值
 * （索引已经在同一行给了路径与行号，溯源到哪一条是读正文时的事）。
 */
function summaryOf(body: string): string {
  const firstLine = body.split(/\r?\n/u)[0] ?? '';
  const withoutSource = firstLine.replace(/^\(source:[^)]*\)\s*/u, '').trim();
  if (withoutSource === '') return '';
  return withoutSource.length <= ENTRY_SUMMARY_MAX_CHARS
    ? withoutSource
    : `${withoutSource.slice(0, ENTRY_SUMMARY_MAX_CHARS)}…`;
}

/**
 * 索引之外还有什么（阶段一·兜底行升级，2026-10-15 用户裁决②）——**宿主一轮数一次**。
 *
 * 为什么要有它：索引只覆盖 {@link INDEX_FILES} 那 4 份文件（实测 178 条），而她真实读取里
 * **61.8% 落在索引指不到的地方**（`episodes/**` 与 `assets.md` 等，见 `_ops-bm25/REPORT.md` §7）。
 * 兜底行原来只说清了"索引里还剩多少"，对那 61.8% 一个字都没说——这一格就是补那一句。
 *
 * **三条纪律**：
 *   · **只数、不读内容**（`readdirSync`，不 readFile）：它每轮跑一次，读正文纯属浪费；
 *   · **数不到就是 `null`**（目录不在 / 权限）⇒ 文案写"若干"，**绝不编一个数**；
 *   · **它不改变索引**：`episodes/**` 一条都不进 `INDEX_FILES`（那是大改动，用户没有批）。
 *
 * `extras` 只列"索引覆盖不到、但确实存在"的**顶层**名字（如 `assets.md`、`diary`）——
 * 它们是"她可以按路径去问"的清单，不是索引的候选。
 */
export function memoryIndexNeighbors(dataDir: string): {
  episodes: number | null;
  extras: string[];
} {
  const memDir = join(dataDir, 'workspace', MEMORY_DIR_NAME);
  let names: string[];
  try {
    names = readdirSync(memDir);
  } catch {
    // 记忆目录还不在（她还没写过任何记忆）：不是错误，如实给"一个都没数到"
    return { episodes: 0, extras: [] };
  }
  const covered = new Set<string>(INDEX_FILES);
  const extras = names
    .filter((name) => !covered.has(name) && name !== MEMORY_INDEX_FILE && !name.startsWith('.'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    // `episodes` 已经在下面单独数过了，这里不再重复列它（它在兜底行里有自己的说法）
    .filter((name) => name !== EPISODE_DIR_NAME);

  // episodes：只认 `YYYY-MM-DD.md`（与整理任务 `listDueEpisodes` 的判据同源），
  // 子目录（`episodes/archive/`）**不展开**——兜底行说的"按日期"指的就是那些日子文件。
  let episodes: number | null = 0;
  try {
    episodes = readdirSync(join(memDir, EPISODE_DIR_NAME))
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/u.test(name)).length;
  } catch {
    // 目录读不动 ⇒ `null`（文案写"若干"）。**与"0 份"是两件事**，不许混
    episodes = null;
  }
  return { episodes, extras };
}

// ──────────────────────────────── 渲染索引 ────────────────────────────────

/** 索引文件头（**归属声明**：这是机制生成的，不是她写的；也说明怎么用） */
const INDEX_HEADER = `# 记忆索引（机制生成，不是你的笔记）

下面每一条都是**指针**：指向你自己那份记忆里的某一行。正文不在这个文件里、也不在你的上下文里
——要看哪一条就 \`safe_read\` 那条路径，行号是现成的；读回来的内容会留在你这一轮的历史里。
这个文件每次记忆文件变化后由机制重建，**不要手改**（手改会被覆盖）。`;

/** 渲染"- `路径:行号` [!pinned] 摘要"这一种条目行 */
function entryLines(entries: readonly MemoryIndexEntry[]): string[] {
  return entries.map((e) =>
    `- \`${e.path}:${e.line}\`${e.pinned ? ' **!pinned**' : ''} ${e.summary}`);
}

/** 条目 → 文本 + token（预算判定与渲染共用，避免两处口径漂移） */
function renderIndexEntries(entries: readonly MemoryIndexEntry[], dropped: number): { text: string; tokens: number } {
  const body = entryLines(entries).join('\n');
  const tail = dropped > 0 ? `\n（另有 ${dropped} 条未展开：索引超长，按优先级截到这里。）` : '';
  const text = `${INDEX_HEADER}\n\n${body}${tail}`;
  return { text, tokens: estimateTokens(text) };
}

/**
 * 索引 → 可直接注入的文本（含文件头）。`null`/缺省表示**没有索引**，
 * 调用方（real-loop）据此让长期记忆层那一段整体不出现。
 */
export function renderMemoryIndex(index: MemoryIndex): string {
  return renderIndexEntries(index.entries, index.dropped).text;
}

// ──────────────────────────────── 落盘（幂等） ────────────────────────────────

/**
 * 保证 `MEMORIES/INDEX.md` 与记忆文件一致。**幂等**：渲染结果与盘上逐字节相同就不写盘。
 *
 * 为什么幂等是硬要求：索引待在**常驻前缀**里（长期记忆层）。每次启动无条件重写一次，
 * 就等于每次重启把整段前缀打掉一次——而重启本身并不改变任何一条记忆。
 *
 * 返回动作，供启动摘要与测试断言（'created' | 'updated' | 'unchanged'）。
 */
export function ensureMemoryIndex(dataDir: string): 'created' | 'updated' | 'unchanged' {
  const path = memoryIndexPath(dataDir);
  const text = renderMemoryIndex(buildMemoryIndex(dataDir));
  const current = readTextIfPresent(path);
  if (current === text) return 'unchanged';
  mkdirSync(join(dataDir, 'workspace', MEMORY_DIR_NAME), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return current === null ? 'created' : 'updated';
}

/**
 * 只读地读回索引文本（重放与诊断用）：文件不在就返回空串，**绝不创建**。
 *
 * 为什么单独一条：`buildReplayReport` 的前提是"日志已关、只读重建"。
 * 在那里顺手补建索引文件，等于让一次复盘改了盘上的东西——而且会把重建结果污染成
 * "有索引"（当时的请求里可能根本没有它）。
 *
 * **它不是运行期那条路**（2026-10-06 把口径改准）：real-loop 每轮走的是
 * `memoryIndexPlan`（real-loop.ts:1861）+ `ensureMemoryIndexSafely`（:2163）——自己建、
 * 自己渲染，不经过这里。这条只读路的读者只有两个：`replay.ts`（`memoryIndex:` 那两个字段）
 * 与 `web/server.ts` 的 `/api/replay`。
 *
 * 从前这里还有一条会**补建文件**的 `readMemoryIndexText`，它的注释声称"这是运行期那条路
 * （real-loop 每轮走它）"——那句话早就不是事实了，而它全仓 0 引用，2026-10-06 随审计删掉
 * （docs/repo-cleanliness-audit.md §2.2 A2）。别再按那个说法加回来一条"运行期读文本"的路。
 */
export function readMemoryIndexTextReadOnly(dataDir: string): string {
  return readTextIfPresent(memoryIndexPath(dataDir)) ?? '';
}

// ──────────────────────────────── 小工具 ────────────────────────────────

/** 读文本；不存在 / 读不到 → null（记忆文件缺失是正常状态，不是错误） */
function readTextIfPresent(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
