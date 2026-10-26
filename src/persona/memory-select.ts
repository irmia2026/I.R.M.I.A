/**
 * Irmia Agent — **框架推荐哪几条记忆**（阶段一，2026-10-15）
 *
 * 用户的原话（逐字，唯一判据）：
 * > 「这样，**BM25 挑选应取用户的最近 5 次输入聚合，然后用 BM25 挑出 top-6**，同时**告知：
 * > 这些是与当前话题可能相关的记忆**。**由框架自动推荐**。」
 *
 * ⇒ 三件事各有落点，别混：
 *   ① **查询** = 用户（用户）最近 5 次输入的**聚合**（按时间拼接）——{@link buildMemoryQuery}；
 *   ② **挑选** = BM25 在**全量索引**上取 **top-6**——{@link selectMemoryRecommendation}；
 *   ③ **告知** = 固定块里那一段的标题行逐字说明"这是推荐、不一定都对"——{@link renderMemoryRecommendation}。
 *
 * ──────────────────────────── 为什么要有这一层（与旧口径的差别） ────────────────────────────
 *
 * 旧口径（2026-10-04 用户定的「只看索引，如果需要，heavy 自己去读」）注入的是
 * **整张节流过的指针表**：实测 **29 条 / 890 token**，顺序固定、**与话题无关**——
 * 那 890 token 是每轮都要付的固定支出，而它指到的 4 份文件只占她真实读取的 38.2%
 * （`_ops-bm25\REPORT.md` §7：474 次 `MEMORIES/*` 成功读取里 293 次落在索引指不到的地方）。
 *
 * 新口径**只换注入那一段的挑法**，不换"正文不进上下文"这条底线：
 *   · 注入的是 **top-6 指针**（+ pinned 必留）≈ 200 token 量级，而不是 890；
 *   · 挑的依据是**当前话题**（最近 5 次输入），而不是"索引里的固定顺序"；
 *   · **153→368 token 那一档的实测出处**：同召回下更省（报告 §3 的 `pinned+BM25 实际 token` 行）。
 *
 * ⚠ **诚实记档（报告 §3 的结论不能被这一层绕过）**：同 890 token 下，BM25 的 entry 召回
 * **低于**现状那 29 条固定指针（16.8% vs 23.3%）。所以这一版的正当理由是**省 token + 与话题相关**，
 * **不是"召回更高"**。真正吃住召回的是报告 §7 那条结构事实（61.8% 的真值在索引之外），
 * 本模块只把**能挑的那 178 条**挑好，不去伪造"我覆盖了 episodes"。
 *
 * ──────────────────────────── 三条硬约束（都有正反用例） ────────────────────────────
 *
 *   1. **pinned 必留**：带 `!pinned` 的条目**永远进这 6 条**，不许被排序挤掉
 *      （用户原话那一版里的口径；报告 §4 第 2 条也给了实测：K≤5 时 pinned 的价值最大）。
 *   2. **确定性**：同查询 + 同索引 ⇒ 同 6 条、同顺序（同分按 `路径:行号` 兜底，见 `bm25.ts`）。
 *   3. **如实**：候选为空（她还没写过记忆）时**不编**——推荐段整段不出现（{@link renderMemoryRecommendation}
 *      返回空串），而不是印一个空标题。
 *
 * 它**不读盘**：条目由调用方递进来（`fullMemoryIndex(dataDir)`，一轮读一次），
 * 与渲染层"不读文件系统"同一条纪律（缓存铁律 1）。
 */

import { buildBm25Corpus, rankScored, scoreBm25 } from './bm25.ts';
import type { MemoryIndexEntry } from './memory-injection.ts';
import type { RecallTrace } from './recall.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 推荐几条（用户原话：top-6） */
export const MEMORY_RECOMMEND_TOP_N = 6;

/** 查询用**最近几次**用户输入（用户原话：最近 5 次） */
export const MEMORY_QUERY_INPUT_COUNT = 5;

