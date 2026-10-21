/**
 * CLI 观测命令与启动告警测试 — src/cli.ts 的 tail / review / budget 与 src/alert/startup.ts
 *
 * 覆盖 docs/operations.md §6 的 CLI 表（tail / review list / review resolve / budget 四行）、
 * docs/milestones.md M4 交付物 4 与 5、docs/design.md §4.9 触发点清单首条
 * （启动时发现上一次是非正常退出）。
 *
 * 三条测试纪律：
 *   1. 一个用例一个独立临时目录——`review resolve` 写日志、`recover` 拿锁都要求"没有第二个写者"，
 *      共用目录会让用例之间通过磁盘互相干扰（那类失败最难查）；
 *   2. 断言首选"日志里有什么"，其次才是命令输出文本：输出是给人看的，日志才是事实；
 *   3. 时间全部钉死在假时钟上——告警分片文件名（alarms/YYYY-MM-DD.log）与 30 分钟限流窗都依赖它。
 */

import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { ALERT_DIR_NAME, createNotifier, fingerprintOf, type AlertNotifier } from '../src/alert/notifier.ts';
import {
  interruptedRepairs, notifyStartupRecovery, notifyStartupRecoveryDetailed, restoreStartupAlertWindow,
} from '../src/alert/startup.ts';
import { buildReviewList, runCli, summarizeEvent, type CliContext, type CliIO } from '../src/cli.ts';
import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent } from '../src/log/types.ts';
import { defaultVisibility } from '../src/log/types.ts';
import { LOCK_FILE_NAME } from '../src/runtime/instance-lock.ts';
import { recover } from '../src/runtime/recover.ts';
import { fold } from '../src/state/fold.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const T0 = new Date('2026-02-14T10:00:00.000Z');
const DAY = '2026-02-14';

interface Fixture {
  dir: string;
  eventsDir: string;
  log: EventLog;
  /** 写一条事件（承诺类，与运行期同一纪律：落盘后才返回） */
  append: (type: string, data: unknown, ts?: string) => AppEvent;
  /** 关掉写句柄：CLI 的只读扫描与 resolve 都假定"主进程已停" */
  close: () => void;
}

