/**
 * 插件脚手架（scripts/create-plugin.mjs）· 自检
 *
 * 只做三件事，且**不起任何子进程**（那是 P1a 运行时测试的事）：
 *   ① 三种 lang 各生成一次 → 生成的 plugin.json 能过 `parsePluginManifest`，
 *      入口与 README 都真实存在且非空；
 *   ② 生成物里不含本机绝对路径、不生成 node_modules；
 *   ③ 非空目录拒绝覆盖（--force 才写，而且不删别人的文件）+ CLI 的 0/1/2 退出码与 --help。
 *
 * 独立可跑：`node --test --experimental-strip-types test/plugin-scaffold.test.ts`
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { parsePluginManifest } from '../src/plugin/manifest.ts';
import {
  createPlugin,
  parseArgs,
  readAgentVersion,
  runCli,
  EXIT_CODES,
} from '../scripts/create-plugin.mjs';
import { tempDirSync } from './helpers/temp-dirs.ts';

const LANG_ENTRIES = {
  js: { entry: 'main.mjs', runtime: 'node' },
  ts: { entry: 'main.ts', runtime: 'node' },
  py: { entry: 'main.py', runtime: 'python' },
} as const;

type Lang = keyof typeof LANG_ENTRIES;

describe('create-plugin · 生成的包', () => {
  for (const lang of Object.keys(LANG_ENTRIES) as Lang[]) {
    test(`${lang}：清单能过 parsePluginManifest，入口/README 存在且非空`, () => {
      const root = tempDirSync(`irmia-scaffold-${lang}-`);
      const target = join(root, `demo-${lang}`);
      const result = createPlugin({ id: `demo-${lang}`, lang, dir: target, name: `演示 ${lang}` });

      assert.equal(result.dir, target);
      assert.equal(result.entry, LANG_ENTRIES[lang].entry);
      assert.equal(result.engine, `>=${readAgentVersion()}`);
      assert.deepEqual([...result.files].sort(), ['README.md', 'plugin.json', LANG_ENTRIES[lang].entry].sort());

      const manifestText = readFileSync(join(target, 'plugin.json'), 'utf8');
      const manifest = parsePluginManifest(JSON.parse(manifestText), 'plugin.json');
      assert.equal(manifest.apiVersion, 2);
      assert.equal(manifest.id, `demo-${lang}`);
      assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
      assert.equal(manifest.engine.irmia, `>=${readAgentVersion()}`, 'engine 必须从 src/main.ts 的 AGENT_VERSION 生成，不能写死');
      assert.equal(manifest.runtime.type, LANG_ENTRIES[lang].runtime);
      assert.equal(manifest.runtime.entry, LANG_ENTRIES[lang].entry);
      assert.deepEqual([...manifest.permissions], ['tools.define']);
      assert.equal(manifest.meta?.title, `演示 ${lang}`);

      const entry = readFileSync(join(target, LANG_ENTRIES[lang].entry), 'utf8');
      assert.match(entry, /activate/);
      assert.match(entry, /tools\.define/);
      assert.match(entry, /log\.info/);
      assert.ok(entry.trim().length > 0);

      const readme = readFileSync(join(target, 'README.md'), 'utf8');
      assert.ok(readme.trim().length > 0);
      assert.ok(readme.includes(`demo-${lang}`));
      assert.ok(readme.includes('plugin-install'), 'README 要写清怎么装');
      if (lang === 'py') {
        assert.match(readme, /requirements/, 'Python 样板要说明 requirements');
        assert.ok(readme.includes('网络模块一律拒收'), '不能把 net 权限写成允许直接 import 网络模块');
        assert.ok(readme.includes('联网只能走 `ctx.net.fetch`'));
      }

      // 不写本机绝对路径、不生成 node_modules
      for (const text of [manifestText, entry, readme]) {
        assert.equal(text.includes(target), false, '生成物里不能出现输出目录的绝对路径');
        assert.equal(text.includes(root), false, '生成物里不能出现本机临时目录');
        assert.doesNotMatch(text, /[A-Za-z]:\\/, '生成物里不能出现 Windows 绝对路径');
      }
      assert.equal(existsSync(join(target, 'node_modules')), false);
    });
  }

  test('同名 id 重复生成：产物逐字节相同（幂等，方便 diff）', () => {
    const root = tempDirSync('irmia-scaffold-idempotent-');
    const first = join(root, 'one');
    const second = join(root, 'two');
    createPlugin({ id: 'same-plugin', dir: first, name: '同一个' });
    createPlugin({ id: 'same-plugin', dir: second, name: '同一个' });
    for (const name of ['plugin.json', 'main.mjs', 'README.md']) {
      assert.equal(readFileSync(join(first, name), 'utf8'), readFileSync(join(second, name), 'utf8'), name);
    }
  });

  test('非法 id 与不支持的 lang：抛用法错误（退出码 2 的语义）', () => {
    const root = tempDirSync('irmia-scaffold-invalid-');
    for (const id of ['Upper', '_private', 'a'.repeat(65), 'a/b', '']) {
      assert.throws(
        () => createPlugin({ id, dir: join(root, 'x'), agentVersion: '0.1.0' }),
        (error: unknown) => error instanceof Error && /id|缺少/.test(error.message),
        id,
      );
    }
    assert.throws(
      () => createPlugin({ id: 'ok-id', lang: 'rust', dir: join(root, 'y'), agentVersion: '0.1.0' }),
      /--lang/,
    );
  });

  test('非空目录拒绝覆盖（说清原因），--force 才写且不删别人的文件', () => {
    const root = tempDirSync('irmia-scaffold-occupied-');
    const target = join(root, 'occupied');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'mine');

    assert.throws(
      () => createPlugin({ id: 'occupied-demo', dir: target, agentVersion: '0.1.0' }),
      (error: unknown) => error instanceof Error && /已存在且非空/.test(error.message) && /--force/.test(error.message),
    );
    assert.deepEqual(readdirSync(target), ['keep.txt'], '拒绝时一个文件都不能动');
    assert.equal(existsSync(join(target, 'plugin.json')), false);

    createPlugin({ id: 'occupied-demo', dir: target, force: true, agentVersion: '0.1.0' });
    assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'mine', '--force 不该删掉目录里原有的文件');
    const manifest = parsePluginManifest(JSON.parse(readFileSync(join(target, 'plugin.json'), 'utf8')));
    assert.equal(manifest.id, 'occupied-demo');
    assert.equal(manifest.engine.irmia, '>=0.1.0');
  });
});

describe('create-plugin · 命令行表面', () => {
  test('--help 自描述：用法、三种语言、--force、退出码 0/1/2 都写明', () => {
    const out: string[] = [];
    const err: string[] = [];
    const root = tempDirSync('irmia-scaffold-help-');
    assert.equal(runCli(['--help'], { cwd: root, stdout: (line) => out.push(line), stderr: (line) => err.push(line) }), EXIT_CODES.ok);
    const help = out.join('\n');
    assert.match(help, /用法/);
    assert.match(help, /js\|ts\|py/);
    assert.match(help, /--force/);
    assert.match(help, /退出码/);
    assert.match(help, /0\s+成功/);
    assert.match(help, /1\s+运行期失败/);
    assert.match(help, /2\s+用法错误/);
    assert.deepEqual(err, []);
  });

  test('退出码：缺 id / 非法 id / 坏 lang / 未知选项 / 缺值 → 2；非空目录 → 1；成功 → 0', () => {
    const root = tempDirSync('irmia-scaffold-cli-');
    const out: string[] = [];
    const err: string[] = [];
    const io = { cwd: root, stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) };

    for (const argv of [[], ['Bad_Id'], ['ok-id', '--lang', 'rust'], ['ok-id', '--nope'], ['ok-id', '--dir']]) {
      assert.equal(runCli(argv, io), EXIT_CODES.usage, argv.join(' '));
    }
    assert.ok(err.length > 0);
    assert.match(err.join('\n'), /用法错误/);

    const occupied = join(root, 'occupied-cli');
    mkdirSync(occupied);
    writeFileSync(join(occupied, 'keep.txt'), 'x');
    assert.equal(runCli(['occupied-cli', '--dir', occupied], io), EXIT_CODES.failure);
    assert.match(err.join('\n'), /拒绝覆盖/);

    out.length = 0;
    assert.equal(runCli(['cli-demo', '--lang=py', '--name', '命令行'], io), EXIT_CODES.ok);
    assert.match(out.join('\n'), /已生成插件 cli-demo/);
    assert.equal(existsSync(join(root, 'cli-demo', 'main.py')), true);
  });

  test('parseArgs：位置参数 + 两种 --lang 写法 + --force', () => {
    assert.deepEqual(parseArgs(['demo']), { id: 'demo', lang: 'js', dir: null, name: null, force: false, help: false });
    const parsed = parseArgs(['demo', '--lang=py', '--name', '你好', '--force']);
    assert.equal(parsed.id, 'demo');
    assert.equal(parsed.lang, 'py');
    assert.equal(parsed.name, '你好');
    assert.equal(parsed.force, true);
    assert.equal(parseArgs(['--help']).help, true);
  });

  test('生成的插件 id 与清单校验同口径（边界值两边都拒）', () => {
    // 与 manifest.ts 的 ID 正则同一组边界：合法的小写/数字/连字符/64 字符必须能生成，
    // 且生成结果一定能过 parsePluginManifest；大写、下划线、斜杠、65 字符都拒。
    const root = tempDirSync('irmia-scaffold-id-parity-');
    for (const id of ['a', '0', 'a-b-c', 'x'.repeat(64)]) {
      const target = join(root, id);
      createPlugin({ id, dir: target, agentVersion: '0.1.0' });
      const manifest = parsePluginManifest(JSON.parse(readFileSync(join(target, 'plugin.json'), 'utf8')));
      assert.equal(manifest.id, id);
    }
    for (const id of ['A', 'a_b', 'a b', 'a.b', 'x'.repeat(65)]) {
      assert.throws(() => createPlugin({ id, dir: join(root, 'bad'), agentVersion: '0.1.0' }));
    }
  });
});
