/**
 * 压缩的两件配套 — **判定留痕**（`compaction/decision`）与 **压缩后的真唤醒**（`wake/manual` · via='compact'）
 *
 * 用户的口径（2026-10-09 原话，两件一起拍的）：
 *   ① 「**可以**（加压缩判定留痕）」——`maybeCompact` 原来有四条静默 return，"这一拍为什么不压"
 *      在日志里一个字都没有。现在一 turn 写一行 `compaction/decision`（internal，不进请求）。
 *   ② 「另外**压缩后，应该也进行一次唤醒**。告知 LLM 刚刚进行了压缩。**如有中断的工作则继续**」
 *      ——压缩完成（`compaction/summary` 落库）之后发一次**真唤醒**，正文告知她刚压过、
 *      且要求"没做完的接着做"。
 *
 * 判据（这一份钉八件事）：
 *   ① **每 turn 一行**：`turn/start` 的条数 == `compaction/decision` 的条数，且每一行的
 *      `turn` 都能与某条 `turn/start` 对上（"一 turn 一行"是这份留痕的全部价值所在）；
 *   ② **一行长什么样**：`{turn, historyTokens, thresholdTokens, reason}` 逐字段，
 *      `wrote` 那一条的 `coveredUpToSeq` 与紧随其后的 `compaction/summary` 是**同一个数**；
 *   ③ **internal ⇒ 不进请求**（契约变更的边界，见 `src/log/types.ts` 的可见性映射）：
 *      可见性 + 渲染层两处都验，别只信表；
 *   ④ **真唤醒的三条判据（缺一不可）**：`turn/start` 出现 · 正文**逐字**进当轮请求体 ·
 *      顺序是"先 summary 后 wake"；
 *   ⑤ **反向**：没有压缩的那一拍（reason=`threshold`）⇒ **一个字都不发**（零新唤醒、零新 turn）；
 *   ⑥ **防抖**：唤醒那一拍自己也会做压缩检查 ⇒ 同一 turn 不重复发（且链在闸门处终止）；
 *   ⑦ **闸门那一支**：刚压完再压（新闭合量是一个 recent tail 之下）⇒ `reason='gate'`；
 *   ⑧ `covered`/`previousCovered` 与手动 `/compact` 那条路同源（同函数、同遮蔽点口径）。
 *
 * 走**真链路**：真 EventLog + 真 fold + 真 RealLoop + 真 runTurn，替身只有模型通道。
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent, CompactionDecision, CompactionSummary, Projection } from '../src/log/types.ts';
import { defaultVisibility, emptyProjection } from '../src/log/types.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import { estimateHistoryTokens } from '../src/persona/handoff-note.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';
import { render } from '../src/model/render.ts';
import { RealLoop } from '../src/runtime/real-loop.ts';
import { RECENT_TAIL_TOKENS, compactionCoveredUpToSeq, compactionDecision } from '../src/runtime/agent-loop.ts';
import { applyOne } from '../src/state/fold.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const TZ = 'Asia/Shanghai';
const T0 = new Date('2026-10-09T15:00:00.000+08:00');

/** 小阈值：让"垫料"可以小一点（真阈值 100,000 要垫几十万字符，测试跑起来没意义） */
const THRESHOLD = 10_000;
/** 垫料：明显越线（真口径的 2~3 倍） */
const SEED_TEXT = '往'.repeat(30_000);

const PERSONA: PersonaAssets = {
  identity: 'IDENTITY',
  constitution: 'CONSTITUTION',
  style: 'STYLE',
  state: 'STATE',
  relationship: null,
  personaHash: 'test-hash',
  isSeed: false,
} as unknown as PersonaAssets;

