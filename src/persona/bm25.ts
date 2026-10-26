/**
 * Irmia Agent — 检索打分（BM25，**零依赖**）
 *
 * 这一个模块只回答一件事：**给一句话，从一堆记忆条目里挑出最相关的几条**。
 * 它被两处用（同一份实现，不各写一遍）：
 *   · 阶段一：固定的推荐段——查询是「用户最近 5 次输入的聚合」，条数固定 6 条（`memory-select.ts`）；
 *   · 阶段二：`memory_read` 的 `query` 参数——查询是她给的那一句话，条数由 `n` 定（默认 5）。
 *
 * ──────────────────────────── 口径与出处（**别改**，改了要与下面这份报告对账） ────────────────────────────
 *
 * 分词与打分口径**逐字照搬**那份只读测量报告 `_ops-bm25\REPORT.md` 的"口径 A"，
 * 它的实现是仓库外的 `_ops-bm25\bm25-eval3.mjs`（`tokenizeA` / `buildIndex` / `score`）：
 *
 *   · **口径 A（免依赖）**：中文按**字符二元组（bigram）**；英文 / 数字 / 路径按**词**，
 *     路径再按 `/\ . _ -` 切一刀（`MEMORIES/facts.md` → `memories`、`facts`、`md`）。
 *   · **不引 jieba**：报告 §4 实测本机没有 jieba，且它的优势不稳健 ⇒ **不为此加任何依赖**。
 *     这份实现全是 `Map` 与正则，运行期零依赖、零 IO（不读盘：文档由调用方递进来）。
 *   · BM25 参数 `k1 = 1.2`、`b = 0.75`，idf = `log(1 + (N - df + 0.5) / (df + 0.5))`（与报告同式）。
 *
 * **与报告的一处有意的差异（写清，别当成抄漏）**：报告把每条文档拼成
 * `路径 + 摘要 + 那一行的原始正文`（`bm25-eval3.mjs:66` 的 `DOCS`）。本实现**只吃
 * `路径 + 摘要`**（`MemoryIndexEntry.path` / `.summary`）：
 *   ① 索引条目本身就只带这两样——`buildMemoryIndex` 不保留正文行，要为检索再读一遍
 *      `facts.md` 就等于把"索引已经读过的盘"再读一遍；
 *   ② 摘要是 40 字上限的钩子，正文那一行的边际信息很小，而"检索语料 = 索引里可见的那些字"
 *      这条口径更好解释（她看到什么，框架就是按什么挑的）。
 *   报告 §3 那个"BM25 没打赢现状"的结论不受影响：那是 **token 效率**的结论，不是分词口径的结论。
 *
 * ──────────────────────────── 确定性（缓存铁律的同族要求） ────────────────────────────
 *
 * 同一个查询 + 同一份条目 ⇒ **同一份排序**。两层保证：
 *   ① 打分是纯函数（没有时钟、没有随机、没有 Map 迭代序参与排序）；
 *   ② 排序的同分兜底是 `路径:行号`（{@link rankEntries} 里那一步显式比较）——
 *      分数相等时**不靠输入顺序**，而是按一个稳定、可复现的键排。
 * 这一条是被测过的（`test/memory-select.test.ts` 的"同分确定性"）。
 */

/** BM25 的 `k1`（词频饱和）：照报告口径，别按感觉调 */
const BM25_K1 = 1.2;
/** BM25 的 `b`（长度归一）：照报告口径 */
const BM25_B = 0.75;

/**
 * 切词用的"游程"正则，逐字照搬报告的 `tokenizeA`。
 *
 * 两个分支各有用途：ASCII 段（含 `.` `-` `_` `/` `\`）是一个游程，中文（含全角标点）是另一个。
 * 顺序要紧：把 `-` 收进 ASCII 段里，`date-modified` 才会先整段成一个词、再被切出 `date`/`modified`。
 */
const TOKEN_RUN_RE = /[A-Za-z0-9_.\-\/\\]+|[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]+/gu;

/** CJK 字符判据（与 `tools/registry.ts` 的 token 估算同一段码位；这里只用于切 bigram） */
const CJK_RE = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/;

/**
 * 一段文本 → 词元数组（口径 A）。
 *
 * 中文：每个字本身是一个词元，相邻两字再合成一个 bigram（"喝茶"→ `喝`、`茶`、`喝茶`）。
 * 单字也留（一个字的消息、或末尾那个落单的字）——只留 bigram 会让"茶"这种查询一个词都对不上。
 * 英文/路径：整段小写算一个词元，再按 `/ \ . _ -` 切开各算一个（切出来的空串丢掉）。
 */
