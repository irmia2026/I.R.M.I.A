/**
 * Irmia Agent — 托管 Python 的 **pip 引导**（`src/deps/`）
 *
 * 这段为什么单独一个文件：它**不是**外部依赖探测/安装的通用机制，而是 Python 这一件独有的
 * 收尾步骤。塞进 `install.ts` 会把那份"下载 → 解压 → 复检"的通用编排染上 Python 的细节。
 *
 * ──────────────────────────── 实测事实（**先证后写**，别照抄网上的说法） ────────────────────────────
 *
 * 用户 2026-10-16：「**pip 必须要，方便后续 agent 自行拓展能力。**」于是这件事从
 * "将来的下一步"变成必做。而**网上最常说的两条路，在这台机器上都走不通**（逐条实测 disproved）：
 *
 *   ❌ `python -m ensurepip` —— 它对**完整安装版**有效，而 embeddable 包里**根本没有 ensurepip 模块**。
 *      实测：`python.exe: No module named ensurepip`（真包 `python-3.13.16-embed-amd64.zip` 解压后）。
 *      这一条是关键：谁要是照着"embeddable 也能 ensurepip"写，装完会得到一个**没有 pip 的 python**，
 *      而且失败得很安静（ensurepip 的退出码被当成"引导失败"而不是"这条路不存在"）。
 *   ❌ `python <pip.whl> install pip`（get-pip.py 内部干的事）—— 在 embeddable 环境里报
 *      `can't find '__main__' module in ...pip-26.2.1-py3-none-any.whl`：pip 的 wheel 里
 *      **没有可执行的 `__main__`** 能这样被当作脚本跑（完整版能跑是因为它的 bootstrap 路径不同）。
 *
 *   ✅ **可行的那条**：wheel 本身就是个 zip ⇒ **用我们已有的解压器**把 pip 的 wheel
 *      直接铺进 `Lib\site-packages`。实测：476 个成员铺进去之后
 *      `python -m pip --version` → `pip 26.2.1 from <数据目录>\tools\python\Lib\site-packages\pip (python 3.13)`，
 *      随后 `pip install six`（离线 wheel）与 `pip install packaging`（联网）**都真的装上了**。
 *
 * 三个附带好处（这是选它的理由，不只是"它能用"）：① **零依赖**——复用 `install.ts` 的
 * `readZipEntries`，不引包也不新增子进程协议；② **离线可成**——同一个 wheel 文件让用户手动放，
 * 与主包的离线回退走同一条路；③ **不需要 site-packages 预先存在**（我们自己 mkdir）。
 *
 * ──────────────────────────── 两处必须改的现场（少一处 pip 就是"装了但 import 不到"） ────────────────────────────
 *
 *   ① **`python3XX._pth` 里放开 `import site`**：embeddable 包的 `_pth` 存在时 Python **忽略
 *      `PYTHONPATH` 与环境变量、也不执行 site 初始化** ⇒ 不放开的话 `sys.path` 里没有
 *      `Lib\site-packages`，铺进去的 pip 一个字节都不生效。实测放开后
 *      `any(p.endswith('site-packages') for p in sys.path)` 才是 True。
 *      文件名**不许写死版本号**（`python313._pth` 会变成 `python315._pth`）⇒ 按 `python3*. _pth` 找。
 *   ② **`Lib\site-packages` 要自己建**：`_pth` 里那一行只是"加进 sys.path"的声明，
 *      目录不存在时 pip 会找不到落点（实测：目录不存在时解压目标也就无从谈起）。
 *
 * 零外部依赖：只用 node: 标准库。
 */

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

import { readZipEntries, stripSingleTopDir, zipEntryPath, type Downloader, type ZipEntry } from './install.ts';
import { defaultDepFs } from './probe.ts';
import { decodeText, utf8ConsoleEnv } from '../util/bytes-text.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** pip 的 PyPI 元数据端点（`info.version` + `urls[]` 里带文件名、地址、sha256、requires_python） */
export const PYPI_PIP_JSON_URL = 'https://pypi.org/pypi/pip/json';

/**
 * 钉住的兜底：pip 26.2.1（2026-10-16 实测，1,816,632 字节，sha256 由 PyPI 元数据给出）。
 * 只在"查询最新版"失败时用——写死的那一刻就开始过期，但**过期不等于坏掉**
 * （pip 的老版本照样能装包，只是装的包可能要求更新的 pip）。
 */
