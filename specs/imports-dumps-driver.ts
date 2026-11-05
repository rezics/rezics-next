import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Test-only binding, not a public importer or semantic bulk API. The module at
 * IMPORT_DUMPS_DRIVER exports createImportDumpsDriver(). read binds the actual
 * streaming readers in services/importer, with decompressed source bytes.
 * Archive acquisition/decompression and @rezics/conversion are outside this
 * reader suite. No converter, command proposal, rights or field-group synthesis
 * belongs here; conversion uses one pure source module and converter_revision.
 *
 * The adapter may only map reader values and original error classifications.
 * It must not parse, filter, deduplicate, repair, buffer or catch-and-skip rows.
 * payload is the entire parsed source object (COPY cells remain strings/null),
 * never reconstructed from fixture expectations. key is the native record key;
 * revision is the source revision rendered as a string, or null when absent.
 * No fabricated revision from dump date, hash, row position or converter version.
 *
 * Each call is an independent framing/native-record parse. Every duplicate key
 * remains visible unchanged; only durable RunStore.stage UNIQUE(source,run_id,
 * record_key) rejects duplicate entire input before any API effects.
 * maxRecordBytes bounds encoded record bytes before decoding/JSON parsing;
 * framing, COPY headers and newline delimiters are not part of a record.
 * A rejection invalidates the whole dump even if earlier records were yielded;
 * it can never be interpreted as absence/deletion in reconciliation.
 * No API, database, filesystem mutation or SQL execution is available to read.
 */
export type DumpSource = 'bangumi' | 'vndb' | 'openlibrary' | 'wikidata';
export interface DumpRecord {
  source: DumpSource;
  key: string;
  revision: string | null;
  payload: Record<string, unknown>;
}
export interface ImportDumpsDriver {
  read(
    source: DumpSource,
    input: AsyncIterable<Uint8Array>,
    options: {
      maxRecordBytes: number;
    },
  ): AsyncIterable<DumpRecord>;
  /**
   * Real instrumentation active from factory creation through inspection:
   * all attempted database statements, outbound requests and file writes from
   * reader execution, including failed attempts. Never constant empty arrays.
   */
  effects(): Promise<{ sql: string[]; requests: string[]; fileWrites: string[] }>;
  close(): Promise<void>;
}

/** Called inside every scenario, before fixtures or any product imports. */
export async function loadImportDumpsDriver(): Promise<ImportDumpsDriver> {
  const location = process.env.IMPORT_DUMPS_DRIVER;
  if (!location) throw new Error('IMPORT_DUMPS_DRIVER is required: bind production dump readers');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('IMPORT_DUMPS_DRIVER must be an absolute path or file URL');
  const binding = await import(url.href);
  if (typeof binding.createImportDumpsDriver !== 'function') {
    throw new Error('IMPORT_DUMPS_DRIVER must export createImportDumpsDriver');
  }
  return binding.createImportDumpsDriver();
}
