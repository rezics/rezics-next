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
 * history on the measured subject/source. N/history scales are 32/128/512;
 * independent M (supported source collection entries) scales are 1/8/64.
 * The lowest collection cap is 64: bangumi normalize tags, vndbLimits.maxTitles,
 * wikidataLimits.terms, open-library array fieldCap. M is NOT command count.
 * The platform source-record bound defaults to 256 KiB with a hard 1 MiB cap.
 * This fixture configures a tighter 64 KiB reader cap; source mapping guards below
 * are independent (Bangumi 64 KiB, VNDB 64 KiB, Wikidata 128 KiB, Open Library 2 MiB).
 * Frozen pure-cost amendment: pure conversion is O(record bytes), retaining the
 * whole actual return's UTF-8 JSON bounded by record bytes and supported M, never
 * N/history or unrelated calls. Prove three actual byte samples with at most linear
 * delta slope and byte-identical fixed returns after N/8N/64N unrelated conversions.
 * No intrinsic observer, visit/allocation/heap counters or timing for converters.
 * Reader O(supplied bytes) and all real SQL bounds remain independent and mandatory.
 * Reconciliation/keyset page B = 8; rows <=64 * (items + M) per engine.
 *
 * The former 24 statements/item cannot cover the released two-phase path:
 * record-bindings.ts prepare(create) = BEGIN + binding + entry + record insert
 * + journal insert + COMMIT = 6; acknowledge(create) = BEGIN + binding + entry
 * + record update + journal update + COMMIT = 6. First prepare(propose) = BEGIN
 * + binding + entry + group read + group insert + two capacity updates + journal
 * insert + COMMIT = 9; acknowledge(propose) = BEGIN + binding + entry + candidate
 * read + candidate insert + journal update + COMMIT = 7. Thus one bootstrap plus
 * one candidate already costs 28 SQLite statements BEFORE RunStore or Auth/Access.
 * Later proposals omit the first group insert (8 prepare + 7 acknowledge).
 * Exact combined budgets await real binding: declare additive per-method ceilings
 * before seed/measure, derived from production branches, never from observations.
 * Include retries, controls, nested security/receipt/fence paths and RunStore
 * prepare/acknowledge. Each term has fixed + per-item + per-field coefficients;
 * no dependence on N/history. Ratio checks remain mandatory for the full capture.
 * Setup excludes database/schema/credential creation, deterministic bulk seeding,
 * ANALYZE and staging the run only; measured phase includes bootstrap, binding,
 * reconciliation, plan persistence, dispatch and acknowledgements. Acquisition is
 * separately O(supplied input), never charged as hidden nested database setup.
 * Three equal-ratio scales use shared assertGrowth: constant statements and
 * returned/examined rows for fixed operations, linear in bounded changed payload;
 * PostgreSQL blocks are logarithmic in catalogue/history. SQLite indexed-key
 * proof replaces unavailable work counters, never fabricated zero measurements.
 *
 * seed() is the ONLY setup method. Use the same deterministic algorithm at all
 * scales; bulk-load unrelated state outside measurement. It returns valid raw
 * fixtures, never derived product outcomes. All four converter export paths must
 * identify real independent production functions in bangumi/vndb/wikidata/open-library
 * order. Fixtures encode JSON ConversionInput with native IDs/revisions, not
 * invented source mappings. Count M entries in tags/vn_titles/labels/publishers.
 * Boundary fixtures use normalized supported fields only: exact source projection
 * byte/collection caps and cap+1; all other constraints remain valid. No ignored
 * filler. Input bytes and boundary fixtures are independent of N/history.
 * seed replaces the previous fixture outside measurement. dumpRecord is one framed record, <=1024
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
 * Public writes occur only for D changed records. A private bulk plan may contain
 * 300 commands, dispatched through production splitting into <=100 commands AND
 * <=65536 UTF-8 bytes per public envelope. M replacements require 2*M commands.
 * Seed/setup may NOT fake Auth or Access; real API paths use both.
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
  /** Framed valid records: 65536 and 65537 content bytes, excluding delimiter. */
  dumpAtCap: Uint8Array;
  dumpOverCap: Uint8Array;
  /** Real subject/source-record and bounded Access/receipt anchors only. */
  partitions: readonly string[];
  /** Seeded vanished keys in index order, excluding source/generation decoys. */
  vanishedKeys: readonly string[];
}
export interface ConverterFixture {
  /** Export/code-derived collection and normalized projection limits, exposed by seed. */
  limits: { bytes: number; fields: number };
  exportPath: string;
  input: Uint8Array;
  /**
   * Private native fixture generator returned by the sole seed method. Distinct
   * valid source IDs/revisions, same bounded shape, never derived product outcomes.
   * No database setup or conversion here; callers actually convert every record.
   */
  unrelatedInput(ordinal: number): Uint8Array;
  /** Exact normalized projection cap and cap+1; otherwise valid supported data. */
  atByteCap: Uint8Array;
  oversized: Uint8Array;
  atFieldCap: Uint8Array;
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
  /**
   * Unmeasured index proof: the generic plan of every distinct PostgreSQL text in this capture, client statements and
   * nested auto_explain query texts alike, from `BEGIN; SET LOCAL enable_seqscan = off; EXPLAIN (GENERIC_PLAN, FORMAT
   * JSON) <text>; ROLLBACK` on the fixture's admin connection after the measured operation. Measured sessions are never
   * pinned.
   */
  indexPlans: readonly { sql: string; plan: unknown }[];
  sqlite: {
    /** Actual ANALYZE executed after seeding at this scale, before measuring. */
    analyzed: boolean;
    growingRelations: readonly GrowingRelation[];
  };
  statements: readonly Statement[];
  networkRequests: number;
  /** Reader/database phases only; absent for pure conversion, never fabricated. */
  workUnits?: number;
  allocatedBytes?: number;
  peakRetainedBytes?: number;
  peakRetainedRecords?: number;
}
export type Operation =
  /** Submit one actual invalid public envelope, bypassing private-plan splitting. */
  | { kind: 'public-bulk'; commands: 101 }
  | { kind: 'private-plan'; commands: 300; byteHeavy: true }
  | { kind: 'convert'; exportPath: string; input: Uint8Array }
  | { kind: Scenario; source: 'growth-source'; key: 'fixed-record'; fields: number; pageCap: 8; cursor?: string };
