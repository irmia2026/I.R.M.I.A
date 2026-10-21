/**
 * M4 守护与观测验收（docs/milestones.md M4-5 / M4-6 / M4-7，docs/design.md §4.8）
 *
 * 四件事，都是"无人值守"成立的前提：
 *   ① 守护不重复（M4-6）：真子进程 A 持锁运行中再拉起 B —— B 必须在锁处被拒、非零退出，
 *      且日志 seq 无重复。双写在这里是被**证明**不存在的，而不是被假设不存在的。
 *   ② 守护拉起与接管（M4-5）：SIGKILL 掉 A，锁文件留在盘上（守护场景的真实前状态），
 *      新实例起来后按 instance-lock 既有语义接管，写 instance/takeover{pid-gone}。
 *   ③ 守护脚本（M4-5 交付物）：Windows 计划任务 / systemd / launchd 三份样例含关键指令，
 *      且 Windows 脚本能被 PowerShell 真正解析通过（语法级验证，不只是 grep 关键字）。
 *   ④ status 五要素（M4-7）：水位 / 待办数 / 今日消耗 / 待确认数 / 锁信息，一个不少。
 *
 * 为什么必须真子进程：单实例锁的语义是"两个**进程**不能同时写同一份日志"。在同一进程里
 * mock 出来的第二实例连 pid 都是同一个，证明不了任何事。Windows 上 SIGKILL 落成
 * TerminateProcess，被杀进程退出码是 1 或 null，所以只断言"非 0 退出"，不比对信号名
 * （与 test/crash-injection.test.ts 同口径）。
 *
 * 说明：Node 的类型剥离不做 `.js` → `.ts` 映射，所以这里用显式 `.ts` 说明符导入源码。
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';

import { buildStatusReport, runCli, type CliIO } from '../src/cli.ts';
import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent } from '../src/log/types.ts';
import { LOCK_FILE_NAME } from '../src/runtime/instance-lock.ts';
import { EVENT_LOG_DIR_NAME } from '../src/runtime/recover.ts';
import { fold } from '../src/state/fold.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 常量与工具 ────────────────────────────────

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INSTANCE_SCRIPT = join(PROJECT_ROOT, 'test', 'fixtures', 'guardian-instance.ts');
/** 等待子进程完成启动编排的上限：node 冷启动 + 加载源码通常 < 2 秒 */
const READY_TIMEOUT_MS = 30_000;
/** 等待子进程自行退出的上限（第二个实例应当很快被锁挡回来） */
const EXIT_TIMEOUT_MS = 20_000;
/** 等待被强杀的 pid 从系统里消失的上限 */
const PID_RELEASE_TIMEOUT_MS = 10_000;
const POLL_MS = 25;

/** 锁文件内容（只读用途，缺字段就是没用） */
interface LockRecord {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
}

interface Spawned {
  child: ChildProcess;
  pid: number;
  stdout(): string;
  stderr(): string;
}

interface GuardianFixture {
  dir: string;
  dataDir: string;
  eventDir: string;
  events(): AppEvent[];
  lock(): LockRecord | null;
}

function makeFixture(t: TestContext): GuardianFixture {
  const dir = tempDirSync('irmia-guardian-');
  const dataDir = join(dir, 'data');
  const eventDir = join(dataDir, EVENT_LOG_DIR_NAME);
  mkdirSync(eventDir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

  return {
    dir,
    dataDir,
    eventDir,
    events: () => readEvents(eventDir),
    lock: () => {
      const path = join(dataDir, LOCK_FILE_NAME);
      if (!existsSync(path)) return null;
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as LockRecord;
      } catch {
        return null;
      }
    },
  };
}

/**
 * 读盘上的全部分片。主进程可能正在追加，末行读到一半会解析失败——跳过它，
 * 不影响"seq 是否重复"与"某 pid 是否写过事件"这两类判定（与 cli.ts 的只读扫描同口径）。
 */
