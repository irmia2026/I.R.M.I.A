/**
 * 脱敏闸门：**会进包 / 会进公开副本的那批文件**里，不许有未白名单的敏感面命中。
 *
 * 这份文件盯的是 tools/sanitize-audit.mjs 那条闸门。它与仓库里既有的两条"产物闸门"
 * （tools/package-gate.ps1 扫装配好的包、tools/publish-oss.mjs 扫同步完的公开副本）
 * 是**互补**关系，不是重复：那两条扫的是"已经写出去的产物"，而这条扫的是**源头**——
 * 在同步/装配之前就把"会外发的那批文件"清一遍，专盯那两条**覆盖不到**的敏感面
 * （凭据形状、QQ openid/群号、从 config.json 现读的本机真值）。分工的来由写在
 * tools/sanitize-audit.mjs 的文件头里。
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * 六组断言
 * ════════════════════════════════════════════════════════════════════════════════
 *   1. **扫描面真的解析出来了**：不是空集、不多不少地等于"会外发"那一批
 *      （`config.json` / `docs/**` / `_research/**` / 那两份闸门脚本自己**不在**里面，
 *      而 `README.md` / `skills/office/**` / `test/**` **在**里面）；
 *   2. **闸门本体**：ships 集里未白名单的命中必须是 0 —— **这一条今天会红**，见下；
 *   3. **读数自洽**：`扫了 N` 必须真的等于"候选 − 二进制 − 读不到"，
 *      且退出码与 ok 一致（一个永远返回 0 的闸门看起来和"通过"一模一样）；
 *   4. **白名单卫生**：每一条都真的被命中过（死条目 = 债），且条数对得上；
 *   5. **闸门自己有牙**：`--self-test` 要真命中样本、真放过无害行（模式写坏 = 静默失效）；
 *   6. **表是现读的、不是写死的**：技能白名单与"独立从源码解析一遍"的结果必须逐字相等。
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * 为什么第 2 组**现在**是红的（这是它正常工作的证明，不是坏掉）
 * ════════════════════════════════════════════════════════════════════════════════
 * 仓库里**确实**有会外发、但带着真实身份信息的文件，而且它们全在 `src/**` 与 `test/**`
 * ——而这两棵树都在 tools/publish-oss.mjs 的 SYNC_ROOTS 里 ⇒ 它们**会**同步进公开仓库：
 *   · `test/onebot.test.ts` 把 config.json 里那把**真实 OneBot WS token** 抄成了夹具；
 *   · `test/onebot-private-refer.test.ts` 用了**真实群号**；
 *   · 用户的真实 QQ openid 与真实群 openid 在 12 个 `src/**`、`test/**` 文件里当夹具用。
 * 既有两道闸门为什么没拦住：词表 private-words.json 收的是"某个具体的词"（人名、路径），
 * 而 token 是随机的、openid 是 32 位十六进制 —— 词表里一条都没有对应条目，规则表也不换它们。
 * 所以这条闸门落地时**就该是红的**：红 = 它真的看见了那几处泄漏。绿的条件只有一个 ——
 * 把那几处真值换成占位符（`docs/sanitize-audit.md` 里列着逐条 old→new）。
 *
 * ⚠️ **不许**为了让这条用例变绿而往 WHITELIST 加真值的条目：白名单只收"说明性提及"与
 * "自造夹具"两类，（自检里第 ③ 组专门钉了"不许给 config-value 开后门"）。加真值条目
 * = 直接宣布"本机凭据可以出现在公开面"。
 *
 * 怎么跑才不脆（与 test/publish-oss-skills.test.ts 同一套做法）：
 *   · 一律**起子进程**读 `--json` 那一行，不 import 那个模块 —— 于是 TS 这边不需要那个
 *     .mjs 的类型声明，也不会把"跑一段有 IO 的代码"混进类型检查；
 *   · 公开副本里没有 tools/publish-oss.mjs、也没有 packaging/assemble-package.ps1
 *     ⇒ "会外发哪些文件"无从判定，整组跳过（那条判据只在仓库侧跑得起来）。
 *
 * 测试文件里刻意**不写**任何真实 id / token / 人名：`test/**` 本身也是要同步进公开副本的
 * 东西，在测试里把要拦的值抄一遍，等于闸门自己制造泄漏。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(REPO, 'tools', 'sanitize-audit.mjs');
const PUBLISH = join(REPO, 'tools', 'publish-oss.mjs');
const ASSEMBLE = join(REPO, 'packaging', 'assemble-package.ps1');

const HAS_TOOL = existsSync(TOOL);
/** 两条出口的表都读不到 ⇒ "会外发哪些文件"没法判定（公开副本里就是这种情形） */
const CAN_RESOLVE = existsSync(PUBLISH) || existsSync(ASSEMBLE);

