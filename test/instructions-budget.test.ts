/**
 * `instructions` 段的预算是**硬门** — 与 `tools` 段同形（`test/tool-catalog.test.ts`）。
 *
 * ──────────────────────── 为什么要有这个文件（课题出处：我们自己的审计） ────────────────────────
 *
 * `tools` 段一直有一道硬门：`catalogTokens < 5500` 且**余量 ≥ 30**，超了有人会知道。
 * `instructions` 段（人格三层 + 装置自述）**一道门都没有**——它是请求里**唯一完全静态**的部分，
 * 也是**最大公共前缀**：它的字节一变，整个请求从头失配（缓存全 miss，那是按 token 计价的）。
 * 而"谁改自述都不显示一共动了多少 token"这件事已经发生过好几代：
 * v61 **+882**、v62 **+140**、v63 **+125**、v65 **−384**（逐代实测账见
 * `test/heartbeat-real-wake.test.ts` 的文件头，本节第 313–316 行那一篇）。
 * 没有门 ⇒ 涨的那几代**没有一次**在改动当场被看见，只能事后从事件日志里反推。
 * 这个文件把那条缝补上。
 *
 * ──────────────────────── 量的是"哪一份"（照 `tool-catalog.test.ts` 的纪律写明） ────────────────────────
 *
 * | 口径 | 怎么量 | 依赖 `data/persona/**` 吗 |
 * |---|---|---|
 * | **② 确定性分量**（本文件的**门**） | `INSTRUCTION_RULES.*` + `SELF_BRIEF` | **不依赖** |
 * | **① `renderInstructions` 整段**（本文件的**基线**） | 同上 + `loadPersona('data')` 的三层 | **依赖**（线上真值） |
 *
 * ⚠ **门为什么只落在②上**：`data/` 在 `.gitignore` 里（`git ls-files data/persona` = **0 个文件**）
 * ⇒ 一份新克隆、CI、或任何别人机器上，人格三层是**空的**。若把门压在①上，它在那些环境里
 * 必然红，而红的原因与"有人改胖了自述"毫无关系——那种门会被学会忽略，等于没有。
 * ⇒ **② 完全由仓库里的代码决定**，门压在这里对任何环境都成立；
 *   **① 照旧量、照旧写死在常量里**（它就是与线上 `budget/consumed.context.instructions`
 *   直接可比的那一个数），但它只在**本地人格在位**时参与断言（人格三层为空 ⇒ 跳过那一条，
 *   并把跳过的事实打出来，见下面第三条用例的注释）。
 *
 * ──────────────────────── 当前代的真值 — 大小落定于 v72（2026-10-20 实测）────────────────────────
 * （v72 之前那一代是 v65；v71 只做等长替换、两个 `hash` 于 2026-10-18 复量过一次。）
 *
 * **v72（2026-10-20，用户整段置换 `SELF_BRIEF`）——三组常量全部复量，判据一条没放宽**
 * （仍是"大小的硬门 + 逐字节 hash 精确比对 + 恒等式"，探针 `_research/_tmp-v72-readings.mts`）：
 *   · `SELF_BRIEF` **9226 → 9646 字符**（用户那份 .md 逐字，sha256 `b0d9fe2b…`；见 `self-brief.ts` 头）；
 *   · ② 自述段 **5462 / 24566 / `19ea2a8e6eaa5739` → 5717 / 25708 / `4f0b5d4acab5a779`**（+255 token）；
 *   · ② 确定性分量合计 **5496 → 5751**；
 *   · ① 整段 **6674 / 30138 / `7fa46e52ad55c504` → 6930 / 31280 / `ce5700d3f1b966a7`**（+256 token）；
 *   · 人格三层（差出来的那个口径）**1178 → 1179**：人格文件一个字没动，动的是取整
 *     （`6930 − 5751`；三层各自取整相加仍是 1213 ⇒ 1213 − 1179 = 34 的差没变）。
 *   **这一笔是用户自己的字变大，不是"某个机制长胖了"**：①/② 两条门的余量同时缩水
 *   （① 626 → 370、② 704 → 449），**② 那条"余量 ≥ 500"的读数断言因此在 449 上红了**——
 *   我没有自己把上界改大（判据不许放宽），见 `render.ts` 的 v72 那一篇与施工报告"等裁决"。
 *
 * **v74（2026-10-20，用户拍板）——② 那条"余量 ≥ 500"从硬门降为"只读数、不判红"**：
 *   · **上界 6300 不再作为限制**（`INSTRUCTIONS_HEADER_TOKEN_CEILING` 保留为**参考线**，
 *     由用户本人判断）；**①（7400 / 整段）那条原样是硬门**，只有②这一条放开。
 *   · **判据退回为读数**：每次跑这个文件都会 `console.log` 打印
 *     `SELF_BRIEF 确定性分量 / 上界 / 余量`（可见但不拦）。**这不是漏加断言**——用户 2026-10-20
 *     明确决定放开；**代价**：失去这道 tripwire 之后，自述膨胀只能靠"人看读数"发现 ⇒
 *     所以那行打印**是替代方案，不是可选项**。
 *   · v74 复量（2026-10-20，`SELF_BRIEF` 搬进 speak/report 的指导语后）：
 *     · ② 自述段 **5717 / 25708 / `4f0b5d4acab5a779` → 5712 / 25684 / `b051f01fa99ec325`**（−5 token）；
 *     · ② 确定性分量合计 **5751 → 5746**（余量 549 → **554**）；
 *     · ① 整段 **6930 / 31280 / `ce5700d3f1b966a7` → 6924 / 31256 / `bc11abd73654df5f`**（−6 token，余量 470 → **476**）；
 *     · 人格三层 **1179 → 1178**（= 6924 − 5746；人格文件一个字没动，动的是取整）。
 *     ⚠ 这一笔**不是**为了让谁变绿：搬家本身几乎不省 token（−6），**真正省的是回执**
 *     （4 行 → 5–12 字），见 `render.ts` 的 v74 那一篇与 `tools/admin.ts` 的回执三态。
 *
 * **v76（2026-10-21，`send_media` 的样板搬进 `SELF_BRIEF` §2.1）——② / ① 两条都复量（自述段 +128 / 合计 +127）**：
 *   · 缘起：审计 `_research/KV-AUDIT-2026-10-21.md` 的 P1——单条 `send_media` 成功回执
 *     **293–336 字符**（窗口均值 329）、历史窗口 129 条 ⇒ **42,470 字符 / 16,382 估算 token** 常驻；
 *     样板（"不必重复发送 / `read_channel` 的 `（我）` 行 / `·m<id>` 用来撤回"）**只该付一次**。
 *   · 读数（探针 `_tmp/kv-p1/instructions-readings.ts`，同一把 `estimateTokens`）：
 *     · ② 自述段 **5712 / 25684 / `b051f01fa99ec325` → 5840 / 26254 / `ff003fd6807f4047`**（+128）；
 *     · ② 确定性分量合计 **5746 → 5873**（余量 554 → **427**，参考线 6300 不变）；
 *     · ① 整段 **6924 / 31256 / `bc11abd73654df5f` → 7052 / 31826 / `d3738e093b9bf40a`**
 *       （+128；余量 476 → **348**，硬门 7400 不变）；
 *     · 人格三层 **1178 → 1179**（人格文件一个字没动；7052 − 5873 = 1179，差的是取整）。
 *   · 换来的是**常驻省 ≈10.1K 估算 token**（同一历史窗口 129 条回执：16,382 → 6,284），
 *     以及每笔新调用 **−78 估算 token** 的全价输入。这是"一次付 127、每次省 78"的买卖。
 *   · `SELF_BRIEF` 字符数 **9646 → 9913**（+267，一段；H2/H3/空行结构一个都没动，
 *     `test/self-brief.test.ts` 的结构锁照旧全绿）。`RENDER_VERSION` **75 → 76**。
 *
 * **v78（2026-10-22，关系档案改索引）——`SELF_BRIEF` 一个字节没动（读数回到 v76 那一组）**：
 *   · 缘起：用户「改为类同记忆索引吧」⇒ 固定块里关系档案只留索引（路径 / 字数 / 小节名），
 *     正文不进上下文。这一批只改 `input` 的固定块。
 *   · 中间有一笔**已撤回**：v78 首版曾给 `SELF_BRIEF` §6 那条 RELATIONSHIPS 补一句
 *     （"固定块里只给索引（路径与字数），正文要你自己 safe_read"，+17 token / +79 字节）。
 *     用户随后裁定「你这个提示词会导致反复读啊。不要给指令。」⇒ 那句话删掉，`instructions`
 *     逐字节回到 v76。
 *   · 读数（同一把 `estimateTokens` / `segmentOfText`，与下面三条用例同一个口径）：
 *     · ② 自述段 **5840 / 26254 / `ff003fd6807f4047`**（= v76，未变）；
 *     · ② 确定性分量合计 **5873**（余量 427；参考线 6300 不变）；
 *     · ① 整段 **7052 / 31826 / `d3738e093b9bf40a`**（余量 348，硬门 7400 不变）；
 *     · 人格三层 **1179**（人格文件一个字没动；7052 − 5873 = 1179）。
 *   · 换来的是**每轮少背一份档案正文**（只在 `input` 的固定块里）：阿岚那一段
 *     **1,181 → 166 字节**（−85.9%）、测试群 **2,586 → 133 字节**（−94.9%）。
 *   · `RENDER_VERSION` **77 → 78**（78 从未上生产；同代内改措辞不重复递增）。
 *
 * ⚠ **下面是 v65 那一代的读数，而它到 v68 仍然逐字成立**（件数与 token 从 v65 到 v68 没动过）：
 *   · **v66**（此刻层结构压缩 + 会话清单窗口 + `read_channel` 列会话簿）动的是 `input` 与
 *     `tools`，`instructions` 那一段一个字节没改（`render.ts` 的 v66 那一篇）；
 *   · **v67**（`read_channel` 的描述与行为对齐）只动 `tools` 段一处说明，`instructions` 同样零改动；
 *   · **v68**（思维链按帽回传）只动 `input` 的历史段与 `message/reasoning` 的可见性，
 *     `instructions` 同样零改动（`render.ts` 的 v68 那一篇）。
 *   ⇒ 本文件量的那一串（自述/分割线）**不随这三代变**，所以数值不重取——**这不是"没跟上"**，
 *   而是"这三代确实没碰这一段"（判据：`render.ts` 的 v66/v67/v68 三篇里逐条写明了变的是哪一段）。
 *
 * `RENDER_VERSION = '73'`（`src/model/render.ts` 顶部那个常量；v65 记这一篇时是 `'65'`；
 * v70 只动此刻层与一格观测字段、v71 只改 `SELF_BRIEF` 正文那 4 个字符——两代都**只动字节内容、
 * 不动长度**（v71 那 4 个字符是等长替换）⇒ 下面那些 `tokens` / `bytes` 照旧不重取。
 * **v72 是整段置换** ⇒ 一切重取，见下面那一段；**v73 只动 `input` 的历史段（思维链全量回传）
 * ⇒ `instructions` 这一段一个字节没改，下面的读数照旧**）。
 *
 * **2026-10-18 · 脱敏那一笔（`cdc6b92`）之后复量了 hash（`tokens` / `bytes` 一个数没动）**：
 *   · `HEADER_BRIEF.hash` `568c4e9283766245` → **`19ea2a8e6eaa5739`**；
 *   · `FULL_INSTRUCTIONS.hash` `44b45472504fa2ec` → **`7fa46e52ad55c504`**。
 *   成因与 `test/heartbeat-real-wake.test.ts` 文件头 2026-10-18 那一篇**同一条**：那一笔把
 *   `SELF_BRIEF` 正文里那段 4 位尾号换成了占位值，**旧 4 位 → 新 4 位长度不变**
 *   （`SELF_BRIEF` 整段 9226 → 9226 字符）⇒ 两个 `tokens` / `bytes` 都不该动（实测也没动），
 *   动的只有字节内容。**判据没放宽**：仍是大小的硬门 + 逐字节 hash 精确比对；
 *   探针 `_research/_tmp-sanitize-instructions-delta.mts` 用 `f014811` 的旧字节复现了旧的两个 hash
 *   （`5462 / 24566 / 568c4e9283766245`），⇒ 位移就那一处。
 *   ⚠ `RENDER_VERSION` 在那一笔里**没递**（仍是 `70`）——**该不该递已经裁了：递 `71`**，落在
 *   下一笔（`render.ts` 的 v71 那一篇）。理由正是本文件量的这一条：`tokens` / `bytes` 一个数没动
 *   而**字节真的变了** ⇒ 只递版本号，`replay` 的三指纹才不会把"字节不同"报成"同一代"。
 *
 * **② 确定性分量**（本文件的**门**，与 `data/` 无关，任何环境都复算得出同一组数）：
 *   · 四条分割线常量（`INSTRUCTION_RULES` identity/constitution/style/brief 按 `\n\n` 相连）：
 *     **44 token / 378 字节 / hash `bbe1674eb8a77743`**
 *   · 自述那一段（`INSTRUCTION_RULES.brief` + `\n\n` + `SELF_BRIEF`）：
 *     **5717 token / 25708 字节 / hash `4f0b5d4acab5a779`**（v72 于 2026-10-20 复量，见上面那一篇）
 *   · 两者相加 = **5751 token**（**四条规则行 + 自述**；这是②那条门的读数）
 *   · ⚠ **人格三层全空时 `renderInstructions` 的输出不是上面那一串**：
 *     它会**先过滤掉空块**（`render.ts:2140` 的 `.filter`）⇒ 人格那三条分割线一起消失，
 *     只剩 `INSTRUCTION_RULES.brief` + `\n\n` + `SELF_BRIEF` = **5717 token / 25708 字节 /
 *     hash `4f0b5d4acab5a779`**（即与上面"自述那一段"同一串，已实测 `===`）。
 *     ⚠⚠ **这两个不同的串恰好给出同一组 tokens/bytes/hash**（44 那一笔与 5462 那一笔的取整
 *     巧合碰撞，长度其实差 105 字符）⇒ **任何判据都不许拿 token 数当"这两个串相等"的替身**
 *     （本文件第四条用例末尾记了这次差点栽进去的经过）。
 *
 * **① `renderInstructions` 整段**（含**本机**人格三层；线上同一口径的真值）：
 *   · **6930 token / 31280 字节 / hash `ce5700d3f1b966a7`**（v72 于 2026-10-20 复量）
 *   · ⚠ **人格三层那一笔有两个口径，别混**（两个数只差 1，全是取整，不是账不平）：
 *     · **1179** = ① 整段 **减** ② 确定性分量合计（`6930 − 5751`）——**这是本文件用的那个**
 *       （常量 `PERSONA_LAYERS_TOKENS` 就是这条减法推导出来的）；
 *     · **1178** = 三层**各自取整后相加**（2026-10-20 实测：`identity` 588 + `constitution` 391
 *       ＋ `style` 199，探针 `_research/_tmp-v72-readings.mts`）。
 *     ⚠ 别再拿"逐段相加必然更大"当规律：v65 那一代记的是 1212 > 1178（那时人格文件的读数不同），
 *     这一代反过来（1179 > 1178）——差别来自四条分割线、三段分隔换行与人格正文各自的 `ceil`。
 *     要跟"① 整段"对账就用 1179；要报"人格三层本身多重"就用 1178。本文件的断言一律走前者。
 *
 * ⚠⚠ **别抄线上那个 hash**：线上此刻（未部署 v65）跑的是 **v64**，
 *   `budget/consumed.context.instructions` 里是 `{ tokens: 7058, bytes: 31822, hash: '2f75ea4aef859556' }`。
 *   **那是 v64 的值，不是本文件量到的 v65**——两回事。本文件量的是**工作树里 v65 之后**的值。
 *   两代的关系已实测（同一份人格、同一把尺，`git show 87b130d~1:src/model/self-brief.ts` 抽旧常量）：
 *     v64 `7058 / 31822 / 2f75ea4aef859556` → v65 `6674 / 30138 / 44b45472504fa2ec`
 *     ⇒ 净 **−384 token / −1684 字节**（与 `heartbeat-real-wake.test.ts` 记的 −384 逐字吻合）。
 *     （v65 那个 hash 后来被脱敏那一笔换掉了，当前值见上面"① 整段"那一行：`7fa46e52ad55c504`。）
 *   探针（2026-10-23 从归档搬回仓库）：`tools/measure/instructions-truth.mts`（量当前代）、
 *         `tools/measure/v65-vs-v64-delta.mts`（两代对照，不 checkout、不动工作区）。
 *
 * ──────────────────────── 上界取值与依据 ────────────────────────
 *
 * **`INSTRUCTIONS_TOKEN_CEILING = 7400`**（对①整段；当前 **6930** ⇒ **余量 470**，v72 之前是 626）。
 * 依据是**同一份文件里那串逐代实测位移**（`heartbeat-real-wake.test.ts` 文件头）：
 *   · 一轮**局部措辞**改动实测 **+116 / +125 / +140 token**（v56 分割线 / v63 / v62）；
 *   · 一次**整段置换**实测 **+882 token**（v61 用户手写稿逐字置换）；
 *   · 本代（v65）是**大改**，仍然是 **−384**（大改的方向不必然是涨）；
 *   · v72 又是一次**整段置换**：**+256 token**（用户的新稿，见上面那一篇）。
 * ⇒ 取"当前值 +10% 上下"这一档：470 ⇒ **够 3 轮局部措辞**，不够一次整段置换。
 *   **判据是"下一次大改之前必须有人看一眼"**，不是"不许改"。
 * 涨过这条线**不是"改大这个数"就完事**：先按文件头那两条探针复测、把①的真值改准，
 * 再决定要不要接受这笔常驻开销（同 `tools` 那条门的纪律：两处必须一起动）。
 *
 * **`INSTRUCTIONS_HEADER_TOKEN_CEILING = 6300`**（对②确定性分量；当前 **5751** ⇒ **余量 549**，
 * v72 之前是 704）。
 * **v72（2026-10-20，用户裁决"裁 A"）**：两条上界**各 +100**（`7300 → 7400`、`6200 → 6300`），
 * 因为用户这一批把自述整段置换（② 5496 → **5751**，+255）⇒ 按旧线余量只剩 449 < 500。
 * **判据一个字没放宽**：仍是"余量 ≥ 500"（现在 549）、两条上界的**间距照旧是 1100**
 * （`7300 − 6200 = 7400 − 6300`）⇒ 两者在"自述还能长多少"这件事上仍然同步。**这是移动 tripwire，
 * 不是改判据**；tripwire 各外推 100 **是本批付的代价**。
 * ⇒ **若将来再涨，优先做的是"缩自述"，不是再抬上界。**
 * 它比①那条**宽 78 token**是**故意的**：②里没有"人格三层"可腾挪（人格是用户自己的资产），
 * 而①那条隐含地吃到了人格三层 ⇒ 两条线在"自述还能长多少"这件事上口径要接近，
 * 否则会出现"②还绿、①已红"这种让人以为门坏了的组合。两条线同时红 = 自述该瘦身了。
 *
 * ──────────────────────── 改代的规矩（照 `heartbeat-real-wake.test.ts` 的指纹写法） ────────────────────────
 *
 * **改 `SELF_BRIEF`（或四条分割线常量）⇒ 必须同批复量本文件下面三组常量**，
 * 否则第三条用例当场红在"基线常量与当前代不一致"上——那正是它的用途。
 * 复量方式：跑文件头记的那两条探针（**2026-10-23 起它们就在仓库里**：
 * `tools/measure/instructions-truth.mts` 量当前代、
 * `tools/measure/v65-vs-v64-delta.mts` 做两代对照，不 checkout、不动工作区），
 * 把打出来的数逐字抄进常量，并**在下面注明是哪一代**。
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { segmentOfText } from '../src/model/context-audit.ts';
import { INSTRUCTION_RULES, renderInstructions } from '../src/model/render.ts';
import { SELF_BRIEF } from '../src/model/self-brief.ts';
import { loadPersona } from '../src/persona/loader.ts';
import { estimateTokens } from '../src/tools/registry.ts';

// ──────────────────────────────── 上界（门） ────────────────────────────────

/**
 * 门：① `renderInstructions` 整段的 token 上界。依据见文件头「上界取值与依据」。
 * v72：`7300 → 7400`——**移动 tripwire，不是改判据**（用户自述段 +255 token 是既定事实，见文件头）。
 */
