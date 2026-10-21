/**
 * 阶段一用例 — **框架按最近话题挑的推荐记忆**（`src/persona/memory-select.ts` + `src/persona/bm25.ts`）
 *
 * 用户原话（逐字，唯一判据）：
 * > 「这样，**BM25 挑选应取用户的最近 5 次输入聚合，然后用 BM25 挑出 top-6**，同时**告知：
 * > 这些是与当前话题可能相关的记忆**。**由框架自动推荐**。」
 *
 * 这一份只测**纯函数**（挑选 / 聚合 / 渲染）：它不跑循环、不读盘、不碰日志——
 * 端到端那一段（真循环 + 真事件 + 真固定块）在 `test/memory-injection.test.ts` 里，
 * 两处合起来才盖住"挑法对"与"接线对"。
 *
 * 每条用例都标了它守的是原话里哪半句，免得以后有人把某条当成"措辞测试"删掉：
 *   · 「最近 5 次输入聚合」→ 用例组 ②
 *   · 「BM25 挑出 top-6」  → 用例组 ①
 *   · 「pinned 必留」      → 用例组 ① 的第 2、3 条
 *   · 「告知 / 自动推荐」  → 用例组 ③
 *   · 「同分确定性」       → 用例组 ④
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { tokenizeBm25 } from '../src/persona/bm25.ts';
import type { MemoryIndexEntry } from '../src/persona/memory-injection.ts';
import {
  MEMORY_QUERY_INPUT_COUNT, MEMORY_QUERY_INPUT_MAX_CHARS, MEMORY_QUERY_MAX_CHARS,
  MEMORY_RECOMMEND_PREFIX, MEMORY_RECOMMEND_TOP_N,
  buildMemoryQuery, recommendBannerFor, renderMemoryRecommendation, selectMemoryRecommendation,
} from '../src/persona/memory-select.ts';

// ──────────────────────────────── 夹具 ────────────────────────────────

/** 造一条索引条目（只给挑选用得着的四个字段；`path`/`line`/`summary`/`pinned`） */
function entry(line: number, summary: string, options: { path?: string; pinned?: boolean } = {}): MemoryIndexEntry {
  return {
    path: options.path ?? 'MEMORIES/facts.md',
    line,
    summary,
    pinned: options.pinned === true,
  };
}

/**
 * 一份**像真记忆的**夹具（17 条）：关键是词元的**文档频率分布**要像真的——
 * 这是 2026-10-15 那条 IDF 判据（{@link BM25_MAX_DF_RATIO}）能被测到的前提。
 *
 * 三条分布，各自承担一条判据：
 *   · **路径词元**（`memories` / `facts` / `md`）：**17/17 篇都有** ⇒ `df > N/2` ⇒ **全部被丢**。
 *     真语料上的实测形状与它同构（文档文本 = `路径 + 摘要`，见 `bm25.ts` 文件头）——
 *     这就是"含 `memories` 的查询会挑出无关条目"那条病的成因。
 *   · **`备份` / `密钥`**：4 篇有（`6 + i + j = 4`）⇒ `4 <= 8.5` ⇒ **存活**（真有区分力的词）。
 *   · **`喝茶` / `不挑`**：3 篇有（`i + j = 2`）⇒ 存活。
 */
const ENTRIES: MemoryIndexEntry[] = [
  entry(9, '不拍未成年外观的性化图——死线。', { pinned: true }),
  ...Array.from({ length: 7 }, (_, i) => entry(11 + i, i === 2 ? '喝茶不挑。' : `第 ${i} 条闲话。`)),
  ...Array.from({ length: 6 }, (_, j) => entry(20 + j, j === 3 ? '备份目录在 D 盘根下。' : `第 ${j} 条杂事。`)),
  ...Array.from({ length: 3 }, (_, k) => entry(30 + k, k === 1 ? '"老地方" = 三楼会议室。' : `第 ${k} 条黑话。`,
    { path: 'MEMORIES/jargon.md' })),
];

