/**
 * Irmia Agent — 上下文审计（归因事实 + 缓存破坏哨兵）
 *
 * 两份产出，性质不同，别混：
 *   ① **归因**（每步一条，`ContextBreakdown`）：这次请求的上下文由哪几段组成、各占多少 token。
 *      它是**事实**，不是警告——所以它挂在已有的 `budget/consumed` 上（第 4 条硬约束：
 *      不新增事件类型），随那笔模型调用一起落库。
 *   ② **哨兵**（`CacheBreak`，只在真失守时记）：相邻两次请求的前缀比对结论。它同样挂在
 *      `budget/consumed` 上——同一条事件讲一次调用，谁也不用去别处找"这次是谁坏了"。
 *
 * ⚠ 本模块**不引入任何价格 / 货币 / 计费概念**（用户的明确口径）：只记 token 与结构。
 *
 * 为什么归因必须由渲染层算（而不是在这里重估）：
 * 段边界只有装配请求的那段代码知道（`model/render.ts` 的 `render()`）——`instructions`
 * 到哪结束、哪一条是长期记忆层、哪一条是此刻层、哪条是本轮新输入。在这里拿 `RenderedRequest`
 * 反推边界就是第二份口径，迟早漂移。所以：**render 产出事实，本模块只做比对与措辞**。
 *
 * 重放保真（仓库核心不变量）：
 *   · 归因是渲染的纯函数副产物，`deriveRequest` 是运行期与重放共用的同一个函数
 *     （`runtime/replay.ts` 的 `rebuildRenderedRequest`、`web/server.ts` 的请求预览都走它），
 *     所以"同一份日志 + 同一份配置 ⟹ 同一份归因"；
 *   · 哨兵虽然要**相邻两次**比对，但基准取自日志本身（{@link lastAuditedCall} 从 `budget/consumed`
 *     里读上一次的归因），不是内存里的"上一次"。于是重放时把同一段事件喂进来，
 *     得到的是逐字段相同的结论——它既是记录下来的事实，也是可重算的事实。
 */

import { createHash } from 'node:crypto';

import type { AppEvent } from '../log/types.js';
import { estimateTokens } from '../tools/registry.ts';

// ──────────────────────────────── 归因事实 ────────────────────────────────

/** 段落哈希位数：16 位十六进制（与告警指纹同一长度，够区分且短到人眼能比对） */
export const SEGMENT_HASH_CHARS = 16;

/**
 * 一段上下文的事实：**token 数 + 渲染字节的哈希 + 条数**。
 *
 * 为什么 token 数不够、还要哈希：token 估算是有损的（`estimateTokens` 是启发式），
 * 两个长度相近的段落估出同一个数太容易了——而哨兵要判的是"字节有没有变"，
 * 那必须拿字节说话。哈希只吃已经渲染好的文本，不引入任何新口径。
 */
export interface ContextSegment {
  /** 该段的 token 估算（与 tools/registry 的 `estimateTokens` 同源） */
  tokens: number;
  /** 该段渲染文本的 sha256 前 {@link SEGMENT_HASH_CHARS} 位 */
  hash: string;
  /**
   * 该段**文字**的 utf8 字节数（与 `tokens` 同一串输入；哈希仍按整段 JSON，两者口径不同是刻意的）。
   *
   * 为什么要有它（2026-10-10）：失守时人问的第一个问题是"变了多少"——token 估算是启发式的、
   * 还会被 64 块的供方粒度吃掉，字节数是**可复算的硬数**。观测字段，**不进请求体**。
   * **可选**：老日志没有它。
   */
  bytes?: number;
  /** 该段由几条 input item 组成（`instructions` / `tools` 不是 item，字段不出现） */
  items?: number;
}

/**
 * **一节**的事实（长期记忆层的分节 / 历史前段的逐条）：名字 + token + 字节 + 哈希。
 *
 * 为什么要有它（2026-10-10，用户点名："以后再有失守，一眼看出是哪一节、变了多少字节"）：
 * 整段一个哈希只能回答"记忆层变了"，回答不了"是技能目录、MCP 索引还是早期摘要变的"——
 * 2026-10-09 18:07 / 19:17 两次现场都得靠事后逐字节重建才知道（第一次是 MCP 索引那一行 +6 token，
 * 第二次压根不是记忆层、是历史第 1 条 item）。分节之后这两个问题都是**一次读**。
 *
 * 口径（两处用途不同，各自与它要解释的那个哈希对齐）：
 *   · `memory.sections` —— 哈希/字节按**该节自己的文字**算（分隔符 `\n\n` 不计入任何一节）；
 *   · `history.headItems` —— 哈希/字节按该条 item 的 **JSON** 算（与 `history.headHash` 同一串输入）。
 */
export interface ContextSectionFact {
  /** 节名：记忆层用 `skills` / `mcp` / `summary`；历史前段用 `#1`…`#N`（item 序号，从 1 起） */
  name: string;
  tokens: number;
  bytes: number;
  hash: string;
}

/**
 * 四档可信级别（观测字段的**词表**，2026-10-11 加）。
 *
 * ⚠ 它是 `runtime/trust.ts` 的 `TurnTrust` 的**逐字镜像**，刻意不 import 那一个：本模块在
 * `model/` 层（渲染的事实 + 比对），而 `runtime/trust.ts` 是运行期模块。让渲染层的**事实类型**
 * 依赖运行期的判定模块，会把这个"事件与渲染的纯函数"拖成"要跑起一整条运行期链路才编得过"。
 * 词表本身只有这四个字面量（`trust.ts:27`），两处漂移的代价是**一格日志读不出来**，不是判据
 * 分岔——判据仍然只在 `real-loop.ts` 的 `trustOfTurn` → `trust.ts` 的 `trustOfBatch` 一处。
 *
 * 传值的那一端（`agent-loop` 的 `AgentLoopDeps.trust`）用的是**真身** `TurnTrust`（它本来就在
 * `runtime/` 层里，import 那一个不跨层）；这里这份只当**字段形状的文档**，并在测试里被钉住。
 */
export type TurnTrustLevel = 'owner' | 'self' | 'trusted' | 'external';

