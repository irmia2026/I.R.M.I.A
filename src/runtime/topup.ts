/**
 * Irmia Agent — 人工加注通道（docs/design.md §4.6「撞刹车后的状态是暂停不是失败」）
 *
 * 撞了 task / daily 层刹车之后，循环进入**可恢复暂停**：不写 turn/start、不认领输入、
 * pending 原样留着。恢复的唯一手段是加预算——而加预算的入口必须是"只有主进程持日志写句柄"
 * 这条纪律的延伸：CLI 不写日志，它只往 `<dataDir>/topup/topup-<ts>.json` 写一个看门文件，
 * 由真循环下一拍拾取、先落 `budget/topped-up` 事件再删文件（顺序反了就是丢加注）。
 *
 * 加注的语义是**抬高上限，不是清零消耗**：
 *   - `raiseLimits(config.budget, totals)` 把各层上限抬高（进度一个字节都不动）；
 *   - `foldTopUps(events)` 从 `budget/topped-up` 折叠出累计加注量——跨重启把人工加过的
 *     预算算回来，否则重启一次"加过的额度"就凭空消失，暂停态再也解不开。
 * 这两个函数加在一起，才是「M3-5 硬停后 topup 恢复进度不丢」的完整实现。
 *
 * 零外部依赖：只用 node: 标准库。
 */

import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import type { AppConfig } from '../config/config.js';
import type { AppEvent, BudgetLayer } from '../log/types.js';

// ──────────────────────────────── 常量 ────────────────────────────────

export const TOPUP_WATCH_DIR_NAME = 'topup';
export const TOPUP_FILE_PREFIX = 'topup-';
/** 单次加注上限：防止手滑写出天文数字，把刹车彻底关掉 */
export const MAX_TOPUP_TOKENS = 1_000_000_000;
/** 看门文件名撞车时的重试上限（同毫秒多次加注） */
const MAX_NAME_ATTEMPTS = 1000;

const LAYERS: readonly BudgetLayer[] = ['step', 'turn', 'task', 'daily'];

// ──────────────────────────────── 类型 ────────────────────────────────

/** 各层人工加注累计（与配置上限相加得到有效上限） */
export type TopUpTotals = Record<BudgetLayer, number>;

export interface TopUpRequest {
  layer: BudgetLayer;
  addedTokens: number;
  by: string;
  ts: string;
}

// ──────────────────────────────── 折叠 ────────────────────────────────

export function emptyTopUps(): TopUpTotals {
  return { step: 0, turn: 0, task: 0, daily: 0 };
}

export function allZeroTopUps(totals: TopUpTotals): boolean {
  return LAYERS.every(layer => totals[layer] === 0);
}

/** 单条事件 → 加注累计（增量折叠；运行期拾取看门文件后同步调用） */
export function applyTopUpEvent(totals: TopUpTotals, event: AppEvent): void {
  if (event.type !== 'budget/topped-up') return;
  const { layer, addedTokens } = event.data;
  if (!LAYERS.includes(layer)) return;
  if (!Number.isFinite(addedTokens)) return;
  totals[layer] += addedTokens;
}

/** 从日志折叠加注累计（启动时一次；跨重启把人工加过的预算算回来） */
export function foldTopUps(events: Iterable<AppEvent>): TopUpTotals {
  const totals = emptyTopUps();
  for (const event of events) applyTopUpEvent(totals, event);
  return totals;
}

/**
 * 有效上限 = 配置上限 + 人工加注累计。
 * 返回新对象，绝不改调用方持有的配置（配置对象要参与 configHash，动了就是指纹漂移）。
 */
export function raiseLimits(budget: AppConfig['budget'], totals: TopUpTotals): AppConfig['budget'] {
  if (allZeroTopUps(totals)) return budget;
  return {
    ...budget,
    stepTools: budget.stepTools + totals.step,
    turnSteps: budget.turnSteps + totals.turn,
    taskTokens: budget.taskTokens + totals.task,
    dailyTokens: budget.dailyTokens + totals.daily,
  };
}

// ──────────────────────────────── 看门文件 ────────────────────────────────

/** 解析加注看门文件；形状不对返回 null（绝不猜意图：把 task 写成 tsak 应当报错） */
export function parseTopUpRequest(raw: string): TopUpRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const layer = obj['layer'];
  const addedTokens = obj['addedTokens'];
  if (typeof layer !== 'string' || !LAYERS.includes(layer as BudgetLayer)) return null;
  if (typeof addedTokens !== 'number' || !Number.isInteger(addedTokens) || addedTokens < 0) return null;
  if (addedTokens > MAX_TOPUP_TOKENS) return null;
  const by = typeof obj['by'] === 'string' && obj['by'] !== '' ? obj['by'] : 'human';
  const ts = typeof obj['ts'] === 'string' ? obj['ts'] : new Date().toISOString();
  return { layer: layer as BudgetLayer, addedTokens, by, ts };
}

/**
 * 写加注看门文件（CLI 侧）。文件名 `topup-<epochMillis>.json`，`wx` 排他创建，
 * 同毫秒撞车就向后借 1ms——绝不覆盖既有文件（覆盖等于悄悄吞掉一次人工加注）。
 */
export function writeTopUpRequest(dataDir: string, request: TopUpRequest, now: Date = new Date()): string {
  const dir = join(dataDir, TOPUP_WATCH_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  const body = `${JSON.stringify({ ...request, pid: process.pid }, null, 2)}\n`;
  for (let offset = 0; offset < MAX_NAME_ATTEMPTS; offset++) {
    const path = join(dir, `${TOPUP_FILE_PREFIX}${now.getTime() + offset}.json`);
    let fd: number;
    try {
      fd = openSync(path, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return path;
  }
  throw new Error(`加注文件名连续 ${MAX_NAME_ATTEMPTS} 次撞车，放弃写入`);
}
