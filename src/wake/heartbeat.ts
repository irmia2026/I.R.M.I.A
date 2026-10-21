/**
 * Irmia Agent — 心跳：**概率随时间上升**的连续模型（docs/design.md §4.12、docs/persona.md §6）
 *
 * 心跳是"她自己的呼吸"：没有人说话时，它决定她什么时候自己醒一拍、看一眼有没有该做的事。
 *
 * ## 为什么不是固定间隔（这一版换掉的东西）
 *
 * 用户 2026-10-04 的原话：
 *
 * > 「我希望心跳在 **5~60 分钟不等**，越长时间没触发，**触发概率就越高**。平均在 **10~20 分钟**左右。」
 *
 * 上一版是**确定性排程**：基线 30 分钟、空拍按 2^n 退避、下限 10、上限 60。
 * 它有个被实测钉死的病灶：连续空转时退避撞上限，于是**每一拍都是精确的整 60 分钟**
 * （日志实证：2026-10-04 00:10 → 07:25 连续 9 拍，间隔全是 60.0 分钟；见 `_research/` 的分布脚本）。
 * 那个形态下"越久没触发越该醒来看看"这层意思根本没有落点——间隔是常数，与安静多久无关。
 * 用户的要求不是"换一组更漂亮的常数"，而是**换一类模型**：间隔随机、且命中概率随安静时间上升。
 *
 * ## 模型（本文件唯一的节律真相源）
 *
 * 三段式，每 `tick`（默认 1 分钟）抽一次签：
 *
 *     q = clamp01((安静时长 − floor) / (ceil − floor))     // 位置比例
 *     p = q^α                                             // 命中概率，随安静单调不减
 *     命中 → 这一拍触发；未命中 → 再等一个 tick
 *
 *   - **安静 < floor（默认 5 分钟）绝不触发**：那一段 q = 0 ⇒ p = 0。这是下限，
 *     不是"概率很小"——它同时挡住了"刚说完话又被自己叫醒"。
 *   - **安静 ≥ ceil（默认 60 分钟）必然触发**：q = 1 ⇒ p = 1。这是上限，也顺便让分布有硬尾巴，
 *     不会出现上一版那种"配错一个倍数就静默六小时"。
 *   - 中间 5~60 分钟：p 由 0 爬到 1，α 决定爬的形状。
 *     触发时刻的取值是 `floor, floor+tick, …, ceil−tick`（默认 5, 6, …, 59 分钟，实测最小 6、最大 41）；
 *     下限那一头精确满足"5 分钟起"，上限那头留了一个 tick 的余量——60 是**硬上界**，永不越过。
 *
 * ## 改频率：**给目标均值**，α 是解出来的（不是手调的旋钮）
 *
 * 人话旋钮是 `wake.heartbeatTargetMeanMin`（目标均值，分钟，默认 15）——它问的就是
 * 「平均多久醒一次」这句话本身。启动时按它**反解 α**（`solveHeartbeatAlpha`：
 * 二分 + 固定步数，用的是与实测同一套 pmf——`heartbeatMeanMs`），于是"把心跳调慢到 30 分钟"
 * 只需要说 30，不需要知道 α 是什么、更不需要去调它：
 *
 *     均值(α) 随 α **单调不减**（q<1 时 α 越大 p 越小 ⇒ 等得越久）⇒ 二分合法；
 *     搜索区间 α ∈ [1e-6, 256]，固定 200 步收敛（**确定性**：同输入同输出，不用随机、
 *     也不靠"迭代到差不多就停"）。
 *
 * 目标 15 分钟解出 **α = 1.103180**——与下面那个历史标定值 1.1 差 0.0032，两者的均值差
 * 0.03 分钟（不到 2 秒），所以"默认 15 分钟"与"α = 1.1"这两个说法仍然自洽
 * （`test/heartbeat-target-mean.test.ts` 把这个自洽点钉成断言）。
 *
 * **两端仍由 floor / ceil 兜住**（与 α 无关，一个字没改）：安静 < floor 绝不触发、
 * 安静 ≥ ceil 必然触发。目标均值只允许落在开区间 (floor, ceil) 里（配置解析时校验），
 * 而模型能表达的均值范围是闭区间 **[floor + tick, ceil]**（α→0 时第一拍必中 ⇒ floor + tick；
 * α→∞ 时一路拖到 ceil）：够不着的目标会被解到搜索边界，**实际均值以分布摘要里的解析均值为准**
 * ——配置校验只管"目标在不在 (floor, ceil) 里"这一条，不管 tick 粒度带来的那点可达性。
 *
 * ## α = 1.1 的来历（历史标定值；现在只在"没给目标均值"时兜底）
 *
 * 不用线性 `q`（即 α=1.0）是**先算过再否掉的**：线性给的均值只有 13.98 分钟，看着够用，
 * 但它偏短的一侧太厚（p5 = 7 分钟，5~10 分钟就触发掉 29.5%），而用户要的"越久越可能"
 * 想要的是更靠中间的形状。定 α 的唯一判据是**实测均值落进 10~20 分钟**，推法是：
 *
 *   1. `_research/heartbeat-dist-calibrate.mjs` 扫 α = 0.4…1.5，同时给两样东西：
 *      ① 蒙特卡洛（20 万次、固定种子）；② 解析值 `E = Σ_q q·P(安静 = q)`（pmf 求和）。
 *      两条独立路径互校（差 0.011 分钟），另有一条 20 万分钟的连续长链量"长期平均间隔"
 *      （更新过程：命中即复位，所以长期平均间隔 = E[单轮]）做乘性检验。
 *   2. 反推命中"均值 = 15 分钟"（10~20 的中间值）的 α = 1.103180，取两位小数 **α = 1.1**。
 *   3. α = 1.1 的实测结果（固定种子 0x49524D49，20 万次）：
 *
 *        均值 14.98 分钟 · 中位数 15 · p5 8 分钟 · p95 24 分钟
 *        5 分钟内触发 0.000% · 60 分钟才触发 0.000% · 长链平均间隔 15.03 分钟
 *        分档：5~10 分钟 12.9% · 10~15 分钟 36.7% · 15~20 分钟 32.6% · 20~25 分钟 14.2% · 更久 3.6%
 *
 * 复跑：`node _research/heartbeat-dist-calibrate.mjs --runs 200000`。
 * 改 floor / ceil 会平移整条曲线，**均值会变**：现在不用手工重核了——把目标均值写进配置，
 * α 会在启动时按新的 floor / ceil / tick 重新解一遍（解出来的 α 与解析均值都进分布摘要）。
 *
 * ## 压力（pressure）为什么不再参与节律
 *
 * 上一版用 `(1.5 − pressure)` 压扁间隔，本版**不调制**：用户对心跳的要求是一个统一的分布
 * （"平均 10~20 分钟"），"有牵挂时该更急"这件事不再由节律表达——概率只由一个量决定（安静多久），
 * 于是"均值 15 分钟"这句话才成立、才可复算。`pressure` 仍照旧落进事件（诊断要读）。
 *
 * **每一拍都进 turn**（2026-10-05 起）：命中即"顺带起来看一眼"，没有"值不值得起一个 turn"这一问
 * ——用户把心跳改成**真实唤醒**（唤醒一次的花费远少于缓存前缀被供方回收的花费，这一拍就是去保温
 * 供方那份 KV 前缀的）。当年承担那一问的回复必要性门已拆，原意与警告见 docs/design.md 的
 * 「试过并废掉的口径：回复必要性门」。她当然仍可以不说话（`turn/end.spoke=false`）。
 *
 * ## 复位语义（一个字没改）
 *
 * 只有**外部事件**（任何 wake/* 经 WakeSink 进来）调用 `noteActivity()`，把安静计时归零、
 * 重新从"安静 0"开始抽签。心跳自己**不复位**（否则概率永远起不来）。
 *
 * ## 可审计：这一拍为什么现在响
 *
 * 触发时落进事件的不只是 `quietSeconds`，还有**当时用的概率 `probability`** 与
 * **抽到的随机数 `roll`**。有了这两个数，"这一拍为什么现在响"是可复算的：
 * 当时安静多少秒 ⇒ p 应该是多少（q^α）⇒ roll < p 才响。
 *
 * ## 随机源
 *
 * `random` 可注入：测试与 `_research/` 的模拟一律注入固定种子的 `makeSeededRandom`，
 * 不用真随机——判据是"模拟 10000 次的均值"，不注入就没法复跑。生产缺省 `Math.random()`。
 *
 * 事件写入由调用方负责（`policy` 求值与事件组装在本模块，落库在 HeartbeatSource）：
 * 本模块不认识 EventLog，与 wake/sources.ts 同一条边界纪律。
 *
 * 约定：值导入写 `.ts`（--experimental-strip-types 只擦类型不改路径），纯类型导入写 `.js`。
 */

