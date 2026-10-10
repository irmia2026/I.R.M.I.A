/**
 * Irmia Agent — 工具注册表（docs/schema.md §10、docs/design.md §4.5 / §4.10 / §4.18）
 *
 * 职责边界：本模块只管「登记契约 + 查询 + 进模型清单的取舍」，不执行任何工具。
 * 执行在 tools/executor.ts；注册表在执行期间是可变的（工具可以自己注册新工具），
 * 因此执行器在每次启动一组调用前都要回来重读 `executionMode`。
 *
 * 契约来源唯一：ToolDefinition / ToolContext / ToolHandlerResult 定义在 tools/types.ts
 * （schema §10 的接口层），这里只做复出（re-export），绝不另行声明一份——
 * 两份同名契约迟早会漂移，而"工具的接口"必须只有一个答案。
 *
 * 三条必须在实现里守住的口径：
 * 1. `executionMode(name)` 每次都查表，不做缓存。前一个调用的结果可能改变注册表
 *    （动态注册/卸载工具），一次性分类完会让新模式失效（schema §10 明文约束）。
 * 2. `destructive` 默认不进模型清单。design §4.10 第三级门："有副作用的工具必须在配置里
 *    显式开启才会注册给模型"——默认不放是安全默认，不是遗漏。拦截点在这里，不在提示词里。
 * 3. 描述预算审查：每件工具描述 ≤100 token（design §4.18）。超预算拒绝注册，
 *    因为工具清单是随每次请求发送的常驻开销（约 20 件 ≤2k token）。
 *
 * 约定：值导入写 `.ts`（Node 的 --experimental-strip-types 只擦类型、不改写路径解析），
 * 纯类型导入写 `.js`。
 */
import type { SideEffect } from '../log/types.js';
import type {
  ToolContext, ToolDefinition, ToolExecutionMode, ToolHandlerResult,
} from './types.js';

// 契约复出：调用方从 registry 拿到的就是 types.ts 里那份定义，不会出现两个版本
export type {
  ToolContext, ToolDefinition, ToolExecutionMode, ToolHandlerResult,
} from './types.js';

export type { SideEffect } from '../log/types.js';

// ──────────────────────────────── 注册表自己的类型 ────────────────────────────────

/** 并发模式短名：与契约层的 ToolExecutionMode 是同一个字面量联合，只是注册表对外用短名 */
export type ExecutionMode = ToolExecutionMode;

// ──────────────────────────────── 描述预算 ────────────────────────────────

/** 单件工具描述 token 上限（design §4.18） */
export const MAX_DESCRIPTION_TOKENS = 100;

/** 全清单常驻 token 的观测参考值（design §4.18：约 20 件 ≤2k）。超出不拒绝，只作为告警线索 */
export const CATALOG_TOKEN_REFERENCE = 2000;

/**
 * 零依赖 token 估算（design §4.12）：中文约 1.5 字/token，英文约 4 字符/token。
 * 不引 tokenizer：这个数只用于预算门与观测，几成误差由软阈值机制吸收。
 */
const CJK_RE = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/;

export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

/** 描述超预算。拒绝注册时抛这个，便于上层区分「描述太大要精简」与「代码写错了」 */
export class ToolDescriptionBudgetError extends Error {
  readonly toolName: string;
  readonly tokens: number;
  readonly limit: number;

  constructor(toolName: string, tokens: number, limit: number) {
    super(
      `工具 ${toolName} 的描述估算 ${tokens} token，超过单件预算 ${limit} token（design.md §4.18）：`
      + `工具清单随每次请求常驻发送，请精简描述后重新注册`,
    );
    this.name = 'ToolDescriptionBudgetError';
    this.toolName = toolName;
    this.tokens = tokens;
    this.limit = limit;
  }
}

// ──────────────────────────────── 对外选项 ────────────────────────────────

export interface RegisterOptions {
  /** 允许覆盖同名工具（MCP tools/list_changed 刷新、运行时重注册走这条路）；默认 false */
  replace?: boolean;
}

