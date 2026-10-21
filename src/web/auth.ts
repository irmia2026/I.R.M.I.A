/**
 * 本地认证 —— 密码 + 会话凭据（2026-10，取代原来的 `data/.ui-token` 单一共享 token）
 *
 * ## 它防的是什么
 *
 * **不是**防住拿到磁盘的人：凭据文件就在 `data/` 里，能读盘的人能读它，也能直接删掉它重启
 * 重新设一次密码（那正是"忘记密码"的恢复路径）。它防的是**本机上别的程序、以及任何一个
 * 本地网页顺手打你的本地端口**——一个 `http://127.0.0.1:7788/api/config` 就能读到配置、
 * `/api/commands/*` 就能指挥这个 agent 干活。这是浏览器时代的真实攻击面：任何网页都能向
 * 回环地址发请求，而过去那套的唯一拦路虎是"猜不到那串 token"。现在换成密码，
 * 门槛从"猜 64 位 hex"变成"猜人设的密码 + 指数退避"，且**没有任何东西能被本地网页顺走**。
 *
 * ## 为什么不用 cookie
 *
 * 浏览器会自动把 cookie 附到**发往该源的任何请求**上。也就是说，只要有 cookie，
 * 一个本地网页（或任何能诱使浏览器发请求的东西）就能"借"着人的浏览器去打这个 API——
 * 那正是这套认证要防的那件事，而 cookie 恰好把它请回来。所以一律 `Authorization: Bearer`：
 * 头必须由**调用方显式写下**，浏览器不会代劳，跨源网页也就拿不到它。
 *
 * ## 凭据文件（`<dataDir>/.auth.json`）
 *
 * ```json
 * { "v": 1,
 *   "scrypt": { "salt": "<hex>", "N": 16384, "r": 8, "p": 1 },
 *   "hash": "<hex>",
 *   "sessions": [ { "id": "<hex>", "hash": "<hex>", "createdAt": "<iso>", "label": "gui" } ] }
 * ```
 *
 * **明文绝不落盘、绝不进日志**：盘上只有 scrypt 派生键（密码永不可逆）与会话凭据的
 * sha256（会话凭据是高熵随机串，不需要慢哈希——见 `SESSION_BYTES` 的说明）。
 * 日志里也只说"设了密码/登录成功/登录失败"，不带密码，也不带完整会话凭据。
 *
 * ## 与旧 token 的关系（迁移，别把人锁在外面）
 *
 * 老实例的 `data/.ui-token` 在**设密码之前照旧可用**（`authenticate` 会放行它），所以升级完
 * 立刻打开界面不会进不去。**一旦设了密码，旧 token 当场作废并从盘上删掉**——它是明文文件，
 * 一个已经不作数的密钥留在盘上只会让人误以为它还有用。这件事会落一条 `auth/password-set`
 * 事件（谁在什么时候设的密码、旧 token 已停用）。
 */

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomicSync } from './atomic.ts';

// ──────────────────────────────── 常量与参数 ────────────────────────────────

/** 凭据文件名（`<dataDir>/.auth.json`）：重置 = 删掉它重启，进程会回到「待初始化」 */
export const AUTH_FILE_NAME = '.auth.json';
/** 遗留共享 token 文件名（`<dataDir>/.ui-token`）：只读、只兼容，**不再生成** */
export const UI_TOKEN_FILE = '.ui-token';

