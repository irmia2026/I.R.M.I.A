/**
 * 关系档案的**索引注入**（v78）——`src/persona/relationship.ts` + `src/model/render.ts`。
 *
 * 用户 2026-10-22 的原话（这一版的全部判据）：
 * > 「改为类同记忆索引吧。」（指 `persona/RELATIONSHIPS/*.md` 的注入方式）
 * > 「你这个提示词会导致反复读啊。不要给指令。」（同日追加裁定：索引里只陈述事实）
 *
 * 改前：命中一份档案就把**整篇**印进本轮固定块——而固定块在历史之后、不命中前缀缓存
 * ⇒ 每轮全价。实测阿岚那篇 1,151 字节（≈500 token/轮）、测试群 2,553（≈1,109）。
 * 改后：固定块里只有两行事实——索引（路径 / 字数 / 小节名）+ 一句"如已在上下文中，则不需再读"。
 * **不写 `safe_read`、不写"必须先读/要读"**：读取判据由她自己拿。
 *
 * 这一支钉六件事（前四条是用户点名的验收，第五条是它的前提，第六条是收回的旧边界）：
 *   ① **真链路**：命中档案的那一拍，请求体里有路径与字数，**没有正文的任一整行**；
 *      且该段里 `safe_read` / 祈使词出现 **0 次**（正则断言，逐字节比对）；
 *   ② **不触发就不出现**：没有 `person` 的唤醒（心跳 / 定时器）⇒ 这一段整体不出现；
 *   ③ `sections` 抽取：没有 `##` ⇒ 不出现"小节："；有 4 个 ⇒ 只列前 3 个；
 *   ④ 字数口径是**字符数**，不是字节数（中文一个字三字节，两者差三倍）；
 *   ⑤ 索引里的路径**读得到、改不了**：`safe_read` 能读 `persona/RELATIONSHIPS/*.md`，
 *      通用文件工具写它仍被拒（改写只走 `write_persona`）；
 *   ⑥ **0 字节空档案 ⇒ 整段不出现**（v78 首版丢掉的旧边界，这一笔收回）。
 *
 * ⚠ ③ 的两条边界（`###` 与空标题）也钉在这里：`### ` 是子小节、名字脱离父节读不懂；
 * 渲染层在 `sections` 为空时**整段省掉**"小节：…"——留个空壳会被读成"里面没有小节"。
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { defaultVisibility } from '../src/log/types.ts';
import type { AppEvent } from '../src/log/types.ts';
import { render, SECTION_RULE, TURN_BLOCK_BANNER } from '../src/model/render.ts';
import { charCountOf, relationshipForWake, sectionNamesOf } from '../src/persona/relationship.ts';
import type { RelationshipNote } from '../src/persona/relationship.ts';
import { buildCatalogRegistry } from '../src/tools/catalog.ts';
import { FS_ERROR_CODES } from '../src/tools/fs/index.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { heartbeatData, makeRealWakeRig } from './fixtures/real-wake-rig.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const roots: string[] = [];

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** 临时数据目录，可预置若干份关系档案（`who → 正文`） */
function fixture(relationships: Record<string, string> = {}): string {
  const dir = tempDirSync('irmia-rel-index-');
  roots.push(dir);
  const rel = join(dir, 'persona', 'RELATIONSHIPS');
  mkdirSync(rel, { recursive: true });
  for (const [who, content] of Object.entries(relationships)) {
    writeFileSync(join(rel, `${who}.md`), content, 'utf8');
  }
  return dir;
}

/** 造一个只带 data 的唤醒事件：路由只读 type 与 data 里的那几个字段 */
function wake<T extends AppEvent>(type: T['type'], data: Record<string, unknown>): T {
  return {
    seq: 1,
    ts: '2026-10-22T00:00:00.000Z',
    type,
    data,
    visibility: defaultVisibility(type),
  } as unknown as T;
}

