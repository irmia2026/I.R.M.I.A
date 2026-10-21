/**
 * 测试临时目录：**建了就一定有人删**（2026-10-21）
 *
 * 为什么要有这个 helper：审计在 `C:\Windows\Temp` 数出 5680 个 `irmia-*` 目录 / 7.81GB，
 * 来源不是某个大 bug，而是**一百多个测试文件各自 `mkdtemp` 之后忘了删**——每条用例一次、
 * 全量跑一遍几百个。这种漏法单看每个文件都"只是一次 mkdtemp"，只有把账合起来才看得出来。
 *
 * 做法：把 `mkdtemp` / `mkdtempSync` 换成这里的 `tempDir` / `tempDirSync`。函数签名与返回
 * **逐字相同**（返回那个绝对路径），唯一的区别是**登记**一下；本进程退出时统一删掉。
 * 于是"忘了删"不再是一个需要每个用例作者记住的纪律，而是一条**结构性**保证：
 * 只要用了这个口子，就不可能在 `os.tmpdir()` 里留下东西。
 *
 * 三条分寸：
 *   ① **只删自己登记的**：不做"把新出现的 `irmia-*` 都删掉"那种兜底——`--test-concurrency`
 *      下同一个 TEMP 里可能同时跑着别的测试文件，按时间差删会误删**别人正在用**的目录。
 *   ② **尽力而为、不抛**：退出钩子里 `rm` 失败（文件仍被某句柄占着）只吞掉——清理失败
 *      不该把一份已经通过的测试变成失败；漏掉的由生产侧兜底扫（`src/util/temp-sweep.ts`）收。
 *   ③ **退出即清**：`process.once('exit')` 只能跑同步代码，所以用 `rmSync`；每个测试文件
 *      是独立进程，钩子各自清各自的那一份，互不越界。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 本进程建过、还没确认删掉的临时目录（绝对路径） */
const created = new Set<string>();
let hooked = false;

function ensureExitHook(): void {
  if (hooked) return;
  hooked = true;
  process.once('exit', () => {
    cleanupTempDirs();
  });
}

/**
 * 此刻还挂账的目录（只给测试自己看：断言"确实登记上了"）。
 * 生产代码不读它。
 */
export function trackedTempDirs(): readonly string[] {
  return [...created];
}

/** 立刻清掉本进程登记过的全部目录，返回尝试删除的个数（退出钩子与自测共用一份实现） */
export function cleanupTempDirs(): number {
  let attempted = 0;
  for (const dir of created) {
    attempted += 1;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    } catch {
      // 尽力而为：句柄还开着就留给生产侧兜底扫（见文件头 ②）
    }
  }
  created.clear();
  return attempted;
}

/** 登记一个已经建好的目录，返回同一个路径（给少数自己 `mkdtemp` 的调用点用） */
export function registerTempDir(dir: string): string {
  created.add(dir);
  ensureExitHook();
  return dir;
}

/**
 * `mkdtemp(join(tmpdir(), prefix))` 的等价物 + 退出时清理。
 *
 * 返回的字符串与原来**逐字节相同**（同一个 `os.tmpdir()`、同一个前缀），所以调用点
 * 后面的路径拼接一个字都不用改。
 */
export async function tempDir(prefix: string): Promise<string> {
  return registerTempDir(await mkdtemp(join(tmpdir(), prefix)));
}

/** {@link tempDir} 的同步版（`mkdtempSync` 的调用点用） */
export function tempDirSync(prefix: string): string {
  return registerTempDir(mkdtempSync(join(tmpdir(), prefix)));
}
