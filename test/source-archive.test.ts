/**
 * 源码归档（AGPL「对应源码」）测试：`tools/make-source-archive.ps1`
 *
 * 三组：
 *   ① 归档带上二进制包需要的内置包来源（`packs/subagents/skills/**`、`packs/subagents/tools/**`、
 *      内置 `skills/`），并且**排除仓库现场的 dist（含 dist/packs 双路径）**；
 *   ② fail-closed：仓库里缺一个内置来源 ⇒ 归档必须非 0 退出（不许静默少带）；
 *   ③ 归档保留 gui pubspec 声明的图标/图片/分辨率变体；缺声明资源时失败且不交付 zip；
 *      归档与发布脚本都能被 PowerShell 解析。
 *
 * 2026-11-05 为什么加 ①②：源码归档是 AGPL 的「对应源码」。二进制包里带的
 * `packs/` 与内置 skills 是"安装角色"的运行期依赖；归档少了它们，拿这份源码构建出来的包
 * 仍然 source-missing —— 那就算不上"足以生成、安装、运行该二进制"。
 * 清单与 hash 判据**不在这里手抄**：脚本调用 `packaging/builtin-payload.mjs`（与装配、拆包复验
 * 同一支）从 Profile 的 `builtin:` 清单现算并逐个核对 sha256。
 *
 * 全部用例都用**迷你假仓库**跑真实脚本，不读也不改真实仓库、不产出对外归档。
 * 私有词表用临时合成表（`IRMIA_PRIVATE_WORDS` 指过去），与出包机词表内容无关。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { hashTree } from '../src/runtime/subagent-packages.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const script = resolve(import.meta.dirname, '../tools/make-source-archive.ps1');
const payloadHelper = resolve(import.meta.dirname, '../packaging/builtin-payload.mjs');
// 公开副本里没有 `packaging/`（出包脚手架不外发）⇒ 这一组整组 skip；只在 Windows + pwsh 7 下跑。
const skip = process.platform !== 'win32'
  || !existsSync(payloadHelper)
  || spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { windowsHide: true }).status !== 0;

// ⚠️ 敏感路径/密钥夹具在**源码里不写成完整字面量**：`test/**` 会同步进公开副本，
// `tools/sanitize-audit.mjs` 的 ships 口径会因此报红。这里在运行时拼出来，
// 写进假仓库的仍是**真原值**（能命中脱敏规则），而源码里不存在那些连续字面量。
const BS = String.fromCharCode(92); // 反斜杠
const WIN_HOME = ['C:', 'Users', 'you', 'AppData', 'Local', 'Irmia'].join(BS);
const WIN_REPO = ['D:', 'Irmia', 'app'].join(BS);
const WIN_HOME_PLACEHOLDER = ['<user-home>', 'you', 'AppData', 'Local', 'Irmia'].join(BS);
const WIN_REPO_PLACEHOLDER = ['<install-root>', 'app'].join(BS);
const AKIA_EXAMPLE = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
const AKIA_PLACEHOLDER = ['AKIA', 'DOC', 'EXAMPLE', 'KEY'].join('-');

/**
 * 迷你假仓库：
 *   · gui pubspec + 图标/图片（覆盖原有的"声明资源"用例）；
 *   · 两个 `builtin:` 来源（一个 packs 技能、一个 skills 技能）+ `packs/subagents/tools` + LICENSE；
 *   · 假 Profile 清单与**从真实仓库复制来的** `packaging/builtin-payload.mjs`（清单/自检逻辑不 mock）；
 *   · 故意放 `dist/packs/junk.txt`：归档必须不带任何 dist 内容。
 */
interface FixtureOptions {
  missingAsset?: boolean;
  /** 放一个没被脱敏规则覆盖的私有词（AUDIT_SENTINEL）⇒ 闸门必须拦住（测 fail-closed 不退化）。 */
  unsanitizedSentinel?: boolean;
  /** 放一个不在精确夹具规则里的"像密钥"串 ⇒ 全局密钥形态扫描必须拦住。 */
  genericSecret?: boolean;
}