import type { Projection, WakeHeartbeat } from '../log/types.js';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 安静下限兜底：5 分钟。安静不足它绝不触发（用户给的区间下界） */
export const DEFAULT_HEARTBEAT_FLOOR_MS = 5 * 60 * 1000;

/** 安静上限兜底：60 分钟。到点必然触发——再安静也不该超过一小时不露面 */
export const DEFAULT_HEARTBEAT_CEIL_MS = 60 * 60 * 1000;

/**
 * 检查节奏：1 分钟抽一次签。
 * 它是"抽签频率"不是"心跳间隔"——抽中了才是心跳。调大 = 触发时刻更粗（只能落在 tick 的整数倍上）。
 */
export const DEFAULT_HEARTBEAT_TICK_MS = 60 * 1000;

/**
 * 概率曲线的形状指数 α 的**兜底值**（`p = q^α`）。推法与结果见文件头"α = 1.1 的来历"。
 *
 * 它现在只在**没给目标均值**时生效（`HeartbeatOptions.targetMeanMs` 缺省，或测试/标定注入
 * `shapeAlpha`）。生产路径给的是 `wake.heartbeatTargetMeanMin`，α 由 `solveHeartbeatAlpha`
 * 当场解出来——**手调 α 这件事已经取消了**：改频率说目标均值，别改这个常量。
 */
