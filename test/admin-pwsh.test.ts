/**
 * 管理工具包与 PowerShell 工具测试 — src/tools/admin.ts、src/tools/pwsh.ts
 *
 * 覆盖 docs/design.md §4.10（三级门）/ §4.11（人格只读）/ §4.18（pwsh 专项）/
 * §4.20（三路投递）/ §4.21（todo 与 jobs）、docs/schema.md §10（工具契约）。
 *
 * 六项硬验收：IDENTITY 拒绝、todo 回调、pwsh 单次执行、持久会话变量保持、
 * 危险命令拒绝原因、超时杀树。其余用例覆盖各条实现纪律的边界。
 *
 * 约定：值导入写 `.ts`（Node 的 --experimental-strip-types 只擦类型、不改写路径解析）。
 */

import assert from 'node:assert/strict';
import { estimateTokens } from '../src/tools/registry.ts';
import { SELF_BRIEF } from '../src/model/self-brief.ts';
import { after, before, describe, test } from 'node:test';
import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  MAX_TODO_ITEMS,
  ONDEMAND_WARN_BYTES,
  PERSONA_PROTECTED_FILES,
  SPEAK_TEXT_MAX,
  SPEAK_TEXT_REMIND_MAX,
  SPEAK_TEXT_SUGGESTED_MAX,
  createAdminTools,
  setSleepForTest,
  type AdminEventEmitter,
  type ReplyPoster,
  type ReplyTarget,
  type TodoItem,
} from '../src/tools/admin.ts';
import {
  BoundedText,
  FORBIDDEN_PATTERNS,
  OUTPUT_HEAD_CHARS,
  OUTPUT_TAIL_CHARS,
  POWERSHELL_INSTALL_HINT,
  buildSessionBootstrap,
  buildSingleShotScript,
  createPwshTool,
  decodeClixmlErrors,
  detectPowerShell,
  normalizeNewlines,
  resetInterpreterProbeCache,
  resetPowerShellProbeCache,
  screenCommand,
  scriptEnv,
  stripClixml,
  truncateOutput,
  type PwshToolDefinition,
} from '../src/tools/pwsh.ts';
// 群里 @ 人那几条用例走**真的**通道（真适配器 + 真回投接线，只有网络出口是夹具）：
// 出问题的那一跳正是"工具 → 回投 → 出站体"中间这一段，打桩到中间就等于把它测掉了
import {
  QQ_CHANNEL_NAME, QqOfficialChannel, createChannelReplyPoster,
  type HttpJsonFn, type HttpJsonResponse,
} from '../src/channel/qq-official.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
// 宿主接线那一组（PATH 优先 · 托管兜底的两槽候选）走的是**真装配**：
// 只把依赖探测注入成假结论，中间那一跳（catalog → pwsh）一个字都不打桩
import { DepsManager } from '../src/deps/manager.ts';
import { buildCatalogRegistry } from '../src/tools/catalog.ts';
import { tempDir } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 测试脚手架 ────────────────────────────────

let root = '';

before(async () => {
  root = await tempDir('irmia-tools-');
});

after(async () => {
  await removeTree(root);
});

/**
 * 清理临时目录。Windows 上目录刚被写过时常报 ENOTEMPTY（空目录也删不掉，
 * 通常是防病毒/索引持有句柄），所以退避重试，且不让清理失败掩盖断言结果。
 */
