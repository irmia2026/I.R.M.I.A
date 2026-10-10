/**
 * Irmia Agent — **技能**的申请单：她发起装/删一个技能，用户只在界面点批准或驳回（2026-10-11）
 *
 * 与 MCP 那条线**同一套形状**（五步流水、判据、边界都在 `mcp-grant.ts` 的文件头写着），
 * 这里是技能那一半特有的三件事：
 *
 *   ① **装 = 引入可执行内容**（`skills/<name>/scripts/`）。方案稿 §1.4 实测过：
 *      本机 `skills/anysearch/scripts/` 里真有一批 `*_cli.js` / `.py` / `.sh`。
 *      ⇒ 申请单里 `scripts/` 要**单列一行**（`scriptNames`），卡面上必须看得到——
 *      这是"装技能 = 引入可执行内容"在界面上的落点（用户批的 D8）。
 *   ② **删 = 走回收站**（整目录 rename 进 `<dataDir>/trash/<时间戳>-<name>/`），
 *      内容一个字节不改、可逆。她在任何情况下**都不该**拿到"真正抹掉一份技能资产"的能力。
 *   ③ **落地之后写 `skill/installed{by:'human'}`**：这是**信任门**的凭据（人批的），
 *      不写它就等于装了但进不了 catalog——她会以为装上了、其实她下一拍还是看不见它。
 *
 * 正文与文件**不进事件**（可能几十 KB）：事件里只落"指纹 + 摘要"（字节数、脚本名），
 * 内容是 `<dataDir>/grants/<id>.json` 那份申请单里的事。批准那一刻重算指纹再比，
 * 不一致就拒执行（`skipped-stale`，与 MCP 那条同一条纪律）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SKILL_BODY_MAX_CHARS, SKILL_DESCRIPTION_MAX_CHARS, SKILL_FILE_NAME, SkillManager, skillNameProblem } from '../skill/skills.ts';
import { SKILL_TRASH_DIR } from '../web/server.ts';
import { compactTimestamp } from '../tools/fs/text-codec.ts';
import { sanitizeGrantLine } from './mcp-grant.ts';

/** 一份申请单里 `files[]` 的条数上限（方案稿建议 32；够一个技能带参考文档与几个脚本） */
export const SKILL_GRANT_MAX_FILES = 32;

/** 全部文件的**总字节**上限（1 MiB）：技能是"说明 + 少量脚本"，不是数据包 */
export const SKILL_GRANT_MAX_BYTES = 1024 * 1024;

/** 单条路径的长度上限（`references/xxx.md` 这种相对路径） */
const FILE_PATH_MAX_CHARS = 200;

/** 校验通过的一份技能申请单（规范化之后：字段裁好、理由洗净封顶） */
export interface SkillGrantRequest {
  kind: 'skill-install' | 'skill-remove';
  name: string;
  /** frontmatter 的 `description`（<= 1024 字符）。技能装好之后**唯一**的触发机制 */
  description: string;
  /** SKILL.md 的正文（不含 frontmatter；空串 = 只要一句骨架） */
  body: string;
  /** 随包带的文件（相对技能目录的 posix 路径 → 内容）。`SKILL.md` **不许**出现在这里 */
  files: Array<{ path: string; content: string }>;
  reason: string;
}

export type SkillGrantParse =
  | { ok: true; request: SkillGrantRequest }
  | { ok: false; reason: string; detail: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * 一条随包文件的路径是否可接受。
 *
 * 四条，每一条都对应一种真实的坏形状（这一格最终会被拼成 `<技能目录>/<path>` 去写盘）：
 *   · 空 / 绝对路径 / 盘符 / 上跳（`..`）⇒ 拒：那是"写到技能目录外面去"，不是"带一个文件"；
 *   · 以 `SKILL.md` 结尾 ⇒ 拒：**正文有它自己那一格**，从这里塞进去会绕过正文的长度校验；
 *   · 反斜杠 ⇒ 拒：路径一律按 posix 写（写盘时再转），两套分隔符混着来必出一种"写到了别处"；
 *   · 目录穿越之外还要求"看起来像个文件"（有扩展名或至少在子目录里）。
 */
export function skillFilePathProblem(path: string): string | null {
  if (path === '') return 'files[].path 不能为空';
  if (path.length > FILE_PATH_MAX_CHARS) return `files[].path 太长了（超过 ${FILE_PATH_MAX_CHARS} 字符）`;
  if (/^[a-zA-Z]:/u.test(path) || path.startsWith('/') || path.startsWith('\\')) {
    return `files[].path 必须是**相对技能目录**的路径，收到绝对路径形态「${path}」`;
  }
  if (path.includes('\\')) return `files[].path 里不要用反斜杠（写 posix 的 /），收到「${path}」`;
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return `files[].path 里有空的或上跳的路径段（不接受 ..）：收到「${path}」`;
  }
  if (parts[parts.length - 1] === SKILL_FILE_NAME) {
    return `files[].path 不许是 ${SKILL_FILE_NAME}：正文有它自己那一格（body），`
      + '从这里塞进来会绕过正文的长度校验';
  }
  return null;
}

