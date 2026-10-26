/**
 * 后端**端口文件**：`%LOCALAPPDATA%\Irmia\server.json` ⇒ `{"port":7788,"pid":58888,"since":"…"}`。
 *
 * ## 为什么需要它（2026-10-26 的事故）
 *
 * 界面过去只从环境变量 `IRMIA_WEB_PORT` 取端口（`gui/lib/app.dart`）。环境变量是**继承**来的：
 * 任何父进程往自己环境里塞一个 `IRMIA_WEB_PORT=1580`，界面就连到一个根本没人听的端口，
 * 而屏幕上只有一句 `SocketException … port = 1580`——"谁把 1580 放进去的"从界面上完全看不出来。
 * 环境变量是**猜测**，盘上的事实才是事实：后端在 bind 成功那一刻把"我在哪个端口"写下来，
 * 界面读它。环境变量因此降为第二档（保守兼容），默认 7788 是第三档。
 *
 * ## 三条纪律
 *
 *   · **bind 成功那一刻才写**：先写再 bind 等于把"我听了 7788"这句话说在一个并没有听住的
 *     端口上——那正是这次事故的另一半（lock.json 有新 pid、端口没人应答）；
 *   · **退出时删掉**：一份过期的端口文件会让界面去连一个已经不在的端口。删除前核对
 *     `pid` 是**自己**：极端情况下（旧实例收尾很慢、新实例已经接管）不许把别人的那份删了；
 *   · **写不进去不拦启动**：这台机器上 `%LOCALAPPDATA%` 不可写时，界面还有环境变量与默认值
 *     两档可走；为了一个"提示位"把后端拦下来，主次就颠倒了。
 */

import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomicSync } from '../web/atomic.ts';

/** 文件名（界面那一半在 `gui/lib/backend_port.dart` 里按同一个名字读） */
export const SERVER_PORT_FILE_NAME = 'server.json';

/**
 * **每实例一份**的那个文件名前缀：`server.<port>.json`。
 *
 * 为什么要有它（多实例，2026-10 那一轮）：旧名字 `server.json` 是**全局一份**的——
 * 同一台机器上起第二个实例（换数据目录、换端口）时，两个后端会互相覆盖同一份文件，
 * 于是界面读到的是"最后写的那个"，而它可能是一个已经退出的端口。
 * 每实例一份之后，每个后端只写自己那一条，谁也不碰别人的。
 *
 * `server.json` **保留**（向后兼容）：它仍然由**默认实例**写，界面旧逻辑（`backend_port.dart`
 * 的三级来源）读它照旧能进默认实例；非默认实例不再往它上面写。
 */
export const SERVER_PORT_FILE_PREFIX = 'server.';

/** 端口文件的内容（`since` 是 ISO 时间戳；解析失败的字段一律当没有） */
export interface ServerPortFile {
  port: number;
  pid: number;
  since: string;
}

/**
 * 端口文件的路径：`%LOCALAPPDATA%\Irmia\server.json`。
 *
 * 非 Windows / 没有 `LOCALAPPDATA` ⇒ `null`（**不猜**一个目录写进去：写到别处等于给界面
 * 留一份它永远找不到的文件，而"没有这份文件"本来就是三档来源里正常的一档）。
 */
export function serverPortFilePath(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): string | null {
  if (platform !== 'win32') return null;
  const local = (env['LOCALAPPDATA'] ?? '').trim();
  if (local === '') return null;
  return join(local, 'Irmia', SERVER_PORT_FILE_NAME);
}

/**
 * **每实例一份**的端口文件路径：`%LOCALAPPDATA%\Irmia\server.<port>.json`。
 *
 * 与 {@link serverPortFilePath} 同一个目录、同一条"拿不到 `LOCALAPPDATA` 就给 `null`"的口径；
 * 差别只在文件名里带上了端口。**端口是文件名的一部分**：多实例下"这台机器上有几个后端"
 * 靠目录里这几份文件就能数出来，不必读任何一份的内容。
 */
export function serverPortFilePathForPort(
  port: number,
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): string | null {
  if (platform !== 'win32') return null;
  const local = (env['LOCALAPPDATA'] ?? '').trim();
  if (local === '') return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return join(local, 'Irmia', `${SERVER_PORT_FILE_PREFIX}${port}.json`);
}

