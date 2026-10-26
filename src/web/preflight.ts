/**
 * 启动期的**早绑端口**那一层（`preflight`）：先 listen，再干重活。
 *
 * ## 为什么要有它（2026-10-26 的事故）
 *
 * 事故现场（`data/restart-worker.log`）：
 * ```
 * [结束] ok=False backendPid=24616 port=timeout … reason=port-not-ready ·
 *        新的 pid=24616 已经写进 lock.json，但端口 127.0.0.1:7788 在 32000 毫秒里没有应答
 * ```
 * 而当天实测"冷启动到开始监听"三次是 **35 / 42 / 35 秒**：`main.ts` 把
 * 「23.5 万条事件首折 + MCP + SnowLuma 预热」这些重活干完才 `listen` ⇒ 端口在这半分钟里
 * **根本没人听**。拉起器等 32 秒必然超时、判这次重启失败，界面则连不上任何端口
 * （那一次它还被父进程的 `IRMIA_WEB_PORT=1580` 带到了错误的端口上，见 gui 那一半）。
 *
 * 所以顺序必须反过来：**端口尽早 bind**，重活在后面继续干；这中间 HTTP 层要能明确回答
 * "我还没就绪"，而不是让客户端对着一个不存在的监听超时。
 *
 * ## 分工（这一层只做这三件事）
 *
 *   · `GET /api/health`（**不需要凭据**）⇒ 200 + `{status, uptimeMs, port, pid, phase}`；
 *   · `GET /api/auth/state` ⇒ 200 + `{initialized}`（与就绪后那一条**同一个事实源**：
 *     注入的就是真实的 `AuthStore`，见 `web/auth.ts`——认证门在启动期也能自己判该画哪一扇）；
 *   · 其余一切 ⇒ **503** + `{starting:true, phase, error:{code:'starting', message}}`
 *     ——"还没好"要说出口，不能让调用方挂在那儿等（挂住不答正是这次事故的观感）。
 *
 * `POST /api/auth/*`（设密码 / 登录 / 登出 / 改密码）在就绪前也落在上面那条 503 上：
 * 它们要往事件日志里落 `auth/password-set` 这类**事实**，而日志在重活干完之前还不存在
 * ——先答话、事后补账会丢事实。就绪之后认证那一段与改前**逐字相同**（`server.ts` 里
 * 一个字都没动），所以"认证门"本身没有被这一层碰过。
 *
 * ## 就绪之后
 *
 * `handoff()` 把**同一个 socket** 上的请求交给真处理器（`WebServer` 的 `route`），
 * 不重新 bind、不换端口、不留空窗。此后这一层只做一次 `if`：`handler === null` 吗？
 * ——不会给就绪后的请求引入任何新的中间件语义。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** 启动阶段（`phase` 只在 `status === 'starting'` 时有意义） */
export type StartupPhase = 'events' | 'mcp' | 'channels' | 'ready';

/** `GET /api/health` 的响应体（就绪前后**同一种形状**，只换 `status`/`phase`） */
export interface HealthReading {
  status: 'starting' | 'ready';
  /** 进程已运行的毫秒数（从进程启动算，不是从这个服务算） */
  uptimeMs: number;
  /** 后端实际在听的端口（`port=0` 时这里报系统分配的那个） */
  port: number;
  pid: number;
  phase: StartupPhase;
}

/**
 * 启动状态的**唯一一份**（preflight 与真服务共用同一个实例）。
 *
 * 为什么不各持一份：`/api/health` 在两边都要回答，而"现在到哪一步了"只有一个真相。
 * 两份的后果是"handoff 之后 health 还说自己 starting"这种自相矛盾的读数。
 */
export class StartupState {
  /** 进程启动时刻（uptime 的零点）：默认由 `process.uptime()` 反推，不依赖调用时机 */
  private readonly startedAtMs: number;
  private readonly pidValue: number;
  private readonly now: () => number;
  private readonly portOf: () => number;
  private current: StartupPhase;

