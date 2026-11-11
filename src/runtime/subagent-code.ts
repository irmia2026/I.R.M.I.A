/**
 * Irmia Agent — worker 专用本地 codegraph 工具（`code`）
 *
 * 目标：把 `_devkit-open/tools/codegraph.py` 的代码理解能力以**本地脚本**形态接给 worker
 * 子代理，不引入 MCP、不部署、不重启宿主。一个工具五个动作：
 *
 *   code({action:'index'})   建/增量索引（DB 在本会话 workspace，项目只读）
 *   code({action:'explore'}) 查符号 / 自然语言 / “从 A 到 B”调用链
 *   code({action:'impact'})  文件变更影响面（反向调用者 BFS）
 *   code({action:'pack'})    调用链源码打包（callers/callees/both）
 *   code({action:'status'})  索引健康、语言覆盖、缺失 grammar、不支持语言（如实报 Dart）
 *
 * ## 边界与安全口径（必须与实现一致，不要宣传成沙箱）
 *
 *   · **只给 worker**：由 `subagent-manager.ts` 按 `profile.id === 'worker'` 且非 fork/head
 *     路径注入；Profile 数据里写 `code` 仍会被 capability 表判为 unknown 而拒绝（本工具
 *     不经过 `subagent-capabilities.ts` 的白名单——它是执行器按角色装配的内建工具，
 *     与 `pwsh` 同一条纪律）。
 *   · **项目只读**：`index` 只把 `symbols/edges/sym_fts` 写进 `<session workspace>/.codegraph/
 *     codegraph.db`；Python 侧还会再校验一次 DB 必须落在 workspace 内（纵深防御）。
 *   · **项目边界**：`projectDir` 缺省 = 会话 projectRoot；只接受 projectRoot 内的真实目录
 *     （resolve + realpath + stat，越界/不存在都不 spawn）。被索引项目内不写任何文件。
 *   · **超时/取消/输出上限**：spawn 子进程（shell:false），每次调用独立超时；AbortSignal
 *     触发时杀**整棵进程树**（Windows 用 taskkill /T /F）；stdout/stderr 有硬上限。
 *   · **不是安全沙箱**：Python 进程以同一用户权限运行，能读到同一用户可读的东西。这里
 *     只保证“本工具不会把路径指到项目外、不会把 DB 写进项目里”，不承诺内核级隔离。
 *
 * ## 路径解析（dev 仓库 / 安装版都要能找到；**单一路径**）
 *
 * 脚本在 `<应用根>/packs/subagents/tools/codegraph/code_cli.py`。本模块在 dev 是
 * `src/runtime/`、装完是 `<安装根>/dist/runtime/`，两种布局下 `../..` 都正好是应用根。
 * **不依赖 process.cwd()**——安装版后端的 cwd 是数据目录下的 workspace，拿它当资源根会
 * 永远找不到脚本（P4.4 踩过的同类坑）。
 *
 * 候选里**没有** `<应用根>/dist/packs/...`（2026-11-05 删除）：那是"只搬运 dist"的旧布局
 * 留下的第二解析路径，与内置包安装（`subagent-packages.ts` 只认 `<应用根>/packs/`）不一致。
 * 装配链现在把 `packs/` 整棵搬到**包根**（`packaging/builtin-payload.mjs`），
 * `scripts/copy-assets.mjs` 也不再往 `dist/packs` 复制——同一份资源只有一个根，坏了只有一处能修。
 */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  argsRecord, errorResult, errorResultFromThrown, okResult, optionalBoolean, optionalInteger,
  optionalString, requiredString, TOOL_ERROR_CODES, ToolArgumentError,
  type ToolDefinition,
} from '../tools/types.ts';
import { scopedShellEnv } from './subagent-shell.ts';
import { resolvePythonBinary } from './python-probe.ts';
import { inside } from './subagent-workspace.ts';

