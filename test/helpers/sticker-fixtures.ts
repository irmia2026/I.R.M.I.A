import type { DsResponse } from '../../src/model/ds-client.js';

export function pngBytes(width = 1, height = 1): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

export function jpegBytes(width = 1, height = 1): Buffer {
  const bytes = Buffer.alloc(21);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  bytes[11] = 1;
  bytes[12] = 0;
  bytes[13] = 0x11;
  bytes[14] = 0;
  return bytes;
}

export function gifBytes(width = 1, height = 1): Buffer {
  const bytes = Buffer.alloc(12);
  bytes.write('GIF89a', 0, 'ascii');
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

export function webpBytes(width = 1, height = 1): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8X', 12, 'ascii');
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

export function stickerModelResponse(text: string): DsResponse {
  return {
    status: 'completed',
    outputItems: [{ type: 'message', text }],
    usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 10, reasoningTokens: 0 },
    model: 'vision-test',
    durationMs: 5,
  } as unknown as DsResponse;
}
