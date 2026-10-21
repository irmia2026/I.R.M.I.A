/**
 * Irmia Agent — 本地密钥存储（`<dataDir>/.keys.json`）
 *
 * 为什么要有它：operations.md §1 的密钥教义是「密钥不落配置文件」——`config.json` 里只写
 * 环境变量**名**，值只放进程环境。纯命令行场景下这条纪律够用，但「在界面上填一次 key 就生效」
 * 要求人能在前端写入密钥，而前端没有能力往**别的进程的环境变量**里塞值。于是开第二个位置：
 * `data/.keys.json`（点前缀 = 一眼看出它不该进版本库；`data/` 已在 .gitignore 里）。
 *
 * 读取链（唯一入口 `resolveKey`，全进程只有这一处解释优先级）：
 *
 *     环境变量（按 envName 查）  >  `data/.keys.json`  >  null（未配置）
 *
 * 环境变量优先是刻意的：容器/CI/临时覆盖靠它，且「环境里显式设了值」永远压过文件里的历史值。
 * 反过来，界面写入永远不会悄悄遮蔽环境变量——它只是补上一个「没有环境变量时的默认值」。
 *
 * 三条不变量：
 *   ① 值永不回显：对外只给 `maskKey()` 的掩码（`sk-…1234`）与 configured 布尔，谁都拿不到全值；
 *   ② 值与配置解耦：本模块**不读 config.ts**（反过来 config.ts 读它），不存在循环依赖；
 *   ③ 写盘原子：同目录 tmp → fsync → rename（与 config.ts 的统一写盘规则同源）。
 *
 * 读为什么是同步的：读取点就在「真正发起调用的一瞬间」（`readApiKey` 是同步函数，main.ts 与
 * 模型层按同步帧用它）。文件极小、频率极低，同步读盘代价可忽略；写是异步的（界面路径上不阻塞）。
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ──────────────────────────────── 常量与类型 ────────────────────────────────

/** 密钥文件名：`<dataDir>/.keys.json` */
export const KEYS_FILE_NAME = '.keys.json';

/**
 * 受管的键名全集。**顺序即文件里的键序**（写回时按它排列，diff 干净、人可读）。
 * 与 `config.json` 的 `apiKeyEnv` / `appIdEnv` / `clientSecretEnv` / `tokenEnv` 一一对应：
 * 那些字段说「环境变量叫什么」，这里存「没有环境变量时用什么值」。
 */
export const KEY_NAMES = ['heavy', 'light', 'qqAppId', 'qqClientSecret', 'onebotToken'] as const;

export type KeyName = (typeof KEY_NAMES)[number];

/**
 * 每个键的**默认**环境变量名。之所以是「默认」：键对应的环境变量名可在配置里改
 * （`models.heavy.apiKeyEnv` / `channels.*.appIdEnv` …），此时以配置里的名字为准，
 * 本表只提供缺省值。light 有独立名字：单 key 场景下它与 heavy 都回落到 `IRMIA_API_KEY`，
 * 而 `models.light.apiKeyEnv` 缺省也指向同名环境变量，两条路都通。
 */
export const KEY_ENV: Record<KeyName, string> = {
  heavy: 'IRMIA_API_KEY',
  light: 'IRMIA_LIGHT_API_KEY',
  qqAppId: 'QQ_BOT_APP_ID',
  qqClientSecret: 'QQ_BOT_CLIENT_SECRET',
  onebotToken: 'ONEBOT_ACCESS_TOKEN',
};

/** 密钥文档：只认识受管键名；文件里出现别的键一律忽略（不猜、不报错） */
export type KeysDocument = Partial<Record<KeyName, string>>;

/** 环境变量表（测试可注入；缺省 `process.env`） */
export type KeyEnv = Record<string, string | undefined>;

/** 值的来源：环境变量 / 本地文件 */
export type KeySource = 'env' | 'file';