const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * 应用资源根：dev 是 `<repo>`；dist 是 `<安装根>`（`<安装根>/dist/runtime` 往上两级）。
 * 与 `subagent-packages.ts` 的 MODULE_RESOURCE_ROOT 同一口径，但本模块不 import 它，
 * 免得把整个内置包安装器（含 fetch/归档）拉进代码工具链。
 */
const APPLICATION_ROOT = resolve(moduleDir, '..', '..');

export const CODE_TOOL_NAME = 'code';

/** `index` 可能扫一棵大项目，给更宽的默认超时；其余动作是查询。 */
export const DEFAULT_CODE_TIMEOUT_MS = 120_000;
export const INDEX_CODE_TIMEOUT_MS = 300_000;
export const MAX_CODE_TIMEOUT_MS = 300_000;

/** stdout 上限：pack 最深 2000 行源码，正常远低于此；超限视为异常并报错，不做半截 JSON。 */
export const MAX_CODE_STDOUT_CHARS = 1_000_000;
export const MAX_CODE_STDERR_CHARS = 64_000;
const MAX_QUERY_CHARS = 500;
const MAX_TARGET_CHARS = 200;
const MAX_FILEPATHS = 50;
const MAX_IMPACT_DEPTH = 8;
const MAX_PACK_DEPTH = 5;
const PACK_MODES = ['callers', 'callees', 'both'] as const;
const CODE_ACTIONS = ['index', 'explore', 'impact', 'pack', 'status'] as const;

export type CodeAction = (typeof CODE_ACTIONS)[number];
export type CodePackMode = (typeof PACK_MODES)[number];

export interface CodeCliInput {
  file: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface CodeCliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
  /** spawn 失败（解释器/脚本不存在等）；有它时 code 通常 null。 */
  spawnError?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export type CodeCliRunner = (input: CodeCliInput) => Promise<CodeCliResult>;

export interface CodeToolOptions {
  profileId: string;
  workspace: string;
  /** 会话已授权的项目根；没有它则不注入（worker 的设计任务可以在没有项目根时跑）。 */
  projectRoot?: string | undefined;
  agentId: string;
  emit?: ((data: Record<string, unknown>) => void) | undefined;
  /** 测试/替代注入：解释器、CLI 脚本、命令执行器、环境基座。 */
  pythonPath?: string | undefined;
  cliPath?: string | undefined;
  baseEnv?: NodeJS.ProcessEnv | undefined;
  runner?: CodeCliRunner | undefined;
  /** 测试用：压缩/放大每个动作的超时。生产不传。 */
  timeoutOverrides?: Partial<Record<CodeAction, number>> | undefined;
}

/**
 * `code_cli.py` 的定位候选（按优先级）。第一个存在的即用。
 * `IRMIA_CODEGRAPH_CLI` 是给测试/排障的显式覆盖；找不到脚本时工具仍会注册，调用时
 * 返回明确错误（安装布局缺文件是部署事故，静默少一件工具更难查）。
 */
export function codeCliCandidates(): string[] {
  const override = process.env['IRMIA_CODEGRAPH_CLI'];
  const out: string[] = [];
  if (typeof override === 'string' && override.trim() !== '') out.push(resolve(override.trim()));
  // 唯一权威路径：应用根 packs/（dev = 仓库根；装完 = 安装根）。装配链整棵拷到包根。
  out.push(resolve(APPLICATION_ROOT, 'packs', 'subagents', 'tools', 'codegraph', 'code_cli.py'));
  // 最后才看 cwd：只作为“有人从仓库根手工起”的兜底，不是主要判据。
  out.push(resolve(process.cwd(), 'packs', 'subagents', 'tools', 'codegraph', 'code_cli.py'));
  return [...new Set(out)];
}

export function resolveCodeCliPath(override?: string): { path: string | null; candidates: string[] } {
  const candidates = override !== undefined && override.trim() !== ''
    ? [resolve(override.trim()), ...codeCliCandidates()]
    : codeCliCandidates();
  for (const candidate of candidates) if (existsSync(candidate)) return {path: candidate, candidates};
  return {path: null, candidates};
}

/** 子进程环境：复用 role-scoped pwsh 的最小环境（过滤凭据），再加 Python/编码相关开关。 */
export function codeCliEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...scopedShellEnv(baseEnv),
    // 不写 __pycache__：脚本住在仓库/安装根里，字节码缓存会污染发布树。
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };
}

