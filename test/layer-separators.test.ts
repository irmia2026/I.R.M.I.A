/**
 * 层分割线（v56）—— `src/model/render.ts` 的 `layerRule` / `SECTION_RULE` / `INSTRUCTION_RULES` / `LAYER_RULES`。
 *
 * 用户 2026-10-12 的原话（这一版的全部判据）：
 * > 「提示词里**每一层都要有明确的分割线**。比如 **persona 和装置自述**就要有分割线；
 * >  **state 和上下两块**也要有分割线，不然容易看串。」
 *
 * 这一支按四个方向钉它（正反两面都有）：
 *   ① **每处边界必须出现对应标签、且只出现一次**（层名只挂一条线，不两套并存）；
 *   ② **前缀必须稳定**：同一份输入渲染两次，`instructions` 与每一条层 item 逐字节相同；
 *   ③ **旧文本不许残留**：旧的破折号段头（`以下为框架提供的…`）一个字节都不在；
 *   ④ **不触发时不出现**：层为空时它那条线也不出现（不留悬空横线）。
 *
 * ⚠ 归属：**分割线与层标签**在这一支；各层的**内容语义**在 `render.test.ts` / `m5-acceptance.test.ts`
 * 那些既有用例里（这一版没动语义，所以那边只改了"认层"的判据）。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  INSTRUCTION_RULES, LAYER_RULES, NOW_LAYER_BANNER, RENDER_VERSION, SECTION_RULE,
  TURN_BLOCK_BANNER, render, type RenderInput, type RenderPersona,
} from '../src/model/render.ts';

const PERSONA: RenderPersona = {
  identity: 'IDENTITY 正文',
  constitution: 'CONSTITUTION 正文',
  style: 'STYLE 正文',
  state: 'STATE 正文',
};
const NOW = '2026-10-12T06:00:00.000Z';

function input(extra: Partial<RenderInput> = {}): RenderInput {
  return {
    events: [],
    persona: PERSONA,
    tools: [],
    wakeEvent: null,
    taskCard: null,
    now: NOW,
    timezone: 'Asia/Shanghai',
    model: 'fake',
    lane: 'heavy',
    // 三节都给：状态 / 关系档案 / 记忆索引（这样块内才有两条节间横线）
    // v78：关系档案只有索引（路径 / 字数 / 小节名）+ 一句"如已在上下文中，则不需再读"（陈述，不是指令）
    turnBlock: {
      state: 'STATE 正文',
      relationship: { who: 'YG', path: 'persona/RELATIONSHIPS/YG.md', chars: 4, sections: ['档案'] },
    },
    memoryIndex: '[记忆索引] 一行指针',
    skillCatalog: '[可用技能]\n- 一件',
    ...extra,
  };
}

/** 请求里每一条 message item 的正文（非 message 的给空串占位） */
function textsOf(r: ReturnType<typeof render>): string[] {
  return r.input.map(item => (item.type === 'message' && typeof item.content === 'string' ? item.content : ''));
}

/** 一条正文里某个标记出现几次 */
const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

describe('层分割线（v56）· instructions 四层', () => {
  test('四个块各顶一条带标签的分割线，各只出现一次，且顺序固定', () => {
    const ins = render(input()).instructions;
    for (const [name, rule] of Object.entries(INSTRUCTION_RULES)) {
      assert.equal(countOf(ins, rule), 1, `「${name}」那条线必须出现且只出现一次：\n${rule}`);
      assert.ok(ins.includes(`${rule}\n\n`), `线后面必须紧接它那一块的正文：${rule}`);
    }
    const order = [INSTRUCTION_RULES.identity, INSTRUCTION_RULES.constitution,
      INSTRUCTION_RULES.style, INSTRUCTION_RULES.brief].map(rule => ins.indexOf(rule));
    assert.deepEqual([...order].sort((a, b) => a - b), order, '四条线的先后顺序是身份 → 宪法 → 风格 → 装置自述');
    // 线必须比它那一块的正文靠前（不是挂在块尾）
    for (const [rule, body] of [
      [INSTRUCTION_RULES.identity, PERSONA.identity],
      [INSTRUCTION_RULES.constitution, PERSONA.constitution],
      [INSTRUCTION_RULES.style, PERSONA.style],
    ] as Array<[string, string]>) {
      assert.ok(ins.indexOf(rule) < ins.indexOf(body), `线在正文之前：${rule}`);
    }
  });

  test('人格块为空时：那条线跟着一起不出现（不留悬空横线）', () => {
    const ins = render(input({ persona: { ...PERSONA, constitution: '', style: '   ' } })).instructions;
    assert.equal(countOf(ins, INSTRUCTION_RULES.constitution), 0);
    assert.equal(countOf(ins, INSTRUCTION_RULES.style), 0);
    assert.equal(countOf(ins, INSTRUCTION_RULES.identity), 1);
    assert.equal(countOf(ins, INSTRUCTION_RULES.brief), 1);
    // v65：装置自述里有两处四连换行（用户那两行结束标记的前后）⇒ 改成**点名**锁：
    // 除那两处之外，三连以上换行一处都不许有（空块**不许新增**空行）——不是放宽。
    assert.equal((ins.match(/\n{3,}/gu) ?? []).length, 2,
      'v65：三连以上空行只许是用户版式那两处（两个结束标记前后）');
  });

  test('人格全空时：装置自述那条线仍在（它是程序给的，不随人格空掉）', () => {
    const ins = render(input({ persona: { identity: '', constitution: '', style: '', state: '' } })).instructions;
    assert.equal(countOf(ins, INSTRUCTION_RULES.brief), 1);
    assert.equal(ins.split('\n')[0], INSTRUCTION_RULES.brief, '它就是第一条');
  });
});

