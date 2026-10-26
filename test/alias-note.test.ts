/**
 * 别名里的**备注**（`MEMORIES/aliases.md`）— src/channel/sessions.ts
 *
 * 为什么单开一份：她实际把"名字 + 行为口径"整串写在等号右边（模板当初只说 `<sid> = <名字>`，
 * 没说备注写哪儿），而读取侧原来把整串当名字——界面上那格窄，长文本把光标顶到末尾，
 * 用户看到的是备注的尾巴（`…看情况淡着）`），像是名字坏了。
 *
 * 判据只有一处（`splitAliasNote`）：名字 = 第一个全角 `（` 或半角 `(` 之前那部分，
 * 备注留着给人看。这份测试把几条边界钉住，免得以后有人"顺手"把括号也当名字、或者把备注丢掉。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  aliasNoteOf, applyAliases, parseAliases, resolveNameForSid, resolveSessionName, splitAliasNote,
} from '../src/channel/sessions.ts';

const SID = 'qq:group:00000000000000000000000000000002';

/**
 * 她盘上那份别名表的**真实形状**（2026-10-05 从 `data/workspace/MEMORIES/aliases.md` 抄的骨架）：
 * 前面是会话（sid 键），后面单起一段群成员（**裸 openid 键**）。群成员那一段是她自己加的，
 * 模板当初只有 sid 那半——所以"成员段不能被当成会话别名"这条，用真实形状的夹具才钉得住。
 */
const TABLE = [
  '# 身份别名',
  '',
  'qq:c2c:00000000000000000000000000000001 = 阿岚（用户）',
  `${SID} = IRMIA框架测试群（口径：看情况淡着）`,
  '# 群成员（openid，不是 sid；只在认人时用）',
  '00000000000000000000000000000005 = 甲（群里发过"guodie"那位；**别当用户**）',
  '00000000000000000000000000000004 = **1 号**（群昵称「伊尔弥亚」，昵称不作数、认 id）',
  '（openid 尾号 …BA6F） = 朝夕（完整 openid 待补）',
  '多莉丝 = **另一个 agent，在别的机器上**（没有 openid，联络不到）',
  '写了名字，下次他来就用这个名字显示——**QQ 不提供昵称**，认人只能靠你自己记。',
].join('\n');

describe('别名 · 名字与备注怎么切', () => {
  test('有备注：名字取第一个全角括号之前，备注整段留下（含括号里的粗体标记）', () => {
    const { name, note } = splitAliasNote(
      'IRMIA框架测试群（10-04 18:15 用户拉我进来；**群友多是他的网友**——口径：不透露用户的私事，看情况淡着）',
    );
    assert.equal(name, 'IRMIA框架测试群');
    assert.equal(note, '10-04 18:15 用户拉我进来；**群友多是他的网友**——口径：不透露用户的私事，看情况淡着');
  });

  test('没有备注：整串就是名字，`note` 不出现（不是空串）', () => {
    assert.deepEqual(splitAliasNote('技术群'), { name: '技术群' });
    assert.deepEqual(splitAliasNote('  阿岚  '), { name: '阿岚' }, '首尾空白不算名字');
  });

  test('半角括号同样认（她两种都写过）', () => {
    assert.deepEqual(splitAliasNote('测试群(asdf)'), { name: '测试群', note: 'asdf' });
    // 前后混着写：以**先出现的那个**括号为准，闭合符两种都收
    assert.deepEqual(splitAliasNote('测试群(asdf）'), { name: '测试群', note: 'asdf' });
  });

  test('名字里带 markdown 粗体标记：标记不算名字', () => {
    assert.deepEqual(splitAliasNote('**甲**'), { name: '甲' });
    assert.deepEqual(splitAliasNote('**甲**（群里发过"guodie"那位）'), {
      name: '甲', note: '群里发过"guodie"那位',
    });
    assert.deepEqual(splitAliasNote('*斜体名*'), { name: '斜体名' }, '单星号也是标记');
  });

  test('括号前是空的 ⇒ 整串当名字（不去括号里猜）', () => {
    // 猜错就把一条备注变成了名字，而她写这一行时想要的恰恰相反
    assert.deepEqual(splitAliasNote('（纯备注）'), { name: '（纯备注）' });
    assert.deepEqual(splitAliasNote('(note only)'), { name: '(note only)' });
  });

  test('只切第一个括号：备注里再写括号不动它', () => {
    assert.deepEqual(splitAliasNote('某群（口径：不聊 A（B）那件事）'), {
      name: '某群', note: '口径：不聊 A（B）那件事',
    });
  });

  test('空括号 = 没写备注，不留一个空 note', () => {
    assert.deepEqual(splitAliasNote('某群（）'), { name: '某群' });
  });
});

