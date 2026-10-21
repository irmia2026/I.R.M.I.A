/**
 * Irmia Agent — 临时目录兜底扫（`%TEMP%` 里我们自己的遗留物）
 *
 * 为什么要有它（2026-10-21，外部审计先把账算清的那一件）：
 *   · 审计在 `C:\Windows\Temp` 数出 5680 个 `irmia-*` 目录、7.81GB，**全是测试造的**
 *     （`test/send-media.test.ts` 的 200MB 夹具一条一跑就留一个，从不删）；
 *   · 生产 `src/**` 一个都不建，但**安装器**会建：`install_engine.dart` 的 `verify-only`
 *     早退不删 stage（`irmia-setup-<pid>`），引导器失败现场还会留下 `irmia-boot-<pid>`。
 *   前者已经按"夹具改小 + 测试清理"从源头收拾了，这一件是**兜底**：真有谁漏了，也只漏一会儿。
 *
 * 四条分寸（每一条都对应一类误删现场）：
 *   ① **白名单前缀**：只碰名字以我们自己的族前缀开头的条目。`%TEMP%` 是所有人的公共抽屉，
 *      "够老就删"一旦没有前缀这道门，删掉的就是别人的东西。
 *   ② **够老才碰**：默认 24 小时；`irmia-boot-` 留 7 天（失败现场的价值就在"事后能回传"，
 *      见 {@link TEMP_SWEEP_RULES}）。刚建出来的东西一般是**正在用**的。
 *   ③ **非占用才碰**：先 `rename` 试探——目录被当成工作目录、或里面的文件被独占打开时，
 *      Windows 的 rename 会失败；失败就跳过（`skippedInUse`），不跟活人抢东西。
 *   ④ **默认只报不删**：`IRMIA_TEMP_SWEEP=off|dry|on`，缺省 `dry` —— 第一版上线只看账本。
 *      `dry` 的 `rename` 是"试探完立刻改回来"，一个字节都不删。
 *
 * 调用点（都在装配层，不在这个模块里）：
 *   · 启动时一次（`main.ts`）；
 *   · 每日整理那一拍（`real-loop.ts` 的 `runMemoryMaintain`，走注入的 `tempSweep`）。
 *
 * 只依赖 node: 标准库；不读配置、不写台账——账本（日志与 `temp/swept` 事件）由调用点落。
 */

