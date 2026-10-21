/**
 * 切通道的**写盘纪律**（`src/update/channel-write.ts`）——纯函数那一半。
 *
 * 这条端点写的是用户的 `config.json`，所以要验的四件事都在这里：
 *   · 只改 `update.channel` 这一格（其余键逐字不动）；
 *   · 非法值直接拒绝（**不回退默认**）；
 *   · 值本来相同 ⇒ 不写（文件 sha256 不变，由 `test/update-web.test.ts` 的接口级用例证明）；
 *   · **回读对拍**：`loadConfig` 的值 / 盘上回读的值 / "别处没被改" 三条任一不过 ⇒ 一句话点名。
 *
 * "回读不一致"在真机上几乎造不出来（这一格只认两个字面量），所以用纯函数把那条判据
 * 单独钉住；接口级用例负责验"失败 ⇒ 400 + 回滚到原样"。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyUpdateChannelToDoc,
  isUpdateChannel,
  readSavedUpdateChannel,
  sameConfigDocExceptChannel,
  verifyUpdateChannelWrite,
} from '../src/update/channel-write.ts';

const doc = (): Record<string, unknown> => ({
  $comment: ['手写注释'],
  schemaVersion: 1,
  budget: { softRatio: 0.8 },
  update: { channel: 'beta', enabled: true, endpoint: 'https://irmia.me/releases/latest.json' },
});

describe('isUpdateChannel / readSavedUpdateChannel', () => {
  test('只认 beta / stable（大小写、空格、别的词都不认）', () => {
    assert.equal(isUpdateChannel('beta'), true);
    assert.equal(isUpdateChannel('stable'), true);
    assert.equal(isUpdateChannel('Beta'), false);
    assert.equal(isUpdateChannel(' beta'), false);
    assert.equal(isUpdateChannel('rc'), false);
    assert.equal(isUpdateChannel(null), false);
  });

  test('读盘上那一格：没有 update / 不是对象 / 非法值 ⇒ null', () => {
    assert.equal(readSavedUpdateChannel({}), null);
    assert.equal(readSavedUpdateChannel({ update: 'beta' }), null);
    assert.equal(readSavedUpdateChannel({ update: { channel: 'x' } }), null);
    assert.equal(readSavedUpdateChannel({ update: { channel: 'stable' } }), 'stable');
  });
});

describe('applyUpdateChannelToDoc：只碰这一格', () => {
  test('合法且不同 ⇒ 只改 update.channel，其余原样', () => {
    const target = doc();
    const before = JSON.parse(JSON.stringify(target)) as Record<string, unknown>;
    const result = applyUpdateChannelToDoc(target, 'stable');
    assert.deepEqual([result.changed, result.problem], [true, null]);
    assert.equal((target['update'] as Record<string, unknown>)['channel'], 'stable');
    assert.equal((target['update'] as Record<string, unknown>)['enabled'], true, 'update 里的别的字段不动');
    assert.deepEqual(target['budget'], before['budget']);
    assert.deepEqual(target['$comment'], before['$comment']);
    assert.equal(sameConfigDocExceptChannel(before, target), true, '除这一格外逐字相同');
  });

  test('值本来相同 ⇒ changed:false（调用方据此不写盘）', () => {
    const target = doc();
    const text = JSON.stringify(target);
    const result = applyUpdateChannelToDoc(target, 'beta');
    assert.deepEqual([result.changed, result.problem], [false, null]);
    assert.equal(JSON.stringify(target), text, '一个字节都没动');
  });

  test('非法值 ⇒ problem，且不改文档（不回退默认）', () => {
    const target = doc();
    const result = applyUpdateChannelToDoc(target, 'rc');
    assert.equal(result.changed, false);
    assert.match(String(result.problem), /beta.*stable/u);
    assert.equal((target['update'] as Record<string, unknown>)['channel'], 'beta');
  });

  test('update 存在但不是对象 ⇒ 拒绝（不猜、不覆盖手工写坏的一段）', () => {
    const result = applyUpdateChannelToDoc({ update: 'beta' }, 'stable');
    assert.equal(result.changed, false);
    assert.match(String(result.problem), /update 必须是对象/u);
  });

  test('没有 update 段 ⇒ 合法地补一段（缺省配置的形状）', () => {
    const target: Record<string, unknown> = { schemaVersion: 1 };
    const result = applyUpdateChannelToDoc(target, 'stable');
    assert.equal(result.changed, true);
    assert.deepEqual(target['update'], { channel: 'stable' });
  });
});

describe('verifyUpdateChannelWrite：三条对拍', () => {
  test('全部对上 ⇒ null（放行）', () => {
    const before = doc();
    const after = doc();
    (after['update'] as Record<string, unknown>)['channel'] = 'stable';
    assert.equal(verifyUpdateChannelWrite({
      before,
      readBack: after,
      reloadedChannel: 'stable',
      requested: 'stable',
    }), null);
  });

  test('loadConfig 解析值不对 ⇒ 点名"解析后是 X"', () => {
    const before = doc();
    const after = doc();
    (after['update'] as Record<string, unknown>)['channel'] = 'stable';
    const problem = verifyUpdateChannelWrite({
      before,
      readBack: after,
      reloadedChannel: 'beta',
      requested: 'stable',
    });
    assert.match(String(problem), /解析后是 beta/u);
    assert.match(String(problem), /期望 stable/u);
    assert.match(String(problem), /回滚/u);
  });

  test('盘上回读值不对 ⇒ 点名"回读是 X"', () => {
    const before = doc();
    const problem = verifyUpdateChannelWrite({
      before,
      readBack: doc(), // 回读还是 beta
      reloadedChannel: 'stable',
      requested: 'stable',
    });
    assert.match(String(problem), /回读是 beta/u);
    assert.match(String(problem), /回滚/u);
  });

  test('改到了 update.channel 之外的字段 ⇒ 拒绝并点名', () => {
    const before = doc();
    const after = doc();
    (after['update'] as Record<string, unknown>)['channel'] = 'stable';
    (after['budget'] as Record<string, unknown>)['softRatio'] = 0.5; // 越权改动
    const problem = verifyUpdateChannelWrite({
      before,
      readBack: after,
      reloadedChannel: 'stable',
      requested: 'stable',
    });
    assert.match(String(problem), /之外的字段/u);
  });

  test('键序不同不算改动（canonical 比较；写盘的顺序本来就可能变）', () => {
    const before = { schemaVersion: 1, update: { channel: 'beta', enabled: true } };
    const after = { update: { enabled: true, channel: 'stable' }, schemaVersion: 1 };
    assert.equal(sameConfigDocExceptChannel(before, after), true);
  });
});
