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
 *
 * ──────────────────────────── ⚠ 这个测试量的是"哪一份"（v52 写死在这里） ────────────────────────────
 *
 * **它走 `buildCatalogRegistry`，而那个函数不读 `config.json`**（下面的 `catalog()` 传的是
 * `dataDir: 'data'` + `destructiveEnabled` 参数）。⇒ 它给出的件数与 token 是**代码口径**的真值：
 * 「按仓库当前的代码装配出来是哪几件、多少 token」，**不是**"她此刻请求里那一份"。
 * 两者会在这些情况下不同（**这是唯一一条"测试说 A、线上是 B"的缝，写在这里防暗坑**）：
 *   · `config.tools.disabled` 非空 ⇒ 线上少几件（`main.ts:1183` / `:1260` 的 `setDisabled`）；
 *   · `config.tools.destructiveEnabled` 与这里传的值不同 ⇒ 破坏性那九件的取舍不同；
 *   · `config.tools.taskEnabled: true` ⇒ 线上多一件 `task`；
 *   · `mcpClient` 没传 ⇒ 这个测试**量不到 `mcp` 那一件**（它由 catalog 的条件装配决定）。
 * ⇒ 读这条测试的人别把它的数当成"她此刻看到的清单"；要那一份，去读事件日志里
 * `budget/consumed.context.tools`（`tokens` + `count` + `hash` 三个都在）。
 *
 * **当下真值（v79，2026-10-23 实测，探针 `_tmp/catalog-tokens.mjs`）——三条线，别混**：
 *   · **① 硬门 · 代码口径**（**本文件量的就是它**，`registry.catalogTokens`）：
 *     **22 件 / 5366 token**（上界 5500 ⇒ **余 134**）。**这是唯一的门**：下面
 *     "常驻总量不许悄悄涨"（`< 5500`）与"余量 ≥30"两条断言守的都是它。
 *   · **② 运行期口径 · 工具段本身**（含 `mcp`，与线上同集）：**23 件 / 5476**（= 5366 + `mcp` 110）。
 *     ⚠ 它这一版**仍在 5500 以内**（v79 给 `http_get` 描述 +43）——但它**不是门**：本文件**量不到
 *     `mcp`**（`buildCatalogRegistry` 不传 `mcpClient`）⇒ 这个数是**推算**的；要真值去读事件日志
 *     `budget/consumed.context.tools`。
 *   · **③ 合成账**（工具段 5476 ＋ `instructions` 里那几笔常驻 67）= **5543**。**不是门**：
 *     没有任何断言拿它当界，它只是"常驻前缀这几笔加起来多少"的提醒（下一笔开销先复测再决定）。
 *     （67 这个加数沿 v61 那一笔的读法，v74 没有重新拆解它。）
 *   · v61 这一批（**记忆那一批**）：`memory_read` 扩三个入口（`index`/`query`/`n`，**+64**）
 *     ＋ 腾挪 **−34**（`find` 六格 ＋ `safe_edit` 四格）＋ `ask_human` **断装配**
 *     （**不省 token**：它从 v52 起就不在数组里；这一笔是"同批"，不是递增理由）。
 *   · v72（2026-10-20，**装置自述整段置换 ＋ 三处描述**）：**5371 → 5405（+34）**
 *     ＝ `send_media` 描述 **+31**（能力披露：想撤回就先确认这条通道给不给 `·m<id>`）
 *     ＋ `http_post` **+2**、`http_download` **+1**（"默认关闭"改成事实"出厂默认开启"）。
 *     件数不变（22 件）；余量 129 → **95**（仍 ≥30）。
 *   · v74（2026-10-20，**`find` 描述重写**——她本人"真跑了十几次把参数摸清"之后点名要改）：
 *     **5405 → 5407（+2）**：88 → **90** token（单件 100 门照过；同批后面又被 C 那件压回去）。改的是**内容**不是长度：
 *     分工（文件名＝glob / 内容＝grep）、`pattern` 必填、只给 `ext` 会报错、`path` 可**绝对**、
 *     `file_type`（不叫 `type`）、`max_results=0` 只报数量、一行示例；删掉了 `\d` 支持清单与
 *     `PATH_HINT`（那两句正是把她引向"绝对路径不能用"的误读，且六件工具共用一份、只读工具不需要
 *     "只约束写"那半句）。
 *   · v74 同批第二件（**`speak` / `report` 的调用与回执压到极限**，用户点名的"最高频工具，
 *     调用与回执都要极限降低"）：回执三态（`发送成功` / `成功，但超25字限制（N 字）` /
 *     `失败，<原因>`；按**正文 runes** 数），单条 **94 → 4 token**，按 162.5 条在场每次请求
 *     **15,275 → 650 token**；指导搬进 `SELF_BRIEF` §2.1 ⇒ `speak.desc` **55 → 38**、
 *     `report.desc` **59 → 44**、`speak` 参数 **183 → 131**（`to` 一个字节没删）。
 *     ⇒ 代码口径 **5355 → 5323**（−32）；余量 145 → **177**（仍 ≥30）。运行期 ＋`mcp` 110 = **5433**。
 *     回执那一半不占 `tools`（它是历史里的 `tool/result`）——省的是后续请求，见上。
 *   · v79（2026-10-23，**`http_get` 换正文抽取器 + 三句失败诊断 + 截断报真实总量**）：
 *     **5323 → 5366（+43）**＝ `http_get` 描述 **54 → 86（+32）**（能力披露：默认给可读正文 /
 *     默认一次给全并可续读 / 非 HTML 原样给 / 抓不到会点名下一步用哪件工具 / Referer·Cookie 走
 *     `headers`）＋ `url` 参数 **+7**（私网/环回被 SSRF 拒绝，仍写在参数里而不是占描述预算）
 *     ＋ `max_chars` 参数 **+4**（印出 500000 硬上限）。余量 177 → **134**（仍 ≥30）。
 *     同批 `net.ts` 的回执文本大改（`[续读]` 报真总量 + 两条路、`[诊断]` 三句、`[编码]` 读
 *     `<meta charset>` 与"可能有损"）——**回执不占 `tools`**，占的是历史里的 `tool/result`。
 *   · v80（2026-10-23，**`read_channel` 翻页一页的条数 50 → 15**）：**5366，未动**——这个数逐字进
 *     `before` / `limit` 两个参数描述，而 `50` → `15` 是**等宽替换**，`estimateTokens` 那把尺
 *     一分不差（上界 5500 ⇒ 余量仍是 **134**）。**字节变了、token 没变**：所以 `RENDER_VERSION`
 *     照旧要递（v80），这一格不用改。
 *   · 历史：v52 5358 / v55 5280 / v57 5313 / v59 5362 / v61 5392 / v67 5371 / v72 5405 / v74 5323 /
 *     **v79 5366 / v80 5366**。
 *   · 权威值的出处：`docs/design.md §4.18`「口径与复测」那一段与 `src/model/render.ts` 的
 *     **v80** 那一篇（**当次版本**那一篇；两处必须一起改）。
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { buildCatalogRegistry, HIDDEN_FROM_MODEL } from '../src/tools/catalog.ts';
import { FS_ERROR_CODES } from '../src/tools/fs/index.ts';
import { MAX_DESCRIPTION_TOKENS, estimateTokens } from '../src/tools/registry.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

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

