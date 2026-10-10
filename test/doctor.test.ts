/**
 * doctor 自检测试 — src/runtime/doctor.ts（CLI `doctor` 命令）
 *
 * 验收口径（docs/milestones.md M6-7、docs/schema.md §12、docs/operations.md §6）：
 *   **手工破坏一处不变量 → doctor 报告该条且退出码非 0**。
 *
 * 本套件的 fixtures 是**直接写分片文件**的：EventLog 的正常写入路径不可能造出重复 seq、
 * 双 turn/end、悬空 tool/call 这类违规日志——而那恰恰是 doctor 存在的理由。用写死字节的
 * 违规日志当输入，才是对自检本身的检验。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { runCli, type CliContext, type CliIO } from '../src/cli.ts';
import type { AppEvent, Projection } from '../src/log/types.js';
import { sha256Hex } from '../src/persona/versions.ts';
import { checkBudgetFold, checkSingleOpenTurn, runDoctor } from '../src/runtime/doctor.ts';
import { PROJECTION_CACHE_FILE, PROJECTION_CACHE_VERSION } from '../src/state/projection-cache.ts';
import { fold } from '../src/state/fold.ts';

const T0 = '2026-05-01T00:00:00.000Z';
const STATE_CONTENT = '# 当前状态\n\n待命中。\n';
const REASONING = '先看一眼待办清单，再决定这一刻要不要说话，沉默也是正常动作。';

// ──────────────────────────────── fixture ────────────────────────────────

interface Fixture {
  dir: string;
  /** 覆写事件集后重写分片（模拟"手工破坏一处不变量"） */
  rewrite: (events: AppEvent[]) => void;
  /** 追加一段原始字节（制造半行等磁盘级破坏） */
  appendRaw: (text: string) => void;
  events: () => AppEvent[];
}

function event(
  seq: number,
  type: string,
  data: unknown,
  visibility: 'model' | 'internal' = 'internal',
): AppEvent {
  return { seq, ts: T0, type, data, visibility, origin: 'test/doctor' } as unknown as AppEvent;
}

/** 一份"处处合规"的日志：I1..I11 全部应当通过 */
function healthyEvents(diffHash: string): AppEvent[] {
  return [
    event(1, 'session/start', {
      pid: 4242, cwd: 'C:/tmp', version: '0.1.0', schemaVersion: '1', configHash: 'cfg-1',
    }),
    event(2, 'persona/updated', { file: 'STATE.md', diffHash, by: 'agent' }),
    event(3, 'wake/manual', { note: '看看今天有什么', dedupeKey: 'k1' }, 'model'),
    event(4, 'turn/start', { turn: 1 }),
    event(5, 'input/claimed', { turn: 1, wakeSeqs: [3], claimCounts: [0] }),
    event(6, 'step/start', {
      turn: 1, step: 1, model: 'fake-heavy', lane: 'heavy', renderVersion: '1', personaHash: 'ph-1',
    }),
    event(7, 'message/reasoning', { turn: 1, step: 1, text: REASONING }),
    event(8, 'message/assistant', { text: '看了一眼，没事。', toolCalls: [] }, 'model'),
    event(9, 'tool/call', {
      turn: 1, step: 1, callId: 'call_1', name: 'read_file',
      arguments: '{"file_path":"a.txt"}', sideEffect: 'none',
    }, 'model'),
    event(10, 'tool/result', {
      turn: 1, step: 1, callId: 'call_1', callSeq: 9, status: 'ok', content: '内容若干',
    }, 'model'),
    event(11, 'budget/consumed', {
      turn: 1, step: 1, lane: 'heavy', model: 'fake-heavy',
      inputTokens: 100, outputTokens: 20, cacheHitTokens: 80, cacheMissTokens: 20,
      durationMs: 12, retryCount: 0, finishReason: 'completed', tokensTodayAccum: 120,
    }),
    event(12, 'step/end', { turn: 1, step: 1, toolCalls: 1 }),
    event(13, 'turn/end', { turn: 1, reason: { kind: 'completed' }, spoke: true }),
    event(14, 'timer/set', { timerId: 't1', at: '2026-05-02T00:00:00.000Z', payload: { note: '明天提醒' } }),
  ];
}

