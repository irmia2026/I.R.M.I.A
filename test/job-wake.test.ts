/**
 * 后台任务完成必须是**真唤醒**（2026-10-08 用户的口径）
 * ——src/runtime/job-manager.ts 的 `wake/job` 与 src/model/render.ts 的那一行
 *
 * 用户原话：「**后台任务回执、timer 提醒，这类得是真唤醒**」。判据不是"落了事件"，而是
 * **真的起了一个 turn，且那一条内容出现在当轮请求体里**（与她今天学到的"心跳真的会发请求"
 * 同一条纪律）。这一份钉五件事：
 *   ① **事件落库 + 折投影**：`job/finished` → `wake/job`，而且**运行期**就进 `pending`
 *      （不是等下一次重启）——这正是修复前缺的那一步：只写盘不折投影 ⇒ 循环读内存投影 ⇒
 *      "日志里有、永远不起 turn"；
 *   ② **真的起 turn**：跑一拍 → `turn/start` 出现；
 *   ③ **正文进了请求体**：那一轮发给模型的请求里**逐字**有任务输出的正文（不再只是"任务完成"）；
 *   ④ **反向**：事件刚落库、还没跑拍时**不许**已经有 turn（"落了事件"不算"办完了"），
 *      而 pending 里必须有它（它是**待办的活**，不是一条躺着的通知）；
 *   ⑤ **不刷屏**：同一批完成多个任务 ⇒ **一次**唤醒（一个 turn），正文里把几件都列出来。
 *
 * 走**真链路**：真 JobManager + 真 EventLog + 真 fold + 真 RealLoop，替身只有模型通道。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent } from '../src/log/types.ts';
import { JOB_WAKE_EXCERPT_CHARS } from '../src/log/types.ts';
import { fold } from '../src/state/fold.ts';
import { JobManager, jobLogPathOf, jobsDirOf } from '../src/runtime/job-manager.ts';
import { RealLoop } from '../src/runtime/real-loop.ts';
import { buildCatalogRegistry } from '../src/tools/catalog.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';

const TZ = 'Asia/Shanghai';
const JOB_ID = 't_20261008_1';

const PERSONA: PersonaAssets = {
  identity: 'IDENTITY',
  constitution: 'CONSTITUTION',
  style: 'STYLE',
  state: 'STATE',
  relationship: null,
  personaHash: 'test-hash',
  isSeed: false,
} as unknown as PersonaAssets;

/** 模型替身：heavy 记下每一次请求（"她这一轮看到了什么"就看它），light 回一个空 JSON */
function fakeDs(requests: unknown[]): DsClient {
  return {
    modelFor: (): string => 'fake',
    generate: async (): Promise<unknown> => ({
      status: 'completed',
      outputItems: [{ type: 'message', id: 'm1', text: '{}' }],
      usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, reasoningTokens: 0 },
      incompleteReason: null,
      model: 'fake-light',
      responseId: 'resp_light',
    }),
    stream: async (request: unknown): Promise<unknown> => {
      requests.push(request);
      return {
        status: 'completed',
        text: '嗯。',
        reasoning: '',
        toolCalls: [],
        outputItems: [],
        usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, reasoningTokens: 0 },
        incompleteReason: null,
        model: 'fake-heavy',
        responseId: 'resp_heavy',
        durationMs: 3,
        interrupted: false,
        failure: null,
      };
    },
  } as unknown as DsClient;
}

/**
 * 一次请求里**输入那一段的全部文本**（外层不套 JSON：路径在 Windows 上是反斜杠，
 * `JSON.stringify` 会把它转义成 `\\`，于是"路径在不在请求里"这种断言会因为转义而假红）。
 */
function textOfRequest(request: unknown): string {
  const input = (request as { input?: unknown }).input;
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  const parts: string[] = [];
  for (const item of input) {
    const content = (item as { content?: unknown }).content;
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
  }
  return parts.join('\n');
}

interface JobRig {
  dir: string;
  jobs: JobManager;
  /** **不折投影**的那种装配（修复前的形状）：只写日志，用来给反向用例作证 */
  jobsWithoutProjection: JobManager;
  loop: RealLoop;
  log: EventLog;
  /** 起一个后台任务（写 job/started + 把输出落到它该在的地方） */
  start: (jobId: string, command: string, output: string) => void;
  /** 任务完成（写 job/finished + wake/job） */
  finish: (jobId: string, exitCode: number | null) => Promise<void>;
  /** 跑一拍（生产里定时器回调与这里调的是同一个方法） */
  tick: () => Promise<void>;
  events: () => Promise<AppEvent[]>;
  types: () => Promise<string[]>;
  /** `pending` 里那几条唤醒的类型（"它是待办的活"的判据） */
  pendingTypes: () => Promise<string[]>;
  /** 她这一轮发给模型的请求（重放出来的一段文本） */
  requestText: () => string;
}

