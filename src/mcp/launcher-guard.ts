/**
 * Irmia Agent — MCP stdio **启动器白名单**（`mcp.servers[].command` 的那道闸）
 *
 * ──────────────────────────── 这一层是干什么的 ────────────────────────────
 *
 * `docs/mcp-wiring.md:100-102` 自己承认过那条边界：**加一个 MCP server = 在这台机器上多跑一个
 * 不受 `trust.mode:'workspace'` 约束的进程**（那条边界只作用于 fs 族与 pwsh，`tools/boundary.ts`）。
 * 而在这一版之前，我们对 `mcp.servers[].command` 的校验只有"非空字符串"一条
 * （`parseMcpServers` 的 `command` 那一格）⇒ 配置里写什么就起什么，**零形状约束**。
 *
 * 这一层补的就是那句"零"：**在任何子进程被拉起之前**先判一遍这份 stdio 声明。
 * 它**不是**沙箱（起起来的进程仍然是别人的进程，能碰什么取决于那个程序自己），
 * 它挡的是"配置面被写成一条任意执行"这一类形状：
 *
 *   ① 命令名必须是**已知启动器**（默认表见 `DEFAULT_STDIO_LAUNCHER_ALLOWLIST`）；
 *   ② 命令里不许有 shell 元字符（我们不经过 shell，但这类字符出现在命令名里一定是想干别的）；
 *   ③ **逐启动器禁内联执行**（`python -c` / `node -e` / `docker --network host` 那几类）；
 *   ④ `args` 不许含控制字符；
 *   ⑤ `env` 键名与值不许含控制字符（"必须是 string→string"那条 `parseMcpServers` 早就查了）。
 *
 * ──────────────────────────── 形状是抄来的，不是想出来的 ────────────────────────────
 *
 * 判据抄自 AstrBot 的 `astrbot-src/repo/astrbot/core/agent/mcp_client.py:148-248`
 * （`validate_mcp_stdio_config()`，注释原话 *"Validate stdio MCP config before any subprocess
 * can be spawned."*）：白名单 + 逐启动器禁内联执行 + args 控制字符 + env 形状，
 * 并留一个**环境变量放行口**（它那边是 `_STDIO_ALLOWLIST_ENV`）。
 * 出处与对照见 `docs/prior-art-mcp-disclosure.md` §3.6 与 §4「能抄 1」（那一篇同时给了代价：
 * 白名单会挡住合法的自定义启动器 ⇒ **必须**同时给覆盖口，否则是拿可用性换安全）。
 * **代码一行没有照抄**（那一边是 Python、形状也不同），只抄判据。
 *
 * 同向的一条官方 MUST（那个项目的安全页）：*"If an MCP client supports one-click local MCP
 * server configuration, it MUST implement proper consent mechanisms prior to executing commands."*
 *
 * ──────────────────────────── 两道纪律 ────────────────────────────
 *
 * 1. **放行口只放开"命令名"那一格**：`mcp.extraLaunchers`（配置文件，2026-10-10 加）
 *    或 `IRMIA_MCP_STDIO_ALLOWLIST`（环境变量，**优先于前者**）里写进一个自定义启动器，
 *    它仍然要过 ② ③ ④ ⑤——放行口不是"关掉这一层"。别把它做成一个 `SKIP=1` 的开关：
 *    那等于把这道闸变成默认没有。
 * 2. **错误信息必须给出路**（写给配置它的人，也写给读回执的人）：说清"白名单在哪、
 *    怎么显式放行、放行了还剩哪些限制"。只说"不允许"的回执，下一个人只会去改代码。
 *
 * 零 `tools` 段代价：这一层全在**装配期**（解析配置时），不进任何请求体
 * ⇒ **不触发 `RENDER_VERSION`**（判据见 `src/tools/mcp-entry.ts` 文件头那条红线）。
 *
 * ──────────────── 第 ⑥ 条：这一台机器上**根本起不来**的形状（2026-10-10 加） ────────────────
 *
 * 上面 ①～⑤ 是**形状与策略**判据（平台无关：同一份声明在哪儿都该这么判）。而有一类形状是
 * **这一台机器上的 OS 事实**：`npx` / `npx.cmd` 在 Windows 上按 `spawn(command, args)`（不经 shell）
 * 根本起不来——出厂示例那句 `{"command":"npx"}` 就是这么写的，实测只换来一句裸 ENOENT
 * （判据与实测数见 `unstartableLauncherReason`）。那一段在**起进程那一刻**判，**不进**
 * `checkLauncherSpec`（它管的那一层判在所有平台、且是整机装配期的硬错误：同一条 `npx` 声明在
 * Linux/macOS 上是合法的，而"一个 server 起不来"不该让整台机器起不来，见 `client.ts` 的
 * `registerAll` 纪律）。两个判据各管各的，不互相重复。
 *
 * 约定：值导入写 `.ts`，纯类型导入写 `.js`。零外部依赖：只用 node: 标准库。
 */
import { existsSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';

/**
 * 显式放行口（环境变量）：逗号（或分号）分隔的**命令名**清单，追加在默认白名单之上。
 *
 * **它是最高优先的那一格**（2026-10-10 加配置格之后仍然如此）：命令行临时开关的语义就是
 * "本次进程压过文件里写的"，所以 `.env` 里那一条**不会**被配置挤掉，两个来源是**并集**
 * （默认表 → `mcp.extraLaunchers` → 这个环境变量，见 `effectiveLauncherAllowlist`）。
 * 行为与"只有它一个放行口"的那些版本**逐字相同**：配置格缺席时它就等于从前的自己。
 */
export const STDIO_LAUNCHER_ALLOWLIST_ENV = 'IRMIA_MCP_STDIO_ALLOWLIST';

/**
 * 放行口（配置文件）：`mcp.extraLaunchers` 的**字段路径**。
 *
 * 为什么放行口要有两格：环境变量那一格要求"重启进程"——而它对使用者是**最不干净**的一条
 * 路（要改 `.env` / 计划任务 / 启动脚本，还要重启；用户 2026-10-10 报的正是"拴在环境变量上"）。
 * 而"这台机器上要放行 `obscura`"其实是一份**配置事实**（跟着这台机器走），它该待在 `config.json`
 * 里、与那些 server 声明摆在同一段，写下来就是持久的、看得见的。环境变量留着且**优先级最高**
 * （临时试一次、或者配置读不到时的救急路）。
 *
 * **两个来源的语义完全同一**（都只放开"命令名"那一格）：配置里写了它，仍然要过逐启动器
 * 禁内联执行、args/env 控制字符那几层。默认表只放通用启动器；专有工具走这两格。
 */
export const STDIO_LAUNCHER_ALLOWLIST_CONFIG_FIELD = 'mcp.extraLaunchers';

/**
 * 默认白名单：**只列命令名**（不含路径、不含参数）。
 *
 * 收哪些、不收哪些的判据（不是"够不够全"，是"这一条会不会把整台机器交出去"）：
 *
 * · **放**：包管理/运行时启动器（`npx` / `uvx` / `pnpm dlx` 那一类）——MCP 生态里绝大多数
 *   server 就是这么起的（`npx -y @modelcontextprotocol/server-filesystem <dir>`）；
 * · **放**：语言解释器（`node` / `python` / `deno` 那一类）——本地自己写的 server 走它，
 *   但**内联执行被逐条禁掉**（见 `LAUNCHER_RESTRICTIONS`），所以"解释器"不等于"任意执行"；
 * · **放**：容器与 Windows 上真会用到的那几个壳（`docker` / `pwsh` / `cmd`）——
 *   `pwsh`/`cmd` 看着刺眼，但 MCP 的 stdio 世界里它是"起一个 .cmd/.bat 包装器"的常见形态，
 *   而**拒绝它并不会让人放弃 MCP，只会让人去改我们的代码**（放行口的存在就是为了这个）。
 *   它们的限制写在 `LAUNCHER_RESTRICTIONS` 里（禁 `-Command` / `/c` 这类内联口）。
 * · **不放**：`git` / `curl` / `ssh` / `rm` / `del` 这类"能直接动这台机器"的程序。
 *   要把它们当 MCP server 起，是走放行口的事——**显式**放行才算数。
 * · **不放**：**本机专有工具**——只有某台机器上才有的启动器（自己在本地编出来的
 *   `xyz-server.exe`、某个单位内部打包的二进制、某个只在用户这台机器上装了的第三方工具……）。
 *   判据是"**这个名字对别人是不是也是同一个程序、同一个语义**"：是（`node` / `uvx` / `docker`
 *   那一批）才可能进这张表；不是就走**配置格** `mcp.extraLaunchers`（与那台机器的 `servers[]`
 *   写在同一段：持久、看得见、跟着机器走）或环境变量 `IRMIA_MCP_STDIO_ALLOWLIST`。
 *   为什么这条要单独说：这张默认表跟着**代码**发到每一个使用者手上，往里加一个"只有我这儿有"的
 *   名字，等于替所有人默认放行一个他们机器上多半不存在的程序——那是拿**这台机器的便利**换
 *   **出厂口径**。`docs/mcp-wiring.md` §4.1 那张表列了这条判据的出处与代价（白名单会挡住合法的
 *   自定义启动器 ⇒ **必须**同时给放行口，否则是拿可用性换安全）。
 */
export const DEFAULT_STDIO_LAUNCHER_ALLOWLIST: readonly string[] = [
  // 包管理 / 运行时启动器（MCP 生态的主流形态）
  'npx', 'pnpm', 'yarn', 'bunx', 'uvx', 'uv', 'pipx', 'poetry', 'pip',
  'npm', 'corepack',
  // 语言解释器（本地 server 的常见形态）
  'node', 'deno', 'bun', 'python', 'python3', 'py', 'tsx', 'ts-node',
  'ruby', 'php', 'perl', 'java', 'dotnet', 'go',
  // 容器
  'docker', 'podman',
  // Windows / 通用壳（限制见 LAUNCHER_RESTRICTIONS；放行口就是为了那些"真需要别的"的人）
  'pwsh', 'powershell', 'cmd', 'sh', 'bash', 'zsh',
  // 其它常见 MCP 启动形态（`mcp-server-git` 这类包名启动器：有的包被全局装上、直接当命令用）
  'mcp', 'mcp-server', 'mcp-proxy', 'supergateway', 'mcp-server-git', 'mcp-server-fetch',
];

/**
 * 逐启动器禁**内联执行**（比"命令名不在白名单"更难绕的一层）。
 *
 * 为什么必须有它：白名单放行了 `python` 就等于放行了 `python -c "<任意代码>"`——
 * 那不是"起一个 server"，那是**把 `pwsh` 那件工具从后门又开了一遍**，
 * 而且这一条路上的执行**不受** `tools.destructiveEnabled` 与 `planMode` 管（见
 * `docs/mcp-chain-review.md` 缺陷 ④ 与 `src/tools/mcp-entry.ts` 文件头那张表）。
 *
 * 两个字段的差别（命中即拒）：
 *   · `subcommands`：**整个参数**命中，或 `--x=y` 这种前缀命中（`--network=host` 也算）；
 *   · `flags`：**开关名**命中——`--flag=value` 与 `--flag value` 两种形态都算
 *     （后者会把开关后面那一格值一起拒掉，那正是我们要拦的东西）。
 *
 * ⚠️ 这三条**不受放行口影响**：放行口（`mcp.extraLaunchers` / `IRMIA_MCP_STDIO_ALLOWLIST`）
 * 放开的只是"命令名在不在①那张表里"，这里与 args/env 那两层照旧逐条生效
 * ——放行口不是"关掉这一层"的开关，理由见文件头「两道纪律」第 1 条。
 */
export interface LauncherRestriction {
  /** 一句话说清"为什么这个启动器不许内联"（会进错误信息） */
  readonly why: string;
  /** 整个参数命中即拒（含 `--x=y` 前缀命中） */
  readonly subcommands?: readonly string[];
  /** 开关名命中即拒（`--flag=value` 与 `--flag value` 两种形态都算） */
  readonly flags?: readonly string[];
}

export const LAUNCHER_RESTRICTIONS: Readonly<Record<string, LauncherRestriction>> = {
  python: {
    why: 'Python 的 stdio server 要从模块或脚本文件起（内联代码 `-c` 等于把任意代码交给配置面）',
    flags: ['-c'],
  },
  python3: {
    why: '同上（`-c`）',
    flags: ['-c'],
  },
  py: {
    why: '同上（`-c`）',
    flags: ['-c'],
  },
  node: {
    why: 'Node 的 stdio server 要从脚本文件起（`-e` / `-p` / `--eval` / `--print` 是内联执行）',
    flags: ['-e', '-p', '--eval', '--print'],
  },
  deno: {
    why: 'Deno 的 `eval` 是内联执行',
    flags: ['-e', '--eval', 'eval'],
  },
  bun: {
    why: 'Bun 的 `-e` / `eval` 是内联执行',
    flags: ['-e', '--eval', 'eval'],
  },
  docker: {
    why: 'MCP server 容器不许借宿主命名空间（那等于把边界交给容器里的人配）',
    subcommands: [
      '--network', '--network=', '--pid', '--pid=', '--ipc', '--ipc=',
      '--privileged', '--userns', '--userns=',
    ],
    flags: ['--network', '--pid', '--ipc', '--privileged', '--userns'],
  },
  podman: {
    why: '同上（宿主命名空间）',
    subcommands: ['--network', '--network=', '--pid', '--pid=', '--ipc', '--ipc=', '--privileged'],
    flags: ['--network', '--pid', '--ipc', '--privileged'],
  },
  pwsh: {
    why: 'PowerShell 的 stdio server 要从脚本文件起（`-Command` / `-c` 是内联执行；`-File` 才对）',
    flags: ['-command', '-c', '-encodedcommand', '-e', '-ec'],
  },
  powershell: {
    why: '同上（`-Command` / `-c` 是内联执行；`-File` 才对）',
    flags: ['-command', '-c', '-encodedcommand', '-e', '-ec'],
  },
  cmd: {
    why: 'cmd 的 `/c` / `/k` 是内联执行（要跑批处理就把它包成一个 .cmd 文件、command 直接写那个文件）',
    flags: ['/c', '/k'],
  },
  sh: {
    why: 'shell 的 `-c` 是内联执行',
    flags: ['-c'],
  },
  bash: {
    why: 'shell 的 `-c` 是内联执行',
    flags: ['-c'],
  },
  zsh: {
    why: 'shell 的 `-c` 是内联执行',
    flags: ['-c'],
  },
  npm: {
    why: 'npm 的 `exec` / `x` 是"再起一个任意命令"（stdio server 请直接写那个命令，或用 npx）',
    flags: ['exec', 'x'],
  },
};

/**
 * 命令名里**不许出现**的字符：shell 元字符 + 控制字符。
 *
 * 为什么连引号一起禁：我们**不经过 shell**（`spawn(command, args)`，见 `defaultMcpProcessSpawner`），
 * 所以引号在这里没有合法用途，它只可能是"把一条命令写成一条命令行"的企图。
 * **路径分隔符、盘符冒号、空格一律不禁**：配绝对路径是合法的（GUI 上那条提示写着
 * "PATH 里找得到，或写绝对路径"），而判断只看文件名那一格（`launcherNameOf`）。
 * 命令名里真带空格（`node rm -rf`）会被白名单挡住——它归一出来不是任何一个已知启动器。
 */
export const COMMAND_FORBIDDEN_PATTERN = /['"`;&|<>^$%!(){}[\]*?~#\u0000-\u001f\u007f]/u;

/** `args` / `env` 里不许含的字符：控制字符（含换行、NUL、回车） */
export const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000a-\u001f\u007f]/u;

/** 解析结果：要么放行，要么给一句**能照做**的话 */
export type LauncherVerdict = { ok: true; launcher: string } | { ok: false; reason: string };

/** 把 `"a, B;c"` 这种清单归一成 `["a","b","c"]`（大小写不敏感，`,` 与 `;` 都当分隔符） */
function splitLauncherNames(raw: string): string[] {
  return raw
    .split(/[,;]/u)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '');
}

