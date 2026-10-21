/**
 * Irmia Agent — 唤醒源（docs/design.md §4.3）
 *
 * 所有外部触发在这里统一转成 `wake/*` 事件。M1 实现两个源：
 *   - timer：TimerStore 到期 → `timer/fired`（internal 记账）+ `wake/timer`（model）
 *   - manual：看门目录 `watch/wake-<ts>.json` → `wake/manual`，事件落盘之后才删除文件
 *
 * 与日志的边界：本模块不认识 EventLog，只通过 WakeSink 说话（由 runtime/loop.ts 实现）。
 * 这么切分是为了 M1 的跨进程现实——CLI 与主进程共用同一份日志，但只有主进程持有写句柄，
 * 看门文件是二者之间唯一的通道，于是不存在"两个进程各自分配 seq 撞号"的窗口。
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import type { WakeChannel, WakeManual, WakeSource, WakeTimer } from '../log/types.js';
import type { StoredTimerEntry, TimerStore } from './timer-store.js';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 看门目录名：CLI 写、主进程拾取 */
export const WAKE_WATCH_DIR_NAME = 'watch';

/** 看门文件名前缀，完整形状为 `wake-<epochMillis>.json` */
export const WAKE_FILE_PREFIX = 'wake-';

/** 坏看门文件的保留后缀：静默删除会让"我明明注入了"变成无法取证 */
const BAD_SUFFIX = '.bad';

const WAKE_FILE_RE = /^wake-(\d+)\.json$/;
const DEFAULT_POLL_MS = 500;
/** 坏文件改名上限：目录里堆满坏文件时不能让一次扫描变成无限重试 */
const MAX_BAD_RENAME_ATTEMPTS = 8;

// ──────────────────────────────── 对外类型 ────────────────────────────────

export type WakeEmission =
  | { type: 'wake/timer'; data: WakeTimer['data'] }
  | { type: 'wake/manual'; data: WakeManual['data'] }
  /**
   * IM 通道消息（M9）。它同 WakeSink 走，因为它需要与其它唤醒同一条承诺：
   * `wake()` 返回时事件已在磁盘上——适配器拿到这句承诺后才对平台表示"已收下"。
   */
  | { type: 'wake/channel'; data: WakeChannel['data'] };

/**
 * 唤醒事件落库口。实现者负责 seq 分配与 sync 落盘策略；sources 只声明"发生了什么"。
 * `wake()` 返回时事件必须已在磁盘上——调用方紧接着要删除外部文件，
 * 顺序反了就会出现"文件没了、事件也没写"的静默丢唤醒。
 */
export interface WakeSink {
  /** 定时器到期记账（internal）：投影据此把一次性条目出表、周期条目结算下一拍 */
  timerFired(timerId: string): void;
  /** 唤醒事件（model，承诺类） */
  wake(emission: WakeEmission): void;
}

/**
 * 唤醒源统一接口。命名避开 log/types.ts 的 `WakeSource`（那是来源枚举值），
 * 避免两处同名类型在调用点互相遮蔽。
 */
export interface WakeSourceAdapter {
  readonly name: string;
  start(): void;
  stop(): void;
}

// ──────────────────────────────── 定时器源 ────────────────────────────────

export class TimerWakeSource implements WakeSourceAdapter {
  readonly name = 'timer';

  private readonly store: TimerStore;
  private readonly sink: WakeSink;
  private readonly now: () => Date;

  constructor(store: TimerStore, sink: WakeSink, now: () => Date = () => new Date()) {
    this.store = store;
    this.sink = sink;
    this.now = now;
  }

  /** 布防：TimerStore.start 会立刻补触发已过期条目，因此这里可能同步产生多条唤醒 */
  start(): void {
    this.store.start((entry) => this.emit(entry));
  }

  stop(): void {
    this.store.stop();
  }

  /**
   * 到期结算。先写 `timer/fired` 再写 `wake/timer`：日志顺序即因果顺序——
   * 看到 wake/timer 的人不需要再猜"它为什么醒"，前面那条就是答案。
   * `scheduledAt` 取条目上的到期时刻（不是 now），这样"早了/晚了多久"可从日志直接算。
   */
  private emit(entry: StoredTimerEntry): void {
    this.emitDue(entry.timerId, entry.at, entry.payload);
  }

