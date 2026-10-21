/**
 * Irmia Agent — 后台任务管理器（docs/design.md §4.21 jobs、docs/milestones.md M8-5）
 *
 * 职责：把「后台进程」这一件事收成一个入口。pwsh 的后台模式（`runInBackground`，v27 之后
 * 是唯一入口——别名 `run_command` 已删）必须从这里进出——**事件写入点只此一处**，
 * 否则 `job/*` 会散落在各个工具里，投影的 `jobs` 字段就会变成"看谁记得写"。
 *
 * 三段链路（§4.21 原文）：
 *   job/started{jobId, command, turn}  (internal)
 *     → 进程脱离 turn 独立跑，输出落 data/jobs/<jobId>.log
 *     → job/finished{jobId, exitCode, outputRef}  (internal)  大输出外置到 blob
 *     → wake/job{jobId}  (model)  唤醒下一轮
 *
 * 三条必须守住的语义：
 * 1. **outcome 先落盘、事件后写**：`job/finished` 里的 outputRef 必须已经可读，
 *    否则恢复流程拿着一份指向空文件的事件去复盘（与 §4.12 blob 的"先落盘再写事件"同一条铁律）。
 * 2. **job/started 是承诺类（sync）**：进程已经跑起来了，事件就必须在盘上。
 *    进程崩了而 started 没落盘 = 一个永远不被结算的孤儿。
 * 3. **重启后孤儿必须结算**：上一个进程留下的 `job/started` 没有配对 `job/finished`，
 *    那些进程已经随宿主一起死了——收尾写 finished{exitCode:null}，让投影回到自洽状态。
 *    不结算的后果是 `status` 里永远挂着一个"运行中"的假任务。
 *
 * 零外部依赖：只用 node: 标准库。
 */

import { createHash } from 'node:crypto';
import {
  mkdir, open, readdir, readFile, stat, writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import type { AppEvent, Projection, WakeJob } from '../log/types.js';
import { JOB_WAKE_EXCERPT_CHARS } from '../log/types.ts';
import type { EventLog } from '../log/event-log.js';
import { blobPathOf, estimateTokens } from '../state/blob-store.ts';
import { applyOne, finalizePressure } from '../state/fold.ts';
import { JOB_LOG_SUFFIX } from '../tools/pwsh.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 后台任务产物目录名（相对 dataDir）：输出正文 `<jobId>.log`、诊断索引 `<jobId>.json` */
export const JOBS_DIR_NAME = 'jobs';

/**
 * 索引文件后缀。与 `.log` 分开的第二个文件而不是塞在 `.log` 头部：
 * `.log` 是给人和 `safe_read` 看的原始输出，掺进元数据会污染"输出即原文"的语义。
 */
export const JOB_INDEX_SUFFIX = '.json';

/** 输出外置阈值（估算 token）。默认沿用 blob 口径（8k token），与 §4.12 一致 */
export const DEFAULT_JOB_BLOB_THRESHOLD_TOKENS = 8_000;

// ──────────────────────────────── 对外类型 ────────────────────────────────

/**
 * 任务产物的两个可寻址位置。**`job/finished` 回调里的 `outputRef` 就是它**——
 * 不再另造一对字段：多一个字段就多一处可以和回调漂移的口径。
 */
export interface JobOutput {
  /** 输出正文文件绝对路径（`data/jobs/<jobId>.log`） */
  file: string;
  /** 大输出外置时的 blob 引用（内容寻址，data/blobs/<blobId>） */
  blob?: { blobId: string; bytes: number };
}

export type JobStatus =
  /** 本进程内正在跑 */
  | 'running'
  /** 已正常收尾（含失败退出） */
  | 'finished'
  /** 宿主重启时发现它没有终点——进程已死，按丢失结算 */
  | 'lost';

export interface JobRecord {
  jobId: string;
  command: string;
  turn: number;
  status: JobStatus;
  /** 启动时刻（job/started 的 ts） */
  startedAt: string;
  /** 结束时刻（仅 finished / lost 有） */
  finishedAt?: string;
  exitCode?: number | null;
  output?: JobOutput;
}

export interface JobManagerDeps {
  /** 事件日志；JobManager 是 job/* 与 wake/job 的唯一写入点 */
  log: EventLog;
  /** 数据目录：产物落 `<dataDir>/jobs/`、blob 落 `<dataDir>/blobs/` */
  dataDir: string;
  /** 时钟注入（测试用）；默认取系统时间 */
  now?: () => Date;
  /** 输出外置阈值（估算 token）；默认 DEFAULT_JOB_BLOB_THRESHOLD_TOKENS */
  blobThresholdTokens?: number;
  /**
   * 事件投影：**给了就当场折进去**（`#emit` 里那一段注释记着为什么非折不可——
   * 不折的后果是 `wake/job` 只落事件、不起 turn）。
   *
   * 不传 = 只写日志不折（CLI 诊断、单测里只想看事件的场景）：调用方**必须自己知道**
   * 这一份投影不会被更新，别把"没折"当成"事件没写"。
   */
  projection?: Projection;
  /** 诊断出口（落盘失败、索引写失败等）；默认丢弃 */
  warn?: (message: string) => void;
}

// ──────────────────────────────── 路径 ────────────────────────────────

/** 后台任务产物目录：<dataDir>/jobs */
export function jobsDirOf(dataDir: string): string {
  return join(dataDir, JOBS_DIR_NAME);
}

/** 任务输出正文路径 */
export function jobLogPathOf(dataDir: string, jobId: string): string {
  return join(jobsDirOf(dataDir), `${jobId}${JOB_LOG_SUFFIX}`);
}

/** 任务诊断索引路径 */
export function jobIndexPathOf(dataDir: string, jobId: string): string {
  return join(jobsDirOf(dataDir), `${jobId}${JOB_INDEX_SUFFIX}`);
}

/**
 * jobId 只允许「字母数字下划线短横点」。它是文件名的一段，而文件名来自模型可控的
 * 后台命令 —— 不做白名单就是一个目录穿越口子（`../../x`）。
 */
const JOB_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;

export function isJobId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && JOB_ID_PATTERN.test(value);
}