/**
 * 单条输入进查询时的字符上限。
 *
 * 为什么要有它：粘贴进来的一整篇文档会让查询被那一段彻底主导——BM25 的查询侧是词集，
 * 长文本进来就是"谁的词多谁说了算"。200 字覆盖了"一句话问到点子上"的绝大多数情形，
 * 而超出的部分对"挑 6 条指针"这件事几乎没有增量信息。
 */
export const MEMORY_QUERY_INPUT_MAX_CHARS = 200;

/**
 * 查询整体的字符上限（聚合之后）。
 *
 * 与上一条的分工：那是"单条别太长"，这是"5 条加起来别太长"——最近 5 次都是长消息时，
 * 拼接结果会到 1000 字量级，词集里噪音词（"这个""帮我看看"）会稀释真正的关键词。
 * 1000 字 ≈ 5×200，正好是"每条都吃满"的上界，所以正常情况下它不截断任何东西。
 */
export const MEMORY_QUERY_MAX_CHARS = 1000;

// ──────────────────────────────── 查询聚合 ────────────────────────────────

/** 一次用户输入的原文（调用方从事件里抽好；只留这两样，本模块不认识事件形状） */
export interface MemoryQueryInput {
  /** 事件 seq（时间序即 seq 序；也是"哪几条进了查询"的凭据） */
  seq: number;
  /** 用户发来的文本（原样；截断在本模块里做） */
  text: string;
}

/**
 * 聚合结果的**指纹**（进 `memory/selected.query`，见 `log/types.ts`）。
 *
 * `text` 留在这里是给调用方算哈希与看用例的（**不进事件**：查询原文就是日志里那几条输入本身，
 * 再存一份是重复存储）。
 */
export interface MemoryQueryFingerprint {
  text: string;
  /** 聚合文本的 sha256（空查询 = 空串；算它的人是调用方——本模块不引 crypto） */
  hash: string;
  /** 参与聚合的输入事件 seq（时间序） */
  seqs: number[];
  /** 参与聚合的条数 */
  texts: number;
  /** 有没有因为字符上限被截断 */
  truncated: boolean;
}

/**
 * 最近 N 次用户输入 → 一句话查询（**按时间拼接**）。
 *
 * 两条纪律：
 *   • **按时间**（seq 升序）拼接，不按相关度、不重排——查询是"最近说过什么"的忠实聚合，
 *     排序的职责在 BM25 那一侧；
 *   • 少于是多少条就多少条（第一条消息那一轮只有 1 条），**不补空、不重复**。
 *
 * 返回的 `seqs` 与 `texts` 是给事件账用的（"这一轮是按哪几条挑的"要能对账），
 * `truncated` 如实说有没有因为字符上限截断过。
 */
export function buildMemoryQuery(
  inputs: readonly MemoryQueryInput[],
): { text: string; seqs: number[]; texts: number; truncated: boolean } {
  const recent = [...inputs]
    .sort((a, b) => a.seq - b.seq)
    .slice(-MEMORY_QUERY_INPUT_COUNT);
  let truncated = false;
  const parts: string[] = [];
  for (const input of recent) {
    const raw = input.text.trim();
    if (raw === '') continue;
    if (raw.length > MEMORY_QUERY_INPUT_MAX_CHARS) {
      truncated = true;
      parts.push(raw.slice(0, MEMORY_QUERY_INPUT_MAX_CHARS));
    } else {
      parts.push(raw);
    }
  }
  let text = parts.join('\n');
  if (text.length > MEMORY_QUERY_MAX_CHARS) {
    truncated = true;
    text = text.slice(0, MEMORY_QUERY_MAX_CHARS);
  }
  return { text, seqs: recent.map((input) => input.seq), texts: recent.length, truncated };
}

// ──────────────────────────────── 挑选 ────────────────────────────────

