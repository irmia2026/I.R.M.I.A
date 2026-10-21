/**
 * Irmia Agent — 交接笔记（handoff note）
 *
 * 依据：docs/persona.md §4（连续性：交接笔记）、docs/design.md §4.11 / §4.13、
 * docs/milestones.md M5-2。算法照搬 Cortico `bots/cormini/persona/handoffNote.ts`，
 * 五条规则逐条落地：
 *   1. 收录范围：user 消息、事件帧（wake/*）、工具入参与回执。
 *      不收：assistant 正文、思维链（message/reasoning）、上一份笔记（compaction/summary）、
 *      纯流程类调用（flow 工具：定时器布防、告警、发言——只推进流程，不带交接信息）。
 *   2. 预算按年龄衰减：最近 1/4 条目给满单条预算（foldTokens，默认 1024），往前 1/4 给 1/4，
 *      更早只留开头（1/16，下限 48 token 估算）。
 *   3. 去重：状态类条目（快照类工具、心跳）按 key 只留最新一次；逐字重复的条目合并并
 *      标注"(同样的一条重复了 N 次)"。
 *   4. 装配：从最近往远装入总预算（budgetTokens，默认 4096），装不下的早期条目只记数量。
 *   5. 分段：按时间切"历史"与"最近"两段，各标明时间范围（ISO 时刻原样，不做相对时间）。
 *
 * 两条硬约束：
 * - **纯函数、确定性**（缓存铁律 1）：本模块不读时钟、不读文件、不引随机。时间一律取自事件
 *   自带的 ts，分区参照时刻缺省取最新条目的 ts。同一批事件在任何时刻、任何机器上渲染出
 *   同一字节串——它是 `compaction/summary` 的正文来源，而遮蔽段渲染必须唯一确定（§4.13）。
 * - **总预算硬保证**：返回文本的 token 估算 ≤ budgetTokens（装配时逐条试探，末尾再削一轮，
 *   最后用 foldToBudget 兜底），因此笔记可以安全地放进状态层而不挤爆上下文。
 *
 * token 估算口径与 tools/registry.ts 的 `estimateTokens` 同源（design §4.12：中文约 1.5 字/token、
 * 英文约 4 字符/token），测试里对同一批样本断言两者逐值一致，防止两处口径悄悄漂移。
 *
 * 约定：值导入写 `.ts`（Node 的 --experimental-strip-types 只擦类型、不改写路径解析），
 * 纯类型导入写 `.js`。
 */

import type { AppEvent, WakeJob } from '../log/types.js';
import { formatExact } from '../format/units.ts';
import { reasoningEchoOf, renderExternalEvent, renderWake, wakeTitle } from '../model/render.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 笔记总预算（token 估算）：persona.md §4 默认 4096 */
export const DEFAULT_HANDOFF_BUDGET_TOKENS = 4096;
/** 最近 1/4 条目的单条满预算：persona.md §4 默认 1024 */
export const DEFAULT_HANDOFF_FOLD_TOKENS = 1024;
/** 更早条目的最小保留量：persona.md §4「1/16，下限 48 token」 */
export const HANDOFF_MIN_FOLD_TOKENS = 48;

/**
 * 纯流程类工具：只推进流程、不携带交接信息，入参与回执都不收录。
 * 它们的作用已经落在投影与人格文件里（定时器表、告警出口），再进笔记只是噪音。
 *
 * v27 之后 `notify` 不在这里了——那件工具已删（它与 speak 重复）。
 * 发言出口现在是 `speak`（日常）与 `report`（正式内容），两者仍都算流程类。
 *
 * **v35 起 `set_timer` / `cancel_timer` 这两个名字仍然留在名单里**，虽然工具已经并进
 * `timer` 一件了：笔记是从**盘上的事件**渲染出来的，历史事件里那三个名字会长期存在，
 * 删掉旧名等于让老日志里的定时器布防突然挤进笔记（重放出来的笔记也就跟着变）。
 * 新名字 `timer` 不能只按名字分类——见 `noteClassOf`。
 */
export const FLOW_TOOLS: readonly string[] = ['set_timer', 'cancel_timer', 'speak', 'report'];

/**
 * 状态类工具：回执只描述"此刻是什么样"，历史值没有交接价值——按 `tool:<name>:<角色>` 只留最新一次
 * （入参与回执各自只留最新：它们是同一次调用的两面，挤在同一个 key 上会互相抵消）。
 * 注意与 FLOW_TOOLS 的分工：流程类是"发出去的动作"，状态类是"读回来的快照"。
 *
 * 同样保留旧名 `list_timers`（历史事件），新名字按动作判（`noteClassOf`）。
 */
export const STATE_TOOLS: readonly string[] = ['list_timers', 'todo'];

/**
 * 合并后的定时器工具名（与 `tools/admin.ts` 的 `TIMER_TOOL_NAME` 同字面量）。
 *
 * 为什么不直接导入那个常量：persona 这一层是被渲染层依赖的纯函数层，
 * 反向引 `tools/admin.ts` 会把一整个工具包（fs、通道、告警）拖进它的依赖图里。
 * 同字面量的写法在本仓有先例（`PERSONA_PROPOSAL_DIR` 与 web/server.ts 那份）。
 */
export const TIMER_TOOL = 'timer';

/** 定时器的读动作（= 原来那件 `list_timers` 的职责）：它才是"快照"，另外两个是"动作" */
export const TIMER_READ_ACTION = 'list';