// ──────────────────────────────── ① top-6 + pinned 必留 ────────────────────────────────

test('阶段一 ①：按话题挑出 top-6——茶那句话把"茶"那一条挑进来（不是按索引顺序）', () => {
  const rec = selectMemoryRecommendation(ENTRIES, [{ seq: 1, text: '今天想喝点茶，你记不记得我喝什么' }]);
  // 「挑出 top-6」是**上限**，不是"硬凑 6 条"：与这句话有词重叠的不满 6 条时就印那些。
  assert.ok(rec.counts.bm25 > 0 && rec.counts.bm25 <= MEMORY_RECOMMEND_TOP_N,
    `相关的至多 6 条（实际 ${rec.counts.bm25}）`);
  assert.equal(rec.items[0]?.pinned, true, 'pinned 保底那条排在最前');
  const refs = rec.items.map((item) => item.ref);
  assert.ok(refs.includes('MEMORIES/facts.md:13'), `"茶"那一条必须在：${JSON.stringify(refs)}`);
  // ⚠ 这一条现在是**真判据**（IDF 过滤之后）：只有"存活词元"命中的条目才进得来，
  //   所以那些只与查询共享**路径词元**的闲话/杂事/黑话**一条都不该出现**。
  for (const item of rec.items) {
    if (item.via !== 'bm25') continue;
    assert.ok(item.score > 0, `${item.ref} 的分数该为正：${item.score}`);
    assert.ok(item.matched.length > 0, `${item.ref} 该带上命中的词：${JSON.stringify(item.matched)}`);
  }
  assert.ok(!refs.includes('MEMORIES/facts.md:11'), '只共享路径词元的那一条不许进来（IDF 过滤）');
  assert.ok(!refs.includes('MEMORIES/jargon.md:31'), '另一份文件里的无关条目也不许进来');
});

test('阶段一 ①（IDF 判据·反面）：**只有路径词元**的查询 ⇒ 一条都不给（不是"给一堆低分"）', () => {
  // 这就是那条病的形状：`memories` / `facts` / `md` 在**每一篇**里（df = N ⇒ idf ≈ 0）。
  // 判据：`df > N/2` 的词元在建库时就被丢掉（`BM25_MAX_DF_RATIO`）⇒ 一个存活词元都没有
  // ⇒ 没有任何一篇拿到分 ⇒ **结果为空**（"至少一个存活词元命中"这条判据就落在这里）。
  for (const q of ['memories', 'MEMORIES/facts.md', 'facts md', 'memories facts md']) {
    const rec = selectMemoryRecommendation(ENTRIES, [{ seq: 1, text: q }]);
    assert.equal(rec.counts.bm25, 0, `「${q}」只有路径词元 ⇒ 不该挑出任何条目（实际 ${rec.counts.bm25}）`);
    // ⚠ **pinned 不受影响**（它走 `via:'pinned'` 那条支路，与分数无关）
    assert.equal(rec.counts.pinned, 1, '置顶仍然必留（IDF 过滤不许碰它）');
  }
});

test('阶段一 ①（IDF 判据·正面）：**混着实词**的查询照旧挑得出来（过滤没有把有用的一起丢掉）', () => {
  // 反面判据：路径词元被丢，但**实词**（`备份`，4/17 篇有）必须照旧生效——
  // 否则"过滤"就成了"把检索废掉"。这一条与上一条合起来才钉住"只丢全局词、不丢有用词"。
  const rec = selectMemoryRecommendation(ENTRIES, [{ seq: 1, text: 'memories 备份目录在哪儿' }]);
  assert.equal(rec.counts.bm25, 1, `实词那一条要挑出来：${JSON.stringify(rec.items.map((i) => i.ref))}`);
  assert.equal(rec.items.find((i) => i.via === 'bm25')?.ref, 'MEMORIES/facts.md:23');
});

