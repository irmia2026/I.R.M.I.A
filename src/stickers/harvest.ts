import { createHash } from 'node:crypto';

import { parseImageDataUrl } from '../log/types.ts';
import { normalizeStickerMime, sniffStickerMime, stickerDimensions } from './media.ts';
import type { StickerStore } from './store.ts';
import type { StickerTagger } from './tagger.ts';
import type { StickerEntry, StickerMime } from './types.js';

export const STICKER_HARVEST_MAX_BYTES = 1_500_000;
export const STICKER_HARVEST_MAX_EDGE = 1024;

export interface HarvestMessage {
  channel: string;
  chatType: 'c2c' | 'group-at' | 'group' | 'guild' | 'dm';
  chatId: string;
  person: string;
  attachments?: Array<{ type: string; url?: string; name?: string }>;
}

export interface HarvestOutcome {
  result: 'auto-approved' | 'pending' | 'rejected' | 'skipped';
  reason: string;
  sha256: string;
  entry?: StickerEntry;
}

export interface StickerHarvesterDeps {
  store: StickerStore;
  tagger: StickerTagger;
  probability?: number | (() => number);
  maxGlobalPerHour?: number | (() => number);
  random?: () => number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  emit?: (type: string, data: unknown) => void;
}

export class StickerHarvester {
  private readonly deps: StickerHarvesterDeps;

  constructor(deps: StickerHarvesterDeps) {
    this.deps = deps;
  }

  private probability(): number {
    return typeof this.deps.probability === 'function' ? this.deps.probability() : this.deps.probability ?? 0.15;
  }

  private maxGlobalPerHour(): number {
    return typeof this.deps.maxGlobalPerHour === 'function' ? this.deps.maxGlobalPerHour() : this.deps.maxGlobalPerHour ?? 50;
  }

  async harvest(message: HarvestMessage, options: { self?: boolean; owner?: boolean } = {}): Promise<HarvestOutcome> {
    const probability = this.probability();
    if (probability <= 0) return { result: 'skipped', reason: 'disabled', sha256: '' };
    if (options.self === true) return this.reject(message, 'self-message', '');
    if (message.chatType === 'c2c' && options.owner !== true) return this.reject(message, 'private-non-owner', '');
    const attachments = message.attachments ?? [];
    for (const attachment of attachments) {
      const declared = attachment.type === 'image' ? null : normalizeStickerMime(attachment.type);
      if (attachment.type !== 'image' && declared === null) continue;
      const loaded = await this.load(attachment.url ?? '');
      if (loaded === null) continue;
      if (loaded.bytes.byteLength === 0 || loaded.bytes.byteLength > STICKER_HARVEST_MAX_BYTES) {
        return this.reject(message, 'too-large', loaded.sha256);
      }
      const mime = sniffStickerMime(loaded.bytes);
      if (mime === null) return this.reject(message, 'unsupported-type', loaded.sha256);
      const dimensions = stickerDimensions(loaded.bytes, mime);
      if (dimensions !== null && (dimensions.width > STICKER_HARVEST_MAX_EDGE || dimensions.height > STICKER_HARVEST_MAX_EDGE)) {
        return this.reject(message, 'dimensions', loaded.sha256);
      }
      if (this.deps.store.findBySha256(loaded.sha256) !== null) return this.reject(message, 'duplicate', loaded.sha256);
      const sessionKey = `${message.channel}:${message.chatType}:${message.chatId}`;
      if (!this.deps.store.harvestAllowed(sessionKey, this.now(), 10, this.maxGlobalPerHour())) {
        return this.reject(message, 'rate-limited', loaded.sha256);
      }
      const dice = this.deps.random?.() ?? Math.random();
      if (dice >= probability) return { result: 'skipped', reason: 'dice', sha256: loaded.sha256 };
      if (!this.deps.store.consumeHarvest(sessionKey, this.now(), 10, this.maxGlobalPerHour())) {
        return this.reject(message, 'rate-limited', loaded.sha256);
      }
      const imported = this.deps.store.importSticker({ bytes: loaded.bytes, mime, source: 'collected' });
      if (imported.duplicate) return this.reject(message, 'duplicate', loaded.sha256);
      const tagged = await this.deps.tagger.tag({ stickerId: imported.entry.id, bytes: loaded.bytes, mime });
      const result = tagged.approved ? 'auto-approved' : 'pending';
      this.deps.emit?.('sticker/harvested', {
        chatType: message.chatType,
        sha256: loaded.sha256,
        result,
        ...(tagged.approved ? {} : { reason: tagged.reason }),
      });
      return { result, reason: tagged.reason, sha256: loaded.sha256, entry: tagged.entry };
    }
    return { result: 'skipped', reason: 'no-candidate', sha256: '' };
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private reject(message: HarvestMessage, reason: string, sha256: string): HarvestOutcome {
    this.deps.emit?.('sticker/harvested', { chatType: message.chatType, sha256, result: 'rejected', reason });
    return { result: 'rejected', reason, sha256 };
  }

  private async load(url: string): Promise<{ bytes: Buffer; sha256: string } | null> {
    try {
      let bytes: Buffer;
      if (url.trim().startsWith('data:')) {
        const parsed = parseImageDataUrl(url);
        if (parsed === null) return null;
        bytes = parsed.bytes;
      } else if (/^https?:\/\//iu.test(url.trim())) {
        const response = await (this.deps.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(5_000) });
        if (!response.ok) return null;
        const declared = Number(response.headers.get('content-length') ?? '');
        if (Number.isFinite(declared) && declared > STICKER_HARVEST_MAX_BYTES) return null;
        bytes = Buffer.from(await response.arrayBuffer());
      } else return null;
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    } catch {
      return null;
    }
  }
}
