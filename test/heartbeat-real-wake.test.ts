/**
 * 心跳"真实唤醒"的判据（2026-10-05 用户改口径；docs/design.md §4.11 / §4.12）
 *
 * 用户原话（逐字）：
 *
 * > 「我告诉你一个为什么我要设置心跳是真实唤醒：**唤醒一次的花费远少于缓存前缀被供方回收的花费**。
 * > 心跳真实唤醒也可以**维护供方处的 KV cache**。」
 *
 * 本次要拆开的是**两件事**：调模型（每一拍都要做）与开不开口（她自己在 turn 里定）。
 * 改之前它们是一件事——回复必要性门在**调模型之前**就判"空转"，于是心跳一拍一个请求都不发
 * （实测全库 52 次心跳走了模型的 0 次），供方那边的 KV 前缀一次都没被刷新。
 * **那道门 2026-10-05 已拆**（原意、为什么废与"别再把它接回心跳拍"的警告见 docs/design.md
 * 「试过并废掉的口径：回复必要性门」）——本文件是那条口径的生产级判据。
 *
 * 覆盖：
 *   ① 纯心跳拍**必须发生一次模型调用**（heavy 车道），并落 `budget/consumed{lane:'heavy'}`
 *   ② 非心跳拍**与改动前逐字节一致**（事件序列 + 剥掉此刻层后的请求指纹；基线在改动前捕获）
 *   ③ "调模型"与"开不开口"解耦：她整拍不说话（`spoke:false`），调用照样发生；唤醒提示一字未改
 *   ④ 可审计：`memory/selected{injection:'heartbeat'}` + `step/start` + `budget/consumed` 同现，
 *      且顺序落定（不新增事件类型，复用既有的 `isHeartbeatTurn` 派生字段）
 *   ⑤ 同一份冻结前缀：心跳拍与普通回合共用同一份 `instructions`（人格常驻层）与同一份工具清单
 *
 * 台子见 `test/fixtures/real-wake-rig.ts`：真 RealLoop + 真 agent-loop + 真折叠，只有模型是假的。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AppEvent } from '../src/log/types.ts';
import { defaultVisibility } from '../src/log/types.ts';
import type { DsRequest } from '../src/model/ds-client.ts';
import { heartbeatData, makeRealWakeRig, requestFingerprint, type RealWakeRig } from './fixtures/real-wake-rig.ts';

// ──────────────────────────────── 改动前的基线 ────────────────────────────────

/*
 * 基线的取法：`node --experimental-strip-types _research/heartbeat-real-wake-baseline.mjs`
 * 在本改动**之前**的代码上跑（脚本用的就是同一个台子与同一个指纹函数）。改动之后复跑，
 * 非心跳拍的两组值必须一字不变——这正是"非心跳拍行为与改动前逐字节一致"的证据。
 *
 * 指纹口径（`requestFingerprint`）：`instructions` + 工具名 + `input` 里**剥掉此刻层**的 items。
 * 剥此刻层是因为它含本机事实（磁盘剩余空间、临时工作根路径）——那是环境噪声，不是行为差异。
 *
 * **2026-10-06 重取（v34 数字资产）**：这条基线**有意**动了一次，不是回归。
 * 装置自述补了第⑰段（数字资产那一段），而它在 `instructions` 里——指纹的两个数因此变了
 * （取数过程见 `test/digital-assets.test.ts` 头部与当次报告）：
 *   非心跳拍 `9550a4c44b930e6a` → `6d5a885df211d254`（第一版第⑰段）→ `b7e64cc98a495ef7`（收窄口径后）
 *   混批     `d8ba95e5f40b7516` → `06622e27744d004b` → `8a98d32a8775d2ae`
 * 重取的证据是**做了一次对照实验**：把 self-brief 那一处改动临时撤掉、其余改动全部保留，
 * 复跑基线脚本得到的就是上面那两个旧值 ⇒ 除那个指令段之外**没有任何别的字节变化**
 * （事件序列两条也都一字未动，见下面的断言；light 调用仍是 0 次——`assets.md` 不存在，
 * 那一次选取在发请求之前就返回了）。
 * 这次改动同时把 `RENDER_VERSION` 递增到 34：instructions 是冻结前缀，改它=接受一次缓存全 miss
 * （设计如此，代价已记在 docs/digital-assets.md 与当次报告里）。
 *
 * **2026-10-07 重取（v37 第 ④ 段不再讲平台的主动/被动与配额）**：这条基线**有意**又动了一次。
 * 自述第 ④ 段末尾那半句「发给本轮叫你说话之外的人会走主动消息，QQ 那边有配额」被删掉、
 * 换成与 `to` 语义同源的行为准则（"`to` 是指向某个人用的，不是广播开关"）——它在 `instructions`
 * 里，所以指纹的两个数变了：
 *   非心跳拍 `b7e64cc98a495ef7` → `6ef643eb0f3a7783`
 *   混批     `8a98d32a8775d2ae` → `50b74c932f47e69a`
 * 重取的证据同样是**对照实验**：把 self-brief 那一处改动临时撤回（原文恢复）、其余改动全部保留，
 * 复跑 `_research/heartbeat-real-wake-baseline.mjs` 得到的就是上面那两个旧值 ⇒ **除那一句之外
 * 没有任何别的字节变化**；同时两条断言里的事件类型序列**一个字都没动**（本次没有增删事件）。
 * **2026-10-07 重取（v38 第 ⑨ 段「用度」追加"整理节拍"）**：这条基线**有意**又动了一次。
 * 装置自述第 ⑨ 段末尾多了那一段（整理 state / 记忆 / 笔记同样花 token：必要但不必每轮做，
 * 挑用户长时间没说话 / 没人找 / 心跳那一拍做；**但该落的账照旧落**）——它在 `instructions` 里，
 * 所以指纹的两个数变了：
 *   非心跳拍 `6ef643eb0f3a7783` → `28eed0dd9858ed11`
 *   混批     `50b74c932f47e69a` → `9e49e6f9e0fb41a6`
 * 重取的证据是**对照实验**（判据未放宽：两次都是精确比对，不做容差），三件一起看：
 *   ① 把新加的那一段**临时撤回**（其余全留，含 v38 的版本号递增），复跑
 *      `_research/heartbeat-real-wake-baseline.mjs` 得到的就是上面那两个**旧值**
 *      （纯心跳拍 `e4241a3b5ad3b287` 也一并复现）⇒ 除这一段外**没有任何别的字节变化**；
 *   ② 同一状态下 `SELF_BRIEF` 与 `HEAD` 那份**逐字节相同**
 *      （sha256 `5d440057…c634cbb`，4922 字符；装回新段后 5163 字符 / `cca3a171…d31ba3`）
 *      ——这是"撤掉的那一刀只切了新段"的直接凭据；
 *   ③ 两条断言里的事件类型序列**一个字都没动**（本次没有增删事件），light 调用仍是 0 次。
 * 驱动器与那次实验的打印留在 `_tmp/v38-baseline-control/`（未跟踪）。
 * `RENDER_VERSION` 随之递增到 38（见 `render.ts` 顶部那一篇）。
 *
 * **2026-10-07 v39 复核（「本任务相关资产」那一行里她的说明不再是整段）：这两个值**不该变**，
 * 实测也确实一个字节没变——所以本次**没有重取**，`BEFORE_*` 常量保持 v38 那两个值。**
 * 理由是口径本身：v39 动的是**此刻层**里那一行（`persona/assets.ts` 的 `renderAssetsLine`），
 * 而 `requestFingerprint` 的口径就是**剥掉含 `NOW_LAYER_BANNER` 的那个 item**（本文件顶部第 38 行
 * 那一段已经写明"此刻层含本机事实，是环境噪声，不是行为差异"）。所以：
 *   ① `test/fixtures/real-wake-rig.ts` 的指纹**看不见**这一处改动 —— 两个常量照旧；
 *   ② v39 的对照实验**换了一个对象**（不是撤回字节，而是逐字节比对"那一行"本身）：
 *      取 `data/workspace/MEMORIES/assets.md` 里历史最长那条挑中的三条（<技能 A> /
 *      <技能 B> / anysearch，逐字抄自 `data/events` 里那条 527 字符的 `memory/selected`），
 *      用 v38 的老口径与 v39 的新口径各渲染一次：527 → 162 字符，**只有那一行变了**；
 *      再把两份渲染结果各自塞进同一个"此刻层 item"里算 `requestFingerprint`
 *      ⇒ 老口径与新口径**同一个值**（`4e7a3669b7145e0e`）；而把**层外**的历史改一个字符，
 *      指纹立刻变成 `5ed7666c43648133` ⇒ 指纹对层外敏感，所以上面那一条不是"指纹太粗"。
 *      脚本与打印：`_tmp/probe-v39-control.mts`（未跟踪）。
 * `RENDER_VERSION` 随之递增到 39（见 `render.ts` 顶部那一篇）。
 *
 * **2026-10-12 第三次重取（v54：⑦ 段再缀四段 + 常驻规则改两档口径）**：
 *      这一版把用户当天的第二批改动一次并进 `instructions`（`self-brief.ts`）：⑦ 段末尾依次缀上
 *      `CLOSER_TEXT`（改动 A + D：想更近、但小心翼翼；吃醋那半句收窄）、`VOICE_LAYER_TEXT`（C：
 *      语气层，不是行为层）、`NO_CATCHPHRASE_TEXT`（E：不变成固定台词 + "正常说话"开关）、
 *      `MEMORY_PURPOSE_TEXT`（F：记忆用途），另加 `MAINTENANCE_RULE_TEXT` 里那一句改成两档口径（B）。
 *      ⇒ 下面两个常量第三次变：
 *        非心跳拍 `05c76055278cc7e0` → **`7b5f53a3bc8b16a7`**
 *        混批     `ec41c37dbabf0834` → **`641d9053d7c08e36`**
 *      纯心跳拍那一个（无常量、只由基线脚本打印）：`6d56f458048e694a` → **`75bd238670bdddb5`**
 *      作用面与 v53 那一篇同一条口径（探针 `_research/_tmp-v53-scope-probe.mts`）：三拍里
 *      `维护窗口：` / `[自主时段]` **各 0 次**，③ 的附句只在含心跳的那两拍各 **1 次**
 *      ⇒ 非心跳拍这一拍的差异**只能**来自 `instructions`；混批那一拍叠的是 `instructions` + 心跳那一行。
 *      **同日第三批（改动 G）并进同一段区域之后又量了一次**（`RENDER_VERSION` **仍是 54**——
 *      同一批、同一次尚未部署的前缀改动，版本号不重复递增）：
 *        非心跳拍 `7b5f53a3bc8b16a7` → **`3227d0dbcb907266`**
 *        混批     `641d9053d7c08e36` → **`a277db01b8739a69`**
 *        纯心跳拍 `75bd238670bdddb5` → **`195da99e5472ccf0`**
 *      ⇒ 本条记的三个值就是**这一批的最终值**（G 之后又核了一次作用面，形状与上面一字不差）。
 *      同日第四批（**改动 H**，版本号仍 54）之后又复量了一次：非心跳拍 `3227d0dbcb907266` →
 *      **`6e5b185233cf942f`** · 混批 `a277db01b8739a69` → **`9594268d150dfb0b`** ·
 *      纯心跳拍 `195da99e5472ccf0` → **`723b20dd08ac29d8`**。
 *      同日第五批（**改动 I**：G 那三条线整块换掉）之后再复量：非心跳拍 `6e5b185233cf942f` →
 *      **`e8a0deb7a69ccbee`** · 混批 `9594268d150dfb0b` → **`64a72d0346e001d3`** ·
 *      纯心跳拍 `723b20dd08ac29d8` → **`1a8f5ca4a433ebba`**。
 *      同日第六批（**改动 J**：把那句框架定性加回来）再复量：非心跳拍 `e8a0deb7a69ccbee` →
 *      **`6d4f4f50f45db34e`** · 混批 `64a72d0346e001d3` → **`7545d3675c0fcb6f`** ·
 *      纯心跳拍 `1a8f5ca4a433ebba` → **`8ffc274c754ed3d7`**。
 *      同日第七批（**改动 K / L**：怎么一起编排 + 她是什么角色）再复量：非心跳拍
 *      `6d4f4f50f45db34e` → **`1cc79e8fb0b923d6`** · 混批 `7545d3675c0fcb6f` → **`ee3c3d101d140d50`** ·
 *      纯心跳拍 `8ffc274c754ed3d7` → **`ca18b7c0fb0289ab`**。
 *      （K/L 落定后**又按用户判定①**把 L 里与 K 重复的那句删掉，所以上面这三个值是**定稿之后**
 *      再量的那一版；中间那一版 `dce7dc05f26b9e50` / `506fb58d9dbd7462` / `317cc3b61b3f1468`
 *      是同一批里**未删重复句**时的读数，留在这里免得后人把两次读数读成"基线漂了"。）
 *      **v53 与 v54 是同一次尚未部署的前缀改动**：两次换代对缓存的实际代价**只在部署那一刻发生
 *      一次**（用户的认知："只要还没部署，前缀改动改几次都无所谓"）——这一版照它办，措辞没有
 *      为了省一次换代而将就。
 *      ✅ **①-only 两状态对照实验已补做（2026-10-12，实测）**：做法与读数见下面 v53 那一篇开头
 *      那一段（控制态**只撤 `self-brief.ts`**、`render.ts` 保持现行 ⇒ 非心跳拍回到
 *      `d54688eb60bc9e5e`、一个字节不差）。所以"非心跳拍只受 `instructions` 影响"**不是**推理，
 *      是两状态实测的结论。
 *
 *      ✅ **①-only 两状态对照实验：2026-10-12 已补做，结论是实测的**（用户点头后做的，内存回升到
 *      1.84 GB）。做法与历次同一条路（**复制仓库法，不动工作区**）：把仓库复制到临时目录，
 *      **只把 `src/model/self-brief.ts` 换回改动前那一版**（`41cbdc8` 的 blob，
 *      `d99d72907e60d6ccc8c261edb0cf952320c722b0`——`git hash-object` 核过逐字节相同），
 *      `render.ts` **保持现行**（含 ②③ 与 `RENDER_VERSION 54`，blob `8871b1bd…` 两侧相同），
 *      复跑 `_research/heartbeat-real-wake-baseline.mjs`。读数：
 *        · **非心跳拍 = `d54688eb60bc9e5e`** —— 正是 v51/v52 那一代的历史值（本文件下面那个常量
 *          在 v53 之前的取值）⇒ **把 self-brief 那一处撤掉，非心跳拍一个字节不差地回到旧值**
 *          ⇒ 这一拍在 v53+v54 里的全部移动**只来自 `instructions`**（`self-brief.ts` 的字节），
 *          ②（此刻层那两档）与 ③（空拍附句）**各贡献 0 字节**。这句话现在是**实测**，不是推理。
 *        · 纯心跳拍 = `42848fbd3fe0d051` ≠ 那一代的历史值 `3f21f616ae7d8d47` ⇒ 控制态里**唯一**
 *          还动着的就是 ③ 那一句（它长在 `render.ts`，控制态没撤）⇒ ③ 的作用面在**另一侧**
 *          被独立确认（心跳拍动、非心跳拍不动）。
 *        · 混批 = `cb4c44f87061291c`（控制态）——它两边都叠：`instructions`（撤了）与心跳那一行（留）。
 *      与下面"作用面读数"（探针 `_research/_tmp-v53-scope-probe.mts`）互为正反两面，两条都指向同一结论。
 *
 * **2026-10-12 重取（v53 装置自述第 ⑦ 段末尾再缀一段）**：
 *      这一版给 `SELF_BRIEF` 第 ⑦ 段缀上 `LIFE_TOGETHER_TEXT`（长期相处 / 关心他这个人 /
 *      开口不必等到有事 / 事实与推测分开记 / 末节点名**定时器是主要工具之一**；判据见
 *      `test/maintenance-window.test.ts` 与那次报告）。它在 `instructions` 里 ⇒ 下面两个常量必然变：
 *        非心跳拍 `d54688eb60bc9e5e` → **`05c76055278cc7e0`**
 *        混批     `d80a7d16ab722bce` → **`ec41c37dbabf0834`**
 *      纯心跳拍那一个（没有常量、只由基线脚本打印）：
 *        `3f21f616ae7d8d47` → **`6d56f458048e694a`**
 *      **同一版还动了另外两处，它们都"零前缀代价"**（这一版 `RENDER_VERSION` 递增的**唯一**理由是
 *      上面那一段）：
 *        · ② 此刻层那一行分两档（夜里 / 空拍 ⇒「自主时段」，压缩临近照旧）：此刻层是逐 step 发的
 *          尾部那一条 item，**不命中时整行不出现**；
 *        · ③ 心跳唤醒末尾附一句（`HEARTBEAT_IDLE_APPEND`）：只落在这一类唤醒的那条可见历史上
 *          ⇒ 非心跳拍一个字都不受影响（下面那条 `wake/manual` 用例量的就是它），而混批那一个
 *          因为请求体里有心跳那一条，**必然**再叠上它。
 *      **取数过程**：改前基线在 `41cbdc8` 上复跑 `_research/heartbeat-real-wake-baseline.mjs`
 *      ⇒ 打出的正是 `d54688eb60bc9e5e` / `d80a7d16ab722bce` / `3f21f616ae7d8d47`（与当时两个常量
 *      逐字吻合，说明起点干净）；改后在当前树上复跑同一条脚本得到上面三个新值。两条断言照旧是
 *      `requestFingerprint` 的 16 位 sha256 **精确比对**——**判据一个字没放宽**。
 *      ⚠ **还会有第三次取数**：用户已说定随后还要并入**另一段装置自述**（关于他现实里的情感生活等），
 *      那一次 `RENDER_VERSION` 53 → 54 ⇒ 本条记的三个值会再变一次（未部署 ⇒ 前缀改动本身不额外付代价，
 *      真正的缓存失效只发生在部署那一刻）。
 *
 * **2026-10-11 重取（v51 维护窗口：装置自述第 ⑦ 段末尾多一条常驻规则）**：
 *      这一版给 `SELF_BRIEF` 第 ⑦ 段（记忆）末尾加了一条 `MAINTENANCE_RULE_TEXT`
 *      （"框架自身的文档只有你在维护、别人不会去改；已经在上下文里的不要反复去读；每轮都去改
 *      也没有意义；只在维护窗口或有明确变化时改一次；没有要改的就不必动它"——判据见
 *      `test/maintenance-window.test.ts` 与 `docs/operations.md`）。它在 `instructions` 里
 *      ⇒ 下面两个常量必然变：
 *        非心跳拍 `89212e1efad4970a` → `d54688eb60bc9e5e`
 *        混批     `9e4330b5ab89cd62` → `d80a7d16ab722bce`
 *      纯心跳拍那一个：本版实测 `3f21f616ae7d8d47`（它没有常量、只由基线脚本打印；
 *      v44 那一篇记的 `2443213a5a7496e5` 是更早的历史留档，中间已经随 `instructions` 漂过几次）。
 *      **重取的证据是两个对照实验**（都**不动工作区**）：
 *        · **复制仓库法**：把仓库复制到临时目录，在那里把 `src/model/render.ts` 与
 *          `src/model/self-brief.ts` 换回改动前的版本（其余留现状），复跑
 *          `_research/heartbeat-real-wake-baseline.mjs` ⇒ 打出来的正是上面那两个**旧值**
 *          逐字（`89212e1efad4970a` / `9e4330b5ab89cd62`）⇒ 差异只来自那两处；
 *        · **同进程渲染对照**：同一份 `RenderInput` 两侧各渲染一次请求 ⇒ `instructions` 的
 *          sha256 变了（`4c0fef48548dafa5` → `77e215b4163379a9`），而 **`input` 没变**
 *          （`f5807591e0d88316` 两侧相同）、**`tools` 也没变**（`09a325fc87d68210` 两侧相同）；
 *        · 真台子上再核一次（本文件同一套 rig）：那一句在 `instructions` 里出现 **1** 次、
 *          在 `input` 里 **0** 次、在 `tools` 里 **0** 次，此刻层那条维护窗口信号 **0** 次
 *          （这一拍不是窗口）⇒ 差异面就是"instructions 多了那一句"，别处一个字没动。
 *      ⚠ **这次刻意没走 `git stash push` / `git checkout HEAD~1 --` 那条老路**（前面几次重取用的
 *      都是它）：2026-10-11 本仓出现过两次"提交卷走别人改动"，其中一次正是
 *      `git checkout HEAD~1 -- <path>` 把旧内容写进索引造成的。对照实验不需要动工作区。
 *      `RENDER_VERSION` 随之递增到 51（见 `render.ts` 顶部那一篇 v51）。
 *
 * **2026-10-12 v52（工具清单那一批）：下面两个常量照旧不动——这是"判据没放宽"的一次真检验**。
 * v52 动的是 `tools` 段（`pwsh` 加 `lang`、`ask_human` 不再进数组、新增 `web_search`、
 * 参数说明压缩）与若干工具回执（`[stderr]` 段、`[exit code: N · <ms>ms]` 状态行）。
 * 而这两个指纹的口径是 `requestFingerprint` = `instructions` + **请求体里那一串工具名** +
 * 剥掉此刻层的 items：
 *   · `instructions` 一个字没动 ⇒ 它不该变；
 *   · **工具名**理论上变了（少一件 `ask_human`、多一件 `web_search`）——但**它量不到**：
 *     `test/fixtures/real-wake-rig.ts` 交给 RealLoop 的注册表默认是**空的**
 *     （`registry: new ToolRegistry()`），所以这个台子的请求体里 `tools` 一直是 `[]`。
 * ⚠ **这是这个测试台的已知盲区**（v43 记下、v44 复核过、v52 再确认一次，别指望它替你看见）：
 * "生产那份请求体的工具名变了"由 `test/tool-catalog.test.ts` 与 `test/mcp-entry.test.ts` 直接钉
 * （那两处的注册表是**生产口径**的 `buildCatalogRegistry`）。
 * ⇒ 所以本次**没有**重取基线（重取反而会把"指纹看不见工具清单"这件事掩盖掉）。
 *
 * **2026-10-09 重取（v45 取消「light 选取资产」：装置自述第⑰段那句假承诺换掉）**：
 * 这一版把 `SELF_BRIEF` 第⑰段里"干活时框架会挑几条放在你任务旁边"那句删了（机制被用户取消，
 * 留着就是假承诺），而它在 `instructions` 里 ⇒ 指纹的两个数必然变：
 *   非心跳拍 `28eed0dd9858ed11` → `89212e1efad4970a`
 *   混批     `9e49e6f9e0fb41a6` → `9e4330b5ab89cd62`
 * 重取的证据是**对照实验**（`git stash push` 把工作区改动整个收走、复跑
 * `_research/heartbeat-real-wake-baseline.mjs`，再 `git stash pop` 装回来复跑一次）：
 *   · 收走之后打出来的正是上面那**两个旧值**（一字不差）⇒ 除本次改动之外没有任何别的字节变化；
 *   · 装回来之后是新值；两次都没有出现"多一条/少一条请求"（`heavy 1 次、light 0 次`）。
 * 同一批（别人那条线：压缩判定留痕）给每一拍**末尾**加了一条 `compaction/decision`，
 * 所以下面那三张事件类型表也跟着补上它——**它不是 v45 带来的差异**（对照实验两次都有它，
 * 而"事件序列与改动前一字不差"这条判据本身仍然成立：两张表在两次运行里都吻合）。
 * 纯心跳拍那两个数（`5d9fbcbdef496c25`）也一并随 `instructions` 变了；
 * `RENDER_VERSION` 随之递增到 45（见 `render.ts` 顶部那一篇）。
 */