/** 挑出来的那一条（带**当次索引里的编号**与分数：两者都要进回执与事件账） */
export interface MemoryRecommendationItem {
  /** **当次索引里的 1-based 编号**（= 全量索引数组下标 +1，见 `memory-injection.ts` 的 `fullMemoryIndex`） */
  index: number;
  /** 指针（`MEMORIES/facts.md:9`） */
  ref: string;
  path: string;
  line: number;
  summary: string;
  pinned: boolean;
  /** BM25 分数（pinned 若不在 top-N 里而被保底收进来，这里是 0） */
  score: number;
  /** 为什么进来：'pinned'（保底）还是 'bm25'（按分） */
  via: 'pinned' | 'bm25';
  /** 命中的查询词（回执里的凭据；pinned 保底进来的可能为空） */
  matched: string[];
}

/**
 * **索引之外**还有什么（给兜底行用的目录级事实，2026-10-15 用户裁决②）。
 *
 * 为什么需要它：索引只覆盖 `INDEX_FILES` 那 4 份文件（实测 178 条），而她真实读取里有
 * **61.8% 落在索引指不到的地方**（`episodes/**` 与 `assets.md` 等，见报告 §7）。
 * 兜底行原来只写"另有 N 条"——那只说清了**索引里**还剩多少，对那 61.8% 一个字都没说。
 *
 * ⚠ **数量由宿主数好递进来**（`real-loop` 那一轮一次的素材），**渲染层绝不读盘**（缓存铁律 1）。
 * 读不到就传 `null` ⇒ 文案写"若干"——**不许编一个数**。
 */
export interface MemoryIndexNeighbors {
  /** `MEMORIES/episodes/` 下有几份（按日期的经历文件）；`null` = 没数到（文案写"若干"） */
  episodes: number | null;
  /**
   * 索引覆盖不到、但确实存在的**其它**文件名（如 `assets.md` / `diary/**`）。
   * 空数组 = 没有别的；由宿主按目录现读，**不许在这里拼路径**。
   */
  extras: readonly string[];
}

export interface MemoryRecommendation {
  /** 展示顺序：pinned 保底的在前（编号升序），其余按（分数降序, `路径:行号` 升序） */
  items: MemoryRecommendationItem[];
  /**
   * **保底**（pinned）几条 · **相关**（BM25）几条。
   *
   * 两个数是分开的，因为它们是**两件事的额度**（2026-10-15 用户裁决）：
   *   保底 = "置顶的永远在场"；相关 = "按最近话题挑 6 条"。**两者不许互相挤**——
   *   pinned 多了不该让"相关的"变少，相关的多了也不该把置顶挤掉。
   *   ⚠ 这个数**不写进那一段文本**（她要的是行本身，不是账目）——事件账里数 `selected` 即可。
   */
  counts: { pinned: number; bm25: number };
  /** 全量索引条数（"另有 N 条"那个 N 的基数） */
  total: number;
  /** 这一轮实际用的查询（回执不印它，但事件账与用例要看） */
  query: { text: string; seqs: number[]; texts: number; truncated: boolean };
  /** 索引之外还有什么（兜底行用；缺省 = 没接线 ⇒ 那一行退回旧文案） */
  neighbors?: MemoryIndexNeighbors;
  /**
   * **这一段的正文**（可选，阶段二 2026-10-19）。
   *
   * 缺省 ⇒ 由 {@link renderMemoryRecommendation} 按推荐段的模板渲染（今天的行为）。
   * 给出来 ⇒ 用它当注入的那段文本（召回段是**另一套措辞**：推荐段说的是"按最近话题挑的"，
   * 召回段说的是"你提起了这几个词"——两件事写成一句话会让她误判）。
   */
  segment?: string;
  /**
   * **召回账**（可选；四态 + 命中词 + 候选数 + token）。缺省 = 这一轮没走召回那条路
   * （开关关着，或老调用点）。它进 `memory/selected.recall`（internal，不进请求体）。
   */
  recall?: RecallTrace;
}

