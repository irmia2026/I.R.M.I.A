/**
 * 后端进程的**老生代上限**（V8 的 `--max-old-space-size`）：**唯一来源**。
 *
 * ## 为什么单独一个模块（2026-10-26 的事故链）
 *
 * 同一台机器上有**四条**拉后端的路，各自决定这一格：
 *   · 自重启拉起器 `runtime/restart-worker.ts`（`spawnBackendArgv`）；
 *   · 开发机脚本 `tools/restart-agent.ps1`；
 *   · 随包脚本 `packaging/restart.ps1`；
 *   · 启动器 `packaging/start.ps1`（另有 `packaging/ensure-running.ps1` 这份看护脚本）。
 *
 * 四份各写一个数的时候出过两次真事故（`data/restart-backend.log`）：
 * ```
 * FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
 * ur[47208:…] 62001 ms: Mark-Compact (reduce) 511.5 (521.3) -> 510.5 (521.5) MB
 * ```
 * 现场是：03:34 那次「重启前后端」，拉起器带的是 **512MB**，新实例在 **62 秒**时撞死；
 * 而同一台机器上由**看护脚本**（1024MB）拉起来的那一份活得好好的。于是同一次重启
 * 在"拉起器拉"与"看护拉"两条路上有**两种生死**——这不是配置差异，是拉起器给了它一个
 * 活不了的参数（这台机器的数据量：180 MB 日志 / 23.5 万条事件）。
 *
 * 所以：**这个数只在这里写一次**，四条路都读它（脚本那一侧读环境变量 + 同一个缺省值）。
 *
 * ## 为什么缺省 1024 而不是 512
 *
 * 512 的依据是 2026-10-10 那组**Web 负载**峰值（58 MB / 7.3 万条事件，峰值 217~319 MB）。
 * 数据长到 180 MB / 23.5 万条之后，启动期的 `warmUp`（把整份日志读进内存重建会话簿等）
 * 与那次量测已经不是一个量级：实测 512 在 ready 之后约 20 秒必 OOM，1024 能活。
 * 上限的用途也变了——它当初是**钉住 RSS 水位**（V8 不把老生代还给系统），1024 仍然钉得住，
 * 只是给启动期那一段留出了余量。
 *
 * ## 怎么回退 / 怎么调
 *
 *   · 环境变量 `IRMIA_MAX_OLD_SPACE_MB=<MB>`（`0` 或负数 = **不加这个参数**，回到"V8 自己看着办"）；
 *   · 脚本那一侧显式参数（`-NodeMaxOldSpaceMb`）优先于环境变量；
 *   · 四条路读的都是 `DEFAULT_MAX_OLD_SPACE_MB`，改这一格四边一起变。
 */

import { getHeapStatistics } from 'node:v8';

/** 环境变量名：覆盖老生代上限（MB）。脚本与拉起器读的是同一个名字 */
export const MAX_OLD_SPACE_ENV = 'IRMIA_MAX_OLD_SPACE_MB';

/**
 * 缺省上限（MB）：**1024**。
 *
 * 为什么不是 512：见文件头（这台机器 180 MB 事件日志，512 在 ready 之后约 20 秒必 OOM）。
 * 为什么不是 2048：那组数据在 512 上撞死后曾用 2048 试过，**167 秒还是崩**——真正的问题在
 * `warmUp` 把整份日志收进数组（那是另一笔），而不是上限不够大。1024 是"这台机器实测能活"的那一档。
 */
export const DEFAULT_MAX_OLD_SPACE_MB = 1024;

/** 这一格的来源（启动摘要那一行 `来源=` 就是它） */
export type MaxOldSpaceSource = 'env' | 'default';

/** 解析环境变量里的覆盖值；没有 / 解析不出整数 ⇒ 用缺省（**不猜**一个中间值） */
export function resolveMaxOldSpace(
  env: Record<string, string | undefined> = process.env,
): { mb: number; source: MaxOldSpaceSource } {
  const raw = (env[MAX_OLD_SPACE_ENV] ?? '').trim();
  // 只认十进制整数（`1e3` / `1024.5` 这种写法一律当坏值）：这一格是 MB，不该接受浮点/科学计数
  if (/^-?\d+$/u.test(raw)) {
    return { mb: Number(raw), source: 'env' };
  }
  return { mb: DEFAULT_MAX_OLD_SPACE_MB, source: 'default' };
}

/** 只要数（忘了来源的地方用它；要打日志用 `describeMaxOldSpace`） */
export function resolveMaxOldSpaceMb(env: Record<string, string | undefined> = process.env): number {
  return resolveMaxOldSpace(env).mb;
}

/**
 * 从 argv 里读**本进程实际带的**那个 `--max-old-space-size=N`；没带 ⇒ null。
 *
 * `NODE_OPTIONS` 里写的也算（Node 会把它并进来），所以这里两个都看：先命令行、后环境变量。
 * 只用于**读数**（启动摘要那一行）——"应该给多少"由 [resolveMaxOldSpace] 说了算。
 */
export function flagMaxOldSpaceMb(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): number | null {
  const fromArgv = (args: readonly string[]): number | null => {
    for (const arg of args) {
      const hit = /^--max[-_]old[-_]space[-_]size=(\d+)$/u.exec(arg.trim());
      if (hit !== null) return Number(hit[1]);
    }
    return null;
  };
  const direct = fromArgv(argv);
  if (direct !== null) return direct;
  const nodeOptions = (env['NODE_OPTIONS'] ?? '').trim();
  if (nodeOptions === '') return null;
  return fromArgv(nodeOptions.split(/\s+/u));
}

/**
 * 启动摘要那一行：**这一个进程现在拿的是多少、这个数是谁给的**。
 *
 * 为什么非要有它：OOM 之后日志里只有 `FATAL ERROR: Reach…`，看不出"上限是多少、哪条路给的"。
 * 事故那天正是这样——同一份安装、两个上限（512 与 1024），现场只能靠翻命令历史才知道是谁。
 *
 * 两个读数分开说（它们是**两件事**）：
 *   · `老生代上限=` —— 启动策略（环境变量或缺省 1024），四条路应该给的那个数；
 *   · `命令行 flag=` —— 本进程**实际**带没带。没带时如实说"没带"：那意味着这个进程的
 *     生存概率取决于 V8 的默认值，而不是我们承诺的那个数（脚本漏传时就长这样）。
 */
export function describeMaxOldSpace(input: {
  env?: Record<string, string | undefined>;
  execArgv?: readonly string[];
  heapLimitBytes?: number;
} = {}): string {
  const env = input.env ?? process.env;
  const resolved = resolveMaxOldSpace(env);
  const argv = input.execArgv ?? process.execArgv;
  const actual = flagMaxOldSpaceMb(argv, env);
  const heapLimit = input.heapLimitBytes ?? getHeapStatistics().heap_size_limit;
  const heapLimitMb = Math.round(heapLimit / (1024 * 1024));
  const source = resolved.source === 'env' ? `env(${MAX_OLD_SPACE_ENV})` : 'default';
  const flag = actual === null
    ? '命令行里**没有** --max-old-space-size（V8 默认上限；说明这一条路漏传了）'
    : `命令行里带 --max-old-space-size=${actual}`;
  return `[内存] 老生代上限=${resolved.mb}MB（来源=${source}）· ${flag} · V8 报 heap_size_limit≈${heapLimitMb}MB`;
}
