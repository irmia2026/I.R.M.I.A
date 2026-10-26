/**
 * 压缩线（`persona.compactionThresholdTokens`）：**出厂默认 / 同源 / 不进请求字节** —— 2026-10-12
 *
 * 用户原话（这一版全部判据）：
 *   > 「与之配合的，框架也得有 **compact 80% 预警**。然后**预算 compact 线（history 大小），
 *   >  默认从 100k 提升到 200k**，然后**暴露在 GUI**。」
 *
 * 这一份钉三件事（GUI 那一侧在 `gui/test/settings_page_test.dart`，端点在
 * `test/web-server.test.ts` 的 `set-compaction-threshold` 那一案）：
 *
 *   ① **出厂默认 = 200000**：空目录（连 config.json 都没有）与"老配置缺这一格"都吃新默认；
 *      现场那份显式写了这一格的老配置照它跑（**运行期值由用户自己在界面上改**，出厂默认不动它）。
 *
 *   ② **同源**：80% 预警与压缩触发读的是**同一个键**——压缩判定把"当时生效的那个数"写进
 *      `compaction/decision`（`agent-loop.ts` 的 `maybeCompact`，`d.config.persona.compactionThresholdTokens`
 *      由 `real-loop.ts` 装配进来），预警从**同一条账**上把它读回来（`real-loop.ts` 的
 *      `maintenanceWindowFor` → `render.ts` 的 `maintenanceWindowOf`）。
 *      这里走**真链路**验：改内存里那一格（GUI 端点干的同一件事）之后，下一拍的判定行当场换数；
 *      并且落在 [80%, 100%) 带内时"预警成立而压缩不发生"——这两句话只有在**同一个分母**下才同时为真。
 *
 *   ③ **不进请求字节**：这一格不是 `instructions` / `tools` 的一部分。同一个进程里把它从
 *      10000 改成 200000，下一拍的 `instructions` 与 `tools` **逐字节相同**，
 *      `step/start` 记的 `renderVersion` 也不变 ⇒ 这一项**不需要**递增 `RENDER_VERSION`。
 *
 * 走真链路：真 EventLog + 真 fold + 真 RealLoop + 真 runTurn，替身只有模型通道。
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig, loadConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent, Projection } from '../src/log/types.ts';
import { emptyProjection } from '../src/log/types.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import { MAINTENANCE_COMPACTION_RATIO, RENDER_VERSION, maintenanceWindowOf } from '../src/model/render.ts';
import { estimateHistoryTokens } from '../src/persona/handoff-note.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';
import { RealLoop } from '../src/runtime/real-loop.ts';
import { applyOne } from '../src/state/fold.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const TZ = 'Asia/Shanghai';
const T0 = new Date('2026-10-09T15:00:00.000+08:00'); // 本机 15:00：不是凌晨（只留"压缩临近"那条窗口）

const PERSONA: PersonaAssets = {
  identity: 'IDENTITY',
  constitution: 'CONSTITUTION',
  style: 'STYLE',
  state: 'STATE',
  relationship: null,
  personaHash: 'test-hash',
  isSeed: false,
} as unknown as PersonaAssets;

/** 模型替身：heavy 把每一次请求**逐字记下来**（"这一轮发出去的字节"就看它），light 回空 JSON */
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
  /** 她这一轮发出去的请求（原文） */
  requests: () => unknown[];
  /** 只取最后那一次请求（测"这一轮里没有 X"必须用它，否则会被前几轮的请求污染） */
  lastRequest: () => Record<string, unknown>;
  /** 当前可见历史估算（与压缩判定同一把尺：`estimateHistoryTokens`） */
  historyTokens: () => Promise<number>;
  /** **改内存里那一格**——GUI 端点（`set-compaction-threshold`）在配置锁里做的就是这一件事 */
  setThreshold: (tokens: number) => void;
  /** 走时钟（毫秒）：维护窗口有一道"距上次窗口满 6 小时"的闸，要跨过它就得让时间真的走 */
  advance: (ms: number) => void;
  tick: () => Promise<void>;
  events: () => Promise<AppEvent[]>;
  /** 造一条唤醒，它的正文**量出来**约等于 `tokens`（判据用实数，不靠我猜字符数） */
  appendFiller: (tokens: number) => Promise<void>;
  appendWake: (note: string) => Promise<void>;
}

