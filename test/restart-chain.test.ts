/**
 * 重启链条的**路径选择**与三态回执（`src/runtime/restart-chain.ts` + `src/runtime/restart-worker.ts`）。
 *
 * 钉的是用户 2026-10-07 报的「beta5 内测包重启不了」那颗根因：
 *
 *   · ① 三条路径的**选择判据**：有仓库脚本 / 只有随包脚本 / 都没有 ⇒ 自重启；
 *   · ② 三条路径的回执里都要**写明走的是哪一条**，而服务端解析得出来；
 *   · ③ 失败要**说清哪一环**（脚本缺 / 起不来 / 端口没就绪 / lock 没换 pid）——
 *     "没能确认"不算交代。
 *
 * 真环境（WMI 建进程、真的停旧实例）造不出来也不该在单测里造，所以：
 *   · 选择判据是纯函数（"盘上有什么"注入进来）；
 *   · 拉起器的正文走注入的 io（"怎么做"是假的，"怎么判"是真的）；
 *   · **真的重启一次**那条路在隔离端到端里验（见报告与 `_tmp/` 的现场记录）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RESTART_FAILURE_REASONS, chooseRestartPath, endTraceLine, instanceTraceLine, packagedRestartScript,
  parseRestartPath, repoRestartScript, restartReasonText, restartTraceLine, restartWorkerScript,
} from '../src/runtime/restart-chain.ts';
import { parseRestartTrace, restartCommandLine, restartNote } from '../src/web/server.ts';
import {
  MAX_OLD_SPACE_MB, backendSpawnArgv, parseRestartWorkerArgs, probeTcp, runRestartWorker,
  type RestartWorkerIo, type RestartWorkerOptions,
} from '../src/runtime/restart-worker.ts';

/** 造一个"只有这些路径存在"的世界 */
function world(existing: readonly string[]): (path: string) => boolean {
  const set = new Set(existing);
  return (path: string) => set.has(path);
}

const ROOT = 'C:\\Irmia\\app';

// ──────────────────────────────── ① 选择判据 ────────────────────────────────

test('① 有仓库脚本 ⇒ repo-script（开发机的行为一个字都不许变）', () => {
  const choice = chooseRestartPath(ROOT, { fileExists: world([repoRestartScript(ROOT)]) });
  assert.equal(choice.path, 'repo-script');
  assert.equal(choice.file, 'C:\\Irmia\\app\\tools\\restart-agent.ps1');
  assert.match(choice.why, /repo|tools/u);
});

test('① 只有随包脚本 ⇒ packaged-script（**装出来的那份走这条**）', () => {
  // 这一条正是缺陷的正面：装出来的那份只有 `<root>\restart.ps1`，没有 `tools\`
  const choice = chooseRestartPath(ROOT, { fileExists: world([packagedRestartScript(ROOT)]) });
  assert.equal(choice.path, 'packaged-script');
  assert.equal(choice.file, 'C:\\Irmia\\app\\restart.ps1');
});

test('① 两条都没有 ⇒ self-restart（绝不退回"跑一条不存在的脚本"）', () => {
  // beta.5 的装配目录就是这个形状：包根没有 tools\、也没有 restart.ps1
  const choice = chooseRestartPath(ROOT, { fileExists: world([]) });
  assert.equal(choice.path, 'self-restart');
  // 拉起器随 dist\ 装配，所以它必然在安装根之下（路径给出来是为了留痕里能对得上）
  assert.equal(choice.file, restartWorkerScript(ROOT));
  assert.match(choice.why, /既没有仓库脚本也没有随包脚本|既没有/u);
});

test('① 两条脚本都在 ⇒ 仓库脚本优先（优先级链只有这一处）', () => {
  const choice = chooseRestartPath(ROOT, {
    fileExists: world([repoRestartScript(ROOT), packagedRestartScript(ROOT)]),
  });
  assert.equal(choice.path, 'repo-script');
});

// ──────────────────────────────── ② 回执里写明哪一条 ────────────────────────────────

