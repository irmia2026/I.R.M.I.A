import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { DepsManager, DepReportEntry } from '../deps/manager.ts';
import {
  extractTodoItems, planTodoWrite, type TodoItem,
} from '../persona/todo-state.ts';

/**
 * 首次安装后的自检单。
 *
 * 这不是第二套安装状态：素材来自安装器写的 `install-profile.json`、`applyInstallProfile`
 * 写回的 bootstrap 结果，以及 `DepsManager.report()` 的实时探测。产物只有两样：
 *   · `workspace/CHECK.md` —— agent 读的检查单；
 *   · `persona/STATE.md` 里一条幂等 Todo —— 提醒它去读，并按约定询问用户。
 */

export const INSTALL_CHECK_FILE = 'CHECK.md';
export const INSTALL_CHECK_TASK_PREFIX = '安装自检：';
const INSTALL_CHECK_TASK =
  '安装自检：读取 workspace/CHECK.md 逐项核对；失败先说明影响并征得用户同意，修复后复验，再销项';

export interface EnsureInstallCheckOptions {
  dataDir: string;
  configPath: string;
  deps: Pick<DepsManager, 'report'>;
  now: () => Date;
  write?: (line: string) => void;
}

export interface EnsureInstallCheckResult {
  found: boolean;
  checkPath: string | null;
  needsAttention: boolean;
  todoAdded: boolean;
  errors: string[];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(temp, text, 'utf8');
  renameSync(temp, path);
}

const DEP_IMPACT: Record<string, string> = {
  pwsh: 'pwsh 工具会回退到 Windows PowerShell 5.1；部分命令与编码行为不同',
  rg: 'rg_search 不会注册，按内容搜索不可用',
  es: 'es_search / find 不会注册，按文件名搜索不可用',
  python: 'python 工具、office 与 codegraph 相关能力受影响',
};

function depLine(entry: DepReportEntry): string {
  const state = entry.ok ? 'ready' : entry.status;
  const impact = (process.platform === 'linux' ? entry.impact : undefined) ?? DEP_IMPACT[entry.name];
  const detail = entry.ok
    ? [entry.version, entry.path, entry.pipVersion === null ? '' : `pip ${entry.pipVersion}`]
      .filter((part) => part !== '').join('；')
    : [entry.reason, `影响：${impact ?? '相关能力不可用'}`]
      .filter((part) => part !== '').join('；');
  return `- ${entry.label}（${entry.name}）：${state}${detail === '' ? '' : `；${detail}`}`;
}

function componentState(selected: boolean, value: unknown): string {
  if (!selected) return '未勾选';
  if (value === 'ready') return 'ready';
  if (value === 'failed') return 'failed';
  if (value === 'skipped') return 'skipped';
  return 'pending';
}

function appendMissingSections(stateText: string, missing: readonly string[]): string {
  const eol = stateText.includes('\r\n') ? '\r\n' : '\n';
  let out = stateText;
  if (!out.endsWith(eol)) out += eol;
  for (const section of missing) out += `${eol}## ${section}${eol}`;
  return out;
}

function ensureTodo(dataDir: string): boolean {
  const statePath = join(dataDir, 'persona', 'STATE.md');
  let stateText = existsSync(statePath)
    ? readFileSync(statePath, 'utf8')
    : '# 当前状态\n\n## 当前任务\n\n## 接着干\n';
  const first = extractTodoItems(stateText);
  if (first.items.some((item) => item.content.startsWith(INSTALL_CHECK_TASK_PREFIX))) return false;
  if (first.missingSections.length > 0) stateText = appendMissingSections(stateText, first.missingSections);

  const parsed = extractTodoItems(stateText);
  const item: TodoItem = { content: INSTALL_CHECK_TASK, status: 'pending' };
  const planned = planTodoWrite(stateText, [...parsed.items, item]);
  if (!planned.ok || !planned.changed) return false;
  atomicWrite(statePath, planned.text);
  return true;
}

/** 生成检查单并确保 Todo 只出现一次；没有安装 profile（开发/测试）时不做任何事。 */
export async function ensureInstallCheck(options: EnsureInstallCheckOptions): Promise<EnsureInstallCheckResult> {
  const profilePath = join(dirname(options.configPath), 'install-profile.json');
  if (!existsSync(profilePath)) {
    return { found: false, checkPath: null, needsAttention: false, todoAdded: false, errors: [] };
  }
  let profile: Record<string, unknown>;
  try {
    profile = record(JSON.parse(readFileSync(profilePath, 'utf8')));
  } catch (error) {
    return {
      found: true, checkPath: null, needsAttention: true, todoAdded: false,
      errors: [`install-profile.json 解析失败：${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const report = await options.deps.report(options.now);
  const components = strings(profile['components']);
  const office = record(profile['office']);
  const bootstrap = record(profile['bootstrap']);
  const officeSelected = components.includes('office');
  const deskhandSelected = components.includes('deskhand');
  const officeState = componentState(officeSelected, bootstrap['office']);
  const deskhandState = componentState(deskhandSelected, bootstrap['deskhand']);
  const componentFailures = [officeState, deskhandState].filter((state) => state === 'failed').length;
  const needsAttention = report.needsAttention || componentFailures > 0 || officeState === 'pending' || deskhandState === 'pending';

  const lines = [
    '# 安装自检',
    '',
    `生成时间：${options.now().toISOString()}`,
    `总体：${needsAttention ? '需要处理' : '全部可用'}`,
    '',
    '## 依赖',
    ...report.entries.map(depLine),
    '',
    '## 组件',
    `- office：${officeState}${officeSelected ? '；影响 Word / Excel / PPT / PDF 能力' : ''}`,
    `- deskhand：${deskhandState}${deskhandSelected ? '；影响电脑操控扩展' : ''}`,
    '',
    '## Agent 处理约定',
    '1. 先按本文件逐项确认；不要把“安装器跑完”当成“能力可用”。',
    '2. 失败项要告诉用户：缺什么、影响什么、建议怎么修；先问是否允许执行修复。',
    '3. 没得到同意时不要安装、不要改 MCP 配置；记录“已告知，待用户决定”。',
    '4. 得到同意后再按现有依赖安装/配置路径处理，修复后重新检查；确认成功才销项。',
    '',
    `检查单路径：${join(options.dataDir, 'workspace', INSTALL_CHECK_FILE)}`,
    '',
  ];
  const checkPath = join(options.dataDir, 'workspace', INSTALL_CHECK_FILE);
  atomicWrite(checkPath, lines.join('\n'));
  let todoAdded = false;
  const errors: string[] = [];
  try {
    todoAdded = ensureTodo(options.dataDir);
  } catch (error) {
    errors.push(`写 Todo 失败：${error instanceof Error ? error.message : String(error)}`);
  }
  for (const line of errors) options.write?.(`[安装自检] ${line}`);
  options.write?.(`[安装自检] 已生成 ${checkPath}；${needsAttention ? '有待处理项' : '全部可用'}`);
  return { found: true, checkPath, needsAttention, todoAdded, errors };
}