/** 掩码的最短长度：短于此值一律整体打码（见 `maskKey`） */
const MASK_MIN_LENGTH = 8;

/** 键名收窄：来自 HTTP 请求体的任何值都要先过它 */
export function isKeyName(value: unknown): value is KeyName {
  return typeof value === 'string' && (KEY_NAMES as readonly string[]).includes(value);
}

/** `data/.keys.json` 的绝对路径 */
export function keysPath(dataDir: string): string {
  return join(resolve(dataDir), KEYS_FILE_NAME);
}

// ──────────────────────────────── 掩码 ────────────────────────────────

/**
 * 掩码：`sk-abcdef1234` → `sk-…1234`（保留前 3 与后 4，中间省略）。
 * 短于 8 位一律整体打码为 `…`：再短的串上「前 3 后 4」等于把原文还回去，
 * 而掩码的全部意义就是**掩完之后不等于原文**。
 */
export function maskKey(value: string): string {
  const text = value.trim();
  if (text.length < MASK_MIN_LENGTH) return '…';
  return `${text.slice(0, 3)}…${text.slice(-4)}`;
}

// ──────────────────────────────── 读 ────────────────────────────────

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
}

/**
 * 解析密钥文档。**宽容失败**是刻意的、也只在这里：文件不存在 / 不是合法 JSON / 顶层不是对象
 * 一律当「未配置」，而不是抛错——密钥文件坏了不该让进程起不来。配置文件的严格校验是另一回事：
 * 那里静默回退会造出「看起来生效其实没生效」的隐形故障，而这里「未配置」是个诚实的已知状态，
 * 界面上直接显示「未配置」，人重填一次即可；写路径永远整体覆盖，坏的残留不会传染。
 */
function parseKeysDocument(text: string): KeysDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const doc = raw as Record<string, unknown>;
  const out: KeysDocument = {};
  for (const name of KEY_NAMES) {
    const value = nonEmpty(typeof doc[name] === 'string' ? (doc[name] as string) : undefined);
    if (value !== null) out[name] = value;
  }
  return out;
}

/**
 * 读整份密钥文档。文件缺失（或读不到）→ `{}`。返回的是新对象，调用方改它不影响任何内部状态。
 */
export function loadKeysFile(dataDir: string): KeysDocument {
  let text: string;
  try {
    text = readFileSync(keysPath(dataDir), 'utf8');
  } catch {
    return {};
  }
  return parseKeysDocument(text);
}

/** 读一个键的**文件值**（不看环境变量）。未配置返回 null。 */
export function readKeyFile(dataDir: string, name: KeyName): string | null {
  return loadKeysFile(dataDir)[name] ?? null;
}

export interface ResolveKeyOptions {
  /** 环境变量表；缺省 `process.env` */
  env?: KeyEnv | undefined;
  /** 该键对应的环境变量名；缺省 `KEY_ENV[name]`（配置里改过名字时由调用方传进来） */
  envName?: string | undefined;
}

/**
 * **唯一**的密钥取值入口：环境变量（按 envName 查）优先 > `data/.keys.json`。
 * 未配置返回 null，由调用方决定是报错、降级还是提示用户去配。
 *
 * `dataDir` 传 null = 只看环境变量；`name` 传 null = 只知道环境变量名、不认文件里的键
 * （给「配置里写了个自定义变量名」这类调用点留的直路）。
 */
export function resolveKey(
  dataDir: string | null,
  name: KeyName | null,
  options: ResolveKeyOptions = {},
): string | null {
  const env = options.env ?? process.env;
  const envName = options.envName ?? (name === null ? null : KEY_ENV[name]);

  if (envName !== null) {
    const fromEnv = nonEmpty(env[envName]);
    if (fromEnv !== null) return fromEnv;
  }
  if (dataDir === null || name === null) return null;
  return readKeyFile(dataDir, name);
}

