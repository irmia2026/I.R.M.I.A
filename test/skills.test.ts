/**
 * Skill 系统测试 — src/skill/skills.ts
 *
 * 对齐 docs/design.md §4.19「Skill（任务知识包）」与 docs/milestones.md M7-4。五组断言：
 *   1. **frontmatter**：手写 YAML 子集的解析（引号/块标量/未加引号含冒号/注释）与两个必填字段的校验；
 *   2. **catalog 预算**：每条 50-100 token（超限截断并告警）、总预算裁剪；
 *   3. **信任门**：未确认不进 catalog、human 确认后进入、确认后内容变更即失效、
 *      agent 自沉淀一律仍需确认（防垃圾自注册）；
 *   4. **渐进披露**：catalog 里只有 name + description，SKILL.md 正文不出现在请求里（M7-4），
 *      但模型自己能用 safe_read 读到；
 *   5. **只读区**：技能目录可读不可写（写工具在执行路径上拦，不靠提示词）。
 *
 * 另有 §8「删除」用到的两个基元：`skillNameProblem`（路径穿越在这里**显式**拒绝，不靠正则的宽度）
 * 与 `SkillManager#locate`（两个技能根都认，删除才不会漏掉放在 `.agents/skills/` 那一侧的那份）。
 *
 * 全部用例在真实临时目录里跑：只有真的读一遍 SKILL.md、真的算一遍内容哈希，
 * 「信任门」与「变更失效」才算被证明过。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { describe, type TestContext } from 'node:test';

import type { AppEvent, SkillInstalled } from '../src/log/types.ts';
import { buildSkillList, confirmSkill, formatSkillList } from '../src/cli.ts';
import { deriveRequest } from '../src/runtime/agent-loop.ts';
import {
  CATALOG_ENTRY_TOKEN_BUDGET,
  CATALOG_TOTAL_TOKEN_BUDGET,
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_NAME_MAX_CHARS,
  SkillManager,
  clipDescription,
  parseFrontmatter,
  readOnlyPrefixOf,
  skillNameProblem,
  validateMetadata,
  type SkillManagerOptions,
} from '../src/skill/skills.ts';
import { buildFsTools } from '../src/tools/fs/index.ts';
import { FS_ERROR_CODES, type ToolContext, type ToolDefinition } from '../src/tools/fs/types.ts';
import { estimateTokens } from '../src/tools/registry.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 测试脚手架 ────────────────────────────────

/** 正文哨兵：它一旦出现在 catalog 或任何请求字节里，就说明渐进披露被破坏 */
const BODY_MARKER = 'BODY-ONLY-SENTINEL-9931';

