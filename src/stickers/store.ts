import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { stickerExtension } from './media.ts';
import { STICKER_PHASH_MAX_DISTANCE, phashDistance } from './phash.ts';
import {
  emptyStickerState, type StickerEntry, type StickerMime, type StickerPack, type StickerSource, type StickerState,
  type StickerTag, type StickerTaggingResult,
} from './types.ts';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

function numericArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item)) : [];
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  let handle: number | null = null;
  try {
    handle = openSync(tmp, 'wx');
    writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(handle);
    closeSync(handle);
    handle = null;
    renameSync(tmp, path);
  } catch (err) {
    if (handle !== null) closeSync(handle);
    rmSync(tmp, { force: true });
    throw err;
  }
}

function validPackId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/u.test(value);
}

function blankPack(packId: 'owner-stickers' | 'collected'): StickerPack {
  return packId === 'owner-stickers'
    ? { schema: 1, packId, title: '默认表情', source: 'owner', stickers: [] }
    : { schema: 1, packId, title: '静默采收', source: 'collected', stickers: [] };
}

export class StickerStore {
  readonly root: string;
  private readonly clock: () => Date;

  constructor(dataDir: string, clock: () => Date = () => new Date()) {
    this.root = resolve(dataDir, 'stickers');
    this.clock = clock;
  }

  init(): void {
    for (const dir of ['packs', 'inbox', 'rejected']) mkdirSync(join(this.root, dir), { recursive: true });
    for (const packId of ['owner-stickers', 'collected'] as const) {
      const path = this.packPath(packId);
      if (!existsSync(path)) this.writePack(blankPack(packId));
    }
    if (!existsSync(join(this.root, 'state.json'))) writeJsonAtomic(join(this.root, 'state.json'), emptyStickerState());
    this.migrateLegacyCollectedApprovals();
  }

  /**
   * 旧版自动打标会把 collected 条目直接标成 approved。人工审核是唯一出口：
   * 一次性、幂等地把它们降回 pending；owner 包（owner-stickers）不动。
   */
  migrateLegacyCollectedApprovals(): number {
    const path = this.packPath('collected');
    if (!existsSync(path)) return 0;
    const pack = this.readPack('collected');
    let changed = 0;
    for (const entry of pack.stickers) {
      if (entry.status === 'approved' && entry.tagSource !== 'human') {
        entry.status = 'pending';
        changed += 1;
      }
    }
    if (changed > 0) this.writePack(pack);
    return changed;
  }

  private packPath(packId: string): string {
    if (!validPackId(packId)) throw new Error(`非法贴纸包 id：${packId}`);
    return join(this.root, 'packs', packId, 'pack.json');
  }

  readPack(packId: string): StickerPack {
    const path = this.packPath(packId);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as StickerPack;
    if (parsed.schema !== 1 || parsed.packId !== packId || !Array.isArray(parsed.stickers)) {
      throw new Error(`贴纸包索引损坏：${packId}`);
    }
    return parsed;
  }

  writePack(pack: StickerPack): void {
    writeJsonAtomic(this.packPath(pack.packId), pack);
  }

  listPacks(): StickerPack[] {
    this.init();
    const out: StickerPack[] = [];
    for (const name of readdirSync(join(this.root, 'packs')).sort()) {
      if (existsSync(this.packPath(name))) out.push(this.readPack(name));
    }
    return out;
  }

  listEntries(): Array<{ pack: StickerPack; entry: StickerEntry }> {
    return this.listPacks().flatMap((pack) => pack.stickers.map((entry) => ({ pack, entry })));
  }

  findById(id: string): { pack: StickerPack; entry: StickerEntry } | null {
    return this.listEntries().find(({ entry }) => entry.id === id) ?? null;
  }

  findBySha256(sha256: string): { pack: StickerPack; entry: StickerEntry } | null {
    return this.listEntries().find(({ entry }) => entry.sha256 === sha256) ?? null;
  }

