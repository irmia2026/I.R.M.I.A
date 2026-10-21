/**
 * vision 的用量记账（2026-10-11）—— **一条真发出去的模型请求恰好一笔账，别的路一笔都不记**。
 *
 * 要修的形状（实测 64 次真实请求、零记账）：
 *   `vision_read` 真发出去的每一次模型请求都不记账。根因不在工具层"忘了记"，而是**这条链断了三次**：
 *   ① `src/main.ts` 的 `visionClient.generate` 无类型透传（返回值当 `unknown` 交出去）；
 *   ② `tools/vision.ts` 转手就把 `DsResponse` 压成字符串（`extractResponseText`）⇒ `usage` 丢掉；
 *   ③ 工具层**根本没资格记账**——`ToolContext` 里没有 `log` / `nextSeq()`，它的事件出口只有
 *      `image/attached` 一种（"vision 只该有写这一种事件的能力"，这是设计不是漏洞）。
 *   所以出口只能由宿主开一格（`ToolCatalogOptions.visionRecorder`），与 `memory_read` 的访问账
 *   （`memoryReadRecorder`）同形同一条纪律：**工具层只交事实，账本由宿主写**。
 *
 * 这一份钉四件事（**判据的核心是"只在真发出去一次模型请求时记一条"**）：
 *   ① **正向**：`vision_read`、缓存未命中 ⇒ 恰好**多一条** `budget/consumed{origin:'tools/vision'}`，
 *      且 `inputTokens` / `outputTokens` / `cacheHitTokens` / `cacheMissTokens` / `reasoningTokens`
 *      与假响应**逐格相等**（这一条是"usage 真的没丢"的唯一证据——不是"有没有记账"）；
 *   ② **缓存命中**（`cached: true`）⇒ **一条都不记**。这条最要紧：把"记账"写成"每次调用都记"
 *      是最容易犯的错，而缓存命中占了历史上 143 次调用里的一大块；
 *   ③ **`inline: true`** ⇒ **一条都不记**，且**一次模型请求都没发**（不调模型是这件事的定义）；
 *   ④ **超时真的会触发**：假客户端按 `signal` 决定何时返回（只用短超时注入点，**不真等 120 秒**）
 *      ⇒ 到点中断、如实报失败、**一条账都不记**（失败没有响应可交，不编一个 0 出来）。
 *
 * 装配走的是**生产那一处**（`buildCatalogRegistry` + `visionRecorder` 那一格），不是直接
 * `createVisionTools`——这次要修的正是"接线层丢了 usage"，只驱动工具层就绕过了被测的那一跳。
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent, BudgetConsumed, Projection } from '../src/log/types.ts';
import type { DsClient, DsResponse, DsStreamResult } from '../src/model/ds-client.ts';
import { applyOne, fold } from '../src/state/fold.ts';
import { buildCatalogRegistry } from '../src/tools/catalog.ts';
import { createVisionTools } from '../src/tools/vision.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const NOW = new Date('2026-10-11T10:00:00.000+08:00');

/** 合法 PNG 字节头（够让 loader 的型别判据认出来；内容无所谓——这条用例判的是"发没发、记没记"） */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR', 'latin1'),
  Buffer.alloc(9, 0),
]);

/** 假响应里那一份 usage：四个数各不相同，任何一格被丢掉/写错都能看出来 */
const USAGE = { inputTokens: 1_234, outputTokens: 567, cachedTokens: 89, reasoningTokens: 321 };

function fakeResponse(): DsResponse {
  return {
    status: 'completed',
    outputItems: [{
      type: 'message',
      id: 'm-vision',
      text: JSON.stringify({ peek: '一只橘猫', text: '一只橘猫躺在窗台上。', tags: ['猫'] }),
    }],
    usage: { ...USAGE },
    incompleteReason: null,
    model: 'fake-vision-model',
    responseId: 'resp_vision',
    durationMs: 42,
  };
}

interface Rig {
  dir: string;
  workspace: string;
  dataDir: string;
  events: AppEvent[];
  /** `visionClient.generate` 收到的请求（每真发一次一条） */
  requests: Array<{ signal?: AbortSignal | undefined }>;
  /** `vision_read` / `vision_query` 的调用口 */
  call: (
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal; turn?: number; step?: number },
  ) => Promise<{ content: string; isError?: boolean }>;
  consumed: () => BudgetConsumed[];
}