  /**
   * 按 (timerId, scheduledAt) 补发一次到期事实。
   * 除定时器回调外还有第二条调用路径：恢复流程对"启动时已过期"的第一条是同步结算的，
   * 那一刻它内部的回调只写日志、不产生 wake/timer，入口层据此把漏掉的那条补回来。
   *
   * **payload 跟着事件走**（`entry.payload` 原样带进 `wake/timer`）。这不是顺手加的字段：
   * `at` 型定时器**一触发就从表里删掉**，而认领方（real-loop 的 memoryMaintainWake）原先
   * 只查表拿 payload——于是 at 型定时器的 payload 静默丢失，`/dream` 排的那条唤醒跑成了
   * 普通 turn，她自己用 `timer`（action=set）布的"到点提醒我做什么"同样一句话都留不下，
   * 而工具描述里明写着"payload 是到期时你希望看到的任意 JSON"。cron 型条目触发后保留，
   * 所以这个问题只在 `at` 型上现形——踩中的正是最常用的那种。
   *
   * 补发路径没有 entry，payload 留给 `store.get` 兜底（条目还在就还能取到）。
   */
  emitDue(timerId: string, scheduledAt: string, payload?: unknown): void {
    this.sink.timerFired(timerId);
    const carried = payload ?? this.store.get(timerId)?.payload;
    this.sink.wake({
      type: 'wake/timer',
      data: {
        timerId,
        scheduledAt,
        firedAt: this.now().toISOString(),
        ...(carried === undefined ? {} : { payload: carried }),
      },
    });
  }
}

// ──────────────────────────────── 看门文件源 ────────────────────────────────

export interface WatchSourceOptions {
  now?: () => Date;
  /** 轮询间隔（毫秒）；<= 0 表示只做显式 scanOnce，不起轮询 */
  pollMs?: number;
  /** start() 时是否立即拾取一轮，默认 true */
  scanOnStart?: boolean;
}

interface ManualFileContent {
  note: string;
  dedupeKey?: string;
  person?: string;
}

type ManualParse = { ok: true; value: ManualFileContent } | { ok: false; error: string };

/**
 * 看门文件内容：`{ "note": "...", "dedupeKey"?: "...", "person"?: "..." }`。
 * 只认这几个字段；缺 note 或不是字符串一律判为坏文件——让"注入成功"有一个
 * 明确可判定的形状，比容错猜意图更适合无人值守。
 *
 * `person` 是带人唤醒：写进去就会命中 `persona/RELATIONSHIPS/<person>.md`（persona.md §3）。
 * 不写 = 不带人（脚本注入、子代理任务文本）。
 */
function parseManualFile(raw: string): ManualParse {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: '不是合法 JSON' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: '不是 JSON 对象' };
  }
  const obj = value as Record<string, unknown>;
  const note = obj['note'];
  if (typeof note !== 'string') return { ok: false, error: 'note 缺失或不是字符串' };
  const content: ManualFileContent = { note };
  const key = obj['dedupeKey'];
  if (typeof key === 'string' && key !== '') content.dedupeKey = key;
  const person = obj['person'];
  if (typeof person === 'string' && person.trim() !== '') content.person = person.trim();
  return { ok: true, value: content };
}

