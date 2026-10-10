/**
 * MCP stdio **启动器白名单**测试（`src/mcp/launcher-guard.ts`，2026-10-09）
 *
 * 这一份钉的是**评审之后新加的那一层**：`docs/prior-art-mcp-disclosure.md` §4「能抄 1」——
 * 抄 AstrBot 的 `validate_mcp_stdio_config()`（`mcp_client.py:148-248`）那套判据
 * （白名单 + 逐启动器禁内联执行 + args 控制字符 + env 形状 + 显式放行口）。
 * 用户批的原话是"**别照抄代码，抄判据**"，所以这里的判据逐条对着我们自己的形态重写了一遍。
 *
 * 判据（下面每条用例对应一格）：
 *   ① 白名单内放行（默认表里的常见启动器 + 绝对路径 + Windows 的 .exe/.cmd 形态）
 *   ② 白名单外**拒绝，且给出放行办法**（点名白名单在哪、环境变量怎么设、还剩哪些限制）
 *   ③ 逐启动器禁内联执行：`python -c` / `node -e` / `docker --network host` 这一类
 *   ④ 命令里的 shell 元字符 / 控制字符拒绝；args 与 env 里的控制字符拒绝
 *   ⑤ 放行口生效——**而且它只放开"命令名"那一格**（内联执行那几层照旧拦）
 *   ⑥ 解析器那条路（`parseMcpServers`）真的接上了这道闸，且**判在任何子进程被拉起之前**
 *   ⑦ 「这一台机器上根本起不来的形状」（Windows）：`npx` / `npx.cmd` ⇒ 一句**能照做**的诊断，
 *      而 `uvx` / `node <绝对路径>.js` / 绝对路径 `.exe` ⇒ 正常放行（判据只有一处：
 *      `unstartableLauncherReason`）
 *
 * 纪律：只 import 纯函数 + 解析器，**不起任何进程**（这一层的全部价值就是"在起进程之前判"）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseMcpServers, McpConfigError } from '../src/mcp/client.ts';
import {
  COMMAND_FORBIDDEN_PATTERN,
  DEFAULT_STDIO_LAUNCHER_ALLOWLIST,
  STDIO_LAUNCHER_ALLOWLIST_ENV,
  WINDOWS_SHIM_ONLY_LAUNCHERS,
  WINDOWS_UNSPAWNABLE_SUFFIXES,
  checkLauncherArgs,
  checkLauncherEnv,
  checkLauncherSpec,
  checkStdioLauncher,
  configAllowedLaunchers,
  effectiveLauncherAllowlist,
  extraAllowedLaunchers,
  launcherNameOf,
  unstartableLauncherReason,
} from '../src/mcp/launcher-guard.ts';

/** 干净的进程环境（测试不许被宿主真的设了那个变量影响） */
const NO_ENV: NodeJS.ProcessEnv = {};

/**
 * 在"本进程里那个放行口环境变量是什么"这件事上跑一段代码，跑完**还原原值**。
 *
 * 为什么上面已经有了 `NO_ENV` 还需要它：`NO_ENV` 管得住**显式传 env** 的那几条路
 * （`checkLauncherSpec` / `checkStdioLauncher` / `effectiveLauncherAllowlist`），
 * 而 `parseMcpServers` **收不了 env 参数**——它内部按缺省读 `process.env`（`client.ts`：
 * `checkStdioLauncher(…, process.env, …)`，第五个参数缺省）。于是"宿主机上恰好设了
 * `IRMIA_MCP_STDIO_ALLOWLIST`"会改变那两条用例的结论：用户 2026-10-11 设的是**用户级**
 * `=obscura`，本文件 ⑧ 的 `obscura` 与 ⑥ 的 `git-mcp` 就都被它放行了（实测：设上之后
 * `git-mcp` 那条 `assert.throws` 与 `obscura` 那条一样会红）。
 * 形状与 `test/mcp-launcher-assembly.test.ts` 的 `withEnvHatch` 同一份。
 */
async function withEnvHatch<T>(value: string | undefined, body: () => Promise<T> | T): Promise<T> {
  const before = process.env[STDIO_LAUNCHER_ALLOWLIST_ENV];
  if (value === undefined) delete process.env[STDIO_LAUNCHER_ALLOWLIST_ENV];
  else process.env[STDIO_LAUNCHER_ALLOWLIST_ENV] = value;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env[STDIO_LAUNCHER_ALLOWLIST_ENV];
    else process.env[STDIO_LAUNCHER_ALLOWLIST_ENV] = before;
  }
}