/**
 * 校验一份技能申请单（**唯一实现**：拾取时调它，落地前再调一次）。
 *
 * 判据复用技能系统自己的那两把尺子，**不在这里重写**：
 *   · 名字 → `skillNameProblem`（含路径穿越那一道显式冗余，见它的注释）；
 *   · description 长度 → `SKILL_DESCRIPTION_MAX_CHARS`（frontmatter 的硬线）；
 *   · 正文长度 → `SKILL_BODY_MAX_CHARS`。
 */
export function parseSkillGrantRequest(raw: Record<string, unknown>): SkillGrantParse {
  const kindRaw = raw['kind'];
  if (kindRaw !== 'skill-install' && kindRaw !== 'skill-remove') {
    return { ok: false, reason: 'bad-kind', detail: `skill 那一支的 kind 只能是 skill-install 或 skill-remove` };
  }
  const kind: SkillGrantRequest['kind'] = kindRaw;

  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  const nameProblem = skillNameProblem(name);
  if (nameProblem !== null) return { ok: false, reason: 'bad-name', detail: nameProblem };

  const reason = sanitizeGrantLine(typeof raw['reason'] === 'string' ? raw['reason'] : '', 640);

  if (kind === 'skill-remove') {
    return { ok: true, request: { kind, name, description: '', body: '', files: [], reason } };
  }

  const description = typeof raw['description'] === 'string' ? raw['description'].trim() : '';
  if (description === '') {
    return {
      ok: false,
      reason: 'desc-missing',
      detail: '缺 description。它是这个技能**唯一的触发机制**（catalog 里只有名字与描述）：'
        + '写清"它做什么、什么时候用得上"，否则她永远想不起来用它。',
    };
  }
  if (description.length > SKILL_DESCRIPTION_MAX_CHARS) {
    return {
      ok: false,
      reason: 'desc-too-long',
      detail: `description 超过 ${SKILL_DESCRIPTION_MAX_CHARS} 字符上限（frontmatter 硬线），`
        + `收到 ${description.length} 字符`,
    };
  }

  const body = typeof raw['body'] === 'string' ? raw['body'] : '';
  if (body.length > SKILL_BODY_MAX_CHARS) {
    return {
      ok: false,
      reason: 'body-too-long',
      detail: `body 超过 ${SKILL_BODY_MAX_CHARS} 字符上限，收到 ${body.length} 字符：`
        + '正文是"照着做"的说明，不是数据包——把大块内容放进 files[] 里按需读。',
    };
  }

  const filesRaw = raw['files'];
  const files: Array<{ path: string; content: string }> = [];
  if (filesRaw !== undefined && filesRaw !== null) {
    if (!Array.isArray(filesRaw)) return { ok: false, reason: 'bad-request', detail: 'files 必须是数组' };
    if (filesRaw.length > SKILL_GRANT_MAX_FILES) {
      return {
        ok: false,
        reason: 'bad-request',
        detail: `files 最多 ${SKILL_GRANT_MAX_FILES} 个，收到 ${filesRaw.length} 个`,
      };
    }
    let total = 0;
    for (const [index, item] of filesRaw.entries()) {
      const record = asRecord(item);
      if (record === null) return { ok: false, reason: 'bad-request', detail: `files[${index}] 必须是对象` };
      const path = typeof record['path'] === 'string' ? record['path'].trim() : '';
      const pathProblem = skillFilePathProblem(path);
      if (pathProblem !== null) return { ok: false, reason: 'bad-request', detail: pathProblem };
      const content = typeof record['content'] === 'string' ? record['content'] : null;
      if (content === null) {
        return { ok: false, reason: 'bad-request', detail: `files[${index}]（${path}）的 content 必须是字符串` };
      }
      total += Buffer.byteLength(content, 'utf8');
      files.push({ path, content });
    }
    if (total > SKILL_GRANT_MAX_BYTES) {
      return {
        ok: false,
        reason: 'bad-request',
        detail: `files 总共 ${Math.round(total / 1024)} KB，超过 ${Math.round(SKILL_GRANT_MAX_BYTES / 1024)} KB 上限`,
      };
    }
  }

  return { ok: true, request: { kind, name, description, body, files, reason } };
}

