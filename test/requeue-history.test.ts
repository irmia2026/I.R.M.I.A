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
 * ④ **因果对照（自己造的事件流，真 RealLoop 台子）**：台子跑出一拍真事件（模型那一拍整轮失败 ⇒
 *    agent-loop 真的写一条 `input/requeued{turn-error}`，它落在这一拍的 `step/start` **之后**），
 *    再走**生产那条重建路**（`rebuildRenderedRequest`）：把那条 requeue 从事件流里删掉 ⇒
 *    这一拍的请求**逐字节相同**。
 *    ⚠ 这一条原来读**真 `data/events`** 并做**全行子串匹配**"重投"⇒ 现场一变就假红
 *    （她自己的文本里就有那两个字，2026-10-11 已发生）。取数方式换成台子，**判据一个字没放宽**。
 *
 * **没实测的**：这一改对 cacheHit 的实际改善没有实测——本次现场那次 miss 的主因是上面
 * 那条"插入"，修完它**不会**消失。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultVisibility, type AppEvent } from '../src/log/types.ts';
import { NOW_LAYER_BANNER, inputContentText, render, type InputItem, type RenderInput } from '../src/model/render.ts';
import { locateStep, rebuildRenderedRequest } from '../src/runtime/replay.ts';
import { makeRealWakeRig } from './fixtures/real-wake-rig.ts';

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
// ──────────────────────────────── ④ 因果对照（自己造的事件流） ────────────────────────────────

/**
 * 台子跑一拍、把日志读回来。
 *
 * 为什么用**真 RealLoop 台子**而不是手搓事件：这一条钉的是"一条**后来的** requeue 不许改写
 * 更早那一拍的请求字节"，而"requeue 落在哪一拍"这件事该由**真循环**决定——agent-loop 在整轮
 * 失败时把认领过的输入退回队列（`input/requeued{turn-error}`）。手搓那份事件流等于把这个前提
 * 当成假设写进用例；台子跑出来的才是既成事实（实测：wake seq 1 → step/start seq 8 →
 * input/requeued seq 11）。
 */
test('④ 一条**后来的** requeue 不改写更早那一拍的请求字节（真台子 + 生产重建路）', async (t) => {
  const rig = await makeRealWakeRig({
    // 这一拍整轮失败（模型抛）⇒ agent-loop 走"输入退回队列"那条真路
    stream: [{ throws: new Error('测试替身：这一拍整轮失败（服务端 400 的等价物）') }],
  });
  t.after(rig.dispose);

  const wake = rig.append('wake/manual', {
    note: '【框架通报 · 上下文压缩】turn 1244 刚做过一次上下文压缩。手上没做完的事接着做。',
  });
  await rig.tick();

  const events: AppEvent[] = [];
  for await (const event of rig.log.readAll()) events.push(event);

  const requeue = events.find((event) => event.type === 'input/requeued');
  assert.ok(requeue !== undefined, '前提：整轮失败必须写 input/requeued（否则这条用例什么都没测到）');
  assert.deepEqual(requeue!.data.wakeSeqs, [wake.seq], '前提：退回的正是这一拍认领的那条输入');
  const stepStart = events.find((event) => event.type === 'step/start' && event.data.turn === 1);
  assert.ok(stepStart !== undefined, '前提：这一拍真的起了 step（请求重建得起来）');
  assert.ok(
    stepStart!.seq < requeue!.seq,
    '前提：那条 requeue 落在**这一拍的 step/start 之后**（"后来的"是这条用例的全部张力）',
  );

  /** 走**生产那条重建路**（CLI `replay` 与界面预览共用它），而不是在用例里另拼一份 */
  const renderTurn1 = (stream: readonly AppEvent[]): string[] | null => {
    const located = locateStep(stream, 1, 1);
    if (!located.ok) return null;
    const request = rebuildRenderedRequest(located, {
      persona: {
        identity: 'ID', constitution: 'CO', style: 'ST', state: 'STATE',
        personaHash: 'p', relationship: null,
      },
      tools: [],
      timezone: 'Asia/Shanghai',
    });
    return frozenOf(request);
  };

  const withIt = renderTurn1(events);
  const withoutIt = renderTurn1(events.filter((event) => event.seq !== requeue!.seq));
  assert.ok(withIt !== null && withoutIt !== null, '两边的请求都该重建得起来');
  assert.ok(withIt!.length > 0, '这一拍的请求里得有冻结那一段（否则下面的断言什么都没测到）');
  assert.ok(
    withIt!.some((line) => line.includes('【框架通报 · 上下文压缩】')),
    '前提：这条 wake 真的进了这一拍的请求',
  );

  // ★ 判据本体（一个字没放宽）：删掉那条**后来的** requeue ⇒ 这一拍的请求**逐字节相同**
  assert.deepEqual(
    withIt,
    withoutIt,
    '一条后来的 input/requeued 改写了更早那一拍的请求字节（那一刻它还不存在）',
  );

  // 标记那一格：认**标记的形态**（` · 重投] `），不认"重投"那两个字——她自己的文本里也会有
  // 那两个字（旧版用例就是栽在全行子串匹配上：真 data/ 一变就假红）。
  // 这一格为什么钉得住 v49 那个毛病：这条 wake 在这一拍**已经落在历史那一侧**
  // （实测：这一拍重建出来是 `[界面消息] 【框架通报 …】…`），而 v49 之前历史那一侧拿的是
  // **全量重算**出来的重投集合 ⇒ 一条后来的 requeue 会给它补上 ` · 重投`，字节当场变。
  assert.deepEqual(
    withIt!.filter((line) => line.includes(' · 重投] ')),
    [],
    '那一拍渲染时这条 requeue 还没发生 ⇒ 历史那一侧一个字都不许被补上',
  );
});
