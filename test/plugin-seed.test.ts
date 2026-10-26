/**
 * 内置插件种子（`src/plugin/seed.ts`）的回归测试（beta14）
 *
 * 这个模块的全部价值就是**三条纪律**，所以每条各有一个用例把它的反面钉住：
 *   ① 装过就一个字节都不动（幂等）
 *   ② 不覆盖（内容变了就是新 hash、新目录，旧的那份原样留着）
 *   ③ 失败不拦启动（不抛，把原因如实报出来）
 *
 * 外加两条装配面的：没有出厂种子时**不建空目录**、种子根里**只收目录**（散文件忽略）。
 */

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { pluginPackagesRoot } from '../src/plugin/package-store.ts';
import { ensureBuiltinPlugins } from '../src/plugin/seed.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

/**
 * 造一个最小可用的插件目录（直接当做出厂种子用）。
 *
 * `contributions.skills` 必须是数组（清单校验的硬要求），但**可以是空的**——空数组意味着
 * 「这个插件不贡献技能」，对种子模块完全合法：种子的职责只是把字节搬过去，不解释贡献。
 */
function makePlugin(
  id: string,
  options: { version?: string; files?: Record<string, string> } = {},
): string {
  const dir = tempDirSync('irmia-plugin-src-');
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({
    apiVersion: 1,
    id,
    version: options.version ?? '1.0.0',
    engine: { irmia: '>=0.1.0-beta.1' },
    contributions: { skills: [] },
    permissions: [],
  }));
  for (const [name, content] of Object.entries(options.files ?? {})) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

/** 造一个"出厂种子根"，把若干插件目录按目录名摆进去（真正的整份复制） */
function makeSeedRoot(plugins: Record<string, string>): string {
  const root = tempDirSync('irmia-seed-root-');
  for (const [dirName, source] of Object.entries(plugins)) {
    cpSync(source, join(root, dirName), { recursive: true });
  }
  return root;
}