export const HEARTBEAT_SHAPE_ALPHA = 1.1;

/**
 * α 的搜索下界：小到"第一拍必中"（q>0 时 q^α ≈ 1）⇒ 均值取下限 floor + tick。
 * 取 1e-6 而不是 0：JS 里 `0 ** 0 === 1`，α = 0 会让"下限那一刻"这个退化点混进概率里。
 */
const ALPHA_SEARCH_MIN = 1e-6;

/**
 * α 的搜索上界：256 时默认区间（5/60/1）的解析均值已经是 59.99 分钟，
 * 覆盖得住配置允许的最大目标（< ceil，即整数 59）。α 再大只是把均值推向 ceil 的极限。
 */
const ALPHA_SEARCH_MAX = 256;

/**
 * 二分步数（**固定**，不是"收敛到某个容差就停"）：200 步把 [1e-6, 256] 压到
 * 256 / 2^200，早就过了 double 的分辨率。写死步数是为了让解**确定**：
 * 同一组输入永远给出同一个 α，日志/测试/复算三处对得上。
 */
const ALPHA_SEARCH_STEPS = 200;

/**
 * 策略否决后的重查间隔（毫秒）——design §4.12：策略是热更点，
 * 被否决的这拍不产生任何事件，30 分钟后重新求值。
 */
export const POLICY_RECHECK_MS = 30 * 60 * 1000;

/**
 * 兜底下限：任何定时器都不短于 1 秒。
 * 概率模型自己算不出这么短的值（最早的一拍也在 floor 之后），它是防"配置写了个 0"的安全网。
 */
const MIN_DELAY_MS = 1_000;

/** 定时器上限（约 30 天）：防止荒唐配置让 setTimeout 溢出成"立刻触发" */
const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

// ──────────────────────────────── 对外类型 ────────────────────────────────

/** 一拍心跳的节律结论 */
export type HeartbeatDecision = 'fire' | 'skip';

/** 节律策略：返回 null/'skip' 表示此刻不心跳；异常按 'fire' 处理（心跳不可被策略 bug 掐死） */
export type HeartbeatPolicy = () => HeartbeatDecision | null;

/**
 * 一次心跳的事实（尚未分配 seq）。
 *
 * `quietSeconds` 从投影算（优先 `lastAssistantAt`，其次 `lastWake`），
 * `probability` / `roll` 是**这一次抽签**的两个数：判据是 `roll < probability`。
 */
export interface HeartbeatFiring {
  quietSeconds: number;
  /** 空拍数：连续触发过多少次而中间没有外部事件。**不再参与节律**，仅供诊断（GUI/日志） */
  idleTicks: number;
  /** 压力值（投影算出来的）：**不再参与节律**，仅供诊断与必要性门 */
  pressure: number;
  /** 触发时安静时长对应的命中概率（q^α，见文件头） */
  probability: number;
  /** 这一次抽到的随机数（[0,1)）；`roll < probability` 才触发 */
  roll: number;
}

/** 分布摘要：启动摘要、诊断、测试与报告都读它，避免各处自己解释常量 */
export interface HeartbeatDistribution {
  floorMs: number;
  ceilMs: number;
  tickMs: number;
  alpha: number;
  /** 单轮安静时长的期望值（毫秒），由 pmf 求和解析算出（与实测互校过，见文件头） */
  meanMs: number;
  /**
   * 反解 α 用的**目标均值**（毫秒）；没给目标（α 走兜底/注入值）时为 null。
   *
   * 它在这里是为了让"改频率"这件事可复算：摘要里同时有目标、解出来的 α、解析均值三个数，
   * 启动日志/诊断读一眼就知道"她要多久醒一次、代码实际按多久排"。
   */
  targetMeanMs: number | null;
}