/** 请求的上下文构成（`budget/consumed.context`，internal 可见性——**不进她的上下文**） */
export interface ContextBreakdown {
  /** 渲染版本（`RENDER_VERSION`）：它一变，请求体整体就变了，不是某一段的事 */
  renderVersion: string;
  /**
   * **这一轮的可信级别**（`owner` / `self` / `trusted` / `external`），2026-10-11 加。
   *
   * 为什么要有它：**2026-10-09 ~ 10-11 之间**，`external` 与 `owner/self` 拿到的 `tools` 段
   * 是**两版**（实测 24 件 / 5480 tok ↔ 4 件 / 888 tok，见 `runtime/trust.ts` 的
   * `EXTERNAL_TOOL_ALLOWLIST`），换档那一次会让 `tools` 段之后的一切重算；而在此之前
   * **日志里查不到"这一拍是哪个档"**——`budget/consumed.context` 没有这一格，事后只能从
   * `input/claimed.wakeSeqs` → `wake/*` 事件按判据**反推**，于是现场看到的是一句"原因不明"
   * （这正是用户问的"为什么又失守了"答不上来的直接原因）。
   *
   * ⚠ **当下（v52）工具清单对所有轮次恒定**：2026-10-11 用户裁决撤回了那次收窄
   * （"tool 数组是绝对不动的"），`modelVisibilityFor()` 从此**不参与清单**、只在执行期
   * （`authzGate`）收窄。⇒ 这一格现在是**纯观测**：它照旧记下"这一拍是哪个档"
   * （排障时仍然有用——执行期的门按它判），但**它不再预示 `tools` 段会变**。
   * 别拿它当"清单换版"的判据：换版只看 `RENDER_VERSION`。
   *
   * **它是纯观测字段：一个字节都不进请求体**。证据面与 `builtAtSeq` 逐字同形——
   * `ds-client.buildRequestBody` 只发 model / input / instructions / tools / reasoning /
   * max_output_tokens / text / temperature / top_p，不碰 `context`；所以加它**不需要动
   * `RENDER_VERSION`**（渲染口径没变）。
   *
   * **它与其他格的口径差别（必须说清）**：`context` 的其余每一格都是**渲染的纯函数**（同一份日志
   * ⇒ 同一份归因）；这一格是"**宿主轮首定下的事实**"（同 `budget/consumed.model`：运行期写下的
   * 观察值）。重建路径（`replay` / 界面预览）手里没有它 ⇒ 那一格**不出现**，而不是编一个。
   * 所以读的一侧一律按 `undefined` = "当时没记"处理，绝不当成某一档。
   *
   * **可选**：这一条改动之前写下的 `budget/consumed` 里没有它。
   */
  trust?: TurnTrustLevel;
  /**
   * **请求体构造点**：渲染这一次请求时看得见的最大事件 seq（含本轮唤醒）。
   *
   * 为什么要有它（2026-10-10 加；02:08 与 03:17 两次「原因不明」都是缺它造成的）：
   * `budget/consumed` 的 `ts` / `seq` 是调用**结束**的时刻，而缓存失守的原因发生在请求
   * **构造之前**。在飞久的调用（实测有 63 秒的）会把"上一次被审计调用"的 seq 落到真正的原因
   * **之后** ⇒ 归因窗口里空无一物 ⇒ 明明是自己压缩/重建索引弄的，却报成 `unattributable` 告警。
   * 有了这一格，窗口切成 `prev.builtAtSeq < seq ≤ cur.builtAtSeq`，比的才是"这次请求看见了什么"。
   *
   * **可选**：这条改动之前写下的 `budget/consumed` 里没有它（读的一侧退回按 `seq` 切，
   * 见 {@link detectCacheBreak}），所以老日志的结论逐字段不变。
   */
  builtAtSeq?: number;
  /**
   * v77：**区段（最后一条 user 之后）里有 assistant 条目、却一条 `reasoning` 都没有**——
   * 这是"裸 `function_call` / 裸正文起段"的风险信号。
   *
   * **纯观测，不当门**（v77 的裁定）：2959.2 / 2982.6 / 3050.12 / 3126.5 四份**真实 200** 的
   * 区段就是这个形状，区段级"段首必须 reasoning"会把它们一起挡掉；真正的判据是组级的
   * `assertGroupToolCallContiguity`（同一组里 `function_call_output` 之后不许再出现
   * `function_call`）。这一格只用来看"这一拍出现过没有"（布尔留痕，不计数、不拦）。
   *
   * 为什么不是"区段里有没有 reasoning"：**每个 turn 的第 1 步**，区段就是本轮那条唤醒
   * （一条 user），既没有 assistant 也没有 reasoning ⇒ 那样算的话每一步首步都会记一格 `true`，
   * 纯噪声。所以只在**真有风险信号**（有 assistant 且无 reasoning）时出现。
   *
   * 判据只有一处实现：`render.ts` 的 `reasoningRegionFacts`。
   * **纯观测，一个字节都不进请求体**（与 `trust` / `builtAtSeq` 同一条：`context` 不参与发送），
   * 所以不需要为它单独动 `RENDER_VERSION`。**不出现 = 没有这个信号**（正常）。
   */
  regionNoReasoning?: boolean;
  /**
   * v77：**有 assistant 组是被裸 `tool/call` 兜底开启的**（组里没有任何 `message/assistant` /
   * `message/reasoning` 事件）。
   *
   * 它的含义是"日志缺了那一步的响应事件"（或响应事件被遮蔽点切走）——**恢复路径**的形状。
   * 越是这样越要把历史发出去救回来，所以这里**只留痕、不抛**（见 `render.ts` 的
   * `AssistantGroup.openedByCall` 与 `openGroup`）。正常日志不会出现。
   *
   * 纯观测：`context` 不参与发送，不需要为它动 `RENDER_VERSION`。
   */
  groupOpenedByCall?: boolean;
  /**
   * 人格常驻层 = IDENTITY + CONSTITUTION + STYLE + SELF_BRIEF。
   * 它是请求的**最前面**：这里一变，整个请求从头失配。
   */
  instructions: ContextSegment;
  /** 工具清单（JSON 形态的 name/description/parameters） */
  tools: ContextSegment & { count: number };
  /**
   * input[0] 长期记忆层：技能目录 + MCP 索引 + 早期摘要（压缩会改写它）。
   *
   * **记忆索引不在这里**（v30 起在下面的 `state` 那一段）：她写一笔记忆索引就重建一次，
   * 放头部会让整段历史从第 1 条起失守。这一段现在只剩"变了就是大事"的两样。
   *
   * `sections` 是三节**各自**的事实（2026-10-10 加，可选）：整段哈希回答"变了没有"，
   * 它回答"是哪一节变的、变了多少字节"——见 {@link ContextSectionFact}。
   */
  memory: ContextSegment & { sections?: ContextSectionFact[] };
  /** 事件流渲染出来的历史 items。
   *
   * `headHash` 是**前 {@link HISTORY_HEAD_ITEMS} 条**的哈希：历史每步都在追加尾巴（正常），
   * 只有**前段被改写**才是缓存破坏。单看整段哈希会把每次追加都算成破坏，那是刷屏不是哨兵；
   * 而"两边窗口长度不同"这件事由 `historyRewritten` 显式挡掉。
   *
   * `headItems` 是那前 N 条**逐条**的事实（2026-10-10 加，可选）：`headHash` 只说"前段变了"，
   * 它说"变的是第几条"——2026-10-09 19:17 那次现场（`· 重投` 追溯改写历史第 1 条）就属于
   * "整段看上去只是追加、其实头部一条被改写"，有它一眼定位。
   */
  history: ContextSegment & { headHash: string; items: number; headItems?: ContextSectionFact[] };
  /**
   * 本轮固定块（B2）：`[当前状态]` + `[关系档案]` + 本轮选中的记忆正文 + **记忆索引**（v30）。
   *
   * 它在历史之后、此刻层之前，**一轮之内逐字节不变**——正是"一步之内不必重新编码"的那一段。
   * 索引（v30 从 `memory` 挪进来的）排在块的最后一段：它变时前缀能一直命到它之前。
   * **可选**：本次改动之前写下的 `budget/consumed` 里没有这一段（那时状态挤在此刻层里），
   * 读旧事件的一方必须按"没有"处理，而不是当成 0 token 的一段。
   */
  state?: ContextSegment;
  /** 此刻层（尾部那一条 developer 消息）：**逐 step** 变，本来就该变 */
  now: ContextSegment;
  /** 本轮新输入（turn 首个 step 才有；后续 step 为 0） */
  wake: ContextSegment;
  /** 尾部插播（软阈值提示 / 钩子注入）：本来就不落库、每次都可能不同 */
  hint: ContextSegment;
  /** input 整体：条数与 token 合计（便于对账，也是"这次请求有多大"的那一个数） */
  input: { items: number; tokens: number };
}

/** 计算历史前段哈希时取前几条：够早、够便宜，又能抓住"从头被改写" */
export const HISTORY_HEAD_ITEMS = 8;

/** 文本哈希（前 16 位十六进制）。纯函数：同字节永远同哈希 */
export function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, SEGMENT_HASH_CHARS);
}

/** 一段文本 → 段落事实（`instructions` 这种纯文本段用它） */
export function segmentOfText(text: string): ContextSegment {
  return { tokens: estimateTokens(text), bytes: Buffer.byteLength(text, 'utf8'), hash: hashOf(text) };
}

/**
 * 一节文字 → 分节事实（记忆层的三节用它；历史前段逐条另有一处调用，口径见 {@link ContextSectionFact}）。
 *
 * 与 `hashOf` 同源、与 `estimateTokens` 同源，所以段与节、节与节之间可比。
 */