function makeFixture(t: TestContext, events: AppEvent[] = healthyEvents(sha256Hex(STATE_CONTENT))): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-doctor-'));
  const eventsDir = join(dir, 'events');
  mkdirSync(eventsDir, { recursive: true });
  mkdirSync(join(dir, 'persona'), { recursive: true });
  writeFileSync(join(dir, 'persona', 'STATE.md'), STATE_CONTENT, 'utf8');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const shard = join(eventsDir, '000000000001.jsonl');
  const write = (list: AppEvent[]): void => {
    writeFileSync(shard, `${list.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
  };
  write(events);

  return {
    dir,
    rewrite: write,
    appendRaw: (text) => writeFileSync(shard, text, { encoding: 'utf8', flag: 'a' }),
    events: () => events,
  };
}

function collector(): { io: CliIO; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { io: { out: (line) => lines.push(line), err: (line) => errors.push(line) }, lines, errors };
}

// ──────────────────────────────── ① 全绿 ────────────────────────────────

test('doctor ①：合规日志上 11 条不变量全绿，退出码 0', async (t) => {
  const fx = makeFixture(t);
  const report = await runDoctor(fx.dir);

  const failed = report.checks.filter((check) => check.status === 'fail');
  assert.deepEqual(failed.map((check) => `${check.id}: ${check.detail}`), []);
  assert.equal(report.failures, 0);

  // 11 条不变量一条都不能少（schema §12 的编号就是认领清单）
  for (let index = 1; index <= 11; index++) {
    assert.ok(report.checks.some((check) => check.id === `I${index}`), `缺少不变量 I${index}`);
  }
  // 运行面四项（operations.md §6 的 doctor 行）
  for (const id of ['OPS-log', 'OPS-lock', 'OPS-blob', 'OPS-timers', 'OPS-projection']) {
    assert.ok(report.checks.some((check) => check.id === id), `缺少运行面检查 ${id}`);
  }

  const cli = collector();
  assert.equal(await runCli(['doctor'], cli.io, { dataDir: fx.dir }), 0);
  assert.match(cli.lines.join('\n'), /结论：全部通过/);
  assert.match(cli.lines.join('\n'), /✓ I9/);

  // I7 的换口径锁（2026-10-05）：这条夹具的调用**命中 80 / 未命中 20**——旧口径下 I7 自己
  // 也算一遍 `input + output`，换口径之后会把一份正确的投影报成"投影与事件累计不符"（假故障）。
  // 现在 I7 引 `fold.ts` 的 `budgetTokensOf`：(100 − 80) + 20 = 40。判据不放宽，只钉住"不假报"。
  const i7 = report.checks.find((check) => check.id === 'I7');
  assert.equal(i7?.status, 'ok', `I7 不许假报（换口径后的判据）：${i7?.detail}`);
  assert.match(i7?.detail ?? '', /今日非缓存 40 tok/, '读数要按非缓存口径给，别报旧口径的 120');
});

// ──────────────────────────────── ② 逐条破坏 ────────────────────────────────

test('doctor ②：I1 破坏（重复 seq）被抓且退出码非 0', async (t) => {
  const fx = makeFixture(t);
  const events = fx.events();
  fx.rewrite([...events, event(8, 'message/assistant', { text: '重复编号', toolCalls: [] }, 'model')]);

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'I1');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /seq 8/);
  assert.ok(report.failures > 0);
});

test('doctor ②：I2 破坏（callSeq 指不到 tool/call）被抓', async (t) => {
  const fx = makeFixture(t);
  fx.rewrite(fx.events().map((item) =>
    item.type === 'tool/result'
      ? event(10, 'tool/result', { ...item.data, callSeq: 999 }, 'model')
      : item,
  ));

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'I2');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /callSeq=999/);
});

test('doctor ②：I3 破坏（同一 turn 两条 turn/end）被抓', async (t) => {
  const fx = makeFixture(t);
  fx.rewrite([...fx.events(), event(15, 'turn/end', { turn: 1, reason: { kind: 'completed' }, spoke: true })]);

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'I3');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /turn 1 有 2 条 turn\/end/);
});

test('doctor ②：I3 未闭合优先于重复闭合（2026-10-11 顺序修正）', async (t) => {
  // 现场那份日志的形状：**同一份日志上两种违规同时存在**（1236/1241/1285 有双 turn/end，
  // 1237/1277 未闭合），而判据原来一旦看到 duplicated 就 return ⇒ "未闭合"那一支被遮住、
  // 界面上一次都没露过面。修法：未闭合优先——它要靠恢复流程逐条结算，重复闭合只说明
  // 关闭写了两次、不动账。这条测试钉住"两支同时成立时报的是未闭合"。
  //
  // 形状上有两个坑（都是实测踩出来的）：
  //   · turn 1 必须**不是当前 openTurn**（当前那个 turn 未闭合是合法的）⇒ 末尾开一个 turn 2；
  //   · turn 1 必须在 `started` 里又不在 `endCounts` 里——而 `endCounts` 只看"有没有 end"、
  //     不看"end 在 start 之前还是之后"（判据这一层也是"只要有一条 end 就算闭合"，
  //     见本次报告里点名的那个已知不精确处）⇒ 第 2 条 turn/end 得排在**最后一条 turn/start
  //     之前**，turn 1 才算"有 start、没 end"。
  const fx = makeFixture(t);
  fx.rewrite([
    ...fx.events(),
    event(15, 'turn/end', { turn: 1, reason: { kind: 'completed' }, spoke: true }), // 第 2 条 turn/end
    event(16, 'turn/start', { turn: 1 }),   // turn 1 此后没有新的 turn/end ⇒ 未闭合
    event(17, 'turn/start', { turn: 2 }),   // 当前打开的 turn（合法未闭合）——它让 turn 1 变成违规
  ]);

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'I3');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /未闭合且不是当前 turn：1/, '未闭合不该被"重复闭合"遮住');
});

test('doctor ②：I4 破坏（两个未闭合 turn）被抓', async (t) => {
  const fx = makeFixture(t);
  fx.rewrite([
    ...fx.events(),
    event(15, 'turn/start', { turn: 2 }),
    event(16, 'turn/start', { turn: 3 }),
  ]);

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'I4');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /未闭合 turn：2、3/);
});

test('doctor ②：I4 按 turn 号去重（同 turn 两条 turn/start 只算一个未闭合）', async (t) => {
  // 并发缺陷的现场形状：turn 1277 有两条 turn/start ⇒ 旧判据用 `started.push()` 按**事件条数**
  // 列，于是把 **4** 个未闭合 turn 报成"5 个未闭合 turn：…1277、1277…"。判据问的是
  // "有几个打开的 turn"，不是"写了几条 start"。
  const fx = makeFixture(t);
  fx.rewrite([
    ...fx.events(),
    event(15, 'turn/start', { turn: 2 }),
    event(16, 'turn/start', { turn: 2 }), // 同一 turn 号的第二条 start
    event(17, 'turn/start', { turn: 3 }),
  ]);

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'I4');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /^2 个未闭合 turn：2、3（/, '两个 turn 号 ⇒ 报 2 个，不是 3 条 start');
});

test('doctor ②：I4 反向不一致（投影 openTurn 非空但日志里没有未闭合 turn）', async (t) => {
  // 这一支**造不出一份能触发它的日志**：`openTurn` 只由 turn/start 置位、只由同 turn 的
  // turn/end 清空（fold.ts:208-220），而 runDoctor 的投影就是 fold(events)（doctor.ts:60）
  // ⇒ 走 runDoctor 的测试永远覆盖不到它。所以这里把**显式投影**喂进判据本体（`_` 导出）。
  const fx = makeFixture(t);
  const events = [
    ...fx.events(),
    event(15, 'turn/start', { turn: 2 }),
    event(16, 'turn/end', { turn: 2, reason: { kind: 'completed' }, spoke: true }),
  ];
  // 日志侧：turn 2 已闭合 ⇒ 没有未闭合 turn；投影侧：却说 turn 2 还开着 —— 反过来了。
  const injected = { ...fold(events), openTurn: { turn: 2, step: 1 } } as unknown as Projection;

  const check = checkSingleOpenTurn(events, injected);
  assert.equal(check.status, 'fail');
  assert.match(check?.detail, /投影 openTurn=2 但日志里没有未闭合的 turn/);
});

test('doctor ②：I7 只核投影——事件自带的 tokensTodayAccum 是观测字段，不许当判据', async (t) => {
  // 2026-10-11：删掉"用旧口径（in+out）核 tokensTodayAccum"那条判据（诊断报告 ②.3 错误 A）。
  // 它是写入方的**观测字段**，形状是"新口径基线 + 本条旧口径增量"——拿旧口径去核它 = 两把尺子，
  // 从 2026-10-05 换口径起天天假报。这里把那个字段改成明显错的 999，I7 **必须仍然通过**。
  const fx = makeFixture(t);
  fx.rewrite(fx.events().map((item) =>
    item.type === 'budget/consumed' ? event(11, 'budget/consumed', { ...item.data, tokensTodayAccum: 999 }) : item,
  ));

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'I7');
  assert.equal(check?.status, 'ok', `观测字段不该进判据：${check?.detail}`);
  assert.match(check?.detail ?? '', /今日非缓存 40 tok/, '读数仍按非缓存口径给');
});

test('doctor ②：I7 破坏（投影当日累计与事件重折不符）被抓', async (t) => {
  // 上面那条删的是"核观测字段"，不是把 I7 放空：**投影那三格照旧逐格核**。
  // 注意这一支与 I4 反向判据同一个道理：`runDoctor` 的投影就是 `fold(events)`，两侧同源
  // ⇒ 走 runDoctor 只验得到"折叠是纯函数"，验不到"投影坏了会不会被抓"。所以喂一份显式投影。
  const fx = makeFixture(t);
  const events = fx.events();
  const real = fold(events);
  assert.equal(real.budget.tokensToday, 40, '先钉住这份日志的真值');

  const holed = { ...real, budget: { ...real.budget, tokensToday: 999 } } as unknown as Projection;
  const check = checkBudgetFold(events, holed);
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /投影 tokensToday=999，按非缓存口径折出 40/);
});

test('doctor ②：I7 跨天只在日期变化时归零——换日前的账不许算进"今日"', async (t) => {
  // 诊断报告 ②.3 错误 B：`billable/heavy/light` **从来不归零**（只在 rollover 分支清 accum，
  // 却把全历史 29 991 932 拿去比当日的 1 628 746）。这条测试就是那个形状：前一天花 40，
  // 换日写一条**新日期**的 rollover，今天再花 20 ⇒ 当日 20。旧判据会把 40 也算进去、报 60。
  const fx = makeFixture(t);
  fx.rewrite([
    ...fx.events(),
    event(15, 'budget/rollover', { date: '2026-05-02' }), // 真换日（首条不算变化，这条算）
    event(16, 'budget/consumed', {
      turn: 1, step: 2, lane: 'light', model: 'fake-light',
      inputTokens: 50, outputTokens: 10, cacheHitTokens: 40, cacheMissTokens: 10,
      durationMs: 3, retryCount: 0, finishReason: 'completed', tokensTodayAccum: 60,
    }),
  ]);

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'I7');
  assert.equal(check?.status, 'ok', `换日后的"今日"只能算换日之后的账：${check?.detail}`);
  assert.match(check?.detail ?? '', /今日非缓存 20 tok（heavy 0 \/ light 20）/, '40 那笔属于前一天');
});

test('doctor ②：I7 交叉验证——同日期 rollover 的边界由投影说了算（判据不许自作主张）', async (t) => {
  // ⚠️ 这条钉的是一个**反直觉但必须成立**的性质：I7 是"投影 vs 事件重折"的比对，投影来自
  // `fold(events)`（doctor.ts:60）⇒ 判据的日期边界**必须与 `fold.ts:348-358` 逐字同语义**。
  // 而 fold 折 rollover 时是**无条件**归零的（不自己判"日期真的变了没有"）——这是 2026-10 之前
  // 旧版 `rolloverIfNeeded` 每次启动都写 rollover 留下的形状（现场 09-30 有 26 条同日期 rollover）。
  // 判据若改成"只在日期变化时归零"，就会比投影**多算**同日期 rollover 之后的那一段，
  // 在一份投影自洽的日志上报假故障 ⇒ **判据必须跟着投影走**。
  // 这条用 `checkBudgetFold` 的显式投影口子把这个性质钉死（喂的是 fold 自己的输出，必然自洽）。
  const fx = makeFixture(t);
  const events = [
    ...fx.events(),
    event(15, 'budget/rollover', { date: '2026-05-01' }), // 与首条同日期：fold 照样归零
    event(16, 'budget/consumed', {
      turn: 1, step: 2, lane: 'light', model: 'fake-light',
      inputTokens: 50, outputTokens: 10, cacheHitTokens: 40, cacheMissTokens: 10,
      durationMs: 3, retryCount: 0, finishReason: 'completed', tokensTodayAccum: 60,
    }),
  ];
  const real = fold(events);
  assert.equal(real.budget.tokensToday, 20, 'fold 折同日期 rollover 时归零 ⇒ 当日只剩第二笔 20');

  const check = checkBudgetFold(events, real);
  assert.equal(check.status, 'ok', `判据的日期边界必须与 fold 一致：${check.detail}`);
  assert.match(check.detail, /今日非缓存 20 tok（heavy 0 \/ light 20）/, '与投影同为 20，不许自作主张算 60');
});

test('doctor ②：I9 破坏（turn 已关闭却留下悬空 tool/call）被抓且退出码 1', async (t) => {
  const fx = makeFixture(t);
  fx.rewrite([
    ...fx.events(),
    event(15, 'tool/call', {
      turn: 1, step: 1, callId: 'call_x', name: 'http_post',
      arguments: '{"url":"https://example.test/"}', sideEffect: 'destructive',
    }, 'model'),
  ]);

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'I9');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /call_x/);

  // M6-7 的验收口径：报告该条 + 退出码非 0
  const cli = collector();
  assert.equal(await runCli(['doctor'], cli.io, { dataDir: fx.dir }), 1);
  const text = cli.lines.join('\n');
  assert.match(text, /✗ I9 /);
  assert.match(text, /call_x/);
  assert.match(text, /退出码 1/);
});

test('doctor ②：I10 破坏（人格文件被改动却无 persona/updated）被抓', async (t) => {
  const fx = makeFixture(t);
  writeFileSync(join(fx.dir, 'persona', 'STATE.md'), '# 当前状态\n\n人类直接改的。\n', 'utf8');

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'I10');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /STATE\.md/);
});

test('doctor ②：I11 破坏（internal 事件被塞进模型可见内容）被抓', async (t) => {
  const fx = makeFixture(t);
  const timerEvent = fx.events().find((item) => item.type === 'timer/set')!;
  // 把一条 internal 事件的整条 JSON 放进 user 消息：这正是"internal 进了模型请求"
  fx.rewrite(fx.events().map((item) =>
    item.type === 'message/assistant'
      ? event(8, 'message/assistant', { text: `我把这条抄进来了：${JSON.stringify(timerEvent)}`, toolCalls: [] }, 'model')
      : item,
  ));

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'I11');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /timer\/set\(seq 14\)/);
});

test('doctor ②：OPS-log 破坏（半截行）被抓', async (t) => {
  const fx = makeFixture(t);
  fx.appendRaw('{"seq":15,"ts":"2026-05-01T00:00:00.000Z","type":"turn/en');

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'OPS-log');
  assert.equal(check?.status, 'fail');
  assert.equal(report.badLines, 1);
});

// ──────────────────────────────── ③ 边界 ────────────────────────────────

test('doctor ③：空数据目录（无日志无 persona）不误报，persona 检查报"跳过"', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-doctor-empty-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const report = await runDoctor(dir);
  assert.equal(report.failures, 0);
  assert.equal(report.events, 0);
  const persona = report.checks.find((item) => item.id === 'I10');
  assert.equal(persona?.status, 'skip');
  const internal = report.checks.find((item) => item.id === 'I11');
  assert.equal(internal?.status, 'skip');
});

test('doctor ②：日志那条 diffHash 是 16 位截断（GUI 直编通道）⇒ 内容一致不许报 ✗', async (t) => {
  /**
   * 现场（2026-10-11 的真日志，就是这个形状）：`CONSTITUTION.md` 最近一条 persona/updated 来自
   * `web/api`，`diffHash` 只有 **16 位**（`web/server.ts:5778` 的 `.slice(0, 16)`），而盘上那一侧
   * 算的是满 **64 位** ⇒ 旧判据拿 64 比 16，"一字不差"也判漂移，两侧又都按前 8 位打印，
   * 于是消息长成「盘上 92f28ba3 ≠ 日志 92f28ba3」——同一句话，看不出差在哪。
   * 截断前缀与满量哈希**同源同值**（都是同一个 sha256），所以这里必须判 ok。
   */
  const fx = makeFixture(t, healthyEvents(sha256Hex(STATE_CONTENT).slice(0, 16)));
  const ok = (await runDoctor(fx.dir)).checks.find((item) => item.id === 'I10');
  assert.equal(ok?.status, 'ok', `16 位前缀是同一份内容的截断，不该报漂移：${ok?.detail}`);

  // 判据没被放宽：内容真变了（哪怕只差一个字）照样 ✗，且消息里能看出两侧的长度与全量
  writeFileSync(join(fx.dir, 'persona', 'STATE.md'), '# 当前状态\n\n被改过。\n', 'utf8');
  const bad = (await runDoctor(fx.dir)).checks.find((item) => item.id === 'I10');
  assert.equal(bad?.status, 'fail');
  assert.match(bad?.detail ?? '', /盘上 [0-9a-f]{64}（64 位）≠ 日志 [0-9a-f]{16}（16 位）/);
});

test('doctor ③：版本库快照内容与文件名不符 → I10 报 ✗（内容寻址是硬约束）', async (t) => {
  const fx = makeFixture(t);
  const versionsDir = join(fx.dir, '.versions', 'STATE.md');
  mkdirSync(versionsDir, { recursive: true });
  // 文件名声称是这份内容的 sha256，内容却是别的
  writeFileSync(join(versionsDir, `${sha256Hex('声称的内容')}.md`), '实际内容', 'utf8');

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'I10');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /内容哈希 .* 与文件名不符/);
});

test('doctor ③：--json 输出可被机器消费（含 failures 与逐条结论）', async (t) => {
  const fx = makeFixture(t);
  const cli = collector();
  const ctx: CliContext = { dataDir: fx.dir };
  assert.equal(await runCli(['doctor', '--json'], cli.io, ctx), 0);

  const parsed = JSON.parse(cli.lines.join('\n')) as { failures: number; checks: Array<{ id: string; status: string }> };
  assert.equal(parsed.failures, 0);
  assert.equal(parsed.checks.length, 16);
});

// ──────────────────────────────── ④ 投影缓存（OPS-projection） ────────────────────────────────

/**
 * 把一份投影写成缓存文件。形状**逐字对齐生产**（`state/projection-cache.ts` 的
 * `saveProjectionCache`）：信封 `{ version, lastSeq, state }`，`state.budget.budgetVersion`
 * 由 fold 盖章。少任何一格都不是"这份缓存坏了"，而是"这份缓存不是生产写出来的"——
 * doctor 那条判据要验的是**内容对不对**，所以夹具不能先被加载层拒掉。
 */
function writeCache(fx: Fixture, state: unknown, lastSeq: number): void {
  writeFileSync(
    join(fx.dir, PROJECTION_CACHE_FILE),
    JSON.stringify({ version: PROJECTION_CACHE_VERSION, lastSeq, state }),
    'utf8',
  );
}

test('doctor ④：缓存里的 watermark 是运行期游标，与折叠不一致不算损坏', async (t) => {
  const fx = makeFixture(t);
  const events = fx.events();
  const maxSeq = events[events.length - 1]!.seq;
  // 运行期会把水位推进到日志末尾（loop.ts），而 fold 只累计 lastSeq、永不推进水位（recover.ts 的
  // M1 简化）——这是两者的**合法差异**，不是缓存损坏。剔除它比对，这一项才不会每次报红。
  writeCache(fx, { ...fold(events), watermark: maxSeq }, maxSeq);

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'OPS-projection');
  assert.equal(check?.status, 'ok');
  assert.match(check?.detail ?? '', new RegExp(`watermark ${maxSeq} 为运行期游标`));
  assert.equal(report.failures, 0);
});

test('doctor ④：缓存内容真的不同时仍报损坏（剔掉 watermark 不等于关掉检查）', async (t) => {
  const fx = makeFixture(t);
  const events = fx.events();
  const maxSeq = events[events.length - 1]!.seq;
  writeCache(fx, { ...fold(events), watermark: maxSeq, failStreak: 9 }, maxSeq);

  const report = await runDoctor(fx.dir);
  const check = report.checks.find((item) => item.id === 'OPS-projection');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /缓存损坏/);
});

test('I11：工具输出里的日志原文不算泄漏——她自己翻日志是常事', async (t) => {
  // 一次实测误报（2026-10-01 turn 20）：她跑 doctor，列出五条"整条 internal 事件出现在请求体里"
  // 的 LEAK（budget/rollover、turn/start、step/start…），照着追了一遍，全是假的。
  // 根因是这条不变量把**工具输出**也算进了"请求体文本"——而她 rg_search / safe_read
  // 读事件日志时，日志原文（含整行 internal 事件）会合法地进上下文。判据该问的是
  // "渲染层有没有把 internal 事件当成上下文内容放进去"，与她用工具读到了什么无关。
  const diffHash = 'a'.repeat(64);
  const base = healthyEvents(diffHash);
  const turnStart = base.find((e) => e.seq === 4)!;
  // 动态序列化：拿真实对象的 JSON 去比对，保证与 doctor 的判据逐字节同形
  const serialized = JSON.stringify(turnStart);
  const withLog = base.map((e) => (e.seq === 10 && e.type === 'tool/result'
    ? ({ ...e, data: { ...e.data, content: `events/000000000001.jsonl:4: ${serialized}` } } as unknown as AppEvent)
    : e));
  const fx = makeFixture(t);
  fx.rewrite(withLog);
  const report = await runDoctor(fx.dir);
  const check = report.checks.find((c) => c.id === 'I11');
  assert.ok(check !== undefined);
  assert.equal(check.status, 'ok', `工具读过日志不该被判成泄漏：${check.detail}`);
});