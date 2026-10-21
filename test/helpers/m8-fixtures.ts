/**
 * M8 验收测试的公共夹具（test/m8-acceptance.test.ts 专用）
 *
 * 只放两件事：**手工时钟**与**真 EventLog + 真 fold 的装载器**。
 * 刻意不 mock 投影或事件写入——M8 的多数验收项（job 全链路、plan 门、人审挂起）测的正是
 * "事件写没写对、投影折没折对"，把它们替掉等于把被测事实本身替掉。
 *
 * 两条折叠路径都留着，而且**必须互相印证**（fold 铁律 2）：
 *   • `projection`：把已写事件按顺序折叠出来的当前投影（工具与 gate 的同步写入口需要它同步可得）；
 *   • `refold()`：从盘上日志全量重建（重启后的真实路径）。
 * 两者对同一份日志必须给出同一结论——`assertProjectionConsistent` 就是这条铁律的断言。
 *
 * 约定：值导入写 `.ts`，纯类型导入写 `.js`。
 */

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { tempDirSync } from './temp-dirs.ts';

import type { AppEvent, Projection, Visibility } from '../../src/log/types.js';
import { EventLog } from '../../src/log/event-log.ts';
import { applyOne, fold } from '../../src/state/fold.ts';
import { EVENT_LOG_DIR_NAME } from '../../src/runtime/recover.ts';

/** 固定的假"现在"：所有测试都从这一刻起算，断言里不出现系统时间 */
export const FIXTURE_NOW_ISO = '2026-02-14T02:00:00.000Z';
export const FIXTURE_NOW_MS = Date.parse(FIXTURE_NOW_ISO);

/** 手工时钟：cron 的下一拍与人审超时都靠它推进，测试不 sleep */
export class FixtureClock {
  private ms: number;

  constructor(ms: number = FIXTURE_NOW_MS) {
    this.ms = ms;
  }