/** 笔记首行标题（进不了任何分段，但仍计入总预算） */
const HEADER = '# 交接笔记';

/**
 * 单条工具入参在笔记里的**字节上限**：超过它就压成「键名 + 字节数」，不再原样录入。
 *
 * 为什么要有这条（2026-10-06，用户核定的第二笔）：工具入参动辄几千字符（`safe_edit` 的
 * `old_string`/`new_string` 一次就能上万），而它们坐在笔记的**头部**、每次交接都要重编码一次。
 * 先例：reasonix 的 `compressFoldArgsForSummary`（`compact_fold_input.go:214-239`，>512 字节
 * 压成键名 + 大小）。
 *
 * 512 这个数的取舍：普通调用（`{"file_path":"a.txt"}` 这类）都在它下面，**原样保留**；
 * 一过线就说明这条入参里装着正文、补丁、大段命令——那些内容的价值在"做过这件事"，
 * 不在"逐字复现"，而回执那一条已经把结果说清了。判据按 **UTF-8 字节**（与 `contentRef.bytes`
 * 同一把尺），不按字符数：中文入参一个字三字节，按字符判会放过三倍大的东西。
 *
 * **确定性**：这是纯函数（入参字符串 → 文本），阈值是常量、键名排序固定，所以同一批事件
 * 在任何时刻渲染出同一字节串——重放逐字节重建这条纪律不受影响。
 */
export const HANDOFF_TOOL_ARGS_MAX_BYTES = 512;

/** 重复合并的标注模板（persona.md §4 原文措辞） */
function repeatLabel(times: number): string {
  return ` (同样的一条重复了 ${times} 次)`;
}

// ──────────────────────────────── 条目 ────────────────────────────────

/**
 * 条目种类。
 *
 * `user` = 有人在跟她说话（界面消息 / 外部通道来话），`assistant` = 她说出去的话。
 * 后两者一起构成"对话本身"——压缩把它们遮蔽掉时，笔记是唯一的替代品，所以它们必须进笔记
 * （2026-10-02 补，理由见 `collectHandoffEntries` 的注释）。
 */
export type HandoffEntryKind = 'user' | 'assistant' | 'wake' | 'tool-call' | 'tool-result';

/** 笔记条目：一条事件压缩成一行可读文本 */
export interface HandoffEntry {
  seq: number;
  ts: string;
  kind: HandoffEntryKind;
  /** 工具名（kind 为 tool-call / tool-result 时有值） */
  tool?: string;
  /** 状态类去重键；无 key 即非状态类条目（不参与"只留最新"） */
  stateKey?: string;
  /** 条目正文（尚未按档位截断） */
  text: string;
}

// ──────────────────────────────── 对外类型 ────────────────────────────────

export interface HandoffOptions {
  /** 笔记总预算（token 估算），默认 4096 */
  budgetTokens?: number;
  /** 最近 1/4 条目的单条满预算，默认 1024 */
  foldTokens?: number;
  /** 距今多少毫秒以内算"最近"（与 splitAt 同时给出时 splitAt 优先） */
  splitAtMs?: number;
  /** "最近"段的绝对起点（ISO 时刻）；缺省按最近 1/4 条目切 */
  splitAt?: string;
  /** 纯流程类工具名，默认 FLOW_TOOLS */
  flowTools?: readonly string[];
  /** 状态类工具名，默认 STATE_TOOLS */
  stateTools?: readonly string[];
  /** 分区参照时刻（通常是当前 now）；缺省取最新条目的 ts */
  now?: string;
}

export type HandoffSectionName = '历史' | '最近';

export interface HandoffSection {
  name: HandoffSectionName;
  /** 段内最早 / 最晚条目的 ts（段为空时为 null） */
  from: string | null;
  to: string | null;
  count: number;
}

export interface HandoffNote {
  /** 最终笔记文本（token 估算 ≤ budgetTokens） */
  text: string;
  /** 笔记自身的 token 估算 */
  tokens: number;
  /** 装入笔记的条目数 */
  included: number;
  /** 装不下、只记数量的早期条目数 */
  omitted: number;
  /** 分段元信息（顺序固定：历史 → 最近） */
  sections: HandoffSection[];
}

export interface FoldResult {
  text: string;
  /** 折叠后文本的 token 估算 */
  tokens: number;
  /** 被折叠掉的部分约多少 token（0 表示没折叠） */
  foldedTokens: number;
}

// ──────────────────────────────── token 估算 ────────────────────────────────

/** 宽字符（中日韩 + 全角）判定：与 tools/registry.ts 的 CJK_RE 逐字一致 */
const WIDE_RE = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/u;

/** 权重基准 12：宽字符 8/12（=1/1.5 字/token），其余 3/12（=1/4 字符/token） */
const WIDE_WEIGHT = 8;
const NARROW_WEIGHT = 3;
const WEIGHT_BASE = 12;

/**
 * 零依赖 token 估算（design §4.12）：中文约 1.5 字/token、英文约 4 字符/token。
 * 用整数权重求和再取上界，不引 tokenizer——误差由软阈值机制吸收。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(weightOf(text) / WEIGHT_BASE);
}

function weightOf(text: string): number {
  let weight = 0;
  for (const ch of text) weight += WIDE_RE.test(ch) ? WIDE_WEIGHT : NARROW_WEIGHT;
  return weight;
}

/** 按 token 预算取最长前缀（码点粒度，不切断代理对） */
function takeTokens(text: string, budgetTokens: number): string {
  const limit = Math.floor(budgetTokens * WEIGHT_BASE);
  if (limit <= 0) return '';
  let weight = 0;
  let out = '';
  for (const ch of text) {
    const cost = WIDE_RE.test(ch) ? WIDE_WEIGHT : NARROW_WEIGHT;
    if (weight + cost > limit) break;
    weight += cost;
    out += ch;
  }
  return out;
}