const INSTRUCTIONS_TOKEN_CEILING = 7400;
/**
 * 门：② 确定性分量（四条规则行 + 自述段）的 token 上界。依据见文件头。
 * v72：`6200 → 6300`——与 ① 同步 +100，保住"② 比 ① 宽 78"那条刻意关系；
 * **"余量 ≥ 500"那条判据一个字没动**（现在 6300 − 5751 = 549 ≥ 500）。
 */
const INSTRUCTIONS_HEADER_TOKEN_CEILING = 6300;
/** 与 `tools` 同形的"当前值 vs 上界"读数常量：`tool-catalog.test.ts` 的上界是 5500 */
const TOOLS_TOKEN_CEILING = 5500;

// ──────────────────────────────── 基线（改代即复量） ────────────────────────────────
//
// `tokens` / `bytes` 是**当前代（v65）**的读数（至今没动过）；两个 `hash` 于 2026-10-18
// 因脱敏那一笔（`cdc6b92`）复量——长度没变、内容变了，见文件头那一段。
// ⚠ 注释里的"线上值"是**v64**，别混（见文件头）。

/** v76 · ② 四条分割线常量按 `\n\n` 相连（不依赖 `data/`）——v78 没碰它，未复量 */
const HEADER_RULES = { tokens: 44, bytes: 378, hash: 'bbe1674eb8a77743' } as const;
/**
 * v78 · ② 自述那一段（不依赖 `data/`）：v72 整段置换之后是 5712 / 25684 / `b051f01fa99ec325`；
 * v76 加了一段回执说明 ⇒ 5840 / 26254 / `ff003fd6807f4047`。
 * **v78 没碰 `SELF_BRIEF`**（首版补的那一句"正文要你自己 safe_read"已撤回——它也是"给指令"）
 * ⇒ 读数就是 v76 那一组，未复量、也不许改。
 */