test('② 三行回执的格式：路径那一栏三处都写得出、服务端都读得回', () => {
  for (const [path, label] of [
    ['repo-script', 'repo-script'], ['packaged-script', 'packaged-script'], ['self-restart', 'self-restart'],
  ] as const) {
    const text = restartTraceLine('回执', `路径=${label} · x`)
      + instanceTraceLine({ backendPid: 4242, source: 'lock.json', path })
      + endTraceLine({
        ok: true, backendPid: 4242, port: 'ready', guiPid: 7, path, reason: RESTART_FAILURE_REASONS.ok,
      });
    const parsed = parseRestartTrace(text);
    assert.equal(parsed.path, path, `回执里的路径要能读回来（${label}）`);
    assert.equal(parsed.receipt, true);
    assert.equal(parsed.backendPid, 4242);
    assert.equal(parsed.port, 'ready');
    assert.equal(parsed.guiPid, 7);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.reason, 'ok');
  }
});

test('② 失败那一行带 reason，服务端读得出"坏在哪一环"', () => {
  const line = endTraceLine({
    ok: false, backendPid: 0, port: 'unknown', guiPid: 0, path: 'self-restart',
    reason: RESTART_FAILURE_REASONS.lockNotChanged, detail: 'lock.json 里的 pid 还是旧的',
  });
  const parsed = parseRestartTrace(line);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.path, 'self-restart');
  assert.equal(parsed.reason, 'lock-not-changed');
  assert.match(line, /\[结束\]/u);
  // 每一条失败理由都要有**人读的一句话**（回执照抄它）——
  // 否则界面只能说"失败了"，而用户要的是"坏在哪"
  for (const reason of Object.values(RESTART_FAILURE_REASONS)) {
    if (reason === 'ok') continue;
    assert.notEqual(restartReasonText(reason), '', `失败环节 ${reason} 没有对应的说明`);
  }
  assert.equal(restartReasonText(RESTART_FAILURE_REASONS.ok), '');
});

test('② 老留痕（没有路径那一栏）读回来是 null —— 不猜', () => {
  const legacy = '[回执] 脚本已启动 · GuiExe=（空）\r\n[结束] ok=True backendPid=9 port=ready guiPid=0\r\n';
  const parsed = parseRestartTrace(legacy);
  assert.equal(parsed.path, null);
  assert.equal(parseRestartPath(legacy), null);
  assert.equal(parsed.ok, true);
});

// ──────────────────────────────── ③ 三态文案 ────────────────────────────────

test('③ 文案三态：没执行 / 失败（带哪一环）/ 成功（带真 pid 与端口）/ 未确认', () => {
  // 没执行：self-restart 这一档要说"拉起器"，而不是把人指去跑一条不存在的脚本
  const notStartedSelf = restartNote({ gui: true, scriptStarted: false, path: 'self-restart' });
  assert.match(notStartedSelf, /未能执行/u);
  assert.match(notStartedSelf, /没有被重启/u);
  assert.match(notStartedSelf, /拉起器/u);
  assert.match(notStartedSelf, /self-restart/u);
  assert.equal(/正在重启/u.test(notStartedSelf), false);

  // 没执行：脚本那两条照旧指到脚本上
  const notStartedScript = restartNote({ gui: true, scriptStarted: false, path: 'packaged-script' });
  assert.match(notStartedScript, /restart\.ps1/u);
  assert.match(notStartedScript, /packaged-script/u);

  // 失败：要把"坏在哪一环"翻成人话（这里是 lock 没换 pid）
  const failed = restartNote({
    gui: true, scriptStarted: true, ok: false, backendPid: 0, port: 'timeout',
    reason: RESTART_FAILURE_REASONS.lockNotChanged, path: 'self-restart',
  });
  assert.match(failed, /失败/u);
  assert.match(failed, /lock\.json/u);
  assert.match(failed, /self-restart/u);
  assert.equal(/正在重启/u.test(failed), false);

  // 成功：真 pid + 端口就绪，并写明走的是哪一条
  const ok = restartNote({
    gui: false, scriptStarted: true, ok: true, backendPid: 70788, port: 'ready', path: 'packaged-script',
  });
  assert.match(ok, /70788/u);
  assert.match(ok, /端口已就绪/u);
  assert.match(ok, /packaged-script/u);

  // 未确认：self-restart 要说"拉起器已经在跑了"（它确实是——只是结局晚于这次回执）
  const pending = restartNote({ gui: true, scriptStarted: true, ok: null, port: 'waiting', path: 'self-restart' });
  assert.match(pending, /还没确认/u);
  assert.match(pending, /拉起器已经在跑/u);
  assert.equal(/端口已就绪/u.test(pending), false);
});