function makeBase(t: TestContext): string {
  const dir = tempDirSync('irmia-skill-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface SkillSpec {
  /** 相对技能根的 posix 目录，如 `skills/alpha` */
  relDir: string;
  frontmatter: string | null;
  body?: string;
}

function writeSkillAt(base: string, spec: SkillSpec): void {
  const dir = join(base, ...spec.relDir.split('/'));
  mkdirSync(dir, { recursive: true });
  if (spec.frontmatter === null) return; // 刻意不写 SKILL.md
  const body = spec.body ?? `正文第一行\n${BODY_MARKER}\n正文最后一行`;
  writeFileSync(join(dir, 'SKILL.md'), `---\n${spec.frontmatter}\n---\n\n${body}\n`, 'utf8');
}

function simpleSkill(relDir: string, name: string, description: string, body?: string): SkillSpec {
  const spec: SkillSpec = { relDir, frontmatter: `name: ${name}\ndescription: ${description}` };
  if (body !== undefined) spec.body = body;
  return spec;
}

let seq = 0;
function resetSeq(): void {
  seq = 0;
}

/** 造一条 `skill/installed` 事件（信任门的唯一凭据） */
function installedEvent(
  name: string,
  by: 'human' | 'agent',
  contentHash?: string,
  patch: { seq?: number } = {},
): AppEvent & { type: 'skill/installed' } {
  seq += 1;
  const data: SkillInstalled['data'] = { name, path: `skills/${name}`, by };
  if (contentHash !== undefined) data.contentHash = contentHash;
  return {
    seq: patch.seq ?? seq,
    ts: `2026-03-01T00:00:${String(Math.min(seq, 59)).padStart(2, '0')}.000Z`,
    type: 'skill/installed',
    data,
    visibility: 'internal',
  };
}

interface ManagerHarness {
  base: string;
  manager: SkillManager;
  /** 收到的 skill/installed 事件负载（emit 通道） */
  emitted: SkillInstalled['data'][];
  logs: string[];
}

function makeManager(t: TestContext, options: SkillManagerOptions = {}): ManagerHarness {
  const base = makeBase(t);
  resetSeq();
  const emitted: SkillInstalled['data'][] = [];
  const logs: string[] = [];
  const manager = new SkillManager({
    baseRoot: base,
    out: (line) => logs.push(line),
    emit: (_type, data) => {
      emitted.push(data as SkillInstalled['data']);
    },
    now: () => new Date('2026-03-01T00:00:00.000Z'),
    ...options,
  });
  return { base, manager, emitted, logs };
}

/** 建目录 + 折入 human 确认（「已生效的技能」最常用的一条准备动作） */
function closeSkill(h: ManagerHarness, name: string, description: string, relDir?: string): void {
  writeSkillAt(h.base, simpleSkill(relDir ?? `skills/${name}`, name, description));
  const data = h.manager.buildInstalledData(name, 'human');
  assert.ok(data !== null, `未能为 ${name} 生成确认负载（目录或 frontmatter 有问题）`);
  assert.ok(data.contentHash !== undefined, '确认负载必须带内容哈希（变更检测的凭据）');
  h.manager.setTrustEvents([installedEvent(name, 'human', data.contentHash)]);
}

// ──────────────────────────────── 1. frontmatter ────────────────────────────────

describe('frontmatter 解析（YAML 子集）', () => {
  test('基本键值、引号、行内注释与注释行', () => {
    const parsed = parseFrontmatter(
      [
        '---',
        '# 一句注释',
        'name: daily-review',
        'description: "复盘当天的事，含：决策与遗留" # 行内注释',
        'license: MIT',
        '---',
        '',
        '正文开始',
        '第二行',
      ].join('\n'),
    );
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    assert.equal(parsed.fields['name'], 'daily-review');
    assert.equal(parsed.fields['description'], '复盘当天的事，含：决策与遗留');
    assert.equal(parsed.fields['license'], 'MIT');
    assert.equal(parsed.bodyLines, 2);
    assert.ok(parsed.body.includes('正文开始'));
  });

  test('未加引号且含冒号的值按整段取（容错优先）', () => {
    const parsed = parseFrontmatter(
      ['---', 'name: a-b', 'description: 说明: 这里还有冒号', '---', 'body'].join('\n'),
    );
    assert.ok(parsed.ok);
    assert.equal(parsed.fields['description'], '说明: 这里还有冒号');
  });

  test('块标量 >- 折叠为空格、| 保留换行', () => {
    const folded = parseFrontmatter(
      ['---', 'name: a-b', 'description: >-', '  第一行', '  第二行', '', '  第三段', '---', 'body'].join('\n'),
    );
    assert.ok(folded.ok);
    assert.equal(folded.fields['description'], '第一行 第二行\n第三段');

    const literal = parseFrontmatter(['---', 'name: a-b', 'description: |', '  第一行', '  第二行', '---'].join('\n'));
    assert.ok(literal.ok);
    assert.equal(literal.fields['description'], '第一行\n第二行');
  });

  test('单引号值里的双写单引号按 YAML 规则还原', () => {
    const parsed = parseFrontmatter(['---', 'name: a-b', "description: 'it''s fine'", '---'].join('\n'));
    assert.ok(parsed.ok);
    assert.equal(parsed.fields['description'], "it's fine");
  });

  test('缺少 frontmatter 块被拒绝（不再猜文件头的含义）', () => {
    const parsed = parseFrontmatter('# 只有标题\nname: a-b\n');
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok && parsed.error.includes('frontmatter'));
  });

  test('只有开头的 --- 没有结束的 --- 也被拒绝', () => {
    const parsed = parseFrontmatter('---\nname: a-b\ndescription: x\n');
    assert.equal(parsed.ok, false);
  });
});

// ──────────────────────────────── 2. 元数据校验 ────────────────────────────────