const HEADER_BRIEF = { tokens: 5840, bytes: 26254, hash: 'ff003fd6807f4047' } as const;
/** v76 · ② 确定性分量合计（= 人格全空时 `renderInstructions` 的逐字节输出）：5873 */
const HEADER_TOTAL_TOKENS = 5873;
/**
 * v76 · ① `renderInstructions` 整段（含**本机**人格三层）。
 * ⚠ 线上此刻（未部署 v78）跑的是旧一代，别抄线上那个 hash（见文件头）。
 * ⚠ hash 只认字节内容：`tokens` / `bytes` 相同**不**代表这一串没变（v71 那 4 个字符就是这种形状）。
 * v78 没碰 `instructions` ⇒ 仍是 v76 的 **7052 / 31826 / `d3738e093b9bf40a`**。
 */
const FULL_INSTRUCTIONS = { tokens: 7052, bytes: 31826, hash: 'd3738e093b9bf40a' } as const;
/**
 * v76 · ① 里人格三层占的 token。口径 = **① 整段 − ② 确定性分量合计**（`7052 − 5874 = 1178`）。
 * ⚠ **显式字面量、不许写成 `FULL_INSTRUCTIONS.tokens - HEADER_BRIEF.tokens`**：
 * 那样写会把它变成 1212（减错了被减数——`HEADER_BRIEF` 是"自述段"，不是"确定性分量"），
 * 于是这条恒等式**永远不会红**、也就永远发现不了"忘了复量"。见文件头那个 ⚠ 的两个口径。
 * ⚠ v72 从 1178 变成 1179 是**取整**（人格三层一个字没动，两个量各自的 ceil 撞在一起），不是人格变了；
 * v76 复量回到 1178（同一份人格、同一次自述增长之后的取整结果）。
 */