function readEvents(eventDir: string): AppEvent[] {
  if (!existsSync(eventDir)) return [];
  const events: AppEvent[] = [];
  for (const name of readdirSync(eventDir).filter((n) => n.endsWith('.jsonl')).sort()) {
    let text: string;
    try {
      text = readFileSync(join(eventDir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line === '') continue;
      try {
        events.push(JSON.parse(line) as AppEvent);
      } catch {
        // 写了一半的尾行：忽略
      }
    }
  }
  return events;
}

function seqsOf(events: readonly AppEvent[]): number[] {
  return events.map((e) => e.seq);
}

/** seq 全域无重复：双写的决定性证据（两个实例各自从同一水位分配 seq 必然撞号） */
function assertSeqUnique(events: readonly AppEvent[]): void {
  const seqs = seqsOf(events);
  assert.equal(
    new Set(seqs).size, seqs.length,
    `日志 seq 出现重复（${seqs.length} 条事件 / ${new Set(seqs).size} 个不同 seq）：单实例锁失效，发生了双写`,
  );
}

function pidOfEvent(event: AppEvent): unknown {
  const data = event.data as Record<string, unknown> | null;
  return data === null || typeof data !== 'object' ? undefined : data['pid'];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 强杀：Windows 上 SIGKILL 即 TerminateProcess；taskkill 兜底清掉可能的进程树 */
function killHard(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 已经退出
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  }
}

/** 拉起一次真实编排（假循环：清掉密钥，测试不触网） */
function spawnInstance(fx: GuardianFixture, t: TestContext): Spawned {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // 没有密钥 → main.ts 走假循环；模型调用与"守护会不会双写"无关
  delete env['IRMIA_API_KEY'];
  env['IRMIA_DATA_DIR'] = fx.dataDir;

  const child = spawn(process.execPath, ['--experimental-strip-types', INSTANCE_SCRIPT], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  let out = '';
  let err = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { out += chunk; });
  child.stderr?.on('data', (chunk: string) => { err += chunk; });

  t.after(() => killHard(child));

  const pid = child.pid;
  assert.ok(pid !== undefined, '子进程必须拿到 pid');
  return { child, pid, stdout: () => out, stderr: () => err };
}

/** 等子进程自行退出，返回退出码 */
function waitExit(spawned: Spawned, timeoutMs: number = EXIT_TIMEOUT_MS): Promise<number | null> {
  const { child } = spawned;
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise<number | null>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`等待子进程 ${spawned.pid} 退出超时（${timeoutMs}ms）\n--- stderr ---\n${spawned.stderr()}`));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

/**
 * 等这个实例"真的起来了"：日志里出现属于它 pid 的 session/start。
 * 这个判据比"进程还活着"强得多——session/start 写在拿到锁之后，所以它出现
 * ⟺ 该实例已经持锁并且已经在写日志。
 */
async function waitForReady(spawned: Spawned, fx: GuardianFixture): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawned.child.exitCode !== null || spawned.child.signalCode !== null) {
      throw new Error(
        `实例 pid=${spawned.pid} 在写出 session/start 之前就退出了（exitCode=${String(spawned.child.exitCode)}）\n`
        + `--- stderr ---\n${spawned.stderr()}`,
      );
    }
    const ready = fx.events().some((e) => e.type === 'session/start' && pidOfEvent(e) === spawned.pid);
    if (ready) return;
    await delay(POLL_MS);
  }
  throw new Error(`等待实例 pid=${spawned.pid} 启动超时（${READY_TIMEOUT_MS}ms）\n--- stdout ---\n${spawned.stdout()}`);
}

/** 等被强杀的 pid 从系统里消失：pid 探活是接管判据的第一条，必须真的不在了 */
async function waitPidReleased(pid: number): Promise<void> {
  const deadline = Date.now() + PID_RELEASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await delay(POLL_MS);
  }
  assert.fail(`pid ${pid} 被强杀后 ${PID_RELEASE_TIMEOUT_MS}ms 内仍可探活，接管路径无法验证`);
}

// ──────────────────────────────── ① + ② 守护不重复与接管 ────────────────────────────────

