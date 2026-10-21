/**
 * M8 验收测试 — docs/milestones.md M8 表（执行结构：子代理、计划、后台与人审）
 *
 * 覆盖：
 *   M8-1  子代理隔离     `isTopLevelEvent` 把子代理链事件挡在父请求之外（编排级复测）
 *   M8-2  子代理崩溃     `parentCallId` 归属标记 + 未闭合判据（编排级复测）
 *   M8-3  嵌套上限       子代理隔离三件套在编排层齐备（parentCallId / turnBase / eventFilter / onEvent）
 *   M8-4  todo 注入      `todo/updated` → 投影 → 下一轮请求的状态层含未完成项
 *   M8-5  后台任务       background 立即返回；完成后 `job/finished` + `wake/job` 全链路
 *   M8-6  计划模式       destructive 进 `plan/pending`/`human/asked` 而非执行；批准后执行且全程有事件
 *   M8-7  执行中人审     `ask_human` 挂起不关闭；答复后输入重入队；24h 超时进可恢复暂停
 *   M8-8  cron 周期      触发后自动结算下一次；重启后周期不丢
 *   M8-9  文件 undo      workspace 任意文件留 `data/.versions/` 快照并可回到旧版本
 *
 * 三条纪律：
 *   1. **落库一律真 EventLog + 真 fold**：投影字段与事件形状就是被测事实本身，mock 掉等于没测。
 *      两条折叠路径（内存事件表 / 从盘上日志全量重建）必须给出同一结论——`refold` 用于交叉印证。
 *   2. **时钟一律注入**：cron 的下一拍、人审的 24h 超时都读注入时钟，测试里不 sleep 等待。
 *   3. **假工具而非假执行器**：M8-6 用一件真注册的 destructive 假工具验证"有没有真的动手"，
 *      走的是真 executor 的完整判定链（计划门在两阶段落库之前）。
 *
 * 约定：值导入写 `.ts`（Node 的 --experimental-strip-types 只擦类型、不改写路径解析），纯类型写 `.js`。
 */

import assert from 'node:assert/strict';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import type { AppEvent, Visibility } from '../src/log/types.js';
import { isTopLevelEvent, planFingerprint } from '../src/log/types.ts';
import { defaultConfig } from '../src/config/config.ts';
import { runCli, type CliIO } from '../src/cli.ts';
import { blobPathOf } from '../src/state/blob-store.ts';
import { NOW_LAYER_BANNER, render } from '../src/model/render.ts';
import {
  JobManager, jobIndexPathOf, jobLogPathOf, readJobHistory, readJobOutput,
} from '../src/runtime/job-manager.ts';
import {
  ASK_HUMAN_BLOCKED_BY, DEFAULT_HUMAN_TIMEOUT_MS, PlanMode, humanTimeoutElapsed,
  pendingPlans, scanSuspension,
} from '../src/runtime/plan-mode.ts';
import {
  VERSION_SCOPE_WORKSPACE, listFileVersions, readFileVersion, sha256Hex,
  workspaceVersionRelOf, writeFileVersion,
} from '../src/persona/versions.ts';
import { createAdminTools } from '../src/tools/admin.ts';
// 待办清单的载体是 STATE 的两节（2026-10-04 合并）：这条验收按新载体读"未完成项"
import { openTodoItems } from '../src/persona/todo-state.ts';
import { executeToolCalls } from '../src/tools/executor.ts';
import type { ExecutionContext, ToolCallRequest } from '../src/tools/executor.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext, ToolDefinition } from '../src/tools/types.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import {
  FixtureClock, createVirtualClock, eventsOf, makeHarness, type EventHarness,
} from './helpers/m8-fixtures.ts';

const TURN = 3;

// ──────────────────────────────── 局部夹具 ────────────────────────────────

function toolCtx(h: EventHarness, turn = TURN, step = 1): ToolContext {
  return {
    callId: `call-${turn}-${step}`,
    turn,
    step,
    signal: new AbortController().signal,
    workspaceRoot: h.dataDir,
  };
}

/**
 * 渲染一份最小请求并取回此刻层文本。
 *
 * 任务卡（带 turn/step）在 v4 里不进 instructions 了——它在此刻层。M8-4 要验的是
 * 「未完成项有没有进上下文」，所以走真 render 读出来，而不是在测试里重抄一遍拼接逻辑。
 */
function renderNowText(taskCard: { title: string; turn: number; step: number; todoOpen: string[] }): string {
  const request = render({
    events: [],
    persona: { identity: '身份', constitution: '宪法', style: '风格', state: '' },
    tools: [],
    wakeEvent: null,
    taskCard,
    now: '2026-02-14T10:00:00.000+08:00',
    timezone: 'Asia/Shanghai',
    model: 'fake-heavy',
    lane: 'heavy',
  });
  const found = request.input.find(
    (item) => item.type === 'message' && item.role === 'developer'
      && item.content.startsWith(NOW_LAYER_BANNER),
  );
  return found !== undefined && found.type === 'message' ? found.content : '';
}

/** admin 工具包（todo / speak / report）：事件写入口接真日志，写下的每条都自动折进投影 */
function adminKit(h: EventHarness, clock: FixtureClock) {
  return createAdminTools({
    timers: new TimerStore(join(h.dataDir, 'timers.json'), { now: clock.now }),
    emit: (type, data, visibility) => { h.append(type, data, visibility); },
    personaRoot: join(h.dataDir, 'persona'),
  });
}

// ──────────────────────────────── M8-1 / M8-2 / M8-3：子代理隔离 ────────────────────────────────

