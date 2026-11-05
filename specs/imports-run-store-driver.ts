/**
 * TEST ONLY. IMPORT_RUN_STORE_DRIVER exports createImportRunStoreDriver.
 * Bind actual importer-owned durable run operations, forwarding without parsing,
 * conversion, reconciliation, fence lookup, transport, or cached outcomes here.
 * No kernel/catalogue writes. Commands below are validated storage inputs, not
 * converter outcomes. RecordStore remains independent acknowledged metadata.
 *
 * All handles point into directory; close flushes/closes, never deletes a lease.
 * reopen(resume) reclaims that exact run using its durable capability, rotates
 * the lease token, and fences old handles, even on a second open connection.
 * begin without that capability stays busy until finalize or explicit abandon.
 * abandon is allowed before command preparation only; prepared work must resume.
 * Invalid parsing (reported by orchestration to seal) or duplicate staging makes
 * the generation unusable, releases its lease, discards its staged proposals,
 * and never changes baseline/acknowledged metadata. A mass-disappearance
 * rejection is likewise terminal and releases its lease. A failed generation is never
 * a later baseline. Empty initial input is valid; losing all prior keys is not.
 *
 * stage is one indexed source/run/key insert plus current source/key lookup.
 * projection is caller-sanitized normalized data; raw source input is NEVER an
 * argument. Native absent revision is literally unversioned, never a timestamp.
 * seal uses maintained prior/seen-survivor counters, not COUNT/history queries.
 * A mass-disappearance complete seal snapshots missing identities with one
 * `run_missing` INSERT...SELECT plus a stop header before release; that write
 * is generation-scoped evidence, not a page, native effect or approval of loss.
 * No pending command is visible before successful seal. classify compares actual
 * staged/current metadata and atomically persists typed command bytes and keys
 * before returning. Identical metadata/projection must not fabricate a revision.
 * Fence decisions are supplied by orchestration: only explicit fenced omissions
 * with a non-null opaque string security revision discharge a group, never an
 * unfenced rejection. Preserve the supplied revision exactly, without coercion.
 *
 * pagePending returns immutable per-record request envelopes (at most 100
 * commands/65536 UTF-8 bytes), including all original keys; partially resolved
 * envelopes replay their original bytes, while fully resolved ones disappear;
 * retries/reopen must not reserialize/recompute them from new source input.
 * acknowledge consumes actual per-command transport results; absent/rejected
 * keys remain pending. Per-record acknowledged metadata may advance when all
 * its groups resolve. Full baseline remains previous until ALL expected records,
 * vanished records and groups resolve. finalize is bounded/restartable and
 * idempotent; each call processes at most pageCap keys, never all history.
 *
 * pageVanished is exact source+generation, ordered keyset (exclusive after), cap
 * <=100. It excludes unrelated sources and failed/incomplete staged history.
 * Generation-seen markers on current membership or equivalent bounded indexes
 * are allowed. No source/history reset scan, OFFSET, COUNT, unbounded anti-join,
 * or scan to derive missing keys. Total reconciliation is one supplied S pass
 * and D changed/vanished keys, with bounded page memory, not accumulated U*t.
 */
import type { BatchCommand, BatchStatement, BatchWriteResult, FieldGroup } from '@rezics/definitions/bulk';
import type { RecordRow } from '../services/importer/src/record-store.ts';

