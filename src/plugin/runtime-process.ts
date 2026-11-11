/**
 * 插件**进程运行层**：起 / 停 / 重启、请求-响应关联、每类调用超时、崩溃处置。
 *
 * 为什么插件必须住子进程：JS 拦不住死循环，一个坏插件在主进程里就能把整台机器卡死；
 * 而且"越权"与"带崩"是两件事，主进程 import 的方案两件都挡不住。P1a 的边界就是
 * **stdio 协议 + 子进程**：进程内的一切都由这里收尸。
 *
 * 三条时间线（`DEFAULT_PLUGIN_TIMEOUTS`）：
 *   · 工具 10s / 钩子 2s / 定时回调 30s / 激活 15s；
 *   · 超时**不 throw 到事件循环**，而是按类别变成一条 `PluginRpcError`，由调用方决定
 *     "计数 / 杀进程 / 撤贡献"；
 *   · 工具超时是唯一会**杀进程**的一类（工具是同步 handler 的主战场，卡住基本等于挂死）。
 *
 * 崩溃策略（与设计稿一致）：
 *   · 进程非请求退出 → `plugin/crashed` → 冷却 30s 重启**一次**；
 *   · 再崩 → `plugin/failed` + 交回宿主自动停用（`onFatal`）；
 *   · 超时被我们杀掉**不消耗**崩溃预算（否则"三次超时隔离一条贡献"会变成"两次超时停整包"，
 *     与"不整包停"的裁决相反）——它按自己的冷却重启。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

import { killProcessTree } from '../process/kill-tree.ts';
import { utf8ConsoleEnv } from '../util/bytes-text.ts';
import {
  PLUGIN_HOST_METHODS, PLUGIN_NOTIFICATIONS, PLUGIN_PROTOCOL_VERSION, PLUGIN_RPC_ERRORS, PluginRpcError,
  RpcLineDecoder, encodeRpcError, encodeRpcNotification, encodeRpcRequest, encodeRpcResult,
  type RpcMessage,
} from './protocol.ts';
import { nodeRunnerPath, pythonRunnerPath, pluginRunnerRoot, resolveNodeExecutable, resolvePythonExecutable, probePython } from './runner-paths.ts';

export interface PluginTimeouts {
  toolMs: number;
  hookMs: number;
  timerMs: number;
  activationMs: number;
  controlMs: number;
}

export const DEFAULT_PLUGIN_TIMEOUTS: PluginTimeouts = Object.freeze({
  toolMs: 10_000,
  hookMs: 2_000,
  timerMs: 30_000,
  activationMs: 15_000,
  controlMs: 5_000,
});

/** 崩溃后的冷却（30s，设计稿写死的那个数） */
export const PLUGIN_CRASH_COOLDOWN_MS = 30_000;

/** 退出时先给插件多久做收尾（超时即杀进程树） */
const PLUGIN_STOP_GRACE_MS = 500;
const PLUGIN_KILL_GRACE_MS = 2_000;

/** Keep the host's credentials out of plugins, including Node's unrestricted process.env. */
export function pluginProcessEnv(inherited: NodeJS.ProcessEnv, explicit: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(inherited)) if (allowed.has(name.toUpperCase())) env[name] = value;
  // Explicit host injection is used by embeddings/tests, never read from a plugin manifest.
  return utf8ConsoleEnv({ ...env, ...explicit });
}

export const PLUGIN_STDERR_LIMITS = Object.freeze({ windowMs: 1_000, bytesPerWindow: 64 * 1024, linesPerWindow: 128, lineChars: 4_096 });

export type PluginProcessState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed';

export interface PluginExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** 是我们让它退的（disable/uninstall/shutdown/timeout），还是它自己没的 */
  requested: boolean;
  /** 请求退出的原因；`requested:false` 时是 `exit` / `spawn-error` */
  reason: string;
  error?: string;
}