async function makeRig(t: TestContext, thresholdTokens: number): Promise<Rig> {
  const dir = tempDirSync('irmia-threshold-');
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const log = await EventLog.open(join(dataDir, 'events'));
  const projection = emptyProjection();
  const requests: unknown[] = [];
  let nowMs = T0.getTime();
  const config = defaultConfig(dir);
  config.persona = { ...config.persona, compactionThresholdTokens: thresholdTokens };
  const loop = new RealLoop({
    log,
    dataDir,
    projection,
    now: () => new Date(nowMs),
    timezone: TZ,
    ds: fakeDs(requests),
    // 注册一件工具：**空注册表会让 `tools` 那一格恒等于 `[]`**，"工具的字节没变"就成了废话。
    // 有一件在册的（形状照 test/web-server.test.ts 的 echo），那条断言才真的在量东西。
    registry: registryWithEcho(),
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

  const readAll = async (): Promise<AppEvent[]> => {
    log.flush();
    const out: AppEvent[] = [];
    for await (const event of log.readAll()) out.push(event);
    return out;
  };

  const appendWake = async (note: string): Promise<void> => {
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
  };

  return {
    requests: () => requests,
    lastRequest: () => (requests.at(-1) ?? {}) as Record<string, unknown>,
    historyTokens: async (): Promise<number> => estimateHistoryTokens(await readAll()),
    setThreshold: (tokens: number): void => {
      (config.persona as { compactionThresholdTokens: number }).compactionThresholdTokens = tokens;
    },
    advance: (ms: number): void => {
      nowMs += ms;
    },
    tick: async () => {
      await loop.tickOnce();
    },
    events: readAll,
    appendWake,
    /**
     * 「造一条量出来约为 `tokens` 的唤醒正文」。
     *
     * 为什么要量、不直接写死字符数：阈值是 **token**，而正文的 token 数取决于内容与当时的
     * 估算口径（中文约 1.5 字/token）。写死字符数的用例会在阈值或估算口径微调之后变成
     * "测的不是我以为的那一支"——这里先量一次当前可见历史，再按**同一把尺**把差值补上。
     */
    appendFiller: async (tokens: number): Promise<void> => {
      const all = await readAll();
      const before = estimateHistoryTokens(all);
      const nextSeq = (all.at(-1)?.seq ?? 0) + 1;
      const marker = '\n（新的一段往来。）';
      let text = '料';
      // 逐次逼近：每轮都用**同一把尺**量一次（不做解析式的字符↔token 换算，那是第二份口径）
      for (let i = 0; i < 24; i += 1) {
        const after = estimateHistoryTokens([...all, offsetWake(nextSeq, text + marker)]);
        if (after - before >= tokens) break;
        const missing = tokens - (after - before);
        text += '垫'.repeat(Math.max(64, Math.ceil(missing * 1.2)));
      }
      await appendWake(text + marker);
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

/**
 * 一件在册工具的注册表（形状照 `test/web-server.test.ts` 的 echo）。
 *
 * 为什么非要有它：空注册表渲染出来的 `tools` 就是 `[]`（2 字节），"工具那段字节没变"在那种台子上
 * 恒真、什么也没证明。有这一件，`tools` 才是一段真字节（name/description/parameters 全在里面）。
 */
function registryWithEcho(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: 'echo',
    description: '把参数原样返回（测试用的在册工具）',
    parameters: { type: 'object', properties: {} },
    executionMode: 'parallel',
    sideEffect: 'none',
    timeoutMs: 1000,
    handler: async () => ({ content: 'ok' }),
  });
  return registry;
}

const decisions = (events: AppEvent[]): Array<AppEvent & { type: 'compaction/decision' }> =>
  events.filter((event): event is AppEvent & { type: 'compaction/decision' } =>
    event.type === 'compaction/decision');

// ──────────────────────────── ① 出厂默认 = 200000 ────────────────────────────

test('出厂默认 = 200000：空目录与"老配置缺这一格"都吃新默认，显式写了就按它', async (t) => {
  const dirEmpty = tempDirSync('irmia-thr-empty-');
  const dirOld = tempDirSync('irmia-thr-old-');
  const dirPinned = tempDirSync('irmia-thr-pinned-');
  t.after(() => {
    for (const dir of [dirEmpty, dirOld, dirPinned]) rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(defaultConfig(dirEmpty).persona.compactionThresholdTokens, 200_000, 'buildDefaults 那一格');

  // ① 空目录：连 config.json 都没有（首次启动会按默认重建）
  const empty = await loadConfig(dirEmpty);
  assert.equal(empty.config.persona.compactionThresholdTokens, 200_000, '空目录吃新默认');

  // ② 老配置：有 persona 这一节、但**没有这一格** ⇒ 吃新默认（不是 0、也不是旧的 100000）
  writeFileSync(join(dirOld, 'config.json'), `${JSON.stringify({
    schemaVersion: 1,
    persona: { owner: '阿岚' },
    budget: { softRatio: 0.8 },
  }, null, 2)}\n`, 'utf8');
  const old = await loadConfig(dirOld);
  assert.equal(old.config.persona.compactionThresholdTokens, 200_000, '缺这一格 ⇒ 新默认');
  assert.equal(old.config.persona.owner, '阿岚', '同一节里别的格照旧');
  assert.equal(old.config.budget.softRatio, 0.8, '别的节也没被牵连');

  // ③ 现场那份显式写了这一格 ⇒ 按它（出厂默认**不动运行期值**）
  writeFileSync(join(dirPinned, 'config.json'), `${JSON.stringify({
    schemaVersion: 1,
    persona: { compactionThresholdTokens: 100_000 },
  }, null, 2)}\n`, 'utf8');
  const pinned = await loadConfig(dirPinned);
  assert.equal(pinned.config.persona.compactionThresholdTokens, 100_000, '显式覆盖优先于出厂默认');
});

// ─────────────── ② 同源 + ③ 不进请求字节（真链路：真 RealLoop） ───────────────

test('改内存那一格 ⇒ 下一拍当场换数（立刻生效），且冻结前缀逐字节不变', async (t) => {
  const rig = await makeRig(t, 10_000);
  // 起手就过线：压一次（这一行的 thresholdTokens 必须等于配置那一格）
  await rig.appendFiller(20_000);
  await rig.tick();

  const first = decisions(await rig.events());
  assert.equal(first.length, 1, '一拍一个 turn ⇒ 一行留痕');
  assert.equal(first[0]!.data.reason, 'wrote', '越线 ⇒ 该压');
  assert.equal(first[0]!.data.thresholdTokens, 10_000, '压缩判定读的是配置那一格');

  // ↓↓↓ GUI 端点（`set-compaction-threshold`）在 `configFileLock` 的同一个临界区里做的就是这一行
  rig.setThreshold(200_000);
  await rig.appendWake('第二拍：聊两句');
  await rig.tick();

  const rows = decisions(await rig.events());
  assert.equal(rows.length, 2, '两拍两行');
  assert.equal(rows[1]!.data.thresholdTokens, 200_000,
    '下一拍就按新线算（内存那份被改了 ⇒ 立刻生效，不用重启）');

  // ③ 冻结前缀逐字节相同：同一个进程里这一格从 10000 改成 200000，`instructions` 与 `tools` 一个字都没变
  const [reqA, reqB] = rig.requests();
  assert.ok(reqA !== undefined && reqB !== undefined && reqA !== reqB, '两拍各发过一次请求');
  const instructionsA = JSON.stringify((reqA as { instructions?: unknown }).instructions) ?? '';
  const instructionsB = JSON.stringify((reqB as { instructions?: unknown }).instructions) ?? '';
  const toolsA = JSON.stringify((reqA as { tools?: unknown }).tools) ?? '';
  const toolsB = JSON.stringify((reqB as { tools?: unknown }).tools) ?? '';
  // 读数（成功时也打出来）：这就是报告里那句"请求字节不变"的原始数字
  t.diagnostic('请求字节读数：'
    + `instructions ${Buffer.byteLength(instructionsA, 'utf8')} 字节（阈值 10000）`
    + ` vs ${Buffer.byteLength(instructionsB, 'utf8')} 字节（阈值 200000）；`
    + `tools ${Buffer.byteLength(toolsA, 'utf8')} 字节 vs ${Buffer.byteLength(toolsB, 'utf8')} 字节；`
    + `RENDER_VERSION = ${RENDER_VERSION}`);
  assert.equal(instructionsB, instructionsA,
    'instructions（最大公共前缀）逐字节相同 ⇒ 这一项不在里面');
  assert.equal(toolsB, toolsA,
    'tools（工具清单，冻结前缀的另一半）逐字节相同');
  // 而且那一格的名字与含义**根本没出现在前缀里**（不是"值恰好没变"，是"它压根不进前缀"）
  const prefixText = `${instructionsA}${toolsA}`;
  for (const needle of ['compactionThresholdTokens', '压缩线', '200000', '10000']) {
    assert.ok(!prefixText.includes(needle), `冻结前缀里不该出现 ${needle}`);
  }

  // `step/start` 记的渲染版本两拍一致，且就是当前那一代 ⇒ 这一项**不需要**递增 RENDER_VERSION
  const starts = (await rig.events()).filter((event) => event.type === 'step/start');
  assert.equal(starts.length, 2, '两拍各一个 step');
  for (const start of starts) {
    assert.equal((start.data as { renderVersion: string }).renderVersion, RENDER_VERSION);
  }
});

test('80% 预警的分母就是压缩用的那个数：落在 [80%,100%) 时预警成立、压缩不发生', async (t) => {
  const THRESHOLD = 60_000;
  const rig = await makeRig(t, THRESHOLD);
  // 先压一次，把可见历史清回"最近那一截"（不清的话下面那段垫料会直接越线）
  await rig.appendFiller(90_000);
  await rig.tick();
  assert.equal(decisions(await rig.events()).at(-1)!.data.reason, 'wrote', '前提：第一拍真的压过一次');

  // 再把历史垫到 0.85 线：**越 80%、不越 100%**
  const target = Math.floor(THRESHOLD * 0.85);
  const missing = target - (await rig.historyTokens());
  assert.ok(missing > 0, `前提：压缩之后历史（${target - missing}）低于 0.85 线（${target}）`);
  await rig.appendFiller(missing);
  await rig.tick();

  const last = decisions(await rig.events()).at(-1)!;
  const history = last.data.historyTokens;
  const threshold = last.data.thresholdTokens;
  assert.equal(threshold, THRESHOLD, '这一行报的是配置那一格');
  assert.notEqual(last.data.reason, 'wrote',
    `这一段该落在 80%~100% 之间（实测 ${history} / ${threshold}）：越了线就不该再压`);
  assert.ok(history >= threshold * MAINTENANCE_COMPACTION_RATIO,
    `实测 ${history} 该已经越过 80% 线（${threshold * MAINTENANCE_COMPACTION_RATIO}）`);
  assert.ok(history < threshold, `实测 ${history} 该还没越线（${threshold}）`);

  // 预警判据吃的就是**同一条账上的这两个数**（`real-loop.ts` 的 maintenanceWindowFor 正是这么喂的）——
  // 所以"预警按 A 算、压缩按 B 算"这种事在这条链上不可能发生
  const note = maintenanceWindowOf({
    historyTokens: history,
    compactionThresholdTokens: threshold,
    localHour: 15,          // 本机 15:00：不落在凌晨窗口，唯一能成立的就是"压缩临近"
    idleTicks: 0,
    lastWindowAtMs: null,   // 从没给过 ⇒ 那道 6 小时的闸不拦
  }, T0.getTime());
  assert.equal(note?.reason, 'compaction-soon', '同一条账 ⇒ 到 80% 就该给窗口');
  assert.match(note!.text, /压缩临近/u);

  // 端到端：**下一拍的请求里真的出现那一行**（信号行的写法是「维护窗口：」，常驻规则那半用的是
  // 「维护窗口（…）」——两种写法不同，所以这一条匹配到的只可能是信号行）。
  //
  // 为什么要走 7 小时：那道闸是"距上次窗口满 6 小时"（三个窗口共用），而上面第一拍越线时
  // 已经给过一次窗口（在同一个 `T0` 上）——同一刻再问，闸必然拦下。时间真的走过去了，
  // 下一拍的判据才落在"这一行该不该给"上，而不是落在闸上。
  rig.advance(7 * 60 * 60 * 1000);
  await rig.appendWake('再聊一句');
  await rig.tick();
  assert.match(textOfRequest(rig.lastRequest()), /维护窗口：压缩临近/u,
    '压缩临近那一行真的进了下一拍的请求（此刻层）');
});
