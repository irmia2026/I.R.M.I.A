import type { AppConfig } from '../config/config.ts';
import { normalizeStickerMime, sniffStickerMime, stickerDimensions } from './media.ts';
import type { StickerStore } from './store.ts';
import type { StickerTagger, StickerTaggingOutcome } from './tagger.ts';
import {
  STICKER_TAGS, isStickerIntensity, isStickerTag,
  type StickerEntry, type StickerMime, type StickerPack, type StickerSource, type StickerTag,
} from './types.ts';

export const STICKER_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const STICKER_UPLOAD_BODY_MAX_BYTES = 12 * 1024 * 1024;
export const STICKER_PAGE_SIZE = 48;

export class StickerServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'StickerServiceError';
    this.status = status;
    this.code = code;
  }
}

export interface StickerServiceDeps {
  store: StickerStore;
  tagger: StickerTagger;
  config: () => AppConfig;
  emit: (type: string, data: unknown) => void;
}

export interface StickerView extends StickerEntry {
  packId: string;
  packTitle: string;
  source: StickerSource;
  imageUrl: string;
}

export interface StickerListQuery {
  status?: string | null;
  tag?: string | null;
  source?: string | null;
  page?: string | null;
}

function viewOf(pack: StickerPack, entry: StickerEntry): StickerView {
  return {
    ...entry,
    tags: [...entry.tags],
    stats: { ...entry.stats },
    packId: pack.packId,
    packTitle: pack.title,
    source: pack.source,
    imageUrl: `/api/stickers/${encodeURIComponent(entry.id)}/image`,
  };
}

function requiredEntry(store: StickerStore, id: string): { pack: StickerPack; entry: StickerEntry } {
  if (!/^[a-z0-9-]+$/u.test(id)) throw new StickerServiceError(400, 'invalid-sticker-id', '贴纸 id 不合法');
  const found = store.findById(id);
  if (found === null) throw new StickerServiceError(404, 'sticker-not-found', `找不到贴纸：${id}`);
  return found;
}

function tagPatch(value: unknown): StickerTag[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 || !value.every(isStickerTag) || new Set(value).size !== value.length) {
    throw new StickerServiceError(400, 'invalid-sticker-tags', 'tags 要是九标签中的 1–2 个，且不能重复');
  }
  return [...value];
}

export class StickerService {
  private readonly deps: StickerServiceDeps;
  private queue: Promise<void> = Promise.resolve();

  constructor(deps: StickerServiceDeps) {
    this.deps = deps;
  }

  private mutate<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  list(query: StickerListQuery = {}) {
    const status = query.status?.trim() ?? '';
    const tag = query.tag?.trim() ?? '';
    const source = query.source?.trim() ?? '';
    if (status !== '' && !['pending', 'approved', 'rejected', 'blocked'].includes(status)) {
      throw new StickerServiceError(400, 'invalid-sticker-status', 'status 只接受 pending/approved/rejected/blocked');
    }
    if (tag !== '' && !isStickerTag(tag)) throw new StickerServiceError(400, 'invalid-sticker-tag', '未知贴纸标签');
    if (source !== '' && !['owner', 'collected', 'plugin'].includes(source)) {
      throw new StickerServiceError(400, 'invalid-sticker-source', 'source 只接受 owner/collected/plugin');
    }
    const rawPage = query.page?.trim() ?? '';
    const page = rawPage === '' ? 1 : Number(rawPage);
    if (!Number.isSafeInteger(page) || page < 1) throw new StickerServiceError(400, 'invalid-sticker-page', 'page 要是从 1 开始的整数');
    const rows = this.deps.store.listEntries();
    const filtered = rows.filter(({ pack, entry }) =>
      (status === '' || entry.status === status)
      && (tag === '' || entry.tags.includes(tag as StickerTag))
      && (source === '' || pack.source === source));
    const tags = Object.fromEntries(STICKER_TAGS.map((name) => [name, rows.filter(({ entry }) => entry.status === 'approved' && entry.tags.includes(name)).length]));
    const counts = {
      approved: rows.filter(({ entry }) => entry.status === 'approved').length,
      pending: rows.filter(({ entry }) => entry.status === 'pending').length,
      rejected: rows.filter(({ entry }) => entry.status === 'rejected').length,
      blocked: rows.filter(({ entry }) => entry.status === 'blocked').length,
      sentToday: this.deps.store.sentToday(),
    };
    const config = this.deps.config().stickers;
    return {
      items: filtered.slice((page - 1) * STICKER_PAGE_SIZE, page * STICKER_PAGE_SIZE).map(({ pack, entry }) => viewOf(pack, entry)),
      counts,
      tags,
      page,
      pageSize: STICKER_PAGE_SIZE,
      total: filtered.length,
      totalPages: Math.ceil(filtered.length / STICKER_PAGE_SIZE),
      settings: {
        enabled: config.enabled,
        harvestEnabled: config.harvest.enabled,
        harvestProbability: config.harvest.probability,
        taggingEnabled: config.tagging.enabled,
        groups: config.groups,
        passiveProbability: config.passiveProbability,
        minTurnsBetween: config.minTurnsBetween,
        rejectedRetentionDays: config.rejectedRetentionDays,
      },
    };
  }

  entry(id: string): StickerView {
    const found = requiredEntry(this.deps.store, id);
    return viewOf(found.pack, found.entry);
  }

  image(id: string): { bytes: Buffer; mime: StickerMime } {
    requiredEntry(this.deps.store, id);
    const entry = this.entry(id);
    const ext = entry.file.split('.').pop()?.toLowerCase();
    const mime: StickerMime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return { bytes: this.deps.store.readEntryBytes(id), mime };
  }

