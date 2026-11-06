import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, {type TestContext} from 'node:test';

import {
  BUILTIN_PROFILES, DEFAULT_PROFILE_COMPACT_AT, DEFAULT_PROFILE_CONTEXT_LIMIT, MAX_PROFILE_CONTEXT_CHARS,
  MAX_PROFILE_CONTEXT_FILE_BYTES, MAX_PROFILE_SYSTEM_PROMPT_CHARS, RETIRED_PROFILE_IDS, ROLE_PACKAGES_FILE,
  SubagentProfileRegistry,
} from '../src/runtime/subagent-profiles.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

function dir(t: TestContext): string {
  const root = tempDirSync('irmia-subagent-profiles-');
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}

function writeRolePackages(root: string, installed: string[]): void {
  mkdirSync(join(root, 'subagents'), {recursive: true});
  writeFileSync(join(root, 'subagents', ROLE_PACKAGES_FILE), JSON.stringify({schema: 1, installed}), 'utf8');
}

function writeSkill(root: string, id: string): void {
  mkdirSync(join(root, 'skills', id), {recursive: true});
  writeFileSync(join(root, 'skills', id, 'SKILL.md'), `# ${id}\n`, 'utf8');
}

function writeMcp(root: string, profileId: string, id: string): void {
  mkdirSync(join(root, 'subagents', 'packs', profileId, 'mcp'), {recursive: true});
  writeFileSync(join(root, 'subagents', 'packs', profileId, 'mcp', `${id}.json`), '{}\n', 'utf8');
}

function summaryOf(registry: SubagentProfileRegistry, id: string) {
  return registry.summaries(true).find((item) => item.id === id);
}

test('三个角色包 + 隐式 general：加载、摘要、general 隐藏', (t) => {
  const registry = new SubagentProfileRegistry(dir(t));
  assert.deepEqual(registry.list().map((profile) => profile.id).sort(),
    ['general', 'researcher', 'scribe', 'worker']);
  assert.deepEqual(registry.summaries().map((item) => item.id).sort(),
    ['researcher', 'scribe', 'worker'], 'general 不进角色包列表');

  const all = registry.summaries(true);
  assert.equal(all.length, 4, 'includeHidden 才看得到 general');
  const general = registry.get('general');
  assert.notEqual(general, null);
  assert.equal(general!.hidden, true);
  assert.equal(general!.tools, 'readonly');
  const generalSummary = all.find((item) => item.id === 'general')!;
  assert.equal(generalSummary.available, true);
  assert.equal(generalSummary.locked, false);
  assert.deepEqual(generalSummary.missing, []);
  assert.deepEqual(registry.errors, []);
});