export const PIP_FALLBACK_VERSION = '26.2.1';
export const PIP_FALLBACK_URL =
  'https://files.pythonhosted.org/packages/f3/6e/1736e5b4ae2b778ef2f81c47d797de9f891d4d8acb047a24ca37a60294dd/'
  + 'pip-26.2.1-py3-none-any.whl';
export const PIP_FALLBACK_SHA256 =
  '71138adf1f4ca900cdb7d289c21b7494329f2332b6d85f0e1c42108c0384ed3e';

/** `_pth` 里那一行原文与放开后的样子（实测原文带 `#`：`#import site`） */
const PTH_SITE_COMMENTED = '#import site';
const PTH_SITE_ENABLED = 'import site';
/** `_pth` 里声明 site-packages 的那一行（相对 python 根，反斜杠是官方写法） */
const PTH_SITE_PACKAGES = 'Lib\\site-packages';

/**
 * "这确实是 pip 的 wheel"的判据：wheel 里必有 `pip/__init__.py`（实测 476 个成员里第一个就是它）。
 *
 * 为什么需要它（P1-22）：联网那条路拿得到 PyPI 的 sha256，手动放的那份没有权威哈希可比。
 * 拿不到哈希时**不能什么都不做**——至少得证明"是合法 zip + 成员安全 + 真的是 pip"，
 * 否则一份放错的包会在"铺开 → 复检失败"之后才暴露，而那时已经往 site-packages 里灌了别人的文件。
 */
const PIP_ENTRY_MARKER = 'pip/__init__.py';

/** pip 引导的超时：解压上万个小文件 + 一次 `pip --version`，60s 够（联网那条另有下载超时） */
export const PIP_VERIFY_TIMEOUT_MS = 60_000;

/** `python -m pip --version` 的第一行形如 `pip 26.2.1 from <路径> (python 3.13)` */
export function parsePipVersion(stdout: string): string | null {
  const matched = /^pip\s+(\d+\.\d+(?:\.\d+)?)/mu.exec(stdout.trim());
  return matched === null ? null : matched[1]!;
}

// ──────────────────────────────── 形状 ────────────────────────────────

export interface PipBootstrapInput {
  /** 托管 Python 的落地目录（`<dataDir>/tools/python/`） */
  dir: string;
  /** 下载器：与主包**共用同一个**（测试注入假源，绝不联网） */
  download: Downloader;
  /** 文本抓取（PyPI 元数据那条路）；省略时用调用方给的那个 */
  fetchText?: ((url: string) => Promise<string>) | undefined;
  /** 缓存目录（`<dataDir>/tools/.cache/`）；wheel 与离线包都放这里 */
  cacheDir: string;
  /** 手动放的 pip wheel 路径（离线回退）；省略时 = `<cacheDir>/pip.whl` */
  offlineWheel?: string | undefined;
  /** 命令执行注入点（测试用：真路径上是一段真 python，测试里跑不起来） */
  runCommand?: ((exe: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string; code: number | null }>) | undefined;
  /** 落实的 sha256 校验开关（测试里的假 wheel 没有真哈希；生产路径必须开） */
  verifySha256?: boolean | undefined;
}

export interface PipBootstrapOutcome {
  ok: boolean;
  /** 引导成功时的 pip 版本（`26.2.1`）；失败时为空串 */
  version: string;
  /** 失败的**确切阶段**：`pth` / `metadata` / `download` / `unpack` / `verify` */
  step: 'pth' | 'metadata' | 'download' | 'unpack' | 'verify';
  /** 给用户看的一句话（含下一步） */
  reason: string;
  /** 逐步细节（报告里逐行列出） */
  details: string[];
}

// ──────────────────────────────── 默认命令执行 ────────────────────────────────

/**
 * 跑一次命令并收输出（`python -m pip --version` 用；ENOENT/超时都只是"这个不可用"）。
 *
 * **收原始字节、结束时一次解码**（2026-10-18 收口）：原来是 `setEncoding('utf8')`，
 * 而 pip 的报错/警告在中文 Windows 上是 GBK 字节——流式 utf8 会当场换成 U+FFFD，
 * 而那句 reason 是要原样回给用户看的。
 */
