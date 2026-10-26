/**
 * Irmia Agent — **缓存未命中率告警**（滑动窗口）的判据、阈值与全部文案
 *
 * ───────────────────────────── 用户原话（这一批的根据） ─────────────────────────────
 *
 * 「我注意到**缓存未命中在暴涨**。并且**框架没有任何警告**」
 * 「花费涨到**约 5 倍**，但框架**一声不响**。」
 *
 * （原话里那两个金额在这里不复述：本仓库不引入价格/货币/计费口径，理由见下。额度、比例、倍数
 * 是这一批唯一的计量语言。）
 *
 * 本模块只放**纯东西**（判据 / 阈值 / 文案），一行 IO、一行事件写入都没有：
 *   · 运行期的三个出口在 `runtime/real-loop.ts` 的 `handleCostAlerts`（事件 + 控制台一行 + 一次真唤醒）；
 *   · 只读的读数出口在 `runtime/doctor.ts` 的 `OPS-cache-miss`（判据同一个函数、参数 `respectDedupe:false`）；
 *   · 一行摘要出口在 `cli.ts` 的 `summarizeEvent`（读事件自己的载荷，不重算）。
 *
 * ⚠ **本模块不出现任何货币 / 计费口径**（`model/context-audit.ts:11`、`docs/schema.md:391`、
 * `docs/design.md:603`、`docs/tools-audit.md:403` 四处成文的用户铁律："本仓库不引入价格/货币"）。
 * 载荷里那一格仍然叫 `estCostPerTurn`（契约名），但**单位是「未命中当量 token」**，
 * 并且把单位写成载荷里的一格（`estCostUnit`）——**不让读的人把它误读成钱**。
 * 折算口径取仓库自己已经写下的分价比例（`docs/design.md:603` 记的用户分价口径：
 * 未命中价约为命中价的 ×10），所以 `命中 token ÷ 10` 就是命中的"未命中当量"。
 *
 * ───────────────────────────── 为什么是"滑动窗口"而不是"单拍" ─────────────────────────────
 *
 * 单拍判据在这个问题上必然误报（用户要的是"暴涨"，不是"抖了一下"）：
 *   · `budget/consumed` **一次模型调用一条**，一次上下文压缩会让**每一个在飞轮**各付一次前缀失效
 *     （`docs/cache-miss-0208.md` §4 实测：一次压缩 ⇒ 三条 `cacheBreak` 告警）。单拍判据就是
 *     "一条重大变化报 N 次"，那正是仓库一直在杀的"告警常态化 ⇒ 人就不看了"；
 *   · 反过来，服务端的缓存单元是尽力而为的（`docs/design.md` §4.13 规则 3），单拍偶尔掉到
 *     30% 而下一拍回到 99% 是**常态**，按单拍报等于天天报。
 * ⇒ 看"最近 20 轮整体的未命中份额"。它要回答的是「**最近这段是不是一直在重编码前缀**」。
 *
 * ───────────────────────────── 五个阈值各自为什么是这个值 ─────────────────────────────
 *
 * ① 窗口 `CACHE_ALERT_WINDOW_TURNS = 20`
 *    20 轮 ≈ 一份日志里"最近一个工作段"的量级：够长到把单拍抖动平掉（一拍只占 1/20 权重），
 *    又够短到恶化在几十分钟内就浮出来（心跳 5~15 分钟一拍，20 轮 ≈ 2~5 小时）。
 *    取 5 轮会被单拍主导、取 100 轮会把"昨天已经坏掉的那一半"混进来。
 *
 * ② 触发线 `CACHE_ALERT_MISS_RATIO = 0.10`（2026-10-21 由 0.20 下调：当天最大 20 轮窗口只有 22.8%，0.20 会漏早期）
 *    用户给的正常值是 **~1–2%**（`docs/design.md` §4.13 的实测：每拍刻意共用同一份冻结前缀去
 *    保温供方的前缀缓存）。20% 是"正常值的 10~20 倍"：离抖动够远（实测偶发 30~60% 的单拍，
 *    20 轮加权之后到不了 20%），又能抓住"约 5 倍花费"那一档。**定在 10% 会把合入期的正常重建
 *    报成故障**；定在 50% 等于等到"每条请求都全 miss"才吭声，那时钱已经花掉了。
 *    ★ **为什么不是任务书原定的 0.25：实测当天全天峰值窗口只有 22.82%**（基线 1.73%，13.2 倍）
 *    —— 25% 会正好落在峰值之上、在把它叫出来的那一场里一次都不响。完整读数与它的能力边界
 *    （天生滞后约半小时）写在下面常量自己的注释里。
 *
 * ③ 相对基线 `CACHE_ALERT_BASELINE_FACTOR = 2`
 *    绝对线单独用会在两种情形下失灵：一是本机命中率本来就长期偏高（分母不同），二是缓慢爬升
 *    （从 1% 爬到 20% 很贵，但一次都没过 25%）。所以再加一条"比过去 24 小时的中位数高出 ≥2 倍"。
 *    **2 倍**是刻意的宽松值：中位数本身是稳健统计量（不受单拍尖峰影响），2 倍之外的变化
 *    已经不可能用"服务端抖动"解释。
 *
 * ④ 样本下限 `CACHE_ALERT_MIN_TURNS = 5`
 *    5 轮以下的中位数/比值都是噪声（3 轮里只要有 1 轮全 miss，比值就能到 33%）。
 *    它与 `warnedSinceLastCompaction` 那条"样本不够不判"是同一条纪律：**判不出来就不报**。
 *
 * ⑤ 去重档位 `CACHE_ALERT_BAND = 0.1`（10 个百分点一档）+ `CACHE_ALERT_DEDUPE_HOURS = 24`
 *    窗口比值每进一轮只动"一个 turn 的份额"，5 个百分点一档会让同一次恶化在档位边界上
 *    抖出两三条（27.3% → 30.4% 就跨档）；10 个百分点一档之后，**同一个 `renderVersion`
 *    的同一次恶化 24 小时内只报一条**，而真的又恶化一档（25~35% → 35~45%）照旧再报
 *    ——那是新的坏消息，不该被压掉。
 *
 * ───────────────────────────── 基线为什么**不含窗口自己** ─────────────────────────────
 *
 * 基线 = "过去 24 小时里、**窗口之前的那些轮**"的每轮未命中率的中位数。
 * 把窗口自己算进基线是循环论证：一次**持续**的恶化会把中位数一起拖上去，
 * 比值随之趋近 1，于是**最该叫的那一次恰好不叫**（这正是用户报的那个"框架一声不响"）。
 * 中位数（不是均值）是为了不被窗口前一两条极端值带跑。
 *
 * 基线取不到（窗口之前 24 小时内一轮都没有）⇒ `why: 'no-baseline'`，**不报**：
 * "相对基线恶化"这一条缺一不可，拿 0 当基线会把"第一次出现未命中"报成"恶化"。
 * 唯一的例外写在 `ratioOutweighsBaseline`：**基线是 0% 而窗口 > 0** —— 那是无中生有，
 * 按"高出 ≥2 倍"读就是成立（0 的两倍还是 0，但这里的语义显然是"本来没有，现在有"）。
 *
 * ─────────────────────── 2026-10-26 · 用户两条指示（这一批的根据） ───────────────────────
 *
 * ①「**缓存命中只看窗口内模型。切换模型就重新放。**」
 * ②「**如果是不返回缓存命中的模型就我们自己算。**」
 *
 * ────────── ① 为什么窗口必须按模型切（不是洁癖，是实测报错了） ──────────
 *
 * heavy 档曾用 `gpt-6.1-sol`（events seq 250635–250947 / turns 3783–3786，2026-10-25 16:37 起），
 * 30 拍合计 `cacheHitTokens 47,232` / `cacheMissTokens 820,151` ⇒ 未命中 **94.6%**；切回
 * `deepseek-flash` 之后 22 拍是 **11.1%**（逐步 6.3 / 8.1 / 6.5%）。旧口径把两者算进**同一个**
 * 20 轮窗口（桶的 key 只有 turn 号，桶里没有模型），于是报出 **79.8%**——读起来像"我们的前缀
 * 设计坏了"，而现场的两段账各自都说得清（一个端点基本不报命中、一个正常）。
 * ⇒ 桶的 key 从 `turn` 改成 **`lane|model`**（同一轮里换模型会出现两个桶，这正确），
 * 窗口 = **同一 model 的最近 {@link CACHE_ALERT_WINDOW_TURNS} 轮**，基线也按同一 lane+model 取。
 * 换模型的第一拍窗口只有 1 个样本 ⇒ 走既有的 `too-few-turns`（**不报**，等它攒够 5 拍）。
 * 窗口里若出现 ≥2 个模型（历史残留：升级前写下的日志、同一轮里切换过），**只用最新那个模型的
 * 桶**；`modelsInWindow` 只作诊断落进载荷，**不参与判据**。
 *
 * ────────── ② "不返回缓存数据"怎么判、我们自己怎么算 ──────────
 *
 * 判据在 {@link cacheCaliberOf}，两种形状都算"不返回"：
 *   ⓐ **供方一次都没报命中**：窗口 Σhit = 0 而确实有输入；
 *   ⓑ **供方报的是一个与上下文规模无关的常数**：窗口里每个非零 hit 都等于同一个 c，
 *      且 c 只占窗口最大一拍输入的四分之一以下。
 *      ⚠ 这一条是**从实测反推**的、必须写清：`gpt-6.1-sol` 那 30 拍里 hit 只有 `0` 与固定的
 *      `5,248` 两种值（9 拍 5248 / 21 拍 0），而输入已从 16,074 涨到 32,225——命中量与上下文
 *      规模**无关**。只写 ⓐ（`Σhit === 0`）的话，那 9 拍 5248 会让这条判据在**它要修的那场
 *      事故里一次都不响**，与"绝对线正好落在峰值之上"是同一类错误。
 *
 * 自算的口径写在 `model/context-audit.ts` 的 `estimatePrefixHitOf`（逐段逐条比前缀，
 * **只算完全相同的段**）；这里只负责窗口级的两件事：把每一拍的自算值加总，以及把基线也换成
 * 同一档口径（否则"自算的 33%"会被拿去跟"供方的 94.6%"比，那条判据永远不响）。
 * **供方给的数一个字节都不改**（`budget/consumed` 那四格照旧），只在 `budget/consumed` 上留
 * 两格 `cacheReported`（这一拍 hit>0）/ `cacheEstimated`（这一拍命中量可自算）作痕迹。
 *
 * ⚠ **"拍"与"轮"不是同一个数**：口径的启动条件是「持续 ≥ {@link CACHE_ALERT_MIN_TURNS} **拍**」
 * （一次调用一拍：现场 gpt 那 30 拍只摊在 4 轮里），判据的样本下限仍是「≥ 5 **轮**」。
 * 于是 gpt 那一段的读数是**自算的 53.5%**、但在它那段里**不报**（4 轮 < 5，判不出来就不报）。
 * 实测：turns 3783–3786 的 30 拍，供方 94.55% ↔ 自算 **53.5%**（估算命中 403,137 / 867,383 输入）。
 *
 * ────────── 文案（用户给的三个形状，逐字落在这里） ──────────
 *
 *   常规   `【框架通报 · 缓存成本】最近 20 轮（heavy · deepseek-flash）未命中 11.1%，24 小时基线 2.0%——…`
 *   零命中 `【框架通报 · 缓存成本】gpt-6.1-sol 最近 20 轮一次缓存都没命中（命中 0 / 输入 860k）——该端点很可能不支持前缀缓存，换模型即可恢复`
 *   自算   `…（该模型不返回缓存数据，本行按上下文前缀自算）`
 * 三个形状都**不写钱**（本仓库的铁律，见文件头第一段），且都**必须带模型名**。
 */

