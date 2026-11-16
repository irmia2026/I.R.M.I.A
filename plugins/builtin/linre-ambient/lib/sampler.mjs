import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join } from 'node:path';

export const PRIVACY_TITLE_PATTERN = /1password|bitwarden|keepass|password|密码|token|secret|apikey|private|incognito|无痕|隐私/iu;
export const EVERYTHING_ES_PATH = 'C:\\Users\\admin\\Documents\\_tools\\everything\\es.exe';
const TEMP_EXTENSIONS = new Set(['.crdownload', '.tmp', '.part', '.download', '.partial']);
const PS_TIMEOUT_MS = 3500;
const ES_TIMEOUT_MS = 3000;
const RECENT_WINDOW_MS = 30 * 60 * 1000;

const PS_SCRIPT = [
  '$ProgressPreference = "SilentlyContinue"',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'try {',
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public class LinreWinAmbient {',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct LII { public uint cbSize; public uint dwTime; }',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
  '  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LII l);',
  '  public static uint IdleMs() {',
  '    var l = new LII();',
  '    l.cbSize = (uint)Marshal.SizeOf(l);',
  '    return GetLastInputInfo(ref l) ? (uint)Environment.TickCount - l.dwTime : 0;',
  '  }',
  '  public static string Title(IntPtr h) {',
  '    var s = new StringBuilder(256);',
  '    GetWindowText(h, s, 256);',
  '    return s.ToString();',
  '  }',
  '}',
  '"@',
  '$h = [LinreWinAmbient]::GetForegroundWindow()',
  '$p = [uint32]0',
  'if ($h -ne [IntPtr]::Zero) { [void][LinreWinAmbient]::GetWindowThreadProcessId($h, [ref]$p) }',
  '$fp = if ($p -gt 0) { (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName } else { "" }',
  '$ft = if ($h -ne [IntPtr]::Zero) { [LinreWinAmbient]::Title($h) } else { "" }',
  '$wins = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne "" } | Select-Object -First 12 @{n="p";e={$_.ProcessName}}, @{n="t";e={$_.MainWindowTitle}})',
  '@{ fgProcess = $fp; fgTitle = $ft; idleSeconds = [int][Math]::Floor([LinreWinAmbient]::IdleMs() / 1000); windows = $wins } | ConvertTo-Json -Compress -Depth 3',
  '} catch { "{}" }',
].join('\n');

const PS_ENCODED = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');

export function clipChars(text, max) {
  const chars = [...String(text ?? '')];
  if (chars.length <= max) return chars.join('');
  return max <= 1 ? chars.slice(0, max).join('') : `${chars.slice(0, max - 1).join('')}…`;
}

export function redactWindowTitle(title, hideAll = false) {
  const clean = String(title ?? '').replace(/\s+/gu, ' ').trim();
  if (clean === '') return '';
  if (PRIVACY_TITLE_PATTERN.test(clean)) return '[隐私窗口]';
  if (hideAll) return '[已隐藏]';
  return clean;
}

function execFileAsync(command, args, timeout) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 512 * 1024 }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, stdout: '' });
        return;
      }
      resolve({ ok: true, stdout: typeof stdout === 'string' ? stdout : '' });
    });
  });
}