export interface PluginProcessTarget {
  id: string;
  contentHash: string;
  version: string;
  apiVersion: number;
  rootDir: string;
  /** 插件数据目录（不是包目录）：ctx.files 与 `--allow-fs-write` 都指它 */
  dataDir: string;
  runtime: { type: 'node' | 'python'; entry: string };
  permissions: readonly string[];
  /** 清单里的网络白名单（P1b；`ctx.net.fetch` 的唯一放行依据） */
  netAllow: readonly string[];
  config: Record<string, unknown>;
}

export interface PluginProcessHandlers {
  /** 插件发来的请求（tool.register / state.set / chat.send …），由 host-services 实现 */
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  /** stderr 的每一行（宿主日志要带插件前缀） */
  onStderr: (line: string) => void;
  /** 协议层的坏帧；不杀进程，但必须留痕 */
  onProtocolProblem: (message: string, line: string) => void;
}

export interface PluginProcessOptions {
  target: PluginProcessTarget;
  handlers: PluginProcessHandlers;
  timeouts?: Partial<PluginTimeouts>;
  log: (line: string) => void;
  onExit: (info: PluginExitInfo) => void;
  nodePath?: string;
  pythonPath?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * 一条宿主 ↔ 插件进程的会话。
 *
 * 并发口径：**宿主→插件的请求被串行化**（`chain`）。理由不是简化，而是正确性——
 * Python 运行器的 RPC 是"写一帧、同步读一帧"，两条并发请求会让它读错响应；串行化让
 * 两种语言的运行器行为一致，代价是同一插件的多个工具调用排队（P1a 的插件都是轻量的）。
 * 插件→宿主的请求**不排队**：运行器可以在处理一个工具时反过来调 `ctx.state`。
 */
export class PluginProcess {
  readonly target: PluginProcessTarget;
  private readonly options: PluginProcessOptions;
  private readonly timeouts: PluginTimeouts;
  private readonly decoder = new RpcLineDecoder();
  private readonly pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; method: string }>();
  private readonly exitPromise: Promise<PluginExitInfo>;
  private resolveExit!: (info: PluginExitInfo) => void;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private chain: Promise<unknown> = Promise.resolve();
  private ready: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private state: PluginProcessState = 'idle';
  private startedAt = 0;
  private requestedReason: string | null = null;
  private exited = false;
  private stderrRest = '';
  private spawnError: string | null = null;
  private processGroup: number | null = null;
  private stderrWindowStarted = 0;
  private stderrWindowBytes = 0;
  private stderrWindowLines = 0;
  private stderrDroppedBytes = 0;

  constructor(options: PluginProcessOptions) {
    this.options = options;
    this.target = options.target;
    this.timeouts = { ...DEFAULT_PLUGIN_TIMEOUTS, ...options.timeouts };
    this.exitPromise = new Promise<PluginExitInfo>((resolve) => { this.resolveExit = resolve; });
  }

  get status(): { state: PluginProcessState; pid: number | null; startedAt: number; uptimeMs: number } {
    // pid 跟着**真进程**走：停机中（stopping）进程还活着，pid 就必须报得出来——
    // 否则界面/测试会在"我们刚开始停"那一刻就以为进程已经没了，而事件还没落。
    const pid = this.child?.pid ?? null;
    return {
      state: this.state,
      pid,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
    };
  }

  /** 起进程 → 等 ready → 发 activate。任一步失败都会杀掉进程并 throw。 */
  async start(): Promise<void> {
    if (this.child !== null) throw new Error('插件进程已经起过；重启用 stop() + 新的实例');
    const { runtime } = this.target;
    if (runtime.type === 'python') {
      const probe = probePython(this.options.pythonPath ?? resolvePythonExecutable());
      if (!probe.available) {
        throw new PluginRpcError(PLUGIN_RPC_ERRORS.internalError,
          `Python 运行时不可用（${probe.binary}：${probe.detail}）。Python 插件需要宿主机上装 Python 3.9+，或设 IRMIA_PYTHON 指到解释器`, 'crash');
      }
    }
    this.state = 'starting';
    const command = this.buildCommand();
    const child = spawn(command.file, command.args, {
      cwd: this.target.rootDir,
      windowsHide: true,
      detached: runtime.type === 'python' && process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...pluginProcessEnv(process.env, this.options.env),
        IRMIA_PLUGIN_ID: this.target.id,
        IRMIA_PLUGIN_VERSION: this.target.version,
        IRMIA_PLUGIN_DATA_DIR: this.target.dataDir,
        IRMIA_PLUGIN_API_VERSION: String(this.target.apiVersion),
      },
    });
    this.child = child;
    if (runtime.type === 'python' && process.platform !== 'win32') this.processGroup = child.pid ?? null;
    this.attach(child);