import type { AppEvent, CacheAlertPayload, CacheAlertContributor, ModelLane } from '../log/types.js';
import type { ContextBreakdown } from '../model/context-audit.js';
import { estimatePrefixHitOf } from '../model/context-audit.ts';
import { formatCompact, formatPercent } from '../format/units.ts';

// ──────────────────────────────── 阈值（唯一一处定义） ────────────────────────────────

/**
 * ① 窗口长度：**同一 lane + 同一 model** 最近多少**轮**（2026-10-26 起按模型切，见文件头 ①）。
 *
 * 一个模型一个窗口——"最近 20 轮不分模型"那个口径会把两个端点的账混成一个数（实测：
 * `gpt-6.1-sol` 94.6% + `deepseek-flash` 11.1% ⇒ 旧口径报 79.8%，读起来像我们的前缀坏了）。
 */
export const CACHE_ALERT_WINDOW_TURNS = 20;
/**
 * ② 绝对触发线：窗口未命中率必须**严格大于**它。
 *
 * ⚠ **这里取 0.20 而不是任务书原定的 0.25，是实测改的**（2026-10-21，本机只读复算）：
 * 把当天 `data/events` 的每一个"最近 20 档 heavy"窗口都算一遍，**全天峰值是 22.82%**
 * （本地 03:34 那个窗口；同一场的基线是 1.73%，即 **13.2 倍**）。也就是说 25% 那条线
 * **正好落在峰值之上 ⇒ 这一条在把它叫出来的那场事故里一次都不会响**——那与它要修的病
 * 是同一个病。20% 与实测峰值之间留 2.8 个点，同时仍远高于正常值（~1–2%）与单拍抖动。
 *
 * ⚠ 但也要如实说清它的**能力边界**：20% 第一次被越过是本地 **03:24** 前后，而驱逐在
 * **02:54:56** 就开始了 ⇒ 这一条**天生滞后约半小时**（钱是那半小时里烧掉的）。
 * 真正早的那条是 `runtime/reasoning-echo-pressure.ts` 的**前兆**：同一场它在 **02:30 之前**
 * 就已经 ≥90% 并且会一直响到事中。所以这两条的分工是"前兆主防、结果兜底"，
 * **不是**两条同权判据。
 */
export const CACHE_ALERT_MISS_RATIO = 0.1;
/** ③ 相对基线：窗口未命中率必须 ≥ 基线中位数 × 这个倍数 */
export const CACHE_ALERT_BASELINE_FACTOR = 2;
/** ④ 样本下限：窗口里至少这么多轮才判 */
export const CACHE_ALERT_MIN_TURNS = 5;
/** 基线回看多久（小时） */
export const CACHE_ALERT_BASELINE_HOURS = 24;
/** ⑤ 去重：同一 (lane, renderVersion, 档位) 在这么久之内只报一次 */
export const CACHE_ALERT_DEDUPE_HOURS = 24;
/** ⑤ 档位宽度（10 个百分点一档；理由见文件头 ⑤） */
export const CACHE_ALERT_BAND = 0.1;
/**
 * 命中 token 折成"未命中当量"的比例：**1/10**。
 *
 * 来源是**仓库已经写下的**分价口径（`docs/design.md:603` / `docs/tools-audit.md:403`：
 * 未命中价约为命中价的 ×10），不是本模块自己编的数。产物仍然只是 token——
 * 一个字节的货币单位都不出现（见文件头那条铁律）。
 */
export const CACHE_ALERT_HIT_PRICE_RATIO = 0.1;

/** 判据要的全部输入（`lane` 一次只算一条：两条 lane 的"正常值"不是一个数） */
export interface CacheAlertSignals {
  /** 事件日志（只读；本模块自己不做 IO） */
  events: readonly AppEvent[];
  /** 算哪条 lane */
  lane: ModelLane;
  /**
   * 判据的"现在"（毫秒）。**由调用方给，模块自己不读时钟**（同 `fold` 的纪律）：
   *   · 运行期给 `deps.now()`（= 这一轮收尾的时刻）；
   *   · `doctor` 给**日志末尾时刻**——它读的可能是几周前的日志，用墙钟会让 24 小时基线永远是空的。
   */
  nowMs: number;
  /**
   * 去重要不要生效。
   *   · 运行期 `true`（用户要的是"不刷屏"）；
   *   · `doctor` `false`——它回答的是"**现在健不健康**"，不是"要不要再叫一次"。
   *     拿去重把 doctor 压成 ok，等于把一条正在恶化的现状藏起来。
   */
  respectDedupe: boolean;
}

