/**
 * 半开探针的判据 —— `src/main.ts` 的 `createPluginProbe`
 *
 * 这一份**不起任何真 MCP 进程**（也不碰真实数据目录）：探测池由测试替身代替，真进程的
 * 连带行为不在单测范围内。要守住的四条判据，每条都对应一个真实故障形状：
 *
 *   ① **只探原故障贡献**：包里别的 MCP server 没坏，不该为了复核一条而把它们都拉起来；
 *   ② **独立短预算**：探测压在 turn 边界与退出路径上，不能沿用常驻池 120s/600s 的耐心；
 *   ③ **可取消、且取消不是失败**：退出时先关掉在飞的探测池，探针以 `PluginProbeCancelledError`
 *      fast-fail（熔断器只还原隔离态、不记 strike）；真实的启动失败仍然走普通错误、照常归因；
 *   ④ **找不到贡献要报错**：错误里带贡献名，熔断器才能继续退避、日志才说得清探的是哪一条。
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createPluginProbe, type PluginProbePool } from '../src/main.ts';
import type { McpClientPoolOptions } from '../src/mcp/client.ts';
import { PluginProbeCancelledError } from '../src/plugin/failures.ts';
import type { PluginView } from '../src/plugin/manager.ts';
import type { PluginPackage } from '../src/plugin/package-store.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const HASH = 'a'.repeat(64);

function packageOf(rootDir: string, contributions: { skills: readonly string[]; hooks?: string; mcp?: string }): PluginPackage {
  return {
    rootDir,
    contentHash: HASH,
    fileCount: 1,
    totalBytes: 1,
    manifest: {
      apiVersion: 1, id: 'demo', version: '1.0.0',
      engine: { irmia: '>=0.1.0' }, contributions, permissions: [],
    },
  };
}

function probingView(pkg: PluginPackage, contributionKind: string, contributionName: string): PluginView {
  return {
    package: pkg,
    state: 'probing',
    problems: [],
    requiresRestart: false,
    circuit: {
      state: 'probing', contributionKind, contributionName,
      category: 'timeout', count: 3, lastError: 'request timed out', strikes: 1,
    },
  };
}

/** probe 失败时把错误取出来（成功则返回 null），省掉每处 `assert.rejects` 的样板。 */
async function probeError(handle: ReturnType<typeof createPluginProbe>, id = 'demo', hash = HASH): Promise<Error | null> {
  return await handle.probe(id, hash).then(() => null, (reason: unknown) => reason as Error);
}

test('只连故障贡献那一条 server，并用独立的短预算建池', async () => {
  const root = tempDirSync('irmia-probe-mcp-');
  writeFileSync(join(root, 'mcp.json'), JSON.stringify([
    { name: 'chat', command: 'node', args: ['chat.mjs'] },
    { name: 'search', command: 'node', args: ['search.mjs'] },
  ]));
  const pkg = packageOf(root, { skills: [], mcp: 'mcp.json' });
  const options: McpClientPoolOptions[] = [];
  const called: string[] = [];
  const handle = createPluginProbe({
    list: () => [probingView(pkg, 'mcp', 'demo__search')],
    dataDir: root,
    write: () => {},
    createPool: (value): PluginProbePool => {
      options.push(value);
      return {
        listTools: async (name) => { called.push(name); return []; },
        shutdown: async () => {},
      };
    },
  });

  await handle.probe('demo', HASH);

  assert.equal(options.length, 1, '只该建一个探测池');
  assert.deepEqual(options[0]!.servers.map((server) => server.name), ['demo__search']);
  assert.equal(options[0]!.requestTimeoutMs, 15_000);
  assert.equal(options[0]!.progressHardCapMs, 30_000);
  assert.deepEqual(called, ['demo__search'], '除了故障贡献，别的 server 一个都不该连');
});

