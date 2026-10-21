/**
 * 工具清单**恒定**的判据（2026-10-11 用户裁决后重写）。
 *
 * 这一支以前叫"`trust` 门接上线的判据（v44）"——它钉的是**反面**：外部档的 `tools` 段
 * **必须比** owner 档少，少到只剩白名单四件。那条判据把违规行为锁死了：
 * `481db36` 让 `modelVisibility` 随信任级变，而用户 2026-10-04 定过、2026-10-11 又逐字重申
 * 的铁律是「**tool 数组是绝对不动的（除非我们版本更新）任何情况都不应该变动**」。
 * ⇒ 本文件整支**改成反向判据**：**owner 档与 external 档的 `tools` 段逐字节相同**。
 *
 * 设计条文（`docs/design.md:1029`，2026-10-04 定稿）：
 *   "**外部来源那几轮怎么收窄（2026-10-04 定稿）**：**不在工具清单层**。清单对所有轮次恒定
 *    （§4.13 的缓存纪律，实测同签名命中 85.2%、换签名 41.2%），收窄挪到**执行期**——
 *    `runtime/authz.ts` 的 `authzGate` 配合 `tools.groupSceneHardRefusal`（默认软提醒，
 *    GUI 可切硬拒绝）。`registry.ts` 的 `allowOnly` 与 `trust.ts` 的 `modelVisibilityFor`
 *    都还在、也有用例，只是当前**刻意不调用**（接线点写在 `trust.ts` 里）。"
 *
 * 三组判据（对应下面三组用例）：
 *   ① **入口那一层**：`modelVisibilityFor('owner'|…)` 与 `('external'|…)` **不再**是两份清单
 *      ——生产那一格是常量 `{ includeDestructive: 配置 }`，与信任级无关；
 *   ② **真链路**：群聊那一轮的 `tools` 段与用户那一轮**逐字节相同**（同一份配置），
 *      而且**整段 JSON**相同（不只是名字——schema 也是字节）；
 *   ③ **执行期那半边照旧拒**：客人 + `groupSceneHardRefusal` 开着时，本机类工具在
 *      **调用那一刻**被 `authzGate` 拒（清单恒定不等于没人拦——拦的是执行期，不是清单）。
 *
 * 为什么必须走真链路（而不是只断言 `listForModel`）：接线**正是最容易漏的那一步**，
 * 而这一支的历史就是"有人把清单层层接上了、有人又把它拆了"。只断言函数本身，
 * 等于把两次都重演一遍。
 *
 * 说明：Node 的类型剥离不做 `.js` → `.ts` 映射，所以这里用显式 `.ts` 说明符导入源码。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createAuthzGate, denyReasonFor } from '../src/runtime/authz.ts';
import { EXTERNAL_TOOL_ALLOWLIST, modelVisibilityFor } from '../src/runtime/trust.ts';
import { buildCatalogRegistry } from '../src/tools/catalog.ts';
import type { DsRequest } from '../src/model/ds-client.ts';
import type { RealWakeRig } from './fixtures/real-wake-rig.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { makeRealWakeRig } from './fixtures/real-wake-rig.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

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

/** 那一拍发出的 heavy 请求（她那一轮的主请求） */
function heavyRequestOf(rig: RealWakeRig): DsRequest {
  const heavy = rig.requests.find((item) => item.lane === 'heavy');
  assert.ok(heavy !== undefined, '她那一拍该发一次 heavy 请求（否则下面比的是空）');
  return heavy.request;
}

/** 假模型收到的那一次 heavy 请求里的工具名（顺序就是请求体里的顺序） */
function toolNamesOf(rig: RealWakeRig): string[] {
  return (heavyRequestOf(rig).tools ?? []).map((tool) => tool.name);
}

/**
 * **`tools` 段的逐字节指纹**——判据"两档相同"要的是整段，不只是名字：
 * 描述、参数 schema、required 全是请求体里真实发出的字节，只比名字会漏掉 schema 级别的差异。
 * 哈希只用来把"不同"这件事显示成一个短串，`assert.equal` 仍然比的是两边的 canonical 串。
 */
function toolsBytesOf(request: DsRequest): string {
  return JSON.stringify(request.tools ?? []);
}