test('M4-6 守护不重复：第二个实例在锁处被拒并非零退出，日志 seq 无重复（无双写）', async (t) => {
  const fx = makeFixture(t);

  const a = spawnInstance(fx, t);
  await waitForReady(a, fx);

  const beforeB = fx.events();
  assert.ok(beforeB.length > 0, '首个实例必须已经写下 session/start 等事件');
  assert.equal(fx.lock()?.pid, a.pid, '锁必须由首个实例持有');

  // 说明：第二个实例在拿锁**之前**会先跑配置加载与人格种子（main.ts 的启动顺序如此），
  // 那一步只写 data/persona/ 的模板文件，不碰事件日志——所以下面的判据全部围绕
  // 事件日志与锁文件：它们才是“双写”的定义域。

  // 守护把第二个实例拉起来了（计划任务兜底重启 / 手工 start）——它必须在锁处停下
  const b = spawnInstance(fx, t);
  const code = await waitExit(b);

  assert.notEqual(code, 0, `第二个实例必须非零退出，实际 ${String(code)}\n--- stdout ---\n${b.stdout()}`);
  assert.match(
    `${b.stderr()}${b.stdout()}`, /(单实例锁|启动失败)/u,
    `第二个实例必须明确报告被锁挡住\n--- stderr ---\n${b.stderr()}`,
  );

  const afterB = fx.events();
  assert.equal(fx.lock()?.pid, a.pid, '被拒的实例不得覆盖既有锁');
  assertSeqUnique(afterB);
  assert.ok(
    !afterB.some((e) => pidOfEvent(e) === b.pid),
    `被拒实例一条事件都不该写，但日志里出现了属于 pid ${b.pid} 的事件`,
  );

  // 首个实例仍在正常工作：锁有效、水位不越过日志末尾
  assert.equal(a.child.exitCode, null, '首个实例不得因第二个实例的启动而受影响');
  const projection = fold(afterB);
  assert.ok(projection.watermark <= projection.lastSeq);

  killHard(a.child);
  await waitExit(a);
});

test('M4-5 守护拉起：锁文件保留而进程已死时，新实例正常接管并写 instance/takeover', async (t) => {
  const fx = makeFixture(t);

  const a = spawnInstance(fx, t);
  await waitForReady(a, fx);
  const pidA = a.pid;
  const seqAfterA = seqsOf(fx.events());

  // 崩溃前最后读一次锁文件的心跳：接管事件必须如实引用它
  const heartbeatBeforeCrash = fx.lock()?.heartbeatAt;
  assert.ok(heartbeatBeforeCrash !== undefined, '崩溃前锁文件必须可读');

  // 崩溃：SIGKILL 不给优雅退出的机会，所以锁文件留在盘上——这正是守护拉起的真实前状态
  killHard(a.child);
  await waitExit(a);
  await waitPidReleased(pidA);

  assert.equal(fx.lock()?.pid, pidA, 'SIGKILL 之后锁文件必须仍在（进程没机会 release）');

  const c = spawnInstance(fx, t);
  await waitForReady(c, fx);

  assert.match(
    `${c.stdout()}${c.stderr()}`, /已接管陈旧锁/u,
    `新实例必须报告接管\n--- stdout ---\n${c.stdout()}`,
  );

  const events = fx.events();
  const takeover = events.find((e) => e.type === 'instance/takeover');
  assert.ok(takeover !== undefined, '接管必须留下 instance/takeover 事件（schema §4.8）');
  const takeoverData = takeover.data as { previousPid: number; previousHeartbeatAt: string; staleBecause: string };
  assert.equal(takeoverData.previousPid, pidA, '接管记录必须如实引用前任 pid');
  assert.equal(takeoverData.staleBecause, 'pid-gone', '前任 pid 已不存在——确定性命据，不消耗接管宽限期');
  assert.equal(typeof takeoverData.previousHeartbeatAt, 'string');
  assert.ok(Number.isFinite(Date.parse(takeoverData.previousHeartbeatAt)), '接管记录必须带可解析的心跳时间');
  assert.ok(
    Date.parse(takeoverData.previousHeartbeatAt) >= Date.parse(heartbeatBeforeCrash),
    '接管记录的心跳必须来自前任实例（不早于崩溃前读到的值）',
  );

  // 接管者接着干活：它自己的 session/start 落在 takeover 之后，且锁归它
  const claim = events.find((e) => e.type === 'session/start' && pidOfEvent(e) === c.pid);
  assert.ok(claim !== undefined, '接管后的实例必须写下自己的 session/start');
  assert.ok(takeover.seq < claim.seq, 'instance/takeover 必须先于 session/start 落盘');
  assert.equal(fx.lock()?.pid, c.pid, '接管成功后锁归新实例');

  assertSeqUnique(events);
  assert.ok(seqsOf(events).length > seqAfterA.length, '接管是新增事件，不是改写历史');
  const projection = fold(events);
  assert.ok(projection.watermark <= projection.lastSeq);

  killHard(c.child);
  await waitExit(c);
});

// ──────────────────────────────── ③ 守护脚本静态验收 ────────────────────────────────

