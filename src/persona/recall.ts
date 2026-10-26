/**
 * Irmia Agent — **记忆召回：私有词典 + 最长匹配 + 四态留痕**（阶段二，**默认关闭**）
 *
 * 一句话：**平常闲聊不注入记忆；话里出现"这个安装自己的词"时才去回忆**。
 *
 * ──────────────────────────── 三件事、三处落点 ────────────────────────────
 *
 *   ① **私有词典**（`data/persona/recall-dictionary.jsonl`，JSONL 一行一个词）
 *      词从**本安装自己的对话语料**里发现（n-gram + 凝聚度 + 邻接熵，见
 *      `tools/memory-recall-measure.ts`），**不写死任何词**：换一个人设、换一台机器，
 *      词典跟着语料自己长。晋升/淘汰的判据全部是**相对量**（分位数），见
 *      {@link promoteRecallWords}。
 *   ② **最长匹配**（{@link buildRecallMatcher} / {@link matchRecall}）：
 *      前缀树 + 最长优先，零依赖、纯函数、可单测。拉丁词按整词小写比，CJK/数字前缀按码位比。
 *   ③ **两段式**：**专名命中 ⇒ 触发召回**（要不要去回忆）；**所有词参与 BM25 + 近因打分**
 *      （想起哪一条）——打分那一段是现成的 `bm25.ts` / `memory-select.ts`，这里不复写。
 *
 * ──────────────────────────── 四种状态（用户点的第 ⑤ 条） ────────────────────────────
 *
 * 只记"没注入"是不够的——四种结局对应四件不同的后续动作：
 *
 *   · `not-triggered` 未触发：没命中词典（或命中的词刚在上下文里出现过）。**正常**，
 *     大多数轮次都该是这一档；冷启动时 `reason: 'dictionary-empty'`。
 *   · `no-candidate` 触发但无候选：命中了，但记忆索引里没有一条相关的 ⇒ **记忆该写**。
 *   · `truncated` 命中但被预算截断：挑出来的超了硬顶，按确定性规则砍 ⇒ **预算该调**。
 *   · `injected` 正常注入。
 *
 * 每一种都带 `hits`（命中了哪几个词，可核对）、`candidates`（有分的候选条数）、
 * `tokens`（注入的 token 数）——没有这三个数，事后无法回答"为什么这一轮注入了/没注入"。
 *
 * ──────────────────────────── 开关与代价 ────────────────────────────
 *
 * `config.persona.recallEnabled`（**默认 false**）：关着时这一层**一行都不执行**，
 * 注入的仍是原来的"最近 5 次输入 → top-6"，请求字节逐字不变（见 `real-loop` 的接点）。
 * 打开后注入的是**另一段文本**（{@link renderRecallSegment}），所以那段字节与关着时不同
 * ——它是**配置取值**造成的差异，与 `persona.memoryEnabled` 同一类，不是渲染模板换代
 * （`RENDER_VERSION` 的判据是模板，不是配置；理由写在 `docs/design-memory-recall.md`）。
 *
 * 它**不读盘**：词典由调用方读进来（`loadRecallDictionary`），打分条目也由调用方递进来
 * ——与 `memory-select.ts` / `bm25.ts` 同一条纪律（渲染层不读文件系统）。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { estimateTokens } from '../tools/registry.ts';
import { buildBm25Corpus, scoreBm25 } from './bm25.ts';
import type { MemoryIndexEntry } from './memory-injection.ts';

// ──────────────────────────────── 常量（全部是结构/比例，不是语料拟合值） ────────────────────────────────

/** 词典文件（相对 `data/`；一行一个词，见 {@link recallDictionaryJsonl}） */
export const RECALL_DICTIONARY_FILE = 'persona/recall-dictionary.jsonl';

/**
 * 晋升的**语义下限**：跨 ≥2 个自然日。
 *
 * 不是阈值，是"重复"的语义：同一天刷十遍不代表这个词在她的世界里稳定存在，
 * 挡的是"一次聊天的口头禅被当成专名"。与 `MIN_OCCURRENCE` 一起构成"出现过且不是偶然"。
 */
export const RECALL_MIN_DISTINCT_DAYS = 2;

/**
 * 晋升的**语义下限**：至少被"命名"过两次（{@link RecallCandidate.evidence} ≥ 2）。
 *
 * 一次命名可能是巧合（"这个叫 X 的东西"），两次以上才说明这个字在她记忆里**是个名字**。
 * 这是 2026-10-19 用户裁决的核心改动：把 PMI 从**硬门**降级为**辅助分**，硬门换成
 * "至少有一条命名位置证据"——因为 PMI 天生歧视"常用字拼出来的中文实体名"
 * （实测三个漏召回例子全是这种：`内测群` PMI 7.07、`测试群` 7.38、`长门` 7.90，
 * 而当时的中档门槛是 9.25）。
 */
export const RECALL_MIN_NAMING_EVIDENCE = 2;

/**
 * 晋升的**语义下限**：命名证据要来自**至少两种不同的格式线索**。
 *
 * 一种线索不足以证明"这是个名字"：`「」`引号在记忆里也用来引用对话（实测"发出来""爱你"
 * 都能凑够两条）；而真名通常同时出现在两种格式里（`X = Y` 值位 + `群` 后缀、`@某人` + 引号）。
 * 这条规则只看**线索种类数**，不看任何具体词，换人设照样成立。
 */
export const RECALL_MIN_EVIDENCE_KINDS = 2;

/** 晋升的**语义下限**：至少出现过 2 次（只出现一次的串无法判断是不是词） */
export const RECALL_MIN_OCCURRENCE = 2;

/**
 * 淘汰窗口：**90 天没再出现、且 count 不再增长 ⇒ 降级**（用户给的规则，不是从语料拟合的）。
 *
 * 为什么必须有淘汰：词典只进不出的话，OOV 恒空、检索永不触发——
 * 每一条老名字都会永久占着"触发位"，而这个人的世界是会长出新名字的。
 */
export const RECALL_EVICT_AFTER_DAYS = 90;

/**
 * 相关度下限的**默认分位**（0–1 的比例，不是分数）：命中词里最稀的那个的 idf，
 * 至少要落在本安装词表 idf 分布的这个分位上。0.25 = "比四分之一的词更稀"。
 *
 * 它是**比例**不是分数：BM25 的分数是相对量，同一句话在不同语料上不可比，
 * 而"词表 idf 分布的分位"随语料自己缩放。
 */
export const RECALL_MIN_IDF_QUANTILE = 0.25;

