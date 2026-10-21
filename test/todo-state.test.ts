/**
 * `persona/todo-state.ts`——待办清单的唯一载体（`STATE.md` 的两节）。
 *
 * 这一套用例盯的是**合并方案把那两笔账算对**（docs/context-regression-check.md §4）：
 *   ① 写清单**只动那两节的正文**，STATE 其余字节一个不改（她手写的心情、别的节、说明行）；
 *   ② 读清单**宽容**（她手写的 `-` / `1.` / 无状态记号都认），但**不把日记当待办**
 *      （长段落、`✅ …`、`**[10-03 …` 那种叙述一律不进任务卡）；
 *   ③ 定位不到就**明确报错**，不静默整体重写；
 *   ④ 内容没变 = 不写（幂等：重复写不该让下一轮的固定块白失守一次）。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  TODO_SECTIONS,
  extractTodoItems,
  openTodoItems,
  parseTodoLine,
  planTodoWrite,
  renderTodoLine,
  splitAcrossSections,
  type TodoItem,
} from '../src/persona/todo-state.ts';

/** 一份"她自己的" STATE：有心情、有别的节、有说明行——用来证明"只有那两节的正文会变" */
const STATE_FIXTURE = [
  '# 当前状态',
  '',
  '心情：松的。这一行是她写的。',
  '',
  '## 当前任务',
  '',
  '- [~] 核对备份目录',
  '',
  '## 接着干',
  '',
  '- [ ] 看日志尾部',
  '- [x] 写结论',
  '',
  '## 群的边界（10-02 夜·用户定）',
  '- 测试群聊1 = 真·私有场子。',
  '',
  '## 工具常识（已验）',
  '- 一条早就会了的常识。',
  '',
].join('\n');

const ITEMS: TodoItem[] = [
  { content: '核对备份目录', status: 'in_progress' },
  { content: '看日志尾部', status: 'pending' },
];

describe('todo-state · 读（宽容但不当日记）', () => {
  test('两节都读得到，状态记号认全；标题带后缀也认', () => {
    const text = [
      '# 当前状态',
      '',
      '## 当前任务：无（收尾）',
      '- [~] 正在做的那件',
      '',
      '## 接着干',
      '1. 第一件',
      '2. [x] 第二件（已经做完）',
      '* 第三件（无记号 → 未完成）',
      '  - 缩进两格的也算',
      '',
    ].join('\n');
    const result = extractTodoItems(text);
    assert.deepEqual(result.missingSections, []);
    assert.deepEqual(result.items, [
      { content: '正在做的那件', status: 'in_progress' },
      { content: '第一件', status: 'pending' },
      { content: '第二件（已经做完）', status: 'completed' },
      { content: '第三件（无记号 → 未完成）', status: 'pending' },
      { content: '缩进两格的也算', status: 'pending' },
    ]);
    // 未完成项才进任务卡：`[x]` 不算
    assert.deepEqual(openTodoItems(text), [
      '正在做的那件', '第一件', '第三件（无记号 → 未完成）', '缩进两格的也算',
    ]);
  });

  test('她的日记不进清单：长段落、✅ 开头、**[ 开头、非条目行一律不认', () => {
    const text = [
      '# 当前状态',
      '',
      '## 当前任务',
      '',
      '- ✅ [10-03 19:12 交办 → 19:2x 办结] **coder 的内测包通知已转给用户单聊**。',
      '- 备注：以后 coder 若真递**文件**，走 `send_media`。',
      '',
      '## 接着干',
      '',
      '0. **[10-03 02:48 用户叫停 → 04:42 前提已解] 两个新 skill 的改造**——一堆叙述。',
      `- ${'很长的一条'.repeat(120)}`,
      '- [ ] 真正该做的一件',
      '这一行是说明文字，不是条目。',
      '',
    ].join('\n');
    assert.deepEqual(extractTodoItems(text).items, [
      { content: '真正该做的一件', status: 'pending' },
    ]);
  });

  test('缺节如实报出来（读这一侧不算错，写那一侧会拒）', () => {
    const text = '# 当前状态\n\n## 当前任务\n\n- [ ] 只有这一节\n';
    const result = extractTodoItems(text);
    assert.deepEqual(result.missingSections, ['接着干']);
    assert.deepEqual(result.items, [{ content: '只有这一节', status: 'pending' }]);
  });

  test('一行 → 条目：认的与不认的形状', () => {
    assert.deepEqual(parseTodoLine('- [ ] a'), { content: 'a', status: 'pending' });
    assert.deepEqual(parseTodoLine('- [~] a'), { content: 'a', status: 'in_progress' });
    assert.deepEqual(parseTodoLine('- [X] a'), { content: 'a', status: 'completed' });
    assert.deepEqual(parseTodoLine('1) a'), { content: 'a', status: 'pending' });
    assert.equal(parseTodoLine('- [ ]   '), null, '空条目不算');
    assert.equal(parseTodoLine('就是一句话'), null);
    assert.equal(parseTodoLine('    - 缩进四格'), null, '太深的是正文里的嵌套');
    assert.equal(parseTodoLine(`- ${'x'.repeat(501)}`), null, '超长的是叙述，不是待办');
  });
});

