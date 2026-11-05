import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { resolveProfileTools } from './subagent-capabilities.ts';

export type ProfileId = string;
export type ProfileTools = 'readonly' | string[];
export type ProfileWorkspace = 'own' | 'none';
export type ProfileLane = 'heavy' | 'light';

/**
 * P4.1：文件面的根。`workspace` = 会话自己的 workspace；`project` = 项目根。
 *
 * `auto`（worker 合并后新增）：会话被父代理授权了 projectRoot 就用 project，否则退回
 * workspace——编码任务与“没有项目的设计任务”共用同一个角色，不必为了后者复制一份 Profile。
 */
export type ProfileWorkdir = 'workspace' | 'project' | 'auto';
/**
 * 角色 scoped pwsh 的根（P4.5 起真正生效，见 `subagent-shell.ts`）：
 *   · `workspace` = 只给会话自己的 workspace；
 *   · `project`   = project（默认）+ 本会话 workspace（worker 需要两边都能跑）；
 *   · `auto`      = 有 projectRoot 时等同 project，否则等同 workspace；
 *   · `full`      = **仅 worker**：cwd 默认 session workspace，命令可 cd/访问任意绝对路径、
 *                   执行任意命令（不做路径/命令审计；输出上限、超时、AbortSignal、最小环境仍在）。
 *                   文件工具不受影响（仍按 workdir 收口在 project/workspace），外部目录访问走 pwsh；
 *   · `none`      = 不注入 pwsh（general/fork 永远没有）。
 *
 * ⚠ 这是 **cwd + 命令审计 + 最小环境**，不是 Windows 沙箱：不要把它宣传成“workspace-only 沙箱”。
 * 审计能挡住根外绝对路径/`..`/`cd`/嵌套 shell/家目录变量等常见越界写法，挡不住执意逃逸的进程。
 */
export type ProfileShell = 'workspace' | 'project' | 'auto' | 'full' | 'none';
/** 角色包的思考档；P4.2 起冻结进会话并原样进入模型请求。 */
export type ProfileReasoningEffort = 'low' | 'medium' | 'high' | 'max';

/**
 * worker 的 codegraph 依赖：Python 解释器之外必须真的能 import 的模块。
 *
 * 这是**动态依赖**（healthcheck 真探测 import），不是 binaries 那种“命令存在即可”：
 * 缺 tree-sitter 语法包时 code 工具只能建 Python 索引，不能假装多语言可用。
 */
export const WORKER_PYTHON_MODULES: readonly string[] = Object.freeze([
  'tree_sitter',
  'tree_sitter_javascript',
  'tree_sitter_typescript',
  'tree_sitter_go',
  'tree_sitter_rust',
  'tree_sitter_java',
  'tree_sitter_c',
  'tree_sitter_cpp',
]);

/** P4.1：角色包声明的依赖。缺失即锁定；`missing` 只回报这里的 id。 */
export interface ProfileRequires {
  skills?: string[];
  mcp?: string[];
  binaries?: string[];
  /**
   * healthcheck 逐模块 `import` 的 Python 依赖（静态锁定态不预判，见 `availability()`）。
   * 缺失 id 直接进 `missing`（worker 会被锁成 locked）。
   */
  pythonModules?: string[];
}

/** 安装清单项；P4.4 起 ref 与 sha256 均为必填，安装器只接受内置角色的 curated 来源。 */
export interface ProfileInstallSource {
  source: string;
  ref?: string;
  sha256?: string;
  /**
   * 来源许可证。builtin 来源默认按仓库自有内容视为 AGPL-3.0-only；
   * 外部 MIT/Apache 来源必须显式声明，安装器会用随包的 LICENSE 正文校验。
   */
  license?: string;
}

export interface SubagentProfile {
  id: ProfileId;
  label: string;
  description: string;
  /** Appended after the framework identity, never replaces it. */
  systemPrompt: string;
  workdir: ProfileWorkdir;
  shell: ProfileShell;
  tools: ProfileTools;
  workspace: ProfileWorkspace;
  /** P4.3 起按白名单加载 catalog，并由 skill_read 只读正文/资产。 */
  skills: string[];
  /** P4.3 起只连 curated 且安装包内声明的 MCP server。 */
  mcpServers: string[];
  reasoningEffort: ProfileReasoningEffort;
  contextLimit: number;
  /** 0.5–0.95，默认 0.7。 */
  compactAt: number;
  maxTurns?: number;
  requires?: ProfileRequires;
  install?: ProfileInstallSource[];
  /** 隐式 Profile（general）不进 `GET /api/subagents/profiles`。 */
  hidden?: boolean;
  /** 旧五件套 id 的兼容标记（不是新角色）。 */
  legacy?: boolean;
  /** 旧字段（P3.2）：仍影响执行器选路；P4.1 不新增使用。 */
  lane?: ProfileLane;
  context?: {instructions?: string; files?: string[]};
}

export interface ProfileAvailability {
  available: boolean;
  locked: boolean;
  /** 未满足的依赖 id（不含路径）。 */
  missing: string[];
}

export interface ProfileSummary {
  id: string;
  label: string;
  description: string;
  toolCount: number;
  workspace: ProfileWorkspace;
  workdir: ProfileWorkdir;
  shell: ProfileShell;
  reasoningEffort: ProfileReasoningEffort;
  contextLimit: number;
  compactAt: number;
  skills: string[];
  mcpServers: string[];
  available: boolean;
  locked: boolean;
  missing: string[];
}

/** Profile 没写 `maxTurns` 时的兜底轮数（与 general 的出厂值同档）。 */
export const DEFAULT_SUBAGENT_MAX_TURNS = 12;