describe('元数据校验', () => {
  const good = { name: 'daily-review', description: '每天复盘：读当天的 episode 并写结论' };

  test('合法元数据通过，并保留官方扩展字段', () => {
    const verdict = validateMetadata({ ...good, 'allowed-tools': 'safe_read' }, 'daily-review');
    assert.ok(verdict.ok);
    assert.equal(verdict.metadata.name, 'daily-review');
    assert.equal(verdict.metadata.extras['allowed-tools'], 'safe_read');
    assert.equal(verdict.metadata.extras['name'], undefined);
  });

  test('name 不合规一律拒绝：大写、下划线、空格、中文、超长', () => {
    const cases: Array<[string, string]> = [
      ['Daily-Review', 'Daily-Review'],
      ['daily_review', 'daily_review'],
      ['daily review', 'daily-review'],
      ['每日复盘', 'daily-review'],
      ['a'.repeat(SKILL_NAME_MAX_CHARS + 1), 'daily-review'],
      ['-leading', '-leading'],
      ['trailing-', 'trailing-'],
    ];
    for (const [name, dirName] of cases) {
      const verdict = validateMetadata({ ...good, name }, dirName);
      assert.equal(verdict.ok, false, `name「${name}」本应被拒绝`);
      assert.ok(!verdict.ok && verdict.reason.length > 0);
    }
  });

  test('name 必须与目录同名', () => {
    const verdict = validateMetadata(good, 'other-dir');
    assert.equal(verdict.ok, false);
    assert.ok(!verdict.ok && verdict.reason.includes('目录名'));
  });

  test('description 必填且 ≤1024 字符', () => {
    const missing = validateMetadata({ name: 'daily-review' }, 'daily-review');
    assert.equal(missing.ok, false);

    const tooLong = validateMetadata(
      { name: 'daily-review', description: 'x'.repeat(SKILL_DESCRIPTION_MAX_CHARS + 1) },
      'daily-review',
    );
    assert.equal(tooLong.ok, false);
    assert.ok(!tooLong.ok && tooLong.reason.includes('1024'));

    const atLimit = validateMetadata(
      { name: 'daily-review', description: 'x'.repeat(SKILL_DESCRIPTION_MAX_CHARS) },
      'daily-review',
    );
    assert.equal(atLimit.ok, true);
  });
});

// ──────────────────────────────── 3. 扫描 ────────────────────────────────

describe('技能根扫描', () => {
  test('两个根都扫、隐藏目录跳过、缺 SKILL.md 与非法 frontmatter 分别记拒绝原因', (t) => {
    const h = makeManager(t);
    writeSkillAt(h.base, simpleSkill('skills/alpha', 'alpha', '做甲事：处理 alpha 相关任务时使用'));
    writeSkillAt(h.base, simpleSkill('.agents/skills/beta', 'beta', '做乙事：处理 beta 相关任务时使用'));
    writeSkillAt(h.base, { relDir: 'skills/gamma', frontmatter: null }); // 没有 SKILL.md
    writeSkillAt(h.base, simpleSkill('skills/delta', 'delta-wrong', '名字与目录不一致'));
    writeSkillAt(h.base, simpleSkill('skills/Bad-Dir', 'Bad-Dir', '目录名大写也不合规'));
    writeSkillAt(h.base, simpleSkill('skills/.hidden', '.hidden', '隐藏目录不是 skill'));

    const scan = h.manager.scan();
    assert.deepEqual(scan.candidates.map((c) => c.name), ['alpha', 'beta']);
    assert.equal(scan.candidates[0]?.skillPath, 'skills/alpha/SKILL.md');
    assert.equal(scan.candidates[1]?.skillPath, '.agents/skills/beta/SKILL.md');
    assert.equal(scan.candidates[0]?.contentHash.length, 64);

    const reasons = new Map(scan.rejected.map((r) => [r.relDir, r.reason]));
    assert.ok(reasons.get('skills/gamma')?.includes('SKILL.md'));
    assert.ok(reasons.get('skills/delta')?.includes('目录名'));
    assert.ok(reasons.size >= 3, `拒绝清单应含 gamma/delta/Bad-Dir，实际 ${[...reasons.keys()].join('、')}`);
    assert.ok(!scan.candidates.some((c) => c.name === '.hidden'));
  });

  test('同名跨根：先声明的根生效，后者被拒绝并说明原因', (t) => {
    const h = makeManager(t);
    writeSkillAt(h.base, simpleSkill('skills/alpha', 'alpha', '第一个根里的 alpha：同名冲突测试'));
    writeSkillAt(h.base, simpleSkill('.agents/skills/alpha', 'alpha', '第二个根里的 alpha：应被拒绝'));

    const scan = h.manager.scan();
    assert.equal(scan.candidates.length, 1);
    assert.equal(scan.candidates[0]?.relDir, 'skills/alpha');
    assert.ok(scan.rejected.some((r) => r.relDir === '.agents/skills/alpha' && r.reason.includes('同名')));
  });

  test('技能根不存在时扫描为空，不抛错', (t) => {
    const h = makeManager(t);
    const scan = h.manager.scan();
    assert.deepEqual(scan.candidates, []);
    assert.deepEqual(scan.rejected, []);
  });
});

