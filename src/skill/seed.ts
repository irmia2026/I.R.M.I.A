/**
 * Irmia Agent — 技能种子（出厂技能包 → 数据目录，一次性、幂等）
 *
 * ──────────────────────────────── 这个模块修的是哪两条 ────────────────────────────────
 *
 * 2026-10-23 现场，两条病同源：
 *   ① 运行环境搬进安装目录、数据目录另立一处之后，`SkillManager` 还建在 `process.cwd()` 上
 *      ⇒ 技能根 = `<安装根>/skills`。数据目录里一件都没有，界面上"没有任何技能"、
 *      catalog 0 条——而技能文件其实好端端躺在安装目录里；
 *   ② **更重的那条**：技能实体住在**安装目录**里 ⇒ 用户用安装器更新（安装目录被整体替换）
 *      ⇒ 装的技能全没。这不是显示问题，是丢失用户资产。
 *
 * 改法（技能实体的家搬进数据目录）：
 *   · 运行期技能根 = `<dataDir>/skills/<name>/SKILL.md`，与 `persona/` 同级
 *     （`main.ts` 把 `SkillManager.baseRoot` 给成数据目录）；
 *   · 仓库/安装包里的 `skills/` 退化成**出厂种子**——本模块只负责那一次复制；
 *   · 安装器此后只在"数据目录里还没有技能"时起作用；更新替换安装目录再也碰不到技能。
 *
 * ──────────────────────────────── 三条纪律（每一条都对应一种坏结果） ────────────────────────────────
 *
 *  ① **`<dataDir>/skills` 已存在就一个字节都不动。** 不覆盖、不补缺、不"顺手同步一下"：
 *     用户可能改过里面的 SKILL.md（信任门按内容哈希判"确认后又被改"），也可能**故意删掉**
 *     过某个技能——再从种子里复制回去，等于让"删掉的技能"每次启动复活，比扫不到更坏。
 *  ② **幂等**：第二次启动不再复制（`state: 'exists'`）。判据就是那个目录本身，
 *     不另记 marker 文件——marker 是第二份真相源（marker 在、目录被删 ⇒ 永远不复制；
 *     目录在、marker 丢 ⇒ 重复复制），而目录在不在**本身就是**那个事实。
 *  ③ **失败不留半成品**：dest 是本次新建的（前面判过它不存在），复制中途失败就把它整个
 *     删掉再如实报错。留着半个目录，下一轮会命中①"已存在"，把残缺状态永久钉住。
 *
 * 复制是**整份照搬**（`SKILL.md` + references/ + assets/ + scripts/ + 那个技能自己的
 * `.env`）：一个技能的随包文件就是它的一部分，挑着复制会造出一种"读得到说明、跑不了脚本"
 * 的新坏法。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { SKILLS_DIR_NAME } from './skills.ts';

/**
 * 种子落点 / 默认技能根的目录名：**从 `skills.ts` 取的同一个常量**（不在本文件再写一遍
 * 字面量——"落点叫 skills"与"默认技能根叫 skills"必须是同一个词，否则种子会复制进一个
 * 谁都扫不到的目录）。
 */
export { SKILLS_DIR_NAME };

/**
 * 一次 `ensureSkillsSeed` 的结论。
 *
 * 四个状态是**互斥且穷尽**的，调用方（`main.ts`）只按它决定"说什么"与"要不要写事件"：
 *   · `created` —— 本次真的复制了（应写一条 internal 事件 + 一行启动摘要）；
 *   · `exists`  —— 数据目录里已有一份，**一个字节都没动**（幂等的常态，不必说什么）；
 *   · `no-seed` —— 没有可复制的出厂种子（老安装包/裁剪过的发行版）：保持数据目录原样，
 *                  由 `SkillManager` 的兼容根去兜（`main.ts` 给了 `process.cwd()`）；
 *   · `failed`  —— 复制本身失败（含"种子在、目标是个文件"这种写不进去的现场）：如实报，
 *                  不拦启动（技能扫不到是功能缺一块，起不来是整台机器没了）。
 */