const PERSONA_LAYERS_TOKENS = 1179;

// ──────────────────────────────── 量 ────────────────────────────────

const DATA_DIR = 'data';

/** ② 确定性分量：四条规则行 — 完全由代码决定，任何环境同一组数 */
function rulesText(): string {
  return [
    INSTRUCTION_RULES.identity,
    INSTRUCTION_RULES.constitution,
    INSTRUCTION_RULES.style,
    INSTRUCTION_RULES.brief,
  ].join('\n\n');
}

/** ② 确定性分量：自述那一段（带它自己那条分割线） */
function briefText(): string {
  return `${INSTRUCTION_RULES.brief}\n\n${SELF_BRIEF}`;
}

/** ② 确定性分量合计 */
function headerText(): string {
  return `${rulesText()}\n\n${SELF_BRIEF}`;
}

/** 读本机人格（缺 `data/` 时是空串，不是错误——`loadPersona` 对缺失文件返回 `''`） */
function personaOnDisk() {
  return loadPersona(resolve(DATA_DIR));
}

/**
 * 报错文案的形状：**现在 / 上界 / 超出** 三个数都要在（课题的硬要求：让下一个人当场判断）。
 * `over > 0` 才该被调用；`over <= 0` 时不产生误导性的负值。
 */
function overBudgetMessage(label: string, now: number, ceiling: number): string {
  return `${label}现在 ${now} token、上界 ${ceiling}、超出 ${now - ceiling}`
    + `（余量 ${ceiling - now > 0 ? ceiling - now : 0}）`
    + '：这一段是**最大公共前缀**，改胖了每一轮请求都多付一份，而且它一变整段前缀失配'
    + '（缓存全 miss）。'
    + '⇒ 别直接把这个上界改大：先用 `tools/measure/instructions-truth.mts` 复测当前真值，'
    + '把 `test/instructions-budget.test.ts` 文件头与常量改准，再决定要不要接受这笔常驻开销';
}

