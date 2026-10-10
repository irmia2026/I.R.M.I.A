/**
 * 「重投」标记只属于当前输入，**历史 item 永不被改写**（v49，2026-10-10）。
 *
 * ──────────────────────── 这一版改的是什么（别读成那次 miss 的修法） ────────────────────────
 *
 * 机制（实测）：`requeuedSeqsOf` **从当前事件流全量重算**，不看那条 `input/requeued` 发生在
 * 第几拍 ⇒ 一条**后来的** requeue（崩溃重投 / 人审答复 `reason:'human-answered'`）会让它盖住的
 * 那条 wake 在**它已经进历史之后**被补上 ` · 重投`：同一个事件序列先渲染成
 * `[界面消息] …`、之后又渲染成 `[界面消息 · 重投] …`。那违反"只追加"（本文件头铁律 2）。
 * 全量日志口径：66 条 `input/requeued`、99 个被重投的 wake，其中 **73 个是"已进历史之后才被标"**。
 *
 * ⚠️ **它不是 03:17 那次 `miss=37884` 的修法**：那次的主因是**同一条框架通报被重投了第二遍、
 * 插在历史中间**（它之后的一切错位）——逐项对照见 `src/model/render.ts` 顶部 v49 那一篇。
 * 本文件钉的是"历史永不被改写"这一条，**不包括**那条插入（那归唤醒那条线）。
 *
 * ──────────────────────────── 四条判据（本文件就是它们） ────────────────────────────
 *
 * ① **历史 item 字节稳定**：插入一条 `input/requeued` 之后，同一拍的两次渲染
 *    （一次带那条事件、一次把它摘掉）**除当轮输入那一格的两个字以外逐字节相同**。
 * ② **当前输入仍带"重投"**：被重投的那一拍，**当轮输入**那条 wake 上必须有 ` · 重投`。
 * ③ **因果对照**：把那条 `input/requeued` 拿掉 ⇒ 两次渲染的条数与字节只差那个标记。
 * ④ **真数据回归**（`data/events`）：拿真实发生过的那一拍，删掉盖住它的那条 requeue
 *    之后**前缀逐字节相同**。`data/` 是运行数据、不在版本库里 ⇒ 找不到时**如实跳过**并说明。
 *
 * **没实测的**：这一改对 cacheHit 的实际改善没有实测——本次现场那次 miss 的主因是上面
 * 那条"插入"，修完它**不会**消失。
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { defaultVisibility, type AppEvent } from '../src/log/types.ts';
import { NOW_LAYER_BANNER, inputContentText, render, type InputItem, type RenderInput } from '../src/model/render.ts';
import { locateStep, rebuildRenderedRequest } from '../src/runtime/replay.ts';
import { loadPersona } from '../src/persona/loader.ts';
import { catalogToolSpecs } from '../src/tools/catalog.ts';

// ──────────────────────────────── 事件与渲染的小工厂 ────────────────────────────────

let seq = 0;

/** 一条事件（seq 自增；ts 按分钟自增，保证同一份构造逐字节可复现） */
function mk<T extends AppEvent['type']>(type: T, data: unknown, patch: { seq?: number; ts?: string } = {}): AppEvent {
  seq += 1;
  return {
    seq: patch.seq ?? seq,
    ts: patch.ts ?? new Date(Date.UTC(2026, 1, 14, 10, seq)).toISOString(),
    type,
    data,
    visibility: defaultVisibility(type),
  } as unknown as AppEvent;
}

function resetSeq(): void {
  seq = 0;
}

const NOW = '2026-02-14T18:00:00.000Z';

/** 最小可渲染输入（只要历史那一侧；此刻层/固定块都关掉，免得噪音进断言） */
function renderWith(events: AppEvent[], wakeEvent: AppEvent | null): RenderInput & { events: AppEvent[] } {
  return {
    events,
    persona: { identity: 'ID', constitution: 'CO', style: 'ST', state: 'STATE' },
    tools: [{ name: 'safe_read', description: '读文件', parameters: { type: 'object', properties: {} } }],
    wakeEvent,
    taskCard: null,
    now: NOW,
    timezone: 'Asia/Shanghai',
    model: 'fake-heavy',
    lane: 'heavy',
    turnBlock: null,
    memoryIndex: null,
    skillCatalog: null,
  } as RenderInput & { events: AppEvent[] };
}

const textOf = (item: InputItem): string =>
  item.type === 'message' ? inputContentText(item.content) : JSON.stringify(item);

