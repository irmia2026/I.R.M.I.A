/**
 * Irmia Agent —— **自重启的拉起器**（路径链的第 ③ 条：`self-restart`）。
 *
 * ## 它是什么、为什么必须有它
 *
 * 装出来的那份（内测包）里既没有 `tools\restart-agent.ps1`，也可能没有随包脚本
 * `restart.ps1`（见 `restart-chain.ts` 的文件头：那正是「beta5 内测包重启不了」的根因）。
 * 两条脚本都没有时，**框架必须自己会这一手**：用自带运行时
 * （`runtime\node\node.exe`）起一份新的自己，然后优雅退出。
 *
 * 为什么不是一个内联的 `node -e "…"`：那串 JS 要挤进 `cmd.exe /s /c "…"` 的引号里，
 * 而这条链路上任何一点引号不确定都不该引入（见 `web/server.ts` 的 `restartCommandLine` 文件头：
 * 三点对照实测过重定向写在哪一对引号里都会让命令"返回 0 而根本不执行"）。
 * 做成**随 dist 一起装配的一个文件**，命令行上就只有绝对路径与数字——
 * 与"随包脚本"是同一个形状（区别只在于它是框架自己的产物，而不是要人手维护的脚本）。
 *
 * ## 为什么是"拉起器 → 等旧实例死 → 再拉新的"，而不是"先拉新的再自己退"
 *
 * 单实例锁（`instance-lock.ts`）与监听端口这两样都**只允许一个用户**：
 * 新实例起在旧实例还活着的时候，会撞上 `LockHeldError`（锁被活着的 pid 持有 ⇒ 直接退出）
 * 或 `EADDRINUSE`。所以顺序只能是：
 *
 *   ① 服务端把它自己那条"要重启"的决定**先落进留痕**，然后 WMI 建一个**分离**的拉起器；
 *   ② 服务端把这次 HTTP 回执发出去，再走**既有退出路径**优雅退出
 *      （落事件 → session/end → 收尾 → 让锁释放）；
 *   ③ 拉起器等旧实例**真的消失**（pid 不在了 / 锁换了用户），
 *      才按 Windows 那套实测过的拼法把新的拉起来：
 *      `cmd.exe /s /c ""<node>" "<entry>" >> "<日志>" 2>&1"`、入口与 cwd 都是绝对路径；
 *   ④ 拉起器盯着"**她真的换了个人**"的两条硬凭据（`lock.json` 里的新 pid + 端口能应答），
 *      把 `[实例]` / `[结束]` 两行写进留痕——于是这次重启**在服务端已经退出之后**，
 *      仍然留下了可证明的三态回执（`ok=` / 真 pid / 端口那一档 / 失败是哪一环）。
 *
 * ## 回执三行（服务端按行解析，见 `web/server.ts` 的 `parseRestartTrace`）
 *
 *   `[回执] 路径=self-restart · 拉起器已启动 pid=… · …`      ← 它真的跑起来了
 *   `[实例] 后端已接管 pid=… source=lock.json path=…`        ← 她真的换了个人
 *   `[结束] ok=… backendPid=… port=… guiPid=… path=… reason=…` ← 恰好一次
 *
 * 三态不许互相冒充：`ok=False` 一定带 `reason=`（哪一环坏的），
 * **绝不写"没能确认"就算完**——那正是这颗按钮过去最没品的失败方式。
 */

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, openSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
import { resolve } from 'node:path';

import {
  RESTART_FAILURE_REASONS, endTraceLine, instanceTraceLine, restartTraceLine,
  type RestartFailureReason,
} from './restart-chain.ts';

/** 拉起器自己写留痕用的路径标签：它就是 `self-restart` 这一条 */
export const SELF_RESTART_PATH = 'self-restart' as const;

export interface RestartWorkerOptions {
  /** 旧实例的 pid（可能两个：进程自己的 pid + `lock.json` 里那个；都要等它们消失） */
  oldPids: number[];
  /** 安装根（新实例的 cwd） */
  root: string;
  /** 用哪个 node 起新的自己（自带运行时的绝对路径） */
  nodeExe: string;
  /** 新实例的入口（`<root>\dist\main.js`，绝对路径） */
  entry: string;
  /** 留痕文件（三行写在这里，服务端读它） */
  traceLog: string;
  /** 新实例 stdout/stderr 的落点 */
  backendLog: string;
  /** 数据目录（读 `lock.json`） */
  dataDir: string;
  host: string;
  port: number;
  /** 界面可执行文件（空 = 本次不动界面） */
  guiExe: string;
  /** 只重启界面（一个后端进程都不动） */
  guiOnly: boolean;
  /** 等旧实例消失的上限（毫秒） */
  waitMs: number;
  /** 等端口就绪的上限（毫秒） */
  portWaitMs: number;
}

