/**
 * Irmia Agent — 告警出口（M3，docs/design.md §4.9 全文 / docs/milestones.md M3-6、M3-7、M3-10）
 *
 * 职责：无人值守时，出问题得有人知道。三个框架都只写日志，这是必须自己补的洞。
 *
 * 三档实现，按"永远可用"排序：
 *   ① **文件档**（默认，永远可用）：`<alertDir>/YYYY-MM-DD.log` 追加一行人类可读记录。
 *      它是最后一道防线：磁盘在就在，不依赖网络、不依赖对端。
 *   ② **Webhook 档**：POST JSON `{ level, title, body, ts, fingerprint }` 到 `alerts.webhookUrl`。
 *      没配就不出口（不写这个字段即代表不用）。
 *   ③ IM 消息档复用同一出口（admin.ts 的 notify/speak 第二路注入的正是这里的 AlertNotifier）。
 *
 * 三条刻意的语义：
 * **限流（§4.9「同一类告警 30 分钟内只发一次」）**：指纹 = 类别 + 关键参数的哈希。
 *   内存 Map 负责短期判定，`foldAlarms(events)` / `AlarmIndex` 是恢复入口——限流窗口从
 *   `alarm/sent` 事件折叠重建，所以重启进程不会让一个坏掉的接口重新刷屏（M3-10）。
 *   被限流不是失败：消息被**有意丢弃**，`sent: false` + `reason: 'rate-limited'`，不计入失败。
 *
 * **stall 恢复通知（§4.9 参照 Cortico）**：告警发出时按"故障键"登记（首次时刻 + 连续次数），
 *   恢复（连续失败后首次成功）时发一条"已恢复"再清除登记——同一串故障不重复告警，
 *   也不会在故障期间刷屏。恢复通知的指纹与故障本身不同（`…:recovered`），
 *   所以不会被故障那 30 分钟窗口连坐。没有登记时不发（不制造"恢复了什么"的假事实）。
 *   限流只节流**人看的通道**：恢复通知自己被限流时，那条 `alarm/sent{recovered:true}`
 *   照旧写（销账不能缺，见 `deliver` 里那段说明）。
 *
 * 两种对外形状（同一份实现，双方接口都保留）：
 *   - `new Notifier({ alertDir, rateLimitMin, now, history, record, webhookUrl })`
 *     ：`send(level, title, body)` / `recover({ level, title }, note)`，宿主自己写事件；
 *   - `createNotifier({ config, dataDir, emit, now })`
 *     ：任务接口（`send(message)` 兼容 admin.ts 的 Notifier，另带 alert/fail/ok/restore）。
 *
 * 约定：值导入写 `.ts`（Node 的 --experimental-strip-types 只擦类型、不改写路径解析），
 * 纯类型导入写 `.js`。
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AppConfig } from '../config/config.js';
import type { AppEvent, Visibility } from '../log/types.js';
import { defaultVisibility } from '../log/types.ts';
import type { Notifier as AdminNotifier, NotifyMessage, NotifyOutcome } from '../tools/admin.js';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 告警日志目录名（operations.md §2 的目录结构：<dataDir>/alarms/） */
export const ALERT_DIR_NAME = 'alarms';
/** 限流窗口兜底（分钟）：config.alerts.rateLimitMin 缺失或非法时用它 */
export const DEFAULT_RATE_LIMIT_MIN = 30;
/** 指纹展示长度：完整 sha256 太长，前 16 位足够区分且便于人眼比对 */
export const FINGERPRINT_CHARS = 16;
/** Webhook 超时：无人值守场景下，一个不回话的端点不能拖住调用方 */
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** 被限流时的原因串（调用方据此区分"丢掉了"与"失败了"） */
export const RATE_LIMITED = 'rate-limited';

// ──────────────────────────────── 对外类型 ────────────────────────────────

/** 告警级别（与 admin.ts 的 NotifyMessage 同源） */
export type AlertLevel = NotifyMessage['level'];

/** 事件写入口（注入）：宿主实现为「分配 seq → append → 落日志」 */
export type AlertEmitter = (type: string, data: unknown, visibility: Visibility) => void;

