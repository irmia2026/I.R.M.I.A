/**
 * MCP 工具结果里的图片 → 上下文（唯一实现）。
 *
 * 背景（2026-10-30，她反馈）：桌面操控类 MCP server 的 `look` 把截图作为 MCP `image` 内容返回，
 * 而客户端原来只把它渲染成一句「[image 内容：…（本版不落盘二进制）]」——图永远进不了上下文。
 *
 * 两条路（与 `vision_read` 的 inline 同一条）：
 *   ① 落盘到 `<dataDir>/workspace/attachments/mcp/<server>/<sha>.<ext>`；
 *   ② 写一条 `image/attached` 事件（model 可见）——渲染层据此把图作为 `input_image` 注入下一次请求。
 *
 * 判据不在这里另写一份白名单：型别走 `contextImageMediaType`（`log/types.ts` 唯一实现），
 * 与渲染层挑图用的是同一把尺。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { contextImageMediaType } from '../log/types.ts';

/** 单张图上限（原始字节）：超过就不进上下文，只留占位文本 */
export const MCP_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export interface McpImageInput {
  server: string;
  tool: string;
  mimeType: string;
  dataBase64: string;
}

export interface McpImageAttacherOptions {
  dataDir: string;
  /** `config.vision.imagesToContext`：关掉时一张都不接（与 QQ 图片同一条闸） */
  enabled: boolean;
  /** 写 `image/attached`（可见性由调用方按 `resolveEventVisibility` 判） */
  append: (data: { key: string; mime: string }) => void;
  /** 没接的原因（进宿主日志；不抛） */
  onSkip?: (reason: string) => void;
}

/**
 * 造一个 `attachImage` 回调（MCP 池的 `attachImage` 选项直接用它）。
 *
 * 返回 `null` 的四种情形都必须说清：图片直通关着、型别不在白名单、字节超限、落盘失败。
 * **不许静默**——静默的表现就是"回执说进了、请求体里没有"，那正是这个 bug 的形状。
 */
export function makeMcpImageAttacher(
  options: McpImageAttacherOptions,
): (input: McpImageInput) => { key: string } | null {
  const workspaceRoot = join(options.dataDir, 'workspace');
  return (input) => {
    if (!options.enabled) {
      options.onSkip?.('config.vision.imagesToContext=false：图片直通没开');
      return null;
    }
    const mime = contextImageMediaType(input.mimeType);
    if (mime === null) {
      options.onSkip?.(`型别 ${input.mimeType} 不在上下文白名单（png/jpeg/gif/webp）`);
      return null;
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(input.dataBase64, 'base64');
    } catch {
      options.onSkip?.('base64 解不开');
      return null;
    }
    if (bytes.byteLength === 0) {
      options.onSkip?.('图片字节为空');
      return null;
    }
    if (bytes.byteLength > MCP_IMAGE_MAX_BYTES) {
      options.onSkip?.(`图片 ${bytes.byteLength} 字节超过 ${MCP_IMAGE_MAX_BYTES} 上限`);
      return null;
    }
    const ext = mime === 'image/png' ? 'png'
      : mime === 'image/jpeg' ? 'jpg'
        : mime === 'image/gif' ? 'gif' : 'webp';
    const server = input.server.replace(/[^A-Za-z0-9_-]/gu, '_');
    const dir = join(workspaceRoot, 'attachments', 'mcp', server);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      options.onSkip?.(`建目录失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const file = join(dir, `${hash}.${ext}`);
    try {
      if (!existsSync(file)) writeFileSync(file, bytes);
    } catch (error) {
      options.onSkip?.(`落盘失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    const key = relative(workspaceRoot, file).split(sep).join('/');
    options.append({ key, mime });
    return { key };
  };
}
