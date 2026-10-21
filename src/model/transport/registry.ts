/**
 * **协议回退的结论缓存与状态机**（设计 §2.4 / §5.2 / §6.2 的唯一实现）。
 *
 * 它回答一个问题：**这个端点（`baseUrl`）该按哪套协议发？** 以及"凭什么这么认为"。
 *
 * ## 四条不变量（每条都有对应用例，见 `test/protocol-fallback.test.ts`）
 *
 * 1. **每端点每进程只探一次**：`probeCount` 记的是"我们真的拿 Responses 试过几次"。
 *    在 `responses` 状态上第一次命中判据就切，切完**不再回探**（状态机里没有 chat→responses 的边）。
 * 2. **反判据 8 类永不切**（§2.3）：401/403、429、5xx(501 除外)、413、422/400(未命中 P4)、
 *    timeout/network/aborted、200 空产出、200 坏 JSON(非 HTML)、200+error 信封 —— 一个都不许触发
 *    切换，也**不许污染缓存**（不写任何记录）。
 *
 *    ⚠ 2026-10-21 修（评审 P2/P3 的阻塞项）：**"200" 不等于"支持 Responses"**。对端回
 *    `200 + HTML`（SPA 兜底页）、`200 + {"detail":"Not Found"}`、`200 + {}` 这三种形状时，
 *    它根本没在说 Responses 的语言——原先 P2 要求 `status >= 400`、P3 要求 `code === 'bad_shape'`，
 *    而 2xx 的解析失败**根本不经过 `httpErrorOf`**（那里只在 `!res.ok` 时被调）⇒ 两个判据在
 *    生产链路上**不可达**，heavy 每一拍都被记成 `stream_interrupted` 并退回输入（重投环）。
 *    现在证据由 `DsClient` 在"2xx 但没有产出"时**当场构造**并送进来（见 `DsClient` 的
 *    `resendOnNoOutput`），判据本身只看"回包长什么样"，不看"是谁把错误分类的"。
 * 3. **硬前置**：`evidence.delivered === true`（这一发已经吐过字）⇒ **一律不许切**（§5.4）。
 * 4. **`disabled` 最高优先**（`IRMIA_DISABLE_CHAT_FALLBACK=1`）：直接返回 `responses`、
 *    **连判据都不算**（探测计数恒 0）——"关掉就完全回到今天"。
 *
 * ## 为什么缓存键是 `baseUrl`
 *
 * `/responses` 存不存在是**端点**的属性，不是模型的属性；同一端点上 heavy/light 两条 lane
 * 不该各探一次。而两格端点本来就可以不同（`models.heavy.baseUrl` / `models.light.baseUrl`，
 * 启动期取定、`DsClient.endpointFor` 是唯一取值口）⇒ 键跟着它走：换一个端点就是另一格结论。
 */

import type { DsErrorKind } from '../ds-client.js';
import type { ModelLane } from '../../log/types.js';
import type { ModelProtocol } from './types.js';

/** 切换判据（进 `model/protocol` 事件的 `criterion` 字段） */
export type SwitchCriterion =
  | 'http_404'
  | 'http_405'
  | 'http_501'
  | 'html_body'
  | 'missing_output_shape'
  | 'error_names_endpoint'
  | 'chat_http_404'
  | 'chat_adapter_fault';

/** 一次失败的现场（由 `DsClient` 从 `DsClientError` 与"这一发交付了没有"拼出来） */
export interface FailureEvidence {
  /** HTTP 状态；传输层失败（超时/网络/中断）是 `null` */
  status: number | null;
  /** 错误正文（已按 2,000 字符截断） */
  bodyText: string | null;
  /** `DsClientError.code`（`http_404` / `bad_shape` / `timeout_silent` …） */
  code: string;
  /** `DsClientError.kind`（七类） */
  kind: DsErrorKind;
  /** ★ 硬前置：这一发有没有已经交付内容（§5.4）。`true` ⇒ 永远不切 */
  delivered: boolean;
}

