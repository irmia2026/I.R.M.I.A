/**
 * **技能**的申请单：她发起装/删，用户只在界面点批准或驳回（2026-10-11 第二笔）
 *
 * 与 MCP 那条线**同一套形状**（见 `test/mcp-grant.test.ts` 与 `grant/mcp-grant.ts` 的文件头），
 * 这一份钉的是技能那一支**特有**的四件事：
 *   ① **`scripts/` 是风险点**：装技能 = 引入可执行内容（本机 `skills/anysearch/scripts/`
 *      里真有一批脚本）⇒ 申请单里那几个名字要进事件、要进卡面（方案稿 D8）；
 *   ② **删走回收站**：整目录 rename 进 `<dataDir>/trash/`，内容一个字节不改、可逆；
 *   ③ **落装之后写 `skill/installed{by:'human'}`** 才算过信任门（不写 = 装了但她看不见）；
 *   ④ **随包文件的路径**不许写到技能目录外面去（上跳 / 绝对路径 / 反斜杠 / 覆盖 SKILL.md）。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import {
  GRANT_WAKE_CARD_SENTENCE, applyGrant, grantPathOf, grantReceiptLine, grantWakeNoteOf, grantsDirOf,
  parseGrantRequest, wakeForGrant,
} from '../src/grant/mcp-grant.ts';
import { skillGrantWakeNoteOf } from '../src/grant/skill-grant.ts';
import { CATALOG_HEADER, DEFAULT_SKILL_ROOTS, SKILL_FILE_NAME, SkillManager } from '../src/skill/skills.ts';
import { sha256Hex } from '../src/tools/fs/text-codec.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';
import { RIG_NOW, makeRealWakeRig } from './fixtures/real-wake-rig.ts';
import type { AppEvent } from '../src/log/types.ts';

/** 一份合法的 `skill-install` 单子（各用例按需覆盖几格） */
function installFile(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'skill-install',
    name: 'morning-review',
    description: '每天早上翻一遍昨天的进展，落一份摘要',
    body: '# 早上复盘\n\n1. 读昨天的日记\n2. 写一份摘要\n',
    files: [],
    reason: '想每天固定做一次',
    ...extra,
  };
}

function writeGrantFile(workspace: string, id: string, data: unknown): string {
  const dir = grantsDirOf(join(workspace, 'data'));
  mkdirSync(dir, { recursive: true });
  const path = grantPathOf(join(workspace, 'data'), id);
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
  return path;
}

async function eventsOf(rig: Awaited<ReturnType<typeof makeRealWakeRig>>): Promise<AppEvent[]> {
  return [...(await rig.events())];
}

// ──────────────────────────────── ① 校验那一层 ────────────────────────────────

test('① 技能单子：description 是唯一触发机制 ⇒ 空的不收；名字走技能系统那把尺子', () => {
  const ok = parseGrantRequest(installFile());
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.request.kind, 'skill-install');

  const noDesc = parseGrantRequest(installFile({ description: '' }));
  assert.equal(noDesc.ok, false);
  assert.match(noDesc.ok === false ? noDesc.detail : '', /唯一的触发机制/u);

  // 名字：大写 / 下划线 / 路径分隔符 / 上跳 —— 全部由 `skillNameProblem` 判（不在这里重写）
  for (const bad of ['Morning-Review', 'morning_review', '../evil', 'a/b', 'C:\\x']) {
    const parsed = parseGrantRequest(installFile({ name: bad }));
    assert.equal(parsed.ok, false, `名字「${bad}」该被拒`);
  }
  // **技能名与 MCP 服务名不是同一把尺子**（技能只允许小写 + 连字符）：拿 MCP 那套来会放行大写
  const mcpName = parseGrantRequest(installFile({ name: 'Obscura_1' }));
  assert.equal(mcpName.ok, false);
});

test('①b scripts/ 单列一行：脚本名进摘要（卡面与事件都看得到那件事）', () => {
  const parsed = parseGrantRequest(installFile({
    files: [
      { path: 'scripts/run.js', content: 'console.log(1)\n' },
      { path: 'scripts/clean.py', content: 'print(1)\n' },
      { path: 'references/notes.md', content: '# 笔记\n' },
    ],
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.request.files.length, 3);
});

test('①c 随包文件的路径不许写到技能目录外面去', () => {
  for (const bad of ['../outside.js', '/etc/passwd', 'C:\\x.js', 'scripts\\run.js', 'a//b.js', './x.js']) {
    const parsed = parseGrantRequest(installFile({ files: [{ path: bad, content: 'x' }] }));
    assert.equal(parsed.ok, false, `路径「${bad}」该被拒`);
  }
  // `SKILL.md` 不许从 files 里塞（正文有它自己那一格，从这里进会绕过长度校验）
  const overwrite = parseGrantRequest(installFile({ files: [{ path: SKILL_FILE_NAME, content: 'x' }] }));
  assert.equal(overwrite.ok, false);
  assert.match(overwrite.ok === false ? overwrite.detail : '', /正文有它自己那一格/u);
});

test('①d 正文与文件数都有硬顶（技能是说明 + 少量脚本，不是数据包）', () => {
  const tooLong = parseGrantRequest(installFile({ body: 'x'.repeat(40_001) }));
  assert.equal(tooLong.ok, false);
  const tooMany = parseGrantRequest(installFile({
    files: Array.from({ length: 33 }, (_, i) => ({ path: `f${i}.md`, content: 'x' })),
  }));
  assert.equal(tooMany.ok, false);
});

// ──────────────────────────────── ② 待批 ────────────────────────────────

test('② 技能单子照样变成一条待批：问题、卡面、脚本名单都在**同一个信箱**里', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  writeGrantFile(rig.dir, 's-1', installFile({
    files: [{ path: 'scripts/run.js', content: 'console.log(1)\n' }],
  }));

  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();

  const events = await eventsOf(rig);
  const asked = events.filter((event) => event.type === 'human/asked');
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.data.source, 'system', '待批走挂起语义（与 MCP 那条同一条）');
  assert.match(asked[0]!.data.question, /批准装一个技能「morning-review」/u);
  // 卡面上"它会做什么"与**脚本那一行**都要在（用户点名的风险点）
  assert.match(asked[0]!.data.context, /它会做什么：每天早上翻一遍昨天的进展/u);
  assert.match(asked[0]!.data.context, /风险点：.*可执行脚本.*scripts\/run\.js/u, 'scripts/ 必须单列一行');
  assert.match(asked[0]!.data.context, /skill\/installed/u, '卡面要说清落地之后会写信任门那条凭据');

  const requested = events.filter((event) => event.type === 'grant/requested');
  assert.equal(requested.length, 1);
  assert.equal(requested[0]!.data.kind, 'skill-install');
  assert.deepEqual(requested[0]!.data.skillScriptNames, ['scripts/run.js'], '脚本名单进事件（界面据此单列）');
  assert.equal(requested[0]!.data.skillFileCount, 1);
  // 正文**不进事件**（可能几十 KB）：事件里只有字节数
  assert.equal(typeof requested[0]!.data.skillBodyBytes, 'number');
  assert.ok(!JSON.stringify(requested[0]!.data).includes('读昨天的日记'), '正文不该出现在事件里');
});

