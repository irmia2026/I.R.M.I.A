/**
 * Irmia Agent — 子代理角色 scoped pwsh（P4.5 / 收尾，2026-11-05 加 `full` 档）
 *
 * 背景：P4.3 的 B 方案只给了 `scoped_command`（固定命令、`shell:false`），与用户要求的
 * “researcher 只有 workspace 的 pwsh，worker/scribe 有 full pwsh”
 * 不一致。本模块把 Profile 的 `shell` 字段真正接到一个**角色级 pwsh 工具**上：
 *
 *   · `shell:'workspace'` ⇒ 只给 workspace 根；
 *   · `shell:'project'`   ⇒ 给 project 根（主）+ 本会话 workspace（次，worker 需要）；
 *   · `shell:'auto'`      ⇒ 由调用方先按“会话有没有 projectRoot”折算成上面两种之一
 *                            （manager 负责折算；本工具只接受已经确定的两档）；
 *   · `shell:'full'`      ⇒ **仅 worker**：cwd 固定 session workspace，命令可 cd/访问任意
 *                            绝对路径、执行任意命令；不做路径/命令审计，只保留输出上限、
 *                            超时、AbortSignal 与最小环境（见 {@link createFullPwshTool}）；
 *   · `shell:'none'`      ⇒ 不产出工具（general / fork 一律没有）。
 *
 * ## 边界：workspace/project 是 cwd + 命令审计；full 只剩执行资源边界——**都不是安全沙箱**
 *
 * Windows 上没有 Job Object / AppContainer / 受限令牌这一层真实隔离：同一个用户权限下
 * 子进程本来就能读整台机器的文件（只要它拿得到绝对路径）。因此本模块**不宣称**
 * “workspace-only 沙箱”。两档的实际差别：
 *
 *   · `workspace`/`project`：① cwd 固定；② 静态命令审计（根外绝对路径 / UNC / 盘符相对路径 /
 *     `~` / `..` 越界段 / 切换 cwd 的 cmdlet / 嵌套 shell / 反射与进程逃逸 API / 家目录变量，
 *     执行前拒绝并落审计事件）；③ 最小环境；④ 输出截断 + 超时 + AbortSignal。
 *   · `full`（worker）：只有 ③④。cwd 默认 workspace，但命令里可以 `cd` 到任意目录、用任意
 *     绝对路径——这是“worker 是重度主力，外部目录靠 pwsh”的显式授权，不是漏洞。
 *
 * 仍然绕得过去的面（**必须如实承认**，尤其 full 档）：命令文本里用变量拼接、`[char]`、
 * `Invoke-Expression` 变形、读取 pwsh 自身进程环境之外的磁盘内容、同用户进程的注册表/服务/
 * 其它进程——**都没有**内核级隔离兜底；审计只是文本规则，且在 full 档下根本不启用。
 *
 * 所以产品侧的口径只能是：**角色 pwsh = cwd/审计（或 full 的无审计）+ 最小环境，不是沙箱**。
 * 与 `subagent-capabilities.ts` 的关系：`pwsh` 在 capability 表里仍是 `unsafe`（Profile
 * 数据不能声明它）；本工具由运行时按 `profile.shell` **注入**，`full` 还额外要求
 * `profileId === 'worker' || 'scribe'`（数据文件写了也拿不到）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { errorResult, okResult, TOOL_ERROR_CODES, type ToolDefinition } from '../tools/types.ts';
import { inside } from './subagent-workspace.ts';

/** 角色工具可选的根名。 */
export type ScopedPwshRoot = 'workspace' | 'project';

export interface ScopedPwshResult {
  code: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
  /** spawn 失败（二进制不存在等）时的原因；有它时 code 通常为 null。 */
  spawnError?: string;
}

export type ScopedPwshRunner = (input: {
  file: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
}) => Promise<ScopedPwshResult>;

export interface ScopedPwshOptions {
  profileId: string;
  shell: 'workspace' | 'project' | 'full' | 'none';
  workspace: string;
  projectRoot?: string | undefined;
  agentId: string;
  emit?: ((data: Record<string, unknown>) => void) | undefined;
  runner?: ScopedPwshRunner | undefined;
  /** 环境变量基座；测试/替代注入用，缺省 process.env。 */
  baseEnv?: NodeJS.ProcessEnv | undefined;
}

