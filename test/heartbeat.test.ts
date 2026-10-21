/**
 * 心跳：**概率随时间上升**的连续模型测试（docs/design.md §4.12）
 *
 * 用户的口径（2026-10-04）：
 *   「我希望心跳在 5~60 分钟不等，越长时间没触发，触发概率就越高。平均在 10~20 分钟左右。」
 *
 * 判据（只紧不松，逐条对应下面六个小节）：
 *   ① 安静 < 下限（5 分钟）：**绝不**触发（p 恒为 0，不是"概率很小"）；
 *   ② 安静 ≥ 上限（60 分钟）：**必然**触发（p = 1，端到端驱动定时器证明它真的会响）；
 *   ③ p 随安静时间**单调不减**；
 *   ④ 注入**可复现的随机源**后模拟 10000 次，均值落在 10~20 分钟（实测约 15）；
 *   ⑤ 外部事件复位：安静计时归零，一切重新从 0 开始；
 *   ⑥ 事件里带 `probability` 与 `roll`，且 `roll < probability` 可复算。
 *   ⑦ 节律策略与退化输入（既有行为）；
 *   ⑧ **目标均值**（2026-02-06 加）：改频率只需要给"平均多久醒一次"，α 由它反解出来
 *      ——目标 15/30 分钟各自模拟 ≥20000 次的实测均值、上下限边界在新 α 下不变、
 *       审计三字段照旧可复算、以及"目标 15 ⇒ α ≈ 1.1"这个自洽点。
 *
 * 说明：Node 的类型剥离不做 `.js` → `.ts` 映射，所以这里用显式 `.ts` 说明符导入源码。
 * 本文件的时间与随机**全部注入**：真时钟/真随机会让"均值落在 10~20"这类判据变成偶发失败。
 */

import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

import type { AppEvent, Projection, WakeHeartbeat } from '../src/log/types.ts';
import { emptyProjection } from '../src/log/types.ts';
import { CONFIG_FILE_NAME, ConfigError, loadConfig } from '../src/config/config.ts';
import {
  HEARTBEAT_SHAPE_ALPHA, Heartbeat, HeartbeatSource, POLICY_RECHECK_MS,
  heartbeatMeanMs, heartbeatProbability, makeSeededRandom, solveHeartbeatAlpha,
  DEFAULT_HEARTBEAT_CEIL_MS, DEFAULT_HEARTBEAT_FLOOR_MS, DEFAULT_HEARTBEAT_TICK_MS,
  type HeartbeatFiring, type HeartbeatSink,
} from '../src/wake/heartbeat.ts';
import { tempDir } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const MIN = 60_000;
const FLOOR = DEFAULT_HEARTBEAT_FLOOR_MS;      // 5 分钟
const CEIL = DEFAULT_HEARTBEAT_CEIL_MS;        // 60 分钟
const TICK = DEFAULT_HEARTBEAT_TICK_MS;        // 1 分钟
const T0 = Date.parse('2026-02-14T10:00:00.000+08:00');
/** 模拟用的固定种子（"IRMI"）：写在测试里，失败可原样复现 */
const SEED = 0x49524d49;
/** 模拟轮数：判据要求 ≥10000 */
const RUNS = 10_000;

const seeded = (seed = SEED): (() => number) => makeSeededRandom(seed);
/** 恒定随机源：`always(0.001)` 表示"掷出的数总是 0.001"，用来把抽签结果钉死 */
const always = (value: number): (() => number) => () => value;

