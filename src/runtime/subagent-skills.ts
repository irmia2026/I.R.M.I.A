import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseFrontmatter } from '../skill/skills.ts';
import { errorResult, okResult, type ToolDefinition } from '../tools/types.ts';
import { inside } from './subagent-workspace.ts';

export interface SubagentSkillEntry {
  id: string;
  description: string;
  root: string;
}

export class SubagentSkillRuntime {
  readonly entries: SubagentSkillEntry[];
  readonly missing: string[];
  readonly catalog: string;

  constructor(dataDir: string, profileId: string, whitelist: readonly string[]) {
    const entries: SubagentSkillEntry[] = [];
    const missing: string[] = [];
    for (const id of whitelist) {
      const roots = [
        resolve(dataDir, 'subagents', 'packs', profileId, 'skills', id),
        resolve(dataDir, 'skills', id),
      ];
      const root = roots.find((candidate) => existsSync(resolve(candidate, 'SKILL.md')));
      if (root === undefined) {
        missing.push(id);
        continue;
      }
      const text = readFileSync(resolve(root, 'SKILL.md'), 'utf8');
      const parsed = parseFrontmatter(text);
      if (!parsed.ok || parsed.fields['name'] !== id) {
        missing.push(id);
        continue;
      }
      entries.push({id, description: parsed.fields['description'] ?? '', root: realpathSync.native(root)});
    }
    this.entries = entries;
    this.missing = missing;
    this.catalog = entries.length === 0 ? '' : [
      '[角色技能白名单] 只列当前 Profile 明确允许的技能；正文与 assets 用 skill_read 按需只读，不继承父级技能。',
      ...entries.map((entry) => `- ${entry.id}: ${entry.description}`),
      '读取：skill_read({skill:"<id>",path:"SKILL.md"})；references/scripts/assets 也用同一入口。',
    ].join('\n');
  }

  tool(): ToolDefinition {
    return {
      name: 'skill_read',
      description: '按 Profile 白名单只读技能正文、references、scripts 或 assets；不能修改技能目录。',
      parameters: {
        type: 'object',
        properties: {
          skill: {type: 'string', description: 'catalog 中列出的 skill id'},
          path: {type: 'string', description: '技能内相对路径，默认 SKILL.md'},
          encoding: {type: 'string', enum: ['utf8', 'base64'], description: '文本默认 utf8；二进制资产用 base64'},
        },
        required: ['skill'], additionalProperties: false,
      },
      executionMode: 'parallel', sideEffect: 'none', timeoutMs: 10_000,
      handler: async (args) => {
        const row = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {};
        const id = typeof row['skill'] === 'string' ? row['skill'] : '';
        const entry = this.entries.find((item) => item.id === id);
        if (entry === undefined) return errorResult('这个 skill 不在当前 Profile 的可读白名单中。', 'skill-not-allowed');
        const rel = typeof row['path'] === 'string' && row['path'].trim() !== '' ? row['path'] : 'SKILL.md';
        const path = resolve(entry.root, rel);
        if (!inside(entry.root, path)) return errorResult('技能路径不能越过该 skill 目录。', 'skill-path-denied');
        try {
          const real = realpathSync.native(path);
          if (!inside(entry.root, real) || !statSync(real).isFile()) throw new Error('not-file');
          const bytes = readFileSync(real);
          if (bytes.length > 512 * 1024) return errorResult('技能文件超过 512 KiB 读取上限。', 'skill-too-large');
          return okResult(row['encoding'] === 'base64' ? bytes.toString('base64') : bytes.toString('utf8'));
        } catch {
          return errorResult('技能文件不存在、不是普通文件或无法读取。', 'skill-read-failed');
        }
      },
    };
  }
}
