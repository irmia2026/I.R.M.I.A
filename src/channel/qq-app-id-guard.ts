/**
 * 「同一 QQ App ID 被两个实例同时连接」的启动前检查。
 *
 * 为什么必须在**启用 QQ 官方通道之前**判：平台上同一个 bot 的 inbound 事件会被两端抢；
 * 两个进程各自把同一批消息写进各自的日志，就会出现"她有时收到、有时没收到"的幽灵现象。
 * 这里只做**读**：扫 `%APPDATA%\Irmia\instances.json` 里 pid 仍在跑的其它实例，读各自
 * `<dataDir>/.keys.json` 的 `qqAppId`，与当前解析出的 appId 比较。**不打印值**，也不写事件。
 *
 * 边界如实写：
 *   · 只比较 `.keys.json`；另一台若把 appId 放在环境变量里，这里看不到（那是环境级的显式覆盖）。
 *   · 两个实例**同时首次启动**时，登记表里都还没有对方 ⇒ 这里都会放行（竞态）；本函数只覆盖
 *     "已经有一台在跑、第二台再起"这条最常见的现场路径。
 */
import { readKeyFile } from '../config/keys.ts';
import { instancesFilePath, readInstancesFile } from '../runtime/instance-registry.ts';
import { comparisonKey } from '../tools/boundary.ts';

export interface QqAppIdConflict {
  /** 另一台实例的显示名（读不出来就回退到数据目录；不包含任何凭据） */
  name: string;
  port: number;
}

export interface QqAppIdGuardInput {
  /** 当前实例的数据目录 */
  dataDir: string;
  /** 当前实例实际会用的 appId（环境变量或 `.keys.json` 解析后的值） */
  appId: string;
  env?: Record<string, string | undefined>;
  /** 测试注入点；缺省查进程是否还活着 */
  isAlive?: (pid: number) => boolean;
  platform?: NodeJS.Platform;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但当前用户无权发信号；仍按"在跑"算（保守一侧）。
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sameDataDir(a: string, b: string): boolean {
  return comparisonKey(a) === comparisonKey(b);
}

/** 返回冲突的另一台实例；没有冲突（或没法判断）返回 null。 */
export function findQqAppIdConflict(input: QqAppIdGuardInput): QqAppIdConflict | null {
  const appId = input.appId.trim();
  if (appId === '') return null;
  const path = instancesFilePath(input.env ?? process.env, input.platform ?? process.platform);
  if (path === null) return null;
  const isAlive = input.isAlive ?? pidAlive;
  const instances = readInstancesFile(path).file.instances;
  for (const record of instances) {
    if (record.pid <= 0) continue;
    if (record.dataDir.trim() === '' || sameDataDir(record.dataDir, input.dataDir)) continue;
    if (!isAlive(record.pid)) continue;
    const other = (readKeyFile(record.dataDir, 'qqAppId') ?? '').trim();
    if (other === '' || other !== appId) continue;
    return { name: record.name.trim() === '' ? record.dataDir : record.name, port: record.port };
  }
  return null;
}