/** 拉起器对外说的话（全部经过它——纯函数与真实现之间只有这一层） */
export interface RestartWorkerIo {
  /** 往留痕里追加一行（服务端读它） */
  trace: (line: string) => void;
  /** 拉起器自己的输出（被 cmd 那层重定向到 restart-script.log） */
  log: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  isPidAlive: (pid: number) => boolean;
  /** 读 `<dataDir>/lock.json` 里的 pid（0 = 没读到） */
  readLockPid: () => number;
  probePort: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  /** 起新的后端；返回它的 pid（起不来就抛） */
  spawnBackend: (input: { nodeExe: string; entry: string; root: string; logPath: string }) => number;
  /** 停掉 GUI 进程（按 exe 全路径匹配，分隔符/大小写无关）；返回停掉的 pid */
  stopGui: (guiExe: string) => number[];
  /** 拉起 GUI；返回它的 pid（起不来就返回 0） */
  startGui: (guiExe: string) => number;
}

const DEFAULT_WAIT_MS = 90_000;
const DEFAULT_PORT_WAIT_MS = 60_000;
const POLL_MS = 500;

/** 参数解析的结论（纯函数：`--old-pid 1,2` 这种逗号列表也认） */
export type WorkerArgsResult =
  | { ok: true; options: RestartWorkerOptions }
  | { ok: false; error: string };

function argValue(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  return value === undefined ? null : value;
}

/**
 * 解析拉起器的命令行。
 *
 * 为什么要单拎出来：这条命令行是**服务端拼的**，而它决定了"新实例的 cwd、入口、日志在哪"——
 * 拼错了的症状是"点了重启没反应"，那正是这次要根除的形状。纯函数 ⇒ 单测能把每个参数摆一遍。
 */
export function parseRestartWorkerArgs(argv: readonly string[]): WorkerArgsResult {
  const num = (name: string, fallback: number): number => {
    const raw = argValue(argv, name);
    if (raw === null || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  const root = (argValue(argv, '--root') ?? '').trim();
  const nodeExe = (argValue(argv, '--node') ?? '').trim();
  const entry = (argValue(argv, '--entry') ?? '').trim();
  const traceLog = (argValue(argv, '--trace') ?? '').trim();
  const dataDir = (argValue(argv, '--data-dir') ?? '').trim();
  const missing = ([['--root', root], ['--node', nodeExe], ['--entry', entry],
    ['--trace', traceLog], ['--data-dir', dataDir]] as const)
    .filter(([, value]) => value === '').map(([name]) => name);
  if (missing.length > 0) return { ok: false, error: `缺参数：${missing.join('、')}` };

  const oldRaw = (argValue(argv, '--old-pid') ?? '').trim();
  // 服务端可能同时给"进程自己的 pid"与"lock.json 里那个"（正常情况下是同一个）：
  // 去重，免得白等一遍；两个都等，是因为**锁是那个会把新实例挡在外面的东西**。
  const oldPids = oldRaw === ''
    ? []
    : [...new Set(oldRaw.split(',').map((part) => Number(part.trim()))
      .filter((value) => Number.isInteger(value) && value > 0))];
  if (oldRaw !== '' && oldPids.length === 0) {
    return { ok: false, error: `--old-pid 不是一个 pid 列表：${oldRaw}` };
  }
  const port = num('--port', 0);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, error: `--port 不是合法端口：${argValue(argv, '--port') ?? '（缺）'}` };
  }
  return {
    ok: true,
    options: {
      oldPids,
      root,
      nodeExe,
      entry,
      traceLog,
      backendLog: (argValue(argv, '--out') ?? '').trim(),
      dataDir,
      host: (argValue(argv, '--host') ?? '127.0.0.1').trim() || '127.0.0.1',
      port,
      guiExe: (argValue(argv, '--gui-exe') ?? '').trim(),
      guiOnly: argv.includes('--gui-only'),
      waitMs: num('--wait-ms', DEFAULT_WAIT_MS),
      portWaitMs: num('--port-wait-ms', DEFAULT_PORT_WAIT_MS),
    },
  };
}