/**
 * 从环境里取出"额外放行"的命令名（**最高优先的那一格**）。
 *
 * 语义与 `mcp.extraLaunchers` 完全一致（都只放开"命令名"那一格），差别只在优先级与寿命：
 * 环境变量是本次进程的临时口径，配置格是持久口径——两个来源**并集**，谁也不覆盖谁
 * （所以"配置里写了、环境里没写"与"两边都写"在放行结果上等同；顺序见下面那份合并表）。
 */
export function extraAllowedLaunchers(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[STDIO_LAUNCHER_ALLOWLIST_ENV];
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return splitLauncherNames(raw);
}

/**
 * 从配置里取出"额外放行"的命令名（`mcp.extraLaunchers`，2026-10-10 加）。
 *
 * 两条刻意的口径，与上面那格**同源**：
 *   • 一律 `trim().toLowerCase()`：Windows 上 `Obscura` 与 `obscura` 是同一个程序，
 *     而 `launcherNameOf` 也按小写归一 ⇒ 两处不一致会出现"配了却不生效"；
 *   • 空串/空元素丢掉（不报错）：配置里多打一个逗号不该让整机起不来。**类型不对才报错**
 *     ——那一层在 `config.ts` 的 `readMcpConfig` 里判（与 `maxInFlight` / `rssSample` 同一条纪律）。
 */