async function setup(t: TestContext): Promise<Fixture> {
  const dir = tempDirSync('irmia-cli-observe-');
  const eventsDir = join(dir, 'events');
  const log = await EventLog.open(eventsDir);
  t.after(() => {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const append = (type: string, data: unknown, ts: string = T0.toISOString()): AppEvent => {
    const event = {
      seq: log.nextSeq(),
      ts,
      type,
      data,
      visibility: defaultVisibility(type),
      origin: 'test/cli-observe',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    return event;
  };

  return {
    dir,
    eventsDir,
    log,
    append,
    close: () => {
      log.close();
    },
  };
}

/** 读回日志全部事件（open→读→close；测试里没有第二个写者，安全） */
async function readAll(dir: string): Promise<AppEvent[]> {
  const log = await EventLog.open(join(dir, 'events'));
  try {
    const events: AppEvent[] = [];
    for await (const event of log.readAll()) events.push(event);
    return events;
  } finally {
    log.close();
  }
}

function collector(): { io: CliIO; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { io: { out: (line) => lines.push(line), err: (line) => errors.push(line) }, lines, errors };
}

/** 造一个"有活着的持有者"的锁文件：review resolve 必须据此拒绝写 */
function writeActiveLock(dir: string, pid: number): void {
  writeFileSync(
    join(dir, LOCK_FILE_NAME),
    JSON.stringify({ pid, startedAt: T0.toISOString(), heartbeatAt: T0.toISOString() }),
    'utf8',
  );
}

// ──────────────────────────────── tail ────────────────────────────────

test('cli tail：按类型前缀过滤，摘要压成一行并如实给出域', async (t) => {
  const fx = await setup(t);
  fx.append('wake/manual', { note: '起来看看\n第二行' });
  fx.append('turn/start', { turn: 1 });
  fx.append('tool/call', {
    turn: 1, step: 1, callId: 'call_1', name: 'http_post',
    arguments: '{"url":"https://example.test/x"}', sideEffect: 'destructive',
  });
  fx.append('tool/result', {
    turn: 1, step: 1, callId: 'call_1', callSeq: 3, status: 'ok', content: 'done',
  });
  fx.append('budget/consumed', {
    turn: 1, step: 1, lane: 'heavy', model: 'fake-heavy',
    inputTokens: 100, outputTokens: 20, cacheHitTokens: 80, cacheMissTokens: 20,
    durationMs: 5, retryCount: 0, finishReason: 'completed', tokensTodayAccum: 120,
  });
  fx.close();

  const all = collector();
  assert.equal(await runCli(['tail', '--limit', '3'], all.io, { dataDir: fx.dir }), 0);
  assert.match(all.lines[0]!, /日志尾部 3 条/);
  // 最后三条 = tool/call、tool/result、budget/consumed（tail 是尾部，不是头部）
  assert.match(all.lines[1]!, /tool\/call · http_post\(call_1\) \[destructive\] \{"url"/);
  assert.match(all.lines[2]!, /tool\/result · call_1 · ok/);
  assert.match(all.lines[3]!, /budget\/consumed · heavy 120 tok（in 100 \/ out 20 · hit 80 \/ miss 20）· completed/);
  assert.ok(all.lines.every((line) => !line.includes('\n')), '摘要必须压成单行，否则 tail 的行数不可信');

  // 域过滤：只留 tool/ 域的两条
  const tool = collector();
  assert.equal(await runCli(['tail', '--type', 'tool/', '--limit', '10'], tool.io, { dataDir: fx.dir }), 0);
  assert.match(tool.lines[0]!, /过滤 tool\/\*/);
  assert.equal(tool.lines.slice(1).length, 2);
  assert.ok(!tool.lines.some((line) => line.includes('turn/start')));
  assert.match(tool.lines[1]!, /call_1/);

  // 先过滤再凑数：`--type wake/ --limit 1` 给的是最近一条 wake 事件，不是"最近 1 条恰是 wake"
  const wake = collector();
  assert.equal(await runCli(['tail', '--type', 'wake/', '--limit', '1'], wake.io, { dataDir: fx.dir }), 0);
  assert.match(wake.lines[1]!, /手动唤醒：起来看看 ⏎ 第二行/);

  // 参数错误一律退出码 2，且不猜意图
  const bad = collector();
  assert.equal(await runCli(['tail', '--limit', '0'], bad.io, { dataDir: fx.dir }), 2);
  assert.equal(await runCli(['tail', '--limit', 'abc'], bad.io, { dataDir: fx.dir }), 2);
  assert.equal(await runCli(['tail', '--nope'], bad.io, { dataDir: fx.dir }), 2);
  assert.ok(bad.errors.some((line) => line.includes('--limit 必须是')));
});

test('cli tail：跳过无法解析的尾行并如实计数（主进程正追加时读到半行）', async (t) => {
  const fx = await setup(t);
  fx.append('turn/start', { turn: 1 });
  // 活动分片是延迟创建的：先写一条，才拿得到分片文件名
  const shard = fx.log.shardFiles[0]!;
  fx.close();
  // 模拟"写了一半就崩"的尾行：只读扫描不修复它，只把它算进 badLines
  appendFileSync(join(fx.eventsDir, shard), '{"seq":2,"ts":', 'utf8');

  const out = collector();
  assert.equal(await runCli(['tail', '--limit', '5'], out.io, { dataDir: fx.dir }), 0);
  assert.match(out.lines[0]!, /日志尾部 1 条/);
  assert.match(out.lines[1]!, /turn\/start · turn 1/);
  assert.ok(
    out.lines.some((line) => line.includes('跳过 1 行无法解析的内容')),
    out.lines.join('\n'),
  );
});

test('summarizeEvent：未知形状也不抛，退化成 JSON 摘要', () => {
  const fake = {
    seq: 9, ts: T0.toISOString(), type: 'future/unknown-thing',
    data: { a: 1 }, visibility: 'internal',
  } as unknown as AppEvent;
  assert.equal(summarizeEvent(fake), '{"a":1}');
});

test('summarizeEvent：turn/end 的 reasoningEcho 多一格，其余格式一字不动（v68）', () => {
  const turnEnd = (reason: Record<string, unknown>): AppEvent => ({
    seq: 9, ts: T0.toISOString(), type: 'turn/end',
    data: { turn: 3, reason, spoke: false }, visibility: 'internal', origin: 'test/cli',
  } as unknown as AppEvent);

  // 没有指纹时：与 v68 之前逐字相同（既有格式不许被这一格改掉）
  assert.equal(
    summarizeEvent(turnEnd({ kind: 'error', message: '请求被拒绝', code: 'http_400' })),
    'turn 3 · error(http_400: 请求被拒绝) · 未发言',
  );
  // 有指纹时：只多 ` · 思维链未回传` 这一格
  assert.equal(
    summarizeEvent(turnEnd({ kind: 'error', message: '请求被拒绝', code: 'http_400', reasoningEcho: true })),
    'turn 3 · error(http_400 · 思维链未回传: 请求被拒绝) · 未发言',
  );
  // 别的 400（图片格式一类）没有这一格 ⇒ 输出照旧
  assert.equal(
    summarizeEvent(turnEnd({ kind: 'error', message: '图片格式不被接受', code: 'http_400' })),
    'turn 3 · error(http_400: 图片格式不被接受) · 未发言',
  );
});

test('summarizeEvent：turn/end 的 idleReason 显示成一句人话，老日志显示「未记录」（2026-10-19）', () => {
  const turnEnd = (data: Record<string, unknown>): AppEvent => ({
    seq: 9, ts: T0.toISOString(), type: 'turn/end',
    data: { turn: 3, spoke: false, reason: { kind: 'completed' }, ...data },
    visibility: 'internal', origin: 'test/cli',
  } as unknown as AppEvent);

  // 有新写的那一格：code 的人话 + 她那句话的摘要（末尾多一格，前面逐字不变）
  assert.equal(
    summarizeEvent(turnEnd({ idleReason: { code: 'tired', note: '今天有点累，先不说话了。' } })),
    'turn 3 · completed · 未发言 · 未开口：累了（今天有点累，先不说话了。）',
  );
  // 读侧归一在这里也要生效：未知 code ⇒ 别的原因，超长 note ⇒ 80 字（不抛、不整行吞掉）
  assert.equal(
    summarizeEvent(turnEnd({ idleReason: { code: 'bored', note: '累'.repeat(100) } })),
    `turn 3 · completed · 未发言 · 未开口：别的原因（${'累'.repeat(80)}）`,
  );
  // 老日志（没有这一格）：如实写"未记录"，不是错误
  assert.equal(summarizeEvent(turnEnd({})), 'turn 3 · completed · 未发言 · 未开口：未记录');
  // 说过话的轮次：既有那行**逐字不变**（这一格一个字都不加）
  assert.equal(summarizeEvent(turnEnd({ spoke: true })), 'turn 3 · completed · 发过言');
  // 不是 completed 的结局也不加（reason 已经说清是谁让她停的）
  assert.equal(summarizeEvent(turnEnd({ reason: { kind: 'interrupted' } })), 'turn 3 · interrupted · 未发言');
});

test('cli tail：turn/end 那一行末尾给出「未开口」的理由（新日志有人话，老形状写未记录）', async (t) => {
  const fx = await setup(t);
  fx.append('turn/start', { turn: 1 });
  fx.append('turn/end', {
    turn: 1, reason: { kind: 'completed' }, spoke: false, idleReason: { code: 'tired', note: '今天有点累' },
  });
  fx.append('turn/start', { turn: 2 });
  // 这一格出现之前写下的形状：没有 idleReason。读取**不许报错**，显示"未记录"
  fx.append('turn/end', { turn: 2, reason: { kind: 'completed' }, spoke: false });
  fx.close();

  const out = collector();
  assert.equal(await runCli(['tail', '--type', 'turn/end', '--limit', '10'], out.io, { dataDir: fx.dir }), 0);
  assert.match(out.lines[1]!, /turn 1 · completed · 未发言 · 未开口：累了（今天有点累）/);
  assert.match(out.lines[2]!, /turn 2 · completed · 未发言 · 未开口：未记录/);
});

// ──────────────────────────────── review ────────────────────────────────

test('cli review：list 打印待确认明细，resolve 写 review/resolved 后待确认清除', async (t) => {
  const fx = await setup(t);
  fx.append('turn/start', { turn: 7 });
  fx.append('tool/call', {
    turn: 7, step: 2, callId: 'call_unknown', name: 'http_post',
    arguments: '{}', sideEffect: 'destructive',
  });
  fx.append('tool/result', {
    turn: 7, step: 2, callId: 'call_unknown', callSeq: 2, status: 'unknown',
    content: 'Its outcome is unknown.',
    error: { message: '进程在调用执行期间退出', code: 'recovered-unknown' },
  });
  fx.close();

  const list = collector();
  assert.equal(await runCli(['review', 'list'], list.io, { dataDir: fx.dir }), 0);
  assert.match(list.lines[0]!, /待确认调用 1 条/);
  assert.match(list.lines[1]!, /call_unknown · http_post · 2026-02-14T10:00:00\.000Z · turn 7 · step 2/);

  const ctx: CliContext = { dataDir: fx.dir, now: () => T0 };
  const resolve = collector();
  assert.equal(
    await runCli(
      ['review', 'resolve', 'call_unknown', '--outcome', 'succeeded', '--note', '外部接口查过，确实发出去了'],
      resolve.io, ctx,
    ),
    0,
  );
  assert.ok(resolve.lines.some((line) => line.includes('已结案：call_unknown → succeeded')));

  // 事件层：一条 review/resolved，字段完整，可见性按 schema 表（model）
  const events = await readAll(fx.dir);
  const resolved = events.filter(
    (event): event is Extract<AppEvent, { type: 'review/resolved' }> => event.type === 'review/resolved',
  );
  assert.equal(resolved.length, 1);
  assert.deepEqual(resolved[0]!.data, {
    callId: 'call_unknown', outcome: 'succeeded', note: '外部接口查过，确实发出去了', by: 'human',
  });
  assert.equal(resolved[0]!.visibility, 'model');
  assert.equal(resolved[0]!.seq, Math.max(...events.map((event) => event.seq)), '结案事件必须落在日志末尾');

  // 投影层：结案即从待确认列表消失（fold 的口径，不是 CLI 自己记的账）
  assert.equal(fold(events).needsReview.length, 0);
  assert.equal(buildReviewList(fx.dir).length, 0);
  const after = collector();
  assert.equal(await runCli(['review', 'list'], after.io, { dataDir: fx.dir }), 0);
  assert.match(after.lines[0]!, /待确认调用 0 条/);

  // 闸门①：拼错的 callId 不写日志（退出码 2）
  const typo = collector();
  assert.equal(await runCli(['review', 'resolve', 'call_typo', '--outcome', 'failed'], typo.io, ctx), 2);
  assert.ok(typo.errors.some((line) => line.includes('不在待确认列表里')));

  // 闸门②：outcome 只认三个值
  const badOutcome = collector();
  assert.equal(await runCli(['review', 'resolve', 'call_unknown', '--outcome', 'maybe'], badOutcome.io, ctx), 2);
  assert.equal(await runCli(['review', 'resolve', 'call_unknown'], badOutcome.io, ctx), 2);
  assert.equal(await runCli(['review', 'nope'], badOutcome.io, ctx), 2);

  // 闸门③：主进程活着就绝不写日志（退出码 3）——两个进程撞 seq 会让下次启动拒绝启动
  writeActiveLock(fx.dir, process.pid);
  const busy = collector();
  assert.equal(await runCli(['review', 'resolve', 'call_unknown', '--outcome', 'failed'], busy.io, ctx), 3);
  assert.ok(busy.errors.some((line) => line.includes('主进程正在运行')));
  assert.equal((await readAll(fx.dir)).filter((event) => event.type === 'review/resolved').length, 1, '被拒绝时不得落任何新事件');
});

// ──────────────────────────────── budget ────────────────────────────────

test('cli budget：heavy/light 分列、缓存命中率、距软/硬阈值比例与加注后的有效上限', async (t) => {
  const fx = await setup(t);
  // heavy：input 1000 = 命中 800 + 未命中 200，输出 400 ⇒ 非缓存口径计入 200 + 400 = 600
  fx.append('budget/consumed', {
    turn: 1, step: 1, lane: 'heavy', model: 'fake-heavy',
    inputTokens: 1000, outputTokens: 400, cacheHitTokens: 800, cacheMissTokens: 200,
    durationMs: 5, retryCount: 0, finishReason: 'completed', tokensTodayAccum: 1400,
  });
  // light：命中 0 ⇒ 两种口径同值（100 + 0）
  fx.append('budget/consumed', {
    turn: 1, step: 2, lane: 'light', model: 'fake-light',
    inputTokens: 100, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 100,
    durationMs: 3, retryCount: 0, finishReason: 'completed', tokensTodayAccum: 1500,
  });
  fx.append('budget/topped-up', { layer: 'daily', addedTokens: 1000, by: 'cli-tester' });
  fx.close();

  const ctx: CliContext = {
    dataDir: fx.dir,
    budget: { ...defaultConfig(fx.dir).budget, dailyTokens: 2000, taskTokens: 500, softRatio: 0.8 },
  };

  const out = collector();
  assert.equal(await runCli(['budget'], out.io, ctx), 0);
  const text = out.lines.join('\n');
  // 单位与口径（2026-10-05 用户报"同一个数两种写法"之后统一）：紧凑写法在前、真数在括号里，
  // 数字旁边的单位一律写"非缓存 token"。**同一个数在运行情况页、日志页、CLI 必须是同一串字符**
  // （那条回归立案在 test/format-units.test.ts）。
  assert.match(text, /今日非缓存消耗: 700 非缓存 token（heavy 600 · light 100）/);
  assert.match(text, /缓存: 命中 800 \/ 未命中 300 · 命中率 72\.7%/);
  assert.match(text, /单任务非缓存累计: 700 非缓存 token/);
  assert.match(text, /人工加注: daily \+1\.0k（1,000）/, '加注量也换档，真数在括号里');
  // 有效硬上限 = 配置 2000 + 加注 1000 = 3000；已用 700 → 23.3%；软阈值 2400 → 29.2%
  assert.match(text, /每日\(daily\): 已用 700 \/ 硬上限 3\.0k（3,000） 非缓存 token（23\.3%） · 软阈值 2\.4k（2,400）（29\.2%）/);
  // task 层：700 / 500 已越线，软阈值 400
  assert.match(text, /单任务\(task\): 已用 700 \/ 硬上限 500 非缓存 token（140\.0%） · 软阈值 400（175\.0%） · 已越线/);
  // 同一个数在 CLI 与界面必须是同一个写法：这条与 test/format-units.test.ts 的那一条同源，
  // 这里钉的是"CLI 那一侧确实走了它"（而不是自己又算了一遍）
  const big = collector();
  assert.equal(await runCli(['budget'], big.io, {
    ...ctx, budget: { ...ctx.budget!, dailyTokens: 5_000_000 },
  }), 0);
  assert.match(
    big.lines.join('\n'),
    /每日\(daily\): 已用 700 \/ 硬上限 5\.0M（5,001,000） 非缓存 token/,
    '百万级印 M、真数在括号里，单位词与非缓存口径一起给',
  );

  const today = collector();
  assert.equal(await runCli(['budget', '--today'], today.io, ctx), 0);
  const todayText = today.lines.join('\n');
  assert.match(todayText, /今日非缓存口径（仅每日层）:/);
  assert.ok(!todayText.includes('单步(step)'), todayText);

  const bad = collector();
  assert.equal(await runCli(['budget', '--task'], bad.io, ctx), 2);
  assert.ok(bad.errors.some((line) => line.includes('无法识别的参数')));
});

test('cli budget：没有样本时的命中率是「无样本」，不是 0%', async (t) => {
  const fx = await setup(t);
  fx.append('budget/rollover', { date: DAY });
  fx.close();

  const out = collector();
  assert.equal(await runCli(['budget'], out.io, { dataDir: fx.dir, budget: defaultConfig(fx.dir).budget }), 0);
  const text = out.lines.join('\n');
  assert.match(text, /命中率 无样本/);
  assert.match(text, /人工加注: 无/);
});

// ──────────────────────────────── 启动异常退出告警 ────────────────────────────────

test('启动告警：recover 结算 interrupted 后发 warn 级告警（指纹 startup-recovery），同类限流', async (t) => {
  const fx = await setup(t);
  fx.append('wake/manual', { note: '崩溃前的输入' });
  fx.append('turn/start', { turn: 1 });
  fx.append('input/claimed', { turn: 1, wakeSeqs: [1], claimCounts: [0] });
  fx.close(); // 模拟崩溃：turn 未闭合，也没有 session/end

  const recovery = await recover({ dataDir: fx.dir });
  t.after(() => {
    recovery.lock.release();
  });

  // 与 runtime/recover.ts 的文本契约：文案一改，这条断言立刻红——告警不会静默失效
  assert.ok(
    interruptedRepairs(recovery.repairs).length > 0,
    `repairs 应含 interrupted 结算，实际：${JSON.stringify(recovery.repairs)}`,
  );
  assert.ok(recovery.repairs.some((repair) => repair.includes('turn/end{interrupted}')));

  const emitted: AppEvent[] = [];
  const notifier = createNotifier({
    config: { rateLimitMin: 30 },
    dataDir: fx.dir,
    emit: (type, data, visibility) => {
      emitted.push({
        seq: emitted.length + 1, ts: T0.toISOString(), type, data, visibility,
      } as unknown as AppEvent);
    },
    now: () => T0,
  });

  const receipt = await notifyStartupRecovery(notifier, {
    repairs: recovery.repairs, dataDir: fx.dir, pid: 4242,
  });
  assert.equal(receipt?.ok, true);

  const fingerprint = fingerprintOf('startup-recovery');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.type, 'alarm/sent');
  assert.equal(emitted[0]!.data.fingerprint, fingerprint);
  assert.equal(emitted[0]!.data.level, 'warn');
  assert.match(emitted[0]!.data.title, /启动恢复：上一次运行异常退出/);

  // 文件档是永远可用的那一档：告警必须落在 alarms/YYYY-MM-DD.log
  const logPath = join(fx.dir, ALERT_DIR_NAME, `${DAY}.log`);
  assert.ok(existsSync(logPath), '告警文件档缺失');
  const text = readFileSync(logPath, 'utf8');
  assert.match(text, /\[warn\]/);
  assert.ok(text.includes(fingerprint));
  assert.match(text, /上一次运行异常退出/);

  // 限流：同一类启动告警 30 分钟内只发一次（守护脚本反复拉起不该刷屏）
  const again = await notifyStartupRecovery(notifier, { repairs: recovery.repairs, dataDir: fx.dir });
  assert.equal(again?.ok, true, '被限流不是失败');
  assert.equal(emitted.length, 1, '第二次被限流丢弃，不写 alarm/sent');

  // 正常退出：repairs 里没有 interrupted，就不发告警——不制造"出事了"的假事实
  const normal = await notifyStartupRecovery(notifier, {
    repairs: ['水位恢复：待处理输入 1 条（manual×1）', '恢复定时器：1 条来自投影，已布防 1 个在途句柄'],
  });
  assert.equal(normal, null);
  assert.equal(emitted.length, 1);
});

test('启动告警：正常退出的恢复清单（无 interrupted）不发任何告警', async (t) => {
  const fx = await setup(t);
  fx.append('session/start', {
    pid: 111, cwd: fx.dir, version: '0.1.0', schemaVersion: '1', configHash: 'deadbeef',
  });
  fx.append('session/end', { reason: 'shutdown' });
  fx.close();

  const recovery = await recover({ dataDir: fx.dir });
  t.after(() => {
    recovery.lock.release();
  });

  assert.deepEqual(interruptedRepairs(recovery.repairs), []);

  const emitted: AppEvent[] = [];
  const notifier = createNotifier({
    config: { rateLimitMin: 30 },
    dataDir: fx.dir,
    emit: (type, data, visibility) => {
      emitted.push({
        seq: emitted.length + 1, ts: T0.toISOString(), type, data, visibility,
      } as unknown as AppEvent);
    },
    now: () => T0,
  });

  assert.equal(await notifyStartupRecovery(notifier, { repairs: recovery.repairs, dataDir: fx.dir }), null);
  assert.equal(emitted.length, 0);
  assert.equal(existsSync(join(fx.dir, ALERT_DIR_NAME, `${DAY}.log`)), false, '不该产生告警文件');
});

// ──────────────────────────────── 启动告警与限流窗口的顺序（P1-20） ────────────────────────────────

/**
 * 一次"进程启动"的告警出口。
 *
 * 关键是**每次启动都是新实例**：`Notifier` 的限流窗口是内存里的（`windowsMap`），
 * 进程一重启就空了——跨重启的那一份只能从日志折回来。这正是 P1-20 被测的那条路：
 * 重启后先 `restoreStartupAlertWindow(日志)`，再发启动告警。
 */
function startupNotifier(log: EventLog, dataDir: string, now: () => Date): AlertNotifier {
  return createNotifier({
    config: { rateLimitMin: 30 },
    dataDir,
    emit: (type, data, visibility) => {
      log.append({
        seq: log.nextSeq(), ts: now().toISOString(), type, data, visibility, origin: 'test/cli-observe',
      } as unknown as AppEvent, { sync: true });
    },
    now,
  });
}

/** 日志里现有的 `alarm/sent`（限流窗口的唯一来源） */
async function alarmSent(log: EventLog): Promise<AppEvent[]> {
  const out: AppEvent[] = [];
  for await (const event of log.readAll()) {
    if (event.type === 'alarm/sent') out.push(event);
  }
  return out;
}

/** 一次崩溃留下的补偿清单（`recover` 的文本契约已由上面那条用例锁住，这里只要形状） */
const CRASH_REPAIRS = ['上一次运行异常退出：turn 1 补写 turn/end{interrupted}'];

test('启动告警：连续两次启动只留一条（P1-20：窗口先恢复，再发告警）', async (t) => {
  const fx = await setup(t);

  // ── 启动 #1：日志里一条 alarm/sent 都没有 ⇒ 窗口空 ⇒ 这条必须真的发出去 ──
  const first = startupNotifier(fx.log, fx.dir, () => T0);
  assert.equal(await restoreStartupAlertWindow(first, fx.log), 0, '第一次启动时日志里还没有告警可折');
  const firstReceipt = await notifyStartupRecoveryDetailed(first, { repairs: CRASH_REPAIRS, dataDir: fx.dir, pid: 111 });
  assert.equal(firstReceipt.outcome?.ok, true);
  assert.equal(firstReceipt.suppressed, false, '第一条不该被限流');
  assert.equal((await alarmSent(fx.log)).length, 1);

  // ── 重启：**新的**告警出口（内存窗口空了）+ 同一份日志 ──
  // 这正是崩溃循环的形状：进程反复被拉起，而日志一直留着。
  const second = startupNotifier(fx.log, fx.dir, () => T0);
  assert.equal(await restoreStartupAlertWindow(second, fx.log), 1, '第二次启动前，日志里那一条要折回窗口');
  const secondReceipt = await notifyStartupRecoveryDetailed(second, { repairs: CRASH_REPAIRS, dataDir: fx.dir, pid: 222 });
  assert.equal(secondReceipt.outcome?.ok, true, '被限流不是失败');
  assert.equal(secondReceipt.suppressed, true, '第二次必须被限流窗口压掉');
  // 判据是**日志与文件里的条数**，不是内存计数：崩溃循环里人只该收到一条
  assert.equal((await alarmSent(fx.log)).length, 1, '重启之后不许再写一条 alarm/sent');
  const lines = readFileSync(join(fx.dir, ALERT_DIR_NAME, `${DAY}.log`), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, '告警文件档也只该有一行');
  assert.equal(lines[0]!.includes(fingerprintOf('startup-recovery')), true, '那一条就是启动恢复告警');
});

test('启动告警：**不恢复窗口**时第二次启动会再发一条（P1-20 的病，这条锁住"为什么必须先恢复"）', async (t) => {
  const fx = await setup(t);
  const first = startupNotifier(fx.log, fx.dir, () => T0);
  await notifyStartupRecoveryDetailed(first, { repairs: CRASH_REPAIRS, dataDir: fx.dir });

  // 重启，但**故意跳过** restoreStartupAlertWindow —— 这就是修之前的顺序（告警早于 warmUp 的折回）
  const second = startupNotifier(fx.log, fx.dir, () => T0);
  const again = await notifyStartupRecoveryDetailed(second, { repairs: CRASH_REPAIRS, dataDir: fx.dir });
  assert.equal(again.suppressed, false);
  assert.equal((await alarmSent(fx.log)).length, 2, '不恢复窗口 ⇒ 每重启一条：这正是 P1-20 的病');
});