/** 一次切换的结论（`DsClient.subscribeProtocol` 把它交给宿主，C-3 落成事件） */
export interface SwitchDecision {
  lane: ModelLane;
  /**
   * 发现这一刻用的模型 id（`model/protocol.model` 的唯一来源，设计 §6.2）。
   *
   * 为什么非要它：`criterion` + `status` 只回答"这个**端点**不支持"，而"哪个**模型**在这个端点上
   * 不支持"是排障时的第一个分叉（同一个 baseUrl 上 heavy/light 可以是两个模型）。
   * 空串 = 调用方不知道（只可能出现在直接调 `noteFailure` 的测试里）。
   */
  model: string;
  from: ModelProtocol;
  to: ModelProtocol | 'unavailable';
  criterion: SwitchCriterion;
  /**
   * `url` 是**端点**（`baseUrl`，已去尾斜杠）：账本要能回答"**哪个 baseUrl** 不支持"，
   * 只记 `status` 时这一格只能靠猜（设计 §6.2 的 evidence 有它，2026-10-21 补上）。
   */
  evidence: { status: number | null; url: string; bodySnippet: string | null; errorCode: string };
  /** 这个端点**第一次**被观测到"不支持"的时刻（RFC3339） */
  firstSeenAt: string;
  /** 这条结论落定的时刻（通常与 `firstSeenAt` 相同；隔离/两不通时另取） */
  decidedAt: string;
}

type EndpointState =
  | { kind: 'responses' }
  | { kind: 'chat'; criterion: SwitchCriterion; firstSeenAt: string }
  | { kind: 'unavailable'; criterion: SwitchCriterion; firstSeenAt: string }
  | { kind: 'quarantined'; fault: string; firstSeenAt: string };

/**
 * 记一次失败要交的全部东西（`DsClient` 拼好后整份递进来）。
 *
 * 为什么是对象而不是五个位置参数：`baseUrl` / `lane` / `model` / `protocol` / `evidence` 里
 * 有三个是字符串，位置传错（把 `model` 当 `lane`）编译期看不出来、运行期只会安静地记错账。
 */
export interface FailureReport {
  /** 端点（`baseUrl`，已去尾斜杠）：缓存键 + `evidence.url` */
  baseUrl: string;
  lane: ModelLane;
  /** 发现这一刻的模型 id（进 `SwitchDecision.model`；不知道就传 `''`） */
  model: string;
  /** 这一发实际用的协议（`responses` 走探测；`chat-completions` 走"两条路都不通"） */
  protocol: ModelProtocol;
  evidence: FailureEvidence;
}

/** 反判据的状态码（§2.3）：这些**永远不许**触发切换 */
const DENIED_STATUSES: ReadonlySet<number> = new Set([400, 401, 402, 403, 413, 422, 429]);
/** 传输层/内容类的失败（与协议无关，切换没有意义） */
const DENIED_KINDS: ReadonlySet<DsErrorKind> = new Set(['timeout', 'network', 'aborted', 'empty', 'rate_limited']);

const HTML_RE = /<(?:!doctype|html|title)[\s>]/iu;
const NOT_FOUND_WORDS_RE = /(?:not[\s_-]*found|unsupported|unknown|invalid|does[\s_-]*not[\s_-]*support|未找到|不支持|无此)/iu;

/**
 * **Responses 的探测判据（P1–P4，顺序即优先级，第一条命中就停）**。
 *
 * 判据的取舍理由见设计 §2.2 / §2.3；这里只重复两条最容易写错的：
 *   · P1（404/405/501）放在最前面，因为它是**唯一不需要读 body** 就能定的；
 *   · P2（HTML）必须在 P3（缺 `output` 形状）之前：HTML 解析成 JSON 一定失败，
 *     先按 HTML 定性，否则会被归成 `bad_json` 那个可重试的 `server` 类，白重试三次。
 */