/**
 * 挑出推荐的那几条。
 *
 * 算法（顺序即优先级；**两个额度互不侵占**——2026-10-15 用户裁决"pinned 不占那 6 个名额"）：
 *   ① **pinned 全部保底进**（`via: 'pinned'`）——它们永远在，且**不占**相关那 6 个位置；
 *   ② 相关那 {@link MEMORY_RECOMMEND_TOP_N} 个位置由 BM25 的 top 填（`via: 'bm25'`），
 *      **已经在①里的不重复**（她已经在上面看到那一条了，再印一遍是浪费一行）。
 *
 * ⇒ **pinned 多于 6 条时照实全给**（不砍置顶），**相关的仍是 6 条**——两边不互相挤。
 * 判据：pinned 是"保底"、相关是"推荐"，两件事不该抢同一个额度。
 *
 * 展示顺序：pinned 段（按编号升序，稳定）→ 其余按（分数降序, `路径:行号` 升序）。
 * 为什么 pinned 不按分数排：它们的入选与分数无关，混排会让"为什么它在第 1 条"变得不可解释；
 * 而"保底的都在前面"本身就是**给她看的可读信号**（再加 `!pinned` 标记，她能一眼分辨）。
 */
export function selectMemoryRecommendation(
  entries: readonly MemoryIndexEntry[],
  inputs: readonly MemoryQueryInput[],
  topN: number = MEMORY_RECOMMEND_TOP_N,
): MemoryRecommendation {
  const query = buildMemoryQuery(inputs);
  const refOf = (entry: MemoryIndexEntry): string => `${entry.path}:${entry.line}`;
  const found = new Map<number, MemoryRecommendationItem>();

  // ① pinned 保底（编号升序 = 索引顺序，稳定且可复现）——**额度另算，不占下面的 topN**
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined || entry.pinned !== true) continue;
    found.set(i, {
      index: i + 1,
      ref: refOf(entry),
      path: entry.path,
      line: entry.line,
      summary: entry.summary,
      pinned: true,
      score: 0,
      via: 'pinned',
      matched: [],
    });
  }
  const pinnedItems = [...found.values()].sort((a, b) => a.index - b.index);

  // ② 相关那 topN 个位置（而不是 topN − pinned 个）：语料 = `路径 + 摘要`，口径见 `bm25.ts` 文件头
  const rest: MemoryRecommendationItem[] = [];
  if (query.text !== '') {
    const corpus = buildBm25Corpus(entries.map((entry) => `${entry.path} ${entry.summary}`));
    const ranked = rankScored(scoreBm25(corpus, query.text), (i) => refOf(entries[i] as MemoryIndexEntry));
    for (const hit of ranked) {
      if (rest.length >= topN) break;
      if (found.has(hit.index)) continue; // 已在保底段里（或已在下面收进来），不重复占位
      const entry = entries[hit.index];
      if (entry === undefined) continue;
      const item: MemoryRecommendationItem = {
        index: hit.index + 1,
        ref: refOf(entry),
        path: entry.path,
        line: entry.line,
        summary: entry.summary,
        pinned: entry.pinned,
        score: hit.score,
        via: 'bm25',
        matched: hit.matched,
      };
      rest.push(item);
      found.set(hit.index, item);
    }
  }

  const items = [...pinnedItems, ...rest];
  return {
    items,
    counts: { pinned: pinnedItems.length, bm25: rest.length },
    total: entries.length,
    query,
  };
}

// ──────────────────────────────── 渲染 ────────────────────────────────