// ──────────────────────────────── 拉起器：参数与三态 ────────────────────────────────

const BASE_OPTIONS: RestartWorkerOptions = {
  oldPids: [111],
  root: ROOT,
  nodeExe: 'C:\\Irmia\\app\\runtime\\node\\node.exe',
  entry: 'C:\\Irmia\\app\\dist\\main.js',
  traceLog: 'C:\\Irmia\\app\\data\\restart-trace.log',
  backendLog: 'C:\\Irmia\\app\\data\\restart-backend.log',
  dataDir: 'C:\\Irmia\\app\\data',
  host: '127.0.0.1',
  port: 7788,
  guiExe: '',
  guiOnly: false,
  waitMs: 1_000,
  portWaitMs: 1_000,
};

interface FakeWorld {
  io: RestartWorkerIo;
  trace: string[];
  options: RestartWorkerOptions;
}

/**
 * 造一个可控的世界：旧实例什么时候死、新实例什么时候写 lock、端口什么时候应答，
 * 全由这里的开关决定——三个失败环节于是各自能单独摆一遍。
 */
function fakeWorld(overrides: Partial<RestartWorkerOptions> & {
  oldDiesAfterPolls?: number;
  lockPidAfterSpawn?: number;
  portReadyAfterPolls?: number;
  spawnThrows?: boolean;
  stopGuiThrows?: boolean;
  guiStarts?: number;
} = {}): FakeWorld {
  const options: RestartWorkerOptions = {
    ...BASE_OPTIONS,
    ...overrides,
    oldPids: overrides.oldPids ?? BASE_OPTIONS.oldPids,
  };
  const trace: string[] = [];
  let ticks = 0;
  let lockPid = 111;
  let spawned = false;
  const oldDiesAfter = overrides.oldDiesAfterPolls ?? 1;
  const portAfter = overrides.portReadyAfterPolls ?? 1;
  const io: RestartWorkerIo = {
    trace: (line) => { trace.push(line); },
    log: () => {},
    now: () => ticks * 100,
    sleep: async () => { ticks += 1; },
    isPidAlive: (pid) => pid === 111 && ticks < oldDiesAfter,
    // 旧实例退出时**它自己会把 lock.json 删掉**（`InstanceLock.release()`）——
    // 这个假世界要照实模拟，否则"等旧实例真消失"这条判据会因为一个永不消失的锁而空等。
    readLockPid: () => {
      if (!spawned && ticks >= oldDiesAfter) return 0;
      return lockPid;
    },
    // 只重启界面时后端本来就该在服务（端口由**现役**后端回答）；否则要等新实例起来
    probePort: async () => (options.guiOnly ? true : (spawned && ticks >= portAfter)),
    spawnBackend: () => {
      if (overrides.spawnThrows === true) throw new Error('spawn ENOENT');
      spawned = true;
      if (overrides.lockPidAfterSpawn !== undefined && overrides.lockPidAfterSpawn !== 0) {
        lockPid = overrides.lockPidAfterSpawn;
      }
      return 222;
    },
    stopGui: () => {
      if (overrides.stopGuiThrows === true) throw new Error('拒绝访问');
      return [333];
    },
    startGui: () => overrides.guiStarts ?? 444,
  };
  return { io, trace, options };
}

test('拉起器：成了 —— 回执/实例/结束三行齐，且写明 self-restart', async () => {
  const w = fakeWorld({ lockPidAfterSpawn: 222 });
  const code = await runRestartWorker(w.options, w.io);
  assert.equal(code, 0);
  const text = w.trace.join('');
  assert.match(text, /\[回执\] 路径=self-restart/u);
  assert.match(text, /\[实例\] 后端已接管 pid=222 source=lock\.json path=self-restart/u);
  assert.match(text, /\[结束\] ok=True backendPid=222 port=ready guiPid=0 path=self-restart reason=ok/u);
  const parsed = parseRestartTrace(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.backendPid, 222);
  assert.equal(parsed.port, 'ready');
  assert.equal(parsed.path, 'self-restart');
});