test('故障贡献名指向不存在的 server 时抛错，且错误里带贡献名', async () => {
  const root = tempDirSync('irmia-probe-missing-');
  writeFileSync(join(root, 'mcp.json'), JSON.stringify([{ name: 'chat', command: 'node', args: ['chat.mjs'] }]));
  const pkg = packageOf(root, { skills: [], mcp: 'mcp.json' });
  const handle = createPluginProbe({
    list: () => [probingView(pkg, 'mcp', 'demo__gone')],
    dataDir: root,
    write: () => {},
    createPool: () => { throw new Error('找不到贡献时不该建探测池'); },
  });

  const error = await probeError(handle);
  assert.ok(error instanceof Error, '找不到对应贡献必须失败，不能静默算成功');
  assert.equal(error instanceof PluginProbeCancelledError, false, '这不是宿主取消，不能被当成取消');
  assert.match(error.message, /demo__gone/);
  assert.match(error.message, /demo__chat/, '错误里要说清当前声明了哪些 server');
});

test('Hook 贡献不由探针复核：显式报出路由错误，且不起进程', async () => {
  // 依据：`circuit-breaker.drainOnce` 对 hook 是 `dirty = true; continue;`（不进 runProbe），
  // hook 的复核由 `composePluginRuntime` 把条目送进 HookRunner、在 turn 边界回写成功/失败。
  // 所以探针这条分支今天不该被走到；真走到了要当场看见"路由错了"，而不是伪造一次复核结果。
  const root = tempDirSync('irmia-probe-hook-');
  writeFileSync(join(root, 'hooks.json'), JSON.stringify([{ hook: 'Wake', matcher: 'manual', command: 'node hook.mjs' }]));
  const pkg = packageOf(root, { skills: [], hooks: 'hooks.json' });
  const pools: McpClientPoolOptions[] = [];
  const handle = createPluginProbe({
    list: () => [probingView(pkg, 'hook', 'Wake:manual')],
    dataDir: root,
    write: () => {},
    createPool: (value): PluginProbePool => { pools.push(value); throw new Error('Hook 不该建 MCP 池'); },
  });

  const error = await probeError(handle);
  assert.ok(error instanceof Error);
  assert.equal(error instanceof PluginProbeCancelledError, false);
  assert.match(error.message, /HookRunner/);
  assert.deepEqual(pools, [], 'Hook 不该起任何进程');
});

test('Skill 贡献只校验声明的根目录可读，不起 MCP', async () => {
  const root = tempDirSync('irmia-probe-skill-');
  mkdirSync(join(root, 'skills'));
  const pkg = packageOf(root, { skills: ['skills'] });

  const pools: McpClientPoolOptions[] = [];
  const handle = createPluginProbe({
    list: () => [probingView(pkg, 'skill', 'skills')],
    dataDir: root,
    write: () => {},
    createPool: (value): PluginProbePool => { pools.push(value); throw new Error('Skill 探针不该建 MCP 池'); },
  });
  await handle.probe('demo', HASH);
  assert.deepEqual(pools, [], 'Skill 探针只核对目录，不起 MCP');

  // 声明里有、贡献名却对不上：必须报错而不是静默通过。
  const undeclared = createPluginProbe({
    list: () => [probingView(pkg, 'skill', 'skills-gone')],
    dataDir: root,
    write: () => {},
    createPool: () => { throw new Error('Skill 探针不该建 MCP 池'); },
  });
  const missing = await probeError(undeclared);
  assert.ok(missing instanceof Error);
  assert.match(missing.message, /skills-gone/);

  // 声明里有、目录却读不到：同样必须报错（这里用"目录不存在"这个不用改权限的形状）。
  const emptyRoot = tempDirSync('irmia-probe-skill-gone-');
  const brokenPkg = packageOf(emptyRoot, { skills: ['skills'] });
  const broken = createPluginProbe({
    list: () => [probingView(brokenPkg, 'skill', 'skills')],
    dataDir: emptyRoot,
    write: () => {},
    createPool: () => { throw new Error('Skill 探针不该建 MCP 池'); },
  });
  const unreadable = await probeError(broken);
  assert.ok(unreadable instanceof Error);
  assert.match(unreadable.message, /不可读/);
});