/** 那份要落地的 SKILL.md（frontmatter + 正文；**唯一实现**：指纹与写盘读同一串字节） */
export function skillFileText(request: SkillGrantRequest): string {
  // frontmatter 是**手写的 YAML 子集**（见 `skill/skills.ts` 的解析器）：只认这两个字段，
  // 所以这里用最朴素的两行写法，不做引号转义的花活——description 里的换行会被解析器
  // 当成 frontmatter 结束，所以先把它压成一行（与 `skill-create` 拼骨架那份同口径）。
  const oneLine = request.description.replace(/[\r\n]+/gu, ' ').trim();
  const body = request.body.trim() === '' ? `# ${request.name}\n` : request.body;
  return `---\nname: ${request.name}\ndescription: ${oneLine}\n---\n\n${body}`;
}

/**
 * 一份技能申请单的**内容指纹**：批准那一刻重算再比（判"审阅期间被改过没有"）。
 *
 * 进散列的是**要落地的那份字节**（SKILL.md 的文本 + 每个随包文件的路径与内容），
 * 不含 `reason`（改一句"为什么想装它"不该让这张单子作废）。
 */
export function skillGrantHash(request: SkillGrantRequest): string {
  if (request.kind !== 'skill-install') return '';
  return `skill-grant-${hashOf(JSON.stringify([
    skillFileText(request),
    request.files.map((file) => [file.path, file.content]),
  ]))}`;
}

/** 与 `mcp-grant.ts` 那个 `contentKey` 同一手法（sha256 前 16 位十六进制） */
function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

// ──────────────────────────────── 卡面（人看到的那两段话） ────────────────────────────────

/** 卡面上那行"它会带什么"：`scripts/` **单列**（用户批的 D8：那是可执行内容） */
export function skillScriptNames(files: ReadonlyArray<{ path: string }>): string[] {
  return files.filter((file) => file.path.startsWith('scripts/')).map((file) => file.path);
}

/** `skill-*` 那一支的 `question`（与 `grantQuestionOf` 同一处口径：一进制，界面读同一串字节） */
export function skillGrantQuestionOf(request: SkillGrantRequest): string {
  return request.kind === 'skill-install'
    ? `批准装一个技能「${request.name}」？`
    : `批准删掉技能「${request.name}」？`;
}

/** `skill-*` 那一支的 `context`（卡面上那段上下；**每一个字都是框架算出来的**） */
export function skillGrantContextOf(request: SkillGrantRequest): string {
  const lines: string[] = [];
  if (request.kind === 'skill-install') {
    lines.push(`它会做什么：${request.description}`);
    const scripts = skillScriptNames(request.files);
    const others = request.files.filter((file) => !file.path.startsWith('scripts/'));
    if (scripts.length > 0) {
      // **这一行是用户点名的风险点**（D8）：装技能 = 引入可执行内容，而本机上真发生过
      lines.push(`风险点：它带 ${scripts.length} 个**可执行脚本**（scripts/）：${scripts.join('、')}`
        + '——装了之后她会照这个技能的指示做，而这些脚本是会被跑起来的东西。');
    }
    if (others.length > 0) lines.push(`另外还带 ${others.length} 个文件：${others.map((f) => f.path).join('、')}`);
    lines.push(`正文 ${Buffer.byteLength(skillFileText(request), 'utf8')} 字节（SKILL.md）。`);
    lines.push(
      '批准之后：由 framework 建 skills/' + request.name + '/ 并写 SKILL.md（内容逐字照这份单子），'
      + '随后写一条 skill/installed{by:"human"} —— 那是**信任门**的凭据，'
      + '写了它这个技能才进得了她下一拍的 catalog（不写就等于"装了但她看不见"）。',
    );
  } else {
    lines.push(
      `它会删掉：技能根下名为「${request.name}」的那个目录。`
      + '走的是**回收站**（整目录移到 <dataDir>/trash/<时间戳>-<name>/，内容一个字节不改，'
      + '移回去即可恢复），不是 rm -rf。',
    );
    lines.push(
      '批准之后：framework 移目录 + 写一条 skill/installed 之外的两条申请单事件；'
      + '她的 catalog 下一拍就没有这个技能了。',
    );
  }
  if (request.reason !== '') lines.push(`她写的理由：${request.reason}`);
  lines.push('不点会怎样：超时只落一条「未批准、未拒绝」的事实，这张单子原地不动，你回来照样能批。');
  return lines.join('\n');
}

