/**
 * 数字口径与单位格式的**唯一实现**（2026-10-05 用户报"同一时刻同一个数两种写法"之后立的）。
 *
 * 用户的现场（逐字）：
 *   > 「运行情况页写 2705.9k，日志页写 2.7M，**同一时刻同一个数两种写法**」
 *
 * 两处各写各的 `_num()`／内联三目，于是同一个 2705946 在两张卡上长得不一样。这种分岔不会
 * 报错、不会让任何测试变红，只会让人**不敢信屏幕上的数**——所以判据收成一个函数，
 * 服务端（`web/server.ts`）与 CLI（`cli.ts`）都引它，界面那一侧是 `gui/lib/format.dart`
 * 的**逐字镜像**（两侧各有一份实现是运行时的现实：一边 Node 一边 Dart；但阈值与小数位
 * 只有这一份文字定义，改这里就得同步改那边，测试两边都钉了同一张表）。
 *
 * 约定（阈值与小数位）：
 *   · 1000 进制；`k` / `M` / `G` 三档，小于 1000 的原样印整数。
 *   · **保留 1 位小数**（`1.0k` / `2.7M` / `1.0G`）；**整数部分到两位数就不带小数**
 *     （`10M` / `100M`）——到那个量级，小数点后面那一位是噪音，而它一位都不丢精度
 *     （`10M` 就是 10,000,000 这个整数本身）。一位数时那一位是**有效数字**，不能省：
 *     `1.0k` 说的是"一千"，省成 `1k` 会让人读不出它是 1000 还是 1000 上下。
 *   · **先四舍五入再换档**，否则会出现 `1000.0k` / `1000.0M` 这种读不出量级的写法：
 *     `999_949 → 999.9k`（它四舍五入不到 1000.0），`999_950 → 1.0M`，
 *     `1_000_000 → 1.0M`，`999_999_999 → 1.0G`。
 *
 * 为什么 unit 单独一段而不是把 `token` 写死在函数里：这个函数也印"日上限""加注量"
 * 这类**不是 token** 的数（层数是"次"）。口径词（非缓存 token）由调用点按那一行的语义给，
 * 不由格式化函数猜。
 */

/** 单位刻度（1000 进制）与后缀。顺序即量级顺序。 */
const SCALES: ReadonlyArray<{ readonly from: number; readonly suffix: string }> = [
  { from: 1_000_000_000, suffix: 'G' },
  { from: 1_000_000, suffix: 'M' },
  { from: 1_000, suffix: 'k' },
];

/**
 * 一个数 → `k` / `M` / `G` 自动换档的紧凑写法（**唯一实现**）。
 *
 * 非有限数照实印（`NaN` / `Infinity`）：调用点拿到的若是坏数据，屏幕上该显示那个坏数，
 * 而不是被这个函数悄悄折成 0。
 */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const n = Math.round(value);
  // 先挑档位，再看舍入会不会把它顶到下一档（一次判完，不留"三档都不匹配"的缝）：
  // 999950 在 k 档是 999.95k，舍入成 1000.0k ⇒ 它该说成 1.0M。
  const picked = scaleIndexFor(n);
  if (picked < 0) return String(n); // 比 k 还小：原样印，不编单位
  const scaled = Math.round((n / SCALES[picked]!.from) * 10) / 10;
  // 舍入把这一档顶穿（999.95k → 1000.0k）就交给上一档，让它印成 1.0M
  const scale = Math.abs(scaled) >= 1000 && picked > 0 ? picked - 1 : picked;
  const final = Math.round((n / SCALES[scale]!.from) * 10) / 10;
  return `${compactDigits(final)}${SCALES[scale]!.suffix}`;
}

/** 量级落在哪一档（0=G 1=M 2=k）；**比 k 还小返回 -1**（= 这个数不印单位） */
function scaleIndexFor(value: number): number {
  for (let index = 0; index < SCALES.length; index += 1) {
    if (Math.abs(value) >= SCALES[index]!.from) return index;
  }
  return -1;
}

/**
 * 档内数字的字面写法：**两位数起不带小数位**（`10M` / `105M`），一位数时那一位留着（`1.0k`）。
 *
 * 注意"不带小数位"不等于"抹掉小数"：`999.9k` 的那个 .9 是真的量级差，抹掉就成了 `1000k`。
 */
function compactDigits(value: number): string {
  return Math.abs(value) >= 10 && Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * **原始精确值**：千分位分隔的整数。
 *
 * 为什么紧凑写法旁边必须有个说得出真数的地方：`2.7M` 与 `2,705,946` 差着 5946 个 token，
 * 而"这个月还剩多少""这次撞线超了多少"都要看真数。纪律与 CLI 的告警文案同一条
 *（`real-loop.ts` 的 `formatTokens`）：**只做展示，永不进事件、不进账**。
 */
export function formatExact(value: number): string {
  const n = Number.isFinite(value) ? Math.round(value) : 0;
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

/**
 * 界面/CLI 的一句话读法：`2.7M（2,705,946）`——紧凑写法与原始值**摆在一起**。
 *
 * 用户的要求逐字是「保留"原始精确值"在 tooltip 或括号里（别让人看不到真实数）」。
 * 这一对由**一个函数**给出，免得每个调用点各拼一次（拼法一分岔，就又回到"同一个数两种写法"）。
 *
 * 两截相同时只印一遍（`700`）：括号里再写一次 `700` 是噪音。**相等是按字面比**，
 * 不是按数值比——`1.0k` 与 `1,000` 数值相同而字面不同，两者都要印
 * （`1.0k` 说的是量级，`1,000` 说的是真数，人核对时看的是后者）。
 */
export function formatWithExact(value: number): string {
  const compact = formatCompact(value);
  const exact = formatExact(value);
  return compact === exact ? compact : `${compact}（${exact}）`;
}

/**
 * 服务端给界面的那些**字符串**（`web/server.ts` 的提示语、建议正文）里的 token 数走它：
 * 紧凑写法 + 原始精确值 + 口径词，一次说完。
 *
 * 服务端只管数字与口径，单位格式由本函数给——两边各写一套正是用户报的那个 bug。
 */
export function tokenPhrase(value: number, unit = '非缓存 token'): string {
  return `${formatWithExact(value)} ${unit}`;
}

/**
 * 一个 **0–1 的比例** → `27.3%`（一位小数，**唯一实现**）。
 *
 * 为什么放进本模块而不是各自拼一次：比例与 token 数是同一个毛病——同一个数在两处印成两种写法，
 * 人就得自己对齐；本仓库已经为 token 那一侧立过这条规矩（见 `formatWithExact` 的注释）。
 *
 * 三条边界：
 *   · **非有限数照实印**（与 `formatCompact` 同一条纪律：坏数据该显示成坏数，不许被折成 0%）；
 *   · **负数照实印**（`-1` 在本仓库是"算不出来"的哨兵，怎么读由调用方决定，格式化不做语义判断）；
 *   · **单位不在这里加**：要不要写成 `%`、要不要带"占比"两个字，由文案那侧决定。
 */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return String(ratio);
  return `${(ratio * 100).toFixed(1)}%`;
}
