/**
 * **实例登记表**：`%APPDATA%\Irmia\instances.json` —— 盘上是唯一真相源，**后端写、界面读**。
 *
 * ## 它解决的是哪一件事
 *
 * 「登出 = 结束当前实例」之后，界面要回到**实例选择页**：列出这台机器上登记过的实例、
 * 逐条判活、按需把没在跑的那个拉起来。界面自己不知道任何一个实例的数据目录/端口/该用
 * 哪个 node 跑哪个入口——这些只有**正在跑的那个后端**知道。所以后端在 bind 成功那一刻
 * 把"我是谁、我在哪个端口、我的数据目录在哪、我是用哪个 node 跑的哪个入口"写下来，
 * 界面读这一份。**不推送、不缓存跨进程**：界面每次进选择页现读一次盘。
 *
 * ## 三条纪律（每一条都对应一种会真实发生的损坏）
 *
 *   ① **只写自己那条**：两个实例（两个进程）会同时读改写同一份文件。整份重写而先读的那份
 *      已经过期，就会把别人刚追加的那条**整段丢掉**（经典 lost update）。所以：抢文件锁 →
 *      现读 → 只改自己那条 → 原子替换。锁是 `<file>.lock` 的 `wx` 排他创建（跨进程；
 *      `config/file-lock.ts` 那把 Promise 队列只在一个进程内有效，跨进程什么都挡不住）。
 *   ② **退出时 pid 清 0，不删条目**：条目是"这台机器上存在过哪些实例"的记忆，删掉它
 *      等于让界面忘了那个实例（而它的数据目录还在盘上）。清 0 的语义是"它现在没在跑"。
 *      清之前核对 pid 是**自己**：旧实例收尾很慢、新实例已经接管时，pid 早就换了用户。
 *   ③ **读不出来不覆盖**：文件半截/不是 JSON 时**不许**当成空表直接写回去——那一写就把
 *      别人那几条一起抹了。做法是先把坏文件改名成 `.bad`（留证据），再按空表重建，
 *      并把这件事说成人话打出去。
 *
 * ## 名字从哪来
 *
 * `name` 是**新增那一刻**从 `persona/IDENTITY.md` 认出来的（认不出就用数据目录的末段）。
 * 之后**永不覆盖**——只有下面这一个例外：
 *
 * 多实例第一版只认结构化那一行 `名字：`，而老实例的人格文件多是散文写法（本机那份第一行就是
 * `我是伊尔弥亚（Irmia）。表面身份：…`）⇒ 当时回落到目录末段（`data`）。这一版把解析规则
 * **逐条镜像**成 `gui/lib/her_name.dart` 那一份（含散文兜底 {@link herNameFromIdentity}），
 * 并给已有条目一次**升级**机会：`name` 还是目录末段的那些，若现在能解出更好的名字就改一次，
 * `nameSource` 记成 `identity`——第二次启动不再动（见 {@link upsertRunningInstance}）。
 *
 * `nameSource` 三档（{@link InstanceNameSource}）：`identity` = 从人格文件解出来的；
 * `dir` = 目录末段兜底；`manual` = 界面/用户改的名，**后端的任何启动路径都不许覆盖**。
 *
 * ⚠ **判据的权威实现是 `gui/lib/her_name.dart`**（界面显示用的那一份）。{@link herNameFromIdentity}
 * 是它的镜像，**两份必须同形**：改那边时看这里一眼；改这里时要让两份用例的样本也对得上
 * （`test/instance-registry.test.ts` 与 `gui/test/her_name_test.dart`）。
 *
 * ## `isDefault`
 *
 * "默认实例"= 数据目录正好是**安装目录下的 `data`**（`<install>/data`），也就是从
 * `packaging/` 装的、用户日常打开的那一个。它只决定两件事：
 *   · 旧名的端口文件 `server.json` 为谁而写（见 `runtime/server-port-file.ts`）；
 *   · 界面上能不能删（默认实例不给删）。
 * 判定用的是**路径比较**（`comparisonKey`：大小写/分隔符归一），不是字符串相等。
 *
 * ## 与端口文件的分工
 *
 * 端口文件（`%LOCALAPPDATA%\Irmia\server.<port>.json`）回答"**这个端口**上是谁"，
 * 登记表回答"**这台机器**上有哪些实例"。两者都由后端在 bind 成功那一刻写，但用途不同：
 * 界面判活走 `GET /api/instance`（真的问一句），端口文件是留给旧逻辑/拉起器的那一档。
 */