/** 真渲染一次（无人格、无工具、无历史）：只为了拿固定块那一段 */
function turnBlockOf(note: RelationshipNote | null): string {
  const rendered = render({
    events: [],
    persona: { identity: '', constitution: '', style: 'S', state: '' },
    tools: [],
    wakeEvent: null,
    taskCard: null,
    now: '2026-10-22T00:00:00.000Z',
    timezone: 'Asia/Shanghai',
    model: 'fake-heavy',
    lane: 'heavy',
    turnBlock: { state: 'STATE 正文', relationship: note },
  });
  return rendered.input
    .filter((item) => item.type === 'message' && typeof item.content === 'string')
    .map((item) => (item as { content: string }).content)
    .find((text) => text.startsWith(TURN_BLOCK_BANNER)) ?? '';
}

// ──────────────────────────────── ① 真链路：有路径与字数、没有正文 ────────────────────────────────

describe('v78①：命中关系档案的那一拍，请求体里只有索引', () => {
  /** 正文里每一行都**独一无二**：反向断言"没有正文的任一整行"要靠它 */
  const BODY = [
    '# 索引测试人',
    '',
    '## 牵挂',
    '- 他上周把阳台那盆薄荷搬进了屋里（这一行只存在于档案正文）',
    '- 他讨厌别人替他回消息（这一行也只存在于档案正文）',
    '',
    '## 边界·雷区',
    '不要在他开会的时候连着发三条（这一行同样只在正文里）',
    '',
  ].join('\n');

  test('真 RealLoop 的一拍：请求体含 `persona/RELATIONSHIPS/…` 与「N 字」，不含正文任一整行', async () => {
    // 走 `makeRealWakeRig`（真 RealLoop + 真 agent-loop + 真 render，只有模型是假的）：
    // 这条判据问的是"她那一刻真收到的请求里有没有正文"，替身台子答不了。
    const rig = await makeRealWakeRig({ stream: [{ text: '', toolCalls: [] }] });
    try {
      const relDir = join(rig.dir, 'data', 'persona', 'RELATIONSHIPS');
      mkdirSync(relDir, { recursive: true });
      const relPath = join(relDir, '索引测试人.md');
      writeFileSync(relPath, BODY, 'utf8');
      // 期望值**从盘上那份文件算**（不写死字数 / 小节名）：夹具与真档案走同一条解析路径
      const onDisk = readFileSync(relPath, 'utf8');
      const chars = charCountOf(onDisk);
      const sectionNames = sectionNamesOf(onDisk);
      rig.append('wake/manual', { note: '帮我看看日志', person: '索引测试人' });
      await rig.tick();

      const heavy = rig.requests.filter((item) => item.lane === 'heavy');
      assert.equal(heavy.length, 1, `这一拍应当恰好一次 heavy 请求，实际 ${heavy.length} 次`);
      const body = JSON.stringify(heavy[0]!.request);

      // 正向：路径与字数都在（这两个数就是"她能不能去读、值不值得去读"的判据）
      assert.ok(body.includes('persona/RELATIONSHIPS/索引测试人.md'), '索引行必须给正文的路径');
      assert.ok(body.includes(`${chars} 字`), `索引行必须给字数（${chars} 字）`);
      assert.ok(body.includes(`小节：${sectionNames.join(' / ')}`), '索引行要给小节名（前 3 个）');
      assert.ok(
        body.includes('如已在上下文中，则不需再读。'),
        '第二行只注明"如已在上下文中，则不需再读"——陈述事实，不是指令',
      );

      // 反向：正文的**任一整行**都不许进请求体（不是"整篇不在"，是"一行都不许"）
      const lines = BODY.split('\n').filter((line) => line.trim() !== '');
      assert.ok(lines.length >= 4, '夹具里要有足够多的正文行');
      for (const line of lines) {
        assert.equal(body.includes(line), false, `正文整行进请求体了：${line}`);
      }
      // 标签行本身还在（认层靠它，测试与诊断也靠它）
      assert.ok(body.includes('[关系档案 · 索引测试人]'));
      // 固定块里那一段到此为止：索引行 + 契约行，没有第三行正文
      const block = (heavy[0]!.request.input as Array<{ content?: unknown }>)
        .map((item) => (typeof item.content === 'string' ? item.content : ''))
        .find((text) => text.startsWith(TURN_BLOCK_BANNER)) ?? '';
      const start = block.indexOf('[关系档案 · 索引测试人]');
      assert.ok(start >= 0, '固定块里要有关系档案这一段');
      const section = block.slice(start).split(`\n\n${SECTION_RULE}\n\n`)[0]!.trimEnd();
      assert.equal(
        section,
        '[关系档案 · 索引测试人]\n'
        + '- persona/RELATIONSHIPS/索引测试人.md · '
        + `${chars} 字 · 小节：${sectionNames.join(' / ')}\n`
        + '  如已在上下文中，则不需再读。',
        '这一段逐字节就是"标签行 + 索引行 + 事实行"三行，多一行都算把正文带回来了',
      );
      // 这一段的**全部**读取指令判据（用户：「不要给指令」「会导致反复读」）。
      // ⚠ 只能断言这一段，不能断言整份请求：`safe_read` 是工具名，`tools` 清单里必然出现。
      assert.equal(
        (section.match(/safe_read/gu) ?? []).length,
        0,
        `这一段里 safe_read 出现 0 次（现在有）：\n${section}`,
      );
      assert.equal(
        (section.match(/必须先|要读/gu) ?? []).length,
        0,
        `这一段里"必须先 / 要读"出现 0 次（现在有）：\n${section}`,
      );
    } finally {
      rig.dispose();
    }
  });

  test('§② 没有 person 的唤醒（心跳）：同一份档案在位，这一段也整体不出现', async () => {
    // 反向的关键：**档案确实存在**，只是这一拍不带人。若这里写成"没有档案"，这条用例
    // 就变成了"文件不存在当然不注入"——那什么都证明不了。
    const rig = await makeRealWakeRig({ stream: [{ text: '', toolCalls: [] }] });
    try {
      const relDir = join(rig.dir, 'data', 'persona', 'RELATIONSHIPS');
      mkdirSync(relDir, { recursive: true });
      writeFileSync(join(relDir, '索引测试人.md'), BODY, 'utf8');
      rig.append('wake/heartbeat', heartbeatData(1800, 1));
      await rig.tick();

      const heavy = rig.requests.filter((item) => item.lane === 'heavy');
      assert.equal(heavy.length, 1, `心跳拍应当恰好一次 heavy 请求，实际 ${heavy.length} 次`);
      const body = JSON.stringify(heavy[0]!.request);
      assert.equal(body.includes('[关系档案'), false, '不带人的唤醒不许注入关系档案（保持原行为）');
      assert.equal(body.includes('索引测试人'), false, '连文件名都不该出现');
      // 心跳拍照旧有固定块（STATE 那一段）——"这一段不出现"不等于"固定块没了"
      assert.ok(body.includes('[当前状态]'), '固定块本身照旧在');
    } finally {
      rig.dispose();
    }
  });

  test('§⑥ 0 字节空档案：带人的一拍也不出现这一段（与心跳那张同一条断言）', async () => {
    // 边界是**旧行为**：v77 之前渲染层判的是 `content.trim() !== ''`，空档案整段不出现；
    // v78 首版只判 `relationship !== null`，于是空文件也会印出一行"0 字"。这一笔收回。
    const rig = await makeRealWakeRig({ stream: [{ text: '', toolCalls: [] }] });
    try {
      const relDir = join(rig.dir, 'data', 'persona', 'RELATIONSHIPS');
      mkdirSync(relDir, { recursive: true });
      writeFileSync(join(relDir, '空档案人.md'), '', 'utf8');

      // 解析器仍如实报告"这份档案存在、0 字"（命中判据没变：文件在就算命中）；
      // 是**渲染层**把 0 字档案整段省掉——边界落在哪一层，这里钉死。
      const note = relationshipForWake(
        wake('wake/manual', { note: 'x', person: '空档案人' }),
        join(rig.dir, 'data'),
      );
      assert.ok(note !== null, '空文件仍然是"有这个人"（与"没有档案"两件事）');
      assert.equal(note.chars, 0);
      assert.deepEqual(note.sections, []);

      rig.append('wake/manual', { note: '在吗', person: '空档案人' });
      await rig.tick();

      const heavy = rig.requests.filter((item) => item.lane === 'heavy');
      assert.equal(heavy.length, 1, `这一拍应当恰好一次 heavy 请求，实际 ${heavy.length} 次`);
      const body = JSON.stringify(heavy[0]!.request);
      assert.equal(body.includes('[关系档案'), false, '0 字节档案 = 没有正文，整段不出现（旧行为）');
      assert.equal(body.includes('persona/RELATIONSHIPS/空档案人.md'), false, '连索引行都不该出现');
      assert.ok(body.includes('[当前状态]'), '固定块本身照旧在');
    } finally {
      rig.dispose();
    }
  });
});

