/**
 * Irmia Agent — 附件仓库（把外部发来的图片落到本地）
 *
 * 存在的理由只有一条，但是硬的：**图片进上下文必须是本地字节**。
 *
 * QQ 的富媒体给的是**临时直链**（`multimedia.nt.qq.com.cn/download?...&rkey=…`）。把直链
 * 直接塞进 `input_image` 看起来能省一次下载，代价却是：那条 URL 一旦过期，服务端会返回
 * `400 Failed to download image`，而这条消息**永远留在历史里**——于是那条会话的每一次请求
 * 都必然失败，且她自己修不好（历史是只追加的）。实测拿一个取不到的地址请求，就是这个错。
 *
 * 所以约定是：**URL 只是"去哪取"的线索，进上下文的一律是本地那份字节**。
 *   • 落盘位置：`<dataDir>/blobs/images/<sha256(url)>`（内容寻址，同一张图重复发不重复存）
 *   • 不带扩展名：MIME 由事件里的 `type` 给出，不靠文件名猜
 *   • 写失败/超时一律降级——那条消息退化成纯文字（仍能看到地址），不阻塞 turn
 *
 * **大图先压再进**（`compressForContext`）：图片每轮请求都要重发一次，一张 2.2MB 的 PNG
 * 转成 base64 是 3MB——那笔上传开销与等待时间全落在"她回一句话"上。而模型端本来就会把图
 * 缩到自己的输入尺寸，我们传原图只是在替它搬像素。实测 640×1138 的 PNG（1.07MB）缩到
 * 1024 长边、存成 JPEG 质量 75 之后是 81KB（8%），一次约 0.5 秒。
 *
 * 谁负责下载与压缩（见 real-loop 的 prewarmRecentAttachments）：**每一拍 + 每一 step 边界**
 * 补扫新到的附件（2026-10-21 起后者才是主路：一整个 turn 会占住 tick，tick 上的预取在
 * turn 运行期间根本轮不到）。渲染层不下载也不读盘，它通过注入的 loader 拿 data URL（render 是纯函数）。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RenderImageRef } from '../model/render.ts';
import { decodeText } from '../util/bytes-text.ts';
import {
  buildContextImage,
  parseImageDataUrl,
  type ContextImageChosen,
  type ContextImageSkipReason,
} from '../log/types.ts';

/** 附件目录名（在 `<dataDir>/blobs/` 之下，与 tools/fs 的 blob 外置同域） */
export const ATTACHMENT_DIR_NAME = 'images';

/**
 * 下载上限：只防"这不是一张图"的意外（视频、压缩包），不是"进不进上下文"的门槛。
 *
 * 旧版这里是 1.5MB 的**硬上限**——超了那张图就完全不进上下文，只剩一个地址。用户否掉了
 * 这个口径：模型端本来就会压缩，卡在门口没有意义，该做的是**自己先压**（见 compressForContext）。
 */
export const DEFAULT_ATTACHMENT_DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024;

/**
 * 超过这个体积就先压一道。
 *
 * 定在 400KB 是因为它落在"base64 之后约 550KB"——一轮请求里带两张也就是 1MB 出头，
 * 而她一轮的正文本来就有十几 KB 到几十 KB。再大就该压，再小不值得起一次进程。
 */
export const CONTEXT_IMAGE_COMPRESS_ABOVE_BYTES = 400_000;

/** 压缩后的最长边：模型看图的输入尺寸用不到比这更大，再大只是替它搬像素 */
export const CONTEXT_IMAGE_MAX_EDGE = 1024;

/** JPEG 质量：75 是"看不出差别"与"体积掉一个量级"之间的常用点 */
export const CONTEXT_IMAGE_JPEG_QUALITY = 75;

/**
 * 压缩后的兜底上限：压完仍然超过它就不进上下文（留地址 + 让她用 vision_read 转述）。
 * 正常压缩到这个数是不可能的（实测 1MB PNG → 81KB），所以它只是防"压缩器半死不活"。
 */
export const CONTEXT_IMAGE_HARD_BYTES = 1_500_000;