export function probeResponsesUnsupported(
  evidence: FailureEvidence,
  /**
   * 这份证据是**哪套协议**回来的（缺省 `responses`，即"探测：对方支持 Responses 吗"）。
   *
   * 只有 P3 用它：chat 方向的证据若"看起来就是一份合法的 chat 回包"（有 `choices` 数组），
   * 那说明**对端其实按 chat 回了**、只是没按 SSE 发——绝不许把它读成"两条路都不通"
   * （那会在一个**能用的端点**上抛 `protocol_unavailable`）。
   */
  asProtocol: ModelProtocol = 'responses',
): SwitchCriterion | null {
  if (evidence.delivered) return null;
  if (DENIED_KINDS.has(evidence.kind)) return null;
  const status = evidence.status;
  // 5xx 里只有 501 算"未实现"；其余（含 HTML 错误页的 500）一律按反判据
  if (status !== null && status >= 500 && status !== 501) return null;
  if (status === 429 || status === 401 || status === 402 || status === 403 || status === 413) return null;

  // P1：路由不存在 / 方法不允许 / 未实现
  if (status === 404) return 'http_404';
  if (status === 405) return 'http_405';
  if (status === 501) return 'http_501';

  const body = evidence.bodyText;
  /**
   * P2：HTML 落地页 / 网关 404 页 / **SPA 兜底页**。
   *
   * ★ 2026-10-21 修（评审 blocker ①）：原来这里要求 `status >= 400`，于是"**2xx 回一张 HTML**"
   * 这种真实形状（静态站、SPA、反向代理把未知路径兜成首页）在生产链路上永远走不到判据：
   * 非流式那条路会把它归成 `bad_json`（`server` 类、可重试三次），流式那条路会把它记成
   * `stream_interrupted`（一个字都没收到）⇒ 每一拍都失败、每一拍都退回输入 ⇒ **重投环**。
   * 现在只要正文**看起来是 HTML** 就算（5xx 已在上面被挡掉；1xx/3xx 走不到这里——
   * `fetch` 自己跟随重定向）。判据为什么不是"content-type"：那个头可以对端随便写，
   * 而 body 的前 2,000 字符里有 `<!doctype` / `<html` / `<title` 是 HTML 的**内容证据**。
   */
  if (body !== null && HTML_RE.test(body) && (status === null || status >= 200)) return 'html_body';

  /**
   * P3：2xx 但回的是**别的东西**——能解析成对象，且**三个 Responses 信封的特征一个都没有**
   * （没有 `output`、没有 `error`、没有 `status`）。
   *
   * ★ 2026-10-21 修（评审 blocker ①）：原来的判据是 `evidence.code === 'bad_shape'`，而那个 code
   * 只从 `httpErrorOf` 来（**只在 `!res.ok` 时被调**）⇒ 2xx 的解析失败永远带不出这个 code，
   * P3 在真实路径上不可达。现在证据由 `DsClient` 当场构造（`code` 可能是 `bad_shape` /
   * `bad_status` / `stream_interrupted`），判据只看**形状**。
   *
   * 为什么加 `status` 这一条（原来没有）：`{"status":"in_progress"}` 这种 2xx 回包**确实**在说
   * Responses 的语言，只是状态不对（我们按 `server` 类重试是既有语义）——把它判成"这不是
   * Responses 端点"会误切。而 `{"detail":"Not Found"}` / `{}` / `{"choices":[…]}`（把 /responses
   * 路由到了 chat 端点的形状）都没有 `status` ⇒ 仍然命中。
   */
  if (status !== null && status >= 200 && status < 300 && body !== null) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (!Array.isArray(record['output']) && record['error'] === undefined && record['status'] === undefined) {
          // chat 方向的反例：`choices` 是**合法 chat 回包**的形状（对端只是没按 SSE 发），
          // 那不是"两条路都不通"——这条判断只在 `asProtocol === 'chat-completions'` 时生效，
          // 所以"把 /responses 路由到 chat 端点"（Responses 方向收到 `choices`）仍然照切。
          const chatShaped = asProtocol === 'chat-completions' && Array.isArray(record['choices']);
          if (!chatShaped) return 'missing_output_shape';
        }
      }
    } catch {
      /* P3 不适用于坏 JSON（那是 `bad_json` ⇒ 反判据；HTML 那种"坏 JSON"已由 P2 定性） */
    }
  }

  // P4：正文**同时**点名 `/responses` 与"不存在/不支持"，且两者距离够近（防误标）
  if (body !== null && status !== null && (status === 400 || status === 422 || status === 404 || status === 405 || status === 501)) {
    const dot = body.search(NOT_FOUND_WORDS_RE);
    if (dot >= 0) {
      const window = body.slice(Math.max(0, dot - 200), dot + 200);
      if (window.includes('/responses') || window.includes('responses')) return 'error_names_endpoint';
    }
  }
  if (DENIED_STATUSES.has(status ?? 0) && status !== 400 && status !== 422) return null;
  return null;
}

