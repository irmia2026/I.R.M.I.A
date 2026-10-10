/**
 * Irmia Agent — **后端保活前端**（A 项）：主进程看着界面，界面意外没了就把它拉回来。
 *
 * 用户的原话：「后端（主进程）要看着界面 —— 界面意外没了就把它重新拉起来（不能只是"不管"）」，
 * 同时立了一条**硬约束**：「不许与用户的意愿打架：用户主动关掉界面（或退出）时不许自动拉回来」。
 * 这个文件就是那两句话的落点，两件事各占一半：
 *
 *   · **看着**：每 `intervalMs`（默认 15 秒）按**可执行文件全路径**问一次"它还在吗"；
 *   · **不许打架**：见下面「主动退出 vs 崩溃」——判据只有一处，就在 `markerStateOf()`。
 *
 * ──────────────────────── 「他主动退的」与「崩了/被杀了」怎么分（协议逐条） ────────────────────────
 *
 * 两端握手，载体是**一个短时效标记文件** `<dataDir>/gui-quit.marker`：
 *
 *   ① **界面侧**（优雅退出前，例如托盘「退出」与点窗口 × 走到 `windowManager.destroy()` 之前）
 *      写一次这个文件，内容 `{ ts, pid, reason }`（`ts` = 它写下的那一刻，ISO 8601）；
 *   ② **后端侧**每一拍先看它：标记**新鲜**（`now - ts ≤ markerTtlMs`，默认 5 分钟）
 *      ⇒ 判定"他主动退的" ⇒ **只记账，不拉起**，随后**把这个标记消费掉（删除）**；
 *   ③ 标记**过期或不存在** ⇒ 判定"崩了/被杀了" ⇒ 才走拉起；
 *   ④ **消费**这一步是必需的：不消费，一次主动退出会永久压住"此后所有崩溃的拉起"
 *      （用户今天关了一次界面 ⇒ 明天她崩了却再也拉不起来，而且看起来像"保活没生效"）。
 *      消费之后，TTL 只负责"别把很久以前那次主动退出算到现在的崩溃头上"。
 *
 * **为什么必须两端一起**：进程退出本身分不出这两种。界面是一个 Flutter 窗口进程，
 * 托盘「退出」与点 × 都是 `windowManager.destroy()`，崩溃也是进程消失——**从外面看一字不差**，
 * 退出码也读不到（它不是我们的子进程）。所以判据只能由界面**在退出之前**留下。
 *
 * **现状（2026-10-11 起）**：上面第 ① 条**界面那一半已经接上**（v50 这一代：`gui/lib/gui_quit.dart`，
 * 关窗 `gui/lib/main.dart:85` 与托盘退出 `gui/lib/shell/tray.dart:150` 各写一次，收进托盘不写；`b5d68ce`）。
 * **唯一的例外是旧构建的界面**（那个 exe 里没有这段代码）：它不写标记 ⇒ 标记永远不会出现，
 * 用户**主动**关界面会被判成崩溃、被拉回来（上限见下，最长 2 个窗口 = 6 次，之后永久停手并报警）。
 * 要立刻停掉保活：建一个空文件 `<dataDir>/gui-guard.off`，或把环境变量 `IRMIA_GUI_GUARD`
 * 设成 `off` / `watch`（见 `resolveGuardMode()`）。
 *
 * ──────────────────────── 不许误拉（四条各自独立的闸） ────────────────────────
 *
 *   ① **全路径判活，绝不按文件名**（今晚踩过"按名字误杀"的坑）：枚举进程时先按文件名粗筛，
 *      **最终判据是 `ExecutablePath` 与目标全路径逐字相等**（大小写无关）。名字相同、
 *      装在别处的另一个界面不会被认成"它还在"，因此也不会因为它不在而误拉一个出来；
 *   ② **连续两次确认**（默认 2）：一次探活失败（powershell 超时/抛错）与"确认没有这个进程"
 *      必须分开——探活**抛错**只记账不拉起；探活成功但列表为空才算"没了"，而且要**连续两次**；
 *   ③ **拉起器活跃期不插手**：重启脚本与 self-restart 都会先停界面、再拉起来，
 *      它们干活期间（`data/restart-trace.log` 的 mtime 在 `launcherQuietMs` 内）我们**只看着**
 *      ——否则会出现两个界面（脚本拉一个、我们拉一个）；
 *   ④ **拉起之后给启动时间**（`startupGraceMs`）：界面起来要加载 DLL 与 `data\`，
 *      立刻复判"它还没在"会白烧一次配额、还会连拉两次。
 *
 * ──────────────────────── 拉起上限与告警 ────────────────────────
 *
 *   · 滚动窗口 `windowMs`（默认 5 分钟）内最多拉 `maxRelaunchPerWindow` 次（默认 3）；
 *   · 超限 ⇒ **不再拉**，写一条 `capped` 记录 + **告警**（"别无限重启"）；
 *   · 连续 `maxExhaustedWindows` 个窗口（默认 2）都用满仍救不回来 ⇒ **永久停手**，
 *     写一条 `given-up` 记录 + 再报一次警：界面每起来就又没了，多半不是"意外掉了"，
 *     接着拉只会变成对着人刷窗口。之后要恢复只能重启后端（这一次的判断不落盘）。
 *
 * ──────────────────────── 拉起的形状（一字不改，只有一条） ────────────────────────
 *
 *   `Start-Process -FilePath <exe 绝对路径> -WorkingDirectory <exe 所在目录>`
 *
 * 这条形状是实测钉下来的（`docs/restart-gui-launch-shape.md`：`cmd /s /c` + `>>` 那一族的根因
 * 是"重定向目标恰好被外层持有"，五个格子四失败一成功，`Start-Process` 那一格是唯一稳定成功的）。
 * 所以这里**不重定向**（`Start-Process` 默认就不重定向，恰恰是那条根因的对立面）、
 * **不用 `cmd /s /c`、不用 `npx`**、工作目录**显式给 exe 所在目录**（Flutter 产物要就地找
 * `flutter_windows.dll` 与 `data\`，工作目录给错会"起来就自己退"而拉起那一层照样报成功）。
 *
 * 目标路径**只从环境变量进**（与 `restart-worker.stopGuiByPath` 同一手法），
 * 于是这段脚本里没有一个外来字符串，引号问题在构造上就不存在。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveRestartShell } from './restart-shell.ts';

// ──────────────────────────────── 常量与文件名 ────────────────────────────────

/** 用户主动退出界面的标记（界面在优雅退出前写它）。短时效，看过即消费 */
export const GUI_QUIT_MARKER_NAME = 'gui-quit.marker';
/** 保活总闸：这个文件在 ⇒ 只看着、绝不拉起（用户一句话就能停掉它） */
export const GUI_GUARD_OFF_FILE_NAME = 'gui-guard.off';
/** 界面 exe 路径的落点（一行，`#` 开头是注释）：自动发现找不到时的明路 */
export const GUI_PATH_FILE_NAME = 'gui-path.txt';
/** 拉起器的留痕（重启脚本与 self-restart 都写它）：用它判"拉起器正在干活" */
export const RESTART_TRACE_FILE_NAME = 'restart-trace.log';