/**
 * `maxTurns` 的硬上限（P3.2.1）。
 *
 * Profile 是**数据**，写一个 `maxTurns: 1e9` 就等于"没有上限"——而这一层存在的理由正是
 * "不能无限跑"。超出即夹到本值：夹的是数字，不是静默放行（`normalizeProfile` 只接受正整数，
 * 非法值直接退回兜底）。
 */
export const MAX_SUBAGENT_MAX_TURNS = 200;

/**
 * Profile `systemPrompt` 的字符上限（P3.2.1）。
 *
 * 它只**追加**在父人格 identity 之后，所以这条上限量的是"追加段最多能挤掉多少框架身份/工具契约"。
 * 超过即拒绝加载该 Profile（不截断）——截断会把一句写了一半的规则留在系统提示里。
 */
export const MAX_PROFILE_SYSTEM_PROMPT_CHARS = 8_000;

/** Profile context 装配后**总字符**上限；超过即拒绝加载该 Profile，不截断。 */
export const MAX_PROFILE_CONTEXT_CHARS = 32_768;

/** Profile context **单文件字节**上限；超过即拒绝加载该 Profile，不截断。 */
export const MAX_PROFILE_CONTEXT_FILE_BYTES = 16_384;

/** 角色包 context 窗口；P4.2 起由发送前闸执行。 */
export const DEFAULT_PROFILE_CONTEXT_LIMIT = 1_000_000;
/** 压缩阈值默认值；P4.2 起冻结进会话。 */
export const DEFAULT_PROFILE_COMPACT_AT = 0.7;
export const MIN_PROFILE_COMPACT_AT = 0.5;
export const MAX_PROFILE_COMPACT_AT = 0.95;
export const DEFAULT_PROFILE_WORKDIR: ProfileWorkdir = 'workspace';
export const DEFAULT_PROFILE_SHELL: ProfileShell = 'none';
/** general 与未显式声明的旧 Profile 保持既有 heavy/high 默认档。 */
export const DEFAULT_PROFILE_REASONING_EFFORT: ProfileReasoningEffort = 'high';

/** P4.1 起不再是 Profile 的旧 id；已有数据按 legacy 处理，不映射成新角色。 */
export const RETIRED_PROFILE_IDS: readonly string[] = ['research', 'coding', 'docs', 'review', 'ops'];

/**
 * 角色包安装登记文件（相对 `<dataDir>/subagents/`）。
 *
 * P4.1 没有安装器：这个文件就是"装了什么"的唯一事实。缺文件 = 一个都没装，
 * 因此三个角色包默认 locked。安装器（后续阶段）写它，本阶段只读。
 */
export const ROLE_PACKAGES_FILE = 'role-packages.json';

const WRITING = ['safe_read', 'read_blob', 'grep', 'find', 'safe_write', 'safe_edit', 'multi_edit', 'report'];

/**
 * 三个角色包 + 隐式 general。P4.2 接 reasoning/context，P4.3 接 workdir/受限命令/skill/MCP；
 * 角色包的安装事实与健康检查仍由锁定态单独判定。
 *
 * 2026-11-05 合并：原 `coder`（编码）与 `design`（设计）合并成 `worker`——两者都是
 * “在项目里动手”的角色，拆成两份会让父代理在“这次算编码还是设计”上先做一道无意义判断，
 * 而工具面本来就可以并集。worker 用 `workdir:'auto'`（文件面：有项目根进项目，没有就只写
 * workspace）+ `shell:'full'`（pwsh：cwd 默认 workspace，可访问任意绝对路径）表达“重度主力”，
 * 不再用两份 Profile 表达同一个区别。
 */
