import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { createTestContext } from '../sdk/node/testing.mjs';
import { probePython } from '../src/plugin/runner-paths.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const SDK = resolve('sdk');
const TSC = resolve('node_modules/typescript/bin/tsc');

function compilePlugin(source: string): ReturnType<typeof spawnSync> {
  const dir = tempDirSync('irmia-plugin-sdk-compile-');
  writeFileSync(join(dir, 'main.ts'), source);
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      noEmit: true, skipLibCheck: false, baseUrl: dir,
      paths: {
        '@irmia/plugin-sdk': [join(SDK, 'node', 'index.d.ts')],
        '@irmia/plugin-sdk/testing': [join(SDK, 'node', 'testing.d.ts')],
      },
    },
    files: ['main.ts'],
  }));
  return spawnSync(process.execPath, [TSC, '-p', join(dir, 'tsconfig.json')], { encoding: 'utf8', timeout: 30_000 });
}

test('Node SDK：合法插件类型、Hook 与测试辅助均可编译', () => {
  const result = compilePlugin(`
    import type { PluginManifest, PluginModule } from '@irmia/plugin-sdk';
    import { createTestContext } from '@irmia/plugin-sdk/testing';
    export const manifest: PluginManifest = {
      apiVersion: 2, id: 'typed-plugin', version: '1.0.0', engine: { irmia: '>=0.1.0-beta.15' },
      runtime: { type: 'node', entry: 'main.ts' }, permissions: ['tools.define', 'hooks.model'],
    };
    const plugin: PluginModule = {
      async activate(ctx) {
        await ctx.tools.define<{ name?: string }>({
          name: 'hello', description: 'hello', sideEffect: 'none',
          handler: async (args) => ({ content: '你好，' + (args.name ?? '世界') }),
        });
        await ctx.hooks.on('model.request', async () => ({ systemSuffix: 'typed' }), { mode: 'blocking' });
        await ctx.hooks.on('turn.start', () => undefined, { mode: 'observe', errorPolicy: 'LOG' });
      },
      async deactivate(ctx) { await ctx.state.plugin.set('stopped', true); },
    };
    export default plugin;
    const testContext = createTestContext();
    void testContext.ctx;
  `);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('Node SDK：非法权限、Hook、模式和工具返回形状会被编译拒绝', () => {
  const result = compilePlugin(`
    import type { PluginManifest, PluginModule } from '@irmia/plugin-sdk';
    const manifest: PluginManifest = {
      apiVersion: 2, id: 'bad-types', version: '1.0.0', engine: { irmia: '>=0.1.0-beta.15' },
      runtime: { type: 'node', entry: 'main.ts' }, permissions: ['shell'],
    };
    const plugin: PluginModule = { async activate(ctx) {
      await ctx.tools.define({ name: 'bad', description: 'bad', handler: async () => ({ content: 42 }) });
      await ctx.hooks.on('does.not.exist', () => undefined);
      await ctx.hooks.on('turn.start', () => undefined, { mode: 'blocking', errorPolicy: 'ABORT' });
    } };
    void manifest; void plugin;
  `);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /shell/);
  assert.match(output, /does\.not\.exist/);
  assert.match(output, /content/);
});

test('Node testing：真实示例可在内存 ctx 中做 handler 单元测试', async () => {
  const { ctx, tools, fileData } = createTestContext();
  const example = await import('../examples/hello-tool/main.mjs');
  await example.activate(ctx);
  const result = await tools.get('hello')!.handler({ name: 'SDK' });
  assert.equal(result.content, '你好，SDK！');
  await ctx.files.write('notes/test.txt', 'ok');
  assert.equal(await ctx.files.read('notes/test.txt'), 'ok');
  assert.equal(fileData.has('notes/test.txt'), true);
  await assert.rejects(ctx.net.fetch('https://example.com'), (error: unknown) => (error as { code?: number }).code === -32006);
});

test('Python 存根与公开契约同形，且是合法 Python 类型存根语法', () => {
  const stub = readFileSync(join(SDK, 'python', 'irmia_plugin.pyi'), 'utf8');
  const contract = JSON.parse(readFileSync(join(SDK, 'contract.json'), 'utf8'));
  for (const item of contract.hooks) assert.ok(stub.includes(`'${item.point}'`), `Python 存根缺 ${item.point}`);
  for (const item of contract.permissions) assert.ok(stub.includes(`'${item.permission}'`), `Python 存根缺 ${item.permission}`);
  const probe = probePython();
  if (!probe.available) return;
  const parsed = spawnSync(probe.binary, ['-I', '-c', 'import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))', join(SDK, 'python', 'irmia_plugin.pyi')], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(parsed.status, 0, parsed.stderr);
});