/**
 * scrypt 参数：N=16384（2^14）、r=8、p=1。
 *
 * 三条理由，都不是拍脑袋：
 *   ① **内存代价 = 128·N·r = 16 MiB**，正好落在 Node 的 `maxmem` 默认值 32 MiB 之下——
 *      不用去抬 `maxmem`（抬了就等于给自己留一个"哪天参数被调大就把进程拖死"的坑）。
 *   ② **时间代价 ~50–120ms**（现代 x86）。这是本地交互式登录，人感觉不到；而对爆破来说，
 *      每一次猜测都要付这份 CPU 与内存，单机爆破速度被压到几十次/秒以下——再叠上退避，
 *      一个像样的密码就不是"能不能猜出来"的问题了。
 *   ③ 不取更大（N=2^15 以上）：那是给"离线拖走哈希"的场景准备的，而这里的威胁模型**明确
 *      不是**防住拿到磁盘的人（见文件头）。为一个不存在的威胁把每次登录拖到半秒，是拿体验
 *      换安心。
 *
 * `p=1`：并行度交给攻击者去选，我们这边单线程算一份就够（Node 的 scrypt 默认单线程）。
 */
export const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1 } as const;
/** 派生键长度：32 字节（256 位），与 sha256 输出同宽，够用且不长 */
export const SCRYPT_KEYLEN = 32;
/** salt 长度：16 字节 = 128 位随机。够到"同一个密码两次设出来的哈希不同"，也就废掉了彩虹表 */
export const SCRYPT_SALT_BYTES = 16;

/**
 * 会话凭据的随机字节数：32 字节（256 位）。
 *
 * 为什么它只存 sha256 而不是也过 scrypt：会话凭据是**我们自己生成的均匀随机串**，
 * 没有"人选的口令"那种低熵问题，256 位空间下爆破不可行，快哈希足够；
 * 而每个 API 请求都要验一次会话，用 scrypt 会让每次请求都付 50ms——那是拿整条 API 的
 * 延迟去换一个不存在的收益。
 */
export const SESSION_BYTES = 32;
/** 单次请求的会话数上限（FIFO 淘汰最旧的）：界面 + 脚本 + 几台机器，够用；防的是无限增长 */
export const SESSION_MAX = 32;

/** 密码长度下限：本地门锁，防的是"空密码/一位数"这种等于没设的写法 */
export const PASSWORD_MIN_LEN = 6;
/** 上限：挡住把一段文件当密码提交（scrypt 的输入长度不敏感，但没必要收 1MB） */
export const PASSWORD_MAX_LEN = 200;

/**
 * 登录退避：连续失败第 n 次之后，下一次验证前先等 `min(BASE·2^(n-1), MAX)`。
 * 第 1 次失败不罚（打错一次是人之常情），从第 2 次起 500ms、1s、2s、4s、8s 封顶。
 *
 * 为什么不是"锁死 N 分钟"：那种做法有个恶毒的性质——**任何人失败 N 次就能把用户永久锁在门外**
 * （失败计数只有登录成功才清零）。本地端口是本机任何程序都能打的，那等于把"拒绝服务"
 * 做成了认证的一部分。只涨延迟不设硬锁，攻击者要付的代价一样是指数级的，
 * 而用户自己最多多等 8 秒。
 */
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 8_000;
/**
 * 失败计数的记忆时长：超过这么久没有新的失败，就从 0 重新数。
 *
 * 有了它，退避不会变成"昨天打错两次，今天开机第一次登录先等 1 秒"那种莫名其妙的迟钝；
 * 同时对攻击者毫无帮助——他只要停手 5 分钟就得从头爬一遍指数。
 */
export const BACKOFF_DECAY_MS = 5 * 60_000;

// ──────────────────────────────── 对外形状 ────────────────────────────────

/** 盘上那份 `.auth.json` 的形状（v1）。未知字段一律忽略，读到读不懂的东西按"未初始化"处理 */
export interface AuthFileV1 {
  v: 1;
  scrypt: { salt: string; N: number; r: number; p: number };
  hash: string;
  sessions: AuthSessionRecord[];
}

export interface AuthSessionRecord {
  /** 会话标识：**不是密钥**（8 字节随机），用于撤销、事实事件与界面展示，可以进日志 */
  id: string;
  /** 会话凭据的 sha256（hex）。凭据原文只在签发那一次出现在响应体里 */
  hash: string;
  createdAt: string;
  /** 谁在用这条会话（界面/脚本自报）；只作展示与排障用，不参与任何判定 */
  label?: string;
}

