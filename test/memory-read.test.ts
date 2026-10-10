/**
 * Irmia Agent — `memory_read` 测试（按索引指针读记忆）
 *
 * 用户的原话：「读记忆时能指定读对应索引的记忆，而不是用 read 工具，导致反复把 state、
 * memory 的全文读入」。这一组用例锁四件事（判据都取自那段话与 design §4.17 第 2 条）：
 *
 *   ① **按指针只给那几条**（含 `!pinned` 条目的形态）；
 *   ② **指针漂了 / 越界 → 明确报错、不返回可能对不上的内容**（"指错了比不指还糟"）；
 *   ③ **读整篇被拒**（上限是硬的，不夹取——夹取会让"我要 200 行"静默变成 40 行）；
 *   ④ **访问账落了、且不含正文**（§4.17 的"访问强化"要的是指针，不是内容）。
 *
 * 走 `buildCatalogRegistry` 而不是直接调 handler：这样"注册进清单了没有"也一并被测到
 * （件数 25 → 26 是一次有意的清单变更，见 docs/design.md §4.18）。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { EventLog } from '../src/log/event-log.ts';
import { buildCatalogRegistry } from '../src/tools/catalog.ts';
import { FS_ERROR_CODES, type ToolDefinition, type ToolContext } from '../src/tools/fs/index.ts';
import { TimerStore } from '../src/wake/timer-store.ts';

// ──────────────────────────────── 夹具 ────────────────────────────────

/**
 * facts.md 的行号是**刻意的**：条目 6 有 3 行（1 条 + 2 条缩进子项），
 * 用来测"读一条会不会顺手把下一条也读进来"。
 */
const FACTS = [
  '# Facts',                              // 1
  '',                                     // 2
  '## 置顶（pinned）',                     // 3
  '- [!pinned] [valid 2026-01-01] (source: turn 3) 用户对花生过敏',  // 4
  '',                                     // 5
  '## 稳定事实',                           // 6
  '- [valid 2026-09-30] (source: config.json persona.owner) 本机用户 = OWNER', // 7
  '  - 子项甲：他周五下午通常开例会',        // 8
  '  - 子项乙：他讨厌八股过渡',              // 9
  '- [valid 2026-10-02] 喝茶不挑',          // 10
  '',                                     // 11
  '## 观察',                               // 12
  '- [valid 2026-10-03] 夜里她转图那次没下结论', // 13
].join('\n');

const JARGON = [
  '# 黑话与含义',                          // 1
  '',                                     // 2
  '（用户用的黑话、缩写、圈内词。）',          // 3
  '',                                     // 4
  '- "老地方" = 他常说的那个会议室，不是地点。', // 5
].join('\n');

interface Fixture {
  ctx: ToolContext;
  tool: ToolDefinition;
  /** 落下来的事件（这次装配里 emit 收到的一切） */
  events: Array<{ type: string; data: unknown }>;
  factsPath: string;
}

