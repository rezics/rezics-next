/**
 * Outcome contract; no product implementation or simulated counters here.
 * IMPORT_GROWTH_DRIVER is an absolute path/file URL exporting
 * createImportGrowthDriver(). Each instance owns isolated stores and credentials.
 *
 * Production bindings must use openGrowthDatabase, seed, measure, checkGrowth
 * and Population from services/kernel/test/support/growth.ts for PostgreSQL,
 * retaining raw auto_explain capture (including nested Auth/Access/fence/receipt
 * work). A root gate must run this suite with that real binding. The red verifier
 * proves only executable specifications, never product success.
 *
 * All measurements include nested calls, retries, transactions, Auth, Access,
 * schema/projection validation, server fence checks and bulk-client requests.
 * No clocks, mocks, extrapolated counts, hidden work or cheaper substitute SQL.
 * SQLite wraps actual Database prepare/query/run and Statement get/all/iterate/run,
 * transaction and exec calls. Count executions, not preparations; count each
 * executed SQL once (including transaction control), with actual bound parameters
 * and rows delivered to store code, including lazy iterator consumption. Changes
 * may be reported separately; returned rows are NOT examined rows.
 * At each scale seed runs ANALYZE outside measurement. Capture raw EXPLAIN QUERY
 * PLAN with the actual parameters for EVERY distinct executed SQLite SQL/binding,
 * also outside measurement. Never require statement-status, VM or index-height
 * estimates. SQLite blocks:0 means unavailable buffers, NOT zero physical I/O.
 * Growing-table metadata comes from actual schema/index introspection, includes
 * every growing relation (including read aliases), and is checked in test support.
 * PostgreSQL retains actual examined rows and shared hits plus reads via growth.ts.
 *
 * N = unrelated catalogue/importer keys; history = unrelated U x t, including
 * history on the measured subject/source. M = fields/proposals, capped at 512;
 * recordBytes <= 65536; reconciliation/keyset page B = 8. Fixed operations allow
 * 24 statements per item and 64 * (items + M) rows per engine, independent of
 * N/history (SQLite returned rows; PostgreSQL examined plus appended rows).
 * Three equal-ratio scales use shared assertGrowth: constant statements and
 * returned/examined rows for fixed operations, linear in bounded changed payload;
 * PostgreSQL blocks are logarithmic in catalogue/history. SQLite indexed-key
 * proof replaces unavailable work counters, never fabricated zero measurements.
 *
 * seed() is the ONLY setup method. Use the same deterministic algorithm at all
 * scales; bulk-load unrelated state outside measurement. It returns valid raw
 * fixtures, never derived product outcomes. All four converter export paths must
 * identify real independent production functions. Their fixtures have exactly M
 * fields, deterministic bytes independent of N/history, an oversized valid
 * record, and a valid 513-field record below the byte cap. seed replaces the
 * previous fixture outside measurement. dumpRecord is one framed record, <= 1024
 * bytes. stream() invokes the real dump reader directly on the supplied iterable
 * (no adapter buffering, rereading, pre-parsing or alternate acquisition).
 *
 * Seed the same source/key/field values and subject at every scale. Each scenario
 * starts fresh. New has no stored key; unchanged has matching digest/revision; changed alters one field;
 * revision changes only converter revision. Mass disappearance has a maintained
 * baseline and >50% vanished keys; vanished-page has >B allowed vanished keys,
 * an exact source/generation cursor, and a second source/generation as decoys.
 * Stage the supplied run before measurement using real importer setup. Detection
 * reads maintained baseline/seen-survivor counters, never historical COUNT.
 * Vanished enumeration uses indexed generation-specific keyset pages, not an
 * unbounded anti-join. New/changed uses (source, record_key) seeks; staging uses
 * (source, run_id, record_key). Public commands route to each subject partition;
 * every refresh checks (source, external_id, field_group), including unchanged,
 * with reference rechecks at command preparation and current-fence reads at final
 * disclosure. Tuple-home authority is independent of subject mapping; a later
 * cross-partition fence hides a write, without promising physical write exclusion.
 * Public writes occur only for D changed records. Bulk requests contain M bounded
 * commands. Seed/setup may NOT fake Auth or Access; real API paths use both.
 */