function runCommandDefault(
  exe: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { stdout: string; stderr: string; code: number | null }): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, [...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // 与 deps/probe 同一处：让 python 按 UTF-8 写（见 util/bytes-text.ts）
        env: utf8ConsoleEnv(),
      });
    } catch (err) {
      finish({ stdout: '', stderr: String(err), code: null });
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const decodeStreams = (): { stdout: string; stderr: string } => ({
      stdout: decodeText(Buffer.concat(stdoutChunks)).text,
      stderr: decodeText(Buffer.concat(stderrChunks)).text,
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
      const { stdout, stderr } = decodeStreams();
      finish({ stdout, stderr, code: null });
    }, PIP_VERIFY_TIMEOUT_MS);
    // 不设 setEncoding：解码推迟到 close（见函数注释）
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.stdout?.on('error', () => undefined);
    child.stderr?.on('error', () => undefined);
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      const { stdout, stderr } = decodeStreams();
      finish({ stdout, stderr: stderr === '' ? err.message : stderr, code: null });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      const { stdout, stderr } = decodeStreams();
      finish({ stdout, stderr, code });
    });
  });
}

// ──────────────────────────────── `_pth` 放行 ────────────────────────────────

/** 托管目录里的 `python3XX._pth`（**按形状找，不写死版本号**）；找不到返回 null */
export function findPthFile(dir: string, listDir: (dir: string) => string[] = defaultDepFs.listDir): string | null {
  let entries: string[] = [];
  try {
    entries = listDir(dir).slice().sort();
  } catch {
    return null;
  }
  // `python313._pth` / `python315._pth` / `python3._pth` 都认；排序保证同一目录下结论稳定
  const matched = entries.find((name) => /^python3\d*\._pth$/u.test(name));
  return matched === undefined ? null : join(dir, matched);
}

/**
 * 放开 `_pth` 里的 `import site` 并补上 `Lib\site-packages` 那一行。
 *
 * **幂等**：已经是放开状态就不重复加（第二次装/复检重跑不该把文件越改越长）。
 * 行尾统一写 `\n`：那是 Python 官方文档明确支持的写法（实测改后 `sys.path` 立刻包含
 * `Lib\site-packages`），而且避免在 Windows 上因 CRLF 判断产生两套字节。
 */
export async function enableSiteInPth(pthPath: string): Promise<string[]> {
  const before = await readFile(pthPath, 'utf8');
  const details: string[] = [];
  const lines = before.split(/\r?\n/);
  let sawSite = false;
  let sawSitePackages = false;
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === PTH_SITE_COMMENTED) {
      out.push(PTH_SITE_ENABLED);
      sawSite = true;
      continue;
    }
    if (trimmed === PTH_SITE_ENABLED) sawSite = true;
    if (trimmed === PTH_SITE_PACKAGES) sawSitePackages = true;
    out.push(line);
  }
  if (!sawSite) {
    out.push(PTH_SITE_ENABLED);
    details.push(`_pth 里没有 import site 那一行，已补上`);
  } else if (before.includes(PTH_SITE_COMMENTED)) {
    details.push(`已放开 ${pthPath} 里的 \`${PTH_SITE_COMMENTED}\` → \`${PTH_SITE_ENABLED}\``);
  } else {
    details.push(`_pth 里的 import site 早已放开（幂等，没重复改）`);
  }
  if (!sawSitePackages) {
    out.push(PTH_SITE_PACKAGES);
    details.push(`_pth 里补上 ${PTH_SITE_PACKAGES}`);
  }
  // 去掉末尾空行再统一补一个换行
  while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
  await writeFile(pthPath, `${out.join('\n')}\n`, 'utf8');
  return details;
}

// ──────────────────────────────── 取 pip 的 wheel ────────────────────────────────

export interface PipWheelPick {
  ok: boolean;
  url: string;
  version: string;
  sha256: string;
  error: string;
}

/**
 * 从 PyPI 的 JSON 里挑"最新 pip 的 py3-none-any wheel"。
 *
 * 只看 `urls[]`（**当前版本**的文件清单）而不是 `releases`（全部历史）：我们要的就是
 * "最新那一个"，历史清单几十兆且没必要。`requires_python` 不看——解释器版本由我们决定
 * （最低 3.8 那条判据在 probe.ts），真装不上时复检会如实报。
 */