/** 一个端点这一刻的结论（只读视图，给观测与测试用） */
export interface EndpointView {
  state: EndpointState['kind'];
  protocol: ModelProtocol;
  /** 真的拿 Responses 试过几次（`disabled` 时恒 0） */
  probes: number;
}

/**
 * 结论缓存 + 状态机。**每进程一个**（`DsClient` 持有；测试可注入以跨 client 共享）。
 *
 * 线程/并发：Node 单线程，且这里只做同步读写 ⇒ 不需要锁。并发两发同时失败时，
 * 第一发把状态改成 `chat`，第二发再进来已经是 `chat` ⇒ 不会再写第二条结论（幂等）。
 */
export class ProtocolRegistry {
  private readonly now: () => number;
  /** `IRMIA_DISABLE_CHAT_FALLBACK=1` ⇒ 恒 `responses`、连判据都不算 */
  readonly disabled: boolean;
  private readonly state = new Map<string, EndpointState>();
  private readonly probes = new Map<string, number>();
  private readonly listeners = new Set<(decision: SwitchDecision) => void>();

  constructor(options: { now?: () => number; disabled?: boolean } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.disabled = options.disabled === true;
  }

  /**
   * 这个端点该走哪套协议（**发送侧唯一读点**）。
   *
   * ⚠ **它不是"能不能发"的判据**：`unavailable` 是"两条路都不通"（§5.2），那时这里返回
   * `'responses'` 只是为了保持"总函数"（`viewOf` / GUI / 观测都还要一个字符串）。发送之前
   * **必须先问 {@link ProtocolRegistry.isUnavailable}** —— 设计 §5.2 的口径是"不发请求、
   * 直接抛 `protocol_unavailable`"，`DsClient.exchange()` 的开头就是那道闸。
   * （2026-10-21 评审 T3：只有这个总函数时，`unavailable` 之后第 3 次调用照旧打 `/responses`。）
   */
  protocolFor(baseUrl: string): ModelProtocol {
    if (this.disabled) return 'responses';
    return this.state.get(baseUrl)?.kind === 'chat' ? 'chat-completions' : 'responses';
  }

  /**
   * 这个端点是不是**两条路都不通**（§5.2 的 `unavailable`）。
   *
   * `true` ⇒ 调用方**不许发请求**，直接抛 `DsClientError{kind:'invalid', code:'protocol_unavailable'}`。
   * 只有 `auto` 档要问它：强制档（`models.<lane>.protocol`）本来就不读 registry 的结论。
   */
  isUnavailable(baseUrl: string): boolean {
    return this.state.get(baseUrl)?.kind === 'unavailable';
  }

  /** `unavailable` 的那份结论（给 `protocol_unavailable` 的文案用；不是这个状态就是 `null`） */
  unavailableOf(baseUrl: string): { criterion: SwitchCriterion; firstSeenAt: string } | null {
    const record = this.state.get(baseUrl);
    if (record === undefined || record.kind !== 'unavailable') return null;
    return { criterion: record.criterion, firstSeenAt: record.firstSeenAt };
  }

  /** 观测：这一刻的结论 + 探测次数 */
  viewOf(baseUrl: string): EndpointView {
    const record = this.state.get(baseUrl);
    return {
      state: record?.kind ?? 'responses',
      protocol: this.protocolFor(baseUrl),
      probes: this.probes.get(baseUrl) ?? 0,
    };
  }

  /** 探测次数（"每端点每进程只探一次"那条验收的判据） */
  probeCountOf(baseUrl: string): number {
    return this.probes.get(baseUrl) ?? 0;
  }