    try {
      await this.waitReady();
      await this.activate();
    } catch (error) {
      this.killNow('activate-failed');
      const exited = await this.waitExit(PLUGIN_KILL_GRACE_MS);
      this.state = 'crashed';
      if (exited === null) {
        const message = `插件 ${this.target.id} 激活失败，终止后仍未退出（PID ${String(this.status.pid)}）；已保留进程记录，重试前必须完成清理`;
        this.options.log(message);
        throw new Error(message, { cause: error });
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
    this.state = 'running';
    this.startedAt = Date.now();
  }

  /**
   * 宿主发起的请求（串行）。超时 → `PluginRpcError{category:'timeout'}`，**不自动杀进程**：
   * 杀不杀是策略，由调用方（工具/钩子）决定。
   */
  request(method: string, params?: unknown, timeoutMs = this.timeouts.controlMs): Promise<unknown> {
    const run = this.chain.then(async () => await this.call(method, params, timeoutMs), async () => await this.call(method, params, timeoutMs));
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 正式停机：通知 → 关 stdin → 等 grace → 杀。 */
  async stop(reason = 'shutdown'): Promise<PluginExitInfo> {
    if (this.child === null) return { code: null, signal: null, requested: true, reason };
    this.requestedReason = reason;
    this.state = 'stopping';
    try {
      this.write(encodeRpcNotification(PLUGIN_HOST_METHODS.deactivate, { reason }));
    } catch { /* 进程可能已经没了：下面照旧走收尸 */ }
    try { this.child.stdin?.end(); } catch { /* 同上 */ }
    const exited = await this.waitExit(PLUGIN_STOP_GRACE_MS);
    if (exited !== null) return exited;
    this.killNow(reason);
    const killed = await this.waitExit(PLUGIN_KILL_GRACE_MS);
    if (killed !== null) return killed;
    this.state = 'crashed';
    const message = `插件 ${this.target.id} 终止后仍未退出（PID ${String(this.status.pid)}），未完成清理`;
    this.options.log(message);
    throw new Error(message);
  }

  private async waitExit(timeoutMs: number): Promise<PluginExitInfo | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.exitPromise, new Promise<null>((resolve) => {
        timer = setTimeout(() => { resolve(null); }, timeoutMs);
        timer.unref();
      })]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** 超时/隔离用的硬杀（同步发信号，不 await 退出） */
  kill(reason: string): void {
    this.requestedReason = reason;
    this.killNow(reason);
  }

  private killNow(reason: string): void {
    if (this.child === null) return;
    this.requestedReason = reason;
    this.killGroup();
    killProcessTree(this.child, { forceTree: true });
  }

  private killGroup(): void {
    // Only the PGID created by our detached spawn is ever targeted.
    if (this.processGroup === null) return;
    try { process.kill(-this.processGroup, 'SIGKILL'); } catch { /* group already empty */ }
  }

  private buildCommand(): { file: string; args: string[] } {
    const { runtime } = this.target;
    const entry = join(this.target.rootDir, runtime.entry);
    if (runtime.type === 'node') {
      const file = this.options.nodePath ?? resolveNodeExecutable();
      const args = [
        '--permission',
        // 读：只给包目录（入口、它的 import、包内资源）；写：只给插件数据目录。
        // 这两条是 P1a 唯一的"真围栏"：白名单外的写与 execSync 实测都是 ERR_ACCESS_DENIED。
        `--allow-fs-read=${this.target.rootDir}`,
        `--allow-fs-write=${this.target.dataDir}`,
      ];
      if (runtime.entry.endsWith('.ts') || runtime.entry.endsWith('.mts')) args.push('--experimental-strip-types');
      args.push(nodeRunnerPath(), entry);
      return { file, args };
    }
    const file = this.options.pythonPath ?? resolvePythonExecutable();
    // -B must be a flag: -I ignores PYTHONDONTWRITEBYTECODE from the environment.
    const args = ['-I', '-B', '-u', pythonRunnerPath(), entry];
    if (process.platform !== 'win32') return { file, args };
    const powershell = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return { file: powershell, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      join(pluginRunnerRoot(), 'windows-job.ps1'), '-Payload', Buffer.from(JSON.stringify({ file, args }), 'utf8').toString('base64')] };
  }