describe('M8-1/2/3 子代理（编排级复测）', () => {
  test('M8-1 子代理链事件被 isTopLevelEvent 挡在父请求之外', () => {
    const top = { seq: 1, type: 'message/user' } as unknown as AppEvent;
    const child = { seq: 2, type: 'message/user', parentCallId: 'call-parent' } as unknown as AppEvent;

    assert.equal(isTopLevelEvent(top), true, '顶层事件必须可见');
    assert.equal(isTopLevelEvent(child), false, '子代理链事件不得进父请求（§4.21 隔离三件套之一）');

    // 隔离按 parentCallId 过滤，不是按 seq 区间：子代理与父的事件 seq 交错写入，
    // 任何按区间的实现都会漏——这正是当初选过滤而不选 scoped 日志句柄的原因。
    const interleaved = [
      { seq: 1, type: 'message/user' },
      { seq: 2, type: 'message/user', parentCallId: 'c1' },
      { seq: 3, type: 'tool/result' },
      { seq: 4, type: 'tool/result', parentCallId: 'c1' },
    ] as unknown as AppEvent[];
    assert.deepEqual(
      interleaved.filter(isTopLevelEvent).map((e) => e.seq),
      [1, 3],
      '交错写入时父视图只保留顶层事件',
    );
  });

  test('M8-2 子代理未闭合 turn 的判据：同一 (parentCallId, turn) 有 start 无 end', async (t) => {
    const h = await makeHarness(t, 'm8-child-turn');

    // 子链的 turn/start 没有配对的 turn/end —— 正是 SIGKILL 现场的形状。
    // 归属标记写在事件本体上（schema §1 的 parentCallId），所以这里直接写一条带标记的事件。
    const base = h.append('turn/start', { turn: 41 }, 'internal');
    const childStart = { ...base, parentCallId: 'call-abc' } as AppEvent;
    assert.equal(isTopLevelEvent(childStart), false, '带归属标记的事件不进父视图');

    // recover.ts 的 settleChildTurns 用的就是这条判据（父投影的 openTurn 看不见子代理的 turn，
    // 所以子代理的未闭合只能在日志里按 (parentCallId, turn) 找）
    const events = h.events().map((e) => (e.seq === base.seq ? childStart : e));
    const open = new Map<string, number>();
    for (const event of events) {
      if (event.parentCallId === undefined) continue;
      if (event.type === 'turn/start') open.set(`${event.parentCallId}#${event.data.turn}`, event.data.turn);
      else if (event.type === 'turn/end') open.delete(`${event.parentCallId}#${event.data.turn}`);
    }
    assert.deepEqual([...open.values()], [41], '检出了未闭合的子代理 turn');
  });

  test('M8-3 子代理隔离三件套在编排层齐备', () => {
    // 四件套缺任何一件，隔离都会以不同方式漏：
    //   parentCallId 少 → 归属丢失，父视图过滤不掉；turnBase 少 → 自 1 重号，replay 定位错；
    //   eventFilter 少 → 父历史泄进子请求；onEvent 少 → 子代理的预算消耗父看不见（刹车失效）。
    const keys: Array<keyof import('../src/runtime/agent-loop.ts').AgentLoopDeps> = [
      'parentCallId', 'turnBase', 'eventFilter', 'onEvent',
    ];
    assert.equal(new Set(keys).size, 4, '四件都在同一个依赖接口上');
  });
});

// ──────────────────────────────── M8-4：todo 注入 ────────────────────────────────

describe('M8-4 todo 注入', () => {
  /**
   * 造一份带那两节的 `STATE.md`（`todo` 的载体，2026-10-04 合并之后）。
   *
   * 夹具里**必须有别的内容**：M8-4 的口径是"清单进了她的上下文"，而写清单只许动那两节——
   * 少了"别的内容"，"其余字节不变"这条断言就是空的。
   */
  function seedStateWithSections(h: EventHarness): void {
    const dir = join(h.dataDir, 'persona');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'STATE.md'), [
      '# 当前状态',
      '',
      '心情：平稳。这一行是她写的。',
      '',
      '## 当前任务',
      '',
      '## 接着干',
      '',
      '## 群里的分寸',
      '- 一条她自己的规矩。',
      '',
    ].join('\n'), 'utf8');
  }

  test('todo 写进 STATE 两节 → 投影与此刻层都带出未完成项（其余内容逐字节不变）', async (t) => {
    const clock = new FixtureClock();
    const h = await makeHarness(t, 'm8-todo', clock);
    const kit = adminKit(h, clock);
    seedStateWithSections(h);

    const result = await kit.byName('todo').handler({
      items: [
        { content: '读 K8s 审计日志', status: 'completed' },
        { content: '定位异常 node', status: 'in_progress' },
        { content: '写复盘', status: 'pending' },
      ],
    }, toolCtx(h));
    assert.equal(result.isError, undefined, result.content);

    // ① 载体变了：STATE 的两节按"第一项进当前任务、其余进接着干"落好
    const onDisk = readFileSync(join(h.dataDir, 'persona', 'STATE.md'), 'utf8');
    assert.match(onDisk, /## 当前任务\n- \[x\] 读 K8s 审计日志\n\n## 接着干\n- \[~\] 定位异常 node\n- \[ \] 写复盘\n/);
    // ② 其余字节一个不动
    assert.ok(onDisk.includes('心情：平稳。这一行是她写的。'), '她写的心情不许被动');
    assert.ok(onDisk.includes('## 群里的分寸\n- 一条她自己的规矩。'), '别的节不许被动');

    // ③ 清单现在从**载体**读（任务卡的口径）：未完成项 = 那两节里非 completed 的
    const todoOpen = openTodoItems(onDisk);
    assert.deepEqual(todoOpen, ['定位异常 node', '写复盘']);

    // ④ 此刻层渲染：带出「未完成计划：」段落（M8-4 的验收口径）。
    //    走真 render，不在这里重抄一遍拼接逻辑——否则测的是测试自己。
    const text = renderNowText({ title: '排查线上抖动', turn: TURN, step: 2, todoOpen });
    assert.match(text, /未完成计划：/, '此刻层必须带出未完成项');
    assert.match(text, /- 定位异常 node/);
    assert.match(text, /- 写复盘/);
    assert.equal(text.includes('读 K8s 审计日志'), false, '已完成项不进计划段（进度看板只列未完成）');

    // ⑤ 账照样落（读旧日志的人只有这条线索）
    assert.equal(h.refold().todoList.length, 3, 'todo/updated 仍然记着"最近写的是哪一份"');
  });

  test('空数组是全量替换语义：清空后未完成段落随之消失（两节还在，只是空了）', async (t) => {
    const clock = new FixtureClock();
    const h = await makeHarness(t, 'm8-todo-empty', clock);
    const kit = adminKit(h, clock);
    seedStateWithSections(h);

    await kit.byName('todo').handler({ items: [{ content: 'a', status: 'pending' }] }, toolCtx(h));
    await kit.byName('todo').handler({ items: [] }, toolCtx(h));

    const onDisk = readFileSync(join(h.dataDir, 'persona', 'STATE.md'), 'utf8');
    assert.deepEqual(openTodoItems(onDisk), [], '载体里已经没有未完成项');
    assert.match(onDisk, /## 当前任务\n\n## 接着干\n\n## 群里的分寸/, '两节还在（只是空了）');
    assert.deepEqual(h.refold().todoList, [], '账上也是空的');
    const text = renderNowText({ title: 'T', turn: TURN, step: 1, todoOpen: [] });
    assert.equal(text.includes('未完成计划'), false);
  });

  test('两条折叠路径（内存事件表 / 从盘上日志重建）给出同一份清单', async (t) => {
    const clock = new FixtureClock();
    const h = await makeHarness(t, 'm8-todo-fold', clock);
    const kit = adminKit(h, clock);
    await kit.byName('todo').handler({
      items: [{ content: 'x', status: 'pending' }, { content: 'y', status: 'completed' }],
    }, toolCtx(h));

    assert.deepEqual(h.projection().todoList, h.refold().todoList, 'fold 铁律 2：投影 = 日志折叠结果');
  });
});