test('角色内容：researcher/worker/scribe 的 v2 字段与工具面（coder+design 已合并为 worker）', (t) => {
  const registry = new SubagentProfileRegistry(dir(t));

  const researcher = registry.get('researcher')!;
  assert.equal(researcher.label, '调研');
  assert.equal(researcher.workdir, 'workspace');
  assert.equal(researcher.shell, 'workspace');
  assert.deepEqual(researcher.tools, ['read', 'write', 'network', 'report']);
  assert.deepEqual(researcher.skills, ['auto-deep-research', 'quick-research']);
  assert.equal(researcher.reasoningEffort, 'max');
  assert.match(researcher.systemPrompt, /证据/u);
  assert.match(researcher.systemPrompt, /来源/u);
  assert.match(researcher.systemPrompt, /未解决/u);
  for (const name of ['safe_read', 'http_get', 'web_search', 'report']) {
    assert.ok(registry.toolNames(researcher).includes(name), `researcher 应含 ${name}`);
  }

  const worker = registry.get('worker')!;
  assert.equal(worker.label, '开发');
  assert.equal(worker.workdir, 'auto', '有 projectRoot 进项目，没有则退回 workspace');
  assert.equal(worker.shell, 'full', 'worker 是重度主力：full pwsh（cwd 默认 workspace、可访问任意路径）');
  assert.deepEqual(worker.tools, ['read', 'write', 'safe_rollback', 'vision_read', 'vision_query', 'report'],
    'worker 工具面 = 原 coder ∪ design（没有 MCP）；safe_rollback 显式点名（write capability 不含它）');
  assert.deepEqual(worker.skills,
    ['dev-workflow', 'review', 'irmia-framework', 'plugin-dev',
      'design-taste-frontend', 'ui-ux-pro-max', 'impeccable', 'motion-design']);
  assert.deepEqual(worker.mcpServers, [], '合并后 worker 不接 MCP');
  assert.equal(worker.reasoningEffort, 'max');
  assert.notEqual(worker.systemPrompt.trim(), '', 'worker 仍有轻量 systemPrompt');
  for (const name of ['safe_read', 'safe_write', 'vision_read', 'vision_query', 'report']) {
    assert.ok(registry.toolNames(worker).includes(name), `worker 应含 ${name}`);
  }
  for (const reserved of ['code_search', 'code_impact', 'code_pack', 'code']) {
    assert.equal(registry.toolNames(worker).includes(reserved), false, `${reserved} 不是 Profile 可声明的工具（code 由执行器按角色注入）`);
  }
  assert.deepEqual(worker.requires?.binaries, ['node', 'npm', 'git']);
  assert.deepEqual(worker.requires?.pythonModules, [
    'tree_sitter', 'tree_sitter_javascript', 'tree_sitter_typescript', 'tree_sitter_go',
    'tree_sitter_rust', 'tree_sitter_java', 'tree_sitter_c', 'tree_sitter_cpp',
  ]);
  // 外部设计 skill 已 vendor：固定 commit + 真实 hash，不再保留占位。
  for (const id of ['ui-ux-pro-max', 'impeccable', 'motion-design']) {
    const source = worker.install!.find((item) => item.source.endsWith(`/${id}`))!;
    assert.match(source.ref, /^[a-f0-9]{40}$/u, `${id} commit`);
    assert.match(source.sha256 ?? '', /^[a-f0-9]{64}$/u, id);
  }
  assert.equal(worker.install!.find((item) => item.source.endsWith('/motion-design'))!.ref,
    'f9a8a041b85185ee4881b3471d3415e939aac772', 'motion-design 固定到上游 commit');
  assert.equal(worker.install!.find((item) => item.source.endsWith('/motion-design'))!.sha256,
    '1b0700e2b0076b2efd86eb94d84f1bb67342e90a57ff58d9d7df04b06c3a3599', 'motion-design 归档 hash');

  const scribe = registry.get('scribe')!;
  assert.equal(scribe.label, '秘书');
  assert.equal(scribe.workdir, 'workspace');
  assert.equal(scribe.shell, 'full', 'scribe 需要 pwsh 跑 office / human-writing 等 skill 脚本');
  assert.deepEqual(scribe.tools, ['read', 'write', 'report']);
  assert.deepEqual(scribe.skills, [
    'office', 'copywriting', 'human-writing',
    'learn-with-u-writer', 'wechat-article', 'weekly-report', 'meeting-notes',
    'xiaohongshu-post', 'douyin-script', 'event-architect', 'sevonsss-plan',
  ]);
  assert.deepEqual(scribe.mcpServers, [], '秘书不接 MCP');
  assert.equal(scribe.reasoningEffort, 'high', 'scribe 是唯一的 high');
  assert.match(scribe.systemPrompt, /格式/u);
  assert.match(scribe.systemPrompt, /归档/u);

  for (const id of ['researcher', 'worker', 'scribe', 'general']) {
    const profile = registry.get(id)!;
    assert.equal(profile.contextLimit, DEFAULT_PROFILE_CONTEXT_LIMIT, `${id} contextLimit`);
    assert.equal(profile.contextLimit, 1_000_000);
    assert.equal(profile.compactAt, DEFAULT_PROFILE_COMPACT_AT, `${id} compactAt`);
    assert.equal(profile.compactAt, 0.7);
  }
  assert.equal(registry.get('general')!.reasoningEffort, 'high', 'general 沿用现有默认档');
  assert.equal(registry.get('coder'), null, 'coder 已随合并删除');
  assert.equal(registry.get('design'), null, 'design 已随合并删除');
});

