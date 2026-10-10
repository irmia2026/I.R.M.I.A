/**
 * **重投一条已经被折叠的通报** —— 2026-10-10 那次整段前缀失守的真因与守卫（v50）。
 *
 * ──────────────────────────── 现场（逐项对照 1245/14 与 1246/1） ────────────────────────────
 *
 * 本机 03:17:50 那一拍：`input=54396 / cacheHit=16512 / cacheMiss=37884`（几乎全 miss），
 * 日志自己的判词是 `cacheBreak.class='history' / cause='unattributable'`
 * ——"指纹变了，但两次调用之间没有任何能解释它的事件"。
 *
 * 真因**不是**某条事件的字节被改写，而是**多了一条一模一样的通报**：
 *   · turn 1245 认领了 `wake/manual`（**上下文压缩通报**，seq 72233）并把它递了出去；
 *   · turn 1245 以 `human/asked` 挂起；
 *   · 之后一次压缩把 seq 72233 **折进了摘要**（遮蔽点 72430）；
 *   · 人答复到达 ⇒ `settleHumanSuspension` 写 `input/requeued{human-answered}`，
 *     把那条**已经被折掉**的通报重新入队 ⇒ 它作为 turn 1246 的当轮输入**又插了一遍**
 *     （插在历史中间）⇒ **它之后的一切错位** ⇒ 前缀整段失守。
 *
 * ──────────────────────────── 判据（一处），与它带来的行为 ────────────────────────────
 *
 * `real-loop.settleHumanSuspension`：把"重投"按它进那一轮的位置分两类——
 *   · `seq < 该轮 turn/start` ⇒ 上一拍**已经递到她眼前**的那条输入；
 *   · 其余 ⇒ 本轮进行中才插进来的插话（还没被递过）。
 * 只有前一类才再问一句"它还在吗"：**`seq <= 遮蔽点` ⇒ 已被折进摘要 ⇒ 不许再插一条**。
 *
 * 于是本文件钉的正是"**她眼前那个包裹出现几次**"：
 *   · 被折掉的那条**不再回队列**（`input/requeued` 不写、也不会有第二次投递）；
 *   · **没被折掉的照旧重投**（重启打断 / 整轮失败那两条路要的正是"再给她一次机会"），
 *     它仍然是"第一次递给她"——不多不少一条。
 *
 * ──────────────────────────── 这条用例为什么能守住 ────────────────────────────
 *
 * 它**在缺陷状态下必须是红的**（本文件落地时实测过：把过滤去掉，下面第 ① 条立刻红）。
 * 用的是**真 `RealLoop` 台子**（真 EventLog、真 fold、真 agent-loop、真 render、真 tick，
 * 只有模型是假的）⇒ 走的是生产那条投递链，不是渲染层的替身。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { makeRealWakeRig } from './fixtures/real-wake-rig.ts';
import type { RealWakeRig } from './fixtures/real-wake-rig.ts';

/** 通报里的**哨兵**：数它在请求里出现几次，就是"这个包裹递了几遍" */
const MARKER = '压缩通报哨兵-7391';

const NOTE = `【框架通报 · 上下文压缩】${MARKER}：压过了，接着做。`;

/** 请求体里那段冻结的内容（长期记忆层 + 历史 + 本轮新输入）拼成一份文字 */
function inputText(rig: RealWakeRig, index: number): string {
  const request = rig.requests[index];
  assert.ok(request !== undefined, `第 ${index} 次请求存在`);
  const items = request.request.input;
  const list = Array.isArray(items) ? items : [];
  return list
    .map((item) => {
      const content = (item as { content?: unknown }).content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.map((part) => String((part as { text?: unknown }).text ?? '')).join('\n');
      }
      return JSON.stringify(item);
    })
    .join('\n');
}

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

/**
 * 造现场：一条通报 + 一次人审挂起 + 答复。
 *
 * `folded` = 要不要在挂起**之前**先把它折进摘要（`coveredUpToSeq` 盖住它）。
 *   · `true`  ⇒ 复刻现场：递过、折掉、答复后**不该再递**
 *   · `false` ⇒ 对照组（重启打断 / 整轮失败那两条路的形状）：该照旧重投
 *
 * 挂起线索靠 `scanSuspension` 从日志重建（`turn/start` → `input/claimed` → `human/asked`
 * → `turn/end{blocked}`），所以这里**不碰 RealLoop 的内存**，全部走事件。
 */
async function sceneHumanSuspension(folded: boolean): Promise<{ rig: RealWakeRig; noteSeq: number }> {
  const rig = await makeRealWakeRig({ stream: [{ text: '' }, { text: '' }, { text: '' }] });
  const note = rig.append('wake/manual', { note: NOTE });
  if (folded) {
    rig.append('compaction/summary', {
      coveredUpToSeq: note.seq,
      summary: '（这一轮之前的往来已经折进摘要）',
    });
  }
  rig.append('turn/start', { turn: 1 });
  rig.append('input/claimed', { turn: 1, wakeSeqs: [note.seq], claimCounts: [1] });
  rig.append('human/asked', { question: '这份要外传吗', context: '', turn: 1 });
  rig.append('turn/end', { turn: 1, reason: { kind: 'blocked', by: 'ask-human' }, spoke: false });
  rig.append('human/answered', { question: '这份要外传吗', answer: '不外传', by: 'human' });
  return { rig, noteSeq: note.seq };
}

test('① 已被折叠的通报**不再重投**：不写 input/requeued，也没有第二次投递', async (t) => {
  const { rig, noteSeq } = await sceneHumanSuspension(true);
  t.after(rig.dispose);

  await rig.tick();

  const events = await rig.events();
  const requeued = events.filter((event) => event.type === 'input/requeued');
  assert.deepEqual(
    requeued.map((event) => (event.type === 'input/requeued' ? event.data.wakeSeqs : [])),
    [],
    `被折掉的那条（seq ${noteSeq}）不该再回队列——回队列它就作为当轮输入又插一遍，`
    + '而她眼前那个包裹于是出现两遍（现场 miss=37884 的成因）',
  );
  // 队列里没有别的输入 ⇒ 这一拍**不起 turn**（不写请求）就是对的：那条通报已经没意义了
  assert.equal(rig.requests.length, 0, '没有可投递的输入时不该白发一次请求');
});

test('② 对照：**没被折叠**的输入照旧重投（重启打断 / 整轮失败那条路不受影响）', async (t) => {
  const { rig, noteSeq } = await sceneHumanSuspension(false);
  t.after(rig.dispose);

  await rig.tick();

  const events = await rig.events();
  const requeued = events
    .filter((event) => event.type === 'input/requeued')
    .flatMap((event) => (event.type === 'input/requeued' ? event.data.wakeSeqs : []));
  assert.deepEqual(requeued, [noteSeq], '没被折掉的那条必须照旧回队列（"再给她一次机会"）');

  // 它被真的递出去了（这一拍起了 turn），而且她确实看得见那条通报
  assert.ok(rig.requests.length >= 1, '回队列之后这一拍该起一个 turn');
  const text = inputText(rig, rig.requests.length - 1);
  assert.ok(countOf(text, MARKER) >= 1, '那条通报必须在她这一拍的请求里（重投真的到了）');
});
