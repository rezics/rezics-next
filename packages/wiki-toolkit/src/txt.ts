// SPDX-License-Identifier: Apache-2.0
import iconv from 'iconv-lite';
import { createHash } from 'node:crypto';
import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { parseLocator, type Locator, type ExternalSource } from '../protocol/locator.ts';
import {
  bounds,
  quoteSelector,
  verified,
  type ParsedText,
  type TextUnit,
  type Verification,
} from './types.ts';

export const TXT_LIMITS = {
  inputBytes: 128 * 1024 * 1024,
  segmentBytes: 256 * 1024,
  chunkBytes: 64 * 1024,
  retainedUnits: 4096,
} as const;
export function checkTxtSize(size: number) {
  if (size > TXT_LIMITS.inputBytes) throw new Error('TXT exceeds the 128 MiB input byte ceiling');
}
interface Reader {
  size: number;
  read(start: number, end: number): Buffer;
}
interface Encoding {
  name: string;
  bom: number;
  decoding: NonNullable<TextUnit['decoding']>;
}
const encodings: Record<string, string> = {
  utf8: 'utf8',
  utf16le: 'utf16le',
  utf16be: 'utf16be',
  shiftjis: 'shift_jis',
  sjis: 'shift_jis',
  windows1252: 'windows1252',
  cp1252: 'windows1252',
  latin1: 'latin1',
  iso88591: 'latin1',
  ascii: 'ascii',
};
const canonical = (name: string) => encodings[name.toLowerCase().replace(/[-_]/g, '')];
function safeLength(bytes: Buffer, encoding: string, eof: boolean) {
  if (eof) return bytes.length;
  let end = bytes.length;
  if (encoding === 'utf8') {
    let lead = end - 1;
    while (lead >= 0 && (bytes[lead]! & 0xc0) === 0x80) lead--;
    const value = bytes[lead] ?? 0;
    const width = value >= 0xf0 ? 4 : value >= 0xe0 ? 3 : value >= 0xc0 ? 2 : 1;
    if (end - lead < width) end = lead;
  } else if (encoding.startsWith('utf16')) {
    end -= end % 2;
    const last = encoding === 'utf16le' ? bytes.readUInt16LE(end - 2) : bytes.readUInt16BE(end - 2);
    if (last >= 0xd800 && last <= 0xdbff) end -= 2;
  } else if (encoding === 'shift_jis') {
    for (let i = 0; i < end; i++) {
      const value = bytes[i]!;
      if ((value >= 0x81 && value <= 0x9f) || (value >= 0xe0 && value <= 0xfc)) {
        if (++i === end) end--;
      }
    }
  }
  return end;
}
function decode(bytes: Buffer, encoding: string) {
  const text = iconv.decode(bytes, encoding, { stripBOM: false });
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text))
    throw new Error('TXT contains an unpaired Unicode surrogate');
  if (!iconv.encode(text, encoding).equals(bytes))
    throw new Error('TXT has invalid or unsupported byte sequences or boundaries for its encoding');
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text)) throw new Error('Unsupported TXT control bytes');
  return text;
}
function* chunks(reader: Reader, encoding: string, start: number) {
  while (start < reader.size) {
    const bytes = reader.read(start, Math.min(reader.size, start + TXT_LIMITS.chunkBytes));
    const length = safeLength(bytes, encoding, start + bytes.length === reader.size);
    if (length <= 0) throw new Error('Invalid TXT character boundary');
    const text = decode(bytes.subarray(0, length), encoding);
    yield text;
    start += length;
  }
}
function chooseEncoding(reader: Reader, declared?: string): Encoding {
  const head = reader.read(0, Math.min(3, reader.size));
  const bom = head.equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ? (['utf8', 3] as const)
    : head[0] === 0xff && head[1] === 0xfe
      ? (['utf16le', 2] as const)
      : head[0] === 0xfe && head[1] === 0xff
        ? (['utf16be', 2] as const)
        : undefined;
  const requested = declared ? canonical(declared) : undefined;
  if (declared && !requested)
    throw new Error(
      'Unsupported TXT encoding; use UTF-8, UTF-16LE/BE, Shift_JIS, Windows-1252, Latin-1 or ASCII',
    );
  if (requested && bom && requested !== bom[0])
    throw new Error('Declared encoding conflicts with the TXT byte-order mark');
  const scan = (encoding: string) => {
    let content = false,
      japanese = false;
    for (const text of chunks(reader, encoding, bom?.[1] ?? 0)) {
      content ||= !!text.trim();
      japanese ||= /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
    }
    if (!content) throw new Error('Unsupported or empty TXT input');
    return japanese;
  };
  let name = requested ?? bom?.[0];
  if (name) scan(name);
  else {
    try {
      scan('utf8');
      name = 'utf8';
    } catch {
      try {
        if (scan('shift_jis')) name = 'shift_jis';
      } catch {
        /* requires declaration */
      }
      if (!name)
        throw new Error('TXT encoding is uncertain or invalid; declare --encoding explicitly');
    }
  }
  return {
    name,
    bom: bom?.[1] ?? 0,
    decoding: {
      encoding: name,
      basis: declared ? 'declared' : bom ? 'bom' : 'detected',
      uncertain: !declared && !bom,
      alternatives:
        !declared && !bom ? ['Other legacy encodings may decode the same bytes differently'] : [],
    },
  };
}
const heading =
  /^(?:[ \t]*(?:chapter|book|part)\s+(?:\d+|[ivxlcdm]+)\b[^\r\n]*|[ \t]*[*=-]{3,}[ \t]*)\r?\n?$/i;