test('锁定态：三个角色包默认未安装 ⇒ locked + missing；general 始终可用', (t) => {
  const registry = new SubagentProfileRegistry(dir(t));
  const expected = new Map<string, string[]>([
    ['researcher', ['auto-deep-research', 'quick-research']],
    ['worker', ['dev-workflow', 'review', 'irmia-framework', 'plugin-dev', 'design-taste-frontend',
      'ui-ux-pro-max', 'impeccable', 'motion-design', 'node', 'npm', 'git']],
    ['scribe', ['office', 'copywriting', 'human-writing',
      'learn-with-u-writer', 'wechat-article', 'weekly-report', 'meeting-notes',
      'xiaohongshu-post', 'douyin-script', 'event-architect', 'sevonsss-plan', 'python']],
  ]);
  for (const [id, missing] of expected) {
    const item = summaryOf(registry, id)!;
    assert.equal(item.available, false, `${id} 默认不可用`);
    assert.equal(item.locked, true, `${id} 默认锁定`);
    assert.deepEqual(item.missing, missing, `${id} 只回报依赖 id`);
  }
  assert.equal(summaryOf(registry, 'general')!.available, true);
});

test('安装登记后静态缺项精确；二进制与 Python 模块留给 healthcheck', (t) => {
  const root = dir(t);
  writeRolePackages(root, ['worker', 'scribe']);
  writeSkill(root, 'dev-workflow');
  const partial = new SubagentProfileRegistry(root);
  assert.equal(summaryOf(partial, 'worker')!.locked, true);
  assert.deepEqual(summaryOf(partial, 'worker')!.missing,
    ['review', 'irmia-framework', 'plugin-dev', 'design-taste-frontend', 'ui-ux-pro-max', 'impeccable',
      'motion-design', 'node', 'npm', 'git']);
  assert.deepEqual(summaryOf(partial, 'scribe')!.missing,
    ['office', 'copywriting', 'human-writing',
      'learn-with-u-writer', 'wechat-article', 'weekly-report', 'meeting-notes',
      'xiaohongshu-post', 'douyin-script', 'event-architect', 'sevonsss-plan', 'python']);
  assert.equal(summaryOf(partial, 'researcher')!.locked, true, '没装包的研究员仍锁');

  for (const id of ['review', 'irmia-framework', 'plugin-dev', 'design-taste-frontend', 'ui-ux-pro-max', 'impeccable', 'motion-design']) writeSkill(root, id);
  const ready = new SubagentProfileRegistry(root);
  assert.deepEqual(summaryOf(ready, 'worker')!.missing, ['node', 'npm', 'git']);
  assert.equal(summaryOf(ready, 'scribe')!.locked, true, 'scribe 没装技能仍锁');
});

test('requires 缺失 ⇒ locked + missing；补上技能文件即可满足', (t) => {
  const root = dir(t);
  mkdirSync(join(root, 'subagents'), {recursive: true});
  writeFileSync(join(root, 'subagents', 'profiles.json'), JSON.stringify({
    profiles: [{
      id: 'needs-skill', label: '缺依赖', tools: 'readonly', workspace: 'own',
      workdir: 'workspace', shell: 'none', skills: ['needs-skill'], mcpServers: [],
      reasoningEffort: 'max', contextLimit: 1000, compactAt: 0.5,
      requires: {skills: ['needs-skill']},
      install: [{source: 'skills/needs-skill', ref: 'v1', sha256: 'b'.repeat(64)}],
    }],
  }), 'utf8');
  const locked = new SubagentProfileRegistry(root);
  const row = summaryOf(locked, 'needs-skill')!;
  assert.equal(row.available, false);
  assert.equal(row.locked, true);
  assert.deepEqual(row.missing, ['needs-skill']);

  // 包已装 + 依赖技能已装 ⇒ 立即可用（状态判定按当前 filesystem）
  writeRolePackages(root, ['needs-skill']);
  writeSkill(root, 'needs-skill');
  const ready = new SubagentProfileRegistry(root);
  assert.equal(summaryOf(ready, 'needs-skill')!.available, true);
  assert.deepEqual(summaryOf(ready, 'needs-skill')!.missing, []);
});

