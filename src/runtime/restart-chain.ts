/**
 * Irmia Agent —— 重启链条的**路径选择**（唯一一处判据）。
 *
 * ## 这个文件治的是什么（2026-10-07 用户报的缺陷）
 *
 * 用户报的是「**beta5 内测包重启不了**」，根因是结构性的、不是偶发：
 *
 *   · 内测包**根本不含 `tools\` 目录、不含 `restart-agent.ps1`**
 *     （包根只有 dist/ gui/ runtime/ skills/ config.example.json config.json package.json
 *       README-BETA.md START.cmd start.ps1 VERSION.txt）；
 *   · 而服务端的重启命令是**去跑 `tools\restart-agent.ps1`**（`web/server.ts` 那条命令行）。
 *
 * ⇒ 在**装出来的那份**（不是开发仓库）里重启**必然失败**：脚本不存在。
 *   开发机上看不出来，因为开发仓库里 `tools\` 一直在。
 *
 * 隔离复现（beta.5 的装配目录拷进 %TEMP%、自带 dataDir 与端口 7801，2026-10-07）：
 *   POST /api/commands/restart ⇒ `scriptStarted:false · backendPid:0 · port:unknown`，
 *   `data\restart-script.log` 里是 pwsh 的原话
 *   `The argument '…\beta5\tools\restart-agent.ps1' is not recognized as the name of a script file.`，
 *   而 `data\lock.json` 的 pid 从头到尾没变（后端根本没被重启）。
 *   WMI `Create` 那一层返回码 **0** —— 又一次"返回码 0 而脚本一个字都没执行"。
 *
 * ## 判据（优先级链，前一条存在就不看后一条）
 *
 *   ① `repo-script`      `<root>/tools/restart-agent.ps1` —— **开发机**（仓库里）走它，保持原样；
 *   ② `packaged-script`  `<root>/restart.ps1` —— **随包脚本**（由 `packaging/` 装配到包根）。
 *                        装在别人机器上的那份靠它，**不依赖仓库里才有的东西**；
 *   ③ `self-restart`     两条都没有 ⇒ 框架**自己**用 `runtime/node/node.exe`
 *                        起一份新的自己（入口 = 装出来的那份的 `dist/main.js`、
 *                        cwd = 安装根、stdout/stderr 重定向到它自己的日志），
 *                        然后**优雅退出**（走既有退出路径：落事件、收尾、让锁释放）。
 *
 * 为什么顺序是这样：仓库里 `tools/` 一直在，所以开发机的行为**一个字节都不能变**（①）；
 * 随包脚本能做开发机脚本能做的一切（按安装根匹配命令行、等旧实例真消失再拉新的），
 * 所以它是装机版的首选（②）；两条都没有时**绝不能回到"跑一条不存在的脚本"**——
 * 那正是这次的缺陷，所以兜底必须是"框架自己会这一手"，而不是"报错让人去修"（③）。
 *
 * ## 为什么判据在这里、而不在 web/server.ts 里
 *
 * 这条链路的正确性全靠"哪种环境挑到哪一条"，而那些环境造不出来（不能为了测试把仓库里的
 * `tools/` 删掉）。所以选择逻辑写成纯函数：目录里有什么由调用方给（注入 `fileExists`），
 * 三条分支在测试里都能摆一遍（见 `test/restart-chain.test.ts`）。
 */

import { join } from 'node:path';

/** 重启链条实际走的那一条 */
export type RestartPath = 'repo-script' | 'packaged-script' | 'self-restart';

/** 三条路径的**回执里要写明的那个名字**（服务端、随包脚本、拉起器三处共用一个写法） */
export const RESTART_PATH_LABEL: Record<RestartPath, string> = {
  'repo-script': 'repo-script',
  'packaged-script': 'packaged-script',
  'self-restart': 'self-restart',
};

/** 仓库脚本（开发机）在安装根下的相对位置 */
export const REPO_RESTART_SCRIPT_REL = join('tools', 'restart-agent.ps1');
/** 随包脚本在安装根下的相对位置（装配清单 `packaging/assemble-package.ps1` 的 $PayloadFiles 里也有它） */
export const PACKAGED_RESTART_SCRIPT_REL = 'restart.ps1';
/** 自带 Node 运行时在安装根下的相对位置（tier ③ 用它起新的自己） */
export const BUNDLED_NODE_REL = join('runtime', 'node', 'node.exe');
/** 后端入口在安装根下的相对位置（tier ③ 拉起的就是它） */
export const BACKEND_ENTRY_REL = join('dist', 'main.js');
/** tier ③ 的拉起器：**随 dist 一起装配**，不是"仓库里才有的脚本" */
export const RESTART_WORKER_REL = join('dist', 'runtime', 'restart-worker.js');

