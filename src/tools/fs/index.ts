/**
 * Irmia Agent — 文件系工具包入口
 *
 * 对外只有一个注册函数：`fsTools(registry)`。**七件常驻 + 两件条件注册**：
 * `rg_search` 与 `es_search` 各自探测到引擎才被造出来（v30：rg 也改成条件注册了，
 * 它原先的"TS 逐行扫描降级"已经删掉，理由见 search-tools.ts 的文件头）。
 * v42 删掉了 `list_dir`（常驻八件 → 七件），列目录并进 `safe_read`（传目录即列目录）。
 *
 * 注册前做一遍契约自检（design.md §4.18「工具设计五原则」中可机械校验的部分）：
 *   • name 非空且在本次注册内唯一；
 *   • timeoutMs 为正——没有超时的工具在无人值守下是挂起隐患（schema §10）；
 *   • sideEffect 只允许 none / idempotent / destructive；
 *   • 描述长度受控：整份清单随每次请求发送，工具描述超预算即拒绝注册。
 *
 * 用法：
 *   const registry = { register(tool) { map.set(tool.name, tool); } };
 *   await fsTools(registry, {}, {}, { deps });
 */

import { createEnv, type FsEnv } from './env.ts';
import {
  createMultiEditTool,
  createSafeEditTool,
  createSafeRollbackTool,
  createSafeWriteTool,
} from './edit-tools.ts';
import { createReadBlobTool, createSafeReadTool } from './read-tools.ts';
import { createEsSearchTool, createRgSearchTool, searchGateOf, type SearchEngineGate } from './search-tools.ts';
import { estimateTokens, MAX_DESCRIPTION_TOKENS } from '../registry.ts';
import type { DepsManager, DepName } from '../../deps/manager.ts';
import type { FsToolDeps, FsToolOptions, ToolDefinition, ToolRegistryLike } from './types.ts';

export * from './types.ts';
export { createEnv, resolveGuarded, runProcessDefault, DEFAULT_READ_ONLY_PREFIXES, type FsEnv } from './env.ts';
export {
  BLOB_DIR_NAME,
  BLOB_ID_PATTERN,
  DIR_DEPTH_DEFAULT,
  DIR_DEPTH_MAX,
  DIR_DEPTH_MIN,
  DIR_ENTRIES_DEFAULT,
  DIR_ENTRIES_MAX,
  createReadBlobTool,
  createSafeReadTool,
  renderDirectoryListing,
  type DirListing,
  type DirListingOptions,
} from './read-tools.ts';
export { ENGINE_LINE_PREFIX, createEsSearchTool, createRgSearchTool, searchGateOf, type SearchEngineGate } from './search-tools.ts';
export {
  atomicWrite,
  fuzzyMatch,
  guardedWrite,
  parseEditRequest,
  stripLineNumberPrefixes,
  planEdit,
  type EditMode,
  type EditRequest,
  type MatchLocation,
  type PlanResult,
  type WriteTarget,
} from './edit-core.ts';
export {
  createMultiEditTool,
  createSafeEditTool,
  createSafeRollbackTool,
  createSafeWriteTool,
} from './edit-tools.ts';
export {
  backupDirFor,
  createBackup,
  listBackups,
  readBackup,
  type BackupEntry,
  type BackupRecord,
} from './backup.ts';
export { comparisonKey, expandAliases, firstSegmentOf, isInside, resolveInsideRoot, type GuardResult, type PathAlias } from './path-guard.ts';
export {
  DEFAULT_SKIP_DIRS,
  buildGlobFilter,
  buildMatcher,
  readDirEntries,
  walkFiles,
  type WalkEntry,
  type WalkStats,
} from './search-core.ts';
export { checkSyntax, describeVerdict, type SyntaxVerdict } from './syntax-check.ts';
export {
  compactTimestamp,
  decodeText,
  encodeText,
  globToRegExp,
  joinLines,
  looksBinary,
  positionAt,
  previewLine,
  sha256Hex,
  splitLines,
  withLineNumbers,
  type DecodedText,
  type DetectedEncoding,
  type Eol,
  type SplitText,
} from './text-codec.ts';