/** 一次认证的结论。`via` 只说"凭什么放行的"，便于日志与测试分辨迁移期那两种来源 */
export type AuthVerdict =
  | { ok: true; via: 'session'; sessionId: string }
  | { ok: true; via: 'legacy-token' }
  | { ok: false; reason: 'uninitialized' | 'missing' | 'invalid' };

/** 签发结果（设置密码 / 登录 / 改密码成功都回这个）；失败时给 HTTP 层可直接用的状态码与代码 */
export type AuthIssue =
  | { ok: true; token: string; sessionId: string; createdAt: string }
  | { ok: false; status: number; code: string; message: string };

export interface AuthStoreOptions {
  dataDir: string;
  now: () => Date;
  /** 诊断输出；缺省静默（调用方一般传服务端的 write） */
  out?: ((line: string) => void) | undefined;
  /**
   * 遗留 token 覆盖点（测试用）。缺省读 `<dataDir>/.ui-token`；
   * 显式给 `null` = "这个实例没有旧 token"。
   */
  legacyToken?: string | null | undefined;
  /**
   * 退避睡眠的覆盖点（测试用）；缺省真的等。
   *
   * 为什么要留这个注入口：退避的**时间表**才是被测的行为，而"真的睡 8 秒"只会让测试变慢、
   * 还测不准（机器一忙就不准）。注入一个记账函数，就能逐次断言"第 n 次失败之后该等多少"。
   */
  wait?: ((ms: number) => Promise<void>) | undefined;
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

/** scrypt 的 Promise 包装：用异步版而不是 `scryptSync`，别让一次登录把整个事件循环按住 100ms */
function scryptAsync(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(
      password,
      salt,
      SCRYPT_KEYLEN,
      { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r * 2 },
      (err, derived) => {
        if (err !== null && err !== undefined) reject(err);
        else resolve(derived as Buffer);
      },
    );
  });
}

/** 退避睡眠：只用在"这次登录要验密码"之前。ms <= 0 直接返回（绝大多数登录都属于这种） */
async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

// ──────────────────────────────── 凭据库 ────────────────────────────────

export class AuthStore {
  private readonly dataDir: string;
  private readonly now: () => Date;
  private readonly write: (line: string) => void;
  private readonly wait: (ms: number) => Promise<void>;

  /** 盘上那份的解码结果；null = 还没设过密码（或文件读不懂，见 `load`） */
  private file: AuthFileV1 | null = null;
  /** 遗留共享 token；null = 没有。设了密码之后恒为 null（那条路当场作废） */
  private legacyToken: string | null;

  /** 连续登录失败次数与最后一次失败时刻（退避与衰减都靠这两个数） */
  private failures = 0;
  private lastFailureAt = 0;

  constructor(options: AuthStoreOptions) {
    this.dataDir = options.dataDir;
    this.now = options.now;
    this.write = options.out ?? (() => {});
    this.wait = options.wait ?? sleep;
    this.legacyToken = options.legacyToken !== undefined
      ? (options.legacyToken === null ? null : options.legacyToken.trim())
      : readLegacyToken(options.dataDir);
    this.file = this.load();

    if (this.file !== null && this.legacyToken !== null) {
      // 老实例 + 已经设过密码：说明密码是在别处设的（或盘上那份是手改出来的）。
      // 与"设密码时作废旧 token"同一条口径，这里补一次，别留下两条都能进的路。
      this.disableLegacyToken('启动时发现已设密码');
    }
  }

  // ── 读取与落盘 ──