// ──────────────────────────────── ③ 落地 ────────────────────────────────

test('③ 批准装：目录 + SKILL.md + 随包文件都写出来，且**扫描器认它**（信任门之外那一半）', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  writeGrantFile(rig.dir, 's-1', installFile({
    files: [
      { path: 'scripts/run.js', content: 'console.log("hi")\n' },
      { path: 'references/notes.md', content: '# 笔记\n' },
    ],
  }));
  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();
  const requested = (await eventsOf(rig)).find((event) => event.type === 'grant/requested')!;

  const applied = await applyGrant({
    dataDir: join(rig.dir, 'data'),
    configPath: join(rig.dir, 'config.json'),
    id: 's-1',
    requestedHash: requested.data.contentHash,
    skillsRoot: rig.dir,
  });
  assert.equal(applied.state, 'ok');
  assert.equal(applied.landed, 'morning-review');

  const dir = join(rig.dir, 'skills', 'morning-review');
  const text = readFileSync(join(dir, SKILL_FILE_NAME), 'utf8');
  assert.match(text, /^---\nname: morning-review\ndescription: 每天早上翻一遍昨天的进展，落一份摘要\n---\n/u);
  assert.match(text, /读昨天的日记/u, '正文原样写进去');
  assert.equal(readFileSync(join(dir, 'scripts', 'run.js'), 'utf8'), 'console.log("hi")\n');
  assert.equal(readFileSync(join(dir, 'references', 'notes.md'), 'utf8'), '# 笔记\n');

  // 扫描器认它 = 这个技能真的存在（信任门那一关是另一条事件的事，见下一条）
  const scanned = new SkillManager({ baseRoot: rig.dir }).scan().candidates;
  assert.ok(scanned.some((candidate) => candidate.name === 'morning-review'), '扫描器要认得它');
});

test('③b 已存在同名目录 ⇒ **不覆盖**（那可能是人写了很久的东西）', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  mkdirSync(join(rig.dir, 'skills', 'morning-review'), { recursive: true });
  writeFileSync(join(rig.dir, 'skills', 'morning-review', SKILL_FILE_NAME), '人写的原件\n', 'utf8');
  writeGrantFile(rig.dir, 's-1', installFile());
  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();
  const requested = (await eventsOf(rig)).find((event) => event.type === 'grant/requested')!;

  const applied = await applyGrant({
    dataDir: join(rig.dir, 'data'), configPath: join(rig.dir, 'config.json'),
    id: 's-1', requestedHash: requested.data.contentHash, skillsRoot: rig.dir,
  });
  assert.equal(applied.state, 'skipped-invalid');
  assert.match(applied.failure ?? '', /已经存在/u);
  assert.equal(
    readFileSync(join(rig.dir, 'skills', 'morning-review', SKILL_FILE_NAME), 'utf8'),
    '人写的原件\n',
    '原件一个字节都不许动',
  );
});

test('③c 删除：整目录进回收站（可逆），内容一个字节不改', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  const dir = join(rig.dir, 'skills', 'old-skill');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SKILL_FILE_NAME), '---\nname: old-skill\ndescription: 旧的\n---\n\n正文\n', 'utf8');

  writeGrantFile(rig.dir, 's-2', { kind: 'skill-remove', name: 'old-skill', reason: '不用了' });
  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();
  const events = await eventsOf(rig);
  const requested = events.find((event) => event.type === 'grant/requested')!;
  assert.equal(requested.data.kind, 'skill-remove');
  assert.match(events.find((event) => event.type === 'human/asked')!.data.question, /批准删掉技能「old-skill」/u);

  const applied = await applyGrant({
    dataDir: join(rig.dir, 'data'), configPath: join(rig.dir, 'config.json'),
    id: 's-2', requestedHash: requested.data.contentHash,
    skillsRoot: rig.dir, now: () => new Date('2026-10-11T02:30:45.123Z'),
  });
  assert.equal(applied.state, 'ok');
  assert.equal(existsSync(dir), false, '原目录必须已经不在了');
  assert.ok(applied.landed !== undefined && existsSync(applied.landed), '搬进回收站的那一份要在');
  assert.match(applied.landed!, /trash/u);
  // 内容一个字节不改（可逆的那条承诺）
  assert.match(readFileSync(join(applied.landed!, SKILL_FILE_NAME), 'utf8'), /^---\nname: old-skill/u);
});

test('③d 要删的技能不在 ⇒ 拒执行（"有人先删过"与"本来就没有"都如实说）', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  writeGrantFile(rig.dir, 's-3', { kind: 'skill-remove', name: 'never-existed' });
  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();
  const requested = (await eventsOf(rig)).find((event) => event.type === 'grant/requested')!;

  const applied = await applyGrant({
    dataDir: join(rig.dir, 'data'), configPath: join(rig.dir, 'config.json'),
    id: 's-3', requestedHash: requested.data.contentHash, skillsRoot: rig.dir,
  });
  assert.equal(applied.state, 'skipped-invalid');
  assert.match(applied.failure ?? '', /没有叫 never-existed 的目录/u);
});

