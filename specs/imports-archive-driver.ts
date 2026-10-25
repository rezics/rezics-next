import type { Entry } from './imports-vndb-tables-driver.ts';

/**
 * TEST ONLY. The binding supplies runtime IO observation, never a TAR parser or
 * outcome model. readArchive is called directly from services/importer/src/archive.ts.
 * Existing ArchiveEntry/VndbTablesStore and converter contracts remain authoritative.
 * Input is decompressed TAR (operators may pipe zstd -dc to stdin). No compression
 * service, second source pass, COPY decoding, SQL execution or extraction belongs here.
 *
 * Proposed production reader boundary: readArchive(input, options) returns sequential
 * ArchiveEntry streams. Advancing drains an unread prior entry; cancelling its byte
 * iterator drains that entry before advancing. Returning the outer iterator closes
 * input immediately. Abort also interrupts a pending read. Full EOF validation,
 * including two zero blocks and zero-only trailing padding, precedes staging ready.
 * This suite chooses explicit rejection of PAX/GNU extension headers, not support.
 *
 * onProgress reports ACTUAL live retained backing-store bytes (including a large
 * subarray's backing allocation, header/path metadata and lookahead) and cumulative
 * byte visits in the real reader. Count copies/scans too; no input-size estimates,
 * VM statistics or static figures. Released views stop counting. Instrumentation
 * must not retain payloads. maxChunkBytes bounds the backing allocation accepted;
 * reject abusive chunks before copying. Payload length is bounded by maxTotalBytes,
 * not by a per-file allocation. Each supplied byte is visited a constant number
 * of times, with one physical stream and no file-sized arrays.
 *
 * observe instruments actual SQLite preparation/execution, partition dispatch,
 * network, filesystem, logging and subprocess calls during the operation, including nested
 * calls; no mocked reader or precomputed zeros. Loader integration intentionally
 * runs outside this pure-reader observation and uses the real VndbTablesStore.
 * Full CLI/API suites separately prove converter and kernel integration.
 */
export interface ArchiveOptions {
  maxTotalBytes: number;
  maxChunkBytes: number;
  maxMetadataBytes: number;
  signal?: AbortSignal;
  onProgress: (sample: { retainedBytes: number; visitedBytes: number }) => void;
}
export type ReadArchive = (input: AsyncIterable<Uint8Array>, options: ArchiveOptions) => AsyncIterable<Entry>;
export interface IO {
  sqlite: number;
  partitions: number;
  network: number;
  filesystem: number;
  subprocess: number;
  logs: number;
}
export interface ArchiveDriver {
  read: ReadArchive;
  observe<T>(operation: () => Promise<T>): Promise<{ value: T; io: IO }>;
}
export async function loadArchiveDriver(): Promise<ArchiveDriver> {
  const binding = process.env.IMPORT_ARCHIVE_DRIVER;
  if (!binding) throw new Error('IMPORT_ARCHIVE_DRIVER is required: bind the production streaming TAR reader');
  const observer = await import(binding);
  // A computed URL keeps the specification executable before this module exists.
  const module = new URL('../services/importer/src/archive.ts', import.meta.url).href;
  const production = await import(module);
  return { read: production.readArchive as ReadArchive, observe: observer.observe };
}