import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { sleepSync, writeFileAtomicSync } from '../web/atomic.ts';
// 路径比较（大小写 / 分隔符 / 尾部空格点的归一）只有一处实现：见 `tools/boundary.ts` 的文件头
import { comparisonKey } from '../tools/boundary.ts';

/** 文件名（界面那一半在 `gui/lib/instances.dart` 里按同一个名字读） */
export const INSTANCES_FILE_NAME = 'instances.json';

/** 登记表的版本（结构变了就 +1；界面见到不认识的就当"没有这一档"，不猜） */
export const INSTANCES_FILE_VERSION = 1;

/** `name` 这一格的出处。`manual` 只由**界面/用户**写入，后端只读它、永不写它。 */
export type InstanceNameSource = 'identity' | 'dir' | 'manual';

/** 一条实例记录。字段口径见文件头；`pid: 0` = 它现在没在跑。 */
export interface InstanceRecord {
  /** 实例标识：`<host>:<port>#<数据目录哈希前 16 位>`（与 `web/server.ts` 的 `instanceIdOf` 同源） */
  id: string;
  /** 选择页上显示的名字（新增时定下，之后只按 {@link InstanceNameSource} 的规则动） */
  name: string;
  /**
   * `name` 这一格从哪来（多实例第二版加的；老条目没有这一格，见 {@link nameSourceOf}）：
   *   · `identity` —— `persona/IDENTITY.md` 解出来的；
   *   · `dir` —— 数据目录末段（解不出名字时的兜底）；
   *   · `manual` —— 界面改的名（**后端永不覆盖**，连 `nameSource` 都不改）。
   */
  nameSource?: InstanceNameSource;
  /** 数据目录（绝对路径，原样存；界面拿它当 `--data-dir` 与目录存在性判据） */
  dataDir: string;
  host: string;
  /** 最近一次 bind 的端口（`pid: 0` 时它是"上次用的那个端口"） */
  port: number;
  /** 当前 pid；0 = 没在跑（正常退出会清 0，崩溃就留给界面判活/接管） */
  pid: number;
  /** 拉起它用的那个 node（`process.execPath`；界面"启动并登录"要用它） */
  nodeExe: string;
  /** 入口脚本的绝对路径（`process.argv[1]`；界面的工作目录按它推安装根） */
  entry: string;
  createdAt: string;
  /** 最近一次 bind 成功的时刻 */
  lastStartedAt: string;
  /** 最近一次 `/api/health` 变 ready 的时刻；没读到过就是空串 */
  lastReadyAt: string;
  /** 数据目录是不是安装目录下的 `data`（决定"能不能删"与旧端口文件写给谁） */
  isDefault: boolean;
}

/** 整份文件的形状 */
export interface InstancesFile {
  v: number;
  instances: InstanceRecord[];
}

/** 读的结果：`recovered` 为真表示"盘上那份读不出来，这条是重建出来的空表" */
export interface ReadInstancesResult {
  file: InstancesFile;
  /** 文件在但读不出来（不是 JSON / 顶层不是对象）——调用方据此决定要不要留证据 */
  recovered: boolean;
  /** 文件根本不在（首次安装 / 从没有实例登记过） */
  missing: boolean;
}

// ──────────────────────────────── 路径 ────────────────────────────────

/**
 * 登记表路径：`%APPDATA%\Irmia\instances.json`。
 *
 * 为什么是 `APPDATA` 而不是 `LOCALAPPDATA`：它与界面的凭据（`sessions\`）、`ui-state.json`、
 * 文案覆盖层同族——**同一台机器上的同一批事实放在同一个根下**，备份/迁移时不用记两个目录。
 * 端口文件留在 `LOCALAPPDATA` 是因为它本来就是"这台机器的运行期提示位"（本文件不改它的口径）。
 *
 * 非 Windows / 没有 `APPDATA` ⇒ `null`（**不猜**一个目录写进去，见 `serverPortFilePath` 的注释）。
 */
export function instancesFilePath(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): string | null {
  if (platform !== 'win32') return null;
  const appData = (env['APPDATA'] ?? '').trim();
  if (appData === '') return null;
  return join(appData, 'Irmia', INSTANCES_FILE_NAME);
}

// ──────────────────────────────── 读 ────────────────────────────────