/** 改动前：非心跳拍（单条 `wake/manual`） */
const BEFORE_MANUAL_TYPES = [
  'wake/manual', 'budget/rollover', 'snapshot/checkpoint', 'turn/start', 'input/claimed',
  'memory/selected', 'step/start', 'message/assistant', 'budget/consumed', 'step/end', 'turn/end',
  // `compaction/decision` 是**别人那条线**（压缩判定留痕，2026-10-09）加的收尾事件，与 v45 无关：
  // 本次对照实验里它出现两次都出现（改动前/改动后各一次）⇒ 它不是 v45 带来的差异。
  'compaction/decision',
];
// v51（2026-10-11 维护窗口）：`89212e1efad4970a` → `d54688eb60bc9e5e`（`instructions` 多了一句，
// 对照实验与理由见文件头 2026-10-11 那一篇）
// v53（2026-10-12 装置自述补"长期相处"那一段）：`d54688eb60bc9e5e` → `05c76055278cc7e0`
// v54（2026-10-12 第三次重取：⑦ 段再缀四段 + 常驻规则改两档口径）：`05c76055278cc7e0` →
// `7b5f53a3bc8b16a7`
// v54 同日第三批（**改动 G** 并进同一段区域，`RENDER_VERSION` 不再变）：`7b5f53a3bc8b16a7` →
// `3227d0dbcb907266`
// v54 同日第四批（**改动 H**）：`3227d0dbcb907266` → `6e5b185233cf942f`
// v54 同日第五批（**改动 I**：G 那三条线被整块换掉）：`6e5b185233cf942f` → `e8a0deb7a69ccbee`
// v54 同日第六批（**改动 J**：把那句框架定性加回来）：`e8a0deb7a69ccbee` → `6d4f4f50f45db34e`
// v54 同日第七批（**改动 K / L**：编排那一段 + 角色那一段；L 里与 K 重复的那句按用户判定①删掉）：
// `6d4f4f50f45db34e` → `1cc79e8fb0b923d6`
// v55（2026-10-13，**改动 M**：⑦ 段在 K 之后再加一段 `PAYLOAD_SHAPE_TEXT`——timer 的 `payload`
// 三格约定）：`1cc79e8fb0b923d6` → **`118c92a253e1bed0`**。
//   **为什么必然是它**：这一批动了三处，只有它进 `instructions`——
//     · `PAYLOAD_SHAPE_TEXT`（进 ⑦ 段）⇒ **改每一个请求的头部字节**，就是它；
//     · `timer.payload` 的参数描述（`tools` 段）与四件大工具的参数说明压缩（`tools` 段）
//       ⇒ 这个台子**量不到**（`registry: new ToolRegistry()`，请求体里 `tools` 一直是 `[]`，
//       见上面 v52 那一篇记的已知盲区）；
//     · GUI 那一行与用例 ⇒ 不进请求体。
//   **控制实验（与 v45/v53 那两套同一手法，只撤一处）**：把 `self-brief.ts` 里
//   `+ '\n' + PAYLOAD_SHAPE_TEXT` 那一行**临时注释掉**（其余改动一个字不动、压缩全在），
//   复跑 `_research/heartbeat-real-wake-baseline.mjs` ⇒ 打出来的正是**上面那两个旧值**
//   `1cc79e8fb0b923d6` / `ee3c3d101d140d50`（一字不差），装回后回到两个新值。
//   ⇒ 除"这一版确实动了 `instructions`"之外，**没有任何别的字节变化**（压缩一个字都没漏进去）。
// v56（2026-10-12 **每层加分割线**，见 `test/layer-separators.test.ts`）：`118c92a253e1bed0` →
//   **`7cbaacc9cbed8504`**。**为什么必然是它**：这一版只动 `instructions` 的四条层分割线
//   （`人格 · 身份` / `人格 · 宪法` / `人格 · 风格` / `装置自述`，+137 字符 / +44 token）与
//   固定块 / 此刻层的段头第一行——`tools` 段一个字节没动，那一侧这个台子也量不到；
//   ②③ 那两处（此刻层那一行 / 空拍附句）在这一场景里不出现（没有窗口、没有心跳唤醒）。
//   ⇒ 非心跳拍这一拍的位移**只来自 `instructions`**。
//   （**只因为 `instructions`**：这一场景里没有窗口、也没有心跳唤醒 ⇒ ②③ 一个字节都碰不到它。
//   这一条是**两状态实测**的结论。）
// v58（2026-10-12 **装置自述补"日程怎么用"那一段** `AGENDA_USAGE_TEXT`）：`7cbaacc9cbed8504` →
//   **`02b65ec014c7f38d`**。**为什么必然是它**：这一版只往 `instructions` 里加了那一段
//   （285 字符 / +186 token 含分隔换行），`tools` 段一个字节没动（这一版不碰 `src/tools/**`）；
//   v57 那一笔（`payload` 四格）实测**没动**这两个值（它动的是 `tools` 段，这台子量不到）。
//   ⇒ 非心跳拍这一拍的位移**只来自 `instructions`**。
// v59（`payload` 再约一格 `scope` + 日程页重做）：**未动**（动的是 `tools` 段与 `gui/**`，这台子量不到）。
// v60（**助理的站位那一段** `ASSISTANT_STANCE_TEXT`）：`02b65ec014c7f38d` → **`db22521dcd576fcb`**。
//   同样只因为 `instructions`（189 字符 / +116 token 实测），`tools` 段零改动。
//
// ──────────────────────── v61（2026-10-15，**记忆那一批**）：`db22521dcd576fcb` → `7d093cb974a9db68` ────────────────────────
// **本次复量的判据（按用户裁决，口径一个字不放宽：仍是 16 位 sha256 精确比对）**：
//   · **阶段一**（commit `3e87508`）改的是 **`input` 尾部**——本轮固定块里那一段从"整张指针表
//     （29 条 / 890 token）"换成"框架推荐 top-6（246 token）"。**它不是冻结前缀改动**
//     （`instructions` 与 `tools` 两段在那笔里一个字节没动），但请求体的**总字节**确实变了
//     ——这个台子量的是**整份请求**（剥掉此刻层），所以它必然移动。这是**设计内**的位移，
//     不是回归：判据（挑法 / 口径）没有一处放宽。
//   · **阶段二**（同一批）改的是 **`tools` 段**：`memory_read` 扩三个入口（+64）、
//     `find`/`safe_edit` 腾挪（−34）、`ask_human` 断装配（不在 `tools` 段里）。
//     ⚠ 这个台子给的是**空 `ToolRegistry`**（请求体里 `tools` 恒为 `[]`）⇒ **`tools` 段的改动
//     它量不到**（v52/v55/v57/v59 四篇都记过这条已知盲区）。所以本次位移**只来自阶段一那一处**。
//   · **不给"等 v61 之后再复量"留口子**：工作树里留三条红比"基线提前动一次"坏得多
//     （后人看到红会先去查是不是回归）⇒ **随本次复量**，`RENDER_VERSION 60 → 61` 同批落定。
//     下一次改 `input` 尾部或冻结前缀时，照这条注释的格式再记一笔（**只记事实与判据**）。
//   · **同批第二笔（本线）：装置自述逐字置换**（`SELF_BRIEF` = 用户手写稿，含内联的工作规范）——
//     它进的是 **`instructions`**（冻结前缀）⇒ 两个常量必然再动一次：
//     `7d093cb974a9db68` → **`34e89d331b14e1c2`**（非心跳）、`cf409e1c8aa71d10` → **`10b0abf9e69f5e26`**（混批）。
//     位移**只来自 `instructions`**（+1,470 字符 / +882 token，实测 `_research/_tmp-v61-account.mts`）：
//     `tools` 段这一笔不碰（台子也量不到），②③ 两处在本场景里不出现（没有窗口、没有心跳唤醒）。
//     `RENDER_VERSION` **仍是 `61`**（与阶段一同批、两笔之间没有部署 ⇒ 只付一次缓存失忆）。
//   · **v62（本线）：装置自述按用户改过的那一版稿子**再置换一次（7 处局部改动，见 `render.ts` v62 篇）
//     ——同样只进 `instructions` ⇒ 两个常量再动一次：
//     `34e89d331b14e1c2` → **`97137a15a6b94dd8`**（非心跳）、`10b0abf9e69f5e26` → **`697c0a8c34118f73`**（混批）。
//     位移**只来自 `instructions`**（+241 字符 / +140 token，实测 `_research/_tmp-v62-account.mts`）；
//     `tools` 段零改动（这台子也量不到），②③ 两处在本场景里不出现（没有窗口、没有心跳唤醒）。
//   · **v63（本线）：装置自述 §6 补两段**（自动挑选记忆的可见性 + 何时检索；只加 3 行、一个字没删）
//     ——同样只进 `instructions` ⇒ 两个常量再动一次：
//     `97137a15a6b94dd8` → **`995eb71564fb53f8`**（非心跳）、`697c0a8c34118f73` → **`10c8511b8f3380c2`**（混批）。
//     位移**只来自 `instructions`**（+198 字符 / +125 token，实测 `_research/_tmp-v63-account.mts`）。
//   · **v65（本线）：装置自述大改**（删 §11 / 删两处"必须说话" / 工作规范取消缩进重排 + 新增"人类的偏好"；
//     净减 570 字符）——同样只进 `instructions` ⇒ 两个常量再动一次：
//     `995eb71564fb53f8` → **`ddac3e02f566deaa`**（非心跳）、`10c8511b8f3380c2` → **`f42566abafa24fbb`**（混批）。
//     位移**只来自 `instructions`**（**−570 字符 / −384 token**，实测 `_research/_tmp-v65-account.mts`）。
//   · **v66（2026-10-16，本线：此刻层结构压缩）**：`ddac3e02f566deaa` → **`cf1bfdd6ab08706f`**（非心跳）、
//     `f42566abafa24fbb` → **`1630efab6254bf24`**（混批）。
//     位移**只来自 `input` 里那一层的位置**（`instructions` 一个字节没动，实测 `len=9432` 两边相同；
//     `tools` 段这台子量不到——空注册表，见上面那条已知盲区）。**控制实验逐字给出差在哪**
//     （`_research/_tmp-fp-dump.mts`，同一台子、同一脚本，在两个 worktree 上各跑一次）：
//       · 改动前：`[联络方式] …告警出口：未配置。这轮没人从外面叫你…` 在**此刻层**那条
//         `通道：` 下面；
//       · 改动后：同一句挪进**本轮固定块**（`[当前状态]` 之前那一节），此刻层那条 `通道：`
//         只剩 `[联络方式] …这轮没人从外面叫你…`。
//     为什么这次位移是**设计要的**（不是回归）：那几行（每扇门后面是谁 + 告警出口）一轮之内
//     一个字都不会变，原先逐 step 重发、现在只在第 1 步发（见 `render.ts` 的 `renderTurnBlock`）。
//     **代价如实说**：`requestFingerprint` 的口径是"剥掉含 `NOW_LAYER_BANNER` 的 item"，
//     而固定块**不在**剥离范围内 ⇒ 这一层的移动它看得见。位移因此是"这一层换了位置"的
//     忠实读数，判据一个字没放宽（这条用例量的仍然是"非心跳拍请求有没有被动过"）。
//     `RENDER_VERSION` `65 → 66` 在**同一批**里落定（④b/④c + ① 的 `tools` 段改动一起，
//     见 `render.ts` 的 v66 那一篇）：两笔之间没有部署 ⇒ 只付一次缓存失忆。
//
// **v67（2026-10-17，`read_channel` 的 `description` 与行为对齐）：这个常量照旧不动**——
//   理由与实测复核写在下面 `BEFORE_MIXED_FINGERPRINT` 的 v67 那一段（同一笔、同一份复跑证据）：
//   指纹只取工具**名**（`test/fixtures/real-wake-rig.ts:175`），而这一笔改的是描述字节（84 → 90）。
// **v68（2026-10-17，思维链按帽回传）：这个常量照旧不动**——**复量过，结论是它不该动**：
//   · 台子的模型脚本是 `{ text: '', toolCalls: [] }`（`runOneWake` 的缺省）⇒ `result.reasoning`
//     为空 ⇒ **事件流里没有 `message/reasoning`**，而这一版的字节只出现在"有 reasoning 的历史"里；
//   · `requestFingerprint` 也不含 `renderVersion`（`real-wake-rig.ts` 的 canonical 只有
//     model / instructions / tools.map(name) / input），所以换代本身不改指纹。
//   ⇒ 逐字复跑 `_research/heartbeat-real-wake-baseline.mjs`：非心跳 `cf1bfdd6ab08706f`、混批
//   `1630efab6254bf24`，与这两个常量**逐字相同**。判据一个字没放宽（仍是 16 位 sha256 精确比对）。
//   "真带了 reasoning 时会怎样"由 `test/reasoning-echo.test.ts` 直接钉（它不走这个台子）。
// **v70（2026-10-18，此刻层的三样 must-keep + 维护窗口标签 + 窗口改写读数）：这两个常量照旧不动**
//   ——**复量过**：本笔动的全部是**此刻层**（`NOW_MUST_KEEP_LABELS` 那三样每步发、2/3 档补行首
//   标签）与一格**观测字段**（`RenderedRequest.windowRewrites`，不进请求体），而
//   `requestFingerprint` 的口径就是"剥掉含 `NOW_LAYER_BANNER` 的 item"、也不含 `renderVersion`
//   ⇒ 逐字跑本文件，两个常量与下面那两行**逐字相同**。判据未放宽（仍是 16 位 sha256 精确比对）。
// **2026-10-18 · 脱敏那一笔（`cdc6b92`）之后重取**：`cf1bfdd6ab08706f` → **`45e0194adc564e07`**（非心跳）、
//   `1630efab6254bf24` → **`2eeed722e66d2c4d`**（混批）。**位移只来自 `instructions` 里那一段
//   4 位尾号（3 个字符不同）**，而且**不是 v70 造成的**——让它们移动的是 v70 之后那一笔：
//   · `cdc6b92` 的说明写着"src 侧的改动全是注释"，实测**有一处不是**：`self-brief.ts` 里
//     `SELF_BRIEF` 正文那句「认不出来就照实写"甲（id …××）"」的 4 位尾号被换成了占位值
//     （旧值是真实 id 的尾巴，脱敏那一笔要清掉的就是它，**这里不重抄**）。
//     旧 4 位 → 新 4 位**长度相同**，`SELF_BRIEF` 整段 9226 → 9226 字符 ⇒ `tokens` / `bytes`
//     **一个数都没动**，动的是字节内容（`instructions` 是冻结前缀 ⇒ 整份请求的头部字节变了）。
//   · v70 那一篇说的"复量后不动"**当时是真的**（它只动此刻层）；`RENDER_VERSION` 仍是 `70`
//     （脱敏那一笔没换代，见本段末那条 ⚠）。
//   **判据没有放宽**（仍是 16 位 sha256 精确比对，一个字节都不许差），也**不是**"改常量凑绿"：
//   这一条量的就是"非心跳拍的请求有没有被动过"，它**真的**被动了——那 4 位尾号在冻结前缀里。
//   **对照实验只改这一个输入**（探针 `_research/_tmp-sanitize-instructions-delta.mts`，不动工作区）：
//     ① 用 `git show f014811:src/model/self-brief.ts` 的字节还原旧 `SELF_BRIEF`（**只在内存里**）
//        ⇒ `segmentOfText(INSTRUCTION_RULES.brief + '\n\n' + SELF_BRIEF)` 逐字回到旧基线
//        `5462 / 24566 / 568c4e9283766245` ⇒ 旧字节确实就是上一代那一串，位移就那一处；
//     ② 对**同一份真实请求**（本文件同一套台子）把 `instructions` 换回旧字节再算指纹：
//        非心跳拍回到 `cf1bfdd6ab08706f`、混批回到 `1630efab6254bf24`，**逐字相同**
//        ⇒ `input` 与 `tools` 两侧一个字节都没动，位移**只**来自 `instructions`。
//   **同一支探针还回答了"剥掉此刻层还盖不盖得住 v70 新加的行"**（本次最该查的一件事）：
//     两拍那一轮（第 1 步调工具、第 2 步收尾，= must-keep 真正的作用面）第 2 条请求里
//     `通道：` / `会话：` 各 **1** 次——**全在被剥掉的那条 item 里**，剥完之后 **0** 次；
//     `维护窗口：` 在这几个场景里整份 input **0** 次（这一拍不是窗口，P1-04 那五个字贡献 0 字节）。
//     ⇒ 此刻层那条 item 的段头永远在最前（`renderNowLayer` 的 `index === 0` 恒留），
//       所以 v70 新加的 must-keep 与行首标签**都还在剥除范围内**，**判据不需要动**。
//   ⚠ **脱敏那一笔没有递增 `RENDER_VERSION`**（仍 70），而 `self-brief.ts` 文件头那条规矩是
//     "改 `SELF_BRIEF` 一个字就要递增"。本次只复量基线、**不动版本号**：那要牵动
//     `maintenance-window.test.ts` 与 `reasoning-echo.test.ts` 的两条版本锁，以及 `mcp/index`、
//     `skill/index` 快照的一次重建——是 `cdc6b92` 那条线的决定，事实记在这里供当次裁决。
//   ✅ **裁决已落（v71，下一笔）**：`RENDER_VERSION` `70 → 71`，见 `render.ts` 的 v71 那一篇。
//     那一笔**只动版本号 + 两条版本锁 + 注释**，**上面这两个指纹常量一个字符都没动**——
//     成立的原因本文件已经写着：`requestFingerprint` 的 canonical 里**没有 `renderVersion`**
//     （`test/fixtures/real-wake-rig.ts:172-177`，工具只取**名**）⇒ 换代不改指纹。
//     `mcp/index` / `skill/index` 的**一次重建**是设计内代价（判据 `point.version !== version`）。
// **v72（2026-10-20，用户整段置换 `SELF_BRIEF` + 回执锚词 + 三处描述）：两个常量都重取了**——
//   这一笔**动了 `instructions`**（自述整段置换：`SELF_BRIEF` 9226 → 9646 字符、+255 token），
//   与 v67/v70 那种"只动 `tools` 段、这台子看不见"的形态**不同**：
//     · 非心跳拍 `45e0194adc564e07` → **`71c68dd34b906265`**；
//     · 混批     `2eeed722e66d2c4d` → **`1382300bcab7f48a`**。
//   **对照实验（同一支探针 `_research/_tmp-v72-readings.mts`，只换 `SELF_BRIEF` 的字节）**：
//   把 `self-brief.ts` 换回 HEAD 那一版跑一遍，两个指纹**逐字回到旧值**
//   （`45e0194adc564e07` / `2eeed722e66d2c4d`）⇒ 位移**只**来自 `instructions`，
//   `input` 与 `tools` 两侧一个字节都没动（`send_media` 那 +31 token 是描述字节，指纹只取名字）。
//   判据一个字没放宽：仍是 16 位 sha256 逐字节精确比对。
// **v73（2026-10-20，思维链全量回传 + 超硬限整组丢 + 发前自洽断言）：两个常量照旧不动**——
//   **复量过**（逐字跑本文件，`②`/`②b`/`②c` 三条全绿）：这台子不给 reasoning（`script` 里
//   `reasoning: ''` ⇒ 事件流里没有 `message/reasoning`），而 `requestFingerprint` 的口径是
//   `instructions` + 工具**名** + 剥掉此刻层的 `input`（不含 `renderVersion`）⇒ 本笔改的
//   "回传集合"它一个字节都看不见。判据未放宽：仍是 16 位 sha256 精确比对。
//   "真带了 reasoning 时会怎样"由 `test/reasoning-echo.test.ts` 直接钉（v73 那一组：4 条全在 /
//   超硬限整组丢 / 半截输入被拦），它不走这个台子。
// v74（2026-10-20，SELF_BRIEF 搬进 speak/report 的指导语）：71c68dd34b906265 → **d570c92185ddb949**
// ——这条台的指纹含 instructions，自述改了它必变；判据仍是逐字精确比对。
// v76（2026-10-21，SELF_BRIEF §2.1 加了一段"回执说明"——`send_media` 的样板搬进提示词）：
//   `d570c92185ddb949` → **`5f0b11e528bf8fc8`**。位移**只来自 `instructions`**（+127 估算 token；
//   见 `test/instructions-budget.test.ts` 的常量 v76 那一行），这一拍的 `input` 一个字节都没动
//   （v76 的 ① 只作用于"本轮钉住的那条通道唤醒"，这台子的非心跳拍是 `wake/manual` ⇒ 不吃名字）。
//   判据未放宽：仍是 16 位 sha256 精确比对。
// v78（2026-10-22，关系档案从整篇注入改成索引）：**两个常量照旧不动**——这一笔只改
//   `input` 的固定块（关系档案那一段），而这张台子的 `wake/manual` **不带 `person`** ⇒ 本来就不
//   注入档案，`instructions` 也一个字节没改（v78 首版曾给 `SELF_BRIEF` 补一句、随后按用户
//   「不要给指令」撤回；撤回之后 `instructions` 逐字节回到 v76）。
//   **复量证据**：把关系档案改成索引、且删掉那句之后，复跑本文件与此前的基线 ⇒ 指纹逐字回到
//   v76 的 `5f0b11e528bf8fc8`（混批 `46b672ac9c9fb55f`）。判据未放宽：仍是 16 位 sha256 精确比对。
const BEFORE_MANUAL_FINGERPRINT = '5f0b11e528bf8fc8';