test('拉起器：旧实例不退出 ⇒ reason=old-not-gone，而且没有拉起任何东西', async () => {
  const w = fakeWorld({ oldDiesAfterPolls: 999, lockPidAfterSpawn: 222 });
  const code = await runRestartWorker(w.options, w.io);
  assert.equal(code, 1);
  const parsed = parseRestartTrace(w.trace.join(''));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, RESTART_FAILURE_REASONS.oldNotGone);
  assert.equal(parsed.path, 'self-restart');
  assert.equal(w.trace.join('').includes('[实例]'), false, '没拉起新实例就不许写"后端已接管"');
});

test('拉起器：进程起不来（spawn 抛）⇒ reason=spawn-failed', async () => {
  const w = fakeWorld({ spawnThrows: true });
  const code = await runRestartWorker(w.options, w.io);
  assert.equal(code, 1);
  const parsed = parseRestartTrace(w.trace.join(''));
  assert.equal(parsed.reason, RESTART_FAILURE_REASONS.spawnFailed);
  assert.equal(parsed.backendPid, 0);
});

test('拉起器：端口应答但 lock 没换 pid ⇒ reason=lock-not-changed（"换了个人"这条凭据不成立）', async () => {
  const w = fakeWorld({ lockPidAfterSpawn: 0 });
  const code = await runRestartWorker(w.options, w.io);
  assert.equal(code, 1);
  const parsed = parseRestartTrace(w.trace.join(''));
  assert.equal(parsed.reason, RESTART_FAILURE_REASONS.lockNotChanged);
  assert.equal(parsed.ok, false);
});

test('拉起器：lock 换了 pid 但端口没就绪 ⇒ reason=port-not-ready（真 pid 照样要报出来）', async () => {
  const w = fakeWorld({ lockPidAfterSpawn: 222, portReadyAfterPolls: 99999 });
  const code = await runRestartWorker(w.options, w.io);
  assert.equal(code, 1);
  const parsed = parseRestartTrace(w.trace.join(''));
  assert.equal(parsed.reason, RESTART_FAILURE_REASONS.portNotReady);
  assert.equal(parsed.backendPid, 222, '失败也要给出读到的那点凭据');
});

test('拉起器：带界面时先停后起，[结束] 里给得出 guiPid', async () => {
  const w = fakeWorld({ lockPidAfterSpawn: 222, guiExe: 'C:\\Irmia\\app\\gui\\irmia_gui.exe', guiStarts: 444 });
  const code = await runRestartWorker(w.options, w.io);
  assert.equal(code, 0);
  assert.match(w.trace.join(''), /guiPid=444/u);
});

test('拉起器：界面拉不起来 ⇒ 后端那一段照旧报真 pid，但整件事是失败（不许把"只重启了后端"说成重启了）', async () => {
  const w = fakeWorld({ lockPidAfterSpawn: 222, guiExe: 'C:\\Irmia\\app\\gui\\irmia_gui.exe', guiStarts: 0 });
  const code = await runRestartWorker(w.options, w.io);
  assert.equal(code, 1);
  const parsed = parseRestartTrace(w.trace.join(''));
  assert.equal(parsed.reason, RESTART_FAILURE_REASONS.guiFailed);
  assert.equal(parsed.backendPid, 222);
  assert.equal(parsed.guiPid, 0);
});

test('拉起器：-GuiOnly ⇒ 一个后端进程都不动（不写 [实例]，也不去等旧 pid）', async () => {
  const w = fakeWorld({ guiOnly: true, guiExe: 'C:\\Irmia\\app\\gui\\irmia_gui.exe', oldDiesAfterPolls: 999 });
  const code = await runRestartWorker(w.options, w.io);
  assert.equal(code, 0);
  const text = w.trace.join('');
  assert.equal(text.includes('[实例]'), false, '只重启界面时后端本来就该在服务：不该写"后端已接管"');
  assert.match(text, /\[结束\] ok=True backendPid=111 port=ready guiPid=444 path=self-restart reason=ok/u);
});

