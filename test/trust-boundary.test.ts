/**
 * Irmia Agent — 信任边界（`config.trust.mode`）**执行路径**测试
 *
 * 覆盖用户的两条要求：「能够触碰整个电脑是默认行为」（`'full'`）与「完全信任 / 工作目录」
 * （`'workspace'` 时 fs 工具族与 pwsh **一起**只允许在 `trust.workspaceRoot` 内）。
 * 设计口径见 `docs/`（配置那一半）与 `src/tools/boundary.ts`（执行那一半）。
 *
 * 这个文件刻意**不重复**既有测试台：`test/fs-tools.test.ts` 里那些用例不传 `boundaryRoot`，
 * 它们继续证明"默认仍然是受限的"（本文件最后也自己钉一条，免得将来有人把默认值改了却没人发现）。
 *
 * 三条纪律：
 *   · 越界用例一律用**真实临时目录**（`$env:TEMP` 下的夹具），不打桩路径——只有让内核真的
 *     解析 `..` 与符号链接，"拒绝"才不是因为路径拼错；
 *   · 断言拒绝的**理由**（边界在哪、怎么改），不只断言 `isError`：一句说不清下一步的拒绝
 *     会让她在同一个地方反复重试；
 *   · `'full'` 那一档必须真的**碰得到**工作根之外——这是"完全信任"唯一可验证的形态。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { trustBoundaryRoot } from '../src/config/config.ts';
import { DepsManager } from '../src/deps/manager.ts';
import { comparisonKey, effectiveBoundaryRoot, isInside } from '../src/tools/boundary.ts';
import { executeToolCalls, type ExecutionContext } from '../src/tools/executor.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import {
  FS_ERROR_CODES,
  fsTools,
  resolveInsideRoot,
  type ToolContext,
  type ToolDefinition,
  type ToolHandlerResult,
} from '../src/tools/fs/index.ts';
import {
  absolutePathLiteralsIn,
  commandPathBoundaryError,
  createPwshTool,
  workdirBoundaryError,
  type PwshToolDefinition,
} from '../src/tools/pwsh.ts';

// ──────────────────────────────── 测试脚手架 ────────────────────────────────

/** 三个真实目录：工作根、工作根之外（`$env:TEMP` 下的夹具）、workspace 模式的边界根 */
let root = '';
let outside = '';
let boundary = '';

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'irmia-trust-ws-'));
  outside = await mkdtemp(join(tmpdir(), 'irmia-trust-out-'));
  boundary = await mkdtemp(join(tmpdir(), 'irmia-trust-bound-'));
  // 只读区用例要一个真实的 skills/ 目录（相对工作根），否则它测不到"前缀命中"
  await mkdir(join(root, 'skills'), { recursive: true });
});

after(async () => {
  for (const dir of [root, outside, boundary]) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  }
});

interface Harness {
  tool(name: string): ToolDefinition;
  /** 默认 ctx：**不传 `boundaryRoot`**（既有装配与既有测试台的历史口径） */
  ctx(patch?: Partial<ToolContext>): ToolContext;
}

/**
 * 装配一份 fs 工具集。依赖探测注入成"都没有"：这两条用例与 rg/es 无关，
 * 而让它们去碰真机探测既慢又不确定（绝不能让用例依赖本机装没装）。
 */
async function makeHarness(): Promise<Harness> {
  const table = new Map<string, ToolDefinition>();
  const deps = new DepsManager({
    dataDir: join(root, 'data'),
    probe: async (name) => ({
      name,
      status: 'missing' as const,
      path: '',
      version: '',
      anyVersion: '',
      source: null,
      dir: null,
      reason: `测试环境：${name} 不可用`,
      attempts: [`test: ${name} 不参与本组用例`],
    }),
  });
  await fsTools(
    { register: (tool) => table.set(tool.name, tool) },
    // 备份根塞进临时目录：这条用例不该往真实 home 里写东西
    { backupDir: join(root, '.backups'), ripgrepPath: null, everythingPath: null, deps },
    {},
  );

  const ctx = (patch: Partial<ToolContext> = {}): ToolContext => ({
    callId: 'call-trust',
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    workspaceRoot: root,
    ...patch,
  });

  return {
    tool: (name) => {
      const tool = table.get(name);
      assert.ok(tool !== undefined, `工具 ${name} 未注册`);
      return tool;
    },
    ctx,
  };
}