/**
 * 每 N 秒看一眼。**为什么是 15 秒**：
 *   · 上界：确认两次 ⇒ 从"界面没了"到"拉起来"最多 2×15=30 秒。人不会觉得"它不管我"；
 *   · 下界：每一拍要起一个 powershell 去做 CIM 查询（本机实测约 100~300 毫秒 CPU），
 *     15 秒一拍 = 每分钟 4 次，相对后端自身的负载可以忽略；
 *   · 它远小于标记 TTL（5 分钟）与拉起器静默窗（5 分钟），所以这两条判据不会因采样太稀而漏。
 * 用户给的范围是 10~30 秒，取中间偏小的一侧：界面掉了要**快**，而 4 次/分钟的代价**小**。
 */
export const DEFAULT_INTERVAL_MS = 15_000;
/** 标记的新鲜期：超过它就不再算"他刚才主动退的" */
export const DEFAULT_MARKER_TTL_MS = 300_000;
/** 连续两次确认才算"真的没了"（一次探活可能只是 powershell 打嗝） */
export const DEFAULT_CONFIRMATIONS = 2;
/** 拉起之后给它多久启动（这期间不判"还没在"，也不烧配额） */
export const DEFAULT_STARTUP_GRACE_MS = 60_000;
/** 拉起器留痕在这段时间内被写过 ⇒ 它正在干活，我们不插手 */
export const DEFAULT_LAUNCHER_QUIET_MS = 300_000;
/** 滚动窗口与窗口内的拉起上限（用户给的口径：5 分钟内最多 3 次） */
export const DEFAULT_WINDOW_MS = 300_000;
export const DEFAULT_MAX_RELAUNCH_PER_WINDOW = 3;
/** 连续几个窗口都用满配额 ⇒ 永久停手（2 个窗口 = 最多 6 次，之后不再打扰人） */
export const DEFAULT_MAX_EXHAUSTED_WINDOWS = 2;
/** 探活子进程的超时（毫秒）：超过就当这次探活失败，绝不把它当"界面没了" */
export const PROBE_TIMEOUT_MS = 20_000;

// ──────────────────────────────── 退出标记：协议本体 ────────────────────────────────

export interface GuiQuitMarker {
  /** 界面写下它的时刻（ISO 8601）——新鲜度判据就靠它 */
  ts: string;
  /** 写下它的界面进程 pid（人读用；不参与判定） */
  pid: number | null;
  /** 为什么退（人读用，例如 `tray-quit` / `window-close`） */
  reason: string;
}

export type GuiQuitMarkerState = 'absent' | 'fresh' | 'expired' | 'unreadable';

export interface GuiQuitMarkerReading {
  state: GuiQuitMarkerState;
  record: GuiQuitMarker | null;
  /** 距写下它过了多久（毫秒）；读不到时间戳时为 null */
  ageMs: number | null;
  file: string;
}

export function guiQuitMarkerPath(dataDir: string): string {
  return join(dataDir, GUI_QUIT_MARKER_NAME);
}

/** 界面自己的应用目录名（`%APPDATA%\Irmia\...`：界面已经把会话凭据与界面偏好存在这儿） */
export const GUI_APP_DIR_NAME = 'Irmia';

/**
 * **第二个落点**：`%APPDATA%\Irmia\gui-quit.marker`。为什么要第二个（2026-10-11）：
 *
 * 界面**不知道后端的 dataDir**（它只知道本地服务地址；而这次部署里后端跑在开发仓库
 * `<repo>\data`，界面却在 `D:\IrmiaAgent\agent\...`）。要它写
 * `<dataDir>/gui-quit.marker`，就得先把 dataDir 铺到它手里——那要么改拉起的形状
 * （用户刚把 `Start-Process -FilePath <exe> -WorkingDirectory <目录>` 这条钉死，不该动），
 * 要么让界面去猜。而 `%APPDATA%\Irmia\` 是**两端都算得出来**的同一个目录
 * （界面本来就往那儿写 `sessions\<实例>` 与 `ui-state.json`），所以界面写这个标记
 * **一个路径都不用知道**，三行 Dart 就够。
 *
 * 后端两处都认（新鲜的那个算数，消费时两处一起删）：`<dataDir>` 那一处留给脚本与
 * 别的半边（`--mark-gui-quit`），`%APPDATA%` 那一处留给界面。协议本身只有一条。
 */
export function guiQuitMarkerPaths(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
): readonly string[] {
  const paths = [guiQuitMarkerPath(dataDir)];
  const appData = (env['APPDATA'] ?? '').trim();
  if (appData !== '') paths.push(join(appData, GUI_APP_DIR_NAME, GUI_QUIT_MARKER_NAME));
  return paths;
}

/**
 * 写「我主动退了」的标记（**界面那一半要用它**；`--mark-gui-quit` 也走这条）。
 * 写盘失败**不抛**：退出路径上写不下一个标记，不该把界面自己也拦下来。
 */