  async upload(payload: Record<string, unknown>): Promise<{ entry: StickerView; duplicate: boolean; tagging: StickerTaggingOutcome | null }> {
    const mime = typeof payload['mime'] === 'string' ? normalizeStickerMime(payload['mime']) : null;
    const raw = payload['data'];
    if (mime === null) throw new StickerServiceError(400, 'invalid-sticker-mime', '只接受 png/jpeg/gif/webp 图片');
    if (typeof raw !== 'string' || raw.trim() === '') throw new StickerServiceError(400, 'invalid-sticker-data', '缺少 base64 图片内容');
    const compact = raw.replace(/\s/gu, '');
    const bytes = Buffer.from(compact, 'base64');
    if (bytes.length === 0 || bytes.toString('base64') !== compact) {
      throw new StickerServiceError(400, 'invalid-sticker-data', '图片不是合法的 base64');
    }
    if (bytes.length > STICKER_UPLOAD_MAX_BYTES) throw new StickerServiceError(413, 'payload-too-large', '单张贴纸不能超过 8MB');
    const sniffed = sniffStickerMime(bytes);
    if (sniffed !== mime) throw new StickerServiceError(400, 'invalid-sticker-content', '图片内容与声明型别不一致');
    const dimensions = stickerDimensions(bytes, mime);
    if (dimensions !== null && (dimensions.width > 1024 || dimensions.height > 1024)) {
      throw new StickerServiceError(400, 'sticker-dimensions-too-large', '图片宽高都不能超过 1024 像素');
    }
    return await this.mutate(async () => {
      const imported = this.deps.store.importSticker({ bytes, mime, source: 'owner' });
      if (imported.duplicate) return { entry: this.entry(imported.entry.id), duplicate: true, tagging: null };
      let outcome = await this.deps.tagger.tag({ stickerId: imported.entry.id, bytes, mime, autoApprove: false });
      if (outcome.reason === 'not-sticker') {
        // 上传与采集同一条判据：不是表情包就进 rejected，不留在可发送列表。
        const rejected = this.deps.store.review(imported.entry.id, 'reject');
        outcome = {...outcome, entry: rejected};
      }
      return { entry: this.entry(outcome.entry.id), duplicate: false, tagging: outcome };
    });
  }

  async review(id: string, payload: Record<string, unknown>): Promise<{ entry: StickerView; action: string }> {
    const tags = tagPatch(payload['tags']);
    const intensity = payload['intensity'];
    if (intensity !== undefined && !isStickerIntensity(intensity)) {
      throw new StickerServiceError(400, 'invalid-sticker-intensity', 'intensity 只接受 mild/obvious/strong');
    }
    const status = payload['status'];
    if (status !== undefined && !['approved', 'rejected', 'blocked'].includes(status as string)) {
      throw new StickerServiceError(400, 'invalid-sticker-status', '人工审核只能改为 approved/rejected/blocked');
    }
    if (tags === undefined && intensity === undefined && status === undefined) {
      throw new StickerServiceError(400, 'empty-sticker-patch', '没有要修改的标签、强度或状态');
    }
    return await this.mutate(() => {
      const found = requiredEntry(this.deps.store, id);
      const patch = { ...(tags === undefined ? {} : { tags }), ...(intensity === undefined ? {} : { intensity }) };
      let action = 'edit';
      let entry: StickerEntry;
      if (status === undefined) {
        entry = this.deps.store.update(id, patch);
      } else {
        const nextTags = tags ?? found.entry.tags;
        if (status === 'approved' && nextTags.length === 0) {
          throw new StickerServiceError(400, 'sticker-tags-required', '批准前至少要保留一个标签');
        }
        action = status === 'approved' ? (found.entry.status === 'rejected' ? 'restore' : 'approve') : status === 'rejected' ? 'reject' : 'block';
        entry = this.deps.store.review(id, action as 'approve' | 'reject' | 'restore' | 'block', patch);
      }
      this.deps.emit('sticker/reviewed', { stickerId: id, action, by: 'human', tags: entry.tags, intensity: entry.intensity });
      return { entry: this.entry(id), action };
    });
  }

  async remove(id: string): Promise<StickerView> {
    return await this.mutate(() => {
      requiredEntry(this.deps.store, id);
      const entry = this.deps.store.review(id, 'delete');
      this.deps.emit('sticker/reviewed', { stickerId: id, action: 'delete', by: 'human' });
      return viewOf(this.deps.store.findById(id)!.pack, entry);
    });
  }

  async purge(id?: string): Promise<{ count: number; ids: string[] }> {
    return await this.mutate(() => {
      if (id !== undefined && requiredEntry(this.deps.store, id).entry.status !== 'rejected') {
        throw new StickerServiceError(400, 'sticker-not-rejected', '只能彻底删除已拒绝的贴纸');
      }
      const threshold = id === undefined ? this.deps.store.now().getTime() - this.deps.config().stickers.rejectedRetentionDays * 86_400_000 : undefined;
      const ids = this.deps.store.listEntries()
        .filter(({ entry }) => entry.status === 'rejected' && (id === undefined || entry.id === id)
          && (threshold === undefined || Date.parse(entry.rejectedAt ?? entry.addedAt) <= threshold))
        .map(({ entry }) => entry.id);
      const count = this.deps.store.purgeRejected(threshold, id);
      for (const stickerId of ids) this.deps.emit('sticker/reviewed', { stickerId, action: 'delete', by: 'human', purged: true });
      return { count, ids };
    });
  }
}
