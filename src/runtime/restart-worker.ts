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
 *   ④ 拉起器盯着"**她真的换了个人**"的两条硬凭据（`lock.json` 里的新 pid +
 *      `GET /api/health` 答 `status=ready`），把 `[实例]` / `[结束]` 两行写进留痕
 *      ——于是这次重启**在服务端已经退出之后**，仍然留下了可证明的三态回执
 *      （`ok=` / 真 pid / 端口那一档 / 失败是哪一环）。
 *
 * ## 2026-10-26：判据从"TCP 能连"改成"**health 说 ready**"，窗口 32 秒 → 180 秒
 *
 * 事故现场（`data/restart-worker.log`）：
 * ```
 * [结束] ok=False backendPid=24616 port=timeout … reason=port-not-ready ·
 *        新的 pid=24616 已经写进 lock.json，但端口 127.0.0.1:7788 在 32000 毫秒里没有应答
 * ```
 * 三条根因都在这里：
 *   · **窗口太短**：冷启动到开始监听实测 35–42 秒，而窗口是 32 秒 ⇒ 必然超时；
 *   · **判据太粗**："端口能连"与"能干活"是两件事。后端现在**先 bind、再干重活**，
 *     于是"TCP 连上了"恰恰出现在**还没就绪**的那一段——拿它当成功凭据就是这次事故的翻版；
 *   · **超时即放弃**：那一轮之后新实例还在起，而拉起器已经退出、判了失败——"后端半途
 *     生死不明"就是这么来的。现在超时**不杀新实例**，还会再等 60 秒复查一次。
 *
 * 四档端口读数（写进 `[结束]` 的 `port=`）：
 *   · `ready`            —— health 说就绪（**唯一**算成功的一档）；
 *   · `starting`         —— 端口在听、health 说还在启动（正常情况会在窗口内变成 ready）；
 *   · `starting-timeout` —— 窗口用尽都没 ready（复查改判成功时，那一行会是 `port=ready`）；
 *   · `timeout` / `unknown` —— 老口径（脚本那两条路照旧用它们）。
 *
 * ## 回执三行（服务端按行解析，见 `web/server.ts` 的 `parseRestartTrace`）
 *
 *   `[回执] 路径=self-restart · 拉起器已启动 pid=… · …`      ← 它真的跑起来了
 *   `[实例] 后端已接管 pid=… source=lock.json path=…`        ← 她真的换了个人
 *   `[结束] ok=… backendPid=… port=… guiPid=… path=… reason=…` ← 一次；**改判**时会有第二行
 *
 * 三态不许互相冒充：`ok=False` 一定带 `reason=`（哪一环坏的），
 * **绝不写"没能确认"就算完**——那正是这颗按钮过去最没品的失败方式。
 */

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, openSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
import { resolve } from 'node:path';

import { decodeText } from '../util/bytes-text.ts';
import { DEFAULT_MAX_OLD_SPACE_MB, resolveMaxOldSpaceMb } from './node-memory.ts';
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
  /**
   * 问一次 `GET /api/health`：**这是"就绪"的唯一判据**（不再是 TCP 能不能连）。
   * `down` = 连不上/超时；`starting` = 答了话但还没就绪；`ready` = 可以干活了。
   */
  probeHealth: (host: string, port: number, timeoutMs: number) => Promise<HealthProbe>;
  /** 起新的后端；返回它的 pid（起不来就抛） */
  spawnBackend: (input: { nodeExe: string; entry: string; root: string; logPath: string }) => number;
  /** 停掉 GUI 进程（按 exe 全路径匹配，分隔符/大小写无关）；返回停掉的 pid */
  stopGui: (guiExe: string) => number[];
  /** 拉起 GUI；返回它的 pid（起不来就返回 0） */
  startGui: (guiExe: string) => number;
}

/** 一次健康探测的三种结局（见 `probeHealth`） */
export type HealthProbe = 'ready' | 'starting' | 'down';

