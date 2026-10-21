/**
 * Irmia Agent — 人格版本库（docs/persona.md §5、docs/design.md §4.11、docs/operations.md §6）
 *
 * 形态：`<dataDir>/.versions/<文件>/<diffHash>.md` 的**内容寻址逐版本快照集合**。
 * 文件名就是内容自身的 sha256，于是"同一内容只存一份"天然成立，不需要任何清理启发式，
 * 也不假定系统装有 git（design.md §4.11 明确的环境假定：零依赖）。
 *
 * 三条纪律：
 *   1. **只增不改**：已存在同名快照就跳过写入。同名即同内容，覆盖它没有任何信息收益，
 *      反而把"这份快照是什么时候留下的"这一信息抹掉。
 *   2. **写盘原子**：同目录 `.tmp.<pid>.<n>` → fsync → rename 覆盖，与项目其余落盘同一套纪律。
 *   3. **快照是派生数据**：读不到就是读不到，不做前缀匹配、不做修补。版本库里没有对应内容时
 *      返回 null，由调用方如实报告"此刻无法重建"，而不是拿当前内容冒充历史。
 *
 * 与事件日志的分工：`persona/updated { file, diffHash, by }` 是**事实**（何时、改哪个文件、谁改的），
 * 版本库是**内容**（那个 diffHash 对应的全文）。两者缺一：只有事件则历史内容不可考，
 * 只有快照则不知何时与何人所为。CLI 的 persona log / diff / rollback 因此都要同时读两边。
 *
 * 零外部依赖：只用 node: 标准库。
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 版本库根目录名（与 schema §11 目录树的隐藏目录约定一致） */
export const VERSIONS_DIR_NAME = '.versions';
/** 快照扩展名：与 persona 资产同为 Markdown，人类可直接打开比对 */
export const VERSION_FILE_SUFFIX = '.md';
/** 合法 diffHash：sha256 hex。放宽到 8 位是为了接受 CLI 里常用的短前缀 */
const DIFF_HASH_RE = /^[0-9a-f]{8,64}$/u;

/** diffHash 前缀形状校验（CLI 在查版本库之前先用它挡住明显的手误输入） */
export function isDiffHashPrefix(value: string): boolean {
  return DIFF_HASH_RE.test(value.trim().toLowerCase());
}

// ──────────────────────────────── 基础工具 ────────────────────────────────

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 把用户给的"文件"归一化为版本库用的相对路径。两种写法都接受：
 * `STATE.md` 与 `persona/STATE.md`——人记不住自己在哪个目录里敲的命令，这里不该成为门槛。
 * 拒绝绝对路径、盘符与 `..` 上升段：版本库只服务 persona/ 之内的一层映射。
 */
export function normalizePersonaFile(input: string): string {
  let normalized = input.trim().replace(/\\/gu, '/');
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (normalized.toLowerCase().startsWith('persona/')) normalized = normalized.slice('persona/'.length);
  if (normalized === '') throw new Error('文件路径不得为空');
  if (isAbsolute(normalized) || /^[a-z]:/iu.test(normalized)) {
    throw new Error(`只接受 persona/ 内的相对路径（例如 STATE.md），收到绝对路径或盘符：${input}`);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) {
    throw new Error(`路径含 ".." 或空段，拒绝解析：${input}`);
  }
  return segments.join('/');
}

/** 版本库根：`<dataDir>/.versions` */
export function personaVersionsRoot(dataDir: string): string {
  return join(dataDir, VERSIONS_DIR_NAME);
}

/** 某个文件某一版本的快照路径：`<dataDir>/.versions/<文件>/<diffHash>.md` */
export function versionPathOf(dataDir: string, file: string, diffHash: string): string {
  return join(personaVersionsRoot(dataDir), normalizePersonaFile(file), `${diffHash}${VERSION_FILE_SUFFIX}`);
}

// ──────────────────────────────── 读 ────────────────────────────────

export interface PersonaVersionRef {
  file: string;
  diffHash: string;
  path: string;
  bytes: number;
}