/** 描述预算口径与 tools/registry.ts 共用同一实现，不另立一套（design.md §4.18） */
export { estimateTokens, MAX_DESCRIPTION_TOKENS };

export interface BuildFsToolsOptions {
  /**
   * 外部依赖管理器（**探测只做一次**的来源）。给了它，两件搜索工具注册与否
   * 就照框架的那份缓存结论；不传则由本函数临时造一个（CLI 窄路径与单测）。
   *
   * 为什么不是"直接 import 一个全局单例"：那样测试之间会互相污染，
   * 而"这台机器有没有 rg"恰好是测试最需要控制的一件事（绝不能让用例依赖本机装没装）。
   */
  deps?: DepsManager | undefined;
  /**
   * 不可用依赖的如实告知出口（启动日志）。**工具不注册不等于可以无声无息**：
   * 用户点名要"保留没有时如实告知"——注册层面拿掉它，日志与 GUI 上必须说清为什么。
   */
  onNote?: ((message: string) => void) | undefined;
}

/** 让 FS 包的装配与 tools/catalog.ts 的 options 形状兼容（不侵入后者的字段） */
type FsBuildInput = FsToolOptions & BuildFsToolsOptions;

/**
 * 装配文件系工具。
 *
 * 两件搜索工具的注册都取决于**框架的依赖探测结论**（`src/deps/`，一次探测、结论缓存）：
 *   · rg_search：没装 ripgrep 就不注册（v30 删掉了它的 TS 降级链）；
 *   · es_search：没装 es.exe 就不注册（v27 起就这么做）。
 * 两者的 handler 拿的是同一份结论里认定的可执行文件，所以"注册了但一调就失败"
 * 这种自相矛盾不会发生。
 *
 * 探测代价只在**第一次**付：结论缓存在 DepsManager 里，rg 与 es 各探一次，
 * 建注册表的次数（启动两处 + CLI 重建）不再乘上候选数。
 */
export async function buildFsTools(
  options: FsBuildInput = {},
  deps: Partial<FsToolDeps> = {},
): Promise<ToolDefinition[]> {
  const env: FsEnv = createEnv(options, deps);
  const manager = options.deps ?? await defaultDepsManager(options);
  const note = options.onNote ?? ((): void => undefined);

  // 生效的路径别名也要能被人**一眼核对**（与"条件注册的工具不出现时必须如实告知"同一条纪律）：
  // 别名靠"主根优先"判定，所以唯一会让它失效的情形是**主根下后来真的建了同名目录**——
  // 把表打出来，人对着目录看一眼就知道有没有这种事。这里只说表本身（相对数据目录），
  // 不猜 workspaceRoot：真实的解析永远用调用时的 ctx.workspaceRoot。
  note(`[工具] 路径别名：${
    env.pathAliases({ workspaceRoot: process.cwd() })
      .map((alias) => `${alias.prefix}/ → ${alias.root}`)
      .join(' · ')
  }`);

  const [rgProbe, esProbe] = await Promise.all([manager.get('rg'), manager.get('es')]);
  const rgGate: SearchEngineGate = searchGateOf(
    { ok: rgProbe.status === 'ready', path: rgProbe.path, version: rgProbe.version, reason: rgProbe.reason },
    'ripgrep',
  );
  const esGate: SearchEngineGate = searchGateOf(
    { ok: esProbe.status === 'ready', path: esProbe.path, version: esProbe.version, reason: esProbe.reason },
    'es',
  );

  const tools: ToolDefinition[] = [createSafeReadTool(env)];
  if (rgGate.available) {
    tools.push(createRgSearchTool(env, rgGate));
    note(`[工具] rg_search 已注册（引擎 ${rgGate.command}，${rgGate.label}）`);
  } else {
    note(`[工具] rg_search 未注册：${rgProbe.reason}`);
  }
  if (esGate.available) {
    tools.push(createEsSearchTool(env, esGate));
    note(`[工具] es_search 已注册（引擎 ${esGate.command}，${esGate.label}）`);
  } else {
    note(`[工具] es_search 未注册：${esProbe.reason}`);
  }
  tools.push(
    createReadBlobTool(env),
    createSafeEditTool(env),
    createSafeWriteTool(env),
    createSafeRollbackTool(env),
    createMultiEditTool(env),
  );
  return tools;
}