/** 单条截断：只留开头，末尾一个省略号（"更早只留开头"，任务里的硬规则） */
function clipTokens(text: string, budgetTokens: number): string {
  if (estimateTokens(text) <= budgetTokens) return text;
  const head = takeTokens(text, Math.max(0, budgetTokens - estimateTokens('…')));
  return head === '' ? '' : `${head}…`;
}

/**
 * 超预算文本截断 + 痕迹行："…[后面约 N token 已折叠]"。
 * 返回文本的 token 估算必然 ≤ budgetTokens（预算小到装不下痕迹行时，只留痕迹行本身）。
 */
export function foldToBudget(text: string, budgetTokens: number): FoldResult {
  const budget = Math.max(0, Math.floor(budgetTokens));
  const total = estimateTokens(text);
  if (total <= budget) return { text, tokens: total, foldedTokens: 0 };

  // 痕迹行是自描述的（N 的位数会影响长度），先按上界给它留位置，再逐字符收敛
  const reserve = estimateTokens('…[后面约 999999 token 已折叠]');
  let head = takeTokens(text, Math.max(0, budget - reserve));
  let out = markFolded(head, total);
  while (estimateTokens(out) > budget && head.length > 0) {
    // 中文 1.5 字/token 的粒度让边界可能上浮零点几 token：从尾部逐码点回退
    head = [...head].slice(0, -1).join('');
    out = markFolded(head, total);
  }
  if (estimateTokens(out) > budget) {
    // 连痕迹行都装不下：退化为"只剩痕迹"，它仍带信息（后面有多少内容被折叠了）
    out = `…[后面约 ${total} token 已折叠]`;
    while (estimateTokens(out) > budget && out.length > 0) out = [...out].slice(0, -1).join('');
  }
  return { text: out, tokens: estimateTokens(out), foldedTokens: Math.max(0, total - estimateTokens(head)) };
}

function markFolded(head: string, total: number): string {
  const folded = Math.max(0, total - estimateTokens(head));
  return head === '' ? `…[后面约 ${folded} token 已折叠]` : `${head}…[后面约 ${folded} token 已折叠]`;
}

// ──────────────────────────────── 收录 ────────────────────────────────

/** timerId → 最近一条 timer/set 的 payload（与 render 同源：wake/timer 自身不带 payload） */
function timerPayloadsOf(events: readonly AppEvent[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const e of events) {
    if (e.type === 'timer/set') map.set(e.data.timerId, e.data.payload);
    if (e.type === 'timer/cancelled') map.delete(e.data.timerId);
  }
  return map;
}

/** 多行文本折成单行：笔记是逐行清单，换行会破坏它的可读性 */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * `wake/job` 的**回读线索**（P1-15，2026-10-17 修）：标题（`wakeTitle`，已含 jobId / 命令 / 退出码）
 * 之外再补一句"输出全文在哪、多大"。
 *
 * 为什么必须补：压缩把这段历史遮蔽之后，笔记是唯一替代品——旧写法只抄 `wake/job` 的标题，
 * 于是"任务跑完了、结果是什么、要去哪儿重读"三件事里只有第一件留下来。她只能凭印象继续。
 *
 * **不抄正文**（`outputExcerpt` 最长 2,000 字，笔记总预算只有 4,096 token）：折叠前正文已经在
 * 可见历史里，折叠后需要的是**路**，不是第二份正文。这条线索的成本实测 13–20 token/条
 * （路径长短决定；判据在 `test/handoff-note.test.ts` 的 P1-15 用例里，用 before/after 的 token 差钉住）。
 *
 * 纯函数：只读事件自带的字段，不碰文件系统——确定性（同一批事件任何时候渲染同一字节串）。
 */
function jobRereadHintOf(data: WakeJob['data']): string {
  const file = typeof data.outputFile === 'string' ? data.outputFile.trim() : '';
  if (file === '') {
    // 没有可回读的文件时**如实说**（别让"没有输出"被读成"没有发生过"）
    return data.outputExcerpt === undefined ? ' · 没有留下输出正文' : ' · 没有留下可回读的文件';
  }
  const bytes = typeof data.outputBytes === 'number' && data.outputBytes > 0
    ? ` ${formatExact(data.outputBytes)} 字节`
    : '';
  return ` · 全文${bytes}在 ${file}（safe_read 重读）`;
}

const WAKE_TYPES = new Set<string>([
  'wake/timer', 'wake/file', 'wake/webhook', 'wake/manual',
  'wake/heartbeat', 'wake/intention', 'wake/job',
]);

/**
 * 收录事件 → 条目（保持输入的时间正序）。
 *
 * **收四类**：外部来话（`wake/channel`，谁在哪个会话里说了什么）、界面消息（`message/user`）、
 * 心跳/定时器这类事件帧（`WAKE_TYPES`）、工具入参与回执。
 *
 * **2026-10-02 补进"对话本身"**：原来刻意不收 `wake/channel` 与 `message/assistant`
 * （理由是"已经说完的话，不是交接的东西"）。那个理由只在"这些话还留在现场"时成立——
 * 而压缩的遮蔽点一旦落在这段对话中间，现场就只剩半截（他的问题被遮、她的回答留着），
 * 用户实测到的"压缩后又把已经回复过的东西再回复一遍"正是这么来的。
 * 笔记是**遮蔽段的唯一替代品**，所以它必须带上"他说了什么、我答了什么"——
 * 否则遮蔽等于把对话删掉，而不是把它变成摘要。
 *
 * 仍然不收：思维链（内部过程）、上一份笔记（会自我复制）。
 */
