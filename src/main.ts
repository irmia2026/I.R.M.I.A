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

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AppEvent, Visibility, WakeChannel } from './log/types.js';
// 值导入：工具侧写入点的**可见性判据**（表说 model 的事件省略可见性即抛，见它的注释）
import { resolveEventVisibility } from './log/types.ts';
import { msgSeqOf, mentionsKeyword, shouldWakeForChannelMessage } from './channel/inbox.ts';
import { ManagedProtocolService, readEndpointFromConfig, resolveServiceDir } from './services/snowluma.ts';
import { normalizeSid, parseAliases } from './channel/sessions.ts';
import { createNotifier } from './alert/notifier.ts';
import { notifyStartupRecovery } from './alert/startup.ts';
import { loadConfig, readApiKey, trustBoundaryRoot, type AppConfig } from './config/config.ts';
import { ConfigWatcher } from './config/watcher.ts';
import { ensurePersonaSeeds, loadPersona, type PersonaAssets } from './persona/loader.ts';
import { ensureMemorySeeds } from './persona/memory-maintain.ts';
import { ensureMemoryIndex } from './persona/memory-injection.ts';
import { DsClient } from './model/ds-client.ts';
import { McpClientPool, type McpDeclarationChange } from './mcp/client.ts';
import { buildCatalogRegistry } from './tools/catalog.ts';
import { createDepsManager, summarizeNotReady } from './deps/manager.ts';
import type { ToolRegistry } from './tools/registry.ts';
import type { InputNotifyPoster, MediaPoster, ReplyPoster } from './tools/admin.js';
import { SkillManager } from './skill/skills.ts';
import {
  HookRunner, digestProjection, hookConfigPath, loadHookConfig, protectedHookPaths,
} from './hook/hooks.ts';
import { RealLoop, memoryHostingEnabled } from './runtime/real-loop.ts';
import { startWebServer, type WebServer } from './web/server.ts';
import { AUTH_FILE_NAME, UI_TOKEN_FILE } from './web/auth.ts';
import { WEBHOOK_SECRET_FILE_NAME } from './web/webhook-secret.ts';
import { keysPath } from './config/keys.ts';
import { applyOne, finalizePressure } from './state/fold.ts';
import { JobManager } from './runtime/job-manager.ts';
import { toInstanceTakeoverData, type TakeoverRecord } from './runtime/instance-lock.ts';
import { FakeLoop, maxTurnOfLog } from './runtime/loop.ts';
import { EVENT_LOG_DIR_NAME, TIMER_FILE_NAME, recover, type RecoverResult } from './runtime/recover.ts';
import { TimerStore } from './wake/timer-store.ts';
import {
  QqOfficialChannel, createChannelReplyPoster,
} from './channel/qq-official.ts';
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
export const AGENT_VERSION = '0.1.0-beta.6';
/** 事件形状版本（docs/schema.md） */
export const SCHEMA_VERSION = '1';
export const DEFAULT_DATA_DIR_NAME = 'data';

export type SessionEndReason = 'shutdown' | 'error' | 'signal';

// ──────────────────────────────── 对外类型 ────────────────────────────────

