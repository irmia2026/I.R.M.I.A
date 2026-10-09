export const DEFAULT_MAX_SEGMENTS = 5;
export const DEFAULT_MIN_SEGMENT_LENGTH = 10;

const PAIRS: Readonly<Record<string, string>> = {
  '(': ')', '（': '）', '[': ']', '【': '】', '{': '}', '《': '》', '〈': '〉', '〔': '〕',
  '「': '」', '『': '』', '“': '”', '‘': '’', '"': '"', "'": "'", '<': '>',
};
const PRIMARY = /[。？！!?；;.]/u;
const SECONDARY = /[，,、]/u;

export interface SplitOptions {
  /** 0 表示不限制段数。 */
  maxSegments?: number;
  minSegmentLength?: number;
}

export function charCount(text: string): number {
  return [...text].length;
}

function visibleLength(text: string): number {
  return charCount(text.replace(/\s/gu, ''));
}

function lineAt(text: string, start: number): { text: string; end: number } {
  const newline = text.indexOf('\n', start);
  const end = newline < 0 ? text.length : newline + 1;
  return { text: text.slice(start, end).trim(), end };
}

function tableEnd(text: string, start: number): number | null {
  if (start > 0 && text[start - 1] !== '\n') return null;
  const header = lineAt(text, start);
  if (!header.text.includes('|') || header.end === text.length) return null;
  const separator = lineAt(text, header.end);
  const cells = separator.text.replace(/^\||\|$/gu, '').split('|');
  if (!cells.every((cell) => /^\s*:?-{3,}:?\s*$/u.test(cell))) return null;
  let end = separator.end;
  while (end < text.length) {
    const row = lineAt(text, end);
    if (!row.text.includes('|')) break;
    end = row.end;
  }
  return end;
}

function protectedEnd(text: string, start: number): number | null {
  if (text.startsWith('<think>', start)) {
    const close = text.indexOf('</think>', start + 7);
    return close < 0 ? text.length : close + 8;
  }
  const fence = /^(?:`{3,}|~{3,})/u.exec(text.slice(start))?.[0];
  const atLineStart = start === 0 || text.slice(text.lastIndexOf('\n', start - 1) + 1, start).trim() === '';
  if (fence !== undefined && atLineStart) {
    const firstLine = text.indexOf('\n', start);
    if (firstLine < 0) return text.length;
    const closing = new RegExp(`^[ \\t]{0,3}${fence}[ \\t]*\\r?$`, 'gm');
    closing.lastIndex = firstLine + 1;
    const match = closing.exec(text);
    return match === null ? text.length : match.index + match[0].length;
  }
  if (text[start] === '`') {
    const marker = /^`+/u.exec(text.slice(start))![0];
    const close = text.indexOf(marker, start + marker.length);
    return close < 0 ? text.length : close + marker.length;
  }
  return tableEnd(text, start);
}

function punctuationAt(text: string, start: number): string | null {
  const char = text[start]!;
  if (char === '\r' && text[start + 1] === '\n') return '\r\n';
  if (char === '\n') return char;
  if (!PRIMARY.test(char)) return null;
  // 英文标识符、版本号和 URL 内的标点不是句末。
  if (/[.!?;]/u.test(char)
    && /[\w/:=+-]/u.test(text[start - 1] ?? '')
    && /[\w/:=+-]/u.test(text[start + 1] ?? '')) return null;
  let end = start + 1;
  while (end < text.length && PRIMARY.test(text[end]!)) end += 1;
  return text.slice(start, end);
}

export function splitForChat(text: string, options: SplitOptions = {}): string[] {
  if (text.trim() === '') return [];
  const maxSegments = options.maxSegments ?? DEFAULT_MAX_SEGMENTS;
  const minLength = options.minSegmentLength ?? DEFAULT_MIN_SEGMENT_LENGTH;
  const target = maxSegments > 0 ? Math.max(Math.ceil(visibleLength(text) / maxSegments), minLength) : 0;
  const segments: string[] = [];
  const stack: string[] = [];
  let chunk = '';
  let length = 0;
  let cursor = 0;

  const flush = (): void => {
    if (chunk === '') return;
    segments.push(chunk);
    chunk = '';
    length = 0;
  };

  while (cursor < text.length) {
    const protectedTo = protectedEnd(text, cursor);
    if (protectedTo !== null) {
      const block = text.slice(cursor, protectedTo);
      chunk += block;
      length += visibleLength(block);
      cursor = protectedTo;
      continue;
    }
    const delimiter = punctuationAt(text, cursor);
    if (delimiter !== null && stack.length === 0) {
      chunk += delimiter;
      cursor += delimiter.length;
      if (target === 0 || length >= target * 0.4) flush();
      else length += visibleLength(delimiter);
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(cursor)!);
    const numericComma = char === ',' && /\d/u.test(text[cursor - 1] ?? '') && /\d/u.test(text[cursor + 1] ?? '');
    if (SECONDARY.test(char) && !numericComma && stack.length === 0 && (target === 0 || length >= target * 0.9)) {
      chunk += char;
      cursor += char.length;
      flush();
      continue;
    }
    const apostrophe = char === "'" && /\w/u.test(text[cursor - 1] ?? '') && /\w/u.test(text[cursor + 1] ?? '');
    if (!apostrophe) {
      if (stack.at(-1) === char) stack.pop();
      else if (PAIRS[char] !== undefined) stack.push(PAIRS[char]!);
    }
    chunk += char;
    if (!/\s/u.test(char)) length += 1;
    cursor += char.length;
  }
  flush();

  if (maxSegments > 0 && segments.length > maxSegments) {
    segments.splice(maxSegments - 1, segments.length, segments.slice(maxSegments - 1).join(''));
  }
  if (segments.length > 1 && visibleLength(segments.at(-1)!) < minLength) {
    const last = segments.pop()!;
    segments[segments.length - 1] += last;
  }
  return segments;
}