export function collectHandoffEntries(
  events: readonly AppEvent[],
  opts: HandoffOptions = {},
): HandoffEntry[] {
  const flowTools = new Set(opts.flowTools ?? FLOW_TOOLS);
  const stateTools = new Set(opts.stateTools ?? STATE_TOOLS);
  const payloads = timerPayloadsOf(events);

  // callId → 那次调用的名字与入参：工具回执本身两样都不带，得从对应的 tool/call 取
  // （入参也要取：v35 起"收不收"不只取决于名字，见 noteClassOf）
  const callById = new Map<string, { name: string; args: string }>();
  for (const e of events) {
    if (e.type === 'tool/call') callById.set(e.data.callId, { name: e.data.name, args: e.data.arguments });
  }

  const out: HandoffEntry[] = [];
  for (const e of events) {
    if (e.type === 'wake/channel') {
      // 谁在哪儿说的：只写会话类型（私聊/群聊），不写 openid——名字在会话清单里，这里要的是"他说了什么"
      const where = e.data.chatType === 'c2c' ? '私聊' : '群聊';
      out.push({
        seq: e.seq, ts: e.ts, kind: 'user',
        text: `[他 · ${where}] ${oneLine(e.data.text)}`,
      });
      continue;
    }
    if (WAKE_TYPES.has(e.type)) {
      const entry: HandoffEntry = {
        seq: e.seq, ts: e.ts, kind: 'wake',
        // P1-15：`wake/job` 除了标题，还带一条"全文在哪儿"的回读线索（见 jobRereadHintOf）。
        // 折叠之后连这句话都没有，她就只剩"任务完成了"这个印象、没有任何回读的路。
        text: `[唤醒] ${oneLine(wakeTitle(e, payloads))}${e.type === 'wake/job' ? jobRereadHintOf(e.data) : ''}`,
      };
      // 心跳是纯粹的"还在、没事"信号：同一份状态重复多少次都只留最新一次
      if (e.type === 'wake/heartbeat') entry.stateKey = 'wake:heartbeat';
      out.push(entry);
      continue;
    }
    if (e.type === 'message/user') {
      out.push({
        seq: e.seq, ts: e.ts, kind: 'user',
        text: `[用户] ${oneLine(e.data.text)}`,
      });
      continue;
    }
    if (e.type === 'message/assistant') {
      const text = oneLine(e.data.text ?? '');
      if (text === '') continue;
      out.push({ seq: e.seq, ts: e.ts, kind: 'assistant', text: `[我] ${text}` });
      continue;
    }
    if (e.type === 'tool/call') {
      const cls = noteClassOf(e.data.name, e.data.arguments, flowTools, stateTools);
      if (cls === 'flow') continue; // 纯流程调用：不收录
      const entry: HandoffEntry = {
        seq: e.seq, ts: e.ts, kind: 'tool-call', tool: e.data.name,
        text: `[调用] ${e.data.name}(${noteArgsOf(e.data.arguments)})`,
      };
      if (cls === 'state') entry.stateKey = `tool:${e.data.name}:call`;
      out.push(entry);
      continue;
    }
    if (e.type === 'tool/result') {
      const call = callById.get(e.data.callId);
      const name = call?.name ?? '?';
      const cls = noteClassOf(name, call?.args, flowTools, stateTools);
      if (cls === 'flow') continue;
      const entry: HandoffEntry = {
        seq: e.seq, ts: e.ts, kind: 'tool-result', tool: name,
        text: resultText(name, e),
      };
      if (cls === 'state') entry.stateKey = `tool:${name}:result`;
      out.push(entry);
      continue;
    }
    // 其余事件类型：不收录（reasoning、compaction/summary 等）
  }
  return out;
}

/**
 * 笔记里怎么印一条工具调用的入参（2026-10-06 第二笔）。
 *
 * 短的**原样**（普通调用占绝大多数，逐字留着最有用）；超过 {@link HANDOFF_TOOL_ARGS_MAX_BYTES}
 * 的压成「顶层键名 + 字节数 + 一句说明」——键名留着是因为"她动过哪几个字段"是交接信息，
 * 值不留是因为那几千字节的正文在笔记里既读不完也占不起（笔记总预算只有 4096 token）。
 *
 * 非对象/非 JSON/缺入参：只剩字节数与说明（键名那一段整段不出现），**不留空括号**。
 * 键名按**原出现顺序**列（不排序）：JSON 的键序是入参生成时的顺序，重放时同一份字节
 * 得到同一个顺序，确定性不靠排序来保证；排序反而会把"她先写哪个字段"这个信息抹掉。
 */
function noteArgsOf(args: string | undefined): string {
  const raw = oneLine(args ?? '');
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes <= HANDOFF_TOOL_ARGS_MAX_BYTES) return raw;

  const keys = topLevelKeysOf(raw);
  const head = keys.length === 0 ? '' : `${keys.join(',')} · `;
  return `${head}${formatExact(bytes)} 字节 · 参数正文未收入笔记`;
}

/** 顶层键名（原出现顺序）。取不到（非 JSON / 不是对象）返回空数组 */
function topLevelKeysOf(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
    return Object.keys(parsed as Record<string, unknown>);
  } catch {
    return [];
  }
}

