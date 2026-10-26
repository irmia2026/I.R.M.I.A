/**
 * Irmia Agent — 进程入口编排（docs/design.md §4.7 恢复七步的宿主、README 快速验证）
 *
 * 启动顺序（不可打乱）：
 *   ① 恢复七步（runtime/recover.ts，内部含拿锁）→ ② 记 instance/takeover 与 session/start
 *   → ③ 布防唤醒源 → ④ 假循环起拍 → ⑤ 等信号。
 * 锁由恢复流程第一步拿：两个进程同时启动时，后来的那个要在碰日志之前就被挡在门外。
 *
 * 退出顺序是启动的镜像：先停源停循环（不再产生新事件），再写 session/end，
 * 最后落缓存、停定时器、关日志、放锁。M1 不调模型，优雅退出的代价就是这几步。
 *
 * 约定：值导入写 `.ts`（Node 的 --experimental-strip-types 只擦类型、不改写路径解析），
 * 编译输出由 rewriteRelativeImportExtensions 改回 .js。
 */

import { AGENT_VERSION } from './version.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AppEvent, Visibility, WakeChannel } from './log/types.js';
// 值导入：工具侧写入点的**可见性判据**（表说 model 的事件省略可见性即抛，见它的注释）
import { resolveEventVisibility } from './log/types.ts';
import { msgSeqOf, mentionsKeyword, shouldWakeForChannelMessage } from './channel/inbox.ts';
import { ManagedProtocolService, readEndpointFromConfig, resolveServiceDir } from './services/snowluma.ts';
import { normalizeSid, parseAliases } from './channel/sessions.ts';
import { createNotifier } from './alert/notifier.ts';
import { notifyStartupRecoveryDetailed, restoreStartupAlertWindow } from './alert/startup.ts';
import {
  CONFIG_FILE_NAME, lightLaneKeyPolicy, loadConfig, modelKeyGroups, readApiKey, trustBoundaryRoot,
  configHash, type AppConfig, type LoadedConfig,
} from './config/config.ts';
import { ConfigWatcher } from './config/watcher.ts';
import { ensurePersonaSeeds, loadPersona, type PersonaAssets } from './persona/loader.ts';
import { ensureMemorySeeds } from './persona/memory-maintain.ts';
import { ensureMemoryIndex } from './persona/memory-injection.ts';
import { DsClient, type DsResponse } from './model/ds-client.ts';
import type { SwitchDecision } from './model/transport/registry.ts';
import { McpClientPool, type McpClientPoolOptions, type McpDeclarationChange } from './mcp/client.ts';
import { buildCatalogRegistry } from './tools/catalog.ts';
import { createDepsManager, summarizeNotReady } from './deps/manager.ts';
import type { ToolRegistry } from './tools/registry.ts';
import type { InputNotifyPoster, MediaPoster, ReplyPoster } from './tools/admin.js';
import { SkillManager, planSkillRoots, type SkillRootRef } from './skill/skills.ts';
import { ensureSkillsSeed, SKILLS_DIR_NAME } from './skill/seed.ts';
// 路径比较（大小写 / 分隔符 / 尾部空格点的归一）只有一处实现：见 `tools/boundary.ts` 的文件头
import { comparisonKey } from './tools/boundary.ts';
import {
  HookRunner, digestProjection, hookConfigPath, loadHookConfig, protectedHookPaths,
} from './hook/hooks.ts';
import { RealLoop, memoryHostingEnabled } from './runtime/real-loop.ts';
import { instanceIdOf, startWebServer, type WebServer } from './web/server.ts';
// 启动期的**早绑端口**（2026-10-26）：先 listen、再干重活；就绪前 HTTP 答 starting/503
import { StartupState, startPreflightServer, type PreflightServer } from './web/preflight.ts';
// 端口文件（`%LOCALAPPDATA%\Irmia\server.json`）：界面取端口的第一档，见那个模块的文件头
import {
  readServerPortFile, removeServerPortFile, serverPortFilePath, serverPortFilePathForPort, shouldClaimLegacyPortFile, writeServerPortFile,
} from './runtime/server-port-file.ts';
// 实例登记表（`%APPDATA%\Irmia\instances.json`）：多实例下"这台机器上有哪些实例"的唯一真相源，
// **后端写、界面读**。判据与逐字段口径全在那个模块的文件头。
import {
  fallbackInstanceName, herNameFromIdentity, instancesFilePath as instancesFilePathOf, isDefaultDataDir,
  markInstanceReady, markInstanceStopped, upsertRunningInstance, type InstanceRecord,
} from './runtime/instance-registry.ts';

/** pid 是否还活着（用于"旧名端口文件别抢"那条判据；与 restart-worker 的 pidAlive 同口径：EPERM 也算活着） */
const legacyPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};
// 老生代上限的唯一来源（四条拉后端的路都读它；启动摘要那一行也在这里）
import { describeMaxOldSpace } from './runtime/node-memory.ts';
// 更新检查（2026-10-22）：检测器 + 节流/状态一层。只 GET 一个静态 JSON，不下载、不安装。
import { UpdateService } from './update/service.ts';
import { AUTH_FILE_NAME, AuthStore, UI_TOKEN_FILE } from './web/auth.ts';
import { WEBHOOK_SECRET_FILE_NAME } from './web/webhook-secret.ts';
import { backfillSharedKeys, keysPath, keyStatus } from './config/keys.ts';
import { applyOne, finalizePressure } from './state/fold.ts';
import { JobManager } from './runtime/job-manager.ts';
import {
  planTempSweep, runStartupTempSweep, runTempSweep,
} from './util/temp-sweep.ts';
import { LockHeldError, toInstanceTakeoverData, type TakeoverRecord } from './runtime/instance-lock.ts';
import {
  acquireInstanceGate, BackendAlreadyRunningError,
  type GateReclaimRecord,
} from './runtime/instance-guard.ts';
import {
  createGuiGuard, discoverGuiExe, launchGuiByStartProcess, listPidsByExePath, resolveGuardMode,
  DEFAULT_INTERVAL_MS, DEFAULT_MAX_RELAUNCH_PER_WINDOW, DEFAULT_WINDOW_MS,
  GUI_GUARD_OFF_FILE_NAME, GUI_PATH_FILE_NAME,
  type GuiGuard, type GuiGuardRecord,
} from './runtime/gui-guard.ts';
import { FakeLoop, maxTurnOfLog } from './runtime/loop.ts';
import { PluginManager, type PluginView } from './plugin/manager.ts';
import { PluginCircuitBreaker } from './plugin/circuit-breaker.ts';
import { composePluginMcp } from './plugin/contributions.ts';
import { PluginProbeCancelledError, type PluginFailure } from './plugin/failures.ts';
import { composePluginRuntime, mapPluginMcpOwners, mergeMcpDeclarations, pluginProtectedPaths, type PluginRuntimeComposition } from './plugin/runtime.ts';
import { allEventsOf } from './state/event-snapshot.ts';
import { EVENT_LOG_DIR_NAME, TIMER_FILE_NAME, recover, type RecoverResult } from './runtime/recover.ts';
import { TimerStore } from './wake/timer-store.ts';
import {
  QqOfficialChannel, createChannelReplyPoster,
} from './channel/qq-official.ts';
// 「这条是不是我自己发的」的判据（**只此一处**，见 onChannelMessage 上面那段）：
// 标识集合与那个问句都从这一个模块来，两条通道共用同一份实现。
import {
  SelfIdentity, isChannelNoticeData, type ChannelNoticeData,
} from './channel/self-identity.ts';
// 那一道闸的**调用入口**（判据只一份，见 `channel/self-message-gate.ts` 的文件头）
import { channelGate } from './channel/self-message-gate.ts';
import { createWorkspaceMediaPoster } from './channel/media-poster.ts';
import { createInputNotifyPoster } from './channel/input-notify.ts';
import {
  ONEBOT_REPLY_SCHEME, OneBotChannel, createOneBotReplyPoster,
} from './channel/onebot.ts';
import type { ChannelAdapter } from './channel/qq-official.js';
import {
  ManualWatchSource, TimerWakeSource, WAKE_WATCH_DIR_NAME, type WakeSourceAdapter,
} from './wake/sources.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/**
 * 产品版号（后端唯一真相源，写进 `session/start` 事件，GUI/CLI/日志都显示它）。
 * 改这一个要同步四处：`package.json` 的 version、`gui/pubspec.yaml` 的 version、
 * `gui/lib/pages/settings_page.dart` 的 `guiVersion`（界面显示），以及下面两个自持字面量：
 * `web/server.ts` 的 `McpProbeHost.clientInfo`、`mcp/client.ts` 的 `DEFAULT_CLIENT_INFO`。
 * 内测版口径：功能面到"能装能用"，但仍会有破坏性改动，所以带 `-beta` 预发布标记
 * （**具体是第几个内测版、版号是什么，以这一行的字面量为准**——别把版号抄进注释：
 * 出包脚本只改版号那一行、不改注释，抄一处就留一处对不上）。
 */
export { AGENT_VERSION } from './version.ts';
/** 事件形状版本（docs/schema.md） */
export const SCHEMA_VERSION = '1';
export const DEFAULT_DATA_DIR_NAME = 'data';

export type SessionEndReason = 'shutdown' | 'error' | 'signal';

// ──────────────────────────────── 对外类型 ────────────────────────────────

export interface MainOptions {
  /**
   * 数据目录（= 命令行 `--data-dir`，优先级最高）。
   * 缺省按 `IRMIA_DATA_DIR` → config.json 的 `dataDir` → `<cwd>/data` 依次退。
   */
  dataDir?: string;
  /**
   * 配置在哪（= 命令行 `--config`）：可以是**目录**，也可以直接给 `config.json` 的路径。
   * 缺省 `<cwd>/config.json`。它决定"读哪份配置"，而 config.json 里的 `dataDir`
   * 又是数据目录的第三档——所以它必须先于数据目录定下来（见 `resolveStartupPaths`）。
   */
  configPath?: string;
  /**
   * 监听端口（= 命令行 `--port`，优先级最高；缺省按 `config.web.port`）。
   *
   * 多实例的落点：安装根的 `config.json` 只有一个 `web.port`，而每台实例要一个自己的端口
   * （界面从 7788 起向上找第一个空闲的）。见 {@link parseMainArgs} 里那段取舍。
   */
  port?: number;
  out?: (line: string) => void;
  now?: () => Date;
  /** 嵌入方（测试、上级守护）自己管进程生命周期时可关掉 */
  installSignalHandlers?: boolean;
}

export interface MainHandle {
  readonly dataDir: string;
  readonly loop: FakeLoop | RealLoop;
  readonly sources: readonly WakeSourceAdapter[];
  readonly recovery: RecoverResult;
  readonly config: AppConfig;
  readonly persona: PersonaAssets;
  readonly webServer: WebServer | null;
  /** 优雅退出，幂等：停源 → 停循环 → session/end → 落缓存 → 停定时器 → 关日志 → 放锁 */
  stop(reason?: SessionEndReason, detail?: string): Promise<void>;
}

// ──────────────────────── 可测的纯函数段（2026-10-18 抽，REVIEW P1-29）────────────────────────
//
// 这几个函数是从 `runMain` / `main` 里抽出来的判据：
//   · `resolveDataDir`        —— 参数 > 环境变量 `IRMIA_DATA_DIR` > config.json 的 `dataDir`
//                                > `<cwd>/data`（**2026-10-23 补上第三档**，见下面那段长注释）
//   · `parseMainArgs`         —— 命令行里的 `--data-dir` / `--config` / `--port`（别的参数一律忽略）
//   · `resolveStartupPaths`   —— **先定配置路径、读它，再定数据目录**（顺序本身就是判据）
//   · `isDirectRun`           —— `process.argv[1]` 是不是本模块（决定"是入口还是被 import"）
//   · `startupExitCode` / `startupFailureLine` —— 启动失败 ⇒ exit 1 + 一行人话
// 抽的理由只有一个：**启动路径此前零覆盖**（REVIEW P1-29：`main.ts` 是唯一的生产装配入口，
// 而它的判据一条用例都没有）。抽的是判据，不是把 `runMain` 拆开——后者要建目录、开日志、
// 抢单实例锁、起模型客户端；那类"起真进程"的用例不在本笔的范围内，也不该拿它冒充覆盖。
// 用例在 `test/main-entry.test.ts`，与这里逐条对账（改这里要一起改那边）。

/**
 * 数据目录的**来路**：优先级链上第一个有值的那一档。启动摘要的「数据来源」逐字打印它。
 *
 * 四档而不是三档：`flag` 是宿主/命令行**直接给**的（`--data-dir`），它与"配置文件说了什么"
 * 是两件事——把它们都说成 `config` 会让摘要撒谎，而这份摘要存在的唯一理由就是
 * "此刻到底按谁说的在跑"。
 */
export type DataDirSource = 'flag' | 'env' | 'config' | 'cwd';

export interface DataDirResolution {
  /** 生效数据目录（**原样**：相对路径不在这里展开，历史语义如此，见下面的用例） */
  dataDir: string;
  /** 这个值是从哪一档来的 */
  source: DataDirSource;
}

/**
 * 数据目录的取值链：**`--data-dir` 参数 > `IRMIA_DATA_DIR` > config.json 的 `dataDir`
 * > `<cwd>/data`**。
 *
 * ── 第三档是 2026-10-23 补的，它修的是一个产品级故障 ──
 *
 * 现场（`data` 根是 `<安装根>/data`，`config.json` 里写着 `"dataDir": "<安装根>/data"` 的绝对路径）：
 * 从别的工作目录起进程，**key 从配置那份 `.keys.json` 读得到**（`readApiKey` 用的是
 * `config.dataDir`），而事件日志、人格、锁全写进了 `<cwd>/data`（`resolveDataDir` 用的是
 * 参数/环境变量/cwd）⇒ 启动摘要写着 `最大 seq 0`、人格是"种子模板未填写"，
 * 而她真实的 235197 条事件在另一个目录里。**一句话：配置说了 A，实际写进 B。**
 *
 * 为什么"只加一档"不够、还要看 `resolveStartupPaths`：`config.json` 的位置本身由
 * cwd / `--config` 决定，所以**必须先定配置路径、读配置，再定数据目录**——顺序反了，
 * 第三档就永远读不到（这正是原来那个写法：`resolveDataDir` 在 `loadConfig` 之前就定死了）。
 *
 * 两条分寸：
 *   · **空串也算"给了值"**（`??` 只看 null/undefined）：历史语义如此，钉在用例里。
 *     空值会在 `runMain` 的 `mkdirSync` 当场炸出来，不会静默换目录。
 *   · **相对路径不在这里展开**：`configDataDir` 由 `loadConfig` 交出时**已经是绝对路径**
 *     （它按配置文件所在目录解析，不是按 cwd），其余三档原样返回——"配置里的相对路径
 *     相对配置文件"这条语义因此只有一处实现（`config.ts` 的 `parseAppConfig`）。
 */
export function resolveDataDir(input: {
  /** `--data-dir` / `MainOptions.dataDir`：优先级最高 */
  dataDir?: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  /**
   * config.json 里**显式写下的** dataDir（`LoadedConfig.dataDirWritten !== null` 时才给）。
   * 传进来的是 `loaded.config.dataDir`——`loadConfig` 已按配置目录解析成绝对路径。
   */
  configDataDir?: string | undefined;
}): DataDirResolution {
  if (input.dataDir !== undefined) return { dataDir: input.dataDir, source: 'flag' };
  const fromEnv = input.env['IRMIA_DATA_DIR'];
  if (fromEnv !== undefined) return { dataDir: fromEnv, source: 'env' };
  if (input.configDataDir !== undefined) return { dataDir: input.configDataDir, source: 'config' };
  return { dataDir: join(input.cwd, DEFAULT_DATA_DIR_NAME), source: 'cwd' };
}

export interface MainArgs {
  dataDir?: string;
  configPath?: string;
  /** `--port`：界面/拉起器指定这一次监听哪个端口（多实例的关键一格，见 `parseMainArgs`） */
  port?: number;
  /** 认不出来的参数（原样留着，只为诊断）：**绝不该因为它们就拒绝启动** */
  ignored: string[];
}

/**
 * 认命令行里的三个参数：`--data-dir <路径>` / `--config <路径>` / `--port <端口>`
 * （`=` 写法同样认）。
 *
 * 为什么必须**宽容**（认不出来就忽略，而不是报错退出）：拉起器会往命令行里塞别的东西
 * ——`tools/restart-agent.ps1 -KillTag` 就是给入口追加一个 `--kill-tag=<值>`，那是**进程
 * 匹配用的标记**，本进程一个字都不该管。严格解析的后果不是"参数写错了"，而是
 * "她起不来了"，而症状会出现在一个与参数毫无关系的错误上。
 *
 * 空值（`--data-dir=`）当没给：手滑不该让一个无人值守进程起不来（那里还有 `mkdirSync`
 * 与"指到文件上"那道检查在兜底，静默换目录是不可能的）。
 *
 * **`--port` 是 2026-10 多实例加的那一格**：安装根的 `config.json` 只有**一个** `web.port`，
 * 而"新建实例"要给它一个自己的端口（界面从 7788 起找到的空闲端口）。两条路可选——让界面
 * 替新实例写一份 config.json，或把端口**当场**交给进程。选后者：界面不必懂配置文件的形状，
 * 也不会留下第二份"这台实例的配置"（多一份配置文件就多一处会跟人改的东西打架）。
 * 它**只**在命令行显式给的时候生效（不走环境变量）：继承来的 `IRMIA_WEB_PORT` 把后端带到
 * 另一个端口上，正是 `gui/lib/backend_port.dart` 文件头记的那次事故的形状。
 */
export function parseMainArgs(argv: readonly string[]): MainArgs {
  const out: MainArgs = { ignored: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (name !== '--data-dir' && name !== '--config' && name !== '--port') {
      out.ignored.push(arg);
      continue;
    }
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === undefined) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        index += 1;
      }
    }
    if (value === undefined || value === '') {
      out.ignored.push(arg);
      continue;
    }
    if (name === '--port') {
      const port = Number.parseInt(value, 10);
      // 非法端口当没给（宽容解析的一条：手滑不该让进程起不来，`config.web.port` 兜住）
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        out.ignored.push(arg);
        continue;
      }
      out.port = port;
      continue;
    }
    if (name === '--data-dir') out.dataDir = value;
    else out.configPath = value;
  }
  return out;
}

/** 启动期"配置在哪 + 数据目录在哪 + 它们是怎么定的"这一组事实 */
export interface StartupPaths {
  /** 配置目录（config.json 的父目录，绝对路径） */
  configDir: string;
  /** `loadConfig` 的结果；`loaded.config.dataDir` 这一格**已钉成生效数据目录**（见 `pinDataDir`） */
  loaded: LoadedConfig;
  /** 生效数据目录（**原样**，目录还没建） */
  dataDir: string;
  /** 数据目录的来路（启动摘要打印它） */
  source: DataDirSource;
  /** config.json 里写下的 dataDir 原文（可能是相对路径）；没写就是 null */
  configDataDir: string | null;
}

/**
 * **先定配置路径、读它，再定数据目录**——启动顺序的判据全在这一个函数里。
 *
 * 三件事按这个顺序做，顺序本身就是为什么它必须抽出来单独测：
 *   ① `configPath`（`--config` / 缺省 `<cwd>/config.json`）归一成**配置目录**；
 *   ② `loadConfig(configDir)` 真读（缺文件时它会写一份出厂配置——与从前同一行为）；
 *   ③ 用"配置里写没写 dataDir"决定第三档，走完四档得到生效数据目录，并把它**钉回配置对象**。
 *
 * 第③步里那个"钉"（`pinDataDir`）不是顺手：`config.dataDir` 是**好几个消费者**读的那一格
 * （`.keys.json`、协议端安装目录、依赖自装目录、trust 的缺省工作根），而事件/人格/锁读的是
 * `dataDir`。两份值就是两份事实——现场那个"key 读得到、事件却写进另一个目录"正是这么来的。
 */
export async function resolveStartupPaths(input: {
  dataDir?: string | undefined;
  configPath?: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
}): Promise<StartupPaths> {
  const configDir = normalizeConfigDir(input.configPath, input.cwd);
  const loaded = await loadConfig(configDir);
  const written = loaded.dataDirWritten;
  const resolved = resolveDataDir({
    dataDir: input.dataDir,
    env: input.env,
    cwd: input.cwd,
    ...(written === null ? {} : { configDataDir: loaded.config.dataDir }),
  });
  pinDataDir(loaded, resolved.dataDir);
  return {
    configDir,
    loaded,
    dataDir: resolved.dataDir,
    source: resolved.source,
    configDataDir: written,
  };
}

/**
 * 把**生效数据目录**钉进这份配置（返回同一个对象，就地改）。
 *
 * `config.json` 里的 `dataDir` 从此只是**输入**之一，不是运行期事实：否则 `IRMIA_DATA_DIR`
 * 或 `--data-dir` 一给，`config.dataDir` 与 `dataDir` 就分家了（现场那个脑裂）。
 * `configHash` 跟着重算——它描述的是**生效配置**的指纹（render 三输入之一）。
 */
export function pinDataDir(loaded: LoadedConfig, dataDir: string): LoadedConfig {
  if (loaded.config.dataDir !== dataDir) {
    loaded.config.dataDir = dataDir;
    loaded.configHash = configHash(loaded.config);
  }
  return loaded;
}

/**
 * 配置路径归一：允许给**目录**、也允许直接给 `config.json` 本身；没给就跑 `cwd`。
 * 相对路径相对 cwd（命令行参数的自然语义），之后一切都用绝对路径。
 */
function normalizeConfigDir(configPath: string | undefined, cwd: string): string {
  if (configPath === undefined || configPath.trim() === '') return resolve(cwd);
  const absolute = resolve(cwd, configPath.trim());
  return basename(absolute).toLowerCase() === CONFIG_FILE_NAME ? dirname(absolute) : absolute;
}

/** 启动结果 → 进程退出码：跑起来 = 0，启动失败 = 1（与抽之前逐字相同） */
export function startupExitCode(err: unknown): number {
  return err === null ? 0 : 1;
}

/** 启动失败写到 stderr 的那一行（Error 与非 Error 的写法由 `describeError` 定） */
export function startupFailureLine(err: unknown): string {
  return `[致命] 启动失败：${describeError(err)}`;
}

// ──────────────────────────────── 工具 ────────────────────────────────

/**
 * M1 没有配置系统，configHash 固定为空配置的摘要占位；
 * M4 接上 TOML 后改为读真实配置，字段含义不变（render 三输入指纹之一）。
 */