export const BUILTIN_PROFILES: readonly SubagentProfile[] = [
  {
    id: 'general', label: '通用', description: '最小只读后台子代理；隐式默认与兜底。',
    systemPrompt: '',
    workdir: 'workspace', shell: 'none',
    tools: 'readonly', workspace: 'own',
    skills: [], mcpServers: [], reasoningEffort: 'high',
    contextLimit: DEFAULT_PROFILE_CONTEXT_LIMIT, compactAt: DEFAULT_PROFILE_COMPACT_AT,
    lane: 'heavy', maxTurns: 12, hidden: true,
  },
  {
    id: 'researcher', label: '调研',
    description: '证据驱动的调研：检索、核对来源、归纳结论与未解决问题。',
    systemPrompt: '你是调研子代理。你的训练知识有截止时间：凭印象记得的版本、价格、政策、人物/组织现状、'
      + '产品、事件和日期都可能已过时。除不随时间变化的稳定概念外，凡涉及当前状态或“最新情况”，'
      + '必须先联网检索取证，优先官方/一手来源；不得用记忆代替最新证据，也不得把过时信息写成当前事实。'
      + '先判断任务：快速摸方向、找入口资源用 quick-research；'
      + '需要证据、统计与可审计报告用 auto-deep-research。先列问题与判据，再检索并交叉核对来源；'
      + '报告只写证据、来源与未解决问题，明确区分事实与推断。只写自己的 workspace，不执行任意命令。',
    workdir: 'workspace', shell: 'workspace',
    tools: ['read', 'write', 'network', 'report'], workspace: 'own',
    skills: ['auto-deep-research', 'quick-research'], mcpServers: [], reasoningEffort: 'max',
    contextLimit: DEFAULT_PROFILE_CONTEXT_LIMIT, compactAt: DEFAULT_PROFILE_COMPACT_AT,
    lane: 'heavy', maxTurns: 16,
    requires: {skills: ['auto-deep-research', 'quick-research']},
    install: [
      {source: 'builtin:packs/subagents/skills/auto-deep-research', ref: '0.1.0-beta.14', sha256: '78feceacb2a50ea65d7c210b0d845737a0dcbcc056a643f3db5b89f19258fae3'},
      {source: 'builtin:packs/subagents/skills/quick-research', ref: '0.1.0-beta.14', sha256: '6b022c9b71c92a3a44f06395a8216f0f0f9c7ecfcad223ec7d82b9f9f11d7150'},
    ],
  },
  {
    id: 'worker', label: '开发',
    description: '在项目根实现/修改代码，或做界面视觉评审与设计规格；用项目命令跑测试构建，用 codegraph 理解代码。',
    systemPrompt: '你是开发子代理（编码与设计合并）。开工前先判断：需求是否清楚、改动范围与风险、'
      + '是修一个小点还是跨模块/新系统；判断不清先读代码和项目约束，不要猜。'
      + '技术选型按此顺序：① 复用项目已有的成熟技术栈、依赖、模式和工具；'
      + '② 优先标准库/平台原生能力；③ 简单任务直接手写、快速完成；'
      + '④ 只有以上都不合适、且收益明确时才考虑重型开发（新框架/新服务/大重构），并先说明理由和代价。'
      + '禁止为小任务引入新框架或过度设计；能扩展现有实现就不新写，能用成熟方案就不自造轮子。'
      + '先读相关代码再改；改动尽量小，保持现有风格。'
      + '实现任务严格按：实现 → 测试 → 读取 review skill → 检查 diff/影响面 → 报告风险收尾。'
      + '设计任务先理解界面目标与约束，再输出设计规格、参考依据与逐条可验收项，指出取舍与风险。'
      + '代码索引（code 工具）只写本会话 workspace，被索引项目只读；'
      + '默认在自己的 workspace 完成工作；需要访问外部目录时用 pwsh，但只做任务必要的最小操作、不做无关改动；'
      + '父代理给了项目根就优先在项目内工作。不要直接对用户说话，用 report 回报父代理。',
    // worker 是重度主力：文件面仍按 auto（有项目根进项目、没有退回 workspace），
    // shell 用 full（cwd 默认 workspace，但可 cd/访问任意绝对路径；仅 worker 生效）。
    workdir: 'auto', shell: 'full',
    // `write` capability 展开的是 safe_write/safe_edit/multi_edit，**不含** safe_rollback
    // （回滚是 destructive 写，默认不随 capability 一起发）。worker 会做多步改动，必须能撤销
    // 自己写坏的文件，所以在这里显式点名；其他角色不扩大（general/researcher/scribe 没有它）。
    tools: ['read', 'write', 'safe_rollback', 'vision_read', 'vision_query', 'report'], workspace: 'own',
    // 设计相关四项均已随包；impeccable 为离线静态版（无引擎/下载器/遥测）。
    // MIT/Apache-2.0 许可证与 UPSTREAM.md 都在 skill 目录内。
    skills: [
      'dev-workflow', 'review', 'irmia-framework', 'plugin-dev',
      'design-taste-frontend', 'ui-ux-pro-max', 'impeccable', 'motion-design',
    ],
    mcpServers: [], reasoningEffort: 'max',
    contextLimit: DEFAULT_PROFILE_CONTEXT_LIMIT, compactAt: DEFAULT_PROFILE_COMPACT_AT,
    lane: 'heavy', maxTurns: 30,
    requires: {
      skills: [
        'dev-workflow', 'review', 'irmia-framework', 'plugin-dev',
        'design-taste-frontend', 'ui-ux-pro-max', 'impeccable', 'motion-design',
      ],
      binaries: ['node', 'npm', 'git'],
      pythonModules: [...WORKER_PYTHON_MODULES],
    },
    install: [
      {source: 'builtin:packs/subagents/skills/dev-workflow', ref: '0.1.0-beta.14', sha256: '1cd012549a0856b372e7a70c4278b4b05551a68e761ddc860cac5d6e6eceb7fd'},
      {source: 'builtin:packs/subagents/skills/review', ref: '0.1.0-beta.14', sha256: 'cc0dc605f98801e332b389f0ea9c9ebd1c50e4a7e83f0687b8df40a6fc641c40'},
      {source: 'builtin:skills/irmia-framework', ref: '0.1.0-beta.14', sha256: '2367c25014db0dd55c442ec9b1b476a9584ca48f88efc323eb9e2f56c025129b'},
      {source: 'builtin:skills/plugin-dev', ref: '0.1.0-beta.14', sha256: 'e4c06583a0d6dfccd4c074856d5b7648c17530895f9b5d060bbad6291e259b81'},
      {source: 'builtin:packs/subagents/skills/design-taste-frontend', ref: '0.1.0-beta.14', sha256: 'd2e97dd47c76f17f30c02c9e370fb67860bd28dcc23654e923e081e0411aceaa', license: 'MIT'},
      // 外部设计 skill：已 vendor 到 packs，附 LICENSE + UPSTREAM.md。
      // impeccable 是离线静态版，不含引擎/下载器；telemetry 不可用。
      {source: 'builtin:packs/subagents/skills/ui-ux-pro-max', ref: 'b7d5353e0130feb8c5574ef1251f8a1db1873ccb', sha256: '09c34772e20988410cbad347b1dc33271b4046096f2917c20e74390826267095', license: 'MIT'},
      {source: 'builtin:packs/subagents/skills/impeccable', ref: 'c8891a9ae865d6ee311836ae5199bfce0fe115b1', sha256: 'b05059761c1eb19e090644d621c136ee5dca7107d8867e5c990b253eae2ce274', license: 'Apache-2.0'},
      {source: 'builtin:packs/subagents/skills/motion-design', ref: 'f9a8a041b85185ee4881b3471d3415e939aac772', sha256: '1b0700e2b0076b2efd86eb94d84f1bb67342e90a57ff58d9d7df04b06c3a3599', license: 'MIT'},
    ],
  },
  {
    id: 'scribe', label: '秘书',
    description: '长文、文案、报告、方案与材料整理：中文写作、office、活动方案、商业计划；不写代码，不接 MCP。',
    systemPrompt: '你是秘书子代理（scribe）。先确认任务、受众、目的、格式、截止时间和事实依据；'
      + '长文/公众号/知乎优先读 learn-with-u-writer，公众号平台规则读 wechat-article，'
      + '小红书/抖音读对应 skill，周报/述职读 weekly-report，会议纪要读 meeting-notes；'
      + '活动方案策划读 event-architect，商业计划书/BP 读 sevonsss-plan；'
      + '成稿或改稿读 copywriting，需要中文语感/去模板腔读 human-writing，docx/xlsx/pdf 读 office。'
      + '不编造事实、数字、引用或资质；不确定项用清晰占位符标出。'
      + '默认在自己的 workspace 写交付物；需要跑 skill 自带脚本时可以用 pwsh，但只做任务必要的操作，不做无关改动。'
      + '交付前检查名称、日期、版本、格式和归档位置；不直接对用户说话，用 report 回报父代理。',
    workdir: 'workspace', shell: 'full',
    tools: ['read', 'write', 'report'], workspace: 'own',
    skills: [
      'office', 'copywriting', 'human-writing',
      'learn-with-u-writer', 'wechat-article', 'weekly-report', 'meeting-notes',
      'xiaohongshu-post', 'douyin-script', 'event-architect', 'sevonsss-plan',
    ], mcpServers: [], reasoningEffort: 'high',
    contextLimit: DEFAULT_PROFILE_CONTEXT_LIMIT, compactAt: DEFAULT_PROFILE_COMPACT_AT,
    lane: 'heavy', maxTurns: 20,
    requires: {
      skills: [
        'office', 'copywriting', 'human-writing',
        'learn-with-u-writer', 'wechat-article', 'weekly-report', 'meeting-notes',
        'xiaohongshu-post', 'douyin-script', 'event-architect', 'sevonsss-plan',
      ], binaries: ['python'],
    },
    install: [
      {source: 'builtin:skills/office', ref: '0.1.0-beta.14', sha256: '39063430486df73809ffb9bf6f3a63e3206614fdac9c894859b32aa08eeea882'},
      {source: 'builtin:packs/subagents/skills/copywriting', ref: '0.1.0-beta.14', sha256: '713a57aa6a6455c1a82a7ea13e7cf9db2971462fe0502d98b95c96bdbd0dce12'},
      {source: 'builtin:packs/subagents/skills/human-writing', ref: '4fda173f3fef7fb808f3eba991eeb2528ea4b189', sha256: '2ead3c6416447e8bbc17e753c810dca8d599062b7f7a9facd953e7fb05327563', license: 'MIT'},
      {source: 'builtin:packs/subagents/skills/learn-with-u-writer', ref: '0ea18574e7223663355a24ded55f40cdfa4665da', sha256: 'd47ae0f6095beb1b26787f846b0bce627c4892391ed1318af23c864af61f9ee9', license: 'MIT'},
      {source: 'builtin:packs/subagents/skills/wechat-article', ref: '51f21a0a9c1a430b1506c5495259623b7c9e2633', sha256: '7649d9cca04f5ac2720830be3d377d6de0445c2194ad648b9fbfd685cdb17939', license: 'MIT'},
      {source: 'builtin:packs/subagents/skills/weekly-report', ref: '51f21a0a9c1a430b1506c5495259623b7c9e2633', sha256: 'a7816f6a634c1c1de29221725b6a2d39f324a182fb8fdea2974e20ca944252b4', license: 'MIT'},
      {source: 'builtin:packs/subagents/skills/meeting-notes', ref: '51f21a0a9c1a430b1506c5495259623b7c9e2633', sha256: 'c35decad49d9a8cac94524bacb97fa56568b5f1c75c8f8af43d82494dcd7c05c', license: 'MIT'},
      {source: 'builtin:packs/subagents/skills/xiaohongshu-post', ref: '51f21a0a9c1a430b1506c5495259623b7c9e2633', sha256: 'c65e8f563373d1b97518bf22e1aa7c6b6e5e0a1a7952587d57f1c7a8b8b36966', license: 'MIT'},
      {source: 'builtin:packs/subagents/skills/douyin-script', ref: '51f21a0a9c1a430b1506c5495259623b7c9e2633', sha256: '7ca11e3cae537119cd420ba4b04302df36d396629ce7c849a4473748bc88f139', license: 'MIT'},
      {source: 'builtin:packs/subagents/skills/event-architect', ref: '5a0d4fded7317f9886c43bf702bd41af931a01f1', sha256: '6f57108ba9bd7043a665eb06cbdce78cfea39acf8652aad8fba6376949c4e1b5', license: 'MIT'},
      {source: 'builtin:packs/subagents/skills/sevonsss-plan', ref: '49df77fb662741da46c1eab867fde56b37c0ebe6', sha256: 'caf73f429631bbe3050a8010b31a9b4ead906bd3d8513a9ebc4824997d66b9cb', license: 'MIT'},
    ],
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 依赖 id 的安全字符集：防止 `../` 之类把文件探测带出数据目录。 */
const DEPENDENCY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]*$/u;

function isSafeDependencyId(value: string): boolean {
  return DEPENDENCY_ID_PATTERN.test(value);
}

function readEnum<T extends string>(
  raw: unknown,
  field: string,
  allowed: readonly T[],
  fallback: T,
  issues: string[],
): T {
  if (raw === undefined) return fallback;
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) return raw as T;
  issues.push(`${field} 只能是 ${allowed.join(' / ')}`);
  return fallback;
}