/** 假闹钟：手动推进定时器，不依赖真实时钟（心跳测试必须是确定的） */
interface FakeClock {
  now: () => Date;
  setTimer: (handler: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** 当前挂起的定时器（null 表示没有） */
  pending: () => { ms: number; handle: number } | null;
  /** 推进 ms 毫秒并触发到点的定时器 */
  advance: (ms: number) => void;
  /** 定时器被重新布防的次数（复位/重排是否真的发生） */
  arms: () => number;
}

function fakeClock(startMs = T0): FakeClock {
  let current = startMs;
  let nextHandle = 0;
  let armed: { ms: number; handle: number } | null = null;
  let armCount = 0;
  const table = new Map<number, () => void>();

  const fire = (handle: number): void => {
    const handler = table.get(handle);
    table.delete(handle);
    armed = null;
    handler?.();
  };

  return {
    now: () => new Date(current),
    setTimer: (handler, ms) => {
      nextHandle += 1;
      armCount += 1;
      armed = { ms, handle: nextHandle };
      table.set(nextHandle, handler);
      return nextHandle;
    },
    clearTimer: (handle) => {
      table.delete(handle as number);
      if (armed?.handle === handle) armed = null;
    },
    pending: () => (armed === null ? null : { ...armed }),
    advance: (ms) => {
      current += ms;
      const due = armed;
      if (due !== null && ms >= due.ms) fire(due.handle);
    },
    arms: () => armCount,
  };
}

/** 投影替身：只用得到 lastAssistantAt / lastWake / idleTicks / pressure */
function projectionOf(patch: Partial<Projection> = {}): Projection {
  return { ...emptyProjection(), ...patch };
}

interface Harness {
  clock: FakeClock;
  /** 最近一次交付的事实 */
  firings: HeartbeatFiring[];
  /** 建一个心跳（附投影）：投影是副本，测试改它不影响别人 */
  make: (patch?: Partial<Projection>, options?: OptionsForTest) => { beat: Heartbeat; projection: Projection };
}

interface OptionsForTest {
  floorMs?: number;
  ceilMs?: number;
  tickMs?: number;
  /** 目标均值（毫秒）：给了它，α 由 `solveHeartbeatAlpha` 在构造时反解（⑧ 用的就是它） */
  targetMeanMs?: number;
  shapeAlpha?: number;
  random?: () => number;
  policy?: () => 'fire' | 'skip' | null;
  /**
   * "最后一次活动"的时刻（默认 = 现在，等价于刚说过话）。
   *
   * 它同时是两个量的参照：心跳内部的安静计时（取投影里的活动时刻）与事件里的 `quietSeconds`。
   * 给一个更早的时刻 = 盘面已经安静了一会儿（模拟重启后接手一个已经安静很久的实例）。
   */
  lastActivityMs?: number;
  onFire?: (firing: HeartbeatFiring) => void;
}

function makeHarness(startMs = T0): Harness {
  const clock = fakeClock(startMs);
  const firings: HeartbeatFiring[] = [];
  const make = (
    patch: Partial<Projection> = {},
    options: OptionsForTest = {},
  ): { beat: Heartbeat; projection: Projection } => {
    // 每个实例拿自己的投影副本：共享一份会被测试互相污染（这里踩过一次）
    const projection = projectionOf(patch);
    // 活动时刻落进投影（心跳从投影读安静起点，于是安静计时与 quietSeconds 共用同一个参照）。
    // 显式写了 lastWake 的用例**不覆盖**它——那正是被测量的那个字段。
    projection.lastWake ??= {
      source: 'manual',
      at: new Date(options.lastActivityMs ?? startMs).toISOString(),
    };
    const beat = new Heartbeat({
      projection,
      ...(options.floorMs !== undefined ? { floorMs: options.floorMs } : {}),
      ...(options.ceilMs !== undefined ? { ceilMs: options.ceilMs } : {}),
      ...(options.tickMs !== undefined ? { tickMs: options.tickMs } : {}),
      ...(options.targetMeanMs !== undefined ? { targetMeanMs: options.targetMeanMs } : {}),
      ...(options.shapeAlpha !== undefined ? { shapeAlpha: options.shapeAlpha } : {}),
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
      random: options.random ?? seeded(),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onFire: (firing) => {
        firings.push(firing);
        options.onFire?.(firing);
      },
    });
    return { beat, projection };
  };
  return { clock, firings, make };
}

/**
 * 端到端驱动：从"刚有活动"开始，每次推进一个 tick 直到触发（或到上限）。
 * 返回这次触发对应的安静时长（毫秒）= 时钟从活动时刻走到触发时刻的距离——
 * 与心跳算概率用的那个量、与事件里的 `quietSeconds` 同一个口径。
 * 推进量必须是 tick 的整数倍，否则假闹钟可能跳过一整拍。
 */
function runUntilFire(beat: Heartbeat, clock: FakeClock, capMs = CEIL + 10 * MIN): number {
  const before = beat.beatCount;
  let elapsed = 0;
  while (elapsed < capMs) {
    clock.advance(TICK);
    elapsed += TICK;
    // 判据是"这一轮**新**触发了一拍"：拿 beatCount > 0 会在第二轮起立刻为真
    if (beat.beatCount > before) return elapsed;
  }
  throw new Error(`推进 ${capMs / MIN} 分钟仍未触发——上限失效了`);
}

/** 模拟 RUNS 轮"安静 → 触发"：返回每轮的安静时长（毫秒） */
function simulateRuns(runs: number, seed = SEED, extra: OptionsForTest = {}): number[] {
  const harness = makeHarness();
  const { beat } = harness.make({}, { random: seeded(seed), ...extra });
  beat.start();
  const quies = [];
  for (let i = 0; i < runs; i++) {
    quies.push(runUntilFire(beat, harness.clock));
    beat.noteActivity(); // 下一轮从"安静 0"重新开始（与真实复位同一条路）
  }
  beat.stop();
  return quies;
}

/** 模拟结果的摘要（均值/中位数/分位数/最大值）：⑧ 的验收要连这些数一起报出来 */
function summarize(quies: number[]): {
  meanMin: number; medianMin: number; p5Min: number; p95Min: number; minMin: number; maxMin: number;
} {
  const sorted = [...quies].sort((a, b) => a - b);
  return {
    meanMin: quies.reduce((a, b) => a + b, 0) / quies.length / MIN,
    medianMin: quantile(sorted, 0.5) / MIN,
    p5Min: quantile(sorted, 0.05) / MIN,
    p95Min: quantile(sorted, 0.95) / MIN,
    minMin: sorted[0]! / MIN,
    maxMin: sorted[sorted.length - 1]! / MIN,
  };
}

function quietEvent(data: WakeHeartbeat['data'], seq = 1): AppEvent {
  return {
    seq,
    ts: new Date(T0).toISOString(),
    type: 'wake/heartbeat',
    data,
    visibility: 'model',
    origin: 'test',
  } as unknown as AppEvent;
}

/** 排序后取分位数（p 用 0~1 的比例） */
function quantile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

// ──────────────────── ① 下限：安静不足 5 分钟绝不触发 ────────────────────

test('① 安静不足下限：一次都不触发（不是概率小，是概率恒为 0）', () => {
  // 纯函数层：下限以下的每一分钟都必须是 0
  for (const quietMin of [0, 0.5, 1, 2, 3, 4, 4.9, 4.999]) {
    assert.equal(
      heartbeatProbability(quietMin * MIN, FLOOR, CEIL, HEARTBEAT_SHAPE_ALPHA), 0,
      `安静 ${quietMin} 分钟的命中概率必须是 0`,
    );
  }
  assert.equal(heartbeatProbability(FLOOR, FLOOR, CEIL, HEARTBEAT_SHAPE_ALPHA), 0, '下限那一刻正好是 0');

  // 端到端：拿一个"总是掷出 0.001"的随机源（任何 >0 的概率都会命中），
  // 于是"没触发"只可能是因为概率是 0——这比挑一个种子强得多
  const harness = makeHarness();
  const { beat } = harness.make({}, { random: always(0.001) });
  beat.start();

  for (let i = 1; i <= 5; i++) {
    harness.clock.advance(TICK);
    assert.equal(beat.beatCount, 0, `安静 ${i} 分钟时不该触发（下限 ${FLOOR / MIN} 分钟）`);
    assert.deepEqual(harness.firings, [], '下限之下不交付任何事实');
  }
});

// ──────────────────── ② 上限：安静满 60 分钟必然触发 ────────────────────

test('② 安静到上限必然触发：p = 1，且掷出再大的数也会响', () => {
  assert.equal(heartbeatProbability(CEIL, FLOOR, CEIL, HEARTBEAT_SHAPE_ALPHA), 1, '上限处 p = 1');
  assert.equal(heartbeatProbability(CEIL + 30 * MIN, FLOOR, CEIL, HEARTBEAT_SHAPE_ALPHA), 1, '超过上限仍是 1');

  // 端到端：随机源永远掷到 [0,1) 里最大的那一档（0.999…），只有 p = 1 才可能命中。
  // 盘面直接从"安静 59 分钟"开始（投影里上次活动在 59 分钟前）→ 下一个抽签点正好是 60 分钟。
  const harness = makeHarness();
  const { beat } = harness.make({}, { random: always(0.999999), lastActivityMs: T0 - 59 * MIN });
  beat.start();
  assert.equal(beat.quietMs(), 59 * MIN, '盘面安静 59 分钟');

  harness.clock.advance(TICK); // → 60 分钟
  assert.equal(beat.beatCount, 1, '整整 60 分钟必须触发');
  assert.equal(harness.firings.length, 1);
  assert.equal(harness.firings[0]?.probability, 1, '这一拍用的概率是 1');
  assert.ok((harness.firings[0]?.roll ?? 1) < 1);
  beat.stop();
});

test('② 安静恰好在 60 分钟前一点仍未到上限时，p 仍小于 1（上限是唯一的必然点）', () => {
  const p59 = heartbeatProbability(59 * MIN, FLOOR, CEIL, HEARTBEAT_SHAPE_ALPHA);
  assert.ok(p59 < 1, `安静 59 分钟的 p=${p59} 必须小于 1`);
  assert.ok(p59 > 0.9, `但已经很接近必然（p=${p59}），否则尾巴太肥`);
});

// ──────────────────── ③ 单调性：p 随安静时间不递减 ────────────────────

test('③ p 随安静时间单调不减（逐分钟断言，不是抽样）', () => {
  let previous = -1;
  for (let quietMin = 0; quietMin <= CEIL / MIN + 10; quietMin++) {
    const p = heartbeatProbability(quietMin * MIN, FLOOR, CEIL, HEARTBEAT_SHAPE_ALPHA);
    assert.ok(p >= previous, `安静 ${quietMin} 分钟的 p=${p} 不应低于上一分钟的 ${previous}`);
    assert.ok(p <= 1 && p >= 0, '概率必须落在 [0,1]');
    previous = p;
  }
  // 中段确实在涨（别只剩两端两个常数）：每多安静 5 分钟，p 都要更大
  for (const quietMin of [5, 10, 20, 30, 45, 55]) {
    assert.ok(
      heartbeatProbability((quietMin + 5) * MIN, FLOOR, CEIL, HEARTBEAT_SHAPE_ALPHA)
        > heartbeatProbability(quietMin * MIN, FLOOR, CEIL, HEARTBEAT_SHAPE_ALPHA),
      `安静 ${quietMin} → ${quietMin + 5} 分钟，p 必须上升`,
    );
  }
  // α 是幂次：中点的 p 略低于线性（线性中点 = 0.5），但整条曲线更饱满、均值落得更中间。
  // 这一条把"为什么不是线性"钉住：线性（α=1）的均值只有 13.98、p5 = 7 分钟，
  // 5~10 分钟就触发掉 29.5%；α=1.1 把这些重量往中间挪（见 _research/ 的标定表）。
  const mid = heartbeatProbability((FLOOR + CEIL) / 2, FLOOR, CEIL, HEARTBEAT_SHAPE_ALPHA);
  assert.ok(Math.abs(mid - 0.5 ** HEARTBEAT_SHAPE_ALPHA) < 1e-12, `中点的 p=${mid} 应等于 0.5^α`);
  assert.ok(mid < 0.5, 'α>1 的形状在中点低于线性——换来的是更靠中间的均值与更薄的短尾');
});

// ────────────── ④ 模拟 10000 次：均值落在 10~20 分钟 ──────────────

test(`④ 模拟 ${RUNS} 次（注入固定种子）：均值落在 10~20 分钟`, () => {
  const quies = simulateRuns(RUNS);
  const sorted = [...quies].sort((a, b) => a - b);
  const meanMin = quies.reduce((a, b) => a + b, 0) / quies.length / MIN;
  const medianMs = quantile(sorted, 0.5);
  const p5Ms = quantile(sorted, 0.05);
  const p95Ms = quantile(sorted, 0.95);

  // 判据本体：均值必须落在用户给的区间
  assert.ok(meanMin >= 10 && meanMin <= 20, `均值 ${meanMin.toFixed(2)} 分钟必须落在 10~20`);
  // 钉一个更窄的带子：现在实测约 15，漂出去 1 分钟就说明分布被动过（改 α/上下限都会撞这里）
  assert.ok(meanMin > 14 && meanMin < 16, `均值 ${meanMin.toFixed(2)} 分钟应钉在 15 附近（标定值见源码注释）`);

  // 验收要求一并报出来的分位数与两个极端比例
  assert.equal(quies.filter(q => q < FLOOR).length, 0, '5 分钟内触发比例必须是 0');
  assert.equal(quies.filter(q => q === FLOOR).length, 0, '恰好 5 分钟也不该触发（下限那一刻 p=0）');
  assert.equal(quies.filter(q => q >= CEIL).length, 0, '没有一轮需要拖到 60 分钟——尾巴不该那么肥');
  assert.ok(sorted[0]! >= FLOOR + TICK, `最早的一拍不早于"下限 + 一个 tick"，实测 ${sorted[0]! / MIN} 分钟`);
  assert.equal(medianMs / MIN, 15, `中位数 ${medianMs / MIN} 分钟`);
  assert.equal(p5Ms / MIN, 8, `p5 = ${p5Ms / MIN} 分钟`);
  assert.equal(p95Ms / MIN, 24, `p95 = ${p95Ms / MIN} 分钟`);
  assert.ok(p95Ms - p5Ms > 10 * MIN, '5~60 分钟"不等"：跨度要够宽，不能挤成一坨');

  // 解析值独立互校（两条路径，防"公式写歪了但模拟恰好掩盖"）
  const analytic = heartbeatMeanMs(FLOOR, CEIL, TICK, HEARTBEAT_SHAPE_ALPHA) / MIN;
  assert.ok(Math.abs(analytic - meanMin) < 0.5, `解析均值 ${analytic.toFixed(2)} 应与实测 ${meanMin.toFixed(2)} 一致`);
});

test('④ 换一个种子结论不变（不是"挑了个好种子"）', () => {
  for (const seed of [1, 0x1234abcd, 0xdeadbeef]) {
    const quies = simulateRuns(2_000, seed);
    const meanMin = quies.reduce((a, b) => a + b, 0) / quies.length / MIN;
    assert.ok(meanMin >= 10 && meanMin <= 20, `种子 ${seed.toString(16)} 的均值 ${meanMin.toFixed(2)} 分钟仍在 10~20`);
  }
});

test('④ 分布摘要（启动日志与状态页读它）与判据一致', () => {
  const harness = makeHarness();
  const { beat } = harness.make();
  const dist = beat.distribution;
  assert.equal(dist.floorMs, FLOOR);
  assert.equal(dist.ceilMs, CEIL);
  assert.equal(dist.tickMs, TICK);
  assert.equal(dist.alpha, HEARTBEAT_SHAPE_ALPHA);
  const meanMin = dist.meanMs / MIN;
  assert.ok(meanMin > 14 && meanMin < 16, `摘要里的均值 ${meanMin.toFixed(2)} 分钟`);
});

// ──────────────────── ⑤ 复位：外部事件重新计时 ────────────────────

test('⑤ 外部事件复位：安静计时归零，重新从抽签起点开始', () => {
  const harness = makeHarness();
  const { beat } = harness.make({}, { random: always(0.001) });
  beat.start();

  // 先触发一拍（6 分钟），确认链路是活的
  harness.clock.advance(6 * TICK);
  assert.equal(beat.beatCount, 1, '6 分钟触发第一拍');
  assert.equal(beat.quietMs(), 0, '触发即复位：安静计时归零');

  // 再安静到"下一次本该触发"的位置之前复位：之后必须重新从 0 数起
  harness.clock.advance(5 * TICK);
  assert.equal(beat.quietMs(), 5 * MIN, '安静 5 分钟');
  const armsBefore = harness.clock.arms();
  beat.noteActivity();
  assert.ok(harness.clock.arms() > armsBefore, '复位必须重新布防');
  assert.equal(beat.quietMs(), 0, '复位把安静计时归零');
  assert.equal(harness.clock.pending()?.ms, TICK, '复位后下一次抽签在一个 tick 之后');

  // 复位之后要重新安静满下限才可能触发（外部事件的价值就在这里）
  harness.clock.advance(TICK);
  assert.equal(beat.beatCount, 1, '安静 1 分钟不可能触发');
  harness.clock.advance(5 * TICK); // → 安静 6 分钟
  assert.equal(beat.beatCount, 2, '重新安静到 6 分钟才触发');
  beat.stop();
});

test('⑤ 心跳自己不复位：下一拍仍从"触发那一刻"重新起算，空拍持续累计', () => {
  const harness = makeHarness();
  const { beat, projection } = harness.make({}, { random: always(0.5) });
  beat.start();
  const onFire = (firing: HeartbeatFiring): void => {
    projection.idleTicks = firing.idleTicks; // 模拟 fold：心跳事件把空拍折进投影
  };
  beat.setOnFire(onFire);

  // 概率命中即**新一轮**的起点（更新过程：命中 → 复位 → 重新抽签），
  // 所以每一轮的安静时长都独立同分布，而不是越往后越长。
  const first = runUntilFire(beat, harness.clock);
  assert.ok(first >= FLOOR + TICK, `第一轮不早于"下限 + 一个 tick"（实测 ${first / MIN} 分钟）`);
  const second = runUntilFire(beat, harness.clock);
  assert.ok(second >= FLOOR + TICK, `第二轮同样不早于下限（实测 ${second / MIN} 分钟）`);
  assert.equal(beat.beatCount, 2);
  // 空拍是**另一本账**：它只在外部事件到达时归零，于是连续空转时一直累计
  assert.equal(projection.idleTicks, 2, '空拍连续累计（诊断用：它不再参与排期）');
  beat.stop();
});

test('⑤ 重启不重置：安静计时取投影里最后一次活动的时刻', () => {
  // 进程刚起来，但"她上次开口"是 20 分钟前：第一拍该按安静 20 分钟算，不按 0 算。
  // （旧模型每次重启都把定时器从零重新布防，实测出现过 128/166/256 分钟的空档。）
  const harness = makeHarness();
  const { beat } = harness.make({ lastAssistantAt: new Date(T0 - 20 * MIN).toISOString() }, { random: always(0.001) });
  beat.start();

  assert.equal(beat.quietMs(), 20 * MIN, '安静时长从投影算起，不从进程启动算起');
  const elapsed = runUntilFire(beat, harness.clock);
  assert.ok(elapsed <= 2 * MIN, `已经安静 20 分钟，第一拍该很快响（实测又等了 ${elapsed / MIN} 分钟）`);
  beat.stop();
});

// ────────────── ⑥ 可审计：事件带 probability / roll ──────────────

test('⑥ 触发的事件带 probability 与 roll，且判据 roll < probability 可复算', () => {
  const harness = makeHarness();
  const written: WakeHeartbeat['data'][] = [];
  const sink: HeartbeatSink = { emitHeartbeat: (data) => written.push(data) };
  const { beat } = harness.make({}, { random: seeded() });
  const source = new HeartbeatSource(beat, sink);
  assert.equal(source.name, 'heartbeat');

  source.start();
  const quietMs = runUntilFire(beat, harness.clock);
  source.stop();

  assert.equal(written.length, 1, '触发一次就落一条事件');
  const data = written[0]!;
  assert.deepEqual(
    Object.keys(data).sort(),
    ['idleTicks', 'pressure', 'probability', 'quietSeconds', 'roll'],
    '五键齐备：quietSeconds/idleTicks/pressure + 审计用的 probability/roll',
  );

  // 复算：用事件自带的安静时长重算概率，必须与事件里的 probability 一致（q 取整到 tick）
  const quietRounded = quietMs - (quietMs % TICK);
  const expected = heartbeatProbability(quietRounded, FLOOR, CEIL, HEARTBEAT_SHAPE_ALPHA);
  assert.ok(Math.abs(data.probability - expected) < 1e-12,
    `事件里的 probability=${data.probability} 应等于按安静时长重算的 ${expected}`);
  assert.ok(data.roll >= 0 && data.roll < 1, 'roll 是 [0,1) 里的数');
  assert.ok(data.roll < data.probability, `roll ${data.roll} < probability ${data.probability}（这一拍为什么响）`);
  assert.equal(data.quietSeconds, Math.floor(quietMs / 1000), 'quietSeconds 与安静时长一致');
});

test('⑥ 没触发的那几拍不留痕：事件只在触发时产生', () => {
  const harness = makeHarness();
  const written: WakeHeartbeat['data'][] = [];
  const sink: HeartbeatSink = { emitHeartbeat: (data) => written.push(data) };
  const { beat } = harness.make({}, { random: always(0.001) });
  new HeartbeatSource(beat, sink).start();

  harness.clock.advance(TICK); // 安静 1 分钟：抽都不抽
  assert.deepEqual(written, [], '未触发不落事件');
  assert.equal(beat.lastDraw(), null, '都没抽过签，就不该有"最近一次抽签"');

  harness.clock.advance(5 * TICK); // → 6 分钟：触发
  // 显式标类型读回：前面那句 `assert.deepEqual(written, [])` 会把 TS 的流分析钉在"这个数组是空的"上，
  // 于是后面的 `written[0]` 被收窄成 never（运行期当然不是）。标清类型即可，断言本身不变
  const firedEvents = written as WakeHeartbeat['data'][];
  assert.equal(firedEvents.length, 1);
  assert.deepEqual(beat.lastDraw(), {
    probability: firedEvents[0]!.probability,
    roll: firedEvents[0]!.roll,
  });
  beat.stop();
});

test('⑥ quietSeconds：优先距上次发言，其次距上次被唤醒，缺参照为 0', () => {
  /**
   * 这一条只断言**真实成立的性质**（谁优先 / 谁兜底 / 无效参照怎么办），不做手工时序推算。
   *
   * 测法：同一个盘面，每轮触发前后把 `patch` 应用到一个"参照记录"上，然后**读回真正用的那个参照**
   * （`lastAssistantAt ?? lastWake.at`），再断言 `quietSeconds` 与"触发时刻 − 那个参照"一致——
   * 参照与触发时刻都是当场量出来的，测试里没有一个手算出来的时间常数。
   * （教训：先前几版试图精确算出"第 3 条用例会在第几分钟触发"，差一个 tick 就红，
   *   而红的原因与被测行为无关。）
   */
  const harness = makeHarness();
  let reference: { lastAssistantAt: string | null; lastWakeAt: string | null } =
    { lastAssistantAt: null, lastWakeAt: null };
  const { beat, projection } = harness.make(
    { lastAssistantAt: null, lastWake: null },
    // 恒定随机源：第一次够得着下限的抽签必中（roll = −1 < 任何正概率），
    // 于是"什么时候响"只由下限决定，测试里不用猜第几拍命中
    { random: always(-1) },
  );
  beat.start();

  const fireWith = (patch: { lastAssistantAt?: string | null; lastWakeAt?: string | null }): {
    quietSeconds: number; expected: number; usedReference: string | null;
  } => {
    reference = { ...reference, ...patch };
    // 让投影跟着 patch 走：下一轮起点 = 触发时刻（quietSeconds 的参照始终是投影里那两栏）
    if (patch.lastAssistantAt !== undefined) projection.lastAssistantAt = patch.lastAssistantAt;
    if (patch.lastWakeAt !== undefined) {
      projection.lastWake = patch.lastWakeAt === null
        ? null
        : { source: 'manual', at: patch.lastWakeAt };
    }
    harness.firings.length = 0;
    runUntilFire(beat, harness.clock);
    const firing = harness.firings.at(-1)!;
    const usedReference = reference.lastAssistantAt ?? reference.lastWakeAt;
    const nowMs = harness.clock.now().getTime();
    const expected = usedReference === null || Date.parse(usedReference) > nowMs
      ? 0
      : Math.floor((nowMs - Date.parse(usedReference)) / 1000);
    return { quietSeconds: firing.quietSeconds, expected, usedReference };
  };

  // ① 两个参照都有、发言更近 → 用发言
  const both = fireWith({
    lastAssistantAt: new Date(T0 - 10 * MIN).toISOString(),
    lastWakeAt: new Date(T0 - 20 * 3600_000).toISOString(),
  });
  assert.equal(both.usedReference, new Date(T0 - 10 * MIN).toISOString(), '发言更近');
  assert.equal(both.quietSeconds, both.expected, '安静时长按"距上次开口"算');
  assert.ok(both.quietSeconds < 20 * 3600, '没有退回用 20 小时前的那次唤醒');

  // ② 没有发言记录 → 退回"上次被唤醒"
  const woken = fireWith({
    lastAssistantAt: null,
    lastWakeAt: new Date(T0 - 20 * 3600_000).toISOString(),
  });
  assert.equal(woken.usedReference, new Date(T0 - 20 * 3600_000).toISOString(), '发言缺失时用唤醒');
  assert.equal(woken.quietSeconds, woken.expected, '安静时长按"距上次被唤醒"算');
  assert.ok(woken.quietSeconds >= 20 * 3600, `实测 ${woken.quietSeconds}s`);

  // ③ 两个参照都没有（全新实例）→ 0：**不拿环境时钟硬算**，
  //    否则必要性门会把"全新实例"误判成"很久没说话"
  const fresh = fireWith({ lastAssistantAt: null, lastWakeAt: null });
  assert.equal(fresh.usedReference, null);
  assert.equal(fresh.quietSeconds, 0, '全新实例不凭空造一个巨大安静时长');

  // ④ 参照时刻在未来（时钟回拨）→ 归零，不给负数。
  //    两个参照都得摆到未来：字段取的是 `lastAssistantAt ?? lastWake`，只把发言摆到未来、
  //    留着 `lastWake` 在过去，它会退回用 wake 算（实测踩过：得到 360 而不是 0）
  assert.equal(
    fireWith({
      lastAssistantAt: new Date(T0 + 3600_000).toISOString(),
      lastWakeAt: new Date(T0 + 1800_000).toISOString(),
    }).quietSeconds,
    0,
    '参照时刻在未来时归零，不给负数',
  );
  beat.stop();
});

// ──────────────────── ⑦ 节律策略与退化输入（既有行为） ────────────────────

test('节律策略返回 null：被否决的那拍不产生事实，也不把安静计时归零', () => {
  const harness = makeHarness();
  const { beat } = harness.make({}, { random: always(0.001), policy: () => null });
  beat.start();

  harness.clock.advance(6 * TICK); // 安静 6 分钟：本该命中
  assert.equal(beat.beatCount, 0, '被否决的一拍不计入心跳数');
  assert.deepEqual(harness.firings, [], '否决不交付任何事实');
  assert.equal(harness.clock.pending()?.ms, POLICY_RECHECK_MS, '重查排到 POLICY_RECHECK_MS 之后');
  assert.equal(beat.quietMs(), 6 * MIN, '安静计时不归零——重查时 p 只会更高');

  // 策略改口（热更）：重查到点时按"已经安静 36 分钟"的概率抽签
  beat.setPolicy(() => 'fire');
  harness.clock.advance(POLICY_RECHECK_MS);
  assert.equal(beat.beatCount, 1);
  // 同上：`beatCount > before` 这个比较会把 TS 的流分析钉在"firings 还是空的"上
  const fired = harness.firings as HeartbeatFiring[];
  assert.equal(fired.length, 1);
  const p36 = heartbeatProbability(36 * MIN, FLOOR, CEIL, HEARTBEAT_SHAPE_ALPHA);
  assert.equal(fired[0]!.probability, p36, '用的是重查那一刻的真实安静时长');
  beat.stop();
});

test("策略返回 'skip' 与 null 等价；返回 'fire' 照常", () => {
  const skip = makeHarness();
  const skipped = skip.make({}, { random: always(0.001), policy: () => 'skip', lastActivityMs: T0 - 60 * MIN });
  skipped.beat.start();
  skip.clock.advance(TICK);
  assert.equal(skipped.beat.beatCount, 0);

  const fire = makeHarness();
  const fired = fire.make({}, { random: always(0.001), policy: () => 'fire', lastActivityMs: T0 - 60 * MIN });
  fired.beat.start();
  fire.clock.advance(TICK);
  assert.equal(fired.beat.beatCount, 1);
});

test('策略抛错按照常心搏处理：心跳不允许被策略 bug 掐死', () => {
  const harness = makeHarness();
  const { beat } = harness.make({}, {
    random: always(0.001),
    lastActivityMs: T0 - 60 * MIN,
    policy: () => {
      throw new Error('策略炸了');
    },
  });
  beat.start();
  harness.clock.advance(TICK);
  assert.equal(beat.beatCount, 1, '策略异常时仍必须心跳');
});

test('退化输入不产生热循环：非法时长落回默认，tick 不超过下限', () => {
  const harness = makeHarness();
  const degenerate = harness.make({}, {
    floorMs: 0, ceilMs: Number.NaN, tickMs: -5,
  }).beat.distribution;
  assert.equal(degenerate.floorMs, FLOOR, '非法下限落回 5 分钟');
  assert.equal(degenerate.ceilMs, CEIL, '非法上限落回 60 分钟');
  assert.equal(degenerate.tickMs, TICK, '非法 tick 落回 1 分钟');

  const inverted = harness.make({}, { floorMs: 20 * MIN, ceilMs: 5 * MIN }).beat;
  assert.equal(inverted.distribution.ceilMs, 20 * MIN, '上限低于下限时取上限 = 下限（静默更久才是坏方向）');
  assert.equal(
    heartbeatProbability(20 * MIN, 20 * MIN, 20 * MIN, HEARTBEAT_SHAPE_ALPHA), 1,
    '上下限相等：到点必响，不留中间地带',
  );

  const fastTick = harness.make({}, { floorMs: 5 * MIN, tickMs: 30 * MIN }).beat;
  assert.equal(fastTick.distribution.tickMs, 5 * MIN, 'tick 超过下限时夹到下限，下限必须仍是下界');
});

test('布防幂等：start 重复调用不叠加定时器；stop 后不再触发', () => {
  const harness = makeHarness();
  const { beat } = harness.make({}, { random: always(0.001) });

  beat.start();
  const afterFirst = harness.clock.arms();
  beat.start();
  assert.equal(harness.clock.arms(), afterFirst, '重复 start 不重新布防');

  beat.stop();
  assert.equal(harness.clock.pending(), null, 'stop 清掉在途定时器');
  harness.clock.advance(600 * MIN);
  assert.equal(beat.beatCount, 0, 'stop 之后不再心跳');
});

test('首次布防：不早于下限，也没有把首拍排到上限之后', () => {
  const harness = makeHarness();
  const { beat } = harness.make();
  beat.start();
  const first = harness.clock.pending()?.ms ?? 0;
  assert.ok(first <= TICK, `首拍布防 ${first}ms 应在一个 tick 之内开始抽签（下限才是门槛）`);
  beat.stop();
});

test('心跳事件替身形状与 schema 一致（提醒：改 schema 必须同步这里）', () => {
  const event = quietEvent({ quietSeconds: 30, idleTicks: 1, pressure: 0.05, probability: 0.4, roll: 0.2 });
  assert.deepEqual(
    Object.keys(event.data as object).sort(),
    ['idleTicks', 'pressure', 'probability', 'quietSeconds', 'roll'],
  );
});

test('可复现的随机源：同种子同序列，不同种子不同序列', () => {
  const a = seeded(SEED);
  const b = seeded(SEED);
  const c = seeded(SEED + 1);
  const seqA = [a(), a(), a(), a()];
  const seqB = [b(), b(), b(), b()];
  const seqC = [c(), c(), c(), c()];
  assert.deepEqual(seqA, seqB, '同种子必须给出同一串数（模拟才可复跑）');
  assert.notDeepEqual(seqA, seqC, '换种子该换序列');
  for (const value of seqA) assert.ok(value >= 0 && value < 1, '随机数落在 [0,1)');
});

// ────────── ⑧ 目标均值：改频率只需要给均值，α 是解出来的（2026-02-06） ──────────

/**
 * 用户的问题与口径（这一节存在的理由）：
 *
 * > 「心跳频率我没有地方可以控制吗？」
 *
 * 之前只有 floor / ceil / tick 三个旋钮（调的是**区间**），而**均值**由代码里写死的 α=1.1 定死，
 * 没有一个"说人话"的旋钮。现在配置里有 `wake.heartbeatTargetMeanMin`（目标均值，出厂默认 45），
 * α 由它在启动时**反解**出来——这一节把"改均值真的改得动、且改出来就是那个均值"钉住。
 *
 * 判据只紧不松：模拟一律 ≥20000 次、固定种子（SEED），并**走真实心跳类**（假闹钟 + 注入随机源），
 * 不另写一份概率公式——两份公式漂起来正是这类改动最容易坏的地方。
 */
const TARGET_RUNS = 20_000;

/** 目标均值的配置解析（③ 的判据在配置层：写错的三种方式必须当场报配置错） */
async function freshConfigDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await tempDir('irmia-heartbeat-config-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  return resolve(dir);
}

test('⑧ 目标 15 分钟：解出 α ≈ 1.1（自洽点），20000 次模拟均值落在 14~16 分钟', () => {
  const targetMs = 15 * MIN;

  // ① 自洽点：目标正好是现在这套分布的 15 分钟 ⇒ 解出来必须≈历史标定值 α = 1.1
  const solved = solveHeartbeatAlpha(FLOOR, CEIL, TICK, targetMs);
  assert.ok(Math.abs(solved - HEARTBEAT_SHAPE_ALPHA) < 0.01,
    `目标 15 分钟解出 α=${solved}，应与标定值 ${HEARTBEAT_SHAPE_ALPHA} 一致（差 ${Math.abs(solved - 1.1)}）`);
  // 与 _research/heartbeat-dist-calibrate.mjs 的反推值同源（那里扫出 1.103180）
  assert.ok(Math.abs(solved - 1.103180) < 1e-5, `解出的 α=${solved} 应与标定表里的 1.103180 对上`);

  // ② 两条独立路径互校：解出来的 α 用 pmf 算回的均值必须是目标本身
  const analytic = heartbeatMeanMs(FLOOR, CEIL, TICK, solved) / MIN;
  assert.ok(Math.abs(analytic - 15) < 1e-6, `解析均值 ${analytic} 必须打回目标 15 分钟`);
  // 兜底常量那一份（α = 1.1）的解析均值也要落在 14~16："默认 15 分钟"与"α = 1.1"两个说法自洽
  const legacy = heartbeatMeanMs(FLOOR, CEIL, TICK, HEARTBEAT_SHAPE_ALPHA) / MIN;
  assert.ok(Math.abs(legacy - 15) < 0.05, `α = 1.1 的解析均值 ${legacy} 应贴着 15 分钟`);

  // ③ 实测：走真实心跳类的 20000 轮模拟
  const quies = simulateRuns(TARGET_RUNS, SEED, { targetMeanMs: targetMs });
  const s = summarize(quies);
  assert.equal(quies.length, TARGET_RUNS);
  assert.ok(s.meanMin >= 14 && s.meanMin <= 16,
    `目标 15 分钟：实测均值 ${s.meanMin.toFixed(3)} 分钟必须落在 14~16（中位数 ${s.medianMin}、`
    + `p5 ${s.p5Min}、p95 ${s.p95Min}、最小 ${s.minMin}、最大 ${s.maxMin}）`);
  // 固定种子下这一条是确定的：把实测均值钉到解析值附近，漂了就说明分布被动过
  assert.ok(Math.abs(s.meanMin - analytic) < 0.5,
    `实测均值 ${s.meanMin.toFixed(3)} 应与解析均值 ${analytic.toFixed(3)} 互校在 0.5 分钟内`);

  // ④ 分布摘要里三个数齐备：目标、解出来的 α、解析均值（启动日志与诊断读它）
  const dist = makeHarness().make({}, { targetMeanMs: targetMs }).beat.distribution;
  assert.equal(dist.targetMeanMs, targetMs, '摘要里要报出目标均值');
  assert.equal(dist.alpha, solved, '摘要里的 α 就是解出来的那个（不是兜底常量）');
  assert.ok(Math.abs(dist.meanMs - targetMs) < 1e-3, '摘要里的解析均值就是目标本身');
});

test('⑧ 目标 30 分钟：解出的 α 与 15 分钟不同，20000 次模拟均值落在 28~32 分钟', () => {
  const targetMs = 30 * MIN;
  const solved = solveHeartbeatAlpha(FLOOR, CEIL, TICK, targetMs);
  assert.ok(solved > HEARTBEAT_SHAPE_ALPHA,
    `"更慢"必须解出更大的 α（实测 α=${solved}）：q<1 时 α 越大 p 越小、等得越久`);
  assert.ok(Math.abs(heartbeatMeanMs(FLOOR, CEIL, TICK, solved) - targetMs) < 1e-3,
    '解出来的 α 必须把解析均值打回 30 分钟');

  const quies = simulateRuns(TARGET_RUNS, SEED, { targetMeanMs: targetMs });
  const s = summarize(quies);
  assert.ok(s.meanMin >= 28 && s.meanMin <= 32,
    `目标 30 分钟：实测均值 ${s.meanMin.toFixed(3)} 分钟必须落在 28~32（中位数 ${s.medianMin}、`
    + `p5 ${s.p5Min}、p95 ${s.p95Min}、最小 ${s.minMin}、最大 ${s.maxMin}）`);
  assert.ok(Math.abs(s.meanMin - 30) < 0.5, `实测均值 ${s.meanMin.toFixed(3)} 应贴着目标 30 分钟`);

  // "5~60 分钟不等"这条口径在新 α 下照旧成立：跨度要够宽，不能挤成一坨
  assert.ok(s.p95Min - s.p5Min > 15, `p5 ${s.p5Min} → p95 ${s.p95Min}：跨度要够宽（> 15 分钟）`);
  assert.ok(s.minMin >= (FLOOR + TICK) / MIN, `最早的一拍不早于"下限 + 一个 tick"（实测 ${s.minMin} 分钟）`);
  assert.ok(s.maxMin < CEIL / MIN, `没有一轮拖到 60 分钟（实测最大 ${s.maxMin} 分钟）`);
});

test('⑧ 反解是确定的：同输入同输出、无随机、越慢的目标准出越大的 α', () => {
  const once = solveHeartbeatAlpha(FLOOR, CEIL, TICK, 20 * MIN);
  const twice = solveHeartbeatAlpha(FLOOR, CEIL, TICK, 20 * MIN);
  assert.equal(once, twice, '同一个目标必须每次都解出同一个 α（确定性：二分 + 固定步数）');

  let previous = 0;
  for (const targetMin of [7, 10, 15, 20, 30, 45, 59]) {
    const alpha = solveHeartbeatAlpha(FLOOR, CEIL, TICK, targetMin * MIN);
    assert.ok(alpha > previous, `目标 ${targetMin} 分钟解出 α=${alpha}，应严格大于上一个目标（均值随 α 单调不减）`);
    const mean = heartbeatMeanMs(FLOOR, CEIL, TICK, alpha) / MIN;
    assert.ok(Math.abs(mean - targetMin) < 1e-3,
      `目标 ${targetMin} 分钟：解出的 α 必须把解析均值打回目标（实得 ${mean}）`);
    previous = alpha;
  }

  // 够不着的两端取搜索边界并**如实返回**，不抛错也不偷偷换目标（配置层已卡住 (floor, ceil)，
  // 这里管的是 tick 粒度带来的可达性：tick=5 时"最短均值"= floor + tick = 10 分钟）
  assert.ok(solveHeartbeatAlpha(5 * MIN, 60 * MIN, 5 * MIN, 6 * MIN) < 0.001,
    '比"最快"还快的目标取搜索下界（α→0：第一拍必中 ⇒ 均值 = floor + tick）');
  assert.equal(solveHeartbeatAlpha(FLOOR, CEIL, TICK, 90 * MIN), 256, '比"最慢"还慢的目标取搜索上界');
  // 退化/非法输入不编个数出来：落回兜底 α（分布摘要里的解析均值才是实际值）
  assert.equal(solveHeartbeatAlpha(FLOOR, FLOOR, TICK, 15 * MIN), HEARTBEAT_SHAPE_ALPHA, '退化区间');
  assert.equal(solveHeartbeatAlpha(FLOOR, CEIL, 0, 15 * MIN), HEARTBEAT_SHAPE_ALPHA, 'tick 非法');
  assert.equal(solveHeartbeatAlpha(FLOOR, CEIL, TICK, Number.NaN), HEARTBEAT_SHAPE_ALPHA, '目标非法');
});

test('⑧ 目标均值 ≤ 下限 / ≥ 上限 ⇒ 配置错，消息里带两个边界的值', async (t) => {
  const cases: { raw: object; label: string; wantCeil: number }[] = [
    { raw: { heartbeatFloorMin: 10, heartbeatCeilMin: 60, heartbeatTargetMeanMin: 10 }, label: '等于下限', wantCeil: 60 },
    { raw: { heartbeatFloorMin: 5, heartbeatCeilMin: 20, heartbeatTargetMeanMin: 20 }, label: '等于上限', wantCeil: 20 },
    // 只调大下限、没写目标均值 ⇒ 出厂默认值（45）与 floor 冲突，也要当场报错。
    // 这里 floor 必须**大于**出厂默认值才会冲突：默认值一改，写死 40 的旧用例就变成
    // "什么都没测"（而不是失败）——那是最坏的一种测试，所以 floor 跟着默认值走（50 > 45）。
    { raw: { heartbeatFloorMin: 50, heartbeatCeilMin: 90 }, label: '只调大下限、出厂默认 45 与 floor 冲突', wantCeil: 60 },
  ];
  for (const { raw, label, wantCeil } of cases) {
    const dir = await freshConfigDir(t);
    await writeFile(join(dir, CONFIG_FILE_NAME), JSON.stringify({ wake: raw, timezone: 'Asia/Shanghai' }), 'utf8');
    await assert.rejects(
      () => loadConfig(dir),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError, `${label}：必须是配置错，收到 ${String(err)}`);
        assert.equal(err.where, 'wake.heartbeatTargetMeanMin');
        // 消息里必须给出下限与"真正能填的上界"——拿到报错的人不该还得回去翻配置才知道能填什么。
        // 上界取的是两条约束的**交**（配置里的 ceil ∩ 本字段自身的 5~60），不是 np 里的 ceil 原值：
        // 报一个填进去照样报错的数（例如 ceil=90、而字段最多 60）等于指错路。
        const floor = (raw as { heartbeatFloorMin: number }).heartbeatFloorMin;
        assert.match(err.message, new RegExp(String(floor)), `${label}：消息要说清下限 ${floor}`);
        assert.match(err.message, new RegExp(String(wantCeil)), `${label}：消息要说清上界 ${wantCeil}`);
        return true;
      },
    );
  }
});