/** 一个值能不能当"一条记录"用：不认识就整条丢掉（不让一行坏数据毁掉整张表） */
function parseRecord(raw: unknown): InstanceRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  const text = (key: string): string => (typeof item[key] === 'string' ? (item[key] as string) : '');
  const number = (key: string): number => {
    const value = item[key];
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
  };
  const id = text('id').trim();
  const dataDir = text('dataDir').trim();
  // id 与 dataDir 是**仅有的两条硬判据**：少一条这条记录就没法用（界面按 id 找凭据、
  // 按 dataDir 拉起后端），留着它只会在选择页上画一条点不动的行
  if (id === '' || dataDir === '') return null;
  const port = number('port');
  const rawSource = text('nameSource').trim();
  const nameSource: InstanceNameSource | undefined =
    rawSource === 'identity' || rawSource === 'dir' || rawSource === 'manual' ? rawSource : undefined;
  return {
    id,
    name: text('name').trim(),
    // 认不出的来源**不猜**：留着 undefined，由 nameSourceOf() 按名字反推（老条目就是这一档）
    ...(nameSource === undefined ? {} : { nameSource }),
    dataDir,
    host: text('host').trim() === '' ? '127.0.0.1' : text('host').trim(),
    port: port > 0 && port <= 65535 ? port : 0,
    pid: Math.max(0, number('pid')),
    nodeExe: text('nodeExe').trim(),
    entry: text('entry').trim(),
    createdAt: text('createdAt'),
    lastStartedAt: text('lastStartedAt'),
    lastReadyAt: text('lastReadyAt'),
    isDefault: item['isDefault'] === true,
  };
}

/**
 * 读登记表（**绝不抛**）。
 *
 * 三档结论：文件不在（`missing`）/ 读得出来（`instances` 是盘上那份）/ 读不出来
 * （`recovered: true`，`instances` 是空表）。第三档**不许**被当成第一档悄悄写回去——
 * 调用方（{@link upsertRunningInstance}）会先把坏文件改名留证据。
 */
export function readInstancesFile(path: string | null): ReadInstancesResult {
  const empty: InstancesFile = { v: INSTANCES_FILE_VERSION, instances: [] };
  if (path === null) return { file: empty, recovered: false, missing: true };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { file: empty, recovered: false, missing: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { file: empty, recovered: true, missing: false };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { file: empty, recovered: true, missing: false };
  }
  const doc = parsed as Record<string, unknown>;
  const rawList = doc['instances'];
  const instances: InstanceRecord[] = [];
  if (Array.isArray(rawList)) {
    for (const raw of rawList) {
      const record = parseRecord(raw);
      if (record !== null) instances.push(record);
    }
  }
  const version = doc['v'];
  return {
    file: {
      v: typeof version === 'number' && Number.isFinite(version) ? Math.trunc(version) : INSTANCES_FILE_VERSION,
      instances,
    },
    recovered: false,
    missing: false,
  };
}

// ──────────────────────────────── 锁 ────────────────────────────────

/** 抢锁的等待上限（毫秒）。两个进程的写都只占几毫秒，1.5 秒已经是"对面卡死了" */
const LOCK_WAIT_MS = 1500;
/** 超过这么久还没放 ⇒ 判陈旧、直接接管（进程被杀时锁文件会留在盘上） */
const LOCK_STALE_MS = 10_000;

/**
 * 登记表的**跨进程**读-改-写闸：`<file>.lock` 的 `wx` 排他创建。
 *
 * 为什么不复用 `config/file-lock.ts` 的 `createFileLock()`：那是**进程内**的 Promise 队列，
 * 用来挡同一个进程里并发的异步读句柄（Windows 上 rename 的 EPERM）。而这里要挡的是
 * **两个后端进程**同时改同一份 `instances.json`——只有盘上的排他创建能挡。
 *
 * 抢不到就重试（15ms 一拍），超时**抛**（由调用方降级成"只说一句"，见 {@link upsertRunningInstance}）。
 * 陈旧接管有代价：如果两个进程恰好同时判"这把锁陈旧了"，它们会一起进来——所以陈旧阈值
 * 取得比任何一次正常写的耗时大三个数量级（10 秒 vs 几毫秒）。
 */
function withRegistryLock<T>(path: string, task: () => T): T {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | null = null;
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx');
      break;
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (code !== 'EEXIST') {
        // 目录不存在（首次写入）之类的错：交给下面的原子写去建目录/报错，
        // 这里不因为"锁建不起来"就把这次写入整个丢掉
        break;
      }
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
      } catch {
        // 刚被对面删掉：下一圈就能抢到
        stale = true;
      }
      if (stale) {
        try {
          unlinkSync(lockPath);
        } catch {
          // 对面同时删掉了：无妨
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`实例登记表被另一个进程占着（${lockPath}）——这次不写，免得把别人的条目弄丢`);
      }
      sleepSync(15);
    }
  }
  try {
    return task();
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 关不掉不影响结论：下面 unlink 才是"放锁"
      }
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // 锁文件已经不在（陈旧接管时被对面删过）：退出路径上这不是错
    }
  }
}

