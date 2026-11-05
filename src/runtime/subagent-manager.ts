import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import type { AppConfig } from '../config/config.ts';
import {
  defaultVisibility, emptyProjection, type AppEvent, type AppEventType, type Projection, type SubagentStatus,
} from '../log/types.ts';
import type { DsClient } from '../model/ds-client.ts';
import { applyOne, applySubagentEvent } from '../state/fold.ts';
import type { ToolDefinition, ToolHandlerResult } from '../tools/types.ts';
import {
  argsRecord, errorResult, errorResultFromThrown, okResult, optionalBoolean, optionalString,
  requiredString, TOOL_ERROR_CODES, ToolArgumentError,
} from '../tools/types.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { BudgetGuard } from './budget-guard.ts';
import { childEventFilter } from './subagent.ts';
import { runTurn, type AgentLoopBudget, type AgentLoopDeps, type AgentLoopPersona } from './agent-loop.ts';
import { RENDER_VERSION } from '../model/render.ts';
import type { ToolModelSpec } from '../tools/registry.ts';
import {
  SubagentProfileRegistry, type SubagentProfile, type ProfileAvailability,
  DEFAULT_SUBAGENT_MAX_TURNS, MAX_SUBAGENT_MAX_TURNS,
} from './subagent-profiles.ts';
import { SubagentPackageInstaller } from './subagent-packages.ts';
import { healthcheckSubagentProfile } from './subagent-health.ts';
import { toolDenialClass } from './subagent-capabilities.ts';
import {
  compactCutoff, generateCompactSummary, readingForRequest, SUBAGENT_COMPACT_REQUIRED,
  SUBAGENT_CONTEXT_LIMIT, SUBAGENT_MAX_COMPACTS, summaryText,
  type SubagentCompactState,
} from './subagent-compaction.ts';
import type { ProfileReasoningEffort } from './subagent-profiles.js';
import { resolveAuthorizedProject, scopeToolToRoots } from './subagent-workspace.ts';
import { SubagentSkillRuntime } from './subagent-skills.ts';
import { createScopedPwshTool } from './subagent-shell.ts';
import { createCodeTool } from './subagent-code.ts';
import { createScreenshotTool } from './subagent-screenshot.ts';
import { SubagentMcpRuntime, type SubagentMcpOptions } from './subagent-mcp.ts';

export type SubagentProfileId = 'general' | 'researcher' | 'worker' | 'scribe';

export interface AgentSession {
  schema: 1;
  agentId: string;
  profileId: string;
  parentCallId: string;
  parentTurn: number;
  status: SubagentStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  turn: number;
  resumeCount: number;
  task: string;
  context: string;
  pendingMessages: string[];
  lastReport: string | null;
  /** P2 fork: parent prefix boundary (inclusive) and diagnostic hash. */
  forkFromSeq?: number;
  prefixHash?: string;
  headHash?: string;
  forkPrefixFile?: string;
  forkHeadFile?: string;
  tokens: {used: number; limit: number};
  workspace: string;
  /**
   * P3.2.1：本次激活（delegate 首次 + 每次 resume/续聊）最多跑多少轮。
   *
   * 为什么冻结在 session 上而不是每次现读 Profile：Profile 是数据文件，跑着的时候被人改了
   * 会让同一个会话的上限忽大忽小；resume/恢复必须按"创建时那份额度"继续。缺省（老会话）取
   * Profile 当前值。
   */
  maxTurns?: number;
  /**
   * P3.2.1：`'none'` = 这个 Profile 没有 workspace（文件工具拒绝、不创建目录）。
   * 缺省（P3.2 之前写下的会话）= `'own'`，与老行为逐字一致。
   */
  workspaceMode?: 'own' | 'none';
  /** P4.3：仅 project 类 Profile；只保存已授权且 realpath 后的根，不进公开 API。 */
  projectRoot?: string;
  /** P4.2：创建时冻结；老会话在第一次恢复时冻结一次，之后不再跟随 Profile 变化。 */
  reasoningEffort?: ProfileReasoningEffort;
  reasoningEffortApplied?: ProfileReasoningEffort | null;
  contextLimit?: number;
  compactAt?: number;
  compact?: SubagentCompactState;
  error: string | null;
}

export interface ForkHead {
  schema: 1;
  renderVersion: string;
  forkFromSeq: number;
  persona: AgentLoopPersona;
  tools: ToolModelSpec[];
  headHash: string;
}

export interface SubagentModelCapabilities {
  /** 当前 heavy provider 已确认的上下文 token 上限；null = 未确认。 */
  contextLimit: number | null;
  reasoningEfforts: readonly ProfileReasoningEffort[];
}

export interface SubagentManagerDeps {
  dataDir: string;
  log: import('../log/event-log.ts').EventLog;
  registry: ToolRegistry;
  projection: Projection;
  persona: AgentLoopPersona;
  ds: DsClient;
  config: () => AppConfig;
  now: () => string;
  timezone: string;
  runTurnFn?: typeof runTurn;
  compactFn?: typeof generateCompactSummary;
  /** 已确认的 Provider 能力；提供后做预检，缺省时请求原样发送并显式报告对端错误。 */
  modelCapabilities?: SubagentModelCapabilities;
  /** P4.3：允许 worker 使用的项目根；生产只授权启动项目，测试可显式注入。 */
  projectRoots?: readonly string[];
  mcpPoolFactory?: SubagentMcpOptions['poolFactory'];
  binaryCheck?: (id: string) => boolean;
  /** healthcheck 的 Python 模块探测注入（测试用；生产走真 spawn）。 */
  pythonModulesCheck?: (modules: readonly string[]) => readonly string[];
  /** 测试/替代注入：codegraph 的 Python/CLI 路径与执行器（生产用默认解析）。 */
  codePythonPath?: string;
  codeCliPath?: string;
  codeRunner?: import('./subagent-code.ts').CodeCliRunner;
  /** 测试/替代注入：screenshot 的 PowerShell 执行器（生产用默认 spawn）。 */
  screenshotRunner?: import('./subagent-screenshot.ts').ScreenshotRunner;
  /** Test/alternate injection; production builds the registry from dataDir/subagents. */
  profiles?: SubagentProfileRegistry;
}

export interface DelegateInput {
  profile?: string;
  profileId?: string;
  task: string;
  context?: string;
  /** worker：父级指定的项目目录；必须位于 projectRoots 内。 */
  projectRoot?: string;
  /** P2: seed the child with the parent's completed-turn prefix. */
  fork?: boolean;
}

export interface DelegateHandle {
  agentId: string;
  status: 'queued' | 'running';
  profileId: string;
  workspace: string;
}

/**
 * 递归/控制面工具：schema 保留（与父同集），执行期一律拒绝。
 *
 * `delegate` 与 `subagent` 是 P1 后台子代理的两个入口（`task` 是前台那一件），
 * 子代理手里**一件都不许真的能调用**——否则"派一个子代理"就成了绕过嵌套上限的路。
 * 名单只有这一处：Profile 路径（`childToolRegistry`）、fork 路径（`forkToolRegistry`）、
 * 冻结头路径（`headToolRegistry`）共用它。
 */
const RECURSIVE_TOOLS = new Set(['delegate', 'task', 'subagent']);
export const FORK_NOTICE = '当前为 Fork 子代，接受完整的父级上下文以了解复杂任务情况。'
  + '不需要感到意外和惊慌，完成任务即可。';
const FORK_READONLY = new Set(['safe_read', 'read_blob', 'grep', 'find', 'report']);

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), {recursive: true});
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'wx');
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    rmSync(tmp, {force: true});
    throw error;
  }
}

function isSession(value: unknown): value is AgentSession {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row['schema'] === 1 && typeof row['agentId'] === 'string' && typeof row['status'] === 'string'
    && typeof row['parentCallId'] === 'string' && typeof row['task'] === 'string';
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return value;
}

function childProjectionOf(parent: Projection): Projection {
  const child = emptyProjection();
  child.budget.tokensToday = parent.budget.tokensToday;
  child.budget.tokensTodayHeavy = parent.budget.tokensTodayHeavy;
  child.budget.tokensTodayLight = parent.budget.tokensTodayLight;
  child.budget.cacheHitToday = parent.budget.cacheHitToday;
  child.budget.cacheMissToday = parent.budget.cacheMissToday;
  child.budget.tokensTask = parent.budget.tokensTask;
  child.failStreak = parent.failStreak;
  child.lastExhausted = {...parent.lastExhausted};
  child.degraded = parent.degraded === null ? null : {...parent.degraded};
  child.lastModelSuccessAt = parent.lastModelSuccessAt;
  child.firstEventAt = parent.firstEventAt;
  return child;
}

/** Profile 子代理注册表的装配选项（capability 过滤的输入）。 */
interface ChildToolOptions {
  /** `workspace:'own'` 才允许写工具；`none` 一律拒绝。 */
  allowWrites: boolean;
  /**
   * 有没有文件面（workspace）。`false` ⇒ 读/写文件工具**一件都不注册**：
   * 没有 workspace 的 Profile 没有可读的根，注册一件"能读任意路径"的工具就是最小权限的反面。
   */
  allowFiles: boolean;
  allowedRoots: readonly string[];
  defaultRoot: string;
  manager?: SubagentManager;
  agentId?: string;
}