test('③e 单子在审阅期间被改过（指纹对不上）⇒ 拒执行，一个文件都不动', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  writeGrantFile(rig.dir, 's-4', installFile());
  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();
  const requested = (await eventsOf(rig)).find((event) => event.type === 'grant/requested')!;

  // 她把 description 改了（要落地的那份字节因此变了）
  writeGrantFile(rig.dir, 's-4', installFile({ description: '换成另一句话' }));

  const applied = await applyGrant({
    dataDir: join(rig.dir, 'data'), configPath: join(rig.dir, 'config.json'),
    id: 's-4', requestedHash: requested.data.contentHash, skillsRoot: rig.dir,
  });
  assert.equal(applied.state, 'skipped-stale');
  assert.equal(existsSync(join(rig.dir, 'skills', 'morning-review')), false, '拒执行 = 一个文件都不建');
});

// ──────────────────── ④ 通知与回执：**与 MCP 那一条同一处代码路径** ────────────────────

/** 台子上那条 `wake/manual{via:'grant'}`（没有时失败——否则下面的断言会静默测空气） */
function grantWakeOf(events: readonly AppEvent[]): { note: string; via: string; dedupeKey: string } {
  const found = events.filter(
    (event) => event.type === 'wake/manual' && (event.data as { via?: unknown }).via === 'grant',
  );
  assert.equal(found.length, 1, '一次决定恰好一条 via=grant 的唤醒');
  return found[0]!.data as { note: string; via: string; dedupeKey: string };
}

test('④a 批准装：通知走的是**与 MCP 同一条**路（wake/manual · via=grant），措辞是技能那一支', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  writeGrantFile(rig.dir, 's-1', installFile({
    files: [{ path: 'scripts/run.js', content: 'console.log(1)\n' }],
  }));
  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();
  const requested = (await eventsOf(rig)).find((event) => event.type === 'grant/requested')!;

  const exec = await applyGrant({
    dataDir: join(rig.dir, 'data'), configPath: join(rig.dir, 'config.json'),
    id: 's-1', requestedHash: requested.data.contentHash, skillsRoot: rig.dir,
  });
  assert.equal(exec.state, 'ok');

  // **与 `grant-decide` 端点逐字同一个调用**（那条路也是 wakeForGrant → appendSync wake/manual model）
  const facts = {
    id: 's-1',
    kind: 'skill-install' as const,
    name: 'morning-review',
    outcome: 'approved' as const,
    reason: null,
    exec,
    scriptCount: requested.data.skillScriptNames?.length ?? 0,
  };
  const seq = wakeForGrant({
    facts,
    nowMs: Date.parse('2026-10-11T03:00:00.000Z'),
    append: (data) => rig.append('wake/manual', data).seq,
    onError: (message) => assert.fail(`唤醒不该发不出去：${message}`),
  });
  assert.equal(typeof seq, 'number', '她必须真的被叫醒一次（不许只在日志里留一行）');

  const wake = grantWakeOf(await eventsOf(rig));
  assert.equal(wake.via, 'grant', '与 MCP 批准同一条 via（界面据此渲染成框架卡片）');
  assert.match(wake.dedupeKey, /^grant-/u, '幂等键与 MCP 那条同一种形状（决定的身份 + 5 秒时间片）');
  // 技能那一支的措辞：说清落地在哪、信任门、**索引什么时候变**、脚本有没有被跑
  assert.match(wake.note, /装一个技能「morning-review」/u);
  assert.match(wake.note, /已被批准并且执行成功/u);
  assert.match(wake.note, /skill\/installed/u, '信任门那条凭据要说清（不写它等于装了但看不见）');
  assert.match(wake.note, /下一次归集/u, '索引什么时候变要与 MCP 同一口径（缓存保护）');
  assert.match(wake.note, /没有执行/u, '它带脚本 ⇒ 必须说清框架一个都没跑（用户点名的安全项）');
  assert.equal(wake.note.includes('MCP server'), false, '技能那一支不许说成 MCP server（同一入口、不同措辞）');
  // 回执那一行（HTTP 应答里那一格）是同一件事的一行版
  const receipt = grantReceiptLine(facts);
  assert.match(receipt, /装进技能根/u);
  assert.match(receipt, /信任门/u);

  // ── 同一处代码路径的**正面证据**：MCP 那一支喂同一个 `wakeForGrant`，产出同形状的 via/键 ──
  const mcpSeq = wakeForGrant({
    facts: {
      id: 'g-1', kind: 'mcp-add', name: 'obscura', outcome: 'approved',
      reason: null, exec: { state: 'ok', landed: 'obscura' },
    },
    nowMs: Date.parse('2026-10-11T03:00:00.000Z'),
    append: (data) => rig.append('wake/manual', data).seq,
    onError: (message) => assert.fail(`唤醒不该发不出去：${message}`),
  });
  assert.equal(typeof mcpSeq, 'number');
  const events = await eventsOf(rig);
  const grantWakes = events.filter(
    (event) => event.type === 'wake/manual' && (event.data as { via?: unknown }).via === 'grant',
  );
  assert.equal(grantWakes.length, 2, '两条决定各一条唤醒（via 都是 grant：同一处代码路径）');
  assert.match((grantWakes[1]!.data as { note: string }).note, /加 MCP server「obscura」/u);
  // 三态都有话说：驳回 / 成功 / 失败
  const failed = grantWakeNoteOf({ ...facts, exec: { state: 'failed', failure: '写技能目录失败：EACCES' } });
  assert.match(failed, /已被批准，但执行没有成功/u);
  assert.match(failed, /EACCES/u);
});

