/**
 * Irmia Agent — 活动边界（`config.trust.mode` 在工具层落地的**唯一判据**）
 *
 * 用户 2026-10-04 的原话：「能够触碰整个电脑是默认行为。其他工具也要可以。可以在 GUI 和
 * 第一次运行的引导页增加开关。完全信任 / 工作目录」。配置那一半在 `config.ts` 的
 * `TrustConfig`（`'full'` 整台电脑 / `'workspace'` 只限 `workspaceRoot`）；本模块是它在
 * **执行路径**上的落点。
 *
 * 为什么单独一个模块，而不是把这几行散进各工具：
 *   · **判据只有一处**。`boundaryRoot` 的三态决议（undefined / null / string）如果每个工具
 *     各写一遍 `ctx.boundaryRoot ?? ctx.workspaceRoot`，那"配置说 A、实际拦在 B"只是时间问题
 *     ——这个仓库刚删掉过一条**写着边界、其实没人读**的配置（`paths.workspaceAllowlist`），
 *     不留第二例。
 *   · **前缀比较也只有一处**。Windows 上大小写不敏感、正斜杠等价、末尾点与空格会被内核剥除
 *     ——这三条任何一条判漏，`C:\work-evil` 或 `C:\WORK\ ` 就能混进来。`fs/path-guard.ts` 与
 *     `tools/pwsh.ts` 是**两个工具族**，它们必须比同一套（本模块）。
 *   · 本模块**零依赖**（只用 `node:path` 的 `sep`）：谁都能 import，不会与工具族互相牵连
 *     （`tools/types.ts` 那条"工具之间不允许互相 import 实现"因此不被破坏）。
 *
 * 三种取值（与 `ToolContext.boundaryRoot` 同一份语义）：
 *   · `undefined` = **保持历史行为**：拿 `workspaceRoot` 当边界。没传它的调用点（含既有测试台、
 *     子代理、CLI 窄路径）因此一条都不用改，而"默认仍然是受限的"这件事有测试钉着。
 *   · `null`     = **不设边界**（`trust.mode: 'full'`）：整台电脑。
 *   · `string`   = 用这个根当边界（`trust.mode: 'workspace'`）：越界即拒，理由说清边界在哪。
 */

import { sep } from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

/**
 * 前缀比较用的归一化：Windows 折叠大小写与正斜杠，并去掉尾部冗余分隔符。
 *
 * 末尾点与空格必须一起剥：内核会剥除路径末端它们，于是 `C:\work\ ` 与 `C:\work` 是同一个
 * 目录——只做字符串比较而不归一，就会出现"看着在边界外、实际写进边界内"或反过来的误判。
 */
export function comparisonKey(p: string): string {
  let key = p.replaceAll('/', sep);
  if (IS_WINDOWS) {
    key = key.replace(/[ .]+$/u, '');
    key = key.toLowerCase();
  }
  while (key.length > 1 && key.endsWith(sep)) key = key.slice(0, -1);
  return key;
}

/**
 * p 是否落在 root 之内（含 root 自身）。纯字符串比较，不触盘。
 *
 * 前缀比较必须带分隔符：只比 `C:\work` 会让 `C:\workspace-evil` 混进来（实测用例在
 * `test/fs-tools.test.ts` 的 `isInside` 那一条）。
 */