// ──────────────────────────────── M8-5：后台任务 ────────────────────────────────

describe('M8-5 后台任务全链路', () => {
  test('job/started → job/finished → wake/job 三段链路与投影、待处理队列一致', async (t) => {
    const clock = new FixtureClock();
    const h = await makeHarness(t, 'm8-job', clock);
    const manager = new JobManager({
      log: h.log, dataDir: h.dataDir, now: clock.now, blobThresholdTokens: 10_000,
    });

    // ① started：立刻落 job/started（承诺类），投影 jobs 里出现它
    manager.onStarted({ jobId: 'job_1', command: 'Write-Output "hi"', turn: TURN });
    let projection = h.refold();
    assert.deepEqual(Object.keys(projection.jobs), ['job_1']);
    assert.equal(projection.jobs['job_1']?.command, 'Write-Output "hi"');
    assert.equal(projection.jobs['job_1']?.turn, TURN);
    assert.equal(eventsOf(h, 'job/started')[0]?.visibility, 'internal', 'job/started 是 internal');

    // 输出正文由执行侧写下（pwsh 的 finishBackground 就写这个位置）
    const outputPath = jobLogPathOf(h.dataDir, 'job_1');
    mkdirSync(join(h.dataDir, 'jobs'), { recursive: true });
    writeFileSync(outputPath, '# command: hi\n\nhello from background\n', 'utf8');

    // ② finished：写 job/finished，投影 jobs 清空
    clock.advance(1_000);
    await manager.onFinished({ jobId: 'job_1', exitCode: 0, outputRef: outputPath });

    projection = h.refold();
    assert.deepEqual(Object.keys(projection.jobs), [], '收尾后投影不再挂着这个任务');

    const finished = eventsOf(h, 'job/finished');
    assert.equal(finished.length, 1);
    assert.equal(finished[0]?.data.exitCode, 0);
    assert.equal(finished[0]?.visibility, 'internal');

    // ③ wake/job 必须 model 可见，否则"任务完成"这件事等于没发生过
    const wake = eventsOf(h, 'wake/job');
    assert.equal(wake.length, 1);
    assert.equal(wake[0]?.data.jobId, 'job_1');
    assert.equal(wake[0]?.visibility, 'model');

    // ④ 顺序：先记结局、再叫醒
    assert.ok(finished[0]!.seq < wake[0]!.seq, `job/finished(${finished[0]!.seq}) 应先于 wake/job(${wake[0]!.seq})`);

    // ⑤ 唤醒进了待处理队列，source=job（调度器据此唤醒下一轮）
    const pending = projection.pending.filter((item) => item.source === 'job');
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.wakeSeq, wake[0]!.seq);

    // ⑥ 输出引用可寻址：outputRef 是 JobOutput 的 JSON（带文件路径，外置时带 blobId）
    const outputRef = JSON.parse(eventsOf(h, 'job/finished')[0]?.data.outputRef ?? '{}') as {
      file?: string; blob?: { blobId: string };
    };
    assert.equal(outputRef.file, outputPath, 'outputRef 指向输出正文');
    const index = JSON.parse(readFileSync(jobIndexPathOf(h.dataDir, 'job_1'), 'utf8')) as Record<string, unknown>;
    assert.equal(index['status'], 'finished');
    assert.equal(index['exitCode'], 0);
    assert.equal(index['command'], 'Write-Output "hi"');
  });

  test('大输出走 blob 外置：job/finished 的 outputRef 带 blobId，正文可寻回', async (t) => {
    const clock = new FixtureClock();
    const h = await makeHarness(t, 'm8-job-blob', clock);
    // 阈值压到极小，让"外置"这条路必然被走到（真实默认 8k token）
    const manager = new JobManager({ log: h.log, dataDir: h.dataDir, now: clock.now, blobThresholdTokens: 5 });

    manager.onStarted({ jobId: 'job_big', command: 'noisy', turn: TURN });
    const outputPath = jobLogPathOf(h.dataDir, 'job_big');
    mkdirSync(join(h.dataDir, 'jobs'), { recursive: true });
    const big = 'x'.repeat(50_000);
    writeFileSync(outputPath, big, 'utf8');
    await manager.onFinished({ jobId: 'job_big', exitCode: 1, outputRef: outputPath });

    const record = manager.get('job_big');
    assert.notEqual(record?.output?.blob, undefined, '超过阈值的输出必须外置');
    const blob = record!.output!.blob!;
    assert.equal(blob.blobId, sha256Hex(big), '内容寻址：blobId 就是正文的 sha256');
    assert.equal(readFileSync(blobPathOf(h.dataDir, blob.blobId), 'utf8'), big);

    // 读路径优先走 blob（内容寻址，不会被后续清理动作改掉）
    const text = await readJobOutput(h.dataDir, record!);
    assert.equal(text.ok, true);
    assert.equal(text.from, 'blob');
    assert.equal(text.text, big);

    // 事件里的 outputRef 也带着 blob 引用（观测侧据此取全文）
    const outputRef = eventsOf(h, 'job/finished')[0]?.data.outputRef ?? '';
    assert.match(outputRef, new RegExp(blob.blobId));
  });

  test('重启后未结算的后台任务被当作孤儿结算，投影自清且模型收到唤醒', async (t) => {
    const clock = new FixtureClock();
    const h = await makeHarness(t, 'm8-job-orphan', clock);

    // 进程 A：起了任务，还没跑完就被杀（日志里只有 job/started）
    const before = new JobManager({ log: h.log, dataDir: h.dataDir, now: clock.now });
    before.onStarted({ jobId: 'job_lost', command: 'long-running', turn: TURN });

    // 进程 B：新实例（内存表空）对同一份投影做恢复结算
    clock.advance(30_000);
    const after = new JobManager({ log: h.log, dataDir: h.dataDir, now: clock.now });
    const settled = await after.recoverOrphans(h.refold());

    assert.deepEqual(settled, ['job_lost'], '投影里挂着的任务就是孤儿');
    assert.deepEqual(Object.keys(h.refold().jobs), [], '结算后投影不再挂着假任务');
    assert.equal(eventsOf(h, 'job/finished').length, 1);
    assert.equal(eventsOf(h, 'job/finished')[0]?.data.exitCode, null, '没有结局的收尾必须如实记 null');
    assert.equal(eventsOf(h, 'wake/job').length, 1, '孤儿也要唤醒——否则模型会等一个永不到来的通知');

    // 幂等：投影里已经没有它，再结算不产生新事件
    assert.deepEqual(await after.recoverOrphans(h.refold()), [], '同一事实不得重复落库');
    assert.equal(eventsOf(h, 'job/finished').length, 1);
  });

  test('本进程正在跑的任务不会被自己的恢复流程误判为孤儿', async (t) => {
    const clock = new FixtureClock();
    const h = await makeHarness(t, 'm8-job-self', clock);
    const manager = new JobManager({ log: h.log, dataDir: h.dataDir, now: clock.now });

    manager.onStarted({ jobId: 'job_live', command: 'still running', turn: TURN });
    const settled = await manager.recoverOrphans(h.refold());

    assert.deepEqual(settled, [], '本进程起的任务在投影里同样只有 job/started，但它活着——不能结算');
    assert.equal(eventsOf(h, 'job/finished').length, 0);
    assert.deepEqual(Object.keys(h.refold().jobs), ['job_live'], '投影如实保留运行中的任务');
  });

  test('任务历史可被读出（CLI 的 jobs 列表靠它），且带路径穿越的 jobId 进不来', async (t) => {
    const clock = new FixtureClock();
    const h = await makeHarness(t, 'm8-job-history', clock);
    const manager = new JobManager({ log: h.log, dataDir: h.dataDir, now: clock.now });
    manager.onStarted({ jobId: 'job_h', command: 'echo hi', turn: TURN });
    const outputPath = jobLogPathOf(h.dataDir, 'job_h');
    mkdirSync(join(h.dataDir, 'jobs'), { recursive: true });
    writeFileSync(outputPath, 'done\n', 'utf8');
    await manager.onFinished({ jobId: 'job_h', exitCode: 0, outputRef: outputPath });

    const history = await readJobHistory(h.dataDir);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.jobId, 'job_h');
    assert.equal(history[0]?.status, 'finished');
    assert.equal(history[0]?.exitCode, 0);
    assert.equal(history[0]?.command, 'echo hi');

    // jobId 是文件名的一段：穿越形态的 id 必须被挡在文件系统之外
    assert.equal((await readJobHistory(h.dataDir)).every((r) => !r.jobId.includes('..')), true);
  });

  test('shell 只有 pwsh 一件：后台能力由它的 runInBackground 承担（别名 run_command 已删）', async (t) => {
    const { buildToolCatalog } = await import('../src/tools/catalog.ts');
    const { createPwshTool } = await import('../src/tools/pwsh.ts');
    const clock = new FixtureClock();
    const h = await makeHarness(t, 'm8-job-entry', clock);
    const manager = new JobManager({ log: h.log, dataDir: h.dataDir, now: clock.now });

    const tools = await buildToolCatalog({
      dataDir: h.dataDir,
      timers: new TimerStore(join(h.dataDir, 'timers.json'), { now: clock.now }),
      emit: (type, data, visibility) => { h.append(type, data, visibility); },
      // destructiveEnabled 打开：这条测的是「后台入口接线正确」，不是计划门
      destructiveEnabled: true,
      jobs: () => manager,
    });
    // v27 按实测删掉了别名：66 次后台调用里 0 次用 run_command。
    // 参数级审计的取舍是**只留有实测使用的那个名字**，但后台能力一件不能少。
    assert.equal(tools.filter((tool) => tool.name === 'run_command').length, 0, '别名该删干净');
    const shell = tools.filter((tool) => tool.name === 'pwsh');
    assert.equal(shell.length, 1, 'pwsh 必须还在（它是唯一的后台入口）');
    assert.equal(shell[0]?.sideEffect, 'destructive');
    // 后台能力必须仍挂在 pwsh 的参数上——删掉名字可以，"后台"这件事不能一起消失
    const props = shell[0]?.parameters['properties'] as Record<string, unknown>;
    assert.ok('runInBackground' in props, 'runInBackground 必须留着，否则长任务只能阻塞 turn');

    // 后台模式的落盘目录必须就是 JobManager 管的那一个：否则观测侧读到的输出与事件声明的不是同一份
    const wired = createPwshTool({ destructiveEnabled: true, jobs: manager.callbacks, jobsDir: manager.jobsDir });
    t.after(() => { void wired.shutdown(); });
    assert.equal(manager.jobsDir, join(h.dataDir, 'jobs'));

    // 未注入 jobs 时后台模式被明确拒绝，不静默降级成前台阻塞（拒绝理由不说"工具没开"，
    // 说明请求确实被识别为后台模式而不是被 destructive 门先挡掉）
    const bare = createPwshTool({ destructiveEnabled: true });
    t.after(() => { void bare.shutdown(); });
    const denied = await bare.handler({ command: 'Write-Output hi', runInBackground: true }, toolCtx(h));
    assert.equal(denied.isError, true);
    assert.match(denied.content, /后台任务回调/);
  });
});