/** "这个绝对路径存在吗"（默认 fs.existsSync）；测试注入 */
export interface RestartPathProbe {
  fileExists: (path: string) => boolean;
}

export interface RestartPathChoice {
  path: RestartPath;
  /** 走这一条时实际要用的文件（tier ③ = 拉起器；机器可读，写进留痕/事件里） */
  file: string;
  /**
   * 为什么是这一条（人读的一句话，直接进日志/事件）——
   * "装了却没有脚本"这件事必须能事后看出来，否则下一次又要靠现场复现才知道。
   */
  why: string;
}

/** 仓库脚本的绝对路径 */
export function repoRestartScript(root: string): string {
  return join(root, REPO_RESTART_SCRIPT_REL);
}

/** 随包脚本的绝对路径 */
export function packagedRestartScript(root: string): string {
  return join(root, PACKAGED_RESTART_SCRIPT_REL);
}

/** tier ③ 拉起器的绝对路径 */
export function restartWorkerScript(root: string): string {
  return join(root, RESTART_WORKER_REL);
}

/** 后端入口的绝对路径（tier ③ 拉起它；①② 把它作为 `-NodeEntry` 传给脚本） */
export function backendEntry(root: string): string {
  return join(root, BACKEND_ENTRY_REL);
}

/**
 * 挑一条重启路径。**优先级链只有这一处**（服务端不再自己判"脚本在不在"）。
 *
 * 注意 tier ③ 的判据里**没有**"拉起器在不在"：那份文件随 `dist\` 一起装配，
 * 而 `dist\` 是这次要修的东西本身的产物。把它算进"选哪条路径"会让判据依赖自己刚写下的
 * 文件在不在（一个先有鸡还是先有蛋的问题）。所以这里的口径是：
 * **两条脚本都没有 ⇒ 自重启**；拉起器缺失是**自发自重启之后**才可能暴露的失败
 * （服务端会在那一步如实报 `restart-self-worker-missing`，绝不悄悄退回"跑一条不存在的脚本"）。
 */
export function chooseRestartPath(root: string, probe: RestartPathProbe): RestartPathChoice {
  const repo = repoRestartScript(root);
  if (probe.fileExists(repo)) {
    return {
      path: 'repo-script',
      file: repo,
      why: `安装根里有仓库脚本（${REPO_RESTART_SCRIPT_REL}）——开发机的形状，走它（与从前一字不差）`,
    };
  }
  const packaged = packagedRestartScript(root);
  if (probe.fileExists(packaged)) {
    return {
      path: 'packaged-script',
      file: packaged,
      why: `安装根里没有仓库脚本，但有随包脚本（${PACKAGED_RESTART_SCRIPT_REL}）——装出来的那份走它`,
    };
  }
  return {
    path: 'self-restart',
    file: restartWorkerScript(root),
    why: `安装根里既没有仓库脚本（${REPO_RESTART_SCRIPT_REL}）也没有随包脚本（${PACKAGED_RESTART_SCRIPT_REL}）`
      + '——框架自己拉起一份新的自己（不依赖任何随包/仓库脚本）',
  };
}

/**
 * 从留痕里读"这次走的是哪一条"（`路径=<名字>` / `path=<名字>`）。
 *
 * 为什么留痕里要有它：三条路径的**失败症状长得一样**（后端没换 pid），
 * 而后事要回答的第一个问题恰恰是"它当时想走哪条、走到了哪一步"。
 * 读不到就返回 null（老脚本、旧留痕没有这一栏）——**不猜**。
 */
export function parseRestartPath(text: string): RestartPath | null {
  const hit = /(?:路径=|path=)(repo-script|packaged-script|self-restart)\b/u.exec(text);
  return hit === null ? null : (hit[1] as RestartPath);
}

/** 留痕行前缀：服务端发起（tier ③ 只有它有）、链条自己起跑、换了实例、收尾 */
export type RestartTraceKind = '发起' | '回执' | '实例' | '结束';

/**
 * 拼一行**定形**的重启留痕。
 *
 * 为什么行格式要挤在这样一个函数里：这三行是服务端、随包脚本、拉起器**三方共同**写的，
 * 而服务端要按行解析它们（`parseRestartTrace`）。三处各拼一次就会出现
 * "服务端读 A、脚本写 B"的分岔——而这条留痕的全部意义就是"能对上"。
 *
 * 行形状（与 `tools\restart-agent.ps1` 的历史写法兼容，只**多加**一栏 `路径=`）：
 *   `[发起] 路径=self-restart · 由服务端 pid=… 发起 · …`
 *   `[回执] 路径=<path> · …`
 *   `[实例] 后端已接管 pid=<n> source=<来源> path=<path>`
 *   `[结束] ok=True/False backendPid=<n> port=<档> guiPid=<n> path=<path> reason=<token> · <人读的话>`
 */