/**
 * **证据的加权分**（2026-10-19 第三轮）：不再用"种类数"当铁律，改成加权求和。
 *
 *   强线索（权重 3）：`heading`（`# 名字`）、`assign`（`X = Y` 的值位）、`at`、`call`、`filename`
 *   中线（权重 2）：`suffix`（`群/号/家/店/铺/台` 之前那截）
 *   弱线索（权重 1）：`quote`（`「」` 内——它也被用来引用对话）
 *
 * 为什么要加权：上一轮"≥2 类"把 `吱吱` / `1号` / `海南` 这些**只被引号反复提到**的真名全挡在门外；
 * 而"引号里 6 条"其实比"两类各 1 条"更可信。加权能把这两种情况分开。
 */
export const RECALL_EVIDENCE_WEIGHT = { strong: 3, medium: 2, weak: 1 } as const;

/** 晋升的证据门槛（加权分）：= 1 条强线索+1 条弱线索 / 2 条中线 / 4 条弱线索 */
export const RECALL_MIN_EVIDENCE_WEIGHT = 4;

/**
 * **一票通过**的证据权重（2026-10-19 第三轮）。
 *
 * 证据权重高到这一档时，**跳过熵 / 频次 / 日数三道分位门**（结构下限与证据门槛照旧）。
 * 依据：上一轮实测"证据够、接不上"——②→③ 掉了 19 条，那些词大多是真名，被后面的分位门砍掉。
 * 一票通过＝把"证据足够强"当成比统计形状更硬的证据。
 */
export const RECALL_ONE_VOTE_WEIGHT = 10;

// ──────────────────────────────── 词典的形状 ────────────────────────────────

/** 一个候选词（发现器的产物；本模块只吃这几格，别的字段不认） */
export interface RecallCandidate {
  word: string;
  /** 出现次数 */
  count: number;
  /** 凝聚度（bit；拉丁整词/数字前缀名为 null——它们没有内部切分点）。**辅助分，不做硬门** */
  pmi: number | null;
  /** min(左邻熵, 右邻熵)（bit） */
  minEntropy: number;
  /** 出现过的自然日数 */
  distinctDays: number;
  /** 第一次/最后一次出现（ISO 时间；淘汰判据用 lastSeen） */
  firstSeen: string;
  lastSeen: string;
  /**
   * **命名位置证据的条数**（2026-10-19 起是晋升的**硬门**，见
   * {@link RECALL_MIN_NAMING_EVIDENCE}）。
   *
   * 只数**格式判据**：`X = Y` 的值位 / `# 标题` / `「」` 引号内 / `@某人` /
   * `叫|名叫|昵称…` 之后 / `群|号|家|店|铺|台` 之前 / 联系人文件名。**不认任何具体词**，
   * 所以换一个人设照样成立。词表与判据的实现在构建器（`tools/memory-recall-measure.ts`），
   * 本模块只消费这个数。
   */
  evidence?: number;
  /**
   * **证据的"种类数"**（几条**互不相同**的格式线索命中过它）。
   *
   * 为什么要单独一格：单一来源的证据太弱——`「」`引号在记忆文件里既用来命名、也用来
   * **引用对话**，实测"发出来""爱你""你好"这些日常短语都能从引号里拿到 2 条证据；
   * 而真正的名字通常**同时**落在两种以上格式里（`X = Y` 的值位 + `群` 后缀 /
   * `@某人` + 引号）。所以晋升要求**至少两种**不同的证据，
   * 见 {@link RECALL_MIN_EVIDENCE_KINDS}。
   */
  evidenceKinds?: number;
  /**
   * **证据的加权分**（2026-10-19 第三轮；晋升就看这一格）。
   *
   * = 3×强线索条数 + 2×中线条数 + 1×弱线索条数（见 {@link RECALL_EVIDENCE_WEIGHT}）。
   * 高到 {@link RECALL_ONE_VOTE_WEIGHT} 时**一票通过**：跳过熵/频次/日数三道分位门。
   */
  evidenceWeight?: number;
  /** **强线索**的条数（heading/assign/at/call/filename）：一票通过与它挂钩 */
  evidenceStrong?: number;
  /**
   * **名字 → 条目**的反向索引（第四轮，2026-10-19）：这个词出现在**哪几条索引行的全文**里，
   * 形如 `MEMORIES/facts.md:87`（按出现顺序，构建时截断到 {@link RECALL_MAX_REFS} 条）。
   *
   * 为什么必须有它：索引行只留 40 字摘要（`ENTRY_SUMMARY_MAX_CHARS`），而实体名经常落在
   * 摘要**之后**的位置——实测 5/35 个命中词在 266 条摘要里**一个字都没有**，指针层于是
   * 指不到它们（b′ 的天花板被这一条压到 85.7%）。
   * 反向索引把这个数抬到接近 100%，而且**不往索引行里塞字**（指针的 token 不涨）。
   */
  refs?: string[];
}

/** 反向索引每条词最多存几条指针（构建时截断；超出的是"这个词满世界都是"，不该当名字） */
export const RECALL_MAX_REFS = 8;

/** 三档分位参数（每个都是 0–1 的比例；**没有绝对阈值**） */
export interface RecallQuantilePlan {
  /** PMI 的分位 */
  pmi: number;
  /** 邻接熵的分位 */
  entropy: number;
  /** count 下界分位（不是偶然出现一次） */
  countMin: number;
  /** count 上界分位（不是通用高频词） */
  countMax: number;
  /** 出现日数上界分位（出现得太分散的是日常词） */
  daysMax: number;
}

/** 算出来的绝对门槛（只是"这一版语料 + 这一组分位"的读数，**不写进配置**） */
export interface RecallThresholds {
  pmi: number;
  entropy: number;
  countMin: number;
  countMax: number;
  daysMax: number;
  /** 池子大小；0 ⇒ 冷启动（词典必空） */
  poolSize: number;
}

/** 升序数组上的分位数（线性插值；空数组给 NaN，调用方必须显式处理"没有池子"） */
export function quantileOf(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0] as number;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

/**
 * 池子 → 分位门槛（纯函数）。
 *
 * **熵那一列只在"左右邻至少有一个变化"的样本里取分位**：子串（"亚小"之于"亚小姐"）的邻接
 * 几乎是确定的、熵恒为 0；把它们算进来会让分位直接落在 0，熵门形同虚设。
 * 这不是把门槛往下调，而是把"测不出自由度"的样本排除在度量之外——它们本来就会被熵门挡掉。
 *
 * 池子为空（新装、语料太少）⇒ 全部 NaN ⇒ {@link promoteRecallWords} 出空词典 ⇒
 * 冷启动（不触发 + 留痕 `dictionary-empty`）。**不抛错**：空词典是合法状态。
 */