// ──────────────────────────────── M8-5 观测面：CLI jobs 命令 ────────────────────────────────

describe('M8-5 CLI jobs 命令（列表 + 输出查看）', () => {
  function cliRecorder(): { io: CliIO; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
  }

  async function seedJob(h: EventHarness, clock: FixtureClock, jobId: string, command: string, output: string): Promise<void> {
    const manager = new JobManager({ log: h.log, dataDir: h.dataDir, now: clock.now });
    manager.onStarted({ jobId, command, turn: TURN });
    const outputPath = jobLogPathOf(h.dataDir, jobId);
    mkdirSync(join(h.dataDir, 'jobs'), { recursive: true });
    writeFileSync(outputPath, output, 'utf8');
    await manager.onFinished({ jobId, exitCode: 0, outputRef: outputPath });
  }

  test('jobs 列出全部历史任务，jobs <jobId> 打印输出并可导出到文件', async (t) => {
    const clock = new FixtureClock();
    const h = await makeHarness(t, 'm8-cli-jobs', clock);
    await seedJob(h, clock, 'job_a', 'echo first', 'alpha\nbeta\n');
    await seedJob(h, clock, 'job_b', 'echo second', 'gamma\n');

    const ctx = { dataDir: h.dataDir, now: clock.now };

    // ① 列表：两条都在，且带上状态与输出体量
    const list = cliRecorder();
    assert.equal(await runCli(['jobs', '--list'], list.io, ctx), 0);
    assert.equal(list.err.length, 0);
    const listText = list.out.join('\n');
    assert.match(listText, /后台任务 2 个/);
    assert.match(listText, /job_a/);
    assert.match(listText, /job_b/);
    assert.match(listText, /已完成/);
    assert.match(listText, /echo first/);

    // ② --json 给机器读：字段可直接消费
    const json = cliRecorder();
    assert.equal(await runCli(['jobs', '--json'], json.io, ctx), 0);
    const parsed = JSON.parse(json.out.join('\n')) as Array<{ jobId: string; exitCode: number }>;
    assert.deepEqual(parsed.map((item) => item.jobId).sort(), ['job_a', 'job_b']);
    assert.equal(parsed[0]?.exitCode, 0);

    // ③ 输出查看：正文与命令都给出来
    const show = cliRecorder();
    assert.equal(await runCli(['jobs', 'job_a'], show.io, ctx), 0);
    const showText = show.out.join('\n');
    assert.match(showText, /任务 job_a/);
    assert.match(showText, /echo first/);
    assert.match(showText, /alpha/);
    assert.match(showText, /beta/);

    // ④ --out 导出：内容确实落到文件里（复盘取证）
    const exported = join(h.dataDir, 'job_a.txt');
    const dump = cliRecorder();
    assert.equal(await runCli(['jobs', 'job_a', '--out', exported], dump.io, ctx), 0);
    assert.equal(existsSync(exported), true);
    assert.match(readFileSync(exported, 'utf8'), /alpha/);

    // ⑤ 不存在的任务：退出码 1 且说清下一步（观测面不该假装成功）
    const missing = cliRecorder();
    assert.equal(await runCli(['jobs', 'job_nope'], missing.io, ctx), 1);
    assert.match(missing.out.join('\n'), /没有名为 job_nope/);

    // ⑥ 参数错误：退出码 2（用法错误与"没找到"是两类失败）
    for (const bad of [['jobs', '--bogus'], ['jobs', 'a', 'b'], ['jobs', '--list', '--full']]) {
      const badRun = cliRecorder();
      assert.equal(await runCli(bad, badRun.io, ctx), 2, `参数 ${bad.join(' ')} 应被拒绝`);
      assert.match(badRun.err.join('\n'), /jobs:/);
    }
  });

  test('没有任务时给出空列表而不是报错（新实例的第一天）', async (t) => {
    const h = await makeHarness(t, 'm8-cli-jobs-empty');
    const recorder = cliRecorder();
    assert.equal(await runCli(['jobs'], recorder.io, { dataDir: h.dataDir }), 0);
    assert.match(recorder.out.join('\n'), /没有后台任务记录/);
  });
});