function readProjectRoot(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null;
  try {
    const real = realpathSync.native(resolve(raw));
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function readProjectDir(input: string | undefined, root: string): {ok: true; dir: string} | {ok: false; message: string} {
  if (input !== undefined && input.includes('\0')) {
    return {ok: false, message: 'projectDir 不能含 NUL'};
  }
  if (input !== undefined && input.length > 1000) {
    return {ok: false, message: 'projectDir 过长（上限 1000 字符）'};
  }
  if (input !== undefined && input.trim() === '') return {ok: true, dir: root};
  const candidate = resolve(root, input ?? '.');
  try {
    const real = realpathSync.native(candidate);
    if (!statSync(real).isDirectory()) return {ok: false, message: 'projectDir 不是目录'};
    if (!inside(root, real)) {
      return {ok: false, message: 'projectDir 越出会话项目根：只允许项目根内的真实目录。'};
    }
    return {ok: true, dir: real};
  } catch {
    return {ok: false, message: 'projectDir 不存在或无法读取。'};
  }
}

function readAction(row: Record<string, unknown>): CodeAction {
  const action = requiredString(row, 'action', {maxLength: 16});
  if (!(CODE_ACTIONS as readonly string[]).includes(action)) {
    throw new ToolArgumentError(
      'action',
      `code 的 action 只能是 ${CODE_ACTIONS.join(' / ')}；收到 ${JSON.stringify(action)}。`
      + 'index 建索引、explore 查符号/调用链、impact 看变更影响、pack 打包源码、status 看健康。',
    );
  }
  return action as CodeAction;
}

function readFilepaths(row: Record<string, unknown>): string[] {
  const raw = row['filepaths'];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ToolArgumentError('filepaths', 'impact 需要非空的 filepaths 字符串数组（项目相对路径）。');
  }
  if (raw.length > MAX_FILEPATHS) {
    throw new ToolArgumentError('filepaths', `filepaths 最多 ${MAX_FILEPATHS} 个。`);
  }
  const out: string[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ToolArgumentError('filepaths', `filepaths[${index}] 必须是非空字符串。`);
    }
    out.push(item);
  }
  return out;
}

function timeoutFor(action: CodeAction, overrides: CodeToolOptions['timeoutOverrides']): number {
  const override = overrides?.[action];
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.min(Math.floor(override), MAX_CODE_TIMEOUT_MS);
  }
  return action === 'index' ? INDEX_CODE_TIMEOUT_MS : DEFAULT_CODE_TIMEOUT_MS;
}

function tail(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(-limit);
}

function parseJsonPayload(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  if (text === '') return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * CLI 的业务错误码 → 工具错误码。参数类错误让模型自己改（E_INVALID_ARGS），
 * 路径/边界类给 E_UNSAFE_PATH；其余保留 codegraph 自己的 code（可解释性优先）。
 */
function mapCliErrorCode(code: string | undefined): string {
  switch (code) {
    case 'invalid-args': return TOOL_ERROR_CODES.invalidArgs;
    case 'path-invalid':
    case 'path-outside-project':
    case 'project-root-invalid':
    case 'project-root-unauthorized':
    case 'db-outside-workspace':
      return TOOL_ERROR_CODES.unsafePath;
    case undefined: return 'code-action-failed';
    default: return code;
  }
}

function structured(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, null, 2);
}

/**
 * 创建 `code` 工具。
 *
 * 返回 null 的场景（都是**装配条件不满足**，不是执行错误）：
 *   · 不是 worker（researcher/scribe/general 永远拿不到）；
 *   · 没有 workspace（文件面不存在，DB 无处可放）；
 *   · 没有已授权 projectRoot（worker 的设计任务可以没有项目；此时 code 注入条件不成立，
 *     由 manager 决定回退到 workspace 版 worker）。
 */