export interface KeyStatus {
  /** 该键当前是否可用（环境变量或文件里有一个非空值） */
  configured: boolean;
  /** 掩码（`sk-…1234` 形态）；未配置为 null。**永远不是全值** */
  mask: string | null;
  /** 值来自哪里；未配置为 null（界面据此说清「是环境变量给的还是这里填的」） */
  source: KeySource | null;
  /** 该键对应的环境变量名（值从环境来时的查表键，也是界面提示语的一部分） */
  envName: string;
}

export interface KeyStatusOptions extends ResolveKeyOptions {
  /** 数据目录；缺省只看环境变量（服务端会显式传 `<dataDir>`） */
  dataDir?: string | null | undefined;
}

/** 状态视图（界面用）：configured + 掩码 + 来源，**不含值** */
export function keyStatus(name: KeyName, options: KeyStatusOptions = {}): KeyStatus {
  const env = options.env ?? process.env;
  const envName = options.envName ?? KEY_ENV[name];
  const dataDir = options.dataDir ?? null;

  const fromEnv = nonEmpty(env[envName]);
  if (fromEnv !== null) {
    return { configured: true, mask: maskKey(fromEnv), source: 'env', envName };
  }

  const fromFile = dataDir === null ? null : readKeyFile(dataDir, name);
  if (fromFile !== null) {
    return { configured: true, mask: maskKey(fromFile), source: 'file', envName };
  }
  return { configured: false, mask: null, source: null, envName };
}

// ──────────────────────────────── 写 ────────────────────────────────

/** 原子写：同目录 tmp → fsync → rename 覆盖（与 config.ts 的统一写盘规则同源） */
let tmpSeq = 0;

async function writeKeysFileAtomic(path: string, text: string): Promise<void> {
  // pid + 序号：同进程并发写各自有独立 tmp，最后 rename 的都是完整内容
  const tmp = `${path}.tmp.${process.pid}.${tmpSeq++}`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp 残留不影响正确性：它的名字唯一，下一次写不会撞上 */
    }
    throw err;
  }
}

/** 一次写里的"哪几格 = 什么值"（空串/纯空白 = 清除那一格） */
export type KeysWritePlan = Partial<Record<KeyName, string>>;

/**
 * 写**一组**键：整份文档「读出来 → 改这几格 → 按 `KEY_NAMES` 顺序写回」——
 * 别人的键与顺序都不动，没有局部写、没有半截文件。
 *
 * 为什么要一次写多格（而不是逐格调 [writeKeyFile]）：引导页要把**同一把 key** 同时落到
 * heavy / light 两格（见 `planModelKeyWrite`）。逐格写就是两次 rename：中间失败会留下一份
 * "只补了一半"的文件——两格本该同值却不同，比一格都没有更难查。这里合成**一次原子写**，
 * 要么两格都在、要么一格都没动，回执才敢说"一格都没落"。
 *
 * 返回值 = **真正变了**的键名（升序按 `KEY_NAMES`）；全都与盘上一致时返回空数组且**不落盘**
 * （不留无意义的 mtime 抖动，重复保存也不报错——幂等）。
 *
 * `value` 为**空串或纯空白 = 清除**该格。清除时若一个键都不剩，**保留一个 `{}` 文件**：
 * 文件在不在是「这台机器配过密钥」的可观测痕迹，也让下一次写入的路径只有一条。
 * 目录不存在则创建（首次配置时 `data/` 可能还没被别的东西建出来）。
 */