test('④b 驳回：有回执且**不装**（那句话是人的决定，不是"没人理"）', async (t) => {
  const rig = await makeRealWakeRig();
  t.after(rig.dispose);
  writeGrantFile(rig.dir, 's-5', installFile());
  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();

  const facts = {
    id: 's-5', kind: 'skill-install' as const, name: 'morning-review',
    outcome: 'rejected' as const, reason: '不想让它常驻', exec: { state: 'not-applicable' as const },
  };
  const seq = wakeForGrant({
    facts,
    nowMs: Date.parse('2026-10-11T03:05:00.000Z'),
    append: (data) => rig.append('wake/manual', data).seq,
    onError: (message) => assert.fail(`唤醒不该发不出去：${message}`),
  });
  assert.equal(typeof seq, 'number');
  const wake = grantWakeOf(await eventsOf(rig));
  assert.match(wake.note, /装一个技能「morning-review」.*被驳回了/u);
  assert.match(wake.note, /他写的理由是：「不想让它常驻」/u);
  assert.match(wake.note, /这是驳回/u, '要说清"别再自己做"（与 MCP 那一支逐字同款的那句；用词与回执同一份）');
  assert.match(grantReceiptLine(facts), /人驳回了这张申请单，理由是：不想让它常驻/u);
  // 驳回 = 一个文件都不建（"有回执"与"真没装"两半都要在）
  assert.equal(existsSync(join(rig.dir, 'skills', 'morning-review')), false);
});

test('④c 她申请 ⇒ 落"待批准"；批准之前，她读到的技能索引里没有它', async (t) => {
  const rig = await makeRealWakeRig({
    skills: (baseRoot) => new SkillManager({ baseRoot, out: () => undefined }),
  });
  t.after(rig.dispose);
  // 先有一个过了信任门的技能（索引里那一行），再让她申请装一个新的
  const alphaDir = join(rig.dir, 'skills', 'alpha-search');
  mkdirSync(alphaDir, { recursive: true });
  const alphaText = '---\nname: alpha-search\ndescription: 先有的那个技能：搜网页与站内内容，查资料时用。\n---\n\n正文。\n';
  writeFileSync(join(alphaDir, SKILL_FILE_NAME), alphaText, 'utf8');
  rig.append('skill/installed', {
    name: 'alpha-search', path: 'skills/alpha-search', by: 'human', contentHash: sha256Hex(alphaText),
  });
  writeGrantFile(rig.dir, 's-6', installFile());

  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();

  const events = await eventsOf(rig);
  // ① 待批的记录在（她递的单子被框架拾起来了），并且**只有**待批这一半
  const requested = events.find((event) => event.type === 'grant/requested')!;
  assert.equal(requested.data.kind, 'skill-install');
  assert.equal(requested.data.by, 'agent');
  assert.ok(events.some((event) => event.type === 'human/asked'), '用户界面上那张卡在');
  assert.equal(events.some((event) => event.type === 'grant/resolved'), false, '还没批 ⇒ 没有结局');
  // ② 批准之前，她那一眼（长期记忆层里的技能索引）里没有它。
  //    只看**索引那一段**：待批那条提问本身会作为「她在等一个人点头」进她的上下文
  //    （`human/asked` 是 model 可见），所以"名字出现在整份 input 里"是正常的——
  //    判据是"索引里没有它"，不是"她不知道自己在等什么"。
  const request = rig.requests[0]!.request;
  const first = (request.input as Array<{ role?: string; content?: unknown }>)[0]!;
  const layer = typeof first.content === 'string' ? first.content : '';
  const at = layer.indexOf(CATALOG_HEADER);
  const segment = at < 0 ? '' : (layer.slice(at).split('\n\n')[0] ?? '');
  assert.match(segment, /- alpha-search: /u, '已生效的那个技能要在索引里（否则这条断言是空的）');
  assert.equal(segment.includes('morning-review'), false, '批准之前她读到的技能索引里没有它');
  // ③ 盘上也没有（"待批准 ≠ 装上了"）
  assert.equal(existsSync(join(rig.dir, 'skills', 'morning-review')), false);
  // ④ 快照里同样没有（索引的字节由快照决定，两处一起说清）
  const snapshot = events.find((event) => event.type === 'skill/index');
  assert.ok(snapshot !== undefined);
  assert.equal((snapshot.data as { text: string }).text.includes('morning-review'), false);
});

// ───── ④d 唤醒正文末尾那句"卡在哪、怎么处理"：技能两支四种状态都有（用户 2026-10-21） ─────
//
// 与 `test/mcp-grant.test.ts` 的 ⑤ 同一把尺子：那一句的**唯一实现**是 `mcp-grant.ts` 的
// `GRANT_WAKE_CARD_SENTENCE`，技能这一支只是把它拼在末尾（自己再写一句就会说成
// "通知卡""审批弹窗"之类人界面上找不到的东西）。这里补的是**技能两支四种状态**：
// 装成功 / 删成功 / 驳回 / 批准但没落地——四个 return 各拼一次，漏一个就是"有一支不知道自己弹了卡"。

/** 那一句"卡在哪"的全部判据（与 `test/mcp-grant.test.ts` ⑤a 同一组，两支共用） */
function assertCardSentenceOnce(note: string, label: string): void {
  assert.ok(note.includes('扩展页'), `${label}：要说清卡在扩展页`);
  assert.ok(note.includes('快速审批卡'), `${label}：要说出右下角那张快速审批卡`);
  assert.ok(note.includes('待批'), `${label}："待批"要与界面同一份用词`);
  // ① **只加一句**：那一句整体只出现一次（就是那一个常量）
  assert.equal(note.split(GRANT_WAKE_CARD_SENTENCE).length, 2, `${label}：只加一句，且是同一个实现`);
  assert.ok(note.endsWith(GRANT_WAKE_CARD_SENTENCE), `${label}：加在正文末尾，不打断原来的说明`);
  // ② 原来的正文里**不许重复**这几个词（重复 = 多写了一段）
  const body = note.slice(0, note.length - GRANT_WAKE_CARD_SENTENCE.length);
  for (const word of ['扩展页', '快速审批卡', '待批']) {
    assert.equal(body.includes(word), false, `${label}：原来的正文里不该重复「${word}」`);
  }
  // ③ **不加第二段**：仍是单行，且整条正文只多一个句号
  assert.equal(note.includes('\n'), false, `${label}：一句，不是第二段`);
  assert.equal(
    (note.match(/。/gu) ?? []).length, (body.match(/。/gu) ?? []).length + 1,
    `${label}：整条正文只多一个句号`,
  );
}