/**
 * 一条工具调用在笔记里的归类：`'flow'`（不收录）/ `'state'`（收录，但按 key 只留最新）/ `'plain'`。
 *
 * **为什么要看入参，而不是只看名字**（v35）：定时器合并成一件 `timer` 之后，同一个名字底下
 * 既有"布防 / 撤销"（发出去的动作，与从前的 `set_timer` / `cancel_timer` 一样该丢），
 * 又有"列出此刻有哪些"（读回来的快照，与从前的 `list_timers` 一样只该留最新一次）。
 * 只按名字分，要么把 `list` 的回执丢掉（她压缩之后不知道自己排过什么），要么让每次布防
 * 都在笔记里留一行噪音——两种都是合并前那份判据的退化。
 *
 * 读不出 `action`（没有入参、不是 JSON、不是字符串）时按 `'flow'` 算：那种调用本来就
 * 因为参数不合法而失败了，它的回执没有交接价值。
 */
function noteClassOf(
  name: string,
  args: string | undefined,
  flowTools: ReadonlySet<string>,
  stateTools: ReadonlySet<string>,
): 'flow' | 'state' | 'plain' {
  if (name === TIMER_TOOL) return timerActionOf(args) === TIMER_READ_ACTION ? 'state' : 'flow';
  if (flowTools.has(name)) return 'flow';
  if (stateTools.has(name)) return 'state';
  return 'plain';
}

/** 从入参 JSON 里取 `action`；取不到返回 null（调用方按 `'flow'` 处理） */
function timerActionOf(args: string | undefined): string | null {
  if (args === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(args);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const action = (parsed as Record<string, unknown>)['action'];
    return typeof action === 'string' ? action : null;
  } catch {
    return null;
  }
}

/**
 * 工具回执文本：状态模板化（同一状态渲染出同一字节串，与 render 的固定模板同精神） */
function resultText(name: string, e: AppEvent & { type: 'tool/result' }): string {
  const d = e.data;
  const head = `[结果] ${name} ${d.status}`;
  let body: string;
  switch (d.status) {
    case 'ok': body = oneLine(d.content); break;
    case 'error': body = oneLine(d.error?.message ?? d.content); break;
    case 'timeout': body = '执行超时，结果未知'; break;
    case 'denied': body = `被策略拒绝：${oneLine(d.error?.message ?? d.content)}`; break;
    case 'unknown': body = '结果未知（Its outcome is unknown.）：只有只读或幂等操作允许重试'; break;
    case 'aborted': body = '未派发（取消时仍在队列）'; break;
    case 'over-limit': body = '未派发（单步工具调用数超限）'; break;
  }
  return body === '' ? head : `${head}：${body}`;
}

// ──────────────────────────────── 去重与合并 ────────────────────────────────

/** 状态类条目按 key 只留最新：同 key 的旧值对交接没有价值（新值已经包含了此刻的真相） */
function dedupeByStateKey(entries: readonly HandoffEntry[]): HandoffEntry[] {
  const seen = new Set<string>();
  const out: HandoffEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const key = entry.stateKey;
    if (key !== undefined) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(entry);
  }
  return out.reverse();
}

/**
 * 逐字重复合并：正文完全相同的条目并成一条，取最新一次的位置与时刻，标注重复次数。
 * 取最新时刻是刻意的——重复条目最新一次往往才是"现在正在发生的事"，
 * 按首次时刻算年龄会让它被误判成陈年旧账、只分到 1/16 的预算。
 */
function mergeRepeats(entries: readonly HandoffEntry[]): HandoffEntry[] {
  const countByText = new Map<string, number>();
  for (const entry of entries) {
    countByText.set(entry.text, (countByText.get(entry.text) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const out: HandoffEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry === undefined) continue;
    if (seen.has(entry.text)) continue;
    seen.add(entry.text);
    const times = countByText.get(entry.text) ?? 1;
    out.push(times > 1 ? { ...entry, text: `${entry.text}${repeatLabel(times)}` } : entry);
  }
  return out.reverse();
}

// ──────────────────────────────── 预算分档 ────────────────────────────────

/**
 * 按年龄衰减的单条预算（下标 0 = 最新条目）：
 * 最近 1/4 满预算，往前 1/4 给 1/4，更早给 1/16 且不低于 48 token。
 */
function tierBudgets(count: number, foldTokens: number): number[] {
  const quarter = Math.ceil(count / 4);
  const recentEnd = Math.min(count, quarter);
  const midEnd = Math.min(count, recentEnd + quarter);
  const mid = Math.max(1, Math.round(foldTokens / 4));
  const early = Math.max(HANDOFF_MIN_FOLD_TOKENS, Math.round(foldTokens / 16));
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(i < recentEnd ? foldTokens : i < midEnd ? mid : early);
  }
  return out;
}

/** 行内时刻：ISO 取 HH:MM:SS 省 token；非常规格式原样保留（确定性优先） */
function clockOf(ts: string): string {
  return ts.length >= 19 ? ts.slice(11, 19) : ts;
}

// ──────────────────────────────── 主入口 ────────────────────────────────

/**
 * 渲染交接笔记。纯函数：不读时钟、不读文件，同一批事件任何时刻渲染出同一字节串。
 * 返回的 `text` 可直接用作 `compaction/summary.summary`（design §4.13：遮蔽段渲染由该事件唯一确定）。
 */
