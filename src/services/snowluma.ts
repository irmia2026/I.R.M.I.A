/**
 * Irmia Agent — 内置协议端（可选开启的外部服务）
 *
 * **为什么要有它**：给 agent 多一条**独立的入站通道**——OneBot，背后是一个真实 QQ 号的社交圈
 * （好友与群聊），不受 QQ 开放平台的沙箱与审核限制。
 *
 * 它**不是**"官方 Bot 的群聊补丁"：2026-10-02 核过官方文档，全量群消息 `GROUP_MESSAGE_CREATE`
 * 用的就是 `GROUP_AND_C2C_EVENT (1<<25)` 那一个订阅位，平台上开了「接收所有消息」官方那条也
 * 收得到群消息（见 review.md 的「已了结（v32 遗留，2026-10-02）」）。两条通道各是一个独立的
 * 消息适配器，互不依赖——选哪条只看"想联络到谁"。
 *
 * 但协议端是个独立的长驻进程：让用户自己起它、自己把端口和 access_token 抄到两边，
 * 等于把框架该干的活推给人。所以这里把"拉起与对接"接过来。
 *
 * **为什么框架不打包它**：SnowLuma 用的是"源码可见非商业许可"，不是 OSI 开源许可——
 * 源码可看、可学、**可非商业自托管**，但商业使用与公开发布修改版都要事先书面授权，
 * 二进制发行包另受 EULA 约束。**自用没问题，随我们分发不行。**
 * 所以这个模块只做四件事：**探测 → 引导 → 拉起 → 对接**；安装由用户自己完成
 * （与 `deps` 那套"外部依赖交给框架管"同一个姿势，只是这一件更大、更该由人点头）。
 *
 * **对接为什么可以零配置**：SnowLuma 默认就在它的 `config/onebot.json` 里开一个 wsServer
 * （`127.0.0.1:3001`，与我们适配器的默认地址同值），access_token 也生成了写在那份文件里。
 * 所以框架**读它的配置**就够了——不需要人在两边各填一遍，也就不存在"两边填得不一样"这种故障。
 *
 * 与框架的关系：它是**她的眼睛**（看群），不是她的一部分。启动失败**不阻塞框架启动**——
 * 适配器按普通 OneBot 处理（连不上就重试），协议端起不来最多是"暂时看不到群"，
 * 不该让她整个停摆。
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';

import { killProcessTree } from '../process/kill-tree.ts';
import { createUtf8Stream, decodeText } from '../util/bytes-text.ts';

/** 服务状态机的取值（GUI 直接显示，所以用词要人能看懂） */
export type ManagedServiceState =
  /** 目录里没有可执行入口——多半还没下载 */
  | 'not-installed'
  /** 装好了但没跑 */
  | 'stopped'
  /** 已拉起，等它把端口开起来 */
  | 'starting'
  /** 端口通了，适配器可以连 */
  | 'ready'
  /** 起不来或中途死了（detail 带原因） */
  | 'failed';

/**
 * 协议端 WebUI 的登录口（**凭据只在这一层活着**）。
 *
 * 为什么单独一类而不是并进 detail：`detail` 会进日志、进界面、进诊断输出，
 * 而这里是**明文口令**。分开之后，"谁会拿到它"在类型上就看得见——只有 `status()` 的调用方，
 * 且只有 web 层那一个地方会把它照原样交给本机界面（见 server.ts 的 buildProtocolSideView）。
 */
export interface WebuiCredential {
  /** 面板要求修改初始密码（`config/webui.json` 的 mustChangePassword） */
  mustChangePassword: boolean;
  /** 初始用户名（SnowLuma 固定 admin）——只有真的拿到了口令才给 */
  user?: string;
  /** 初始口令原文。**只进内存、只进本机界面**，绝不落事件日志、绝不进 detail */
  password?: string;
  /** 口令是从哪来的：本次 stdout / 框架的启动输出留痕 / 没有（无法找回） */
  source: 'stdout' | 'console-log' | 'none';
}

/**
 * 协议端进程的探测结论（第一档）。
 *
 * `pid` 与"谁起的它"**必须分开说**：本次进程起的那个我们知道 pid；已经跑着的那个可能是
 * 上一次会话起的、也可能是人手工起的。两者都不代表"框架管着它"。
 */
export interface ProtocolProcessInfo {
  running: boolean;
  /** 进程号（查得到才有）。**快速探活那条路查不到**——那时宁可不给，也不编一个 */
  pid?: number;
  /**
   * 发现方式：
   *   · spawned    = 本次进程拉起的（pid 我们知道）；
   *   · discovered = 本次进程之前就在跑，靠监听端口反查到的（pid + 启动时刻都有）；
   *   · unmanaged  = 只确认了"那个端口后面是它"，没去查进程表（快，但没有 pid）
   */
  managed?: 'spawned' | 'discovered' | 'unmanaged';
  /** 进程启动时刻（ISO）；查不到就不给——**不给假值** */
  startedAt?: string;
  /** 它**实际**监听的地址（不是配置里写的那个：它会从 5099 退到 5100+） */
  webuiUrl?: string;
}

/**
 * OneBot 配置的探测结论（第二档）。
 *
 * 这一档是**根因那一档**：进程活着而这份文件不在 ⇒ 它从没登录过 QQ，
 * 所以没有端口可连。旧状态机把它压成一句"启动失败"，说的其实不是这件事。
 */
export interface ProtocolOnebotConfigInfo {
  present: boolean;
  /** 读得出来时给（与 `readEndpointFromConfig` 同一个来源，**绝不猜端口**） */
  endpoint?: { wsUrl: string; accessToken: string };
  /** 盘上那份文件的绝对路径（给排障用：人可以直接去看它） */
  path?: string;
  /** 有文件但读不出端点（JSON 坏了 / wsServers 空）——与"文件不在"是两件事 */
  unreadable?: boolean;
}

/** WebUI 的应答门状态（同意门 / 改密门）。**读盘即得，不联网** */
export interface ProtocolConsentInfo {
  /** `config/consent.json` 在不在（不在 = 同意门还没过） */
  consentRecorded: boolean;
  /** 改密门：`config/webui.json` 的 mustChangePassword */
  mustChangePassword: boolean;
}

/** 对外的一条完整报告：状态机的旧结论 + 三档事实 + WebUI 登录口 */
export interface ManagedServiceReport {
  state: ManagedServiceState;
  detail: string;
  process: ProtocolProcessInfo;
  onebotConfig: ProtocolOnebotConfigInfo;
  webui: ProtocolConsentInfo & {
    url?: string;
    /** 面板此刻能不能打开（进程在跑 + 探到监听端口） */
    open: boolean;
    credential: WebuiCredential;
  };
}

export interface ManagedServiceStatus {
  state: ManagedServiceState;
  /** 一句话说明（给人看的，含失败原因） */
  detail: string;
  /** 进程号（跑起来时才有） */
  pid?: number;
  /** 对接点：从协议端自己的配置里读出来的（适配器直接用它连） */
  endpoint?: { wsUrl: string; accessToken: string };
  /** 协议端的 WebUI 地址（登录扫码在那儿做） */
  webuiUrl?: string;
  /**
   * 三档事实（v36，第 1 步）：进程 / OneBot 配置 / WebUI 门。
   *
   * 为什么挂在同一个 status() 上而不是另开一个方法：界面每轮只问一次状态，
   * 而这三档与 `state` 是**同一件事的三个面**——分两次问就会出现"这两句对不上"的中间态。
   * 老字段（state / detail / pid / endpoint / webuiUrl）全部保留：适配器与别处的接线不受影响。
   */
  report: ManagedServiceReport;
}