// ──────────────────────────────── 4. catalog 预算 ────────────────────────────────

describe('catalog 预算', () => {
  test('clipDescription 把整条压进预算内，未超限时原样返回', () => {
    const short = clipDescription(3, '短描述', CATALOG_ENTRY_TOKEN_BUDGET);
    assert.equal(short.truncated, false);
    assert.equal(short.text, '短描述');

    const long = clipDescription(3, '很长的描述'.repeat(60), CATALOG_ENTRY_TOKEN_BUDGET);
    assert.equal(long.truncated, true);
    assert.ok(long.tokens <= CATALOG_ENTRY_TOKEN_BUDGET, `${long.tokens} 应 ≤ ${CATALOG_ENTRY_TOKEN_BUDGET}`);
    assert.ok(long.text.endsWith('…'));
  });

  test('单条超预算：截断到 100 token 内并告警（条目仍然可用）', (t) => {
    const h = makeManager(t);
    const longDescription = '这是一个特别冗长的触发描述，写了太多细节以至于超出了 catalog 单条预算，必须被截断，'
      + '同时还要保留足够的信息让模型知道它大概能干什么，否则截断就等于把技能弄丢了。'.repeat(3);
    closeSkill(h, 'long-desc', longDescription);

    const catalog = h.manager.catalog();
    assert.equal(catalog.entries.length, 1);
    const entry = catalog.entries[0];
    assert.ok(entry !== undefined);
    assert.equal(entry.truncated, true);
    assert.ok(entry.tokens <= CATALOG_ENTRY_TOKEN_BUDGET, `条目 ${entry.tokens} token 应 ≤ 预算`);
    assert.ok(catalog.warnings.some((w) => w.includes('截断')), '截断必须告警');
    assert.ok(catalog.text.includes('- long-desc: '));
  });

  test('catalog 总预算：超出的条目丢弃并告警（不影响它们被 safe_read 读到）', (t) => {
    const h = makeManager(t, { catalogTotalTokens: 40 });
    const description = '做某件事：需要在特定场景触发时使用，包含明确的关键词与动作说明';
    const confirmations: Array<AppEvent & { type: 'skill/installed' }> = [];
    for (const name of ['aa-first', 'bb-second']) {
      writeSkillAt(h.base, simpleSkill(`skills/${name}`, name, description));
      const data = h.manager.buildInstalledData(name, 'human');
      assert.ok(data !== null);
      confirmations.push(installedEvent(name, 'human', data.contentHash));
    }
    // 一次折入两条确认：信任表是"日志折叠"的结果，分两次折会互相清空（测试脚手架别用错）
    h.manager.setTrustEvents(confirmations);

    const catalog = h.manager.catalog();
    assert.equal(catalog.entries.length, 1);
    assert.equal(catalog.entries[0]?.name, 'aa-first'); // 顺序确定：按扫描顺序（目录名升序）
    assert.ok(catalog.warnings.some((w) => w.includes('总预算') && w.includes('bb-second')));
    // 被裁掉的技能仍然可读——catalog 只是索引，不是能力本身
    assert.ok(h.manager.readBody('bb-second') !== null);
  });

  test('没有任何可用技能时 catalog 文本为空串（状态层该段整体不出现）', (t) => {
    const h = makeManager(t);
    writeSkillAt(h.base, simpleSkill('skills/alpha', 'alpha', '未确认的技能不该出现在索引里'));
    assert.equal(h.manager.catalogText(), '');
    assert.equal(h.manager.catalog().tokens, 0);
  });

  test('description 过短会被提示（官方反模式：太模糊就没有触发词）', (t) => {
    const h = makeManager(t);
    closeSkill(h, 'thin', '短');
    const catalog = h.manager.catalog();
    assert.ok(catalog.warnings.some((w) => w.includes('description 只有')));
  });
});

// ──────────────────────────────── 5. 信任门 ────────────────────────────────

