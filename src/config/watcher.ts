/**
 * Irmia Agent — 配置热重载（docs/operations.md §1、docs/milestones.md M6-1）
 *
 * §1 的五个防护参数逐条落地，一个都不少：
 *   • FileWatcher 监听 `config.json` —— **600ms 去抖**（编辑器连存只算一次变更）；
 *   • 两次重载间隔 **≥1s** —— 保存风暴不会把重载叠成并发 IO；
 *   • 单次重载 **20s 超时** —— 慢盘/坏盘不能把重载任务永远挂住；
 *   • **互斥锁串行** —— 一次只跑一个重载，重载期间到达的变化排队而不是并发；
 *   • **单回调异常隔离** —— 一个订阅者抛错不影响其余订阅者，也不影响本次生效流程。
 *
 * 热更白名单（§1 表格左列）以点路径前缀表达；**不在白名单内的一律按「必须重启」处理**：
 * 运行中的实例绝不能因为一次手误把 `dataDir` 切到别处——那会造出两份并行事实。
 * 需要重启的字段只写 `warnings`（提示重启），**不写 `config/changed`**：
 * 那个事件的含义是「已生效」，写它就必须真的生效了。
 *
 * 名单现在**只有一项**：`mcp.servers`（2026-10-10 加，MCP 声明面热更）。
 * 为什么是它、代价是什么、为什么失败能全身而退，逐条写在 `HOT_RELOAD_FIELDS` 的注释里。
 * 生效方式有一条与"换一份新配置"不同的地方，见 `applyHotFieldsInPlace`：**就地改活的
 * `AppConfig`**（引用它的消费者包括 `RealLoop` 与 `WebServer`，换对象等于它们继续读旧的）。
 *
 * 事件化（§1）：生效后写 `config/changed { fields, configHash }`（internal）。
 * `configHash` 取的是**生效配置**的指纹（热更字段已并入、需重启字段保持旧值），
 * 于是它与 renderVersion、personaHash 一起仍然是 render 的唯一输入指纹。
 *
 * 加载失败的处置（与 config.ts 的教义一致）：坏配置**不改变生效状态**——
 * 运行中的实例继续按上一份好配置跑，只留一行诊断。绝不把一次手误变成"配置看起来生效了
 * 但其实是默认值"的隐形故障，也绝不因此让常驻进程停摆。
 *
 * 约定：值导入写 `.ts`（Node 的 --experimental-strip-types 只擦类型、不改写路径解析），
 * 纯类型导入写 `.js`。
 */

import { statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { AppConfig, LoadedConfig } from './config.js';
import type { Visibility } from '../log/types.js';
import { CONFIG_FILE_NAME, configHash, loadConfig } from './config.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 防抖窗口（毫秒）：operations.md §1「600ms 去抖」 */
export const CONFIG_DEBOUNCE_MS = 600;
/** 两次重载的最小间隔（毫秒）：§1「两次重载间隔 ≥1s」 */
export const CONFIG_MIN_RELOAD_INTERVAL_MS = 1_000;
/** 单次重载超时（毫秒）：§1「单次重载 20s 超时」 */
export const CONFIG_RELOAD_TIMEOUT_MS = 20_000;
/**
 * 轮询兜底间隔（毫秒）。fs.watch 在 Windows 上对「临时文件 → rename 覆盖」这类原子写
 * 不保证每次都给事件（被监听的 inode 已经换掉了），而本系统的配置写回正是原子写。
 * 所以除 fs.watch 外再加一路 mtime+size 签名的低频轮询：宁可多一次 stat，不可漏一次改动。
 */
export const CONFIG_POLL_INTERVAL_MS = 250;

/**
 * 可热更字段（operations.md §1 表格左列）：带尾点的是前缀，不带的是整字段。
 *
 * ⚠️ **2026-10-04 清空 → 2026-10-10 只放回一项 `mcp.servers`**。这份名单的来历值得读完再改：
 * 它曾经写着 `budget.` / `wake.` / `alerts.` / `models.` / `tools.destructiveEnabled`，但
 * **热更从来没有接进主进程**——`main.ts` 只在启动时 `loadConfig` 一次，`ConfigWatcher`
 * 在整个仓库里没有任何调用方。于是"改了立刻生效"这句话在界面上、在文档里都说了好几天，
 * 实际上一次都没发生过（用户报的「保存后弹回旧值」就是这个）。所以在 2026-10-04 被**清空**，
 * 口径改成"全部字段都要重启才生效"，等用户拍板那个取舍。
 *
 * **为什么现在只放回 `mcp.servers` 一项**（用户 2026-10-10 的原话：「配置的 mcp 不能热加载吗？」）
 * ——取舍不是"顺手"，它逐条对着下面三件事判过：
 *
 *   ① **代价是实的、而且必须写在明处**：`configHash` 是 render 的**三指纹之一**
 *      （与 `RENDER_VERSION`、`personaHash` 并列，见 `config.ts` 的 `configHash` 与
 *      docs/context-audit.md）。而这一段（`mcp.servers`）**不进提示词的那一格**：
 *      进上下文的是 **MCP 常驻索引**，它按既有快照机制**在重大变化点归集**
 *      （`real-loop.mcpIndexSync` 的三个触发点：首次 / 模板换代 / `compaction/summary` 之后），
 *      **不是**每次配置改动都重建。所以这一项热更**不会**改请求前缀的字节
 *      ——"声明变了"这件事走的是**尾部追加的通报**（`wake/manual{via:'mcp'}`），与用户定的
 *      「追加在末，固定位置，直到上下文重大变化时归集」逐字对齐。
 *      ⚠️ 但**仍然至少有一次失配**：`configHash` 一变，凡是拿它当输入指纹的地方
 *      （`replay` 的指纹比对、`/api/config` 的 `x-config-hash`、诊断）都会看到"换了一份配置"。
 *      那是**设计内**的代价，不是 bug：指纹的全部意义就是"配置变了要看得出来"。
 *      别为了让指纹保持不变而把这几个字段排除在 `AppConfig` 之外——那会让记录与事实脱钩。
 *   ② **失败要能全身而退**：这一段的解析（`parseMcpServers` + 启动器白名单）**全在
 *      `loadConfig` 里**（`readMcpConfig`）。所以"写坏了"这件事的处置不是"池里出现半份坏声明"，
 *      而是**那份配置根本进不来**：`reloadOnce` 的 catch 保留旧配置继续跑，只留一行诊断
 *      （见文件头「加载失败的处置」）。放行口缺失（`mcp.extraLaunchers` 没写、环境变量也没设）
 *      同样在这一层被挡下 ⇒ 不会有一个"半生效"的中间态。
 *   ③ **粒度按 server 算**：`mergeHotFields` 只负责把这一项换进生效配置；**只重连真变了的那几个**
 *      server 是池的事（`McpClientPool.applyDeclarations`）。热更不该把另一个 server 正在飞的
 *      调用打断，也不该把它的运维账清成零。
 *
 * **刻意没放回来的**：`budget.` / `wake.` / `alerts.` / `models.` / `tools.*`。
 * 它们每一个都要单独回答"改了这一格，请求前缀的哪一段字节会变"（`budget` 那几个进提示词与
 * 压缩预算、`wake` 那几个是循环构造参数、`tools.*` 是**工具装配参数**——工具清单一变就是一次
 * 全 miss ≈9.6 万 token）。`mcp.servers` 之所以能先来，正是因为它**不在**那条路上（见 ①）。
 * 填一项就得有一项的证据：别在改这一行时顺手把别的东西一起放进来。
 */
export const HOT_RELOAD_FIELDS: readonly string[] = ['mcp.servers'];

/**
 * 必须重启才生效（§1 表格右列）。`timezone` / `paths` / `persona` 未列入可热更白名单，
 * 按「只有不改变进程结构的配置允许热更」的保守规则同样归此列：它们的解释基准
 * （跨天记账口径、执行器路径解析、压缩预算）不在一拍之内随便改。
 */
export const RESTART_REQUIRED_FIELDS: readonly string[] = [
  'dataDir', // 数据目录路径
  'schemaVersion', // 事件/配置 schema 版本
  'timezone', // "今日"与告警窗口的解释基准
  'paths.', // 工作目录白名单（执行器的解析基准）
  'persona.', // 人格连续性与上下文压缩预算
];

// ──────────────────────────────── 字段分类 ────────────────────────────────

/** 字段归类：hot = 立刻生效；restart = 需重启（含未列白名单者）；unknown = 未知字段（按 restart 处理） */
export type ConfigFieldClass = 'hot' | 'restart' | 'unknown';

function matchesAny(field: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith('.')) {
      if (field.startsWith(pattern)) return true;
    } else if (field === pattern) {
      return true;
    }
  }
  return false;
}