/**
 * 读-改-写的那一半：抢锁 → **现读** → 改 → 原子替换。
 *
 * `mutate` 拿到的是**盘上此刻**那份（不是调用方进函数前读的旧副本，那正是 lost update
 * 的来源）；返回 `{keep, changed}`：`keep` 是这次要不要写盘（没变化就不碰文件——
 * 每 30 秒重写一次登记表只会让杀软与索引器白白忙一场）。
 */
function mutateRegistry<T>(
  path: string,
  mutate: (file: InstancesFile, recovered: boolean) => { result: T; keep: boolean },
  out: ((line: string) => void) | undefined,
  backupBad: (path: string) => void,
): T {
  return withRegistryLock(path, () => {
    const read = readInstancesFile(path);
    if (read.recovered) {
      // 坏文件先留证据（改名，不删）：那里面可能有别人那几条的残骸
      backupBad(path);
      out?.(`[实例] 登记表读不出来（不是合法 JSON）：已改名为 ${path}.bad，按空表重建`
        + '——若里面有别的实例，请从 .bad 里手工捞回来');
    }
    const outcome = mutate(read.file, read.recovered);
    if (outcome.keep) {
      writeFileAtomicSync(path, `${JSON.stringify(read.file, null, 2)}\n`);
    }
    return outcome.result;
  });
}

// ──────────────────────────────── 写 ────────────────────────────────

/** 同一条记录的比较键：用 dataDir（大小写/分隔符归一）——id 里含端口，换端口就换 id */
function dataDirKey(dataDir: string): string {
  return comparisonKey(dataDir);
}

export interface UpsertInstanceInput {
  /** 登记表路径；`null`（非 Windows / 没有 APPDATA）= 什么都不写，返回 null */
  path: string | null;
  id: string;
  /**
   * 名字候选。新增时用它；已有条目**只在"旧条目一次性升级"那一种情形下**才会被它改掉
   * （见 {@link upsertRunningInstance}）。
   */
  name: string;
  /**
   * 这个名字的出处（调用方说得出就说：`herNameFromIdentity(...)` 解出来了 ⇒ `identity`，
   * 走 {@link fallbackInstanceName} ⇒ `dir`）。只决定两件事：
   *   · 新增时写进 `nameSource`（不给就按"有名字 ⇒ identity、空 ⇒ dir"推，见 {@link nameSourceOf}）；
   *   · 旧条目升级时**只认 `identity` 这一档**——目录末段没有资格覆盖任何已经写下的名字。
   * `manual` 不在这张表里：那是界面写下的，后端**永远不产生**它。
   */
  nameSource?: 'identity' | 'dir';
  dataDir: string;
  host: string;
  port: number;
  pid: number;
  nodeExe: string;
  entry: string;
  isDefault: boolean;
  now?: () => Date;
  out?: (line: string) => void;
}

/**
 * **后端启动时**（bind 成功那一刻）登记自己在跑：按 dataDir 找条目。
 *
 *   · 有 ⇒ 更新 pid / port / host / nodeExe / entry / lastStartedAt；名字那一格按
 *         {@link InstanceNameSource} 的规则处理（见下）；**createdAt / id / isDefault 一个字都不动**；
 *   · 没有 ⇒ 追加一条（name 取她的名字、取不到用目录末段；isDefault 由调用方按路径判）。
 *
 * 名字这一格只有三档动作（见文件头"名字从哪来"）：
 *   ① `manual` ⇒ **什么都不做**（连 `nameSource` 都不补：那是用户改过的名字）；
 *   ② `dir`（含老条目里"名字 = 目录末段"那一档）+ 这一次解出了 `identity` ⇒ **升级一次**，
 *      改完把 `nameSource` 落成 `identity`；下一次启动走 ①/③ 都不会再动它；
 *   ③ 其余 ⇒ 名字不动，只把老条目缺的 `nameSource` 补成事实（`dir` / `identity`）。
 *
 * 返回写下去的那条记录（`path === null` 或写盘失败 ⇒ null，**不抛**：登记表是一个提示位，
 * 它写不进去不该拦住后端启动——与端口文件同一条分寸）。
 */
