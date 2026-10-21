/**
 * 守护 / 单实例编排夹具（test/guardian.test.ts 专用）
 *
 * 唯一职责：像真实部署那样启动**一次完整的进程编排**。这里调用的 `main()` 就是
 * `dist\main.js`（`npm start`）背后的那个入口函数，所以「第二个实例被锁拒掉并以非零退出」
 * 走的是与生产完全同一条路径——不是测试里另抄一遍的 try/catch。
 *
 * 用法（由 test/guardian.test.ts 以子进程方式拉起）：
 *   node --experimental-strip-types test/fixtures/guardian-instance.ts
 *   · 数据目录：环境变量 IRMIA_DATA_DIR（与 CLI / main.ts 的口径一致）
 *   · 工作目录：调用方设为项目根（config.json 与 <cwd>/data 的推断都依赖 cwd）
 *
 * 刻意清空 IRMIA_API_KEY：没有密钥时 main.ts 走假循环，路径确定、不触网。
 * 本夹具验的是守护与单实例锁，模型调用与它无关。
 *
 * 退出码语义（与生产一致）：拿不到锁 / 配置非法 / 日志打不开 → main() 返回 1 → 非零退出，
 * 计划任务与 systemd 正是靠这个非零码判定"这次没起来"。
 */

import { main } from '../../src/main.ts';

delete process.env['IRMIA_API_KEY'];

const code = await main();

// main() 成功时不会返回（信号处理器与循环轮询定时器保持进程存活）；
// 能走到这一行只可能是启动失败——被锁挡住是最常见的那种。
if (code !== 0) process.exit(code);
