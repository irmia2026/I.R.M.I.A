/**
 * **老生代上限的唯一来源**（`src/runtime/node-memory.ts`）—— 2026-10-26 事故链的收口。
 *
 * 现场（`data/restart-backend.log`，同一天两次）：
 * ```
 * FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
 * ur[47208:…] 62001 ms: Mark-Compact (reduce) 511.5 (521.3) -> 510.5 (521.5) MB
 * ```
 * 而起因不是"内存不够大"这么笼统：同一份安装上**四条拉后端的路给了两个数**——
 * 拉起器 512（62 秒撞死）、看护脚本 1024（活得好好的）。同一次重启，两种生死。
 *
 * 这一份钉的是那个**数**本身：缺省 1024、一个环境变量覆盖口（`IRMIA_MAX_OLD_SPACE_MB`）、
 * 以及"本进程实际带没带这个 flag"的读数（启动摘要那一行的两个事实）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MAX_OLD_SPACE_MB, MAX_OLD_SPACE_ENV, describeMaxOldSpace, flagMaxOldSpaceMb,
  resolveMaxOldSpace, resolveMaxOldSpaceMb,
} from '../src/runtime/node-memory.ts';
import { MAX_OLD_SPACE_MB, backendSpawnArgv } from '../src/runtime/restart-worker.ts';

test('① 缺省 1024（不是 512）：这台机器 180 MB 日志 / 23.5 万条事件，512 在 ready 之后约 20 秒必 OOM', () => {
  assert.equal(DEFAULT_MAX_OLD_SPACE_MB, 1024);
  assert.equal(MAX_OLD_SPACE_MB, DEFAULT_MAX_OLD_SPACE_MB, '拉起器的常量必须是同一份来源');
  assert.deepEqual(resolveMaxOldSpace({}), { mb: 1024, source: 'default' });
});

test('①b 环境变量覆盖：数字就是数字，坏值不生效（不猜一个中间值）', () => {
  assert.deepEqual(resolveMaxOldSpace({ [MAX_OLD_SPACE_ENV]: '1536' }), { mb: 1536, source: 'env' });
  assert.deepEqual(resolveMaxOldSpace({ [MAX_OLD_SPACE_ENV]: ' 2048 ' }), { mb: 2048, source: 'env' });
  // 0 / 负数 = **不加参数**（回退那条路），原样传下去
  assert.deepEqual(resolveMaxOldSpace({ [MAX_OLD_SPACE_ENV]: '0' }), { mb: 0, source: 'env' });
  assert.deepEqual(resolveMaxOldSpace({ [MAX_OLD_SPACE_ENV]: '-1' }), { mb: -1, source: 'env' });
  // 坏值（空 / 非数字 / 小数）⇒ 回缺省
  for (const bad of ['', '   ', 'abc', '1024.5', '1e3']) {
    assert.deepEqual(resolveMaxOldSpace({ [MAX_OLD_SPACE_ENV]: bad }), { mb: 1024, source: 'default' },
      `坏值不许生效：${JSON.stringify(bad)}`);
  }
  assert.equal(resolveMaxOldSpaceMb({ [MAX_OLD_SPACE_ENV]: '1536' }), 1536);
});

test('② 拉起器拼的参数用的是这一份：缺省 1024，覆盖了跟环境走，0 就不加', () => {
  assert.deepEqual(backendSpawnArgv('C:\\Irmia\\app\\dist\\main.js'),
    ['--max-old-space-size=1024', 'C:\\Irmia\\app\\dist\\main.js']);
  assert.deepEqual(
    backendSpawnArgv('e.js', resolveMaxOldSpaceMb({ [MAX_OLD_SPACE_ENV]: '1536' })),
    ['--max-old-space-size=1536', 'e.js'],
  );
  assert.deepEqual(backendSpawnArgv('e.js', resolveMaxOldSpaceMb({ [MAX_OLD_SPACE_ENV]: '0' })), ['e.js']);
});

test('③ 本进程实际带没带：argv 优先、NODE_OPTIONS 次之、都没有就是 null', () => {
  assert.equal(flagMaxOldSpaceMb(['node', '--max-old-space-size=1024', 'dist/main.js'], {}), 1024);
  assert.equal(flagMaxOldSpaceMb(['node', 'dist/main.js'], { NODE_OPTIONS: '--max-old-space-size=2048' }), 2048);
  assert.equal(flagMaxOldSpaceMb(['node', '--max-old-space-size=1024', 'x.js'],
    { NODE_OPTIONS: '--max-old-space-size=2048' }), 1024, '命令行压过 NODE_OPTIONS（Node 的口径）');
  assert.equal(flagMaxOldSpaceMb(['node', 'dist/main.js'], {}), null);
});

test('④ 启动摘要那一行：策略值与"实际带没带"分开说（OOM 时唯一能回答"谁给的"的地方）', () => {
  const withFlag = describeMaxOldSpace({
    env: {}, execArgv: ['node', '--max-old-space-size=1024', 'dist/main.js'], heapLimitBytes: 1024 * 1024 * 1024,
  });
  assert.match(withFlag, /^\[内存\] 老生代上限=1024MB（来源=default）/u);
  assert.match(withFlag, /命令行里带 --max-old-space-size=1024/u);
  assert.match(withFlag, /heap_size_limit≈1024MB/u);

  const withoutFlag = describeMaxOldSpace({ env: {}, execArgv: ['node', 'dist/main.js'], heapLimitBytes: 1024 * 1024 * 1024 });
  assert.match(withoutFlag, /命令行里\*\*没有\*\* --max-old-space-size/u, '漏传时必须如实说"没带"');

  const fromEnv = describeMaxOldSpace({
    env: { [MAX_OLD_SPACE_ENV]: '1536' }, execArgv: ['node', '--max-old-space-size=1536', 'x.js'],
    heapLimitBytes: 1536 * 1024 * 1024,
  });
  assert.match(fromEnv, /老生代上限=1536MB（来源=env\(IRMIA_MAX_OLD_SPACE_MB\)）/u);
});

test('⑤ 这一行不许在启动时抛（OOM 排障靠它，不许自己成为新的故障点）', () => {
  // 不传任何东西 ⇒ 读真环境与真 argv，仍然必须是一行字符串
  const line = describeMaxOldSpace();
  assert.match(line, /^\[内存\] 老生代上限=\d+MB（来源=(default|env\(IRMIA_MAX_OLD_SPACE_MB\))）/u);
});
