import type { SourceId, SourceRecord } from '@rezics/conversion';
import {
  createDumpCounters,
  dumpChunkLimit,
  dumpRecordLimit,
  dumpLines,
  DumpMemory,
  type DumpCounters,
} from './dumps-bytes';

function invalid(): never {
  throw new Error('Invalid dump record or framing');
}
function object(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

type WikiScan = { depth: number; quoted: boolean; escaped: boolean; started: boolean; bytes: number };
function scanWikiEntity(text: string, scan: WikiScan): boolean | null {
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    const code = text.charCodeAt(i);
    if (code <= 0x7f) scan.bytes++;
    else if (code <= 0x7ff) scan.bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      scan.bytes += 4;
      i++;
    } else scan.bytes += 3;
    if (scan.quoted) {
      if (scan.escaped) scan.escaped = false;
      else if (char === '\\') scan.escaped = true;
      else if (char === '"') scan.quoted = false;
      continue;
    }
    if (char === '"') scan.quoted = true;
    else if (char === '{') {
      scan.started = true;
      scan.depth++;
    } else if (char === '}') {
      if (scan.depth === 0) return invalid();
      if (--scan.depth === 0) {
        const tail = text.slice(i + 1).trim();
        if (tail !== '' && tail !== ',') return invalid();
        return tail === ',';
      }
    }
  }
  if (!scan.started) return invalid();
  return null;
}

function copyCell(cell: string, memory: DumpMemory, counters: DumpCounters): string | null {
  if (cell === '\\N') return null;
  // PostgreSQL COPY text escapes are decoded into bytes before UTF-8 decoding,
  // including multibyte characters represented by octal/hex escapes.
  const bytes = new TextEncoder().encode(cell);
  counters.copiedBytes += bytes.length;
  memory.hold(5, bytes);
  const out = new Uint8Array(bytes.length);
  memory.hold(6, out);
  let size = 0;
  for (let i = 0; i < bytes.length; i++) {
    let byte = bytes[i]!;
    if (byte === 92) {
      byte = bytes[++i] ?? invalid();
      const escapes: Record<number, number> = { 98: 8, 102: 12, 110: 10, 114: 13, 116: 9, 118: 11 };
      if (byte >= 48 && byte <= 55) {
        let octal = String.fromCharCode(byte);
        while (octal.length < 3 && bytes[i + 1]! >= 48 && bytes[i + 1]! <= 55)
          octal += String.fromCharCode(bytes[++i]!);
        byte = parseInt(octal, 8) & 255;
      } else if (byte === 120) {
        let hex = '';
        while (hex.length < 2 && bytes[i + 1] !== undefined && /[0-9a-f]/i.test(String.fromCharCode(bytes[i + 1]!)))
          hex += String.fromCharCode(bytes[++i]!);
        if (!hex) return invalid();
        byte = parseInt(hex, 16);
      } else byte = escapes[byte] ?? byte;
    }
    out[size++] = byte;
    counters.copiedBytes++;
  }
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(out.subarray(0, size));
    memory.hold(7, value);
    return value;
  } catch {
    return invalid();
  }
}

/**
 * Parse decompressed text only. A later failure invalidates the entire dump,
 * including previously yielded records. VNDB archive/table assembly is separate.
 * Duplicates are yielded unchanged: durable RunStore staging owns run uniqueness.
 */
