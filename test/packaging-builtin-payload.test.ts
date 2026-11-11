/**
 * 便携包内置资源（`packs/` + 内置 skills + LICENSE）的测试。
 *
 * 盯的是 2026-11-05 的发布阻塞项：装配链过去只拷 `dist/`、白名单 skills，**不拷 `packs/`**，
 * 于是测试者装完一点「安装角色」就 source-missing。修法是把清单交给
 * `packaging/builtin-payload.mjs`：它从 `src/runtime/subagent-profiles.ts` 的 install 清单
 * 现算要带哪些目录，并按 Profile 里钉的 sha256 逐个重算（与运行时 `hashTree` 同一条算法）。
 *
 * 五组断言（都在真仓库 / 临时目录上跑，不 mock）：
 *   ① 清单 = Profile 里所有 `builtin:` 来源（含 worker 的全部技能）+ 运行时专用 pack 目录 + LICENSE；
 *   ② 逐个内置来源的 `hashTree()` 必须等于 Profile 里的 sha256（两支实现同算法的硬证据；
 *      不等就说明安装时必 source-hash-mismatch）；
 *   ③ `--copy` 到临时包根后，packs 脚本 / codegraph CLI / 每个内置技能的 SKILL.md / LICENSE 都在；
 *   ④ `--check` 对复制结果判绿；删一个文件、或塞一个 `dist/packs/` 进来，必须判红（唯一路径口径）；
 *   ⑤ fail-closed：Profile 引用一个不存在的来源时，清单必须 exit 非 0，不许静默少带。
 *
 * ⚠️ 本文件会同步进公开副本（`test/**` 不排除），而 `packaging/` 不出公开副本 ⇒
 *    公开副本里这一组整组 skip（与 `test/publish-oss-skills.test.ts` 对 publish 脚本的处理同例）。
 *    测试里**不写死任何技能名**：要举例就从 Profile 清单里取，将来加/撤技能这份文件不用改。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test, { describe, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { hashTree } from '../src/runtime/subagent-packages.ts';
import { BUILTIN_PROFILES } from '../src/runtime/subagent-profiles.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 出包脚手架（含这支清单脚本）**不进公开副本** ⇒ 公开副本里没有它。 */
const PAYLOAD = join(REPO, 'packaging', 'builtin-payload.mjs');
const HAS_PAYLOAD = existsSync(PAYLOAD);

interface ManifestSource {
  dir: string;
  sha256: string;
}

