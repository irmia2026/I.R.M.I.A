/**
 * 拉起器等**就绪**的那三条路 —— 用**真的假后端**（真 HTTP 服务器）验，不 mock 判据。
 *
 * 事故（2026-10-26，`data/restart-worker.log`）：
 * ```
 * [结束] ok=False backendPid=24616 port=timeout … reason=port-not-ready ·
 *        新的 pid=24616 已经写进 lock.json，但端口 127.0.0.1:7788 在 32000 毫秒里没有应答
 * ```
 * 冷启动 35–42 秒 ⇒ 32 秒的窗口必然超时；判据还是"TCP 能连"（端口先 bind 之后，那恰好是
 * **还没就绪**那一刻的特征）。这一份钉住改完之后的四条：
 *
 *   ① **立刻 ready** ⇒ `[结束] ok=True port=ready`，恰好一行，退出码 0；
 *   ② **20 秒后才 ready** ⇒ 一路等过去（中途 `starting` 不算失败），最后 `port=ready`；
 *   ③ **永不就绪** ⇒ 先写 `[结束] ok=False port=starting-timeout`，**不杀新实例**，
 *      再等 60 秒复查；仍然不就绪 ⇒ 只留那一行、退出码 1；
 *   ④ **复查改判** ⇒ 超时之后 60 秒内通了：补写一行 `[结束] ok=True port=ready`，
 *      解析取**最后**一行（`parseRestartTrace`），退出码 0。
 *
 * 时钟是假的（`io.now`/`io.sleep`），所以"20 秒"与"60 秒"在用例里只花几百毫秒；
 * 端口与 health 答复是**真的**（真 `http.createServer`），所以判据不是 mock 出来的。
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test, { type TestContext } from 'node:test';

import { RESTART_FAILURE_REASONS } from '../src/runtime/restart-chain.ts';
import {
  parseRestartWorkerArgs, runRestartWorker, type HealthProbe, type RestartWorkerIo, type RestartWorkerOptions,
} from '../src/runtime/restart-worker.ts';
import { RESTART_PORT_WAIT_MS, parseRestartTrace } from '../src/web/server.ts';

/** 一次探测的模拟耗时（与 `restart-worker.ts` 里的 POLL_MS 同值：一拍 = 500 毫秒） */
const TICK_MS = 500;

/**
 * 一个**真的**假后端：只答 `/api/health`。
 *
 * `readyAfterProbes` 是"第几次探测开始说 ready"——用它模拟"重活还在干"：
 *   · 1（缺省）= 立刻 ready；`null` = 永远 starting；数字 = 第 N 次探测起 ready。
 */
