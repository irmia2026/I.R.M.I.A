/**
 * Irmia Agent — 场景鉴权（2026-10-04 用户定稿）
 *
 * 这套东西的哲学前提（用户原话）：**QQ 是她手机里可以点开的社交软件，本机对话流才是她唯一的上下文。**
 * 所以权限问题不是"你是谁、配不配"，而是"**这件事是不是发生在自己家里**"。
 *
 * 由此只有两类动作：
 *   • **社交类**：说话（`speak` / `report` 是同类，只是长短与语气的分工）、看消息、发媒体。
 *     在哪个场合都开放——群里有人跟她说话，她本来就该能回。
 *   • **本机类**：文件、命令、配置、技能、定时器。碰的是这台机器，只有"最高档"的场合才给。
 *
 * 场合只有两档：
 *   • `owner`：GUI / 本机唤醒、官 bot 上**用户 id** 的会话（单聊与群聊都算）、她自己（心跳/定时器/后台）；
 *   • `guest`：除此之外——群里别人、陌生单聊、webhook，都是"软件里遇到的人"。
 *
 * 两种情景（用户 2026-10-04）：
 *   • **软提醒（默认）**：群聊轮次在上下文里附一句场景提醒，判断权留给她；
 *   • **硬拒绝（可选开启）**：群聊场合下本机类工具直接不可用。
 *
 * 三条纪律：清单恒定（缓存不废）、判在执行期、认不出按 guest 算（从严）。
 */
import type { ToolPlanGate, PlanGateCall, ToolPlanDenial } from '../tools/executor.ts';

/** 场合：最高档（自己家）还是客人（软件里遇到的人） */
export type Scenario = 'owner' | 'guest';

/**
 * **本机类工具**：碰这台机器的。
 *
 * 为什么用名单而不是给每件工具加字段：加字段要动十几处工具定义，而这张名单是"人读一眼就能
 * 核对"的东西——它是安全边界，宁可显式列出来、代码评审时看得见。**名单之外的一律当本机类**：
 * 所以将来新增工具、或 MCP 接进来的外部工具，默认都是"客人不能碰"，不需要谁记得来改这里。
 */
export const MACHINE_TOOLS: readonly string[] = [
  'pwsh',            // 在这台机器上跑命令
  'safe_write',      // 写文件
  'safe_edit',       // 改文件
  'multi_edit',      // 批量改文件
  'safe_rollback',   // 回滚文件
  'write_persona',   // 改她的人格资产
  // 定时器（v35：set_timer / cancel_timer / list_timers 并成一件，动作由 action 选）。
  //
  // 为什么整件算本机类而不是"list 那个动作算社交类"：这张名单是**按名字**核对的，
  // 它的价值就在于"人读一眼就能核对"（见上面那段）。一旦要按入参分档，它就得同时
  // 读懂 `action` 的语义才能判断，安全边界也就没法一眼看完了。
  //
  // 代价写在明面上（实测过、知情接受）：合并前 `list_timers` 在社交类名单里，
  // 所以**客人（硬拒绝档）从前能看到定时器列表，现在看不到了**。影响面很小——
  // 硬拒绝默认是关的（软提醒档下两个名单都不参与判定，一切照旧），而"客人 + 硬拒绝"
  // 是用户明确要收紧的那一档：定时器表里有她什么时候醒、要做什么（payload），
  // 收进本机类与 write_persona / pwsh 同档，方向是对的。
  'timer',           // 布防 / 撤销 / 列出定时器（会让她在无人时自己动起来）
  'http_post',       // 对外发请求（带副作用）
  'http_download',   // 往本机拉东西
];

/** 社交类：明确放行的那些（说话、看、发媒体）；其余按本机类处理 */
export const SOCIAL_TOOLS: readonly string[] = [
  'speak', 'report', 'read_channel', 'send_media', 'vision_read', 'vision_query',
  'http_get', 'todo', 'rg_search', 'es_search', 'read_blob',
  'ask_human',
];
// v42：`list_dir` 从这张名单里**移出**（工具本身也删了，列目录并进 `safe_read`）。
// 这是一次**权限语义变更，得知道**（docs/tools-audit.md §3.1 当年就点过这一条）：
//   · 改前：客人（硬拒绝档）能列目录——`list_dir` 在社交类名单里；
//   · 改后：列目录走 `safe_read`，而 `safe_read` **不在**这张名单里（也**不能**在：它能读到
//     MEMORIES/ 里关于用户的事，registry.ts 的注释写着为什么）。
//   ⇒ **客人 + 硬拒绝档从此列不了目录**。方向是收紧、安全，且硬拒绝默认是关的
//     （软提醒档下两张名单都不参与判定，一切照旧），所以实际影响只在"客人 + 硬拒绝"那一档。
//   反方向（把 safe_read 加进社交类）是**不能做**的：那等于把 MEMORIES/ 交给陌生人。