  private attach(child: ChildProcess): void {
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { this.onStdout(chunk); });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { this.onStderr(chunk); });
    /**
     * stdin 的写入失败（`write after end` / EPIPE）**必须在这里收掉**：
     * 进程刚好在这一刻退出时，`stdin.write()` 的失败是异步 error 事件，try/catch 抓不到；
     * 没有监听器就会变成宿主进程的 uncaughtException（一次正常停机把整个宿主带崩）。
     */
    child.stdin?.on('error', (error: Error) => {
      this.options.log(`插件 stdin 写入失败（已吞掉）：${error.message}`);
    });
    child.on('error', (error) => {
      this.spawnError = error.message;
      this.options.log(`进程错误：${error.message}`);
      // A failed spawn has no exit event; resolve cleanup and reject ready here.
      if (child.pid === undefined) this.handleExit(null, null);
    });
    child.on('exit', (code, signal) => { this.handleExit(code, signal); });
  }

  private onStdout(chunk: string): void {
    for (const frame of this.decoder.push(chunk)) {
      if ('failure' in frame) {
        this.options.handlers.onProtocolProblem(frame.failure.reason, frame.failure.line);
        continue;
      }
      this.onMessage(frame.message);
    }
  }

  private onStderr(chunk: string): void {
    const now = Date.now();
    if (now - this.stderrWindowStarted >= PLUGIN_STDERR_LIMITS.windowMs) {
      this.flushStderrDrops();
      this.stderrWindowStarted = now;
      this.stderrWindowBytes = 0;
      this.stderrWindowLines = 0;
    }
    const byteLength = Buffer.byteLength(chunk, 'utf8');
    const remaining = Math.max(0, PLUGIN_STDERR_LIMITS.bytesPerWindow - this.stderrWindowBytes);
    this.stderrWindowBytes += Math.min(remaining, byteLength);
    if (byteLength > remaining) {
      this.stderrDroppedBytes += byteLength - remaining;
      const bytes = Buffer.from(chunk, 'utf8');
      let end = remaining;
      // Avoid introducing a replacement character that would exceed the byte
      // allowance when the cutoff lands inside a UTF-8 sequence.
      while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
      this.stderrDroppedBytes += remaining - end;
      chunk = bytes.subarray(0, end).toString('utf8');
    }
    if (chunk === '') return;
    this.stderrRest += chunk;
    let index = this.stderrRest.indexOf('\n');
    while (index !== -1) {
      const line = this.stderrRest.slice(0, index).replace(/\r$/, '');
      this.stderrRest = this.stderrRest.slice(index + 1);
      if (line !== '') this.emitStderrLine(line);
      index = this.stderrRest.indexOf('\n');
    }
    // 一行都不换的 stderr（比如 Python traceback 的最后一段）也要在半行时显示，但别把它当前缀拖着
    if (this.stderrRest.length >= PLUGIN_STDERR_LIMITS.lineChars) {
      this.emitStderrLine(this.stderrRest);
      this.stderrRest = '';
    }
  }

  private emitStderrLine(line: string): void {
    if (this.stderrWindowLines >= PLUGIN_STDERR_LIMITS.linesPerWindow) {
      this.stderrDroppedBytes += Buffer.byteLength(line, 'utf8');
      return;
    }
    this.stderrWindowLines += 1;
    const kept = line.slice(0, PLUGIN_STDERR_LIMITS.lineChars);
    this.stderrDroppedBytes += Buffer.byteLength(line.slice(kept.length), 'utf8');
    this.options.handlers.onStderr(kept);
  }

  private flushStderrDrops(): void {
    if (this.stderrDroppedBytes === 0) return;
    this.options.log(`插件 stderr 超过速率上限，已丢弃 ${this.stderrDroppedBytes} 字节`);
    this.stderrDroppedBytes = 0;
  }

  /**
   * 收到一帧。用**字段判定**而不是 `isXxx` 类型谓词：`RpcNotification` 与 `RpcRequest` 的
   * 结构在 TypeScript 里是互相可赋值的（一个有 id 一个没有，但类型层面只约束"有的那些字段"），
   * 用类型谓词排除会把剩下的类型收成 never。协议层因此只认字段。
   */
  private onMessage(message: RpcMessage): void {
    const frame = message as unknown as Record<string, unknown>;
    if (typeof frame['method'] === 'string' && frame['id'] === undefined) {
      if (frame['method'] === PLUGIN_NOTIFICATIONS.ready) {
        const params = frame['params'];
        const protocol = params !== null && typeof params === 'object' && !Array.isArray(params)
          ? (params as Record<string, unknown>)['protocol']
          : undefined;
        if (protocol !== PLUGIN_PROTOCOL_VERSION) {
          this.ready?.reject(new PluginRpcError(
            PLUGIN_RPC_ERRORS.unsupported,
            `插件协议不兼容：宿主支持 protocol=${PLUGIN_PROTOCOL_VERSION}，运行器报告 ${JSON.stringify(protocol)}`,
            'unsupported',
            { supported: PLUGIN_PROTOCOL_VERSION, reported: protocol ?? null },
          ));
        } else {
          this.ready?.resolve();
        }
        return;
      }
      // 插件发来的通知（目前是 log.write）：照请求处理，只是没有回帧。
      // 丢掉的代价是"插件日志永远看不见"——而日志正是排障时唯一能看的东西。
      void this.options.handlers.onRequest(frame['method'], frame['params']).catch((error: unknown) => {
        this.options.handlers.onProtocolProblem('插件通知处理失败', error instanceof Error ? error.message : String(error));
      });
      return;
    }
    if (typeof frame['method'] === 'string') {
      const id = frame['id'];
      if (typeof id === 'number' || typeof id === 'string') {
        void this.serve(id, frame['method'], frame['params']);
        return;
      }
    }
    const id = frame['id'];
    if (typeof id !== 'number' && typeof id !== 'string') {
      this.options.handlers.onProtocolProblem('无法判定的帧', JSON.stringify(message).slice(0, 300));
      return;
    }
    const entry = this.pending.get(id);
    if (entry === undefined) {
      this.options.handlers.onProtocolProblem('收到对不上号的响应（id 不在飞）', JSON.stringify(message).slice(0, 300));
      return;
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    const error = frame['error'];
    if (error !== null && typeof error === 'object') {
      const detail = error as Record<string, unknown>;
      entry.reject(new PluginRpcError(
        typeof detail['code'] === 'number' ? detail['code'] : PLUGIN_RPC_ERRORS.internalError,
        typeof detail['message'] === 'string' ? detail['message'] : '插件调用失败',
        'business',
        detail['data'],
      ));
    } else {
      entry.resolve(frame['result']);
    }
  }

  private async serve(id: string | number, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.options.handlers.onRequest(method, params);
      this.safeWrite(encodeRpcResult(id, result));
    } catch (error) {
      const code = error instanceof PluginRpcError ? error.code : PLUGIN_RPC_ERRORS.internalError;
      const message = error instanceof Error ? error.message : String(error);
      this.safeWrite(encodeRpcError(id, code, message));
    }
  }

  /**
   * 回帧失败**只吞掉**：进程可能就在这一刻退了（uninstall/disable），这时"回不了帧"是
   * 预期内的——让它变成一个未处理的 Promise 拒绝，会把宿主的关停流程染成一条假故障。
   */
  private safeWrite(frame: string): void {
    try {
      this.write(frame);
    } catch {
      /* 见方法注释 */
    }
  }

  private waitReady(): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => { this.ready = { resolve, reject }; });
    return Promise.race([
      ready,
      delay(this.timeouts.activationMs).then(() => {
        throw new PluginRpcError(PLUGIN_RPC_ERRORS.timeout, `插件在 ${this.timeouts.activationMs}ms 内没有报告 ready`, 'timeout');
      }),
    ]).finally(() => { this.ready = null; });
  }

  private async activate(): Promise<void> {
    try {
      await this.call(PLUGIN_HOST_METHODS.activate, {
        apiVersion: this.target.apiVersion,
        id: this.target.id,
        version: this.target.version,
        permissions: [...this.target.permissions],
        netAllow: [...this.target.netAllow],
        config: this.target.config,
        dataDir: this.target.dataDir,
      }, this.timeouts.activationMs);
    } catch (error) {
      if (error instanceof PluginRpcError) throw error;
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.internalError, `插件 activate 失败：${error instanceof Error ? error.message : String(error)}`, 'crash');
    }
  }

  private call(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.child === null || this.exited) {
      return Promise.reject(new PluginRpcError(PLUGIN_RPC_ERRORS.pluginExited, '插件进程已经退出', 'crash'));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PluginRpcError(PLUGIN_RPC_ERRORS.timeout, `${method} 超过 ${timeoutMs}ms 未返回`, 'timeout'));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.write(encodeRpcRequest(id, method, params));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(frame: string): void {
    const stdin = this.child?.stdin;
    if (stdin === null || stdin === undefined || stdin.destroyed || stdin.writableEnded || !stdin.writable) {
      throw new PluginRpcError(PLUGIN_RPC_ERRORS.pluginExited, '插件 stdin 已关闭', 'crash');
    }
    stdin.write(frame);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.killGroup();
    this.processGroup = null;
    this.flushStderrDrops();
    this.exited = true;
    const requested = this.requestedReason !== null;
    const reason = this.requestedReason ?? (this.spawnError === null ? 'exit' : 'spawn-error');
    this.state = requested ? 'stopped' : 'crashed';
    this.child = null;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new PluginRpcError(PLUGIN_RPC_ERRORS.pluginExited,
        `插件进程在 ${entry.method} 返回前退出（code=${String(code)}, signal=${String(signal)}）`, 'crash'));
      this.pending.delete(id);
    }
    this.ready?.reject(new PluginRpcError(PLUGIN_RPC_ERRORS.pluginExited, '插件在 ready 之前退出', 'crash'));
    const info: PluginExitInfo = { code, signal, requested, reason, ...(this.spawnError === null ? {} : { error: this.spawnError }) };
    this.resolveExit(info);
    try {
      this.options.onExit(info);
    } catch (error) {
      this.options.log(`退出回调抛错（已吞掉）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// ──────────────────────────────── 监督者（崩溃冷却 + 重启一次） ────────────────────────────────

export interface PluginRuntimeStatus {
  state: 'stopped' | 'starting' | 'running' | 'restarting' | 'crashed' | 'failed';
  pid: number | null;
  startedAt: number;
  uptimeMs: number;
  restarts: number;
  lastExit: PluginExitInfo | null;
}

export interface SupervisorTarget extends PluginProcessTarget {}

export interface PluginRuntimeSupervisorOptions {
  log: (line: string) => void;
  emit: (type: string, data: Record<string, unknown>) => void;
  timeouts?: Partial<PluginTimeouts>;
  /** 首次崩溃后的冷却（默认 30s；测试可缩短） */
  crashCooldownMs?: number;
  /** 超时击杀后的重启冷却（默认与崩溃同值） */
  timeoutRestartDelayMs?: number;
  now?: () => number;
  nodePath?: string;
  pythonPath?: string;
  env?: NodeJS.ProcessEnv;
  /** 连续崩溃两次：交回宿主自动停用 */
  onFatal?: (target: SupervisorTarget, reason: string) => void;
}

interface SupervisedEntry {
  target: SupervisorTarget;
  handlers: PluginProcessHandlers;
  process: PluginProcess | null;
  restarts: number;
  restartTimer: NodeJS.Timeout | null;
  stopping: boolean;
  startedAt: number;
  lastExit: PluginExitInfo | null;
  lastError: string | null;
}

const keyOf = (id: string, hash: string): string => `${id}\0${hash}`;

export class PluginRuntimeSupervisor {
  private readonly entries = new Map<string, SupervisedEntry>();
  private readonly options: PluginRuntimeSupervisorOptions;
  private readonly now: () => number;

  constructor(options: PluginRuntimeSupervisorOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  async start(target: SupervisorTarget, handlers: PluginProcessHandlers): Promise<void> {
    const key = keyOf(target.id, target.contentHash);
    const existing = this.entries.get(key);
    if (existing !== undefined) await this.stop(target.id, target.contentHash, 'restart');
    const entry: SupervisedEntry = {
      target, handlers, process: null, restarts: 0, restartTimer: null,
      stopping: false, startedAt: 0, lastExit: null, lastError: null,
    };
    this.entries.set(key, entry);
    try {
      await this.spawnEntry(entry, false);
    } catch (error) {
      entry.stopping = true;
      if (entry.restartTimer !== null) clearTimeout(entry.restartTimer);
      entry.restartTimer = null;
      entry.lastError = error instanceof Error ? error.message : String(error);
      this.options.emit('plugin/failed', {
        id: target.id, contentHash: target.contentHash,
        reason: `插件启动失败：${entry.lastError}`,
        category: 'start',
      });
      if (entry.process?.status.pid == null) this.entries.delete(key);
      throw error;
    }
  }

  private async spawnEntry(entry: SupervisedEntry, isRestart: boolean): Promise<void> {
    const process = new PluginProcess({
      target: entry.target,
      handlers: entry.handlers,
      ...(this.options.timeouts === undefined ? {} : { timeouts: this.options.timeouts }),
      log: (line) => { this.options.log(line); },
      onExit: (info) => { this.handleExit(entry, info); },
      ...(this.options.nodePath === undefined ? {} : { nodePath: this.options.nodePath }),
      ...(this.options.pythonPath === undefined ? {} : { pythonPath: this.options.pythonPath }),
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
    });
    entry.process = process;
    await process.start();
    entry.startedAt = this.now();
    entry.lastError = null;
    this.options.emit('plugin/runtime-started', {
      id: entry.target.id, contentHash: entry.target.contentHash,
      runtime: entry.target.runtime.type, entry: entry.target.runtime.entry,
      pid: process.status.pid, startedAt: new Date(entry.startedAt).toISOString(),
      ...(isRestart ? { restarted: true, attempt: entry.restarts } : {}),
    });
    if (isRestart) {
      this.options.emit('plugin/restarted', {
        id: entry.target.id, contentHash: entry.target.contentHash,
        attempt: entry.restarts, pid: process.status.pid, at: new Date(this.now()).toISOString(),
      });
    }
  }

  private handleExit(entry: SupervisedEntry, info: PluginExitInfo): void {
    entry.process = null;
    entry.lastExit = info;
    const key = keyOf(entry.target.id, entry.target.contentHash);
    if (entry.stopping || (info.requested && info.reason !== 'timeout')) {
      entry.stopping = true;
      this.options.emit('plugin/runtime-stopped', {
        id: entry.target.id, contentHash: entry.target.contentHash, reason: info.reason,
      });
      if (this.entries.get(key) === entry) this.entries.delete(key);
      return;
    }
    if (info.requested && info.reason === 'timeout') {
      // 超时击杀：不消耗崩溃预算（见文件头），冷却后拉起来
      this.options.emit('plugin/runtime-stopped', {
        id: entry.target.id, contentHash: entry.target.contentHash, reason: 'timeout',
      });
      this.scheduleRestart(entry, this.options.timeoutRestartDelayMs ?? this.options.crashCooldownMs ?? PLUGIN_CRASH_COOLDOWN_MS);
      return;
    }
    // 真正的崩溃（它自己没的）
    const willRestart = entry.restarts < 1;
    this.options.emit('plugin/crashed', {
      id: entry.target.id, contentHash: entry.target.contentHash,
      pid: null, exitCode: info.code, signal: info.signal,
      reason: info.reason, willRestart, at: new Date(this.now()).toISOString(),
      ...(info.error === undefined ? {} : { error: info.error }),
    });
    if (!willRestart) {
      entry.stopping = true;
      this.options.emit('plugin/failed', {
        id: entry.target.id, contentHash: entry.target.contentHash,
        reason: `插件连续两次崩溃（最近一次 code=${String(info.code)} signal=${String(info.signal)}），已自动停用`,
        category: 'crash',
      });
      if (this.entries.get(key) === entry) this.entries.delete(key);
      try {
        this.options.onFatal?.(entry.target, '连续两次崩溃');
      } catch (error) {
        this.options.log(`自动停用回调抛错：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    entry.restarts += 1;
    this.scheduleRestart(entry, this.options.crashCooldownMs ?? PLUGIN_CRASH_COOLDOWN_MS);
  }

  private scheduleRestart(entry: SupervisedEntry, delayMs: number): void {
    if (entry.restartTimer !== null) clearTimeout(entry.restartTimer);
    this.options.emit('plugin/restart-scheduled', {
      id: entry.target.id, contentHash: entry.target.contentHash,
      delayMs, at: new Date(this.now()).toISOString(),
    });
    const timer = setTimeout(() => {
      entry.restartTimer = null;
      void this.restartEntry(entry);
    }, delayMs);
    timer.unref();
    entry.restartTimer = timer;
  }

  private async restartEntry(entry: SupervisedEntry): Promise<void> {
    if (entry.stopping) return;
    try {
      await this.spawnEntry(entry, true);
    } catch (error) {
      entry.lastError = error instanceof Error ? error.message : String(error);
      entry.stopping = true;
      this.options.emit('plugin/failed', {
        id: entry.target.id, contentHash: entry.target.contentHash,
        reason: `插件重启失败，已停用：${entry.lastError}`,
        category: 'start',
      });
      if (entry.process?.status.pid == null) this.entries.delete(keyOf(entry.target.id, entry.target.contentHash));
      try {
        this.options.onFatal?.(entry.target, '重启失败');
      } catch (error) {
        this.options.log(`自动停用回调抛错：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async stop(id: string, contentHash: string, reason = 'disable'): Promise<void> {
    const key = keyOf(id, contentHash);
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    entry.stopping = true;
    if (entry.restartTimer !== null) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = null;
    }
    const process = entry.process;
    // 不在这里把 entry.process 置空：`status()` 的 pid 必须一直报到"进程真的退了"那一刻，
    // 否则界面（与测试）会在 stop 刚开始时就以为已经收尸完毕，而 runtime-stopped 事件还没落。
    if (process !== null) await process.stop(reason);
    if (entry.process === process) entry.process = null;
    this.entries.delete(key);
  }

  async stopAll(reason = 'shutdown'): Promise<void> {
    const entries = [...this.entries.values()];
    await Promise.all(entries.map(async (entry) => {
      await this.stop(entry.target.id, entry.target.contentHash, reason);
    }));
  }

  /** 同步杀（uninstall 要在删目录之前把进程收掉；kill 本身不需要 await） */
  killNow(id: string, contentHash: string, reason = 'uninstall'): void {
    const key = keyOf(id, contentHash);
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    entry.stopping = true;
    if (entry.restartTimer !== null) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = null;
    }
    entry.process?.kill(reason);
    this.entries.delete(key);
  }

  get(id: string, contentHash: string): PluginProcess | null {
    return this.entries.get(keyOf(id, contentHash))?.process ?? null;
  }

  status(id: string, contentHash: string): PluginRuntimeStatus | null {
    const entry = this.entries.get(keyOf(id, contentHash));
    if (entry === undefined) return null;
    const runtime = entry.process?.status;
    return {
      state: runtime === undefined ? (entry.stopping ? 'stopped' : 'restarting') : (runtime.state === 'running' ? 'running' : runtime.state === 'starting' ? 'starting' : runtime.state === 'crashed' ? 'crashed' : 'stopped'),
      pid: runtime?.pid ?? null,
      startedAt: entry.startedAt,
      uptimeMs: entry.startedAt > 0 ? this.now() - entry.startedAt : 0,
      restarts: entry.restarts,
      lastExit: entry.lastExit,
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