async function fakeBackend(t: TestContext, readyAfterProbes: number | null): Promise<{ server: Server; port: number; probes: () => number }> {
  let probes = 0;
  const server = createServer((req, res) => {
    if ((req.url ?? '').split('?')[0] !== '/api/health') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":{"code":"not-found","message":"fake"}}');
      return;
    }
    probes += 1;
    const ready = readyAfterProbes !== null && probes >= readyAfterProbes;
    const body = JSON.stringify({
      status: ready ? 'ready' : 'starting',
      uptimeMs: probes * TICK_MS,
      port: 0,
      pid: 4242,
      phase: ready ? 'ready' : 'events',
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  assert.ok(port > 0, '假后端没拿到端口');
  t.after(async () => {
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      server.closeAllConnections?.();
    });
  });
  return { server, port, probes: () => probes };
}

interface World {
  io: RestartWorkerIo;
  trace: string[];
  logs: string[];
  options: RestartWorkerOptions;
  /** 模拟时钟（毫秒） */
  now(): number;
  /** 新实例的 pid 活着的读数（这里从不杀它：用例据此断言"没杀"） */
  spawnedPid(): number;
}

function world(input: {
  port: number;
  portWaitMs: number;
  /** 新实例什么时候把 lock.json 换成自己的 pid（第几拍；0 = 一起来就换） */
  lockAfterTicks?: number;
}): World {
  const trace: string[] = [];
  const logs: string[] = [];
  let ticks = 0;
  let spawned = false;
  let lockPid = 0;
  const lockAfter = input.lockAfterTicks ?? 0;
  const options: RestartWorkerOptions = {
    oldPids: [111],
    root: 'C:\\Irmia\\app',
    nodeExe: 'C:\\Irmia\\app\\runtime\\node\\node.exe',
    entry: 'C:\\Irmia\\app\\dist\\main.js',
    traceLog: 'C:\\Irmia\\app\\data\\restart-trace.log',
    backendLog: 'C:\\Irmia\\app\\data\\restart-backend.log',
    dataDir: 'C:\\Irmia\\app\\data',
    host: '127.0.0.1',
    port: input.port,
    guiExe: 'C:\\Irmia\\app\\gui\\irmia_gui.exe',
    guiOnly: false,
    waitMs: 1_000,
    portWaitMs: input.portWaitMs,
  };
  const io: RestartWorkerIo = {
    trace: (line) => { trace.push(line); },
    log: (line) => { logs.push(line); },
    now: () => ticks * TICK_MS,
    sleep: async (ms) => {
      ticks += Math.max(1, Math.round(ms / TICK_MS));
      await new Promise<void>((resolve) => { setTimeout(resolve, 2); });
    },
    isPidAlive: (pid) => pid === 111 && ticks < 1,
    readLockPid: () => {
      if (!spawned) return 0;
      if (ticks < lockAfter) return 0;
      lockPid = 222;
      return lockPid;
    },
    // **真的探测**（真 HTTP）：判据不是 mock 的
    probeHealth: async (host, port, timeoutMs) => {
      const res = await fetch(`http://${host}:${port}/api/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      }).catch(() => null);
      if (res === null) return 'down';
      const text = await res.text().catch(() => '');
      try {
        const parsed = JSON.parse(text) as { status?: unknown };
        if (parsed.status === 'ready') return 'ready';
        if (parsed.status === 'starting') return 'starting';
      } catch {
        // 读不懂就不是 ready
      }
      return 'starting';
    },
    spawnBackend: () => {
      spawned = true;
      return 222;
    },
    stopGui: () => [333],
    startGui: () => 444,
  };
  return {
    io,
    trace,
    logs,
    options,
    now: () => ticks * TICK_MS,
    spawnedPid: () => (spawned ? 222 : 0),
  };
}

function endLines(text: string): string[] {
  return text.split(/\r?\n/u).filter((line) => line.startsWith('[结束]'));
}

// ──────────────────────────── ① 立刻 ready ────────────────────────────

test('① 假后端立刻 ready ⇒ [结束] ok=True port=ready（恰好一行，退出码 0）', async (t) => {
  const backend = await fakeBackend(t, 1);
  const w = world({ port: backend.port, portWaitMs: 180_000 });
  const code = await runRestartWorker(w.options, w.io);

  assert.equal(code, 0);
  const text = w.trace.join('');
  assert.match(text, /\[回执\] 路径=self-restart/u);
  assert.match(text, /\[实例\] 后端已接管 pid=222 source=lock\.json path=self-restart/u);
  const ends = endLines(text);
  assert.equal(ends.length, 1, `[结束] 必须恰好一行：${ends.join(' / ')}`);
  assert.match(ends[0] ?? '', /^\[结束\] ok=True backendPid=222 port=ready guiPid=444 path=self-restart reason=ok/u);

  const parsed = parseRestartTrace(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.port, 'ready');
  assert.equal(parsed.backendPid, 222);
  assert.equal(parsed.path, 'self-restart');
});

// ──────────────────────────── ② 20 秒后才 ready ────────────────────────────

test('② 20 秒后才 ready：中途 starting 不算失败，最后 port=ready（窗口 180 秒够）', async (t) => {
  // 40 拍 × 500ms = 20 秒（第 41 次探测起说 ready）
  const backend = await fakeBackend(t, 41);
  const w = world({ port: backend.port, portWaitMs: 180_000 });
  const code = await runRestartWorker(w.options, w.io);

  assert.equal(code, 0, '180 秒的窗口里 20 秒就该等到');
  const text = w.trace.join('');
  const ends = endLines(text);
  assert.equal(ends.length, 1, '等到了就只写一行');
  assert.match(ends[0] ?? '', /ok=True .* port=ready /u);
  assert.ok(w.now() >= 20_000, `应当真的等满 20 秒（模拟时钟），实际 ${w.now()}ms`);
  assert.equal(w.trace.join('').includes('ok=False'), false, '中途的 starting 不许写成失败');
});

// ──────────────────────────── ③ 永不就绪 ────────────────────────────

test('③ 永不就绪：先写 ok=False port=starting-timeout，**不杀新实例**，复查后仍失败（一行、1）', async (t) => {
  const backend = await fakeBackend(t, null);
  const w = world({ port: backend.port, portWaitMs: 3_000 });
  const code = await runRestartWorker(w.options, w.io);

  assert.equal(code, 1);
  const text = w.trace.join('');
  const ends = endLines(text);
  assert.equal(ends.length, 1, `复查没通就只留一行 [结束]：${ends.join(' / ')}`);
  assert.match(ends[0] ?? '',
    /^\[结束\] ok=False backendPid=222 port=starting-timeout guiPid=444 path=self-restart reason=port-not-ready/u);
  assert.match(ends[0] ?? '', /没有杀掉新实例/u);
  // **没杀**：这条路上根本没有杀进程的分支，用例从"它还在"这一侧钉住
  assert.equal(w.spawnedPid(), 222, '新实例必须留着（超时不等于失败到要收尸）');
  assert.ok(w.logs.some((line) => line.includes('不杀新实例')), '拉起器自己要说明这一点');
  // 复查窗口真的等了 60 秒（模拟时钟：3 秒窗口 + 60 秒复查）
  assert.ok(w.now() >= 63_000, `应当等过 3s 窗口 + 60s 复查，实际 ${w.now()}ms`);
  // 解析取最后一行：这里也读成失败（ok=False）
  const parsed = parseRestartTrace(text);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.port, 'starting-timeout');
  assert.equal(parsed.reason, RESTART_FAILURE_REASONS.portNotReady);
});

// ──────────────────────────── ④ 复查改判 ────────────────────────────

test('④ 超时之后 60 秒内通了 ⇒ 补写一行 ok=True（改判），解析取最后一行', async (t) => {
  // 窗口 3 秒（6 拍），第 9 次探测起 ready（≈4.5 秒）：超时那一刻还在 starting，复查时通了
  const backend = await fakeBackend(t, 9);
  const w = world({ port: backend.port, portWaitMs: 3_000 });
  const code = await runRestartWorker(w.options, w.io);

  assert.equal(code, 0, '复查通了就算成功');
  const text = w.trace.join('');
  const ends = endLines(text);
  assert.equal(ends.length, 2, `超时 + 改判各一行：${ends.join(' / ')}`);
  assert.match(ends[0] ?? '', /ok=False .* port=starting-timeout /u, '第一行是超时那一刻的读数');
  assert.match(ends[1] ?? '', /ok=True .* port=ready /u, '第二行是改判');
  assert.match(ends[1] ?? '', /复查改判/u);

  const parsed = parseRestartTrace(text);
  assert.equal(parsed.ok, true, '解析必须取**最后**一行：改判之后的结论');
  assert.equal(parsed.port, 'ready');
  assert.equal(parsed.backendPid, 222);
  assert.equal(parsed.reason, RESTART_FAILURE_REASONS.ok);
});

// ──────────────────────────── ⑤ 窗口的默认值与"服务端传的那个数" ────────────────────────────

test('⑤ 窗口：--port-wait-ms 缺省 180 秒；服务端拼的那一格也是 180 秒（原来 32 秒）', () => {
  const parsed = parseRestartWorkerArgs([
    '--root', 'C:\\Irmia\\app', '--node', 'n.exe', '--entry', 'e.js',
    '--trace', 't.log', '--data-dir', 'd', '--port', '7788',
  ]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.options.portWaitMs, 180_000, '缺省窗口必须是三分钟（冷启动 40 秒 + 重活余量）');
  assert.equal(RESTART_PORT_WAIT_MS, 180_000, '服务端传给拉起器的那个数（--port-wait-ms）也必须是三分钟');
});

// ──────────────────────────── ⑥ 判据是 health，不是"TCP 能连" ────────────────────────────

test('⑥ 端口通但 health 一直 starting ⇒ 不许判成功（TCP 能连 ≠ 能干活）', async (t) => {
  const backend = await fakeBackend(t, null);
  const w = world({ port: backend.port, portWaitMs: 2_000 });
  const code = await runRestartWorker(w.options, w.io);
  assert.equal(code, 1, 'TCP 通、health 说 starting：这不是成功');
  const parsed = parseRestartTrace(w.trace.join(''));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.port, 'starting-timeout');
});

test('⑥b 端口根本没人听 ⇒ 那一档报 timeout（与 starting-timeout 分开）', async (t) => {
  // 挑一个"刚关掉"的端口：先起一个假后端拿到端口，再关掉
  const backend = await fakeBackend(t, 1);
  const deadPort = backend.port;
  await new Promise<void>((resolveClose) => {
    backend.server.close(() => resolveClose());
    backend.server.closeAllConnections?.();
  });
  const w = world({ port: deadPort, portWaitMs: 1_500 });
  const code = await runRestartWorker(w.options, w.io);
  assert.equal(code, 1);
  const parsed = parseRestartTrace(w.trace.join(''));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.port, 'timeout', '没人听 ⇒ timeout；"在听但没就绪" ⇒ starting-timeout');
});

// ──────────────────────────── ⑦ 探测函数本身 ────────────────────────────

test('⑦ probeHealth 三档：ready / starting / down 各自读得回来', async (t) => {
  const { probeHealth } = await import('../src/runtime/restart-worker.ts');
  const ready = await fakeBackend(t, 1);
  const starting = await fakeBackend(t, null);
  assert.equal(await probeHealth('127.0.0.1', ready.port, 500), 'ready' satisfies HealthProbe);
  assert.equal(await probeHealth('127.0.0.1', starting.port, 500), 'starting' satisfies HealthProbe);
  // 端口 1 上几乎不可能有人听
  assert.equal(await probeHealth('127.0.0.1', 1, 300), 'down' satisfies HealthProbe);
});