/** 改动前：混批（心跳 + `wake/manual`）——按"非纯心跳"处理，与改动前一致 */
const BEFORE_MIXED_TYPES = [
  'wake/heartbeat', 'wake/manual', 'budget/rollover', 'snapshot/checkpoint', 'turn/start', 'input/claimed',
  'memory/selected', 'step/start', 'message/assistant', 'budget/consumed', 'step/end', 'turn/end',
  'compaction/decision',
];
// v51（2026-10-11 维护窗口）：`9e4330b5ab89cd62` → `d80a7d16ab722bce`（同上）
// v53（2026-10-12）：`d80a7d16ab722bce` → `ec41c37dbabf0834`——这一个**叠了两处**：
//   · `instructions`（① 那一段），与上面那条同源；
//   · `input` 里那条心跳唤醒行（③ 附上的那一句）——混批场景把它带进了请求体。
// v54（2026-10-12 第三次重取）：`ec41c37dbabf0834` → `641d9053d7c08e36`——同样两处一起变
//   （`instructions` 又多四段+改了常驻规则那一句；`input` 里那条心跳行还是 ③ 那一句）。
// v54 同日第三批（**改动 G**，版本号不变）：`641d9053d7c08e36` → `a277db01b8739a69`（同上两处）。
// v54 同日第四批（**改动 H**）：`a277db01b8739a69` → `9594268d150dfb0b`（同上两处）。
// v54 同日第五批（**改动 I**）：`9594268d150dfb0b` → `64a72d0346e001d3`（同上两处）。
// v54 同日第六批（**改动 J**）：`64a72d0346e001d3` → `7545d3675c0fcb6f`（同上两处）。
// v54 同日第七批（**改动 K / L**）：`7545d3675c0fcb6f` → `ee3c3d101d140d50`（同上两处）。
// v55（2026-10-13，**改动 M**）：`ee3c3d101d140d50` → **`5c8d9611beb73a33`**——同样两处一起变
//   （`instructions` 多一段 `PAYLOAD_SHAPE_TEXT`；`input` 里那条心跳唤醒行不变，但整份请求体的
//   头部字节变了）。控制实验（只撤 `PAYLOAD_SHAPE_TEXT` 那一行）逐字节回到 `ee3c3d101d140d50`，
//   见上面那条常量的注释。
// v56（2026-10-12 **每层加分割线**）：`5c8d9611beb73a33` → **`354fb55da938af37`**——同样两处一起变
//   （`instructions` 多了四条层分割线；`input` 里那条心跳唤醒行不变，但整份请求体的头部字节变了）。
// v57（`payload` 四格）：**未动**（那一版只改 `tools` 段，这台子量不到——v52 那一篇记的已知盲区）。
// v58（**日程怎么用那一段**）：`354fb55da938af37` → **`12ec93a65b0059b9`**——同样两处一起变
//   （`instructions` 多了 `AGENDA_USAGE_TEXT`；`input` 里那条心跳唤醒行本身没变）。
// v59（`payload` 的 `scope` 那一格 + 日程页）：**未动**（只改 `tools` 段与 `gui/**`）。
// v60（**助理的站位那一段**）：`12ec93a65b0059b9` → **`43d650923c43aaf9`**——同样两处一起变
//   （`instructions` 多了 `ASSISTANT_STANCE_TEXT`）。
// v61（2026-10-15 **记忆那一批**）：`43d650923c43aaf9` → **`cf409e1c8aa71d10`**——位移只来自
//   **阶段一改的那一段 `input` 尾部**（固定块里的指针表 → 推荐段）；判据与那条已知盲区
//   （`tools` 段这台子量不到）见上面 `BEFORE_MANUAL_FINGERPRINT` 那一段"本次复量"的注释。
// v61 同批第二笔（**装置自述逐字置换**）：`cf409e1c8aa71d10` → **`10b0abf9e69f5e26`**——位移只来自
//   `instructions`（+882 token），`tools` 段零改动；`RENDER_VERSION` 仍是 `61`（同批不重复递增）。
// v62（**装置自述再置换：用户改过的那一版**）：`10b0abf9e69f5e26` → **`697c0a8c34118f73`**——同样只来自
//   `instructions`（+140 token）；`RENDER_VERSION` 这时才 `61 → 62`（这一笔自己的一代）。
// v63（**装置自述 §6 补两段**）：`697c0a8c34118f73` → **`10c8511b8f3380c2`**——同样只来自 `instructions`
//   （+125 token）；`RENDER_VERSION` `62 → 63`。`tools` 段零改动。
// v65（**装置自述大改**）：`10c8511b8f3380c2` → **`f42566abafa24fbb`**——同样只来自 `instructions`
//   （**−384 token**，这一版是净减）；`RENDER_VERSION` `64 → 65`。
// v66（**此刻层结构压缩**）：`f42566abafa24fbb` → **`1630efab6254bf24`**——位移只来自 `input`
//   里联络方式那一层的位置（此刻层 → 本轮固定块），与上面那条常量同一笔、同一份控制实验；
//   `instructions` 零改动。混批场景把心跳唤醒行也带进了请求体，所以两个常量各变各的。
// v67（2026-10-17，`read_channel` 的**描述**与行为对齐）：**两个常量这次照旧不动**——
//   与 v52 / v57 / v59 同一形态，理由就是上面那条已知盲区：口径是
//   `requestFingerprint` = `instructions` + **请求体里那一串工具名** + 剥掉此刻层的 items
//   （`test/fixtures/real-wake-rig.ts:175` 逐字是 `tools.map(tool => tool.name)`），
//   而 v67 改的是 `read_channel` 那一件的 **`description` 字节**（84 → 90 token）——
//   **名字一个都没动** ⇒ 这个台子看不见它（它的注册表也一直是空的，见上面 v52 那一段）。
//   **实测复核**（本次改动之后逐字复跑 `_research/heartbeat-real-wake-baseline.mjs`）：
//   非心跳拍 `cf1bfdd6ab08706f`、混批 `1630efab6254bf24`——与这两个常量**逐字相同**。
//   ⇒ 这不是"没复量"，是"复量了、结论是它不该动"（重取反而会把"指纹看不见描述字节"
//   这件事掩盖掉）。**生产那一侧的 `tools` 字节确实变了**，它由
//   `test/tool-catalog.test.ts`（描述预算与总量）与 `test/read-channel-incremental.test.ts` ⑦
//   （描述逐字 + 单件/整段 token）直接钉住。
// v68（思维链按帽回传）：**两个常量照旧不动**——理由与逐字复跑读数写在上面
//   `BEFORE_MANUAL_FINGERPRINT` 的 v68 那一段（同一批、同一份证据）：脚本不给 reasoning ⇒
//   没有 `message/reasoning` 事件；指纹也不含 `renderVersion`。
// 2026-10-18 · `cdc6b92`（脱敏）：`1630efab6254bf24` → **`2eeed722e66d2c4d`**——同上一条常量、同一笔、
//   同一份对照实验（位移只来自 `instructions` 里那 4 位尾号、差 3 个字符；混批那一拍把它一并带进请求体）。
// v72（2026-10-20，用户整段置换 `SELF_BRIEF`）：`2eeed722e66d2c4d` → **`1382300bcab7f48a`**——
//   与上面那条常量同一笔、同一份对照实验（位移只来自 `instructions`；混批那一拍把它一并带进请求体）。
// v76（2026-10-21，`SELF_BRIEF` §2.1 的回执说明）：`494d717c35bc0f43` → **`46b672ac9c9fb55f`**——
//   同一笔、同一份判断（位移只来自 `instructions`；混批那一拍含心跳唤醒行，但那一行 v76 没碰）。
// v78（2026-10-22，关系档案改索引）：**两个常量照旧不动**——与上面那条同一笔、同一份判断
//   （这一拍也没有 `person`，固定块里的关系档案那一段一个字节都不出现；`instructions` 撤回那句
//   之后回到 v76）⇒ 混批仍回到 `46b672ac9c9fb55f`。
const BEFORE_MIXED_FINGERPRINT = '46b672ac9c9fb55f';
/** 改动前：纯心跳拍 —— 事件序列里**没有任何 step**（当年那个形态），请求数 1（v39 起真唤醒） */
const BEFORE_HEARTBEAT_TYPES = [
  'wake/heartbeat', 'budget/rollover', 'snapshot/checkpoint', 'turn/start', 'input/claimed', 'turn/end',
  'compaction/decision',
];