test('工具清单：run_command / notify 不许回来；ask_human **入口已断**（实现留死代码）', async () => {
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
  assert.ok(registry.has('pwsh'), '后台能力要有出口：pwsh');
  assert.ok(registry.has('speak'), '推送能力要有出口：speak 的 level 参数');
  assert.equal(
    (registry.get('speak')?.parameters['properties'] as Record<string, unknown>)['level'] !== undefined,
    true,
    'speak 必须留着 level——它是原来的 notify',
  );

  // ── ask_human：**断装配**（2026-10-15 用户裁决第二版）──────────────────────────
  //
  // 用户原话（逐字，唯一判据）：
  // > 「我让你移除的 ask_human 貌似没移除？（**移除入口，也不再进入任何请求**，相关内容
  // > **只作为保留在仓库中的死代码**）」
  //
  // v52 那次做的是"**代码级隐藏**"（`HIDDEN_FROM_MODEL`）：它不列进模型清单，但**注册表里还在**
  // ⇒ `registry.get('ask_human')` 非 null、`executor` 只按名字查表（**不看 visibility**）
  // ⇒ **执行期依然可达**（实测直接调它的 handler 会照旧写下 `human/asked{source:'agent'}`）。
  // 那不是用户要的"移除入口"，所以这一版把它从**装配**这一层就剔掉。
  //
  // 判据的两半都要钉住，只钉一半会漏掉两种真实的退步：
  //   ① 只钉"不在清单里" ⇒ 有人把它加回 `buildToolCatalog` 也不会有用例红
  //      （而"注册表里没有它"才是"入口断了"的可执行定义）；
  //   ② 只钉"注册表里没有" ⇒ 把实现一起删掉（`createAdminTools` 里那件）也看不出来，
  //      而"**实现作为死代码保留**"是用户原话的后半句（随时一行改回来）。
  assert.equal(registry.has('ask_human'), false, '入口必须断在装配层：注册表里没有它');
  assert.equal(registry.get('ask_human'), null, '执行期因此不可达（get 返回 null）');
  assert.equal(registry.isHidden('ask_human'), false, '它不是"被隐藏"——是**根本没注册**');
  const spec = registry.listForModel({ includeDestructive: true }).find((tool) => tool.name === 'ask_human');
  assert.equal(spec, undefined, '也不在模型清单里（那一份是注册表的函数，注册表没有它就没有）');
  assert.deepEqual(HIDDEN_FROM_MODEL, [], '隐藏名单现在**是空的**（机制留着给以后用，见 catalog.ts）');

  // ② **实现必须原样保留**（死代码）：它不经过注册表也能被造出来——
  //    这就是 `test/human-ask.test.ts` / `plan-askhuman.test.ts` 走的那条路
  //    （`createAdminTools(...).byName('ask_human')`），所以那些用例**一条都没改**。
  const { createAdminTools } = await import('../src/tools/admin.ts');
  const admin = createAdminTools({
    dataDir: 'data',
    timers: new TimerStore({ dir: 'data', fire: () => {} }),
    emit: () => {},
  });
  assert.equal(
    typeof admin.byName('ask_human').handler,
    'function',
    '实现作为**死代码**保留（用户原话后半句）：不删、随时一行改回来',
  );
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
  // 事后才发现"的（4391 / 3875 / 3699 / 3931 / 4587 / 4645 / 4839 / 4874 / 5088 / 5167 / 5435 / 5497 / 5370 / 5480，
  // docs/design.md §4.18 记着这一串）。单件都在各自的门内，加起来仍然可能多付一份 schema
  // ——所以钉的是**总量**。
  //
  // 上界 5500 的来历（2026-10-06 实测）：有 `es.exe` 24 件 / **5415**，没 `es.exe` 23 件 / 4933
  // （`_research/tool-count-recount-es.mts` 与 `tool-count-recount.mts`）。留 85 token 余量：
  // 够一次措辞微调，不够再加一件（一件整件 ≥100 token）。**涨过这条线不是"改大这个数"就完事**：
  // 先按 §4.18 那段口径复测、把权威值改准，再决定要不要接受这笔常驻开销。
  //
  // v52（2026-10-12）的本条视角真值：**23 件 / 5358**（= 运行期 24 件 / 5468 − `mcp` 110）。
  // v55（2026-10-13，timer `payload` 三格约定那一批）的本条视角真值：**23 件 / 5280**
  // （= 运行期 24 件 / 5390 − `mcp` 110）。净变化 = **−78**：`+7`（`timer.payload` 点明三格）
  // 抵掉 **−85**（四件大工具的参数说明压缩：`find` −43（描述 −22 / 参数面 −21）/
  // `safe_edit` −24 / `safe_read` −18 / `grep` 未动；逐条 diff 表见提交说明与
  // `_research/_tmp-v55-params-account.mts`）。
  // ⚠ 这一批真正要装的是 `instructions` 那段（`PAYLOAD_SHAPE_TEXT` **+67**）：①②同批之后
  // 运行期 = 5390 + 67 = **5457 / 5500（余 43）**，`<5500` 与"余量 ≥30"两条都还绿。
  // v57（2026-10-12，timer `payload` 再约四格 `title`/`cat`/`dur`/`action`）：**23 件 / 5313**（+33）；
  // v59（2026-10-12，timer `payload` 再约一格 `scope` = 她自己的内部事不上日程页的周历）：
  // **23 件 / 5362**，净变化 = **+49**（只加了那一句描述）⇒ 余量 **187 → 138**（本条判据 ≥30 仍绿）。
  //   另两条线只记在文件头、不在这里判：② 运行期口径（含 `mcp`）**5472**、③ 合成账（＋那段 `instructions`
  //   的几笔常驻）**5725**——**③ 不是门**，别拿它当余量（本文件量不到 `mcp`，②③ 都只是推算出来的账）。
  // ⚠ 这个测试**不读 `config.json`**（文件头的"量的是哪一份"那一段）：它给的是**代码口径**，
  // 不是"她此刻请求里那一份"。
  const { registry } = await catalog();
  const total = registry.catalogTokens({ includeDestructive: true });
  assert.ok(
    total < 5500,
    `常驻工具说明 ${total} token（上界 5500）：要么加了新工具，要么某件的描述/参数 schema 又长回去了。`
    + '先按 docs/design.md §4.18「口径与复测」复测（_research/tool-count-recount.mts / -es.mts，'
    + 'v52 起还可以用 _research/_tmp-tools-token-before.mts 量"含 mcp"那一档；'
    + 'v59 那一代的实录见 _research/_tmp-v59-tools-account.mts），'
    + '把那段权威值改准，再动这个上界——两处必须一起动',
  );
});

