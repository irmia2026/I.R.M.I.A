/**
 * `persona/recall.ts` 的聚焦用例（阶段二：私有词典 + 最长匹配 + 四态）。
 *
 * ⚠ **夹具里不许出现真实人名/人格名**（`tools/sanitize-audit.mjs` 的口径：`test/` 在发布范围里）：
 * 这一份全用 `阿甲` / `小乙` / `Alice` 这类明显的假名，且**不依赖任何真实数据目录**。
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  buildRecallMatcher, gateRecall, isStale, matchRecall, parseRecallDictionary,
  planRecallInjection, promoteRecallWords, recallDictionaryJsonl, recallThresholds,
  renderRecallSegment,
} from '../src/persona/recall.ts';
import type { MemoryIndexEntry } from '../src/persona/memory-injection.ts';
import type { RecallCandidate } from '../src/persona/recall.ts';

// ──────────────────────────────── 夹具 ────────────────────────────────

const cand = (word: string, over: Partial<RecallCandidate> = {}): RecallCandidate => ({
  word,
  count: 5,
  pmi: 9,
  minEntropy: 2,
  distinctDays: 3,
  firstSeen: '2026-10-01T00:00:00.000Z',
  lastSeen: '2026-10-03T00:00:00.000Z',
  // 默认带"证据加权 9 分、其中 1 条强线索"：2026-10-19 第三轮起晋升看 `evidenceWeight`（≥4），
  // 一票通过看 `evidenceStrong ≥ 1 && weight ≥ 10`；PMI 已降级为辅助分。
  evidence: 3,
  evidenceKinds: 2,
  evidenceWeight: 9,
  evidenceStrong: 1,
  ...over,
});

const ENTRIES: MemoryIndexEntry[] = [
  { path: 'MEMORIES/facts.md', line: 10, summary: '阿甲是测试群里的常客', pinned: true },
  { path: 'MEMORIES/facts.md', line: 12, summary: '小乙 喜欢在夜里写代码', pinned: false },
  { path: 'MEMORIES/facts.md', line: 20, summary: 'Alice 负责文档，很少露面', pinned: false },
  { path: 'MEMORIES/facts.md', line: 30, summary: '备份目录在 D 盘根下', pinned: false },
];

// ──────────────────────────────── 最长匹配 ────────────────────────────────

test('最长匹配：CJK 取最长、命中不重叠', () => {
  const m = buildRecallMatcher(['阿甲', '阿甲庄园', '小乙']);
  const hits = matchRecall('阿甲庄园今天没人', m);
  assert.deepEqual(hits.map((h) => h.word), ['阿甲庄园'], '最长优先，不是先命中的那个');
  const two = matchRecall('阿甲和小乙都在', m);
  assert.deepEqual(two.map((h) => h.word), ['阿甲', '小乙']);
  assert.equal(two[0]?.end, 2, '命中区间是码位下标');
});

test('最长匹配：拉丁词大小写不敏感、数字前缀名能命中', () => {
  const m = buildRecallMatcher(['alice', '1号']);
  assert.deepEqual(matchRecall('ALICE 来了', m).map((h) => h.word), ['alice']);
  assert.deepEqual(matchRecall('Alice 来了', m).map((h) => h.word), ['alice']);
  assert.deepEqual(matchRecall('1号在吗', m).map((h) => h.word), ['1号']);
});

test('最长匹配：空词典一个都不命中（冷启动不抛错）', () => {
  const m = buildRecallMatcher([]);
  assert.equal(m.size, 0);
  assert.deepEqual(matchRecall('阿甲和小乙', m), []);
});

test('最长匹配：纯函数（同输入同输出）', () => {
  const m1 = buildRecallMatcher(['阿甲', '小乙']);
  const m2 = buildRecallMatcher(['小乙', '阿甲']);
  assert.deepEqual(matchRecall('阿甲找小乙', m1), matchRecall('阿甲找小乙', m2), '词表顺序不影响匹配');
});

// ──────────────────────────────── 触发门（要不要回忆） ────────────────────────────────

test('触发门：三种未触发理由分得开', () => {
  const empty = buildRecallMatcher([]);
  assert.equal(gateRecall('阿甲', empty).reason, 'dictionary-empty');

  const m = buildRecallMatcher(['阿甲']);
  assert.equal(gateRecall('今天天气不错', m).reason, 'no-hit');
  // 命中的词刚刚在上下文里出现过 ⇒ 已经在眼前，不必再回忆
  const inCtx = gateRecall('阿甲呢', m, '刚才阿甲说过话');
  assert.equal(inCtx.triggered, false);
  assert.equal(inCtx.reason, 'in-context');
});

test('触发门：命中且不在上下文里 ⇒ 触发，hits 是命中的词', () => {
  const m = buildRecallMatcher(['阿甲', '小乙']);
  const gate = gateRecall('小乙昨天说的那个方案', m, '阿甲：早');
  assert.equal(gate.triggered, true);
  assert.deepEqual(gate.hits, ['小乙']);
  assert.equal(gate.reason, undefined);
});

// ──────────────────────────────── 晋升 / 淘汰（全部是相对量） ────────────────────────────────

test('晋升：分位门槛是本安装自己的读数，池子空 ⇒ 全 NaN ⇒ 空词典', () => {
  const th = recallThresholds([], { pmi: 0.9, entropy: 0.8, countMin: 0.5, countMax: 0.995, daysMax: 0.9 });
  assert.ok(Number.isNaN(th.pmi) && Number.isNaN(th.entropy));
  assert.equal(promoteRecallWords([], th).length, 0, '冷启动 = 空词典，不是错误');

  const pool = [cand('阿甲', { count: 2, pmi: 9, minEntropy: 1 }), cand('小乙', { count: 8, pmi: 12, minEntropy: 3 })];
  const th2 = recallThresholds(pool, { pmi: 0.9, entropy: 0.8, countMin: 0, countMax: 0.995, daysMax: 0.9 });
  assert.ok(th2.countMax > 2 && th2.countMax < 8, '上界是池子自己的分位（线性插值），不是写死的数');
  assert.ok(th2.pmi >= 9, 'PMI 门槛也来自池子（这里只有两条，插值落在中间）');
});

test('晋升：⭐ 命名位置证据（加权分）是硬门，PMI 不再是硬门', () => {
  const th = recallThresholds([cand('阿甲')], { pmi: 0, entropy: 0, countMin: 0, countMax: 1, daysMax: 1 });
  // 没有证据 / 证据不够（加权 <4）⇒ 进不了词典
  assert.equal(promoteRecallWords([cand('没被命名过', { evidenceWeight: 0, evidenceStrong: 0 })], th).length, 0);
  assert.equal(promoteRecallWords([cand('弱证据', { evidenceWeight: 2, evidenceStrong: 0 })], th).length, 0);
  // 加权 9 分但**没有强线索**：要过统计门（这里 count 99 远高于池子的 countMax）——一票通过不算
  assert.equal(promoteRecallWords([cand('只有弱线索', { evidenceWeight: 9, evidenceStrong: 0, count: 99 })], th).length, 0);
  // 有强线索 + 权重 ≥10 ⇒ **一票通过**，连统计门都不看
  const oneVote = promoteRecallWords([cand('被强命名过', { evidenceWeight: 10, evidenceStrong: 1, pmi: 1 })], th);
  assert.equal(oneVote.length, 1, '高权重一票通过');
});

test('晋升：跨 ≥2 天、出现 ≥2 次仍是语义下限；淘汰按 lastSeen', () => {
  const th = recallThresholds([cand('阿甲')], { pmi: 0, entropy: 0, countMin: 0, countMax: 1, daysMax: 1 });
  assert.equal(promoteRecallWords([cand('只出现一次', { count: 1 })], th).length, 0);
  assert.equal(promoteRecallWords([cand('只在一天', { distinctDays: 1 })], th).length, 0);
  const ok = promoteRecallWords([cand('阿甲')], th);
  assert.deepEqual(ok.map((c) => c.word), ['阿甲'], '过门');

  // 淘汰：90 天没再出现 ⇒ 降级（不进词典）
  assert.equal(isStale(cand('老词', { lastSeen: '2026-01-01T00:00:00.000Z' }), '2026-10-19T00:00:00.000Z'), true);
  assert.equal(isStale(cand('新词', { lastSeen: '2026-10-18T00:00:00.000Z' }), '2026-10-19T00:00:00.000Z'), false);
  const evicted = promoteRecallWords([cand('老词', { lastSeen: '2026-01-01T00:00:00.000Z' })], th, {
    now: '2026-10-19T00:00:00.000Z',
  });
  assert.equal(evicted.length, 0, '淘汰生效：词典有进有出');
});

test('晋升：count 是**双向门**（太低不算词、太高是通用词）', () => {
  const pool = [
    cand('罕见名', { count: 3 }),
    cand('通用词', { count: 900 }),
  ];
  const th = recallThresholds(pool, { pmi: 0, entropy: 0, countMin: 0, countMax: 0.5, daysMax: 1 });
  const words = promoteRecallWords(pool, th).map((c) => c.word);
  assert.ok(words.includes('罕见名'), '低频的那个能进');
  assert.ok(!words.includes('通用词'), '高频的那个被上界挡掉');
});

// ──────────────────────────────── 词典文件（JSONL） ────────────────────────────────

test('词典：写出再读回来是同一个词表；坏行跳过、空文件合法', () => {
  const words = [cand('阿甲'), cand('alice', { pmi: null })];
  const text = recallDictionaryJsonl(words, { kind: (w) => (w === 'alice' ? 'latin' : 'cjk') });
  const back = parseRecallDictionary(text);
  assert.deepEqual(back.map((c) => c.word), ['阿甲', 'alice']);
  assert.equal(back[1]?.pmi, null, '拉丁整词没有凝聚度这一格');
  assert.deepEqual(parseRecallDictionary(''), []);
  assert.deepEqual(parseRecallDictionary('{坏行\n\n').map((c) => c.word), [], '坏行跳过，不抛');
});

// ──────────────────────────────── 注入：四态 + 预算截断 ────────────────────────────────

const matcher = buildRecallMatcher(['阿甲', '小乙', 'Alice']);

test('四态：未触发 ⇒ 一个字都不注入，且记 reason', () => {
  const gate = gateRecall('今天天气不错', matcher);
  const plan = planRecallInjection({ query: '今天天气不错', gate, entries: ENTRIES, budget: { maxItems: 6, maxTokens: 400 } });
  assert.equal(plan.trace.state, 'not-triggered');
  assert.equal(plan.trace.tokens, 0);
  assert.deepEqual(plan.items, []);
  assert.equal(renderRecallSegment(gate.hits, plan.items), '', '不注空壳');
});

test('四态：触发但记忆里没有一条相关的 ⇒ no-candidate（记忆该写）', () => {
  const gate = gateRecall('阿甲', matcher);
  const plan = planRecallInjection({
    query: '阿甲', gate, entries: [ENTRIES[3] as MemoryIndexEntry], budget: { maxItems: 6, maxTokens: 400 },
  });
  assert.equal(plan.trace.state, 'no-candidate');
  assert.deepEqual(plan.items, []);
  assert.equal(plan.trace.candidates, 0);
});

test('四态：正常注入 ⇒ injected，带 token 与条数', () => {
  const gate = gateRecall('阿甲 小乙', matcher);
  const plan = planRecallInjection({ query: '阿甲 小乙', gate, entries: ENTRIES, budget: { maxItems: 6, maxTokens: 400 } });
  assert.equal(plan.trace.state, 'injected');
  assert.ok(plan.trace.tokens > 0);
  assert.ok(plan.items.length >= 2, 'pinned 与命中的都在');
  assert.ok(plan.trace.candidates >= plan.items.length);
  const text = renderRecallSegment(gate.hits, plan.items);
  assert.ok(text.startsWith('【想起来的记忆】'), '措辞与推荐段不同：这是"你提到了…"的召回段');
  assert.ok(text.includes('@'.repeat(0))); // 保住断言链（下面那几条才是判据）
  assert.ok(text.includes('MEMORIES/facts.md:10'), '行形态与索引行同构：编号 + 指针 + 摘要');
});

test('四态：相对相关度下限让"触发但无候选"真的出现', () => {
  // 20 条摘要里 8 条写着"备份"：够多，但**不是**稀有词（idf 很低）
  const common: MemoryIndexEntry[] = Array.from({ length: 20 }, (_, i) => ({
    path: 'MEMORIES/facts.md', line: 100 + i,
    summary: i < 8 ? `备份目录 ${i} 的说明` : `文档条目 ${i} 的说明`,
    pinned: false,
  }));
  const m = buildRecallMatcher(['备份']);
  const gate = gateRecall('备份', m);
  assert.equal(gate.triggered, true, '先确保触发这一层是过的');
  const noFloor = planRecallInjection({ query: '备份', gate, entries: common, budget: { maxItems: 6, maxTokens: 400 } });
  const withFloor = planRecallInjection({
    query: '备份', gate, entries: common,
    budget: { maxItems: 6, maxTokens: 400, minIdfQuantile: 0.9 },
  });
  assert.notEqual(noFloor.trace.state, 'no-candidate', '不设下限时总能找到"相关"的');
  assert.equal(withFloor.trace.state, 'no-candidate', '只命中大众词 ⇒ 算"记忆该写"，不算相关');
  assert.equal(withFloor.trace.candidates, 0);
  assert.equal(withFloor.trace.injected, 0);
});

test('四态：条数上限只是 top-K（记 injected，不算截断），pinned 永不砍', () => {
  const gate = gateRecall('阿甲 小乙 Alice 备份', matcher);
  const full = planRecallInjection({ query: '阿甲 小乙 Alice 备份', gate, entries: ENTRIES, budget: { maxItems: 6, maxTokens: 10_000 } });
  const cut = planRecallInjection({ query: '阿甲 小乙 Alice 备份', gate, entries: ENTRIES, budget: { maxItems: 1, maxTokens: 10_000 } });
  assert.equal(cut.trace.state, 'injected', '只按条数收窄不是"被预算截断"');
  assert.ok(cut.items.length < full.items.length);
  assert.ok(cut.trace.candidates > cut.trace.injected, '相关几条 / 推了几条 由这两个数分开回答');
  assert.ok(cut.items.some((item) => item.pinned), 'pinned 保底那条不会被条数上限挤掉');
});

test('四态：token 硬顶也会触发截断（先砍低分）', () => {
  const gate = gateRecall('阿甲 小乙 Alice 备份', matcher);
  const tight = planRecallInjection({ query: '阿甲 小乙 Alice 备份', gate, entries: ENTRIES, budget: { maxItems: 6, maxTokens: 40 } });
  assert.equal(tight.trace.state, 'truncated');
  assert.ok(tight.trace.tokens <= 40 || tight.items.every((item) => item.pinned), '要么压进硬顶，要么只剩 pinned');
});

test('确定性：同输入两次调用逐字节相同', () => {
  const gate = gateRecall('阿甲 小乙', matcher);
  const a = planRecallInjection({ query: '阿甲 小乙', gate, entries: ENTRIES, budget: { maxItems: 6, maxTokens: 400 } });
  const b = planRecallInjection({ query: '阿甲 小乙', gate, entries: ENTRIES, budget: { maxItems: 6, maxTokens: 400 } });
  assert.equal(renderRecallSegment(gate.hits, a.items), renderRecallSegment(gate.hits, b.items));
  assert.deepEqual(a.trace, b.trace);
});
