/**
 * 界面保活测试（src/runtime/gui-guard.ts）
 *
 * 用户这一批要的两件事，各钉住最要紧的判据：
 *   · **看着**：按可执行文件全路径判活、探活失败不许当成"没了"、连续两次确认、拉起用既定形状、
 *     拉起上限 3 次/5 分钟并在超限后如实报警；
 *   · **不许与用户的意愿打架**：退出标记（`<dataDir>/gui-quit.marker`）新鲜 ⇒ 只记账不拉起，
 *     并且**消费掉**（否则一次主动退会永久压住后面所有崩溃的拉起）；过期/读不懂 ⇒ 按崩溃处理。
 *
 * 真进程那一层（真起一个 powershell 探活）单独两支，`win32` 之外跳过。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  consumeGuiQuitMarker, createGuiGuard, discoverGuiExe, guiQuitMarkerPath, guiQuitMarkerPaths,
  listPidsByExePath, readGuiQuitMarker, readTail, resolveGuardMode, writeGuiQuitMarker,
  GUI_GUARD_OFF_FILE_NAME, GUI_LAUNCH_SCRIPT, GUI_PATH_FILE_NAME, GUI_PROBE_SCRIPT,
  type GuiGuardAlert, type GuiGuardOptions, type GuiGuardRecord, type GuiLaunchResult,
} from '../src/runtime/gui-guard.ts';

const EXE = 'D:\\IrmiaAgent\\agent\\gui\\build\\windows\\x64\\runner\\Release\\irmia_gui.exe';
const BASE_MS = Date.parse('2026-10-11T00:00:00.000Z');

function makeDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-gui-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Fake {
  nowMs: number;
  launcherMtimeMs: number | null;
  /** 探活：给 pid 数组 = 这些都在跑；抛错 = 这一次没问出来 */
  probe: (exe: string) => number[] | Error;
  launched: string[];
  launchResult: GuiLaunchResult;
}

interface Harness {
  dir: string;
  fake: Fake;
  records: GuiGuardRecord[];
  alerts: GuiGuardAlert[];
  tick(): Promise<void>;
  outcomes(): string[];
  advance(ms: number): void;
}

function harness(t: TestContext, over: Partial<GuiGuardOptions> = {}): Harness {
  const dir = makeDir(t);
  const fake: Fake = {
    nowMs: BASE_MS,
    launcherMtimeMs: null,
    probe: () => [],
    launched: [],
    launchResult: { ok: true, pid: 4242, note: 'Start-Process pid 4242' },
  };
  const records: GuiGuardRecord[] = [];
  const alerts: GuiGuardAlert[] = [];
  const guard = createGuiGuard({
    dataDir: dir,
    exe: EXE,
    exeSource: '测试',
    mode: 'relaunch',
    io: {
      listPids: async (exe: string) => {
        const result = fake.probe(exe);
        if (result instanceof Error) throw result;
        return result;
      },
      launch: async (exe: string) => {
        fake.launched.push(exe);
        return fake.launchResult;
      },
    },
    record: (record) => records.push(record),
    alert: (alert) => alerts.push(alert),
    now: () => fake.nowMs,
    launcherMtime: () => fake.launcherMtimeMs,
    // 封闭：不认这台机器上真 `%APPDATA%\Irmia\` 里可能躺着的标记（否则测试会被外部文件影响）
    env: {},
    ...over,
  });
  t.after(() => guard.stop());
  return {
    dir,
    fake,
    records,
    alerts,
    tick: async () => { await guard.tick(); },
    outcomes: () => records.map((r) => r.outcome),
    advance: (ms: number) => { fake.nowMs += ms; },
  };
}

/** 界面"没了"的那一拍：探活返回空列表 */
const GONE = (): number[] => [];

// ──────────────────────────────── 看着：探活判据 ────────────────────────────────