// ──────────────────────────────── ① 门：确定性分量不许越界 ────────────────────────────────

test('instructions 预算：装置自述（确定性分量）不许越上界 —— 它会静默地让每一轮变贵', () => {
  // 为什么先落这一条：它是**唯一与 `data/` 无关**的判据（文件头「量的是哪一份」那张表）
  // ⇒ 在空人格、CI、别人机器上都给出同一个答案，红了一定是"有人改胖了自述/规则行"。
  const now = estimateTokens(headerText());
  assert.ok(
    now < INSTRUCTIONS_HEADER_TOKEN_CEILING,
    overBudgetMessage('装置自述（确定性分量）', now, INSTRUCTIONS_HEADER_TOKEN_CEILING),
  );
  // 读数常量：**余量 ≥500 从硬门改成"只读数、不判红"**（用户 2026-10-20 决定，由他本人判断）。
  //
  // ⚠ 这不是漏加断言（**写清楚，否则以后有人会以为这是漏的**）：`6300` / `7400` 仍是"参考线"，
  // ①（整段）那条 `now < INSTRUCTIONS_TOKEN_CEILING` 照旧是硬门；放开的是②这条**余量**判据。
  // 代价：失去这道 tripwire 之后，自述膨胀只能靠"人看读数"发现 ⇒ 所以下面**必须打印**
  // （`console.log` 每次都出现，替代"红了才知道"）。
  const margin = INSTRUCTIONS_HEADER_TOKEN_CEILING - now;
  console.log(
    `[instructions] SELF_BRIEF 确定性分量 ${now} token / 上界 ${INSTRUCTIONS_HEADER_TOKEN_CEILING}`
    + ` / 余量 ${margin}（① 整段上界 ${INSTRUCTIONS_TOKEN_CEILING}）`,
  );
  assert.ok(margin > 0,
    `确定性分量 ${now} 已经**越过**参考线上界 ${INSTRUCTIONS_HEADER_TOKEN_CEILING}——`
    + '上界不再是硬门（用户 2026-10-20），但越过参考线必须有人看一眼这份读数',
  );
});