export interface ListForModelOptions {
  /**
   * destructive 工具的开关，三态：
   * 不传/false → 一件都不列（默认，安全默认）；true → 全列；数组 → 只列名单内的。
   */
  includeDestructive?: boolean | readonly string[];
  /**
   * **严格白名单**：给了它就**只列这些件**，其余一概不出现（destructive 与否都拦）。
   *
   * 与 `includeDestructive` 的区别是"排除法"与"列举法"：前者是"除了危险的那些都给"，
   * 后者是"只有这些能给"。给外部来源（群里的人、陌生人、webhook）用后者——
   * `safe_read` / `rg_search` 都不是 destructive，但它们能读到 MEMORIES/
   * 里关于用户的事，对陌生人同样不该给。见 `runtime/trust.ts`。
   */
  allowOnly?: readonly string[];
}

/** 交给模型的工具说明（不含 handler，渲染层可以直接序列化） */
export interface ToolModelSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

// ──────────────────────────────── 注册表 ────────────────────────────────

const NAME_RE = /^\S+$/;
const NAME_MAX_LENGTH = 64;
const MODES: readonly ExecutionMode[] = ['parallel', 'exclusive'];
const SIDE_EFFECTS: readonly SideEffect[] = ['none', 'idempotent', 'destructive'];

export class ToolRegistry {
  /**
   * Map 保持插入顺序：模型清单顺序必须稳定（design §4.13 渲染确定性），
   * 不排序、不按注册时间抖动。覆盖同名工具不改变它原有的位置。
   */
  private readonly defs = new Map<string, ToolDefinition>();

  /** 用户在设置里关掉的工具（config.tools.disabled）；只在内存，重启后由配置重新装载 */
  private readonly disabled = new Set<string>();

  get size(): number {
    return this.defs.size;
  }

  /** 登记一件工具。校验失败一律抛错——注册期是最后一道能便宜拦住的关口 */
  register(def: ToolDefinition, options: RegisterOptions = {}): void {
    assertDefinition(def);
    if (this.defs.has(def.name) && options.replace !== true) {
      throw new Error(
        `工具 ${def.name} 已经注册过：要覆盖请显式传 { replace: true }（MCP 刷新与运行时重注册走这条路）`,
      );
    }
    this.defs.set(def.name, def);
  }

  /** 卸载工具（MCP server 退出、skill 卸载）。返回是否真的删掉了 */
  unregister(name: string): boolean {
    return this.defs.delete(name);
  }

  get(name: string): ToolDefinition | null {
    return this.defs.get(name) ?? null;
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }

  /** 全部已注册工具名（含 destructive），按注册顺序 */
  names(): string[] {
    return [...this.defs.keys()];
  }

  /**
   * 每次调用重新查表，绝不缓存（schema §10：executionMode 在每次启动一组前重新读取）。
   * 未知工具返回 'exclusive'：让它单独成组、前后成为屏障——执行器随后会把它换成一条
   * 「未知工具 + 可用清单」的错误结果，保守分组不会让它与真正的副作用调用重叠。
   */
  executionMode(name: string): ExecutionMode {
    return this.defs.get(name)?.executionMode ?? 'exclusive';
  }

  /** 进模型清单的工具（按注册顺序）。destructive 默认不列，配置显式开启才进；被关闭的不列 */
  listForModel(options: ListForModelOptions = {}): ToolModelSpec[] {
    const specs: ToolModelSpec[] = [];
    for (const def of this.defs.values()) {
      if (this.disabled.has(def.name)) continue;
      if (!isVisible(def, options)) continue;
      const spec: ToolModelSpec = {
        name: def.name,
        description: def.description,
        parameters: def.parameters,
      };
      if (def.outputSchema !== undefined) spec.outputSchema = def.outputSchema;
      specs.push(spec);
    }
    return specs;
  }

  /**
   * 关闭/开启一批工具（设置界面的开关，config.tools.disabled）。
   *
   * 语义是「从她眼前拿掉」而不是「删掉这件工具」：`names()` 仍然列得出来（界面要显示
   * 一件工具存在但关着），`get()` 也仍然拿得到定义（执行到半路时才能给出一句像样的
   * 「这件工具已关闭」而不是「未知工具」）。
   *
   * 名单外的名字直接忽略：配置里留着已不存在的工具名（版本回退、MCP 未连）不该让装配报错。
   */
  setDisabled(names: readonly string[]): void {
    this.disabled.clear();
    for (const name of names) {
      if (this.defs.has(name)) this.disabled.add(name);
    }
  }

