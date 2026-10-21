#!/usr/bin/env node
/**
 * Irmia Agent 测试夹具 — 最小 MCP stdio server（纯 JS，子进程直接跑，不需要类型剥离）
 *
 * 它只实现被 MCP 客户端池用到的那一小截协议：initialize / notifications/initialized /
 * tools/list / tools/call / notifications/cancelled。行为由环境变量编排，覆盖：
 *
 *   FAKE_MCP_MARKER_DIR       标记目录（events.jsonl 逐条记录生命周期事实）
 *   FAKE_MCP_POLLUTE=1        首次启动往 stdout 写一行非 JSON-RPC（测协议违规重启）
 *   FAKE_MCP_IGNORE_STDIN_END=1  关 stdin 之后不退出（逼客户端走 SIGTERM）
 *   FAKE_MCP_LIST_CHANGED=1   第二次 tools/list 多一个 late 工具；首次 tools/call 后发
 *                             notifications/tools/list_changed
 *   FAKE_MCP_RESPOND_AFTER_MS=tools/call 统一延迟 t 毫秒再回应（测超时与取消）
 *   FAKE_MCP_PROGRESS_MS=t    tools/call 期间每 t 毫秒发一次 notifications/progress
 *   FAKE_MCP_PAGE_SIZE=n      `tools/list` 按 n 件一页分页回 `nextCursor`（测分页；n<=0 = 不分页）。
 *                             cursor 的形状是 `起始下标@圈数`（例：`"2@0"`），绕回开头时名字带 `_p{圈数}`
 *                             后缀（否则第二次数到的同名工具会被注册表判成重复，件数就数不出来）。
 *   FAKE_MCP_LIST_FAIL_PAGE=k 第 k 页（1 起）回一个 JSON-RPC 错误（测"分页中途失败必须如实报"）
 *   FAKE_MCP_REPEAT_CURSOR=1  **永远**声明"还有下一页"（cursor 逐页不同）——测页数上限那条路；
 *                            游标原样回环（同一串 cursor 反复回）由单测里的可编程假进程覆盖
 *
 * 纪律：stdout 只写合法 JSON-RPC（唯一例外是刻意打开的污染开关），日志一律走 stderr。
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const markerDir = process.env.FAKE_MCP_MARKER_DIR ?? '';
if (markerDir !== '') {
  try {
    mkdirSync(markerDir, { recursive: true });
  } catch {
    // 目录已存在：忽略
  }
}

function mark(label, extra = {}) {
  if (markerDir === '') return;
  try {
    appendFileSync(join(markerDir, 'events.jsonl'), `${JSON.stringify({ t: label, ts: Date.now(), ...extra })}\n`);
  } catch {
    // 标记失败不影响被测行为
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const SCHEMA_TEXT = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
const SCHEMA_EMPTY = { type: 'object', properties: {} };
const SCHEMA_CHARS = { type: 'object', properties: { chars: { type: 'number' } } };
const SCHEMA_MS = { type: 'object', properties: { ms: { type: 'number' } } };

const TOOLS = [
  {
    name: 'echo',
    description: '回显输入文本（夹具工具）',
    inputSchema: SCHEMA_TEXT,
    annotations: { readOnlyHint: true },
  },
  { name: 'big', description: '返回一大段文本（测 blob 外置）', inputSchema: SCHEMA_CHARS },
  { name: 'fail', description: '总是返回 isError', inputSchema: SCHEMA_EMPTY },
  { name: 'slow', description: '延迟很久才回应（测超时与取消）', inputSchema: SCHEMA_MS },
];

/**
 * 额外工具（`FAKE_MCP_EXTRA_TOOLS` 一个 JSON 数组）：给"披露面清洗"那几条用例用的
 * ——那些用例要的形状是**不可信字段**（名字带反引号/换行、描述里藏指令、超长），
 * 而默认四件工具是全仓库共用的夹具，不该为了这一条把它们的名字改脏。
 *
 * 形状：`[{ "name": "...", "description": "...", "inputSchema": {...} }]`，解不出来就**忽略**
 * （夹具要稳：为一条用例写坏一个环境变量，不该让别的用例跟着红）。
 * ⚠️ 名字要能过**客户端**的字符集校验（`^[A-Za-z0-9_-]{1,128}$`，`client.ts` 的
 * `MCP_NAME_PATTERN`）——名字不合规的工具在 `validateToolsList` 那一层就被丢了，
 * 根本到不了披露面（那一层有自己的用例：`test/mcp-client.test.ts`）。所以这一格主要用来
 * 造**脏描述**（描述没有字符集限制，是清洗真正要挡的那一半）。
 */