describe('内置插件种子', () => {
  test('① 首次启动：装进包仓库，报告 created', () => {
    const root = makeSeedRoot({ demo: makePlugin('demo-plugin') });
    const dataDir = tempDirSync('irmia-data-');

    const report = ensureBuiltinPlugins(dataDir, root);
    assert.equal(report.state, 'created');
    assert.equal(report.installed.length, 1);
    assert.equal(report.installed[0]?.manifest.id, 'demo-plugin');
    assert.equal(report.skipped.length, 0);
    assert.equal(report.failures.length, 0);

    // 真的落在内容寻址的仓库里
    const target = join(pluginPackagesRoot(dataDir), 'demo-plugin', report.installed[0]!.contentHash);
    assert.ok(existsSync(join(target, 'plugin.json')));
  });

  test('② 第二次启动：一个字节都不动，报告 exists', () => {
    const root = makeSeedRoot({ demo: makePlugin('demo-plugin') });
    const dataDir = tempDirSync('irmia-data-');

    const first = ensureBuiltinPlugins(dataDir, root);
    const hash = first.installed[0]!.contentHash;

    const second = ensureBuiltinPlugins(dataDir, root);
    assert.equal(second.state, 'exists');
    assert.equal(second.installed.length, 0, '第二次不该再"装"任何东西');
    assert.equal(second.skipped.length, 1, '它应当被认成"已经在仓库里"');
    assert.equal(second.skipped[0]?.contentHash, hash);
  });

  test('③ 内容变了：新 hash 新目录，旧那份原样留着（不覆盖）', () => {
    const dataDir = tempDirSync('irmia-data-');

    const v1 = ensureBuiltinPlugins(dataDir, makeSeedRoot({ demo: makePlugin('demo-plugin') }));
    const oldHash = v1.installed[0]!.contentHash;

    // 同名同版本、但多一个文件 ⇒ 不同 contentHash ⇒ 另一个目录
    const v2 = ensureBuiltinPlugins(dataDir, makeSeedRoot({
      demo: makePlugin('demo-plugin', { files: { 'extra.txt': 'changed bytes' } }),
    }));
    const newHash = v2.installed[0]!.contentHash;

    assert.notEqual(newHash, oldHash, '改了一个字节，内容哈希必须变');
    const dirs = readdirSync(join(pluginPackagesRoot(dataDir), 'demo-plugin')).sort();
    assert.deepEqual(dirs, [oldHash, newHash].sort(), '两版必须并存，旧版不能被覆盖删除');
  });

  test('④ 没有出厂种子：no-seed，且不建空目录', () => {
    const dataDir = tempDirSync('irmia-data-');
    const missing = join(tempDirSync('irmia-none-'), 'not-here');

    const report = ensureBuiltinPlugins(dataDir, missing);
    assert.equal(report.state, 'no-seed');
    assert.equal(report.installed.length, 0);
    assert.equal(existsSync(pluginPackagesRoot(dataDir)), false, 'no-seed 不该顺手建出仓库目录');
  });

  test('⑤ 种子根里只有散文件、没有目录：同样按 no-seed 处理', () => {
    const dataDir = tempDirSync('irmia-data-');
    const root = tempDirSync('irmia-flat-');
    writeFileSync(join(root, 'README.md'), 'this is not a plugin');

    const report = ensureBuiltinPlugins(dataDir, root);
    assert.equal(report.state, 'no-seed');
  });

  test('⑥ 一个坏包不拦好包，但失败必须如实报出来', () => {
    const broken = tempDirSync('irmia-broken-');
    // plugin.json 是坏 JSON：scan 必然抛错
    writeFileSync(join(broken, 'plugin.json'), '{ not json');

    const root = makeSeedRoot({
      good: makePlugin('good-plugin'),
      broken,
    });
    const dataDir = tempDirSync('irmia-data-');
    const report = ensureBuiltinPlugins(dataDir, root);

    // 好包照样装上（失败不拦启动）
    assert.equal(report.installed.length, 1);
    assert.equal(report.installed[0]?.manifest.id, 'good-plugin');
    // 坏包的失败原因必须报出来，且指明是哪个目录
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0]?.dir, 'broken');
    assert.ok(report.failures[0]!.reason.length > 0, '失败必须带一句人话');
    // 有失败就是 failed（哪怕另外有成功）
    assert.equal(report.state, 'failed');

    // ⚠ 这条是本用例真正要钉住的：**部分失败时，成功那一个仍然必须出现在 `installed` 里**。
    // `main.ts` 就是按 `installed` 逐条写 `plugin/builtin` 装配账的——如果这里把它挪进
    // `skipped` 或者干脆不报，盘上会有包、日志里却没有"它是怎么来的"，事后无从追查。
    // （这条断言看着与上面重复，但它守的是**另一个消费方的契约**，删了就会静默退化。）
    assert.deepEqual(report.installed.map((pkg) => pkg.manifest.id), ['good-plugin'],
      '部分失败时，装成功的那几个仍要出现在 installed 里（装配账靠它）');
  });

  test('⑦ 种子根是个文件而不是目录：no-seed，不抛', () => {
    const dataDir = tempDirSync('irmia-data-');
    const file = join(tempDirSync('irmia-file-'), 'iam-a-file');
    writeFileSync(file, 'x');

    const report = ensureBuiltinPlugins(dataDir, file);
    assert.equal(report.state, 'no-seed');
  });

  test('⑧ 多个插件：全部装进去，报告里逐个列出', () => {
    const root = makeSeedRoot({
      alpha: makePlugin('alpha-plugin'),
      beta: makePlugin('beta-plugin'),
    });
    const dataDir = tempDirSync('irmia-data-');

    const report = ensureBuiltinPlugins(dataDir, root);
    assert.equal(report.state, 'created');
    assert.deepEqual(
      report.installed.map((pkg) => pkg.manifest.id).sort(),
      ['alpha-plugin', 'beta-plugin'],
    );
  });
});
