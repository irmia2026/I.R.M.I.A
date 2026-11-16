import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { DEP_SPECS, probeCandidate } from './probe.ts';

/** winget 的 App Execution Alias；PATH 里不一定有 WindowsApps，所以直接找这个路径。 */
export function findWinget(): string | null {
  const local = process.env['LOCALAPPDATA'] ?? '';
  const candidates = [
    local === '' ? '' : join(local, 'Microsoft', 'WindowsApps', 'winget.exe'),
    ...(process.env['PATH'] ?? process.env['Path'] ?? '')
      .split(delimiter)
      .map((dir) => dir.trim().replace(/^"|"$/gu, ''))
      .filter((dir) => dir !== '')
      .map((dir) => join(dir, 'winget.exe')),
  ].filter((candidate) => candidate !== '');
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

/** PowerShell 的 winget/MSIX 落点；WindowsApps 是 alias，不要在 PATH 缺失时就判没装。 */
export function pwshCandidatePaths(): string[] {
  const local = process.env['LOCALAPPDATA'] ?? '';
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  return [
    local === '' ? '' : join(local, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    'pwsh',
  ].filter((candidate) => candidate !== '');
}

interface WingetRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function defaultRun(exe: string, args: readonly string[], timeoutMs: number): Promise<WingetRunResult> {
  return new Promise((resolve) => {
    const child = spawn(exe, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* already gone */ }
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * 首选路径：winget 当前把 PowerShell 分发为 MSIX bundle，支持 --scope user。
 * 装完只认真实 `pwsh -NoLogo ...` 的版本输出，不把 winget 的退出码当成功。
 */
export async function installPowerShellWithWinget(
  winget: string,
  options: { run?: typeof defaultRun; timeoutMs?: number; attempts?: number } = {},
): Promise<{ ok: boolean; exePath: string; version: string; details: string[] }> {
  const run = options.run ?? defaultRun;
  const details: string[] = [`winget: ${winget}`];
  const result = await run(winget, [
    'install', '--id', 'Microsoft.PowerShell', '--exact', '--source', 'winget',
    '--scope', 'user', '--silent', '--accept-package-agreements', '--accept-source-agreements',
    '--disable-interactivity',
  ], options.timeoutMs ?? 600_000);
  details.push(`winget exit=${result.code ?? 'null'}${result.timedOut ? '（超时）' : ''}`);
  const tail = result.stderr.trim().split(/\r?\n/u).filter(Boolean).slice(-3).join(' | ');
  if (tail !== '') details.push(tail);
  if (result.timedOut || result.code !== 0) {
    return { ok: false, exePath: '', version: '', details };
  }

  const attempts = options.attempts ?? 8;
  for (let i = 0; i < attempts; i++) {
    for (const candidate of pwshCandidatePaths()) {
      const probed = await probeCandidate(DEP_SPECS.pwsh, candidate, 'path');
      if (probed.result.ok) {
        return { ok: true, exePath: probed.result.path, version: probed.result.version, details };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  details.push('winget 返回成功，但没有找到可启动的 pwsh 7（可能需要重启资源管理器/重新登录）');
  return { ok: false, exePath: '', version: '', details };
}