  /** 订阅"发生了一次切换"（C-3 把它落成 `model/protocol` 事件）；返回退订函数 */
  subscribe(listener: (decision: SwitchDecision) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * 记一次失败，必要时给出**切换结论**（`null` = 这次不切）。
   *
   * 顺序：开关 → 硬前置 → 判据 → 当前状态。四步任何一步说不，就一个字节都不动（含探测计数）。
   *
   * `report.protocol` 决定问哪一侧的判据：
   *   · `responses` —— 探测（P1–P4），命中 ⇒ 切到 `chat`（每端点只探一次）；
   *   · `chat-completions` —— "**两条路都不通**"（P6）：也命中断言 ⇒ 落 `unavailable`，
   *     之后发送侧一律短路（见 {@link isUnavailable}）。
   */
  noteFailure(report: FailureReport): SwitchDecision | null {
    const { baseUrl, lane, model, protocol, evidence } = report;
    if (this.disabled) return null;          // R3：关掉就完全回到今天（连判据都不算）
    if (evidence.delivered) return null;     // §5.4 硬前置
    const current = this.state.get(baseUrl);
    if (protocol === 'responses') {
      // 只有"还没结论"时才探测（这就是"每端点每进程只探一次"）
      if (current !== undefined) return null;
      const criterion = probeResponsesUnsupported(evidence);
      // 只有**真的形成结论**才算一次探测：反判据（限流 / 5xx / 密钥错 / 超时 / 空包…）说明不了
      // 端点支持什么，记进去会把"反判据不污染探测缓存"这条验收变成空话。
      if (criterion === null) return null;
      this.probes.set(baseUrl, (this.probes.get(baseUrl) ?? 0) + 1);
      const at = new Date(this.now()).toISOString();
      this.state.set(baseUrl, { kind: 'chat', criterion, firstSeenAt: at });
      return this.notifySwitch({
        lane, model, from: 'responses', to: 'chat-completions', criterion,
        evidence: this.evidenceOf(baseUrl, evidence),
        firstSeenAt: at, decidedAt: at,
      });
    }
    // chat 侧也判据命中 ⇒ 两条路都不通（不是协议问题，是 baseUrl 填错了）。
    // `asProtocol` 必传：chat 方向的 P3 要排除"对端其实按 chat 回了一份合法 JSON"那种形状。
    const criterion = probeResponsesUnsupported({ ...evidence, delivered: false }, 'chat-completions');
    if (criterion === null) return null;
    const at = new Date(this.now()).toISOString();
    this.state.set(baseUrl, { kind: 'unavailable', criterion, firstSeenAt: at });
    return this.notifySwitch({
      lane, model, from: 'chat-completions', to: 'unavailable',
      criterion: criterion === 'http_404' ? 'chat_http_404' : criterion,
      evidence: this.evidenceOf(baseUrl, evidence),
      firstSeenAt: at, decidedAt: at,
    });
  }

  /**
   * 适配器自己炸了（R2）：把 chat 判死（本进程不再试）+ 退回 Responses。
   *
   * 判据是"**不是 `DsClientError`**"（对端的错都有 kind、会被分类表退避；我们自己的编程错误不是）。
   * 退回 `responses` 是刻意的：R2 要求"最坏结果 = 和今天一模一样的那条失败"。
   */
  noteAdapterFault(baseUrl: string, lane: ModelLane, model: string, fault: string): SwitchDecision | null {
    const current = this.state.get(baseUrl);
    if (current !== undefined && current.kind === 'quarantined') return null;
    const at = new Date(this.now()).toISOString();
    this.state.set(baseUrl, { kind: 'quarantined', fault: fault.slice(0, 500), firstSeenAt: at });
    return this.notifySwitch({
      lane, model, from: 'chat-completions', to: 'responses', criterion: 'chat_adapter_fault',
      evidence: { status: null, url: baseUrl, bodySnippet: null, errorCode: 'chat_adapter_fault' },
      firstSeenAt: at, decidedAt: at,
    });
  }

  /** 事件里的证据形状（正文只留 200 字符；`url` = 端点） */
  private evidenceOf(
    baseUrl: string,
    evidence: FailureEvidence,
  ): { status: number | null; url: string; bodySnippet: string | null; errorCode: string } {
    return {
      status: evidence.status,
      url: baseUrl,
      bodySnippet: evidence.bodyText === null ? null : evidence.bodyText.slice(0, 200),
      errorCode: evidence.code,
    };
  }

  private notifySwitch(decision: SwitchDecision): SwitchDecision {
    for (const listener of this.listeners) {
      try {
        listener(decision);
      } catch {
        /* 观测不该有能力打断请求（与 retryListeners 同一条纪律） */
      }
    }
    return decision;
  }
}