export function recallThresholds(
  pool: readonly RecallCandidate[],
  plan: RecallQuantilePlan,
): RecallThresholds {
  const pmiValues = pool.filter((c) => c.pmi !== null).map((c) => c.pmi as number).sort((a, b) => a - b);
  const entValues = pool.filter((c) => c.minEntropy > 0).map((c) => c.minEntropy).sort((a, b) => a - b);
  const countValues = pool.map((c) => c.count).sort((a, b) => a - b);
  const daysValues = pool.map((c) => c.distinctDays).sort((a, b) => a - b);
  return {
    pmi: quantileOf(pmiValues, plan.pmi),
    entropy: quantileOf(entValues, plan.entropy),
    countMin: quantileOf(countValues, plan.countMin),
    countMax: quantileOf(countValues, plan.countMax),
    daysMax: quantileOf(daysValues, plan.daysMax),
    poolSize: pool.length,
  };
}

/** 淘汰：最后出现距 `now` 超过 {@link RECALL_EVICT_AFTER_DAYS} 天 ⇒ 降级（不进词典） */
export function isStale(candidate: RecallCandidate, now: string, evictAfterDays = RECALL_EVICT_AFTER_DAYS): boolean {
  const last = Date.parse(candidate.lastSeen);
  const at = Date.parse(now);
  if (!Number.isFinite(last) || !Number.isFinite(at)) return false;
  return at - last > evictAfterDays * 24 * 3600 * 1000;
}

/**
 * 池子 + 门槛 → 词典（晋升四条**同时**满足；这是"有进有出"的那一半）。
 *
 *   ① **⭐ 被命名过**（硬门，2026-10-19 第三轮改成**加权分**）：`evidenceWeight ≥ RECALL_MIN_EVIDENCE_WEIGHT`。
 *      这是**新的硬门**——它取代了原来那条"PMI ≥ 分位门槛"。PMI 判的是"这串字像不像一个词"，
 *      我们要的是"这串字**是不是一个名字**"（`内测群`/`测试群`/`长门` 的 PMI 都低于同期门槛，
 *      但它们在记忆里被**显式命名**过）。
 *   ② **够自由**：min(左邻熵, 右邻熵) ≥ 分位门槛；
 *   ③ **够常用但不够通用**：`countMin ≤ count ≤ countMax` 且 `distinctDays ≤ daysMax`；
 *   ④ **结构性下限**：出现过 ≥2 次、跨 ≥2 天；距 `now` 超过 {@link RECALL_EVICT_AFTER_DAYS} 天 ⇒ 降级。
 *   ⑤ **⭐ 一票通过**（2026-10-19 第三轮）：`evidenceWeight ≥ RECALL_ONE_VOTE_WEIGHT` 时**跳过 ②③**
 *      ——证据足够强就不再看统计形状。依据是第二轮那三问：证据够、接不上（②→③ 掉 19 条）。
 *
 * ⚠ **PMI 不再参与晋升**（`thresholds.pmi` 只用于报告里那一列"辅助分读数"）。
 * 一个词若没有命名证据，它再凝聚也进不了词典——这正是"闲聊不触发"的来源。
 */