function readBoolean(raw: unknown, field: string, fallback: boolean, issues: string[]): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw === 'boolean') return raw;
  issues.push(`${field} 必须是布尔值`);
  return fallback;
}

function readStringList(raw: unknown, field: string, issues: string[]): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    issues.push(`${field} 必须是字符串数组`);
    return undefined;
  }
  const out: string[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== 'string') {
      issues.push(`${field}[${index}] 必须是字符串`);
      continue;
    }
    const value = item.trim();
    if (value === '') {
      issues.push(`${field}[${index}] 不能为空`);
      continue;
    }
    if (!isSafeDependencyId(value)) {
      issues.push(`${field}[${index}] "${value}" 含非法字符`);
      continue;
    }
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function readRequires(raw: unknown, issues: string[]): ProfileRequires | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    issues.push('requires 必须是对象');
    return undefined;
  }
  const out: ProfileRequires = {};
  for (const key of ['skills', 'mcp', 'binaries', 'pythonModules'] as const) {
    const values = readStringList(raw[key], `requires.${key}`, issues);
    if (values !== undefined) out[key] = values;
  }
  return out;
}

function readInstall(raw: unknown, issues: string[]): ProfileInstallSource[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    issues.push('install 必须是数组');
    return undefined;
  }
  const out: ProfileInstallSource[] = [];
  for (const [index, item] of raw.entries()) {
    if (!isRecord(item)) {
      issues.push(`install[${index}] 必须是对象`);
      continue;
    }
    const source = typeof item['source'] === 'string' ? item['source'].trim() : '';
    if (source === '' || /[\u0000-\u001f]/u.test(source)) {
      issues.push(`install[${index}].source 必须是非空且不含控制字符的字符串`);
      continue;
    }
    const entry: ProfileInstallSource = {source};
    const ref = typeof item['ref'] === 'string' ? item['ref'].trim() : '';
    if (ref === '') issues.push(`install[${index}].ref 是必填的固定 commit/tag/version`);
    else entry.ref = ref;
    const sha = typeof item['sha256'] === 'string' ? item['sha256'].trim() : '';
    if (!/^[a-fA-F0-9]{64}$/u.test(sha)) issues.push(`install[${index}].sha256 是必填的 64 位十六进制`);
    else entry.sha256 = sha.toLowerCase();
    out.push(entry);
  }
  return out;
}