export interface ManagedServiceOptions {
  /** 协议端安装目录（人指定的，框架不下载） */
  dir: string;
  /** 用哪个 node 跑它（默认当前进程的 execPath，保证与框架同版本） */
  nodePath?: string;
  /** 等端口就绪的上限（毫秒，默认 30s：NTQQ 起来慢） */
  readyTimeoutMs?: number;
  /** 日志出口（协议端的 stdout/stderr 逐行给这里） */
  onLog?: (line: string) => void;
  /** spawn 注入点（测试用；缺省走真实 spawn） */
  spawnFn?: typeof spawn;
  /**
   * 谁去看"那个进程在不在、在听哪个端口"（测试注入点）。
   *
   * 默认那条路分两段：先探它自己记的那个端口（一次本机 HTTP），拿不到再查监听端口表
   * （`netstat` + 进程表）。留成注入口有两个理由：单测里绝不能去查真机的端口表；
   * 而这条探测依赖宿主平台，换实现时不该动服务层的逻辑。
   */
  discover?: (dir: string) => WebuiListenerInfo | null;
  /**
   * 探活口：回答"那个地址上现在有没有人在听"（不给就走真 TCP 的 `canConnect`）。
   *
   * **这一问的正确语义是"那个端口后面是不是本服务自己的实例"**——判据写在这里，因为它决定
   * `waitReady` 会不会把兜底 probe 当端点交出去：
   *   · "那个端口后面确实是它" ⇒ 兜底 probe（空 token）也可以当端点；
   *   · "它自己的配置里写着那个端点"（通常还带 token）⇒ 当然可以；
   *   · **两者都谈不上 ⇒ 不许当端点**。
   *
   * 默认实现 `canConnect` 只是裸 TCP 连接（不握手、不认身份），在单机上够用，但**它不回答
   * 身份问题**：本机 3001 这种号段上谁都可能听着（2026-10-07 实测：真实协议端一登录，
   * 本机 3001 就有进程在听）。所以：
   *   · **单测必须注入**一个只认临时目录那份配置的实现（与 `discover` 同一条纪律：
   *     测试绝不去碰真机的端口）——不注入的话，用例会变成"看这台机器上装了什么"；
   *   · 想要更强判据的调用方，可以注入一个真去认身份的实现。
   *
   * 生产路径不给它，行为与以前一字不差。
   */
  probe?: (wsUrl: string) => Promise<boolean>;
  /**
   * 兜底探活地址（默认 `DEFAULT_FALLBACK_PROBE_URL`，即协议端默认的 3001）。
   *
   * 它只在"配置还没落盘、没有端点可探"时用；留成可注入是为了让单测能在自己控制的端口上
   * 复现"兜底端口上真的有人听"（见 `probe` 的判据）。
   */
  fallbackProbeUrl?: string;
  /**
   * `netstat -ano` 的输出来源（测试注入点）。
   *
   * 为什么单独留一个而不是让 `discover` 全包：默认那条探测里有一段**值得单独测**的解析
   * （`parseNetstatListenLine`）与一段挑选逻辑。单测直接喂一份 netstat 文本，就能把
   * "端口退让到 5100 时界面显示 5100" 这件事走真代码验一遍，而不是验一个假的 discover。
   */
  runNetstat?: () => string;
  /** 进程事实查询（测试注入点，默认走 PowerShell 的 CIM） */
  processFacts?: (pids: readonly number[]) => Map<number, { startedAt?: string; commandLine: string }>;
  /**
   * 框架自己的启动输出留痕（`agent-console.out.log` 那一类）里的凭据来源。
   *
   * 它回答的是"本次进程没起它、但**启动它的那次**是我们留了痕的，口令还能捞回来吗"。
   * 返回 null 就如实报"无法找回"——不猜、不去撞密码。
   */
  readConsoleCredential?: (dir: string) => WebuiCredential | null;
}

/** 端口表探测的结论（进程在不在、在听哪个端口、什么时候起的） */
export interface WebuiListenerInfo {
  /** 进程号；`0` = 这条路没查到 pid（只确认了"那个端口后面是它"） */
  pid: number;
  port: number;
  host: string;
  /** 进程启动时刻（ISO）；宿主上查不到就不给 */
  startedAt?: string;
  /** 这条结论是怎么来的（界面据此决定要不要说 pid） */
  via?: 'port-table' | 'http-probe';
}

/**
 * 发行包里可能出现的入口，按优先级探测。
 *
 * **`index.mjs` 排第一是实测来的**（v1.14.20 win-x64-lite 解压后的样子）：发行包根目录直接就是
 * `index.mjs`，没有 `dist/` 那一层——我最初按源码仓库的布局写成 `dist/index.mjs`，
 * 拿真包一试才发现找不到入口。`launcher.bat` 只是它的包装（查 node 版本 → `node ./index.mjs`），
 * 排在后面是因为它多一层 cmd 进程，而我们要收 stdout 与进程树。
 */
const ENTRY_CANDIDATES = ['index.mjs', 'dist/index.mjs', 'launcher.bat', 'launcher.sh'] as const;

/** 协议端的 OneBot 配置（相对于它的安装目录） */
const ONEBOT_CONFIG_PATH = 'config/onebot.json';
/** WebUI 的凭据/运行期文件（相对于它的安装目录）——两个门的事实都在这两份文件里 */
const WEBUI_CONFIG_PATH = 'config/webui.json';
const CONSENT_CONFIG_PATH = 'config/consent.json';
/** 运行期设置（它自己记的 `webuiPort` 在这里：那是"它想在哪个端口开面板"的期望值） */
const RUNTIME_CONFIG_PATH = 'config/runtime.json';

/**
 * 兜底探活的默认地址：协议端默认的 OneBot 正向 ws 端口（与适配器的默认值同值）。
 *
 * 它只在**它的配置还没落盘**时用——那一刻没有端点可探，探这个"它打算开的"默认端口，
 * 目的仅仅是尽早知道它往前走了。**这条兜底不是端点**：端点只认它自己配置里写着的那一份
 * （见 `waitReady`）。留成可注入（`ManagedServiceOptions.fallbackProbeUrl`）是为了让单测能在
 * 一个**自己控制的端口**上复现"兜底端口上真的有人听"，而不必依赖真机 3001 上有没有人。
 */
export const DEFAULT_FALLBACK_PROBE_URL = 'ws://127.0.0.1:3001';

/**
 * 从协议端自己的配置里读出对接点。
 *
 * 只认 `networks.wsServers[0]`——那是它的**正向 WebSocket 服务端**，也正是我们适配器连的方向
 * （`wsClients` 是反向，方向相反，不是我们要的）。读不出来就返回 null，绝不猜一个端口：
 * 猜错的后果是连到别的本地服务上，比连不上更难查。
 *
 * 这个函数是纯的（只读一个文件），所以能单独断言——"配置读得对不对"是这条链上最容易悄悄坏掉的一环。
 */
