/**
 * 上下文审计那份报告的**产出验收**（`tools/context-audit.ts`，2026-10-11）
 *
 * 这一条盯的是"审计报告里那个'谁'写的是**名字**还是**裸 id**"——也就是 v47 那一格
 * （`ContactFacts.personNameOf`）在这份报告里的落点。为什么要**真跑一遍脚本**：
 * 这个判据只在"渲染出来的一屏上"成立，而审计报告的全部价值就是"她当时收到了什么"。
 *
 * 三件事，按"错在哪一层"分开：
 *   ① 只有**群成员别名**的人（`aliases.md` 的 `# 群成员` 段，名字真源**第三档**）⇒ 那一行写名字；
 *   ② 三张名字表里都没有的人 ⇒ **照实回落那串 id**（绝不编名字）；
 *   ③ 那一节自己的脚本自检要**逐字核对通过**（断言不过会在报告里显式写成"未通过"）。
 *
 * ── 两条纪律 ──
 *
 * · **不往仓库里写文件**：脚本用 `IRMIA_AUDIT_OUT` 写到临时目录（缺省才是仓库里那份生成物）。
 *   这条不是洁癖：重跑一次报告就会把 `docs/context-audit.md` 按**当前机器状态**改写
 *   （personaHash、工具清单 digest、磁盘余量都在里面），测试不该顺手改一份被 git 跟踪的生成物。
 * · **不在用例里重算判据**：这里只读脚本的产出、只比字面量。下面那些构造的 id / 名字是
 *   **期望的产出**（不是第二份实现）——改了 `tools/context-audit.ts` 那份场景夹具，就要同步改这里，
 *   而"同步改"正是这条测试要逼出来的那一步。
 *
 * 为什么不断言"整份报告没有一处 `脚本自检 · 未通过`"：那几节里**另有**几处**改动之前就红着的**断言
 * （那些场景把"此刻层在第几条"写成了旧次序，见文件头那一节的历史），与本条要钉的东西无关。
 * 所以这里只核**本节**那一行自检结论（是谁的红就报在谁头上）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(PROJECT_ROOT, 'tools', 'context-audit.ts');

/** 那一节的标题（`tools/context-audit.ts` 里 `list.push({ title })` 的那一串，逐字） */
const SECTION_TITLE = '## 场景 11 · 群里有人试探过她';

/** 只有**群成员别名**的人：`FFEEDD…` 的名字只在 `aliases.md` 的 `# 群成员` 段里写着 */
const MEMBER_ONLY_ID = 'FFEEDDCCBBAA99887766554433221100';
/** 她给那个人起的名字（**故意与他日志里的昵称「路边摊老板」不同**：这个名字只可能来自那一档） */
const MEMBER_ONLY_NAME = '打本的老王';
/** 三张名字表里都没有的人：屏幕上应当**照实**写这串 id */
const UNKNOWN_ID = '0123456789ABCDEF0123456789ABCDEF';

/** 跑一次脚本，返回它写出来的报告（写到临时文件，不碰仓库里那份） */
function runAudit(): string {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-audit-req-'));
  const out = join(dir, 'context-audit.md');
  try {
    const spawned = spawnSync(process.execPath, ['--experimental-strip-types', SCRIPT], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 180_000,
      // **只**给这一条：脚本缺省写的还是仓库里那份生成物（缺省行为没变）
      env: { ...process.env, IRMIA_AUDIT_OUT: out },
    });
    assert.equal(spawned.status, 0, `审计脚本必须跑通（status=${String(spawned.status)}）\n${spawned.stderr}`);
    return readFileSync(out, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 那一节（从它的标题到下一个 `## ` 标题之前） */
function sectionOf(report: string, title: string): string {
  const start = report.indexOf(title);
  assert.notEqual(start, -1, `报告里找不到那一节「${title}」——场景被删了或标题改了`);
  const rest = report.slice(start + title.length);
  const next = rest.indexOf('\n## ');
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * 那一节里"**这一屏**"的正文：`③ input` / `② instructions` 那些 ```` ````` 围栏里逐字抄出来的东西。
 *
 * 为什么必须把范围收到围栏里：围栏**外**是这一节的说明文字，里面会出现这些 id（例如
 * 「id …（打本的老王）在这一屏上一次都没出现」这句机械核对——它正是在*说*那串 id 不在屏上）。
 * 要钉的是"她收到的那一屏上写的是名字还是那串 id"，所以只有围栏里算数。
 */
function screenedText(section: string): string {
  const out: string[] = [];
  for (const hit of section.matchAll(/^````text\n([\s\S]*?)^````$/gmu)) out.push(hit[1] ?? '');
  return out.join('\n');
}

test('审计报告里：只有群成员别名的人写成名字，认不出的人照实回落那串 id', () => {
  const report = runAudit();
  const section = sectionOf(report, SECTION_TITLE);

  // ① 名字真源的**第三档**（群成员别名）在报告里生效：那一行写的是名字
  const screen = screenedText(section);
  assert.ok(
    screen.includes(`· 摸鱼群（群聊）· ${MEMBER_ONLY_NAME} —— 曾试图打探/注入 1 次`),
    `「预警：」那一行必须写出群成员别名那一档的名字（${MEMBER_ONLY_NAME}）\n--- 本节那一屏 ---\n${screen}`,
  );
  // ……而且**不能**退回裸 id（修之前就是这一串：审计的 ContactFacts 没给 personNameOf）
  assert.equal(
    screen.includes(MEMBER_ONLY_ID),
    false,
    '有名字的人不许再以裸 id 的形式出现在那一屏上（同一个人的两个名字，正是 v47 修的那件事）',
  );
  assert.equal(
    screen.includes(`· 摸鱼群（群聊）· ${MEMBER_ONLY_ID} —— 曾试图`),
    false,
    '更准确地说：不许出现"以那串 id 打头"的预警行',
  );

  // ② 反面：三张表里都没有的人 ⇒ 照实写 id（"认不出"与"认得出"在这一屏上是两种写法）
  assert.ok(
    screen.includes(`· 摸鱼群（群聊）· ${UNKNOWN_ID} —— 曾试图打探/注入 1 次`),
    '认不出的人必须照实回落那串 id（绝不编名字）',
  );

  // ③ 产出的名字来自**哪一档**：报告 §0 要如实列出三张名字表（第三张 = 群成员别名）
  assert.ok(report.includes('群成员别名表'), '报告 §0 要列出群成员别名那一档（否则读的人不知道名字从哪来）');
  assert.ok(report.includes(MEMBER_ONLY_NAME), '§0 那张表里要写着这个名字');

  // ④ 本节自己的断言逐字核对通过（不过会在报告里显式写成"未通过"——那是这一节的红）
  assert.match(
    section,
    /\*\*脚本自检\*\*：\d+ 条断言（[^）]*）逐字核对通过。/u,
    `本节断言必须逐字核对通过\n--- 本节自检那一段 ---\n${section.slice(section.indexOf('**脚本自检**'), section.length).slice(0, 300)}`,
  );
});