interface Hit {
  id: string;
  rel: string;
  line: number;
  masked: string;
}

interface Pipeline {
  syncRoots: number;
  excludes: number;
  ossOwn: number;
  skillsPublic: string[];
  sanitizeRules: number;
  skillsWhitelist: string[];
  payloadFiles: string[];
  hasPublish: boolean;
  hasAssemble: boolean;
}

interface Audit {
  ok: boolean;
  scope: string;
  candidates: number;
  scannedFiles: number;
  binarySkipped: number;
  missing: number;
  totalHits: number;
  whitelistedHits: number;
  whitelistEntries: number;
  whitelistUsed: number;
  staleWhitelist: number;
  words: { oss: number; package: number; repo: number };
  pipeline: Pipeline;
  inventoryCount: number;
  inventoryReason: string | null;
  files: string[];
  scopeOf: Record<string, string>;
  hits: Hit[];
  whitelisted: Hit[];
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Run {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: REPO, encoding: 'utf8' });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * 读 `--json` 那一行。
 * 契约与 tools/publish-oss.mjs 的 `--skills-check --json` 一致：**stdout 上只有一行 JSON**，
 * 别的什么都不许混进来（报表和机器可读输出混在一条流里，测试就只能靠猜）。
 */
function parseJson<T>(r: Run, what: string): T {
  const lines = r.stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '');
  assert.equal(lines.length, 1, `${what} 只该输出一行 JSON，实际 ${lines.length} 行：\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(lines[0] ?? '{}') as T;
}

function auditOf(args: string[] = ['--json']): Audit {
  return parseJson<Audit>(run(args), `sanitize-audit ${args.join(' ')}`);
}

/** 把命中压成"互不相同的值 → 出现在哪几个文件"，红的时候一眼知道要改几个决定。 */
function summarize(hits: Hit[]): string {
  const byValue = new Map<string, Hit[]>();
  for (const h of hits) byValue.set(h.masked, [...(byValue.get(h.masked) ?? []), h]);
  return [...byValue.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([masked, list]) => {
      const where = [...new Set(list.map((h) => `${h.rel}:${h.line}`))];
      return `  · ${masked}  [${list[0]?.id ?? '?'}]  ${list.length} 处 —— ${where.slice(0, 4).join(', ')}`
        + `${where.length > 4 ? ` …（还有 ${where.length - 4} 处）` : ''}`;
    })
    .join('\n');
}

/** 独立解析 tools/publish-oss.mjs 的 SKILLS_PUBLIC（与第 6 组对账用，不 import 它） */
function skillsPublicFromSource(): string[] {
  const src = readFileSync(PUBLISH, 'utf8');
  const hit = /const\s+SKILLS_PUBLIC\s*=\s*\[([^\]\n]*(?:\n[^\]\n]*)*)\]/u.exec(src);
  const names: string[] = [];
  for (const token of (hit?.[1] ?? '').replace(/\/\/[^\n]*/gu, '').split(',')) {
    const lit = /^\s*['"]([^'"]*)['"]\s*$/u.exec(token);
    if (lit?.[1]) names.push(lit[1]);
  }
  return names.sort();
}

describe('脱敏闸门（会进包 / 会进公开副本的那批文件）', {
  skip: !HAS_TOOL
    ? '仓库里没有 tools/sanitize-audit.mjs'
    : !CAN_RESOLVE
      ? '读不到 tools/publish-oss.mjs 与 packaging/assemble-package.ps1（公开副本里两者都没有）'
        + ' —— "会外发哪些文件"无从判定，这条判据只在仓库侧跑'
      : false,
}, () => {
  test('扫描面：解析出来的就是"会外发"那一批（不是空集，也不多不少）', () => {
    const a = auditOf();
    assert.equal(a.scope, 'ships');
    assert.equal(a.ok && a.totalHits !== 0, false, 'ok 必须与 totalHits 一致');

    // ① 分母够大 ⇒ 下面的断言不是空话（今天 ~470 个文件；留余量到 300 免得文件数正常波动就红）
    assert.ok(a.scannedFiles > 300,
      `会外发的文件只扫到 ${a.scannedFiles} 个 —— 分母太小说明 ships 集没解析出来，`
      + '"通过"会是假象（闸门最坏的失败形状：静默空集）');
    assert.equal(a.scannedFiles + a.binarySkipped + a.missing, a.files.length,
      '扫到的 + 二进制跳过的 + 读不到的，必须正好等于候选 —— 否则有文件被静默漏掉了');

    // ② 两个出口都必须参与：只有一边参与时，"少了另一边"是看不出来的
    assert.ok(a.pipeline.hasPublish && a.pipeline.hasAssemble,
      '两条出口（公开副本 / 便携包）的表都得读到，否则扫描面缺一半');
    const scopes = new Set(Object.values(a.scopeOf));
    assert.ok(scopes.has('oss'), '扫描面里必须有"只进公开副本"的文件');
    assert.ok(scopes.has('package'), '扫描面里必须有"只进便携包"的文件');
    assert.equal(Object.keys(a.scopeOf).length, a.files.length, '每个文件都要有归宿');

    // ③ **在**里面的：这三棵树要么进公开副本、要么进包
    const inShips = (p: string): boolean => a.files.includes(p);
    for (const p of ['package.json', 'src/main.ts', 'gui/lib/app.dart', 'ARCHITECTURE.md']) {
      assert.ok(inShips(p), `${p} 会外发（在同步范围里），扫描面里必须有它`);
    }
    assert.ok(a.files.some((f) => /^skills\/office\//u.test(f)),
      '白名单技能 skills/office 会随包与公开副本发出去，必须被扫');
    assert.ok(a.files.some((f) => /^test\/.+\.test\.ts$/u.test(f)),
      'test/** 会同步进公开副本（它在 publish-oss.mjs 的 SYNC_ROOTS 里），必须被扫');

    // ④ **不在**里面的：这几份写着一堆本机路径/真名，但它们一个字节都不会外发 ——
    //    把它们扫进来只会制造假命中，而假命中会把真命中淹掉。
    for (const [p, why] of [
      ['config.json', '本机配置（排除表）'],
      ['docs/design.md', '设计文档不开源（docs/** 整棵在排除表里）'],
      ['tools/private-words.json', '词表本体（排除表）'],
      ['tools/publish-oss.mjs', '发布脚本本体（排除表）'],
      ['packaging/assemble-package.ps1', '出包脚手架，不在 $PayloadFiles 里'],
      // OSS_OWN 那一档：公开副本里是**另一个版本**，脚本第 2 步显式跳过、不覆盖仓库这份。
      // 所以仓库这份写了什么都不出去 —— 仓库版 README.md 与 brand/README.md 就写着本机路径与真名，
      // 把它们扫进来只会制造假命中（假命中会把真命中淹掉）。
      ['README.md', '公开副本自有（OSS_OWN）：仓库这份不会被覆盖过去'],
      ['brand/README.md', '同上：公开副本里是英文版，仓库这份写着本机 Python 绝对路径'],
    ] as [string, string][]) {
      assert.ok(!inShips(p), `${p} 不会外发（${why}），不该出现在扫描面里`);
    }
    assert.ok(!a.files.some((f) => f.startsWith('_research/')), '_research/** 在排除表里，不会外发');
  });

  test('闸门：ships 集里没有未白名单的敏感面命中', () => {
    const a = auditOf();
    assert.equal(a.totalHits, 0,
      `会外发的文件里有 ${a.totalHits} 处未白名单的命中 —— 这批内容今天不许发：\n`
      + `${summarize(a.hits)}\n\n`
      + '  怎么处置：把命中改成占位符（`<用户名>` / `<QQ 号>` / `123456789` 这类明显的假值）。\n'
      + '  确实属于"说明性提及 / 自造夹具"的，才往 tools/sanitize-audit.mjs 的 WHITELIST 加一条**带理由**的条目。\n'
      + '  ⚠️ 为了让这条变绿而删词/删模式/给真值加白名单 = 拆闸门。')
    ;
  });

  test('读数：退出码与 ok 一致，白名单没有死条目', () => {
    const a = auditOf();
    assert.ok(a.scannedFiles > 0, '至少要真读一个文件');
    assert.ok(a.words.oss > 0 && a.words.package > 0,
      '词表两档都得读出来（只读一档的话，另一档的泄漏就看不见）');
    assert.ok(a.pipeline.syncRoots > 0 && a.pipeline.excludes > 0,
      '公开副本那两张表得真的解析出来（解析成空集 ⇒ 判据失效，不能当成"没问题"）');
    assert.ok(a.pipeline.sanitizeRules > 0, '脱敏规则表得解析出来（否则会拿"未脱敏的草稿"去判，全是假命中）');

    // 白名单：条数对得上、且**一条死的都没有**（死条目是债：它让"白名单 K 条"这个读数虚高）
    assert.equal(a.whitelistUsed + a.staleWhitelist, a.whitelistEntries,
      '用上的 + 过期的 必须等于白名单总条数');
    assert.equal(a.staleWhitelist, 0,
      `有 ${a.staleWhitelist} 条白名单今天一处都没命中 —— 那是已经修掉或写歪的条目，删掉它，别留着让读数虚高`);
    assert.equal(a.whitelisted.length, a.whitelistedHits, '白名单放行的处数要对得上');
    for (const w of a.whitelisted) {
      assert.ok(w.id.length > 0 && w.rel.length > 0, '白名单放行的每一处都要有 id 与来源文件');
    }

    // 退出码：0 = 通过、1 = 有未白名单命中。这一条钉的是"闸门真的会影响退出码"——
    // 一个永远返回 0 的闸门，看起来和"通过"一模一样。
    const r = run(['--json']);
    assert.equal(r.code, a.ok ? 0 : 1,
      `退出码必须是 ${a.ok ? 0 : 1}（未白名单命中 ${a.totalHits} 处），实际 ${r.code}`);
  });

  test('闸门自己有牙：--self-test 真命中样本、真放过无害行', () => {
    const r = run(['--self-test', '--json']);
    const self = parseJson<{ ok: boolean; checks: number; checked: { name: string }[]; failures: string[] }>(
      r, 'sanitize-audit --self-test --json',
    );
    assert.equal(r.code, 0,
      `自检不通过（${self.failures.length} 条）：${self.failures.join('；')}\n`
      + '  自检查的是"模式还认得自己要拦的东西吗、白名单还守纪律吗、本文件自己能不能发出去"——'
      + '一条不过就说明闸门已经不可信了');
    assert.ok(self.ok, '自检的 ok 必须为真');
    // 6 条结构性模式各一条 + 无害样本 + 白名单纪律 + 脱敏规则 + 自己能不能发出去……
    assert.ok(self.checks >= 10, `自检只跑了 ${self.checks} 条 —— 少了就说明有模式/纪律没被验到`);
    assert.equal(self.checks, self.checked.length, '跑过的条数与报文要一致');
  });

  test('表是现读的、不是写死的（技能白名单与独立解析对账）', () => {
    const a = auditOf();
    // 独立在测试这边再解析一遍 tools/publish-oss.mjs 的表零，与闸门自己报的对比。
    // 两边不一致只有两种可能：闸门把名单写死了（漂移），或者解析歪了 —— 两种都要红。
    const fromSource = skillsPublicFromSource();
    assert.ok(fromSource.length > 0,
      '从 tools/publish-oss.mjs 的源码里没解析出 SKILLS_PUBLIC —— 表零没了或换了写法，先修解析');
    assert.deepEqual([...a.pipeline.skillsPublic].sort(), fromSource,
      '闸门报的技能白名单必须与 publish-oss.mjs 源码里的表零逐字一致：'
      + '不一致就说明闸门没有现读、而是留了第二份名单（那正是"两处漂移"的形状）');
    // 便携包那张表也得非空（包与公开副本两份名单的一致性由 test/publish-oss-skills.test.ts 盯）
    assert.ok(a.pipeline.skillsWhitelist.length > 0, '便携包的 $SkillsWhitelist 得读出来');
    assert.ok(a.pipeline.payloadFiles.length > 0, '便携包的自持件清单得读出来');
  });

  test('--scope repo 是报表口径：含全仓、但不改退出码', () => {
    // 这条钉的是"两个口径真的不同"：全仓口径要含 docs/**、_research/**、词表本体这些
    // **写着本机路径与真名、但一个字节都不会外发**的东西；而且它**故意**不因为命中而失败
    // —— 它是报表，不是门（拿报表当门，就会逼人把 `--scope` 用成 `--scope ships`，
    //    于是那份"全仓有多少敏感面"的读数再也没人看）。
    const r = run(['--scope', 'repo', '--json']);
    const a = parseJson<Audit>(r, 'sanitize-audit --scope repo --json');
    assert.equal(a.scope, 'repo');
    assert.ok(a.files.some((f) => f.startsWith('docs/')),
      '全仓口径要含 docs/**（设计文档里写着本机路径与真值，是仓里最该被看见的一批）');
    assert.ok(a.files.some((f) => f.startsWith('_research/')), '全仓口径要含 _research/**');
    assert.ok(a.files.includes('tools/private-words.json'), '全仓口径要含词表本体');
    assert.equal(r.code, 0, '报表口径不改退出码 —— 它是给人看的读数，不是门');
    assert.ok(a.files.length > auditOf().files.length,
      '全仓口径的分子必须大于 ships 口径（否则两个口径根本没分开）');
  });
});