test('探测池里的真实失败仍是普通错误，不会被当成取消', async () => {
  const root = tempDirSync('irmia-probe-real-failure-');
  writeFileSync(join(root, 'mcp.json'), JSON.stringify([{ name: 'chat', command: 'node', args: ['chat.mjs'] }]));
  const pkg = packageOf(root, { skills: [], mcp: 'mcp.json' });
  const handle = createPluginProbe({
    list: () => [probingView(pkg, 'mcp', 'demo__chat')],
    dataDir: root,
    write: () => {},
    createPool: (): PluginProbePool => ({
      listTools: async () => { throw new Error('server 起不来'); },
      shutdown: async () => {},
    }),
  });

  const error = await probeError(handle);
  assert.ok(error instanceof Error);
  assert.equal(error instanceof PluginProbeCancelledError, false, '没关停却被标成取消，会掩盖真实故障');
  assert.match(error.message, /server 起不来/, '原始失败原因要原样上抛');
});

test('关停时先取消在飞探测：探测池被 shutdown，探针立刻失败而不是等满预算', async () => {
  const root = tempDirSync('irmia-probe-cancel-');
  writeFileSync(join(root, 'mcp.json'), JSON.stringify([{ name: 'chat', command: 'node', args: ['chat.mjs'] }]));
  const pkg = packageOf(root, { skills: [], mcp: 'mcp.json' });
  let shutdowns = 0;
  let rejectListTools: ((error: Error) => void) | undefined;
  const handle = createPluginProbe({
    list: () => [probingView(pkg, 'mcp', 'demo__chat')],
    dataDir: root,
    write: () => {},
    createPool: (): PluginProbePool => ({
      listTools: async () => await new Promise<unknown>((_resolve, reject) => { rejectListTools = reject; }),
      shutdown: async () => {
        shutdowns += 1;
        rejectListTools?.(new Error('probe pool shutdown'));
      },
    }),
  });

  const pending = probeError(handle);
  // 先让 `probe` 走到 `listTools` 的 await 上，再模拟退出流程里的取消。
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  await handle.cancelAll();
  const cancelled = await pending;
  assert.ok(cancelled instanceof PluginProbeCancelledError, '关停导致的中止必须抛取消类型，熔断器才不记 strike');
  assert.match(cancelled.message, /shutdown/);
  assert.ok(shutdowns >= 1, 'cancelAll 必须真的 shutdown 探测池');

  // 取消之后再来的探针不再起池，同样以"取消"快速收场。
  const after = await probeError(handle);
  assert.ok(after instanceof PluginProbeCancelledError);
  assert.match(after.message, /关停/);
});

test('取消路径上 shutdown 自己的异常不会盖掉"取消"判定', async () => {
  // 危险路径：catch 里刚抛 `PluginProbeCancelledError`，finally 里 `shutdown()` 又抛 ——
  // JS 会用 finally 的异常覆盖它，熔断器于是把"宿主收摊"记成真实失败。这条守住那个覆盖。
  const root = tempDirSync('irmia-probe-cancel-shutdown-');
  writeFileSync(join(root, 'mcp.json'), JSON.stringify([{ name: 'chat', command: 'node', args: ['chat.mjs'] }]));
  const pkg = packageOf(root, { skills: [], mcp: 'mcp.json' });
  let rejectListTools: ((error: Error) => void) | undefined;
  const handle = createPluginProbe({
    list: () => [probingView(pkg, 'mcp', 'demo__chat')],
    dataDir: root,
    write: () => {},
    createPool: (): PluginProbePool => ({
      listTools: async () => await new Promise<unknown>((_resolve, reject) => { rejectListTools = reject; }),
      shutdown: async () => {
        rejectListTools?.(new Error('probe pool shutdown'));
        rejectListTools = undefined;
        throw new Error('shutdown 本身也不顺利');
      },
    }),
  });

  const pending = probeError(handle);
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  await handle.cancelAll(); // 池 shutdown 的异常在 cancelAll 里被 allSettled 收掉
  const error = await pending;
  assert.ok(error instanceof PluginProbeCancelledError, 'finally 的 shutdown 异常不能把取消改写成失败');
});