  /**
   * 读凭据文件。
   *
   * 读不懂（不存在 / 不是 JSON / 形状不对 / 版本不认识）**一律按"未初始化"处理**，
   * 而不是拒绝启动：恢复路径本来就叫"删掉这个文件重启"（本地场景的标准做法），
   * 而一个坏文件把人永久锁在门外才是真正的事故。这里只把事实说出来，不静默吞掉。
   */
  private load(): AuthFileV1 | null {
    let raw: string;
    try {
      raw = readFileSync(join(this.dataDir, AUTH_FILE_NAME), 'utf8');
    } catch {
      return null; // 文件不存在 = 首次启动，正常路径
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.write(`[认证] ${AUTH_FILE_NAME} 不是合法 JSON，按「还没设密码」处理；重新设一次密码即可覆盖它`);
      return null;
    }
    if (!isRecord(parsed) || parsed['v'] !== 1) {
      this.write(`[认证] ${AUTH_FILE_NAME} 的形状不认识（v≠1），按「还没设密码」处理；重新设一次密码即可覆盖它`);
      return null;
    }
    const scrypt = parsed['scrypt'];
    const hash = parsed['hash'];
    if (!isRecord(scrypt) || typeof hash !== 'string' || hash === '') {
      this.write(`[认证] ${AUTH_FILE_NAME} 缺少 scrypt/hash 字段，按「还没设密码」处理`);
      return null;
    }
    const salt = scrypt['salt'];
    const N = scrypt['N'];
    const r = scrypt['r'];
    const p = scrypt['p'];
    // 参数范围校验（不只是"类型对"）：这份文件是**盘上可改的**，一个被改成 N=2^30 的文件
    // 会让下一次登录去申请几十 GB 内存——那是一个"读一份 JSON 就能打死进程"的坑。
    // 上下界按 scrypt 自身的要求（N 是 2 的幂）与我们只用过的参数给足余量。
    if (
      typeof salt !== 'string' || salt === ''
      || typeof N !== 'number' || typeof r !== 'number' || typeof p !== 'number'
      || !Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)
      || N < 2 || N > 1 << 20 || (N & (N - 1)) !== 0
      || r < 1 || r > 32 || p < 1 || p > 16
    ) {
      this.write(`[认证] ${AUTH_FILE_NAME} 的 scrypt 参数不合法，按「还没设密码」处理`);
      return null;
    }