/** 夹具：真建一份 MEMORIES/，再走 `buildCatalogRegistry`（顺带把"注册进清单了没有"测到） */
async function fixture(t: TestContext, files?: Record<string, string>): Promise<Fixture> {
  const dataDir = mkdtempSync(join(tmpdir(), 'irmia-memread-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const memDir = join(dataDir, 'workspace', 'MEMORIES');
  mkdirSync(memDir, { recursive: true });
  for (const [name, body] of Object.entries(files ?? { 'facts.md': FACTS, 'jargon.md': JARGON })) {
    writeFileSync(join(memDir, name), body, 'utf8');
  }

  const events: Array<{ type: string; data: unknown }> = [];
  const { registry, problems } = await buildCatalogRegistry({
    dataDir,
    timers: new TimerStore(join(dataDir, 'timers.json')),
    emit: (type, data) => events.push({ type, data }),
    destructiveEnabled: true,
    memoryReadRecorder: (data) => events.push({ type: 'memory/read', data }),
  });
  assert.deepEqual(problems, [], `memory_read 必须注册成功（描述超预算会被静默跳过）：${problems.join('；')}`);
  const tool = registry.get('memory_read');
  assert.ok(tool !== null, 'memory_read 没进清单');

  return {
    ctx: {
      callId: 'call-1',
      turn: 42,
      step: 3,
      signal: new AbortController().signal,
      workspaceRoot: dataDir,
    },
    tool,
    events,
    factsPath: join(memDir, 'facts.md'),
  };
}

// ──────────────────────────────── ① 按指针读到那几条 ────────────────────────────────

test('memory_read：按索引指针读到那一条（默认只读 1 行）', async (t) => {
  const h = await fixture(t);
  const res = await h.tool.handler({ path: 'MEMORIES/facts.md', line: 10 }, h.ctx);
  assert.equal(res.isError, undefined, res.content);
  assert.match(res.content, /喝茶不挑/u, '要读到第 10 行那条');
  assert.ok(!res.content.includes('开例会'), `默认只该读 1 行，不许顺手带上下一条：\n${res.content}`);
  assert.match(res.content, /MEMORIES\/facts\.md:10/u, '要回显指针');
});

test('memory_read：`!pinned` 条目的形态被如实带出来', async (t) => {
  const h = await fixture(t);
  const res = await h.tool.handler({ path: 'MEMORIES/facts.md', line: 4 }, h.ctx);
  assert.equal(res.isError, undefined, res.content);
  assert.match(res.content, /!pinned/u, '置顶标记要出现在回执里');
  assert.match(res.content, /花生过敏/u);
  assert.match(res.content, /用户对花生过敏/u, '摘要里不该带行内标签');
});

test('memory_read：给 lines 能读一条 + 它的缩进子项', async (t) => {
  const h = await fixture(t);
  const res = await h.tool.handler({ path: 'MEMORIES/facts.md', line: 7, lines: 3 }, h.ctx);
  assert.equal(res.isError, undefined, res.content);
  assert.match(res.content, /OWNER/u);
  assert.match(res.content, /子项甲/u);
  assert.match(res.content, /子项乙/u);
  assert.ok(!res.content.includes('喝茶不挑'), 'lines=3 不该越到第 10 行');
  assert.match(res.content, /line=10/u, '要给出接着读的行号');
});

test('memory_read：自由格式文件（jargon.md）同样按指针读', async (t) => {
  const h = await fixture(t);
  const res = await h.tool.handler({ path: 'MEMORIES/jargon.md', line: 5 }, h.ctx);
  assert.equal(res.isError, undefined, res.content);
  assert.match(res.content, /老地方/u);
});

test('memory_read：文件末尾时如实说"已到末尾"', async (t) => {
  const h = await fixture(t);
  const res = await h.tool.handler({ path: 'MEMORIES/facts.md', line: 13 }, h.ctx);
  assert.equal(res.isError, undefined, res.content);
  assert.match(res.content, /已到文件末尾/u);
});

// ──────────────────────────────── ② 漂了 / 越界 → 明确报错，不给错内容 ────────────────────────────────

test('memory_read：指针漂了（那一行不再是条目）→ 报错，且**不返回任何正文**', async (t) => {
  const h = await fixture(t);
  // 把第 10 行那条改写成一段普通说明（不再是 `- ` 开头的条目）
  const shifted = FACTS.split('\n');
  shifted[9] = '（这一段被换成了说明文字，索引里那条指针因此失效）';
  writeFileSync(h.factsPath, shifted.join('\n'), 'utf8');

  const res = await h.tool.handler({ path: 'MEMORIES/facts.md', line: 10 }, h.ctx);
  assert.equal(res.isError, true, `指针失效必须报错：${res.content}`);
  assert.equal(res.error?.code, FS_ERROR_CODES.NO_MATCH);
  assert.match(res.content, /已经不在原来的位置/u, '要说清是"漂了"');
  assert.ok(
    !res.content.includes('这一段被换成了说明文字'),
    `不许把对不上的内容当结果返回：\n${res.content}`,
  );
  assert.ok(!res.content.includes('喝茶不挑'), '更不许返回那条已经不在这一行的记忆');
});

test('memory_read：指针漂了（行被插到前面，行号指到别的条目）→ 报错', async (t) => {
  const h = await fixture(t);
  // 在文件开头插一行：原来第 10 行的"喝茶不挑"被挤到 11 行，第 10 行现在是一条子项/别的条目
  const lines = FACTS.split('\n');
  lines.splice(0, 0, '# 新加的标题行');
  writeFileSync(h.factsPath, lines.join('\n'), 'utf8');

  const res = await h.tool.handler({ path: 'MEMORIES/facts.md', line: 10 }, h.ctx);
  // 第 10 行现在是"子项乙"那一行：它**仍然是条目吗**？facts 的判据要求 `- ` 开头，
  // 子项是缩进的 `  - `，所以不算条目 → 漂了。无论哪种，都**不许**返回"喝茶不挑"。
  assert.equal(res.isError, true, `行号漂了必须报错，实际：${res.content}`);
  assert.ok(!res.content.includes('喝茶不挑'), `不许返回已经不在这一行的那条记忆：\n${res.content}`);
});

test('memory_read：行号越界 → 报错并给出文件实际行数', async (t) => {
  const h = await fixture(t);
  const res = await h.tool.handler({ path: 'MEMORIES/facts.md', line: 999 }, h.ctx);
  assert.equal(res.isError, true);
  assert.equal(res.error?.code, FS_ERROR_CODES.INVALID_ARGS);
  assert.match(res.content, /只有 13 行/u, `要说清文件现在多少行：\n${res.content}`);
  assert.match(res.content, /1~13/u, '要给合法范围');
});

test('memory_read：line 缺省/为 0 都被拒（行号是 1-based，不许猜）', async (t) => {
  const h = await fixture(t);
  const missing = await h.tool.handler({ path: 'MEMORIES/facts.md' }, h.ctx);
  assert.equal(missing.isError, true);
  assert.equal(missing.error?.code, FS_ERROR_CODES.INVALID_ARGS);

  const zero = await h.tool.handler({ path: 'MEMORIES/facts.md', line: 0 }, h.ctx);
  assert.equal(zero.isError, true, 'line:0 不是"第一行"，是没指定');
  assert.equal(zero.error?.code, FS_ERROR_CODES.INVALID_ARGS);
});

test('memory_read：文件不在 → NOT_FOUND，且给下一步（v42：出口是 safe_read，不是已删的 list_dir）', async (t) => {
  const h = await fixture(t);
  const res = await h.tool.handler({ path: 'MEMORIES/nope.md', line: 1 }, h.ctx);
  assert.equal(res.isError, true);
  assert.equal(res.error?.code, FS_ERROR_CODES.NOT_FOUND);
  // 指路必须指向**存在的**那件工具：list_dir 在 v42 删了，回执再提它就是"教她调一个不存在的工具"
  assert.match(res.content, /safe_read/u, '要给一个可执行的下一步');
  assert.doesNotMatch(res.content, /list_dir/u, 'list_dir 已经删了，回执不许再指向它');
});

// ──────────────────────────────── ③ 读整篇被拒 ────────────────────────────────

test('memory_read：lines 超过上限 → 拒绝，而不是夹取', async (t) => {
  const h = await fixture(t);
  const res = await h.tool.handler({ path: 'MEMORIES/facts.md', line: 1, lines: 500 }, h.ctx);
  assert.equal(res.isError, true, `超上限必须拒绝，静默夹取会让"读 500 行"看起来成功了：${res.content}`);
  assert.equal(res.error?.code, FS_ERROR_CODES.INVALID_ARGS);
  assert.match(res.content, /40/u, '要说出上限是多少');
  assert.match(res.content, /safe_read/u, '要看全文要给出正确的路');
});

test('memory_read：只能读 MEMORIES/ 下的文件——任意路径与穿越都拒绝', async (t) => {
  const h = await fixture(t);
  const attempts = [
    'src/main.ts',                    // 根本不是记忆
    'MEMORIES/../../config.json',     // 穿越
    '/etc/passwd',                    // 绝对路径
    'data/persona/STATE.md',          // 别的资产
    'MEMORIES/facts.md/../../../x',   // 拼在文件名后面
  ];
  for (const path of attempts) {
    const res = await h.tool.handler({ path, line: 1 }, h.ctx);
    assert.equal(res.isError, true, `${path} 必须被拒，实际：${res.content}`);
    assert.equal(res.error?.code, FS_ERROR_CODES.PATH_DENIED, `${path} 的错误码`);
    assert.match(res.content, /safe_read/u, `${path} 要说清该走哪条路`);
  }
});

// ──────────────────────────────── ④ 访问账 ────────────────────────────────

test('memory_read：读成功落一条 memory/read，**只放指针、不放正文**', async (t) => {
  const h = await fixture(t);
  const res = await h.tool.handler({ path: 'MEMORIES/facts.md', line: 7, lines: 2 }, h.ctx);
  assert.equal(res.isError, undefined, res.content);

  const reads = h.events.filter((e) => e.type === 'memory/read');
  assert.equal(reads.length, 1, `该落一条访问账，实际 ${reads.length} 条`);
  const data = reads[0]?.data as Record<string, unknown>;
  // turn 来自 ctx.turn（夹具给的是 42）：整理任务要按"最近的"排序，没有 turn 就排不了
  assert.deepEqual(data, { turn: 42, path: 'MEMORIES/facts.md', line: 7, lines: 2, pinned: false });

  // **正文一个字都不许进事件**（与 memory/selected 同一条纪律：内容已经作为工具结果留在历史里）
  const serialized = JSON.stringify(reads[0]);
  assert.ok(!serialized.includes('OWNER'), `事件里不许有正文：${serialized}`);
  assert.ok(!serialized.includes('子项甲'), `事件里不许有正文：${serialized}`);
});

test('memory_read：读失败**不落**访问账（没读到的条目不算被访问）', async (t) => {
  const h = await fixture(t);
  const failed = await h.tool.handler({ path: 'MEMORIES/facts.md', line: 999 }, h.ctx);
  assert.equal(failed.isError, true);
  assert.equal(h.events.filter((e) => e.type === 'memory/read').length, 0, '失败不该记账');

  const drifted = await h.tool.handler({ path: 'MEMORIES/facts.md', line: 3 }, h.ctx);
  assert.equal(drifted.isError, true, '第 3 行是分区标题，不是条目');
  assert.equal(h.events.filter((e) => e.type === 'memory/read').length, 0, '漂了也不该记账');
});

test('memory_read：未接访问账出口时照常可读（账是派生物，不是前提）', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'irmia-memread-noemit-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(join(dataDir, 'workspace', 'MEMORIES'), { recursive: true });
  writeFileSync(join(dataDir, 'workspace', 'MEMORIES', 'facts.md'), FACTS, 'utf8');

  const { registry } = await buildCatalogRegistry({
    dataDir,
    timers: new TimerStore(join(dataDir, 'timers.json')),
    emit: () => undefined,
    destructiveEnabled: true,
    // 刻意不给 memoryReadRecorder
  });
  const tool = registry.get('memory_read');
  assert.ok(tool !== null);
  const res = await tool.handler(
    { path: 'MEMORIES/facts.md', line: 10 },
    { callId: 'c', turn: 1, step: 1, signal: new AbortController().signal, workspaceRoot: dataDir },
  );
  assert.equal(res.isError, undefined, res.content);
  assert.match(res.content, /喝茶不挑/u);
});

// ──────────────────────────────── ⑤ 清单契约 ────────────────────────────────

test('memory_read：在模型视线内，且描述没过硬门', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'irmia-memread-spec-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const { registry, problems } = await buildCatalogRegistry({
    dataDir,
    timers: new TimerStore(join(dataDir, 'timers.json')),
    emit: () => undefined,
    destructiveEnabled: true,
  });
  assert.deepEqual(problems, [], problems.join('；'));
  const names = registry.listForModel({ includeDestructive: true }).map((tool) => tool.name);
  assert.ok(names.includes('memory_read'), '不在模型清单里，加了也白加');
  assert.equal(registry.get('memory_read')?.sideEffect, 'none', '它不写记忆文件');
});