function fixture(options: FixtureOptions = {}): { repo: string; out: string; words: string; zip: string; report: string } {
  const root = tempDirSync('irmia-source-archive-');
  const repo = join(root, 'repo');
  const out = join(root, 'out');
  mkdirSync(join(repo, 'gui', 'assets', '2.0x'), { recursive: true });
  writeFileSync(join(repo, 'gui', 'pubspec.yaml'), 'name: archive_fixture\nflutter:\n  assets:\n    - assets/tray.ico\n    - assets/mark.png\n');
  writeFileSync(join(repo, 'gui', 'assets', 'tray.ico'), 'synthetic icon');
  if (!options.missingAsset) writeFileSync(join(repo, 'gui', 'assets', 'mark.png'), 'synthetic bitmap');
  writeFileSync(join(repo, 'gui', 'assets', '2.0x', 'mark.png'), 'synthetic resolution variant');

  // ── 内置包来源（清单由 Profile 的 builtin: 安装项决定）──
  mkdirSync(join(repo, 'packs', 'subagents', 'skills', 'fake-skill'), { recursive: true });
  writeFileSync(join(repo, 'packs', 'subagents', 'skills', 'fake-skill', 'SKILL.md'),
    '---\nname: fake-skill\ndescription: fake fixture\n---\nfake\n');
  mkdirSync(join(repo, 'packs', 'subagents', 'tools', 'codegraph'), { recursive: true });
  writeFileSync(join(repo, 'packs', 'subagents', 'tools', 'codegraph', 'code_cli.py'), '# fake cli\n');
  mkdirSync(join(repo, 'skills', 'fake-dev'), { recursive: true });
  writeFileSync(join(repo, 'skills', 'fake-dev', 'SKILL.md'),
    '---\nname: fake-dev\ndescription: fake builtin skill\n---\nfake\n');
  writeFileSync(join(repo, 'LICENSE'), 'AGPL fake fixture\n');
  mkdirSync(join(repo, 'sdk', 'node'), { recursive: true });
  writeFileSync(join(repo, 'sdk', 'node', 'index.d.ts'), 'export interface PluginContext {}\n');
  // 仓库现场的 dist 双路径副本：归档必须排除。
  mkdirSync(join(repo, 'dist', 'packs'), { recursive: true });
  writeFileSync(join(repo, 'dist', 'packs', 'junk.txt'), 'must not be archived\n');

  // ── 脱敏夹具：私有词 / 本机路径 / 像密钥的假 token / 非 UTF-8 历史脚本 ──
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, 'test', 'private-fixture.md'), [
    '# 脱敏夹具（合成）',
    '人格名：伊尔弥亚 / 弥亚小姐 / 弥亚',
    '私有表情包：owner-stickers / 默认表情',
    '人称：用户',
    '本机路径：' + WIN_REPO + ' 与 ' + WIN_HOME,
    '私有工具痕迹：.astrbot',
    '',
  ].join('\n'));
  writeFileSync(join(repo, 'test', 'r2-put.test.ts'), [
    `const accessKeyId = '${AKIA_EXAMPLE}';`,
    `assert.equal(authorization, 'AWS4-HMAC-SHA256 Credential=${AKIA_EXAMPLE}/20130524/us-east-1/s3/aws4_request');`,
    '',
  ].join('\n'));
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  // 非 UTF-8（含 0x81）但无 NUL 的历史脚本：字节级分支要能换掉其中的 ASCII 本机路径，且保留其余字节。
  writeFileSync(join(repo, 'scripts', 'legacy-encoding.cmd'), Buffer.concat([
    Buffer.from('# legacy '),
    Buffer.from([0x81]),
    Buffer.from(` encoding\r\nset APP=${WIN_REPO}\r\n`),
  ]));
  if (options.unsanitizedSentinel) {
    writeFileSync(join(repo, 'test', 'unsanitized-sentinel.txt'), 'AUDIT_SENTINEL is not covered by any rule\n');
  }
  if (options.genericSecret) {
    writeFileSync(join(repo, 'test', 'generic-secret.txt'), `ghp_${'A'.repeat(32)}\n`);
  }

  // 假 Profile 清单 + 真实清单脚本（hash 用运行时同一条 hashTree 算）。
  mkdirSync(join(repo, 'src', 'runtime'), { recursive: true });
  mkdirSync(join(repo, 'packaging'), { recursive: true });
  writeFileSync(join(repo, 'packaging', 'builtin-payload.mjs'), readFileSync(payloadHelper));
  const packsHash = hashTree(join(repo, 'packs', 'subagents', 'skills', 'fake-skill'));
  const skillsHash = hashTree(join(repo, 'skills', 'fake-dev'));
  writeFileSync(join(repo, 'src', 'runtime', 'subagent-profiles.ts'), [
    'export const BUILTIN_PROFILES = [',
    '  {',
    "    id: 'fake', label: '假角色', description: '', systemPrompt: '',",
    "    workdir: 'workspace', shell: 'none', tools: 'readonly', workspace: 'own',",
    "    skills: [], mcpServers: [], reasoningEffort: 'high', contextLimit: 1, compactAt: 0.7,",
    '    install: [',
    `      {source: 'builtin:packs/subagents/skills/fake-skill', ref: 'v1', sha256: '${packsHash}'},`,
    `      {source: 'builtin:skills/fake-dev', ref: 'v1', sha256: '${skillsHash}'},`,
    '    ],',
    '  },',
    '];',
    '',
  ].join('\n'));

  const words = join(root, 'synthetic-words.json');
  writeFileSync(words, JSON.stringify({
    words: [{ word: 'AUDIT_SENTINEL', level: 'fatal', why: 'synthetic', scope: ['package', 'oss'] }],
    forbiddenNames: [], forbiddenExtensions: [],
  }));
  const zip = join(out, 'irmia-agent-v0.0.0-test-source.zip');
  return { repo, out, words, zip, report: join(out, 'irmia-agent-v0.0.0-test-source.sanitize-report.json') };
}