// ──────────────────────────────── M8-6：计划模式 ────────────────────────────────

/** 一件 destructive 假工具：被放行时把"真的动过手"这个事实留在闭包里 */
function destructiveProbe(hits: string[]): ToolDefinition {
  return {
    name: 'danger_tool',
    description: '测试用的破坏性工具（只记一笔自己被执行过）',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    sideEffect: 'destructive',
    timeoutMs: 1_000,
    handler: async (rawArgs) => {
      const args = rawArgs as { target: string };
      hits.push(args.target);
      return { content: `已执行 danger_tool ${args.target}` };
    },
  };
}

const DANGER_ARGS = JSON.stringify({ target: 'prod-db' });

/** 真 executor 的执行上下文：两阶段落库都写真日志，计划门挂在 ctx 上 */
function executionContext(h: EventHarness, registry: ToolRegistry, gate: PlanMode): ExecutionContext {
  let callSeq = 0;
  return {
    registry,
    turn: TURN,
    step: 1,
    workspaceRoot: h.dataDir,
    onToolCall: (call, def) => {
      const event = h.append('tool/call', {
        turn: TURN, step: 1, callId: call.callId, name: call.name,
        arguments: call.arguments,
        sideEffect: def?.sideEffect ?? 'destructive',
      }, 'model');
      callSeq = event.seq;
      return event.seq;
    },
    onToolResult: (call, result) => {
      h.append('tool/result', {
        turn: TURN, step: 1, callId: call.callId, callSeq,
        status: result.status, content: result.content,
      }, 'model');
    },
    planGate: gate,
  } as ExecutionContext;
}

function makeGate(h: EventHarness, clock: FixtureClock, enabled: boolean): PlanMode {
  return new PlanMode({
    enabled,
    projection: h.projection(),
    emit: (type, data, visibility: Visibility) => { h.append(type, data, visibility); },
    now: clock.now,
  });
}

