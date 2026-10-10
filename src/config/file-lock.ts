/**
 * Irmia Agent — 配置文件那一把闸（`config.json` / `data/hooks.json` 的读-改-写）
 *
 * ──────────────────────────── 为什么它单独一个文件 ────────────────────────────
 *
 * 这条闸原来长在 `web/server.ts` 里（`function createFileLock()` + 一个模块私有的
 * `const configFileLock`）。2026-10-11 这条通道多了一个**第二个写入方**：
 * 她在界面上点批准之后，框架要往 `config.json` 的 `mcp.servers[]` 里加/删一条
 * （`grant/mcp-grant.ts` 的 `withGrantConfigDoc`）。
 *
 * 两个写入方必须排在**同一个队列**里——各自建一把锁就是那个经典洞：两条
 * "读整份文档 → 改 → 写回" 交错执行，后写的那条会把先写的那条整段盖掉。
 *
 * 而"谁持有这一把锁"这件事**不该靠跨模块 import 来保证**：那条路上已经出过一次事故
 * （`web/server.ts` 被人整文件重写，`export const configFileLock` 连同一段逻辑一起消失，
 * 全仓测试当场 `does not provide an export named 'configFileLock'`）。
 * ⇒ 把**实例与实现**都放在这里，两个写入方都从这里 import：谁重写谁，这一格都不受影响。
 *
 * ⚠ 判据是"**一次读-改-写只许走一个队列**"，不是"这个文件被 import 了几次"：
 * 所以这里导出的是一个**模块级单例**。不要在调用方 `createFileLock()` 建第二把。
 */

/**
 * 串行闸：把并发的异步读-改-写排成一队。
 *
 * 为什么需要它（原注释，逐字保留）：真正的根因是**并发的异步读句柄**——一次
 * `readFile` 打开的文件句柄会让紧接着的 `rename`（原子写那一步）在 Windows 上失败
 * （`EPERM: operation not permitted, rename '…tmp' -> '…'`，实测踩到过）。
 * `writeFileAtomicSync` 里那层退避重试兜的是杀软/索引器的偶发，两件事不一样。
 *
 * 队列本身**不许因为一次失败而断掉**：吞掉拒绝，让下一个拿到干净的接力棒
 * （否则一次配置写失败之后，后面所有的写命令都会挂在一个已经 rejected 的 promise 上）。
 */
export function createFileLock(): <T>(task: () => Promise<T> | T) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T> | T): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/**
 * `config.json`（与 `data/hooks.json`）那一把闸的**唯一实例**。
 *
 * 三个写入方都从这一个 import：
 *   · `web/server.ts` 的 `withConfigDoc`（界面的 mcp-save / mcp-remove / config-update）；
 *   · `web/server.ts` 的 `mutateHookConfig`（钩子那份文件）；
 *   · `grant/mcp-grant.ts` 的 `withGrantConfigDoc`（她申请、人批准之后框架落地那一步）。
 */
export const configFileLock = createFileLock();
