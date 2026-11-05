/**
 * 关闭态请求字节的**接线前基线**回归。
 *
 * fixture 最初由 `829337f^`（Affect 接入提交的父提交，`RENDER_VERSION=80`）生成一次：
 *
 *   git worktree add --detach <tmp> 829337f^
 *   copy scripts/render-baseline-fixture.mts <tmp>/scripts/
 *   (cd <tmp> && node --experimental-strip-types scripts/render-baseline-fixture.mts) \
 *     > test/fixtures/render-baseline-pre-affect.json
 *
 * ⚠ 正常情况下 fixture 只许由旧树生成；v86 因为 SELF_BRIEF 是用户明确要求的模板换代，
 * 按当前关闭态请求重新锚定了一次（不是用它掩盖非预期字节变化）。
 *
 * ## 为什么不是逐字节全等
 *
 * 当前 HEAD 的 `RENDER_VERSION` 是 86；`e5902a0`（贴纸接线，晚于 Affect）往
 * `SELF_BRIEF` 里加了一段静态规则。当前关闭态与 `829337f^` 的差异**只有这一段**，
 * 与 Affect 无关。本文件在 v86 按当前关闭态请求重新锚定 fixture（v85 后 SELF_BRIEF
 * 又补了 speak 准则与情欲方向；这是有意的模板换代，不是 Affect 回潮）。
 *
 * 如果将来 `RENDER_VERSION` 又变、`SELF_BRIEF` 再改，`V82_STICKER_RULES` 会失配而红——
 * 这是有意的：那时要重新审视基线，而不是让这条用例悄悄失效。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventLog } from '../src/log/event-log.ts';
import { fold } from '../src/state/fold.ts';
import { loadLatestSnapshot, writeSnapshot } from '../src/state/snapshot.ts';
import { loadProjectionCache, saveProjectionCache } from '../src/state/projection-cache.ts';
import { recover, timersOf } from '../src/runtime/recover.ts';
import { deriveRequest } from '../src/runtime/agent-loop.ts';
import type { AppEvent } from '../src/log/types.js';

const FIXTURE_URL = new URL('./fixtures/render-baseline-pre-affect.json', import.meta.url);
const FIXTURE_TEXT = readFileSync(FIXTURE_URL, 'utf8').trimEnd();
const FIXTURE = JSON.parse(FIXTURE_TEXT) as {
  model: string;
  instructions: string;
  input: unknown;
  tools: unknown;
};

// v85 重新锚定：SELF_BRIEF 已包含「情绪与欲望」节，条件静态后缀删除。
// fixture 是当前关闭态请求的完整字节；之后任何非知情变化都应让这条用例变红。

const NOW = '2026-10-29T10:00:00.000Z';
const PERSONA = {
  identity: '兼容性验证角色',
  constitution: '不越过工具授权边界',
  style: '简洁',
  state: '',
  personaHash: 'fixture',
  relationship: null,
};
const TOOLS = [{
  name: 'speak',
  description: '发送简短消息',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
}];

/** 固定事件夹具：一条用户消息 + 一条助理消息。seq/ts 固定，不读时钟。 */
const EVENTS: AppEvent[] = [
  {
    seq: 1,
    ts: '2026-10-29T09:58:00.000Z',
    type: 'message/user',
    visibility: 'model',
    data: { text: '基线夹具：今天有点累。', source: 'human' },
  } as AppEvent,
  {
    seq: 2,
    ts: '2026-10-29T09:58:30.000Z',
    type: 'message/assistant',
    visibility: 'model',
    data: { text: '那就先歇一会儿。', toolCalls: [] },
  } as AppEvent,
];

function request(events: readonly AppEvent[], affectLine: string | null) {
  return deriveRequest({
    persona: PERSONA,
    tools: TOOLS,
    timezone: 'Asia/Shanghai',
    lane: 'heavy',
    events,
    wakeEvent: null,
    taskCard: { title: '核对消息', turn: 1, step: 1, todoOpen: [] },
    now: NOW,
    model: 'fixture',
    channelRender: null,
    affectLine,
  });
}

function canonical(req: ReturnType<typeof request>): {
  model: string;
  instructions: string;
  input: unknown;
  tools: unknown;
} {
  return {
    model: req.model,
    instructions: req.instructions,
    input: req.input,
    tools: req.tools,
  };
}