function toolsDigestOf(request: DsRequest): string {
  return createHash('sha256').update(toolsBytesOf(request)).digest('hex').slice(0, 16);
}

// ──────────────────────── ① 入口那一层：生产口径是常量 ────────────────────────

test('① 生产口径的注册表：owner 档与 external 档的清单**逐字节相同**', async (t) => {
  const dataDir = tempDirSync('irmia-trust-gate-');
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
  assert.ok(registry.names().includes('mcp'), '`mcp` 必须在注册表里（否则下面几条断言什么也没锁）');

  // **生产那一格**（`real-loop.ts` 的 `agentDeps`）：常量，与信任级无关。
  // 写成这个字面量是**故意的**——它是判据本身：谁把它换回 `modelVisibilityFor(trust, …)`，
  // 下面两条断言立刻红。
  const visibility = { includeDestructive: true } as const;

  const owner = registry.listForModel(visibility).map((spec) => spec.name);
  const external = registry.listForModel(visibility).map((spec) => spec.name);
  assert.deepEqual(external, owner,
    '工具清单恒定（2026-10-04 定稿 / 2026-10-11 裁决）：两档看到的**必须是同一份清单**，'
    + '顺序也一样——`tools` 段是请求体最前面的稳定前缀，它一变，之后的整段历史缓存全部失效');
  assert.ok(owner.includes('mcp'), '`mcp` 在清单里（它是入口，不是 destructive 动作）');
  assert.ok(owner.includes('pwsh'), '配置把 destructive 全开时 `pwsh` 在清单里');

  // **`modelVisibilityFor` 还在**（用例也留着），但它算出来的 external 档**不再**是生产口径。
  // 这一条是"故意不调用"的书面证据：函数没删、口径没改，只是接线点不接。
  assert.notDeepEqual(registry.listForModel(modelVisibilityFor('external', true)).map((s) => s.name), owner,
    '`modelVisibilityFor(\'external\', …)` 仍然给出白名单四件那一档（函数与口径都留着）——'
    + '它**不是**生产口径，生产走的是上面那份常量');
  assert.deepEqual([...EXTERNAL_TOOL_ALLOWLIST], ['speak', 'report', 'read_channel', 'vision_read'],
    '黑名单/白名单这张表本身没被动过（它是执行期收窄那份判断的真源）');
});

// ──────────────────────── ② 真链路：两档的 `tools` 段相同 ────────────────────────

test('② 真链路：群里有人 @ 她 ⇒ 那一轮的 `tools` 段与用户那一轮**逐字节相同**', async (t) => {
  // 两个台子**同一份配置**（destructive 全开）、同一批注册工具，唯一差别是"谁唤醒的"。
  const make = () => makeRealWakeRig({
    registerTools: RIG_TOOLS,
    generate: [{ outputItems: [{ type: 'message', text: NO_RISK }] }],
    stream: [{ text: '', toolCalls: [] }],
    patchConfig: (config) => { config.tools.destructiveEnabled = true; },
  });

  const ownerRig = await make();
  t.after(ownerRig.dispose);
  const guestRig = await make();
  t.after(guestRig.dispose);

  ownerRig.append('wake/manual', { note: '帮我看一眼 MCP' });
  await ownerRig.tick();
  guestRig.append('wake/channel', GROUP_WAKE);
  await guestRig.tick();

  const ownerTools = toolsBytesOf(heavyRequestOf(ownerRig));
  const guestTools = toolsBytesOf(heavyRequestOf(guestRig));

  assert.equal(toolsDigestOf(heavyRequestOf(guestRig)), toolsDigestOf(heavyRequestOf(ownerRig)),
    `群聊那一轮的 \`tools\` 段必须与用户那一轮**逐字节相同**（实际 ${toolsDigestOf(heavyRequestOf(guestRig))}`
    + ` vs ${toolsDigestOf(heavyRequestOf(ownerRig))}）——工具数组只在**版本更新**时变`);
  assert.equal(guestTools, ownerTools, '`tools` 段整段相同（含描述与参数 schema，不只是名字）');

  const names = toolNamesOf(guestRig);
  for (const name of ['mcp', 'pwsh', 'safe_read']) {
    assert.ok(names.includes(name),
      `群聊那一轮同样看得见 \`${name}\`：收窄**不在清单层**（它在执行期，见 ③）；实际：${names.join('、')}`);
  }
  assert.deepEqual(names, toolNamesOf(ownerRig), '两档的工具名与顺序也一致');
});

