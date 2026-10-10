/**
 * 本机专有启动器的放行口在**装配期**生效（2026-10-11）
 *
 * ──────────────────────────── 这一条盯的形状 ────────────────────────────
 *
 * `config.json` 里声明了一个**默认表不认**的启动器：用户这台机器上就是 `obscura`
 * （`D:\opencode\obscura-release\obscura.exe`，args `["mcp"]`）。它在装配期
 * （`loadConfig` → `parseMcpServers` → `checkStdioLauncher`）要过启动器白名单那一关；
 * 过不去就抛 `ConfigError`、`main()` 返回 1 ⇒ **整机起不来**（计划任务 / systemd 看到的就是
 * "这次没起来"，实测形状见 `test/guardian.test.ts` 那两条：子进程 stderr 是一句
 * `mcp.servers[0].command：… 不在白名单里`）。
 *
 * 两条放行路都必须在**装配期**生效，而且**只有显式给出时才生效**：
 *   · **配置格** `mcp.extraLaunchers: ["obscura"]`——持久、跟着这台机器走、改完不必重启；
 *   · **环境变量** `IRMIA_MCP_STDIO_ALLOWLIST=obscura`——临时 / 救急，**优先级最高**。
 *   （判据是同一个函数：`launcher-guard.ts` 的 `effectiveLauncherAllowlist`，
 *   默认表 → 配置格 → 环境变量，并集。）
 *
 * ──────────────────── 为什么不与另外两条测试重复 ────────────────────
 *
 *   · `test/mcp-launcher-guard.test.ts` 的 ⑧ 钉的是**判据本身**（`checkLauncherSpec` /
 *     `parseMcpServers` 那一层：语义、归一、优先级、还有哪三层照旧拦）；
 *   · `test/config.test.ts` 钉的是**那一格自己的形状**（缺省空、非法形状当场报错、
 *     同一个文件里的放行当场生效）。
 *   这一条只钉一件事：**放进一份真配置、真读一遍**——两条放行口各自能不能让"整机装配"
 *   过这一关。漏掉这一跳的代价不是"某个字段不对"，而是**整机起不来**，所以值得在配置这一层
 *   再钉一次。（配置格里写的是**命令名** `obscura`，不是那条路径：判据是 `launcherNameOf`
 *   归一出来的**文件名**那一格，写整条路径对不上——错误回执里给的那句也是命令名。）
 *
 * ──────────────── 为什么这一条自己管 `process.env` ────────────────
 *
 * 装配期那条路内部读的就是 `process.env`（`client.ts`：`checkStdioLauncher(…, process.env, …)`，
 * 第五个参数缺省）。也就是说"**宿主进程里恰好有没有那个变量**"会改变这条判据的结论：
 * 用户 2026-10-11 正是靠**用户级** `IRMIA_MCP_STDIO_ALLOWLIST=obscura` 让整机起来的，而任何
 * **没继承**它的启动路径（旧环境、计划任务、别的账户）都会在装配期抛错——那正是这条地雷。
 *
 * 所以本用例**两个方向都自己设**（删掉 ⇒ 必须抛；设上 ⇒ 必须过），跑完还原原值：
 * 结论只取决于本用例给出的那两个事实，**不取决于宿主机上有没有那个变量**。
 * （这条纪律值得写下来：一个"依赖宿主环境恰好干净"的用例，在设过那个变量的机器上会变红，
 * 而红的原因看起来却是"判据坏了"。）
 *
 * 纪律：**不起任何进程**（这一层的全部价值就是"在起进程之前判"）；`config.json` 是临时目录里
 * 现写的一份，**不读**用户那份真配置（那份是本机的现场状态，读它会让结论随机器变）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { CONFIG_FILE_NAME, ConfigError, loadConfig } from '../src/config/config.ts';
import { STDIO_LAUNCHER_ALLOWLIST_ENV } from '../src/mcp/launcher-guard.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

async function freshDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-launcher-assembly-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return resolve(dir);
}

function writeRawConfig(dir: string, value: unknown): Promise<void> {
  return writeFile(join(dir, CONFIG_FILE_NAME), JSON.stringify(value, null, 2), 'utf8');
}

/** 用户 2026-10-11 01:52 往 `config.json` 里加的那条声明（形状逐字：绝对路径 + `["mcp"]`） */
const OBSCURA_EXE = 'D:\\opencode\\obscura-release\\obscura.exe';

