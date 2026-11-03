/**
 * turn 边界钩子的**行为回归**（B2，2026-10-26 与作者一起确认的那条修正）。
 *
 * 病：源分支写的是 `onTurnBoundary: async () => { await circuitBreaker?.drain(); }`。
 * `drain()` 会 `flushApply()`（把隔离/恢复落到组合面与 MCP 池）+ 对"隔离到期"的插件跑
 * **网络探针**（预算 15s、硬顶 30s）。而它出现在 `tickOnce` 收尾的 `finally` 里，下一批输入
 * 又要等这一拍结束才被认领 ⇒ 一次探活能把下一轮对话挡住十几秒。
 *
 * 修法：踢一脚就走（`pluginTurnBoundary`，实现在 `src/main.ts`），**不**把那个 promise
 * 交回去等。判据就是这两条：
 *   · 边界调用在 drain 还没收场时就返回了（下面第 1 例，确定性的：drain 由我们手动放行）；
 *   · 装配点真的走的是这条实现（第 4 例：源码级断言，防止有人把 `await drain()` 写回去）。
 *
 * 为什么不在 `RealLoop` 上整拍验：那要跑一次真 turn（模型替身 + 一整批事件），而这条判据
 * 与 turn 内容无关——它只问"钩子返回得快不快"。钩子本身是 `main.ts` 里**唯一**的一份实现，
 * 所以直接验它就是验装配点。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { pluginTurnBoundary } from '../src/main.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 一个"慢 drain"：返回的 promise 只有调用 release 才收场（不给超时，全靠手动放行）。 */
function slowDrain(): { drain: () => Promise<void>; release: () => void; calls: () => number } {
  let release: (() => void) | undefined;
  let calls = 0;
  return {
    drain: () => {
      calls += 1;
      return new Promise<void>((resolve) => { release = resolve; });
    },
    release: () => { release?.(); },
    calls: () => calls,
  };
}

test('插件：turn 边界踢一脚就走——drain 还没收场，边界已经返回', async () => {
  const breaker = slowDrain();
  const boundary = pluginTurnBoundary(() => breaker);

  // 手工放行之前，这一次调用必须已经 resolve（否则下面这行会永远挂着 ⇒ 测试超时即红）
  await boundary();
  assert.equal(breaker.calls(), 1, 'drain 被踢了一次（不是没调）');

  breaker.release();
});

test('插件：turn 边界——drain 的拒绝被吃掉，不会成为 unhandled rejection', async () => {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { seen.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const boundary = pluginTurnBoundary(() => ({ drain: async () => { throw new Error('组合应用失败（模拟）'); } }));
    await boundary();
    // 给它两拍微任务 + 一次 setImmediate：未处理的拒绝会在这个窗口里被 Node 报出来
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.deepEqual(seen, [], '边界钩子不许把 drain 的拒绝漏成 unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('插件：turn 边界——没有熔断器（假循环/未接插件）时是空操作', async () => {
  const boundary = pluginTurnBoundary(() => null);
  await boundary();
});

test('装配点：main.ts 的 onTurnBoundary 走 pluginTurnBoundary，不是 await drain', () => {
  const source = readFileSync(join(REPO_ROOT, 'src', 'main.ts'), 'utf8');
  assert.match(source, /onTurnBoundary: pluginTurnBoundary\(\(\) => circuitBreaker\)/u,
    '装配必须用 pluginTurnBoundary（踢一脚就走）');
  assert.doesNotMatch(source, /await\s+circuitBreaker\??\.drain\(\)/u,
    '不许把 drain 的 promise await 回 turn 边界（那正是 B2 修掉的那条）');
});