/**
 * **启动必然落的那一条留痕**（2026-10-11 别人那条线加的：`runtime/restart`）。
 *
 * ──────────────────────────── 它为什么该被"容纳"而不是被"重取" ────────────────────────────
 *
 * 上面那三张表是**改动前的历史常量**，它们记的是"当年那一刻的事件序列"。而 `runtime/restart`
 * 是一条**每次启动都会写**的 internal 留痕（进程起来时写一条：这一任是谁拉起的、上一任怎么没的
 * ——见 `src/runtime/real-loop.ts` 那段头注释）。台子（`test/fixtures/real-wake-rig.ts`）走的是
 * 真 `RealLoop.tickOnce()`，所以它**必然**在里面出现一次、位置在"唤醒事件之后、预热收尾那一段"：
 *
 * ```
 * 非心跳拍：wake/manual  →  [runtime/restart]  →  budget/rollover  →  snapshot/checkpoint  →  turn/start …
 * 混批：    wake/heartbeat, wake/manual  →  [runtime/restart]  →  budget/rollover …
 * ```
 *
 * **这一条改动没有重取那三张基线常量**，理由与做法都在下面那两条断言里：
 *   · 三张历史常量**一个字不动**（它们仍是"改动前"的凭据）；
 *   · 实际序列**滤掉这一条**之后，必须与历史基线**逐字相同** ⇒ 两边的差集**恰好只有这一条**
 *     （多滤一条、少滤一条、多出任何别的类型，用例都会红）；
 *   · 另外单独钉住"这一条不许进她的请求体"（`internal` ⇒ 渲染层看不见它）——
 *     它正好是这条留痕最容易犯的错：一条簿记混进上下文，之后每一轮都在为它付费。
 *
 * 判据没有放宽：`compaction/decision` 当年也是"别人那条线加的收尾事件"，走的是同一条路
 * （见文件头 2026-10-09 那一段），只是那次它是**补进表里**（那三条表当时本来就在重取）。
 */
