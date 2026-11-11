/**
 * Irmia Agent — 子代理 Profile 的**工具 capability 分类**（P3.2.1 硬化）
 *
 * 为什么需要这一层：P3.2 的 Profile `tools` 是一个**裸工具名数组**——写 `speak` 就拿到
 * `speak`，写 `pwsh` 就拿到 `pwsh`。也就是说"Profile 决定能做什么"这句话当时只由数据文件
 * 自己保证，而数据文件是外部输入（`data/subagents/profiles.json`；用户/插件/手滑都能写）。
 * 本模块把它翻过来：**Profile 只能申请 capability，capability 决定工具**；写工具名只是
 * "申请那件工具所属的 capability"的一种写法，且必须过同一道分类闸。
 *
 * 分类只有一处（{@link TOOL_CLASSES}），运行期与加载期共用：
 *   · **加载期**（`subagent-profiles.ts`）：Profile 声明了不可授予的条目 ⇒ **拒绝加载该 Profile**
 *     并记进 `SubagentProfileRegistry.errors`（默认拒绝，不是"过滤掉继续跑"）；
 *   · **运行期**（`subagent-manager.ts` 的 `childToolRegistry`）：再按同一份分类筛一遍
 *     （纵深防御：老 `session.json`、注入的 Profile 对象、将来新增的授予路径都绕不过它）。
 *
 * 六个面向 Profile 的 capability 与三类永不可授予的类别：
 *
 * | 类别 | 含义 | 能否授予 Profile |
 * |---|---|---|
 * | `read` | 只读文件/检索（`safe_read`/`read_blob`/`grep`/`find`） | ✅ 只在 own workspace（文件工具） |
 * | `write` | 写 own workspace 的文件 | ✅ 仅 `workspace:'own'` |
 * | `network` | 出网读写（`http_*`/`web_search`） | ✅ |
 * | `report` | 只路由**父代理**的报告通道 | ✅（永远保留） |
 * | `user-channel` | 直接对用户说话/读用户通道（`speak`/`send_media`/`read_channel`/`ask_human`） | ❌ 永远拒绝 |
 * | `recursive` | 递归创建/控制子代理（`delegate`/`subagent`/`task`） | ❌ 永远拒绝 |
 * | `unsafe` | 命令执行与系统级写入（`pwsh`/`write_persona`/`todo`/`timer`/`mcp`/`memory_read`） | ❌ 永远拒绝 |
 * | `unknown` | 不在表里的工具名（含 `mcp__*` 与插件工具） | ❌ 永远拒绝 |
 *
 * 为什么命令执行单独一类而不是并进 `write`：`pwsh` 能做的事远不止写 own workspace（它能把
 * `boundaryRoot` 之外的东西一起改掉、能出网、能起进程），把"写文件"的授权偷偷放大成"任意命令"
 * 正是这一层要防的绕过。同理 `memory_read` 读的是**父代理的记忆根**（`<dataDir>/workspace/MEMORIES`），
 * 不属于子代理的资料面，不能因为"它叫 read"就跟着 `read` 一起发下去。
 *
 * P4.5 的边界：本表仍然把 `pwsh` 归为 `unsafe`——**Profile 数据不能自己声明它**。角色能拿到的
 * 是运行时按 `profile.shell` 注入的**另一个** `pwsh`（`subagent-shell.ts`：cwd 固定 + 命令审计 +
 * 最小环境，不是沙箱）。这两件事不能混称：Profile 的 `tools` 里写 `pwsh` 依然整份拒绝。
 */

/** 六个面向 Profile 的 capability（也是 profiles.json 里可以写的 capability 名）。 */
export type ProfileCapability = 'read' | 'write' | 'network' | 'user-channel' | 'recursive' | 'report';

/** 工具的实际分类：六个 capability + 两个"永不可授予"的类别。 */
export type ToolClass = ProfileCapability | 'unsafe' | 'unknown';

