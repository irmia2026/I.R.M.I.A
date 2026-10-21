/**
 * Irmia Agent — 一键装协议端（框架代下载 + 解压）
 *
 * 用户拍板："**框架需要引导客户安装 snowluma，并且尽量少让对方配置**。"
 * 所以这一步的目标是把"找 release → 下 zip → 解压 → 填路径"四步手工，压成**一次点击**。
 *
 * **为什么框架能代下载**：我们只是替他点了一下下载——包从**官方 Releases** 拿，
 * 不随框架分发、不改它一个字节。
 *
 * SnowLuma 的许可（LICENSE §3）**允许再分发**，条件是：非商业、附完整许可文本、
 * 不改动声明、公开修改版要事先授权。我们连"再分发"都算不上（没有随框架分发任何东西），
 * 只是把人本来要手动做的三步代劳了；包里自带 `LICENSE`/`EULA.md`/`PRIVACY.md`，
 * 随包落地，正好满足"附完整许可文本"。
 *
 * 真正需要避开的是另外两条：**§4(b)**（不得基于它开发、发布或分发另一个项目——
 * 所以我们只做进程托管，不包装它的 API、不基于它写衍生品）与 **§5**（原生件专有，
 * 不授予**单独**再分发——所以我们从不把 `native/*.node` 拆出来单独给谁）。
 *
 * **装到哪**：`<dataDir>/services/snowluma/`。不放进 `tools/`（那是 pwsh/rg/es 那些
 * 一次性小工具的家）：这是长驻服务，探测方式、升级方式、生命周期都不一样，
 * 混在一起将来会互相绊。
 */

import { existsSync } from 'node:fs';
import { rm, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  downloadWithNode, extractZipToDirectory, readZipEntries, type Downloader,
} from '../deps/install.ts';

/** 协议端在数据目录下的家 */
export const SERVICES_DIR_NAME = 'services';
/** 下载缓存的子目录（失败了人能自己去看那半截文件） */
export const SERVICE_CACHE_DIR_NAME = '.cache';
/** 官方仓库（release 从这儿拿，不从任何镜像） */
export const SNOWLUMA_REPO = 'SnowLuma/SnowLuma';

export interface SnowLumaAsset {
  name: string;
  url: string;
  size: number;
}

export interface SnowLumaInstallInput {
  dataDir: string;
  /** 下载实现（默认 `downloadWithNode`；测试注入假的） */
  download?: Downloader | undefined;
  /** 取文本（GitHub API 那条路；默认用 node:https） */
  fetchText?: ((url: string) => Promise<string>) | undefined;
  /** 目标平台，默认当前平台（测试注入） */
  platform?: NodeJS.Platform | undefined;
  /** 进度出口：下载/解压的每一步都报一句，界面直接显示 */
  onProgress?: ((line: string) => void) | undefined;
  timeoutMs?: number | undefined;
}

export interface SnowLumaInstallOutcome {
  ok: boolean;
  /** 装好后的目录（ok 为 true 时一定有） */
  dir?: string;
  /** 装的是哪个版本（取自 release tag） */
  version?: string;
  /** 一句话结果或失败原因 */
  detail: string;
  /** 过程记录（给人看的，含每一步与耗时） */
  log: string[];
}

/** 协议端的安装目录（探测、安装、拉起三处共用这一个约定） */
export function snowlumaServiceDir(dataDir: string): string {
  return join(dataDir, SERVICES_DIR_NAME, 'snowluma');
}

/**
 * 从 release 的资产清单里挑出该平台该用的包。
 *
 * 只认 **lite** 包：完整包 37.8 MB 里带的是它自己的原生组件包，我们用不上，
 * 而 lite 只有 4.6 MB、自包含、只要 Node 22.13+（我们本来就有）。
 *
 * **只支持 Windows**：Windows/Linux 的 lite 包都是 zip，macOS 也是 zip，
 * 但 Linux 那边官方发的是 `.tar.gz`——解压器只认 zip（零依赖手写的），
 * 所以这里明确返回 null 让上层说清楚"这个平台请手动安装"，而不是下载一个解不开的文件。
 */
export function pickLiteAsset(
  assets: readonly SnowLumaAsset[],
  platform: NodeJS.Platform,
): SnowLumaAsset | null {
  if (platform !== 'win32') return null;
  const wanted = 'win-x64-lite.zip';
  return assets.find((a) => a.name.endsWith(wanted)) ?? null;
}

/** GitHub release 的最小形状（只取我们要的字段，别的一概不认） */
interface GithubRelease {
  tag_name?: unknown;
  assets?: unknown;
}

