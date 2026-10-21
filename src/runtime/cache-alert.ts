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
 */

import type { AppEvent, CacheAlertPayload, CacheAlertContributor, ModelLane } from '../log/types.js';
import { formatCompact, formatPercent } from '../format/units.ts';

// ──────────────────────────────── 阈值（唯一一处定义） ────────────────────────────────

/** ① 窗口长度：最近多少**轮**（同一 lane 分开算） */
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
 */
interface LaneBucket {
  hit: number;
  miss: number;
  output: number;
  retries: number;
  calls: number;
  reasoningCalls: number;
  /** 这一档里出现过的 `context.renderVersion`（按出现顺序去重，最后一次写入的是"最新"） */
  renderVersions: string[];
  /** 这一档里出现过的 `context.history.headHash`（历史前段被改写的直接证据） */
  historyHeads: string[];
  /** 最后一拍的 seq（排序键；也是"这一档属于哪一刻"的唯一口径） */
  lastSeq: number;
  /** 最后一拍的 `ts`（毫秒）；解析不出来是 null（那就不参与 24 小时基线） */
  tsMs: number | null;
}

function emptyBucket(seq: number): LaneBucket {
  return {
    hit: 0, miss: 0, output: 0, retries: 0, calls: 0, reasoningCalls: 0,
    renderVersions: [], historyHeads: [], lastSeq: seq, tsMs: null,
  };
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
    const key = d.turn > 0 ? `turn:${d.turn}` : `call:${event.seq}`;
    const bucket = byKey.get(key) ?? emptyBucket(event.seq);
    const input = Number.isFinite(d.inputTokens) ? Math.max(0, d.inputTokens) : 0;
    const hit = Number.isFinite(d.cacheHitTokens) ? Math.max(0, Math.min(d.cacheHitTokens, input)) : 0;
    const miss = Number.isFinite(d.cacheMissTokens) ? Math.max(0, d.cacheMissTokens) : 0;
    const output = Number.isFinite(d.outputTokens) ? Math.max(0, d.outputTokens) : 0;
    bucket.hit += hit;
    bucket.miss += miss;
    bucket.output += output;
    bucket.retries += Number.isFinite(d.retryCount) ? Math.max(0, d.retryCount) : 0;
    bucket.calls += 1;
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

/** 一档样本的未命中率；分母为 0 ⇒ null（算不出来，不拿 0 冒充） */
function missRatioOf(bucket: LaneBucket): number | null {
  const total = bucket.hit + bucket.miss;
  return total > 0 ? bucket.miss / total : null;
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

/** 判据本体在一条 lane 上的实现（`planCacheAlert` / `planCacheAlerts` 共用的唯一一份） */
function verdictOf(
  lane: ModelLane,
  all: LaneBucket[],
  events: readonly AppEvent[],
  nowMs: number,
  respectDedupe: boolean,
): CacheAlertVerdict {
  if (all.length === 0) return { fired: false, why: 'no-calls', reading: null };

  const window = all.slice(-CACHE_ALERT_WINDOW_TURNS);
  // 窗口的 seq 区间：右端是本档末条的 seq，左端是**窗口前一条**的 seq（0 = 没有前一条）
  const windowLastSeq = window[window.length - 1]?.lastSeq ?? 0;
  const windowPrevSeq = all.length > window.length ? (all[all.length - window.length - 1]?.lastSeq ?? 0) : 0;
  const evicted = evictedInWindow(events, windowPrevSeq, windowLastSeq);

  // 基线段：**窗口之前**、且落在 `nowMs` 往前 24 小时内的那些档（理由见文件头）
  const windowFirstSeq = window[0]?.lastSeq ?? 0;
  const baselineFloorMs = nowMs - CACHE_ALERT_BASELINE_HOURS * 3_600_000;
  const baseline = all.filter((bucket) => bucket.lastSeq < windowFirstSeq
    && bucket.tsMs !== null && bucket.tsMs >= baselineFloorMs);

  const sum = (list: readonly LaneBucket[], pick: (bucket: LaneBucket) => number): number =>
    list.reduce((acc, bucket) => acc + pick(bucket), 0);

  const hit = sum(window, bucket => bucket.hit);
  const miss = sum(window, bucket => bucket.miss);
  const output = sum(window, bucket => bucket.output);
  const windowCalls = sum(window, bucket => bucket.calls);
  const windowReasoningCalls = sum(window, bucket => bucket.reasoningCalls);
  const windowRetries = sum(window, bucket => bucket.retries);
  const windowRatios = window.map(missRatioOf).filter((value): value is number => value !== null);
  const baselineRatios = baseline.map(missRatioOf).filter((value): value is number => value !== null);
  const baselineMedian = medianOf(baselineRatios);

  // 读数在**任何**出口都算出来（doctor 要读"现在的数"，不只是"叫没叫"）：
  // 比值算不出来时给 `-1`——**不拿 0 冒充**"命中率 0%"，那是另一个意思。
  const ratio = hit + miss > 0 ? miss / (hit + miss) : -1;
  const windowVersions = window.flatMap(bucket => bucket.renderVersions);
  const latestVersion = windowVersions[windowVersions.length - 1] ?? 'unknown';
  const costTokens = window.reduce(
    (acc, bucket) => acc + bucket.miss + bucket.output + bucket.hit * CACHE_ALERT_HIT_PRICE_RATIO,
    0,
  );
  const reading: CacheAlertReading = {
    lane,
    windowTurns: window.length,
    missRatio: ratio < 0 ? -1 : round4(ratio),
    baselineMissRatio: baselineMedian === null ? -1 : round4(baselineMedian),
    estCostPerTurn: window.length === 0 ? 0 : Math.round(costTokens / window.length),
    estCostUnit: 'miss-equiv-tokens',
    topContributor: topContributorOf(window, baseline, evicted),
    renderVersion: latestVersion,
    missRatioBand: ratio < 0 ? -1 : missRatioBandOf(ratio),
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
    windowTurns: reading.windowTurns,
    missRatio: reading.missRatio,
    baselineMissRatio: reading.baselineMissRatio,
    estCostPerTurn: reading.estCostPerTurn,
    estCostUnit: reading.estCostUnit,
    topContributor: reading.topContributor,
    renderVersion: reading.renderVersion,
    missRatioBand: reading.missRatioBand,
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
 * 入参刻意取**载荷的那几格**而不是整个 `CacheAlertReading`：`cli tail` 手上只有事件载荷
 * （诊断用的三格不落库），而"同一条判据吐出同一句话"这条要求不该被一个
 * "少了个只给测试看的字段"破坏。
 */
export function cacheAlertReadings(
  reading: Pick<CacheAlertPayload, 'lane' | 'windowTurns' | 'missRatio' | 'baselineMissRatio' | 'estCostPerTurn'>,
): string {
  const laneText = reading.lane === 'heavy' ? 'heavy' : 'light';
  return `缓存未命中率 ${percentText(reading.missRatio)}（基线 ${percentText(reading.baselineMissRatio)}）`
    + ` · 最近 ${reading.windowTurns} 轮（${laneText}）`
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
 */
export function cacheAlertWakeNote(reading: CacheAlertReading): string {
  const laneText = reading.lane === 'heavy' ? 'heavy' : 'light';
  const where = CONTRIBUTOR_TEXT[reading.topContributor];
  return `【框架通报 · 缓存成本】最近 ${reading.windowTurns} 轮（${laneText}）的**缓存未命中率 ${percentText(reading.missRatio)}**，`
    + `过去 24 小时的基线是 ${percentText(reading.baselineMissRatio)}——每轮约 ${formatCompact(reading.estCostPerTurn)} 未命中当量`
    + `（未命中 + 输出 + 命中/10）。这不是你做了什么错事：未命中率高，说明每一拍都在把前缀重编码一遍，钱花在这里。
- **先别起长任务**：一次长任务要发几十个请求，每一个都按这个价付。等未命中率回到 ${percentText(CACHE_ALERT_MISS_RATIO)} 以内再做。
- 可以跟用户说一句：最近缓存命中低，我少绕两圈。
- 想自己查就去看 \`budget/consumed.cacheBreak\` 与 \`context.history.headHash\`（每拍一条）；框架的主嫌疑是：${where}。`;
}