test('②b 真链路：用户那一轮**照旧读配置**——`destructiveEnabled:false` 时 `pwsh` 消失', async (t) => {
  const rig = await makeRealWakeRig({
    registerTools: RIG_TOOLS,
    stream: [{ text: '', toolCalls: [] }],
    patchConfig: (config) => { config.tools.destructiveEnabled = false; },
  });
  t.after(rig.dispose);

  rig.append('wake/manual', { note: '看一眼清单' });
  await rig.tick();

  const names = toolNamesOf(rig);
  assert.equal(names.includes('pwsh'), false,
    '唯一还管清单的那个开关是全局 `destructiveEnabled`（恒定口径 = 只吃配置）');
  assert.ok(names.includes('mcp'), '`mcp` 不是 destructive ⇒ 照旧在（它是入口，不是动作）');
});

// ──────────────────────── ③ 执行期那半边：该拒的仍然拒 ────────────────────────

test('③ 执行期：客人 + 硬拒绝档 ⇒ 本机类工具在**调用那一刻**被拒（清单恒定不等于不拦）', () => {
  const denied: string[] = [];
  const hard = createAuthzGate({
    scenario: 'guest',
    hardRefusal: true,
    onDenied: (call) => { denied.push(call.tool); },
  });

  for (const tool of ['pwsh', 'safe_write', 'timer', 'mcp']) {
    const verdict = hard.intercept({ tool, turn: 1, step: 1, arguments: {} });
    assert.ok(verdict !== null, `\`${tool}\` 是本机类（名单外一律算本机类）⇒ 硬拒绝档必须拒`);
    assert.equal(verdict.code, 'E_GROUP_SCENE', '拒绝码是既有的那个，没有新造');
    assert.equal(verdict.content, denyReasonFor(tool), '理由是人话、逐字用 authz 那一份');
  }
  assert.deepEqual(denied, ['pwsh', 'safe_write', 'timer', 'mcp'], '每一次拒绝都落了账（顺序即调用顺序）');

  // 社交类在硬拒绝档下照样放行：群里有人跟她说话，她本来就该能回
  for (const tool of ['speak', 'report', 'read_channel', 'vision_read']) {
    assert.equal(hard.intercept({ tool, turn: 1, step: 1, arguments: {} }), null,
      `\`${tool}\` 是社交类 ⇒ 硬拒绝档也放行`);
  }

  // 用户档一律放行
  const ownerGate = createAuthzGate({ scenario: 'owner', hardRefusal: true });
  assert.equal(ownerGate.intercept({ tool: 'pwsh', turn: 1, step: 1, arguments: {} }), null,
    '自己家里：本机类是本职');

  // **默认的就是软提醒那一档**（`config.ts` 的出厂默认 + `config.json` 现值都是 false）：
  // 客人 + 本机类**放行**，因为框架已经把风险讲清楚了，判断留给她。
  const soft = createAuthzGate({ scenario: 'guest', hardRefusal: false });
  assert.equal(soft.intercept({ tool: 'pwsh', turn: 1, step: 1, arguments: {} }), null,
    '软提醒档（默认）：`decideAuthz` 对客人一律放行——拦人的是那句提醒与她自己的判断');
});

test('③b 执行期拒绝的理由归到用户头上（她要能拿去跟群里的人复述）', () => {
  const gate = createAuthzGate({ scenario: 'guest', hardRefusal: true });
  const verdict = gate.intercept({ tool: 'safe_write', turn: 3, step: 2, arguments: {} });
  assert.ok(verdict !== null);
  assert.ok(verdict.content?.includes('用户禁止过'),
    `拒绝理由必须写明"用户禁止过"（不是她的洁癖、也不是框架的脾气）：${verdict.content}`);
  assert.ok(verdict.content?.includes('safe_write'), '要点名是哪一件工具');
  assert.ok(verdict.content?.includes('本机或单聊'), '要给一条出路（去哪儿说这件事）');
});