export function createCodeTool(options: CodeToolOptions): ToolDefinition | null {
  if (options.profileId !== 'worker') return null;
  if (options.workspace.trim() === '' || !existsSync(options.workspace)) return null;
  const projectRoot = readProjectRoot(options.projectRoot);
  if (projectRoot === null) {
    options.emit?.({action: 'code-project-root-missing', profileId: options.profileId, agentId: options.agentId});
    return null;
  }
  const workspace = realpathSync.native(resolve(options.workspace));
  if (!statSync(workspace).isDirectory()) return null;
  const dbPath = join(workspace, '.codegraph', 'codegraph.db');
  const runner = options.runner ?? runCodeCliProcess;
  const pythonOverride = options.pythonPath;

  return {
    name: CODE_TOOL_NAME,
    description: '本地代码图：index 建/增量索引；explore 查符号或调用链；impact 看文件变更影响；'
      + 'pack 打包调用链源码；status 看索引健康、语言与 grammar 覆盖。索引只写本会话 workspace，'
      + '项目只读；Dart 等未支持语言如实报告。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...CODE_ACTIONS],
          description: 'index 建索引 / explore 查询 / impact 影响面 / pack 打包源码 / status 索引健康',
        },
        projectDir: {
          type: 'string',
          description: '被索引的项目目录（相对或绝对）；缺省 = 会话项目根；只允许项目根内路径，越界拒绝。',
        },
        incremental: {type: 'boolean', description: 'index：只重建有变更的文件（默认 false = 全量）'},
        query: {type: 'string', description: 'explore：符号名、自然语言，或「从 A 到 B」的调用链问题'},
        filepaths: {
          type: 'array', items: {type: 'string'},
          description: 'impact：变更的项目相对文件路径数组（如 ["src/app.py"]）',
        },
        maxDepth: {type: 'integer', description: 'impact：调用者 BFS 深度，1-8，默认 3'},
        target: {type: 'string', description: 'pack：目标符号名（支持 Class.method 或唯一短名）'},
        depth: {type: 'integer', description: 'pack：调用链深度，1-5，默认 2'},
        mode: {type: 'string', enum: [...PACK_MODES], description: 'pack：both（默认）/ callers / callees'},
      },
      required: ['action'],
      additionalProperties: false,
    },
    // 不标 destructive：它只写自己 workspace 里的索引 DB，不写项目；标 destructive 会被
    // 父配置的 destructiveEnabled 关掉，等于让 worker 的代码理解能力随无关开关消失。
    executionMode: 'exclusive',
    sideEffect: 'idempotent',
    timeoutMs: MAX_CODE_TIMEOUT_MS,
    handler: async (args, ctx) => {
      const started = Date.now();
      let codeAction: CodeAction | null = null;
      if (ctx.signal.aborted) {
        return errorResult('code 调用在开始前已被取消（AbortSignal）。', TOOL_ERROR_CODES.aborted);
      }
      try {
        const row = argsRecord(args, CODE_TOOL_NAME);
        const action = readAction(row);
        codeAction = action;
        const projectDirInput = optionalString(row, 'projectDir', {maxLength: 1000});
        const projectDir = readProjectDir(projectDirInput, projectRoot);
        if (!projectDir.ok) {
          return errorResult(`code 拒绝 projectDir：${projectDir.message}`, TOOL_ERROR_CODES.unsafePath);
        }

        const request: Record<string, unknown> = {
          action, projectDir: projectDir.dir, dbPath, workspaceRoot: workspace, allowedRoot: projectRoot,
        };
        if (action === 'index') {
          request['incremental'] = optionalBoolean(row, 'incremental', false);
        } else if (action === 'explore') {
          request['query'] = requiredString(row, 'query', {maxLength: MAX_QUERY_CHARS});
        } else if (action === 'impact') {
          request['filepaths'] = readFilepaths(row);
          request['maxDepth'] = optionalInteger(row, 'maxDepth', 3, {min: 1, max: MAX_IMPACT_DEPTH});
        } else if (action === 'pack') {
          request['target'] = requiredString(row, 'target', {maxLength: MAX_TARGET_CHARS});
          request['depth'] = optionalInteger(row, 'depth', 2, {min: 1, max: MAX_PACK_DEPTH});
          const mode = optionalString(row, 'mode', {maxLength: 16});
          if (mode !== undefined && !(PACK_MODES as readonly string[]).includes(mode)) {
            throw new ToolArgumentError('mode', `pack 的 mode 只能是 ${PACK_MODES.join(' / ')}，收到 ${JSON.stringify(mode)}。`);
          }
          request['mode'] = mode ?? 'both';
        }

        const cli = resolveCodeCliPath(options.cliPath);
        if (cli.path === null) {
          options.emit?.({
            action: 'code-cli-missing', profileId: options.profileId, agentId: options.agentId,
            candidates: cli.candidates.length,
          });
          return errorResult(
            '找不到 codegraph 脚本 code_cli.py（安装布局缺 packs/subagents/tools/codegraph/）。'
            + '已尝试：' + cli.candidates.join('；')
            + '。这是部署问题：请让宿主补回该目录，不要在项目里手工建索引。',
            TOOL_ERROR_CODES.noRuntime,
          );
        }
        const python = pythonOverride ?? resolvePythonBinary();
        if (python === null) {
          options.emit?.({action: 'code-python-missing', profileId: options.profileId, agentId: options.agentId});
          return errorResult(
            '找不到可用的 Python 解释器：code 工具需要一个能 import tree-sitter 的 python。'
            + '安装 Python 并装齐 tree-sitter 语法包后重试（healthcheck 会同时把 worker 锁成 missing）。',
            TOOL_ERROR_CODES.noRuntime,
          );
        }

        const timeoutMs = timeoutFor(action, options.timeoutOverrides);
        const stdin = JSON.stringify(request);
        const result = await runner({
          file: python,
          args: [cli.path],
          cwd: workspace,
          env: codeCliEnv(options.baseEnv),
          stdin,
          signal: ctx.signal,
          timeoutMs,
        });
        const durationMs = Date.now() - started;
        const stdout = tail(result.stdout, MAX_CODE_STDOUT_CHARS);
        const stderr = tail(result.stderr, MAX_CODE_STDERR_CHARS);
        const payload = parseJsonPayload(stdout);
        const ok = payload?.['ok'] === true && result.spawnError === undefined
          && !result.timedOut && !result.aborted && !result.stdoutTruncated;

        options.emit?.({
          action: 'code', codeAction: action, profileId: options.profileId, agentId: options.agentId,
          ok, durationMs, timeoutMs, requestBytes: Buffer.byteLength(stdin, 'utf8'),
          stdoutChars: result.stdout.length, stderrChars: result.stderr.length,
          ...(result.timedOut ? {timedOut: true} : {}),
          ...(result.aborted ? {aborted: true} : {}),
          ...(result.stdoutTruncated ? {stdoutTruncated: true} : {}),
          ...(result.spawnError === undefined ? {} : {spawnError: result.spawnError}),
          ...(typeof payload?.['error_code'] === 'string' ? {cliErrorCode: payload['error_code']} : {}),
        });

        if (result.spawnError !== undefined) {
          return errorResult(
            `codegraph 子进程启动失败（${result.spawnError}）：检查 Python 解释器与脚本路径。`,
            TOOL_ERROR_CODES.spawnFailed,
          );
        }
        if (result.timedOut) {
          return errorResult(
            `code({action:'${action}'}) 超时（${timeoutMs}ms，已杀进程树）；大项目可先缩小 projectDir 再 index。`,
            TOOL_ERROR_CODES.timeout,
          );
        }
        if (result.aborted) {
          return errorResult(`code({action:'${action}'}) 已取消（AbortSignal）。`, TOOL_ERROR_CODES.aborted);
        }
        if (result.stdoutTruncated) {
          return errorResult(
            `codegraph 输出超过 ${MAX_CODE_STDOUT_CHARS} 字符上限，已截断且无法得到完整 JSON；`
            + '请缩小查询范围（更精确的 query/target 或更小 projectDir）。',
            TOOL_ERROR_CODES.tooLarge,
          );
        }
        if (payload === null) {
          const detail = stderr.trim() !== '' ? `\nstderr:\n${stderr}` : '';
          return errorResult(
            `codegraph 没有返回合法 JSON（exit=${result.code ?? 'null'}）。${detail}`,
            'code-action-failed',
          );
        }

        if (payload['ok'] !== true) {
          const code = mapCliErrorCode(typeof payload['error_code'] === 'string' ? payload['error_code'] : undefined);
          const enriched = {action, projectDir: projectDir.dir, ...payload};
          return errorResult(structured(enriched), code);
        }

        return okResult(structured({action, projectDir: projectDir.dir, ...payload}));
      } catch (error) {
        if (error instanceof ToolArgumentError) {
          options.emit?.({action: 'code', codeAction, profileId: options.profileId, agentId: options.agentId, ok: false, durationMs: Date.now() - started, invalidArgs: true});
          return errorResultFromThrown(error, TOOL_ERROR_CODES.invalidArgs);
        }
        options.emit?.({action: 'code', codeAction, profileId: options.profileId, agentId: options.agentId, ok: false, durationMs: Date.now() - started});
        return errorResultFromThrown(error, 'code-action-failed');
      }
    },
  };
}