/** 单个字段路径（如 `budget.softRatio`）的归类 */
export function classifyConfigField(field: string): ConfigFieldClass {
  if (matchesAny(field, HOT_RELOAD_FIELDS)) return 'hot';
  if (matchesAny(field, RESTART_REQUIRED_FIELDS)) return 'restart';
  return 'unknown';
}

// ──────────────────────────────── 差异计算 ────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 归一化比较口径：undefined 与"键不存在"视为同一种事实 */
function sameValue(a: unknown, b: unknown): boolean {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!sameValue(a[key], b[key])) return false;
    }
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * 递归求点路径差异（键序无关，数组整体算一个字段）。
 * 只报告"真的变了"的路径——同一份文件重复保存不产生任何差异，于是不写事件、不通知订阅者。
 */
export function diffConfigFields(before: unknown, after: unknown, prefix = ''): string[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const out: string[] = [];
    for (const key of [...keys].sort()) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      const a = before[key];
      const b = after[key];
      if (isPlainObject(a) && isPlainObject(b)) {
        out.push(...diffConfigFields(a, b, path));
        continue;
      }
      if (!sameValue(a, b)) out.push(path);
    }
    return out;
  }
  return sameValue(before, after) ? [] : [prefix];
}

function readPath(source: unknown, path: string): unknown {
  let node: unknown = source;
  for (const key of path.split('.')) {
    if (!isPlainObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

/** 就地写路径；值为 undefined 时删键（"删掉这一行"也是合法的变更） */
function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys[keys.length - 1] as string;
  let node = target;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index] as string;
    const next = node[key];
    if (isPlainObject(next)) {
      node = next;
    } else {
      const created: Record<string, unknown> = {};
      node[key] = created;
      node = created;
    }
  }
  if (value === undefined) delete node[last];
  else node[last] = value;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 只把白名单内的字段并进生效配置：其余字段保持上一份生效值。
 * 于是"同时改了预算阈值与数据目录"这种输入也能拿到最大善意——预算立刻生效，目录等重启。
 */
export function mergeHotFields(
  current: AppConfig,
  next: AppConfig,
  hotFields: readonly string[],
): AppConfig {
  const merged = cloneJson(current) as unknown as Record<string, unknown>;
  for (const field of hotFields) writePath(merged, field, readPath(next, field));
  return merged as unknown as AppConfig;
}

/**
 * **就地**把白名单字段并进 `current`，并返回 `current` 自身（`reloadOnce` 用；2026-10-10 加）。
 *
 * 与 `mergeHotFields` 的差别只有一个词：**就地**。为什么非这样不可——
 * 活的 `AppConfig` 对象在装配期被**按引用**交给了别处（`main.ts` 把 `config` 递给
 * `RealLoop.config` 与 `startWebServer` 的 `deps.config`；`real-loop` 的 `deps.config` 是
 * `private readonly`，没有任何替换口）。所以"换一个新对象"这条路的效果是
 * **她与界面继续读旧配置**——那正是"保存后弹回旧值"那个老毛病的形状。
 * 就地改则一处改、处处见，不需要给每个消费者加一个 setter（加十个 setter 就多十处会漏的地方）。
 *
 * **为什么这里敢就地改**（这不是"随手可变状态"）：热更名单里的字段是**整字段替换**的
 * （`mcp.servers` 是数组、永远整体换），而被改的那一格在**同一拍**内没有第二个读者
 * ——调用方（`ConfigWatcher.reloadOnce`）在改完**立刻**通知订阅者，订阅者再去重建
 * 自己那份派生状态（池、索引、界面）。反过来，"先拷一份、改完再换引用"才是那个
 * 会漏掉引用持有者的写法。
 *
 * 两条硬纪律（与白名单那一段注释同源）：
 *   · **只动名单内的字段**：名单外的一律保持旧值（`readPath` 根本不会被调到它们）；
 *   · **数组就地改**（`splice`），不重新赋值 `current.mcp.servers = [...]`
 *     ——因为**有人可能已经抓住了这个数组**（`real-loop` 的索引视图、界面的快照）。
 *     整字段替换的语义没变（旧元素全清、新元素全进），变的是"抓住它的那些人还看得见"。
 */
export function applyHotFieldsInPlace(
  current: AppConfig,
  next: AppConfig,
  hotFields: readonly string[],
): AppConfig {
  const target = current as unknown as Record<string, unknown>;
  for (const field of hotFields) {
    const value = readPath(next, field);
    const existing = readPath(current, field);
    if (Array.isArray(existing) && Array.isArray(value)) {
      // 就地替换数组内容（见上面那条纪律）：先清空再逐个推入，元素的**引用**照旧是新的
      existing.splice(0, existing.length, ...value);
      continue;
    }
    writePath(target, field, cloneJson(value));
  }
  return current;
}

// ──────────────────────────────── 文件监听 ────────────────────────────────

export interface FileWatcherOptions {
  /** 被监听的文件绝对路径 */
  path: string;
  /** 变化回调（去抖之后） */
  onChange: () => void;
  /** 去抖窗口（毫秒），默认 CONFIG_DEBOUNCE_MS */
  debounceMs?: number;
  /** 轮询兜底间隔（毫秒），0 表示只靠 fs.watch；默认 CONFIG_POLL_INTERVAL_MS */
  pollMs?: number;
  /** 诊断输出 */
  onDebug?: (line: string) => void;
}

/**
 * 单文件的"变化了"信号（去抖后回调一次）。它只负责回答"文件动过没有"，
 * 不认识配置、不认识 JSON、不认识事件——解析与生效是 ConfigWatcher 的事。
 *
 * 两路信号合并：fs.watch 监听**父目录**（这样原子写的 rename 也能看到，
 * 且文件被替换后监听不会失效）+ 低频签名轮询兜底。见 CONFIG_POLL_INTERVAL_MS 的理由。
 */
export class FileWatcher {
  private readonly path: string;
  private readonly dir: string;
  private readonly name: string;
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private readonly onChange: () => void;
  private readonly onDebug: (line: string) => void;

  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private poll: NodeJS.Timeout | null = null;
  private signature = '';
  private started = false;

  constructor(options: FileWatcherOptions) {
    this.path = options.path;
    this.dir = dirname(options.path);
    this.name = basename(options.path);
    this.debounceMs = Math.max(0, options.debounceMs ?? CONFIG_DEBOUNCE_MS);
    this.pollMs = Math.max(0, options.pollMs ?? CONFIG_POLL_INTERVAL_MS);
    this.onChange = options.onChange;
    this.onDebug = options.onDebug ?? (() => undefined);
  }

  /** 当前是否已布防 */
  get watching(): boolean {
    return this.started;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // 记录基线：布防那一刻已有的状态不算"变化"，否则启动即触发一次重载
    this.signature = this.currentSignature();

    try {
      // persistent:false：监听不该阻止进程退出（测试与嵌入方共用同一份实现）
      const watcher = watch(this.dir, { persistent: false }, (_event, filename) => {
        // Windows 下 filename 可能是 null（无法定位具体文件）：宁可信其有
        if (filename === null || String(filename) === this.name) this.bump();
      });
      watcher.on('error', (err) => {
        this.onDebug(`[配置] 文件监听异常，退化为轮询兜底：${describe(err)}`);
        watcher.close();
        if (this.watcher === watcher) this.watcher = null;
      });
      this.watcher = watcher;
    } catch (err) {
      this.onDebug(`[配置] 无法监听目录 ${this.dir}，退化为轮询兜底：${describe(err)}`);
      this.watcher = null;
    }

    if (this.pollMs > 0) {
      this.poll = setInterval(() => {
        if (this.currentSignature() !== this.signature) this.bump();
      }, this.pollMs);
      // 轮询是长期存在的活跃源，必须 unref：它不该成为进程退不出去的理由
      this.poll.unref();
    }
  }

  stop(): void {
    this.started = false;
    if (this.watcher !== null) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.poll !== null) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }

  /** mtime+size+ino 签名：ino 参与判定是为了抓住"同一 mtime 的原子替换" */
  private currentSignature(): string {
    try {
      const stat = statSync(this.path);
      return `${stat.mtimeMs}:${stat.size}:${stat.ino ?? 0}`;
    } catch {
      return 'missing'; // 文件不存在也是事实：它出现在签名变化里，重载路径会自愈（写回默认配置）
    }
  }

  /** 一次变化信号：更新签名并重置去抖计时 */
  private bump(): void {
    this.signature = this.currentSignature();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.started) return;
      this.onChange();
    }, this.debounceMs);
  }
}