export async function writeKeysFile(dataDir: string, plan: KeysWritePlan): Promise<KeyName[]> {
  const dir = resolve(dataDir);
  const path = keysPath(dir);
  const current = loadKeysFile(dir);

  const merged: KeysDocument = {};
  for (const key of KEY_NAMES) {
    const existing = current[key];
    if (existing !== undefined) merged[key] = existing;
  }

  const changed: KeyName[] = [];
  for (const key of KEY_NAMES) {
    if (!Object.hasOwn(plan, key)) continue;
    const incoming = (plan[key] ?? '').trim();
    const existing = merged[key] ?? '';
    if (existing === incoming) continue; // 没变就不算一笔改动
    if (incoming === '') delete merged[key];
    else merged[key] = incoming;
    changed.push(key);
  }
  if (changed.length === 0) return [];

  // 固定键序写回：文件里的排列与 KEY_NAMES 一致，diff 里看不出「谁先配的」
  const ordered: Record<string, string> = {};
  for (const key of KEY_NAMES) {
    const existing = merged[key];
    if (existing !== undefined) ordered[key] = existing;
  }

  mkdirSync(dir, { recursive: true });
  await writeKeysFileAtomic(path, `${JSON.stringify(ordered, null, 2)}\n`);
  return changed;
}

/** 写一个键：见 [writeKeysFile]（单格是它的退化情形，行为与历史版本逐字一致） */
export async function writeKeyFile(dataDir: string, name: KeyName, value: string): Promise<void> {
  await writeKeysFile(dataDir, { [name]: value });
}

// ──────────────────────────────── 模型路由的密钥格 ────────────────────────────────

/**
 * 一条模型路由在密钥层里的样子。
 *
 * `slot` 是 `data/.keys.json` 里的**格名**（受管键名之一）；`null` = 这条路由没有自己的格
 * （今天只有 `degraded`：`KEY_NAMES` 里没有它，这属于已登记的边界，见 `planModelKeyWrite`）。
 * `envName` 是配置里写的环境变量名（`models.<route>.apiKeyEnv`）——**同名即同一把 key**。
 */
export interface ModelKeyRoute {
  route: string;
  slot: KeyName | null;
  envName: string;
}

/**
 * 引导页/设置页要写一把模型 key 时，**这次该写哪几格**（唯一一处判断，纯函数）。
 *
 * 规则两句话：
 *   ① `allRoutes`（引导页那条路传 true）——人只填了**一把** key，那就把它写到当前配置里
 *     **每一条**有格的模型路由上：新用户填一次，heavy 与 light 都拿得到，不必再去设置页
 *     补第二遍（这正是"填了这里没给那边"的挫败感来源）。
 *   ② 不开 `allRoutes`（设置页按格保存）——只顺手补**共用同一个 `apiKeyEnv`** 的那几格：
 *     同名环境变量只可能有一个值，"盘上同名的两格却不同值"是没有意义的中间态。
 *     名字不同的格**不动**（那是另一把 key，设置页有它自己的输入框）。
 *
 * 没有格的路由（`degraded`）写不进去也不该假装写了：它们进 `noSlot`，由回执如实说出来
 * （"环境变量 IRMIA_XXX 得你自己给"）。已有的格按 `KEY_NAMES` 排序，文件里的键序因此稳定。
 */
export function planModelKeyWrite(
  target: KeyName,
  routes: readonly ModelKeyRoute[],
  options: { allRoutes?: boolean } = {},
): { slots: KeyName[]; noSlot: ModelKeyRoute[] } {
  const allRoutes = options.allRoutes === true;
  const targetRoute = routes.find((route) => route.slot === target);
  // 目标不是模型格（qqAppId / onebotToken 这些通道凭据）：只写它自己，别的格一概不碰。
  // "写到每一档"只是**模型密钥**的事——把通道凭据扇出去会覆盖掉另一把完全无关的密钥。
  if (targetRoute === undefined) return { slots: [target], noSlot: [] };
  const targetEnv = targetRoute.envName;

  const picked = new Set<KeyName>([target]);
  for (const route of routes) {
    if (route.slot === null || route.slot === target) continue;
    if (allRoutes || route.envName === targetEnv) picked.add(route.slot);
  }

  // 没格的路由：只有"这一趟本来想覆盖全部路由"时才值得报出来（单格保存与它无关）
  const slots = KEY_NAMES.filter((name) => picked.has(name));
  const coveredEnvs = new Set(
    routes.filter((route) => route.slot !== null && picked.has(route.slot)).map((route) => route.envName),
  );
  const noSlot = allRoutes ? routes.filter((route) => route.slot === null && !coveredEnvs.has(route.envName)) : [];
  return { slots, noSlot };
}

