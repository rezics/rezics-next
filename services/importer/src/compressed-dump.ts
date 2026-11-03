import { crc32, createInflateRaw, type InflateRaw } from 'node:zlib';
import { DumpInputError, throwIfAborted, type DumpByteProgress } from './dump-input.ts';
import { DEFAULT_DUMP_CHUNK_BYTES, MAX_DUMP_CHUNK_BYTES } from './dumps-bytes.ts';

/** Official Open Library and Wikidata gzip dumps only. VNDB archives stay uncompressed. */
export type DumpCompression = 'none' | 'gzip';
export const DUMP_COMPRESSIONS = ['none', 'gzip'] as const;
export const GZIP_DUMP_SOURCES = ['openlibrary', 'wikidata'] as const;

/** Zip-bomb ceiling for one streamed dump. Official Wikidata JSON dumps remain under this
 * as of 2026; operators raise `--decode-budget` for a larger single file. The cap does not
 * relax record, statement or journal limits. One transform-window overshoot is counted
 * before rejection: decodedBytes may exceed the budget by at most the gzip high-water mark.
 */
export const DEFAULT_DECODED_DUMP_BYTES = 256 * 1024 ** 3;
const MIN_ZLIB_CHUNK = 64;
const GZIP_HEADER = 10;
const GZIP_TRAILER = 8;

export type GzipDumpFailureIdentity =
  | 'gzip-integrity'
  | 'gzip-truncated'
  | 'gzip-trailing-garbage'
  | 'decode-budget'
  | 'compression-unsupported';

export type GzipDumpCounters = {
  compressedBytes: number;
  decodedBytes: number;
  members: number;
  peakCompressedWindow: number;
  peakDecodedWindow: number;
  decodeVisits: number;
};

export type GzipDumpObserver = {
  onDecodedChunk?(bytes: number, backingBytes: number): void;
};

export function createGzipDumpCounters(): GzipDumpCounters {
  return {
    compressedBytes: 0,
    decodedBytes: 0,
    members: 0,
    peakCompressedWindow: 0,
    peakDecodedWindow: 0,
    decodeVisits: 0,
  };
}

export function gzipHighWaterMark(value = DEFAULT_DUMP_CHUNK_BYTES): number {
  if (!Number.isSafeInteger(value) || value < MIN_ZLIB_CHUNK || value > MAX_DUMP_CHUNK_BYTES)
    throw new DumpInputError('gzip high-water mark is outside the admitted dump chunk window.', 'invalid-input');
  return value;
}

export function decodeBudgetLimit(value: number | undefined): number {
  const cap = value === undefined ? DEFAULT_DECODED_DUMP_BYTES : value;
  if (!Number.isSafeInteger(cap) || cap <= 0)
    throw new DumpInputError('Decoded-byte budget must be a positive safe integer.', 'decode-budget');
  return cap;
}

export function parseDumpCompression(value: string): DumpCompression {
  if (value === 'none' || value === 'gzip') return value;
  throw new DumpInputError('Only --compression none or gzip is admitted.', 'compression-unsupported');
}

export function admitDumpCompression(source: string, compression: DumpCompression): void {
  if (compression === 'none') return;
  if (!(GZIP_DUMP_SOURCES as readonly string[]).includes(source))
    throw new DumpInputError(
      'gzip compression is only admitted for Open Library and Wikidata streamed dumps.',
      'compression-unsupported',
    );
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function mapGzipError(error: unknown, signal: AbortSignal): never {
  if (signal.aborted) throw signal.reason ?? new DOMException('Import interrupted', 'AbortError');
  if (error instanceof DumpInputError) throw error;
  if (isAbort(error)) throw error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : 'gzip decompression failed';
  if (code === 'Z_BUF_ERROR' || /unexpected end of file/i.test(message))
    throw new DumpInputError('gzip input is truncated before a complete member trailer.', 'gzip-truncated');
  if (/incorrect data check/i.test(message))
    throw new DumpInputError('gzip CRC or length trailer does not match the decompressed member.', 'gzip-integrity');
  throw new DumpInputError('gzip dump failed integrity or completeness checks.', 'gzip-integrity');
}

function concatBytes(
  left: Uint8Array,
  right: Uint8Array,
  cap: number,
  identity: 'gzip-integrity' | 'invalid-input',
): Uint8Array {
  if (!left.byteLength) return right;
  if (!right.byteLength) return left;
  if (left.byteLength + right.byteLength > cap)
    throw new DumpInputError('gzip framing buffer exceeded the admitted window.', identity);
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left);
  out.set(right, left.byteLength);
  return out;
}