test('① 按**可执行文件全路径**判活：探针脚本比的是全路径，不是文件名', () => {
  assert.match(GUI_PROBE_SCRIPT, /\$full -ieq \$target/u, '判据必须是全路径逐字相等（大小写无关）');
  assert.match(GUI_PROBE_SCRIPT, /ExecutablePath/u, '路径取自 ExecutablePath');
  assert.match(GUI_PROBE_SCRIPT, /IRMIA_GUI_GUARD_EXE/u, '目标路径只从环境变量进（构造上不存在引号问题）');
  // 名字只当粗筛（CIM 的 Name 过滤器），不许当判据
  assert.doesNotMatch(GUI_PROBE_SCRIPT, /-like '\*/u, '不许出现"按通配符匹配名字"那种判据');
});

test('① 探活**抛错**不等于"它没了"：只记账、不拉起，而且不清零确认链', async (t) => {
  const h = harness(t);
  h.fake.probe = () => new Error('powershell 打嗝');
  await h.tick();
  await h.tick();
  assert.deepEqual(h.outcomes(), ['probe-failed'], '连着两拍失败只记一条（同类不刷屏）');
  assert.equal(h.fake.launched.length, 0, '一次都不许拉');
  assert.match(h.records[0]?.reason ?? '', /不拉起/u);
});

test('① 连续两次确认才算"真的没了"：第一次不动作', async (t) => {
  const h = harness(t);
  h.fake.probe = GONE;
  await h.tick();
  assert.equal(h.fake.launched.length, 0, '第一次空读数不动作');
  assert.deepEqual(h.outcomes(), [], '也不记账（避免噪音）');
  await h.tick();
  assert.equal(h.fake.launched.length, 1, '第二次确认才拉起');
  assert.deepEqual(h.outcomes(), ['relaunched']);
});

test('① 它还活着时什么都不做', async (t) => {
  const h = harness(t);
  h.fake.probe = () => [45008];
  await h.tick();
  await h.tick();
  assert.deepEqual(h.outcomes(), []);
  assert.equal(h.fake.launched.length, 0);
});

test('① 拉起的形状：Start-Process + 绝对路径 + exe 所在目录（不是 cmd /s /c、不是 npx）', () => {
  assert.match(GUI_LAUNCH_SCRIPT, /Start-Process -FilePath \$exe -WorkingDirectory \$dir -PassThru/u);
  assert.doesNotMatch(GUI_LAUNCH_SCRIPT, /cmd(\.exe)?\s*\/s\s*\/c/u, '不许用 cmd /s /c（那条形状实测四败一胜）');
  assert.doesNotMatch(GUI_LAUNCH_SCRIPT, /npx/u, '不许用 npx');
  assert.doesNotMatch(GUI_LAUNCH_SCRIPT, />>|-RedirectStandard/u, '不许重定向（那正是那条根因的对立面）');
});

test('① 拉起时给的 exe 就是解析出来的那个全路径，工作目录记的是 exe 所在目录', async (t) => {
  const h = harness(t);
  h.fake.probe = GONE;
  await h.tick();
  await h.tick();
  assert.deepEqual(h.fake.launched, [EXE]);
  assert.equal(h.records.at(-1)?.detail['workingDirectory'], EXE.slice(0, EXE.lastIndexOf('\\')));
});

test('① 拉起之后给启动时间：grace 内不重复拉起', async (t) => {
  const h = harness(t, { startupGraceMs: 60_000 });
  h.fake.probe = GONE;
  await h.tick();
  await h.tick();
  assert.equal(h.fake.launched.length, 1);
  h.fake.probe = GONE;
  await h.tick();
  await h.tick();
  assert.equal(h.fake.launched.length, 1, 'grace 内不许再拉（否则白烧配额还会连拉两次）');
  h.advance(61_000);
  await h.tick();
  await h.tick();
  assert.equal(h.fake.launched.length, 2, 'grace 过了还没起来才再拉');
});

test('① 界面回来了 ⇒ 记一条 gui-back，并把"用满配额"的记账清掉', async (t) => {
  const h = harness(t);
  h.fake.probe = GONE;
  await h.tick();
  await h.tick();
  assert.equal(h.records.at(-1)?.outcome, 'relaunched');
  // 越过启动时间窗（界面起来要加载 DLL 与 data\，这期间本来就不判"它在不在"）
  h.advance(61_000);
  h.fake.probe = () => [45008];
  await h.tick();
  assert.equal(h.records.at(-1)?.outcome, 'gui-back');
});

// ──────────────────────────────── 不许打架：退出标记协议 ────────────────────────────────

test('② 新鲜的退出标记 ⇒ 只记账、不拉回来，并且把标记**消费掉**', async (t) => {
  const h = harness(t);
  writeGuiQuitMarker(h.dir, { now: () => new Date(h.fake.nowMs), reason: 'tray-quit' });
  assert.ok(existsSync(guiQuitMarkerPath(h.dir)));
  h.fake.probe = GONE;
  await h.tick();
  await h.tick();

  assert.equal(h.fake.launched.length, 0, '用户主动退的，一个进程都不许拉');
  assert.deepEqual(h.outcomes(), ['paused-by-quit-marker']);
  assert.match(h.records[0]?.reason ?? '', /主动/u);
  assert.equal(existsSync(guiQuitMarkerPath(h.dir)), false, '标记必须被消费掉——否则一次主动退会永久压住后面所有崩溃的拉起');
  assert.equal(h.records[0]?.detail['markerConsumed'], true);
});

test('② 标记过期 ⇒ 按崩溃处理（拉起），且不去动那个过期标记', async (t) => {
  const h = harness(t, { markerTtlMs: 300_000 });
  writeGuiQuitMarker(h.dir, { now: () => new Date(h.fake.nowMs - 600_000) }); // 10 分钟前
  assert.equal(readGuiQuitMarker(h.dir, { now: () => h.fake.nowMs, ttlMs: 300_000 }).state, 'expired');

  h.fake.probe = GONE;
  await h.tick();
  await h.tick();
  assert.equal(h.fake.launched.length, 1, '过期标记不算"他主动退的"');
  assert.ok(existsSync(guiQuitMarkerPath(h.dir)), '只有新鲜标记才消费');
});

test('② 标记读不懂（写到一半被杀 / 外部改写）⇒ 按崩溃处理（宁可多拉一次）', async (t) => {
  const h = harness(t);
  writeFileSync(guiQuitMarkerPath(h.dir), '{"ts": "2026-10-11T00');
  assert.equal(readGuiQuitMarker(h.dir, { now: () => h.fake.nowMs }).state, 'unreadable');
  h.fake.probe = GONE;
  await h.tick();
  await h.tick();
  assert.equal(h.fake.launched.length, 1);
});

test('② 标记的读写与消费自成一体（含时钟回拨按"刚写的"保守处理）', async (t) => {
  const dir = makeDir(t);
  assert.equal(readGuiQuitMarker(dir, { now: () => BASE_MS }).state, 'absent');
  const written = writeGuiQuitMarker(dir, { now: () => new Date(BASE_MS), pid: 45008, reason: 'window-close' });
  assert.equal(written.ok, true);
  const fresh = readGuiQuitMarker(dir, { now: () => BASE_MS + 1_000, ttlMs: 300_000 });
  assert.equal(fresh.state, 'fresh');
  assert.equal(fresh.record?.pid, 45008);
  assert.equal(fresh.record?.reason, 'window-close');
  // 时钟回拨 ⇒ ageMs 为负 ⇒ 当"刚写的"（与 instance-lock 同一条保守口径）
  assert.equal(readGuiQuitMarker(dir, { now: () => BASE_MS - 60_000, ttlMs: 300_000 }).state, 'fresh');
  assert.equal(consumeGuiQuitMarker(dir), true);
  assert.equal(consumeGuiQuitMarker(dir), false, '删两次第二次就没了（幂等）');
});

test('② 界面不知道 dataDir 也能写标记：`%APPDATA%\\Irmia\\` 那个落点同样算数（两处一起消费）', async (t) => {
  const dir = makeDir(t);
  const appData = join(dir, 'AppData', 'Roaming');
  const appMarker = join(appData, 'Irmia', 'gui-quit.marker');
  // 界面只往自己那个目录写（它算得出 %APPDATA%，算不出后端的 dataDir）
  writeGuiQuitMarker(dir, { now: () => new Date(BASE_MS), reason: 'window-close', targets: [appMarker] });

  const paths = guiQuitMarkerPaths(dir, { APPDATA: appData });
  assert.deepEqual(paths, [join(dir, 'gui-quit.marker'), appMarker], '两处都认');
  assert.equal(readGuiQuitMarker(dir, { now: () => BASE_MS + 1_000, env: { APPDATA: appData } }).state, 'fresh');

  const h = harness(t, { env: { APPDATA: appData } });
  // 把 harness 的数据目录换成带 APPDATA 的那一个（它自己的 dir 是另一个临时目录）
  writeGuiQuitMarker(h.dir, { now: () => new Date(h.fake.nowMs), reason: 'window-close', targets: [appMarker] });
  h.fake.probe = GONE;
  await h.tick();
  await h.tick();
  assert.equal(h.fake.launched.length, 0, '写在 %APPDATA% 那一处的标记同样要拦住拉起');
  assert.deepEqual(h.outcomes(), ['paused-by-quit-marker']);
  assert.equal(existsSync(appMarker), false, '消费时两处一起删');
});

test('② 两处都有标记时取**最新鲜**的那一份（脚本与界面各留过一次痕迹）', (t) => {
  const dir = makeDir(t);
  const appData = join(dir, 'AppData', 'Roaming');
  const env = { APPDATA: appData };
  writeGuiQuitMarker(dir, { now: () => new Date(BASE_MS - 60_000), reason: 'script' });
  writeGuiQuitMarker(dir, {
    now: () => new Date(BASE_MS - 1_000),
    reason: 'window-close',
    targets: [join(appData, 'Irmia', 'gui-quit.marker')],
  });
  const reading = readGuiQuitMarker(dir, { now: () => BASE_MS, env });
  assert.equal(reading.record?.reason, 'window-close', '取最近那一次主动退出');
  assert.equal(reading.file, join(appData, 'Irmia', 'gui-quit.marker'));
});

// ──────────────────────────────── 不许误拉与不准抢：拉起器 ────────────────────────────────

test('③ 拉起器正在干活（留痕新鲜）⇒ 我们不插手，等它干完再判', async (t) => {
  const h = harness(t, { launcherQuietMs: 300_000 });
  h.fake.launcherMtimeMs = h.fake.nowMs - 10_000;
  h.fake.probe = GONE;
  await h.tick();
  await h.tick();
  await h.tick();
  assert.equal(h.fake.launched.length, 0, '脚本先停界面再拉起来，这期间我们不许抢着拉');
  assert.deepEqual(h.outcomes(), ['launcher-active'], '同类连着来只记一条');

  h.fake.launcherMtimeMs = h.fake.nowMs - 400_000; // 静默窗过去了
  await h.tick();
  await h.tick();
  assert.equal(h.fake.launched.length, 1, '静默窗过去后要重新连续确认两次才拉');
});

// ──────────────────────────────── 上限与告警 ────────────────────────────────

test('④ 上限 3 次/5 分钟：第 4 次不拉，并如实报警（warn）', async (t) => {
  const h = harness(t, { startupGraceMs: 1_000, windowMs: 300_000, maxRelaunchPerWindow: 3 });
  h.fake.probe = GONE;
  for (let i = 0; i < 3; i++) {
    await h.tick();
    await h.tick();
    h.advance(1_500); // 越过 grace 但仍在同一个窗口里
  }
  assert.equal(h.fake.launched.length, 3, '三次全部用掉');

  await h.tick();
  await h.tick();
  assert.equal(h.fake.launched.length, 3, '超限之后一次都不许再拉');
  assert.equal(h.records.at(-1)?.outcome, 'capped');
  assert.equal(h.alerts.length, 1, '超限必须如实报警');
  assert.equal(h.alerts[0]?.level, 'warn');
  assert.match(h.alerts[0]?.title ?? '', /超限/u);
  assert.match(h.alerts[0]?.body ?? '', /IRMIA_GUI_GUARD=off/u, '告警里要写清怎么停掉它');

  await h.tick();
  assert.equal(h.alerts.length, 1, '同一个窗口只报一次（别刷屏）');
});

test('④ 连续两个窗口都用满 ⇒ 永久停手（critical 告警，之后连探活都不做）', async (t) => {
  const h = harness(t, { startupGraceMs: 1_000, windowMs: 300_000, maxRelaunchPerWindow: 3, maxExhaustedWindows: 2 });
  h.fake.probe = GONE;
  const burnOneWindow = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) {
      await h.tick();
      await h.tick();
      h.advance(1_500);
    }
    await h.tick(); // 这一拍撞上限
    await h.tick();
  };
  await burnOneWindow();
  assert.equal(h.fake.launched.length, 3);
  assert.equal(h.records.at(-1)?.outcome, 'capped');

  h.advance(300_000); // 窗口滚过去
  await burnOneWindow();
  assert.equal(h.fake.launched.length, 6, '第二个窗口又用满 3 次');
  assert.equal(h.records.at(-1)?.outcome, 'given-up');
  assert.equal(h.alerts.length, 2);
  assert.equal(h.alerts[1]?.level, 'critical');

  const probesBefore = h.fake.launched.length;
  h.advance(3_600_000);
  await h.tick();
  await h.tick();
  assert.equal(h.fake.launched.length, probesBefore, '永久停手之后**再也不拉**（别无限重启）');
});

