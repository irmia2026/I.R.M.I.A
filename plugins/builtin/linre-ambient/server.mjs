import {
  collectRecentFiles,
  collectStorage,
  formatAgeText,
  formatBytes,
  formatIdleText,
  sampleWindows,
  searchEverything,
} from './lib/sampler.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const VALID_SCOPES = new Set(['windows', 'recent_files', 'storage', 'all']);

const TOOLS = [
  {
    name: 'peek_host',
    description: '轻量看看宿主电脑此刻在发生什么：可见窗口与键鼠空闲（windows）、近期下载/桌面新文件或 Everything 搜索（recent_files）、磁盘可用空间与目录计数（storage），或一次全看（all）。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['windows', 'recent_files', 'storage', 'all'],
        },
        query: {
          type: 'string',
        },
      },
      additionalProperties: false,
    },
  },
];

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

async function formatWindowsSection() {
  const data = await sampleWindows();
  const lines = ['【窗口与键鼠】'];
  const fgDesc = data.fgProcess
    ? (data.fgTitle ? `${data.fgProcess}「${data.fgTitle}」` : data.fgProcess)
    : '（无前台窗口信息）';
  lines.push(`· 前台焦点：${fgDesc}`);
  lines.push(`· 键鼠状态：${data.idleSeconds === null ? '未知' : `${formatIdleText(data.idleSeconds)}（${data.idleSeconds} 秒）`}`);
  if (data.windows.length === 0) {
    lines.push('· 可见窗口：无（或无桌面会话）');
  } else {
    lines.push('· 可见窗口：');
    for (const w of data.windows) {
      lines.push(`  - ${w.process}${w.title ? `：${w.title}` : ''}`);
    }
  }
  return lines.join('\n');
}

async function formatRecentFilesSection(query) {
  const lines = ['【近期文件】'];
  const q = typeof query === 'string' ? query.trim() : '';
  if (q !== '') {
    const es = await searchEverything(q);
    if (es.available) {
      lines.push(`· Everything 搜索「${q}」：`);
      if (es.results.length === 0) {
        lines.push('  （没有匹配结果）');
      } else {
        for (const item of es.results) lines.push(`  - ${item}`);
      }
      return lines.join('\n');
    }
  }
  const files = collectRecentFiles({ maxAgeMs: Infinity, limit: 12 });
  if (files.length === 0) {
    lines.push('· Downloads / Desktop 暂无文件记录');
  } else {
    for (const file of files) {
      lines.push(`· [${file.dir}] ${file.name}（${formatBytes(file.sizeBytes)} · ${formatAgeText(file.ageMs)}）`);
    }
  }
  return lines.join('\n');
}

function formatStorageSection() {
  const info = collectStorage();
  const lines = ['【存储概览】'];
  if (info.drives.length === 0) {
    lines.push('· 磁盘空间：暂不可用');
  } else {
    for (const d of info.drives) {
      lines.push(`· ${d.drive} 可用：${d.freeGb.toFixed(1)} GB`);
    }
  }
  if (info.downloadsCount !== null) lines.push(`· Downloads 顶层条目数：${info.downloadsCount}`);
  if (info.tempCount !== null) lines.push(`· Temp 顶层条目数：${info.tempCount}`);
  return lines.join('\n');
}

export async function runPeekHost(args = {}) {
  if (args !== null && (typeof args !== 'object' || Array.isArray(args))) {
    return textResult('参数必须是对象', true);
  }
  const rawScope = args?.scope ?? 'all';
  if (!VALID_SCOPES.has(rawScope)) {
    return textResult(`不支持的 scope：${String(rawScope)}`, true);
  }
  const query = typeof args?.query === 'string' ? args.query : '';
  const sections = [];
  if (rawScope === 'windows' || rawScope === 'all') sections.push(await formatWindowsSection());
  if (rawScope === 'recent_files' || rawScope === 'all') sections.push(await formatRecentFilesSection(query));
  if (rawScope === 'storage' || rawScope === 'all') sections.push(formatStorageSection());
  return textResult(sections.join('\n\n'));
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
        serverInfo: { name: 'linre-ambient', version: '0.1.0' },
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
    if (params.name !== 'peek_host') {
      send({ jsonrpc: '2.0', id: message.id, result: textResult(`未知工具：${String(params.name)}`, true) });
      return;
    }
    try {
      send({ jsonrpc: '2.0', id: message.id, result: await runPeekHost(params.arguments ?? {}) });
    } catch (error) {
      send({ jsonrpc: '2.0', id: message.id, result: textResult(`linre-ambient: ${error instanceof Error ? error.message : String(error)}`, true) });
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