function reasonOf(command: unknown, args?: readonly unknown[], env: NodeJS.ProcessEnv = NO_ENV): string {
  const verdict = checkLauncherSpec(command, args, env);
  return verdict.ok ? '' : verdict.reason;
}

// ──────────────────────────────── ① 白名单内放行 ────────────────────────────────

test('① 白名单内放行：MCP 生态的常见启动器一个都不许被误挡', () => {
  // 这些形态是真实存在的（前两条是官方 server 的标准起法，后两条是本地自写 server 的起法）
  const cases: Array<[string, string[]]> = [
    ['npx', ['-y', '@modelcontextprotocol/server-filesystem', '.']],
    ['uvx', ['mcp-server-fetch']],
    ['node', ['./my-server.mjs']],
    ['python', ['-m', 'my_mcp_server']],
    ['python3', ['server.py']],
    ['docker', ['run', '-i', '--rm', 'mcp/server-github']],
    ['pwsh', ['-NoProfile', '-File', './server.ps1']],
    ['cmd', ['C:\\servers\\run.cmd']],
  ];
  for (const [command, args] of cases) {
    const verdict = checkLauncherSpec(command, args, NO_ENV);
    assert.equal(verdict.ok, true, `${command} ${args.join(' ')} 应当放行（实际：${verdict.ok ? '' : verdict.reason}）`);
  }

  // 绝对路径与 Windows 后缀：判的是**文件名**那一格（配绝对路径是合法的，出厂文档就这么写）
  assert.equal(checkLauncherSpec('C:\\Program Files\\nodejs\\node.exe', ['x.js'], NO_ENV).ok, true,
    '带空格的绝对路径 + .exe 后缀：那是 node');
  assert.equal(checkLauncherSpec('/usr/local/bin/node', ['x.js'], NO_ENV).ok, true, 'POSIX 绝对路径');
  assert.equal(checkLauncherSpec('node.exe', [], NO_ENV).ok, true, '裸 node.exe');
  assert.equal(launcherNameOf('C:\\tools\\NPX.CMD'), 'npx', '大小写与 .cmd 后缀都归一掉');
});

// ──────────────────────────────── ② 白名单外拒绝并给出路 ────────────────────────────────

test('② 白名单外拒绝：错误信息必须给出**三条出路**（换启动器 / 环境变量放行 / 它不该当 server）', () => {
  for (const command of ['git', 'curl', 'ssh', 'git-mcp', 'rm', 'del']) {
    const reason = reasonOf(command);
    assert.notEqual(reason, '', `${command} 不在白名单里，必须拒`);
    assert.match(reason, /不在白名单里/u, `要说清是哪一件事不允许（实际：${reason}）`);
    assert.match(reason, new RegExp(STDIO_LAUNCHER_ALLOWLIST_ENV, 'u'),
      '必须给出显式放行口的名字——只说"不允许"的回执，下一个人只会去改代码');
    assert.match(reason, /launcher-guard\.ts/u, '要说清白名单在哪（人得能找到它）');
    assert.match(reason, /docs\/mcp-wiring\.md/u, '要带上那条理由的出处（加 server = 多一个不受边界约束的进程）');
    assert.match(reason, /显式放行才算数/u, '要说清这是刻意的默认收紧');
  }
  // 名字里带空格（`node rm -rf` 这种"想写成一条命令行"的形态）归一出来不是任何启动器 ⇒ 拒
  assert.notEqual(reasonOf('node rm -rf'), '', '命令名里带空格的那种写法不许过');
});

// ──────────────────────────────── ③ 逐启动器禁内联执行 ────────────────────────────────