test('④d 技能四种状态的正文都带那句"卡在哪"，且只加一句（与 MCP 同一句实现）', () => {
  const installFacts = {
    id: 's-90', kind: 'skill-install' as const, name: 'morning-review', outcome: 'approved' as const,
    reason: null, exec: { state: 'ok' as const, landed: 'morning-review' }, scriptCount: 2,
  };
  const install = grantWakeNoteOf(installFacts);
  const remove = grantWakeNoteOf({
    id: 's-91', kind: 'skill-remove', name: 'old-skill', outcome: 'approved',
    reason: null, exec: { state: 'ok', landed: 'data/trash/20261021-120000-old-skill' },
  });
  const rejected = grantWakeNoteOf({
    id: 's-92', kind: 'skill-install', name: 'morning-review', outcome: 'rejected',
    reason: '不想让它常驻', exec: { state: 'not-applicable' },
  });
  const failed = grantWakeNoteOf({
    id: 's-93', kind: 'skill-install', name: 'morning-review', outcome: 'approved',
    reason: null, exec: { state: 'failed', failure: '写技能目录失败：EACCES' },
  });
  for (const [label, note] of [
    ['装成功', install], ['删成功', remove], ['驳回', rejected], ['批准但没落地', failed],
  ] as const) {
    assertCardSentenceOnce(note, label);
  }
  // 同一串字节 = 同一份实现：直接调技能那一支与走共用入口（`grantWakeNoteOf` 的分派）逐字相同
  assert.equal(install, skillGrantWakeNoteOf(installFacts), '技能那一边没有自己的第二份文案');
  // 用词落点（与回执同一份）：装 =「装进技能根」、删 =「移进回收站」
  assert.match(install, /装进技能根/u);
  assert.match(grantReceiptLine(installFacts), /装进技能根/u);
  const removeFacts = {
    id: 's-91', kind: 'skill-remove' as const, name: 'old-skill', outcome: 'approved' as const,
    reason: null, exec: { state: 'ok' as const, landed: 'data/trash/20261021-120000-old-skill' },
  };
  assert.match(remove, /移进回收站/u);
  assert.match(grantReceiptLine(removeFacts), /移进回收站/u);
  // 技能那两支不说 MCP 那支的话（"写进配置"只属于 mcp-*）
  assert.equal(install.includes('写进配置'), false);
  assert.equal(remove.includes('写进配置'), false);
});

// ──────────────── ⑤ 端到端：批准装 / 批准删的**整条链路**（临时目录 + 假技能包） ────────────────
//
// 用户 2026-10-11 那一版自承的缺口①：「**批准装技能整条没真跑过**（尤其'装到哪个根'只靠读代码）」。
// 这一条把它跑一遍，用的是**生产的那条链路**，一个部件都不是替身：
//   · `RealLoop.tickOnce`（真拾取 `settleGrants`、真 fold、真 `skillIndexSync`、真 render）；
//   · `WebServer` 的 `grant-decide` 端点（人点批准/驳回走的就是它）；
//   · 真的 `EventLog` / 真的 `SkillManager` / 真的文件系统。
// 只有模型是假的（台子本来就只假模型）。技能根与数据目录全部挂在临时目录里，
// **一个字节都不碰仓库里的 `data/**` 与 `skills/`**。
//
// ── 这一条要给出的实测答案：**批准的技能落到哪个根？** ──
//   落点 = `skillsRootOf(baseRoot)` = baseRoot 下的 `DEFAULT_SKILL_ROOTS[0]`，也就是
//   **`<baseRoot>/skills/<name>`**。baseRoot 的来源两处一处口径：web 层是
//   `deps.skillsRoot ?? process.cwd()`（server.ts 的 grant-decide），`main.ts` 的技能管理器是
//   `SkillManager.baseRoot = dataDir`（v79 起：技能实体住在数据目录）**并且装配 web 时传
//   `skillsRoot: dataDir`**——所以生产上那个根是 `**<dataDir>/skills/<name>**`。
//   本用例判的**不是**生产那份 baseRoot 的取值，而是"web 层缺省时按哪个根落地"这条**回退**
//   判据：把 `process.cwd()` 换到台子的临时根上、**不给 `skillsRoot`**，于是落点就是
//   `<台子根>/skills/<name>`。断言因此有三件事一起说清：实际落点（打出来）、
//   `data/skills/` 在这个回退姿势下不被使用、`DEFAULT_SKILL_ROOTS` 扫得到。
//   （生产那条路"装进数据目录"由 `test/skills-datadir.test.ts` 与 `main.ts` 的装配钉住。）
//
// ── 它同时钉住那个"顺手修的洞"：**引擎信任表的增量折叠** ──
//   `skill/installed` 是 **web 层**写的（不是循环自己 `appendSync` 的那一条），所以循环里那张
//   信任表在**下一次归集点**之前根本不知道它（`SkillManager.applyTrustEvent` 只折本进程自己写的）。
//   修法在 `RealLoop.skillIndexSync`：重建索引之前把 `seq > skillTrustSeq` 的事件增量折进来。
//   这一条用例的两个时刻就是那个洞的两面：
//     · 批准之后、归集之前：`trustOf` 仍是 `never-confirmed`（洞的形状）；
//     · 归集那一拍之后：`trusted`，而且**没有重启**（重启就等于把判据换成"重启才生效"了）。

/** 一张 `skill/index` 快照的文本（没有快照给空串） */
function lastSkillIndexText(events: readonly AppEvent[]): string {
  const snapshots = events.filter(
    (event): event is AppEvent & { type: 'skill/index' } => event.type === 'skill/index',
  );
  return snapshots.length === 0 ? '' : snapshots[snapshots.length - 1]!.data.text;
}