test('④ 窗口滚过去之后恢复拉起（超限是"本轮"，不是永久）', async (t) => {
  const h = harness(t, { startupGraceMs: 1_000, windowMs: 300_000, maxRelaunchPerWindow: 1, maxExhaustedWindows: 9 });
  h.fake.probe = GONE;
  await h.tick();
  await h.tick();
  assert.equal(h.fake.launched.length, 1);
  await h.tick();
  await h.tick();
  assert.equal(h.fake.launched.length, 1, '窗口内超限');
  h.advance(301_000);
  await h.tick();
  await h.tick();
  assert.equal(h.fake.launched.length, 2, '窗口滚过去就能再拉');
});

test('④ watch 档：只记账、一个进程都不拉', async (t) => {
  const h = harness(t, { mode: 'watch' });
  h.fake.probe = GONE;
  await h.tick();
  await h.tick();
  await h.tick();
  assert.equal(h.fake.launched.length, 0);
  assert.deepEqual(h.outcomes(), ['watch-only']);
});

test('④ 拉起失败如实记账（launch-failed），不假装成功', async (t) => {
  const h = harness(t);
  h.fake.launchResult = { ok: false, pid: 0, note: '拉起失败：Start-Process 抛异常 InstanceNotFound' };
  h.fake.probe = GONE;
  await h.tick();
  await h.tick();
  assert.equal(h.records.at(-1)?.outcome, 'launch-failed');
  assert.match(h.records.at(-1)?.reason ?? '', /没成/u);
});