test('⑧ 换了 α，静默边界一个字没变：5 分钟内 0% 触发、60 分钟必触发', () => {
  // 用"更慢"那档（目标 30 分钟 ⇒ α ≈ 2.9）重验两端：α 只改中间的形状，碰不到两条硬边界
  const alpha = solveHeartbeatAlpha(FLOOR, CEIL, TICK, 30 * MIN);
  assert.equal(heartbeatProbability(FLOOR, FLOOR, CEIL, alpha), 0, '下限那一刻 p 恒为 0');
  for (const quietMin of [0, 1, 4, 4.999]) {
    assert.equal(heartbeatProbability(quietMin * MIN, FLOOR, CEIL, alpha), 0, `安静 ${quietMin} 分钟不触发`);
  }
  assert.equal(heartbeatProbability(CEIL, FLOOR, CEIL, alpha), 1, '到上限 p = 1');
  assert.equal(heartbeatProbability(CEIL + 30 * MIN, FLOOR, CEIL, alpha), 1, '超过上限仍是 1');

  // 端到端 ①：模拟 20000 轮，没有一轮落在下限或更早
  const quies = simulateRuns(TARGET_RUNS, SEED, { targetMeanMs: 30 * MIN });
  assert.equal(quies.filter(q => q < FLOOR + TICK).length, 0, '5 分钟内（含恰好 5 分钟）触发比例必须是 0%');
  assert.equal(quies.filter(q => q > CEIL).length, 0, '没有一轮越过 60 分钟');

  // 端到端 ②：盘面安静 59 分钟 + "永远掷出 0.999999" ⇒ 只有 p = 1 才可能响，必须是 60 分钟那一拍
  const harness = makeHarness();
  const { beat } = harness.make({}, {
    random: always(0.999999), targetMeanMs: 30 * MIN, lastActivityMs: T0 - 59 * MIN,
  });
  beat.start();
  assert.equal(beat.quietMs(), 59 * MIN);
  harness.clock.advance(TICK); // → 安静 60 分钟
  assert.equal(beat.beatCount, 1, '整整 60 分钟必须触发（与 α 无关）');
  assert.equal(harness.firings[0]?.probability, 1, '这一拍用的概率是 1');
  beat.stop();
});