export function renderHandoffNote(events: readonly AppEvent[], opts: HandoffOptions = {}): HandoffNote {
  const budgetTokens = Math.max(0, Math.floor(opts.budgetTokens ?? DEFAULT_HANDOFF_BUDGET_TOKENS));
  const foldTokens = Math.max(1, Math.floor(opts.foldTokens ?? DEFAULT_HANDOFF_FOLD_TOKENS));

  const ordered = mergeRepeats(dedupeByStateKey(collectHandoffEntries(events, opts)));
  const desc = [...ordered].reverse(); // 最近 → 最远：预算从最近往远装入
  const tiers = tierBudgets(desc.length, foldTokens);

  const refMs = opts.now !== undefined ? Date.parse(opts.now) : Date.parse(desc[0]?.ts ?? '');
  const recentStart = recentStartIndex(ordered, opts, refMs);
  const isRecent = new Set<number>(ordered.slice(recentStart).map(entry => entry.seq));

  // 装入：装不下即停，剩下的早期条目只记数量（总预算优先给最近的）
  let used = estimateTokens(HEADER);
  const included: Array<{ entry: HandoffEntry; text: string }> = [];
  for (let i = 0; i < desc.length; i += 1) {
    const entry = desc[i];
    if (entry === undefined) continue;
    const text = clipTokens(entry.text, tiers[i] ?? foldTokens);
    if (text === '') break; // 预算连一个字符都装不下：后面同样装不下
    const cost = estimateTokens(text);
    if (used + cost > budgetTokens) break;
    included.push({ entry, text });
    used += cost;
  }
  let omitted = desc.length - included.length;

  const compose = (): string => buildText(included, isRecent, omitted);
  let text = compose();
  // 省略计数行也要占预算：装不下就再吐出一条（从最早装入的那条开始），保证总量硬 ≤ 预算
  while (estimateTokens(text) > budgetTokens && included.length > 0) {
    included.pop();
    omitted += 1;
    text = compose();
  }
  if (estimateTokens(text) > budgetTokens) text = foldToBudget(text, budgetTokens).text;

  const sections = sectionMeta(included, isRecent);
  return {
    text,
    tokens: estimateTokens(text),
    included: included.length,
    omitted,
    sections,
  };
}

/** "最近"段的起始下标（升序数组）：splitAt 优先，其次 splitAtMs，缺省按最近 1/4 条目切 */
function recentStartIndex(
  ordered: readonly HandoffEntry[],
  opts: HandoffOptions,
  refMs: number,
): number {
  const splitAt = opts.splitAt;
  if (splitAt !== undefined) {
    const at = Date.parse(splitAt);
    if (!Number.isNaN(at)) {
      const index = ordered.findIndex(entry => Date.parse(entry.ts) >= at);
      return index === -1 ? ordered.length : index;
    }
  }
  if (opts.splitAtMs !== undefined && !Number.isNaN(refMs)) {
    const at = refMs - opts.splitAtMs;
    const index = ordered.findIndex(entry => Date.parse(entry.ts) >= at);
    return index === -1 ? ordered.length : index;
  }
  return Math.max(0, ordered.length - Math.ceil(ordered.length / 4));
}

function buildText(
  included: ReadonlyArray<{ entry: HandoffEntry; text: string }>,
  isRecent: ReadonlySet<number>,
  omitted: number,
): string {
  const lines: string[] = [HEADER];
  const history = included.filter(item => !isRecent.has(item.entry.seq)).reverse();
  const recent = included.filter(item => isRecent.has(item.entry.seq)).reverse();

  for (const [name, items] of [['历史', history], ['最近', recent]] as const) {
    if (items.length === 0) continue;
    lines.push(sectionTitle(name, items), ...items.map(item => `- [${clockOf(item.entry.ts)}] ${item.text}`));
  }
  if (omitted > 0) lines.push(`（更早的 ${omitted} 条已省略）`);
  return lines.join('\n');
}

function sectionTitle(
  name: HandoffSectionName,
  items: ReadonlyArray<{ entry: HandoffEntry; text: string }>,
): string {
  const first = items[0]?.entry.ts ?? '';
  const last = items[items.length - 1]?.entry.ts ?? '';
  return `## ${name}（${first} ~ ${last} · ${items.length} 条）`;
}

function sectionMeta(
  included: ReadonlyArray<{ entry: HandoffEntry; text: string }>,
  isRecent: ReadonlySet<number>,
): HandoffSection[] {
  const out: HandoffSection[] = [];
  for (const name of ['历史', '最近'] as const) {
    // included 是装入顺序（新→旧），段内取回时间正序后才谈得上"最早 / 最晚"
    const items = included.filter(item => (name === '最近') === isRecent.has(item.entry.seq)).reverse();
    out.push({
      name,
      from: items[0]?.entry.ts ?? null,
      to: items[items.length - 1]?.entry.ts ?? null,
      count: items.length,
    });
  }
  return out;
}

/**
 * 交接笔记的**机械替代文本**（2026-10-06 加）。
 *
 * 为什么不能"笔记渲染不出来就什么都不写"：先例是 reasonix 的 `mechanicalFoldDigest`
 * ——「Saying the summary is missing is what stops the model reading the gap as
 * 'nothing was there' and inventing what the folded turns contained.」留白会被读成
 * "那段时间什么都没发生"，然后她会**按这个印象编下去**。所以遮蔽一旦发生，
 * `compaction/summary` 必须落一条，而且 `summary` 字段**不许空**。
 *
 * 这段文本是**纯函数**（count → 字符串），不含时刻、不含随机：重放才逐字节可重建。
 * 单独导出是为了让测试与报告都能引用同一串字面量、不必各写一遍。
 */
