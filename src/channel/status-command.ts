/**
 * Irmia Agent — 「状态命令」：白名单 QQ 号发触发词 → 合并转发回一份本机状态报告。
 *
 * ──────────────────────────────── 这个模块解决的是什么 ────────────────────────────────
 *
 * 主用户想在 QQ 上随时看一眼"这台机器现在怎么样"：CPU/内存/磁盘/开机多久、Irmia 自己
 * 跑了多久。这条需求有三个硬约束，决定了它**不是插件、不进 agent**：
 *
 *   ① **确定性**：触发就必须回，不能取决于模型那一刻"觉得该不该做"；
 *   ② **零模型成本**：回一条状态不该花一次 turn 的 token；
 *   ③ **快**：秒回，而不是排在她的发言队列后面等。
 *
 * 所以它落在通道层（main.ts 的消息入口拦截），本模块只做三件纯事：**匹配**、**采集**、
 * **发送编排**（合并转发失败降级纯文本）。发送本身由宿主把 OneBot 通道适配成
 * `StatusForwardSender` 递进来——这里不 import 通道实现，保持可单测、无环。
 *
 * ──────────────────────────────── 三条纪律 ────────────────────────────────
 *
 *  ① **整句完全相等**，不是子串：「sts」不该被「status」命中，反过来也不该。这是命令，
 *     命令就要有命令的边界；模糊匹配的成本是误触发，而误触发等于替别人执行。
 *  ② **采集是采样，不是瞬读**：CPU 占用率要隔一拍取两次 `os.cpus()` 求差分才有意义。
 *     采样间隔（350ms）与 sleep 都可注入，测试里用假探针 + 假时钟，零等待、零平台依赖。
 *  ③ **降级要如实记账**：协议端不认 `send_*_forward_msg` 时回退纯文本多发，并写一行日志——
 *     "合并转发没发出去"这个事实不许无声消失。
 */

import { statfsSync } from 'node:fs';
import { cpus, freemem, totalmem, uptime } from 'node:os';

export interface StatusCommandConfig {
  /** 允许触发的 QQ 号（字符串形态） */
  users: readonly string[];
  /** 触发词（整句 trim 后完全相等） */
  triggers: readonly string[];
}

/** 通道消息里本模块关心的最小形状（WakeChannel['data'] 的子集，不 import 事件层） */
export interface StatusMessage {
  channel: string;
  chatType: string;
  chatId: string;
  person: string;
  text: string;
}

/** 纯判据：发送者在白名单里，且整句（trim 后）与某个触发词完全相等。 */
export function matchesStatusCommand(data: Pick<StatusMessage, 'person' | 'text'>, config: StatusCommandConfig): boolean {
  if (!config.users.includes(data.person)) return false;
  return config.triggers.includes(data.text.trim());
}

