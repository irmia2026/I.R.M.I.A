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
 * 八组断言
 * ════════════════════════════════════════════════════════════════════════════════
 *   1. **扫描面真的解析出来了**：不是空集、不多不少地等于"会外发"那一批
 *      （`config.json` / `docs/**` / `packaging/**` / 那两份闸门脚本自己**不在**里面，
 *      而 `README.md` / `skills/office/**` / `test/**` **在**里面）；
 *   2. **闸门本体**：ships 集里未白名单的命中必须是 0 —— **这一条今天会红**，见下；
 *   3. **读数自洽**：`扫了 N` 必须真的等于"候选 − 二进制 − 读不到"，
 *      且退出码与 ok 一致（一个永远返回 0 的闸门看起来和"通过"一模一样）；
 *   4. **白名单卫生**：每一条都真的被命中过（死条目 = 债），且条数对得上；
 *   5. **闸门自己有牙**：`--self-test` 要真命中样本、真放过无害行（模式写坏 = 静默失效）；
 *   6. **表是现读的、不是写死的**：技能白名单与"独立从源码解析一遍"的结果必须逐字相等；
 *   7. **词表缺失 ⇒ 工具红**：私有词表 2026-10-23 搬出了仓库（`IRMIA_PRIVATE_WORDS` /
 *      仓库同级 `_private/private-words.json`）。读不到 ⇒ exit 2、`ok:false`，
 *      **不许**退化成"没有词表 ⇒ 没命中 ⇒ 通过"（那是闸门最坏的失败形状）；
 *   8. **词表在位 ⇒ 正常**：环境变量指到哪份就读哪份（现场造一份合成词表验这条），
 *      且缺省那份在本机必须在位；另钉一条 **"词表不许回到仓库里"** 的不变量。
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * 为什么第 2 组**现在**是红的（这是它正常工作的证明，不是坏掉）
 * ════════════════════════════════════════════════════════════════════════════════
 * 仓库里**确实**有会外发、但带着真实身份信息的文件，而且它们全在 `src/**` 与 `test/**`
 * ——而这两棵树都在 tools/publish-oss.mjs 的 SYNC_ROOTS 里 ⇒ 它们**会**同步进公开仓库：
 *   · `test/onebot.test.ts` 把 config.json 里那把**真实 OneBot WS token** 抄成了夹具；
 *   · `test/onebot-private-refer.test.ts` 用了**真实群号**；
 *   · 用户的真实 QQ openid 与真实群 openid 在 12 个 `src/**`、`test/**` 文件里当夹具用。
 * 既有两道闸门为什么没拦住：词表（**仓库外**那份）收的是"某个具体的词"（人名、路径），
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
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(REPO, 'tools', 'sanitize-audit.mjs');
const PUBLISH = join(REPO, 'tools', 'publish-oss.mjs');
const ASSEMBLE = join(REPO, 'packaging', 'assemble-package.ps1');

/** 私有词表的位置变量（仓库外；见 docs/sanitize-audit.md §2.2） */
const WORDS_ENV = 'IRMIA_PRIVATE_WORDS';
/** 词表**不许**再回到仓库里（它一回来就等于真名回到仓库里） */
const WORDS_IN_REPO = join('tools', 'private-words.json');

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