/**
 * 真链路测试台：真 EventLog + 真投影 + **真 `buildCatalogRegistry`**（照 `main.ts` 那份选项，
 * 含 `visionRecorder` 那一格——**它就是被测的那一跳**）。
 *
 * `respond` 决定假模型怎么回：默认立刻交一份成功响应；用例可以用它造"一直不返回、只认 signal"
 * 的那种（超时那一条）。
 */
async function makeRig(
  t: TestContext,
  respond?: (signal: AbortSignal | undefined) => Promise<DsResponse>,
): Promise<Rig> {
  const dir = tempDirSync('irmia-vision-usage-');
  const dataDir = join(dir, 'data');
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'pic.png'), PNG_BYTES);
  const log = await EventLog.open(join(dataDir, 'events'));
  const projection: Projection = fold([]);
  const events: AppEvent[] = [];
  t.after(() => {
    void log.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * 与 `main.ts` 的 `emit` 逐字同形：可见性走 `resolveEventVisibility` 那一处判据
   * （省略 ⇒ 由 schema 表判；表说 `model` 的事件省略就当场抛）。
   */
  const emit = (type: string, data: unknown, visibility?: 'model' | 'internal'): void => {
    const event = {
      seq: log.nextSeq(),
      ts: NOW.toISOString(),
      type,
      data,
      visibility: visibility ?? 'internal',
      origin: 'test/vision-usage-accounting',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    applyOne(projection, event);
    events.push(event);
  };

  const requests: Array<{ signal?: AbortSignal | undefined }> = [];
  /**
   * 假 `DsClient`：`generate` 是 vision 那条路（本文件唯一被测的模型口），`stream` 一次都不该被调
   * ——vision 是工具内部的**非流式**调用，走到 `stream` 说明接错了线。
   */
  const ds = {
    modelFor: (lane: string): string => (lane === 'light' ? 'fake-light' : 'fake-heavy'),
    generate: async (request: { signal?: AbortSignal | undefined }): Promise<DsResponse> => {
      requests.push(request);
      return respond === undefined ? fakeResponse() : await respond(request.signal);
    },
    stream: async (): Promise<DsStreamResult> => {
      throw new Error('vision 这条路不该走 stream（它是工具内部的非流式调用）');
    },
  } as unknown as DsClient;

  const { registry, problems } = await buildCatalogRegistry({
    dataDir,
    timers: new TimerStore(),
    emit,
    visionClient: {
      // 与 `main.ts` 的适配器**逐字同形**：请求原样透传，响应原样交回。
      generate: async (request: unknown) => ds.generate(request as never),
    },
    // 这一格就是被测的接线：工具层从 `ctx` 里交出 turn/step，宿主据此写账。
    visionRecorder: (response, turn, step) => {
      const usage = response.usage;
      const inputTokens = usage.inputTokens;
      const outputTokens = usage.outputTokens;
      const cacheHit = Math.max(0, Math.min(usage.cachedTokens, inputTokens));
      emit('budget/consumed', {
        turn,
        step,
        lane: 'light',
        model: response.model,
        inputTokens,
        outputTokens,
        cacheHitTokens: cacheHit,
        cacheMissTokens: Math.max(0, inputTokens - cacheHit),
        reasoningTokens: usage.reasoningTokens,
        durationMs: response.durationMs,
        retryCount: 0,
        finishReason: 'completed',
        tokensTodayAccum: inputTokens + outputTokens,
      }, 'internal');
    },
    visionImagesToContext: true,
  });
  assert.deepEqual(problems, [], '工具集装配不该有跳过项');

  return {
    dir,
    workspace,
    dataDir,
    events,
    requests,
    consumed: () => events.filter((e): e is BudgetConsumed => e.type === 'budget/consumed'),
    call: async (name, args, options = {}) => {
      const tool = registry.get(name);
      assert.ok(tool !== null, `${name} 得在注册表里`);
      const ctx: ToolContext = {
        callId: `call_${name}`,
        turn: options.turn ?? 7,
        step: options.step ?? 3,
        signal: options.signal ?? new AbortController().signal,
        workspaceRoot: workspace,
      };
      return await tool.handler(args, ctx);
    },
  };
}

// ─────────────────── ① 真发一次请求 ⇒ 恰好多一条账，且每个数都对 ───────────────────

test('① vision_read 缓存未命中：恰好多一条 budget/consumed{origin 由宿主定}，usage 逐格相等', async (t) => {
  const rig = await makeRig(t);
  const before = rig.consumed().length;

  const result = await rig.call('vision_read', { paths: ['pic.png'] });
  assert.equal(result.isError, undefined, `不该失败：${result.content}`);

  // 工具自己报的读数：这次是"新读"，也就是真发了一次请求
  const summary = JSON.parse(result.content) as { fresh: number; cached: number };
  assert.equal(summary.fresh, 1, '这一张必须真的发出去（缓存未命中）');
  assert.equal(rig.requests.length, 1, '恰好好发一次模型请求');

  const after = rig.consumed();
  assert.equal(after.length - before, 1, '恰好多一条账——不多不少');
  const entry = after[after.length - 1]!;
  assert.equal(entry.data.lane, 'light', 'vision 走 light lane');
  assert.equal(entry.data.turn, 7, 'turn 由工具层从 ctx 交出来');
  assert.equal(entry.data.step, 3, 'step 同上');
  assert.equal(entry.data.model, 'fake-vision-model', 'model 取响应里那一格（不是猜的）');
  // **这一组才是"usage 真的没丢"的证据**（光看"记了一条"证明不了这件事）
  assert.equal(entry.data.inputTokens, USAGE.inputTokens);
  assert.equal(entry.data.outputTokens, USAGE.outputTokens);
  assert.equal(entry.data.cacheHitTokens, USAGE.cachedTokens);
  assert.equal(entry.data.cacheMissTokens, USAGE.inputTokens - USAGE.cachedTokens);
  assert.equal(entry.data.reasoningTokens, USAGE.reasoningTokens);
  assert.equal(entry.data.durationMs, 42);
  assert.equal(entry.data.finishReason, 'completed');
  assert.equal(entry.data.tokensTodayAccum, USAGE.inputTokens + USAGE.outputTokens);

  // 账不许进她的上下文：schema 表里 budget/consumed 是 internal
  assert.equal(entry.visibility, 'internal', '预算账一个字节都不进请求体');
});

// ─────────────────── ② 缓存命中：一条都不记（这条最容易写错） ───────────────────

test('② 缓存命中那一路：一条账都不记，也不再发模型请求', async (t) => {
  const rig = await makeRig(t);

  // 第一次：真读，落缓存
  const first = await rig.call('vision_read', { paths: ['pic.png'] });
  assert.equal((JSON.parse(first.content) as { fresh: number }).fresh, 1);
  const afterFirst = rig.consumed().length;
  assert.equal(rig.requests.length, 1);

  // 第二次：同一张图 + 同一个问题 ⇒ 命中缓存（`vision.ts` 的 `hit !== undefined` 分支）
  const second = await rig.call('vision_read', { paths: ['pic.png'] });
  assert.equal(second.isError, undefined, `第二次不该失败：${second.content}`);
  const summary = JSON.parse(second.content) as { fresh: number; cached: number };
  assert.equal(summary.cached, 1, '这一张必须命中缓存');
  assert.equal(summary.fresh, 0);

  assert.equal(rig.requests.length, 1, '命中缓存**不再发**模型请求');
  assert.equal(rig.consumed().length, afterFirst,
    '缓存命中一条账都不记——"记账"不能写成"每次调用都记"');
});

// ─────────────────── ③ inline 直通：不调模型 ⇒ 一条都不记 ───────────────────

test('③ vision_read{inline:true}：一次模型请求都不发，因此一条账都不记', async (t) => {
  const rig = await makeRig(t);
  const before = rig.consumed().length;

  const result = await rig.call('vision_read', { paths: ['pic.png'], inline: true });
  assert.equal(result.isError, undefined, `inline 该成功：${result.content}`);
  assert.equal(rig.requests.length, 0, 'inline 不调视觉模型（它只把原图放进上下文）');
  assert.equal(rig.consumed().length, before, '没发请求就没有账');
  // 但它**确实做了事**：写了一条 image/attached（这条判据保证"没记账"不是因为"什么都没干"）
  assert.equal(rig.events.filter((e) => e.type === 'image/attached').length, 1);
});

// ─────────────────── ④ 超时真的会触发（不真等 120 秒） ───────────────────

/**
 * 这一条**只驱动工具层**（`createVisionTools` + 短超时注入点），不进 `buildCatalogRegistry`：
 * 它判的是"挂上去的那个信号到点真的会中断"，与记账是两件事，各测各的才分得清是哪一层坏的。
 *
 * 假模型**只认 signal**：它在 signal 上挂一个中断回调，并且**永不主动返回**。于是——
 *   · 超时信号真的挂上了 ⇒ 到点中断、抛出来、如实报 `E_TIMEOUT`；
 *   · 若改动丢了（没挂信号）⇒ 这一发永远不 settle。
 * "能跑完"本身就是那条判据，不需要去摸 `AbortSignal.timeout` 的内部形状。
 *
 * ⚠ **为什么要给 `ctx.signal` 也塞一个自己的控制器**：`AbortSignal.timeout` 的定时器是
 * **unref** 的（Node 的规定），所以没有别的句柄时事件循环会直接判定"没事可做"而退出——
 * 那不是"超时没触发"，是"没人等它"。这个控制器把事件循环按到超时那一刻之后（并保住子进程），
 * 它自己**不**中断，所以测到的中断只可能来自被测的那个超时信号。
 */
async function makeTimeoutRig(t: TestContext): Promise<{
  call: () => Promise<{ content: string; isError?: boolean }>;
  /** 假模型收到的信号（用来断言"确实给了它一个"） */
  signals: Array<AbortSignal | undefined>;
  /** 收工时放掉那个"按住事件循环"的控制器 */
  release: () => void;
}> {
  const dir = tempDirSync('irmia-vision-timeout-');
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'pic.png'), PNG_BYTES);
  const keepAlive = new AbortController();
  const keepAliveTimer = setTimeout(() => { keepAlive.abort(); }, 3_000);
  t.after(() => {
    clearTimeout(keepAliveTimer);
    rmSync(dir, { recursive: true, force: true });
  });

  const signals: Array<AbortSignal | undefined> = [];
  const tools = createVisionTools({
    dataDir: join(dir, 'data'),
    requestTimeoutMs: 40,
    dsClient: {
      generate: async (request) => {
        signals.push(request.signal);
        await new Promise<never>((_resolve, reject) => {
          const signal = request.signal;
          if (signal === undefined) return;
          const fail = (): void => {
            reject(signal.reason instanceof Error
              ? signal.reason
              : Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
          };
          if (signal.aborted) { fail(); return; }
          signal.addEventListener('abort', fail, { once: true });
        });
        throw new Error('不可达：signal 一定会中断');
      },
    },
  });
  const read = tools.find((tool) => tool.name === 'vision_read');
  assert.ok(read !== undefined, 'vision_read 得在返回的工具集里');
  return {
    signals,
    release: () => { clearTimeout(keepAliveTimer); },
    call: async () => await read.handler({ paths: ['pic.png'] }, {
      callId: 'call_timeout',
      turn: 1,
      step: 1,
      signal: keepAlive.signal,
      workspaceRoot: workspace,
    }),
  };
}

test('④ 单调用超时：到点真的中断、如实报 E_TIMEOUT、一条账都不记', async (t) => {
  const rig = await makeTimeoutRig(t);

  const started = Date.now();
  const result = await rig.call();
  const elapsed = Date.now() - started;
  rig.release();

  assert.equal(rig.signals.length, 1, '恰好好发一次请求');
  assert.ok(rig.signals[0] !== undefined, '这一发必须带着中断信号（改动之前这里是 undefined）');
  // 失败是**逐条**报的（`vision_read` 一次可带多张图，一张失败不该让整条调用失败）：
  // 汇总里 `failed: 1`，那一张自己的 `error.code` 才是判据。
  const summary = JSON.parse(result.content) as {
    failed: number;
    fresh: number;
    images: Array<{ error?: { code?: string } }>;
  };
  const item = summary.images[0];
  assert.equal(item?.error?.code, 'E_TIMEOUT', `到点那条路要报超时码，实际：${JSON.stringify(item)}`);
  assert.equal(summary.failed, 1, '这一张要如实记成失败');
  assert.equal(summary.fresh, 0, '超时的那一张不许被算成"新读"（它没读成）');
  assert.ok(elapsed < 5_000, `不该真等 120 秒（实测 ${elapsed}ms）`);
});