test('工具清单：v52 的五件一批在上界之内（余量别被下一件吃掉）', async () => {
  // 为什么单独立一条：上一条只判"<5500"，而**余量本身**是这一批真正在管的东西——
  // v52 落进来之前，余量是 20（再来一件 ≥100 的工具就塞不下）。那一批靠
  // "隐藏 `ask_human` −134、加 `web_search` +258、参数说明压缩 −160"把余量拉到 **32**。
  //
  // 判据刻意是"余量 ≥ 30"而不是某个具体值：措辞微调会让它上下动（那是有意允许的），
  // 但**再加一件工具**（≥100）必然把它打到线下——那正是这条要拦的事。
  // 口径与文件头一致：这是**代码口径**（不含 `mcp`），运行期口径 = 这个数 + 110。
  // v55（2026-10-13）：代码口径 5358 → **5280** ⇒ 余量 142 → **220**；运行期 5468 → **5390**。
  // v59（2026-10-12）：**5313 → 5362**（timer 的 `payload` 再约一格 `scope`，+49）⇒ 余量 138。
  // v61（2026-10-15，**记忆那一批**）：**5362 → 5392（+30）** ⇒ 余量 **108**；运行期 **5502**。
  //   净 +30 = `memory_read` 扩三个入口（`index`/`query`/`n`）**+64**（整件 169 → 233）
  //   ＋ 腾挪 **−34**（`find` 六格 354 → 330 ＋ `safe_edit` 四格 327 → 317：
  //   只删"同一件事写两遍"）。
  //   ⚠ 运行期那一档越过 5500 那条**提醒线**（v61 +2、v72 +15），但**它不是门**（本文件头写死了：
  //   唯一那道门是下面这个 `catalogTokens`）——**别读成"破线"**，门的余量是 95。
  // v72（2026-10-20）：**5371 → 5405（+34）** ⇒ 余量 129 → **95**；运行期 **5515**。
  //   净 +34 = `send_media` 描述 +31（能力披露）＋ `http_post` +2 ＋ `http_download` +1
  //   （后两件是把"默认关闭"改成事实——出厂默认自 2026-10-21 起是全开）。
  const MIN_HEADROOM = 30;
  const { registry, problems } = await catalog();
  assert.deepEqual(problems, [], `有工具被跳过：${problems.join('；')}`);
  const total = registry.catalogTokens({ includeDestructive: true });
  const names = registry.listForModel({ includeDestructive: true }).map((tool) => tool.name);
  assert.equal(names.length, 22, `代码口径的件数变了（v64：22 件 = 运行期 23 件 − mcp；砍 read_blob 后 23 → 22）：${names.length}`);
  // 两件"这一批动过的"必须在场：`web_search` 是新加的、`pwsh` 是改造过的
  assert.ok(names.includes('web_search'), 'web_search 必须常驻（它固化的是她一直在手搓的那条路）');
  assert.ok(names.includes('pwsh'), 'pwsh 必须常驻');
  // `ask_human` **入口已断**（2026-10-15 裁决第二版）：清单与注册表里都没有它
  assert.ok(!names.includes('ask_human'), 'ask_human 不许再进工具数组');
  assert.equal(registry.has('ask_human'), false, '注册表里也没有它（"移除入口"的可执行定义）');
  assert.ok(
    5500 - total >= MIN_HEADROOM,
    `上界 5500 只剩 ${5500 - total} token（v72 之后的余量是 95；判据 ≥ ${MIN_HEADROOM}）：`
    + '再加一件工具（整件 ≥100 token）或让某件的说明长回去，都会把余量吃到线下。'
    + '要加就先按 docs/design.md §4.18 复测、再决定从哪里腾地方（v52 腾的是 ask_human 那 134、'
    + 'v55 腾的是四件大工具参数说明里重复与废话那 85、v61 腾的是 find/safe_edit 那 37）',
  );
});