/** 判据没响的原因（**每个出口都要能区分**：不发不等于同一个理由，事后读日志的人要分得清） */
export type CacheAlertSkip =
  /** 这条 lane 一条 `budget/consumed` 都没有（新装的机器、只有 light 的机器） */
  | 'no-calls'
  /** 窗口不足 {@link CACHE_ALERT_MIN_TURNS} 轮 */
  | 'too-few-turns'
  /** 窗口里所有调用的 token 都是 0（`finishReason:'failed'` 那几拍）⇒ 分母为 0，算不出比值 */
  | 'no-token-sample'
  /** 比值没到绝对线 {@link CACHE_ALERT_MISS_RATIO} */
  | 'below-ratio'
  /** 窗口之前 24 小时内没有可比基线 */
  | 'no-baseline'
  /** 过了绝对线，但相对基线没到 {@link CACHE_ALERT_BASELINE_FACTOR} 倍 */
  | 'below-baseline'
  /** 三条全成立，但同 (lane, renderVersion, 档位) 24 小时内已经报过 */
  | 'duplicate';

/** 一次判据的读数（`fired` 与否都有：doctor 要读"现在的数"，不只是"叫没叫"） */
export interface CacheAlertReading extends CacheAlertPayload {
  /** 窗口里参与统计的调用条数（诊断用；不进事件载荷——它是可复算的，不是承诺类事实） */
  windowCalls: number;
  /** 窗口里带思维链的拍数（`topContributor === 'reasoning-echo'` 的判据用，诊断可核） */
  windowReasoningCalls: number;
  /** 窗口里 `retryCount` 之和（同上） */
  windowRetries: number;
}

/** 一次判据的结论 */
export interface CacheAlertVerdict {
  fired: boolean;
  why: CacheAlertSkip | 'fired';
  /** 读数；只有 `no-calls` 时是 null（那时连"最近多少轮"都无从谈起） */
  reading: CacheAlertReading | null;
}

// ──────────────────────────────── 判据 ────────────────────────────────

/**
 * 一轮（或一次没有轮号的内部调用）的样本。
 *
 * 排序键是 **`lastSeq`** 而不是 `turn`：日志里 `budget/consumed.turn` 有两种来源——
 * `TurnRunner.accountStep` 写的是真轮号，而 `judgeChannelWakes(wakeEvents, 0)` 这类内部调用
 * **写的是 0**（那一刻 turn 号还没分配，见 `real-loop.ts` 的调用点注释）。0 不是一个轮，
 * 把一整天几十次判定塞进同一个 `turn 0` 会让 `windowTurns` 永远等于 1、这条判据永远不响。
 * ⇒ `turn <= 0` 的调用**各自成一档**；排序统一用 `seq`（日志里恒单调，与时间同序）。
 *
 * **桶的 key 是 `lane|model`**（2026-10-26 起，见文件头 ①）：同一个 lane 换了模型就是另一本账，
 * 新旧模型不许混在同一个 20 轮窗口里。同一轮里换模型会出现两个桶——那是对的。
 */
interface LaneBucket {
  /** 桶的 key（`turn:<n>` 或 `call:<seq>`；自算那一档要按同一个 key 把估算值对回来） */
  key: string;
  /** 这一档用的模型（`budget/consumed.model`；老日志缺这一格 ⇒ `'unknown'`，不猜） */
  model: string;
  hit: number;
  miss: number;
  /** Σ`inputTokens`（`miss` 是"未命中"，`input` 是"这一拍总共发了多少"——两者不是一个数） */
  input: number;
  output: number;
  retries: number;
  calls: number;
  reasoningCalls: number;
  /**
   * 这一档里**每一笔**的命中量与输入量（原样，不聚合）。
   *
   * 只服务 `cacheCaliberOf` 的两条判据：ⓐ Σhit===0、ⓑ "非零 hit 恒为同一个常数且与输入规模
   * 无关"。条目数与 `calls` 相同（一笔一拍一条），量级是"一次调用"，不会把 20 万条事件撑成
   * 两个大数组。
   */
  hits: number[];
  inputs: number[];
  /** 这一档里出现过的 `context.renderVersion`（按出现顺序去重，最后一次写入的是"最新"） */
  renderVersions: string[];
  /** 这一档里出现过的 `context.history.headHash`（历史前段被改写的直接证据） */
  historyHeads: string[];
  /** 最后一拍的 seq（排序键；也是"这一档属于哪一刻"的唯一口径） */
  lastSeq: number;
  /** 最后一拍的 `ts`（毫秒）；解析不出来是 null（那就不参与 24 小时基线） */
  tsMs: number | null;
}

function emptyBucket(key: string, seq: number, model: string): LaneBucket {
  return {
    key, model, hit: 0, miss: 0, input: 0, output: 0, retries: 0, calls: 0, reasoningCalls: 0,
    hits: [], inputs: [], renderVersions: [], historyHeads: [], lastSeq: seq, tsMs: null,
  };
}

/** 桶的 key：真轮号按轮分、无轮号的内部调用各自成一档（理由见 {@link LaneBucket}） */
function bucketKeyOf(data: { turn: number }, seq: number): string {
  return data.turn > 0 ? `turn:${data.turn}` : `call:${seq}`;
}

/** 事件 `ts` → 毫秒；解析不出来给 null（**不拿"现在"顶替**——那会把老事件当成刚发生的） */
function tsMsOf(ts: unknown): number | null {
  if (typeof ts !== 'string') return null;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : null;
}

function addDistinct(list: string[], value: string | undefined): void {
  if (value === undefined || value === '') return;
  if (!list.includes(value)) list.push(value);
}

/**
 * 把事件流折成"**两条 lane 各自**的每一档样本"（各按 `lastSeq` 升序）。**一趟遍历出两条 lane**
 * ——不是洁癖：`web/server.ts` 的总览页**每十秒**被拉一次（`buildDashboard` 的注释），
 * 一 lane 一趟 = 每十秒多扫两遍 20 万条事件。一趟出两条，那些消费者一次付清。
 *
 * 三条口径写在这里（读日志的人不必回头猜）：
 *   · **不算子代理链**（`parentCallId !== undefined`）：子代理是隔离视图，它的 `turn` 号由
 *     `turnBase` 的下限自己排，**可能与主日志的轮号撞车**；把两支的消耗并进同一个轮桶，
 *     得到的窗口两支都不像。子代理的钱照旧折进父层预算（`state/fold.ts` 的
 *     `applySubagentEvent`），那是账本的事；本判据看的是"主循环这条 lane 的缓存故事"。
 *   · **`turn > 0` 才当轮**，其余各自成一档（理由见 {@link LaneBucket}）。
 *   · **失败拍的 0 token 照收**：它们让分母不动、分子不动，等于"这一档没有样本"，
 *     由 {@link CACHE_ALERT_MIN_TURNS} 与分母守卫各自兜住。
 *   · **桶按 `lane|model` 分**（2026-10-26，文件头 ①）：同一轮里换了模型就是两个桶。
 */
