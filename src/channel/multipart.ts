import { randomBytes } from 'node:crypto';

/**
 * Irmia Agent — multipart/form-data 编码（零依赖）
 *
 * 为什么需要它：QQ 官方的**频道（guild）那条路**送媒体走的是 v1 的
 * `POST /channels/{channel_id}/messages` + **multipart**（字段 `file_image` 直接带文件字节），
 * 与 v2 的"先上传换 file_info、再 msg_type=7"完全不通用。
 * AstrBot 那边是靠 botpy 内部拼 multipart（它把 `file_image` 当路径，自己开文件上传）；
 * 我们零依赖，只能自己拼——那就把这块**单独放一个文件、单独钉用例**：
 * 二进制体是最容易"看起来对、实际错一个字节"的地方（CRLF、边界、结尾 `--`）。
 *
 * 只做这件事，不碰网络：调用方拿 `{ body, contentType }` 自己去发。
 */

/** 一个文本字段 */
export interface MultipartField {
  name: string;
  value: string;
}

/** 一个文件字段 */
export interface MultipartFile {
  name: string;
  filename: string;
  /** 文件内容（原始字节；不做任何转义） */
  data: Uint8Array;
  /** 可选 MIME；省了就不发 Content-Type 那一行 */
  contentType?: string;
}

export interface MultipartBody {
  body: Buffer;
  /** 直接当 `content-type` 头用（含 boundary） */
  contentType: string;
}

/**
 * 边界串：官方算法是 30 个 `-` + 随机 hex。
 * 这里用 `crypto.randomBytes`（与 node 自带一致的随机源），并保证**不会**出现在任何字段值或
 * 文件字节里——真出现了就换一个（文件字节是任意的，理论上撞得上；撞上就会把体切坏）。
 */
function pickBoundary(parts: readonly (string | Uint8Array)[]): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const random = randomBytes(16).toString('hex');
    const boundary = `----irmia${random}`;
    const needle = Buffer.from(boundary, 'utf8');
    if (!parts.some((part) => Buffer.from(part).includes(needle))) return boundary;
  }
  // 极端情况：随机 8 次都撞上（不可能）——加时间戳让步，宁可长一点也不要切坏
  return `----irmia${randomBytes(16).toString('hex')}${Date.now()}`;
}

/**
 * 拼一个 multipart/form-data 体。
 *
 * 口径（RFC 7578 / 官方文档一致）：每段以 `--<boundary>CRLF` 开头、`CRLF` 结尾，
 * 最后以 `--<boundary>--CRLF` 收束；字段与文件的区别只在文件那段多一行
 * `Content-Disposition` 带 `filename`，以及可选的 `Content-Type`。
 *
 * **一律用 CRLF**：只写 `\n` 的实现在很多服务端能过、在官方这边会解析失败——
 * 这正是值得单独钉住的那类细节。
 */
export function buildMultipartBody(input: {
  fields?: readonly MultipartField[];
  file?: MultipartFile;
  boundary?: string;
}): MultipartBody {
  const fields = input.fields ?? [];
  const file = input.file;
  const boundary = input.boundary
    ?? pickBoundary([
      ...fields.flatMap((field) => [field.name, field.value]),
      ...(file === undefined ? [] : [file.filename, file.data]),
    ]);

  const chunks: Buffer[] = [];
  const push = (text: string): void => { chunks.push(Buffer.from(text, 'utf8')); };
  const crlf = '\r\n';

  for (const field of fields) {
    push(`--${boundary}${crlf}`);
    // 名字里出现引号/换行会破坏头（调用方给的都是我们自己的常量，这里只做最小防护）
    push(`Content-Disposition: form-data; name="${field.name.replace(/["\r\n]/gu, '')}"${crlf}${crlf}`);
    push(field.value);
    push(crlf);
  }
  if (file !== undefined) {
    push(`--${boundary}${crlf}`);
    push(
      `Content-Disposition: form-data; name="${file.name.replace(/["\r\n]/gu, '')}";`
      + ` filename="${file.filename.replace(/["\r\n]/gu, '')}"${crlf}`,
    );
    push(`Content-Type: ${file.contentType ?? 'application/octet-stream'}${crlf}${crlf}`);
    chunks.push(Buffer.from(file.data)); // 原始字节，不转义
    push(crlf);
  }
  push(`--${boundary}--${crlf}`);

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

