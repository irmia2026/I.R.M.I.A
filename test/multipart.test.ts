/**
 * multipart 编码：频道（guild）发媒体那条路的地基。
 *
 * 只测纯函数——把拼出来的体**再解析回来**，逐字节对上；二进制体最容易"看起来对、
 * 实际错一个字节"（CRLF、边界、结尾 `--`），所以这里连"文件里恰好含有类似边界的字节"也钉住。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMultipartBody } from '../src/channel/multipart.ts';

/** 测试用的小解析器：只认我们拼出来的形状，用来做往返验证 */
function parse(body: Buffer, contentType: string) {
  const boundary = /boundary=(.+)$/u.exec(contentType)?.[1] ?? '';
  assert.ok(boundary !== '', 'content-type 必须带 boundary');
  assert.ok(body.subarray(body.length - 2).toString('binary') === '\r\n', '体必须以 CRLF 收尾');
  const raw = body.toString('binary');
  const pieces = raw.split(`--${boundary}`);
  const parts: Array<{ name: string; filename?: string; data: Buffer }> = [];
  for (const piece of pieces) {
    if (piece === '' || piece === '--\r\n') continue;
    const headEnd = piece.indexOf('\r\n\r\n');
    assert.ok(headEnd > 0, "每段都要有头与体之间的空行");
    const head = piece.slice(0, headEnd);
    const bodyText = piece.slice(headEnd + 4).replace(/\r\n$/u, '');
    const name = /name="([^"]*)"/u.exec(head)?.[1] ?? '';
    const filename = /filename="([^"]*)"/u.exec(head)?.[1];
    parts.push({
      name,
      ...(filename === undefined ? {} : { filename }),
      data: Buffer.from(bodyText, 'binary'),
    });
  }
  return parts;
}

test('文本字段 + 文件字段：往返解析回来逐字节一致', () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0d, 0x0a, 0x1a]);
  const built = buildMultipartBody({
    fields: [{ name: 'content', value: '看这个' }, { name: 'msg_id', value: 'MSG-1' }],
    file: { name: 'file_image', filename: 'a.png', data: bytes, contentType: 'image/png' },
  });
  const parts = parse(built.body, built.contentType);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map((p) => p.name), ['content', 'msg_id', 'file_image']);
  assert.equal(parts[0]?.data.toString('utf8'), '看这个', '中文按 UTF-8 原样');
  assert.equal(parts[2]?.filename, 'a.png');
  assert.deepEqual(parts[2]?.data, bytes, '文件字节必须逐字节一致（含 CR/LF 与控制字符）');
});

test('只用字段（没有文件）也能拼：段数与收尾都对', () => {
  const built = buildMultipartBody({ fields: [{ name: 'content', value: '在频道里说一句' }] });
  const parts = parse(built.body, built.contentType);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]?.data.toString('utf8'), '在频道里说一句');
  assert.ok(built.contentType.startsWith('multipart/form-data; boundary='));
});

test('二进制里恰好含有边界模样时不会切坏（换一个边界）', () => {
  const tricky = Buffer.from('----irmia00112233445566778899aabbccddee', 'utf8');
  const built = buildMultipartBody({
    file: { name: 'file_image', filename: 'x.bin', data: tricky },
  });
  const parts = parse(built.body, built.contentType);
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0]?.data, tricky, '内容原样带出（边界另选，不切坏内容）');
});
