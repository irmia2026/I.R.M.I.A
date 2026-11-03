export const STICKER_TAGS = ['开心', '难过', '担心', '生气', '亲近', '好奇', '无语', '得意', '害羞'] as const;
export type StickerTag = typeof STICKER_TAGS[number];
export type StickerIntensity = 'mild' | 'obvious' | 'strong';
export type StickerStatus = 'pending' | 'approved' | 'rejected' | 'blocked';
export type StickerSource = 'owner' | 'collected' | 'plugin';
export type StickerTagSource = 'human' | 'auto' | 'imported';
export type StickerMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface StickerEntry {
  id: string;
  file: string;
  tags: StickerTag[];
  intensity: StickerIntensity;
  status: StickerStatus;
  sha256: string;
  addedAt: string;
  rejectedAt?: string;
  tagSource: StickerTagSource;
  tagConfidence: number;
  note: string;
  stats: { sent: number; lastSentAt: string | null };
}

export interface StickerPack {
  schema: 1;
  packId: string;
  title: string;
  source: StickerSource;
  stickers: StickerEntry[];
}

export interface StickerState {
  schema: 1;
  tagging: { callsMs: number[] };
  harvest: { globalMs: number[]; sessionsMs: Record<string, number[]> };
  sent: Array<{ stickerId: string; atMs: number }>;
  recent: string[];
  lastStickerTurn: number | null;
}

export interface StickerTaggingResult {
  tags: StickerTag[];
  intensity: StickerIntensity;
  confidence: number;
  note: string;
  /** Whether the image itself is a sticker/meme, not a photo/screenshot/long image. */
  isSticker: boolean;
}

export function isStickerTag(value: unknown): value is StickerTag {
  return typeof value === 'string' && (STICKER_TAGS as readonly string[]).includes(value);
}

export function isStickerIntensity(value: unknown): value is StickerIntensity {
  return value === 'mild' || value === 'obvious' || value === 'strong';
}

export function emptyStickerState(): StickerState {
  return { schema: 1, tagging: { callsMs: [] }, harvest: { globalMs: [], sessionsMs: {} }, sent: [], recent: [], lastStickerTurn: null };
}