function collectLanes(events: readonly AppEvent[]): Record<ModelLane, LaneBucket[]> {
  const maps: Record<ModelLane, Map<string, LaneBucket>> = {
    heavy: new Map<string, LaneBucket>(),
    light: new Map<string, LaneBucket>(),
  };
  for (const event of events) {
    if (event.type !== 'budget/consumed') continue;
    if (event.parentCallId !== undefined) continue;
    const d = event.data;
    const byKey = maps[d.lane];
    if (byKey === undefined) continue;
    // 模型是**桶的一部分**（文件头 ①）：换模型即换一本账，新旧模型不许混进同一个窗口。
    // 老日志缺 `model` 的按 `'unknown'` 归（不猜成某一档；它们自成一桶，混不进任何真模型）。
    const model = typeof d.model === 'string' && d.model !== '' ? d.model : 'unknown';
    const key = `${bucketKeyOf(d, event.seq)}|${model}`;
    const bucket = byKey.get(key) ?? emptyBucket(key, event.seq, model);
    const input = Number.isFinite(d.inputTokens) ? Math.max(0, d.inputTokens) : 0;
    const hit = Number.isFinite(d.cacheHitTokens) ? Math.max(0, Math.min(d.cacheHitTokens, input)) : 0;
    const miss = Number.isFinite(d.cacheMissTokens) ? Math.max(0, d.cacheMissTokens) : 0;
    const output = Number.isFinite(d.outputTokens) ? Math.max(0, d.outputTokens) : 0;
    bucket.hit += hit;
    bucket.miss += miss;
    bucket.input += input;
    bucket.output += output;
    bucket.retries += Number.isFinite(d.retryCount) ? Math.max(0, d.retryCount) : 0;
    bucket.calls += 1;
    bucket.hits.push(hit);
    bucket.inputs.push(input);
    bucket.reasoningCalls += (Number.isFinite(d.reasoningTokens) ? (d.reasoningTokens ?? 0) : 0) > 0 ? 1 : 0;
    addDistinct(bucket.renderVersions, d.context?.renderVersion);
    addDistinct(bucket.historyHeads, d.context?.history?.headHash);
    if (event.seq >= bucket.lastSeq) {
      bucket.lastSeq = event.seq;
      bucket.tsMs = tsMsOf(event.ts);
    }
    byKey.set(key, bucket);
  }
  const sorted = (map: Map<string, LaneBucket>): LaneBucket[] =>
    [...map.values()].sort((a, b) => a.lastSeq - b.lastSeq);
  return { heavy: sorted(maps.heavy), light: sorted(maps.light) };
}

/** 一对 (命中, 未命中) 的未命中率；分母为 0 ⇒ null（算不出来，不拿 0 冒充） */
function missRatioPairOf(hit: number, miss: number): number | null {
  const total = hit + miss;
  return total > 0 ? miss / total : null;
}

// ────────────────────── 「不返回缓存数据」的判据 + 自算窗口（2026-10-26） ──────────────────────

/**
 * 窗口级口径：`'reported'` = 用供方的数；`'zero-hit'` / `'fixed-hit'` = 我们自己算（两种形状，
 * 文案分档用得上——零命中那一档要单独说"一次都没命中"）。
 */
export type CacheCaliber = 'reported' | 'zero-hit' | 'fixed-hit';

/**
 * **这个模型的窗口"不返回缓存数据"吗**（判据唯一一处，理由与实测写在文件头 ②）。
 *
 * ⓐ `zero-hit`：窗口 Σhit = 0 且确实有输入。
 *    ⚠ 它同时盖住用户说的"`hit+miss === 0` / 字段缺失"两种形状——写入侧
 *    `cacheMissTokens = inputTokens − cacheHitTokens` 是**我们自己减的**，所以"字段缺失"
 *    在事件上就是 `hit=0, miss=input`；而真的 `0/0`（失败拍）由"有输入"这一条挡掉。
 * ⓑ `fixed-hit`：每一个非零 hit 都等于同一个常数 c、至少出现两次、且 c 只占窗口最大一拍输入的
 *    四分之一以下。这是"命中量与上下文规模无关"的可判形状（现场：5248 × 9 拍 / 输入 16k–32k）。
 *
 * 两条都必须先有"真的在发东西"（Σinput > 0）：否则一个窗口全是失败拍也会被读成"不返回"。
 */
export function cacheCaliberOf(window: readonly LaneBucket[]): CacheCaliber {
  const inputTotal = window.reduce((sum, bucket) => sum + bucket.input, 0);
  if (!(inputTotal > 0)) return 'reported';
  const hitTotal = window.reduce((sum, bucket) => sum + bucket.hit, 0);
  if (hitTotal === 0) return 'zero-hit';
  const nonzero = window.flatMap(bucket => bucket.hits).filter(hit => hit > 0);
  if (nonzero.length < 2) return 'reported';
  const fixed = nonzero[0];
  if (fixed === undefined) return 'reported';
  if (!nonzero.every(hit => hit === fixed)) return 'reported';
  const maxInput = Math.max(...window.flatMap(bucket => bucket.inputs));
  // 常数命中量连最大一拍输入的四分之一都不到 ⇒ 它不是"这段前缀命中了"，是端点报的一个死数
  if (!(fixed * 4 <= maxInput)) return 'reported';
  return 'fixed-hit';
}

/** 一拍的**自算**样本（`hit` 由 `estimatePrefixHitOf` 给，`miss` 是补出来的那一截） */
interface EstimatedSample {
  hit: number;
  miss: number;
}

/**
 * **按前缀自算**这个模型的每一档命中量（窗口 + 基线都要用同一档口径，见文件头 ②）。
 *
 * 一趟只读遍历，内存里只留"同模型上一拍的 `context`"一份 ⇒ 不随日志长度涨。
 * 三条口径：
 *   · **上一拍必须是同一模型的上一拍**（换模型就重新找基准，与窗口同一个判据）；
 *   · **没有 `context` 的拍**：老日志 —— 这一拍一个 token 都不算（`hit=0`），
 *     但仍然推进"上一拍"指针？**不推进**：那一拍的前缀根本看不见，拿它当基准等于拿空气比；
 *   · `hit` 夹在 `[0, inputTokens]` 之间（估算不可能比这一拍实际发出去的多）。
 *
 * 只在 `cacheCaliberOf !== 'reported'` 时才被调用（每十秒一次的仪表盘上，正常路径零成本；
 * 自算那一档多一趟 O(n) 纯比较，已由 `web/server.ts` 的 `cacheAlertsForDashboard` 按
 * `upToSeq` + 分钟桶缓存）。
 */
export function estimateByBucketOf(input: {
  events: readonly AppEvent[];
  lane: ModelLane;
  model: string;
}): Map<string, EstimatedSample> {
  const out = new Map<string, EstimatedSample>();
  let previous: ContextBreakdown | null = null;
  for (const event of input.events) {
    if (event.type !== 'budget/consumed') continue;
    if (event.parentCallId !== undefined) continue;
    const d = event.data;
    if (d.lane !== input.lane) continue;
    const model = typeof d.model === 'string' && d.model !== '' ? d.model : 'unknown';
    if (model !== input.model) continue;
    const context = d.context;
    if (context === undefined) continue;
    const at = Number.isFinite(d.inputTokens) ? Math.max(0, d.inputTokens) : 0;
    const estimated = previous === null ? 0 : Math.min(at, Math.max(0, estimatePrefixHitOf(previous, context)));
    previous = context;
    const key = `${bucketKeyOf(d, event.seq)}|${model}`;
    const sample = out.get(key) ?? { hit: 0, miss: 0 };
    sample.hit += estimated;
    sample.miss += Math.max(0, at - estimated);
    out.set(key, sample);
  }
  return out;
}

/** 一档在某一口径下的 (hit, miss)：供方原值，或自算值（自算缺这一档 ⇒ 全按未命中，保守） */
function hitMissOf(bucket: LaneBucket, estimates: Map<string, EstimatedSample> | null): EstimatedSample {
  if (estimates === null) return { hit: bucket.hit, miss: bucket.miss };
  const sample = estimates.get(bucket.key);
  if (sample === undefined) return { hit: 0, miss: bucket.input };
  return sample;
}

/** 中位数（偶数个取中间两个的均值；空集 ⇒ null）。纯函数，不改入参 */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const high = sorted[mid];
  if (high === undefined) return null;
  if (sorted.length % 2 === 1) return high;
  const low = sorted[mid - 1];
  return low === undefined ? high : (low + high) / 2;
}