export function promoteRecallWords(
  pool: readonly RecallCandidate[],
  thresholds: RecallThresholds,
  options: {
    now?: string;
    evictAfterDays?: number;
    minEvidenceWeight?: number;
    oneVoteWeight?: number;
  } = {},
): RecallCandidate[] {
  const now = options.now;
  const evictAfterDays = options.evictAfterDays ?? RECALL_EVICT_AFTER_DAYS;
  const minWeight = options.minEvidenceWeight ?? RECALL_MIN_EVIDENCE_WEIGHT;
  const oneVote = options.oneVoteWeight ?? RECALL_ONE_VOTE_WEIGHT;
  const out: RecallCandidate[] = [];
  for (const cand of pool) {
    if (cand.count < RECALL_MIN_OCCURRENCE) continue;
    if (cand.distinctDays < RECALL_MIN_DISTINCT_DAYS) continue;
    const weight = cand.evidenceWeight ?? ((cand.evidence ?? 0) * RECALL_EVIDENCE_WEIGHT.weak);
    const strong = cand.evidenceStrong ?? 0;
    if (weight < minWeight) continue;
    if (now !== undefined && isStale(cand, now, evictAfterDays)) continue;
    // 一票通过：**强线索 + 足够权重**才不再看统计形状（只有弱线索堆到 10 分不算——名字/没有 就是这样混进来的）
    const oneVotePass = strong >= 1 && weight >= oneVote;
    if (!oneVotePass) {
      if (!Number.isNaN(thresholds.countMin) && cand.count < thresholds.countMin) continue;
      if (!Number.isNaN(thresholds.countMax) && cand.count > thresholds.countMax) continue;
      if (!Number.isNaN(thresholds.daysMax) && cand.distinctDays > thresholds.daysMax) continue;
      if (!Number.isNaN(thresholds.entropy) && cand.minEntropy < thresholds.entropy) continue;
    }
    out.push(cand);
  }
  // 降序按（证据权重 → count → 字典序）：同一个池子两次跑出同一份词典
  out.sort((a, b) => ((b.evidenceWeight ?? 0) - (a.evidenceWeight ?? 0))
    || (b.count - a.count) || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
  return out;
}

/** 词典 → JSONL（一行一个词；只落判据需要的那些格，正文不进文件） */
export function recallDictionaryJsonl(
  words: readonly RecallCandidate[],
  extra: { kind?: (word: string) => string } = {},
): string {
  return words.map((w) => JSON.stringify({
    word: w.word,
    kind: extra.kind?.(w.word) ?? null,
    count: w.count,
    pmi: w.pmi,
    entropy: w.minEntropy,
    days: w.distinctDays,
    evidence: w.evidence ?? 0,
    evidenceKinds: w.evidenceKinds ?? 0,
    evidenceWeight: w.evidenceWeight ?? 0,
    evidenceStrong: w.evidenceStrong ?? 0,
    refs: w.refs ?? [],
    firstSeen: w.firstSeen,
    lastSeen: w.lastSeen,
  })).join('\n') + (words.length === 0 ? '' : '\n');
}

/**
 * JSONL → 词表。**宽容读**：坏行跳过，不抛错（词典是资产，坏了不该把整轮请求打死）；
 * 空文件 = 空词典 = 冷启动，这是合法状态。
 */
export function parseRecallDictionary(text: string): RecallCandidate[] {
  const out: RecallCandidate[] = [];
  for (const line of text.split('\n')) {
    const raw = line.trim();
    if (raw === '') continue;
    let obj: any;
    try { obj = JSON.parse(raw); } catch { continue; }
    const word = typeof obj?.word === 'string' ? obj.word : '';
    if (word === '') continue;
    out.push({
      word,
      count: Number(obj.count) || 0,
      pmi: obj.pmi === null || obj.pmi === undefined ? null : Number(obj.pmi),
      minEntropy: Number(obj.entropy ?? obj.minEntropy) || 0,
      distinctDays: Number(obj.days ?? obj.distinctDays) || 0,
      evidence: Number(obj.evidence) || 0,
      evidenceKinds: Number(obj.evidenceKinds) || 0,
      evidenceWeight: Number(obj.evidenceWeight) || 0,
      evidenceStrong: Number(obj.evidenceStrong) || 0,
      refs: Array.isArray(obj.refs) ? obj.refs.map((x: unknown) => String(x)).slice(0, RECALL_MAX_REFS) : [],
      firstSeen: String(obj.firstSeen ?? ''),
      lastSeen: String(obj.lastSeen ?? ''),
    });
  }
  return out;
}

/** 词典文件的绝对路径（`<dataDir>/persona/recall-dictionary.jsonl`） */
export function recallDictionaryPath(dataDir: string): string {
  return join(dataDir, RECALL_DICTIONARY_FILE);
}

/**
 * **正文层的证据门槛**（2026-10-19 第三轮）：只有证据权重高到这个数的词才**展开正文**。
 *
 * 两级注入的分工就在这里：
 *   · **指针层**（永远在）用**全词典**——只要这条词被命名过（权重 ≥
 *     {@link RECALL_MIN_EVIDENCE_WEIGHT}）就把它指出来；
 *   · **正文层**（花钱的那一层）只用**强证据词**（权重 ≥ 本常量）。
 * 实测：同一份词典、同一批轮次，正文门槛从 4 抬到 10，闲聊正文注入率 15.0% → 8.2%，
 * 而指针覆盖率几乎不动（67.4% → 65.1%）——这就是"两级"的意义。
 */
export const RECALL_BODY_MIN_EVIDENCE_WEIGHT = 10;

/**
 * 读词典并建匹配器（**宿主调用**：一轮一次；渲染层不读盘）。
 *
 * 三条纪律：
 *   · **文件不在 = 空词典**（新装、还没跑过构建）：不抛错，直接进冷启动；
 *   · **坏行跳过**（{@link parseRecallDictionary}）：一份写坏的词典不该把整轮请求打死；
 *   · **按 mtime 缓存**：同一个进程里盘上没变就不重读、不重建前缀树。
 */
let matcherCache: { path: string; mtimeMs: number; matcher: RecallMatcher; candidates: RecallCandidate[] } | null = null;

/** 读词典（宽的那一份：指针层用全量）。返回匹配器与候选表（后者给"按权重再切一刀"用） */
export function loadRecallDictionaryFile(filePath: string): { matcher: RecallMatcher; candidates: RecallCandidate[] } {
  if (!existsSync(filePath)) return { matcher: buildRecallMatcher([]), candidates: [] };
  let mtimeMs = 0;
  try { mtimeMs = Math.round(statSync(filePath).mtimeMs); } catch { return { matcher: buildRecallMatcher([]), candidates: [] }; }
  if (matcherCache !== null && matcherCache.path === filePath && matcherCache.mtimeMs === mtimeMs) {
    return { matcher: matcherCache.matcher, candidates: matcherCache.candidates };
  }
  let text = '';
  try { text = readFileSync(filePath, 'utf8'); } catch { return { matcher: buildRecallMatcher([]), candidates: [] }; }
  const candidates = parseRecallDictionary(text);
  const matcher = buildRecallMatcher(candidates.map((c) => c.word));
  matcherCache = { path: filePath, mtimeMs, matcher, candidates };
  return { matcher, candidates };
}

/** 只要匹配器（老调用点用；等于 {@link loadRecallDictionaryFile} 的 `.matcher`） */
export function loadRecallDictionary(filePath: string): RecallMatcher {
  return loadRecallDictionaryFile(filePath).matcher;
}

/**
 * 从同一份词典切出**正文层**的匹配器（证据权重 ≥ {@link RECALL_BODY_MIN_EVIDENCE_WEIGHT}）。
 *
 * 两级注入的"两个视图"只差这一个阈值，不另存一份文件：词典是资产，视图是解释。
 */
export function buildBodyMatcher(candidates: readonly RecallCandidate[]): RecallMatcher {
  return buildRecallMatcher(
    candidates.filter((c) => (c.evidenceWeight ?? 0) >= RECALL_BODY_MIN_EVIDENCE_WEIGHT).map((c) => c.word),
  );
}

// ──────────────────────────────── 最长匹配（前缀树） ────────────────────────────────
interface TrieNode {
  next: Map<string, TrieNode>;
  word: string | null;
}

export interface RecallMatcher {
  root: TrieNode;
  /** 最长词的长度（码位数）——剪枝用，也是"最快能判出不可能命中"的界 */
  maxWordLength: number;
  /** 词表规模（进事件账：一眼看出词典是空的还是长起来了） */
  size: number;
}

/**
 * 前缀树 + **最长匹配**（"AC 风格"的那一半）。
 *
 * 为什么不用完整 Aho–Corasick：AC 的价值是"一次扫描同时匹配所有模式、下一个起点复用状态"。
 * 我们只做**单起点的最长匹配**，起点每步都前进，不需要 failure link——两种做法在
 * "给定位置的最长词"上等价，而这一版代码短得多、也更容易单测。
 *
 * 复杂度 O(n × L)，L = 最长词的码位数（CJK 2–6 字、拉丁词几个字符）。
 * 纯函数、无 IO、无时钟 ⇒ 同输入同输出。
 */
export function buildRecallMatcher(words: Iterable<string>): RecallMatcher {
  const root: TrieNode = { next: new Map(), word: null };
  let maxWordLength = 0;
  let size = 0;
  for (const word of words) {
    const chars = [...word];
    if (chars.length === 0) continue;
    let node = root;
    for (const ch of chars) {
      let child = node.next.get(ch);
      if (child === undefined) { child = { next: new Map(), word: null }; node.next.set(ch, child); }
      node = child;
    }
    if (node.word === null) size += 1;
    node.word = word;
    if (chars.length > maxWordLength) maxWordLength = chars.length;
  }
  return { root, maxWordLength, size };
}

export interface RecallHit {
  word: string;
  start: number;
  end: number;
}

/**
 * 在一段文本里做最长匹配（命中区间**不重叠**：一次提及只该触发一次）。
 *
 * 两条口径：
 *   · **拉丁词大小写不敏感**（词典存小写；查询时逐字降级试一次）；
 *   · **CJK / 数字前缀按码位**（前缀树本来就是按码位走的，天然一致）。
 */
export function matchRecall(text: string, matcher: RecallMatcher): RecallHit[] {
  if (matcher.size === 0) return [];
  const hits: RecallHit[] = [];
  const chars = [...text];
  let i = 0;
  while (i < chars.length) {
    let node: TrieNode = matcher.root;
    let best: { word: string; end: number } | null = null;
    const limit = Math.min(chars.length, i + matcher.maxWordLength);
    for (let j = i; j < limit; j += 1) {
      const ch = chars[j] as string;
      const lower = ch.toLowerCase();
      const next: TrieNode | undefined = node.next.get(ch) ?? (lower !== ch ? node.next.get(lower) : undefined);
      if (next === undefined) break;
      node = next;
      if (node.word !== null) best = { word: node.word, end: j + 1 };
    }
    if (best === null) { i += 1; continue; }
    hits.push({ word: best.word, start: i, end: best.end });
    i = best.end;
  }
  return hits;
}

// ──────────────────────────────── 触发门（要不要去回忆） ────────────────────────────

/** 未触发的原因（封闭枚举；进事件账，用来回答"为什么这一轮没回忆"） */
export type RecallSkipReason =
  /** 词典是空的（冷启动 / 语料还没长起来）——**不是错误** */
  | 'dictionary-empty'
  /** 话里没有词典里的词 */
  | 'no-hit'
  /** 命中的词刚刚在上下文里出现过 ⇒ 已经在眼前，不必再回忆 */
  | 'in-context';

export interface RecallGate {
  triggered: boolean;
  /** 命中的词（已扣掉"最近上下文里出现过"的那些），按出现顺序去重 */
  hits: string[];
  /** 没触发时的理由；触发了就没有这一格 */
  reason?: RecallSkipReason;
}

/**
 * 两段式的第一段：**要不要去回忆**。
 *
 * 判据只有两条，都是"事实"而不是调出来的阈值：
 *   · 话里出现了**词典里的词**（这个安装自己的专名/新词）；
 *   · 那个词**不在最近上下文里**（用户那句验收标准里的括号：不在上下文中的）。
 *
 * `recentText` 由调用方给（一轮取一次：最近若干条可见消息）。给空串 = 不做第二步
 * （等价于"所有命中的词都算不在上下文里"）。
 */
export function gateRecall(
  query: string,
  matcher: RecallMatcher,
  recentText = '',
): RecallGate {
  if (matcher.size === 0) return { triggered: false, hits: [], reason: 'dictionary-empty' };
  const rawHits = matchRecall(query, matcher);
  if (rawHits.length === 0) return { triggered: false, hits: [], reason: 'no-hit' };
  const recent = recentText === '' ? new Set<string>() : new Set(matchRecall(recentText, matcher).map((h) => h.word));
  const hits = [...new Set(rawHits.map((h) => h.word))].filter((word) => !recent.has(word));
  if (hits.length === 0) return { triggered: false, hits: [], reason: 'in-context' };
  return { triggered: true, hits };
}

// ──────────────────────────────── 注入（想起哪一条 + 预算硬顶） ────────────────────────

/** 四态（顺序即"从最省到最费"，读起来跟成本同向） */
export type RecallState = 'not-triggered' | 'no-candidate' | 'truncated' | 'injected';

/** 一轮的召回账（进 `memory/selected.recall`，internal；不进请求体） */
export interface RecallTrace {
  state: RecallState;
  /** 未触发时的细分理由（触发时为 undefined） */
  reason?: RecallSkipReason;
  /** 命中的词典词（可核对"为什么这一轮去回忆了"） */
  hits: string[];
  /** 有分的候选条数（0 ⇒ 记忆该写；进事件后这个数与 `injected` 分得开） */
  candidates: number;
  /** 正文实际注入的条数 */
  injected: number;
  /** 正文实际注入的 token（`estimateTokens` 口径，与运行期同一份实现） */
  tokens: number;
  /**
   * **指针层**（2026-10-19 第三轮）：每轮都注入的那一小块"目录"。
   *
   * 它和正文**分开计量**——用户的验收线也是分开的：`a′`（闲聊轮的指针 token ≤40）
   * 与 `b′`（U 轮指针里出现正确条目的比例 ≥90%）。指针是"有东西可想起"这件事的保底，
   * 正文是"真的把它展开"。
   */
  pointer: number;
  pointerTokens: number;
}

/** 注入硬顶：条数 + token 双上限（谁是瓶颈由调用方配，二者都算"硬顶"） */
export interface RecallBudget {
  /** 最多几条 */
  maxItems: number;
  /** 最多多少 token（**相对量**：由宿主按"今天的每轮常驻成本"算出并递进来） */
  maxTokens: number;
  /**
   * **相关度下限**（相对量，可选；2026-10-19 加）。
   *
   * 单位是"**本安装词表 idf 分布的分位**"：`0.25` = 命中词里至少有一个词的 idf
   * ≥ 词表 idf 的 p25。**没有绝对分数**——BM25 的分数是相对量，绝对阈值最容易误杀。
   *
   * 为什么需要它：不加这条，"触发但无候选"几乎永远不出现（BM25 在真实索引上总能
   * 找到一两条有词重叠的条目 ⇒ "记忆该写"这个信号形同虚设，实测三档都是 0–1 次）。
   * 判据的直觉：命中的全是"满大街都有"的词（idf 极低）时，那不叫相关，叫撞词。
   *
   * 缺省 / `0` = 关掉这条下限（老行为）。
   */
  minIdfQuantile?: number;
}

/** 注入段里的一条（**展示顺序**即数组顺序；`index` 是**全量索引里的 1-based 编号**，`memory_read` 用的就是它） */
export interface RecallItem {
  index: number;
  ref: string;
  path: string;
  line: number;
  summary: string;
  pinned: boolean;
  /** BM25 分数（两位小数进回执；pinned 保底进来的记 0） */
  score: number;
  /** 命中的查询词（回执里"为什么是它"的凭据） */
  matched: string[];
}

export interface RecallInjection {
  trace: RecallTrace;
  /** 展示顺序：pinned 保底在前，其余按（分数降序、近因降序、`路径:行号` 升序） */
  items: RecallItem[];
}

/**
 * 第二段：**想起哪一条**（所有词参与 BM25 + 近因打分；预算硬顶 + 确定性截断）。
 *
 * 打分那一段**不在这里复写**：用的是 `bm25.ts` 的同一个语料/同一个公式，排序同分兜底
 * 用 `路径:行号`（与 `memory-select.ts` 一致）。这里只加三样东西：
 *
 *   ① **近因**：`recencyOf` 更近的候选在**同分**时优先——不是加一个权重项（那会把 BM25
 *      的相对性破坏掉），而是**同分兜底**那一层：同分时先按"最近被读过"、再按 `路径:行号`。
 *      为什么放同分层：BM25 分数是相对量，硬加一个 recency 项等于把两个不同量纲相加，
 *      而"同分时怎么排"本来就没有信息，用近因填这一格不引入新偏差。
 *   ② **预算硬顶**：token 超了就砍，规则见 {@link truncateToBudget}。
 *   ③ **四态**：每种结局都留痕（见 {@link RecallTrace}）。
 */
export function planRecallInjection(input: {
  query: string;
  gate: RecallGate;
  entries: readonly MemoryIndexEntry[];
  budget: RecallBudget;
  /** 已在**指针层**展示过的条目（正文不再重复：同一行出现两次是白花钱） */
  pointerRefs?: readonly string[];
  /** `路径:行号` → 最近一次被读/写的时间（毫秒）；没有就是 undefined（同分兜底第二档） */
  recencyOf?: (ref: string) => number | undefined;
}): RecallInjection {
  const { gate, entries, budget } = input;
  if (!gate.triggered) {
    return {
      trace: { state: 'not-triggered', reason: gate.reason ?? 'no-hit', hits: [], candidates: 0, injected: 0, tokens: 0, pointer: 0, pointerTokens: 0 },
      items: [],
    };
  }
  const corpus = buildBm25Corpus(entries.map((entry) => `${entry.path} ${entry.summary}`));
  const scored = scoreBm25(corpus, input.query);
  /**
   * **相关度下限**（相对量）：先算本安装词表的 idf 分布，取它的一个分位当门槛，
   * 再看每条候选**命中的词里最稀的那个**够不够稀。够不到 ⇒ 这一轮算"触发但无候选"。
   */
  const idfOf = (df: number): number => Math.log(1 + (corpus.N - df + 0.5) / (df + 0.5));
  const idfValues = [...corpus.df.values()].map(idfOf).sort((a, b) => a - b);
  const idfFloor = budget.minIdfQuantile === undefined || budget.minIdfQuantile <= 0
    ? Number.NaN
    : quantileOf(idfValues, budget.minIdfQuantile);
  /**
   * 哪些命中词有资格参与"下限"这一步：**至少两个字、且不是纯数字**。
   *
   * 理由是 BM25 的分词口径（`tokenizeBm25`）会把中文切成单字 bigram、把数字整段留下，
   * 于是 `12` 条摘要里的序号 `0..9` 每个都变成 df=1 的"极稀有词"——拿它们判"够不够稀有"
   * 是自欺欺人。下限要判的是**词**，不是分词器的边角料。
   */
  const informative = (token: string): boolean => [...token].length >= 2 && !/^[0-9]+$/u.test(token);
  const idfByToken = new Map<string, number>();
  const idfOfToken = (token: string): number => {
    let v = idfByToken.get(token);
    if (v === undefined) {
      const df = corpus.df.get(token);
      v = df === undefined ? 0 : idfOf(df);
      idfByToken.set(token, v);
    }
    return v;
  };
  const bestIdfOf = (hit: { matched: string[] }): number => {
    let best = 0;
    for (const token of hit.matched) if (informative(token)) best = Math.max(best, idfOfToken(token));
    return best;
  };
  const keptScored = Number.isNaN(idfFloor)
    ? scored
    : scored.filter((hit) => {
      const best = bestIdfOf(hit);
      // 一条"有内容的词"都没命中 ⇒ 不拿下限去否它（那是分词粒度问题，不是相关性问题）
      return best === 0 || best >= (idfFloor as number);
    });
  if (keptScored.length === 0) {
    return { trace: { state: 'no-candidate', hits: gate.hits, candidates: 0, injected: 0, tokens: 0, pointer: 0, pointerTokens: 0 }, items: [] };
  }
  const shownRefs = new Set(input.pointerRefs ?? []);
  const scoreOf = new Map<number, number>();
  const matchedOf = new Map<number, string[]>();
  for (const hit of keptScored) { scoreOf.set(hit.index, hit.score); matchedOf.set(hit.index, hit.matched); }
  const recency = input.recencyOf ?? (() => undefined);
  const refOf = (entry: MemoryIndexEntry): string => `${entry.path}:${entry.line}`;
  const toItem = (i: number, score: number, matched: string[]): RecallItem => {
    const entry = entries[i] as MemoryIndexEntry;
    return {
      index: i + 1, ref: refOf(entry), path: entry.path, line: entry.line,
      summary: entry.summary, pinned: entry.pinned === true, score, matched,
    };
  };

  const pinned: RecallItem[] = [];
  const others: RecallItem[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] as MemoryIndexEntry;
    const score = scoreOf.get(i) ?? 0;
    if (shownRefs.has(refOf(entry))) continue;
    if (entry.pinned === true) { pinned.push(toItem(i, score, matchedOf.get(i) ?? [])); continue; }
    if (score <= 0) continue;
    others.push(toItem(i, score, matchedOf.get(i) ?? []));
  }
  others.sort((a, b) => (b.score - a.score)
    || ((recency(b.ref) ?? 0) - (recency(a.ref) ?? 0))
    || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const room = Math.max(0, budget.maxItems - pinned.length);
  const { items, cut } = truncateToBudget([...pinned, ...others.slice(0, room)], budget, gate.hits);
  const tokens = items.length === 0 ? 0 : estimateTokens(renderRecallSegment(gate.hits, items));
  /**
   * `truncated` 只指**预算硬顶**逼着我们砍掉了本来要给的条目（`cut === true`）。
   *
   * 条数上限（`maxItems`，与老口径同为 6）造成的"20 条里有 14 条没进"**不算截断**——
   * 那是"挑 top-K"本身，不是预算不够。两者混在一起会让"正常注入"几乎永远不出现
   * （实测第一次跑就是这样：凡是候选多于 6 条的轮次全记成 truncated，四态退化成一态）。
   * "有多少条相关 / 推了几条"这个差别由 `candidates` 与 `injected` 两个数回答，不用状态码兼职。
   */
  const state: RecallState = items.length === 0 ? 'no-candidate' : (cut ? 'truncated' : 'injected');
  return {
    trace: { state, hits: gate.hits, candidates: keptScored.length, injected: items.length, tokens, pointer: 0, pointerTokens: 0 },
    items,
  };
}

/**
 * 预算截断（**确定性**）：先砍低分、同分先砍更旧的。
 *
 * 输入是已经排好序的候选（pinned 保底在前、其余按分数降序）。**pinned 永不砍**：
 * 砍它等于把"置顶的永远在场"这条口径推翻。
 *
 * 返回留下的条目（**保持输入顺序**，展示顺序不因截断而变）与"有没有砍过"。
 */
function truncateToBudget(
  picked: readonly RecallItem[],
  budget: RecallBudget,
  hits: readonly string[],
): { items: RecallItem[]; cut: boolean } {
  const items = [...picked];
  let cut = false;
  while (items.length > 0) {
    if (estimateTokens(renderRecallSegment(hits, items)) <= budget.maxTokens) break;
    let victim = -1;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i] as RecallItem;
      if (item.pinned !== true && (victim === -1 || item.score < (items[victim] as RecallItem).score)) victim = i;
    }
    if (victim === -1) break; // 只剩 pinned：照实印，不砍置顶
    items.splice(victim, 1);
    cut = true;
  }
  return { items, cut };
}

