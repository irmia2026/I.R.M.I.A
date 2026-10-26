import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import {
  isPluginEngineCompatible,
  parsePluginManifest,
} from '../src/plugin/manifest.ts';
import {
  assertPluginSourceOutsideStore,
  installPluginPackage,
  PLUGIN_FILE_LIMITS,
  pluginPackagesRoot,
  scanPluginPackage,
} from '../src/plugin/package-store.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

function manifest(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: 1,
    id: 'companion-kit',
    version: '1.2.3',
    engine: { irmia: '>=0.1.0-beta.12' },
    contributions: { skills: ['skills'], hooks: 'hooks.json', mcp: 'mcp.json' },
    permissions: [],
    ...patch,
  };
}

function source(manifestPatch: Record<string, unknown> = {}): string {
  const dir = tempDirSync('irmia-plugin-source-');
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest(manifestPatch)));
  return dir;
}

describe('插件清单', () => {
  test('接受 P0 的 Skill、Hook、MCP 声明并冻结路径数组', () => {
    const parsed = parsePluginManifest(manifest());
    assert.equal(parsed.id, 'companion-kit');
    assert.deepEqual(parsed.contributions.skills, ['skills']);
    assert.equal(parsed.contributions.hooks, 'hooks.json');
    assert.equal(parsed.contributions.mcp, 'mcp.json');
    assert.throws(() => parsed.contributions.skills.push('other'), TypeError);
  });

  test('拒绝 P1 能力、未知字段与无效身份', () => {
    for (const kind of ['prompts', 'persona', 'providers', 'ui']) {
      assert.throws(() => parsePluginManifest(manifest({ contributions: { [kind]: [] } })), new RegExp(kind));
    }
    assert.throws(() => parsePluginManifest(manifest({ unexpected: true })), /unexpected/);
    for (const id of ['', 'Upper', '_private', 'a'.repeat(65), 'a/b']) {
      assert.throws(() => parsePluginManifest(manifest({ id })));
    }
    for (const version of ['', '1.0', 'v1.0.0', '1.0.0+build']) {
      assert.throws(() => parsePluginManifest(manifest({ version })));
    }
    for (const apiVersion of [0, 2, '1']) {
      assert.throws(() => parsePluginManifest(manifest({ apiVersion })));
    }
  });

  test('严格校验贡献路径和权限', () => {
    for (const path of ['../secret', '/absolute', 'C:/absolute', '', 'skills/../other']) {
      assert.throws(() => parsePluginManifest(manifest({ contributions: { skills: [path] } })));
      assert.throws(() => parsePluginManifest(manifest({ contributions: { hooks: path } })));
    }
    assert.throws(() => parsePluginManifest(manifest({ permissions: 'network' })));
    assert.throws(() => parsePluginManifest(null));
  });

  test('精确和最低版本约束遵循 prerelease 顺序', () => {
    assert.equal(isPluginEngineCompatible('>=0.1.0-beta.12', '0.1.0-beta.12'), true);
    assert.equal(isPluginEngineCompatible('>=0.1.0-beta.13', '0.1.0-beta.12'), false);
    assert.equal(isPluginEngineCompatible('0.1.0-beta.12', '0.1.0-beta.12'), true);
    assert.equal(isPluginEngineCompatible('0.1.0', '0.1.0-beta.12'), false);
    assert.equal(isPluginEngineCompatible('>=0.1.0-beta.12', '0.1.0'), true);
    for (const requirement of ['^1.0.0', '~1.0.0', '*', '>=1.0.0 || <2.0.0', '1.0']) {
      assert.throws(() => isPluginEngineCompatible(requirement, '1.0.0'));
    }
  });
});