// ──────────────────────────────── 热重载 ────────────────────────────────

/** 一次重载的结局（无差异时不产生这个对象） */
export interface ConfigReloadOutcome {
  /** 是否真的热更生效（false = 只有需重启的字段变了，运行中的实例一字未动） */
  applied: boolean;
  /** 本次热更生效的字段路径 */
  fields: string[];
  /** 变了但需重启才生效的字段路径（本次未应用） */
  requiresRestart: string[];
  /** 人类可读警示（诊断输出里也会逐条出现） */
  warnings: string[];
  /** 当前生效配置的指纹 */
  configHash: string;
  /** 当前生效配置全量 */
  config: AppConfig;
}

/** 订阅者收到的变更事实（与 ConfigReloadOutcome 同源，附 config 供订阅者直接替换引用） */
export interface ConfigChange extends ConfigReloadOutcome {
  applied: true;
}

export type ConfigChangeListener = (change: ConfigChange) => void;

export interface ConfigWatcherOptions {
  /** 配置所在目录（config.json 的父目录，也是相对路径字段的解析基准） */
  configDir: string;
  /** 首次加载的结果（宿主已经加载过，watcher 不重复读盘） */
  initial: LoadedConfig;
  /** 事件写入口：生效后写 `config/changed`（internal） */
  emit: (type: string, data: unknown, visibility: Visibility) => void;
  /** 诊断输出 */
  out?: (line: string) => void;
  /** 时钟注入（重载间隔判定用） */
  now?: () => number;
  /** 去抖窗口覆盖点（测试用） */
  debounceMs?: number;
  /** 重载最小间隔覆盖点（测试用） */
  minIntervalMs?: number;
  /** 单次重载超时覆盖点（测试用） */
  reloadTimeoutMs?: number;
  /** 轮询兜底间隔覆盖点（测试用） */
  pollMs?: number;
  /** 加载函数覆盖点（测试注入慢加载/抛错）；默认 config.ts 的 loadConfig */
  load?: (dir: string) => Promise<LoadedConfig>;
}