/** 可授予 Profile 的 capability 白名单（`user-channel`/`recursive` 不在里面）。 */
export const GRANTABLE_CAPABILITIES: readonly ProfileCapability[] = ['read', 'write', 'network', 'report'];

/**
 * capability → 内置工具展开（**最小集**，不是"所有能归进这一类的工具"）。
 *
 * 为什么刻意小于分类面：`read` 只发四件文件工具（与 P3.2 的 `readonly` 逐字相同），
 * `vision_read`/`vision_query` 这类虽然也归 `read`，但它们要外接能力/模型，默认不发；
 * 真要它们就在 `tools` 里显式写工具名（仍过分类闸）。少发一件是安全的，多发一件不是。
 */
export const CAPABILITY_TOOLS: Readonly<Record<ProfileCapability, readonly string[]>> = Object.freeze({
  read: ['safe_read', 'read_blob', 'grep', 'find'],
  write: ['safe_write', 'safe_edit', 'multi_edit'],
  network: ['http_get', 'http_post', 'http_download', 'web_search'],
  report: ['report'],
  'user-channel': [],
  recursive: [],
});

/**
 * 内置工具 → 分类。**唯一一份**：新增内置工具必须在这里落一格，否则它默认 `unknown`
 * （不可授予）——这是有意的失败方向：忘记登记 = Profile 拿不到，而不是悄悄拿到。
 */
export const TOOL_CLASSES: Readonly<Record<string, ToolClass>> = Object.freeze({
  // 读（文件面，受 ctx.boundaryRoot 约束）
  safe_read: 'read',
  read_blob: 'read',
  grep: 'read',
  find: 'read',
  vision_read: 'read',
  vision_query: 'read',

  // 写（文件面，受 ctx.boundaryRoot 约束）
  safe_write: 'write',
  safe_edit: 'write',
  multi_edit: 'write',
  safe_rollback: 'write',

  // 网络
  http_get: 'network',
  http_post: 'network',
  http_download: 'network',
  web_search: 'network',

  // 用户通道：子代理唯一出口是 report → 父代理，永远不直接找用户
  speak: 'user-channel',
  send_media: 'user-channel',
  read_channel: 'user-channel',
  ask_human: 'user-channel',

  // 递归/控制面：schema 保留但执行期拒绝（fork 缓存契约），Profile 永不授予。
  // `subagent` 是 2026-11-05 合并后的控制面入口（status/message/cancel 三个 action），
  // 旧的 `subagent_message`/`subagent_cancel`/`subagent_status` 已不再注册。
  delegate: 'recursive',
  subagent: 'recursive',
  task: 'recursive',

  // 报告：只路由父代理
  report: 'report',

  // 命令执行/系统级写入：能越过 workspace 边界或改框架状态，永不授予
  pwsh: 'unsafe',
  write_persona: 'unsafe',
  todo: 'unsafe',
  timer: 'unsafe',
  mcp: 'unsafe',
  memory_read: 'unsafe',
});

/** Profile 里可以出现的 capability 名（含两个"可写但不可授予"，用于给出准确拒绝理由）。 */
const CAPABILITY_NAMES: readonly string[] = [
  ...GRANTABLE_CAPABILITIES, 'user-channel', 'recursive',
];

export function isCapabilityName(value: string): value is ProfileCapability {
  return CAPABILITY_NAMES.includes(value);
}

/** 工具名 → 分类；表外一律 `unknown`（含 `mcp__*` 与插件动态注册的工具）。 */
export function classifyTool(name: string): ToolClass {
  const known = TOOL_CLASSES[name];
  if (known !== undefined) return known;
  return 'unknown';
}

/** Profile 里 `tools` / `workspace` 的最小形状（不 import profiles，避免环形依赖）。 */
export interface ProfileToolPolicy {
  id: string;
  tools: 'readonly' | readonly string[];
  workspace: 'own' | 'none';
}