export function mechanicalSummaryText(coveredCount: number): string {
  const n = Math.max(0, Math.trunc(coveredCount));
  return '# 交接笔记\n'
    + `（这一段有 ${n} 条往来被折进来了，但**自动笔记这次没生成出来**——`
    + '不是"这段什么都没发生"。要细节请从 `events/` 或 `_research/` 的工具按 seq 回查。）\n';
}

// ──────────────────────────────── 压缩阈值口径 ────────────────────────────────

/**
 * 某个遮蔽点之后**还没被折进笔记**的可见历史规模：`(fromSeq, toSeq]` 之间 model 可见事件之和。
 *
 * 口径与 {@link estimateHistoryTokens} **同一把尺**（同一个 `historyTextOf` + 同一个
 * `estimateTokens`），只是把范围写成显式区间——④ 的交接闸门量的是"这次折叠的收益规模"
 * （从上一个遮蔽点起、还没折进任何笔记的那些内容），而不是"整条历史有多长"。
 *
 * **为什么是"从上一个遮蔽点起"而不是"本轮新增"**（这一条我踩过一次，记在这里）：
 * 第一版量的是"上一次 turn/end → 本次遮蔽点"那一段，于是
 *   ① 实测 21:40 那种"一轮干了 18 步"的场景，上一轮的内容（44,281）不算数，
 *      量出来只剩本轮新增的一点点；
 *   ② 手工 `/compact` 那一拍量出来干脆是 0（刚跑完的那一轮落在上一个 turn/end 之后）。
 * 真正决定"这次折叠值不值"的是**将要发生变化的那些字节**：从上一个遮蔽点起、还没进任何
 * 笔记的全部可见历史。折叠把这一整段换成一份笔记，收益就是它的规模。
 *
 * **思维链按"真发出去的那一份"计入**（与 {@link estimateHistoryTokens} 同一份判据）：
 * v68 把 `message/reasoning` 改成 model 可见之后，`historyTextOf` 对它是**全文**——闸门于是把
 * "折叠能省多少"算**大**了（更容易放行一次其实不够本的折叠）。真正进请求、真正会被折掉的是
 * {@link reasoningEchoOf} 挑出的那几条，而它认的遮蔽点就是 `fromSeq`（与渲染层同一处），
 * 所以这里改吃同一个纯函数：**闸门读数与"这次折叠真能省掉的那几个字节"一致**。
 * **v73 起那几条就是全量**（帽子已废）：读数因此比 v70/71/72 **大**——这不是放宽，是"折算的
 * 就是真发出去的全量"。方向仍然只有一条判据：闸门读数 = 请求里 reasoning item 的 token 和。
 * 与阈值那一侧同理，**它不进请求体任何字节** ⇒ `RENDER_VERSION` **不递**。
 */
export function estimateMaskedTokens(
  events: readonly AppEvent[],
  fromSeq: number,
  toSeq: number,
): number {
  const payloads = timerPayloadsOf(events);
  // 思维链**按真发出去的那一份计入**（v73：全量；撞硬上限时只剩下留下来的那几条）：
  // seq → 实际会进请求的正文。不在里面的一个 token 都不算——渲染层对它们一个字节都不推。
  // `fromSeq` 就是参照点（渲染层的遮蔽点），所以这两处挑出来的是**同一批字符串**。
  const echoed = new Map(
    reasoningEchoOf(events, fromSeq).map(entry => [entry.seq, entry.text] as const),
  );
  let tokens = 0;
  for (const e of events) {
    if (e.seq <= fromSeq || e.seq > toSeq) continue;
    if (e.visibility !== 'model') continue;
    // 摘要自身不计（与 estimateHistoryTokens 同一条）：它遮蔽别的段，不该被算进被遮蔽量
    if (e.type === 'compaction/summary') continue;
    // reasoning 走同一个纯函数那一条路（见函数注释），其余层照旧按 `historyTextOf` 全文量
    if (e.type === 'message/reasoning') {
      const text = echoed.get(e.seq);
      if (text !== undefined) tokens += estimateTokens(text);
      continue;
    }
    tokens += estimateTokens(historyTextOf(e, payloads));
  }
  return tokens;
}

