import type { AppEvent } from '../log/types.js';
import type { DsClient, DsReasoningEffort, DsUsage } from '../model/ds-client.js';
import { estimateTokens } from '../tools/registry.ts';
import type { ProfileReasoningEffort } from './subagent-profiles.js';

export const SUBAGENT_RECENT_RAW_TURNS = 2;
export const SUBAGENT_MAX_COMPACTS = 8;
export const SUBAGENT_COMPACT_REQUIRED = 'subagent-compact-required';
export const SUBAGENT_CONTEXT_LIMIT = 'context-limit-exceeded';

export interface SubagentCompactSummary {
  goal: string;
  task: string;
  constraints: string[];
  plan: string;
  progress: string;
  decisions: string[];
  artifacts: Array<{path: string; summary: string}>;
  openQuestions: string[];
  recentTurns: Array<{turn: number; summary: string}>;
  toolResultsIndex: Array<{callId: string; tool: string; seq: number; summary: string}>;
}

export interface SubagentCompactState {
  count: number;
  threshold: number;
  coveredUpToSeq: number;
  atTurn: number;
  atSeq: number;
  promptTokens: number;
  tokenSource: 'provider' | 'estimated';
  summary: SubagentCompactSummary;
}

export interface SubagentContextReading {
  tokens: number;
  source: 'provider' | 'estimated';
}

export function readingForRequest(
  request: {context: {instructions: {tokens: number}; tools: {tokens: number}; input: {tokens: number}}},
  lastProviderInputTokens: number | null,
): SubagentContextReading {
  if (lastProviderInputTokens !== null && Number.isSafeInteger(lastProviderInputTokens) && lastProviderInputTokens >= 0) {
    return {tokens: lastProviderInputTokens, source: 'provider'};
  }
  const tokens = request.context.instructions.tokens + request.context.tools.tokens + request.context.input.tokens;
  return {tokens, source: 'estimated'};
}

export function compactCutoff(
  events: readonly AppEvent[],
  parentCallId: string,
  forkFromSeq: number | undefined,
  previousCoveredUpToSeq: number,
  recentTurns = SUBAGENT_RECENT_RAW_TURNS,
): number | null {
  const ends = events
    .filter((event) => event.parentCallId === parentCallId && event.type === 'turn/end'
      && event.seq > (forkFromSeq ?? 0) && event.seq > previousCoveredUpToSeq)
    .map((event) => event.seq)
    .sort((a, b) => a - b);
  const keep = Math.max(1, Math.trunc(recentTurns));
  if (ends.length <= keep) return null;
  return ends[ends.length - keep - 1] ?? null;
}

export function summaryText(summary: SubagentCompactSummary): string {
  return `[子代理结构化上下文摘要]\n${JSON.stringify(summary, null, 2)}`;
}

export function parseCompactSummary(value: unknown): SubagentCompactSummary {
  if (!isRecord(value)) throw new Error('compact-summary-invalid');
  const summary: SubagentCompactSummary = {
    goal: requiredText(value['goal']),
    task: requiredText(value['task']),
    constraints: stringList(value['constraints']),
    plan: requiredText(value['plan']),
    progress: requiredText(value['progress']),
    decisions: stringList(value['decisions']),
    artifacts: artifactList(value['artifacts']),
    openQuestions: stringList(value['openQuestions']),
    recentTurns: recentTurnList(value['recentTurns']),
    toolResultsIndex: toolResultList(value['toolResultsIndex']),
  };
  if (summaryText(summary).length > 128_000) throw new Error('compact-summary-too-large');
  return summary;
}