// ──────────────────────────────── 纯读：历史与输出 ────────────────────────────────

/**
 * 扫 `data/jobs/` 的索引文件还原任务列表（**只读，不写事件**）。
 *
 * 存在的理由：CLI 与观测前端要能看到"上一个进程跑过的任务"，而内存表只覆盖本进程。
 * 索引缺失或损坏的任务按最小事实还原（只在目录里有 `.log` 时也列出来）——宁可少几个字段，
 * 也不要因为一个坏索引就让一个真实存在过的任务从列表里消失。
 */
export async function readJobHistory(dataDir: string): Promise<JobRecord[]> {
  const dir = jobsDirOf(dataDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const ids = new Set<string>();
  for (const name of names) {
    if (name.endsWith(JOB_INDEX_SUFFIX)) ids.add(name.slice(0, -JOB_INDEX_SUFFIX.length));
    else if (name.endsWith(JOB_LOG_SUFFIX)) ids.add(name.slice(0, -JOB_LOG_SUFFIX.length));
  }

  const records: JobRecord[] = [];
  for (const jobId of ids) {
    if (!isJobId(jobId)) continue;
    const logPath = jobLogPathOf(dataDir, jobId);
    let record: JobRecord | null = null;
    try {
      const raw = await readFile(jobIndexPathOf(dataDir, jobId), 'utf8');
      record = parseJobIndex(raw, jobId, logPath);
    } catch {
      record = null;
    }
    if (record !== null) {
      records.push(record);
      continue;
    }
    // 索引缺失：用输出文件的 mtime 当结束时刻，至少把事实留在列表里
    let startedAt = '';
    try {
      const info = await stat(logPath);
      startedAt = info.mtime.toISOString();
    } catch {
      continue;
    }
    records.push({
      jobId, command: '', turn: 0, status: 'lost', startedAt,
      output: { file: logPath },
    });
  }

  records.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  return records;
}

function parseJobIndex(raw: string, jobId: string, logPath: string): JobRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const status = o['status'];
  if (status !== 'running' && status !== 'finished' && status !== 'lost') return null;
  const blob = o['blob'];
  const output: JobOutput = typeof blob === 'object' && blob !== null
    ? { file: logPath, blob: blob as NonNullable<JobOutput['blob']> }
    : { file: logPath };
  const exitCode = o['exitCode'];
  const record: JobRecord = {
    jobId,
    command: typeof o['command'] === 'string' ? o['command'] : '',
    turn: typeof o['turn'] === 'number' ? o['turn'] : 0,
    status,
    startedAt: typeof o['startedAt'] === 'string' ? o['startedAt'] : '',
    output,
  };
  if (typeof o['finishedAt'] === 'string') record.finishedAt = o['finishedAt'];
  if (typeof exitCode === 'number' || exitCode === null) record.exitCode = exitCode as number | null;
  return record;
}