export function upsertRunningInstance(input: UpsertInstanceInput): InstanceRecord | null {
  if (input.path === null) return null;
  const path = input.path;
  const now = input.now ?? (() => new Date());
  const stamp = now().toISOString();
  let record: InstanceRecord | null = null;
  try {
    record = mutateRegistry(path, (file) => {
      const key = dataDirKey(input.dataDir);
      let existing: InstanceRecord | undefined;
      for (const item of file.instances) {
        if (dataDirKey(item.dataDir) === key) {
          existing = item;
          break;
        }
      }
      if (existing !== undefined) {
        existing.id = input.id;
        existing.dataDir = resolve(input.dataDir);
        existing.host = input.host;
        existing.port = input.port;
        existing.pid = input.pid;
        existing.nodeExe = input.nodeExe;
        existing.entry = input.entry;
        existing.lastStartedAt = stamp;
        // createdAt / isDefault **刻意不更新**：见文件头
        const source = nameSourceOf(existing);
        const candidate = input.name.trim();
        if (source === 'manual') {
          // ① 用户改过的名字：启动路径一个字节都不许动（连"来源"也不改，免得把 manual 洗成别的）
        } else if (
          source === 'dir'
          && input.nameSource === 'identity'
          && candidate !== ''
          // ② 旧条目一次性升级：名字**当时确实回落成了目录末段**，现在解出了更好的
          && existing.name.trim() === fallbackInstanceName(existing.dataDir)
        ) {
          input.out?.(`[实例] 登记表里「${existing.name}」是从目录末段回落的——`
            + `她的名字现在能认出来了，升级为「${candidate}」（只这一次）`);
          existing.name = candidate;
          existing.nameSource = 'identity';
        } else if (existing.nameSource === undefined) {
          // ③ 老条目补一格事实（名字不动）：下一次启动就不必再按名字反推了
          existing.nameSource = source;
        }
        return { result: existing, keep: true };
      }
      const candidate = input.name.trim();
      const fresh: InstanceRecord = {
        id: input.id,
        name: candidate === '' ? fallbackInstanceName(input.dataDir) : candidate,
        // 空名字 ⇒ 一定是目录末段；调用方没说出处时按"有名字 ⇒ identity"推（见 nameSourceOf）
        nameSource: candidate === ''
          ? 'dir'
          : (input.nameSource ?? 'identity'),
        dataDir: resolve(input.dataDir),
        host: input.host,
        port: input.port,
        pid: input.pid,
        nodeExe: input.nodeExe,
        entry: input.entry,
        createdAt: stamp,
        lastStartedAt: stamp,
        lastReadyAt: '',
        isDefault: input.isDefault,
      };
      file.instances.push(fresh);
      return { result: fresh, keep: true };
    }, input.out, (bad) => backupBadFile(bad));
  } catch (err) {
    input.out?.(`[实例] 登记表写不进去（${path}）：${describe(err)}`
      + '——不影响启动；界面这一侧会看不到这台实例的登记条目');
    return null;
  }
  if (record !== null) {
    input.out?.(`[实例] 登记表已更新：${record.name}（${record.nameSource ?? '?'}）· ${record.id} · pid ${record.pid}`
      + `（${record.isDefault ? '默认实例' : '普通实例'}；${path}）`);
  }
  return record;
}

export interface ReadyMarkInput {
  path: string | null;
  dataDir: string;
  /** 只在这条记录的 pid 还是**自己**时才写（换用户了就不许动） */
  pid: number;
  now?: () => Date;
}

/** **就绪那一刻**补记 `lastReadyAt`（与 `[界面] 后端就绪` 那一行同一处调） */
export function markInstanceReady(input: ReadyMarkInput): void {
  if (input.path === null) return;
  const stamp = (input.now ?? (() => new Date()))().toISOString();
  const key = dataDirKey(input.dataDir);
  try {
    mutateRegistry(input.path, (file) => {
      const target = file.instances.find((item) => dataDirKey(item.dataDir) === key);
      if (target === undefined) return { result: false, keep: false };
      // pid 不是自己 ⇒ 这条记录已经换用户（新实例接管了），别拿旧时刻盖上去
      if (target.pid !== input.pid) return { result: false, keep: false };
      if (target.lastReadyAt === stamp) return { result: false, keep: false };
      target.lastReadyAt = stamp;
      return { result: true, keep: true };
    }, undefined, (bad) => backupBadFile(bad));
  } catch {
    // 就绪时刻是个提示位，写不进去不该拦住"后端就绪"这件事
  }
}

export interface StopMarkInput {
  path: string | null;
  dataDir: string;
  /** 自己的 pid：只有盘上那条记的还是它时才清 0（见文件头纪律②） */
  pid: number;
  out?: (line: string) => void;
}

/**
 * **后端退出时**把自己那条的 `pid` 清 0（**不删条目**）。
 *
 * 核对 pid 是**自己**：旧实例收尾很慢、新实例已经接管时，盘上那条的 pid 早就换了用户，
 * 这时候清 0 等于告诉界面"新实例没在跑"——它下一次判活就会把活着的那台当成死的。
 */