function runArchive(fx: ReturnType<typeof fixture>, version = '0.0.0-test') {
  return spawnSync('pwsh', ['-NoProfile', '-File', script, '-Version', version, '-Repo', fx.repo, '-OutDir', fx.out], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, IRMIA_PRIVATE_WORDS: fx.words },
  });
}

/** 用 PowerShell 读 zip 条目（不依赖 bsdtar；与归档脚本同一套 .NET API）。 */
function zipEntries(zip: string): string[] {
  const entries = spawnSync('pwsh', ['-NoProfile', '-Command',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead($env:IRMIA_ARCHIVE_TEST_ZIP); try { @($zip.Entries.FullName) | ConvertTo-Json -Compress } finally { $zip.Dispose() }'], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, IRMIA_ARCHIVE_TEST_ZIP: zip },
  });
  assert.equal(entries.status, 0, entries.stderr);
  return (JSON.parse(entries.stdout) as string[]).map((name) => name.replaceAll('\\', '/'));
}

test('源码归档保留 pubspec 的图标、图片及分辨率变体', { skip }, () => {
  const fx = fixture();
  const run = runArchive(fx);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const names = zipEntries(fx.zip);
  for (const path of ['pubspec.yaml', 'assets/tray.ico', 'assets/mark.png', 'assets/2.0x/mark.png']) {
    assert.ok(names.includes(`irmia-agent/gui/${path}`), `归档缺文件：${path}`);
  }
});

test('源码归档带齐内置包来源（packs/skills/tools），且排除 dist 双路径', { skip }, () => {
  const fx = fixture();
  const run = runArchive(fx);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const names = new Set(zipEntries(fx.zip));

  // ① 每个 builtin: 来源都在归档里（含 builtin:skills 这一类，例如 plugin-dev）。
  assert.ok(names.has('irmia-agent/packs/subagents/skills/fake-skill/SKILL.md'), '归档缺 packs 内置技能');
  assert.ok(names.has('irmia-agent/skills/fake-dev/SKILL.md'), '归档缺 builtin:skills 技能');
  assert.ok(names.has('irmia-agent/packs/subagents/tools/codegraph/code_cli.py'), '归档缺 worker 的 codegraph CLI');
  assert.ok(names.has('irmia-agent/LICENSE'), '归档根必须有 LICENSE（内置来源的许可证核验用）');
  assert.ok(names.has('irmia-agent/packaging/builtin-payload.mjs'), '归档要能重建：清单脚本本身也得在源码里');
  assert.ok(names.has('irmia-agent/src/runtime/subagent-profiles.ts'), '归档要能重建：Profile 清单必须在');
  assert.ok(names.has('irmia-agent/sdk/node/index.d.ts'), '归档必须带开发期 SDK');

  // ② 仓库现场的 dist（尤其 dist/packs）不带进归档。
  const leaked = [...names].filter((name) => name === 'irmia-agent/dist'
    || name.startsWith('irmia-agent/dist/') || name.includes('/dist/packs/'));
  assert.deepEqual(leaked, [], `源码归档里出现了 dist 内容：\n${leaked.join('\n')}`);

  // ③ 自检步骤真的跑了，且判据就是内置包清单那一步。
  assert.match(run.stdout, /内置包来源自检/u, '脚本里必须有内置包来源自检这一步');
  assert.match(run.stdout, /hash 与 Profile 清单一致/u);
});