export async function sampleWindows(options = {}) {
  const platform = options.platform ?? process.platform;
  const hideAll = Boolean(options.hideWindowTitles);
  if (platform !== 'win32' || options.disablePowerShell || process.env.LINRE_AMBIENT_NO_PS === '1') {
    return { fgProcess: '', fgTitle: '', idleSeconds: null, windows: [] };
  }
  const runner = options.execRunner ?? execFileAsync;
  const res = await runner(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', PS_ENCODED],
    options.timeoutMs ?? PS_TIMEOUT_MS,
  );
  if (!res.ok || res.stdout.trim() === '') {
    return { fgProcess: '', fgTitle: '', idleSeconds: null, windows: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout.trim());
  } catch {
    return { fgProcess: '', fgTitle: '', idleSeconds: null, windows: [] };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { fgProcess: '', fgTitle: '', idleSeconds: null, windows: [] };
  }
  const fgProcess = typeof parsed.fgProcess === 'string' ? parsed.fgProcess.trim() : '';
  const fgTitle = redactWindowTitle(parsed.fgTitle, hideAll);
  const idleSeconds = typeof parsed.idleSeconds === 'number' && Number.isFinite(parsed.idleSeconds) && parsed.idleSeconds >= 0
    ? Math.floor(parsed.idleSeconds)
    : null;
  const rawList = Array.isArray(parsed.windows)
    ? parsed.windows
    : (parsed.windows && typeof parsed.windows === 'object' ? [parsed.windows] : []);
  const windows = [];
  const seen = new Set();
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const proc = typeof item.p === 'string' ? item.p.trim() : '';
    const title = redactWindowTitle(item.t, hideAll);
    if (proc === '') continue;
    const key = `${proc}::${title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    windows.push({ process: proc, title });
  }
  return { fgProcess, fgTitle, idleSeconds, windows };
}

function isSkippedFile(name) {
  const lower = name.toLowerCase();
  if (name.startsWith('.') || name.startsWith('~$') || lower === 'desktop.ini' || lower === 'thumbs.db') return true;
  const ext = extname(lower);
  return TEMP_EXTENSIONS.has(ext);
}

export function collectRecentFiles(options = {}) {
  const home = options.homedir ?? homedir();
  const dirs = options.dirs ?? [
    { label: 'Downloads', path: join(home, 'Downloads') },
    { label: 'Desktop', path: join(home, 'Desktop') },
  ];
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? RECENT_WINDOW_MS;
  const limit = options.limit ?? 12;
  const files = [];
  for (const entry of dirs) {
    const dirLabel = typeof entry === 'string' ? entry : entry.label;
    const dirPath = typeof entry === 'string' ? entry : entry.path;
    let items;
    try {
      items = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of items) {
      if (!dirent.isFile()) continue;
      if (isSkippedFile(dirent.name)) continue;
      const fullPath = join(dirPath, dirent.name);
      try {
        const st = statSync(fullPath);
        const ageMs = Math.max(0, nowMs - st.mtimeMs);
        if (Number.isFinite(maxAgeMs) && ageMs > maxAgeMs) continue;
        files.push({
          name: dirent.name,
          dir: dirLabel,
          path: fullPath,
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs,
          ageMs,
        });
      } catch {
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, limit);
}

export function readDriveFreeGb(drivePath, statfsFn = statfsSync) {
  try {
    const s = statfsFn(drivePath);
    const bavail = Number(s.bavail);
    const bsize = Number(s.bsize);
    if (!Number.isFinite(bavail) || !Number.isFinite(bsize)) return null;
    return (bavail * bsize) / (1024 ** 3);
  } catch {
    return null;
  }
}

function countTopLevelEntries(dirPath) {
  try {
    return readdirSync(dirPath).length;
  } catch {
    return null;
  }
}

export function collectStorage(options = {}) {
  const platform = options.platform ?? process.platform;
  const statfsFn = options.statfsFn ?? statfsSync;
  const existsFn = options.existsFn ?? existsSync;
  const home = options.homedir ?? homedir();
  const tempPath = options.tempDir ?? tmpdir();
  const drives = [];
  if (platform === 'win32') {
    for (const letter of ['C:\\', 'D:\\']) {
      if (letter === 'C:\\' || existsFn(letter)) {
        const freeGb = readDriveFreeGb(letter, statfsFn);
        if (freeGb !== null) drives.push({ drive: letter.slice(0, 2), freeGb });
      }
    }
  } else {
    const freeGb = readDriveFreeGb('/', statfsFn);
    if (freeGb !== null) drives.push({ drive: '/', freeGb });
  }
  return {
    drives,
    downloadsCount: countTopLevelEntries(join(home, 'Downloads')),
    tempCount: countTopLevelEntries(tempPath),
  };
}

export function formatDiskSegment(freeGb, baselineGb) {
  if (typeof freeGb !== 'number' || !Number.isFinite(freeGb)) return '';
  const base = typeof baselineGb === 'number' && Number.isFinite(baselineGb) ? baselineGb : freeGb;
  const delta = freeGb - base;
  const deltaText = Math.abs(delta) < 0.05 ? '稳' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}G`;
  return `C盘余${freeGb.toFixed(1)}G(${deltaText})`;
}