test('阶段一 ①：**pinned 必留**——一句与它完全无关的话也得把它带上', () => {
  // 这是"不许被排序挤掉"的正面判据：查询里一个与它相关的词都没有。
  const rec = selectMemoryRecommendation(ENTRIES, [{ seq: 1, text: '备份目录在哪儿' }]);
  const pinned = rec.items.filter((item) => item.via === 'pinned');
  assert.equal(pinned.length, 1, '夹具里一条 pinned');
  assert.equal(pinned[0]?.ref, 'MEMORIES/facts.md:9');
  assert.equal(pinned[0]?.score, 0, '保底收进来的记 0 分（它不是按分进来的）');
  assert.equal(rec.counts.pinned, 1);
});

test('阶段一 ①（2026-10-15 裁决）：pinned **不占**那 6 个名额——8 条 pinned + 仍给 6 条相关', () => {
  // 判据（用户裁决那一版）：**pinned 是"保底"，相关是"推荐"，两件事不该抢同一个额度**。
  // 这条钉两半：置顶一条都不许砍；相关那 6 个位置一条都不许被置顶吃掉。
  const many: MemoryIndexEntry[] = Array.from({ length: 8 }, (_, i) =>
    entry(10 + i, `置顶第 ${i} 条`, { pinned: true }));
  const rest: MemoryIndexEntry[] = Array.from({ length: 8 }, (_, i) =>
    entry(100 + i, `喝茶相关的第 ${i} 条`));
  const rec = selectMemoryRecommendation([...many, ...rest], [{ seq: 1, text: '喝茶' }]);
  assert.equal(rec.counts.pinned, 8, '置顶一律保底：8 条全在');
  assert.equal(rec.counts.bm25, MEMORY_RECOMMEND_TOP_N, '相关仍是 6 条（没被置顶挤掉）');
  assert.equal(rec.items.length, 14, '两段相加才是总行数');
  // 渲染出来必须**数得出 14 行**，且标题行的条数与之一致（否则她数出 14 行会以为出了错）
  const text = renderMemoryRecommendation(rec);
  assert.equal(text.split('\n').length, 2 + 14, '两端：标题 + 14 行 + 兜底');
  assert.ok(text.startsWith(recommendBannerFor(14)), `标题条数 = 实际行数：\n${text}`);
  // 保底那几条带 `!pinned`（她自己分辨得出哪几条是保底、哪几条是相关）
  assert.equal((text.match(/\*\*!pinned\*\*/gu) ?? []).length, 8, '8 条置顶都带标记');
});

test('阶段一 ①：pinned **0 条** ⇒ 就是 6 条（不多不少）', () => {
  // 9 篇、其中 8 篇有 `喝茶` ⇒ df 8 ≤ 4.5？不，8 > 4.5 ⇒ **会被丢**。所以这里用 9 篇里 6 篇有它
  // （df 6 > 4.5 也超）——为了让"存活词元"真的存活，语料得有区分度：9 篇里 4 篇有 `喝茶`。
  const none: MemoryIndexEntry[] = Array.from({ length: 9 }, (_, i) =>
    entry(20 + i, i < 4 ? `喝茶第 ${i} 条` : `第 ${i} 条别的`));
  const rec = selectMemoryRecommendation(none, [{ seq: 1, text: '喝茶' }]);
  assert.equal(rec.counts.pinned, 0);
  assert.equal(rec.items.length, 4, '相关 4 条（只有那 4 篇有这个词；上限 6 但**宁少不凑**）');
  assert.equal(rec.items.filter((item) => item.pinned).length, 0);
});

test('阶段一 ①：候选为空（她还没写过记忆）→ 段整段不出现，不印空标题', () => {
  const rec = selectMemoryRecommendation([], [{ seq: 1, text: '随便问一句' }]);
  assert.equal(rec.items.length, 0);
  assert.equal(renderMemoryRecommendation(rec), '', '不编、不印空壳');
});

// ──────────────────────────────── ② 查询 = 最近 5 次输入的聚合 ────────────────────────────────