import { lstat, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOUR_MS = 3_600_000;

/** 环境变量名：`off`（什么都不扫）/ `dry`（只报，缺省）/ `on`（真删） */
export const TEMP_SWEEP_ENV = 'IRMIA_TEMP_SWEEP';

/** 缺省模式：**只报不删**（第一版上线先看账，见文件头 ④） */
export const TEMP_SWEEP_DEFAULT_MODE: TempSweepMode = 'dry';

/** 一轮最多处理多少个候选（防止启动被 3000 个目录拖住；超了记 `truncated`） */
export const TEMP_SWEEP_MAX_ENTRIES = 2_000;

export type TempSweepMode = 'off' | 'dry' | 'on';

export interface TempSweepRule {
  /** 名字前缀（白名单） */
  readonly prefix: string;
  /** 多老才碰（毫秒） */
  readonly minAgeMs: number;
  /** 这条前缀是谁建的（写在这里，是为了让"删它有理"可复核） */
  readonly note: string;
}

/**
 * 白名单前缀表（**顺序即优先级**：先命中的规则说了算）。
 *
 * 为什么 `irmia-boot-` 要 7 天而不是 24 小时：那是**安装器失败现场**——引导器把壳解到
 * `%TEMP%\irmia-boot-<pid>`，失败时刻意保留，事后要靠它回传日志/复现。刚失败的现场
 * 最有用，24 小时就扫掉等于把证据扔了；7 天足够一次"过个周末再反馈"的节奏，之后由
 * 兜底扫清掉（见 `install_engine.dart` 的说明与 docs/operations.md）。
 *
 * 最后一条 `irmia-` 是**族兜底**：安装器日志（`irmia-setup.log`）、开发脚本
 * （`irmia-gui-build-*` 等）、测试夹具（`irmia-media-*` 等）都落在这条下。它排在最后，
 * 所以上面几条的期限优先。
 */
export const TEMP_SWEEP_RULES: readonly TempSweepRule[] = [
  {
    prefix: 'irmia-boot-',
    minAgeMs: 7 * 24 * HOUR_MS,
    note: '安装器引导器的失败现场（刻意保留给人回传；7 天后清）',
  },
  {
    prefix: 'irmia-setup-',
    minAgeMs: 24 * HOUR_MS,
    note: '安装器 stage（verify-only 早退曾泄漏）',
  },
  {
    prefix: 'irmia-manifest-',
    minAgeMs: 24 * HOUR_MS,
    note: '安装包清单的临时目录（install_engine.readManifest）',
  },
  {
    prefix: 'irmia-syntax-',
    minAgeMs: 24 * HOUR_MS,
    note: 'fs 族语法检查的临时文件（tools/fs/syntax-check.ts）',
  },
  {
    prefix: 'irmia-',
    minAgeMs: 24 * HOUR_MS,
    note: '其余 irmia- 命名（安装器日志 / 打包脚本 / 测试夹具的兜底）',
  },
];

export interface TempSweepReport {
  mode: TempSweepMode;
  /** 扫的是哪个目录（`os.tmpdir()`，测试可注入） */
  root: string;
  /** 前缀命中的条目数（含还不算老的） */
  scanned: number;
  /** 够老、前缀命中的候选：`dry` 下 = "将删"的个数，`on` 下 = 尝试删的个数 */
  candidates: number;
  /** 候选的字节数（目录按递归求和） */
  bytes: number;
  /** 真删掉的个数（`dry` 恒为 0） */
  deleted: number;
  /** 前缀命中但还不够老的个数（只计数，便于判断"阈值是不是太松"） */
  skippedYoung: number;
  /** `rename` 试探失败（判定为占用）而跳过的个数 */
  skippedInUse: number;
  /** 删/改回失败的个数 */
  failures: number;
  /** 候选超过 {@link TEMP_SWEEP_MAX_ENTRIES} ⇒ 这一轮没扫完 */
  truncated: boolean;
  /** 读目录失败时的原因（空串 = 一切正常） */
  error: string;
}

export interface TempSweepOptions {
  /** 显式模式；省略时读 {@link TEMP_SWEEP_ENV}，再省略用 {@link TEMP_SWEEP_DEFAULT_MODE} */
  mode?: TempSweepMode;
  /** 扫哪个目录；省略 = `os.tmpdir()` */
  root?: string;
  /** 当前时刻（测试注入；省略 = `Date.now()`） */
  now?: () => number;
  /** 前缀规则（测试注入；省略 = {@link TEMP_SWEEP_RULES}） */
  rules?: readonly TempSweepRule[];
  /** 单轮上限（测试可以调小；省略 = {@link TEMP_SWEEP_MAX_ENTRIES}） */
  maxEntries?: number;
}

/**
 * 环境变量 → 模式。**不认识的值不猜**：退回缺省 `dry`，并把这件事写进 `problem`
 * （调用点据此打一行日志——"开关写错了所以按 dry 跑"必须看得见，不能静默）。
 */
export function parseTempSweepMode(raw: string | undefined): {
  mode: TempSweepMode;
  problem: string;
} {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return { mode: TEMP_SWEEP_DEFAULT_MODE, problem: '' };
  if (value === 'off' || value === 'dry' || value === 'on') return { mode: value, problem: '' };
  return {
    mode: TEMP_SWEEP_DEFAULT_MODE,
    problem: `${TEMP_SWEEP_ENV}=${raw ?? ''} 不认识（只认 off|dry|on）⇒ 按 ${TEMP_SWEEP_DEFAULT_MODE} 跑`,
  };
}

/** 名字命中哪条规则（**第一条**说了算；一条都不命中 ⇒ null） */
export function tempSweepRuleFor(
  name: string,
  rules: readonly TempSweepRule[] = TEMP_SWEEP_RULES,
): TempSweepRule | null {
  for (const rule of rules) {
    if (name.startsWith(rule.prefix)) return rule;
  }
  return null;
}

/** 字节数 → 一行账里那个"共多少"（≥1 MiB 用 MB，小的用 KB——两千字节说成 `0.0 MB` 等于没说） */
function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** 人类可读的一行账（日志与事件用同一份文字） */
export function formatTempSweepLine(report: TempSweepReport): string {
  const size = formatBytes(report.bytes);
  if (report.mode === 'off') return `[临时目录] 已关闭（${TEMP_SWEEP_ENV}=off）：没有扫 ${report.root}`;
  const scanNote = report.truncated ? `，本轮只扫了前 ${TEMP_SWEEP_MAX_ENTRIES} 个候选` : '';
  const skipNote = report.skippedInUse > 0 ? `，占用跳过 ${report.skippedInUse} 个` : '';
  const failNote = report.failures > 0 ? `，失败 ${report.failures} 个` : '';
  const tail = `${report.root}（白名单前缀、够老、非占用）${scanNote}${skipNote}${failNote}`;
  if (report.error !== '') return `[临时目录] 扫不动 ${report.root}：${report.error}`;
  return report.mode === 'dry'
    ? `[临时目录] dry-run：将删 ${report.candidates} 个 / 共 ${size} —— ${tail}`
    : `[临时目录] 已删 ${report.deleted} 个 / 共 ${size} —— ${tail}`;
}

/**
 * 跑一轮兜底扫。
 *
 * 不抛异常：`%TEMP%` 读不动是"这一轮没扫成"，不该让启动或每日整理跟着失败（`error` 字段带着原因）。
 * 破坏性动作只有一处（`on` 模式的 `rm`），且永远发生在 `rename` 成功之后——这两步合起来就是
 * "先确认没人在用，再动手"。
 */
export async function runTempSweep(options: TempSweepOptions = {}): Promise<TempSweepReport> {
  const parsedMode = options.mode === undefined ? parseTempSweepMode(process.env[TEMP_SWEEP_ENV]) : null;
  const mode = options.mode ?? parsedMode!.mode;
  const root = options.root ?? tmpdir();
  const now = options.now ?? ((): number => Date.now());
  const rules = options.rules ?? TEMP_SWEEP_RULES;
  const maxEntries = options.maxEntries ?? TEMP_SWEEP_MAX_ENTRIES;
  const report: TempSweepReport = {
    mode, root, scanned: 0, candidates: 0, bytes: 0, deleted: 0,
    skippedYoung: 0, skippedInUse: 0, failures: 0, truncated: false, error: '',
  };
  // `off` 连目录都不读（"关掉了"就该真的是零动作，别拿一次 readdir 当"没删"）
  if (mode === 'off') return report;

  let names: string[];
  try {
    names = await readdir(root);
  } catch (err) {
    report.error = toMessage(err);
    return report;
  }

  let probeSeq = 0;
  for (const name of names) {
    const rule = tempSweepRuleFor(name, rules);
    if (rule === null) continue;
    report.scanned += 1;

    const path = join(root, name);
    let stat;
    try {
      stat = await lstat(path);
    } catch {
      continue; // 刚被别的进程删掉/改名的：不是我们的候选
    }
    const ageMs = now() - stat.mtimeMs;
    if (ageMs <= rule.minAgeMs) {
      report.skippedYoung += 1;
      continue;
    }
    if (report.candidates >= maxEntries) {
      report.truncated = true;
      break;
    }
    report.candidates += 1;
    report.bytes += await sizeOf(path);

    // ③ 非占用试探：rename 成功 = 没人在用；失败 = 跳过（**绝不对失败的那个动手**）
    probeSeq += 1;
    const probe = `${path}.sweep-${process.pid}-${probeSeq}`;
    try {
      await rename(path, probe);
    } catch {
      report.skippedInUse += 1;
      continue;
    }

    if (mode === 'dry') {
      // 只报了"会删"，那就立刻改回去：dry 一个字节都不许删
      try {
        await rename(probe, path);
      } catch (err) {
        report.failures += 1;
        report.error = `${report.error === '' ? '' : `${report.error}；`}改回失败：${toMessage(err)}`;
      }
      continue;
    }
    try {
      await rm(probe, { recursive: true, force: true, maxRetries: 2 });
      report.deleted += 1;
    } catch (err) {
      report.failures += 1;
      report.error = `${report.error === '' ? '' : `${report.error}；`}删除失败：${toMessage(err)}`;
    }
  }
  return report;
}

// ──────────────────────────────── 启动接线 ────────────────────────────────

/**
 * 启动期从环境变量定下的那一档（**只读一次**：`IRMIA_TEMP_SWEEP` 是"启动期决定的后台维护"，
 * 与 `wake.memoryMaintainCron` 同一条口径——改档要重启才生效）。
 *
 * 抽成纯函数是为了让"启动到底按哪一档跑"这个判据能被钉住：`runMain` 本身依赖太多
 * （配置、人格、锁、日志），全仓没有它的测试；而这里错一档的后果是"以为只报不删，其实删了"
 * ——那是最不该靠肉眼复查的一类。
 */
export interface TempSweepPlan {
  mode: TempSweepMode;
  /** 环境变量写错时的说明（空串 = 正常）；调用点要把它打出来，不许静默 */
  problem: string;
}

export function planTempSweep(
  env: Record<string, string | undefined> = process.env,
): TempSweepPlan {
  return parseTempSweepMode(env[TEMP_SWEEP_ENV]);
}

/** `temp/swept` 事件的载荷（**唯一一处**构造：启动接线与每日整理那拍共用，不许两处各拼一份） */
export interface TempSweptPayload {
  mode: 'dry' | 'on';
  root: string;
  scanned: number;
  candidates: number;
  bytes: number;
  deleted: number;
  skippedInUse: number;
  failures: number;
  error: string;
}

export function tempSweptPayload(report: TempSweepReport): TempSweptPayload {
  return {
    mode: report.mode === 'on' ? 'on' : 'dry',
    root: report.root,
    scanned: report.scanned,
    candidates: report.candidates,
    bytes: report.bytes,
    deleted: report.deleted,
    skippedInUse: report.skippedInUse,
    failures: report.failures,
    error: report.error,
  };
}

export interface StartupTempSweepOptions {
  /** 启动时定下的那一档（`planTempSweep` 的结果） */
  plan: TempSweepPlan;
  /** 日志出口（`main.ts` 的 `write`） */
  log: (line: string) => void;
  /** 事件出口（`main.ts` 的 `append`）；不给 = 只写日志（测试/嵌入方） */
  append?: (type: 'temp/swept', data: TempSweptPayload, visibility: 'internal') => void;
  /** 扫描根（测试注入；缺省 `os.tmpdir()`） */
  root?: string;
  /** 扫的实现（测试注入；缺省 {@link runTempSweep}） */
  sweep?: (options: TempSweepOptions) => Promise<TempSweepReport>;
}

/**
 * **启动时那一拍**：读档 →（必要时说破写错的开关）→ 扫一轮 → 落 `temp/swept` 事件 → 打一行账。
 *
 * 为什么整段抽出来（而不是留在 `main.ts` 里三行）：`runMain` 目前**没有任何测试覆盖**
 * （见 `test/main-entry.test.ts` 文件头），把这段留在它里面就等于"启动到底按哪一档跑、
 * 事件到底落不落"只能靠肉眼复查。抽出来之后 `test/temp-sweep.test.ts` 能拿一个假 logger +
 * 假事件口 + 自己的临时根把这条路径整条跑一遍（`IRMIA_TEMP_SWEEP` 未设 ⇒ 必须是 `dry`、
 * 必须落一条 `deleted=0` 的 `temp/swept`）。
 *
 * 分寸：`off` ⇒ 不扫（`runTempSweep` 立刻返回）也**不落事件**——"关掉了"不是一次"扫了零个"的账；
 * 扫不动 ⇒ 不抛（`runTempSweep` 自己吞掉），照样打一行说明。
 */
export async function runStartupTempSweep(options: StartupTempSweepOptions): Promise<TempSweepReport> {
  const { plan } = options;
  if (plan.problem !== '') options.log(`[临时目录] ${plan.problem}`);
  const sweep = options.sweep ?? runTempSweep;
  const report = await sweep({
    mode: plan.mode,
    ...(options.root === undefined ? {} : { root: options.root }),
  });
  if (report.mode !== 'off') {
    options.append?.('temp/swept', tempSweptPayload(report), 'internal');
  }
  options.log(formatTempSweepLine(report));
  return report;
}

/** 递归求字节数（只统计**不跟随符号链接**；读不动就按 0 算——它是账，不是判据） */
async function sizeOf(path: string): Promise<number> {  let stat;
  try {
    stat = await lstat(path);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch {
    return 0;
  }
  for (const entry of entries) total += await sizeOf(join(path, entry));
  return total;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