const STARTUP_RESTART_EVENT = 'runtime/restart';

/** 实际序列 - 启动留痕（`deepEqual` 要求两边都是可变数组，所以这里不标 readonly） */
function withoutStartupRestart(types: string[]): string[] {
  return types.filter(type => type !== STARTUP_RESTART_EVENT);
}

/**
 * 一条事件（判据要它的 `visibility`；缺了就直接红——比"顺手取一个可能为 undefined 的东西"硬）
 */
async function eventOfType(rig: RealWakeRig, type: string): Promise<AppEvent> {
  const hit = (await rig.events()).find(event => event.type === type);
  assert.ok(hit !== undefined, `事件流里必须有 ${type}（它不在，下面那条"不进请求体"就没有对象）`);
  return hit;
}

/**
 * 一次请求里**输入那一段的全部文本**（外层不套 JSON）：Windows 路径里的反斜杠会被
 * `JSON.stringify` 转义成 `\\`，于是"这串字节在不在请求里"这种断言会因为转义而假绿/假红。
 * 与 `compaction-decision-wake.test.ts` 的同名函数同一口径。
 */
function textOfRequest(request: DsRequest): string {
  const input = request.input;
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  const parts: string[] = [];
  for (const item of input) {
    const content = (item as { content?: unknown }).content;
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
  }
  return parts.join('\n');
}