/** 从 GitHub API 的响应里解析出 tag 与资产清单；形状不对返回 null（不猜） */
export function parseRelease(raw: string): { tag: string; assets: SnowLumaAsset[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rel = parsed as GithubRelease;
  const tag = typeof rel.tag_name === 'string' ? rel.tag_name : '';
  if (tag === '') return null;
  if (!Array.isArray(rel.assets)) return null;
  const assets: SnowLumaAsset[] = [];
  for (const item of rel.assets) {
    if (typeof item !== 'object' || item === null) continue;
    const a = item as Record<string, unknown>;
    const name = typeof a['name'] === 'string' ? a['name'] : '';
    const url = typeof a['browser_download_url'] === 'string' ? a['browser_download_url'] : '';
    const size = typeof a['size'] === 'number' ? a['size'] : 0;
    if (name === '' || url === '') continue;
    assets.push({ name, url, size });
  }
  return { tag, assets };
}

/** 默认的取文本：node:https，带 User-Agent（GitHub API 不给 UA 会 403） */
async function defaultFetchText(url: string, timeoutMs: number): Promise<string> {
  const { get } = await import('node:https');
  return await new Promise<string>((resolve, reject) => {
    const req = get(url, { headers: { 'user-agent': 'irmia-agent', accept: 'application/vnd.github+json' } }, (res) => {
      const code = res.statusCode ?? 0;
      if (code < 200 || code >= 300) {
        res.resume();
        reject(new Error(`HTTP ${code}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('取 release 信息超时')); });
    req.on('error', reject);
  });
}

/**
 * 装一份协议端。**任何失败都返回 `ok:false` 而不抛**——安装是用户点的动作，
 * 失败要能变成界面上的一句话，而不是把整个进程带崩。
 */
export async function installSnowLuma(input: SnowLumaInstallInput): Promise<SnowLumaInstallOutcome> {
  const log: string[] = [];
  const say = (line: string): void => {
    log.push(line);
    input.onProgress?.(line);
  };
  const platform = input.platform ?? process.platform;
  const timeoutMs = input.timeoutMs ?? 30_000;
  const dir = snowlumaServiceDir(input.dataDir);
  const download = input.download ?? downloadWithNode;
  const fetchText = input.fetchText ?? ((url: string) => defaultFetchText(url, timeoutMs));

  if (platform !== 'win32') {
    return {
      ok: false,
      detail: `一键安装目前只支持 Windows（官方在 Linux 上发的是 .tar.gz，而解压器只认 zip）。`
        + '请从 https://github.com/SnowLuma/SnowLuma/releases 手动下载解压，再把目录填进来。',
      log,
    };
  }

  // ① 问官方要最新 release（从官方仓库拿，不从任何镜像）
  say('正在查询官方 Releases…');
  let release: { tag: string; assets: SnowLumaAsset[] } | null = null;
  try {
    const raw = await fetchText(`https://api.github.com/repos/${SNOWLUMA_REPO}/releases/latest`);
    release = parseRelease(raw);
  } catch (err) {
    return { ok: false, detail: `查不到最新版本（${errText(err)}）——检查网络，或手动下载后把目录填进来。`, log };
  }
  if (release === null) {
    return { ok: false, detail: '官方 Releases 的回应看不懂（形状变了？）——请手动下载。', log };
  }
  const asset = pickLiteAsset(release.assets, platform);
  if (asset === null) {
    return { ok: false, detail: `这个版本（${release.tag}）里没有找到 lite 包——请手动下载。`, log };
  }
  say(`找到 ${release.tag} 的 ${asset.name}（${(asset.size / 1024 / 1024).toFixed(1)} MB）`);

  // ② 下载到缓存目录（失败留下的半截文件人能自己看）
  const cacheDir = join(input.dataDir, SERVICES_DIR_NAME, SERVICE_CACHE_DIR_NAME);
  await mkdir(cacheDir, { recursive: true });
  const zipPath = join(cacheDir, asset.name);
  await rm(zipPath, { force: true }).catch(() => undefined);
  say('正在下载…');
  try {
    const result = await download(asset.url, zipPath);
    if (!result.ok) return { ok: false, detail: `下载失败：${result.error ?? '原因不明'}`, log };
  } catch (err) {
    return { ok: false, detail: `下载失败：${errText(err)}`, log };
  }
  const bytes = (await stat(zipPath).catch(() => null))?.size ?? 0;
  say(`下载完成（${(bytes / 1024 / 1024).toFixed(1)} MB）`);

  // ③ 解压到它的家。`extractZipToDirectory` 会先清空目标目录——这里是有意的：
  //    重装/升级都该是一次干净落地，而不是把新版本盖在旧的文件堆上。
  say('正在解压…');
  const { readFile } = await import('node:fs/promises');
  const entries = readZipEntries(await readFile(zipPath));
  if (!entries.ok) return { ok: false, detail: `这个包不是有效的 zip：${entries.error ?? '解析失败'}`, log };
  const extracted = await extractZipToDirectory(entries.entries, dir);
  if (!extracted.ok) return { ok: false, detail: `解压失败：${extracted.error}`, log };
  say(`解压完成（${extracted.written} 个文件）`);

  // ④ 复检：解压成功不等于能跑（这正是 deps 那边学到的教训——装完不验就报"已装好"，
  //    用户会在很久以后才发现没生效）。这里验最要紧的一条：入口文件在不在。
  if (!existsSync(join(dir, 'index.mjs'))) {
    return {
      ok: false,
      detail: '解压完了但没找到 index.mjs——包结构可能变了，请手动确认或换个版本。',
      log,
    };
  }
  say(`就绪：${dir}`);
  return { ok: true, dir, version: release.tag, detail: `已装好 ${release.tag}`, log };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