/** 默认命令长度上限：超过就不审了，直接拒（审计本身也不该被超长文本拖垮）。 */
export const MAX_SCOPED_COMMAND_CHARS = 16_000;
export const DEFAULT_SCOPED_PWSH_TIMEOUT_MS = 180_000;
export const MAX_SCOPED_PWSH_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 64_000;

export interface ScopedShellAudit {
  ok: boolean;
  /** 拒绝原因码（ok=false 时必有）。 */
  code: string;
  /** 给模型看的一句话说明（不含路径）。 */
  message: string;
}

const OK_AUDIT: ScopedShellAudit = {ok: true, code: '', message: ''};

function deny(code: string, message: string): ScopedShellAudit {
  return {ok: false, code, message};
}

/**
 * 根外绝对路径：`C:\...` / `C:/...` / `C:`（盘符相对）/ UNC `\\server\share` / 当前盘根 `/...`。
 *
 * 正则只做**候选提取**，是否越界交给 `resolve + inside`；这样 `C:\project\src` 这种根内
 * 绝对路径不会被误杀（coder 经常需要写绝对路径），而 `C:\Windows` 会被拦。
 */
const DRIVE_ABSOLUTE = /(?:^|[\s"'`=;(,{|&])([A-Za-z]:(?:[\\/][^\s"'`;|&()]*)?)/gu;
const UNC_PATH = /(?:^|[\s"'`=;(,{|&])(\\\\[^\s"'`;|&()]*)/gu;
const ROOTED_PATH = /(?:^|[\s"'`=;(,{|&])([\\/][^\s"'`;|&()]*)/gu;
/** `..` 作为独立路径段：`cd ..`、`../x`、`..\x`、`a/../b`。`0..1`/`file..txt` 不会命中。 */
const PARENT_SEGMENT = /(?:^|[\s"'`=;(,{|\\/])\.\.(?=$|[\s"'`;),|&\\/])/u;
/** `~` 家目录展开（`~`、`~/x`、`~\x`）。 */
const HOME_EXPANSION = /(?:^|[\s"'`=;(,{|&])~(?=$|[\s"'`;),|&\\/])/u;

interface BlockedPattern {
  code: string;
  message: string;
  re: RegExp;
}

/**
 * 已知的越界写法。**按“执行器/API 名”拦，不按“命令实现”拦**：正常构建、测试、文件读写
 * （Get-ChildItem/Get-Content/Copy-Item/New-Item/npm/flutter/git/node）都不在表里。
 */
const BLOCKED_PATTERNS: readonly BlockedPattern[] = [
  {
    code: 'shell-cwd-locked',
    message: 'cwd 固定在授权根：拒绝 Set-Location/cd/pushd/popd 等切换工作目录的命令。',
    re: /(?:^|[\s"'`=;(,{|&])(?:set-location|pushd|popd|chdir|cd|sl)(?=$|[\s;"'`)|&])/iu,
  },
  {
    code: 'shell-drive-escape',
    message: '拒绝新建/切换 PSDrive（New-PSDrive/Set-PSDrive/Remove-PSDrive）。',
    re: /(?:^|[\s"'`=;(,{|&])(?:new-psdrive|set-psdrive|remove-psdrive)(?=$|[\s;"'`)|&])/iu,
  },
  {
    code: 'shell-process-escape',
    message: '拒绝起新进程/作业/计划任务（Start-Process/Start-Job/schtasks/Register-ScheduledTask）。',
    re: /(?:^|[\s"'`=;(,{|&])(?:start-process|start-job|register-scheduledtask|unregister-scheduledtask|schtasks)(?=$|[\s;"'`)|&])/iu,
  },
  {
    code: 'shell-nested-shell',
    message: '拒绝嵌套 shell/命令解释器（pwsh/powershell/cmd/wsl/bash/sh），命令必须在本工具里直接给出。',
    re: /(?:^|[\s"'`=;(,{|&])(?:pwsh|powershell|cmd|wsl|bash|sh)(?:\.exe)?(?=$|[\s;"'`)|&])/iu,
  },
  {
    code: 'shell-dynamic-exec',
    message: '拒绝动态代码执行（Invoke-Expression/iex/Add-Type），命令必须可被静态审计。',
    re: /(?:^|[\s"'`=;(,{|&])(?:invoke-expression|iex|add-type)(?=$|[\s;"'`)|&])/iu,
  },
  {
    code: 'shell-process-api',
    message: '拒绝通过 .NET 直接起进程/改当前目录（System.Diagnostics.Process、SetCurrentDirectory）。',
    re: /(?:system\.diagnostics\.process|setcurrentdirectory|\[environment\]::currentdirectory)/iu,
  },
  {
    code: 'shell-reflection',
    message: '拒绝反射/动态程序集（[System.Reflection、Assembly::Load）——静态审计不了的东西不给执行。',
    re: /(?:system\.reflection|assembly\]::load|assembly::load)/iu,
  },
  {
    code: 'shell-env-home',
    message: '拒绝引用家目录/用户目录环境变量（USERPROFILE/HOME/APPDATA/LOCALAPPDATA 等）。',
    re: /(?:\$(?:env:)?(?:userprofile|home|homedrive|homepath|appdata|localappdata|username|userdomain)|\$\{env:(?:userprofile|home|homedrive|homepath|appdata|localappdata|username|userdomain)\})/iu,
  },
  {
    code: 'shell-env-dump',
    message: '拒绝整表枚举环境变量（Env: drive）；需要某个变量请直接写变量名。',
    re: /(?:^|[\s"'`=;(,{|&])env:(?=$|[\s"'`;),|&])/iu,
  },
];

/**
 * 静态审计一条 pwsh 命令。返回 `ok:false` 时调用方**不许 spawn**。
 *
 * 规则顺序：长度/控制字符 → 家目录 → 已知越界写法 → 路径候选（拒绝根外/UNC/根路径/盘符）
 * → `..` 段。拒绝理由只写规则，不回显命令文本（命令里可能有敏感值）。
 */
export function auditShellCommand(
  command: string,
  roots: readonly string[],
): ScopedShellAudit {
  if (command.trim() === '') return deny('shell-empty', 'command 不能为空。');
  if (command.length > MAX_SCOPED_COMMAND_CHARS) {
    return deny('shell-too-long', `命令超过 ${MAX_SCOPED_COMMAND_CHARS} 字符上限，拒绝审计与执行。`);
  }
  if (command.includes('\0')) return deny('shell-null-byte', '命令里不允许出现 NUL。');
  if (HOME_EXPANSION.test(command)) {
    return deny('shell-env-home', '拒绝 `~` 家目录展开：命令只能使用授权根内的路径。');
  }
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.re.test(command)) return deny(pattern.code, pattern.message);
  }
  if (PARENT_SEGMENT.test(command)) {
    return deny('shell-parent-traversal', '拒绝路径里的 `..` 越界段：请使用授权根内的相对路径。');
  }
  const resolvedRoots = roots.map((root) => resolve(root));
  for (const candidate of pathCandidates(DRIVE_ABSOLUTE, command)) {
    if (!resolvedRoots.some((root) => inside(root, resolve(candidate)))) {
      return deny('shell-path-outside-root', '拒绝授权根外的绝对路径：命令只能使用 workspace/project 根内的路径。');
    }
  }
  for (const candidate of pathCandidates(ROOTED_PATH, command)) {
    // `C:\x` 这种已被盘符正则覆盖；这里处理 `/x`、`\x` 这类“当前盘根”写法。
    if (/^[\\/]{2}/u.test(candidate)) continue; // UNC 由下一条规则处理，避免 URL 误伤
    const resolved = resolve(candidate);
    if (!resolvedRoots.some((root) => inside(root, resolved))) {
      return deny('shell-path-outside-root', '拒绝授权根外的绝对路径：命令只能使用 workspace/project 根内的路径。');
    }
  }
  for (const candidate of pathCandidates(UNC_PATH, command)) {
    const resolved = resolve(candidate);
    if (!resolvedRoots.some((root) => inside(root, resolved))) {
      return deny('shell-path-outside-root', '拒绝授权根外的绝对路径：命令只能使用 workspace/project 根内的路径。');
    }
  }
  return OK_AUDIT;
}

function pathCandidates(re: RegExp, command: string): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  for (const match of command.matchAll(re)) {
    const value = match[1];
    if (value !== undefined && value !== '' && !out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * `shell:'full'` 的**执行前自检**（不是安全审计）：只拦空命令/超长/NUL 这类一定跑不出结果的
 * 输入，路径、cd、嵌套 shell、进程逃逸一概放行——这一档的语义就是“worker 的完整终端”。
 *
 * 为什么还留一道：空命令会让 pwsh 直接成功返回空输出，模型会把“什么都没做”当成“做完了”；
 * 超长命令有命令行长度上限，截断执行比拒绝更危险。**不要**往这里加路径/命令黑名单：
 * full 模式和 `workspace/project` 两档不是同一个产品承诺（见文件头）。
 */
export function auditFullShellCommand(command: string): ScopedShellAudit {
  if (command.trim() === '') return deny('shell-empty', 'command 不能为空。');
  if (command.length > MAX_SCOPED_COMMAND_CHARS) {
    return deny('shell-too-long', `命令超过 ${MAX_SCOPED_COMMAND_CHARS} 字符上限，拒绝执行。`);
  }
  if (command.includes('\0')) return deny('shell-null-byte', '命令里不允许出现 NUL。');
  return OK_AUDIT;
}

/**
 * 子代理 pwsh 的环境变量：过滤明显是凭据的键与私有前缀，其余照传（构建工具链依赖
 * PATH/TEMP/APPDATA/USERPROFILE 等，不能说“最小环境”就把 npm/flutter 弄坏）。
 *
 * 注意：这不是隔离——它只保证“父进程的 API key 不会白送进子进程环境”。家目录路径仍在
 * USERPROFILE/APPDATA 里（工具链需要），所以命令审计会拒绝 `$env:USERPROFILE` 之类的直接引用。
 */
const SENSITIVE_ENV_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION|AUTH)/iu;
const PRIVATE_ENV_PREFIX = /^(?:IRMIA_|DSH_|DEEPSEEK_|OPENAI_|ANTHROPIC_|GOOGLE_|AZURE_|AWS_)/u;

export function scopedShellEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) continue;
    if (SENSITIVE_ENV_NAME.test(name) || PRIVATE_ENV_PREFIX.test(name)) continue;
    out[name] = value;
  }
  // 两个跨平台提示：构建脚本常按 CI 走非交互分支；同时去掉 pwsh 的 profile 干扰由参数负责。
  out['CI'] = '1';
  return out;
}

/** pwsh 二进制探测（缓存一次）：优先 PowerShell 7 `pwsh`，Windows 回退 powershell.exe。 */
let cachedShellBinary: string | null | undefined;

export function resolveShellBinary(): string | null {
  if (cachedShellBinary !== undefined) return cachedShellBinary;
  const candidates = [process.env['IRMIA_PWSH_PATH'], 'pwsh', ...(process.platform === 'win32' ? ['powershell.exe'] : [])]
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  for (const candidate of candidates) {
    const looksLikePath = candidate.includes(sep) || candidate.includes('/');
    if (looksLikePath && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      shell: false, windowsHide: true, timeout: 15_000,
    });
    if (probe.status === 0 && probe.error === undefined) {
      cachedShellBinary = candidate;
      return candidate;
    }
  }
  cachedShellBinary = null;
  return null;
}

/** 测试隔离用：清掉二进制定位缓存。 */
export function resetShellBinaryCache(): void {
  cachedShellBinary = undefined;
}

/**
 * 角色 scoped pwsh 工具。
 *
 * 返回值约定：
 *   · `shell:'none'` ⇒ `null`（general/fork 永远拿不到）；
 *   · `shell:'workspace'` ⇒ 只有一个根 workspace，不接受 `root` 参数；
 *   · `shell:'project'` 且会话有已授权 projectRoot ⇒ project（默认）+ workspace 两个根；
 *   · `shell:'project'` 但会话没有 projectRoot ⇒ 退化为 workspace-only（并记一条 runtime 审计，
 *     不让一个没有项目根的会话凭空拿到项目权限）；
 *   · `shell:'full'` ⇒ **只对 worker / scribe 生效**：cwd 固定 session workspace，命令可 `cd`/访问任意
 *     绝对路径、执行任意命令（不做路径审计）；仍保留输出上限、超时、AbortSignal 与最小环境。
 *     对其他 Profile 返回 null 并落 `shell-full-denied` 审计——这是“重度工作角色”的
 *     运行时授权，不能由 Profile 数据自己声明（capability 表里 pwsh 仍是 unsafe）。
 */
const FULL_SHELL_PROFILES = new Set(['worker', 'scribe']);

export function createScopedPwshTool(options: ScopedPwshOptions): ToolDefinition | null {
  if (options.shell === 'none') return null;
  if (!existsSync(options.workspace)) return null;
  if (options.shell === 'full') {
    if (!FULL_SHELL_PROFILES.has(options.profileId)) {
      options.emit?.({action: 'shell-full-denied', profileId: options.profileId, agentId: options.agentId});
      return null;
    }
    return createFullPwshTool(options);
  }
  return createRestrictedPwshTool({...options, shell: options.shell});
}

/**
 * `shell:'full'`：worker 的完整终端。cwd 固定 session workspace，但**不做路径/命令审计**：
 * 模型可以 `cd C:\...`、读写任意绝对路径、起构建工具。保留的只有执行资源边界：
 * 输出截断、超时、AbortSignal、最小环境（过滤凭据）——这是“别把 key 递给子进程 + 别挂死”，
 * 不是“拦住它碰整台机器”。文件工具（safe_read/write/edit）仍按 session workspace/project
 * 收口，external 目录的访问走这里。
 */
function createFullPwshTool(options: ScopedPwshOptions): ToolDefinition {
  const workspace = options.workspace;
  const runner = options.runner ?? runScopedPwshProcess;
  return {
    name: 'pwsh',
    description: 'worker 完整权限 pwsh：cwd 默认自己的 workspace，可 cd/访问任意绝对路径、执行任意命令。'
      + '保留输出上限、超时、AbortSignal 与最小环境（过滤凭据），不是安全沙箱；'
      + '外部目录尽量最小范围、不做无关改动。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的 PowerShell 命令。cwd 固定在本子代理 workspace；可 cd 到任意目录，'
            + '绝对路径不受限；输出/超时有上限。',
        },
        timeoutMs: {type: 'number', description: `超时毫秒，默认 ${DEFAULT_SCOPED_PWSH_TIMEOUT_MS}，上限 ${MAX_SCOPED_PWSH_TIMEOUT_MS}`},
      },
      required: ['command'],
      additionalProperties: false,
    },
    executionMode: 'exclusive', sideEffect: 'idempotent', timeoutMs: MAX_SCOPED_PWSH_TIMEOUT_MS,
    handler: async (args, ctx) => {
      const row = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {};
      const command = typeof row['command'] === 'string' ? row['command'] : '';
      const timeoutMs = clampTimeout(row['timeoutMs']);
      const started = Date.now();
      const commandHash = createHash('sha256').update(command, 'utf8').digest('hex').slice(0, 16);
      const audit = auditFullShellCommand(command);
      if (!audit.ok) {
        options.emit?.({
          action: 'shell-denied', profileId: options.profileId, agentId: options.agentId,
          root: 'workspace', unrestricted: true, code: audit.code, commandHash,
          commandChars: command.length, durationMs: Date.now() - started,
        });
        return errorResult(`pwsh 命令被拒绝（${audit.code}）：${audit.message}`, TOOL_ERROR_CODES.invalidArgs);
      }
      const file = resolveShellBinary();
      if (file === null) {
        options.emit?.({
          action: 'shell-unavailable', profileId: options.profileId, agentId: options.agentId,
          root: 'workspace', unrestricted: true, commandHash, durationMs: Date.now() - started,
        });
        return errorResult('运行时找不到 pwsh（PowerShell 7）或 powershell.exe，无法执行角色 shell。', 'scoped-shell-unavailable');
      }
      const result = await runner({
        file,
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        cwd: workspace,
        env: scopedShellEnv(options.baseEnv),
        signal: ctx.signal,
        timeoutMs,
      });
      const durationMs = Date.now() - started;
      const stdout = tail(result.stdout, MAX_OUTPUT_CHARS);
      const stderr = tail(result.stderr, MAX_OUTPUT_CHARS);
      const ok = result.code === 0 && !result.aborted && !result.timedOut && result.spawnError === undefined;
      options.emit?.({
        action: 'shell', profileId: options.profileId, agentId: options.agentId,
        root: 'workspace', unrestricted: true, ok, exitCode: result.code, durationMs,
        commandHash, commandChars: command.length,
        ...(result.timedOut ? {timedOut: true} : {}),
        ...(result.aborted ? {aborted: true} : {}),
        ...(result.spawnError === undefined ? {} : {spawnError: result.spawnError}),
      });
      if (ok) return okResult(joinOutput(stdout, stderr));
      const reason = result.spawnError !== undefined ? `spawn：${result.spawnError}`
        : result.timedOut ? `超时（${timeoutMs}ms）`
          : result.aborted ? '已取消'
            : `exit=${result.code ?? 'null'}`;
      return errorResult(
        `pwsh 执行失败（${reason}）：\n${joinOutput(stdout, stderr)}`,
        result.timedOut ? 'scoped-shell-timeout' : result.aborted ? 'scoped-shell-aborted' : 'scoped-shell-failed',
      );
    },
  };
}

/** `workspace` / `project` 两档：cwd 固定 + 静态命令审计（见文件头口径）。 */
function createRestrictedPwshTool(
  options: ScopedPwshOptions & {shell: 'workspace' | 'project'},
): ToolDefinition {
  const project = options.shell === 'project' && options.projectRoot !== undefined && existsSync(options.projectRoot)
    ? options.projectRoot : undefined;
  const rootMap: Partial<Record<ScopedPwshRoot, string>> = {workspace: options.workspace};
  if (project !== undefined) rootMap.project = project;
  const rootNames = Object.keys(rootMap) as ScopedPwshRoot[];
  const defaultRoot: ScopedPwshRoot = project === undefined ? 'workspace' : 'project';
  const roots = rootNames.map((name) => rootMap[name]!);
  const runner = options.runner ?? runScopedPwshProcess;
  if (options.shell === 'project' && project === undefined) {
    options.emit?.({action: 'shell-project-root-missing', profileId: options.profileId, agentId: options.agentId});
  }

  const properties: Record<string, unknown> = {
    command: {
      type: 'string',
      description: '要执行的 PowerShell 命令（cwd 固定在所选授权根；根外绝对路径、..、cd/Set-Location、'
        + '嵌套 shell、家目录变量与进程/反射逃逸 API 会在执行前被拒绝）。',
    },
    timeoutMs: {type: 'number', description: `超时毫秒，默认 ${DEFAULT_SCOPED_PWSH_TIMEOUT_MS}，上限 ${MAX_SCOPED_PWSH_TIMEOUT_MS}`},
  };
  if (rootNames.length > 1) {
    properties['root'] = {
      type: 'string', enum: rootNames,
      description: '执行根：project（项目根，默认）或 workspace（本子代理自己的 workspace）。',
    };
  }

  return {
    name: 'pwsh',
    description: '角色受限 pwsh：cwd 固定 + 命令审计 + 最小环境（不是安全沙箱）。'
      + '可执行常规 PowerShell 命令（构建、测试、文件操作）；越界路径与逃逸写法在执行前拒绝。'
      + '只在自己的 workspace' + (project === undefined ? '' : '或父级授权的项目根') + '内工作。',
    parameters: {type: 'object', properties, required: ['command'], additionalProperties: false},
    // 不用 'destructive'：它会让父配置的 destructiveEnabled 决定子代理有没有构建能力；
    // 角色 shell 是 Profile 级授权，由这里按 shell 字段装配。
    executionMode: 'exclusive', sideEffect: 'idempotent', timeoutMs: MAX_SCOPED_PWSH_TIMEOUT_MS,
    handler: async (args, ctx) => {
      const row = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {};
      const command = typeof row['command'] === 'string' ? row['command'] : '';
      const rawRoot = row['root'];
      if (rawRoot !== undefined && (typeof rawRoot !== 'string' || !(rootNames as string[]).includes(rawRoot))) {
        return errorResult(`root 只能是 ${rootNames.join(' / ')}；这个 Profile 没有该根。`, TOOL_ERROR_CODES.invalidArgs);
      }
      const rootName = (typeof rawRoot === 'string' ? rawRoot : defaultRoot) as ScopedPwshRoot;
      const cwd = rootMap[rootName];
      if (cwd === undefined) {
        return errorResult('这个会话没有已授权的项目根。', 'project-root-required');
      }
      const timeoutMs = clampTimeout(row['timeoutMs']);
      const started = Date.now();
      const commandHash = createHash('sha256').update(command, 'utf8').digest('hex').slice(0, 16);
      const audit = auditShellCommand(command, roots);
      if (!audit.ok) {
        options.emit?.({
          action: 'shell-denied', profileId: options.profileId, agentId: options.agentId,
          root: rootName, code: audit.code, commandHash, commandChars: command.length,
          durationMs: Date.now() - started,
        });
        return errorResult(`pwsh 命令被拒绝（${audit.code}）：${audit.message}`, TOOL_ERROR_CODES.unsafePath);
      }
      const file = resolveShellBinary();
      if (file === null) {
        options.emit?.({
          action: 'shell-unavailable', profileId: options.profileId, agentId: options.agentId,
          root: rootName, commandHash, durationMs: Date.now() - started,
        });
        return errorResult('运行时找不到 pwsh（PowerShell 7）或 powershell.exe，无法执行角色 shell。', 'scoped-shell-unavailable');
      }
      const result = await runner({
        file,
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        cwd,
        env: scopedShellEnv(options.baseEnv),
        signal: ctx.signal,
        timeoutMs,
      });
      const durationMs = Date.now() - started;
      const stdout = tail(result.stdout, MAX_OUTPUT_CHARS);
      const stderr = tail(result.stderr, MAX_OUTPUT_CHARS);
      const ok = result.code === 0 && !result.aborted && !result.timedOut && result.spawnError === undefined;
      options.emit?.({
        action: 'shell', profileId: options.profileId, agentId: options.agentId,
        root: rootName, ok, exitCode: result.code, durationMs, commandHash, commandChars: command.length,
        ...(result.timedOut ? {timedOut: true} : {}),
        ...(result.aborted ? {aborted: true} : {}),
        ...(result.spawnError === undefined ? {} : {spawnError: result.spawnError}),
      });
      if (ok) return okResult(joinOutput(stdout, stderr));
      const reason = result.spawnError !== undefined ? `spawn：${result.spawnError}`
        : result.timedOut ? `超时（${timeoutMs}ms）`
          : result.aborted ? '已取消'
            : `exit=${result.code ?? 'null'}`;
      return errorResult(
        `pwsh 执行失败（${reason}）：\n${joinOutput(stdout, stderr)}`,
        result.timedOut ? 'scoped-shell-timeout' : result.aborted ? 'scoped-shell-aborted' : 'scoped-shell-failed',
      );
    },
  };
}

function clampTimeout(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_SCOPED_PWSH_TIMEOUT_MS;
  return Math.min(Math.floor(raw), MAX_SCOPED_PWSH_TIMEOUT_MS);
}

function tail(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(-limit);
}

function joinOutput(stdout: string, stderr: string): string {
  const content = `${stdout}${stderr}`.trim();
  return content === '' ? '(无输出)' : content;
}

/** 默认执行器：spawn pwsh，参数不经 shell；超时/取消杀进程树；输出截断。 */
async function runScopedPwshProcess(input: {
  file: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<ScopedPwshResult> {
  return await new Promise((resolveResult) => {
    let child: ReturnType<typeof spawn> | null = null;
    try {
      child = spawn(input.file, [...input.args], {
        cwd: input.cwd, shell: false, windowsHide: true, env: input.env,
        stdio: ['ignore', 'pipe', 'pipe'],
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
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', abort);
      resolveResult({code, stdout, stderr, aborted: input.signal.aborted, timedOut});
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
    const abort = (): void => { killTree(); };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, input.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { stdout = tail(stdout + chunk.toString('utf8'), MAX_OUTPUT_CHARS * 2); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = tail(stderr + chunk.toString('utf8'), MAX_OUTPUT_CHARS * 2); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', abort);
      resolveResult({
        code: null, stdout, stderr, aborted: false, timedOut,
        spawnError: error instanceof Error ? error.message : String(error),
      });
    });
    child.on('close', finish);
    input.signal.addEventListener('abort', abort, {once: true});
    if (input.signal.aborted) abort();
  });
}
