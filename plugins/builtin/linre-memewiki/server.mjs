import { readConfig } from './lib/config.mjs';
import { createMemeDb } from './lib/db.mjs';
import { resolvePluginDataDir } from './lib/paths.mjs';
import { submitFeedback } from './lib/sync.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const pluginDataDir = resolvePluginDataDir();
const db = createMemeDb({ pluginDataDir });

const USAGE_RULES = [
  '【接梗规则】',
  '1. 先自然接梗、别主动科普：顺着「怎么用 / 怎么接」回一句，像本来就会；',
  '2. 只有对方明确问「这是什么梗 / 什么意思」才用一两句解释出处，不要念完整词条；',
  '3. 查不到就说不知道，不要硬编或把不相干的梗拼到一起；',
  '4. 用户纠正你或教你新梗时，先自然接住，再问对方要不要提交到梗维基，得到明确同意才调用 feedback_meme。',
].join('\n');

const TOOLS = [
  {
    name: 'lookup_meme',
    description: '查询本地梗百科（6792+ 热梗、黑话、缩写）。支持精确、别名、前缀与模糊搜索。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的梗名、别名、黑话或关键词' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: '最多返回几条结果，默认 5' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'random_meme',
    description: '从本地梗百科随机抽取 1-5 条热梗词条，可按标签过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: '可选标签过滤，例如 动物梗、二游、谐音梗' },
        count: { type: 'integer', minimum: 1, maximum: 5, description: '抽取条数（1-5），默认 1' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'feedback_meme',
    description: '向 cnmeme.wiki 提交词条纠正或新梗投稿，并默认同步写入本地可写词库。只在用户明确同意后调用。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '梗名/词条标题' },
        content: { type: 'string', description: '纠正或新增的正文/用法说明' },
        requestType: { type: 'string', enum: ['edit', 'create'], description: '提交类型：edit 或 create' },
        saveLocal: { type: 'boolean', description: '是否同时写入本地可写词库，默认 true' },
      },
      required: ['title', 'content'],
      additionalProperties: false,
    },
  },
];

function clip(text, maxLen) {
  const clean = String(text ?? '').replace(/\s+/gu, ' ').trim();
  const chars = [...clean];
  return chars.length > maxLen ? `${chars.slice(0, maxLen).join('')}…` : clean;
}

function formatEntry(row) {
  const lines = [`「${row.title}」`];
  if (row.aliases) lines.push(`别名：${clip(row.aliases, 120)}`);
  if (row.tags) lines.push(`标签：${clip(row.tags, 120)}`);
  if (row.usage) lines.push(`怎么用 / 怎么接：${clip(row.usage, 500)}`);
  if (row.summary) lines.push(`释义：${clip(row.summary, 400)}`);
  if (row.origin) lines.push(`出处：${clip(row.origin, 400)}`);
  if (row.other) lines.push(`补充：${clip(row.other, 240)}`);
  return lines.join('\n');
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function handleLookupMeme(args) {
  const query = String(args?.query || '').trim();
  if (!query) return textResult('请提供要查询的梗名或关键词（query）。', true);
  const limit = Math.max(1, Math.min(10, Math.trunc(Number(args?.limit) || 5)));
  const hits = db.searchMemes(query, { limit });
  if (hits.length === 0) {
    return textResult(`本地梗百科未收录「${query}」。不要硬猜或编造解释，直接说不知道或反问一句即可。`);
  }
  const body = hits.map((row, idx) => `[${idx + 1}] ${formatEntry(row)}`).join('\n\n');
  return textResult(`${USAGE_RULES}\n\n${body}`);
}

function handleRandomMeme(args) {
  const tag = String(args?.tag || '').trim();
  const count = Math.max(1, Math.min(5, Math.trunc(Number(args?.count) || 1)));
  const rows = db.randomMemes({ tag, count });
  if (rows.length === 0) {
    return textResult(tag ? `没有找到标签包含「${tag}」的词条。` : '本地词库为空。');
  }
  return textResult(rows.map((row, idx) => `[${idx + 1}] ${formatEntry(row)}`).join('\n\n'));
}

async function handleFeedbackMeme(args) {
  const title = String(args?.title || '').trim();
  const content = String(args?.content || '').trim();
  if (!title || !content) {
    return textResult('缺少必填参数 title 或 content。', true);
  }
  const cfg = readConfig(pluginDataDir);
  void cfg;
  const res = await submitFeedback({
    db,
    pluginDataDir,
    title,
    content,
    requestType: args?.requestType,
    saveLocal: args?.saveLocal,
  });
  if (!res.ok && !res.localSaved) {
    return textResult(res.error || res.message || '提交失败。', true);
  }
  const text = res.message || res.error || '已完成处理。';
  return textResult(text, false);
}

async function callTool(name, args) {
  if (args !== null && typeof args === 'object' && Array.isArray(args)) {
    return textResult('工具参数必须是对象', true);
  }
  const safeArgs = args !== null && typeof args === 'object' ? args : {};
  if (name === 'lookup_meme') return handleLookupMeme(safeArgs);
  if (name === 'random_meme') return handleRandomMeme(safeArgs);
  if (name === 'feedback_meme') return await handleFeedbackMeme(safeArgs);
  return textResult(`未知工具：${name}`, true);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'linre-memewiki', version: '0.1.0' },
      },
    });
    return;
  }
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return;
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === 'tools/call') {
    const params = message.params ?? {};
    try {
      const result = await callTool(params.name, params.arguments ?? {});
      send({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: textResult(`linre-memewiki: ${error instanceof Error ? error.message : String(error)}`, true),
      });
    }
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (line === '') continue;
    try {
      void handle(JSON.parse(line));
    } catch (error) {
      process.stderr.write(`invalid MCP message: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
});

process.stdin.on('end', () => {
  db.close();
  process.exit(0);
});