/**
 * Profile 子代理的工具注册表（P3.2.1）。
 *
 * 三层判据，缺一不可：
 *   1. **加载期**：Profile 声明不可授予的条目 ⇒ 整份拒绝（`subagent-profiles.ts`）；
 *   2. **这里**：按 `toolDenialClass` 再筛一遍——用户通道/递归/unsafe/unknown 连 schema 都不进；
 *      写工具只在 own workspace；文件工具只在有 workspace 时；
 *   3. **执行期**：`delegate`/`subagent`/`task` schema 保留但 handler 拒绝（与 fork 同一条
 *      "禁用不摘除"纪律）；`report` 一律换成路由父代理的包装（绝不落用户通道）。
 */
function childToolRegistry(
  parent: ToolRegistry,
  names: readonly string[],
  options: ChildToolOptions,
): ToolRegistry {
  const child = new ToolRegistry();
  const selected = new Set<string>();
  for (const name of names) {
    // 纵深防御：即使调用方给的名单没经过 Profile 注册表校验，这里也不放行。
    if (toolDenialClass(name, {allowWrites: options.allowWrites, allowFiles: options.allowFiles}) !== null) continue;
    selected.add(name);
  }
  // Recursion schema is always present when the parent has it; handler guard rejects calls.
  for (const name of RECURSIVE_TOOLS) selected.add(name);
  // 报告通道永远保留（只路由父代理）。
  selected.add('report');
  for (const name of selected) {
    const def = parent.get(name);
    if (def === null) continue;
    let routed: ToolDefinition = def;
    if (name === 'report' && options.manager !== undefined && options.agentId !== undefined) {
      routed = {
        ...def,
        handler: async (args) => options.manager!.reportProgress(options.agentId!,
          typeof (args as Record<string, unknown>)['text'] === 'string'
            ? String((args as Record<string, unknown>)['text']) : ''),
      };
    } else if (RECURSIVE_TOOLS.has(name)) {
      routed = {
        ...def,
        handler: async () => errorResult('子代理不能再派子代理（depth-exceeded）。', 'depth-exceeded'),
      };
    }
    try {
      child.register(scopeToolToRoots(routed, options.allowedRoots, options.defaultRoot));
    } catch {
      // duplicate is impossible here; never abort the session for a missing optional tool
    }
  }
  return child;
}

/**
 * P2 fork registry: schema is the parent's full set, but execution is guarded.
 * `report` keeps the parent schema and is rerouted to the parent agent (never the user).
 */
function forkToolRegistry(parent: ToolRegistry, manager: SubagentManager, agentId: string): ToolRegistry {
  const child = new ToolRegistry();
  for (const spec of parent.listForModel({includeDestructive: true})) {
    const def = parent.get(spec.name);
    if (def === null) continue;
    let next: ToolDefinition;
    if (RECURSIVE_TOOLS.has(def.name)) {
      next = {
        ...def,
        handler: async () => errorResult('子代理不能再派子代理（depth-exceeded）。', 'depth-exceeded'),
      };
    } else if (def.name === 'report') {
      next = {
        ...def,
        handler: async (args) => manager.reportProgress(agentId,
          typeof (args as Record<string, unknown>)['text'] === 'string'
            ? String((args as Record<string, unknown>)['text']) : ''),
      };
    } else if (!FORK_READONLY.has(def.name)) {
      next = {
        ...def,
        handler: async () => errorResult('Fork 子代理受 Profile 写权限限制，不能调用这件工具。', 'fork-permission-denied'),
      };
    } else {
      next = def;
    }
    try {
      child.register(next);
    } catch {
      // duplicate name in parent registry is impossible; keep child alive
    }
  }
  return child;
}

/** Rebuild the exact frozen fork schema; handlers are paired from the live registry when still present. */
function headToolRegistry(
  head: ForkHead,
  live: ToolRegistry,
  manager: SubagentManager,
  agentId: string,
): ToolRegistry {
  const child = new ToolRegistry();
  for (const spec of head.tools) {
    const current = live.get(spec.name);
    const base: ToolDefinition = current === null
      ? {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        ...(spec.outputSchema === undefined ? {} : {outputSchema: spec.outputSchema}),
        executionMode: 'exclusive',
        sideEffect: 'none',
        timeoutMs: 10_000,
        handler: async () => errorResult('Fork 头快照里的这件工具已不存在于当前父注册表。', 'fork-tool-missing'),
      }
      : {
        ...current,
        description: spec.description,
        parameters: spec.parameters,
        ...(spec.outputSchema === undefined ? {} : {outputSchema: spec.outputSchema}),
      };
    let def: ToolDefinition = base;
    if (RECURSIVE_TOOLS.has(spec.name)) {
      def = {
        ...base,
        handler: async () => errorResult('子代理不能再派子代理（depth-exceeded）。', 'depth-exceeded'),
      };
    } else if (spec.name === 'report') {
      def = {
        ...base,
        handler: async (args) => manager.reportProgress(agentId,
          typeof (args as Record<string, unknown>)['text'] === 'string'
            ? String((args as Record<string, unknown>)['text']) : ''),
      };
    } else if (!FORK_READONLY.has(spec.name)) {
      def = {
        ...base,
        handler: async () => errorResult('Fork 子代理受 Profile 写权限限制，不能调用这件工具。', 'fork-permission-denied'),
      };
    }
    try {
      child.register(def);
    } catch {
      // keep frozen schema alive even if a name collides
    }
  }
  return child;
}

function budgetHook(guard: BudgetGuard): AgentLoopBudget {
  const hook: AgentLoopBudget = {checkBeforeStep: (projection) => guard.checkBeforeStep(projection)};
  if (guard.softHint !== undefined) hook.softHint = (projection) => guard.softHint!(projection);
  if (guard.stepCallLimit !== undefined) hook.stepCallLimit = () => guard.stepCallLimit!();
  if (guard.noteStepOverflow !== undefined) hook.onStepOverflow = (actual) => guard.noteStepOverflow!(actual);
  return hook;
}

/**
 * 一次激活的轮数上限（P3.2.1）。
 *
 * 取值顺序：session 上冻结的那份（创建时写死，resume 沿用它）→ Profile 当前值 → 兜底。
 * 非法值一律回到安全档：<=0 用兜底，超大夹到硬上限（Profile 是数据，不能靠写大数绕过执行）。
 * 它取代的是"仅解析"：P3.2 的 `maxTurns` 只在 profiles.json 里躺着，运行期一个字都不读。
 */
function maxTurnsOf(session: AgentSession, profile: SubagentProfile): number {
  const raw = session.maxTurns ?? profile.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS;
  if (!Number.isSafeInteger(raw) || raw <= 0) return DEFAULT_SUBAGENT_MAX_TURNS;
  return Math.min(raw, MAX_SUBAGENT_MAX_TURNS);
}

/**
 * P1 background AgentSession runtime. One instance is process-local; sessions are persisted under
 * <dataDir>/subagents/sessions/<agentId>/session.json and can be resumed by a new process.
 */
export class SubagentManager {
  private readonly deps: SubagentManagerDeps;
  private readonly root: string;
  private readonly sessionsDir: string;
  private readonly profiles: SubagentProfileRegistry;
  private readonly profileHealth = new Map<string, ProfileAvailability>();
  private readonly sessions = new Map<string, AgentSession>();
  private readonly queue: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelled = new Set<string>();
  private active = 0;
  private started = false;

  constructor(deps: SubagentManagerDeps) {
    this.deps = deps;
    this.root = resolve(deps.dataDir, 'subagents');
    this.sessionsDir = join(this.root, 'sessions');
    this.profiles = deps.profiles ?? new SubagentProfileRegistry(deps.dataDir);
  }

  /** `includeHidden` 只给测试/诊断：HTTP 只用默认值（general 隐式兜底不进列表）。 */
  profileSummaries(includeHidden = false): ReturnType<SubagentProfileRegistry['summaries']> {
    return this.profiles.summaries(includeHidden).map((summary) => ({
      ...summary,
      ...(this.profileHealth.get(summary.id) ?? {}),
    }));
  }

  profileErrors(): readonly string[] {
    return this.profiles.errors;
  }

  get enabled(): boolean {
    return this.deps.config().subagents.enabled;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    mkdirSync(this.sessionsDir, {recursive: true});
    for (const session of this.loadAll()) this.sessions.set(session.agentId, session);
    await this.recoverInterrupted();
    for (const profile of this.profiles.list()) {
      if (profile.install !== undefined) await this.refreshProfileHealth(profile.id);
    }
    for (const session of this.sessions.values()) {
      if (session.status === 'queued') this.enqueue(session.agentId);
    }
  }