/**
 * 配置热重载器。持有"当前生效配置"这一份事实，负责：
 * 监听 → 去抖 → 串行重载（含最小间隔与超时）→ 白名单过滤 → 事件化 → 通知订阅者。
 */
export class ConfigWatcher {
  private readonly configDir: string;
  private readonly emit: (type: string, data: unknown, visibility: Visibility) => void;
  private readonly write: (line: string) => void;
  private readonly nowMs: () => number;
  private readonly minIntervalMs: number;
  private readonly reloadTimeoutMs: number;
  private readonly load: (dir: string) => Promise<LoadedConfig>;
  private readonly files: FileWatcher;
  private readonly listeners = new Set<ConfigChangeListener>();

  /** 当前生效配置（热更已并入；需重启字段保持旧值） */
  private config: AppConfig;
  private hash: string;

  /** 互斥锁：所有重载走这一条串行链，任何时刻只有一个在跑 */
  private chain: Promise<unknown> = Promise.resolve();
  /** 已排入一次待跑的重载（去抖窗口内的多次变化合并成一次） */
  private pending = false;
  private lastReloadAtMs = 0;
  private stopped = false;

  constructor(options: ConfigWatcherOptions) {
    this.configDir = options.configDir;
    this.emit = options.emit;
    this.write = options.out ?? (() => undefined);
    this.nowMs = options.now ?? (() => Date.now());
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? CONFIG_MIN_RELOAD_INTERVAL_MS);
    this.reloadTimeoutMs = Math.max(1, options.reloadTimeoutMs ?? CONFIG_RELOAD_TIMEOUT_MS);
    this.load = options.load ?? ((dir: string) => loadConfig(dir));
    this.config = options.initial.config;
    this.hash = options.initial.configHash;
    const fileOptions: FileWatcherOptions = {
      path: joinConfigPath(this.configDir),
      onChange: () => this.queueReload('文件变化'),
      onDebug: this.write,
    };
    if (options.debounceMs !== undefined) fileOptions.debounceMs = options.debounceMs;
    if (options.pollMs !== undefined) fileOptions.pollMs = options.pollMs;
    this.files = new FileWatcher(fileOptions);
  }

  /** 当前生效配置 */
  get effectiveConfig(): AppConfig {
    return this.config;
  }

  /** 当前生效配置的指纹 */
  get effectiveHash(): string {
    return this.hash;
  }

  start(): void {
    this.files.start();
    this.write(`[配置] 已监听 ${joinConfigPath(this.configDir)}`
      + `（去抖 ${CONFIG_DEBOUNCE_MS}ms，重载间隔 ≥${Math.round(this.minIntervalMs / 1000)}s，`
      + `单次超时 ${Math.round(this.reloadTimeoutMs / 1000)}s）`);
  }

  stop(): void {
    this.stopped = true;
    this.files.stop();
  }

  /**
   * 订阅生效变更；返回退订函数。回调异常被隔离，不影响其他订阅者
   */
  subscribe(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * **这台实例上的热更接线是活的吗**（2026-10-11 加）：已启动 且 至少有一个订阅者。
   *
   * 为什么要这一格：有些回执要如实回答"这次改动**需要重启**吗"——而那个答案的字面意思
   * 就是"本进程里有没有人在配置变化之后把派生状态跟上"。判据只有这里一处，
   * 别让调用方各猜一遍（猜错的方向有两种，都很难查）：
   *   · 猜"不接线"（一律回 `restartRequired: true`）⇒ 热更明明生效了却让人去重启，
   *     正是用户报的那句"老是让用户手动帮忙"；
   *   · 猜"接线了"（一律回 false）⇒ 夹具 / 内嵌方没接的时候，回执会撒谎说"已生效"
   *     ——那比前者坏得多（`test/web-server.test.ts` 那批夹具正是这种形状）。
   *
   * 判据取"有没有订阅者"而不是"start() 过没有"：**把派生状态跟上**这件事就是订阅者干的
   * （`main.ts` 那一个订阅者负责池重建与通报），没人订阅的 watcher 会改生效配置、
   * 也会写 `config/changed`，但没有任何东西跟着动——那一刻说"已生效"是过头话。
   */
  get live(): boolean {
    return !this.stopped && this.listeners.size > 0;
  }

  /**
   * 立刻做一次重载（绕过去抖，但**不绕过**最小间隔与串行纪律）。
   * 返回 null 表示文件与生效配置没有差异。文件驱动的重载与手工/CLI/Web 通道走同一份逻辑。
   */
  async reloadNow(): Promise<ConfigReloadOutcome | null> {
    return await this.serialize(() => this.reloadOnce('手工重载'));
  }

  // ── 内部 ──

  /**
   * 串行链：前一个任务失败不影响后一个，返回值原样透传。
   * 这是"互斥锁串行"的实现——两个重载永远不会交叉读写 this.config。
   */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 收到一次变化信号：已排入则合并（去抖之外的第二次合并），否则排入串行链 */
  private queueReload(trigger: string): void {
    if (this.stopped || this.pending) return;
    this.pending = true;
    void this.serialize(async () => {
      // 开跑即清标记：重载期间到达的新变化可以再排一次（串行链保证它等在前一次之后）
      this.pending = false;
      await this.reloadOnce(trigger);
    }).catch((err: unknown) => {
      // 重载路径自身不该抛（内部已分类处理），兜底只为不留未处理的 rejection
      this.write(`[配置] 重载异常：${describe(err)}`);
    });
  }

  /** 单次重载：间隔纪律 → 超时保护的加载 → 白名单过滤 → 事件化 → 通知 */
  private async reloadOnce(trigger: string): Promise<ConfigReloadOutcome | null> {
    const waitMs = this.lastReloadAtMs + this.minIntervalMs - this.nowMs();
    if (waitMs > 0) await delay(waitMs);
    this.lastReloadAtMs = this.nowMs();

    let loaded: LoadedConfig;
    try {
      loaded = await withTimeout(
        this.load(this.configDir),
        this.reloadTimeoutMs,
        () => new Error(`重载超过 ${Math.round(this.reloadTimeoutMs / 1000)}s 未完成`),
      );
    } catch (err) {
      // 坏配置不改生效状态：继续按上一份好配置跑（见文件头）
      this.write(`[配置] ${trigger}触发的重载失败，继续用上一份生效配置：${describe(err)}`);
      return null;
    }

    const fields = diffConfigFields(this.config, loaded.config);
    if (fields.length === 0) return null;

    const hot = fields.filter((field) => classifyConfigField(field) === 'hot');
    const restart = fields.filter((field) => classifyConfigField(field) !== 'hot');
    const warnings: string[] = [];
    if (restart.length > 0) {
      warnings.push(`以下字段需要重启才生效（本次未应用）：${restart.join('、')}；改完请重启 Irmia 进程`);
    }

    if (hot.length === 0) {
      // 没有任何可热更字段：不写 config/changed（那个事件只描述"已生效"）
      this.write(`[配置] ${trigger}：未检测到可热更字段变化`);
      for (const warning of warnings) this.write(`[配置] ${warning}`);
      return {
        applied: false,
        fields: [],
        requiresRestart: restart,
        warnings,
        configHash: this.hash,
        config: this.config,
      };
    }

    // **就地**并入（不是换一个新对象）：活的 AppConfig 被按引用交给了 RealLoop 与 WebServer，
    // 换对象等于"她与界面继续读旧配置"。判据与两条纪律见 `applyHotFieldsInPlace` 的注释。
    const next = applyHotFieldsInPlace(this.config, loaded.config, hot);
    this.config = next;
    // 指纹取的是**生效配置**（热更字段已并入、需重启字段保持旧值）：所以它与
    // renderVersion、personaHash 一起仍然是 render 的唯一输入指纹。代价如实说：
    // 热更一次 ⇒ 这个指纹就变一次（**设计内**，见 HOT_RELOAD_FIELDS 注释的①）。
    this.hash = configHash(next);
    this.emit('config/changed', { fields: hot, configHash: this.hash }, 'internal');
    this.write(`[配置] ${trigger}：热更生效 ${hot.length} 项（${hot.join('、')}）`
      + `，configHash ${this.hash.slice(0, 8)}`);
    for (const warning of warnings) this.write(`[配置] ${warning}`);

    const change: ConfigChange = {
      applied: true,
      fields: hot,
      requiresRestart: restart,
      warnings,
      configHash: this.hash,
      config: next,
    };
    this.notify(change);
    return change;
  }

  /** 逐个通知，异常隔离：一个订阅者抛错不拦其他订阅者，也不回滚已生效的配置 */
  private notify(change: ConfigChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (err) {
        this.write(`[配置] 订阅者回调异常（已隔离，其余订阅者不受影响）：${describe(err)}`);
      }
    }
  }
}

// ──────────────────────────────── 工具 ────────────────────────────────

export function joinConfigPath(dir: string): string {
  return dir.endsWith(CONFIG_FILE_NAME) ? dir : join(dir, CONFIG_FILE_NAME);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 超时保护：超时按错误外抛（调用方决定是跳过还是重试），留下的悬挂 promise 不再被等待 */
async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(onTimeout());
    }, ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