// ──────────────────────────────── 落地（**批准之后**才走这里） ────────────────────────────────

export interface SkillApplyResult {
  state: 'ok' | 'failed' | 'skipped-stale' | 'skipped-invalid';
  failure?: string;
  landed?: string;
}

/** 技能根（**只写第一个根**：`.agents/skills/` 是跨客户端约定，不是我们的写入面，与 `skill-create` 同口径） */
function skillsRootOf(baseRoot: string): string | null {
  const manager = new SkillManager({ baseRoot });
  return manager.roots[0] ?? null;
}

/**
 * 把一份**获准**的技能申请单落地。
 *
 * 顺序是判据（**判在前、写在后**）：
 *   ① 单子还在盘上吗；② 校验（含名字那一道路径穿越）；③ **重算指纹**比对（不一致 = 审阅期间被改过）；
 *   ④ 装：目录**不存在**才建（已存在 ⇒ `skipped-invalid`，绝不覆盖——那可能是人写了很久的东西）；
 *   ⑤ 写 SKILL.md 与随包文件；任一步失败 ⇒ **把半成品目录移进回收站**（不留半截技能），并如实报错；
 *   ⑥ 回读一次扫描器（它认下的名字才算数——写完了但 frontmatter 解析不出来，等于没装上）。
 *
 * 删：走回收站那条既有语义（整目录 rename），目标撞车 ⇒ 拒（那是**另一条**原件）。
 */
export function applySkillGrant(input: {
  dataDir: string;
  baseRoot: string;
  request: SkillGrantRequest;
  now: () => Date;
}): SkillApplyResult {
  const root = skillsRootOf(input.baseRoot);
  if (root === null) return { state: 'failed', failure: '技能根未配置（装配点没给 skillsRoot）' };
  const manager = new SkillManager({ baseRoot: input.baseRoot });
  const name = input.request.name;

  if (input.request.kind === 'skill-remove') {
    const found = manager.locate(name);
    if (found === null) {
      return {
        state: 'skipped-invalid',
        failure: `技能根里没有叫 ${name} 的目录（两处都找过了：${manager.roots.join('、')}）：`
          + '可能已经有人删过，或它本来就不在。这次批准没有动任何文件。',
      };
    }
    try {
      const moved = moveSkillToTrash({
        dir: found.dir, relDir: found.relDir, name, dataDir: input.dataDir, now: input.now,
      });
      return { state: 'ok', landed: moved.movedTo };
    } catch (err) {
      return { state: 'failed', failure: err instanceof Error ? err.message : String(err) };
    }
  }

  const dir = join(root, name);
  if (existsSync(dir)) {
    return {
      state: 'skipped-invalid',
      failure: `技能目录已经存在：${dir}。这次批准**没有覆盖它**——`
        + '覆盖可能就是抹掉人写了很久的东西（要改内容请直接编辑那份 SKILL.md，改完信任门会自动退回待确认）。',
    };
  }

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SKILL_FILE_NAME), skillFileText(input.request), 'utf8');
    for (const file of input.request.files) {
      const target = join(dir, ...file.path.split('/'));
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, file.content, 'utf8');
    }
  } catch (err) {
    // 半成品目录**移进回收站**（不留半截技能：它会被扫描器当成一个待确认的技能，
    // 而人点"确认"时看到的是一份不完整的东西）。移不动就如实说目录留在哪。
    let note = '';
    try {
      const moved = moveSkillToTrash({ dir, relDir: name, name, dataDir: input.dataDir, now: input.now });
      note = `（半成品目录已移进回收站：${moved.movedTo}）`;
    } catch (moveErr) {
      note = `（半成品目录留在 ${dir}，回收站也搬不动：${moveErr instanceof Error ? moveErr.message : String(moveErr)}）`;
    }
    return {
      state: 'failed',
      failure: `写技能目录失败：${err instanceof Error ? err.message : String(err)}${note}`,
    };
  }

  // 回读一次：**扫描器认下的名字才算数**（写完了但 frontmatter 解析不出来 = 没装上）
  const scanned = manager.scan().candidates.some((candidate) => candidate.name === name);
  if (!scanned) {
    return {
      state: 'failed',
      failure: `目录与 ${SKILL_FILE_NAME} 都写了，但扫描器不认它（frontmatter 解析不出来）：`
        + `看一眼 ${join(dir, SKILL_FILE_NAME)}。`,
    };
  }
  return { state: 'ok', landed: name };
}