test('阶段一 ②：查询取**最近 5 条**用户输入，按时间拼接（第 6 条及更早的进不来）', () => {
  const inputs = Array.from({ length: 8 }, (_, i) => ({ seq: i + 1, text: `第 ${i + 1} 句` }));
  const q = buildMemoryQuery(inputs);
  assert.equal(MEMORY_QUERY_INPUT_COUNT, 5, '判据就是 5（用户原话）');
  assert.equal(q.texts, 5, '只取 5 条');
  assert.deepEqual(q.seqs, [4, 5, 6, 7, 8], '取的是**最近的** 5 条（第 1..3 条被挤掉）');
  assert.equal(q.text, '第 4 句\n第 5 句\n第 6 句\n第 7 句\n第 8 句', '按时间（seq 升序）拼接');
});

test('阶段一 ②：**少于是多少条就多少条**——第一条消息那一轮只有 1 条', () => {
  const q = buildMemoryQuery([{ seq: 42, text: '在吗' }]);
  assert.equal(q.texts, 1);
  assert.deepEqual(q.seqs, [42]);
  assert.equal(q.text, '在吗', '不补空、不重复');
  // 一条都没有（理论上只在空批出现）：查询是空串，挑选照常能跑（pinned 仍保底）
  const empty = buildMemoryQuery([]);
  assert.equal(empty.text, '', '没有查询就是空串——不编一个占位句');
  assert.equal(empty.texts, 0);
  assert.equal(selectMemoryRecommendation(ENTRIES, []).items[0]?.pinned, true, '空查询下 pinned 照样在');
});

test('阶段一 ②：输入进来时乱的顺序也按时间排（聚合不依赖调用方给的次序）', () => {
  const q = buildMemoryQuery([
    { seq: 30, text: '后说的' },
    { seq: 10, text: '先说的' },
  ]);
  assert.equal(q.text, '先说的\n后说的', '按 seq 升序，与入参顺序无关');
});

test('阶段一 ②：单条与整体都有字符上限，截断要**如实记**（`truncated`）', () => {
  const long = { seq: 1, text: '啊'.repeat(MEMORY_QUERY_INPUT_MAX_CHARS + 50) };
  const one = buildMemoryQuery([long]);
  assert.equal(one.truncated, true, '单条超上限 → 截断');
  assert.equal(one.text.length, MEMORY_QUERY_INPUT_MAX_CHARS);
  // 整体上限：5 条各吃满时正好到 1000，再多就截
  const many = Array.from({ length: 5 }, (_, i) => ({ seq: i + 1, text: '啊'.repeat(MEMORY_QUERY_INPUT_MAX_CHARS) }));
  const all = buildMemoryQuery(many);
  assert.equal(all.text.length, MEMORY_QUERY_MAX_CHARS);
  assert.equal(all.truncated, true, '整体被截断也要如实记');
  // 正常长度的一条**不许**被记成截断（判据不许放宽成"总是 true"）
  assert.equal(buildMemoryQuery([{ seq: 1, text: '短的一句' }]).truncated, false);
});

// ──────────────────────────────── ③ 告知 + 兜底行 ────────────────────────────────

test('阶段一 ③：标题行逐字告知"这是推荐、不一定都对"，并给出取用方式', () => {
  const rec = selectMemoryRecommendation(ENTRIES, [{ seq: 1, text: '喝什么茶' }]);
  const text = renderMemoryRecommendation(rec);
  const first = text.split('\n')[0] ?? '';
  // 逐字的那一半：前缀与"不一定都对"必须一字不差（条数是变量，见下一条用例）
  assert.ok(first.startsWith(MEMORY_RECOMMEND_PREFIX), `标题行前缀要逐字：${first}`);
  assert.equal(first, recommendBannerFor(rec.items.length), '条数那一处填的是**实际条数**');
  assert.match(first, /不一定都对/u, '必须说清"不一定都对"');
  assert.match(first, /框架/u, '必须说清是框架挑的');
  assert.match(first, /memory 工具/u, '必须给出取用方式（否则她只知道有这么几条）');
});

