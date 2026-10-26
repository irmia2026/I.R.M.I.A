/**
 * Irmia Agent — 请求重放（M6-5、docs/operations.md §6 的 `replay <turn> <step>` 行）
 *
 * 把「某一次模型调用当时看到了什么」从日志里重建出来。可重建性是这套设计的地基
 * （schema §13：模型请求的全部内容可由 model 事件 + 人格资产版本重建），
 * 本模块是它的可执行形态——它**不重放副作用**，只重建请求体。
 *
 * 重建口径与运行期严格同源，三条都要对上，少一条就不是"当时那个请求"：
 *   ① 事件集 = `seq < step/start.seq` 的全部日志事件（agent-loop 的 syncEvents 在写
 *      step/start **之前**对齐日志，所以步内事件不在其中）；
 *   ② `wakeEvent` = 该 turn 认领的首条输入，仅第 1 步走参数通道；它同时必须从事件流里
 *      剔除，否则同一输入渲染两次（agent-loop 文件头的协同契约）；
 *   ③ 任务卡 = 认领首条输入的渲染摘要（裁剪口径来自 render.clipTaskTitle）+ 该步时点的
 *      未完成清单（对 `eventsBefore` 折叠得到，不是对当前投影）。
 *
 * 有意不重建的部分（如实报告，不假装齐全）：
 *   - **软阈值提示**（budget-guard 的 softHint）：它按设计不落库（KV 前缀的尾部插播），
 *     日志里没有它的任何痕迹，因此重建出的请求体不含它，字节对比时会恰好差这一条；
 *   - **工具清单**：日志只记 `developer/message` 的名字增减，不记定义。重建用当前装配的
 *     工具集（tools/catalog.ts）并给出摘要哈希，供人判断"是否同一份清单"；
 *   - **技能索引**（长期记忆层的第一段，`[可用技能]` 那一行起）：2026-10-11 起与 MCP 索引
 *     同一套缓存保护——字节只在日志里的 `skill/index` 快照上（重建读它，与运行期逐字节同源）。
 *     那一版**之前**的轮次没有这条事件，退回运行期当时的来源再扫一次（`SkillManager` +
 *     到这一步为止的信任事件，见 `skillCatalogForRebuild`）——技能目录是文件，改过内容/删掉
 *     之后那一段会与当时不同（与人格资产同一条限制，报告 notes 里明说）。
 *
 * 零外部依赖：只用 node: 标准库。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AppEvent, ChannelRenderContext, MemorySelected, ModelLane } from '../log/types.js';
import { isTopLevelEvent } from '../log/types.ts';
import type { InputItem, RenderPersona, RenderedRequest } from '../model/render.js';
import { NOW_LAYER_BANNER, RENDER_VERSION, clipTaskTitle, inputContentText, mcpIndexOf, skillIndexOf, wakeTitle } from '../model/render.ts';
import type { ContactFacts } from '../model/self-brief.ts';
import type { TurnBlockFacts } from '../model/render.js';
import { channelRenderOf, collectSessions, parseAliases, parseMemberAliases, resolvePersonNameFromTables, type SessionAlias } from '../channel/sessions.ts';
// 第四档名字（群成员档案里的自动占位名）：与运行期读的是同一份 JSON，重建侧**只读**
// （构造与 `nameOf` 都不写盘；`register`/`backfill` 才写，这里一个都不调）。
import { GroupMemberBook } from '../channel/group-members.ts';
import { WarnExemptBook, type WarnExemptJudge } from '../channel/warn-exempt.ts';
import { CONFIG_FILE_NAME, loadConfig, systemTimezone } from '../config/config.ts';
import { readEventsReadOnly } from '../log/read-only.ts';
import { loadPersona } from '../persona/loader.ts';
import { readMemoryIndexTextReadOnly } from '../persona/memory-injection.ts';
import { relationshipForWake } from '../persona/relationship.ts';
// 待办清单的唯一载体是 STATE 的两节：运行期、CLI 重放、界面预览三处都从这里读
import { openTodoItems } from '../persona/todo-state.ts';
// 技能索引（P1-16）：重建与预览都问**运行期同一个类**，不另写一份拼装
import { SkillManager } from '../skill/skills.ts';
import { catalogToolSpecs } from '../tools/catalog.ts';
import { sha256Hex } from '../persona/versions.ts';
import { deriveRequest } from './agent-loop.ts';
import { isFrameworkCommandEvent } from './slash-commands.ts';
import { EVENT_LOG_DIR_NAME } from './recover.ts';
// 会话清单那两格窗口素材（v66）：**借运行期那一个判据**，不新写一份。
// 为什么这里值一个 import：那两格是"她 7 天内回过话 / 1 小时内有人 @ 她"的折叠，
// 判据落在 `speak/sent` 与 `mentionedInMessage` 两处既有实现上；在重放侧再写一遍，
// 两条路的过滤结论迟早会漂成"预览少列一个群、而当时那一份列着它"——实测踩到过。
import { foldSpokeAndMention } from './real-loop.ts';
// 「框架自己的唤醒」判据的唯一实现（布防 / 认领 / 请求体排除三处共用）：重建只借它，不另写
import { isMemoryMaintainPayload } from './real-loop.ts';

// ───────────────────────── 进重建上下文的"那几刀"（唯一一处） ─────────────────────────

/**
 * 刀① **归属**：这条事件属于哪一条 turn 链。
 *
 * 顶层（`scope === undefined`）就是 `isTopLevelEvent`（运行期 `contextEventFilter` 的第一刀，
 * 判据只有那一份实现）；子代理链（`scope` = 父 turn 里那次 `task` 调用的 callId）则是运行期
 * 子代理 `eventFilter` 的同一句 `event.parentCallId === callId`（见 `subagent.ts`）。
 *
 * 为什么要这一刀：子代理链是它自己那条 turn 链的内部过程，进了父请求等于让父模型看见
 * "自己"没说过的话（design §4.21）。
 */
export function eventBelongsToChain(event: AppEvent, scope: string | undefined): boolean {
  return scope === undefined ? isTopLevelEvent(event) : event.parentCallId === scope;
}

/**
 * 刀③ **框架自己的唤醒**（每日整理那条定时器唤醒）：不是给她的输入，不进她的上下文。
 *
 * 判据只有一份：运行期 `real-loop.isMemoryMaintainWake` 内部的 `isMemoryMaintainPayload`
 * （布防 / 认领 / 排除三处共用）。重建这一侧照抄那句判断，只换"payload 从哪儿拿"：
 *   · 事件自己带着（`WakeTimer.payload`：到期时定时器上挂着的那个 payload，见那个类型注释）；
 *   · 否则折事件流里该 timerId 最近一条 `timer/set` 的 payload——运行期那条回退查的是
 *     **定时器表**（`timers.get(timerId)`），而表就是这些 `timer/set` 事件的投影，同一处口径。
 *
 * 为什么要这一刀（REVIEW P1-17）：运行期 `agent-loop.requestEvents` 把整理唤醒挡在请求体之外
 * （2026-10-11 用户的口径：她该看见的是效果，不是框架自己按的按钮），重建没有这一刀 ⇒
 * 每一份重建都比当时**多一行** `[定时器触发] …`，"重建==当时"当场破损。
 */
export function isFrameworkWakeEvent(
  event: AppEvent,
  timerPayloads?: ReadonlyMap<string, unknown>,
): boolean {
  if (event.type !== 'wake/timer') return false;
  if (isMemoryMaintainPayload(event.data.payload)) return true;
  const folded = timerPayloads?.get(event.data.timerId);
  return folded !== undefined && isMemoryMaintainPayload(folded);
}

/**
 * 一事件是否进重建/预览的上下文——**三刀的唯一组合点**（CLI 重放与界面预览都调它）。
 *
 *   ① 归属：同一条 turn 链（{@link eventBelongsToChain}）；
 *   ② 框架指令：整条就是一条指令的 `wake/manual`（`/compact`、`/handoff`、打错的那些）以及
 *      用户单聊里的 `/stop`——判据 `isFrameworkCommandEvent`（与运行期 `contextEventFilter`
 *      第二刀同一个函数）。指令是给框架的，她要看见的是指令的**效果**（摘要/交接笔记）；
 *   ③ 框架唤醒：每日整理那条（{@link isFrameworkWakeEvent}）。
 *
 * 为什么抽成一个导出的函数（REVIEW P1-17 的原话是"抽成一处共用，别再各写一份"）：界面
 * 那条预览路径原先自己写了一份过滤（只扣 `seq < stepStart` 与本轮唤醒），三刀**一刀都没有**
 * ——同一份日志在界面上比 CLI 重建多出框架指令行、整理唤醒行与子代理链的事件，而且不报错。
 *
 * 运行期那句组合（`contextEventFilter` + `isFrameworkWake` 注入）落在 `real-loop.ts` /
 * `agent-loop.ts`：那两个文件是别的施工线在改，本次不碰；三刀各自的**判据**仍然是同一份
 * 实现（`isTopLevelEvent` / `isFrameworkCommandEvent` / `isMemoryMaintainPayload`），
 * 重建侧只有这一处组合。
 */
export function isRebuildContextEvent(
  event: AppEvent,
  scope: string | undefined,
  timerPayloads?: ReadonlyMap<string, unknown>,
): boolean {
  if (!eventBelongsToChain(event, scope)) return false;
  if (isFrameworkCommandEvent(event)) return false;
  return !isFrameworkWakeEvent(event, timerPayloads);
}

/**
 * 技能索引（`skills/*\/SKILL.md` 的 catalog）文本：**老日志（没有 `skill/index` 快照）那一段的来源**。
 *
 * ⚠ 2026-10-11 起它**不再**是主路：从那一版开始，技能索引与 MCP 索引同一套缓存保护——
 * 字节只来自日志里的 `skill/index` 快照（见 {@link skillCatalogForReplay}）。这条函数现在只服务
 * **那一版之前写下的轮次**（那时运行期确实是每 turn 现问技能目录），保留它等于保留历史保真：
 * 同一个类、同一个基准目录、同一份信任事件——只多切一刀：**只折 `seq < throughSeq` 的那批**
 * （那之后才确认的技能，当时还没进 catalog；不切就等于让重建凭空多一段）。
 *
 * "现在这份"的限制照实写在这里：SKILL.md 是**文件**，重建读到的是当前内容（与人格资产同一条
 * 限制）。技能被改过、目录被删掉时，这一段字节会与当时不同——报告 notes 里明说这一点。
 */