  /** Nearest perceptual hash within maxDistance; null if none. */
  findByPHash(phash: string, maxDistance = STICKER_PHASH_MAX_DISTANCE): { pack: StickerPack; entry: StickerEntry } | null {
    if (!/^[0-9a-f]{16}$/u.test(phash)) return null;
    let best: { pack: StickerPack; entry: StickerEntry; distance: number } | null = null;
    for (const row of this.listEntries()) {
      if (row.entry.phash === undefined) continue;
      const distance = phashDistance(row.entry.phash, phash);
      if (distance <= maxDistance && (best === null || distance < best.distance)) {
        best = {...row, distance};
      }
    }
    return best === null ? null : {pack: best.pack, entry: best.entry};
  }

  setPHash(id: string, phash: string): StickerEntry {
    if (!/^[0-9a-f]{16}$/u.test(phash)) throw new Error('非法感知哈希');
    const found = this.findById(id);
    if (found === null) throw new Error(`找不到贴纸：${id}`);
    found.entry.phash = phash;
    this.writePack(found.pack);
    return found.entry;
  }

  entriesMissingPHash(): Array<{
    packId: string; id: string; file: string; path: string; mime: StickerMime;
  }> {
    return this.listEntries()
      .filter(({ entry }) => entry.phash === undefined)
      .map(({ pack, entry }) => ({
        packId: pack.packId,
        id: entry.id,
        file: entry.file,
        path: this.entryPath(pack.packId, entry.file),
        mime: this.mimeOfEntry(entry),
      }));
  }

  entryPath(packId: string, file: string): string {
    const full = resolve(this.root, 'packs', packId, file);
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new Error('贴纸文件越出数据目录');
    return full;
  }

  readEntryBytes(id: string): Buffer {
    const found = this.findById(id);
    if (found === null) throw new Error(`找不到贴纸：${id}`);
    return readFileSync(this.entryPath(found.pack.packId, found.entry.file));
  }

  importSticker(input: {
    bytes: Buffer;
    mime: StickerMime;
    source: Exclude<StickerSource, 'plugin'>;
    addedAt?: string;
    phash?: string;
  }): { entry: StickerEntry; duplicate: boolean } {
    this.init();
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const existing = this.findBySha256(sha256);
    if (existing !== null) return { entry: existing.entry, duplicate: true };
    const packId = input.source === 'collected' ? 'collected' : 'owner-stickers';
    const pack = this.readPack(packId);
    const ext = stickerExtension(input.mime);
    const file = `../../inbox/${sha256}.${ext}`;
    const id = `${packId === 'collected' ? 'collected' : 'ws'}-${sha256.slice(0, 16)}`;
    const entry: StickerEntry = {
      id, file, tags: [], intensity: 'obvious', status: 'pending', sha256,
      ...(input.phash === undefined ? {} : {phash: input.phash}),
      addedAt: input.addedAt ?? this.clock().toISOString(), tagSource: 'auto', tagConfidence: 0,
      note: '', stats: { sent: 0, lastSentAt: null },
    };
    const target = this.entryPath(packId, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, input.bytes);
    pack.stickers.push(entry);
    this.writePack(pack);
    return { entry, duplicate: false };
  }

  applyTagging(id: string, result: StickerTaggingResult, approved: boolean): StickerEntry {
    const found = this.findById(id);
    if (found === null) throw new Error(`找不到待打标贴纸：${id}`);
    const { pack, entry } = found;
    const next: StickerEntry = {
      ...entry,
      tags: [...result.tags],
      intensity: result.intensity,
      tagConfidence: result.confidence,
      note: result.note,
      // applyTagging(true) 是人工/夹具路径；自动路径永远传 false。
      tagSource: approved ? 'human' : entry.tagSource,
      status: approved ? 'approved' : 'pending',
    };
    if (approved) {
      const ext = stickerExtension(this.mimeOfEntry(entry));
      const target = `cache/${entry.sha256}.${ext}`;
      this.moveEntryFile(pack.packId, entry.file, target);
      next.file = target;
    }
    Object.assign(entry, next);
    this.writePack(pack);
    return entry;
  }