test('工具清单：定时器三件已并成一件 `timer`，旧名不许回来、四个动作一个不许少', async () => {
  // v35（design §4.18）：`set_timer` / `cancel_timer` / `list_timers` 合成的依据是
  // 四天 8 次调用（set 2 / list 6 / cancel 0）却常驻 269 token。合并的是**入口**，
  // 所以这一条同时钉两件事：旧名不许回来（回来就是每轮多付一份 schema），
  // 四个能力也不许少（少了 `list` 她看不到自己排了什么；少了 `cancel` 误排就撤不回来；
  // 少了 `wait`——2026-10-08 用户的口径「timer 提供一个 wait」——她就只能自己算绝对时刻，
  // 或者干脆在原地反复 read_channel）。
  const { registry } = await catalog();
  for (const gone of ['set_timer', 'cancel_timer', 'list_timers']) {
    assert.equal(registry.has(gone), false, `${gone} 又注册回来了：定时器已并成一件 timer`);
  }
  const timer = registry.get('timer');
  assert.ok(timer !== null, 'timer 是合并后的那一件，不许消失');
  const props = timer.parameters['properties'] as Record<string, unknown>;
  assert.deepEqual((props['action'] as { enum?: unknown }).enum, ['set', 'wait', 'cancel', 'list'],
    'action 四个取值就是四个能力');
  assert.equal('at' in props && 'cron' in props && 'payload' in props, true, 'set 的两条路与 payload 都要在');
  assert.equal('timer_id' in props, true, 'cancel 必须能指定撤哪一个');
  // wait（2026-10-08）：时长两个单位都在（参数描述里写明单位），上限写在 minutes 那一格里
  assert.equal('seconds' in props && 'minutes' in props, true, 'wait 的时长要有分钟与秒两个单位');
  assert.match(String((props['seconds'] as { description?: string }).description), /秒/u,
    '单位必须写进参数描述（她看得到的就是那一行）');
  assert.match(String((props['minutes'] as { description?: string }).description), /分钟/u);
  assert.match(String((props['minutes'] as { description?: string }).description), /12 小时/u,
    '上限要写清（防呆：更远的唤醒该走 set 的 at/cron）');
});