export function markInstanceStopped(input: StopMarkInput): boolean {
  if (input.path === null) return false;
  const key = dataDirKey(input.dataDir);
  try {
    return mutateRegistry(input.path, (file) => {
      const target = file.instances.find((item) => dataDirKey(item.dataDir) === key);
      if (target === undefined) return { result: false, keep: false };
      if (target.pid !== input.pid) {
        input.out?.(`[实例] 登记表里那条已经是别人了（盘上 pid ${target.pid}，我是 ${input.pid}）：不清 pid`);
        return { result: false, keep: false };
      }
      if (target.pid === 0) return { result: true, keep: false };
      target.pid = 0;
      return { result: true, keep: true };
    }, input.out, (bad) => backupBadFile(bad));
  } catch (err) {
    input.out?.(`[实例] 登记表清 pid 失败（${input.path}）：${describe(err)}`
      + '——界面会把这条当成"还在跑"，判活请求失败后仍会显示未运行');
    return false;
  }
}

/**
 * 删掉一条记录（**界面**那条"删除实例"走的是同一份字节，这里是给工具/用例用的对称实现）。
 *
 * 语义上只允许删**没在跑**且**非默认**的条目——那条判据在**界面**（`gui/lib/instances.dart`），
 * 这里不重复校验：本函数是"把一条按 id 删掉"，调用方负责判据（两处判据必然漂移，
 * 而漂移的表现是"界面上删不掉 / 脚本里删得掉"）。
 */
export function removeInstanceRecord(input: {
  path: string | null;
  id: string;
  out?: (line: string) => void;
}): boolean {
  if (input.path === null) return false;
  try {
    return mutateRegistry(input.path, (file) => {
      const before = file.instances.length;
      file.instances = file.instances.filter((item) => item.id !== input.id);
      return { result: file.instances.length !== before, keep: file.instances.length !== before };
    }, input.out, (bad) => backupBadFile(bad));
  } catch {
    return false;
  }
}

// ──────────────────────────────── 名字与默认判定 ────────────────────────────────

/**
 * `name` 这一格是从哪儿来的 —— **老条目没有 `nameSource`**（多实例第一版），按名字反推。
 *
 * 反推的判据只有一条：**名字是不是正好等于数据目录末段**。那正是旧版唯一会回落的形状
 * （{@link fallbackInstanceName}），所以"等于末段 ⇒ `dir`、否则 ⇒ `identity`"既不会把
 * 用户改过的名字误判成 `dir` 再覆盖掉（那种名字几乎不可能正好等于末段），也不会漏掉
 * 本机这条真实的老条目（`name: "data"` / `dataDir: …\data`）。
 *
 * 为什么不用"没有这一格 ⇒ manual"：那一档在历史里**不可能存在**（界面在此之前没有改名入口），
 * 而把它当 manual 会让所有老实例永远升不上来——正是这一版要修的那件事。
 */
export function nameSourceOf(
  record: Pick<InstanceRecord, 'name' | 'nameSource' | 'dataDir'>,
): InstanceNameSource {
  const explicit = record.nameSource;
  if (explicit === 'identity' || explicit === 'dir' || explicit === 'manual') return explicit;
  return record.name.trim() === fallbackInstanceName(record.dataDir) ? 'dir' : 'identity';
}

/** 数据目录末段（取不到名字时的兜底；`D:\data` ⇒ `data`） */
export function fallbackInstanceName(dataDir: string): string {
  const normalized = resolve(dataDir).replace(/[\\/]+$/u, '');
  const tail = basename(normalized);
  return tail === '' ? 'instance' : tail;
}

/** 名字行：允许前置缩进与列表符号（人可能写成 `- 名字：小七`），标签后接全角或半角冒号 */
const NAME_LINE = /^([ \t\uFEFF]*(?:[-*+][ \t]*)?)名字[ \t]*[:：][ \t]*(.*)$/mu;
/** 首启种子模板的标记（与 `gui/lib/her_name.dart`、`persona/loader.ts` 同一串字面量） */
const SEED_MARKER = '<!-- SEED';
/** 名字长度上限：与 `gui/lib/her_name.dart` 的 `kHerNameMaxChars` 同值 */
const NAME_MAX_CHARS = 24;

