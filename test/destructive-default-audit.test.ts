/**
 * 出厂 **destructive 工具策略 = 全开** 的审计判据（2026-10-21 用户裁决）。
 *
 * 三条要同时钉住，缺一条这个默认值就不该改：
 *   ① 缺省配置读出来就是 `true`（全开）——危险工具进模型视线；
 *   ② **全开档下 destructive 调用仍然写审计**：走真执行器 + 真事件日志，
 *      `tool/call`（带完整入参）与 `tool/result`（带终态）两条都在，且 callSeq 配对；
 *   ③ 显式关掉之后可见性门照旧生效（默认档改宽 ≠ 显式关不掉）。
 *
 * ## 为什么这条要单开一个文件
 *
 * 用户对 ② 的裁决是"**默认全开、不加任何新门槛**"。于是要回答的问题不是"要不要加门"，
 * 而是"改默认档有没有顺手把既有的东西弄丢"。审计这一条最容易悄悄丢：它不在
 * `destructiveEnabled` 那一格上，而在执行器的**两阶段落库**里（`src/tools/executor.ts`：
 * 执行前 `tool/call` 拿 seq、执行后 `tool/result` 引用它）。两处相距很远，改了配置默认值之后
 * 没有任何类型检查会提醒"日志还在不在"——只能靠一条走真链路的用例。
 *
 * ⚠️ 这条用例**不是**在加门：它只断言"记录照写"。全开之后 `pwsh` 的命令黑名单、
 * `authzGate`、`planMode`、MCP 入口的危险门、受保护路径一个都没动（各自有各自的用例）。
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { defaultVisibility, type AppEvent } from '../src/log/types.ts';
import {
  executeToolCalls,
  type ExecutionContext,
  type ToolCallRequest,
} from '../src/tools/executor.ts';
import { ToolRegistry, type ToolDefinition, type ToolHandlerResult } from '../src/tools/registry.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const TURN = 3;
const STEP = 1;
const EPOCH_MS = 1_780_000_000_000;

function freshDir(t: TestContext): string {
  const dir = tempDirSync('irmia-destructive-audit-');
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return resolve(dir);
}

/** 一件声明为 destructive 的工具（形状与 `pwsh` / `safe_write` 那一批同族） */
function destructiveTool(name = 'wipe'): ToolDefinition {
  return {
    name,
    description: '测试用的破坏性动作（崩溃后不可自动重试的那种）',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    executionMode: 'exclusive',
    sideEffect: 'destructive',
    timeoutMs: 5_000,
    handler: async (): Promise<ToolHandlerResult> => ({ content: `${name} 已执行` }),
  };
}

function call(id: string, name: string, args: unknown = {}): ToolCallRequest {
  return { callId: id, name, arguments: JSON.stringify(args) };
}

interface Harness {
  events: AppEvent[];
  ctx: ExecutionContext;
}

/** 真 EventLog + 与 `agent-loop` 同形的两阶段落库回调（`tool/call` 先行、`tool/result` 引用 seq） */
async function setup(t: TestContext, registry: ToolRegistry): Promise<Harness> {
  const dataDir = freshDir(t);
  const log = await EventLog.open(join(dataDir, 'events'));
  t.after(() => {
    try {
      log.close();
    } catch {
      // 已关闭：清理阶段忽略
    }
  });

  const events: AppEvent[] = [];
  const append = (type: string, data: unknown): AppEvent => {
    const event = {
      seq: log.nextSeq(),
      ts: new Date(EPOCH_MS + events.length).toISOString(),
      type,
      data,
      visibility: defaultVisibility(type),
      origin: 'test/destructive-audit',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    events.push(event);
    return event;
  };

  const ctx: ExecutionContext = {
    registry,
    turn: TURN,
    step: STEP,
    workspaceRoot: dataDir,
    onToolCall: (req) => append('tool/call', {
      turn: TURN,
      step: STEP,
      callId: req.callId,
      name: req.name,
      arguments: req.arguments,
      sideEffect: registry.get(req.name)?.sideEffect ?? 'none',
    }).seq,
    onToolResult: (req, result, callSeq) => {
      append('tool/result', {
        turn: TURN,
        step: STEP,
        callId: req.callId,
        callSeq,
        status: result.status,
        content: result.content,
        durationMs: result.durationMs,
        ...(result.error !== undefined ? { error: result.error } : {}),
      });
    },
    onToolZombie: (req, note) => {
      append('tool/zombie', { callId: req.callId, name: req.name, note });
    },
  };

  return { events, ctx };
}

test('② 缺省配置的 destructive 策略就是全开（危险工具进模型视线）', (t) => {
  const config = defaultConfig(freshDir(t));
  assert.equal(config.tools.destructiveEnabled, true, '出厂默认必须是全开');

  const registry = new ToolRegistry();
  registry.register(destructiveTool());
  // 生产那一格（real-loop 的 `modelVisibility`）就是 `{ includeDestructive: config.tools.destructiveEnabled }`
  const names = registry
    .listForModel({ includeDestructive: config.tools.destructiveEnabled })
    .map((spec) => spec.name);
  assert.deepEqual(names, ['wipe'], '全开档下 destructive 工具必须在模型清单里');
});

test('② 全开档下 destructive 调用仍有审计：tool/call（带入参）+ tool/result（带终态）', async (t) => {
  const config = defaultConfig(freshDir(t));
  const registry = new ToolRegistry();
  registry.register(destructiveTool());
  const h = await setup(t, registry);

  const records = await executeToolCalls(
    [call('c1', 'wipe', { path: 'C:/somewhere/important' })],
    h.ctx,
  );
  assert.equal(records.length, 1);
  assert.equal(records[0]?.result.status, 'ok', '全开档下它真的执行了（不是被拒）');

  const callEvents = h.events.filter((e) => e.type === 'tool/call');
  const resultEvents = h.events.filter((e) => e.type === 'tool/result');
  assert.equal(callEvents.length, 1, '每一次执行都必须先落 tool/call');
  assert.equal(resultEvents.length, 1, '执行完必须落 tool/result');

  const callEvent = callEvents[0]!;
  assert.equal(callEvent.data.name, 'wipe');
  assert.equal(callEvent.data.sideEffect, 'destructive', '审计里要能看出这是危险动作');
  assert.match(
    String((callEvent.data as { arguments?: unknown }).arguments),
    /C:\/somewhere\/important/u,
    'tool/call 必须带完整入参——没有入参的"审计"查不出她到底动了什么',
  );

  const resultEvent = resultEvents[0]!;
  assert.equal(resultEvent.data.callId, 'c1');
  assert.equal(resultEvent.data.callSeq, callEvent.seq, 'tool/result 必须引用那条 tool/call 的 seq');
  assert.equal(resultEvent.data.status, 'ok');
});

test('② 显式写关仍然优先：同一件 destructive 工具在模型清单里消失（可见性门没被删）', (t) => {
  const registry = new ToolRegistry();
  registry.register(destructiveTool());
  assert.deepEqual(
    registry.listForModel({ includeDestructive: false }).map((spec) => spec.name),
    [],
    '显式关闭 ⇒ 一件都不列（这是三态里的 false 档，默认值改了它也没变）',
  );
});
