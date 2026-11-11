import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { buildPluginContract, CONTRACT_ROOT, syncPluginContract } from '../scripts/plugin-contract.mjs';
import { readAgentVersion } from '../scripts/create-plugin.mjs';

test('插件契约快照与当前源码、文档和 SDK 文件一致', async () => {
  const contract = await buildPluginContract();
  assert.equal(contract.hostVersion, readAgentVersion());
  assert.equal(contract.permissions.length, 14);
  assert.equal(contract.hooks.length, 17);
  assert.equal(new Set(contract.permissions.map((item) => item.permission)).size, 14);
  assert.equal(new Set(contract.hooks.map((item) => item.point)).size, 17);
  assert.equal(contract.hooks.find((item) => item.point === 'command.before')?.allowAbort, true);
  assert.equal(contract.hooks.filter((item) => item.allowAbort).length, 1);

  const snapshot = JSON.parse(readFileSync(join(CONTRACT_ROOT, 'sdk', 'contract.json'), 'utf8'));
  assert.deepEqual(snapshot, contract);
  const synchronized = await syncPluginContract({ check: true });
  assert.deepEqual(synchronized.changed, []);
});

test('清单 Schema 提供真实的基础约束，且不冒充完整运行时校验', async () => {
  const schema = JSON.parse(readFileSync(join(CONTRACT_ROOT, 'sdk', 'plugin-manifest.schema.json'), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['apiVersion', 'id', 'version', 'engine', 'permissions']);
  assert.deepEqual(schema.properties.runtime.properties.type.enum, ['node', 'python', 'declarative']);
  assert.deepEqual(schema.allOf[1].then.properties.permissions.items.enum, (await buildPluginContract()).permissions.map((item) => item.permission));

  const id = new RegExp(schema.properties.id.pattern);
  assert.equal(id.test('hello-tool'), true);
  assert.equal(id.test('Bad Id'), false);
  const version = new RegExp(schema.properties.version.pattern);
  assert.equal(version.test('0.1.0-beta.15'), true);
  assert.equal(version.test('1.0.0-01'), false);
  assert.equal(version.test('1.0.0+build'), false);
  const relative = new RegExp(schema.properties.runtime.properties.entry.pattern);
  assert.equal(relative.test('main.ts'), true);
  assert.equal(relative.test('../outside.ts'), false);
  assert.equal(relative.test('C:\\main.ts'), false);
  const sdkPackage = JSON.parse(readFileSync(join(CONTRACT_ROOT, 'sdk', 'node', 'package.json'), 'utf8'));
  assert.equal(sdkPackage.version, (await buildPluginContract()).hostVersion);
});
