/**
 * **只用于从旧树生成一次** `test/fixtures/render-baseline-pre-affect.json`。
 *
 * 用法（必须在一份 `829337f^` 的 worktree 里跑；当前树会被 RENDER_VERSION 守卫拒绝）：
 *
 *   git -C <repo> worktree add --detach <tmp> 829337f^
 *   copy scripts/render-baseline-fixture.mts <tmp>/scripts/
 *   cd <tmp>
 *   node --experimental-strip-types scripts/render-baseline-fixture.mts \
 *     > <repo>/test/fixtures/render-baseline-pre-affect.json
 *
 * 为什么必须用旧树：这份 fixture 是「接线前」的字节基线。用当前树生成再让新树去比，
 * 就是把测试变成自比，永远绿、也永远证明不了什么。
 *
 * 夹具（events/persona/tools/time）必须与 `test/affect-byte-baseline.test.ts` 一字不差；
 * 改这里就要重新生成 fixture 并重新审视基线。
 */
import {deriveRequest} from '../src/runtime/agent-loop.ts';
import {RENDER_VERSION} from '../src/model/render.ts';

if (RENDER_VERSION !== '80') {
  throw new Error(`请只在 829337f^（RENDER_VERSION=80）的 worktree 里生成 fixture；当前是 ${RENDER_VERSION}`);
}

const events = [
  {
    seq: 1,
    ts: '2026-10-29T09:58:00.000Z',
    type: 'message/user',
    visibility: 'model',
    data: {text: '基线夹具：今天有点累。', source: 'human'},
  },
  {
    seq: 2,
    ts: '2026-10-29T09:58:30.000Z',
    type: 'message/assistant',
    visibility: 'model',
    data: {text: '那就先歇一会儿。', toolCalls: []},
  },
] as const;

const request = deriveRequest({
  persona: {
    identity: '兼容性验证角色',
    constitution: '不越过工具授权边界',
    style: '简洁',
    state: '',
    personaHash: 'fixture',
    relationship: null,
  },
  tools: [{
    name: 'speak',
    description: '发送简短消息',
    parameters: {type: 'object', properties: {text: {type: 'string'}}},
  }],
  timezone: 'Asia/Shanghai',
  lane: 'heavy',
  events,
  wakeEvent: null,
  taskCard: {title: '核对消息', turn: 1, step: 1, todoOpen: []},
  now: '2026-10-29T10:00:00.000Z',
  model: 'fixture',
  channelRender: null,
} as Parameters<typeof deriveRequest>[0]);

const canonical = {
  model: request.model,
  instructions: request.instructions,
  input: request.input,
  tools: request.tools,
};
process.stdout.write(`${JSON.stringify(canonical, null, 2)}\n`);