test('instructions 预算：工具的当前值与上界在同一份报告里可读（与 tool-catalog 同形）', () => {
  // 这一条**不重复** tool-catalog 的门（那边是权威）：它只把"两条预算线各自的当前值"
  // 放在同一个文件里，让下一个人一次读全，不必在两个文件之间对账。
  // 口径：`tools` 那一侧的权威门是 `tool-catalog.test.ts` 的 `catalogTokens`（**代码口径**）。
  const toolTotal = 5323;              // v74 工作树实测（代码口径；权威值在 tool-catalog.test.ts 文件头）
  const toolCount = 22;                // 同上（运行期口径是 23 件，多一件 mcp）
  assert.ok(
    toolTotal < TOOLS_TOKEN_CEILING,
    `常驻工具说明 ${toolTotal} token、上界 ${TOOLS_TOKEN_CEILING}、超出 ${toolTotal - TOOLS_TOKEN_CEILING}`
    + '——权威门在 test/tool-catalog.test.ts，这里只是把两条线并排写出来',
  );
  assert.equal(toolCount, 22, `代码口径件数变了（v65：22 件 = 运行期 23 件 − mcp）：${toolCount}`);
  assert.equal(INSTRUCTIONS_TOKEN_CEILING, 7400,
    '上界常量被改动过：改它必须同批改文件头那一段依据（v72 是用户裁的"两条同步 +100"）');
});

// ──────────────────────────────── ② 基线：确定性分量与当前代逐字一致 ────────────────────────────────

test('instructions 基线：确定性分量与"当前代"逐字一致（改了自述却忘了复量 ⇒ 当场红）', () => {
  // 这一条就是课题要的"改了自述却忘了复量基线 ⇒ 用例当场红"。
  // 它量的是②（不含人格）⇒ 与数据目录无关，复算必然可重复。
  const rules = segmentOfText(rulesText());
  const brief = segmentOfText(briefText());

  assert.equal(
    rules.tokens,
    HEADER_RULES.tokens,
    `四条分割线常量的 token 变了：现在 ${rules.tokens}、基线 ${HEADER_RULES.tokens}`
    + `、差 ${rules.tokens - HEADER_RULES.tokens}`,
  );
  assert.equal(rules.bytes, HEADER_RULES.bytes, `四条分割线常量的 bytes：现在 ${rules.bytes}、基线 ${HEADER_RULES.bytes}`);
  assert.equal(rules.hash, HEADER_RULES.hash, `四条分割线常量的 hash：现在 ${rules.hash}、基线 ${HEADER_RULES.hash}`);

  assert.equal(
    brief.tokens,
    HEADER_BRIEF.tokens,
    `装置自述那一段的 token 变了：现在 ${brief.tokens}、基线 ${HEADER_BRIEF.tokens}`
    + `、差 ${brief.tokens - HEADER_BRIEF.tokens > 0 ? '+' : ''}${brief.tokens - HEADER_BRIEF.tokens}`
    + '——改了自述就要同批复量本文件的基线常量（文件头「改代的规矩」）',
  );
  assert.equal(brief.bytes, HEADER_BRIEF.bytes, `装置自述段的 bytes：现在 ${brief.bytes}、基线 ${HEADER_BRIEF.bytes}`);
  assert.equal(brief.hash, HEADER_BRIEF.hash, `装置自述段的 hash：现在 ${brief.hash}、基线 ${HEADER_BRIEF.hash}`);

  const header = estimateTokens(headerText());
  assert.equal(
    header,
    HEADER_TOTAL_TOKENS,
    `确定性分量合计：现在 ${header}、基线 ${HEADER_TOTAL_TOKENS}、差 ${header - HEADER_TOTAL_TOKENS}`,
  );
  // 分割线常量本身也在基线里：单改一条线（比如把标签换个词）也要被看见
  assert.deepEqual(
    Object.values(INSTRUCTION_RULES),
    ['────────────【人格 · 身份】────────────', '────────────【人格 · 宪法】────────────',
      '────────────【人格 · 风格】────────────', '────────────【装置自述】────────────'],
    '四条分割线的逐字内容变了（它们进冻结前缀 ⇒ 要同批递增 RENDER_VERSION）',
  );
});