describe('信任门', () => {
  test('未确认的技能不进 catalog，进 pending 清单', (t) => {
    const h = makeManager(t);
    writeSkillAt(h.base, simpleSkill('skills/alpha', 'alpha', '做甲事：处理 alpha 相关任务时使用'));

    const catalog = h.manager.catalog();
    assert.equal(catalog.entries.length, 0);
    assert.equal(catalog.text, '');
    assert.equal(catalog.pending.length, 1);
    assert.equal(catalog.pending[0]?.state, 'never-confirmed');
    assert.ok(catalog.warnings.some((w) => w.includes('alpha') && w.includes('未进 catalog')));
  });

  test('human 确认事件后进入 catalog；渲染文本只含名称与描述', (t) => {
    const h = makeManager(t);
    const description = '每日复盘：当用户说"复盘""总结今天"时使用，读 episode 并写结论';
    writeSkillAt(h.base, simpleSkill('skills/daily-review', 'daily-review', description));
    const data = h.manager.buildInstalledData('daily-review', 'human');
    assert.ok(data !== null);
    h.manager.setTrustEvents([installedEvent('daily-review', 'human', data.contentHash)]);

    const catalog = h.manager.catalog();
    assert.deepEqual(catalog.entries.map((e) => e.name), ['daily-review']);
    assert.ok(catalog.text.includes('daily-review'));
    assert.ok(catalog.text.includes(description));
    assert.ok(!catalog.text.includes(BODY_MARKER), 'catalog 绝不能含正文');
    assert.ok(h.manager.trustOf('daily-review').state === 'trusted');
  });

  test('确认之后内容又被改动：退回待确认（变更即失效）', (t) => {
    const h = makeManager(t);
    const description = '做甲事：处理 alpha 相关任务时使用，含明确触发词';
    closeSkill(h, 'alpha', description);
    assert.equal(h.manager.catalog().entries.length, 1);

    // 改动 SKILL.md（正文变了，哈希随之改变）
    writeSkillAt(h.base, simpleSkill('skills/alpha', 'alpha', description, '被改过的正文'));
    const catalog = h.manager.catalog();
    assert.equal(catalog.entries.length, 0);
    assert.equal(catalog.pending[0]?.state, 'content-changed');
    assert.ok(catalog.warnings.some((w) => w.includes('又被改动')));

    // 重新确认后恢复
    const data = h.manager.buildInstalledData('alpha', 'human');
    assert.ok(data !== null);
    h.manager.setTrustEvents([installedEvent('alpha', 'human', data.contentHash)]);
    assert.equal(h.manager.catalog().entries.length, 1);
  });

  test('agent 自沉淀（by:agent）不构成信任，仍需人类确认', (t) => {
    const h = makeManager(t);
    writeSkillAt(h.base, simpleSkill('skills/self-made', 'self-made', '自己沉淀的做法：遇到同类问题时使用'));

    const data = h.manager.install('self-made', 'agent');
    assert.ok(data !== null);
    assert.equal(data.by, 'agent');
    assert.equal(h.emitted.length, 1, '自沉淀必须落一条 skill/installed 事件');
    assert.equal(h.emitted[0]?.by, 'agent');

    // 事件折进信任表后依然不进 catalog
    h.manager.setTrustEvents([installedEvent('self-made', 'agent', data.contentHash)]);
    const catalog = h.manager.catalog();
    assert.equal(catalog.entries.length, 0);
    assert.equal(catalog.pending[0]?.state, 'agent-proposed');

    // 人类确认后才生效：确认覆盖自沉淀（后写覆盖先写）
    const humanData = h.manager.buildInstalledData('self-made', 'human');
    assert.ok(humanData !== null);
    const agentEvent = installedEvent('self-made', 'agent', data.contentHash, { seq: 10 });
    const humanEvent = installedEvent('self-made', 'human', humanData.contentHash, { seq: 11 });
    h.manager.setTrustEvents([humanEvent, agentEvent]); // 故意乱序传入：折叠按 seq 排序
    assert.equal(h.manager.trustOf('self-made').state, 'trusted');
    assert.equal(h.manager.catalog().entries.length, 1);
  });

  test('install 对不存在或非法的技能返回 null，绝不写一条指向空气的确认', (t) => {
    const h = makeManager(t);
    assert.equal(h.manager.install('nothing-here', 'human'), null);
    writeSkillAt(h.base, simpleSkill('skills/bad-name', 'mismatch', '名字与目录不一致'));
    assert.equal(h.manager.confirm('bad-name'), null);
    assert.equal(h.emitted.length, 0);
  });

  test('旧事件没有 contentHash 时按名字信任（兼容），并允许显式关掉变更检测', (t) => {
    const h = makeManager(t);
    writeSkillAt(h.base, simpleSkill('skills/legacy', 'legacy', '老格式确认事件：没有内容哈希可用'));
    h.manager.setTrustEvents([installedEvent('legacy', 'human')]);
    assert.equal(h.manager.trustOf('legacy').state, 'trusted');
  });
});

