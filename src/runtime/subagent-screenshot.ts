/**
 * Irmia Agent — worker 专用 `screenshot` 工具（Windows 桌面/窗口截图）
 *
 * 目标：让 worker 子代理能“看见”自己刚做出来的界面——截当前屏幕或按标题子串截某个窗口，
 * PNG 只写进**本会话 workspace**，返回绝对路径/尺寸/字节数。不引入 MCP、不引入 Playwright：
 * Node 侧 spawn 一个 PowerShell 进程，用 .NET（System.Drawing）+ User32（PrintWindow）完成。
 *
 * ## 边界与安全口径（必须与实现一致，不要宣传成沙箱）
 *
 *   · **只给 worker**：由 `subagent-manager.ts` 按 `profile.id === 'worker'` 且非 fork/head
 *     路径注入（与 `code`/角色 pwsh 同一条纪律）。Profile 数据里写 `screenshot` 会被
 *     capability 表判为 unknown 而拒绝——它是执行器按角色装配的内建工具，不经过白名单。
 *   · **只写 workspace**：`path` 只接受相对路径，拼接后必须落在会话 workspace 内
 *     （lexical + 父目录 realpath 双重校验，拒绝 `..`/绝对路径/盘符/UNC/符号链接越界）。
 *     默认输出 `<workspace>/screenshots/<YYYYMMDD-HHmmss-SSS>.png`；已存在的文件不覆盖。
 *     工具结果里的 `path` 返回**绝对路径**（worker 有 projectRoot 时文件工具根是项目根，
 *     截图却固定在 session workspace；绝对路径才能直接交给 vision_read），审计事件里只写相对路径。
 *   · **不覆盖外部项目路径**：同上——项目根、skills、家目录都不在写入面里。
 *   · **超时/取消/输出上限**：spawn 子进程（shell:false，脚本经 `-EncodedCommand` 传入，
 *     参数只走环境变量，不做字符串拼接）；默认 30s，AbortSignal 触发时杀进程树；
 *     stdout/stderr 有硬上限，PNG 有 32 MiB 上限，落盘后由 Node **再读 PNG 头**校验尺寸
 *     （不信任脚本自报的数字）。
 *   · **不是安全沙箱**：PowerShell 进程以同一用户权限运行；本工具只保证“自己只往 workspace
 *     写、只读屏幕”，不承诺内核级隔离（见 `subagent-shell.ts` 同一口径）。
 *
 * ## 为什么窗口截图用 PrintWindow
 *
 * `CopyFromScreen` 只能截“屏幕上露出来的区域”：窗口被遮挡/最小化就截不到，且会把窗口外的
 * 桌面一起带进来。窗口模式先用 `PrintWindow(..., PW_RENDERFULLCONTENT)` 让窗口自己绘制到
 * 内存 DC，失败再退化为按窗口矩形抓屏。标题子串匹配多个可见窗口时取**面积最大**的那个
 * （通常是主窗口，而不是同类的小浮窗）。
 */
import { spawn } from 'node:child_process';
import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  argsRecord, errorResult, errorResultFromThrown, okResult, optionalString, TOOL_ERROR_CODES,
  type ToolDefinition,
} from '../tools/types.ts';
import { scopedShellEnv, resolveShellBinary } from './subagent-shell.ts';
import { inside } from './subagent-workspace.ts';

export const SCREENSHOT_TOOL_NAME = 'screenshot';

/** 截图是交互操作，正常 <2s（Add-Type 编译占大头）；30s 足够，上限 60s。 */
export const DEFAULT_SCREENSHOT_TIMEOUT_MS = 30_000;
export const MAX_SCREENSHOT_TIMEOUT_MS = 60_000;
/** PNG 上限：4K 截图通常 <8 MiB；超过 32 MiB 视为异常输出，不返回半截文件。 */
export const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024;
export const MAX_SCREENSHOT_STDOUT_CHARS = 16_384;
export const MAX_SCREENSHOT_STDERR_CHARS = 16_384;
export const SCREENSHOTS_DIR = 'screenshots';