/** 列出某个文件在版本库里的全部版本；按 diffHash 排序（内容寻址，顺序无时间语义） */
export function listPersonaVersions(dataDir: string, file: string): PersonaVersionRef[] {
  const dir = join(personaVersionsRoot(dataDir), normalizePersonaFile(file));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: PersonaVersionRef[] = [];
  for (const name of names) {
    if (!name.endsWith(VERSION_FILE_SUFFIX)) continue;
    const diffHash = name.slice(0, -VERSION_FILE_SUFFIX.length);
    if (!DIFF_HASH_RE.test(diffHash)) continue;
    const path = join(dir, name);
    out.push({ file: normalizePersonaFile(file), diffHash, path, bytes: statSize(path) });
  }
  return out.sort((a, b) => (a.diffHash < b.diffHash ? -1 : a.diffHash > b.diffHash ? 1 : 0));
}

/** 版本库里有快照的文件清单相关工具见 listPersonaVersions（按文件列举）；这里只保留读取入口 */

function statSize(path: string): number {
  try {
    return readFileSync(path).byteLength;
  } catch {
    return 0;
  }
}

/** 读回指定版本的全文；不存在或读不动一律 null（快照缺失是常态，不是异常） */
export function readPersonaVersion(dataDir: string, file: string, diffHash: string): string | null {
  try {
    return readFileSync(versionPathOf(dataDir, file, diffHash), 'utf8');
  } catch {
    return null;
  }
}

/**
 * 短前缀 → 完整 diffHash。CLI 里人手敲 64 位十六进制不现实，frontend 也只显示前 8 位。
 * 唯一匹配才算数：多个匹配就报错列出候选，零匹配报错提示先跑 persona log —— 猜一个版本去回滚
 * 是"用一次误操作改变人格"，比报错严重得多。
 */
export type HashPrefixResolution =
  | { ok: true; diffHash: string }
  | { ok: false; reason: string; candidates: string[] };

export function resolveDiffHashPrefix(dataDir: string, file: string, prefix: string): HashPrefixResolution {
  const normalized = prefix.trim().toLowerCase();
  if (!DIFF_HASH_RE.test(normalized)) {
    return { ok: false, reason: `diffHash 必须是 8-64 位十六进制，收到 "${prefix}"`, candidates: [] };
  }
  const known = listPersonaVersions(dataDir, file);
  const exact = known.find((item) => item.diffHash === normalized);
  if (exact !== undefined) return { ok: true, diffHash: exact.diffHash };
  const matched = known.filter((item) => item.diffHash.startsWith(normalized)).map((item) => item.diffHash);
  if (matched.length === 1) return { ok: true, diffHash: matched[0]! };
  if (matched.length === 0) {
    return {
      ok: false,
      reason: `版本库里没有以 ${normalized} 开头的 ${normalizePersonaFile(file)} 快照`
        + `（已有 ${known.length} 个版本；用 persona log 或 persona diff 查看）`,
      candidates: [],
    };
  }
  return { ok: false, reason: `前缀 ${normalized} 命中 ${matched.length} 个版本，请给更长的前缀`, candidates: matched };
}

// ──────────────────────────────── 写 ────────────────────────────────

export interface WrittenVersion extends PersonaVersionRef {
  /** false = 该内容已在版本库里（内容寻址的幂等写入） */
  created: boolean;
}

let tmpSeq = 0;

/**
 * 写一份版本快照。内容寻址：已存在就跳过（`created: false`），因此本操作幂等，
 * 可以放心地在"写文件之前"和"回滚之前"都调一次。
 */