/**
 * 召回段 → 可直接注入固定块的文本。
 *
 * 与"推荐段"（`MEMORY_RECOMMEND_BANNER_TEMPLATE`）**措辞不同**，因为**事实不同**：
 * 推荐段是"框架按最近话题挑的"，召回段是"你提起了这几个词，所以去翻了记忆"。
 * 把两种情况写成同一句话会让她误判"框架在盯着我的话题"，而不是"我说到了它记得的东西"。
 *
 * 行形态与索引行同构（编号 + 指针 + 摘要）：编号是她去 `memory_read` 的入口，
 * 指针是给人看的可核对凭据。
 */
export function renderRecallSegment(hits: readonly string[], items: readonly RecallItem[]): string {
  if (items.length === 0) return '';
  const why = hits.length === 0 ? '' : `（你提到了 ${hits.slice(0, 4).join('、')}${hits.length > 4 ? ' 等' : ''}）`;
  const head = `【想起来的记忆】${why}框架从记忆里挑了 ${items.length} 条，不一定都对；要哪条用 memory 工具取`;
  const lines = items.map((item) => {
    const pinned = item.pinned ? ' **!pinned**' : '';
    return `${item.index}. \`${item.ref}\`${pinned} ${item.summary}`;
  });
  return `${head}\n${lines.join('\n')}`;
}