test('M4-5 交付物：三个平台的守护样例含关键指令（Windows 脚本可被 PowerShell 解析）', () => {
  const ps1Path = join(PROJECT_ROOT, 'scripts', 'install-windows-task.ps1');
  const unitPath = join(PROJECT_ROOT, 'scripts', 'irmia-agent.service');
  const plistPath = join(PROJECT_ROOT, 'scripts', 'com.google.irmia.agent.plist');

  const ps1 = readFileSync(ps1Path, 'utf8');
  const unit = readFileSync(unitPath, 'utf8');
  const plist = readFileSync(plistPath, 'utf8');

  // Windows 计划任务（design §4.8 的计划任务语义）：开机触发 + 失败 1 分钟重启 + node 跑 dist/main.js
  assert.match(ps1, /New-ScheduledTaskTrigger\s+-AtStartup/u, '必须有 AtStartup 触发');
  assert.match(ps1, /-RestartCount\s+999/u, '失败重启次数必须是 999');
  assert.match(ps1, /-RestartInterval\s*\(New-TimeSpan\s+-Minutes\s+1\)/u, '失败重启间隔必须是 1 分钟');
  assert.match(ps1, /-AllowStartIfOnBatteries/u, '必须允许电池供电时启动（无人值守笔记本）');
  assert.match(ps1, /Register-ScheduledTask/u, '必须真的注册计划任务');
  assert.match(ps1, /Unregister-ScheduledTask/u, '必须配套卸载');
  assert.match(ps1, /function Get-IrmiaAgentTaskStatus/u, '必须配套 status 查询函数');
  assert.match(ps1, /dist/u, '入口必须是编译产出 dist/main.js');
  assert.match(ps1, /main\.js/u, '入口必须是 main.js');
  assert.match(ps1, /-WorkingDirectory\s+\$Root/u, '工作目录必须是项目根');

  // Linux systemd（design §4.8 的三条硬指标）
  assert.match(unit, /^\s*Restart=always\s*$/mu, 'Restart=always');
  assert.match(unit, /^\s*RestartSec=5\s*$/mu, 'RestartSec=5');
  assert.match(unit, /^\s*StartLimitBurst=0\s*$/mu, 'StartLimitBurst=0（不限制重启次数）');
  assert.match(unit, /^\s*StandardOutput=journal\s*$/mu, '标准输出落 journal');
  assert.match(unit, /^\s*StandardError=journal\s*$/mu, '标准错误落 journal');
  assert.match(unit, /^\s*ExecStart=.*\bnode\b.*dist\/main\.js\s*$/mu, 'ExecStart 必须是 node dist/main.js');

  // macOS launchd（KeepAlive=true，且 Label 与文件名一致否则 launchctl 认不出来）
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.google\.irmia\.agent<\/string>/u, 'Label 必须与 plist 文件名一致');
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/u, 'KeepAlive 必须为 true');

  // 语法级验证：关键指令能写对，前提是整份脚本能被解析（grep 关键字挡不住语法错）
  const parsed = spawnSync('pwsh', [
    '-NoProfile', '-Command',
    `$errors = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile('${ps1Path.replace(/'/g, "''")}', [ref]$null, [ref]$errors); `
    + 'if ($errors.Count -gt 0) { $errors | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }; exit 1 } else { exit 0 }',
  ], { encoding: 'utf8' });
  if (parsed.error !== undefined) {
    // 没有 pwsh 就不做语法级验证（断言仍覆盖关键指令）
    assert.match(String(parsed.error), /ENOENT|not found/u);
  } else {
    assert.equal(parsed.status, 0, `PowerShell 解析失败：\n${parsed.stdout}${parsed.stderr}`);
  }
});

// ──────────────────────────────── ④ M4-7 status 五要素 ────────────────────────────────

const EPOCH_ISO = '2026-09-29T14:00:00.000Z';