test('③ 逐启动器禁内联执行：python -c / node -e / docker --network host / pwsh -Command / cmd /c', () => {
  const denied: Array<[string, string[]]> = [
    ['python', ['-c', 'print(1)']],
    ['python3', ['-c', 'import os']],
    ['py', ['-c', 'x']],
    ['node', ['-e', 'require("fs")']],
    ['node', ['-p', '1+1']],
    ['node', ['--eval', 'x']],
    ['node', ['--print', 'x']],
    ['deno', ['eval', 'x']],
    ['bun', ['-e', 'x']],
    ['docker', ['run', '--network', 'host', 'img']],
    ['docker', ['run', '--network=host', 'img']],
    ['docker', ['run', '--pid', 'host', 'img']],
    ['docker', ['run', '--ipc=host', 'img']],
    ['docker', ['run', '--privileged', 'img']],
    ['podman', ['run', '--network', 'host', 'img']],
    ['pwsh', ['-Command', 'Get-ChildItem']],
    ['pwsh', ['-c', 'gci']],
    ['powershell', ['-EncodedCommand', 'ZwBlAHQ=']],
    ['cmd', ['/c', 'dir']],
    ['sh', ['-c', 'id']],
    ['bash', ['-c', 'id']],
    ['npm', ['exec', '--', 'rm', '-rf', '/']],
    ['npm', ['x', 'cowsay']],
  ];
  for (const [command, args] of denied) {
    const reason = reasonOf(command, args);
    assert.notEqual(reason, '', `${command} ${args.join(' ')} 必须拒（内联执行/借宿主命名空间）`);
    assert.match(reason, /被拒/u, `要说清是"哪一格参数"被拒（实际：${reason}）`);
    assert.match(reason, new RegExp(STDIO_LAUNCHER_ALLOWLIST_ENV, 'u'), '也要给出路');
    assert.match(reason, /不会被放行口关掉/u, '要说清内联执行那一层是放行口也关不掉的');
  }

  // 同一批启动器的**合法**形态不许被误伤（这是防止"一刀切禁掉整类启动器"）
  for (const [command, args] of [
    ['python', ['-m', 'my_server']],
    ['node', ['./server.js', '--port', '0']],
    ['docker', ['run', '-i', '--rm', 'img']],
    ['pwsh', ['-NoProfile', '-File', 'server.ps1']],
    ['cmd', ['run.cmd']],
    ['npm', ['run', 'start']],
  ] as Array<[string, string[]]>) {
    assert.equal(checkLauncherSpec(command, args, NO_ENV).ok, true,
      `${command} ${args.join(' ')} 是合法形态，不该被内联执行那一条误伤`);
  }
});

// ──────────────────────────────── ④ 控制字符 / 元字符 ────────────────────────────────

test('④ 命令里的元字符、args 与 env 里的控制字符：一律拒，且说清是哪一格', () => {
  const badCommands = [
    'node; rm -rf /',
    'node && echo x',
    'node | cat',
    'node > out.txt',
    'node `whoami`',
    'node $(whoami)',
    'node\npython',
    'node\u0000x',
    '"node"',
    "node'",
  ];
  for (const command of badCommands) {
    const reason = reasonOf(command);
    assert.notEqual(reason, '', `${JSON.stringify(command)} 必须拒`);
    assert.match(reason, /元字符|控制字符/u, `要说清是"不许出现某个字符"（实际：${reason}）`);
  }
  // 判据本身也钉住（防有人把这条正则改松）
  assert.ok(COMMAND_FORBIDDEN_PATTERN.test(';'), '；是元字符');
  assert.ok(!COMMAND_FORBIDDEN_PATTERN.test('C:\\Program Files\\nodejs\\node.exe'),
    '路径分隔符/盘符冒号/空格**不在**禁用集里（配绝对路径是合法的）');

  // args：控制字符拒（换行 / 回车 / NUL），普通参数照收
  assert.equal(checkLauncherArgs(['ok', '--root', '.']), null, '普通参数照收');
  assert.match(checkLauncherArgs(['a\nb']) ?? '', /控制字符/u, 'args 里的换行要拒');
  assert.match(checkLauncherArgs(['a\u0000b']) ?? '', /控制字符/u, 'args 里的 NUL 要拒');
  assert.match(checkLauncherArgs(['a\rb']) ?? '', /控制字符/u, 'args 里的回车要拒');

  // env：键名空 / 键名控制字符 / 值控制字符都拒；正常 env 照收
  assert.equal(checkLauncherEnv({ TOKEN: 'x', 'A=B': 'v' }), null, 'string→string 与 `=` 键名照收');
  assert.match(checkLauncherEnv({ '': 'x' }) ?? '', /空键名/u);
  assert.match(checkLauncherEnv({ 'a\nb': 'x' }) ?? '', /控制字符/u);
  assert.match(checkLauncherEnv({ TOKEN: 'line1\nline2' }) ?? '', /控制字符/u);

  // 一把尺子（checkStdioLauncher）：三层串起来，返回 null = 放行
  assert.equal(checkStdioLauncher('node', ['./s.js'], { A: 'b' }, NO_ENV), null);
  assert.match(checkStdioLauncher('node', ['-e', 'x'], undefined, NO_ENV) ?? '', /被拒/u,
    '参数那一层在"一把尺子"里也要生效');
});

