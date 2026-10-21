/**
 * 人格资产字节形状测试 — src/persona/loader.ts 的 normalizePersonaAsset
 *
 * 要守住的那句话：**内容相同 ⇒ 请求字节相同**。
 *
 * 为什么它不是洁癖：`instructions`（人格三层 + 装置自述）是所有请求的最大公共前缀，
 * 它的字节一变，整个请求从头失配。而"内容没变、字节变了"是最冤的一种失配——
 * 实测数据目录里 IDENTITY/CONSTITUTION/STYLE 是 CRLF（人用编辑器写的），
 * STATE/RELATIONSHIPS 是 LF（agent 通过 write_persona 写的）。同一个人机交替编辑的文件，
 * 就算把内容改回原样，字节也是另一种，于是**必然再吃一次全 miss**。
 *
 * 规范化只动形状：BOM、行尾、多余尾部空行。内容一个字都不动。
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { loadPersona, normalizePersonaAsset, writePersonaAsset } from '../src/persona/loader.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const roots: string[] = [];

function scratch(): string {
  const dir = tempDirSync('irmia-bytes-');
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe('字节规范化 · 只动形状', () => {
  test('行尾统一为 LF（CRLF 与 CR 都算）', () => {
    assert.equal(normalizePersonaAsset('a\r\nb\r\nc'), 'a\nb\nc');
    assert.equal(normalizePersonaAsset('a\rb'), 'a\nb');
    assert.equal(normalizePersonaAsset('a\nb'), 'a\nb');
  });

  test('去掉 BOM', () => {
    assert.equal(normalizePersonaAsset('\uFEFF# 标题'), '# 标题');
  });

  test('压掉多余的尾部空行，但不新增换行', () => {
    assert.equal(normalizePersonaAsset('正文\n\n\n'), '正文\n');
    assert.equal(normalizePersonaAsset('正文\n'), '正文\n');
    assert.equal(normalizePersonaAsset('正文'), '正文', '没写结尾换行就不给它补');
  });

  test('正文一个字都不动（行内空白、缩进、空行都保留）', () => {
    const text = '# 标题\n\n  - 缩进项\n\n第二段，中间空行留着\n';
    assert.equal(normalizePersonaAsset(text), text);
  });

  test('幂等：规范化过的再规范化不变', () => {
    const twice = normalizePersonaAsset(normalizePersonaAsset('a\r\n\r\n\r\n'));
    assert.equal(twice, normalizePersonaAsset('a\r\n\r\n\r\n'));
  });

  test('空串与纯空白不炸', () => {
    assert.equal(normalizePersonaAsset(''), '');
    assert.equal(normalizePersonaAsset('\r\n'), '\n');
  });
});

describe('读入侧 · 同一内容必须给出同一份 assets', () => {
  test('人写（CRLF）与 agent 写（LF）的同一内容 → identity 与 personaHash 都相同', () => {
    const body = '# 我是谁\n\n我不装懂。\n';

    const human = scratch();
    mkdirSync(join(human, 'persona'), { recursive: true });
    writeFileSync(join(human, 'persona', 'IDENTITY.md'), body.replace(/\n/gu, '\r\n'), 'utf8');

    const agent = scratch();
    mkdirSync(join(agent, 'persona'), { recursive: true });
    writeFileSync(join(agent, 'persona', 'IDENTITY.md'), body, 'utf8');

    const a = loadPersona(human);
    const b = loadPersona(agent);
    assert.equal(a.identity, b.identity, 'identity 字节必须一致（它是 instructions 的开头）');
    assert.equal(a.personaHash, b.personaHash, 'hash 也必须一致——否则 change/未 change 判不出来');
  });

  test('带 BOM 与多余尾部空行的文件同样归一', () => {
    const clean = scratch();
    mkdirSync(join(clean, 'persona'), { recursive: true });
    writeFileSync(join(clean, 'persona', 'CONSTITUTION.md'), '# 宪法\n', 'utf8');

    const messy = scratch();
    mkdirSync(join(messy, 'persona'), { recursive: true });
    writeFileSync(join(messy, 'persona', 'CONSTITUTION.md'), '\uFEFF# 宪法\r\n\r\n\r\n', 'utf8');

    assert.equal(loadPersona(messy).constitution, loadPersona(clean).constitution);
  });

  test('文件缺失仍是空串（不因为规范化多出内容）', () => {
    const dir = scratch();
    assert.equal(loadPersona(dir).identity, '');
    assert.equal(loadPersona(dir).state, '');
  });
});

describe('写入侧 · 落盘的就该是规范形状', () => {
  test('writePersonaAsset 把 CRLF 内容写成 LF', async () => {
    const dir = scratch();
    await writePersonaAsset(dir, 'STATE.md', '第一行\r\n第二行\r\n');
    assert.equal(readFileSync(join(dir, 'persona', 'STATE.md'), 'utf8'), '第一行\n第二行\n');
  });

  test('返回的字节数是规范化后的（调用方用它记 persona/updated）', async () => {
    const dir = scratch();
    const bytes = await writePersonaAsset(dir, 'STATE.md', '甲\r\n乙\r\n');
    assert.equal(bytes, Buffer.byteLength('甲\n乙\n', 'utf8'));
  });

  test('写入 → 读入是幂等的：再写一次同样内容不产生新字节', async () => {
    const dir = scratch();
    await writePersonaAsset(dir, 'STATE.md', '甲\r\n乙\r\n');
    const first = loadPersona(dir).state;
    await writePersonaAsset(dir, 'STATE.md', first);
    assert.equal(loadPersona(dir).state, first);
  });
});