export function restartTraceLine(kind: RestartTraceKind, body: string): string {
  return `[${kind}] ${body}\r\n`;
}

/** `[实例]` 那一行（服务端认的"后端换了 pid"凭据） */
export function instanceTraceLine(input: {
  backendPid: number;
  source: string;
  path: RestartPath;
}): string {
  return restartTraceLine('实例',
    `后端已接管 pid=${input.backendPid} source=${input.source} path=${RESTART_PATH_LABEL[input.path]}`);
}

/** `[结束]` 那一行（**恰好写一次**；服务端据此说成功/失败与为什么） */
export function endTraceLine(input: {
  ok: boolean;
  backendPid: number;
  port: 'ready' | 'waiting' | 'timeout' | 'unknown';
  guiPid: number;
  path: RestartPath;
  /** 失败的那一环（机器可读 token；成功时是 `ok`）——"不许没能确认了事" */
  reason: string;
  /** 人读的一句话（可空） */
  detail?: string | undefined;
}): string {
  const head = `ok=${input.ok ? 'True' : 'False'} backendPid=${input.backendPid}`
    + ` port=${input.port} guiPid=${input.guiPid}`
    + ` path=${RESTART_PATH_LABEL[input.path]} reason=${input.reason}`;
  const detail = (input.detail ?? '').trim();
  return restartTraceLine('结束', detail === '' ? head : `${head} · ${detail}`);
}

/**
 * 失败环节的**机器可读名字**（"失败要说清哪一环"的落点）。
 *
 * 用户 2026-10-07 的原话是「不许用'猜'的确认」，同一句话的另一半是
 * 「失败不许'没能确认'了事」：这三条路径上可能坏的环节是有限的，逐个起名，
 * 于是"重启没成"这件事事后能一眼看出坏在哪一段，而不是只能看到一句"没能确认"。
 */
export const RESTART_FAILURE_REASONS = {
  /** tier ③：随包脚本与仓库脚本都不在，而拉起器那份文件也没装进来 */
  workerMissing: 'worker-missing',
  /** tier ③：拉起器没留下回执（WMI 那一层被拒 / 拉起器自己起不来） */
  workerNotStarted: 'worker-not-started',
  /** tier ②/③：旧实例在等它的窗口里没有退出（新实例起不来是因为它占着锁/端口） */
  oldNotGone: 'old-not-gone',
  /** tier ②/③：新实例的进程没起来（入口不认 / 缺依赖 / 起来就自己退了） */
  spawnFailed: 'spawn-failed',
  /** 进程起来了，但端口在窗口里没有应答 */
  portNotReady: 'port-not-ready',
  /** 端口应答了，但 lock.json 里的 pid 没换成新的（"换了个人"这条凭据不成立） */
  lockNotChanged: 'lock-not-changed',
  /** 界面进程没能重启（收到 -GuiExe / --gui-exe 却停不掉或拉不起来） */
  guiFailed: 'gui-failed',
  /** WMI 那一层就没把进程建起来（返回码非 0 / 抛异常） */
  wmiFailed: 'wmi-failed',
  /** 一切正常 */
  ok: 'ok',
} as const;

export type RestartFailureReason = typeof RESTART_FAILURE_REASONS[keyof typeof RESTART_FAILURE_REASONS];

/** 失败环节 → 人读的一句话（回执与界面说的是同一件事，只有这一处翻译） */
export function restartReasonText(reason: string): string {
  switch (reason) {
    case RESTART_FAILURE_REASONS.workerMissing:
      return 'self-restart 的拉起器没随包装配（dist\\runtime\\restart-worker.js 不在）';
    case RESTART_FAILURE_REASONS.workerNotStarted:
      return 'self-restart 的拉起器没有留下回执（它根本没跑起来：看 data\\restart-script.log）';
    case RESTART_FAILURE_REASONS.oldNotGone:
      return '旧实例在等待窗口里没有退出（新实例因此拿不到锁/端口）';
    case RESTART_FAILURE_REASONS.spawnFailed:
      return '新实例的进程没起来（入口不认 / 缺依赖 / 起来就自己退了）';
    case RESTART_FAILURE_REASONS.portNotReady:
      return '新实例的进程起来了，但端口没有应答';
    case RESTART_FAILURE_REASONS.lockNotChanged:
      return '端口应答了，但 lock.json 里的 pid 没有换成新的（"换了个人"这条凭据不成立）';
    case RESTART_FAILURE_REASONS.guiFailed:
      return '界面进程没能重启（停不掉或拉不起来）';
    case RESTART_FAILURE_REASONS.wmiFailed:
      return 'WMI 那一层就没把进程建起来（返回码非 0 或抛异常）';
    default:
      return '';
  }
}