test('工具清单：read_file 已改名 safe_read，且行号是**无开关**的默认输出', async () => {
  const { registry } = await catalog();
  assert.equal(registry.has('read_file'), false, 'devkit 原名是 safe_read，read_file 是移植漏改');
  const safeRead = registry.get('safe_read');
  assert.ok(safeRead !== null);
  const props = safeRead.parameters['properties'] as Record<string, unknown>;
  assert.equal('line_numbers' in props, false, '行号不该有开关——它是行号寻址唯一的地址来源');
});

test('工具清单：list_dir 已删（v42 并入 safe_read），旧名不许回来、列目录的能力也不许少', async () => {
  // 删除依据是实测：`data/events/**` 全部 `tool/call` 里 `list_dir` **201 次 / 5264 次总量**、
  // 近 24h 仅 1 次，却常驻 212 token（name 2 / desc 40 / params 170）——而列目录这件事
  // `pwsh` 的 `Get-ChildItem` 与 `safe_read` 的目录形态都能做。腾出的常驻开销是留给 `mcp` 的。
  //
  // 这一条钉两件事（与"定时器三件并成一件"、"run_command / notify 不许回来"同一套写法）：
  // ① 旧名不许回来（回来就是每轮多付一份 schema）；② **能力一件都不许少**——
  //    `safe_read` 必须带着目录形态（`depth` 参数 + 那句"传目录则列目录"），
  //    否则"删了一件工具"就变成了"她不会列目录了"。
  const { registry, problems } = await catalog();
  assert.equal(registry.has('list_dir'), false, '`list_dir` 又注册回来了：v42 已把它并进 safe_read');
  assert.deepEqual(problems, [], `有工具被跳过：${problems.join('；')}`);

  const safeRead = registry.get('safe_read');
  assert.ok(safeRead !== null, 'safe_read 是承接列目录的那一件，不许消失');
  const props = safeRead.parameters['properties'] as Record<string, unknown>;
  assert.equal('depth' in props, true, '目录形态要能递归（旧 list_dir 的 depth 实测用了 136/201 次）');
  // 条数上限走既有的 limit（不新添常驻参数），描述里必须说清"目录时是什么单位"
  assert.match(String((props['limit'] as { description?: string }).description), /目录/u,
    'limit 兼作列目录的条数上限——这件事必须写在它自己的参数描述里');
  assert.match(safeRead.description, /目录/u, '工具描述里要有"传目录则列目录"，否则没有任何地方告诉她');
  // `pwsh` 是递归/隐藏项/按时间排这些少数用法的出口，指路必须留着——**只是换了一格**
  // （v52：那句从工具描述搬进了 `command` 的参数描述，见下"权威值"那一段的说明）。
  // 判据不变：她"想列目录"时总读得到这一句；断言的落点跟着那句所在的格子走，别把
  // "换位置"当成"删了"（这条用例钉的是**能力在不在**，不是它在哪一格）。
  const pwsh = registry.get('pwsh');
  assert.ok(pwsh !== null);
  const pwshProps = pwsh.parameters['properties'] as Record<string, { description?: string }>;
  assert.match(
    String(pwshProps['command']?.description),
    /Get-ChildItem/u,
    '少了指路她会在"想列目录"时发懵',
  );
});

test('人格资产只读（P2）：fs 写工具拒绝 data/persona/**，并把该走哪条路说清楚', async (t) => {
  // 实测：STATE.md 被改 87 次，其中 62 次（71%）走 safe_edit——那条路不写 persona/updated、
  // 也不进人格版本库（快照落 workspace scope，`persona log/diff` 读的是 persona scope）。
  // 只读区这道门早就在 `guardedWrite` 的第零步，只是从前没登记 persona 这一个前缀。
  //
  // 与 write_persona 的局部替换形态**同批**：只堵洞不加形态，等于把她从"改一行"逼成
  // "重写整篇 65 行的 STATE.md"。
  const dir = tempDirSync('irmia-persona-ro-');
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