/**
 * ③ 的算式本体：窗口比值是不是**相对基线恶化了 ≥2 倍**。
 *
 * 两处刻意的边界：
 *   · **基线 0 而窗口 > 0 ⇒ 成立**（"本来一次都没漏、现在开始漏了"就是无中生有；0 的两倍还是 0，
 *     用乘法读会把这一档整个漏掉）；
 *   · 窗口 0 ⇒ 不成立（分母侧已经由绝对线挡掉，这里只是把语义写全）。
 */
export function ratioOutweighsBaseline(windowRatio: number, baselineRatio: number): boolean {
  if (!(windowRatio > 0)) return false;
  if (baselineRatio <= 0) return true;
  return windowRatio >= baselineRatio * CACHE_ALERT_BASELINE_FACTOR;
}

/** 未命中率 → 去重档位（10 个百分点一档；理由见文件头 ⑤） */
export function missRatioBandOf(missRatio: number): number {
  return Math.floor(missRatio / CACHE_ALERT_BAND);
}

/** 保留 4 位小数（载荷里的比值：够细，又不带一串浮点尾巴） */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * `topContributor`：**用现有数据猜"谁最可疑"，四条候选之外一律 `'unknown'`**。
 *
 * ⚠ 用户点名的纪律是「**不许编**」。所以这里**不是**"挑一个最像的说出来"，
 * 而是四条**可证的**判据依次问一遍，一条都不成立就**如实说不知道**（`'unknown'`）——
 * 一个编出来的归因比"原因不明"坏得多：它会让人去查一个不存在的地方
 * （`docs/cache-miss-0208.md` §4 那次"被标成无法归因其实是误报"是同一个教训的反面）。
 *
 * 四条候选与它们的判据（顺序有理由，见下面每一条）：
 *
 * ⓪ `'reasoning-echo-eviction'` —— 窗口覆盖的 seq 区间里出现过
 *    `model/reasoning-echo{kind:'reasoning_echo_prune'}` 且某一条 `dropped[].why === 'maxTotalChars'`。
 *    **为什么排在最前**：这是 2026-10-21 只读审计（20.6 万条事件、零反例）追出来的**根因链条**
 *    的名字——回传字符顶穿 `maxTotalChars` ⇒ 每一笔挤掉最老的一个 assistant 组 ⇒ 历史头部每笔
 *    位移 ⇒ 每笔都重编码前缀。其余四条都是它的**表现形式**（`history-tail` 是结果，
 *    `render-version` 在那一场里干脆是无辜的：`instructions` / `tools` / `memory` 三段哈希
 *    一个字节都没变）。用户点名要它别再落进 `'unattributable'`，所以它必须**先于**一切被问到。
 *
 * ① `'render-version'` —— 窗口里出现过 **≥2 个 `context.renderVersion`**，
 *    或窗口最新的一版与基线最新的一版不同。
 *    **为什么排第一**：渲染口径换代 ⇒ 请求体整体不同 ⇒ 必然一次全 miss
 *    （`log/types.ts` 的 `message/reasoning` 那一格、`render.ts` 的版本纪律）。
 *    这是唯一一条"一成立就足以解释一切"的判据，所以先问它。
 *
 * ② `'history-tail'` —— 窗口里出现过 **≥2 个 `context.history.headHash`**。
 *    **用的为什么是 `headHash` 而不是 `history.hash`**：整段 history 每步都在追加尾巴，
 *    整段哈希**必然**每次都变 ⇒ 拿它当证据等于"永远成立"，那不是判据。
 *    `headHash` 只盖前 {@link HISTORY_HEAD_ITEMS} 条（`model/context-audit.ts` 的定义），
 *    它变了才是"历史前段被改写"（压缩换掉遮蔽点、`input/requeued` 给老 item 补标记）。
 *    用户说的"input 尾部变化"在现有数据里能指认的，就是这一格。
 *
 * ③ `'reasoning-echo'` —— 窗口里"带思维链的拍"占比 ≥ **50%**，且比基线**高 ≥30 个百分点**。
 *    **为什么是这两个数**：思维链回传本身不改字节（它是既有条目的一部分），只有在
 *    "回传集合**变了**"的时候才会让历史字节变——而"变了"在现有数据里唯一的代理就是
 *    "带思维链的拍变多了"。50% 是"过半"，30 个百分点是"翻了量级"的量级差；
 *    两个都满足才叫"变了"，只满足其一可能只是这一轮恰好都在想事。
 *
 * ④ `'retry'` —— 窗口里 `retryCount` 之和 ≥ 窗口的**拍数**（平均每拍至少重试一次）。
 *    **为什么是"每拍一次"**：`retryCount` 是"服务端在抖"最早的信号，而单次重试是常态；
 *    平均每拍都重试一次，才够得上"这一段的未命中是重试撑起来的"。
 *
 * 四条都不成立 ⇒ `'unknown'`（**不猜**）。
 */
/**
 * 窗口的 seq 区间里，有没有**撞总字符上限的整组丢**（`reasoning-echo-eviction` 的唯一判据）。
 *
 * 三条口径别改：
 *   · 只认 `why === 'maxTotalChars'`：`'half-state'` 是"有思维链事件但原文为空"的修补——它不改
 *     "历史每笔都在位移"这件事，不算这个根因。（2026-10-21 起 `why` 里**没有 `'maxItems'`** 了：
 *     那个"最多 N 条"的旋钮连同判据一起删了；历史日志里若还留着这个值，同样**不认**——它不是
 *     这条根因。）
 *   · 只认**落在窗口里**的：窗口之前发生过而现在已经不驱逐，那是已经过去了的事；
 *   · 边界取 `(窗口前一条的 lastSeq, 窗口末条的 lastSeq]`——与 `budget/consumed` 的口径同源
 *     （窗口是"最近 20 档"，而这一条就是那 20 档之间的账）。
 */
function evictedInWindow(
  events: readonly AppEvent[],
  fromSeqExclusive: number,
  toSeqInclusive: number,
): boolean {
  for (const event of events) {
    if (event.type !== 'model/reasoning-echo') continue;
    if (event.data.kind !== 'reasoning_echo_prune') continue;
    if (event.seq <= fromSeqExclusive || event.seq > toSeqInclusive) continue;
    if ((event.data.dropped ?? []).some(entry => entry.why === 'maxTotalChars')) return true;
  }
  return false;
}

export function topContributorOf(
  window: readonly LaneBucket[],
  baseline: readonly LaneBucket[],
  /** 窗口的 seq 区间里有没有"撞总字符上限的整组丢"（判据在 {@link evictedInWindow}） */
  evicted: boolean,
): CacheAlertContributor {
  // ⓪ 思维链驱逐（根因；判据与理由见方法头）
  if (evicted) return 'reasoning-echo-eviction';

  // ① 渲染口径换代
  const windowVersions = [...new Set(window.flatMap(bucket => bucket.renderVersions))];
  if (windowVersions.length >= 2) return 'render-version';
  const windowLatestVersion = windowVersions[windowVersions.length - 1];
  const baselineVersions = [...new Set(baseline.flatMap(bucket => bucket.renderVersions))];
  const baselineLatestVersion = baselineVersions[baselineVersions.length - 1];
  if (windowLatestVersion !== undefined && baselineLatestVersion !== undefined
    && windowLatestVersion !== baselineLatestVersion) return 'render-version';

  // ② 历史前段被改写
  const heads = new Set(window.flatMap(bucket => bucket.historyHeads));
  if (heads.size >= 2) return 'history-tail';

  // ③ 思维链回传集合变了
  const windowCalls = window.reduce((sum, bucket) => sum + bucket.calls, 0);
  const baselineCalls = baseline.reduce((sum, bucket) => sum + bucket.calls, 0);
  if (windowCalls > 0 && baselineCalls > 0) {
    const windowShare = window.reduce((sum, bucket) => sum + bucket.reasoningCalls, 0) / windowCalls;
    const baselineShare = baseline.reduce((sum, bucket) => sum + bucket.reasoningCalls, 0) / baselineCalls;
    if (windowShare >= 0.5 && windowShare - baselineShare >= 0.3) return 'reasoning-echo';
  }

  // ④ 重试
  const retries = window.reduce((sum, bucket) => sum + bucket.retries, 0);
  if (windowCalls > 0 && retries >= windowCalls) return 'retry';

  return 'unknown';
}