export function skillCatalogForRebuild(
  baseRoot: string,
  events: readonly AppEvent[],
  throughSeq: number,
): string {
  const manager = new SkillManager({ baseRoot });
  manager.setTrustEvents(events.filter((event) => event.seq < throughSeq));
  return manager.catalogText();
}

/**
 * 重建时那一段技能索引：**新日志读快照，老日志退回当时那条来源**（2026-10-11）。
 *
 * 为什么要这一层分派（这一格的判据就是 `SkillIndexSnapshot` 注释的最后一段）：
 *   · 从这一版起，技能索引的字节**只在日志里**（`skill/index` 快照，由 `real-loop.skillIndexSync`
 *     在重大变化点写）。重建读它 = 与运行期**逐字节同源**，技能目录之后被改过/删掉也不影响；
 *   · 但**老日志没有这条事件**（这一版之前写下的轮次）——那时索引是"运行期现问技能目录"的。
 *     拿"没有快照"当"当时没有技能"会把整段历史重建成少一截的另一个请求（实测那段 2,460 字节），
 *     所以老轮次必须退回 {@link skillCatalogForRebuild}（同一个 `SkillManager` + 到那一步为止的
 *     信任事件）——那条路的有损之处（读到的是**现在**的 SKILL.md）在报告 notes 里已经说过。
 *
 * `throughSeq` 那一刀与运行期同一条口径：快照是**轮首**写的，所以"这一步之前"的那些事件里
 * 正好包含本步该用的那一份；那之后才写的（后面轮次的）不许拿来用。
 */
export function skillCatalogForReplay(
  baseRoot: string,
  events: readonly AppEvent[],
  throughSeq: number,
): string {
  const point = skillIndexOf(events.filter((event) => event.seq < throughSeq));
  if (point.seq !== 0) return point.text ?? '';
  return skillCatalogForRebuild(baseRoot, events, throughSeq);
}

// ──────────────────────────────── 定位 ────────────────────────────────

export interface TaskCardSnapshot {
  title: string;
  turn: number;
  step: number;
  todoOpen: string[];
  /**
   * 本任务相关资产那一行（v34，可选）：**取当时那条 `memory/selected.assets`**，不从盘上重算。
   * 空串 = 当时没有那一行（清单不存在 / 没挑出相关的 / 心跳拍）——那时字段整个不带上，
   * 渲染结果与引入它之前逐字节相同。
   */
  assets?: string;
}

export interface ReplayPosition {
  turn: number;
  step: number;
  /** 该次调用的 step/start 事件（三指纹：renderVersion / personaHash / model+lane 都在它身上） */
  stepStart: AppEvent & { type: 'step/start' };
  /**
   * render 的事件流：`seq < step/start.seq`、**已过那三刀**（归属 / 框架指令 / 框架唤醒，
   * 见 {@link isRebuildContextEvent}），按 seq 升序
   */
  eventsBefore: AppEvent[];
  /** 本步的新输入（仅第 1 步非 null；已从 eventsBefore 里剔除） */
  wakeEvent: AppEvent | null;
  /**
   * 本轮认领的**首条**输入（v74；每一步都非 null——第 2 步起它是"历史里那条唤醒"）。
   *
   * 为什么与 `wakeEvent` 分开：`wakeEvent` 是"首步那个新输入通道"（盖章/提及通知/标题）；
   * 位置与渲染归 `pinnedWake`（`rebuildRenderedRequest` 用这个字段 + 本轮 `turn/start` 的 seq
   * 拼出 `PinnedWake`）——与运行期 `agent-loop.runStep` 同一条口径，重放才与真实请求同源。
   */
  firstWakeEvent: AppEvent | null;
  /** 该 turn 认领的全部输入 seq（批内首条即任务卡标题来源） */
  claimedWakeSeqs: number[];
  taskCard: TaskCardSnapshot;
  /** 遮蔽点：被 compaction/summary 覆盖的最大 seq（0 表示没有摘要） */
  coveredUpToSeq: number;
}

export type LocateStepResult =
  | ({ ok: true } & ReplayPosition)
  | { ok: false; reason: string };

/** 找 `(turn, step)` 对应的 step/start；事件流假定已按 seq 升序 */
export function locateStep(events: readonly AppEvent[], turn: number, step: number): LocateStepResult {
  const stepStart = events.find(
    (event): event is AppEvent & { type: 'step/start' } =>
      event.type === 'step/start' && event.data.turn === turn && event.data.step === step,
  );
  if (stepStart === undefined) {
    const steps = events
      .filter((event) => event.type === 'step/start' && event.data.turn === turn)
      .map((event) => (event.type === 'step/start' ? event.data.step : 0));
    const hint = steps.length > 0
      ? `turn ${turn} 已记录的 step：${steps.join('、')}`
      : `日志里没有 turn ${turn} 的任何 step/start`;
    return { ok: false, reason: `找不到 turn ${turn} step ${step} 的 step/start（${hint}）` };
  }

  // 归属过滤（design §4.21）：重建「这一次调用当时看到了什么」，就必须用与运行期同一份可见性。
  // **三刀只有一处组合**（{@link contextEventsForRebuild}）：① 归属（子代理链不进父上下文）；
  // ② 框架指令（`/compact` / `/handoff` / `/stop` 不进她的上下文）；③ 框架唤醒（每日整理那条
  // 定时器唤醒——运行期 `agent-loop.requestEvents` 也是把它从**事件流**里摘掉的）。
  const scope = stepStart.parentCallId;
  const eventsBefore = contextEventsForRebuild(events, scope, stepStart.seq);

  // 该 turn 的认领：取**第一笔**。一个 turn 可以分批认领（开头一笔 + 中途被她看见的插话各一笔，
  // 见 agent-loop 的 claimInterruption），而这里要的"本轮新输入"始终是开头那一笔；
  // 取最后一笔会把打断她的那条消息当成这一轮的任务卡标题（运行期用的是开头那条，重放就会对不上）。
  let claimedWakeSeqs: number[] = [];
  for (const event of eventsBefore) {
    if (event.type === 'input/claimed' && event.data.turn === turn) {
      claimedWakeSeqs = [...event.data.wakeSeqs];
      break;
    }
  }

  const firstWakeSeq = claimedWakeSeqs[0];
  // **本轮新输入按 seq 从整份日志里取**（运行期也是 `log.get(wakeSeq)`）：它不依赖"进不进上下文"
  // ——框架自己的唤醒在事件流里被刀③挡住，而它仍可能是本轮认领的那条输入（那时它走
  // `wakeEvent` 这个**独立通道**进请求，不是历史里的一行）。
  const firstWake = firstWakeSeq === undefined
    ? null
    : events.find((event) => event.seq === firstWakeSeq) ?? null;
  // 第 1 步之外的 step 没有"本轮新输入"：它与首步看到的是同一份历史（只多了自己产生的工具结果）
  const wakeEvent = step === 1 ? firstWake : null;
  // 标题口径必须与运行期逐字节一致（agent-loop 的 taskCard 用的是 wakeTitle，不是 renderWake）。
  // payload 折的是**本步之前的整段**（不减去那三刀）：`wake/timer` 自身可能不带 payload，
  // 而标题/渲染都要它——与 `contextEventsForRebuild` 内部折的是同一份实现。
  const timerPayloads = timerPayloadsOf(events.filter((event) => event.seq < stepStart.seq));
  const title = firstWake === null ? '' : clipTaskTitle(wakeTitle(firstWake, timerPayloads));

  let coveredUpToSeq = 0;
  for (const event of eventsBefore) {
    if (event.type === 'compaction/summary' && event.data.coveredUpToSeq > coveredUpToSeq) {
      coveredUpToSeq = event.data.coveredUpToSeq;
    }
  }

  return {
    ok: true,
    turn,
    step,
    stepStart,
    eventsBefore,
    wakeEvent,
    firstWakeEvent: firstWake,
    claimedWakeSeqs,
    taskCard: {
      title,
      turn,
      step,
      // 待办清单**不在这里算**：`locateStep` 只拿事件，拿不到她的 STATE。
      // 真正把清单填进任务卡的是 `rebuildRenderedRequest`（它手里有 persona，从 STATE 那两节读）。
      // 留一个空数组在这里，是这个快照"事件侧能确定的字段"的诚实表示。
      todoOpen: [],
      // 本任务相关资产那一行（v34）：**在这一层就能确定**——它是轮首写下的结论
      // （`memory/selected.assets`），不需要她的 STATE、也不需要现在那份清单文件。
      // 从盘上重算会读到"现在这份 assets.md"，那是另一回事（"重建必须等于当时"）。
      assets: assetsFromEvents(eventsBefore, turn),
    },
    coveredUpToSeq,
  };
}

/** 该 turn 的 `memory/selected.assets`（**最后一条**；没有就是空串） */
function assetsFromEvents(events: readonly AppEvent[], turn: number): string {
  let found = '';
  for (const event of events) {
    if (event.type !== 'memory/selected' || event.data.turn !== turn) continue;
    const assets = (event.data as { assets?: unknown }).assets;
    if (typeof assets === 'string' && assets.trim() !== '') found = assets;
  }
  return found;
}

/**
 * 该 turn 注入的那一段**文本**（阶段一，2026-10-15）——三态，别把它当成"有就用、没有就退回盘上"：
 *
 *   · `{ kind: 'injected', text }`：**新事件**（有 `injected` 那一格，可能是**空串**）。
 *     空串是一个**结论**："这一轮什么都没注入"（她还没写过任何记忆 / 推荐为空）。
 *     ⚠ 这时**绝不许**退回盘上读 `MEMORIES/INDEX.md`——那份文件由 `ensureMemoryIndex` **照旧**在维护
 *     （盘上的指针表有它自己的读者），但**它已经不进请求了**。退回盘上就会把一段
 *     "当时根本没注入"的字节塞进重建结果里：实测过一次，界面预览因此比真实请求**多**
 *     整整一段旧索引（`test/channel-wire.test.ts:601` 那条用例红的）。
 *   · `{ kind: 'legacy' }`：**老事件**（2026-10-15 之前写的，没有那一格）——那时注入的是
 *     `renderMemoryIndex(buildMemoryIndex(dir))`，"盘上文件 + 确定性渲染"的函数 ⇒
 *     由调用方从盘上读回，能逐字节复原当时那一段。
 *   · 一轮**一条账都没有**（心跳轮、老日志、子代理）：也走 `legacy`——按盘上那份复原是当时的口径。
 *
 * 与 {@link assetsFromEvents} 同一条纪律：**只读事件、不改写历史**。
 */
export type InjectedIndexLookup =
  | { kind: 'injected'; text: string }
  | { kind: 'legacy' };