  constructor(options: {
    /** 端口读数（bind 之后才是真值；preflight 与真服务都指向**同一个** server） */
    port: () => number;
    phase?: StartupPhase;
    now?: () => number;
    startedAt?: number;
    pid?: number;
  }) {
    this.portOf = options.port;
    // 起点是 `events`：端口 bind 住的那一刻，进程正要开始折事件（重活的第一段）。
    // `ready` 不是"默认值"，它只能由 `markReady()` 写进来——那一下同时意味着真服务已接管。
    this.current = options.phase ?? 'events';
    this.now = options.now ?? (() => Date.now());
    this.pidValue = options.pid ?? process.pid;
    this.startedAtMs = options.startedAt
      ?? this.now() - Math.round(process.uptime() * 1000);
  }

  /** 已经就绪了吗（`phase === 'ready'` 的同一条判据，读的是同一个字段） */
  ready(): boolean {
    return this.current === 'ready';
  }

  phase(): StartupPhase {
    return this.current;
  }

  /**
   * 播报阶段。**只许往前走**：一个晚到的 `setPhase('events')`（比如某段耗时逻辑的收尾）
   * 不许把已经进到 `mcp` 的读数打回去——那会让 health 的读数忽前忽后，看的人以为是两件事。
   *
   * 顺序与 `main.ts` 的真实装配顺序同一份：折事件 → 通道/协议端（SnowLuma 预热在这一档）
   * → MCP 池与工具注册表 → 就绪。拉锯的地方只有一处：这条次序只在这里写一次。
   */
  setPhase(phase: StartupPhase): void {
    const order: readonly StartupPhase[] = ['events', 'channels', 'mcp', 'ready'];
    if (order.indexOf(phase) < order.indexOf(this.current)) return;
    this.current = phase;
  }

  /** 就绪：此后 `health` 报 ready，且真服务接管所有请求 */
  markReady(): void {
    this.current = 'ready';
  }

  /** 当前这一份读数（`/api/health` 的响应体就是它） */
  reading(): HealthReading {
    const uptimeMs = Math.max(0, Math.round(this.now() - this.startedAtMs));
    return {
      status: this.ready() ? 'ready' : 'starting',
      uptimeMs,
      port: this.portOf(),
      pid: this.pidValue,
      phase: this.current,
    };
  }

  /** 已经就绪的一份（给"不经过启动期"的装配点用：测试、CLI、直接构造的 WebServer） */
  static readyNow(port: () => number): StartupState {
    return new StartupState({ port, phase: 'ready' });
  }
}

/**
 * 认证事实的**最小接口**（结构子集，不 import AuthStore）。
 *
 * 只要一个只读布尔：`/api/auth/state` 回答的就是它，认证门的判据仍然只有 `AuthStore` 一处
 * （`initialized` 是 getter，所以传进来的对象在启动期也读得到当时那一刻的事实）。
 */
export interface PreflightAuthFact {
  readonly initialized: boolean;
}

/** 就绪后接管请求的处理器（`WebServer` 的 route 包一层就是它） */
export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * 已经 bind 好、还没接上真处理器的那个 socket（留给 `WebServer` 接管）。
 *
 * 为什么不是"关掉 preflight 再让真服务 listen"：那中间有一个真实的空窗——旧连接被 RST、
 * 新连接 ECONNREFUSED，而"重启那一刻界面先起来、后端在载入"正是这次要修的那种观感。
 * 同一个 socket 换处理器没有这个窗口，也不会有第二个进程能在这中间抢到端口。
 */
export interface ServerBootstrap {
  readonly server: Server;
  /** 已经 bind 的端口（`port=0` 时为系统分配的那个） */
  readonly port: number;
  /** 从这一行起，请求走真处理器 */
  handoff(handler: RequestHandler): void;
}

export interface PreflightOptions {
  host?: string;
  /** 想听的端口；0 = 系统挑（测试用） */
  port: number;
  state: StartupState;
  /** `/api/auth/state` 的事实源（生产装配里就是 `main.ts` 早建的那份 `AuthStore`） */
  auth: PreflightAuthFact;
  /** 诊断输出；缺省 console.log */
  out?: ((line: string) => void) | undefined;
}

