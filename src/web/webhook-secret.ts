/**
 * webhook 专用凭据 —— 与界面会话凭据**分开**的一份密钥（B9，2026-10）
 *
 * ## 它解决的是什么（这一节就是这一项存在的理由）
 *
 * 在此之前，`/webhook/*` 与 `/api/*` 共用同一份凭据（界面登录后的会话凭据，或迁移期那份
 * `data/.ui-token`）。于是任何要给这个 agent 投东西的外部系统（监控告警、别台机器上的脚本、
 * Home Assistant……）都必须拿到**界面会话凭据**。那份东西有两个要命的性质：
 *
 *   ① **它会随"改密码 / 登出 / 换台机器"失效**——外部脚本半夜悄悄开始收 401，
 *      而故障现场（"我明明配好的"）在另一台机器上，谁都想不到是用户昨天在界面上改了密码；
 *   ② **它同时能读整个 `/api/*`**——她的记忆、人格文件、完整事件日志、配置、密钥掩码。
 *      一个只需要"投一条告警进来"的监控脚本，顺手拿到了这个人的全部内心与全部运维面。
 *
 * 所以这里给的是一条**只够投递**的凭据：`/webhook/*` 认它，`/api/*` 一律 401。
 * 换句话说，权限的方向是**单向**的——它能写一条 `wake/webhook`，读不到任何东西。
 *
 * ## 收窄的代价（必须说清，因为它是真的）
 *
 * 这一天之前，已经配好的外部脚本**会当场断**（它们拿的是会话凭据）。这是有意的取舍：
 * 留着会话凭据继续能打 `/webhook/*`，等于这一项什么都没做——那条通道照旧挂着界面的全部权限。
 * 所以口径写进三处，让断掉的人查得到原因：401 响应体、服务端诊断输出（`[webhook] …`）、
 * `docs/operations.md` §4.2。**旧的 `.ui-token` 同样不再放行 webhook**（它是明文文件，
 * 权限与界面会话凭据完全等同，没有任何理由让它在这条通道上继续有效）。
 *
 * ## 凭据文件（`<dataDir>/.webhook-secret.json`）
 *
 * ```json
 * { "v": 1,
 *   "id": "<hex>",                 // 8 字节随机，**不是密钥**：给事件、日志与界面引用它用
 *   "hash": "<hex>",               // 凭据原文的 sha256 —— 盘上只有它
 *   "createdAt": "<iso>",
 *   "rotatedAt": "<iso>" | null,   // 最后一次轮换时刻（首次生成时 null）
 *   "by": "<label>" }              // 谁生成的（界面/脚本自报，只作展示）
 * ```
 *
 * 三条纪律，与 `web/auth.ts` 同源：
 *   · **明文只在生成的那一刻回给调用方一次**（响应体里那个 `token`），之后盘上、内存里、
 *     日志里、事件里都只有哈希或那个非密钥的 `id`；
 *   · **首次启动不自动生成**：没有外部系统要投东西时它就是一份凭空多出来的秘密——
 *     没人要的秘密没人会去轮换，也没人记得它在哪儿。要它的人按一次「生成」；
 *   · **轮换 = 覆盖**：新值落盘成功之后才换内存里那份，旧值当场失效。反过来的顺序
 *     （先换内存再写盘）会造出"这次能用、重启后失效"的鬼故事。
 *
 * ## 为什么只存 sha256，不像密码那样过 scrypt
 *
 * 与 `SESSION_BYTES` 同一条理由：这是**我们自己生成的均匀随机串**（256 位），没有"人选的口令"
 * 那种低熵问题，快哈希足够。而 `/webhook/*` 是热路径——外部的每一次投递都要验一次，
 * 用 scrypt 等于给每个回调加 50–120ms 延迟，换的是一个不存在的收益。
 *
 * ## 为什么不塞进 `data/.auth.json`
 *
 * 那个文件的恢复路径是「删掉它重启，重新设一次密码」——把 webhook 凭据放进去，一次忘记密码
 * 就会顺手把外部投递全打断；反过来，"轮换 webhook 凭据"也不该有能力碰界面那扇门。
 * 两份秘密、两条生命周期、两个文件。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomicSync } from './atomic.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 凭据文件名（`<dataDir>/.webhook-secret.json`）：与 `.auth.json` 同一层、同一套纪律 */
export const WEBHOOK_SECRET_FILE_NAME = '.webhook-secret.json';

/**
 * 凭据的随机字节数：32 字节（256 位），base64url 编码后 43 个字符。
 *
 * 与界面会话凭据同宽（`auth.ts` 的 `SESSION_BYTES`），但**不共用那个常量**：两份凭据的
 * 生命周期互不相干，将来任何一份要调宽度时，不该顺手把另一份也改掉。
 */
export const WEBHOOK_SECRET_BYTES = 32;

// ──────────────────────────────── 对外形状 ────────────────────────────────