const MAX_PATH_CHARS = 300;
const MAX_WINDOW_CHARS = 200;
const SCREENSHOT_MODES = ['screen', 'window'] as const;
export type ScreenshotMode = (typeof SCREENSHOT_MODES)[number];

export interface ScreenshotCommandInput {
  file: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface ScreenshotCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
  /** spawn 失败（找不到 pwsh 等）时的原因；有它时 code 通常为 null。 */
  spawnError?: string;
}

export type ScreenshotRunner = (input: ScreenshotCommandInput) => Promise<ScreenshotCommandResult>;

export interface ScreenshotToolOptions {
  profileId: string;
  /** 会话 workspace（唯一允许落盘的位置）。 */
  workspace: string;
  agentId: string;
  emit?: ((data: Record<string, unknown>) => void) | undefined;
  /** 测试/替代注入：命令执行器（注入后不需要本机真有 pwsh）。 */
  runner?: ScreenshotRunner | undefined;
  /** 环境基座；测试/替代注入用，缺省 process.env。 */
  baseEnv?: NodeJS.ProcessEnv | undefined;
  /** 测试用：覆盖超时（生产不传）。 */
  timeoutMs?: number | undefined;
  /** 测试用：固定时钟（文件名）；生产不传。 */
  nowMs?: (() => number) | undefined;
}

/**
 * PowerShell 载荷。**参数一律从环境变量读**，脚本文本里不拼任何用户输入——
 * spawn 用 `shell:false` + `-EncodedCommand`（UTF-16LE base64），连引号转义都不需要。
 *
 * 输出契约（stdout 一行 JSON，纯 ASCII）：成功
 *   `{"ok":true,"width":W,"height":H,"bytes":N,"titleB64":"..."}`
 * 失败 `{"ok":false,"code":"...","messageB64":"..."}`。
 */