test('instructions 基线：① 整段与本机人格下的当前代一致（人格为空则只判退化形状）', () => {
  // ① 是**与线上事件日志直接可比**的那一个数（`budget/consumed.context.instructions`）。
  // 但它含本机人格三层 ⇒ 在 `data/persona/**` 为空的环境里它不含人格，
  // 拿它去比①的常量会红在一个**与改动无关**的理由上（文件头「量的是哪一份」）。
  // ⇒ 人格为空 ⇒ **只判"① 退化成什么形状"**；人格在位 ⇒ **精确比对**（这才是线上那个数）。
  const persona = personaOnDisk();
  const full = segmentOfText(renderInstructions(persona));
  const header = estimateTokens(headerText());

  if (persona.identity === '' && persona.constitution === '' && persona.style === '') {
    // ⚠ **判据必须是"人格三层为空"本身，不能拿 token 数当替身**（这里差点栽进去，留记录）：
    // `renderInstructions` 会**先过滤掉空块**（`render.ts:2140` 的 `.filter`）⇒ 人格全空时
    // 输出里**没有**那三条人格分割线，只剩 `INSTRUCTION_RULES.brief` 那一条。
    // 而"四条规则行 + 自述"与"一条规则行 + 自述"**长度差 105 字符，却恰好给出同一组
    // `tokens/bytes/hash`**（44 与 5462 这两笔取整的巧合碰撞）⇒ 用 `full.tokens === header`
    // 当分支条件会被这个碰撞蒙过、把"少三条分割线"当成"逐字节相等"。
    // 所以下面直接按**空块过滤后的形状**判：只该剩【装置自述】那一条。
    assert.equal(
      renderInstructions(persona),
      `${INSTRUCTION_RULES.brief}\n\n${SELF_BRIEF}`,
      '空人格时 ① 只该剩【装置自述】那一条分割线（人格那三条要跟着空块一起被过滤掉，'
      + '否则会留下三根悬空的横线——render.ts:2131 那条纪律）',
    );
    assert.ok(
      full.tokens < INSTRUCTIONS_TOKEN_CEILING,
      overBudgetMessage('instructions 整段（空人格）', full.tokens, INSTRUCTIONS_TOKEN_CEILING),
    );
    return;
  }

  assert.equal(
    full.tokens,
    FULL_INSTRUCTIONS.tokens,
    `① instructions 整段的 token 变了：现在 ${full.tokens}、基线 ${FULL_INSTRUCTIONS.tokens}`
    + `、差 ${full.tokens - FULL_INSTRUCTIONS.tokens > 0 ? '+' : ''}${full.tokens - FULL_INSTRUCTIONS.tokens}`
    + `——若是改了自述/规则行，同批复量本文件基线；若是人格三层变了，复量 PERSONA_LAYERS_TOKENS（现在 ${PERSONA_LAYERS_TOKENS}）`,
  );
  assert.equal(full.bytes, FULL_INSTRUCTIONS.bytes, `① 整段的 bytes：现在 ${full.bytes}、基线 ${FULL_INSTRUCTIONS.bytes}`);
  assert.equal(full.hash, FULL_INSTRUCTIONS.hash, `① 整段的 hash：现在 ${full.hash}、基线 ${FULL_INSTRUCTIONS.hash}`);

  // 门的另一面：① 整段也在自己的上界之内（②那条门 + 人格三层）
  assert.ok(
    full.tokens < INSTRUCTIONS_TOKEN_CEILING,
    overBudgetMessage('instructions 整段', full.tokens, INSTRUCTIONS_TOKEN_CEILING),
  );
  // 人格三层那一笔单独记一笔：它涨了也是每轮都付，而它不在②那条门的视野里。
  // 判据是**恒等式**（① 整段 − ② 自述段 = 人格三层），不是"人格不许变"——
  // 人格是用户自己的资产，他改了就该看到这个数动，而不是被一条门拦住。
  assert.equal(
    full.tokens - header,
    PERSONA_LAYERS_TOKENS,
    `人格三层占的 token 变了：现在 ${full.tokens - header}、基线 ${PERSONA_LAYERS_TOKENS}`
    + `（= ① ${full.tokens} − ② ${header}；口径见文件头那个 ⚠，别拿逐段相加的 1212 来对）`
    + '——人格是用户自己的资产，这一条只记事实、不拦内容',
  );
});

// ──────────────────────────────── ③ 反向验证：过界会被拦，且报错文案含三个数 ────────────────────────────────