// ──────────────────────────────── 指针层（第三轮：两级注入的①） ────────────────────────

/**
 * **指针层**：每轮都注入的一小块"记忆目录"（目标 30–40 token）。
 *
 * 为什么要有它（用户 2026-10-19 的架构裁决）：正文按需展开那套单独用，会变成
 * "闲聊时她眼前什么都没有"——她**不知道有东西可想起来**。指针层把"有东西"这件事
 * **永远摆在眼前**（一条几行的目录：编号 + 摘要掐头），成本几十分之一；
 * 真要哪一条，她自己用 `memory_read` 取，或者等证据门命中时正文展开。
 *
 * 选哪几条：**这一句话的 BM25 前几条**（与正文同一条打分口径），一条都没有就退回 pinned。
 * 这样 b′（"指针里出现正确条目"）才有意义：指针不是固定目录，而是"这一轮最可能用得上的那几行"。
 */
export interface RecallPointer {
  items: RecallItem[];
  tokens: number;
}

/** 指针层的预算（默认 40 token / 3 条；两者都是量级目标，不是阈值） */
export const RECALL_POINTER_BUDGET = { maxTokens: 40, topN: 3 } as const;

/** 指针行里摘要截到几个字（再长就不便宜了；8 字够认出是哪一条） */
export const RECALL_POINTER_SUMMARY_CHARS = 8;

