/**
 * Immutable outcome contract; no implementation or simulated counters here.
 * IMPORT_GROWTH_DRIVER is an absolute path/file URL exporting
 * createImportGrowthDriver(). Each instance owns isolated stores and credentials.
 *
 * No performance harness exists on main at specification time. Binding must use
 * the performance Goal's shared harness when available, and a workspace check or
 * root gate must run this entire unchanged suite with that production binding.
 * The missing-driver verifier only proves the specification executes red.
 *
 * All measurements include nested calls, retries, transactions, Auth, Access,
 * schema/projection validation, server fence checks and bulk-client requests.
 * Do not replace a dependent API with cheaper SQL or hide an existing-path cost:
 * report the exact production path and conflicting bound instead. No clocks,
 * mocks, product behavior, extrapolated counts or asserted constant counters.
 * Instrument actual operations, including zero-I/O converters. Keep raw executed
 * SQL and actual EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) / SQLite QUERY PLAN.
 * rowsExamined includes rejected/filtered/join rows, not just returned rows.
 * buffers includes hits AND reads; sqliteVmSteps/FULLSCAN_STEP are actual
 * sqlite3_stmt_status deltas, never estimates. All statements must be captured.
 *
 * N = unrelated catalogue/importer keys; history = unrelated U x t, including
 * history on the measured subject/source. M = fields/proposals, capped at 512;
 * recordBytes <= 65536; reconciliation/keyset page B = 8. Fixed operations allow
 * 24 statements per item and 64 * (items + M) examined/appended rows, independent of N/history.
 * A binary index has height ceil(log2(N + history + 2)); allow at most eight
 * buffer visits and 128 SQLite VM steps per statement per level, plus respectively
 * 8M and 128M for bounded field work across the operation. No scan is allowed
 * even below those absolute budgets.
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
 * with the server checking again before a write to close the preflight race.
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
export interface Statement {
  sql: string;
  engine: 'sqlite' | 'postgres';
  /** Raw engine plan, including parameters/index conditions and actual rows. */
  explain: string;
  rowsExamined: number;
  rowsAppended: number;
  indexBuffers: number;
  sqliteFullscanSteps?: number;
  sqliteVmSteps?: number;
}
export interface Counters {
  partitions: readonly string[];
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