/**
 * **判据本体**（唯一一处）。三条触发条件缺一不可，外加一条去重。
 *
 * 出口顺序是刻意的（与 `model/compaction-warning.ts` 的 `planCompactionWarning` 同一条纪律：
 * 每个出口对应"为什么没报"的一个取值，三者都是"不发"但事后读日志的人要分得清）：
 *   ① 没有调用 ⇒ `no-calls`
 *   ② 样本不够 ⇒ `too-few-turns`
 *   ③ 分母为 0 ⇒ `no-token-sample`
 *   ④ 没过绝对线 ⇒ `below-ratio`
 *   ⑤ 没有基线 ⇒ `no-baseline`
 *   ⑥ 相对基线没恶化 ⇒ `below-baseline`
 *   ⑦ 报过了 ⇒ `duplicate`
 *   ⑧ 其余 ⇒ `fired`
 *
 * ⚠ ②③ 必须排在 ④ 前面：窗口只有 3 轮、或 20 轮全是失败拍（0 token）时，
 * 比值要么是噪声要么算不出来，先判"线下"会把它们记成 "below-ratio" ——
 * 那会让"样本不够"这个真实原因读起来像"数值健康"。
 */
export function planCacheAlert(signals: CacheAlertSignals): CacheAlertVerdict {
  const { events, lane, nowMs, respectDedupe } = signals;
  return verdictOf(lane, collectLanes(events)[lane], events, nowMs, respectDedupe);
}

/**
 * **两条 lane 一次算完**（判据同一个 `verdictOf`、事件只扫一趟）。
 *
 * 三个生产消费者都走这一条：`real-loop.handleCacheAlert`、`doctor`、
 * `web/server.ts` 的总览页建议区（每十秒被拉一次，见 `collectLanes` 的注释）。
 * 单 lane 的 {@link planCacheAlert} 留给测试与"只想问一条 lane"的调用点。
 */
export function planCacheAlerts(input: {
  events: readonly AppEvent[];
  nowMs: number;
  respectDedupe: boolean;
}): CacheAlertVerdict[] {
  const lanes = collectLanes(input.events);
  return (['heavy', 'light'] as const).map(lane =>
    verdictOf(lane, lanes[lane], input.events, input.nowMs, input.respectDedupe));
}

/**
 * 判据本体在一条 lane 上的实现（`planCacheAlert` / `planCacheAlerts` 共用的唯一一份）。
 *
 * 2026-10-26 起多了两步（文件头 ①②），都排在上面那串出口**之前**：
 *   ⓪ **选窗口**：先定"这条 lane 最新的模型"，窗口只取**该模型**的最近
 *      {@link CACHE_ALERT_WINDOW_TURNS} 档，基线也只取该模型的（换模型即重开窗口）；
 *   ⓪′ **定口径**：该模型的窗口"不返回缓存数据"（`cacheCaliberOf`）就整窗改成**自算**，
 *      连基线一起换（否则自算的 33% 会被拿去跟供方的 94.6% 比，那条相对线永远不响）。
 * 两个决定都写在读数里（`model` / `modelsInWindow` / `cacheReported` / `cacheEstimated`）。
 */
function verdictOf(
  lane: ModelLane,
  all: LaneBucket[],
  events: readonly AppEvent[],
  nowMs: number,
  respectDedupe: boolean,
): CacheAlertVerdict {
  if (all.length === 0) return { fired: false, why: 'no-calls', reading: null };

  // ⓪ 窗口只统计**最新那个模型**的桶（文件头 ①）：换模型就重新放，旧模型的账不并进来。
  const model = all[all.length - 1]?.model ?? 'unknown';
  // `modelsInWindow` 是**原始**最近 20 档里出现过的模型（诊断用，不参与判据）：
  // 它回答"这一段历史上混过几个模型"，而不是"窗口统计了几个模型"（后者恒为 1）。
  const modelsInWindow = [...new Set(all.slice(-CACHE_ALERT_WINDOW_TURNS).map(bucket => bucket.model))];
  const modelBuckets = all.filter(bucket => bucket.model === model);
  const window = modelBuckets.slice(-CACHE_ALERT_WINDOW_TURNS);
  // 窗口的 seq 区间：右端是本档末条的 seq，左端是**窗口前一条**的 seq（0 = 没有前一条）。
  // 左端取的是**同模型**窗口前一条：`evictedInWindow` 问的是"这 20 档之间发生过驱逐吗"。
  const windowLastSeq = window[window.length - 1]?.lastSeq ?? 0;
  const windowPrevSeq = modelBuckets.length > window.length
    ? (modelBuckets[modelBuckets.length - window.length - 1]?.lastSeq ?? 0)
    : 0;
  const evicted = evictedInWindow(events, windowPrevSeq, windowLastSeq);

  // 基线段：**窗口之前**、**同一模型**、且落在 `nowMs` 往前 24 小时内的那些档（文件头 ③）
  const windowFirstSeq = window[0]?.lastSeq ?? 0;
  const baselineFloorMs = nowMs - CACHE_ALERT_BASELINE_HOURS * 3_600_000;
  const baseline = modelBuckets.filter((bucket) => bucket.lastSeq < windowFirstSeq
    && bucket.tsMs !== null && bucket.tsMs >= baselineFloorMs);

  const sum = (list: readonly LaneBucket[], pick: (bucket: LaneBucket) => number): number =>
    list.reduce((acc, bucket) => acc + pick(bucket), 0);

  // ⓪′ 口径：供方在这个窗口里报的命中是"没有 / 一个与上下文无关的死数"⇒ 我们自己算。
  //
  // ⚠ **两个下限不是同一个数，别混**：
  //   · **口径**的启动条件是「持续 ≥ {@link CACHE_ALERT_MIN_TURNS} **拍**」——"拍"= 一次模型调用
  //     （同一轮里可能有好几拍：现场 gpt-6.1-sol 那 30 拍只摊在 **4 轮**里）。按轮算的话，
  //     那段永远开不了自算，读数会停在供方的 94.5%（那正是用户不要的那个数）。
  //   · **判据**的样本下限仍然是「≥ {@link CACHE_ALERT_MIN_TURNS} **轮**」（`window.length`，
  //     出口顺序里那一条 too-few-turns）——于是 gpt 那段现在是"**有自算读数、不报**"。
  const providerHit = sum(window, bucket => bucket.hit);
  const windowInput = sum(window, bucket => bucket.input);
  const windowCalls = sum(window, bucket => bucket.calls);
  const caliber: CacheCaliber = cacheCaliberOf(window);
  const estimates = caliber !== 'reported' && windowCalls >= CACHE_ALERT_MIN_TURNS
    ? estimateByBucketOf({ events, lane, model })
    : null;

  const windowSamples = window.map(bucket => hitMissOf(bucket, estimates));
  const hit = estimates === null ? providerHit : windowSamples.reduce((acc, sample) => acc + sample.hit, 0);
  const miss = estimates === null
    ? sum(window, bucket => bucket.miss)
    : windowSamples.reduce((acc, sample) => acc + sample.miss, 0);
  const output = sum(window, bucket => bucket.output);
  const windowReasoningCalls = sum(window, bucket => bucket.reasoningCalls);
  const windowRetries = sum(window, bucket => bucket.retries);
  const windowRatios = windowSamples
    .map(sample => missRatioPairOf(sample.hit, sample.miss))
    .filter((value): value is number => value !== null);
  const baselineRatios = baseline
    .map(bucket => hitMissOf(bucket, estimates))
    .map(sample => missRatioPairOf(sample.hit, sample.miss))
    .filter((value): value is number => value !== null);
  const baselineMedian = medianOf(baselineRatios);

  // 读数在**任何**出口都算出来（doctor 要读"现在的数"，不只是"叫没叫"）：
  // 比值算不出来时给 `-1`——**不拿 0 冒充**"命中率 0%"，那是另一个意思。
  const ratio = hit + miss > 0 ? miss / (hit + miss) : -1;
  const windowVersions = window.flatMap(bucket => bucket.renderVersions);
  const latestVersion = windowVersions[windowVersions.length - 1] ?? 'unknown';
  const costTokens = windowSamples.reduce(
    (acc, sample, index) => acc + sample.miss + (window[index]?.output ?? 0)
      + sample.hit * CACHE_ALERT_HIT_PRICE_RATIO,
    0,
  );
  const reading: CacheAlertReading = {
    lane,
    model,
    modelsInWindow,
    windowTurns: window.length,
    windowInputTokens: windowInput,
    windowProviderHitTokens: providerHit,
    missRatio: ratio < 0 ? -1 : round4(ratio),
    baselineMissRatio: baselineMedian === null ? -1 : round4(baselineMedian),
    estCostPerTurn: window.length === 0 ? 0 : Math.round(costTokens / window.length),
    estCostUnit: 'miss-equiv-tokens',
    topContributor: topContributorOf(window, baseline, evicted),
    renderVersion: latestVersion,
    missRatioBand: ratio < 0 ? -1 : missRatioBandOf(ratio),
    cacheReported: estimates === null,
    cacheEstimated: estimates !== null,
    windowCalls,
    windowReasoningCalls,
    windowRetries,
  };

  if (window.length < CACHE_ALERT_MIN_TURNS) {
    return { fired: false, why: 'too-few-turns', reading };
  }
  if (windowRatios.length === 0 || ratio < 0) {
    return { fired: false, why: 'no-token-sample', reading };
  }
  if (!(ratio > CACHE_ALERT_MISS_RATIO)) {
    return { fired: false, why: 'below-ratio', reading };
  }
  if (baselineMedian === null) {
    return { fired: false, why: 'no-baseline', reading };
  }
  if (!ratioOutweighsBaseline(ratio, baselineMedian)) {
    return { fired: false, why: 'below-baseline', reading };
  }
  if (respectDedupe && alreadyReported(events, reading, nowMs)) {
    return { fired: false, why: 'duplicate', reading };
  }
  return { fired: true, why: 'fired', reading };
}