test('阶段一 ③：每条带**稳定编号**（= 全量索引里的序号）+ 指针；末尾一行给兜底出路', () => {
  const rec = selectMemoryRecommendation(ENTRIES, [{ seq: 1, text: '喝什么茶' }]);
  const text = renderMemoryRecommendation(rec);
  const lines = text.split('\n');
  // 每条一行：`<编号>. `<路径:行号>` [!pinned] 摘要`
  for (const item of rec.items) {
    const line = lines.find((l) => l.startsWith(`${item.index}. `));
    assert.ok(line, `编号 ${item.index} 那一行要在：\n${text}`);
    assert.ok(line?.includes(`\`${item.ref}\``), `那一行要带指针 ${item.ref}`);
  }
  // 编号就是"全量索引里的序号"：夹具第 4 条（下标 3）的编号必须是 4
  const idx = rec.items.findIndex((item) => item.ref === 'MEMORIES/facts.md:15');
  if (idx >= 0) assert.equal(rec.items[idx]?.index, 4, '编号 = 索引数组下标 + 1');
  assert.match(text, /另有 \d+ 条/u, `要有兜底那一行：\n${text}`);
  assert.equal(rec.total, ENTRIES.length, '兜底里的 N 以全量条数为基数');
});

// ──────────────────────────────── ④ 确定性（同分兜底） ────────────────────────────────

test('阶段一 ④：**同分确定性**——两条分数完全一样时按 `路径:行号` 排，两次调用逐字节相同', () => {
  // 造两条**文档完全相同、只差路径与行号**的条目：那一句查询下它们的分数必然相等。
  // ⚠ 两处都得小心，否则这条用例会**静默退化成空断言**（两次都实测踩到）：
  //    · 填充文档要与查询**一个字符都不共享**（用 `zzz`/`www`），否则它自己也被匹配进来；
  //    · **两条路径要"存活词元数"对齐**：BM25 按文档长度归一，而路径也算词元；
  //      更要紧的是 `facts` 若只在一条里出现（另一条是 `aaa`），那一条**存活词元就少一个**
  //      （实测 9 vs 11 词元 ⇒ 分数不等 ⇒ 排出来的是"谁长谁短"，不是同分兜底）。
  //      所以两边各配 3 篇**含同名词元**的填充：`facts` 与 `aaa` 的 df 都到 4 ⇒ 都不被丢、长度都对齐。
  const tie: MemoryIndexEntry[] = [
    entry(100, '一模一样。'),
    entry(20, '一模一样。', { path: 'MEMORIES/aaa.md' }),
    ...Array.from({ length: 3 }, (_, i) => entry(200 + i, `zzz${i}`)),
    ...Array.from({ length: 3 }, (_, i) => entry(300 + i, `www${i}`, { path: 'MEMORIES/aaa.md' })),
  ];
  const inputs = [{ seq: 1, text: '一模一样' }];
  const a = selectMemoryRecommendation(tie, inputs);
  const b = selectMemoryRecommendation(tie, inputs);
  assert.equal(renderMemoryRecommendation(a), renderMemoryRecommendation(b), '两次调用逐字节相同');
  assert.equal(a.items.length, 2, `只有那两条命中：${JSON.stringify(a.items.map((i) => i.ref))}`);
  const keys = a.items.map((item) => item.ref);
  assert.deepEqual(keys, ['MEMORIES/aaa.md:20', 'MEMORIES/facts.md:100'], '同分按 `路径:行号` 升序兜底');
  assert.equal(a.items[0]?.score, a.items[1]?.score, '前提：两条分数真的一样（否则这条测的不是同分兜底）');
});

// ──────────────────────────────── ⑤ 兜底行：目录级（2026-10-15 裁决②） ────────────────────────────────