/**
 * 散文兜底：只认「我叫…」「我是…」这两种最直白的写法（与 `gui/lib/her_name.dart` 的 `_proseName` 同形）。
 *
 * 为什么排除那一串字符：它们是**句子**会接着写下去的地方（标点、空格、括号），
 * 名字在那里结束。`{1,16}` 是"名字不会是一段话"的粗尺，精确判据在 {@link looksLikeName}。
 * ⚠ `g` 只是让 `matchAll` 能扫全文（与 Dart 的 `allMatches` 同一个用途），不是"替换全部"。
 */
const PROSE_NAME = /我(?:叫|是)[ \t]*([^\s，。；、！？：:（）()\[\]【】《》「」…~—\-#*\/\\|]{1,16})/gu;

/** 名字不像名字的开头（量词/代词）："我是一个喜欢安静的人"里的"一个喜欢安静的人"不是名字 */
const NOT_NAME_PREFIX = [
  '一个', '一名', '一位', '一只', '一种', '一台', '一群', '一份', '一件', '一本', '一场',
  '这台', '这个', '那个', '这里', '那里', '谁的',
  '个', '位', '名', '只', '种', '台', '你', '我', '他', '她', '它', '谁', '这', '那',
];

/** 括号开头的值 = 模板占位符或补充说明（种子模板里的 `名字：（改成她的名字）`），不是名字 */
const BRACKET_PREFIX = ['（', '(', '[', '［', '{', '｛', '<', '《', '【', '<!--'];

/**
 * 从 `persona/IDENTITY.md` 的正文里认她的名字；认不出 ⇒ null。
 *
 * **这是 `gui/lib/her_name.dart` 的 `herNameFromIdentity` 的逐条镜像，两份必须同形**
 * （权威在 GUI 那一份：界面上的称呼、首次引导的默认唤醒词都读它）。三条判据：
 *
 *   ① 有 `名字：` 那一行 ⇒ **一切以它为准**（写得不清楚就等于没写，不去正文里猜——
 *      这样模板里的示例句永远不可能被当成她的名字）；
 *   ② 没有这一行、且正文还是首启种子模板（`<!-- SEED`）⇒ 认不出（模板里的示例不是她）；
 *   ③ 没有这一行、正文是人写过的 ⇒ 只认最直白的 `我叫…` / `我是…` 兜底，**第一个像名字的**算数
 *      （前一句可能是"我是一个助手"，那就往后找下一句——不因为第一句不像就整份放弃）。
 *
 * 第 ③ 条为什么现在也要有：它是**老实例**的名字唯一能被认出来的路（本机那份第一行就是
 * `我是伊尔弥亚（Irmia）。表面身份：…`）。旧版这里刻意不做散文兜底，于是登记表把她的名字
 * 回落成了目录末段 `data` —— 那正是这次要修的东西。
 */
export function herNameFromIdentity(identity: string | null | undefined): string | null {
  const text = identity ?? '';
  if (text.trim() === '') return null;

  // ① 结构化那一行：有它就以它为准（哪怕它写得不清楚——那等于"没写"，不去正文里猜）
  const match = NAME_LINE.exec(text);
  if (match !== null) return cleanNameValue(match[2] ?? '');

  // ② 正文还是首启种子模板：里面的示例句不是她（老实例升级上来时踩的正是这一条）
  if (text.includes(SEED_MARKER)) return null;

  // ③ 人写过的正文：只认「我叫…」「我是…」，第一个像名字的算数
  for (const prose of text.matchAll(PROSE_NAME)) {
    const token = (prose[1] ?? '').trim();
    if (looksLikeName(token)) return token;
  }
  return null;
}

/**
 * 一行名字 → 能用的名字（不可用返回 null；口径与 `gui/lib/her_name.dart` 的 `_cleanNameValue` 同源）。
 *
 * 去掉的部分：首尾空白、名字后面括号里的外文或注释（`名字：小七（Xiaoqi）` → `小七`）、
 * 行尾标点。拒绝的部分：括号/注释开头（占位符）、含控制字符、超长。
 */
export function cleanNameValue(raw: string): string | null {
  let value = raw.replace(/\s+/gu, ' ').trim();
  if (value === '') return null;
  for (const prefix of BRACKET_PREFIX) {
    if (value.startsWith(prefix)) return null;
  }
  // 括号起的那一段是注解（外文名、身份说明），不是名字本身
  value = value.split(/[（(【[《]/u)[0]!.trim();
  // 行尾标点是排版，不是名字的一部分
  value = value.replace(/[。．.,，;；、:：!！?？~～]+$/u, '').trim();
  if (value === '') return null;
  if (/[\u0000-\u001F\u007F]/u.test(value)) return null;
  if ([...value].length > NAME_MAX_CHARS) return null;
  return value;
}

/**
 * "这一串像不像一个名字"：散文兜底的过滤器（与 `gui/lib/her_name.dart` 的 `_looksLikeName` 同形）。
 *
 * 宁可认不出来（登记表回落到目录末段），也不要把"一个喜欢安静的人"这样的句子片段当成她的名字。
 */
export function looksLikeName(token: string): boolean {
  if (token === '') return false;
  if ([...token].length > NAME_MAX_CHARS) return false;
  // 名字里不会有"的"（"常驻的伙伴"这样的一律不是名字）
  if (token.includes('的')) return false;
  for (const prefix of NOT_NAME_PREFIX) {
    if (token.startsWith(prefix)) return false;
  }
  // 至少要有"字"（汉字/字母/数字），纯标点不是名字
  if (/^[\s，。；、！？：:（）()\[\]【】《》「」…~—\-#*\/\\|·.,;!?]+$/u.test(token)) return false;
  return true;
}

/** 名字行在不在（与 `gui` 那份同一个判据：有这一行就以它为准，哪怕写得不清楚） */
export function hasHerNameLine(identity: string | null | undefined): boolean {
  return NAME_LINE.test(identity ?? '');
}

/** 是种子模板（里面的示例句不是她） */
export function isSeedIdentity(identity: string | null | undefined): boolean {
  return (identity ?? '').includes(SEED_MARKER);
}

/**
 * 入口脚本所在的**安装根**：`<install>/dist/main.js` ⇒ `<install>`；`<install>/main.js` ⇒ `<install>`。
 *
 * 为什么允许两种：出包布局是 `dist/main.js`（构建产物），而开发期可能直接跑别的位置。
 * 判据只看父目录名是不是 `dist`——它不猜"往上几层"，只回答"这一层是不是构建目录"。
 */
export function installRootOf(entry: string): string {
  const abs = resolve(entry);
  const parent = dirname(abs);
  return basename(parent).toLowerCase() === 'dist' ? dirname(parent) : parent;
}

/**
 * 这个数据目录是不是**默认实例的数据目录**。
 *
 * 「默认」= **这个安装根按自己的 `config.json` 跑的那一个**。判据是路径事实，两条：
 *   · 安装根的 `config.json` 里**显式写了** `dataDir` ⇒ 那就是默认数据目录
 *     （本机现场就是这样：程序装在 `<安装根>\app`，config.json 写的数据目录是 `<数据根>\data`，
 *     数据故意放在安装根**外面**——那是"程序归程序、数据归数据"的部署法，不是异常）；
 *   · 没写 ⇒ 默认是 `<安装根>/data`（出厂布局，`--data-dir` / `IRMIA_DATA_DIR` 都不给时
 *     `resolveDataDir` 的最后一档就是 `<cwd>/data`，而 cwd = 安装根）。
 *
 * 为什么不用"谁是第一个登记的"或"谁在 7788"：那两条都会随现场漂，而**路径**是
 * `comparisonKey` 能归一的事实（大小写、分隔符写法不同仍是同一个目录）。
 *
 * 判不出来（入口路径空、config 也没写）⇒ 如实返回 false：默认意味着"界面不许删"，
 * 猜错会把一个普通实例锁成不能删的。
 */
export function defaultDataDirOf(input: {
  /** 入口脚本（`<install>/dist/main.js`）；空串 = 不知道 */
  entry: string;
  /** 安装根那份 `config.json` 里**显式写下的** dataDir（没写就是 null） */
  configDataDir: string | null;
}): string | null {
  if (input.configDataDir !== null && input.configDataDir.trim() !== '') {
    return resolve(input.configDataDir.trim());
  }
  const entry = input.entry.trim();
  if (entry === '') return null;
  return join(installRootOf(entry), 'data');
}

/** 这个数据目录是不是默认实例的那一份（实现见 {@link defaultDataDirOf}） */
export function isDefaultDataDir(input: {
  entry: string;
  dataDir: string;
  configDataDir: string | null;
}): boolean {
  const expected = defaultDataDirOf({ entry: input.entry, configDataDir: input.configDataDir });
  if (expected === null) return false;
  return comparisonKey(expected) === comparisonKey(input.dataDir);
}

// ──────────────────────────────── 小工具 ────────────────────────────────

/** 坏文件改名留证据（`.bad`；改不动就只说一句，反正不能拿它当空表覆盖） */
function backupBadFile(path: string): void {
  try {
    if (!existsSync(path)) return;
    renameSync(path, `${path}.bad`);
  } catch {
    // 改名失败：下面的原子写照样会盖掉它，但至少调用方已经被告知"这条是从坏文件重建的"
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