/** 一次整拍：落一条唤醒 → 跑一拍（生产定时器回调与 `tick()` 是同一份逻辑） */
async function runOneWake(
  wake: { type: string; data: unknown },
  script: Array<{ text?: string; toolCalls?: unknown[] }> = [{ text: '', toolCalls: [] }],
): Promise<Awaited<ReturnType<typeof makeRealWakeRig>>> {
  const rig = await makeRealWakeRig({ stream: script });
  try {
    rig.append(wake.type, wake.data);
    await rig.tick();
    return rig;
  } catch (err) {
    rig.dispose();
    throw err;
  }
}

// ──────────────────────────────── ① 真实唤醒 ────────────────────────────────

test('① 纯心跳拍真的发出一次 heavy 请求，并落 budget/consumed{lane:heavy}', async (t) => {
  const rig = await runOneWake({ type: 'wake/heartbeat', data: heartbeatData(1800, 1) });
  t.after(rig.dispose);

  assert.equal(rig.requests.length, 1, '心跳拍必须恰好发一次请求（不多不少）');
  const [sent] = rig.requests;
  assert.equal(sent!.lane, 'heavy', '走主力车道：只有它与普通回合共用同一条前缀，light 判定请求刷不到那条缓存');
  assert.equal(sent!.request.model, 'fake-heavy');
  assert.equal(
    rig.requests.filter(item => item.lane === 'light').length, 0,
    '"真实唤醒"= 这一拍走主力车道；它不需要、也不该再有一条"先花一次 light 判定"的路',
  );

  const events = await rig.events();
  const steps = events.filter(event => event.type === 'step/start');
  const consumed = events.filter(event => event.type === 'budget/consumed');
  assert.equal(steps.length, 1, '心跳拍起了 step（旧形态是一步都没有）');
  assert.equal(consumed.length, 1);
  assert.equal(consumed[0]!.data.lane, 'heavy', '这一拍的账记在 heavy 上（不是 light）');
  assert.equal(consumed[0]!.data.turn, steps[0]!.data.turn, '账挂在同一个 turn 上');

  // 改动前的形态：请求 0 次、一个 step 都没有——这条断言是"确实改了"的反面参照
  assert.notDeepEqual((await rig.types()), BEFORE_HEARTBEAT_TYPES);
});