const EXTRA_TOOLS = (() => {
  const raw = process.env.FAKE_MCP_EXTRA_TOOLS;
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => item !== null && typeof item === 'object') : [];
  } catch {
    return [];
  }
})();
if (EXTRA_TOOLS.length > 0) TOOLS.push(...EXTRA_TOOLS);

const LATE_TOOL = { name: 'late', description: 'list_changed 之后才出现的工具', inputSchema: SCHEMA_EMPTY };

let listCount = 0;
let listChangeSent = false;

function handleCall(message) {
  const params = message.params ?? {};
  const name = params.name;
  const args = params.arguments ?? {};
  const token = params._meta?.progressToken;
  mark('call', { name, args, id: message.id, meta: params._meta });

  const envDelay = Number(process.env.FAKE_MCP_RESPOND_AFTER_MS ?? '0');
  const delay = Number.isFinite(envDelay) && envDelay > 0
    ? envDelay
    : (name === 'slow' ? Number(args.ms ?? 5000) : 0);
  const progressEvery = Number(process.env.FAKE_MCP_PROGRESS_MS ?? '0');
  let progressTimer = null;
  if (progressEvery > 0 && token !== undefined) {
    let n = 0;
    progressTimer = setInterval(() => {
      n += 1;
      send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: n } });
    }, progressEvery);
  }

  const finish = () => {
    if (progressTimer !== null) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
    if (name === 'fail') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: '夹具主动报告的工具失败' }], isError: true },
      });
      return;
    }
    if (name === 'big') {
      const chars = Number(args.chars ?? 20000);
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: '大'.repeat(chars) }] },
      });
      return;
    }
    if (name === 'echo') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: `echo:${String(args.text ?? '')}` }] },
      });
    } else {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: `unknown tool ${String(name)}` }], isError: true },
      });
    }
    if (process.env.FAKE_MCP_LIST_CHANGED === '1' && !listChangeSent) {
      listChangeSent = true;
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      mark('list-changed');
    }
  };

  if (delay > 0) setTimeout(finish, delay);
  else finish();
}