/** 并发判据用：这里只需要"能不能给它发信号"，EPERM 也算活着（与 instance-lock 同一口径） */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 端口**现在**有人听吗（TCP 建连；与服务端 `portListening` 同一口径） */
export function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((settle) => {
    const socket = connect({ host, port });
    let done = false;
    const finish = (value: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      settle(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * 拉起器的正文。**判据全在这里**（io 只是"怎么做"，"怎么判"不散在调用方）。
 *
 * 返回进程退出码：0 = 新实例真的接管了；1 = 某一环失败（留痕里 `[结束] reason=` 写清了是哪一环）。
 */
export async function runRestartWorker(options: RestartWorkerOptions, io: RestartWorkerIo): Promise<number> {
  const path = SELF_RESTART_PATH;
  const oldList = options.oldPids.join(',') || '（没给）';
  io.trace(restartTraceLine('回执',
    `路径=${path} · 拉起器已启动 pid=${process.pid} · 等旧实例 pid=${oldList} 退出后拉起 ${options.entry}`));

  // ── ① 停界面（先停它：旧后端要死了，界面留着只会对着一个断掉的连接狂重连）──
  let guiPid = 0;
  let guiStopped = 0;
  let guiError = '';
  if (options.guiExe !== '') {
    try {
      const stopped = io.stopGui(options.guiExe);
      guiStopped = stopped.length;
      io.log(`[拉起器] 停了 ${guiStopped} 个界面进程（${options.guiExe}）${stopped.length === 0 ? '（此刻没有在跑）' : ` pid=[${stopped.join(',')}]`}`);
    } catch (err) {
      guiError = String(err);
      io.log(`[拉起器] 停界面失败：${guiError}`);
    }
  }

  // ── ② 只重启界面：后端一个进程都不动，端口那一档由现役后端回答 ──
  if (options.guiOnly) {
    if (options.guiExe === '') {
      const line = endTraceLine({
        ok: false, backendPid: io.readLockPid(), port: 'unknown', guiPid: 0, path,
        reason: RESTART_FAILURE_REASONS.guiFailed, detail: '--gui-only 但没给 --gui-exe：没有界面可重启',
      });
      io.trace(line);
      return 1;
    }
    const up = io.startGui(options.guiExe);
    const portReady = await io.probePort(options.host, options.port, 500);
    io.trace(endTraceLine({
      ok: up > 0, backendPid: io.readLockPid(), port: portReady ? 'ready' : 'timeout',
      guiPid: up, path,
      reason: up > 0 ? RESTART_FAILURE_REASONS.ok : RESTART_FAILURE_REASONS.guiFailed,
      detail: up > 0 ? '只重启了界面（-GuiOnly：一个后端进程都没动）' : '界面进程没拉起来',
    }));
    return up > 0 ? 0 : 1;
  }

  // ── ③ 等旧实例**真的消失**：锁与端口都只允许一个用户，不等就是撞锁/抢端口 ──
  const waitUntil = io.now() + options.waitMs;
  for (;;) {
    const alive = options.oldPids.filter((pid) => io.isPidAlive(pid));
    const lockPid = io.readLockPid();
    const lockStillOld = lockPid !== 0 && options.oldPids.includes(lockPid);
    if (alive.length === 0 && !lockStillOld) break;
    if (io.now() >= waitUntil) {
      io.trace(endTraceLine({
        ok: false, backendPid: lockPid, port: 'unknown', guiPid: 0, path,
        reason: RESTART_FAILURE_REASONS.oldNotGone,
        detail: `旧实例 pid=[${alive.join(',')}] 在 ${options.waitMs} 毫秒里没有退出`
          + `（lock.json 的 pid=${lockPid}）；没有拉起新实例——撞锁/抢端口只会让两个实例互相打架`,
      }));
      return 1;
    }
    await io.sleep(POLL_MS);
  }
  io.log(`[拉起器] 旧实例已消失（pid=[${oldList}]），开始拉起 ${options.entry}`);

  // ── ④ 拉起新的自己：入口与 cwd 都是绝对路径，stdout/stderr 落它自己的日志 ──
  let spawned = 0;
  try {
    spawned = io.spawnBackend({
      nodeExe: options.nodeExe, entry: options.entry, root: options.root, logPath: options.backendLog,
    });
    io.log(`[拉起器] 已拉起新实例 pid=${spawned}（cwd=${options.root}）`);
  } catch (err) {
    io.trace(endTraceLine({
      ok: false, backendPid: 0, port: 'unknown', guiPid: 0, path,
      reason: RESTART_FAILURE_REASONS.spawnFailed, detail: `拉起新实例失败：${String(err)}`,
    }));
    return 1;
  }

  // ── ⑤ 两条硬凭据：她**换了个人**（lock.json 的新 pid）+ **端口能应答** ──
  const portUntil = io.now() + options.portWaitMs;
  let portState: 'ready' | 'timeout' = 'timeout';
  let newPid = 0;
  let portReady = false;
  for (;;) {
    portReady = await io.probePort(options.host, options.port, 500);
    const lockPid = io.readLockPid();
    if (lockPid !== 0 && !options.oldPids.includes(lockPid)) newPid = lockPid;
    if (portReady && newPid !== 0) break;
    if (io.now() >= portUntil) break;
    await io.sleep(POLL_MS);
  }
  if (portReady) portState = 'ready';
  // 端口应答了也可能不是"她"（比如旧实例还在收尾、或者别的程序占了）：pid 不许凭空捏造
  const ok = portReady && newPid !== 0;
  let reason: RestartFailureReason = RESTART_FAILURE_REASONS.ok;
  let detail = '';
  if (!ok) {
    reason = newPid === 0 ? RESTART_FAILURE_REASONS.lockNotChanged : RESTART_FAILURE_REASONS.portNotReady;
    detail = newPid === 0
      ? `拉起的 pid=${spawned} 在 ${options.portWaitMs} 毫秒里没有把 lock.json 换成新 pid`
        + `（端口那一档=${portState}）——"换了个人"这条凭据不成立`
      : `新的 pid=${newPid} 已经写进 lock.json，但端口 ${options.host}:${options.port} 在`
        + ` ${options.portWaitMs} 毫秒里没有应答`;
  } else {
    io.trace(instanceTraceLine({ backendPid: newPid, source: 'lock.json', path }));
    detail = `新实例 pid=${newPid}（入口 ${options.entry}）`;
  }

  // ── ⑥ 界面：端口能应答之后再拉起来（与重启脚本同一个次序）──
  if (options.guiExe !== '') {
    if (guiError !== '') {
      if (ok) { reason = RESTART_FAILURE_REASONS.guiFailed; detail = `界面停不掉：${guiError}`; }
    } else {
      guiPid = io.startGui(options.guiExe);
      if (guiPid === 0 && ok) {
        reason = RESTART_FAILURE_REASONS.guiFailed;
        detail = `界面没拉起来（${options.guiExe}）`;
      }
    }
  }

  io.trace(endTraceLine({
    ok: ok && reason === RESTART_FAILURE_REASONS.ok,
    backendPid: newPid, port: portState, guiPid, path, reason, detail,
  }));
  return ok && reason === RESTART_FAILURE_REASONS.ok ? 0 : 1;
}

// ──────────────────────────── 真实现（只有进程边界才碰它） ────────────────────────────

function appendTrace(traceLog: string, line: string): void {
  try {
    appendFileSync(traceLog, line, 'utf8');
  } catch {
    // 留痕写不下去**不算错**：重启本身比留痕重要（与 tools\restart-agent.ps1 同一条纪律）
  }
}

function readLockPidFrom(dataDir: string): number {
  try {
    const lock = JSON.parse(readFileSync(resolve(dataDir, 'lock.json'), 'utf8')) as { pid?: unknown };
    return typeof lock.pid === 'number' ? lock.pid : 0;
  } catch {
    return 0;
  }
}

/**
 * 停掉界面进程：**按 exe 全路径匹配**（大小写与分隔符无关），与 `tools\restart-agent.ps1`
 * 的口径一致——不能因为"名字一样"就去杀别人机器上另一个安装的界面。
 *
 * 走系统自带的 `powershell.exe`（`web/server.ts` 的 `portListening` 也是这么做的：
 * 这条路上不能 await 出花来，而 PowerShell 的 CIM 查询是 Windows 上唯一现成的、
 * 能不装任何东西就拿到"进程 + 可执行文件全路径"的口子）。目标路径**只从环境变量进**，
 * 于是这段脚本里没有一个外来字符串，引号问题在构造上就不存在。
 */
function stopGuiByPath(guiExe: string): number[] {
  const script = [
    '$target = [System.IO.Path]::GetFullPath($env:IRMIA_RESTART_GUI_EXE)',
    '$name = [System.IO.Path]::GetFileName($target)',
    '$pids = @()',
    'foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name = \'$name\'" -ErrorAction SilentlyContinue)) {',
    '  $path = $p.ExecutablePath',
    '  if (-not $path) { continue }',
    '  try { $full = [System.IO.Path]::GetFullPath($path) } catch { continue }',
    '  if ($full -ieq $target) { $pids += $p.ProcessId; Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }',
    '}',
    'Write-Output ($pids -join ",")',
  ].join("\n");
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, IRMIA_RESTART_GUI_EXE: guiExe },
  });
  const text = (probe.stdout ?? '').trim();
  if (text === '') return [];
  return text.split(',').map((part) => Number(part.trim())).filter((value) => Number.isInteger(value) && value > 0);
}

/**
 * 拉起界面进程。
 *
 * ## 判据：**三条路同一形状**
 *
 * 拉界面的路一共三条，形状必须**逐字同一种**（对着 `docs/restart-gui-launch-shape.md` 的结论抄）：
 *
 *   | # | 谁 | 落在哪 |
 *   |---|---|---|
 *   | ① | 开发机脚本 | `tools\restart-agent.ps1` 的 `Invoke-DetachedStartProcess` |
 *   | ② | 随包脚本 | `packaging\restart.ps1` 的同名函数 |
 *   | ③ | 自重启拉起器 | **这里** |
 *
 * 三条都是 `Start-Process -FilePath <exe 绝对路径> -WorkingDirectory <exe 所在目录> -PassThru`。
 *
 * **为什么这件事必须一致**（那份文档的实测结论，别再往 `cmd /s /c` 上打补丁）：
 * 界面拉不起来的原因**不是**那个形状本身、也**不是**中文路径，而是"**重定向目标恰好被外层
 * 持有**"——`cmd` 的 `>>` 只 `FILE_SHARE_READ`，内层在"打开文件"这一步就失败、`cmd` 随即退出，
 * 而建进程那一层照样报成功。症状是 `界面拉起=not-appeared`：命令发出去了、壳 pid 也有、
 * 目标 exe 根本没被执行。`Start-Process` 这条形状**不经过 `cmd`**、也不重定向界面的
 * stdout/stderr ⇒ 没有那个变量。
 *
 * 换成这条形状还顺带修掉一个判据问题：`-PassThru` 给的 pid **就是界面自己**，
 * 于是不必去"采样里认一个同路径的新进程"——那套分不清"我拉起的"与"用户手工拉起的"
 * （2026-10-10 01:31 那条 `alive` 的疑点就是这么来的）。三条路**只认自己手里的 pid**。
 *
 * ## 与两条脚本唯一的差别：谁来读"四态"
 *
 * 脚本会把 `alive / alive-no-window / appeared-then-exited / not-appeared` 写进留痕，
 * 而拉起器这一层的契约只有"给一个 pid，0 = 没起来"（`RestartWorkerIo.startGui`）——
 * 所以这里做**同一件事的最小版**：`-PassThru` 拿到 pid 之后**复看一次**（3 秒，与脚本同一条
 * "拉起成功 = 活过 3 秒"纪律：缺 DLL / 缺 `data\` 的程序会起来就自己退，而那一刻
 * `Start-Process` 照样是成功的）；活着就报 pid，已经退了就报 0。
 * 判据没有第二份：`[结束] guiPid=0 + reason=gui-failed` 就是这条路说的"没起来"。
 *
 * 目标路径**只从环境变量进**（与上面 `stopGuiByPath` 同一条纪律）：这段脚本里没有一个外来
 * 字符串，引号问题在构造上就不存在。**工作目录必须是 exe 所在目录**：Flutter 的 Windows
 * 产物要就地找 `flutter_windows.dll` 与 `data\`，工作目录给错 = 起来就自己退。
 *
 * 导出只为让测试能直接调它（`test\restart-worker-gui.test.ts` 拿**替身 exe** 走三态：
 * 活着 ⇒ 给 pid、起来就退 ⇒ 0、根本起不来 ⇒ 0，并从那替身自己写下的 cwd 读数验
 * `-WorkingDirectory` 真的生效）——**一个真界面都不弹**。
 */
export function startGuiProcess(guiExe: string): number {
  const script = [
    '$exe = [System.IO.Path]::GetFullPath($env:IRMIA_RESTART_GUI_EXE)',
    '$dir = [System.IO.Path]::GetDirectoryName($exe)',
    // 形状与两条脚本逐字一致（`-FilePath` 绝对路径 + `-WorkingDirectory` exe 所在目录 + `-PassThru`）
    'try { $p = Start-Process -FilePath $exe -WorkingDirectory $dir -PassThru } catch { Write-Output "0"; exit 0 }',
    // 复看一次：起来就自己退（缺 DLL / 缺 data）不算拉起来（脚本那边叫 appeared-then-exited）
    'Start-Sleep -Milliseconds 3000',
    'if ($p.HasExited) { Write-Output "0" } else { Write-Output ([string]$p.Id) }',
  ].join("\n");
  try {
    const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, IRMIA_RESTART_GUI_EXE: guiExe },
    });
    const pid = Number((probe.stdout ?? '').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

/**
 * 新后端的老生代上限（MB）—— 与三份启动脚本**同一个数、同一处口径**
 * （`packaging/start.ps1` / `packaging/restart.ps1` / `tools/restart-agent.ps1`
 * 的 `-NodeMaxOldSpaceMb` 默认都是 512）。
 *
 * **为什么这条路上也必须有**：`self-restart` 是**第三条**拉后端的路（没有 pwsh / 没有那两个
 * 脚本时就走它），它在这里 `spawn` 新后端。少了这个参数，界面那三份脚本带上了上限、
 * 而这一条路悄悄退化成"由 V8 自己看着办"——**同一个进程在不同重启路径下内存行为不一样**，
 * 是那种最难查的不一致。
 *
 * 为什么是 512 与风险，见 `docs/operations.md` §4.4（与本文件同源的那段注释）。
 * 改这一格即可回退（设 0 = 不带这个参数）。
 */
export const MAX_OLD_SPACE_MB = 512;

/**
 * 拉新后端时给 node 的参数数组（**纯函数**，便于钉住）。
 *
 * 顺序是判据：`--max-old-space-size` 是 **Node 自己的选项，必须排在入口之前**；
 * 排到入口之后会被当成 `main.js` 的参数（它不认，直接退）。上限 ≤ 0 时**一个参数都不加**，
 * 命令行与加这条之前逐字相同（那是"回退"这条路的定义）。
 */
export function backendSpawnArgv(entry: string, maxOldSpaceMb: number = MAX_OLD_SPACE_MB): string[] {
  return maxOldSpaceMb > 0 ? [`--max-old-space-size=${maxOldSpaceMb}`, entry] : [entry];
}

/**
 * 拉起新的后端：**分离**进程（`detached` + `unref`），所以拉起器退出之后它还活着。
 *
 * stdout/stderr 直接给它自己的日志文件（`stdio` 里那两个 fd）：这样"新实例为什么没起来"
 * 事后有原文可看，而不会随拉起器一起消失。
 *
 * ⚠ Node 的选项**必须排在入口之前**（`node --max-old-space-size=512 <entry>`）；
 * 排在入口之后会被当成 `main.js` 自己的参数（它不认，直接退）。
 */
function spawnBackendDetached(input: { nodeExe: string; entry: string; root: string; logPath: string }): number {
  if (!existsSync(input.nodeExe)) throw new Error(`没有这个 node 运行时：${input.nodeExe}`);
  if (!existsSync(input.entry)) throw new Error(`没有这个入口：${input.entry}`);
  const fd = openSync(input.logPath, 'a');
  const child = spawn(input.nodeExe, backendSpawnArgv(input.entry), {
    cwd: input.root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env },
  });
  const pid = child.pid ?? 0;
  if (pid === 0) throw new Error('spawn 没有给出 pid');
  child.unref();
  return pid;
}

function realIo(): RestartWorkerIo {
  return {
    trace: () => {},
    log: (line) => { process.stdout.write(`${line}\n`); },
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((settle) => { setTimeout(settle, ms); }),
    isPidAlive: pidAlive,
    readLockPid: () => 0,
    probePort: probeTcp,
    spawnBackend: spawnBackendDetached,
    stopGui: stopGuiByPath,
    startGui: startGuiProcess,
  };
}

/** 拉起器的进程入口（被 `dist\runtime\restart-worker.js` 直接跑时走这里） */
async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseRestartWorkerArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`[拉起器] ${parsed.error}\n`);
    return 2;
  }
  const options = parsed.options;
  const io = realIo();
  io.trace = (line) => {
    appendTrace(options.traceLog, line);
    process.stdout.write(line);
  };
  io.readLockPid = () => readLockPidFrom(options.dataDir);
  return runRestartWorker(options, io);
}

const invokedDirectly = ((): boolean => {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return resolve(script) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