export interface MainOptions {
  /** 数据目录；缺省取 IRMIA_DATA_DIR，再退到 <cwd>/data */
  dataDir?: string;
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

/** 启动摘要：水位/待办/定时器/锁是无人值守场景最先要确认的四件事 */
export function renderStartupSummary(input: {
  dataDir: string;
  recovery: RecoverResult;
  timers: TimerStore;
  startTurn: number;
  mode: 'real' | 'fake';
  persona: PersonaAssets;
}): string {
  const { dataDir, recovery, timers, startTurn, mode, persona } = input;
  const p = recovery.projection;
  const lines: string[] = [
    '=== Irmia Agent 启动摘要 ===',
    `数据目录: ${dataDir}`,
    `循环模式: ${mode === 'real' ? '真循环（已配置模型）' : '假循环（未配置 API key，仅写事件不调模型）'}`,
    `人格: ${persona.isSeed ? '种子模板未填写（去 data/persona/ 填 IDENTITY.md）' : '已加载'}（hash ${persona.personaHash}）`,
    `事件日志: 最大 seq ${p.lastSeq} / 分片 ${recovery.log.shardFiles.length} 个`,
    `水位: ${p.watermark} / 待办 ${p.pending.length} 条 / 定时器 ${timers.list().length} 个（在途句柄 ${timers.armedCount()}）`,
    `未闭合 turn: ${p.openTurn === null ? '无' : `#${p.openTurn.turn}（本次恢复已结算）`}`,
    `下一轮 turn 号: ${startTurn + 1}`,
    `锁: 持有 pid ${recovery.lock.pid}（startedAt ${recovery.lock.startedAt}）`,
  ];
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
 */
function mcpReloadNoteOf(change: McpDeclarationChange, totalAfter: number): string {
  const total = totalAfter === 0 ? '现在一个都没有了' : `现在一共 ${totalAfter} 个`;
  return [
    `config.json 里的 MCP 声明改了（改动当场生效，不用重启）：${describeMcpDeclChange(change, 'sentence')}`,
    `${total}。要看工具清单就用 \`mcp\` 工具（不带 server 看有哪些 server）。`,
    '⚠️ 你上下文里那份 **MCP 常驻索引不会立刻跟着变**——它保持原样，等下一次上下文重大变化'
      + '（压缩 / reset）或下次启动时才归集。所以这份通报是**追加在末尾**的：'
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

export async function runMain(options: MainOptions = {}): Promise<MainHandle> {
  const write = options.out ?? ((line: string) => {
    console.log(line);
  });
  const now = options.now ?? (() => new Date());
  const dataDir = options.dataDir
    ?? process.env['IRMIA_DATA_DIR']
    ?? join(process.cwd(), DEFAULT_DATA_DIR_NAME);
  // 先把"指到文件上"这种错抓出来，别让它变成一句 `EEXIST: file already exists, mkdir
  // '…\config.json'`——那个报错只说"已经存在"，完全看不出根因是"我把一个文件当目录用了"，
  // 排查的人会以为代码有 bug（真发生过一次：一个冒烟脚本把 dataDir 指到了 config.json）。
  if (existsSync(dataDir) && !statSync(dataDir).isDirectory()) {
    throw new Error(`数据目录指向了一个文件：${dataDir}——它应该是一个目录（检查 --data-dir / IRMIA_DATA_DIR）`);
  }
  mkdirSync(dataDir, { recursive: true });

  // 配置与人格：先加载配置（configHash 是 render 三指纹之一），再确保人格种子并加载
  const loadedConfig = await loadConfig(process.cwd());
  const config = loadedConfig.config;
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

  const recovery = await recover(
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

  // 启动异常退出告警（design §4.9 触发点首条）：recover 的补偿清单里出现 interrupted 结算即发一条。
  // 告警失败绝不拦启动——它是观测，不是启动的前置条件。
  try {
    const receipt = await notifyStartupRecovery(notifier, {
      repairs: recovery.repairs,
      dataDir,
      pid: process.pid,
    });
    if (receipt !== null) {
      write(receipt.ok
        ? '[告警] 上一次运行异常退出：启动告警已发出（详见 alarms/，warn 级）'
        : `[告警] 上一次运行异常退出，但启动告警未送达：${receipt.reason}`);
    }
  } catch (err) {
    write(`[告警] 启动告警发送异常（不拦启动）：${describeError(err)}`);
  }

  // ── 唤醒事件落库口与循环（有 API key 真循环，无则假循环降级） ──
  const startTurn = await maxTurnOfLog(log);
  const apiKey = readApiKey(config.models.heavy, process.env, config.dataDir, 'heavy');
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
  const mcpPool = new McpClientPool({
    servers: config.mcp.servers,
    // 生命周期事件落 mcp/server-started / mcp/server-stopped（internal）：
    // 界面「扩展 → MCP」的运行期状态就是从这两条折出来的（mcpView）
    //
    // 可见性走**同一处判据**（不是手写的字面量）：这几条今天在表里都是 internal，所以这里
    // 显式写 `internal` 是对的；而哪天有人把其中一条改成 `model`，这一处会**当场抛**，
    // 逼他回来回答"这条到底进不进上下文"——而不是让它静默留在 internal（那正是
    // `vision_read` / `speak` 那两个洞的形状，见 resolveEventVisibility 的注释）。
    emit: (type, data) => { append(type, data, resolveEventVisibility(type, 'internal')); },
    dataDir,
    onLog: (line) => { write(`[MCP] ${line}`); },
    // 两格池级参数（2026-10-10 接线，出厂值在 config.ts 的 mcp 段）：
    //   · maxInFlight = **整池**在飞上限（超限如实拒绝、不排队；极多 server + 子代理并发时往上调，
    //     逐 server 那一格管的是"别把同一个 server 打爆"，这一格管"别同时拉起 N 个别人的进程"）；
    //   · rssSample = 是否采那个进程的 RSS（关掉后 /api/mcp 那几格如实留空；环境变量
    //     IRMIA_MCP_RSS_SAMPLE 比它优先，见 client.ts 的 resolveRssSampler）。
    maxInFlight: config.mcp.maxInFlight,
    rssSample: config.mcp.rssSample,
  });
  mcpPoolRef.pool = mcpPool;
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
    configDir: process.cwd(),
    initial: loadedConfig,
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
        const declChange = await mcpPool.applyDeclarations(config.mcp.servers);
        const touched = declChange.added.length + declChange.removed.length + declChange.changed.length;
        if (touched === 0) {
          // 走到这里只有一种情形：`mcp.servers` 这个字段变了、但**每个 server 的内容都没变**
          // （例如只调了数组里的次序）。按 web 侧同一把尺子"没改动就不叫她"。
          write('[MCP] 声明面变了但每个 server 的内容都一样（多半只调了次序）：不重连、不通报');
          return;
        }
        const note = mcpReloadNoteOf(declChange, config.mcp.servers.length);
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
      baseUrl: config.models.heavy.baseUrl,
      apiKey,
      heavyModel: config.models.heavy.model,
      lightModel: config.models.light.model,
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
    const workspaceRoot = join(dataDir, 'workspace');
    mkdirSync(workspaceRoot, { recursive: true });

    // 执行点钩子（design §4.19）：配置在 data/hooks.json，对 agent 只读——
    // 它定义的是「谁能改我」，所以写入口按 protectedHookPaths 拒绝（见 catalog 的 protectedPaths）。
    // 单条非法只跳过它自己并报出来：一条写错的钩子不该拦住整个进程启动。
    const hookConfig = loadHookConfig(hookConfigPath(dataDir));
    for (const problem of hookConfig.problems) write(`[Hook] 配置条目被跳过：${problem}`);
    // enabled: false 的条目保留在文件里但不装配：GUI 的开关就是"临时停用一条钩子"，
    // 与"删掉这条钩子"是两件事（前者把命令行留着，后者要重新拼一遍）。
    const hookEntries = hookConfig.entries.filter((entry) => entry.enabled !== false);
    const hookDisabled = hookConfig.entries.length - hookEntries.length;
    const hooks = new HookRunner({
      entries: hookEntries,
      emit: (fired) => { emit('hook/fired', { hook: fired.hook, outcome: fired.outcome }); },
      onNote: (text) => { write(`[Hook] ${text}`); },
      // 投影摘要是活数据：每次 fork 前现取，不缓存（钩子看到的必须当时那一刻的事实）
      digest: () => digestProjection(recovery.projection),
    });
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
    const visionClient = {
      generate: async (request: unknown) => ds.generate(request as Parameters<DsClient['generate']>[0]),
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
      // 她自己在这个会话里说过的话（2026-10-04 用户："read channel 返回的结果里应该包含 bot
      // 自己的 speak"）。同一个循环层的口——它读的是 speak 的投递回执，工具层不碰日志。
      channelSpokenReader: async (sid) => await realLoopRef.current?.readChannelSpoken(sid) ?? [],
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
    // 工具开关（设置界面的禁用名单）：从配置装载到内存注册表。关掉的工具不进模型请求，
    // 界面仍列得出来（显示为关闭态）——名单外的名字由 setDisabled 自己忽略
    registry.setDisabled(config.tools.disabled);
    // 单件工具注册失败必须说出来：静默少一件能力，比启动失败更难查（§4.18 的描述预算）
    for (const problem of catalog.problems) write(`[工具] 未注册（已跳过）：${problem}`);

    // 技能系统（design §4.19）：技能根是项目级资产（skills/、.agents/skills/，与 workspace/ 同级），
    // 工具白名单根同为 cwd，所以模型能用 safe_read 自己读 SKILL.md 正文（渐进披露第二层）。
    // 只有过了信任门（skill/installed{by:'human'}）的 skill 才进 catalog——启动时把话说清楚。
    const skills = new SkillManager({
      baseRoot: process.cwd(),
      out: write,
      emit: (type, data, visibility) => {
        append(type, data, visibility);
      },
    });
    for (const line of skills.startupWarnings()) write(line);

    loop = new RealLoop({
      log, dataDir, projection: recovery.projection, now,
      timezone: config.timezone ?? 'Asia/Shanghai',
      ds, registry, persona, config, out: write,
      // 同一个告警实例：启动告警刚写下的 alarm/sent 就是它的限流窗口起点
      notifier,
      skills,
      // 执行点钩子（§4.19）：三个执行点一次装配全部生效（工具两点走执行器，Wake 走循环）
      hooks,
      // 每日记忆整理（design §4.17）：布防与 payload 识别都读这张表
      timers,
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
      timers,
      now,
      ...(toolRegistry !== undefined ? { registry: toolRegistry } : {}),
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
  } catch (err) {
    write(`[界面] 本地服务启动失败（不拦启动）：${describeError(err)}`);
  }

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
   */
  const onChannelMessage = (data: WakeChannel['data']): void => {
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

  if (qqChannel !== null) {
    qqChannel.onMessage = onChannelMessage;
  }
  if (onebotChannel !== null) {
    onebotChannel.onMessage = onChannelMessage;
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

  write(renderStartupSummary({ dataDir, recovery, timers, startTurn, mode: apiKey !== null ? 'real' : 'fake', persona }));
  if (backfilled > 0) {
    write(`[唤醒源/timer] 补记 ${backfilled} 条恢复期已触发的定时器（wake/timer 已入队）`);
  }

  // ── 退出 ──
  let stopping = false;
  const signalHandlers: Array<{ signal: NodeJS.Signals; handler: (signal: NodeJS.Signals) => void }> = [];

  const stop = async (reason: SessionEndReason = 'shutdown', detail?: string): Promise<void> => {
    if (stopping) return;
    stopping = true;

    for (const entry of signalHandlers) process.off(entry.signal, entry.handler);
    signalHandlers.length = 0;

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
    // 配置热重载：先撤监听（fs.watch 与那路 250ms 轮询），再做后面那些收尾
    // ——退出过程中不该再有"配置变了 ⇒ 重连一个 MCP server"，那会与下面的池关机打起来。
    configWatcher.stop();
    loop.stop();

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
  loop.start();
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

export async function main(): Promise<number> {
  try {
    activeHandle = await runMain();
    // 句柄持有锁与日志：保留引用，等信号处理器调用 stop
    void activeHandle;
    return 0;
  } catch (err) {
    process.stderr.write(`[致命] 启动失败：${describeError(err)}\n`);
    return 1;
  }
}

function isDirectRun(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return moduleUrl === pathToFileURL(entry).href;
}

if (isDirectRun(import.meta.url)) {
  void main().then((code) => {
    // 正常路径下进程由信号处理器 exit；只有启动失败才走到这里
    if (code !== 0) process.exit(code);
  });
}