function readPositiveInteger(raw: unknown, field: string, fallback: number, issues: string[]): number {
  if (raw === undefined) return fallback;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return raw;
  issues.push(`${field} 必须是正整数`);
  return fallback;
}

function readCompactAt(raw: unknown, fallback: number, issues: string[]): number {
  if (raw === undefined) return fallback;
  if (typeof raw === 'number' && Number.isFinite(raw)
    && raw >= MIN_PROFILE_COMPACT_AT && raw <= MAX_PROFILE_COMPACT_AT) {
    return raw;
  }
  issues.push(`compactAt 必须是 ${MIN_PROFILE_COMPACT_AT}–${MAX_PROFILE_COMPACT_AT} 之间的数`);
  return fallback;
}

interface NormalizeResult {
  profile: SubagentProfile | null;
  issues: string[];
}

function normalizeProfile(raw: unknown, fallbackId: string, base?: SubagentProfile): NormalizeResult {
  if (!isRecord(raw)) return {profile: null, issues: ['Profile 必须是对象']};
  const id = typeof raw['id'] === 'string' && raw['id'].trim() !== '' ? raw['id'].trim() : fallbackId;
  if (!PROFILE_ID_PATTERN.test(id)) {
    return {profile: null, issues: [`profile id "${id}" 非法（只允许小写字母开头的小写字母/数字/连字符）`]};
  }
  const fallback = base ?? BUILTIN_PROFILES.find((profile) => profile.id === id);
  const issues: string[] = [];
  const label = typeof raw['label'] === 'string' ? raw['label'] : fallback?.label ?? id;
  const description = typeof raw['description'] === 'string' ? raw['description'] : fallback?.description ?? '';
  const systemPrompt = typeof raw['systemPrompt'] === 'string' ? raw['systemPrompt'] : fallback?.systemPrompt ?? '';
  const toolsRaw = raw['tools'];
  const tools: ProfileTools = toolsRaw === 'readonly'
    ? 'readonly'
    : Array.isArray(toolsRaw) && toolsRaw.every((item) => typeof item === 'string' && item.trim() !== '')
      ? toolsRaw.map((item) => item.trim())
      : fallback?.tools ?? 'readonly';
  const workspaceRaw = raw['workspace'];
  const workspace: ProfileWorkspace = workspaceRaw === 'none' || workspaceRaw === 'own'
    ? workspaceRaw
    : fallback?.workspace ?? 'own';
  const laneRaw = raw['lane'];
  const lane: ProfileLane | undefined = laneRaw === 'heavy' || laneRaw === 'light'
    ? laneRaw : fallback?.lane;
  const maxTurns = typeof raw['maxTurns'] === 'number' && Number.isSafeInteger(raw['maxTurns']) && raw['maxTurns'] > 0
    ? raw['maxTurns'] : fallback?.maxTurns;

  const workdir = readEnum(raw['workdir'], 'workdir', ['workspace', 'project', 'auto'] as const,
    fallback?.workdir ?? DEFAULT_PROFILE_WORKDIR, issues);
  const shell = readEnum(raw['shell'], 'shell', ['workspace', 'project', 'auto', 'full', 'none'] as const,
    fallback?.shell ?? DEFAULT_PROFILE_SHELL, issues);
  const skills = readStringList(raw['skills'], 'skills', issues) ?? fallback?.skills ?? [];
  const mcpServers = readStringList(raw['mcpServers'], 'mcpServers', issues) ?? fallback?.mcpServers ?? [];
  const reasoningEffort = readEnum(raw['reasoningEffort'], 'reasoningEffort',
    ['low', 'medium', 'high', 'max'] as const,
    fallback?.reasoningEffort ?? DEFAULT_PROFILE_REASONING_EFFORT, issues);
  const contextLimit = readPositiveInteger(raw['contextLimit'], 'contextLimit',
    fallback?.contextLimit ?? DEFAULT_PROFILE_CONTEXT_LIMIT, issues);
  const compactAt = readCompactAt(raw['compactAt'], fallback?.compactAt ?? DEFAULT_PROFILE_COMPACT_AT, issues);
  const requires = readRequires(raw['requires'], issues) ?? fallback?.requires;
  const install = readInstall(raw['install'], issues) ?? fallback?.install;
  const hidden = readBoolean(raw['hidden'], 'hidden', fallback?.hidden ?? false, issues);
  const legacy = RETIRED_PROFILE_IDS.includes(id) || fallback?.legacy === true;

  if (issues.length > 0) return {profile: null, issues};

  const contextRaw = raw['context'];
  const context = isRecord(contextRaw)
    ? {
      ...(typeof contextRaw['instructions'] === 'string' ? {instructions: contextRaw['instructions']} : {}),
      ...(Array.isArray(contextRaw['files'])
        ? {files: contextRaw['files'].filter((item): item is string => typeof item === 'string' && item !== '')}
        : {}),
    }
    : fallback?.context;
  return {
    profile: {
      id, label, description, systemPrompt, workdir, shell, tools, workspace,
      skills, mcpServers, reasoningEffort, contextLimit, compactAt,
      ...(maxTurns === undefined ? {} : {maxTurns}),
      ...(requires === undefined ? {} : {requires}),
      ...(install === undefined ? {} : {install}),
      ...(hidden ? {hidden: true} : {}),
      ...(legacy ? {legacy: true} : {}),
      ...(lane === undefined ? {} : {lane}),
      ...(context === undefined ? {} : {context}),
    },
    issues: [],
  };
}