/**
 * 这条账是**新格式**吗（阶段一起写的那种）？
 *
 * 判据 = 带不带那三格里的**任意一格**（`injected` / `selected` / `query`）。
 * 为什么不只认 `injected`：**"这一轮什么都没注入"是新格式里一个合法的结论，而它不写空字段**
 * （与 `assets` 同一条纪律：不写空字段，老事件的形状因此逐字节不变）——
 * 只认 `injected` 会把"新的、空的"误判成老事件，于是退回盘上读 `INDEX.md`，
 * 把一段**当时根本没注入**的字节塞进重建结果（实测过一次：界面预览比真实请求多整整一段旧索引）。
 */
function isNewFormatSelection(data: Record<string, unknown>): boolean {
  return 'injected' in data || 'selected' in data || 'query' in data;
}

export function injectedIndexFromEvents(events: readonly AppEvent[], turn: number): InjectedIndexLookup {
  let found: InjectedIndexLookup | null = null;
  for (const event of events) {
    if (event.type !== 'memory/selected' || event.data.turn !== turn) continue;
    const data = event.data as unknown as Record<string, unknown>;
    // 取"最后一条"与运行期口径一致（崩溃后重投同一个 turn 时会再写一条）
    const injected = data['injected'];
    if (typeof injected === 'string') {
      found = { kind: 'injected', text: injected };
    } else if (isNewFormatSelection(data)) {
      // 新格式、但这一轮**什么都没注入**：空串是一个**结论**，不许退回盘上（见类型注释）
      found = { kind: 'injected', text: '' };
    }
  }
  return found ?? { kind: 'legacy' };
}

/**
 * 重建时"记忆那一段"该给什么文本——**两个入口共用这一处判据**（CLI 的 `buildReplayReport`
 * 与界面的 `buildReplay`），免得两条重建路径各判一次、迟早漂成"预览与重放不一样"。
 */
export function memoryIndexTextForRebuild(
  events: readonly AppEvent[],
  turn: number,
  dataDir: string,
): string {
  const lookup = injectedIndexFromEvents(events, turn);
  return lookup.kind === 'injected' ? lookup.text : readMemoryIndexTextReadOnly(dataDir);
}

/**
 * timerId → 最近一条 timer/set 的 payload（与 render 内部同口径：`wake/timer` 事件可能不带
 * payload）。导出是给**界面预览**用的：它按同一条口径折一次，才能与 CLI 的重建认下同一个
 * "框架唤醒"（{@link isFrameworkWakeEvent}）。
 */
export function timerPayloadsOf(events: readonly AppEvent[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const event of events) {
    if (event.type === 'timer/set') map.set(event.data.timerId, event.data.payload);
    if (event.type === 'timer/cancelled') map.delete(event.data.timerId);
  }
  return map;
}

/**
 * 重建/预览用的事件流：`seq < beforeSeq`、过那三刀（{@link isRebuildContextEvent}），保序。
 *
 * **两条重建路径都调它**（CLI 的重放与界面预览；P1-17 的原话是"抽成一处共用，别再各写一份"）：
 * 过滤 + 折 timer payload 这两步只有这一份实现。各写一份的结果实测过——界面预览比 CLI 重建
 * 多出框架指令行、整理唤醒行与子代理链的事件，而两边都声称是"她当时收到的请求"。
 */
export function contextEventsForRebuild(
  events: readonly AppEvent[],
  scope: string | undefined,
  beforeSeq: number,
): AppEvent[] {
  const scoped = events.filter((event) => event.seq < beforeSeq);
  const timerPayloads = timerPayloadsOf(scoped);
  return scoped.filter((event) => isRebuildContextEvent(event, scope, timerPayloads));
}

/**
 * 重建那一轮的**联络事实**（此刻层的「通道：/会话：/点名：」三项全靠它）。
 *
 * 为什么要补（2026-10-02 发现）：`rebuildRenderedRequest` 原来根本不传 `contact`，
 * 于是重放出来的此刻层少了那三项——与**当时真正发出去的请求不一致**，而"replay 必须能
 * 重建同一份请求"是本仓库的硬纪律（否则复盘的结论不算数）。
 *
 * 三样东西的来源，按能不能回到当时分：
 *   • **会话簿**：从这一刻之前的事件折（`collectSessions`）——它本来就是日志的投影，
 *     所以是**当时**的样子（比运行期那份内存副本更忠实）；
 *   • **话题**：从这一刻之前的 `channel/topic` 事件取（每个会话留最近一条）；
 *   • **唤醒的那条消息**：就是本 turn 认领的那条 `wake/channel`（`position.wakeEvent`），
 *     `mentionsMe` 也照原样带着——点名那一句正是靠它判的；
 *   • **联系人与别名**：只能拿"现在这份"（它们不在事件里），由调用方从盘上读进来。
 */
function rebuildContact(position: ReplayPosition, options: RebuildOptions): ContactFacts | null {
  const gate = options.contact;
  if (gate === undefined) return null;
  return contactFactsForReplay({
    events: position.eventsBefore,
    wakeEvent: position.wakeEvent,
    qqOfficial: gate.qqOfficial,
    onebot: gate.onebot,
    alertWebhook: gate.alertWebhook,
    ...(gate.contacts === undefined ? {} : { contacts: gate.contacts }),
    ...(gate.aliases === undefined ? {} : { aliases: gate.aliases }),
    ...(gate.memberAliases === undefined ? {} : { memberAliases: gate.memberAliases }),
  });
}

/**
 * **上一轮的"本轮新输入"**（v69）：第 1 步重建时要用它（它决定"点名"那一项在不在、
 * 以及任务卡标题是不是那句提及通知）。CLI 重建这一侧只有事件池，所以从 `input/claimed`
 * 里取本 turn 认领的**第一笔** wakeSeq，再回池子里找那条事件。
 *
 * 为什么非要它：v69 的基线是"上一步**完整**的那一层"，第 2 步的基线就是重新渲染出来的第 1 步；
 * 而第 1 步的 `点名：` 在提及那一轮是**不出现**的（那句话已经作为本轮输入摆在她面前）。
 * 不带 wakeEvent 重建第 1 步 ⇒ 基线里多一条 `点名：` ⇒ 与当时那一份逐字节不同 ⇒ 当前步
 * 会把它判成"没变"而不发（重建 ≠ 当时）。取不到就返回 null（退化成"每个字段都发"那一侧）。
 */
function firstWakeOf(pool: readonly AppEvent[], turn: number): AppEvent | null {
  for (const event of pool) {
    if (event.type !== 'input/claimed' || event.data.turn !== turn) continue;
    const wakeSeq = event.data.wakeSeqs[0];
    if (wakeSeq === undefined) return null;
    return pool.find((item) => item.seq === wakeSeq) ?? null;
  }
  return null;
}

/**
 * **同一 turn 上一步完整的那一层此刻层**（v66 引入；v69 换成 `nowLayerFull`）：CLI 重建用它，
 * 界面预览那一侧**有意不递归**（见 `web/server.ts` 里 `buildReplay` 那一段的已知边界注：
 * 那边是给人看的，CLI 这条逐字节比对的路才是要紧的那一条）。
 *
 * `build` 是"把上一步渲染出来"的回调，返回 null 表示那一步渲染不出来 ⇒ 退化成"每个字段都发"
 * （与引入这一版之前逐字节相同）。判据全在入参里（池子、turn、step），所以这个函数是纯的。
 *
 * ⚠ **池子必须是"上一步也看得见"的那一份**（`position.eventsBefore` 不行——那是本步之前的
 * 切片，连本步的 `step/start` 都在里面，而上一步的 `step/start` 恰恰不在）。
 *
 * ⚠ **必须取 `nowLayerFull` 而不是 input 里那一条此刻层 item**（v69）：后者是**裁剪过**的，
 * 被省掉的字段在下下步的基线里就不存在了 ⇒ 重建会比当时多发一行（隔步重发那条老病的镜像）。
 */
function previousNowLayerIn(
  pool: readonly AppEvent[],
  turn: number,
  step: number,
  build: (previous: { wake: AppEvent & { type: 'step/start' }; events: readonly AppEvent[] }) => RenderedRequest | null,
): string | null {
  if (step <= 1) return null;
  const found = pool.find(
    (event): event is AppEvent & { type: 'step/start' } =>
      event.type === 'step/start' && event.data.turn === turn && event.data.step === step - 1,
  );
  if (found === undefined) return null;
  let request: RenderedRequest | null;
  try {
    request = build({ wake: found, events: pool.filter((event) => event.seq < found.seq) });
  } catch {
    return null;
  }
  if (request === null) return null;
  // v69：取**完整的那一层**（未经增量裁剪）。input 里那一条是裁剪后的——拿它当基线，
  // 重建出来的下一步会"忘了"上一步被省掉的字段 ⇒ 比当时多发出一行。
  return request.nowLayerFull;
}

/**
 * **同一 turn 上一步完整的那一层此刻层**（v66 引入；v69 换口径）：逐字段增量的参照物。
 *
 * 为什么重建这一侧也要它：运行期第 ≥2 步只发"变了的字段"，而重建若把每个字段都渲染出来，
 * 第 3 步就会比当时**多出**那几行——"重建必须等于当时"是这个模块的全部意义（见文件头）。
 * 做法是把上一步**照同一条路再算一遍**（`rebuildRenderedRequest` 递归一次），取它的
 * `nowLayerFull`（**完整**那一层，不是 input 里裁剪后的那一条）。代价是每重建一步多渲染一次
 * （纯计算、不读盘），换来的是逐字节可比。
 *
 * 判据本体在 {@link previousNowLayerIn}（界面的预览走同一个函数）。
 *
 * 四条边界：
 *   · **第 1 步没有上一步** ⇒ null（运行期也是这一支：没有参照物 ⇒ 每个字段都发）；
 *   · 上一步的 `step/start` 找不到（没给池子 / 被压缩遮蔽）⇒ null（同上）；
 *   · **只递归一层**：递归调用显式传 `previousNowLayer: null`，不会无限往下钻——`nowLayerFull`
 *     本身与基线无关，所以一层就够（要完整的那一层，不要"上一步裁剪后的结果"）；
 *   · **重建上一步要用"那一步"的步号与本轮 wake**（v69）：任务卡里的 `已 M 步` 若用**当前**
 *     步号，重建出来的上一份卡片会与当前这份逐字节相同 ⇒ 当前那行会被判成"没变"而不发；
 *     第 1 步还要带上本轮 wake（`点名：` 的在场判据与提及标题都靠它）。
 */
