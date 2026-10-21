/**
 * Irmia Agent — 「这一轮为什么没开口」的唯一一处口径（`turn/end.idleReason`，2026-10-19 加）
 *
 * 为什么要这一格：`turn/end` 早就回答了"她说过话没有"（`spoke`）与"这一轮怎么收的场"
 * （`reason`），却答不了**沉默轮**里那句最该有人味的问话——"你为什么没说话"。沉默在旧日志里
 * 只剩一个 `spoke:false`，事后无从查证（外部研究 dsh-bili-whale 把这一条列为最值得学的一条：
 * **每个"不作为"都得给一句人话理由**，不许只写"跳过"）。
 *
 * 三条纪律（改它之前先读）：
 *   ① **纯事件层**：它不进请求体（`turn/end` 是 internal）、不改任何既有事件的语义与
 *      `TurnEndReason`、也**不动 `RENDER_VERSION`**（`model/render.ts` 一个字节都没改）；
 *   ② **枚举封闭**：`code` 只有七个值，读侧认不出的一律归 `other`，且 **note 原样保留**
 *      ——"不认识的字符串"不等于"没有理由"，整格丢掉就是把唯一的人话线索扔了；
 *   ③ **缺省 = 未记录**：老日志没有这一格 ⇒ 读侧给 `null`，**不是错误**
 *      （日志只追加、历史不改写；界面/CLI 把它显示成"未记录"）。
 *
 * 写侧"什么时候写"的判据只在 `runtime/agent-loop.ts` 的 `idleReasonFor` 一处；本文件只放
 * 形状的归一与那句"人话"的判定，读侧（CLI/报告/GUI）共用同一份，不再各写一遍。
 */

import type { IdleReason, IdleReasonCode } from './types.js';

// ──────────────────────────────── 常量 ────────────────────────────────

/**
 * `note` 的字数上限（**码点**：按码点切，不切坏代理对）。
 *
 * 与 `JOB_WAKE_EXCERPT_CHARS` 同一条口径（"取开头、按码点切"）：note 是**回看线索**，
 * 不是她的原话存档——她那句话本身已经在 `message/reasoning` 里逐字落库。80 字足够放下
 * "今天有点累，先不说话了"这一句，又不至于让一条 turn/end 膨胀。
 */
export const IDLE_REASON_NOTE_MAX_CHARS = 80;

/** `code` 的封闭枚举（顺序即读侧文档序；**写侧只许这七个值**） */
export const IDLE_REASON_CODES: readonly IdleReasonCode[] = [
  'tired',
  'unwell',
  'busy',
  'nothing_worth_saying',
  'waiting_for_owner',
  'quiet_hours',
  'other',
];

/**
 * `code` → 一句人话（CLI 摘要与将来的 GUI 共用；**不是给模型的文案**）。
 *
 * 为什么要有它：`code` 是给程序与 grep 用的稳定标识，而这一格存在的理由是**给人看**。
 * 两处各写一份措辞，迟早读成两件事。
 */
export const IDLE_REASON_TEXT: Readonly<Record<IdleReasonCode, string>> = {
  tired: '累了',
  unwell: '不舒服',
  busy: '在忙',
  nothing_worth_saying: '没有要说的',
  waiting_for_owner: '在等用户',
  quiet_hours: '安静时段',
  other: '别的原因',
};

/**
 * 写侧的关键词表：**便宜的一刀，不是理解**。
 *
 * 为什么只做关键词而不做"语义判断"：这一格是**观测**，判错的代价由 `note` 兜底——note 里存的是
 * 她那句话的原文开头，回看的人一眼能核对，所以宁可给一个粗判的 code，也不为了"准"去多花一次
 * 模型调用（那会把一条观测变成一轮开销）。判不出来一律 `other` + 原样 note。
 *
 * 顺序即优先级：更具体/更少见的说法排前面。例如"太晚了，他睡了，不吵他"里有"太晚"，
 * 该归 `quiet_hours` 而不是"累了"；"等用户回来再说"该归 `waiting_for_owner` 而不是"在忙"。
 */
const IDLE_REASON_KEYWORDS: readonly (readonly [IdleReasonCode, readonly string[]])[] = [
  ['waiting_for_owner', ['等你', '等用户', '等回复', '等答复', '等确认', '等他', '等人']],
  ['busy', ['忙着', '有点忙', '很忙', '太忙', '忙不过来', '顾不上', '走不开', '抽不出', '赶时间', '手头有事']],
  ['unwell', ['不舒服', '难受', '头疼', '头痛', '生病', '发烧', '头晕', '胃疼', '反胃', '恶心']],
  ['quiet_hours', ['太晚', '夜深', '深夜', '半夜', '这个点', '安静时段']],
  ['tired', ['累了', '有点累', '很累', '好累', '疲惫', '困了', '很困', '好困', '没精神', '想睡', '熬夜', '没睡好', '歇一会', '歇一会儿']],
  ['nothing_worth_saying', ['没什么好说', '没什么可说', '没什么值得说', '没什么要说', '没必要说', '不必说', '无需', '无事', '没什么事', '不太重要', '不值一提']],
];