/**
 * Profile 定义级校验（P3.2.1）：返回空数组 = 可加载；非空 = **整份拒绝**。
 *
 * 拒绝而不是"过滤掉再跑"：一份写了 `speak` 的 Profile，如果只把 `speak` 摘掉、其余照发，
 * 用户看到的是"Profile 好好的"，而那行不被执行的授权永远查不出来。日志里必须留下
 * "这份配置被拒了、为什么"，下一次才不会有人以为它生效了。
 *
 * 这里查**定义本身**（不需要读盘）：工具 capability 白名单 + `systemPrompt` 字符上限。
 * context 文件的字节/字符上限要读盘，由构造末尾的 `loadContexts()` 查，超了同样整份拒绝。
 */
function profileIssues(profile: SubagentProfile): string[] {
  const issues = [...resolveProfileTools(profile).errors];
  if (profile.systemPrompt.length > MAX_PROFILE_SYSTEM_PROMPT_CHARS) {
    issues.push(`${profile.id}: systemPrompt 有 ${profile.systemPrompt.length} 字符，`
      + `超过上限 ${MAX_PROFILE_SYSTEM_PROMPT_CHARS}（它会追加在框架身份之后，不许挤掉身份与工具契约）`);
  }
  return issues;
}

/** 这份 Profile 的**有效工具名**（已展开 capability、已过白名单、report 永远保留）。 */
export function profileToolNames(profile: SubagentProfile): string[] {
  return resolveProfileTools(profile).names;
}

/**
 * Profile definitions are data, not policy: they may add role instructions and a tool allowlist,
 * but cannot replace the framework identity or grant tools outside this registry's list.
 */