function run(args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
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

/** 本机有没有 pwsh（package-gate 的 fail-closed 那条用例要用；没有就跳过那半条） */
let pwshOk: boolean | null = null;
function hasPwsh(): boolean {
  if (pwshOk === null) {
    const r = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    pwshOk = r.status === 0;
  }
  return pwshOk;
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
    // `ARCHITECTURE.md` 2026-10-23 归位到 `docs/ARCHITECTURE.md`：它仍在 ships 里（KEEP 那一条把它
    // 从 `docs/**` 的排除里单拎出来）。这条断言盯的是"那份对外架构文档**还在发**"——位置换了，
    // 判据没换；要是哪天有人把 KEEP 那行删了，它会当场红（那是真事故：公开仓库里就没有架构说明了）。
    for (const p of ['package.json', 'src/main.ts', 'gui/lib/app.dart', 'docs/ARCHITECTURE.md']) {
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
      // 词表本体 2026-10-23 搬出仓库（`IRMIA_PRIVATE_WORDS` / 仓库同级 `_private/`）⇒ 它现在
      // 既不在 ships 集里、也不该在仓库里。**"不在仓库里"**由下面第 8 组那条不变量专门钉着；
      // 这里只剩"它不会外发"（排除表里那条排除已降级成兜底，见 publish-oss.mjs 的注释）。
      ['tools/private-words.json', '词表已搬出仓库（万一被放回来，排除表那条兜底也不外发它）'],
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
    // 这条钉的是"两个口径真的不同"：全仓口径要含 docs/**、packaging/** 这些
    // **写着本机路径与真名、但一个字节都不会外发**的东西；而且它**故意**不因为命中而失败
    // —— 它是报表，不是门（拿报表当门，就会逼人把 `--scope` 用成 `--scope ships`，
    //    于是那份"全仓有多少敏感面"的读数再也没人看）。
    const r = run(['--scope', 'repo', '--json']);
    const a = parseJson<Audit>(r, 'sanitize-audit --scope repo --json');
    assert.equal(a.scope, 'repo');
    assert.ok(a.files.some((f) => f.startsWith('docs/')),
      '全仓口径要含 docs/**（设计文档里写着本机路径与真值，是仓里最该被看见的一批）');
    // 第二个例子原先钉的是 `_research/**`。2026-10-23 它整个移出了仓库（历史分析工作台产物：
    // 探针/补丁脚本与含真实会话的转储，判据与 `data/` 同一条——"某台机器上这一刻是什么"），
    // 于是那条断言的前提消失了，换成 `packaging/**`：它随仓库走，却不在同步范围里（出包脚手架，
    // 见 publish-oss.mjs 的排除表），同样**只**出现在全仓口径里。判据强度不变。
    assert.ok(a.files.some((f) => f.startsWith('packaging/')),
      '全仓口径要含 packaging/**（出包脚手架，不在同步范围里）');
    // 词表本体 2026-10-23 也搬出了仓库 ⇒ 全仓口径里**不该**再有它（第 8 组钉着"不许回来"）。
    assert.ok(!a.files.includes('tools/private-words.json'),
      '词表本体已经搬出仓库，全仓口径里不该再有它 —— 它回来就等于真名回到仓库里');
    assert.equal(r.code, 0, '报表口径不改退出码 —— 它是给人看的读数，不是门');
    assert.ok(a.files.length > auditOf().files.length,
      '全仓口径的分子必须大于 ships 口径（否则两个口径根本没分开）');
  });

  test('词表缺失 ⇒ 工具红（fail-closed：宁可红，不许把"没判据"当成"通过"）', () => {
    // 私有词表 2026-10-23 搬出仓库：它读不到不再是一件"不会发生的事"。
    // 这条用例走**环境变量指到一个肯定不存在的路径**，与这台机器上词表在不在无关。
    const missing = join(tmpdir(), `irmia-words-absent-${process.pid}-${Date.now()}`, 'private-words.json');
    assert.ok(!existsSync(missing), `这条用例需要一个肯定不存在的路径，实际存在：${missing}`);

    const r = run(['--json'], { [WORDS_ENV]: missing });
    assert.equal(r.code, 2,
      `词表读不到时必须 exit 2（判据没法应用），实际 ${r.code}。`
      + '  如果它是 0，说明闸门把"没有词表"当成了"没有命中" —— 那是闸门最坏的失败形状。'
      + `\n${r.stdout}\n${r.stderr}`);
    const j = parseJson<{ ok: boolean; error?: string }>(r, 'sanitize-audit --json（词表缺失）');
    assert.equal(j.ok, false, '词表缺失时 ok 必须为 false');
    assert.match(String(j.error), /私有词表缺失/u, `报错要直接点名"私有词表缺失"，实际：${j.error}`);
    assert.match(String(j.error), /它不在仓库里了/u, `报错要说清它已搬出仓库，实际：${j.error}`);

    // `--self-test` 走同一个 loadPipeline ⇒ 也必须 fail-closed（自检自己不能变成"静默绿"）
    const st = run(['--self-test', '--json'], { [WORDS_ENV]: missing });
    const sj = parseJson<{ ok: boolean; error?: string }>(st, 'sanitize-audit --self-test --json（词表缺失）');
    assert.equal(st.code, 2, `自检在词表缺失时也必须 exit 2，实际 ${st.code}：\n${st.stdout}\n${st.stderr}`);
    assert.equal(sj.ok, false, '自检在词表缺失时 ok 必须为 false');
    assert.match(String(sj.error), /私有词表缺失/u, `自检报错同样要点名，实际：${sj.error}`);

    // 另外两个读者跟的是**同一条规则**（三处各自推一遍缺省，见 docs/sanitize-audit.md §2.2）：
    //   · publish-oss.mjs ⇒ exit 3，且**一个字节都不写**（它在第 0 步就读词表，早于同步）；
    //   · package-gate.ps1 ⇒ exit 3（用法/路径错那一档）。
    if (existsSync(PUBLISH)) {
      const p = spawnSync(process.execPath, [PUBLISH, '--dry'], {
        cwd: REPO, encoding: 'utf8', env: { ...process.env, [WORDS_ENV]: missing },
      });
      assert.equal(p.status, 3,
        `publish-oss 在词表缺失时必须 exit 3（fail-closed，不许当成"没命中"），实际 ${p.status}：`
        + `\n${p.stdout}\n${p.stderr}`);
      assert.match(`${p.stdout}${p.stderr}`, /私有词表缺失/u, 'publish-oss 的报错要点名"私有词表缺失"');
    }
    if (hasPwsh()) {
      const g = spawnSync('pwsh', ['-NoProfile', '-File', join(REPO, 'tools', 'package-gate.ps1'), '-ListOnly'], {
        cwd: REPO, encoding: 'utf8', env: { ...process.env, [WORDS_ENV]: missing },
      });
      assert.equal(g.status, 3,
        `package-gate 在词表缺失时必须 exit 3（fail-closed），实际 ${g.status}：\n${g.stdout}\n${g.stderr}`);
      assert.match(`${g.stdout}${g.stderr}`, /私有词表缺失/u, 'package-gate 的报错要点名"私有词表缺失"');
    }
  });

  test('词表在位 ⇒ 正常：指到哪份就读哪份；且词表不许回到仓库里', () => {
    // ① 环境变量指到一份**合成**词表 ⇒ 闸门照常跑，读到的就是那一份（不是缺省那份）。
    //    合成词表里刻意只有一个不对应任何真实内容的词：这条用例只验"读取路径"，不验词。
    const dir = mkdtempSync(join(tmpdir(), 'irmia-words-synth-'));
    try {
      const wordsPath = join(dir, 'private-words.json');
      writeFileSync(wordsPath, `${JSON.stringify({
        $comment: ['合成词表：只用于 test/sanitize.test.ts 验证"指到哪份就读哪份"'],
        words: [{ word: '合成用例词', level: 'fatal', scope: ['oss', 'package'], why: '用例现场造的合成词，不对应任何真实内容' }],
        forbiddenExtensions: [],
        forbiddenNames: [],
      }, null, 2)}\n`, 'utf8');

      const r = run(['--scope', 'repo', '--json'], { [WORDS_ENV]: wordsPath });
      assert.equal(r.code, 0, `合成词表在位时应当能跑（repo 口径不改退出码），实际 ${r.code}：\n${r.stderr}`);
      const a = parseJson<Audit>(r, 'sanitize-audit --scope repo --json（合成词表）');
      assert.equal(a.words.repo, 1,
        `读到的必须是环境变量指的那份（1 条），实际 ${a.words.repo} 条 ——`
        + ' 对不上说明环境变量没生效（那"换机器/换词表"这条路就是假的）');
      assert.equal(a.words.oss, 1, 'oss 档要按合成的 scope 过滤出来');
      assert.equal(a.words.package, 1, 'package 档同上');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // ② 缺省那份（不设环境变量）也必须在本机在位 —— 那是跑闸门的常态，读不到就是这台机器的布置问题。
    const a = auditOf();
    assert.ok(a.words.repo > 0,
      '缺省词表读不到：请把它放到仓库同级的 _private/private-words.json，或设 IRMIA_PRIVATE_WORDS'
      + '（见 docs/sanitize-audit.md §2.2）');

    // ③ 不变量：**词表不许回到仓库里**。它一旦被加回跟踪列表，就等于真名回到仓库里了 ——
    //    这条红比闸门任何一条红都硬。
    assert.ok(!existsSync(join(REPO, WORDS_IN_REPO)),
      `词表又出现在仓库里了：${WORDS_IN_REPO} —— 它必须留在仓库外（IRMIA_PRIVATE_WORDS / 同级 _private/）`);
    const ls = spawnSync('git', ['-c', 'core.quotePath=false', 'ls-files', '--', WORDS_IN_REPO], {
      cwd: REPO, encoding: 'utf8',
    });
    assert.equal((ls.stdout ?? '').trim(), '',
      `${WORDS_IN_REPO} 又被 git 跟踪了 —— 那就是"真名还在仓库里"`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 路径类词条：**两种斜杠都认**（2026-10-23 补的洞）
//
// 洞的形状：词表里那条"打包/交付现场"路径词的 match 只认反斜杠 ⇒ `deploy/site/` 里 6 处
// 正斜杠写法（RELEASES.md 4 处 + publish-release.sh 2 处）一处都扫不到，闸门还是绿的。
// 三条闸门（本工具的 scan、package-gate、publish-oss）现在都做"路径类词条两种斜杠都试"。
//
// 用例为什么**不在源码里写死那条路径**：`test/**` 本身会同步进公开副本，把要拦的值抄一遍
// 等于闸门自己制造泄漏（本文件开头的纪律）。所以样本一律**现场从私有词表拼出来**：
// 词表里有哪几条路径词，就验哪几条 × 两种斜杠。
// ════════════════════════════════════════════════════════════════════════════

/** 私有词表里"路径类"的词条（word 里带反斜杠）—— 从词表现读，不在测试里写死任何本机路径 */
function pathWords(): { word: string; match?: string }[] | null {
  const fromEnv = (process.env[WORDS_ENV] ?? '').trim();
  const wordsPath = fromEnv === '' ? join(REPO, '..', '_private', 'private-words.json') : resolve(fromEnv);
  if (!existsSync(wordsPath)) return null;
  const data = JSON.parse(readFileSync(wordsPath, 'utf8')) as { words?: { word?: string; match?: string }[] };
  return (data.words ?? []).filter((w): w is { word: string; match?: string } => (
    typeof w.word === 'string' && w.word.includes('\\')
  ));
}

/**
 * 同一处内容的两种写法：`<词>\probe` 与 `<词>/probe`。
 * 词条本身以分隔符结尾时（词表里那条用户目录词就是这样）照样拼：两种写法都仍然是一条合法路径。
 */
function twoSlashes(word: string): { raw: string; slash: string } {
  return { raw: `${word}\\probe`, slash: `${word.replace(/\\/gu, '/')}/probe` };
}

describe('路径类词条：两种斜杠都认（正斜杠盲区）', () => {
  test('sanitize-audit --self-test：自检里钉着"路径词两种斜杠都命中"（每条 × 2 种写法）', {
    skip: HAS_TOOL ? false : '仓库里没有 tools/sanitize-audit.mjs',
  }, () => {
    const r = run(['--self-test', '--json']);
    const self = parseJson<{
      ok: boolean; checks: number; checked: { name: string; detail?: string }[]; failures: string[];
    }>(r, 'sanitize-audit --self-test --json');
    assert.equal(r.code, 0, `自检不通过：${self.failures.join('；')}`);
    const check = self.checked.find((c) => c.name === '路径词两种斜杠都命中');
    assert.ok(check !== undefined,
      '自检里必须有这一条 —— 少了它，正斜杠盲区就没有回归门。'
      + `今天跑过的：${self.checked.map((c) => c.name).join(' / ')}`);
    assert.match(String(check.detail), /^\d+ 条路径词 × 2 种斜杠$/u,
      `自检要真的对每条路径词试了两种斜杠（读数：${check.detail}）—— 读数是 0 条就等于没验`);
  });

  test('package-gate：反斜杠写法与正斜杠写法都命中，"同前缀但不是一条路径"的不误拦', {
    skip: hasPwsh() ? false : '本机没有 pwsh（package-gate 是 PowerShell 脚本）',
  }, (t) => {
    const words = pathWords();
    if (words === null) {
      t.skip('读不到私有词表 —— 闸门自己会 fail-closed（exit 3），这条用例没有判据可验');
      return;
    }
    assert.ok(words.length > 0, '词表里一条路径类词条都没有 —— 这条用例会变成空话');

    const dir = mkdtempSync(join(tmpdir(), 'irmia-gate-slash-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    // 正样本：每条路径词 × 两种斜杠，一行一处
    const raws = words.map((w) => twoSlashes(w.word).raw);
    const slashes = words.map((w) => twoSlashes(w.word).slash);
    // 反样本：**同前缀、但后面不是分隔符**（词表 why 里那个"给使用者的示例目录"就是这个形状）。
    // 只对带 match 的词成立：不带 match 的词是字面量子串匹配，加个后缀本来就该命中。
    const decoys = words.filter((w) => w.match !== undefined).flatMap((w) => {
      const stem = w.word.replace(/[\\/]+$/u, '');
      return [`${stem}Agent`, `${stem.replace(/\\/gu, '/')}Agent`];
    });
    const lines = [...raws, ...slashes, ...decoys];
    writeFileSync(join(dir, 'probe.md'), `${lines.join('\n')}\n`, 'utf8');

    const g = spawnSync('pwsh', [
      '-NoProfile', '-File', join(REPO, 'tools', 'package-gate.ps1'), '-Path', dir, '-Scope', 'oss',
    ], { cwd: REPO, encoding: 'utf8' });
    const out = `${g.stdout}${g.stderr}`;

    const want = raws.length + slashes.length;
    assert.equal(g.status, 2, `两种写法都必须被拦下（期望 exit 2，实际 ${g.status}）：\n${out}`);
    assert.match(out, new RegExp(`命中 ${want} 处`, 'u'),
      `应当恰好 ${want} 处命中（${words.length} 条路径词 × 2 种斜杠）：\n${out}`);
    for (let i = 1; i <= want; i += 1) {
      assert.match(out, new RegExp(`行 ${i}\\s`, 'u'),
        `第 ${i} 行的写法必须被报出来（两种斜杠里漏一种就是那个洞）：\n${out}`);
    }
    for (let i = want + 1; i <= lines.length; i += 1) {
      assert.doesNotMatch(out, new RegExp(`行 ${i}\\s`, 'u'),
        `第 ${i} 行是反样本（同前缀但不是一条路径），不该被拦 —— 误拦会把真命中淹掉：\n${out}`);
    }
  });

  test('publish-oss：同一个词的反斜杠写法与正斜杠写法都命中（产物闸门，扫的是公开副本）', {
    skip: existsSync(PUBLISH) ? false : '公开副本里没有 tools/publish-oss.mjs（它不外发）—— 这条判据只在仓库侧跑',
  }, (t) => {
    const words = pathWords();
    if (words === null) {
      t.skip('读不到私有词表 —— publish-oss 在缺词表时 exit 3（fail-closed），这条用例没有判据可验');
      return;
    }
    assert.ok(words.length > 0, '词表里一条路径类词条都没有 —— 这条用例会变成空话');

    // 空的临时公开副本（git init）⇒ 第 2 步会把仓库侧该发的文件同步进去，第 4 步再整棵扫一遍。
    // 两个探针文件直接放在副本里（未跟踪也会被扫）：一个只写反斜杠形，一个只写正斜杠形。
    const oss = mkdtempSync(join(tmpdir(), 'irmia-oss-slash-'));
    t.after(() => rmSync(oss, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: oss, stdio: 'ignore' });
    const samples = words.map((w) => twoSlashes(w.word));
    writeFileSync(join(oss, 'leak-backslash.md'), `${samples.map((s) => s.raw).join('\n')}\n`, 'utf8');
    writeFileSync(join(oss, 'leak-forward.md'), `${samples.map((s) => s.slash).join('\n')}\n`, 'utf8');

    const r = spawnSync(process.execPath, [
      PUBLISH, '--oss', oss, '--skip-config', '--allow-dirty',
    ], { cwd: REPO, encoding: 'utf8' });
    const out = `${r.stdout}${r.stderr}`;

    assert.equal(r.status, 2, `命中私有词时发布闸门必须 exit 2（实际 ${r.status}）：\n${out}`);
    for (const rel of ['leak-backslash.md', 'leak-forward.md']) {
      assert.match(out, new RegExp(`${rel}\\s+\\[`, 'u'),
        `${rel} 的命中必须报出来（两种斜杠各一处；漏一种就是那个洞）：\n${out}`);
    }
    for (const w of words) {
      assert.ok(out.includes(`[${w.word}]`), `报出来的词条必须是词表里那一条（${w.word}）：\n${out}`);
    }
  });
});