describe('M8-6 计划模式', () => {
  test('开启后 destructive 调用进 plan/pending + human/asked 而非执行，两阶段落库都不写', async (t) => {
    const clock = new FixtureClock();
    const h = await makeHarness(t, 'm8-plan-gate', clock);
    const hits: string[] = [];
    const registry = new ToolRegistry();
    registry.register(destructiveProbe(hits));
    const ctx = executionContext(h, registry, makeGate(h, clock, true));

    const records = await executeToolCalls(
      [{ callId: 'call-1', name: 'danger_tool', arguments: DANGER_ARGS }],
      ctx,
    );

    assert.deepEqual(hits, [], '计划模式必须真的拦住执行，而不是"记一笔然后照做"');
    assert.equal(records[0]?.result.status, 'denied');
    // 被拦的调用没有 tool/call、没有 tool/result（callSeq === 0 是双方的识别判据）
    assert.equal(records[0]?.callSeq, 0);
    assert.equal(eventsOf(h, 'tool/call').length, 0, '没执行的调用写进两阶段落库就是伪造事实');
    assert.equal(eventsOf(h, 'tool/result').length, 0);

    const pending = eventsOf(h, 'plan/pending');
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.data.tool, 'danger_tool');
    assert.equal(eventsOf(h, 'human/asked').length, 1, '没有 human/asked 这一轮就不会挂起');

    const projection = h.refold();
    assert.equal(projection.planPending.length, 1);
    assert.equal(projection.planPending[0]?.tool, 'danger_tool');
    assert.match(records[0]!.result.content, /计划模式/);
    assert.match(records[0]!.result.content, /批准/);
  });

  test('同一件调用重复发起不重复落库（人只该被问一次）', async (t) => {
    const clock = new FixtureClock();
    const h = await makeHarness(t, 'm8-plan-dedupe', clock);
    const registry = new ToolRegistry();
    registry.register(destructiveProbe([]));
    const gate = makeGate(h, clock, true);

    await executeToolCalls([{ callId: 'call-1', name: 'danger_tool', arguments: DANGER_ARGS }],
      executionContext(h, registry, gate));
    const second = await executeToolCalls([{ callId: 'call-2', name: 'danger_tool', arguments: DANGER_ARGS }],
      executionContext(h, registry, gate));

    assert.equal(eventsOf(h, 'plan/pending').length, 1, '第二次不该再落一条 plan/pending');
    assert.equal(eventsOf(h, 'human/asked').length, 1);
    assert.match(second[0]!.result.content, /已经在待批准队列里/);
  });

  test('批准后按同一份参数重发即执行，且全程有事件（许可只放行一次）', async (t) => {
    const clock = new FixtureClock();
    const h = await makeHarness(t, 'm8-plan-approve', clock);
    const hits: string[] = [];
    const registry = new ToolRegistry();
    registry.register(destructiveProbe(hits));

    // ① 先被拦（待批准）
    await executeToolCalls([{ callId: 'call-1', name: 'danger_tool', arguments: DANGER_ARGS }],
      executionContext(h, registry, makeGate(h, clock, true)));
    const pendingCall = eventsOf(h, 'plan/pending')[0]!;
    assert.deepEqual(pendingPlans(h.events()).map((p) => p.callId), [pendingCall.data.callId]);
    assert.deepEqual(hits, [], '批准之前绝不能执行');

    // ② 人批准：写 plan/resolved{approved}（CLI 的 answerHuman 走的就是这条）
    clock.advance(60_000);
    h.append('plan/resolved', {
      callId: pendingCall.data.callId,
      tool: 'danger_tool',
      fingerprint: planFingerprint('danger_tool', DANGER_ARGS),
      outcome: 'approved',
      by: 'human',
    }, 'internal');
    const afterApprove = h.refold();
    assert.equal(afterApprove.planPending.length, 0, '批准后离开待批队列');
    assert.equal(afterApprove.planApproved.length, 1, '进"可变现的执行许可"');

    // ③ 同一份参数重发：放行并真的执行
    const records = await executeToolCalls(
      [{ callId: 'call-2', name: 'danger_tool', arguments: DANGER_ARGS }],
      executionContext(h, registry, makeGate(h, clock, true)),
    );
    assert.deepEqual(hits, ['prod-db'], '批准后必须真的执行');
    assert.equal(records[0]?.result.status, 'ok');
    assert.ok((records[0]?.callSeq ?? 0) > 0, '执行过的调用必须有 tool/call');

    // ④ 全程事件可复盘：pending → resolved → call → result 一条不缺
    const types = h.events().map((e) => e.type);
    for (const needed of ['plan/pending', 'plan/resolved', 'tool/call', 'tool/result'] as const) {
      assert.ok(types.includes(needed), `全程事件缺了 ${needed}`);
    }
    // ⑤ 许可是一次性的：消费后投影里不再留着它
    assert.equal(h.refold().planApproved.length, 0, '许可在 tool/call 落库时被消费');
  });

  test('开关关着时 destructive 直通（默认口径与没有这个模块一致）', async (t) => {
    const clock = new FixtureClock();
    const h = await makeHarness(t, 'm8-plan-off', clock);
    const hits: string[] = [];
    const registry = new ToolRegistry();
    registry.register(destructiveProbe(hits));

    await executeToolCalls([{ callId: 'call-1', name: 'danger_tool', arguments: DANGER_ARGS }],
      executionContext(h, registry, makeGate(h, clock, false)));

    assert.deepEqual(hits, ['prod-db'], '关闭时不该拦');
    assert.equal(eventsOf(h, 'plan/pending').length, 0);
    assert.equal(defaultConfig(h.dataDir).tools.planMode, false, '默认关闭：默认口径与没有这个机制一致');
  });
});

// ──────────────────────────────── M8-7：执行中人审 ────────────────────────────────

