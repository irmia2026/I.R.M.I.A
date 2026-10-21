/**
 * Irmia Agent —— 重启链条用的那个 shell（"谁来跑 tools/restart-agent.ps1"）。
 *
 * ## 为什么要有这个文件
 *
 * 重启那条路是"用 WMI 建一个**分离**的进程去跑脚本"（本进程不能自己重启自己）。
 * WMI 建进程的环境**没有 PATH**，所以传给它的可执行文件必须是绝对路径，或者是一个
 * 系统一定找得到的名字（`powershell.exe` 在 System32 里，满足这一条）。
 *
 * 这段判断原先写死在 `web/server.ts` 里，而且写的是**本机私事**：
 * `existsSync('C:\\path\\to\\pwsh.exe') ? … : 'powershell.exe'`。
 * 那是开发机上某一个 pwsh 的安装位置——换台机器它永远不存在，于是每个测试者都在跑
 * 兜底分支，而源码里留着一条只有作者本人看得懂的硬编码路径。
 *
 * ## 探测顺序（前一个不存在就看下一个，全都不存在就用系统自带那个）
 *
 *   ① `IRMIA_PWSH` 环境变量：显式指定优先。装在不常见位置的人有一条明路，
 *      不必改代码、也不必指望这套猜测命中；
 *   ② PATH 里的 `pwsh.exe`：正常安装（winget / MSI）都会进 PATH；
 *   ③ 两个标准安装目录（PowerShell 7 / 6 的 Program Files 位置）：PATH 被裁剪过的
 *      环境（服务、任务计划、某些启动器）里，这一条往往才是唯一命中的；
 *   ④ `powershell.exe`：系统自带的 Windows PowerShell 5.1。**它一定在**，
 *      而 `restart-agent.ps1` 是按 5.1 兼容写的（文件存 UTF-8 带 BOM，正是为它）。
 *
 * ## 为什么用"注入 fileExists"的写法
 *
 * 这段判断的价值全在"哪种环境挑到哪一个"上，而那些环境造不出来（不能为了测试删掉
 * 系统里的 pwsh）。所以探测逻辑写成纯函数：环境变量与"文件在不在"都由调用方给，
 * 测试就能把四种情形都摆一遍。
 */

/** 默认的候选绝对路径（Windows 上 PowerShell 的标准安装位置） */
const DEFAULT_CANDIDATES: readonly string[] = [
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'C:\\Program Files\\PowerShell\\6\\pwsh.exe',
];

/** 全都探测不到时用它：系统自带、WMI 环境也找得到（在 System32 里） */
export const FALLBACK_SHELL = 'powershell.exe';

export interface ResolveRestartShellOptions {
  /** 环境变量（默认 `process.env`）；只读 `IRMIA_PWSH` 与 `PATH` */
  env: Record<string, string | undefined>;
  /** "这个绝对路径存在吗"（默认 fs.existsSync）；测试注入 */
  fileExists: (path: string) => boolean;
  /** 标准安装位置覆盖点（测试用） */
  candidates?: readonly string[];
}

/**
 * 挑一个 shell 去跑重启脚本。返回的字符串**要么是存在的绝对路径，要么是兜底的名字**
 * （绝不返回一个不存在的绝对路径——那正是原来那条硬编码路径的病）。
 */
export function resolveRestartShell(options: ResolveRestartShellOptions): string {
  const explicit = (options.env['IRMIA_PWSH'] ?? '').trim();
  if (explicit !== '' && options.fileExists(explicit)) return explicit;

  const fromPath = findOnPath(options.env['PATH'], 'pwsh.exe', options.fileExists);
  if (fromPath !== null) return fromPath;

  for (const candidate of options.candidates ?? DEFAULT_CANDIDATES) {
    if (options.fileExists(candidate)) return candidate;
  }
  return FALLBACK_SHELL;
}

/**
 * 在 PATH 里找一个可执行文件。
 *
 * 只做"目录拼上文件名、问一句在不在"这种最笨的检查（不查 PATHEXT、不查注册表）：
 * 这里要的是一个**绝对路径**，`pwsh.exe` 是完整文件名，够用；猜多了反而会出现
 * "挑到一个跑不了的东西"这种更难查的故障。
 */
export function findOnPath(
  pathValue: string | undefined,
  fileName: string,
  fileExists: (path: string) => boolean,
): string | null {
  if (pathValue === undefined || pathValue === '') return null;
  for (const raw of pathValue.split(';')) {
    const dir = raw.trim().replace(/^"|"$/gu, '');
    if (dir === '') continue;
    const full = `${dir.endsWith('\\') || dir.endsWith('/') ? dir.slice(0, -1) : dir}\\${fileName}`;
    if (fileExists(full)) return full;
  }
  return null;
}