export function isMachineTool(name: string): boolean {
  if (SOCIAL_TOOLS.includes(name)) return false;
  // 名单外的一律按本机类（从严）：新工具、MCP 工具默认都不给客人
  return true;
}

// 群聊场景的提醒原文**不在这里**：它住在 `model/self-brief.ts` 的 `GROUP_SCENE_REMINDER`
// ——把这句话说出口的是渲染层（self-brief 的通知渲染），文案与用法必须同源。
// 这里从前有一份**逐字重复**的副本（连注释都写着"用户给的措辞，逐字用"），而它只被
// test/authz.test.ts 读：两份真源意味着改文案时漏一处不会红，险的是漏掉**活着的那一处**。
// 2026-10-06 随审计删掉，那份用例改成 import self-brief 里那一份
// （docs/repo-cleanliness-audit.md §2.2 A18）。要改那句话，去 self-brief.ts 改。

export interface AuthzDecision {
  allow: boolean;
  /** 拒绝时给她的一句话（她是主体，理由要她能读懂、能拿去跟人说） */
  reason?: string;
  code?: string;
}

/**
 * 硬拒绝时的拒绝理由。
 *
 * 两件事各说一半，缺一件都不行（用户 2026-10-04 的要求）：
 *   • **把规矩归到用户头上**：这不是她的洁癖、也不是框架的脾气，是**用户禁止过**。
 *     这层归属必须写出来——她是主体，这句话她要能**拿去跟群里的人复述**：
 *     "他禁止过我在群里做这个"。省掉这一句，拒得再对也像是她自己不肯配合。
 *   • **保留事实说明**：群聊场合旁边有别的人。这是她判断的依据，不是修饰。
 *
 * 最后一句给的是**出路**（要动这台机器去哪儿说），不是道歉——与 authz 的
 * "机制给事实，判断留给她"同一条口径：拒绝也要让她知道下一步。
 */
export function denyReasonFor(tool: string): string {
  return `用户禁止过在群聊场景里做这台机器上的事（${tool}）——群聊场合旁边有别的人，`
    + '我不能在这儿替他做。本机上的事请在本机或单聊里跟我说。';
}

/**
 * 判定的**唯一实现**（纯函数：不读环境、不看时钟，因此可重放、可复盘）。
 *
 * 三档：
 *   • 最高档 → 放行；
 *   • 客人 + 社交类 → 放行（社交软件里说话本来就该能说）；
 *   • 客人 + 本机类 → 硬拒绝开着就拒；没开（默认软提醒）放行——因为框架已经用那句提醒
 *     把风险讲清楚了，剩下的是她的判断（**机制给事实，判断留给她**）。
 */
export function decideAuthz(input: {
  scenario: Scenario;
  tool: string;
  hardRefusal: boolean;
}): AuthzDecision {
  if (input.scenario === 'owner') return { allow: true };
  if (!isMachineTool(input.tool)) return { allow: true };
  if (!input.hardRefusal) return { allow: true };
  return {
    allow: false,
    code: 'E_GROUP_SCENE',
    reason: denyReasonFor(input.tool),
  };
}

/** 门：执行器在每个调用前问它一次（与 plan 模式那套共用同一个挂点） */
export function createAuthzGate(input: {
  scenario: Scenario;
  hardRefusal: boolean;
  /** 拒绝时落一条事实（宿主注入；不注入就不落账，但判定照做） */
  onDenied?: (call: { tool: string; turn: number; step: number; reason: string; code: string }) => void;
}): ToolPlanGate {
  return {
    intercept(call: PlanGateCall): ToolPlanDenial | null {
      const verdict = decideAuthz({
        scenario: input.scenario,
        tool: call.tool,
        hardRefusal: input.hardRefusal,
      });
      if (verdict.allow) return null;
      const reason = verdict.reason ?? denyReasonFor(call.tool);
      const code = verdict.code ?? 'E_GROUP_SCENE';
      input.onDenied?.({ tool: call.tool, turn: call.turn, step: call.step, reason, code });
      return { content: reason, message: reason, code };
    },
  };
}