/** 心跳节拍器选项 */
export interface HeartbeatOptions {
  /** 投影：lastAssistantAt / lastWake / idleTicks / pressure 的来源 */
  projection: Projection;
  /** 安静下限（毫秒，默认 5 分钟）：不足它绝不触发 */
  floorMs?: number;
  /** 安静上限（毫秒，默认 60 分钟）：到点必然触发 */
  ceilMs?: number;
  /** 抽签节奏（毫秒，默认 1 分钟） */
  tickMs?: number;
  /**
   * 目标均值（毫秒）：**说人话的那个旋钮**。给了它，α 就在构造时由 `solveHeartbeatAlpha`
   * 反解（生产路径来自 `wake.heartbeatTargetMeanMin`）；不给则用 `shapeAlpha` / 兜底常量。
   */
  targetMeanMs?: number;
  /**
   * 形状指数 α（默认 HEARTBEAT_SHAPE_ALPHA）：只给**测试与标定**注入用，不进配置。
   * 只在没给 `targetMeanMs` 时生效——两个都给时以目标均值为准（它是人的口径，α 是实现的细节）。
   */
  shapeAlpha?: number;
  /** 节律策略（热更点） */
  policy?: HeartbeatPolicy | null;
  /**
   * 每拍的交付回调（已通过策略求值）。**只管交付事实，不做写入**：
   * 组装与落库在 HeartbeatSource。缺省时空实现，供纯算法测试使用。
   */
  onFire?: (firing: HeartbeatFiring) => void;
  /** 时钟注入：定时器布防与安静计时都用它 */
  now?: () => Date;
  /** 随机源注入（测试与模拟一律注入固定种子；生产缺省 Math.random） */
  random?: () => number;
  /** 定时器注入（测试用假闹钟）；给出时必须同时给出 clearTimer */
  setTimer?: (handler: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** 诊断输出 */
  onDebug?: (line: string) => void;
}

// ──────────────────────────────── 概率模型（纯函数，可单测） ────────────────────────────────

/**
 * 安静时长 → 命中概率。**本模型唯一的概率定义**（文件头有完整推导与实测）：
 *
 *     q = clamp01((quietMs − floorMs) / (ceilMs − floorMs))
 *     p = q^α
 *
 * 三条性质都是判据（test/heartbeat.test.ts ①③）：
 *   - `quietMs < floorMs` ⇒ p = 0（下限，绝不触发）；
 *   - `quietMs ≥ ceilMs` ⇒ p = 1（上限，必然触发）；
 *   - p 随 quietMs **单调不减**（q 与 q^α 在 [0,1] 上都单调不减）。
 */
export function heartbeatProbability(quietMs: number, floorMs: number, ceilMs: number, alpha: number): number {
  const span = ceilMs - floorMs;
  // 上限不大于下限（配置写反了/相等）：只剩"到点必响"这一种合法语义，不给中间地带
  if (!(span > 0)) return quietMs >= ceilMs ? 1 : 0;
  const q = (quietMs - floorMs) / span;
  if (!(q > 0)) return 0; // 含 NaN（quietMs 非法）→ 不触发，静默更久才是坏方向
  if (q >= 1) return 1;
  return q ** alpha;
}

/**
 * 单轮安静时长的期望值（毫秒）：`E = Σ_q q·P(安静 = q)`，q 取遍 floor..ceil 之间的抽签点。
 *
 * 两处容易写错、都在 `_research/heartbeat-dist-calibrate.mjs` 里踩过并留了证：
 *   ① **不能用存活和** `Σ P(安静 > m)`：本模型第一个抽签点的 p **恰好是 0**（floor 那一刻 q=0），
 *      那个退化项会被多算一次，结果恒多一个 tick（实测 13.98 真值 vs 存活和 14.975）。
 *   ② **尾部那一项不能省**：最后一个抽签点 p ≡ 1（到 ceil 必然触发），它没有"命中概率"可乘
 *      ——它是必然而不是概率。漏掉它，α=0（每次必中）会算出 floor 而不是 floor + tick。
 */
export function heartbeatMeanMs(floorMs: number, ceilMs: number, tickMs: number, alpha: number): number {
  if (!(ceilMs > floorMs) || !(tickMs > 0)) return floorMs;
  let survival = 1;
  let mean = 0;
  for (let quiet = floorMs; quiet <= ceilMs; quiet += tickMs) {
    const hit = heartbeatProbability(quiet, floorMs, ceilMs, alpha);
    mean += quiet * survival * hit; // P(安静 = quiet)
    survival *= 1 - hit;
    if (!(survival > 1e-15)) break; // 尾巴可以忽略了：剩下的概率全落在"到点必然触发"那一项上
  }
  // 尾部：一直没命中就会在 ceil 那一刻必然触发（p = 1），这一项按剩余存活概率整块计入
  mean += ceilMs * survival;
  return mean;
}

/**
 * **反解 α**：给定目标均值，返回让 `heartbeatMeanMs(...) === targetMeanMs` 的那个 α。
 *
 * 这就是"改频率只需要给目标均值"这句话的落点：α 不是配置项，它是这里算出来的中间量。
 * 判据只有一条——**与实测同一套 pmf**：均值一律由 `heartbeatMeanMs`（pmf 求和）算，
 * 测试里的模拟也走同一个心跳类，不另写一份公式（两份公式漂起来正是这一类改动最容易坏的地方）。
 *
 * 为什么二分合法：`q ∈ (0,1)` 时 `q^α` 随 α **严格减小** ⇒ 命中越难 ⇒ 等得越久 ⇒
 * 均值随 α **单调不减**（实测表见文件头：α=1 → 13.98、1.1 → 14.97、2 → 23.33、50 → 59.07）。
 * 于是"均值 = 目标"这个方程在 α 上只有一个解，二分一定收敛到它。
 *
 * 确定性的三条硬规矩（不为好看留余地）：
 *   ① **不用随机**：没有任何蒙特卡洛，纯解析 pmf 求值；
 *   ② **固定步数**：`ALPHA_SEARCH_STEPS` 步，不看容差、不提前退出——同输入必同输出；
 *   ③ **边界给确定答案**：目标够不着时取搜索边界并**如实返回**（不抛错、不偷偷改成别的目标），
 *      实际均值以 `heartbeatMeanMs` 的结果为准（分布摘要里就是它）。
 *      够不着的两种情形：比"最快"还快（≤ floor + tick，α→0 的极限）⇒ 返回下界；
 *      比"最慢"还慢（≥ ceil，α→∞ 的极限）⇒ 返回上界。
 *
 * ⚠️ 配置层已经把"目标必须落在 (floor, ceil) 里"卡住了（`wake.heartbeatTargetMeanMin` 的
 * 交叉校验）；这里处理的是**模型可达性**那一层（tick 粒度会让最短均值 = floor + tick）。
 */
export function solveHeartbeatAlpha(floorMs: number, ceilMs: number, tickMs: number, targetMeanMs: number): number {
  // 退化区间或非法目标：解不出来也不该编一个，落回兜底 α（调用方随后会看到解析均值）
  if (!(ceilMs > floorMs) || !(tickMs > 0) || !Number.isFinite(targetMeanMs)) return HEARTBEAT_SHAPE_ALPHA;

  const meanAt = (alpha: number): number => heartbeatMeanMs(floorMs, ceilMs, tickMs, alpha);
  const meanAtMin = meanAt(ALPHA_SEARCH_MIN);
  const meanAtMax = meanAt(ALPHA_SEARCH_MAX);
  if (targetMeanMs <= meanAtMin) return ALPHA_SEARCH_MIN;
  if (targetMeanMs >= meanAtMax) return ALPHA_SEARCH_MAX;

  // 二分：mean(mid) < 目标 ⇒ α 还不够大（均值偏小）⇒ 抬下界；否则压低上界
  let lo = ALPHA_SEARCH_MIN;
  let hi = ALPHA_SEARCH_MAX;
  for (let step = 0; step < ALPHA_SEARCH_STEPS; step += 1) {
    const mid = (lo + hi) / 2;
    if (meanAt(mid) < targetMeanMs) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * 可复现的伪随机源（SplitMix32）：同一种子给同一串数。
 *
 * 为什么生产之外一律用它：验收判据是"模拟 10000 次的均值落在 10~20 分钟"，
 * 拿真随机去跑，结论每次都不同、失败也无法复现。种子取整数字面量（写字符串哈希会引入
 * 与文本编码有关的隐藏输入）。
 */
export function makeSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return ((z ^ (z >>> 15)) >>> 0) / 4294967296;
  };
}

// ──────────────────────────────── 心跳 ────────────────────────────────

/**
 * 心跳节拍器。它只管"什么时候该醒"与"这一拍的事实是什么"，
 * 不管"醒了往哪写"（那是 HeartbeatSource 的事），也不管"醒了要不要说话"（必要性门的事）。
 */
export class Heartbeat {
  private readonly projection: Projection;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly setTimer: (handler: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly emitDebug: (line: string) => void;
  /** 交付回调：构造时给一份默认空实现，HeartbeatSource 装好之后再换掉它 */
  private fireCallback: (firing: HeartbeatFiring) => void;
  private readonly floorMs: number;
  private readonly ceilMs: number;
  private readonly tickMs: number;
  /**
   * 形状指数 α：**构造时定死**（给了目标均值就是解出来的，否则是兜底/注入值）。
   * 它不是热更点——改频率改的是配置里的目标均值，重启后在这里重新解一次。
   */
  private readonly alpha: number;
  /** 反解 α 用的目标均值（毫秒）；没给目标时为 null（α 走兜底常量） */
  private readonly targetMeanMs: number | null;
  private policy: HeartbeatPolicy | null;
  private handle: unknown = null;
  private running = false;
  /**
   * 安静计时起点：外部事件到达或上一次心跳触发时归零。
   * 初值取"投影里最后一次活动时刻"，于是进程重启后第一条心跳不会把重启当成"刚说完话"
   * （上一版栽在这里：每次重启都从零重新布防，实测出现过 128 / 166 / 256 分钟的空档）。
   */
  private quietSinceMs: number;
  /** 下一次抽签的时刻（计划值；到点时按实际经过的毫秒算安静时长，不想当然用 tick） */
  private nextTickAtMs: number;
  /** 最近一次抽签的两个数（诊断用；触发时原样进事件） */
  private lastRoll: { probability: number; roll: number } | null = null;
  /** 进程内累计的心跳拍数（诊断用；权威计数在日志） */
  private beat = 0;

  constructor(options: HeartbeatOptions) {
    this.projection = options.projection;
    this.floorMs = normalizeDuration(options.floorMs ?? DEFAULT_HEARTBEAT_FLOOR_MS, DEFAULT_HEARTBEAT_FLOOR_MS);
    // 上限低于下限是配置写反了：取上限 = 下限（更快的节律不危险，静默更久才危险）
    this.ceilMs = Math.max(this.floorMs, normalizeDuration(options.ceilMs ?? DEFAULT_HEARTBEAT_CEIL_MS, DEFAULT_HEARTBEAT_CEIL_MS));
    // 抽签节奏不许超过 floor：否则"最早的一拍"会晚于下限，下限就不再是下限
    this.tickMs = Math.min(
      this.floorMs,
      normalizeDuration(options.tickMs ?? DEFAULT_HEARTBEAT_TICK_MS, DEFAULT_HEARTBEAT_TICK_MS),
    );
    // α 的来路有两条，**目标均值优先**（它是人的口径，α 是实现的细节）：
    //   ① 给了 targetMeanMs ⇒ 当场反解（生产路径：wake.heartbeatTargetMeanMin）；
    //   ② 没给 ⇒ 用注入的 shapeAlpha，再没有就用兜底常量 HEARTBEAT_SHAPE_ALPHA。
    // 目标非法（非有限/非正）时按"没给"处理：宁可用标定好的兜底 α，也不要拿 NaN 去算概率。
    const targetMeanMs = options.targetMeanMs;
    if (Number.isFinite(targetMeanMs) && (targetMeanMs as number) > 0) {
      this.targetMeanMs = targetMeanMs as number;
      this.alpha = solveHeartbeatAlpha(this.floorMs, this.ceilMs, this.tickMs, this.targetMeanMs);
    } else {
      this.targetMeanMs = null;
      this.alpha = Number.isFinite(options.shapeAlpha ?? HEARTBEAT_SHAPE_ALPHA) && (options.shapeAlpha ?? HEARTBEAT_SHAPE_ALPHA) > 0
        ? (options.shapeAlpha ?? HEARTBEAT_SHAPE_ALPHA)
        : HEARTBEAT_SHAPE_ALPHA;
    }
    this.policy = options.policy ?? null;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? (() => Math.random());
    this.setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => {
      clearTimeout(handle as NodeJS.Timeout);
    });
    this.emitDebug = options.onDebug ?? (() => undefined);
    this.fireCallback = options.onFire ?? (() => undefined);
    const nowMs = this.now().getTime();
    this.quietSinceMs = referenceActivityMs(this.projection ?? null, nowMs);
    this.nextTickAtMs = this.quietSinceMs + this.tickMs;
  }