export type Scenario = 'new' | 'unchanged' | 'changed' | 'revision' | 'mass-disappearance' | 'vanished-page' | 'bulk';
export interface Seed {
  n: number;
  history: number;
  fields: number;
  scenario: Scenario;
  source: 'growth-source';
  key: 'fixed-record';
}
export interface Fixture {
  converters: readonly [ConverterFixture, ConverterFixture, ConverterFixture, ConverterFixture];
  dumpRecord: Uint8Array;
  /** Real subject/source-record and bounded Access/receipt anchors only. */
  partitions: readonly string[];
  /** Seeded vanished keys in index order, excluding source/generation decoys. */
  vanishedKeys: readonly string[];
}
export interface ConverterFixture {
  exportPath: string;
  input: Uint8Array;
  oversized: Uint8Array;
  tooManyFields: Uint8Array;
}
export type SqliteValue = null | string | number | bigint | Uint8Array;
export type SqliteParameters = readonly SqliteValue[] | Readonly<Record<string, SqliteValue>>;
export interface GrowingRelation {
  table: string;
  /** Actual schema metadata, including unique keys used by exact INSERT. */
  indexes: readonly { name: string; columns: readonly string[]; unique: boolean }[];
  integerPrimaryKey?: string;
}
export interface SqliteStatement {
  engine: 'sqlite';
  sql: string;
  parameters: SqliteParameters;
  /** JSON of raw EXPLAIN QUERY PLAN rows for this SQL and these parameters. */
  explain: string;
  rowsReturned: number;
  changes?: number;
  classification: 'readable' | 'keyed-insert' | 'transaction-control';
  /** Every growing relation read, including aliases for self joins/subqueries. */
  reads: readonly { table: string; alias: string }[];
}
export interface PostgresStatement {
  engine: 'postgres';
  /** Actual write row count, separate from auto_explain examined rows. */
  rowsAppended: number;
  sql: string;
  /** Raw auto_explain JSON; empty only for captured transaction control. */
  explain: string;
}
export type Statement = SqliteStatement | PostgresStatement;
export interface Counters {
  partitions: readonly string[];
  /** Complete raw capture from growth.ts; never SQLite returned-row counters. */
  postgres: import('../services/kernel/test/support/growth-cost').Capture;
  sqlite: {
    /** Actual ANALYZE executed after seeding at this scale, before measuring. */
    analyzed: boolean;
    growingRelations: readonly GrowingRelation[];
  };
  statements: readonly Statement[];
  networkRequests: number;
  /** Instrumented field/byte visits, allocations and peak retained parser data. */
  workUnits: number;
  allocatedBytes: number;
  peakRetainedBytes: number;
  peakRetainedRecords: number;
}
export type Operation =
  | { kind: 'convert'; exportPath: string; input: Uint8Array }
  | { kind: Scenario; source: 'growth-source'; key: 'fixed-record'; fields: number; pageCap: 8; cursor?: string };
export interface Outcome {
  status: 'completed' | 'record-too-large' | 'batch-too-large' | 'mass-disappearance-blocked';
  publicWrites: number;
  fenceChecks: number;
  serverFenceChecks: number;
  visitedKeys: readonly string[];
  nextCursor?: string;
}
export interface ImportGrowthDriver {
  seed(options: Readonly<Seed>): Promise<Fixture>;
  /** Flush setup; capture all real counters until callback settles, also on rejection. */
  measure<T>(operation: () => Promise<T>): Promise<{ value: T; counters: Counters }>;
  run(operation: Readonly<Operation>): Promise<Outcome>;
  stream(input: AsyncIterable<Uint8Array>, options: { pageCap: 8; recordByteCap: 65536 }): AsyncIterable<unknown>;
  close(): Promise<void>;
}