const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$mode = [string]$env:IRMIA_SHOT_MODE
$outPath = [string]$env:IRMIA_SHOT_PATH
$needle = [string]$env:IRMIA_SHOT_WINDOW
$script:payload = $null
$script:bitmap = $null
$script:width = 0
$script:height = 0
$script:titleB64 = ''
function Set-Failure([string]$code, [string]$message) {
  $messageB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($message))
  $script:payload = [ordered]@{ ok = $false; code = $code; messageB64 = $messageB64 }
}
try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  if ($mode -eq 'screen') {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $script:width = [int]$bounds.Width
    $script:height = [int]$bounds.Height
    if ($script:width -le 0 -or $script:height -le 0) {
      Set-Failure 'no-desktop' 'primary screen reported empty bounds'
    } else {
      $script:bitmap = [System.Drawing.Bitmap]::new($script:width, $script:height)
      $graphics = [System.Drawing.Graphics]::FromImage($script:bitmap)
      try {
        $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $script:bitmap.Size)
      } finally {
        $graphics.Dispose()
      }
    }
  } elseif ($mode -eq 'window') {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class IrmiaScreenshotWindow {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
    try { [void][IrmiaScreenshotWindow]::SetProcessDPIAware() } catch { }
    $script:bestHandle = [IntPtr]::Zero
    $script:bestArea = -1
    $callback = [IrmiaScreenshotWindow+EnumWindowsProc]{
      param([IntPtr]$handle, [IntPtr]$param)
      if ([IrmiaScreenshotWindow]::IsWindowVisible($handle)) {
        $length = [IrmiaScreenshotWindow]::GetWindowTextLength($handle)
        if ($length -gt 0) {
          $builder = New-Object System.Text.StringBuilder ($length + 1)
          [void][IrmiaScreenshotWindow]::GetWindowText($handle, $builder, $builder.Capacity)
          $title = $builder.ToString()
          if ($title.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $rect = New-Object IrmiaScreenshotWindow+RECT
            if ([IrmiaScreenshotWindow]::GetWindowRect($handle, [ref]$rect)) {
              $area = ([int64]$rect.Right - [int64]$rect.Left) * ([int64]$rect.Bottom - [int64]$rect.Top)
              if ($area -gt $script:bestArea) {
                $script:bestArea = $area
                $script:bestHandle = $handle
              }
            }
          }
        }
      }
      return $true
    }
    [void][IrmiaScreenshotWindow]::EnumWindows($callback, [IntPtr]::Zero)
    if ($script:bestHandle -eq [IntPtr]::Zero) {
      Set-Failure 'window-not-found' 'no visible window title contains the requested substring'
    } else {
      $titleLength = [IrmiaScreenshotWindow]::GetWindowTextLength($script:bestHandle)
      if ($titleLength -gt 0) {
        $titleBuilder = New-Object System.Text.StringBuilder ($titleLength + 1)
        [void][IrmiaScreenshotWindow]::GetWindowText($script:bestHandle, $titleBuilder, $titleBuilder.Capacity)
        $script:titleB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($titleBuilder.ToString()))
      }
      $rect = New-Object IrmiaScreenshotWindow+RECT
      if (-not [IrmiaScreenshotWindow]::GetWindowRect($script:bestHandle, [ref]$rect)) {
        Set-Failure 'capture-failed' 'GetWindowRect failed'
      } else {
        $script:width = [int]($rect.Right - $rect.Left)
        $script:height = [int]($rect.Bottom - $rect.Top)
        if ($script:width -le 0 -or $script:height -le 0) {
          Set-Failure 'window-not-capturable' 'window has no drawable area'
        } else {
          $script:bitmap = [System.Drawing.Bitmap]::new($script:width, $script:height)
          $graphics = [System.Drawing.Graphics]::FromImage($script:bitmap)
          $hdc = $graphics.GetHdc()
          try {
            $printed = [IrmiaScreenshotWindow]::PrintWindow($script:bestHandle, $hdc, 2)
          } finally {
            $graphics.ReleaseHdc($hdc)
          }
          if (-not $printed) {
            try {
              $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $script:bitmap.Size)
              $printed = $true
            } catch {
              $printed = $false
            }
          }
          $graphics.Dispose()
          if (-not $printed) { Set-Failure 'capture-failed' 'PrintWindow and screen copy both failed' }
        }
      }
    }
  } else {
    Set-Failure 'bad-mode' 'unknown capture mode'
  }
  if ($script:payload -eq $null) {
    $script:bitmap.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $file = Get-Item -LiteralPath $outPath
    $script:payload = [ordered]@{
      ok = $true; width = [int]$script:width; height = [int]$script:height;
      bytes = [long]$file.Length; titleB64 = $script:titleB64
    }
  }
} catch {
  Set-Failure 'capture-failed' $_.Exception.Message
} finally {
  if ($script:bitmap -ne $null) { $script:bitmap.Dispose() }
}
[Console]::Out.WriteLine(($script:payload | ConvertTo-Json -Compress))
`;

/** 只算一次：UTF-16LE base64 是 PowerShell `-EncodedCommand` 的输入格式。 */
const ENCODED_POWERSHELL_SCRIPT = Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64');

/** 默认文件名：本地时间 `YYYYMMDD-HHmmss-SSS`（与截图发生的时刻一致，人一眼能读）。 */
export function screenshotFileName(nowMs: number): string {
  const date = new Date(nowMs);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    + `-${pad(date.getMilliseconds(), 3)}`;
}

function tail(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(-limit);
}

function parseJsonPayload(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  if (text === '') return null;
  const attempts = [text, ...text.split(/\r?\n/u).reverse()];
  for (const candidate of attempts) {
    const line = candidate.trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 继续尝试下一行
    }
  }
  return null;
}

function decodeBase64Text(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    return text.length <= maxChars ? text : text.slice(0, maxChars);
  } catch {
    return null;
  }
}

interface PngFacts {
  width: number;
  height: number;
  bytes: number;
}

/** 读 PNG 头（8 字节签名 + IHDR）拿真实尺寸；不信任脚本自报的数字。 */
function readPngFacts(path: string): PngFacts | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size < 33 || stat.size > MAX_SCREENSHOT_BYTES) return null;
    const header = Buffer.alloc(33);
    const fd = openSync(path, 'r');
    try {
      const read = readSync(fd, header, 0, header.length, 0);
      if (read < header.length) return null;
    } finally {
      closeSync(fd);
    }
    // 89 50 4E 47 0D 0A 1A 0A
    if (header[0] !== 0x89 || header[1] !== 0x50 || header[2] !== 0x4e || header[3] !== 0x47
      || header[4] !== 0x0d || header[5] !== 0x0a || header[6] !== 0x1a || header[7] !== 0x0a) return null;
    if (header.readUInt32BE(8) !== 13 || header.toString('latin1', 12, 16) !== 'IHDR') return null;
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    if (width <= 0 || height <= 0) return null;
    return {width, height, bytes: stat.size};
  } catch {
    return null;
  }
}

interface ResolvedOutput {
  target: string;
  /** 相对 workspace 的输出路径（正斜杠）。只进审计事件，工具结果用绝对路径。 */
  relativePath: string;
}

function readOutputPath(
  input: string | undefined,
  workspace: string,
  nowMs: number,
): {ok: true; output: ResolvedOutput} | {ok: false; message: string} {
  if (input !== undefined && input.length > MAX_PATH_CHARS) {
    return {ok: false, message: `path 过长（上限 ${MAX_PATH_CHARS} 字符）。`};
  }
  if (input !== undefined && input.includes('\0')) return {ok: false, message: 'path 不能含 NUL。'};
  let relInput = input;
  if (relInput !== undefined) {
    if (relInput.trim() === '') return {ok: false, message: 'path 不能是空字符串；省略它则自动生成文件名。'};
    // 只接受 workspace 内相对路径：绝对路径/盘符/UNC 一律拒绝（不靠“看一眼像不像”）。
    if (isAbsolute(relInput) || /^[A-Za-z]:/u.test(relInput) || relInput.startsWith('\\\\')) {
      return {ok: false, message: 'path 必须是 workspace 内的相对路径（不接受绝对路径/盘符/UNC）。'};
    }
    const segments = relInput.split(/[\\/]+/u);
    if (segments.includes('..')) {
      return {ok: false, message: 'path 不能包含 `..` 越界段。'};
    }
    if (!/\.png$/iu.test(relInput)) {
      return {ok: false, message: 'path 必须以 .png 结尾（本工具只产出 PNG）。'};
    }
  }
  const candidates: string[] = [];
  if (relInput === undefined) {
    const base = screenshotFileName(nowMs);
    candidates.push(join(SCREENSHOTS_DIR, `${base}.png`));
    for (let index = 1; index <= 20; index += 1) candidates.push(join(SCREENSHOTS_DIR, `${base}-${index}.png`));
  } else {
    candidates.push(relInput);
  }
  for (const candidate of candidates) {
    const target = resolve(workspace, candidate);
    if (!inside(workspace, target)) continue;
    // lstat 而不是 existsSync：悬空符号链接 existsSync=false，但写下去仍会跟随到链接目标。
    if (lstatSync(target, {throwIfNoEntry: false}) !== undefined) {
      if (relInput !== undefined) return {ok: false, message: '目标文件已存在；本工具不覆盖已有文件，请换一个 path。'};
      continue;
    }
    // 父目录在 workspace 内真实存在（先创建再 realpath：挡住 junction/symlink 越界）。
    try {
      const parent = dirname(target);
      mkdirSync(parent, {recursive: true});
      const realParent = realpathSync.native(parent);
      if (!inside(workspace, realParent)) {
        return {ok: false, message: 'path 的父目录解析后越出 workspace；拒绝写入。'};
      }
      if (!statSync(realParent).isDirectory()) return {ok: false, message: 'path 的父目录不是目录。'};
    } catch {
      return {ok: false, message: '无法创建 path 的父目录（不存在或无权限）。'};
    }
    return {
      ok: true,
      output: {target, relativePath: relative(workspace, target).replaceAll('\\', '/')},
    };
  }
  return {ok: false, message: '同名截图文件过多，无法生成新的文件名；请显式给 path。'};
}

function codeForScriptError(code: unknown): string {
  switch (code) {
    case 'window-not-found': return 'screenshot-window-not-found';
    case 'window-not-capturable': return 'screenshot-window-not-capturable';
    case 'no-desktop': return 'screenshot-no-desktop';
    case 'bad-mode': return TOOL_ERROR_CODES.invalidArgs;
    default: return 'screenshot-capture-failed';
  }
}

/**
 * 创建 `screenshot` 工具。
 *
 * 返回 null 的场景（装配条件不满足，不是执行错误）：不是 worker；workspace 不存在/不是目录。
 * 没有 projectRoot 也照常创建（worker 的纯设计任务只需要自己的 workspace）。
 */
export function createScreenshotTool(options: ScreenshotToolOptions): ToolDefinition | null {
  if (options.profileId !== 'worker') return null;
  if (options.workspace.trim() === '' || !existsSync(options.workspace)) return null;
  let workspace: string;
  try {
    workspace = realpathSync.native(resolve(options.workspace));
    if (!statSync(workspace).isDirectory()) return null;
  } catch {
    return null;
  }
  const runner = options.runner ?? runScreenshotProcess;
  const nowMs = options.nowMs ?? (() => Date.now());
  const injectedRunner = options.runner !== undefined;
  const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(Math.floor(options.timeoutMs), MAX_SCREENSHOT_TIMEOUT_MS)
    : DEFAULT_SCREENSHOT_TIMEOUT_MS;

  return {
    name: SCREENSHOT_TOOL_NAME,
    description: '截当前屏幕或指定标题子串的窗口，PNG 只写本会话 workspace（默认 screenshots/<时间>.png）。'
      + '返回路径、宽高与字节数；可用于检查刚做的界面。找不到窗口/无桌面时明确报错。',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string', enum: [...SCREENSHOT_MODES],
          description: 'screen（默认，主屏幕全屏截图）/ window（按窗口标题子串截单个窗口）',
        },
        window: {type: 'string', description: 'window 模式必填：窗口标题的子串（不区分大小写；多个匹配取面积最大）'},
        path: {
          type: 'string',
          description: '可选输出路径（workspace 内相对路径，必须以 .png 结尾）；缺省自动生成 screenshots/<时间>.png，不覆盖已有文件',
        },
      },
      additionalProperties: false,
    },
    // 与 code 工具同一口径：只写自己 workspace 里的新文件，不写项目；标 destructive 会被
    // 父配置的 destructiveEnabled 关掉，等于让 worker 的“看界面”能力随无关开关消失。
    executionMode: 'exclusive',
    sideEffect: 'idempotent',
    timeoutMs: MAX_SCREENSHOT_TIMEOUT_MS,
    handler: async (args, ctx) => {
      const started = Date.now();
      let mode: ScreenshotMode = 'screen';
      if (ctx.signal.aborted) {
        return errorResult('screenshot 调用在开始前已被取消（AbortSignal）。', TOOL_ERROR_CODES.aborted);
      }
      try {
        const row = argsRecord(args, SCREENSHOT_TOOL_NAME);
        const modeInput = optionalString(row, 'mode', {maxLength: 16}) ?? 'screen';
        if (!(SCREENSHOT_MODES as readonly string[]).includes(modeInput)) {
          return errorResult(
            `mode 只能是 ${SCREENSHOT_MODES.join(' / ')}；收到 ${JSON.stringify(modeInput)}。`,
            TOOL_ERROR_CODES.invalidArgs,
          );
        }
        mode = modeInput as ScreenshotMode;
        const windowInput = optionalString(row, 'window', {maxLength: MAX_WINDOW_CHARS});
        const pathInput = optionalString(row, 'path', {maxLength: MAX_PATH_CHARS});
        if (mode === 'screen' && windowInput !== undefined) {
          return errorResult('window 只在 mode:"window" 时有效；截全屏请省略 window 参数。', TOOL_ERROR_CODES.invalidArgs);
        }
        if (mode === 'window' && (windowInput === undefined || windowInput.trim() === '')) {
          return errorResult('mode:"window" 需要非空的 window 参数（窗口标题子串）。', TOOL_ERROR_CODES.invalidArgs);
        }

        const resolved = readOutputPath(pathInput, workspace, nowMs());
        if (!resolved.ok) {
          options.emit?.({
            action: 'screenshot-denied', profileId: options.profileId, agentId: options.agentId,
            mode, code: 'screenshot-path-invalid', durationMs: Date.now() - started,
          });
          return errorResult(`screenshot 拒绝输出路径：${resolved.message}`, TOOL_ERROR_CODES.unsafePath);
        }
        const {target, relativePath} = resolved.output;

        const file = injectedRunner ? 'screenshot-runner-injected' : resolveShellBinary();
        if (file === null) {
          options.emit?.({
            action: 'screenshot-unavailable', profileId: options.profileId, agentId: options.agentId,
            mode, durationMs: Date.now() - started,
          });
          return errorResult(
            '运行时找不到 PowerShell（pwsh 或 powershell.exe），无法截图。',
            TOOL_ERROR_CODES.noRuntime,
          );
        }
        const env: NodeJS.ProcessEnv = {
          ...scopedShellEnv(options.baseEnv),
          IRMIA_SHOT_MODE: mode,
          IRMIA_SHOT_PATH: target,
          IRMIA_SHOT_WINDOW: windowInput ?? '',
        };
        const result = await runner({
          file,
          args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_POWERSHELL_SCRIPT],
          cwd: workspace,
          env,
          signal: ctx.signal,
          timeoutMs,
        });
        const durationMs = Date.now() - started;
        const stdout = tail(result.stdout, MAX_SCREENSHOT_STDOUT_CHARS);
        const stderr = tail(result.stderr, MAX_SCREENSHOT_STDERR_CHARS);
        const payload = parseJsonPayload(stdout);
        const payloadOk = payload?.['ok'] === true;
        const spawnFailed = result.spawnError !== undefined;

        const emitBase = {
          action: 'screenshot', profileId: options.profileId, agentId: options.agentId,
          mode, durationMs, timeoutMs, ...(windowInput === undefined ? {} : {windowNeedleChars: windowInput.length}),
        };
        if (spawnFailed) {
          options.emit?.({...emitBase, ok: false, spawnFailed: true});
          return errorResult(
            '截图子进程启动失败：检查 PowerShell 是否可执行（pwsh / powershell.exe）。',
            TOOL_ERROR_CODES.spawnFailed,
          );
        }
        if (result.timedOut) {
          options.emit?.({...emitBase, ok: false, timedOut: true});
          return errorResult(`截图超时（${timeoutMs}ms，已杀进程树）。`, TOOL_ERROR_CODES.timeout);
        }
        if (result.aborted) {
          options.emit?.({...emitBase, ok: false, aborted: true});
          return errorResult('截图已取消（AbortSignal）。', TOOL_ERROR_CODES.aborted);
        }
        if (payload === null) {
          options.emit?.({...emitBase, ok: false, scriptErrorCode: 'invalid-json'});
          const detail = stderr.trim() === '' ? '' : `\nstderr:\n${stderr}`;
          return errorResult(
            `截图脚本没有返回合法 JSON（exit=${result.code ?? 'null'}）。${detail}`,
            'screenshot-failed',
          );
        }
        if (payloadOk !== true) {
          const scriptCode = typeof payload['code'] === 'string' ? payload['code'] : 'capture-failed';
          const detail = decodeBase64Text(payload['messageB64'], 400) ?? '';
          options.emit?.({...emitBase, ok: false, scriptErrorCode: scriptCode});
          const friendly = scriptCode === 'window-not-found'
            ? `找不到标题包含 ${JSON.stringify(windowInput ?? '')} 的可见窗口；请换一个更准确的子串，或先用 mode:"screen" 看整屏。`
            : scriptCode === 'no-desktop'
              ? '没有可截取的主屏幕（当前会话可能没有交互式桌面）。'
              : `截图失败（${scriptCode}）${detail === '' ? '' : `：${detail}`}`;
          return errorResult(friendly, codeForScriptError(scriptCode));
        }

        // 文件是脚本写的：以 Node 侧的 PNG 头解析为准，并再校验一次真实路径没越界。
        const facts = readPngFacts(target);
        if (facts === null) {
          options.emit?.({...emitBase, ok: false, scriptErrorCode: 'invalid-png'});
          rmSync(target, {force: true});
          return errorResult(
            '截图脚本报告成功，但输出文件不是合法 PNG（签名/IHDR 校验失败或超过上限），已删除。',
            'screenshot-invalid-output',
          );
        }
        let realTarget: string;
        try {
          realTarget = realpathSync.native(target);
        } catch {
          options.emit?.({...emitBase, ok: false, scriptErrorCode: 'missing-output'});
          return errorResult('截图脚本报告成功，但输出文件不存在。', 'screenshot-invalid-output');
        }
        if (!inside(workspace, realTarget)) {
          rmSync(target, {force: true});
          options.emit?.({...emitBase, ok: false, scriptErrorCode: 'output-outside-workspace'});
          return errorResult('截图输出解析后越出 workspace，已删除并拒绝返回。', TOOL_ERROR_CODES.unsafePath);
        }

        const title = typeof payload['titleB64'] === 'string' && payload['titleB64'] !== ''
          ? decodeBase64Text(payload['titleB64'], MAX_WINDOW_CHARS) : null;
        // `path` 用**绝对路径**：worker 有 projectRoot 时文件工具的根是项目根，而截图固定落在
        // session workspace——相对路径会被 vision_read/safe_read 解析到项目根下而找不到。
        // 绝对值落在 worker 自己的 workspace 内（上面已 realpath 校验），不是外部路径泄漏。
        const response: Record<string, unknown> = {
          ok: true,
          path: realTarget,
          width: facts.width,
          height: facts.height,
          bytes: facts.bytes,
          mode,
          ...(title === null || title === '' ? {} : {windowTitle: title}),
        };
        options.emit?.({
          ...emitBase, ok: true, width: facts.width, height: facts.height, bytes: facts.bytes,
          outputRelative: relativePath,
          ...(title === null ? {} : {windowTitleChars: title.length}),
        });
        return okResult(JSON.stringify(response, null, 2));
      } catch (error) {
        options.emit?.({
          action: 'screenshot', profileId: options.profileId, agentId: options.agentId,
          mode, ok: false, durationMs: Date.now() - started,
        });
        return errorResultFromThrown(error, 'screenshot-failed');
      }
    },
  };
}

/**
 * 默认执行器：spawn PowerShell（参数不经 shell），超时/取消杀进程树，输出截断。
 * 与 `subagent-code.ts` 的 `runCodeCliProcess` 同一套收口（Windows 用 taskkill /T /F）。
 */
export function runScreenshotProcess(input: ScreenshotCommandInput): Promise<ScreenshotCommandResult> {
  return new Promise((resolveResult) => {
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
      input.signal.removeEventListener('abort', onAbort);
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
    const onAbort = (): void => { killTree(); };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, input.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = tail(stdout + chunk.toString('utf8'), MAX_SCREENSHOT_STDOUT_CHARS * 2);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = tail(stderr + chunk.toString('utf8'), MAX_SCREENSHOT_STDERR_CHARS * 2);
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
  });
}