export interface ProfileToolResolution {
  /** 通过白名单的工具名（已展开 capability、已去重；`report` 永远保留）。 */
  names: string[];
  /** 被拒绝的条目（空数组 = 这份 Profile 的声明合法）。 */
  errors: string[];
}

/**
 * 解析一份 Profile 的 `tools` 声明。
 *
 * 两条规则：
 *   1. 条目可以是 capability 名（`read`/`write`/`network`/`report`），也可以是**具体工具名**；
 *      工具名按 {@link classifyTool} 归到 capability 再判——所以"写工具名"绕不过白名单。
 *   2. 任何一条不可授予（用户通道/递归/unsafe/unknown/写但无 workspace）⇒ 该条进 `errors`；
 *      调用方（Profile 注册表）据此**拒绝整份 Profile**，而不是"过滤掉继续跑"。
 *
 * `report` 永远补进结果：它是子代理唯一的对外出口（路由到父代理），缺了它子代理只能靠
 * 最终一条 assistant 文本，等于把"能报告进度"降级成"只能等结束"。
 */
export function resolveProfileTools(policy: ProfileToolPolicy): ProfileToolResolution {
  const errors: string[] = [];
  const names: string[] = [];
  const add = (name: string): void => {
    if (!names.includes(name)) names.push(name);
  };
  const entries: readonly string[] = policy.tools === 'readonly' ? ['read', 'report'] : policy.tools;

  for (const raw of entries) {
    const entry = raw.trim();
    if (entry === '') {
      // 空条目不会放行任何东西，但它是数据错误，按"拒绝并记录"处理
      errors.push(`${policy.id}: tools 里有空条目`);
      continue;
    }
    if (isCapabilityName(entry)) {
      if (!GRANTABLE_CAPABILITIES.includes(entry)) {
        errors.push(`${policy.id}: capability "${entry}" 不可授予子代理（用户通道/递归永远拒绝）`);
        continue;
      }
      if (entry === 'write' && policy.workspace !== 'own') {
        errors.push(`${policy.id}: workspace 为 none 时不能授予写 capability`);
        continue;
      }
      for (const name of CAPABILITY_TOOLS[entry]) add(name);
      continue;
    }

    const cls = classifyTool(entry);
    switch (cls) {
      case 'read':
      case 'network':
      case 'report':
        add(entry);
        break;
      case 'write':
        if (policy.workspace !== 'own') {
          errors.push(`${policy.id}: workspace 为 none 时不能授予写工具 "${entry}"`);
          break;
        }
        add(entry);
        break;
      case 'user-channel':
      case 'recursive':
      case 'unsafe':
      case 'unknown':
        errors.push(`${policy.id}: 工具 "${entry}" 不可由 Profile 授予（${cls}）`);
        break;
    }
  }

  // 报告通道永远保留（只路由父代理；见 reportProgress）
  for (const name of CAPABILITY_TOOLS.report) add(name);
  return {names, errors};
}

/**
 * 运行期二次判定（纵深防御）：这件工具能不能出现在 Profile 子代理的注册表里。
 * 返回 `null` = 放行；非 null = 拒绝的类别（调用方据此跳过注册）。
 *
 * 注意它判的是**类别**，不判父注册表里有没有这件工具——那一步由调用方按 `parent.get()` 决定。
 */
export function toolDenialClass(
  name: string,
  options: {allowWrites: boolean; allowFiles: boolean},
): ToolClass | null {
  const cls = classifyTool(name);
  if (cls === 'user-channel' || cls === 'recursive' || cls === 'unsafe' || cls === 'unknown') return cls;
  if (cls === 'write' && !options.allowWrites) return cls;
  // `read`/`write` 是文件面：没有 workspace 的 Profile 一件都不发
  if ((cls === 'read' || cls === 'write') && !options.allowFiles) return cls;
  return null;
}
