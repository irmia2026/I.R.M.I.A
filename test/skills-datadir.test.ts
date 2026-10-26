/**
 * 技能实体住在**数据目录** — 种子复制 / 技能根生效计划 / 路径别名（v79，2026-10-23）
 *
 * ──────────────────────────────── 为什么这批用例单独一个文件 ────────────────────────────────
 *
 * 2026-10-23 现场两条病同源：运行环境搬进安装目录之后，`SkillManager` 还建在
 * `process.cwd()` 上 ⇒ ① 数据目录里一件技能都没有（界面"没有任何技能"、catalog 0 条）；
 * ② 技能实体住在安装目录 ⇒ 安装器更新（整体替换安装目录）⇒ 装的技能全没。
 *
 * 改法三条，这里各钉一条（**每条都在真临时目录里跑**：真的复制文件、真的读 SKILL.md、
 * 真的经过 fs 工具的别名与只读区判定——不用 mock 假装它们发生过）：
 *
 *   A. **技能根** = 数据目录（`<dataDir>/skills`），cwd 那份退为兼容根（只在主根不存在时生效）；
 *   B. **出厂种子复制**（`ensureSkillsSeed`）：首次整份照搬、第二次一个字节不动、
 *      用户改过/删过的**绝不覆盖**、失败不留半成品；
 *   C. **路径别名** `skills/` → `<dataDir>/skills`：模型读正文的写法一个字节没变，
 *      读到的是数据目录那一份；**写仍然被只读区挡住**（两种写法都挡）。
 *
 * 反向验证（把自己改回去，确认这些用例会红）记在提交说明里；用例本身只认行为。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { describe, type TestContext } from 'node:test';

import { buildSkillList } from '../src/cli.ts';
import { renderSkillsRootLine } from '../src/main.ts';
import { DEFAULT_SKILL_ROOTS, SKILLS_DIR_NAME, SkillManager, planSkillRoots } from '../src/skill/skills.ts';
import { ensureSkillsSeed } from '../src/skill/seed.ts';
import { SKILLS_DATA_READ_ONLY_PREFIX } from '../src/tools/catalog.ts';
import { pathAliasesFor } from '../src/tools/fs/env.ts';
import { DEFAULT_READ_ONLY_PREFIXES, buildFsTools } from '../src/tools/fs/index.ts';
import { FS_ERROR_CODES, type ToolContext, type ToolDefinition } from '../src/tools/fs/types.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

/** 一个临时根（本进程退出时统一删；建了就一定有人删，见 helpers/temp-dirs.ts） */
function makeRoot(t: TestContext, prefix = 'irmia-skills-datadir-'): string {
  const dir = tempDirSync(prefix);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 正文哨兵：读到哪一份就看它，一眼分得出"数据目录"与"出厂种子" */
const DATA_BODY = 'DATA-DIR-BODY-7713';
const SEED_BODY = 'SEED-COPY-BODY-7713';

interface SkillFixture {
  /** 技能根下的目录名（= 技能名） */
  name: string;
  /** `description`（≥20 字符，免得 catalog 顺手报"描述太短"的告警干扰读数） */
  description: string;
  /** SKILL.md 正文那一行哨兵 */
  body: string;
  /** 随包文件（相对技能目录的 posix 路径 → 内容）；用来证明"整份照搬" */
  extra?: Record<string, string>;
}

/** 在**一个技能根**下写一个技能（`<root>/<name>/SKILL.md`），返回根目录 */
function writeSkill(root: string, fixture: SkillFixture): string {
  const dir = join(root, fixture.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${fixture.name}\ndescription: ${fixture.description}\n---\n\n${fixture.body}\n`,
    'utf8',
  );
  for (const [rel, content] of Object.entries(fixture.extra ?? {})) {
    const target = join(dir, ...rel.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return root;
}

/** 一个技能根 + 两个技能（office 带随包文件，alpha 只有 SKILL.md） */
function writeTwoSkills(root: string, body: string): void {
  writeSkill(root, {
    name: 'office',
    description: '写 Word/Excel/PPT 文档、读表格并核对数字时用；先看它再动手',
    body,
    extra: {
      'references/word.md': '# Word 要点\n',
      'scripts/run.mjs': 'console.log("office");\n',
      '.env': 'OFFICE_TOKEN=seed\n',
    },
  });
  writeSkill(root, {
    name: 'alpha',
    description: '处理甲类事情时用：含明确触发词与边界，别凭名字猜步骤',
    body,
  });
}

function ctxOf(workspaceRoot: string): ToolContext {
  return { callId: 'call-1', turn: 1, step: 1, signal: new AbortController().signal, workspaceRoot };
}

/** fs 工具表（find 显式关掉：让这台机器上装没装 es.exe 都不影响读数） */
async function fsToolsOf(input: { workspaceRoot: string; dataDir: string }): Promise<Map<string, ToolDefinition>> {
  const table = new Map<string, ToolDefinition>();
  const built = await buildFsTools(
    { dataDir: input.dataDir, backupDir: join(input.dataDir, '.backups'), everythingPath: null },
    { now: () => new Date('2026-03-01T00:00:00.000Z') },
  );
  built.forEach((tool) => table.set(tool.name, tool));
  return table;
}

// ──────────────────────────────── A. 技能根：数据目录 ────────────────────────────────

describe('技能根：数据目录优先，cwd 只做兼容根', () => {
  test('数据目录里有 skills ⇒ 只扫它（cwd 那份同名技能不参与）', (t) => {
    const cwd = makeRoot(t);
    const dataDir = join(cwd, 'data');
    writeTwoSkills(join(dataDir, DEFAULT_SKILL_ROOTS[0]), DATA_BODY);
    writeTwoSkills(join(cwd, DEFAULT_SKILL_ROOTS[0]), SEED_BODY);

    const plan = planSkillRoots(dataDir, cwd);
    assert.deepEqual(plan.filter((root) => root.compat), [], '主根存在时不该出现兼容根');
    assert.equal(plan[0]?.dir, join(dataDir, DEFAULT_SKILL_ROOTS[0]), '第一个根是数据目录里的 skills/');
    assert.equal(plan[0]?.compat, false);

    const manager = new SkillManager({ baseRoot: dataDir, compatBaseRoot: cwd });
    const scanned = manager.scan();
    assert.deepEqual(scanned.candidates.map((item) => item.name).sort(), ['alpha', 'office']);
    for (const candidate of scanned.candidates) {
      assert.ok(candidate.dir.startsWith(join(dataDir, DEFAULT_SKILL_ROOTS[0])), `要扫数据目录那份：${candidate.dir}`);
      assert.equal(candidate.relDir, `skills/${candidate.name}`, 'relDir 是模型该抄的那条路径（与根基准无关）');
      assert.equal(candidate.skillPath, `skills/${candidate.name}/SKILL.md`);
    }
  });

  test('catalog 用的是数据目录那一份（信任门照旧，描述取自数据目录）', (t) => {
    const cwd = makeRoot(t);
    const dataDir = join(cwd, 'data');
    writeTwoSkills(join(dataDir, DEFAULT_SKILL_ROOTS[0]), DATA_BODY);
    writeSkill(join(cwd, DEFAULT_SKILL_ROOTS[0]), {
      name: 'office',
      description: '出厂种子里的那份描述：如果它进了 catalog 就说明又扫回安装目录了',
      body: SEED_BODY,
    });

    const manager = new SkillManager({ baseRoot: dataDir, compatBaseRoot: cwd });
    assert.ok(manager.confirm('office') !== null, '数据目录里的 office 应该能被确认');
    const catalog = manager.catalog();
    assert.deepEqual(catalog.entries.map((entry) => entry.name), ['office']);
    assert.ok(
      catalog.text.includes('写 Word/Excel/PPT'),
      'catalog 的那条描述必须来自**数据目录**那份 SKILL.md',
    );
    assert.ok(!catalog.text.includes('出厂种子里的那份描述'), '不允许把种子那份的描述带进 catalog');
    assert.equal(catalog.pending.length, 1, 'alpha 没确认过 ⇒ 待确认（不进 catalog）');
  });

  test('数据目录里还没有 skills ⇒ 兼容根兜住（老安装/开发目录仍扫得到）', (t) => {
    const cwd = makeRoot(t);
    const dataDir = join(cwd, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeTwoSkills(join(cwd, DEFAULT_SKILL_ROOTS[0]), SEED_BODY);

    const plan = planSkillRoots(dataDir, cwd);
    assert.deepEqual(
      plan.filter((root) => root.compat).map((root) => root.dir),
      [join(cwd, DEFAULT_SKILL_ROOTS[0])],
      '主根不存在时才补兼容根',
    );

    const manager = new SkillManager({ baseRoot: dataDir, compatBaseRoot: cwd });
    assert.equal(
      manager.roots[0],
      join(dataDir, DEFAULT_SKILL_ROOTS[0]),
      '写入面（roots[0]）永远是数据目录，哪怕它今天还不存在',
    );
    const scanned = manager.scan();
    assert.deepEqual(scanned.candidates.map((item) => item.name).sort(), ['alpha', 'office']);
    for (const candidate of scanned.candidates) {
      assert.ok(candidate.dir.startsWith(join(cwd, DEFAULT_SKILL_ROOTS[0])), `兼容根扫到的：${candidate.dir}`);
      assert.equal(candidate.relDir, `skills/${candidate.name}`);
    }
    // 兼容根里那份照样能走信任门（内容哈希按它的 SKILL.md 算）
    assert.ok(manager.confirm('alpha') !== null);
    assert.deepEqual(manager.catalog().entries.map((entry) => entry.name), ['alpha']);
  });

  test('数据目录里的 skills 存在（哪怕空）⇒ 不再回退兼容根（删掉的技能不许复活）', (t) => {
    const cwd = makeRoot(t);
    const dataDir = join(cwd, 'data');
    mkdirSync(join(dataDir, DEFAULT_SKILL_ROOTS[0]), { recursive: true });
    writeTwoSkills(join(cwd, DEFAULT_SKILL_ROOTS[0]), SEED_BODY);

    assert.deepEqual(planSkillRoots(dataDir, cwd).filter((root) => root.compat), []);
    assert.equal(new SkillManager({ baseRoot: dataDir, compatBaseRoot: cwd }).scan().candidates.length, 0);
  });

  test('启动摘要那一行：说清"技能根：数据目录（附 cwd 兼容根）"', (t) => {
    const cwd = makeRoot(t);
    const dataDir = join(cwd, 'data');

    const primaryOnly = renderSkillsRootLine(planSkillRoots(dataDir, cwd));
    assert.ok(primaryOnly !== null);
    assert.match(primaryOnly, /^技能根: 数据目录 /u);
    assert.ok(primaryOnly.includes(join(dataDir, DEFAULT_SKILL_ROOTS[0])));
    assert.ok(!primaryOnly.includes('兼容根'), '数据目录那一份在的时候不印兼容根（少一句噪声）');

    mkdirSync(dataDir, { recursive: true });
    writeTwoSkills(join(cwd, DEFAULT_SKILL_ROOTS[0]), SEED_BODY);
    const withCompat = renderSkillsRootLine(planSkillRoots(dataDir, cwd));
    assert.ok(withCompat !== null);
    assert.ok(withCompat.includes('附 cwd 兼容根'), `兼容根必须明说：${withCompat}`);
    assert.ok(withCompat.includes(join(cwd, DEFAULT_SKILL_ROOTS[0])));
  });

  test('CLI 的 skill list 与运行期同一条基准（数据目录 + cwd 兼容根）', (t) => {
    const cwd = makeRoot(t);
    const dataDir = join(cwd, 'data');
    mkdirSync(join(dataDir, 'events'), { recursive: true });
    writeTwoSkills(join(dataDir, DEFAULT_SKILL_ROOTS[0]), DATA_BODY);

    const report = buildSkillList(dataDir, cwd);
    assert.deepEqual(report.entries.map((entry) => entry.name).sort(), ['alpha', 'office']);
    assert.deepEqual(report.entries.map((entry) => entry.relDir).sort(), ['skills/alpha', 'skills/office']);
  });
});

// ──────────────────────────────── B. 出厂种子复制 ────────────────────────────────

describe('出厂种子复制（一次性、幂等、绝不覆盖）', () => {
  test('首次运行：整份照搬（含 references/scripts/.env），并如实报个数', (t) => {
    const cwd = makeRoot(t);
    const dataDir = join(cwd, 'data');
    mkdirSync(dataDir, { recursive: true });
    const seedRoot = join(cwd, DEFAULT_SKILL_ROOTS[0]);
    writeTwoSkills(seedRoot, SEED_BODY);

    const report = ensureSkillsSeed(dataDir, seedRoot);
    assert.equal(report.state, 'created');
    assert.deepEqual(report.skills, ['alpha', 'office'], '技能名升序（读数确定性）');
    assert.equal(report.files, 5, 'alpha 1 个 + office 4 个（SKILL.md、references、scripts、.env）');
    assert.equal(report.dest, join(dataDir, DEFAULT_SKILL_ROOTS[0]));

    // 真的在盘上：正文与随包文件一个不少
    const destSkill = join(dataDir, DEFAULT_SKILL_ROOTS[0], 'office');
    assert.ok(readFileSync(join(destSkill, 'SKILL.md'), 'utf8').includes(SEED_BODY));
    assert.equal(readFileSync(join(destSkill, 'references', 'word.md'), 'utf8'), '# Word 要点\n');
    assert.equal(readFileSync(join(destSkill, 'scripts', 'run.mjs'), 'utf8'), 'console.log("office");\n');
    assert.equal(readFileSync(join(destSkill, '.env'), 'utf8'), 'OFFICE_TOKEN=seed\n');
    // 种子本身一个字节都没动（它还要给出下一次安装当种子）
    assert.ok(readFileSync(join(seedRoot, 'office', 'SKILL.md'), 'utf8').includes(SEED_BODY));
  });

  test('第二次启动：不再复制（幂等），一个字节都不动', (t) => {
    const cwd = makeRoot(t);
    const dataDir = join(cwd, 'data');
    mkdirSync(dataDir, { recursive: true });
    const seedRoot = join(cwd, DEFAULT_SKILL_ROOTS[0]);
    writeTwoSkills(seedRoot, SEED_BODY);

    assert.equal(ensureSkillsSeed(dataDir, seedRoot).state, 'created');
    const first = readFileSync(join(dataDir, DEFAULT_SKILL_ROOTS[0], 'office', 'SKILL.md'), 'utf8');

    const second = ensureSkillsSeed(dataDir, seedRoot);
    assert.equal(second.state, 'exists', '第二次启动的结论是"已存在"，不是"又复制了一次"');
    assert.deepEqual(second.skills, []);
    assert.equal(second.files, 0);
    assert.equal(readFileSync(join(dataDir, DEFAULT_SKILL_ROOTS[0], 'office', 'SKILL.md'), 'utf8'), first);

    // 第三次也一样（幂等不是"第二次恰好")
    assert.equal(ensureSkillsSeed(dataDir, seedRoot).state, 'exists');
  });

  test('用户改过的文件不被覆盖（数据目录那份是资产，种子只是出厂默认）', (t) => {
    const cwd = makeRoot(t);
    const dataDir = join(cwd, 'data');
    mkdirSync(dataDir, { recursive: true });
    const seedRoot = join(cwd, DEFAULT_SKILL_ROOTS[0]);
    writeTwoSkills(seedRoot, SEED_BODY);
    ensureSkillsSeed(dataDir, seedRoot);

    // 人改了一份正文（信任门会把它退回待确认，那是人的决定；这里只验"不被覆盖"）
    const edited = join(dataDir, DEFAULT_SKILL_ROOTS[0], 'alpha', 'SKILL.md');
    writeFileSync(edited, '人改过的正文：这一行必须活下来\n', 'utf8');
    // 人**故意删掉**了另一个技能：再复制回来等于"删掉的技能每次启动都复活"
    rmSync(join(dataDir, DEFAULT_SKILL_ROOTS[0], 'office'), { recursive: true, force: true });

    const again = ensureSkillsSeed(dataDir, seedRoot);
    assert.equal(again.state, 'exists');
    assert.equal(readFileSync(edited, 'utf8'), '人改过的正文：这一行必须活下来\n', '改过的正文被覆盖了');
    assert.equal(existsSync(join(dataDir, DEFAULT_SKILL_ROOTS[0], 'office')), false, '删掉的技能被复制回来了');
  });

  test('没有出厂种子 ⇒ 不建空目录（"不存在"要留给兼容根与下一次启动）', (t) => {
    const cwd = makeRoot(t);
    const dataDir = join(cwd, 'data');
    mkdirSync(dataDir, { recursive: true });

    const missing = ensureSkillsSeed(dataDir, join(cwd, 'skills'));
    assert.equal(missing.state, 'no-seed');
    assert.deepEqual(missing.skills, []);
    assert.equal(existsSync(join(dataDir, DEFAULT_SKILL_ROOTS[0])), false, '不许建空目录');

    // 种子目录在、但里面一件技能都没有：同样不复制（空壳会让"存在即不复制"永久关门）
    mkdirSync(join(cwd, 'skills'), { recursive: true });
    assert.equal(ensureSkillsSeed(dataDir, join(cwd, 'skills')).state, 'no-seed');
    assert.equal(existsSync(join(dataDir, DEFAULT_SKILL_ROOTS[0])), false);
  });

  test('落点是个同名文件 ⇒ 如实失败，不碰那个文件', (t) => {
    const cwd = makeRoot(t);
    const dataDir = join(cwd, 'data');
    mkdirSync(dataDir, { recursive: true });
    const seedRoot = join(cwd, DEFAULT_SKILL_ROOTS[0]);
    writeTwoSkills(seedRoot, SEED_BODY);
    const blocker = join(dataDir, DEFAULT_SKILL_ROOTS[0]);
    writeFileSync(blocker, 'not a directory\n', 'utf8');

    const report = ensureSkillsSeed(dataDir, seedRoot);
    assert.equal(report.state, 'failed');
    assert.match(report.failure ?? '', /不是一个目录/u);
    assert.equal(readFileSync(blocker, 'utf8'), 'not a directory\n', '文件必须原样留着，等由人处理');
  });

  test('端到端：种子复制一次之后，运行期技能根就直接看到它们（不需要兼容根）', (t) => {
    const cwd = makeRoot(t);
    const dataDir = join(cwd, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeTwoSkills(join(cwd, DEFAULT_SKILL_ROOTS[0]), SEED_BODY);

    assert.equal(ensureSkillsSeed(dataDir, join(cwd, DEFAULT_SKILL_ROOTS[0])).state, 'created');

    // 复制之后：主根存在 ⇒ 计划里没有兼容根，扫到的却还是那两个技能（只是换了真身的位置）
    const plan = planSkillRoots(dataDir, cwd);
    assert.deepEqual(plan.filter((root) => root.compat), []);
    const manager = new SkillManager({ baseRoot: dataDir, compatBaseRoot: cwd });
    const scanned = manager.scan();
    assert.deepEqual(scanned.candidates.map((item) => item.name).sort(), ['alpha', 'office']);
    for (const candidate of scanned.candidates) {
      assert.ok(candidate.dir.startsWith(join(dataDir, DEFAULT_SKILL_ROOTS[0])));
    }
  });
});

// ──────────────────────────────── C. 路径别名：读得到、写不了 ────────────────────────────────

describe('路径别名 skills/ → <dataDir>/skills', () => {
  test('别名表里那一条指向数据目录，并且是"数据目录优先"', () => {
    const cwd = join('C:', 'work');
    const dataDir = join(cwd, 'data');
    const aliases = pathAliasesFor({ workspaceRoot: cwd }, dataDir);
    const skills = aliases.find((alias) => alias.prefix.toLowerCase() === 'skills');
    assert.ok(skills !== undefined, '别名表里必须有 skills/ —— 模型读正文就靠它');
    assert.equal(skills.root, join(dataDir, SKILLS_DIR_NAME));
    assert.equal(
      skills.mode,
      'alias-first',
      '主根优先会让模型读到安装目录里的出厂种子（信任门绑的是数据目录那份的内容哈希）',
    );
  });

  test('safe_read 读到的是**数据目录**那一份（不是安装目录里的种子）', async (t) => {
    const cwd = makeRoot(t);
    const dataDir = join(cwd, 'data');
    writeTwoSkills(join(dataDir, DEFAULT_SKILL_ROOTS[0]), DATA_BODY);
    // 安装目录里也有同名技能：内容不同，读到哪一份一眼可辨
    writeTwoSkills(join(cwd, DEFAULT_SKILL_ROOTS[0]), SEED_BODY);

    const table = await fsToolsOf({ workspaceRoot: cwd, dataDir });
    const read = table.get('safe_read');
    assert.ok(read !== undefined);
    const result = await read.handler({ path: 'skills/office/SKILL.md' }, ctxOf(cwd));
    assert.equal(result.isError, undefined, result.content);
    assert.ok(result.content.includes(DATA_BODY), '要读数据目录那份正文');
    assert.ok(!result.content.includes(SEED_BODY), '读到出厂种子就说明别名没接管');
  });

  test('数据目录里没有这一份时退回主根（老目录/开发目录仍读得到）', async (t) => {
    const cwd = makeRoot(t);
    const dataDir = join(cwd, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeTwoSkills(join(cwd, DEFAULT_SKILL_ROOTS[0]), SEED_BODY);

    const table = await fsToolsOf({ workspaceRoot: cwd, dataDir });
    const read = table.get('safe_read');
    assert.ok(read !== undefined);
    const result = await read.handler({ path: 'skills/alpha/SKILL.md' }, ctxOf(cwd));
    assert.equal(result.isError, undefined, result.content);
    assert.ok(result.content.includes(SEED_BODY));
  });

  test('写仍然被只读区挡住（skills/ 写法：别名改写之后也认得出）', async (t) => {
    const cwd = makeRoot(t);
    const dataDir = join(cwd, 'data');
    writeTwoSkills(join(dataDir, DEFAULT_SKILL_ROOTS[0]), DATA_BODY);

    const table = await fsToolsOf({ workspaceRoot: cwd, dataDir });
    const target = join(dataDir, DEFAULT_SKILL_ROOTS[0], 'office', 'SKILL.md');
    const before = readFileSync(target, 'utf8');

    const write = table.get('safe_write');
    assert.ok(write !== undefined);
    const written = await write.handler(
      { path: 'skills/office/SKILL.md', content: '被模型改掉的正文', overwrite: true },
      ctxOf(cwd),
    );
    assert.equal(written.isError, true, '写入技能目录必须被拒绝');
    assert.equal(written.error?.code, FS_ERROR_CODES.PATH_DENIED);
    assert.ok(written.content.includes('只读区'), written.content);
    assert.equal(readFileSync(target, 'utf8'), before, '文件必须一个字节都没动');

    const edit = table.get('safe_edit');
    assert.ok(edit !== undefined);
    const edited = await edit.handler(
      { path: 'skills/office/SKILL.md', old: DATA_BODY, new: 'x' },
      ctxOf(cwd),
    );
    assert.equal(edited.isError, true);
    assert.equal(edited.error?.code, FS_ERROR_CODES.PATH_DENIED);
    assert.equal(readFileSync(target, 'utf8'), before);
  });

  test('写仍然被只读区挡住（data/skills 写法：别名不管它，只读前缀自己覆盖）', async (t) => {
    const cwd = makeRoot(t);
    const dataDir = join(cwd, 'data');
    writeTwoSkills(join(dataDir, DEFAULT_SKILL_ROOTS[0]), DATA_BODY);

    // 生产装配那两格是 `buildCatalogRegistry` 给的（`DEFAULT_READ_ONLY_PREFIXES` +
    // `data/persona` + `data/skills`）；这里照抄同一份名单，测的是"只读区那条判据"本身
    const table = new Map<string, ToolDefinition>();
    const built = await buildFsTools(
      {
        dataDir,
        backupDir: join(dataDir, '.backups'),
        everythingPath: null,
        readOnlyPrefixes: [...DEFAULT_READ_ONLY_PREFIXES, SKILLS_DATA_READ_ONLY_PREFIX],
        readOnlyHints: {
          [SKILLS_DATA_READ_ONLY_PREFIX]: '技能目录模型可读、不可改：读正文用 safe_read。',
        },
      },
      { now: () => new Date('2026-03-01T00:00:00.000Z') },
    );
    built.forEach((tool) => table.set(tool.name, tool));

    const write = table.get('safe_write');
    assert.ok(write !== undefined);
    const written = await write.handler(
      { path: 'data/skills/office/SKILL.md', content: '被模型改掉的正文', overwrite: true },
      ctxOf(cwd),
    );
    assert.equal(written.isError, true, '第二种写法同样必须被拒');
    assert.equal(written.error?.code, FS_ERROR_CODES.PATH_DENIED);
    assert.ok(written.content.includes('只读区'), written.content);
  });
});