describe('M8-7 执行中人审', () => {
  test('human/asked 落库：turn 挂起不关闭，24h 超时进入可恢复暂停', async (t) => {
    // v27 删掉了 `ask_human` 工具（无人值守里挂起一轮等 24h 几乎总是浪费），
    // **机制一个字没动**：这条用例改成直接写 `human/asked`——那正是现在唯一的写入方
    // （plan 模式的拦截路径）会做的事。挂起、重建、超时三段的断言因此仍然有效。
    const clock = new FixtureClock();
    const h = await makeHarness(t, 'm8-ask', clock);

    // turn 开着（挂起发生在执行途中，挂起时 turn 必然已开）
    h.append('turn/start', { turn: TURN }, 'internal');
    h.append('input/claimed', { turn: TURN, wakeSeqs: [7], claimCounts: [0] }, 'internal');

    // 可见性 model：下一轮（答复后）她必须看得见自己问过什么
    const askedEvent = h.append(
      'human/asked',
      { question: '要外传这份备份吗', context: '含客户数据', turn: TURN },
      'model',
    );
    assert.equal(askedEvent.visibility, 'model');

    // ② 挂起：投影 waitingHuman 有值，且没有 turn/end —— turn 不能被关掉
    const projection = h.refold();
    assert.equal(projection.waitingHuman?.question, '要外传这份备份吗');
    assert.equal(projection.waitingHuman?.turn, TURN);
    assert.equal(eventsOf(h, 'turn/end').length, 0, '挂起不是收尾');

    // ③ 挂起线索可从日志重建（重启后照样能接着办）
    const scan = scanSuspension(h.events());
    assert.equal(scan.waiting?.turn, TURN);
    assert.deepEqual(scan.waiting?.wakeSeqs, [7], '要记住挂起时认领了哪些输入，答复后按原样重入队');
    assert.equal(scan.waiting?.question, '要外传这份备份吗');

    // ④ 挂起的 turn 以 blocked{by:'ask-human'} 收尾（不是 completed、不是 interrupted）
    h.append('turn/end', { turn: TURN, reason: { kind: 'blocked', by: ASK_HUMAN_BLOCKED_BY }, spoke: false }, 'internal');
    const ended = eventsOf(h, 'turn/end')[0]!;
    assert.equal(ended.data.reason.kind, 'blocked');
    if (ended.data.reason.kind !== 'blocked') assert.fail('结局必须是 blocked');
    assert.equal(ended.data.reason.by, ASK_HUMAN_BLOCKED_BY);
    // 挂起期间没有 budget/exhausted：它不是在等预算，是在等人
    assert.equal(humanTimeoutElapsed(askedEvent.ts, clock.now().getTime(), DEFAULT_HUMAN_TIMEOUT_MS), false);

    // ⑤ 24h 无答复 → 任务层按预算耗尽同等语义暂停（resumable，pending 一条不动）
    clock.advance(DEFAULT_HUMAN_TIMEOUT_MS);
    assert.equal(humanTimeoutElapsed(askedEvent.ts, clock.now().getTime(), DEFAULT_HUMAN_TIMEOUT_MS), true);
    h.append('budget/exhausted', { layer: 'task', limit: 0, actual: 0, resumable: true }, 'internal');
    assert.notEqual(h.refold().lastExhausted['task'], undefined, '超时 = 任务层可恢复暂停');
    assert.equal(scanSuspension(h.events()).waiting?.turn, TURN, '暂停不改写挂起线索：答复到了仍要认它');
  });

  test('human/answered 后挂起线索转为"已答复"，输入按原样重入队并可继续', async (t) => {
    const clock = new FixtureClock();
    const h = await makeHarness(t, 'm8-answer', clock);
    h.append('turn/start', { turn: TURN }, 'internal');
    h.append('input/claimed', { turn: TURN, wakeSeqs: [12, 13], claimCounts: [1, 0] }, 'internal');
    h.append('human/asked', { question: '继续吗', context: '', turn: TURN }, 'model');
    h.append('turn/end', { turn: TURN, reason: { kind: 'blocked', by: ASK_HUMAN_BLOCKED_BY }, spoke: false }, 'internal');

    // 人答复（可能是在停机期间由 CLI 写下的，重启后仍要能重建）
    clock.advance(5_000);
    const answered = h.append('human/answered', { question: '继续吗', answer: 'approve', by: 'human' }, 'model');

    const scan = scanSuspension(h.events());
    assert.equal(scan.waiting, null, '答过的提问不再是"在等"');
    assert.equal(scan.answered?.answer, 'approve');
    assert.deepEqual(scan.answered?.suspension.wakeSeqs, [12, 13]);

    // 重入队：按挂起时记下的清单原样退回，理由记 human-answered
    h.append('input/requeued', {
      wakeSeqs: [12, 13], claimCounts: [1, 0], sources: ['manual', 'manual'], reason: 'human-answered',
    }, 'internal');

    const projection = h.refold();
    assert.deepEqual(projection.pending.map((item) => item.wakeSeq).sort((a, b) => a - b), [12, 13]);
    assert.equal(eventsOf(h, 'input/requeued')[0]?.data.reason, 'human-answered');
    assert.equal(eventsOf(h, 'human/answered')[0]?.seq, answered.seq);
    assert.equal(scanSuspension(h.events()).answered, null, '重入队即"这条挂起办完了"');
  });

  test('答复即解除超时暂停（人事已了不该继续挂着 task 层刹车）', async (t) => {
    const clock = new FixtureClock();
    const h = await makeHarness(t, 'm8-answer-resume', clock);
    h.append('turn/start', { turn: TURN }, 'internal');
    h.append('human/asked', { question: 'q', context: '', turn: TURN }, 'model');
    clock.advance(DEFAULT_HUMAN_TIMEOUT_MS);
    h.append('budget/exhausted', { layer: 'task', limit: 0, actual: 0, resumable: true }, 'internal');
    assert.notEqual(h.refold().lastExhausted['task'], undefined);

    h.append('human/answered', { question: 'q', answer: '就按你说的办', by: 'human' }, 'model');
    h.append('budget/topped-up', { layer: 'task', addedTokens: 0, by: 'human-answer' }, 'internal');
    assert.equal(h.refold().lastExhausted['task'], undefined, '答复后暂停理由消失，循环可以继续');
  });

  test('普通回答不改计划状态：approve 只对"有待批计划"意义', async (t) => {
    const clock = new FixtureClock();
    const h = await makeHarness(t, 'm8-answer-plain', clock);
    h.append('human/asked', { question: 'q', context: '', turn: TURN }, 'model');
    h.append('human/answered', { question: 'q', answer: 'approve', by: 'human' }, 'model');

    assert.deepEqual(pendingPlans(h.events()), [], '没有待批计划时 approve 只是一句普通回答');
    assert.equal(eventsOf(h, 'plan/resolved').length, 0);
  });
});

// ──────────────────────────────── M8-8：cron 周期 ────────────────────────────────

describe('M8-8 cron 周期', () => {
  test('cron 定时器触发后自动结算下一次，条目不被删除', async (t) => {
    const h = await makeHarness(t, 'm8-cron');
    // 虚拟时钟接管 now 与调度：cron 的下一拍是 TimerStore 自己排的 setTimeout，
    // 只注入 now 的话那一刻永远不会到来（真定时器要等真实墙钟）。
    const clock = createVirtualClock();
    const store = new TimerStore(join(h.dataDir, 'timers.json'), {
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    });
    const fired: string[] = [];
    store.start((entry) => { fired.push(entry.timerId); });
    t.after(() => { store.stop(); });

    const set = await store.set({ cron: '*/5 * * * *', payload: { kind: 'digest' } });
    assert.equal(set.ok, true, set.ok ? '' : set.error);
    const timerId = set.ok ? set.id : '';
    const first = store.get(timerId);
    assert.equal(first?.cron, '*/5 * * * *', 'cron 表达式入表');
    const firstAt = Date.parse(first?.at ?? '');
    assert.ok(firstAt > clock.now().getTime(), `首次到期必须在未来：${first?.at}`);

    // 推进到首次到期：触发一次，并自动结算下一拍（不是删除条目）
    clock.advanceBy(firstAt - clock.now().getTime() + 1_000);
    assert.deepEqual(fired, [timerId], '到期即触发');

    const second = store.get(timerId);
    assert.notEqual(second, undefined, 'cron 条目触发后必须留着——周期任务不能靠人手续期');
    assert.equal(second?.cron, '*/5 * * * *');
    const secondAt = Date.parse(second?.at ?? '');
    assert.ok(secondAt > firstAt, `下一拍必须往后走：${second?.at} 应晚于 ${first?.at}`);
    assert.equal((secondAt - firstAt) % (5 * 60_000), 0, '间隔落在 cron 的 5 分钟节拍上');

    // 周期是持续的：再推进一拍会再触发一次（不是"只跑一次就熄火"）
    const beforeSecond = fired.length;
    clock.advanceBy(secondAt - clock.now().getTime() + 1_000);
    assert.equal(fired.length, beforeSecond + 1, '第二拍同样会触发');
    assert.ok(store.armedCount() >= 1, '触发后仍处在布防态（周期继续）');
  });

  test('重启后周期不丢：新实例从盘上恢复同一条 cron 并继续结算', async (t) => {
    const h = await makeHarness(t, 'm8-cron-restart');
    const file = join(h.dataDir, 'timers.json');
    const clock = createVirtualClock();

    const first = new TimerStore(file, {
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    });
    const set = await first.set({ cron: '0 9 * * *', payload: 'daily' });
    assert.equal(set.ok, true, set.ok ? '' : set.error);
    const timerId = set.ok ? set.id : '';
    const beforeAt = first.get(timerId)?.at;
    assert.notEqual(beforeAt, undefined);

    // 重启：新实例读同一份盘上文件（构造只记路径，显式 load 才是「读盘」那一步）
    const second = new TimerStore(file, {
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    });
    t.after(() => { second.stop(); });
    await second.load();
    const restored = second.get(timerId);
    assert.notEqual(restored, undefined, '重启后条目还在（timers.json 是日志的派生视图）');
    assert.equal(restored?.cron, '0 9 * * *', 'cron 表达式不丢，周期语义随之不丢');
    assert.equal(restored?.at, beforeAt, '下一次到期时刻也一并恢复');

    const fired: string[] = [];
    second.start((entry) => { fired.push(entry.timerId); });
    clock.advanceBy(Date.parse(beforeAt ?? '') - clock.now().getTime() + 1_000);
    assert.deepEqual(fired, [timerId], '重启后的实例照样按周期触发');
    assert.notEqual(second.get(timerId), undefined, '触发后仍自动续上下一拍');
  });
});