/**
 * 去重：**同 (lane, renderVersion, 档位) 在 24 小时内报过没有**——从日志里数，不看进程内存。
 *
 * 为什么必须从日志读（与 `real-loop.warnedSinceLastCompaction` 逐字同一条理由）：
 * 重启之后"报过"这件事必须照样成立，否则每次重启都会补一条。为什么不用 `wake/manual.dedupeKey`：
 * 那条键在投影里是**永久生效**的（`state/fold.ts` 的 `dedupeKeys` 只增不清），拿它压 24 小时
 * 的窗口会变成"这台机器上永远只叫一次"——与"恶化一档就该再叫"冲突。去重只有这一处，
 * 不在唤醒那条路上再写一遍（两处各写一遍必然漂移）。
 */
export function alreadyReported(
  events: readonly AppEvent[],
  reading: Pick<CacheAlertPayload, 'lane' | 'renderVersion' | 'missRatioBand'>,
  nowMs: number,
): boolean {
  const floorMs = nowMs - CACHE_ALERT_DEDUPE_HOURS * 3_600_000;
  for (const event of events) {
    if (event.type !== 'budget/cache-alert') continue;
    const at = tsMsOf(event.ts);
    if (at === null || at < floorMs) continue;
    const d = event.data;
    if (d.lane !== reading.lane) continue;
    if (d.renderVersion !== reading.renderVersion) continue;
    if (d.missRatioBand !== reading.missRatioBand) continue;
    return true;
  }
  return false;
}

/** 读数 → 事件载荷（**只挑载荷那几格**；诊断用的三格不进日志——它们是可复算的，不是承诺类事实） */
export function cacheAlertPayloadOf(reading: CacheAlertReading): CacheAlertPayload {
  return {
    lane: reading.lane,
    model: reading.model,
    modelsInWindow: reading.modelsInWindow,
    windowTurns: reading.windowTurns,
    windowInputTokens: reading.windowInputTokens,
    windowProviderHitTokens: reading.windowProviderHitTokens,
    missRatio: reading.missRatio,
    baselineMissRatio: reading.baselineMissRatio,
    estCostPerTurn: reading.estCostPerTurn,
    estCostUnit: reading.estCostUnit,
    topContributor: reading.topContributor,
    renderVersion: reading.renderVersion,
    missRatioBand: reading.missRatioBand,
    cacheReported: reading.cacheReported,
    cacheEstimated: reading.cacheEstimated,
  };
}

// ──────────────────────────────── 文案（三处出口共用一份读数） ────────────────────────────────

/**
 * 未命中率的百分数（`0.2731` → `27.3%`）。
 *
 * **`-1` 在本模块是"算不出来"的哨兵 ⇒ 印成 `未知`**：那是域语义，格式化那一层不该知道，
 * 所以分段只有这一处（`formatPercent` 本体在 `format/units.ts`，比例的唯一写法）。
 */
export function percentText(ratio: number): string {
  return ratio < 0 ? '未知' : formatPercent(ratio);
}

/** 候选归因 → 一句话（给 doctor 与排障读；事件里存的是码，不是这句话） */
export const CONTRIBUTOR_TEXT: Record<CacheAlertContributor, string> = {
  'reasoning-echo-eviction':
    '思维链回传顶穿上限后开始驱逐最老的组（`reasoningEchoPlan` 撞 `maxTotalChars` ⇒ 历史头部位移 ⇒ 每笔重编码前缀）',
  'render-version': '渲染口径换代（窗口里 `context.renderVersion` 换过版 ⇒ 请求体整体不同）',
  'history-tail': '历史前段被改写（窗口里 `context.history.headHash` 变过 ⇒ 前缀从改写处断开）',
  'reasoning-echo': '思维链回传集合变了（窗口里带思维链的拍明显变多）',
  retry: '重试（窗口里平均每拍至少重试一次 ⇒ 服务端在抖）',
  unknown: '原因不明（四条候选判据都不成立——不是"没有原因"，是现有数据指认不出来）',
};

/**
 * 没响的原因 → 一句话（**每个出口都要说得清**：不发不等于同一个理由）。
 * 这张表只服务 `doctor` 与排障——事件只在 `fired` 时落库，失败分支不进日志。
 */
export const CACHE_ALERT_SKIP_TEXT: Record<CacheAlertSkip, string> = {
  'no-calls': '这条 lane 一条 `budget/consumed` 都没有，无从读数',
  'too-few-turns': `窗口不足 ${CACHE_ALERT_MIN_TURNS} 轮，样本不够，不判`,
  'no-token-sample': '窗口里的调用全是 0 token（失败拍）⇒ 比值算不出来',
  'below-ratio': `在线内（触发线 ${percentText(CACHE_ALERT_MISS_RATIO)}，且需比基线中位数高出 ${CACHE_ALERT_BASELINE_FACTOR} 倍）`,
  'no-baseline': `窗口之前 ${CACHE_ALERT_BASELINE_HOURS} 小时内没有可比基线，不判`,
  'below-baseline': `过了绝对线，但相对基线没到 ${CACHE_ALERT_BASELINE_FACTOR} 倍`,
  duplicate: `同 (lane, renderVersion, 档位) 在 ${CACHE_ALERT_DEDUPE_HOURS} 小时内已报过`,
};