async function makeRig(t: TestContext): Promise<JobRig> {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-job-wake-'));
  const log = await EventLog.open(join(dir, 'events'));
  const projection = fold([]);
  const now = (): Date => new Date('2026-10-08T15:00:00.000+08:00');
  const requests: unknown[] = [];
  mkdirSync(jobsDirOf(dir), { recursive: true });
  // **与生产同一份装配**（main.ts）：JobManager 拿到投影，事件落库之后当场折进去
  const jobs = new JobManager({ log, dataDir: dir, now, projection });
  const loop = new RealLoop({
    log,
    dataDir: dir,
    projection,
    now,
    timezone: TZ,
    ds: fakeDs(requests),
    registry: new ToolRegistry(),
    persona: PERSONA,
    config: defaultConfig(dir),
    out: () => {},
    pollMs: 3_600_000,
  });
  t.after(() => {
    loop.stop();
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const start = (jobId: string, command: string, output: string): void => {
    writeFileSync(jobLogPathOf(dir, jobId), output, 'utf8');
    jobs.onStarted({ jobId, command, turn: 1 });
  };
  const types = async (): Promise<string[]> => {
    log.flush();
    const out: string[] = [];
    for await (const event of log.readAll()) out.push(event.type);
    return out;
  };
  return {
    dir,
    jobs,
    jobsWithoutProjection: new JobManager({ log, dataDir: dir, now }),
    loop,
    log,
    start,
    finish: async (jobId, exitCode) => {
      await jobs.onFinished({ jobId, exitCode, outputRef: jobLogPathOf(dir, jobId) });
    },
    tick: async () => { await loop.tickOnce(); },
    events: async () => {
      log.flush();
      const out: AppEvent[] = [];
      for await (const event of log.readAll()) out.push(event);
      return out;
    },
    types,
    pendingTypes: async () => {
      const out: string[] = [];
      for (const item of projection.pending) {
        const event = log.get(item.wakeSeq);
        if (event !== null) out.push(event.type);
      }
      return out;
    },
    requestText: () => requests.map(textOfRequest).join('\n'),
  };
}

// ──────────────────────────────── ① 事件 + 折投影 + 真 turn + 正文进请求 ────────────────────────────────

test('后台任务完成：wake/job 进 pending、跑一拍真的起 turn，任务输出正文逐字出现在请求体里', async (t) => {
  const rig = await makeRig(t);
  const output = '构建成功：42 个文件全部通过\n耗时 12.3s';
  rig.start(JOB_ID, 'npm run build', output);
  await rig.finish(JOB_ID, 0);

  const events = await rig.events();
  const finished = events.find((event) => event.type === 'job/finished');
  const wake = events.find((event) => event.type === 'wake/job');
  assert.ok(finished !== undefined, 'job/finished 要先落（internal：投影据此清掉"有一个任务在跑"）');
  assert.ok(wake !== undefined, 'wake/job 是模型可见的那一条');
  assert.ok(finished.seq < wake.seq, '日志顺序即因果顺序');
  const data = (wake as AppEvent & { type: 'wake/job' }).data;
  assert.equal(data.command, 'npm run build', '事件里带上"跑的是什么"');
  assert.equal(data.exitCode, 0);
  assert.ok(data.outputExcerpt?.includes('42 个文件全部通过'),
    `正文要随事件走（她就是照这一份看见结果的）：${JSON.stringify(data)}`);
  assert.equal(data.outputFile, jobLogPathOf(rig.dir, JOB_ID), '全文在哪要写清（要全文就 safe_read 读它）');

  // ① 反向：**只落事件不算办完** —— 还没跑拍，不许已经有 turn；但它是 pending 里的活
  assert.equal((await rig.types()).includes('turn/start'), false,
    '"落了事件"本身不是唤醒：还没跑拍就不该已经有 turn（否则这条用例测不出"真唤醒"）');
  assert.deepEqual(await rig.pendingTypes(), ['wake/job'], '它是**待办的活**，不是一条躺着的通知');

  // ② 真唤醒：跑一拍 → 真 turn
  await rig.tick();
  const types = await rig.types();
  assert.equal(types.includes('turn/start'), true, '后台任务完成必须真的起一个 turn');
  assert.equal(types.includes('input/claimed'), true, '那条唤醒要被这一轮认领掉（不许留在队列里反复叫）');

  // ③ 正文真的进了**当轮请求体**（判据：真链路 + 假模型记请求）
  const text = rig.requestText();
  assert.ok(text.includes('构建成功：42 个文件全部通过'),
    `任务输出的正文必须逐字进她这一轮的请求：\n${text.slice(0, 900)}`);
  assert.ok(text.includes('npm run build'), '命令也要在（她才知道这结果是什么的结果）');
  assert.ok(text.includes('后台任务完成'), '唤醒那一行的标记照旧在');
  // 输出全文与正文同源（不是另拼一句"完成了"）
  assert.ok(text.includes('耗时 12.3s'), '整段输出都在（没被另写一遍摘要）');
});

// ──────────────────────────────── ② 合并：同一批多件只叫一次 ────────────────────────────────

test('同一批完成两个任务 ⇒ **一次**唤醒（一个 turn），正文里两件都列出来', async (t) => {
  const rig = await makeRig(t);
  rig.start('t_1', 'npm run build', '构建成功：42 个文件');
  rig.start('t_2', 'npm test', '1974 个用例全过');
  await rig.finish('t_1', 0);
  await rig.finish('t_2', 0);

  await rig.tick();
  const starts = (await rig.types()).filter((type) => type === 'turn/start');
  assert.equal(starts.length, 1, '同一批到齐 ⇒ 只起一个 turn（"真唤醒"不许变成"连着叫醒十次"）');
  const text = rig.requestText();
  assert.ok(text.includes('构建成功：42 个文件'), '第一件的正文要在');
  assert.ok(text.includes('1974 个用例全过'), '第二件的正文也要在（一次唤醒里列清有几件）');
  assert.ok(text.includes('t_1') && text.includes('t_2'), '两件的 jobId 都要能对上');
  assert.deepEqual(await rig.pendingTypes(), [], '这一批认领完 ⇒ 队列清空（不会下一拍再叫一遍）');
});

// ──────────────────────────────── ③ 大输出：截断要如实说，且给全文的路 ────────────────────────────────

test('大输出：只带开头一截、如实说全文多少字节与在哪；请求里不出现全文尾巴', async (t) => {
  const rig = await makeRig(t);
  const head = '开头的这一行';
  const tail = '尾巴的哨兵字符串';
  const output = `${head}\n${'填'.repeat(JOB_WAKE_EXCERPT_CHARS + 500)}\n${tail}`;
  rig.start(JOB_ID, 'npm run build', output);
  await rig.finish(JOB_ID, 0);

  const wake = (await rig.events()).find((event) => event.type === 'wake/job') as AppEvent & { type: 'wake/job' };
  assert.equal(wake.data.outputTruncated, true, '截了要如实标注（否则她拿这一截当全文）');
  assert.equal([...(wake.data.outputExcerpt ?? '')].length, JOB_WAKE_EXCERPT_CHARS,
    `唤醒里那一截就是上限那么多字（${JOB_WAKE_EXCERPT_CHARS}）`);
  assert.equal(wake.data.outputBytes, Buffer.byteLength(output, 'utf8'), '全文多少字节要如实带');
  assert.ok(wake.data.outputExcerpt?.startsWith(head), '取的是开头（与 blob 预览同一条口径）');
  assert.equal(wake.data.outputExcerpt?.includes(tail), false, '尾巴不在这一截里');

  await rig.tick();
  const text = rig.requestText();
  assert.ok(text.includes(head), '开头那一截要进请求');
  assert.equal(text.includes(tail), false, '全文的尾巴不进请求（每轮都要重发的东西必须有界）');
  assert.ok(text.includes('开头'), '渲染要说明这是开头一截');
  assert.ok(text.includes(jobLogPathOf(rig.dir, JOB_ID)), '要给全文的路径');
  assert.ok(text.includes('safe_read'), '要给一条**能用**的取全文的路');
});

// ──────────────────────────────── ④ 指路：不存在的东西不许写进去 ────────────────────────────────

test('唤醒里不许指向"job 查询工具"（注册表里没有它），指路必须是 safe_read + 路径', async (t) => {
  // 这一条是**关于事实的断言**：那句"（用 job 查询工具看结果）"让她去够一个够不着的东西。
  // 先证明注册表里确实没有这件工具（判据在工具清单本身，不在文案里）。
  const { registry } = await buildCatalogRegistry({
    dataDir: 'data',
    timers: new TimerStore(null),
    emit: () => {},
  });
  assert.deepEqual(registry.names().filter((name) => /job/iu.test(name)), [],
    '没有任何"job 查询工具"——所以唤醒那一行不能让她去找它');
  assert.equal(registry.has('safe_read'), true, '读全文要用的是她已有的 safe_read');

  const rig = await makeRig(t);
  rig.start(JOB_ID, 'npm run build', '构建成功');
  await rig.finish(JOB_ID, 0);
  await rig.tick();
  const text = rig.requestText();
  assert.equal(text.includes('job 查询工具'), false, `不许指向不存在的工具：\n${text.slice(0, 600)}`);
  assert.ok(text.includes('safe_read'), '要给出真正能用的那条路');
});

// ──────────────────────────────── ⑥ 反向：只落事件、不起 turn 的那条路 ────────────────────────────────

test('反向：只写日志、不折投影 ⇒ 起不了 turn（修复前的形状；这条锁住 main 那条接线）', async (t) => {
  // 这不是"另一种合法装配"，而是**修复前真实发生过的形状**：`JobManager` 只 `log.append`，
  // 而运行期读 `pending` 的是**内存投影**（`RealLoop.tickOnce`）——于是 `wake/job` 落了库，
  // 却永远不起 turn（要等下一次进程重启，recover 把整份日志重折一遍才发现任务早完了）。
  // 所以这一条断言的是"**不传投影就起不了 turn**"：它保证 `main.ts` 那一格必须传投影，
  // 也保证上面那条绿灯（真 turn + 正文进请求）测的是**接线**，不是"事件存在"。
  const rig = await makeRig(t);
  const output = '构建成功：42 个文件';
  rig.start(JOB_ID, 'npm run build', output);
  await rig.jobsWithoutProjection.onFinished({
    jobId: JOB_ID, exitCode: 0, outputRef: jobLogPathOf(rig.dir, JOB_ID),
  });

  // 事件照旧在盘上（写日志那一步没问题）——问题恰恰是"只有事件"
  assert.equal((await rig.types()).includes('wake/job'), true, '事件确实落了库');
  assert.deepEqual(await rig.pendingTypes(), [], '而内存投影里没有它（这就是那条断掉的接线）');
  await rig.tick();
  const types = await rig.types();
  assert.equal(types.includes('turn/start'), false, '只落事件 ⇒ 起不了 turn（不许有第二条"看起来像唤醒"的路）');
  assert.equal(rig.requestText().includes(output), false, '没起 turn ⇒ 正文当然也没进任何请求');
});


// ──────────────────────────────── ⑤ 没有输出 / 没跑完 ────────────────────────────────

test('读不到输出（文件不在）与"没跑完就被结算"：都如实说，不编正文、也不说成成功', async (t) => {
  const rig = await makeRig(t);
  // ① 输出文件不在（盘满、被清理）：事件里没有正文，但路径还在
  rig.jobs.onStarted({ jobId: 't_missing', command: 'npm run build', turn: 1 });
  await rig.jobs.onFinished({ jobId: 't_missing', exitCode: 0, outputRef: jobLogPathOf(rig.dir, 't_missing') });
  const missing = (await rig.events()).find((event) => event.type === 'wake/job') as AppEvent & { type: 'wake/job' };
  assert.equal(missing.data.outputExcerpt, undefined, '读不到就不编正文');
  assert.equal(missing.data.outputFile, jobLogPathOf(rig.dir, 't_missing'), '路径照给（"文件不存在"是可解释的事实）');

  // ② 孤儿结算（exitCode: null）：渲染要写成"未知"，不许读成成功
  rig.start('t_orphan', 'npm run build', '跑到一半的日志');
  const projection = fold([]);
  for (const event of await rig.events()) {
    const { applyOne } = await import('../src/state/fold.ts');
    applyOne(projection, event);
  }
  const settleRig = new JobManager({
    log: rig.log,
    dataDir: rig.dir,
    projection,
    now: () => new Date('2026-10-08T16:00:00.000+08:00'),
  });
  await settleRig.recoverOrphans(projection);
  const orphanWake = (await rig.events())
    .filter((event): event is AppEvent & { type: 'wake/job' } => event.type === 'wake/job')
    .find((event) => event.data.jobId === 't_orphan');
  assert.ok(orphanWake !== undefined, '孤儿也要留下一条唤醒（"那件事没有结果"必须让她知道）');
  assert.equal(orphanWake.data.exitCode, null);
  assert.ok(orphanWake.data.outputExcerpt?.includes('跑到一半的日志'),
    '跑到一半的日志就是她要看的"没有结果长什么样"');
});
