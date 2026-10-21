/**
 * 单位与口径格式测试 — src/format/units.ts
 *
 * 立这份测试的那条意见（用户 2026-10-05，逐字）：
 *   > 「时机合适时单位换为M」——运行情况页写 2705.9k，日志页写 2.7M，
 *   > **同一时刻同一个数两种写法**。
 *
 * 所以这份测试钉两件事：
 *   ① **换档边界**（999.9k / 1000k / 1.05M / 10M / 1G 以及它们的临界点）——边界写错时
 *      屏幕上是 `1000.0k` 这种读不出量级的写法，而任何别的测试都不会因此变红；
 *   ② **同一个数只有一个写法**——同一个值走 `formatCompact` / `tokenPhrase` / CLI 的
 *      `formatBudget` / 服务端的字符串，出现在哪一页都是同一串字符。这一条是那个 bug 的
 *      直接回归：过去运行情况页与日志页各写各的三目表达式，2705946 于是成了两种写法。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { formatCompact, formatExact, formatWithExact, tokenPhrase } from '../src/format/units.ts';

// ──────────────────────────────── ① 换档边界 ────────────────────────────────

test('换档：小于 1000 原样整数，1000 起换 k，100 万起换 M，10 亿起换 G', () => {
  assert.equal(formatCompact(0), '0');
  assert.equal(formatCompact(1), '1');
  assert.equal(formatCompact(999), '999');
  assert.equal(formatCompact(1000), '1.0k', '一位数时那一位是有效数字：1.0k 不能被省成 1k');
  assert.equal(formatCompact(1500), '1.5k');
  assert.equal(formatCompact(999_949), '999.9k', '999.9k 是这一档的顶——它四舍五入不到 1000.0');
  assert.equal(formatCompact(999_950), '1.0M', '先舍入再换档：999.95k 印成 1000.0k 就读不出量级了');
  assert.equal(formatCompact(1_000_000), '1.0M', '用户举的例：1000k 那一档到这里结束');
  assert.equal(formatCompact(1_050_000), '1.1M', '1.05M 保留 1 位小数、四舍五入');
  assert.equal(formatCompact(2_705_946), '2.7M', '现场那个数：2705.9k 与 2.7M 从此是同一个写法');
  assert.equal(formatCompact(10_000_000), '10M', '整数部分到两位数就不带小数：10M 比 10.0M 干净');
  assert.equal(formatCompact(105_000_000), '105M');
  assert.equal(formatCompact(999_949_999), '999.9M');
  assert.equal(formatCompact(999_950_000), '1.0G');
  assert.equal(formatCompact(1_000_000_000), '1.0G', '用户举的例：1G');
  assert.equal(formatCompact(1_500_000_000), '1.5G');
});

test('换档：负数与坏数照实印（不悄悄折成 0）', () => {
  assert.equal(formatCompact(-1500), '-1.5k');
  assert.equal(formatCompact(-999), '-999');
  assert.equal(formatCompact(Number.NaN), 'NaN');
  assert.equal(formatCompact(Number.POSITIVE_INFINITY), 'Infinity');
});

test('精确值：千分位，且**永不四舍五入到别处**（对账要的是真数）', () => {
  assert.equal(formatExact(2_705_946), '2,705,946');
  assert.equal(formatExact(700), '700');
  assert.equal(formatExact(1_000_000_000), '1,000,000,000');
});

test('紧凑写法旁边永远有真数：formatWithExact 的两截', () => {
  assert.equal(formatWithExact(2_705_946), '2.7M（2,705,946）');
  // 同一个写法不重复印两遍（700 的紧凑写法与真数同形）
  assert.equal(formatWithExact(700), '700');
  assert.equal(tokenPhrase(6_400_000), '6.4M（6,400,000） 非缓存 token');
});

// ──────────────────────────────── ② 一个数只有一个写法 ────────────────────────────────

test('同一个数在不同入口格式化结果一致（服务端 tokenPhrase 与 formatCompact 同源）', () => {
  const samples = [0, 999, 1_000, 999_949, 999_950, 1_000_000, 1_050_000, 2_705_946, 10_000_000, 1_000_000_000];
  for (const value of samples) {
    const compact = formatCompact(value);
    // 服务端/CLI 拼句子时只在紧凑写法后面缀口径词或括号，**绝不再自己算一遍**
    assert.ok(tokenPhrase(value).startsWith(compact), `${value} → ${tokenPhrase(value)} 不以 ${compact} 开头`);
    assert.ok(formatWithExact(value).startsWith(compact));
  }
});

test('口径词由调用点给，不由格式化函数猜（同一批数字可以印成"非缓存 token"或别的单位）', () => {
  assert.equal(tokenPhrase(1_500_000, 'token'), '1.5M（1,500,000） token');
});