test('memory_read：只读——绝不改记忆文件一个字节', async (t) => {
  const h = await fixture(t);
  const before = readFileSync(h.factsPath);
  await h.tool.handler({ path: 'MEMORIES/facts.md', line: 7, lines: 3 }, h.ctx);
  await h.tool.handler({ path: 'MEMORIES/facts.md', line: 1 }, h.ctx); // 不是条目 → 报错
  assert.deepEqual(readFileSync(h.factsPath), before, '读取不许动文件');
});

// ──────────────────────────────── ⑥ 整链：事件真的落到日志里 ────────────────────────────────

/**
 * 这一条补的是"运行期整链"那块空白（接线进 `main.ts` 之前没法测）。
 *
 * 前五组测的是"工具层把 payload 交出去了没有"（注入一个收集器）。这一条测的是
 * **交出去之后真的落进事件日志**：走真实 `EventLog`（临时目录），把工具交出来的
 * payload 按 `main.ts` 那行的写法写进去，再从盘上读回 JSON 核对。
 *
 * 两件事必须成立：① `memory/read` 能被日志序列化（事件类型在联合里、有默认可见性）；
 * ② **正文一个字都不在日志里**——这是"只放指针不放正文"那条纪律的**盘上证据**，
 * 不再是"我注入了收集器所以相信它"。
 */
