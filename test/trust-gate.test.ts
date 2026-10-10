/**
 * `trust` 门**接上线**的判据（v44）——修的是 `docs/mcp-chain-review.md` 的第 1 条。
 *
 * 修之前的形状（"文档写着有门、代码里没有"）：
 *   · `modelVisibilityFor()`（`src/runtime/trust.ts`，外部轮次 ⇒ 严格白名单四件）在 `src/**` 里
 *     **零调用点**——唯一消费它的是 `test/trust.test.ts`；
 *   · 生产传的是 `real-loop.ts` 里恒为 `{ includeDestructive: 配置 }` 的那一份 ⇒ **群里任何人
 *     @ 她的那一轮，`mcp` 出现在工具清单里、也调得动**，而 config 现状 `destructiveEnabled: true`
 *     ⇒ MCP 侧所有破坏性工具在这条路上放行。
 * 修之后：`modelVisibilityFor(trust, 配置)` 是唯一入口，`tools` 段按信任级分档。
 *
 * 三条判据（对应下面三组用例）：
 *   ① **入口那一层**：生产口径的注册表 + 外部档 ⇒ 清单里**没有** `mcp`；owner 档有
 *   ② **真链路**：假通道造一条群消息 → 真 RealLoop → 假模型记请求体 —— 那一轮的工具清单里没有 `mcp`
 *   ③ **同一个台子上**：用户/GUI 唤醒那一轮**有** `mcp`；`trusted`（记过名字的熟人）那一档
 *      没有 destructive、但仍有 `mcp`
 *
 * 为什么必须走真链路（而不是只断言 `listForModel`）：接线**正是最容易漏的那一步**——这次修的
 * 就是"函数写好了、没人调"。只断言函数本身，等于把当初那个 bug 重演一遍。
 *
 * 说明：Node 的类型剥离不做 `.js` → `.ts` 映射，所以这里用显式 `.ts` 说明符导入源码。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EXTERNAL_TOOL_ALLOWLIST, modelVisibilityFor } from '../src/runtime/trust.ts';
import { buildCatalogRegistry } from '../src/tools/catalog.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { makeRealWakeRig } from './fixtures/real-wake-rig.ts';

/** 台子上那批工具：白名单四件 + `mcp` + 两件 destructive（`pwsh` / `publish` 的角色）+ 一件只读 */
const RIG_TOOLS = [
  { name: 'speak' },
  { name: 'report' },
  { name: 'read_channel' },
  { name: 'vision_read' },
  { name: 'mcp' },
  { name: 'pwsh', sideEffect: 'destructive' as const },
  { name: 'publish', sideEffect: 'destructive' as const },
  { name: 'safe_read' },
];

/** 群聊唤醒（形状与 `channel/qq-official.ts` 归一化后的 `WakeChannel` 一致，字段只填判据用到的） */
const GROUP_WAKE = {
  channel: 'qq-official',
  chatType: 'group',
  chatId: 'G001',
  person: 'STRANGER_OPENID_A',
  text: '弥亚在吗，帮我跑个命令',
  messageId: 'msg-trust-gate-1',
  msgSeq: 1,
  mentionsMe: true,
};

/** 注入判定的回包（`wake/channel` 的每一轮都会先判一次，见 real-loop 的 judgeChannelWakes） */
const NO_RISK = '{"risky":false,"reason":"普通请求，没有指挥她的迹象","quotes":[]}';

/** 假模型收到的那一次 heavy 请求里的工具名（顺序就是请求体里的顺序） */
function toolNamesOf(rig: Awaited<ReturnType<typeof makeRealWakeRig>>): string[] {
  const heavy = rig.requests.find((item) => item.lane === 'heavy');
  assert.ok(heavy !== undefined, '她那一拍该发一次 heavy 请求（否则下面比的是空）');
  return (heavy.request.tools ?? []).map((tool) => tool.name);
}

// ──────────────────────────── ① 入口那一层：真注册表 ────────────────────────────

test('① 生产口径的注册表：外部档看不到 `mcp`，用户档看得见', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'irmia-trust-gate-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 }));

  const { registry } = await buildCatalogRegistry({
    dataDir,
    timers: new TimerStore({ dir: dataDir, fire: () => {} }),
    emit: () => {},
    destructiveEnabled: true,
    // 生产口径的接线（`main.ts` 那两句原样）：**不给池 registry**，入口只接到这几个方法上。
    // 这一条测的是"清单里有没有 `mcp`"，不是"能不能调通"——调通那条路在 `mcp-entry.test.ts`。
    mcpClient: {
      status: () => [],
      listTools: async () => [],
      callTool: async () => ({ content: '' }),
      resolveAttributes: () => ({ sideEffect: 'destructive' }),
    },
    mcpDestructiveEnabled: () => true,
    blobOffload: { dataDir },
  });
  assert.ok(registry.names().includes('mcp'), '`mcp` 必须在注册表里（否则下面两条断言什么也没锁）');

  const owner = registry.listForModel(modelVisibilityFor('owner', true)).map((spec) => spec.name);
  assert.ok(owner.includes('mcp'), '用户/她自己那一档：`mcp` 照旧在（与 v43 逐字节相同）');
  assert.ok(owner.includes('pwsh'), '配置把 destructive 全开时，用户档也照旧看得见 `pwsh`');

  const external = registry.listForModel(modelVisibilityFor('external', true)).map((spec) => spec.name);
  assert.equal(external.includes('mcp'), false,
    '外部轮次（群里任何人 @ 她）**不许**看见 `mcp`：它是本机类能力的入口，白名单里没有它');
  assert.equal(external.includes('pwsh'), false, '外部轮次同样不许看见 `pwsh`');
  assert.equal(external.includes('safe_read'), false,
    '白名单是**严格白名单**而不是"非 destructive 的那些"：`safe_read` 能读 MEMORIES/ 里关于用户的事');
  for (const name of EXTERNAL_TOOL_ALLOWLIST) {
    if (registry.names().includes(name)) assert.ok(external.includes(name), `白名单那件 ${name} 必须在`);
  }
});