export interface AlertInput {
  /** 告警类别（如 `budget-exhausted`、`model-failure`）：同类同参数共用指纹 */
  category: string;
  level: AlertLevel;
  title: string;
  body: string;
  /** 参与指纹的关键参数（layer、callId、endpoint…）；变参数即变指纹 */
  params?: Record<string, string | number | boolean> | undefined;
}

/** 一次告警的送达回执：是否发出、指纹、落盘文件 */
export interface AlertDelivery {
  /** 真的发出去了（被限流或全通道失败时为 false） */
  sent: boolean;
  fingerprint: string;
  /** 文件档路径（即使写入失败也给出目标路径，便于人去看） */
  file: string;
  reason?: string | undefined;
}

export interface AlertStats {
  /** 真正发出去的条数 */
  sent: number;
  /** 被限流丢弃的条数 */
  suppressed: number;
  /** 所有通道都失败的条数 */
  failed: number;
}

/** 写进日志的告警事实（限流窗口的唯一来源） */
export interface AlertRecord {
  fingerprint: string;
  level: AlertLevel;
  title: string;
  /**
   * 故障键（如 `category:stall`、`alert:水位停滞`）；普通告警为 null。
   *
   * 为什么它必须落进日志（2026-10-03）：`stalling` 原来只在内存里，于是**进程一重启，
   * 一个已经报出去的故障就再也配不上它的"已恢复"**——故障键连同它的连续窗口一起丢了。
   * 记进事件后，`foldStalls` 能把未恢复的故障重建回来，恢复通知照样只发一次。
   */
  key?: string | null;
  /** 这条是恢复通知而不是故障本身（`foldStalls` 据此销账） */
  recovered?: boolean;
}

export interface NotifierOptions {
  /** 告警日志目录（调用方给的通常是 join(dataDir, ALERT_DIR_NAME)） */
  alertDir: string;
  /** 同类告警限流窗口（分钟） */
  rateLimitMin: number;
  /** 时钟注入 */
  now: () => Date;
  /** 告警发出后的回调：宿主据此写 `alarm/sent` 事件与更新索引 */
  record?: ((record: AlertRecord) => void) | undefined;
  /** 限流窗口的既有索引（启动恢复；同一实例会被持续更新） */
  history?: AlarmIndex | undefined;
  /** Webhook 出口；不配即只落文件 */
  webhookUrl?: string | undefined;
  /** fetch 注入（测试用）；缺省全局 fetch */
  fetchImpl?: typeof fetch | undefined;
}

/** 任务接口：文件档 + Webhook 档 + 限流 + stall 恢复（admin.ts 的 Notifier 形状 + 扩展） */
export interface AlertNotifier extends AdminNotifier {
  alert(input: AlertInput): Promise<NotifyOutcome>;
  fail(input: AlertInput): Promise<NotifyOutcome>;
  ok(category: string, body?: string | undefined): Promise<NotifyOutcome>;
  /**
   * 启动补写的销账口：给**上一个进程留下的**故障写一条"已恢复"（调用方负责核实它当刻
   * 确实不成立）。与 `ok()` 的分工见实现处的说明。
   */
  releasePending(category: string, body: string): Promise<NotifyOutcome>;
  /** 恢复入口：把历史 alarm/sent 折进限流窗口（M3-10 跨重启限流） */
  restore(events: Iterable<AppEvent>): void;
  /** 当前限流窗口快照：指纹 → 最近一次发送时刻（毫秒） */
  windows(): Map<string, number>;
  stats(): AlertStats;
  /** 配置热更点（alerts.rateLimitMin 在白名单内）：下一拍按新窗口判定，不等重启 */
  setRateLimitMin(min: number): void;
  /** 配置热更点（alerts.webhookUrl 属于告警开关）：不传即关闭 webhook 出口 */
  setWebhookUrl(url: string | undefined): void;
}

export interface CreateNotifierOptions {
  /** 生效配置的告警段（AppConfig['alerts']） */
  config: AppConfig['alerts'];
  /** 数据根目录：告警日志写到 `<dataDir>/alarms/` */
  dataDir: string;
  /** 事件写入口：每发出一条告警写 `alarm/sent`（限流的事实来源） */
  emit: AlertEmitter;
  /** 时钟注入 */
  now: () => Date;
  /** fetch 注入（测试用）；缺省全局 fetch */
  fetchImpl?: typeof fetch | undefined;
  /** 启动恢复：已有事件流，折进限流窗口后再开张 */
  history?: Iterable<AppEvent> | undefined;
}