// ──────────────────────────────── ③ sections 抽取与渲染 ────────────────────────────────

describe('v78③：sections 抽取（前 3 个 `## ` 小节名）', () => {
  test('没有 `##` 的文件 ⇒ sections 为空数组：索引行 + 事实行，两行都不多', () => {
    const body = '# 只有一级标题\n\n正文一行。\n';
    const dir = fixture({ 无小节: body });
    const note = relationshipForWake(wake('wake/manual', { note: 'x', person: '无小节' }), dir);
    assert.ok(note !== null);
    assert.deepEqual(note.sections, []);
    const block = turnBlockOf(note);
    assert.ok(block.includes('[关系档案 · 无小节]'));
    assert.equal(block.includes('小节：'), false, '空 sections 不许留"小节："空壳');
    const start = block.indexOf('[关系档案 · 无小节]');
    assert.equal(
      block.slice(start),
      '[关系档案 · 无小节]\n'
      + `- persona/RELATIONSHIPS/无小节.md · ${charCountOf(body)} 字\n`
      + '  如已在上下文中，则不需再读。',
      `sections 为空时只有"索引行 + 事实行"两行（不许印"小节："空壳）：\n${block}`,
    );
  });

  test('4 个 `##` ⇒ 只列前 3 个（顺序照文件里的先后）', () => {
    const body = '# 标题\n\n## 甲\n一\n\n## 乙\n二\n\n## 丙\n三\n\n## 丁\n四\n';
    const dir = fixture({ 四节: body });
    const note = relationshipForWake(wake('wake/manual', { note: 'x', person: '四节' }), dir);
    assert.ok(note !== null);
    assert.deepEqual(note.sections, ['甲', '乙', '丙']);
    assert.ok(turnBlockOf(note).includes('小节：甲 / 乙 / 丙'), '渲染只列前 3 个');
    assert.equal(turnBlockOf(note).includes('丁'), false, '第 4 个不许出现');
  });

  test('`###` 是子小节，不算进索引；空标题也不算', () => {
    const body = '# 标题\n\n## 真小节\n### 子小节\n### 另一个子小节\n\n##   \n\n## 尾巴\n';
    const dir = fixture({ 子节: body });
    const note = relationshipForWake(wake('wake/manual', { note: 'x', person: '子节' }), dir);
    assert.ok(note !== null);
    assert.deepEqual(note.sections, ['真小节', '尾巴'], '`###` 与空标题都不进索引');
    assert.deepEqual(sectionNamesOf(body), ['真小节', '尾巴']);
  });

  test('`## ` 只认行首：正文中间提到"## "不算小节', () => {
    const body = '# 标题\n\n这一行里提到 ## 不算\n\n## 才算\n';
    const dir = fixture({ 行首: body });
    const note = relationshipForWake(wake('wake/manual', { note: 'x', person: '行首' }), dir);
    assert.ok(note !== null);
    assert.deepEqual(note.sections, ['才算']);
  });
});