/** 下载超时（毫秒）。等太久会把"回一句话"这件事拖成事故 */
export const DEFAULT_ATTACHMENT_TIMEOUT_MS = 5_000;

/** 压缩超时（毫秒）：起一次系统进程的开销在几百毫秒量级，给足余量 */
export const DEFAULT_COMPRESS_TIMEOUT_MS = 15_000;

export function attachmentDir(dataDir: string): string {
  return join(dataDir, 'blobs', ATTACHMENT_DIR_NAME);
}

/** 落盘路径：内容寻址（key 通常是那条临时直链），不带扩展名 */
export function attachmentPath(dataDir: string, key: string): string {
  const sha = createHash('sha256').update(key).digest('hex');
  return join(attachmentDir(dataDir), sha);
}

/** 压缩产物的路径：与原件同址加后缀，一眼看出它是"给上下文用的那一份" */
export function compressedPath(dataDir: string, key: string): string {
  return `${attachmentPath(dataDir, key)}.ctx.jpg`;
}

/**
 * 压缩器（注入点）：把 `source` 缩到 `maxEdge` 以内并以 JPEG 存到 `dest`。
 *
 * 返回 `boolean`（老写法）或 "成功与否 + **失败原因**"。后者是 2026-10-21 加的：
 * 压缩这条路**从未成功过**（107 个原件、0 个 `.ctx.jpg`，42 个 >400KB 的走过这条分支），
 * 而原来的返回值只有一个 false —— 于是"为什么没压成"（进程起不来？超时？脚本报错？）
 * 在日志上一个字都没有。判据与处置一个字没改（压缩失败仍然**不算错**，原件还在），
 * 改的只是"允许它说出来"。
 *
 * 默认实现走系统自带的 GDI+（Windows PowerShell 5.1 + System.Drawing）——这个项目零外部
 * 依赖，"缩个图"不值得为它破例；测试注入假实现，免得每次跑用例都起一个进程。
 */
export type ImageCompressor = (
  source: string,
  dest: string,
  options: { maxEdge: number; quality: number; timeoutMs: number },
) => Promise<boolean | ImageCompressResult>;

/** 压缩的结论：`ok=false` 时 `reason` 必须说清是哪一种失败（不许给空理由） */
export interface ImageCompressResult {
  ok: boolean;
  reason?: string;
}

let compressor: ImageCompressor = compressWithGdiPlus;

/** 测试注入点：传 null 恢复默认 */
export function setImageCompressorForTest(fn: ImageCompressor | null): void {
  compressor = fn ?? compressWithGdiPlus;
}

/**
 * 把子进程吐的字节解成能读的文字。
 *
 * 为什么不能直接 `String(stderr)`（2026-10-21）：Windows PowerShell 的 stderr 走**控制台输出
 * 编码**——中文系统上那是 GBK，而 Node 默认按 UTF-8 解 ⇒ 一整段替换字符，等于没留痕。
 * 判据：先按 UTF-8 解，出现 `\\uFFFD` 就按 GBK 再解一次（`chcp 65001` 的机器上第一次就对）。
 * 只影响"失败原因可不可读"，不影响任何成功/失败判定。
 */
function decodeConsoleOutput(bytes: string | Buffer): string {
  if (typeof bytes === 'string') return bytes;
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(bytes);
  } catch {
    return utf8;
  }
}

/**
 * 脚本侧的失败原因标记（2026-10-21）。
 *
 * 为什么要标记：PowerShell 的 stderr 被重定向时会包成 CLIXML——前面盖一行 `#< CLIXML`，
 * 后面跟一段 `<Objs …>`（"正在准备首次使用模块"这类进度噪声）。**原因就夹在信封中间**：
 * 按标签一刀切会把"路径中具有非法字符"整行连同信封一起吃掉（实测过），等于又静默了。
 * 所以原因单独打一行带标记的纯文字，Node 按行认它，不参与标签剥离。
 */
const COMPRESS_FAIL_MARKER = 'CTX-COMPRESS-FAIL: ';

/**
 * 从 stderr 里把失败原因拎出来：先认脚本打的标记行（最可靠），认不到再退回剥标签的残句。
 * 附带的 `stderrTail` 是给"exit 0 却没有回执 ok"这种更怪的失败留证据的。
 */