export function configAllowedLaunchers(configured: readonly string[] | undefined): string[] {
  if (configured === undefined) return [];
  const out: string[] = [];
  for (const item of configured) {
    for (const name of splitLauncherNames(item)) out.push(name);
  }
  return out;
}

/**
 * 生效的白名单（默认表 + 配置格 + 环境变量）；错误信息与测试都读这一份，不各拼一遍。
 *
 * **顺序即优先级**（前面的先出现，但三格是**并集**、不是覆盖）：
 *   ① `DEFAULT_STDIO_LAUNCHER_ALLOWLIST`——通用启动器（出厂就认，不写配置也有）；
 *   ② `extraFromConfig`（`mcp.extraLaunchers`）——这台机器上额外要放行的；
 *   ③ `IRMIA_MCP_STDIO_ALLOWLIST`——**最高优先**那一格（临时口径压过文件里的持久口径）。
 * 去重按小写做、**保留第一次出现的拼写**（默认表里的 `npx` 不会被配置里的 `NPX` 顶掉，
 * 错误信息里那份清单因此与 `DEFAULT_STDIO_LAUNCHER_ALLOWLIST` 逐字对得上）。
 */
export function effectiveLauncherAllowlist(
  env: NodeJS.ProcessEnv = process.env,
  extraFromConfig: readonly string[] | undefined = undefined,
): string[] {
  const extra = [...configAllowedLaunchers(extraFromConfig), ...extraAllowedLaunchers(env)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...DEFAULT_STDIO_LAUNCHER_ALLOWLIST, ...extra]) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * 命令名归一：`C:\Program Files\nodejs\node.exe` / `/usr/local/bin/node` / `node` ⇒ `node`。
 *
 * 为什么按 basename 判而不是"整串必须等于 node"：**配绝对路径是合法的**（同 `config.ts`
 * 出厂文档那句）。所以白名单判的是**文件名**那一格，路径本身不参与判据——路径的越界不归
 * 这一层管（那是 `trust.mode` 的事，而这里已认"server 不受那条边界约束"）。
 */
