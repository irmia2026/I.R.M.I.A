/**
 * 公开副本发布纪律：**技能默认不外发；要公开必须显式进白名单**（tools/publish-oss.mjs 的表零 SKILLS_PUBLIC）
 *
 * 这条纪律管两件事，两件事都在这份文件里被盯着：
 *   ① **事实**：这个仓库发布出去的技能只有 `anysearch` 一个，其余一律不外发；
 *   ② **默认值**：不外发**不需要任何人登记**。她将来新建的任何一个技能目录（磁盘上的、还没提交的、
 *      已经提交的）都落在"不外发"这一档里 —— **不报错、不中止、不拦同步**，也不需要谁去代码里加一行。
 *
 * 为什么第 ② 条也要写成断言（它是这份文件里最要紧的一条）：这条纪律的第一版是 fail-closed 的
 *   ——"白名单外、排除表里也没提到的技能目录 ⇒ 中止同步"（exit 3，`--allow-dirty` 也绕不过）。看着更
 *   安全，实际形状是"**她每新建一个技能，同步就被拦下，直到有人去代码里加一行登记**"：把维护名单的
 *   活儿塞给了人，还挡住了与"这个技能该不该公开"无关的正常同步。2026-10-10 拆掉那道门，判据换成
 *   "白名单之外一律不外发"这个**默认值** —— 不外发由形状本身保证（同步范围由表零生成，白名单之外的
 *   技能根本不在 willPublish 的判据里），不需要谁记得做什么。
 *   所以下面第 3 组用例的判据是"**探针在场 ⇒ 同步照常进行（exit 0）且它不进计划**"，
 *   而不是"探针在场 ⇒ 同步被拦住"。
 *
 * 五组断言：
 *   1. 今天的既成事实：会发布的技能只有 anysearch；磁盘上其余技能目录一律不外发（这一档不需要登记）；
 *   2. 同步计划（`--dry`）：白名单里的 anysearch 会同步；白名单之外的技能**一个文件都不出现**
 *      （这一组跑在**已跟踪**文件上，所以它也是"跟踪着但没进白名单 ⇒ 不外发"的硬证据）；
 *   3. 造一个临时假技能目录 ⇒ **同步照常（exit 0）**、**它不进计划**、报表把它列在"不外发"里；
 *      测完**必须删掉**，删掉之后报表恢复原状（证明上面那几条读数确实是那个探针造成的）；
 *   4. 「白名单之外一律不外发」这条判据**只有一处定义**（源码级断言），且"没登记就中止"那道门
 *      确实已经拆掉（源码级 + 行为级：第 3 组）；
 *   5. 两张白名单**集合相等**（防漂移）：publish-oss.mjs 的 SKILLS_PUBLIC（管公开仓库）
 *      与 assemble-package.ps1 的 $SkillsWhitelist（管 zip 包）——**规则：要公开必须两处都登记**。
 *
 * ⚠️ 这组用例**刻意不写**"白名单之外一个都不能有""每个技能目录都必须被登记"这类断言：那正是要拆掉
 *    的维护负担 —— **她新建一个技能，不该让任何一条测试变红**。
 *
 * 怎么跑才不脆：第 2、3 组给 `--oss` 一个**空的临时 git 仓库**，于是"会同步哪些文件"这件事与真实
 * 公开副本当时的状态无关（真实副本是最新的时，计划本来就是空的——那种时候断言会变成空话）。测的仍
 * 是同一份判据：脚本从仓库侧算 wanted，与公开副本里有什么无关。
 *
 * 测试文件里刻意**不写**那几个私有技能的名字：`test/**` 本身也是要同步进公开副本的东西，而"私有资产
 * 连名字都不该出现在公开面"是 tools/private-words.json 里钉死的口径（oss 档 fatal；那条记录记的就是
 * "内容挡住了、名字从别处漏了"）。名字从脚本的报表输出里取。
 *
 * ⚠️ 公开副本里没有 tools/publish-oss.mjs（EXCLUDE 里钉着它），所以这组用例在那边整组跳过——
 * 它只在仓库侧跑得起来，那也正是这条判据该被盯住的地方。
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { describe, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISH = join(REPO, 'tools', 'publish-oss.mjs');
/** zip 包那侧的白名单（$SkillsWhitelist）住在这儿 —— 第 5 组用例只**读它的源码文本** */
const ASSEMBLE = join(REPO, 'packaging', 'assemble-package.ps1');
const SKILLS_DIR = join(REPO, 'skills');