export const MISSING_RUN_STORE_DRIVER = 'IMPORT_RUN_STORE_DRIVER is required: bind real durable importer run state';
export const CAPS = {
  sourceBytes: 64,
  keyBytes: 512,
  projectionBytes: 65536,
  pendingBytes: 65536,
  commands: 100,
  page: 100,
} as const;
export interface Run {
  source: string;
  id: string;
  lease: string;
}
export interface Staged {
  row: RecordRow;
  projection: BatchStatement[];
}
export interface Omission {
  field_group: FieldGroup;
  disposition: 'fenced';
  securityRevision: string;
}
export type Seal = {
  status: 'ready' | 'invalid-input' | 'mass-disappearance';
  prior: number;
  seenSurvivors: number;
  supplied: number;
  diagnostic: string;
};
export interface Pending {
  after: string;
  recordKey: string;
  bytes: string;
  keys: string[];
}
export interface SourceView {
  generation: string | null;
  count: number;
}
export interface KeyView {
  baseline: RecordRow | null;
  acknowledged: RecordRow | null;
  staged: Staged | null;
  omissions: Omission[];
}
export interface RunStoreDriver {
  close(): Promise<void>;
  /** No implicit timeout takeover. Invalid thresholds must reject before leasing. */
  begin(source: string, options?: { disappearanceThreshold?: number }): Promise<Run | 'busy'>;
  reopen(resume: Run): Promise<Run>;
  abandon(run: Run): Promise<'abandoned' | 'pending-work'>;
  stage(run: Run, record: Staged): Promise<void>;
  /** Parse errors are reported only by the real caller, not parsed in this store. */
  seal(run: Run, input: { complete: true } | { complete: false; reason: 'malformed' | 'truncated' }): Promise<Seal>;
  classify(
    run: Run,
    key: string,
    input: { commands: BatchCommand[]; omissions?: Omission[] },
  ): Promise<'new' | 'changed' | 'unchanged' | 'vanished'>;
  pagePending(run: Run, page: { after?: string; limit: number }): Promise<Pending[]>;
  pageVanished(run: Run, page: { after?: string; limit: number }): Promise<RecordRow[]>;
  acknowledge(run: Run, result: BatchWriteResult): Promise<void>;
  finalize(run: Run, pageCap: number): Promise<'incomplete' | 'more' | 'complete'>;
  source(source: string): Promise<SourceView>;
  key(source: string, key: string, run?: Run): Promise<KeyView>;
  /** Complete logical dump of ALL importer tables/columns, for allowlist/privacy inspection only. */
  persisted(): Promise<unknown>;
  /** Actual SQLite wrapping evidence, not onStatement callbacks or supplied flags. */
  measure<T>(operation: () => Promise<T>): Promise<{ value: T; evidence: Evidence }>;
  /** Execute ANALYZE on every state database outside measurement. */
  analyze(): Promise<void>;
}
export type CreateImportRunStoreDriver = (options: { directory: string }) => Promise<RunStoreDriver>;

/**
 * The binding may use future services/importer/tests/support/sqlite-growth.
 * Wrap ALL actual Database prepare/query/run/exec and executed Statement
 * get/all/iterate/run, including transaction controls and lazy iterator rows.
 * Count executions once, not preparations. Capture even on operation rejection.
 * No VM/fullscan/index-step/FFI counters. rows = actual rows delivered to caller.
 * Summaries count SQLite statements and returned rows; buffer IO is not observed.
 * EXPLAIN every distinct SQL AND actual binding after ANALYZE at EVERY scale,
 * outside measurement. No fabricated counters, empty capture, or static flags.
 * Schema is raw sqlite_schema plus PRAGMA index_list/index_info/table_info
 * introspection, includes every growing relation, including bounded-per-key
 * history tables whose aggregate size grows. Do not exempt an UPDATE/DELETE or
 * SELECT by spelling; only exact keyed VALUES inserts and controls can lack a
 * readable plan. Include aliases for every growing relation occurrence.
 */
export type Parameter = string | number | bigint | null | Uint8Array;
export interface Relation {
  table: string;
  createSql: string;
  indexes: { name: string; columns: string[]; unique: boolean; origin: 'pk' | 'u' | 'c'; createSql: string | null }[];
  integerPrimaryKey?: string;
}
export interface Execution {
  database: string;
  sql: string;
  parameters: Parameter[] | Record<string, Parameter>;
  rows: number;
  plan: { id: number; parent: number; notused: number; detail: string }[];
  reads: { table: string; alias: string }[];
  kind: 'readable' | 'keyed-insert' | 'control';
}
export interface Evidence {
  /** Raw actually executed ANALYZE statements, not a boolean. */
  analysis: { database: string; sql: string }[];
  schema: { database: string; relations: Relation[] }[];
  executions: Execution[];
}

