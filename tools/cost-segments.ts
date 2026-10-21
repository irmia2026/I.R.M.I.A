/**
 * 只读测量：**段归因**——上下文这一笔钱花在哪些段上。
 *
 * 输出 `history / 此刻层 / 固定块 / instructions / tools / summary / wake`（外加把 100% 凑满的
 * "记忆层其余"与"尾部插播"）的占比、窗口合计与末笔明细；页脚再给一条
 * "估算线用到几成 / 最近一条 compaction/decision 的真实 vs 估算"。
 *
 * 用法：
 *   node --experimental-strip-types tools/cost-segments.ts [--data data] [--last 200]
 *
 * 三条纪律（与 doctor 的 `OPS-cost-segments` 是同一条）：
 *   · **只读**：`readEventsReadOnly`（与 status / doctor 同一个解析器），不持写句柄、不修半行；
 *   · **口径只有一处**：聚合与措辞在 `src/model/cost-segments.ts`，本文件只做参数与打印；
 *   · **不出现货币**：只印 token 与占比（仓库既有铁律）。
 */

import { join } from 'node:path';

import { readEventsReadOnly } from '../src/log/read-only.ts';
import { readCompactionWarnings } from '../src/model/compaction-warning.ts';
import {
  formatCostSegments,
  readCostSegments,
  type CostSegmentsCompactionFooter,
} from '../src/model/cost-segments.ts';

const argOf = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value === undefined ? fallback : value;
};

const dataDir = argOf('--data', 'data');
const requested = Number(argOf('--last', '200'));
const windowRows = Number.isFinite(requested) ? requested : 200;

const scan = readEventsReadOnly(join(dataDir, 'events'));
const reading = readCostSegments(scan.events, windowRows);

// 页脚那两格：`latest`（估算线用到几成）与 `real`（真实 vs 估算）可能不是同一行，
// 分开读、分开印（见 `CostSegmentsCompactionFooter` 的注释）。
const compactionReadout = readCompactionWarnings(scan.events);
const latest = compactionReadout.latest;
const real = compactionReadout.lastReal;
const compaction: CostSegmentsCompactionFooter = {
  latest: latest === null
    || latest.historyTokens === null
    || latest.thresholdTokens === null
    || latest.thresholdTokens <= 0
    ? null
    : {
      seq: latest.seq,
      turn: latest.turn,
      usedRatio: latest.historyTokens / latest.thresholdTokens,
    },
  real: real === null || real.real === null
    ? null
    : { seq: real.seq, turn: real.turn, ...real.real },
};

for (const line of formatCostSegments(reading, { dataDir, compaction })) {
  console.log(line);
}
if (scan.badLines > 0) {
  // 与 doctor 的 OPS-log 同一个口径：主进程正在追加时尾部半行属正常，但必须让人看见
  console.error(`（日志里有 ${scan.badLines} 行无法解析，已跳过；主进程正在追加时尾部半行属正常）`);
}