/**
 * 会发布的技能清单 —— **从表零的源码文本读出来**，不在这里写死。
 * 为什么改成"读出来"（2026-10-10）：从前这里写着 `const ONLY_PUBLIC = 'anysearch'`，
 * 于是"随框架多发一份技能"这件事会**因为测试写死了名字而变红**，而那条纪律本身
 * （"默认不外发、只有白名单会外发"）根本没被违反。判据应该盯**规则**，不是盯**名单的长度**：
 *   · 名单内容由表零唯一决定（脚本自己的报表输出也会独立核一遍，见第 1 组）；
 *   · 这里读源码文本只为了知道"应该有哪些"，好把报表/计划与它对照。
 */
const PUBLIC_SKILLS: string[] = (() => {
  const hit = /const\s+SKILLS_PUBLIC\s*=\s*\[([^\]\n]*(?:\n[^\]\n]*)*)\]/u.exec(readFileSync(PUBLISH, 'utf8'));
  const names: string[] = [];
  for (const token of (hit?.[1] ?? '').replace(/\/\/[^\n]*/gu, '').split(',')) {
    const lit = /^\s*['"]([^'"]*)['"]\s*$/u.exec(token);
    if (lit?.[1]) names.push(lit[1]);
  }
  return names.sort();
})();
/** 白名单里那个**搜索**技能：它是既成事实（公开副本一直有它），无论白名单怎么变都不该消失 */
const SEARCH_SKILL = 'anysearch';
/**
 * 那个搜索技能的旧名字别名 —— 给"与它逐字相关"的断言用（它的文件数、它那份字面量只许出现一次…）。
 * ⚠️ **不许**再用它去断言"白名单里只有这一个名字"：那会让"多发一份框架自带技能"变成红，
 *    而那条纪律（默认不外发、只有白名单会外发）根本没被违反。白名单的内容一律以 `PUBLIC_SKILLS` 为准。
 */
const ONLY_PUBLIC = SEARCH_SKILL;
/** 探针：证明"白名单之外的技能目录照常不外发、也不拦同步"。用完必须删掉（下面 finally + t.after 两道） */
const PROBE = '__tmp-unlisted-probe__';

const HAS_SCRIPT = existsSync(PUBLISH);

interface SkillsCheck {
  ok: boolean;
  skillsRoot: string;
  onDisk: string[];
  anomaly: string[];
  public: string[];
  private: string[];
  unlisted: string[];
  doubleListed: string[];
  missingPublic: string[];
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Run {
  const r = spawnSync(process.execPath, [PUBLISH, ...args], { cwd: REPO, encoding: 'utf8' });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 读一行 JSON（报表的机器可读契约：**只输出一行** JSON，stdout 上别的东西不许混进来） */
function parseJson<T>(r: Run, what: string): T {
  const lines = r.stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '');
  assert.equal(lines.length, 1, `${what} 只该输出一行 JSON，实际 ${lines.length} 行：\n${r.stdout}`);
  return JSON.parse(lines[0] ?? '{}') as T;
}

/**
 * `--skills-check --json` 那一行。
 * ⚠️ exit 0 是这条纪律的一部分：报表是**信息性**的，白名单之外有技能目录不是失败
 * （唯一非 0 的情形是 skills/ 读不出这种环境错误）。
 */
function skillsCheck(): SkillsCheck {
  const r = run(['--skills-check', '--json']);
  assert.equal(r.code, 0, `技能盘面报表必须 exit 0（不外发是默认值，不是失败）——实际 ${r.code}\n${r.stdout}${r.stderr}`);
  return parseJson<SkillsCheck>(r, '--skills-check --json');
}

/**
 * 空的临时公开副本（git init 一个空仓库）。
 * 为什么要有它：`--dry` 的计划 = "仓库侧该同步的" 减去 "公开副本已有的"。拿真实副本跑，计划会
 * 随公开副本的状态忽多忽少（它是最新的时计划为空，断言就成了空话）；拿空仓库跑，计划恒等于
 * "会被发布出去的全部文件"，判据才每次都在真的被验。
 */
function emptyOss(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-oss-dry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

/** `--dry` 在空副本上的同步计划行（脚本第 1 步只打印这两种形态） */
function plannedLines(dry: Run): string[] {
  return dry.stdout.split('\n').filter((line) => /^ {2}[增减] /.test(line));
}

/** 计划行里涉及 skills/ 的那个目录名（不涉及就返回 null） */
function plannedSkillOf(line: string): string | null {
  const at = line.indexOf('skills/');
  if (at < 0) return null;
  return line.slice(at + 'skills/'.length).split('/')[0] ?? '';
}

/** 磁盘上真实的技能目录名（报表读的必须是这一份，不是夹具） */
function skillsOnDisk(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true }).map((e) => e.name).sort();
}

