import type { BatchCommand, BatchStatement, Rights } from '@rezics/definitions/bulk';
import type { CoverCredit, CoverProvenance } from '@rezics/definitions/media-import';
import type { GrowingRelation, SqliteStatement } from './imports-growth-driver';
import type { Capture } from '../services/kernel/test/support/growth-cost';
import type { GrowthDatabase, Population } from '../services/kernel/test/support/growth';
import type { HttpResponse, Json, Reference, Statement, Subject } from './semantic-driver';
import type { ConversionContext } from '../packages/conversion/src/support';

/**
 * IMPORT_API_DRIVER is an absolute file path/URL exporting createImportApiDriver.
 * Test binding only: instantiate the production importer, migrated durable importer
 * SQLite and kernel databases, dump readers and @rezics/conversion source modules.
 * Reuse account-lifecycle/semantic production fixture setup and actual Auth-issued
 * bearer tokens; actual Access checks bulk permission and configured import limits.
 * Both actors have subject:create; only bulk has subject:batch_write,
 * source_fence:read and media:import_from_url, all on the sole Global resource.
 * Ordinary has no import-only grants or scopes. Governance uses data-defined
 * moderation/grant authority. Revocation removes only batch write, preserving
 * the original token, other authority and stored receipts.
 * Every write uses the decided public authenticated bulk HTTP handlers (actual
 * createKernel.handle is acceptable). Use POST /v1/subjects:batchWrite and @rezics/definitions/bulk.
 * Grant subject:batch_write and bulk-import authority ONLY on Global
 * {route:0,id:00000000-0000-8000-8000-000000000000}. Claims at
 * (source,external_id) create-or-resolve one stable subject across all groups.
 * Setup, grants, community adoption and takedown use real module commands/API.
 * No fake policy, receipts, proposals, fences, privileged importer endpoint or
 * direct kernel write SQL. SQL observation is allowed. Factories clean partial
 * failures; close removes isolated databases/tokens even after scenario failures.
 * restart closes/reopens importer state, retaining durable state and kernel data.
 *
 * Frozen pure-cost amendment: pure conversion is O(record bytes), with logical
 * retained whole-return UTF-8 JSON bounded by record bytes and supported M, never
 * N/history or unrelated calls. Observe the untouched return, including normalized
 * data/hash input; three actual byte samples prove at most linear delta slope,
 * and N/8N/64N actual unrelated conversions preserve the entire fixed return.
 * No intrinsic observer, visit/allocation/heap counters or timing for converters.
 * Reader O(supplied bytes), SQLite executions/rows/EQP and PostgreSQL nested
 * auto_explain buffers/rows/statements remain mandatory with unchanged bounds.
 * Platform source records default to 256 KiB, hard 1 MiB; this fixture deliberately
 * uses a tighter 64 KiB reader cap. Source mappings retain their independent
 * guards (Bangumi 64 KiB, VNDB 64 KiB, Wikidata 128 KiB, Open Library 2 MiB).
 *
 * Evidence below is a test observation, NOT a competing semantic wire contract.
 * Keep HTTP bodies/headers intact. Proposal/field evidence must be extracted from
 * actual retrieved public bodies, with persisted revisions independently observed.
 * Semantic owns the public proposal/bulk schema. No expected output may be seeded.
 * Only external source HTTP and object-store boundary fixtures are permitted,
 * through production content adapters with deterministic encoded source bytes.
 * Use the existing production domain allowlist for the supplied fixture URL; keep
 * source/redirect URL validation and byte/time/pixel caps active.
 * Run the real registered content jobs/Sharp pipeline; no fake media state/job,
 * Auth, Access, document persistence, tuple-home fences or evaluator.
 * Source envelopes retain only native record revision/digest/converter metadata;
 * never invent a native snapshot revision or map fixture labels to fingerprints.
 * Register fixture feed openlibrary explicitly with createSourceRegistration's
 * source alias; never rewrite observed native source envelopes.
 * Cover transport uses POST /v1/media:importFromUrl {containerId,sourceUrl,credit,provenance}
 * with containerId resolved from the actual subject bootstrap and the ordinary
 * automated account bearer/bulk-import grant. No BFF, relay,
 * media:complete, R2 credentials or service token bypass. Every refresh checks
 * all tuple-home fences (unchanged included); preparation rechecks references;
 * final public disclosure reads current fences independently of subject mapping.
 * A cross-partition fence promises disclosure hiding, not physical write exclusion.
 */