/**
 * 请求体里**冻结的那一段**（长期记忆层 + 历史 + 本轮新输入）：判据要的是它。
 *
 * **剥掉此刻层**：那一层逐 step 变（时刻、进度、本机），是**设计内**会变的那一格
 * （本文件头 v24/v29 那些注释与 `requestFingerprint` 同一口径）——把它算进"历史被改写了"
 * 就成了假结论。剥法按**段头常量**认层，不按索引认（与 render 自己的做法一致）。
 */
function frozenOf(request: { input: InputItem[] }): string[] {
  return request.input.map(textOf).filter((line) => !line.includes(NOW_LAYER_BANNER));
}

// ──────────────────────────────── 现场那一对的构造 ────────────────────────────────

/**
 * 造一份"已经发生过一次重投"的日志。
 *
 * 三个时点是判据的骨架（每个时点的**当轮输入不在 `events` 里**——那是 `agent-loop` 的协同契约）：
 *   · **第 1 拍**：`wake`（一条 `wake/manual`）作为当轮输入 ⇒ 它的字节从此进历史；
 *   · **第 2 拍**：一条 `input/requeued` 盖住它（现场那条 reason 是 `human-answered`，
 *     这里用同一个值——判据不看 reason，看"那条 requeue 发生在第几拍"），它**又被递了一次**；
 *   · **第 3 拍**：另一条 wake 当轮输入 ⇒ 第 2 拍那一格这时已经成了历史，
 *     于是"它进历史时的字节"可以直接读出来。
 */
function sceneWithRequeue(): { before: AppEvent[]; after: AppEvent[]; wake: AppEvent } {
  resetSeq();
  const wake = mk('wake/manual', {
    note: '【框架通报 · 上下文压缩】turn 1244 刚做过一次上下文压缩。手上没做完的事接着做。',
  });
  const before = [
    mk('turn/start', { turn: 1 }),
    mk('input/claimed', { turn: 1, wakeSeqs: [wake.seq], claimCounts: [0] }),
    mk('step/start', { turn: 1, step: 1, model: 'fake-heavy', lane: 'heavy', renderVersion: '49', personaHash: 'p' }),
    mk('message/assistant', { text: '收到。', toolCalls: [] }),
    mk('turn/end', { turn: 1, reason: { kind: 'completed' }, spoke: true }),
  ];
  // 第 2 拍：人审答复把那条 wake 退回队列（现场 seq 72375 那一条），它重新成为当轮输入
  const after = [
    ...before,
    mk('input/requeued', {
      wakeSeqs: [wake.seq], claimCounts: [0], sources: ['manual'], reason: 'human-answered',
    }),
    mk('turn/start', { turn: 2 }),
    mk('input/claimed', { turn: 2, wakeSeqs: [wake.seq], claimCounts: [1] }),
    mk('step/start', { turn: 2, step: 1, model: 'fake-heavy', lane: 'heavy', renderVersion: '49', personaHash: 'p' }),
  ];
  return { before, after, wake };
}

// ──────────────────────────────── ① 历史 item 字节稳定 ────────────────────────────────

test('① 插入一条 input/requeued 之后，历史那一段**逐字节不变**（只多出新的尾部）', () => {
  const { before, after, wake } = sceneWithRequeue();

  // 第 1 拍：那条 wake 是当轮输入（它进历史时的字节 —— 那时还没有任何 requeue）
  const turn1 = frozenOf(render(renderWith(before, wake)));
  // 第 2 拍：同一拍的两种事件流——一种带那条 requeue，一种把它摘掉（因果对照）
  const withRequeue = frozenOf(render(renderWith(after, wake)));
  const noRequeue = frozenOf(render(renderWith(after.filter((e) => e.type !== 'input/requeued'), wake)));

  // ── 判据一：差异**只有**当轮输入那一格的两个字 ──
  // （不按下标切：当轮输入在 output 里的位置由渲染顺序决定，两边本来就该逐条对齐）
  assert.equal(withRequeue.length, noRequeue.length, '两次渲染条数相同（只差标记两个字）');
  assert.deepEqual(
    withRequeue.map((line) => line.replace(' · 重投', '')),
    noRequeue,
    '除那两个字以外，一个字节都不许差',
  );
  const marked = withRequeue.filter((line) => line.includes('重投'));
  assert.equal(marked.length, 1, '有 requeue 时恰好一格带标记');
  assert.match(marked[0]!, /^\[界面消息 · 重投\] /u, '标记的形态：`[界面消息 · 重投] <note>`');
  assert.deepEqual(noRequeue.filter((line) => line.includes('重投')), [], '没有 requeue 时一个字都不该有');

  // ── 判据二：历史里那一条**与它第一次进历史时逐字节相同** ──
  // （第 1 拍那一格 = `turn1` 的最后一条；它在第 2 拍里必须是同一个字节串）
  const originalLine = turn1[turn1.length - 1]!;
  assert.ok(originalLine.includes('【框架通报 · 上下文压缩】'), '第 1 拍那一格就是那条 wake');
  assert.equal(
    noRequeue.includes(originalLine),
    true,
    '第 2 拍里那条老 item 与第 1 拍逐字节相同',
  );
});