// ──────────────────────────────── ⑤ 放行口 ────────────────────────────────

test('⑤ 显式放行口生效：`IRMIA_MCP_STDIO_ALLOWLIST` 放行自定义启动器，但**只放开命令名那一格**', () => {
  const hatch: NodeJS.ProcessEnv = { [STDIO_LAUNCHER_ALLOWLIST_ENV]: 'git-mcp, My-Server ; other-tool' };

  // 放行口生效（大小写不敏感；`,` 与 `;` 都是分隔符）
  assert.deepEqual(extraAllowedLaunchers(hatch), ['git-mcp', 'my-server', 'other-tool']);
  assert.equal(checkLauncherSpec('git-mcp', ['--stdio'], hatch).ok, true, '显式放行的自定义启动器要能过');
  assert.equal(checkLauncherSpec('MY-SERVER.exe', [], hatch).ok, true, '大小写与 .exe 后缀都认');
  assert.equal(checkLauncherSpec('other-tool', [], hatch).ok, true, '`;` 分隔的那一格也认');

  // 默认表照旧在（放行口是**追加**，不是替换）
  const effective = effectiveLauncherAllowlist(hatch);
  for (const name of DEFAULT_STDIO_LAUNCHER_ALLOWLIST) {
    assert.ok(effective.includes(name), `${name} 必须还在默认表里`);
  }
  assert.ok(effective.includes('git-mcp'), '放行口那一项也必须在');

  // **放行口只放开命令名**：内联执行、控制字符、env 那三层照旧生效
  assert.match(checkStdioLauncher('git-mcp', ['a\nb'], undefined, hatch) ?? '', /控制字符/u,
    'args 控制字符那一层不因放行口而关掉');
  assert.match(checkStdioLauncher('git-mcp', ['x'], { TOKEN: 'a\nb' }, hatch) ?? '', /控制字符/u,
    'env 那一层不因放行口而关掉');
  assert.notEqual(checkLauncherSpec('git-mcp; rm -rf /', [], hatch).reason, '',
    '元字符那一层也不因放行口而关掉');

  // 没设那个变量时，生效表就等于默认表（**默认收紧**这条不能被环境里别的东西影响）
  assert.deepEqual(extraAllowedLaunchers(NO_ENV), []);
  assert.deepEqual(effectiveLauncherAllowlist(NO_ENV), [...DEFAULT_STDIO_LAUNCHER_ALLOWLIST]);
});

// ──────────────────────────────── ⑥ 接进解析器 ────────────────────────────────