/**
 * 没注入管理器时的兜底：临时造一个。
 * 它的探测是**惰性的**（构造不发进程），走到 `get()` 才真探——CLI 的窄路径也就能白拿一份缓存。
 * 旧字段 `ripgrepPath` / `everythingPath` 从这里透传进管理器，语义不变
 * （`null` = 显式禁用，字符串 = 指定路径，`undefined` = 自动探测）。
 */
async function defaultDepsManager(options: FsBuildInput): Promise<DepsManager> {
  const { DepsManager: Manager } = await import('../../deps/manager.ts');
  return new Manager({
    // 兜底管理器只服务"没注入管理器"的窄路径：dataDir 缺省时用进程 cwd 下的 data
    dataDir: options.dataDir ?? process.cwd(),
    ...(options.ripgrepPath === undefined ? {} : { ripgrepPath: options.ripgrepPath }),
    ...(options.everythingPath === undefined ? {} : { everythingPath: options.everythingPath }),
  });
}

export interface RegisterOptions {
  /** 为 false 时只注册只读工具（destructive 默认关闭，见 design.md §4.10 第 3 条） */
  enableDestructive?: boolean;
}

/**
 * 把文件系工具注册进宿主注册表，返回实际注册的工具（便于调用方记录与断言）。
 * 任一工具违反契约就抛错——宁可启动失败，也不注册一个不该存在的工具。
 *
 * async 是两件搜索工具的条件注册带来的（见 buildFsTools）：调用方本来就都在 async 上下文里，
 * 而"注册表里到底有几件工具"这件事必须等探测落地才成立。
 */
export async function fsTools(
  registry: ToolRegistryLike,
  options: FsBuildInput = {},
  deps: Partial<FsToolDeps> = {},
  registerOptions: RegisterOptions = {},
): Promise<ToolDefinition[]> {
  const enableDestructive = registerOptions.enableDestructive ?? true;
  const tools = await buildFsTools(options, deps);
  const seen = new Set<string>();
  const registered: ToolDefinition[] = [];

  for (const tool of tools) {
    if (tool.name === '') throw new Error('fsTools: 存在 name 为空的工具定义');
    if (seen.has(tool.name)) throw new Error(`fsTools: 工具名重复：${tool.name}`);
    seen.add(tool.name);
    if (!Number.isFinite(tool.timeoutMs) || tool.timeoutMs <= 0) {
      throw new Error(`fsTools: ${tool.name} 的 timeoutMs 必须是正数（schema §10：无超时等于挂起隐患）`);
    }
    if (tool.sideEffect !== 'none' && tool.sideEffect !== 'idempotent' && tool.sideEffect !== 'destructive') {
      throw new Error(`fsTools: ${tool.name} 的 sideEffect 非法：${String(tool.sideEffect)}`);
    }
    if (tool.executionMode !== 'parallel' && tool.executionMode !== 'exclusive') {
      throw new Error(`fsTools: ${tool.name} 的 executionMode 非法：${String(tool.executionMode)}`);
    }
    if (tool.description.length > MAX_DESCRIPTION_TOKENS * 4) {
      // 粗筛：中英混排下 4 字符/token 已是宽松上界，真正判定在下面按 estimateTokens 做
      throw new Error(`fsTools: ${tool.name} 描述长度异常（${tool.description.length} 字符）`);
    }
    const tokens = estimateTokens(tool.description);
    if (tokens > MAX_DESCRIPTION_TOKENS) {
      throw new Error(
        `fsTools: ${tool.name} 的描述估算 ${tokens} token，超过 ${MAX_DESCRIPTION_TOKENS} token 预算（§4.18 token 成本审查）`,
      );
    }
    if (!enableDestructive && tool.sideEffect === 'destructive') continue;
    registry.register(tool);
    registered.push(tool);
  }

  return registered;
}