function masterDeclaration(extraLaunchers?: unknown): Record<string, unknown> {
  return {
    mcp: {
      ...(extraLaunchers === undefined ? {} : { extraLaunchers }),
      servers: [{ name: 'obscura', command: OBSCURA_EXE, args: ['mcp'] }],
    },
  };
}

/**
 * 在"本进程里那个环境变量是什么"这件事上跑一段代码，跑完**还原原值**。
 *
 * `undefined` = 删掉它（模拟"没继承那个变量的启动路径"：旧环境 / 计划任务 / 别的账户）。
 */
async function withEnvHatch<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
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

// ──────────────────────────────── 用例 ────────────────────────────────

test('① 两条放行口都不给 ⇒ 装配期当场抛 ConfigError（地雷的形状：整机起不来）', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, masterDeclaration());

  await withEnvHatch(undefined, async () => {
    await assert.rejects(() => loadConfig(dir), (err: unknown) => {
      assert.ok(err instanceof ConfigError, `要抛 ConfigError（实际 ${String(err)}）`);
      assert.match(err.message, /mcp\.servers\[0\]\.command/u, '错误信息要带定位（哪个下标、哪一格）');
      assert.match(err.message, /obscura/u, '要点名那个启动器');
      assert.match(err.message, /不在白名单里/u, '要说清是白名单这一关拒的');
      assert.match(err.message, /mcp\.extraLaunchers/u, '要给出配置文件里那条放行路');
      assert.match(err.message, new RegExp(STDIO_LAUNCHER_ALLOWLIST_ENV, 'u'), '也要给出环境变量那条放行路');
      return true;
    });
  });
});

test('② 配置格 `mcp.extraLaunchers` ⇒ 装配期放行（一个环境变量都不设）', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, masterDeclaration(['obscura']));

  await withEnvHatch(undefined, async () => {
    const loaded = await loadConfig(dir);
    const server = loaded.config.mcp.servers[0];
    assert.ok(server !== undefined, '声明必须读回来（放行之后就轮到它了）');
    assert.equal(server.name, 'obscura');
    assert.equal(server.command, OBSCURA_EXE, 'command 逐字读回：配绝对路径是合法的，判据只看文件名那一格');
    assert.deepEqual(server.args, ['mcp'], 'args 也逐字读回');
    assert.deepEqual(loaded.config.mcp.extraLaunchers, ['obscura'], '配置格里那一项（trim + 小写归一后）');
  });
});

test('③ 环境变量那一格：装配期只在**本进程真的设了它**时才放行（宿主环境不参与结论）', async (t) => {
  const before = process.env[STDIO_LAUNCHER_ALLOWLIST_ENV];
  const dir = await freshDir(t);
  // 同一份配置（只有 servers、没有配置格）：只有"那个环境变量在不在"这一个变量在变
  await writeRawConfig(dir, masterDeclaration());

  await withEnvHatch('obscura', async () => {
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.config.mcp.servers.map((entry) => entry.name), ['obscura'],
      '环境变量那一格在装配期生效（它从前就是这条路；优先级仍然最高）');
    assert.deepEqual(loaded.config.mcp.extraLaunchers, [], '这一路上配置格是空的——放行只来自环境变量');
  });

  await withEnvHatch(undefined, async () => {
    await assert.rejects(() => loadConfig(dir), /不在白名单里/u,
      '同一个目录、同一条声明：没有那个变量时必须抛（这一条就是那条地雷的判据）');
  });

  assert.equal(process.env[STDIO_LAUNCHER_ALLOWLIST_ENV], before, '跑完必须还原宿主环境：本用例不许留痕');
});