function handle(message) {
  if (message.method === 'initialize') {
    const params = message.params ?? {};
    mark('initialize', {
      protocolVersion: params.protocolVersion,
      capabilities: params.capabilities,
      clientInfo: params.clientInfo,
    });
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: params.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'notifications/initialized') {
    mark('initialized');
    return;
  }
  if (message.method === 'tools/list') {
    listCount += 1;
    const pageSize = Number(process.env.FAKE_MCP_PAGE_SIZE ?? '0');
    const failPage = Number(process.env.FAKE_MCP_LIST_FAIL_PAGE ?? '0');
    const all = process.env.FAKE_MCP_LIST_CHANGED === '1' && listCount >= 2
      ? [...TOOLS, LATE_TOOL]
      : TOOLS;
    // 分页：cursor 是"下一页起始下标"的字符串形式（取完不给 nextCursor）。
    // 不分页（pageSize<=0）时与以前逐字相同：一次给全部、params 里没有 cursor 也照回。
    if (pageSize > 0) {
      const cursorText = message.params?.cursor;
      // cursor 的形状 = `起始下标@圈数`（`"2@0"`）。圈数只为一件事存在：回环档下标会绕回开头、
      // 于是同一件工具会被第二次数到——名字撞车会被注册表判成重复，件数就数不出 40 件。
      // 形状解析不出来时按"第一页"处理（宽容；真 server 的 cursor 是不透明串）。
      const at = String(cursorText ?? '0@0').split('@');
      const startRaw = Number(at[0]);
      const cycleRaw = Number(at[1]);
      const from = Number.isFinite(startRaw) && startRaw >= 0 ? Math.floor(startRaw) : 0;
      const cycle = Number.isFinite(cycleRaw) && cycleRaw >= 0 ? Math.floor(cycleRaw) : 0;
      const pageIndex = Math.floor(from / pageSize) + 1;
      mark('list', { n: listCount, page: pageIndex, cursor: cursorText ?? null, pageSize, cycle });
      if (failPage > 0 && pageIndex === failPage) {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: `夹具刻意让第 ${pageIndex} 页失败` },
        });
        return;
      }
      // 取页：下标越过清单末尾时**绕回开头并进一圈**（只在回环档里会发生）——否则后面那些页是空的，
      // "页数上限"那条路就只在数页数，数不出件数。
      const slice = [];
      for (let i = 0; i < pageSize; i += 1) {
        if (all.length === 0) break;
        const index = from + i;
        const base = all[index % all.length];
        const wraps = Math.floor(index / all.length);
        // 名字必须落在规范字符集里（`[A-Za-z0-9_-]`）：带 `#` 的名字会被客户端判成不合法并跳过
        slice.push(wraps === 0 ? base : { ...base, name: `${base.name}_p${wraps}` });
      }
      const end = from + pageSize;
      const more = end < all.length || process.env.FAKE_MCP_REPEAT_CURSOR === '1';
      const wrapsNow = Math.floor(end / all.length);
      const nextCursor = more ? `${end}@${cycle + wrapsNow}` : undefined;
      const result = nextCursor === undefined ? { tools: slice } : { tools: slice, nextCursor };
      send({ jsonrpc: '2.0', id: message.id, result });
      return;
    }
    mark('list', { n: listCount });
    send({ jsonrpc: '2.0', id: message.id, result: { tools: all } });
    return;
  }
  if (message.method === 'tools/call') {
    handleCall(message);
    return;
  }
  if (message.method === 'notifications/cancelled') {
    mark('cancelled', { requestId: message.params?.requestId, reason: message.params?.reason });
    return;
  }
  mark('unknown-method', { method: message.method });
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
  }
}

// 污染：只发生一次（重启后恢复正常），用来验证"协议错误 → 重启该进程"
if (process.env.FAKE_MCP_POLLUTE === '1') {
  const flag = markerDir === '' ? '' : join(markerDir, 'polluted.flag');
  const alreadyPolluted = flag !== '' && existsSync(flag);
  if (!alreadyPolluted) {
    if (flag !== '') {
      try {
        writeFileSync(flag, '1');
      } catch {
        // 标记失败：下面照样污染一次
      }
    }
    process.stdout.write('fake mcp server 启动中（这一行不是 JSON-RPC）\n');
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\n');
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      mark('bad-input', { line });
      continue;
    }
    handle(message);
  }
});

process.stdin.on('end', () => {
  mark('stdin-end');
  if (process.env.FAKE_MCP_IGNORE_STDIN_END === '1') {
    // 刻意不退出：同时要留住事件循环，否则 Node 在无 pending 工作时会自行结束，
    // "忽略 stdin 关闭"就无从测起（这条正是 SIGTERM/SIGKILL 分支的前提）
    setInterval(() => {}, 1000);
    return;
  }
  setTimeout(() => process.exit(0), 10);
});

process.on('SIGTERM', () => {
  mark('sigterm');
  if (process.env.FAKE_MCP_IGNORE_SIGTERM === '1') return;
  process.exit(0);
});

process.on('SIGINT', () => {
  mark('sigint');
  process.exit(0);
});

process.on('exit', (code) => {
  mark('exit', { code });
});