/** 构造一份"有活干"的数据目录：一条待办、一笔今日消耗、一条待确认、一把有效的锁 */
async function seedStatusFixture(fx: GuardianFixture): Promise<void> {
  const log = await EventLog.open(fx.eventDir);
  try {
    const append = (type: string, data: unknown, visibility: string): number => {
      const seq = log.nextSeq();
      log.append({ seq, ts: EPOCH_ISO, type, data, visibility } as unknown as AppEvent, { sync: true });
      return seq;
    };

    append('wake/manual', { note: '守护验收' }, 'model');
    append('budget/consumed', {
      lane: 'heavy', model: 'deepseek-chat',
      inputTokens: 100, outputTokens: 50,
      cacheHitTokens: 80, cacheMissTokens: 20,
      durationMs: 5, retryCount: 0, finishReason: 'completed', tokensTodayAccum: 150,
    }, 'internal');
    const callSeq = append('tool/call', {
      turn: 1, step: 1, callId: 'c_m4', name: 'http_post', args: { url: 'https://example.invalid' }, sideEffect: 'destructive',
    }, 'model');
    append('tool/result', {
      turn: 1, step: 1, callId: 'c_m4', callSeq, status: 'unknown', content: 'Its outcome is unknown.',
    }, 'model');
  } finally {
    log.close();
  }

  // 一把有效的锁：pid 用测试进程自己，于是 status 的探活判定必然为"持有"
  writeFileSync(
    join(fx.dataDir, LOCK_FILE_NAME),
    `${JSON.stringify({ pid: process.pid, startedAt: EPOCH_ISO, heartbeatAt: EPOCH_ISO }, null, 2)}\n`,
  );
}

function collector(): { io: CliIO; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    io: { out: (line) => lines.push(line), err: (line) => errors.push(line) },
    lines,
    errors,
  };
}

test('M4-7 status 五要素：水位 / 待办数 / 今日消耗 / 待确认数 / 锁信息', async (t) => {
  const fx = makeFixture(t);
  await seedStatusFixture(fx);

  const report = await buildStatusReport(fx.dataDir);

  const { io, lines, errors } = collector();
  assert.equal(await runCli(['status'], io, { dataDir: fx.dataDir }), 0, errors.join('\n'));

  const text = lines.join('\n');
  // 逐要素断言（缺失即失败），且值必须对得上投影——不是"有这一行就行"
  assert.equal(report.watermark, 0, '水位停在最早一条待办之前');
  assert.ok(lines.some((line) => line.includes('水位: 0')), `缺水位\n${text}`);
  assert.equal(report.pending.total, 1);
  assert.ok(lines.some((line) => line.includes('待办 1')), `缺待办数\n${text}`);
  assert.equal(report.budget.tokensToday, 70, '今日消耗 = 最近一条 rollover 之后的 consumed 之和（非缓存口径：(100 − 80) + 50）');
  // 单位与口径统一（2026-10-05）：数字后面的单位词只有一处给（`format/units.ts` 的口径由
  // 调用点补），CLI status 与 budget 两行必须写同一个说法
  assert.ok(lines.some((line) => line.includes('今日非缓存消耗: 70 非缓存 token')), `缺今日消耗\n${text}`);
  assert.equal(report.needsReview, 1, 'unknown 的工具调用必须进待确认');
  assert.ok(lines.some((line) => line.includes('待确认 1')), `缺待确认数\n${text}`);
  assert.equal(report.lock.present, true);
  assert.equal(report.lock.pid, process.pid);
  assert.equal(report.lock.alive, true);
  assert.ok(lines.some((line) => line.includes(`锁: 持有者 pid ${process.pid}`)), `缺锁信息\n${text}`);

  // 分列口径（operations.md §6：今日消耗要 hit/miss 分列）
  // tokensToday* 走**非缓存口径**（2026-10-05）：(100 − 80) + 50 = 70；hit/miss 是原始分量，照旧
  assert.deepEqual(report.budget, {
    tokensToday: 70,
    tokensTodayHeavy: 70,
    tokensTodayLight: 0,
    cacheHitToday: 80,
    cacheMissToday: 20,
  });

  // --json 与人类可读输出同源：同一组字段，前端/脚本按同一份语义读
  const { io: jsonIo, lines: jsonLines } = collector();
  assert.equal(await runCli(['status', '--json'], jsonIo, { dataDir: fx.dataDir }), 0);
  const parsed = JSON.parse(jsonLines.join('\n')) as {
    watermark: number;
    pending: { total: number };
    budget: { tokensToday: number; cacheHitToday: number; cacheMissToday: number };
    needsReview: number;
    lock: { present: boolean; pid: number | null; alive: boolean | null };
  };
  assert.equal(parsed.watermark, 0);
  assert.equal(parsed.pending.total, 1);
  assert.equal(parsed.budget.tokensToday, 70);
  assert.equal(parsed.budget.cacheHitToday, 80);
  assert.equal(parsed.budget.cacheMissToday, 20);
  assert.equal(parsed.needsReview, 1);
  assert.equal(parsed.lock.present, true);
  assert.equal(parsed.lock.pid, process.pid);
  assert.equal(parsed.lock.alive, true);
});