/** 秒 → 人话时长：3天4小时 / 4小时12分 / 3分20秒。 */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分`;
  return `${minutes}分${s % 60}秒`;
}

/** `os.cpus()` 单核时间的最小形状（测试用假数据照这个造） */
export interface CpuTimes {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}

/**
 * 两次采样之间的全核 CPU 占用率（0~100 整数）：(Δtotal − Δidle) / Δtotal。
 * 核数变了（热插拔几乎不会发生，但测试会）就按较短那组对齐；没有正的时间差分返回 0——
 * "这次测不出来"如实说 0%，比编一个数好。
 */
export function cpuUsagePercent(prev: readonly { times: CpuTimes }[], next: readonly { times: CpuTimes }[]): number {
  let idle = 0;
  let total = 0;
  const cores = Math.min(prev.length, next.length);
  for (let i = 0; i < cores; i += 1) {
    const p = prev[i]!.times;
    const n = next[i]!.times;
    const dTotal = (n.user + n.nice + n.sys + n.idle + n.irq) - (p.user + p.nice + p.sys + p.idle + p.irq);
    const dIdle = n.idle - p.idle;
    if (dTotal <= 0) continue;
    total += dTotal;
    idle += Math.max(0, Math.min(dIdle, dTotal));
  }
  if (total <= 0) return 0;
  return Math.round(((total - idle) / total) * 100);
}

/** 系统探针：全部可注入——测试给假的，运行期用 `nodeSystemProbe`。 */
export interface SystemProbe {
  cpus(): Array<{ model: string; times: CpuTimes }>;
  totalmem(): number;
  freemem(): number;
  uptime(): number;
  /** 某个盘符的用量（`C`）；不存在/读不出给 null */
  drive(letter: string): { sizeBytes: number; freeBytes: number } | null;
}

/** 运行期真探针：`statfsSync` 读盘（Node 22 原生，不需要 wmic/pwsh 子进程）。 */
export const nodeSystemProbe: SystemProbe = {
  cpus: () => cpus(),
  totalmem: () => totalmem(),
  freemem: () => freemem(),
  uptime: () => uptime(),
  drive: (letter) => {
    try {
      const s = statfsSync(`${letter}:\\`);
      return { sizeBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
    } catch {
      return null;
    }
  },
};

const gb = (bytes: number): string => (bytes / (1024 * 1024 * 1024)).toFixed(1);

/**
 * 采集系统状态行（CPU/内存/各盘/开机）。**采样间隔一拍**（sleep 可注入）——
 * 单读 `os.cpus()` 给的是自首启以来的累计，不是"现在多忙"。
 */
export async function collectStatusLines(probe: SystemProbe, sleep: (ms: number) => Promise<void>): Promise<string[]> {
  const before = probe.cpus();
  await sleep(350);
  const after = probe.cpus();

  const model = (after[0]?.model ?? '未知 CPU').replace(/\s+/g, ' ').trim();
  const usedPercent = cpuUsagePercent(before, after);
  const total = probe.totalmem();
  const free = probe.freemem();
  const used = total - free;

  const lines = [
    `CPU：${model}（${after.length} 线程）占用 ${usedPercent}%`,
    `内存：${gb(used)} / ${gb(total)} GB（${total > 0 ? Math.round((used / total) * 100) : 0}%）`,
  ];
  // 固定盘符扫一遍：不存在的盘 statfsSync 会抛，探针层已折成 null——这台机器将来加盘
  // 不需要改这里。
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const d = probe.drive(letter);
    if (d === null || d.sizeBytes <= 0) continue;
    lines.push(`磁盘（${letter}:）：剩 ${gb(d.freeBytes)} / 共 ${gb(d.sizeBytes)} GB`);
  }
  lines.push(`开机：${formatDuration(probe.uptime())}`);
  return lines;
}

/** 宿主递进来的发送口（OneBot 通道在 main.ts 里适配成这个形状）。 */
export interface StatusForwardSender {
  /** 合并转发：每条状态行一个转发节点 */
  sendForward(chatType: string, chatId: string, lines: readonly string[]): Promise<{ ok: boolean; reason?: string }>;
  /** 纯文本兜底（协议端不认 forward 动作时用） */
  sendText(chatType: string, chatId: string, text: string): Promise<{ ok: boolean; reason?: string }>;
}

export interface StatusCommand {
  /** 命中 = 这条消息被本命令接管（不再进 agent、不落信箱） */
  match(data: StatusMessage): boolean;
  /** 采集 + 发送（含降级）；异常与结果都记账，绝不抛给调用方 */
  handle(data: StatusMessage, sender: StatusForwardSender): Promise<void>;
}

export function createStatusCommand(options: {
  config: StatusCommandConfig;
  /** 宿主补充的状态行（版本、进程运行时长之类）：放在系统行之后 */
  extraLines?: () => string[] | Promise<string[]>;
  probe?: SystemProbe;
  sleep?: (ms: number) => Promise<void>;
  write?: (line: string) => void;
}): StatusCommand {
  const probe = options.probe ?? nodeSystemProbe;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const write = options.write ?? (() => {});

  return {
    match: (data) => data.channel === 'onebot' && matchesStatusCommand(data, options.config),
    handle: async (data, sender) => {
      const extras = await (options.extraLines?.() ?? []);
      const lines = [...await collectStatusLines(probe, sleep), ...extras];
      const forward = await sender.sendForward(data.chatType, data.chatId, lines);
      if (forward.ok) {
        write(`[状态命令] 已把状态报告（合并转发 ${lines.length} 条）回给 ${data.person}`);
        return;
      }
      // 协议端不认合并转发：降级纯文本，两边都记账——降级本身也是"运行状态"的一部分。
      const fallback = await sender.sendText(data.chatType, data.chatId, lines.join('\n'));
      write(`[状态命令] 合并转发被协议端拒绝（${forward.reason ?? '未知原因'}），已降级纯文本：`
        + (fallback.ok ? '发送成功' : `纯文本也失败（${fallback.reason ?? '未知原因'}）`));
    },
  };
}