function extractCompressFailure(raw: string): { reason: string; stderrTail: string } {
  const lines = raw.split(/\r?\n/u);
  const marked = lines.find((line) => line.includes(COMPRESS_FAIL_MARKER));
  const at = marked === undefined ? -1 : marked.indexOf(COMPRESS_FAIL_MARKER);
  const reason = marked === undefined || at < 0 ? '' : marked.slice(at + COMPRESS_FAIL_MARKER.length).trim();
  if (reason !== '') return { reason, stderrTail: `；原因: ${reason.slice(0, 240)}` };
  // 退回：CLIXML 信封里是进度噪声，真正的报错在信封之前；整行去掉再剥残留标签
  const noise = lines
    .filter((line) => !/^\s*#< CLIXML/u.test(line) && !line.includes('<Objs'))
    .join(' ')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return { reason: '', stderrTail: noise === '' ? '' : `；stderr: ${noise.slice(0, 240)}` };
}

/**
 * 成功之后**要验产物**（2026-10-21）：`Save` 是"可能什么都没写就退出"的动作，光有回执不算成。
 * 读回字节：非空 + JPEG 的 SOI（`FF D8 FF`）开头 + EOI（`FF D9`）结尾，才算真压出一张能解码的
 * JPEG（GDI+ 的产物实测就是这两头，见验收读数 5,355,480 B → 51,325 B）。
 *
 * 坏产物**必须删掉**：`readAttachmentImage` 认 `.ctx.jpg` 只看"存在且非空"，留一份坏的在那儿
 * 就等于那张图以后每一轮都进请求体——比没压更糟。
 */
function verifyCompressedProduct(dest: string): ImageCompressResult {
  let bytes: Buffer;
  try {
    bytes = readFileSync(dest);
  } catch {
    return { ok: false, reason: '压缩进程回执 ok 但产物读不回来（没写出来）' };
  }
  const size = bytes.byteLength;
  if (size < 4) return { ok: false, reason: `压缩产物只有 ${size} 字节（不是一张图）` };
  const soi = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const eoi = bytes[size - 2] === 0xff && bytes[size - 1] === 0xd9;
  if (!soi || !eoi) {
    return { ok: false, reason: `压缩产物不是完整 JPEG（SOI=${String(soi)} EOI=${String(eoi)}，${size} 字节）` };
  }
  return { ok: true };
}

/**
 * 用系统自带的 GDI+ 缩一张图。
 *
 * **编码（2026-10-21 修的就是这一条）**：脚本本体用 `-EncodedCommand`（UTF-16LE base64）递进去，
 * 脚本里的**路径**也走 base64。原来两侧编码**不一致**——`b64()` 编 UTF-16LE、脚本却用
 * `[Text.Encoding]::UTF8.GetString` 解 ⇒ 路径变成乱码（字符之间夹着 NUL）⇒ `FromFile` 抛
 * "路径中具有非法字符" ⇒ `$src` 是 null ⇒ `DrawImage` 画不出 ⇒ `Save` 又路径非法；而这些全是
 * **非终止错误**（进程 exit 0、stdout 照旧 "ok"）⇒ 三层全静默。后果是这条路在真机上
 * **一次都没成功过**：107 个原件、0 个 `.ctx.jpg`。现在各用各的编码器（`b64Script` / `b64Path`），
 * 并且整段脚本包在 `try/catch` 里。
 *
 * **失败要真的失败**：`$ErrorActionPreference='Stop'`；脚本抛错 ⇒ `exit 1`；产物不存在/0 字节 ⇒
 * `exit 2`；产物解不开 ⇒ `exit 3`；只有真写出一张图才 `exit 0` + 回执 `ok`。
 * 原因走 `COMPRESS_FAIL_MARKER` 那一行，原样进 `compressFailure`。
 *
 * `export` 是给"真 PowerShell"的验收与反向用例用的：它是默认实现、不是注入点，
 * 用例里注入不了它（见 `_research/verify-ctx-compress.mts`）。
 */
export async function compressWithGdiPlus(
  source: string,
  dest: string,
  options: { maxEdge: number; quality: number; timeoutMs: number },
): Promise<ImageCompressResult> {
  // 两个编码器，**别混用**——2026-10-21 的根因就是混用：
  //   • 脚本本体必须 UTF-16LE，那是 `-EncodedCommand` 写死的传输格式
  //   • 脚本里的路径用 UTF-8，与脚本那边 `[Text.Encoding]::UTF8.GetString` 对上
  const b64Script = (text: string): string => Buffer.from(text, 'utf16le').toString('base64');
  const b64Path = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$fail = '${COMPRESS_FAIL_MARKER}'`,
    'try {',
    'Add-Type -AssemblyName System.Drawing',
    `$srcPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64Path(source)}'))`,
    `$dstPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64Path(dest)}'))`,
    `$max = ${options.maxEdge}`,
    '$src = [System.Drawing.Image]::FromFile($srcPath)',
    '$scale = [Math]::Min(1.0, $max / [Math]::Max($src.Width, $src.Height))',
    '$w = [int][Math]::Max(1, [Math]::Round($src.Width * $scale))',
    '$h = [int][Math]::Max(1, [Math]::Round($src.Height * $scale))',
    '$bmp = New-Object System.Drawing.Bitmap $w, $h',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '$g.DrawImage($src, 0, 0, $w, $h)',
    "$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }",
    '$p = New-Object System.Drawing.Imaging.EncoderParameters 1',
    `$p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ${options.quality}L`,
    '$bmp.Save($dstPath, $codec, $p)',
    '$g.Dispose(); $bmp.Dispose(); $src.Dispose()',
    // ② 产物不存在就**主动失败**：`Save` 没写出东西却 exit 0 是最坏的一种"成功"
    'if (-not (Test-Path -LiteralPath $dstPath -PathType Leaf)) { [Console]::Error.WriteLine($fail + "压缩产物没有生成：" + $dstPath); exit 2 }',
    '$len = (Get-Item -LiteralPath $dstPath).Length',
    'if ($len -le 0) { [Console]::Error.WriteLine($fail + "压缩产物是 0 字节：" + $dstPath); exit 2 }',
    // ④ 产物能读回来、解得出宽高才算成（坏图留一份比没压更糟）。
    //    单独兜住"解不开"这一种：它和"脚本本身抛错"不是同一回事，给 exit 3 便于在日志里区分。
    '$chk = $null; $cw = 0',
    'try { $chk = [System.Drawing.Image]::FromFile($dstPath); $cw = $chk.Width } catch { $chk = $null }',
    'if ($null -ne $chk) { $chk.Dispose() }',
    'if ($cw -le 0) { [Console]::Error.WriteLine($fail + "压缩产物解不开（GDI+ 读不回来）：" + $dstPath); exit 3 }',
    "Write-Output 'ok'",
    'exit 0',
    '} catch {',
    // 原因走专用标记行：普通 stderr 会被 CLIXML 信封吞掉（见 COMPRESS_FAIL_MARKER）
    '[Console]::Error.WriteLine($fail + $_.Exception.Message)',
    'exit 1',
    '}',
  ].join('\n');

  // 用系统自带的 Windows PowerShell，而不是 pwsh 7：压缩链不该依赖用户另装的 shell
  const exe = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return await new Promise<ImageCompressResult>((resolve) => {
    execFile(
      exe,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64Script(script)],
      // `encoding: 'buffer'`：stderr 里是中文报错（控制台编码，中文系统是 GBK）。
      // 让 Node 先别按 UTF-8 解——否则到我们手上已经是一串替换字符，"带原因"就名存实亡。
      { timeout: options.timeoutMs, windowsHide: true, encoding: 'buffer' },
      (err, stdout, stderr) => {
        const rawErr = decodeConsoleOutput(stderr);
        const { reason: scriptReason, stderrTail } = extractCompressFailure(rawErr);
        if (err) {
          // 产物先删：坏文件留在原地比没有更糟（readAttachmentImage 只认"存在且非空"）
          rmSync(dest, { force: true });
          // 超时与"根本起不来/脚本 exit≠0"是三种事故：判据是 err.killed 与退出码
          const killed = (err as { killed?: boolean }).killed === true;
          const code = String((err as { code?: number | string }).code ?? '?');
          const errText = scriptReason !== '' ? scriptReason : (rawErr.trim() || err.message);
          resolve({
            ok: false,
            reason: killed
              ? `压缩进程超时（>${options.timeoutMs}ms 未返回）`
              : `压缩进程退出码 ${code}：${errText.slice(0, 300)}`,
          });
          return;
        }
        // 判据是回执里那个 `ok`（ASCII），所以这里**本来就不会因为编码判错而坏掉**；
        // 走共享解码只是为了不再有"看着像 ok、其实是替换字符"的中间态字节串。
        const text = typeof stdout === 'string' ? stdout : decodeText(stdout).text;
        if (!text.includes('ok')) {
          resolve({ ok: false, reason: `压缩进程没有回执 ok（脚本报错或有一步没跑完）${stderrTail}` });
          return;
        }
        // ④ 回执 ok 不算数：读回产物、核过 JPEG 两头才算（见 verifyCompressedProduct）
        const verified = verifyCompressedProduct(dest);
        if (!verified.ok) rmSync(dest, { force: true });
        resolve(verified);
      },
    );
  });
}

