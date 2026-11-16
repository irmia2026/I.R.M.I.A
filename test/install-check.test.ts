import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  ensureInstallCheck, INSTALL_CHECK_TASK_PREFIX,
} from '../src/runtime/install-check.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

test('安装自检：生成 CHECK.md 并幂等写入一条 Todo', async () => {
  const root = tempDirSync('irmia-install-check-');
  mkdirSync(join(root, 'persona'), { recursive: true });
  writeFileSync(join(root, 'config.json'), '{"schemaVersion":1}\n', 'utf8');
  writeFileSync(join(root, 'install-profile.json'), JSON.stringify({
    schema: 1, product: 'irmia-agent',
    components: ['core', 'deps', 'office'],
    office: { installOnFirstRun: true },
    bootstrap: { office: 'failed', deskhand: 'skipped', errors: ['openpyxl import failed'] },
  }), 'utf8');
  writeFileSync(join(root, 'persona', 'STATE.md'), [
    '# 当前状态', '', '## 当前任务', '- [~] 在忙', '', '## 接着干', '- [ ] 旧任务', '',
  ].join('\n'), 'utf8');
  const report = {
    needsAttention: true,
    toolsDir: join(root, 'tools'),
    entries: [{
      name: 'python', label: 'Python', status: 'missing', ok: false,
      version: '', path: '', source: null, dir: null,
      reason: 'not found', pipVersion: null, pipReason: '',
    }],
  };
  const calls: string[] = [];
  const options = {
    dataDir: root,
    configPath: join(root, 'config.json'),
    deps: { report: async () => report },
    now: () => new Date('2026-11-15T00:00:00.000Z'),
    write: (line: string) => calls.push(line),
  } as never;

  const first = await ensureInstallCheck(options);
  assert.equal(first.found, true);
  assert.equal(first.needsAttention, true);
  assert.equal(first.todoAdded, true);
  const check = readFileSync(join(root, 'workspace', 'CHECK.md'), 'utf8');
  assert.match(check, /office：failed/u);
  assert.match(check, /Python.*missing/u);
  assert.match(check, /影响：python 工具/u);
  assert.match(check, /先问是否允许执行修复/u);

  const state = readFileSync(join(root, 'persona', 'STATE.md'), 'utf8');
  assert.equal(state.split(INSTALL_CHECK_TASK_PREFIX).length - 1, 1);
  assert.match(state, /## 当前任务\n- \[~\] 在忙/u, '现有任务必须保留');
  assert.match(state, /## 接着干\n- \[ \] 旧任务/u, '旧清单必须保留');

  const second = await ensureInstallCheck(options);
  assert.equal(second.todoAdded, false, '重启不能重复加自检 Todo');
  assert.equal(
    readFileSync(join(root, 'persona', 'STATE.md'), 'utf8').split(INSTALL_CHECK_TASK_PREFIX).length - 1,
    1,
  );
});

test('没有 install-profile 的开发/测试装配不生成检查单', async () => {
  const root = tempDirSync('irmia-install-check-none-');
  const result = await ensureInstallCheck({
    dataDir: root,
    configPath: join(root, 'config.json'),
    deps: { report: async () => ({ needsAttention: false, toolsDir: root, entries: [] }) },
    now: () => new Date(),
  } as never);
  assert.equal(result.found, false);
  assert.equal(result.checkPath, null);
});
