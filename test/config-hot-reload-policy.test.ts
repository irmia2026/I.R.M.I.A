/**
 * 配置生效口径的**唯一一处** —— `src/config/watcher.ts` 的 `HOT_RELOAD_FIELDS` / `HOT_RELOAD_POLICY`
 *
 * 为什么单开一份用例（REVIEW P1-30）：这句话过去被手抄在五个地方（README、docs/ARCHITECTURE、
 * `config/config.ts`、`log/types.ts`、`web/server.ts`），最后抄成两种相反的结论——四处说
 * "全部字段都要重启（热更白名单是空的）"，而真值一直是 `HOT_RELOAD_FIELDS = ['mcp.servers']`
 * 且**刻意不重建** MCP 常驻索引。现在只剩一处常量，这份用例盯住"常量与名单不许分岔"：
 *   · 名单加了字段而那句口径没跟着改 ⇒ 红（否则又是两份说法）；
 *   · 有人把 `mcp.extraLaunchers` 之类误当成热更字段 ⇒ 红（它不在名单里，`classifyConfigField`
 *     给的是 `unknown`，而"名单外 = 必须重启"）；
 *   · 那句话把"不重建索引"漏掉 ⇒ 红（这正是当年被误读的那半句）。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  HOT_RELOAD_FIELDS,
  HOT_RELOAD_POLICY,
  RESTART_REQUIRED_FIELDS,
  classifyConfigField,
} from '../src/config/watcher.ts';

describe('HOT_RELOAD_FIELDS · 今天的热更名单', () => {
  test('只有 mcp.servers 一项（改这一条 = 改口径，要同批改 README/docs/ARCHITECTURE/那份常量）', () => {
    assert.deepEqual([...HOT_RELOAD_FIELDS], ['mcp.servers']);
  });
});

describe('HOT_RELOAD_POLICY · 那句话必须与名单同源', () => {
  test('名单里的每个字段都在那句话里逐字出现（加了字段而句子没改 ⇒ 红）', () => {
    for (const field of HOT_RELOAD_FIELDS) {
      assert.ok(
        HOT_RELOAD_POLICY.includes(field),
        `HOT_RELOAD_POLICY 里没写热更字段 ${field}：口径与名单分岔了`,
      );
    }
  });

  test('三件事都要说全：热更怎么生效 · 其余要重启 · 刻意不重建索引', () => {
    assert.match(HOT_RELOAD_POLICY, /600ms/u);
    assert.match(HOT_RELOAD_POLICY, /重启/u);
    assert.match(HOT_RELOAD_POLICY, /不重建 MCP 常驻索引/u);
  });

  test('不许再说"白名单是空的 / 全部字段都要重启"（那两句是被推翻的旧口径）', () => {
    assert.equal(/白名单是空的/u.test(HOT_RELOAD_POLICY), false);
    assert.equal(/全部字段都要重启/u.test(HOT_RELOAD_POLICY), false);
  });
});

describe('classifyConfigField · 名单外一律按"要重启"处理', () => {
  test('mcp.servers 是 hot', () => {
    assert.equal(classifyConfigField('mcp.servers'), 'hot');
  });

  test('mcp 的另外三格**不是** hot（放行口/池参数要重启——config.ts 的注释按这个写）', () => {
    for (const field of ['mcp.extraLaunchers', 'mcp.maxInFlight', 'mcp.rssSample']) {
      assert.notEqual(classifyConfigField(field), 'hot', `${field} 不在名单里，却被判成热更`);
    }
  });

  test('预算/心跳/告警/模型端点/destructive 开关也都不是 hot', () => {
    for (const field of [
      'budget.softRatio',
      'wake.heartbeatTargetMeanMin',
      'alerts.webhookUrl',
      'models.heavy.model',
      'tools.destructiveEnabled',
    ]) {
      assert.notEqual(classifyConfigField(field), 'hot', `${field} 不在名单里，却被判成热更`);
    }
  });

  test('显式登记为 restart 的那几格都归 restart', () => {
    for (const field of RESTART_REQUIRED_FIELDS) {
      assert.equal(classifyConfigField(field), 'restart', `${field} 应归 restart`);
    }
  });

  /**
   * 2026-10-21：`models.` 被**显式**登记进 `RESTART_REQUIRED_FIELDS`（用户拍板）。
   *
   * 改的是"分类值"，不是行为：这一族原来落在兜底分支返回 `unknown`，而所有消费点都按
   * `!== 'hot' ⇒ 要重启` 处理（`watcher.ts` 的 `fields.filter(...)`）⇒ **行为一直是对的，
   * 只有分类值不是实话**。显式登记之后界面与回执不必再"把未知当要重启来猜"。
   */
  test('`models.*` 是显式 restart 级（协议回退那一格也在内）', () => {
    for (const field of [
      'models.heavy.model',
      'models.heavy.baseUrl',
      'models.heavy.apiKeyEnv',
      'models.heavy.protocol', // 协议回退：`auto` / `responses` / `chat-completions`
      'models.light.protocol',
      'models.degraded.protocol',
      'models.requestTimeout.requestSilenceMs',
    ]) {
      assert.equal(classifyConfigField(field), 'restart', `${field} 必须如实归 restart（它不是热更字段）`);
    }
  });

  test('`models.` 进了 restart 列 ⇒ 兜底那条 `unknown` 分支**仍然存在**（不是"以后全都算 restart"）', () => {
    for (const field of ['mcp.extraLaunchers', 'budget.softRatio', 'wake.heartbeatFloorMin', 'some.unknown.field']) {
      assert.equal(classifyConfigField(field), 'unknown', `${field} 没有显式登记，就该是 unknown`);
    }
  });
});
