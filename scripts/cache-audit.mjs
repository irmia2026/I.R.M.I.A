/**
 * 缓存审计 — 把「人格/记忆变更」与「缓存命中」对齐看。
 *
 * 核心判据（render v4 的布局决定）：
 *   • **前缀级资产**：IDENTITY / CONSTITUTION / STYLE → 进 `instructions` 头部。
 *     改一个字节 = 整个请求从头失配（instructions 是最大公共前缀）。
 *   • **尾部级资产**：STATE.md / RELATIONSHIPS/*.md → 进此刻层（input 尾部）。
 *     改多少都不碰前缀，代价≈0。
 *   • personaHash 是**四份文件的组合哈希**，它包含 STATE，所以「hash 变了」不等于
 *     「缓存被破坏」——本脚本按文件分别归因，不看 hash。
 *
 * 用法：node scripts/cache-audit.mjs [data/events]
 */
import { readdirSync, readFileSync } from 'node:fs';

const PREFIX_FILES = new Set(['IDENTITY.md', 'CONSTITUTION.md', 'STYLE.md']);

const dir = process.argv[2] ?? 'data/events';
const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
const events = [];
for (const f of files) {
  for (const line of readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* 坏行跳过 */
    }
  }
}
events.sort((a, b) => a.seq - b.seq);

const updates = events.filter((e) => e.type === 'persona/updated');
const steps = events.filter((e) => e.type === 'step/start');
const budgets = events.filter((e) => e.type === 'budget/consumed');
const compactions = events.filter((e) => e.type === 'compaction/summary');

const pct = (hit, input) => (input > 0 ? Math.round((hit / input) * 100) : 0);
const fmt = (b) => `hit ${b.data.cacheHitTokens}/${b.data.inputTokens} (${pct(b.data.cacheHitTokens, b.data.inputTokens)}%)`;

console.log(`事件 ${events.length} 条 · seq ${events[0]?.seq}→${events.at(-1)?.seq} · 分片 ${files.length}`);
console.log(`step ${steps.length} · 请求 ${budgets.length} · persona/updated ${updates.length} · 压缩 ${compactions.length}`);

// ── ① 变更按影响面分级 ──
console.log('\n── ① 人格变更按影响面分级 ──');
const prefixUpdates = updates.filter((e) => PREFIX_FILES.has(e.data.file));
const tailUpdates = updates.filter((e) => !PREFIX_FILES.has(e.data.file));
console.log(`  【前缀级】改一次全 miss：${prefixUpdates.length} 次`);
for (const e of prefixUpdates) console.log(`     seq ${e.seq} @ ${e.ts}  ${e.data.file}（by ${e.data.by}）`);
console.log(`  【尾部级】不碰前缀：${tailUpdates.length} 次`);
const tailByFile = new Map();
for (const e of tailUpdates) tailByFile.set(e.data.file, (tailByFile.get(e.data.file) ?? 0) + 1);
for (const [f, n] of tailByFile) console.log(`     ${n} × ${f}`);

// ── ② 每次「前缀级」变更的实测代价 ──
console.log('\n── ② 前缀级变更的实测代价（变更点前后的请求）──');
for (const u of prefixUpdates) {
  const near = budgets.filter((b) => Math.abs(b.seq - u.seq) < 300).sort((a, b) => a.seq - b.seq);
  const after = near.filter((b) => b.seq > u.seq).slice(0, 3);
  const before = near.filter((b) => b.seq < u.seq).slice(-2);
  console.log(`  ${u.data.file} @ seq ${u.seq}`);
  for (const b of before) console.log(`     改前 seq ${b.seq}: ${fmt(b)}`);
  for (const b of after) console.log(`     改后 seq ${b.seq}: ${fmt(b)}  ← ${pct(b.data.cacheHitTokens, b.data.inputTokens) < 40 ? '全 miss 或接近' : '已恢复'}`);
}

// ── ③ 尾部级变更是否真的没代价（对照组）──
console.log('\n── ③ 尾部级变更点附近的命中（应与普通轮次无异）──');
const sampleTails = tailUpdates.slice(-4);
for (const u of sampleTails) {
  const after = budgets.filter((b) => b.seq > u.seq).slice(0, 2);
  console.log(`  ${u.data.file} @ seq ${u.seq}: ${after.map((b) => `#${b.seq} ${pct(b.data.cacheHitTokens, b.data.inputTokens)}%`).join('  ')}`);
}

// ── ④ 压缩（另一类前缀杀手）──
console.log('\n── ④ 压缩对命中的影响 ──');
for (const c of compactions.slice(-4)) {
  const after = budgets.filter((b) => b.seq > c.seq).slice(0, 3);
  console.log(`  压缩 @ seq ${c.seq}（覆盖至 ${c.data.coveredUpToSeq}）: ${after.map((b) => `#${b.seq} ${pct(b.data.cacheHitTokens, b.data.inputTokens)}%`).join('  ')}`);
}

// ── ⑤ 整体盘子 ──
console.log('\n── ⑤ 整体 ──');
const sumIn = budgets.reduce((s, b) => s + b.data.inputTokens, 0);
const sumHit = budgets.reduce((s, b) => s + b.data.cacheHitTokens, 0);
console.log(`  输入 token 合计 ${sumIn} · 命中 ${sumHit}（${pct(sumHit, sumIn)}%）`);

const rates = budgets.map((b) => pct(b.data.cacheHitTokens, b.data.inputTokens)).sort((a, b) => a - b);
const q = (p) => rates[Math.min(rates.length - 1, Math.floor(rates.length * p))];
console.log(`  单次命中率：最低 ${rates[0]}% · 25分位 ${q(0.25)}% · 中位 ${q(0.5)}% · 75分位 ${q(0.75)}% · 最高 ${rates.at(-1)}%`);
const poor = budgets.filter((b) => pct(b.data.cacheHitTokens, b.data.inputTokens) < 30);
console.log(`  命中 <30% 的请求：${poor.length} 次（占 ${Math.round((poor.length / Math.max(budgets.length, 1)) * 100)}%）`);
for (const b of poor.slice(-8)) {
  console.log(`     seq ${b.seq} @ ${b.ts}  in ${b.data.inputTokens}  ${pct(b.data.cacheHitTokens, b.data.inputTokens)}%`);
}

// ── ⑥ 最近的健康度 ──
console.log('\n── ⑥ 最近 12 次请求 ──');
for (const b of budgets.slice(-12)) {
  const d = b.data;
  console.log(`  seq ${String(b.seq).padStart(5)}  in ${String(d.inputTokens).padStart(6)}  hit ${String(d.cacheHitTokens).padStart(6)}  ${String(pct(d.cacheHitTokens, d.inputTokens)).padStart(3)}%`);
}
