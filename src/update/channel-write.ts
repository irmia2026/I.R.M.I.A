/**
 * `POST /api/update/channel` 的**纯函数那一半**：改哪一格、写完怎么对拍。
 *
 * 为什么单独一个文件：这条端点写的是**用户的 `config.json`**，而"写配置文件"在这个仓库里
 * 有自己的严格度（见 `web/server.ts` 的 `withConfigDoc` 与 `applyConfigUpdate`）：
 *   · 只允许写**一个点路径**（`update.channel`），其余键一个字节都不许动；
 *   · 写前保留注释、写后 `loadConfig` 复核；
 *   · **回读对拍**：读回来的值 ≠ 写进去的值 ⇒ 400 + 回滚 + 点名"这一格解析后是 X"；
 *   · 值本来相同 ⇒ **不写盘**（文件 sha256 必须不变）。
 *
 * 把这些判据放在纯函数里，是为了让"回读不一致时回滚"这条能在用例里直接构造出来
 * （真去制造一次 loadConfig 解析出别的值是不可能的——那一格只认两个字面量）。
 */

import type { JsonObject } from '../config/config.js';
import type { UpdateChannel } from './check.js';

/** 唯一允许写的点路径（白名单；别的字段一律拒绝） */
export const UPDATE_CHANNEL_PATH = 'update.channel';

/** 两个字面量；其余一律非法（**不回退默认值**，见 `applyUpdateChannelToDoc` 的注释） */
export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === 'beta' || value === 'stable';
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 盘上那份文档里 `update.channel` 现在是什么（不是两个字面量 / 没有 ⇒ null） */
export function readSavedUpdateChannel(doc: JsonObject): UpdateChannel | null {
  const update = doc['update'];
  if (!isRecord(update)) return null;
  const channel = update['channel'];
  return isUpdateChannel(channel) ? channel : null;
}

/** 一次文档修改的结果（`problem` 非空 ⇒ 调用方必须 400，一个字节都不写） */
export interface UpdateChannelDocChange {
  changed: boolean;
  problem: string | null;
}

/**
 * 把 `update.channel` 写进**文档对象**（就地修改；调用方负责先留一份 before 快照）。
 *
 * 三条：
 *   · 值不在两个字面量里 ⇒ `problem`（**不回退默认**：静默回退等于让人以为切成功了）；
 *   · `update` 存在但不是对象 ⇒ `problem`（不猜、不覆盖——那可能是手工写坏的一段）；
 *   · 值本来就相同 ⇒ `changed:false`（调用方据此**不写盘**，文件 sha256 不变）。
 */
export function applyUpdateChannelToDoc(doc: JsonObject, channel: unknown): UpdateChannelDocChange {
  if (!isUpdateChannel(channel)) {
    return { changed: false, problem: 'channel 只能是 "beta" 或 "stable"' };
  }
  const raw = doc['update'];
  if (raw !== undefined && raw !== null && !isRecord(raw)) {
    return { changed: false, problem: 'config.json 的 update 必须是对象（现在不是），拒绝在它上面改 channel' };
  }
  const update: JsonObject = isRecord(raw) ? raw : {};
  if (update['channel'] === channel) return { changed: false, problem: null };
  update['channel'] = channel;
  doc['update'] = update;
  return { changed: true, problem: null };
}

/** 规范化（键排序）后的 JSON：判"两份文档除某一格外是否逐字相同"用 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** 两份配置文档**除 `update.channel` 之外**是否逐字相同（改到别的键 = 违规） */
export function sameConfigDocExceptChannel(before: JsonObject, after: JsonObject): boolean {
  const strip = (doc: JsonObject): JsonObject => {
    const clone = JSON.parse(JSON.stringify(doc)) as JsonObject;
    const update = clone['update'];
    if (isRecord(update)) delete update['channel'];
    return clone;
  };
  return canonical(strip(before)) === canonical(strip(after));
}

/**
 * 写后对拍。`null` = 通过；非空 = 一句可以直接回 400 的人话（**调用方必须回滚原文件**）。
 *
 * 三条判据分别对应一种真实故障：
 *   ① `loadConfig` 解析出来的值不是写进去的那个（比如将来有人给这一格加了别名/迁移）；
 *   ② 盘上回读的原始文档里那一格不是写进去的那个（写盘/编码/rename 出了问题）；
 *   ③ 除那一格之外还有别的东西变了（"只写一个点路径"这条承诺被破坏）。
 */
export function verifyUpdateChannelWrite(input: {
  before: JsonObject;
  /** **写完之后从盘上重新读回来的**文档（不是内存里那份） */
  readBack: JsonObject;
  /** `loadConfig` 复核出来的生效值 */
  reloadedChannel: unknown;
  requested: UpdateChannel;
}): string | null {
  const { before, readBack, reloadedChannel, requested } = input;
  if (reloadedChannel !== requested) {
    return `update.channel 解析后是 ${String(reloadedChannel)}（期望 ${requested}）：写盘被回滚，配置文件保持原样`;
  }
  const saved = readSavedUpdateChannel(readBack);
  if (saved !== requested) {
    return `update.channel 回读是 ${String(saved)}（期望 ${requested}）：写盘被回滚，配置文件保持原样`;
  }
  if (!sameConfigDocExceptChannel(before, readBack)) {
    return '这次写入改动了 update.channel 之外的字段：已回滚，配置文件保持原样';
  }
  return null;
}
