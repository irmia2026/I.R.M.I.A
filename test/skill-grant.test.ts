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

import { applyGrant, grantPathOf, grantsDirOf, parseGrantRequest } from '../src/grant/mcp-grant.ts';
import { SKILL_FILE_NAME, SkillManager } from '../src/skill/skills.ts';
import { makeRealWakeRig } from './fixtures/real-wake-rig.ts';
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