export function renderRecallPointer(items: readonly RecallItem[]): string {
  if (items.length === 0) return '';
  const parts = items.map((item) => {
    const text = [...item.summary].slice(0, RECALL_POINTER_SUMMARY_CHARS).join('').replace(/[。，,；;、\s]+$/u, '');
    return `#${item.index} ${text}`;
  });
  return `【记忆指针】${parts.join(' · ')}`;
}

/**
 * 算这一轮的指针层。**不套相关度下限**（它的用途是"让你看见有东西"，不是"判定相关"）；
 * 一条有词重叠的都没有时退回 pinned（保底的永远在场）。
 */
export function planRecallPointer(input: {
  query: string;
  entries: readonly MemoryIndexEntry[];
  budget?: { maxTokens: number; topN: number };
  /** 已在别处展示过的条目（正文层会排除它们，避免同一行出现两次） */
  excludeRefs?: readonly string[];
  /**
   * 这一句话里**命中的词典词**（不过"上下文"那道滤网——指针层是目录，不是判定）。
   *
   * 给了它就用**直接命中**选条目：哪条索引的行文本里出现了这些词，就把它摆进指针
   * （按命中词数排）。比 BM25 准得多——整句话的 BM25 会被长尾词稀释（实测 b′ 只有 7%），
   * 而"命中词出现在某条索引里"这件事本身的比例是 42%（= b′ 的天花板）。
   * 没给就退回 BM25 前几条。
   */
  hits?: readonly string[];
  /**
   * **名字 → 条目**的反向索引查询（第四轮）：`refsOf(word)` 给这个词出现过的
   * `路径:行号` 列表（构建期从**索引行的全文**扫出来，见 {@link RecallCandidate.refs}）。
   *
   * 有它就用它——比"摘要里有这个词"准：实测 5/35 个命中词在摘要里一个字都没有，
   * 但它们在**正文行**里出现过，反向索引能把它们指出来，而且**指针的 token 不涨**。
   */
  refsOf?: (word: string) => readonly string[];
}): RecallPointer & { covered: boolean } {
  const budget = input.budget ?? RECALL_POINTER_BUDGET;
  const entries = input.entries;
  if (entries.length === 0 || input.query.trim() === '') return { items: [], tokens: 0, covered: false };
  const refOf = (entry: MemoryIndexEntry): string => `${entry.path}:${entry.line}`;
  const indexOfRef = new Map<string, number>();
  for (let i = 0; i < entries.length; i += 1) indexOfRef.set(refOf(entries[i] as MemoryIndexEntry), i);
  const exclude = new Set(input.excludeRefs ?? []);
  const toItem = (i: number, score: number): RecallItem => {
    const entry = entries[i] as MemoryIndexEntry;
    return {
      index: i + 1, ref: refOf(entry), path: entry.path, line: entry.line,
      summary: entry.summary, pinned: entry.pinned === true, score, matched: [],
    };
  };
  const picked: RecallItem[] = [];
  let covered = false;
  const hits = (input.hits ?? []).filter((word) => word !== '');
  if (hits.length > 0) {
    /**
     * 选条目：**先看反向索引**（这个名字在哪几行的正文里出现过），没有反向索引时退回
     * "摘要里出现了这个词"。两种来源合成一个 `ref → 命中词数` 的表，按命中词数排。
     */
    const votes = new Map<string, number>();
    for (const word of hits) {
      const refs = input.refsOf?.(word) ?? [];
      if (refs.length > 0) {
        for (const ref of refs) votes.set(ref, (votes.get(ref) ?? 0) + 1);
        continue;
      }
      for (const entry of entries) {
        const ref = refOf(entry);
        if (`${entry.path} ${entry.summary}`.includes(word)) votes.set(ref, (votes.get(ref) ?? 0) + 1);
      }
    }
    const ranked = [...votes.entries()]
      .map(([ref, n]) => ({ ref, n, index: indexOfRef.get(ref) ?? -1 }))
      .filter((v) => v.index >= 0 && !exclude.has(v.ref))
      .sort((a, b) => (b.n - a.n) || (a.index - b.index));
    for (const found of ranked) {
      if (picked.length >= budget.topN) break;
      picked.push(toItem(found.index, found.n));
      covered = true; // 这一条是**因为命中词**才被选中的
    }
  }
  if (picked.length === 0) {
    const corpus = buildBm25Corpus(entries.map((entry) => `${entry.path} ${entry.summary}`));
    for (const hit of scoreBm25(corpus, input.query)) {
      if (picked.length >= budget.topN) break;
      const entry = entries[hit.index];
      if (entry === undefined || exclude.has(refOf(entry))) continue;
      picked.push(toItem(hit.index, hit.score));
    }
  }
  if (picked.length === 0) {
    for (let i = 0; i < entries.length && picked.length < budget.topN; i += 1) {
      const entry = entries[i] as MemoryIndexEntry;
      if (entry.pinned !== true || exclude.has(refOf(entry))) continue;
      picked.push(toItem(i, 0));
    }
  }
  // token 硬顶：从最后一条往前砍（指针层本来就只放最相关的那几条）
  while (picked.length > 0 && estimateTokens(renderRecallPointer(picked)) > budget.maxTokens) picked.pop();
  const tokens = picked.length === 0 ? 0 : estimateTokens(renderRecallPointer(picked));
  return { items: picked, tokens, covered: covered && picked.length > 0 };
}