  review(
    id: string,
    action: 'approve' | 'reject' | 'restore' | 'delete' | 'block',
    patch: { tags?: StickerTag[]; intensity?: StickerEntry['intensity'] } = {},
  ): StickerEntry {
    const found = this.findById(id);
    if (found === null) throw new Error(`找不到贴纸：${id}`);
    const { pack, entry } = found;
    if (patch.tags !== undefined) entry.tags = [...patch.tags];
    if (patch.intensity !== undefined) entry.intensity = patch.intensity;
    entry.tagSource = 'human';
    if (action === 'block') entry.status = 'blocked';
    if (action === 'approve' || action === 'restore') {
      const target = `cache/${entry.sha256}.${stickerExtension(this.mimeOfEntry(entry))}`;
      this.moveEntryFile(pack.packId, entry.file, target);
      entry.file = target;
      entry.status = 'approved';
      delete entry.rejectedAt;
    }
    if (action === 'reject' || action === 'delete') {
      const target = `../../rejected/${entry.sha256}.${stickerExtension(this.mimeOfEntry(entry))}`;
      this.moveEntryFile(pack.packId, entry.file, target);
      entry.file = target;
      entry.status = 'rejected';
      entry.rejectedAt = this.clock().toISOString();
    }
    this.writePack(pack);
    return entry;
  }

  /**
   * 彻底丢弃一条自动采收记录：从包索引删除 + 删文件。人工 review('reject') 不走这里。
   * 找不到返回 false；文件已缺失或删除失败不回滚索引（记录已经不该留在库里）。
   */
  discard(id: string): boolean {
    const found = this.findById(id);
    if (found === null) return false;
    const { pack, entry } = found;
    pack.stickers = pack.stickers.filter((item) => item.id !== id);
    this.writePack(pack);
    try {
      rmSync(this.entryPath(pack.packId, entry.file), { force: true });
    } catch {
      // 索引已经移除；坏路径/权限问题不应把已丢弃的记录重新暴露出来。
    }
    return true;
  }

  update(id: string, patch: { tags?: StickerTag[]; intensity?: StickerEntry['intensity'] }): StickerEntry {
    const found = this.findById(id);
    if (found === null) throw new Error(`找不到贴纸：${id}`);
    if (patch.tags !== undefined) found.entry.tags = [...patch.tags];
    if (patch.intensity !== undefined) found.entry.intensity = patch.intensity;
    found.entry.tagSource = 'human';
    this.writePack(found.pack);
    return found.entry;
  }

  purgeRejected(olderThanMs?: number, id?: string): number {
    let count = 0;
    for (const pack of this.listPacks()) {
      const keep: StickerEntry[] = [];
      for (const entry of pack.stickers) {
        const oldEnough = olderThanMs === undefined || Date.parse(entry.rejectedAt ?? entry.addedAt) <= olderThanMs;
        if (entry.status === 'rejected' && oldEnough && (id === undefined || entry.id === id)) {
          rmSync(this.entryPath(pack.packId, entry.file), { force: true });
          count += 1;
        } else keep.push(entry);
      }
      if (keep.length !== pack.stickers.length) {
        pack.stickers = keep;
        this.writePack(pack);
      }
    }
    return count;
  }

  recordSent(id: string, at = this.clock(), turn?: number): StickerEntry {
    const found = this.findById(id);
    if (found === null) throw new Error(`找不到贴纸：${id}`);
    const { pack, entry } = found;
    entry.stats.sent += 1;
    entry.stats.lastSentAt = at.toISOString();
    this.writePack(pack);
    const state = this.readState();
    state.sent.push({ stickerId: id, atMs: at.getTime() });
    state.sent = state.sent.filter((item) => at.getTime() - item.atMs <= 30 * DAY_MS);
    state.recent = [id, ...state.recent.filter((item) => item !== id)].slice(0, 10);
    if (turn !== undefined) state.lastStickerTurn = turn;
    this.writeState(state);
    return entry;
  }