test('静态读取不把未探测的 MCP/二进制误报为可用', (t) => {
  const root = dir(t);
  mkdirSync(join(root, 'subagents'), {recursive: true});
  writeFileSync(join(root, 'subagents', 'profiles.json'), JSON.stringify({
    profiles: [{
      id: 'needs-runtime', label: '运行时依赖', tools: 'readonly', workspace: 'own',
      requires: {mcp: ['browser'], binaries: ['ffmpeg']},
      install: [{source: 'role-packages/needs-runtime', ref: 'v1', sha256: 'c'.repeat(64)}],
    }],
  }), 'utf8');
  writeRolePackages(root, ['needs-runtime']);
  const registry = new SubagentProfileRegistry(root);
  assert.deepEqual(summaryOf(registry, 'needs-runtime')!.missing, ['browser', 'ffmpeg']);
  assert.equal(summaryOf(registry, 'needs-runtime')!.locked, true);
});

test('自定义 profiles.json 覆盖内置；per-id 文件再覆盖；缺文件回退默认', (t) => {
  const root = dir(t);
  mkdirSync(join(root, 'subagents'), {recursive: true});
  writeFileSync(join(root, 'subagents', 'profiles.json'), JSON.stringify({
    profiles: [{id: 'researcher', label: '自定义调研', systemPrompt: '只做自定义调研', tools: ['safe_read', 'report'], workspace: 'none'}],
  }));
  mkdirSync(join(root, 'subagents', 'profiles'), {recursive: true});
  writeFileSync(join(root, 'subagents', 'profiles', 'researcher.json'), JSON.stringify({id: 'researcher', label: '逐文件调研'}));
  const registry = new SubagentProfileRegistry(root);
  assert.equal(registry.get('researcher')?.label, '逐文件调研');
  assert.equal(registry.get('researcher')?.systemPrompt, '只做自定义调研');
  assert.equal(registry.get('researcher')?.workspace, 'none');
  // 未覆盖的 v2 字段仍从内置角色继承
  assert.equal(registry.get('researcher')?.workdir, 'workspace');
  assert.equal(registry.get('researcher')?.reasoningEffort, 'max');
  assert.equal(registry.get('worker')?.label, '开发');
  assert.deepEqual(registry.errors, []);
});

test('旧五件套 id：自定义覆盖可加载但标记 legacy，不映射成新角色', (t) => {
  const root = dir(t);
  writeRolePackages(root, ['worker']);
  mkdirSync(join(root, 'subagents'), {recursive: true});
  writeFileSync(join(root, 'subagents', 'profiles.json'), JSON.stringify({
    profiles: RETIRED_PROFILE_IDS.map((id) => ({id, label: `旧-${id}`, tools: 'readonly', workspace: 'own'})),
  }), 'utf8');
  const registry = new SubagentProfileRegistry(root);
  for (const id of RETIRED_PROFILE_IDS) {
    const profile = registry.get(id);
    assert.notEqual(profile, null, `${id} 覆盖应能加载`);
    assert.equal(profile!.label, `旧-${id}`);
    assert.equal(profile!.legacy, true, `${id} 标记 legacy`);
  }
  // 旧 id 不是新角色：worker 仍然是新的内置角色（coder/design 已随合并删除）
  assert.equal(registry.get('worker')?.label, '开发');
  assert.equal(registry.get('worker')?.legacy, undefined);
  assert.equal(registry.get('coder'), null);
  assert.equal(registry.get('design'), null);
  assert.equal(BUILTIN_PROFILES.some((profile) => profile.id === 'review'), false);
});

test('损坏的 profiles.json 不阻塞，记录错误并使用内置默认', (t) => {
  const root = dir(t);
  mkdirSync(join(root, 'subagents'), {recursive: true});
  writeFileSync(join(root, 'subagents', 'profiles.json'), '{not json', 'utf8');
  const registry = new SubagentProfileRegistry(root);
  assert.equal(registry.get('researcher')?.label, BUILTIN_PROFILES.find((p) => p.id === 'researcher')!.label);
  assert.ok(registry.errors.some((message) => message.includes('JSON 损坏')));
});

