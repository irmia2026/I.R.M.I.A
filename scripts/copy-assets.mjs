// 把 `src/` 里**不是 TypeScript**、但运行期必须存在的资源搬到 `dist/`。
//
// 为什么需要它：`tsc` 只编译 `.ts`。插件运行器（`node-runner.mjs`、`python/*.py`）
// 不在编译产物里，于是开发树能跑、装机版却起不来（2026-10-29 P1a 的已知缺口）。
// 以后再有同类资源（模板、schema、脚本），都往这张表里加一行，别在打包脚本里各写一遍。
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '\\..';
const copies = [
  ['src/plugin/runners', 'dist/plugin/runners'],
];

for (const [from, to] of copies) {
  const source = join(root, from);
  if (!existsSync(source)) {
    console.error(`[copy-assets] 源不存在，跳过：${from}`);
    continue;
  }
  mkdirSync(dirname(join(root, to)), { recursive: true });
  cpSync(source, join(root, to), { recursive: true });
  console.log(`[copy-assets] ${from} → ${to}`);
}