export function pickPipWheel(text: string): PipWheelPick {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, url: '', version: '', sha256: '', error: 'PyPI 的 pip 元数据不是 JSON（可能被网络中间层拦截）' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, url: '', version: '', sha256: '', error: 'PyPI 的 pip 元数据是意外结构' };
  }
  const record = parsed as Record<string, unknown>;
  const info = typeof record['info'] === 'object' && record['info'] !== null
    ? record['info'] as Record<string, unknown>
    : {};
  const version = typeof info['version'] === 'string' ? info['version'] : '';
  const urls = Array.isArray(record['urls']) ? record['urls'] : [];
  for (const item of urls) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const name = typeof row['filename'] === 'string' ? row['filename'] : '';
    const url = typeof row['url'] === 'string' ? row['url'] : '';
    // pip 只发一个纯 python 的 wheel（`pip-XX.Y.Z-py3-none-any.whl`）
    if (!name.endsWith('-py3-none-any.whl') || url === '') continue;
    const digests = typeof row['digests'] === 'object' && row['digests'] !== null
      ? row['digests'] as Record<string, unknown>
      : {};
    const sha = typeof digests['sha256'] === 'string' ? digests['sha256'] : '';
    return { ok: true, url, version: version === '' ? name.replace(/^pip-/u, '').split('-')[0]! : version, sha256: sha, error: '' };
  }
  return { ok: false, url: '', version: '', sha256: '', error: 'PyPI 的 pip 元数据里没有 py3-none-any 的 wheel' };
}

// ──────────────────────────────── 引导主体 ────────────────────────────────

/**
 * 引导 pip。**只做这几件事**（顺序不能换）：
 *   ① 找 `python3XX._pth` 并放开 `import site`（不放开则后面全白干——见文件头）；
 *   ② 建 `Lib\site-packages`；
 *   ③ 取 pip wheel：**先看手动放的那个**（离线优先），否则联网拿最新（失败退回钉住的兜底）；
 *   ④ 校验来源：联网那条比 PyPI 的 sha256；**拿不到权威哈希时**（手动放的包）至少证明
 *      "是合法 zip + 成员安全 + 真的是 pip"，并把实际 sha256 写进 details（P1-22）；
 *   ⑤ 用既有解压器把 wheel 铺进 `Lib\site-packages`（wheel 就是 zip，没有顶层公共目录；
 *      每个成员都过 `zipEntryPath`——与 install.ts 解压器**同一个 zip-slip 判据**）；
 *   ⑥ 复检 `python -m pip --version` —— **引导成功与否只认这一条**；
 *   ⑦ 写一份自包含的 `pip.ini`（镜像/超时都写在这一个文件里，靠 `PIP_CONFIG_FILE` 生效）。
 *
 * 任何一步失败都**如实返回**（阶段名 + 一句话），由调用方决定怎么上报——
 * 这里绝不假装成功：一个"装上了但没有 pip"的 python 会在她第一次 `pip install` 时才暴露，
 * 而那时她早已以为这件事办好了。
 */