export function writeGuiQuitMarker(
  dataDir: string,
  input: {
    now?: () => Date;
    pid?: number | null;
    reason?: string;
    /** 写哪几处；缺省只写 `<dataDir>`（权威落点）。`--mark-gui-quit` 两处都写 */
    targets?: readonly string[];
  },
): { ok: boolean; file: string } {
  const now = input.now ?? (() => new Date());
  const targets = input.targets ?? [guiQuitMarkerPath(dataDir)];
  const record: GuiQuitMarker = {
    ts: now().toISOString(),
    pid: input.pid ?? null,
    reason: input.reason ?? 'gui-quit',
  };
  const text = `${JSON.stringify(record, null, 2)}\n`;
  let ok = false;
  for (const file of targets) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text, 'utf8');
      ok = true;
    } catch {
      // 某一处写不下去不影响另一处：退出路径上写不下一个标记，不该把界面自己也拦下来
    }
  }
  return { ok, file: targets.join('、') };
}

/** 只读一处标记文件（`readGuiQuitMarker` 逐个落点调它） */
function readOneMarker(file: string, now: () => number, ttlMs: number): GuiQuitMarkerReading {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { state: 'absent', record: null, ageMs: null, file };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'unreadable', record: null, ageMs: null, file };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { state: 'unreadable', record: null, ageMs: null, file };
  }
  const obj = parsed as Record<string, unknown>;
  const ts = obj['ts'];
  if (typeof ts !== 'string') return { state: 'unreadable', record: null, ageMs: null, file };
  const at = Date.parse(ts);
  if (!Number.isFinite(at)) return { state: 'unreadable', record: null, ageMs: null, file };
  const pidRaw = obj['pid'];
  const record: GuiQuitMarker = {
    ts,
    pid: typeof pidRaw === 'number' && Number.isInteger(pidRaw) ? pidRaw : null,
    reason: typeof obj['reason'] === 'string' ? obj['reason'] : '',
  };
  const ageMs = now() - at;
  // 时钟回拨会让 ageMs 为负：那是**刚写的**，按新鲜处理（与 instance-lock 同一条保守口径）
  return { state: ageMs <= ttlMs ? 'fresh' : 'expired', record, ageMs, file };
}

/**
 * 读标记并判新鲜度。**判据只有这一处**（后端每一拍、`--status`、测试全走它）。
 *
 * 三个落点里**取最新鲜的那一份**（存在且 ageMs 最小的）：于是"界面写在 %APPDATA%、
 * 脚本写在 dataDir"两边同时留下痕迹时，说的是最近那次主动退出。
 *
 * 三种"不新鲜"分得很清楚：不存在（常态）、过期（可能很久以前那次主动退）、
 * 读不懂（写到一半被杀 / 外部改写）——后两种都**按崩溃处理**：
 * 宁可多拉一次界面，也不要该拉的时候不拉；而"主动退"这条路上界面是**先写标记再退**的，
 * 写不完整就说明它不是走那条路退的。
 */
export function readGuiQuitMarker(
  dataDir: string,
  options: { now?: () => number; ttlMs?: number; env?: Record<string, string | undefined> } = {},
): GuiQuitMarkerReading {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_MARKER_TTL_MS;
  const paths = guiQuitMarkerPaths(dataDir, options.env ?? process.env);
  let best: GuiQuitMarkerReading | null = null;
  let fallback: GuiQuitMarkerReading | null = null;
  for (const file of paths) {
    const reading = readOneMarker(file, now, ttlMs);
    if (reading.state === 'absent') continue;
    // 读不懂的没有 ageMs：它按崩溃处理，所以只在没有任何新鲜标记时才让"读不懂"顶上来
    if (reading.ageMs === null) {
      fallback ??= reading;
      continue;
    }
    if (reading.state === 'fresh') {
      if (best === null || (best.ageMs ?? Number.POSITIVE_INFINITY) > reading.ageMs) best = reading;
      continue;
    }
    fallback ??= reading;
  }
  return best ?? fallback ?? { state: 'absent', record: null, ageMs: null, file: paths[0] ?? '' };
}

/** 消费（删除）标记：看过一次就不再压着后面的崩溃。**所有落点一起删**；删不掉不算错 */
export function consumeGuiQuitMarker(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  let consumed = false;
  for (const file of guiQuitMarkerPaths(dataDir, env)) {
    try {
      unlinkSync(file);
      consumed = true;
    } catch {
      // 没有那份文件 = 常态
    }
  }
  return consumed;
}

// ──────────────────────────────── 保活总闸 ────────────────────────────────

export type GuiGuardMode = 'relaunch' | 'watch' | 'off';

/**
 * 三档总闸（`IRMIA_GUI_GUARD` 环境变量 > `<dataDir>/gui-guard.off` 文件 > 默认）：
 *
 *   · `relaunch`（**默认**）——看着并拉起，这是用户这一批要的那件事；
 *   · `watch`    ——只看着、把每次"界面没了"如实记账，**一个进程都不拉**；
 *   · `off`      ——连看都不看。
 *
 * 为什么要有 `watch` 而不只有开关：保活与"用户主动关界面"之间的判据随时可能再出岔
 * （界面那一半已接线，见文件头那条现状；**旧构建的界面**照旧会被误判成崩溃）。他关界面时若被打扰，
 * `watch` 是"我还要这份观测、但不要你动手"的那一档；`off` 则是"整件事先停下"。
 * 两个名字都写在启动日志里，他要改不必翻文档。
 */
export function resolveGuardMode(env: Record<string, string | undefined>, dataDir: string): {
  mode: GuiGuardMode;
  why: string;
} {
  const offFile = join(dataDir, GUI_GUARD_OFF_FILE_NAME);
  const raw = (env['IRMIA_GUI_GUARD'] ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'watch' || raw === 'relaunch') {
    return { mode: raw, why: `环境变量 IRMIA_GUI_GUARD=${raw}` };
  }
  if (raw !== '') {
    return { mode: 'watch', why: `环境变量 IRMIA_GUI_GUARD=${raw} 不是 off/watch/relaunch 之一 ⇒ 退到"只看不拉"` };
  }
  if (existsSync(offFile)) {
    return { mode: 'watch', why: `存在 ${offFile}（要整件事停下：把 IRMIA_GUI_GUARD 设成 off 并重启后端）` };
  }
  return { mode: 'relaunch', why: '默认（未设置 IRMIA_GUI_GUARD，也没有 gui-guard.off）' };
}