/** 写端口文件；返回是否真写下去了（写不进去只记账，不抛） */
export function writeServerPortFile(input: {
  path: string | null;
  port: number;
  pid?: number;
  since?: string;
  now?: () => Date;
  out?: (line: string) => void;
}): boolean {
  if (input.path === null) return false;
  const now = input.now ?? (() => new Date());
  const record: ServerPortFile = {
    port: input.port,
    pid: input.pid ?? process.pid,
    since: input.since ?? now().toISOString(),
  };
  try {
    writeFileAtomicSync(input.path, `${JSON.stringify(record)}\n`);
    return true;
  } catch (err) {
    input.out?.(`[界面] 端口文件写不进去（${input.path}）：${err instanceof Error ? err.message : String(err)}`
      + '——界面会退回环境变量 / 默认端口那两档');
    return false;
  }
}

/**
 * 删掉端口文件（退出时）。
 *
 * `pid` 给了就**只删自己那一份**（文件里的 pid 与它不同 ⇒ 说明已经换了用户，别动）。
 */
export function removeServerPortFile(
  path: string | null,
  options: { pid?: number; out?: (line: string) => void } = {},
): void {
  if (path === null) return;
  try {
    if (options.pid !== undefined) {
      const current = readServerPortFile(path);
      if (current !== null && current.pid !== options.pid) return;
    }
    unlinkSync(path);
  } catch (err) {
    const code = (err as { code?: string }).code ?? '';
    if (code === 'ENOENT') return; // 本来就没有：退出路径上这不是错
    options.out?.(`[界面] 端口文件删不掉（${path}）：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 读端口文件（工具与用例用；界面那一半是 Dart，判据同源）。
 *
 * **解析失败一律当没有**：文件不是 JSON、顶层不是对象、`port` 不是 1..65535 的整数
 * ⇒ `null`。一个坏的提示位不该让谁去连一个瞎猜的端口。
 */
export function readServerPortFile(path: string): ServerPortFile | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const port = record['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const pid = record['pid'];
  const since = record['since'];
  return {
    port,
    pid: typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : 0,
    since: typeof since === 'string' ? since : '',
  };
}

/**
 * 旧名端口文件（`server.json`）**该不该由我这一份实例来写**。
 *
 * ── 为什么需要这个判据（2026-10-26 冒烟现场）─────────────────────────────
 *
 * 便携包解到新目录、`config.json` 里显式写着 `dataDir: "data"` 时，
 * `isDefaultDataDir()` 会把它判成"默认实例"（那一格的语义是"配置里写明了数据目录"，
 * 不是"我是最初装的那一份"）。于是一个**新副本**刚起来就把 `%LOCALAPPDATA%\Irmia\server.json`
 * 改成自己的端口 —— 而现役主实例还在跑，界面下次启动会照着它去连**新副本**。
 * 实测：装第二份的人，主界面被带到 7790，而 7790 是他随手试的那个冒烟副本。
 *
 * 判据只有一条：**盘上指着的那一份还活着，就不抢**。
 *   · 文件不存在 / 解析不出 ⇒ 写（`missing`）
 *   · 指向我自己 ⇒ 写（`same-pid`，重启后 pid 变了也是这一条的下一次）
 *   · 指向别的 pid，且那个 pid 活着 ⇒ **不写**（`live-other`）
 *   · 指向别的 pid，但那个 pid 已经死了 ⇒ 写（`stale`，接班）
 *
 * 纯函数：读盘与"pid 活没活"都由调用方注入，这样这条判据可以单测。
 */
export function shouldClaimLegacyPortFile(input: {
  path: string | null;
  pid: number;
  /** 现有文件的内容（调用方用 {@link readServerPortFile} 读；读不到传 null） */
  existing: ServerPortFile | null;
  /** pid 是否还活着（真实现：restart-worker 的 `pidAlive`） */
  alive: (pid: number) => boolean;
}): { claim: boolean; reason: 'no-path' | 'missing' | 'same-pid' | 'live-other' | 'stale' } {
  if (input.path === null) return { claim: false, reason: 'no-path' };
  const existing = input.existing;
  if (existing === null || existing.pid <= 0) return { claim: true, reason: 'missing' };
  if (existing.pid === input.pid) return { claim: true, reason: 'same-pid' };
  if (input.alive(existing.pid)) return { claim: false, reason: 'live-other' };
  return { claim: true, reason: 'stale' };
}