// ──────────────────────────────── ② 当前输入仍带"重投" ────────────────────────────────

test('② 被重投的那一拍：**当轮输入**的 wake 上照旧有 ` · 重投`（信号一个字没少）', () => {
  const { after, wake } = sceneWithRequeue();
  const request = render(renderWith(after, wake));

  const withMarker = request.input.map(textOf).filter((line) => line.includes('重投'));
  assert.equal(withMarker.length, 1, '当轮输入那条**恰好一条**带标记（不多不少）');
  assert.match(withMarker[0]!, /^\[界面消息 · 重投\] /u, '标记的形态：`[界面消息 · 重投] <note>`');
  assert.ok(withMarker[0]!.includes('【框架通报 · 上下文压缩】'), '标的是那条被重投的话本身');
});

// ──────────────────────────────── ③ 因果对照 ────────────────────────────────

test('③ 因果对照：把那条 input/requeued 拿掉 ⇒ **除了当轮输入那一格，两次渲染逐字节相同**', () => {
  const { after, wake } = sceneWithRequeue();
  const withoutRequeue = after.filter((e) => e.type !== 'input/requeued');
  assert.equal(withoutRequeue.length, after.length - 1, '确实摘掉了一条');

  const historyWith = frozenOf(render(renderWith(after, wake)));
  const historyWithout = frozenOf(render(renderWith(withoutRequeue, wake)));

  // 差异**恰好**是那一格的两个字：把标记摘掉之后两次渲染必须逐字节相同
  assert.equal(historyWith.length, historyWithout.length, '两次渲染的条数该一样（只差标记两个字）');
  const normalized = historyWith.map((line) => line.replace(' · 重投', ''));
  assert.deepEqual(normalized, historyWithout, '除那两个字以外，一个字节都不许差');
  // 而"当轮输入那一格"正是差异所在（这条对照才有意义）
  const marked = historyWith.filter((line) => line.includes('重投'));
  assert.equal(marked.length, 1, '有 requeue 时当轮输入带标记');
  assert.deepEqual(historyWithout.filter((line) => line.includes('重投')), [], '没有 requeue 时一个字都不该有');
});

// ──────────────────────────────── ④ 真数据回归（现场那一对拍） ────────────────────────────────

const EVENT_DIR = join('data', 'events');

interface Located { turn: number; step: number }

/**
 * 在真日志里找一对"现场拍"：某个 turn 的第一次请求之后，有一条 `input/requeued`
 * 盖住了**那一轮认领过的 wake**（= 追溯改写的现场）。找不到就给 null。
 *
 * 判据与 `_research` 那次归因同一把尺子：requeue 的 seq 落在"那一轮的 step/start"之后。
 * **从最近的往回想**：老的那些现场可能已经被后来的压缩遮蔽（遮蔽点前的 item 不再渲染），
 * 拿它当回归对象会得到"本来就没有前缀"的假失败。
 */
function findRetroRequeueScene(events: readonly AppEvent[]): { victim: Located; next: Located } | null {
  const stepStarts = events.filter((e) => e.type === 'step/start');
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type !== 'input/requeued') continue;
    for (const wakeSeq of event.data.wakeSeqs) {
      const owner = stepStarts.find((s) => s.seq > wakeSeq && s.seq < event.seq);
      if (owner === undefined) continue;
      const turn = owner.data.turn;
      const next = stepStarts.find((s) => s.seq > event.seq && s.data.turn !== turn);
      if (next === undefined) continue;
      return { victim: { turn, step: 1 }, next: { turn: next.data.turn, step: next.data.step } };
    }
  }
  return null;
}

function readAllEvents(): AppEvent[] {
  const out: AppEvent[] = [];
  for (const file of readdirSync(EVENT_DIR).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(EVENT_DIR, file), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as AppEvent);
      } catch { /* 坏行跳过：与 CLI 的读法一致 */ }
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * 全部"追溯改写"的候选现场（**新的在前**）。
 *
 * 为什么要一串而不是一个：老的那些现场可能已经被**后来的压缩**遮蔽（遮蔽点前的 item
 * 不再渲染）——拿它当回归对象只会得到"本来就没有前缀"的假失败。所以调用方从新往旧试，
 * 取第一个**真的还有前缀**的（判据在用例里：前缀条数 > 10）。
 */
