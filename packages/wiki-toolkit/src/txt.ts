// SPDX-License-Identifier: Apache-2.0
import iconv from 'iconv-lite';
import type { Locator } from '../protocol/locator.ts';
import {
  source,
  bounds,
  quoteSelector,
  verified,
  type ParsedText,
  type TextUnit,
} from './types.ts';

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
function decode(bytes: Uint8Array, declared?: string) {
  const buffer = Buffer.from(bytes);
  const bom = buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ? (['utf8', 3] as const)
    : buffer[0] === 0xff && buffer[1] === 0xfe
      ? (['utf16le', 2] as const)
      : buffer[0] === 0xfe && buffer[1] === 0xff
        ? (['utf16be', 2] as const)
        : undefined;
  const requested = declared ? canonical(declared) : undefined;
  if (declared && !requested)
    throw new Error(
      'Unsupported TXT encoding; use UTF-8, UTF-16LE/BE, Shift_JIS, Windows-1252, Latin-1 or ASCII',
    );
  if (requested && bom && requested !== bom[0])
    throw new Error('Declared encoding conflicts with the TXT byte-order mark');
  const payload = buffer.subarray(bom?.[1] ?? 0);
  const reversible = (encoding: string) =>
    iconv.encode(iconv.decode(payload, encoding), encoding).equals(payload);
  let encoding = requested ?? bom?.[0];
  if (!encoding) {
    if (reversible('utf8')) encoding = 'utf8';
    else if (
      reversible('shift_jis') &&
      /[\u3040-\u30ff\u3400-\u9fff]/.test(iconv.decode(payload, 'shift_jis'))
    )
      encoding = 'shift_jis';
    else throw new Error('TXT encoding is uncertain; declare --encoding explicitly');
  }
  if (!reversible(encoding))
    throw new Error('TXT has invalid or unsupported byte sequences for its encoding');
  const text = iconv.decode(payload, encoding);
  if (!text.trim() || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text))
    throw new Error('Unsupported or empty TXT input');
  // Mapping is over the original bytes, including the BOM displacement and CRLF.
  // Supported codecs are stateless. Reject non-round-trippable mappings above.
  const offsets = [bom?.[1] ?? 0];
  let byte = offsets[0]!;
  for (const point of text) {
    if (point.length === 1 && /[\uD800-\uDFFF]/.test(point))
      throw new Error('TXT contains an unpaired Unicode surrogate');
    byte +=
      encoding === 'utf8'
        ? Buffer.byteLength(point)
        : encoding.startsWith('utf16')
          ? point.length * 2
          : iconv.encode(point, encoding).length;
    if (point.length === 2) offsets.push(-1);
    offsets.push(byte);
  }
  return {
    text,
    offsets,
    decoding: {
      encoding,
      basis: declared ? ('declared' as const) : bom ? ('bom' as const) : ('detected' as const),
      uncertain: !declared && !bom,
      alternatives:
        !declared && !bom ? ['Other legacy encodings may decode the same bytes differently'] : [],
    },
  };
}
/** O(bytes + text) conversion and mapping; chapter boundaries are proposals, not alignment. */
export function parseTxt(bytes: Uint8Array, encoding?: string): ParsedText {
  const { text, offsets, decoding } = decode(bytes, encoding);
  const pinned = source(bytes, 'text/plain');
  const starts = [0];
  const headings =
    /^(?:[ \t]*(?:chapter|book|part)\s+(?:\d+|[ivxlcdm]+)\b[^\r\n]*|[ \t]*[*=-]{3,}[ \t]*)\r?$/gim;
  for (const match of text.matchAll(headings)) if (match.index > 0) starts.push(match.index);
  starts.push(text.length);
  const locator = (start: number, end: number, fallback: boolean): Locator => ({
    version: 'rezics-locator-v1',
    source: pinned,
    selector: {
      type: 'ByteRangeSelector',
      unit: 'byte',
      start: offsets[start]!,
      end: offsets[end]!,
    },
    ...(fallback ? { quote: quoteSelector(text, start, end) } : {}),
  });
  const units: TextUnit[] = [];
  const positions = new Map<string, number>();
  for (let i = 0; i < starts.length - 1; i++) {
    const start = starts[i]!,
      end = starts[i + 1]!;
    if (!text.slice(start, end).trim()) continue;
    const ordinal = units.length,
      id = `txt-${ordinal}`;
    positions.set(id, start);
    units.push({
      id,
      ordinal,
      kind: 'chapter',
      label: text.slice(start, end).split(/\r?\n/, 1)[0]!.trim() || `Section ${ordinal + 1}`,
      text: text.slice(start, end),
      locator: locator(start, end, false),
      decoding,
      warnings: ['Chapter boundaries are heuristic; confirm alignment with the Work parts'],
    });
  }
  const reverse = new Map(
    offsets.flatMap((byte, index) => (byte < 0 ? [] : [[byte, index] as const])),
  );
  return {
    units,
    locate(unit, start, end) {
      bounds(unit.text, start, end);
      const origin = positions.get(unit.id);
      if (origin === undefined || units[unit.ordinal] !== unit)
        throw new Error('Unit does not belong to this file');
      return locator(origin + start, origin + end, true);
    },
    verify(value) {
      if (value.selector.type !== 'ByteRangeSelector')
        throw new Error('TXT requires a byte-range locator');
      const start = reverse.get(value.selector.start),
        end = reverse.get(value.selector.end);
      if (start === undefined || end === undefined)
        throw new Error('Byte range does not end on decoded text boundaries');
      return verified(value, text, start, end);
    },
  };
}
