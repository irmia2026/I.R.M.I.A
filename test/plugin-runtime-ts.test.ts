/**
 * 插件平台 P1a · TypeScript 入口 e2e
 *
 * 钉一件事：`.ts` 入口**不需要编译**就能跑（`node --experimental-strip-types`），
 * 而它注册的工具照旧能进宿主注册表并被调用。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createHarness } from './helpers/plugin-runtime-harness.ts';

test('ts 插件：.ts 入口直接加载并注册工具', async (t) => {
  const harness = await createHarness({ fixture: 'plugin-ts' });
  t.after(async () => { await harness.dispose(); });
  await harness.start();
  assert.equal(harness.tools.has('demo-ts__echo'), true);
  const result = await harness.callTool('demo-ts__echo', { text: '你好' });
  assert.deepEqual(result, { content: 'ts:你好' });
  assert.equal(harness.host.status('demo-ts', harness.pkg.contentHash).state, 'running');
});
