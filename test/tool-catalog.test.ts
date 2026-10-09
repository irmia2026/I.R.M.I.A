/**
 * 工具清单完整性测试 — buildCatalogRegistry
 *
 * 存在的理由：**描述预算是硬门**（design §4.18：单件 ≤100 token），超了 `register` 会抛错、
 * 由 `buildCatalogRegistry` 记进 `problems` 并**跳过那件工具**——于是「她少了件工具」变成一件
 * 只能从行为异常里反推的事。这个坑已经栽过两次：`pwsh`（119 token）与 `speak`（改措辞后又超，
 * 而提示词正让她「必须调用 speak」——她做不到）。
 *
 * 所以这里把说话的两件工具钉死：它们必须在，且必须在模型视线内。
 *
 * 2026-10-05 补一条口径（那次实测踩到的形状）：**"描述超线 → register 抛错 → 工具静默消失"**
 * 这条链要给一个**直接指向后果**的断言——先红在"它被跳过了"上，而不是红在一个 token 数字上。
 * 见下面"七件…不许悄悄长回去"里第 ① 步（`problems` 必须为空 + 逐件 `registry.has`）。
 *
 * v27 补一条：**工具数本身要有断言**。这一轮按参数级审计删了三件、压下七件描述，
 * 而"删掉了什么"这件事如果不锁，下一次有人加回一件别名工具时不会有人发现——
 * 它只会让每轮请求悄悄多付一份 schema。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildCatalogRegistry } from '../src/tools/catalog.ts';
import { FS_ERROR_CODES } from '../src/tools/fs/index.ts';
import { MAX_DESCRIPTION_TOKENS, estimateTokens } from '../src/tools/registry.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { shellToolName } from '../src/tools/bash.ts';

function catalog(destructiveEnabled = true): ReturnType<typeof buildCatalogRegistry> {
  const timers = new TimerStore({ dir: 'data', fire: () => {} });
  return buildCatalogRegistry({ dataDir: 'data', timers, emit: () => {}, destructiveEnabled });
}

test('工具清单：描述超预算的件一个都不许有（会静默少一件能力）', async () => {
  const { problems } = await catalog();
  assert.deepEqual(problems, [], `有工具被跳过：${problems.join('；')}`);
});

test('工具清单：speak 与 report 必须注册成功', async () => {
  const { registry, problems } = await catalog();
  assert.ok(registry.has('speak'), `speak 没注册：${problems.join('；')}`);
  assert.ok(registry.has('report'), `report 没注册：${problems.join('；')}`);
});

test('工具清单：说话的两件工具必须在模型视线内（关不掉的是能力，不是提示词）', async () => {
  const { registry } = await catalog();
  const names = registry.listForModel({ includeDestructive: true }).map((tool) => tool.name);
  assert.ok(names.includes('speak'), 'speak 不在模型清单里，提示词让她调用也没用');
  assert.ok(names.includes('report'), 'report 不在模型清单里');
});

test('工具清单：destructive 打开时 http_download 必须真的注册（她要用它取 QQ 发来的图）', async () => {
  // 这曾经是半截接线：catalog 只往 createNetTools 传了 enablePost，于是 http_download
  // 无论配置怎么写都不存在——而 QQ 富媒体给的是临时直链，没有它就等于"图片收不到"。
  const opened = await catalog();
  const names = opened.registry.listForModel({ includeDestructive: true }).map((tool) => tool.name);
  assert.ok(names.includes('http_download'), '开了 destructive 却没有下载工具，图片链路是断的');
  assert.ok(names.includes('http_post'), 'http_post 与它同一道门，两个都该在');

  const closed = await catalog(false);
  const closedNames = closed.registry.listForModel({ includeDestructive: true }).map((tool) => tool.name);
  assert.ok(!closedNames.includes('http_download'), '默认关闭时不该注册（出网写入类要人显式开）');
});

test('工具清单：run_command / notify 不许回来；ask_human 回来了，但语义换成了"不挂起"', async () => {
  // 415 次真实调用的参数级审计结论：run_command 0 次、notify 与 speak 重复——这两件的理由
  // （每轮为一份重复的 schema 付费）今天照样成立，所以它们仍然不许回来。
  //
  // ask_human 是**唯一被推翻的那一件**：design §6.5 记了那次删除的理由是"挂起一个 turn 等答复
  // （默认 24h）几乎总是浪费"——**错在"等"，不在"问"**。§6 恢复的是"问"：新实现写完
  // `human/asked{source:'agent'}` 就返回，turn 照常往下走（挂起判定只认系统来源），
  // 人的答复在下一拍出现，没人答则落一条「未批准、未拒绝」的事实。
  // 它带来的是**一处新增调用链**，不是旧形态的复活——语义的锁在新用例里：
  // test/human-ask.test.ts「她问人：写完就继续做，turn 不挂起」那一条。
  const { registry } = await catalog();
  for (const gone of ['run_command', 'notify']) {
    assert.equal(registry.has(gone), false, `${gone} 又被注册回来了（每轮都要为它付一份 schema）`);
  }
  // 能力本身必须有替代出口，否则"删了"就成了"没了"
  assert.ok(registry.has(shellToolName()), '后台能力要有平台命令工具出口');
  assert.ok(registry.has('speak'), '推送能力要有出口：speak 的 level 参数');
  assert.equal(
    (registry.get('speak')?.parameters['properties'] as Record<string, unknown>)['level'] !== undefined,
    true,
    'speak 必须留着 level——它是原来的 notify',
  );

  // ask_human 回来了，且**必须**在模型视线内：她问不到人时只能自己猜
  assert.ok(registry.has('ask_human'), 'ask_human 没注册：§6 的"问"就没有入口');
  const spec = registry.listForModel({ includeDestructive: true }).find((tool) => tool.name === 'ask_human');
  assert.ok(spec !== undefined, 'ask_human 不在模型清单里，提示词让她问也没用');
  // 描述预算是硬门（§4.18）：这一件的常驻开销与其它件同一把尺子
  const tokens = estimateTokens(spec!.description);
  assert.ok(tokens < 60, `ask_human 的描述 ${tokens} token，超过本轮 60 的线`);
});

test('工具清单：六件被压到 60 token 以内的描述不许悄悄长回去', async () => {
  // 单件硬线是 100（超过直接拒绝注册），但这一轮的取舍是**压到 60**：
  // 常驻开销按这几件一起算才看得出收益，单看每一件都"还没超线"。
  //
  // `write_persona` 于 2026-10-04 从这份名单里**移出**（用户拍板）：它的描述从 59 涨到 78，
  // 多出来的是"给 content 整体替换，或给 old/new 只换那一段"——那是**补上一条缺了很久的
  // 写通道**（她 71% 的人格改动原本绕过 write_persona 走 safe_edit，因而没有
  // persona/updated、也不进人格版本库）。理由：`IDENTITY/CONSTITUTION 只读、STYLE 走提案`
  // 这两句**安全边界**比字数预算重要——砍描述先砍掉的就是它们。
  // 78 < 100 的硬门，所以它照旧注册、照旧进模型清单（下面 ① 那条仍然守着"她不许少一件工具"）。
  const { registry, problems } = await catalog();
  // v35：定时器三件（set_timer / cancel_timer / list_timers）并成一件 `timer`。
  // **那条 <60 的线跟着合并后的那一件走，不放宽**：合并的理由之一就是省常驻 token，
  // 而合并最容易发生的退步恰恰是"三个动作各写一段说明"把描述顶回去。
  const tightened = ['speak', 'todo', 'vision_read', 'timer', 'pwsh', 'safe_edit'];

  // ① **先判"它还在不在"**，再判长度。
  //
  //    为什么把这一条放在前面（2026-10-05 实测踩到）：描述一旦越过 100 的硬门，`register` 会抛错、
  //    `buildCatalogRegistry` 把它记进 `problems` 并**跳过注册**——那个后果不是"描述长了一点"，
  //    而是**她少了一件工具**，而这件事只能从"她怎么突然不会记待办了"反推回来。
  //    这一条的好处是把红色落在**最贴近后果的那句话**上：先看见"todo 被跳过了"，
  //    再去下面看它超了多少——而不是先看见一个 token 数字、自己推出"那它大概没注册"。
  assert.deepEqual(
    problems,
    [],
    `有工具因描述超预算被跳过（硬门 ${100} token，见 registry.ts 的 MAX_DESCRIPTION_TOKENS）：`
    + `${problems.join('；')}——她少的是一件能力，不是一个数字`,
  );

  for (const name of tightened) {
    assert.ok(registry.has(name), `${name} 不在清单里（被跳过了？见上一条）`);
    const tool = registry.get(name);
    assert.ok(tool !== null, `${name} 不在清单里`);
    const tokens = estimateTokens(tool.description);
    assert.ok(tokens < 60, `${name} 的描述又长回 ${tokens} token（本轮口径：<60）`);
  }
});

test('工具清单：任何一件的描述都不许贴到硬门上（距硬门不足 10 token 就红）', async () => {
  // 这一条守的是"下一次静默少一件工具"的第一嫌疑人。它和上面那条 <60 的收紧线**不是一回事**：
  // 收紧线只盖那几件（省常驻开销的取舍），这一条盖**全部件**，判据只有一个——离硬门够不够远。
  //
  // 为什么需要它（2026-10-06 实测）：`read_channel` 98/100 —— 距"register 抛错 → 被记进 problems
  // → 跳过注册"只剩 **2 token**（上面 ① 那条守的就是这个后果）。而它不在收紧名单里，
  // 所以那时候**没有任何用例会因为它的描述再多半句话而变红**：她那边只会突然少了这件能力。
  // 有了这一条，涨到 90 就先红在数字上，不必等到 101 红在"她怎么突然不读群了"上。
  //
  // 10 这个余量是**判断**不是推导：一件工具的措辞改一轮通常几十 token 以内，
  // 留 10 token 够改标点、不够再加一句（要加一句，就该走参数描述或先瘦身）。
  const DESCRIPTION_MARGIN_TOKENS = 10;
  const { registry } = await catalog();
  const tight: string[] = [];
  for (const name of registry.names()) {
    const tool = registry.get(name);
    if (tool === null) continue;
    const tokens = estimateTokens(tool.description);
    if (MAX_DESCRIPTION_TOKENS - tokens < DESCRIPTION_MARGIN_TOKENS) {
      tight.push(`${name} ${tokens}/${MAX_DESCRIPTION_TOKENS}`);
    }
  }
  assert.deepEqual(
    tight,
    [],
    `这些工具的描述距硬门不足 ${DESCRIPTION_MARGIN_TOKENS} token：${tight.join('、')}`
    + `——超了硬门不是"描述长一点"，是**这件工具静默消失**（registry.ts 的 MAX_DESCRIPTION_TOKENS）：`
    + '要么瘦身，要么把细节挪进参数描述（参数不进这份预算）',
  );
});

test('工具清单：常驻总量不许悄悄涨（防"文档与实测各说各话"复发）', async () => {
  // 为什么要有这一条：件数与 token 是**每轮请求都要付的常驻开销**，而它历史上一直是"悄悄涨、
  // 事后才发现"的（4391 / 3875 / 3699 / 3931 / 4587 / 4645 / 4839 / 4874 / 5088 / 5167 / 5435，
  // docs/design.md §4.18 记着这一串）。单件都在各自的门内，加起来仍然可能多付一份 schema
  // ——所以钉的是**总量**。
  //
  // 上界 5500 的来历（2026-10-06 实测）：有 `es.exe` 24 件 / **5415**，没 `es.exe` 23 件 / 4933
  // （`_research/tool-count-recount-es.mts` 与 `tool-count-recount.mts`）。留 85 token 余量：
  // 够一次措辞微调，不够再加一件（一件整件 ≥100 token）。**涨过这条线不是"改大这个数"就完事**：
  // 先按 §4.18 那段口径复测、把权威值改准，再决定要不要接受这笔常驻开销。
  const { registry } = await catalog();
  const total = registry.catalogTokens({ includeDestructive: true });
  assert.ok(
    total < 5500,
    `常驻工具说明 ${total} token（上界 5500）：要么加了新工具，要么某件的描述/参数 schema 又长回去了。`
    + '先按 docs/design.md §4.18「口径与复测」复测（_research/tool-count-recount.mts / -es.mts），'
    + '把那段权威值改准，再动这个上界——两处必须一起动',
  );
});

test('工具清单：定时器三件已并成一件 `timer`，旧名不许回来、三个动作一个不许少', async () => {
  // v35（design §4.18）：`set_timer` / `cancel_timer` / `list_timers` 合成的依据是
  // 四天 8 次调用（set 2 / list 6 / cancel 0）却常驻 269 token。合并的是**入口**，
  // 所以这一条同时钉两件事：旧名不许回来（回来就是每轮多付一份 schema），
  // 三个能力也不许少（少了 `list` 她看不到自己排了什么；少了 `cancel` 误排就撤不回来）。
  const { registry } = await catalog();
  for (const gone of ['set_timer', 'cancel_timer', 'list_timers']) {
    assert.equal(registry.has(gone), false, `${gone} 又注册回来了：定时器已并成一件 timer`);
  }
  const timer = registry.get('timer');
  assert.ok(timer !== null, 'timer 是合并后的那一件，不许消失');
  const props = timer.parameters['properties'] as Record<string, unknown>;
  assert.deepEqual((props['action'] as { enum?: unknown }).enum, ['set', 'cancel', 'list'],
    'action 三个取值就是三个能力');
  assert.equal('at' in props && 'cron' in props && 'payload' in props, true, 'set 的两条路与 payload 都要在');
  assert.equal('timer_id' in props, true, 'cancel 必须能指定撤哪一个');
});

test('工具清单：read_file 已改名 safe_read，且行号是**无开关**的默认输出', async () => {
  const { registry } = await catalog();
  assert.equal(registry.has('read_file'), false, 'devkit 原名是 safe_read，read_file 是移植漏改');
  const safeRead = registry.get('safe_read');
  assert.ok(safeRead !== null);
  const props = safeRead.parameters['properties'] as Record<string, unknown>;
  assert.equal('line_numbers' in props, false, '行号不该有开关——它是行号寻址唯一的地址来源');
});

test('人格资产只读（P2）：fs 写工具拒绝 data/persona/**，并把该走哪条路说清楚', async (t) => {
  // 实测：STATE.md 被改 87 次，其中 62 次（71%）走 safe_edit——那条路不写 persona/updated、
  // 也不进人格版本库（快照落 workspace scope，`persona log/diff` 读的是 persona scope）。
  // 只读区这道门早就在 `guardedWrite` 的第零步，只是从前没登记 persona 这一个前缀。
  //
  // 与 write_persona 的局部替换形态**同批**：只堵洞不加形态，等于把她从"改一行"逼成
  // "重写整篇 65 行的 STATE.md"。
  const dir = mkdtempSync(join(tmpdir(), 'irmia-persona-ro-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'data', 'persona'), { recursive: true });
  writeFileSync(join(dir, 'data', 'persona', 'STATE.md'), '# 状态\n心情：还行\n', 'utf8');

  const { registry } = await buildCatalogRegistry({
    // dataDir 传 `dir/data`（**不是 dir**）：别名表与 personaRoot 都是从它推导的，
    // 传错一层就会让 `persona/STATE.md`（短前缀）落到另一个地方去——那正是 P1 要治的病。
    dataDir: join(dir, 'data'),
    timers: new TimerStore(join(dir, 'timers.json')),
    emit: () => {},
    destructiveEnabled: true,
  });
  const ctx = {
    callId: 'call-1', turn: 1, step: 1,
    signal: new AbortController().signal,
    workspaceRoot: dir,
  };

  const attempts: Array<[string, Record<string, unknown>]> = [
    ['safe_edit', { path: 'data/persona/STATE.md', old: '心情：还行', new: '心情：不错' }],
    ['safe_write', { path: 'data/persona/STATE.md', content: '整篇换掉' }],
    ['safe_rollback', { path: 'data/persona/STATE.md' }],
    ['multi_edit', { edits: [{ file: 'data/persona/STATE.md', old: '心情：还行', new: 'x' }] }],
    // 短前缀那一份也要拦得住：P1 的别名表把它改写到同一个文件（相对路径算下来都是 data/persona/…）
    ['safe_edit', { path: 'persona/STATE.md', old: '心情：还行', new: '心情：不错' }],
  ];
  for (const [name, args] of attempts) {
    const tool = registry.get(name);
    assert.ok(tool !== null, `${name} 不在清单里`);
    const result = await tool.handler(args, ctx);
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args.path ?? args.edits)} 必须被拒`);
    assert.equal(result.error?.code, FS_ERROR_CODES.PATH_DENIED, `${name} 的错误码`);
    assert.match(result.content, /只读区/, `${name} 要说清是只读区`);
    assert.match(result.content, /write_persona/, `${name} 要指出该走哪条通道`);
  }
  assert.equal(
    (await import('node:fs')).readFileSync(join(dir, 'data', 'persona', 'STATE.md'), 'utf8'),
    '# 状态\n心情：还行\n',
    '被拒的写入一个字都不许落盘',
  );

  // 读不受限：人格资产对她一直是可读的（不然她没法知道自己的 STATE）
  const read = await registry.get('safe_read')!.handler({ path: 'data/persona/STATE.md' }, ctx);
  assert.equal(read.isError, undefined, read.content);
  assert.match(read.content, /心情：还行/);
});