export interface EnsureAttachmentOptions {
  /** 注入点：默认全局 fetch */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 允许落盘的最大字节数（只防"这不是一张图"，不是进不进上下文的门槛） */
  maxBytes?: number;
  /** 压缩后的最长边（默认 1024） */
  maxEdge?: number;
  /** JPEG 质量（默认 75） */
  quality?: number;
  /** 压缩超时（毫秒） */
  compressTimeoutMs?: number;
}

export type EnsureAttachmentOutcome = 'cached' | 'fetched' | 'skipped' | 'failed';

/** `ensureAttachment` 的结论（`compressFailure` 只在"走了压缩分支但没成"时出现） */
export interface EnsureAttachmentResult {
  outcome: EnsureAttachmentOutcome;
  bytes?: number;
  reason?: string;
  compressed?: boolean;
  /**
   * 压缩失败的原因（2026-10-21）。
   *
   * **它不改变结局**：原件还在，进不进上下文仍由 `readAttachmentImage` 那一刻的字节数判断
   * （压缩是优化，不是准入条件）。加这一格只是为了"别噤声"——调用方（`real-loop` 的预取）
   * 拿它落一条 `image/trace`，于是"压了但没成"在日志上查得到，而不是只能从"0 个 `.ctx.jpg`"反推。
   */
  compressFailure?: string;
}