export interface JobOutputText {
  ok: boolean;
  text: string;
  /** 读的是外置 blob 还是原文件，便于 CLI 说清"这份全文从哪来" */
  from: 'file' | 'blob' | 'none';
}

/**
 * 取任务输出全文。外置过的任务优先读 blob（内容寻址、不会被后续清理动作改掉），
 * blob 缺位时回落到输出文件——快照机制永远可能被人工清理，读路径不能只有一条腿。
 */
export async function readJobOutput(dataDir: string, record: JobRecord): Promise<JobOutputText> {
  const blob = record.output?.blob;
  if (blob !== undefined) {
    try {
      return { ok: true, text: await readFile(blobPathOf(dataDir, blob.blobId), 'utf8'), from: 'blob' };
    } catch {
      // 落到文件路径继续尝试
    }
  }
  const file = record.output?.file ?? jobLogPathOf(dataDir, record.jobId);
  try {
    return { ok: true, text: await readFile(file, 'utf8'), from: 'file' };
  } catch {
    return { ok: false, text: '', from: 'none' };
  }
}

// ──────────────────────────────── 管理器 ────────────────────────────────

/**
 * `#emit` 的入参：只允许三种负载形状，字段与 log/types.ts 的 JobStarted / JobFinished /
 * WakeJob 逐字对齐。多一个字段这里就编译不过。
 */
type JobEventInput =
  | { type: 'job/started'; data: { jobId: string; command: string; turn: number } }
  | { type: 'job/finished'; data: { jobId: string; exitCode: number | null; outputRef: string } }
  | { type: 'wake/job'; data: WakeJob['data'] };

/** pwsh 后台模式的回调形状（与 tools/pwsh.ts 的 JobCallbacks 结构兼容，值导入避免反向依赖） */
export interface JobStartedInput { jobId: string; command: string; turn: number }
export interface JobFinishedInput { jobId: string; exitCode: number | null; outputRef?: string }

export class JobManager {
  readonly #log: EventLog;
  readonly #dataDir: string;
  readonly #now: () => Date;
  readonly #thresholdTokens: number;
  readonly #warn: (message: string) => void;

  /** 事件投影（可选）：`#emit` 写完日志就把事件折进去，`wake/job` 才能变成一次真唤醒 */
  readonly #projection: Projection | null;

  /** jobId → 本进程内见过的任务（started 即入表） */
  readonly #jobs = new Map<string, JobRecord>();

  /**
   * 本进程亲手起过的 jobId。只用于把「本进程正在跑」与「上个进程留下的孤儿」分开——
   * 两者的投影形状一模一样（都有 job/started、都没有 job/finished）。
   */
  readonly #selfStarted = new Set<string>();

  constructor(deps: JobManagerDeps) {
    this.#log = deps.log;
    this.#dataDir = deps.dataDir;
    this.#now = deps.now ?? (() => new Date());
    this.#thresholdTokens = deps.blobThresholdTokens ?? DEFAULT_JOB_BLOB_THRESHOLD_TOKENS;
    this.#projection = deps.projection ?? null;
    this.#warn = deps.warn ?? (() => undefined);
  }

  /** 交给 createPwshTool 的回调对：**两个后台入口共用这一个对象** */
  get callbacks(): { started: (job: JobStartedInput) => void; finished: (job: JobFinishedInput) => void } {
    return {
      started: (job) => { this.onStarted(job); },
      finished: (job) => { void this.onFinished(job); },
    };
  }

