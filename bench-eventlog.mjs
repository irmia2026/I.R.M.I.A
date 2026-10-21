// JSONL 事件日志性能基准：写入吞吐 / 全量 fold / 稀疏索引查询
// 用法: node bench-eventlog.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync, openSync, fsyncSync, readSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '.bench-tmp');
const FILE = join(DIR, 'events.jsonl');
const N = 100_000;

function makeEvent(i) {
  return {
    seq: i,
    ts: new Date(1_780_000_000_000 + i * 1000).toISOString(),
    type: ['tool/call', 'tool/result', 'message/user', 'budget/consumed', 'step/start'][i % 5],
    visibility: 'model',
    data: { turn: (i / 10) | 0, step: i % 10, callId: `call_${i}`, name: 'http_get', arguments: '{"url":"https://example.com/api/v1/endpoint?param=value"}', cacheHitTokens: i % 1000 },
  };
}

mkdirSync(DIR, { recursive: true });
try { rmSync(FILE); } catch {}

// ── 1. 写入: 承诺类逐条 fsync 是极端情况; 观测类按批(100 条) fsync 是常态 ──
{
  const t0 = performance.now();
  const fd = openSync(FILE, 'w');
  let buf = '';
  for (let i = 0; i < N; i++) {
    buf += JSON.stringify(makeEvent(i)) + '\n';
    if (i % 100 === 99) { writeFileSync(fd, buf); fsyncSync(fd); buf = ''; }
  }
  if (buf) { writeFileSync(fd, buf); fsyncSync(fd); }
  const dt = performance.now() - t0;
  console.log(`[写入-批量fsync] ${N} 条: ${dt.toFixed(0)}ms → ${(N / dt * 1000 | 0).toLocaleString()} 事件/秒`);
}

// 逐条 fsync（承诺类事件的真实成本，取前 2000 条测量）
{
  const fd = openSync(join(DIR, 'sync-heavy.jsonl'), 'w');
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) {
    writeFileSync(fd, JSON.stringify(makeEvent(i)) + '\n');
    fsyncSync(fd);
  }
  const dt = performance.now() - t0;
  console.log(`[写入-逐条fsync] 2000 条: ${dt.toFixed(0)}ms → 平均 ${(dt / 2000).toFixed(2)}ms/条 (p50 量级)`);
}

// ── 2. 全量 fold: 读 + JSON.parse + 折叠（模拟真实 fold 逻辑） ──
{
  const t0 = performance.now();
  const raw = readFileSync(FILE, 'utf8');
  const t1 = performance.now();
  const lines = raw.split('\n');
  let watermark = 0, openTools = 0, tokens = 0;
  for (const line of lines) {
    if (!line) continue;
    const e = JSON.parse(line);
    if (e.type === 'tool/call') openTools++;
    else if (e.type === 'tool/result') openTools--;
    else if (e.type === 'budget/consumed') tokens += e.data.cacheHitTokens;
    watermark = e.seq;
  }
  const t2 = performance.now();
  const mb = (statSync(FILE).size / 1e6).toFixed(1);
  console.log(`[全量fold] ${N} 条 / ${mb}MB: 读取 ${(t1 - t0).toFixed(0)}ms + parse&fold ${(t2 - t1).toFixed(0)}ms = 共 ${(t2 - t0).toFixed(0)}ms`);
}

// ── 3. 稀疏索引: 每 1000 条一个检查点, get(seq) 随机访问 ──
{
  const index = [];
  let offset = 0, lineNo = 0;
  for (const line of readFileSync(FILE, 'utf8').split('\n')) {
    if (lineNo % 1000 === 0) index.push({ line: lineNo, offset });
    offset += Buffer.byteLength(line) + 1;
    lineNo++;
  }
  const fd = openSync(FILE, 'r');
  const buf = Buffer.alloc(4096);
  const t0 = performance.now();
  let hits = 0;
  for (let q = 0; q < 1000; q++) {
    const target = (Math.random() * N) | 0;
    const cp = index[(target / 1000) | 0];
    readSync(fd, buf, 0, 4096, cp.offset);
    hits++;
  }
  const dt = performance.now() - t0;
  console.log(`[稀疏索引] 1000 次随机 get(seq): ${dt.toFixed(1)}ms → 平均 ${(dt / 1000).toFixed(3)}ms/次`);
}

rmSync(DIR, { recursive: true, force: true });