    // 会话逐条校验：坏的那条丢掉而不是整份作废——一条脏会话不该让用户重新登录
    const sessions: AuthSessionRecord[] = [];
    const rawSessions = parsed['sessions'];
    if (Array.isArray(rawSessions)) {
      for (const item of rawSessions) {
        if (!isRecord(item)) continue;
        const id = item['id'];
        const itemHash = item['hash'];
        const createdAt = item['createdAt'];
        if (typeof id !== 'string' || typeof itemHash !== 'string' || typeof createdAt !== 'string') continue;
        if (id === '' || itemHash === '') continue;
        const record: AuthSessionRecord = { id, hash: itemHash, createdAt };
        const label = item['label'];
        if (typeof label === 'string' && label !== '') record.label = label;
        sessions.push(record);
      }
    }
    return { v: 1, scrypt: { salt, N, r, p }, hash, sessions };
  }

  private save(): void {
    if (this.file === null) return;
    writeFileAtomicSync(join(this.dataDir, AUTH_FILE_NAME), `${JSON.stringify(this.file, null, 2)}\n`);
  }

  // ── 状态 ──

  /** 设过密码没有。false = 服务端处于「待初始化」，只放行设置密码这一条路 */
  get initialized(): boolean {
    return this.file !== null;
  }

  /** 遗留 token 是否还在放行（老实例、还没设密码时才可能为 true） */
  get legacyTokenActive(): boolean {
    return this.legacyToken !== null;
  }

  /** 当前有效会话条数（界面上的"已登录设备"与测试用） */
  get sessionCount(): number {
    return this.file?.sessions.length ?? 0;
  }

  /** 下一次登录要等多久（毫秒）：界面上如实告诉人"还要等 N 秒"，比默默转圈强 */
  backoffMs(): number {
    this.decayIfStale();
    if (this.failures <= 1) return 0;
    return Math.min(BACKOFF_BASE_MS * 2 ** (this.failures - 2), BACKOFF_MAX_MS);
  }

  /** 停手足够久就把失败计数清零（见 [BACKOFF_DECAY_MS]） */
  private decayIfStale(): void {
    if (this.failures === 0) return;
    if (this.now().getTime() - this.lastFailureAt < BACKOFF_DECAY_MS) return;
    this.failures = 0;
    this.lastFailureAt = 0;
  }

  private noteFailure(): void {
    this.decayIfStale();
    this.failures += 1;
    this.lastFailureAt = this.now().getTime();
  }

  private noteSuccess(): void {
    this.failures = 0;
    this.lastFailureAt = 0;
  }

  // ── 认证 ──

  /**
   * 判定一个 Bearer 凭据。**这是 `/api/*` 与 `/webhook/*` 共用的唯一入口**——
   * 两条路各写一套判据的话，"界面上进不去但 webhook 还能打"这类错迟早出现。
   *
   * 三种结论有意分得很开，因为调用方要给三种不同的答复：
   *   · 还没设密码（`uninitialized`）——把话说明白："请先在界面里设置一个密码"；
   *   · 有密码但凭据缺失/不对（`missing` / `invalid`）——"会话凭据无效或已失效，请重新登录"；
   *   · 迁移期那份遗留 token（`legacy-token`）。
   *
   * 未初始化时**不管有没有传凭据都回 `uninitialized`**（除非那正好是遗留 token）：
   * 门还没装，说什么"凭据无效"都是误导；界面也正是靠这个码决定弹"设置密码"还是"登录"。
   */
  authenticate(provided: string): AuthVerdict {
    const value = provided.trim();

    if (this.file === null) {
      if (value !== '' && this.legacyToken !== null && equalHex(value, this.legacyToken)) {
        return { ok: true, via: 'legacy-token' };
      }
      return { ok: false, reason: 'uninitialized' };
    }

    if (value === '') return { ok: false, reason: 'missing' };
    const hash = sha256Hex(value);
    for (const session of this.file.sessions) {
      if (equalHex(session.hash, hash)) return { ok: true, via: 'session', sessionId: session.id };
    }
    return { ok: false, reason: 'invalid' };
  }

  // ── 设置 / 登录 / 登出 / 改密码 ──

  /**
   * 首次设密码：**立刻签发一条会话**（设完就是登录态），人不必再输一遍。
   * 已经设过就拒绝（409）——那说明有人在拿设置端点当"重置密码"用，
   * 而重置密码必须物理接触那份文件（删掉重启），不能是一个网络请求。
   */
  async setup(password: string, label?: string): Promise<AuthIssue> {
    if (this.file !== null) {
      return {
        ok: false, status: 409, code: 'already-initialized',
        message: '这台实例已经设过密码了。忘记密码的处理办法：删掉 data/.auth.json 后重启进程，再设一次。',
      };
    }
    const problem = passwordProblem(password);
    if (problem !== null) return { ok: false, status: 400, code: 'password-too-weak', message: problem };

    const salt = randomBytes(SCRYPT_SALT_BYTES);
    const derived = await scryptAsync(password, salt, SCRYPT_PARAMS);
    this.file = {
      v: 1,
      scrypt: { salt: salt.toString('hex'), ...SCRYPT_PARAMS },
      hash: derived.toString('hex'),
      sessions: [],
    };
    // 旧 token 在这一刻作废：先作废再签发，免得中间那一刹那两条路都在
    const disabled = this.disableLegacyToken('已设置密码');
    const issued = this.issue(label);
    this.save();
    this.noteSuccess();
    this.write(`[认证] 已设置密码（会话 ${issued.ok ? issued.sessionId : '?'}）；旧 token ${disabled ? '已作废' : '本来就不存在'}`);
    return issued.ok ? issued : { ok: false, status: 500, code: 'internal', message: '签发会话失败' };
  }

  /**
   * 登录。失败一律回同一句话（不区分"密码错了"与"没设过密码"以外的信息），
   * 并让调用方**先等完退避再验**——退避放在验之前，攻击者连"这次猜得对不对"都要等。
   */
  async login(password: string, label?: string): Promise<AuthIssue> {
    const file = this.file;
    if (file === null) {
      return {
        ok: false, status: 401, code: 'auth-uninitialized',
        message: '这台实例还没设密码。请先在界面里设置一个密码。',
      };
    }

    const wait = this.backoffMs();
    // 一律过一遍 wait（含 0）：测试注入的记账函数要看到**完整**的时间表，sleep(0) 本身是空操作
    await this.wait(wait);

    const params = file.scrypt;
    const derived = await scryptAsync(password, Buffer.from(params.salt, 'hex'), params);
    if (!equalHex(derived.toString('hex'), file.hash)) {
      this.noteFailure();
      const next = this.backoffMs();
      return {
        ok: false, status: 401, code: 'bad-password',
        message: next > 0
          ? `密码不对。连续失败后会退避：下一次尝试前要等约 ${Math.ceil(next / 1000)} 秒。`
          : '密码不对。',
      };
    }

    this.noteSuccess();
    const issued = this.issue(label);
    this.save();
    this.write(`[认证] 登录成功（会话 ${issued.ok ? issued.sessionId : '?'}）`);
    return issued.ok ? issued : { ok: false, status: 500, code: 'internal', message: '签发会话失败' };
  }

  /** 登出：撤销这条会话。找不到也算成功（本来就不在，结果一致）——幂等比报错好用 */
  logout(token: string): boolean {
    if (this.file === null) return false;
    const hash = sha256Hex(token.trim());
    const before = this.file.sessions.length;
    this.file.sessions = this.file.sessions.filter((session) => !equalHex(session.hash, hash));
    const removed = this.file.sessions.length !== before;
    if (removed) {
      this.save();
      this.write('[认证] 已登出并撤销该会话');
    }
    return removed;
  }

  /**
   * 改密码：旧密码必须对；改完**所有旧会话一律失效**（密码一换，之前发出去的凭据就不再代表
   * "知道密码的人"），随后给调用方签发一条**新**会话——那不是"旧会话"，人不必重新登录一次。
   */
  async changePassword(oldPassword: string, newPassword: string, label?: string): Promise<AuthIssue> {
    const file = this.file;
    if (file === null) {
      return {
        ok: false, status: 401, code: 'auth-uninitialized',
        message: '这台实例还没设密码，请走「设置密码」。',
      };
    }
    const wait = this.backoffMs();
    // 一律过一遍 wait（含 0）：测试注入的记账函数要看到**完整**的时间表，sleep(0) 本身是空操作
    await this.wait(wait);

    const params = file.scrypt;
    const derived = await scryptAsync(oldPassword, Buffer.from(params.salt, 'hex'), params);
    if (!equalHex(derived.toString('hex'), file.hash)) {
      this.noteFailure();
      return { ok: false, status: 401, code: 'bad-password', message: '当前密码不对。' };
    }
    const problem = passwordProblem(newPassword);
    if (problem !== null) return { ok: false, status: 400, code: 'password-too-weak', message: problem };

    const salt = randomBytes(SCRYPT_SALT_BYTES);
    const next = await scryptAsync(newPassword, salt, SCRYPT_PARAMS);
    const revoked = file.sessions.length;
    this.file = {
      v: 1,
      scrypt: { salt: salt.toString('hex'), ...SCRYPT_PARAMS },
      hash: next.toString('hex'),
      sessions: [],
    };
    const disabled = this.disableLegacyToken('已改密码');
    const issued = this.issue(label);
    this.save();
    this.noteSuccess();
    this.write(`[认证] 已改密码：${revoked} 条旧会话全部失效；旧 token ${disabled ? '已作废' : '本来就不存在'}`);
    return issued.ok ? issued : { ok: false, status: 500, code: 'internal', message: '签发会话失败' };
  }

  // ── 会话签发与旧 token 作废 ──

  /** 签发一条会话：高熵随机串给调用方，盘上只留 sha256 与一个非密钥的 id */
  private issue(label?: string): AuthIssue {
    if (this.file === null) return { ok: false, status: 500, code: 'internal', message: '凭据库还没初始化' };
    const token = randomBytes(SESSION_BYTES).toString('base64url');
    const record: AuthSessionRecord = {
      id: randomBytes(8).toString('hex'),
      hash: sha256Hex(token),
      createdAt: this.now().toISOString(),
    };
    const clean = label?.trim();
    if (clean !== undefined && clean !== '') record.label = clean.slice(0, 40);

    this.file.sessions.push(record);
    // FIFO 淘汰：会话不设过期（本地长期无人值守，隔三差五被踢出去比多留几条凭据更烦人），
    // 所以必须有个上限兜住"越登越多"
    if (this.file.sessions.length > SESSION_MAX) {
      this.file.sessions = this.file.sessions.slice(-SESSION_MAX);
    }
    return { ok: true, token, sessionId: record.id, createdAt: record.createdAt };
  }

  /**
   * 作废遗留 token：内存里置空 + **从盘上删掉**。
   *
   * 为什么删而不是留着（2026-10-04 定稿，B11 收尾）：它是一份明文密钥，而它已经不作数了。
   * 留着只会让下一个读 `data/.ui-token` 的脚本以为"我还进得去"（然后收到 401 一头雾水），
   * 也让盘上多一个无用的秘密。**不改成改名保留**（`.ui-token.disabled` 这类）：那等于把一份
   * 作废的明文密钥永久留在盘上，而"它为什么突然不好使了"这件事，日志里已经有一句话
   * （下面两行 `[认证] … 已作废并删除`）。删文件失败不算错（只影响整洁），内存里那份才是判据。
   *
   * **这段兼容什么时候可以拆**：读那份 token 的唯一理由，是"老实例还没设过密码、
   * 人手上只有它"。判据是**内测里不再有这类实例**——到那时 `authenticate` 里那条放行分支、
   * `UI_TOKEN_FILE` 这个常量与 `web/server.ts` 里的同名副本可以一起删掉，
   * 并把 `docs/schema.md` 里遗留 token 那一段标成历史。删之前先确认没有人的 `data/.ui-token`
   * 还在被使用（它是只读、不再生成的，所以只会变少、不会变多）。
   */
  private disableLegacyToken(why: string): boolean {
    if (this.legacyToken === null) return false;
    this.legacyToken = null;
    try {
      unlinkSync(join(this.dataDir, UI_TOKEN_FILE));
      this.write(`[认证] ${why}：旧共享 token（${UI_TOKEN_FILE}）已作废并删除`);
    } catch {
      this.write(`[认证] ${why}：旧共享 token 已作废（${UI_TOKEN_FILE} 删不掉，但它不再被接受）`);
    }
    return true;
  }
}

/** 读遗留 token：读不到/太短（那必然是手改坏的）都当没有 */
export function readLegacyToken(dataDir: string): string | null {
  try {
    const text = readFileSync(join(dataDir, UI_TOKEN_FILE), 'utf8').trim();
    return text.length >= 16 ? text : null;
  } catch {
    return null;
  }
}

/** 密码强度检查：返回人话的问题描述，null = 通过 */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LEN) {
    return `密码至少 ${PASSWORD_MIN_LEN} 位（现在 ${password.length} 位）。`;
  }
  if (password.length > PASSWORD_MAX_LEN) {
    return `密码最长 ${PASSWORD_MAX_LEN} 位（现在 ${password.length} 位）。`;
  }
  if (password.trim() === '') return '密码不能全是空白字符。';
  return null;
}
