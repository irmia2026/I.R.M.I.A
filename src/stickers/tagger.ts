import type { DsResponse } from '../model/ds-client.js';
import { extractResponseText, type VisionGenerateRequest, type VisionModelClient } from '../tools/vision.ts';
import type { StickerStore } from './store.ts';
import {
  STICKER_TAGS, isStickerIntensity, isStickerTag,
  type StickerEntry, type StickerMime, type StickerTaggingResult,
} from './types.ts';

export const STICKER_TAGGING_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['tags', 'intensity', 'confidence', 'note', 'isSticker'],
  properties: {
    tags: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: STICKER_TAGS } },
    intensity: { enum: ['mild', 'obvious', 'strong'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    note: { type: 'string', maxLength: 200 },
    isSticker: { type: 'boolean' },
  },
};

export interface StickerTaggingOutcome {
  entry: StickerEntry;
  approved: boolean;
  isSticker: boolean;
  reason: 'pending' | 'not-sticker' | 'tagging-disabled' | 'rate-limited' | 'invalid-json' | 'low-confidence' | 'model-failed';
}

export interface StickerTaggerDeps {
  client: VisionModelClient;
  store: StickerStore;
  model: string;
  enabled?: boolean | (() => boolean);
  maxPerHour?: number | (() => number);
  concurrency?: number | (() => number);
  requestTimeoutMs?: number;
  onUsage?: (response: DsResponse | null) => void;
  emit?: (type: string, data: unknown) => void;
}

export function parseStickerTagging(raw: string): StickerTaggingResult | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'confidence,intensity,isSticker,note,tags') return null;
  if (!Array.isArray(record['tags']) || record['tags'].length < 1 || record['tags'].length > 2) return null;
  if (new Set(record['tags']).size !== record['tags'].length || !record['tags'].every(isStickerTag)) return null;
  if (!isStickerIntensity(record['intensity'])) return null;
  if (typeof record['confidence'] !== 'number' || !Number.isFinite(record['confidence']) || record['confidence'] < 0 || record['confidence'] > 1) return null;
  if (typeof record['note'] !== 'string' || [...record['note']].length > 200) return null;
  if (typeof record['isSticker'] !== 'boolean') return null;
  return {
    tags: [...record['tags']],
    intensity: record['intensity'],
    confidence: record['confidence'],
    note: record['note'],
    isSticker: record['isSticker'],
  };
}

export class StickerTagger {
  private readonly deps: StickerTaggerDeps;
  private active = 0;
  private readonly queue: Array<() => Promise<void>> = [];

  constructor(deps: StickerTaggerDeps) {
    this.deps = deps;
  }

  private enabled(): boolean {
    return typeof this.deps.enabled === 'function' ? this.deps.enabled() : this.deps.enabled !== false;
  }

  private maxPerHour(): number {
    const value = typeof this.deps.maxPerHour === 'function' ? this.deps.maxPerHour() : this.deps.maxPerHour ?? 20;
    return Math.max(1, Math.trunc(value));
  }

  private concurrency(): number {
    const value = typeof this.deps.concurrency === 'function' ? this.deps.concurrency() : this.deps.concurrency ?? 1;
    return Math.max(1, Math.trunc(value));
  }

  tag(input: { stickerId: string; bytes: Buffer; mime: StickerMime; autoApprove?: boolean }): Promise<StickerTaggingOutcome> {
    return new Promise((resolve) => {
      this.queue.push(async () => {
        try {
          resolve(await this.tagNow(input));
        } catch {
          resolve({ entry: this.deps.store.findById(input.stickerId)!.entry, approved: false, isSticker: false, reason: 'model-failed' });
        }
      });
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.concurrency() && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.active += 1;
      void task().finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async tagNow(input: { stickerId: string; bytes: Buffer; mime: StickerMime; autoApprove?: boolean }): Promise<StickerTaggingOutcome> {
    const model = this.deps.model;
    if (!this.enabled()) {
      const entry = this.deps.store.findById(input.stickerId)!.entry;
      this.deps.emit?.('sticker/tagged', { stickerId: input.stickerId, tags: [], intensity: entry.intensity, confidence: 0, model, ok: false });
      return { entry, approved: false, isSticker: false, reason: 'tagging-disabled' };
    }
    if (!this.deps.store.consumeTagging(this.deps.store.now(), this.maxPerHour())) {
      const entry = this.deps.store.findById(input.stickerId)!.entry;
      this.deps.emit?.('sticker/tagged', { stickerId: input.stickerId, tags: [], intensity: entry.intensity, confidence: 0, model, ok: false });
      return { entry, approved: false, isSticker: false, reason: 'rate-limited' };
    }

    const request: VisionGenerateRequest = {
      lane: 'light',
      model,
      input: [{
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '先判断这张图本身是不是表情包/贴纸/梗图：true = 主体单一大、用来表达情绪；'
              + 'false = 照片、截图、长图、文字图、普通网页图、聊天记录截图等。'
              + '不是表情包也要给最接近的标签，但 isSticker 必须是 false。'
              + '再从给定九种情绪标签中选最贴切的 1–2 个，并判断表达强度。'
              + '严格只输出指定 JSON，不要解释，不要代码围栏。九标签：开心、难过、担心、生气、亲近、好奇、无语、得意、害羞。'
              + 'intensity 只能是 mild/obvious/strong；confidence 是 0..1；note 用不超过 200 字说明画面；isSticker 必填。',
          },
          { type: 'input_image', image_url: `data:${input.mime};base64,${input.bytes.toString('base64')}` },
        ],
      }],
      text: { type: 'json_schema', name: 'sticker_tagging', schema: STICKER_TAGGING_SCHEMA },
      reasoning: { effort: 'low' },
      signal: AbortSignal.timeout(this.deps.requestTimeoutMs ?? 30_000),
    };

    let response: DsResponse;
    try {
      response = await this.deps.client.generate(request);
      this.deps.onUsage?.(response);
    } catch {
      this.deps.onUsage?.(null);
      const entry = this.deps.store.findById(input.stickerId)!.entry;
      this.deps.emit?.('sticker/tagged', { stickerId: input.stickerId, tags: [], intensity: entry.intensity, confidence: 0, model, ok: false });
      return { entry, approved: false, isSticker: false, reason: 'model-failed' };
    }

    const result = parseStickerTagging(extractResponseText(response));
    if (result === null) {
      const entry = this.deps.store.findById(input.stickerId)!.entry;
      this.deps.emit?.('sticker/tagged', { stickerId: input.stickerId, tags: [], intensity: entry.intensity, confidence: 0, model: response.model || model, ok: false });
      return { entry, approved: false, isSticker: false, reason: 'invalid-json' };
    }
    // 任何新入库都必须人工审核：autoApprove 参数只为兼容保留，永远不产生 approved。
    const approved = false;
    const entry = this.deps.store.applyTagging(input.stickerId, result, false);
    this.deps.emit?.('sticker/tagged', {
      stickerId: input.stickerId,
      tags: result.tags,
      intensity: result.intensity,
      confidence: result.confidence,
      model: response.model || model,
      ok: approved,
      isSticker: result.isSticker,
    });
    return { entry, approved, isSticker: result.isSticker, reason: result.isSticker ? (result.confidence < 0.7 ? 'low-confidence' : 'pending') : 'not-sticker' };
  }
}