function copyOf(bytes: Uint8Array, start = 0, end = bytes.byteLength): Uint8Array {
  const owned = new Uint8Array(end - start);
  if (owned.byteLength) owned.set(bytes.subarray(start, end));
  return owned;
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

/** RFC 1952 header length, or `undefined` when more compressed bytes are required. */
function gzipHeaderSize(bytes: Uint8Array, cap: number): number | undefined {
  if (bytes.byteLength > cap)
    throw new DumpInputError('gzip header exceeds the admitted framing window.', 'gzip-integrity');
  if (bytes.byteLength < GZIP_HEADER) return undefined;
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b)
    throw new DumpInputError('Input is not a gzip dump member.', 'gzip-integrity');
  if (bytes[2] !== 8) throw new DumpInputError('gzip member is not deflate-compressed.', 'gzip-integrity');
  const flags = bytes[3]!;
  if (flags & 0xe0) throw new DumpInputError('gzip member header uses reserved flags.', 'gzip-integrity');
  let offset = GZIP_HEADER;
  if (flags & 0x04) {
    if (bytes.byteLength < offset + 2) return undefined;
    offset += 2 + (bytes[offset]! | (bytes[offset + 1]! << 8));
    if (offset > cap) throw new DumpInputError('gzip header exceeds the admitted framing window.', 'gzip-integrity');
    if (bytes.byteLength < offset) return undefined;
  }
  for (const bit of [0x08, 0x10] as const) {
    if (!(flags & bit)) continue;
    while (offset < bytes.byteLength && bytes[offset] !== 0) offset++;
    if (offset >= bytes.byteLength) return undefined;
    offset++;
    if (offset > cap) throw new DumpInputError('gzip header exceeds the admitted framing window.', 'gzip-integrity');
  }
  if (flags & 0x02) {
    if (bytes.byteLength < offset + 2) return undefined;
    offset += 2;
  }
  return offset;
}

function writeInflate(inflate: InflateRaw, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      inflate.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => finish(error);
    inflate.once('error', onError);
    try {
      inflate.write(bytes, finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error('gzip inflate write failed'));
    }
  });
}

function destroyInflate(inflate: InflateRaw | undefined): void {
  if (!inflate || inflate.destroyed) return;
  inflate.removeAllListeners();
  inflate.on('error', () => {});
  inflate.destroy();
}

/**
 * Streaming gzip transform between owned compressed chunks and the existing dump decoder.
 * This runtime's `createGunzip` concatenates members but reports trailing garbage as the same
 * incorrect-header error as a non-gzip first byte, and drops a decoded prefix when a complete
 * member shares one write with trailing bytes. Member-framed `createInflateRaw` with CRC/ISIZE
 * checks is the delivered-runtime definition: concatenated members (including an empty last
 * member) are one complete input; non-gzip bytes after a member trailer fail the capture.
 * Gzip header mtime, extra fields, filename and compression level never enter record identity.
 */