export async function generateCompactSummary(input: {
  ds: DsClient;
  session: {task: string; context: string; turn: number};
  events: readonly AppEvent[];
  parentCallId: string;
  forkFromSeq?: number | undefined;
  previous?: SubagentCompactState | undefined;
  effort: ProfileReasoningEffort;
  signal?: AbortSignal | undefined;
}): Promise<{summary: SubagentCompactSummary; usage: DsUsage; usageMissing: boolean; model: string; protocol?: string}> {
  const relevant = input.events.filter((event) => event.parentCallId === input.parentCallId
    && event.seq > (input.forkFromSeq ?? 0)
    && event.seq > (input.previous?.coveredUpToSeq ?? 0)
    && event.type !== 'budget/consumed');
  const transcript = relevant.map((event) => JSON.stringify({
    seq: event.seq, type: event.type, data: event.data,
  })).join('\n');
  if (estimateTokens(transcript) > 900_000) throw new Error('compact-input-too-large');
  const prompt = [
    `目标任务的原始描述：\n${input.session.task}`,
    input.session.context === '' ? '' : `补充材料：\n${input.session.context}`,
    input.previous === undefined ? '' : `上一份结构化摘要：\n${JSON.stringify(input.previous.summary)}`,
    `需要压缩的子代理事件（原始事件仍保存在日志中）：\n${transcript}`,
    '只根据这些事实生成摘要。recentTurns 记录最近轮次；toolResultsIndex 用 seq/callId 指向原始工具结果，'
      + '不要复制完整工具输出。artifacts.path 必须是相对路径。所有字段都必须出现，未知用空字符串或空数组。',
  ].filter((part) => part !== '').join('\n\n');
  const response = await input.ds.generate({
    lane: 'heavy',
    input: [{type: 'message', role: 'user', content: prompt}],
    instructions: '你是子代理上下文压缩器。输出严格符合 schema 的 JSON，保留目标、约束、决定、产物索引和未解决问题。',
    reasoning: {effort: input.effort as DsReasoningEffort},
    maxOutputTokens: 16_384,
    text: {type: 'json_schema', name: 'subagent_compact', schema: COMPACT_SCHEMA},
    ...(input.signal === undefined ? {} : {signal: input.signal}),
  });
  if (response.status !== 'completed') throw new Error(`compact-model-${response.status}`);
  const text = response.outputItems.filter((item) => item.type === 'message').map((item) => item.text).join('').trim();
  if (text === '') throw new Error('compact-summary-empty');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('compact-summary-json');
  }
  return {
    summary: parseCompactSummary(parsed),
    usage: response.usage,
    usageMissing: response.usageMissing === true,
    model: response.model,
    ...(response.protocol === undefined ? {} : {protocol: response.protocol}),
  };
}

const COMPACT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    goal: {type: 'string'}, task: {type: 'string'},
    constraints: {type: 'array', items: {type: 'string'}},
    plan: {type: 'string'}, progress: {type: 'string'},
    decisions: {type: 'array', items: {type: 'string'}},
    artifacts: {type: 'array', items: {type: 'object', properties: {
      path: {type: 'string'}, summary: {type: 'string'},
    }, required: ['path', 'summary'], additionalProperties: false}},
    openQuestions: {type: 'array', items: {type: 'string'}},
    recentTurns: {type: 'array', items: {type: 'object', properties: {
      turn: {type: 'integer'}, summary: {type: 'string'},
    }, required: ['turn', 'summary'], additionalProperties: false}},
    toolResultsIndex: {type: 'array', items: {type: 'object', properties: {
      callId: {type: 'string'}, tool: {type: 'string'}, seq: {type: 'integer'}, summary: {type: 'string'},
    }, required: ['callId', 'tool', 'seq', 'summary'], additionalProperties: false}},
  },
  required: ['goal', 'task', 'constraints', 'plan', 'progress', 'decisions', 'artifacts', 'openQuestions', 'recentTurns', 'toolResultsIndex'],
  additionalProperties: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32_000) throw new Error('compact-summary-invalid');
  return value;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('compact-summary-invalid');
  return value.map((item) => requiredText(item));
}

function artifactList(value: unknown): SubagentCompactSummary['artifacts'] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('compact-summary-invalid');
  return value.map((item) => {
    if (!isRecord(item)) throw new Error('compact-summary-invalid');
    const path = requiredText(item['path']);
    if (path.includes('\0') || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/u.test(path) || path.includes('..')) {
      throw new Error('compact-summary-path');
    }
    return {path, summary: requiredText(item['summary'])};
  });
}

function recentTurnList(value: unknown): SubagentCompactSummary['recentTurns'] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('compact-summary-invalid');
  return value.map((item) => {
    if (!isRecord(item) || !Number.isSafeInteger(item['turn']) || Number(item['turn']) < 0) {
      throw new Error('compact-summary-invalid');
    }
    return {turn: Number(item['turn']), summary: requiredText(item['summary'])};
  });
}

function toolResultList(value: unknown): SubagentCompactSummary['toolResultsIndex'] {
  if (!Array.isArray(value) || value.length > 500) throw new Error('compact-summary-invalid');
  return value.map((item) => {
    if (!isRecord(item) || !Number.isSafeInteger(item['seq']) || Number(item['seq']) < 0) {
      throw new Error('compact-summary-invalid');
    }
    return {
      callId: requiredText(item['callId']), tool: requiredText(item['tool']),
      seq: Number(item['seq']), summary: requiredText(item['summary']),
    };
  });
}