// ──────────────────────────────── 6. 渐进披露与注入 ────────────────────────────────

describe('渐进披露', () => {
  test('catalog 只有 name + description；正文要用 readBody/safe_read 自己取（M7-4）', (t) => {
    const h = makeManager(t);
    closeSkill(h, 'alpha', '做甲事：处理 alpha 相关任务时使用，含明确触发词');

    const catalogText = h.manager.catalogText();
    assert.ok(catalogText.includes('alpha'));
    assert.ok(!catalogText.includes(BODY_MARKER));

    const body = h.manager.readBody('alpha');
    assert.ok(body !== null);
    assert.ok(body.includes(BODY_MARKER), '正文必须能被按需读到');
  });

  test('readBody 超窗口时截断并指明续读方式', (t) => {
    const h = makeManager(t);
    closeSkill(h, 'big', '做大事：需要长正文的技能，用来看截断行为是否正确');
    const body = h.manager.readBody('big', 10);
    assert.ok(body !== null);
    assert.ok(body.includes('已截断'));
    assert.ok(body.includes('SKILL.md'));
  });

  test('catalog 经 deriveRequest 进状态层，且请求体字节里没有正文（M7-4 核心断言）', (t) => {
    const h = makeManager(t);
    closeSkill(h, 'alpha', '做甲事：处理 alpha 相关任务时使用，含明确触发词');
    const catalogText = h.manager.catalogText();
    assert.notEqual(catalogText, '');

    const rendered = deriveRequest({
      persona: { identity: 'IDENTITY', constitution: 'CONSTITUTION', style: 'STYLE', state: 'STATE', personaHash: 'h1' },
      tools: [],
      timezone: 'UTC',
      lane: 'heavy',
      events: [],
      wakeEvent: null,
      taskCard: null,
      now: '2026-03-01T00:00:00.000Z',
      model: 'm',
      skillCatalog: catalogText,
    });

    const stateLayer = rendered.input[0];
    assert.ok(stateLayer !== undefined && stateLayer.type === 'message' && stateLayer.role === 'developer');
    assert.ok(stateLayer.content.includes('可用技能'));
    assert.ok(stateLayer.content.includes('- alpha: '));

    const bytes = [
      rendered.instructions,
      ...rendered.input.map((item) => (item.type === 'message' ? item.content : JSON.stringify(item))),
    ].join('\n');
    assert.ok(!bytes.includes(BODY_MARKER), '正文不得出现在任何请求字节里');
  });

  test('没有技能时 deriveRequest 的状态层不含技能段', () => {
    const rendered = deriveRequest({
      persona: { identity: 'I', constitution: 'C', style: 'S', state: 'STATE', personaHash: 'h1' },
      tools: [],
      timezone: 'UTC',
      lane: 'heavy',
      events: [],
      wakeEvent: null,
      taskCard: null,
      now: '2026-03-01T00:00:00.000Z',
      model: 'm',
      skillCatalog: null,
    });
    const stateLayer = rendered.input[0];
    assert.ok(stateLayer !== undefined && stateLayer.type === 'message');
    assert.ok(!stateLayer.content.includes('可用技能'));
  });
});

// ──────────────────────────────── 7. 只读区 ────────────────────────────────