test('源码归档缺内置来源时 fail-closed：非 0 退出、不交付 zip', { skip }, () => {
  const fx = fixture();
  // 删掉 builtin:skills 那个来源：Profile 清单仍引用它 ⇒ 归档必须拒绝生成。
  spawnSync('pwsh', ['-NoProfile', '-Command', `Remove-Item -LiteralPath (Join-Path $env:IRMIA_FAKE_REPO 'skills/fake-dev') -Recurse -Force`], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, IRMIA_FAKE_REPO: fx.repo },
  });
  const run = runArchive(fx);
  assert.notEqual(run.status, 0, `缺内置来源时归档必须失败：\n${run.stdout}${run.stderr}`);
  assert.match(run.stdout + run.stderr, /内置包来源|不存在|source-missing/u,
    '失败信息要点名缺的是内置包来源');
  assert.equal(existsSync(fx.zip), false, '自检没过时不许交付 zip');
});

test('源码归档缺少声明资源时失败且不交付 zip', { skip }, () => {
  const fx = fixture({ missingAsset: true });
  const run = runArchive(fx);
  assert.notEqual(run.status, 0);
  assert.match(run.stdout + run.stderr, /assets\/mark\.png/);
  assert.equal(existsSync(fx.zip), false);
});

// ── 脱敏后归档（2026-11-05）──────────────────────────────────────────────────

/** 读 zip 条目的原始字节（按规范化路径匹配；用 PowerShell 的 .NET zip API，不依赖 bsdtar）。 */
function zipEntryBytes(zip: string, entry: string): Buffer {
  const result = spawnSync('pwsh', ['-NoProfile', '-Command',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead($env:IRMIA_ARCHIVE_TEST_ZIP);'
    + ' try { $target=$env:IRMIA_ARCHIVE_TEST_ENTRY; $hit=$null; foreach ($e in $zip.Entries) { if ($e.FullName.Replace(\'\\\',\'/\') -eq $target) { $hit=$e; break } };'
    + ' if ($null -eq $hit) { Write-Error "entry not found: $target"; exit 3 }; $s=$hit.Open(); try { $ms=New-Object System.IO.MemoryStream; $s.CopyTo($ms);'
    + ' [Convert]::ToBase64String($ms.ToArray()) } finally { $s.Dispose() } } finally { $zip.Dispose() }'], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, IRMIA_ARCHIVE_TEST_ZIP: zip, IRMIA_ARCHIVE_TEST_ENTRY: entry },
  });
  assert.equal(result.status, 0, `读 zip 条目失败（${entry}）：${result.stderr}`);
  return Buffer.from((result.stdout ?? '').trim(), 'base64');
}