const DEFAULT_WAIT_MS = 90_000;
/**
 * 等"新实例就绪"的缺省窗口：**180 秒**（2026-10-26 从 60 秒抬上来）。
 *
 * 服务端那条 self-restart 命令显式传 `--port-wait-ms 180000`（见 `web/server.ts` 的
 * `RESTART_PORT_WAIT_MS`）；这里的缺省值与它**同一个数**，免得"手跑一次拉起器"与
 * "从界面点重启"两套窗口不一样。
 */
const DEFAULT_PORT_WAIT_MS = 180_000;
const POLL_MS = 500;
/** 单次 health 探测的上限：回环上正常是几毫秒，500ms 已经宽到不该误杀 */
const HEALTH_PROBE_TIMEOUT_MS = 500;
/**
 * 窗口用尽之后**再等多久复查一次**（60 秒）。
 *
 * 为什么不是"超时就收工"：超时那一刻新实例往往只差几秒（重活在收尾），而杀掉它等于把
 * "重启失败"变成"后端没了"——那正是这次事故里"半途生死不明"的形状。所以：
 *   · **一个进程都不杀**（这里从来就没有杀的分支，注释写死是为了不让下一个人加）；
 *   · 先如实写一行 `[结束] ok=False port=starting-timeout`，再等 60 秒；
 *   · 通了就补一行**改判**的 `[结束] ok=True`（解析那边取最后一行，见 `parseRestartTrace`）。
 */
const STARTING_TIMEOUT_RECHECK_MS = 60_000;

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
 * 问一次 `GET /api/health`——**"后端真的能干活了吗"的唯一判据**（2026-10-26 起）。
 *
 * 为什么不继续用 `probeTcp`：端口先 bind、重活后干之后，"TCP 连上了"正好是**还没就绪**
 * 那一段的特征。拿它当成功凭据，拉起器会把一个 35 秒还没折完事件的进程判成"已接管"，
 * 而界面随后能连上、每一条数据请求都失败——比"连不上"更难查。
 *
 * 三种结局的判法：
 *   · `down`     —— 连不上 / 超时 / 被拒（没人听就是这个）；
 *   · `ready`    —— HTTP 答了 JSON 且 `status === 'ready'`；
 *   · `starting` —— 其余一切"答了话但没说 ready"（health 说 starting、老后端 404、
 *                   别的程序占着端口返回一坨 HTML）。这一档**继续等**，不猜。
 */
