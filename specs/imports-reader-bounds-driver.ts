import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DumpRecord, DumpSource } from './imports-dumps-driver.ts';
import type { DumpCounters } from '../services/importer/src/dumps-bytes.ts';

export const MISSING_READER_BOUNDS_DRIVER =
  'IMPORT_READER_BOUNDS_DRIVER is required: instrument real dump readers and durable staging';

/** Exact future product signatures, exported by dumps.ts and dumps-bytes.ts.
 * Existing arguments/counters remain supported; the fourth dumpLines argument
 * is optional. These are fixed service-composition exports, never caller-raised
 * ceilings. Validation happens before input[Symbol.asyncIterator] or next().
 */
export interface ReaderOptions {
  maxRecordBytes: number;
  maxChunkBytes?: number;
  counters?: DumpCounters;
}
export interface ReaderAPI {
  readDump(source: DumpSource, input: AsyncIterable<Uint8Array>, options: ReaderOptions): AsyncGenerator<DumpRecord>;
  dumpLines(
    input: AsyncIterable<Uint8Array>,
    limit: () => number,
    counters: DumpCounters,
    options?: { maxChunkBytes?: number },
  ): AsyncGenerator<Uint8Array>;
  createDumpCounters(): DumpCounters;
  MAX_DUMP_CHUNK_BYTES: 1048576;
  DEFAULT_DUMP_CHUNK_BYTES: 262144;
}
export interface RetainedSample {
  /** Actual simultaneously live backing allocations, deduplicated by identity.
   * Includes old+new buffers during growth and suspended yields. Borrowed input
   * under validation is not admitted/retained; reject before any byte access.
   * scratch includes decoder/COPY work; excludes caller-owned yielded payloads.
   */
  input: number;
  line: number;
  scratch: number;
  metadata: number;
  total: number;
  /** Historical supplied keys in any collection/arena. Current row identity is
   * scratch; fixed COPY column names are framing metadata, not source keys. */
  keyEntries: number;
}
/** TEST ONLY binding: export createImportReaderBoundsDriver(): Promise<BoundsProbe>.
 * Install interception before product loading, restore on close. measure invokes
 * its callback exactly once and observes real reads/copies, allocations, releases,
 * Set/Map additions/deletions and retained arrays/strings. No parser, outcome
 * model, replay, whole-source rechunking, cached results, heap/timing guesses or
 * static zero metadata. Samples come from actual bookkeeping at allocation,
 * release, collection mutation and yield (including reallocation transients).
 * metadata counts actual retained encoded key/string bytes and bookkeeping
 * capacity, including fixed framing state, not just payload byteLength. A real
 * reader-provided counter with that bookkeeping is an alternative to wrapping.
 * Observe fixed metadata too: empty fabricated evidence is never sufficient.
 * Capture attempted SQL/fs/API operations even when they throw. Transport
 * interception remains active across the entire factory-to-close lifetime.
 * N stored keys and U*t history are never parser inputs. Existing RunStore
 * indexed-growth proof remains required; stream work is outside DB measurement.
 */
export interface BoundsProbe {
  measure<T>(operation: () => Promise<T>): Promise<{
    value: T;
    samples: RetainedSample[];
    effects: { sql: string[]; requests: string[]; fileWrites: string[] };
  }>;
  transportAttempts(): Promise<string[]>;
  close(): Promise<void>;
}
export async function loadReaderBounds() {
  const location = process.env.IMPORT_READER_BOUNDS_DRIVER;
  if (!location) throw new Error(MISSING_READER_BOUNDS_DRIVER);
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('IMPORT_READER_BOUNDS_DRIVER must be an absolute path or file URL');
  const binding = await import(url.href);
  if (typeof binding.createImportReaderBoundsDriver !== 'function')
    throw new Error('Missing createImportReaderBoundsDriver');
  const probe: BoundsProbe = await binding.createImportReaderBoundsDriver();
  try {
    // Direct real module exports: the binding cannot substitute reader behavior.
    const imported = await probe.measure(async () => ({
      dumps: await import('../services/importer/src/dumps.ts'),
      bytes: await import('../services/importer/src/dumps-bytes.ts'),
    }));
    if (Object.values(imported.effects).some((attempts) => attempts.length)) {
      throw new Error('Dump reader module loading attempted external effects');
    }
    const { dumps, bytes } = imported.value;
    const api = { ...bytes, readDump: dumps.readDump } as unknown as ReaderAPI;
    return { api, probe };
  } catch (error) {
    await probe.close();
    throw error;
  }
}