/**
 * **三处出口共用的那一段读数**（逐字同一份：`doctor`、控制台、`cli tail` 都引它）。
 *
 * 用户给的三个数就是这三个：**现在的未命中率 / 基线 / 最近多少轮**，
 * 再加一个"每轮大约多少钱"——第四格在本仓库是**未命中当量 token**（不是钱，理由见文件头）。
 *
 * 2026-10-26 起这一行多了两件东西（文件头 ①②）：
 *   · **模型名**（`（heavy · deepseek-flash）`）——同一个 lane 换了模型就是另一本账，
 *     不带模型名的两行读数没法比；
 *   · **自算标记**（`· 按上下文前缀自算`）——那一个百分数不是供方说的，是我们自己算的。
 *     这一格必须在**三处出口**都出现（它们共用这一行），否则"同一个指标两个口径"。
 *
 * 入参刻意取**载荷的那几格**而不是整个 `CacheAlertReading`：`cli tail` 手上只有事件载荷
 * （诊断用的三格不落库），而"同一条判据吐出同一句话"这条要求不该被一个
 * "少了个只给测试看的字段"破坏。
 */
export function cacheAlertReadings(
  reading: Pick<CacheAlertPayload,
    'lane' | 'model' | 'windowTurns' | 'missRatio' | 'baselineMissRatio' | 'estCostPerTurn' | 'cacheEstimated'>,
): string {
  const laneText = reading.lane === 'heavy' ? 'heavy' : 'light';
  // 老事件（2026-10-26 之前写的 `budget/cache-alert`）里没有 `model` / `cacheEstimated` 两格：
  // 那时窗口不分模型。`cli tail` 读老日志照样要能印出一行——缺模型就如实写"模型未知"，
  // 不拿 lane 名顶替（那会把"没记"读成"只有一条 lane"）。
  const modelText = String(reading.model ?? '') === '' ? '模型未知' : String(reading.model);
  const caliberText = reading.cacheEstimated === true ? ' · 按上下文前缀自算' : '';
  return `缓存未命中率 ${percentText(reading.missRatio)}（基线 ${percentText(reading.baselineMissRatio)}）`
    + ` · 最近 ${reading.windowTurns} 轮（${laneText} · ${modelText}）${caliberText}`
    + ` · 每轮约 ${formatCompact(reading.estCostPerTurn)} 未命中当量`;
}

/**
 * **出口 ①：控制台那一行**（`real-loop` 的 `handleCacheAlert` 原地 `write`）。
 *
 * 用户的原句（任务书）：
 *   `[成本] 缓存未命中率 27.3%（基线 1.2%）· 最近 20 轮 · 每轮约 <金额> —— 检查 renderVersion 换代 / reasoning 回传 / 历史尾部变化`
 *
 * 本函数产出的是**同一句式**，只把那一格金额换成 `43.2k 未命中当量`——仓库不引入价格/货币
 * （四处成文的用户铁律，见文件头）。那一截是本仓库**唯一**有意偏离任务书字面的地方，
 * 偏离的理由写在文件头，值是**可复算的 token 数**而不是编出来的金额。
 */
export function cacheAlertConsoleLine(reading: CacheAlertReading): string {
  return `[成本] ${cacheAlertReadings(reading)}`
    + ' —— 检查 renderVersion 换代 / reasoning 回传 / 历史尾部变化';
}

/**
 * **出口 ②：`doctor` 那一条的 detail**（`OPS-cache-miss`，warn 级，不进退出码）。
 *
 * 与上面那行**同源**（`cacheAlertReadings` 逐字同一份），末尾接上"为什么响/为什么没响"——
 * doctor 是给人**坐下来读**的，多给一格归因不多花一分钱。
 */
export function cacheAlertDoctorDetail(reading: CacheAlertReading, why: CacheAlertSkip | 'fired'): string {
  const head = cacheAlertReadings(reading);
  if (why !== 'fired') return `${head} · ${CACHE_ALERT_SKIP_TEXT[why]}`;
  return `${head} · 主嫌疑：${CONTRIBUTOR_TEXT[reading.topContributor]}`
    + ' —— 先看 renderVersion 有没有换代、再看 reasoning 回传与历史尾部';
}

/**
 * **出口 ③：那条真唤醒的正文**（`wake/manual{via:'system'}.note`，逐字进日志与她的上下文）。
 *
 * 用户要的两件事，逐条落在四行里：
 *   · 「让她知道**最近很贵**」——第一行给三个数（现在的未命中率 / 基线 / 每轮当量）；
 *   · 「**先别做长任务**」——第二行是命令句，且给了**恢复条件**（回到线内再做），
 *     没有它她会把这条读成"以后都别干活"；
 *   · 「并给她一句『可以说一句：最近缓存命中低，我少绕两圈』」——第三行**逐字**是那句话：
 *     给她一句可以直接对用户说的话（用户要的是"她知道，而且能说出口"）；
 *   · 第四行给一条**自己能查**的路（`budget/consumed.cacheBreak` 与 headHash），
 *     免得她只能干等框架修。
 *
 * 渲染形态：`wake/manual` 会被 `renderWake` 拼成 `[界面消息] <本函数返回值>`，
 * 开头的 `【框架通报 · 缓存成本】` 就是给她（与事后读日志的人）认来源的锚
 * （与 `compactionSoonNote` 同一种写法）。
 *
 * ⚠ **正文里不许出现 Markdown 记号**（2026-10-22 用户点名的硬性要求）：它是在界面上读的
 * 纯文本，渲染层不认 Markdown——要强调用「」或换行。
 *
 * ────────── 2026-10-26：三档口径，文案按用户给的三句话分（文件头最后一段） ──────────
 *
 *   · **常规**（供方给了数）：`最近 N 轮（lane · model）未命中 X%，24 小时基线 Y%——…`
 *   · **零命中**（供方一次都没报命中）：`<model> 最近 N 轮一次缓存都没命中（命中 0 / 输入 Z）
 *     ——该端点很可能不支持前缀缓存，换模型即可恢复`（这一档**不出现未命中率**：那个数是我们
 *     自算的，会在下一句里说清；现场就是 `gpt-6.1-sol`）
 *   · **自算**（供方报了一个与上下文规模无关的常数）：常规句式 + `（该模型不返回缓存数据，
 *     本行按上下文前缀自算）`
 * 三档都**带模型名**、都**不写钱**。
 */
export function cacheAlertWakeNote(reading: CacheAlertReading): string {
  const laneText = reading.lane === 'heavy' ? 'heavy' : 'light';
  const where = CONTRIBUTOR_TEXT[reading.topContributor];
  const progress = `每轮约 ${formatCompact(reading.estCostPerTurn)} 未命中当量（未命中 + 输出 + 命中/10）`;
  // 零命中那一档：供方一次都没报命中（自算值在整个窗口都靠我们估）——它要说的不是"多贵"，
  // 而是"这条端点不报缓存，换模型就回来了"（现场：gpt-6.1-sol 30 拍里 21 拍 0、9 拍固定 5248）
  const zeroHit = reading.cacheEstimated && reading.windowProviderHitTokens === 0;
  const head = zeroHit
    ? `【框架通报 · 缓存成本】${reading.model} 最近 ${reading.windowTurns} 轮一次缓存都没命中`
      + `（命中 0 / 输入 ${formatCompact(reading.windowInputTokens)}）`
      + '——该端点很可能不支持前缀缓存，换模型即可恢复。'
    : `【框架通报 · 缓存成本】最近 ${reading.windowTurns} 轮（${laneText} · ${reading.model}）`
      + `未命中 ${percentText(reading.missRatio)}，24 小时基线 ${percentText(reading.baselineMissRatio)}——${progress}`
      + (reading.cacheEstimated ? '（该模型不返回缓存数据，本行按上下文前缀自算）' : '')
      + '。';
  return `${head}这不是你做了什么错事：未命中率高，说明每一拍都在把前缀重编码一遍，代价花在这里。
- 先别起长任务：一次长任务要发几十个请求，每一个都按这个价付。等未命中率回到 ${percentText(CACHE_ALERT_MISS_RATIO)} 以内再做。
- 可以跟用户说一句：最近缓存命中低，我少绕两圈。
- 想自己查就去看 \`budget/consumed.cacheBreak\` 与 \`context.history.headHash\`（每拍一条）；框架的主嫌疑是：${where}。`;
}