  /** 本进程已发出的心跳拍数 */
  get beatCount(): number {
    return this.beat;
  }

  /** 当前是否已布防 */
  get armed(): boolean {
    return this.running;
  }

  /** 分布摘要：启动摘要与诊断读它 */
  get distribution(): HeartbeatDistribution {
    return {
      floorMs: this.floorMs,
      ceilMs: this.ceilMs,
      tickMs: this.tickMs,
      alpha: this.alpha,
      meanMs: heartbeatMeanMs(this.floorMs, this.ceilMs, this.tickMs, this.alpha),
      targetMeanMs: this.targetMeanMs,
    };
  }

  /** 当前安静时长（毫秒）：安静计时起点到"现在" */
  quietMs(): number {
    return Math.max(0, this.now().getTime() - this.quietSinceMs);
  }

  /** 最近一次抽签的 { 概率, 抽到的数 }；还没抽过时为 null */
  lastDraw(): { probability: number; roll: number } | null {
    return this.lastRoll === null ? null : { ...this.lastRoll };
  }

  /** 策略替换点（热更） */
  setPolicy(policy: HeartbeatPolicy | null): void {
    this.policy = policy;
  }

  /** 交付回调替换点：HeartbeatSource 装配时把自己接上（未装配时心跳只记诊断） */
  setOnFire(onFire: (firing: HeartbeatFiring) => void): void {
    this.fireCallback = onFire;
  }