function previousNowLayerFor(
  position: ReplayPosition,
  options: RebuildOptions,
  nowOverride: string | undefined,
): string | null {
  const pool = options.previousPool;
  if (pool === undefined) return null;
  const turn = position.stepStart.data.turn;
  const firstWake = firstWakeOf(pool, turn);
  return previousNowLayerIn(
    pool,
    turn,
    position.stepStart.data.step,
    (previous) => rebuildRenderedRequest(
      {
        ...position,
        stepStart: previous.wake,
        step: previous.wake.data.step,
        // 任务卡按**那一步**的步号重建（见上一条边界：用当前步号会让"当前任务"这一项被误省）
        taskCard: { ...position.taskCard, step: previous.wake.data.step },
        // 本轮新输入只在第 1 步有；第 ≥2 步必须是 null（渲染层据此把 wake 从历史里剔掉）
        wakeEvent: previous.wake.data.step === 1 ? firstWake : null,
        eventsBefore: [...previous.events],
      },
      options,
      undefined,
      null,
    ),
  );
}

/**
 * 重建某一刻的**联络事实**（此刻层的「通道：/会话：/点名：」三项全靠它）——CLI 与 web 两条
 * 重放路径**共用这一份**（2026-10-02：web 那条原来自己手拼渲染输入，连「会话：」「点名：」
 * 都没有；两条重放路径各拼一份，正是"重建结果不一致"的温床）。
 *
 * 三样东西的来源，按能不能回到当时分：
 *   • **会话簿**：从这一刻之前的事件折（`collectSessions`）——它本来就是日志的投影，
 *     所以是**当时**的样子（比运行期那份内存副本更忠实）；
 *   • **话题**：从这一刻之前的 `channel/topic` 事件取（每个会话留最近一条）；
 *   • **唤醒的那条消息**：就是本 turn 认领的那条 `wake/channel`，`mentionsMe` 照原样带着
 *     ——点名那一句正是靠它判的；
 *   • **联系人与别名**：只能拿"现在这份"（它们不在事件里），由调用方从盘上读进来。
 */
export function contactFactsForReplay(input: {
  events: readonly AppEvent[];
  wakeEvent: AppEvent | null;
  qqOfficial: boolean;
  onebot: boolean;
  alertWebhook: boolean;
  contacts?: ReadonlyMap<string, string>;
  aliases?: ReadonlyMap<string, SessionAlias>;
  /**
   * 群成员别名（`# 群成员` 段的裸 id = 名字）。给不给都行：
   * 这一档是"名字真源"里排在会话别名之后的第三档，而**第四档（群成员档案）在这一层拿不到**
   * ——那是 `data/group-members.json`，只有运行期那份 host 读它。所以重建侧的名字可能比当时
   * 少**最后一档**：那些**只有**机器占位名的人，重建时会写成 id。这条限制如实写在这里，
   * 不假装重建过（design §4.13 的重建纪律）。
   */
  memberAliases?: ReadonlyMap<string, SessionAlias>;
}): ContactFacts {
  const sessions = collectSessions(input.events);
  const topics = new Map<string, string>();
  for (const event of input.events) {
    if (event.type === 'channel/topic' && event.data.topic.trim() !== '') {
      topics.set(event.data.sid, event.data.topic);
    }
  }
  // 会话清单的窗口素材（v66 两格，v67 加频次的时刻表）：**用运行期同一个函数**折同一批事件
  //（`foldSpokeAndMention`，判据只此一处）。不折的后果实测过：预览里那个刚 @ 过她的群
  // 会因为"她没回过话、也没记录到提及"被滤掉，而当时真发出去的那一份列着它——
  // 而这条路的全部意义就是"重建出同一份请求"。
  const { spokeAt, mentionedAt, spokeTimes } = foldSpokeAndMention(input.events);

  const wake = input.wakeEvent;
  const wakeMessage = wake !== null && wake.type === 'wake/channel'
    ? {
      channel: wake.data.channel,
      chatType: wake.data.chatType,
      chatId: wake.data.chatId,
      person: wake.data.person,
      ...(wake.data.mentionsMe === true ? { mentionsMe: true } : {}),
    }
    : null;

  return {
    qqOfficial: input.qqOfficial,
    onebot: input.onebot,
    alertWebhook: input.alertWebhook,
    // 唤醒来源那一项与联络段里"这次是哪扇门"有关：有通道唤醒就带上它
    wakeChannel: wakeMessage === null ? null : { channel: wakeMessage.channel, chatType: wakeMessage.chatType },
    sessions,
    ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
    ...(input.contacts === undefined ? {} : { contacts: input.contacts }),
    // 发言人 → 名字（v47）：与运行期同一处判据（三档人写的表；第四档在这条路上没有，见入参注释）
    personNameOf: (person: string) =>
      resolvePersonNameFromTables(person, input.contacts, input.aliases, input.memberAliases),
    wakeMessage,
    topics,
    spokeAt,
    mentionedAt,
    spokeTimes,
  };
}

/** `MEMORIES/aliases.md` 里的别名（重建用；读不到就是空表——她还没认过人） */
function readAliasesForReplay(dataDir: string): ReadonlyMap<string, SessionAlias> {
  try {
    return parseAliases(readFileSync(join(dataDir, 'workspace', 'MEMORIES', 'aliases.md'), 'utf8'));
  } catch {
    return new Map();
  }
}

/**
 * 同一份文件里的**群成员别名**（`# 群成员` 段的裸 id = 名字）：重建通知行那个"谁"要用。
 *
 * 与 `readAliasesForReplay` 同一条纪律（只读、读不到当空），与运行期的分工也一样：运行期由
 * `real-loop.readAliasTables` 一次读、两次解析，这里为了不动既有调用点的形状，读第二次。
 * 读不到 = 那一档没有名字 ⇒ 通知行照实回落 id（**不是**错，是如实）。
 */
function readMemberAliasesForReplay(dataDir: string): ReadonlyMap<string, SessionAlias> {
  try {
    return parseMemberAliases(readFileSync(join(dataDir, 'workspace', 'MEMORIES', 'aliases.md'), 'utf8'));
  } catch {
    return new Map();
  }
}

/**
 * 重建用的豁免判据：**读现在这份** `data/warn-exempt.json`（界面改的东西，不在事件里）。
 *
 * 与 `readAliasesForReplay` 同一条纪律（只读、读不到就当空），但后果不同：这个**必须给**。
 * 不给的后果不是"少一段内容"，而是**多出一句提示**——规则命中在渲染期是现算的
 * （见 `RebuildOptions.warnExempt`），而重建与当时必须逐字节一致。
 *
 * **导出**（2026-10-04）：界面那条"重建请求体"预览（`web/server.ts` 的 `buildReplay`）走的是
 * 另一个入口，它当初漏传了这个判据，于是对豁免会话预览里多出那句提示、真实请求里没有——
 * 同一个洞在两处各修一遍迟早漂移，所以判据只留这一份实现，两条重建路径都问它。
 */
export function warnExemptJudgeOf(dataDir: string): WarnExemptJudge {
  const book = new WarnExemptBook(dataDir);
  return (subject) => book.isExempt(subject);
}

// ──────────────────────────────── 重建 ────────────────────────────────

export interface RebuildOptions {
  persona: RenderPersona & { personaHash: string };
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  timezone: string;
  /** 时间上下文的覆盖点（--diff 的右侧渲染用当前时刻；缺省取 step/start.ts） */
  now?: string;
  /**
   * **一份"上一步也看得见"的事件流**（v66）：算"同一 turn 上一步的此刻层"要用它。
   *
   * 为什么不能拿 `position.eventsBefore` 凑合：那是**本步之前**的切片，而"上一步的
   * `step/start`"恰恰不在里面（它的 seq 比本步大）——用它去找上一步永远找不到。
   * `buildReplayReport` 传的是 `located.eventsBefore`（全量那份）。不给 ⇒ 不算上一步 ⇒
   * 重建出来的此刻层**每个字段都发**（与引入这一版之前逐字节相同）。
   */
  previousPool?: readonly AppEvent[];
  /**
   * 联络事实里**只能从盘上拿**的那几样（会话簿与话题是从事件折的，见下面 rebuildContact）。
   *
   * 与人格资产同一口径：联系人与别名是"现在这份"，不是当时的快照——它们不在事件里，
   * 没法自动回到那一刻。所以报告的 notes 里要**明说**这一点（design §4.13 的重建纪律：
   * 重建不出来的东西必须自己承认，不许假装重建过）。
   */
  contact?: {
    qqOfficial: boolean;
    onebot: boolean;
    alertWebhook: boolean;
    contacts?: ReadonlyMap<string, string>;
    aliases?: ReadonlyMap<string, SessionAlias>;
    /** 群成员别名（`# 群成员` 段）——名字真源的第三档，缺省 = 那一档没有名字 */
    memberAliases?: ReadonlyMap<string, SessionAlias>;
  };
  /**
   * 数据目录（v29/B2）：重建"本轮固定块"里那段**选中的记忆正文**时要从盘上按 `path:line` 现取。
   *
   * 不给 = 那一段不出现（与"当时没有选材事件"同一条路径）。给了它，正文与运行期同源：
   * 都是从她自己的记忆文件里、那一条所在的行读出来的。
   */
  dataDir?: string;
  /**
   * 记忆索引文本（长期记忆层那一段）。与人格资产同一条限制：它是**文件**，
   * 重建时读到的是现在这份。不给 = 那一段不出现。
   *
   * ⚠ 阶段一（2026-10-15）起，**当轮事件里有 `memory/selected.injected` 时它优先**——
   * 那一格存的是"当时注入的那段文本本身"（推荐段算不回来，判据见 `injectedIndexFromEvents`）。
   * 这一格留给老日志（2026-10-15 之前：整张指针表可由盘上 `INDEX.md` 复原）与其它调用点。
   */
  memoryIndex?: string | null;
  /**
   * 技能索引文本（长期记忆层的**第一段**，design §4.19 渐进披露第 1 层）。
   *
   * 不给时由 `buildReplayReport` 走 {@link skillCatalogForReplay}：**新日志读 `skill/index`
   * 快照**（与运行期逐字节同源），**老日志退回** {@link skillCatalogForRebuild}（同一个
   * `SkillManager` + 同一个基准目录 + 到这一步为止的 `skill/installed`）。这一格留给
   * 嵌入方/测试**显式注入**。
   *
   * 为什么它原来整段缺失而没人发现：缺省（`null`）在渲染层的语义是"没有可用技能，该段不出现"
   * ——少一段不报错、不影响任何断言，只在逐字节比对时差一截（真日志实测 2,460 字节，与 REVIEW 记的 555 token 同量级）。
   */
  skillCatalog?: string | null;
  /**
   * `persona.memoryEnabled`（v32 起真的接上了执行路径，见 docs/persona.md §3.1）。
   *
   * 关掉时**固定块里的索引整段不出现**——与运行期同一条判据（real-loop 的 agentDeps 读的是
   * 同一个配置字段），而不是"重建这条路上另判一次"。盘上的 `INDEX.md` 可能还在（框架只是不再
   * 动它），但那一轮她的固定块里确实没有它，重建必须如实照做。
   *
   * 缺省（不给）= 开着：这是**出厂默认**，也是所有旧调用点（老测试、脚本）原来的行为——
   * 这一版不该让它们重建出另一串字节。
   */
  memoryEnabled?: boolean;
  /**
   * `persona.stateBudgetBytes`（v32）：此刻层那行 STATE 超预算提醒的阈值。
   *
   * 与人格资产同一条限制：它是**配置**，不在事件里，所以重建读到的是"现在这份配置"里的那个数
   *（`buildReplayReport` 从 config.json 读，报告 notes 里已就配置漂移说过一次）。
   * 不给 = `deriveRequest` 的兜底（`DEFAULT_STATE_BUDGET_BYTES`，出厂 8 KB）。
   */
  stateBudgetBytes?: number;
  /**
   * 「这条通道消息豁免吗」的判据（2026-10-04）：**重建必须与当时同源**的那一半。
   *
   * 为什么它非有不可：规则命中变成警告的第二个出口是渲染期现算（`renderExternalEvent` 的兜底
   * 扫描）——被豁免的会话在那条路上一个字都不贴。重建若不带这份判据，同一批事件就会渲染出
   * 多出那句提示的**另一串字节**（而"同一份日志重建同一份请求"是仓库的核心不变量）。
   *
   * 与联系人和别名同一条限制：豁免名单也是**文件**（`data/warn-exempt.json`，界面上改的东西），
   * 不在事件里——所以重建读到的是**现在这份**，报告 notes 里明说这一点。
   * 不给 = 谁都不豁免（"预警开着"那一侧；子代理与诊断路径就是这一支）。
   */
  warnExempt?: WarnExemptJudge | null;
}