export function readEndpointFromConfig(dir: string): {
  wsUrl: string;
  accessToken: string;
} | null {
  // ① 全局配置：人在它的 WebUI 里存过的那份
  const global = parseEndpoint(tryRead(join(dir, ONEBOT_CONFIG_PATH)));
  if (global !== null) return global;
  // ② 按账号的快照 `config/onebot_<uin>.json`：**第一次起来时它自己物化的那份**。
  //
  // 为什么必须看这里：SnowLuma 的 `OneBotManager` 用 `persistDefaults: true` 加载配置，
  // 而 `loadOneBotConfig` 在没有全局文件时走 `saveOneBotConfig(uin, config, { mode: 'snapshot' })`
  // ——落的是**按账号的完整快照**，全局文件根本不会出现。只读全局那份的后果是：
  // 拿空 token 去连一个**随机生成了 access_token 并开着校验**的端口，表现是"端口通了却一直连不上"，
  // 而且日志里只会看到鉴权失败，看不出是读配置读错了地方。
  //
  // 多个账号时取**最近改动的**那个：同时挂两个 QQ 是可能的，而我们只对接一个——
  // 取最新的至少是"他最近在用的那个"，比按文件名排序更接近意图。
  const perUin = listConfigFiles(join(dir, 'config'))
    .filter((name) => name.startsWith(PER_UIN_PREFIX) && name.endsWith('.json'))
    .map((name) => ({ name, mtime: mtimeOf(join(dir, 'config', name)) }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const entry of perUin) {
    const found = parseEndpoint(tryRead(join(dir, 'config', entry.name)));
    if (found !== null) return found;
  }
  return null;
}

/** 文件修改时间；读不到就当 0（排最后，不影响别的候选） */
function mtimeOf(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** 按账号快照的文件名前缀（`onebot_<uin>.json`） */
const PER_UIN_PREFIX = 'onebot_';

/**
 * 「本次启动的初始凭据」那一行（第 2 步的解析对象）。
 *
 * 口径来自实测的原文（SnowLuma 的 `logger` 里 `logInitialWebuiCredentials`）：
 * ```
 * 01:26:39 INFO               [WebUI] initial credentials: user=admin password=d198b971dd2b7b03
 * ```
 * 它**只往 stdout 写**（`process.stdout.write`），不进它的文件日志——所以解析对象是
 * **框架捕获到的那份 stdout**，不是协议端的 `logs/snowluma-<date>.log`（那一份里有横幅、
 * 没有口令）。这个区别是这条链上最容易搞错的一步，单独立了一条用例锁住。
 *
 * 用户名写成"可选组"而不是钉死 `admin`：它是它那边的实现细节，我们只认这一行的形状；
 * 形状变了就返回 null（**宁可报"没解析到"，也不猜一个口令出来**）。
 */
const CREDENTIAL_LINE = /initial credentials:\s*user=(\S+)\s+password=(\S+)/u;

/** WebUI 真实监听端口的证据行：`listening http://127.0.0.1:5100`（含端口退让后的那个值） */
const LISTENING_LINE = /listening\s+(https?):\/\/([^\s/:]+):(\d+)/u;

/** 端口退让的警告行：`port 5099 is in use, using 5100 instead` */
const PORT_FALLBACK_LINE = /port\s+(\d+)\s+is in use, using\s+(\d+)\s+instead/u;

export interface ParsedCredentialLine {
  user: string;
  password: string;
}

/** 从一行输出里解析初始凭据；不是那一行就返回 null */
export function parseCredentialLine(line: string): ParsedCredentialLine | null {
  const match = CREDENTIAL_LINE.exec(line);
  if (match === null) return null;
  const user = (match[1] ?? '').trim();
  const password = (match[2] ?? '').trim();
  if (user === '' || password === '') return null;
  return { user, password };
}

/**
 * 口令的打码。
 *
 * **为什么不是全遮**：界面上要能让人核对"我手里这条和它刚生成的那条是不是同一条"，
 * 全遮之后两个不同的口令长得一模一样，人只能靠试。所以留头尾各两位——足够区分，
 * 不足以还原（SnowLuma 的初始口令是 `randomBytes(8).toString('hex')`，16 位十六进制，
 * 头尾四位之外的 12 位不可从这四个字符推出来）。
 *
 * 与 `maskAccessToken`（连值带键整段抹掉）的分寸不同是**有意的**：那个是长连接凭据，
 * 界面上从不需要核对它；这个是"人要在另一个窗口里手打进去"的一次性口令。
 */
export function maskCredential(secret: string): string {
  if (secret === '') return '';
  if (secret.length <= 4) return '****';
  return `${secret.slice(0, 2)}…${secret.slice(-2)}`;
}

/**
 * 把已知的口令从一行输出里抹掉（`***`）。
 *
 * 用在 `ManagedProtocolService` 的 stdout 中继上：那一行凭据本身之外，
 * 协议端还可能把口令打在别的地方（比如它自己的调试输出）。**留痕是好事，泄口令不是**——
 * 所以只抹值本身，句子照旧留着（人还是看得出"它打印过凭据"这件事）。
 */
export class SecretRedactor {
  private readonly secrets: string[] = [];

  /** 收一个明文口令（太短的忽略：两三个字符的"口令"替换起来只会误伤正常文本） */
  learn(secret: string): void {
    if (secret.length < 6 || this.secrets.includes(secret)) return;
    this.secrets.push(secret);
  }

  /** 抹掉这一行里所有已知口令 */
  apply(line: string): string {
    let out = line;
    for (const secret of this.secrets) out = out.split(secret).join('***');
    return out;
  }

  get learned(): readonly string[] {
    return this.secrets;
  }
}

/**
 * 从协议端目录下的文件读出「两个门」的状态（**只读盘，不联网**）。
 *
 * 为什么读盘就够：两个门的状态各自有一份落盘记录——
 *   · 同意门 → `config/consent.json`（过了才有这个文件，`recordConsent` 写的）；
 *   · 改密门 → `config/webui.json` 的 `mustChangePassword`（改过密码就变 false）。
 * 读盘不产生副作用，也不会因为"面板没开"而误报——**这正是它比探 HTTP 强的地方**。
 */
export function readConsentInfo(dir: string): ProtocolConsentInfo {
  const consentRecorded = existsSync(join(dir, CONSENT_CONFIG_PATH));
  let mustChangePassword = false;
  const raw = tryRead(join(dir, WEBUI_CONFIG_PATH));
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        mustChangePassword = (parsed as Record<string, unknown>)['mustChangePassword'] === true;
      }
    } catch {
      // webui.json 坏了：那是"读不出"，不是"没有改密门"——如实按 false 报（不敢说它开着），
      // 但下面的 onebotConfig 那条链上同样的情形**必须**报 unreadable，别把两件事混成一个
      mustChangePassword = false;
    }
  }
  return { consentRecorded, mustChangePassword };
}

/**
 * 第二档的完整结论：文件在不在、端点读出来是什么、盘上那份文件在哪。
 *
 * 与 `readEndpointFromConfig` 的关系：**先问它**（它管"端点是什么"，单测最多），
 * 再补"为什么是 null"——文件不在 / 在但读不出，这两句在界面上是两条完全不同的下一步。
 */
export function readOnebotConfigInfo(dir: string): ProtocolOnebotConfigInfo {
  const endpoint = readEndpointFromConfig(dir);
  const found = listConfigFiles(join(dir, 'config'))
    .filter((name) => (name === 'onebot.json' || (name.startsWith(PER_UIN_PREFIX) && name.endsWith('.json'))))
    .map((name) => ({ name, mtime: mtimeOf(join(dir, 'config', name)) }))
    .sort((a, b) => b.mtime - a.mtime);
  if (endpoint !== null) {
    // 端点读出来了：把**是哪一份**文件说清楚（全局那份优先于快照，与读取顺序同一口径）
    const globalName = found.find((entry) => entry.name === 'onebot.json');
    const name = globalName?.name ?? found[0]?.name ?? ONEBOT_CONFIG_PATH;
    return { present: true, endpoint, path: join(dir, 'config', name) };
  }
  if (found.length === 0) return { present: false };
  // 有文件却读不出端点：**不许**说成"没有配置"（人明明看得见那个文件）
  return { present: false, path: join(dir, 'config', found[0]!.name), unreadable: true };
}