describe('技能目录只读区', () => {
  async function tools(root: string): Promise<Map<string, ToolDefinition>> {
    const table = new Map<string, ToolDefinition>();
    const built = await buildFsTools(
      // find 是条件注册的（要探测 es.exe）：显式关掉，让这条用例在任何机器上都同形
      { backupDir: join(root, '.backups'), everythingPath: null },
      { now: () => new Date('2026-03-01T00:00:00.000Z') },
    );
    built.forEach((tool) => table.set(tool.name, tool));
    return table;
  }

  function ctx(root: string): ToolContext {
    return { callId: 'call-1', turn: 1, step: 1, signal: new AbortController().signal, workspaceRoot: root };
  }

  test('readOnlyPrefixOf 按路径分量匹配，不吃前缀式绕过', () => {
    assert.equal(readOnlyPrefixOf(['skills'], 'skills/alpha/SKILL.md'), 'skills');
    assert.equal(readOnlyPrefixOf(['skills'], 'skills'), 'skills');
    assert.equal(readOnlyPrefixOf(['skills', '.agents/skills'], '.agents/skills/a/SKILL.md'), '.agents/skills');
    assert.equal(readOnlyPrefixOf(['skills'], 'skills-other/x.md'), null);
    assert.equal(readOnlyPrefixOf(['skills'], 'workspace/skills/x.md'), null);
  });

  test('写工具拒绝 skills/ 内的路径，safe_read 仍能读到正文', async (t) => {
    const h = makeManager(t);
    closeSkill(h, 'alpha', '做甲事：处理 alpha 相关任务时使用，含明确触发词');
    const table = await tools(h.base);

    const write = table.get('safe_write');
    assert.ok(write !== undefined);
    const written = await write.handler(
      { path: 'skills/alpha/SKILL.md', content: '被模型改掉的正文' },
      ctx(h.base),
    );
    assert.equal(written.isError, true, '写入技能目录必须被拒绝');
    assert.equal(written.error?.code, FS_ERROR_CODES.PATH_DENIED);
    assert.ok(written.content.includes('只读区'));

    const edit = table.get('safe_edit');
    assert.ok(edit !== undefined);
    const edited = await edit.handler(
      { path: 'skills/alpha/SKILL.md', old: BODY_MARKER, new: 'x' },
      ctx(h.base),
    );
    assert.equal(edited.isError, true);
    assert.equal(edited.error?.code, FS_ERROR_CODES.PATH_DENIED);

    const rollback = table.get('safe_rollback');
    assert.ok(rollback !== undefined);
    const rolled = await rollback.handler({ path: 'skills/alpha/SKILL.md' }, ctx(h.base));
    assert.equal(rolled.isError, true);
    assert.equal(rolled.error?.code, FS_ERROR_CODES.PATH_DENIED);

    const read = table.get('safe_read');
    assert.ok(read !== undefined);
    const content = await read.handler({ path: 'skills/alpha/SKILL.md' }, ctx(h.base));
    assert.equal(content.isError, undefined);
    assert.ok(content.content.includes(BODY_MARKER), '渐进披露的前提是模型能读到正文');

    // 只读区之外的工作区文件照写不误（拦截只针对技能目录）
    const other = await write.handler({ path: 'workspace/note.md', content: 'ok' }, ctx(h.base));
    assert.equal(other.isError, undefined);
  });
});

// ──────────────────────────────── 8. 名字安全与物理位置（删除用） ────────────────────────────────

describe('技能名的安全判定（删除会把名字拼成路径）', () => {
  test('合规名字放行：新建与删除共用这一把尺子', () => {
    assert.equal(skillNameProblem('morning-review'), null);
    assert.equal(skillNameProblem('a1-b2'), null);
    assert.equal(skillNameProblem('x'.repeat(64)), null, '64 字符的合法名照旧放行（官方上限）');
  });

  test('路径穿越显式拒绝：上跳、分隔符、盘符、绝对路径都不许当名字', () => {
    const names = ['../x', '..\\x', 'a/b', '..', '.', 'C:\\Windows', 'C:x', '/etc/passwd', '\\\\srv\\share'];
    for (const name of names) {
      const problem = skillNameProblem(name);
      assert.notEqual(problem, null, `${name} 必须被拒`);
      assert.match(problem!, /技能名/u, `${name} 的错误信息要指明是名字的问题`);
    }
  });

  test('规范之外的名字照旧拒绝，错误信息说清允许什么', () => {
    assert.match(skillNameProblem('晨间总结')!, /小写字母、数字与连字符/u);
    assert.equal(skillNameProblem(''), '缺少 name（技能名，如 morning-review）');
  });
});

