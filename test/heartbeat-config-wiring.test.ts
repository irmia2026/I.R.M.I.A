/**
 * 心跳**目标均值**的接线判据（2026-02-06）：配置真的接到运行期了吗？
 *
 * 为什么单开一条接线用例：`wake.heartbeatTargetMeanMin` 是一个"说人话的旋钮"，
 * 而旋钮最典型的坏法**不是算错，是没接上**——配置解析得好好的、字段也进了 AppConfig，
 * 但构造心跳时没人读它，于是用户改了配置却发现心跳一点没变（留一个读了不生效的旋钮，
 * 比没有这个旋钮更坏：他会以为自己调过了）。
 *
 * 判据只有一条但必须走**真链路**：真 `RealLoop` + 真配置 + 真启动摘要。
 * 台子是 `test/fixtures/real-wake-rig.ts`（只有模型是假的），配置在构造前改一次
 * （`patchConfig`），然后把 `loop.start()` 写出的启动摘要读回来：
 *
 *   - 摘要里必须出现**目标均值**与**解出来的 α**两个数；
 *   - 换一个目标（45 → 10）⇒ 摘要里的解析均值跟着变成 10 分钟、α 变小；
 *   - 解析均值与"按目标解出来的 α"一致（`solveHeartbeatAlpha`，与心跳内部同一个函数）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AppConfig } from '../src/config/config.ts';
import { solveHeartbeatAlpha } from '../src/wake/heartbeat.ts';
import { makeRealWakeRig } from './fixtures/real-wake-rig.ts';

const MIN = 60_000;

/** 从启动摘要里挑出心跳那一行（`[心跳] 已布防：…`） */
function heartbeatLine(lines: string[]): string {
  const line = lines.find(text => text.startsWith('[心跳] 已布防'));
  assert.ok(line !== undefined, `启动摘要里必须有心跳那一行，实得：\n${lines.join('\n')}`);
  return line;
}

/**
 * 起一次真循环、把启动摘要读回来。
 *
 * `start()` 里那两件事（`ensureReady()` 与第一拍）是**故意不 await** 的（生产里就是这么起），
 * 所以这里显式把它们等到：`tickOnce()` 内部 await 同一个 `ensureReady` 记忆化 promise，
 * 再让出几次事件循环，读完摘要才收台子——否则关日志会撞上还在飞的 promise（实测踩过）。
 */
async function startupLines(patch?: (config: AppConfig) => void): Promise<string[]> {
  const rig = await makeRealWakeRig(patch === undefined ? {} : { patchConfig: patch });
  try {
    rig.loop.start();
    await rig.tick();
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
    return [...rig.lines];
  } finally {
    rig.loop.stop();
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
    rig.dispose();
  }
}

test('接线：改 wake.heartbeatTargetMeanMin，启动摘要里的均值与 α 真的跟着变', async () => {
  // ① 出厂默认（45 分钟）：摘要里目标、α、解析均值三个数都要在
  const baseLine = heartbeatLine(await startupLines());
  const baseAlpha = solveHeartbeatAlpha(5 * MIN, 60 * MIN, MIN, 45 * MIN);
  assert.match(baseLine, /目标均值 45 分钟/, `默认必须报出目标均值 45 分钟：${baseLine}`);
  assert.match(baseLine, new RegExp(`解出 α = ${baseAlpha.toFixed(4)}`), `默认解出的 α 应是 ${baseAlpha.toFixed(4)}：${baseLine}`);
  assert.match(baseLine, /均值约 45 分钟/, `解析均值应落在目标上：${baseLine}`);

  // ② 配置改成 10 分钟：同一份代码、同一个入口，摘要必须跟着走（这就是"接线"本身）
  const fasterLine = heartbeatLine(await startupLines((config) => {
    config.wake.heartbeatTargetMeanMin = 10;
  }));
  assert.match(fasterLine, /目标均值 10 分钟/, `改了配置就必须报 10 分钟：${fasterLine}`);
  assert.match(fasterLine, /均值约 10 分钟/, `解析均值必须跟着目标走（这就是接线生效）：${fasterLine}`);
  // 与心跳内部同一个解之间的互校：α = solveHeartbeatAlpha(5, 60, 1, 10) ⇒ 摘要里那个数
  const alpha = solveHeartbeatAlpha(5 * MIN, 60 * MIN, MIN, 10 * MIN);
  assert.match(fasterLine, new RegExp(`解出 α = ${alpha.toFixed(4)}`), `${fasterLine}（应含 α = ${alpha.toFixed(4)}）`);
});