/**
 * **本轮固定块**（v29/B2）的重建素材：`[当前状态]` + 关系档案。
 *
 * 两样都取**当前**人格资产（与 instructions 的重建口径一致：日志只留聚合哈希，
 * 逐文件历史不可解，所以"人格层的重建"本就是现在这份）。
 *
 * **没有"选中的记忆正文"那一段**（2026-10-04 用户的口径：「只看索引，如果需要，heavy 自己去读，
 * 随后跟随 tool call 留在上下文」）：固定块里关于记忆的只有 `options.memoryIndex` 那份索引。
 * 所以这里不需要 `dataDir`，也不需要 `memory/selected` 事件——重建与运行期同为"只有索引"。
 *
 * 为什么单独抽成一个函数：重建有**两个入口**——CLI 的 `rebuildRenderedRequest`
 * 与界面的 `buildReplay`。界面那个当初漏了这一整块，于是预览比真实请求少整整一条固定块
 * （而预览正是用户夜里用来看"她当时到底收到了什么"的那一屏）。把装配抽到这里、
 * 两个入口都调它，是唯一能防住"两条重建路径各写一份、迟早漂移"的做法。
 */
export function turnBlockFactsForReplay(options: RebuildOptions): TurnBlockFacts {
  return {
    state: options.persona.state,
    relationship: options.persona.relationship ?? null,
    // 记忆正文不再进固定块（见上面）：只留索引，索引由 `memoryIndex` 那条路给。
    memory: null,
  };
}

/**
 * 重建时**本轮那条唤醒**要吃的那份显示名（唤醒正文 `session=` / `sid=` / `person=` 三个标签的素材）。
 *
 * 优先级只有一条，判据也只有这一处（CLI 重放与界面预览都问它/同一套规则）：
 *   ① **新日志**：`step/start.channelRender` 有这一格（含 `null`）⇒ **原样用**。2026-10-22 起
 *      运行期把"当时解析出来的结论"记在这里（写入点是 `agent-loop.runStep`，值就是它刚递给
 *      `deriveRequest` 的那一份），所以重放拿到的 `sid` / 会话名 / 发言人名**逐字节就是当时那一份**
 *      ——这一条是本次修复的全部要点：不靠反推，靠当时记下来的事实。`null` 是"本轮不是通道轮"
 *      的**结论**，不是"没记录"，所以不能再往下走回退。
 *   ② **老日志**（没有这一格）：按盘上现在这份联系人表 / `aliases.md`（两段）/ `group-members.json`
 *      重算，判据与运行期同一处（`sessions.ts` 的 `channelRenderOf`）。**这是现在这份，不是当时那份**
 *      ——人改过名字时那一格会与当时不同，`buildReplayReport` 的 notes 里如实写了这一句。
 *   ③ 唤醒本身不是 `wake/channel`（心跳 / 定时器 / 界面消息）⇒ 没有上下文（`none`）。
 *
 * 把"用了哪一种"作为 `source` 交回去，是为了让报告能在**不重写判据**的前提下决定要不要加那条
 * "现在这份"的说明（重写一遍判据 = 迟早与这里的结论漂开）。
 */
export interface ReplayChannelRender {
  context: ChannelRenderContext | null;
  /** `recorded` = 新日志当时记的；`fallback` = 老日志按盘上重算；`none` = 本轮不是通道轮 */
  source: 'recorded' | 'fallback' | 'none';
}

export function channelRenderForReplay(
  position: ReplayPosition,
  options: {
    /** 联络事实里那三张名字表（`RebuildOptions.contact`）；缺省 = 那一档没有名字 */
    contact?: RebuildOptions['contact'] | undefined;
    /** 数据目录（第四档 `group-members.json` 从它下面只读）；缺省 = 那一档没有名字 */
    dataDir?: string | undefined;
  },
): ReplayChannelRender {
  // `!== undefined` 就是"新日志"的判据：写侧每步都写这一格（通道轮给对象、其余给 null），
  // 所以"键不在"只可能是 2026-10-22 之前的日志。
  const recorded = position.stepStart.data.channelRender;
  if (recorded !== undefined) return { context: recorded, source: 'recorded' };
  const wake = position.firstWakeEvent;
  if (wake === null || wake.type !== 'wake/channel') return { context: null, source: 'none' };
  const tables = options.contact;
  return {
    context: channelRenderOf(wake.data, {
      contacts: tables?.contacts,
      aliases: tables?.aliases,
      memberAliases: tables?.memberAliases,
      groupMemberNameOf: groupMemberNameOfForReplay(options.dataDir),
    }),
    source: 'fallback',
  };
}

/**
 * 第四档（群成员档案）的**只读**读取器：重建侧只有这一条路能拿到"群友A（群昵称：…）"这种
 * 自动占位名，而运行期 `real-loop.groupMemberName` 读的是同一份 `<dataDir>/group-members.json`。
 *
 * 只读：`GroupMemberBook` 的构造与 `nameOf` 都不写盘（`register` / `backfill` 才写，这里不调），
 * 所以"重建不建文件"那条承诺不破。没有 `dataDir`（纯内存重建的调用点）⇒ 那一档没有名字。
 */
function groupMemberNameOfForReplay(
  dataDir: string | undefined,
): ((person: string) => string | null) | undefined {
  if (dataDir === undefined) return undefined;
  const book = new GroupMemberBook(dataDir);
  return (person) => book.nameOf(person);
}

/**
 * 重建请求体。走 `deriveRequest`（与运行期同一个函数）而不是另写一份拼装逻辑：
 * 复制一份拼装代码，等于给"重建结果与当时一致"这个承诺留了一个必然漂移的副本。
 *
 * `now` 取 `step/start.ts`，`model`/`lane` 取该事件，二者都是运行期写进去的原值。
 */