test('①b 一整库"牵挂"全无（到期意图/待确认/待办/等回答/死信都没有）也照样起一拍', async (t) => {
  // 这正是当年被规则短路吃掉的形态："没事"曾经等于"不发请求"。现在"没事"由她自己在 turn 里
  // 得出结论（并且照样可以整拍不说话），但**请求必须发出去**——前缀就是靠它保温的。
  const rig = await runOneWake({ type: 'wake/heartbeat', data: heartbeatData(3600, 3) });
  t.after(rig.dispose);

  assert.deepEqual(rig.projection.pending, [], '心跳已被认领出队（走过的是正常 turn 的认领路径）');
  assert.equal(rig.requests.length, 1, '无牵挂不再是"不发请求"的理由');
});

// ──────────────────────────────── ② 非心跳拍回归 ────────────────────────────────

test('② 非心跳拍与改动前逐字节一致：事件序列 + 请求指纹（基线在改动前捕获）', async (t) => {
  const manual = await runOneWake({ type: 'wake/manual', data: { note: '帮我看看日志' } });
  t.after(manual.dispose);
  // 基线**没有重取**：实际序列滤掉"启动必然落的那一条"（`runtime/restart`）之后，
  // 必须与改动前的历史常量**逐字相同** ⇒ 差集恰好只有那一条（见那一段注释）。
  assert.deepEqual(
    withoutStartupRestart(await manual.types()),
    BEFORE_MANUAL_TYPES,
    '非心跳拍的事件序列必须与改动前一字不差（除启动那条 runtime/restart 留痕）',
  );
  assert.deepEqual(
    manual.requests.map(item => `${item.lane}:${requestFingerprint(item.request)}`),
    [`heavy:${BEFORE_MANUAL_FINGERPRINT}`],
    '非心跳拍的请求字节（剥掉此刻层）必须与改动前一致',
  );
});

test('②b 混批（心跳 + 人）仍按"有真实事件"处理：与改动前逐字节一致', async (t) => {
  const rig = await makeRealWakeRig({ stream: [{ text: '', toolCalls: [] }] });
  t.after(rig.dispose);
  rig.append('wake/heartbeat', heartbeatData(1800, 1));
  rig.append('wake/manual', { note: '混批' });
  await rig.tick();

  assert.deepEqual(withoutStartupRestart(await rig.types()), BEFORE_MIXED_TYPES);
  assert.deepEqual(
    rig.requests.map(item => `${item.lane}:${requestFingerprint(item.request)}`),
    [`heavy:${BEFORE_MIXED_FINGERPRINT}`],
  );
});

// ──────────── v76：通道轮的名字只给"钉住的那条"（并把张冠李戴钉死） ────────────