function retroRequeueScenes(events: readonly AppEvent[]): Array<{ victim: Located; next: Located }> {
  const stepStarts = events.filter((e) => e.type === 'step/start');
  const found: Array<{ victim: Located; next: Located }> = [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type !== 'input/requeued') continue;
    for (const wakeSeq of event.data.wakeSeqs) {
      const owner = stepStarts.find((s) => s.seq > wakeSeq && s.seq < event.seq);
      if (owner === undefined) continue;
      const turn = owner.data.turn;
      const next = stepStarts.find((s) => s.seq > event.seq && s.data.turn !== turn);
      if (next === undefined) continue;
      found.push({ victim: { turn, step: 1 }, next: { turn: next.data.turn, step: next.data.step } });
    }
  }
  return found;
}

test('④ 真数据回归：现场那一拍，删掉那条 input/requeued 之后**前缀逐字节相同**', async (t) => {
  if (!existsSync(EVENT_DIR)) {
    t.skip(`没有 ${EVENT_DIR}（运行数据不在版本库里）——这条用例在真实工作区上才有意义`);
    return;
  }
  const events = readAllEvents();
  const scenes = retroRequeueScenes(events);
  if (scenes.length === 0) {
    t.skip('这份日志里已经找不到"追溯改写"的现场——用例跳过而不是假绿');
    return;
  }

  const persona = loadPersona('data');
  const tools = (await catalogToolSpecs('data')).specs;
  /** 走**生产那条重建路**（CLI `replay` 与界面预览共用它），而不是在用例里另拼一份 */
  const renderAt = (stream: readonly AppEvent[], turn: number, step: number): string[] | null => {
    const located = locateStep(stream, turn, step);
    if (!located.ok) return null;
    const request = rebuildRenderedRequest(located, {
      persona: {
        identity: persona.identity, constitution: persona.constitution, style: persona.style,
        state: persona.state, personaHash: persona.personaHash, relationship: null,
      },
      tools,
      timezone: 'Asia/Shanghai',
    });
    return frozenOf(request);
  };

  /**
   * 判据（**在受害那一拍自己身上**做因果对照，不跨轮比）：
   * 把那条追溯改写它的 `input/requeued` 从事件流里删掉，同一拍的**前缀必须逐字节相同**。
   *
   * 为什么不跨轮比（第一版就是这么写的，假红）：
   *   • 轮与轮之间隔着"本该出现的新输入"，多唤醒的轮次里 `locateStep.wakeEvent` 只挑一条
   *     —— 另一条会以历史形态渲染，于是 item 列表天然错位一格；
   *   • 而且现场可能已被后来的压缩遮蔽（老的那些就是这样）。
   *   两条都会让"前缀被改写"与"本来就该多一条"混在一起——那正是这条用例要分开的两种情形。
   */
  let hits = 0;
  let usedTurn: number | null = null;
  for (const scene of scenes.slice(0, 40)) {
    // 找出"盖住这一拍那条 wake"的 requeue 事件：它的 seq 落在该拍第一个 step/start 之后
    const stepStart = events.find(
      (e) => e.type === 'step/start' && e.data.turn === scene.victim.turn && e.data.step === scene.victim.step,
    );
    if (stepStart === undefined) continue;
    const culprit = events.find((e) => e.type === 'input/requeued' && e.seq > stepStart.seq);
    if (culprit === undefined) continue;

    const withIt = renderAt(events, scene.victim.turn, scene.victim.step);
    const withoutIt = renderAt(
      events.filter((e) => e.seq !== culprit.seq),
      scene.victim.turn,
      scene.victim.step,
    );
    if (withIt === null || withoutIt === null) continue;
    if (withIt.length <= 10) continue; // 前缀已被压缩遮蔽：换下一个现场

    hits += 1;
    usedTurn = scene.victim.turn;
    assert.deepEqual(
      withIt,
      withoutIt,
      `真数据回归：turn ${scene.victim.turn} 的前缀被 seq ${culprit.seq} 那条 input/requeued 改写了`,
    );
    assert.deepEqual(
      withIt.filter((line) => line.includes('重投')),
      [],
      `turn ${scene.victim.turn} 的历史里不该再有"重投"字样（它只属于当轮输入）`,
    );
    break;
  }

  if (hits === 0) {
    t.skip(`找到 ${scenes.length} 个现场，但它们的前缀都已被后来的压缩遮蔽——跳过而不是假绿`);
    return;
  }
  console.log(`[mcp-index] 真数据回归：turn ${usedTurn} 的前缀在删掉那条 requeue 前后逐字节相同`);
});