export function rebuildRenderedRequest(
  position: ReplayPosition,
  options: RebuildOptions,
  nowOverride?: string,
  previousNowLayer?: string | null,
): RenderedRequest {
  /**
   * **本轮新输入的位置**（v74）：与运行期同一条口径——它从事件流里摘掉，由 `pinnedWake` 钉在
   * 本轮 `turn/start` 的 seq 处（首步=历史末尾；之后每一步同一位置，requeued 的唤醒不再跳回中段）。
   *
   * `firstWakeEvent` 在第 1 步之外也非 null（v74 加的字段）：老口径只在首步剔它的 seq，
   * 第 2 步起它就留在事件流里、按 seq 渲染——那正是"同一轮内唤醒位置被改写"的重放版本。
   */
  const pinnedWakeEvent = position.firstWakeEvent;
  let pinnedBeforeSeq = position.stepStart.seq;
  if (pinnedWakeEvent !== null) {
    for (const event of position.eventsBefore) {
      if (event.type === 'turn/start' && event.data.turn === position.turn) {
        pinnedBeforeSeq = event.seq;
        break;
      }
    }
  }
  const pinnedWake = pinnedWakeEvent === null
    ? null
    : { event: pinnedWakeEvent, beforeSeq: pinnedBeforeSeq };
  const events = pinnedWakeEvent === null
    ? [...position.eventsBefore]
    : position.eventsBefore.filter((event) => event.seq !== pinnedWakeEvent.seq);

  return deriveRequest({
    persona: {
      identity: options.persona.identity,
      constitution: options.persona.constitution,
      style: options.persona.style,
      state: options.persona.state,
      personaHash: options.persona.personaHash,
      relationship: options.persona.relationship ?? null,
    },
    tools: options.tools,
    timezone: options.timezone,
    contact: rebuildContact(position, options),
    lane: position.stepStart.data.lane,
    events,
    wakeEvent: position.wakeEvent,
    ...(pinnedWake === null ? {} : { pinnedWake }),
    // 任务卡：标题与步号取事件侧那份快照，**待办清单从她的 STATE 那两节现读**
    // （2026-10-04 合并：`todo` 工具写的就是那两节，不再有并行的 `projection.todoList`）。
    // 口径与运行期（agent-loop 的 `taskCard()`）、与界面预览（web/server.ts）**同一处实现**：
    // 三处各写一份"怎么从 STATE 里数未完成项"，迟早会漂成三种口径。
    //
    // 与人格资产同一条限制（报告里那句"人格层按当前内容重建"覆盖了它）：日志里没有逐轮的
    // STATE 快照，所以读的是**现在这份**里的那两节——漂移范围就是那两节。
    taskCard: { ...position.taskCard, todoOpen: openTodoItems(options.persona.state ?? '') },
    now: nowOverride ?? options.now ?? position.stepStart.ts,
    model: position.stepStart.data.model,
    // **本轮固定块**（v29/B2）：与运行期同一形状、与界面预览**同一份装配**
    //（见 turnBlockFactsForReplay 的注释：抽出来就是为了两个入口不再各写一份）
    turnBlock: turnBlockFactsForReplay(options),
    // 记忆索引（长期记忆层那一段）：与人格资产同一条限制——它是个**文件**，重建读到的是现在这份。
    // 走只读那条路（readMemoryIndexTextReadOnly）：重建不能创建文件，"只读重建"是这个模块的承诺。
    //
    // **关掉框架代管记忆时给 null**（`options.memoryEnabled`，见 docs/persona.md §3.1）：
    // 判据与运行期（real-loop 的 agentDeps）**同一个配置字段**，不另写一份（`buildReplayReport`
    // 从 config.json 读一次、传进来；界面预览那条路读的是同一个字段）。关掉之后盘上的 INDEX.md
    // 可能还在（框架只是不再动它），照旧把它渲染进重建结果就等于让重建显示一份"她当时根本没看见"
    // 的东西——而"重建必须等于当时"是这个模块的全部意义。
    memoryIndex: options.memoryEnabled === false ? null : (options.memoryIndex ?? null),
    // 技能索引（长期记忆层的第一段）：**与 MCP 索引同一套缓存保护**（2026-10-11）——
    // 新日志的字节只在日志里（`skill/index` 快照），老日志退回当时的来源
    // （`skillCatalogForReplay`，判据与理由写在那一处）。这一格原来压根没传：缺省 null 在渲染层
    // 是"没有可用技能"（该段不出现），于是重建每份请求都少一截而不报错。
    skillCatalog: options.skillCatalog ?? null,
    // MCP 常驻索引（v46）：**取当时那一版**——最后一条 `mcp/index` 快照（`mcpIndexOf` 扫的是
    // 本步之前的事件流，与运行期读"最后一条"同一判据）。**老轮次没有这条事件 ⇒ null ⇒
    // 那一段整段不出现**，重建结果与当时逐字节相同（这是硬判据，不许拿现在的配置去补写）。
    mcpIndex: mcpIndexOf(events).text,
    // STATE 预算（v32）：重建要用的阈值与运行期同一个来源（当时生效的那份 config.json）。
    // 缺省 = 出厂 8 KB（`deriveRequest` 的兜底）；CLI 与界面两条重建路都从这里进，口径一致。
    ...(options.stateBudgetBytes === undefined ? {} : { stateBudgetBytes: options.stateBudgetBytes }),
    // 上一步的此刻层（v66 引入；v69 起是**完整的那一层**）：逐字段增量（不变的那些不发）要一个
    // 参照物，而那个参照物就是**同一 turn 上一步那一条 `nowLayerFull`**（运行期从
    // `RenderedRequest.nowLayerFull` 存下来，见 agent-loop 的 `previousNow`）。给了就用；
    // 没给且这不是第 1 步 ⇒ 现算一次（见 `previousNowLayerFor`）——不这样，重建出来的第 3 步
    // 会比当时**多出**那些"其实没发"的字段，而"重建等于当时"是这个模块的全部意义。
    previousNowLayer: previousNowLayer
      ?? previousNowLayerFor(position, options, nowOverride),
    // 豁免判据：与人格/别名同一条"现在这份"的限制，但**必须传**——不传就会多渲染出那句
    // 规则提示，重建与当时逐字节一致这条承诺当场作废（见 RebuildOptions.warnExempt）。
    warnExempt: options.warnExempt ?? null,
    // 本轮通道消息的名字（v76 留下的那个洞，2026-10-22 补齐）：**优先读当时记在 `step/start`
    // 里的 `channelRender`**——运行期把解析结果记进那一格，所以重建拿到的就是**当时那一份**，
    // 不必拿现在的别名表反推（"重放缺 session=/sid="正是反推补不齐的后果）。
    // 老日志没有那一格 ⇒ 退回按盘上现在这份重算，报告 notes 里明说那是"现在这份，不是当时那份"
    //（判据与回退都收在 `channelRenderForReplay` 一处，这里只取结论）。
    // 它只作用于**本轮钉住的那条**唤醒（render.ts 的 contextFor），历史段一个字节都不吃它。
    channelRender: channelRenderForReplay(position, options).context,
    // 软提示不落库（见文件头）：这里只能是 null，并在报告里明说
    softHint: null,
  });
}

/**
 * 取该 turn 的**记忆索引注入账**（**最后一条** `memory/selected`）；没有就是 null。
 *
 * 2026-10-04 起它只是账（记"注入了没有 + 当时那份索引的指纹与条数"）：固定块里那段索引由
 * `RebuildOptions.memoryIndex` 从盘上读回（运行期与重放同源），所以重建**不再需要**它来装配请求。
 * 留着这个读取口是给诊断/审计用的——事后要回答"这一轮到底注入了没有、注进去的是哪一版"，
 * 只有它答得上来（盘上的索引是**现在**那份，未必等于当时那份）。
 *
 * 事件在**轮首**写下，所以正常情形下它落在 `eventsBefore` 里（seq 小于该 turn 的每个 step/start）。
 * 取"最后一条"与运行期的读取口径一致：崩溃后重投同一个 turn 时可能再写一条，
 * 两条里最后那条才是这一轮实际用的。
 */
export function lastMemorySelection(position: ReplayPosition): MemorySelected['data'] | null {
  let found: MemorySelected['data'] | null = null;
  for (const event of position.eventsBefore) {
    if (event.type === 'memory/selected' && event.data.turn === position.turn) {
      found = event.data as MemorySelected['data'];
    }
  }
  return found;
}

// ──────────────────────────────── 并排对照 ────────────────────────────────

export interface RequestDiff {
  identical: boolean;
  instructionsChanged: boolean;
  inputCounts: { left: number; right: number };
  /** 第一处不同的位置（逐项比较 input，按 render 的装配顺序） */
  firstDifference: { index: number; left: string | null; right: string | null } | null;
  changedItems: number;
  tools: { onlyLeft: string[]; onlyRight: string[]; changed: string[] };
  bytes: { left: number; right: number };
}

/** 逐项对照两份请求体：左 = 当时重建，右 = 当前口径（renderVersion / personaHash / 工具清单） */
export function diffRenderedRequests(left: RenderedRequest, right: RenderedRequest): RequestDiff {
  const changed = new Set<number>();
  const max = Math.max(left.input.length, right.input.length);
  let first: RequestDiff['firstDifference'] = null;
  for (let index = 0; index < max; index++) {
    const a = left.input[index];
    const b = right.input[index];
    if (sameItem(a, b)) continue;
    changed.add(index);
    if (first === null) {
      first = { index, left: a === undefined ? null : describeItem(a), right: b === undefined ? null : describeItem(b) };
    }
  }

  const leftTools = new Map(left.tools.map((tool) => [tool.name, tool]));
  const rightTools = new Map(right.tools.map((tool) => [tool.name, tool]));
  const onlyLeft: string[] = [];
  const onlyRight: string[] = [];
  const changedTools: string[] = [];
  for (const [name, tool] of leftTools) {
    const other = rightTools.get(name);
    if (other === undefined) onlyLeft.push(name);
    else if (JSON.stringify(tool) !== JSON.stringify(other)) changedTools.push(name);
  }
  for (const name of rightTools.keys()) if (!leftTools.has(name)) onlyRight.push(name);

  return {
    identical: changed.size === 0
      && left.instructions === right.instructions
      && onlyLeft.length === 0 && onlyRight.length === 0 && changedTools.length === 0
      && left.model === right.model,
    instructionsChanged: left.instructions !== right.instructions,
    inputCounts: { left: left.input.length, right: right.input.length },
    firstDifference: first,
    changedItems: changed.size,
    tools: { onlyLeft, onlyRight, changed: changedTools },
    bytes: { left: jsonBytes(left), right: jsonBytes(right) },
  };
}