// ──────────────────────────────── ④ 解析器只给索引：字数口径是字符 ────────────────────────────────

describe('v78④：解析器返回的是索引（正文一个字都不进这个结构）', () => {
  test('note 只有 who / path / chars / sections 四格，且 chars 是字符数不是字节数', () => {
    const body = '# 某人\n\n## 牵挂\n他喜欢吃面。\n';
    const dir = fixture({ 某人: body });
    const note = relationshipForWake(wake('wake/manual', { note: 'x', person: '某人' }), dir);
    assert.ok(note !== null);
    assert.deepEqual(note, {
      who: '某人',
      path: 'persona/RELATIONSHIPS/某人.md',
      chars: Array.from(body).length,
      sections: ['牵挂'],
    });
    assert.equal('content' in note, false, '正文不许再出现在这个结构里（v78 的全部要点）');
    // 中文一个字三字节：两个数差三倍这件事必须被用例钉住，否则"字数"会被当成"字节数"用
    assert.notEqual(note.chars, Buffer.byteLength(body, 'utf8'), 'chars 是字符数，不是 UTF-8 字节数');
  });

  test('path 的文件名与 loadRelationship 的转义规则同源（含 `/` 的名字也能给出真实路径）', () => {
    const dir = fixture({ a_b: '# 转义\n' });
    const note = relationshipForWake(wake('wake/manual', { note: 'x', person: 'a/b' }), dir);
    assert.ok(note !== null, '`a/b` 存成 `a_b.md` 之后应当命中');
    assert.equal(note.path, 'persona/RELATIONSHIPS/a_b.md');
    assert.equal(readFileSync(join(dir, 'persona', 'RELATIONSHIPS', 'a_b.md'), 'utf8'), '# 转义\n');
  });
});