  now = (): Date => new Date(this.ms);

  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

/**
 * 虚拟时钟：连**调度**一起接管（`setTimeout` / `clearTimeout`）。
 *
 * TimerStore 的下一拍不是靠轮询，而是自己排一个真 setTimeout——测试里如果只注入 now，
 * 到期的那一刻永远不会到来（真定时器要等真实墙钟）。这个时钟按真实事件循环的语义推进：
 * 每个回调在它自己的到期时刻执行，期间新排的定时器按剩余时间顺延。
 */
export interface VirtualClock {
  now: () => Date;
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** 推进到「当前时刻 + ms」，返回本次实际派发数 */
  advanceBy: (ms: number) => number;
  pendingCount: () => number;
}

export function createVirtualClock(startMs: number = FIXTURE_NOW_MS): VirtualClock {
  interface Task { at: number; seq: number; handler: () => void }
  let currentMs = startMs;
  let seq = 0;
  const tasks = new Map<number, Task>();

  return {
    now: () => new Date(currentMs),
    setTimeout: (handler, ms) => {
      seq += 1;
      tasks.set(seq, { at: currentMs + ms, seq, handler });
      return seq;
    },
    clearTimeout: (handle) => {
      if (typeof handle === 'number') tasks.delete(handle);
    },
    advanceBy: (ms) => {
      const deadline = currentMs + ms;
      let fired = 0;
      for (;;) {
        let pick: Task | null = null;
        for (const task of tasks.values()) {
          if (task.at > deadline) continue;
          if (pick === null || task.at < pick.at || (task.at === pick.at && task.seq < pick.seq)) pick = task;
        }
        if (pick === null) break;
        tasks.delete(pick.seq);
        if (pick.at > currentMs) currentMs = pick.at;
        fired += 1;
        pick.handler();
      }
      if (deadline > currentMs) currentMs = deadline;
      return fired;
    },
    pendingCount: () => tasks.size,
  };
}

export interface EventHarness {
  dataDir: string;
  log: EventLog;
  /** 已写事件（按 seq 升序），**从盘上日志读**——外部模块（JobManager 等）可能直接写日志，内存镜像看不全 */
  events: () => readonly AppEvent[];
  /** 按顺序折叠出的当前投影（**引用恒定**：持有它的模块能看到后续写入） */
  projection: () => Projection;
  /** 从盘上日志全量重建的投影（重启路径） */
  refold: () => Projection;
  append: (type: string, data: unknown, visibility?: Visibility) => AppEvent;
}

/**
 * 只读某个类型的事件（按 seq 升序）。用「按 type 值过滤」而非公开泛型 Extract 体操：
 * 调用点在断言里直接拿到窄化后的联合成员，字段访问因此有类型保护。
 * 类型由下方 eventsOf 的显式标注给出，返回值形态与 filter 窄化一致。
 */
export function eventsOf<T extends AppEvent['type']>(
  harness: EventHarness,
  type: T,
): Array<Extract<AppEvent, { type: T }>> {
  const out: Array<Extract<AppEvent, { type: T }>> = [];
  for (const event of harness.events()) {
    if (event.type === type) out.push(event as Extract<AppEvent, { type: T }>);
  }
  return out;
}

/**
 * 装载器：真 EventLog（落盘、sync）+ 真 fold。
 * 每条事件都先 `log.append` 再进内存事件表——盘上那份是权威，内存那份只是顺序视图。
 */
export async function makeHarness(
  t: { after: (fn: () => void) => void },
  prefix: string,
  clock: FixtureClock = new FixtureClock(),
): Promise<EventHarness> {
  // 走 helper 建目录（进程退出兜底清），清理钩子**合成一条**：先 close 再 rm。
  // 分成两条 `t.after` 时顺序取决于注册顺序，rm 可能跑在 close 之前（Windows 上句柄还开着
  // ⇒ 删不掉），2026-10-21 的全量跑里就漏过一个 `m8-cron*`。
  const dataDir = tempDirSync(prefix);
  const log = await EventLog.open(join(dataDir, EVENT_LOG_DIR_NAME));
  t.after(() => {
    log.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });

  const written: AppEvent[] = [];
  // 增量折叠的当前投影。**对象引用恒定**：PlanMode / BudgetGuard 这类模块持有投影对象，
  // 每次重折都换一个新对象的话，它手上的引用会指向过期快照（gate 就再也看不到新落的事件）。
  const live = fold([]);

  const harness: EventHarness = {
    dataDir,
    log,
    // 从盘上读而不是读内存镜像：JobManager / PlanMode 这类模块自己 append 事件，
    // 只维护一份"我 append 过什么"的镜像会让断言看不见它们真正写下的事实。
    events: () => readLogSync(harness),
    projection: () => live,
    // 从盘上重折：与 live 不是同一份内存对象，而是日志本身
    refold: () => fold(readLogSync(harness)),
    append: (type, data, visibility = 'internal') => {
      const event = {
        seq: log.nextSeq(),
        ts: clock.now().toISOString(),
        type,
        data,
        visibility,
        origin: 'test/m8',
      } as unknown as AppEvent;
      log.append(event, { sync: true });
      written.push(event);
      applyOne(live, event);
      return event;
    },
  };
  return harness;
}

/**
 * 同步读全量日志。EventLog 的 readAll 是异步迭代器，而验收断言里到处需要同步取投影快照
 * （工具与 gate 的写入契约都是同步的）。测试日志很小，直接读分片文件即可；
 * 分片名由 EventLog 自己给出（`shardFiles`），路径解析不重复实现一遍。
 */
function readLogSync(harness: EventHarness): AppEvent[] {
  const dir = join(harness.dataDir, EVENT_LOG_DIR_NAME);
  const out: AppEvent[] = [];
  for (const name of harness.log.shardFiles) {
    const text = readFileSync(join(dir, name), 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      out.push(JSON.parse(line) as AppEvent);
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}
