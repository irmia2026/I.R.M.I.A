/**
 * 多帧 GIF → 帧序列矩阵图。
 *
 * 设计约束（2026-11-11 用户定）：
 *   · 不依赖 ffmpeg/ImageMagick；用 Windows 自带 PowerShell 5.1 + System.Drawing；
 *   · 0.7s 是默认采样间隔，但短 GIF 全取、长 GIF 受 24 帧上限保护；
 *   · 顶部固定写「框架自动采样的gif动图表情，下为帧序列：」；
 *   · 每格按采样顺序写 #1、#2、#3…（不写原始帧号与秒数）。
 *
 * 转换是**预取阶段**的异步动作；`readAttachmentImage` 那一刻只同步读产物，不在这里起进程。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const GIF_MATRIX_VERSION = 'v2';
export const GIF_MATRIX_TOP_TEXT = '框架自动采样的gif动图表情，下为帧序列：';

const FAIL_MARKER = 'GIF-MATRIX-FAIL: ';

export interface GifMatrixResult {
  ok: boolean;
  path?: string;
  frames?: number;
  selected?: number;
  intervalMs?: number;
  reason?: string;
}

/** 矩阵图缓存位置：按原附件 key 内容寻址，转换器版本变了自动换文件。 */
export function gifMatrixPath(dataDir: string, key: string): string {
  const hash = createHash('sha256').update(`${GIF_MATRIX_VERSION}\n${key}`).digest('hex').slice(0, 32);
  return resolve(dataDir, 'blobs', 'images', `${hash}.gif-matrix-${GIF_MATRIX_VERSION}.jpg`);
}

/** 只认 GIF 字节头；扩展名与声明都不可信。 */
export function isGifFile(path: string): boolean {
  try {
    const bytes = readFileSync(path).subarray(0, 6);
    return bytes.toString('ascii') === 'GIF87a' || bytes.toString('ascii') === 'GIF89a';
  } catch {
    return false;
  }
}