  candidates(tag: StickerTag, now = this.clock()): StickerEntry[] {
    const state = this.readState();
    const recent = new Set(state.recent.slice(0, 10));
    return this.listEntries()
      .map(({ entry }) => entry)
      .filter((entry) => entry.status === 'approved' && entry.tags.includes(tag) && !recent.has(entry.id))
      .filter((entry) => state.sent.filter((item) => item.stickerId === entry.id && now.getTime() - item.atMs <= 30 * DAY_MS).length < 3);
  }

  sentToday(now = this.clock()): number {
    const day = now.toISOString().slice(0, 10);
    return this.readState().sent.filter((item) => new Date(item.atMs).toISOString().slice(0, 10) === day).length;
  }

  now(): Date {
    return this.clock();
  }

  harvestAllowed(sessionKey: string, now = this.clock(), perSession = 10, global = 50): boolean {
    const state = this.readState();
    const globalCount = state.harvest.globalMs.filter((at) => now.getTime() - at < HOUR_MS).length;
    const sessionCount = (state.harvest.sessionsMs[sessionKey] ?? []).filter((at) => now.getTime() - at < HOUR_MS).length;
    return globalCount < global && sessionCount < perSession;
  }

  consumeTagging(now = this.clock(), maxPerHour = 20): boolean {
    const state = this.readState();
    state.tagging.callsMs = state.tagging.callsMs.filter((at) => now.getTime() - at < HOUR_MS);
    if (state.tagging.callsMs.length >= maxPerHour) return false;
    state.tagging.callsMs.push(now.getTime());
    this.writeState(state);
    return true;
  }

  consumeHarvest(sessionKey: string, now = this.clock(), perSession = 10, global = 50): boolean {
    const state = this.readState();
    state.harvest.globalMs = state.harvest.globalMs.filter((at) => now.getTime() - at < HOUR_MS);
    const session = (state.harvest.sessionsMs[sessionKey] ?? []).filter((at) => now.getTime() - at < HOUR_MS);
    if (state.harvest.globalMs.length >= global || session.length >= perSession) return false;
    state.harvest.globalMs.push(now.getTime());
    session.push(now.getTime());
    state.harvest.sessionsMs[sessionKey] = session;
    this.writeState(state);
    return true;
  }

  readState(): StickerState {
    try {
      const parsed = JSON.parse(readFileSync(join(this.root, 'state.json'), 'utf8')) as Partial<StickerState>;
      return {
        schema: 1,
        tagging: { callsMs: numericArray(parsed.tagging?.callsMs) },
        harvest: {
          globalMs: numericArray(parsed.harvest?.globalMs),
          sessionsMs: Object.fromEntries(Object.entries(parsed.harvest?.sessionsMs ?? {}).map(([key, value]) => [key, numericArray(value)])),
        },
        sent: Array.isArray(parsed.sent)
          ? parsed.sent.filter((item): item is { stickerId: string; atMs: number } =>
            typeof item === 'object' && item !== null && typeof item.stickerId === 'string' && Number.isFinite(item.atMs))
          : [],
        recent: Array.isArray(parsed.recent) ? parsed.recent.filter((item): item is string => typeof item === 'string').slice(0, 10) : [],
        lastStickerTurn: typeof parsed.lastStickerTurn === 'number' && Number.isSafeInteger(parsed.lastStickerTurn) ? parsed.lastStickerTurn : null,
      };
    } catch {
      return emptyStickerState();
    }
  }

  writeState(state: StickerState): void {
    writeJsonAtomic(join(this.root, 'state.json'), state);
  }

  private mimeOfEntry(entry: StickerEntry): StickerMime {
    const ext = entry.file.split('.').pop()?.toLowerCase();
    if (ext === 'png') return 'image/png';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
    return 'image/jpeg';
  }

  private moveEntryFile(packId: string, from: string, to: string): void {
    if (from === to) return;
    const source = this.entryPath(packId, from);
    const target = this.entryPath(packId, to);
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(source) && statSync(source).isFile()) renameSync(source, target);
    else if (!existsSync(target)) throw new Error(`贴纸原图缺失：${from}`);
  }
}