export type Source = 'bangumi' | 'vndb' | 'openlibrary' | 'wikidata';
export interface Dump {
  source: Source;
  /** Fixture label only; never source metadata or acknowledgement authority. */
  snapshot: string;
  bytes: Uint8Array;
  converterRevision: string;
  /** Raw archive entry streams; VNDB COPY TO STDOUT files plus matching .header. */
  entries?: () => AsyncIterable<{
    path: string;
    kind: 'file';
    declaredBytes: number;
    bytes: AsyncIterable<Uint8Array>;
  }>;
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
  /** Actual source-retracted candidate IDs; historical proposals remain readable. */
  retracted: string[];
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
  /** Exact RunStore.source generation fingerprint, opaque or null; no label mapping. */
  snapshot: string | null;
  /** Exact maintained RunStore.source count; no history COUNT/scan. */
  records: number;
}
export interface Exchange {
  request: {
    url: string;
    method: string;
    headers: Headers;
    body: unknown;
    /** Untouched actual serialized UTF-8 HTTP body, not observer JSON.stringify output. */
    serializedBody: string;
    /** Keys in actual serialized command order. */
    keys: string[];
  };
  response: HttpResponse;
  atMs: number;
  /**
   * Ordered per-command observations from actual persisted core.receipt PKs.
   * Identity serializes the native composite PK, never a generated UUID/batch ID.
   * Rejected 429/denied requests expose no receipts (an empty array).
   */
  receipts: { key: string; identity: string | null }[];
}
export interface Run {
  outcome: 'complete' | 'mass-disappearance' | 'invalid-input' | 'denied' | 'interrupted';
  /** Untouched actual converter results captured during this run; never reconstructed metadata. */
  conversions: readonly { readonly sourceMetadata?: unknown }[];
  /** Every attempted public bulk write, including rejected/retried attempts. */
  exchanges: Exchange[];
  waits: { startedAtMs: number; durationMs: number }[];
  vanished: string[];
}
export interface Counters {
  /** Executions and actual rows delivered to SQLite store code, NOT examined rows. */
  statements: number;
  rowsReturned: number;
  sqlite: { analyzed: boolean; growingRelations: readonly GrowingRelation[]; executions: readonly SqliteStatement[] };
  /** Raw shared growth.ts auto_explain capture, including nested Auth/Access/fence/receipt work. */
  postgres: Capture;
  partitions: number;
  inputBytes: number;
  records: number;
  peakBufferedBytes: number;
  maxPageRecords: number;
  /** Instrumented byte/token/field visits including revisits, never byte estimates. */
  workUnits: number;
}
export type CostPhase = 'reader' | 'converter' | 'reconcile' | 'api';
/** Pure conversion needs no fictitious byte/visit/heap/record counters. */
export type PhaseCounters = Record<Exclude<CostPhase, 'converter'>, Counters> & {
  converter: Pick<Counters, 'statements' | 'rowsReturned' | 'sqlite' | 'postgres' | 'partitions'>;
};
export interface ImportApiDriver {
  /** Same migrated/instrumented DB used by real kernel requests, opened via openGrowthDatabase. */
  readonly growthDatabase: GrowthDatabase;
  /** Shared seed(Population) setup grows BOTH hot partition and unrelated catalogue/history. */
  readonly population: Population;
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
  /** Actual captured bulk commands, never regenerated expected proposals. */
  commands(run: Run): BatchCommand[];
  /** Fetch through public content disclosure, then independently inspect persisted rows. No scalar-to-document synthesis. */
  document(proposal: Proposal): Promise<{
    response: { status: number; headers: Headers; bytes: Uint8Array };
    stored: { id: string; digest: string; bytes: Uint8Array; rights: Rights; transactionId: string };
    semantic: { documentId: string; digest: string; language: string; body: null; transactionId: string };
  }>;
  /** Public media GET plus independent native media/storage/job observations. */
  media(proposal: Proposal): Promise<{
    id: string;
    state: string;
    transitions: string[];
    role: string;
    /** Native persisted/status credit and provenance, without display-line synthesis. */
    credit: CoverCredit;
    provenance: CoverProvenance;
    digest: string;
    sourceBytes: Uint8Array;
    storedBytes: Uint8Array;
    response: { status: number; headers: Headers; bytes: Uint8Array; url: string };
    sharedSharpPipeline: boolean;
    /** Captured production transport and verified Auth context, not asserted by a fake job. */
    transport: {
      request: { url: string; method: string; headers: Headers; body: unknown };
      importerId: string;
      verifiedSub: string;
      websiteSession: boolean;
      serviceToken: boolean;
      importerFetchedBytes: number;
      contentFetches: string[];
    };
  }>;
  /** All actual media:importFromUrl requests/jobs so a forbidden reimport cannot hide behind reuse. */
  mediaImports(): Promise<{ requests: number; jobs: number }>;
  /** Current restricted check and direct public content fetch using captured IDs. */
  fence(
    source: Source,
    externalId: string,
    fieldGroup: string,
    as: 'bulk' | 'ordinary' | 'anonymous',
  ): Promise<HttpResponse>;
  disclose(proposal: Proposal): Promise<{ status: number; bytes: Uint8Array }>;
  baseline(source: Source): Promise<Baseline>;
  /**
   * Durable individual command ACK from the source-owned journal/RunStore command done
   * and bootstrap binding ACK as applicable; never HTTP status or duplicate authority.
   * Exact source/owner/command-key seeks only, O(log N); no receipt/history enumeration.
   */
  acknowledged(key: string): Promise<boolean>;
  /**
   * Native complete record ACK for the current run from RunStore.key acknowledged
   * (or its installed same-database transaction adapter), only after ALL record
   * commands. Exact source/record point read; no synthetic ACK table or status count.
   */
  recordAcknowledged(source: Source, externalId: string): Promise<boolean>;
  /** Exact persisted per-command receipt PK lookup using the captured command context. */
  receipt(key: string): Promise<string | null>;
  restart(): Promise<void>;
  setBulkPermission(allowed: boolean): Promise<void>;
  /**
   * Reissue the exact captured public body/keys with the original bulk actor/token
   * by default (also for as:bulk). Explicit as:ordinary uses the actual ordinary
   * Auth bearer, never actor/scope mapping. This direct HTTP boundary observation
   * does not bypass preflight in the production importer.
   * Every command must be reauthorized before its own receipt lookup.
   */
  replay(exchange: Exchange, options?: { as: 'bulk' | 'ordinary' }): Promise<HttpResponse>;
  adopt(source: Source, externalId: string, property: string, value: Json): Promise<void>;
  /**
   * Final rights complaint: for cover, call the actual content media takedown API
   * AND the separate tuple-home fence API, as ordinary commands in their own
   * partitions. No cross-partition transaction or simulated atomic rollback.
   * For facts/summary apply the appropriate tuple fence. Bind to real routes once
   * the pending content media takedown HTTP endpoint exists; never invent a route.
   * Retain appeal bytes under the content contract; no hidden purge. Final public
   * disclosure independently checks the current tuple-home fence reference.
   */
  takedown(source: Source, externalId: string, fieldGroup: string): Promise<void>;
  /**
   * Configure the real write-rate limit for the bulk importer's rate class through startup budget overrides. Windows
   * run on database statement time, so nowMs has no effect and waits are real. No Date patch, request-time header or
   * fake 429s. Commands resolve a fresh actor anchor on every attempt; kernel owns FIFO/serialization retries.
   */
  rateLimit(input: { requests: number; windowMs: number; nowMs: number }): Promise<void>;
  /**
   * Untouched production converter result plus extracted actual statement inputs;
   * no database/network access. Caller supplies actual resolved subject context.
   * Invoke the actual source function exactly, preserving source behavior/context.
   * raw includes the entire normalizedRecord/hash input, never a filtered footprint
   * or placeholder hash. Never turn bootstrap commands into fabricated statements.
   */
  convert(
    source: Source,
    record: unknown,
    converterRevision: string,
    context?: ConversionContext,
  ): Promise<{
    raw: unknown;
    statements: BatchStatement[];
  }>;
  /**
   * Performance-only setup: one deterministic method at ALL scales. May bulk-load
   * unrelated setup outside measurement; never bypass behavior in outcome tests.
   * Catalogue/importer keys and account/editorial history grow independently;
   * Counts are target totals. Include historical importer keys in the measured
   * source and unrelated sources, without changing its active one-record baseline.
   * Include unrelated semantic/auth/editorial history in the measured partition.
   * Seed records never share the measured key. Uses shared seed(growthDatabase,
   * population, range), Population grows hot partition AND rest. Repeated calls
   * grow to target totals and ANALYZE outside measurement; no approximate counts.
   */
  seed(input: { catalogueRecords: number; historyRows: number }): Promise<{
    /**
     * Private native-input fixture generator, returned by the sole seed method.
     * Distinct valid native IDs/revisions, bounded supported fields; no conversion,
     * derived outcomes, catalogue writes or context changes. Tests convert each.
     */
    unrelatedRecord(source: Source, ordinal: number): unknown;
  }>;
  /**
   * Mandatory shared growth.ts measure on growthDatabase (openGrowthDatabase),
   * retaining auto_explain rows/buffers/statements including Auth/Access/fence/receipts.
   * SQLite wraps actual Database prepare/query/run and executed Statement
   * get/all/iterate/run plus exec/transaction control. Count each execution once,
   * not preparation, and rows actually returned (including lazy iteration).
   * ANALYZE outside measurement at every scale; EXPLAIN QUERY PLAN outside
   * measurement for EVERY distinct executed SQL with its actual bound parameters.
   * Supply actual schema/index metadata and every growing read alias for the
   * indexed-key proof in test support. No status/FFI/VM/index-height estimates.
   * SQLite blocks:0 means unavailable buffers, not zero physical IO.
   * Account every operation in its actual phase, including bootstrap, later proposals,
   * nested journals/authorization/fences/receipts; no hidden setup or adapter work,
   * elapsed time or static proof. Preserve the shared N/U scales and M variation.
   * Reader counters include all parser invocations and bytes. Converter phase
   * retains only actual zero-attempt purity evidence, never computed work counters.
   */
  measure(action: () => Promise<void>): Promise<PhaseCounters>;
  close(): Promise<void>;
}
export interface DriverOptions {
  /** Test-configured production caps: B=8; M<=64; one record <=64 KiB. */
  batchRecords: 8;
  maxFields: 64;
  maxRecordBytes: 65536;
}
export type CreateImportApiDriver = (options: DriverOptions) => Promise<ImportApiDriver>;