/** 模型替身：heavy 把每一次请求**逐字记下来**（"她这一轮看到了什么"就看它），light 回空 JSON */
function fakeDs(requests: unknown[]): DsClient {
  return {
    modelFor: (): string => 'fake',
    generate: async (): Promise<unknown> => ({
      status: 'completed',
      outputItems: [{ type: 'message', id: 'm1', text: '{"picks":[]}' }],
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
 * 一次请求里**输入那一段的全部文本**（外层不套 JSON：Windows 路径里有反斜杠，
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

interface Rig {
  dir: string;
  dataDir: string;
  projection: Projection;
  /** 她这一轮发给模型的请求（"看到了什么"的唯一判据） */
  requestText: () => string;
  /** 只取**最后那一次**请求的文本（测"这一轮里没有 X"必须用它，否则会被前几轮的请求污染） */
  lastRequestText: () => string;
  tick: () => Promise<void>;
  events: () => Promise<AppEvent[]>;
  ofType: <T extends string>(type: T) => Promise<AppEvent[]>;
  appendWake: (note: string) => Promise<AppEvent>;
  /** 造一条唤醒，它的正文**量出来**约等于 `tokens`（判据用实数，不靠我猜字符数） */
  fillerForTokens: (tokens: number) => Promise<string>;
}

/** 建一个真日志 + 真投影 + 真 RealLoop 的台子（`rebuild` 可以在塞完垫料之后重建） */
async function makeRig(t: TestContext, opts: { thresholdTokens?: number } = {}): Promise<Rig> {
  const dir = tempDirSync('irmia-compaction-wake-');
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const log = await EventLog.open(join(dataDir, 'events'));
  const projection = emptyProjection();
  const requests: unknown[] = [];
  const config = defaultConfig(dir);
  // 阈值由夹具给（真默认是 100,000；这里要的是"能压一次"，不是"压得起不划算"）
  config.persona = { ...config.persona, compactionThresholdTokens: opts.thresholdTokens ?? THRESHOLD };
  const loop = new RealLoop({
    log,
    dataDir,
    projection,
    now: () => T0,
    timezone: TZ,
    ds: fakeDs(requests),
    registry: new ToolRegistry(),
    persona: PERSONA,
    config,
    out: () => {},
    pollMs: 3_600_000,
    timers: new TimerStore(join(dataDir, 'timers.json'), { now: () => T0 }),
  });
  t.after(async () => {
    loop.stop();
    log.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发的句柄占用：清理失败不影响断言结论 */
    }
  });

  const events = async (): Promise<AppEvent[]> => {
    log.flush();
    const out: AppEvent[] = [];
    for await (const event of log.readAll()) out.push(event);
    return out;
  };

  return {
    dir,
    dataDir,
    projection,
    requestText: () => requests.map(textOfRequest).join('\n'),
    lastRequestText: () => (requests.length === 0 ? '' : textOfRequest(requests[requests.length - 1])),
    tick: async () => { await loop.tickOnce(); },
    events,
    ofType: async <T extends string>(type: T): Promise<AppEvent[]> =>
      (await events()).filter((event) => event.type === type),
    appendWake: async (note: string): Promise<AppEvent> => {
      const event = {
        seq: log.nextSeq(),
        ts: T0.toISOString(),
        type: 'wake/manual',
        data: { note },
        visibility: 'model',
        origin: 'test',
      } as unknown as AppEvent;
      log.append(event, { sync: true });
      applyOne(projection, event);
      return event;
    },
    /**
     * 「造一条量出来约为 `tokens` 的唤醒正文」。
     *
     * 为什么要量、不直接写死字符数：判据里的两个刻度（阈值 10,000 / 闸门 20,000 token）都是
     * **token**，而正文的 token 数取决于内容与当时的估算口径（中文约 1.5 字/token）。
     * 写死字符数的用例会在阈值或估算口径微调之后变成"测的不是我以为的那一支"——
     * 这里先量一次当前可见历史，再按**同一把尺**（`estimateHistoryTokens`）把差值补上。
     */
    fillerForTokens: async (tokens: number): Promise<string> => {
      log.flush();
      const all: AppEvent[] = [];
      for await (const event of log.readAll()) all.push(event);
      const before = estimateHistoryTokens(all);
      const nextSeq = (all[all.length - 1]?.seq ?? 0) + 1;
      const marker = '\n（新的一段往来。）';
      let text = '料';
      // 逐次逼近：每轮都用**同一把尺**量一次（不做解析式的字符↔token 换算，那是第二份口径）
      for (let i = 0; i < 24; i += 1) {
        const after = estimateHistoryTokens([...all, offsetWake(nextSeq, text + marker)]);
        if (after - before >= tokens) break;
        const missing = tokens - (after - before);
        text += '垫'.repeat(Math.max(64, Math.ceil(missing * 1.2)));
      }
      return text + marker;
    },
  };
}

/** 只用于量 token 的假事件（seq 挂在日志末尾之后：`estimateHistoryTokens` 只看遮蔽点之后那一段） */
function offsetWake(seq: number, note: string): AppEvent {
  return {
    seq, ts: T0.toISOString(), type: 'wake/manual', data: { note },
    visibility: 'model', origin: 'test',
  } as unknown as AppEvent;
}

const decisions = (events: AppEvent[]): Array<AppEvent & { type: 'compaction/decision' }> =>
  events.filter((event): event is AppEvent & { type: 'compaction/decision' } =>
    event.type === 'compaction/decision');

const compactWakes = (events: AppEvent[]): Array<AppEvent & { type: 'wake/manual' }> =>
  events.filter((event): event is AppEvent & { type: 'wake/manual' } =>
    event.type === 'wake/manual' && (event.data as { via?: string }).via === 'compact');

/** 压缩**前**那条预警（`via:'compact-soon'`，2026-10-15 加）——与本文件的 `via:'compact'` 是两件事 */
const compactSoons = (events: AppEvent[]): Array<AppEvent & { type: 'wake/manual' }> =>
  events.filter((event): event is AppEvent & { type: 'wake/manual' } =>
    event.type === 'wake/manual' && (event.data as { via?: string }).via === 'compact-soon');

const summaries = (events: AppEvent[]): Array<AppEvent & { type: 'compaction/summary' }> =>
  events.filter((event): event is AppEvent & { type: 'compaction/summary' } =>
    event.type === 'compaction/summary');

// ──────────────────────── ① 每 turn 一行 + 一行长什么样 ────────────────────────

test('留痕：每个 turn 恰好一行 compaction/decision，字段逐项对得上（含 wrote 那条的遮蔽点）', async (t) => {
  const rig = await makeRig(t);
  // 垫料：一段"早前那一段往来"（它会进第一份交接笔记，这正是它的用处——把历史推过阈值）
  await rig.appendWake(SEED_TEXT);

  await rig.tick();          // turn 1：起 turn → 压一次（wrote）
  await rig.tick();          // turn 2：消费那条压缩唤醒（这一拍不该再压）

  const events = await rig.events();
  const starts = events.filter((event) => event.type === 'turn/start');
  const ends = events.filter((event) => event.type === 'turn/end');
  const rows = decisions(events);

  // ① 每 turn 一行：条数与 turn/start 一一对应（**这才是这份留痕的价值**）
  assert.equal(starts.length, 2, `这个夹具该跑两个 turn：${events.map(e => e.type).join(',')}`);
  assert.equal(rows.length, starts.length,
    `一 turn 一行（turn/start ${starts.length} 条 ⇒ 留痕也该 ${starts.length} 条）`);
  assert.deepEqual(
    rows.map((row) => row.data.turn),
    starts.map((event) => (event.data as { turn: number }).turn),
    '每一行的 turn 都能与某条 turn/start 对上（顺序也一致）',
  );

  // ② 字段：第一行是 wrote（压了），第二行是 threshold（没压）
  const first = rows[0]!;
  assert.equal(first.data.reason, 'wrote', '第一拍历史越线 ⇒ 该压');
  assert.ok(first.data.historyTokens > THRESHOLD,
    `historyTokens 要如实报当时的估算（${first.data.historyTokens} > ${THRESHOLD}）`);
  assert.equal(first.data.thresholdTokens, THRESHOLD, 'thresholdTokens 是当时生效的配置值');
  assert.equal(typeof first.data.coveredUpToSeq, 'number', 'wrote 那一条必须带遮蔽点');
  assert.equal(first.data.previousCoveredUpToSeq, 0, '第一次折叠 ⇒ 参照点是 0（还没压过）');
  // 遮蔽点必须落在**本 turn 的 turn/end** 上（不是 turn/start、也不是任意 seq）——
  // 这一条是 §4.13 那条"不能劈开他问的那句与她答的那段"的机器判据，也是
  // `maybeCompact` 里那句 `await this.syncEvents()` 的回归哨兵（少了它，判定看不到
  // 本 turn 的 turn/end，遮蔽点会退回 turn/start：叫醒她的那句话被遮掉、她的回答留在现场）。
  assert.equal(first.data.coveredUpToSeq, ends[0]?.seq,
    '遮蔽点 = 本 turn 的 turn/end（整轮要么一起进笔记、要么一起留在现场）');
  assert.ok((first.data.coveredUpToSeq ?? 0) > (starts[0]?.seq ?? 0), '遮蔽点落在本 turn 之内');
  const seed = events.find((event) => event.type === 'wake/manual')!;
  assert.ok(first.seq > (ends[0]?.seq ?? 0), '留痕落在 turn/end 之后（它是"这一拍的账"）');
  assert.ok((ends[0]?.seq ?? 0) > seed.seq, '叫醒她的那句话在遮蔽点之前 ⇒ 与她的回答同侧');
  const summary = summaries(events)[0]!;
  assert.equal(first.data.coveredUpToSeq, summary.data.coveredUpToSeq,
    '留痕里的遮蔽点与紧随其后的 summary 是**同一个数**（两个数对不上就没法复盘）');
  assert.ok(summary.seq < first.seq,
    `先落摘要、再落留痕（summary=${summary.seq} decision=${first.seq}）——留痕记的是"这一拍的账"`);
  assert.equal(summary.visibility, 'model', '摘要进她的上下文');
  assert.equal(first.visibility, 'internal', '留痕不进她的上下文');

  const second = rows[1]!;
  assert.equal(second.data.reason, 'threshold', '第二拍没越线 ⇒ 如实写"阈值没过"');
  assert.equal(second.data.coveredUpToSeq, undefined,
    '阈值没过时"遮蔽点在哪"还不是一个事实 ⇒ 该字段缺席（不填 0 冒充算过）');
  assert.ok(second.data.historyTokens <= THRESHOLD,
    `压完之后可见历史该掉到阈值之下（${second.data.historyTokens}）`);
});

// ──────────────────────── ①-b 真实读数（2026-10-21 加） ────────────────────────

test('留痕带真实读数：本 turn 最近一笔成功调用的 usage.inputTokens + 同一笔的估算合计', async (t) => {
  const rig = await makeRig(t);
  await rig.appendWake(SEED_TEXT);
  await rig.tick();          // turn 1：wrote
  await rig.tick();          // turn 2：消费 via=compact

  const events = await rig.events();
  const rows = decisions(events);
  assert.ok(rows.length >= 2, `这个夹具该有两行留痕（实测 ${rows.length}）`);

  for (const row of rows) {
    // fake heavy 每一次流式调用都报 usage.inputTokens = 10（本 turn 最近一笔成功调用的真值）
    assert.equal(row.data.inputTokens, 10,
      `turn ${row.data.turn}：inputTokens 要如实记 usage.inputTokens（不是估算）`);
    assert.equal(typeof row.data.estimatedInputTokens, 'number');
    assert.ok((row.data.estimatedInputTokens ?? 0) > 0,
      `turn ${row.data.turn}：同一笔请求的估算合计要是个真数`);

    // 与**同一 turn 最后一笔** budget/consumed.context 的三个段事实逐字同源
    const consumed = events.filter(
      (event): event is AppEvent & { type: 'budget/consumed' } =>
        event.type === 'budget/consumed' && event.data.turn === row.data.turn,
    );
    const last = consumed[consumed.length - 1]!;
    const context = last.data.context!;
    assert.equal(
      row.data.estimatedInputTokens,
      context.instructions.tokens + context.tools.tokens + context.input.tokens,
      `turn ${row.data.turn}：估算合计 = instructions + tools + input（与 budget/consumed.context 同源）`,
    );
  }
});

// ──────────────────────── ② internal ⇒ 不进请求（契约边界） ────────────────────────

test('留痕是 internal：可见性表 + 真请求体两处都不进请求', async (t) => {
  const rig = await makeRig(t);
  await rig.appendWake(SEED_TEXT);
  await rig.tick();
  await rig.tick(); // 第二拍：摘要这时才第一次进她的请求（压缩发生在第一拍收尾之后）

  assert.equal(defaultVisibility('compaction/decision'), 'internal',
    '写入点走 defaultVisibility，所以表里这一格就是契约');

  const events = await rig.events();
  const row = decisions(events)[0]!;
  // ① 真请求体：她**实际发出去**的那一份里没有它（比拿一份手工拼的 RenderInput 更硬）。
  //    用**最后那一次**请求：拼接所有请求的话，"前面某一轮里有 X"会让"这一轮里没有 X"假红。
  const sent = rig.lastRequestText();
  assert.equal(sent.includes('compaction/decision'), false, '事件类型名不该出现在请求里');
  assert.equal(sent.includes('thresholdTokens'), false, '判据的字段名同样不该出现');
  assert.equal(sent.includes(String(row.data.historyTokens)), false,
    `留痕里的数不该进请求（${row.data.historyTokens}）`);
  // 正对照：同一次请求里，那份摘要**必须**在（否则上面三条可能只是因为整条路都坏了）
  assert.ok(sent.includes('早期历史摘要'), '同一次请求里摘要要在——否则上面三条不算证据');
  // ② 渲染层单测（判据落在"事件流 → input"这一步上，与上面那条互为正反）
  const rendered = render({
    events,
    persona: { identity: 'I', constitution: 'C', style: 'S', state: 'ST', personaHash: 'h' },
    wakeEvent: null,
    taskCard: null,
    now: T0.toISOString(),
    timezone: TZ,
    lane: 'heavy',
    model: 'fake',
    tools: [],
    skillCatalog: null,
    memoryIndex: null,
    turnBlock: null,
  } as unknown as Parameters<typeof render>[0]);
  const input = JSON.stringify(rendered.input);
  assert.equal(input.includes('compaction/decision'), false, '渲染层也不该把它变成任何一段');
  assert.ok(input.includes('早期历史摘要'), '同一次渲染里摘要要在——否则上面三条不算证据');
});

// ──────────────────────── ③④⑤ 真唤醒 + 正文逐字 + 顺序 + 反向 ────────────────────────

test('真唤醒：压缩完成后起 turn、正文逐字进当轮请求体，且顺序是先 summary 后 wake', async (t) => {
  const rig = await makeRig(t);
  await rig.appendWake(SEED_TEXT);

  // ③ 反向的**前提**：还没跑拍时不许已经有 turn（否则下面测不出"真唤醒"）
  assert.equal((await rig.ofType('turn/start')).length, 0, '"落了事件"本身不是唤醒');

  await rig.tick(); // 第一拍：起 turn → 收尾压一次 → 同一拍把唤醒放进队列

  const events = await rig.events();
  const wake = compactWakes(events)[0];
  assert.ok(wake !== undefined, `压缩之后必须发一条 wake/manual(via=compact)：${events.map(e => e.type).join(',')}`);
  assert.equal(wake.visibility, 'model', '它要进她的上下文（internal 的那条她看不见）');
  assert.equal((wake.data as { person?: string }).person, undefined,
    '用户没开口 ⇒ 不带人（带了会把关系档案注进这一轮）');

  // ④ 顺序：先 summary、后 wake（日志顺序即因果顺序）
  const summary = summaries(events)[0]!;
  const covered = summary.data.coveredUpToSeq;
  assert.ok(summary.seq < wake.seq, `先压后叫（summary=${summary.seq} wake=${wake.seq}）`);

  // ③ 判据一：**真的起了一个 turn**（这一拍还没起——唤醒是给下一拍的活）
  const before = (await rig.ofType('turn/start')).length;
  assert.equal(before, 1, '第一拍只有一个 turn（压缩那一拍自己）');
  await rig.tick(); // 第二拍：认领那条唤醒 → 真起 turn
  assert.equal((await rig.ofType('turn/start')).length, 2, '唤醒必须真的起一个 turn');

  // ③ 判据二：正文**逐字**进了**当轮**请求体（分行验：漏一段就红）
  const text = rig.lastRequestText();
  const note = (wake.data as { note: string }).note;
  for (const line of note.split('\n')) {
    assert.ok(text.includes(line), `这一行必须逐字进她当轮的请求：\n${line}\n---请求尾部---\n${text.slice(-1500)}`);
  }
  assert.ok(text.includes('【框架通报 · 上下文压缩】'), '段头要在（她要一眼看出这不是用户说的话）');
  assert.ok(text.includes(`覆盖至 seq ${covered}`), '要说清遮蔽点在哪');
  assert.ok(text.includes('data/events'), '入口要落在她真能读到的路径上');
  assert.ok(text.includes('接着做'), '用户点名要的那一句「如有中断的工作则继续」必须在');
  // 判据落在**那条正文**上，不是整份请求体：请求体里别处的 `**` 是既有的（记忆索引 / 自述），
  // 本批只管"框架通报的正文"这一类字。
  assert.equal(note.includes('**'), false, '正文里不许出现 Markdown 记号（界面不渲染它，星号会原样显示）');
  assert.ok((await rig.ofType('input/claimed')).length >= 2, '那条唤醒被当轮认领掉（不留在队列里反复叫）');
});

// ──────────────────────── ⑤ 反向：没有压缩 ⇒ 一个字都不发 ────────────────────────

test('反向断言：没有压缩（reason=threshold）⇒ 不发唤醒、不起新 turn', async (t) => {
  const rig = await makeRig(t, { thresholdTokens: 10_000_000 }); // 阈值抬到天上 ⇒ 永远压不了
  await rig.appendWake(SEED_TEXT);

  await rig.tick();
  const events = await rig.events();
  const row = decisions(events)[0]!;
  assert.equal(row.data.reason, 'threshold', '这个夹具必须落在"阈值没过"那一支');
  assert.equal(row.data.coveredUpToSeq, undefined);
  assert.equal(summaries(events).length, 0, '没压 ⇒ 没有摘要');
  assert.equal(compactWakes(events).length, 0, '没压 ⇒ **不发**压缩唤醒（别每拍都吵她）');
  assert.equal((await rig.ofType('turn/start')).length, 1, '没压 ⇒ 不起第二个 turn');
  // 压缩预警（`via:'compact-soon'`，2026-10-15 加）也是 `wake/manual`，但它是**另一件事**，
  // 判据按 `via` 分。本用例的阈值抬到天上（1e7）⇒ 那条预警的判据落在"线下"、**不发**，
  // 所以队列里只该有夹具最初那一条（没多出任何东西）。
  assert.equal(compactSoons(events).length, 0, '这一支与压缩预警无关 ⇒ 不掺进它的断言');
  const manual = await rig.ofType('wake/manual');
  assert.deepEqual(manual.map((event) => (event.data as { via?: string }).via), [undefined],
    '队列里只有最初那条唤醒（夹具写的，没有 via）——没多出任何东西');
});

// ──────────────────────── ⑥ 防抖：同一 turn 不重复发 + 链在闸门处终止 ────────────────────────

test('防抖：唤醒那一拍自己也做压缩检查，但同一 turn 不重复发，且不自我激发出第三条', async (t) => {
  const rig = await makeRig(t);
  await rig.appendWake(SEED_TEXT);
  await rig.tick();          // turn 1：压 → 发第 1 条唤醒
  await rig.tick();          // turn 2：这一拍就是那条唤醒，收尾仍会做压缩检查

  const events = await rig.events();
  assert.equal(compactWakes(events).length, 1,
    '唤醒那一拍不许再发一条（"同一 turn 不重复发"）');
  assert.equal(decisions(events).length, 2, '但留痕照旧每 turn 一行（判据一直在跑，只是不该压）');
  assert.equal(decisions(events)[1]!.data.reason, 'threshold',
    '刚压完，可见历史已掉到阈值之下 ⇒ 第二拍连闸门都走不到');
});

test('防抖（链）：再垫一次料 ⇒ 下一个 turn 也只发一条，而且旧的那条早已被认领', async (t) => {
  const rig = await makeRig(t);
  await rig.appendWake(SEED_TEXT);
  await rig.tick();          // turn 1：压 → 唤醒 #1（进队列）
  await rig.tick();          // turn 2：认领 #1
  // 又垫**够一个 recent tail 以上**的新料（闸门要的就是这个：新闭合量 ≥ 一个 recent tail）
  const second = await rig.fillerForTokens(RECENT_TAIL_TOKENS + 12_000);
  assert.ok(second.length > 0);
  await rig.appendWake(second);
  await rig.tick();          // turn 3：压 → 唤醒 #2
  await rig.tick();          // turn 4：认领 #2

  const events = await rig.events();
  assert.equal(summaries(events).length, 2,
    `两次压缩（第二拍的料是新闭合的，够一个 recent tail）：`
    + `${decisions(events).map(r => `${r.data.turn}:${r.data.reason}/${r.data.maskedTokens}`).join(' ')}`);
  assert.equal(compactWakes(events).length, 2, '每次都只发一条（不是 2 的幂、也不是每拍都发）');
  const rows = decisions(events);
  assert.deepEqual(rows.map((row) => row.data.reason), ['wrote', 'threshold', 'wrote', 'threshold'],
    '四个 turn 各一行：压、没压、压、没压');
  const wakes = compactWakes(events);
  assert.ok(summaries(events)[0]!.seq < wakes[0]!.seq, '第一次：先 summary 后 wake');
  assert.ok(summaries(events)[1]!.seq < wakes[1]!.seq, '第二次：同样先 summary 后 wake');
  assert.ok(wakes[0]!.seq < summaries(events)[1]!.seq, '第二条压缩发生在第一条唤醒被认领之后（顺序单调）');
});

// ──────────────────────── ⑦ 闸门那一支（刚压完再压 ⇒ gate） ────────────────────────

test('闸门：新闭合的历史不足一个 recent tail ⇒ 不写摘要、不发唤醒（"这一拍不划算"）', async (t) => {
  const rig = await makeRig(t);
  // 第一次折叠：垫料远超阈值（这一拍必然 wrote）
  await rig.appendWake(SEED_TEXT);
  await rig.tick();
  assert.equal(decisions(await rig.events())[0]!.data.reason, 'wrote');

  // 第二次：**小料**——量出"新闭合的历史"再定它的多少：刚压完的可见历史 + 一个小增量。
  // 这个增量刻意取在 RECENT_TAIL_TOKENS 之下：越过阈值、但远不够一个 recent tail。
  await rig.tick(); // 先消费掉那条唤醒（否则它和下面的料挤在同一批）
  await rig.appendWake(await rig.fillerForTokens(THRESHOLD + 1_000));
  await rig.tick();

  const events = await rig.events();
  const row = decisions(events)[decisions(events).length - 1]!;
  // 判据是**量出来的**：新闭合的历史 < RECENT_TAIL_TOKENS ⇒ 一定压不动。
  // （历史刚被压过，"越过阈值"这件事本身还要看那一拍剩了多少——所以这里两种结论都合法，
  //   但**绝不允许**是 wrote，也绝不允许发出唤醒。）
  assert.ok(row.data.reason === 'gate' || row.data.reason === 'threshold',
    `小增量这一拍只可能被闸门或阈值拦下，不会是 ${row.data.reason}`
    + `（history=${row.data.historyTokens} masked=${row.data.maskedTokens}）`);
  if (row.data.reason === 'gate') {
    assert.ok((row.data.maskedTokens ?? 0) < RECENT_TAIL_TOKENS,
      `闸门量要如实报出来（${row.data.maskedTokens} < ${RECENT_TAIL_TOKENS}）`);
    assert.ok((row.data.previousCoveredUpToSeq ?? 0) > 0, '参照点是已有摘要的覆盖点（不是 0）');
  }
  assert.equal(summaries(events).length, 1, '被拦下 ⇒ 不写第二份摘要');
  assert.equal(compactWakes(events).length, 1, '也不发第二条唤醒');
});

test('闸门不管第一次折叠：参照点为 0 时量出来的是整条历史（这是刻意的）', async (t) => {
  const rig = await makeRig(t);
  await rig.appendWake(SEED_TEXT);
  await rig.tick();
  const row = decisions(await rig.events())[0]!;
  assert.equal(row.data.reason, 'wrote');
  assert.equal(row.data.previousCoveredUpToSeq, 0);
  // 第一次折叠的"闸门量"= (0, covered] 的整条可见历史，它必然 ≫ 一个 recent tail
  assert.ok((row.data.maskedTokens ?? 0) >= RECENT_TAIL_TOKENS,
    `第一次折叠量的是整条历史（${row.data.maskedTokens}）——拿增量卡它会让第一次永远压不动`);
});

// ──────────────────────── ⑧ 与手动那条路同源 ────────────────────────

test('口径同源：手动 /compact 那条路与自动压缩算出来的遮蔽点是同一个函数（同一份日志同一个数）', async (t) => {
  const rig = await makeRig(t);
  await rig.appendWake(SEED_TEXT);
  await rig.tick();

  // 手动那条路的判据在 `real-loop.planSlashCompaction` 里，读的是**同一份**日志与
  // 同一个 `compactionCoveredUpToSeq`（floorSeq = 队列里最老那条之前）。这里不重复实现它，
  // 只钉住"两条路用的是同一个导出"——`compactionCoveredUpToSeq` 是全仓唯一一份遮蔽点口径。
  const all = await rig.events();
  const summary = summaries(all)[0]!;
  const manualView = compactionCoveredUpToSeq(all, null, 0);
  const autoView = compactionCoveredUpToSeq(all, null, 0, true);
  assert.equal(typeof manualView, 'number');
  assert.equal(typeof autoView, 'number');
  // 自动压缩取的是**本 turn 的 turn/end**（includeInFlightTurn），所以它 ≥ 手动那条
  // （手动没有进行中的 turn，取日志里最后一条 turn/end）
  assert.ok(autoView >= manualView, `自动口径不得早于手动口径（${autoView} ≥ ${manualView}）`);
  assert.ok(summary.data.coveredUpToSeq <= autoView,
    '摘要的遮蔽点是当时算出来的那个数（之后的事件不会让它变小）');
});

// ──────────────────────── ⑨ 唤醒正文是一个纯函数（同一份判定 ⇒ 同一串字节） ────────────────────────

test('唤醒正文里那些"要她做的事"逐条都在（三条口径，缺一不可）', async (t) => {
  const rig = await makeRig(t);
  await rig.appendWake(SEED_TEXT);
  await rig.tick();
  const wake = compactWakes(await rig.events())[0]!;
  const note = (wake.data as { note: string }).note;
  const lines = note.split('\n');
  assert.equal(lines.length, 4, `正文该是四行（段头 + 三条）：\n${note}`);
  assert.ok(lines[0]!.includes('turn 1'), '段头要带上这是哪一拍');
  assert.ok(lines[1]!.includes('交接笔记'), '① 告知刚压过 + 替代品是什么');
  assert.ok(lines[1]!.includes('最前面'), '① 要给**具体位置**（在最前面那段里），不是一句概念');
  assert.ok(lines[2]!.includes('safe_read'), '② 要看细节 ⇒ 给一条她已有的能力');
  assert.ok(lines[3]!.includes('接着做'), '③ 用户点名要的那一句');
});

// ──────────────────────── ⑩ 事件形状（契约） ────────────────────────

test('契约：compaction/decision 的事件形状与可见性（新增事件不许悄悄进请求）', () => {
  // 形状：类型名、可见性两处由这一条钉住；字段的可选性由 TypeScript 的联合类型钉住
  const sample: CompactionDecision = {
    seq: 1,
    ts: T0.toISOString(),
    type: 'compaction/decision',
    visibility: 'internal',
    origin: 'runtime/agent-loop',
    data: {
      turn: 7,
      historyTokens: 123_456,
      thresholdTokens: 100_000,
      reason: 'gate',
      coveredUpToSeq: 900,
      previousCoveredUpToSeq: 800,
      maskedTokens: 1_234,
    },
  };
  assert.equal(sample.type, 'compaction/decision');
  assert.equal(defaultVisibility(sample.type), 'internal');
  const summary: CompactionSummary = {
    seq: 2, ts: T0.toISOString(), type: 'compaction/summary', visibility: 'model',
    data: { coveredUpToSeq: 900, summary: 'x' },
  };
  assert.equal(defaultVisibility(summary.type), 'model');
});

// ────────── ⑪ v75：回传字符超上限 ⇒ **立即压**（`trigger = 'echo-chars'`） ──────────

/**
 * 只读复算把 **2026-10-21 凌晨那 39 分钟**追到了一个很具体的错位上（零反例）：
 *
 *   · `compaction/decision` 进第一道门**只有一条路**——`historyTokens > thresholdTokens`（200,000）；
 *   · 而"顶穿 300,000"的是**渲染层的字符账**（回传思维链的正文总字符），它与估算器的 token 账
 *     **不是同一把尺**（估算器按 1.5 字/token，实测偏低 1.6× 左右）；
 *   · 于是那段时间里 token 侧一直没到线（`reason` 恒为 `threshold`），压缩线**根本没被叫到**，
 *     而渲染层每一笔都在挤最老的组 ⇒ 每笔 92% miss，烧了 39 分钟。
 *
 * 这一组钉 v75 的第二条进门路：**回传字符 > 上限 ⇒ 这一轮收尾就压**，并且账上要说得出
 * "是哪一条判据把它推过门的"（`trigger`）与它用的三个数（`echoChars` / `echoCharsKept` /
 * `echoCharsLimit`）。
 */
function echoTriggerEvents(): { events: AppEvent[]; turnStartSeq: number } {
  let seq = 0;
  const events: AppEvent[] = [];
  const push = (type: string, data: unknown): AppEvent => {
    seq += 1;
    const event = {
      seq, ts: T0.toISOString(), type, data,
      visibility: defaultVisibility(type), origin: 'test/echo-trigger',
    } as unknown as AppEvent;
    events.push(event);
    return event;
  };
  push('wake/manual', { note: '接着干' });
  // 老历史 40 组（**在本轮 turn/start 之前**：v75 的驱逐边界只按这一段算）
  for (let i = 0; i < 40; i += 1) {
    const chars = i === 39 ? 7_501 : 7_500;
    push('message/user', { text: `第 ${i + 1} 组输入`, source: 'human' });
    push('message/assistant', { text: `ANSWER-${i + 1}`, toolCalls: [] });
    push('message/reasoning', {
      turn: 9, step: i + 1, text: `R${i + 1}-` + '甲'.repeat(chars - 2 - String(i + 1).length),
    });
  }
  const start = push('turn/start', { turn: 9 });
  push('turn/end', { turn: 9, reason: { kind: 'completed' }, spoke: true });
  return { events, turnStartSeq: start.seq };
}

test('★ v75：回传字符顶穿 300,000 ⇒ 压缩判定的 trigger 是 echo-chars（token 侧根本没越线）', () => {
  const { events, turnStartSeq } = echoTriggerEvents();
  const decision = compactionDecision({
    events, turn: 9, turnStartSeq, cfg: { thresholdTokens: 200_000 },
  });
  // 前置：token 那一条路**没有**越线——这正是现场的形状（估算器一直在 200,000 以下）
  assert.ok(decision.historyTokens < 200_000,
    `（前置）token 侧没越线：${decision.historyTokens} < 200,000`);
  // 新判据的三个数都在账上（缺一个都读不出"超了多少"）
  assert.equal(decision.echoChars, 300_001, '★ 会回传的总字符（留下的 + 已被挤掉的）');
  assert.equal(decision.echoCharsLimit, 300_000, '★ 生效的上限');
  assert.ok((decision.echoCharsKept ?? 0) < 300_000,
    `留下的那一份已经被挤回上限以内（${decision.echoCharsKept}）——所以判据读的是总字符，不是它`);
  // 结论：压了，且推门的是新判据
  assert.equal(decision.trigger, 'echo-chars', '★ "哪一条判据把它推过第一道门"');
  assert.equal(decision.reason, 'wrote', '两条进门路都通到同一道结论（压）');
  assert.ok((decision.coveredUpToSeq ?? 0) > turnStartSeq, '遮蔽点落在本轮之内（交接覆盖本轮）');
});

test('对照：字符侧没超 ⇒ 老口径说了算（token 越线 = history-tokens；都没越线 = 连 trigger 都没有）', () => {
  const { events, turnStartSeq } = echoTriggerEvents();
  const small = events.filter(event => {
    if (event.type !== 'message/reasoning') return true;
    return (event.data as { text: string }).text.length < 2_000;
  });
  // ① 都没越线 ⇒ reason=threshold，且**没有** trigger（"谁都没推门"不是"推门的是空"）
  const below = compactionDecision({ events: small, turn: 9, turnStartSeq, cfg: { thresholdTokens: 200_000 } });
  assert.equal(below.reason, 'threshold');
  assert.equal(below.trigger, undefined);
  assert.ok(below.echoChars < 300_000);
  assert.ok(below.historyTokens < 200_000);
  // ② token 越线、字符没越线 ⇒ 老口径推的门
  const tokenOver = compactionDecision({ events: small, turn: 9, turnStartSeq, cfg: { thresholdTokens: 10 } });
  assert.equal(tokenOver.echoChars, below.echoChars, '（前置）字符账没变');
  assert.equal(tokenOver.trigger, 'history-tokens', '★ 老口径仍然记在 trigger 上（可归因）');
  assert.equal(tokenOver.reason, 'wrote');
});