  async installProfile(profileId: string): Promise<ReturnType<SubagentProfileRegistry['summaries']>[number] | null> {
    if (!this.enabled) throw new Error('subagents-disabled');
    await new SubagentPackageInstaller({dataDir: this.deps.dataDir}).install(profileId);
    this.profiles.reloadRolePackages();
    const availability = await this.refreshProfileHealth(profileId);
    this.write('subagent/profile-installed', {
      profileId, available: availability?.available ?? false, missing: availability?.missing ?? ['profile-unknown'],
    }, 'internal', null);
    return this.profileSummaries(true).find((item) => item.id === profileId) ?? null;
  }

  async verifyProfile(profileId: string): Promise<ReturnType<SubagentProfileRegistry['summaries']>[number] | null> {
    if (!this.enabled) throw new Error('subagents-disabled');
    if (this.profiles.get(profileId) === null) throw new Error('profile-unknown');
    const availability = await this.refreshProfileHealth(profileId);
    this.write('subagent/profile-health', {
      profileId, available: availability?.available ?? false, missing: availability?.missing ?? ['healthcheck'],
    }, 'internal', null);
    return this.profileSummaries(true).find((item) => item.id === profileId) ?? null;
  }

  private async refreshProfileHealth(profileId: string): Promise<ProfileAvailability | null> {
    const profile = this.profiles.get(profileId);
    if (profile === null) return null;
    let availability: ProfileAvailability;
    try {
      availability = await healthcheckSubagentProfile(profile, this.profiles, {
        dataDir: this.deps.dataDir, ds: this.deps.ds,
        ...(this.deps.modelCapabilities === undefined ? {} : {modelCapabilities: this.deps.modelCapabilities}),
        ...(this.deps.projectRoots === undefined ? {} : {projectRoots: this.deps.projectRoots}),
        ...(this.deps.mcpPoolFactory === undefined ? {} : {mcpPoolFactory: this.deps.mcpPoolFactory}),
        ...(this.deps.binaryCheck === undefined ? {} : {binaryCheck: this.deps.binaryCheck}),
        ...(this.deps.pythonModulesCheck === undefined ? {} : {pythonModulesCheck: this.deps.pythonModulesCheck}),
      });
    } catch {
      availability = {available: false, locked: true, missing: ['healthcheck']};
    }
    this.profileHealth.set(profileId, availability);
    return availability;
  }

  async delegate(input: DelegateInput, parent: {callId: string; turn: number}): Promise<DelegateHandle> {
    if (!this.enabled) throw new Error('subagents-disabled');
    const chosen = this.profiles.get(input.profileId ?? input.profile ?? 'general');
    if (chosen === null) throw new Error('profile-unknown');
    if (input.fork !== true) {
      const availability = this.profileHealth.get(chosen.id) ?? this.profiles.availability(chosen);
      if (availability.locked) {
        throw new Error(`profile-locked:${chosen.id};missing=${availability.missing.join(',')}`);
      }
    }
    const profile = input.fork === true ? 'general' : chosen.id;
    // fork 的权限/额度按 general 算（fork 不继承 Profile 的写权限，见设计文档 §13）
    const effective = input.fork === true ? this.profiles.get('general') ?? chosen : chosen;
    this.assertModelCapabilities(effective.reasoningEffort ?? 'high', effective.contextLimit ?? 1_000_000);
    // 缺省 workdir = workspace（老 Profile 字段语义不变）。
    const workdirMode = effective.workdir ?? 'workspace';
    const projectRoot = input.fork === true || workdirMode === 'workspace'
      ? null
      // workdir:'auto'（worker）：只有父代理显式给了项目根才进 project；没给就用 workspace，
      // 不再把“唯一授权根”自动塞给设计类任务（否则纯设计任务会莫名在项目根里写东西）。
      : workdirMode === 'auto'
        ? (input.projectRoot === undefined ? null : resolveAuthorizedProject(input.projectRoot, this.deps.projectRoots ?? []))
        : resolveAuthorizedProject(input.projectRoot, this.deps.projectRoots ?? []);
    if (projectRoot === null && input.projectRoot !== undefined) throw new Error('project-root-not-allowed');
    const task = input.task.trim();
    if (task === '' || task.length > 50_000) throw new Error('task-invalid');
    const fork = input.fork === true ? await this.buildForkSnapshot() : null;
    const agentId = `sub-${randomUUID()}`;
    const workspace = 'workspace';
    const session: AgentSession = {
      schema: 1,
      agentId,
      profileId: profile,
      parentCallId: parent.callId === '' ? `delegate-${agentId}` : parent.callId,
      parentTurn: parent.turn,
      status: 'queued',
      createdAt: this.deps.now(),
      updatedAt: this.deps.now(),
      startedAt: null,
      turn: 0,
      resumeCount: 0,
      task,
      context: (input.context ?? '').slice(0, 16_000),
      pendingMessages: [],
      lastReport: null,
      ...(fork === null ? {} : {
        forkFromSeq: fork.seq, prefixHash: fork.hash, headHash: fork.head.headHash,
        forkPrefixFile: 'prefix.json', forkHeadFile: 'head.json',
      }),
      tokens: {used: 0, limit: this.deps.config().budget.taskTokens},
      workspace,
      maxTurns: effective.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
      workspaceMode: effective.workspace,
      ...(projectRoot === null ? {} : {projectRoot}),
      reasoningEffort: effective.reasoningEffort ?? 'high',
      reasoningEffortApplied: null,
      contextLimit: effective.contextLimit ?? 1_000_000,
      compactAt: effective.compactAt ?? 0.7,
      error: null,
    };
    this.sessions.set(agentId, session);
    this.save(session);
    if (fork !== null) {
      this.writeForkPrefix(agentId, fork.events);
      this.writeForkHead(agentId, fork.head);
    }
    this.enqueue(agentId);
    return {agentId, status: 'queued', profileId: profile, workspace};
  }

  /** Child-side progress report: emits to the parent wake queue, never to a user channel. */
  reportProgress(agentId: string, summary: string): ToolHandlerResult {
    const session = this.require(agentId);
    if (session.status === 'cancelled' || session.status === 'completed' || session.status === 'archived') {
      return errorResult('子代理已终态，不能再报告。', 'subagent-terminal');
    }
    const text = summary.trim();
    if (text === '') return errorResult('报告正文不能为空。', 'report-empty');
    const reportId = `report-${agentId}-${session.turn}-${Date.now()}`;
    this.emit('subagent/report', {agentId, kind: 'progress', reportId, summary: text, tokens: {...session.tokens}}, session);
    this.write('wake/subagent', {
      agentId, parentCallId: session.parentCallId, status: 'running', kind: 'progress',
      summary: text, tokens: {...session.tokens}, reportId,
    }, 'model', null);
    return okResult('已报告给父代理；父代理会在下一个 turn 看到。');
  }

  message(agentId: string, message: string): {accepted: true; agentId: string; queued: boolean} {
    const session = this.require(agentId);
    const text = message.trim();
    if (text === '') throw new Error('message-invalid');
    if (session.status === 'cancelled' || session.status === 'archived') throw new Error('subagent-terminal');
    session.pendingMessages.push(text.slice(0, 16_000));
    if (session.status === 'interrupted' || session.status === 'completed') {
      this.resume(agentId);
      return {accepted: true, agentId, queued: false};
    }
    if (session.status === 'queued') this.enqueue(agentId);
    this.save(session);
    return {accepted: true, agentId, queued: true};
  }

  cancel(agentId: string, reason = 'parent-cancel'): {cancelled: true; agentId: string} {
    const session = this.require(agentId);
    if (session.status === 'completed' || session.status === 'cancelled' || session.status === 'archived') {
      throw new Error('subagent-terminal');
    }
    this.cancelled.add(agentId);
    const controller = this.controllers.get(agentId);
    if (controller !== undefined) {
      controller.abort();
      // API/status reads this immediately; the worker still settles the turn asynchronously.
      session.status = 'cancelled';
      session.updatedAt = this.deps.now();
      this.save(session);
    }
    if (session.status === 'queued') {
      this.removeFromQueue(agentId);
      session.status = 'cancelled';
      session.updatedAt = this.deps.now();
      this.save(session);
      this.emit('subagent/cancelled', {agentId, reason}, session);
      this.emit('subagent/finished', {
        agentId, status: 'cancelled', summary: '', steps: 0, turn: session.turn,
        tokens: {...session.tokens},
      }, session);
    }
    return {cancelled: true, agentId};
  }

  resume(agentId: string): {resumed: true; agentId: string; status: SubagentStatus} {
    const session = this.require(agentId);
    if (session.status !== 'interrupted' && session.status !== 'completed' && session.status !== 'cancelled') {
      throw new Error('subagent-not-resumable');
    }
    const profile = this.profiles.get(session.profileId);
    this.assertModelCapabilities(
      session.reasoningEffort ?? profile?.reasoningEffort ?? 'high',
      session.contextLimit ?? profile?.contextLimit ?? 1_000_000,
    );
    if (session.forkFromSeq !== undefined) {
      const head = this.readForkHead(session);
      if (head === null) {
        session.error = 'fork-head-missing';
        this.save(session);
        throw new Error('fork-head-missing');
      }
      if (head.renderVersion !== RENDER_VERSION) {
        session.error = 'fork-head-render-version';
        this.save(session);
        throw new Error('fork-head-render-version');
      }
    }
    session.status = 'queued';
    session.resumeCount += 1;
    session.updatedAt = this.deps.now();
    this.save(session);
    /**
     * 收尾（P4.5）：resume 必须把上一次 cancel 的标记**摘掉**。
     *
     * 旧实现只在 `cancel()` 里 `cancelled.add(agentId)`，resume 从不清——于是"取消后恢复"的
     * 那一轮跑完时，`runSession` 的收尾判据 `this.cancelled.has(agentId)` 仍为真，会把它
     * 重新标成 cancelled：恢复等于没恢复。父代理显式 resume 就是"让它重新动起来"，旧账在这里销。
     */
    this.cancelled.delete(agentId);
    this.emit('subagent/resumed', {agentId, fromTurn: session.turn, resumeCount: session.resumeCount}, session);
    this.enqueue(agentId);
    return {resumed: true, agentId, status: 'queued'};
  }