test('损坏的 role-packages.json 不阻塞，按未安装处理', (t) => {
  const root = dir(t);
  mkdirSync(join(root, 'subagents'), {recursive: true});
  writeFileSync(join(root, 'subagents', ROLE_PACKAGES_FILE), '{oops', 'utf8');
  const registry = new SubagentProfileRegistry(root);
  assert.ok(registry.errors.some((message) => message.includes(ROLE_PACKAGES_FILE)));
  assert.equal(summaryOf(registry, 'worker')!.locked, true);
});

test('非法 v2 字段：整份拒绝并记录字段名，不拖垮其它 Profile', (t) => {
  const root = dir(t);
  mkdirSync(join(root, 'subagents'), {recursive: true});
  writeFileSync(join(root, 'subagents', 'profiles.json'), JSON.stringify({
    profiles: [
      {id: 'bad-workdir', tools: 'readonly', workspace: 'own', workdir: 'home'},
      {id: 'bad-shell', tools: 'readonly', workspace: 'own', shell: 'bash'},
      {id: 'bad-effort', tools: 'readonly', workspace: 'own', reasoningEffort: 'ultra'},
      {id: 'bad-context', tools: 'readonly', workspace: 'own', contextLimit: 0},
      {id: 'bad-compact-low', tools: 'readonly', workspace: 'own', compactAt: 0.2},
      {id: 'bad-compact-high', tools: 'readonly', workspace: 'own', compactAt: 1.2},
      {id: 'bad-skills', tools: 'readonly', workspace: 'own', skills: ['../escape']},
      {id: 'bad-mcp', tools: 'readonly', workspace: 'own', mcpServers: 'browser'},
      {id: 'bad-install', tools: 'readonly', workspace: 'own', install: [{}]},
      {id: 'good', tools: 'readonly', workspace: 'own', workdir: 'project', shell: 'project',
        skills: ['ok-skill'], mcpServers: ['browser'], reasoningEffort: 'low',
        contextLimit: 2048, compactAt: 0.9,
        requires: {skills: ['ok-skill']},
        install: [{source: 'skills/ok-skill', ref: 'v1', sha256: 'a'.repeat(64)}]},
      {id: 'good-auto', tools: 'readonly', workspace: 'own', workdir: 'auto', shell: 'auto',
        requires: {pythonModules: ['tree_sitter']}},
      {id: 'good-full', tools: 'readonly', workspace: 'own', workdir: 'workspace', shell: 'full'},
    ],
  }), 'utf8');
  const registry = new SubagentProfileRegistry(root);
  for (const id of ['bad-workdir', 'bad-shell', 'bad-effort', 'bad-context', 'bad-compact-low',
    'bad-compact-high', 'bad-skills', 'bad-mcp', 'bad-install']) {
    assert.equal(registry.get(id), null, `${id} 应被拒绝`);
  }
  const errors = registry.errors.join('\n');
  for (const needle of ['workdir', 'shell', 'reasoningEffort', 'contextLimit', 'compactAt', 'skills', 'mcpServers', 'install']) {
    assert.ok(errors.includes(needle), `错误里应提到 ${needle}`);
  }
  const good = registry.get('good')!;
  assert.equal(good.workdir, 'project');
  assert.equal(good.shell, 'project');
  assert.equal(good.reasoningEffort, 'low');
  assert.equal(good.contextLimit, 2048);
  assert.equal(good.compactAt, 0.9);
  assert.deepEqual(good.skills, ['ok-skill']);
  assert.deepEqual(good.mcpServers, ['browser']);
  assert.deepEqual(good.requires, {skills: ['ok-skill']});
  assert.deepEqual(good.install, [{source: 'skills/ok-skill', ref: 'v1', sha256: 'a'.repeat(64)}]);
  // worker 合并后新增的两档：auto/full 合法加载，pythonModules 保留在 requires 里（由 healthcheck 探测）。
  const auto = registry.get('good-auto')!;
  assert.equal(auto.workdir, 'auto');
  assert.equal(auto.shell, 'auto');
  assert.deepEqual(auto.requires?.pythonModules, ['tree_sitter']);
  // `full` 是合法的 Profile 字段值（是否真的生效由执行器按 profileId 判定，非 worker 拿不到 pwsh）。
  assert.equal(registry.get('good-full')?.shell, 'full');
});

