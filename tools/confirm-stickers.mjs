import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const repo = 'C:/Users/admin/Documents/linre-src/L.i.N.R.E';
const { EventLog } = await import(`file:///${repo}/dist/log/event-log.js`);
const types = await import(`file:///${repo}/dist/log/types.js`);

const id = 'linre-stickers';
const root = join(repo, 'data/plugins/packages', id);
const dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const hashes = dirs.map((name) => name.split('-').pop() ?? name).filter((h) => /^[0-9a-f]{64}$/.test(h));
if (hashes.length === 0) {
  console.error('找不到任何完整的 contentHash');
  process.exit(1);
}
const target = process.argv[2] ?? hashes[hashes.length - 1];
if (!hashes.includes(target)) {
  console.error(`目标 hash 不在目录里：${target}`);
  process.exit(1);
}

const log = await EventLog.open(join(repo, 'data/events'));
const visibilityOf = (type) => (typeof types.defaultVisibility === 'function' ? types.defaultVisibility(type) : 'model');

function emit(type, data) {
  const seq = log.nextSeq();
  const event = { seq, ts: new Date().toISOString(), type, data, visibility: visibilityOf(type) };
  log.append(event, { sync: true });
  console.log(`写入 seq=${seq} ${type} ${JSON.stringify(data)}`);
}

for (const hash of hashes) {
  if (hash === target) continue;
  emit('plugin/disabled', { id, contentHash: hash });
}
emit('plugin/installed', { id, contentHash: target, version: '0.1.0' });
emit('plugin/enabled', { id, contentHash: target });

log.close();
console.log(`完成：已启用 ${id}@${target.slice(0, 8)}`);
