import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stickerExtension } from './media.ts';
import type { StickerMime } from './types.ts';

export const STICKER_PHASH_MAX_DISTANCE = 6;
export type StickerPHasher = (bytes: Buffer, mime: StickerMime) => Promise<string | null>;
const PHASH_RE = /^[0-9a-f]{16}$/u;

function b64Script(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}
function b64Path(path: string): string {
  return Buffer.from(path, 'utf8').toString('base64');
}
function powershellExe(): string {
  return join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function isHash(value: string | null): value is string {
  return value !== null && PHASH_RE.test(value);
}

/** 64-bit dHash as 16 lowercase hex chars; null on any failure. Never throws. */
export async function computeStickerPHash(bytes: Buffer, mime: StickerMime): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-sticker-phash-'));
  const path = join(dir, `image.${stickerExtension(mime)}`);
  try {
    writeFileSync(path, bytes);
    const [hash] = await computeStickerPHashBatch([path]);
    return hash ?? null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One PowerShell process for all paths. Output protocol is deliberately opaque:
 * `OK <index> <hash>` / `FAIL <index>`; paths never go to stdout/stderr.
 */
export async function computeStickerPHashBatch(paths: readonly string[]): Promise<Array<string | null>> {
  if (paths.length === 0) return [];
  // Paths go through a temp manifest, not the command line: 97 long paths would
  // otherwise exceed Windows' command-line limit. The manifest is base64 lines,
  // so even non-ASCII paths survive Windows PowerShell 5.1's encoding.
  const dir = mkdtempSync(join(tmpdir(), 'irmia-sticker-phash-batch-'));
  const manifest = join(dir, 'paths.b64');
  writeFileSync(manifest, `${paths.map(b64Path).join('\n')}\n`, 'utf8');
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Drawing',
    `$manifestPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64Path(manifest)}'))`,
    '$encoded = @(Get-Content -LiteralPath $manifestPath -Encoding UTF8 | Where-Object { $_ -ne "" })',
    '$paths = @()',
    'foreach ($line in $encoded) { $paths += [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) }',
    'for ($i = 0; $i -lt $paths.Count; $i++) {',
    '  $img = $null; $bmp = $null; $g = $null',
    '  try {',
    '    $img = [System.Drawing.Image]::FromFile($paths[$i])',
    '    $bmp = New-Object System.Drawing.Bitmap 9, 8, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)',
    '    $g = [System.Drawing.Graphics]::FromImage($bmp)',
    '    $g.Clear([System.Drawing.Color]::White)',
    '    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '    $g.DrawImage($img, 0, 0, 9, 8)',
    '    [UInt64]$hash = 0',
    '    for ($y = 0; $y -lt 8; $y++) {',
    '      for ($x = 0; $x -lt 8; $x++) {',
    '        $a = $bmp.GetPixel($x, $y); $b = $bmp.GetPixel($x + 1, $y)',
    '        $la = 0.299 * $a.R + 0.587 * $a.G + 0.114 * $a.B',
    '        $lb = 0.299 * $b.R + 0.587 * $b.G + 0.114 * $b.B',
    '        if ($la -gt $lb) { $hash = $hash -bor ([UInt64]1 -shl ($y * 8 + $x)) }',
    '      }',
    '    }',
    '    Write-Output ("OK {0} {1:x16}" -f $i, $hash)',
    '  } catch {',
    '    Write-Output ("FAIL {0}" -f $i)',
    '  } finally {',
    '    if ($null -ne $g) { $g.Dispose() }',
    '    if ($null -ne $bmp) { $bmp.Dispose() }',
    '    if ($null -ne $img) { $img.Dispose() }',
    '  }',
    '}',
  ].join('\n');

  try {
    const stdout = await new Promise<string | null>((resolve) => {
      try {
        execFile(
          powershellExe(),
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64Script(script)],
          {timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024},
          (error, out) => resolve(error === null ? out : null),
        );
      } catch {
        resolve(null);
      }
    });
    const out: Array<string | null> = paths.map(() => null);
    if (stdout === null) return out;
    for (const line of stdout.split(/\r?\n/u)) {
      const ok = /^OK (\d+) ([0-9a-f]{16})$/u.exec(line.trim());
      if (ok !== null) {
        const index = Number(ok[1]);
        if (Number.isInteger(index) && index >= 0 && index < out.length) out[index] = ok[2]!;
      }
    }
    return out;
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

/** 64-bit Hamming distance; malformed/absent hashes are treated as maximally distant. */
export function phashDistance(a: string | null | undefined, b: string | null | undefined): number {
  if (!isHash(a ?? null) || !isHash(b ?? null)) return 64;
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (x !== 0n) {
    x &= x - 1n;
    count += 1;
  }
  return count;
}
