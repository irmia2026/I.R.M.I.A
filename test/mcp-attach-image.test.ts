/**
 * MCP 图片落盘/接入（`src/mcp/attach-image.ts`）单测。
 *
 * 背景：桌面操控类 MCP server 把截图作为 MCP `image` 内容返回，而框架原来只给一句
 * 「[image 内容…本版不落盘二进制]」——图永远进不了上下文（2026-10-30 她反馈）。
 *
 * 这里钉四件事：① 接住时落盘 + 写事件 + 返回工作区相对路径；② 关掉直通时不接；
 * ③ 型别不在白名单时不接；④ 超过上限时不接。所有"不接"都必须给出原因（`onSkip`），
 * 不许静默——静默的表现就是"回执说进了、请求体里没有"。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';

import { MCP_IMAGE_MAX_BYTES, makeMcpImageAttacher } from '../src/mcp/attach-image.ts';

/** 1x1 透明 PNG（67 字节） */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function fixture(): { dataDir: string; cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'irmia-mcp-img-'));
  return { dataDir, cleanup: () => rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 }) };
}

test('接住：落盘到 workspace/attachments/mcp/<server>/，写 image 事件，返回工作区相对路径', (t) => {
  const { dataDir, cleanup } = fixture();
  t.after(cleanup);
  const events: Array<{ key: string; mime: string }> = [];
  const attach = makeMcpImageAttacher({
    dataDir,
    enabled: true,
    append: (data) => events.push(data),
  });
  const result = attach({ server: 'desk-mcp', tool: 'look', mimeType: 'image/png', dataBase64: PNG_B64 });
  assert.notEqual(result, null);
  const key = result?.key ?? '';
  assert.match(key, /^attachments\/mcp\/desk-mcp\/[0-9a-f]{16}\.png$/u, key);
  const file = join(dataDir, 'workspace', key.split('/').join(sep));
  assert.equal(existsSync(file), true, '图片要真落盘');
  assert.deepEqual(readFileSync(file), Buffer.from(PNG_B64, 'base64'));
  assert.deepEqual(events, [{ key, mime: 'image/png' }]);
  // 同字节第二次：同一份内容寻址、不重复写、仍然返回同一 key
  const again = attach({ server: 'desk-mcp', tool: 'look', mimeType: 'image/png', dataBase64: PNG_B64 });
  assert.equal(again?.key, key);
  assert.equal(events.length, 2, '每次接入都写一条事件（渲染层按事件挑图）');
});

test('直通关掉：不落盘、不写事件，原因说清', (t) => {
  const { dataDir, cleanup } = fixture();
  t.after(cleanup);
  const skipped: string[] = [];
  const events: unknown[] = [];
  const attach = makeMcpImageAttacher({
    dataDir,
    enabled: false,
    append: (data) => events.push(data),
    onSkip: (reason) => skipped.push(reason),
  });
  assert.equal(attach({ server: 's', tool: 't', mimeType: 'image/png', dataBase64: PNG_B64 }), null);
  assert.equal(events.length, 0);
  assert.deepEqual(skipped, ['config.vision.imagesToContext=false：图片直通没开']);
});

test('型别不在白名单：不接，原因点出白名单', (t) => {
  const { dataDir, cleanup } = fixture();
  t.after(cleanup);
  const skipped: string[] = [];
  const attach = makeMcpImageAttacher({ dataDir, enabled: true, append: () => undefined, onSkip: (r) => skipped.push(r) });
  assert.equal(attach({ server: 's', tool: 't', mimeType: 'image/bmp', dataBase64: PNG_B64 }), null);
  assert.match(skipped[0] ?? '', /不在上下文白名单/u);
});

test('超过上限：不接，原因带实际字节数', (t) => {
  const { dataDir, cleanup } = fixture();
  t.after(cleanup);
  const skipped: string[] = [];
  const attach = makeMcpImageAttacher({ dataDir, enabled: true, append: () => undefined, onSkip: (r) => skipped.push(r) });
  const big = Buffer.alloc(MCP_IMAGE_MAX_BYTES + 1, 0).toString('base64');
  assert.equal(attach({ server: 's', tool: 't', mimeType: 'image/png', dataBase64: big }), null);
  assert.match(skipped[0] ?? '', /超过/u);
});