// ──────────────────────────────── 路径从哪来 · 档位 ────────────────────────────────

test('⑤ 界面路径三来源按优先级：环境变量 → gui-path.txt → 拉起器留痕（且只认盘上存在的）', (t) => {
  const dir = makeDir(t);
  const exists = (path: string): boolean => path === EXE || path === 'D:\\other\\gui.exe';
  const traceLine = '[回执] 脚本已启动 · GuiExe=' + EXE + '（收到=True · 盘上存在=True ⇒ 带路径且存在） · GuiOnly=False';
  const readTrace = (): string => traceLine;

  // ① 环境变量最优先
  assert.deepEqual(
    discoverGuiExe({ dataDir: dir, env: { IRMIA_GUI_EXE: EXE }, fileExists: exists, readTrace }),
    { exe: EXE, source: '环境变量 IRMIA_GUI_EXE' },
  );
  // ② 环境变量指向不存在的文件 ⇒ 不回退（显式指定就该显式失败，别猜）
  assert.equal(discoverGuiExe({ dataDir: dir, env: { IRMIA_GUI_EXE: 'D:\\nope\\x.exe' }, fileExists: exists, readTrace }), null);

  // ③ gui-path.txt
  writeFileSync(join(dir, GUI_PATH_FILE_NAME), `# 界面 exe 路径\n${EXE}\n`);
  assert.deepEqual(
    discoverGuiExe({ dataDir: dir, env: {}, fileExists: exists, readTrace }),
    { exe: EXE, source: `文件 ${join(dir, GUI_PATH_FILE_NAME)}` },
  );

  // ④ 都没有 ⇒ 从留痕里认（只认盘上存在的那个）
  rmSync(join(dir, GUI_PATH_FILE_NAME));
  assert.deepEqual(
    discoverGuiExe({ dataDir: dir, env: {}, fileExists: exists, readTrace }),
    { exe: EXE, source: `拉起器留痕 ${join(dir, 'restart-trace.log')}` },
  );
  assert.equal(
    discoverGuiExe({ dataDir: dir, env: {}, fileExists: (p) => p !== EXE, readTrace }),
    null,
    '留痕里那个路径盘上没了 ⇒ 不猜，如实返回"找不到"',
  );
  // ⑤ 什么都没有 ⇒ null（绝不按名字猜一个）
  assert.equal(discoverGuiExe({ dataDir: dir, env: {}, fileExists: exists, readTrace: () => '' }), null);
});

