#!/usr/bin/env node
/**
 * Irmia Agent 测试夹具 — 一个**永不回应 initialize** 的 MCP server（纯 JS，子进程直接跑）
 *
 * 存在的理由只有一个：`mcp-test` 这条命令的"握手超时"分支没有任何办法用别的办法测。
 * 真 server 都会回 initialize，而不回的那个（`test/fixtures/fake-mcp-server.mjs` 的污染开关）
 * 走的是"协议违规"那条路——那是另一条分支。
 *
 * 它做的事：
 *   · 收到 initialize **故意不回**（把请求原文记进日志）；
 *   · 收到别的行也照记；
 *   · 收到 SIGTERM 记一行然后退出（mcp-test 的关机序列会走到 SIGTERM 这一级）；
 *   · 启动时把 pid 写进日志，好让用例断言"它真的被收掉了"。
 *
 * 用法：`node hang-mcp-server.mjs <journalPath>`（日志一行一条 JSON，追加写）
 */

import { appendFileSync } from 'node:fs';

const journal = process.argv[2] ?? '';

function mark(label, extra = {}) {
  if (journal === '') return;
  try {
    appendFileSync(journal, `${JSON.stringify({ t: label, ts: Date.now(), pid: process.pid, ...extra })}\n`);
  } catch {
    // 记不下不影响被测行为
  }
}

mark('start');

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
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      mark('bad-line', { line });
      continue;
    }
    // 刻意什么都不回：连 initialize 都不回。这就是"卡在握手上"的那个 server。
    mark('request', { method: message.method ?? null, id: message.id ?? null });
  }
});

process.stdin.on('end', () => {
  mark('stdin-end');
  // 关 stdin 之后也不退出：逼 mcp-test 的关机序列往下走到 SIGTERM（这条正是要验证的能力）
  setInterval(() => {}, 1000);
});

process.on('SIGTERM', () => {
  mark('sigterm');
  process.exit(0);
});

process.on('exit', (code) => {
  mark('exit', { code });
});
