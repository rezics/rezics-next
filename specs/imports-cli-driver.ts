import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BatchCommand } from '@rezics/definitions/bulk';
import type { Entry } from './imports-vndb-tables-driver.ts';

/**
 * TEST ONLY: IMPORT_CLI_DRIVER exports createImportCliDriver({directory, fetch, clock}).
 * Instantiate the actual services/importer/src/cli.ts exported run entrypoint (or
 * spawn `bun services/importer/src/cli.ts`). Forward argv unchanged. The binding
 * MUST NOT parse flags, select sources, decode dumps, implement transport, derive
 * counters, reconcile records or synthesize outcomes. Production parsing,
 * independent @rezics/conversion source modules, coordinator, SQLite stores and
 * import-fetch adapter remain real. Wrappers may observe calls without replacing
 * them. No kernel shortcuts, grant creation, browser/BFF login or service token.
 * The caller supplies an existing automated-account OAuth bearer in a file.
 *
 * Document the production run's external-boundary options when binding: stdin,
 * raw VNDB archive entries, fetch, clock/sleep, AbortSignal, and an EXACT test-only
 * loopback origin exception. No public CLI switch disables HTTPS. Redirects stay
 * manual/rejected; token must never travel outside the configured exact origin.
 * Files and state paths below are real files under directory. Reopen is a fresh
 * CLI invocation, not a reset. Factory/close clean partial setup and all handles.
 * Observations include attempts from factory setup/import through invoke completion;
 * factories must not eagerly open state, read tokens or contact the API for help.
 *
 * Input strategy: uncompressed native framed stdin/file for Bangumi, Open Library
 * and Wikidata. For VNDB the exported run accepts raw six-table archive entries
 * through the documented production entry boundary, forwarding paths/byte streams
 * to the real staging loader, never pregrouping JSON or executing dump SQL.
 * Archive decompression is operator-owned: e.g. `zstd -dc -- dump.json.zst | bun
 * services/importer/src/cli.ts --source wikidata --dump - ...`. Use pipefail,
 * trusted binaries, bounded disk/record/entry caps, no shell interpolation or
 * extraction of untrusted paths. This suite does not claim tar/zstd process proof.
 *
 * Test exit choices: success/help=0, input=2, mass-disappearance=3, denied=4,
 * interrupted=130, busy=5. These are CLI outcomes, not a public API error catalogue.
 * Diagnostics are bounded maintained counters; never enumerate state for stats.
 * inspect is OUTSIDE measurement, reads actual durable state for privacy/recovery,
 * and must never be called by the CLI. baseline is an opaque committed-generation
 * fingerprint; pendingKeys are original durable journal command keys.
 *
 * Counted evidence covers ALL actual forwarded SQLite executions and returned rows,
 * including consumed iterators, transactions and reopened handles. The binding MUST
 * use createSqliteProbe from services/importer/tests/support/sqlite-growth on
 * synchronous real store operations and aggregate its actual samples, calling
 * verifyPlans before handles close. ANALYZE outside measurement at all scales; bound EXPLAIN for
 * EVERY distinct executed statement; reject growing SCAN, TEMP B-TREE, AUTOMATIC
 * indexes; require declared-index/INTEGER PRIMARY KEY SEARCH prefixes. Explicitly
 * classify exact INSERT/control; SELECT/UPDATE/DELETE cannot be exempt by name.
 * Named counts report SQLite statements and returned rows, never examined rows or
 * buffer/physical IO. Missing capture is valid only for observed no-I/O preflight.
 * seed grows failed runs under a separate hot-history source and unrelated live
 * keys/history with ONE seed at 1,8,64, leaving the measured source baseline empty; it uses real
 * stores and the same fixture API, outside measured invoke. No fabricated costs.
 * Real HTTP/Auth/PostgreSQL growth is separately proved by imports-api.test.ts;
 * core indexed store/concurrency proof is imports-run-store.test.ts. This suite
 * proves client wiring with a typed fixture remote, not server authorization.
 */
export const MISSING_CLI_DRIVER = 'IMPORT_CLI_DRIVER is required: bind production importer CLI and runner';
export const exit = { success: 0, input: 2, mass: 3, denied: 4, interrupted: 130, busy: 5 } as const;
export type Source = 'bangumi' | 'vndb' | 'openlibrary' | 'wikidata';
export interface Invocation {
  stdin?: AsyncIterable<Uint8Array>;
  entries?: AsyncIterable<Entry>;
  signal?: AbortSignal;
  /** Only this exact origin may use HTTP; omitted for production validation. */
  testOrigin?: string;
}
export interface Execution {
  code: number;
  stdout: string;
  stderr: string;
  /** Observed calls to actual runner/source registration, not argv-derived. */
  runners: { source: string; sourceKind: Source; state: string; converterModule: string; decoderModule: string }[];
  sql: { sql: string; parameters: unknown[]; rows: number; plan: string[] }[];
  fileWrites: string[];
  tokenReads: { path: string; bytes: number }[];
  requests: { url: string; authorization: string | null; bytes: number }[];
  openHandles: number;
  input: { bytes: number; passes: number; records: number; peakBufferedBytes: number; maxPageRecords: number };
  counts: { 'sqlite statements': number; 'sqlite returned rows': number };
}
export interface CliDriver {
  invoke(argv: string[], boundaries?: Invocation): Promise<Execution>;
  inspect(
    state: string,
    source: string,
  ): Promise<{
    baseline: string | null;
    pendingKeys: string[];
    normalized: unknown;
  }>;
  seed(state: string, scale: number): Promise<void>;
  close(): Promise<void>;
}
export interface Options {
  directory: string;
  /** Actual HTTP boundary only; use the real production transport over it. */
  fetch: (request: Request) => Promise<Response>;
  clock: { now(): number; sleep(ms: number): Promise<void> };
}
export type CreateCliDriver = (options: Options) => Promise<CliDriver>;
export async function loadCliDriver(): Promise<CreateCliDriver> {
  const location = process.env.IMPORT_CLI_DRIVER;
  if (!location) throw new Error(MISSING_CLI_DRIVER);
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('IMPORT_CLI_DRIVER must be an absolute path or file URL');
  const binding = await import(url.href);
  if (typeof binding.createImportCliDriver !== 'function')
    throw new Error('IMPORT_CLI_DRIVER must export createImportCliDriver');
  return binding.createImportCliDriver;
}
/** A wire observation uses the existing public command, never a parallel schema. */
export type Command = BatchCommand;