export function probeHealth(host: string, port: number, timeoutMs: number): Promise<HealthProbe> {
  return new Promise<HealthProbe>((settle) => {
    let done = false;
    const finish = (state: HealthProbe): void => {
      if (done) return;
      done = true;
      settle(state);
    };
    let req: ReturnType<typeof request>;
    try {
      req = request({
        host,
        port,
        path: '/api/health',
        method: 'GET',
        timeout: timeoutMs,
        headers: { accept: 'application/json' },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (text.length < 4096) text += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(text) as { status?: unknown };
            if (parsed.status === 'ready') {
              finish('ready');
              return;
            }
            if (parsed.status === 'starting') {
              finish('starting');
              return;
            }
          } catch {
            // 不是 JSON：可能是别的程序占着这个端口 / 老后端的 404 页
          }
          finish('starting');
        });
        res.on('error', () => finish('starting'));
      });
    } catch {
      finish('down');
      return;
    }
    req.on('timeout', () => {
      req.destroy();
      finish('down');
    });
    req.on('error', () => finish('down'));
    req.end();
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
    // 现役后端已经在服务：判据仍然是 health=ready（"在听"不等于"能干活"，见 probeHealth）
    const health = await io.probeHealth(options.host, options.port, HEALTH_PROBE_TIMEOUT_MS);
    const backendReady = health === 'ready';
    io.trace(endTraceLine({
      ok: up > 0, backendPid: io.readLockPid(),
      port: backendReady ? 'ready' : (health === 'starting' ? 'starting' : 'timeout'),
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

  // ── ⑤ 两条硬凭据：她**换了个人**（lock.json 的新 pid）+ **health 说 ready** ──
  //
  // 判据（2026-10-26 起）：不再是 `probeTcp`。后端先 bind 再干重活，所以"TCP 连上了"
  // 恰恰可能出现在**还没就绪**那一段——拿它当凭据说"接管了"，界面随后每一条数据请求都会失败。
  const portUntil = io.now() + options.portWaitMs;
  let lastHealth: HealthProbe = 'down';
  /** 窗口里有没有见过"端口在听、还没就绪"那一档（`starting-timeout` 与 `timeout` 的差别） */
  let sawStarting = false;
  let newPid = 0;
  let backendReady = false;
  for (;;) {
    lastHealth = await io.probeHealth(options.host, options.port, HEALTH_PROBE_TIMEOUT_MS);
    if (lastHealth !== 'down') sawStarting = true;
    const lockPid = io.readLockPid();
    if (lockPid !== 0 && !options.oldPids.includes(lockPid)) newPid = lockPid;
    if (lastHealth === 'ready' && newPid !== 0) {
      backendReady = true;
      break;
    }
    if (io.now() >= portUntil) break;
    await io.sleep(POLL_MS);
  }
  // 端口那一档：只有 `ready` 算成功；见过 starting 的超时与"根本没人听"必须分开报
  let portState: 'ready' | 'starting' | 'starting-timeout' | 'timeout' =
    backendReady ? 'ready' : (sawStarting ? 'starting-timeout' : 'timeout');
  const ok = backendReady && newPid !== 0;
  let reason: RestartFailureReason = RESTART_FAILURE_REASONS.ok;
  let detail = '';
  if (!ok) {
    reason = newPid === 0 ? RESTART_FAILURE_REASONS.lockNotChanged : RESTART_FAILURE_REASONS.portNotReady;
    detail = newPid === 0
      ? `拉起的 pid=${spawned} 在 ${options.portWaitMs} 毫秒里没有把 lock.json 换成新 pid`
        + `（端口那一档=${portState}）——"换了个人"这条凭据不成立`
      : `新的 pid=${newPid} 已经写进 lock.json，但 ${options.host}:${options.port} 在`
        + ` ${options.portWaitMs} 毫秒里没有就绪（最后一次 /api/health=${lastHealth}）`;
  } else {
    io.trace(instanceTraceLine({ backendPid: newPid, source: 'lock.json', path }));
    detail = `新实例 pid=${newPid}（入口 ${options.entry}）· /api/health 已 ready`;
  }

  // ── ⑥ 界面：后端就绪之后再拉起来（与重启脚本同一个次序）──
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

  // ── ⑦ 结局：超时**不杀新实例**，先如实写一行失败，再等 60 秒复查一次 ──
  if (ok) {
    io.trace(endTraceLine({
      ok: reason === RESTART_FAILURE_REASONS.ok,
      backendPid: newPid, port: 'ready', guiPid, path, reason, detail,
    }));
    return reason === RESTART_FAILURE_REASONS.ok ? 0 : 1;
  }

  const timeoutDetail = `${detail} · **没有杀掉新实例**：它可能只差几秒就绪，杀了就是把"重启失败"变成"后端没了"`;
  io.trace(endTraceLine({
    ok: false, backendPid: newPid, port: portState, guiPid, path, reason, detail: timeoutDetail,
  }));
  io.log(`[拉起器] 等就绪超时（${options.portWaitMs} 毫秒，最后 /api/health=${lastHealth}）：`
    + `不杀新实例，再等 ${Math.round(STARTING_TIMEOUT_RECHECK_MS / 1000)} 秒复查一次`);

  const recheckUntil = io.now() + STARTING_TIMEOUT_RECHECK_MS;
  let recovered = false;
  for (;;) {
    lastHealth = await io.probeHealth(options.host, options.port, HEALTH_PROBE_TIMEOUT_MS);
    const lockPid = io.readLockPid();
    if (lockPid !== 0 && !options.oldPids.includes(lockPid)) newPid = lockPid;
    if (lastHealth === 'ready' && newPid !== 0) {
      recovered = true;
      break;
    }
    if (io.now() >= recheckUntil) break;
    await io.sleep(POLL_MS);
  }
  if (!recovered) {
    io.log(`[拉起器] 复查仍未就绪（最后 /api/health=${lastHealth}）：就这样收尾，新实例留在盘上继续起`);
    return 1;
  }
  // 改判：补写一行 `[结束] ok=True`（`parseRestartTrace` 取**最后**一行，所以外面读到的是成功）
  io.trace(endTraceLine({
    ok: true, backendPid: newPid, port: 'ready', guiPid, path,
    reason: RESTART_FAILURE_REASONS.ok,
    detail: `复查改判：超时（${options.portWaitMs} 毫秒）之后又等到了就绪（pid=${newPid}，/api/health=ready）`
      + '——前一行 ok=False 是超时那一刻的读数',
  }));
  io.log(`[拉起器] 复查改判：pid=${newPid} 已就绪（/api/health=ready），这次重启算成功`);
  return 0;
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
  // **不收 `encoding:'utf8'`**（2026-10-18 收口）：这一格的输出是 pid 列表（ASCII），
  // 但 Windows PowerShell 5.1 出错时的中文诊断是 GBK 字节，而它会顺着错误路径给人看见。
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 20_000,
    env: { ...process.env, IRMIA_RESTART_GUI_EXE: guiExe },
  });
  const text = (probe.stdout === null ? '' : decodeText(probe.stdout).text).trim();
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
      timeout: 20_000,
      env: { ...process.env, IRMIA_RESTART_GUI_EXE: guiExe },
    });
    const pid = Number((probe.stdout === null ? '' : decodeText(probe.stdout).text).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

/**
 * 新后端的老生代上限（MB）—— **与三份启动脚本、以及看护脚本同一个数、同一处来源**
 * （2026-10-26 收口：这个数只写在 `runtime/node-memory.ts` 里，四条路都读它）。
 *
 * **为什么这条路上也必须有**：`self-restart` 是**第三条**拉后端的路（没有 pwsh / 没有那两个
 * 脚本时就走它），它在这里 `spawn` 新后端。少了这个参数，界面那三份脚本带上了上限、
 * 而这一条路悄悄退化成"由 V8 自己看着办"——**同一个进程在不同重启路径下内存行为不一样**，
 * 是那种最难查的不一致。
 *
 * **为什么从 512 抬到 1024**（同一台机器上两种生死，见 `node-memory.ts` 的文件头）：
 * 拉起器带 512 拉起的新实例在 62 秒时撞死（`FATAL ERROR: Reached heap limit`），
 * 而看护脚本（1024）拉起的那一份活得很好。**拉起器不许给一个活不了的参数。**
 *
 * 环境变量 `IRMIA_MAX_OLD_SPACE_MB` 可以覆盖（设 0 = 不带这个参数，回退）。
 */
export const MAX_OLD_SPACE_MB = DEFAULT_MAX_OLD_SPACE_MB;

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
 * ⚠ Node 的选项**必须排在入口之前**（`node --max-old-space-size=1024 <entry>`）；
 * 排在入口之后会被当成 `main.js` 自己的参数（它不认，直接退）。
 *
 * 上限**现读**环境变量（`IRMIA_MAX_OLD_SPACE_MB`，缺省 `DEFAULT_MAX_OLD_SPACE_MB`）：
 * 拉起器是 detached 起的，它的环境就是服务端那一刻的环境——所以"临时调大一次"只需
 * 在起服务端之前设这个变量，不必改任何脚本。
 */
function spawnBackendDetached(input: { nodeExe: string; entry: string; root: string; logPath: string }): number {
  if (!existsSync(input.nodeExe)) throw new Error(`没有这个 node 运行时：${input.nodeExe}`);
  if (!existsSync(input.entry)) throw new Error(`没有这个入口：${input.entry}`);
  const fd = openSync(input.logPath, 'a');
  const child = spawn(input.nodeExe, backendSpawnArgv(input.entry, resolveMaxOldSpaceMb(process.env)), {
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
    probeHealth,
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