/**
 * 标题行的**措辞模板**（用户原话里给的那一句，逐字）——`%N%` 是实际条数。
 *
 * 为什么逐字、为什么只有一个 `%N%` 是可替换的：
 *   · 逐字的是**告知那一半**——她必须一眼看出"这是框架按话题挑的推荐、不一定都对"，
 *     而不是"框架认定的相关记忆"。改这句话就等于改口径，要用户点头
 *     （与 self-brief 那些逐字文案同一条纪律）。
 *   · 只有**条数**跟着实际走：`%N%` 下面填的是 `items.length`，不是常量 6。
 *     实测依据：一句"今天想喝点茶"在真索引上只有 4 条有词重叠（其余是 0 分）——
 *     那时印"挑了 6 条"而只给 4 行，她会把"少的那 2 条"当成没显示出来的东西去找。
 *     **宁少不凑**：凑到 6 条就要把 0 分的无关记忆推到她眼前，那正好抵消"与话题相关"。
 */
export const MEMORY_RECOMMEND_BANNER_TEMPLATE =
  '【可能相关的记忆】以下是框架按最近话题挑的 %N% 条，不一定都对；要哪条用 memory 工具取';

/** 标题行的兜底形态（条数未知时用；`renderMemoryRecommendation` 一律用带真实条数的那一份） */
export const MEMORY_RECOMMEND_BANNER =
  MEMORY_RECOMMEND_BANNER_TEMPLATE.replace('%N%', String(MEMORY_RECOMMEND_TOP_N));
export function recommendBannerFor(count: number): string {
  return MEMORY_RECOMMEND_BANNER_TEMPLATE.replace('%N%', String(count));
}

/**
 * 标题行的**固定前缀**（不含条数）：`【可能相关的记忆】以下是框架按最近话题挑的`。
 *
 * 为什么要给一个前缀出口：条数是变量（见上一条），而"这一段在不在"是判据——
 * 测试与界面预览要按它认这一段的身份，不能按一个会变的整串去 `includes`
 * （那样"条数从 6 变成 4"会让判据一起变红，而它红得没有意义）。
 */
export const MEMORY_RECOMMEND_PREFIX = MEMORY_RECOMMEND_BANNER_TEMPLATE.slice(
  0,
  MEMORY_RECOMMEND_BANNER_TEMPLATE.indexOf('%N%'),
);

/** 一条推荐行：`1. `MEMORIES/facts.md:9` [!pinned] 摘要`（与索引里的行形态同构，便于对照） */
function recommendationLine(item: MemoryRecommendationItem): string {
  const pinned = item.pinned ? ' **!pinned**' : '';
  return `${item.index}. \`${item.ref}\`${pinned} ${item.summary}`;
}

/**
 * 兜底行（**一行**，2026-10-15 用户裁决②：升级成"目录级"）。
 *
 * 三件事按"她能不能据此去取"的顺序排：
 *   ① **索引里还剩多少**（"另有 N 条"）——原来的那一半，一个字没删；
 *   ② **索引之外还有什么**（`episodes/**` N 份 + 其它文件名）——治那 61.8% 的**结构性盲区里最便宜的一半**：
 *      不把 `episodes/**` 塞进索引（那是大改动），只**告诉她那些东西在、并且怎么取**；
 *   ③ **怎么取**（`path`+`line` 入口 / 按路径问她）。
 *
 * ⚠ 三条纪律：
 *   · **数量不许编**：`neighbors` 没接线（缺省）或数不到（`episodes: null`）时写"若干"，
 *     绝不写一个看起来像真数的数字（她按那个数去找会扑空）。
 *   · **它仍是一行**：新增的东西全塞进同一对括号里，不另起一行、不另起一段。
 *   · **别的文件名只列前几个**（{@link MAX_TAIL_EXTRAS}）：真目录里它们可以有七八个，
 *     全列出来这一行就比 6 条推荐还长——而这一行的用途是"让她知道还有、并且会问"，
 *     不是给她一份完整清单（要完整清单她 `safe_read` 那个目录就行，索引头里也写着）。
 */