export async function writePersonaVersion(
  dataDir: string,
  file: string,
  content: string,
): Promise<WrittenVersion> {
  const display = normalizePersonaFile(file);
  const diffHash = sha256Hex(content);
  const path = versionPathOf(dataDir, display, diffHash);
  if (existsSync(path)) {
    return { file: display, diffHash, path, bytes: Buffer.byteLength(content, 'utf8'), created: false };
  }

  await mkdir(dirname(path), { recursive: true });
  tmpSeq += 1;
  const tmp = `${path}.tmp.${process.pid}.${tmpSeq}`;
  try {
    const handle = await open(tmp, 'wx');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  return { file: display, diffHash, path, bytes: Buffer.byteLength(content, 'utf8'), created: true };
}

// ──────────────────────────────── 通用文件版本（design §4.22） ────────────────────────────────
//
// persona/ 与 workspace/ 共用**同一套**逐版本快照机制：`<dataDir>/.versions/<scope>/<相对路径>/<diffHash>.md`。
//
// 为什么与 persona 分开一层 scope，而不是复用 normalizePersonaFile：
//   • persona 那套按 basename 归一化（`STATE.md` 与 `persona/STATE.md` 等价），因为人是在 persona/
//     里面敲命令的；workspace 侧拿到的是工作区相对路径（可能带子目录），归一化规则必须不同——
//     共用一套归一只会让"路径穿越"与"同名不同文件"两件事都没法各自说清。
//   • scope 段让两类资产的快照在同一目录树下互不遮蔽：`workspace/a.md` 与 persona 的 `A.md`
//     即使同名也是两个文件。
//
// 与 fs 工具的 backups/ 分工（两套机制，不是一件事）：
//   • `data/.versions/`（本文件）：**内容寻址、跨日留存、只增不改**——回答「昨天那个版本还在不在」，
//     所以它是文件级 undo 的依据（M8-9）；
//   • `backups/`（tools/fs/backup.ts）：短期的「写入前快照」，受 keep 上限裁剪，回答「刚才那次改坏了怎么退回去」。
//   两者都不假定系统装有 git（design §4.22 的零依赖要求）。

/** 版本库里的资产分区：persona 人格资产 / workspace 工作区文件 */
export const VERSION_SCOPE_PERSONA = 'persona';
export const VERSION_SCOPE_WORKSPACE = 'workspace';
export type VersionScope = typeof VERSION_SCOPE_PERSONA | typeof VERSION_SCOPE_WORKSPACE;

/** 单个路径段的转义上限：超长段用哈希兜底，保证文件名长度可控 */
const MAX_PATH_SEGMENT = 80;

/**
 * 工作区相对路径 → 版本库可用的相对路径。与 normalizeWorkspaceRel 的区别是它**容忍**里面
 * 还带着 `..`（先削掉前缀再校验），因为这里的输入已经过 path-guard，只剩「可能带 workdir 前缀」一种形态。
 */
function escapeVersionSegment(segment: string): string {
  let seg = segment.replace(/[<>:"|?*\u0000-\u001f]/gu, '_');
  if (seg === '' || /^\.+$/u.test(seg)) seg = '_';
  seg = seg.replace(/[ .]+$/u, '_');
  if (seg.length > MAX_PATH_SEGMENT) {
    seg = `${seg.slice(0, MAX_PATH_SEGMENT - 9)}_${sha256Hex(segment).slice(0, 8)}`;
  }
  return seg;
}

/**
 * 归一化一个版本库相对路径（scope 内）。
 * 规则：统一 `/` 分隔、去掉 `./` 与空段、拒绝绝对路径与盘符、拒绝 `..` 上升段。
 */
export function normalizeVersionPath(input: string, label = '文件路径'): string {
  let normalized = input.trim().replace(/\\/gu, '/');
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (normalized === '') throw new Error(`${label}不得为空`);
  if (isAbsolute(normalized) || /^[a-z]:/iu.test(normalized)) {
    throw new Error(`${label}只接受版本库内的相对路径，收到绝对路径或盘符：${input}`);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`${label}含 ".." 上升段，拒绝解析：${input}`);
  }
  const kept = segments.filter((segment) => segment !== '' && segment !== '.');
  if (kept.length === 0) throw new Error(`${label}不得为空：${input}`);
  return kept.map(escapeVersionSegment).join('/');
}

/**
 * 把一个绝对路径映射成 workspace 分区里的版本库相对路径。
 * 输入是**已在工作区之内**的绝对路径（调用方用 path-guard 保证），这里只做映射不做放行判断。
 */
export function workspaceVersionRelOf(workspaceRoot: string, absPath: string): string {
  const rel = relative(workspaceRoot, absPath).replaceAll('\\', '/');
  if (rel === '' || rel === '.' || rel.startsWith('../')) {
    throw new Error(`路径不在工作区内，无法建立版本快照：${absPath}`);
  }
  return normalizeVersionPath(rel, '工作区相对路径');
}

/** 某个文件某一版本的快照路径：`<dataDir>/.versions/<scope>/<相对路径>/<diffHash>.md` */
export function fileVersionPathOf(
  dataDir: string,
  scope: VersionScope,
  relPath: string,
  diffHash: string,
): string {
  return join(
    personaVersionsRoot(dataDir),
    scope,
    normalizeVersionPath(relPath),
    `${diffHash}${VERSION_FILE_SUFFIX}`,
  );
}

/** 某个文件在版本库里的全部快照（按 diffHash 排序；内容寻址的顺序无时间语义） */
export function listFileVersions(
  dataDir: string,
  scope: VersionScope,
  relPath: string,
): PersonaVersionRef[] {
  const display = normalizeVersionPath(relPath);
  const dir = join(personaVersionsRoot(dataDir), scope, display);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: PersonaVersionRef[] = [];
  for (const name of names) {
    if (!name.endsWith(VERSION_FILE_SUFFIX)) continue;
    const diffHash = name.slice(0, -VERSION_FILE_SUFFIX.length);
    if (!DIFF_HASH_RE.test(diffHash)) continue;
    const path = join(dir, name);
    out.push({ file: display, diffHash, path, bytes: statSize(path) });
  }
  return out.sort((a, b) => (a.diffHash < b.diffHash ? -1 : a.diffHash > b.diffHash ? 1 : 0));
}

/** 读取某个快照的正文；不存在返回 null（与 persona 侧同一口径：读不到就是 null，不抛） */
export function readFileVersion(
  dataDir: string,
  scope: VersionScope,
  relPath: string,
  diffHash: string,
): string | null {
  try {
    return readFileSync(fileVersionPathOf(dataDir, scope, relPath, diffHash), 'utf8');
  } catch {
    return null;
  }
}

/**
 * 写一份文件版本快照（内容寻址，幂等）。
 *
 * 调用点是**文件写工具的写入之后**（design §4.22「写工具执行后自动留快照」）：
 * 留的是"改完后的新内容"，所以同一份内容重复写不会产生第二份，跨日的旧版本也不会被覆盖
 * ——「回滚到昨日版本」因此只是从版本库里挑一份读回来。
 */
export async function writeFileVersion(
  dataDir: string,
  scope: VersionScope,
  relPath: string,
  content: string,
): Promise<WrittenVersion> {
  const display = normalizeVersionPath(relPath);
  const diffHash = sha256Hex(content);
  const path = fileVersionPathOf(dataDir, scope, display, diffHash);
  if (existsSync(path)) {
    return { file: display, diffHash, path, bytes: Buffer.byteLength(content, 'utf8'), created: false };
  }

  await mkdir(dirname(path), { recursive: true });
  tmpSeq += 1;
  const tmp = `${path}.tmp.${process.pid}.${tmpSeq}`;
  try {
    const handle = await open(tmp, 'wx');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  return { file: display, diffHash, path, bytes: Buffer.byteLength(content, 'utf8'), created: true };
}

// ──────────────────────────────── 行级差异 ────────────────────────────────

export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
  /** 旧文件行号（1 起）；新增行没有旧行号 */
  oldLine: number | null;
  /** 新文件行号（1 起）；删除行没有新行号 */
  newLine: number | null;
}

/** LCS 表的上限：超过就退化——人格文件本就该短，超长的两份文件逐行 diff 只会淹没人眼 */
const LCS_CELL_LIMIT = 1_000_000;

/**
 * 行级差异（LCS 动态规划，零依赖）。输出顺序即阅读顺序：oldLine / newLine 单调递增。
 * 退化路径明确：两边行数乘积超过上限时，整份"全删 + 全增"——宁可难看也不要 O(n²) 卡住 CLI。
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const before = splitLines(oldText);
  const after = splitLines(newText);
  const n = before.length;
  const m = after.length;

  if (n === 0 || m === 0 || n * m > LCS_CELL_LIMIT) {
    return [
      ...before.map((text, i) => ({ kind: 'del' as const, text, oldLine: i + 1, newLine: null })),
      ...after.map((text, i) => ({ kind: 'add' as const, text, oldLine: null, newLine: i + 1 })),
    ];
  }

  // dp[i][j] = before[i..] 与 after[j..] 的最长公共子序列长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = before[i] === after[j]
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ kind: 'same', text: before[i]!, oldLine: i + 1, newLine: j + 1 });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: 'del', text: before[i]!, oldLine: i + 1, newLine: null });
      i += 1;
    } else {
      out.push({ kind: 'add', text: after[j]!, oldLine: null, newLine: j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ kind: 'del', text: before[i]!, oldLine: i + 1, newLine: null });
    i += 1;
  }
  while (j < m) {
    out.push({ kind: 'add', text: after[j]!, oldLine: null, newLine: j + 1 });
    j += 1;
  }
  return out;
}

/** 统一换行约定：CRLF 归一化为 LF，末尾空行不计为一行内容 */
function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface DiffStats {
  added: number;
  removed: number;
  same: number;
}

export function diffStats(lines: readonly DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  let same = 0;
  for (const line of lines) {
    if (line.kind === 'add') added += 1;
    else if (line.kind === 'del') removed += 1;
    else same += 1;
  }
  return { added, removed, same };
}

export interface FormatDiffOptions {
  /** 最多渲染多少行（超出只报计数），默认 400 */
  maxLines?: number;
  /** 每个连续上下文段的保留行数，默认 3 */
  contextLines?: number;
}

/**
 * 渲染成带左右行号的差异文本。不产 git 风格的 `@@ -a,b +c,d @@` 头：这里的读者是
 * 在终端里看人格改了什么的人，`- 12     |（删）旧行` 比 hunk 头一眼就懂。
 */
export function formatDiffLines(lines: readonly DiffLine[], options: FormatDiffOptions = {}): string[] {
  const maxLines = options.maxLines ?? 400;
  const context = options.contextLines ?? 3;
  const keep = contextKeepSet(lines, context);
  const out: string[] = [];
  let shown = 0;
  let hidden = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.kind === 'same' && !keep.has(index)) {
      hidden += 1;
      continue;
    }
    if (shown >= maxLines) {
      hidden += 1;
      continue;
    }
    out.push(renderDiffLine(line));
    shown += 1;
  }
  if (hidden > 0) out.push(`… 省略 ${hidden} 行未变更/超限内容（--full 可看全部）`);
  return out;
}

function renderDiffLine(line: DiffLine): string {
  const mark = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
  const oldNo = line.oldLine === null ? '    ' : String(line.oldLine).padStart(4, ' ');
  const newNo = line.newLine === null ? '    ' : String(line.newLine).padStart(4, ' ');
  return `${mark} ${oldNo} ${newNo} │ ${line.text}`;
}

/** 保留"有变更行附近 context 行"的索引集合：上下文段外的纯相同行折叠掉 */
function contextKeepSet(lines: readonly DiffLine[], context: number): Set<number> {
  const keep = new Set<number>();
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]!.kind === 'same') continue;
    const from = Math.max(0, index - context);
    const to = Math.min(lines.length - 1, index + context);
    for (let k = from; k <= to; k++) keep.add(k);
  }
  return keep;
}

/** 供路径安全复核：所有写入路径必须落在 persona 根目录之内 */
export function isInsideRoot(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  const comparable = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  const rc = comparable(r);
  const tc = comparable(t);
  if (tc === rc) return true;
  return tc.startsWith(rc.endsWith(sep) ? rc : rc + sep);
}
