/**
 * 数字资产（`MEMORIES/assets.md` + 框架聚合的事实层）——判据
 *
 * 口径分两段，**别把它们读混**：
 *   · **v34–v44**（2026-10-06 起）：框架在轮首读这份清单、把索引喂给 light 挑 ≤3 条、渲染成
 *     此刻层任务卡上那一行「本任务相关资产：…」。
 *   · **v45**（2026-10-09 用户拍板）：**那条机制取消**——理由（他的口径）是准确率太低，
 *     抽 18 条看过：一半合理，系统性误判是"去群里说一声"被匹到一个私有工具、
 *     "另一个实例"被匹到 `gh`。于是**框架不再替她挑**：清单不进她的上下文，
 *     要用哪件由她自己照清单（与每一条的 SKILL.md 指路）去读。
 *
 * 取消之后**还成立**的判据（这一份文件守的就是这些）：
 *   ① **那一行不在请求体里了**：真链路跑一轮，此刻层与整份 input 里都没有它，
 *      也没有 `origin='persona/assets'` 的 `budget/consumed`（那一笔 light 账随选取一起没了）；
 *   ② **她那份清单原样在**：解析、坏行如实计数、种子幂等且不预置条目；
 *   ③ **事实层照旧**：技能目录 / MCP 声明 / PATH 探测——**不要求她手抄事实**，
 *      没核对就不假装核对过（`unknown`），读不到配置面不写成"确实没有"；
 *   ④ **常驻的只有那一句规则**（先读说明再用、不许凭名字猜），而且装置自述里**不再有**
 *      "干活时框架会挑几条放在你任务旁边"那句假承诺（评审点名过的那一句）。
 *
 * 台子见 `test/fixtures/real-wake-rig.ts`：**真 RealLoop + 真 agent-loop + 真 render**，
 * 只有模型是假的——"那一行到底还在不在请求里"只有走整条链路才证得了。
 * 旧日志那一侧（`memory/selected.assets` → 逐字节重建）另钉在 `test/replay.test.ts` 的 v34 那条。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { heartbeatData, makeRealWakeRig } from './fixtures/real-wake-rig.ts';
import { NOW_LAYER_BANNER, type RenderInput, type RenderPersona, render } from '../src/model/render.ts';
import { SELF_BRIEF } from '../src/model/self-brief.ts';
import {
  ASSET_NOTE_CHARS_MAX, assetsFile, clipAssetNote, commandOf, ensureAssetsSeed,
  factOf, indexOf, isUsable, parseAssetLine, parseAssets, probeOnPath, readAssets, withFacts,
  type AssetFactSource, type TaskAsset,
} from '../src/persona/assets.ts';
import { memoriesDir } from '../src/persona/memory-maintain.ts';

const NO_FACTS: AssetFactSource = { skills: undefined, mcp: undefined, probePath: undefined };
const NOW = '2026-02-14T10:00:00.000+08:00';

/** 落一份清单（路径与生产一致：`<dataDir>/workspace/MEMORIES/assets.md`） */
function writeAssets(rig: { dir: string }, content: string): string {
  const file = join(rig.dir, 'data', 'workspace', 'MEMORIES', 'assets.md');
  mkdirSync(join(rig.dir, 'data', 'workspace', 'MEMORIES'), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return file;
}

/** 从一段渲染出来的 input 里取此刻层那一段文本 */
function nowLayerOfItems(items: ReadonlyArray<{ content?: unknown }> | undefined): string {
  for (const item of items ?? []) {
    if (typeof item.content === 'string' && item.content.includes(NOW_LAYER_BANNER)) return item.content;
  }
  return '';
}

/** 从一次请求里取出此刻层那一段文本（按段头认层，不按索引——与 render 自己的做法一致） */
function nowLayerOf(request: { input?: unknown }): string {
  const items = Array.isArray(request.input) ? request.input : [];
  return nowLayerOfItems(items as Array<{ content?: unknown }>);
}

/** 一份"要是那条机制还在，必然会被挑中"的清单：三件都写着 `已在 PATH`（探测都能找到） */
const THREE_ASSETS = [
  '# 数字资产',
  '',
  '- [path] Obscura ｜ 按策略抓网页正文 ｜ 已在 PATH',
  '- [path] gh ｜ 命令行管 GitHub ｜ 已在 PATH',
  '- [path] ffmpeg ｜ 转码与抽帧 ｜ 已在 PATH',
].join('\n');

/** 确定性的 PATH 探测（事实层的输入）：这几条找得到、其余找不到 */
const PROBE = (command: string): { found: boolean; path?: string } => {
  const name = command.trim().toLowerCase();
  if (name === 'obscura') return { found: true, path: 'C:\\Tools\\obscura\\obscura.exe' };
  if (name === 'gh') return { found: true, path: 'C:\\Program Files\\Git\\cmd\\gh.exe' };
  return { found: false };
};

// ──────────────── ① v45：那一行不再进请求（真链路，端到端） ────────────────

/*
 * 为什么这一条要**走整条链路**：删掉一个函数、删掉一次调用，都可能留下"看起来还在"的形态
 * （比如事件里还记着、此刻层还渲染着、账上还在花钱）。只有真 RealLoop + 真循环 + 真渲染
 * 跑出来的**请求体**与**事件流**能证否。
 */
test('① 真链路：那一行不再出现，也没有 persona/assets 那一笔 light 账', async (t) => {
  const rig = await makeRealWakeRig({
    // 只给 heavy 脚本：台子的假模型在"脚本耗尽还要被调用"时直接抛 ⇒ light 多调一次就会红
    stream: [{ text: '', toolCalls: [] }],
    probeAssetPath: PROBE,
  });
  t.after(rig.dispose);
  writeAssets(rig, THREE_ASSETS);

  rig.append('wake/manual', { note: '把这篇文章抓下来整理成 markdown' });
  await rig.tick();

  // ①a 一次 light 都不发（原来这一拍是「判注入?（手动唤醒不判）→ 挑资产（light）→ heavy」）
  assert.deepEqual(rig.requests.map(item => item.lane), ['heavy'],
    '取消之后这一拍只有她自己的主力车道：不再有"先花一次 light 挑资产"');
  assert.equal(rig.requests.filter(item => item.lane === 'light').length, 0);

  // ①b 请求体里那一行没有了（整份 input 逐字查，不只看此刻层）
  const heavy = rig.requests[0]!.request;
  const now = nowLayerOf(heavy);
  assert.ok(now.includes('当前任务：'), `任务卡照旧在（实际：${now}）`);
  assert.ok(!now.includes('本任务相关资产'), `此刻层里不再有那一行（实际：${now}）`);
  assert.ok(!JSON.stringify(heavy.input).includes('本任务相关资产'), '整份 input 里也没有');
  // 清单内容当然也不在（它从来就没常驻过）
  assert.ok(!JSON.stringify(heavy.input).includes('Obscura'), '清单内容不进她的上下文');

  // ①c 账：没有 `origin='persona/assets'` 的 budget/consumed，也没有带 assets 的 memory/selected
  const events = await rig.events();
  const consumed = events.filter(event => event.type === 'budget/consumed');
  assert.equal(consumed.filter(event => event.origin === 'persona/assets').length, 0,
    '那一笔 light 账随选取一起没了（原来每次选取记一条）');
  assert.deepEqual(consumed.map(event => event.data.lane), ['heavy'], '这一拍只剩 heavy 那一条账');
  const selected = events.filter(event => event.type === 'memory/selected');
  assert.equal(selected.length, 1, '记忆索引那条账照旧（它跟资产无关）');
  assert.equal((selected[0]!.data as { assets?: string }).assets, undefined,
    '新的事件里不再有那一格（旧日志里那些仍然读得回来，见 replay 用例）');

  // ①d 循环日志里也没有"挑了哪几条"那一行
  assert.ok(!rig.lines.some(line => line.includes('[数字资产]')),
    `控制台不再有 [数字资产] 那些行（实际：${JSON.stringify(rig.lines.filter(l => l.includes('[数字资产]')))}）`);
});

test('①b 心跳拍：同样不发 light（与取消之前一致的那一半）', async (t) => {
  const rig = await makeRealWakeRig({ stream: [{ text: '', toolCalls: [] }], probeAssetPath: PROBE });
  t.after(rig.dispose);
  writeAssets(rig, THREE_ASSETS);

  rig.append('wake/heartbeat', heartbeatData(1800, 1));
  await rig.tick();

  assert.deepEqual(rig.requests.map(item => item.lane), ['heavy']);
  assert.ok(!nowLayerOf(rig.requests[0]!.request).includes('本任务相关资产'));
});

test('①c 那一行的渲染代码还在（旧日志重建要用）：任务卡给了 assets 才渲染，不给就不渲染', () => {
  // 渲染层那一处**一个字都没改**——它是"逐字节重建旧日志"的落点：
  // 事件里有那一行（v34–v44 的轮次）就照原样渲染；运行期不给值（v45）就没有这一行。
  // 这条纯渲染断言把两态都钉住，免得以后有人"顺手"把渲染那一段也删了（那等于改写历史）。
  const base = buildRenderInput();
  const line = '本任务相关资产：Obscura（已在 PATH）——完整清单见 MEMORIES/assets.md';
  const oldLog = render({ ...base, taskCard: { title: '抓一篇正文', turn: 1, step: 1, todoOpen: [], assets: line } });
  const newLog = render({ ...base, taskCard: { title: '抓一篇正文', turn: 1, step: 1, todoOpen: [] } });
  assert.ok(nowLayerOfItems(oldLog.input).includes(line), '事件里有那一行 ⇒ 重建时照旧渲染（旧日志不失真）');
  assert.ok(!nowLayerOfItems(newLog.input).includes('本任务相关资产'),
    '运行期不给值 ⇒ 整行不出现（v45 的常态）');
});

// ──────────────── ② 解析：坏行如实降级，不编、不崩 ────────────────

test('②a 解析规则：只有名字、没有"在哪"的行**跳过**（不降级成一条）', () => {
  assert.deepEqual(
    parseAssetLine('- [path] Obscura ｜ 抓网页正文 ｜ 路径：D:\\obscura.exe'),
    { kind: 'path', name: 'Obscura', purpose: '抓网页正文', where: '路径：D:\\obscura.exe', from: 'her' },
  );
  assert.equal(parseAssetLine('- gh ｜ 命令行管 GitHub'), null, '缺"在哪"：跳过（不许让看起来有）');
  assert.equal(parseAssetLine('- [skill] 周报 ｜ 生成周报'), null, '同上（分类不影响这条判据）');
  assert.equal(parseAssetLine('- ｜ 没有名字 ｜ 已在 PATH'), null, '缺名字：跳过');
  assert.equal(parseAssetLine('这条自由文本不是条目'), null, '没有分隔符：跳过');
  assert.equal(parseAssetLine('# 数字资产'), null, '标题不是条目');
  assert.equal(parseAssetLine('- x ｜ y ｜ '), null, '"在哪"只有空白：跳过');

  const doc = parseAssets([
    '# 数字资产',
    '- goo ｜ 只有名字',
    '- [path] gh ｜ 管 GitHub ｜ 已在 PATH',
    '随手写的一句',
    '',
    '- [path] ffmpeg ｜ 转码 ｜ 未安装（需要 winget）',
  ].join('\n'));
  assert.equal(doc.entries.length, 2, '只认三段齐全的那两条');
  assert.equal(doc.skipped, 2, '坏行**如实计数**（另外两条没读懂）');
});

test('②b 三分类：不写分类按 path 算；认不出的分类标记不算分类', () => {
  assert.equal(parseAssetLine('- gh ｜ 管 GitHub ｜ 已在 PATH')!.kind, 'path', '缺省 path');
  assert.equal(
    parseAssetLine('- ［skill］ 周报 ｜ 生成周报 ｜ 说明：MEMORIES/skills/weekly.md')!.kind,
    'skill',
    '全角方括号也认',
  );
  assert.equal(parseAssetLine('- [MCP] github ｜ 查 issue ｜ 已配好')!.kind, 'mcp', '大小写不敏感');
  assert.equal(
    parseAssetLine('- [foo] bar ｜ 用途 ｜ 已在 PATH')!.name,
    '[foo] bar',
    '认不出的分类标记**不当分类**（留在名字里，不猜）',
  );
});

// ──────────────── ③ 事实层（框架聚合，别让她手抄） ────────────────

test('③a 事实层：skill 在不在、命令在不在 PATH——都如实说，绝不美化她写的"在哪"', () => {
  const entries = [
    { kind: 'skill' as const, name: 'weekly', purpose: '周报', where: 'MEMORIES/skills/weekly.md' },
    { kind: 'skill' as const, name: 'ghost', purpose: '早就删掉的技能', where: 'MEMORIES/skills/ghost.md' },
    { kind: 'mcp' as const, name: 'github', purpose: '查 issue', where: '配好的那个 server' },
    { kind: 'mcp' as const, name: 'nope', purpose: '没配过的 server', where: '某人说的那个 server' },
    { kind: 'path' as const, name: 'definitely-not-a-real-command-xyz', purpose: '不存在', where: '已在 PATH' },
    { kind: 'path' as const, name: 'ffmpeg', purpose: '转码', where: '未安装（需要 winget install ffmpeg）' },
  ];
  const facts: AssetFactSource = {
    skills: ['weekly', 'other'],
    mcp: [{ name: 'github', ready: true }],
    probePath: () => ({ found: false }),
  };
  const withF = withFacts(entries, facts);
  assert.equal(withF[0]!.fact?.state, 'ready', '技能目录里有 ⇒ 就绪');
  assert.equal(withF[1]!.fact?.state, 'missing', '技能目录里没有 ⇒ 如实说"没找到"（不是一直看着像有）');
  assert.equal(withF[2]!.fact?.state, 'ready', 'server 已声明并启动 ⇒ 就绪');
  assert.equal(withF[3]!.fact?.state, 'missing', '配置里没有这个 server ⇒ 未找到');
  assert.equal(withF[4]!.fact?.state, 'missing', 'PATH 里没有 ⇒ 未找到');
  assert.equal(withF[5]!.fact?.state, 'declared', '她自己写了"未安装"⇒ 照她写的算，**不去探测、不替她改口**');
  // 她写的"在哪"**一个字都没被改写**（事实层只做加法）
  assert.equal(withF[5]!.where, '未安装（需要 winget install ffmpeg）');
});

test('③a2 MCP：就绪不可知就如实说"未知"；读不到配置面**绝不写**"配置里没有"', () => {
  const herMcp = { kind: 'mcp' as const, name: 'github', purpose: '查 issue 与 PR', where: '配置里那个 server' };
  // ① 声明面读得到、运行期状态看不到（生产上就是这一支）⇒ "已配置（是否已启动未知）"
  assert.deepEqual(
    factOf(herMcp, { mcp: [{ name: 'github' }] }),
    { state: 'declared', detail: '已配置（是否已启动未知）' },
  );
  // ② 有真运行期状态就照它说（将来宿主把那半接进来时走这一支）
  assert.deepEqual(
    factOf(herMcp, { mcp: [{ name: 'github', ready: true }] }),
    { state: 'ready', detail: 'server 已启动' },
  );
  assert.deepEqual(
    factOf(herMcp, { mcp: [{ name: 'github', ready: false }] }),
    { state: 'declared', detail: '已配置（未启动）' },
  );
  // ③ 声明面**读得到**、里面没有她写的那个 ⇒ 这才是"确实没配"
  assert.deepEqual(
    factOf(herMcp, { mcp: [{ name: 'other' }] }),
    { state: 'missing', detail: '配置里没有这个 server' },
  );
  // ④ 声明面**读不到**（undefined）⇒ 只说"读不到配置面"，**绝不说**"配置里没有这个 server"
  const unknown = factOf(herMcp, NO_FACTS);
  assert.equal(unknown.state, 'unknown', 'unknown = "这一轮没核过"，与 declared（有话说）是两回事');
  assert.equal(unknown.detail, '这一轮读不到 MCP 配置面');
  assert.ok(!unknown.detail.includes('配置里没有'), '读不到 ≠ 确实没有：那一句会是假话');
  // ⑤ 她自己写着"未安装"时照旧优先（mcp 也一样：不探测、不改口）
  assert.equal(factOf({ ...herMcp, where: '未安装（需要先装它的 CLI）' }, { mcp: [] }).detail, '清单里写着未安装');
  // ⑥ "未知"分两种，别混：`declared` 是"有话说"（能用），`unknown` 是"这一轮压根没核过"
  assert.equal(isUsable({ ...herMcp, fact: factOf(herMcp, { mcp: [{ name: 'github' }] }) }), true,
    '"已配置（是否已启动未知）"是**能用**的那一侧');
  assert.equal(isUsable({ ...herMcp, fact: unknown }), true, '"没核过"也不等于"不能用"');
  assert.equal(isUsable({ ...herMcp, fact: { state: 'missing', detail: '配置里没有这个 server' } }), false,
    '核对过说"不在"才算用不了');
  assert.equal(isUsable({ ...herMcp, where: '未安装（需要先装它的 CLI）' }), false, '她自己写着未安装也算用不了');
});

test('③a3 MCP：配置里声明的 server 由框架自己列出来（她不必手抄）', () => {
  const facts: AssetFactSource = { mcp: [{ name: 'github' }, { name: 'playwright' }] };
  const index = indexOf([], facts);
  assert.deepEqual(index.map(entry => `${entry.kind}:${entry.name}`), ['mcp:github', 'mcp:playwright']);
  assert.equal(index[0]!.fact?.detail, '已配置（是否已启动未知）', '事实条目本身也如实说"未知"');
});

test('③b 事实层：她没抄过的技能与 MCP server 也会被列出来（框架自己列）', () => {
  const hers = [{ kind: 'path' as const, name: 'gh', purpose: '管 GitHub', where: '已在 PATH' }];
  const facts: AssetFactSource = {
    skills: ['weekly', 'dsh-docs'],
    mcp: [{ name: 'github', ready: false }],
    probePath: () => ({ found: true, path: 'C:\\bin\\gh.exe' }),
  };
  const index = indexOf(hers, facts);
  assert.deepEqual(
    index.map(entry => `${entry.kind}:${entry.name}`),
    ['path:gh', 'skill:weekly', 'skill:dsh-docs', 'mcp:github'],
    '她那一层在前，事实层补她没提过的',
  );
  assert.equal(index[0]!.fact?.state, 'ready', 'PATH 探测到了就绪');
  // 她写过同名的就不再重复列（她的那一层优先）
  const dedup = indexOf(
    [...hers, { kind: 'path' as const, name: 'GH', purpose: '重复写了一遍', where: '已在 PATH' }],
    { probePath: () => ({ found: true, path: 'C:\\bin\\gh.exe' }) },
  );
  assert.equal(dedup.filter(entry => entry.kind === 'path').length, 2, '两条都是她写的，事实层不再补');
});

test('③c 没核对手段时说"这一轮没核过"（unknown），不假装核对过、也不写"未找到"', () => {
  const asset = { kind: 'path' as const, name: 'gh', purpose: '管 GitHub', where: '已在 PATH' };
  const noProbe = factOf(asset, NO_FACTS);
  assert.equal(noProbe.state, 'unknown', '没探测手段 ⇒ unknown（不是 declared，更不是 ready/missing）');
  assert.equal(noProbe.detail, '这一轮没有探测 PATH');
  assert.ok(!noProbe.detail.includes('未找到'), '没核过就绝不写"未找到"（那是编）');
  assert.equal(isUsable({ ...asset, fact: noProbe }), true, '没核过 ≠ 不能用');
  assert.equal(factOf(asset, { probePath: () => ({ found: true, path: 'C:\\gh.exe' }) }).state, 'ready');
  assert.equal(commandOf(asset), 'gh', '「已在 PATH」⇒ 拿名字去探');
  assert.equal(commandOf({ ...asset, where: '路径：D:\\bin\\gh.exe' }), 'D:\\bin\\gh.exe');
  assert.equal(commandOf({ ...asset, where: '某人给的压缩包' }), null, '取不出命令 ⇒ 不探测（不猜）');
});

test('③d probeOnPath：真的查 PATH（用一份自造的 PATH 与目录证明它认得出/认不出）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-path-probe-'));
  try {
    writeFileSync(join(dir, 'gh.exe'), 'x', 'utf8');
    const env = { PATH: dir, PATHEXT: '.EXE;.CMD' };
    const hit = probeOnPath('gh', env);
    assert.equal(hit.found, true);
    // 大小写不比：Windows 上 `gh.EXE` 与 `gh.exe` 是同一个文件（探测结论按真实目录项给）
    assert.equal((hit.path ?? '').toLowerCase(), join(dir, 'gh.exe').toLowerCase());
    assert.equal(probeOnPath('nope-nope', env).found, false);
    // 直接给绝对路径也认（她写了 `路径：…` 的那种）——**带反斜杠的 Windows 路径也要认**
    assert.equal(probeOnPath(join(dir, 'gh.exe'), env).found, true);
    assert.equal(probeOnPath(join(dir, 'missing.exe'), env).found, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('③e 端到端：技能目录里没有的那条技能，事实层如实说"技能目录里没有它"', async (t) => {
  // 真的建一个技能目录（技能根下一个带 SKILL.md 的子目录 = 一个技能），让"事实层"有东西可核：
  // "她清单里那条技能还在不在"因此是**真查出来的**，不是用例编的。
  const { SkillManager } = await import('../src/skill/skills.ts');
  const rig = await makeRealWakeRig({
    stream: [{ text: '', toolCalls: [] }],
    probeAssetPath: PROBE,
    skills: (baseRoot) => new SkillManager({ baseRoot, out: () => undefined }),
  });
  t.after(rig.dispose);
  mkdirSync(join(rig.dir, 'skills', 'alpha'), { recursive: true });
  writeFileSync(join(rig.dir, 'skills', 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: 真在目录里的那个技能\n---\n\n正文\n', 'utf8');
  writeAssets(rig, [
    '# 数字资产',
    '- [skill] alpha ｜ 真在目录里的那个技能 ｜ skills/alpha/SKILL.md',
    '- [skill] ghost-skill ｜ 早就删掉的技能 ｜ MEMORIES/skills/ghost.md',
  ].join('\n'));

  rig.append('wake/manual', { note: '拿那个技能做点事' });
  await rig.tick();

  // 技能目录这一半是**真**的（SkillManager 扫盘），所以这条断言不是自说自话
  const doc = readAssets(join(rig.dir, 'data'))!;
  const facts: AssetFactSource = {
    skills: ['alpha'],
    probePath: PROBE,
  };
  const checked = withFacts(doc.entries, facts);
  assert.equal(checked[0]!.fact?.state, 'ready', '目录里在的那个 ⇒ 就绪');
  assert.equal(checked[1]!.fact?.state, 'missing', '早就删掉的那个 ⇒ 如实说"没找到"');
  // 这一拍照旧只有 heavy（事实层还在，但没有任何"挑"的动作）
  assert.deepEqual(rig.requests.map(item => item.lane), ['heavy']);
});

// ──────────────── ④ 常驻规则、种子、（不常驻） ────────────────

test('④a 常驻规则只有一句：用资产先读说明、不许凭名字猜；而且**不再有**那句假承诺', () => {
  assert.ok(SELF_BRIEF.includes('先读它的说明再用'), '规则在装置自述里（常驻、短、稳定）');
  assert.ok(SELF_BRIEF.includes('不许凭名字猜怎么调'));
  assert.ok(SELF_BRIEF.includes('skill、MCP、PATH 里的命令，都算你的数字资产'), '一个概念三个分类要说清');
  assert.ok(SELF_BRIEF.includes('有哪些、在哪、就绪没有由框架给你'), '事实层不要求她手抄');
  assert.ok(SELF_BRIEF.includes('`MEMORIES/assets.md`'), '清单在哪要说清（她自己去看的那份）');

  // **v45 的核心断言**：那句假承诺必须消失，且换成与新行为一致的说法
  // （原来是"你在被叫去干活的时候，我会从这份清单里挑可能用得上的几条（最多三条）放在你的任务旁边"）。
  assert.ok(!SELF_BRIEF.includes('放在你的任务旁边'),
    '不再许诺"框架会挑几条放在任务旁边"——机制取消了，那是假承诺（评审点名过）');
  assert.ok(!SELF_BRIEF.includes('我会从这份清单里挑'), '同上：不许留半句');
  assert.ok(SELF_BRIEF.includes('这份清单**不进你的上下文**，也没有谁替你挑'),
    '新说法要写明：不进上下文、也没人替她挑');
  assert.ok(SELF_BRIEF.includes('做一件事之前，先照它看一眼手上有什么、再去读那条自己的说明'),
    '给她一条她自己能走的路（线索就在这里，不另加指路行）');
});

test('④b 清单不常驻：她的清单内容一个字都不进上下文', async (t) => {
  const rig = await makeRealWakeRig({ stream: [{ text: '', toolCalls: [] }], probeAssetPath: PROBE });
  t.after(rig.dispose);
  writeAssets(rig, THREE_ASSETS);

  rig.append('wake/manual', { note: '只看第一件事' });
  await rig.tick();

  const request = rig.requests.find(item => item.lane === 'heavy')!.request;
  const all = JSON.stringify(request.input);
  assert.ok(!all.includes('Obscura'), '清单里的条目不在她的上下文里（v45 之后更没有那一行提示）');
  assert.ok(!all.includes('gh ｜'), '清单的原始行也不在');
  const instructions = typeof request.instructions === 'string' ? request.instructions : '';
  assert.ok(!instructions.includes('Obscura'), '装置自述里也没有清单内容（常驻的只有那一句规则）');
});

test('④c 种子：只在文件不存在时写一次（幂等）；它是说明，不是条目；**不再许诺那一行**', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-assets-seed-'));
  try {
    mkdirSync(memoriesDir(dir), { recursive: true });
    assert.equal(ensureAssetsSeed(dir), true, '第一次：写');
    const first = readAssets(dir);
    assert.ok(first !== null && first.entries.length === 0, '种子是**说明 + 围栏里的格式示例**，一条真资产都没预置');
    assert.equal(first?.skipped, 0, '说明与示例都不算坏行（不然她一打开就看到"另有 7 行没读懂"）');
    // 种子是写给她的说明：那句"你会收到一行挑好的"必须跟着机制一起消失（否则又是假承诺）
    const seed = readSeedText(dir);
    assert.ok(!seed.includes('会收到一行「本任务相关资产」'), '种子里不再许诺那一行');
    assert.ok(seed.includes('也没有谁会替你挑几条递过来'), '改成与新行为一致的说法');
    writeFileSync(assetsFile(dir), '# 数字资产\n\n- [path] gh ｜ 管 GitHub ｜ 已在 PATH\n', 'utf8');
    assert.equal(ensureAssetsSeed(dir), false, '第二次：文件已在，一个字节都不动');
    assert.equal(readAssets(dir)!.entries.length, 1, '她自己写的内容没被种子覆盖');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 读种子原文（不经过解析：这一条要查的是**字节**，不是条目） */
function readSeedText(dir: string): string {
  return readFileSync(assetsFile(dir), 'utf8');
}

// ──────────────── ⑤ 那一套"一行、一句话"的截断口径（历史资产，仍然钉着） ────────────────

/*
 * v39（2026-10-07）定的是"说明那一格怎么截才不把她写的路切坏"。v45 取消那条机制之后，
 * 这一套**没有生产调用点**了（见 `assets.ts` 那段注释），但它**没被删**：口径与判据留在这里，
 * 将来真有人重开一条"给她递点什么"的路，照它来（别在别处另写一套）。
 */
test('⑤a 长说明（>60 字符）⇒ 截断（缀省略号），多字节字符不切坏', () => {
  const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十超出部分还在继续写下去';
  assert.ok([...long].length > ASSET_NOTE_CHARS_MAX, `用例前提：这段说明 ${[...long].length} 字符，要超过上限`);
  const clipped = clipAssetNote(long);
  assert.ok([...clipped].length <= ASSET_NOTE_CHARS_MAX, `要收进 ${ASSET_NOTE_CHARS_MAX} 字符（实际 ${[...clipped].length}）`);
  assert.ok(clipped.includes('…'), `超出就该缀省略号（实际：${clipped}）`);
  const source = new Set([...long]);
  for (const char of clipped) {
    if (char === '…') continue;
    assert.ok(source.has(char), `截断切坏了一个多字节字符：${char}`);
  }
});

test('⑤b 畸形（多行 / 含反引号命令 / 括号不闭合）⇒ 只取第一句，并如实', () => {
  const nl = `第一句。\n第二句还有别的话要讲清楚一点\n第三句更多的话堆在这儿不下心就整段进来了`;
  assert.equal(clipAssetNote(nl), '第一句。', '多行只取第一行、只取第一句');

  const cmd = '要跑这个：`pwsh -NoProfile -File "D:\\a\\b\\anysearch_cli.ps1" search "查询" --max_results 8` 就行，别另外装东西浪费时间';
  const cmdNote = clipAssetNote(cmd);
  assert.ok(cmdNote.includes('要跑这个：'), `切点别落在冒号上（切出来是个没宾语的残句，实际：${cmdNote}）`);
  assert.ok(cmdNote.endsWith('…'), `末尾那半句用省略号如实收住（实际：${cmdNote}）`);
  assert.ok(!cmdNote.includes('别另外装东西'), `命令后面那些细节不进这一格（实际：${cmdNote}）`);

  // anysearch 那条的真实形状：`说明：<路径>（…` 括号**不闭合**，后头还接着一段话
  const unbalanced = '说明：skills/bad/SKILL.md（正文同目录 scripts/x.py；**草稿，尚未过信任门进 catalog**，见 facts）';
  assert.equal(clipAssetNote(unbalanced), 'skills/bad/SKILL.md', '只留指路那一截');
});

test('⑤c 确定性：同一输入两次截断**逐字节相同**（重放要能逐字节重建）', () => {
  const text = '说明：MEMORIES/skills/a/SKILL.md（正文同目录 scripts/a.py；**草稿**，见 facts）';
  assert.equal(clipAssetNote(text), clipAssetNote(text), '截断是纯函数：禁时钟、禁随机、禁环境值');
});

// ──────────────── 装配：纯渲染的最小输入 ────────────────

/** 纯渲染用例的最小 RenderInput（不读盘、不看时钟：render 本来就是纯函数） */
function buildRenderInput(): RenderInput {
  const persona: RenderPersona = {
    identity: 'IDENTITY', constitution: 'CONSTITUTION', style: 'STYLE', state: 'STATE',
  };
  return {
    events: [],
    persona,
    tools: [],
    wakeEvent: null,
    taskCard: null,
    now: NOW,
    timezone: 'Asia/Shanghai',
    model: 'fake-heavy',
    lane: 'heavy',
  };
}