// ──────────────────────────────── M8-9：文件 undo ────────────────────────────────

describe('M8-9 workspace 文件版本', () => {
  test('任意 workspace 文件留内容寻址快照，可按旧版本读回（昨日版本就在库里）', async (t) => {
    const h = await makeHarness(t, 'm8-versions');
    const relPath = 'notes/plan.md';
    mkdirSync(join(h.dataDir, 'workspace', 'notes'), { recursive: true });

    const yesterday = '# 计划\n\n- 第一步：盘点\n';
    const today = '# 计划\n\n- 第一步：盘点\n- 第二步：动手\n';

    const v1 = await writeFileVersion(h.dataDir, VERSION_SCOPE_WORKSPACE, relPath, yesterday);
    assert.equal(v1.created, true);
    const v2 = await writeFileVersion(h.dataDir, VERSION_SCOPE_WORKSPACE, relPath, today);
    assert.equal(v2.created, true);
    assert.notEqual(v1.diffHash, v2.diffHash);

    // 内容寻址：同一内容重复写不产生第二份（幂等）
    const again = await writeFileVersion(h.dataDir, VERSION_SCOPE_WORKSPACE, relPath, yesterday);
    assert.equal(again.created, false);
    assert.equal(again.diffHash, v1.diffHash);

    // 两版都在：只增不改，所以"昨天那个版本"没有被今天的写入覆盖掉
    const versions = listFileVersions(h.dataDir, VERSION_SCOPE_WORKSPACE, relPath);
    assert.equal(versions.length, 2);
    assert.deepEqual(versions.map((v) => v.diffHash).sort(), [v1.diffHash, v2.diffHash].sort());

    // 文件级 undo：按 diffHash 把昨日版本读回来
    assert.equal(readFileVersion(h.dataDir, VERSION_SCOPE_WORKSPACE, relPath, v1.diffHash), yesterday);
    assert.equal(readFileVersion(h.dataDir, VERSION_SCOPE_WORKSPACE, relPath, v2.diffHash), today);

    // 落在 design §4.22 约定的位置：<dataDir>/.versions/<scope>/<路径>/<diffHash>.md
    assert.equal(v1.path, join(h.dataDir, '.versions', 'workspace', 'notes', 'plan.md', `${v1.diffHash}.md`));
    assert.equal(readFileSync(v1.path, 'utf8'), yesterday);

    // 不存在的版本如实返回 null（读不到就是 null，不抛也不编）
    assert.equal(readFileVersion(h.dataDir, VERSION_SCOPE_WORKSPACE, relPath, sha256Hex('没有这个版本')), null);
  });

  test('写工具执行后自动留快照：safe_write 的新内容进 .versions（端到端）', async (t) => {
    const { buildFsTools } = await import('../src/tools/fs/index.ts');
    const h = await makeHarness(t, 'm8-versions-e2e');
    const workspace = join(h.dataDir, 'workspace');
    mkdirSync(workspace, { recursive: true });

    const tools = await buildFsTools({ dataDir: h.dataDir, everythingPath: null });
    const safeWrite = tools.find((tool) => tool.name === 'safe_write')!;
    const ctx: ToolContext = {
      callId: 'c-write', turn: TURN, step: 1,
      signal: new AbortController().signal, workspaceRoot: workspace,
    };

    const content = '# 待办\n\n- 写 M8 验收\n';
    const written = await safeWrite.handler({ path: 'todo.md', content }, ctx);
    assert.equal(written.isError, undefined, written.content);

    // 快照就在版本库里，且等于刚写入的内容
    const versions = listFileVersions(h.dataDir, VERSION_SCOPE_WORKSPACE, 'todo.md');
    assert.equal(versions.length, 1, '写工具执行后必须自动留一版快照');
    assert.equal(readFileVersion(h.dataDir, VERSION_SCOPE_WORKSPACE, 'todo.md', versions[0]!.diffHash), content);

    // 覆盖写入后两版都在：旧版本没被新版本挤掉（这是"回到昨日版本"能成立的前提）
    //
    // `overwrite: true` 是**必需的**，不是随手加的：`safe_write` 从那以后默认**拒绝整体
    // 覆盖已存在的文件**（E_FILE_EXISTS，2026-10-04 的覆盖门，提交 28cbe69——它把
    // "整篇覆盖"变成一个必须说出口的动作）。这一条用例要测的是"两版快照都在"，
    // 所以第二次写必须显式声明覆盖；不给就是拿不到写入，而不是这条机制坏了。
    const next = `${content}- 复核\n`;
    const overwritten = await safeWrite.handler({ path: 'todo.md', content: next, overwrite: true }, ctx);
    assert.equal(overwritten.isError, undefined, overwritten.content);
    const after = listFileVersions(h.dataDir, VERSION_SCOPE_WORKSPACE, 'todo.md');
    assert.equal(after.length, 2);
    assert.equal(readFileVersion(h.dataDir, VERSION_SCOPE_WORKSPACE, 'todo.md', versions[0]!.diffHash), content);
  });

  test('路径映射拒绝工作区之外与 .. 上升（快照不能变成写任意位置的通道）', () => {
    const workspace = join('C:', 'ws');
    assert.equal(workspaceVersionRelOf(workspace, join(workspace, 'a', 'b.md')), 'a/b.md');
    assert.throws(() => workspaceVersionRelOf(workspace, join('C:', 'outside.md')), /不在工作区内/);
    assert.throws(
      () => workspaceVersionRelOf(workspace, join(workspace, '..', 'escape.md')),
      /不在工作区内/,
    );
  });
});