function sameItem(a: InputItem | undefined, b: InputItem | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 单条 input item 的单行描述：只给类型与首行摘要，避免把整段历史打到终端 */
function describeItem(item: InputItem): string {
  switch (item.type) {
    case 'message': {
      const text = inputContentText(item.content);
      // v23 起此刻层以**固定段头**两行开头（51 + 53 字的分隔线与归属说明）。它对诊断没有信息量，
      // 却会把 60 字的预览位占满——终端上于是只剩一串破折号，看不出这是哪一拍的此刻层。
      // 所以预览时剥掉段头，从第一个字段（`时刻：…`）说起。
      const body = text.startsWith(NOW_LAYER_BANNER) ? text.slice(NOW_LAYER_BANNER.length).trimStart() : text;
      const head = body.replace(/\s+/gu, ' ').slice(0, 60);
      return `message[${item.role}] ${head}${body.length > 60 ? '…' : ''}`;
    }
    case 'function_call': return `function_call ${item.name}(${item.call_id})`;
    case 'function_call_output': return `function_call_output ${item.call_id}（${item.output.length} 字符）`;
    // 思维链以 reasoning item 回传（render v3）：终端里只报字数，不进内容
    case 'reasoning': {
      const chars = item.content.reduce((sum, part) => sum + part.text.length, 0);
      return `reasoning（${chars} 字符）`;
    }
  }
}

/**
 * 请求体字节数：与发送前序列化同一口径（JSON UTF-8），缓存命中按前缀字节判定。
 *
 * 只数**发往模型的那四个键**（model / instructions / input / tools）：`RenderedRequest` 上
 * 还有 2026-10-03 加的 `context`（渲染副产物，见 model/context-audit.ts），而
 * `agent-loop` 的 `toDsRequest` 显式装配时并不会把它发出去——把它算进"请求体字节"，
 * 这个数就不再是缓存前缀的那个数了。
 */
export function jsonBytes(request: RenderedRequest): number {
  return Buffer.byteLength(JSON.stringify({
    model: request.model,
    instructions: request.instructions,
    input: request.input,
    tools: request.tools,
  }), 'utf8');
}

export function formatRequestDiff(diff: RequestDiff): string[] {
  const lines: string[] = [];
  lines.push(
    `字节：当时 ${diff.bytes.left} / 当前 ${diff.bytes.right}`
    + `${diff.identical ? '（逐字段一致）' : ''}`,
  );
  lines.push(
    `input 条数：当时 ${diff.inputCounts.left} / 当前 ${diff.inputCounts.right}`
    + `（不同 ${diff.changedItems} 条）`,
  );
  lines.push(`instructions：${diff.instructionsChanged ? '已变化（人格常驻层或任务卡不同）' : '一致'}`);
  if (diff.firstDifference !== null) {
    lines.push(`首个差异 @${diff.firstDifference.index}:`);
    lines.push(`  - 当时：${diff.firstDifference.left ?? '（无此条）'}`);
    lines.push(`  + 当前：${diff.firstDifference.right ?? '（无此条）'}`);
  }
  const toolParts: string[] = [];
  if (diff.tools.onlyLeft.length > 0) toolParts.push(`仅当时有：${diff.tools.onlyLeft.join('、')}`);
  if (diff.tools.onlyRight.length > 0) toolParts.push(`仅当前有：${diff.tools.onlyRight.join('、')}`);
  if (diff.tools.changed.length > 0) toolParts.push(`定义变化：${diff.tools.changed.join('、')}`);
  lines.push(`工具清单：${toolParts.length === 0 ? '一致' : toolParts.join('；')}`);
  return lines;
}

// ──────────────────────────────── 报告装配（CLI 的 replay 命令） ────────────────────────────────

export interface ReplayReportOptions {
  /** config.json 所在目录（默认 process.cwd()）；**只读**：不存在不创建 */
  cwd?: string;
  /**
   * 技能根基准目录（`skills/`、`.agents/skills/` 的父目录）；缺省 = **`dataDir`**。
   *
   * 为什么缺省是 `dataDir`：运行期那份 `SkillManager` 建在数据目录上（v79 起，`main.ts`），
   * 技能实体住在 `<dataDir>/skills`——重建必须扫同一串根，"CLI 重建看到的技能"才是
   * "她当时看到的技能"（REVIEW P1-16）。web 侧显式传 `deps.skillsRoot`（生产 = 同一个数据
   * 目录），CLI 不传即走这里这个缺省。
   */
  skillsRoot?: string;
  /** 技能索引文本覆盖点（测试与嵌入方注入）；缺省按**当前**技能目录 + 到该步为止的信任事件重建 */
  skillCatalog?: string | null;
  /** 工具清单覆盖点（测试与嵌入方注入）；缺省用当前装配（tools/catalog.ts） */
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  /** 工具清单视角，默认与真实循环一致（不列破坏性工具） */
  includeDestructive?: boolean | readonly string[];
  /** 时区覆盖点；缺省读 config.json，再退到系统时区 */
  timezone?: string;
  /** --diff 右侧渲染用的时刻（默认此刻）；缺省右侧 = 当时口径 */
  compareNow?: string;
}

export interface ReplayReport {
  dataDir: string;
  turn: number;
  step: number;
  stepStart: {
    seq: number;
    ts: string;
    model: string;
    lane: ModelLane;
    renderVersion: string;
    personaHash: string;
  };
  /** 三指纹比对：当时记录 vs 当前口径 */
  fingerprints: {
    renderVersion: { recorded: string; current: string; matches: boolean; note: string };
    personaHash: { recorded: string; current: string; matches: boolean; note: string };
    configHash: { recorded: string | null; current: string | null; matches: boolean | null; source: string };
  };
  tools: { count: number; digest: string; source: 'current-catalog'; problems: string[] };
  /**
   * 长期记忆层里**技能索引**那一段的读数（REVIEW P1-16）。
   *
   * 为什么要一格读数：这一段原来整段缺失而**不报错**（缺省 null 的语义是"没有可用技能"），
   * 只能靠逐字节比对发现。有了字节数，"重建比当时少一截"这件事在报告里直接看得见。
   */
  skills: { bytes: number };
  events: {
    scanned: number;
    /** 参与渲染的事件条数（= seq < step/start.seq、且过了那三刀的条数） */
    inStream: number;
    /** 被那三刀挡掉、但 seq 仍小于 step/start 的事件条数（归属 / 框架指令 / 框架唤醒） */
    filteredOut: number;
    rendered: number;
    coveredUpToSeq: number;
    wakeSeq: number | null;
    claimedWakeSeqs: number[];
    todoOpen: number;
  };
  /** 当时口径重建出来的请求体 */
  request: RenderedRequest;
  /** 与当前时刻重渲染的并排对照 */
  diff: RequestDiff;
  notes: string[];
}

export type ReplayBuildResult = { ok: true; report: ReplayReport } | { ok: false; error: string };

/**
 * 装配一份 replay 报告。人读的摘要在 `formatReplaySummary`，JSON 就是 `report.request`。
 *
 * 一条如实报告的纪律：**人格层不可从版本库自动重组**。`step/start` 只记录整份人格资产的
 * 聚合哈希，而版本库是按文件内容寻址的逐文件快照——从聚合哈希反推"四个文件当时各自的版本"
 * 是个不可解的搜索。所以人格不匹配时用当前内容重建，并在 `fingerprints.personaHash.note`
 * 里说清"这份重建的人格层是当前内容"，而不是悄悄拿错的东西冒充历史。
 */
export async function buildReplayReport(
  dataDir: string,
  turn: number,
  step: number,
  options: ReplayReportOptions = {},
): Promise<ReplayBuildResult> {
  const scan = readEventsReadOnly(join(dataDir, EVENT_LOG_DIR_NAME));
  const located = locateStep(scan.events, turn, step);
  if (!located.ok) return { ok: false, error: located.reason };

  const stepStart = located.stepStart;
  const recordedPersonaHash = stepStart.data.personaHash;
  const recordedRenderVersion = stepStart.data.renderVersion;

  const current = loadPersona(dataDir);
  const personaMatches = current.personaHash === recordedPersonaHash;

  const toolResult = options.tools !== undefined
    ? { specs: options.tools, problems: [] as string[] }
    : options.includeDestructive === undefined
      ? await catalogToolSpecs(dataDir)
      : await catalogToolSpecs(dataDir, { includeDestructive: options.includeDestructive });
  const tools = toolResult.specs;

  // 时区：config.json → 系统时区。CLI 不造配置（loadConfig 会写默认配置，那是启动期行为）
  const cwd = options.cwd ?? process.cwd();
  let timezone = options.timezone ?? null;
  let configCurrent: string | null = null;
  let configSource = 'none';
  let contactGate: RebuildOptions['contact'];
  // v32：框架代管记忆的总开关与 STATE 字节预算都从**盘上那份配置**读（与联系人表、豁免名单
  // 同一条"不在事件里、只能取现在这份"的口径）。两个字段的判据只有这一处实现，界面预览
  //（web/server.ts）读的是同一个字段名——两条重建路径不许各写一份。
  let memoryEnabled = true;
  let stateBudgetBytes: number | undefined;
  const configPath = join(cwd, CONFIG_FILE_NAME);
  if (existsSync(configPath)) {
    try {
      const loaded = await loadConfig(cwd);
      configCurrent = loaded.configHash;
      configSource = 'config.json';
      if (timezone === null) timezone = loaded.config.timezone;
      memoryEnabled = loaded.config.persona.memoryEnabled;
      stateBudgetBytes = loaded.config.persona.stateBudgetBytes;
      // 联络事实里"只能从盘上拿"的那几样（联系人表、别名表、两条通道开没开）：
      // 会话簿与话题由 rebuildContact 从事件折，其余只能取**现在**这份——报告里会明说。
      contactGate = {
        qqOfficial: loaded.config.channels.qqOfficial.enabled,
        onebot: loaded.config.channels.onebot.enabled,
        alertWebhook: (loaded.config.alerts.webhookUrl ?? '') !== '',
        contacts: new Map(Object.entries(loaded.config.persona.contacts)),
        aliases: readAliasesForReplay(dataDir),
        memberAliases: readMemberAliasesForReplay(dataDir),
      };
    } catch (err) {
      configSource = `config.json 不可用：${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (timezone === null) timezone = systemTimezone();

  // 「当时」的 configHash：取 seq ≤ step/start.seq 的最后一条 session/start 或 config/changed
  let configRecorded: string | null = null;
  for (const event of located.eventsBefore) {
    if (event.type === 'session/start') configRecorded = event.data.configHash;
    if (event.type === 'config/changed') configRecorded = event.data.configHash;
  }

  // 情景档案：与 real-loop 共用同一份路由判据（带人唤醒命中 RELATIONSHIPS/<who>.md）
  const relationship = relationshipForWake(located.wakeEvent, dataDir);
  const persona = {
    identity: current.identity,
    constitution: current.constitution,
    style: current.style,
    state: current.state,
    personaHash: current.personaHash,
    relationship,
  };

  // 技能索引（长期记忆层的第一段）：**新日志读快照、老日志退回当时的来源**——
  // 分派判据只写在 `skillCatalogForReplay` 一处（这一版起与 MCP 索引同一套缓存保护）。
  //
  // v79：缺省基准是**数据目录**（运行期那份 `SkillManager` 建在 `<dataDir>` 上，技能实体
  // 住在 `<dataDir>/skills`）——重建必须扫同一串根，否则"CLI 重放看到的技能"与"她当时
  // 看到的"是两份东西（本次搬迁前缺省是 cwd，那条路只对"技能住在安装目录"的老日志成立）。
  const skillCatalog = options.skillCatalog !== undefined
    ? options.skillCatalog
    : skillCatalogForReplay(options.skillsRoot ?? dataDir, scan.events, stepStart.seq);

  const request = rebuildRenderedRequest(
    located,
    {
      persona, tools, timezone,
      // v29/B2：固定块里的记忆那一段——**优先取当轮事件里那份原文**（阶段一：推荐段算不回来），
      // 老事件才从盘上读回（只读，不建文件）。`dataDir` 仍要传：重建联系人/别名那条路要用它。
      dataDir,
      memoryIndex: memoryIndexTextForRebuild(located.eventsBefore, located.turn, dataDir),
      // 技能索引：与运行期同一份来源（见上），两条重建（当时口径 / --diff 右栏）**用同一串字节**
      // ——右栏若少了它，差异报告会把"装配缺失"说成"当前口径变了"
      skillCatalog,
      // v32：框架代管记忆的总开关与 STATE 字节预算，都照**盘上那份配置**判（上面读一次）。
      // 与运行期同一个字段、同一条口径：关掉时重建出来的固定块里没有索引——那才是她当时看到的。
      memoryEnabled,
      ...(stateBudgetBytes === undefined ? {} : { stateBudgetBytes }),
      // 豁免名单也是盘上的东西（界面在改），与别名/联系人同一条口径：**读现在这份**。
      // 判据本身只有一处实现（WarnExemptBook.isExempt），这里只把它递给重建。
      warnExempt: warnExemptJudgeOf(dataDir),
      ...(contactGate === undefined ? {} : { contact: contactGate }),
      // 上一步的此刻层要一份"全量"事件流才找得到（见 `RebuildOptions.previousPool`）
      previousPool: located.eventsBefore,
    },
  );
  const compareRequest = rebuildRenderedRequest(
    located,
    {
      persona, tools, timezone,
      now: options.compareNow ?? new Date().toISOString(),
      dataDir,
      memoryIndex: memoryIndexTextForRebuild(located.eventsBefore, located.turn, dataDir),
      skillCatalog,
      memoryEnabled,
      ...(stateBudgetBytes === undefined ? {} : { stateBudgetBytes }),
      warnExempt: warnExemptJudgeOf(dataDir),
      ...(contactGate === undefined ? {} : { contact: contactGate }),
      previousPool: located.eventsBefore,
    },
  );

  /**
   * 本轮那条唤醒的显示名是**从哪儿来的**：新日志 = 当时记在 `step/start.channelRender` 里的结论
   * （精确）；老日志 = 按盘上现在这份重算（回退，必须如实说）。判据与重建请求里用的是同一处
   * （`channelRenderForReplay`），这里只是把结论写进报告——不另判一次，免得两处结论漂开。
   */
  const channelRenderSource = channelRenderForReplay(located, {
    contact: contactGate,
    dataDir,
  }).source;

  const notes: string[] = [
    '软阈值提示（budget softHint）按设计不落库，重建结果不含它——字节差异里可能恰好少这一条',
    '工具清单取自当前装配（tools/catalog.ts）：日志只记工具增减的名字，不记定义',
    `时间上下文取 step/start.ts（${stepStart.ts}）；--diff 右侧用当前时刻，状态层的时间行必然不同`,
    // 联络事实拆成两半：会话簿/话题按当时的事件重建，联系人与别名只能取现在这份
    '此刻层的「会话」「点名」按**当时**的事件重建（会话簿由 wake/channel 折、话题取 channel/topic）；'
    + '「通道」里的**联系人表与别名表用的是现在这份**（它们不在事件里），人改过名字时那一句会与当时不同',
    // 豁免名单同属"不在事件里、只能取现在这份"，但它影响的是**有没有那句框架提示**：
    // 不写这一条，开关前后重建出来的字节差异会被当成"渲染 bug"查半天
    '框架预警的**豁免名单**（data/warn-exempt.json）不在事件里，重建用的是**现在这份**：'
    + '开关改过之后，重建结果里那条消息可能比当时多（或少）一句规则层的框架提示',
    // 三件"只存在于运行期"的事实：它们不是事件，日志里没有。不写这一条，看重建结果的人就会把
    // 「未知」读成"当时就是这样"——那是把重建的局限当成事实。
    '此刻层的「本机」「用度」只存在于运行期（进程/磁盘/投影的瞬时值不落日志）：'
    + '重建结果里它们写「未知」或不出现，与当时的真值不同；要看真值请查 step/start 前后的 budget/consumed 事件与进程日志',
    // 固定块里的记忆索引与人格资产同一条限制，说清漂移范围
    '本轮固定块里的**记忆索引**（MEMORIES/INDEX.md 的渲染形态）与人格资产同一条限制：'
    + '它是个文件，重建时读到的是**现在**这份。索引只含指针（路径 + 行号 + 一行摘要），'
    + '所以漂移的范围是那些指针行，不是记忆正文；'
    + '要核对"当时注进去的是哪一版"，看该 turn 的 `memory/selected.indexHash`',
    // 2026-10-04 起固定块里**没有**"选中的记忆正文"那一段（只给索引，正文她按需 safe_read）：
    // 所以重建不需要、也不该再声称"按当时选的那几条现取正文"
    '固定块里**只有索引**（不注入记忆正文）：正文由她自己 `safe_read` 现取，'
    + '所以它不在固定块里，而在本次请求的历史段（工具结果）里',
  ];
  // 本轮唤醒的显示名走了**旧日志回退**时必须如实说："这是现在这份，不是当时那份"——否则
  // 重放里那个名字会被读成"当时她看到的就是它"，那是把重建的边界当成了事实。
  // 新日志不走这一支：`step/start.channelRender` 记的就是当时那份，逐字节可复算。
  if (channelRenderSource === 'fallback') {
    notes.push('本轮唤醒的显示名（`session=`/`sid=`/`person=`）走的是**旧日志回退**：'
      + '这份日志的 `step/start` 还没有 `channelRender` 那一格，重建按盘上现在这份联系人表 / '
      + 'aliases.md（会话别名 + 群成员别名）/ group-members.json 重算——'
      + '**这是现在这份，不是当时那份**（人改过名字时那一格会与当时不同）');
  }
  // 关掉框架代管记忆时索引整段不出现——这一条要写出来，否则"重建结果里没有索引"会被当成漏装配。
  // 判据是上面读进来的那个值（与重建装配用的是同一个），不是另算一次。
  if (!memoryEnabled) {
    notes.push('框架代管记忆已关（config.json 的 persona.memoryEnabled = false）：'
      + '重建结果里**没有**记忆索引那一段，与运行期一致；'
      + '盘上若还留着 MEMORIES/INDEX.md，那是历史文件，框架不再重建也不再注入它');
  }
  if (!personaMatches) {
    notes.push(`当时的人格资产（${recordedPersonaHash.slice(0, 8)}）与当前（${current.personaHash.slice(0, 8)}）不同：`
      + '人格层已按当前内容重建，逐文件历史请用 persona diff/log 从版本库比对');
  }
  if (recordedRenderVersion !== RENDER_VERSION) {
    notes.push(`当时的渲染模板版本 ${recordedRenderVersion} 与当前 ${RENDER_VERSION} 不同：`
      + '渲染代码只有一份，重建只能用当前模板，字节差异的根因在这里');
  }
  if (toolResult.problems.length > 0) {
    notes.push(`工具集装配有 ${toolResult.problems.length} 处问题：${toolResult.problems.slice(0, 3).join('；')}`);
  }
  // 技能索引那一段的"现在这份"限制（REVIEW P1-16）：不写这一条，"重建里技能少了/多了"会被
  // 当成装配 bug 查半天——与人格资产同一条限制，如实写在这里。
  notes.push('技能索引（长期记忆层的第一段）按**现在这份** `skills/` 目录 + 到这一步为止的 '
    + '`skill/installed` 重建：SKILL.md 改过内容、技能目录被删掉/新装（还没确认）时，'
    + '这一段字节会与当时不同');

  // 那三刀挡掉了多少条（seq 仍小于 step/start 的读数）：回答"重建的事件集与日志差多少"。
  // 少了这个数，"重建==当时"一旦破损只能靠逐字节比对发现——而它正是 P1-17 那条的代价。
  const rawBefore = scan.events.filter((event) => event.seq < stepStart.seq).length;
  const filteredOut = Math.max(0, rawBefore - located.eventsBefore.length);

  return {
    ok: true,
    report: {
      dataDir,
      turn,
      step,
      stepStart: {
        seq: stepStart.seq,
        ts: stepStart.ts,
        model: stepStart.data.model,
        lane: stepStart.data.lane,
        renderVersion: recordedRenderVersion,
        personaHash: recordedPersonaHash,
      },
      fingerprints: {
        renderVersion: {
          recorded: recordedRenderVersion,
          current: RENDER_VERSION,
          matches: recordedRenderVersion === RENDER_VERSION,
          note: '模板变更 = 一次缓存全 miss；重建只能用当前模板代码',
        },
        personaHash: {
          recorded: recordedPersonaHash,
          current: current.personaHash,
          matches: personaMatches,
          note: personaMatches ? '人格与当时一致' : '人格与当时不同（用当前内容重建）',
        },
        configHash: {
          recorded: configRecorded,
          current: configCurrent,
          matches: configRecorded !== null && configCurrent !== null ? configRecorded === configCurrent : null,
          source: configSource,
        },
      },
      tools: {
        count: tools.length,
        digest: sha256Hex(JSON.stringify(tools)),
        source: 'current-catalog',
        problems: toolResult.problems,
      },
      skills: { bytes: Buffer.byteLength(skillCatalog ?? '', 'utf8') },
      events: {
        scanned: scan.events.length,
        inStream: located.eventsBefore.length,
        filteredOut,
        rendered: request.input.length,
        coveredUpToSeq: located.coveredUpToSeq,
        wakeSeq: located.wakeEvent?.seq ?? null,
        claimedWakeSeqs: located.claimedWakeSeqs,
        todoOpen: located.taskCard.todoOpen.length,
      },
      request,
      diff: diffRenderedRequests(request, compareRequest),
      notes,
    },
  };
}

/** 人读摘要：三指纹 + 事件规模 + 请求规模 */
export function formatReplaySummary(report: ReplayReport): string[] {
  const lines: string[] = [
    `重放 · turn ${report.turn} step ${report.step}（step/start seq ${report.stepStart.seq} @ ${report.stepStart.ts}）`,
    `模型：${report.stepStart.model}（${report.stepStart.lane}）`,
    `指纹 renderVersion：记录 ${report.stepStart.renderVersion} / 当前 ${RENDER_VERSION}`
    + ` → ${report.fingerprints.renderVersion.matches ? '一致' : '不一致'}`,
    `指纹 personaHash：记录 ${report.stepStart.personaHash.slice(0, 16)} / 当前 ${report.fingerprints.personaHash.current.slice(0, 16)}`
    + ` → ${report.fingerprints.personaHash.matches ? '一致' : '不一致'}`,
    `指纹 configHash：记录 ${short(report.fingerprints.configHash.recorded)}`
    + ` / 当前 ${short(report.fingerprints.configHash.current)}`
    + ` → ${report.fingerprints.configHash.matches === null ? '无法比对' : report.fingerprints.configHash.matches ? '一致' : '不一致'}`,
    `事件流：参与渲染 ${report.events.inStream} 条（扫描 ${report.events.scanned} 条`
    + `${report.events.filteredOut > 0 ? ` · 三刀挡掉 ${report.events.filteredOut} 条` : ''}）`
    + ` · 本轮新输入 ${report.events.wakeSeq === null ? '（无，非首步）' : `seq ${report.events.wakeSeq}`}`
    + ` · 遮蔽点 seq ${report.events.coveredUpToSeq}`,
    `请求体：${report.request.input.length} 条 input · ${jsonBytes(report.request)} 字节`
    + ` · 工具 ${report.tools.count} 件（digest ${report.tools.digest.slice(0, 12)}）`
    + ` · 技能索引 ${report.skills.bytes} 字节`,
  ];
  for (const note of report.notes) lines.push(`注：${note}`);
  return lines;
}

function short(value: string | null): string {
  return value === null ? '（无记录）' : value.slice(0, 16);
}