function* lineParts(reader: Reader, encoding: Encoding) {
  let pending = '',
    continued = false;
  for (const text of chunks(reader, encoding.name, encoding.bom)) {
    pending += text;
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline + 1);
      pending = pending.slice(newline + 1);
      yield { text: line, heading: !continued && heading.test(line) };
      continued = false;
    }
    if (pending.length >= TXT_LIMITS.chunkBytes) {
      let end = TXT_LIMITS.chunkBytes;
      if (/[\uD800-\uDBFF]/.test(pending[end - 1]!)) end--;
      yield { text: pending.slice(0, end), heading: false };
      pending = pending.slice(end);
      continued = true;
    }
  }
  if (pending) yield { text: pending, heading: !continued && heading.test(pending) };
}
function* units(reader: Reader, encoding: Encoding, source: ExternalSource): Generator<TextUnit> {
  let parts: string[] = [],
    size = 0,
    start = encoding.bom,
    ordinal = 0,
    label = '',
    continuation = false;
  const emit = (): TextUnit => ({
    id: `txt-${ordinal}`,
    ordinal: ordinal++,
    kind: 'chapter',
    label: label || `Section ${ordinal}`,
    text: parts.join(''),
    locator: {
      version: 'rezics-locator-v1',
      source,
      selector: { type: 'ByteRangeSelector', unit: 'byte', start, end: start + size },
    },
    decoding: encoding.decoding,
    warnings: [
      'Chapter boundaries are heuristic; confirm alignment with the Work parts',
      ...(continuation ? ['Chapter split at the 256 KiB segment byte ceiling'] : []),
    ],
  });
  for (const part of lineParts(reader, encoding)) {
    const bytes = iconv.encode(part.text, encoding.name).length;
    if (size && (part.heading || size + bytes > TXT_LIMITS.segmentBytes)) {
      yield emit();
      start += size;
      parts = [];
      size = 0;
      continuation = !part.heading;
    }
    if (part.heading || !label) label = part.text.split(/\r?\n/, 1)[0]!.trim().slice(0, 200);
    parts.push(part.text);
    size += bytes;
  }
  if (size) yield emit();
}
function pinned(reader: Reader): ExternalSource {
  const hash = createHash('sha256');
  for (let start = 0; start < reader.size; start += TXT_LIMITS.chunkBytes)
    hash.update(reader.read(start, Math.min(reader.size, start + TXT_LIMITS.chunkBytes)));
  return { type: 'external', representationSha256: hash.digest('hex'), mediaType: 'text/plain' };
}
function verify(
  reader: Reader,
  encoding: Encoding,
  source: ExternalSource,
  value: Locator,
): Verification {
  const locator = parseLocator(value);
  if (
    locator.source.type !== 'external' ||
    locator.source.representationSha256 !== source.representationSha256 ||
    locator.source.mediaType !== 'text/plain'
  )
    throw new Error('Locator belongs to a different representation (SHA-256 or format mismatch)');
  if (locator.selector.type !== 'ByteRangeSelector')
    throw new Error('TXT requires a byte-range locator');
  const { start, end } = locator.selector;
  if (start < encoding.bom || end > reader.size)
    throw new Error('Byte range is outside TXT text boundaries');
  if (end - start > TXT_LIMITS.segmentBytes)
    throw new Error('TXT verification range exceeds the 256 KiB segment byte ceiling');
  // Decode the containing chunks to validate that both endpoints are character boundaries.
  let byte = encoding.bom,
    before = '',
    selected = '',
    after = '',
    foundStart = false,
    foundEnd = false;
  for (const text of chunks(reader, encoding.name, encoding.bom)) {
    const length = iconv.encode(text, encoding.name).length,
      next = byte + length;
    if (byte <= start && start < next) {
      const prefix = decode(reader.read(byte, start), encoding.name);
      before += prefix;
      foundStart = true;
    }
    if (next <= start) before = (before + text).slice(-128);
    if (next > start && byte < end)
      selected += decode(reader.read(Math.max(byte, start), Math.min(next, end)), encoding.name);
    if (byte < end && end <= next) {
      after = decode(reader.read(end, next), encoding.name);
      foundEnd = true;
    } else if (foundEnd && after.length < 128) after += text;
    byte = next;
    if (foundEnd && (after.length >= 128 || byte === reader.size)) break;
  }
  if (!foundStart || !foundEnd)
    throw new Error('Byte range does not end on decoded text boundaries');
  before = [...before.slice(-128)].slice(-32).join('');
  after = [...after.slice(0, 128)].slice(0, 32).join('');
  const context = before + selected + after;
  return verified(locator, context, before.length, before.length + selected.length);
}
function readerFor(bytes: Uint8Array): Reader {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { size: bytes.length, read: (start, end) => buffer.subarray(start, end) };
}
/** In-memory convenience API: at most 128 MiB input, no per-character offset tables. */
export function parseTxt(bytes: Uint8Array, declared?: string): ParsedText {
  checkTxtSize(bytes.length);
  const reader = readerFor(bytes),
    encoding = chooseEncoding(reader, declared),
    source = pinned(reader);
  const extracted: TextUnit[] = [];
  for (const unit of units(reader, encoding, source)) {
    if (extracted.length >= TXT_LIMITS.retainedUnits)
      throw new Error('TXT exceeds the 4096-unit in-memory ceiling; use the streaming units CLI');
    extracted.push(unit);
  }
  return {
    units: extracted,
    locate(unit, start, end) {
      bounds(unit.text, start, end);
      if (extracted[unit.ordinal] !== unit || unit.locator.selector.type !== 'ByteRangeSelector')
        throw new Error('Unit does not belong to this file');
      const origin = unit.locator.selector.start;
      return {
        version: 'rezics-locator-v1',
        source,
        selector: {
          type: 'ByteRangeSelector',
          unit: 'byte',
          start: origin + iconv.encode(unit.text.slice(0, start), encoding.name).length,
          end: origin + iconv.encode(unit.text.slice(0, end), encoding.name).length,
        },
        quote: quoteSelector(unit.text, start, end),
      };
    },
    verify: (value) => verify(reader, encoding, source, value),
  };
}
/** CLI iterator: reads and hashes in 64 KiB chunks, retaining only one bounded segment. */
export function openTxtFile(path: string, declared?: string) {
  const fd = openSync(path, 'r');
  try {
    const initial = fstatSync(fd, { bigint: true });
    const size = Number(initial.size);
    const unchanged = () => {
      const current = fstatSync(fd, { bigint: true });
      if (
        current.size !== initial.size ||
        current.mtimeNs !== initial.mtimeNs ||
        current.ctimeNs !== initial.ctimeNs
      )
        throw new Error('TXT file changed while reading');
    };
    checkTxtSize(size);
    const reader: Reader = {
      size,
      read(start, end) {
        const buffer = Buffer.alloc(end - start);
        let count = 0;
        while (count < buffer.length) {
          const read = readSync(fd, buffer, count, buffer.length - count, start + count);
          if (!read) throw new Error('TXT file changed while reading');
          count += read;
        }
        return buffer;
      },
    };
    const source = pinned(reader),
      encoding = chooseEncoding(reader, declared);
    unchanged();
    return {
      units: (function* () {
        for (const unit of units(reader, encoding, source)) {
          unchanged();
          yield unit;
        }
        unchanged();
      })(),
      verify: (value: Locator) => {
        unchanged();
        const result = verify(reader, encoding, source, value);
        unchanged();
        return result;
      },
      close: () => closeSync(fd),
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