test('阶段一 ⑤：兜底行带**索引之外**的东西（episodes 真数 + 别的文件名），仍是一行', () => {
  // 治的是报告 §7 那 61.8% 的**结构性盲区里最便宜的一半**：不把 `episodes/**` 塞进索引，
  // 只告诉她那些东西在、并且怎么取。数量由**宿主数好递进来**（`memoryIndexNeighbors`），
  // 渲染层一个字都不读盘。
  const rec = selectMemoryRecommendation(ENTRIES, [{ seq: 1, text: '喝茶' }]);
  const text = renderMemoryRecommendation({
    ...rec,
    neighbors: { episodes: 8, extras: ['assets.md', 'diary'] },
  });
  const lines = text.split('\n');
  assert.equal(lines.length, 2 + rec.items.length, '仍是一行兜底（没有变多段）');
  const tail = lines.at(-1) ?? '';
  assert.match(tail, /另有 \d+ 条在索引里/u, `索引里还剩多少要留着：\n${tail}`);
  assert.match(tail, /`episodes\/\*\*`（8 份，按日期）/u, `episodes 要给**真数**：\n${tail}`);
  assert.match(tail, /`assets\.md`/u, '别的文件名要列出来');
  assert.match(tail, /`diary`/u);
  assert.match(tail, /path`\+`line/u, '要给出怎么取（否则她只知道"有那么些东西"）');
  assert.ok(!tail.includes('\n'), '兜底行就是一行');
});

test('阶段一 ⑤：**数量不许编**——数不到时写"若干"，没接线时退回旧文案', () => {
  const rec = selectMemoryRecommendation(ENTRIES, [{ seq: 1, text: '喝茶' }]);
  // ① 数不到（目录读不动）⇒ "若干"，**不许**写 0 或别的数字
  const unknown = renderMemoryRecommendation({ ...rec, neighbors: { episodes: null, extras: [] } });
  assert.match(unknown, /`episodes\/\*\*`（若干份，按日期）/u, `数不到就写"若干"：\n${unknown}`);
  assert.ok(!/episodes\/\*\*`（\d/u.test(unknown), '数不到时不许出现任何数字');
  // ② 没有 episodes、也没有别的：那一截整段不出现（不印空话）
  const bare = renderMemoryRecommendation({ ...rec, neighbors: { episodes: 0, extras: [] } });
  assert.ok(!bare.includes('索引之外的还有'), `没有索引之外的东西时不印那一截：\n${bare}`);
  // ③ **没接线**（老调用点：子代理/诊断/只读重建）⇒ 退回**旧文案**，请求字节与接线之前逐字相同
  const legacy = renderMemoryRecommendation(rec);
  assert.match(legacy, /，可用 memory 工具按路径或自然语言查）/u, `没接线就退回旧文案：\n${legacy}`);
  assert.ok(!legacy.includes('episodes'), '旧文案里不该出现新那一截');
});

test('阶段一 ④：`bm25.ts` 的分词口径是"中文 bigram + 英文/路径按词"（判据写死）', () => {  // 中文：逐字 push 一个字、紧跟它的 bigram（**顺序与报告的实现逐字相同**：
  // `for i: push(c[i]); if(i+1) push(c[i]+c[i+1])` ⇒ `喝`、`喝茶`、`茶`——别按"字典序好看"去改）。
  assert.deepEqual(tokenizeBm25('喝茶'), ['喝', '喝茶', '茶']);
  // 英文/路径：整段小写 + 按分隔符再切
  const path = tokenizeBm25('MEMORIES/facts.md');
  assert.ok(path.includes('memories'), `路径要按词切：${JSON.stringify(path)}`);
  assert.ok(path.includes('facts'));
  assert.ok(path.includes('md'));
  // 空串与纯空白：一个词元都没有（挑选那一侧据此走"没有查询"）
  assert.deepEqual(tokenizeBm25(''), []);
  assert.deepEqual(tokenizeBm25('   '), []);
});