/**
 * 一把密钥的**形状自检**：返回人话原因，`null` = 形状没问题。
 *
 * 为什么只查这一条：我们没法在写盘那一刻证明"这个 key 是对的"（那要真的发一次请求，
 * 而写密钥是离线动作）。但**最可能的那一种无效**是现场就能认定的——粘贴时带进了换行或空格
 * （从网页复制、从聊天窗口复制都常见）。让它在写盘前就失败，比让它写进去、下一次调用
 * 才显示 401 强得多：人会以为是自己的 key 不对，而不是"我们存了个带换行的串"。
 *
 * 空串 / 纯空白 = 清除，不算错（清除是 set-key 的合法动作）。
 */
export function keyShapeProblem(value: string): string | null {
  const text = value.trim();
  if (text === '') return null;
  const match = /\s/.exec(text);
  if (match !== null) {
    const at = match.index + 1;
    const what = match[0] === '\n' ? '换行' : (match[0] === '\t' ? '制表符' : '空格');
    return `密钥里第 ${at} 个字符是${what}：多半是粘贴时带进来的（密钥里不该有空白字符）`;
  }
  return null;
}

/** 补齐结果：把 [source] 的值写给了 [filled] 这几格（都空着就没得可补，返回空） */
export interface KeyBackfill {
  envName: string;
  /** 这一组的全部格（回执/日志要把它们念出来，人才能照着去设置页看） */
  slots: KeyName[];
  source: KeyName;
  filled: KeyName[];
  /** 同名的几格里出现了**不同**的值：不猜、不覆盖，只报出来（人工去设置页决定） */
  conflict: boolean;
}

/**
 * 「同一个 `apiKeyEnv` 共用的几格」补齐：老用户只填过 heavy（引导页那个 bug 的直接后果），
 * 新版本启动时把那个值补到同名的其它格上，幂等。
 *
 * 判据刻意保守：
 *   · 这一组里**恰好一格**有值 ⇒ 其余空着的格补成同一个值（一次原子写）；
 *   · 有值的格 ≥ 2 且**值不同** ⇒ `conflict: true`，一个字节都不写（我们不知道哪个才是对的）；
 *   · 都空 ⇒ 什么都不做（没人配过，不该凭空造出一份空文件）。
 *
 * `groups` 由调用方从**生效配置**算出来（`config.ts` 的 `modelKeyRoutes`，本模块不读配置：
 * keys.ts ↔ config.ts 的依赖方向只有一条）。
 */
export async function backfillSharedKeys(
  dataDir: string,
  groups: ReadonlyArray<{ envName: string; slots: readonly KeyName[] }>,
): Promise<KeyBackfill[]> {
  const current = loadKeysFile(dataDir);
  const out: KeyBackfill[] = [];
  const plan: KeysWritePlan = {};

  for (const group of groups) {
    const slots = KEY_NAMES.filter((name) => group.slots.includes(name));
    if (slots.length < 2) continue;
    const present = slots.filter((name) => (current[name] ?? '') !== '');
    if (present.length === 0) continue;

    const values = new Set(present.map((name) => current[name]));
    if (values.size > 1) {
      out.push({ envName: group.envName, slots, source: present[0]!, filled: [], conflict: true });
      continue;
    }
    const missing = slots.filter((name) => !present.includes(name));
    if (missing.length === 0) continue;
    const source = present[0]!;
    for (const name of missing) plan[name] = current[source]!;
    out.push({ envName: group.envName, slots, source, filled: missing, conflict: false });
  }

  if (Object.keys(plan).length > 0) await writeKeysFile(dataDir, plan);
  return out;
}