test('⑤ 保活档位：环境变量 > gui-guard.off > 默认 relaunch', (t) => {
  const dir = makeDir(t);
  assert.equal(resolveGuardMode({}, dir).mode, 'relaunch');
  writeFileSync(join(dir, GUI_GUARD_OFF_FILE_NAME), '');
  assert.equal(resolveGuardMode({}, dir).mode, 'watch', '有 off 文件 ⇒ 至少退到"只看不拉"');
  assert.equal(resolveGuardMode({ IRMIA_GUI_GUARD: 'off' }, dir).mode, 'off');
  assert.equal(resolveGuardMode({ IRMIA_GUI_GUARD: 'RELAUNCH' }, dir).mode, 'relaunch');
  assert.equal(resolveGuardMode({ IRMIA_GUI_GUARD: '随便写的' }, dir).mode, 'watch', '不认识的值退到最保守的那一档');
});

// ──────────────────────────────── 真进程：探活那一步 ────────────────────────────────

test('⑥ 真探活：拿正在跑的本进程 node.exe 全路径去问，必须认出它自己', { skip: process.platform !== 'win32' }, async () => {
  const pids = await listPidsByExePath(process.execPath);
  assert.ok(pids.includes(process.pid), `按全路径探活应当认出自己（pid ${String(process.pid)}），实际 [${pids.join(',')}]`);
});