  /** API/tests only: mark terminal session archived; sessions remain readable by id. */
  archive(agentId: string): boolean {
    const session = this.sessions.get(agentId) ?? this.load(agentId);
    if (session === null) return false;
    session.status = 'archived';
    session.updatedAt = this.deps.now();
    this.save(session);
    this.sessions.set(agentId, session);
    return true;
  }

  list(includeArchived = false): Array<Record<string, unknown>> {
    return [...this.sessions.values()]
      .filter((session) => includeArchived || session.status !== 'archived')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((session) => this.publicView(session));
  }

  status(agentId?: string): Record<string, unknown> | null {
    if (agentId !== undefined) {
      const session = this.sessions.get(agentId) ?? this.load(agentId);
      return session === null ? null : this.publicView(session);
    }
    return {items: this.list(false)};
  }

  private publicView(session: AgentSession): Record<string, unknown> {
    const profile = this.profiles.get(session.profileId);
    return {
      agentId: session.agentId,
      profileId: session.profileId,
      // 旧 session（research/coding/...）不映射成新角色：label 退回 id，并标 legacy。
      profileLabel: profile?.label ?? session.profileId,
      ...(profile === null || profile.legacy === true ? {profileLegacy: true} : {}),
      status: session.status,
      parentCallId: session.parentCallId,
      parentTurn: session.parentTurn,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      turn: session.turn,
      resumeCount: session.resumeCount,
      lastReport: session.lastReport,
      headHash: session.headHash ?? null,
      headError: session.error,
      reasoningEffort: session.reasoningEffort ?? profile?.reasoningEffort ?? 'high',
      reasoningEffortApplied: session.reasoningEffortApplied ?? null,
      contextLimit: session.contextLimit ?? profile?.contextLimit ?? 1_000_000,
      compactAt: session.compactAt ?? profile?.compactAt ?? 0.7,
      compactCount: session.compact?.count ?? 0,
      contextTokens: session.compact?.promptTokens ?? null,
      contextTokenSource: session.compact?.tokenSource ?? null,
      tokens: {...session.tokens},
      canResume: session.status === 'interrupted' || session.status === 'completed' || session.status === 'cancelled',
      canCancel: session.status !== 'completed' && session.status !== 'cancelled' && session.status !== 'archived',
    };
  }

  /** P2: only a completed parent prefix; current turn's tool/call (including delegate) is excluded. */
  private async buildForkSnapshot(): Promise<{
    seq: number; hash: string; events: AppEvent[]; head: ForkHead;
  } | null> {
    try {
      const all: AppEvent[] = [];
      for await (const event of this.deps.log.readAll()) all.push(event);
      let seq = 0;
      for (const event of all) if (event.type === 'turn/end' && event.seq > seq) seq = event.seq;
      if (seq === 0) return null;
      const prefix = all.filter((event) => event.seq <= seq).map((event) => deepFreeze(structuredClone(event)));
      const tools = this.deps.registry.listForModel({includeDestructive: true})
        .map((def) => ({
          name: def.name, description: def.description, parameters: def.parameters,
          ...(def.outputSchema === undefined ? {} : {outputSchema: def.outputSchema}),
        }));
      // Diagnostic hash over the three request-head inputs we can reproduce without a model call.
      const hash = createHash('sha256')
        .update(JSON.stringify({system: this.deps.persona, tools, prefix}), 'utf8')
        .digest('hex');
      const persona = deepFreeze(structuredClone(this.deps.persona));
      const headHash = createHash('sha256').update(JSON.stringify({
        renderVersion: RENDER_VERSION, forkFromSeq: seq, persona, tools,
      }), 'utf8').digest('hex');
      return {
        seq, hash, events: prefix,
        head: {schema: 1, renderVersion: RENDER_VERSION, forkFromSeq: seq, persona, tools, headHash},
      };
    } catch {
      return null;
    }
  }

  private writeForkPrefix(agentId: string, events: readonly AppEvent[]): void {
    try {
      writeJsonAtomic(join(this.sessionsDir, agentId, 'prefix.json'), events);
    } catch {
      // Prefix snapshot is diagnostic/recovery material; a write failure must not kill delegate.
    }
  }

  private writeForkHead(agentId: string, head: ForkHead): void {
    writeJsonAtomic(join(this.sessionsDir, agentId, 'head.json'), head);
  }

  private readForkHead(session: AgentSession): ForkHead | null {
    try {
      const raw = JSON.parse(readFileSync(join(this.sessionsDir, session.agentId, 'head.json'), 'utf8')) as unknown;
      if (typeof raw !== 'object' || raw === null) return null;
      const head = raw as ForkHead;
      if (head.schema !== 1 || head.forkFromSeq !== session.forkFromSeq
        || typeof head.renderVersion !== 'string' || typeof head.headHash !== 'string'
        || typeof head.persona !== 'object' || !Array.isArray(head.tools)) return null;
      return head;
    } catch {
      return null;
    }
  }

  private require(agentId: string): AgentSession {
    const session = this.sessions.get(agentId) ?? this.load(agentId);
    if (session === null) throw new Error('subagent-not-found');
    this.sessions.set(agentId, session);
    return session;
  }

  private enqueue(agentId: string): void {
    if (!this.queue.includes(agentId)) this.queue.push(agentId);
    this.pump();
  }