// ──────────────────────────────── 界面 exe 路径从哪来 ────────────────────────────────

export interface GuiExeDiscovery {
  exe: string;
  /** 路径是从哪儿读到的（人读；出问题时第一句就要看它） */
  source: string;
}

/** 读文件尾 N 字节（留痕可能很大；要看的是**最近一次**拉起） */
export function readTail(file: string, maxBytes: number): string {
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    // 不用 readSync 的 position 参数：拿整段再切，代码短且不依赖 fs 的偏移语义
    const text = readFileSync(file, 'utf8');
    return start === 0 ? text : text.slice(-maxBytes);
  } catch {
    return '';
  }
}

/**
 * 从拉起器留痕里认出**最近一次用过的界面 exe**。
 *
 * 四条模式各自锚在一个**只可能出现在界面那一支**的字段上（不是"抓一个 .exe 路径"那种松判据
 * ——那样会抓到 `node.exe`、`pwsh.exe`）。四条都来自两个拉起器真实的留痕行：
 *   · `GuiExe=<路径>（收到=…`      —— `[回执]` 那一行
 *   · `-GuiExe <路径>`             —— `完整命令行` 那一行
 *   · `-FilePath "<路径>" -WorkingDirectory` —— `Start-Process` 拉起读数
 *   · `界面进程（<路径>）`          —— restart-worker 的停界面那一行
 * **只认盘上真的存在的那个**：留痕里可能留着已卸载安装的路径。
 */
export function discoverGuiExe(input: {
  dataDir: string;
  env: Record<string, string | undefined>;
  fileExists: (path: string) => boolean;
  readTrace?: (file: string) => string;
}): GuiExeDiscovery | null {
  const { dataDir, env, fileExists } = input;
  /**
   * 两个**显式**来源（环境变量、`gui-path.txt`）指到盘上没有的东西时**返回 null**，
   * 不退回自动发现：人会写错一个字母，而"你说的是 A、我用的却是 B"正是最难查的那类故障
   * （下面 `gui-path.txt` 那一支是同一条纪律）。只有留痕那一条是自动发现
   * ——它本来就只是"最近一次真的用过哪个"。
   */
  const explicit = (env['IRMIA_GUI_EXE'] ?? '').trim();
  if (explicit !== '') {
    return fileExists(explicit) ? { exe: explicit, source: '环境变量 IRMIA_GUI_EXE' } : null;
  }

  const pathFile = join(dataDir, GUI_PATH_FILE_NAME);
  try {
    for (const line of readFileSync(pathFile, 'utf8').split(/\r?\n/u)) {
      const text = line.trim();
      if (text === '' || text.startsWith('#')) continue;
      if (fileExists(text)) return { exe: text, source: `文件 ${pathFile}` };
      return null; // 写进去的那一行不存在：不猜、不退回留痕——写这份文件的人就是在显式指定
    }
  } catch {
    // 没有这份文件 = 常态
  }

  const trace = join(dataDir, RESTART_TRACE_FILE_NAME);
  const readTrace = input.readTrace ?? ((file: string) => readTail(file, 256 * 1024));
  const text = readTrace(trace);
  if (text === '') return null;
  const patterns: readonly RegExp[] = [
    /GuiExe=([^\s（(]+\.exe)/gu,
    /-GuiExe\s+([^\s"']+\.exe)/gu,
    /-FilePath\s+"([^"]+\.exe)"\s+-WorkingDirectory/gu,
    /界面进程（([^）]+\.exe)）/gu,
  ];
  let best: { index: number; exe: string } | null = null;
  for (const pattern of patterns) {
    // 每次重新 lastIndex：正则带 g，复用同一个实例会从上次位置继续
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const exe = (match[1] ?? '').trim();
      if (exe === '' || !fileExists(exe)) continue;
      const index = match.index ?? 0;
      if (best === null || index > best.index) best = { index, exe };
    }
  }
  if (best === null) return null;
  return { exe: best.exe, source: `拉起器留痕 ${trace}` };
}

// ──────────────────────────────── 探活与拉起（注入点 + 真实实现） ────────────────────────────────

export interface GuiLaunchResult {
  ok: boolean;
  /** `Start-Process -PassThru` 给的 pid；0 = 没拿到 */
  pid: number;
  /** 人读的一句话（失败时是原因） */
  note: string;
}

/** 按 exe 全路径枚举进程的探针脚本。**目标只从环境变量进**（构造上不存在引号问题） */
export const GUI_PROBE_SCRIPT = [
  '$target = [System.IO.Path]::GetFullPath($env:IRMIA_GUI_GUARD_EXE)',
  "$name = [System.IO.Path]::GetFileName($target)",
  '$pids = @()',
  "foreach ($p in @(Get-CimInstance Win32_Process -Filter \"Name = '$name'\" -ErrorAction SilentlyContinue)) {",
  '  $path = $p.ExecutablePath',
  '  if (-not $path) { continue }',
  '  try { $full = [System.IO.Path]::GetFullPath($path) } catch { continue }',
  '  if ($full -ieq $target) { $pids += $p.ProcessId }',
  '}',
  "Write-Output ('PIDS=' + ($pids -join ','))",
].join('\n');

/**
 * 拉起脚本：**已确立的那条形状，一字不改**。
 * `-PassThru` 拿到的 pid 就是界面自己（这条形状没有 cmd 壳）；默认不重定向。
 */
export const GUI_LAUNCH_SCRIPT = [
  '$exe = $env:IRMIA_GUI_GUARD_EXE',
  '$dir = $env:IRMIA_GUI_GUARD_DIR',
  'try {',
  '  $p = Start-Process -FilePath $exe -WorkingDirectory $dir -PassThru -ErrorAction Stop',
  "  Write-Output ('PID=' + $p.Id)",
  '} catch {',
  "  Write-Output ('ERR=' + $_.Exception.GetType().FullName + ' :: ' + $_.Exception.Message)",
  '}',
].join('\n');