  /** 当前空拍数（取自投影，不额外记账） */
  idleTicks(): number {
    return Math.max(0, Math.trunc(this.projection.idleTicks));
  }

  /** 静默时长（毫秒）：安静不满 tick 的部分不补，取整到 tick 的整数倍 */
  private quietRoundedMs(quietMs: number): number {
    return quietMs - (quietMs % this.tickMs);
  }

  /**
   * 这一拍到下一次抽签该等多久：安静不足下限时只等到"够得着下限"的那一刻，
   * 其余情况等一个 tick。**它不是心跳间隔**——心跳间隔是抽签的结果，不是排出来的。
   */
  nextDelayMs(): number {
    return clampDelay(this.nextTickAtMs - this.now().getTime());
  }

  /**
   * 布防：安静计时取投影里最后一次活动的时刻（重启不重置），并排第一次抽签。
   * 冷启动后最早的一拍落在"安静 5 分钟 + 一个 tick"上，不是"立刻来一拍"。
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    const nowMs = this.now().getTime();
    this.quietSinceMs = referenceActivityMs(this.projection ?? null, nowMs);
    this.nextTickAtMs = this.quietSinceMs + this.tickMs;
    this.arm(this.nextDelayMs());
  }

  stop(): void {
    this.running = false;
    if (this.handle === null) return;
    this.clearTimer(this.handle);
    this.handle = null;
  }

  /**
   * 外部事件到达：安静计时归零，重新从"安静 0"开始抽签（design §4.12「任何外部事件到达即复位」）。
   * 必须由**外部事件**的接收路径调用；心跳自己绝不调用它，否则概率永远起不来。
   */
  noteActivity(): void {
    if (!this.running) return;
    const nowMs = this.now().getTime();
    this.quietSinceMs = nowMs;
    this.nextTickAtMs = nowMs + this.tickMs;
    this.arm(this.tickMs);
  }