const LOG_CHAIN_CASES: Array<[string, number, number]> = [
  ['MEMORIES/facts.md', 7, 2],
  ['MEMORIES/facts.md', 4, 1],
];

test('memory_read：访问账真的落进事件日志，且盘上没有正文', async (t) => {
  const h = await fixture(t);
  const logDir = mkdtempSync(join(tmpdir(), 'irmia-memread-log-'));
  t.after(() => rmSync(logDir, { recursive: true, force: true }));

  const log = await EventLog.open(logDir);
  // 与 `main.ts` 的接线同一写法：把闭包收到的 payload 交给按类型落库的写入口
  const emit = (type: string, data: unknown): void => {
    log.append({
      seq: log.latestSeq() + 1,
      ts: new Date('2026-10-04T00:00:00.000Z').toISOString(),
      type,
      visibility: 'internal',
      origin: 'test',
      data,
    } as never, { sync: true });
  };
  const { registry } = await buildCatalogRegistry({
    dataDir: h.ctx.workspaceRoot,
    timers: new TimerStore(join(h.ctx.workspaceRoot, 'timers.json')),
    emit,
    destructiveEnabled: true,
    memoryReadRecorder: (data) => emit('memory/read', data),
  });
  const tool = registry.get('memory_read');
  assert.ok(tool !== null);

  for (const [path, line, lines] of LOG_CHAIN_CASES) {
    const res = await tool.handler({ path, line, lines }, h.ctx);
    assert.equal(res.isError, undefined, res.content);
  }
  log.close();

  // 从盘上读回：分片文件里就是落库的形状
  const shardDir = logDir;
  const shard = readdirSync(shardDir).filter((name) => name.endsWith('.jsonl'));
  assert.ok(shard.length > 0, `日志分片没建出来：${readdirSync(shardDir).join(', ')}`);
  const onDisk = shard.map((name) => readFileSync(join(shardDir, name), 'utf8')).join('');

  const reads = onDisk.split('\n').filter((l) => l.includes('"memory/read"'));
  assert.equal(reads.length, 2, `该落两条 memory/read，实际 ${reads.length} 条：\n${onDisk}`);
  assert.match(reads[0]!, /"path":"MEMORIES\/facts\.md"/u, '指针要落进去');
  assert.match(reads[0]!, /"line":7/u);
  assert.match(reads[0]!, /"lines":2/u);
  assert.match(reads[1]!, /"pinned":true/u, 'pinned 标记要落进去');

  // **盘上没有正文**：这是"只放指针"的盘上证据
  assert.ok(!onDisk.includes('OWNER'), `日志里不许有正文：\n${onDisk}`);
  assert.ok(!onDisk.includes('子项甲'), `日志里不许有正文：\n${onDisk}`);
  assert.ok(!onDisk.includes('花生过敏'), `日志里不许有正文：\n${onDisk}`);
});

