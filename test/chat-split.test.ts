import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MAX_SEGMENTS, DEFAULT_MIN_SEGMENT_LENGTH, charCount, splitForChat,
} from '../src/tools/chat-split.ts';

test('空文本不投递，默认最多五段', () => {
  assert.equal(DEFAULT_MAX_SEGMENTS, 5);
  assert.equal(DEFAULT_MIN_SEGMENT_LENGTH, 10);
  for (const text of ['', ' ', '\r\n\t']) assert.deepEqual(splitForChat(text), []);
});

test('短话不因逗号碎成多条，标点保留', () => {
  for (const text of ['好，不说了。', '嗨。找我什么事，说吧。', '跑完了，42 个文件', '唉，收到啦？！']) {
    assert.deepEqual(splitForChat(text), [text]);
  }
});

test('自然句末优先，保留句号与每句原文', () => {
  const sentences = ['第一句内容已经足够完整。', '第二句内容也已经足够完整。', '第三句内容还是完整的一句。'];
  assert.deepEqual(splitForChat(sentences.join('')), sentences);
});

test('长逗号句均衡拆分，不见逗号就拆', () => {
  const text = '第一句摆在这里，第二句放在那边，第三句换个地方说，第四句再说一句吧';
  const pieces = splitForChat(text);
  assert.deepEqual(pieces, ['第一句摆在这里，第二句放在那边，', '第三句换个地方说，第四句再说一句吧']);
  assert.equal(pieces.join(''), text);
});

test('默认最多五段，超出的尾部合并且不丢字', () => {
  const text = Array.from({ length: 12 }, (_, i) => `第${i}句的内容已经足够长了。`).join('');
  const pieces = splitForChat(text);
  assert.ok(pieces.length <= 5);
  assert.ok(pieces.length > 1);
  assert.equal(pieces.join(''), text);
});

test('短尾段合并回前一条', () => {
  const text = '第一句内容已经足够完整。第二句内容也已经足够完整。嗯。';
  assert.deepEqual(splitForChat(text), ['第一句内容已经足够完整。', '第二句内容也已经足够完整。嗯。']);
});

test('换行与 CRLF 保留，换行内的空白也不改写', () => {
  for (const newline of ['\n', '\r\n']) {
    const text = `第一行内容已经足够完整。${newline}${newline}第二行内容也已经足够完整。${newline}`;
    assert.equal(splitForChat(text).join(''), text);
  }
});

for (const [open, close] of [['（', '）'], ['(', ')'], ['「', '」'], ['【', '】'], ['《', '》'], ['“', '”'], ['{', '}'], ['[', ']']]) {
  test(`成对符号 ${open}${close} 内部的句末和换行都不切`, () => {
    const block = `${open}这里有一句完整的话。\n还有另一句完整的话，不能切开。${close}`;
    const text = `开场一句内容已经完整。${block}结束这一句也已经足够完整。`;
    const pieces = splitForChat(text);
    assert.equal(pieces.join(''), text);
    assert.ok(pieces.some((piece) => piece.includes(block)), pieces.join('|'));
  });
}

test('嵌套符号与未闭合符号内不拆', () => {
  const block = '（外层完整，里面有「第一句。第二句。」还没结束）';
  assert.ok(splitForChat(block).some((piece) => piece.includes(block)));
  const open = '（没有闭合的段落，第一句话很完整。第二句话也很完整。';
  assert.deepEqual(splitForChat(open), [open]);
});

for (const marker of ['```', '~~~']) {
  test(`${marker} 围栏代码保留整块`, () => {
    const block = `${marker}ts\nconst text = "不要切。逗号也保留，";\nconsole.log(text);\n${marker}`;
    const text = `前面的说明已经足够完整。\n${block}\n后面的说明也已经足够完整。`;
    const pieces = splitForChat(text);
    assert.equal(pieces.join(''), text);
    assert.ok(pieces.some((piece) => piece.includes(block)));
  });
}

test('行内代码与未闭合围栏不切', () => {
  const inline = '`foo.bar("标点。也不能切，");`';
  const text = `执行的是${inline}，这句说明已经足够完整。`;
  assert.ok(splitForChat(text).some((piece) => piece.includes(inline)));
  const open = '```ts\n第一句话。第二句话，第三句话。';
  assert.deepEqual(splitForChat(open), [open]);
});

test('思维块可在行中出现，完整保留内部换行', () => {
  const block = '<think>第一步考虑问题。\n第二步，还是不能切。第三步也完整。</think>';
  const text = `说明文字${block}真正需要送出去的说明已经足够完整。`;
  assert.equal(splitForChat(text).join(''), text);
  assert.ok(splitForChat(text).some((piece) => piece.includes(block)));
});

for (const table of [
  '| 列一 | 列二 |\n| --- | :---: |\n| 内容。完整， | 内容二。 |',
  '列一 | 列二\n--- | ---:\n内容。完整， | 内容二。',
]) {
  test(`Markdown 表格不拆：${table.split('\n')[0]}`, () => {
    const text = `前面的介绍已经足够完整。\n${table}\n后面的说明也已经足够完整。`;
    const pieces = splitForChat(text);
    assert.equal(pieces.join(''), text);
    assert.ok(pieces.some((piece) => piece.includes(table)), pieces.join('|'));
  });
}

test('英文文件名、版本号、URL、数字与缩写不在词内切开', () => {
  const text = "修改 server.ts，版本 v1.2.3，链接 https://example.com/a?x=1，数字 1,000。Don't split identifiers.";
  const pieces = splitForChat(text);
  assert.equal(pieces.join(''), text);
  for (const word of ['server.ts', 'v1.2.3', 'https://example.com/a?x=1', '1,000', "Don't"]) {
    assert.ok(pieces.some((piece) => piece.includes(word)), word);
  }
});

test('emoji 与破折号原样保留，输出确定', () => {
  const text = '第一句话带着 emoji 😀😀😀。第二句话——破折号不会被随机改写。第三句话也足够完整。';
  const pieces = splitForChat(text);
  assert.equal(pieces.join(''), text);
  assert.equal(charCount('😀甲'), 2);
  assert.deepEqual(splitForChat(text), pieces);
  assert.ok(pieces.every((piece) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(piece)));
});

test('显式段数配置与不限段数', () => {
  const text = Array.from({ length: 8 }, (_, i) => `第${i}句已经足够完整了。`).join('');
  assert.equal(splitForChat(text, { maxSegments: 2 }).length, 2);
  assert.equal(splitForChat(text, { maxSegments: 0, minSegmentLength: 0 }).length, 8);
});