  /** 输出落盘目录（pwsh 会直接往这里写 `<jobId>.log`） */
  get jobsDir(): string {
    return jobsDirOf(this.#dataDir);
  }

  // ── 写入侧 ──

  /**
   * 任务启动：先记索引再写事件？**反过来**。
   * job/started 是承诺类事件（sync）：命令已经交给系统了，事件必须在盘上——写索引失败
   * 不该让一个真在跑的任务从日志里消失。
   */
  onStarted(job: JobStartedInput): void {
    const startedAt = this.#now().toISOString();
    const record: JobRecord = {
      jobId: job.jobId,
      command: job.command,
      turn: job.turn,
      status: 'running',
      startedAt,
      output: { file: jobLogPathOf(this.#dataDir, job.jobId) },
    };
    this.#jobs.set(job.jobId, record);
    this.#selfStarted.add(job.jobId);
    this.#emit(
      { type: 'job/started', data: { jobId: job.jobId, command: job.command, turn: job.turn } },
      'internal',
      true,
    );
    void this.#persistIndex(record);
  }

  /**
   * 任务收尾：outcome → 索引 → job/finished → wake/job。
   * 输出外置在事件之前完成，所以事件里的 outputRef 在任何时刻取都拿得到正文。
   */
  async onFinished(job: JobFinishedInput): Promise<JobRecord> {
    const existing = this.#jobs.get(job.jobId);
    const finishedAt = this.#now().toISOString();
    const settled = await this.#settleOutput(job);
    const output = settled.output;

    const record: JobRecord = {
      jobId: job.jobId,
      command: existing?.command ?? '',
      turn: existing?.turn ?? 0,
      status: 'finished',
      startedAt: existing?.startedAt ?? finishedAt,
      finishedAt,
      exitCode: job.exitCode,
      output,
    };
    this.#jobs.set(job.jobId, record);

    // 索引先落盘：事件一旦可见，观测侧就能读到 outcome
    await this.#persistIndex(record);
    this.#emit(
      { type: 'job/finished', data: { jobId: job.jobId, exitCode: job.exitCode, outputRef: JSON.stringify(output) } },
      'internal',
      true,
    );
    // 唤醒是新一轮输入的来源，必须是可见事件（model），否则后台任务完成等于没发生过。
    // **结果正文跟着它走**（见 `JOB_WAKE_EXCERPT_CHARS`）：唤醒起来的那一轮里，
    // 她看到的就是这一截，不必再花一次调用去捞。
    this.#emit({ type: 'wake/job', data: this.#wakeDataOf(record, settled.text) }, 'model', true);
    return record;
  }

  /**
   * 重启孤儿结算（§5 崩溃恢复时序的 jobs 分支）。
   *
   * 判据是**两条同时成立**：投影里还挂着 `job/started` 而没有 `job/finished`，
   * **且**这个 jobId 不是恢复完成后本进程自己起的（`#selfStarted`）。
   * 只看投影是不够的——运行期投影同样含本进程正在跑的任务，结算它们就是把活的任务
   * 判成死的。只看内存表也是不够的——重启后内存表必然是空的。
   *
   * 收尾写 finished{exitCode:null} + wake/job：让「有一个任务在跑」这句判断不再骗人，
   * 也让模型知道那件事没有结果。幂等：结算后投影里该 jobId 消失，重复调用不重复写事件。
   */
  async recoverOrphans(projection: Projection): Promise<string[]> {
    const settled: string[] = [];
    for (const jobId of Object.keys(projection.jobs)) {
      if (!isJobId(jobId)) continue;
      if (this.#selfStarted.has(jobId)) continue; // 本进程起的，正在跑
      const pending = projection.jobs[jobId];
      const command = pending?.command ?? '';
      const turn = pending?.turn ?? 0;
      const at = this.#now().toISOString();
      const output = { file: jobLogPathOf(this.#dataDir, jobId) };
      const record: JobRecord = {
        jobId, command, turn, status: 'lost', startedAt: pending?.startedAt ?? at,
        finishedAt: at, exitCode: null, output,
      };
      this.#jobs.set(jobId, record);
      await this.#persistIndex(record);
      this.#emit(
        { type: 'job/finished', data: { jobId, exitCode: null, outputRef: JSON.stringify(output) } },
        'internal',
        true,
      );
      // 孤儿结算同样带正文一截（有就带）：她醒来要处理的是"这件事没有结果"，
      // 而"没有结果"长什么样（跑到一半的日志）正是她要看的。
      const settledOutput = await readJobOutput(this.#dataDir, record);
      this.#emit(
        { type: 'wake/job', data: this.#wakeDataOf(record, settledOutput.ok ? settledOutput.text : null) },
        'model',
        true,
      );
      settled.push(jobId);
    }
    return settled;
  }

  // ── 读取侧 ──

  /** 本进程内的任务（含刚被结算的孤儿）；未见的返回 null */
  get(jobId: string): JobRecord | null {
    return this.#jobs.get(jobId) ?? null;
  }

  /** 本进程内的任务表，按启动时刻升序 */
  list(): JobRecord[] {
    return [...this.#jobs.values()].sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
  }

  // ── 内部 ──

  /**
   * 输出外置与索引取材。读取前端已经写了 `.log`（pwsh 的 finishBackground），
   * 但**不假设它一定写成功**（磁盘满、目录被占）——缺文件时照常给一个指向该路径的引用，
   * 观测侧"文件不存在"是可解释的事实，而吞掉引用会让一个真跑过的任务看起来没输出。
   */
  async #settleOutput(job: JobFinishedInput): Promise<{ output: JobOutput; text: string | null }> {
    const file = job.outputRef !== undefined && job.outputRef !== ''
      ? job.outputRef
      : jobLogPathOf(this.#dataDir, job.jobId);
    const output: JobOutput = { file };

    let text: string | null = null;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return { output, text: null };
    }
    // 大输出外置（design §4.12 / §4.21）：阈值按估算 token 判，与 blob-store 同口径
    if (estimateTokens(text) <= Math.max(0, this.#thresholdTokens)) return { output, text };

    try {
      const buf = Buffer.from(text, 'utf8');
      const blobId = createHash('sha256').update(buf).digest('hex');
      const target = blobPathOf(this.#dataDir, blobId);
      await mkdir(join(this.#dataDir, 'blobs'), { recursive: true });
      // 已存在就不重写：内容寻址的幂等性由文件名保证，省一次全量写盘
      if (!(await exists(target))) await writeFile(target, buf);
      output.blob = { blobId, bytes: buf.byteLength };
    } catch (err) {
      this.#warn(`后台任务 ${job.jobId} 的输出外置失败：${err instanceof Error ? err.message : String(err)}`);
    }
    // 正文**原样交回调用方**（唤醒那一截就从它切）：外置只管"全文放哪"，
    // 与"她这一轮看见什么"是两件事——后者不该因为文件大小而变。
    return { output, text };
  }

  /**
   * 唤醒事件里那几个字段：**结果正文的一截** + 全文在哪（`WakeJob` 的契约）。
   *
   * 一篇判据，写在这里（两个产生点——正常收尾与重启孤儿结算——共用它）：
   *   · `text === null`（输出读不到：文件没写成、盘满、被清理）⇒ **不编正文**，
   *     只给路径；她看到的是"没有输出"，那是可解释的事实，而不是一句假的空结果；
   *   · 截断在**码点**上切（`[...text]`），不切坏多字节字符；
   *   · **空正文与"没有输出"不是一回事**：空串照样带上（渲染层据此说"这次没有输出"）。
   */
  #wakeDataOf(record: JobRecord, text: string | null): WakeJob['data'] {
    const data: WakeJob['data'] = { jobId: record.jobId };
    if (record.command !== '') data.command = record.command;
    if (record.exitCode !== undefined) data.exitCode = record.exitCode;
    const file = record.output?.file;
    if (file !== undefined && file !== '') data.outputFile = file;
    if (text === null) return data;
    const bytes = Buffer.byteLength(text, 'utf8');
    data.outputBytes = bytes;
    if ([...text].length > JOB_WAKE_EXCERPT_CHARS) {
      data.outputExcerpt = [...text].slice(0, JOB_WAKE_EXCERPT_CHARS).join('');
      data.outputTruncated = true;
    } else {
      data.outputExcerpt = text;
    }
    return data;
  }

  /** 写诊断索引。失败只告警——索引是给人看的旁证，不是真相源（真相在事件日志） */
  async #persistIndex(record: JobRecord): Promise<void> {
    try {
      await mkdir(jobsDirOf(this.#dataDir), { recursive: true });
      const payload: Record<string, unknown> = {
        jobId: record.jobId,
        command: record.command,
        turn: record.turn,
        status: record.status,
        startedAt: record.startedAt,
      };
      if (record.finishedAt !== undefined) payload['finishedAt'] = record.finishedAt;
      if (record.exitCode !== undefined) payload['exitCode'] = record.exitCode;
      if (record.output?.blob !== undefined) payload['blob'] = record.output.blob;
      await writeFile(jobIndexPathOf(this.#dataDir, record.jobId), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch (err) {
      this.#warn(`后台任务 ${record.jobId} 的索引写入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 事件写盘 + **当场折进投影**。`sync` 由调用方定：started/finished/wake 都是"世界已经变了"
   * 的声明，走 fsync；这样进程在写完事件后立刻被杀，重启侧看到的状态仍与外部世界一致。
   *
   * 入参用判别联合而不是宽松的 `(type: string, data: unknown)`：事件负载就是 schema
   * （log/types.ts），多写一个字段就多一处与契约漂移的口子。这里不做类型逃逸。
   *
   * **为什么要折投影**（2026-10-08 修的真缺陷，用户这一句要治的正是它
   * 「后台任务回执、timer 提醒，这类得是真唤醒」）：运行期读 `pending` 的是**内存投影**
   * （`RealLoop.tickOnce` 读 `projection.pending`），而事件写盘与折投影是两步——
   * 只写盘不折，`wake/job` 就成了一条"日志里有、循环永远看不见"的唤醒：
   * **不起 turn**，她要等到下一次进程重启（recover 会把整份日志重新折一遍）才知道任务早就完了。
   * 实测形状：这条路上原来只有 `log.append`，而其它每个写唤醒的入口
   * （`RealLoop.appendSync` / `main` 的工具 `emit` / `web/server` / `channel/topic` …）
   * 都走 `applyOne`——只有这里漏了。纪律与 `RealLoop.appendSync` **同一条**
   * （先落库、再改内存，顺序不可反），连 `finalizePressure` 一起（预算压力按事件时刻结算）。
   */
  #emit(event: JobEventInput, visibility: 'internal' | 'model', sync: boolean): void {
    const seq = this.#log.nextSeq();
    const base = { seq, ts: this.#now().toISOString(), visibility, origin: 'runtime/job-manager' };
    const envelope: AppEvent = event.type === 'job/started'
      ? { ...base, type: 'job/started', data: event.data }
      : event.type === 'job/finished'
        ? { ...base, type: 'job/finished', data: event.data }
        : { ...base, type: 'wake/job', data: event.data };
    this.#log.append(envelope, { sync });
    if (this.#projection !== null) {
      applyOne(this.#projection, envelope);
      finalizePressure(this.#projection, envelope.ts);
    }
  }
}

// ──────────────────────────────── 小工具 ────────────────────────────────

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 只读估量：任务输出目录的规模（观测用）。
 * 用 `open` 逐个读头部而不是全量读盘——长任务输出可能上 GB，观测不该拖垮主进程。
 */
export async function jobOutputBytes(path: string): Promise<number | null> {
  try {
    const handle = await open(path, 'r');
    try {
      const info = await handle.stat();
      return info.size;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** 索引正文的兼容读取（CLI 的 --json 用；失败返回 null 而不是抛） */
export async function readJobIndex(dataDir: string, jobId: string): Promise<Record<string, unknown> | null> {
  if (!isJobId(jobId)) return null;
  try {
    const raw = await readFile(jobIndexPathOf(dataDir, jobId), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