describe('层分割线（v56）· 尾部各层', () => {
  test('长期记忆 / 本轮固定块 / 此刻：三条线各出现一次，且各自是那一层的开头', () => {
    const r = render(input());
    const texts = textsOf(r);
    const all = texts.join('\n\n');
    for (const [name, rule] of Object.entries(LAYER_RULES)) {
      assert.equal(countOf(all, rule), 1, `「${name}」那条线必须出现且只出现一次：${rule}`);
    }
    const memory = texts.find(t => t.startsWith(LAYER_RULES.memory));
    assert.ok(memory !== undefined, '长期记忆层以它那条线开头');
    assert.ok(memory!.includes('[可用技能]'), '线后面就是层内容');
    const block = texts.find(t => t.startsWith(TURN_BLOCK_BANNER));
    assert.ok(block !== undefined, '固定块以段头开头');
    assert.equal(block!.split('\n')[0], LAYER_RULES.turnBlock, '段头第一行就是那条线');
    const now = texts.find(t => t.startsWith(NOW_LAYER_BANNER));
    assert.ok(now !== undefined, '此刻层以段头开头');
    assert.equal(now!.split('\n')[0], LAYER_RULES.now, '段头第一行就是那条线');
    // 线只在层首：层名不会在别处再出现一次（那才是"两套并存"）
    assert.equal(countOf(block!, LAYER_RULES.turnBlock), 1);
    assert.equal(countOf(now!, LAYER_RULES.now), 1);
  });

  test('固定块：节与节之间是 SECTION_RULE；段头与第一节之间不重复铺线', () => {
    const block = textsOf(render(input())).find(t => t.startsWith(TURN_BLOCK_BANNER))!;
    // 三节 ⇒ 两条节间线
    assert.equal(countOf(block, SECTION_RULE), 2, `三节之间恰好两条：\n${block}`);
    const bannerEnd = block.indexOf('\n\n');
    const afterBanner = block.slice(bannerEnd + 2);
    assert.equal(
      afterBanner.startsWith(SECTION_RULE), false,
      '段头那条线之后**直接**是第一节（否则同一处会叠两根线）',
    );
    // 顺序：当前状态 → 关系档案 → 记忆索引（线不改变既有顺序）
    const iState = block.indexOf('[当前状态]');
    const iRel = block.indexOf('[关系档案 · YG]');
    const iIdx = block.indexOf('[记忆索引] 一行指针');
    assert.ok(iState < iRel && iRel < iIdx, '节顺序不变');
    assert.equal(countOf(block, SECTION_RULE), 2, '节间线数量与"节数 − 1"一致');
  });

  test('只有两节时只有一条节间线（线跟着节数走，不是写死的）', () => {
    const block = textsOf(render(input({ memoryIndex: null })))
      .find(t => t.startsWith(TURN_BLOCK_BANNER))!;
    assert.equal(countOf(block, SECTION_RULE), 1);
  });
});

describe('层分割线（v56）· 旧文本与稳定性', () => {
  test('旧的破折号段头一个字节都不残留（防两套并存）', () => {
    const r = render(input());
    const dump = JSON.stringify(r) + r.instructions;
    assert.equal(dump.includes('以下为框架提供的'), false, '旧段头那句话不许还在');
    assert.equal(dump.includes('——以下'), false, '旧的破折号画法不许还在');
    // 注意口径：`—`（em dash）在正文里是**标点**（人格与装置自述的破折号），不许禁；
    // 要禁的是"整行由破折号画出来的分割线"——那种行一个字都没有。
    assert.equal(/^—{5,}$/mu.test(r.instructions), false, 'instructions 里不许再有破折号画的分割线行');
  });

  test('前缀稳定：同一份输入渲染两次，instructions 与每一条层 item 逐字节相同', () => {
    const a = render(input());
    const b = render(input());
    assert.equal(a.instructions, b.instructions, 'instructions 是冻结前缀，两次必须同字节');
    assert.deepEqual(textsOf(a), textsOf(b), '每一条 item 也逐字节相同');
    assert.equal(JSON.stringify(a.input), JSON.stringify(b.input));
  });

  test('不触发时不出现：记忆层为空时它那条线也不出现（不留悬空横线）', () => {
    const r = render(input({ skillCatalog: null, mcpIndex: null }));
    const all = textsOf(r).join('\n\n');
    assert.equal(countOf(all, LAYER_RULES.memory), 0, '层为空 ⇒ 线不出现');
    assert.equal(all.includes('[早期历史摘要'), false, '也没有摘要那一节');
    // 空态下此刻层照旧有它自己那条线（这一层永远在）
    assert.equal(countOf(all, LAYER_RULES.now), 1);
  });

  test('此刻层两行段头：第一行是统一分割线，第二行那句说明原话未动', () => {
    const now = textsOf(render(input())).find(t => t.startsWith(NOW_LAYER_BANNER))!;
    const lines = now.split('\n');
    assert.equal(lines[0], LAYER_RULES.now);
    assert.equal(lines[0]!.length, 28, '12 + 【此刻】(4) + 12');
    assert.equal(lines[1], '（身为本机Agent应当自己领会，但并不与用户、话题、任务直接相关，非必要时也不需要特别与用户提及的信息）');
    assert.ok(RENDER_VERSION >= '56', `这一版的分割线随 v56 起：${RENDER_VERSION}`);
  });
});