describe('公开副本的技能白名单（默认不外发、无需登记）', {
  skip: HAS_SCRIPT ? false : '公开副本里没有 tools/publish-oss.mjs（它不外发）—— 这条判据只在仓库侧跑',
}, () => {
  test('既成事实：会发布的技能 = 表零里显式写下的那几个；磁盘上其余技能目录一律不外发（这一档不需要登记）', () => {
    const check = skillsCheck();

    // ① 报表报的"会发布"必须**恰好等于**表零（源码文本读出来的那份）——多一个少一个都是漂移
    assert.deepEqual([...check.public].sort(), PUBLIC_SKILLS,
      '会同步、会发布的技能必须与表零 SKILLS_PUBLIC 逐字一致：多一个或少一个都说明两处漂移了');
    // ①-b 其中那个**搜索**技能是既成事实，白名单怎么变都不该把它弄丢
    assert.ok(check.public.includes(SEARCH_SKILL),
      `${SEARCH_SKILL} 一直在公开副本里，不该从白名单里消失`);

    // ② 判据看的是**磁盘上的真东西**（不是夹具、也不是 git 跟踪状态）
    assert.deepEqual(check.onDisk, skillsOnDisk(), '报表报的目录清单必须等于磁盘上真实的 skills/');

    // ③ 三个档彼此不重叠（会发布 / 有备注的不外发 / 没备注的不外发），合起来就是磁盘上的全部
    const buckets = [...check.public, ...check.private, ...check.unlisted];
    assert.deepEqual([...buckets].sort(), check.onDisk,
      '每个技能目录都必须在三个档里有一个归宿 —— 但**只有第一档会外发**：'
      + '后两档的区别只是"排除表里有没有一句说明"，两档都不需要谁去登记');
    assert.equal(new Set(buckets).size, buckets.length, '三个档之间不许重叠');

    // ④ 报表是信息性的：它不因为"有白名单之外的目录"而失败
    assert.equal(check.ok, true, '报表的 ok 只取决于"判据能不能应用"，不取决于谁没登记');
    assert.deepEqual(check.anomaly, [], 'skills/ 必须是个能读的目录');
    assert.deepEqual(check.missingPublic, [], '白名单里的技能目录必须在磁盘上（不然公开副本里那份会被删掉）');
    assert.deepEqual(check.doubleListed, [], '今天没有"名字既在白名单又在排除表"的（有的话报表会告警，但不中止）');

    // ⑤ "不外发"这半边今天有真东西 ⇒ 上面那些断言不是空话
    assert.ok(check.private.length + check.unlisted.length > 0,
      '今天有若干技能目录是不外发的（否则"不外发"这半边全是空断言）');
    assert.ok(!check.private.includes(ONLY_PUBLIC) && !check.unlisted.includes(ONLY_PUBLIC),
      '会发布的那个不该同时出现在不外发的档里');
    // ⚠️ 这里刻意**不写** `assert.deepEqual(check.unlisted, [])` 这类断言：她新建一个技能目录就会让它
    //    变红，而"新建技能不用跟谁打招呼"正是这条纪律要保住的东西（见文件头第 ② 条）。
  });

  test('同步计划：白名单里的 anysearch 会同步；白名单之外的技能一个文件都不出现', (t) => {
    const check = skillsCheck();
    const oss = emptyOss(t);
    const dry = run(['--dry', '--allow-dirty', '--oss', oss]);
    assert.equal(dry.code, 0, `--dry 必须通过（exit ${dry.code}）\n${dry.stdout}${dry.stderr}`);

    const planned = plannedLines(dry);
    assert.ok(planned.length > 0, `空副本上的计划必须有条目，否则这条断言是空的：\n${dry.stdout}`);

    // ① "会发布"这半边：白名单里的技能确实在计划里
    const publicLines = planned.filter((line) => line.includes(`skills/${ONLY_PUBLIC}/`));
    assert.ok(publicLines.length > 0,
      `白名单里的 skills/${ONLY_PUBLIC} 必须在同步计划里（"会同步"这半边得有证据）`);

    // ② "不外发"这半边：两个不外发的档，一个文件都不许出现在计划里
    //    ⚠️ 这里查的是**已跟踪**的技能目录：它们走的是"git ls-files 看得见、但白名单里没有"那条路，
    //    也就是真实的泄漏路径（她把自己的技能提交掉之后）。判据要是漏了，这一步立刻会红。
    for (const name of [...check.private, ...check.unlisted]) {
      assert.ok(!planned.some((line) => line.includes(`skills/${name}`)),
        `白名单之外的 skills/${name} 不该出现在同步计划里：\n${planned.join('\n')}`);
    }

    // ③ 反向兜底：计划里凡涉及 skills/ 的，只能是白名单里的目录（否则"白名单之外一律不外发"是空话）
    for (const line of planned) {
      const name = plannedSkillOf(line);
      if (name === null) continue;
      assert.ok(check.public.includes(name),
        `同步计划里出现了不在白名单里的技能目录（那就是默认外发）：${line}`);
    }

    // ④ 计划里的技能文件数与磁盘上白名单目录的**文件**数对得上（不是"看起来没几条"）
    const realFiles = readdirSync(join(SKILLS_DIR, ONLY_PUBLIC), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile()).length;
    assert.ok(publicLines.length >= realFiles,
      `计划里的 skills/${ONLY_PUBLIC} 文件数（${publicLines.length}）不该少于磁盘上的（${realFiles}）`);
  });

  test('白名单之外的技能目录（临时探针）⇒ 同步照常进行、它不进计划；测完即删', (t: TestContext) => {
    const probe = join(SKILLS_DIR, PROBE);
    const oss = emptyOss(t);
    const cleanup = (): void => rmSync(probe, { recursive: true, force: true });
    t.after(cleanup); // 兜底：断言失败也删（探针留在仓库里，报表就会一直多一行）
    try {
      mkdirSync(probe, { recursive: true });
      writeFileSync(join(probe, 'SKILL.md'),
        `---\nname: ${PROBE}\ndescription: 临时探针：只在测试期间存在，用来证明白名单之外的技能目录不拦同步、也不外发\n---\n\n临时探针正文。\n`,
        'utf8');
      assert.ok(existsSync(join(probe, 'SKILL.md')), '探针得真的在磁盘上，下面的断言才有意义');

      // ① 报表：exit 0（**不是**失败），探针落在"不外发"那一档里，白名单不受影响
      const check = skillsCheck(); // 这个 helper 自己就断言 exit 0
      assert.equal(check.ok, true, '白名单之外有目录 ⇒ 报表照旧 ok（不外发是默认值，不是错误）');
      assert.ok(check.unlisted.includes(PROBE),
        `报表必须把探针列在"不外发"里（今天不外发的档：${[...check.private, ...check.unlisted].join(', ')}）`);
      assert.deepEqual([...check.public].sort(), PUBLIC_SKILLS,
        '白名单不受探针影响（探针只能落在"不外发"档）');
      assert.deepEqual(check.anomaly, [], '探针不该让判据没法应用');
      assert.deepEqual(check.private, check.private.filter((n) => n !== PROBE),
        '探针没在排除表里登记，也就不会出现在"有备注"那一档（**不用登记**正是这条纪律的一部分）');

      // ② 同步照常：探针在场**不是**拦同步的理由。
      //    ⚠️ 刻意**不加** --allow-dirty —— 真实跑法就是这一条；新技能目录也从不是"草稿问题"
      //    （它根本不在 willPublish 的判据里，脏树门看不见它）。
      //    唯一要容忍的另一种结果：仓库里**别的**未提交改动触发了脏树门（那是另一条设计，与技能无关）
      //    ——那时这条用例退一步，只钉"报错里没有探针"，再用 --allow-dirty 把计划拿到手继续验（见 ③）。
      const dry = run(['--dry', '--oss', oss]);
      const dryOut = dry.stdout + dry.stderr;
      if (dry.code !== 0) {
        assert.ok(!dryOut.includes(PROBE), `探针不许成为拦同步的理由：\n${dryOut}`);
        assert.match(dryOut, /未提交改动/u,
          `探针在场时的非 0 只可能是"别的文件脏"那道门（别的原因要在这里暴露出来）：\n${dryOut}`);
      }

      // ③ 探针一个文件都不进计划（无论 ② 走的是哪条路，这一条都必须成立）
      const plan = dry.code === 0 ? dry : run(['--dry', '--allow-dirty', '--oss', oss]);
      assert.equal(plan.code, 0, `同步必须照常进行（exit ${plan.code}）\n${plan.stdout}${plan.stderr}`);
      const planned = plannedLines(plan);
      assert.ok(planned.length > 0, `空副本上的计划必须有条目，否则下面的断言是空的：\n${plan.stdout}`);
      assert.ok(!planned.some((line) => line.includes(PROBE)),
        `白名单之外的探针不许进同步计划：\n${planned.join('\n')}`);

      // ④ 探针在场时，计划里涉及 skills/ 的仍只能是白名单里的目录（与第 2 组同一条判据，再验一遍）
      for (const line of planned) {
        const name = plannedSkillOf(line);
        if (name === null) continue;
        assert.ok(check.public.includes(name),
          `探针在场时，计划里出现了不在白名单里的技能目录：${line}`);
      }

      // ⑤ --allow-dirty 是另一个开关，加不加都不改变"探针不外发"
      const forced = run(['--dry', '--allow-dirty', '--oss', oss]);
      assert.equal(forced.code, 0, '--allow-dirty 下同样照常同步');
      assert.ok(!plannedLines(forced).some((line) => line.includes(PROBE)),
        '--allow-dirty 也不许把探针带进计划');
    } finally {
      cleanup();
    }

    // ⑥ 探针确实被删掉了（这是这条用例的交付物之一：仓库里不许留它）
    assert.equal(existsSync(probe), false, '探针目录必须已被删掉');
    assert.ok(!skillsOnDisk().includes(PROBE), '磁盘上的技能目录清单里也不许有它');

    // ⑦ 删掉之后报表恢复原状 ⇒ 拦住/列住它的确实是那个探针，不是别的什么
    const after = skillsCheck();
    assert.ok(!after.unlisted.includes(PROBE), '探针删掉后报表里不许再有它');
    assert.deepEqual(after.onDisk, skillsOnDisk(), '报表与磁盘必须重新一致');
  });

  test('「白名单之外一律不外发」只有一处定义，且「没登记就中止」那道门已经拆掉（源码级断言）', () => {
    const src = readFileSync(PUBLISH, 'utf8');
    const count = (re: RegExp): number => (src.match(re) ?? []).length;
    // ⚠️ 段落正则一律写成 `\r?\n`，**不许写死 `\n`**（这条踩过，是真的红过）：
    //   仓库没有 .gitattributes，本机 core.autocrlf=true ⇒ 同一次提交在 Windows 上检出就是 CRLF
    //   （tools/publish-oss.mjs 现在就是 CRLF）。用 `\n}\n` 当函数体结尾去锚，CRLF 工作区里一个都
    //   匹配不上 ⇒ bodyOf 返回空串 ⇒ "函数里必须有 X"直接误报（不是代码变了，是换行符变了）。
    const bodyOf = (re: RegExp): string => re.exec(src)?.[1] ?? '';

    // ① 判据函数只有一处定义，且**只有它**拿技能名去比白名单
    assert.equal(count(/function skillVerdict\(/gu), 1, '判据函数必须只有一处定义');
    assert.equal(count(/SKILLS_PUBLIC\.includes\(/gu), 1,
      '拿技能名去比白名单的地方只许有一处 —— 别处自己判，就又会退化成"漏一处"');
    const verdictBody = bodyOf(/function skillVerdict\(name\)\s*\{([\s\S]*?)\r?\n\}/u);
    assert.ok(verdictBody.includes('SKILLS_PUBLIC.includes('),
      '唯一的白名单比对必须在判据函数体内');
    assert.ok(verdictBody.includes("'unlisted'"),
      '白名单之外的默认档必须还在（'+"'unlisted'"+'）：不外发是**默认值**，不是一种要人批准的状态');

    // ② 白名单里的名字只写一次（别处再写一遍 = 第二份白名单）
    assert.equal(count(new RegExp(`'${ONLY_PUBLIC}'`, 'gu')), 1,
      `白名单的字面量只许出现在 SKILLS_PUBLIC 里一次（今天那个名字是 ${ONLY_PUBLIC}）`);

    // ③ 两个消费方都走同一个判据：同步计划（表一/取文件）与磁盘报表
    const publishBody = bodyOf(/function willPublish\(rel\)\s*\{([\s\S]*?)\r?\n\}/u);
    assert.ok(publishBody.includes('skillVerdict('),
      '"这个文件会不会被发布"必须问判据函数');
    assert.ok(publishBody.indexOf('skillVerdict(') < publishBody.indexOf('exclusionOf('),
      '技能那一支必须**先判、且只看白名单**：排除表里那几条 skills/<名> 已经降级成"说明"，不再是门'
      + '（否则"发不发只看表零"这句话就是假的）');
    assert.ok(bodyOf(/function auditSkills\(\)\s*\{([\s\S]*?)\r?\n\}\r?\n/u).includes('skillVerdict('),
      '磁盘报表必须问判据函数');

    // ④ 同步范围的形状：技能项由白名单生成，**没有裸 'skills'**（那正是缺口的形状）
    assert.match(src, /\.\.\.SKILLS_PUBLIC\.map\(/u, '同步范围里的技能项必须由白名单生成，不许手写第二份');
    assert.ok(!/^\s*'skills',\s*$/mu.test(src),
      "同步范围里不许再出现裸 'skills'（整个目录在范围里 = 新技能默认可发布）");

    // ⑤ **本次改动的核心**：那道 fail-closed 的门确实拆掉了。
    //    白名单之外的技能目录只该"不外发"，不该"中止同步"。行为证据在第 3 组；这里钉的是源码里连那句
    //    拒绝都不该在 —— 免得将来有人"顺手加回来"，把维护名单的活儿又塞回给人。
    assert.ok(!src.includes('拒绝同步：skills/'),
      '白名单之外的技能目录不许再中止同步 —— 那道门的实际效果是"她每新建一个技能，同步就被拦下"');
    assert.ok(!/未登记（白名单/u.test(src), '旧的"没登记"报错口径必须删干净');
    assert.equal(count(/\bunknown\b/gu), 0, "旧的 'unknown' 档（把\"没登记\"当成一种状态）已经没有了");
    assert.equal(count(/\bconflict\b/gu), 0, "旧的 'conflict' 档（两边都写了就中止）已经没有了");
    assert.match(src, /const ok = audit\.anomaly\.length === 0;/u,
      '报表的 ok 只取决于"判据能不能应用"（skills/ 读不出）—— 白名单之外有目录不是失败');
    assert.match(src, /无需登记/u, '口径必须写明"不外发无需登记"（那是这条纪律的另一半）');
  });

  test('两张白名单集合相等（防漂移）：publish-oss.mjs 的 SKILLS_PUBLIC ↔ assemble-package.ps1 的 $SkillsWhitelist —— 要公开必须两处都登记', () => {
    // 为什么要有这条：这两张表管的是**同一个决定**（"这个技能公不公开"），却分别管两个出口 ——
    //   · tools/publish-oss.mjs 的 SKILLS_PUBLIC  → 公开仓库同步哪些技能目录；
    //   · packaging/assemble-package.ps1 的 $SkillsWhitelist → zip 包（给测试者的那份）里放哪些技能。
    // 规则：**要公开必须两处都登记**。今天两张表恰好都是 anysearch，但"恰好"不是机制：将来公开
    //   一个新技能要同时改两处，而没有任何东西强制一致。漏改一边的两种后果都不小 ——
    //   只改 zip 侧 = 技能进了每个人的包、却没进公开仓库（两个出口的内容对不上）；
    //   只改公开仓库侧 = 技能公开了、包里却没有（测试者拿不到他本该拿到的东西）。
    //   所以把"一致"本身变成一条会红的断言：改一边不改另一边 ⇒ 这条用例红，并在消息里点名
    //   "哪边多了/少了哪个技能"与"该同时改哪两处（文件:行）"。
    // 怎么读这两张表：**只读源码文本 + 正则**，不 import、不执行 PowerShell（那会在非 Windows 上
    //   炸、也会把"读一张静态表"变成"跑一段任意代码"）。正则只认"名字字面量"，注释掉的那一行
    //   不算登记（注释里写个名字不等于公开了它），落在数组外的同名文本也不算。
    // ⚠️ 断言只做**集合相等**，不规定顺序：两张表都是人读的表，顺序怎么排是风格问题，不是纪律。
    // 边界（为什么不把第三处也纳进来）：`packaging/verify-package.ps1` 的第 4 项也钉着"zip 里只有
    //   anysearch"，但它是**会当场 throw 的复验**（包里多一个目录就红）——那是"响的"，不是静默漂移。
    //   这条检查盯的是**不会自己响**的那一对：公开仓库 ↔ zip 清单（漏改一边，谁都不会叫）。
    const src = readFileSync(PUBLISH, 'utf8');
    const psSrc = readFileSync(ASSEMBLE, 'utf8');

    /** 抓一张表：返回名字、字面量所在行、以及数组原文（原文用来把行号定位到数组那一行） */
    const tableOf = (text: string, label: string, re: RegExp): { names: string[]; line: number; raw: string } => {
      const hits = [...text.matchAll(re)];
      assert.equal(hits.length, 1,
        `${label} 必须**恰好**有一处定义，实际 ${hits.length} 处 —— 两处及以上就是漂移（改了这处、漏了那处）`);
      const hit = hits[0];
      assert.ok(hit !== undefined);
      const raw = hit[0] ?? '';
      const line = text.slice(0, hit.index ?? 0).split('\n').length;
      // 抓的是括号/方括号**里面**那段（捕获组 1）：先掐掉注释，再按逗号切，最后剥掉每个名字的引号。
      //   ① 注释掐掉：注释里写个名字不等于登记了它（否则"注释掉一行"会把漂移盖住）；
      //   ② 只留带引号的整词：`@(` / `)` / 换行 / 尾随空白都不算名字（一个字符都不猜）。
      const names: string[] = [];
      for (const token of (hit[1] ?? '').replace(/\/\/[^\n]*/gu, '').split(',')) {
        const lit = /^\s*['"]([^'"]*)['"]\s*$/u.exec(token);
        if (lit?.[1]) names.push(lit[1]);
      }
      assert.ok(names.length > 0,
        `${label} 抓出来是空的 —— 表不该是空的（两张表都空也只说明这条断言是空话，不是"一致"）\n`
        + `  抓到的原文：${JSON.stringify(raw)}`);
      return { names, line, raw };
    };

    // 两张表的**语法不同**，所以两条正则各认各的形状（而不是用一条宽松的正则去糊两种写法）：
    //   JS：const SKILLS_PUBLIC = ['anysearch'];
    //   PS：$SkillsWhitelist = @('anysearch')
    const oss = tableOf(src, 'tools/publish-oss.mjs 的 SKILLS_PUBLIC',
      /const\s+SKILLS_PUBLIC\s*=\s*\[([^\]\n]*(?:\n[^\]\n]*)*)\]/gu);
    const zip = tableOf(psSrc, 'packaging/assemble-package.ps1 的 $SkillsWhitelist',
      /\$SkillsWhitelist\s*=\s*@\(([^)\n]*(?:\n[^)\n]*)*)\)/gu);

    // 防"两边一起解析错"与"重复登记糊过去"：两张表共用一个解析器 ⇒ 解析 bug 会让两边**同样地错**，
    //   而"集合相等"照样绿。下面三道闸门都不依赖"两边一致"这件事本身：
    //     ① 每个名字必须长成技能名的样子（技能系统规范：小写字母/数字/连字符）——残留的引号、
    //        分号、括号一眼就露；
    //     ② 每张表内部不许重复登记（['a','a'] 与 ['a'] 集合相同，但那正是"漏改一处"的形状）；
    //     ③ 公开仓库那一侧必须**真的含**今天那个会发布的技能 —— 这个事实由第 1 组用例独立钉着
    //        （它读的是脚本自己的报表输出，与这里的正则解析无关），于是"解析器整个抓歪"
    //        不可能悄悄变成"一致"。
    const sites = [
      { label: 'tools/publish-oss.mjs 的 SKILLS_PUBLIC（管公开仓库同步）', ...oss },
      { label: 'packaging/assemble-package.ps1 的 $SkillsWhitelist（管 zip 包）', ...zip },
    ];
    for (const site of sites) {
      assert.equal(new Set(site.names).size, site.names.length,
        `${site.label} 里同一个名字登记了两遍：${site.names.join('、')}`);
      for (const name of site.names) {
        assert.match(name, /^[a-z0-9][a-z0-9-]*$/u,
          `${site.label} 里解析出「${name}」—— 它不像技能名，说明正则在表上抓歪了`);
      }
    }
    assert.ok(oss.names.includes(ONLY_PUBLIC),
      `tools/publish-oss.mjs 的 SKILLS_PUBLIC 里必须含今天那个会发布的技能 ${ONLY_PUBLIC}`
      + '（解析整个抓歪时这条先炸，免得两张表"同样地错"还判成一致）');

    // 出处（写进失败消息里，让人一眼知道该同时改哪两处）：文件 + 数组那一行（1-based）
    const where = `tools/publish-oss.mjs:${oss.line} 与 packaging/assemble-package.ps1:${zip.line}`;
    const sideOf = (names: string[]): string => [...new Set(names)].sort().join('、') || '（空）';
    const onlyIn = (a: string[], b: string[]): string[] => {
      const inB = new Set(b);
      return [...new Set(a)].filter((n) => !inB.has(n)).sort();
    };

    const pub = new Set(oss.names);
    const inZip = new Set(zip.names);
    const diff: string[] = [];
    const pubOnly = onlyIn(oss.names, zip.names);
    const zipOnly = onlyIn(zip.names, oss.names);
    if (pubOnly.length > 0) {
      diff.push(`  · 公开仓库那边多了：${pubOnly.join('、')} —— 它会同步进公开副本，但不会进 zip 包`
        + `（packaging/assemble-package.ps1:${zip.line} 的 $SkillsWhitelist 里没有它）`);
    }
    if (zipOnly.length > 0) {
      diff.push(`  · zip 包那边多了：${zipOnly.join('、')} —— 它会进每个人的包，但不会同步进公开仓库`
        + `（tools/publish-oss.mjs:${oss.line} 的 SKILLS_PUBLIC 里没有它）`);
    }
    assert.deepEqual(diff, [],
      '要公开必须两处都登记（两张表的**集合**必须相等）：\n'
      + `${diff.join('\n')}\n`
      + `  该同时改这两处：${where}\n`
      + `  tools/publish-oss.mjs 的 SKILLS_PUBLIC（管公开仓库同步）        = [${sideOf(oss.names)}]\n`
      + `  packaging/assemble-package.ps1 的 $SkillsWhitelist（管 zip 包）= @(${sideOf(zip.names)})`);

    // 集合相等 = 互相没有对方多出来的名字 + 个数相同（数量对上就不存在"同名重复登记"糊过去的情形）
    assert.deepEqual(pubOnly, [], `两张白名单必须一致：${where}`);
    assert.deepEqual(zipOnly, [], `两张白名单必须一致：${where}`);
    assert.equal(pub.size, inZip.size, `两张白名单的元素个数必须相同：${where}`);
  });
});