/**
 * 可见历史规模（token 估算）：未被 `compaction/summary` 遮蔽的 model 可见事件之和。
 * 运行期用它判定"要不要压缩"——阈值一过就写摘要，写完历史立刻变短（遮蔽生效），
 * 于是自然形成"积累到阈值才压一次"的节奏，而不是每轮都压。
 *
 * **思维链按"真发出去的那一份"计入**（2026-10-17 `2e16303` 的副作用；**2026-10-20 v73 改口径**）：
 * v68 把 `message/reasoning` 从 `internal` 改成 `model` 之后，它成了可见历史的一部分，必须计入——
 * 计入的判据**必须与渲染层同一处**（`model/render.ts` 的 {@link reasoningEchoOf}），因为
 * "估算器算的"与"请求里真有的"要是同一批字符串，压缩阈值才不会凭空偏。
 *
 * **v73 起那份"真发出去的"就是全量**（不再有"最近 3 条 / 单条 20k"的帽子）：所以这个估算器
 * 现在量的是**全部 model 可见思维链**（只有撞 `maxTotalChars` 硬上限时才少掉最老的整组）。
 * ⚠ **连带事实（不是 bug）**：同一段历史在 v73 下算出来的 token **比 v70/71/72 大**（旧口径只算
 * 帽内那点尾巴，实测 ≈2,056 token/请求）⇒ **压缩会更早触发**。这正是"全量回传"的代价与边界：
 * 有界交给压缩线（遮蔽点之后的 reasoning 才回传），而不是在渲染层偷偷截掉某一条的思维链。
 *
 * **不改任何阈值数值、也不动触发时机那一侧的逻辑**：这里只把"reasoning 算多少"换成渲染层
 * 实际会发出去的那个量。**它不进请求体任何字节** ⇒ `RENDER_VERSION` **不递**。
 *
 * 判据只有一处：{@link reasoningEchoOf}（同一个纯函数，渲染层回传的也是它挑出来的那几条）。
 * 所以"估算器算的"与"请求里真有的"是**同一批字符串**——用例拿 `render().input` 的 reasoning
 * item 逐字数对齐（`test/handoff-note.test.ts` 的 ⑦乙/⑦丙 两组）。
 *
 * @param coveredUpToSeq **显式遮蔽点覆盖**（2026-10-06 加）：给了它就按它算，不看日志里
 *   已有的摘要。运行期需要这个覆盖，因为它在"这条摘要还没写下去"的时刻就要知道
 *   "写完之后历史还剩多少"——那正是阈值判定的对象（压缩点从 turn/start 改成本 turn 的
 *   turn/end 之后，两者会差一整轮）。不给则与从前逐值相同：取日志里最大的 coveredUpToSeq。
 */
export function estimateHistoryTokens(
  events: readonly AppEvent[],
  coveredUpToSeq?: number,
): number {
  let covered = 0;
  if (coveredUpToSeq === undefined) {
    for (const e of events) {
      if (e.type === 'compaction/summary' && e.data.coveredUpToSeq > covered) {
        covered = e.data.coveredUpToSeq;
      }
    }
  } else {
    covered = coveredUpToSeq;
  }
  const payloads = timerPayloadsOf(events);
  // 思维链**按真发出去的那一份计入**（v73：全量；只有撞硬上限才少掉最老的整组）：
  // seq → 实际会进请求的正文。不在里面的一个 token 都不算——渲染层对它们**一个字节都不推**。
  // 同一个纯函数、没有第二份判据。
  const echoed = new Map(
    reasoningEchoOf(events, covered).map(entry => [entry.seq, entry.text] as const),
  );
  let tokens = 0;
  for (const e of events) {
    if (e.seq <= covered) continue;
    // 遮蔽段不进请求，不计入。
    // v3 起**思维链也进请求**（思考模式要求回传 reasoning_text），所以它必须计入历史规模：
    // 这一条曾经把 reasoning 排除在外，与渲染口径不一致，后果是历史被低估、压缩迟迟不触发——
    // 实测上下文涨到 50k（阈值 32k）仍然没压过，每轮都在为同一批历史付费。
    if (e.visibility !== 'model') continue;
    if (e.type === 'compaction/summary') continue;
    // reasoning 走同一个纯函数那一条路（见函数注释），其余层照旧按 `historyTextOf` 全文量
    if (e.type === 'message/reasoning') {
      const text = echoed.get(e.seq);
      if (text !== undefined) tokens += estimateTokens(text);
      continue;
    }
    tokens += estimateTokens(historyTextOf(e, payloads));
  }
  return tokens;
}

/** 历史规模里各事件的渲染口径（与 render 的事件流同源，细节不必逐字相同——它只是阈值口径） */
function historyTextOf(e: AppEvent, payloads: Map<string, unknown>): string {
  switch (e.type) {
    case 'message/user': return e.data.text;
    case 'message/assistant': return e.data.text ?? '';
    // **这一支现在两个消费者都不走到**：`estimateHistoryTokens` 与 `estimateMaskedTokens` 都先把
    // reasoning 交给 `reasoningEchoOf`（同一个纯函数），不经过这里。留全文是给未来新消费者一个
    // **不撒谎**的默认值（算"多了"，不是悄悄算成 0）——真加第三个消费者时，得当场想清楚它
    // 该不该读 {@link reasoningEchoOf}（v73 起它是全量口径），而不是指望这行兜底。
    case 'message/reasoning': return e.data.text;
    // **他的消息也占上下文**（2026-10-02 补）：漏掉 `wake/channel` 与漏掉 reasoning 是同一类错
    // ——被遮蔽区间之外的历史被低估，压缩就迟迟不触发，每一轮都在为同一批历史付费
    case 'wake/channel': return renderExternalEvent(e.data);
    case 'tool/call': return `${e.data.name}${e.data.arguments}`;
    case 'tool/result': return e.data.content;
    case 'developer/message': return `工具清单变更 ${e.data.added.join(',')} ${e.data.removed.join(',')}`;
    case 'policy/denied': return `策略拒绝 ${e.data.tool} ${e.data.reason}`;
    case 'review/resolved': return `人工确认 ${e.data.callId} ${e.data.outcome} ${e.data.note}`;
    case 'human/asked': return `等待人工回答 ${e.data.question} ${e.data.context}`;
    case 'human/answered': return `人工回答 ${e.data.answer}`;
    // 超时事实也占历史（它在上下文里是一段「人可能不在」的注入）：漏掉它会让历史被低估
    case 'human/expired': return `未批准未拒绝（超时无人答复） ${e.data.question}`;
    default:
      return WAKE_TYPES.has(e.type) ? renderWake(e, payloads) : '';
  }
}