/** 同名文件按文件名里的毫秒戳排序，保证积压多份时按注入先后入队 */
function compareWakeFile(a: string, b: string): number {
  const ta = Number(WAKE_FILE_RE.exec(a)?.[1] ?? 0);
  const tb = Number(WAKE_FILE_RE.exec(b)?.[1] ?? 0);
  if (ta !== tb) return ta - tb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 手动唤醒源。M1 用轮询而不是 `fs.watch`：看门目录是低频通道，
 * 轮询的语义（"这一拍看到什么就拾取什么"）可测、跨平台一致，
 * 而 fs.watch 在 Windows 上的重命名/原子写事件组合会引入不必要的抖动。
 */
export class ManualWatchSource implements WakeSourceAdapter {
  readonly name = 'manual';
  readonly dir: string;

  private readonly sink: WakeSink;
  private readonly now: () => Date;
  private readonly pollMs: number;
  private readonly scanOnStart: boolean;
  private readonly notes: string[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(dir: string, sink: WakeSink, options: WatchSourceOptions = {}) {
    this.dir = dir;
    this.sink = sink;
    this.now = options.now ?? (() => new Date());
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.scanOnStart = options.scanOnStart ?? true;
  }

  start(): void {
    mkdirSync(this.dir, { recursive: true });
    if (this.scanOnStart) this.scanOnce();
    if (this.timer !== null || this.pollMs <= 0) return;
    this.timer = setInterval(() => {
      this.scanOnce();
    }, this.pollMs);
    // 轮询不是进程存活的理由：主循环停下来时不该被它续命
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 拾取一轮。返回转成事件的条数。删除严格晚于 `sink.wake()` 返回；
   * 若事件写入抛错，文件原样留在目录里，下一拍重试——宁可重复唤醒也不能丢。
   */
  scanOnce(): number {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((name) => WAKE_FILE_RE.test(name));
    } catch {
      // 目录被删或不可读：留空一轮，下一拍再试
      return 0;
    }
    let picked = 0;
    for (const name of names.sort(compareWakeFile)) {
      if (this.pickOne(name)) picked += 1;
    }
    return picked;
  }

  /** 扫描过程中攒下的异常，供启动摘要与告警使用 */
  warnings(): readonly string[] {
    return [...this.notes];
  }

  private pickOne(name: string): boolean {
    const path = join(this.dir, name);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      this.notes.push(`读取看门文件 ${name} 失败：${String(err)}`);
      return false;
    }
    const parsed = parseManualFile(raw);
    if (!parsed.ok) {
      this.notes.push(`看门文件 ${name} 非法（${parsed.error}），已改名为 ${name}${BAD_SUFFIX}`);
      this.parkBadFile(path);
      return false;
    }

    const data: WakeManual['data'] = { note: parsed.value.note };
    if (parsed.value.dedupeKey !== undefined) data.dedupeKey = parsed.value.dedupeKey;
    if (parsed.value.person !== undefined) data.person = parsed.value.person;
    this.sink.wake({ type: 'wake/manual', data });

    try {
      unlinkSync(path);
    } catch (err) {
      // 事件已落盘，文件没删掉只会导致下一拍重复注入；dedupeKey 可以兜住，但要留痕
      this.notes.push(`删除看门文件 ${name} 失败（下次扫描会重复拾取）：${String(err)}`);
    }
    return true;
  }

  private parkBadFile(path: string): void {
    for (let attempt = 0; attempt < MAX_BAD_RENAME_ATTEMPTS; attempt++) {
      const target = `${path}${BAD_SUFFIX}${attempt === 0 ? '' : `.${attempt}`}`;
      try {
        renameSync(path, target);
        return;
      } catch {
        // 目标已存在（同名坏文件积压）时换一个后缀重试
      }
    }
  }
}

// ──────────────────────────────── 工具 ────────────────────────────────

/**
 * 事件类型 → 来源枚举。恢复流程还原 `input/requeued.sources` 时用：
 * 认领列表里只有 seq，来源要从原 wake 事件本身读回来。
 * fold.ts 内部有同表，但那份服务折叠、不导出，这里服务恢复，语义不同不合并。
 *
 * 注意 IM 通道那一条（M9）：它必须在这里，否则一次崩溃/中断后的"输入退回"会把
 * 一条来自 QQ 的消息错记成 manual，来源账就永久说谎了。
 */
export function wakeSourceOfType(type: string): WakeSource | null {
  switch (type) {
    case 'wake/timer': return 'timer';
    case 'wake/file': return 'file';
    case 'wake/webhook': return 'webhook';
    case 'wake/manual': return 'manual';
    case 'wake/intention': return 'intention';
    case 'wake/job': return 'job';
    case 'wake/channel': return 'channel';
    default: return null;
  }
}