// ──────────────────────────────── 判定 ────────────────────────────────

/** 这个字符串是不是那七个 `code` 之一（读侧的封闭性判据，只此一处） */
export function isIdleReasonCode(value: unknown): value is IdleReasonCode {
  return typeof value === 'string' && (IDLE_REASON_CODES as readonly string[]).includes(value);
}

/**
 * 把一段话压成"一句"note：**单行、首尾去白、≤{@link IDLE_REASON_NOTE_MAX_CHARS} 码点**。
 *
 * 为什么压成单行：note 的读者是 `irmia tail` 的一行摘要与日志 grep——换行会把"一条事件一行"
 * 这条纪律打破（CLI 的 `clip` 对别的字段也是这么处理的）。原文一个字都不改，只把空白收成空格。
 * 空串/没给 ⇒ `null`（**不写这一格**，而不是写一个空字符串）。
 */
export function idleReasonNoteOf(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (flat === '') return null;
  const chars = Array.from(flat);
  return chars.length <= IDLE_REASON_NOTE_MAX_CHARS
    ? flat
    : chars.slice(0, IDLE_REASON_NOTE_MAX_CHARS).join('');
}

/**
 * 她那句话 → `code`（关键词表见上；判不出来 = `other`，**不是**丢回未记录）。
 *
 * 扫的是**全文**，不是截断后的 note：理由可能落在那句话的后半截，而 note 只取开头一截
 * （两者口径不同，理由写在 `IDLE_REASON_NOTE_MAX_CHARS` / `idleReasonFromText` 的注释里）。
 */
export function idleReasonCodeOf(text: string): IdleReasonCode {
  for (const [code, words] of IDLE_REASON_KEYWORDS) {
    if (words.some(word => text.includes(word))) return code;
  }
  return 'other';
}

/**
 * 写侧：从她那句话拼一格 `idleReason`（**note 跟着 code 一起走**）。
 *
 * 两种输入，两种输出，界线只有一条——**有没有那句话**：
 *   · 有 ⇒ `{ code, note }`：code 判自全文，note 取开头 ≤80 字（`null` 只会在空串时出现）；
 *   · 没有（空串/空白）⇒ 只有 `code: 'nothing_worth_saying'`：**不编一句她没说过的话**。
 *
 * 纯机械路径（没有模型参与）**不要调这个函数**——那条路连一句话都不存在，直接在写入点给 code
 * 就行（见 `agent-loop.ts` 的 `idleReasonFor`）。
 */
export function idleReasonFromText(text: string | null | undefined): IdleReason {
  // 先压成一行再判：code 扫全文、note 取开头，两者看的是同一句话（只差截断）
  const flat = typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '';
  const note = idleReasonNoteOf(flat);
  // 没有可摘的话 ⇒ 只写 code（与"模型一个字都没吐"那一档同形，不编 note）
  if (note === null) return { code: 'nothing_worth_saying' };
  return { code: idleReasonCodeOf(flat), note };
}

// ──────────────────────────────── 读侧 ────────────────────────────────

/**
 * 读侧归一：**任何形状**的 `turn/end.idleReason` → 一格可读的 `IdleReason`，或 `null`（未记录）。
 *
 * 四件事，顺序就是判据：
 *   ① 缺省 / `null` / 非对象 ⇒ `null`：**老日志**（这一格出现之前写的）与畸形值都按"未记录"读，
 *      不许抛错——上报错等于让一条历史事件弄坏整次 `tail`/`doctor`；
 *   ② `code` 认不出（不是七个值之一、缺格、不是字符串）⇒ `'other'`：封闭枚举的读侧兜底；
 *   ③ `note` 是字符串 ⇒ 压成一行并截到 80 码点；不是字符串/空串 ⇒ 这一格不出现；
 *   ④ **note 永远跟着走**：哪怕 code 归了 `other`，那句话也不许丢（它是唯一的人话线索）。
 *
 * 幂等：把本函数的输出再喂一遍，得到的还是同一格（写入侧写的就是这个形状）。
 */
export function idleReasonOf(raw: unknown): IdleReason | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as { code?: unknown; note?: unknown };
  const note = typeof record.note === 'string' ? idleReasonNoteOf(record.note) : null;
  const code: IdleReasonCode = isIdleReasonCode(record.code) ? record.code : 'other';
  return note === null ? { code } : { code, note };
}

/** 一格 `idleReason` → 显示用的一句话：code 的人话，有 note 就把她那句话括在后面 */
export function idleReasonTextOf(idle: IdleReason): string {
  const label = IDLE_REASON_TEXT[idle.code] ?? IDLE_REASON_TEXT.other;
  const note = idleReasonNoteOf(idle.note);
  return note === null ? label : `${label}（${note}）`;
}