export interface GuiProcessIo {
  /** 探活：**抛错 = 这次没问出来**（绝不是"它不在了"）；`[]` = 确认没有这个路径的进程 */
  listPids: (exe: string) => Promise<number[]>;
  /** 按既定形状拉起；返回 pid 与读数（真实实现是同步的，测试里常给异步替身） */
  launch: (exe: string) => GuiLaunchResult | Promise<GuiLaunchResult>;
}

function resolveShell(): string {
  return resolveRestartShell({ env: process.env, fileExists: existsSync });
}

export function listPidsByExePath(exe: string, shell = resolveShell()): Promise<number[]> {
  return new Promise<number[]>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', GUI_PROBE_SCRIPT], {
      env: { ...process.env, IRMIA_GUI_GUARD_EXE: exe },
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 杀不掉也照旧往下走：这次探活算失败 */ }
      reject(new Error(`探活超时（${PROBE_TIMEOUT_MS} 毫秒）：${shell}`));
    }, PROBE_TIMEOUT_MS);
    timer.unref();
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 判据是那一行 `PIDS=`：没有它 = 这次没问出来，**绝不当成"它不在了"**
      const match = /PIDS=([0-9,\s]*)/u.exec(stdout);
      if (match === null) {
        reject(new Error(`探活没有得到读数（退出码 ${String(code)}）：${(stderr.trim() || stdout.trim()).slice(0, 200)}`));
        return;
      }
      const pids = (match[1] ?? '')
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);
      resolve(pids);
    });
  });
}

/**
 * 按既定形状拉起界面。**同步**（`spawnSync`）：这一步必须拿到"到底起没起来"的读数，
 * 而它是人可感知的偶发动作（不是每一拍都跑），阻塞几百毫秒无所谓。
 */
export function launchGuiByStartProcess(exe: string, shell = resolveShell()): GuiLaunchResult {
  const probe = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', GUI_LAUNCH_SCRIPT], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    env: { ...process.env, IRMIA_GUI_GUARD_EXE: exe, IRMIA_GUI_GUARD_DIR: dirname(exe) },
    windowsHide: true,
  });
  const out = `${probe.stdout ?? ''}`.trim();
  const fail = /ERR=(.*)/u.exec(out);
  if (fail !== null) return { ok: false, pid: 0, note: `拉起失败：${(fail[1] ?? '').trim()}` };
  const pidMatch = /PID=(\d+)/u.exec(out);
  if (pidMatch === null) {
    const detail = (probe.stderr ?? '').trim() || out;
    return { ok: false, pid: 0, note: `拉起没有读数（退出码 ${String(probe.status)}）：${detail.slice(0, 200)}` };
  }
  return { ok: true, pid: Number(pidMatch[1]), note: `Start-Process pid ${pidMatch[1]}` };
}

// ──────────────────────────────── 保活循环 ────────────────────────────────

export type GuiGuardOutcome =
  | 'gui-gone'
  | 'relaunched'
  | 'watch-only'
  | 'launch-failed'
  | 'paused-by-quit-marker'
  | 'launcher-active'
  | 'probe-failed'
  | 'capped'
  | 'given-up'
  | 'gui-back';

/** 一次判定的**原因 + 结果**：宿主把它落成 `runtime/gui-relaunch`（internal） */
export interface GuiGuardRecord {
  outcome: GuiGuardOutcome;
  /** 为什么这么判（人话） */
  reason: string;
  /** 读数（原因与结果都在里面：pid、窗口内第几次、上限、路径…） */
  detail: Record<string, unknown>;
}

export interface GuiGuardAlert {
  /** 与 `alert/notifier.ts` 的 AlertLevel 同口径（超限是 warn，永久停手是 critical） */
  level: 'warn' | 'critical';
  title: string;
  body: string;
  /** 告警指纹参数（同类告警靠它限流） */
  params: Record<string, string | number | boolean>;
}

export interface GuiGuardOptions {
  dataDir: string;
  /** 界面 exe 全路径（由 `discoverGuiExe` 解析；解析不到就别建这个守卫） */
  exe: string;
  /** 路径来源（写进记录，出问题时第一眼看它） */
  exeSource: string;
  mode?: GuiGuardMode;
  io: GuiProcessIo;
  /** 每一拍的决定都走它（宿主写 internal 事件 + stdout） */
  record: (record: GuiGuardRecord) => void;
  /** 超限/永久停手时的报警出口（宿主接 notifier） */
  alert?: (alert: GuiGuardAlert) => void;
  intervalMs?: number;
  markerTtlMs?: number;
  confirmations?: number;
  startupGraceMs?: number;
  launcherQuietMs?: number;
  windowMs?: number;
  maxRelaunchPerWindow?: number;
  maxExhaustedWindows?: number;
  now?: () => number;
  /** 环境变量（用来算 `%APPDATA%` 那个标记落点）；缺省 `process.env`。测试注入以保持封闭 */
  env?: Record<string, string | undefined>;
  /** 拉起器留痕的 mtime（毫秒）；读不到给 null。注入以便测试 */
  launcherMtime?: () => number | null;
  /** 吃掉探活里的 unhandled rejection（测试里用）；默认 console 之外不输出 */
  onError?: (err: unknown) => void;
}

export interface GuiGuard {
  /** 先跑一拍再挂定时器（布防当场就有一次读数），幂等 */
  start(): void;
  /** 停掉定时器（退出路径）；幂等 */
  stop(): void;
  /** 跑一拍（测试直接调它，不必等定时器） */
  tick(): Promise<void>;
  /** 运行期读数（启动日志与 `--status` 都用它） */
  status(): GuiGuardStatus;
}

export interface GuiGuardStatus {
  mode: GuiGuardMode;
  exe: string;
  intervalMs: number;
  maxRelaunchPerWindow: number;
  windowMs: number;
  /** 窗口内已拉起次数 */
  relaunchesInWindow: number;
  /** 连续用满配额的窗口数 */
  exhaustedWindows: number;
  /** 已经永久停手了 */
  givenUp: boolean;
  /** 连续确认"没了"的次数（0 = 上一次看到它还活着） */
  missingStreak: number;
  /** 最近一次拉起结果 */
  lastLaunch: GuiLaunchResult | null;
}