export function sectionFactOf(name: string, text: string): ContextSectionFact {
  return {
    name,
    tokens: estimateTokens(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    hash: hashOf(text),
  };
}

// ──────────────────────────── 命中量的自算（前缀比较） ────────────────────────────

/**
 * **命中量的自算**——拿这一拍的 `context` 与**同一模型上一拍**的 `context` 做前缀比较。
 *
 * 用户的第二条指示（2026-10-26，原话）：「**如果是不返回缓存命中的模型就我们自己算**」。
 *
 * ────────── 为什么需要它（现场，不是设想） ──────────
 *
 * heavy 档曾用 `gpt-6.1-sol`（2026-10-25 16:37 起，events seq 250635–250947 / turns 3783–3786）：
 * 30 拍 `cacheHitTokens` 只有**两种值**——0 或固定的 **5248**，而同一段的 `inputTokens` 已从
 * 21,378 涨到 32,225（命中量与上下文规模**无关**）。合计 hit 47,232 / miss 820,151 ⇒ 未命中
 * **94.6%**；可那 30 拍里 `instructions`（7052 tok / d3738e）与 `tools`（5476 tok / 4d118a）
 * 一个字节都没变过。切回 `deepseek-flash` 之后同一段日志的未命中是 **11.1%**（逐步 6.3 / 8.1 /
 * 6.5%）——同一个窗口、同一个前缀设计，两个数差 8 倍 ⇒ 那条 94.6% 量的是**端点报不报缓存**，
 * 不是我们的前缀好不好。旧口径把两个模型的账混在同一个 20 轮窗口里，于是报出 79.8%，
 * 读起来像"我们的前缀设计坏了"。
 *
 * ────────── 这条函数给的是什么 ──────────
 *
 * 我们自己发出的上下文快照（`budget/consumed.context`，每拍都有）里，段与段都有 `hash`。
 * 按**请求体的顺序**逐段比，**连续相同的段**的 tokens 加起来 = 估算命中量。这是**已有数据**，
 * 一个新协议字段都不用加。
 *
 * 三条口径（都刻意保守，宁可低估命中、不可高估）：
 *   · **顺序即请求体**：instructions → tools → memory → history（逐条 item）→ state → now
 *     → wake → hint → input。**第一处不同 ⇒ 立刻停**，后面的段落即使碰巧相同也不再累加
 *     （前缀已经从那里断了，后面的"相同"不是同一段前缀）；
 *   · **history 只能逐条比**：整段哈希每拍都变（尾巴一直在追加），拿它当判据等于"永远不命中"；
 *     真正要回答的是"**前面那几条有没有被改写**"。没有逐条事实（老日志没有 `headItems`）时
 *     **一个 token 都不算**，不猜。尾巴那几条没有逐条事实 ⇒ 也只算被比过且相同的条目；
 *   · **没有 `context`（老日志）或没有同模型上一拍 ⇒ 0**，不拿别的拍顶替、不拿平均值凑。
 *
 * `input` 那一格是 **item 合计**（不是新的一段，上面各段已经计过），所以它只当"整段还相同"的
 * 最后一道确认，**不再重复累加它的 tokens**——否则命中量会被算成两倍。
 *
 * 估出来的东西只进两处：`runtime/cache-alert.ts` 的**告警读数**（窗口级，见那里的
 * `cacheCaliberOf`）与 `budget/consumed.cacheEstimated` 那一格留痕。**不覆盖**供方给的
 * `cacheHitTokens` / `cacheMissTokens`（有就用供方，理由见 `log/types.ts` 的那两格注释）。
 */
export function estimatePrefixHitOf(previous: ContextBreakdown, current: ContextBreakdown): number {
  let hit = 0;
  // ①②③ 三段无条件的头：人格常驻层 / 工具清单 / 长期记忆层
  for (const name of ['instructions', 'tools', 'memory'] as const) {
    const before = previous[name];
    const after = current[name];
    if (before.hash !== after.hash) return hit;
    hit += after.tokens;
  }
  // ④ 历史 items：逐条比（口径见方法头）
  const history = historyPrefixOf(previous.history, current.history);
  hit += history.tokens;
  if (history.broken) return hit;
  // ⑤⑥⑦⑧ 本轮固定块 / 此刻层 / 本轮输入 / 尾部插播
  for (const name of ['state', 'now', 'wake', 'hint'] as const) {
    const before = previous[name];
    const after = current[name];
    // 两边都没有 ⇒ 这一段本来就不存在（老日志的 `state`），视为相同、贡献 0
    if (before === undefined && after === undefined) continue;
    // 一边有一边没有 ⇒ 字节不同（缺的那一边读作"没有这一段"），前缀在这里断
    if (before === undefined || after === undefined) return hit;
    if (before.hash !== after.hash) return hit;
    hit += after.tokens;
  }
  // ⑨ input 整体：**不累加**（它就是上面各段的合计），只当最后一道确认
  return hit;
}

/**
 * history 段的逐条前缀比较（{@link estimatePrefixHitOf} 的第 ④ 步）。
 *
 * 返回两件事：**比过且相同的条目贡献多少 token** + **前缀是不是在这里断了**。
 * 断与不断分开返回是刻意的：`history` 之后还有 `state`/`now` 要接着比，
 * 而"前面几条相同、尾巴在追加"是**正常**形状（每拍都在追加），不该让整条走不下去。
 *
 * 五种形状，各自的结论：
 *   · 整段哈希相同 ⇒ 完全相同的段，整段 tokens 全算（唯一"完全命中"的形态）；
 *   · 逐条比，某一条不同 ⇒ 前面的算、**从那条起断**；
 *   · 逐条比全同、条目数变多 ⇒ 尾巴在追加，前缀完整，**不断**（尾巴不算 token）；
 *   · 逐条比全同、条目数没变而整段哈希变了 ⇒ 有老条目被就地改写（压缩/重排队），**断**；
 *   · 逐条比全同、条目数变少 ⇒ 有老条目被裁掉，**断**；
 *   · 两边任一侧没有 `headItems`（老日志）⇒ 逐条事实缺失，**断**（一个 token 都不算）。
 */
function historyPrefixOf(
  previous: ContextBreakdown['history'],
  current: ContextBreakdown['history'],
): { tokens: number; broken: boolean } {
  if (previous.hash === current.hash) return { tokens: current.tokens, broken: false };
  const before = previous.headItems;
  const after = current.headItems;
  // 没有逐条事实 ⇒ 只能看 headHash，而它只盖前 N 条，答不出"整段还一样吗" ⇒ 不猜
  if (before === undefined || after === undefined) return { tokens: 0, broken: true };
  let tokens = 0;
  const shared = Math.min(before.length, after.length);
  for (let index = 0; index < shared; index += 1) {
    const left = before[index];
    const right = after[index];
    if (left === undefined || right === undefined) return { tokens, broken: true };
    if (left.hash !== right.hash) return { tokens, broken: true };
    tokens += right.tokens;
  }
  // 比过的条目全同：**追加**是正常形状（前缀仍然完整），其余都是改写了老条目
  if (current.items > previous.items) return { tokens, broken: false };
  return { tokens, broken: true };
}

// ──────────────────────────────── 哨兵 ────────────────────────────────

/**
 * 破坏类别。取**最早失守的那一段**当主类别——它才是"为什么整段前缀没了"的答案：
 * 头部失守会连带后面全部失守，只报最后一段等于把原因藏起来。
 */
export type CacheBreakClass =
  /** 人格文件（IDENTITY / CONSTITUTION / STYLE）被改写 → 头部失守 */
  | 'persona'
  /** 工具清单变了（MCP 上下线、destructive 开关、描述改写） */
  | 'tools'
  /** 长期记忆层被改写（上下文压缩、技能目录变化）→ 从第 1 条 input 起失守 */
  | 'memory'
  /** 历史前段被重写（注入预警给旧消息补话、重排队…） */
  | 'history'
  /**
   * 本轮固定块被改写（v31 起它能被单独观察）：她改了 `STATE.md` / 关系档案，
   * 或写记忆导致索引重建——块内其余几样都还命得中，前缀断在这一格之后。
   */
  | 'state'
  /** `RENDER_VERSION` 变了：渲染口径换代，请求体整体不同 */
  | 'render'
  /** 空闲过期：隔太久 + 命中率塌陷（服务端把前缀回收了） */
  | 'idle';

/** 类别 → 一句话。人话在前，机制在后（界面直接贴，不加工） */
const CLASS_TEXT: Record<CacheBreakClass, string> = {
  persona: '人格文件被改写（IDENTITY / CONSTITUTION / STYLE）——常驻前缀从第一个字节起失守',
  tools: '工具清单变了——tools 段之后的所有内容都要重算',
  memory: '长期记忆层被改写（上下文压缩或技能目录变化）——从第 1 条 input 起失守',
  history: '历史前段被重写（例如给旧消息补了框架提示）——前缀从改写处断开',
  state: '本轮固定块被改写（她改了 STATE / 关系档案，或写记忆导致索引重建）——前缀从块内断开',
  render: '渲染版本换代——请求体整体与上一版不同',
  idle: '空闲太久，服务端把前缀回收了——命中率塌陷',
};

/** 阈值（来自 `config.contextAudit`，默认保守；见 ContextAuditThresholds 的字段注释） */
export interface CacheBreakThresholds {
  /** 空闲多久之后才检查命中率塌陷（毫秒） */
  idleMs: number;
  /** 命中率**相对**跌幅门槛（0–1） */
  hitDrop: number;
}

/** 命中率塌陷还要看上次的底子：上次本来就没命中（< 这个值）时，跌无可跌，不报 */
export const IDLE_PREV_HIT_FLOOR = 0.5;

/** 默认阈值（config 缺失时的兜底，与 config.ts 内置默认同值） */
export const DEFAULT_CACHE_BREAK_THRESHOLDS: CacheBreakThresholds = {
  idleMs: 30 * 60 * 1000,
  hitDrop: 0.5,
};

// ──────────────────────────── 归因（为什么失守） ────────────────────────────

/**
 * 失守的**原因**（2026-10-05 新增，用户批准的「让失守提示带上归因」）。
 *
 * 为什么要有这一层（用户的原话，2026-10-05）：
 * 「框架提示天天报缓存前缀失守，但今天绝大多数失守是我们自己造成的」——十几次重启后端、
 * 她自己频繁改 `persona/STATE.md`、工具清单变更，**预期内的代价和真正的异常混在同一条告警里
 * ⇒ 告警常态化 ⇒ 人就不看了**。所以段哈希比对（{@link detectCacheBreak}）之外再加一层：
 * 拿**事件**去解释"这一段为什么会变"。
 *
 * 判据在 {@link segmentCause}（**只做一处**）；"预期内"（`restart` / `asset` / `tool-inventory` /
 * `compaction` / `render` / `idle` / `turn-boundary`）只降级**展示与分级**，
 * 事件照旧逐条落库——日志只增不改。
 */
export type CacheBreakCause =
  /** 接管/重启：两次调用之间真的有一次 `instance/takeover` / `session/start` */
  | 'restart'
  /** 她自己改了资产：`persona/updated`（含 GUI 直编）或记忆落盘（索引因此重建） */
  | 'asset'
  /** 人格/工具清单变更：`config/changed` 命中 tools/mcp 段、技能目录或 `skill/installed` */
  | 'tool-inventory'
  /** 上下文压缩：`compaction/summary` 改写了早期摘要（记忆层）与遮蔽点（历史前段） */
  | 'compaction'
  /** 段哈希变了，但上述事件一条都解释不了它——**只有这一类仍然告警** */
  | 'unattributable'
  /** `RENDER_VERSION` 变了（渲染口径换代，本来就预期全 miss） */
  | 'render'
  /** 空闲过期：服务端把前缀回收了（正交判据，不是某一"段"的事） */
  | 'idle'
  /** 固定块那一格的换轮重建（只在真的跨了 turn 边界时；见 {@link blockRebuiltAtTurnBoundary}） */
  | 'turn-boundary';

/** 一类原因对应一句话（人话在前，判据在后；界面直接贴，不加工） */
const CAUSE_TEXT: Record<CacheBreakCause, string> = {
  restart: '原因是接管/重启（`instance/takeover` / `session/start`）——进程换代本来就要重编码一次',
  asset: '原因是她自己刚改了资产（`persona/updated` 或记忆落盘 ⇒ 固定块/记忆层换版）',
  'tool-inventory': '原因是人格/工具清单变更（`config/changed`、技能目录或 `skill/installed`）',
  compaction: '原因是上下文压缩（`compaction/summary` 换了一版早期摘要、遮蔽点跟着动）',
  unattributable: '原因不明：指纹变了，但两次调用之间没有任何能解释它的事件',
  render: '原因是渲染版本换代（本来就预期一次全 miss）',
  idle: '原因是空闲太久、服务端把前缀回收了',
  'turn-boundary': '原因是跨了轮边界、固定块在轮首重建（设计内）',
};

/**
 * 预期内的原因：**不告警**，只在日志里留一条普通记录。
 *
 * `render` 与 `idle` 也在内：前者是我们改渲染口径换来的一次性代价（改完前缀重新稳定），
 * 后者是服务端回收了空闲前缀（`idle` 判据本来就要求"久 + 命中率塌陷"两条同时成立，
 * 见 `idleCollapse`）。**真出事的是 `unattributable`**——指纹变了却说不出为什么。
 */
const EXPECTED_CAUSES: ReadonlySet<CacheBreakCause> = new Set<CacheBreakCause>([
  'restart', 'asset', 'tool-inventory', 'compaction', 'render', 'idle', 'turn-boundary',
]);

/** 这一条原因算不算"预期内"（`unattributable` 是唯一一个不算的） */
export function isExpectedCause(cause: CacheBreakCause): boolean {
  return EXPECTED_CAUSES.has(cause);
}

/** 一段失守 + 它的原因 */
export interface CacheBreakCauseEntry {
  /** 失守的段（与 {@link CacheBreak.classes} 一一对应、同序） */
  class: CacheBreakClass;
  cause: CacheBreakCause;
}

/** 一次被审计的模型调用（从 `budget/consumed` 折出来） */
export interface AuditedCall {
  context: ContextBreakdown;
  /** 调用发生的时刻（事件自带 ts） */
  ts: string;
  cacheHitTokens: number;
  cacheMissTokens: number;
  /**
   * 这条调用在日志里的 seq。
   *
   * 它只服务一件事：**把两次调用之间的事件窗口切出来**（归因要用它）。
   * **可选**：手写构造的 `AuditedCall`（测试、诊断）可以不给——那时窗口无从谈起，
   * 归因一律落到 `unattributable`（宁可多报一条，也不凭空替一段失守编原因）。
   */
  seq?: number;
  /**
   * **请求体构造点**（= `context.builtAtSeq`）：这条请求渲染时看得见的最大事件 seq。
   *
   * 窗口优先用它，而不是上面那个 `seq`（完成点）：见 {@link ContextBreakdown.builtAtSeq}。
   * **可选**：老日志没有它、手写构造的调用也可以不给 ⇒ 退回用 `seq` 切窗口，结论不变。
   */
  builtAtSeq?: number;
  /**
   * 这条调用属于第几轮（`budget/consumed.turn`）。
   *
   * 它只服务固定块的"形状差异"判据：块**只在每轮第 1 步发**，比"上一轮某一步"与"这一轮第 1 步"
   * 的块哈希等于拿两个形状不同的请求比大小——**轮号不同就是形状不同**（见
   * {@link blockIsShapeDifference}）。
   *
   * ⚠ 不能拿"窗口里有没有 `turn/start`"顶替：轮边界不一定落在两次调用之间（实测 2026-10-05：
   * turn 565 在第 1 步之后被打断，turn 566 的 `turn/start` 落在**上一次调用之前**）。
   * 同样**可选**，缺了按"认不出"处理（照旧按段失守报）。
   */
  turn?: number;
}

/** 缓存破坏的结论（写进 `budget/consumed.cacheBreak`） */
export interface CacheBreak {
  /** 主类别：**最早**失守的那一段（正交判据 `render` / `idle` 只在没有段失守时当主类别） */
  class: CacheBreakClass;
  /** 本轮命中的全部类别，按"越靠前越早失守"排 */
  classes: CacheBreakClass[];
  /** 一句话人话摘要（界面原样贴） */
  reason: string;
  /** 距上一次被审计的调用隔了多久（毫秒）：`idle` 判据用它，排障也用它 */
  gapMs: number;
  /**
   * 主类别对应的原因（= `causes[0].cause`）。本字段是后加的，**老日志里没有**——
   * 读旧事件的一方按 `undefined` 处理（等价于"当时没归因过"，不是"无法归因"）。
   */
  cause?: CacheBreakCause;
  /** 每个失守段各自的原因，与 `classes` 同序 */
  causes?: CacheBreakCauseEntry[];
  /**
   * 这一次失守该不该**告警**：`true` = 四类原因都能解释它，降级成普通记录。
   *
   * 判据只有一条：**只要有一条原因是 `unattributable` 就告警**（`silent === false`）。
   * 老日志没有这个字段 ⇒ 读的一方按"要告警"处理（`silent !== true`），历史条目一条不丢。
   */
  silent?: boolean;
  /** 这次调用本人的 seq（与 {@link AuditedCall.seq} 同源，重放对齐用） */
  seq?: number;
  /**
   * **新旧分段对照**（2026-10-10 加，可选）：哪一段变了、变了多少字节 / 多少 token、分节里是哪一节。
   *
   * 为什么要有它（用户 2026-10-10 的原话：「以后再有失守，一眼看出是哪一节、变了多少字节，
   * 不用再绕一整轮归因」）：`classes` 只说"记忆层变了"，接下来人要自己去把两次请求体逐字节重建
   * 才能知道变的是哪一节——2026-10-09 18:07 那次（MCP 索引那一行 +6 token）与 19:17 那次
   * （历史第 1 条 item 被补 ` · 重投`）都是这么查出来的，各花了半小时。
   *
   * 与 `classes` **同序、只含"真的按段失守"的那几类**（`render` / `idle` 不是某一段的字节，不编）。
   * **可选**：老日志没有它。
   */
  diff?: CacheBreakDiff[];
}

/**
 * 一段（或一节）的新旧对照。字段一律**可选**，因为两边都可能缺那一段：
 *   · `state` 只在每轮第 1 步发（一边有、一边没有是常态）；
 *   · `sections` / `headItems` 是 2026-10-10 才有的（老日志两边都没有）。
 * 缺一边时 `delta*` 一律不出现——**不拿 0 冒充"没变"**，那是两种不同的事实。
 */
export interface CacheBreakSectionDiff {
  /** 节名：记忆层是 `skills` / `mcp` / `summary`；历史前段是 `#1`…（item 序号，从 1 起） */
  name: string;
  /** 两边的哈希是否不同（缺一边时也算"变了"，因为形状变了） */
  changed: boolean;
  /** 这一节出现在哪一边（`prev-only` / `next-only` 也是形状变化的一种） */
  side: 'both' | 'prev-only' | 'next-only';
  prevHash?: string;
  nextHash?: string;
  prevTokens?: number;
  nextTokens?: number;
  deltaTokens?: number;
  prevBytes?: number;
  nextBytes?: number;
  deltaBytes?: number;
}

/**
 * 一整段的对照（{@link CacheBreakSectionDiff} 的展开形态，见那边的口径）。
 *
 * `changed` / `side` **必填**（2026-10-11 补齐）：它们本来就在继承来的那两格上（`Omit` 只去掉
 * `name`），可实参一直没给——于是 `persona` / `tools` / `state` 三种段级条目**永远显示不出"变了"**，
 * 读的人只能去 `class` 或哈希上猜。口径：
 *   · `changed` —— 两边哈希不等（**缺一边也算变**：形状变了就是变了）；
 *   · `side`    —— 这一段出现在哪一边（`prev-only` / `next-only` / `both`）。
 */
export interface CacheBreakDiff extends Omit<CacheBreakSectionDiff, 'name'> {
  class: CacheBreakClass;
  /**
   * 分节对照（只有 `memory` / `history` 有）：
   *   · `memory` → 三节（技能目录 / MCP 索引 / 早期摘要）；
   *   · `history` → 前 {@link HISTORY_HEAD_ITEMS} 条**逐条**（`#1`…）——"变的是第几条"就靠它。
   * **没变的节也照列**（`changed: false`）："哪一节都没变"与"这一版没有分节"是两件事，
   * 读的人必须能分开——后者意味着"要另找原因"，前者意味着"原因在这几节之外"。
   */
  sections?: CacheBreakSectionDiff[];
}

/** 窗口里出现这两个，就说明进程换过代（`instance/takeover` 先写、`session/start` 紧随） */
const RESTART_EVENTS: ReadonlySet<string> = new Set(['instance/takeover', 'session/start']);

/** `persona/updated` 改到这些文件 ⇒ `instructions` 段换版（`renderInstructions` 只吃这三样） */
const INSTRUCTION_ASSETS: readonly string[] = ['IDENTITY', 'CONSTITUTION', 'STYLE'];

/** 一次调用里被改动的资产，按"它会影响哪一段"归好类 */
interface AssetTargets {
  /** 人格常驻层（instructions 段）被改写 */
  instructions: boolean;
  /** 本轮固定块（state 段）被改写：STATE / 关系档案 / 记忆索引 */
  fixedBlock: boolean;
}

/**
 * 从事件窗口里认出"她自己改了资产"的证据。
 *
 * 三种证据，各自映射到**它真正影响的那一段**：
 *   · `persona/updated` 指到 `IDENTITY` / `CONSTITUTION` / `STYLE` → `instructions`；
 *   · `persona/updated` 指到 `STATE.md` / `RELATIONSHIPS/*` → `state`（固定块里那两节）；
 *   · **写 `MEMORIES/` 下的文件** → 记忆索引重建（`workspace/MEMORIES/INDEX.md`），
 *     而索引在固定块的最后一段 ⇒ 同样只作废 `state` 段。
 *
 * 判据取"事件里写了哪个文件的路径"：工具调用的 `arguments` 是一个 JSON 串，路径就在里面。
 * 这一步刻意做得**保守**：认不出路径就不算证据（落 `unattributable`，仍会告警）。
 */
function assetTargets(window: readonly AppEvent[]): AssetTargets {
  let instructions = false;
  let fixedBlock = false;
  for (const event of window) {
    if (event.type === 'persona/updated') {
      const file = normalizeSlashes(event.data.file).toUpperCase();
      const base = file.slice(file.lastIndexOf('/') + 1);
      if (INSTRUCTION_ASSETS.some((name) => base === `${name}.MD`)) instructions = true;
      else if (base === 'STATE.MD' || file.includes('RELATIONSHIPS/')) fixedBlock = true;
      continue;
    }
    // 记忆落盘：`tool/call` 的 arguments 里出现 MEMORIES 路径 ⇒ 索引会重建
    if (event.type === 'tool/call'
      && normalizeSlashes(JSON.stringify(event.data.arguments)).toUpperCase().includes('MEMORIES')) {
      fixedBlock = true;
    }
  }
  return { instructions, fixedBlock };
}

/** 路径统一成正斜杠（Windows 的 `\` 与 POSIX 的 `/` 都要认） */
function normalizeSlashes(text: string): string {
  return text.replace(/\\/gu, '/');
}

/**
 * 固定块那一格的**形状**变了：它不算前缀失守。
 *
 * 为什么单独判这一条：固定块**只在每轮第 1 步发**，第 2 步起就摘了。实测（2026-10-05 从
 * 1151 条带归因的调用里数出来）：**213 条调用带块**，同一轮内相邻两次调用的块哈希变化 **0 次**
 * （一轮之内冻结，设计如此）；而**跨轮**的相邻两次里有 **68 次**哈希不同——块在轮首重建，
 * 上一轮那一步的块与这一轮第 1 步的块本来就不可比（一边有块、一边没有，或内容随轮首快照换版）。
 *
 * 这正是 `history` 尾巴那条纪律的同一形态：**"快照换了"不等于"前缀被改坏了"**。
 * 判据（四个都要，且**只对 `state` 这一段**生效——别的段该报照报）：
 *
 *   ① 两次调用**分属不同的轮**（轮号从日志里读：`budget/consumed.turn`，见 {@link turnOfCall}）；
 *   ② 两次**都真发了块**（`state.items > 0`；一边没发就是"一边有一边没有"，更不可比）；
 *   ③ **只有 `state` 这一段变**（`stateAloneChanged`）——别的段也变了说明这一轮换的东西不止
 *      块里那几样，那就照旧报出来；
 *   ④ 窗口里没有"她自己动了块里那几样"的证据（`persona/updated` 改 STATE / 关系档案，
 *      或写 `MEMORIES/` 导致索引重建）——**这一条是判据只紧不松的关键**：她真改了资产时，
 *      块的换版是**有内容变化**的换版，必须报出来（归因 `asset`，不告警）。
 *
 * ── 2026-10-11 补的一条：**"索引注入与否"也是形状**（用户报的 06:27 那张卡就是它） ──
 *
 * 现场（本地 10-11 06:27，seq 78793）：`state` 段从 962 tok / 4316 B 变成 1857 tok / 8271 B
 * （+3955 B ≈ `MEMORIES/INDEX.md` 的 3990 字节），卡片措辞读起来像"她改了 STATE"——
 * 而**她一个字节的 STATE / 关系档案都没动**。真相是那两拍分属不同的轮，且**块的形状本就不同**：
 *   · prev 是**心跳轮**（`memory/selected{turn, injection:'heartbeat', entries:0}`）——
 *     心跳轮**整段不注入**记忆索引（`real-loop.ts` 的 `agentDeps`：`isHeartbeatTurn` ⇒ 索引不出现）；
 *   · cur 是**人说的轮**（`injection:'human'`, `entries:30`）——索引进固定块的最后一段。
 * 判据（放在第 ④ 条**之后**，所以"她真写了资产"那条从严的口径一个字没松）：
 *   · 窗口里认得出 `memory/selected` 的注入理由，且这是"**一边注入、一边不注入**"的形态
 *     （一侧 `entries === 0`/`injection === 'heartbeat'`，另一侧不是）⇒ 这一格的差**不需要**
 *     `persona/updated` 或写 MEMORIES 也能解释 ⇒ 不算她改了资产（按形状差异放过，照旧留一句 note）。
 *
 * 第四条与这一条的分工：**先问"她动没动资产"（动了就照旧报 `asset`），再问"是不是注入与否"**。
 * 两条都不成立、轮号又读不出来时才按段失守走——宁可多报一条。
 *
 * 判据用到的三样事实（轮号、`state.items`、事件窗口）**全在日志里**，重放可复算。
 */
function blockIsShapeDifference(prev: AuditedCall, cur: AuditedCall, window: readonly AppEvent[]): boolean {
  if (!blockChanged(prev.context, cur.context)) return false;
  if ((prev.context.state?.items ?? 0) === 0 || (cur.context.state?.items ?? 0) === 0) return true;
  // 别的段也变了 ⇒ 不是"块换了个快照"这一件事，照旧按段失守走
  if (nonBlockBreaks(prev.context, cur.context).length > 0) return false;
  // 她真动了块里那几样 ⇒ 有内容变化，必须报出来（归因 asset，不告警）
  if (assetTargets(window).fixedBlock) return false;
  // 她没动资产，而这一格的差又能被"索引注入与否"解释（心跳轮 ↔ 人说的轮）⇒ 同样是形状差异
  if (memoryIndexInjectionFlipped(prev, cur, window)) return true;
  // 轮号读不出来（老日志 / 手写调用）：认不出"换轮重建"，按段失守走——宁可多报一条
  if (prev.turn === undefined || cur.turn === undefined) return false;
  return prev.turn !== cur.turn;
}

/**
 * 这两拍之间**记忆索引的注入与否**翻转了没有（2026-10-11，06:27 那张卡的判据）。
 *
 * 背景：`state` 段 = `[当前状态]` + `[关系档案]` + **记忆索引**（`render.ts` 的
 * `turnBlock = renderTurnBlock(turnBlock, memoryIndex)`）。索引是这份块里唯一"按轮决定进不进"的
 * 素材——心跳轮整段不注入（设计如此，2026-10-04 用户口径："只有用户输入时才注入"）。
 * 于是"心跳轮那一步"与"人说的那一轮第 1 步"的块哈希不同**是必然的**，与"她改了资产"无关。
 *
 * 判据（四条都要。**只用日志里现成的事实**，见 `MemorySelected` 事件）：
 *   · 窗口里至少有一条 `memory/selected`——它是"这一轮的注入账"，`injection` 与 `entries` 都在上面；
 *     一条都没有（老日志 / 手写调用）⇒ **认不出**，一句话都不说（退回按段失守走，宁可多报一条）；
 *   · 账里的轮号要**认得出这两拍各是哪一轮**：两条账（或一条账 + 一侧本身是心跳拍）能覆盖
 *     `{prev.turn, cur.turn}`——两拍同轮时本就轮不到这条判据，所以这里要求覆盖数 ≥ 2；
 *   · 两侧**逐条取到"这一轮注入了几条"**，且**恰好一侧是 0、另一侧不是**（这就是"翻转"）；
 *     两边都是 0 或两边都不是 0 ⇒ 不是这条形状差异，不提它；
 *   · 轮号缺一侧 ⇒ 认不出，不认。
 *
 * ⚠ 口径上刻意**不猜**：`entries` 是要紧的那一格（"索引到底进没进请求"），`injection` 只是它的
 * 旁注——账里写着 `heartbeat` 就一定是 0 条，写着 `human` 也可能是 0 条（记忆还空着），
 * 而**空的索引段与"没有索引段"在请求里都是那一段为空**，所以判据认 `entries`。
 */
function memoryIndexInjectionFlipped(
  prev: AuditedCall,
  cur: AuditedCall,
  window: readonly AppEvent[],
): boolean {
  const turns: number[] = [];
  if (prev.turn !== undefined) turns.push(prev.turn);
  if (cur.turn !== undefined && cur.turn !== prev.turn) turns.push(cur.turn);
  if (turns.length < 2) return false;
  const entriesOf = new Map<number, number>();
  let sawLedger = false;
  for (const event of window) {
    if (event.type !== 'memory/selected') continue;
    sawLedger = true;
    // 同一个 turn 写两条时取最后一条（与 replay 的 `memorySelectedOf` 同口径：最后一条为准）
    entriesOf.set(event.data.turn, event.data.entries);
  }
  if (!sawLedger) return false;
  const sides = turns.filter((turn) => turn !== undefined).map((turn) => entriesOf.get(turn));
  if (sides.some((entries) => entries === undefined)) return false;
  const zeroes = sides.filter((entries) => entries === 0).length;
  return zeroes === 1;
}

/**
 * 两次调用**分属不同的轮**（轮号从日志里读：`budget/consumed.turn`）。
 *
 * 判不出来（老日志 / 手写调用缺 `turn`）就算"同轮"——宁可多报一条，也不许凭缺字段替一段失守
 * 开脱（与 {@link blockIsShapeDifference} 第 ④ 条同一条纪律）。
 */
function crossesTurnBoundary(prev: AuditedCall, cur: AuditedCall): boolean {
  if (prev.turn === undefined || cur.turn === undefined) return false;
  return prev.turn !== cur.turn;
}

/** 跨轮那句话（**唯一一处措辞**：它与 `blockIsShapeDifference` 那张 note 共用） */
const CROSS_TURN_NOTE =
  '（本次比对的两次调用**分属不同的轮**——跨轮的前缀本来就不可比：固定块在轮首重建、工具清单与记忆层都可能整体换版，'
  + '所以这一次不报段失守，只留这一句。）';

/**
 * **预期内换档**那句话（2026-10-11 加，用户报的四张"tools 段失守"卡的归因）。
 *
 * 与"MCP 掉线"分开的**唯一**判据写在 {@link inventoryTrustShifted}：事件自带的
 * `tools/inventory-changed.kind`。落到这一句上的条件（逐字）：
 *   · 窗口里真有一条 `tools/inventory-changed`，且它落库时被判成 `kind: 'trust-tier'`
 *     ——即**同一条 RENDER_VERSION 下、工具表的父子集关系**造成的增删（信任档收窄/放开：
 *     同一件工具从"常规可见"变成"白名单放行"，名字集合只减不增）；
 *   · 而**不是** `kind: 'mcp'`（`mcp__*` 那批进出清单：掉线/上线，是**真变化**，要人去查）
 *     或 `kind: 'registry'`（工具表本身被换过：注册/注销，也不是换档）。
 */
const TRUST_SHIFT_NOTE =
  '（这一次是**信任档换档**：同一版 `RENDER_VERSION` 下工具表只发生了"父子集"式的增减——'
  + '外部轮拿到严格白名单那四件 vs 用户/她自己那一轮拿到全部；`tools/inventory-changed.kind = '
  + '\'trust-tier\'` 就是凭据。它**不是** MCP 掉线/上线（那一类记 `kind: \'mcp\'`）也不是工具表'
  + '被换过（`kind: \'registry\'`）。）';

/** 除固定块以外的段失守（{@link segmentBreaks} 与"形状差异"判据共用，免得两处各写一份） */
function nonBlockBreaks(prev: ContextBreakdown, cur: ContextBreakdown): CacheBreakClass[] {
  const segments: CacheBreakClass[] = [];
  if (prev.instructions.hash !== cur.instructions.hash) segments.push('persona');
  if (prev.tools.hash !== cur.tools.hash) segments.push('tools');
  if (prev.memory.hash !== cur.memory.hash) segments.push('memory');
  if (historyRewritten(prev, cur)) segments.push('history');
  return segments;
}

/** 逐段比对（按请求体顺序，越靠前越早失守）。{@link detectCacheBreak} 与归因**共用这一处** */
function segmentBreaks(
  prev: AuditedCall,
  cur: AuditedCall,
  evidence: WindowEvidence,
): CacheBreakClass[] {
  const segments = nonBlockBreaks(prev.context, cur.context);
  if (blockChanged(prev.context, cur.context)
    && !blockIsShapeDifference(prev, cur, evidence.window)) {
    segments.push('state');
  }
  return segments;
}

/** 固定块那一格变没变（旧日志里没有这一段：两边的"没有"算没变） */
function blockChanged(prev: ContextBreakdown, cur: ContextBreakdown): boolean {
  if (prev.state === undefined || cur.state === undefined) return false;
  return prev.state.hash !== cur.state.hash;
}

/** 窗口里的证据（一次性认出来，逐段判定共用同一份，免得两段各认一遍认歪） */
interface WindowEvidence {
  restarted: boolean;
  assets: AssetTargets;
  inventoryChanged: boolean;
  /**
   * 这一次清单变化是**信任档换档**（`tools/inventory-changed.kind === 'trust-tier'`），
   * 而**不是**"MCP 掉线 / 工具表真换了"那一种（2026-10-11 加，见 {@link inventoryTrustShifted}）。
   *
   * 两个字段分开的理由：`inventoryChanged` 回答"清单动没动"（动没动决定**能不能归因**），
   * 这一格回答"**动的是哪一类**"（决定措辞与读账的人该不该去查）。**判据只在这一处**，
   * 措辞与分级都读它，不另写一份。
   */
  trustShifted: boolean;
  compacted: boolean;
  /** 事件窗口本身（固定块的形状判据要拿它读轮号） */
  window: readonly AppEvent[];
}

/** 从事件窗口里认证据。**判据只在这一处** */
function evidenceOf(window: readonly AppEvent[]): WindowEvidence {
  const inventory = window.filter(inventoryMoved);
  return {
    restarted: window.some((event) => RESTART_EVENTS.has(event.type)),
    assets: assetTargets(window),
    // 前三种（配置热更 / 技能安装 / MCP 上下线）与 `tools/inventory-changed` **并列**：
    // 它们都不是"出事了"，但它们的**处置方式不同**（前三种要人去核配置/技能/MCP，
    // 换档只是"下一拍就回去"）——分档在下面那一格，这里只回答"动没动"。
    inventoryChanged: inventory.length > 0,
    trustShifted: inventory.some(inventoryTrustShifted),
    compacted: window.some((event) => event.type === 'compaction/summary'),
    window,
  };
}

/**
 * 工具清单换过版的证据（四种，都是**我们自己的动作**，不是"出事了"）：
 *   · `config/changed` 落在 `tools` / `mcp` 段（destructive 开关、清单开关是热更字段）；
 *   · `skill/installed`（技能过信任门 ⇒ 技能目录与 catalog 换版）；
 *   · `mcp/server-started` / `mcp/server-stopped`（MCP 上下线 ⇒ `mcp__*` 那批工具进出清单）；
 *   · **`tools/inventory-changed`**（2026-10-11 加，BUG-3）：构请求那一刻现取的清单指纹变了。
 *
 * 第四条为什么必须在这一份判据里（而不是只当一条观测）：进请求的 `tools` 数组是
 * `registry.listForModel(...)` 在**构请求那一刻**现取的活值，上面那三种动作**一条都不是**的时候
 * 它照样会变（现场：2026-10-11 03:00:05 那拍，24 件 → 4 件、−4592 token，窗口里一条 `mcp/*`、
 * `config/*`、`skill/*` 都没有 ⇒ 必然落 `unattributable` 并告警）。有了它，tools 段的失守才归得了因。
 */
function inventoryMoved(event: AppEvent): boolean {
  if (event.type === 'skill/installed') return true;
  if (event.type === 'mcp/server-started' || event.type === 'mcp/server-stopped') return true;
  if (event.type === 'tools/inventory-changed') return true;
  if (event.type !== 'config/changed') return false;
  return event.data.fields.some((field) => field === 'tools' || field.startsWith('tools.')
    || field === 'mcp' || field.startsWith('mcp.'));
}

/**
 * 这一次清单变化**是信任档换档**吗（2026-10-11 加）——"**预期内换档**"与"**MCP 掉线**"的**唯一**
 * 区分判据点。判据**不在这里现算**：`kind` 由构请求处（`runtime/agent-loop.ts` 的
 * `toolInventoryChangeOf`）在**看得见两份清单名字**的地方定好落进事件——事后读日志的人
 * 手里只有这条事件，判据必须是它自带的字段，否则"复盘时读不出是哪一类"。
 *
 * 两条边界（**判据只紧不松**）：
 *   · 事件里四格**缺一格就返回 false**：宁可让 tools 段照旧落"清单变更"（仍不告警、仍留痕），
 *     也不许凭一条我们没看全的账替它换一个说法；
 *   · `kind !== 'trust-tier'` 一律 false：**`mcp` 那一类（掉线/上线）与 `registry` 那一类
 *     （工具表真被换过）都走不进来**——它们要和"换档"分开读，正是加这一格的全部目的。
 *
 * 为什么信任档换档要单独认出来：四档（`owner`/`self`/`trusted`/`external`）各自给一份清单，
 * "用户/她自己 ↔ 群里的人"来回切时 `tools` 段就在两版之间对调（实测 24 ↔ 4 件，见
 * `runtime/trust.ts` 的 `EXTERNAL_TOOL_ALLOWLIST`）。那是 `render.ts` v44 那篇**有意写下的取舍**
 * （安全压过缓存），所以它**不是异常**——但读账的人得一眼看出"这次不是 MCP 掉了"。
 */
function inventoryTrustShifted(event: AppEvent): boolean {
  if (event.type !== 'tools/inventory-changed') return false;
  const kind: unknown = event.data.kind;
  return kind === 'trust-tier';
}

/**
 * 一段失守的原因（{@link evidenceOf} 认得什么，这里就只认什么）。
 *
 * 顺序是有意的：**接管/重启最先**——它能解释任何一段，而且窗口里真发生重启时，
 * 后面几条证据（人格被改、配置热更）往往同时存在，报"重启"比报"工具清单变更"更接近真相。
 *
 * ⚠ 归因**只到这一层**：`tools` 段一律归 `tool-inventory`，**不再按"换档 / MCP 掉线"分两个
 * 原因值**——那两种的处置（都**不告警**）与分级完全一样，分成两个值只会让 `CacheBreakCause`
 * 的每一张表（`CAUSE_TEXT` / `EXPECTED_CAUSES` / 界面短标签）都跟着长一格。要分开读的那一半
 * 走**证据字段**：{@link WindowEvidence.trustShifted} → `reason` 里那句
 * {@link TRUST_SHIFT_NOTE}，凭据是事件自带的 `kind`（见 {@link inventoryTrustShifted}）。
 */
function segmentCause(segment: CacheBreakClass, evidence: WindowEvidence): CacheBreakCause {
  // ① 接管/重启能解释任何一段：进程换代时工具清单、人格、记忆层都可能重算
  if (evidence.restarted) return 'restart';
  switch (segment) {
    // ② instructions 段只吃人格三层：只有那三个文件被改写才算它的原因
    case 'persona': return evidence.assets.instructions ? 'asset' : 'unattributable';
    // ③ tools 段：工具清单/技能目录变了（配置热更或技能安装）
    case 'tools': return evidence.inventoryChanged ? 'tool-inventory' : 'unattributable';
    // ④ 记忆层：技能目录（清单）+ 早期摘要（压缩）两样，都是我们自己的低频动作
    case 'memory': return evidence.inventoryChanged ? 'tool-inventory'
      : (evidence.compacted ? 'compaction' : 'unattributable');
    // ⑤ 历史前段被重写：唯一的合法来源是上下文压缩（遮蔽点往后挪）
    case 'history': return evidence.compacted ? 'compaction' : 'unattributable';
    // ⑥ 固定块：她改 STATE / 关系档案 / 记忆索引
    case 'state': return evidence.assets.fixedBlock ? 'asset' : 'unattributable';
    default: return 'unattributable';
  }
}

/**
 * 从日志里取**上一次被审计的调用**。
 *
 * 它刻意从事件读而不是从内存读：哨兵要的是"与上一次真实请求比对"，而那次请求的唯一
 * 可靠记录就是日志。重放时喂进同一段事件，`detectCacheBreak` 得到的结论与当时逐字段一致
 * ——这正是"重放保真"对哨兵的要求（不引入只有运行期才有的字段）。
 *
 * 没有 `context` 的老事件（本次改动之前写下的 `budget/consumed`）**跳过**：拿一个没有归因的
 * 调用当基准，只会得到"到处都变了"的假结论。
 */
export function lastAuditedCall(events: Iterable<AppEvent>): AuditedCall | null {
  let found: AuditedCall | null = null;
  for (const event of events) {
    if (event.type !== 'budget/consumed') continue;
    const context = event.data.context;
    if (context === undefined) continue;
    found = {
      context,
      ts: event.ts,
      cacheHitTokens: event.data.cacheHitTokens,
      cacheMissTokens: event.data.cacheMissTokens,
      // seq / turn 都是归因用的（见 AuditedCall 的字段注释）；重放时它们来自同一条日志，逐字段一致
      seq: event.seq,
      // 构造点（新增，可选）：窗口优先用它——完成点会把真正的原因挡在窗口外（2026-10-10）
      ...(context.builtAtSeq === undefined ? {} : { builtAtSeq: context.builtAtSeq }),
      turn: event.data.turn,
    };
  }
  return found;
}

/**
 * 相邻两次请求的前缀比对：**除此刻层尾巴以外的部分**变了就记一条，并注明类别**与原因**。
 *
 * 判据（逐段按请求体里的顺序，越靠前越"早失守"）：
 *   ① `instructions.hash` 变了            → `persona`
 *   ② `tools.hash` 变了                   → `tools`
 *   ③ `memory.hash` 变了                  → `memory`
 *   ④ `history.headHash` 变了             → `history`
 *   ⑤ `state.hash` 变了                   → `state`（固定块；她真动了块里那几样才算，
 *      形状差异不算，见 {@link blockIsShapeDifference}）
 *   ⑥ `renderVersion` 变了                → `render`（正交：它不是某一段的事）
 *   ⑦ `idle`：间隔 ≥ `idleMs` **且** 上次命中率 ≥ {@link IDLE_PREV_HIT_FLOOR}
 *      **且** 本次命中率相对跌掉 ≥ `hitDrop` → `idle`
 *
 * 允许自由变化、**不算破坏**的部分：`history` 的尾巴（追加是常态）、`now`（此刻层本来就每轮变）、
 * `wake`（本轮新输入）、`hint`（尾部插播，本来就不落库）、固定块的形状差异（换了轮、上一轮那一步
 * 根本没发块）。把它们算成破坏，等于每步/每轮都报一次。
 *
 * 第一次调用（`prev === null`）不报：没有可比的对象，"变化"无从谈起。
 *
 * **归因与分级**（2026-10-05，用户批准的「让失守提示带上归因」）：`events` 是调用方手里那份
 * 事件序列（运行期是日志快照，重放是同一段日志），判据据此把每一段失守映射到
 * {@link CacheBreakCause}，并给出 `silent`——**只有 `unattributable` 仍然告警**。
 * 不传 `events`（或两次调用没有 seq）时窗口无从谈起，归因一律 `unattributable`：宁可多报一条，
 * 也不凭空替一段失守编原因（判据只紧不松）；固定块的形状差异也判不出来（没有窗口就没有
 * `turn/start` 可看），于是照旧按段失守走——与本次改动前的行为逐条一致。
 */
export function detectCacheBreak(
  prev: AuditedCall | null,
  cur: AuditedCall,
  thresholds: CacheBreakThresholds = DEFAULT_CACHE_BREAK_THRESHOLDS,
  events: Iterable<AppEvent> = [],
): CacheBreak | null {
  if (prev === null) return null;

  const gapMs = Math.max(0, parseMs(cur.ts) - parseMs(prev.ts));
  // 事件窗口 = **上一次调用的构造点**之后、**本次调用的构造点**（含）之前。
  //
  // 为什么是构造点而不是"上一次调用在日志里的 seq"（2026-10-10 修）：`budget/consumed` 的
  // seq/ts 是调用**结束**的时刻，而请求体是**之前**就装配好的。在飞久的调用（实测 63 秒）会把
  // 真正的原因（那次上下文压缩、那次 `mcp/index` 重建）挡在 `prev.seq` 之前 ⇒ 窗口空 ⇒ 明明是
  // 自己干的，却报成 `unattributable` 并告警（2026-10-09 18:07 / 19:17 两次都栽在这里）。
  // 两端语义：`prev.builtAtSeq` **严格不等**（落在构造点上那条事件上次已经看见了，它变不出差异），
  // `cur.builtAtSeq` **取等**（它正是本次请求看得见的最后一条）。
  // 缺 `builtAtSeq`（老日志 / 手写构造的调用）⇒ 退回按 seq 切，逐字段与本次改动之前一致。
  const windowFrom = prev.builtAtSeq ?? prev.seq;
  const windowTo = cur.builtAtSeq ?? cur.seq;
  // 上界的取等规则跟语义走：构造点**取等**（它正是本次请求看得见的最后一条），旧的 seq 语义
  // 是"本次调用本身不算原因"⇒**严格小于**。
  const includeTo = cur.builtAtSeq !== undefined;
  const window = [...events].filter((event) =>
    (windowFrom === undefined || event.seq > windowFrom)
    && (windowTo === undefined || (includeTo ? event.seq <= windowTo : event.seq < windowTo)));
  const evidence = evidenceOf(window);

  // **跨轮不比段**（2026-10-11 修，BUG-2）。判据与理由见 {@link crossesTurnBoundary}：
  // 两次调用分属不同的轮 ⇒ 逐段比对拿的是两个形状不同的请求（固定块在轮首重建、工具清单与记忆层
  // 都可能整体换版），"哪一段失守"这个问题本身不成立 ⇒ 一段都不报，只留一句说明。
  // 正交判据（`render` / `idle`）**不在此列**：它们比的是版本号与命中率，与"两拍可不可比"无关，
  // 跨轮时照旧成立。基线取错那一半由 `runtime/agent-loop.ts` 的 `TurnRunner` 自己记（同轮内才比）。
  const crossedTurn = crossesTurnBoundary(prev, cur);
  const broken = crossedTurn ? [] : segmentBreaks(prev, cur, evidence);
  const versionChanged = prev.context.renderVersion !== cur.context.renderVersion;
  const idle = idleCollapse(prev, cur, gapMs, thresholds);
  if (broken.length === 0 && !versionChanged && !idle) return null;

  const primary: CacheBreakClass = broken[0] ?? (versionChanged ? 'render' : 'idle');
  const classes = [...broken];
  if (versionChanged) classes.push('render');
  if (idle) classes.push('idle');

  const detail: string[] = [CLASS_TEXT[primary]];
  for (const extra of classes) {
    if (extra !== primary) detail.push(CLASS_TEXT[extra]);
  }
  // 逐段认原因（判据只在 segmentCause 一处；正交的 render / idle 自己也各算一条原因）
  const causes: CacheBreakCauseEntry[] = broken.map((segment) => ({ class: segment, cause: segmentCause(segment, evidence) }));
  if (versionChanged) causes.push({ class: 'render', cause: 'render' });
  if (idle) causes.push({ class: 'idle', cause: 'idle' });

  const cause = causes[0]?.cause ?? 'unattributable';
  // 分级：**每一条原因都是预期内的**才降级（`unattributable` 一条就够它继续告警）
  const silent = causes.every((entry) => isExpectedCause(entry.cause));
  // 固定块的哈希变了、却按"形状差异"放过去时，留一句线索（**不是失守**，只是别让它无声无息地
  // 消失）：事后想核对"这一段到底动没动"的人，在日志里仍然找得到它。
  const stateShapeNote = blockChanged(prev.context, cur.context) && !broken.includes('state')
    ? '（本轮固定块的哈希与上次不同，但那是换轮重建/块没发造成的形状差异，不算前缀失守）'
    : '';
  // 跨轮那一句（BUG-2）：**跨轮不比段**是主判据，这一句只是让"被放过去的那几段"在日志里仍然有痕
  // ——放过去不等于没发生，与上面那张 note 同一条纪律。同轮时一个字都不写（形状与改动前一致）。
  const crossTurnNote = crossedTurn ? CROSS_TURN_NOTE : '';
  // 预期内换档那一句（2026-10-11）：只在**这一次 tools 段真的按段失守、且证据是换档**时出现
  // ——归因已经由 `tool-inventory` 给出（`silent = true`，不告警），这一句回答的是读账的人
  // 接下来要问的那个问题："那我该不该去查 MCP / 配置？"（答案：不用）。
  const trustShiftNote = broken.includes('tools') && evidence.trustShifted ? TRUST_SHIFT_NOTE : '';
  const hit = hitRate(cur);
  const reason = `缓存前缀失守（${classes.join(' + ')}）：${detail.join('；')}。`
    + `距上次调用 ${Math.round(gapMs / 60_000)} 分钟，本次 input ${cur.context.input.tokens} token`
    + `${hit === null ? '' : `，缓存命中 ${(hit * 100).toFixed(1)}%`}。`
    + `${CAUSE_TEXT[cause]}${silent ? '（预期内，不告警）' : '（**归因不明 ⇒ 仍然告警**）'}。`
    + `${trustShiftNote}${stateShapeNote}${crossTurnNote}`;
  // 新旧分段对照：只对"真的按段失守"的那几类做（render / idle 不是某一段的字节，不编）
  const diff = diffOf(prev.context, cur.context, broken);
  return {
    class: primary, classes, reason, gapMs, cause, causes, silent,
    ...(diff.length === 0 ? {} : { diff }),
    ...(cur.seq === undefined ? {} : { seq: cur.seq }),
  };
}

/**
 * 新旧分段对照的**唯一**构造点（口径写在 {@link CacheBreakDiff} / {@link CacheBreakSectionDiff}）。
 *
 * 只回答"字节/规模差在哪"，**不回答原因**——原因仍然只由 {@link segmentCause} 认（一处判据）。
 * `render` / `idle` 两类刻意不在这里出现：它们不是"某一段的文字变了"，编一条对照等于说谎。
 */
function diffOf(
  prev: ContextBreakdown,
  cur: ContextBreakdown,
  classes: readonly CacheBreakClass[],
): CacheBreakDiff[] {
  const out: CacheBreakDiff[] = [];
  for (const cls of classes) {
    if (cls === 'persona') out.push(segmentDiff('persona', prev.instructions, cur.instructions));
    else if (cls === 'tools') out.push(segmentDiff('tools', prev.tools, cur.tools));
    else if (cls === 'state') out.push(segmentDiff('state', prev.state, cur.state));
    else if (cls === 'memory') {
      const sections = sectionDiffsOf(prev.memory.sections, cur.memory.sections);
      out.push({
        ...segmentDiff('memory', prev.memory, cur.memory),
        ...(sections === undefined ? {} : { sections }),
      });
    } else if (cls === 'history') {
      const sections = sectionDiffsOf(prev.history.headItems, cur.history.headItems);
      out.push({
        // 历史段的"哈希"用 headHash（那才是哨兵判的那一格），规模用整段
        ...segmentDiff('history', { ...prev.history, hash: prev.history.headHash },
          { ...cur.history, hash: cur.history.headHash }),
        ...(sections === undefined ? {} : { sections }),
      });
    }
  }
  return out;
}

/**
 * 一段的新旧对照（缺一边时只出那一边的事实，差额一律不出现）。
 *
 * `changed` / `side` **必填**（{@link CacheBreakDiff} 继承的是 {@link CacheBreakSectionDiff} 的
 * 那一对字段）：缺了它们，"哪一段变了"这句话在 `diff[]` 里根本读不出来——而 `class` 回答的是
 * "哪一类失守了"，那是判据的结论、不是新旧对照的读数，拿它顶替必然读错。
 *
 * 三态 `side` 与"变了没变"的分工（与 {@link sectionDiffsOf} 逐字同规则，两处不许各写一套）：
 *   · `prev-only` —— 这一次请求里那一段整个不见了（`state` 只在每轮第 1 步发，这是常态）；
 *   · `next-only` —— 上一次没有、这一次有；
 *   · `both`      —— 两边都在，此时 `changed` 就是**两边哈希不等**。
 * 缺一边时 `changed` 恒为 `true`：形状变了就是变了，**不拿"没得比"冒充"没变"**。
 */
function segmentDiff(
  cls: CacheBreakClass,
  a: ContextSegment | undefined,
  b: ContextSegment | undefined,
): CacheBreakDiff {
  const side: CacheBreakSectionDiff['side'] =
    a === undefined ? 'next-only' : (b === undefined ? 'prev-only' : 'both');
  return {
    class: cls,
    side,
    changed: a?.hash !== b?.hash,
    ...(a === undefined ? {} : { prevHash: a.hash, prevTokens: a.tokens, ...(a.bytes === undefined ? {} : { prevBytes: a.bytes }) }),
    ...(b === undefined ? {} : { nextHash: b.hash, nextTokens: b.tokens, ...(b.bytes === undefined ? {} : { nextBytes: b.bytes }) }),
    ...(a === undefined || b === undefined ? {} : {
      deltaTokens: b.tokens - a.tokens,
      ...(a.bytes === undefined || b.bytes === undefined ? {} : { deltaBytes: b.bytes - a.bytes }),
    }),
  };
}

/**
 * 分节对照（记忆层三节 / 历史前段逐条）：**没变的节也列**，见 {@link CacheBreakDiff.sections}。
 *
 * 两边都没有分节（老日志、或这一版之前的调用）⇒ 返回 `undefined`——读的人由此知道
 * "这一版拿不到分节"，而不是把"没列"读成"没变"。
 * 顺序：先按上一次那边的顺序（`skills → mcp → summary` 是渲染顺序，读起来对得上），再补这次新增的。
 */
function sectionDiffsOf(
  prevFacts: readonly ContextSectionFact[] | undefined,
  nextFacts: readonly ContextSectionFact[] | undefined,
): CacheBreakSectionDiff[] | undefined {
  if (prevFacts === undefined && nextFacts === undefined) return undefined;
  const names: string[] = [];
  for (const fact of [...(prevFacts ?? []), ...(nextFacts ?? [])]) {
    if (!names.includes(fact.name)) names.push(fact.name);
  }
  return names.map((name) => {
    const a = prevFacts?.find((fact) => fact.name === name);
    const b = nextFacts?.find((fact) => fact.name === name);
    const side: CacheBreakSectionDiff['side'] = a === undefined ? 'next-only' : (b === undefined ? 'prev-only' : 'both');
    return {
      name,
      side,
      changed: a?.hash !== b?.hash,
      ...(a === undefined ? {} : { prevHash: a.hash, prevTokens: a.tokens, prevBytes: a.bytes }),
      ...(b === undefined ? {} : { nextHash: b.hash, nextTokens: b.tokens, nextBytes: b.bytes }),
      ...(a === undefined || b === undefined
        ? {}
        : { deltaTokens: b.tokens - a.tokens, deltaBytes: b.bytes - a.bytes }),
    };
  });
}

/**
 * 历史段有没有被**重写**（对比 `history.headHash` 与条数）。
 *
 * 三种情形不能混成一句"哈希不相等"：
 *   · **变短**（`items` 少了）→ 一定有东西被遮蔽或抹掉（压缩就是这一种）；
 *   · **两边都攒满了前 {@link HISTORY_HEAD_ITEMS} 条** → 两边窗口一样长，哈希直接可比，
 *     不一致就是前段被改写；
 *   · **条数一样但都没攒满** → 窗口是同一个（都是"整段"），同样可比。
 * 剩下的情形（尾巴变长，且至少一边还没攒满）**窗口长度本来就不同**，哈希当然不同——
 * 那是最常见的正常追加，绝不能在它身上报破坏（那会变成每步一条的刷屏）。
 */
function historyRewritten(prev: ContextBreakdown, cur: ContextBreakdown): boolean {
  const before = prev.history;
  const after = cur.history;
  if (after.items < before.items) return true;
  if (before.items >= HISTORY_HEAD_ITEMS && after.items >= HISTORY_HEAD_ITEMS) {
    return before.headHash !== after.headHash;
  }
  if (before.items === after.items) return before.headHash !== after.headHash;
  return false;
}

/**
 * 空闲过期判据：**久 + 命中率塌陷**，两个都要。
 *
 * 为什么不能只看"久"：她正常空闲时静默时长本来就会很长（心跳基线 30 分钟），
 * 把"久"当破坏等于把正常当异常——这正是 2026-10-03 那次告警刷屏的同一种错。
 * 命中率塌陷才是服务端真把前缀回收了的证据。
 */
function idleCollapse(
  prev: AuditedCall,
  cur: AuditedCall,
  gapMs: number,
  thresholds: CacheBreakThresholds,
): boolean {
  if (!(gapMs >= thresholds.idleMs)) return false;
  const before = hitRate(prev);
  const after = hitRate(cur);
  // 上次本来就没命中（输入很短时命中率天然为 0）：跌无可跌，不报
  if (before === null || after === null || before < IDLE_PREV_HIT_FLOOR) return false;
  return before - after >= before * thresholds.hitDrop;
}

/** 命中率；没有可用分母（这一笔没报 token）时给 null——不猜 */
function hitRate(call: AuditedCall): number | null {
  const total = call.cacheHitTokens + call.cacheMissTokens;
  if (!(total > 0)) return null;
  return call.cacheHitTokens / total;
}

function parseMs(ts: string): number {
  const at = Date.parse(ts);
  return Number.isFinite(at) ? at : 0;
}

// ──────────────────────────────── 界面措辞 ────────────────────────────────

/** 类别 → 徽章词（「框架提示」卡用；界面不自己维护第二份词表） */
export const CACHE_BREAK_LABEL = '缓存破坏';

/** 类别 → 短标签（一句话标题里用它，长解释在 `reason` 里） */
export const CACHE_BREAK_CLASS_LABEL: Record<CacheBreakClass, string> = {
  persona: '人格文件变更',
  tools: '工具清单变更',
  memory: '长期记忆层改写',
  history: '历史前段重写',
  state: '固定块改写',
  render: '渲染版本变更',
  idle: '空闲过期',
};

/** 原因 → 短标签（告警标题后缀 / 日志里一眼看出是哪一类） */
export const CACHE_BREAK_CAUSE_LABEL: Record<CacheBreakCause, string> = {
  restart: '接管/重启',
  asset: '她改了资产',
  'tool-inventory': '人格/工具清单变更',
  compaction: '上下文压缩',
  unattributable: '无法归因',
  render: '渲染版本变更',
  idle: '空闲过期',
  'turn-boundary': '换轮重建固定块',
};

/** 归因事实在「框架提示」卡里的徽章词 */
export const CONTEXT_LABEL = '上下文';

/**
 * 一行归因摘要（**分部与合计必须自洽**）。
 *
 * 2026-10-04 重写，两件事一起修：
 *   ① **旧版读起来是错的**：它这样印——`指令 0.4万 · 工具 0.4万×25 · 记忆 299 · 历史 959/9 条 ·
 *      此刻层 0.5万 · 合计 0.6万`。而 `input.tokens` 的口径是"只数 input 里的 item 段"
 *      （instructions 与 tools 是另外两个顶层字段，本来就不在里面，见 render.ts 的注释）。
 *      于是"合计"比前面几项的和还小，谁看都会觉得这张卡在瞎写——用户就是这么发现的。
 *   ② **单位太粗**：`万` 取一位小数 = 1000 token 的粒度，两千和三千都印成"0.2万"，
 *      想核对的人根本对不上账。
 *
 * 现在：**整条 = 指令 + 工具 + input 段**，每一项都给**精确整数**（千分位），
 * 等式两边按定义相等——想核对的人能自己加一遍，加出来一定对得上。
 * 措辞里仍然不许出现任何价格/货币字样（用户明确不要计价）。
 */
export function describeContext(context: ContextBreakdown): string {
  const segments = [
    `记忆 ${exact(context.memory.tokens)}`,
  ];
  // 固定块（B2）：旧记录里没有这一段（那时状态挤在此刻层里），没有就不印——
  // 印一个 0 会让人以为"当时这一段是空的"，而事实是"当时还没有这一段"。
  if (context.state !== undefined) segments.push(`固定块 ${exact(context.state.tokens)}`);
  segments.push(
    `历史 ${exact(context.history.tokens)}（${context.history.items} 条）`,
    `此刻层 ${exact(context.now.tokens)}`,
  );
  if (context.wake.tokens > 0) segments.push(`本轮输入 ${exact(context.wake.tokens)}`);
  if (context.hint.tokens > 0) segments.push(`尾部插播 ${exact(context.hint.tokens)}`);
  const whole = context.instructions.tokens + context.tools.tokens + context.input.tokens;
  return `整条 ${exact(whole)} = 指令 ${exact(context.instructions.tokens)}`
    + ` + 工具 ${exact(context.tools.tokens)}（${context.tools.count} 件）`
    + ` + input 段 ${exact(context.input.tokens)}（${segments.join(' · ')}）`;
}

/** 精确整数（千分位）：核对的人要能把这一行自己加一遍 */
function exact(tokens: number): string {
  return Math.max(0, Math.trunc(tokens)).toLocaleString('en-US');
}