export function tokenizeBm25(text: string): string[] {
  const out: string[] = [];
  const input = String(text ?? '');
  TOKEN_RUN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RUN_RE.exec(input)) !== null) {
    const run = match[0];
    if (run === '') continue;
    if (CJK_RE.test(run[0] as string)) {
      const chars = [...run].filter((ch) => CJK_RE.test(ch));
      for (let i = 0; i < chars.length; i += 1) {
        out.push(chars[i] as string);
        if (i + 1 < chars.length) out.push(`${chars[i]}${chars[i + 1]}`);
      }
    } else {
      const lower = run.toLowerCase();
      out.push(lower);
      if (/[/\\._-]/u.test(lower)) {
        for (const part of lower.split(/[/\\._-]+/u)) {
          if (part !== '') out.push(part);
        }
      }
    }
  }
  return out;
}

/** 一篇文档：词元 → 词频 */
type TermFreq = Map<string, number>;

/** 一份建好的语料（`docs` 的顺序即**编号顺序**：第 i 篇的编号是 i+1） */
export interface Bm25Corpus {
  /** 文档数 */
  N: number;
  /** 每篇的词频（下标 = 文档下标） */
  tf: TermFreq[];
  /** 文档频率：词元 → 出现在几篇里 */
  df: Map<string, number>;
  /** 每篇长度（词元数） */
  lens: number[];
  /** 平均长度（空语料时为 1，避免除零） */
  avgdl: number;
}

/**
 * **语料词元的文档频率上限**：出现在**超过一半**文档里的词元在**建库时就被丢掉**（2026-10-15 用户裁决）。
 *
 * 判据（按**成因**治，不是按现象治）：这类词元的 idf ≈ 0，它们对"哪一篇更相关"**没有任何区分力**，
 * 却会给**每一篇**都加上一点点分——于是"随机挑出几条低分无关条目"。
 * 实测的成因就是**路径词元**：文档文本是 `路径 + 摘要`（见文件头），所以 `memories` / `facts` / `md`
 * 出现在**每一篇**里（`df ≈ N` ⇒ `idf ≈ 0`）⇒ 一句含这些词的查询会把全部条目拉进结果。
 *
 * **为什么不设"绝对分数下限"**（用户认可的那条理由）：BM25 的分数是**相对量**，同一句话在不同语料上
 * 不可比——绝对阈值最容易误杀真命中。而 `df` 是语料自身的属性，阈值 `N/2` 是**通用默认**、无需标定。
 *
 * ⚠ **保留路径在语料里**（不把它从文档文本里删掉）：她按文件名问是有用的（"facts 那个文件里有什么"），
 * 只是**不再靠它单独构成命中**——路径词元的区分力本来就该由**同现的摘要词**承担。
 */
export const BM25_MAX_DF_RATIO = 0.5;

/**
 * 建语料。**文档文本由调用方给**（本模块不读盘、不认路径）：
 * 阶段一/二都传 `路径 + 摘要`，见文件头那段"与报告的一处有意的差异"。
 *
 * **两遍**：第一遍数 `df`，第二遍按 {@link BM25_MAX_DF_RATIO} 把"半数以上文档都有"的词元丢掉。
 * 丢掉的是**双向**的：查询侧走同一个 `df` 表（{@link scoreBm25} 查不到就跳过），
 * 所以"路径词元不构成命中"这件事只需要在这一处实现一次。
 *
 * 空语料是合法输入（她还没写过任何记忆）：`N = 0`、`avgdl = 1`，打分全 0、排名为空——
 * 调用方据此如实说"没有相关的"，而不是抛错。
 */