  // ── 内部 ──

  /**
   * 一次抽签。顺序是刻意的：
   *   ① 安静不足下限 → 直接排下一次，**不抽、不计数、不产事件**（下限是硬边界，不是小概率）；
   *   ② 抽（random）→ 与 p 比；
   *   ③ 命中：交付事实、安静归零（下一轮从 0 开始）、排下一次；
   *   ④ 未命中：排下一次，别的什么都不变。
   */
  private roll(): HeartbeatFiring | null {
    const nowMs = this.now().getTime();
    const quietMs = Math.max(0, nowMs - this.quietSinceMs);
    const probability = heartbeatProbability(this.quietRoundedMs(quietMs), this.floorMs, this.ceilMs, this.alpha);
    if (probability <= 0) {
      this.emitDebug(`[心跳] 安静 ${(quietMs / 1000).toFixed(0)}s 不足下限，不抽签`);
      this.nextTickAtMs = nowMs + this.tickMs;
      return null;
    }
    const roll = this.random();
    this.lastRoll = { probability, roll };
    if (!(roll < probability)) {
      this.emitDebug(`[心跳] 未命中（安静 ${(quietMs / 60_000).toFixed(1)} 分钟，p=${probability.toFixed(3)}，roll=${roll.toFixed(3)}）`);
      this.nextTickAtMs = nowMs + this.tickMs;
      return null;
    }
    const decision = this.evaluatePolicy();
    if (decision === 'skip') {
      // 策略否决：不产生任何事实，也不算"命中过"——安静计时**不归零**，
      // 于是重查时 p 只会更高。被否决的这拍不该让"越久越可能"这条性质失效。
      this.emitDebug(`[心跳] 节律策略否决本次心跳（${Math.round(POLICY_RECHECK_MS / 60_000)} 分钟后重查）`);
      this.nextTickAtMs = nowMs + POLICY_RECHECK_MS;
      return null;
    }
    this.beat += 1;
    this.quietSinceMs = nowMs;
    this.nextTickAtMs = nowMs + this.tickMs;
    return {
      quietSeconds: this.quietSeconds(),
      // 空拍只在这里递增：+1 落进事件，外部事件到达时由折叠归零。**不再参与节律**，仅供诊断
      idleTicks: this.idleTicks() + 1,
      pressure: clamp01(this.projection.pressure),
      probability,
      roll,
    };
  }

  /**
   * 策略求值的容错：策略抛错按 'fire' 处理。心跳是常驻体的活性保障，
   * 让一个策略 bug 把心跳掐死，是最不能接受的失败方向。
   */
  private evaluatePolicy(): HeartbeatDecision {
    const policy = this.policy;
    if (policy === null) return 'fire';
    try {
      const decision = policy();
      if (decision === 'skip' || decision === null) return 'skip';
      return 'fire';
    } catch (err) {
      this.emitDebug(`[心跳] 节律策略抛错，按照常心跳处理：${err instanceof Error ? err.message : String(err)}`);
      return 'fire';
    }
  }

  private arm(ms: number): void {
    if (this.handle !== null) {
      this.clearTimer(this.handle);
      this.handle = null;
    }
    const wait = clampDelay(ms);
    this.handle = this.setTimer(() => {
      this.handle = null;
      if (!this.running) return;
      const firing = this.roll();
      if (firing !== null) {
        this.emitDebug(
          `[心跳] 第 ${this.beat} 拍（安静 ${firing.quietSeconds}s，p=${firing.probability.toFixed(3)}，`
          + `roll=${firing.roll.toFixed(3)}，空拍 ${firing.idleTicks}）`,
        );
        this.firingHandler(firing);
      }
      if (this.running) this.arm(this.nextDelayMs());
    }, wait);
  }