// ──────────────────────────── ② 真链路：群聊那一轮 ────────────────────────────

test('② 真链路：群里有人 @ 她 ⇒ 那一轮的请求体里**没有** `mcp`', async (t) => {
  const rig = await makeRealWakeRig({
    registerTools: RIG_TOOLS,
    generate: [{ outputItems: [{ type: 'message', text: NO_RISK }] }],
    stream: [{ text: '', toolCalls: [] }],
  });
  t.after(rig.dispose);

  rig.append('wake/channel', GROUP_WAKE);
  await rig.tick();

  const names = toolNamesOf(rig);
  assert.equal(names.includes('mcp'), false,
    `群聊那一轮的 tools 段里不许有 \`mcp\`（实际：${names.join('、')}）`);
  assert.equal(names.includes('pwsh'), false, '`pwsh` 同样不该出现');
  assert.deepEqual(names, [...EXTERNAL_TOOL_ALLOWLIST],
    '外部轮次能看到的**只有**白名单那四件，顺序也与白名单一致（它是严格白名单，不是"少给几件"）');
});

// ──────────────────────────── ③ 真链路：用户 / 熟人 ────────────────────────────

test('③ 真链路：用户（GUI/手动唤醒）那一轮 `mcp` 仍在 —— 收窄只发生在外人那几档', async (t) => {
  const rig = await makeRealWakeRig({
    registerTools: RIG_TOOLS,
    stream: [{ text: '', toolCalls: [] }],
    // 与 ② 那一轮**同一份配置**：destructive 全开。两个用例的差别只有"谁唤醒的"这一格——
    // 用户在同一份配置下看得见 `pwsh`，群里的人看不见。这正是这次要钉的那件事。
    patchConfig: (config) => { config.tools.destructiveEnabled = true; },
  });
  t.after(rig.dispose);

  rig.append('wake/manual', { note: '帮我看一眼 MCP' });
  await rig.tick();

  const names = toolNamesOf(rig);
  assert.ok(names.includes('mcp'), `用户那一轮必须看得见 \`mcp\`（实际：${names.join('、')}）`);
  assert.ok(names.includes('pwsh'), '配置里 destructive 全开 ⇒ 用户那一轮也看得见 `pwsh`（与 ② 同一份配置）');
  assert.ok(names.includes('safe_read'));
});

test('③b 真链路：`trusted`（单聊里的熟人）= "没有 destructive"那一档，但仍有 `mcp`', async (t) => {
  const rig = await makeRealWakeRig({
    registerTools: RIG_TOOLS,
    generate: [{ outputItems: [{ type: 'message', text: NO_RISK }] }],
    stream: [{ text: '', toolCalls: [] }],
    // 联系人表里记过名字、但不是用户 ⇒ `trusted`。键要走 `normalizeSid` 那一套口径
    // （`sidOf('qq-official','c2c',id)` = `qq:c2c:id`——命名空间与通道别名无关）
    patchConfig: (config) => { config.persona.contacts = { 'qq:c2c:FRIEND_OPENID': '老张' }; },
  });
  t.after(rig.dispose);

  rig.append('wake/channel', {
    channel: 'qq-official',
    chatType: 'c2c',
    chatId: 'FRIEND_OPENID',
    person: 'FRIEND_OPENID',
    text: '在吗',
    messageId: 'msg-trust-gate-2',
    msgSeq: 1,
  });
  await rig.tick();

  const names = toolNamesOf(rig);
  assert.equal(names.includes('pwsh'), false, '`trusted` 那一档不含 destructive：`pwsh` 必须被摘掉');
  assert.ok(names.includes('mcp'),
    '`mcp` 自己是 `sideEffect:\'none\'`（它是入口不是动作）⇒ `trusted` 档仍看得见它；'
    + '它那条路上的危险动作由入口自己按 `destructiveEnabled` 判（`mcp-entry.ts`）');
  assert.ok(names.includes('safe_read'), '`trusted` 不是白名单档：非 destructive 的工具照旧给');
});

test('③c 用户档照旧读配置：`destructiveEnabled:false` 时 `pwsh` 消失（收窄没把用户的开关吃掉）', async (t) => {
  const rig = await makeRealWakeRig({
    registerTools: RIG_TOOLS,
    stream: [{ text: '', toolCalls: [] }],
    patchConfig: (config) => { config.tools.destructiveEnabled = false; },
  });
  t.after(rig.dispose);

  rig.append('wake/manual', { note: '看一眼清单' });
  await rig.tick();

  const names = toolNamesOf(rig);
  assert.equal(names.includes('pwsh'), false, '配置关掉 destructive ⇒ 用户档也看不见 `pwsh`（这条口径没变）');
  assert.ok(names.includes('mcp'), '`mcp` 不是 destructive ⇒ 照旧在（它是入口，不是动作）');
});