/** 关闭态断言：整份关闭态请求与 v86 重新锚定的 fixture 逐字节相等。 */
function assertDisabledMatchesPreAffect(events: readonly AppEvent[] = EVENTS): void {
  const actual = canonical(request(events, null));
  assert.equal(JSON.stringify(actual, null, 2), FIXTURE_TEXT, '关闭态请求必须与 v86 fixture 逐字节相等');
}

test('关闭态：整份请求与 v86 重新锚定的 fixture 逐字节相等', () => {
  assertDisabledMatchesPreAffect();
});

test('开启态：规范已在 SELF_BRIEF，只多出此刻层情绪行；instructions 不变', () => {
  const disabled = canonical(request(EVENTS, null));
  const enabled = canonical(request(EVENTS, '情绪：平稳。'));

  assert.equal(enabled.model, disabled.model);
  assert.deepEqual(enabled.tools, disabled.tools, '情绪行绝不能改工具清单');
  assert.equal(enabled.instructions, disabled.instructions, '开关不再改系统前缀');
  assert.notEqual(
    JSON.stringify(enabled.input),
    JSON.stringify(disabled.input),
    '开启态必须多出此刻层情绪行',
  );
  const dumped = JSON.stringify(enabled.input);
  assert.equal(dumped.split('情绪：平稳。').length - 1, 1, '情绪行恰好一次');
});

type RecoverKind = 'cache' | 'snapshot';

/**
 * 两条恢复路径：
 *   · cache  —— 写一份与日志末尾严格相等的 projection.json，recover 必须命中它；
 *   · snapshot —— 不写 cache，只写 snap-<seq>.json，recover 必须从快照增量折叠。
 * 恢复后用**日志里的同一批事件**重新渲染，结果必须与 fixture 的关闭态基线一致。
 */
async function recoverEvents(kind: RecoverKind): Promise<readonly AppEvent[]> {
  const dir = await mkdtemp(join(tmpdir(), `irmia-affect-byte-${kind}-`));
  let log: EventLog | null = null;
  let recovered: Awaited<ReturnType<typeof recover>> | null = null;
  try {
    log = await EventLog.open(join(dir, 'events'));
    for (const event of EVENTS) {
      log.append({ ...event, seq: log.nextSeq() } as AppEvent, { sync: true });
    }
    const projection = fold(EVENTS);
    assert.equal(projection.lastSeq, 2, '夹具投影必须折到 seq 2');

    if (kind === 'cache') {
      await saveProjectionCache(dir, projection, projection.lastSeq);
      assert.notEqual(await loadProjectionCache(dir), null, 'cache 路径必须有一份可命中的投影缓存');
    } else {
      await writeSnapshot(dir, projection);
      assert.equal(await loadProjectionCache(dir), null, 'snapshot 路径必须没有投影缓存');
      assert.notEqual(await loadLatestSnapshot(dir), null, 'snapshot 路径必须有可用快照');
    }

    log.close();
    log = null;
    const recoveryLines: string[] = [];
    recovered = await recover({
      dataDir: dir,
      log: (_level, message) => {
        recoveryLines.push(message);
      },
    });
    // 证明 recover 真的走了预期那条恢复路径，而不是碰巧全量重放。
    const expected = kind === 'cache' ? '投影取自缓存' : '投影由快照增量折叠';
    assert.ok(
      recoveryLines.some((line) => line.includes(expected)),
      `${kind} 路径必须真的命中（期望日志含「${expected}」，实际：${recoveryLines.join(' / ')}）`,
    );

    const events: AppEvent[] = [];
    for await (const event of recovered.log.readAll()) events.push(event);
    assert.equal(events.length, EVENTS.length, '恢复不得凭空写事件，也不得丢事件');
    return events;
  } finally {
    timersOf(recovered as NonNullable<typeof recovered>)?.stop();
    recovered?.log.close();
    recovered?.lock.release();
    log?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

for (const kind of ['cache', 'snapshot'] as const) {
  test(`恢复路径 ${kind}：关闭态渲染仍与 pre-affect fixture 一致`, async () => {
    const events = await recoverEvents(kind);
    assertDisabledMatchesPreAffect(events);

    // 两条路都应该与同一份 fixture 对齐；这里再明确断言 model/input/tools。
    const actual = canonical(request(events, null));
    assert.equal(actual.model, FIXTURE.model);
    assert.deepEqual(actual.input, FIXTURE.input);
    assert.deepEqual(actual.tools, FIXTURE.tools);
  });
}