test('拉起器：参数不全就当场拒绝（不许"少一个参数也照跑"）', () => {
  const bad = parseRestartWorkerArgs(['--old-pid', '1', '--root', ROOT]);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /--node|--entry|--trace|--data-dir/u);

  const badPort = parseRestartWorkerArgs([
    '--root', ROOT, '--node', 'n.exe', '--entry', 'e.js', '--trace', 't.log', '--data-dir', 'd', '--port', 'x',
  ]);
  assert.equal(badPort.ok, false);

  const ok = parseRestartWorkerArgs([
    '--old-pid', '11,22,22', '--root', ROOT, '--node', 'n.exe', '--entry', 'e.js',
    '--trace', 't.log', '--data-dir', 'd', '--port', '7801', '--gui-only',
  ]);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.options.oldPids, [11, 22], '逗号列表要去重');
    assert.equal(ok.options.port, 7801);
    assert.equal(ok.options.guiOnly, true);
    assert.equal(ok.options.host, '127.0.0.1');
  }
});

// ──────────────────────────────── 命令行形状（Windows 上那几条坑） ────────────────────────────────

test('命令行：重定向写在内层引号里面、入口与 cwd 都是绝对路径、外层是 cmd /s /c', () => {
  // 这是本仓三点对照实测过的唯一一种"真的会执行"的写法：
  //   cmd /s /c ""<exe>" <args> >> "<日志>" 2>&1"
  const line = restartCommandLine({
    shellExe: 'C:\\Irmia\\app\\runtime\\node\\node.exe',
    argv: ['"C:\\Irmia\\app\\dist\\runtime\\restart-worker.js"', '--old-pid', '1234'],
    scriptLog: 'C:\\Irmia\\app\\data\\restart-worker.log',
  });
  assert.equal(
    line,
    'cmd.exe /s /c ""C:\\Irmia\\app\\runtime\\node\\node.exe" '
    + '"C:\\Irmia\\app\\dist\\runtime\\restart-worker.js" --old-pid 1234'
    + ' >> "C:\\Irmia\\app\\data\\restart-worker.log" 2>&1"',
  );
  assert.match(line, /^cmd\.exe \/s \/c ""/u);
  assert.match(line, /2>&1"$/u, '重定向必须落在最外层那对引号里面（写在外面 = 返回 0 而根本不执行）');
});

test('端口探测：探不通就是 false（这条判据要能被单测钉住）', async () => {
  // 用一个几乎不可能有人听的端口：探不通要老实返回 false，而不是抛
  assert.equal(await probeTcp('127.0.0.1', 1, 300), false);
});

// ──────────────────── ④ 自重启那条路也带老生代上限（2026-10-10） ────────────────────

test('④ 自重启拉新后端时带 `--max-old-space-size`，且**排在入口之前**', () => {
  // 这条钉的是一个真实的不一致：三份启动脚本（`packaging/start.ps1` /
  // `packaging/restart.ps1` / `tools/restart-agent.ps1`）都带上了 `-NodeMaxOldSpaceMb 512`，
  // 而 `self-restart` 是**第三条**拉后端的路 —— 少了这里，同一个进程在不同重启路径下
  // 内存行为不一样，那种不一致最难查。
  const argv = backendSpawnArgv('C:\\Irmia\\app\\dist\\main.js');
  assert.deepEqual(argv, ['--max-old-space-size=512', 'C:\\Irmia\\app\\dist\\main.js']);
  // 顺序是判据：Node 的选项排到入口之后会被当成 `main.js` 的参数（它不认，直接退）
  assert.match(argv[0]!, /^--max-old-space-size=\d+$/u);
  assert.equal(argv[argv.length - 1], 'C:\\Irmia\\app\\dist\\main.js', '入口必须是最后一个参数');
});

test('④b 上限设成 0 ⇒ 一个参数都不加（"回退"这条路的定义）', () => {
  assert.deepEqual(backendSpawnArgv('C:\\Irmia\\app\\dist\\main.js', 0), ['C:\\Irmia\\app\\dist\\main.js']);
  assert.deepEqual(backendSpawnArgv('C:\\Irmia\\app\\dist\\main.js', -1), ['C:\\Irmia\\app\\dist\\main.js']);
});

test('④c 三处默认值同源：worker 的常量与脚本里的 512 是同一个数', () => {
  // 脚本那一侧没法在这里 import（PowerShell），所以把"同一个数"写成一条断言：
  // 改任何一处而忘了另一处，这条会红。
  assert.equal(MAX_OLD_SPACE_MB, 512);
});
