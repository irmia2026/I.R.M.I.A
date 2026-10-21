/**
 * M3-3 跨重启累计的夹具（docs/milestones.md M3-3：跑到接近上限，杀进程重启后剩余额度正确）
 *
 * 它只做一件事：用**真实的事件日志**写下若干消耗事实，然后写到崩溃点哨兵并保持存活，
 * 等父测试用 SIGKILL 终结它。父测试随后的判定必须完全来自"从磁盘折叠日志"——
 * 进程已经死了，没有任何内存态可以依赖，这正是 M3-3 要证明的东西。
 *
 * 为什么不用 recover()：M3 的验收不含崩溃恢复（那是 M1/M2 的 T6–T10），
 * 这里要隔离出"预算跨重启累计"这一条，所以只走 EventLog + fold。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EventLog } from '../../src/log/event-log.ts';
import type { AppEvent } from '../../src/log/types.ts';
import { defaultVisibility } from '../../src/log/types.ts';
import { applyOne, fold } from '../../src/state/fold.ts';

function argOf(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

const dataDir = argOf('--data-dir');
const sentinel = argOf('--sentinel');
const consume = Number(argOf('--consume') ?? '0');

if (dataDir === null || sentinel === null || !Number.isFinite(consume)) {
  process.stderr.write('用法：budget-scenario --data-dir D --consume N --sentinel P\n');
  process.exit(2);
}

mkdirSync(dataDir, { recursive: true });
const log = await EventLog.open(join(dataDir, 'events'));
const projection = fold([]);

function write(type: string, data: unknown, sync: boolean): void {
  const event = {
    seq: log.nextSeq(),
    ts: new Date().toISOString(),
    type,
    data,
    visibility: defaultVisibility(type),
    origin: 'test/fixtures/budget-scenario',
  } as unknown as AppEvent;
  log.append(event, { sync });
  applyOne(projection, event);
}

write('session/start', {
  pid: process.pid,
  cwd: process.cwd(),
  version: '0.1.0',
  schemaVersion: '1',
  configHash: 'fixture',
}, true);

// 消耗事实：观测类事件（与运行期同一条节奏——budget/consumed 进缓冲、step 边界落盘）
write('budget/consumed', {
  turn: 1,
  step: 1,
  lane: 'heavy',
  model: 'fixture-model',
  inputTokens: consume,
  outputTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: consume,
  durationMs: 7,
  retryCount: 0,
  finishReason: 'completed',
  tokensTodayAccum: consume,
}, false);
log.flush();

// 崩溃点哨兵：父测试的断言基准来自这里，两侧不各写一份常量
writeFileSync(sentinel, JSON.stringify({
  pid: process.pid,
  consume,
  tokensTask: projection.budget.tokensTask,
  tokensToday: projection.budget.tokensToday,
}), 'utf8');

// 保持存活，等父测试强杀（没有 pending 句柄时 Node 会自己退出，那就不是"杀进程"了）
setInterval(() => {}, 1000);