export type SkillSeedState = 'created' | 'exists' | 'no-seed' | 'failed';

export interface SkillSeedReport {
  state: SkillSeedState;
  /** 复制过去的技能目录名（目录名即技能名，升序）；没复制时为空数组 */
  skills: string[];
  /** 复制过去的文件总数（含 references/assets/scripts 那些随包文件）；没复制时为 0 */
  files: number;
  /** 落点绝对路径（`<dataDir>/skills`） */
  dest: string;
  /** 出厂种子根绝对路径（`<cwd>/skills`） */
  seedRoot: string;
  /** `state === 'failed'` 时的一句人话（为什么没成、下一次会怎样）；其余状态为 undefined */
  failure?: string;
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** 一个技能根下的技能目录名（跳过隐藏项；只收目录——散文件不是技能） */
function listSkillDirs(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !entry.startsWith('.'))
    .filter((entry) => isDirectory(join(root, entry)))
    .sort();
}

/** 目录下的文件总数（递归；符号链接按条目算一个，不跟进——与复制口径一致） */
function countFiles(root: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) total += countFiles(join(root, entry.name));
    else total += 1;
  }
  return total;
}

/**
 * 把出厂种子整份复制到数据目录（**只在 `<dataDir>/skills` 不存在时**）。
 *
 * @param dataDir  数据目录（`<dataDir>/skills` 是落点，与 `persona/` 同级）
 * @param seedRoot 出厂种子的**技能根**绝对路径（运行期是 `<cwd>/skills`）
 */
export function ensureSkillsSeed(dataDir: string, seedRoot: string): SkillSeedReport {
  const dest = join(dataDir, SKILLS_DIR_NAME);
  const base = { dest, seedRoot };

  // ① 已存在 ⇒ 一个字节都不动（这条判据在"种子没有"之前：数据目录里那份才是资产，
  //    出厂种子缺不缺都不该影响它）
  if (existsSync(dest)) {
    if (!isDirectory(dest)) {
      return {
        ...base,
        state: 'failed',
        skills: [],
        files: 0,
        failure: `${dest} 不是一个目录（是一个同名文件），所以这一次没有复制任何技能；`
          + '请由人把它挪走——下次启动会自动重试',
      };
    }
    return { ...base, state: 'exists', skills: [], files: 0 };
  }

  // ② 没有种子可复制：**不建空目录**（"不存在"这个事实要留给兼容根与下一次启动用）
  if (!isDirectory(seedRoot)) {
    return { ...base, state: 'no-seed', skills: [], files: 0 };
  }
  const skills = listSkillDirs(seedRoot);
  if (skills.length === 0) {
    // 种子目录在但一件技能都没有：复制一个空壳只会让"存在即不复制"把门永久关上
    return { ...base, state: 'no-seed', skills: [], files: 0 };
  }

  const files = countFiles(seedRoot);
  try {
    mkdirSync(dirname(dest), { recursive: true });
    // verbatim：不 dereference（符号链接原样过去）、force:false（万一并发建出来了也不覆盖）
    cpSync(seedRoot, dest, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true });
  } catch (err) {
    // ③ 不留半成品：本次新建的那个目录整个删掉，下一次启动还能重来
    try {
      rmSync(dest, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    } catch {
      // 删不掉就只能如实说"它可能只剩一半"——下一次启动会把它当成"已存在"，
      // 所以这句话里必须点明需要人看一眼
    }
    return {
      ...base,
      state: 'failed',
      skills: [],
      files: 0,
      failure: `复制失败（${err instanceof Error ? err.message : String(err)}）：`
        + '已尝试删掉这次建出来的那半个目录，下次启动会重试；'
        + `若它还在，请由人看一眼 ${dest}`,
    };
  }

  return { ...base, state: 'created', skills, files };
}
