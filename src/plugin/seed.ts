/**
 * Irmia Agent — 内置插件种子（出厂插件包 → 数据目录，一次性、幂等）
 *
 * ──────────────────────────────── 这个模块解决的是什么 ────────────────────────────────
 *
 * 插件平台 P0 只提供了「人把包放进数据目录 → 界面点确认 → 启用」这一条路。于是**随包
 * 分发的插件**没有任何安装通道：发包方（我们）没法让出厂就带一份功能，用户也拿不到
 * 「开箱能用」的那个插件。本模块补的就是这一步：把仓库/安装包里的 `plugins/builtin/*`
 * 搬进数据目录的插件包仓库。
 *
 * ──────────────────────────────── 三条纪律（每一条都对应一种坏结果） ────────────────────────────────
 *
 * 与 `skill/seed.ts` 逐条同形，理由也相同——技能那套已经在现场跑过一个多月：
 *
 *  ① **已经装过就一个字节都不动。** 「装过没有」的判据是**插件包仓库里有没有这个
 *     `id@contentHash` 目录**。不另记 marker 文件——marker 是第二份真相源（marker 在、
 *     目录被删 ⇒ 永远不重装；目录在、marker 丢 ⇒ 重复安装），而目录在不在**本身就是**
 *     那个事实。
 *  ② **不覆盖。** 内容寻址的仓库里，同一个 `id@hash` 只可能有一份字节；换了内容就是
 *     另一个 hash、另一个目录。所以「内置插件更新」天然表现为多一个包，由人的确认与
 *     启停决定用哪一版——本模块不替人做这个决定。
 *  ③ **失败不拦启动。** 插件装不上是功能缺一块，起不来是整台机器没了。
 *
 * ──────────────────────────────── 它不是信任门 ────────────────────────────────
 *
 * 搬过来的插件**照样要 `plugin/installed { by: 'human' }` 才进组合**（与 `skill/seed`
 * 同一条裁决）。内置插件是**可执行代码**，比技能风险更高；为省用户一次点击就开
 * 「随包代码自动执行」的口子不值得。
 *
 * 但这里有一条技能那边没有的红利：插件仓库按**内容哈希**寻址，所以「人确认过的那个
 * hash」在下次启动时仍然命中——用户点过一次，之后每次启动都不必再点，除非包内容变了。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { installPluginPackage, pluginPackagesRoot, scanPluginPackage, type PluginPackage } from './package-store.ts';

/** 出厂内置插件在安装包/仓库里的目录名（相对工作根） */
export const BUILTIN_PLUGINS_DIR_NAME = 'plugins/builtin';

/**
 * 一次 `ensureBuiltinPlugins` 的结论。
 *
 * 四个状态**互斥且穷尽**，调用方只按它决定「说什么」与「要不要写事件」：
 *   · `created` —— 本次至少装进去了一个（应写事件 + 一行启动摘要）；
 *   · `exists`  —— 全都在仓库里了（幂等的常态，不必说什么）；
 *   · `no-seed` —— 没有可装的出厂插件（老安装包/裁剪发行版）：保持数据目录原样；
 *   · `failed`  —— 有失败（`failures` 里逐条说清是哪一个、为什么），其余照常。
 *                  一个都没装上时也走这个状态——**不吞掉原因**。
 */
export type PluginSeedState = 'created' | 'exists' | 'no-seed' | 'failed';

export interface PluginSeedFailure {
  /** 出厂种子里的目录名（人读用） */
  dir: string;
  /** 一句人话：为什么没成 */
  reason: string;
}

export interface PluginSeedReport {
  state: PluginSeedState;
  /** 本次**新装进**仓库的那些包（已被跳过的不在内） */
  installed: PluginPackage[];
  /** 已经在仓库里、这次一个字节都没动的那些包 */
  skipped: PluginPackage[];
  /** 逐个失败的原因（成功的不在内）；全成功时为空数组 */
  failures: PluginSeedFailure[];
  /** 出厂种子根绝对路径（`<cwd>/plugins/builtin`） */
  seedRoot: string;
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** 出厂种子根下的候选插件目录名（跳过隐藏项；只收目录） */
function listSeedDirs(seedRoot: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(seedRoot);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !entry.startsWith('.'))
    .filter((entry) => isDirectory(join(seedRoot, entry)))
    .sort();
}

/**
 * 把出厂内置插件装进数据目录的插件包仓库（**只在仓库里还没有那个 `id@hash` 时**）。
 *
 * @param dataDir  数据目录（插件包仓库是 `<dataDir>/plugins/packages`）
 * @param seedRoot 出厂内置插件的**根**绝对路径（运行期是 `<cwd>/plugins/builtin`）
 */
export function ensureBuiltinPlugins(dataDir: string, seedRoot: string): PluginSeedReport {
  const base = { installed: [] as PluginPackage[], skipped: [] as PluginPackage[], failures: [] as PluginSeedFailure[], seedRoot };

  // ① 没有种子可装：**不建空目录**（"不存在"这个事实留给下一次启动用）
  if (!isDirectory(seedRoot)) return { ...base, state: 'no-seed' };
  const dirs = listSeedDirs(seedRoot);
  if (dirs.length === 0) return { ...base, state: 'no-seed' };

  const installed: PluginPackage[] = [];
  const skipped: PluginPackage[] = [];
  const failures: PluginSeedFailure[] = [];

  for (const dir of dirs) {
    const source = join(seedRoot, dir);
    try {
      // 「已经装过没有」：先按**仓库布局的唯一判据**（`pluginPackagesRoot`）问一次。
      //
      // 为什么必须多扫一遍：`installPluginPackage` 对「本次新建」与「早就有了」返回**同一个**
      // 包对象——它不告诉你这次到底动没动盘。而报告里 `installed` / `skipped` 的区别正是这个
      // 事实（`main.ts` 拿 `installed` 写 `plugin/builtin` 装配账：装了几个、是哪几个）。
      //
      // 为什么不去改 `installPluginPackage` 让它返回「是否新建」：那是**插件包仓库的公共入口**，
      // 改返回形状要动它所有调用方与测试，为省一次冷路径的重复读盘不值得（第 4/8 条）。
      // 这里的代价是：每个内置插件每次启动多读一遍自己（≤8 MB、≤256 文件），仅此而已。
      //
      // 为什么不自己拼 `plugins/packages/<id>/<hash>` 字面量：那会把仓库布局抄成第二份知识，
      // 与 `package-store.ts` 迟早会分叉——所以路径一律从 `pluginPackagesRoot()` 来。
      const scanned = scanPluginPackage(source);
      const alreadyThere = existsSync(join(pluginPackagesRoot(dataDir), scanned.manifest.id, scanned.contentHash));
      const pkg = installPluginPackage(source, dataDir);
      if (alreadyThere) skipped.push(pkg);
      else installed.push(pkg);
    } catch (err) {
      failures.push({ dir, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // ② 结论：有失败就如实说失败（部分失败也算），否则按"这次装了几个"分 created/exists
  if (failures.length > 0) return { ...base, state: 'failed', installed, skipped, failures };
  if (installed.length > 0) return { ...base, state: 'created', installed, skipped, failures };
  return { ...base, state: 'exists', installed, skipped, failures };
}