test('instructions 预算：把人格撑到过界 ⇒ 门必须报错，文案含"现在/上界/超出"三个数', () => {
  // 为什么用**人格**来造过界、而不是改自述常量：`SELF_BRIEF` 是用户原文（不许碰），
  // 而 `renderInstructions` 是纯函数、吃的是入参 ⇒ 喂一个超大人格就能在**不改任何常量、
  // 不改任何 src** 的前提下把①那条门顶穿。这是"门真的会拦"的可执行证明。
  const huge = '这是一段用于验证预算门的人造人格正文。'.repeat(4000);   // 远超上界
  const blown = renderInstructions({ identity: huge, constitution: '', style: '', state: '' });
  const now = estimateTokens(blown);

  assert.ok(
    now > INSTRUCTIONS_TOKEN_CEILING,
    `夹具没能把①顶过上界（现在 ${now}、上界 ${INSTRUCTIONS_TOKEN_CEILING}）——夹具太小，这条反向验证就没意义了`,
  );

  // 与生产同一条断言、同一个报错函数：过界 ⇒ `assert.ok` 必须抛出
  assert.throws(
    () => assert.ok(now < INSTRUCTIONS_TOKEN_CEILING, overBudgetMessage('instructions 整段', now, INSTRUCTIONS_TOKEN_CEILING)),
    (err: unknown) => {
      const text = err instanceof Error ? err.message : String(err);
      // 三个数一个不许少（课题的硬要求：失败时要说清"现在是 X、上界 Y、超了 Z"）
      assert.match(text, /现在 \d+ token/u, `报错文案缺"现在 X"：${text}`);
      assert.match(text, /上界 \d+/u, `报错文案缺"上界 Y"：${text}`);
      assert.match(text, /超出 \d+/u, `报错文案缺"超出 Z"：${text}`);
      assert.match(text, new RegExp(`现在 ${now} token、上界 ${INSTRUCTIONS_TOKEN_CEILING}、超出 ${now - INSTRUCTIONS_TOKEN_CEILING}`, 'u'),
        `报错文案里的三个数与实测不符：${text}`);
      return true;
    },
  );

  // 不越界则绿：同一函数喂一份"刚好在界内"的人格，断言不抛
  const ok = renderInstructions({ identity: '一小段人格。', constitution: '', style: '', state: '' });
  const okTokens = estimateTokens(ok);
  assert.ok(okTokens < INSTRUCTIONS_TOKEN_CEILING);
  assert.doesNotThrow(
    () => assert.ok(okTokens < INSTRUCTIONS_TOKEN_CEILING, overBudgetMessage('instructions 整段', okTokens, INSTRUCTIONS_TOKEN_CEILING)),
  );
});

test('instructions 预算：撑过界的是**确定性分量**时同样被拦（②那条门也会说话）', () => {
  // ②那条门守的是"自述/规则行自己长胖"。它的输入是常量 ⇒ 用一个**替身自述**证明同一条断言会拦，
  // 而不是只证明①那一条会拦。
  const stubBrief = '这一句是用来把确定性分量顶过上界的替身自述。'.repeat(3000);
  const now = estimateTokens(`${rulesText()}\n\n${stubBrief}`);
  assert.ok(
    now > INSTRUCTIONS_HEADER_TOKEN_CEILING,
    `夹具没能把②顶过上界（现在 ${now}、上界 ${INSTRUCTIONS_HEADER_TOKEN_CEILING}）`,
  );
  assert.throws(
    () => assert.ok(now < INSTRUCTIONS_HEADER_TOKEN_CEILING,
      overBudgetMessage('装置自述（确定性分量）', now, INSTRUCTIONS_HEADER_TOKEN_CEILING)),
    (err: unknown) => {
      const text = err instanceof Error ? err.message : String(err);
      assert.match(text, /现在 \d+ token、上界 \d+、超出 \d+/u, `文案形状不对：${text}`);
      return true;
    },
  );
  // 与 `tools` 同形的对照：同一套文案函数对工具那一段也给同样三个数
  const toolText = overBudgetMessage('常驻工具说明', 5500 + 17, TOOLS_TOKEN_CEILING);
  assert.match(toolText, /现在 5517 token、上界 5500、超出 17/u, '两条预算线的文案形状必须同形');
});

test('instructions 预算：探针文件在位（下一个人要知道去哪儿复量）', {
  // `tools/measure/` **不进公开副本**（内部度量工具，见 tools/publish-oss.mjs 的排除表）：
  // 公开副本里这两个文件本来就不在 ⇒ 没有前提可判，跳过。仓库侧照旧是一条硬门。
  skip: existsSync(resolve(join('tools', 'measure')))
    ? false
    : '公开副本里没有 tools/measure/（内部度量探针不外发）—— 这条判据只在仓库侧跑',
}, () => {
  // 基线复量靠探针，探针被删掉的话"改代即复量"这条规矩就落不了地 ⇒ 这里钉一下它的存在。
  // 只判存在、不读内容：这两个文件是**工具**，它们的正文不参与任何判据。
  //
  // 2026-10-23 这笔的来历（别再把它们移出去）：`_research/` 整个搬出仓库时，这条用例连同
  // 它的前提一起被删过——**代价是"改代即复量"在仓库内没有可跑的入口了**（当时只如实写下了代价）。
  // 现在两个探针从归档搬回了 `tools/measure/`（去掉 `_tmp-` 前缀），这条用例随之**恢复**，
  // 路径改到新位置。仓库里有工具、有判据，才叫规矩落地；只写"该复量"而没入口，等于没有规矩。
  const probes = [
    join('tools', 'measure', 'instructions-truth.mts'),
    join('tools', 'measure', 'v65-vs-v64-delta.mts'),
  ];
  for (const probe of probes) {
    assert.ok(
      existsSync(resolve(probe)),
      `探针不见了：${probe}——文件头「改代的规矩」指的复量入口就是它`,
    );
  }
});