function recommendationTail(recommendation: MemoryRecommendation): string {
  const { items, total, neighbors } = recommendation;
  const rest = Math.max(0, total - items.length);
  const inIndex = items.length === total
    ? '索引里的条目已全部在此'
    : `另有 ${rest} 条在索引里`;
  // 没接线 ⇒ 退回旧文案（老调用点、子代理、诊断：它们的请求字节因此与接线之前逐字相同）
  if (neighbors === undefined) {
    return items.length === total
      ? `（${inIndex}）`
      : `（${inIndex}，可用 memory 工具按路径或自然语言查）`;
  }
  const outside: string[] = [];
  if (neighbors.episodes !== null && neighbors.episodes > 0) {
    outside.push(`\`episodes/**\`（${neighbors.episodes} 份，按日期）`);
  } else if (neighbors.episodes === null) {
    // 数不到：如实写"若干"，**编一个数比不写更坏**
    outside.push('`episodes/**`（若干份，按日期）');
  }
  for (const name of neighbors.extras.slice(0, MAX_TAIL_EXTRAS)) outside.push(`\`${name}\``);
  // `extras` 比上限多 ⇒ 用一个数交代剩下的（**不删信息，只是不把清单倒出来**）。
  // ⚠ 这一截**不并进 `outside`**：`outside` 是按" 与 "连的名字清单，
  //   把"等 1 项"当第四项会读成 `…与 等 1 项`（多了个空格、也不像话）。它紧跟在清单后面。
  const hidden = neighbors.extras.length - MAX_TAIL_EXTRAS;
  const more = hidden > 0 ? `等 ${hidden} 项` : '';
  const outsideText = outside.length === 0
    ? ''
    : `；索引之外的还有 ${outside.join(' 与 ')}${more}`;
  return `（${inIndex}${outsideText}，可直接用 memory_read 的 \`path\`+\`line\` 入口读，或按路径问我）`;
}

/**
 * 推荐段 → 可直接注入固定块的文本。**候选为空时返回空串**（整段不出现，不印空标题）。
 *
 * 三行结构（用户原话要求的"告知 + 6 条 + 兜底"）：
 *   ① 标题行（{@link MEMORY_RECOMMEND_BANNER_TEMPLATE}，只有条数是变量）；
 *   ② 每条一行：**稳定编号** + 指针 + `!pinned` + 摘要（**保底的在前**，她自己能一眼分辨）；
 *   ③ 兜底行：见 {@link recommendationTail}（**仍是一行**）。
 *
 * ⚠ **一行总述就够，别把标题搞成两段**（2026-10-15 用户裁决那一条）：pinned 与相关
 * 是**两个额度**，但**在这段文本里不记账**——`!pinned` 标记已经让她分得出哪几条是保底的，
 * 再写一行"其中 N 条是置顶"只是把同一件事说两遍（每轮都要付那几 token）。
 * 条数那一处填的是**实际行数**（= pinned 条数 + 相关条数），见 `MEMORY_RECOMMEND_BANNER_TEMPLATE`
 * 那段"宁少不凑"。
 */
export function renderMemoryRecommendation(recommendation: MemoryRecommendation): string {
  const { items } = recommendation;
  if (items.length === 0) return '';
  const lines = items.map(recommendationLine);
  return `${recommendBannerFor(items.length)}\n${lines.join('\n')}\n${recommendationTail(recommendation)}`;
}

/** 一次推荐的**相关条数上限**出口（用例按它断言；真源在常量区） */
export const RECOMMEND_MAX_ITEMS = MEMORY_RECOMMEND_TOP_N;

/**
 * 兜底行里"别的文件名"最多列几个（超出的并成 `等 N 项`）。
 *
 * 取 3 的依据：真目录实测有 **5 个**索引之外的顶层项（`assets.md` / `diary` /
 * `notes-selfie-scenes.md` / `skills` / `episodes`），全列出来那一行会比 6 条推荐还长
 * （实测 +38 token/轮）。3 个够她看出"那边还有东西、而且是有名字的东西"，
 * 剩下的用"等 N 项"如实交代个数——**不删信息，只是不把清单倒出来**。
 */
export const MAX_TAIL_EXTRAS = 3;