export class SubagentProfileRegistry {
  private readonly profiles = new Map<string, SubagentProfile>();
  private readonly dataDir: string;
  /**
   * 装配好的 Profile context 正文（启动时读一次、校验一次）。
   *
   * 为什么是快照而不是每次 `initialText` 现读：上限判定要发生在**加载期**（"超过拒绝加载该
   * Profile"，而不是跑起来才发现），而判定与正文必须是同一份字节，否则"校验时 30KB、运行时
   * 40KB"就是另一条绕过。改了 context 文件就重启——Profile 本来就是启动期加载的数据。
   */
  private readonly contextTexts = new Map<string, string>();
  /** P4.1：已安装角色包 id（读 `<dataDir>/subagents/role-packages.json`）。 */
  private readonly installedRolePackages = new Set<string>();
  readonly errors: string[] = [];

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    for (const profile of BUILTIN_PROFILES) this.profiles.set(profile.id, profile);
    this.loadRolePackages();
    this.loadGlobal();
    this.loadPerId();
    this.loadContexts();
  }

  get(id: string): SubagentProfile | null {
    return this.profiles.get(id) ?? null;
  }

  list(): SubagentProfile[] {
    return [...this.profiles.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Profile 摘要。默认过滤 `hidden`（general）：它是隐式兜底，不参与角色包列表；
   * `includeHidden=true` 给测试/诊断用，不经过 HTTP。
   */
  summaries(includeHidden = false): ProfileSummary[] {
    return this.list()
      .filter((profile) => includeHidden || profile.hidden !== true)
      .map((profile) => {
        const availability = this.availability(profile);
        return {
          id: profile.id,
          label: profile.label,
          description: profile.description,
          toolCount: profileToolNames(profile).length,
          workspace: profile.workspace,
          workdir: profile.workdir,
          shell: profile.shell,
          reasoningEffort: profile.reasoningEffort,
          contextLimit: profile.contextLimit,
          compactAt: profile.compactAt,
          skills: [...profile.skills],
          mcpServers: [...profile.mcpServers],
          available: availability.available,
          locked: availability.locked,
          missing: [...availability.missing],
        };
      });
  }

  /** 静态锁定态：安装登记 + skill/MCP 声明；二进制、Python 模块、模型与真实 MCP 由 P4.4 healthcheck 判定。 */
  availability(profile: SubagentProfile): ProfileAvailability {
    if (profile.id === 'general') return {available: true, locked: false, missing: []};
    const missing: string[] = [];
    const requires = profile.requires;
    const declared = [
      ...(requires?.skills ?? []),
      ...(requires?.mcp ?? []),
      ...(requires?.binaries ?? []),
    ];
    if (profile.install !== undefined && !this.installedRolePackages.has(profile.id)) {
      for (const id of declared) if (!missing.includes(id)) missing.push(id);
      if (missing.length === 0) missing.push(profile.id);
    } else if (requires !== undefined) {
      for (const id of requires.skills ?? []) {
        if (!this.hasSkill(profile.id, id) && !missing.includes(id)) missing.push(id);
      }
      for (const id of requires.mcp ?? []) {
        const declaration = profile.install !== undefined
          && existsSync(join(this.dataDir, 'subagents', 'packs', profile.id, 'mcp', `${id}.json`));
        if (!declaration && !missing.includes(id)) missing.push(id);
      }
      // 静态读取保持保守：二进制是否存在由 manager 的 healthcheck 真探测后覆盖。
      for (const id of requires.binaries ?? []) if (!missing.includes(id)) missing.push(id);
      // pythonModules 刻意不静态预判：解释器可能在 PATH / 托管目录里，只有真 spawn 才知道。
      // 它由 healthcheck 逐模块 import 探测后写进 missing（缺失即 locked，不静默可用）。
    }
    return {available: missing.length === 0, locked: missing.length > 0, missing};
  }

  private hasSkill(profileId: string, id: string): boolean {
    if (!isSafeDependencyId(id)) return false;
    return existsSync(join(this.dataDir, 'subagents', 'packs', profileId, 'skills', id, 'SKILL.md'))
      || existsSync(join(this.dataDir, 'skills', id, 'SKILL.md'));
  }

  isRolePackageInstalled(id: string): boolean {
    return this.installedRolePackages.has(id);
  }

  reloadRolePackages(): void {
    this.installedRolePackages.clear();
    this.loadRolePackages();
  }

  /**
   * 已安装角色包登记。P4.4 写入 `{installed:[{id,installedAt,packHash,sources}]}`；
   * 仍接受旧字符串 id/裸数组，但动态健康检查会要求可验证的完整记录。坏文件不阻塞启动。
   */
  private loadRolePackages(): void {
    const file = join(this.dataDir, 'subagents', ROLE_PACKAGES_FILE);
    if (!existsSync(file)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    } catch {
      this.errors.push(`${ROLE_PACKAGES_FILE}: JSON 损坏，已按未安装处理`);
      return;
    }
    const rows = Array.isArray(raw)
      ? raw
      : isRecord(raw) && Array.isArray(raw['installed'])
        ? raw['installed']
        : null;
    if (rows === null) {
      this.errors.push(`${ROLE_PACKAGES_FILE}: 必须是数组或 {installed:[]}，已按未安装处理`);
      return;
    }
    for (const row of rows) {
      const id = typeof row === 'string'
        ? row
        : isRecord(row) && typeof row['id'] === 'string' ? row['id'] : '';
      if (!PROFILE_ID_PATTERN.test(id)) {
        this.errors.push(`${ROLE_PACKAGES_FILE}: 有一项不是合法角色包 id，已忽略`);
        continue;
      }
      this.installedRolePackages.add(id);
    }
  }

  /**
   * 有效工具白名单：capability 展开 + 白名单复核（见 `subagent-capabilities.ts`）。
   * `report` 永远在结果里——它只路由父代理，是子代理唯一的出口。
   */
  toolNames(profile: SubagentProfile): string[] {
    return profileToolNames(profile);
  }

  /**
   * Profile context 正文（启动时装配，见 `contextTexts` 的注释）。
   * 没有 context / 已被拒绝的 Profile 返回空串；错误在构造时记进 `errors`，这里不再抛。
   */
  contextText(id: string): string {
    return this.contextTexts.get(id) ?? '';
  }

  /**
   * 装配并校验每个 Profile 的 context（P3.2.1 限额）。
   *
   * 拒绝粒度是**整份 Profile**（要求"超过拒绝加载该 Profile，记录错误，默认拒绝，不静默截断"）：
   * 内置 Profile 被覆盖坏了就回退出厂定义（至少权限面还是出厂那份），自定义 Profile 直接移除；
   * 两种都把原因写进 `errors`（main.ts 启动时打出来）。
   */
  private loadContexts(): void {
    for (const profile of [...this.profiles.values()]) {
      const built = this.buildContext(profile);
      for (const message of built.errors) this.errors.push(message);
      if (built.fatal) {
        this.errors.push(`${profile.id}: 已拒绝加载该 Profile（context 超限，不静默截断）`);
        const builtin = BUILTIN_PROFILES.find((item) => item.id === profile.id);
        if (builtin === undefined) this.profiles.delete(profile.id);
        else this.profiles.set(profile.id, builtin);
        this.contextTexts.delete(profile.id);
        continue;
      }
      this.contextTexts.set(profile.id, built.text);
    }
  }

  /**
   * 读一个 Profile 的 context 文件并做两道上限（单文件字节 / 装配后总字符）。
   *
   * 越界/不存在/读不动都不抛（一条坏文件不该让进程起不来），但**超限是致命**：调用方据此拒绝
   * 整份 Profile。错误里只写文件名（不写绝对路径，与 `GET /api/subagents/profiles` 同一条纪律）。
   */
  private buildContext(profile: SubagentProfile): {text: string; errors: string[]; fatal: boolean} {
    const errors: string[] = [];
    const parts: string[] = [];
    let fatal = false;
    if (profile.context === undefined) return {text: '', errors, fatal};
    if (profile.context.instructions !== undefined && profile.context.instructions.trim() !== '') {
      parts.push(profile.context.instructions.trim());
    }
    const root = join(this.dataDir, 'subagents', 'profiles', profile.id);
    for (const file of profile.context.files ?? []) {
      const path = resolve(root, file);
      if (path !== root && !path.startsWith(root + sep)) {
        errors.push(`${profile.id}: context 文件越界：${file}`);
        continue;
      }
      let raw: string;
      try {
        if (!existsSync(path)) {
          errors.push(`${profile.id}: context 文件不存在：${file}`);
          continue;
        }
        raw = readFileSync(path, 'utf8');
      } catch {
        errors.push(`${profile.id}: context 文件读取失败：${file}`);
        continue;
      }
      const bytes = Buffer.byteLength(raw, 'utf8');
      if (bytes > MAX_PROFILE_CONTEXT_FILE_BYTES) {
        errors.push(`${profile.id}: context 文件 ${file} 有 ${bytes} 字节，`
          + `超过单文件上限 ${MAX_PROFILE_CONTEXT_FILE_BYTES} 字节`);
        fatal = true;
        continue;
      }
      parts.push(raw);
    }
    const text = parts.join('\n\n');
    if (text.length > MAX_PROFILE_CONTEXT_CHARS) {
      errors.push(`${profile.id}: context 共 ${text.length} 字符，超过上限 ${MAX_PROFILE_CONTEXT_CHARS}`);
      fatal = true;
    }
    return {text, errors, fatal};
  }

  private readFile(path: string, source: string, baseOf?: (id: string) => SubagentProfile | undefined): void {
    if (!existsSync(path)) return;
    let rawValue: unknown;
    try {
      rawValue = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
      this.errors.push(`${source}: JSON 损坏，已回退内置默认`);
      return;
    }
    const rows = Array.isArray(rawValue)
      ? rawValue
      : isRecord(rawValue) && Array.isArray(rawValue['profiles'])
        ? rawValue['profiles']
        : isRecord(rawValue) && typeof rawValue['id'] === 'string'
          ? [rawValue]
          : null;
    if (rows === null) {
      this.errors.push(`${source}: 必须是数组或 {profiles:[]}`);
      return;
    }
    for (const [index, row] of rows.entries()) {
      const rawId = isRecord(row) && typeof row['id'] === 'string' && row['id'].trim() !== ''
        ? row['id'].trim()
        : `profile-${index}`;
      const normalized = normalizeProfile(row, rawId, baseOf?.(rawId));
      if (normalized.profile === null) {
        const reason = normalized.issues.length > 0 ? normalized.issues.join('；') : 'Profile 形状非法';
        this.errors.push(`${source}: ${reason}；已拒绝加载该 Profile`);
        continue;
      }
      this.accept(normalized.profile, source);
    }
  }

  /**
   * 装载一份 Profile 定义：校验不过 ⇒ **不装**（保留既有那份：内置默认或上一份合法覆盖），
   * 并把理由记进 `errors`（启动时由 main.ts 打到日志）。
   */
  private accept(profile: SubagentProfile, source: string): void {
    const issues = profileIssues(profile);
    if (issues.length > 0) {
      for (const issue of issues) this.errors.push(`${source}: ${issue}；已拒绝加载该 Profile`);
      return;
    }
    this.profiles.set(profile.id, profile);
  }

  private loadGlobal(): void {
    this.readFile(join(this.dataDir, 'subagents', 'profiles.json'), 'profiles.json', (id) => this.profiles.get(id));
  }

  private loadPerId(): void {
    const dir = join(this.dataDir, 'subagents', 'profiles');
    if (!existsSync(dir)) return;
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
      this.errors.push('profiles/: 目录读取失败');
      return;
    }
    for (const name of names.sort()) {
      const id = name.slice(0, -'.json'.length);
      if (!/^[a-z][a-z0-9-]*$/u.test(id)) {
        this.errors.push(`profiles/${name}: 文件名不是合法 profile id`);
        continue;
      }
      this.readFile(join(dir, name), `profiles/${name}`, (id) => this.profiles.get(id));
    }
  }
}