test('⑥ `parseMcpServers` 真的接上了这道闸（配置面 / 界面的内联声明都从这一个口走）', async () => {
  // 拒：白名单外。**这一段自己把那个放行口环境变量删掉**——`parseMcpServers` 收不了 env 参数，
  // 它内部读 `process.env`；不删的话"宿主机上恰好设了它"会让下面这几条**静默变成假绿**（不抛了）。
  await withEnvHatch(undefined, () => {
    assert.throws(() => parseMcpServers([{ name: 'x', command: 'git-mcp' }]), (err: unknown) => {
      assert.ok(err instanceof McpConfigError, '要折成配置错误（调用方只该认一种错误类型）');
      assert.match(err.message, /mcp\.servers\[0\]\.command/u, '错误信息要带定位（哪个下标、哪一格）');
      assert.match(err.message, /不在白名单里/u);
      return true;
    });
    // 拒：内联执行
    assert.throws(() => parseMcpServers([{ name: 'x', command: 'python', args: ['-c', 'x'] }]),
      /被拒/u, '内联执行那一层也要在解析器这条路生效');
    // 拒：args 里的控制字符
    assert.throws(() => parseMcpServers([{ name: 'x', command: 'node', args: ['a\nb'] }]),
      /控制字符/u, 'args 控制字符要在解析器这条路生效');
    // 拒：env 值里的控制字符
    assert.throws(() => parseMcpServers([{ name: 'x', command: 'node', env: { A: 'x\ny' } }]),
      /控制字符/u, 'env 那一层要在解析器这条路生效');
  });
  // 放行：正常声明（含绝对路径、含带值参数的 npx 形态）
  const parsed = parseMcpServers([
    { name: 'fs', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
    { name: 'local', command: 'C:\\tools\\node.exe', args: ['./s.js'] },
  ]);
  assert.deepEqual(parsed.map((entry) => entry.name), ['fs', 'local']);
});

// ───────────── ⑧ 配置格放行口（`mcp.extraLaunchers`；2026-10-10 加） ─────────────

/**
 * 用户 2026-10-10 报的那件事：`obscura` 不在默认表里 ⇒ 装配期抛错、**整机起不来**，
 * 而唯一的出路是设环境变量 `IRMIA_MCP_STDIO_ALLOWLIST=obscura`——
 * 「**拴在环境变量上，不够干净**」。那一格现在有了配置里对应的位置。
 *
 * 这一条钉的是**两格的关系**（不是"再加一个开关"）：
 *   · 语义**完全一致**——都只放开"命令名"那一格（内联执行 / 控制字符那三层照旧）；
 *   · 优先级：默认表 → `mcp.extraLaunchers` → 环境变量（**环境变量最高**，
 *     它从前的行为一个字节都没改：临时试一次、或配置读不到时的救急路仍然走它）；
 *   · 两格是**并集**，谁也不覆盖谁（"配置里写了"与"两边都写"在放行结果上等同）。
 */
test('⑧ 配置格放行口 `mcp.extraLaunchers`：与 `..._ALLOWLIST` 同语义，环境变量优先级最高', async () => {
  // ① 只有配置格：`obscura` 能过（这就是用户要的那条路——不必再设环境变量）
  assert.equal(checkLauncherSpec('obscura', ['--mcp'], NO_ENV, ['obscura']).ok, true,
    '配置里显式放行的启动器必须能过');
  assert.equal(checkLauncherSpec('Obscura.EXE', [], NO_ENV, ['obscura']).ok, true,
    '大小写与 .exe 后缀照旧归一（判据只有一个：launcherNameOf）');

  // ② 归一：配置里那格按 trim + 小写读（与 `launcherNameOf` 同一把尺子）
  assert.deepEqual(configAllowedLaunchers(['  Obscura ', 'My-Tool']), ['obscura', 'my-tool']);
  assert.deepEqual(configAllowedLaunchers(undefined), [], '没写这一格 = 空（旧配置行为逐字不变）');
  assert.deepEqual(configAllowedLaunchers([]), []);
  // 逗号/分号分隔的写法也认（有人会照着环境变量那格的样子写）
  assert.deepEqual(configAllowedLaunchers(['a, b;c']), ['a', 'b', 'c']);

  // ③ 并集与优先级：默认表照旧在；两格同时写 ⇒ 都在；**环境变量那一格不被配置挤掉**
  const both = effectiveLauncherAllowlist({ [STDIO_LAUNCHER_ALLOWLIST_ENV]: 'from-env' }, ['from-config']);
  for (const name of DEFAULT_STDIO_LAUNCHER_ALLOWLIST) {
    assert.ok(both.includes(name), `${name} 必须还在默认表里`);
  }
  assert.ok(both.includes('from-config'), '配置格那一项必须在');
  assert.ok(both.includes('from-env'), '环境变量那一项也必须在（两格并集，不是覆盖）');
  // 环境变量那格的**行为一个字没改**：不传配置格时它就是从前那个自己
  assert.deepEqual(effectiveLauncherAllowlist({ [STDIO_LAUNCHER_ALLOWLIST_ENV]: 'from-env' }),
    effectiveLauncherAllowlist({ [STDIO_LAUNCHER_ALLOWLIST_ENV]: 'from-env' }, []));

  // ④ **语义完全一致**：配置格也只放开"命令名"那一格——这三层照旧拦
  assert.match(checkStdioLauncher('obscura', ['a\nb'], undefined, NO_ENV, ['obscura']) ?? '', /控制字符/u,
    'args 控制字符那一层不因配置放行而关掉');
  assert.match(checkStdioLauncher('obscura', ['x'], { TOKEN: 'a\nb' }, NO_ENV, ['obscura']) ?? '', /控制字符/u,
    'env 那一层不因配置放行而关掉');
  assert.notEqual(checkLauncherSpec('obscura; rm -rf /', [], NO_ENV, ['obscura']).reason, '',
    '元字符那一层也不因配置放行而关掉');
  // 逐启动器禁内联执行：放行一个**默认表里本来就有**的解释器时，那一层照旧生效
  assert.equal(checkLauncherSpec('node', ['-e', 'x'], NO_ENV, ['node']).ok, false,
    '放行口不是"关掉这一层"：node -e 仍然被拒');

  // ⑤ 不在任何一格里的启动器照旧被拒，**而且错误信息要给两条放行路**
  const refused = checkLauncherSpec('obscura', [], NO_ENV, []);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.reason, /mcp\.extraLaunchers/u,
    '拒的时候要指出配置文件里那一格（用户报的正是"只能设环境变量"）');
  assert.match(refused.ok ? '' : refused.reason, /IRMIA_MCP_STDIO_ALLOWLIST/u,
    '也要指出环境变量那一格（优先级最高）');
  assert.match(refused.ok ? '' : refused.reason, /不重启/u,
    '配置格那条路要说明"改完不必重启"（这是它比环境变量干净的地方）');

  // 解析器那条路真的接上了第三个参数（`parseMcpServers` 是唯一入口）。
  //    这里同样**自己把环境变量删掉**：下面那条"不传放行口时照旧拒"要测的是**缺省行为**，
  //    而 `parseMcpServers` 内部读 `process.env` ⇒ 宿主设了这个变量时它就不拒了（假绿）。
  await withEnvHatch(undefined, () => {
    const parsed = parseMcpServers([{ name: 'priv', command: 'obscura', args: ['serve'] }],
      'mcp.servers', ['obscura']);
    assert.deepEqual(parsed.map((entry) => entry.name), ['priv'], '同源传进来的放行口要能放行');
    assert.throws(() => parseMcpServers([{ name: 'priv', command: 'obscura' }]), /不在白名单里/u,
      '不传放行口时照旧拒（缺省行为与这一格存在之前逐字相同）');
  });
});