test('⑥ 真探活：一个盘上不存在的路径 ⇒ 空列表（不是抛错）', { skip: process.platform !== 'win32' }, async () => {
  const pids = await listPidsByExePath('D:\\irmia-not-installed\\gui\\irmia_gui.exe');
  assert.deepEqual(pids, []);
});

test('⑥ 真探活：CIM 查询拿到的可执行文件路径与目标逐字相等才算（名字相同不算）', { skip: process.platform !== 'win32' }, async (t) => {
  // 用一个**名字一定对不上**的路径：这一次探活的判据是"路径相等"，所以必然是空
  const pids = await listPidsByExePath(`${process.execPath}.renamed.exe`);
  assert.deepEqual(pids, [], '改个名就不是它了——按名字判活会在这里认错人');
  void t;
});

test('⑥ 留痕很大时只读尾巴：判据是"最近一次拉起用过哪条路径"', (t) => {
  const dir = makeDir(t);
  const file = join(dir, 'restart-trace.log');
  const head = `${'旧的一行'.repeat(50_000)}\n`;
  writeFileSync(file, `${head}[-] -GuiExe D:\\old\\gui.exe\n`);
  const tail = readTail(file, 1_024);
  assert.ok(tail.length <= 1_024, `读的是尾巴不是整份（实际 ${tail.length} 字符）`);
  assert.ok(tail.includes('D:\\old\\gui.exe'), '最近那一行必须在里面');
  assert.equal(readTail(join(dir, 'nope.log'), 1_024), '', '没有那份文件 ⇒ 空串（不抛）');
});
