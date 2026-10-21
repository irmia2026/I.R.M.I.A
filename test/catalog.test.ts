/**
 * 默认工具集装配测试 — src/tools/catalog.ts
 *
 * 这个模块只为一件事存在：**工具清单是 render 的输入**，所以运行期（main.ts）与事后重建
 * （CLI 的 replay / doctor）必须拿到同一份清单。测试因此盯两件事：
 *   1. 视角语义与真实循环一致（默认不列破坏性工具，§4.10 第三级门）；
 *   2. 单件工具注册失败（描述 token 超预算 §4.18 等）**跳过并报告**，不让整机起不来，
 *      也绝不静默——静默少一件能力比启动失败更难查。
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { buildCatalogRegistry, catalogToolSpecs, type CatalogRegistryResult } from '../src/tools/catalog.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

function makeDir(t: TestContext): string {
  const dir = tempDirSync('irmia-catalog-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 与 CLI 只读场景同构：不布防定时器、不写事件、模型通道未接线 */
function offlineRegistry(dir: string): Promise<CatalogRegistryResult> {
  return buildCatalogRegistry({
    dataDir: dir,
    timers: new TimerStore(join(dir, 'timers.json')),
    emit: () => undefined,
  });
}

test('catalog：默认视角与真实循环一致——不列破坏性工具，只读工具齐全', async (t) => {
  const dir = makeDir(t);
  const { registry } = await offlineRegistry(dir);
  const specs = registry.listForModel({});

  assert.ok(specs.length >= 10, `默认清单应至少有 10 件工具，实际 ${specs.length}`);
  assert.ok(specs.some((spec) => spec.name === 'safe_read'), 'fs 工具应在列');
  assert.ok(specs.some((spec) => spec.name === 'timer'), 'admin 工具应在列');

  // 默认视角一件破坏性工具都不列（安全默认，§4.10）：用 sideEffect 判定而不是猜工具名
  for (const spec of specs) {
    assert.notEqual(
      registry.get(spec.name)?.sideEffect,
      'destructive',
      `${spec.name} 是破坏性工具，不该出现在默认视角里`,
    );
  }

  // 每件工具都必须带上完整定义（重建请求体靠的就是它）
  for (const spec of specs) {
    assert.ok(spec.description.length > 0, `${spec.name} 缺描述`);
    assert.equal(typeof spec.parameters, 'object');
  }
});

test('catalog：切到 includeDestructive 后破坏性工具出现在列（视角可重建）', async (t) => {
  const dir = makeDir(t);
  const { registry } = await offlineRegistry(dir);
  const defaultSpecs = registry.listForModel({});
  const allSpecs = registry.listForModel({ includeDestructive: true });

  assert.ok(allSpecs.length > defaultSpecs.length, '开启后必须多出破坏性工具');
  assert.equal(allSpecs.some((spec) => spec.name === 'write_persona'), true);
  assert.equal(registry.get('write_persona')?.sideEffect, 'destructive');
});

test('catalog：单件工具注册失败被跳过并如实报告，其余工具照常可用', async (t) => {
  const dir = makeDir(t);
  const { registry, problems } = await offlineRegistry(dir);
  const specs = registry.listForModel({});

  assert.ok(specs.length > 0, '单件失败不该导致整套清单为空');

  // 报告出来的名字必须确实不在清单里（报了却还在 = 报告是假的）。
  // 不断言 problems 非空：描述预算随文案变化，它空着也可能是好事。
  const names = new Set(specs.map((spec) => spec.name));
  for (const problem of problems) {
    assert.equal(names.has(problem.split('：')[0]!), false, `${problem} 报告失败却仍出现在清单里`);
  }
});

test('catalog：catalogToolSpecs 就是"清单 + 报告"的便捷封装（replay 用的那条路径）', async (t) => {
  const dir = makeDir(t);
  const direct = await offlineRegistry(dir);
  const viaHelper = await catalogToolSpecs(dir);

  assert.deepEqual(
    viaHelper.specs.map((spec) => spec.name),
    direct.registry.listForModel({}).map((spec) => spec.name),
    '便捷封装与手工装配必须给出同一份清单（顺序也是清单语义的一部分）',
  );
  assert.deepEqual(viaHelper.problems, direct.problems);
});