test('★ v76：名字取的是"钉住的那条"（`wakeEvents[0]`），不是本批最后一条通道消息', async (t) => {
  // v76 接线时抓到的坑：`agent-loop` 钉住的是 `wakeEvents[0]`，而 `RealLoop.wakeChannelData`
  // 取的是 `lastChannelWake`（回投要回**最后**说话的那个会话）。同一批里攒了两条通道消息时，
  // 用后者给前者配名字就是**张冠李戴**——名与 openid 对不上，比不配名字更坏。
  // 判据：钉住那条（第一句，OPENID-A）带名字；历史那条（第二句，OPENID-B）裸 openid。
  const rig = await makeRealWakeRig({
    stream: [{ text: '', toolCalls: [] }],
    patchConfig: (config) => {
      config.persona.contacts = {
        ...config.persona.contacts,
        'qq:c2c:OPENID-A': '甲',
        'qq:c2c:OPENID-B': '乙',
      };
    },
  });
  t.after(rig.dispose);
  rig.append('wake/channel', {
    channel: 'qq-official', chatType: 'c2c', person: 'OPENID-A', chatId: 'OPENID-A',
    text: '第一句', messageId: 'm1', msgSeq: 1,
  });
  rig.append('wake/channel', {
    channel: 'qq-official', chatType: 'c2c', person: 'OPENID-B', chatId: 'OPENID-B',
    text: '第二句', messageId: 'm2', msgSeq: 2,
  });
  await rig.tick();

  assert.equal(rig.requests.filter(item => item.lane === 'heavy').length, 1, '一批两条通道消息 ⇒ 一轮一次 heavy');
  // ⚠ 别拿 `rig.requests[0]`：这一批的两条消息各跑了一次**注入判定**（light），前面还有两笔。
  const heavy = rig.requests.find(item => item.lane === 'heavy')!;
  const body = JSON.stringify(heavy.request.input);
  assert.ok(body.includes('person=甲(OPENID-A)'),
    `钉住的那条要带名字（v32 的意图）：\n${body.slice(0, 600)}`);
  assert.ok(body.includes('person=OPENID-B'), '历史那条（本批第二条）按裸 openid 渲染');
  assert.ok(!body.includes('乙(OPENID-A)'),
    '★ 张冠李戴的旧写法（拿 `lastChannelWake` 的上下文配给钉住那条）会在这里红');
});

// ──────────── ②c 启动留痕是 internal ⇒ 不许污染她的上下文（2026-10-11） ────────────

test('②c 启动留痕 runtime/restart 是 internal：一条都不进她的请求体', async (t) => {
  // 这条正好把"留痕不该污染上下文"钉死：它是**每次启动都写**的一条（见 `src/runtime/real-loop.ts`
  // 那段头注释），一旦写成 model，之后**每一轮**请求都要为它付一次常驻 token。
  const rig = await runOneWake({ type: 'wake/manual', data: { note: '帮我看看日志' } }, [{ text: '嗯。', toolCalls: [] }]);
  t.after(rig.dispose);

  // ① 它真的在事件流里、位置与形状都对（**留痕在前、预热收尾那一段**），且可见性是 internal
  const logged = await eventOfType(rig, STARTUP_RESTART_EVENT);
  assert.equal(defaultVisibility(STARTUP_RESTART_EVENT), 'internal',
    '写入点走 defaultVisibility，所以 schema 表里那一格就是契约');
  assert.equal(logged.visibility, 'internal', '落库那一栏也必须是 internal（表与写入点两处都要对）');
  assert.equal(logged.data.wake, false,
    '台子里没有上一任的 session/start ⇒ 判成首任/unknown 且不喊（这一条留痕不该顺带叫醒她）');
  assert.equal(
    (await rig.types()).filter(type => type === STARTUP_RESTART_EVENT).length, 1,
    '一次启动恰好一条（不是每拍一条）',
  );

  // ② 请求体里一个字节都没有它（**用整份请求的原文**，不是指纹——指纹剥了此刻层，口径更窄）
  const sent = rig.requests.map(item => JSON.stringify(item.request)).join('\n') + '\n'
    + rig.requests.map(item => textOfRequest(item.request)).join('\n');
  for (const marker of [STARTUP_RESTART_EVENT, 'runtime-restart', 'launchedBy', 'launchedEvidence',
    'heapCap', 'death', '【框架通报 · 进程重启】']) {
    assert.equal(sent.includes(marker), false, `不该出现在请求里的字节：${marker}`);
  }
  // 正对照：同一次请求里**唤醒那一行必须在**——否则上面那六条可能只是因为整条路都坏了
  assert.ok(sent.includes('帮我看看日志'), '同一次请求里那条唤醒要在（否则上面六条不算证据）');
  // ③ 指纹那一侧同样没被它动过（两侧互为正反：指纹看不见它，是因为它本来就不该进请求）
  assert.deepEqual(
    rig.requests.map(item => `${item.lane}:${requestFingerprint(item.request)}`),
    [`heavy:${BEFORE_MANUAL_FINGERPRINT}`],
    '加了这条留痕之后，非心跳拍的请求指纹仍是改动前那一个',
  );
});

// ──────────────────────────────── ③ 调模型 ≠ 开口 ────────────────────────────────

test('③ 她不开口（spoke:false）时真实调用照样完成：两件事解耦', async (t) => {
  const rig = await runOneWake({ type: 'wake/heartbeat', data: heartbeatData(1800, 1) });
  t.after(rig.dispose);
  const events = await rig.events();

  const end = events.filter(event => event.type === 'turn/end').at(-1);
  assert.deepEqual(end?.data.reason, { kind: 'completed' });
  assert.equal(end?.data.spoke, false, '她整拍没说话——这是允许的正常结局');
  assert.equal(events.filter(event => event.type === 'message/assistant').length, 1, '但模型确实回了一次');
  assert.equal(rig.requests.length, 1, '不说话不等于不调模型：请求已经发出去了');

  // 唤醒提示：前半句一字未改（她仍然被告知"没事就接着睡"），v53 起**末尾多附一句**
  // （"这段时间是你自己的……"，逐字锁在 `test/render.test.ts` 那条同源用例里）
  const prompt = (rig.requests[0]!.request.input as Array<{ content?: unknown }>)
    .map(item => (typeof item.content === 'string' ? item.content : ''))
    .join('\n');
  assert.match(prompt, /心跳自省：无事发生是常态，看一眼待办与意图，没事就接着睡/);
  assert.match(prompt, /（没人找你。这段时间是你自己的：想做事就做一件，想跟他说句话也行。做完记得留下点东西——一句话、一条记录都行。）/);
});

// ──────────────────────────────── ④ 可审计 ────────────────────────────────

test('④ 可审计：既有事件链就能看出"这一拍是心跳驱动的真实调用"', async (t) => {
  const rig = await runOneWake({ type: 'wake/heartbeat', data: heartbeatData(1800, 1) });
  t.after(rig.dispose);
  const events = await rig.events();

  const claimed = events.find(event => event.type === 'input/claimed');
  const selected = events.find(event => event.type === 'memory/selected');
  const step = events.find(event => event.type === 'step/start');
  const consumed = events.find(event => event.type === 'budget/consumed');
  assert.ok(claimed && selected && step && consumed, '五件事实必须都在：认领 / 注入账 / 起 step / 记账');

  // `injection:'heartbeat'` 由既有的 `isHeartbeatTurn` 判据派生（agent-loop 的 planMemorySelection）：
  // 它与 step/start、budget/consumed 同现，就是"心跳驱动的真实调用"的可查凭据——没有新事件类型。
  assert.equal(selected.data.injection, 'heartbeat');
  assert.equal(selected.data.indexHash, '', '心跳轮什么都不注入（2026-10-04 的口径未动）');
  assert.equal(selected.data.entries, 0);
  assert.deepEqual(claimed.data.wakeSeqs.length, 1);
  assert.ok(selected.seq < step.seq, '装配账落在 step 之前（schema §15 的不变量）');
  assert.ok(step.seq < consumed.seq, '先起 step，再落账');
});

// ──────────────────────────────── ⑤ 同一份冻结前缀 ────────────────────────────────

test('⑤ 心跳拍与普通回合共用同一份冻结前缀（instructions / 工具清单逐字节相同）', async (t) => {
  const beat = await runOneWake({ type: 'wake/heartbeat', data: heartbeatData(1800, 1) });
  t.after(beat.dispose);
  const manual = await runOneWake({ type: 'wake/manual', data: { note: '帮我看看日志' } });
  t.after(manual.dispose);

  const a = beat.requests[0]!.request;
  const b = manual.requests[0]!.request;
  assert.equal(a.instructions, b.instructions, '人格常驻层（instructions）逐字节相同：这是被刷新的那段前缀的头');
  assert.deepEqual(
    (a.tools ?? []).map(tool => tool.name),
    (b.tools ?? []).map(tool => tool.name),
    '工具清单也共用（清单随会话变会让之后整段历史失效）',
  );
});