export async function bootstrapPip(input: PipBootstrapInput): Promise<PipBootstrapOutcome> {
  const details: string[] = [];
  const fail = (
    step: PipBootstrapOutcome['step'],
    reason: string,
  ): PipBootstrapOutcome => ({ ok: false, version: '', step, reason, details });

  const exePath = join(input.dir, 'python.exe');
  const exe = existsSync(exePath) ? exePath : join(input.dir, 'python3.exe');
  const siteDir = join(input.dir, 'Lib', 'site-packages');

  // ① `_pth` 放行
  const pth = findPthFile(input.dir);
  if (pth === null) {
    return fail('pth', `没找到 python3XX._pth（${input.dir}）——embeddable 包里必然有它，找不到说明包的结构变了。`);
  }
  try {
    details.push(...(await enableSiteInPth(pth)));
  } catch (err) {
    return fail('pth', `改不动 ${pth}：${err instanceof Error ? err.message : String(err)}`);
  }

  // ② site-packages 目录（`--target` 那种装法不会替你建；我们自己建，路径也就确定了）
  try {
    await mkdir(siteDir, { recursive: true });
  } catch (err) {
    return fail('unpack', `建不出 ${siteDir}：${err instanceof Error ? err.message : String(err)}`);
  }

  // ③ 取 wheel：离线优先 → 联网 → 钉住的兜底
  const offlineWheel = input.offlineWheel ?? join(input.cacheDir, 'pip.whl');
  const wheelPath = join(input.cacheDir, 'pip-bootstrap.whl');
  let wheelBytes: Buffer | null = null;
  let wheelVersion = '';
  let wheelSha = '';
  let useOffline = false;
  if (existsSync(offlineWheel)) {
    try {
      wheelBytes = await readFile(offlineWheel);
      useOffline = true;
      details.push(`用的是你手动放的 pip wheel：${offlineWheel}`);
    } catch {
      wheelBytes = null;
    }
  }
  if (wheelBytes === null) {
    let url = PIP_FALLBACK_URL;
    let wantSha = PIP_FALLBACK_SHA256;
    wheelVersion = PIP_FALLBACK_VERSION;
    const fetchText = input.fetchText;
    if (fetchText !== undefined) {
      try {
        const picked = pickPipWheel(await fetchText(PYPI_PIP_JSON_URL));
        if (picked.ok) {
          url = picked.url;
          wantSha = picked.sha256;
          wheelVersion = picked.version;
          details.push(`解析到最新 pip ${picked.version}：${url}`);
        } else {
          details.push(`解析最新 pip 失败，退回钉住的 ${PIP_FALLBACK_VERSION}：${picked.error}`);
        }
      } catch (err) {
        details.push(`查询最新 pip 失败，退回钉住的 ${PIP_FALLBACK_VERSION}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await mkdir(input.cacheDir, { recursive: true });
    const downloaded = await input.download(url, wheelPath);
    if (!downloaded.ok) {
      return fail(
        'download',
        `pip 的 wheel 下载失败：${downloaded.error}。python 已经装好了，但没有 pip。`
        + `可以手动下载 ${url} 放到 ${offlineWheel}，再点一次「安装」。`,
      );
    }
    wheelBytes = await readFile(wheelPath).catch(() => null);
    if (wheelBytes === null) return fail('download', `pip wheel 下载到了但读不出来：${wheelPath}`);
    wheelSha = wantSha;
    details.push(`已下载 pip wheel ${downloaded.bytes} 字节（${url}）`);
  }

  // ④ 校验 sha256：只有联网那条路拿得到权威哈希（PyPI 的 `digests.sha256`）
  let shaVerified = false;
  if (input.verifySha256 !== false && !useOffline && wheelSha !== '') {
    const actual = createHash('sha256').update(wheelBytes).digest('hex');
    if (actual !== wheelSha) {
      return fail('download', `pip wheel 的 sha256 与 PyPI 声明不符（期望 ${wheelSha.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）：包可能被中间层换过，已中止。`);
    }
    shaVerified = true;
    details.push(`pip wheel sha256 校验通过（${actual.slice(0, 12)}…）`);
  }

  // ⑤ 铺进 site-packages：**用既有解压器**（wheel 就是 zip；实测没有顶层公共目录）
  let entries: ZipEntry[];
  try {
    const zip = readZipEntries(wheelBytes);
    if (!zip.ok) return fail('unpack', `pip wheel 不是可读的 zip：${zip.error}`);
    entries = stripSingleTopDir(zip.entries);
  } catch (err) {
    return fail('unpack', `读 pip wheel 失败：${err instanceof Error ? err.message : String(err)}`);
  }

  /**
   * ⑤′ **没有权威哈希可比时**（手动放的包，或 PyPI 元数据里 sha256 为空）不能什么都不做，
   * 也不能假装验过了（P1-22）。这里做得到的三件事，一件不少地做：
   *   ① 是合法 zip —— `readZipEntries` 已经验过（走到这里就是合法的）；
   *   ② 成员安全 —— 下面逐个过 `zipEntryPath`（与 `install.ts` 解压器**同一个判据**）；
   *   ③ 真的是 pip —— 必须有 `pip/__init__.py`，否则不铺（放错了包时早早说清）。
   * 然后把**实际 sha256 写进 details**：事后要查"那天到底铺进去的是哪一份"时，这是唯一的凭据。
   */
  if (!shaVerified) {
    const actual = createHash('sha256').update(wheelBytes).digest('hex');
    if (!entries.some((entry) => entry.name === PIP_ENTRY_MARKER)) {
      return fail(
        'unpack',
        `这份 wheel 里没有 ${PIP_ENTRY_MARKER}：它不像 pip 的 wheel（`
        + `${useOffline ? '你放在 ' + offlineWheel + ' 的那份' : 'PyPI 给的地址下到的那份'}可能放错了），没有铺进 ${siteDir}。`,
      );
    }
    details.push(
      `这份 pip wheel 没有权威 sha256 可比（${useOffline ? '手动放的包' : 'PyPI 没给哈希'}）：`
      + `已按"合法 zip + 成员安全 + 含 ${PIP_ENTRY_MARKER}"校验，实际 sha256 ${actual}（${wheelBytes.byteLength} 字节）`,
    );
  }

  try {
    let unpacked = 0;
    for (const entry of entries) {
      if (entry.name === '') continue;
      // **zip-slip 的唯一判据**（install.ts 的 `zipEntryPath`）：wheel 里的名字同样是外部输入，
      // 一条 `../../evil.py` 就能写到 site-packages 外面去（P1-22 修的就是这条）。
      const target = zipEntryPath(siteDir, entry.name);
      if (target === null) {
        return fail(
          'unpack',
          `pip wheel 里有一个成员路径越界（${entry.name}）：包可能是伪造的或结构异常，已中止铺开。`
          + 'Lib\\site-packages 里可能只铺了一半，重试一次会覆盖它。',
        );
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, entry.data);
      unpacked += 1;
    }
    details.push(`已把 pip 铺进 ${siteDir}（${unpacked} 个文件）`);
  } catch (err) {
    return fail('unpack', `写 ${siteDir} 失败：${err instanceof Error ? err.message : String(err)}`);
  }

  // ⑥ 复核：**只认这一条**
  const run = input.runCommand ?? runCommandDefault;
  const probed = await run(exe, ['-m', 'pip', '--version']);
  const version = parsePipVersion(probed.stdout === '' ? probed.stderr : probed.stdout);
  if (version === null) {
    const why = `${probed.stdout}\n${probed.stderr}`.trim().split(/\r?\n/u)[0] ?? '';
    return fail(
      'verify',
      `pip 铺进去了但复检不通过（退出码 ${probed.code ?? 'null'}：${why || '无输出'}）。`
      + `python 本身可用；pip 要手动装的话见 ${PYPI_PIP_JSON_URL}。`,
    );
  }
  details.push(`pip 复检通过：${version}（${siteDir}）`);

  // ⑦ 自包含配置：靠 `PIP_CONFIG_FILE` 指过来，不污染用户级 %APPDATA%\pip
  try {
    await writeFile(
      join(input.dir, 'pip.ini'),
      '# 由 Irmia 框架生成：托管的 pip 配置。\n'
      + '# 要让它生效，调 python 时带上环境变量 PIP_CONFIG_FILE=<这个文件的路径>。\n'
      + '# 镜像/超时/代理都写在这里，不会动用户级的 %APPDATA%\\pip\\pip.ini。\n'
      + '[global]\n'
      + 'timeout = 30\n'
      + 'disable-pip-version-check = true\n',
      'utf8',
    );
    details.push(`已写 ${join(input.dir, 'pip.ini')}（用 PIP_CONFIG_FILE 指过来即生效）`);
  } catch (err) {
    details.push(`pip.ini 写入失败（不影响 pip 使用）：${err instanceof Error ? err.message : String(err)}`);
  }

  // 下载缓存清掉（手动放的那份不动——那是用户的文件）
  if (!useOffline) {
    try {
      await rm(wheelPath, { force: true });
    } catch {
      /* 删不掉就留着 */
    }
  }

  return { ok: true, version, step: 'verify', reason: '', details };
}

/**
 * 问一个解释器要 pip 版本：`<exe> -m pip --version` ⇒ `26.2.1`（没有 pip 返回 null）。
 *
 * 接收**可执行文件**而不是目录：探测到的可能是完整路径，也可能是 PATH 上的裸名 `python`
 * （本机实测就是这种），两种都交给 spawn 自己解析 PATH。
 */
export async function probePipOf(
  exe: string,
  run?: ((exe: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string; code: number | null }>) | undefined,
): Promise<string | null> {
  const result = await (run ?? runCommandDefault)(exe, ['-m', 'pip', '--version']);
  return parsePipVersion(result.stdout === '' ? result.stderr : result.stdout);
}