/**
 * 默认执行器：spawn Python（参数不经 shell），喂 stdin JSON，收 stdout/stderr。
 * 超时/取消都杀进程树——只 kill 根进程会留下 python 子进程（Windows 上尤其明显）。
 */
export function runCodeCliProcess(input: CodeCliInput): Promise<CodeCliResult> {
  return new Promise((resolveResult) => {
    let child: ReturnType<typeof spawn> | null = null;
    try {
      child = spawn(input.file, [...input.args], {
        cwd: input.cwd, shell: false, windowsHide: true, env: input.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolveResult({
        code: null, stdout: '', stderr: '', aborted: false, timedOut: false,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      resolveResult({
        code, stdout, stderr, aborted: input.signal.aborted, timedOut,
        ...(stdoutTruncated ? {stdoutTruncated: true} : {}),
        ...(stderrTruncated ? {stderrTruncated: true} : {}),
      });
    };
    const killTree = (): void => {
      if (child?.pid === undefined) return;
      if (process.platform === 'win32') {
        try {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true, stdio: 'ignore', shell: false,
          });
          killer.on('error', () => undefined);
        } catch {
          try { child.kill(); } catch { /* already gone */ }
        }
      } else {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    };
    const onAbort = (): void => { killTree(); };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, input.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length >= MAX_CODE_STDOUT_CHARS) { stdoutTruncated = true; return; }
      stdout += chunk.toString('utf8');
      if (stdout.length > MAX_CODE_STDOUT_CHARS) {
        stdout = stdout.slice(0, MAX_CODE_STDOUT_CHARS);
        stdoutTruncated = true;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length >= MAX_CODE_STDERR_CHARS) { stderrTruncated = true; return; }
      stderr += chunk.toString('utf8');
      if (stderr.length > MAX_CODE_STDERR_CHARS) {
        stderr = stderr.slice(0, MAX_CODE_STDERR_CHARS);
        stderrTruncated = true;
      }
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      resolveResult({
        code: null, stdout, stderr, aborted: false, timedOut,
        spawnError: error instanceof Error ? error.message : String(error),
      });
    });
    child.on('close', finish);
    input.signal.addEventListener('abort', onAbort, {once: true});
    if (input.signal.aborted) onAbort();
    if (child.stdin !== null && child.stdin !== undefined) {
      child.stdin.on('error', () => undefined);
      child.stdin.write(input.stdin, 'utf8');
      child.stdin.end();
    }
  });
}
