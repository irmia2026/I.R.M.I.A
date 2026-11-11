// 把 `src/` 里**不是 TypeScript**、但运行期必须存在的资源搬到 `dist/`。
//
// 为什么需要它：`tsc` 只编译 `.ts`。插件运行器（`node-runner.mjs`、`python/*.py`）
// 不在编译产物里，于是开发树能跑、装机版却起不来（2026-10-29 P1a 的已知缺口）。
// 以后再有同类资源（模板、schema、脚本），都往这张表里加一行，别在打包脚本里各写一遍。
//
// 2026-11-05：改为**显式递归复制**而不是 `fs.cpSync`。`subagent-packages.ts` 里记着本机
// 实测：Node 22.19 / Windows 上 `cpSync` 拷贝 packs 下的目录会以 0xC0000409 原生崩溃。
// 用 readdir + copyFile 的行为是确定的，顺带在复制时拒掉 symlink（与内置包复制同一条判据）。
//
// ⚠️ **`packs/` 不进 `dist/`（单一路径口径）**：
//   worker 的 codegraph 脚本是 `packs/subagents/tools/codegraph/code_cli.py`，运行时的定位顺序
//   只认两个根：`<应用根>/packs/...`（dev = 仓库根，装完 = 安装根），外加一个 cwd 兜底
//   （见 `src/runtime/subagent-code.ts` 的 `codeCliCandidates`）。`<应用根>/dist/packs/...` 那条
//   候选已删除：它对应的是"只搬运 dist"的旧布局，而内置包安装（`subagent-packages.ts` 的
//   `MODULE_RESOURCE_ROOT`）**从来只认 `<应用根>/packs/`**——两边各有一份 = 包里同一份资源
//   出现两个版本，坏了都不知道该修哪个。
//   ⇒ `packs/` 由装配链整棵搬到**包根**（`packaging/builtin-payload.mjs`），
//     本脚本只负责 `src/` → `dist/` 的纯编译产物伴生资源。
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '\\..';
const copies = [
  ['src/plugin/runners', 'dist/plugin/runners'],
];

function copyTree(from, to) {
  mkdirSync(to, {recursive: true});
  for (const entry of readdirSync(from, {withFileTypes: true})) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`[copy-assets] 拒绝复制 symlink：${source}`);
    if (entry.isDirectory()) copyTree(source, target);
    else if (entry.isFile()) copyFileSync(source, target);
  }
}

for (const [from, to] of copies) {
  const source = join(root, from);
  if (!existsSync(source)) {
    console.error(`[copy-assets] 源不存在，跳过：${from}`);
    continue;
  }
  mkdirSync(dirname(join(root, to)), { recursive: true });
  copyTree(source, join(root, to));
  console.log(`[copy-assets] ${from} → ${to}`);
}
