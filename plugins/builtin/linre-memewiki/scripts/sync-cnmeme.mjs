import { createMemeDb } from '../lib/db.mjs';
import { resolvePluginDataDir } from '../lib/paths.mjs';
import { syncCnmeme } from '../lib/sync.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noExisting = args.includes('--no-existing');

let explicitDataDir = '';
const dirIdx = args.indexOf('--data-dir');
if (dirIdx >= 0 && args[dirIdx + 1]) {
  explicitDataDir = args[dirIdx + 1];
}

const pluginDataDir = resolvePluginDataDir(explicitDataDir);
const db = createMemeDb({ pluginDataDir });

try {
  const result = await syncCnmeme({
    db,
    pluginDataDir,
    dryRun,
    noExisting,
    onProgress: (line) => console.log(line),
  });
  console.log(
    `完成：${result.localBefore} -> ${result.total} 条（新增 ${result.added}，更新 ${result.updated}，失败 ${result.failed}，耗时 ${result.durationSec}s）`,
  );
  if (result.backupPath) console.log(`备份：${result.backupPath}`);
} catch (error) {
  console.error(`同步失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