export interface Outcome {
  /**
   * Private convert observation: UNTOUCHED actual source-function return, including
   * normalizedRecord and hash input. Absent only on rejection/non-convert paths.
   * Invoke the identified export exactly with the supplied native input/context;
   * never omit normalized data, replace hashes or reconstruct expected outputs.
   */
  actualReturn?: unknown;
  status: 'completed' | 'record-too-large' | 'batch-too-large' | 'mass-disappearance-blocked';
  publicWrites: number;
  fenceChecks: number;
  serverFenceChecks: number;
  visitedKeys: readonly string[];
  nextCursor?: string;
  /** Actual serialized public requests, in dispatch order, including all commands. */
  envelopes?: readonly string[];
}
export interface StatementBudgetTerm {
  engine: 'sqlite' | 'postgres';
  method: string;
  /** Production path, branch/loop counts and nested callees; reviewable derivation. */
  derivation: string;
  fixed: number;
  perItem: number;
  perField: number;
}
export interface ImportGrowthDriver {
  /** Static binding declarations, identical across instances/scales; never measured maxima. */
  statementBudgets: Readonly<Record<Scenario, readonly StatementBudgetTerm[]>>;
  seed(options: Readonly<Seed>): Promise<Fixture>;
  /** Flush setup; capture all real counters until callback settles, also on rejection. */
  measure<T>(operation: () => Promise<T>): Promise<{ value: T; counters: Counters }>;
  run(operation: Readonly<Operation>): Promise<Outcome>;
  stream(input: AsyncIterable<Uint8Array>, options: { pageCap: 8; recordByteCap: 65536 }): AsyncIterable<unknown>;
  close(): Promise<void>;
}
