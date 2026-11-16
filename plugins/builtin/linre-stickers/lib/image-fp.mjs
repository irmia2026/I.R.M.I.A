import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export const MIN_IMAGE_BYTES = 129;
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const MIN_DIMENSION = 32;
export const MIN_ASPECT = 0.3;
export const MAX_ASPECT = 3.2;

function parsePngHeader(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  let animated = false;
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'acTL') {
      animated = true;
      break;
    }
    if (type === 'IEND') break;
    const next = offset + 12 + len;
    if (next <= offset || next > buf.length) break;
    offset = next;
  }
  return { format: 'png', mimeType: 'image/png', ext: '.png', width, height, animated };
}

function parseGifHeader(buf) {
  if (buf.length < 10) return null;
  const sig = buf.subarray(0, 6).toString('ascii');
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const animated = buf.includes(Buffer.from('NETSCAPE2.0', 'ascii'));
  return { format: 'gif', mimeType: 'image/gif', ext: '.gif', width, height, animated };
}

function parseWebpHeader(buf) {
  if (buf.length < 30) return null;
  if (buf.subarray(0, 4).toString('ascii') !== 'RIFF') return null;
  if (buf.subarray(8, 12).toString('ascii') !== 'WEBP') return null;
  const chunk = buf.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8 ' && buf.length >= 30) {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return { format: 'webp', mimeType: 'image/webp', ext: '.webp', width, height, animated: false };
  }
  if (chunk === 'VP8L' && buf.length >= 25) {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { format: 'webp', mimeType: 'image/webp', ext: '.webp', width, height, animated: false };
  }
  if (chunk === 'VP8X' && buf.length >= 30) {
    const flags = buf[20];
    const animated = (flags & 0x02) !== 0;
    const width = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
    const height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
    return { format: 'webp', mimeType: 'image/webp', ext: '.webp', width, height, animated };
  }
  return null;
}

function parseJpegHeader(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  let pos = 2;
  while (pos + 4 <= buf.length) {
    while (pos < buf.length && buf[pos] !== 0xff) pos += 1;
    while (pos < buf.length && buf[pos] === 0xff) pos += 1;
    if (pos >= buf.length) break;
    const marker = buf[pos];
    pos += 1;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (marker === 0xda) break;
    if (pos + 2 > buf.length) break;
    const segLen = buf.readUInt16BE(pos);
    if (segLen < 2 || pos + segLen > buf.length) break;
    const isSof = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isSof && segLen >= 7) {
      const height = buf.readUInt16BE(pos + 3);
      const width = buf.readUInt16BE(pos + 5);
      return { format: 'jpeg', mimeType: 'image/jpeg', ext: '.jpg', width, height, animated: false };
    }
    pos += segLen;
  }
  return null;
}

export function parseImageHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < MIN_IMAGE_BYTES || buf.length > MAX_IMAGE_BYTES) {
    return null;
  }
  const info = parsePngHeader(buf)
    ?? parseJpegHeader(buf)
    ?? parseGifHeader(buf)
    ?? parseWebpHeader(buf);
  if (!info) return null;
  if (!Number.isFinite(info.width) || !Number.isFinite(info.height)) return null;
  if (info.width < MIN_DIMENSION || info.height < MIN_DIMENSION) return null;
  const aspect = info.width / info.height;
  if (aspect > MAX_ASPECT || aspect < MIN_ASPECT) return null;
  return { ...info, sizeBytes: buf.length };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function pngDHash(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  const idatChunks = [];

  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataEnd = offset + 8 + len;
    if (dataEnd + 4 > buf.length) break;
    const data = buf.subarray(offset + 8, dataEnd);
    if (type === 'IHDR' && data.length >= 13) {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  if (width <= 0 || height <= 0 || bitDepth !== 8 || interlace !== 0 || idatChunks.length === 0) {
    return null;
  }
  const channelsMap = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bpp = channelsMap[colorType];
  if (!bpp) return null;
  if (width * height > 16_000_000) return null;

  let raw;
  try {
    raw = inflateSync(Buffer.concat(idatChunks));
  } catch {
    return null;
  }
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return null;

  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const outStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const val = raw[rowStart + 1 + x];
      const a = x >= bpp ? pixels[outStart + x - bpp] : 0;
      const b = y > 0 ? pixels[prevStart + x] : 0;
      const c = (x >= bpp && y > 0) ? pixels[prevStart + x - bpp] : 0;
      let recon = val;
      if (filter === 1) recon = (val + a) & 0xff;
      else if (filter === 2) recon = (val + b) & 0xff;
      else if (filter === 3) recon = (val + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) recon = (val + paeth(a, b, c)) & 0xff;
      pixels[outStart + x] = recon;
    }
  }

  const grid = [];
  for (let gy = 0; gy < 8; gy += 1) {
    const y0 = Math.floor((gy * height) / 8);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / 8));
    const row = [];
    for (let gx = 0; gx < 9; gx += 1) {
      const x0 = Math.floor((gx * width) / 9);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / 9));
      let sum = 0;
      let count = 0;
      const stepY = Math.max(1, Math.floor((y1 - y0) / 4));
      const stepX = Math.max(1, Math.floor((x1 - x0) / 4));
      for (let py = y0; py < y1; py += stepY) {
        for (let px = x0; px < x1; px += stepX) {
          const idx = py * stride + px * bpp;
          let lum = 0;
          if (colorType === 0 || colorType === 4) {
            lum = pixels[idx];
          } else if (colorType === 3 && palette) {
            const pIdx = pixels[idx] * 3;
            if (pIdx + 2 < palette.length) {
              lum = 0.299 * palette[pIdx] + 0.587 * palette[pIdx + 1] + 0.114 * palette[pIdx + 2];
            }
          } else {
            lum = 0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2];
          }
          sum += lum;
          count += 1;
        }
      }
      row.push(count > 0 ? sum / count : 0);
    }
    grid.push(row);
  }
  return dHashFromGrid(grid);
}