export type RunStoreCounts = { 'sqlite returned rows': number; 'sqlite statements': number };

/** Indexed-plan proof shared by the executable scenarios; never a product flag. */
export function runStoreCounts(evidence: Evidence, pageCap: number = CAPS.page): RunStoreCounts {
  function requireProof(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(`Run-store SQLite evidence: ${message}`);
  }
  requireProof(evidence.executions.length > 0, 'actual executions are required');
  let rows = 0;
  for (const execution of evidence.executions) {
    const { sql, plan, database } = execution;
    requireProof(Number.isSafeInteger(execution.rows) && execution.rows >= 0, 'invalid actual returned rows');
    rows += execution.rows;
    requireProof(!/\b(?:OFFSET|COUNT\s*\()/i.test(sql), 'OFFSET/historical COUNT is forbidden');
    requireProof(
      evidence.analysis.some((a) => a.database === database && /^\s*ANALYZE(?:\s|;|$)/i.test(a.sql)),
      'missing actual ANALYZE for database',
    );
    const schema = evidence.schema.find((s) => s.database === database);
    requireProof(schema && schema.relations.length > 0, 'missing actual growing schema');
    const relations = schema!.relations;
    for (const relation of relations) {
      requireProof(/^\s*CREATE\s+TABLE\b/i.test(relation.createSql), 'missing sqlite_schema table SQL');
      requireProof(relation.indexes.length > 0 || relation.integerPrimaryKey, 'missing index introspection');
    }
    if (execution.kind === 'control') {
      requireProof(
        /^\s*(?:BEGIN(?:\s+(?:IMMEDIATE|DEFERRED|EXCLUSIVE))?(?:\s+TRANSACTION)?|(?:COMMIT|END)(?:\s+TRANSACTION)?|ROLLBACK(?:\s+TRANSACTION)?(?:\s+TO\s+(?:SAVEPOINT\s+)?\S+)?|SAVEPOINT\s+\S+|RELEASE\s+(?:SAVEPOINT\s+)?\S+)\s*;?\s*$/i.test(
          sql,
        ),
        'non-control exempted from plans',
      );
      requireProof(
        execution.rows === 0 && execution.reads.length === 0 && plan.length === 0,
        'control has hidden work',
      );
      continue;
    }
    if (execution.kind === 'keyed-insert') {
      // Only direct VALUES inserts may have no readable relation plan. UPSERT
      // does not exempt a SELECT, UPDATE/DELETE statement or a source scan.
      const insert = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["`\[]?(\w+)["`\]]?\s*\(([^)]+)\)\s*VALUES\s*\(/i.exec(sql);
      requireProof(insert && !/\bSELECT\b/i.test(sql), 'non-VALUES insert exempted from plans');
      const relation = relations.find((r) => r.table === insert![1]);
      requireProof(relation, 'insert relation absent from introspection');
      const columns = insert![2]!.split(',').map((c) => c.trim().replace(/["`\[\]]/g, ''));
      requireProof(
        relation!.indexes.some((i) => i.unique && i.columns.every((c) => columns.includes(c))) ||
          (relation!.integerPrimaryKey && columns.includes(relation!.integerPrimaryKey)),
        'insert has no exact declared key',
      );
      requireProof(execution.reads.length === 0 && plan.length === 0, 'readable insert must supply a plan');
      continue;
    }
    requireProof(
      execution.kind === 'readable' && plan.length > 0 && execution.reads.length > 0,
      'readable SQL lacks raw EXPLAIN/relations',
    );
    const details = plan.map((p) => p.detail).join('\n');
    // All persisted importer relations are part of the growing schema. Inspect
    // every raw node too, so an omitted self-join alias cannot conceal a scan.
    requireProof(
      plan.every((p) => !/\bSCAN\b/i.test(p.detail) || /\bSCAN CONSTANT ROWS?\b/i.test(p.detail)),
      'growing relation/index SCAN',
    );
    requireProof(!/AUTOMATIC|USE TEMP B-TREE/i.test(details), 'automatic index or growing temporary sort');
    for (const relation of relations) {
      const names = [
        relation.table,
        ...relation.indexes.map((i) => i.name),
        ...execution.reads.filter((r) => r.table === relation.table).map((r) => r.alias),
      ];
      for (const name of names) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        requireProof(
          !new RegExp(`\\bSCAN\\s+(?:TABLE\\s+)?${escaped}(?:\\s|$)`, 'i').test(details),
          `growing relation/index SCAN: ${name}`,
        );
      }
      // SQL spelling is additional evidence, never an exemption from a plan.
      // INSERT destinations are writes; only FROM/JOIN/UPDATE relations must appear in reads.
      const escaped = relation.table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const insertTarget = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["`\[]?(\w+)/i.exec(sql)?.[1];
      if (
        relation.table !== insertTarget &&
        new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO)\\s+["\x60\\[]?${escaped}(?:["\x60\\]]|\\s|$)`, 'i').test(sql)
      ) {
        requireProof(
          execution.reads.some((r) => r.table === relation.table),
          'growing relation omitted from read proof',
        );
      }
    }
    for (const read of execution.reads) {
      const relation = relations.find((r) => r.table === read.table);
      requireProof(relation, 'read relation absent from schema');
      const node = plan.find((p) =>
        new RegExp(`^SEARCH ${read.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} USING `, 'i').test(p.detail),
      );
      requireProof(node, `missing indexed SEARCH for ${read.alias}`);
      const access = /USING (?:COVERING )?(?:INDEX ([^ ]+)|INTEGER PRIMARY KEY|PRIMARY KEY) \((.+)\)/i.exec(
        node!.detail,
      );
      requireProof(access, 'SEARCH lacks explicit equality/range prefix');
      const constraints = access![2]!;
      const equality = (column: string) =>
        new RegExp(`(?:^| AND )${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=\\?`, 'i').test(constraints);
      const index = access![1]
        ? relation!.indexes.find((i) => i.name === access![1])
        : relation!.indexes.find((i) => i.origin === 'pk');
      const integer = /INTEGER PRIMARY KEY/i.test(node!.detail) && relation!.integerPrimaryKey;
      requireProof(integer || index, 'SEARCH does not use a declared index/primary key');
      const point = integer
        ? /(?:rowid|INTEGER PRIMARY KEY)=\?/i.test(constraints) || equality(relation!.integerPrimaryKey!)
        : index!.unique && index!.columns.every(equality);
      requireProof(!integer || point, 'integer primary key must be an exact seek');
      if (!point) {
        // A source-prefix SEARCH alone still permits a whole source scan. A
        // page requires an anchored multi-column prefix, key range and LIMIT.
        // Mass-disappearance evidence copies the exact missing prefix in one
        // INSERT...SELECT; the bound is that prefix, not a caller page.
        const missingSnapshot =
          /^\s*INSERT\s+INTO\s+run_disappearance_missing\b/i.test(sql) &&
          /\bINDEXED BY run_missing\b/i.test(sql) &&
          index!.name === 'run_missing';
        requireProof(index!.columns.length >= 2 && equality(index!.columns[0]!), 'page lacks equality anchor');
        if (!missingSnapshot) {
          requireProof(/\bLIMIT\s+(?:\?|[:@$]\w+|\d+)/i.test(sql), 'non-point access lacks bounded indexed keyset');
          requireProof(execution.rows <= pageCap, 'page exceeds caller cap');
        }
        const constrained = index!.columns.filter((c) =>
          new RegExp(`(?:^| AND )${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[=<>]`, 'i').test(constraints),
        );
        requireProof(constrained.length >= 2, 'page lacks source/generation or cursor prefix');
      }
    }
  }
  return { 'sqlite returned rows': rows, 'sqlite statements': evidence.executions.length };
}