interface Manifest {
  ok: boolean;
  repo: string;
  sources: ManifestSource[];
  packs: string[];
  skills: string[];
  runtimeOnly: string[];
  rootFiles: string[];
  criticalFiles: string[];
  problems: string[];
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Run {
  const result = spawnSync(process.execPath, [PAYLOAD, ...args], { cwd: REPO, encoding: 'utf8' });
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** `--json` 约定：stdout 上**只有一行** JSON（错误/诊断都进 problems 或 stderr）。 */
function manifestOf(result: Run): Manifest {
  const parsed = JSON.parse(result.stdout.trim()) as Manifest;
  assert.equal(typeof parsed.ok, 'boolean');
  return parsed;
}

function temp(t: TestContext): string {
  const dir = tempDirSync('irmia-builtin-payload-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Profile 里所有 `builtin:` 安装来源（排序去重后的仓库相对路径）。 */
function expectedBuiltinDirs(): string[] {
  const dirs = new Set<string>();
  for (const profile of BUILTIN_PROFILES) {
    for (const source of profile.install ?? []) {
      if (source.source.startsWith('builtin:')) dirs.add(source.source.slice('builtin:'.length));
    }
  }
  return [...dirs].sort();
}

describe('便携包内置资源清单（packaging/builtin-payload.mjs）', {
  skip: HAS_PAYLOAD ? false : '公开副本里没有 packaging/（出包脚手架不外发）—— 这组只在仓库侧跑',
}, () => {
  test('① 清单 = Profile 的全部 builtin: 来源 + 运行时 pack 目录 + LICENSE（不抄第二份目录名）', () => {
    const result = run(['--json']);
    assert.equal(result.code, 0, `清单必须 exit 0：${result.stdout}${result.stderr}`);
    const manifest = manifestOf(result);
    assert.equal(manifest.ok, true, manifest.problems.join('；'));
    assert.deepEqual(manifest.sources.map((source) => source.dir).sort(), expectedBuiltinDirs(),
      '清单必须逐字等于 Profile install 清单里的 builtin: 来源 —— 多/少一个都会让某个角色装不上');
    // worker 是技能最多的角色：它的**每一个**安装来源都必须在清单里（任务要求"8 个来源都可在包内解析"）。
    const worker = BUILTIN_PROFILES.find((profile) => profile.id === 'worker');
    assert.notEqual(worker, undefined, '内置 Profile 里必须有 worker');
    const workerSources = (worker!.install ?? []).map((source) => source.source.replace(/^builtin:/u, ''));
    assert.ok(workerSources.length > 0, 'worker 的 install 清单不能是空的');
    for (const dir of workerSources) {
      assert.ok(manifest.sources.some((source) => source.dir === dir), `worker 的来源缺在包清单里：${dir}`);
    }
    // codegraph 脚本与 LICENSE 不在 install 清单里，但运行时必须有——清单要显式带上。
    assert.ok(manifest.runtimeOnly.includes('packs/subagents/tools'), 'worker 的 code 工具要求 packs/subagents/tools 随包');
    assert.ok(manifest.criticalFiles.includes('packs/subagents/tools/codegraph/code_cli.py'),
      'codegraph 的 CLI 脚本是运行时硬依赖（工具报错文案点名它）');
    assert.ok(manifest.rootFiles.includes('LICENSE'), '内置来源的许可证从应用根核验，包根必须有 LICENSE');
    // 每个来源都要能在仓库里定位到（否则打包时只能静默少带）。
    for (const source of manifest.sources) {
      assert.equal(existsSync(join(REPO, source.dir)), true, `清单里的来源在仓库里不存在：${source.dir}`);
    }
  });

  test('② 每个内置来源的 hashTree = Profile 里钉的 sha256（装配/运行时同一条算法）', () => {
    const manifest = manifestOf(run(['--json']));
    assert.equal(manifest.ok, true, manifest.problems.join('；'));
    assert.ok(manifest.sources.length > 0, '没有内置来源时这组断言是空的');
    for (const source of manifest.sources) {
      assert.equal(hashTree(join(REPO, source.dir)), source.sha256,
        `${source.dir} 的目录 hash 与 Profile 清单不一致：装机时会 source-hash-mismatch。`
        + '先确认仓库内容与 Profile 里的 sha256 是同一版（改过技能就要同步改清单）。');
    }
  });

  test('③ --copy 到临时包根：packs / 内置技能 / codegraph CLI / LICENSE 都在', (t) => {
    const pkg = temp(t);
    const result = run(['--copy', '--repo', REPO, '--out', pkg]);
    assert.equal(result.code, 0, `复制必须 exit 0：${result.stdout}${result.stderr}`);
    const manifest = manifestOf(run(['--json']));
    for (const source of manifest.sources) {
      const target = join(pkg, source.dir);
      assert.equal(existsSync(target), true, `包内缺内置来源：${source.dir}`);
      // 技能目录的运行期判据是 SKILL.md（`hasSkill()` 只认它）。
      if (source.dir.startsWith('skills/') || source.dir.includes('/skills/')) {
        assert.equal(existsSync(join(target, 'SKILL.md')), true, `内置技能缺 SKILL.md：${source.dir}`);
      }
    }
    assert.equal(existsSync(join(pkg, 'packs/subagents/tools/codegraph/code_cli.py')), true,
      'worker 的 code 工具脚本必须在包内（packs/subagents/tools/codegraph/code_cli.py）');
    assert.equal(existsSync(join(pkg, 'LICENSE')), true, '包根必须有 LICENSE（内置来源的许可证核验用）');
  });

  test('④ --check：复制结果判绿；删文件或出现 dist/packs 必须判红', (t) => {
    const pkg = temp(t);
    assert.equal(run(['--copy', '--repo', REPO, '--out', pkg]).code, 0);
    const ok = run(['--check', '--repo', REPO, '--pkg', pkg]);
    assert.equal(ok.code, 0, `复制结果必须判绿：${ok.stdout}${ok.stderr}`);
    assert.match(ok.stdout, /内置资源完整/u);

    // 删掉一个内置来源里的文件 ⇒ hash 与 Profile 不一致（模拟"兜底过滤删了包内文件"）
    const manifest = manifestOf(run(['--json']));
    const victimSource = manifest.sources[0]!;
    const victimFile = readTreeFile(join(pkg, victimSource.dir));
    unlinkSync(victimFile);
    const broken = run(['--check', '--repo', REPO, '--pkg', pkg]);
    assert.equal(broken.code, 1, `包内文件被删后 --check 必须判红：${broken.stdout}`);
    assert.match(broken.stdout + broken.stderr, /hash 与 Profile|缺/u);

    // 修回来
    assert.equal(run(['--copy', '--repo', REPO, '--out', pkg]).code, 0);
    assert.equal(run(['--check', '--repo', REPO, '--pkg', pkg]).code, 0);

    // dist/packs = 已删除的双路径口径：哪怕内容对，也不许出现在包里
    mkdirSync(join(pkg, 'dist', 'packs'), { recursive: true });
    const duplicate = run(['--check', '--repo', REPO, '--pkg', pkg]);
    assert.equal(duplicate.code, 1, '包里出现 dist/packs 必须判红（唯一路径口径）');
    assert.match(duplicate.stdout + duplicate.stderr, /dist\/packs|dist\\packs/u);
  });

  test('⑤ fail-closed：Profile 引用了不存在的来源 ⇒ 清单 exit 非 0（不静默少带）', (t) => {
    const fakeRepo = temp(t);
    mkdirSync(join(fakeRepo, 'src', 'runtime'), { recursive: true });
    writeFileSync(join(fakeRepo, 'src', 'runtime', 'subagent-profiles.ts'), [
      'export const BUILTIN_PROFILES = [',
      '  {',
      "    id: 'fake', label: '假角色', description: '', systemPrompt: '',",
      "    workdir: 'workspace', shell: 'none', tools: 'readonly', workspace: 'own',",
      "    skills: [], mcpServers: [], reasoningEffort: 'high', contextLimit: 1, compactAt: 0.7,",
      '    install: [',
      "      {source: 'builtin:packs/subagents/skills/definitely-not-here', ref: 'v1', sha256: '" + 'a'.repeat(64) + "'},",
      '    ],',
      '  },',
      '];',
      '',
    ].join('\n'), 'utf8');
    const result = run(['--json', '--repo', fakeRepo]);
    assert.equal(result.code, 1, `来源不存在时清单必须非 0：${result.stdout}${result.stderr}`);
    const manifest = manifestOf(result);
    assert.equal(manifest.ok, false);
    assert.ok(manifest.problems.some((problem) => problem.includes('不存在')),
      `问题列表要点名缺哪个来源：${manifest.problems.join('；')}`);
  });

  test('⑥ 装配链/构建代码里不再有 dist/packs 双路径（单一口径的源码级断言）', () => {
    // 这条盯的是"删掉了一处、忘了另一处"：copy-assets 若又把 packs 拷进 dist，
    // 装配就会把同一份资源装两次（包根 + dist），而两处都可能被解析到。
    const copyAssets = readFileSync(join(REPO, 'scripts', 'copy-assets.mjs'), 'utf8');
    assert.equal(/\[\s*'packs\/[^']*'/u.test(copyAssets), false,
      'copy-assets.mjs 的复制表里不许再有 packs/ 来源（packs 只由 packaging/builtin-payload.mjs 搬到包根）');
    const codeSource = readFileSync(join(REPO, 'src', 'runtime', 'subagent-code.ts'), 'utf8');
    assert.equal(/resolve\(APPLICATION_ROOT,\s*'dist',\s*'packs'/u.test(codeSource), false,
      'subagent-code.ts 不许再有 <应用根>/dist/packs 的候选路径');
    // 装配脚本必须真的调用这支清单脚本（否则它只是躺在仓库里，包还是缺 packs）。
    const assemble = readFileSync(join(REPO, 'packaging', 'assemble-package.ps1'), 'utf8');
    assert.match(assemble, /builtin-payload\.mjs/u, '装配脚本必须调用 packaging/builtin-payload.mjs');
    assert.match(assemble, /--check/u, '装配脚本必须在兜底过滤之后再 --check 一遍包内资源');
  });
});

/** 取目录树里第一个普通文件（用来制造"包内被删/被改"的失败面）。 */
function readTreeFile(root: string): string {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) return path;
    }
  }
  throw new Error(`目录里没有文件：${root}`);
}
