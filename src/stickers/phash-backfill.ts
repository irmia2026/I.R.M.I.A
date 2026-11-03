import { computeStickerPHashBatch } from './phash.ts';
import type { StickerStore } from './store.ts';

export interface PHashBackfillResult {
  total: number;
  filled: number;
  failed: number;
}

/**
 * One batch process for every entry missing phash. Never throws; failures are counted only
 * (paths are never logged).
 */
export async function backfillStickerPHashes(
  store: StickerStore,
  batch: (paths: readonly string[]) => Promise<Array<string | null>> = computeStickerPHashBatch,
): Promise<PHashBackfillResult> {
  let missing: ReturnType<StickerStore['entriesMissingPHash']> = [];
  try {
    missing = store.entriesMissingPHash();
  } catch {
    return {total: 0, filled: 0, failed: 0};
  }
  if (missing.length === 0) return {total: 0, filled: 0, failed: 0};
  let hashes: Array<string | null> = [];
  try {
    hashes = await batch(missing.map((row) => row.path));
  } catch {
    hashes = missing.map(() => null);
  }
  let filled = 0;
  let failed = 0;
  for (const [index, row] of missing.entries()) {
    const hash = hashes[index] ?? null;
    if (hash === null) {
      failed += 1;
      continue;
    }
    try {
      store.setPHash(row.id, hash);
      filled += 1;
    } catch {
      failed += 1;
    }
  }
  return {total: missing.length, filled, failed};
}