function verifyJpeg(path: string): { ok: true } | { ok: false; reason: string } {
  try {
    const bytes = readFileSync(path);
    const size = bytes.byteLength;
    if (size < 4) return { ok: false, reason: `矩阵图只有 ${size} 字节` };
    const soi = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const eoi = bytes[size - 2] === 0xff && bytes[size - 1] === 0xd9;
    if (!soi || !eoi) return { ok: false, reason: `矩阵图不是完整 JPEG（${size} 字节）` };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `矩阵图读不回来：${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 把一份已落盘的 GIF 转成矩阵图。
 *
 * 重复调用是幂等的：产物已在且非空就直接返回。`source` 不存在、不是 GIF、
 * 只有一帧、或 PowerShell/GDI+ 失败，都只返回 `ok:false`——调用方继续用原图，
 * 不能因为转换失败把消息丢掉。
 */
export async function ensureGifMatrix(
  source: string,
  dest: string,
  options: { timeoutMs?: number; maxFrames?: number; targetFrames?: number } = {},
): Promise<GifMatrixResult> {
  if (!existsSync(source)) return { ok: false, reason: '原图不存在' };
  if (!isGifFile(source)) return { ok: false, reason: '不是 GIF' };
  if (existsSync(dest) && statSync(dest).size > 0) {
    const verified = verifyJpeg(dest);
    return verified.ok ? { ok: true, path: dest } : { ok: false, reason: verified.reason };
  }

  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxFrames = Math.max(2, Math.min(48, options.maxFrames ?? 24));
  const targetFrames = Math.max(2, Math.min(maxFrames, options.targetFrames ?? 12));
  const b64Script = (text: string): string => Buffer.from(text, 'utf16le').toString('base64');
  const b64Path = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$fail = '${FAIL_MARKER}'`,
    'try {',
    'Add-Type -AssemblyName System.Drawing',
    `$srcPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64Path(source)}'))`,
    `$dstPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64Path(dest)}'))`,
    `$maxFrames = ${maxFrames}`,
    `$targetFrames = ${targetFrames}`,
    '$topText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(' +
      `'${b64Path(GIF_MATRIX_TOP_TEXT)}'))`,
    '$img = [System.Drawing.Image]::FromFile($srcPath)',
    '$dim = [System.Drawing.Imaging.FrameDimension]::Time',
    '$count = $img.GetFrameCount($dim)',
    'if ($count -le 1) { $img.Dispose(); Write-Output "static"; exit 0 }',
    // GIF delay 单位是 1/100 秒；0 按浏览器惯例补 100ms，避免 0ms 帧被无限采样。
    '$prop = $img.GetPropertyItem(0x5100)',
    '$delays = @()',
    'for ($i = 0; $i -lt $count; $i++) {',
    '  $d = [BitConverter]::ToInt32($prop.Value, $i * 4)',
    '  if ($d -le 0) { $d = 10 }',
    '  $delays += ($d * 10)',
    '}',
    '$times = @(); $t = 0',
    'for ($i = 0; $i -lt $count; $i++) { $times += $t; $t += $delays[$i] }',
    '$duration = $t',
    '$selected = @()',
    // 短 GIF 全取；长 GIF 用 0.7s 默认间隔，超过 24 帧上限时改覆盖全长。
    'if ($count -le $targetFrames) {',
    '  for ($i = 0; $i -lt $count; $i++) { $selected += $i }',
    '} else {',
    '  $interval = if ($duration -gt 0) { $duration / ($targetFrames - 1) } else { 700 }',
    '  if ($interval -lt 250) { $interval = 250 }',
    '  if ($interval -gt 700) { $interval = 700 }',
    '  $needed = [Math]::Floor($duration / $interval) + 1',
    '  if ($needed -gt $maxFrames) { $interval = $duration / ($maxFrames - 1) }',
    '  $next = 0',
    '  for ($i = 0; $i -lt $count; $i++) {',
    '    if ($times[$i] + 0.5 -ge $next) {',
    '      $selected += $i',
    '      $next = $times[$i] + $interval',
    '      if ($selected.Count -ge $maxFrames) { break }',
    '    }',
    '  }',
    '  if ($selected.Count -lt $maxFrames -and $selected[$selected.Count - 1] -ne ($count - 1)) {',
    '    $selected += ($count - 1)',
    '  }',
    '}',
    '$cols = 4',
    '$tile = 320',
    '$gap = 6',
    '$margin = 12',
    '$header = 56',
    '$rows = [Math]::Ceiling($selected.Count / $cols)',
    '$w = $margin * 2 + $cols * $tile + ($cols - 1) * $gap',
    '$h = $header + $margin * 2 + $rows * $tile + ($rows - 1) * $gap',
    '$bmp = New-Object System.Drawing.Bitmap $w, $h',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality',
    '$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '$bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(245, 246, 248))',
    '$g.FillRectangle($bg, 0, 0, $w, $h)',
    '$headBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(24, 32, 48))',
    '$g.FillRectangle($headBrush, 0, 0, $w, $header)',
    '$white = [System.Drawing.Brushes]::White',
    '$font = New-Object System.Drawing.Font "Microsoft YaHei", 18, ([System.Drawing.FontStyle]::Bold)',
    '$labelFont = New-Object System.Drawing.Font "Microsoft YaHei", 12, ([System.Drawing.FontStyle]::Bold)',
    '$g.DrawString($topText, $font, $white, 14, 14)',
    '$labelBg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(170, 0, 0, 0))',
    'for ($n = 0; $n -lt $selected.Count; $n++) {',
    '  $idx = $selected[$n]',
    '  $img.SelectActiveFrame($dim, $idx)',
    '  $col = $n % $cols; $row = [Math]::Floor($n / $cols)',
    '  $x = $margin + $col * ($tile + $gap)',
    '  $y = $header + $margin + $row * ($tile + $gap)',
    '  $g.FillRectangle($bg, $x, $y, $tile, $tile)',
    // 保持原比例，居中落在格子里；透明 GIF 用浅底，不要叠出黑块。
    '  $scale = [Math]::Min($tile / $img.Width, $tile / $img.Height)',
    '  $dw = [int][Math]::Max(1, [Math]::Round($img.Width * $scale))',
    '  $dh = [int][Math]::Max(1, [Math]::Round($img.Height * $scale))',
    '  $dx = $x + [int](($tile - $dw) / 2); $dy = $y + [int](($tile - $dh) / 2)',
    '  $g.DrawImage($img, $dx, $dy, $dw, $dh)',
    '  # 视频理解将来需要时间轴时，可还原下面这行（帧号 + 秒数）：',
    '  # $label = "#" + ($idx + 1) + " · " + ([Math]::Round($times[$idx] / 1000, 2)) + "s"',
    '  # 动态表情包当前只标采样顺序，减少无关信息。',
    '  $label = "#" + ($n + 1)',
    '  $g.FillRectangle($labelBg, $x, $y + $tile - 26, $tile, 26)',
    '  $g.DrawString($label, $labelFont, $white, $x + 8, $y + $tile - 24)',
    '}',
    "$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }",
    '$p = New-Object System.Drawing.Imaging.EncoderParameters 1',
    '$p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 85L',
    '$bmp.Save($dstPath, $codec, $p)',
    '$g.Dispose(); $bmp.Dispose(); $img.Dispose()',
    'if (-not (Test-Path -LiteralPath $dstPath -PathType Leaf)) { [Console]::Error.WriteLine($fail + "矩阵图没有生成：" + $dstPath); exit 2 }',
    '$len = (Get-Item -LiteralPath $dstPath).Length',
    'if ($len -le 0) { [Console]::Error.WriteLine($fail + "矩阵图是 0 字节：" + $dstPath); exit 2 }',
    '$intervalMs = [int][Math]::Round($duration / [Math]::Max(1, $selected.Count - 1))',
    'Write-Output ("ok|" + $count + "|" + $selected.Count + "|" + $intervalMs)',
    'exit 0',
    '} catch {',
    '[Console]::Error.WriteLine($fail + $_.Exception.Message)',
    'exit 1',
    '}',
  ].join('\n');

  const exe = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const run = await new Promise<{ ok: true; text: string } | { ok: false; reason: string }>((resolveRun) => {
    execFile(
      exe,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64Script(script)],
      { timeout: timeoutMs, windowsHide: true, encoding: 'buffer' },
      (err, stdout, stderr) => {
        const errText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr);
        const outText = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout);
        if (err) {
          rmSync(dest, { force: true });
          const marked = errText.split(/\r?\n/u).find((line) => line.includes(FAIL_MARKER));
          const reason = marked === undefined ? errText.trim() : marked.slice(marked.indexOf(FAIL_MARKER) + FAIL_MARKER.length);
          resolveRun({ ok: false, reason: reason === '' ? err.message : reason });
          return;
        }
        if (!outText.includes('ok|') && !outText.includes('static')) {
          rmSync(dest, { force: true });
          resolveRun({ ok: false, reason: `转换器没有回执：${outText.trim().slice(0, 200)}` });
          return;
        }
        resolveRun({ ok: true, text: outText.trim() });
      },
    );
  });
  if (!run.ok) return run;
  if (run.text.includes('static')) return { ok: false, reason: '单帧 GIF，无需转换' };
  const verified = verifyJpeg(dest);
  if (!verified.ok) {
    rmSync(dest, { force: true });
    return { ok: false, reason: verified.reason };
  }
  const parts = run.text.split('|');
  return {
    ok: true,
    path: dest,
    frames: Number(parts[1] ?? 0),
    selected: Number(parts[2] ?? 0),
    intervalMs: Number(parts[3] ?? 0),
  };
}