export function buildBm25Corpus(docs: readonly string[]): Bm25Corpus {
  const rawTf: TermFreq[] = [];
  const rawDf = new Map<string, number>();
  for (const doc of docs) {
    const freq: TermFreq = new Map();
    for (const token of tokenizeBm25(doc)) freq.set(token, (freq.get(token) ?? 0) + 1);
    rawTf.push(freq);
    for (const token of freq.keys()) rawDf.set(token, (rawDf.get(token) ?? 0) + 1);
  }
  // 过半即丢：`> N * 0.5` 而不是 `>=`——**恰好半数**的词元仍有区分力（一半文档没有它）
  const cutoff = docs.length * BM25_MAX_DF_RATIO;
  const keep = (token: string): boolean => (rawDf.get(token) ?? 0) <= cutoff;
  const tf: TermFreq[] = [];
  const df = new Map<string, number>();
  const lens: number[] = [];
  for (const freq of rawTf) {
    const kept: TermFreq = new Map();
    for (const [token, count] of freq) if (keep(token)) kept.set(token, count);
    tf.push(kept);
    lens.push([...kept.values()].reduce((sum, n) => sum + n, 0));
    for (const token of kept.keys()) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const total = lens.reduce((sum, n) => sum + n, 0);
  return { N: docs.length, tf, df, lens, avgdl: docs.length === 0 ? 1 : total / docs.length };
}

/**
 * 一次打分的逐篇结果（**只给有分的**：一个词都对不上的文档不进结果）。
 *
 * 为什么把"分数"和"下标"一起给出来：调用方（两处）都要用它做两件事——
 * ① 排序取 top-K；② 把分数一路带到回执与事件里当**可核对的凭据**。
 */
export interface ScoredDoc {
  /** 文档下标（0 起；调用方 +1 就是给她的编号） */
  index: number;
  /** BM25 分数（> 0；越大越相关） */
  score: number;
  /** 命中的查询词（去重、按首次出现序）——回执里"为什么是它"的凭据 */
  matched: string[];
}

/**
 * 给一句话打分（纯函数）。
 *
 * 查询侧的分词与文档侧**同一个函数**（`tokenizeBm25`）——两处各写一份必然漂成
 * "建库时切法 A、查询时切法 B"，而那种漂是静默的（分数只是变差，不报错）。
 *
 * **"至少要有一个存活词元命中"这条判据就落在这里**（不是另写一个 if）：被
 * {@link BM25_MAX_DF_RATIO} 丢掉的词元**在 `corpus.df` 里查不到** ⇒ 一个都不参与打分
 * ⇒ 若查询里的词元**全部**是路径词元这类"过半文档都有"的，那么 `scores` 全 0、
 * **结果为空数组**。调用方（推荐段 / `query` 入口）据此如实说"没有相关的"——**宁少不凑**。
 */
export function scoreBm25(corpus: Bm25Corpus, query: string): ScoredDoc[] {
  const queryTokens = new Set(tokenizeBm25(query));
  if (corpus.N === 0 || queryTokens.size === 0) return [];
  const scores = new Float64Array(corpus.N);
  const matched: Array<Set<string>> = Array.from({ length: corpus.N }, () => new Set<string>());
  for (const token of queryTokens) {
    const df = corpus.df.get(token);
    // 查不到 = ①这个词元在所有文档里都没出现，或 ②它被 `BM25_MAX_DF_RATIO` 当"过半文档都有"丢掉了。
    // 两种情况对排序都没有信息（idf 都是 0 / 趋近 0）⇒ 直接跳过。**这就是那条"至少一个存活词元"判据。**
    if (df === undefined || df === 0) continue;
    const idf = Math.log(1 + (corpus.N - df + 0.5) / (df + 0.5));
    for (let i = 0; i < corpus.N; i += 1) {
      const f = corpus.tf[i]?.get(token);
      if (f === undefined || f === 0) continue;
      const len = corpus.lens[i] ?? 0;
      scores[i] = (scores[i] ?? 0) + idf * (f * (BM25_K1 + 1))
        / (f + BM25_K1 * (1 - BM25_B + BM25_B * (len / corpus.avgdl)));
      matched[i]?.add(token);
    }
  }
  const out: ScoredDoc[] = [];
  for (let i = 0; i < corpus.N; i += 1) {
    const score = scores[i] ?? 0;
    if (score > 0) out.push({ index: i, score, matched: [...(matched[i] ?? [])] });
  }
  return out;
}

/**
 * 排序：分数降序，**同分按 `路径:行号` 升序**（确定性那一层，见文件头）。
 *
 * `tieKey` 是调用方给的稳定键（索引条目传 `路径:行号`）。为什么不让调用方自己 `sort`：
 * 同分兜底是"确定性"这条纪律的落点，只写一处才可能被一处测到。
 */
export function rankScored<T>(
  scored: readonly ScoredDoc[],
  tieKey: (index: number) => string,
): Array<ScoredDoc & { key: string }> {
  return scored
    .map((item) => ({ ...item, key: tieKey(item.index) }))
    .sort((a, b) => (b.score - a.score) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * 分数 → 回执里那一格（两位小数）。
 *
 * 为什么要给分数：回执要**可核对**——"为什么是这 6 条"必须有个能对账的数，
 * 而不是一句"框架觉得相关"。两位小数够她（与人）看出量级差，又不至于把回执撑长。
 */
export function formatScore(score: number): string {
  return score.toFixed(2);
}
