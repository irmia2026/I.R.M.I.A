/**
 * 工具分组与开关测试 — src/tools/groups.ts + ToolRegistry 的禁用语义
 *
 * 两条断言线：
 *   • **分组**只有一个维度：内置归一组，MCP 按服务各自成组（组名就是服务名）。名字里写着来源，
 *     所以不需要维护一张「哪件工具属于哪一类」的表。
 *   • **开关**的语义是「从她眼前拿掉」：关掉的工具不进模型清单，但注册表仍知道它存在
 *     （界面要显示一件工具存在但关着），且名单外的名字不会让装配报错。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ToolRegistry } from '../src/tools/registry.ts';
import {
  BUILTIN_GROUP_ID, groupIdOfTool, groupsForTools, mcpGroupId, mcpServerOfTool,
} from '../src/tools/groups.ts';
import type { ToolDefinition } from '../src/tools/types.js';

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `演示工具 ${name}`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    executionMode: 'parallel',
    sideEffect: 'none',
    timeoutMs: 1_000,
    handler: async () => ({ status: 'ok', content: '' }),
  } as unknown as ToolDefinition;
}

describe('工具分组 · 来源', () => {
  test('内置工具归一组', () => {
    assert.equal(groupIdOfTool('read_file'), BUILTIN_GROUP_ID);
    // 名字里带下划线的内置工具照旧归内置组：分组只看 `mcp__` 前缀，不看名字形状
    assert.equal(groupIdOfTool('safe_read'), BUILTIN_GROUP_ID);
  });

  test('MCP 工具按服务分组，组名就是服务名', () => {
    assert.equal(mcpServerOfTool('mcp__anysearch__search'), 'anysearch');
    assert.equal(groupIdOfTool('mcp__anysearch__search'), mcpGroupId('anysearch'));
    assert.equal(groupIdOfTool('mcp__other__ping'), mcpGroupId('other'));
    assert.notEqual(groupIdOfTool('mcp__anysearch__search'), groupIdOfTool('mcp__other__ping'));
  });

  test('不是 MCP 或名字畸形的都当内置（不抛错，界面就别扭一下而已）', () => {
    assert.equal(mcpServerOfTool('read_file'), null);
    assert.equal(mcpServerOfTool('mcp__'), null);
    assert.equal(mcpServerOfTool('mcp__noseparator'), null);
    assert.equal(groupIdOfTool('mcp__'), BUILTIN_GROUP_ID);
  });

  test('聚合分组：内置在前，MCP 按首次出现顺序，没有的组不空摆', () => {
    const groups = groupsForTools(['read_file', 'mcp__b__x', 'safe_edit', 'mcp__a__y', 'mcp__b__z']);
    assert.deepEqual(groups.map((g) => g.id), [BUILTIN_GROUP_ID, mcpGroupId('b'), mcpGroupId('a')]);
    assert.equal(groups[0]?.label, '内置工具');
    assert.equal(groups[1]?.label, 'b');
    assert.deepEqual(groupsForTools([]), []);
    // 只有 MCP 工具时不该凭空多一个「内置工具」组
    assert.deepEqual(groupsForTools(['mcp__a__y']).map((g) => g.id), [mcpGroupId('a')]);
  });
});

describe('工具开关 · 从她眼前拿掉', () => {
  function registry(): ToolRegistry {
    const reg = new ToolRegistry();
    for (const name of ['read_file', 'safe_edit', 'http_download']) reg.register(tool(name));
    return reg;
  }

  test('关掉的工具不进模型清单，但注册表仍知道它存在', () => {
    const reg = registry();
    reg.setDisabled(['http_download']);
    assert.deepEqual(reg.listForModel().map((spec) => spec.name), ['read_file', 'safe_edit']);
    assert.ok(reg.names().includes('http_download'), '界面要列得出来，才能显示为关闭态');
    assert.ok(reg.get('http_download') !== null, '执行到半路时才给得出「已关闭」而不是「未知工具」');
    assert.equal(reg.isDisabled('http_download'), true);
    assert.deepEqual(reg.disabledNames(), ['http_download']);
  });

  test('重新装载名单是整体替换（界面算出来的就是全量）', () => {
    const reg = registry();
    reg.setDisabled(['http_download']);
    reg.setDisabled(['safe_edit']);
    assert.equal(reg.isDisabled('http_download'), false);
    assert.equal(reg.isDisabled('safe_edit'), true);
    reg.setDisabled([]);
    assert.deepEqual(reg.disabledNames(), []);
  });

  test('名单里留着不存在的工具名不报错（版本回退、MCP 未连都会出现）', () => {
    const reg = registry();
    reg.setDisabled(['http_download', 'mcp__gone__search', 'never_existed']);
    assert.deepEqual(reg.disabledNames(), ['http_download']);
  });

  test('全关掉时模型清单为空——这是合法状态，不是错误', () => {
    const reg = registry();
    reg.setDisabled(['read_file', 'safe_edit', 'http_download']);
    assert.deepEqual(reg.listForModel(), []);
    assert.equal(reg.size, 3);
  });
});