/**
 * 确保 key 指向的图片在本地有一份，**并且有一份适合进上下文的**（大图会先压一道）。
 *
 * 任何失败都只是"这张图进不了上下文"，不是错误——调用方不该因为它中断 turn。
 */
export async function ensureAttachment(
  dataDir: string,
  key: string,
  options: EnsureAttachmentOptions = {},
): Promise<EnsureAttachmentResult> {
  if (key === '') return { outcome: 'skipped', reason: '空的附件标识' };
  const target = attachmentPath(dataDir, key);

  let downloaded: { outcome: EnsureAttachmentOutcome; bytes?: number; reason?: string };
  try {
    if (existsSync(target) && statSync(target).size > 0) {
      downloaded = { outcome: 'cached', bytes: statSync(target).size };
    } else {
      downloaded = await downloadAttachment(dataDir, key, target, options);
    }
  } catch (err) {
    return { outcome: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
  if (downloaded.outcome === 'failed' || downloaded.outcome === 'skipped') return downloaded;

  // 大图先压再算：压缩失败不算错——原件还在，进不进上下文由 readAttachmentImage 那一刻的字节头判断
  const size = downloaded.bytes ?? 0;
  if (size > CONTEXT_IMAGE_COMPRESS_ABOVE_BYTES) {
    const compressed = await ensureCompressed(dataDir, key, options);
    const result: EnsureAttachmentResult = { ...downloaded, compressed: compressed.ok };
    // 不写空理由：`reason: undefined` 在 exactOptionalPropertyTypes 下不合法，也没信息量
    if (!compressed.ok && compressed.reason !== undefined && compressed.reason !== '') {
      result.compressFailure = compressed.reason;
    }
    return result;
  }
  return downloaded;
}

/** 下载那一半：把 URL 的字节落到 `target` */
async function downloadAttachment(
  dataDir: string,
  key: string,
  target: string,
  options: EnsureAttachmentOptions,
): Promise<{ outcome: EnsureAttachmentOutcome; bytes?: number; reason?: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ATTACHMENT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_ATTACHMENT_DOWNLOAD_MAX_BYTES;
  try {
    const response = await fetchImpl(key, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      return { outcome: 'failed', reason: `HTTP ${response.status}` };
    }
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { outcome: 'skipped', reason: `附件 ${declared} 字节，超过下载上限 ${maxBytes}` };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0) return { outcome: 'failed', reason: '收到 0 字节' };
    if (buffer.byteLength > maxBytes) {
      return { outcome: 'skipped', reason: `附件 ${buffer.byteLength} 字节，超过下载上限 ${maxBytes}` };
    }
    mkdirSync(attachmentDir(dataDir), { recursive: true });
    writeFileSync(target, buffer);
    return { outcome: 'fetched', bytes: buffer.byteLength };
  } catch (err) {
    return { outcome: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 压缩那一半：已有压缩产物就直接用，否则起一次系统进程缩一道。
 *
 * 返回"现在有没有压缩产物 + 没有时的原因"，调用方不需要区分"这次压的"与"早就压好的"。
 * 2026-10-21 起失败**不再静默**：压缩器可以给 `{ok:false, reason}`，抛错也收成一句原因。
 */
async function ensureCompressed(
  dataDir: string,
  key: string,
  options: EnsureAttachmentOptions,
): Promise<ImageCompressResult> {
  const dest = compressedPath(dataDir, key);
  try {
    if (existsSync(dest) && statSync(dest).size > 0) return { ok: true };
  } catch {
    // 读不到当没有，继续压
  }
  try {
    const outcome = await compressor(attachmentPath(dataDir, key), dest, {
      maxEdge: options.maxEdge ?? CONTEXT_IMAGE_MAX_EDGE,
      quality: options.quality ?? CONTEXT_IMAGE_JPEG_QUALITY,
      timeoutMs: options.compressTimeoutMs ?? DEFAULT_COMPRESS_TIMEOUT_MS,
    });
    if (typeof outcome === 'boolean') {
      // 老写法（`boolean`）没有原因可给：如实说"没给原因"，不编一个
      return outcome ? { ok: true } : { ok: false, reason: '压缩器返回 false 且没有给出原因' };
    }
    return outcome;
  } catch (err) {
    return { ok: false, reason: `压缩器抛错：${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 把引用读成**能进请求体的图片**（渲染层的注入 loader 用它）。
 *
 * **优先读压缩产物**：有 `.ctx.jpg` 就用它——那份是专门为上下文准备的小图。
 * 没有就退回原件，但原件超过 `CONTEXT_IMAGE_HARD_BYTES` 时不给（压缩都压不下来的东西，
 * 塞进每一轮请求只会更糟）：那时的降级是她仍能看到地址、用 `vision_read` 转述。
 *
 * 2026-10-07（P0）：返回值从 `string | null` 改成"**拼好的一份** + 没拼出来时的**理由**"。
 * 起因是现场那个 400——OneBot 的附件声明是段类型裸标签 `image`，旧实现直接把它当 MIME 拼成
 * `data:image;base64,…`，模型判 unsupported image、每一拍都失败。现在型别由**字节头**说了算
 * （见 `buildContextImage`），字节头认不出、声明又不在白名单里就**不拼**，
 * 理由如实交出去（`real-loop` 的预热那条路会把它写进留痕）。
 *
 * 于是这一层是"最后一米"的守门人：**进上下文的图片，型别一定在模型认的白名单里**。
 * 返回 null 都表示"这张图这次不进上下文"，后果只是那条消息少一张图——比让整个请求 400 好得多。
 */
export type AttachmentImageRead =
  | { ok: true; image: ContextImageChosen; compressed: boolean }
  | { ok: false; reason: ContextImageSkipReason };

export function readAttachmentImage(
  dataDir: string,
  ref: RenderImageRef,
  hardBytes: number = CONTEXT_IMAGE_HARD_BYTES,
): AttachmentImageRead {
  if (ref.key === '') return { ok: false, reason: 'no-local-bytes' };
  // 内联字节那条（协议端把段里的 `base64://` 翻成 data URL）：字节就在 key 里，不必落盘。
  // 型别以**它自己声明的**为准（那是这段字节唯一的出处），仍要过白名单。
  if (/^data:/iu.test(ref.key.trim())) {
    const parsed = parseImageDataUrl(ref.key);
    if (parsed === null) return { ok: false, reason: 'data-url-unreadable' };
    if (parsed.bytes.byteLength > hardBytes) return { ok: false, reason: 'too-large' };
    return {
      ok: true,
      compressed: false,
      image: { mediaType: parsed.mediaType, dataUrl: `data:${parsed.mediaType};base64,${parsed.bytes.toString('base64')}` },
    };
  }
  // 压缩产物是我们自己用 JPEG 编出来的：它一定在白名单里，不必再嗅一遍
  const small = compressedPath(dataDir, ref.key);
  try {
    if (existsSync(small) && statSync(small).size > 0) {
      return {
        ok: true,
        compressed: true,
        image: { mediaType: 'image/jpeg', dataUrl: `data:image/jpeg;base64,${readFileSync(small).toString('base64')}` },
      };
    }
  } catch {
    // 压缩产物读不到就退回原件
  }
  try {
    const path = attachmentPath(dataDir, ref.key);
    if (!existsSync(path)) return { ok: false, reason: 'no-local-bytes' };
    const size = statSync(path).size;
    if (size === 0) return { ok: false, reason: 'no-local-bytes' };
    if (size > hardBytes) return { ok: false, reason: 'too-large' };
    const bytes = readFileSync(path);
    // 型别以**字节头**为准（声明那一栏可能是 OneBot 的裸标签 `image`），拼不出来就不进
    const image = buildContextImage(bytes, ref.mime);
    if (image === null) return { ok: false, reason: 'unknown-media-type' };
    return { ok: true, image, compressed: false };
  } catch {
    return { ok: false, reason: 'no-local-bytes' };
  }
}

/** `readAttachmentImage` 的 data URL（渲染层的 loader 只关心这一栏）；不进上下文时给 null */
export function readAttachmentDataUrl(
  dataDir: string,
  ref: RenderImageRef,
  hardBytes: number = CONTEXT_IMAGE_HARD_BYTES,
): string | null {
  const read = readAttachmentImage(dataDir, ref, hardBytes);
  return read.ok ? read.image.dataUrl : null;
}

/**
 * 把工作目录内的一个图片文件读成**能进请求体的图片**——给"她自己要求把这张放进上下文"用
 * （vision_read 的直通模式走 `image/attached` 事件，key 就是那个文件路径）。
 *
 * 与附件那条路同一个收口（`buildContextImage`）：文件名/扩展名只是线索，进请求体的型别
 * 以**字节头**为准——同一条纪律不在两处各写一遍，就不会有一处漏掉。
 */
export function readFileImage(absPath: string, mime: string, maxBytes: number): AttachmentImageRead {
  try {
    if (!existsSync(absPath)) return { ok: false, reason: 'no-local-bytes' };
    const size = statSync(absPath).size;
    if (size === 0) return { ok: false, reason: 'no-local-bytes' };
    if (size > maxBytes) return { ok: false, reason: 'too-large' };
    const image = buildContextImage(readFileSync(absPath), mime);
    if (image === null) return { ok: false, reason: 'unknown-media-type' };
    return { ok: true, image, compressed: false };
  } catch {
    return { ok: false, reason: 'no-local-bytes' };
  }
}

/** `readFileImage` 的 data URL；不进上下文时给 null */
export function readFileDataUrl(absPath: string, mime: string, maxBytes: number): string | null {
  const read = readFileImage(absPath, mime, maxBytes);
  return read.ok ? read.image.dataUrl : null;
}