  /** 交付一拍：回调本身抛错不能带崩定时器链（下一拍必须照常布防） */
  private firingHandler(firing: HeartbeatFiring): void {
    try {
      this.fireCallback(firing);
    } catch (err) {
      this.emitDebug(`[心跳] 交付回调抛错：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 安静时长（秒）：优先"距她上次开口"，其次"距上次被唤醒"。
   * 两者都缺（全新实例）时取 0，而不是拿环境时钟硬算——渲染出"已安静 0 秒"是可读的，
   * 而凭空造一个巨大数字会让必要性门误判成"很久没说话"。
   */
  private quietSeconds(): number {
    const reference = this.projection.lastAssistantAt ?? this.projection.lastWake?.at ?? null;
    if (reference === null) return 0;
    const at = Date.parse(reference);
    if (Number.isNaN(at)) return 0;
    return Math.max(0, Math.floor((this.now().getTime() - at) / 1000));
  }
}

// ──────────────────────────────── 唤醒源适配 ────────────────────────────────

/** 心跳源需要的循环侧能力（与 wake/sources.ts 的 WakeSink 同形，此处只声明用得到的那一条） */
export interface HeartbeatSink {
  /** 落库一条 wake/heartbeat（model 可见；返回时必须在磁盘上） */
  emitHeartbeat(data: WakeHeartbeat['data']): void;
}

/**
 * 心跳唤醒源（与 TimerWakeSource / ManualWatchSource 同款 adapter）。
 *
 * 为什么它不复用 `WakeSink.wake()`：那条路径属于"外部事件"，real-loop 在上面挂
 * `noteActivity()` 复位安静计时。心跳若走那条路，就会每拍把自己复位，概率永远起不来。
 * 所以源只把事实交给 `HeartbeatSink.emitHeartbeat`，复位与不复位各走各的门。
 */
export class HeartbeatSource {
  readonly name = 'heartbeat';

  private readonly heartbeat: Heartbeat;
  private readonly sink: HeartbeatSink;

  constructor(heartbeat: Heartbeat, sink: HeartbeatSink) {
    this.heartbeat = heartbeat;
    this.sink = sink;
    // 装配点：心跳只交付事实，如何成帧与落库留在本类（事件写入的同一处纪律）
    heartbeat.setOnFire((firing) => {
      sink.emitHeartbeat({
        quietSeconds: firing.quietSeconds,
        idleTicks: firing.idleTicks,
        pressure: firing.pressure,
        probability: firing.probability,
        roll: firing.roll,
      });
    });
  }

  start(): void {
    this.heartbeat.start();
  }

  stop(): void {
    this.heartbeat.stop();
  }

  /**
   * 下一次抽签的等待时长（毫秒）。**注意语义**：它是"下一次抽签"，
   * 不是"下一次心跳"——概率模型里心跳时刻是抽签的结果，排不出来。
   */
  nextDelayMs(): number {
    return this.heartbeat.nextDelayMs();
  }

  /** 分布摘要：启动摘要与 status 用它说明"平均多久醒一次" */
  distribution(): HeartbeatDistribution {
    return this.heartbeat.distribution;
  }
}

// ──────────────────────────────── 工具 ────────────────────────────────

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 安静计时起点：投影里最后一次活动（她上次开口 / 上次被唤醒）的时刻。
 *
 * 为什么要读它而不是"进程启动时刻"：重启不是"刚说完话"。上一版每次重启都把定时器
 * 从零重新布防，实测出现过 128 / 166 / 256 分钟的空档（日志实证）。取投影之后，
 * 安静已经够了就按已经够了算——重启不该让心跳往后拖。
 * 参照时刻缺失或非法时取 now（全新实例：从现在开始安静）。
 */
function referenceActivityMs(projection: Projection | null, nowMs: number): number {
  const reference = projection?.lastAssistantAt ?? projection?.lastWake?.at ?? null;
  if (reference === null || reference === undefined) return nowMs;
  const at = Date.parse(reference);
  if (Number.isNaN(at)) return nowMs;
  return Math.min(at, nowMs); // 参照时刻在未来（时钟回拨）时按 now 算，不给负安静
}

/** 时长参数的合法性：非有限/非正一律落回兜底（不拿 0 去算概率） */
function normalizeDuration(ms: number, fallback: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return fallback;
  return clampDelay(ms);
}

/** 定时器时长一律落在 [1s, 30d]：下限挡热循环，上限挡 setTimeout 溢出 */
function clampDelay(ms: number): number {
  if (!Number.isFinite(ms)) return MIN_DELAY_MS;
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.round(ms)));
}