function tryRead(p: string): string | null {
  try {
    return defaultRead(p);
  } catch {
    return null;
  }
}

/** 解析一份协议端配置里的第一个 wsServer；形状不对返回 null（**绝不猜一个端口**） */
function parseEndpoint(raw: string | null): { wsUrl: string; accessToken: string } | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const networks = (parsed as Record<string, unknown>)['networks'];
  if (typeof networks !== 'object' || networks === null) return null;
  const servers = (networks as Record<string, unknown>)['wsServers'];
  if (!Array.isArray(servers) || servers.length === 0) return null;
  const first = servers[0];
  if (typeof first !== 'object' || first === null) return null;
  const s = first as Record<string, unknown>;
  const host = typeof s['host'] === 'string' && s['host'] !== '' ? s['host'] : '127.0.0.1';
  const port = typeof s['port'] === 'number' ? s['port'] : Number(s['port']);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const rawPath = typeof s['path'] === 'string' ? s['path'] : '/';
  const path = rawPath === '' ? '/' : rawPath;
  return {
    wsUrl: `ws://${host}:${port}${path}`,
    accessToken: typeof s['accessToken'] === 'string' ? s['accessToken'] : '',
  };
}

/** 列 config 目录下的文件名；目录不在就返回空（第一次跑之前是常态） */
function listConfigFiles(configDir: string): string[] {
  try {
    return readdirSync(configDir);
  } catch {
    return [];
  }
}

function defaultRead(p: string): string {
  return readFileSync(p, 'utf8');
}

// ────────────────────────────── 进程与端口的探测（第一档的事实来源） ──────────────────────────────

/**
 * 一条 `netstat -ano` 记录的判定：**端口算得出来、PID 在行首**才是我们要的那一行。
 *
 * 输出形态（Windows，中文系统也一样，只有状态词可能本地化）：
 * ```
 *   TCP    127.0.0.1:5099         0.0.0.0:0              LISTENING       34552
 * ```
 * 两条分寸：
 *   · 只认 `LISTEN`（开头即可）：中文系统上它是 `LISTENING`、英文也是——不认别的词就够，
 *     而 `ESTABLISHED` 那类**不是**监听（把一条连出去的长连接当"它在听"是假的）；
 *   · 本地地址可能带方括号（IPv6），所以端口的判据是**最后一个冒号后面那段**。
 */