export function isInside(root: string, p: string): boolean {
  const r = comparisonKey(root);
  const t = comparisonKey(p);
  if (t === r) return true;
  return t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * `ToolContext.boundaryRoot` 的三态 → **有效边界**：`null` = 不设边界，string = 边界根。
 *
 * 形参只要两个字段（而不是整个 `ToolContext`）：`env.ts` 的 `resolveGuarded`、`pwsh` 的
 * handler、`net`/`vision` 的路径解析传的都是同一个 `ctx`，但这个函数不关心 `ctx` 的其余部分。
 */
export function effectiveBoundaryRoot(ctx: {
  workspaceRoot: string;
  boundaryRoot?: string | null;
}): string | null {
  return boundaryDecision(ctx).boundary;
}

/**
 * 同上，但连"这条边界**是不是调用方显式给的**"一起交出来（只有一处判据）。
 *
 * 为什么要这个额外的一位：它决定**拒绝消息的措辞**，而这件事必须分得清——
 *   · `explicit === false`（`boundaryRoot` 缺省）：边界就是 `workspaceRoot`，是**历史行为**，
 *     措辞沿用老那句"白名单只允许工作目录内"（既有测试按它断言）；
 *   · `explicit === true`：边界来自 `config.trust.mode`，**哪怕它恰好等于 `workspaceRoot`**
 *     ——`workspace` 档的默认边界就是工作根（见 `config.ts` 的 `buildDefaults`），
 *     只比"两个路径是否相等"会把最常见的那一档误判成历史默认，于是她拿不到那句
 *     "要在这里活动该怎么改"。判据是"调用方表没表态"，不是"两个路径像不像"。
 */
export function boundaryDecision(ctx: {
  workspaceRoot: string;
  boundaryRoot?: string | null;
}): { boundary: string | null; explicit: boolean } {
  return ctx.boundaryRoot === undefined
    ? { boundary: ctx.workspaceRoot, explicit: false }
    : { boundary: ctx.boundaryRoot, explicit: true };
}

/** 边界的**范围**说明（拒绝消息里那句"现在的边界是什么"） */
export function boundaryScopeNote(boundary: string): string {
  // v64：边界只约束**写**（下面 `PathAccess` 的注释是判据）⇒ 这句也照着说清，
  // 免得她以为连读都被挡住（"读与检索不受限"是她该知道的下一步）。
  return `当前 trust.mode = 'workspace'：只约束**写**操作（写不许越出 ${boundary}）；`
    + '读与检索不受限；符号链接会被展开后再比较';
}

/**
 * 这次路径解析是**读**还是**写**（v64 口径：`trust.mode` 只作用于写）。
 *
 * 为什么要有这个类别：用户 2026-10-13 的裁决——「全盘工具就该全盘……我们的默认设置是完全信任。
 * 所以框架行为应该是：**当开启工作目录模式时，写操作被限制到自身目录内**。」
 * ⇒ 边界从"读 + 写一起挡"改成**只挡写**；读与检索（`safe_read` / `grep` / `find` / `vision_read`…）
 * 一律不受它约束（全盘就是全盘）。
 */
export type PathAccess = 'read' | 'write';

/**
 * 这次调用**要不要受信任边界约束**（读类恒为 `null`；写类沿用 `boundaryDecision` 的三态结论）。
 *
 * 形参是"已经判好的三态边界"而不是整个 ctx：调用方（`fs/path-guard.ts`）本来就要那份结论里的
 * `explicit`（拒绝措辞用），再让它自己写一遍 `access === 'read' ? null : …` 就是第二处判据。
 * **判据只此一处**：调用点只声明"我是读还是写"，**不许自己传 `null` 绕开边界**
 * （那会变成"配置说 A、工具做 B"）。`GuardOptions.access` 是**必填**参数：漏写编译不过——
 * 别让"漏一个词"静默丢掉一条边界。
 */
export function boundaryRootFor(access: PathAccess, decidedBoundary: string | null): string | null {
  return access === 'read' ? null : decidedBoundary;
}

/**
 * 边界的**出路**说明（拒绝消息里那句"怎么改"）。
 *
 * 刻意写成"请让人改"：改 `config.json` 的是用户，不是她——把一句她自己做不到的动作
 * 当作指导回给她，只会换来几轮徒劳的重试（design §4.18 第 5 条：拒绝必须给可行的下一步）。
 */
export function boundaryFixHint(boundary: string): string {
  return `要在这里活动，请让人把 config.json 的 trust.mode 改成 'full'，或把目标挪进 ${boundary}。`;
}

/**
 * 路径语义那句**唯一的话**：基准 + 具名根 + 边界只挡写（2026-10-05 立，v64 扩）。
 *
 * 为什么必须有它：`full` 档放开之后，描述里那句"必须在工作目录内"就成了**假话**，
 * 而假话的代价不是难查，是**她照着描述自我设限**——明明能写 `C:\Users\<你>\…`，她连试都不试，
 * 这个开关就等于白加。反过来也不能写成"哪都能去"：`workspace` 档下**写**越界是要被拒的
 * （v64：只挡写，读与检索不受限——见 `PathAccess`）。
 *
 * 措辞只有一份的理由与边界判定同源：同一句话在十来件工具里各写一遍，改的时候一定漏几处，
 * 于是同一件事在不同工具里说法不一。工具描述与参数描述都从这个常量取。
 *
 * ⚠ 遣词纪律（用户 2026-10-13：「注意不要导致 agent 困惑」）：**只讲事实**，不出现
 * "工作根 / 工作区"这类要她猜的词——相对基准一律写「**仓库根**」（`ctx.workspaceRoot` 的真身）。
 * 这一条有反面断言钉着（`test/path-round-trip.test.ts`：描述与提示里不许出现那两个词）。
 */
export const PATH_HINT =
  // ⚠ 长度（v64 实测的教训）：这句话在**六件工具**的描述里各出现一次 ⇒ 它每长 1 token，`tools` 段
  // 就多付 6。原来那句尾巴是"只约束写操作，读与检索不受限"（多 7 token ×6 = 42），而"只约束写"
  // 本身就把"读不受限"说完了 ⇒ 砍成现在这一版（`grep`/`find` 也因此回到"距单件硬门 ≥10 token"）。
  '路径按仓库根算（MEMORIES/、diary/ 落记忆目录）；只限工作目录那一档只约束写';

export interface OutsideBoundaryInput {
  /** 被拒的东西叫什么（用途或对象），如 `safe_read`、`工作目录`、`命令行里的路径` */
  subject: string;
  /** 解析后的真实路径（符号链接已展开） */
  effective: string;
  /** 边界根（绝对路径） */
  boundary: string;
  /**
   * 这条边界是不是"调用方没表态的历史默认"（`boundaryRoot` 缺省 ⇒ 边界就是 workspaceRoot）。
   * 是则沿用历史措辞（"白名单只允许工作目录内"）；否则说清 `trust.mode` 与怎么改。
   * 判据见 `boundaryDecision`：**不看两个路径是否相等**——`workspace` 档的默认边界正是工作根。
   */
  implicitBoundary: boolean;
}

/** 越界拒绝的完整原因：**边界在哪、为什么被拒、怎么改**，三段齐全 */
export function outsideBoundaryReason(input: OutsideBoundaryInput): string {
  const head = `${input.subject} 拒绝：解析后的真实路径 ${input.effective} 落在工作目录 ${input.boundary} 之外`;
  if (input.implicitBoundary) {
    return `${head}（白名单只允许工作目录内；符号链接会被展开后再比较）`;
  }
  return `${head}（${boundaryScopeNote(input.boundary)}）。${boundaryFixHint(input.boundary)}`;
}