function dHashFromGrid(grid) {
  let bits = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      bits <<= 1n;
      if (grid[y][x] > grid[y][x + 1]) bits |= 1n;
    }
  }
  return bits.toString(16).padStart(16, '0');
}

function byteStreamDHash(buf) {
  const start = Math.min(buf.length, 32);
  const slice = buf.subarray(start);
  if (slice.length < 72) return createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const grid = [];
  const totalBins = 72;
  const binSize = Math.max(1, Math.floor(slice.length / totalBins));
  let idx = 0;
  for (let y = 0; y < 8; y += 1) {
    const row = [];
    for (let x = 0; x < 9; x += 1) {
      const begin = Math.floor((idx * slice.length) / totalBins);
      const end = Math.min(slice.length, begin + Math.min(binSize, 256));
      let acc = 0;
      const step = Math.max(1, Math.floor((end - begin) / 32));
      let cnt = 0;
      for (let i = begin; i < end; i += step) {
        acc += slice[i];
        cnt += 1;
      }
      row.push(cnt > 0 ? acc / cnt : 0);
      idx += 1;
    }
    grid.push(row);
  }
  return dHashFromGrid(grid);
}

export function computeFingerprint(buf) {
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const fp64 = pngDHash(buf) ?? byteStreamDHash(buf);
  return { sha256, fp64 };
}

export function inspectImageBuffer(buf) {
  const header = parseImageHeader(buf);
  if (!header) return null;
  const fp = computeFingerprint(buf);
  return { ...header, ...fp };
}

export function hamming64(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return 64;
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return 64;
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let dist = 0;
  while (x > 0n) {
    dist += Number(x & 1n);
    x >>= 1n;
  }
  return dist;
}

function isFlatFp(fp64) {
  return typeof fp64 !== 'string' || /^0{16}$/i.test(fp64);
}

export function isDuplicateOrBlocked(fp, items, blocked, threshold = 6) {
  if (!fp || typeof fp.sha256 !== 'string') return { matched: false, kind: null, entry: null };
  const flat = isFlatFp(fp.fp64);
  if (Array.isArray(blocked)) {
    for (const b of blocked) {
      if (!b || typeof b !== 'object') continue;
      if (b.sha256 === fp.sha256) return { matched: true, kind: 'blocked', entry: b };
      if (!flat && !isFlatFp(b.fp64) && hamming64(fp.fp64, b.fp64) <= threshold) {
        return { matched: true, kind: 'blocked', entry: b };
      }
    }
  }
  if (Array.isArray(items)) {
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      if (item.sha256 === fp.sha256) return { matched: true, kind: 'duplicate', entry: item };
      if (!flat && !isFlatFp(item.fp64) && hamming64(fp.fp64, item.fp64) <= threshold) {
        return { matched: true, kind: 'duplicate', entry: item };
      }
    }
  }
  return { matched: false, kind: null, entry: null };
}