describe('不可变插件包', () => {
  test('安装和扫描都拒绝不兼容当前代理版本的包', () => {
    const dir = source({ engine: { irmia: '>=999.0.0' } });
    assert.throws(() => scanPluginPackage(dir), /engine|version|incompatible/i);
    assert.throws(() => installPluginPackage(dir, tempDirSync('irmia-plugin-data-')), /engine|version|incompatible/i);
  });

  test('内容哈希与目录枚举顺序无关，安装幂等', () => {
    const first = source();
    const second = source();
    for (const [dir, names] of [[first, ['z.txt', 'a.txt']], [second, ['a.txt', 'z.txt']]] as const) {
      for (const name of names) writeFileSync(join(dir, name), name);
    }
    const a = scanPluginPackage(first);
    const b = scanPluginPackage(second);
    assert.equal(a.contentHash, b.contentHash);
    assert.equal(a.contentHash.length, 64);
    assert.equal(a.fileCount, 3);
    const dataDir = tempDirSync('irmia-plugin-data-');
    const installed = installPluginPackage(first, dataDir);
    assert.deepEqual(installPluginPackage(second, dataDir), installed);
    assert.equal(installed.rootDir, join(pluginPackagesRoot(dataDir), installed.manifest.id, installed.contentHash));
    assert.equal(installed.manifest.engine.irmia, '>=0.1.0-beta.12');
  });

  test('篡改已安装内容会被扫描拒绝', () => {
    const dir = source();
    writeFileSync(join(dir, 'data.txt'), 'original');
    const installed = installPluginPackage(dir, tempDirSync('irmia-plugin-data-'));
    writeFileSync(join(installed.rootDir, 'data.txt'), 'tampered');
    assert.throws(() => scanPluginPackage(installed.rootDir), /content hash|contentHash/i);
  });

  test('拒绝符号链接文件和目录', (t) => {
    const dir = source();
    writeFileSync(join(dir, 'ordinary.txt'), 'safe');
    mkdirSync(join(dir, 'actual'));
    try {
      symlinkSync(join(dir, 'ordinary.txt'), join(dir, 'linked.txt'));
      symlinkSync(join(dir, 'actual'), join(dir, 'linked-dir'), 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('Windows symlink permission unavailable');
      throw error;
    }
    assert.throws(() => scanPluginPackage(dir), /symbolic link/i);
  });

  test('文件数、单文件和总字节数均有限制', () => {
    const tooMany = source();
    for (let i = 0; i < PLUGIN_FILE_LIMITS.maxFiles; i += 1) writeFileSync(join(tooMany, `${i}.txt`), 'x');
    assert.throws(() => scanPluginPackage(tooMany), /file count|too many files/i);

    const tooLarge = source();
    writeFileSync(join(tooLarge, 'large.bin'), Buffer.alloc(PLUGIN_FILE_LIMITS.maxFileBytes + 1));
    assert.throws(() => scanPluginPackage(tooLarge), /file size|too large/i);

    const excessiveTotal = source();
    for (let i = 0; i < 9; i += 1) writeFileSync(join(excessiveTotal, `${i}.bin`), Buffer.alloc(1024 * 1024));
    assert.throws(() => scanPluginPackage(excessiveTotal), /total size|too large/i);
  });

  test('Windows 跨盘插件源不在目标包目录内', { skip: process.platform !== 'win32' }, () => {
    assert.doesNotThrow(() => assertPluginSourceOutsideStore('D:\\plugins\\demo', 'C:\\data\\plugins\\packages'));
    assert.throws(() => assertPluginSourceOutsideStore('C:\\data\\plugins\\packages\\demo', 'C:\\data\\plugins\\packages'), /inside/);
  });

  test('禁止把目标包目录的子孙递归安装为插件', () => {
    const dataDir = tempDirSync('irmia-plugin-data-');
    const dir = join(pluginPackagesRoot(dataDir), 'source');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest()));
    assert.throws(() => installPluginPackage(dir, dataDir), /inside|destination|recursive/i);
  });
});

describe('整包哈希的确定性', () => {
  test('按码点排序，不受 locale/ICU 影响', () => {
    const dir = tempDirSync('irmia-plugin-order-');
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest({ contributions: { skills: [] }, permissions: [] })));
    writeFileSync(join(dir, 'Zeta.md'), 'Z');
    writeFileSync(join(dir, 'alpha.md'), 'A');
    const paths = ['Zeta.md', 'alpha.md', 'plugin.json'];
    const codepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    const digest = (order: string[]): string => {
      const hash = createHash('sha256');
      for (const rel of order) {
        hash.update(rel);
        hash.update('\u0000');
        hash.update(readFileSync(join(dir, rel)));
      }
      return hash.digest('hex');
    };
    const expected = digest([...paths].sort(codepoint));
    assert.equal(scanPluginPackage(dir).contentHash, expected);

    // 反向断言：这条用例真的在盯顺序——若两序一致，说明样本没区分力，直接失败提醒换样本
    const localeOrder = [...paths].sort((a, b) => a.localeCompare(b));
    assert.notEqual(localeOrder.join('|'), [...paths].sort(codepoint).join('|'), '样本需能区分码点序与 locale 序');
    assert.notEqual(digest(localeOrder), expected, 'locale 序算出的哈希必须不同');
  });
});
