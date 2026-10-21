/**
 * 原子写与同步睡眠 —— 原本长在 `web/server.ts` 里，2026-10 抽出来给「凭据文件」复用。
 *
 * 为什么必须抽出来而不是各写一份：`data/.auth.json` 与 `config.json` 是同一类东西——
 * **一份被并发请求读改写的 JSON**。写坏它的后果在这里格外重：凭据文件损坏 = 人再也进不去
 * 界面（忘了密码那条路是"删文件重启"，可那意味着重新设一次密码）。所以两处必须走
 * **同一份** tmp+fsync+rename 的实现，任何一边单独"改进"都会让另一边的保证失效。
 *
 * 关于 Windows 上 rename 的 EPERM：真正的根因是**并发的异步读句柄**（见 server.ts 的
 * `configFileLock` 长注释），那个由各自的调用方用闸/同步读解决；这里保留的一层退避重试
 * 兜的是另一类偶发——杀软/索引器恰好在扫那个临时文件或目标文件。重试对"写一份整文件 JSON"
 * 这种幂等重放完全安全的写入是划算的：把偶发失败原样抛给界面，人会以为"这个功能坏了"。
 */

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** 临时文件名里的进程内自增序号：同一拍里的两次写入要有各自的临时文件 */
let atomicWriteSeq = 0;

/** 同步睡眠（毫秒）：只在写入重试路径上用，绝不出现在请求主路径里 */
export function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/**
 * 原子写：临时文件 → fsync → rename 覆盖。
 *
 * 重试若干次（退避 10·2^n，合计最多约 1s）：本地盘上这已经是"异常持续存在"而不是
 * "偶发"的分界。实测：并发写同一份 config.json 时，10ms / 320ms 级的退避都不够——
 * Windows 的 `MoveFileEx(REPLACE_EXISTING)` 在目标文件正被另一个重命名打开时会回 EPERM，
 * 而那个窗口比想象的长（杀软、索引器都会掺一脚）。
 */
export function writeFileAtomicSync(path: string, text: string): void {
  atomicWriteSeq += 1;
  const tmp = `${path}.tmp.${process.pid}.${atomicWriteSeq}`;
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!transient || attempt >= 9) {
        try {
          unlinkSync(tmp);
        } catch {
          // 临时文件清不掉不影响失败结论（下次写入会盖掉自己的那份）
        }
        throw err;
      }
      // 同步睡一小会儿：这条路径本来就是"写一份小 JSON"，几十毫秒的阻塞换一次成功是划算的
      sleepSync(Math.min(100, 10 * 2 ** attempt));
    }
  }
}