interface ResolvedGuardOptions {
  dataDir: string;
  exe: string;
  exeSource: string;
  mode: GuiGuardMode;
  io: GuiProcessIo;
  record: (record: GuiGuardRecord) => void;
  alert: ((alert: GuiGuardAlert) => void) | undefined;
  intervalMs: number;
  markerTtlMs: number;
  confirmations: number;
  startupGraceMs: number;
  launcherQuietMs: number;
  windowMs: number;
  maxRelaunchPerWindow: number;
  maxExhaustedWindows: number;
  now: () => number;
  env: Record<string, string | undefined>;
  launcherMtime: () => number | null;
  onError: ((err: unknown) => void) | undefined;
}

function resolveGuardOptions(options: GuiGuardOptions): ResolvedGuardOptions {
  const dataDir = options.dataDir;
  return {
    dataDir,
    exe: options.exe,
    exeSource: options.exeSource,
    mode: options.mode ?? 'relaunch',
    io: options.io,
    record: options.record,
    alert: options.alert,
    intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
    markerTtlMs: options.markerTtlMs ?? DEFAULT_MARKER_TTL_MS,
    confirmations: options.confirmations ?? DEFAULT_CONFIRMATIONS,
    startupGraceMs: options.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS,
    launcherQuietMs: options.launcherQuietMs ?? DEFAULT_LAUNCHER_QUIET_MS,
    windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
    maxRelaunchPerWindow: options.maxRelaunchPerWindow ?? DEFAULT_MAX_RELAUNCH_PER_WINDOW,
    maxExhaustedWindows: options.maxExhaustedWindows ?? DEFAULT_MAX_EXHAUSTED_WINDOWS,
    now: options.now ?? Date.now,
    env: options.env ?? process.env,
    launcherMtime: options.launcherMtime ?? (() => {
      try {
        return statSync(join(dataDir, RESTART_TRACE_FILE_NAME)).mtimeMs;
      } catch {
        return null;
      }
    }),
    onError: options.onError,
  };
}

class GuiGuardImpl implements GuiGuard {
  private readonly opts: ResolvedGuardOptions;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  /** 连续确认"没了"的次数 */
  private missingStreak = 0;
  /** 已经确认没了、正在等它起来（起来那一刻记一条 `gui-back`） */
  private awaitingBack = false;
  /** 窗口内每次拉起（被拉起的时刻） */
  private readonly launchTimes: number[] = [];
  /** 连续用满配额的窗口数 */
  private exhaustedWindows = 0;
  private givenUp = false;
  /** 上一次拉起之后给它的启动时间到什么时候 */
  private settleUntil = 0;
  private lastLaunch: GuiLaunchResult | null = null;
  /** 上一个窗口已经记过 `capped` 了（同一个窗口只报一次） */
  private cappedWindowReported = false;
  /** 上一类"粘住"的记录（探活失败 / 拉起器活跃 / 只看不拉）：同一类连着来只记一次，别刷屏 */
  private lastSticky: GuiGuardOutcome | null = null;

  constructor(options: ResolvedGuardOptions) {
    this.opts = options;
  }

  /**
   * 记一条"会持续若干拍"的判定：**同一类连着来只落一条**。
   * 探活失败每 15 秒一次、拉起器活跃能持续 5 分钟——每次都写事件会把日志刷满，
   * 而它们说的是同一件事。界面一旦回来（或真的拉起了）就清掉，下一轮重新记。
   */
  private recordSticky(record: GuiGuardRecord): boolean {
    if (this.lastSticky === record.outcome) return false;
    this.lastSticky = record.outcome;
    this.opts.record(record);
    return true;
  }

