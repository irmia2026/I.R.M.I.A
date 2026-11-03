import type { StickerMime } from './types.js';

const EXT: Record<StickerMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export function normalizeStickerMime(value: string): StickerMime | null {
  const mime = value.trim().toLowerCase();
  if (mime === 'image/png') return 'image/png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'image/jpeg';
  if (mime === 'image/gif') return 'image/gif';
  if (mime === 'image/webp') return 'image/webp';
  return null;
}

export function stickerExtension(mime: StickerMime): string {
  return EXT[mime];
}

export function sniffStickerMime(bytes: Buffer): StickerMime | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const head = bytes.subarray(0, 12).toString('ascii');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.endsWith('WEBP')) return 'image/webp';
  return null;
}

export function stickerDimensions(bytes: Buffer, mime: StickerMime): { width: number; height: number } | null {
  try {
    if (mime === 'image/png' && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    if (mime === 'image/gif' && bytes.length >= 10) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    if (mime === 'image/webp') return webpDimensions(bytes);
    if (mime === 'image/jpeg') return jpegDimensions(bytes);
  } catch {
    return null;
  }
  return null;
}

function webpDimensions(bytes: Buffer): { width: number; height: number } | null {
  const kind = bytes.subarray(12, 16).toString('ascii');
  if (kind === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X' && bytes.length >= 30) {
    const read24 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
    return { width: read24(24) + 1, height: read24(27) + 1 };
  }
  return null;
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    while (at < bytes.length && bytes[at] === 0xff) at += 1;
    const marker = bytes[at];
    at += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(at);
    if (length < 2 || at + length > bytes.length) break;
    const sof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (sof && length >= 7) return { height: bytes.readUInt16BE(at + 3), width: bytes.readUInt16BE(at + 5) };
    at += length;
  }
  return null;
}
