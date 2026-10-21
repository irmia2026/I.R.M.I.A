/**
 * Irmia Agent — 杀掉一整棵子进程树（design §4.19 的"超时即杀"与关机序列共用）
 *
 * 为什么不只是 `child.kill()`：Windows 上 `child.kill('SIGTERM')` 长期不生效
 * （Node 只为 `SIGKILL`/`SIGTERM` 做终止，但对**不响应信号的进程**毫无办法），
 * 而钩子与 MCP server 这两类外部进程都可能自己再拉子进程——
 * 只杀父进程会留下一串谁都管不到的孤儿进程。
 *
 * 三处调用点（钩子执行器、MCP 客户端池、GUI 的 MCP 测试连接）都要同一条纪律：
 * **先直接杀，Windows 上再用 `taskkill /T /F` 兜底**。两份实现迟早会漂移，
 * 所以只有这一个定义点（v28 记过一次同类教训：同一件事写两遍，总有一遍会过期）。
 *
 * 本模块零外部依赖，只用 node: 标准库。
 */

import { spawnSync, type ChildProcess } from 'node:child_process';

/** 进程树终止的结果：给调用方判定用（`taskkill` 不可用时仍会尝试直接 kill） */
export interface KillTreeOutcome {
  /** 是否走到过 `taskkill /T /F`（Windows 上才有） */
  usedTaskkill: boolean;
  /** `taskkill` 的退出码；没跑过则为 null */
  taskkillCode: number | null;
}

/**
 * 杀掉 `child` 及其子孙进程。**永不抛**：杀不掉不是调用方该处理的事
 * （"超时即杀"的语义是"尽力让它死"，而不是"杀不掉就报错打断主流程"）。
 */
export function killProcessTree(child: ChildProcess, options: { forceTree?: boolean } = {}): KillTreeOutcome {
  const pid = child.pid;
  let usedTaskkill = false;
  let taskkillCode: number | null = null;

  // Windows：taskkill /T 才能把子孙一起带走。`forceTree` 为真时连自己也算进去
  // （`/F` 是强杀：gentle 关机已经试过了才会走到这里）。
  if (process.platform === 'win32' && pid !== undefined) {
    usedTaskkill = true;
    try {
      const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      taskkillCode = result.status ?? null;
      if (options.forceTree === true) return { usedTaskkill, taskkillCode };
    } catch {
      // taskkill 不可用（精简镜像）不影响下面的直接 kill
    }
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // 已经退出
  }
  return { usedTaskkill, taskkillCode };
}
