/**
 * SSE 分帧（**逐字搬自** `src/model/ds-client.ts:665-718`，一个字都没改）。
 *
 * 为什么单独一个文件：分帧是**协议无关**的（Responses 与 Chat Completions 都是 SSE，只是事件名与
 * 结束哨兵不同）。把它放在 `transport/` 层，两个协议实现共用同一份"按空行切帧、容忍孤立 CR、
 * flush 收残留帧"的判据——两边各写一份必然在"跨 chunk 断行"这种边界上分叉。
 *
 * ⚠ 搬运纪律：**函数体、注释、判据顺序一个字都不许改**。B 阶段的准入条件是"Responses 路径的
 * 请求字节逐字节不变"（`test/protocol-bytes.test.ts`），而分帧改错的症状是**响应解析**变样
 * （`test/ds-client.test.ts` 那 22 条会红）——两条判据一起看。
 */
// ──────────────────────────────── SSE 解析 ────────────────────────────────

export interface SseFrame {
  /** `event:` 字段；DeepSeek 语义化流里与 data 内的 type 一致，取 data 为准 */
  event: string | null;
  data: string;
}

/**
 * SSE 分帧器。按空行切帧，容忍跨 chunk 断裂的行尾（孤立 CR 也当换行——
 * 规范允许 CR / LF / CRLF 三种行尾，Node 的 chunk 边界不会照顾我们）。
 * 空 data 帧（多切出来的空行）直接丢弃，不让它污染上层状态机。
 */
export class SseFrameDecoder {
  private buffer = '';

  push(chunk: string): SseFrame[] {
    this.buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const frames: SseFrame[] = [];
    for (;;) {
      const sep = this.buffer.indexOf('\n\n');
      if (sep < 0) break;
      const raw = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const frame = parseSseFrame(raw);
      if (frame !== null) frames.push(frame);
    }
    return frames;
  }

  /** 流结束时的残留帧：服务端最后一个事件后没补空行也能收干净 */
  flush(): SseFrame[] {
    const raw = this.buffer;
    this.buffer = '';
    const frame = parseSseFrame(raw);
    return frame === null ? [] : [frame];
  }
}

function parseSseFrame(raw: string): SseFrame | null {
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}