// ──────────────────────────────── 指纹与折叠 ────────────────────────────────

/**
 * 指纹 = 类别 + 关键参数哈希（§4.9；review.md 缺陷 9）。
 * 参数按键名排序后拼接，所以 `{a:1,b:2}` 与 `{b:2,a:1}` 是同一个指纹。
 */
export function fingerprintOf(
  category: string,
  params?: Record<string, string | number | boolean> | undefined,
): string {
  const keys = params === undefined ? [] : Object.keys(params).sort();
  const tail = keys.map((key) => `${key}=${String(params?.[key] ?? '')}`).join('&');
  return createHash('sha256').update(`${category}|${tail}`, 'utf8').digest('hex').slice(0, FINGERPRINT_CHARS);
}

/**
 * 从日志折叠限流窗口（M3-10）：指纹 → 最近一次 `alarm/sent` 的时刻（毫秒）。
 * 纯函数：时间只取事件自带的 ts，不读时钟、不碰文件；同一指纹取最晚一次。
 */
export function foldAlarms(events: Iterable<AppEvent>): Map<string, number> {
  const windows = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'alarm/sent') continue;
    const at = Date.parse(event.ts);
    if (!Number.isFinite(at)) continue;
    const previous = windows.get(event.data.fingerprint);
    if (previous === undefined || at > previous) windows.set(event.data.fingerprint, at);
  }
  return windows;
}

/**
 * 一次故障的连续窗口（stall 机制：恢复通知的依据）
 */
export interface StallRecord {
  /** 首次**真正送达**告警的时刻（毫秒） */
  since: number;
  /** 这个故障键上报过几次（含被限流压制的那些） */
  count: number;
  /** 首次上报用的指纹：恢复通知的正文里如实引用它 */
  fingerprint: string;
  /**
   * 这个故障**至少有一条告警真的送出去过**。
   *
   * 为什么要它（2026-10-03）：故障在整个窗口里都被限流压制时，人从来没被告知出过事；
   * 这时再补一句"已恢复"就是不存在的假事实——恢复通知只配它跟过的那些故障。
   * 它同时挡掉抖动：`stall → 正常 → stall → 正常` 里第二次故障若没送达，
   * 就不会再冒出一条"已恢复"。
   */
  announced: boolean;
}

/**
 * 从日志折叠**仍未恢复的故障**（键 → 连续窗口的近似值）。
 *
 * 为什么要它：限流窗口有 `foldAlarms` 跨重启，故障登记却只有内存一份——重启之后一条
 * 已经报出去的故障既不会重复报（限流还在），也永远不会收到"已恢复"（登记没了）。
 * 事件里现在带了 `key` / `recovered`（可选字段，老日志没有就跳过），于是两边都能重建。
 *
 * 两条刻意的近似（都在事件能表达的范围之内）：
 *   · `since` 取**首次真正送达**那条告警的时刻，而不是首次失败的时刻——日志里只记了前者；
 *   · `count` 数的是**送达过的次数**，不是连续失败次数。恢复通知里那句"连续 N 次"因此是下界，
 *     比编一个数诚实。
 */
export function foldStalls(events: Iterable<AppEvent>): Map<string, StallRecord> {
  const out = new Map<string, StallRecord>();
  for (const event of events) {
    if (event.type !== 'alarm/sent') continue;
    const key = event.data.key;
    if (key === undefined || key === null || key === '') continue;
    const at = Date.parse(event.ts);
    if (!Number.isFinite(at)) continue;
    if (event.data.recovered === true) {
      out.delete(key);
      continue;
    }
    const previous = out.get(key);
    if (previous === undefined) {
      out.set(key, { since: at, count: 1, fingerprint: event.data.fingerprint, announced: true });
    } else {
      previous.count += 1;
    }
  }
  return out;
}

/**
 * 告警限流索引：指纹 → 最近一次发出时刻（毫秒）。
 * 跨重启由日志重建：宿主把 `alarm/sent` 事件喂给 apply()，把实例作为 `history` 交给 Notifier。
 */
export class AlarmIndex {
  private readonly marks = new Map<string, number>();