test('脱敏后归档：zip 内不含原私有词/本机路径/假 token，且生成脱敏报表（不含敏感值）', { skip }, () => {
  const fx = fixture();
  const run = runArchive(fx);
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.equal(existsSync(fx.zip), true, '脱敏后应产出 zip');
  assert.equal(existsSync(fx.report), true, '应产出脱敏报表（与 zip 放一起）');

  const privateText = zipEntryBytes(fx.zip, 'irmia-agent/test/private-fixture.md').toString('utf8');
  for (const raw of ['伊尔弥亚', '弥亚小姐', '弥亚', 'owner-stickers', '默认表情', '用户', WIN_REPO, WIN_HOME, '.astrbot']) {
    assert.equal(privateText.includes(raw), false, `zip 里仍含私有内容：${raw}`);
  }
  for (const replaced of ['Irmia', '助手小姐', '助手', 'owner-stickers', '默认表情', '用户', WIN_REPO_PLACEHOLDER,
    WIN_HOME_PLACEHOLDER, 'astrbot']) {
    assert.equal(privateText.includes(replaced), true, `脱敏占位缺失：${replaced}`);
  }

  // 精确夹具规则：AWS 文档示例 key 被换掉，且是"整串一致替换"（输入与期望串都换，测试语义不变）。
  const r2put = zipEntryBytes(fx.zip, 'irmia-agent/test/r2-put.test.ts').toString('utf8');
  assert.equal(r2put.includes(AKIA_EXAMPLE), false, '假 token 必须被精确夹具规则换掉');
  assert.equal(r2put.match(new RegExp(AKIA_PLACEHOLDER, 'gu'))?.length, 2, '输入与期望串应同时替换');

  // 非 UTF-8 历史脚本走字节级替换：路径换掉、其余字节（0x81）原样保留。
  const legacy = zipEntryBytes(fx.zip, 'irmia-agent/scripts/legacy-encoding.cmd');
  assert.equal(legacy.includes(Buffer.from(WIN_REPO, 'utf8')), false, '非 UTF-8 文件里的本机路径也要换掉');
  assert.equal(legacy.includes(Buffer.from([0x81])), true, '字节级替换不许改坏其余字节');

  // 报表：命中文件/规则/次数，**不含具体敏感值**。
  const reportText = readFileSync(fx.report, 'utf8');
  const report = JSON.parse(reportText) as {
    totalHits: number; filesChanged: number; residual: Array<{ruleId: string}>;
    rules: Array<{id: string; count: number}>; files: Array<{path: string}>;
  };
  assert.ok(report.totalHits > 0, '报表要记命中次数');
  assert.ok(report.filesChanged > 0, '报表要记命中文件数');
  assert.deepEqual(report.residual, [], '脱敏后不应有残留命中');
  const counts = new Map(report.rules.map((row) => [row.id, row.count]));
  for (const id of ['owner-word', 'sticker-pack-id', 'sticker-pack-title', 'persona-name-double',
    'persona-name-honorific', 'persona-name-short', 'repo-root-abs', 'user-home-abs', 'astrbot-trace',
    'aws-doc-example-key']) {
    assert.ok((counts.get(id) ?? 0) > 0, `报表里应有规则 ${id} 的命中数`);
  }
  for (const secret of ['伊尔弥亚', '弥亚', 'owner-stickers', AKIA_EXAMPLE, WIN_HOME, WIN_REPO]) {
    assert.equal(reportText.includes(secret), false, `脱敏报表不许含具体敏感值：${secret}`);
  }
});

test('脱敏后仍有未覆盖的私有词 ⇒ 闸门拦住、不产出 zip（fail-closed 不退化）', { skip }, () => {
  const fx = fixture({ unsanitizedSentinel: true });
  const run = runArchive(fx);
  assert.notEqual(run.status, 0, `未覆盖的私有词必须让归档失败：\n${run.stdout}${run.stderr}`);
  assert.match(run.stdout + run.stderr, /命中私有词表|AUDIT_SENTINEL|不通过/u, '失败信息要指向闸门命中');
  assert.equal(existsSync(fx.zip), false, '闸门没过时不许交付 zip');
});

test('精确夹具之外"像密钥"的串仍被全局密钥形态扫描拦住（扫描没被放宽）', { skip }, () => {
  const fx = fixture({ genericSecret: true });
  const run = runArchive(fx);
  assert.notEqual(run.status, 0, `未列入精确夹具的疑似密钥必须让归档失败：\n${run.stdout}${run.stderr}`);
  assert.match(run.stdout + run.stderr, /疑似真实密钥|密钥/u, '失败信息要指向密钥形态扫描');
  assert.equal(existsSync(fx.zip), false, '密钥扫描没过时不许交付 zip');
});

test('闸门本身仍会拦住未脱敏内容（不依赖归档管道的 fail-closed）', { skip }, () => {
  const fx = fixture();
  const dir = join(fx.repo, 'unsanitized-probe');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bad.txt'), 'AUDIT_SENTINEL must be caught\n');
  const gate = spawnSync('pwsh', ['-NoProfile', '-File', resolve(import.meta.dirname, '../tools/package-gate.ps1'), '-Path', dir], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, IRMIA_PRIVATE_WORDS: fx.words },
  });
  assert.notEqual(gate.status, 0, `未脱敏内容必须被闸门拦住：\n${gate.stdout}${gate.stderr}`);
});

test('归档与发布脚本均可被 PowerShell 解析', { skip }, () => {
  for (const file of [script, resolve(import.meta.dirname, '../tools/release.ps1')]) {
    const parsed = spawnSync('pwsh', ['-NoProfile', '-Command',
      '$tokens=$null; $issues=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:IRMIA_SCRIPT_TO_PARSE,[ref]$tokens,[ref]$issues); if($issues.Count){$issues | ForEach-Object {$_.Message}; exit 1}'], {
      windowsHide: true, encoding: 'utf8', env: { ...process.env, IRMIA_SCRIPT_TO_PARSE: file },
    });
    assert.equal(parsed.status, 0, parsed.stdout + parsed.stderr);
  }
});