  /** 这件工具是否被用户在设置里关掉了 */
  isDisabled(name: string): boolean {
    return this.disabled.has(name);
  }

  /** 当前被关闭的工具名单（按注册顺序，供界面与诊断回显） */
  disabledNames(): string[] {
    return this.names().filter(name => this.disabled.has(name));
  }

  /**
   * 全清单常驻 token 估算（design §4.18 的 2k 观测线）。只读指标：超线不拒绝注册，
   * 但它意味着每轮请求都在为工具说明付费，应该在评审时处理。
   */
  catalogTokens(options: ListForModelOptions = {}): number {
    let total = 0;
    for (const spec of this.listForModel(options)) {
      total += estimateTokens(spec.name) + estimateTokens(spec.description);
      total += estimateTokens(JSON.stringify(spec.parameters) ?? '');
    }
    return total;
  }
}

// ──────────────────────────────── 校验 ────────────────────────────────

function isVisible(def: ToolDefinition, options: ListForModelOptions): boolean {
  // allowOnly 是比 destructive 更硬的一道：它列的**只有**这些件，其余一律不出现。
  // 用在"本轮不是用户/她自己发起的"那些轮次上（见 runtime/trust.ts）——外部来源
  // （群里的人、陌生人、webhook）能看到的工具是**严格白名单**而不是"非 destructive 的那些"：
  // safe_read / rg_search 都能读到 MEMORIES/ 里关于用户的事，它们不是 destructive，
  // 但对一个群里来的陌生人来说同样不该给。
  if (options.allowOnly !== undefined) return options.allowOnly.includes(def.name);
  if (def.sideEffect !== 'destructive') return true;
  const policy = options.includeDestructive;
  if (policy === undefined || policy === false) return false;
  if (policy === true) return true;
  return policy.includes(def.name);
}

function assertDefinition(def: ToolDefinition): void {
  if (typeof def.name !== 'string' || !NAME_RE.test(def.name) || def.name.length > NAME_MAX_LENGTH) {
    throw new Error(
      `工具名必须是 1-${NAME_MAX_LENGTH} 个不含空白的字符（收到 ${JSON.stringify(def.name)}）：`
      + '命名空间用 mcp__{server}__{tool} 这类前缀，不要用空格',
    );
  }
  if (typeof def.description !== 'string' || def.description.trim().length === 0) {
    throw new Error(`工具 ${def.name} 的描述不能为空：描述就是提示工程（design.md §4.18 五原则第 5 条）`);
  }
  const tokens = estimateTokens(def.description);
  if (tokens > MAX_DESCRIPTION_TOKENS) {
    throw new ToolDescriptionBudgetError(def.name, tokens, MAX_DESCRIPTION_TOKENS);
  }
  if (typeof def.parameters !== 'object' || def.parameters === null || Array.isArray(def.parameters)) {
    throw new Error(`工具 ${def.name} 的 parameters 必须是 JSON Schema 对象`);
  }
  if (def.outputSchema !== undefined
    && (typeof def.outputSchema !== 'object' || def.outputSchema === null || Array.isArray(def.outputSchema))) {
    throw new Error(`工具 ${def.name} 的 outputSchema 必须是 JSON Schema 对象`);
  }
  if (!MODES.includes(def.executionMode)) {
    throw new Error(`工具 ${def.name} 的 executionMode 只能是 parallel 或 exclusive，收到 ${JSON.stringify(def.executionMode)}`);
  }
  if (!SIDE_EFFECTS.includes(def.sideEffect)) {
    throw new Error(`工具 ${def.name} 的 sideEffect 只能是 none/idempotent/destructive，收到 ${JSON.stringify(def.sideEffect)}`);
  }
  if (!Number.isInteger(def.timeoutMs) || def.timeoutMs <= 0) {
    throw new Error(`工具 ${def.name} 的 timeoutMs 必须是正整数毫秒，收到 ${JSON.stringify(def.timeoutMs)}`);
  }
  if (typeof def.handler !== 'function') {
    throw new Error(`工具 ${def.name} 缺少 handler`);
  }
}
