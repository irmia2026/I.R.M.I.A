/**
 * Irmia Agent — 日志只读扫描（CLI 与 doctor 共用的唯一实现）
 *
 * 一条硬纪律：**只读扫描绝不持写句柄**。`EventLog.open` 会做末行自愈（截断半截行），
 * 在主进程正追加时截断它的行是不可接受的副作用——所以 status / tail / review / budget /
 * export / doctor 全部走这里，用 `readFileSync` 扫分片，不修复、不截断、不写盘。
 *
 * 抽成独立模块的原因与 tools/catalog.ts 相同：口径必须只有一份。doctor 要是自己再写一套
 * 解析，那"doctor 说日志没问题"这件事就只证明了 doctor 的解析器和日志一致，而不是日志没问题。
 *
 * 零外部依赖：只用 node: 标准库。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { AppEvent } from './types.js';

/** 分片文件名：`<起始 seq，12 位补零>.jsonl`（schema §11） */
export const SHARD_NAME_RE = /^\d{12}\.jsonl$/u;

export interface LogScan {
  shards: number;
  events: AppEvent[];
  badLines: number;
  maxSeq: number;
}

export interface TailScan {
  /** 按 seq 升序的尾部事件 */
  events: AppEvent[];
  /** 实际读了几个分片：从最后一个分片往前读，凑够条数即停 */
  shardsRead: number;
  /** 跳过多少行无法解析的内容（主进程此刻正在追加时可能读到半行） */
  badLines: number;
}

export interface RangeScan {
  /** 落在 [from, to] 区间内的事件，按 seq 升序 */
  events: AppEvent[];
  shardsRead: number;
  badLines: number;
}

/** 分片名升序 = seq 升序（文件名是补零的起始 seq）；读不到目录即"没有日志" */
export function listShardNames(eventsDir: string): string[] {
  try {
    return readdirSync(eventsDir).filter((name) => SHARD_NAME_RE.test(name)).sort();
  } catch {
    return [];
  }
}

/** 行 → 事件。只做信封的最小形状校验：坏行必须被计数而不是被当成事件 */
export function parseEventLine(line: string): AppEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const envelope = value as Partial<AppEvent>;
  if (typeof envelope.seq !== 'number' || !Number.isInteger(envelope.seq) || envelope.seq < 1) return null;
  if (typeof envelope.ts !== 'string' || typeof envelope.type !== 'string') return null;
  return value as AppEvent;
}

/**
 * 全量只读扫描。主进程正在追加时最坏情况是读到写了一半的尾行——计入 badLines，
 * 不影响其余事件（doctor 会把 badLines 报出来，因为"日志完整性"是它的职责）。
 */
export function readEventsReadOnly(eventsDir: string): LogScan {
  const names = listShardNames(eventsDir);
  const events: AppEvent[] = [];
  let badLines = 0;
  let maxSeq = 0;
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(eventsDir, name), 'utf8');
    } catch {
      // 分片读不到（权限/句柄冲突）不是"坏行"，跳过整个分片而不污染计数
      continue;
    }
    for (const line of text.split('\n')) {
      if (line === '') continue;
      const event = parseEventLine(line);
      if (event === null) {
        badLines += 1;
        continue;
      }
      events.push(event);
      if (event.seq > maxSeq) maxSeq = event.seq;
    }
  }
  return { shards: names.length, events, badLines, maxSeq };
}

/**
 * 从最后一个分片往前读，凑够 limit 条即停——tail 的 I/O 只与"要看多少"有关，与日志总量无关。
 * `type` 是类型前缀过滤（`tool/` 匹配 `tool/call` 与 `tool/result`）。
 */
export function readTailEvents(
  eventsDir: string,
  options: { limit: number; type?: string | undefined },
): TailScan {
  const type = options.type;
  const names = listShardNames(eventsDir);
  const events: AppEvent[] = [];
  let badLines = 0;
  let shardsRead = 0;
  for (let i = names.length - 1; i >= 0 && events.length < options.limit; i--) {
    const name = names[i]!;
    let text: string;
    try {
      text = readFileSync(join(eventsDir, name), 'utf8');
    } catch {
      continue;
    }
    shardsRead += 1;
    const lines = text.split('\n');
    for (let j = lines.length - 1; j >= 0 && events.length < options.limit; j--) {
      const line = lines[j]!;
      if (line === '') continue;
      const event = parseEventLine(line);
      if (event === null) {
        badLines += 1;
        continue;
      }
      // 先过滤再凑数：`--type tool/ --limit 5` 是"最近 5 条 tool 事件"，
      // 而不是"最近 5 条里恰好是 tool 的那几条"——后者会给出一个没人想要的残缺列表
      if (type !== undefined && !event.type.startsWith(type)) continue;
      events.push(event);
    }
  }
  events.reverse(); // 反向读是为了早停，输出仍是时序（老 → 新）
  return { events, shardsRead, badLines };
}

/**
 * 导出用：只取 [from, to] 区间的事件。分片头部的起始 seq 可用来跳过整片——
 * 归档过的日志有几百万行时，这一步决定了 `export` 是秒级还是要等一分钟。
 */
export function readRangeEvents(eventsDir: string, from: number, to: number): RangeScan {
  const names = listShardNames(eventsDir);
  const events: AppEvent[] = [];
  let badLines = 0;
  let shardsRead = 0;
  for (const name of names) {
    // 分片名即"这片里最小可能的 seq"：整片都在区间之后就没必要读了
    if (Number(name.slice(0, 12)) > to) break;
    let text: string;
    try {
      text = readFileSync(join(eventsDir, name), 'utf8');
    } catch {
      continue;
    }
    shardsRead += 1;
    let maxInShard = 0;
    for (const line of text.split('\n')) {
      if (line === '') continue;
      const event = parseEventLine(line);
      if (event === null) {
        badLines += 1;
        continue;
      }
      if (event.seq > maxInShard) maxInShard = event.seq;
      if (event.seq >= from && event.seq <= to) events.push(event);
    }
    // 本片的最大 seq 已经超过区间起点且整片读完了才可能提前收工：靠区间上界判断更稳
    if (maxInShard > to) break;
  }
  events.sort((a, b) => a.seq - b.seq);
  return { events, shardsRead, badLines };
}