test('⑧ 审计三字段照旧：probability / roll / quietSeconds，且判据可复算（用解出来的 α）', () => {
  const targetMs = 30 * MIN;
  const written: WakeHeartbeat['data'][] = [];
  const sink: HeartbeatSink = { emitHeartbeat: (data) => written.push(data) };
  const harness = makeHarness();
  const { beat } = harness.make({}, { random: seeded(), targetMeanMs: targetMs });
  const source = new HeartbeatSource(beat, sink);

  source.start();
  const quietMs = runUntilFire(beat, harness.clock);
  source.stop();

  assert.equal(written.length, 1, '触发一次就落一条事件');
  const data = written[0]!;
  assert.deepEqual(
    Object.keys(data).sort(),
    ['idleTicks', 'pressure', 'probability', 'quietSeconds', 'roll'],
    '五键齐备：quietSeconds/idleTicks/pressure + 审计用的 probability/roll',
  );

  // 复算：事件里的 probability 必须等于"按事件自带的安静时长 + 本次实际用的 α"重算的值。
  // α 从分布摘要读（不在这里重推一份），于是"解出来的 α"与"事件里的 probability"对得上。
  const usedAlpha = beat.distribution.alpha;
  assert.equal(usedAlpha, solveHeartbeatAlpha(FLOOR, CEIL, TICK, targetMs), '摘要里的 α 就是解出来的那个');
  const quietRounded = quietMs - (quietMs % TICK);
  const expected = heartbeatProbability(quietRounded, FLOOR, CEIL, usedAlpha);
  assert.ok(Math.abs(data.probability - expected) < 1e-12,
    `事件里的 probability=${data.probability} 应等于重算的 ${expected}`);
  assert.ok(data.roll >= 0 && data.roll < 1, 'roll 是 [0,1) 里的数');
  assert.ok(data.roll < data.probability, `roll ${data.roll} < probability ${data.probability}（这一拍为什么响）`);
  assert.equal(data.quietSeconds, Math.floor(quietMs / 1000), 'quietSeconds 与安静时长一致');
});