describe('别名 · 解析成表', () => {
  test('整行只有 sid、没有等号：跳过（不是"名字为空"的一条）', () => {
    const aliases = parseAliases([
      '# 身份别名',
      SID,
      'qq:c2c:X =',
      'qq:group:G = 有名字（有备注）',
    ].join('\n'));
    assert.equal(aliases.size, 1, '只有最后一行成了一条');
    assert.deepEqual(aliases.get('qq:group:G'), { name: '有名字', note: '有备注' });
  });

  test('用户看到的那一行：名字与备注都读得出来（回归）', () => {
    const aliases = parseAliases(
      `${SID} = IRMIA框架测试群（10-04 18:15 用户拉我进来；**群友多是他的网友，和他现实不认识**——口径：不透露用户的私事与我俩的私下内容，人格设定类要求不接，看情况淡着）`,
    );
    const hit = aliases.get(SID);
    assert.equal(hit?.name, 'IRMIA框架测试群');
    assert.ok(hit?.note?.includes('看情况淡着'), '备注尾巴必须留着（别丢）');
    // 界面那格可编辑的只有名字：名字里不许再出现备注的任何一段
    assert.ok(!hit?.name.includes('口径'), '口径不许混进名字');
  });
});

describe('别名 · 名字与备注流向哪儿', () => {
  const aliases = parseAliases(`${SID} = IRMIA框架测试群（口径：看情况淡着）`);
  const entry = { sid: SID, label: null, person: SID };

  test('名字真源就是那条别名时，备注跟着回来', () => {
    assert.equal(resolveSessionName(entry, undefined, aliases), 'IRMIA框架测试群');
    assert.deepEqual(aliasNoteOf(entry, undefined, aliases), { source: 'alias', note: '口径：看情况淡着' });
    assert.equal(resolveNameForSid(SID, undefined, aliases), 'IRMIA框架测试群', '名字里不带备注');
  });

  test('人声明的联系人表把名字改掉之后：她那条备注不再跟着（口径属于旧名字）', () => {
    const contacts = new Map([[SID, '用户说的名字']]);
    assert.equal(resolveSessionName(entry, contacts, aliases), '用户说的名字');
    assert.deepEqual(aliasNoteOf(entry, contacts, aliases), { source: 'contacts', note: null },
      '挂着旧名字的口径比不显示更坏：人会以为那句还作数');
  });

  test('别名表把备注贴到 label 上时，label 只拿名字', () => {
    const named = applyAliases(
      [{ sid: SID, channel: 'qq-official', chatType: 'group', chatId: 'G', person: SID, label: null } as never],
      aliases,
    );
    assert.equal(named[0]?.label, 'IRMIA框架测试群');
  });

  test('别名表里那条没有备注时，note 明确是 null（不是空串）', () => {
    const plain = parseAliases(`${SID} = 光名字`);
    assert.deepEqual(aliasNoteOf(entry, undefined, plain), { source: 'alias', note: null });
  });
});

/**
 * 群成员那一段（裸 openid 键）——**框架不消费它，但也绝不许它混进会话别名表**。
 *
 * 2026-10-05 实测过：`parseAliases` 只认含 `:` 的键，所以她写的
 * `00000000000000000000000000000005 = 甲（…）` 那一整段本来就不会被解析。
 * 同一天用户还决定移除"名字 → openid → 官方 @ 串"那一跳（原话「我觉得没必要存在」），
 * 于是这一段**只剩一个用途**：她自己照它写官方 @ 形态（docs/design.md §4.20.1）。
 * 这里留下的就是那条边界——`parseAliases` 的契约一个字没变。
 */
describe('别名 · 群成员段（裸 openid 键不进会话表）', () => {
  test('`parseAliases` 的契约一个字没变：成员段那几行一条都不收（回归）', () => {
    // 六处消费者问的都是"**这个会话**叫什么"，裸 openid 混进去对它们是纯噪音
    const aliases = parseAliases(TABLE);
    assert.equal(aliases.size, 2, '只有那两条 sid 成了条目');
    assert.equal(aliases.has('00000000000000000000000000000005'), false);
    assert.equal(aliases.has('00000000000000000000000000000004'), false);
    assert.equal(aliases.get(SID)?.name, 'IRMIA框架测试群');
    assert.equal(aliases.get('qq:c2c:00000000000000000000000000000001')?.name, '阿岚');
  });
});