test('Profile context files 仅从 profiles/<id>/ 读取，越界被拒绝', (t) => {
  const root = dir(t);
  mkdirSync(join(root, 'subagents', 'profiles', 'researcher'), {recursive: true});
  writeFileSync(join(root, 'subagents', 'profiles', 'researcher', 'notes.md'), '资料正文', 'utf8');
  writeFileSync(join(root, 'secret.txt'), '不该读', 'utf8');
  writeFileSync(join(root, 'subagents', 'profiles', 'researcher.json'), JSON.stringify({
    id: 'researcher', context: {instructions: '先读资料', files: ['notes.md', '../secret.txt']},
  }));
  const registry = new SubagentProfileRegistry(root);
  const text = registry.contextText('researcher');
  assert.match(text, /先读资料/u);
  assert.match(text, /资料正文/u);
  assert.equal(text.includes('不该读'), false);
  assert.ok(registry.errors.some((message) => message.includes('越界')));
});

test('capability 白名单：工具名按分类判，speak/pwsh/未知/递归一律拒绝整份 Profile', (t) => {
  const root = dir(t);
  mkdirSync(join(root, 'subagents'), {recursive: true});
  writeFileSync(join(root, 'subagents', 'profiles.json'), JSON.stringify({
    profiles: [
      {id: 'speak-prof', label: 'speak', tools: ['speak'], workspace: 'own'},
      {id: 'shell-prof', label: 'pwsh', tools: ['pwsh'], workspace: 'own'},
      {id: 'unknown-prof', label: 'unknown', tools: ['write_file_evil'], workspace: 'own'},
      {id: 'recursive-prof', label: 'recursive', tools: ['task'], workspace: 'own'},
      {id: 'none-write', label: 'none+write', tools: ['read', 'write'], workspace: 'none'},
      {id: 'net', label: '联网', tools: ['read', 'network'], workspace: 'own'},
    ],
  }));
  const registry = new SubagentProfileRegistry(root);
  for (const id of ['speak-prof', 'shell-prof', 'unknown-prof', 'recursive-prof', 'none-write']) {
    assert.equal(registry.get(id), null, `${id} 不应被加载`);
  }
  const errors = registry.errors.join('\n');
  for (const needle of ['speak', 'pwsh', 'write_file_evil', 'task', 'workspace']) {
    assert.ok(errors.includes(needle), `应记录：${needle}`);
  }
  // 合法 Profile：capability 展开成内置工具名，report 永远保留
  const net = registry.get('net');
  assert.notEqual(net, null);
  const names = registry.toolNames(net!);
  for (const name of ['safe_read', 'read_blob', 'grep', 'find', 'http_get', 'web_search', 'report']) {
    assert.ok(names.includes(name), `net 应含 ${name}`);
  }
  assert.equal(names.includes('safe_write'), false);
  assert.equal(names.includes('speak'), false);
});

test('capability 展开：tools 省略时 report 仍然保留（唯一对外出口）', (t) => {
  const root = dir(t);
  mkdirSync(join(root, 'subagents'), {recursive: true});
  writeFileSync(join(root, 'subagents', 'profiles.json'), JSON.stringify({
    profiles: [{id: 'empty-tools', label: '空工具', tools: [], workspace: 'own'}],
  }));
  const registry = new SubagentProfileRegistry(root);
  const profile = registry.get('empty-tools')!;
  assert.notEqual(profile, null);
  assert.deepEqual(registry.toolNames(profile), ['report']);
  assert.equal(registry.summaries().find((item) => item.id === 'empty-tools')?.toolCount, 1);
});