export async function* readDump(
  source: SourceId,
  input: AsyncIterable<Uint8Array>,
  options: {
    maxRecordBytes?: number | undefined;
    maxChunkBytes?: number;
    counters?: DumpCounters;
  } = {},
): AsyncGenerator<SourceRecord> {
  const chunkCap = dumpChunkLimit(options.maxChunkBytes);
  const cap = dumpRecordLimit(options.maxRecordBytes);
  if (!['bangumi', 'vndb', 'openlibrary', 'wikidata'].includes(source)) return invalid();
  const counters = options.counters ?? createDumpCounters();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const memory = new DumpMemory(counters);
  memory.hold(8, source, 'metadata');
  let columns: string[] | null = null;
  let table: string | null = null;
  let wiki: 'start' | 'lines' | 'first' | 'value' | 'valueOrClose' | 'separator' | 'closed' = 'start';
  let wikiParts: string[] | null = null;
  let wikiBytes = 0;
  const wikiScan: WikiScan = { depth: 0, quoted: false, escaped: false, started: false, bytes: 0 };
  const lineCap = () =>
    source === 'vndb' && table === null ? Math.max(cap + 1, 65536) : cap + (source === 'wikidata' ? 2 : 1);
  try {
    for await (const bytes of dumpLines(input, lineCap, counters, { maxChunkBytes: chunkCap }, memory)) {
      try {
        let text: string;
        try {
          text = decoder.decode(bytes);
        } catch {
          return invalid();
        }
        memory.hold(3, text);
        let recordBytes = bytes.length;
        if (source === 'wikidata') {
          text = text.trim();
          let assembled = false;
          if (!text) continue;
          if (wiki === 'closed') return invalid();
          if (wiki === 'start') {
            if (text === '[') {
              wiki = 'first';
              continue;
            }
            if (text === '[]') {
              wiki = 'closed';
              continue;
            }
            wiki = 'lines';
          }
          if (wiki !== 'lines') {
            if (wikiParts === null) {
              if (text === ']') {
                if (wiki !== 'first' && wiki !== 'separator' && wiki !== 'valueOrClose') return invalid();
                wiki = 'closed';
                continue;
              }
              if (text === ',') {
                if (wiki !== 'separator') return invalid();
                wiki = 'value';
                continue;
              }
              if (wiki !== 'first' && wiki !== 'value' && wiki !== 'valueOrClose') return invalid();
              wikiParts = [];
              wikiBytes = 0;
              wikiScan.depth = 0;
              wikiScan.quoted = false;
              wikiScan.escaped = false;
              wikiScan.started = false;
              wikiScan.bytes = 0;
            }
            wikiParts.push(text);
            if (wikiParts.length > 1) wikiScan.bytes++;
            wikiBytes += bytes.length + (wikiParts.length > 1 ? 1 : 0);
            memory.hold(4, wikiParts);
            const comma = scanWikiEntity(text, wikiScan);
            if (comma === null) {
              if (wikiBytes > cap + 1) return invalid();
              continue;
            }
            if (comma) {
              const last = wikiParts.length - 1;
              wikiParts[last] = wikiParts[last]!.slice(0, -1);
            }
            text = wikiParts.join('\n');
            memory.hold(14, text);
            wikiParts = null;
            memory.hold(4, null);
            memory.hold(4, text);
            memory.hold(14, null);
            wiki = comma ? 'valueOrClose' : 'separator';
            assembled = true;
          }
          memory.hold(4, text);
          if (assembled) counters.copiedBytes += wikiScan.bytes;
          recordBytes = wikiScan.bytes;
        }
        if (source === 'vndb') {
          if (table === null) {
            const header = /^COPY\s+(?:(?:public|"public")\.)?("?\w+"?)\s*\(([^)]+)\)\s+FROM\s+stdin;\s*$/i.exec(text);
            if (header) {
              const identifier = (value: string) => (value.startsWith('"') ? value.slice(1, -1) : value.toLowerCase());
              table = identifier(header[1]!);
              columns = header[2]!.split(',').map((c) => identifier(c.trim()));
              memory.hold(9, table, 'metadata');
              memory.hold(10, columns, 'metadata');
              if (table === 'vn') {
                const names = new Set(columns); // Bounded COPY framing names, never record identities.
                memory.hold(11, names);
                if (!columns.includes('id') || names.size !== columns.length || columns.some((c) => !/^\w+$/.test(c)))
                  return invalid();
                memory.hold(11, null);
              }
            } else if (/^\s*COPY\s+(?:public\.)?"?vn"?(?:\s|\()/i.test(text)) return invalid();
            continue;
          }
          if (text === '\\.') {
            table = null;
            columns = null;
            memory.hold(9, null);
            memory.hold(10, null);
            continue;
          }
        }
        if (recordBytes > cap) throw new Error('Dump record exceeds byte limit');
        if (source === 'vndb' && table !== 'vn') continue;
        let payload: Record<string, unknown>;
        let key: string;
        let revision: string | null = null;
        if (source === 'vndb') {
          const cells = text.split('\t');
          memory.hold(12, cells);
          if (!columns || cells.length !== columns.length) return invalid();
          payload = {};
          for (let i = 0; i < columns.length; i++) {
            const value = copyCell(cells[i]!, memory, counters);
            Object.defineProperty(payload, columns[i]!, {
              value,
              enumerable: true,
              writable: true,
              configurable: true,
            });
            for (const slot of [5, 6, 7]) memory.hold(slot, null);
          }
          if (typeof payload.id !== 'string' || !/^v[1-9]\d*$/.test(payload.id)) return invalid();
          key = payload.id;
        } else if (source === 'openlibrary') {
          const cells = text.split('\t');
          memory.hold(12, cells);
          if (cells.length !== 5) return invalid();
          const [type, id, rev, , json] = cells;
          payload = object(json!);
          if (
            !/^[1-9]\d*$/.test(rev!) ||
            !positive(payload.revision) ||
            String(payload.revision) !== rev ||
            payload.key !== id ||
            !payload.type ||
            typeof payload.type !== 'object' ||
            (payload.type as Record<string, unknown>).key !== type
          )
            return invalid();
          if (type !== '/type/work' && type !== '/type/edition') continue;
          if (!(type === '/type/work' ? /^\/works\/OL[1-9]\d*W$/ : /^\/books\/OL[1-9]\d*M$/).test(id!))
            return invalid();
          key = id!;
          revision = rev!;
        } else {
          payload = object(text);
          if (source === 'bangumi') {
            if (!positive(payload.id) || ![1, 2, 3, 4, 6].includes(payload.type as number)) return invalid();
            key = String(payload.id);
          } else {
            const hasRevision = Object.prototype.hasOwnProperty.call(payload, 'lastrevid');
            const identity =
              payload.type === 'item' ? /^Q[1-9][0-9]*/ : payload.type === 'property' ? /^P[1-9][0-9]*/ : null;
            if (
              !identity ||
              typeof payload.id !== 'string' ||
              // Compare the whole match: JavaScript's $ also admits a final newline.
              identity.exec(payload.id)?.[0] !== payload.id ||
              (hasRevision && !positive(payload.lastrevid))
            )
              return invalid();
            // Properties consume framing but never become catalogue source members.
            if (payload.type === 'property') continue;
            key = payload.id;
            if (hasRevision) revision = String(payload.lastrevid);
          }
        }
        memory.hold(13, key);
        counters.yieldedRecords++;
        memory.sample();
        yield { source, key, revision, payload };
      } finally {
        for (const slot of [3, 5, 6, 7, 11, 12, 13]) memory.hold(slot, null);
        if (wikiParts === null) memory.hold(4, null);
      }
    }
    if (
      table !== null ||
      (source === 'wikidata' && (wikiParts !== null || !['start', 'lines', 'closed'].includes(wiki)))
    )
      return invalid();
  } finally {
    memory.close();
  }
}