export interface PreflightServer extends ServerBootstrap {
  state: StartupState;
  portOf(): number;
  /** 已经交给真处理器了吗（`close()` 的判据） */
  handedOff(): boolean;
  /** 没收尾就退出时用：关掉 socket。已经 handoff 之后调用是**空操作**（socket 归真服务了） */
  close(): Promise<void>;
}

/** 写一份 JSON 响应（这个模块不 import server.ts：依赖方向只有 server → preflight） */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** 未就绪时那一条答复的**统一形状**（`starting` + `phase` 是契约，`error` 是给人读的那句） */
function startingBody(state: StartupState, message: string): Record<string, unknown> {
  return {
    starting: true,
    phase: state.phase(),
    error: { code: 'starting', message },
  };
}

/**
 * 启动期那套答复（handoff 之前**唯一**的请求处理）。
 *
 * 三个分支的先后是有讲究的：`health` 与 `auth/state` 先放行（它们是"能不能起来/该画哪扇门"
 * 的读数，本身不依赖任何重活），其余一律 503——包括 `/webhook/*` 与认证的写端点。
 */
function answerBeforeReady(
  req: IncomingMessage,
  res: ServerResponse,
  state: StartupState,
  auth: PreflightAuthFact,
): void {
  let path = '/';
  try {
    path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    // URL 解析不了就当作"非健康检查"：503 那句比 400 更能说明此刻的真实状态
  }
  if (path === '/api/health') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: { code: 'method-not-allowed', message: '就绪状态只接受 GET /api/health' } });
      return;
    }
    sendJson(res, 200, state.reading());
    return;
  }
  if (path === '/api/auth/state') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: { code: 'method-not-allowed', message: '认证状态只接受 GET /api/auth/state' } });
      return;
    }
    sendJson(res, 200, { initialized: auth.initialized });
    return;
  }
  sendJson(res, 503, startingBody(
    state,
    `后端还在启动（阶段 ${state.phase()}）：端口已经 bind，重活还没干完。`
    + '等 /api/health 变成 {"status":"ready"} 再来——这条答复不是最终状态。',
  ));
}

/**
 * bind 端口并立刻可答话。**端口 bind 成功的那一刻就是它返回的时刻**（重活一行都还没干）。
 *
 * 失败（`EADDRINUSE` 等）**照原样抛**：调用方决定"不拦启动"，但这一层不许把"没听成"
 * 说成"听成了"。
 */
export async function startPreflightServer(options: PreflightOptions): Promise<PreflightServer> {
  const write = options.out ?? ((line: string) => {
    console.log(line);
  });
  const host = options.host ?? '127.0.0.1';
  const state = options.state;
  /** 真处理器：`null` = 还在启动期（所有请求都走 `answerBeforeReady`） */
  let handler: RequestHandler | null = null;

  const server = createServer((req, res) => {
    const target = handler;
    if (target === null) {
      try {
        answerBeforeReady(req, res, state, options.auth);
      } catch {
        // 答复本身出错就别再抛了：启动期的每一行输出都已经在日志里，这里只保证不崩
        if (!res.headersSent) sendJson(res, 503, startingBody(state, '后端还在启动'));
        else res.end();
      }
      return;
    }
    target(req, res);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: unknown): void => {
      rejectListen(err instanceof Error ? err : new Error(String(err)));
    };
    server.once('error', onError);
    server.listen(options.port, host, () => {
      server.off('error', onError);
      resolveListen();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : 0;
  write(`[界面] 端口已先 bind：http://${host}:${boundPort}（重活在后面继续；就绪前 /api/health 报 starting）`);

  let closed = false;
  return {
    server,
    port: boundPort,
    state,
    portOf: () => {
      const current = server.address();
      return typeof current === 'object' && current !== null ? current.port : boundPort;
    },
    handoff: (next: RequestHandler) => {
      handler = next;
    },
    handedOff: () => handler !== null,
    close: async () => {
      // 已经交给真服务了 ⇒ socket 归它（它自己会 close）：这里再关一次就是把服务拆了
      if (handler !== null || closed) return;
      closed = true;
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections?.();
      });
    },
  };
}