export async function* gunzipDumpChunks(
  input: AsyncIterable<Uint8Array>,
  options: {
    signal: AbortSignal;
    decodeBudget: number;
    highWaterMark?: number;
    progress?: DumpByteProgress;
    observer?: GzipDumpObserver;
    counters?: GzipDumpCounters;
  },
): AsyncGenerator<Uint8Array> {
  const highWaterMark = gzipHighWaterMark(options.highWaterMark);
  const budget = decodeBudgetLimit(options.decodeBudget);
  const counters = options.counters ?? createGzipDumpCounters();
  const iterator = input[Symbol.asyncIterator]();
  let incoming: Uint8Array | undefined;
  let incomingOffset = 0;
  let rest: Uint8Array = new Uint8Array(0);
  let inflate: InflateRaw | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener('abort', onAbort);
    destroyInflate(inflate);
    inflate = undefined;
    void iterator.return?.()?.catch(() => {});
  };
  const onAbort = () => close();
  options.signal.addEventListener('abort', onAbort, { once: true });

  const pullCompressed = async (): Promise<Uint8Array | undefined> => {
    throwIfAborted(options.signal);
    for (;;) {
      if (incoming && incomingOffset < incoming.byteLength) {
        const size = Math.min(highWaterMark, incoming.byteLength - incomingOffset);
        const owned = copyOf(incoming, incomingOffset, incomingOffset + size);
        incomingOffset += size;
        if (incomingOffset >= incoming.byteLength) incoming = undefined;
        counters.compressedBytes += size;
        counters.peakCompressedWindow = Math.max(counters.peakCompressedWindow, owned.buffer.byteLength);
        return owned;
      }
      const next = await iterator.next();
      throwIfAborted(options.signal);
      if (next.done) return undefined;
      if (!(next.value instanceof Uint8Array))
        throw new DumpInputError('Compressed dump chunk is not a byte window.', 'invalid-input');
      incoming = next.value;
      incomingOffset = 0;
      if (!incoming.byteLength) incoming = undefined;
    }
  };

  const fill = async (need: number, cap: number): Promise<boolean> => {
    while (rest.byteLength < need) {
      const more = await pullCompressed();
      if (!more) return false;
      rest = concatBytes(rest, more, cap, 'gzip-integrity');
    }
    return true;
  };

  try {
    throwIfAborted(options.signal);
    for (;;) {
      if (!rest.byteLength && !(await fill(1, MAX_DUMP_CHUNK_BYTES))) {
        if (!counters.members)
          throw new DumpInputError('gzip input is truncated before a complete member trailer.', 'gzip-truncated');
        return;
      }
      if (!(await fill(2, MAX_DUMP_CHUNK_BYTES)))
        throw new DumpInputError('gzip input is truncated before a complete member trailer.', 'gzip-truncated');
      if (rest[0] !== 0x1f || rest[1] !== 0x8b) {
        if (counters.members)
          throw new DumpInputError(
            'gzip stream has non-gzip trailing bytes after a complete member.',
            'gzip-trailing-garbage',
          );
        throw new DumpInputError('Input is not a gzip dump member.', 'gzip-integrity');
      }
      let headerSize = gzipHeaderSize(rest, MAX_DUMP_CHUNK_BYTES);
      while (headerSize === undefined) {
        if (!(await fill(rest.byteLength + 1, MAX_DUMP_CHUNK_BYTES)))
          throw new DumpInputError('gzip input is truncated before a complete member trailer.', 'gzip-truncated');
        headerSize = gzipHeaderSize(rest, MAX_DUMP_CHUNK_BYTES);
      }
      rest = copyOf(rest, headerSize);
      inflate = createInflateRaw({ chunkSize: highWaterMark });
      let memberCrc = 0;
      let memberIsize = 0;
      let memberEnded = false;
      const yieldDecoded = function* (): Generator<Uint8Array> {
        for (;;) {
          throwIfAborted(options.signal);
          const chunk = inflate!.read();
          if (!(chunk instanceof Uint8Array) || !chunk.byteLength) return;
          for (let offset = 0; offset < chunk.byteLength; offset += highWaterMark) {
            const size = Math.min(highWaterMark, chunk.byteLength - offset);
            const owned = copyOf(chunk, offset, offset + size);
            memberCrc = crc32(owned, memberCrc) >>> 0;
            memberIsize = (memberIsize + size) >>> 0;
            counters.decodedBytes += size;
            counters.decodeVisits++;
            counters.peakDecodedWindow = Math.max(counters.peakDecodedWindow, owned.buffer.byteLength);
            options.progress?.add('decodedBytes', size);
            options.observer?.onDecodedChunk?.(size, owned.buffer.byteLength);
            if (counters.decodedBytes > budget)
              throw new DumpInputError(
                `Decoded dump bytes exceeded the ${budget}-byte budget (one transform window overshoot is included).`,
                'decode-budget',
              );
            yield owned;
          }
        }
      };
      while (!memberEnded) {
        throwIfAborted(options.signal);
        if (!rest.byteLength) {
          const more = await pullCompressed();
          if (!more)
            throw new DumpInputError('gzip input is truncated before a complete member trailer.', 'gzip-truncated');
          rest = more;
        }
        const before = inflate.bytesWritten;
        await writeInflate(inflate, rest);
        throwIfAborted(options.signal);
        yield* yieldDecoded();
        const consumed = Math.min(rest.byteLength, Math.max(0, inflate.bytesWritten - before));
        if (consumed < rest.byteLength) {
          rest = copyOf(rest, consumed);
          memberEnded = true;
        } else {
          rest = new Uint8Array(0);
        }
      }
      if (!(await fill(GZIP_TRAILER, highWaterMark + GZIP_TRAILER)))
        throw new DumpInputError('gzip input is truncated before a complete member trailer.', 'gzip-truncated');
      const trailer = copyOf(rest, 0, GZIP_TRAILER);
      rest = copyOf(rest, GZIP_TRAILER);
      if (u32le(trailer, 0) !== memberCrc || u32le(trailer, 4) !== memberIsize)
        throw new DumpInputError(
          'gzip CRC or length trailer does not match the decompressed member.',
          'gzip-integrity',
        );
      counters.members++;
      destroyInflate(inflate);
      inflate = undefined;
    }
  } catch (error) {
    close();
    mapGzipError(error, options.signal);
  } finally {
    close();
  }
}

/** Apply admitted compression below the common owned byte reader. `none` is identity. */
export async function* decodeDumpBytes(
  input: AsyncIterable<Uint8Array>,
  options: {
    compression: DumpCompression;
    signal: AbortSignal;
    decodeBudget?: number;
    highWaterMark?: number;
    progress?: DumpByteProgress;
    observer?: GzipDumpObserver;
    counters?: GzipDumpCounters;
  },
): AsyncGenerator<Uint8Array> {
  if (options.compression === 'none') {
    yield* input;
    return;
  }
  yield* gunzipDumpChunks(input, {
    signal: options.signal,
    decodeBudget: decodeBudgetLimit(options.decodeBudget),
    ...(options.highWaterMark === undefined ? {} : { highWaterMark: options.highWaterMark }),
    ...(options.progress === undefined ? {} : { progress: options.progress }),
    ...(options.observer === undefined ? {} : { observer: options.observer }),
    ...(options.counters === undefined ? {} : { counters: options.counters }),
  });
}