describe('SkillManager#locate（删除要两个根都认）', () => {
  test('两个根都找，给出根名与相对路径（posix）；找不到返回 null', (t) => {
    const h = makeManager(t);
    writeSkillAt(h.base, simpleSkill('skills/alpha', 'alpha', '甲事：处理 alpha 相关任务时使用，含触发词'));
    writeSkillAt(h.base, simpleSkill('.agents/skills/beta', 'beta', '乙事：处理 beta 相关任务时使用，含触发词'));

    assert.deepEqual(h.manager.locate('alpha'), {
      dir: join(h.base, 'skills', 'alpha'),
      relDir: 'skills/alpha',
      rootName: 'skills',
    });
    assert.deepEqual(h.manager.locate('beta'), {
      dir: join(h.base, '.agents', 'skills', 'beta'),
      relDir: '.agents/skills/beta',
      rootName: '.agents/skills',
    });
    assert.equal(h.manager.locate('never-existed'), null);
  });

  test('同名跨根时命中先声明的根（与 scan 的优先级同源）', (t) => {
    const h = makeManager(t);
    writeSkillAt(h.base, simpleSkill('skills/shadowed', 'shadowed', '先声明的根：优先级高，删除只该动这一份'));
    writeSkillAt(h.base, simpleSkill('.agents/skills/shadowed', 'shadowed', '后声明的根：另一条技能，不该被顺手删掉'));

    assert.equal(h.manager.locate('shadowed')?.relDir, 'skills/shadowed');
  });

  test('写坏的目录（缺 SKILL.md）也定位得到：scan 拒它，删除要能清它', (t) => {
    const h = makeManager(t);
    writeSkillAt(h.base, { relDir: 'skills/broken', frontmatter: null });

    assert.ok(existsSync(join(h.base, 'skills', 'broken')), '目录确实建了（只是没写 SKILL.md）');
    assert.equal(h.manager.scan().candidates.length, 0, 'scan 不认它（这正是它最该被清掉的理由）');
    assert.equal(h.manager.locate('broken')?.relDir, 'skills/broken');
  });
});

// ──────────────────────────────── 9. CLI 信任门操作面 ────────────────────────────────

describe('CLI 信任门操作面（skill list / confirm）', () => {
  test('确认前后：待确认 → 已生效 → 内容改动后重新退回待确认', async (t) => {
    const base = makeBase(t);
    const dataDir = join(base, 'data');
    mkdirSync(dataDir, { recursive: true });
    const description = '演示技能：验证人类确认流程能否把它放进 catalog 的技能索引';
    writeSkillAt(base, simpleSkill('skills/anysearch-demo', 'anysearch-demo', description));

    const before = buildSkillList(dataDir, base);
    assert.equal(before.entries.length, 1);
    assert.equal(before.entries[0]?.state, 'never-confirmed');
    assert.equal(before.catalogTokens, 0);

    // 主进程没跑，允许写事件（与 review resolve 同款探锁）
    const confirmed = await confirmSkill(
      dataDir,
      { name: 'anysearch-demo', by: 'tester' },
      new Date('2026-03-01T00:00:00.000Z'),
      base,
    );
    assert.ok(confirmed.ok, confirmed.ok ? '' : confirmed.error);
    assert.equal(confirmed.contentHash.length, 64);

    const after = buildSkillList(dataDir, base);
    assert.equal(after.entries[0]?.state, 'trusted');
    assert.ok(after.catalogTokens > 0);
    assert.ok(formatSkillList(after).some((line) => line.includes('✓ anysearch-demo')));

    // 改动 SKILL.md → 确认绑定的内容哈希失配 → 自动退回待确认（design §4.19）
    writeSkillAt(base, simpleSkill('skills/anysearch-demo', 'anysearch-demo', `${description}（被改动）`));
    const drifted = buildSkillList(dataDir, base);
    assert.equal(drifted.entries[0]?.state, 'content-changed');
    assert.equal(drifted.catalogTokens, 0);
  });

  test('确认一个不存在或不合规的技能被拒绝，不写指向空气的事件', async (t) => {
    const base = makeBase(t);
    const dataDir = join(base, 'data');
    mkdirSync(dataDir, { recursive: true });

    const missing = await confirmSkill(dataDir, { name: 'not-there', by: 'tester' }, new Date(), base);
    assert.equal(missing.ok, false);
    assert.ok(!missing.ok && missing.code === 2);

    writeSkillAt(base, simpleSkill('skills/bad-name', 'mismatch', '名字与目录不一致，不该被确认'));
    const mismatch = await confirmSkill(dataDir, { name: 'bad-name', by: 'tester' }, new Date(), base);
    assert.equal(mismatch.ok, false);

    const listed = buildSkillList(dataDir, base);
    assert.equal(listed.entries.length, 0);
    assert.ok(listed.rejected.some((item) => item.relDir === 'skills/bad-name'));
  });
});

// ──────────────────────────────── 10. 常量口径 ────────────────────────────────

describe('token 估算与常量口径', () => {
  test('条目预算与 design §4.19 的 50-100 token 口径一致', () => {
    assert.equal(CATALOG_ENTRY_TOKEN_BUDGET, 100);
    assert.ok(CATALOG_TOTAL_TOKEN_BUDGET >= CATALOG_ENTRY_TOKEN_BUDGET);
    assert.ok(estimateTokens('- alpha: 做甲事') > 0);
  });
});