type Ctx = ToolContext;

function run(tool: ToolDefinition, ctx: Ctx, args: unknown): Promise<ToolHandlerResult> {
  return tool.handler(args, ctx);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** 拒绝消息必须说清三件事：边界在哪、为什么、怎么改 */
function assertBoundaryDenial(result: ToolHandlerResult, boundaryPath: string): void {
  assert.equal(result.isError, true, `本该被拒，实际：${result.content}`);
  assert.equal(result.error?.code, FS_ERROR_CODES.PATH_DENIED);
  // 比路径用 comparisonKey（Windows 上折叠大小写与分隔符）：判定与断言读的是同一条口径，
  // 而消息里的边界是**异步 realpath 的规范大小写**（`C:\Windows\Temp` vs `C:\WINDOWS\TEMP`）
  assert.ok(
    comparisonKey(result.content).includes(comparisonKey(boundaryPath)),
    `拒绝消息里必须写出边界在哪：${result.content}`,
  );
  assert.match(result.content, /trust\.mode/u);
  assert.match(result.content, /改成 'full'/u);
}

// ──────────────────────────────── 判据只有一处 ────────────────────────────────

describe('活动边界 · 三态决议只有一处', () => {
  it('undefined = 保持历史行为（拿 workspaceRoot 当边界）', () => {
    assert.equal(effectiveBoundaryRoot({ workspaceRoot: 'R' }), 'R');
  });

  it('null = 不设边界（完全信任）', () => {
    assert.equal(effectiveBoundaryRoot({ workspaceRoot: 'R', boundaryRoot: null }), null);
  });

  it('string = 用这个根当边界', () => {
    assert.equal(effectiveBoundaryRoot({ workspaceRoot: 'R', boundaryRoot: 'B' }), 'B');
  });

  it("config.trust → 边界：'full' 不设边界，'workspace' 只限 workspaceRoot", () => {
    assert.equal(trustBoundaryRoot({ mode: 'full', workspaceRoot: 'W' }), null);
    assert.equal(trustBoundaryRoot({ mode: 'workspace', workspaceRoot: 'W' }), 'W');
  });

  it('前缀比较仍然是"带分隔符 + Windows 折叠大小写"那一套（pwsh 与 fs 共用同一份）', () => {
    assert.ok(isInside('C:\\work', 'C:\\work\\a.txt'));
    assert.ok(!isInside('C:\\work', 'C:\\workspace-evil\\a.txt'));
  });
});

// ──────────────────────────────── 完全信任（full） ────────────────────────────────

describe('完全信任 · 工作根之外的文件真的能碰', () => {
  it('safe_write：在工作根之外的临时目录里新建文件', async (t) => {
    const h = await makeHarness();
    const target = join(outside, 'full-new.txt');

    const result = await run(h.tool('safe_write'), h.ctx({ boundaryRoot: null }), {
      path: target,
      content: '完全信任：写在工作根之外',
    });

    assert.notEqual(result.isError, true, result.content);
    assert.equal(await readFile(target, 'utf8'), '完全信任：写在工作根之外');
    t.diagnostic(`已实测：boundaryRoot=null 时成功写入 ${target}`);
  });

  it('safe_read：读工作根之外的文件', async (t) => {
    const h = await makeHarness();
    const target = join(outside, 'full-read.txt');
    await writeFile(target, '外面的内容', 'utf8');

    const result = await run(h.tool('safe_read'), h.ctx({ boundaryRoot: null }), { path: target });

    assert.notEqual(result.isError, true, result.content);
    assert.match(result.content, /外面的内容/u);
    t.diagnostic(`已实测：boundaryRoot=null 时成功读取 ${target}`);
  });

  it('safe_read 传目录：列工作根之外的目录（v42：列目录并进 safe_read）', async () => {
    const h = await makeHarness();
    await writeFile(join(outside, 'listed.txt'), 'x', 'utf8');

    const result = await run(h.tool('safe_read'), h.ctx({ boundaryRoot: null }), { path: outside });

    assert.notEqual(result.isError, true, result.content);
    assert.match(result.content, /listed\.txt/u);
  });

  it('指向工作根之外的符号链接：完全信任下按 realpath 的落点照常读', async () => {
    const h = await makeHarness();
    await writeFile(join(outside, 'linked-secret.txt'), 'LINKED', 'utf8');
    const link = join(root, 'link-out');
    await symlink(outside, link, 'junction');

    const result = await run(h.tool('safe_read'), h.ctx({ boundaryRoot: null }), {
      path: join(link, 'linked-secret.txt'),
    });

    assert.notEqual(result.isError, true, result.content);
    assert.match(result.content, /LINKED/u);
  });
});

// ──────────────────────────────── 只限工作目录（workspace） ────────────────────────────────

describe('只限工作目录 · 同样的路径被拒绝，且理由说清边界在哪', () => {
  it('safe_write 越界被拒，且一个字节都没落盘', async () => {
    const h = await makeHarness();
    const target = join(outside, 'workspace-new.txt');

    const result = await run(h.tool('safe_write'), h.ctx({ boundaryRoot: boundary }), {
      path: target,
      content: '不该被写出来',
    });

    assertBoundaryDenial(result, boundary);
    assert.equal(await exists(target), false, '被拒绝的写入不得留下文件');
  });

  it('safe_read 越界被拒', async () => {
    const h = await makeHarness();
    const target = join(outside, 'workspace-read.txt');
    await writeFile(target, '外面', 'utf8');

    const result = await run(h.tool('safe_read'), h.ctx({ boundaryRoot: boundary }), { path: target });

    assertBoundaryDenial(result, boundary);
  });

  it('safe_read 传目录越界同样被拒（列目录不是绕过边界的第二条路）', async () => {
    const h = await makeHarness();
    const result = await run(h.tool('safe_read'), h.ctx({ boundaryRoot: boundary }), { path: outside });
    assertBoundaryDenial(result, boundary);
  });

  it('边界内照旧可用（拒绝的是越界，不是把这个模式弄坏）', async () => {
    const h = await makeHarness();
    const target = join(boundary, 'inside.txt');
    const write = await run(h.tool('safe_write'), h.ctx({ boundaryRoot: boundary }), {
      path: target,
      content: '边界内',
    });
    assert.notEqual(write.isError, true, write.content);

    const read = await run(h.tool('safe_read'), h.ctx({ boundaryRoot: boundary }), { path: target });
    assert.notEqual(read.isError, true, read.content);
    assert.match(read.content, /边界内/u);
  });

  it('符号链接指向边界外：workspace 模式下照旧被拒（realpath 之后才比边界）', async () => {
    const h = await makeHarness();
    await writeFile(join(outside, 'linked-secret.txt'), 'LINKED', 'utf8');
    const link = join(boundary, 'link-out');
    await symlink(outside, link, 'junction');

    const result = await run(h.tool('safe_read'), h.ctx({ boundaryRoot: boundary }), {
      path: join(link, 'linked-secret.txt'),
    });

    assertBoundaryDenial(result, boundary);
  });

  it('边界根本身不可用时报清楚它不可用（不是含混的"路径被拒"）', async () => {
    const h = await makeHarness();
    const missing = join(outside, 'no-such-boundary-dir');
    const result = await run(h.tool('safe_read'), h.ctx({ boundaryRoot: missing }), {
      path: join(boundary, 'inside.txt'),
    });
    assert.equal(result.isError, true);
    assert.match(result.content, /信任边界根不可用/u);
    assert.match(result.content, /trust\.mode/u);
  });
});

// ──────────── workspace 档的默认边界 = 智能体自己的工作根（2026-10-05 定） ────────────
//
// 这一组治的是一个**默认值错误**：`trust.workspaceRoot` 原来的默认是 `<配置目录>/workspace`，
// 而她的记忆（`<dataDir>/workspace/MEMORIES/`）与人格资产（`<dataDir>/persona/`）都长在
// 配置目录之下、那个 `workspace/` 之**外**——于是 `mode: 'workspace'` 下她连自己的记忆都
// `safe_read` 不到。那不是"只限工作目录"，是把她锁在门外。
//
// 现在的默认 = **配置目录本身**（配置那一半的 `buildDefaults`），也正是 fs 工具族今天用的
// 那个根（`agent-loop.ts` 的 `deps.workspaceRoot ?? process.cwd()`）。语义因此干净：
// **`workspace` = 今天的行为**、**`full` = 新放开的那一档**。
// 这组用例按**默认口径**摆盘：工作根 = 临时目录，dataDir = `<工作根>/data`（与出厂一致）。

describe('workspace 档 · 默认边界（= 工作根）下，她自己的资产读得到、外面进不去', () => {
  /** 与真实出厂布局同形：记忆在 `<工作根>/data/workspace/MEMORIES/`，人格在 `<工作根>/data/persona/` */
  async function assetHarness(): Promise<{ h: Harness; memoryFile: string; personaFile: string }> {
    const h = await makeHarness();
    await mkdir(join(root, 'data', 'workspace', 'MEMORIES'), { recursive: true });
    await mkdir(join(root, 'data', 'persona'), { recursive: true });
    const memoryFile = join(root, 'data', 'workspace', 'MEMORIES', 'facts.md');
    const personaFile = join(root, 'data', 'persona', 'STATE.md');
    await writeFile(memoryFile, '记忆里的一条事实\n', 'utf8');
    await writeFile(personaFile, '# 状态\n心情：不错\n', 'utf8');
    return { h, memoryFile, personaFile };
  }

  it('记忆与人格资产都可读：MEMORIES/ 与 persona/ 两种写法都通', async () => {
    const { h } = await assetHarness();
    const ctx = h.ctx({ boundaryRoot: root }); // 默认口径：边界 = 工作根

    // ① 别名写法（她自己的书写习惯）：MEMORIES/facts.md → <dataDir>/workspace/MEMORIES/facts.md
    const memory = await run(h.tool('safe_read'), ctx, { path: 'MEMORIES/facts.md' });
    assert.notEqual(memory.isError, true, `记忆必须读得到（旧默认下这条会被边界拒）：${memory.content}`);
    assert.match(memory.content, /记忆里的一条事实/u);

    // ② persona/STATE.md 同样走别名落到 <dataDir>/persona/
    const persona = await run(h.tool('safe_read'), ctx, { path: 'persona/STATE.md' });
    assert.notEqual(persona.isError, true, `人格资产必须读得到：${persona.content}`);
    assert.match(persona.content, /心情：不错/u);

    // ③ 绝对路径写法（记忆目录的真实位置）也通
    const absolute = await run(h.tool('safe_read'), ctx, {
      path: join(root, 'data', 'workspace', 'MEMORIES', 'facts.md'),
    });
    assert.notEqual(absolute.isError, true, absolute.content);
  });

  it('同一个档下，工作根之外照旧被拒（"读得到自己的资产"不等于放开了边界）', async () => {
    const { h } = await assetHarness();
    const ctx = h.ctx({ boundaryRoot: root });

    const read = await run(h.tool('safe_read'), ctx, { path: join(outside, 'secret.txt') });
    const list = await run(h.tool('safe_read'), ctx, { path: outside });

    for (const result of [read, list]) {
      assertBoundaryDenial(result, root);
    }
  });
});

// ──────────────────────────────── 默认仍是受限（回归钉子） ────────────────────────────────

describe('回归钉：不传 boundaryRoot 的调用点一条都不许被打开', () => {
  it('safe_read / safe_write 在工作根之外全被拒绝（历史口径原样）', async () => {
    const h = await makeHarness();
    const plain = h.ctx(); // 刻意不带 boundaryRoot
    assert.equal('boundaryRoot' in plain, false, '这条用例的前提就是不传它');

    const read = await run(h.tool('safe_read'), plain, { path: join(outside, 'whatever.txt') });
    const write = await run(h.tool('safe_write'), plain, { path: join(outside, 'pwn.txt'), content: 'x' });
    // 目录形态走的是同一条 resolveGuarded（`allowDirectory` 只改"收不收目录"，
    // **边界那一条一个字没松**）——所以它必须同样被拒，措辞也是同一句
    const list = await run(h.tool('safe_read'), plain, { path: outside });

    for (const [name, result] of [['safe_read', read], ['safe_write', write], ['safe_read（目录）', list]] as const) {
      assert.equal(result.isError, true, `${name} 本该被拒：${result.content}`);
      assert.equal(result.error?.code, FS_ERROR_CODES.PATH_DENIED, name);
      // 历史措辞原样保留（既有 fs 测试按它断言）
      assert.match(result.content, /落在工作目录/u, name);
    }
    assert.equal(await exists(join(outside, 'pwn.txt')), false);
  });

  it('resolveInsideRoot：不设边界只跳过"必须在根内"，其余守卫一条不少', async () => {
    // ① 越界：完全信任后放行（这是被测的那一条被跳过）
    const outsideFile = join(outside, 'x.txt');
    await writeFile(outsideFile, 'x', 'utf8');
    const allowed = await resolveInsideRoot(root, outsideFile, { boundaryRoot: null });
    assert.equal(allowed.ok, true, JSON.stringify(allowed));
    assert.equal(allowed.ok ? allowed.existed : false, true, '存在性判定照旧（stat 那一步没被跳过）');
    assert.equal(allowed.ok ? allowed.path : '', await realpath(outsideFile));

    // ② 保留设备名：照旧拒绝
    const device = await resolveInsideRoot(root, 'NUL', { boundaryRoot: null });
    assert.equal(device.ok, false);
    assert.match(device.ok ? '' : device.reason, /保留设备名/u);

    // ③ NUL 字节：照旧拒绝
    const nul = await resolveInsideRoot(root, 'a\0b', { boundaryRoot: null });
    assert.equal(nul.ok, false);

    // ④ 目标类型与存在性：照旧拒绝（这条同时证明 realpath/stat 那两步没被跳过）
    const missing = await resolveInsideRoot(root, join(outside, 'nope.txt'), { boundaryRoot: null });
    assert.equal(missing.ok, false);
    assert.equal(missing.ok ? '' : missing.code, FS_ERROR_CODES.NOT_FOUND);

    // ⑤ 相对路径的解析基准仍是工作根（不是 cwd、也不是边界）
    const relativeTarget = await resolveInsideRoot(root, 'inside-relative.txt', {
      boundaryRoot: null,
      allowMissing: true,
    });
    assert.equal(relativeTarget.ok, true);
    assert.equal(relativeTarget.ok ? relativeTarget.path : '', join(await realpath(root), 'inside-relative.txt'));
  });
});

// ──────────────────────────────── "改什么"的门在两种模式下一致 ────────────────────────────────

describe('"改什么"的门与边界无关：两种模式下行为一致', () => {
  it('覆盖门：既有文件默认拒绝整体覆盖（full 与 workspace 同码同理由）', async () => {
    const h = await makeHarness();
    const target = join(boundary, 'existing.txt');
    await writeFile(target, '原有内容', 'utf8');

    const inFull = await run(h.tool('safe_write'), h.ctx({ boundaryRoot: null }), {
      path: target,
      content: '整篇覆盖',
    });
    const inWorkspace = await run(h.tool('safe_write'), h.ctx({ boundaryRoot: boundary }), {
      path: target,
      content: '整篇覆盖',
    });

    for (const result of [inFull, inWorkspace]) {
      assert.equal(result.isError, true, result.content);
      assert.equal(result.error?.code, FS_ERROR_CODES.FILE_EXISTS);
      assert.match(result.content, /overwrite:true/u);
    }
    assert.equal(await readFile(target, 'utf8'), '原有内容', '被拒的覆盖不得改动文件');
  });

  it('只读区：skills/ 在完全信任下**依然**不可写（边界换了，"改什么"没换）', async () => {
    const h = await makeHarness();
    const target = join(root, 'skills', 'owned.md');
    // 两种模式都用"边界=工作根"，好让同一个只读区目标在两边都到得了
    // （边界设在别处时，workspace 模式会先被边界拦下，那就测不到只读区这道门了）
    const inFull = await run(h.tool('safe_write'), h.ctx({ boundaryRoot: null }), {
      path: target,
      content: 'x',
    });
    const inWorkspace = await run(h.tool('safe_write'), h.ctx({ boundaryRoot: root }), {
      path: target,
      content: 'x',
    });

    for (const result of [inFull, inWorkspace]) {
      assert.equal(result.isError, true, result.content);
      assert.equal(result.error?.code, FS_ERROR_CODES.PATH_DENIED);
      assert.match(result.content, /只读区/u);
    }
    assert.equal(await exists(target), false);
  });

  it('备份与回滚：工作根之外（full）与边界之内（workspace）都能退回去', async () => {
    const h = await makeHarness();

    // ① full：目标在工作根之外——备份仍要落在备份根内（相对路径被逐段转义），回滚仍要能读回来
    const outTarget = join(outside, 'rollback-me.txt');
    await run(h.tool('safe_write'), h.ctx({ boundaryRoot: null }), {
      path: outTarget,
      content: 'v1',
      overwrite: true,
    });
    await run(h.tool('safe_write'), h.ctx({ boundaryRoot: null }), {
      path: outTarget,
      content: 'v2',
      overwrite: true,
    });
    assert.equal(await readFile(outTarget, 'utf8'), 'v2');
    const rolledOut = await run(h.tool('safe_rollback'), h.ctx({ boundaryRoot: null }), { path: outTarget });
    assert.notEqual(rolledOut.isError, true, rolledOut.content);
    assert.equal(await readFile(outTarget, 'utf8'), 'v1');

    // ② workspace：同样两写一回滚，目标在边界之内
    const inTarget = join(boundary, 'rollback-me.txt');
    await run(h.tool('safe_write'), h.ctx({ boundaryRoot: boundary }), {
      path: inTarget,
      content: 'v1',
      overwrite: true,
    });
    await run(h.tool('safe_write'), h.ctx({ boundaryRoot: boundary }), {
      path: inTarget,
      content: 'v2',
      overwrite: true,
    });
    const rolledIn = await run(h.tool('safe_rollback'), h.ctx({ boundaryRoot: boundary }), { path: inTarget });
    assert.notEqual(rolledIn.isError, true, rolledIn.content);
    assert.equal(await readFile(inTarget, 'utf8'), 'v1');
  });
});

// ──────────────────────────────── pwsh ────────────────────────────────

describe('pwsh · 命令行里的绝对路径与 workdir（workspace 模式才拦）', () => {
  it('absolutePathLiteralsIn：认出盘符与 UNC 字面量，带引号的路径不会被空格切断', () => {
    assert.deepEqual(absolutePathLiteralsIn('Write-Output hi'), []);
    assert.deepEqual(absolutePathLiteralsIn("Get-Content 'C:\\Windows\\win.ini'"), ['C:\\Windows\\win.ini']);
    assert.deepEqual(
      absolutePathLiteralsIn('Get-Content "C:\\Program Files\\a b.txt"'),
      ['C:\\Program Files\\a b.txt'],
    );
    assert.deepEqual(absolutePathLiteralsIn('cd C:/temp; ls'), ['C:/temp']);
    assert.deepEqual(absolutePathLiteralsIn('Get-Content \\\\server\\share\\x.txt'), ['\\\\server\\share\\x.txt']);
  });

  it('workdir 越界的拒绝原因：写清边界在哪、怎么改、默认会用哪儿', () => {
    const message = workdirBoundaryError(outside, boundary);
    assert.ok(message !== null);
    assert.ok(message.includes(boundary));
    assert.match(message, /trust\.mode/u);
    assert.match(message, /改成 'full'/u);
    assert.ok(workdirBoundaryError(boundary, boundary) === null, '边界根本身当然可以作为 workdir');
  });

  it('命令行里的绝对路径越界的拒绝原因：写清边界在哪、怎么改', () => {
    const message = commandPathBoundaryError(join(outside, 'a.txt'), boundary);
    assert.ok(message !== null);
    assert.ok(message.includes(boundary));
    assert.match(message, /改成 'full'/u);
    assert.equal(commandPathBoundaryError(join(boundary, 'a.txt'), boundary), null);
  });

  it('workspace：workdir 越界 → 拒绝，命令未执行（连 shell 都不用起）', async (t) => {
    const tool = createPwshTool({ destructiveEnabled: true, onWarning: () => undefined });
    t.after(() => tool.shutdown());
    const ctx: ToolContext = {
      callId: 'call-pwsh-1',
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
      workspaceRoot: root,
      boundaryRoot: boundary,
    };

    const result = await tool.handler(
      { command: 'Write-Output 我不该跑起来', workdir: outside },
      ctx,
    );

    assert.equal(result.isError, true, result.content);
    assert.equal(result.error?.code, FS_ERROR_CODES.PATH_DENIED);
    assert.match(result.content, /信任边界/u);
    assert.ok(result.content.includes(boundary));
    assert.match(result.content, /改成 'full'/u);
  });

  it('workspace：命令行里的边界外绝对路径 → 拒绝，并指名那条路径', async (t) => {
    const tool = createPwshTool({ destructiveEnabled: true, onWarning: () => undefined });
    t.after(() => tool.shutdown());
    const secret = join(outside, 'secret.txt');
    await writeFile(secret, 'SECRET', 'utf8');
    const ctx: ToolContext = {
      callId: 'call-pwsh-2',
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
      workspaceRoot: root,
      boundaryRoot: boundary,
    };

    const result = await tool.handler({ command: `Get-Content -LiteralPath '${secret}'` }, ctx);

    assert.equal(result.isError, true, result.content);
    assert.equal(result.error?.code, FS_ERROR_CODES.PATH_DENIED);
    assert.ok(result.content.includes(boundary), result.content);
    assert.ok(result.content.includes(secret), `拒绝消息要指名那条路径：${result.content}`);
  });

  it('full：同一条命令放行（真实执行，读得到边界外的文件）', async (t) => {
    const tool = createPwshTool({ destructiveEnabled: true, onWarning: () => undefined });
    t.after(() => tool.shutdown());
    const target = join(outside, 'full-shell.txt');
    await writeFile(target, 'FULL-OK', 'utf8');

    const ctx: ToolContext = {
      callId: 'call-pwsh-3',
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
      workspaceRoot: root,
      boundaryRoot: null,
    };

    const result = await tool.handler(
      { command: `Get-Content -LiteralPath '${target}'`, workdir: outside, timeoutMs: 20_000 },
      ctx,
    );

    // 机器上没有可用的 PowerShell 时如实跳过，而不是把"环境缺件"记成"边界放行失败"
    if (result.isError === true && result.error?.code === 'E_NO_RUNTIME') {
      t.skip(`本机没有可用的 PowerShell 运行时：${result.content}`);
      return;
    }
    assert.notEqual(result.isError, true, result.content);
    assert.match(result.content, /FULL-OK/u);
    assert.match(result.content, /\[shell\]/u);
  });

  it('full 不是"什么都放行"：命令黑名单在两种模式下都照旧生效', async (t) => {
    const tool = createPwshTool({ destructiveEnabled: true, onWarning: () => undefined });
    t.after(() => tool.shutdown());
    const ctx: ToolContext = {
      callId: 'call-pwsh-4',
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
      workspaceRoot: root,
      boundaryRoot: null,
    };

    const result = await tool.handler({ command: 'Remove-Item -Recurse -Force C:\\Windows\\Temp' }, ctx);

    assert.equal(result.isError, true, result.content);
    assert.equal(result.error?.code, 'E_DENIED_COMMAND');
  });

  it('workspace 且省略 workdir：默认工作目录落在边界根（不是工作根）', async (t) => {
    const tool = createPwshTool({ destructiveEnabled: true, onWarning: () => undefined });
    t.after(() => tool.shutdown());
    const ctx: ToolContext = {
      callId: 'call-pwsh-5',
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
      workspaceRoot: root,
      boundaryRoot: boundary,
    };

    const result = await tool.handler({ command: '(Get-Location).Path', timeoutMs: 20_000 }, ctx);

    if (result.isError === true && result.error?.code === 'E_NO_RUNTIME') {
      t.skip(`本机没有可用的 PowerShell 运行时：${result.content}`);
      return;
    }
    assert.notEqual(result.isError, true, result.content);
    // 默认目录 = 边界根：否则这个模式下一次调用都跑不起来（默认值自己越界）
    const normalize = (p: string): string => p.replaceAll('\\', '/').toLowerCase();
    assert.ok(
      normalize(result.content).includes(normalize(boundary)),
      `默认工作目录应当是边界根 ${boundary}：${result.content}`,
    );
  });
});

// ──────────────────────────────── 接线：ExecutionContext → ToolContext ────────────────────────────────

describe('接线 · boundaryRoot 从执行上下文原样到工具上下文', () => {
  async function ctxSeenByHandler(boundaryRoot: string | null | undefined): Promise<ToolContext> {
    let seen: ToolContext | null = null;
    const registry = new ToolRegistry();
    registry.register({
      name: 'probe_ctx',
      description: '记录 ctx 的探针工具（本用例只关心 boundaryRoot 有没有被搬运）',
      parameters: { type: 'object', properties: {} },
      executionMode: 'parallel',
      sideEffect: 'none',
      timeoutMs: 1000,
      handler: async (_args, ctx) => {
        seen = ctx;
        return { content: 'ok' };
      },
    });
    const ctx: ExecutionContext = {
      registry,
      turn: 1,
      step: 1,
      workspaceRoot: 'R',
      onToolCall: () => 1,
      onToolResult: () => undefined,
      ...(boundaryRoot === undefined ? {} : { boundaryRoot }),
    };

    await executeToolCalls([{ callId: 'c1', name: 'probe_ctx', arguments: '{}' }], ctx);
    if (seen === null) throw new Error('工具 handler 没有被调用');
    return seen;
  }

  it("null（完全信任）与 string（只限某根）都原样到达 handler", async () => {
    assert.equal((await ctxSeenByHandler(null)).boundaryRoot, null);
    assert.equal((await ctxSeenByHandler('B')).boundaryRoot, 'B');
  });

  it('没给时 handler 的 ctx 里**没有这个键**（undefined 与缺省同义：历史行为）', async () => {
    const seen = await ctxSeenByHandler(undefined);
    assert.equal('boundaryRoot' in seen, false);
    assert.equal(effectiveBoundaryRoot(seen), 'R');
  });

  it('子代理/嵌套链的转手不改变三态（工具层拿到什么，它就带下去什么）', async () => {
    for (const value of [null, 'B', undefined] as const) {
      const seen = await ctxSeenByHandler(value);
      assert.equal(seen.boundaryRoot, value);
    }
  });
});