async function removeTree(dir: string): Promise<void> {
  let delay = 20;
  for (let attempt = 0; attempt < 9; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* 临时目录留在系统 temp 里由 OS 回收，不影响测试结论 */
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** 独立的子目录：每个用例用自己的根，互不干扰 */
async function workspace(name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeCtx(workspaceRoot: string, patch: Partial<ToolContext> = {}): ToolContext {
  return {
    callId: 'call_test',
    turn: 7,
    step: 1,
    signal: new AbortController().signal,
    workspaceRoot,
    ...patch,
  };
}

interface EventRecorder {
  emit: AdminEventEmitter;
  events: Array<{ type: string; data: unknown }>;
  /** 取某类型最后一次事件的 data */
  last(type: string): unknown;
  /** 某类型的事件条数 */
  count(type: string): number;
}

function makeRecorder(): EventRecorder {
  const events: Array<{ type: string; data: unknown }> = [];
  return {
    events,
    emit: (type, data) => {
      events.push({ type, data });
    },
    last: (type) => [...events].reverse().find((event) => event.type === type)?.data,
    count: (type) => events.filter((event) => event.type === type).length,
  };
}

/** 等待条件成立（后台任务这类异步完成点用）；超时抛错而不是静默通过 */
async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待超时：${label}`);
}

/** 结果内容的首行（pwsh 的输出首行就是命令的 stdout 首行） */
function firstLineOf(content: string): string {
  return normalizeNewlines(content).split('\n', 1)[0] ?? '';
}

/**
 * 计字口径：一个字算一个（emoji / 增补平面字符也算一个）——与 `speak` 里那条分段判据
 * （`chat-split.ts` 的 `charCount`）同一个数法，也与 `speak` 的 `maxLength` 同源。
 *
 * 用例里要数夹具的字数时**走这里，不要用 `text.length`**：后者把 emoji 数成两个，
 * 夹具的"正好 45"就会在带表情时悄悄飘到另一侧，边界用例变成一条假绿。
 */
function charCount(text: string): number {
  return [...text].length;
}

// ──────────────────────────────── write_persona ────────────────────────────────

describe('write_persona：persona 唯一写通道与只读保护', () => {
  test('IDENTITY.md 被拒绝，原因回给模型，且不落盘', async () => {
    const ws = await workspace('persona-identity');
    const personaRoot = join(ws, 'persona');
    const recorder = makeRecorder();
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: recorder.emit,
      personaRoot,
      onPersonaUpdated: () => undefined,
    });
    const ctx = makeCtx(ws);

    const result = await toolkit.byName('write_persona').handler(
      { file: 'IDENTITY.md', content: '# 新的我\n' },
      ctx,
    );

    assert.equal(result.isError, true, '必须被拒绝');
    assert.equal(result.error?.code, 'E_PROTECTED_TARGET');
    // 拒绝原因必须可操作：说清为什么 + 该改走哪条路
    assert.match(result.content, /只读/);
    assert.match(result.content, /STATE\.md|STYLE\.md/);
    assert.equal(recorder.count('persona/updated'), 0, '被拒绝的写入不得产生 persona/updated');
    assert.equal(await exists(join(personaRoot, 'IDENTITY.md')), false, '被拒绝的写入不得落盘');
  });

  test('CONSTITUTION.md 同样只读，子目录里的同名文件也拦得住', async () => {
    const ws = await workspace('persona-constitution');
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: makeRecorder().emit,
      personaRoot: join(ws, 'persona'),
    });
    const ctx = makeCtx(ws);

    for (const file of ['CONSTITUTION.md', 'constitution.md', 'RELATIONSHIPS/IDENTITY.md']) {
      const result = await toolkit.byName('write_persona').handler({ file, content: 'x' }, ctx);
      assert.equal(result.isError, true, `${file} 必须被拒绝`);
      assert.equal(result.error?.code, 'E_PROTECTED_TARGET');
    }
    assert.deepEqual(PERSONA_PROTECTED_FILES.map((name) => name.toUpperCase()).sort(), [
      'CONSTITUTION.MD', 'IDENTITY.MD',
    ]);
  });

  test('STYLE 由人拍板：直写被拒、提案收，核心身份连提案都不收', async () => {
    const ws = await workspace('persona-style');
    const personaRoot = join(ws, 'persona');
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: makeRecorder().emit,
      personaRoot,
    });
    const ctx = makeCtx(ws);
    const tool = toolkit.byName('write_persona');

    // 直写 STYLE：拒，且要告诉地提案这条路怎么走
    const direct = await tool.handler({ file: 'STYLE.md', content: '# 语气\n' }, ctx);
    assert.equal(direct.isError, true, 'STYLE 不能直写');
    assert.equal(direct.error?.code, 'E_PROTECTED_TARGET');
    assert.match(direct.content, /proposals\/STYLE\.md/, '要给出提案路径，不能只说「不行」');
    assert.equal(await exists(join(personaRoot, 'STYLE.md')), false, '被拒就不能落盘');

    // 提案可以写：改的仍不是她的说话方式，审批在人手上
    const proposal = await tool.handler({ file: 'proposals/STYLE.md', content: '# 想更直白\n' }, ctx);
    assert.equal(proposal.isError, undefined, proposal.content);
    assert.equal(
      await readFile(join(personaRoot, 'proposals', 'STYLE.md'), 'utf8'),
      '# 想更直白\n',
    );
    assert.equal(await exists(join(personaRoot, 'STYLE.md')), false, '写提案不得直接改动本体');

    // 核心身份连提案都不收：改的仍是「哪个资产」，与走哪条路无关
    for (const file of ['proposals/IDENTITY.md', 'proposals/CONSTITUTION.md']) {
      const denied = await tool.handler({ file, content: 'x' }, ctx);
      assert.equal(denied.isError, true, `${file} 必须被拒绝`);
      assert.equal(denied.error?.code, 'E_PROTECTED_TARGET');
    }
  });

  test('可写层正常落盘：原子写 + persona/updated + 语义回调 + 可复算的 diffHash', async () => {
    const ws = await workspace('persona-write');
    const personaRoot = join(ws, 'persona');
    const recorder = makeRecorder();
    const updated: Array<{ file: string; diffHash: string; by: string }> = [];
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: recorder.emit,
      personaRoot,
      onPersonaUpdated: (payload) => updated.push(payload),
    });
    const content = '# 关系档案：Alex\n\n- 认识于项目启动日\n';
    const result = await toolkit.byName('write_persona').handler(
      { file: 'RELATIONSHIPS/alex.md', content },
      makeCtx(ws),
    );

    assert.equal(result.isError, undefined, result.content);
    assert.equal(await readFile(join(personaRoot, 'RELATIONSHIPS', 'alex.md'), 'utf8'), content);

    const expectedHash = createHash('sha256').update(content, 'utf8').digest('hex');
    const event = recorder.last('persona/updated') as { file: string; diffHash: string; by: string };
    assert.deepEqual(event, {
      file: 'RELATIONSHIPS/alex.md',
      diffHash: expectedHash,
      by: 'agent',
    });
    assert.equal(updated.length, 1, '语义回调必须触发（宿主据此刷新 personaHash）');
    assert.equal(updated[0]?.diffHash, expectedHash);

    // 不留 .tmp 残骸
    assert.equal(await exists(join(personaRoot, 'RELATIONSHIPS', `alex.md.tmp.${process.pid}`)), false);
  });

  test('局部替换（old/new）：只换那一段，其余逐字节不动，且同样留审计', async () => {
    // 这一条钉的是 P2 的**另一半**：光把 fs 写入口对 data/persona 堵上（见 tool-catalog 的
    // 只读区用例）不够——她改一行 STATE.md 要重吐整篇 65 行，是被逼着走 safe_edit 的
    // （实测 87 次改动里 62 次走了 safe_edit，因而没有 persona/updated、也不进人格版本库）。
    // 形态与门必须同时到位。
    const ws = await workspace('persona-partial');
    const personaRoot = join(ws, 'persona');
    const recorder = makeRecorder();
    const updated: Array<{ file: string; diffHash: string; by: string }> = [];
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: recorder.emit,
      personaRoot,
      onPersonaUpdated: (payload) => updated.push(payload),
    });
    const ctx = makeCtx(ws);
    const tool = toolkit.byName('write_persona');

    const original = '# 状态\n\n## 心情\n还行\n\n## 手头的事\n等 coder 打包\n';
    await mkdir(personaRoot, { recursive: true });
    await writeFile(join(personaRoot, 'STATE.md'), original, 'utf8');

    const result = await tool.handler({ file: 'STATE.md', old: '还行', new: '不错' }, ctx);
    assert.equal(result.isError, undefined, result.content);
    const after = await readFile(join(personaRoot, 'STATE.md'), 'utf8');
    assert.equal(after, original.replace('还行', '不错'), '除了那一段，其余逐字节不变');
    assert.match(result.content, /局部替换/, '回执要说清这次走的是局部替换');

    // 与整体替换**同一条审计线**：persona/updated + 语义回调一个都不能少
    const expectedHash = createHash('sha256').update(after, 'utf8').digest('hex');
    assert.deepEqual(recorder.last('persona/updated'), {
      file: 'STATE.md',
      diffHash: expectedHash,
      by: 'agent',
    });
    assert.equal(updated.length, 1, '局部替换也要触发宿主回调（personaHash 靠它刷新）');

    // new 省略 = 删掉这一段
    // 注意 old 里**不带结尾换行**：匹配跑在"按行拼回来"的形态上（与 safe_edit 同一条内核、
    // 同一个口径），文件末尾那个换行不在匹配文本里。这也是她抄原文时会踩的那一脚。
    const removed = await tool.handler({ file: 'STATE.md', old: '## 手头的事\n等 coder 打包' }, ctx);
    assert.equal(removed.isError, undefined, removed.content);
    assert.doesNotMatch(await readFile(join(personaRoot, 'STATE.md'), 'utf8'), /等 coder 打包/);
  });

  test('局部替换的三种走不通：找不到 / 多匹配 / 与 content 同时给', async () => {
    const ws = await workspace('persona-partial-miss');
    const personaRoot = join(ws, 'persona');
    await mkdir(personaRoot, { recursive: true });
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: makeRecorder().emit,
      personaRoot,
    });
    const ctx = makeCtx(ws);
    const tool = toolkit.byName('write_persona');
    const path = join(personaRoot, 'STATE.md');
    await writeFile(path, '# 状态\n- 同一条\n- 同一条\n', 'utf8');

    // ① 找不到：要给下一步，不能只说"没命中"
    const missing = await tool.handler({ file: 'STATE.md', old: '根本不存在的一段', new: 'x' }, ctx);
    assert.equal(missing.isError, true);
    assert.match(missing.content, /没动手/);
    assert.match(missing.content, /safe_read/, '要告诉她怎么确认原文');

    // ② 多匹配：必须显式消歧，不许猜一处改
    const ambiguous = await tool.handler({ file: 'STATE.md', old: '同一条', new: 'x' }, ctx);
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.content, /命中 2 处/);
    assert.equal(await readFile(path, 'utf8'), '# 状态\n- 同一条\n- 同一条\n', '多匹配时一个字都不许落盘');

    // ③ 两种形态同时给：不知道她想怎样，当场问清楚
    const both = await tool.handler({ file: 'STATE.md', content: '整篇', old: '同一条', new: 'x' }, ctx);
    assert.equal(both.isError, true);
    assert.equal(both.error?.code, 'E_INVALID_ARGS');
    assert.match(both.content, /二选一/);

    // ④ 什么都没给
    const neither = await tool.handler({ file: 'STATE.md' }, ctx);
    assert.equal(neither.isError, true);
    assert.equal(neither.error?.code, 'E_INVALID_ARGS');

    // ⑤ 文件还不存在：局部替换没法改不存在的文件，要指路 content
    const absent = await tool.handler({ file: 'RELATIONSHIPS/nobody.md', old: 'a', new: 'b' }, ctx);
    assert.equal(absent.isError, true);
    assert.match(absent.content, /content/, '第一次写要告诉她用整体替换');
  });

  test('局部替换不许绕过两道门：IDENTITY/CONSTITUTION 只读、STYLE 只收提案', async () => {
    // 门是按**目标文件**判的，与走哪条形态无关——这条用例防的是"新开的那条路漏了门"。
    const ws = await workspace('persona-partial-gates');
    const personaRoot = join(ws, 'persona');
    await mkdir(personaRoot, { recursive: true });
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: makeRecorder().emit,
      personaRoot,
    });
    const ctx = makeCtx(ws);
    const tool = toolkit.byName('write_persona');
    await writeFile(join(personaRoot, 'IDENTITY.md'), '我是谁\n', 'utf8');
    await writeFile(join(personaRoot, 'STYLE.md'), '说话方式\n', 'utf8');

    for (const file of ['IDENTITY.md', 'CONSTITUTION.md', 'STYLE.md']) {
      const denied = await tool.handler({ file, old: '我是谁', new: 'x' }, ctx);
      assert.equal(denied.isError, true, `${file} 的局部替换也必须被拒`);
      assert.equal(denied.error?.code, 'E_PROTECTED_TARGET');
    }
    assert.equal(await readFile(join(personaRoot, 'IDENTITY.md'), 'utf8'), '我是谁\n', '被拒就不许落盘');
    assert.equal(await readFile(join(personaRoot, 'STYLE.md'), 'utf8'), '说话方式\n');
  });

  test('按需层超过软上限（2 KB = 2048 字节）只警告不拒绝；硬上限则拒绝', async () => {
    const ws = await workspace('persona-size');
    const personaRoot = join(ws, 'persona');
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: makeRecorder().emit,
      personaRoot,
    });
    const ctx = makeCtx(ws);
    const tool = toolkit.byName('write_persona');

    // STATE.md 属按需层：超软上限只警告，内容照样写入
    const big = 'x'.repeat(ONDEMAND_WARN_BYTES + 512);
    const warned = await tool.handler({ file: 'STATE.md', content: big }, ctx);
    assert.equal(warned.isError, undefined, warned.content);
    assert.match(warned.content, /\[警告\]/);
    assert.ok((warned.additionalContext ?? []).some((line) => line.includes('按需层')));
    assert.equal(await readFile(join(personaRoot, 'STATE.md'), 'utf8'), big);

    // 非按需层同样的体积不算按需层超限（MEMORIES 不每轮注入，没有尺寸劝告）
    const other = await tool.handler({ file: 'MEMORIES.md', content: big }, ctx);
    assert.equal(other.isError, undefined);
    assert.doesNotMatch(other.content, /\[警告\]/);

    // 超过硬上限直接拒绝
    const tooBig = await tool.handler({ file: 'STATE.md', content: 'x'.repeat(70 * 1024) }, ctx);
    assert.equal(tooBig.isError, true);
    assert.equal(tooBig.error?.code, 'E_TOO_LARGE');
  });

  test('软上限的判据是严格大于：正好 2048 字节不警告，2049 才警告（与 STATE 预算同一条线）', async () => {
    // 2026-10-17 用户批的那一笔：阈值 4096 → 2048，与 `persona.stateBudgetBytes` 同一根线。
    // 判据钉**严不严格**：`bytes > onDemandWarnBytes`，不是 `>=`——与 `stateBudgetReminder`
    // 的 `stateBytes > budgetBytes` 一模一样（正好 2048 那边两种提醒都不该出现）。
    assert.equal(ONDEMAND_WARN_BYTES, 2048, '软上限就是 2 KB = 2048 字节');
    const ws = await workspace('persona-warn-line');
    const personaRoot = join(ws, 'persona');
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: makeRecorder().emit,
      personaRoot,
    });
    const ctx = makeCtx(ws);
    const tool = toolkit.byName('write_persona');

    // 正好 2048 字节：不警告（内容照样写入；'x' 是 1 字节，规范化不动它）
    const exactly = await tool.handler(
      { file: 'STATE.md', content: 'x'.repeat(ONDEMAND_WARN_BYTES) },
      ctx,
    );
    assert.equal(exactly.isError, undefined, exactly.content);
    assert.equal(exactly.content.includes(`已写入 STATE.md：${ONDEMAND_WARN_BYTES} 字节`), true);
    assert.doesNotMatch(exactly.content, /\[警告\]/, '正好等于上限：不警告');
    assert.equal((exactly.additionalContext ?? []).length, 0, '正好等于上限：一条警告都没有');

    // 多一个字节：警告，但内容照样写入（只提醒、不拒绝）
    const over = await tool.handler(
      { file: 'STATE.md', content: 'x'.repeat(ONDEMAND_WARN_BYTES + 1) },
      ctx,
    );
    assert.equal(over.isError, undefined, over.content);
    assert.match(over.content, /\[警告\]/);
    assert.ok(
      (over.additionalContext ?? []).some((line) => line.includes('按需层')),
      '警告进 additionalContext（她看得到）',
    );
    // 回执里的数字由常量生成：改阈值不会让回执说谎（说 2048 就真的是 2048）
    assert.ok(
      over.content.includes(`超过按需层建议上限 ${ONDEMAND_WARN_BYTES} 字节`),
      `回执要给出真实阈值：${over.content}`,
    );
    assert.equal(await readFile(join(personaRoot, 'STATE.md'), 'utf8'), 'x'.repeat(ONDEMAND_WARN_BYTES + 1));
  });

  test('工具描述里的门槛也跟着写 2KB（tools 段字节变了 ⇒ 同批递 RENDER_VERSION 69）', () => {
    // 阈值与描述不能分岔：一个说 2KB、一个写 4KB，读的人会按 4KB 估自己的文件。
    // 这一句进的是 `tools` 段（`ToolDefinition.description` → 请求体 tools），所以本批
    // 改它必须**同批**递 RENDER_VERSION（68 → 69，见 render.ts 文件头 v69 那一篇）。
    const toolkit = createAdminTools({ timers: new TimerStore(null), emit: makeRecorder().emit });
    const tool = toolkit.byName('write_persona');
    assert.ok(tool.description.includes('按需层超 2KB 警告'), `描述要说 2KB：${tool.description}`);
    assert.equal(tool.description.includes('4KB'), false, '不许再说 4KB（与阈值分岔）');
    // 等长替换（4KB → 2KB）：`catalogTokens` 的硬门（< 5500、余量 ≥ 30）不受这一笔影响
    assert.equal(
      Buffer.byteLength(tool.description, 'utf8'),
      Buffer.byteLength(tool.description.replace('按需层超 2KB 警告', '按需层超 4KB 警告'), 'utf8'),
      '只换了一个字符，字节数不变',
    );
  });

  test('路径逃逸与非 .md 后缀一律拒绝', async () => {
    const ws = await workspace('persona-escape');
    const personaRoot = join(ws, 'persona');
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: makeRecorder().emit,
      personaRoot,
    });
    const ctx = makeCtx(ws);
    const tool = toolkit.byName('write_persona');

    const escapes = ['../outside.md', 'a/../../outside.md', 'C:/Windows/Temp/x.md', '/etc/passwd.md'];
    for (const file of escapes) {
      const result = await tool.handler({ file, content: 'x' }, ctx);
      assert.equal(result.isError, true, `${file} 必须被拒绝`);
      assert.equal(result.error?.code, 'E_INVALID_ARGS');
    }
    assert.equal(await exists(join(root, 'outside.md')), false, '越界路径不得落盘');

    const wrongSuffix = await tool.handler({ file: 'STATE.txt', content: 'x' }, ctx);
    assert.equal(wrongSuffix.isError, true);
    assert.equal(wrongSuffix.error?.code, 'E_UNSAFE_PATH');

    const missing = await tool.handler({ content: 'x' }, ctx);
    assert.equal(missing.isError, true);
    assert.equal(missing.error?.code, 'E_INVALID_ARGS');
    assert.match(missing.content, /file/);
  });

  /**
   * ── 经链接到达的 persona 根（2026-10-23 修）──
   *
   * 现场：`write_persona {file:'STATE.md'}` 报 `file 的父目录经符号链接指向 persona/ 之外：
   * STATE.md`，而**同一条路径此前一直是能写的**。根因不是"不该 realpath"，而是
   * "只 realpath 了一边"：她的 persona 根经 junction 到达（真值是 `<安装根>/data/persona`），
   * 而比较的另一侧还是字面的 `<cwd>/data/persona` ⇒ 每次都判成越界。
   *
   * 两条必须同时成立，缺一条这个修法就是"把门拆了"：
   *   · 经链接的**根**、以及经链接但**仍在 persona 内**的父目录 ⇒ 通过；
   *   · 经链接**指向 persona 之外**的父目录 ⇒ 照旧拦住、且一个字节都不落盘。
   */
  test('persona 根经 junction 到达时照样能写（本次修复：两边都展开再比）', async () => {
    const ws = await workspace('persona-via-link-root');
    const realPersona = join(ws, 'real-persona');
    await mkdir(realPersona, { recursive: true });
    await writeFile(join(realPersona, 'STATE.md'), '# 当前状态\n\n旧\n', 'utf8');
    // 根**经链接**到达：字面路径与真值不是同一个字符串（现场就是这个形状）
    const linkedRoot = join(ws, 'persona');
    await symlink(realPersona, linkedRoot, 'junction');

    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: makeRecorder().emit,
      personaRoot: linkedRoot,
    });
    const result = await toolkit.byName('write_persona').handler(
      { file: 'STATE.md', content: '# 当前状态\n\n新\n' },
      makeCtx(ws),
    );

    assert.equal(result.isError, undefined, `经链接的 persona 根不该被误判成越界：${result.content}`);
    assert.equal(await readFile(join(realPersona, 'STATE.md'), 'utf8'), '# 当前状态\n\n新\n');
  });

  test('父目录经 junction 指向别处、但仍在 persona 内 ⇒ 通过（拒绝的是越界，不是链接）', async () => {
    const ws = await workspace('persona-via-link-inside');
    const personaRoot = join(ws, 'persona');
    await mkdir(join(personaRoot, 'real-relationships'), { recursive: true });
    await symlink(join(personaRoot, 'real-relationships'), join(personaRoot, 'RELATIONSHIPS'), 'junction');

    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: makeRecorder().emit,
      personaRoot,
    });
    const result = await toolkit.byName('write_persona').handler(
      { file: 'RELATIONSHIPS/alex.md', content: '# 关系档案：Alex\n' },
      makeCtx(ws),
    );

    assert.equal(result.isError, undefined, `仍在 persona 内的链接必须放行：${result.content}`);
    assert.equal(
      await readFile(join(personaRoot, 'real-relationships', 'alex.md'), 'utf8'),
      '# 关系档案：Alex\n',
    );
  });

  test('**真逃逸**：persona 里的子目录经 junction 指向 persona 之外 ⇒ 必须拦住且不落盘', async () => {
    const ws = await workspace('persona-via-link-escape');
    const personaRoot = join(ws, 'persona');
    const outside = join(ws, 'outside-persona');
    await mkdir(personaRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(personaRoot, 'evil'), 'junction');

    const recorder = makeRecorder();
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: recorder.emit,
      personaRoot,
    });
    const result = await toolkit.byName('write_persona').handler(
      { file: 'evil/x.md', content: '# 逃逸\n' },
      makeCtx(ws),
    );

    assert.equal(result.isError, true, '指向 persona 之外的 junction 必须被拦');
    assert.equal(result.error?.code, 'E_INVALID_ARGS');
    assert.match(result.content, /符号链接指向 persona\/ 之外/);
    // 反向验证：被拒的那一次一个字节都没有落到真值那边
    assert.equal(await exists(join(outside, 'x.md')), false);
    assert.equal(recorder.count('persona/updated'), 0, '被拒绝的写入不得产生 persona/updated');
  });

  test('目标的父目录还不存在（新建）⇒ 仍按最近的存在祖先展开判定（不因"不存在"就放过越界）', async () => {
    const ws = await workspace('persona-via-link-missing');
    const personaRoot = join(ws, 'persona');
    const outside = join(ws, 'outside-missing');
    await mkdir(personaRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(personaRoot, 'evil'), 'junction');

    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: makeRecorder().emit,
      personaRoot,
    });
    // 三层都还不存在：`evil/new/deep.md`——"不存在"不是放行的理由
    const result = await toolkit.byName('write_persona').handler(
      { file: 'evil/new/deep.md', content: '# x\n' },
      makeCtx(ws),
    );
    assert.equal(result.isError, true, '链接之后的目录即使还不存在，也仍属越界');
    assert.equal(await exists(join(outside, 'new', 'deep.md')), false);
  });
});

// ──────────────────────────────── 定时器：一件工具、三个动作 ────────────────────────────────

describe('timer：一件工具三个动作（v35 把 set_timer / cancel_timer / list_timers 并成一件）', () => {
  // 合并的账在 design §4.18 与 tools-audit.md §3.4；这里钉的是**三个能力一个都没丢**：
  // 设一个 → 列得出 → 撤得掉。少任何一条，合并就是"省了 token、丢了出口"。
  test('action=set 布防 → action=list 列得出（含 id）→ action=cancel 撤得掉', async () => {
    const ws = await workspace('timers');
    const timers = new TimerStore(null);
    const recorder = makeRecorder();
    const toolkit = createAdminTools({ timers, emit: recorder.emit, personaRoot: join(ws, 'persona') });
    const ctx = makeCtx(ws);
    const due = new Date(Date.now() + 3_600_000).toISOString();

    const listed0 = await toolkit.byName('timer').handler({ action: 'list' }, ctx);
    assert.equal(listed0.isError, undefined, listed0.content);
    assert.match(listed0.content, /没有任何未触发的定时器/);

    const set = await toolkit.byName('timer').handler(
      { action: 'set', at: due, payload: { note: '喝水' } },
      ctx,
    );
    assert.equal(set.isError, undefined, set.content);
    const timerId = /id=(\S+?)，/.exec(set.content)?.[1];
    assert.equal(typeof timerId, 'string', `应回报 timerId：${set.content}`);
    assert.equal(timers.list().length, 1);
    // 布防的回执必须自带"怎么撤"——合并之后撤销不再是一件独立的工具，她得从回执里知道
    assert.match(set.content, /action=cancel/, '布防回执要指出撤销走哪个动作');

    const listed = await toolkit.byName('timer').handler({ action: 'list' }, ctx);
    assert.equal(listed.isError, undefined, listed.content);
    assert.match(listed.content, /一次性/);
    assert.match(listed.content, /喝水/);
    assert.ok(listed.content.includes(timerId), `列表每行要带 id（撤销靠它）：${listed.content}`);

    const cancelled = await toolkit.byName('timer').handler({ action: 'cancel', timer_id: timerId }, ctx);
    assert.equal(cancelled.isError, undefined);
    assert.match(cancelled.content, /已取消/);
    assert.equal(timers.list().length, 0);

    const again = await toolkit.byName('timer').handler({ action: 'cancel', timer_id: timerId }, ctx);
    assert.equal(again.isError, undefined, '重复取消不是错误：如实回报“不在表里”');
    assert.match(again.content, /不在表里/);
  });

  test('action=set 的 cron 分支照旧：周期条目在列表里带出下一拍', async () => {
    const ws = await workspace('timers-cron');
    const timers = new TimerStore(null);
    const toolkit = createAdminTools({
      timers,
      emit: makeRecorder().emit,
      personaRoot: join(ws, 'persona'),
    });
    const ctx = makeCtx(ws);

    const set = await toolkit.byName('timer').handler({ action: 'set', cron: '0 9 * * 1-5' }, ctx);
    assert.equal(set.isError, undefined, set.content);
    assert.match(set.content, /周期/);

    const listed = await toolkit.byName('timer').handler({ action: 'list' }, ctx);
    assert.match(listed.content, /周期 0 9 \* \* 1-5/);
  });

  test('非法 action 与缺参数给出可操作的错误（一处判据：缺字段 / 取值非法分开说）', async () => {
    const ws = await workspace('timers-bad');
    const timers = new TimerStore(null);
    const toolkit = createAdminTools({
      timers,
      emit: makeRecorder().emit,
      personaRoot: join(ws, 'persona'),
    });
    const ctx = makeCtx(ws);

    // ① 整个 action 字段没给：与全仓其它工具同一条措辞
    const noAction = await toolkit.byName('timer').handler({ at: '2030-01-01T00:00:00+08:00' }, ctx);
    assert.equal(noAction.isError, true);
    assert.equal(noAction.error?.code, 'E_INVALID_ARGS');
    assert.match(noAction.content, /action/);

    // ② 给了但不是四个取值之一：必须把四个取值摆出来，否则她只能瞎试
    const badAction = await toolkit.byName('timer').handler({ action: 'frobnicate' }, ctx);
    assert.equal(badAction.isError, true);
    assert.equal(badAction.error?.code, 'E_INVALID_ARGS');
    assert.match(badAction.content, /set \/ wait \/ cancel \/ list/);

    // ③ action=set 但 at/cron 一个都没给
    const none = await toolkit.byName('timer').handler({ action: 'set' }, ctx);
    assert.equal(none.isError, true);
    assert.equal(none.error?.code, 'E_INVALID_ARGS');
    assert.match(none.content, /at 或 cron/);

    const badAt = await toolkit.byName('timer').handler({ action: 'set', at: '2026-09-30 14:00' }, ctx);
    assert.equal(badAt.isError, true);
    assert.match(badAt.content, /ISO 8601/);

    const badCron = await toolkit.byName('timer').handler({ action: 'set', cron: '99 * * * *' }, ctx);
    assert.equal(badCron.isError, true);
    assert.match(badCron.content, /cron/);

    // ④ action=cancel 但没给 timer_id
    const noId = await toolkit.byName('timer').handler({ action: 'cancel' }, ctx);
    assert.equal(noId.isError, true);
    assert.equal(noId.error?.code, 'E_INVALID_ARGS');
    assert.match(noId.content, /timer_id/);

    // ⑤ 五条非法输入一个都不许落进表里（布防失败却留下条目是最坏的那种"看起来成功了"）
    assert.equal(timers.list().length, 0);
  });
});

// ──────────────────────────────── speak：告警出口与三路投递 ────────────────────────────────

describe('speak：告警出口与三路投递', () => {
  // v27 删掉了 notify 工具（与 speak 的第二路重复）：原先那条「notify 返回真实送达状态」
  // 的用例随之删除，但它锁的**两条纪律**不能在删工具时一起丢掉，所以在这里以 speak 为载体钉住：
  //   ① 渠道失败要把原因回给模型，不许假装成功；
  //   ② 未注入出口时如实说"跳过"，而不是静默。
  test('speak 第二路：渠道失败如实回报，未配置出口时如实说跳过（原 notify 的两条纪律）', async () => {
    const ws = await workspace('speak-notify-path');
    const personaRoot = join(ws, 'persona');
    const ctx = makeCtx(ws);

    const failing = createAdminTools({
      timers: new TimerStore(null),
      emit: makeRecorder().emit,
      personaRoot,
      notifier: { send: async () => ({ ok: false, reason: '通道 503' }) },
    });
    const failed = await failing.byName('speak').handler({ text: '跑完了' }, ctx);
    assert.equal(failed.isError, undefined, failed.content);
    assert.match(failed.content, /推送失败[：，]/u, '失败原因必须回给模型（v74：中文一格，不印英文原文）');

    const bare = createAdminTools({ timers: new TimerStore(null), emit: makeRecorder().emit, personaRoot });
    const skipped = await bare.byName('speak').handler({ text: '跑完了' }, ctx);
    // v74：出口没配时**一个字都不印**（成功回执只回答"发出去了"这件事）
    assert.match(skipped.content, /投递：本轮没有 IM 会话可发/u, skipped.content);
    assert.doesNotMatch(skipped.content, /推送/u, '成功时不印"主动推送：跳过"');
  });

  test('speak 三路投递：日志 + 推送 + 回投，逐路写 speak/sent', async (t) => {
    const ws = await workspace('speak');
    const recorder = makeRecorder();
    const pushed: string[] = [];
    const posted: Array<{ target: ReplyTarget; text: string }> = [];
    const replyPoster: ReplyPoster = {
      async post(target, text) {
        posted.push({ target, text });
        return { ok: true, status: 200 };
      },
    };
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: recorder.emit,
      personaRoot: join(ws, 'persona'),
      notifier: { send: async (message) => { pushed.push(message.body); return { ok: true }; } },
      replyTargetOf: (ctx) => ({ url: 'http://127.0.0.1:9/reply', idempotencyKey: `turn-${ctx.turn}` }),
      replyPoster,
    });
    const ctx = makeCtx(ws);

    // 逐段之间要按打字节奏等：把 sleep 注入成空实现，否则这条用例会真睡
    setSleepForTest(async () => {});
    t.after(() => { setSleepForTest(null); });

    // 分段是门内的投递形态：这条夹具 15 字，稳在硬门（`SPEAK_TEXT_MAX`）以内、也切成两条。
    // 门的两侧（40 通过 / 41 被拒）在「硬门」那条用例里钉着，分段本身在「分段回来了」那条里钉着。
    const spoken = '长任务跑完了，共 42 个文件';
    const result = await toolkit.byName('speak').handler({ text: spoken }, ctx);
    assert.equal(result.isError, undefined, result.content);
    // v74（用户最终口径）：回执只留三态——这条正文 15 字（≤25）⇒ 逐字 `发送成功`。
    // "切成两条"这件事不再进回执（它是投递形态，不是她要的判断）；凭据本身仍在事件里（下面几行钉着）。
    assert.deepEqual(result.content.split('\n').filter(line => line !== ''), ['- 发送成功'], result.content);

    // 内容本体逐段落在 message/assistant（schema §4：发言记录与内容分离）
    const spokenSegments = recorder.events
      .filter((event) => event.type === 'message/assistant')
      .map((event) => (event.data as { text: string }).text);
    assert.deepEqual(spokenSegments, ['长任务跑完了', '共 42 个文件'], '句末标点消失，逗号处断开');
    const channels = recorder.events
      .filter((event) => event.type === 'speak/sent')
      .map((event) => (event.data as { channel: string }).channel)
      .sort();
    assert.deepEqual(channels, ['log', 'log', 'notify', 'reply-url'], 'log 逐段，notify 与回投各一条回执');
    const charCounts = recorder.events
      .filter((event) => event.type === 'speak/sent')
      .map((event) => (event.data as { chars: number }).chars)
      .sort((a, b) => a - b);
    assert.deepEqual(charCounts, [6, 8, 15, 15], 'log 路按段计字数；notify 与 reply-url 按整篇计');
    assert.equal(pushed.length, 1, '告警出口整篇一条，不刷屏');
    assert.equal(posted.length, 2, '回投逐段发：IM 那边一条条收');
    assert.equal(posted[0]?.target.idempotencyKey, 'turn-7', '幂等键 = turn 号');
  });

  test('逐段节奏：等的是**待发送那一段**的字数，不是上一段', async (t) => {
    const ws = await workspace('speak-pace');
    const waits: number[] = [];
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: makeRecorder().emit,
      personaRoot: join(ws, 'persona'),
    });
    // 逗号处一律断开 → 段数确定；sleep 换成人账，看等的是多少毫秒。
    // 12 字是"太短不拆"的下限，所以这一段挑够长的（否则整段一条，节奏就测不出来了）
    setSleepForTest(async (ms) => {
      waits.push(ms);
    });
    t.after(() => {
      setSleepForTest(null);
    });

    const result = await toolkit.byName('speak').handler({ text: '甲乙丙丁戊，己庚辛壬癸子' }, makeCtx(ws));
    assert.equal(result.isError, undefined, result.content);
    // 两段：『甲乙丙丁戊』(5 字) 与 『己庚辛壬癸子』(6 字)。**第一段也要等**——她按下的不是
    // "发送"，是"开始打字"；默认速度 90 字/分钟 → 每字 60000/90 ≈ 666.7ms，
    // 于是 5 字 → 3333ms、6 字 → 4000ms（都是待发送那一段自己的字数，不是上一段的）。
    assert.deepEqual(waits, [3333, 4000], '每一段都等它自己要打多久');
  });

  test('发言节奏可关：typingEffect=false 时一段都不等，全部立刻发完', async (t) => {
    const ws = await workspace('speak-notyping');
    const waits: number[] = [];
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: makeRecorder().emit,
      personaRoot: join(ws, 'persona'),
      speakTyping: { typingEffect: false, charsPerMinute: 90 },
    });
    setSleepForTest(async (ms) => { waits.push(ms); });
    t.after(() => {
      setSleepForTest(null);
    });

    const result = await toolkit.byName('speak').handler({ text: '甲乙丙丁戊，己庚辛壬癸子' }, makeCtx(ws));
    assert.equal(result.isError, undefined, result.content);
    assert.deepEqual(waits, [], '关掉打字效果就是"内容尽快到手"，等待应当一次都没有');
    // 2026-10-20（R4）：这条以前还断言回执里有 `/间隔共等 0\.0s/`（那一行已删，是机械复述）。
    // 判据本来就在上面那句 `waits` 的读数里——**真的没睡**比"回执里写着 0.0s"强；
    // 而"说成几条"这件事在别的用例里由 `message/assistant` 的逐段内容钉着。
  });

  test('打字速度可调：每分钟字数直接决定每段等多久', async (t) => {
    const ws = await workspace('speak-speed');
    const waits: number[] = [];
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: makeRecorder().emit,
      personaRoot: join(ws, 'persona'),
      speakTyping: { typingEffect: true, charsPerMinute: 300 },
    });
    setSleepForTest(async (ms) => { waits.push(ms); });
    t.after(() => {
      setSleepForTest(null);
    });

    await toolkit.byName('speak').handler({ text: '甲乙丙丁戊，己庚辛壬癸子' }, makeCtx(ws));
    // 300 字/分钟 = 每字 200ms：5 字 → 1000、6 字 → 1200
    assert.deepEqual(waits, [1000, 1200]);
  });

  test('回投与日志同节奏：IM 那条跟着每一段走，不是等 sleep 花光才一股脑发', async (t) => {
    // 实测踩过的坑：两路各写一遍循环时，第一遍把 sleep 全用在日志上、第二遍才连着 POST，
    // 于是界面上一条条往外蹦、QQ 那边等 speak 快结束了才涌出来。两路必须共用同一个节奏。
    const ws = await workspace('speak-sync');
    const timeline: string[] = [];
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: (type, data) => {
        if (type === 'message/assistant') timeline.push(`log:${(data as { text: string }).text}`);
      },
      personaRoot: join(ws, 'persona'),
      replyTargetOf: () => ({ url: 'qq:c2c:OPENID_B', idempotencyKey: 'turn-1' }),
      replyPoster: {
        async post(_target, text) {
          timeline.push(`im:${text}`);
          return { ok: true, status: 200 };
        },
      },
    });
    setSleepForTest(async (ms) => { timeline.push(`sleep:${ms}`); });
    t.after(() => {
      setSleepForTest(null);
    });

    const result = await toolkit.byName('speak').handler({ text: '甲乙丙丁戊，己庚辛壬癸子' }, makeCtx(ws));
    assert.equal(result.isError, undefined, result.content);
    assert.deepEqual(timeline, [
      'sleep:3333', 'log:甲乙丙丁戊', 'im:甲乙丙丁戊',
      'sleep:4000', 'log:己庚辛壬癸子', 'im:己庚辛壬癸子',
    ], '每段都是「等它自己打完 → 落日志 → 发 IM」；IM 落在 sleep 之前就等于旧的一股脑行为');
  });

  test('被打断（首段还没发）：一条都不发，回执说清"说了什么、什么没说"', async (t) => {
    // 她在按键之前对方又开口了——那半截话根本不该出去
    const ws = await workspace('speak-interrupt-first');
    const recorder = makeRecorder();
    let epoch = 0;
    const posted: string[] = [];
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: recorder.emit,
      personaRoot: join(ws, 'persona'),
      replyTargetOf: () => ({ url: 'qq:c2c:OPENID_B', idempotencyKey: 'turn-1' }),
      replyPoster: { async post(_target, text) { posted.push(text); return { ok: true, status: 200 }; } },
      userSpoke: () => ({ text: '你在忙吗', wakeSeq: 4242 }),
    });
    // 打字节奏的等待里人开口了（真实触发点是 real-loop 的 WakeSink，这里直接推计数）
    setSleepForTest(async () => { epoch += 1; });
    t.after(() => {
      setSleepForTest(null);
    });

    // 销账口：真被打断才许销——销的是**打断她的那条**（回执引用的与销账的必须是同一条）
    const claimed: number[] = [];
    const ctx = {
      ...makeCtx(ws), interruptEpoch: () => epoch,
      claimInterruption: (wakeSeq: number) => { claimed.push(wakeSeq); },
    };
    const result = await toolkit.byName('speak').handler({ text: '甲乙丙丁戊，己庚辛壬癸子' }, ctx);

    assert.equal(result.isError, undefined, result.content);
    assert.match(result.content, /发言被打断/);
    assert.match(result.content, /他刚说「你在忙吗」/, '要把对方的新话摆出来，她才知道该针对什么重说');
    assert.match(result.content, /一条都没发/);
    assert.match(result.content, /己庚辛壬癸子/, '没发出去的内容要原样告诉她');
    assert.match(result.content, /重新组织语言/);
    assert.deepEqual(claimed, [4242], '被打断就把那条输入销账：不销，下一轮她会把同一个问题再答一遍');
    assert.deepEqual(posted, [], '被打断就一条都不发');
    assert.equal(recorder.count('message/assistant'), 0, '没发出去的话不许落进对话流');
  });

  test('被打断之后重新说一次：这一次要能正常说完（一次打断不许锁死整轮）', async (t) => {
    // 实测事故：早先用 AbortSignal 做打断信号，它一旦 abort 就永远是 aborted——
    // 她被打断一次之后，这一轮剩下的每一次 speak 都在第一片等待里被判成"又被打断"，
    // 连着十二次一句也没发出去，只能等下个 turn 才开口。
    const ws = await workspace('speak-interrupt-recover');
    const recorder = makeRecorder();
    let epoch = 0;
    let bumped = false;
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: recorder.emit,
      personaRoot: join(ws, 'persona'),
      userSpoke: () => ({ text: '等等', wakeSeq: 77 }),
    });
    // 只有**第一次**等待期间人开口；之后的等待里计数不再变
    setSleepForTest(async () => {
      if (!bumped) {
        bumped = true;
        epoch += 1;
      }
    });
    t.after(() => {
      setSleepForTest(null);
    });

    const claimed: number[] = [];
    const ctx = {
      ...makeCtx(ws), interruptEpoch: () => epoch,
      claimInterruption: (wakeSeq: number) => { claimed.push(wakeSeq); },
    };
    const first = await toolkit.byName('speak').handler({ text: '甲乙丙丁戊，己庚辛壬癸子' }, ctx);
    assert.match(first.content, /发言被打断/, '第一次确实被打断');

    const second = await toolkit.byName('speak').handler({ text: '戊己庚辛壬癸，子丑寅卯辰巳' }, ctx);
    assert.ok(!second.content.includes('被打断'), `第二次不该再被打断：${second.content}`);
    // 2026-10-20（R4）：抬头 `发言已处理：` 已删（它每条回执都一样）。这条用例要守的是
    // "第二次**正常处理完**"——判据换成正常回执才有的那一行（没有回投地址 ⇒ 本机提示）。
    assert.match(second.content, /投递：本轮没有 IM 会话可发/u);
    assert.equal(recorder.count('message/assistant'), 2, '第二次的两段都该正常落进对话流');
    assert.deepEqual(claimed, [77], '销账只发生在那一次真被打断上，第二次说完不再销');
  });

  test('被打断（已经说出去一条）：剩下的不发，回执点明哪条收不回来', async (t) => {
    const ws = await workspace('speak-interrupt-mid');
    const recorder = makeRecorder();
    let epoch = 0;
    const posted: string[] = [];
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: recorder.emit,
      personaRoot: join(ws, 'persona'),
      replyTargetOf: () => ({ url: 'qq:c2c:OPENID_B', idempotencyKey: 'turn-1' }),
      replyPoster: {
        async post(_target, text) {
          posted.push(text);
          // 第一条刚落地，对方就说话了 —— 打断发生在下一段的打字等待里
          epoch += 1;
          return { ok: true, status: 200 };
        },
      },
      userSpoke: () => ({ text: '等等', wakeSeq: 88 }),
    });
    setSleepForTest(async () => {});
    t.after(() => {
      setSleepForTest(null);
    });

    const claimed: number[] = [];
    const ctx = {
      ...makeCtx(ws), interruptEpoch: () => epoch,
      claimInterruption: (wakeSeq: number) => { claimed.push(wakeSeq); },
    };
    const result = await toolkit.byName('speak').handler({ text: '甲乙丙丁戊，己庚辛壬癸子' }, ctx);

    assert.equal(result.isError, undefined, result.content);
    assert.deepEqual(claimed, [88], '说了一半被打断也算"她看见了"：照样销账');
    assert.deepEqual(posted, ['甲乙丙丁戊'], '已经发出去的那条收不回来');
    assert.deepEqual(
      recorder.events.filter((e) => e.type === 'message/assistant').map((e) => (e.data as { text: string }).text),
      ['甲乙丙丁戊'],
      '后面的段落一个字都不许再落',
    );
    assert.match(result.content, /已经发出去的（收不回来了）：1 条——甲乙丙丁戊/);
    // 未发的那半截只有一条：不编号（加了「1.」既不帮读、又显得像在递清单），但条数照给
    assert.match(result.content, /没来得及发的（1 条）：己庚辛壬癸子/);
  });

  test('打断不靠等待：关掉打字效果（一次都不等）时插话，剩下的段落照样一个字不发', async (t) => {
    // 为什么必须有这条：打断原先**只**在打字等待的那几片轮询里判。等待有两个零等待的口子——
    // ① `typingEffect=false`；② 一趟总预算 90s 用尽之后剩下的段不再等。那两个口子上，
    // 判据一次都没被读过，于是"人已经插话"这件事她完全看不见，后面几段一口气全吐出去。
    // 这条用例把那个口子钉住：**等待为 0 也必须回头看一眼计数**。
    const ws = await workspace('speak-interrupt-nowait');
    const recorder = makeRecorder();
    let epoch = 0;
    let sentOnce = false;
    // 在"第一段落进对话流"那一刻推计数：真实触发点是 real-loop 的计数（人插话），
    // 这里模拟的正是"她已经说出第一条，人这时插话"——与 17:38 那轮同一形状。
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: (type, data) => {
        recorder.emit(type, data);
        if (type === 'message/assistant' && !sentOnce) {
          sentOnce = true;
          epoch += 1;
        }
      },
      personaRoot: join(ws, 'persona'),
      // 关掉打字效果：perCharMs = 0，循环里一次 sleep 都不会发生
      speakTyping: { typingEffect: false, charsPerMinute: 90 },
      userSpoke: () => ({ text: '和我的私聊是私有的，没关系', wakeSeq: 4242 }),
    });
    const claimed: number[] = [];
    const ctx = {
      ...makeCtx(ws), interruptEpoch: () => epoch,
      claimInterruption: (wakeSeq: number) => { claimed.push(wakeSeq); },
    };
    const result = await toolkit.byName('speak').handler({ text: '甲乙丙丁戊，己庚辛壬癸子' }, ctx);

    assert.equal(result.isError, undefined, result.content);
    assert.match(result.content, /发言被打断/, `等待为 0 也不能漏掉插话：${result.content}`);
    assert.deepEqual(
      recorder.events.filter((e) => e.type === 'message/assistant').map((e) => (e.data as { text: string }).text),
      ['甲乙丙丁戊'],
      '已经发出去的第一条不受影响，后面那条一个字都不许再落',
    );
    assert.match(result.content, /已经发出去的（收不回来了）：1 条——甲乙丙丁戊/);
    assert.match(result.content, /没来得及发的（1 条）：己庚辛壬癸子/);
    assert.deepEqual(claimed, [4242], '真被打断就销账，销的是打断她的那一条');
  });

  test('插话发生在开口之前：这一段话照常说完（打断的语义是"开口之后又来插话"）', async (t) => {
    // 反方向的一条：`interruptEpoch` 在 speak 开始**之前**就变过（他把 speak 那句话打出来时
    // 人已经开过口了）。这不是"被打断"——她还一个字都没出去，该不该说由她想；
    // 若在这里也判打断，她就永远说不出一句针对新消息的话。
    const ws = await workspace('speak-epoch-before');
    const recorder = makeRecorder();
    let epoch = 5;
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: recorder.emit,
      personaRoot: join(ws, 'persona'),
      speakTyping: { typingEffect: false, charsPerMinute: 90 },
      userSpoke: () => ({ text: '早先那句', wakeSeq: 7 }),
    });
    const claimed: number[] = [];
    const ctx = {
      ...makeCtx(ws), interruptEpoch: () => epoch,
      claimInterruption: (wakeSeq: number) => { claimed.push(wakeSeq); },
    };
    const result = await toolkit.byName('speak').handler({ text: '甲乙丙丁戊，己庚辛壬癸子' }, ctx);

    assert.ok(!result.content.includes('被打断'), `基准取的是开口那一刻：${result.content}`);
    assert.equal(recorder.count('message/assistant'), 2, '两段都该发出去');
    assert.deepEqual(claimed, [], '没被打断就不销账——那条消息要留在队列里等她下一轮看见');
  });

  test('没被打断时一切照旧：插话计数在场但没变过，不改变任何行为', async (t) => {
    const ws = await workspace('speak-nointerrupt');
    const recorder = makeRecorder();
    const epoch = 0;
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: recorder.emit,
      personaRoot: join(ws, 'persona'),
      // 计数没变说明她没被打断；此时人**确实**开过口（noteUserSpoke 无条件跑），
      // 所以这条新话她根本没看见——销账口一次都不许被调到（销了就是把消息整个吞掉）
      userSpoke: () => ({ text: '刚好在她开口前说的那句', wakeSeq: 99 }),
    });
    setSleepForTest(async () => {});
    t.after(() => {
      setSleepForTest(null);
    });

    const claimed: number[] = [];
    const ctx = {
      ...makeCtx(ws), interruptEpoch: () => epoch,
      claimInterruption: (wakeSeq: number) => { claimed.push(wakeSeq); },
    };
    const result = await toolkit.byName('speak').handler({ text: '甲乙丙' }, ctx);
    assert.equal(result.isError, undefined, result.content);
    assert.ok(!result.content.includes('被打断'));
    assert.equal(recorder.count('message/assistant'), 1);
    assert.deepEqual(claimed, [], '没被打断就不销账：那条消息要留在队列里等她下一轮看见');
  });

  test('回执形状：九条气泡只出去三条 → 编号点名第 1~3 条已发、第 4~6 条没发，各逐条给内容', async (t) => {
    // 用户 2026-10-01 的原设计：「返回结果告诉她『以下内容还没来得及发送，考虑重新组织语言』」。
    // 2026-10-03 补的形状要求：**她得一眼看出"第 4 条起没出去、内容是什么"**——
    // 只说"被取消"或静默丢掉，她就只能猜自己说到哪儿了，而重新组织语言必须建立在
    // "我上一句停在哪"之上。这条用例把那个形状钉死（编号 + 条数 + 不重复已发的内容）。
    const ws = await workspace('speak-receipt-shape');
    const recorder = makeRecorder();
    let epoch = 0;
    // 六个逗号 → 六条气泡；第三条落库之后人插话。
    // **整段必须压在硬门（`SPEAK_TEXT_MAX`）以内**：超门的话 speak 直接拒绝、一个字都不发，
    // 这条用例锁的"第 4 条起没出去"就整个失效（连第一条都不会有）。这一份正好 40 字（贴线）。
    const text = '第一句话在这里，第二句也在这，三句在这里了，四句在这呢，五句在这里呀，六句在这吧';
    assert.equal(charCount(text), SPEAK_TEXT_MAX, '夹具必须正好压在硬门上（41 就会整段被拒）');
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: (type, data) => {
        recorder.emit(type, data);
        if (type === 'message/assistant' && recorder.count('message/assistant') === 3) epoch += 1;
      },
      personaRoot: join(ws, 'persona'),
      speakTyping: { typingEffect: false, charsPerMinute: 90 },
      userSpoke: () => ({ text: '和我的私聊是私有的，没关系', wakeSeq: 4242 }),
    });
    const ctx = {
      ...makeCtx(ws), interruptEpoch: () => epoch,
      claimInterruption: () => {},
    };

    const result = await toolkit.byName('speak').handler({ text }, ctx);
    const lines = result.content.split('\n');
    assert.equal(lines.length, 4, `回执就四行（多了就是把同一段话抄两遍）：\n${result.content}`);
    assert.match(lines[0]!, /发言被打断：他刚说「和我的私聊是私有的，没关系」。/);
    assert.match(lines[1]!, /^- 已经发出去的（收不回来了）：3 条——第一句话在这里／第二句也在这／三句在这里了$/);
    assert.match(
      lines[2]!,
      /^- 没来得及发的（3 条）：1\. 四句在这呢／2\. 五句在这里呀／3\. 六句在这吧$/,
      '未发的必须逐条编号点名——她据此才看得出"第 4 条起没出去"',
    );
    // 第三行不重复已发的内容（重复 = 同一段话在上下文里出现两次，且容易让她把已发的重讲一遍）
    assert.ok(!lines[2]!.includes('第一句话'), `未发那行不许夹带已发的内容：${lines[2]}`);
    assert.match(lines[3]!, /重新组织语言/);
    assert.match(lines[3]!, /^别把剩下这半截硬接上去/);
  });

  test('speak 的 to：发到指定会话；sid 非法就如实报错，不静默', async (t) => {
    const ws = await workspace('speak-to');
    const recorder = makeRecorder();
    const posted: Array<{ target: ReplyTarget; text: string }> = [];
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: recorder.emit,
      personaRoot: join(ws, 'persona'),
      replyPoster: {
        async post(target, text) {
          posted.push({ target, text });
          return { ok: true, status: 200 };
        },
      },
    });
    setSleepForTest(async () => {});
    t.after(() => {
      setSleepForTest(null);
    });

    const ok = await toolkit.byName('speak').handler({ text: '在的', to: 'qq:c2c:OPENID_B' }, makeCtx(ws));
    assert.equal(ok.isError, undefined, ok.content);
    // sid 与回投地址同形：原样交给通道，不做二次加工
    assert.equal(posted[0]?.target.url, 'qq:c2c:OPENID_B');
    assert.match(ok.content, /发送成功/u);
    assert.equal(
      (recorder.last('speak/sent') as { sid?: string }).sid,
      'qq:c2c:OPENID_B',
      'speak/sent 带 sid：她跟谁说过话，以后能复盘',
    );

    // 形态不对就不发，而且要说清 sid 从哪来（不弄一个“看起来发出去了”的假成功）
    const bad = await toolkit.byName('speak').handler({ text: '在的', to: '乱写' }, makeCtx(ws));
    assert.equal(bad.isError, true);
    assert.match(bad.content, /外部会话清单/);
    assert.equal(posted.length, 1, '非法 sid 不得产生任何投递');
  });

  test('speak 一路失败不影响另两路（回投被拒时仍留有发言记录）', async () => {
    const ws = await workspace('speak-partial');
    const recorder = makeRecorder();
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: recorder.emit,
      personaRoot: join(ws, 'persona'),
      notifier: { send: async () => ({ ok: false, reason: '通道不可用' }) },
      replyTargetOf: () => ({ url: 'http://127.0.0.1:9/reply', idempotencyKey: 'turn-1' }),
      replyPoster: { post: async () => ({ ok: false, reason: 'HTTP 500' }) },
    });

    const result = await toolkit.byName('speak').handler({ text: '你好' }, makeCtx(ws));
    assert.equal(result.isError, undefined);
    assert.match(result.content, /推送失败[：，]/u);
    // 回执不说"第 N 条失败"：那读起来像"再试一次也许就成了"，实测她为此在群聊那轮
    // 换了五次措辞。**一条都没发出去时**（这里 2 字 = 一段）说清"这一条没有送达，
    // 本机那一段不等于他收到了"，并给出"还要不要试"的判断（2026-10-08 用户的口径）。
    assert.match(result.content, /投递失败：这一条没有送达|失败，/u);
    assert.match(result.content, /失败，/u);
    assert.match(result.content, /不必重试/u, `失败必须给重试判断：${result.content}`);
    assert.doesNotMatch(result.content, /HTTP 500/u, 'v74：不印英文原文/内部码');
    assert.equal(recorder.count('speak/sent'), 1, '只有日志那一路送达');
    assert.equal((recorder.last('speak/sent') as { channel: string }).channel, 'log');

    // 没有 IM 会话可发时说清"跳过的只是那一跳"，而不是静默省略；
    // 更要紧的是别让她读成"整条发言失败了"——实测她读到旧措辞后会把同一句再说四遍
    const noReply = createAdminTools({
      timers: new TimerStore(null),
      emit: recorder.emit,
      personaRoot: join(ws, 'persona'),
    });
    const skipped = await noReply.byName('speak').handler({ text: '你好' }, makeCtx(ws));
    // 2026-10-20（用户实测：「这种不能继续缩吗」）：这一句从三段压成**一行**，但
    // **三个信息点一个不少**——判据就是下面三处子串：
    //   ① 跳过 + 原因（本轮没有 IM 会话可发）
    //   ② 只在本机对话流、≠他收到
    //   ③ 要发到那边就带 `to`
    assert.match(skipped.content, /投递：本轮没有 IM 会话可发（跳过）/, `① 跳过与原因：${skipped.content}`);
    assert.match(skipped.content, /只落在本机对话流，不等于他收到了/u,
      `② 只在本机、不等于他收到：${skipped.content}`);
    assert.match(skipped.content, /要发到那边，带 `to` 再发一次/u, `③ 给出去路：${skipped.content}`);
    // 压掉的两句是 ② 的另一面（"人在界面能看见" = 界面就是这条流 / "下一轮看不到这一篇" =
    // 没到那边自然读不回来）：同一层意思不再说两遍——用户问的就是这个。
    assert.equal(skipped.content.includes('人在界面能看见'), false, `同一件事只留一句：${skipped.content}`);
    assert.equal(skipped.content.includes('不会看到这一篇'), false, `同一件事只留一句：${skipped.content}`);
  });

  test('回本轮叫你的人：带上 msg_id，这条才算被动回复而不是主动消息', async () => {
    // 实测事故（2026-10-01 群聊）：她的每条回复都没带 msg_id，被平台判成主动消息，
    // 撞上「主动消息失败, 无权限」（40034105）——连着试了五次。而平台规则很明确：
    // 携带 msg_id 的才是"对用户消息的回复"，走回复窗口（群聊 5 分钟 / 5 次），不需要那个权限。
    const ws = await workspace('speak-msgid');
    const recorder = makeRecorder();
    const seen: ReplyTarget[] = [];
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: recorder.emit,
      personaRoot: join(ws, 'persona'),
      currentWakeChannel: () => ({
        channel: 'qq-official', chatType: 'group-at', person: 'u1', chatId: 'G1',
        text: '嗨', messageId: 'MSG-123', msgSeq: 1,
      }),
      replyPoster: { async post(target) { seen.push(target); return { ok: true, status: 200 }; } },
    });

    // ① 不指定 to：回本轮叫醒她的那个会话 —— 那就是"回复那条消息"
    await toolkit.byName('speak').handler({ text: '在的' }, makeCtx(ws));
    assert.equal(seen[0]?.url, 'qq:group:G1');
    assert.equal(seen[0]?.msgId, 'MSG-123', '少了 msg_id 就变成主动消息，群聊会因无权限失败');

    // ② 显式 to 指着同一个会话：仍然是回复，照样带 msg_id
    await toolkit.byName('speak').handler({ text: '在的', to: 'qq:group:G1' }, makeCtx(ws));
    assert.equal(seen[1]?.msgId, 'MSG-123', 'to 写的是本轮的会话时，它还是回复');

    // ③ 显式 to 指着别人：那是真正的主动消息，没有 msg_id 可用（要权限、有配额）
    await toolkit.byName('speak').handler({ text: '在的', to: 'qq:c2c:OTHER' }, makeCtx(ws));
    assert.equal(seen[2]?.msgId, undefined, '发给别人是主动消息，不能假装被动');
  });

  test('权限类投递失败：回执要说清"重试无用"，别让她一遍遍换措辞', async () => {
    const ws = await workspace('speak-denied');
    const recorder = makeRecorder();
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: recorder.emit,
      personaRoot: join(ws, 'persona'),
      replyTargetOf: () => ({ url: 'qq:group:G1', idempotencyKey: 'turn-1' }),
      replyPoster: {
        post: async () => ({ ok: false, reason: 'HTTP 400 code=40034105 主动消息失败, 无权限' }),
      },
    });

    const result = await toolkit.byName('speak').handler({ text: '嗨' }, makeCtx(ws));
    assert.equal(result.isError, undefined, '投递失败不是工具错误：日志那一路照样落了盘');
    // v74（用户最终口径）：失败回执 = `失败，<中文原因>`——原因要能判断下一步，**不印内部码/英文**。
    // 原口径那串"向该会话发送消息时存在权限问题，不必重试"整句压成了 `没有权限（平台拒绝），不必重试`。
    assert.match(result.content, /失败，没有权限（平台拒绝），不必重试/u, result.content);
    assert.doesNotMatch(result.content, /40034105|HTTP 400/u, '不印内部码/英文原文');
    assert.doesNotMatch(result.content, /report|改道|别再说一遍/, '不该给建议');
  });

  // ── speak 的长度口径：25 = 目标 / 40 = 硬门（拒绝）/ 分段 = 门内的投递形态 ──

  test('描述里的字数上限由常量拼出来（描述与判据不许两处真相）', async () => {
    const ws = await workspace('speak-desc');
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: makeRecorder().emit,
      personaRoot: join(ws, 'persona'),
    });
    const description = toolkit.byName('speak').description;

    // **v74（用户 2026-10-20）：desc 只留"怎么调"，不留"该怎么想"**——
    // "写多长 / 最多两个逗号 / 别重复发"搬进 `SELF_BRIEF` §2.1；描述只留参数、必填、一行示例。
    // 所以这里钉的是"描述小、能调"，以及“两个数仍在判据同源处（SELF_BRIEF / 常量）”。
    assert.match(description, /text 必填/u, description);
    assert.match(description, /\{text:/u, `描述要有一行示例：${description}`);
    assert.ok(estimateTokens(description) <= 60,
      `描述该是"怎么调"那一档（≤60 token，与另外几件同一道线）：${estimateTokens(description)}`);
    assert.equal(SPEAK_TEXT_SUGGESTED_MAX, 25, '25 是用户定的说话风格目标，不许按实测分布放宽');
    // 两个数（25 / 40）与"成功不必重复发"都必须在**她发之前读得到**的地方
    assert.match(SELF_BRIEF, /正文尽量 ≤25 字/u, '25 字这条要在自述里');
    assert.match(SELF_BRIEF, /超 40 字退回/u, '硬门 40 也要在自述里');
    assert.match(SELF_BRIEF, /成功了就不必重复发送/u, '"不必重复发送"这条规矩在自述里');

    // **"这是聊天用的、可以不成句"**：v74 起写在 `text` 参数描述里（参数不进 <60 那份预算）。
    const textParam = (toolkit.byName('speak').parameters['properties'] as Record<string, { description: string }>)['text']!;
    for (const word of ['口语', '残缺', '倒装']) {
      assert.match(
        textParam.description,
        new RegExp(word, 'u'),
        `text 参数描述要明说允许口语化（缺「${word}」）：${textParam.description}`,
      );
    }
  });

  test('25/26 字的回执两态：25 ⇒ `发送成功`；26 ⇒ `成功，但超25字限制（26 字）`（v74 取代旧"提醒"）', async () => {
    const ws = await workspace('speak-remind');
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: makeRecorder().emit,
      personaRoot: join(ws, 'persona'),
      // 关掉打字节奏：这一条锁的是回执形态，不是节奏（节奏有自己的用例）
      speakTyping: { typingEffect: false, charsPerMinute: 90 },
      replyTargetOf: () => ({ url: 'qq:group:G1', idempotencyKey: 'turn-remind' }),
      replyPoster: { post: async () => ({ ok: true, status: 200 }) },
    });
    const tool = toolkit.byName('speak');

    // ① 正好 25 字：`发送成功`（没有"提醒："那段附注——v74 起回执只报结果）
    const onLine = await tool.handler({ text: '甲'.repeat(SPEAK_TEXT_SUGGESTED_MAX) }, makeCtx(ws));
    assert.equal(onLine.isError, undefined, onLine.content);
    assert.deepEqual(onLine.content.split('\n').filter(line => line !== ''), ['- 发送成功'], onLine.content);
    assert.doesNotMatch(onLine.content, /提醒：/u, 'v74：不再追附注（超限信息在下一态那一行里）');

    // ② 刚过线一个字：`成功，但超25字限制（26 字）`——**不是失败**
    const justOver = await tool.handler({ text: '甲'.repeat(SPEAK_TEXT_SUGGESTED_MAX + 1) }, makeCtx(ws));
    assert.equal(justOver.isError, undefined, justOver.content);
    assert.deepEqual(justOver.content.split('\n').filter(line => line !== ''),
      ['- 成功，但超25字限制（26 字）'], justOver.content);
    assert.equal(justOver.content.includes('失败'), false, '超限不是失败');

    // ③ 远过线：同一个形态，N 跟着变（判据只有一条线：按 runes 数正文）
    const wayOver = await tool.handler({ text: '甲'.repeat(SPEAK_TEXT_SUGGESTED_MAX + 10) }, makeCtx(ws));
    assert.deepEqual(wayOver.content.split('\n').filter(line => line !== ''),
      ['- 成功，但超25字限制（35 字）'], wayOver.content);
  });

  test('硬门：41 字直接拒绝（不截断、不照发），拒绝文案给全三条出路', async () => {
    const ws = await workspace('speak-gate');
    const recorder = makeRecorder();
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: recorder.emit,
      personaRoot: join(ws, 'persona'),
      // 关掉打字节奏：这一条锁的是"门"，不锁等多久
      speakTyping: { typingEffect: false, charsPerMinute: 90 },
      // 目标故意给一个：门必须在**解析目标之前**就拦下（一句话超了门，就没有"发给谁"的问题了）
      replyTargetOf: () => ({ url: 'qq:group:G1', idempotencyKey: 'turn-gate' }),
    });
    const tool = toolkit.byName('speak');

    // ① **正好 40 字：通过**（判据是「超过」，压线不算超）。
    const onGate = '甲'.repeat(SPEAK_TEXT_MAX);
    assert.equal(onGate.length, SPEAK_TEXT_MAX, '夹具必须正好压在门上');
    const allowed = await tool.handler({ text: onGate }, makeCtx(ws));
    assert.equal(allowed.isError, undefined, `正好 ${SPEAK_TEXT_MAX} 字必须放行：${allowed.content}`);
    assert.doesNotMatch(allowed.content, /超过 speak 的上限/u, '压线不该被拒');
    assert.equal(recorder.count('message/assistant'), 1, '放行的那条正常落库');

    // ② **41 字（刚过门）：直接拒绝**——不是截断、不是"提醒之后照发"。
    const overGate = '甲'.repeat(SPEAK_TEXT_MAX + 1);
    const bubblesBefore = recorder.count('message/assistant');
    const sentBefore = recorder.count('speak/sent');
    const rejected = await tool.handler({ text: overGate }, makeCtx(ws));
    assert.equal(rejected.isError, true, `超过 ${SPEAK_TEXT_MAX} 字必须被拒：${rejected.content}`);
    assert.match(rejected.content, new RegExp(`${SPEAK_TEXT_MAX} 字`, 'u'), '要说清门是多少字');
    assert.match(rejected.content, new RegExp(`这段 ${SPEAK_TEXT_MAX + 1} 字`, 'u'), '要如实报出收到了多少字');
    // 三条出路一条都不许少（用户原话：重新组织语言 / 多次调用 / report）
    // 2026-10-16 改判：出路① 的**措辞**从"重新组织成更短的一句"压成"压缩成更短的一句"
    // （回执每次调用都进上下文；压的是形容词，三条出路一条没少）——判据跟着新字面量走。
    assert.match(rejected.content, /压缩成更短的一句/u, '出路①：压成更短的一句');
    assert.match(rejected.content, /拆成几次调用/u, '出路②：拆成几次调用');
    assert.match(rejected.content, /report/u, '出路③：内容本来就长 → report');
    // "一个字都没发出去"必须是**事实**，不是一句话：任何一路都不许多出一条
    assert.equal(recorder.count('message/assistant'), bubblesBefore, '被拒时一个字都不许落进对话流');
    assert.equal(recorder.count('speak/sent'), sentBefore, '被拒时不许新增任何 speak/sent 回执（三路都不许动）');
    assert.equal(
      recorder.events.some((event) => event.type === 'message/assistant'
        && (event.data as { text: string }).text === overGate),
      false,
      '被拒的原文一个字都不许出现在对话流里（截断或照发都会留下痕迹）',
    );
  });

  test('分段回来了：40 字以内的多逗号文本照旧切成多条发出', async () => {
    // 用户 2026-10-05 取消了"超过 45 字不分段"那条口径 → 分段对所有进门内的文本照旧生效。
    // 夹具用 `test/speak-interrupt-web.test.ts` 那一份（4 段、共 33 字）：它同时证明
    // "门内的长句仍然被切"，而不是整条发出。
    const ws = await workspace('speak-segment');
    const recorder = makeRecorder();
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: recorder.emit,
      personaRoot: join(ws, 'persona'),
      speakTyping: { typingEffect: false, charsPerMinute: 90 },
    });
    const tool = toolkit.byName('speak');

    const herSpeech = '第一句摆在这里，第二句放在那边，第三句换个地方说，第四句再说一句吧';
    assert.ok(
      charCount(herSpeech) <= SPEAK_TEXT_MAX,
      `夹具 ${charCount(herSpeech)} 字必须落在硬门（${SPEAK_TEXT_MAX}）以内`,
    );
    const result = await tool.handler({ text: herSpeech }, makeCtx(ws));
    assert.equal(result.isError, undefined, result.content);
    // 2026-10-20（R4）：这条以前断言 `/按聊天节奏发成 4 条/`（那一行已删，是机械复述）。
    // "切成了四段"这件事由下面那条 deepEqual 逐段钉着——比回执里的一句复述更强：
    // 它看的是**真的落进对话流的那四段**，而不是回执怎么描述自己。
    assert.deepEqual(
      recorder.events
        .filter((event) => event.type === 'message/assistant')
        .map((event) => (event.data as { text: string }).text),
      ['第一句摆在这里', '第二句放在那边', '第三句换个地方说', '第四句再说一句吧'],
      '逗号处断开、标点摘掉，逐条发出去',
    );
  });

  // ──────────── 出站正文里的 @：一个字都不动（2026-10-05 用户决定移除形态改写） ────────────
  //
  // 这里原来有一层便利：她从 `speak` / `report` 的正文里写 `[@名字]`，框架读她的
  // `MEMORIES/aliases.md` 群成员段查出 openid，再改写成官方那一串
  // `<qqbot-at-user id="…" />`；名字认不出来时**一个字都不发**。用户 2026-10-05 决定移除
  // （原话「我觉得没必要存在」）：① **她本人就会写官方形态**，id 就在她自己的 aliases.md
  // 群成员段里（docs/design.md §4.20.1）；② 那一层因为一个读表路径错误把她**整条消息卡住过**。
  //
  // 所以现在这一组用例从 speak 工具一路走到 HTTP 请求体，钉的是"**一个字节都不改、也不拦**"。

  /**
   * 她的群成员表：`MEMORIES/aliases.md` 的成员段，键是**裸 openid**（不是 sid）。
   *
   * 夹具里故意把它写得齐齐整整——那层解析已经移除了，框架**不该再读它**：正文里写什么就发什么。
   * 留着它正是为了当反证（表在，也不查）。
   */
  async function writeMemberAliases(ws: string, lines: string[]): Promise<void> {
    await mkdir(join(ws, 'MEMORIES'), { recursive: true });
    await writeFile(join(ws, 'MEMORIES', 'aliases.md'), [
      '# 身份别名',
      '',
      'qq:group:GROUP1 = 测试群聊1（口径：少说话）',
      '# 群成员（openid，不是 sid；只在认人时用）',
      ...lines,
      '',
    ].join('\n'), 'utf8');
  }

  const MEMBER1_OPENID = '00000000000000000000000000000004';

  /** 真 QQ 通道 + 夹具网络出口：记下每一个真正发出去的请求体 */
  function qqRigWith(http: (input: { url: string; jsonBody: unknown }) => HttpJsonResponse): {
    toolkit: (emit: AdminEventEmitter) => ReturnType<typeof createAdminTools>;
    sentBodies: Array<Record<string, unknown>>;
  } {
    const sentBodies: Array<Record<string, unknown>> = [];
    const fn = async (input: { url: string; method: string; jsonBody?: unknown }): Promise<HttpJsonResponse> => {
      if (input.url.includes('/messages')) sentBodies.push(input.jsonBody as Record<string, unknown>);
      return http({ url: input.url, jsonBody: input.jsonBody });
    };
    return {
      sentBodies,
      toolkit: (emit) => {
        const channel = new QqOfficialChannel({
          appId: 'APP',
          clientSecret: 'SECRET',
          http: fn as unknown as HttpJsonFn,
          useMarkdown: true,
        });
        const poster = createChannelReplyPoster(new Map([[QQ_CHANNEL_NAME, channel]]));
        return createAdminTools({
          timers: new TimerStore(null),
          emit,
          personaRoot: 'persona',
          replyTargetOf: (ctx) => ({ url: 'qq:group:GROUP1', idempotencyKey: `turn-${ctx.turn}` }),
          replyPoster: poster,
        });
      },
    };
  }

  /** 一律答"成功"的出口口径：token 请求与发消息请求分开答 */
  const okHttp = (id: string) => (input: { url: string }): HttpJsonResponse =>
    (input.url.includes('getAppAccessToken')
      ? { status: 200, text: '', body: { access_token: 'T', expires_in: '7200' } }
      : { status: 200, text: JSON.stringify({ id }), body: { id } });

  test('分段照旧：@ 串不给切分**加任何规则**，而且没有一段是框架改过的字', async (t) => {
    const ws = await workspace('speak-mention-official');
    await writeMemberAliases(ws, [`${MEMBER1_OPENID} = **1 号**（群昵称「伊尔弥亚」，昵称不作数）`]);
    const recorder = makeRecorder();
    const rig = qqRigWith(okHttp('M-AT'));
    setSleepForTest(async () => {});
    t.after(() => { setSleepForTest(null); });

    // 夹具用短 id：真实 openid（32 位）的官方串连 `speak` 的 40 字硬门都进不去（见下面那条注释）。
    const tag = '<qqbot-at-user id="X9" />';
    const text = `${tag} 一号在不在，收到回个话`;
    assert.ok(text.length <= 40, `夹具 ${text.length} 字必须落在 speak 的硬门（40）以内`);
    const result = await rig.toolkit(recorder.emit)
      .byName('speak').handler({ text }, makeCtx(ws));
    assert.equal(result.isError, undefined, result.content);

    const sent = rig.sentBodies.map((body) => (body['markdown'] as { content: string }).content);
    // ① 逗号照旧断开（分段规则一个字没改）
    assert.equal(sent.at(-1), '收到回个话', '逗号处断开、标点摘掉');
    assert.equal(rig.sentBodies[0]?.['msg_type'], 2, 'markdown 开着照旧走 markdown（@ 不改这条口径）');
    // ② **框架没有在中间插字或改字**：每一段都是原文里按顺序截下来的一段。
    //    切点在哪儿由 `chat-split` 一个人说了算（包括长过 `SPLIT_MAX_CHARS`=20 时补的那一刀）——
    //    这一层移除之后就再也没有"为了 @ 而先切后渲染"这回事了。
    let cursor = 0;
    for (const segment of sent) {
      const at = text.indexOf(segment, cursor);
      assert.ok(at >= 0, `每一段都必须是原文里按顺序的一段，且没被改写：${segment}`);
      cursor = at + segment.length;
    }
    assert.deepEqual(
      recorder.events.filter((event) => event.type === 'message/assistant')
        .map((event) => (event.data as { text: string }).text),
      sent,
      '本地那份记录与发出去的是同一份字节',
    );

    // 如实记下（2026-10-05，给下一个人的话）：`SPLIT_MAX_CHARS`=20，而官方串本身 25 字节起，
    // 所以 `speak` 这条路上它**一定**长过 20，于是会在自己的空格处被再切一刀
    // （`<qqbot-at-user` | `id="…" />…`）——那一刀会把 @ 切成两半。这不是这层移除带来的，
    // 但移除之后它成了 @ 的唯一路径问题：**要 @ 人的正文请走 `report`**（不切分、不限长，
    // 真 openid 的整串在下面那条用例里钉着）。要不要给 `chat-split` 加一条"标记内不许下刀"
    // 的规则，由用户定——那是分段器的口径，不是这一层的。
    assert.match(result.content, /发送成功|成功，但超/u);
  });

  test('`report` 里写**真实 openid** 的官方串：整段逐字节进请求体，不切分也不改写', async (t) => {
    // speak 那条 40 字硬门装不下真实 openid（32 位）+ 一句话，所以"@ 人的长正文"实际走 report。
    const ws = await workspace('report-mention-official');
    await writeMemberAliases(ws, [`${MEMBER1_OPENID} = **1 号**（群昵称「伊尔弥亚」，昵称不作数）`]);
    const recorder = makeRecorder();
    const rig = qqRigWith(okHttp('M-REPORT'));
    const result = await rig.toolkit(recorder.emit).byName('report').handler({
      text: `<qqbot-at-user id="${MEMBER1_OPENID}" /> 一号，用户让我把这条报告发给你：跑完了，42 个文件。`,
    }, makeCtx(ws));
    assert.equal(result.isError, undefined, result.content);
    assert.equal(rig.sentBodies.length, 1, '整段一条，不切分');
    assert.equal(
      (rig.sentBodies[0]?.['markdown'] as { content: string }).content,
      `<qqbot-at-user id="${MEMBER1_OPENID}" /> 一号，用户让我把这条报告发给你：跑完了，42 个文件。`,
      '官方那一串（含真实 openid）逐字节原样',
    );
    // report 没有 25 字建议线（2026-10-21）：这一篇远超 25 字，回执照样逐字 `发送成功`。
    assert.equal(result.content.trim(), '- 发送成功', result.content);
  });

  test('`[@名字]` 原样出站而且**照发**：不再有"认不出就一个字都不发"那道门', async (t) => {
    // 移除的核心就是这一条：正文里写 `[@1 号]`——框架不改写它（不查 aliases.md），
    // 更**不拒发**。它到了群里是普通文字，那是她的写法问题，轮不到框架替她拦。
    const ws = await workspace('speak-mention-bracket');
    await writeMemberAliases(ws, [
      '00000000000000000000000000000005 = 甲',
      `${MEMBER1_OPENID} = **1 号**（群昵称「伊尔弥亚」，昵称不作数）`,
    ]);
    const recorder = makeRecorder();
    const rig = qqRigWith(okHttp('M-BRACKET'));
    setSleepForTest(async () => {});
    t.after(() => { setSleepForTest(null); });

    const text = '[@1 号] 在不在';
    const result = await rig.toolkit(recorder.emit)
      .byName('speak').handler({ text }, makeCtx(ws));
    assert.equal(result.isError, undefined, `不拒发：${result.content}`);

    assert.equal(rig.sentBodies.length, 1, 'HTTP 请求照发（反向断言：不拒发）');
    assert.equal(
      (rig.sentBodies[0]?.['markdown'] as { content: string }).content,
      text,
      '就是这个字节串——既没被查表换成官方那一串，也没被拦下',
    );
    assert.equal(
      JSON.stringify(rig.sentBodies[0]?.['markdown']).includes('qqbot-at-user'),
      false,
      '框架不再替她把名字翻成 openid（aliases.md 里那个 `1 号` 与它无关）',
    );
    assert.deepEqual(
      recorder.events.filter((event) => event.type === 'message/assistant')
        .map((event) => (event.data as { text: string }).text),
      [text],
    );
  });

  test('出站体逐字节照旧（回归）：一个字都不改、msg_seq 也不动', async (t) => {
    const ws = await workspace('speak-mention-plain');
    await writeMemberAliases(ws, [`${MEMBER1_OPENID} = 1 号`]);
    const rig = qqRigWith(okHttp('M-PLAIN'));
    setSleepForTest(async () => {});
    t.after(() => { setSleepForTest(null); });

    const result = await rig.toolkit(makeRecorder().emit)
      .byName('speak').handler({ text: '跑完了，42 个文件' }, makeCtx(ws));
    assert.equal(result.isError, undefined, result.content);
    // 与"加 @ 支持之前"逐字节一样：msg_type=2 + markdown.content + msg_seq=1（没有 msg_id 就是主动消息）。
    // 9 字不足分段下限（`SPLIT_MIN_CHARS`=12），所以整句一条发出去。
    assert.deepEqual(rig.sentBodies, [
      { msg_type: 2, markdown: { content: '跑完了，42 个文件' }, msg_seq: 1 },
    ], '出站体一个字节都不许变');
  });

  test('非 QQ 目标：正文连"改写"这个念头都不该有（`[@名字]` 一字不动）', async (t) => {
    const ws = await workspace('speak-mention-onebot');
    await writeMemberAliases(ws, [`${MEMBER1_OPENID} = 1 号`]);
    const posted: string[] = [];
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: makeRecorder().emit,
      personaRoot: join(ws, 'persona'),
      replyTargetOf: (ctx) => ({ url: 'onebot:c2c:12345', idempotencyKey: `turn-${ctx.turn}` }),
      replyPoster: { async post(_target, text) { posted.push(text); return { ok: true, status: 200 }; } },
    });
    setSleepForTest(async () => {});
    t.after(() => { setSleepForTest(null); });

    const result = await toolkit.byName('speak').handler({ text: '[@1 号] 在不在' }, makeCtx(ws));
    assert.equal(result.isError, undefined, result.content);
    assert.deepEqual(posted, ['[@1 号] 在不在'], '所有通道一个待遇：正文原样，谁也不替谁猜协议');
  });

  test('没有 markdown 权限时**回执如实**：降级事实进回执（形态变了就得说清）', async (t) => {
    const ws = await workspace('speak-mention-degraded');
    await writeMemberAliases(ws, [`${MEMBER1_OPENID} = 1 号`]);
    const recorder = makeRecorder();
    let call = 0;
    const rig = qqRigWith((input) => {
      if (input.url.includes('getAppAccessToken')) {
        return { status: 200, text: '', body: { access_token: 'T', expires_in: '7200' } };
      }
      call += 1;
      // 第一条（markdown）被拒 → 通道降级纯文本重发；第二条（纯文本）成功
      return call === 1
        ? { status: 200, text: '', body: { code: 40034127, message: '无markdown模板权限' } }
        : { status: 200, text: '', body: { id: 'M-FALLBACK' } };
    });
    setSleepForTest(async () => {});
    t.after(() => { setSleepForTest(null); });

    const text = '在不在';
    const result = await rig.toolkit(recorder.emit).byName('speak').handler({ text }, makeCtx(ws));
    assert.equal(result.isError, undefined, result.content);
    // 形态如实：markdown 被拒 → 纯文本，而**正文照旧是同一份字节**（降级不改话）
    assert.equal(rig.sentBodies.length, 2, '一次失败 + 一次降级重发');
    assert.equal(rig.sentBodies[0]?.['msg_type'], 2);
    assert.equal(rig.sentBodies[1]?.['msg_type'], 0);
    assert.equal(rig.sentBodies[1]?.['content'], text);
    // 回执如实：不许只说"已送达"——"形态变了"必须一起说清（`SendOutcome.degraded` 那一项）
    assert.match(result.content, /40034127/u);
    assert.match(
      result.content,
      /原生 markdown 模板权限/u,
      '顺带给出去路：让用户去开权限（这句是**通道**带回来的降级事实）',
    );
  });
});

// ──────────────────────────────── todo ────────────────────────────────

describe('todo：全量替换语义与回调（2026-10-04 起载体是 STATE 的两节）', () => {
  /**
   * 造一份"她自己的" STATE.md：里面有**别的节**、有心情、有说明行——
   * 判据就是"写清单只动 `## 当前任务` / `## 接着干` 两节的正文，其余一个字节不改"，
   * 所以夹具里必须有可被误伤的内容，否则那条断言是空的。
   */
  async function stateFixture(ws: string, taskBody: string, ongoingBody: string): Promise<string> {
    const personaRoot = join(ws, 'persona');
    await mkdir(personaRoot, { recursive: true });
    const text = [
      '# 当前状态',
      '',
      '心情：松的。这一行是**她写的**，谁都不许动。',
      '',
      '## 当前任务',
      taskBody,
      '## 接着干',
      ongoingBody,
      '## 群的边界（10-02 夜·用户定）',
      '- 测试群聊1 = 真·私有场子。这些字也要逐字节不变。',
      '',
      '## 工具常识（已验）',
      '- 一条早就会了的常识。',
      '',
    ].join('\n');
    await writeFile(join(personaRoot, 'STATE.md'), text, 'utf8');
    return text;
  }

  test('写进 STATE 两节、落两条账、触发两个回调；第二次调用是整体替换', async () => {
    const ws = await workspace('todo');
    const recorder = makeRecorder();
    const seen: TodoItem[][] = [];
    const personaSeen: string[] = [];
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: recorder.emit,
      personaRoot: join(ws, 'persona'),
      onTodoUpdated: (items) => seen.push([...items]),
      onPersonaUpdated: (payload) => personaSeen.push(payload.file),
    });
    const ctx = makeCtx(ws);
    const tool = toolkit.byName('todo');
    const before = await stateFixture(ws, '（还没写清单）\n', '（也没排队）\n');

    const first: TodoItem[] = [
      { content: '扫描仓库', status: 'completed' },
      { content: '生成报告', status: 'in_progress' },
      { content: '发送摘要', status: 'pending' },
    ];
    const result = await tool.handler({ items: first }, ctx);
    assert.equal(result.isError, undefined, result.content);
    // ① 两条账都落：todo/updated（给投影/界面）与 persona/updated（给人格缓存与归因）
    assert.deepEqual(recorder.last('todo/updated'), { items: first });
    assert.equal(recorder.last('persona/updated')?.['file'], 'STATE.md');
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], first, '回调必须收到完整清单');
    assert.deepEqual(personaSeen, ['STATE.md'], '人格回调要跟着发，否则这一轮的状态快照是旧的');
    assert.match(result.content, /清单已写进 STATE\.md/);

    // ② 盘上真的变了：两节按顺序分（第一项进「当前任务」，其余进「接着干」）
    const onDisk = await readFile(join(ws, 'persona', 'STATE.md'), 'utf8');
    assert.match(onDisk, /## 当前任务\n- \[x\] 扫描仓库\n\n## 接着干/);
    assert.match(onDisk, /## 接着干\n- \[~\] 生成报告\n- \[ \] 发送摘要\n\n## 群的边界/);
    // ③ 其余字节一个不动：把两节正文换成占位符，剩下的必须与夹具逐字节相同
    const strip = (text: string): string => text
      .replace(/## 当前任务\n[\s\S]*?\n## 接着干/, '## 当前任务\n<BODY>\n## 接着干')
      .replace(/## 接着干\n[\s\S]*?\n## 群的边界/, '## 接着干\n<BODY>\n## 群的边界');
    assert.equal(strip(onDisk), strip(before), '只有那两节的正文允许变');

    // 全量替换：第二次只给一项，两节就只剩这一项
    const second: TodoItem[] = [{ content: '等人工确认', status: 'in_progress' }];
    await tool.handler({ items: second }, ctx);
    assert.deepEqual(recorder.last('todo/updated'), { items: second });
    assert.deepEqual(seen[1], second);
    const afterSecond = await readFile(join(ws, 'persona', 'STATE.md'), 'utf8');
    assert.match(afterSecond, /## 当前任务\n- \[~\] 等人工确认\n\n## 接着干\n\n## 群的边界/);
    assert.equal(afterSecond.includes('扫描仓库'), false, '旧项被整体替换掉');

    // 空数组 = 清空（两节都空，但节还在）
    const cleared = await tool.handler({ items: [] }, ctx);
    assert.match(cleared.content, /已清空/);
    assert.deepEqual(recorder.last('todo/updated'), { items: [] });
    const afterClear = await readFile(join(ws, 'persona', 'STATE.md'), 'utf8');
    assert.match(afterClear, /## 当前任务\n\n## 接着干\n\n## 群的边界/);

    // ④ 幂等：同一份清单再写一次**不落盘、不落账**（否则下一轮的固定块白失守一次）
    const writes = recorder.count('persona/updated');
    const again = await tool.handler({ items: [] }, ctx);
    assert.equal(again.isError, undefined, again.content);
    assert.match(again.content, /没有变化|已经是空的/);
    assert.equal(recorder.count('persona/updated'), writes, '内容没变就不该产生 persona/updated');
  });

  test('那两节不在时如实报错，且文件一个字节都不动', async () => {
    const ws = await workspace('todo-no-section');
    const personaRoot = join(ws, 'persona');
    await mkdir(personaRoot, { recursive: true });
    // 只留「当前任务」：故意缺「接着干」
    const text = '# 当前状态\n\n心情：好。\n\n## 当前任务\n\n- [ ] 一件旧事\n';
    await writeFile(join(personaRoot, 'STATE.md'), text, 'utf8');

    const recorder = makeRecorder();
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: recorder.emit,
      personaRoot,
    });
    const result = await toolkit.byName('todo').handler(
      { items: [{ content: '新的一件', status: 'pending' }] },
      makeCtx(ws),
    );

    assert.equal(result.isError, true, '缺节必须报错，不能静默整体重写');
    assert.match(result.content, /找不到「## 接着干」/);
    assert.match(result.content, /一个字节都没动/);
    assert.equal(await readFile(join(personaRoot, 'STATE.md'), 'utf8'), text, '文件必须原样');
    assert.equal(recorder.count('persona/updated'), 0, '没写成就不能落 persona/updated');
  });

  test('非法清单被拒绝：非数组、未知状态、超上限', async () => {
    const ws = await workspace('todo-bad');
    const toolkit = createAdminTools({
      timers: new TimerStore(null),
      emit: makeRecorder().emit,
      personaRoot: join(ws, 'persona'),
    });
    const ctx = makeCtx(ws);
    const tool = toolkit.byName('todo');
    await stateFixture(ws, '\n', '\n');

    const notArray = await tool.handler({ items: 'a,b' }, ctx);
    assert.equal(notArray.isError, true);
    assert.match(notArray.content, /必须是数组/);

    const badStatus = await tool.handler({ items: [{ content: 'x', status: 'done' }] }, ctx);
    assert.equal(badStatus.isError, true);
    assert.match(badStatus.content, /status 只能是/);

    const tooMany = await tool.handler(
      { items: Array.from({ length: MAX_TODO_ITEMS + 1 }, (_, index) => ({ content: `t${index}`, status: 'pending' })) },
      ctx,
    );
    assert.equal(tooMany.isError, true);
    assert.match(tooMany.content, new RegExp(`最多 ${MAX_TODO_ITEMS} 项`));
  });
});

// ──────────────────────────────── pwsh：纯函数层 ────────────────────────────────

describe('pwsh：命令黑名单与输出处理（纯函数）', () => {
  test('危险命令命中规则，安全命令放行', () => {
    const blocked: Array<[string, string]> = [
      ['rm -rf /', 'rm-recursive-force'],
      ['Remove-Item -Recurse -Force D:\\', 'remove-item-recursive-force'],
      ['Remove-Item C:\\ ', 'remove-item-drive-root'],
      ['format C: /q', 'format-volume'],
      ['mkfs.ext4 /dev/sda1', 'mkfs'],
      ['diskpart /s script.txt', 'disk-management'],
      ['reg add HKLM\\Software\\X /v Y /d Z', 'registry-write'],
      ['bcdedit /set {default} safeboot minimal', 'boot-config'],
      ['takeown /f C:\\Windows', 'takeown-icacls-grant'],
      ['shutdown /s /t 0', 'power-state'],
      ['cipher /w:C:\\temp', 'wipe-free-space'],
      ['Set-ExecutionPolicy Unrestricted -Force', 'execution-policy'],
      ['rd /s /q C:\\temp', 'del-rd-recursive'],
      // 大小写与换行变形不得成为绕过通道
      ['Rm   -Rf   /', 'rm-recursive-force'],
      ['REMOVE-ITEM -RECURSE -FORCE C:\\x', 'remove-item-recursive-force'],
    ];
    for (const [command, ruleId] of blocked) {
      const hit = screenCommand(command);
      assert.notEqual(hit, null, `应被拒绝：${command}`);
      assert.equal(hit?.id, ruleId, `${command} 应命中 ${ruleId}`);
      assert.ok((hit?.reason.length ?? 0) > 0, '每条规则都要有给模型看的原因');
    }

    const allowed = [
      'Get-ChildItem .',
      'Write-Output "hello"',
      'Get-Process | Select-Object -First 5',
      'git status',
      'Remove-Item ./tmp-output.txt',
      'npm test',
      '$x = 1; $x + 1',
    ];
    for (const command of allowed) {
      assert.equal(screenCommand(command), null, `不应被拒绝：${command}`);
    }
    assert.ok(FORBIDDEN_PATTERNS.length >= 10);
  });

  test('截断保留头 8k + 尾 2k 并附续读指导', () => {
    const short = 'abc';
    assert.deepEqual(truncateOutput(short), { text: 'abc', truncated: false });

    const long = `${'A'.repeat(OUTPUT_HEAD_CHARS)}${'B'.repeat(50_000)}${'C'.repeat(OUTPUT_TAIL_CHARS)}`;
    const result = truncateOutput(long);
    assert.equal(result.truncated, true);
    assert.ok(result.text.startsWith('A'.repeat(100)));
    assert.ok(result.text.endsWith('C'.repeat(100)));
    assert.match(result.text, /中间 \d+ 字已省略/);
    assert.match(result.text, /Select-String|Select-Object/, '截断处必须告诉模型怎么继续拿');
  });

  test('CLIXML 残留按锚定剥离；错误块按节点解码成可读文本（三档同一套 stderr）', () => {
    // 实测：pwsh 首次输出错误时会先写一行 #< CLIXML
    assert.equal(stripClixml('#< CLIXML\r\n实际输出\r\n'), '实际输出\r\n');
    assert.equal(
      stripClixml('#< CLIXML\n错误: x\n<Objs Version="1.1"><S S="Error">y</S></Objs>\n'),
      '错误: x\n',
    );
    // 不以标记开头就不动它：不做全局猜测
    const untouched = 'echo "#< CLIXML\n"';
    assert.equal(stripClixml(untouched), untouched);
    assert.equal(normalizeNewlines('a\r\nb\r\n'), 'a\nb\n');

    // ── v52：`Write-Error` 在管道上被包成 CLIXML，**要解码而不是丢掉** ──
    // 夹具逐字取自实测（pwsh 7.5.3 往 stderr 管道写 `Write-Error "boom"` 的原始字节）：
    // `stripClixml` 会把它整个丢掉 ⇒ 她的报错凭空消失；`decodeClixmlErrors` 解得出来。
    const raw = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">'
      + '<S S="Error">_x001B_[31;1mWrite-Error: _x001B_[31;1mboom_x001B_[0m_x000D__x000A_</S></Objs>';
    assert.equal(stripClixml(raw), '', '旧口径：整个错误块被丢掉（这正是 v52 要修的那一格）');
    const decoded = decodeClixmlErrors(raw);
    assert.match(decoded, /Write-Error: boom/, `要解出可读的错误文本：${JSON.stringify(decoded)}`);
    assert.doesNotMatch(decoded, /CLIXML|<Objs|_x001B_|\u001b/u, 'XML 包裹、转义、ANSI 装饰都不许留给它读');
    // 不是 CLIXML 就原样返回（不做全局猜测）
    assert.equal(decodeClixmlErrors('plain stderr\n'), 'plain stderr\n');
    // 解不出节点时退回旧口径，**绝不返回空串**（展示层宁可多留字节，也不能让报错消失）
    assert.equal(decodeClixmlErrors('#< CLIXML\r\n散文本\r\n'), '散文本\r\n');
  });

  test('BoundedText：内存有界、尾部窗口仍能定位结束标记', () => {
    const buffer = new BoundedText(1_000);
    buffer.push('H'.repeat(600));
    buffer.push('M'.repeat(2_000));
    buffer.push('TAIL__IRMIA_END_abc__ 0\r\n');
    assert.ok(buffer.droppedChars > 0, '超出上限必须丢弃并计数');
    assert.ok(buffer.length <= 1_000, `保留量必须有界，实际 ${buffer.length}`);
    assert.ok(buffer.text().startsWith('H'), '头部保留');
    assert.match(buffer.window(), /__IRMIA_END_abc__ 0/, '结束标记必须在尾部窗口里找到');

    // 短输出（未触发丢弃）同样能定位：窗口回退到全部内容
    const small = new BoundedText(1_000);
    small.push('ok\r\n__IRMIA_END_abc__ 0\r\n');
    assert.equal(small.droppedChars, 0);
    assert.match(small.window(), /__IRMIA_END_abc__ 0/);
  });

  test('脚本拼装：命令走 base64，不把用户文本拼进命令行', () => {
    const nasty = 'Write-Output "引号 \' 与 $变量 与\n换行"';
    const script = buildSingleShotScript(nasty);
    assert.doesNotMatch(script, /引号|换行/, '命令本体不得以明文出现在脚本里');
    assert.match(script, /FromBase64String/);
    assert.match(script, /exit \$LASTEXITCODE/, '必须显式收敛退出码');

    const bootstrap = buildSessionBootstrap('marker-123');
    assert.match(bootstrap, /\$irmiaMarker='marker-123'/);
    // v52：`SetError([Console]::Out)` 那一条**被测掉了**（不是漏测）——IRMIA 2026-10-12
    // 第 1 条要求"三种 lang 同一套 stdout/stderr"，而把 PowerShell 的 error stream 并进
    // stdout 会让 pwsh 档的报错落在正文、另两档落在 `[stderr]` 段里。所以这里反过来钉：
    // **不许再合并**（合并回来这条会红）。
    assert.doesNotMatch(bootstrap, /SetError\(\[Console\]::Out\)/, 'stderr 必须就是 stderr（三档同一套格式）');
    assert.match(bootstrap, /\[Console\]::OutputEncoding=\[Text\.Encoding\]::UTF8/, '中文编码那一条照旧在');
    assert.match(bootstrap, /finally/, 'exit 也要能写出边界标记');
    assert.match(bootstrap, /__IRMIA_END_/);
  });
});

// ──────────────────────────────── pwsh：真实执行 ────────────────────────────────

describe('pwsh：检测链与真实执行', () => {
  /** 本组共用一个工具实例：pwsh 每次启动都是真实进程，集中复用减少开销 */
  let tool: PwshToolDefinition;
  let ws = '';

  before(async () => {
    ws = await workspace('pwsh');
    tool = createPwshTool({ destructiveEnabled: true, onWarning: () => undefined });
  });

  after(async () => {
    await tool.shutdown();
  });

  test('检测链：能用上 pwsh 7，否则回退 5.1 并给出安装建议', async () => {
    // 本组里别的用例会注入假探测并污染模块级缓存，这里先清一次（真探测一次，代价可接受）
    resetPowerShellProbeCache();
    const probe = await tool.probe();
    assert.ok(['pwsh', 'powershell'].includes(probe.kind), `意外的运行时：${probe.kind}`);
    assert.ok(probe.major >= 5, `版本号应可解析，实际 ${probe.version}`);
    if (probe.kind === 'powershell') {
      assert.notEqual(probe.warning, null);
      assert.match(probe.warning ?? '', /winget install Microsoft\.PowerShell/);
    } else {
      assert.equal(probe.warning, null);
      assert.ok(probe.major >= 7);
    }
    // 与独立探测结果一致（缓存不得改变事实）
    const again = await detectPowerShell();
    assert.equal(again.kind, probe.kind);
    assert.ok(POWERSHELL_INSTALL_HINT.length > 0);
  });

  test('默认 shell 就是依赖探测认定的那个 pwsh 7（路径可以是完整的）', async () => {
    // 注入一份"框架探测到 pwsh 7 在别处"的结论：工具必须用它，而不是自己再猜一次
    resetPowerShellProbeCache();
    const injected = createPwshTool({
      destructiveEnabled: true,
      depsProbe: async () => ({
        ok: true,
        path: process.execPath, // 任何存在的可执行文件都行：这条用例只看选中的是谁
        version: '7.5.0',
        reason: '',
      }),
    });
    try {
      const probe = await injected.probe();
      assert.equal(probe.kind, 'pwsh');
      assert.equal(probe.version, '7.5.0');
      assert.equal(probe.exe, process.execPath, '必须用探测给出的路径（不是裸名字）');
      assert.equal(probe.warning, null, '用上 PS7 就不该有回退告警');
    } finally {
      await injected.shutdown();
    }
  });

  test('依赖探测说没有 pwsh 7 时：如实回退 5.1，且不假装满足', async () => {
    resetPowerShellProbeCache();
    const fallback = createPwshTool({
      destructiveEnabled: true,
      onWarning: () => undefined,
      depsProbe: async () => ({ ok: false, path: '', version: '', reason: '测试：pwsh 7 未安装' }),
    });
    try {
      if (process.platform !== 'win32') return; // 回退项是 Windows PowerShell，非 Windows 上会直接报错
      const probe = await fallback.probe();
      assert.equal(probe.kind, 'powershell');
      assert.match(probe.warning ?? '', /未检测到 PowerShell 7/u);
      assert.match(probe.warning ?? '', /winget install Microsoft\.PowerShell/u);
    } finally {
      resetPowerShellProbeCache();
      await fallback.shutdown();
    }
  });

  test('单次执行：echo 拿到输出与退出码，进程隔离不保留状态', async () => {
    const ctx = makeCtx(ws);
    const echoed = await tool.handler({ command: 'Write-Output "hello-irmia"', persistent: false }, ctx);
    assert.equal(echoed.isError, undefined, echoed.content);
    assert.equal(firstLineOf(echoed.content), 'hello-irmia');
    assert.match(echoed.content, /\[exit code: 0 · \d+ms\]/, 'v52：退出码与耗时同一行，三档同一个形状');

    // 单次模式的语义就是"新进程"：上一个进程里的变量不存在
    await tool.handler({ command: '$isolated = 5', persistent: false }, ctx);
    const check = await tool.handler({ command: '$isolated', persistent: false }, ctx);
    assert.doesNotMatch(check.content, /^5$/m, '单次执行不得跨进程保留变量');

    // 中文与退出码：5.1 的编码差异由显式 UTF-8 抹平
    const chinese = await tool.handler({ command: 'Write-Output "中文输出正常"', persistent: false }, ctx);
    assert.equal(firstLineOf(chinese.content), '中文输出正常');

    const exitCode = await tool.handler({ command: 'cmd /c "exit 9"', persistent: false }, ctx);
    assert.match(exitCode.content, /\[exit code: 9 · \d+ms\]/, '真实退出码必须传出来（v52 起与耗时同一行）');
    assert.equal(exitCode.isError, undefined, '非零退出码是命令的结果，不是工具失败');
  });

  test('每次调用的回执都标明本次用的是哪个 shell（且不挡第一行输出）', async () => {
    const ctx = makeCtx(ws);
    const echoed = await tool.handler({ command: 'Write-Output "shell-receipt"', persistent: false }, ctx);
    // 首行仍然是命令自己的输出（元信息贴在最末）；这一条是 v30 的硬要求：
    // "每次调用的回执里要说明这次用的是哪个 shell"
    assert.equal(firstLineOf(echoed.content), 'shell-receipt');
    const shellLine = echoed.content.split('\n').find((line) => line.startsWith('[shell] '));
    assert.ok(shellLine !== undefined, `回执里必须有 [shell] 行：${echoed.content}`);
    assert.match(shellLine, /^\[shell\] (pwsh|powershell) [\d.]+ · .+/u, `shell 行形状不符：${shellLine}`);

    // 表里一致：shellLine() 与探测结论、与回执里那一行三者必须同一
    const probe = await tool.probe();
    assert.ok(shellLine.includes(probe.kind), '回执行里的 shell 种类要与探测结论一致');
    assert.ok(shellLine.includes(probe.version), '回执行里的版本要与探测结论一致');
    assert.ok(shellLine.includes(probe.exe), '回执行里要给出真正被调用的可执行文件');
    assert.equal(await tool.shellLine(), shellLine, 'shellLine() 就是回执里那一行');

    // 拒绝路径（没执行任何东西）不该贴 shell 行：那时没有"这次用的 shell"
    const denied = await tool.handler({ command: 'Remove-Item -Recurse -Force C:\\Windows' }, ctx);
    assert.equal(denied.isError, true);
    assert.ok(!denied.content.includes('[shell]'), '没执行就不该声称用了哪个 shell');
  });

  test('持久会话：变量与工作目录跨调用保持', async () => {
    const ctx = makeCtx(ws);
    const set = await tool.handler({ command: '$x = 1' }, ctx);
    assert.equal(set.isError, undefined, set.content);

    const sum = await tool.handler({ command: '$x + 1' }, ctx);
    assert.equal(firstLineOf(sum.content), '2', `期望持久变量生效：${sum.content}`);

    // 再累一次，证明是同一份会话状态
    await tool.handler({ command: '$x = $x + 40' }, ctx);
    const again = await tool.handler({ command: '$x + 1' }, ctx);
    assert.equal(firstLineOf(again.content), '42');

    // cwd 也在会话内持久
    const child = join(ws, 'sub');
    await mkdir(child, { recursive: true });
    await tool.handler({ command: `Set-Location -LiteralPath '${child.replace(/'/g, "''")}'` }, ctx);
    const where = await tool.handler({ command: '(Get-Location).Path' }, ctx);
    // Windows 路径大小写不敏感，而 PowerShell 会按自己的规范化形式回显，所以忽略大小写比较
    assert.equal(firstLineOf(where.content).toLowerCase(), child.toLowerCase(), where.content);

    // 函数定义同样跨调用（这是持久会话相对单次执行的核心价值）
    await tool.handler({ command: 'function Get-IrmiaTag { "tag-ok" }' }, ctx);
    const tagged = await tool.handler({ command: 'Get-IrmiaTag' }, ctx);
    assert.equal(firstLineOf(tagged.content), 'tag-ok');

    // 错误可读：非终止错误要落在**与另两档同一个** `[stderr]` 段里，而且是可读文本
    const warned = await tool.handler({ command: 'Write-Error "boom"; Write-Output "after"' }, ctx);
    // 判据走 `composeContent` 的同一套处理（`normalizeNewlines` + CLIXML 解码）：
    // pwsh 往管道写错误时会包一层 CLIXML，**那层包裹应当被解掉**，直接拿生文本断言
    // 会红在一个假问题上（v52 实测踩过这一脚）。
    const cleaned = normalizeNewlines(decodeClixmlErrors(normalizeNewlines(warned.content)));
    assert.match(cleaned, /\[stderr\]\n[\s\S]*boom/);
    assert.doesNotMatch(cleaned, /CLIXML|<Objs/u, 'CLIXML 那层包裹不许留给它读');
    assert.match(cleaned, /after/);
  });

  test('危险命令被拒绝并把原因回给模型，且确实没有执行', async () => {
    const ctx = makeCtx(ws);
    const denied = await tool.handler({ command: 'Remove-Item -Recurse -Force C:\\Windows' }, ctx);
    assert.equal(denied.isError, true);
    assert.equal(denied.error?.code, 'E_DENIED_COMMAND');
    assert.match(denied.content, /remove-item-recursive-force/);
    assert.match(denied.content, /递归强制删除/);
    assert.match(denied.content, /人工执行/, '拒绝消息要给出下一步');

    // 被拒绝之后会话仍然可用（拒绝发生在执行之前）
    const alive = await tool.handler({ command: 'Write-Output "still-alive"' }, ctx);
    assert.equal(firstLineOf(alive.content), 'still-alive');
  });

  test('超时杀进程树，并把会话状态丢失如实告知', async () => {
    const ctx = makeCtx(ws);
    const started = Date.now();
    const timedOut = await tool.handler({ command: 'Start-Sleep -Seconds 60', timeoutMs: 1_000 }, ctx);

    assert.equal(timedOut.isError, true);
    assert.equal(timedOut.error?.code, 'E_TIMEOUT');
    assert.match(timedOut.content, /超时/);
    assert.match(timedOut.content, /runInBackground/, '超时消息要给替代路径');
    assert.ok(Date.now() - started < 30_000, '超时必须真的掐断，而不是等命令自己结束');

    // 下一次调用自动重建会话，并如实说明 cwd/变量已经丢了
    const after = await tool.handler({ command: 'Write-Output "rebuilt"' }, ctx);
    assert.equal(firstLineOf(after.content), 'rebuilt');
    assert.match(after.content, /持久会话已在本次调用前重建/);
    assert.match(after.content, /变量状态丢失/);

    // 重建后旧变量确实不在了（如实告知不是一句空话）
    const gone = await tool.handler({ command: '$x' }, ctx);
    assert.doesNotMatch(gone.content, /^42$/m, '重建后旧变量必须不存在');
  });

  test('并发抢占：中断信号能掐断在跑的命令', async () => {
    const ctx = makeCtx(ws);
    const controller = new AbortController();
    const pending = tool.handler(
      { command: 'Start-Sleep -Seconds 30' },
      makeCtx(ws, { signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 300);
    const aborted = await pending;
    assert.equal(aborted.isError, true);
    assert.equal(aborted.error?.code, 'E_ABORTED');

    // 中断同样杀掉了会话，下一次调用重建后仍可用
    const recovered = await tool.handler({ command: 'Write-Output "after-abort"' }, ctx);
    assert.match(recovered.content, /after-abort/);
  });

  test('workdir 与参数校验给出可操作的错误', async () => {
    const ctx = makeCtx(ws);
    const missingCwd = await tool.handler({ command: 'Write-Output 1', workdir: join(ws, '不存在的目录') }, ctx);
    assert.equal(missingCwd.isError, true);
    assert.match(missingCwd.content, /工作目录不存在/);

    const badTimeout = await tool.handler({ command: 'Write-Output 1', timeoutMs: 1 }, ctx);
    assert.equal(badTimeout.isError, true);
    assert.match(badTimeout.content, /timeoutMs/);

    const noCommand = await tool.handler({}, ctx);
    assert.equal(noCommand.isError, true);
    assert.match(noCommand.content, /command/);

    const badPersistent = await tool.handler({ command: 'Write-Output 1', persistent: 'yes' }, ctx);
    assert.equal(badPersistent.isError, true);
    assert.match(badPersistent.content, /布尔值/);
  });

  test('未显式开启 destructive 时一律拒绝执行（三级门默认关）', async () => {
    const gated = createPwshTool();
    try {
      const blocked = await gated.handler({ command: 'Write-Output "should-not-run"' }, makeCtx(ws));
      assert.equal(blocked.isError, true);
      assert.equal(blocked.error?.code, 'E_DESTRUCTIVE_DISABLED');
      assert.match(blocked.content, /默认关闭/);
      assert.doesNotMatch(blocked.content, /should-not-run/, '未开启时不得有任何执行痕迹');
    } finally {
      await gated.shutdown();
    }
  });
});

// ──────────────────────────────── pwsh：后台任务 ────────────────────────────────

describe('pwsh：后台任务对接 jobs 回调', () => {
  test('runInBackground 立刻返回 jobId，完成后写 job/finished 与输出文件', async () => {
    const ws = await workspace('pwsh-bg');
    const jobsDir = join(ws, 'jobs');
    const startedJobs: Array<{ jobId: string; command: string; turn: number }> = [];
    const finishedJobs: Array<{ jobId: string; exitCode: number | null; outputRef?: string }> = [];
    const tool = createPwshTool({
      destructiveEnabled: true,
      jobsDir,
      jobs: {
        started: (job) => startedJobs.push(job),
        finished: (job) => finishedJobs.push(job),
      },
    });

    try {
      const launched = await tool.handler(
        { command: 'Write-Output "background-done"; cmd /c "exit 0"', runInBackground: true },
        makeCtx(ws, { turn: 11 }),
      );
      assert.equal(launched.isError, undefined, launched.content);
      assert.match(launched.content, /后台任务已启动/);
      assert.match(launched.content, /独立进程/, '要说清后台任务不共享持久会话状态');

      assert.equal(startedJobs.length, 1);
      assert.equal(startedJobs[0]?.turn, 11);
      assert.match(startedJobs[0]?.command ?? '', /background-done/);

      await waitFor(() => finishedJobs.length === 1, 30_000, 'job/finished 回调');
      const finished = finishedJobs[0]!;
      assert.equal(finished.jobId, startedJobs[0]?.jobId);
      assert.equal(finished.exitCode, 0);
      assert.equal(typeof finished.outputRef, 'string');
      const log = await readFile(finished.outputRef!, 'utf8');
      assert.match(log, /background-done/);
      assert.match(log, /# command: /);
    } finally {
      await tool.shutdown();
    }
  });

  test('未注入 jobs 回调时拒绝后台模式，不静默降级', async () => {
    const ws = await workspace('pwsh-bg-none');
    const tool = createPwshTool({ destructiveEnabled: true });
    try {
      const result = await tool.handler({ command: 'Write-Output 1', runInBackground: true }, makeCtx(ws));
      assert.equal(result.isError, true);
      assert.match(result.content, /未配置后台任务回调/);
    } finally {
      await tool.shutdown();
    }
  });

  test('后台任务输出落盘失败只告警，job/finished 照常回调', async () => {
    const ws = await workspace('pwsh-bg-fail');
    const warnings: string[] = [];
    // 用一个"文件"当目录，让 mkdir 必然失败
    const blocker = join(ws, 'blocker');
    await writeFile(blocker, 'not a directory', 'utf8');
    const finished: Array<{ exitCode: number | null }> = [];
    const tool = createPwshTool({
      destructiveEnabled: true,
      jobsDir: join(blocker, 'jobs'),
      onWarning: (message) => warnings.push(message),
      jobs: { started: () => undefined, finished: (job) => finished.push(job) },
    });

    try {
      const launched = await tool.handler({ command: 'Write-Output "bg"', runInBackground: true }, makeCtx(ws));
      assert.equal(launched.isError, undefined);
      await waitFor(() => finished.length === 1, 30_000, 'job/finished 回调');
      assert.equal(finished[0]?.exitCode, 0);
      assert.ok(warnings.some((line) => line.includes('落盘失败')), `应留下告警：${warnings.join(' | ')}`);
    } finally {
      await tool.shutdown();
    }
  });
});

// ──────────────────────────────── pwsh：整段脚本与 lang（v52） ────────────────────────────────
//
// 用户 2026-10-12 的原话：「**改造 pwsh 工具，并且 desc 要优化到清楚怎么用（整段脚本的用法）**」。
// 这一组钉的就是那句话的四个判据：① 整段多行脚本（含引号与中文）一次交进去就能跑；
// ② `lang: python` / `lang: node` 各有一条真跑；③ 超时照样杀**进程树**（不是只杀父进程）；
// ④ 临时脚本**一定要被删掉**（包括超时那条异常路径）。
//
// 为什么另起一组而不是塞进上一组：上一组共用一个会话实例（为省进程启动开销），
// 而这一组的判据是"每一档都是新进程、跑完不留文件"——共用一个实例会把"新进程"这件事测糊。

describe('pwsh：整段脚本与 lang（v52）', () => {
  let ws = '';
  let tool: PwshToolDefinition;

  before(async () => {
    ws = await workspace('pwsh-lang');
    tool = createPwshTool({ destructiveEnabled: true, onWarning: () => undefined });
  });

  after(async () => {
    await tool.shutdown();
  });

  /** 回执里那一行 `[lang] …（…跑完已删除：<路径>）` 里的脚本路径 */
  function scriptPathOf(content: string): string | null {
    // 2026-10-20（R5）：尾巴那半句（"这一档每次都是新进程，不继承…"）已删，路径后面
    // 不再是 `；`，而是整行的右括号。分隔符跟着变成 `；）` 两个都收。
    return /跑完已删除：(.+?)[；）]/u.exec(content)?.[1] ?? null;
  }

  test('lang 默认就是 pwsh：整段多行脚本 + 内层引号 + 中文，一次交进去就能跑', async () => {
    const ctx = makeCtx(ws);
    // 夹具刻意集齐三样难东西：**多行**、**单双引号嵌套**、**中文**。
    // 走 base64 通道（单次/会话）或临时文件（v52 三档同源）都不需要她转义任何一个字符。
    const script = [
      '$名字 = "伊尔弥亚"',
      "$句子 = '她说：\"你好\"'",
      'Write-Output "$名字 / $句子"',
      'Write-Output "第二行中文"',
    ].join('\n');
    const result = await tool.handler({ command: script }, ctx);
    assert.equal(result.isError, undefined, result.content);
    const lines = normalizeNewlines(result.content).split('\n');
    assert.equal(lines[0], '伊尔弥亚 / 她说："你好"', `首行必须是脚本自己的输出：${result.content}`);
    assert.equal(lines[1], '第二行中文');
    // 缺省档（lang=pwsh + 默认持久会话）走的是**持久会话**那条路：回执形状与 v51 一致
    // （只有 `[shell]`，没有 `[lang]` 那一行）
    assert.ok(!result.content.includes('[lang]'), 'lang 缺省 + 默认持久会话时不该改回执形状');
    assert.match(result.content, /\[shell\] (pwsh|powershell)/u);

    // 坏的 lang 取值：当场拒，且把三个取值摆出来（给不全她只能瞎试）
    const bad = await tool.handler({ command: 'Write-Output 1', lang: 'ruby' }, ctx);
    assert.equal(bad.isError, true);
    assert.equal(bad.error?.code, 'E_INVALID_ARGS');
    assert.match(bad.content, /pwsh \/ python \/ node/u);
  });

  test('lang=node：整段脚本真跑，临时文件跑完被删掉', async () => {
    const ctx = makeCtx(ws);
    const script = [
      'const 名字 = "伊尔弥亚";',
      'const 引号 = `她说："你好" 与 \'再见\'`;',
      'console.log(`${名字} / ${引号}`);',
      'console.log(["第二行", "中文"].join(" · "));',
    ].join('\n');
    const result = await tool.handler({ command: script, lang: 'node' }, ctx);
    assert.equal(result.isError, undefined, result.content);
    const lines = normalizeNewlines(result.content).split('\n');
    assert.equal(lines[0], '伊尔弥亚 / 她说："你好" 与 \'再见\'', result.content);
    assert.equal(lines[1], '第二行 · 中文');
    assert.match(result.content, /\[exit code: 0 · \d+ms\]/);

    // 临时脚本必须被删（这一条是用户点名的判据：异常路径也要删）
    const path = scriptPathOf(result.content);
    assert.notEqual(path, null, `回执里要给出脚本路径：${result.content}`);
    assert.equal(await exists(path!), false, `临时脚本必须被删掉：${path}`);
    // 连目录都收了（空目录顺手删）
    assert.equal(await exists(join(ws, '.irmia-tmp')), false, '空的 .irmia-tmp 也该被收掉');
  });

  test('lang=python：整段脚本真跑（中文与引号不用转义）', async () => {
    const ctx = makeCtx(ws);
    const script = [
      '# -*- coding: utf-8 -*-',
      '名字 = "伊尔弥亚"',
      "句子 = '她说：\"你好\"'",
      'print(f"{名字} / {句子}")',
      'print("，".join(["第二行", "中文"]))',
    ].join('\n');
    const result = await tool.handler({ command: script, lang: 'python' }, ctx);
    // 这台机器上 python 可能存在也可能不存在：不存在时**必须如实报"没执行"**，
    // 而不是换一个语言偷偷跑（那会得到一段看起来跑了、结果全错的输出）
    if (result.error?.code === 'E_NO_RUNTIME') {
      assert.match(result.content, /没有执行/u);
      assert.match(result.content, /python3 \/ python/u, '要说清试过哪些名字');
      assert.equal(scriptPathOf(result.content), null, '没执行就不该有脚本路径');
      return;
    }
    assert.equal(result.isError, undefined, result.content);
    const lines = normalizeNewlines(result.content).split('\n');
    assert.equal(lines[0], '伊尔弥亚 / 她说："你好"', result.content);
    assert.equal(lines[1], '第二行，中文');
    assert.match(result.content, /\[lang\] python · /u);
    const path = scriptPathOf(result.content);
    assert.equal(await exists(path!), false, `临时脚本必须被删掉：${path}`);
  });

  test('lang=python/node + persistent=true：当场说清"这一档没有持久会话"，不静默忽略', async () => {
    const ctx = makeCtx(ws);
    const result = await tool.handler({ command: 'print(1)', lang: 'python', persistent: true }, ctx);
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, 'E_INVALID_ARGS');
    assert.match(result.content, /没有持久会话/u);
    assert.match(result.content, /去掉 persistent/u, '要给出改动最小的那一步');
  });

  test('lang=pwsh + persistent=false：也走临时文件，同样跑完即删', async () => {
    // 这一档是新加的（v52 三档同源）：脚本写进 .ps1 临时文件执行。取证是回执里那行 `[lang]`
    const ctx = makeCtx(ws);
    const result = await tool.handler(
      { command: 'Write-Output "临时脚本档"\nWrite-Output "第二行"', lang: 'pwsh', persistent: false },
      ctx,
    );
    assert.equal(result.isError, undefined, result.content);
    assert.equal(firstLineOf(result.content), '临时脚本档');
    assert.match(result.content, /\[lang\] pwsh · /u);
    // `[shell]` 每一档都贴（v30 的硬要求），临时脚本档也一样
    assert.match(result.content, /\[shell\] (pwsh|powershell)/u);
    const path = scriptPathOf(result.content);
    assert.notEqual(path, null, result.content);
    assert.equal(await exists(path!), false, '临时脚本必须被删掉');
  });

  test('临时脚本档：超时照样杀进程树，而且脚本文件也要删掉', async () => {
    const ctx = makeCtx(ws);
    const started = Date.now();
    const result = await tool.handler(
      {
        // 起一个**子进程**去睡：只杀父进程的话它会活下来（review.md 缺陷 6 的 zombie）
        command: [
          'import subprocess, sys',
          'subprocess.run([sys.executable, "-c", "import time; time.sleep(60)"])',
        ].join('\n'),
        lang: 'python',
        timeoutMs: 1_500,
      },
      ctx,
    );
    if (result.error?.code === 'E_NO_RUNTIME') return; // 没有 python：这条判据在这台机器上不成立
    assert.equal(result.isError, true, result.content);
    assert.equal(result.error?.code, 'E_TIMEOUT');
    assert.match(result.content, /已终止进程树/u);
    assert.ok(Date.now() - started < 30_000, '超时必须真的掐断，而不是等命令自己结束');
    const path = scriptPathOf(result.content);
    assert.notEqual(path, null, `超时回执里也要给出脚本路径：${result.content}`);
    assert.equal(await exists(path!), false, '超时是异常路径，临时脚本同样必须被删掉');
  });

  // ──────────── IRMIA 的五条设计要求（2026-10-12，她是在用的人） ────────────
  //
  // 逐条都有用例钉住，每一条的注释里写明"钉的是哪一条要求"。

  test('要求①：三档的输出格式**逐字同一套**（stdout/stderr/exit code/耗时）', async () => {
    const ctx = makeCtx(ws);
    /** 三档各自跑一段"写一行 stdout + 写一行 stderr + 非零退出码"的脚本 */
    const cases: Array<{ lang: 'pwsh' | 'python' | 'node'; script: string; extra?: { persistent: boolean } }> = [
      // pwsh 这一档刻意给 `persistent: false`：**持久会话拿不到 `exit N` 的退出码**——
      // `exit` 会终止整个会话进程（没有任何标记写回来），而那正是"会话丢了、如实告知"
      // 那条既有语义要处理的情形（见文件头第 4 条）。要对齐三档的**输出格式**，
      // 就得让三档都走同一类执行路径（每档一段独立进程）。
      {
        lang: 'pwsh',
        script: 'Write-Output "OUT"\n[Console]::Error.WriteLine("ERR")\nexit 7',
        extra: { persistent: false },
      },
      { lang: 'python', script: 'import sys\nprint("OUT")\nprint("ERR", file=sys.stderr)\nsys.exit(7)' },
      { lang: 'node', script: 'console.log("OUT")\nconsole.error("ERR")\nprocess.exit(7)' },
    ];
    const shapes: string[] = [];
    for (const { lang, script, extra } of cases) {
      const result = await tool.handler({ command: script, lang, ...(extra ?? {}) }, ctx);
      if (result.error?.code === 'E_NO_RUNTIME') continue; // 这台机器没有这个解释器：跳过这一档
      const text = normalizeNewlines(result.content);
      assert.match(text, /^OUT$/m, `${lang} 的 stdout 要单独成段`);
      assert.match(text, /\[stderr\]\nERR/, `${lang} 的 stderr 要用同一个 [stderr] 段头`);
      // 状态行：`[exit code: N · <ms>ms]` —— 退出码与耗时同一行、同一个形状
      const status = /^\[exit code: (7) · (\d+)ms\]$/m.exec(text);
      assert.notEqual(status, null, `${lang} 的状态行形状不符（要 [exit code: N · <ms>ms]）：${text}`);
      assert.ok(Number(status![2]) >= 0, `${lang} 的耗时要是个真数`);
      // 形状（把数字抹掉）三档必须逐字相同
      shapes.push(text.replace(/\d+ms/u, '<ms>ms').replace(/\[lang\][^\n]*/u, '').replace(/\[shell\][^\n]*/u, '').trim());
    }
    assert.ok(shapes.length >= 2, `至少两档要能跑（实际 ${shapes.length}）`);
    for (const shape of shapes) {
      assert.equal(shape, shapes[0], `三档的输出形状必须逐字相同（她不想记三套）：\n${shapes.join('\n---\n')}`);
    }
  });

  test('要求②：闸门一致 —— 超时/工作目录/截断三档同源（不是 pwsh 有、python 没有）', async () => {
    const ctx = makeCtx(ws);
    // 超时：python 档也要在 1.5s 内被杀（走的是同一个 superviseChild + kill-tree）
    const slow = await tool.handler(
      { command: 'import time\ntime.sleep(60)', lang: 'python', timeoutMs: 1_500 },
      ctx,
    );
    if (slow.error?.code !== 'E_NO_RUNTIME') {
      assert.equal(slow.error?.code, 'E_TIMEOUT');
      assert.match(slow.content, /已终止进程树/u);
    }
    // 工作目录：被拒的 workdir 在 python 档同样被拒（同一个 assertWorkdir）
    const badCwd = await tool.handler(
      { command: 'print(1)', lang: 'python', workdir: join(ws, '不存在的目录') },
      ctx,
    );
    if (badCwd.error?.code !== 'E_NO_RUNTIME') {
      assert.match(badCwd.content, /工作目录不存在/u);
    }
    // 超时参数：三档用同一个 `timeoutMs`（越界在**发请求之前**就被拒）
    for (const lang of ['pwsh', 'python', 'node'] as const) {
      const tooBig = await tool.handler({ command: 'x', lang, timeoutMs: 60_001 }, ctx);
      assert.equal(tooBig.isError, true, `${lang} 档的 timeoutMs 上限要一样`);
      assert.match(tooBig.content, /timeoutMs/u);
    }
  });

  test('要求③：cwd/变量的口径 —— 只有 pwsh 档共用会话，另两档各开各的', async () => {
    const ctx = makeCtx(ws);
    const sub = join(ws, 'lang-cwd');
    await mkdir(sub, { recursive: true });
    // ① pwsh 档：Set-Location 之后下一条命令就在那（**既有行为，实测的是 v51 就有的东西**）
    await tool.handler({ command: `Set-Location -LiteralPath '${sub.replace(/'/g, "''")}'` }, ctx);
    const where = await tool.handler({ command: '(Get-Location).Path' }, ctx);
    assert.equal(firstLineOf(where.content).toLowerCase(), sub.toLowerCase(),
      'pwsh 档的 cwd 要跨调用保持（持久会话的既有语义）');
    // ② node 档：**不跟 shell 会话**——它自己的 cwd 是 workdir（这里是 ws，不是 sub）
    const nodeCwd = await tool.handler({ command: 'console.log(process.cwd())', lang: 'node' }, ctx);
    assert.equal(firstLineOf(nodeCwd.content).toLowerCase(), ws.toLowerCase(),
      'node 档不许继承 shell 会话的 cwd（各开各的，见 desc 那句"cwd 不跟 shell 会话"）');
    // ③ python 档：同上
    const pyCwd = await tool.handler(
      { command: 'import os\nprint(os.getcwd())', lang: 'python' },
      ctx,
    );
    if (pyCwd.error?.code !== 'E_NO_RUNTIME') {
      assert.equal(firstLineOf(pyCwd.content).toLowerCase(), ws.toLowerCase(), 'python 档同理');
    }
    // ④ 变量：pwsh 档的变量跨调用在（$x 那条既有用例钉着），另两档不在——同一个变量名不给它
    await tool.handler({ command: '$langProbe = 41' }, ctx);
    const pyVar = await tool.handler(
      { command: 'print(globals().get("langProbe", "none"))', lang: 'python' },
      ctx,
    );
    if (pyVar.error?.code !== 'E_NO_RUNTIME') {
      assert.equal(firstLineOf(pyVar.content), 'none', 'python 档不许看到 shell 会话的变量');
    }
    // ⑤ 恢复：shell 会话仍在（上面那些别的档没把它弄坏）
    const stillThere = await tool.handler({ command: 'Split-Path -Leaf (Get-Location).Path' }, ctx);
    assert.equal(firstLineOf(stillThere.content), 'lang-cwd');
  });

  test('要求④：`lang=node` 默认按 .mjs / import 语义（`require` 那个坑不让她自己绕）', async () => {
    const ctx = makeCtx(ws);
    // `import` 直接可用：扩展名是 .mjs，所以工作根的 `"type": "module"` 与它无关
    const esm = await tool.handler(
      { command: 'import fs from "node:fs";\nconsole.log("esm", typeof fs.readFileSync);', lang: 'node' },
      ctx,
    );
    assert.equal(esm.isError, undefined, esm.content);
    assert.equal(firstLineOf(esm.content), 'esm function');
    // 临时脚本后缀就是 .mjs（说明"为什么 require 会报错"这件事在描述里根本不用提）
    const path = scriptPathOf(esm.content);
    assert.match(String(path), /\.mjs$/u, `node 档的临时文件必须是 .mjs：${path}`);
    // `require` 在 ESM 里**确实**不可用——这不是缺陷，是口径；如实报出来即可
    const cjs = await tool.handler({ command: 'const fs = require("node:fs");\nconsole.log("cjs");', lang: 'node' }, ctx);
    assert.equal(cjs.isError, undefined, '跑起来但报错：退出码非零不是工具失败');
    assert.match(cjs.content, /require is not defined|require/u);
    assert.match(cjs.content, /\[exit code: 1 · \d+ms\]/u, '退出码要如实带出来（她据此知道这一段没跑成）');
  });

  test('要求⑤：python 侧现状照实说（缺依赖时报的是 python 自己的错，工具不擅自装）', async () => {
    const ctx = makeCtx(ws);
    // 她给的现状：3.11.5 在、requests / python-docx 缺。工具**不做任何包管理**
    // （不 pip install、不降级、不换语言），只把解释器自己的报错原样带回来。
    const probe = await tool.handler({ command: 'import sys\nprint(sys.version.split()[0])', lang: 'python' }, ctx);
    if (probe.error?.code === 'E_NO_RUNTIME') return;
    assert.match(probe.content, /^3\.\d+\.\d+$/m, '版本号要原样带出来');
    const missing = await tool.handler({ command: 'import requests', lang: 'python' }, ctx);
    assert.equal(missing.isError, undefined, '缺一个包不是工具失败：脚本跑了、退出码非零');
    assert.match(missing.content, /\[exit code: 1 · \d+ms\]/u);
    assert.match(missing.content, /ModuleNotFoundError|No module named/u, '解释器自己的错要原样回给她');
    assert.doesNotMatch(missing.content, /pip install/u, '工具不许替她决定装包（要装先报用户）');
    // 已装的那几个也照实认得（她给的清单）
    const hasPil = await tool.handler({ command: 'import PIL\nprint("PIL ok")', lang: 'python' }, ctx);
    assert.equal(firstLineOf(hasPil.content), 'PIL ok', '她给的清单里 PIL 是在的');
  });

  test('危险动作：按语言分组判（python 的递归删除命得中，正文里的 PowerShell 字符串不误伤）', () => {
    // 而写一个生成 PowerShell 的 python 脚本时，正文里那句 PowerShell 只是数据，不该被拒。
    assert.notEqual(screenCommand('import shutil\nshutil.rmtree("C:/tmp")', 'python'), null);
    assert.equal(screenCommand('print("Remove-Item -Recurse -Force C:/x")', 'python'), null,
      'python 正文里的 PowerShell 字符串只是数据，拿 PowerShell 的语法拒它是误伤');
    assert.notEqual(
      screenCommand('import fs from "node:fs";\nfs.rmSync("C:/", { recursive: true, force: true });', 'node'),
      null,
    );
    // pwsh 档照旧：管的是"递归强制删除"这件事的 shell 写法（既有的 rm-recursive-force 那条）
    assert.notEqual(screenCommand('rm -rf /', 'pwsh'), null);
    // 并且这条分组不影响既有 13 条：`screenCommand` 单参调用的行为与 v51 逐字相同
    assert.equal(screenCommand('Get-ChildItem .'), null);
    assert.notEqual(screenCommand('Remove-Item -Recurse -Force D:\\'), null);
    assert.ok(FORBIDDEN_PATTERNS.length >= 17, '两组语言规则都登记在案');
  });
});

// ──────────────────────────────── PATH 优先的 Python 与 pip（2026-10-17 口径翻正） ────────────────────────────────

/**
 * 用户 2026-10-17 的口径（**覆盖上一版的"托管优先、PATH 兜底"**）：
 *
 * > 「**Python 和 pip 不应该是默认要求装的，而是有就用 PATH 里的。没有的话就要求装。**」
 *
 * 这一组锁四件事，每件都对应一个**会骗到人**的失败形状：
 *   ① **PATH 上有一个可用的 ⇒ 就用它**（哪怕框架也装了一份），且回执里说清"是系统那份"；
 *   ② **PATH 上没有时才用托管那份**（"没有的话就要求装"那条路），回执里说清"是托管那份"；
 *   ③ **两处都没有时的回执必须诚实**：说清试过哪些名字、**脚本一次都没跑**、并给出"框架能替你装"；
 *   ④ **`PIP_CONFIG_FILE` 只给 python 档**，而且只在**真的用托管那份**时才带上
 *      （系统那份旁边没有我们的 pip.ini，硬塞过去就是改掉她自己的 pip 配置）。
 */
describe('pwsh：Python 解释器解析（PATH 优先 · 托管兜底，2026-10-17）', () => {
  let ws = '';
  before(async () => { ws = await workspace('pwsh-pip'); });

  /** 本机 PATH 上那个能跑起来的 python（找不到时返回 null：用例据此如实跳过，而不是假绿） */
  async function pathPython(): Promise<string | null> {
    for (const name of ['python3', 'python']) {
      const found = await new Promise<boolean>((resolve) => {
        const child = spawn(name, ['--version'], { stdio: 'ignore', windowsHide: true });
        child.on('error', () => resolve(false));
        child.on('close', () => resolve(true));
      });
      if (found) return name;
    }
    return null;
  }

  test('PATH 有 python ⇒ 用它（断言回执里的路径 == PATH 上那个），托管那份一次都不被碰', async () => {
    const onPath = await pathPython();
    if (onPath === null) return; // 这台机器上没有 python ⇒ 走下面"两处都没有"那条用例的分支
    let asked = 0;
    const tool = createPwshTool({
      destructiveEnabled: true,
      onWarning: () => undefined,
      langProbe: async () => {
        asked += 1;
        // 宿主给**两槽候选**（PATH 一槽、托管一槽），谁先用由工具定。
        // 托管槽故意指一个**不存在**的路径：真按 PATH 优先就不该碰到它。
        return {
          pathSlot: onPath,
          managedSlot: 'C:\\data\\tools\\python\\python.exe',
          pipConfigFile: 'C:\\data\\tools\\python\\pip.ini',
        };
      },
    });
    try {
      const result = await tool.handler({ command: 'print("path-first-ok")', lang: 'python' }, makeCtx(ws));
      assert.equal(asked, 1, '要先问宿主那两槽候选');
      assert.match(result.content, /path-first-ok/u, 'PATH 优先那条路要真能跑起来');
      // 回执那一行要如实说清**用的是哪一个**（用户 2026-10-16 要路径、10-17 要"哪一份"）
      assert.match(result.content, new RegExp(`\\[lang\\] python · ${onPath}\\b`, 'u'),
        `回执要写明用 PATH 上那个解释器：${result.content.split('\n').slice(-3).join(' | ')}`);
      assert.match(result.content, /系统 PATH 上那份/u, `回执要说清"哪一份"：${result.content.split('\n').slice(-3).join(' | ')}`);
      assert.doesNotMatch(result.content, /框架托管那份/u, '用的是 PATH 那份，回执不许说成托管的');
      assert.doesNotMatch(result.content, /tools\\\\?python/u, '托管那份一次都不该出现在这一次的回执里');
    } finally {
      await tool.shutdown();
    }
  });

  test('两槽候选都起不来时不静默降级：如实报错（"不能假装跑了"）', async () => {
    // 两槽都给**不存在**的路径。⚠ 还必须把 PATH 清空：名字链最后会回落到 `python3` / `python`，
    // 而本机 PATH 上真的有一个（3.11.5）——不清空的话这条用例命中的是它，验的就不是"找不到"了。
    const empty = await tempDir('irmia-broken-slots-');
    const originalPath = process.env['PATH'];
    const originalPathext = process.env['PATHEXT'];
    process.env['PATH'] = empty;
    process.env['PATHEXT'] = '';
    resetInterpreterProbeCache();
    for (const name of ['python3', 'python']) {
      const found = await new Promise<boolean>((resolve) => {
        const child = spawn(name, ['--version'], { stdio: 'ignore', windowsHide: true });
        child.on('error', () => resolve(false));
        child.on('close', () => resolve(true));
      });
      assert.equal(found, false, `前置条件：清空 PATH 之后 ${name} 不该还能起来`);
    }
    const tool = createPwshTool({
      destructiveEnabled: true,
      onWarning: () => undefined,
      langProbe: async () => ({
        pathSlot: 'C:\\never\\there\\python.exe',
        managedSlot: 'C:\\never\\there\\managed\\python.exe',
        pipConfigFile: 'C:\\never\\there\\managed\\pip.ini',
      }),
    });
    try {
      const result = await tool.handler({ command: 'print(1)', lang: 'python' }, makeCtx(ws));
      assert.equal(result.isError, true, `两个候选都起不来时必须失败：${result.content.slice(0, 200)}`);
      assert.match(result.content, /找不到可用的 Python 解释器/u);
    } finally {
      await tool.shutdown();
      resetInterpreterProbeCache();
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
      if (originalPathext === undefined) delete process.env['PATHEXT'];
      else process.env['PATHEXT'] = originalPathext;
    }
  });

  test('PATH 一个都没有、托管有 ⇒ 用托管的（"没有的话就要求装"那条路）', async () => {
    // 用"PATH 清空 + 托管槽给真解释器"造现场：托管槽只有在 PATH 全空时才会被考虑。
    // 本机有 python（3.11.5）时它是**最有说服力**的那条用例：清空 PATH 之前那个必须轮不到。
    const onPath = await pathPython();
    if (onPath === null) return; // 没有真解释器可借 ⇒ 这一条在本机不成立，如实跳过
    const empty = await tempDir('irmia-pathonly-');
    const originalPath = process.env['PATH'];
    const originalPathext = process.env['PATHEXT'];
    process.env['PATH'] = empty;
    process.env['PATHEXT'] = '';
    resetInterpreterProbeCache();
    // 前置条件自检：清完 PATH 之后，名字链必须真的起不来（否则这条用例是假锁）
    for (const name of ['python3', 'python']) {
      const found = await new Promise<boolean>((resolve) => {
        const child = spawn(name, ['--version'], { stdio: 'ignore', windowsHide: true });
        child.on('error', () => resolve(false));
        child.on('close', () => resolve(true));
      });
      assert.equal(found, false, `前置条件：清空 PATH 之后 ${name} 不该还能起来`);
    }
    // 托管槽给**真解释器**的完整路径（`where python` 的答案），于是"PATH 空 ⇒ 用托管"能真跑起来。
    // ⚠ 还原 PATH 之前不许 spawn 那个完整路径——它自己的依赖（DLL）不在 PATH 上会起不来，
    //   所以这一条**只验解析结论**（回执那一行），不验脚本输出。
    const real = await new Promise<string | null>((resolve) => {
      const child = spawn('where', [onPath], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { out += chunk; });
      child.on('error', () => resolve(null));
      child.on('close', () => resolve(out.trim().split(/\r?\n/u)[0]?.trim() || null));
    });
    if (real === null) return;
    const tool = createPwshTool({
      destructiveEnabled: true,
      onWarning: () => undefined,
      langProbe: async () => ({
        pathSlot: onPath,           // 名字链在 PATH 上空了 ⇒ 这一槽不会被解析成功
        managedSlot: real,          // 兜底那一份：完整路径，起得来
        pipConfigFile: join(ws, 'pip.ini'),
      }),
    });
    try {
      const result = await tool.handler({ command: 'print("managed-fallback")', lang: 'python' }, makeCtx(ws));
      assert.equal(result.isError, undefined, `托管兜底要真能跑：${result.content.slice(0, 300)}`);
      assert.match(result.content, /managed-fallback/u);
      assert.match(result.content, /框架托管那份/u, `回执要说清用的是托管那份：${result.content.split('\n').slice(-3).join(' | ')}`);
    } finally {
      await tool.shutdown();
      resetInterpreterProbeCache();
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
      if (originalPathext === undefined) delete process.env['PATHEXT'];
      else process.env['PATHEXT'] = originalPathext;
    }
  });

  test('两处都没有时的诚实回执：说清试过什么、脚本没跑、并给出两条出路', async () => {
    // **造一个"这台机器上什么解释器都没有"的现场**：把 PATH 清空到一个空目录。
    // 不这么做的话本机有 python（3.11.5）⇒ 这条用例永远是"跳过"，那就成了假锁
    // （绿得没有信息）；而探测结果在模块级缓存里，所以先清缓存再改 PATH，最后两个都还原。
    const empty = await tempDir('irmia-nopython-');
    const originalPath = process.env['PATH'];
    const originalPathext = process.env['PATHEXT'];
    process.env['PATH'] = empty;
    process.env['PATHEXT'] = '';
    resetInterpreterProbeCache();
    // 前置条件自检：**清完 PATH 之后那两个名字必须真的起不来**。没有这一条的话，
    // 一旦将来有人改了"解释器从哪儿找"，这条用例会静默变成一条永远跳过的假锁
    // （绿得没有信息——本仓点过名的那种）。所以这里自己 spawn 一次把它钉住。
    for (const name of ['python3', 'python']) {
      const found = await new Promise<boolean>((resolve) => {
        const child = spawn(name, ['--version'], { stdio: 'ignore', windowsHide: true });
        child.on('error', () => resolve(false));
        child.on('close', () => resolve(true));
      });
      assert.equal(found, false, `前置条件：清空 PATH 之后 ${name} 不该还能起来`);
    }
    const tool = createPwshTool({
      destructiveEnabled: true,
      onWarning: () => undefined,
      // 两槽都是空：这正是"这台机器一个 python 都没有、框架也没替它装过"的形状
      langProbe: async () => ({ pathSlot: null, managedSlot: null, pipConfigFile: null }),
    });
    try {
      const ctx = makeCtx(ws);
      const result = await tool.handler({ command: 'print("永远不该被执行")', lang: 'python' }, ctx);
      assert.equal(result.isError, true, `清空 PATH 之后必须找不到解释器：${result.content.slice(0, 200)}`);
      const text = result.content;
      assert.match(text, /找不到可用的 Python 解释器/u);
      assert.match(text, /试过：python3 \/ python/u, '要把试过的名字摆出来（不然她只能瞎试）');
      assert.match(text, /这一段脚本没有执行/u, '**要说清脚本一次都没跑**（不是"跑了但没结果"）');
      assert.match(text, /「外部依赖」/u, '要指出框架能替你装（这不是环境定局）');
      assert.match(text, /pip install/u, '要说出装好之后能干什么（她要 pip 的理由）');
      assert.match(text, /一键装上/u, '要说清那是"一键"（不必她自己折腾）');
      // 说清没跑 ⇒ 工作目录里不该留下任何临时脚本（.irmia-tmp 目录本身可以为空/不存在）
      const tmpDir = join(ws, '.irmia-tmp');
      if (existsSync(tmpDir)) {
        assert.deepEqual(readdirSync(tmpDir).filter((n) => n.endsWith('.py')), [], '没跑就不该留下 .py 临时文件');
      }
    } finally {
      await tool.shutdown();
      resetInterpreterProbeCache();
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
      if (originalPathext === undefined) delete process.env['PATHEXT'];
      else process.env['PATHEXT'] = originalPathext;
    }
  });
});

describe('pwsh：`PIP_CONFIG_FILE` 只给 python 档（用户 2026-10-16 加分项）', () => {
  test('scriptEnv：python 档带 PIP_CONFIG_FILE，pwsh / node 两档一个字节都不加', () => {
    const ini = 'D:\\data\\tools\\python\\pip.ini';
    const py = scriptEnv('python', ini);
    assert.equal(py['PIP_CONFIG_FILE'], ini, 'python 档要指到托管那份 pip.ini');
    // UTF-8 那两句三档都有（v52 的既定行为，不许被这次改动碰掉）
    for (const lang of ['pwsh', 'python', 'node'] as const) {
      assert.equal(scriptEnv(lang, ini)['PYTHONIOENCODING'], 'utf-8');
      assert.equal(scriptEnv(lang, ini)['PYTHONUTF8'], '1');
    }
    // **另两档不许有这个变量**：设上就是污染别人的环境（子进程里读得到）
    assert.equal(scriptEnv('pwsh', ini)['PIP_CONFIG_FILE'], undefined, 'pwsh 档不许被污染');
    assert.equal(scriptEnv('node', ini)['PIP_CONFIG_FILE'], undefined, 'node 档不许被污染');
    // 没有配置时（没装托管 Python / 文件不在盘上）：python 档也不设，而不是设成一个空串
    assert.equal(scriptEnv('python', null)['PIP_CONFIG_FILE'], undefined);
  });

  test('真跑一遍：python 档看得到托管 pip.ini，pwsh / node 两档看不到（端到端）', async () => {
    const dir = await tempDir('irmia-pipenv-');
    const ini = join(dir, 'pip.ini');
    await writeFile(ini, '[global]\ntimeout = 30\n', 'utf8');
    const tool = createPwshTool({
      destructiveEnabled: true,
      onWarning: () => undefined,
      pythonPipConfigFile: ini,
    });
    try {
      const probe = await tool.handler({ command: 'print(1)', lang: 'python' }, makeCtx(dir));
      if (probe.error?.code === 'E_NO_RUNTIME') return; // 本机没有 python ⇒ 如实跳过
      // ① python 档：环境里能看到 PIP_CONFIG_FILE，且指向那个文件
      const py = await tool.handler({
        command: 'import os\nprint("PIPCFG=" + str(os.environ.get("PIP_CONFIG_FILE")))',
        lang: 'python',
      }, makeCtx(dir));
      assert.match(py.content, /PIPCFG=.*pip\.ini/u, `python 档要带上 PIP_CONFIG_FILE：${py.content}`);
      // ② pwsh 档：**看不到**（同一台机器、同一个工具实例，唯一差别是 lang）
      const ps = await tool.handler({ command: 'Write-Output "PIPCFG=$env:PIP_CONFIG_FILE"', lang: 'pwsh', persistent: false }, makeCtx(dir));
      assert.match(ps.content, /PIPCFG=\s*$/mu, `pwsh 档不许被 PIP_CONFIG_FILE 污染：${ps.content}`);
      // ③ node 档：同样看不到
      const js = await tool.handler({
        command: 'console.log("PIPCFG=" + String(process.env.PIP_CONFIG_FILE))',
        lang: 'node',
      }, makeCtx(dir));
      assert.match(js.content, /PIPCFG=undefined/u, `node 档不许被 PIP_CONFIG_FILE 污染：${js.content}`);
    } finally {
      await tool.shutdown();
    }
  });

  test('文件不在盘上时不设这个变量（不指向一个不存在的配置）', async () => {
    const dir = await tempDir('irmia-pipenv-missing-');
    const tool = createPwshTool({
      destructiveEnabled: true,
      onWarning: () => undefined,
      pythonPipConfigFile: join(dir, '从来没有过的-pip.ini'),
    });
    try {
      const probe = await tool.handler({ command: 'print(1)', lang: 'python' }, makeCtx(dir));
      if (probe.error?.code === 'E_NO_RUNTIME') return;
      const py = await tool.handler({
        command: 'import os\nprint("PIPCFG=" + str(os.environ.get("PIP_CONFIG_FILE")))',
        lang: 'python',
      }, makeCtx(dir));
      assert.match(py.content, /PIPCFG=None/u, `文件不存在时不许设：${py.content}`);
    } finally {
      await tool.shutdown();
    }
  });
});

// ──────────────────────────────── 宿主接线：两槽候选真的送到工具那一侧 ────────────────────────────────

/**
 * 上面那一组用的是**注入的 `langProbe`**（验工具怎么用这两槽）。这一组补的是**中间那一跳**：
 * `tools/catalog.ts` 的 `buildShellTools` 是不是真的按"PATH 一槽 + 托管一槽"给出去。
 *
 * 为什么这一跳值得单独锁：它是上一版把口径接反的地方（宿主直接给"赢家"、工具照办）。
 * 只锁两头的话，接线退回旧样子时两头都还是绿的——**绿得没有信息**。
 */
describe('宿主接线：`buildShellTools` 给的两槽候选（PATH 优先 · 托管兜底）', () => {
  test('PATH 上有一个可用的 python ⇒ 托管槽也给了，但工具用 PATH 那个、并如实说"系统那份"', async () => {
    const onPath = await new Promise<string | null>((resolve) => {
      const child = spawn('where', ['python'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { out += chunk; });
      child.on('error', () => resolve(null));
      child.on('close', () => resolve(out.trim().split(/\r?\n/u)[0]?.trim() || null));
    });
    if (onPath === null) return; // 这台机器上没有 python ⇒ 与上面"两处都没有"那条同一处置：如实跳过

    const dir = await tempDir('irmia-wiring-slots-');
    const managedDir = join(dir, 'tools', 'python');
    await mkdir(managedDir, { recursive: true });
    // 托管槽靠**盘上真有那个文件**命中（判据与探测第二段逐字相同），所以这里落一个空文件；
    // 它不在 PATH 上、也不在名字链里 ⇒ 只有"托管那一槽"会给出来
    const managedExe = join(managedDir, 'python.exe');
    await writeFile(managedExe, 'not-a-real-python', 'utf8');
    const ini = join(managedDir, 'pip.ini');
    await writeFile(ini, '[global]\ntimeout = 30\n', 'utf8');

    const deps = new DepsManager({
      dataDir: dir,
      // python 那一件按**真实形状**注入：PATH 上有一个可用的（这一台机器上真有的那个）
      probe: async (name) => {
        if (name === 'python') {
          return {
            name, status: 'ready', path: onPath, version: '3.11.5', anyVersion: '3.11.5',
            source: 'path', dir: null, reason: '', attempts: [],
            pipVersion: '26.2.1', pipReason: '',
          };
        }
        if (name === 'pwsh') {
          // 用**正在跑测试的这个 node** 顶替 pwsh：本工具只认"跑得起来 + 版本主号 ≥ 7"，
          // 而 `node --version` 给的是 `v22.x`（主号 ≥ 7）⇒ pwsh 档可用，python 档才测得到
          return {
            name, status: 'ready', path: process.execPath, version: '22.0.0', anyVersion: '22.0.0',
            source: 'path', dir: null, reason: '', attempts: [],
          };
        }
        return {
          name, status: 'missing', path: '', version: '', anyVersion: '',
          source: null, dir: null, reason: `${name} 未安装`, attempts: [],
        };
      },
    });

    const { registry } = await buildCatalogRegistry({
      dataDir: dir,
      timers: new TimerStore({ dir, fire: () => undefined }),
      emit: () => undefined,
      destructiveEnabled: true,
      deps,
    });
    const tool = registry.get('pwsh');
    assert.ok(tool !== null, 'pwsh 工具要在注册表里');
    try {
      const result = await tool.handler(
        { command: 'print("wiring-ok")', lang: 'python' },
        makeCtx(dir),
      );
      assert.match(result.content, /wiring-ok/u, `接线之后 PATH 那份要真能跑：${result.content.slice(0, 300)}`);
      assert.match(result.content, /系统 PATH 上那份/u,
        `宿主给了两槽、工具要用 PATH 那一槽：${result.content.split('\n').slice(-3).join(' | ')}`);
      // 托管那份的 pip.ini **不该**被塞进系统那份 python 的环境里（那是污染她自己的 pip 配置）
      const env = await tool.handler({
        command: 'import os\nprint("PIPCFG=" + str(os.environ.get("PIP_CONFIG_FILE")))',
        lang: 'python',
      }, makeCtx(dir));
      assert.match(env.content, /PIPCFG=None/u,
        `用系统那份时不许带上托管那份 pip.ini：${env.content.slice(0, 300)}`);
    } finally {
      await tool.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