/** 请求体里那段**技能索引**（长期记忆层里以 `CATALOG_HEADER` 开头的那一段）；没有时给空串 */
function skillSegmentOfRequest(input: unknown): string {
  const items = Array.isArray(input) ? input : [];
  const first = items[0] as { role?: string; content?: unknown } | undefined;
  const layer = first !== undefined && typeof first.content === 'string' ? first.content : '';
  const at = layer.indexOf(CATALOG_HEADER);
  if (at < 0) return '';
  const rest = layer.slice(at);
  const end = rest.indexOf('\n\n');
  return end < 0 ? rest : rest.slice(0, end);
}

test('⑤ 端到端：假技能包 → 递单 → 界面批准 → 装进技能根（逐字）→ 归集进索引 → 批准删除 → 回收站 → 归集后消失', async (t) => {
  const WEB_TOKEN = 'test-token-skill-grant-e2e';
  const cwdBefore = process.cwd();
  /** 循环手上那一个真的 SkillManager（信任表就在它里面：增量折叠验的是**它**） */
  let engineSkills: SkillManager | null = null;
  const rig = await makeRealWakeRig({
    // 与 `main.ts` 同一句：`new SkillManager({ baseRoot: process.cwd() })`（台子把 baseRoot 给成临时根）
    skills: (baseRoot) => {
      engineSkills = new SkillManager({ baseRoot, out: () => undefined });
      return engineSkills;
    },
    // 每一拍一个 heavy 请求（台子脚本耗尽会抛：多一拍少一拍都会红）
    stream: Array.from({ length: 8 }, () => ({ text: '好。' })),
  });
  let web: WebServer | null = null;
  // 清理顺序就是**判据的一部分**：先把 cwd 从临时目录里挪出来，再删目录、再关服务。
  // （Windows 上 cwd 停在待删目录里会把它锁住，rmSync 会静默失败留下垃圾。）
  t.after(async () => {
    process.chdir(cwdBefore);
    await web?.close();
    rig.dispose();
  });

  const dataDir = join(rig.dir, 'data');
  const personaRoot = join(dataDir, 'persona');
  mkdirSync(personaRoot, { recursive: true });
  t.diagnostic(`[e2e] 临时根（也就是这一场的"项目根"）：${rig.dir}`);

  // ── ① 造一个假技能包：`<tmp>/pkg/SKILL.md` + 一个脚本 + 一份参考 ──
  // 它**真的在盘上**（不是用例心里想的字符串）：装出来的每一个字节都要跟它比。
  // 包里的 SKILL.md 就按落地格式写（两行 frontmatter + 空行 + 正文），于是
  // "装出来的 SKILL.md == 包里的 SKILL.md" 这句话能逐字节成立。
  const DESCRIPTION = '探针技能：验证"人批准装技能"的整条链路，带一个脚本与一份参考文档。';
  const BODY = '# 探针用法\n\n1. 先读 references/notes.md\n2. 再跑 scripts/probe.py\n';
  const PKG_SKILL_TEXT = `---\nname: probe-kit\ndescription: ${DESCRIPTION}\n---\n\n${BODY}`;
  const PKG_SCRIPT = 'print("probe ok")\n';
  const PKG_NOTES = '# 探针笔记\n\n这段字必须逐字落进技能目录。\n';
  const pkgDir = join(rig.dir, 'pkg');
  for (const [rel, content] of [
    [SKILL_FILE_NAME, PKG_SKILL_TEXT],
    ['scripts/probe.py', PKG_SCRIPT],
    ['references/notes.md', PKG_NOTES],
  ] as const) {
    const target = join(pkgDir, ...rel.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }

  // 先有一个**已经生效**的技能（否则"删除之后索引里不再含它"会撞上"空索引不落事件"那条设计，
  // 判据就变成测空气了）。它是人早就批过的：目录 + 一条 `skill/installed{by:'human'}`
  // ——这条是循环自己 `appendSync` 的，与生产里"skill-confirm 那条路"同形。
  const keepText = '---\nname: keep-kit\ndescription: 一直留着的那个技能：做另一件事，用来对照索引的进出。\n---\n\n正文。\n';
  mkdirSync(join(rig.dir, 'skills', 'keep-kit'), { recursive: true });
  writeFileSync(join(rig.dir, 'skills', 'keep-kit', SKILL_FILE_NAME), keepText, 'utf8');
  rig.append('skill/installed', {
    name: 'keep-kit', path: 'skills/keep-kit', by: 'human', contentHash: sha256Hex(keepText),
  });

  // ── ② 递单：她做的事就是往 `data/grants/` 写一张单子（盘上的包 → 单子里的几格） ──
  writeGrantFile(rig.dir, 'e2e-install', {
    kind: 'skill-install',
    name: 'probe-kit',
    description: DESCRIPTION,
    body: BODY,
    files: [
      { path: 'scripts/probe.py', content: PKG_SCRIPT },
      { path: 'references/notes.md', content: PKG_NOTES },
    ],
    reason: '想让它每天帮我跑一次探针',
  });

  // ── ③ 框架拾取（真 `settleGrants`）：一拍之后台面上有 `grant/requested` 与 `human/asked` ──
  rig.append('wake/manual', { note: '一拍' });
  await rig.tick();

  const afterPickup = await eventsOf(rig);
  const requested = afterPickup.find((event) => event.type === 'grant/requested');
  const asked = afterPickup.find((event) => event.type === 'human/asked');
  assert.ok(requested !== undefined, '她递的单子必须被拾取成一条 grant/requested');
  assert.ok(asked !== undefined, '拾取之后台面上必须有那张卡（human/asked）');
  assert.equal(asked.data.question, '批准装一个技能「probe-kit」？');
  assert.equal(requested.data.kind, 'skill-install');
  // `scripts/` 单列（D8）：它会进事件、进卡面
  assert.deepEqual(requested.data.skillScriptNames, ['scripts/probe.py']);
  assert.equal(requested.data.skillFileCount, 2);

  // 批准之前：盘上没有、扫描器看不见、信任门也没凭据（"待批 ≠ 装上了"）
  const installedDir = join(rig.dir, DEFAULT_SKILL_ROOTS[0], 'probe-kit');
  assert.equal(existsSync(installedDir), false, '批准之前不许有任何目录');

  // ── ④ 人点批准（**真的走 HTTP 的 `grant-decide`**） ──
  // 把 cwd 换到临时根上，并且**不给 `skillsRoot`**：测的是 web 层那条**回退**判据
  // （`deps.skillsRoot ?? process.cwd()`）。生产装配（`main.ts`）v79 起显式传 `dataDir`，
  // 那一条路由 `test/skills-datadir.test.ts` 与 main 的装配钉住；这里不传是为了把
  // "缺省时按哪个根落地"也实测到，同时保证一个字节都不会落进真仓库的 `skills/`。
  process.chdir(rig.dir);
  const webNow = (): Date => new Date(Date.parse(RIG_NOW));
  web = await startWebServer({
    log: rig.log,
    projection: rig.projection,
    config: defaultConfig(rig.dir),
    personaRoot,
    dataDir,
    timers: new TimerStore(join(dataDir, 'timers.json'), { now: webNow }),
    now: webNow,
    registry: new ToolRegistry(),
    // ↓ **刻意不传 skillsRoot**：这一条验的是回退（生产传的是 dataDir，见上面的说明）
    uiToken: WEB_TOKEN,
    configPath: join(rig.dir, 'config.json'),
    port: 0,
    out: (line) => t.diagnostic(`[web] ${line}`),
  });
  const decide = async (body: Record<string, unknown>): Promise<{
    status: number;
    text: string;
    body: {
      ok?: boolean; outcome?: string; skillInstalledSeq?: number | null;
      exec?: { state?: string; failure?: string; landed?: string };
      receipt?: string; woken?: boolean; restartRequired?: boolean; restartNote?: string;
      error?: { code?: string; message?: string };
    };
  }> => {
    const response = await fetch(`${web!.url()}/api/commands/grant-decide`, {
      method: 'POST',
      headers: { authorization: `Bearer ${WEB_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: response.status, text, body: (parsed ?? {}) as never };
  };

  const approved = await decide({ id: 'e2e-install', decision: 'approve' });
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.body.outcome, 'approved');
  assert.equal(approved.body.exec?.state, 'ok', JSON.stringify(approved.body.exec));
  assert.equal(approved.body.exec?.landed, 'probe-kit');
  assert.equal(typeof approved.body.skillInstalledSeq, 'number', '信任门那条凭据必须真的落了');
  assert.match(String(approved.body.receipt), /装进技能根/u);
  // 技能那一支不写 config.json ⇒ 不许说"mcp.servers 要重启"（那是实测过的一句假话）
  assert.equal(approved.body.restartRequired, false);
  assert.equal(String(approved.body.restartNote).includes('mcp.servers'), false);

  // ── ④a **装到了哪个根**：三件事一起说清（实际路径 / 不是 data/skills / 扫得到） ──
  t.diagnostic(`[e2e] 批准之后技能装到了：${installedDir}`);
  assert.equal(existsSync(installedDir), true, `技能该落在 ${installedDir}`);
  // 它不是 `<dataDir>/skills/`（那条路没人扫：`DEFAULT_SKILL_ROOTS` 是 `skills` 与 `.agents/skills`）
  assert.equal(existsSync(join(dataDir, DEFAULT_SKILL_ROOTS[0], 'probe-kit')), false, '不许装进 data/skills/');
  // `DEFAULT_SKILL_ROOTS` 扫得到吗：用**同一把尺子**（SkillManager 的默认根）扫一遍
  const scanner = new SkillManager({ baseRoot: process.cwd(), out: () => undefined });
  const scan = scanner.scan();
  const found = scan.candidates.find((candidate) => candidate.name === 'probe-kit');
  t.diagnostic(`[e2e] 扫描根 = ${scan.roots.join('、')}`);
  t.diagnostic(`[e2e] 扫到的 relDir = ${found?.relDir ?? '(没扫到)'}，skillPath = ${found?.skillPath ?? '(没有)'}`);
  assert.ok(found !== undefined, 'DEFAULT_SKILL_ROOTS 必须扫得到刚装上的技能');
  assert.equal(found.relDir, 'skills/probe-kit');
  assert.equal(found.rootName, DEFAULT_SKILL_ROOTS[0], '命中第一个根（`skills/`）');
  assert.equal(found.skillPath, 'skills/probe-kit/SKILL.md');

  // ── ④b 内容**逐字对**：SKILL.md 与随包文件一个字节不差 ──
  assert.equal(readFileSync(join(installedDir, SKILL_FILE_NAME), 'utf8'), PKG_SKILL_TEXT,
    'SKILL.md 必须与假技能包逐字节相同');
  assert.equal(readFileSync(join(installedDir, 'scripts', 'probe.py'), 'utf8'), PKG_SCRIPT,
    '随包脚本逐字节相同');
  assert.equal(readFileSync(join(installedDir, 'references', 'notes.md'), 'utf8'), PKG_NOTES,
    '随包参考文档逐字节相同');
  // 盘上的包本身没被动过（"装"是复制，不是搬走人的东西）
  assert.equal(readFileSync(join(pkgDir, SKILL_FILE_NAME), 'utf8'), PKG_SKILL_TEXT);

  // ── ④c 信任门凭据落库：`skill/installed{by:'human'}`，哈希是**技能系统自己算的** ──
  const afterApprove = await eventsOf(rig);
  const installs = afterApprove.filter(
    (event): event is AppEvent & { type: 'skill/installed' } => event.type === 'skill/installed',
  );
  const probeInstall = installs.find((event) => event.data.name === 'probe-kit');
  assert.ok(probeInstall !== undefined, '批准装之后必须有一条 probe-kit 的 skill/installed');
  assert.equal(probeInstall.data.by, 'human', '人批的 ⇒ by:human（自沉淀才是 agent）');
  assert.equal(probeInstall.data.path, 'skills/probe-kit');
  assert.equal(probeInstall.data.contentHash, sha256Hex(PKG_SKILL_TEXT), '哈希是那串要落地的字节');

  // ── ④d 引擎信任表：**此刻还不知道**（那条事件是 web 层写的，循环自己没写过它） ──
  assert.ok(engineSkills !== null);
  const engine = engineSkills as SkillManager;
  assert.equal(
    engine.trustOf('probe-kit', sha256Hex(PKG_SKILL_TEXT)).state,
    'never-confirmed',
    '归集之前循环那张信任表不该认得这条 web 层写的凭据（那正是 2026-10-11 补的洞的形状）',
  );

  // ── ⑤ 归集点（压缩/重启等价的那一拍）：索引重建，**不重启**就得看见它 ──
  // `compaction/summary` 是本仓库里唯一的"上下文重大变化"凭据（`skillIndexOf.coveredSeq`），
  // 它一落，下一拍 `skillIndexSync` 就走重建那一条。
  rig.append('compaction/summary', { coveredUpToSeq: 1, summary: '（测试用的交接笔记）' });
  rig.append('wake/manual', { note: '归集这一拍' });
  await rig.tick();

  const afterCollect = await eventsOf(rig);
  const indexText = lastSkillIndexText(afterCollect);
  t.diagnostic(`[e2e] 归集之后的 skill/index：\n${indexText}`);
  assert.match(indexText, /- probe-kit: /u, '归集之后索引里必须出现这个技能');
  assert.match(indexText, /探针技能/u, '正文（描述）要真的进去，不是只有名字');
  assert.match(indexText, /- keep-kit: /u, '一直留着的那个也还在（否则"多一行"是假结论）');
  // 增量折叠真的发生了（同一个 SkillManager 实例，没有重启、没有 setTrustEvents 全量重折）
  assert.equal(
    engine.trustOf('probe-kit', sha256Hex(PKG_SKILL_TEXT)).state,
    'trusted',
    '归集那一刻信任表要把 web 层写的那条增量折进来（不折 = 装了但永远看不见）',
  );
  // 她这一拍读到的请求里也真有这一段（索引不是只落在事件里）
  const collectedRequest = rig.requests.at(-1)!.request;
  assert.match(skillSegmentOfRequest(collectedRequest.input), /- probe-kit: /u,
    '归集之后她这一次请求的技能索引里就有它');

  // ── ⑥ 再删（`skill-remove` 批准） ──
  writeGrantFile(rig.dir, 'e2e-remove', { kind: 'skill-remove', name: 'probe-kit', reason: '验完了，删掉' });
  await rig.tick(); // 拾取（每一拍都会扫一遍 grants/，不需要额外的唤醒）
  const afterRemovePickup = await eventsOf(rig);
  const removeAsked = afterRemovePickup.filter((event) => event.type === 'human/asked')
    .find((event) => event.data.question === '批准删掉技能「probe-kit」？');
  assert.ok(removeAsked !== undefined, '删除申请也要挂成一张卡');
  assert.ok(
    afterRemovePickup.some((event) => event.type === 'grant/requested' && event.data.id === 'e2e-remove'),
    '删除申请照样落一条 grant/requested',
  );

  const removed = await decide({ id: 'e2e-remove', decision: 'approve' });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(removed.body.outcome, 'approved');
  assert.equal(removed.body.exec?.state, 'ok', JSON.stringify(removed.body.exec));
  // 删除**不写**信任门凭据（目录都没了，写它等于给空气发凭据）
  assert.equal(removed.body.skillInstalledSeq, null, '删除不该再写 skill/installed');
  const landed = String(removed.body.exec?.landed ?? '');
  t.diagnostic(`[e2e] 删除：原目录 ${installedDir} ⇒ 回收站 ${landed}`);
  assert.ok(landed.includes('trash'), `该进回收站，实际 ${landed}`);
  assert.ok(existsSync(landed), '回收站里那一份要在');
  // 目录真的走了、内容一个字节不改（可逆那条承诺）
  assert.equal(existsSync(installedDir), false, '批准删除之后原目录必须已经不在了');
  assert.equal(readFileSync(join(landed, SKILL_FILE_NAME), 'utf8'), PKG_SKILL_TEXT,
    '回收站里那份 SKILL.md 一个字节不改（移回去就能恢复）');
  assert.equal(readFileSync(join(landed, 'scripts', 'probe.py'), 'utf8'), PKG_SCRIPT);

  // ── ⑦ 再归集一次 ⇒ 索引里**不再含它**（而 keep-kit 还在，所以这一拍真的落了一条新快照） ──
  rig.append('compaction/summary', { coveredUpToSeq: 1, summary: '（测试用的交接笔记 · 第二次）' });
  rig.append('wake/manual', { note: '删完再归集' });
  await rig.tick();

  const afterRemoveCollect = await eventsOf(rig);
  const finalIndex = lastSkillIndexText(afterRemoveCollect);
  t.diagnostic(`[e2e] 删除后归集的 skill/index：\n${finalIndex}`);
  assert.equal(finalIndex.includes('probe-kit'), false, '归集之后索引里不许再有它');
  assert.match(finalIndex, /- keep-kit: /u, '对照面：另一个技能照旧在（证明这条快照是重建出来的）');
  // 快照是**追加**的（不是回改历史）：删除前那条还逐字留在日志里
  const snapshotTexts = afterRemoveCollect
    .filter((event) => event.type === 'skill/index')
    .map((event) => (event.data as { text: string }).text);
  assert.ok(snapshotTexts.length >= 3, `至少三条快照（首次 / 装后 / 删后），实际 ${snapshotTexts.length} 条`);
  assert.ok(snapshotTexts.some((text) => text.includes('probe-kit')), '历史里那条快照照旧含它（不回改历史）');
  // 她下一拍读到的技能索引里也没有了
  assert.equal(
    skillSegmentOfRequest(rig.requests.at(-1)!.request.input).includes('probe-kit'),
    false,
    '删除归集之后她的技能索引里就没有这一行了',
  );
  // 磁盘事实：两个根里都找不到它了
  assert.equal(new SkillManager({ baseRoot: process.cwd() }).locate('probe-kit'), null);
});
