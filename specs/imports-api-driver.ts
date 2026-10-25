import type { HttpResponse, Json, Reference, Statement, StatementInput, Subject } from './semantic-driver';

/**
 * IMPORT_API_DRIVER is an absolute file path/URL exporting createImportApiDriver.
 * Test binding only: instantiate the production importer, migrated durable importer
 * SQLite and kernel databases, dump readers and @rezics/conversion source modules.
 * Reuse account-lifecycle/semantic production fixture setup and actual Auth-issued
 * bearer tokens; actual Access checks bulk permission and configured import limits.
 * Ordinary and bulk actors have the same required semantic permissions; only
 * bulk has bulk permission. Revocation removes only bulk permission, preserving
 * the original token, other authority and stored receipts.
 * Every write uses the decided public authenticated bulk HTTP handlers (actual
 * createKernel.handle is acceptable). No guessed route is prescribed here.
 * Setup, grants, community adoption and takedown use real module commands/API.
 * No fake policy, receipts, proposals, fences, privileged importer endpoint or
 * direct kernel write SQL. SQL observation is allowed. Factories clean partial
 * failures; close removes isolated databases/tokens even after scenario failures.
 * restart closes/reopens importer state, retaining durable state and kernel data.
 *
 * Evidence below is a test observation, NOT a competing semantic wire contract.
 * Keep HTTP bodies/headers intact. Proposal/field evidence must be extracted from
 * actual retrieved public bodies, with persisted revisions independently observed.
 * Semantic owns the public proposal/bulk schema. No expected output may be seeded.
 */
export type Source = 'bangumi' | 'vndb' | 'openlibrary' | 'wikidata';
export interface Dump {
  source: Source;
  snapshot: string;
  bytes: Uint8Array;
  converterRevision: string;
}
export interface Proposal {
  id: string;
  subjectId: string;
  source: Source;
  externalId: string;
  recordRevision: string;
  recordDigest: string;
  converterRevision: string;
  fieldGroup: string;
  kind: 'value' | 'source-removal';
  statement: Statement | null;
  /** References on the actual proposal, including source-removal proposals. */
  references: Reference[];
}
export interface RecordView {
  responses: HttpResponse[];
  subject: Subject | null;
  proposals: Proposal[];
  /** Actual stored subject revisions, including historical proposal revisions. */
  revisions: { revision: number; proposalIds: string[] }[];
  /** Effective community choice read through semantic's public API. */
  adopted: Record<string, Json>;
}
/** Import-domain committed effects, including public bulk receipts; exclude setup/grant administration. */
export interface Effects {
  subjects: number;
  proposals: number;
  revisions: number;
  receipts: number;
}
export interface Baseline {
  snapshot: string | null;
  records: number;
  acknowledgedBatches: number;
}
export interface Exchange {
  request: { url: string; method: string; headers: Headers; body: unknown; key: string };
  response: HttpResponse;
  atMs: number;
  /** Independently observed durable receipt ID; null for rejected requests. */
  receiptId: string | null;
}
export interface Run {
  outcome: 'complete' | 'mass-disappearance' | 'invalid-input' | 'denied' | 'interrupted';
  /** Every attempted public bulk write, including rejected/retried attempts. */
  exchanges: Exchange[];
  waits: { startedAtMs: number; durationMs: number }[];
  vanished: string[];
}
export interface Counters {
  statements: number;
  rowsExamined: number;
  fullScans: number;
  sqliteFullscanSteps: number;
  sqliteVmSteps: number;
  pgRows: number;
  pgBuffers: number;
  partitions: number;
  inputBytes: number;
  records: number;
  peakBufferedBytes: number;
  maxPageRecords: number;
  /** Observed index heights, not computed from the supplied scale. */
  indexLevels: number;
  /** Instrumented byte/token/field visits including revisits, never byte estimates. */
  workUnits: number;
}
export type CostPhase = 'reader' | 'converter' | 'reconcile' | 'api';
export interface ImportApiDriver {
  /** Resolve bundled standard vocabulary IDs, not invented import properties. */
  readonly properties: { title: string; summary: string; cover: string; externalId: string };
  run(
    dump: Dump,
    controls?: {
      as?: 'bulk' | 'ordinary';
      /** Real barrier after client fence preflight, before the actual HTTP write. */
      beforeWrite?: () => Promise<void>;
      /** Drop one committed response at the transport boundary; halt before retry. */
      loseCommittedResponse?: boolean;
      /** Observe rejected 429 before importer sleep/retry or checkpoint updates. */
      onRateLimited?: (exchange: Exchange) => Promise<void>;
    },
  ): Promise<Run>;
  read(source: Source, externalId: string): Promise<RecordView>;
  effects(): Promise<Effects>;
  baseline(source: Source): Promise<Baseline>;
  /** Durable importer acknowledgement for this stable batch key, never inferred from HTTP status. */
  acknowledged(key: string): Promise<boolean>;
  restart(): Promise<void>;
  setBulkPermission(allowed: boolean): Promise<void>;
  /** Reissue exactly this captured request, using the same real actor/token. */
  replay(exchange: Exchange): Promise<HttpResponse>;
  adopt(source: Source, externalId: string, property: string, value: Json): Promise<void>;
  takedown(source: Source, externalId: string, fieldGroup: string): Promise<void>;
  /** Configure real import limit and authoritative test clock; no fake 429s. */
  rateLimit(input: { requests: number; windowMs: number; nowMs: number }): Promise<void>;
  /** Untouched production converter result plus extracted actual statement inputs; no database access. */
  convert(
    source: Source,
    record: unknown,
    converterRevision: string,
  ): Promise<{
    raw: unknown;
    statements: StatementInput[];
  }>;
  /**
   * Performance-only setup: one deterministic method at ALL scales. May bulk-load
   * unrelated setup outside measurement; never bypass behavior in outcome tests.
   * Catalogue/importer keys and account/editorial history grow independently;
   * Counts are target totals. Include historical importer keys in the measured
   * source and unrelated sources, without changing its active one-record baseline.
   * Include unrelated semantic/auth/editorial history in the measured partition.
   * Seed records never share the measured key. Each scale uses a fresh factory.
   */
  seed(input: { catalogueRecords: number; historyRows: number }): Promise<void>;
  /**
   * Narrow bridge to the performance Goal's shared harness when available. Measure
   * real executed statements/rows, SQLite stmt_status FULLSCAN_STEP/VM_STEP and
   * PostgreSQL buffers/EXPLAIN actual rows, including Access/fence/receipt work.
   * Account every operation in a phase; no hidden adapter work or elapsed time.
   * Reader/converter counters include all parser/converter invocations and bytes.
   */
  measure(action: () => Promise<void>): Promise<Record<CostPhase, Counters>>;
  close(): Promise<void>;
}
export interface DriverOptions {
  /** Test-configured production caps: B=8; M<=64; one record <=64 KiB. */
  batchRecords: 8;
  maxFields: 64;
  maxRecordBytes: 65536;
}
export type CreateImportApiDriver = (options: DriverOptions) => Promise<ImportApiDriver>;