test('systemPrompt 超上限：拒绝加载该 Profile；内置覆盖回退出厂定义', (t) => {
  const root = dir(t);
  mkdirSync(join(root, 'subagents'), {recursive: true});
  writeFileSync(join(root, 'subagents', 'profiles.json'), JSON.stringify({
    profiles: [
      {id: 'fat-prompt', label: '超长提示', systemPrompt: 'x'.repeat(MAX_PROFILE_SYSTEM_PROMPT_CHARS + 1), tools: 'readonly', workspace: 'own'},
      {id: 'researcher', label: '覆盖超长', systemPrompt: 'y'.repeat(MAX_PROFILE_SYSTEM_PROMPT_CHARS + 1), tools: 'readonly', workspace: 'own'},
    ],
  }));
  const registry = new SubagentProfileRegistry(root);
  assert.equal(registry.get('fat-prompt'), null, '自定义超长 Profile 不加载');
  assert.equal(registry.get('researcher')?.label, '调研', '内置 Profile 被改坏时回退出厂定义');
  assert.ok(registry.errors.some((message) => message.includes('systemPrompt') && message.includes('超过上限')));
});

test('context 单文件字节超限：拒绝加载该 Profile，不静默截断', (t) => {
  const root = dir(t);
  mkdirSync(join(root, 'subagents', 'profiles', 'bigfile'), {recursive: true});
  writeFileSync(join(root, 'subagents', 'profiles', 'bigfile', 'notes.md'),
    'a'.repeat(MAX_PROFILE_CONTEXT_FILE_BYTES + 1), 'utf8');
  writeFileSync(join(root, 'subagents', 'profiles', 'bigfile.json'), JSON.stringify({
    id: 'bigfile', tools: 'readonly', workspace: 'own', context: {files: ['notes.md']},
  }));
  const registry = new SubagentProfileRegistry(root);
  assert.equal(registry.get('bigfile'), null);
  assert.equal(registry.contextText('bigfile'), '');
  assert.ok(registry.errors.some((message) => message.includes('单文件上限')));
  assert.ok(registry.errors.some((message) => message.includes('已拒绝加载该 Profile')));
});

test('context 总字符超限：拒绝加载该 Profile（多文件合计）', (t) => {
  const root = dir(t);
  mkdirSync(join(root, 'subagents', 'profiles', 'bigtotal'), {recursive: true});
  // 单文件都在字节上限内，合计越过总字符上限
  for (const name of ['a.md', 'b.md', 'c.md']) {
    writeFileSync(join(root, 'subagents', 'profiles', 'bigtotal', name), 'z'.repeat(16_000), 'utf8');
  }
  writeFileSync(join(root, 'subagents', 'profiles', 'bigtotal.json'), JSON.stringify({
    id: 'bigtotal', tools: 'readonly', workspace: 'own', context: {files: ['a.md', 'b.md', 'c.md']},
  }));
  const registry = new SubagentProfileRegistry(root);
  const total = 16_000 * 3 + '\n\n'.length * 2;
  assert.ok(total > MAX_PROFILE_CONTEXT_CHARS);
  assert.equal(registry.get('bigtotal'), null);
  assert.ok(registry.errors.some((message) => message.includes(`上限 ${MAX_PROFILE_CONTEXT_CHARS}`)));
});

test('context 小文件正常装配；缺失文件只记录、不拒绝 Profile', (t) => {
  const root = dir(t);
  mkdirSync(join(root, 'subagents', 'profiles', 'partial'), {recursive: true});
  writeFileSync(join(root, 'subagents', 'profiles', 'partial', 'ok.md'), '可用资料', 'utf8');
  writeFileSync(join(root, 'subagents', 'profiles', 'partial.json'), JSON.stringify({
    id: 'partial', tools: 'readonly', workspace: 'own', context: {instructions: '先读资料', files: ['ok.md', 'missing.md']},
  }));
  const registry = new SubagentProfileRegistry(root);
  assert.notEqual(registry.get('partial'), null, '缺一个文件不该拒绝整份 Profile');
  const text = registry.contextText('partial');
  assert.match(text, /先读资料/u);
  assert.match(text, /可用资料/u);
  assert.ok(registry.errors.some((message) => message.includes('不存在')));
});