export function formatIdleText(idleSeconds) {
  if (typeof idleSeconds !== 'number' || !Number.isFinite(idleSeconds) || idleSeconds < 0) return '未知';
  if (idleSeconds < 60) return '键鼠活跃';
  const mins = Math.floor(idleSeconds / 60);
  if (mins < 5) return `键鼠空闲${mins}分`;
  return `键鼠已离席${mins}分`;
}

export function formatAgeText(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return '未知';
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}小时前`;
  return `${Math.floor(hour / 24)}天前`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0B';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 ** 3)).toFixed(2)}GB`;
}

export function topOpenApps(windows, fgProcess, limit = 4) {
  const seen = new Set();
  const apps = [];
  for (const w of Array.isArray(windows) ? windows : []) {
    const proc = typeof w?.process === 'string' ? w.process.trim() : '';
    if (proc === '' || seen.has(proc)) continue;
    seen.add(proc);
    apps.push(proc);
  }
  const filtered = fgProcess ? apps.filter((name) => name !== fgProcess) : apps;
  const pick = filtered.length > 0 ? filtered : apps;
  return pick.slice(0, limit);
}

export function formatAmbientLine(sample, config = {}, maxChars = 160) {
  if (config.enabled === false || !sample) return '';
  const hideAll = Boolean(config.hideWindowTitles);
  const fgProc = typeof sample.fgProcess === 'string' ? sample.fgProcess.trim() : '';
  const fgTitle = hideAll ? '' : redactWindowTitle(sample.fgTitle, false);
  const fgPart = fgProc
    ? (fgTitle ? `前台=${fgProc}「${clipChars(fgTitle, 18)}」` : `前台=${fgProc}`)
    : '';
  const idlePart = typeof sample.idleSeconds === 'number' ? formatIdleText(sample.idleSeconds) : '';
  const apps = topOpenApps(sample.windows, fgProc, 4);
  const appsPart = apps.length > 0 ? `开着=${apps.join(',')}` : '';
  const files = Array.isArray(sample.recentFiles) ? sample.recentFiles.slice(0, 2) : [];
  const filesPart = files.length > 0 ? `新文件=${files.map((f) => clipChars(f.name, 18)).join(',')}` : '';
  const diskPart = formatDiskSegment(sample.cFreeGb, sample.baselineCFreeGb);

  const candidates = [fgPart, idlePart, appsPart, filesPart, diskPart].filter(Boolean);
  if (candidates.length === 0) return '';

  let line = `环境：${candidates.join('｜')}`;
  if ([...line].length <= maxChars) return line;

  const trimmedOrder = [
    [fgPart, idlePart, appsPart, diskPart],
    [fgPart, idlePart, diskPart],
    [fgProc ? `前台=${fgProc}` : '', idlePart, diskPart],
  ];
  for (const group of trimmedOrder) {
    const next = group.filter(Boolean);
    if (next.length === 0) continue;
    line = `环境：${next.join('｜')}`;
    if ([...line].length <= maxChars) return line;
  }
  return clipChars(line, maxChars);
}

export async function searchEverything(query, options = {}) {
  const esPath = options.esPath ?? EVERYTHING_ES_PATH;
  const existsFn = options.existsFn ?? existsSync;
  if (!existsFn(esPath)) return { available: false, results: [] };
  const cleanQuery = String(query ?? '').replace(/[\r\n\0]/gu, ' ').trim();
  if (cleanQuery === '') return { available: true, results: [] };
  const runner = options.execRunner ?? execFileAsync;
  const res = await runner(esPath, ['-p', '-n', '20', cleanQuery], options.timeoutMs ?? ES_TIMEOUT_MS);
  if (!res.ok) return { available: true, results: [] };
  const results = res.stdout
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, 20);
  return { available: true, results };
}