/**
 * **一轮的两级注入**（第三轮的主入口；测量与运行期都走这一个函数）。
 *
 *   ① 指针层：**永远**算一次（`planRecallPointer`），30–40 token 量级；
 *   ② 正文层：证据门命中才展开（`planRecallInjection`），且**排除指针里已有的条目**；
 *   ③ 状态在这两层上重新定义（2026-10-19）：
 *      · 证据门没命中 **且** 指针层也空 ⇒ `no-candidate`（**记忆里连目录都对不上 ⇒ 记忆该写**）；
 *        指针层非空 ⇒ `not-triggered`（有目录可看，只是不需要展开）；
 *      · 证据门命中但正文没有指针之外的新东西 ⇒ `no-candidate`（展开是多余的）。
 *      这样 `no-candidate` 才真的可能发生——上一轮它在真实语料里是 0 次。
 */
export function planRecallTurn(input: {
  query: string;
  gate: RecallGate;
  entries: readonly MemoryIndexEntry[];
  pointerBudget?: { maxTokens: number; topN: number };
  /** 这句话里命中的词典词（**不过上下文滤网**；指针层用它选条目） */
  rawHits?: readonly string[];
  /** 名字 → 条目 的反向索引（构建期产出；见 `RecallCandidate.refs`） */
  refsOf?: (word: string) => readonly string[];
  bodyBudget: RecallBudget;
  recencyOf?: (ref: string) => number | undefined;
}): { pointer: RecallPointer; body: RecallInjection; trace: RecallTrace } {
  const pointer = planRecallPointer({
    query: input.query,
    entries: input.entries,
    // 指针用**原始命中词**（不过上下文滤网）：目录不该因为"刚说过"就不显示
    ...(input.rawHits === undefined ? {} : { hits: input.rawHits }),
    ...(input.refsOf === undefined ? {} : { refsOf: input.refsOf }),
    ...(input.pointerBudget === undefined ? {} : { budget: input.pointerBudget }),
  });
  const pointerRefs = pointer.items.map((item) => item.ref);
  const body = planRecallInjection({
    query: input.query,
    gate: input.gate,
    entries: input.entries,
    budget: input.bodyBudget,
    pointerRefs,
    ...(input.recencyOf === undefined ? {} : { recencyOf: input.recencyOf }),
  });
  const rawHits = input.rawHits ?? [];
  let state: RecallState = body.trace.state;
  if (state === 'not-triggered') {
    /**
     * **`no-candidate` 的新定义**（第四轮，用户裁决③）：
     *   · 这一句**提到了**词典里的词（`rawHits` 非空）**但指针里一条也没指向它**
     *     ⇒ `no-candidate`：记忆里连一条关于它的条目都没有 ⇒ **记忆该写**（或索引该覆盖）；
     *   · 没提到任何词（纯闲聊）⇒ `not-triggered`；指针为空同理。
     * 上一版把它定义成"指针为空"，而指针几乎从不空 ⇒ 这个信号在真实语料里恒为 0。
     */
    state = rawHits.length > 0 && !pointer.covered ? 'no-candidate' : 'not-triggered';
  }
  if (state === 'injected' && body.items.length === 0) state = 'no-candidate';
  return {
    pointer,
    body,
    trace: {
      ...body.trace,
      state,
      pointer: pointer.items.length,
      pointerTokens: pointer.tokens,
    },
  };
}
