import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

import { sniffStickerMime, stickerDimensions, stickerExtension } from './media.ts';
import type { StickerMime } from './types.ts';

export interface StickerResizeInput {
  bytes: Buffer;
  mime: StickerMime;
  maxEdge: number;
  timeoutMs?: number;
}

export interface StickerResizeResult {
  bytes: Buffer;
  mime: StickerMime;
  width: number;
  height: number;
  resized: true;
}

/** Injectable for tests; null = resize failed / fallback to original. GIF must never be passed. */
export type StickerResizer = (input: StickerResizeInput) => Promise<StickerResizeResult | null>;

function b64Script(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}
function b64Path(path: string): string {
  return Buffer.from(path, 'utf8').toString('base64');
}

function powershellExe(): string {
  return join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * GDI+ resize with no npm dependency. PNG/WebP become PNG (32bpp ARGB keeps
 * transparency); JPEG becomes JPEG quality ~80. The caller validates the output
 * and may keep the original on null.
 */
export const resizeStickerImage: StickerResizer = async (input) => {
  if (input.mime === 'image/gif') return null;
  const maxEdge = Math.max(1, Math.trunc(input.maxEdge));
  const dir = mkdtempSync(join(tmpdir(), 'irmia-sticker-resize-'));
  const isJpeg = input.mime === 'image/jpeg';
  const inPath = join(dir, `in.${stickerExtension(input.mime)}`);
  const outPath = join(dir, isJpeg ? 'out.jpg' : 'out.png');
  try {
    writeFileSync(inPath, input.bytes);
    const script = [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.Drawing',
      `$srcPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64Path(inPath)}'))`,
      `$dstPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64Path(outPath)}'))`,
      `$max = ${maxEdge}`,
      'try {',
      '  $src = [System.Drawing.Image]::FromFile($srcPath)',
      '  $scale = [Math]::Min(1.0, $max / [Math]::Max($src.Width, $src.Height))',
      '  $w = [int][Math]::Max(1, [Math]::Round($src.Width * $scale))',
      '  $h = [int][Math]::Max(1, [Math]::Round($src.Height * $scale))',
      isJpeg
        ? '  $bmp = New-Object System.Drawing.Bitmap $w, $h'
        : '  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)',
      '  $g = [System.Drawing.Graphics]::FromImage($bmp)',
      ...(isJpeg
        ? []
        : [
          '  $g.Clear([System.Drawing.Color]::Transparent)',
          '  $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy',
        ]),
      '  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
      '  $g.DrawImage($src, 0, 0, $w, $h)',
      ...(isJpeg
        ? [
          "  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }",
          '  $p = New-Object System.Drawing.Imaging.EncoderParameters 1',
          '  $p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 80L',
          '  $bmp.Save($dstPath, $codec, $p)',
        ]
        : ['  $bmp.Save($dstPath, [System.Drawing.Imaging.ImageFormat]::Png)']),
      '  $g.Dispose(); $bmp.Dispose(); $src.Dispose()',
      '} catch {',
      '  [Console]::Error.WriteLine($_.Exception.Message)',
      '  exit 1',
      '}',
      'if (-not (Test-Path -LiteralPath $dstPath -PathType Leaf)) { exit 2 }',
      'if ((Get-Item -LiteralPath $dstPath).Length -le 0) { exit 2 }',
      'exit 0',
    ].join('\n');
    const ok = await new Promise<boolean>((resolve) => {
      execFile(
        powershellExe(),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64Script(script)],
        {timeout: input.timeoutMs ?? 10_000, windowsHide: true},
        (error) => resolve(error === null),
      );
    });
    if (!ok) return null;
    const bytes = readFileSync(outPath);
    const mime = sniffStickerMime(bytes);
    if (mime === null || bytes.length === 0) return null;
    const dims = stickerDimensions(bytes, mime);
    if (dims === null || dims.width <= 0 || dims.height <= 0) return null;
    if (dims.width > maxEdge || dims.height > maxEdge) return null;
    const expected: StickerMime = isJpeg ? 'image/jpeg' : 'image/png';
    if (mime !== expected) return null;
    return {bytes, mime, width: dims.width, height: dims.height, resized: true};
  } catch {
    return null;
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
};