describe('todo-state · 写（只动那两节，其余逐字节不变）', () => {
  test('清单写进两节：第一项进「当前任务」，其余进「接着干」', () => {
    const plan = planTodoWrite(STATE_FIXTURE, ITEMS);
    assert.equal(plan.ok, true, plan.ok ? '' : plan.message);
    if (!plan.ok) return;
    assert.equal(plan.changed, true);
    assert.match(plan.text, /## 当前任务\n- \[~\] 核对备份目录\n\n## 接着干\n- \[ \] 看日志尾部\n/);
    // 她自己那一行、别的节、末尾空行——一个都没动
    assert.ok(plan.text.includes('心情：松的。这一行是她写的。'));
    assert.ok(plan.text.includes('## 群的边界（10-02 夜·用户定）\n- 测试群聊1 = 真·私有场子。'));
    assert.ok(plan.text.includes('## 工具常识（已验）\n- 一条早就会了的常识。'));
    assert.equal(plan.text.endsWith('\n'), STATE_FIXTURE.endsWith('\n'));
    // 逐行 diff：**把两节的正文抹成占位符之后，其余每一行必须一一对应**。
    //
    // 为什么不能直接按"改之前的行号"逐行比：正文行数会变，后面的行整体位移——那种比法在
    // 第一处长度差之后就全线错位（实测误报"第 8 行不该变"）。抹掉正文再看，位移就不再影响。
    const stripBodies = (text: string): string[] => {
      const lines = text.split('\n');
      const keep: string[] = [];
      let inBody: 'none' | 'task' | 'ongoing' = 'none';
      for (const line of lines) {
        if (line.startsWith('## 当前任务')) { inBody = 'task'; keep.push(line); continue; }
        if (line.startsWith('## 接着干')) { inBody = 'ongoing'; keep.push(line); continue; }
        if (/^## /u.test(line)) { inBody = 'none'; keep.push(line); continue; }
        if (inBody === 'none') keep.push(line);
      }
      return keep;
    };
    assert.deepEqual(
      stripBodies(plan.text),
      stripBodies(STATE_FIXTURE),
      '把两节正文抹掉之后，其余每一行必须与原文一一对应（顺序与内容都不许变）',
    );
  });

  test('写完再读回来是同一份（往返稳定），重复写同一份 = changed:false', () => {
    const first = planTodoWrite(STATE_FIXTURE, ITEMS);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.deepEqual(extractTodoItems(first.text).items, ITEMS, '写进去的与读出来的必须一致');

    const again = planTodoWrite(first.text, ITEMS);
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.changed, false, '同一份清单再写一次不该产生写入');
    assert.equal(again.text, first.text);
  });

  test('清空：两节置空，节还在（不是把节删掉）', () => {
    const plan = planTodoWrite(STATE_FIXTURE, []);
    assert.equal(plan.ok, true, plan.ok ? '' : plan.message);
    if (!plan.ok) return;
    assert.match(plan.text, /## 当前任务\n\n## 接着干\n\n## 群的边界/);
    assert.deepEqual(extractTodoItems(plan.text).items, []);
  });

  test('CRLF 的 STATE 不会被改成 LF（字节形状的纪律）', () => {
    const crlf = STATE_FIXTURE.replace(/\n/gu, '\r\n');
    const plan = planTodoWrite(crlf, ITEMS);
    assert.equal(plan.ok, true, plan.ok ? '' : plan.message);
    if (!plan.ok) return;
    assert.equal(plan.text.includes('\r\n'), true);
    assert.equal(/(?<!\r)\n/u.test(plan.text), false, '不许留下裸 LF');
  });

  test('缺节 / 只缺一节 → 明确报错，且不改文本', () => {
    const noSections = planTodoWrite('# 当前状态\n\n心情：好。\n', ITEMS);
    assert.equal(noSections.ok, false);
    if (noSections.ok) return;
    assert.equal(noSections.code, 'no_section');
    assert.match(noSections.message, /找不到「## 当前任务」「## 接着干」/);

    const oneSection = planTodoWrite('# x\n\n## 当前任务\n\n- [ ] a\n', ITEMS);
    assert.equal(oneSection.ok, false);
    if (oneSection.ok) return;
    assert.match(oneSection.message, /找不到「## 接着干」/);
    assert.match(oneSection.message, /一个字节都没动/);
  });

  test('两节的顺序被调换过也能处理（各自按区间替换，互不影响）', () => {
    const swapped = [
      '# 当前状态',
      '',
      '## 接着干',
      '',
      '- [ ] 排队的一件',
      '',
      '## 当前任务',
      '',
      '- [~] 在做的一件',
      '',
      '## 别的节',
      '- 不动',
      '',
    ].join('\n');
    const plan = planTodoWrite(swapped, ITEMS);
    assert.equal(plan.ok, true, plan.ok ? '' : plan.message);
    if (!plan.ok) return;
    assert.deepEqual(extractTodoItems(plan.text).items, ITEMS);
    assert.ok(plan.text.includes('## 别的节\n- 不动'), '别的节照旧');
  });

  test('节的标题被改过（关键词还在）仍认；被改名成别的就报错', () => {
    const renamed = STATE_FIXTURE.replace('## 当前任务', '## 当前任务：无（收尾）');
    const ok = planTodoWrite(renamed, ITEMS);
    assert.equal(ok.ok, true, ok.ok ? '' : ok.message);

    const gone = STATE_FIXTURE.replace('## 当前任务', '## 手头的活儿');
    const bad = planTodoWrite(gone, ITEMS);
    assert.equal(bad.ok, false);
    if (bad.ok) return;
    assert.equal(bad.code, 'no_section');
  });
});

describe('todo-state · 纯函数', () => {
  test('渲染一行与切分两节', () => {
    assert.equal(renderTodoLine({ content: 'a', status: 'pending' }), '- [ ] a');
    assert.equal(renderTodoLine({ content: 'a', status: 'in_progress' }), '- [~] a');
    assert.equal(renderTodoLine({ content: 'a', status: 'completed' }), '- [x] a');
    const split = splitAcrossSections(ITEMS);
    assert.deepEqual(split['当前任务'], [ITEMS[0]]);
    assert.deepEqual(split['接着干'], [ITEMS[1]]);
    assert.deepEqual(splitAcrossSections([]), { 当前任务: [], 接着干: [] });
    assert.deepEqual([...TODO_SECTIONS], ['当前任务', '接着干']);
  });
});