  apply(event: AppEvent): void {
    if (event.type !== 'alarm/sent') return;
    const at = Date.parse(event.ts);
    if (!Number.isFinite(at)) return;
    const previous = this.marks.get(event.data.fingerprint);
    if (previous === undefined || at > previous) this.marks.set(event.data.fingerprint, at);
  }

  merge(events: Iterable<AppEvent>): void {
    for (const event of events) this.apply(event);
  }

  /** 该指纹在窗口内是否已发过 */
  suppressed(fingerprint: string, nowMs: number, windowMs: number): boolean {
    const last = this.marks.get(fingerprint);
    return last !== undefined && nowMs - last < windowMs;
  }

  entries(): Map<string, number> {
    return new Map(this.marks);
  }
}

// ──────────────────────────────── 工厂（任务接口） ────────────────────────────────

export function createNotifier(options: CreateNotifierOptions): AlertNotifier {
  const webhookUrl = options.config?.webhookUrl;
  const core = new Notifier({
    alertDir: join(options.dataDir, ALERT_DIR_NAME),
    rateLimitMin: pickRateLimitMin(options.config?.rateLimitMin),
    now: options.now,
    // 限流状态的唯一来源：事件先落盘（由宿主保证承诺类 fsync），内存索引跟上
    record: (record) => {
      options.emit(
        'alarm/sent',
        {
          fingerprint: record.fingerprint,
          level: record.level,
          title: record.title,
          // 故障键与"这条是恢复通知"是**可选**字段：普通告警（notify / 预算提示这类）不写 key，
          // 老日志里也整个没有。有了它们，`foldStalls` 才能在重启后把未恢复的故障重建回来。
          ...(record.key === undefined || record.key === null ? {} : { key: record.key }),
          ...(record.recovered === true ? { recovered: true } : {}),
        },
        defaultVisibility('alarm/sent'),
      );
    },
    ...(webhookUrl !== undefined ? { webhookUrl } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (options.history !== undefined) core.restore(options.history);
  return {
    send: (message) => core.sendMessage(message),
    alert: (input) => core.alert(input),
    fail: (input) => core.fail(input),
    ok: (category, body) => core.ok(category, body),
    releasePending: (category, body) => core.releasePending(category, body),
    restore: (events) => {
      core.restore(events);
    },
    windows: () => core.windows(),
    stats: () => core.stats(),
    setRateLimitMin: (min) => {
      core.setRateLimitMin(min);
    },
    setWebhookUrl: (url) => {
      core.setWebhookUrl(url);
    },
  };
}

// ──────────────────────────────── 实现 ────────────────────────────────

/** 告警与故障键的绑定：`recovered` 为 true 表示这条是恢复通知（不登记故障、只销账） */
interface FaultRef {
  key: string;
  recovered?: boolean | undefined;
}

/** 一次故障的连续窗口（stall 机制：恢复通知的依据）——定义见文件上方的 `foldStalls` 段 */

export class Notifier {
  private readonly alertDir: string;
  /** 限流窗口（毫秒）是配置热更点：非 readonly，走 setRateLimitMin */
  private rateLimitMs: number;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;
  /** webhook 出口属于"告警开关"，同在白名单内：非 readonly，走 setWebhookUrl */
  private webhookUrl: string | undefined;
  private readonly record: ((record: AlertRecord) => void) | undefined;

  /** 限流窗口：指纹 → 最近一次成功发出（含落盘）的时刻 */
  private readonly windowsMap = new Map<string, number>();
  /** 处于故障中的故障键 → 连续失败窗口 */
  private readonly stalling = new Map<string, StallRecord>();
  /**
   * 这些故障键是**上一个进程留下的**（由 `restore()` 折进来的），本进程从没见过它发生。
   *
   * 为什么要分开记（2026-10-05）：`restore()` 把历史故障重建回来，于是 `healthCheck` 的
   * `ok()` 在**重启后的第一拍**就会替它写一条"已恢复"——而本进程从头到尾没观察到一次失败，
   * 那句话说出口就是**编事实**（"连续失败已恢复成功"）。原来的 `record` 只喂 `deliver` 的
   * 成功分支，而恢复通知被限流时不落事件，所以这个洞一直没露出来；把销账补进限流分支之后
   * 它立刻现形了。
   *
   * 两条出路：
   *   · **新进程真的又失败过**（`fail()` 被调过，那条告警送没送达都算，见 `noteFault`）
   *     ⇒ `noteFault` 把它从这一集里摘掉，此后自然恢复照旧写（那是本进程亲眼看见的故障）；
   *   · **由进程状态决定、重启后重新评估**的那几类（预算耗尽、水位停滞）⇒ 走
   *     `alert/startup.ts` 的启动补写：那边要求"当刻确实不成立"才写，写完从这一集里摘掉。
   * 剩下的（"已经发生过的历史事实"）**永远等不到自动的"已恢复"**——那条账不该由重启来销。
   */
  private readonly carriedOver = new Set<string>();
  private readonly counters: AlertStats = { sent: 0, suppressed: 0, failed: 0 };
  /** 目录只创建一次；创建失败不拦发送（appendFile 会再报一次，行为一致） */
  private dirReady = false;

  constructor(options: NotifierOptions) {
    this.alertDir = options.alertDir;
    this.rateLimitMs = Math.round(pickRateLimitMin(options.rateLimitMin) * 60_000);
    this.now = options.now;
    this.webhookUrl = options.webhookUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.record = options.record;
    if (options.history !== undefined) {
      for (const [fingerprint, at] of options.history.entries()) {
        const previous = this.windowsMap.get(fingerprint);
        if (previous === undefined || at > previous) this.windowsMap.set(fingerprint, at);
      }
    }
  }

  // ── 宿主形状：send / recover（宿主自己写事件） ──

  /** 配置热更：改同类告警限流窗口（分钟）。已发出的窗口不回溯，新窗口从下一拍起生效 */
  setRateLimitMin(min: number): void {
    this.rateLimitMs = Math.round(pickRateLimitMin(min) * 60_000);
  }

  /** 配置热更：开/关/改 webhook 出口（undefined = 关闭外呼，只落文件档） */
  setWebhookUrl(url: string | undefined): void {
    this.webhookUrl = url === undefined || url.trim() === '' ? undefined : url;
  }

  /**
   * 发一条告警并按故障键登记 stall（故障期间重复调用同一标题即被限流，不刷屏）。
   * 返回回执：`sent` 为 false 时看 `reason` 区分"被限流"与"通道失败"。
   */
  async send(level: AlertLevel, title: string, body: string): Promise<AlertDelivery> {
    return this.deliver(
      { category: 'alert', level, title, body, params: { title } },
      fingerprintOf('alert', { title }),
      { key: `alert:${title}` },
    );
  }

  /**
   * 故障恢复通知：该故障键处于 stall **且它的告警真的报出去过**时发一条 info 并清除登记；
   * 否则返回 null（调用方据此决定要不要打"已恢复"日志——不制造假事实）。
   */
  async recover(spec: { level: AlertLevel; title: string }, note: string): Promise<AlertDelivery | null> {
    const key = `alert:${spec.title}`;
    const stall = this.stalling.get(key);
    if (stall === undefined) return null;
    // 先销账再投递：恢复通知自己失败（或异常重复调用）时不该变成每拍重试的刷屏源
    this.stalling.delete(key);
    if (!stall.announced) return null;
    const seconds = Math.max(0, Math.round((this.now().getTime() - stall.since) / 1000));
    return this.deliver(
      {
        category: 'alert:recovered',
        level: 'info',
        title: `已恢复：${spec.title}`,
        body: `${note}（同类故障连续 ${stall.count} 次，持续 ${seconds} 秒）`,
        params: { title: spec.title },
      },
      // 恢复通知单独成指纹，不被故障那 30 分钟窗口连坐
      fingerprintOf('alert:recovered', { title: spec.title }),
      // 恢复通知自己**不是**故障：不登记、也不重复销账
      { key, recovered: true },
    );
  }

  // ── 任务形状：admin 兼容 + alert / fail / ok ──

  /** admin.ts 的 Notifier 形状：消息类告警，以标题为关键参数（同标题半小时只提醒一次） */
  async sendMessage(message: NotifyMessage): Promise<NotifyOutcome> {
    return this.alert({
      category: 'notify',
      level: message.level,
      title: message.title,
      body: message.body,
      params: { title: message.title },
    });
  }

  /** 带类别与参数指纹的告警（不登记 stall：普通告警不是故障） */
  async alert(input: AlertInput): Promise<NotifyOutcome> {
    return toOutcome(await this.deliver(input, fingerprintOf(input.category, input.params), null));
  }

  /** 故障上报：登记 stall + 投递；重复调用只累计次数（告警被限流） */
  async fail(input: AlertInput): Promise<NotifyOutcome> {
    return toOutcome(await this.deliver(
      input,
      fingerprintOf(input.category, input.params),
      { key: `category:${input.category}` },
    ));
  }

  /**
   * 恢复上报：处于 stall 时发一条"已恢复"并清除登记；不在 stall（或那次故障没送达）时什么都不做。
   *
   * 两条**不许写**的情形（都写在这一个地方，调用方不必自己判）：
   *   · 那次故障没送达（`announced` 为假）——人从来没被告知出过事，恢复通知就是假事实；
   *   · 这个故障键是 `restore()` 从上一个进程折进来的（见 `carriedOver`）——本进程没有
   *     "恢复成功"那一刻可写。要销这类账，走启动补写（`alert/startup.ts`），
   *     那条路要求"当刻确实不成立"才算数。
   */
  async ok(category: string, body?: string | undefined): Promise<NotifyOutcome> {
    const key = `category:${category}`;
    const stall = this.stalling.get(key);
    if (stall === undefined) return { ok: true };
    if (this.carriedOver.has(key)) return { ok: true };
    this.stalling.delete(key);
    if (!stall.announced) return { ok: true };
    const seconds = Math.max(0, Math.round((this.now().getTime() - stall.since) / 1000));
    const input: AlertInput = {
      category: `${category}:recovered`,
      level: 'info',
      title: `已恢复：${category}`,
      body: body ?? `同类故障连续 ${stall.count} 次后首次成功，已恢复（故障持续 ${seconds} 秒）。`,
      params: { category },
    };
    return toOutcome(await this.deliver(
      input,
      fingerprintOf(input.category, input.params),
      { key, recovered: true },
    ));
  }

  /**
   * 恢复入口：把历史 `alarm/sent` 折进两份状态——限流窗口（M3-10 跨重启限流）与
   * **尚未恢复的故障登记**（`foldStalls`）。后者让"已恢复"在重启之后仍然配得上它的报警。
   *
   * 折进来的故障同时记进 `carriedOver`（本进程没见过它发生）：于是 `ok()` 不会替它
   * 写一条本进程没资格写的"已恢复"，要销账得走 `releasePending()`（启动补写那条路）。
   */
  restore(events: Iterable<AppEvent>): void {
    const list = [...events];
    for (const [fingerprint, at] of foldAlarms(list)) {
      const previous = this.windowsMap.get(fingerprint);
      if (previous === undefined || at > previous) this.windowsMap.set(fingerprint, at);
    }
    for (const [key, record] of foldStalls(list)) {
      // 只补空缺：本进程已经登记的故障（更新、更准）不被历史覆盖
      if (this.stalling.has(key)) continue;
      this.stalling.set(key, record);
      this.carriedOver.add(key);
    }
  }

  /**
   * 启动补写的销账入口：`category:<类别>` 这个历史故障**当刻确实不成立**时，写一条"已恢复"。
   *
   * 与 `ok()` 的分工是一条线：`ok()` 写"本进程看见的恢复"，本方法写"**上一个进程留下的、
   * 当刻已经核实过不成立**的恢复"。调用方（`runtime/real-loop.ts` 的启动路径）负责核实，
   * 核实不了就别调——这里不做二次判定，判据只有一份（见 `alert/startup.ts`）。
   *
   * 幂等：写下去之后登记与"上一个进程留下的"标记都被摘掉，同一进程内再调是空操作；
   * 下一次启动 `foldStalls` 见到那条 `recovered:true` 也不会再把这个键折回来。
   */
  async releasePending(category: string, body: string): Promise<NotifyOutcome> {
    const key = `category:${category}`;
    const stall = this.stalling.get(key);
    if (stall === undefined) return { ok: true };
    this.stalling.delete(key);
    this.carriedOver.delete(key);
    if (!stall.announced) return { ok: true };
    const seconds = Math.max(0, Math.round((this.now().getTime() - stall.since) / 1000));
    const input: AlertInput = {
      category: `${category}:recovered`,
      level: 'info',
      title: `已恢复：${category}`,
      body: `${body}（这条故障是上一个进程报出去的，持续 ${seconds} 秒）`,
      params: { category },
    };
    return toOutcome(await this.deliver(
      input,
      fingerprintOf(input.category, input.params),
      { key, recovered: true },
    ));
  }

  windows(): Map<string, number> {
    return new Map(this.windowsMap);
  }

  stats(): AlertStats {
    return { ...this.counters };
  }

  // ── 投递 ──

  private async deliver(
    input: AlertInput,
    fingerprint: string,
    fault: FaultRef | null,
  ): Promise<AlertDelivery> {
    const at = this.now();
    const nowMs = at.getTime();
    const ts = at.toISOString();
    const file = this.filePath(ts);

    const last = this.windowsMap.get(fingerprint);
    if (last !== undefined && nowMs - last < this.rateLimitMs) {
      // 有意丢弃：不是失败，是限流。故障仍在持续，stall 登记照旧推进（只是没送达）
      this.counters.suppressed += 1;
      this.noteFault(fault, fingerprint, false);
      // **恢复通知的销账不许被限流吞掉**（2026-10-05 修的现场）。
      //
      // 限流是**人看的通道**的节流（文件档 + webhook）：一天里解了两次同一个故障，
      // 人不需要收两条推送。但"这个故障已经解除"是**账**——前端读的是 `alarm/sent` 事件
      // （见 web/server.ts 的 frameworkNotesView），账缺一条，卡上就永远红着。
      //
      // 现场（实测：真实日志 30159 条，见 _research/alarm-probe.txt）：09:33:55 解 daily 层
      // 写下了恢复通知（fp=856b390081a0cb84），14 分钟后 09:47:28 解 task 层时同一个指纹
      // 还在 30 分钟窗口内 ⇒ 这一条被限流丢弃 ⇒ **`budget/resumed` 落了库、恢复通知没落库**，
      // 运行情况页那条「预算耗尽（任务 token）」一直红着，而它早就解除了。
      //
      // 所以这里只补一件事：recovered 记录照旧交给宿主落 `alarm/sent`（日志只增不改，
      // 同一次故障的配对账必须完整）。对外**照实**返回被限流——这一条没有推送出去。
      if (fault?.recovered === true) {
        this.record?.({
          fingerprint,
          level: input.level,
          title: input.title,
          key: fault.key,
          recovered: true,
        });
      }
      return { sent: false, fingerprint, file, reason: RATE_LIMITED };
    }

    const fileOutcome = await this.appendLine(file, ts, fingerprint, input);
    const webhookOutcome = await this.postWebhook({ ts, fingerprint, input });

    // 两件事要分开：
    //   · 存档（限流窗口的推进依据）＝ 任一通道成功。只要落盘了就推进窗口，
    //     否则一个挂掉的 webhook 会在每一拍被重试（刷屏 + 无谓外呼）；
    //   · 送达（返回的 sent）＝ 真正给人的通道成功：配了 webhook 就只看它，
    //     没配才由文件档担当。
    const fileOk = fileOutcome === null;
    const webhookOk = webhookOutcome !== null && webhookOutcome.ok;
    const archived = fileOk || webhookOk;
    if (archived) {
      this.counters.sent += 1;
      this.windowsMap.set(fingerprint, nowMs);
      this.noteFault(fault, fingerprint, true);
      this.record?.({
        fingerprint,
        level: input.level,
        title: input.title,
        // 故障键只在故障类告警上出现：普通告警的 key 是 null，老日志则整个字段都没有
        key: fault?.key ?? null,
        ...(fault?.recovered === true ? { recovered: true } : {}),
      });
    } else {
      this.counters.failed += 1;
      this.noteFault(fault, fingerprint, false);
    }

    const reasons: string[] = [];
    if (fileOutcome !== null) reasons.push(fileOutcome.reason);
    if (webhookOutcome !== null && !webhookOutcome.ok) reasons.push(webhookOutcome.reason);
    const delivered = this.webhookUrl === undefined ? fileOk : webhookOk;
    if (delivered) return { sent: true, fingerprint, file };
    return { sent: false, fingerprint, file, reason: reasons.join('；') || '所有通道均失败' };
  }

  /** 文件档：追加一行。失败不抛——告警出口自己崩掉比漏一条更糟 */
  private async appendLine(
    file: string,
    ts: string,
    fingerprint: string,
    input: AlertInput,
  ): Promise<{ ok: false; reason: string } | null> {
    try {
      if (!this.dirReady) {
        await mkdir(this.alertDir, { recursive: true });
        this.dirReady = true;
      }
      await appendFile(file, formatLine(ts, fingerprint, input), 'utf8');
      return null;
    } catch (err) {
      return { ok: false, reason: `告警日志写入失败：${describeError(err)}` };
    }
  }

  /** Webhook 档：未配置返回 null（"没有这一档"与"这一档失败"是两件事） */
  private async postWebhook(args: {
    ts: string;
    fingerprint: string;
    input: AlertInput;
  }): Promise<{ ok: true } | { ok: false; reason: string } | null> {
    const url = this.webhookUrl;
    if (url === undefined) return null;
    const payload = JSON.stringify({
      level: args.input.level,
      title: args.input.title,
      body: args.input.body,
      ts: args.ts,
      fingerprint: args.fingerprint,
    });
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (!response.ok) return { ok: false, reason: `Webhook 返回 HTTP ${response.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `Webhook 投递失败：${describeError(err)}` };
    }
  }

  private markStall(key: string, fingerprint: string, announced: boolean): void {
    const existing = this.stalling.get(key);
    if (existing === undefined) {
      this.stalling.set(key, { since: this.now().getTime(), count: 1, fingerprint, announced });
      return;
    }
    existing.count += 1;
    if (announced) existing.announced = true;
  }

  /**
   * 故障登记的推进：普通故障（`fault.recovered !== true`）落账；恢复通知自己只是销账完成，
   * 不再重新登记——否则一次恢复就会把刚清掉的故障键又立起来。
   *
   * 走到这里就等于**本进程又见过它发生了一次**（`fail()` 是"这个故障此刻成立"的唯一入口；
   * 普通告警与恢复通知带的 `fault` 分别是 null / `recovered:true`，都在上面挡掉了），
   * 所以"上一个进程留下的"标记要在这里摘掉：此后它是一条本进程看着的活故障，
   * 自然恢复当然该写「已恢复」。
   *
   * 判据是**见过它发生**，不是**这一条告警送达了**（2026-10-05 修的真 bug）：限流节流的是
   * 给人看的通道，它挡不住"故障又发生了一次"这个事实——何况这个故障账早在前一个进程就
   * 报出去过（`foldStalls` 只折已送达的键，折回来的 `announced` 必为真）。若在这里再要求
   * 一次送达，被限流压住的那次观察就不算数，于是本进程后面**真的**看着它解除时也写不出
   * 销账，运行情况页那张卡就一直红着——`model-failure` 更惨：它不在启动补写的判据表里
   * （历史事实类，见 `alert/startup.ts` 的 `NEVER_BACKFILLED`），重启那条路也不救它。
   * 那正是这一整段要修的病，所以要在这里挡住它。
   */
  private noteFault(fault: FaultRef | null, fingerprint: string, archived: boolean): void {
    if (fault === null || fault.recovered === true) return;
    this.markStall(fault.key, fingerprint, archived);
    this.carriedOver.delete(fault.key);
  }

  /** 告警日志按 UTC 日期分片（与 budget/rollover 的"今日"口径一致） */
  private filePath(ts: string): string {
    return join(this.alertDir, `${ts.slice(0, 10)}.log`);
  }
}

// ──────────────────────────────── 小工具 ────────────────────────────────

/** 内部回执 → admin 形状的结局：被限流不是失败（有意丢弃） */
function toOutcome(delivery: AlertDelivery): NotifyOutcome {
  if (delivery.sent) return { ok: true };
  if (delivery.reason === RATE_LIMITED) return { ok: true };
  return { ok: false, reason: delivery.reason ?? '告警未送达' };
}

/** 人类可读一行（换行转义，保证一条告警恒占一行，便于 tail/grep） */
function formatLine(ts: string, fingerprint: string, input: AlertInput): string {
  const body = input.body.replace(/\r?\n/gu, ' ⏎ ');
  return `${ts} [${input.level}] fp=${fingerprint} ${input.title} | ${body}\n`;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pickRateLimitMin(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RATE_LIMIT_MIN;
}