  start(): void {
    if (this.timer !== null || this.stopped) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.opts.intervalMs);
    // 定时器不阻止进程退出：主循环才是唯一的存活理由（与 instance-lock 的心跳同一条纪律）
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  status(): GuiGuardStatus {
    this.pruneWindow();
    return {
      mode: this.opts.mode,
      exe: this.opts.exe,
      intervalMs: this.opts.intervalMs,
      maxRelaunchPerWindow: this.opts.maxRelaunchPerWindow,
      windowMs: this.opts.windowMs,
      relaunchesInWindow: this.launchTimes.length,
      exhaustedWindows: this.exhaustedWindows,
      givenUp: this.givenUp,
      missingStreak: this.missingStreak,
      lastLaunch: this.lastLaunch,
    };
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      // 上一拍还没回来（探活慢）：**跳过这一拍**而不是叠着发一个 powershell
      return;
    }
    this.running = true;
    try {
      await this.tickInner();
    } catch (err) {
      this.opts.record({
        outcome: 'probe-failed',
        reason: `这一拍没跑完（不改判定、不拉起）：${err instanceof Error ? err.message : String(err)}`,
        detail: { exe: this.opts.exe, exeSource: this.opts.exeSource },
      });
      const hook = this.opts.onError;
      if (hook !== undefined) hook(err);
    } finally {
      this.running = false;
    }
  }

  private pruneWindow(): void {
    const floor = this.opts.now() - this.opts.windowMs;
    while (this.launchTimes.length > 0 && (this.launchTimes[0] ?? 0) < floor) this.launchTimes.shift();
  }

  private async tickInner(): Promise<void> {
    if (this.givenUp) return;
    const nowMs = this.opts.now();

    // ① 拉起之后先给它启动时间：这期间不判"还没在"，也不烧配额
    if (nowMs < this.settleUntil) return;

    // ② 探活。**抛错 = 这次没问出来**：只记账，绝不据此拉起
    let pids: number[];
    try {
      pids = await this.opts.io.listPids(this.opts.exe);
    } catch (err) {
      this.missingStreak = 0;
      this.recordSticky({
        outcome: 'probe-failed',
        reason: `这一拍没问出界面在不在（可能是 powershell 打嗝）⇒ 不拉起，等下一拍：`
          + `${err instanceof Error ? err.message : String(err)}`,
        detail: { exe: this.opts.exe, exeSource: this.opts.exeSource },
      });
      return;
    }

    if (pids.length > 0) {
      this.missingStreak = 0;
      // 界面在跑：清掉"粘住"的记账，下一次真的没了会重新记一条
      this.lastSticky = null;
      if (this.awaitingBack) {
        this.awaitingBack = false;
        // 界面回来了：把一个窗口的"用满配额"记账清掉（它这次真的活下来了）
        this.exhaustedWindows = 0;
        this.opts.record({
          outcome: 'gui-back',
          reason: '界面已经在跑（上一次拉起生效了）',
          detail: { exe: this.opts.exe, pids, exeSource: this.opts.exeSource },
        });
      }
      return;
    }

    // ③ 确认"没了"。探活成功但列表为空才算——而且要连续 confirmations 次
    this.missingStreak += 1;
    if (this.missingStreak < this.opts.confirmations) {
      return; // 第一次当"再确认一次"，不记账不动作（避免把 powershell 的一次空读数当崩溃）
    }

    // ④ 主动退出 vs 崩溃：**判据只有这一处**
    const marker = readGuiQuitMarker(this.opts.dataDir, {
      now: this.opts.now,
      ttlMs: this.opts.markerTtlMs,
      env: this.opts.env,
    });
    if (marker.state === 'fresh') {
      const consumed = consumeGuiQuitMarker(this.opts.dataDir, this.opts.env);
      this.missingStreak = 0;
      this.opts.record({
        outcome: 'paused-by-quit-marker',
        reason: `界面是被**主动**退掉的（标记 ${marker.file}，写下于 ${marker.record?.ts ?? '?'}`
          + `${marker.ageMs === null ? '' : `，${Math.round(marker.ageMs / 1000)} 秒前`}）⇒ 只记账，不拉回来`,
        detail: {
          exe: this.opts.exe,
          marker: marker.record,
          markerConsumed: consumed,
          markerAgeMs: marker.ageMs,
          exeSource: this.opts.exeSource,
        },
      });
      this.awaitingBack = false;
      return;
    }

    // ⑤ 拉起器正在干活（重启脚本 / self-restart 都是"先停界面、再拉起来"）：不插手，等它干完
    const traceMtime = this.opts.launcherMtime();
    if (traceMtime !== null && this.opts.now() - traceMtime < this.opts.launcherQuietMs) {
      this.missingStreak = 0; // 让它干完，之后重新连续确认两次再判
      this.recordSticky({
        outcome: 'launcher-active',
        reason: `拉起器 ${Math.round((this.opts.now() - traceMtime) / 1000)} 秒前还在写留痕`
          + `（${RESTART_TRACE_FILE_NAME}）⇒ 界面多半是它停的、也由它拉，我们不插手`,
        detail: { exe: this.opts.exe, traceAgeMs: this.opts.now() - traceMtime, exeSource: this.opts.exeSource },
      });
      return;
    }

    this.pruneWindow();
    if (this.launchTimes.length >= this.opts.maxRelaunchPerWindow) {
      if (!this.cappedWindowReported) {
        this.cappedWindowReported = true;
        this.exhaustedWindows += 1;
        const willGiveUp = this.exhaustedWindows >= this.opts.maxExhaustedWindows;
        this.opts.record({
          outcome: willGiveUp ? 'given-up' : 'capped',
          reason: willGiveUp
            ? `${this.opts.windowMs / 1000} 秒的窗口里已经拉过 ${this.launchTimes.length} 次（连续 ${this.exhaustedWindows} 个窗口都用满）`
              + `⇒ **永久停手**：界面每起来就又没了，接着拉只会变成对着人刷窗口。`
              + '要恢复保活请重启后端（这个判断不落盘），或先查界面为什么起不来'
            : `${this.opts.windowMs / 1000} 秒的窗口里已经拉过 ${this.launchTimes.length} 次`
              + `（上限 ${this.opts.maxRelaunchPerWindow}）⇒ 本轮不再拉，等窗口滚过去`,
          detail: {
            exe: this.opts.exe,
            attemptsInWindow: this.launchTimes.length,
            maxPerWindow: this.opts.maxRelaunchPerWindow,
            windowMs: this.opts.windowMs,
            exhaustedWindows: this.exhaustedWindows,
            exeSource: this.opts.exeSource,
          },
        });
        this.raiseAlert(willGiveUp ? 'critical' : 'warn', willGiveUp, {
          attemptsInWindow: this.launchTimes.length,
          maxPerWindow: this.opts.maxRelaunchPerWindow,
          exhaustedWindows: this.exhaustedWindows,
        });
        if (willGiveUp) this.givenUp = true;
      }
      return;
    }
    this.cappedWindowReported = false;

    // ⑥ watch 档：只记账
    if (this.opts.mode !== 'relaunch') {
      this.missingStreak = 0;
      this.recordSticky({
        outcome: 'watch-only',
        reason: '界面没了，但保活处在"只看不拉"这一档（IRMIA_GUI_GUARD=watch 或 gui-guard.off）⇒ 不拉',
        detail: { exe: this.opts.exe, mode: this.opts.mode, exeSource: this.opts.exeSource },
      });
      return;
    }

    // ⑦ 拉起（**已确立的那条形状**）
    this.missingStreak = 0;
    const launchedAt = this.opts.now();
    this.launchTimes.push(launchedAt);
    this.settleUntil = launchedAt + this.opts.startupGraceMs;
    const result = await this.opts.io.launch(this.opts.exe);
    this.lastLaunch = result;
    this.awaitingBack = true;
    this.lastSticky = null;
    this.opts.record({
      outcome: result.ok ? 'relaunched' : 'launch-failed',
      reason: result.ok
        ? `界面意外没了（连续 ${this.opts.confirmations} 次确认），已按既定形状拉起：`
          + '`Start-Process -FilePath <exe> -WorkingDirectory <exe 所在目录>`'
        : `界面意外没了，拉起这一步没成：${result.note}`,
      detail: {
        exe: this.opts.exe,
        workingDirectory: dirname(this.opts.exe),
        pid: result.pid,
        note: result.note,
        attemptInWindow: this.launchTimes.length,
        maxPerWindow: this.opts.maxRelaunchPerWindow,
        windowMs: this.opts.windowMs,
        startupGraceMs: this.opts.startupGraceMs,
        exeSource: this.opts.exeSource,
      },
    });
  }

  private raiseAlert(level: 'warn' | 'critical', gaveUp: boolean, params: Record<string, string | number | boolean>): void {
    const hook = this.opts.alert;
    if (hook === undefined) return;
    hook({
      level,
      title: gaveUp ? '界面保活已停止（连续两个窗口都拉不起来）' : '界面保活本轮超限',
      body: [
        gaveUp
          ? `界面（${this.opts.exe}）在连续 ${String(params['exhaustedWindows'])} 个窗口里都是"拉起来就又没了"，`
            + '保活已经**永久停手**——再拉下去只是对着人刷窗口。'
          : `界面（${this.opts.exe}）在 ${String(this.opts.windowMs / 1000)} 秒里被拉起 `
            + `${String(params['attemptsInWindow'])} 次（窗口上限 ${String(params['maxPerWindow'])}），本轮不再拉。`,
        `路径来自：${this.opts.exeSource}`,
        '要停掉保活：`IRMIA_GUI_GUARD=off` 重启后端（或 `=watch` 只保留观测）；',
        '要恢复一次永久停手：重启后端即可。',
      ].join('\n'),
      params,
    });
  }
}

