import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createZstdDecompress } from 'node:zlib';

export class SourceArchiveInvalid extends Error {}
export class SourceArchiveUnavailable extends Error {}
export class SourceArchiveConflict extends Error {}

export const SOURCE_ARCHIVE_LIMITS = {
  parts: 4096, bytes: 1_073_741_824, expandedBytes: 2_147_483_648,
  entries: 4096, rowBytes: 262_144, rows: 20_000_000, headerBytes: 16_384,
} as const;
export type SourceArchiveMediaType = 'application/x-tar' | 'application/zstd';
export type SourceImageRole = 'cover' | 'portrait' | 'screenshot';
export type VndbImageTable = 'vn' | 'chars' | 'vn_screenshots' | 'releases_images' | 'vn_image_votes';
export interface VndbCopyCoordinate {
  table: VndbImageTable;
  /** Zero-based physical COPY row. Equal bytes never identify an occurrence. */
  rowOrdinal: number;
  rowDigest: string;
  fieldLocator: string;
  imageId: string;
  namespace: 'vn' | 'character' | 'release';
  externalId: string;
  role: SourceImageRole;
}
export interface VerifiedVndbCopyRow extends VndbCopyCoordinate {
  profile: 'source-vndb-copy-row-v1';
  decodedRow: Record<string, string | null>;
  /** Exact canonical decoded row bytes; distinct from the compressed archive. */
  decodedBytes: Uint8Array;
  imageUrl: string;
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const utf8 = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

export function decodedCopyCell(value: string): string | null {
  if (value === '\\N') return null;
  return value.replace(/\\([0-7]{1,3}|x[0-9a-fA-F]{1,2}|.)/g, (_match, code: string) => {
    if (/^[0-7]/.test(code)) return String.fromCharCode(parseInt(code, 8));
    if (code.startsWith('x')) return String.fromCharCode(parseInt(code.slice(1), 16));
    const escapes: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
    return escapes[code] ?? code;
  });
}

async function* expanded(bytes: Uint8Array, type: SourceArchiveMediaType): AsyncGenerator<Buffer> {
  const input = Readable.from([bytes]);
  const stream = type === 'application/zstd' ? input.pipe(createZstdDecompress()) : input;
  let total = 0;
  try {
    for await (const chunk of stream) {
      const data = Buffer.from(chunk as Uint8Array);
      total += data.length;
      if (total > SOURCE_ARCHIVE_LIMITS.expandedBytes) throw new SourceArchiveInvalid('archive expansion exceeds its bound');
      yield data;
    }
  } finally { stream.destroy(); input.destroy(); }
}

/** Stream tar entries without extracting paths or materializing the expanded dump. */
async function scanTar(bytes: Uint8Array, type: SourceArchiveMediaType, wanted: string,
  consume: (chunk: Buffer, final: boolean) => void): Promise<void> {
  let pending: Buffer = Buffer.alloc(0);
  let remaining = 0, padding = 0, entry = '', entries = 0;
  let found = false, ended = false, zeroHeaders = 0;
  for await (const chunk of expanded(bytes, type)) {
    let data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    pending = Buffer.alloc(0);
    while (data.length) {
      if (ended) {
        if (data.some(byte => byte !== 0)) throw new SourceArchiveInvalid('nonzero data after tar end');
        break;
      }
      if (remaining) {
        const size = Math.min(remaining, data.length);
        if (entry === wanted) consume(data.subarray(0, size), size === remaining);
        remaining -= size; data = data.subarray(size);
        continue;
      }
      if (padding) {
        const size = Math.min(padding, data.length);
        padding -= size; data = data.subarray(size); continue;
      }
      if (data.length < 512) { pending = data; break; }
      const header = data.subarray(0, 512); data = data.subarray(512);
      if (header.every(byte => byte === 0)) {
        if (++zeroHeaders === 2) ended = true;
        continue;
      }
      if (zeroHeaders || ++entries > SOURCE_ARCHIVE_LIMITS.entries) throw new SourceArchiveInvalid('invalid tar entry bound');
      const text = (from: number, size: number) => utf8(header.subarray(from, from + size)).replace(/\0.*$/, '').trim();
      const name = text(0, 100), prefix = text(345, 155);
      entry = prefix ? `${prefix}/${name}` : name;
      if (!entry || entry.startsWith('/') || entry.split('/').some(part => part === '..' || part === '.')) {
        throw new SourceArchiveInvalid('unsafe tar entry');
      }
      const octal = text(124, 12), checksum = text(148, 8);
      const sum = header.reduce((total, value, index) => total + (index >= 148 && index < 156 ? 32 : value), 0);
      if (!/^[0-7]+$/.test(octal) || !/^[0-7]+$/.test(checksum) || parseInt(checksum, 8) !== sum) {
        throw new SourceArchiveInvalid('invalid tar header');
      }
      const kind = header[156];
      if (kind !== 0 && kind !== 48 && kind !== 53) throw new SourceArchiveInvalid('unsupported tar entry type');
      remaining = parseInt(octal, 8);
      if (!Number.isSafeInteger(remaining) || remaining > SOURCE_ARCHIVE_LIMITS.expandedBytes
        || kind === 53 && remaining !== 0) throw new SourceArchiveInvalid('invalid tar entry size');
      padding = (512 - remaining % 512) % 512;
      if (entry === wanted) {
        if (found || kind === 53) throw new SourceArchiveInvalid('ambiguous archive table');
        found = true;
        if (!remaining) consume(Buffer.alloc(0), true);
      }
    }
  }
  if (!ended || pending.length || remaining || padding || !found) throw new SourceArchiveInvalid('archive table is missing or truncated');
}

function imageLocation(input: VndbCopyCoordinate): { owner: string; column: string } {
  if (input.namespace === 'character' && input.role === 'portrait' && input.table === 'chars') return { owner: 'id', column: 'image' };
  if (input.namespace === 'vn') {
    if (input.role === 'cover' && input.table === 'vn') {
      if (input.fieldLocator === '/image') return { owner: 'id', column: 'image' };
      if (input.fieldLocator === '/c_image') return { owner: 'id', column: 'c_image' };
    }
    if (input.role === 'cover' && input.table === 'vn_image_votes') return { owner: 'vid', column: 'img' };
    if (input.role === 'screenshot' && input.table === 'vn_screenshots') return { owner: 'id', column: 'scr' };
  }
  if (input.namespace === 'release' && input.role === 'cover' && input.table === 'releases_images') return { owner: 'id', column: 'img' };
  throw new SourceArchiveInvalid('unsupported image table, namespace or capture role');
}

/** Verify the exact original ordinal; never pick a different matching duplicate. */
export async function verifyVndbCopyRow(bytes: Uint8Array, type: SourceArchiveMediaType,
  input: VndbCopyCoordinate): Promise<VerifiedVndbCopyRow> {
  const location = imageLocation(input);
  if (!Number.isSafeInteger(input.rowOrdinal) || input.rowOrdinal < 0 || input.rowOrdinal >= SOURCE_ARCHIVE_LIMITS.rows
    || !/^[a-f0-9]{64}$/.test(input.rowDigest) || input.fieldLocator !== `/${location.column}`
    || !/^(cv|ch|sf)\d+$/.test(input.imageId) || !/^[vcr]\d+$/.test(input.externalId)) {
    throw new SourceArchiveInvalid('exact COPY coordinate is required');
  }
  try {
    const header: Buffer[] = []; let headerLength = 0;
    await scanTar(bytes, type, `db/${input.table}.header`, chunk => {
      headerLength += chunk.length;
      if (headerLength > SOURCE_ARCHIVE_LIMITS.headerBytes) throw new SourceArchiveInvalid('COPY header exceeds its bound');
      header.push(chunk);
    });
    const columns = utf8(Buffer.concat(header)).replace(/\n$/, '').split('\t');
    if (!columns.length || columns.some(column => !/^[a-z][a-z0-9_]*$/.test(column))
      || new Set(columns).size !== columns.length || !columns.includes(location.owner)
      || !columns.includes(location.column)) throw new SourceArchiveInvalid('invalid COPY columns');
    let pending: Buffer = Buffer.alloc(0);
    let ordinal = 0, selected: Buffer | null = null;
    const line = (row: Buffer) => {
      if (row.length > SOURCE_ARCHIVE_LIMITS.rowBytes || ordinal >= SOURCE_ARCHIVE_LIMITS.rows) throw new SourceArchiveInvalid('COPY rows exceed their bound');
      if (ordinal++ === input.rowOrdinal) selected = Buffer.from(row);
    };
    await scanTar(bytes, type, `db/${input.table}`, (chunk, final) => {
      const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let start = 0;
      for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
        line(data.subarray(start, end)); start = end + 1;
      }
      pending = data.subarray(start);
      if (pending.length > SOURCE_ARCHIVE_LIMITS.rowBytes) throw new SourceArchiveInvalid('COPY row exceeds its bound');
      if (final && pending.length) { line(pending); pending = Buffer.alloc(0); }
    });
    if (!selected) throw new SourceArchiveUnavailable('original COPY ordinal is unavailable');
    const cells = utf8(selected).split('\t');
    if (cells.length !== columns.length) throw new SourceArchiveInvalid('COPY column count differs');
    const decodedRow = Object.fromEntries(columns.map((column, index) => [column, decodedCopyCell(cells[index]!)]));
    const decodedBytes = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(decodedRow).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))));
    if (sha(decodedBytes) !== input.rowDigest || decodedRow[location.owner] !== input.externalId
      || decodedRow[location.column] !== input.imageId
      || input.table === 'releases_images' && decodedRow.itype !== 'pkgfront') {
      throw new SourceArchiveConflict('COPY row identity, digest or image field differs');
    }
    const image = /^(cv|ch|sf)(\d+)$/.exec(input.imageId)!;
    if ((input.role === 'portrait' ? 'ch' : input.role === 'screenshot' ? 'sf' : 'cv') !== image[1]) {
      throw new SourceArchiveInvalid('image identity disagrees with its witnessed role');
    }
    return { profile: 'source-vndb-copy-row-v1', ...input, decodedRow, decodedBytes,
      imageUrl: `https://t.vndb.org/${image[1]}/${String(Number(image[2]) % 100).padStart(2, '0')}/${image[2]}.jpg` };
  } catch (error) {
    if (error instanceof SourceArchiveInvalid || error instanceof SourceArchiveConflict || error instanceof SourceArchiveUnavailable) throw error;
    throw new SourceArchiveInvalid('archive or COPY encoding is invalid', { cause: error });
  }
}
