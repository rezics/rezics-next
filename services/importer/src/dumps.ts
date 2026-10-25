import type { SourceId, SourceRecord } from '@rezics/conversion';
import { createDumpCounters, dumpLines, type DumpCounters } from './dumps-bytes';

function invalid(): never { throw new Error('Invalid dump record or framing'); }
function object(text: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function copyCell(cell: string): string | null {
  if (cell === '\\N') return null;
  // PostgreSQL COPY text escapes are decoded into bytes before UTF-8 decoding,
  // including multibyte characters represented by octal/hex escapes.
  const bytes = new TextEncoder().encode(cell);
  const out = new Uint8Array(bytes.length);
  let size = 0;
  for (let i = 0; i < bytes.length; i++) {
    let byte = bytes[i]!;
    if (byte === 92) {
      byte = bytes[++i] ?? invalid();
      const escapes: Record<number, number> = { 98: 8, 102: 12, 110: 10, 114: 13, 116: 9, 118: 11 };
      if (byte >= 48 && byte <= 55) {
        let octal = String.fromCharCode(byte);
        while (octal.length < 3 && bytes[i + 1]! >= 48 && bytes[i + 1]! <= 55) octal += String.fromCharCode(bytes[++i]!);
        byte = parseInt(octal, 8) & 255;
      } else if (byte === 120) {
        let hex = '';
        while (hex.length < 2 && bytes[i + 1] !== undefined && /[0-9a-f]/i.test(String.fromCharCode(bytes[i + 1]!))) hex += String.fromCharCode(bytes[++i]!);
        if (!hex) return invalid();
        byte = parseInt(hex, 16);
      } else byte = escapes[byte] ?? byte;
    }
    out[size++] = byte;
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(out.subarray(0, size)); }
  catch { return invalid(); }
}

/**
 * Parse decompressed text only. A later failure invalidates the entire dump,
 * including previously yielded records. VNDB archive/table assembly is separate.
 * Only native keys are retained for duplicate detection; payloads are not stored.
 */
export async function* readDump(source: SourceId, input: AsyncIterable<Uint8Array>, options: {
  maxRecordBytes: number;
  counters?: DumpCounters;
}): AsyncGenerator<SourceRecord> {
  const cap = options.maxRecordBytes;
  if (!Number.isSafeInteger(cap) || cap <= 0 || cap > Number.MAX_SAFE_INTEGER - 4) throw new Error('Invalid record byte limit');
  if (!['bangumi', 'vndb', 'openlibrary', 'wikidata'].includes(source)) return invalid();
  const counters = options.counters ?? createDumpCounters();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const keys = new Set<string>();
  let columns: string[] | null = null;
  let table: string | null = null;
  let wiki: 'start' | 'lines' | 'first' | 'value' | 'separator' | 'closed' = 'start';
  const lineCap = () => source === 'vndb' && table === null ? Math.max(cap + 1, 65536)
    : cap + (source === 'wikidata' ? 2 : 1);
  for await (const bytes of dumpLines(input, lineCap, counters)) {
    let text: string;
    try { text = decoder.decode(bytes); } catch { return invalid(); }
    let recordBytes = bytes.length;
    if (source === 'wikidata') {
      text = text.trim();
      if (!text) continue;
      if (wiki === 'closed') return invalid();
      if (wiki === 'start') {
        if (text === '[') { wiki = 'first'; continue; }
        if (text === '[]') { wiki = 'closed'; continue; }
        wiki = 'lines';
      }
      if (wiki !== 'lines') {
        if (text === ']') {
          if (wiki !== 'first' && wiki !== 'separator') return invalid();
          wiki = 'closed'; continue;
        }
        if (text === ',') {
          if (wiki !== 'separator') return invalid();
          wiki = 'value'; continue;
        }
        if (wiki !== 'first' && wiki !== 'value') return invalid();
        const comma = text.endsWith(',');
        if (comma) text = text.slice(0, -1).trimEnd();
        wiki = comma ? 'value' : 'separator';
      }
      recordBytes = new TextEncoder().encode(text).length;
    }
    if (source === 'vndb') {
      if (table === null) {
        const header = /^COPY\s+(?:(?:public|"public")\.)?("?\w+"?)\s*\(([^)]+)\)\s+FROM\s+stdin;\s*$/i.exec(text);
        if (header) {
          const identifier = (value: string) => value.startsWith('"') ? value.slice(1, -1) : value.toLowerCase();
          table = identifier(header[1]!);
          columns = header[2]!.split(',').map(c => identifier(c.trim()));
          if (table === 'vn' && (!columns.includes('id') || new Set(columns).size !== columns.length || columns.some(c => !/^\w+$/.test(c)))) return invalid();
        } else if (/^\s*COPY\s+(?:public\.)?"?vn"?(?:\s|\()/i.test(text)) return invalid();
        continue;
      }
      if (text === '\\.') { table = null; columns = null; continue; }
    }
    if (recordBytes > cap) throw new Error('Dump record exceeds byte limit');
    if (source === 'vndb' && table !== 'vn') continue;
    let payload: Record<string, unknown>;
    let key: string;
    let revision: string | null = null;
    if (source === 'vndb') {
      const cells = text.split('\t');
      if (!columns || cells.length !== columns.length) return invalid();
      payload = Object.fromEntries(columns.map((column, i) => [column, copyCell(cells[i]!)]));
      if (typeof payload.id !== 'string' || !/^v[1-9]\d*$/.test(payload.id)) return invalid();
      key = payload.id;
    } else if (source === 'openlibrary') {
      const cells = text.split('\t');
      if (cells.length !== 5) return invalid();
      const [type, id, rev, , json] = cells;
      payload = object(json!);
      if (!/^[1-9]\d*$/.test(rev!) || !positive(payload.revision) || String(payload.revision) !== rev || payload.key !== id ||
        !payload.type || typeof payload.type !== 'object' || (payload.type as Record<string, unknown>).key !== type) return invalid();
      if (type !== '/type/work' && type !== '/type/edition') continue;
      if (!(type === '/type/work' ? /^\/works\/OL[1-9]\d*W$/ : /^\/books\/OL[1-9]\d*M$/).test(id!)) return invalid();
      key = id!; revision = rev!;
    } else {
      payload = object(text);
      if (source === 'bangumi') {
        if (!positive(payload.id) || ![1, 2, 3, 4, 6].includes(payload.type as number)) return invalid();
        key = String(payload.id);
      } else {
        if (payload.type !== 'item' || typeof payload.id !== 'string' || !/^Q[1-9]\d*$/.test(payload.id) || !positive(payload.lastrevid)) return invalid();
        key = payload.id; revision = String(payload.lastrevid);
      }
    }
    if (keys.has(key)) throw new Error('Duplicate dump record key');
    keys.add(key);
    counters.yieldedRecords++;
    yield { source, key, revision, payload };
  }
  if (table !== null || (source === 'wikidata' && !['start', 'lines', 'closed'].includes(wiki))) return invalid();
}