export function parseNetstatListenLine(line: string): { port: number; pid: number } | null {
  const trimmed = line.trim();
  if (!/^TCP\s/iu.test(trimmed)) return null;
  if (!/LISTEN/iu.test(trimmed)) return null;
  const tail = /(\d+)\s*$/u.exec(trimmed);
  if (tail === null) return null;
  const pid = Number(tail[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const local = /^TCP\s+(\S+)/iu.exec(trimmed);
  if (local === null) return null;
  const colon = local[1]!.lastIndexOf(':');
  if (colon < 0) return null;
  const port = Number(local[1]!.slice(colon + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { port, pid };
}

/** 跑一次 `netstat -ano` 并逐行判定；拿不到输出就返回空数组（探测失败不是"没有进程"） */
function listenEntries(run?: () => string): Array<{ port: number; pid: number }> {
  let text: string;
  try {
    // netstat 的正文是 ASCII，但**表头**在中文 Windows 上是 GBK（cp936）字节。这里只取
    // 命中行，可 `encoding:'utf8'` 会把表头换成替换字符——一条给人看的判据不该靠"恰好没用到"。
    text = run === undefined
      ? decodeText(execFileSync('netstat', ['-ano'], { timeout: 5_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).text
      : run();
  } catch {
    return [];
  }
  const out: Array<{ port: number; pid: number }> = [];
  for (const line of text.split(/\r?\n/u)) {
    const entry = parseNetstatListenLine(line);
    if (entry !== null) out.push(entry);
  }
  return out;
}

/**
 * 默认的进程探测：**从监听端口反查**。
 *
 * 为什么要反查而不是记着自己 spawn 的 pid：状态要如实回答的那个问题是"它现在在不在"，
 * 而"本次进程起过它"只是**其中一种**在的方式。实测那条现场就是另一种：进程在跑
 * （pid 34552，01:26:38 起，只听 5099），而本次框架进程从没起过它——旧状态于是报"已停止"，
 * 人看着一个活着的进程被说成没在跑。
 *
 * 判据两条**同时成立**才认：
 *   ① 有一条 LISTEN 记录的 PID 正是那个进程；
 *   ② 那个进程的命令行里出现本安装目录下的入口文件名（`index.mjs`）。
 * 只认端口表的话，本机上任何一个监听端口的程序都会被说成"协议端在跑"。
 *
 * 开销：一次 `netstat`（~50ms）+ 一次只查那几个候选 pid 的进程表（~1s，PowerShell 自身启动占大头）。
 * 调用点用 `DISCOVERY_CACHE_MS` 兜住频率——**这条路只在进程不是本次 spawn 的时候才走**。
 */
export function discoverWebuiListener(
  dir: string,
  injection: {
    /** `netstat -ano` 的输出（测试注入：绝不能去查真机的端口表） */
    netstat?: () => string;
    /** 进程事实查询（测试注入） */
    facts?: (pids: readonly number[]) => Map<number, { startedAt?: string; commandLine: string }>;
  } = {},
): WebuiListenerInfo | null {
  const entry = ENTRY_CANDIDATES.map((rel) => join(dir, rel)).find((p) => existsSync(p)) ?? null;
  if (entry === null) return null;
  const entryBase = entry.split(/[\\/]/u).pop() ?? entry;
  const myPid = process.pid;
  const candidates = listenEntries(injection.netstat).filter((listen) => listen.pid !== myPid);
  if (candidates.length === 0) return null;
  const facts = (injection.facts ?? processFactsOf)(candidates.map((c) => c.pid));
  for (const listen of candidates) {
    const found = facts.get(listen.pid);
    if (found === undefined) continue;
    if (!found.commandLine.includes(dir) && !found.commandLine.includes(entryBase)) continue;
    const out: WebuiListenerInfo = { pid: listen.pid, port: listen.port, host: '127.0.0.1', via: 'port-table' };
    if (found.startedAt !== undefined) out.startedAt = found.startedAt;
    return out;
  }
  return null;
}

/**
 * 默认的**快速**探测：先只看"它自己记的那个端口"上是不是它。
 *
 * 为什么值得多这一条路：进程表那条路要起一次 PowerShell（实测 ~1 秒），而这条只要一次
 * 本机 HTTP（~10ms）。绝大多数时候协议端就在它记的那个端口上跑着，于是状态查询不必
 * 每次都去查进程表。**代价是这条路拿不到 pid 与启动时刻**——那两样只有进程表知道，
 * 所以它返回的是"在跑，但接管方式不明"（界面照实显示，不编一个 pid）。
 */
export async function probeWebuiOnConfiguredPort(dir: string): Promise<WebuiListenerInfo | null> {
  const port = readConfiguredWebuiPort(dir);
  if (!await probeWebuiIdentity(port)) return null;
  return { pid: 0, port, host: '127.0.0.1', via: 'http-probe' };
}

/**
 * 协议端 WebUI 的地址：登录（扫码）在那儿做。
 *
 * 端口写死 5099 是有依据的——SnowLuma 的文档明说"打开 http://localhost:5099，使用启动日志中的
 * 初始密码登录 WebUI"。**但它会退让**：5099 被占时它顺手换成 5100+，并把
 * `port 5099 is in use, using 5100 instead` 写进自己的日志。所以这个常量只剩一个身份——
 * **退让之前那个期望值**；界面上真正该显示的是 `report.webui.url`（实测那个）。
 */
export const DEFAULT_WEBUI_URL = 'http://127.0.0.1:5099';

/** 期望的 WebUI 端口（与 `DEFAULT_WEBUI_URL` 同一个数，探测时当起点用） */
const DEFAULT_WEBUI_PORT = 5099;

/**
 * 探测缓存的时长（毫秒）。
 *
 * 为什么要有缓存：探测失败那条路要跑一次 `netstat` **加**一次 PowerShell（进程表查询在
 * 这台机器上实测 ~1 秒）——而 `report()` 是每次界面轮询都会问的，不缓存就等于让界面
 * 每次刷新都去查一遍进程表。
 *
 * 8 秒是折中：这三档会变（人登录 QQ 之后配置就出现了），但**不会以秒为单位变**；
 * 而进程的启停本来就是分钟级的动作。要立刻看到变化，重启进程或重新登录面板即可。
 */
const DISCOVERY_CACHE_MS = 8_000;

/** 读它自己记的期望端口（`config/runtime.json` 的 webuiPort）；读不到就用默认那个 */
export function readConfiguredWebuiPort(dir: string): number {
  const raw = tryRead(join(dir, RUNTIME_CONFIG_PATH));
  if (raw === null) return DEFAULT_WEBUI_PORT;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_WEBUI_PORT;
    const port = (parsed as Record<string, unknown>)['webuiPort'];
    const value = typeof port === 'number' ? port : Number(port);
    return Number.isInteger(value) && value > 0 && value <= 65535 ? value : DEFAULT_WEBUI_PORT;
  } catch {
    return DEFAULT_WEBUI_PORT;
  }
}

/**
 * 一次 HTTP 探活：确认那个端口后面真的是**它**（而不是本机上随便一个 Web 服务）。
 *
 * 判据是**它的前端产物里那句话**：`client/index.html` 里有 SnowLuma 的标题。
 * 只看"端口通了"是不够的——5099 这种号段上什么都可能有，而把它们说成"协议端在跑"
 * 会让人去一个不相干的页面上找登录框（比报"不知道"坏得多）。
 *
 * 拿不到明确特征时返回 false，调用方**回落到进程表那条路**（那条能给出 pid 与启动时刻，
 * 是更强的证据）；两条都拿不到才如实报"没探到"。
 */
async function probeWebuiIdentity(port: number, timeoutMs = 700): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
    if (!response.ok) return false;
    const text = await response.text();
    return /snowluma/iu.test(text);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 一个 pid 的启动时刻（ISO）与命令行。
 *
 * 走 PowerShell 的 CIM 而不是 `wmic`：`wmic` 在 Win11 24H2 之后已被移除，
 * 而 PowerShell 在支持的 Windows 上都在。**两条都失败就返回空**——
 * 探测不到启动时刻不是错误，编一个才是。
 */
function processFactsOf(pids: readonly number[]): Map<number, { startedAt?: string; commandLine: string }> {
  const out = new Map<number, { startedAt?: string; commandLine: string }>();
  const wanted = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0).slice(0, 64);
  if (wanted.length === 0) return out;
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  // 逐行 `pid<TAB>ISO 启动时刻<TAB>命令行`：比 JSON 小一个数量级，解析也不必容错到字节级
  const script = `Get-CimInstance Win32_Process -Filter "${wanted.map((p) => `ProcessId=${p}`).join(' or ')}"`
    + ' | ForEach-Object { "$($_.ProcessId)`t$($_.CreationDate.ToString(\'o\'))`t$($_.CommandLine)" }';
  let text: string;
  try {
    // **收原始字节**（2026-10-18）：这条命令读的是进程命令行——含中文路径/参数是常态，
    // 而 Windows PowerShell 往管道里写的是控制台代码页（中文机器 936）。`encoding:'utf8'`
    // 会把它换成 U+FFFD，而这段文本要拿去判"这个 pid 是不是协议端"。
    const bytes = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
    text = decodeText(bytes).text;
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    const [pidText, atText = '', ...rest] = line.split('\t');
    const pid = Number((pidText ?? '').trim());
    if (!Number.isInteger(pid)) continue;
    const entry: { startedAt?: string; commandLine: string } = { commandLine: rest.join('\t') };
    // CIM 的 CreationDate 带本机偏移（`2026-10-07T01:26:38.6270720+08:00`）；
    // `new Date` 认得出它，得到的 UTC 时刻是对的——**不用手工去补时区**
    const at = atText.trim() === '' ? null : new Date(atText.trim());
    if (at !== null && !Number.isNaN(at.getTime())) entry.startedAt = at.toISOString();
    out.set(pid, entry);
  }
  return out;
}

export class ManagedProtocolService {
  private readonly options: ManagedServiceOptions;
  private child: ChildProcess | null = null;
  private state: ManagedServiceState = 'stopped';
  private detail = '';
  private endpoint: { wsUrl: string; accessToken: string } | undefined;
  /** 我们主动 stop 时置位：用来区分"它自己死了"与"我叫它停的" */
  private stopping = false;
  /**
   * 本次 stdout 里捞到的初始凭据。
   *
   * **只活在内存里**：不进 detail（那句要进日志、进界面、进诊断输出）、不进事件日志。
   * 用到它的只有 `status().report.webui.credential` 那一条路。
   */
  private credential: { user: string; password: string } | null = null;
  /** stdout 里看到的真实监听地址（含端口退让后的那个值） */
  private listening: { url: string; port: number } | null = null;
  /**
   * 口令抹除器。
   *
   * **它必须在中继那一层生效**：留痕归留痕，口令落进启动输出就等于把它抄进文件——
   * 而这条路（`onLog` → 框架的控制台留痕）本来就是给排障用的，不是给抄密码用的。
   */
  private readonly redactor = new SecretRedactor();
  /**
   * 端口表探测的短缓存。
   *
   * 为什么必须有：那次探测要跑 `netstat` + 一次 PowerShell 的 CIM 查询，秒级开销；
   * 而 `report()` 是**每次界面轮询都会问**的（界面上那张卡刷新一次就问一次）。
   * 不缓存的话，一个"看状态"的界面会变成一台不停查进程表的机器。
   *
   * 2 秒是**刻意短**的：这三档的意义就在于"人登录 QQ 之后它自己会变"，
   * 缓存久了界面就会持续说旧的（那正是这一版要治的病）。
   */
  private discoveryCache: { at: number; value: WebuiListenerInfo | null } | null = null;
  /** 正在飞的那次探测（并发去重：状态查询与动作回执可能同时来） */
  private discoveryInflight: Promise<WebuiListenerInfo | null> | null = null;

  /**
   * 探测一次并在 `DISCOVERY_CACHE_MS` 内复用同一个结论。
   *
   * 两条路按顺序（**快的那条先**，因为 `report()` 是界面每次轮询都会问的）：
   *   ① 只看它自己记的那个端口上是不是它（一次本机 HTTP，~10ms）；
   *   ② ①不成立时查监听端口表 + 进程表（~1s，但能给出 pid 与启动时刻）。
   * 缓存把 ② 的代价摊到 8 秒一次；要立刻看到变化就重启进程（那本来也是这类改动的生效方式）。
   */
  private async discoverCached(): Promise<WebuiListenerInfo | null> {
    const fresh = this.discoveryCache;
    if (fresh !== null && Date.now() - fresh.at < DISCOVERY_CACHE_MS) return fresh.value;
    // 同一个时刻只允许一次探测在飞：界面可能同时开两个请求（状态 + 动作回执）
    const inflight = this.discoveryInflight;
    if (inflight !== null) return await inflight;
    const promise = this.discoverOnce();
    this.discoveryInflight = promise;
    try {
      const value = await promise;
      this.discoveryCache = { at: Date.now(), value };
      return value;
    } finally {
      this.discoveryInflight = null;
    }
  }

  /** 真去探一次（两条路按顺序试）；探测本身抛了按"没探到"报，不把异常升级成状态 */
  private async discoverOnce(): Promise<WebuiListenerInfo | null> {
    if (this.options.discover !== undefined) {
      try {
        return this.options.discover(this.options.dir);
      } catch {
        return null;
      }
    }
    try {
      const fast = await probeWebuiOnConfiguredPort(this.options.dir);
      if (fast !== null) return fast;
    } catch {
      // 快速探活失败不是结论，继续走下面那条
    }
    try {
      return discoverWebuiListener(this.options.dir, {
        ...(this.options.runNetstat === undefined ? {} : { netstat: this.options.runNetstat }),
        ...(this.options.processFacts === undefined ? {} : { facts: this.options.processFacts }),
      });
    } catch {
      return null;
    }
  }

  constructor(options: ManagedServiceOptions) {
    this.options = options;
  }

  /** 入口文件路径；找不到返回 null（= 还没装） */
  entryPath(): string | null {
    for (const rel of ENTRY_CANDIDATES) {
      const p = join(this.options.dir, rel);
      if (existsSync(p)) return p;
    }
    return null;
  }

  /**
   * 探活一次（"那个地址上有没有人在听"）。
   *
   * 默认那条就是真 TCP（`canConnect`）——**生产行为与以前一字不差**；这一层存在的理由是
   * 单测必须能隔离真机端口（判据见 `ManagedServiceOptions.probe`）。
   */
  private async probePort(wsUrl: string): Promise<boolean> {
    const probe = this.options.probe ?? canConnect;
    return await probe(wsUrl);
  }

  /**
   * 谁在跑、在听哪个端口（第一档）。
   *
   * 两个来源按优先级：
   *   ① **本次进程起的那个**：pid 我们自己知道，它的 stdout 里也有"listening"那一行；
   *   ② 反查：本次进程没起它（配置是启动之后才写的、或者它是人手工跑的），那就从监听端口反查。
   * 两条都拿不到就是"不在跑"。**不猜**——猜一个 pid 出来比报"不知道"坏得多。
   */
  private async processInfo(): Promise<ProtocolProcessInfo> {
    const child = this.child;
    if (child?.pid !== undefined) {
      const out: ProtocolProcessInfo = { running: true, pid: child.pid, managed: 'spawned' };
      if (this.listening !== null) out.webuiUrl = this.listening.url;
      return out;
    }
    const found = await this.discoverCached();
    if (found === null) return { running: false };
    const out: ProtocolProcessInfo = {
      running: true,
      // 快速探活那条路查不到 pid：**宁可不给**（`managed: 'unmanaged'` 就是这句话），
      // 也不把 0 当 pid 显示出去
      ...(found.pid > 0 ? { pid: found.pid } : {}),
      managed: found.via === 'http-probe' ? 'unmanaged' : 'discovered',
      webuiUrl: `http://${found.host}:${found.port}`,
    };
    if (found.startedAt !== undefined) out.startedAt = found.startedAt;
    return out;
  }

  /**
   * WebUI 的登录口（第 2 步）：谁能开、口令是什么、从哪来的。
   *
   * 口令的来路按可靠度排：
   *   ① 本次 spawn 的 stdout（`initial credentials:` 那一行）——**唯一的权威来源**；
   *   ② 框架自己的启动输出留痕（`agent-console.out.log` 那一类，由 `readConsoleCredential` 注入）：
   *      本次进程没起它，但上一次启动它的那次留了痕，口令还在里面；
   *   ③ 都没有 ⇒ `source: 'none'`，**如实说"找不回"**。
   *
   * 为什么第三条必须存在、且必须说出口：SnowLuma 每次启动都会重新生成初始口令
   * （`previous bootstrap password was never rotated; regenerated a new one`），
   * 而它**只往 stdout 打一次**。所以"进程在跑、口令却找不回来"是一个真实且常见的状态——
   * 不说清楚，人会以为界面坏了；说清楚了，下一步（重启一次让它重新打印）才看得见。
   */
  private webuiCredential(process: ProtocolProcessInfo): WebuiCredential {
    const mustChangePassword = readConsentInfo(this.options.dir).mustChangePassword;
    if (this.credential !== null) {
      return {
        mustChangePassword,
        user: this.credential.user,
        password: this.credential.password,
        source: 'stdout',
      };
    }
    // 只有"它真的在跑"时才去翻留痕：进程都不在，翻出来的口令一定是上一轮作废的那条
    if (process.running) {
      const read = this.options.readConsoleCredential ?? readConsoleCredentialDefault;
      let fromLog: WebuiCredential | null = null;
      try {
        fromLog = read(this.options.dir);
      } catch {
        fromLog = null;
      }
      if (fromLog !== null && fromLog.source === 'console-log') {
        return { ...fromLog, mustChangePassword };
      }
    }
    return { mustChangePassword, source: 'none' };
  }

  /**
   * 三档事实（v36）：进程 / OneBot 配置 / WebUI 门。
   *
   * 每问一次就重新探测一次（读两个小文件 + 一次端口表），**不缓存**：
   * 这三档正是"人登录 QQ 之后自己会变"的那些事实，缓存它们等于让界面持续说旧的。
   */
  async report(): Promise<ManagedServiceReport> {
    const process = await this.processInfo();
    const onebotConfig = readOnebotConfigInfo(this.options.dir);
    const credential = this.webuiCredential(process);
    const webuiUrl = process.webuiUrl ?? (this.listening === null ? undefined : this.listening.url);
    return {
      state: this.state,
      detail: this.detail,
      process,
      onebotConfig,
      webui: {
        ...readConsentInfo(this.options.dir),
        ...(webuiUrl === undefined ? {} : { url: webuiUrl }),
        open: process.running,
        credential,
      },
    };
  }

  async status(): Promise<ManagedServiceStatus> {
    const report = await this.report();
    const out: ManagedServiceStatus = { state: this.state, detail: this.detail, report };
    if (report.process.pid !== undefined) out.pid = report.process.pid;
    if (this.endpoint !== undefined) out.endpoint = this.endpoint;
    /**
     * WebUI 地址：**进程在跑就给**（v36 改的口径）。
     *
     * 旧写法是"只有 ready / starting 才给"——那条判据把"面板开着"和"OneBot 端口开着"
     * 混成了一件（而它们恰恰是这次要拆开的两件事）：实测那条现场进程活着、面板开着、
     * 只差 OneBot 配置，界面却因为 state=failed 而不给按钮，人连登录都做不到。
     */
    if (report.webui.url !== undefined) out.webuiUrl = report.webui.url;
    return out;
  }

  /**
   * 拉起协议端并等它就绪。
   *
   * **不等它登录**：登录要人扫码，可能几分钟也可能明天——`ready` 的含义只是"端口通了，
   * 适配器可以去连了"。连上之后 QQ 那边的登录态由协议端自己维护，框架不掺和。
   */
  async start(): Promise<ManagedServiceStatus> {
    if (this.child !== null) return await this.status();
    // **已经在跑就别再拉一个**：那会变成两个进程抢同一个 WebUI 端口（第二个退让到 5100），
    // 而适配器只连 3001——人看到的是"点了启动，然后什么都对不上了"
    const alive = await this.processInfo();
    if (alive.running) {
      this.state = 'starting';
      const where = alive.webuiUrl === undefined ? '' : `（面板在 ${alive.webuiUrl}）`;
      this.detail = `它已经在跑了（pid ${alive.pid ?? '未知'}${where}，本次进程没有拉起它）——`
        + '等它的 OneBot 端口开起来；没有端口说明它还没登录 QQ。';
      const endpoint = readEndpointFromConfig(this.options.dir);
      if (endpoint !== null && await this.probePort(endpoint.wsUrl)) {
        this.endpoint = endpoint;
        this.state = 'ready';
        this.detail = `已就绪，OneBot 在 ${endpoint.wsUrl}`;
      }
      return await this.status();
    }
    const entry = this.entryPath();
    if (entry === null) {
      this.state = 'not-installed';
      this.detail = `没找到可执行入口（找过 ${ENTRY_CANDIDATES.join(' / ')}）——请先下载协议端发行包并解压`;
      return await this.status();
    }

    this.state = 'starting';
    this.detail = '正在拉起协议端…';
    const spawnFn = this.options.spawnFn ?? spawn;
    const isScript = entry.endsWith('.mjs') || entry.endsWith('.js');
    const nodePath = this.options.nodePath ?? process.execPath;
    const args = isScript ? [entry] : [];
    const child = isScript
      ? spawnFn(nodePath, args, { cwd: this.options.dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      : spawnFn(entry, [], { cwd: this.options.dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    this.stopping = false;

    // 流式解 + **行缓冲**：逐块 `toString('utf8').split('\n')` 有两个病——
    // ① 跨块的多字节字符会被切成两半（变成替换字符）；
    // ② 被管道切开的半行会被当完整行送去抹口令 ⇒ **口令只有半截能匹配上，剩下的就漏出去了**。
    const stream = createUtf8Stream();
    let pendingLine = '';
    const relay = (chunk: Buffer): void => {
      pendingLine += stream.push(chunk);
      const parts = pendingLine.split(/\r?\n/u);
      pendingLine = parts.pop() ?? '';
      for (const line of parts) {
        if (line.trim() === '') continue;
        this.noteLine(line);
        // 先抹口令再往外送：留痕要留，口令不能跟着留（见 redactor 的注释）
        this.options.onLog?.(this.redactor.apply(line));
      }
    };
    child.stdout?.on('data', relay);
    child.stderr?.on('data', relay);
    child.on('exit', (code, signal) => {
      this.child = null;
      if (this.stopping) {
        this.state = 'stopped';
        this.detail = '已停止';
        return;
      }
      this.state = 'failed';
      this.detail = `协议端自己退出了（code=${code ?? 'null'} signal=${signal ?? 'null'}）——日志见服务日志`;
    });

    // 等端口就绪：**以它的配置文件为准**轮询，文件还没生成时按默认端口探
    const endpoint = await this.waitReady(child);
    /**
     * **端点必须有配置背书才算就绪**（v37 收紧；2026-10-07 那条"永远的 401"就是这个形状）。
     *
     * `waitReady` 里那条兜底探活只能证明"那个端口上有人听"，**证明不了"那是它"**——默认探活是
     * 裸 TCP，答不了身份问题，而真机上 3001 这种号段里谁都可能听着（实测：真实协议端一登录，
     * 本机 3001 立刻有人应）。所以端点的**唯一来源是它自己那份配置**：读不出 wsUrl/token 就
     * **绝不 ready**，哪怕端口是通的——否则交出去的正是那个**空 token 的兜底端点**。
     *
     * 为什么这一句落在这里而不是 `waitReady` 内部：判定就绪的 `this.state = 'ready'` 本来就在
     * 这一处，而 `waitReady` 的返回式与节奏一个字都不该动（那条兜底探活的用处是"尽早知道它
     * 往前走了"——留着它，这种情况**立刻**就报出真实原因，不必等满 readyTimeout）。
     *
     * 读不出时的去向是**下面那条如实的三档诊断**（"进程在跑 · OneBot 配置缺失"），
     * 不是一句笼统的失败。
     */
    const backed = endpoint === null ? null : readEndpointFromConfig(this.options.dir);
    if (backed === null) {
      /**
       * 等不到端点时那句 detail **必须说清是哪一档断的**（第 1 步的核心要求）。
       *
       * 旧那句是"它可能还没登录，或者启动失败了"——两个完全不同的原因被并成一句，
       * 而它们的下一步也完全不同（前者去登录、后者去看日志）。现在按**盘上的事实**分：
       * 配置在不在，就是这两条路的分岔点。
       *
       * 两种"没端点"要分开说（它们是两句不同的话）：
       *   · `endpoint === null` = 等满了也没有任何端口应声；
       *   · `endpoint !== null` = **端口上有人听，但它自己那份配置读不出端点** ⇒ 那不是它，
       *     或者那份文件还没写全——按三档如实说"配置缺失/读不出"，绝不说成"就绪"。
       */
      const why = await this.diagnoseNoPort();
      this.state = 'failed';
      this.detail = endpoint === null
        ? `等 ${Math.round((this.options.readyTimeoutMs ?? 30_000) / 1000)} 秒仍没等到 OneBot 端口——${why.what}。${why.next}`
        : `读不出它自己的端点（端口上有人听也不算就绪）——${why.what}。${why.next}`;
      return await this.status();
    }
    this.endpoint = backed;
    this.state = 'ready';
    this.detail = `已就绪，OneBot 在 ${backed.wsUrl}`;
    return await this.status();
  }

  /**
   * "为什么没有 OneBot 端口"——按盘上的三档事实给一句能指导下一步的话。
   *
   * 这段是这次改动的落点：**进程活着而配置缺失，必须显示成
   * "进程在跑 · OneBot 配置缺失（未登录）"**，而不是"启动失败"。
   *
   * 返回值分成**事实**（`what`）与**下一步**（`next`）两段而不是一整句：
   * 这样"分岔点判对了没有"可以被单测直接断言，而不必去匹配一句中文里的关键词
   * （匹配字符串的用例会在有人改一个字的时候假红，而那正是最容易被顺手改坏的地方）。
   */
  private async diagnoseNoPort(): Promise<{ what: string; next: string }> {
    const process = await this.processInfo();
    const config = readOnebotConfigInfo(this.options.dir);
    const processText = process.running
      ? `协议端进程在跑（pid ${process.pid ?? '未知'}，面板在 ${process.webuiUrl ?? '端口未知'}）`
      : '协议端进程没在跑';
    if (config.present && config.endpoint !== undefined) {
      return {
        what: `${processText}，它的配置里写着 ${config.endpoint.wsUrl}，但那个端口连不上`,
        next: '多半是它启动到一半就停了，去看服务日志。',
      };
    }
    if (config.unreadable) {
      return {
        what: `${processText}，${config.path ?? '它的 OneBot 配置'} 在盘上但读不出端点`
          + '（JSON 坏了，或者 wsServers 是空的）',
        next: '这条要人去修那份文件，框架不猜端口。',
      };
    }
    return {
      what: `${processText}，而 OneBot 配置缺失（${ONEBOT_CONFIG_PATH} 还没有）`
        + '——这一份是它**登录 QQ 之后**才物化的，所以这一档的意思就是"它从没登录过 QQ"',
      next: `去它的 WebUI 里接入 QQ（面板地址见这一档的 process.webuiUrl），`
        + '配置与 3001 端口才会出现，适配器随后自己连上。',
    };
  }

  /**
   * 记下 stdout 里的**证据行**（凭据 / 真实监听地址 / 端口退让）。
   *
   * 三行都是"只有它自己知道"的事实，且都只往 stdout 打——所以在这里收，而不是事后去翻文件。
   */
  private noteLine(line: string): void {
    const credential = parseCredentialLine(line);
    if (credential !== null) {
      this.credential = credential;
      this.redactor.learn(credential.password);
    }
    const listening = LISTENING_LINE.exec(line);
    if (listening !== null) {
      const port = Number(listening[3]);
      if (Number.isInteger(port) && port > 0) {
        // 主机名照它自己说的记（默认 127.0.0.1）：不替它改写成 localhost——
        // 那是两个不同的解析结果，而"点开打不开"最常见的原因就是这种想当然的等价
        this.listening = { url: `${listening[1]}://${listening[2]}:${port}`, port };
      }
    }
    const fallback = PORT_FALLBACK_LINE.exec(line);
    if (fallback !== null) {
      // 退让行本身不含主机与协议，只能补一句"它换到了哪个端口"；URL 等 listening 那行给
      this.detail = `它的 WebUI 端口 ${fallback[1]} 被占用，自动退让到 ${fallback[2]}`;
    }
  }

  /** 停掉协议端（连同它的子进程——NTQQ 那层不杀干净会留孤儿） */
  async stop(): Promise<void> {
    const child = this.child;
    if (child === null) {
      this.state = 'stopped';
      this.detail = '已停止';
      return;
    }
    this.stopping = true;
    killProcessTree(child, { forceTree: true });
    this.child = null;
    this.state = 'stopped';
    this.detail = '已停止';
  }

  /**
   * 轮询等端口开起来。两种来源按优先级：
   *   ① 它的配置文件里写了哪个端口就探哪个（准）
   *   ② 文件还没生成时探默认的 3001（SnowLuma 默认值，也是我们适配器的默认值）
   * 探到之后**再读一次配置**取 token——端口通了文件必然已经写过。
   *
   * **端点只认它自己配置里写着的那一份**（判据见 `ManagedServiceOptions.probe`）：
   * 探活回答的是"有没有人在听"，而 `canConnect` 那条默认实现只是裸 TCP——**"有人在听"不等于
   * "那是它"**。本机 3001 这种号段上谁都可能听着（2026-10-07 实测现场：真实协议端一登录，
   * 本机 3001 立刻有人应），所以：
   *   · 兜底 probe 之所以能被交出去，靠的是**探活口认得出"那是本服务自己的实例"**——
   *     默认实现认不出，单测因此必须注入（不注入就会把真机 3001 读成"它起来了"）；
   *   · 那一拍里**重读出来的配置**永远是第一顺位（它带着 token），兜底 probe 只在重读也
   *     读不出来时才落到最后。
   * 这条兜底在生产有价值（尽早知道它往前走了），所以不删；要收紧成"没有配置就不算端点"是
   * 另一件事，得单独定。
   */
  private async waitReady(child: ChildProcess): Promise<{ wsUrl: string; accessToken: string } | null> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 30_000);
    const fallback = this.options.fallbackProbeUrl ?? DEFAULT_FALLBACK_PROBE_URL;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || this.child === null) return null;
      const fromConfig = readEndpointFromConfig(this.options.dir);
      const probe = fromConfig ?? { wsUrl: fallback, accessToken: '' };
      if (await this.probePort(probe.wsUrl)) {
        // 端口通了：配置文件必然已落盘，重读一次拿准确值（含 token）
        return readEndpointFromConfig(this.options.dir) ?? probe;
      }
      await sleep(500);
    }
    return null;
  }
}

/**
 * 从**框架自己的启动输出留痕**里捞回初始凭据（第二可靠的来源）。
 *
 * 为什么需要它：本次进程没起协议端（配置是启动之后才写下的、或者它是人手工跑的）时，
 * 那个口令只出现在**启动它的那一次**的 stdout 里。实测的现场正是这样：
 * `<安装根>\agent-console.out.log` 里留着
 * ```
 * [协议端] 01:26:39 INFO               [WebUI] initial credentials: user=admin password=d198b971dd2b7b03
 * ```
 * 而协议端自己的 `logs/snowluma-<date>.log` 里**只有横幅、没有口令**（那句走的是
 * `process.stdout.write`，绕开了它的文件传输层）。所以这条路找不到时**不许**去猜。
 *
 * 取**最后一条**匹配：SnowLuma 每次启动都重新生成口令（"previous bootstrap password was
 * never rotated"），留痕里因此可能有好几条，只有最后那条还有效。**这仍不是权威**——
 * 进程若在留痕之后又重启过一次，最后那条也是作废的；所以只在"它确实在跑"时才用它
 * （调用点保着这条），并且界面上如实标出来源。
 */
export function readCredentialFromLogFile(path: string): WebuiCredential | null {
  const raw = tryRead(path);
  if (raw === null) return null;
  let found: ParsedCredentialLine | null = null;
  for (const line of raw.split(/\r?\n/u)) {
    const parsed = parseCredentialLine(line);
    if (parsed !== null) found = parsed;
  }
  if (found === null) return null;
  return { mustChangePassword: false, user: found.user, password: found.password, source: 'console-log' };
}

/**
 * 候选留痕路径：**只认部署形态那一份**（`<安装根>/agent-console.out.log`）。
 *
 * 为什么不把仓库工作目录下的同名文件也列进来：那是**开发期**的留痕，装的是另一个实例的
 * 口令——拿它去填现场那个面板，登录会失败，而失败原因（"口令不对"）看起来跟"这功能坏了"
 * 一模一样。这条链上"猜一个来源"比"报没找到"坏得多，所以候选表是**穷举出来的、写死的**，
 * 不做目录爬取。要加新形态就往这里加一行，`readCredentialFromLogFile` 已经能读任意路径。
 */
export function defaultCredentialLogPaths(dir: string): string[] {
  const out: string[] = [];
  // 安装根由**数据目录**推导，候选表就是这几种布局（穷举、写死，不做目录爬取）：
  //   ① 开发仓库形态：`<安装根>/dev/data` ⇒ 安装根是 data 的上两级
  //   ② 装出来的形态：`<安装根>/agent/data` ⇒ 安装根是 data 的上三级
  // ⚠️ 从前这里还列着某个具体安装根的两行绝对路径（两种大小写）——那等于把"某台机器装在哪"
  //    写进了产品代码；2026-10-23 换成上面这两条推导，本机行为逐字不变。
  out.push(resolve(dir, '..', '..', 'agent-console.out.log'));
  out.push(resolve(dir, '..', '..', '..', 'agent-console.out.log'));
  return out;
}

/** 默认的留痕读取：逐个候选试，第一个能解析出凭据的就用它 */
export function readConsoleCredentialDefault(dir: string): WebuiCredential | null {
  for (const candidate of defaultCredentialLogPaths(dir)) {
    const found = readCredentialFromLogFile(candidate);
    if (found !== null) return found;
  }
  return null;
}

/** 把 ws URL 解析成 host/port 并做一次 TCP 连接测试（不握手——协议端开了端口就够） */
export async function canConnect(wsUrl: string, timeoutMs = 800): Promise<boolean> {
  let host = '127.0.0.1';
  let port = 3001;
  try {
    const u = new URL(wsUrl);
    if (u.hostname !== '') host = u.hostname;
    if (u.port !== '') port = Number(u.port);
  } catch {
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

/** 把相对路径按安装目录解成绝对路径；已经是绝对的就不动它 */
export function resolveServiceDir(dir: string, baseDir: string): string {
  return isAbsolute(dir) ? dir : resolve(baseDir, dir);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => { setTimeout(r, ms); });
}
