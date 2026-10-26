/**
 * Irmia Agent — 「内核真正会访问的那个路径」（符号链接 / junction 展开的**唯一一处**实现）
 *
 * 为什么必须有这一处（2026-10-23 现场）：`resolve()` 只做字符串归一，**不动链接**。
 * 于是"一个已经展开过的真路径"与"一个没展开的根"做前缀比较，必然得出"越界"——
 * 现场那两条报错（`write_persona` 的"父目录经符号链接指向 persona/ 之外"、版本快照的
 * "路径不在工作区内"）**根本原因都是这件事**，而不是路径真的跑出去了：
 * 她的 `data` 根是经链接到达的（`<cwd>/data` → `<安装根>/data`），而比较的另一侧是字面根。
 *
 * 判据只有一条：**要比较，就把两边都用同一把尺子展开**（见 `expandRealPath`）。
 * 半个链接也算：`realpathSync.native` 会把路径上**每一段**都解开，返回的是文件系统认的那条。
 *
 * 三条分寸（每一条都对应一种会误判的现场）：
 *   ① **只信文件系统**：用 `realpathSync.native`（libuv 的 `uv_fs_realpath`）。Windows 上它连
 *      junction 与 subst 一起解开，而 Node 的 JS 版 `realpathSync` 只认 symlink——那两种
 *      "看起来是普通目录、实际指向别处"的形状正是本次故障的载体。
 *   ② **不存在不等于越界**：目标是"还没建的文件"是常态（新建 STATE.md、新建记忆条目、
 *      快照库自己也这么建目录）。这时对**最近的存在祖先**展开，再把不存在的尾段原样拼回去
 *      ——内核访问的就是"展开后的祖先 + 原样的尾段"，与 `fs/path-guard.ts` 的
 *      `deepestExisting` 同一套语义（那个是异步版、服务于路径守卫；这里是同步版、
 *      服务于"比较两段路径是不是同一个地方"）。
 *   ③ **爬不动就原样返回**：盘符不存在、权限不足、路径里有 NUL 这类情况下，退回 `resolve()`
 *      的字符串结果，让调用方其余的判据（`..` 段、绝对路径、字面前缀比较）照旧生效
 *      ——不抛、不猜、不把"读不到"当成"在外"。
 *
 * 零依赖：只用 node: 标准库。工具层与 persona 层共用（`tools/admin.ts`、
 * `persona/versions.ts`），所以放在 util/ 下而不是任何一族的目录里。
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * 路径的**真实路径**；解析不出来（不存在、读不动）返回 `null`。
 *
 * 单独导出是因为调用方有时只想问"它现在真实在哪"（目标不存在就是不存在），
 * 而 `expandRealPath` 的语义是"不存在也给你一个能比较的路径"——两件事，别混。
 */
export function realPathOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/**
 * 把一条路径展开成"内核真正会访问的路径"：先对**最近的存在祖先**取真实路径，
 * 再把不存在的尾段原样拼回去；整条都爬不到盘符时退回 `resolve()` 的结果（见文件头 ③）。
 *
 * 例（现场那一条：`<安装根>\app\data` 是指向 `<安装根>\data` 的链接）：
 *   `expandRealPath('<安装根>\app\data\persona')` → `<安装根>\data\persona`
 * 例（新建目标）：`expandRealPath('<安装根>\data\persona\新文件.md')`
 *   → `<安装根>\data\persona\新文件.md`（祖先存在，尾段原样带回来）
 */
export function expandRealPath(path: string): string {
  const lexical = resolve(path);
  const tail: string[] = [];
  let cursor = lexical;
  for (;;) {
    const real = realPathOrNull(cursor);
    if (real !== null) return tail.length === 0 ? real : join(real, ...tail);
    const parent = dirname(cursor);
    // 已经爬到根（`C:\` 或 `/`）还解析不了：这条路径上没有任何一段是真实存在的。
    // 不抛——返回字符串归一的那个结果，让调用方的其余判据去判它（文件头 ③）。
    if (parent === cursor) return lexical;
    tail.unshift(basename(cursor));
    cursor = parent;
  }
}