// ──────────────────────────────── ⑤ safe_read 读得到，写仍然禁 ────────────────────────────────

describe('v78⑤：索引里那条路径读得到、改不了', () => {
  test('safe_read 能读 `persona/RELATIONSHIPS/<名字>.md`；safe_write 仍被拒', async (t) => {
    const dir = tempDirSync('irmia-rel-read-');
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const relDir = join(dir, 'data', 'persona', 'RELATIONSHIPS');
    mkdirSync(relDir, { recursive: true });
    const path = join(relDir, '阿岚.md');
    writeFileSync(path, '# 阿岚\n\n## 牵挂\n- 他还在改代码\n', 'utf8');

    const { registry } = await buildCatalogRegistry({
      dataDir: join(dir, 'data'),
      timers: new TimerStore({ dir: join(dir, 'data'), fire: () => {} }),
      emit: () => {},
      destructiveEnabled: true,
    });
    const ctx = {
      callId: 'call-1', turn: 1, step: 1,
      signal: new AbortController().signal,
      workspaceRoot: dir,
    };

    // 读：索引行里的路径**逐字**交给 safe_read 就能读到（短前缀靠 fs 族的别名表接回 dataDir）
    const read = await registry.get('safe_read')!.handler({ path: 'persona/RELATIONSHIPS/阿岚.md' }, ctx);
    assert.equal(read.isError, undefined, `safe_read 读不到索引给的路径：${read.content}`);
    assert.match(read.content, /他还在改代码/u);

    // 写：通用文件工具仍然拒绝（改写只能走 write_persona——它才记 persona/updated）
    for (const name of ['safe_write', 'safe_edit']) {
      const args = name === 'safe_write'
        ? { path: 'persona/RELATIONSHIPS/阿岚.md', content: '整篇换掉' }
        : { path: 'persona/RELATIONSHIPS/阿岚.md', old: '他还在改代码', new: 'x' };
      const result = await registry.get(name)!.handler(args, ctx);
      assert.equal(result.isError, true, `${name} 必须被拒（persona/ 是只读区）`);
      assert.equal(result.error?.code, FS_ERROR_CODES.PATH_DENIED, `${name} 的错误码`);
      assert.match(result.content, /write_persona/u, `${name} 要指出该走哪条通道`);
    }
    assert.equal(readFileSync(path, 'utf8'), '# 阿岚\n\n## 牵挂\n- 他还在改代码\n',
      '被拒的写入一个字都不许落盘——索引说的"读得到"必须同时是"改不了"');
  });
});