function emptyConfigHash(): string {
  return createHash('sha256').update('{}').digest('hex').slice(0, 16);
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * 读一眼 `persona/IDENTITY.md` 的正文（实例登记表要在 bind 那一刻知道"她叫什么"）。
 *
 * 为什么直接读文件而不是走 `loadPersona`：那一趟要读四个文件并算 personaHash，而这里
 * 只需要一行字。读不到就是 null（首启时这份文件还没被种下，登记表就走"目录末段"那一档）。
 */
function readIdentityText(dataDir: string): string | null {
  try {
    return readFileSync(join(dataDir, 'persona', 'IDENTITY.md'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * 启动摘要里「技能根」那一行（v79）。
 *
 * 为什么摘要里非有它不可：技能从 2026-10-23 起住在**数据目录**（`<dataDir>/skills`），
 * 而安装目录/仓库里的 `skills/` 只是出厂种子。这两件事在盘上是**两个同名目录**——
 * 光看摘要里的"数据目录"那一行，读的人分不出"她现在用的是哪一份技能"，而现场那次
 * "界面上没有任何技能"正是这么发生的。所以把**这次真正扫的那串根**印出来，
 * 并且明说哪个是数据目录、哪个是 cwd 兼容根（后者只在数据目录里还没有这一份时出现）。
 *
 * 没有根（`roots` 为空）时返回 null：那一行整个不出现，不印"技能根：（无）"这种空话。
 * 纯函数（不读盘）：入参就是 `planSkillRoots` 的结论，摘要与用例读同一份。
 */
export function renderSkillsRootLine(roots: readonly SkillRootRef[]): string | null {
  if (roots.length === 0) return null;
  const primary = roots.filter((root) => !root.compat).map((root) => root.dir);
  const compat = roots.filter((root) => root.compat).map((root) => root.dir);
  const head = primary.length === 0 ? '（数据目录里没有默认根）' : primary.join('、');
  const tail = compat.length === 0
    ? ''
    : `（附 cwd 兼容根 ${compat.join('、')}——数据目录里还没有这一份时才用它）`;
  return `技能根: 数据目录 ${head}${tail}`;
}

/**
 * 启动摘要：水位/待办/定时器/锁是无人值守场景最先要确认的四件事。
 *
 * 头三行是**同一个事实的三面**（2026-10-23 加）：`数据目录` 是"此刻真的写在哪"、
 * `配置` 是"读的是哪一份 config.json"、`数据来源` 是"这个数据目录是按谁说的定的"。
 * 为什么三行都要印：现场那次脑裂的全部症状就是这三件事对不上，而当时摘要里只有第一行
 * ——读的人因此看不出"配置说 A、实际写进 B"。三行必须**同时**出现且一致。
 */
export function renderStartupSummary(input: {
  dataDir: string;
  /** 生效的 config.json 绝对路径（`LoadedConfig.path`） */
  configPath: string;
  /** 数据目录的来路（`resolveDataDir` 的结论） */
  dataDirSource: DataDirSource;
  recovery: RecoverResult;
  timers: TimerStore;
  startTurn: number;
  mode: 'real' | 'fake';
  persona: PersonaAssets;
  /**
   * 技能根的生效计划（`planSkillRoots` 的结论；v79）。
   *
   * 可选：老的调用点/用例不传就不印那一行（生产装配 `main.ts` 一定传）。
   * 为什么不在这里现算：根的存在性要在**装配那一刻**判（数据目录里刚被复制过技能），
   * 而摘要渲染是之后的事——两处各算一次，就会出现"摘要说的根"与"真的要扫的根"不一致。
   */
  skills?: readonly SkillRootRef[];
}): string {
  const { dataDir, configPath, dataDirSource, recovery, timers, startTurn, mode, persona, skills } = input;
  const p = recovery.projection;
  const lines: string[] = [
    '=== Irmia Agent 启动摘要 ===',
    `数据目录: ${dataDir}`,
    `配置: ${configPath}`,
    `数据来源: ${dataDirSource}`,
    `循环模式: ${mode === 'real' ? '真循环（已配置模型）' : '假循环（未配置 API key，仅写事件不调模型）'}`,
    `人格: ${persona.isSeed ? '种子模板未填写（去 data/persona/ 填 IDENTITY.md）' : '已加载'}（hash ${persona.personaHash}）`,
    `事件日志: 最大 seq ${p.lastSeq} / 分片 ${recovery.log.shardFiles.length} 个`,
    `水位: ${p.watermark} / 待办 ${p.pending.length} 条 / 定时器 ${timers.list().length} 个（在途句柄 ${timers.armedCount()}）`,
    `未闭合 turn: ${p.openTurn === null ? '无' : `#${p.openTurn.turn}（本次恢复已结算）`}`,
    `下一轮 turn 号: ${startTurn + 1}`,
    `锁: 持有 pid ${recovery.lock.pid}（startedAt ${recovery.lock.startedAt}）`,
  ];
  if (skills !== undefined) {
    const skillsLine = renderSkillsRootLine(skills);
    if (skillsLine !== null) lines.push(skillsLine);
  }
  if (recovery.repairs.length > 0) {
    lines.push(`恢复补偿 ${recovery.repairs.length} 项:`);
    for (const repair of recovery.repairs) lines.push(`  - ${repair}`);
  }
  return lines.join('\n');
}

/**
 * 恢复开始前读一眼盘上的定时器 hint 表，记下"此刻已过期"的条目。
 * 用途见 runMain 里的补记逻辑：恢复流程对第一条过期条目是同步结算的，
 * 那一刻的回调只写日志，不产生 wake/timer——所以要在外面把事实补回来。
 */
async function overdueHints(timers: TimerStore, now: () => Date): Promise<Map<string, string>> {
  await timers.load();
  const nowMs = now().getTime();
  const overdue = new Map<string, string>();
  for (const entry of timers.list()) {
    if (Date.parse(entry.at) <= nowMs) overdue.set(entry.timerId, entry.at);
  }
  return overdue;
}

// ──────────────────────────────── 编排 ────────────────────────────────

/**
 * 一次 MCP 声明面热更的**净效果**（一句话）。诊断输出与给她的通报正文**共用这一份**
 * ——两处各写一遍必然漂移（一处改了、另一处照旧），而它们说的本来就是同一件事。
 *
 * 顺序即事实：`added` / `changed` 按新声明里的次序、`removed` 按旧声明里的次序
 * （它们要直接读进给她的那句话里，顺序乱了那句话读起来就像随机抽样）。
 * 三段各自成句，空的那段不出现（不写"删除了：无"这种机器腔）；
 * `style` 只决定动词用"加/删/改"还是"加了/删了/改了"（前者给日志、后者给正文）。
 */
function describeMcpDeclChange(change: McpDeclarationChange, style: 'terse' | 'sentence' = 'terse'): string {
  const verb = style === 'sentence'
    ? { added: '加了 ', removed: '删了 ', changed: '改了 ' }
    : { added: '加 ', removed: '删 ', changed: '改 ' };
  const sep = style === 'sentence' ? '，' : '；';
  const what = [
    change.added.length > 0 ? `${verb.added}${change.added.join('、')}` : '',
    change.removed.length > 0 ? `${verb.removed}${change.removed.join('、')}` : '',
    change.changed.length > 0 ? `${verb.changed}${change.changed.join('、')}` : '',
  ].filter((part) => part !== '').join(sep);
  // 三个都空 = 字段变了但每个 server 的内容都没变（多半只调了次序）：如实说，别留一句空话
  return what === '' ? '每个 server 的内容都没变' : what;
}

/**
 * 这次改动的**身份**（幂等键里那半段）：**动了哪些 server**，不含正文。
 *
 * 与 `web/server.ts` 的 `mcpChangeIdentityKeyOf` 是**同一把尺子**（那边管界面上的保存、
 * 这边管直接改文件），刻意各留一份而不是硬拉一个共享函数：两处的输入类型不同
 * （那边是配置文档里的裸条目、这边是解析后的 `McpDeclarationChange`），
 * 而"身份 = ±/~ 加名字集合"这条判据本身只有三行——共用一个泛型函数要靠适配器，
 * 适配器比这三行更容易漂。**两处都改时要一起看**（测试 `test/mcp-config-hot-reload.test.ts`）。
 */
function mcpReloadIdentityKeyOf(change: McpDeclarationChange): string {
  return [
    `+${[...change.added].sort().join(',')}`,
    `-${[...change.removed].sort().join(',')}`,
    `~${[...change.changed].sort().join(',')}`,
  ].join('|');
}

/**
 * 给她的那句话（`wake/manual{via:'mcp'}` 的正文）。
 *
 * 三件事必须都在里面，少一件这句话就没用：
 *   ① **变了什么**（加了/删了/改了哪些 server，逐字点名）；
 *   ② **现在一共几个**（"现在一个都没有了"而不是"一共 0 个"——后者读起来像故障码）；
 *   ③ **去哪儿看清单**（`mcp` 工具，不带 server）——这段通报**刻意不带工具全文**：
 *      披露式的全部价值就是"工具不进上下文，她调用时才披露"。
 *
 * 第四句（"索引不会立刻跟着变"）是**这条路独有**的：热更之后索引与配置会短暂不一致
 * （设计内，判据见 `real-loop.mcpIndexSync` 与 `HOT_RELOAD_FIELDS` ①）。
 * 不写这一句，她读到索引里没有那个新 server 时只会得出"我记错了"或"热更没生效"。
 *
 * 与 web 侧 `mcpChangeWakeNoteOf` 的差别也在这第一句：那条说的是"界面刚存了配置"，
 * 这条说的是"文件在运行期变了"——两条路的来源不同，正文里说清是哪一种，读历史的人才分得清。
 *
 * ⚠ **正文里不许出现 Markdown 记号**（2026-10-22 用户点名的硬性要求）：它是在界面上读的
 * 纯文本，渲染层不认 Markdown——要强调用「」或换行。
 */
export function mcpReloadNoteOf(change: McpDeclarationChange, totalAfter: number): string {
  const total = totalAfter === 0 ? '现在一个都没有了' : `现在一共 ${totalAfter} 个`;
  return [
    `config.json 里的 MCP 声明改了（改动当场生效，不用重启）：${describeMcpDeclChange(change, 'sentence')}`,
    `${total}。要看工具清单就用 \`mcp\` 工具（不带 server 看有哪些 server）。`,
    '⚠️ 你上下文里那份 MCP 常驻索引不会立刻跟着变——它保持原样，等下一次上下文重大变化'
      + '（压缩 / reset）或下次启动时才归集。所以这份通报是追加在末尾的：'
      + '以它为准，别以为索引里没写就等于没有。',
  ].join('\n');
}

/**
 * 内容哈希做幂等键（与 `web/server.ts` 的同名函数**逐字同源**：截 16 位 = 够区分又短到人能比对）。
 *
 * 为什么要在这里也有一份：`dedupeKey` 是**唤醒的幂等键**，唯一性规则必须与哪条路写的无关
 * ——同一个身份算出来的键在哪一边都得一样。那边那一份是模块私有函数（没导出），
 * 而为一个三行的哈希去导出它、再让 main.ts 去认 web 那一层，比留这一份更绕。
 */
function contentKey(prefix: string, text: string): string {
  return `${prefix}-${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)}`;
}

/**
 * vision 的用量账**落库那一跳**（2026-10-21 从 `runMain` 里抽出来；抽的唯一理由是**可测**）。
 *
 * `runMain` 那边只留"为什么这条账只能由宿主写"那一段（`recordVisionUsage` 的注释），记账本体在这里：
 * `origin: 'tools/vision'` 不能走宿主那个 `emit`（它写死 `origin: 'main'`），所以这是一个独立写入点。
 * 抽成模块级函数之后，`protocol` 那一格（协议回退 C-3）能被直接驱动断言，而不必启动整个进程
 * （`runMain` 要抢单实例锁，测试里跑不了）。
 *
 * 字段与 `channel/topic.ts` 的 `account()` 逐字段同形（既有的 light 记账写法），差别只有 `origin`。
 */
export function appendVisionConsumption(
  deps: { log: RecoverResult['log']; projection: RecoverResult['projection']; now: () => Date },
  response: DsResponse,
  turn: number,
  step: number,
): void {
  const { log, projection, now } = deps;
  const usage = response.usage;
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  const cacheHit = Math.max(0, Math.min(usage.cachedTokens, inputTokens));
  const event = {
    seq: log.nextSeq(),
    ts: now().toISOString(),
    type: 'budget/consumed',
    data: {
      turn,
      step,
      lane: 'light',
      // 模型名取响应里那一格（`DsResponse.model`），不猜——工具请求里那个可以是别名
      model: response.model,
      inputTokens,
      outputTokens,
      cacheHitTokens: cacheHit,
      cacheMissTokens: Math.max(0, inputTokens - cacheHit),
      // 思维链 token：**每次都写**（没产思维链就是 0），见 log/types.ts 的字段注释
      reasoningTokens: usage.reasoningTokens,
      // 这一发实际用的协议（协议回退 C-3）：**有就带、没有就不写**（不猜、不默认成 'responses'）。
      // 它不进请求体 ⇒ 不动 RENDER_VERSION。
      ...(response.protocol === undefined ? {} : { protocol: response.protocol }),
      // 对端没给 usage ⇒ 四格是补出来的 0（"预算少算"的判据；只在真缺时写这一格）
      ...(response.usageMissing === true ? { usageMissing: true as const } : {}),
      // 这一格是"这次 HTTP 往返"的量，`DsResponse` 自己带着，不必在这里读表
      durationMs: response.durationMs,
      retryCount: 0,
      finishReason: response.status === 'completed'
        ? 'completed'
        : (response.incompleteReason === 'max_output_tokens' ? 'max_output_tokens' : 'failed'),
      // 观测字段：本条写入之前的**内存投影**当日累计 + 本条（口径见 log/types.ts 该字段注释）
      tokensTodayAccum: projection.budget.tokensToday + inputTokens + outputTokens,
    },
    // `budget/consumed` 在 schema 表里是 internal ⇒ **一个字节都不进她的上下文**
    visibility: 'internal',
    origin: 'tools/vision',
  } as unknown as AppEvent;
  log.append(event, { sync: false });
  applyOne(projection, event);
  finalizePressure(projection, event.ts);
}

/**
 * **协议切换的留痕那一跳**（`model/protocol` 事件的落库本体，2026-10-21 从 `runMain` 里抽出来）。
 *
 * 抽出来的唯一理由与 {@link appendVisionConsumption} 相同：**可测**。`runMain` 要抢单实例锁，
 * 测试里跑不了，于是"事件里到底有没有 `model` / `evidence.url`"过去只能靠肉眼读代码
 * （评审 blocker ⑤ 就是这条：设计 §6.2 有这两格，事件里没有 ⇒ 账本答不出"哪个 baseUrl 不支持"）。
 * 抽成模块级函数之后，`test/protocol-observability.test.ts` 能直接驱动它、断言落下来的字段。
 *
 * 与 `runMain` 里那个 `append` 的口径**逐字段一致**：`sync: true`（这条账很少、但必须立刻可靠；
 * 它要在"两个协议都不通、那一拍没有任何 budget/consumed"时也能留痕）、`origin: 'main'`。
 * 刻意**不挑可见性**：调用方写死 `'internal'`（`EVENT_VISIBILITY` 里也登记了），她读不到它。
 */
export function appendProtocolSwitch(
  deps: { log: RecoverResult['log']; now: () => Date },
  decision: SwitchDecision,
): void {
  const { log, now } = deps;
  const event = {
    seq: log.nextSeq(),
    ts: now().toISOString(),
    type: 'model/protocol',
    data: {
      lane: decision.lane,
      // 发现时的模型：与 `evidence.url` 一起回答"**哪条 lane 的哪个模型**在**哪个端点**上不支持"
      model: decision.model,
      from: decision.from,
      to: decision.to,
      criterion: decision.criterion,
      evidence: decision.evidence,
      firstSeenAt: decision.firstSeenAt,
      decidedAt: decision.decidedAt,
    },
    // 事件是给"读日志的人与程序"的（`EVENT_VISIBILITY` 里登记为 internal：不进她的上下文）
    visibility: 'internal',
    origin: 'main',
  } as unknown as AppEvent;
  log.append(event, { sync: true });
}

/**
 * **两条 lane 的启动读数**（2026-10-21）：`models.<lane>.model @ models.<lane>.baseUrl`
 * + 那一格密钥的来源。
 *
 * 抽成模块级纯函数（只在启动时读一次 `process.env` 与 `data/.keys.json`）的三个理由：
 *   · 它是"现在跑的是什么"的**唯一一份人话读数**（设置页那行「现在跑的是 …」读的是同一对值：
 *     `models.<lane>.model` / `.baseUrl`；两处说法必须一致）；
 *   · `lightLaneKey` 的三档（本格 / 沿用 heavy / 没有）要在这里说出口——`null` 这一档
 *     （两格指向不同端点、而 light 没配 key）**不发任何请求**，启动时就该让人看见；
 *   · 密钥来源必须印出来：`resolveKey` 是**环境变量优先**，所以进程里一个旧的
 *     `IRMIA_API_KEY` 会压过设置页刚写进 `.keys.json` 的那把——"我填了新 key 却还是 401"
 *     只有这一行能解释。
 */
export function describeLaneReadout(config: AppConfig, lightLaneKey: string | null | undefined): string {
  const keyNote = (name: 'heavy' | 'light'): string => {
    const status = keyStatus(name, {
      dataDir: config.dataDir,
      envName: config.models[name].apiKeyEnv,
    });
    if (status.source === 'env') return `key 来自环境变量 ${status.envName}（优先，会压过密钥文件）`;
    if (status.source === 'file') return `key 来自 data/.keys.json 的 ${name} 格`;
    return '没有 key';
  };
  const lightNote = lightLaneKey === undefined
    ? `key 沿用 heavy 的（两格指向同一个端点；环境变量 ${config.models.light.apiKeyEnv}）`
    : (lightLaneKey === null
      ? `没有可用的 key（端点与 heavy 不同，不会借用 heavy 的密钥；设环境变量 ${config.models.light.apiKeyEnv}）`
      : keyNote('light'));
  return `[模型] 运行读数（启动这一刻定下，改 models.* 要重启进程才接管）：`
    + `heavy=${config.models.heavy.model} @ ${config.models.heavy.baseUrl}（${keyNote('heavy')}）`
    + ` · light=${config.models.light.model} @ ${config.models.light.baseUrl}（${lightNote}）`;
}

// ──────────────────────────── 半开探针 ────────────────────────────

/**
 * 半开探测的请求预算：**与常驻 MCP 池分开**。
 *
 * 常驻池那一格是「单请求 120 秒，progress 通知续期时硬顶 600 秒」——那是为"模型正等着
 * 一份真实结果"准备的耐心。半开探测回答的是另一个问题：「这条刚失败过的贡献，现在还通不通？」
 * 它压在 turn 边界与退出流程上（`circuitBreaker.stop()` 要等它收场），一个卡住的 server
 * 不该把一次"下次再说"拖成十分钟。超过下面这两个数就按"不知道通不通 = 还不通"处理，
 * 由熔断器继续退避：这比让用户干等一个已经坏掉的东西更诚实，也更早让人看见现场。
 */
const PLUGIN_PROBE_REQUEST_TIMEOUT_MS = 15_000;
const PLUGIN_PROBE_PROGRESS_HARD_CAP_MS = 30_000;

/**
 * 探针只需要「把这一条贡献拉起来试一次」，所以它只要最小的一对能力。
 *
 * 不直接用 `McpClientPool` 当类型，是为了让测试能换一个**不起进程**的替身去验
 * "只连哪一条、预算多大、能不能取消"这三条判据——真 MCP 子进程的连带行为本来就不是
 * 单测该碰的东西。
 */
export interface PluginProbePool {
  listTools(serverName: string, options: { requireConnected: boolean }): Promise<unknown>;
  shutdown(): Promise<unknown>;
}

export interface PluginProbeDeps {
  /**
   * `PluginManager.list()` 的只读面。
   *
   * 探测入口要的只是"哪个 `id@hash` 正处于 probing、它记下的故障贡献是哪一条"；
   * 用函数而不是整个 manager，是为了让这份判据能在没有插件目录的测试里直接验。
   */
  list: () => readonly PluginView[];
  dataDir: string;
  extraLaunchers?: readonly string[] | undefined;
  write: (line: string) => void;
  /** 建池口子：生产就是 `new McpClientPool(...)`；测试可换成替身。 */
  createPool?: ((options: McpClientPoolOptions) => PluginProbePool) | undefined;
}

export interface PluginProbeHandle {
  probe: (pluginId: string, contentHash: string) => Promise<void>;
  /**
   * 关停序列专用：把仍在飞的探测池全部关掉，让 `listTools` 立刻失败。
   *
   * 没有这一步，`circuitBreaker.stop()` 要等探针把 15s/30s 的预算走完——用户看到的是
   * "点了退出，进程半天不消失"。而这些池只承担一次探活，没有必须等它落地的状态。
   */
  cancelAll: () => Promise<void>;
}

/**
 * 建一个「半开探针」：只探 `circuit.contributionName` 指向的那一条贡献。
 *
 * 为什么必须只探一条：探针的语义是"复核原故障贡献"，同一包里的其它贡献并没有坏；
 * 把它们也逐条拉起来，既多起进程，又让每个 server 的超时叠在 turn 边界与退出路径上。
 *
 * 各贡献类型的复核方式不同：
 *   · `mcp`   —— 只把同名 server 交给探测池，其余不连；
 *   · `skill` —— 只复核声明的技能根目录仍可读，不起 MCP；
 *   · `hook`  —— **不经过探针**：`circuit-breaker` 在 `drainOnce` 里对 hook 直接跳过
 *     `runProbe`，改由 `composePluginRuntime` 把命中的条目送进 `HookRunner`，在 turn 边界
 *     拿真实执行结果回写 `noteSuccess`/`noteFailure`。探针收到 hook 会显式报路由错误。
 *
 * 找不到对应贡献时**抛错**而不是静默算成功（错误信息带上贡献名）：熔断器据此继续退避，
 * 日志里也说得清"探的是哪一条、为什么没找到"。
 */
export function createPluginProbe(deps: PluginProbeDeps): PluginProbeHandle {
  // 在飞的探测池：`cancelAll()` 从这里拿。用 Set 是因为 finally 里要按对象删掉。
  const activePools = new Set<PluginProbePool>();
  // 因关停正在被我们收掉的池：它的 `listTools` 拒绝是"宿主主动收摊"，不是插件又坏了。
  // 按池记而不是只按全局 `cancelled` 判，是为了不把另一个池上真实发生的失败也吞成取消。
  const cancelledPools = new Set<PluginProbePool>();
  const createPool = deps.createPool ?? ((options: McpClientPoolOptions) => new McpClientPool(options));
  let cancelled = false;
  const labelOf = (id: string, hash: string): string => `${id}@${hash.slice(0, 8)}`;

  const probeMcpContribution = async (view: PluginView, contributionName: string): Promise<void> => {
    const mcp = composePluginMcp([view.package], deps.extraLaunchers);
    if (mcp.warnings.length > 0) throw new Error(mcp.warnings.join('; '));
    const server = mcp.servers.find((entry) => entry.name === contributionName);
    if (server === undefined) {
      const declared = mcp.servers.map((entry) => entry.name);
      throw new Error(`插件 ${view.package.manifest.id} 找不到故障贡献 ${contributionName}：`
        + `当前 MCP 声明里${declared.length === 0 ? '没有可用 server' : `只有 ${declared.join('、')}`}`);
    }
    const pool = createPool({
      servers: [server],
      dataDir: deps.dataDir,
      toolsCache: false,
      emit: () => {},
      requestTimeoutMs: PLUGIN_PROBE_REQUEST_TIMEOUT_MS,
      progressHardCapMs: PLUGIN_PROBE_PROGRESS_HARD_CAP_MS,
      onLog: (line) => { deps.write(`[插件探测] ${line}`); },
    });
    activePools.add(pool);
    try {
      await pool.listTools(server.name, { requireConnected: true });
    } catch (error) {
      // 关停时 `cancelAll()` 会先把这个池记进 cancelledPools 再 shutdown：这里的拒绝是
      // "我们让它停的"，必须抛可识别的取消类型 —— 熔断器据此只还原隔离态、不记 strike，
      // 也不写 plugin/quarantined；否则用户关一次进程就会平白把隔离期翻倍。
      if (cancelledPools.has(pool)) {
        throw new PluginProbeCancelledError(`插件 ${labelOf(view.package.manifest.id, view.package.contentHash)} 的半开探测在关停时被取消：${describeError(error)}`);
      }
      throw error;
    } finally {
      const cancelledHere = cancelledPools.has(pool);
      activePools.delete(pool);
      cancelledPools.delete(pool);
      try {
        // 关停竞态下 `cancelAll()` 可能已经在收同一个池；`shutdown()` 幂等，重复调用只是等它收完。
        await pool.shutdown();
      } catch (error) {
        // 取消路径上 shutdown 自己的异常不能再冒出来：它会盖掉上面刚抛的
        // `PluginProbeCancelledError`，熔断器又会把"宿主收摊"误记成插件失败。
        if (!cancelledHere) throw error;
        deps.write(`[插件探测] 取消探测池时 shutdown 报错（已忽略，退出继续）：${describeError(error)}`);
      }
    }
  };

  const probeSkillContribution = (view: PluginView, contributionName: string): void => {
    const declared = view.package.manifest.contributions.skills;
    if (!declared.includes(contributionName)) {
      throw new Error(`插件 ${view.package.manifest.id} 找不到故障贡献 ${contributionName}：`
        + `当前 Skill 声明里${declared.length === 0 ? '没有技能根' : `只有 ${declared.join('、')}`}`);
    }
    try {
      // 探活只需要"这个根还在、还能列目录"；SKILL.md 的扫描与校验由 SkillManager 自己那一拍做。
      readdirSync(join(view.package.rootDir, contributionName));
    } catch (error) {
      throw new Error(`插件 ${view.package.manifest.id} 的 Skill 根目录不可读：${contributionName}（${describeError(error)}）`);
    }
  };

  const probe = async (id: string, hash: string): Promise<void> => {
    // 关停已经开始：新探测不必再起，直接以"取消"收场（熔断器会还原隔离态、不记 strike）。
    if (cancelled) throw new PluginProbeCancelledError(`插件 ${labelOf(id, hash)} 的半开探测已随宿主关停取消`);
    const view = deps.list().find((item) => item.package.manifest.id === id
      && item.package.contentHash === hash && item.state === 'probing');
    if (view === undefined) {
      throw new Error(`插件 ${labelOf(id, hash)} 不在半开探测状态（可能已被禁用、移除或重启过），无法探测`);
    }
    const circuit = view.circuit;
    if (circuit === undefined) {
      throw new Error(`插件 ${labelOf(id, hash)} 处于半开状态却没有记录故障贡献，无法确定该探哪一条`);
    }
    switch (circuit.contributionKind) {
      case 'mcp':
        return probeMcpContribution(view, circuit.contributionName);
      case 'hook':
        // Hook 不由探针复核：`drainOnce`（circuit-breaker.ts）对 hook 直接 dirty+continue，
        // 真正的复核是 `composePluginRuntime` 把这一条送进 HookRunner、在 turn 边界按执行
        // 结果回写 `noteSuccess`/`noteFailure`（main.ts 的 hook emit 那一段）。
        // 今天走不到这里；真被送进来就显式报路由错误——宁可让熔断器看见一条"探针收到
        // 不该它管的类型"的失败，也不要伪造一次声明复核结果。
        throw new Error(`插件 ${labelOf(id, hash)} 的 Hook 贡献不由半开探针复核（由 HookRunner 在 turn 边界实测）`);
      case 'skill':
        probeSkillContribution(view, circuit.contributionName);
        return;
      default:
        throw new Error(`插件 ${labelOf(id, hash)} 的故障贡献类型未知：${circuit.contributionKind}`);
    }
  };

  const cancelAll = async (): Promise<void> => {
    cancelled = true;
    const pools = [...activePools];
    // 先登记"这些池是被我们主动收掉的"：`listTools` 的拒绝要靠这个判据折算成取消。
    for (const pool of pools) cancelledPools.add(pool);
    // 关停路径上"某个池收不掉"不该拦住退出：各自 best-effort，异常只影响它自己。
    const settled = await Promise.allSettled(pools.map(async (pool) => { await pool.shutdown(); }));
    const failed = settled.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
    // 但也不能吞掉：退出时哪个探测池没关掉，事后要查得到（与主 MCP 池关机同一条纪律）。
    if (failed.length > 0) {
      deps.write(`[插件探测] ${failed.length} 个探测池关停失败，退出继续：${failed.map((item) => describeError(item.reason)).join('; ')}`);
    }
  };

  return { probe, cancelAll };
}

export async function runMain(options: MainOptions = {}): Promise<MainHandle> {
  const write = options.out ?? ((line: string) => {
    console.log(line);
  });
  const now = options.now ?? (() => new Date());

  /**
   * ── 顺序即判据（2026-10-23）：① 先定"读哪份配置"并真读它 → ② 再由它定数据目录 ──
   *
   * 反过来（先按 cwd/环境变量定数据目录，再读 cwd 的配置）就是那个产品级故障：
   * 数据目录的第三档 `config.json` 的 `dataDir` **永远来不及生效**（`loadConfig` 在它之后），
   * 而 key 那一侧读的偏偏是 `config.dataDir` ⇒ 配置说 A、实际写进 B，seq 从 0 开始。
   * 判据全部在 `resolveStartupPaths` 里（含"配置里的相对 dataDir 相对配置文件"），这里只装配。
   */
  const startup = await resolveStartupPaths({
    dataDir: options.dataDir,
    configPath: options.configPath,
    env: process.env,
    cwd: process.cwd(),
  });
  const loadedConfig = startup.loaded;
  const config = loadedConfig.config;
  const dataDir = startup.dataDir;

  /**
   * `--port`：**显式给的端口压过 config.json 的 `web.port`**（多实例的唯一入口）。
   *
   * 只在命令行显式给的时候生效（不看环境变量，理由见 `parseMainArgs`）。它落在 `config.web.port`
   * 上而不是另开一格里：**下游每一处（preflight / startWebServer / 端口文件 / 登记表）
   * 读的都是同一个 `config.web.port`**，两处取值就是两份事实，而"听起来 7789、实际听 7788"
   * 那种故障查起来最贵。说出来的那一行是必须的：改了一个数就得有人能看见是谁改的。
   */
  if (options.port !== undefined) {
    const before = config.web.port;
    config.web.port = options.port;
    write(`[界面] 端口按命令行 --port=${options.port} 生效（config.json 里写的是 ${before}）`);
  }

  // 先把"指到文件上"这种错抓出来，别让它变成一句 `EEXIST: file already exists, mkdir
  // '…\config.json'`——那个报错只说"已经存在"，完全看不出根因是"我把一个文件当目录用了"，
  // 排查的人会以为代码有 bug（真发生过一次：一个冒烟脚本把 dataDir 指到了 config.json）。
  if (existsSync(dataDir) && !statSync(dataDir).isDirectory()) {
    throw new Error(`数据目录指向了一个文件：${dataDir}——它应该是一个目录（检查 --data-dir / IRMIA_DATA_DIR / config.json 的 dataDir；本次来源 ${startup.source}）`);
  }
  mkdirSync(dataDir, { recursive: true });

  /**
   * 「配置说一套、实际写进另一套」必须当场说出来（2026-10-23）。
   *
   * 为什么不靠上面那三行摘要：它们只说"现在用的是哪个"，而**最容易误判的那种现场**
   * 是"我以为配置生效了"——所以两个数一旦不同就在启动日志里点明"配置那一格本次不生效，
   * 改它没用"（要改就得先撤掉 `--data-dir` / `IRMIA_DATA_DIR`，或重启）。
   *
   * **值相同就不说**：环境变量恰好等于配置里那个值时，"配置那一格不生效"是一句噪音
   * ——它确实不生效，但结果一样，读者不需要为这句话去改任何东西。判据是路径比较
   * （`comparisonKey`）而不是字符串相等：Windows 上大小写与分隔符写法都不改变
   * "是不是同一个目录"。
   */
  if (
    startup.configDataDir !== null
    && startup.source !== 'config'
    && comparisonKey(startup.configDataDir) !== comparisonKey(dataDir)
  ) {
    const via = startup.source === 'flag' ? '--data-dir 参数' : '环境变量 IRMIA_DATA_DIR';
    write(`[配置] config.json 写的是 dataDir=${startup.configDataDir}，但本次生效的是 ${dataDir}`
      + `（来源：${via}）——配置那一格本次不生效，改它没用`);
  }

  /**
   * ── ⓪ 开工第一行：**老生代上限是多少、这个数是谁给的**（2026-10-26）──────────────
   *
   * 事故那天 OOM 之后，日志里只有 `FATAL ERROR: Reached heap limit`——看不出上限是多少、
   * 更看不出是**哪条路**给的（同一份安装上，拉起器给 512、看护脚本给 1024，两种生死）。
   * 这一行让下一次 OOM 有得查：策略值（环境变量或 1024 缺省）+ 本进程命令行到底带没带。
   *
   * 唯一的数在 `runtime/node-memory.ts`（四条拉后端的路都读它）。
   */
  write(describeMaxOldSpace());

  /**
   * ── ① 端口**先 bind**，重活后干（2026-10-26 的事故根治点）────────────────────────
   *
   * 事故现场：后端冷启动到开始监听要 **35–42 秒**（23.5 万条事件首折 + MCP + SnowLuma
   * 预热），而拉起器等端口的窗口是 32 秒 ⇒ 每次「重启前后端」都被判失败，界面连不上、
   * 后端半途生死不明（`data/restart-worker.log` 那行 `[结束] ok=False … port=timeout`）。
   *
   * 所以顺序反过来：配置一读出来就把端口 bind 住（`preflight.ts`），重活照旧在后面干。
   * 这中间 HTTP 层**照常答话**：`GET /api/health` 报 `starting`，其余 `/api` 回 503
   * `{starting:true, phase}`——拉起器与界面凭这两个读数就知道"它在起，不是没了"。
   *
   * 三件配套：
   *   · `auth` 在这里**早建一份**：启动期 `GET /api/auth/state` 也要能答（界面进门第一步），
   *     而且它与就绪后是**同一个实例**（认证判据只有一份，在 AuthStore 里）；
   *   · **端口文件**：bind 成功那一刻写下 `{port,pid,since}`，界面按它取端口（第一档来源）；
   *   · **失败不拦启动**：端口被占时说清"没能先 bind"，后面 `startWebServer` 照旧会如实报。
   */
  const boundPort: { value: number } = { value: 0 };
  const startupState = new StartupState({
    port: () => (boundPort.value > 0 ? boundPort.value : config.web.port),
    now: () => now().getTime(),
  });
  /**
   * ── 实例登记（多实例，2026-10）─────────────────────────────────────────────────
   *
   * 「登出 = 结束当前实例」之后界面要回到**实例选择页**，而它得知道这台机器上登记过哪些
   * 实例、每个实例该用哪个 node 跑哪个入口、数据目录在哪——那些只有**正在跑的后端**知道。
   * 所以 bind 成功那一刻把自己写进 `%APPDATA%\Irmia\instances.json`（唯一真相源在盘上，
   * 后端写、界面读），并把端口文件改成**每实例一份**：`server.<port>.json`；
   * 旧名 `server.json` 只由**默认实例**写（界面旧逻辑读它照旧能进默认实例）。
   *
   * 三条分寸（与端口文件同一套）：bind 成功那一刻才写；退出时清 pid 而不是删条目；
   * 写不进去**不拦启动**（登记表是一个提示位，界面还有"读不到就当没有"那一档）。
   * 判据与逐字段口径全在 `runtime/instance-registry.ts` 的文件头，这里只做装配。
   */
  const instancesPath = instancesFilePathOf(process.env);
  /** 旧名的端口文件（`server.json`：**只有默认实例写**，见下面 registerInstance） */
  const portFilePath = serverPortFilePath(process.env);
  /** 入口脚本：`node <entry> …` 的那个。宿主嵌入（测试）时它可能是用例文件——登记表只认相对路径之外的事实 */
  const entryPath = ((): string => {
    const raw = (process.argv[1] ?? '').trim();
    return raw === '' ? '' : resolve(raw);
  })();
  const isDefaultInstance = isDefaultDataDir({
    entry: entryPath,
    dataDir,
    configDataDir: startup.configDataDir,
  });
  /** 每实例一份的端口文件路径（bind 成功那一刻才定得下来：端口是文件名的一部分） */
  let perInstancePortPath: string | null = null;
  /**
   * 登记表里自己那条（`/api/instance` 与退出路径都读它；写不进去就是 null）。
   *
   * 用一个**容器**而不是裸的 `let x: T | null`：赋值发生在闭包里，而 TS 对闭包外的赋值
   * 一律看不见——裸变量在 `if (x === null) … else { x.name }` 处会被窄化成 `never`。
   */
  const instanceRef: { record: InstanceRecord | null } = { record: null };
  const registerInstance = (port: number): void => {
    if (port <= 0) return;
    perInstancePortPath = serverPortFilePathForPort(port, process.env);
    if (writeServerPortFile({
      path: perInstancePortPath,
      port,
      pid: process.pid,
      now,
      out: write,
    })) {
      write(`[界面] 每实例端口文件已写：${perInstancePortPath}（{"port":${port},"pid":${process.pid}}）`);
    }
    // 旧名：**只有默认实例写**。非默认实例写它会把默认实例那一份顶掉——那正是多实例下
    // "界面被带到一个已经不在的端口"的那条老路（见 runtime/server-port-file.ts 的文件头）
    if (isDefaultInstance) {
      // 2026-10-26 补一条更硬的判据：**盘上指着的那一份还活着就不抢**。
      // 否则一个便携副本（config.json 里显式写着 dataDir，于是被判成"默认实例"）
      // 一起来就把现役主实例的端口指针改成自己的——实测：主界面被带到了新副本的端口上。
      const legacyClaim = shouldClaimLegacyPortFile({
        path: portFilePath,
        pid: process.pid,
        existing: portFilePath === null ? null : readServerPortFile(portFilePath),
        alive: legacyPidAlive,
      });
      if (!legacyClaim.claim) {
        write(`[界面] 旧名端口文件**没抢**：${portFilePath}（判据 ${legacyClaim.reason}）`
          + '——另一份实例正在用它，抢了会把界面带到我这边来');
      } else if (writeServerPortFile({
        path: portFilePath,
        port,
        pid: process.pid,
        now,
        out: write,
      })) {
        write(`[界面] 端口文件已写：${portFilePath}（默认实例；{"port":${port},"pid":${process.pid}}）`
          + '——界面按它找端口，不再只靠环境变量 IRMIA_WEB_PORT');
      }
    }
    // 名字取她的（`persona/IDENTITY.md` 解出来的；解不出用目录末段）。**出处一起交给登记表**：
    // 只有"这次真解出来了"（identity）才有资格把旧条目里那个回落的名字升级一次
    // （见 `runtime/instance-registry.ts` 的 `nameSourceOf` / `upsertRunningInstance`）。
    const identityName = herNameFromIdentity(readIdentityText(dataDir));
    instanceRef.record = upsertRunningInstance({
      path: instancesPath,
      id: instanceIdOf(config.web.host, port, dataDir),
      name: identityName ?? fallbackInstanceName(dataDir),
      nameSource: identityName === null ? 'dir' : 'identity',
      dataDir,
      host: config.web.host,
      port,
      pid: process.pid,
      nodeExe: process.execPath,
      entry: entryPath,
      isDefault: isDefaultInstance,
      now,
      out: write,
    });
  };
  const authStore = new AuthStore({ dataDir, now, out: write });
  let preflight: PreflightServer | null = null;
  try {
    preflight = await startPreflightServer({
      host: config.web.host,
      port: config.web.port,
      state: startupState,
      auth: authStore,
      out: write,
    });
    boundPort.value = preflight.portOf();
    registerInstance(boundPort.value);
  } catch (err) {
    preflight = null;
    write(`[界面] 端口没能先 bind（${describeError(err)}）——不拦启动；`
      + '如果端口被占，本次的界面仍会退回环境变量 / 默认端口那两档去找后端');
  }
  /** 收掉那个"还没交给真服务"的 socket（启动失败 / 退出时用；已经 handoff 之后是空操作） */
  const closePreflight = async (): Promise<void> => {
    const current = preflight;
    if (current === null || current.handedOff()) return;
    preflight = null;
    removeServerPortFile(portFilePath, { pid: process.pid, out: write });
    await current.close();
  };

  // 配置与人格：配置已在上面加载好（configHash 是 render 三指纹之一），这里确保人格种子并加载
  const seededFiles = ensurePersonaSeeds(dataDir);
  const persona = loadPersona(dataDir);
  if (seededFiles.length > 0) write(`[人格] 首次启动，已写入种子文件：${seededFiles.join('、')}`);
  if (persona.isSeed) write('[人格] 种子模板未填写——首个心跳 turn 将引导用户完善 IDENTITY.md');

  // 记忆结构同样要在**启动时**就位：她随时可能想记一笔（episodes/ 流水账、facts.md 事实），
  // 不能等第一次整理（默认每日 4 点）才创建——那之前她会发现"记忆目录不存在"而写不下去。
  const seededMemory = ensureMemorySeeds(dataDir);
  if (seededMemory.length > 0) write(`[记忆] 首次启动，已建好记忆结构：${seededMemory.join('、')}`);
  // 记忆索引（B2）：与种子同一风格——机制保证"结构存在"，但它的内容由记忆文件生成。
  // 幂等（内容没变不写盘）：否则每次重启都会把常驻前缀打掉一次，而重启并不改变任何一条记忆。
  //
  // **关掉框架代管记忆时整段跳过**（v32，docs/persona.md §3.1）：不再生成、也不再重建
  // `INDEX.md`——盘上已有的那份留在原地（框架此后一个字节都不动它），读、写、整理全归她自己。
  // 判据与运行期（real-loop 的索引注入、每日整理布防）**同一处**（`memoryHostingEnabled`）。
  // 上面那一步仍然建目录结构：「记忆托管」关的是框架替她做的那半，不是她自己的文件系统——
  // 她随时可能想记一笔，那时发现"记忆目录不存在"才是真的坏。
  if (memoryHostingEnabled(config)) {
    const indexAction = ensureMemoryIndex(dataDir);
    if (indexAction !== 'unchanged') write(`[记忆] 已${indexAction === 'created' ? '生成' : '重建'}记忆索引 INDEX.md`);
  } else {
    write('[记忆] 记忆托管已关（persona.memoryEnabled = false）：不生成、不重建索引 INDEX.md，'
      + '每日整理也不布防——读、写、整理全归她自己');
  }

  // 定时器表由宿主创建并交给恢复流程：唤醒源必须在同一份表上挂 onDue 回调。
  // 若让 recover 自建一份，它的回调只写日志，到期事实不会变成 wake/timer 事件。
  const timers = new TimerStore(join(dataDir, TIMER_FILE_NAME), { now });
  const overdue = await overdueHints(timers, now);

  const lockState: { takeover: TakeoverRecord | null } = { takeover: null };
  let stopRef: ((reason: SessionEndReason, detail?: string) => Promise<void>) | null = null;

  /**
   * ── 单实例：**接管闸门**罩住恢复流程的第一步（那次可能并发的接管）──
   *
   * 为什么必须在 `recover()` 外面再包一层：`instance-lock.ts` 的排他创建对**首次创建**
   * 是原子的，但**接管陈旧锁**走的是"判定 → tmp+rename 覆盖 → 回读"，而 rename 覆盖
   * 不是比较并交换——两个进程都可能在对方写之前读到"前任已死"，然后**都**认为自己持了锁
   * （完整的交错写在 `instance-guard.ts` 的文件头）。那正是"两套 turn 同时跑"的形状。
   *
   * 闸门（`<dataDir>/lock.json.takeover`，同样 `wx` 排他创建）把"判定 + 写入"串起来：
   * 谁拿不到闸门就**如实拒绝启动**，一个字节都不写。它只在 recover 期间持有。
   *
   * 判据一处都没多：接管结论（pid-gone / pid-reused / stale-heartbeat + 宽限期）仍然
   * 整个由 `instance-lock.ts` 给；这里只负责**串行**。
   */
  const gate = await acquireInstanceGate(dataDir, {
    log: (level, message, extra) => {
      write(`[锁/${level}] ${message}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
    },
    onReclaim: (record: GateReclaimRecord) => {
      write(`[锁] 接管了陈旧闸门：前任 pid ${record.previousPid ?? '未知'}（${record.staleBecause}`
        + `${record.heldMs === null ? '' : `，持有了 ${Math.round(record.heldMs / 1000)} 秒`}）——`
        + '上一个实例是在接管单实例锁的中途死的；本次继续，接管本身的留痕见紧随的 instance/takeover');
    },
  });

  let recovery: RecoverResult;
  try {
    recovery = await recover(
      {
        dataDir,
        timers,
        log: (level, message, extra) => {
          write(`[恢复/${level}] ${message}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
        },
      },
      {
        now: () => now().getTime(),
        onTakeover: (record) => {
          lockState.takeover = record;
        },
        onStolen: (info) => {
          // 锁被夺走意味着双写风险已经成立：唯一正确的动作是立刻退出，不再写任何事件
          write(`[致命] 锁已不属于本进程（当前持有者 pid ${info.observed?.pid ?? '未知'}），立即退出`);
          const stop = stopRef;
          if (stop !== null) {
            void stop('error', '锁被接管').then(() => {
              process.exitCode = 1;
              process.exit(1);
            });
          }
        },
      },
    );
  } catch (err) {
    // 起不来就别留着那个"已经在听"的端口：一份指向死进程的端口文件会把界面带到一个
    // 永远不该被连的端口上（那正是这次事故的另一半）。
    await closePreflight();
    // 「已经有一个后端在跑」要有一句人能直接读懂的话，而不是一个 LockHeldError 的类名
    // （用户 2026-10-11 要的判据：第二个实例**立刻退出** + 人话说明）
    if (err instanceof LockHeldError) {
      throw new BackendAlreadyRunningError(err.file, err.holder.pid, err.holder.startedAt);
    }
    throw err;
  } finally {
    gate.release();
  }

  const { log, lock } = recovery;

  const append = (type: string, data: unknown, visibility: Visibility): AppEvent => {
    const event = {
      seq: log.nextSeq(),
      ts: now().toISOString(),
      type,
      data,
      visibility,
      origin: 'main',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    return event;
  };

  const pluginManager = new PluginManager(dataDir, (type, data) => {
    append(type, data, 'internal');
  });
  pluginManager.setEvents(await allEventsOf(log));
  let pluginRuntime = composePluginRuntime(pluginManager, config.mcp.extraLaunchers);
  let pluginMcpOwners = new Map<string, { pluginId: string; contentHash: string }>();
  let circuitBreaker: PluginCircuitBreaker | null = null;
  let replacePluginHooks: (entries: Parameters<HookRunner['setEntries']>[0]) => void = () => {};
  let replacePluginSkills: (roots: PluginRuntimeComposition['skillRoots']) => void = () => {};
  for (const warning of pluginRuntime.warnings) write(`[插件] ${warning}`);
  const mcpDeclarations = (): readonly import('./mcp/client.js').McpServerEntry[] => {
    pluginMcpOwners = mapPluginMcpOwners(config.mcp.servers, pluginRuntime.packages, config.mcp.extraLaunchers);
    try {
      return mergeMcpDeclarations(config.mcp.servers, pluginRuntime.mcpServers);
    } catch (error) {
      write(`[插件] MCP 声明冲突，保留内置配置：${describeError(error)}`);
      return config.mcp.servers;
    }
  };
  let runtimeApplyChain: Promise<unknown> = Promise.resolve();
  const applyRuntimeDeclarations = <T>(action: (declarations: () => readonly import('./mcp/client.js').McpServerEntry[]) => Promise<T>): Promise<T> => {
    const run = runtimeApplyChain.then(async () => await action(mcpDeclarations));
    runtimeApplyChain = run.catch(() => undefined);
    return run;
  };
  const applyPluginRuntime = (): Promise<void> => applyRuntimeDeclarations(async (currentDeclarations) => {
    pluginRuntime = composePluginRuntime(pluginManager, config.mcp.extraLaunchers);
    const owners = mapPluginMcpOwners(config.mcp.servers, pluginRuntime.packages, config.mcp.extraLaunchers);
    pluginMcpOwners = owners;
    replacePluginSkills(pluginRuntime.skillRoots);
    replacePluginHooks(pluginRuntime.hookEntries);
    await mcpPoolRef.pool?.applyDeclarations(currentDeclarations());
    for (const warning of pluginRuntime.warnings) write(`[插件] ${warning}`);
  });
  const mcpPluginFailure = (serverName: string, category: PluginFailure['category'], message: string): PluginFailure | null => {
    const owner = pluginMcpOwners.get(serverName);
    if (owner === undefined) return null;
    return { ...owner, contributionKind: 'mcp', contributionName: serverName, category, message };
  };
  /**
   * 半开探针：只探熔断器记下的那一条贡献，并给它一份独立的短预算。
   *
   * 判据与分支都在模块级的 `createPluginProbe`（那里能脱离 `runMain` 验）；这里只做装配，
   * 顺手把"在飞的探测池"句柄留给退出流程，好在停熔断器之前先让探针 fast-fail。
   */
  const pluginProbe = createPluginProbe({
    list: () => pluginManager.list(),
    dataDir,
    extraLaunchers: config.mcp.extraLaunchers,
    write,
  });

  /**
   * 同 [append]，但**把分配到的 seq 交给载荷构造器**。
   *
   * 为什么需要它：`channel/message` 的 `msgSeq` 是"这条消息在这个会话里排第几"，信箱的未读
   * 正是按它算的（`channel/sessions.ts`）。而两种平台都可能给不出真序号——没了 @ 的群消息
   * OneBot 填 0、官方全量群消息的事件体里压根没有这个字段。约定（写在 `channel/sessions.ts`
   * 那段）：**给不出就填事件 seq**，它单调、重放稳定，正是这里要的那个数。
   * 而 seq 是"分配即消耗"的（`EventLog.nextSeq`），所以只能在写之前一次性拿到。
   */
  const appendWithSeq = (
    type: string,
    dataOf: (seq: number) => unknown,
    visibility: Visibility,
  ): AppEvent => {
    const seq = log.nextSeq();
    const event = {
      seq,
      ts: now().toISOString(),
      type,
      data: dataOf(seq),
      visibility,
      origin: 'main',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    return event;
  };

  const takeover = lockState.takeover;
  if (takeover !== null) {
    append('instance/takeover', toInstanceTakeoverData(takeover), 'internal');
    write(`[锁] 已接管陈旧锁：前任 pid ${takeover.previousPid ?? '未知'}（${takeover.staleBecause}）`);
  }
  append('session/start', {
    pid: process.pid,
    cwd: process.cwd(),
    version: AGENT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    configHash: loadedConfig.configHash,
  }, 'internal');

  /**
   * ── 出厂技能 → 数据目录（v79，2026-10-23 现场两条病同源）──
   *
   * 技能实体住在**数据目录**（`<dataDir>/skills/<name>/SKILL.md`，与 `persona/` 同级），
   * 安装目录/仓库里的 `skills/` 只是**出厂种子**。这里做那唯一一次复制：
   *
   *   · `<dataDir>/skills` **不存在**才复制（`ensureSkillsSeed` 的全部判据在 `skill/seed.ts`
   *     的文件头：已存在就一个字节都不动、幂等、失败不留半成品）；
   *   · 复制成功写一条 `skill/seed`（internal）——它解释"盘上这几个技能目录是怎么来的"，
   *     也是"复制了几件"的唯一凭据（摘要行会随 stdout 滚掉，事件留得住）；
   *   · 它**不是信任门**：复制过来的技能照样要 `skill/installed{by:'human'}` 才进 catalog；
   *     内容逐字照搬 ⇒ 老日志里那些确认的内容哈希照旧命中，人不必重新点一遍。
   *
   * 为什么放在单实例锁**之后**（`recover()` 已经拿到锁、`session/start` 已经落下）：
   * 并发的第二个进程会在拿锁时就被挡住，于是"两个进程同时往 `<dataDir>/skills` 复制"
   * 这种半成品现场根本不会出现；事件顺序也就自然是"这一任起来了 → 它补了哪些出厂技能"。
   */
  const launchCwd = process.cwd();
  const skillsSeed = ensureSkillsSeed(dataDir, join(launchCwd, SKILLS_DIR_NAME));
  if (skillsSeed.state === 'created') {
    append('skill/seed', {
      source: SKILLS_DIR_NAME,
      dest: SKILLS_DIR_NAME,
      skills: skillsSeed.skills,
      files: skillsSeed.files,
    }, 'internal');
    write(`[技能] 首次运行：已把出厂技能复制到数据目录（${skillsSeed.skills.length} 个：`
      + `${skillsSeed.skills.join('、')}，共 ${skillsSeed.files} 个文件）⇒ ${skillsSeed.dest}`);
    write('[技能] 此后技能住在数据目录：安装器更新（替换安装目录）不再碰它们，界面装/删也落在这里');
  } else if (skillsSeed.state === 'failed') {
    write(`[技能] 出厂技能没有复制成功：${skillsSeed.failure ?? '（没有原因）'}`);
  } else if (skillsSeed.state === 'no-seed') {
    // 老安装包/裁剪发行版里没有出厂种子：不是错误。技能从哪来由兼容根与界面/申请单那几条路决定
    write(`[技能] 没有可复制的出厂种子（${skillsSeed.seedRoot} 不存在或里面没有技能目录）：`
      + `数据目录保持原样（${skillsSeed.dest}）`);
  }

  /**
   * 技能根的**生效计划**（v79）：在"种子已经复制完"之后算一次，摘要与 `SkillManager`
   * 读的是同一份输入（数据目录 + cwd 兼容根）。`SkillManager` 内部按同一函数现算，
   * 所以两处不可能给出两种说法（`planSkillRoots` 是唯一判据）。
   */
  const skillRoots: SkillRootRef[] = planSkillRoots(dataDir, launchCwd);

  /**
   * ── `%TEMP%` 兜底扫（2026-10-21）：**启动时一次**（每日整理那一拍还会再来一次）──
   *
   * 为什么卡在启动这个位置：安装器 stage（`irmia-setup-<pid>`）与引导器失败现场
   * （`irmia-boot-<pid>`）都是**上一个进程**的遗留物，新进程起来时正好没人在用它们。
   * 开关只在这里读一次（`IRMIA_TEMP_SWEEP=off|dry|on`，缺省 `dry` = 只报不删）；
   * 改档要重启才生效——与 `wake.memoryMaintainCron` 同一条口径（都是"启动期决定的后台维护"）。
   *
   * **不拦启动**：扫不动只写一行日志（`runTempSweep` 自己吞掉所有异常并返回 `error`）。
   * 账落两处：`temp/swept` 事件（事后查得到）+ 启动日志（当场看得见）。
   *
   * 判据与动作在 `util/temp-sweep.ts`（`planTempSweep` / `runStartupTempSweep`）：`runMain`
   * 全仓没有测试覆盖，所以"启动到底按哪一档跑、事件落不落"这段被抽成可测函数
   * （`test/temp-sweep.test.ts` 的"启动接线"用例）。这里只留装配。
   */
  const sweepPlan = planTempSweep(process.env);
  await runStartupTempSweep({
    plan: sweepPlan,
    log: write,
    append: (type, data, visibility) => {
      append(type, data, visibility);
    },
  });

  // 后台任务管理器（design §4.21 jobs）：pwsh 的 runInBackground 从这里进出，
  // 共用它一个实例——job/* 与 wake/job 事件只有这一个写入点。
  // v27 删掉了它的别名 run_command：两个名字共用一个执行体，实测只用得上一个。
  //
  // **v41 起把投影也交给它**（2026-10-08 修的真缺陷）：它写的事件原先只落盘、不折投影，
  // 而运行期读 `pending` 的是内存投影——于是 `wake/job` 成了"日志里有、循环永远看不见"的唤醒，
  // **不起 turn**（她得等下一次重启才知道任务早完了）。纪律与 real-loop 的 `appendSync` 同一条。
  const jobManager = new JobManager({
    log,
    dataDir,
    now,
    projection: recovery.projection,
    warn: (message) => { write(`[后台任务] ${message}`); },
  });

  // 重启孤儿结算（§5 崩溃恢复时序的 jobs 分支）：投影里挂着 job/started 而没有
  // job/finished 的任务，其进程已随上一个宿主一起死。不结算，「有一个任务在跑」
  // 这句判断就会一直骗人（投影的 jobs 字段永不自清），且模型会等一个永不到来的唤醒。
  const orphanedJobs = await jobManager.recoverOrphans(recovery.projection);
  if (orphanedJobs.length > 0) {
    write(`[后台任务] 结算 ${orphanedJobs.length} 个随宿主中断的任务：${orphanedJobs.join('、')}`);
  }

  // 告警出口在启动期就建好，并与真循环共用同一个实例：限流窗口只有一份（M3-10），
  // 启动告警与运行期告警才不会各自持一份窗口、互相绕开对方的限流。
  const notifier = createNotifier({
    config: config.alerts,
    dataDir,
    emit: (type, data, visibility) => {
      append(type, data, visibility);
    },
    now,
  });

  /**
   * **先恢复限流窗口，再发启动告警**（P1-20，2026-10-18）。
   *
   * 原顺序的代价（实测现场）：`notifier.restore(日志)` 只发生在真循环的 `warmUp` 里，
   * 而启动告警在**那之前**就发了 ⇒ "同一类告警 30 分钟内只发一次"这条承诺在**告警自己身上**
   * 失效：一个必然崩溃的进程被守护脚本反复拉起，每重启一次就合法地多发一条，而那时窗口还是空的。
   *
   * 代价说清楚：这里要把事件日志顺序读一遍（稍后 `warmUp` 还会再读一遍）。两份都是启动期
   * 一次性成本，换来的是"崩溃循环里人只收到一条"。
   * 读不动日志**不拦启动**（告警是观测，不是启动前置条件），但这时要说清"本次可能重复"——
   * 悄悄退化成原顺序，等于把这条承诺又丢了一次。
   */
  try {
    const restoredAlarms = await restoreStartupAlertWindow(notifier, log);
    if (restoredAlarms > 0) write(`[告警] 已从日志重建限流窗口（${restoredAlarms} 条 alarm/sent）`);
  } catch (err) {
    write(`[告警] 限流窗口重建失败（不拦启动；本次启动告警可能重复）：${describeError(err)}`);
  }

  // 启动异常退出告警（design §4.9 触发点首条）：recover 的补偿清单里出现 interrupted 结算即发一条。
  // 告警失败绝不拦启动——它是观测，不是启动的前置条件。
  try {
    const receipt = await notifyStartupRecoveryDetailed(notifier, {
      repairs: recovery.repairs,
      dataDir,
      pid: process.pid,
    });
    if (receipt.outcome !== null) {
      if (receipt.suppressed) {
        // 窗口内**有意丢弃**：账早已在日志里（第一条 alarm/sent），这一次没有推第二条给人
        write('[告警] 上一次运行异常退出：同类启动告警还在限流窗口内，这次没有再推一条（账在 alarms/，warn 级）');
      } else if (receipt.outcome.ok) {
        write('[告警] 上一次运行异常退出：启动告警已发出（详见 alarms/，warn 级）');
      } else {
        write(`[告警] 上一次运行异常退出，但启动告警未送达：${receipt.outcome.reason}`);
      }
    }
  } catch (err) {
    write(`[告警] 启动告警发送异常（不拦启动）：${describeError(err)}`);
  }

  // ── 唤醒事件落库口与循环（有 API key 真循环，无则假循环降级） ──

  // 密钥补齐（老用户兜底，2026-10-20 用户实测的挫败点）：
  //
  // 现场：首次引导填 key 时只写了 `heavy` 那一格（`gui/lib/onboarding.dart` 的 `_settleApi`
  // 从前硬编码 `{'name': 'heavy'}`），而 `.keys.json` 是**按格**存的：同一个 `apiKeyEnv`
  // （出厂 heavy / light 都是 `IRMIA_API_KEY`）意味着同一个值，可盘上却是两格。于是人明明填过
  // key，设置页的 light 那张卡照样写「未配置」——"填了这边没给那边"的挫败感就在这里。
  //
  // 新版本**写**的时候已经一次落多格（`src/web/server.ts` 的 set-key 扇出），但老用户不会再走
  // 一遍引导，所以启动时补一次。三条分寸：
  //   · 幂等：检查后不写盘、不抖 mtime，重复跑不报错（`backfillSharedKeys` 的判据）；
  //   · 不猜：同名的几格值不同 ⇒ 一个字节都不写，只把冲突喊出来（人自己去设置页定夺）；
  //   · 不拦启动：写不进去照常起（密钥那边还有假循环兜底，缺一把 key 不该让进程起不来）。
  try {
    const refills = await backfillSharedKeys(config.dataDir, modelKeyGroups(config));
    for (const refill of refills) {
      write(refill.conflict
        ? `[模型] 密钥没有补齐：共用同一个环境变量 ${refill.envName} 的 ${refill.slots.join(' / ')}`
          + ` 盘上的值不一样——去设置页确认要留哪一把（本次一个字节都没动）`
        : `[模型] 密钥补齐：${refill.filled.join(' / ')} 也用上了 ${refill.source} 那一格的密钥`
          + `（这几格的 apiKeyEnv 都是 ${refill.envName}）`);
    }
  } catch (err) {
    write(`[模型] 密钥补齐没成（不拦启动）：${describeError(err)}`);
  }

  const startTurn = await maxTurnOfLog(log);
  /**
   * **两把 key，各按自己那一格解析**（2026-10-21，per-lane 端点与密钥）。
   *
   * 从前这里只有一行 `readApiKey(config.models.heavy, …)`，那一把 key 同时喂给 heavy 与 light
   * ——于是 `models.light.apiKeyEnv` 这一格**从来没被读过**（与 `models.light.baseUrl` 同一个病）：
   * 在 light 卡里换一个服务商，请求仍旧带着 heavy 的密钥打 heavy 的端点。
   *
   * 现在两条 lane 各解析各的（`readApiKey` 的取值链不变：环境变量优先 > `data/.keys.json`，
   * 只是**环境变量名逐 lane**）。三种情形：
   *   · 两格都解析到值（含出厂形态"两个 `apiKeyEnv` 同名"）⇒ 各用各的，值通常相同；
   *   · light 没解析到值、且两格**指向同一个端点** ⇒ 沿用 heavy 那一把（同一个端点上
   *     "同一个凭证"就是事实；`DsClient` 的 `lightApiKey: undefined` 表达这一档）；
   *   · light 没解析到值、但两格**指向不同端点** ⇒ 传 `null`：light 的请求会在发送前报
   *     `missing_api_key`，而不是把 heavy 的密钥发给另一个服务商。
   *
   * `apiKey`（heavy 那一把）仍是"真循环 / 假循环"的闸：没有 heavy 的密钥就没有主力模型，
   * 与从前逐字一致（light 有没有 key 不决定这个进程跑不跑）。
   */
  const heavyKey = readApiKey(config.models.heavy, process.env, config.dataDir, 'heavy');
  const lightKey = readApiKey(config.models.light, process.env, config.dataDir, 'light');
  const apiKey = heavyKey;
  /** light 那一格最终递给 `DsClient` 的密钥：见上面那三条（`undefined` = 沿用 heavy） */
  const lightKeyPolicy = lightLaneKeyPolicy(config, lightKey);
  const lightLaneKey: string | null | undefined = lightKeyPolicy === 'own'
    ? lightKey
    : (lightKeyPolicy === 'share-heavy' ? undefined : null);
  let loop: FakeLoop | RealLoop;

  /**
   * 真循环的句柄（惰性）：speak 的回投地址由它现取（M9）。
   * 用闭包而不是快照：注册表要在 RealLoop 之前装配，而回投目标的"值"只能来自运行中的循环。
   */
  const realLoopRef: { current: RealLoop | null } = { current: null };

  /**
   * MCP 池的句柄（惰性，装配在下面"有 key"那一支里）：退出时要**按官方关机序列**收掉它
   * 拉起的子进程（关 stdin → 等待 → SIGTERM → SIGKILL）。少了这一步，那些 server
   * 进程会在框架退出后变成孤儿——它们是别人的进程，不该被留在这台机器上。
   */
  const mcpPoolRef: { pool: McpClientPool | null } = { pool: null };

  /**
   * QQ 官方通道（M9）。装配条件：配置打开 + 两个环境变量非空。
   * 密钥教义：配置文件里只有变量名，值在这里从进程环境读，不落盘、不进日志、不进事件。
   */
  // 阶段播报（`/api/health` 的 `phase`）：接下来这段是通道与协议端（SnowLuma 预热也在这一档）
  startupState.setPhase('channels');
  const qqChannel = createQqChannelIfConfigured(config.channels.qqOfficial, write, config.dataDir);
  /**
   * 内置协议端（可选）：`channels.onebot.managed` 有值就由框架把它拉起来。
   *
   * **启动失败不阻塞框架**：协议端是"她的眼睛"（看群），不是她的一部分——它起不来最多是
   * 暂时看不到群，不该让她整个停摆。连不上时适配器会自己重试，日志里也会说明原因。
   */
  const managedService = await startManagedProtocolIfConfigured(config, write);
  /**
   * OneBot 通道（M9）：连协议端（NapCat / SnowLuma 等）的正向 ws 端口，密钥同一条教义。
   *
   * **v36 起对接点不再只取一次**：`status()` 是异步的了（它要真去探"进程在不在、
   * 在听哪个端口"），而且"它已经在跑、只是本次进程没管它"这条路上，端点也可能已经存在。
   */
  const managedStatus = managedService === null ? null : await managedService.status();
  /**
   * 端点重读口（v37）：协议端的 OneBot 配置**可能晚于本进程物化**（人登录 QQ 之后才写下来），
   * 所以"启动时读到的是 null"不能成为定论——把它交给适配器，由它每次建连前现读一次。
   *
   * 读法只有一条：`readEndpointFromConfig`（协议端自己那份配置里的
   * `networks.wsServers[0]`，**绝不猜端口**）。缓存与失效条件在适配器那边
   * （`OneBotEndpointMemo`：硬下限 10 秒 + 建连失败即失效），所以界面轮询不看盘、
   * 60 秒一次的退避也不会变成 60 秒一次读盘。
   */
  const managedOnebotDir = config.channels.onebot.managed === undefined
    ? null
    : resolveServiceDir(config.channels.onebot.managed.dir, config.dataDir);
  const onebotChannel = createOneBotChannelIfConfigured(
    config.channels.onebot, write, config.dataDir, managedStatus?.endpoint ?? null,
    managedOnebotDir === null ? null : () => readEndpointFromConfig(managedOnebotDir),
  );
  const channels: Map<string, ChannelAdapter> = new Map();
  if (qqChannel !== null) channels.set(qqChannel.name, qqChannel);
  if (onebotChannel !== null) channels.set(onebotChannel.name, onebotChannel);

  /**
   * **「我自己是谁」的到达点**（2026-10-11 修的一处"改了等于没改"）。
   *
   * 这份认知是**运行期长出来的**，而通道是在上面就建好的（那时它还什么都不知道）：
   *   • OneBot：机器人 QQ 号要等 WS 打开或首条事件里的 `self_id`（`dispatch` 里学）；
   *   • 官方：openid 来自 `GET /users/@me` 探针、群里 @ 我的 `mentions[bot]`、或我自己那条
   *     回声的 `author.bot`（见 `qq-official.ts` 的 `rememberSelfOpenid`）。
   *
   * 所以两条通道各有一个 `onSelfId` 回调，收到的每一个都**当场**记进下面那个判据对象——
   * 而判据对象与真循环拿的是**同一个实例**（`RealLoopDeps.selfMessages`），
   * 于是"学到"这件事一次就到位，不需要第二份名单、也不需要重启。
   *
   * 为什么还要 `sources`（现读口）那一层：`onSelfId` 是**推送**，漏一次就是一次静默失效；
   * 现读口是**拉取**——查询那一刻直接问通道"你此刻知道谁"。两条腿都有，快照那条路才真的没了。
   */
  const selfIdListeners: Array<(id: string) => void> = [];
  const onSelfId = (id: string): void => {
    for (const listener of selfIdListeners) listener(id);
  };
  qqChannel?.setSelfIdListener?.(onSelfId);
  onebotChannel?.setSelfIdListener?.(onSelfId);

  /**
   * **「这条是不是我自己发的」——判据只此一处**（2026-10-11 用户裁决的落点）。
   *
   * 现场（`_ops-readchannel\REPORT.md` §2）：她一次 speak 的三条气泡从**平台另一扇门**
   * （同一实体群的 qq-official 那一路）被当作"别人发来的消息"推回来，`person` 是她自己的 openid。
   * 整条入站链路上没有任何一处判这一条，于是它被完整地当成某个群成员说的话：落
   * `channel/message` → 算未读 → **进群成员档案**（`data/group-members.json` 里多出一条
   * `群友C（群昵称：伊尔弥亚2号）`，与真人网友并列）。
   *
   * 为什么判在**宿主的落库口**而不是两个适配器各判一遍：两扇门的"自己"形状不同（OneBot 是 QQ 号、
   * 官方是按群隔离的 openid），各判一遍就是同一条纪律的两个实现，迟早一扇门改了另一扇没改；
   * 而两条通道的消息**都要经过这个落库口**，挡在这里等于一处判据同时盖住两扇门。
   *
   * **命中 ⇒ 三件事一起不做**：不落 `channel/message`、不注册群成员、不计未读
   *（它们本就是这条路上先后发生的三件：落库 → 折叠会话簿 → 注册）。
   *
   * ⚠ **不动"她看得见自己的消息"这条固定设计**：她说过什么走的是**另一条路**——
   * `speak`/`report`/`send_media` 成功投递时补的 `speak/sent` 凭据，`read_channel` 由
   * `readChannelSpoken` 读它、渲染成行首 `（我）`。这里丢掉的是"平台把我说的话推回来"的**副本**，
   * 不是"我说过什么"的凭据（`test/self-message-gate.test.ts` 正面钉着这一行还在）。
   *
   * **两条来源合一份判据**（缺一条就是那次"改了等于没改"）：
   *   • `providers` = 现读口：`qqChannel.selfIds()` / `onebotChannel.selfIds()`——**每次判都现问**，
   *     所以运行期学到的那些**当场**算数（快照式写法在这里恒假，见 `SelfIdentity` 的注释）；
   *   • `selfIdListeners` = 推送口：通道学到新的就回调进来（两条通道的 `onSelfId`）。
   *
   * "我自己是谁"由各通道自己回答；一个都认不出时这一层是**失效**的——那是刻意的降级方向：
   * 宁可让一次回声漏进来，也绝不因为"认不出自己"而丢掉别人的话。
   *
   * 造在这里（真循环之前）的理由：循环要拿**同一个实例**去挡"重折历史事件"那条路
   * （`RealLoopDeps.selfMessages` → `groupMemberCandidateOf`）——递副本的话，
   * 两份认知各走各的，而"档案里那个群友是谁"这种偏差从行为上看不出来。
   */
  const selfIdentity = new SelfIdentity([
    () => qqChannel?.selfIds() ?? [],
    () => onebotChannel?.selfIds() ?? [],
  ]);
  selfIdListeners.push((id) => { selfIdentity.add(id); });
  // 两条通道建好之后可能已经知道一点了（构造时的握手）；listen 回调会把当下那份补推一次
  qqChannel?.setSelfIdListener?.(onSelfId);
  onebotChannel?.setSelfIdListener?.(onSelfId);
  /**
   * 认出/认不出自己都**留一行痕**（不许静默）：这一行只在启动时打一次，而且是**事实**不是承诺——
   * 官方那侧的 `GET /users/@me` 探针与群事件里的 `mentions` 都会随后补进这个集合。
   */
  if (selfIdentity.size > 0) {
    write(`[通道] 已认出「我自己的标识」${selfIdentity.size} 个（平台推回来的自己的消息不再落库、不再注册成员、不计未读）`);
  } else if (qqChannel !== null || onebotChannel !== null) {
    write('[通道] 还不知道「我自己的标识」：平台把自己的消息推回来时可能被当成别人说的'
      + '（OneBot 侧等 get_login_info / 首条事件的 self_id；官方侧等 /users/@me 或群里 @ 我的事件）');
  }

  /**
   * speak 的回投出口（M9）：多通道并存时按回投 URL 的 scheme 分派（qq: / onebot:）。
   * 只装配了其中一个通道时，另一个 scheme 的地址如实报"未装配"，而不是静默当成发送失败。
   */
  const qqReplyPoster = qqChannel === null ? null : createChannelReplyPoster(channels);
  const onebotReplyPoster = onebotChannel === null ? null : createOneBotReplyPoster(channels);
  const replyPoster: ReplyPoster | null = qqReplyPoster === null && onebotReplyPoster === null
    ? null
    : {
        async post(target, text) {
          if (target.url.startsWith(ONEBOT_REPLY_SCHEME)) {
            if (onebotReplyPoster === null) return { ok: false, reason: 'OneBot 通道未装配，回投跳过' };
            return await onebotReplyPoster.post(target, text);
          }
          if (qqReplyPoster === null) return { ok: false, reason: 'QQ 通道未装配，回投跳过' };
          return await qqReplyPoster.post(target, text);
        },
      };
  /**
   * **"正在输入"的投递口**（2026-10-11，用户：「只做正在输入。speak 时触发」）。
   *
   * 装配判据只有两条，且都在这里：
   *   • `config.speak.inputNotify` 为真（**出厂开**）——关掉时**根本不装它**，于是
   *     `speak` 一个请求都不发。判据落在接线层（而不是在 `speak` 里再 if 一次），
   *     所以工具层永远不知道有这么一个开关；
   *   • 有通道（`channels.size === 0` 时没什么可发的；装上也只是每轮白跑一次查表）。
   *
   * **不在这里按通道名分支**：哪条通道会发、哪个会话类型能发，全由
   * `channel/input-notify.ts` 按**能力**（有没有 `sendInputNotify`）与通道自己的实现判。
   * OneBot 没有这条能力 ⇒ 它上面表现为"优雅跳过"。
   */
  const inputNotifyPoster: InputNotifyPoster | null =
    config.speak.inputNotify && channels.size > 0 ? createInputNotifyPoster(channels) : null;
  /**
   * 媒体投递口（`send_media`）：本机文件只允许**两个允许根**里的路径——`dataDir` 与
   * **工作根**（与 fs 工具族、`http_download` 同源），读成字节交给通道层；
   * 网络图直接透传，让平台自己去回源。
   *
   * 两个根各有各的来路：她既有的写法（`workspace/tmp/…`）相对 `dataDir`，
   * 而 `http_download` 落在工作根下。少了第二个根，**下载下来的图就发不出去**
   * （实测 t285 连撞两次）。顺序与判定见 `channel/media-poster.ts` 的文件头。
   *
   * **装配条件只看"有没有通道"，不看是哪条通道**（2026-10-07 修）：原先写的是
   * `qqChannel === null ? null : …`，于是 OneBot-only 的机器上这件工具直接报"没有接线"，
   * 而她的工具清单是恒定的——那等于"某条通道下这件能力不存在"。现在 **OneBot 也实现了
   * 媒体接口**（`OneBotChannel.sendMediaTo`：图片/视频/语音走消息段、文件走 `upload_*_file`），
   * 分派按回投地址的 scheme 走（`channel/media-poster.ts` 的 `createMediaDispatcher`，
   * 与 speak 那条路共用 `admin.parseReplyUrlAny` 一份判据）。
   * 而"这条通道到底发不发得了"仍由通道自己说了算：没有 `sendMediaTo` 就如实说清是哪条通道、
   * 为什么不支持——**能力由通道声明，工具清单恒定不变**。
   */
  // 胶水抽到 `channel/media-poster.ts` 了（原来写在这里，一次都没被测过）：
  // 白名单、大小、字节读取那三条规则现在有主，见 `test/media-poster.test.ts`。
  //
  // `workspaceRoot` 传 `process.cwd()`：这是 fs 工具族真正的根（`agent-loop.ts` 里
  // `deps.workspaceRoot ?? process.cwd()`，而 real-loop 不传它）。**不要**用下面
  // `launch()` 里那个 `join(dataDir, 'workspace')`——那是磁盘事实快照的根，不是工具的根。
  //
  // 受保护路径（**一份名单、两处消费**）：定义了「谁能改我」的钩子配置 + 本机凭据。
  //   · fs 写入口（catalog 的 `protectedPaths`）拒绝改写它们；
  //   · `send_media` 的外发门（媒体投递口的 `protectedPaths`）拒绝把它们发给通道。
  // 为什么必须共用一份：这两件事挡的是同一批文件——凭据既不该被她改掉，也不该被她交出去
  // （用户 2026-10-05 点名：她能读 `.keys.json` 不是问题，"发到第三方通道"才是）。名单里
  // 每一项都指得出它的定义处，不再手写同义字面量。
  const protectedPaths: readonly string[] = [
    ...protectedHookPaths(dataDir),
    ...pluginProtectedPaths(dataDir),
    keysPath(dataDir),                                    // data/.keys.json：模型与通道密钥
    join(dataDir, AUTH_FILE_NAME),                        // data/.auth.json：界面密码与会话凭据
    join(dataDir, WEBHOOK_SECRET_FILE_NAME),              // data/.webhook-secret.json：webhook 专用凭据
    join(dataDir, UI_TOKEN_FILE),                         // data/.ui-token：遗留共享 token（只读兼容）
  ];
  const mediaPoster: MediaPoster | null = channels.size === 0
    ? null
    : createWorkspaceMediaPoster({
      dataDir,
      workspaceRoot: process.cwd(),
      channels,
      protectedPaths,
    });
  let toolRegistry: ToolRegistry | undefined;
  // destructive 工具的开关（三态）归一到布尔：true 或非空名单都表示「开着」——
  // 名单模式的逐件过滤由注册表的 includeDestructive 负责，装配层只需知道要不要把它们造出来。
  const destructiveTools = config.tools.destructiveEnabled === true
    || (Array.isArray(config.tools.destructiveEnabled) && config.tools.destructiveEnabled.length > 0);

  // 活动边界（trust.mode）如实报一句：这是一条**边界**，"它现在管到哪儿"必须是启动日志里
  // 看得见的事实（设置页显示的是同一份 config，判据也只有一处——config.ts 的 trustBoundaryRoot，
  // 执行器读的正是它）。真假循环两条路都该看见这句，所以放在分岔之前。
  const boundaryRoot = trustBoundaryRoot(config.trust);
  write(`[信任] 活动边界：${boundaryRoot === null
    ? '完全信任（整台电脑：文件读写与命令都不设边界）'
    : `只限 ${boundaryRoot}（越界的文件读写与命令一律拒绝）`}`);

  /**
   * 外部依赖管理器（v30）：pwsh 7 / ripgrep / es.exe 的探测、安装与复检都归它。
   *
   * **构造它不发任何进程**（探测是惰性的），所以放在真假循环分岔之前：
   * 假循环那台机器也该在设置页看见"缺哪件、怎么装"。
   * 这里的 `write` 会把三条"未就绪"如实打进启动日志——工具不出现不能无声无息。
   *
   * 报告与安装走的那份结论和工具用的是**同一个对象**，所以点完安装的复检
   * 能让下一次工具调用立刻看到新装的引擎（不必重启进程）。
   */
  const deps = createDepsManager({
    dataDir,
    configPaths: config.deps.paths,
    onNote: write,
  });
  void deps.getAll().then(async (all) => {
    const report = await deps.report(now);
    for (const line of summarizeNotReady(report)) write(line);
    const ready = report.entries.filter((entry) => entry.ok).map((entry) => `${entry.name} ${entry.version}`);
    write(`[依赖] 就绪 ${ready.length}/${report.entries.length}${ready.length === 0 ? '' : `：${ready.join('、')}`}`
      + `（自装目录 ${report.toolsDir}；报告见 GET /api/deps 与设置页「外部依赖」）`);
    // 单独记一笔 pwsh：它是工具的默认 shell，回退到 5.1 这件事值得在启动日志里显眼。
    // 只在 Windows 上说：非 Windows 上根本没有 powershell.exe 5.1 这个回退项（那时工具会直接报不可用）
    if (all.pwsh.status !== 'ready' && process.platform === 'win32') {
      write('[依赖] pwsh 工具将回退到 Windows PowerShell 5.1（每次回执里会标明本次用的是哪个 shell）');
    }
  }).catch((err: unknown) => {
    // 探测失败不该拦住启动：工具会各自给出"运行时不可用"的如实错误
    write(`[依赖] 探测失败：${err instanceof Error ? err.message : String(err)}`);
  });

  /**
   * MCP 客户端池（2026-10-09，**第一次真的接上**）。
   *
   * 在这之前 `McpClientPool` 在整个 `src/` 里**没有任何构造点**（只有测试里 new 过）
   * ——配置里那份 `mcp.servers[]` 谁也没读过、谁也没起过。这一版把它接进主流程。
   *
   * **刻意不给它 `registry`**（池的选项里有这一格，这里不传）：用户拍定的口径是
   * "只有一件内置入口工具 `mcp`，此后 MCP 都从它调用"。池一旦拿到注册表，
   * `syncServerTools` 就会把 `mcp__{server}__{tool}` 写进模型清单——
   * 那正好是这一版要避开的那件事（工具清单一变 = 一次全 miss ≈9.6 万 token）。
   * 披露式的全部价值就在这一句上：**MCP 的工具不进 `tools` 段，只在她调用时进工具结果。**
   *
   * **不 `registerAll()`**：那是"启动期把每个 server 都拉起来"的枚举口径；池自己的纪律是
   * **随用随起**（`ensureReady` 在 `callTool` / `listTools` 路径上按需拉起，空闲 5 分钟回收）。
   * 启动期不起任何外部进程，也不因为某个 server 起不来而拦住启动。
   *
   * 没有声明任何 server 时**照旧建池**：`mcp` 入口工具要无条件常驻（清单一变就是一次全 miss），
   * 它调用时如实回一句"没有已声明的 server"——而不是"这件工具不存在"。
   *
   * **建在分支之前**（真假循环都看得见它）：没有 key 的机器上「扩展 → 工具」那一页
   * 照样要看得见 `mcp` 这件工具（与 `memory_read` / `pwsh` 同一条理由）。假循环那个池
   * 永远不会被调用（不跑模型就不派发工具），所以它也不会拉起任何外部进程。
   */
  // 阶段播报（`/api/health` 的 `phase`）：接下来是 MCP 池与工具注册表的装配
  startupState.setPhase('mcp');
  const mcpPool = new McpClientPool({
    servers: mcpDeclarations(),
    // 生命周期事件落 mcp/server-started / mcp/server-stopped（internal）：
    // 界面「扩展 → MCP」的运行期状态就是从这两条折出来的（mcpView）
    //
    // 可见性走**同一处判据**（不是手写的字面量）：这几条今天在表里都是 internal，所以这里
    // 显式写 `internal` 是对的；而哪天有人把其中一条改成 `model`，这一处会**当场抛**，
    // 逼他回来回答"这条到底进不进上下文"——而不是让它静默留在 internal（那正是
    // `vision_read` / `speak` 那两个洞的形状，见 resolveEventVisibility 的注释）。
    emit: (type, data) => { append(type, data, resolveEventVisibility(type, 'internal')); },
    dataDir,
    now: () => now().getTime(),
    onLog: (line) => { write(`[MCP] ${line}`); },
    // 两格池级参数（2026-10-10 接线，出厂值在 config.ts 的 mcp 段）：
    //   · maxInFlight = **整池**在飞上限（超限如实拒绝、不排队；极多 server + 子代理并发时往上调，
    //     逐 server 那一格管的是"别把同一个 server 打爆"，这一格管"别同时拉起 N 个别人的进程"）；
    //   · rssSample = 是否采那个进程的 RSS（关掉后 /api/mcp 那几格如实留空；环境变量
    //     IRMIA_MCP_RSS_SAMPLE 比它优先，见 client.ts 的 resolveRssSampler）。
    maxInFlight: config.mcp.maxInFlight,
    rssSample: config.mcp.rssSample,
    onSystemicFailure: (signal) => {
      const failure = mcpPluginFailure(signal.serverName, signal.category, signal.message);
      if (failure !== null) circuitBreaker?.noteFailure(failure);
    },
    onRequestSuccess: (serverName) => {
      const failure = mcpPluginFailure(serverName, 'timeout', '');
      if (failure !== null) circuitBreaker?.noteSuccess(failure);
    },
  });
  mcpPoolRef.pool = mcpPool;
  circuitBreaker = new PluginCircuitBreaker({ manager: pluginManager, now: () => now().getTime(), apply: applyPluginRuntime, probe: pluginProbe.probe });
  if (config.mcp.servers.length === 0) {
    write('[MCP] config.json 里没有声明任何 server（mcp.servers[] 为空）：'
      + '`mcp` 工具照常在她手里，调用时会如实说"没有已声明的 server"');
  } else {
    const names = config.mcp.servers.map((entry) => `${entry.name}${entry.disabled === true ? '（已停用）' : ''}`);
    write(`[MCP] 已声明 ${config.mcp.servers.length} 个 server：${names.join('、')}`
      + '（随用随起：第一次调用才拉起它，空闲 5 分钟回收；它们的工具不进她的工具清单，走 `mcp` 工具调）');
  }

  /**
   * ──────────────────── 配置热重载（2026-10-10，MCP 声明面）────────────────────
   *
   * **为什么走 `ConfigWatcher` 而不是自己再写一个轮询**（用户问的那件事的答案）：
   * `config/watcher.ts` 里那套东西是**为这件事写好的、一直没人接**（`HOT_RELOAD_FIELDS`
   * 曾经因此被清空，理由逐字写在那一行上面）。它已经有四条必需的性质，一条都不该在第二份实现里
   * 重新想一遍：
   *   · **检测是两路合并**：`FileWatcher` 监听**父目录**（Windows 上"临时文件 → rename 覆盖"
   *     这种原子写换掉了 inode，只监听文件本身会漏事件；本仓库的配置写回正是原子写）
   *     ＋ 250ms 的 mtime/size/ino 签名轮询兜底；两路都汇进同一个 600ms 去抖窗口；
   *   · **重载是串行的**（互斥锁链 + 两次重载间隔 ≥1s + 单次 20s 超时）：保存风暴不会把重载
   *     叠成并发 IO，慢盘也不会把重载任务永远挂住；
   *   · **白名单过滤只有一处实现**（`classifyConfigField`）：名单外的字段只写 warning、
   *     不写 `config/changed`（那个事件的语义是"已生效"）；
   *   · **失败保留旧配置**（文件头那段教义）：解析失败 ⇒ 继续按上一份好配置跑，只留一行诊断。
   *     这一条正是用户要的"失败回退安全"的落点，而且它**天然覆盖**放行口缺失那一类：
   *     `mcp.servers[].command` 的启动器校验在 `loadConfig` 里（`readMcpConfig` → `parseMcpServers`
   *     → `checkStdioLauncher`），坏配置根本进不到下面这个订阅者里来。
   *
   * **生效粒度**：`configHash`/白名单那一层是"整字段"的（`mcp.servers` 是一个字段），
   * 而真正决定"要不要重连某个 server"的是池的 `applyDeclarations`——它按
   * `mcpEntryContentKey` 逐个比，**只重连真变了的**（见那个方法的注释：不打断别人的在飞调用、
   * 不清别人的运维账）。所以"整字段替换"不会变成"整池重来"。
   *
   * **索引那一格刻意不动**：`mcp.servers` 进上下文的形态是**常驻索引**，而索引按既有快照机制
   * **在重大变化点归集**（`compaction/summary` 之后 / 模板换代 / 首次）。这里要做的偏偏是它的反面
   * ——**只追加一条尾部通报**（`wake/manual{via:'mcp'}`：加了/删了/改了哪些、现在一共几个），
   * 索引那几个字节**一个都不改**（改了就是每轮请求前缀失配 = 缓存整段失效）。判据与代价写在
   * `config/watcher.ts` 的 `HOT_RELOAD_FIELDS` ①与 `real-loop.mcpIndexSync` 的方法头。
   *
   * ──────────────────── 交接说明（2026-10-11 **已收尾**，留着是为了记住判据在哪） ────────────────────
   *
   * 接完热更这条线之后，"要重启才生效"那句话曾有三处互相不一致，现在三处按**同一份判据**收齐了：
   *   · `src/web/server.ts` 的 `mcp-save` / `mcp-remove` 回执那一格 `restartRequired`
   *     ——按**净效果**给，判据只有一处：`WebServerImpl.mcpRestartOutcome()` 的方法头
   *     （那一节也是"将来加了不走热更的字段要登记的地方"）；
   *   · 界面那一侧读它、不再写死（`gui/lib/pages/extensions_page.dart` 的 `_mcpWriteOutcome`：
   *     `restartNote` 原样接在 toast 后面）；
   *   · `test/extensions-commands.test.ts` 与 `test/mcp-decl-wake.test.ts` 钉的是新口径的三面
   *     （有改动·接住了 ⇒ false；有改动·没人接住 ⇒ true；净效果为零 ⇒ false；
   *     顺带写下的 `tools.disabled` 接不住 ⇒ true）。
   */
  const configWatcher = new ConfigWatcher({
    configDir: startup.configDir,
    initial: loadedConfig,
    /**
     * 重载也把数据目录钉回启动时那一个（判据见 `pinDataDir`）。
     *
     * 不钉的后果是**每次热更都附带一句假警报**：盘上那份配置的 `dataDir` 与生效值不同
     * （`--data-dir`/环境变量覆盖，或配置里就是默认值）时，`diffConfigFields` 会稳定地
     * diff 出 `dataDir`，而它是**重启级**字段 ⇒ 每改一格 `mcp.servers` 都会多一行
     * "以下字段需要重启才生效：dataDir"。真话要说在该说的时候（这里的数据目录是启动时定的，
     * 运行期不会被这行配置改掉），不该变成每次保存的噪音。
     */
    load: async (dir) => pinDataDir(await loadConfig(dir), dataDir),
    // `config/changed`（internal）：与 web 侧写的那条同名同形（fields + configHash）。
    // 这里**不写** `requiresRestart`——那一条只描述"盘上改了、进程没改"的那种写盘命令；
    // 热更这条路是真的生效了，而没生效的那些字段在 `warnings` 与下面的日志里逐条点名。
    emit: (type: string, data: unknown, visibility: Visibility) => { append(type, data, visibility); },
    out: write,
  });
  configWatcher.subscribe((change) => {
    // ── ① 循环那一侧：如实说清"索引字节不动"（它读的是同一份就地改过的 AppConfig）──
    if (loop instanceof RealLoop) loop.notifyConfigReloaded(change);
    if (!change.fields.includes('mcp.servers')) return;
    // ── ② 池那一侧：按 server 粒度重连；完了发尾部通报 ──
    // **刻意不 await**：订阅者回调是同步接口，而重连要等关机序列（关 stdin → 等 → SIGTERM）。
    // 配置已经生效了（就地改完才通知的），这里只是"把派生状态跟上"，它慢不该拖住重载；
    // 失败也不吞：catch 里如实写一行。
    void (async () => {
      try {
        const declChange = await applyRuntimeDeclarations(async (currentDeclarations) => await mcpPool.applyDeclarations(currentDeclarations()));
        const declarations = mcpDeclarations();
        const touched = declChange.added.length + declChange.removed.length + declChange.changed.length;
        if (touched === 0) {
          // 走到这里只有一种情形：`mcp.servers` 这个字段变了、但**每个 server 的内容都没变**
          // （例如只调了数组里的次序）。按 web 侧同一把尺子"没改动就不叫她"。
          write('[MCP] 声明面变了但每个 server 的内容都一样（多半只调了次序）：不重连、不通报');
          return;
        }
        const note = mcpReloadNoteOf(declChange, declarations.length);
        const event = append('wake/manual', {
          note,
          // 与 web 侧 `wakeForMcpChange` 同一格：界面据此把它渲染成**框架卡片**而不是"用户说的话"
          via: 'mcp',
          // 幂等键（与 web 侧 `wakeForMcpChange` 同一格，但**不加时间片**）：取**改动的身份**
          // （动了哪些 server），不取正文——正文里带着"现在一共几个"，拿它当键的话同一串编辑的
          // 后几笔会各叫一次。web 侧要时间片是因为界面上的"保存"可以被连点（同一组改动重复提交）；
          // 这条路只在**文件真的变了**时走（`ConfigWatcher` 的 diff 会滤掉"没变"的保存），
          // 所以同一个身份就是同一件事，一个身份只该叫一次——而两次各改一个不同 server 是两个身份，
          // 各自都会到（那是两件事，不是同一组改动的重复提交）。
          // 前缀 `cfg-mcp` 与 web 侧的 `ui-mcp` 不同：两条路的来源不同，幂等键不该串味。
          dedupeKey: contentKey('cfg-mcp', mcpReloadIdentityKeyOf(declChange)),
        }, 'model');
        // 先落库再折进投影（工具侧那条 emit 的同一条纪律）：本轮的挂起判定与前端投影
        // 要当场看见这条唤醒，而不是等下一拍有人替我折。
        applyOne(recovery.projection, event);
        finalizePressure(recovery.projection, event.ts);
        write(`[MCP] 声明面热更已生效（${describeMcpDeclChange(declChange)}）⇒ 通报 seq ${event.seq}`
          + `（wake/manual · via=mcp）：常驻索引的字节不变，它在下一次重大变化或重启时归集`);
      } catch (err) {
        write(`[MCP] 声明面热更已生效，但池重建那一半失败了：${describeError(err)}`
          + '（配置已是新的，下一次调用会按新声明走）');
      }
    })();
  });
  configWatcher.start();

  if (apiKey !== null) {
    const ds = new DsClient({
      // heavy：`models.heavy`（端点 + 密钥）；light：`models.light` 自己的端点与（可能的）密钥。
      // 两格都**在启动这一拍取定**（`models.` 是 restart 级，见 `config/watcher.ts` 的
      // `RESTART_REQUIRED_FIELDS`）——所以"界面显示新值、请求还打旧端点"这件事只有当进程
      // 没真重启时才会出现，而那时的读数见下面那行启动日志与设置页的「现在跑的是」。
      baseUrl: config.models.heavy.baseUrl,
      apiKey,
      /**
       * light 的端点 / 密钥（2026-10-21 接上：从前这两格**从来没被运行时读过**）。
       *
       * `lightBaseUrl` 恒传（它一定有值，缺省就是 heavy 的）；
       * `lightLaneKey` 三档见 `lightLaneKeyPolicy`：`own` = 那一格解析出来的值，
       * `undefined` = 与 heavy 同端点、沿用同一把，`null` = 不同端点且没配 ⇒ 发送前报
       * `missing_api_key`（不借 key，不静默改道）。
       */
      lightBaseUrl: config.models.light.baseUrl,
      ...(lightLaneKey === undefined ? {} : { lightApiKey: lightLaneKey }),
      heavyModel: config.models.heavy.model,
      lightModel: config.models.light.model,
      /**
       * **三档协议**（`models.<lane>.protocol`，协议回退 C-3，2026-10-21 加）。
       *
       * 逐 lane 递进去（配置本来就是逐 lane 的）：`'auto'`（出厂值）= 今天的路（先按 Responses、
       * 探测到不支持才切 Chat）；`'responses'` = 强制 Responses、永不切；`'chat-completions'` =
       * 强制走 Chat、不先试 Responses。优先级与判据的唯一实现是 `DsClient.protocolFor`。
       *
       * 启动期读一次（`models.*` 是 restart 级，见 `config/watcher.ts` 的 `RESTART_REQUIRED_FIELDS`）；
       * 环境变量 `IRMIA_DISABLE_CHAT_FALLBACK=1` 仍**压过**这两格（R3 的救急闸）。
       */
      heavyProtocol: config.models.heavy.protocol ?? 'auto',
      lightProtocol: config.models.light.protocol ?? 'auto',
      /**
       * ───────────── 单次请求的三格时限（2026-10-16 加）─────────────
       *
       * **这一行原来没有**（`timeoutMs` 不传 ⇒ 落到 `ds-client.ts` 那个硬编码的
       * `DEFAULT_TIMEOUT_MS = 180_000`），而那个 180s 是**总时限**：计时器在 `send()` 之前
       * 就起跳、连收流一起算。于是一次正常的长思考会在写到一半时被我们自己的定时器掐断
       * （实测被掐那一刻已累积 10 万字符推理、断在半句话上），而 `timeout` 又在可重试类别里
       * ⇒ 掐断 → step 失败 → 输入退回队列 → 下一轮从第一步重跑同一个请求 → 再撞同一堵墙。
       * 用户的原话是「**不要硬性掐断**，因为现代的大模型**超长思考很正常**。**思考 40 分钟都有可能**」。
       *
       * 三格的分工（取值与依据逐条写在 `config.ts` 的 `RequestTimeoutConfig`）：
       *   · `silenceMs` —— 流式判**静默**（多久没收到任何数据），长思考期间一直在吐分片 ⇒ 撞不到；
       *   · `hardCapMs` —— 静默之外那道很宽的兜底，抓"一直在吐字但永不结束"（3 小时）；
       *   · `timeoutMs` —— 非流式（light 的一问一答）仍是总时限，那里没有增量可救。
       *
       * 三个数都来自配置（`models.requestTimeout`，出厂 120s / 3h / 180s）；
       * 它们**不在热更白名单里** ⇒ 改完要重启进程才生效（与 budget.* / wake.* 同一口径）。
       */
      silenceMs: config.models.requestTimeout.requestSilenceMs,
      hardCapMs: config.models.requestTimeout.requestHardCapMs,
      timeoutMs: config.models.requestTimeout.nonStreamTimeoutMs,
      /**
       * **一键关掉协议回退**（用户 R3 的救急闸，2026-10-21）。
       *
       * 为什么是环境变量而不是配置项：它是"配置写坏了 / 界面登不上"时用的**最后一根绳子**——
       * 一个环境变量 + 重启就回到今天，不必打开任何界面，也不会被配置校验挡住。
       * 与上面三格时限同一条口径：**启动期读一次**（`DsClient` 自己不读 `process.env`，
       * 否则测试不可控；判据见 `test/protocol-fallback.test.ts` 的第①条）。
       */
      disableChatFallback: process.env['IRMIA_DISABLE_CHAT_FALLBACK'] === '1',
      /**
       * `Retry-After` 被**封顶**时留一行日志（2026-10-18，review P1-08）。
       *
       * 为什么非写不可：封顶是"我们改了服务端的建议"，而这件事在别处一点痕迹都没有——
       * 读日志的人只会看到"退避了 60s"，看不出对端要的其实是 1h，然后会去查错的墙
       * （以为自己的指数曲线在退避）。原值与实际上限都由 `RetryInfo` 带过来，判据在
       * `ds-client.ts`（`retryAfterCappedFromMs` 出现 ⇔ 真的截断了），这里只负责印出来。
       */
      onRetry: (info) => {
        if (info.retryAfterCappedFromMs !== undefined) {
          write(`[模型] 服务端要求等待 ${info.retryAfterCappedFromMs}ms（Retry-After），`
            + `超过上限，已截断为 ${info.delayMs}ms（${info.kind}，第 ${info.attempt} 次失败后）`);
        }
      },
    });
    /**
     * 工具侧的事件写入点。
     *
     * **可见性走 `resolveEventVisibility` 那一处判据**（省略 ⇒ 由 schema 表判；表说 `model`
     * 的事件省略就当场抛）。原先是 `visibility: Visibility = 'internal'` 这个**恒为 internal**
     * 的默认参数——它让"省略可见性"在两侧含义相反：表说 model、落库成 internal、渲染层不看它，
     * 而回执照旧说"已放进你的上下文"（2026-10-11 修的 `vision_read` inline 与 `speak` 两处）。
     */
    const emit = (type: string, data: unknown, visibility?: Visibility): void => {
      const event = append(type, data, resolveEventVisibility(type, visibility));
      // 工具写的事件必须**立刻**折进投影：plan 模式落下 human/asked 之后，本轮的挂起判定、
      // 前端投影与 real-loop 的挂起记账都要当场看见它（与 real-loop.appendSync 同一条纪律：
      // 先落库再改内存——而不是"等下一拍有人替我折"）。
      applyOne(recovery.projection, event);
      finalizePressure(recovery.projection, event.ts);
    };

    /**
     * **协议切换的留痕**（协议回退 C-3）：`subscribeProtocol` → 一条 `model/protocol` + 一行日志。
     *
     * 为什么在这里接：`DsClient` 是**进程级单例**且它不写事件（那是宿主的活，与
     * `onRetry`/`subscribeRetry` 同一条纪律——传输层不认识日志）。
     *
     * 「恰好 1 条」由 registry 保证：状态机没有回切边，同一端点同一进程只落一次结论
     * （判据见 `test/protocol-fallback.test.ts` 的 ②③；开关关闭时 registry 直接返回、
     * 连判据都不算 ⇒ **0 条**）。
     */
    ds.subscribeProtocol((decision) => {
      // 这一行是给运维的人看的：她怎么突然不一样了 / 凭什么 / 怎么回去 —— 一句话三件事
      write(`[模型] ${decision.from} 不可用（${decision.criterion}）⇒ lane ${decision.lane} 已切到 `
        + `${decision.to}（首次发现 ${decision.firstSeenAt}）。本进程不再回探；`
        + '要强制回 Responses：设 IRMIA_DISABLE_CHAT_FALLBACK=1 或改配置 models.<lane>.protocol，然后重启');
      // 事件落库本体在模块级 `appendProtocolSwitch`（抽出去的唯一理由是**可测**，见它的注释）。
      // 它写 `sync:true` + `origin:'main'`：这条账很少，但必须在"两个协议都不通、这一拍连
      // `budget/consumed` 都没有"时也留得下来。
      appendProtocolSwitch({ log: recovery.log, now }, decision);
    });

    /**
     * 定时器表的变动出口（`timer/set` / `timer/cancelled`）——**这一格原先空着**。
     *
     * `TimerStore` 只把表写进 `data/timers.json`，一个事件都不写；而真相源是日志
     * （那个模块自己的文件头就写着这句）。后果是 `state/fold.ts` 的 `case 'timer/set'`
     * 从未被执行过 ⇒ `projection.timers` 恒为 `[]` ⇒ 首页「定时器」卡片永远空态、
     * `web/server.ts` 的 `timer-cancel` 永远 `notFound`（撤销按钮永远失败），
     * 而盘上明明躺着活着的定时器、`timer/fired` 也照常落。
     *
     * 为什么接线点是这里而不是各调用点：改这张表的有**四条路**（`timer` 工具的
     * set/cancel/wait、real-loop 的每日整理布防、web 侧的 `timer-cancel`），
     * 逐处补写必然漂移——判据收在 `TimerStore` 那一处（`emitSet`/`emitCancelled`），
     * 这里只给它一个出口。
     *
     * 复用与工具同一个 `emit`（先落库、再 `applyOne` 折投影）：布防/撤销的回执发出去时，
     * 日志与投影**都**已经认了这件事——界面下一次轮询就看得见，不必等下一拍、更不必重启。
     * 可见性交给 `resolveEventVisibility` 那一处判据（`timer/*` 不在表里 ⇒ `internal`：
     * 它是簿记，不是给她的输入；唤醒她的是紧随其后的 `wake/timer`）。
     */
    timers.setEventSink({
      set: (entry) => { emit('timer/set', entry, 'internal'); },
      cancelled: (timerId) => { emit('timer/cancelled', { timerId }, 'internal'); },
    });
    const workspaceRoot = join(dataDir, 'workspace');
    mkdirSync(workspaceRoot, { recursive: true });

    /**
     * vision 的用量账出口（2026-10-11 加）。
     *
     * **为什么要有这一格**：`vision_read` 真发出去的每一次模型请求原先都不记账——
     * 适配器（下面那个 `visionClient`）无类型透传，`tools/vision.ts` 转手把 `DsResponse`
     * 压成字符串，`usage` 在第一跳就断了；而工具层**没有**写事件的能力（`ToolContext` 里
     * 没有 `log` / `nextSeq()`），所以这条账只能由宿主写。实测 64 次真实请求零记账。
     *
     * **只在真发出去一次模型请求时记一条**（工具层负责那条判据，见 `VisionToolsOptions.onUsage`）：
     * `inline:true`（不调模型）与 `vision_query` / `vision_read` 命中缓存（纯缓存读）**一条都不记**。
     *
     * 字段与 `channel/topic.ts` 的 `account()` 逐字段同形（既有的 light 记账写法），
     * 差别只有 `origin`（区分是谁花的）与 `turn`/`step`（工具层从 `ctx.turn`/`ctx.step` 交出来，
     * 与 `memoryReadRecorder` 同一条路：这里不需要"当前是哪一轮"这种跨层状态）。
     *
     * **落库本体在模块级 {@link appendVisionConsumption}**（2026-10-21 抽出去）：抽出唯一理由是
     * 可测——`protocol` 那一格（协议回退 C-3）要能直接驱动断言，而 `runMain` 要抢单实例锁。
     * 这里只把当前的 log / 投影 / 时钟递进去，一个字节的行为都不改。
     *
     * ⚠ **不递 `BUDGET_ACCOUNTING_VERSION`**（判据见 `log/types.ts` 该字段的注释）：
     * 它描述的是预算累计量的**口径**（`(input−cacheHit)+output`），加一个事件**生产点**不改
     * 这个算式（`fold.ts` 的 `budgetTokensOf` 只看三格、不看 origin）。代价是运行中的那份投影
     * 不会被丢弃 ⇒ **历史那 64 次永远不进基数**，预算读数在生效处会有一个台阶；
     * 递版本也变不出历史数据（它们本来就没被记过），代价却是一次全量重放。
     */
    const recordVisionUsage = (response: DsResponse, turn: number, step: number): void => {
      appendVisionConsumption({ log, projection: recovery.projection, now }, response, turn, step);
    };

    // 执行点钩子（design §4.19）：配置在 data/hooks.json，对 agent 只读——
    // 它定义的是「谁能改我」，所以写入口按 protectedHookPaths 拒绝（见 catalog 的 protectedPaths）。
    // 单条非法只跳过它自己并报出来：一条写错的钩子不该拦住整个进程启动。
    const hookConfig = loadHookConfig(hookConfigPath(dataDir));
    for (const problem of hookConfig.problems) write(`[Hook] 配置条目被跳过：${problem}`);
    // enabled: false 的条目保留在文件里但不装配：GUI 的开关就是"临时停用一条钩子"，
    // 与"删掉这条钩子"是两件事（前者把命令行留着，后者要重新拼一遍）。
    const builtinHookEntries = hookConfig.entries.filter((entry) => entry.enabled !== false);
    const hookDisabled = hookConfig.entries.length - builtinHookEntries.length;
    const hooks = new HookRunner({
      entries: [...builtinHookEntries, ...pluginRuntime.hookEntries],
      emit: (fired) => {
        emit('hook/fired', { hook: fired.hook, outcome: fired.outcome,
          ...(fired.pluginId === undefined ? {} : { pluginId: fired.pluginId, contentHash: fired.contentHash, contributionName: fired.contributionName }) });
        if (fired.pluginId === undefined || fired.contentHash === undefined || fired.contributionName === undefined) return;
        const failure: PluginFailure = { pluginId: fired.pluginId, contentHash: fired.contentHash, contributionKind: 'hook',
          contributionName: fired.contributionName, category: fired.outcome === 'timeout' ? 'hook-timeout' : 'hook-error', message: `Hook ${fired.outcome}` };
        if (fired.outcome === 'ok') circuitBreaker?.noteSuccess(failure);
        else circuitBreaker?.noteFailure(failure);
      },
      onNote: (text) => { write(`[Hook] ${text}`); },
      // 投影摘要是活数据：每次 fork 前现取，不缓存（钩子看到的必须当时那一刻的事实）
      digest: () => digestProjection(recovery.projection),
    });
    replacePluginHooks = (entries) => { hooks.setEntries([...builtinHookEntries, ...entries]); };
    if (hooks.size > 0) {
      write(`[Hook] ${hookConfigPath(dataDir)} 已装配 ${hooks.size} 条钩子`
        + `${hookDisabled > 0 ? `（另有 ${hookDisabled} 条被停用）` : ''}`);
    } else if (hookConfig.exists) {
      write(`[Hook] ${hookConfigPath(dataDir)} 里没有可用条目`
        + `${hookDisabled > 0 ? `（${hookDisabled} 条被停用）` : ''}`);
    }
    // 工具集装配只有一处实现（tools/catalog.ts）：CLI 的 replay / doctor 重建请求体时
    // 必须拿到与运行期同一份工具说明，否则"模型当时看到了什么"就再也重建不出来。
    // vision 的模型通道适配：vision 期望 {role, content:[input_text|input_image][]}，
    // DS Responses 原生支持 input_image 块，透传即可（DsClient 类型未声明 image part，此处断言）
    //
    // **记账那一行是 2026-10-11 补的**：这个适配器原先把 `ds.generate()` 的返回值当
    // **无类型透传**交出去，`tools/vision.ts` 转手就把它压成字符串（`extractResponseText`）
    // ——`usage` 在第一跳就断了，vision 的 64 次真实模型请求因此一条账都没有，
    // 预算闸门看不见它（见 `_ops-light2\REPORT.md` ②）。
    // 现在**只是多交一份出去**：`return res` 与改动之前逐字节一样（同一个对象、同一个引用），
    // 请求体更是一个字节都没动（下面那个记账函数只写事件，不碰 `DsRequest`）。
    //
    // 取值的**先空后填**与 `registryRef` 同一个道理：`buildCatalogRegistry` 在下面就被调用，
    // 而它需要的那个记账函数要用到此刻还没定下来的东西——所以先给一个"不记账"的空实现占位，
    // 注册表造好之后立刻换成真的（填上的那一行就在下面 `catalog` 那一句之后）。
    // 工具调用发生在 turn 里，那一刻这个格子必然已经填好了。
    //
    // 形参就是工具层交出来的三格（响应 + 它那一步的 turn/step）——**原样收下、原样转交**。
    // 为什么还要多一格 `visionCallSite`：适配器（`visionClient`）拿到的是"请求 + 响应"，
    // 里面没有"这是哪一轮哪一步"；那是工具层手里的事实（`ctx` 在它那儿）。工具层在**同一次**
    // `generate` 里先交 turn/step（`onUsage`）、适配器紧接着交出响应，两步同一个同步块、
    // 中间不可能插进第二次调用，所以这一格读到的一定是本次那一对号。
    let visionCallSite = { turn: 0, step: 0 };
    let visionRecorder: (response: DsResponse, turn: number, step: number) => void = () => {};
    const visionClient = {
      generate: async (request: unknown) => {
        const res = await ds.generate(request as Parameters<DsClient['generate']>[0]);
        // turn/step 由工具层（`tools/catalog.ts` 那一层）从 `ctx` 里带出来——同一个适配器
        // 服务的是"工具调用"这一条路，而每一次调用都有自己的 turn/step。
        visionRecorder(res, visionCallSite.turn, visionCallSite.step);
        return res;
      },
    };
    /**
     * 注册表的**惰性取值点**：`task`（子代理）要的是"父注册表"本身，而它现在正在被造
     * ——`buildCatalogRegistry` 先把工具清单造出来，再逐件注册。所以给一个先空后填的格子：
     * 取值发生在 `task` 被调用的那一刻，那时它早就填好了。MCP 之后上线的新工具也在里面
     * （子代理的工具集是父的子集，就该照着调用那一刻的注册表现算）。
     */
    const registryRef: { registry: ToolRegistry | null } = { registry: null };
    const catalog = await buildCatalogRegistry({
      dataDir,
      timers,
      emit,
      visionClient,
      // vision 的用量账落点（2026-10-11）：工具层只交事实（原样的 `DsResponse` 与它那一步的
      // turn/step），写事件这件事在这里做——工具层没有 `log`/`nextSeq()`，这正是那 64 次
      // 真实请求零记账的原因（见 `recordVisionUsage` 那一篇注释）。
      //
      // turn/step 由工具层从 `ctx` 里交出来（与 `memoryReadRecorder` 同一条路：`catalog.ts`
      // 那格的注释写着"turn 由工具层从 `ctx.turn` 交出来，所以这里不需要'当前是哪一轮'
      // 这种跨层状态"）——这一格**原样转手**即可。
      visionRecorder: (response, turn, step) => {
        visionCallSite = { turn, step };
        recordVisionUsage(response, turn, step);
      },
      // 外部依赖（v30）：pwsh 7 / ripgrep / es.exe 由框架统一探测一次，结论在本次进程内共享。
      // 三处消费同一份缓存——pwsh 的默认 shell、rg_search / es_search 注不注册、
      // 以及 GET /api/deps 与设置页的「外部依赖」卡片。构造它不发任何进程（探测是惰性的）。
      deps,
      // 条件注册的工具不出现时必须说出来：静默少一件能力比启动失败更难查
      onNote: write,
      // 图片直通（design §4.20）：开了它，QQ 发来的图片会直接进上下文，
      // 并且 vision_read 的 inline 参数可用（把指定图放进上下文而不是转述）
      visionImagesToContext: config.vision.imagesToContext,
      // 发言节奏（config.speak）与"他刚说了什么"：都只服务 speak。
      // 后者走惰性取值——catalog 先于 RealLoop 就位，而那句话只有循环层知道。
      speakTyping: config.speak,
      // ask_human 的回执要报"多久没人答会告诉你"（design §6.1）：与 real-loop 落 human/expired
      // 读的是同一个配置值，两处各写一个数必然漂移
      askHumanTimeoutMs: config.tools.askHumanTimeoutMin * 60_000,
      userSpoke: () => realLoopRef.current?.userSpokeNow() ?? null,
      // read_channel 的两个注入点（v32）：消息要现读日志、名字要现读她的别名表与联系人表，
      // 两样都在循环层手里（它持有 EventLog 与会话簿）。catalog 先于 RealLoop 就位，
      // 所以同样走惰性取值——调用发生在 turn 里，那一刻的循环才是要用的那个。
      channelReader: async (sid, limit, before) =>
        await realLoopRef.current?.readChannelMessages(sid, limit, before) ?? [],
      // 会话簿（v66）：`read_channel` 不给 sid 时列的那一份。取的正是此刻层那张清单的**同一个口**
      // （`RealLoop.sessions()`），所以"清单上说还有 N 个没列"与"这一支列出来的全部"必然一致。
      // 惰性取值同上面几条：catalog 先于 RealLoop 就位，调用发生在 turn 里。
      channelSessions: () => realLoopRef.current?.sessionRows() ?? [],
      // 她自己在这个会话里说过的话（2026-10-04 用户："read channel 返回的结果里应该包含 bot
      // 自己的 speak"）。同一个循环层的口——它读的是 speak 的投递回执，工具层不碰日志。
      channelSpokenReader: async (sid) => await realLoopRef.current?.readChannelSpoken(sid) ?? [],
      // 群里发生过的事（2026-10-11）：同一个循环层、同一个日志，只是**另一种事件**
      //（`channel/notice`：谁开了全员禁言、谁入群退群、谁撤回了一条……）。
      // 不接这一根线，notice 就"只进不出"——落库了、可见性也对，可她永远看不见。
      channelNoticeReader: async (sid, limit, before) =>
        await realLoopRef.current?.readChannelNotices(sid, limit, before) ?? [],
      // 她自己的管理动作（「我做过」，2026-10-11）：同一个循环层、同一个日志，**第四种事件**。
      // 平台**不对她自己的动作发 notice**，所以这一眼只能从 MCP 管理类工具的回执那一层补
      //（catalog 的 `onReceipt` → `channel/self-action`）。不接这一根线那条账就"只进不出"：
      // 日志里有、她永远看不见——她翻那个群时看不到"我设过全员禁言"。
      channelSelfActionReader: async (sid, limit, before) =>
        await realLoopRef.current?.readChannelActions(sid, limit, before) ?? [],
      // 群里动静那一行里说"我"的时候要用它（notice 不带昵称）。递**取值器**：这份认知是
      // 运行期长出来的（OneBot 等 self_id、官方等 /users/@me 或群里 @ 我的事件），
      // 而工具包在启动时就造好了——收快照等于永远空集。
      selfIds: () => selfIdentity.values(),
      resolveChannelName: (sid) => realLoopRef.current?.resolveChannelName(sid) ?? null,
      // read_channel 每行那个短时间用本机时区（她不该在自己读数时做换算，见 admin.ts）
      timezone: config.timezone,
      // 这一轮叫她的那条消息（提及/@）：read_channel 对那个会话一律照给（v28 的配套）
      mentionMessage: () => realLoopRef.current?.currentMention() ?? null,
      // read_channel 每行的"谁"：按**人**解析名字（有单聊记录的人认得出，其余给短代号）
      resolvePersonName: (person) => realLoopRef.current?.resolvePersonName(person) ?? null,
      // destructive 工具的装配开关（§4.10 第三级门）：决定 http_post / http_download 这类
      // 「配置里显式开启才注册」的工具造不造出来，也决定 pwsh 的危险模式放不放行
      destructiveEnabled: destructiveTools,
      // MCP 入口（2026-10-09）：`mcp` 工具的接线面就是池的那三个方法。
      // **无条件传**（不是"有 server 才传"）：这一件必须常驻，理由见上面 mcpPool 的注释。
      mcpClient: mcpPool,
      // 披露式下**唯一还管得住 MCP 危险动作的那道门**：MCP 的工具不进注册表，
      // `registry` 的 destructive 过滤够不着它们，所以入口那一件自己读这个开关
      // （判据与代价见 `src/tools/mcp-entry.ts` 的文件头那张表）
      mcpDestructiveEnabled: () => config.tools.destructiveEnabled,
      // 单条回执上限：`mcp` 的清单披露走它（与父循环、子代理同一把尺）
      blobOffload: { dataDir },
      // `task`（隔离子代理，design §4.21）的注册开关：**默认 false = 不注册**。
      // 判据是用户显式写的 `tools.taskEnabled`，与 destructiveEnabled 刻意**不共用**：
      // 后者是"允许她做不可自动重试的事"，前者是"多一件常驻工具"——两件事，两个开关
      //（共用会让"把 destructive 打开"顺带把子代理能力也打开，那是加能力的副作用，不是决定）。
      taskEnabled: config.tools.taskEnabled,
      // 运行期素材**惰性取**：注册表这一句还在造（此刻 catalog.registry 尚不存在），
      // 投影与人格也还没交到循环手里。取值发生在 `task` 被调用的那一刻，那时三样都在。
      // `guard` / `planGate` 由 RealLoop 每轮补上（它才有判定器与计划门）。
      taskRuntime: () => {
        const live = registryRef.registry;
        // 没填上 = 装配没走完（理论上到不了这里）：判 null，`task` 会如实报"未接线"
        if (live === null) return null;
        return {
          log,
          ds,
          registry: live,
          projection: recovery.projection,
          persona,
          // 单条工具回执的上限：**与父循环同一份配置**（父那处在 real-loop 的 agentDeps）。
          // 子代理的上下文同样是她的上下文那一类东西，不能因为"派了个子代理"就没有这条界。
          blobOffload: { dataDir },
        };
      },
      // 后台任务管理器惰性取值：装配顺序上 catalog 先于 jobManager 的其它消费方就位
      jobs: () => jobManager,
      // 记忆访问账（design §4.17 第 2 条"访问强化"）：`memory_read` 每读成功一条就记一笔，
      // **只放指针不放正文**（正文已经作为工具结果留在历史里）。有了它，"整理任务把常读的
      // 条目往前提"才有数据可依——在那之前这条机制一直是"设计里有、实现里没有"。
      memoryReadRecorder: (data) => emit('memory/read', data),
      // 受保护路径（钩子配置 + 本机凭据）对 agent 只读（§4.19 第 5 条）：写入口拒绝，读不受限。
      // 名单与 `send_media` 的外发门是**同一份**（见上面 protectedPaths 的定义处）
      protectedPaths,
      // 回投接线（M9）：通道存在时 speak 的第三路才有地址；回投实现走通道自己的发送器
      ...(replyPoster === null ? {} : {
        currentWakeChannel: () => realLoopRef.current?.wakeChannel() ?? null,
        replyPoster,
      }),
      ...(mediaPoster === null ? {} : { mediaPoster }),
      // "正在输入"：只在配置开着（且装了通道）时才有这一下——关掉时连口子都不传
      ...(inputNotifyPoster === null ? {} : { inputNotify: inputNotifyPoster }),
      onPersonaUpdated: () => {
        const fresh = loadPersona(dataDir);
        persona.identity = fresh.identity;
        persona.constitution = fresh.constitution;
        persona.style = fresh.style;
        persona.state = fresh.state;
        persona.personaHash = fresh.personaHash;
        persona.isSeed = fresh.isSeed;
      },
    });
    const registry = catalog.registry;
    toolRegistry = registry;
    // 填上那个惰性格子（见上面 registryRef 的注释）：`task` 的取值器从这一刻起拿得到父注册表
    registryRef.registry = registry;
    // 填上 vision 的记账格子（与上面同一手法，也同一个理由）：注册表已经造好，而适配器
    // 此刻起每一次真发出去的请求都会把响应带到这里。在那之前它是空实现（不记账）——
    // 那一刻还没有任何工具能发起调用，所以那个空窗期不丢任何一条账。
    visionRecorder = recordVisionUsage;
    // 工具开关（设置界面的禁用名单）：从配置装载到内存注册表。关掉的工具不进模型请求，
    // 界面仍列得出来（显示为关闭态）——名单外的名字由 setDisabled 自己忽略
    registry.setDisabled(config.tools.disabled);
    // 单件工具注册失败必须说出来：静默少一件能力，比启动失败更难查（§4.18 的描述预算）
    for (const problem of catalog.problems) write(`[工具] 未注册（已跳过）：${problem}`);

    /**
     * 技能系统（design §4.19）：技能根 = **数据目录**（`<dataDir>/skills`、`<dataDir>/.agents/skills`），
     * 与 `persona/` 同级。
     *
     * 为什么 baseRoot 从 `process.cwd()` 改成 `dataDir`（v79，2026-10-23 两条病同源）：
     *   ① 运行环境搬进安装目录、数据目录另立一处之后，cwd 那份技能根就是**安装目录**里的
     *      技能——界面上"没有任何技能"、catalog 0 条；
     *   ② 更重的那条：技能实体住在安装目录 ⇒ 安装器更新（整体替换）⇒ 装的技能全没。
     * 技能实体搬进数据目录之后，安装目录/仓库里的 `skills/` 只是出厂种子（`skill/seed.ts`
     * 首次运行复制一次），更新再也碰不到用户装的技能。
     *
     * `compatBaseRoot: process.cwd()` 是**兼容根**（优先级最低）：数据目录里还没有这一份时
     * 仍能扫到老安装/开发目录里的技能（`planSkillRoots` 的三条规则写在 `skills.ts` 里）。
     * 模型读正文的写法一个字节都没变（还是 `skills/<name>/SKILL.md`）：fs 工具的别名表把
     * `skills/` 接到 `<dataDir>/skills`（`tools/fs/env.ts` 的 `pathAliasesFor`）。
     * 只有过了信任门（skill/installed{by:'human'}）的 skill 才进 catalog——启动时把话说清楚。
     */
    const skills = new SkillManager({
      baseRoot: dataDir,
      compatBaseRoot: launchCwd,
      packageRoots: pluginRuntime.skillRoots,
      out: write,
      emit: (type, data, visibility) => {
        append(type, data, visibility);
      },
    });
    for (const line of skills.startupWarnings()) write(line);
    replacePluginSkills = (roots) => { skills.setPackageRoots(roots); };

    loop = new RealLoop({
      log, dataDir, projection: recovery.projection, now,
      timezone: config.timezone ?? 'Asia/Shanghai',
      ds, registry, persona, config, out: write,
      mcpDeclarations,
      // 插件组合变了 ⇒ 常驻索引必须在下一拍失效（否则撤走的 server 会留在模型索引里）
      pluginRevision: () => pluginRuntime.revision,
      onTurnBoundary: async () => { await circuitBreaker?.drain(); },
      // 版本号（`runtime/restart` 的通报里要说"你现在跑的是哪一版"）：给的是**同一个常量**
      // ——`session/start.version` 写的也是它。循环自己不去盘上读 `package.json`：
      // 版本号的唯一真相源就是这一行（见它的注释），多读一处就是多一个会漂的口径。
      version: AGENT_VERSION,
      // 同一个告警实例：启动告警刚写下的 alarm/sent 就是它的限流窗口起点
      notifier,
      skills,
      // 「我自己是谁」的那一份（与宿主落库口**同一个实例**）：循环只在群成员登记那一处用它，
      // 挡的是 warmUp 重折历史事件时把判据补上之前落下的回声又登记一遍（见那一格的注释）
      selfMessages: selfIdentity,
      // 执行点钩子（§4.19）：三个执行点一次装配全部生效（工具两点走执行器，Wake 走循环）
      hooks,
      // 每日记忆整理（design §4.17）：布防与 payload 识别都读这张表
      timers,
      // `%TEMP%` 兜底扫（2026-10-21）：每日整理那一拍顺带跑一次。开关在这个进程里只读一次
      // （`sweepPlan`，与启动那一拍同一份判据）；`off` 就**不注入**——那一拍连"扫了零个"的账都不写。
      ...(sweepPlan.mode === 'off' ? {} : { tempSweep: async () => await runTempSweep({ mode: sweepPlan.mode }) }),
      // 她问人之后的等待线（§6.1）：与上面 catalog 传的是同一个配置值
      askHumanTimeoutMs: config.tools.askHumanTimeoutMin * 60_000,
      // `task` 子代理的运行期素材（design §4.21）：**只在用户真的打开了它时才给**。
      // 这里补的是只有循环才知道的三样——刹车判定器（活取，加注会换实例）、计划门、
      // 执行点钩子；其余四样（log / ds / registry / projection / persona）由 catalog 那侧
      // 的取值器给（装配点就有）。没打开时这一格不传：于是"没开"在运行期也是真的，
      // 而不只是"没注册"。
      ...(config.tools.taskEnabled ? { taskRuntime: {} } : {}),
    });
    write(`[模型] 已配置 ${config.models.heavy.model}（key 来自环境变量 ${config.models.heavy.apiKeyEnv} 或本地密钥文件），`
      + `工具 ${registry.listForModel({ includeDestructive: config.tools.destructiveEnabled }).length} 件可用`
      + `（注册 ${registry.size} 件，其余被 destructive 策略或工具开关挡在模型视线外）`);
    /**
     * **「现在跑的是什么」的第一份读数**（2026-10-21）。
     *
     * 为什么非印不可：界面上直到今天都**没有一个"现在在用哪个端点"的读数**，而设置页读的是
     * 盘上那份（`?source=saved`）——于是"改了 light 的端点、重启没真换进程"在屏幕上看起来
     * 一切正常，实际请求还打在旧端点上。这一行把两条 lane 的**启动值**（= 本进程真正会用的）
     * 与**密钥来源**一起说清：key 从环境变量来时会压过设置页刚写进 `.keys.json` 的那把，
     * 这正是"填了新 key 却还是 401"那种现场的唯一解释。
     *
     * 格式与设置页那行「现在跑的是 …」同源（同两个值：`models.<lane>.model` / `.baseUrl`），
     * 所以人和界面不会读到两种说法。
     */
    write(describeLaneReadout(config, lightLaneKey));
  } else {
    loop = new FakeLoop({
      log,
      dataDir,
      startTurn,
      projection: recovery.projection,
      now,
    });
    // 假循环也要有一份工具注册表：工具本身不依赖模型（vision 的通道不传就是"注册可用、调用即报错"），
    // 而**界面必须看得见清单与开关**——否则没有 key 的机器上，「扩展 → 工具」永远是空的，
    // 用户既看不到她有什么工具，也关不掉任何一件。emit 给空实现：这些工具不会被派发（不跑模型），
    // 真要用工具得先配好 key 走上面那条分支。
    const observed = await buildCatalogRegistry({
      dataDir,
      timers,
      emit: () => {},
      // 与真循环那份**同一个数组**（不是各算一遍）：两处各写一次名单，迟早漂成两份
      protectedPaths,
      destructiveEnabled: destructiveTools,
      deps,
      onNote: write,
      // MCP 入口照旧装配（与真循环**同一个池实例**）：界面要看得见它、也要能关它。
      // 这一支里没有任何东西会调用它（不跑模型就不派发工具），所以它不会拉起外部进程。
      mcpClient: mcpPool,
      mcpDestructiveEnabled: () => config.tools.destructiveEnabled,
      blobOffload: { dataDir },
      // **刻意不接 `memoryReadRecorder`**：这条分支没有真循环（不跑模型、不派发工具），
      // 所以永远不会有一次真的记忆读取，也就没有访问账可记。`memory_read` 照旧注册
      // ——界面要看得见清单与开关（上面那条注释的理由）。
    });
    toolRegistry = observed.registry;
    toolRegistry.setDisabled(config.tools.disabled);
    for (const problem of observed.problems) write(`[工具] 未注册（已跳过）：${problem}`);
    write(`[模型] 未找到 API key（设环境变量 ${config.models.heavy.apiKeyEnv}，或在设置页把密钥写进 data/.keys.json），降级为假循环`);
    write(`[工具] 假循环下仍装配 ${toolRegistry.listForModel({}).length} 件工具供界面查看与开关（不会被执行）`);
  }
  if (loop instanceof RealLoop) realLoopRef.current = loop;

  /**
   * 「她被怎么称呼」（`channels.mentionKeywords`）：**可变**，界面改完立刻生效。
   *
   * 为什么不做成"改了要重启"：这几个词决定的是"群里喊她名字算不算在叫她"，
   * 而人第一次多半会填错（太宽误唤醒、太窄会漏），当场改当场试才是正常用法。
   * 持久化仍走配置文件（`POST /api/commands/set-mention-keywords` 写盘 + 调下面那个回调）。
   */
  let mentionKeywords: string[] = [...config.channels.mentionKeywords];

  // ── 更新检查（2026-10-22）──
  //
  // 装配点放在 web 服务之前：`GET /api/update` / `POST /api/update/check` 要它。
  // **它不依赖 web 服务**：web 起不来（端口被占）时更新检查照常按 12h 节奏跑——
  // 那是"用户该知道有新版本"的提醒，不该陪绑一个本地端口。
  //
  // 三个配置值在这里读一次（`update.*` 是 restart 级，改完重启才接管；见 config/watcher.ts）。
  // `emit` 用的是本文件的 `append`：`update/checked` 的可见性在 `log/types.ts` 里钉死 internal
  // ⇒ 不进她的上下文、不产生 speak/report（这条提醒只给用户）。
  const updateService = new UpdateService({
    dataDir,
    currentVersion: AGENT_VERSION,
    enabled: config.update.enabled,
    channel: config.update.channel,
    endpoint: config.update.endpoint,
    now,
    emit: (type, data, visibility) => {
      append(type, data, visibility);
    },
    out: write,
  });

  // ── 观测前端与 webhook 的本地 HTTP 服务（design §4.15/§4.16）：真假循环都启动——
  // 它不依赖模型，假循环降级时照常可观可控。token 首启只打印一次（server.tokenCreated）。
  // 韧性：本地服务启动失败（如端口被占）只告警不拦启动——agent 的职责是干活，不是陪绑一个端口。
  let webServer: WebServer | null = null;
  try {
    webServer = await startWebServer({
      log,
      projection: recovery.projection,
      config,
      personaRoot: join(dataDir, 'persona'),
      dataDir,
      /**
       * **端口早绑那一层交出来的 socket 与同一份启动状态**（2026-10-26）：
       *   · `bootstrap` 给了 ⇒ 本服务**不重新 bind**，直接把同一个 socket 上的请求接到
       *     `route`（不换端口、不留空窗，界面在重启窗口里不会被 RST / ECONNREFUSED）；
       *   · `startup` 是**同一个实例** ⇒ `/api/health` 报 ready 的那一刻，数据路由已经能答
       *     （拉起器与界面都只凭这一条就敢说"后端回来了"）。
       * 端口没能先 bind 时（`preflight === null`）两格都不传：本服务自己 listen，
       * 启动状态是自带的"已经就绪"——行为与改前逐字相同。
       */
      ...(preflight === null ? {} : { bootstrap: preflight, startup: startupState }),
      // 认证库：与启动期 `/api/auth/state` 用的是**同一个实例**（认证判据只有一份）
      auth: authStore,
      /**
       * 技能根基准（v79）：与运行期那份 `SkillManager` **同一个基准**（数据目录），
       * 界面上的技能列表 / 批准落地 / 删除 / 重建预览因此与"她当时看到的"同源。
       *
       * 不传的代价（改之前就是这样）：web 侧按 `process.cwd()` 猜，于是界面看的是
       * **安装目录**里的那份技能——点"装一个技能"也装回安装目录，更新一次全没
       * （正是这次要修的第二条病）。这一格是那些动作唯一的落点，不能省。
       */
      skillsRoot: dataDir,
      timers,
      now,
      /**
       * **配置文件的绝对路径**（2026-10-23 加）：界面侧的保存（`config-update` /
       * `mcp-save` / 工具开关）写的就是这一份。
       *
       * 不传的话 web 侧按 `join(process.cwd(), 'config.json')` 自己猜一个——`--config`
       * 指到别处时，界面会把改动写进**另一份文件**，而进程读的还是原来那份：
       * 屏幕上「已保存」、行为一点没变。判据只有一处（这里给的就是 `loadConfig` 读过的那条）。
       */
      configPath: loadedConfig.path,
      plugins: pluginManager,
      // 管理视图（/api/skills、/api/mcp）要看到插件贡献：给的是函数，读的永远是当下这一份组合
      pluginRuntime: () => pluginRuntime,
      ...(toolRegistry !== undefined ? { registry: toolRegistry } : {}),
      // 更新检查的数据口（GET /api/update 与 POST /api/update/check 的宿主）
      update: updateService,
      /**
       * **配置热更接线是活的吗**：`mcp-save` / `mcp-remove` 的回执里那一格 `restartRequired`
       * 靠它给事实（否则那句话是假的：热更落地之后写盘即生效，不必重启）。
       *
       * 给的是**函数**而不是当下的快照：`stop()` 之后 `live` 会变 false，而回执问的是
       * "此刻有没有人在接管配置变化"。判据只有一处（`ConfigWatcher.live` 的注释）。
       */
      configReload: () => configWatcher.live,
      // 外部依赖：GET /api/deps 读它的缓存结论，dep-install 装完就地复检并刷新它
      deps,
      // 内置协议端（v34）：界面上要能看它的状态、启停它、改它的目录。
      // 只在启动时真建了实例才注入——没注入时那三条端点照常工作（报"没配置/没装配"），
      // 因为"什么都没配"恰恰是设置页最该显示出来的那种常态（见 WebServerDeps.protocolSide）。
      ...(managedService !== null ? { protocolSide: managedService } : {}),
      /**
       * 第三档（v36）：适配器的链路状态由它自己回答（它握着那条 ws），
       * 协议端那两档由 protocolSide 回答——两句话合成"到底断在哪一环"。
       *
       * 这里给的是**取快照的函数**而不是快照本身：状态是随时变的（重连、收消息），
       * 界面每问一次就该拿当时的那一刻。
       */
      onebotLink: () => {
        const link = onebotChannel === null ? null : onebotChannel.linkView();
        const hasEndpoint = managedStatus?.endpoint !== undefined
          || config.channels.onebot.wsUrl.trim() !== '';
        return {
          enabled: config.channels.onebot.enabled,
          connected: link?.connected ?? false,
          hasEndpoint,
          ...(link === null ? {} : { target: link.target }),
          ...(link === null || link.selfId === '' ? {} : { selfId: link.selfId }),
          reconnectAttempts: link?.reconnectAttempts ?? 0,
          lastEventAt: onebotChannel === null ? null : (onebotChannel.snapshot().lastEventAt ?? null),
          delivered: onebotChannel === null ? 0 : onebotChannel.snapshot().delivered,
        };
      },
      notifier,
      host: config.web.host,
      port: config.web.port,
      onPersonaUpdated: () => {
        const fresh = loadPersona(dataDir);
        persona.identity = fresh.identity;
        persona.constitution = fresh.constitution;
        persona.style = fresh.style;
        persona.state = fresh.state;
        persona.personaHash = fresh.personaHash;
        persona.isSeed = fresh.isSeed;
      },
      // 关键词热更：改完下一句消息就按新名单判（回调只换运行期那份，盘上那份已在命令里写好）
      onMentionKeywords: (keywords) => { mentionKeywords = [...keywords]; },
      // 「界面聊天框里那句就是人开口」——本模块自己 appendSync 落的 wake/manual 不经过
      // `RealLoop.wake()`（那是 WakeSink 的正门），所以在这里补一次通报：不补，她正在说的
      // 那半截话会照旧说完（用户 2026-10-03 17:38 那轮，注释见 WebServerDeps.noteUserSpoke）。
      //
      // 只接真循环：判据（哪些唤醒算"人开口"）由循环层自己把着，这边不做第二份判断。
      // 假循环下没人读那个计数，接了等于没有，但装配路径只有一条。
      noteUserSpoke: (seq, type, data) => {
        if (loop instanceof RealLoop) loop.noteUserSpokeEvent(seq, type, data);
      },
      /**
       * 用户急停（`/stop`，2026-10-16 加）的两步口——与界面那条 `wake/manual` 的
       * "落库 + 通报"同一个顺序、同一处（见 `WebServerDeps.ownerStopCommand` 那段注释）：
       *   · ① 落库**之前**：是急停就当场掐流 + 清队列（判据与动作只有一份实现：
       *     `RealLoop.ownerStopCommand` → 与 QQ 单聊入口 `onChannelMessage` 走的
       *     `wake()` 那条路同一个 `stopCommandOf`）；
       *   · ② 落库**之后**（同一个同步块里）：`consumeStopCommand` 落留痕、把这件急停作废。
       * 缺省不注入 = 按老路走（落 `wake/manual`、下一拍处理），所以假循环与测试的装配不用改。
       */
      ownerStopCommand: (type, data) => (loop instanceof RealLoop ? loop.ownerStopCommand(type, data) : null),
      consumeStopCommand: (type, data, wakeSeq) =>
        (loop instanceof RealLoop ? loop.consumeStopCommand(type, data, wakeSeq) : null),
      // 第三步：载体摘除。**只能在 `appendSync` 折完投影之后**（见 RealLoop.dropStopInput 的注释）
      dropPendingStopInput: () => (loop instanceof RealLoop ? loop.dropStopInput() : 0),
      /**
       * **实例自述的静态那一半**（`GET /api/instance` 的 `name` / `isDefault`）。
       *
       * 为什么由宿主给：那两个字段的真源在**登记表**（后端 bind 时写、界面读），而 `name`
       * 是"新增那一刻定下、之后永不覆盖"的东西——web 层每次现读盘反而会让"启动之后改名"
       * 跟登记表打架。端口与 pid 是 web 层自己知道的事实，不进这一格。
       */
      ...(instanceRef.record === null ? {} : {
        instanceIdentity: { name: instanceRef.record.name, isDefault: instanceRef.record.isDefault },
      }),
      out: write,
    });
    // 启动时只报"门是什么状态"，**不打印任何凭据**（密码与会话凭据的原文从不进日志）。
    // 首次启动的人要知道的是"去哪儿设密码"，不是一串要粘贴的 token——那段日子结束了。
    if (webServer.auth.initialized) {
      write(`[界面] 本地服务 ${webServer.url()} · 已设密码（凭据在 data/.auth.json；忘记密码 = 删掉它重启）`);
    } else if (webServer.auth.legacyTokenActive) {
      write(`[界面] 本地服务 ${webServer.url()} · 还没设密码：请打开 GUI 设置一个（旧的 data/.ui-token 现在仍可用，设完即作废）`);
    } else {
      write(`[界面] 本地服务 ${webServer.url()} · 还没设密码：请打开 GUI 设置一个`);
    }
    // 「就绪」这条读数同时是拉起器等的那个判据（`GET /api/health` = ready）。
    // 打上从**进程启动**到就绪的毫秒数：这台机器冷启动到底多久，日志里一眼能查。
    write(`[界面] 后端就绪：http://${config.web.host}:${webServer.port()}`
      + `（从进程启动起 ${Math.round(process.uptime() * 1000)} ms；/api/health 现报 ready）`);
    /**
     * 登记表：**就绪那一刻**补记 `lastReadyAt`。
     *
     * 为什么不在 bind 那一刻写：`lastStartedAt` 与 `lastReadyAt` 是两个事实，中间那段
     * （本机冷启动 35–42 秒）恰恰是"它起了但还不能干活"——界面判活要能区分这两档。
     *
     * `instanceRef.record === null`（端口没能先 bind，所以 bind 那一刻没登记）⇒ 这里补登记一次：
     * 真服务的端口就是这一次 listen 出来的那个，"我听了 7788"这句话现在才有事实撑。
     */
    if (instanceRef.record === null) {
      registerInstance(webServer.port());
    } else {
      markInstanceReady({ path: instancesPath, dataDir, pid: process.pid, now });
    }
  } catch (err) {
    write(`[界面] 本地服务启动失败（不拦启动）：${describeError(err)}`);
    // 端口早绑了、真服务却起不来 ⇒ 那个 socket 与端口文件都得收掉：
    // 留着只会让界面对着一个"有人听、谁都不答"的端口（或者连到一个死端口）等到超时。
    await closePreflight();
  }

  // 更新检查起拍：**无论 web 服务成没成**（见上面装配点那段注释）。
  // 首检延迟 60 秒（`UPDATE_FIRST_CHECK_DELAY_MS`），之后按 12h /（连续失败 3 次后）24h 自查；
  // 定时器是 unref 的——它不该把进程留在事件循环里，退出流程也不必等它。
  updateService.start();

  /**
   * 什么算"关注"——口径写在 `channel/inbox.ts` 的 `WATCHED_SESSION_SOURCES`，这里是实现：
   * **人声明的事实**（`config.persona.contacts` 里有名字的 sid）∪ **她自己认的人**
   * （`MEMORIES/aliases.md`）。
   *
   * 为什么每条消息现读一次别名表而不是装配时读一次：那是**她自己会改的文件**，
   * 改完下一条消息就该生效——启动时读一次意味着"她认了人，但直到重启前都不算数"。
   * 文件很小（几 KB），消息也不密，这个代价换"改动立即生效"是划算的。
   */
  /**
   * 什么算"关注"——口径写在 `channel/inbox.ts` 的 `WATCHED_SESSION_SOURCES`，这里是实现：
   * **人声明的事实**（`config.persona.contacts` 里有名字的 sid）∪ **她自己认的人**
   * （`MEMORIES/aliases.md`）。
   *
   * 为什么每条消息现读一次别名表而不是装配时读一次：那是**她自己会改的文件**，
   * 改完下一条消息就该生效——启动时读一次意味着"她认了人，但直到重启前都不算数"。
   * 文件很小（几 KB），消息也不密，这个代价换"改动立即生效"是划算的。
   */
  const watchedSidsOf = (): ReadonlySet<string> => {
    // **键要归一**（2026-10-02 会话身份归一）：消息那一侧算出来的 sid 现在是 `qq:group:<群id>`，
    // 而人手里那张表可能还是归一前填的 `qq:group-at:<群id>`——不归一就会出现
    // "我给这个群起过名字、以为关注上了，实际一条都没叫醒她"（用户实测撞上过）。
    const out = new Set<string>();
    for (const sid of Object.keys(config.persona.contacts)) out.add(normalizeSid(sid));
    try {
      const text = readFileSync(join(dataDir, 'workspace', 'MEMORIES', 'aliases.md'), 'utf8');
      for (const sid of parseAliases(text).keys()) out.add(normalizeSid(sid));
    } catch {
      // 没有那份文件 = 她还没认过人，不是错误
    }
    return out;
  };

  /**
   * 通道消息的落库口（与其它唤醒源同一条纪律：先落盘再返回）。
   *
   * **两条出口，别混**：@ 她 / 关注的会话走 `loop.wake`（进消息流、起 turn）；
   * 其余进**信箱**——`channel/message` 是 internal，写进待办队列就等于唤醒，
   * 那就把"她可以选择看不看"变成了"每一条都推给她"。信箱只记账：进会话簿、算未读，
   * 她通过会话清单里的条数知晓，想看再用 `read_channel` 现取。
   *
   * **两条出口的 `msgSeq` 最终都补上**（2026-10-07）：规则只有一个
   * （`channel/inbox.ts` 的 `msgSeqOf`），只是补的时机不同——
   * 信箱这条在**落库那一刻**补（seq 就在手上），唤醒那条在 `real-loop.wake` 里补
   * （事件 seq 是它分配的）。原先唤醒那条不补，代价是 OneBot 群 @ 那一轮的通知里**永远**
   * 不出现「（这一条你还没看过）」：判据 `wakeEvent.data.msgSeq > entry.readUpToSeq`
   * 遇上恒 0 永远为假，她会把它读成"又是上一次那条"而不回（报告 §3.4）。
   *
   * **2026-10-11：头一件事是「这条是不是我自己发的」**（判据与来历见上面 `selfIdentity`
   * 那一段——全仓只此一处）。命中就整条丢掉：她自己的话有 `speak/sent` 那条凭据，
   * `read_channel` 里照旧以 `（我）` 出现，与这里丢掉的这个**副本**是两回事。
   */
  const onChannelMessage = (data: WakeChannel['data']): void => {
    // 我自己发出去的那条（平台推回来的副本）：不落库、不注册群成员、不计未读。
    // 放在所有分支**之前**：连下面那条关键词判定都不必做——它本来就不是"别人说的话"。
    // 判据是 `channelGate`（唯一一处实现，见 channel/self-message-gate.ts 的文件头）——
    // 它读的是 `selfIdentity`：**此刻**知道的那一份（运行期学到的标识当场算数）。
    if (channelGate(data, selfIdentity)) {
      /**
       * 认出来了就**留一行痕**：这是"平台把我自己的话推回来了"唯一的现场凭据
       * （原先一个字都不记，于是"她怎么变成群友了"只能靠翻事件日志反推）。
       * 只记通道 + 那条的 id 前 12 位：够把一条对上，不抄正文、不抄标识。
       */
      write(`[通道] 收到一条我自己发的消息（${data.channel}），已按"自己的回声"丢弃：不落库、不注册成员、不计未读`);
      return;
    }
    // 文本提及（关键词）也算"在叫她"：判据在分流器里，这里只把**结论**记进事件
    // （`mentionsMe` 让渲染层说出"提到了你"而不是"@ 了你"——她据此判断该怎么接）。
    // **只有群聊才有"提及"这回事**：私聊里人家本来就在跟她说话，句子里带上名字是常事，
    // 标成"提及"会让此刻层多出一行不对句式的提示（见 self-brief 的 renderMentionNote）。
    const byKeyword = data.chatType !== 'c2c'
      && data.mentionsMe !== true
      && mentionsKeyword(data.text, mentionKeywords);
    if (shouldWakeForChannelMessage(data, { watchedSids: watchedSidsOf(), mentionKeywords })) {
      loop.wake({ type: 'wake/channel', data: byKeyword ? { ...data, mentionsMe: true } : data });
      return;
    }
    // 信箱这条路口同样要补（规则在 channel/inbox.ts 的 msgSeqOf）：不补的话平台给不出序号的
    // 那两类消息每一条都是 0，未读永远算不出来。
    appendWithSeq(
      'channel/message',
      (seq) => ({ ...data, msgSeq: msgSeqOf(data, seq) }),
      'internal',
    );
  };

  /**
   * 群里动静（`channel/notice`）的落库口：**只记账，不唤醒**。
   *
   * 与 `onChannelMessage` 的两条出口刻意不同：notice 不进 `loop.wake`（"有人撤回了一条消息"
   * 不是叫她）、也不参与未读（未读数的必须是**别人的话**）。它唯一的出路是 `read_channel`：
   * 她翻开这个群时，那一行 `[阿岚 开启了全员禁言]` 就在时间轴上（渲染在
   * `channel/self-identity.ts` 的 `noticeLineText`，名字走既有真源现查，查不到不编）。
   *
   * `msgSeq` 补成事件 seq：与 `channel/message` 同一条规则（`msgSeqOf`），
   * 这样将来若有人给 notice 算未读，口径不会分叉。
   */
  const onChannelNotice = (data: ChannelNoticeData): void => {
    // 平台原样给的载荷先过一遍形状检查：**畸形不落库**（一条渲染不出来的事件会让
    // read_channel 每次翻到这儿都多一行空的）
    if (!isChannelNoticeData(data)) return;
    appendWithSeq(
      'channel/notice',
      (seq) => ({ ...data, msgSeq: seq }),
      'internal',
    );
  };

  if (qqChannel !== null) {
    qqChannel.onMessage = onChannelMessage;
    qqChannel.onNotice = onChannelNotice;
  }
  if (onebotChannel !== null) {
    onebotChannel.onMessage = onChannelMessage;
    onebotChannel.onNotice = onChannelNotice;
  }

  const timerSource = new TimerWakeSource(timers, loop, now);
  const sources: WakeSourceAdapter[] = [
    timerSource,
    new ManualWatchSource(join(dataDir, WAKE_WATCH_DIR_NAME), loop, { now }),
    // 通道是输入源（start/stop 与其它源同寿），同时也是一个输出通道
    ...(qqChannel === null ? [] : [qqChannel]),
    ...(onebotChannel === null ? [] : [onebotChannel]),
  ];

  // 补记恢复期被静默结算的定时器：hint 表显示它启动时已过期、恢复后又不在表里，
  // 而日志里仍留着它的 timer/set（没有被 timer/fired 结清）——说明它是恢复流程
  // 同步触发的那一条，回调当时只写日志。事件由这里补，唤醒不丢。
  let backfilled = 0;
  for (const [timerId, at] of overdue) {
    const stillDefined = recovery.projection.timers.some((entry) => entry.timerId === timerId);
    if (stillDefined && timers.get(timerId) === null) {
      timerSource.emitDue(timerId, at);
      backfilled += 1;
    }
  }

  for (const source of sources) source.start();

  const manualSource = sources[1];
  if (manualSource instanceof ManualWatchSource) {
    for (const warning of manualSource.warnings()) write(`[唤醒源/manual] ${warning}`);
  }

  write(renderStartupSummary({
    dataDir,
    configPath: loadedConfig.path,
    dataDirSource: startup.source,
    recovery,
    timers,
    startTurn,
    mode: apiKey !== null ? 'real' : 'fake',
    persona,
    skills: skillRoots,
  }));
  if (backfilled > 0) {
    write(`[唤醒源/timer] 补记 ${backfilled} 条恢复期已触发的定时器（wake/timer 已入队）`);
  }

  /**
   * ── 后端保活前端（A 项）：主进程看着界面，界面意外没了就把它拉回来 ──
   *
   * 判据、协议与上限**全部写在** `runtime/gui-guard.ts` 的文件头（那里是唯一一处），
   * 这里只做三件接线的事：把路径喂给它、把它的每一条判定落成 `runtime/gui-relaunch`
   * （internal：原因 + 结果都在里面）、把"超限/永久停手"接到既有的告警出口。
   *
   * **界面 exe 的路径不许猜**：三个来源按优先级（环境变量 `IRMIA_GUI_EXE` →
   * `data/gui-path.txt` 里的一行 → 拉起器留痕里最近一次真的用过、且**盘上还在**的那一个），
   * 全都没有就**如实说"这次不保活"**并给出怎么补——绝不退到"按名字找一个像界面的进程"
   * （今晚踩过的那条坑：按名字判断会认错人）。
   *
   * **主动退出 vs 崩溃**：区分"用户主动关的"与"崩了"靠界面**退出前**写的那枚短时效标记（协议 `docs/gui-guard.md` §3）。
   * 界面那一半**已经接上**（v50 起：`gui/lib/gui_quit.dart` ⇒ `%APPDATA%\Irmia\gui-quit.marker`，关窗
   * `main.dart:85`／托盘 `tray.dart:150` 各写一次、**收进托盘不写**，b5d68ce）；**只有旧构建的界面**不写标记 ⇒ 那时主动关仍会被当崩溃拉回。
   */
  const guardMode = resolveGuardMode(process.env, dataDir);
  const guiFound = discoverGuiExe({ dataDir, env: process.env, fileExists: existsSync });
  /**
   * 句柄要先于 `stop()` 声明：退出路径里第一件事就是把它停掉
   * （不再有"界面没了 ⇒ 又被拉回来"这种在退出过程中冒出来的动作）。
   */
  const guiGuardRef: { guard: GuiGuard | null } = { guard: null };
  if (guardMode.mode === 'off') {
    write(`[界面保活] 已关（${guardMode.why}）：不看着界面，也不拉起它`);
  } else if (guiFound === null) {
    write('[界面保活] 找不到界面 exe 的绝对路径 ⇒ 本次不保活（绝不按名字猜）。三种给法任选一条：'
      + '环境变量 IRMIA_GUI_EXE=<exe 绝对路径>、'
      + `或写一行进 ${join(dataDir, GUI_PATH_FILE_NAME)}、或让拉起器（tools/restart-agent.ps1 -GuiExe …）先跑过一次`);
  } else {
    write(`[界面保活] 已布防：每 ${DEFAULT_INTERVAL_MS / 1000} 秒按**可执行文件全路径**看一次 ${guiFound.exe}`
      + `（路径来自 ${guiFound.source}）· 档位=${guardMode.mode}（${guardMode.why}）`
      + ` · 拉起上限 ${DEFAULT_MAX_RELAUNCH_PER_WINDOW} 次/${DEFAULT_WINDOW_MS / 60_000} 分钟，超限报警`);
    write(`[界面保活] 主动退出的判据：界面在退出前写 ${join(dataDir, 'gui-quit.marker')}（或 %APPDATA%\\Irmia 那一份，两处都认）`
      + ` ⇒ 新鲜就判"用户主动关的"，只记账不拉起。界面那一半**已接线**（v50 起：gui/lib/gui_quit.dart，`
      + `关窗与托盘退出各写一次，b5d68ce）——只有**旧构建的界面**不写标记 ⇒ 那时主动关会被当成崩溃拉回来；`
      + `要停就 IRMIA_GUI_GUARD=watch（只看不拉）或 =off，也可以建一个空文件 ${join(dataDir, GUI_GUARD_OFF_FILE_NAME)}`);
    guiGuardRef.guard = createGuiGuard({
      dataDir,
      exe: guiFound.exe,
      exeSource: guiFound.source,
      mode: guardMode.mode,
      io: { listPids: listPidsByExePath, launch: launchGuiByStartProcess },
      record: (r: GuiGuardRecord) => {
        append('runtime/gui-relaunch', { outcome: r.outcome, reason: r.reason, ...r.detail }, 'internal');
        write(`[界面保活] ${r.outcome}：${r.reason}`);
      },
      alert: (a) => {
        // 与其它告警共用同一个出口（限流窗口只有一份）：这里不 await，也不让它拦住别的收尾
        void notifier.alert({
          category: 'gui-guard',
          level: a.level,
          title: a.title,
          body: a.body,
          params: a.params,
        }).catch((err: unknown) => {
          write(`[界面保活] 告警没发出去（不影响保活本身）：${describeError(err)}`);
        });
      },
    });
  }

  // ── 退出 ──
  let stopping = false;
  const signalHandlers: Array<{ signal: NodeJS.Signals; handler: (signal: NodeJS.Signals) => void }> = [];

  const stop = async (reason: SessionEndReason = 'shutdown', detail?: string): Promise<void> => {
    if (stopping) return;
    stopping = true;

    for (const entry of signalHandlers) process.off(entry.signal, entry.handler);
    signalHandlers.length = 0;

    // 保活守在第一件事上停掉：退出过程中界面消失是**预期的**（拉起器先停界面再收后端），
    // 这时候再去"保活"只会与拉起器抢着拉出第二个界面。
    guiGuardRef.guard?.stop();

    // 更新检查的定时器跟着收掉：退出流程里不该再排一次 12 小时后的检测
    // （在飞的那一次请求由它自己的 8 秒上限收场，不拦退出）。
    updateService.stop();

    // 协议端是框架拉起来的，就得由框架收尸：先停它（killProcessTree 连子进程一起，
    // 否则 NTQQ 那层会变成孤儿进程，下次启动还会抢同一个端口）
    if (managedService !== null) {
      try {
        await managedService.stop();
      } catch (err) {
        write(`[退出] 协议端停止失败：${describeError(err)}`);
      }
    }

    for (const source of sources) source.stop();
    if (webServer !== null) await webServer.close();
    // 端口文件：**退出时删掉**（只删自己那份）。留着它，下一次界面启动会去连一个已经不在的端口
    // ——那正是这次事故里"界面指向了错误端口"的同一类失败。web 服务没起来时那份文件本来就不该在。
    //
    // 多实例（2026-10）：删的是**自己那两份**——每实例那份（`server.<port>.json`，按文件名里的
    // 端口定身份）与旧名的 `server.json`（`removeServerPortFile` 会核对 pid，只在还是自己时才删）。
    removeServerPortFile(perInstancePortPath, { out: write });
    removeServerPortFile(portFilePath, { pid: process.pid, out: write });
    /**
     * 登记表：**自己的 pid 清 0，不删条目**。
     *
     * 条目是"这台机器上存在过哪些实例"的记忆——删掉它等于让界面忘了那个实例，而它的
     * 数据目录还在盘上。清 0 的语义是"它现在没在跑"，界面据此显示"未运行"并给一个
     * 「启动并登录」。核对 pid 是**自己**的那一半在 `markInstanceStopped` 里（见那里的注释）。
     */
    markInstanceStopped({ path: instancesPath, dataDir, pid: process.pid, out: write });
    await closePreflight();
    // 配置热重载：先撤监听（fs.watch 与那路 250ms 轮询），再做后面那些收尾
    // ——退出过程中不该再有"配置变了 ⇒ 重连一个 MCP server"，那会与下面的池关机打起来。
    configWatcher.stop();
    // 半开探针此刻可能正握着别的进程：先关掉在飞的探测池，让 `listTools` 立刻失败。
    // 否则下面的 `circuitBreaker.stop()` 要等探针把 15s/30s 的预算走完，退出会明显变慢。
    await pluginProbe.cancelAll();
    await circuitBreaker?.stop();
    await runtimeApplyChain;
    await loop.stop();

    // MCP server 是**别人的进程**：框架拉起来的就得由框架收尸（与上面协议端同一条纪律）。
    // 走池自己的关机序列，收不掉时如实说出是哪几个——"留了一个孤儿进程"必须看得见。
    if (mcpPoolRef.pool !== null) {
      try {
        const reports = await mcpPoolRef.pool.shutdown();
        for (const report of reports) {
          write(`[退出] MCP server ${report.name} 已停止（${report.reason}：${report.stages.join(' → ')}）`);
        }
      } catch (err) {
        write(`[退出] MCP 池停止失败：${describeError(err)}`);
      }
    }

    try {
      append('session/end', detail === undefined ? { reason } : { reason, detail }, 'internal');
    } catch (err) {
      // 日志已不可写：仍然走完释放流程，让下一次启动能接管
      write(`[退出] 写 session/end 失败：${describeError(err)}`);
    }

    await loop.writeProjectionCache();
    timers.stop();
    try {
      await timers.flush();
    } catch (err) {
      write(`[退出] 定时器表落盘失败：${describeError(err)}`);
    }
    log.close();
    lock.release();
  };
  stopRef = stop;

  if (options.installSignalHandlers !== false) {
    const onSignal = (signal: NodeJS.Signals): void => {
      write(`[退出] 收到 ${signal}，开始优雅退出`);
      void stop('signal', signal).then(() => {
        process.exit(0);
      });
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, onSignal);
      signalHandlers.push({ signal, handler: onSignal });
    }
  }

  // ── 起拍 ──
  circuitBreaker?.start();
  loop.start();
  // 保活跟着主循环起拍（`start()` 会**先跑一拍**：布防当场就有一次"界面在不在"的读数）
  guiGuardRef.guard?.start();
  write(`[运行] 唤醒源 ${sources.length} 个已布防（日志目录 ${EVENT_LOG_DIR_NAME}/），假循环整装待发`);

  return { dataDir, loop, sources, recovery, config, persona, webServer, stop };
}

/**
 * 按配置建 QQ 官方通道（M9）。三个不建的条件都如实报出来——
 * "我配了它却没上线"比"它报错"更难查，所以每一种都不静默。
 */
function createQqChannelIfConfigured(
  channelConfig: AppConfig['channels']['qqOfficial'],
  write: (line: string) => void,
  dataDir: string | null = null,
): QqOfficialChannel | null {
  if (!channelConfig.enabled) {
    write('[通道/QQ] 未启用（config.channels.qqOfficial.enabled=false），跳过');
    return null;
  }
  // 复用 readApiKey 的取值链：环境变量名来自配置，环境里没值就回退到 .keys.json 的同名键
  const appId = readApiKey({ apiKeyEnv: channelConfig.appIdEnv }, process.env, dataDir, 'qqAppId');
  const clientSecret = readApiKey({ apiKeyEnv: channelConfig.clientSecretEnv }, process.env, dataDir, 'qqClientSecret');
  if (appId === null || clientSecret === null) {
    const missing = [appId === null ? channelConfig.appIdEnv : '', clientSecret === null ? channelConfig.clientSecretEnv : '']
      .filter((name) => name !== '').join('、');
    write(`[通道/QQ] 已启用但密钥未配置：${missing}；适配器未启动（配置里只写变量名，值放进程环境或设置页的本地密钥文件）`);
    return null;
  }
  const log = {
    info: (line: string) => { write(line); },
    warn: (line: string) => { write(line); },
  };
  const channel = new QqOfficialChannel({
    appId,
    clientSecret,
    log,
    ...(channelConfig.apiBase === undefined ? {} : { apiBase: channelConfig.apiBase }),
    ...(channelConfig.tokenUrl === undefined ? {} : { tokenUrl: channelConfig.tokenUrl }),
    ...(channelConfig.gatewayUrl === undefined ? {} : { gatewayUrl: channelConfig.gatewayUrl }),
    useMarkdown: channelConfig.useMarkdown,
  });
  // 值的来源照实说：环境变量里有就用环境变量，没有才是界面写进 data/.keys.json 的那份
  const fromEnv = (process.env[channelConfig.appIdEnv] ?? '').trim() !== '';
  const source = fromEnv ? `环境变量 ${channelConfig.appIdEnv}` : '本地密钥文件 data/.keys.json';
  write(`[通道/QQ] 已装配（appId 来自${source}）：网关长连接，intents=1<<25（群@与单聊）`
    + `；群消息攒批 ${channelConfig.groupBatchMinutes} 分钟（0 = 每条都唤醒）`);
  return channel;
}

/**
 * 按配置建 OneBot 通道（M9）。与 QQ 的差别只有一处：协议端（NapCat）常常压根没开 token 校验，
 * 所以环境变量缺失时**只警告照常连接**（匿名连），而不是像 QQ 那样"没密钥就不上线"——
 * 若协议端其实开了校验，握手会被它自己拒掉，日志里看得见失败原因。
 */
/**
 * 把配置里声明的内置协议端拉起来（可选）。
 *
 * 返回 null 表示"没配"；**起不来也返回实例**（带着 failed 状态）——界面要显示它为什么没起来，
 * 所以状态得留着。**任何失败都不抛**：协议端是她的一个器官，坏了不该让整个框架起不来。
 */
async function startManagedProtocolIfConfigured(
  config: AppConfig,
  write: (line: string) => void,
): Promise<ManagedProtocolService | null> {
  const managed = config.channels.onebot.managed;
  if (!config.channels.onebot.enabled || managed === undefined) return null;
  const service = new ManagedProtocolService({
    dir: resolveServiceDir(managed.dir, config.dataDir),
    onLog: (line) => { write(`[协议端] ${line}`); },
  });
  if (managed.autoStart === false) {
    write('[协议端] 已配置但 autoStart=false：本次不自动拉起');
    return service;
  }
  try {
    const status = await service.start();
    write(`[协议端] ${status.state}：${status.detail}`);
  } catch (err) {
    write(`[协议端] 拉起失败（不阻塞启动）：${describeError(err)}`);
  }
  return service;
}

function createOneBotChannelIfConfigured(
  channelConfig: AppConfig['channels']['onebot'],
  write: (line: string) => void,
  dataDir: string | null = null,
  /** 由框架拉起的协议端给出的对接点；给了它就**压过**配置里手填的 wsUrl / tokenEnv */
  managedEndpoint: { wsUrl: string; accessToken: string } | null = null,
  /**
   * 端点重读口（v37）：给内置协议端用——**每次建连前现读一次它的配置**。
   *
   * 为什么必须有它：协议端的 OneBot 配置是**人登录 QQ 之后**才物化到盘上的，
   * 而框架进程可能比它先起（实测现场：01:58 起进程时 `config/onebot.json` 还不存在，
   * 02:04 用户登录 QQ 之后它才写下来）。只在启动时读一次、读不到就固化，后果不是"晚一点连上"
   * 而是**永远连不上**：适配器此后每一拍都拿着空 token 去敲那个端口，日志里只有 401。
   * 读盘频率与失效条件在 `OneBotEndpointMemo`（缓存 + 硬下限 10 秒），这里只提供读法。
   */
  resolveEndpoint: (() => { wsUrl: string; accessToken: string } | null) | null = null,
): OneBotChannel | null {
  if (!channelConfig.enabled) {
    write('[通道/OneBot] 未启用（config.channels.onebot.enabled=false），跳过');
    return null;
  }
  /**
   * 地址与密钥的来源，两种情形二选一：
   *
   *   • **框架拉起的协议端**：都用它自己配置里的那份（`managedEndpoint`）。压过手填的那些字段
   *     是有意的——两边各填一遍就会有"填得不一样"的故障，而它的表现形式是"连上了但收不到消息"，
   *     最难查。既然端口和 token 本来就由它生成，就以它为准。
   *   • **外部协议端**：沿用原来的教义（wsUrl 从配置来、token 只写变量名、值从环境或密钥文件读）。
   *
   * **v37 起这两份只是"第一拍用的那份"**：`resolveEndpoint` 给了的话，适配器每次建连前会
   * 重新问一次协议端的配置（读法与缓存见那个参数与 `OneBotEndpointMemo`）。原因见它的注释：
   * 装配这一刻读到的 null 不能固化——协议端的配置本来就可能在框架之后才写下来。
   */
  const wsUrl = managedEndpoint?.wsUrl ?? channelConfig.wsUrl;
  const tokenFromEnv = managedEndpoint === null
    ? readApiKey({ apiKeyEnv: channelConfig.tokenEnv }, process.env, dataDir, 'onebotToken')
    : (managedEndpoint.accessToken === '' ? null : managedEndpoint.accessToken);
  const accessToken = tokenFromEnv;
  if (managedEndpoint !== null) {
    write(`[通道/OneBot] 对接点来自框架拉起的协议端：${wsUrl}`);
  }
  if (accessToken === null) {
    write(
      `[通道/OneBot] 密钥未配置（环境变量 ${channelConfig.tokenEnv} 与本地密钥文件都没有值）：按"协议端未开校验"匿名连接`
      + '（若 NapCat 开了 access_token，握手会被拒，日志里会看到连接失败）'
      + (resolveEndpoint === null
        ? ''
        : '；**每次重连前会现读一次协议端的配置**——它登录 QQ 之后写下的端点与 token 会被自动带上'),
    );
  }
  const log = {
    info: (line: string) => { write(line); },
    warn: (line: string) => { write(line); },
  };
  const channel = new OneBotChannel({
    wsUrl,
    ...(accessToken === null ? {} : { accessToken }),
    ...(resolveEndpoint === null ? {} : { resolveEndpoint }),
    log,
  });
  write(`[通道/OneBot] 已装配：连 ${wsUrl}（正向 ws，群@与单聊/群聊全量；回复无被动窗口限制）`
    + (resolveEndpoint === null ? '' : '；端点每次重连前现读一次（协议端配置晚于本进程物化时不会被固化成"没有 token"）'));
  return channel;
}

// ──────────────────────────────── 入口 ────────────────────────────────

let activeHandle: MainHandle | null = null;

/**
 * 进程入口：命令行里的 `--data-dir` / `--config` 与嵌进方显式给的 `options` 合并
 * （**显式的 options 优先**：那是代码里写死的事实，命令行是外部输入）。
 *
 * 命令行这一层为什么必须有：启动失败那句话早就写着"检查 --data-dir / IRMIA_DATA_DIR"
 * （见 `runMain` 里那条报错），而在此之前**根本没有这个参数**——指路指到一个不存在的东西，
 * 比不指路更坏。`--config` 是同一笔的配套：数据目录的第三档在配置文件里，而配置文件
 * 自己在哪，得有人能说。
 */
export async function main(options: MainOptions = {}): Promise<number> {
  try {
    const args = parseMainArgs(process.argv.slice(2));
    const merged: MainOptions = { ...options };
    if (merged.dataDir === undefined && args.dataDir !== undefined) merged.dataDir = args.dataDir;
    if (merged.configPath === undefined && args.configPath !== undefined) merged.configPath = args.configPath;
    // `--port`：显式给的那一格压过 config.json（见 parseMainArgs 里那段取舍）
    if (merged.port === undefined && args.port !== undefined) merged.port = args.port;
    activeHandle = await runMain(merged);
    // 句柄持有锁与日志：保留引用，等信号处理器调用 stop
    void activeHandle;
    return startupExitCode(null);
  } catch (err) {
    process.stderr.write(`${startupFailureLine(err)}\n`);
    return startupExitCode(err);
  }
}

/**
 * `entry` 显式可传是本笔唯一的形状变化（原来读死 `process.argv[1]`）：
 * 不传就是历史行为，传了才可测——否则这条判据只能靠起进程去验。
 */
export function isDirectRun(moduleUrl: string, entry: string | undefined = process.argv[1]): boolean {
  if (entry === undefined) return false;
  return moduleUrl === pathToFileURL(entry).href;
}

if (isDirectRun(import.meta.url)) {
  void main().then((code) => {
    // 正常路径下进程由信号处理器 exit；只有启动失败才走到这里
    if (code !== 0) process.exit(code);
  });
}

