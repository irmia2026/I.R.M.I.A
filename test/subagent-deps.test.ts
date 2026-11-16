import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GIT_MIRROR_URL,
  SUBAGENT_PYTHON_PACKAGES,
  installSubagentDependencies,
} from '../src/runtime/subagent-deps.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

test('子代理依赖映射：tree_sitter 模块名映射到 PyPI 包名', () => {
  assert.equal(SUBAGENT_PYTHON_PACKAGES['tree_sitter'], 'tree-sitter');
  assert.equal(SUBAGENT_PYTHON_PACKAGES['tree_sitter_javascript'], 'tree-sitter-javascript');
  assert.equal(SUBAGENT_PYTHON_PACKAGES['tree_sitter_cpp'], 'tree-sitter-cpp');
  assert.match(GIT_MIRROR_URL, /^https:\/\/mirrors\.huaweicloud\.com\/git-for-windows\//u);
});

test('没有依赖要求时安装步骤是 no-op', async () => {
  const root = tempDirSync('irmia-subagent-deps-');
  const result = await installSubagentDependencies(undefined, root);
  assert.equal(result.ok, true);
  assert.equal(result.git, 'ready');
  assert.equal(result.python, 'ready');
  assert.deepEqual(result.details, []);
});