/** 建保活守卫。**不接触进程**：`start()` 之后才会探活 */
export function createGuiGuard(options: GuiGuardOptions): GuiGuard {
  return new GuiGuardImpl(resolveGuardOptions(options));
}

// ──────────────────────────────── 命令行（协议的另一半：谁都能写这个标记） ────────────────────────────────

function isDirectRun(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return moduleUrl === pathToFileURL(entry).href;
}

function argValue(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  return argv[index + 1] ?? null;
}

function resolveDataDir(argv: readonly string[]): string {
  return argValue(argv, '--data-dir')
    ?? process.env['IRMIA_DATA_DIR']
    ?? join(process.cwd(), 'data');
}

function usage(): string {
  return [
    '用法（这条命令行就是"主动退出界面"协议的另一半，界面那一半见 docs/gui-guard.md §7）：',
    '  node dist/runtime/gui-guard.js --mark-gui-quit [--reason tray-quit] [--data-dir <dataDir>]',
    '      写"界面主动退出"标记（含时间戳）：后端看到**新鲜的**它就只记账、不把界面拉回来。',
    '      两处一起写：<dataDir>/gui-quit.marker 与 %APPDATA%\\Irmia\\gui-quit.marker',
    '      （后者是界面自己能够到的那个目录——它不知道后端的 dataDir，见 §7）。',
    '  node dist/runtime/gui-guard.js --status [--data-dir <dataDir>]',
    '      打印当前判据：保活档位、界面 exe 是从哪儿读到的、标记新不新鲜、拉起器留痕多久前写过。',
  ].join('\n');
}

/**
 * CLI 入口。**走 `import.meta.url` 直接运行判定**（与 `main.ts` 同一手法），
 * 所以它被 `main.ts` 导入时这一整段不会执行。
 */
async function runCli(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--mark-gui-quit')) {
    const reason = argValue(argv, '--reason') ?? 'gui-quit';
    const dataDir = resolveDataDir(argv);
    // 两处都写：脚本走 dataDir，界面走 %APPDATA%（它不需要知道 dataDir 在哪儿）
    const result = writeGuiQuitMarker(dataDir, {
      reason,
      pid: process.pid,
      targets: guiQuitMarkerPaths(dataDir),
    });
    // 退出路径上的写盘失败**不该**让界面自己被拦住：如实说一句，退出码仍是 0
    process.stdout.write(result.ok
      ? `已写下"界面主动退出"标记：${result.file}（后端看到新鲜标记就只记账、不拉回来）\n`
      : `标记写不下去（不影响退出）：${result.file}\n`);
    return 0;
  }
  if (argv.includes('--status')) {
    const dataDir = resolveDataDir(argv);
    const env = process.env;
    const gate = resolveGuardMode(env, dataDir);
    const found = discoverGuiExe({ dataDir, env, fileExists: existsSync });
    const marker = readGuiQuitMarker(dataDir);
    const traceAge = (() => {
      try {
        return Date.now() - statSync(join(dataDir, RESTART_TRACE_FILE_NAME)).mtimeMs;
      } catch {
        return null;
      }
    })();
    const lines = [
      '=== 界面保活（gui-guard）现状 ===',
      `数据目录: ${dataDir}`,
      `保活档位: ${gate.mode}（${gate.why}）`,
      `界面 exe: ${found === null ? '**找不到**（保活不会生效；用 IRMIA_GUI_EXE 或 ' + GUI_PATH_FILE_NAME + ' 指定）' : `${found.exe}（来自 ${found.source}）`}`,
      `退出标记: ${marker.state}${marker.record === null ? '' : `（${marker.record.ts}，${marker.record.reason}）`} · ${marker.file}`,
      `标记落点（两处都认）: ${guiQuitMarkerPaths(dataDir).join(' | ')}`,
      `拉起器留痕: ${traceAge === null ? '没有' : `${Math.round(traceAge / 1000)} 秒前写过`}（静默窗 ${DEFAULT_LAUNCHER_QUIET_MS / 1000} 秒内不插手）`,
    ];
    if (found !== null) {
      try {
        const pids = await listPidsByExePath(found.exe);
        lines.push(`此刻在跑的界面（按可执行文件全路径判）: ${pids.length === 0 ? '没有' : `pid=[${pids.join(',')}]`}`);
      } catch (err) {
        lines.push(`此刻探活失败（不是"它不在"）: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }
  process.stdout.write(`${usage()}\n`);
  return argv.length === 0 ? 0 : 1;
}

if (isDirectRun(import.meta.url)) {
  void runCli().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