/** 盘上那份 `.webhook-secret.json` 的形状（v1）。未知字段一律忽略 */
export interface WebhookSecretFileV1 {
  v: 1;
  /** 标识（**不是密钥**）：8 字节随机 hex，可进日志、事件与界面 */
  id: string;
  /** 凭据原文的 sha256（hex） */
  hash: string;
  createdAt: string;
  /** 最后一次轮换时刻；首次生成时为 null */
  rotatedAt: string | null;
  /** 谁生成的（界面/脚本自报的 label）；只作展示，不参与任何判定 */
  by?: string;
}

/**
 * 一次 webhook 认证的结论。
 *
 * 四种失败分得很开，因为调用方要给的答复不一样：
 *   · `unconfigured` —— 这台实例从来没生成过专用凭据（连界面都没按过那个按钮）；
 *   · `missing`      —— 配了凭据，但请求里没带；
 *   · `previous`     —— 带的正是**上一份**（已轮换掉的）凭据：调用方还没换，这是最有用的那条线索；
 *   · `invalid`      —— 别的什么东西（界面会话凭据、`.ui-token`、打错的串都落这里）。
 *
 * `previous` 只在**内存里**认得出来（旧哈希不落盘）：它是一条诊断线索，不是一条认证通路。
 */
export type WebhookVerdict =
  | { ok: true; secretId: string }
  | { ok: false; reason: 'unconfigured' | 'missing' | 'previous' | 'invalid' };

/** 轮换结果；失败时给 HTTP 层可直接用的状态码与代码（照 `auth.ts` 的 `AuthIssue`） */
export type WebhookRotateResult =
  | {
    ok: true;
    /** **明文，只在这里出现这一次** */
    token: string;
    secretId: string;
    createdAt: string;
    /** 这次是首次生成还是轮换 */
    action: 'generate' | 'rotate';
    /** 被顶掉的那份的 id（首次生成时 null）——不是密钥，可以记事件 */
    previousSecretId: string | null;
  }
  | { ok: false; status: number; code: string; message: string };

/** 状态视图（给界面画那张卡）：**绝不含凭据原文，也不含哈希** */
export interface WebhookSecretView {
  configured: boolean;
  secretId: string | null;
  createdAt: string | null;
  rotatedAt: string | null;
  by: string | null;
  /** 凭据文件路径（界面上写清"它在哪儿"，排障时省一轮问答） */
  file: string;
}

export interface WebhookSecretOptions {
  dataDir: string;
  now: () => Date;
  /** 诊断输出；缺省静默（调用方一般传服务端的 write） */
  out?: ((line: string) => void) | undefined;
}

// ──────────────────────────────── 小工具 ────────────────────────────────

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 常量时间比较（等长 hex）；长度不同直接 false——`timingSafeEqual` 要求等长 buffer */
function equalHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ──────────────────────────────── 凭据库 ────────────────────────────────

export class WebhookSecretStore {
  private readonly dataDir: string;
  private readonly now: () => Date;
  private readonly write: (line: string) => void;

  /** 盘上那份的解码结果；null = 从来没生成过（或文件读不懂，见 `load`） */
  private file: WebhookSecretFileV1 | null = null;
  /**
   * 上一份凭据的哈希——**只在内存里**，只用来回答"你拿的是不是刚被换掉的那份"。
   *
   * 为什么不落盘：它已经不作数了，落盘就等于把一份废密钥的指纹永久留在盘上（与 `auth.ts`
   * 里"作废的 `.ui-token` 删掉而不是改名留着"同一条取舍）。重启后这个线索就没了，
   * 那没关系——它只影响一条日志措辞，不影响任何判定。
   */
  private previousHash: string | null = null;

  constructor(options: WebhookSecretOptions) {
    this.dataDir = options.dataDir;
    this.now = options.now;
    this.write = options.out ?? (() => {});
    this.file = this.load();
  }

  // ── 读取与落盘 ──