/**
 * 整目录移进 `<dataDir>/trash/<时间戳>-<名字>/`（**既有语义的唯一实现**）。
 *
 * 这一条原来长在 `web/server.ts` 的 `removeSkill` 里（人点删除那条路）；这一版把它挪到这里，
 * 两条路（人点删除 / 她申请、人批准）**共用同一份**——两份实现迟早漂移，而这是"技能资产
 * 还在不在"的那一条线。
 *
 * 四道关口（原注释逐字保留）：名字先过 `skillNameProblem`（调用方负责）→ 位置上 `locate`
 * → 落点撞车就拒（那是**另一条**原件）→ 整目录搬走，内容一个字节不改。
 */
export function moveSkillToTrash(input: {
  dir: string;
  relDir: string;
  name: string;
  dataDir: string;
  now: () => Date;
}): { movedTo: string; trashDir: string; restore: string } {
  const trashRoot = join(input.dataDir, SKILL_TRASH_DIR);
  const stamp = compactTimestamp(input.now());
  const target = join(trashRoot, `${stamp}-${input.name}`);
  if (existsSync(target)) {
    throw new Error(`回收站里已经有这一份了：${target}。同一个时间戳（毫秒）删同名技能才会撞上，`
      + '多半是重复请求：先看一眼那一份要不要留，再决定是删这一次，还是先把那一份移走。');
  }
  // 先建目录再移动：renameSync 不替我们建父目录，而"还没有回收站"是正常状态（从没删过东西）
  mkdirSync(trashRoot, { recursive: true });
  try {
    renameSync(input.dir, target);
  } catch (err) {
    throw new Error(`把 ${input.relDir} 移进回收站失败，原目录未动：${err instanceof Error ? err.message : String(err)}。`
      + '常见原因：回收站与技能根不在同一个盘（rename 不能跨盘），或那个目录正被别的进程占用。');
  }
  return {
    movedTo: target,
    trashDir: trashRoot,
    restore: `把 ${target} 移回 ${input.dir} 即可恢复（内容一个字节没改）`,
  };
}

/**
 * 事件里那几格"给人看的摘要"（正文与文件内容**不进事件**）。
 *
 * ⚠ 字段名**必须与 `GrantRequested` 上那几格逐字一致**（`skill*` 前缀）：这里返回的是要
 * **展开进事件**的那一份，名字对不上就是"静默少了几格"——TypeScript 的 `satisfies` 对
 * 展开进来的多余/缺失属性是**查不出来**的（`satisfies` 只查声明的那一层）。
 * 实测踩到过：这里曾返回 `{ description, bodyBytes, … }`，事件里于是什么都没有。
 */
export function skillGrantSummaryOf(request: SkillGrantRequest): {
  skillDescription: string;
  skillBodyBytes: number;
  skillFileCount: number;
  skillScriptNames: string[];
} {
  return {
    skillDescription: request.description,
    skillBodyBytes: Buffer.byteLength(request.body, 'utf8'),
    skillFileCount: request.files.length,
    skillScriptNames: skillScriptNames(request.files),
  };
}