export function launcherNameOf(command: string): string {
  const name = basename(command.trim());
  // Windows：`node.exe` 与 `node` 是同一个程序；`.cmd`/`.bat` 包装器同理
  return name.replace(/\.(exe|cmd|bat|com)$/iu, '').toLowerCase();
}

/**
 * 判一份 stdio 声明**能不能起**。返回 `{ok:false}` 时 `reason` 是一句给配置者的完整解释
 * （含放行办法），调用方把它原样拼进 `McpConfigError` 即可，不要另写一套措辞。
 */
export function checkLauncherSpec(
  command: unknown,
  args: readonly unknown[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
  extraFromConfig: readonly string[] | undefined = undefined,
): LauncherVerdict {
  if (typeof command !== 'string' || command.trim() === '') {
    return { ok: false, reason: 'command 必须是非空字符串' };
  }
  const raw = command.trim();
  const hit = COMMAND_FORBIDDEN_PATTERN.exec(raw);
  if (hit !== null) {
    return {
      ok: false,
      reason: `command ${JSON.stringify(raw)} 里不许出现 shell 元字符或控制字符`
        + `（第一个是 ${JSON.stringify(hit[0])}）：我们不经过 shell 起进程（spawn(command, args)），`
        + '所以这些字符在这里没有合法用途。参数一律走 args 数组，一格一个。',
    };
  }
  const launcher = launcherNameOf(raw);
  const allowlist = effectiveLauncherAllowlist(env, extraFromConfig);
  if (!allowlist.some((name) => name.toLowerCase() === launcher)) {
    return { ok: false, reason: describeNotAllowed(launcher, allowlist) };
  }
  const restriction = LAUNCHER_RESTRICTIONS[launcher];
  if (restriction !== undefined && args !== undefined) {
    const tokens = args.map((arg) => (typeof arg === 'string' ? arg : String(arg)));
    for (const token of tokens) {
      const lower = token.toLowerCase();
      const bare = lower.includes('=') ? (lower.split('=')[0] ?? lower) : lower;
      const subcommandHit = (restriction.subcommands ?? []).find(
        (item) => lower === item || lower.startsWith(item),
      );
      const flagHit = (restriction.flags ?? []).find((item) => bare === item);
      if (subcommandHit === undefined && flagHit === undefined) continue;
      const shown = subcommandHit ?? flagHit ?? '';
      return {
        ok: false,
        reason: `启动器 ${launcher} 的这一格参数被拒：${JSON.stringify(token)}`
          + `（命中的判据是 ${JSON.stringify(shown)}）。${restriction.why}。`
          + `要放行"另一个启动器"就在 config.json 的 mcp.extraLaunchers 里写它`
          + `（或设环境变量 ${STDIO_LAUNCHER_ALLOWLIST_ENV}=<命令名,逗号分隔>）；`
          + '**但内联执行这一层不会被放行口关掉**——它是按启动器写死的（判据在 '
          + 'src/mcp/launcher-guard.ts 的 LAUNCHER_RESTRICTIONS）。',
      };
    }
  }
  return { ok: true, launcher };
}

/** 不在白名单里的那句解释（**必须给三条出路**：改配置、走放行口、白名单在哪） */
function describeNotAllowed(launcher: string, allowlist: readonly string[]): string {
  return `MCP server 的启动器 ${JSON.stringify(launcher)} 不在白名单里。`
    + `白名单（${allowlist.length} 项）在 src/mcp/launcher-guard.ts 的 DEFAULT_STDIO_LAUNCHER_ALLOWLIST：`
    + `${allowlist.join('、')}。三种做法：`
    + '① 换成白名单里的启动器（把 my-server 写成 node ./my-server.js 这一类）；'
    + `② 真要用这个启动器，就把它显式放行。两处入口，语义完全一样：`
    + `   · **配置文件**（推荐，持久）：config.json 的 mcp.extraLaunchers 里加 ${JSON.stringify(launcher)}`
    + '（字符串数组）——改完**不重启**也生效（声明面热加载会连它一起重新校验）；'
    + `   · **环境变量**（临时 / 救急，**优先于上面那一格**）：`
    + `${STDIO_LAUNCHER_ALLOWLIST_ENV}=${launcher}（多个用逗号分隔）再重启进程。`
    + '**显式放行才算数**（这一条是刻意的：加一个 server 就是在给这台机器加一个不受 trust.mode'
    + '约束的进程，见 docs/mcp-wiring.md:100-102）；'
    + '③ 这个启动器本身就不该当 MCP server（git / curl / ssh 这类"能直接动这台机器"的程序）。'
    + '放行口只放开"命令名"这一格：args 控制字符、逐启动器禁内联执行那两层照旧生效。';
}

/**
 * 校验 `args`：只查控制字符（"必须是字符串数组"那条 `parseMcpServers` 已经查过）。
 *
 * 为什么不查别的：`args` 的内容**本来就该由 server 自己决定**（`npx -y <包名>`、
 * `--root <目录>` 都是合法参数）。这里只挡一种东西——**把换行/NUL 塞进参数**，
 * 那是"想骗过某处按行解析"的形态，正常参数里不会出现。
 */
export function checkLauncherArgs(args: readonly string[] | undefined): string | null {
  if (args === undefined) return null;
  for (const arg of args) {
    if (CONTROL_CHAR_PATTERN.test(arg)) {
      return `args 里不许含控制字符（换行 / NUL / 回车等）：${JSON.stringify(arg)}。`
        + '参数要一格一个地放进数组，别把多行内容塞进单格。';
    }
  }
  return null;
}

/**
 * 校验 `env`：键名非空且不含控制字符、值不含控制字符。
 *
 * 这一格 `parseMcpServers` 已经查过"string→string"，这里补的是**形状之外**那半。
 * `=` 在键名里是合法的（Node 的 env 对象支持 `"A=B": "v"` 这种删除语义），所以不拦它。
 */
export function checkLauncherEnv(env: Record<string, string> | undefined): string | null {
  if (env === undefined) return null;
  for (const [key, value] of Object.entries(env)) {
    if (key.trim() === '') return 'env 里有一个空键名：改成有名字的键（例如 TOKEN）。';
    if (CONTROL_CHAR_PATTERN.test(key)) {
      return `env 的键名 ${JSON.stringify(key)} 里不许含控制字符。`;
    }
    if (CONTROL_CHAR_PATTERN.test(value)) {
      return `env.${key} 的值里不许含控制字符（换行 / NUL / 回车等）：`
        + '要放多行内容就放进文件，用 args 指路径。';
    }
  }
  return null;
}

/**
 * 一把尺子：把上面三层串起来（`parseMcpServers` 只调这一个口）。
 * 返回 null = 放行；返回字符串 = 一句给人看的完整原因。
 */
export function checkStdioLauncher(
  command: unknown,
  args: readonly string[] | undefined,
  env: Record<string, string> | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
  extraFromConfig: readonly string[] | undefined = undefined,
): string | null {
  const verdict = checkLauncherSpec(command, args, processEnv, extraFromConfig);
  if (!verdict.ok) return verdict.reason;
  return checkLauncherArgs(args) ?? checkLauncherEnv(env);
}

// ══════════════════════ ⑥ 这一台机器上根本起不来的形状（Windows；2026-10-10 加） ══════════════════════

/**
 * Windows 上**只有 `.cmd` / `.ps1` 垫片**的那批启动器（npm 全局装出来的样子）。
 *
 * 名单本身不是判据——真正的判据是"**PATH 上有没有同名的 `.exe` / `.com`**"（见
 * `windowsExecutableOnPath`）：standalone 装的 `pnpm.exe`、bun 的 `bunx.exe` 都不该被误拦。
 * 名单只决定"哪些名字值得去查一次 PATH"（别的名字一律不查，别给每次启动加 I/O）。
 *
 * 前七个是**本机实测**（node v22.19.0 + Windows 10.0.26200，`spawn(name, ['--version'])`
 * 不经 shell）：`npx` / `npm` / `pnpm` / `yarn` / `corepack` / `tsx` 全部 **ENOENT**；
 * 后四个是 MCP 生态里同样由 npm 全局装出来的（同一机制，**未逐个实测**）。
 */
export const WINDOWS_SHIM_ONLY_LAUNCHERS: readonly string[] = [
  'npx', 'npm', 'pnpm', 'yarn', 'corepack', 'tsx', 'ts-node',
  'mcp', 'mcp-server', 'mcp-proxy', 'supergateway',
];

/**
 * 被 `spawn`（不经 shell）**直接拒掉**的包装脚本后缀。
 *
 * 本机实测（node v22.19.0）：`spawn('npx.cmd')` ⇒ **同步 EINVAL**、`spawn('npx.ps1')` ⇒ **同步 EFTYPE**。
 * 原因是 CVE-2024-27980 之后 Node 的缓解：`.cmd` / `.bat` 必须 `shell:true` 才肯起；我们**刻意不经 shell**。
 */
export const WINDOWS_UNSPAWNABLE_SUFFIXES: readonly string[] = ['.cmd', '.bat', '.ps1'];

/** 「改成什么」那一段（两种死路共用一份，别各写一遍） */
const WINDOWS_STARTABLE_SHAPES =
  '改成**这一台机器上实测起得来**的写法：'
  + '① `node <绝对路径>/cli.js`——把那个包落下来、直指它的入口 js（`node` 是真 .exe）；'
  + '② `uvx <工具名>`——`uvx` 也是真 .exe（代价：它会多带几个子进程，内存账见 docs/multi-mcp-memory.md）；'
  + '③ 某个**绝对路径的 .exe**——原生单文件 server 最省（实测 18–20 MB / 66 ms）。';

/** 「还有哪条死路」那一段（同上，共用） */
const WINDOWS_DEAD_ENDS =
  '`cmd /c …` 这条老路同样走不通：它被我们自己的启动器白名单拒'
  + '（LAUNCHER_RESTRICTIONS 里 cmd 的 flags = ["/c","/k"]）；'
  + '而放行口（config.json 的 mcp.extraLaunchers 与环境变量 IRMIA_MCP_STDIO_ALLOWLIST）'
  + '只放开"命令名"那一格，放不开上面这两条——'
  + '它们是 Node 与 OS 层面的限制，不是配置写法的问题。';

/** 这个名字在 PATH 上有没有**真能执行**的 `.exe` / `.com`（Windows 上"能不能 spawn"就看它） */
function windowsExecutableOnPath(fileName: string, env: NodeJS.ProcessEnv): string | null {
  const names = /\.(exe|com)$/iu.test(fileName) ? [fileName] : [`${fileName}.exe`, `${fileName}.com`];
  const pathValue = env['PATH'] ?? env['Path'] ?? '';
  for (const dir of pathValue.split(delimiter)) {
    const trimmed = dir.trim().replace(/^"|"$/gu, '');
    if (trimmed === '') continue;
    for (const name of names) {
      const candidate = join(trimmed, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 这一台机器上**按 `spawn(command, args)`（不经 shell）根本起不来**的已知形状 ⇒ 一句能照做的诊断。
 *
 * 返回 `null` = 不拦（照常 spawn）；返回字符串 = 一句给配置者的话（**为什么** + **改成什么**）。
 *
 * 为什么要有它：出厂示例与半个生态都写着 `{"command":"npx"}`，而在 Windows 上它只会换来一句
 * 裸 ENOENT——读的人既不知道"为什么"，也不知道"那该写什么"。判据**只有这一处**，
 * `defaultMcpProcessSpawner` 在起进程之前调它（`client.ts`），诊断文案也只有这一份。
 *
 * 判据（**只在 Windows 上成立**，且只覆盖实测过的两种形状）：
 *   ① 命令名以 `.cmd` / `.bat` / `.ps1` 结尾 ⇒ Node 同步拒（EINVAL / EFTYPE，实测）；
 *   ② 裸命令名（不带路径）是 `WINDOWS_SHIM_ONLY_LAUNCHERS` 里的一个，**且 PATH 上没有同名
 *      `.exe` / `.com`** ⇒ 起不来（`npx` 实测 ENOENT：CreateProcess 只给命令名补 `.exe`，
 *      npm 发的是 `npx.cmd` / `npx.ps1`）。这一条带了 PATH 检查，所以"真有 `npx.exe` 的机器"
 *      不会被误拦；Linux / macOS 上一律返回 `null`（那边 `npx` 是真能起的）。
 */
export function unstartableLauncherReason(
  command: unknown,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (platform !== 'win32') return null;
  if (typeof command !== 'string') return null;
  const raw = command.trim();
  if (raw === '') return null;
  const name = basename(raw);
  const lower = name.toLowerCase();
  const before = '（这一句判在起进程之前：**没有为它留下任何进程**。）';
  const opener = `command ${JSON.stringify(raw)} 在 Windows 上起不来：`;

  // ① 包装脚本：`.cmd` / `.bat` / `.ps1`（有没有路径都一样，Node 只看后缀）
  if (WINDOWS_UNSPAWNABLE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return opener
      + '`.cmd` / `.bat` 包装脚本会被 Node **同步拒掉**（本机 node v22.19.0 实测 EINVAL；`.ps1` 是 EFTYPE）——'
      + '那是 CVE-2024-27980 之后的缓解：不经 shell 就起不了包装脚本，而我们**刻意**不经 shell'
      + '（`spawn(command, args)`，见 client.ts 的 defaultMcpProcessSpawner）。'
      + before + WINDOWS_STARTABLE_SHAPES + WINDOWS_DEAD_ENDS;
  }

  // ② 裸命令名 + npm 垫片 + PATH 上没有同名的可执行文件
  const hasPath = raw.includes('/') || raw.includes('\\');
  if (hasPath) return null;
  const launcher = launcherNameOf(name);
  if (!WINDOWS_SHIM_ONLY_LAUNCHERS.includes(launcher)) return null;
  if (windowsExecutableOnPath(name, env) !== null) return null;
  const looked = /\.(exe|com)$/iu.test(name) ? name : `${name}.exe`;
  return opener
    + 'spawn 不经 shell 时 CreateProcess 只给命令名补 `.exe`，而 PATH 上**没有 ' + looked + '**'
    + '（用 npm 装的话，' + launcher + ' 只有 ' + launcher + '.cmd / ' + launcher + '.ps1 这两个垫片；'
    + '本机 node v22.19.0 上 `npx` / `npm` / `pnpm` / `yarn` / `corepack` / `tsx` 实测都是 ENOENT）。'
    + before + WINDOWS_STARTABLE_SHAPES + WINDOWS_DEAD_ENDS;
}
