import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('./pillow-worker.py', import.meta.url));
let running = false;
const waiters: Array<() => void> = [];

/** Serialize decoders and bound the amount of work waiting for one. No process stays resident. */
export async function runPillow(args: readonly string[], timeoutMs: number): Promise<{ value: unknown } | { error: string }> {
  if (running) {
    if (waiters.length >= 4) return { error: '图片处理繁忙' };
    await new Promise<void>(resolve => waiters.push(resolve));
  }
  running = true;
  try {
    return await new Promise(resolve => {
      execFile(process.env['IRMIA_IMAGE_PYTHON']?.trim() || 'python3', ['-I', worker, ...args], {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 512 * 1024,
        encoding: 'utf8',
      }, (error, stdout) => {
        let value: unknown;
        try { value = JSON.parse(stdout); } catch { /* The process may have failed before writing anything. */ }
        if (error === null) {
          return resolve(value === undefined ? { error: '图片处理没有有效回执' } : { value });
        }
        const reason = value !== null && typeof value === 'object' && 'error' in value ? String(value.error) : '';
        resolve({ error: error.killed ? '图片处理超时' : reason || '图片处理需要 Python 3 和 Pillow（Ubuntu：python3-pil）' });
      });
    });
  } finally {
    const next = waiters.shift();
    if (next === undefined) running = false;
    else next();
  }
}

/** Publish only a completed result. GIFs may intentionally return no file when they are static. */
export async function writePillowImage(
  operation: 'resize' | 'gif', source: string, dest: string, args: readonly string[], timeoutMs: number,
  validate: (file: string) => boolean,
): Promise<{ value: unknown } | { error: string }> {
  const temp = dest + '.' + randomUUID() + '.tmp';
  try {
    await mkdir(dirname(dest), { recursive: true });
    const result = await runPillow([operation, source, temp, ...args], timeoutMs);
    if ('error' in result) return result;
    if (result.value !== null && typeof result.value === 'object'
      && 'static' in result.value && result.value.static === true) return result;
    if (!validate(temp)) return { error: '图片处理产物不完整' };
    await rename(temp, dest);
    return result;
  } catch {
    return { error: '图片处理产物无法写入' };
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}