  private removeFromQueue(agentId: string): void {
    const index = this.queue.indexOf(agentId);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private pump(): void {
    const max = Math.max(1, this.deps.config().subagents.maxConcurrent);
    while (this.active < max && this.queue.length > 0) {
      const agentId = this.queue.shift()!;
      const session = this.sessions.get(agentId);
      if (session === undefined || session.status === 'cancelled' || session.status === 'archived') continue;
      /**
       * 同一个 AgentSession **同一时刻只许有一个激活**（P4.5 收尾）。
       *
       * 旧实现没有这道闸：cancel 的 abort 还没落地时父代理就 resume，队列里会出现同
       * 一个 agentId 的第二次激活，两个 runSession 并发跑同一份 session.json（轮次号互相
       * 覆盖、收尾事件互相打架）。已经有一次激活在跑就把它放回队列，等那次在 finally 里
       * 调 pump 时再起——那时代码路径上只有一条激活着。
       */
      if (this.controllers.has(agentId)) {
        this.queue.push(agentId);
        break;
      }
      this.active += 1;
      void this.runSession(agentId).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async runSession(agentId: string): Promise<void> {
    const session = this.require(agentId);
    if (session.status === 'cancelled' || session.status === 'archived') return;
    let forkHead: ForkHead | null = null;
    if (session.forkFromSeq !== undefined) {
      forkHead = this.readForkHead(session);
      if (forkHead === null || forkHead.renderVersion !== RENDER_VERSION) {
        session.status = 'interrupted';
        session.error = forkHead === null ? 'fork-head-missing' : 'fork-head-render-version';
        this.save(session);
        this.emit('subagent/interrupted', {agentId, turn: session.turn, reason: 'shutdown'}, session);
        return;
      }
    }
    const profile = this.profiles.get(session.profileId);
    if (profile === null) {
      session.status = 'interrupted';
      session.error = 'profile-unknown';
      this.save(session);
      this.emit('subagent/interrupted', {agentId, turn: session.turn, reason: 'shutdown'}, session);
      return;
    }
    session.reasoningEffort ??= profile.reasoningEffort;
    session.contextLimit ??= profile.contextLimit;
    session.compactAt ??= profile.compactAt;
    session.reasoningEffortApplied = session.reasoningEffort;
    const controller = new AbortController();
    this.controllers.set(agentId, controller);
    session.status = 'running';
    session.updatedAt = this.deps.now();
    if (session.startedAt === null) session.startedAt = session.updatedAt;
    this.save(session);
    if (session.startedAt === session.updatedAt) {
      this.emit('subagent/started', {
        agentId, profileId: session.profileId, parentCallId: session.parentCallId, parentTurn: session.parentTurn,
        maxTurns: maxTurnsOf(session, profile),
        reasoningEffort: session.reasoningEffort,
        reasoningEffortApplied: session.reasoningEffortApplied,
        contextLimit: session.contextLimit,
        compactAt: session.compactAt,
        compactCount: session.compact?.count ?? 0,
        tokens: {...session.tokens},
        ...(session.forkFromSeq === undefined ? {} : {
          forkFromSeq: session.forkFromSeq, prefixHash: session.prefixHash, headHash: session.headHash,
        }),
      }, session);
    }

    // P3.2.1：本次激活的轮数额度（每次 delegate/resume 重新起算，见 `settleMaxTurns` 的说明）。
    const maxTurns = maxTurnsOf(session, profile);
    let turnsThisRun = 0;
    let lastSteps = 0;
    let continuation: string | null = null;
    let contextReading: {tokens: number; source: 'provider' | 'estimated'} | null = null;
    // workspace:'none' = 没有文件面：**不创建目录**，文件工具一律不注册（最小权限）。
    const workspaceMode = session.workspaceMode ?? profile.workspace;
    const workspace = this.workspacePath(agentId);
    if (workspaceMode === 'own') mkdirSync(workspace, {recursive: true});
    /**
     * 文件面根（P4.5 扩展 workdir:'auto'）：
     *   · `project`：必须有 projectRoot，否则抛 project-root-required（老语义不变）；
     *   · `workspace`：只给会话 workspace；
     *   · `auto`（worker）：有 projectRoot 就用 project，没有就退回 workspace——同一份角色
     *     既能做编码任务，也能在没有项目的纯设计任务里只写自己的 workspace。
     * fork/head 路径一律 workspace（fork 不继承 Profile 的项目权限）。
     */
    const profileWorkdir = profile.workdir ?? 'workspace';
    const workdir = forkHead !== null ? workspace
      : profileWorkdir === 'project' ? session.projectRoot ?? null
        : profileWorkdir === 'auto' ? session.projectRoot ?? workspace
          : workspace;
    const allowedRoots = workdir === null ? [] : workdir === workspace ? [workspace] : [workdir, workspace];
    const childTools: ChildToolOptions = {
      allowWrites: workspaceMode === 'own',
      allowFiles: workspaceMode === 'own',
      allowedRoots,
      defaultRoot: workdir ?? workspace,
      manager: this,
      agentId,
    };
    const runtimeEmit = (data: Record<string, unknown>): void => {
      this.write('subagent/runtime', {agentId, ...data}, 'internal', session);
    };
    const skillRuntime = forkHead === null
      ? new SubagentSkillRuntime(this.deps.dataDir, profile.id, profile.skills ?? []) : null;
    if (skillRuntime !== null && skillRuntime.missing.length > 0) {
      runtimeEmit({action: 'skills-missing', missing: [...skillRuntime.missing]});
    }
    // P4.5：Profile 的 `shell` 字段在这里真正落到角色 scoped pwsh 上。
    // worker（shell:'full'，仅 worker 生效）：cwd 默认 session workspace，命令可 cd/访问任意
    // 绝对路径（不做路径审计，见 `subagent-shell.ts` 的 createFullPwshTool）；
    // 其余角色：auto 按 projectRoot 折算，researcher/scribe 只有 workspace，general/fork 没有。
    // 文件工具仍按 workdir 收口在 project/workspace——外部目录只走 pwsh，不扩文件面。
    const effectiveShell = profile.shell === 'auto'
      ? (session.projectRoot === undefined ? 'workspace' : 'project')
      : profile.shell ?? 'none';
    const shellTool = forkHead === null ? createScopedPwshTool({
      profileId: profile.id, shell: effectiveShell, workspace,
      ...(session.projectRoot === undefined ? {} : {projectRoot: session.projectRoot}),
      agentId, emit: runtimeEmit,
    }) : null;
    // worker 专用 codegraph 工具：只在有项目根时注入（没有项目就没有可索引的东西）。
    // 条件与 shell 同一个会话事实（session.projectRoot），不是“猜 profile 应该有什么”。
    const codeTool = forkHead === null && profile.id === 'worker' && session.projectRoot !== undefined
      ? createCodeTool({
        profileId: profile.id, workspace, projectRoot: session.projectRoot, agentId, emit: runtimeEmit,
        ...(this.deps.codePythonPath === undefined ? {} : {pythonPath: this.deps.codePythonPath}),
        ...(this.deps.codeCliPath === undefined ? {} : {cliPath: this.deps.codeCliPath}),
        ...(this.deps.codeRunner === undefined ? {} : {runner: this.deps.codeRunner}),
      }) : null;
    // worker 专用 screenshot：只写会话 workspace，**没有 projectRoot 也能用**（纯设计任务）。
    const screenshotTool = forkHead === null && profile.id === 'worker'
      ? createScreenshotTool({
        profileId: profile.id, workspace, agentId, emit: runtimeEmit,
        ...(this.deps.screenshotRunner === undefined ? {} : {runner: this.deps.screenshotRunner}),
      }) : null;
    const profileMcpServers = profile.mcpServers ?? [];
    const mcpRuntime = forkHead === null && profileMcpServers.length > 0 ? new SubagentMcpRuntime({
      dataDir: this.deps.dataDir, profileId: profile.id, agentId, servers: profileMcpServers,
      roots: allowedRoots, defaultRoot: workdir ?? workspace, emit: runtimeEmit,
      ...(this.deps.mcpPoolFactory === undefined ? {} : {poolFactory: this.deps.mcpPoolFactory}),
    }) : null;

    try {
      if (workdir === null) throw new Error('project-root-required');
      await mcpRuntime?.start(controller.signal);
      while (true) {
        const hasPending = session.pendingMessages.length > 0;
        /**
         * 收尾（P4.5）：父代理显式 `resume` 一个**已经完成过一轮**的会话时，队列里可能一条消息
         * 都没有（cancel 之后 message 会被 `subagent-terminal` 拒绝，只剩 resume 这一扇门）。
         * 旧实现在这里直接 `break`：会话被置成 `running` 却一次模型都不调，永远卡在 running。
         * 现在的语义：没有新消息的 resume = 让子代理按已完成进度**继续跑一轮**（明确的续跑指令，
         * 不重放全部历史、不声称完成）；真拿到新报告后照常走 completed 收尾。
         */
        if (!hasPending && continuation === null && session.lastReport !== null) {
          if (session.resumeCount > 0 && session.status === 'running') {
            continuation = '[继续] 父代理要求继续这个子任务：按已完成进度接着做未完成的部分，'
              + '不要重复已完成的副作用；完成后把结论报告给父代理。';
          } else {
            break;
          }
        }
        if (turnsThisRun >= maxTurns) {
          // 到上限就**不再调用模型**：留下队列与 workspace，等父代理 resume/续聊。
          this.settleMaxTurns(session, maxTurns, lastSteps);
          return;
        }
        const next = session.pendingMessages.shift() ?? continuation ?? this.initialText(session);
        continuation = null;
        turnsThisRun += 1;
        const baseTokens = this.deps.projection.budget.tokensTask;
        const child = childProjectionOf(this.deps.projection);
        let lastText: string | null = null;
        let steps = 0;
        let turn = session.turn;
        const guard = new BudgetGuard({
          config: this.deps.config().budget,
          projection: child,
          emit: (type, data, visibility) => {
            const event = this.write(type, data, visibility, session);
            applyOne(child, event);
          },
          now: () => new Date(this.deps.now()),
        });
        const registry = forkHead !== null
          ? headToolRegistry(forkHead, this.deps.registry, this, session.agentId)
          : childToolRegistry(this.deps.registry, this.profiles.toolNames(profile), childTools);
        if (skillRuntime !== null && (profile.skills ?? []).length > 0) registry.register(skillRuntime.tool());
        if (shellTool !== null) registry.register(shellTool);
        if (codeTool !== null) registry.register(codeTool);
        if (screenshotTool !== null) registry.register(screenshotTool);
        mcpRuntime?.registerTools(registry);
        const wakes: AppEvent[] = [];
        if (session.forkFromSeq !== undefined && session.turn === 0) {
          const notice = this.write('wake/manual', {note: FORK_NOTICE}, 'model', session);
          applyOne(child, notice);
          wakes.push(notice);
        }
        const wake = this.write('wake/manual', {note: next}, 'model', session);
        // The child projection owns this input; the parent only sees budget attribution.
        applyOne(child, wake);
        wakes.push(wake);
        const deps: AgentLoopDeps = {
          log: this.deps.log,
          ds: this.deps.ds,
          registry,
          projection: child,
          persona: forkHead?.persona ?? this.profilePersona(this.deps.persona, profile),
          now: this.deps.now,
          timezone: this.deps.timezone,
          lane: profile.lane ?? 'heavy',
          ...(forkHead === null ? {modelVisibility: {includeDestructive: this.deps.config().tools.destructiveEnabled}} : {}),
          skillCatalog: skillRuntime?.catalog ?? null,
          mcpIndex: mcpRuntime === null ? null : `[子代理 MCP 白名单] ${profileMcpServers.join(', ')}`,
          reasoningEffort: session.reasoningEffort ?? 'high',
          contextGuard: (request, lastProviderInputTokens) => {
            contextReading = readingForRequest(request, lastProviderInputTokens);
            return this.contextVerdict(session, contextReading);
          },
          workspaceRoot: workdir,
          boundaryRoot: workdir,
          eventFilter: session.forkFromSeq === undefined
            ? childEventFilter(session.parentCallId)
            : (event) => event.seq <= session.forkFromSeq! || event.parentCallId === session.parentCallId,
          parentCallId: session.parentCallId,
          agentId: session.agentId,
          turnBase: Math.max(session.parentTurn, turn),
          budget: budgetHook(guard),
          signal: controller.signal,
          onEvent: (event) => {
            applySubagentEvent(this.deps.projection, event);
            if (event.type === 'turn/start' && (event.data as {turn: number}).turn > turn) {
              turn = (event.data as {turn: number}).turn;
            }
            if (event.type === 'step/start') steps += 1;
            if (event.type === 'message/assistant' && event.data.text !== null
              && event.data.text.trim() !== '') lastText = event.data.text;
          },
        };
        const reason = await (this.deps.runTurnFn ?? runTurn)(deps, wakes);
        lastSteps = steps;
        session.turn = Math.max(session.turn, turn);
        session.tokens.used = Math.max(session.tokens.used, this.deps.projection.budget.tokensTask - baseTokens);
        session.updatedAt = this.deps.now();
        if (controller.signal.aborted || this.cancelled.has(agentId)) {
          /**
           * 收尾（P4.5）：父代理可能在 cancel 的 abort 落地**之前**就按了 resume。
           * 那次 resume 会带一个新的 AbortController；如果现在 map 里已经不是**这一个**，
           * 说明本次激活已被后来的激活接管，收尾（状态/事件）全部交给新激活，不许在这里写——
           * 否则日志里会出现"先 cancelled、同一轮又 completed"的假账。
           */
          if (this.controllers.get(agentId) !== controller) {
            return;
          }
          /**
           * 父代理可能在 cancel 的 abort 落地**之前**就按了 resume。
           * 那时 session.status 已经被 resume 改成 `queued`——这一支不能再把它覆盖回 cancelled
           * （否则队列里的那次恢复会被 pump 当 cancelled 直接丢掉，表现为"点了恢复没反应"）。
           * 把状态交还给队列即可；新一次激活会带全新的 AbortController。
           */
          if ((session.status as SubagentStatus) === 'queued') {
            this.save(session);
            return;
          }
          session.status = 'cancelled';
          session.error = null;
          this.save(session);
          this.emit('subagent/cancelled', {agentId, reason: 'parent-cancel'}, session);
          this.emit('subagent/finished', {
            agentId, status: 'cancelled', summary: lastText ?? '', steps, turn: session.turn,
            tokens: {...session.tokens},
          }, session);
          return;
        }
        if (reason.kind === 'error' && (reason.code === SUBAGENT_COMPACT_REQUIRED || reason.code === SUBAGENT_CONTEXT_LIMIT)) {
          if (reason.code === SUBAGENT_CONTEXT_LIMIT) {
            this.settleContextFailure(session, 'context-limit-exceeded', steps, '连续 compact 已达上限，停止调用模型');
            return;
          }
          try {
            await this.compactSession(session, child, contextReading, controller.signal);
            continuation = '[上下文已压缩] 根据结构化摘要与保留的最近原始轮次继续未完成任务；不要重复已完成的副作用。';
            session.status = 'running';
            session.error = null;
            session.tokens.used = Math.max(session.tokens.used, this.deps.projection.budget.tokensTask - baseTokens);
            this.save(session);
            continue;
          } catch (error) {
            this.settleContextFailure(session, 'compact-failed', steps, error instanceof Error ? error.message : String(error));
            return;
          }
        }
        if (reason.kind !== 'completed') {
          session.status = 'interrupted';
          session.error = JSON.stringify(reason);
          this.save(session);
          this.emit('subagent/interrupted', {agentId, turn: session.turn, reason: 'shutdown'}, session);
          this.emit('subagent/finished', {
            agentId, status: 'interrupted', summary: lastText ?? '', steps, turn: session.turn,
            tokens: {...session.tokens},
          }, session);
          return;
        }
        session.lastReport = lastText ?? '';
        if (session.pendingMessages.length === 0) {
          session.status = 'completed';
          this.save(session);
          this.emit('subagent/report', {
            agentId, kind: 'final', reportId: `report-${agentId}-${session.turn}`,
            summary: session.lastReport, tokens: {...session.tokens},
          }, session);
          this.emit('subagent/finished', {
            agentId, status: 'completed', summary: session.lastReport, steps, turn: session.turn,
            tokens: {...session.tokens},
          }, session);
          this.write('wake/subagent', {
            agentId, parentCallId: session.parentCallId, status: 'completed',
            summary: session.lastReport, tokens: {...session.tokens},
            reportId: `report-${agentId}-${session.turn}`,
          }, 'model', null);
          return;
        }
        session.status = 'running';
        this.save(session);
      }
    } catch (error) {
      session.status = this.cancelled.has(agentId) ? 'cancelled' : 'interrupted';
      session.error = error instanceof Error ? error.message : String(error);
      session.updatedAt = this.deps.now();
      this.save(session);
      this.emit('subagent/interrupted', {agentId, turn: session.turn, reason: 'shutdown'}, session);
      this.emit('subagent/finished', {
        agentId, status: session.status === 'cancelled' ? 'cancelled' : 'interrupted',
        summary: session.lastReport ?? '', steps: 0, turn: session.turn, tokens: {...session.tokens},
      }, session);
    } finally {
      try {
        await mcpRuntime?.shutdown();
      } catch (error) {
        runtimeEmit({action: 'mcp-shutdown-failed', reason: error instanceof Error ? error.message : String(error)});
      }
      this.controllers.delete(agentId);
    }
  }

  private assertModelCapabilities(effort: ProfileReasoningEffort, contextLimit: number): void {
    const capabilities = this.deps.modelCapabilities;
    if (capabilities === undefined) return;
    if (!capabilities.reasoningEfforts.includes(effort)) throw new Error('reasoning-effort-unsupported');
    if (capabilities.contextLimit === null || contextLimit > capabilities.contextLimit) {
      throw new Error('context-limit-unsupported');
    }
  }

  private contextVerdict(
    session: AgentSession,
    reading: {tokens: number; source: 'provider' | 'estimated'},
  ): {kind: 'error'; code: string; message: string} | null {
    const limit = session.contextLimit ?? 1_000_000;
    const threshold = Math.floor(limit * (session.compactAt ?? 0.7));
    if (reading.tokens < threshold) return null;
    if ((session.compact?.count ?? 0) >= SUBAGENT_MAX_COMPACTS) {
      return {
        kind: 'error', code: SUBAGENT_CONTEXT_LIMIT,
        message: `上下文读数 ${reading.tokens}（${reading.source}）达到 ${threshold}，且连续 compact 已达上限`,
      };
    }
    return {
      kind: 'error', code: SUBAGENT_COMPACT_REQUIRED,
      message: `上下文读数 ${reading.tokens}（${reading.source}）达到 compact 阈值 ${threshold}`,
    };
  }

  private async compactSession(
    session: AgentSession,
    child: Projection,
    reading: {tokens: number; source: 'provider' | 'estimated'} | null,
    signal: AbortSignal,
  ): Promise<void> {
    if (reading === null) throw new Error('compact-reading-missing');
    if ((session.compact?.count ?? 0) >= SUBAGENT_MAX_COMPACTS) throw new Error('compact-limit');
    const events: AppEvent[] = [];
    for await (const event of this.deps.log.readAll()) events.push(event);
    const previousCovered = session.compact?.coveredUpToSeq ?? 0;
    const cutoff = compactCutoff(events, session.parentCallId, session.forkFromSeq, previousCovered);
    if (cutoff === null) throw new Error('compact-no-progress');
    const generated = await (this.deps.compactFn ?? generateCompactSummary)({
      ds: this.deps.ds,
      session: {task: session.task, context: session.context, turn: session.turn},
      events,
      parentCallId: session.parentCallId,
      ...(session.forkFromSeq === undefined ? {} : {forkFromSeq: session.forkFromSeq}),
      ...(session.compact === undefined ? {} : {previous: session.compact}),
      effort: session.reasoningEffort ?? 'high',
      signal,
    });
    const count = (session.compact?.count ?? 0) + 1;
    const threshold = Math.floor((session.contextLimit ?? 1_000_000) * (session.compactAt ?? 0.7));
    const consumed = this.write('budget/consumed', {
      turn: session.turn, step: 0, lane: 'heavy', model: generated.model,
      inputTokens: generated.usage.inputTokens, outputTokens: generated.usage.outputTokens,
      cacheHitTokens: generated.usage.cachedTokens,
      cacheMissTokens: Math.max(0, generated.usage.inputTokens - generated.usage.cachedTokens),
      reasoningTokens: generated.usage.reasoningTokens,
      ...(generated.protocol === undefined ? {} : {protocol: generated.protocol}),
      ...(generated.usageMissing ? {usageMissing: true} : {}),
      retryCount: 0, finishReason: 'completed', operation: 'subagent-compact',
    }, 'internal', session);
    applyOne(child, consumed);
    const summaryEvent = this.write('compaction/summary', {
      coveredUpToSeq: cutoff,
      summary: summaryText(generated.summary),
      compactCount: count,
      contextLimit: session.contextLimit,
      compactAt: session.compactAt,
      promptTokens: reading.tokens,
      tokenSource: reading.source,
    }, 'internal', session);
    applyOne(child, summaryEvent);
    const compacted = this.write('subagent/compacted', {
      agentId: session.agentId, count, threshold, coveredUpToSeq: cutoff,
      promptTokens: reading.tokens, tokenSource: reading.source,
      recentRawTurns: 2, summary: generated.summary,
    }, 'internal', session);
    session.compact = {
      count, threshold, coveredUpToSeq: cutoff, atTurn: session.turn, atSeq: compacted.seq,
      promptTokens: reading.tokens, tokenSource: reading.source, summary: generated.summary,
    };
    session.updatedAt = this.deps.now();
    this.save(session);
  }

  private settleContextFailure(session: AgentSession, code: string, steps: number, detail: string): void {
    const agentId = session.agentId;
    const reportId = `report-${agentId}-${session.turn}-${code}`;
    const summary = code === 'compact-failed'
      ? `子代理上下文压缩失败（compact-failed）：${detail}。原始消息与工具结果仍完整保留；未截断历史，父代理可处理后 resume。`
      : '子代理已达到上下文硬上限且无法继续压缩（context-limit-exceeded）。原始历史完整保留，未静默截断。';
    session.status = 'interrupted';
    session.error = code;
    session.updatedAt = this.deps.now();
    this.save(session);
    this.emit('subagent/interrupted', {agentId, turn: session.turn, reason: code}, session);
    this.emit('subagent/report', {agentId, kind: 'progress', reportId, summary, tokens: {...session.tokens}}, session);
    this.emit('subagent/finished', {
      agentId, status: 'interrupted', summary, steps, turn: session.turn, tokens: {...session.tokens},
    }, session);
    this.write('wake/subagent', {
      agentId, parentCallId: session.parentCallId, status: 'interrupted', kind: 'progress',
      summary, tokens: {...session.tokens}, reportId,
    }, 'model', null);
  }

  /**
   * P3.2.1：一次激活跑满 `maxTurns` 的收尾。
   *
   * 为什么是 `interrupted` 而不是 `completed`/`cancelled`：活没干完，但也不是失败——会话、队列、
   * workspace 全留着，父代理 `subagent({action:"message"})`/resume 就能继续（"父可 resume/继续"的落点）。
   * 为什么必须写 report + wake：上限是**框架替它停的手**，父代理下一轮必须知道"它不是想完了，
   * 是被叫停了、队列里还有几条"，否则会把暂停读成完成。
   * 语义是**每次激活的额度**（delegate 首次、每次 resume 各自重新起算）：累计值会让"父可继续"
   * 变成空话——一 resume 就立刻再撞上限。
   */
  private settleMaxTurns(session: AgentSession, maxTurns: number, steps: number): void {
    const agentId = session.agentId;
    const pending = session.pendingMessages.length;
    const reportId = `report-${agentId}-${session.turn}-max-turns`;
    const summary = `已达到 maxTurns 上限（本次运行 ${maxTurns} 轮），子代理已停止调用模型，`
      + '会话、队列与 workspace 均保留。'
      + (pending > 0 ? `队列里还有 ${pending} 条消息。` : '')
      + '父代理可以 resume 或追加消息让它继续（每次恢复重新起算 maxTurns）。';
    session.status = 'interrupted';
    session.error = 'max-turns';
    session.updatedAt = this.deps.now();
    this.save(session);
    this.emit('subagent/interrupted', {agentId, turn: session.turn, reason: 'max-turns', maxTurns}, session);
    this.emit('subagent/report', {
      agentId, kind: 'progress', reportId, summary, tokens: {...session.tokens},
    }, session);
    this.emit('subagent/finished', {
      agentId, status: 'interrupted', summary, steps, turn: session.turn, tokens: {...session.tokens},
    }, session);
    this.write('wake/subagent', {
      agentId, parentCallId: session.parentCallId, status: 'interrupted', kind: 'progress',
      summary, tokens: {...session.tokens}, reportId,
    }, 'model', null);
  }

  private profilePersona(base: AgentLoopPersona, profile: SubagentProfile): AgentLoopPersona {
    if (profile.systemPrompt.trim() === '') return base;
    return {
      ...base,
      identity: `${base.identity}\n\n## Profile: ${profile.label} (${profile.id})\n${profile.systemPrompt.trim()}`,
      personaHash: `${base.personaHash}:profile-${profile.id}`,
    };
  }

  private initialText(session: AgentSession): string {
    const head = `[子任务]\n${session.task}`;
    const context = session.context === '' ? '' : `\n\n[必要材料]\n${session.context}`;
    const profileContext = session.forkFromSeq === undefined ? this.profiles.contextText(session.profileId) : '';
    return `${head}${context}${profileContext === '' ? '' : `\n\n[Profile 上下文]\n${profileContext}`}`;
  }

  private async recoverInterrupted(): Promise<void> {
    const events = await (async () => {
      try {
        const out: AppEvent[] = [];
        for await (const event of this.deps.log.readAll()) out.push(event);
        return out;
      } catch {
        return [] as AppEvent[];
      }
    })();
    for (const session of this.sessions.values()) {
      if (!['running', 'waiting', 'reporting'].includes(session.status)) continue;
      const open = events.filter((event) => event.parentCallId === session.parentCallId && event.type === 'turn/start')
        .map((event) => (event.data as {turn: number}).turn)
        .filter((turn) => !events.some((event) => event.parentCallId === session.parentCallId
          && event.type === 'turn/end' && (event.data as {turn: number}).turn === turn));
      const turn = open.length > 0 ? Math.max(...open) : session.turn;
      if (open.length > 0) {
        this.write('turn/end', {turn, reason: {kind: 'interrupted'}, spoke: false}, 'internal', session);
      }
      session.status = 'interrupted';
      session.updatedAt = this.deps.now();
      this.save(session);
      this.emit('subagent/interrupted', {agentId: session.agentId, turn, reason: 'restart'}, session);
    }
  }

  private emit(type: string, data: Record<string, unknown>, session: AgentSession | null): void {
    this.write(type, data, defaultVisibility(type), session);
  }

  private write(type: string, data: unknown, visibility: 'model' | 'internal' | 'debug', session: AgentSession | null): AppEvent {
    const event = {
      seq: this.deps.log.nextSeq(),
      ts: this.deps.now(),
      type,
      data,
      visibility,
      origin: 'runtime/subagent-manager',
      ...(session === null ? {} : {parentCallId: session.parentCallId, agentId: session.agentId}),
    } as unknown as AppEvent;
    this.deps.log.append(event, {sync: true});
    if (session === null) applyOne(this.deps.projection, event);
    else applySubagentEvent(this.deps.projection, event);
    return event;
  }

  private workspacePath(agentId: string): string {
    const sessionDir = resolve(this.sessionsDir, agentId);
    const path = resolve(sessionDir, 'workspace');
    if (!path.startsWith(this.sessionsDir + sep)) throw new Error('workspace-invalid');
    return path;
  }

  private sessionPath(agentId: string): string {
    return resolve(this.sessionsDir, agentId, 'session.json');
  }

  private save(session: AgentSession): void {
    writeJsonAtomic(this.sessionPath(session.agentId), session);
    this.sessions.set(session.agentId, session);
  }

  private load(agentId: string): AgentSession | null {
    if (!/^sub-[0-9a-f-]{8,}$/u.test(agentId)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.sessionPath(agentId), 'utf8')) as unknown;
      return isSession(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private loadAll(): AgentSession[] {
    const out: AgentSession[] = [];
    if (!existsSync(this.sessionsDir)) return out;
    for (const name of readdirSync(this.sessionsDir)) {
      const session = this.load(name);
      if (session !== null) out.push(session);
    }
    return out;
  }
}

/**
 * 子代理工具族（P1 后台运行时）。**只有两件**：
 *
 *   · `delegate` —— 创建会话、立即返回 agentId（后台跑，不阻塞父 turn）；
 *   · `subagent` —— 控制面合并入口，`action` 三选一：`status` / `message` / `cancel`。
 *
 * 为什么从四件并成两件（2026-11-05）：`subagent_message` / `subagent_cancel` /
 * `subagent_status` 三件各只回答一件事，却让父模型每轮都为三份 schema 付费；它们的
 * 共同对象（agentId）与共同前缀（subagent）本来就是一回事。合并后旧三件**不再注册**，
 * 能力一件不少：三个动作都直接复用 `SubagentManager` 的 `status/list`、`message`、`cancel`。
 *
 * `action` 必填、无默认动作（与 `timer` 同一条纪律）：漏写 `action` 得到一句明确的参数错，
 * 而不是被静默解释成 `status`。参数校验全部在 handler 里做（不依赖 JSON schema 的
 * `oneOf` / 条件必填）：现有工具体系只把 schema 交给模型，运行期不做条件校验。
 *
 * `subagents.enabled=false` 时**返回空数组**：`main.ts` 的 `if` 已经挡过一次，这里是第二道
 * （也让"默认关闭 ⇒ 工具清单不变"成为可执行断言，而不只是装配点的一行判断）。
 */
/**
 * 父代理工具回执用的精简视图：`status` 不把 task/context/tokens 和完整 lastReport 塞回上下文。
 * 管理只需要身份、状态、能否续聊/取消，以及一段报告预览；完整报告仍在事件流与会话页。
 */
const STATUS_LIST_REPORT_CHARS = 120;
const STATUS_SINGLE_REPORT_CHARS = 600;

function truncateStatusText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function compactStatusView(view: Record<string, unknown>, reportLimit: number): Record<string, unknown> {
  const report = typeof view['lastReport'] === 'string' ? view['lastReport'] : null;
  const error = typeof view['headError'] === 'string' ? view['headError'] : null;
  return {
    agentId: view['agentId'],
    profileId: view['profileId'],
    ...(typeof view['profileLabel'] === 'string' ? {profileLabel: view['profileLabel']} : {}),
    ...(view['profileLegacy'] === true ? {profileLegacy: true} : {}),
    status: view['status'],
    turn: view['turn'],
    resumeCount: view['resumeCount'],
    updatedAt: view['updatedAt'],
    canResume: view['canResume'],
    canCancel: view['canCancel'],
    ...(report === null || report === '' ? {} : {
      lastReportPreview: truncateStatusText(report, reportLimit),
      lastReportChars: report.length,
    }),
    ...(error === null || error === '' ? {} : {error: truncateStatusText(error, 300)}),
  };
}

export function createSubagentTools(manager: SubagentManager): ToolDefinition[] {
  if (!manager.enabled) return [];

  const delegate: ToolDefinition = {
    name: 'delegate',
    description: '派一个后台子代理，立即返回 handle。它有自己的持久会话与 workspace，完成后会唤醒你。',
    parameters: {
      type: 'object',
      properties: {
        profile: {type: 'string', description: '子代理 Profile（兼容旧参数）；默认 general'},
        profileId: {type: 'string', description: '角色包 id：researcher/worker/scribe；默认 general'},
        task: {type: 'string', description: '完整、自足的任务描述'},
        context: {type: 'string', description: '可选材料；不继承父上下文'},
        projectRoot: {type: 'string', description: 'worker 的项目目录；必须在宿主授权根内；不给则 worker 在 workspace 工作'},
        fork: {type: 'boolean', description: 'P2：带父已完成 turn 前缀（复用缓存），默认 false'},

      },
      required: ['task'],
      additionalProperties: false,
    },
    executionMode: 'parallel',
    sideEffect: 'none',
    timeoutMs: 10_000,
    handler: async (args, ctx): Promise<ToolHandlerResult> => {
      try {
        const row = args as Record<string, unknown>;
        const handle = await manager.delegate({
          ...(typeof row['profile'] === 'string' ? {profile: row['profile']} : {}),
          ...(typeof row['profileId'] === 'string' ? {profileId: row['profileId']} : {}),
          task: typeof row['task'] === 'string' ? row['task'] : '',
          ...(typeof row['context'] === 'string' ? {context: row['context']} : {}),
          ...(typeof row['projectRoot'] === 'string' ? {projectRoot: row['projectRoot']} : {}),
          ...(row['fork'] === true ? {fork: true} : {}),
        }, {callId: ctx.callId, turn: ctx.turn});
        return okResult(JSON.stringify(handle));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = message.startsWith('profile-locked:') ? 'profile-locked'
          : ['profile-unknown', 'subagents-disabled', 'reasoning-effort-unsupported', 'context-limit-unsupported',
            'project-root-required', 'project-root-unauthorized', 'project-root-invalid', 'project-root-not-allowed'].includes(message)
            ? message : 'delegate-failed';
        return errorResult(message, code);
      }
    },
  };

  /** 三个动作的唯一取值表：schema 的 enum 与报错文案都从它来（不手写第二份） */
  const SUBAGENT_ACTIONS = ['status', 'message', 'cancel'] as const;
  type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];

  /**
   * 读 `action`：缺字段与非法取值分别给一句能照着改的话。
   * 缺字段走 `requiredString`（"缺少必填参数 action"，与全仓其它工具同一条措辞）；
   * 非法取值单独判——`action=kill` 必须报"只能是 status / message / cancel"。
   */
  const readAction = (args: Record<string, unknown>): SubagentAction => {
    const action = requiredString(args, 'action', {maxLength: 16});
    if (!(SUBAGENT_ACTIONS as readonly string[]).includes(action)) {
      throw new ToolArgumentError(
        'action',
        `subagent 的 action 只能是 ${SUBAGENT_ACTIONS.join(' / ')}，收到 ${JSON.stringify(action)}：`
        + 'status 查看、message 续聊、cancel 取消。',
      );
    }
    return action as SubagentAction;
  };

  /** message / cancel 的必填对象：缺了就报 `agentId`，而不是拿空串去查一个不存在的会话 */
  const readAgentId = (args: Record<string, unknown>): string =>
    requiredString(args, 'agentId', {maxLength: 128});

  /** action=status：给 agentId 查单条（归档也查得到），不给则列出未归档摘要 */
  const statusAction = (args: Record<string, unknown>): ToolHandlerResult => {
    const agentId = optionalString(args, 'agentId', {maxLength: 128});
    if (agentId !== undefined) {
      const view = manager.status(agentId);
      if (view === null) {
        return errorResult(
          `找不到子代理 ${agentId}（subagent-not-found）：用 subagent({action:"status"}) 看现有会话。`,
          'subagent-not-found',
        );
      }
      // 回执只给管理所需的精简字段；完整报告看事件流/会话页，不塞回父上下文。
      return okResult(JSON.stringify(compactStatusView(view, STATUS_SINGLE_REPORT_CHARS)));
    }
    // 不传 agentId = 全部未归档摘要；includeArchived 才把归档区一并列出。
    const includeArchived = optionalBoolean(args, 'includeArchived', false);
    return okResult(JSON.stringify({
      items: manager.list(includeArchived)
        .map((view) => compactStatusView(view, STATUS_LIST_REPORT_CHARS)),
    }));
  };

  /** action=message：运行中入 inbox，完成/中断则自动 resume（语义全在 manager.message） */
  const messageAction = (args: Record<string, unknown>): ToolHandlerResult => {
    const agentId = readAgentId(args);
    const message = requiredString(args, 'message', {maxLength: 16_000});
    if (message.trim() === '') {
      throw new ToolArgumentError('message', 'message 不能为空：写一句要子代理接着做什么。');
    }
    try {
      return okResult(JSON.stringify(manager.message(agentId, message)));
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error), 'subagent-message-failed');
    }
  };

  /** action=cancel：queued 直接取消，running 触发 AbortSignal（语义全在 manager.cancel） */
  const cancelAction = (args: Record<string, unknown>): ToolHandlerResult => {
    const agentId = readAgentId(args);
    const reason = optionalString(args, 'reason', {maxLength: 200});
    try {
      const result = reason === undefined ? manager.cancel(agentId) : manager.cancel(agentId, reason);
      return okResult(JSON.stringify(result));
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error), 'subagent-cancel-failed');
    }
  };

  return [
    delegate,
    {
      name: 'subagent',
      description:
        '管理后台子代理（id 由 delegate 返回）。action 三选一：status 查看精简摘要（可给 agentId；'
        + '缺省全部未归档，includeArchived 含归档）；message 续聊（agentId + message，完成/中断会自动 resume）；'
        + 'cancel 取消（agentId）。完整报告看事件流/会话页，status 只回身份、状态和短预览。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...SUBAGENT_ACTIONS],
            description: 'status 查看 / message 续聊 / cancel 取消',
          },
          agentId: {type: 'string', description: '子代理 id（delegate 的返回值）；status 缺省 = 全部'},
          message: {type: 'string', description: 'message：要追加的一句话；子代理结束后自动续跑'},
          includeArchived: {type: 'boolean', description: 'status：同时列出已归档（缺省 false）'},
          reason: {type: 'string', description: 'cancel：取消原因（可选）'},
        },
        required: ['action'],
        additionalProperties: false,
      },
      // message / cancel 有顺序语义（旧三件里这两件就是 exclusive）；status 跟着它走，
      // 代价只是多一道屏障，换来的是"取消不会被同一步里的 status 重叠掉"。
      executionMode: 'exclusive',
      sideEffect: 'none',
      timeoutMs: 10_000,
      handler: async (rawArgs): Promise<ToolHandlerResult> => {
        try {
          const args = argsRecord(rawArgs, 'subagent');
          const action = readAction(args);
          if (action === 'status') return statusAction(args);
          if (action === 'message') return messageAction(args);
          return cancelAction(args);
        } catch (error) {
          // 参数错误（缺 action/agentId/message、未知 action）走 E_INVALID_ARGS，模型能自己改
          return errorResultFromThrown(error, TOOL_ERROR_CODES.invalidArgs);
        }
      },
    },
  ];
}

export const SUBAGENT_TOOL_NAMES = ['delegate', 'subagent'] as const;