  /**
   * 读凭据文件。
   *
   * 读不懂（不存在 / 不是 JSON / 形状不对 / 版本不认识）**一律按"还没生成"处理**：
   * 门锁文件坏掉时正确的行为是"这扇门先不开"（401 会把话说明白），而不是拒绝启动，
   * 也不是拿一份读不懂的东西去做比较。这里只把事实说出来，不静默吞掉。
   */
  private load(): WebhookSecretFileV1 | null {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return null; // 文件不存在 = 从没生成过，正常路径
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.write(`[webhook] ${WEBHOOK_SECRET_FILE_NAME} 不是合法 JSON，按「还没生成专用凭据」处理；重新生成一次即可覆盖它`);
      return null;
    }
    if (!isRecord(parsed) || parsed['v'] !== 1) {
      this.write(`[webhook] ${WEBHOOK_SECRET_FILE_NAME} 的形状不认识（v≠1），按「还没生成专用凭据」处理`);
      return null;
    }
    const id = parsed['id'];
    const hash = parsed['hash'];
    const createdAt = parsed['createdAt'];
    if (typeof id !== 'string' || id === '' || typeof hash !== 'string' || hash === ''
      || typeof createdAt !== 'string') {
      this.write(`[webhook] ${WEBHOOK_SECRET_FILE_NAME} 缺少 id/hash/createdAt 字段，按「还没生成专用凭据」处理`);
      return null;
    }
    const rotatedAt = typeof parsed['rotatedAt'] === 'string' ? parsed['rotatedAt'] : null;
    const record: WebhookSecretFileV1 = { v: 1, id, hash, createdAt, rotatedAt };
    const by = parsed['by'];
    if (typeof by === 'string' && by !== '') record.by = by;
    return record;
  }

  private save(): void {
    if (this.file === null) return;
    writeFileAtomicSync(this.path, `${JSON.stringify(this.file, null, 2)}\n`);
  }

  // ── 状态 ──

  /** 凭据文件绝对路径（界面展示与排障用） */
  get path(): string {
    return join(this.dataDir, WEBHOOK_SECRET_FILE_NAME);
  }

  /** 生成过没有。false = 这台实例的 `/webhook/*` 一律 401 */
  get configured(): boolean {
    return this.file !== null;
  }

  /** 当前凭据的标识（不是密钥）；没生成过时 null */
  get secretId(): string | null {
    return this.file?.id ?? null;
  }

  view(): WebhookSecretView {
    const file = this.file;
    return {
      configured: file !== null,
      secretId: file?.id ?? null,
      createdAt: file?.createdAt ?? null,
      rotatedAt: file?.rotatedAt ?? null,
      by: file?.by ?? null,
      file: this.path,
    };
  }

  // ── 认证 ──

  /**
   * 判定一个 Bearer 凭据。**这是 `/webhook/*` 唯一的判据**——`/api/*` 走的是
   * `AuthStore.authenticate`，两份凭据互不通用，这正是这一项要的结果。
   *
   * 比较的是 sha256（常量时间）；盘上有的也只是 sha256，所以这个函数不可能"吐回"原文。
   */
  authenticate(provided: string): WebhookVerdict {
    const file = this.file;
    if (file === null) return { ok: false, reason: 'unconfigured' };

    const value = provided.trim();
    if (value === '') return { ok: false, reason: 'missing' };

    const hash = sha256Hex(value);
    if (equalHex(file.hash, hash)) return { ok: true, secretId: file.id };
    // 上一份（刚被轮换掉的）：认得出，但**不放行**——只为了让日志与 401 说得准
    if (this.previousHash !== null && equalHex(this.previousHash, hash)) {
      return { ok: false, reason: 'previous' };
    }
    return { ok: false, reason: 'invalid' };
  }

  // ── 生成 / 轮换 ──

  /**
   * 生成或轮换专用凭据（同一个动作：这个通道的凭据永远只有一份，没有"多把钥匙"的形态）。
   *
   * 顺序是**先落盘、后换内存**，这一点是有意的：写盘失败时旧值仍然有效、盘上也没变，
   * 调用方拿到一句"没成"就可以照旧投递；反过来先换内存的话，会出现"这次请求成功、
   * 重启之后同一份凭据失效"这种查不出来的鬼故事。
   *
   * 落盘之后内存里那份新值**立刻生效**，旧值同时失效（它的哈希被覆盖掉了）——
   * "当场失效"就是这一步的全部意义，所以这里不留任何宽限期。
   */
  rotate(by?: string): WebhookRotateResult {
    const token = randomBytes(WEBHOOK_SECRET_BYTES).toString('base64url');
    const nowIso = this.now().toISOString();
    const previous = this.file;
    const label = by?.trim().slice(0, 40);

    const next: WebhookSecretFileV1 = {
      v: 1,
      id: randomBytes(8).toString('hex'),
      hash: sha256Hex(token),
      createdAt: previous?.createdAt ?? nowIso,
      rotatedAt: previous === null ? null : nowIso,
      ...(label !== undefined && label !== '' ? { by: label } : {}),
    };
    this.file = next;
    try {
      this.save();
    } catch (err) {
      // 回滚：盘上没变，内存里也不该变（两组状态必须一致，否则"这次能用、重启就失效"）
      this.file = previous;
      const reason = err instanceof Error ? err.message : String(err);
      this.write(`[webhook] 生成专用凭据失败：${WEBHOOK_SECRET_FILE_NAME} 写不进去（${reason}）；旧凭据照旧有效`);
      return {
        ok: false,
        status: 500,
        code: 'write-failed',
        message: `写不进凭据文件 ${this.path}（${reason}）。旧凭据仍然有效，可以稍后再试。`,
      };
    }

    this.previousHash = previous?.hash ?? null;
    return {
      ok: true,
      token,
      secretId: next.id,
      createdAt: next.createdAt,
      action: previous === null ? 'generate' : 'rotate',
      previousSecretId: previous?.id ?? null,
    };
  }
}