// ──────────────────── ⑦ 「这一台机器上根本起不来的形状」（Windows；2026-10-10 加） ────────────────────

/** 一个**空 PATH**：里面当然没有 npx.exe（用它把"PATH 上没有可执行文件"那一格钉死） */
const EMPTY_PATH: NodeJS.ProcessEnv = { PATH: '' };

/** 临时目录里放一个真的 `npx.exe`：模拟"这台机器上真有 .exe 的 npx"（那种情况不许拦） */
function withFakeExeDir(name: string, body: (pathValue: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-guard-'));
  writeFileSync(join(dir, name), 'MZ（测试用的假可执行文件：只被 existsSync 看到）');
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('⑦ Windows：`npx` / `npx.cmd` ⇒ 一句**能照做**的诊断（不是裸 ENOENT/EINVAL）', () => {
  // ① 裸 `npx`：实测 ENOENT（npm 只发 .cmd/.ps1，CreateProcess 只给命令名补 .exe）
  const bare = unstartableLauncherReason('npx', 'win32', EMPTY_PATH);
  assert.ok(bare !== null, 'Windows 上的裸 npx 必须被拦下来（它根本起不来）');
  assert.match(bare, /在 Windows 上起不来/u, '开门见山说清"这台机器上起不来"');
  assert.match(bare, /ENOENT/u, '要带上实测到的那件事（裸 ENOENT 是今天现场看到的东西）');
  assert.match(bare, /npx\.cmd \/ npx\.ps1/u, '要说清 npm 发的是什么');
  assert.match(bare, /PATH 上\*\*没有 npx\.exe\*\*/u, '要说清判据（PATH 上没有同名 .exe）');
  // 「改成什么」三条，逐条点名（判据是"读的人能照做"，所以这三条必须有）
  assert.match(bare, /node <绝对路径>\/cli\.js/u, '出路①：直指入口 js');
  assert.match(bare, /uvx <工具名>/u, '出路②：uvx');
  assert.match(bare, /绝对路径的 \.exe/u, '出路③：原生单文件 .exe');
  assert.match(bare, /cmd \/c/u, '顺带说清 `cmd /c` 那条老路也被白名单拒了');

  // ② `.cmd` / `.bat` / `.ps1` 包装脚本：实测同步 EINVAL / EFTYPE（CVE-2024-27980 之后的缓解）
  for (const command of ['npx.cmd', 'npm.cmd', 'C:\\tools\\run.bat', 'npx.ps1']) {
    const reason = unstartableLauncherReason(command, 'win32', EMPTY_PATH);
    assert.ok(reason !== null, `${command} 必须被拦（Node 同步拒包装脚本，我们不经 shell）`);
    assert.match(reason, /EINVAL|EFTYPE/u, `${command}：要说清实测到的是哪一种同步拒`);
    assert.match(reason, /CVE-2024-27980/u, '要说清"为什么"（Node 的缓解，必须 shell:true）');
    assert.match(reason, /node <绝对路径>\/cli\.js/u, `${command}：也要给出路`);
    assert.match(reason, /没有为它留下任何进程/u, '要说清这一步判在起进程之前');
  }
  assert.deepEqual(WINDOWS_UNSPAWNABLE_SUFFIXES, ['.cmd', '.bat', '.ps1'], '后缀表是这三格');
});

test('⑦ 放行的形状一个都不许被误拦（`uvx` / `node <绝对路径>.js` / 绝对路径 .exe / 真有 .exe 的 npx）', () => {
  // 实测能起的形状（判据只该拦"起不来的"，多拦一条 = 把一个能用的配置打死）
  for (const command of [
    'uvx', 'uv', 'node', 'python', 'deno', 'pwsh', 'cmd',
    'D:\\IrmiaAgent\\tools\\node\\node.exe',              // 绝对路径 .exe（实测 spawned exit=0）
    'C:\\Windows\\System32\\cmd.exe',
    'node.exe',
  ]) {
    assert.equal(unstartableLauncherReason(command, 'win32', EMPTY_PATH), null,
      `${command} 在这台机器上能起，不许拦`);
  }
  // 同一个 npx 在别的平台上是合法的 → 判据是**平台相关**的，非 Windows 一律 null
  for (const command of ['npx', 'npx.cmd', 'npm']) {
    assert.equal(unstartableLauncherReason(command, 'linux', EMPTY_PATH), null,
      `${command} 在 Linux 上是合法的（那边 npx 真能起）`);
    assert.equal(unstartableLauncherReason(command, 'darwin', EMPTY_PATH), null, 'macOS 同理');
  }
  // PATH 上真有 `.exe` 的那台机器：**不许误拦**（standalone 装的 pnpm.exe 之类）
  withFakeExeDir('npx.exe', (dir) => {
    assert.equal(unstartableLauncherReason('npx', 'win32', { PATH: dir }), null,
      'PATH 上有 npx.exe ⇒ 它起得来，不许拦');
  });
  // 名字不在那张表里的（哪怕 PATH 上什么都没有）：那是普通的"命令不存在"，不冒充"已知形状"
  for (const command of ['my-server', 'definitely-not-a-real-command-xyz']) {
    assert.equal(unstartableLauncherReason(command, 'win32', EMPTY_PATH), null,
      `${command} 不在这张表里 ⇒ 交给原来的 ENOENT 那条路（不在这里编原因）`);
  }
  // 带路径的命令不做 PATH 查找（配绝对路径是合法的；找不到就是普通的手误）
  assert.equal(unstartableLauncherReason('C:\\tools\\npx', 'win32', EMPTY_PATH), null,
    '带路径的形式不按 PATH 判（那是"这个文件在不在"的问题）');
});

test('⑦ 那张表本身：只列 npm 垫片那一类，且白名单里认得它们（否则诊断永远轮不到）', () => {
  for (const name of WINDOWS_SHIM_ONLY_LAUNCHERS) {
    assert.ok(DEFAULT_STDIO_LAUNCHER_ALLOWLIST.includes(name),
      `${name} 必须先在启动器白名单里（否则配置那一层就先拒了，这条诊断轮不到）`);
    assert.equal(launcherNameOf(name), name, `${name} 归一之后还是它自己`);
  }
  // 反向：实测能起的真 .exe 一个都不许进这张表（进了就会被"PATH 上没有 .exe"那一条误伤）
  for (const name of ['uvx', 'uv', 'node', 'python', 'cmd', 'pwsh']) {
    assert.ok(!WINDOWS_SHIM_ONLY_LAUNCHERS.includes(name), `${name} 是真 .exe，不该进这张表`);
  }
});
