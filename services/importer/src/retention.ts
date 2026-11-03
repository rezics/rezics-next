import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, open, stat, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ImportSession, importOwnerIsBusy, type ImportOwnership } from './import-session.ts';
import { InspectionFailure, InspectionStore } from './inspection-store.ts';
import { RetentionFailure } from './retention-errors.ts';

export const RETENTION_PLAN_KIND = 'rezics-importer-generation-retention';
export const RETENTION_PLAN_VERSION = 1;
export const RETENTION_SCHEMA = 'importer-generation-retention-v1';
export const RETENTION_DEFAULT_PAGE = 20;
export const RETENTION_MAX_PAGE = 100;
export const RETENTION_MAX_SELECTED = 100;
export const RETENTION_DELETE_PAGE = 100;
export const RETENTION_LOCAL_MAINTENANCE =
  'Local importer history cleanup is in progress for this source. Finish the exact retention or retire-staging apply; this source cannot start or resume another capture until that plan completes.';
const MAX_PLAN_BYTES = 262_144;
const GENERATION_ID = /^[1-9][0-9]*$/u;
const SOURCE_ID = /^[a-z][a-z0-9_-]{0,31}$/u;
const PLAN_ID = /^[a-f0-9]{48}$/u;
const LIVE_STATUS = new Set(['staging', 'ready', 'finalizing']);
const TERMINAL_RETAINED = new Set(['abandoned', 'invalid-input', 'mass-disappearance']);
const REQUIRED_TABLES = [
  'run_sources',
  'run_generations',
  'run_entries',
  'run_acknowledged',
  'run_commands',
  'run_payloads',
  'run_envelopes',
] as const;
const KNOWN_RUN_ID_TABLES = new Set([
  'run_entries',
  'run_envelopes',
  'run_commands',
  'run_conversion_diagnostics',
  'run_conversion_diagnostic_records',
  'run_aggregate_operations',
  'run_staging_checkpoints',
  'run_staging_prefix',
  'run_disappearance_stops',
  'run_disappearance_missing',
  'vndb_table_runs',
  'vndb_table_rows',
  'vndb_table_spool',
  'vndb_acquisition_checkpoints',
  'vndb_acquisition_members',
]);
const DELETE_PHASES = [
  'envelopes',
  'commands',
  'diagnostics',
  'diagnostic_records',
  'aggregate_operations',
  'staging_prefix',
  'staging_checkpoints',
  'disappearance_missing',
  'disappearance_stops',
  'vndb_spool',
  'vndb_rows',
  'vndb_runs',
  'entries',
  'tombstone',
] as const;
export const RETENTION_DELETE_PHASES = DELETE_PHASES;
export type RetentionDeletePhase = (typeof DELETE_PHASES)[number];

export type RetentionCatalog = Readonly<{
  tables: ReadonlySet<string>;
  diagnosticRecordsColumn: boolean;
  userVersion: number;
}>;

export type RetentionPin = 'none' | 'baseline' | 'active';
export type RetentionEligibilityReason =
  | 'superseded-complete'
  | 'active-generation'
  | 'completed-baseline'
  | 'status-retained'
  | 'unresolved-pending'
  | 'deferred-cover'
  | 'inconsistent-accounting'
  | 'retirement-in-progress'
  | 'deliberately-retired'
  | 'unknown-status';

export type RetentionTableCounts = Readonly<{
  entries: number;
  envelopes: number;
  commands: number;
  diagnostics: number;
  diagnosticRecords: number;
  aggregateOperations: number;
  stagingCheckpoints: number;
  stagingPrefix: number;
  vndbRuns: number;
  vndbRows: number;
  vndbSpool: number;
}>;

export type RetentionGenerationRow = Readonly<{
  id: string;
  seq: number;
  status: string;
  pin: RetentionPin;
  eligible: boolean;
  reason: RetentionEligibilityReason;
  explanation: string;
  counts: RetentionTableCounts;
}>;

export type RetentionListDocument = Readonly<{
  version: 1;
  operation: 'list';
  source: string;
  sourceState: 'absent' | 'active' | 'baseline' | 'uninitialized';
  baseline: string | null;
  active: string | null;
  presentCount: number | null;
  sequence: number | null;
  ownershipRow: 'present' | 'absent' | 'unavailable';
  limit: number;
  end: 'end' | 'more';
  nextAfter?: string;
  generations: readonly RetentionGenerationRow[];
  preserved: readonly string[];
  sqliteNote: string;
  snapshot: string;
}>;

export type RetentionPlanDocument = Readonly<{
  version: 1;
  kind: typeof RETENTION_PLAN_KIND;
  planId: string;
  createdAt: string;
  state: Readonly<{ path: string; dev: number; ino: number; userVersion: number }>;
  source: string;
  schema: Readonly<{ compatibility: typeof RETENTION_SCHEMA; tables: readonly string[] }>;
  pins: Readonly<{
    baseline: string | null;
    active: string | null;
    presentCount: number;
    sequence: number;
    ownershipRow: 'present' | 'absent' | 'unavailable';
  }>;
  selected: readonly RetentionGenerationRow[];
  applyable: boolean;
  preserved: readonly string[];
  unavailable: readonly string[];
  sqliteNote: string;
  snapshot: string;
  apply: string;
}>;

export type RetentionApplyDocument = Readonly<{
  version: 1;
  operation: 'apply';
  status: 'complete' | 'cancelled';
  planId: string;
  source: string;
  retired: readonly string[];
  inProgress: readonly string[];
  sqliteNote: string;
  snapshot: string;
}>;

export type RetentionObserver = Readonly<{
  onDatabaseOpen?(path: string): void;
  beforePage?(input: { generation: string; phase: RetentionDeletePhase }): void;
}>;

export type RetentionOptions = Readonly<{
  signal?: AbortSignal;
  instrumentDatabase?: (database: Database) => Database;
  observer?: RetentionObserver;
  now?: () => Date;
  pageSize?: number;
}>;

const PRESERVED = [
  'run_sources sequence and current generation/present_count',
  'the active generation and its complete baseline snapshot',
  'run_members, run_acknowledged, run_reference_signatures and run_payloads',
  'record bindings, journals, candidates, media, observation heads and classification heads',
] as const;

const SQLITE_NOTE =
  'SQLite can reuse pages after DELETE; the state file size need not shrink. Retention never VACUUMs or compact-rewrites the database.';

function snapshotAdvice(statePath: string): string {
  return `A source-history plan may recommend the existing local snapshot command without making it a hidden backup workflow: bun services/importer/src/cli.ts backup --state ${JSON.stringify(statePath)} --output <snapshot-dir>`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RetentionFailure('Retention was cancelled.', 'cancelled');
}

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function admitSource(value: unknown): asserts value is string {
  if (typeof value !== 'string' || bytes(value) > 32 || !SOURCE_ID.test(value))
    throw new RetentionFailure('Source must be an exact configured source identifier.', 'usage');
}

function admitGenerationId(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    bytes(value) > 32 ||
    !GENERATION_ID.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new RetentionFailure('Generation must be a positive stored generation ID.', 'usage');
}

function admitPlanId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !PLAN_ID.test(value))
    throw new RetentionFailure('Plan confirmation must be the exact plan identity.', 'usage');
}

function exactObject(value: unknown, required: readonly string[], label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key))
  )
    throw new RetentionFailure(`Retention document ${label} has an unsupported shape.`, 'incompatible');
  return value as Record<string, unknown>;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw new RetentionFailure(`Malformed journal value: ${label} is not a bounded integer.`, 'incompatible');
  return value;
}

function tableExists(database: Database, name: string): boolean {
  return !!database.query('SELECT 1 AS found FROM sqlite_schema WHERE type=? AND name=?').get('table', name);
}

export function retentionCatalog(database: Database): RetentionCatalog {
  return {
    tables: new Set(
      (
        database.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {
          name: string;
        }[]
      ).map((row) => row.name),
    ),
    diagnosticRecordsColumn: tableColumns(database, 'run_generations').has('diagnostic_records'),
    userVersion: userVersion(database),
  };
}

function tableColumns(database: Database, name: string): Set<string> {
  return new Set(
    database
      .query(`PRAGMA table_info(${name})`)
      .all()
      .map((row) => (row as { name: string }).name),
  );
}

function countRows(database: Database, sql: string, ...args: (string | number)[]): number {
  const row = database.query(sql).get(...args) as { n: unknown } | null;
  return integer(row?.n ?? 0, 'count');
}

function existsFlag(database: Database, sql: string, ...args: string[]): boolean {
  const row = database.query(sql).get(...args) as { n: unknown } | null;
  const value = row?.n ?? 0;
  if (value !== 0 && value !== 1)
    throw new RetentionFailure('Malformed journal row: existence indicator is not boolean.', 'incompatible');
  return value === 1;
}

function optionalCount(
  database: Database,
  table: string,
  source: string,
  runId: string,
  tables: ReadonlySet<string>,
): number {
  if (!tables.has(table)) return 0;
  return countRows(database, `SELECT COUNT(*) AS n FROM ${table} WHERE source=? AND run_id=?`, source, runId);
}

const KNOWN_SAFE_TABLES = new Set([
  ...KNOWN_RUN_ID_TABLES,
  'run_sources',
  'run_generations',
  'run_members',
  'run_acknowledged',
  'run_reference_signatures',
  'run_payloads',
  'run_aggregate_heads',
  'run_retention_work',
  'import_owners',
  'binding_records',
  'binding_groups',
  'binding_journal',
  'binding_candidates',
  'binding_media',
  'binding_metadata_journal',
  'binding_metadata_current',
]);

function unknownPerRunTables(database: Database): string[] {
  const tables = database
    .query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  const unexpected: string[] = [];
  for (const { name } of tables) {
    if (KNOWN_SAFE_TABLES.has(name)) continue;
    const columns = tableColumns(database, name);
    if (columns.has('run_id')) unexpected.push(name);
  }
  return unexpected;
}

function requireKnownSchema(database: Database): string[] {
  for (const table of REQUIRED_TABLES) {
    if (!tableExists(database, table))
      throw new RetentionFailure(`Unsupported importer state schema: table ${table} is missing.`, 'incompatible');
  }
  const unexpected = unknownPerRunTables(database);
  if (unexpected.length)
    throw new RetentionFailure(
      `Unknown per-run table ${unexpected[0]} is present; report it to Imports rather than deleting unfamiliar data.`,
      'incompatible',
    );
  return database
    .query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

function generationSelect(catalog: RetentionCatalog): string {
  const diagnostic = catalog.diagnosticRecordsColumn ? 'diagnostic_records' : 'NULL AS diagnostic_records';
  return `SELECT id,seq,status,supplied,${diagnostic} FROM run_generations`;
}

function userVersion(database: Database): number {
  const row = database.query('PRAGMA user_version').get() as { user_version: unknown };
  return integer(row.user_version, 'user_version');
}

function ownershipRow(
  database: Database,
  source: string,
  tables?: ReadonlySet<string>,
): 'present' | 'absent' | 'unavailable' {
  if (tables ? !tables.has('import_owners') : !tableExists(database, 'import_owners')) return 'unavailable';
  return database.query('SELECT 1 AS found FROM import_owners WHERE source=? LIMIT 1').get(source)
    ? 'present'
    : 'absent';
}

function sourcePins(database: Database, source: string) {
  const row = database
    .query('SELECT source,sequence,lease_run,generation,present_count FROM run_sources WHERE source=?')
    .get(source) as {
    source: unknown;
    sequence: unknown;
    lease_run: unknown;
    generation: unknown;
    present_count: unknown;
  } | null;
  if (!row) {
    return {
      sourceState: 'absent' as const,
      baseline: null as string | null,
      active: null as string | null,
      presentCount: null as number | null,
      sequence: null as number | null,
    };
  }
  const sequence = integer(row.sequence, 'run_sources.sequence');
  const presentCount = integer(row.present_count, 'run_sources.present_count');
  const baseline = row.generation === null || row.generation === undefined ? null : String(row.generation);
  const active = row.lease_run === null || row.lease_run === undefined ? null : String(row.lease_run);
  if (baseline !== null) admitGenerationId(baseline);
  if (active !== null) admitGenerationId(active);
  return {
    sourceState: (active !== null ? 'active' : baseline !== null ? 'baseline' : 'uninitialized') as
      | 'active'
      | 'baseline'
      | 'uninitialized',
    baseline,
    active,
    presentCount,
    sequence,
  };
}

function generationCounts(
  database: Database,
  source: string,
  id: string,
  tables: ReadonlySet<string>,
): RetentionTableCounts {
  return {
    entries: countRows(database, 'SELECT COUNT(*) AS n FROM run_entries WHERE source=? AND run_id=?', source, id),
    envelopes: countRows(database, 'SELECT COUNT(*) AS n FROM run_envelopes WHERE source=? AND run_id=?', source, id),
    commands: countRows(database, 'SELECT COUNT(*) AS n FROM run_commands WHERE source=? AND run_id=?', source, id),
    diagnostics: optionalCount(database, 'run_conversion_diagnostics', source, id, tables),
    diagnosticRecords: optionalCount(database, 'run_conversion_diagnostic_records', source, id, tables),
    aggregateOperations: optionalCount(database, 'run_aggregate_operations', source, id, tables),
    stagingCheckpoints: optionalCount(database, 'run_staging_checkpoints', source, id, tables),
    stagingPrefix: optionalCount(database, 'run_staging_prefix', source, id, tables),
    vndbRuns: optionalCount(database, 'vndb_table_runs', source, id, tables),
    vndbRows: optionalCount(database, 'vndb_table_rows', source, id, tables),
    vndbSpool: optionalCount(database, 'vndb_table_spool', source, id, tables),
  };
}

function pendingWork(database: Database, source: string, id: string) {
  const pending = existsFlag(
    database,
    `SELECT EXISTS(SELECT 1 FROM run_envelopes INDEXED BY run_envelope_pending WHERE source=? AND run_id=? AND pending=1) AS n`,
    source,
    id,
  );
  const covers = existsFlag(
    database,
    `SELECT EXISTS(SELECT 1 FROM run_entries INDEXED BY run_cover_pending WHERE source=? AND run_id=? AND cover_pending=1) AS n`,
    source,
    id,
  );
  const remaining = existsFlag(
    database,
    `SELECT EXISTS(SELECT 1 FROM run_entries WHERE source=? AND run_id=? AND remaining>0) AS n`,
    source,
    id,
  );
  return { pending, covers, remaining };
}

function classifyGeneration(
  database: Database,
  source: string,
  row: { id: string; seq: number; status: string; supplied: number; diagnosticRecords: number | null },
  pins: { baseline: string | null; active: string | null },
  tables: ReadonlySet<string>,
): RetentionGenerationRow {
  const pin: RetentionPin = row.id === pins.active ? 'active' : row.id === pins.baseline ? 'baseline' : 'none';
  const counts = generationCounts(database, source, row.id, tables);
  const work = pendingWork(database, source, row.id);
  let reason: RetentionEligibilityReason;
  let explanation: string;
  if (row.status === 'retired') {
    reason = 'deliberately-retired';
    explanation = 'This generation is a permanent retirement tombstone; its per-run captures are already gone.';
  } else if (row.status === 'retiring') {
    reason = 'retirement-in-progress';
    explanation =
      'Retirement of this generation is already in progress for a local plan; finish that plan instead of selecting it again.';
  } else if (pin === 'active') {
    reason = 'active-generation';
    explanation = 'The live or recoverable generation stays pinned and cannot be retired.';
  } else if (pin === 'baseline') {
    reason = 'completed-baseline';
    explanation = 'The current complete baseline snapshot stays pinned and cannot be retired.';
  } else if (LIVE_STATUS.has(row.status) || TERMINAL_RETAINED.has(row.status)) {
    reason = 'status-retained';
    explanation = `Generations with status ${row.status} remain retained in this journey.`;
  } else if (row.status !== 'complete') {
    reason = 'unknown-status';
    explanation = 'The stored status is not a complete superseded capture; it is not inferred into eligibility.';
  } else if (work.pending) {
    reason = 'unresolved-pending';
    explanation = 'A supposedly complete generation still has pending envelopes; it is not repaired into eligibility.';
  } else if (work.covers) {
    reason = 'deferred-cover';
    explanation = 'A supposedly complete generation still has deferred covers; it is not repaired into eligibility.';
  } else if (work.remaining || counts.entries !== row.supplied) {
    reason = 'inconsistent-accounting';
    explanation =
      'Stored complete accounting disagrees with retained generation-local rows; it is not repaired into eligibility.';
  } else if (row.diagnosticRecords !== null && counts.diagnosticRecords !== row.diagnosticRecords) {
    reason = 'inconsistent-accounting';
    explanation =
      'Stored diagnostic-record counts disagree with the generation-local review keys; it is not repaired into eligibility.';
  } else {
    reason = 'superseded-complete';
    explanation =
      'This complete generation is not the current baseline or recoverable run and may be deliberately retired.';
  }
  return {
    id: row.id,
    seq: row.seq,
    status: row.status,
    pin,
    eligible: reason === 'superseded-complete',
    reason,
    explanation,
    counts,
  };
}

function emptyCounts(): RetentionTableCounts {
  return {
    entries: 0,
    envelopes: 0,
    commands: 0,
    diagnostics: 0,
    diagnosticRecords: 0,
    aggregateOperations: 0,
    stagingCheckpoints: 0,
    stagingPrefix: 0,
    vndbRuns: 0,
    vndbRows: 0,
    vndbSpool: 0,
  };
}

function mapInspectionFailure(error: unknown): never {
  if (error instanceof RetentionFailure) throw error;
  if (error instanceof InspectionFailure)
    throw new RetentionFailure(
      error.message,
      error.code === 130 ? 'cancelled' : error.code === 1 ? 'failed' : 'unsafe-file',
      error.code,
    );
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') throw new RetentionFailure('State file does not exist.', 'missing');
  if (code === 'ELOOP') throw new RetentionFailure('State path must not be a symbolic link.', 'unsafe-file');
  throw new RetentionFailure('Unable to open the importer state file.', 'unsafe-file');
}

async function openReadonly(statePath: string, options: RetentionOptions): Promise<InspectionStore> {
  throwIfAborted(options.signal);
  try {
    options.observer?.onDatabaseOpen?.(statePath);
    const store = await InspectionStore.open(statePath);
    return store;
  } catch (error) {
    mapInspectionFailure(error);
  }
}

function wrapDatabase(database: Database, options: RetentionOptions): Database {
  return options.instrumentDatabase?.(database) ?? database;
}

export async function listRetentionGenerations(
  input: { state: string; source: string; after?: string; limit?: number },
  options: RetentionOptions = {},
): Promise<RetentionListDocument> {
  admitSource(input.source);
  const limit = input.limit ?? RETENTION_DEFAULT_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > RETENTION_MAX_PAGE)
    throw new RetentionFailure('Page size must be an integer from 1 through 100.', 'usage');
  if (input.after !== undefined) admitGenerationId(input.after);
  const store = await openReadonly(input.state, options);
  try {
    throwIfAborted(options.signal);
    const database = wrapDatabase(store.database, options);
    return listRetentionOnDatabase(
      database,
      { source: input.source, limit, ...(input.after !== undefined ? { after: input.after } : {}) },
      retentionCatalog(database),
      store.path,
    );
  } finally {
    await store.close();
  }
}

export function listRetentionOnDatabase(
  database: Database,
  input: { source: string; after?: string; limit: number },
  catalog: RetentionCatalog,
  statePath: string,
): RetentionListDocument {
  const pins = sourcePins(database, input.source);
  const ownership = ownershipRow(database, input.source, catalog.tables);
  let afterSeq = 0;
  if (input.after !== undefined) {
    const prior = database
      .query('SELECT seq FROM run_generations WHERE source=? AND id=?')
      .get(input.source, input.after) as { seq: unknown } | null;
    if (!prior) throw new RetentionFailure('The --after generation does not exist for this source.', 'missing');
    afterSeq = integer(prior.seq, 'run_generations.seq', 1);
  }
  const rows = database
    .query(
      `${generationSelect(catalog)}
        WHERE source=? AND seq>? ORDER BY seq LIMIT ?`,
    )
    .all(input.source, afterSeq, input.limit + 1) as {
    id: unknown;
    seq: unknown;
    status: unknown;
    supplied: unknown;
    diagnostic_records: unknown;
  }[];
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit).map((row) => {
    const id = String(row.id);
    admitGenerationId(id);
    return classifyGeneration(
      database,
      input.source,
      {
        id,
        seq: integer(row.seq, 'run_generations.seq', 1),
        status: String(row.status),
        supplied: integer(row.supplied, 'run_generations.supplied'),
        diagnosticRecords:
          row.diagnostic_records === null || row.diagnostic_records === undefined
            ? null
            : integer(row.diagnostic_records, 'run_generations.diagnostic_records'),
      },
      pins,
      catalog.tables,
    );
  });
  const last = page.at(-1);
  return {
    version: 1,
    operation: 'list',
    source: input.source,
    sourceState: pins.sourceState,
    baseline: pins.baseline,
    active: pins.active,
    presentCount: pins.presentCount,
    sequence: pins.sequence,
    ownershipRow: ownership,
    limit: input.limit,
    end: hasMore ? 'more' : 'end',
    ...(hasMore && last ? { nextAfter: last.id } : {}),
    generations: page,
    preserved: PRESERVED,
    sqliteNote: SQLITE_NOTE,
    snapshot: snapshotAdvice(statePath),
  };
}

function selectedRows(
  database: Database,
  source: string,
  ids: readonly string[],
  pins: { baseline: string | null; active: string | null },
  catalog: RetentionCatalog,
): RetentionGenerationRow[] {
  if (ids.length === 0 || ids.length > RETENTION_MAX_SELECTED)
    throw new RetentionFailure('A retention plan names between 1 and 100 exact generation IDs.', 'usage');
  const seen = new Set<string>();
  const selected: RetentionGenerationRow[] = [];
  for (const id of ids) {
    admitGenerationId(id);
    if (seen.has(id)) throw new RetentionFailure('A retention plan cannot repeat a generation ID.', 'usage');
    seen.add(id);
    const row = database.query(`${generationSelect(catalog)} WHERE source=? AND id=?`).get(source, id) as {
      id: unknown;
      seq: unknown;
      status: unknown;
      supplied: unknown;
      diagnostic_records: unknown;
    } | null;
    if (!row) {
      selected.push({
        id,
        seq: 0,
        status: 'missing',
        pin: 'none',
        eligible: false,
        reason: 'unknown-status',
        explanation: 'No generation with this exact ID exists for the configured source.',
        counts: emptyCounts(),
      });
      continue;
    }
    selected.push(
      classifyGeneration(
        database,
        source,
        {
          id,
          seq: integer(row.seq, 'run_generations.seq', 1),
          status: String(row.status),
          supplied: integer(row.supplied, 'run_generations.supplied'),
          diagnosticRecords:
            row.diagnostic_records === null || row.diagnostic_records === undefined
              ? null
              : integer(row.diagnostic_records, 'run_generations.diagnostic_records'),
        },
        pins,
        catalog.tables,
      ),
    );
  }
  return selected;
}

export async function buildRetentionPlan(
  input: { state: string; source: string; generations: readonly string[]; output: string },
  options: RetentionOptions = {},
): Promise<RetentionPlanDocument> {
  admitSource(input.source);
  if (!input.output || !input.output.trim() || input.output === '-')
    throw new RetentionFailure('A retention plan requires --output <path>.', 'usage');
  const store = await openReadonly(input.state, options);
  let handle: FileHandle | undefined;
  try {
    throwIfAborted(options.signal);
    const database = wrapDatabase(store.database, options);
    const tables = requireKnownSchema(database);
    const catalog = retentionCatalog(database);
    const pins = sourcePins(database, input.source);
    if (pins.sourceState === 'absent')
      throw new RetentionFailure(`No source state exists for ${JSON.stringify(input.source)}.`, 'missing');
    const selected = selectedRows(database, input.source, input.generations, pins, catalog);
    const identity = await stat(store.path);
    const planId = randomBytes(24).toString('hex');
    const document: RetentionPlanDocument = {
      version: RETENTION_PLAN_VERSION,
      kind: RETENTION_PLAN_KIND,
      planId,
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      state: { path: store.path, dev: identity.dev, ino: identity.ino, userVersion: userVersion(database) },
      source: input.source,
      schema: { compatibility: RETENTION_SCHEMA, tables },
      pins: {
        baseline: pins.baseline,
        active: pins.active,
        presentCount: pins.presentCount ?? 0,
        sequence: pins.sequence ?? 0,
        ownershipRow: ownershipRow(database, input.source, catalog.tables),
      },
      selected,
      applyable: selected.every((row) => row.eligible),
      preserved: PRESERVED,
      unavailable: [
        'per-generation run_entries, run_envelopes, run_commands, run_conversion_diagnostics and run_conversion_diagnostic_records',
        'per-generation run_aggregate_operations when present',
        'per-generation run_staging_checkpoints and run_staging_prefix leftover after seal, when present',
        'per-generation run_disappearance_stops and run_disappearance_missing when present',
        'per-generation VNDB materialization rows when those tables exist',
      ],
      sqliteNote: SQLITE_NOTE,
      snapshot: snapshotAdvice(store.path),
      apply: `bun services/importer/src/cli.ts retention --state ${JSON.stringify(store.path)} --plan ${JSON.stringify(resolve(input.output))} --confirm ${planId} --apply`,
    };
    throwIfAborted(options.signal);
    const payload = `${JSON.stringify(document)}\n`;
    if (bytes(payload) > MAX_PLAN_BYTES)
      throw new RetentionFailure('Retention plan exceeds its stored bound.', 'failed');
    const output = resolve(input.output);
    try {
      handle = await open(output, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST')
        throw new RetentionFailure('Plan path already exists and will not be replaced.', 'unsafe-file');
      if (code === 'ELOOP') throw new RetentionFailure('Plan path must not be a symbolic link.', 'unsafe-file');
      throw new RetentionFailure('Unable to create an exclusive owner-only plan file.', 'unsafe-file');
    }
    const written = await handle.write(Buffer.from(payload, 'utf8'), 0, Buffer.byteLength(payload), 0);
    if (written.bytesWritten !== Buffer.byteLength(payload))
      throw new RetentionFailure('Plan file could not be written completely.', 'failed');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(output, 0o600);
    return document;
  } finally {
    await handle?.close().catch(() => {});
    await store.close();
  }
}

function parseSelected(value: unknown): RetentionGenerationRow[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > RETENTION_MAX_SELECTED
  )
    throw new RetentionFailure('Retention plan selected set is unsupported.', 'incompatible');
  return value.map((entry) => {
    const row = exactObject(
      entry,
      ['id', 'seq', 'status', 'pin', 'eligible', 'reason', 'explanation', 'counts'],
      'selected generation',
    );
    admitGenerationId(row.id);
    const counts = exactObject(
      row.counts,
      [
        'entries',
        'envelopes',
        'commands',
        'diagnostics',
        'diagnosticRecords',
        'aggregateOperations',
        'stagingCheckpoints',
        'stagingPrefix',
        'vndbRuns',
        'vndbRows',
        'vndbSpool',
      ],
      'selected counts',
    );
    return {
      id: row.id as string,
      seq: integer(row.seq, 'selected.seq'),
      status: String(row.status),
      pin: row.pin as RetentionPin,
      eligible: row.eligible === true,
      reason: row.reason as RetentionEligibilityReason,
      explanation: String(row.explanation),
      counts: {
        entries: integer(counts.entries, 'counts.entries'),
        envelopes: integer(counts.envelopes, 'counts.envelopes'),
        commands: integer(counts.commands, 'counts.commands'),
        diagnostics: integer(counts.diagnostics, 'counts.diagnostics'),
        diagnosticRecords: integer(counts.diagnosticRecords, 'counts.diagnosticRecords'),
        aggregateOperations: integer(counts.aggregateOperations, 'counts.aggregateOperations'),
        stagingCheckpoints: integer(counts.stagingCheckpoints, 'counts.stagingCheckpoints'),
        stagingPrefix: integer(counts.stagingPrefix, 'counts.stagingPrefix'),
        vndbRuns: integer(counts.vndbRuns, 'counts.vndbRuns'),
        vndbRows: integer(counts.vndbRows, 'counts.vndbRows'),
        vndbSpool: integer(counts.vndbSpool, 'counts.vndbSpool'),
      },
    };
  });
}

export async function readRetentionPlanFile(path: string): Promise<RetentionPlanDocument> {
  const resolved = resolve(path);
  let handle: FileHandle | undefined;
  try {
    handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const identity = await handle.stat();
    if (!identity.isFile()) throw new RetentionFailure('Plan path is not a regular file.', 'unsafe-file');
    if ((identity.mode & 0o077) !== 0)
      throw new RetentionFailure('Plan file must be owner-only (mode 0600).', 'unsafe-file');
    if (identity.size > MAX_PLAN_BYTES)
      throw new RetentionFailure('Plan file exceeds its stored bound.', 'incompatible');
    const buffer = Buffer.alloc(Number(identity.size));
    const read = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (read.bytesRead !== buffer.byteLength)
      throw new RetentionFailure('Plan file could not be read completely.', 'incompatible');
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString('utf8')) as unknown;
    } catch {
      throw new RetentionFailure('Plan file is not valid JSON.', 'incompatible');
    }
    const document = exactObject(
      parsed,
      [
        'version',
        'kind',
        'planId',
        'createdAt',
        'state',
        'source',
        'schema',
        'pins',
        'selected',
        'applyable',
        'preserved',
        'unavailable',
        'sqliteNote',
        'snapshot',
        'apply',
      ],
      'plan',
    );
    if (document.version !== 1 || document.kind !== RETENTION_PLAN_KIND)
      throw new RetentionFailure('Plan file is not a supported retention plan.', 'incompatible');
    admitPlanId(document.planId);
    admitSource(document.source);
    const state = exactObject(document.state, ['path', 'dev', 'ino', 'userVersion'], 'plan.state');
    const schema = exactObject(document.schema, ['compatibility', 'tables'], 'plan.schema');
    const pins = exactObject(
      document.pins,
      ['baseline', 'active', 'presentCount', 'sequence', 'ownershipRow'],
      'plan.pins',
    );
    if (schema.compatibility !== RETENTION_SCHEMA)
      throw new RetentionFailure('Plan schema compatibility does not match this importer.', 'stale');
    if (!Array.isArray(schema.tables) || !Array.isArray(document.preserved) || !Array.isArray(document.unavailable))
      throw new RetentionFailure('Plan file is not a supported retention plan.', 'incompatible');
    return {
      version: 1,
      kind: RETENTION_PLAN_KIND,
      planId: document.planId as string,
      createdAt: String(document.createdAt),
      state: {
        path: String(state.path),
        dev: integer(state.dev, 'state.dev'),
        ino: integer(state.ino, 'state.ino'),
        userVersion: integer(state.userVersion, 'state.userVersion'),
      },
      source: document.source as string,
      schema: { compatibility: RETENTION_SCHEMA, tables: schema.tables as string[] },
      pins: {
        baseline: pins.baseline === null ? null : (admitGenerationId(pins.baseline), pins.baseline as string),
        active: pins.active === null ? null : (admitGenerationId(pins.active), pins.active as string),
        presentCount: integer(pins.presentCount, 'pins.presentCount'),
        sequence: integer(pins.sequence, 'pins.sequence'),
        ownershipRow: pins.ownershipRow as RetentionPlanDocument['pins']['ownershipRow'],
      },
      selected: parseSelected(document.selected),
      applyable: document.applyable === true,
      preserved: document.preserved as string[],
      unavailable: document.unavailable as string[],
      sqliteNote: String(document.sqliteNote),
      snapshot: String(document.snapshot),
      apply: String(document.apply),
    };
  } catch (error) {
    if (error instanceof RetentionFailure) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new RetentionFailure('Plan file does not exist.', 'missing');
    if (code === 'ELOOP') throw new RetentionFailure('Plan path must not be a symbolic link.', 'unsafe-file');
    throw new RetentionFailure('Unable to read the retention plan file.', 'unsafe-file');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function openWritable(
  statePath: string,
  options: RetentionOptions,
): Promise<{
  path: string;
  database: Database;
  identity: { dev: number; ino: number };
  close(options?: { database?: boolean }): void;
}> {
  const path = resolve(statePath);
  let descriptor: FileHandle | undefined;
  let database: Database | undefined;
  try {
    descriptor = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const identity = await descriptor.stat();
    if (!identity.isFile()) throw new RetentionFailure('State path is not a regular file.', 'unsafe-file');
    const after = await stat(path);
    if (after.dev !== identity.dev || after.ino !== identity.ino)
      throw new RetentionFailure('State path changed while it was being opened.', 'unsafe-file');
    options.observer?.onDatabaseOpen?.(path);
    const opened = new Database(path, { create: false, strict: true });
    const afterOpen = await stat(path);
    if (afterOpen.dev !== identity.dev || afterOpen.ino !== identity.ino)
      throw new RetentionFailure('State path changed while it was being opened.', 'unsafe-file');
    database = wrapDatabase(opened, options);
    const handle = descriptor;
    descriptor = undefined;
    return {
      path,
      database,
      identity: { dev: identity.dev, ino: identity.ino },
      close(options?: { database?: boolean }) {
        try {
          if (options?.database !== false) database?.close();
        } finally {
          void handle.close();
        }
      },
    };
  } catch (error) {
    database?.close();
    await descriptor?.close().catch(() => {});
    if (error instanceof RetentionFailure) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') throw new RetentionFailure('State file does not exist.', 'missing');
    if (code === 'ELOOP') throw new RetentionFailure('State path must not be a symbolic link.', 'unsafe-file');
    if (error instanceof Error && /unable to open database|not a database|malformed/i.test(error.message))
      throw new RetentionFailure('State file is not a supported writable SQLite database.', 'incompatible');
    throw new RetentionFailure('Unable to open the importer state file for retention apply.', 'unsafe-file');
  }
}

function ensureRetentionWork(database: Database): void {
  database.exec(`CREATE TABLE IF NOT EXISTS run_retention_work (
    plan_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    selected_json TEXT NOT NULL,
    bound_json TEXT NOT NULL,
    status TEXT NOT NULL,
    generation_id TEXT NOT NULL DEFAULT '',
    phase TEXT NOT NULL DEFAULT '',
    cursor TEXT NOT NULL DEFAULT '',
    result_json TEXT,
    created_at TEXT NOT NULL
  ) WITHOUT ROWID`);
}

type WorkRow = {
  plan_id: string;
  source: string;
  selected_json: string;
  bound_json: string;
  status: string;
  generation_id: string;
  phase: string;
  cursor: string;
  result_json: string | null;
};

function workRow(database: Database, planId: string): WorkRow | null {
  return database.query('SELECT * FROM run_retention_work WHERE plan_id=?').get(planId) as WorkRow | null;
}

function phaseIndex(phase: string): number {
  const index = DELETE_PHASES.indexOf(phase as RetentionDeletePhase);
  if (index < 0) throw new RetentionFailure('Retention work cursor names an unknown deletion phase.', 'incompatible');
  return index;
}

function deletePage(
  database: Database,
  table: string,
  keySql: string,
  deleteSql: string,
  source: string,
  runId: string,
  cursor: string,
  pageSize: number,
  tables: ReadonlySet<string>,
): { cursor: string; done: boolean; deleted: number } {
  if (!tables.has(table)) return { cursor, done: true, deleted: 0 };
  const keys = database.query(keySql).all(source, runId, cursor, pageSize) as { key: string }[];
  for (const row of keys) database.query(deleteSql).run(source, runId, row.key);
  const last = keys.at(-1)?.key ?? cursor;
  return { cursor: last, done: keys.length < pageSize, deleted: keys.length };
}

function splitCursor(cursor: string): [string, string] {
  if (!cursor) return ['', ''];
  const split = cursor.indexOf('\u001f');
  if (split < 0) return [cursor, ''];
  return [cursor.slice(0, split), cursor.slice(split + 1)];
}

function runPhasePage(
  database: Database,
  source: string,
  runId: string,
  phase: RetentionDeletePhase,
  cursor: string,
  pageSize: number,
  tables: ReadonlySet<string>,
): { cursor: string; done: boolean; deleted: number } {
  switch (phase) {
    case 'envelopes': {
      if (!tables.has('run_envelopes')) return { cursor, done: true, deleted: 0 };
      const [record, envelopeText] = splitCursor(cursor);
      const envelope = envelopeText === '' ? -1 : Number(envelopeText);
      const rows = database
        .query(
          `SELECT record_key,envelope_index FROM run_envelopes
          WHERE source=? AND run_id=? AND (record_key,envelope_index)>(?,?)
          ORDER BY record_key,envelope_index LIMIT ?`,
        )
        .all(source, runId, record, envelope, pageSize) as { record_key: string; envelope_index: number }[];
      for (const row of rows)
        database
          .query('DELETE FROM run_envelopes WHERE source=? AND run_id=? AND record_key=? AND envelope_index=?')
          .run(source, runId, row.record_key, row.envelope_index);
      const last = rows.at(-1);
      return {
        cursor: last ? `${last.record_key}\u001f${last.envelope_index}` : cursor,
        done: rows.length < pageSize,
        deleted: rows.length,
      };
    }
    case 'commands':
      return deletePage(
        database,
        'run_commands',
        `SELECT command_key AS key FROM run_commands WHERE source=? AND run_id=? AND command_key>? ORDER BY command_key LIMIT ?`,
        'DELETE FROM run_commands WHERE source=? AND run_id=? AND command_key=?',
        source,
        runId,
        cursor,
        pageSize,
        tables,
      );
    case 'diagnostics': {
      if (!tables.has('run_conversion_diagnostics')) return { cursor, done: true, deleted: 0 };
      const [record, phaseName] = splitCursor(cursor);
      const rows = database
        .query(
          `SELECT record_key,phase FROM run_conversion_diagnostics
          WHERE source=? AND run_id=? AND (record_key,phase)>(?,?)
          ORDER BY record_key,phase LIMIT ?`,
        )
        .all(source, runId, record, phaseName, pageSize) as { record_key: string; phase: string }[];
      for (const row of rows)
        database
          .query('DELETE FROM run_conversion_diagnostics WHERE source=? AND run_id=? AND record_key=? AND phase=?')
          .run(source, runId, row.record_key, row.phase);
      const last = rows.at(-1);
      return {
        cursor: last ? `${last.record_key}\u001f${last.phase}` : cursor,
        done: rows.length < pageSize,
        deleted: rows.length,
      };
    }
    case 'diagnostic_records':
      return deletePage(
        database,
        'run_conversion_diagnostic_records',
        `SELECT record_key AS key FROM run_conversion_diagnostic_records WHERE source=? AND run_id=? AND record_key>? ORDER BY record_key LIMIT ?`,
        'DELETE FROM run_conversion_diagnostic_records WHERE source=? AND run_id=? AND record_key=?',
        source,
        runId,
        cursor,
        pageSize,
        tables,
      );
    case 'aggregate_operations':
      return deletePage(
        database,
        'run_aggregate_operations',
        `SELECT operation_id AS key FROM run_aggregate_operations WHERE source=? AND run_id=? AND operation_id>? ORDER BY operation_id LIMIT ?`,
        'DELETE FROM run_aggregate_operations WHERE source=? AND run_id=? AND operation_id=?',
        source,
        runId,
        cursor,
        pageSize,
        tables,
      );
    case 'staging_prefix': {
      if (!tables.has('run_staging_prefix')) return { cursor, done: true, deleted: 0 };
      const ordinal = cursor === '' ? -1 : Number(cursor);
      const rows = database
        .query(
          `SELECT ordinal FROM run_staging_prefix
          WHERE source=? AND run_id=? AND ordinal>?
          ORDER BY ordinal LIMIT ?`,
        )
        .all(source, runId, ordinal, pageSize) as { ordinal: number }[];
      for (const row of rows)
        database
          .query('DELETE FROM run_staging_prefix WHERE source=? AND run_id=? AND ordinal=?')
          .run(source, runId, row.ordinal);
      const last = rows.at(-1);
      return {
        cursor: last ? String(last.ordinal) : cursor,
        done: rows.length < pageSize,
        deleted: rows.length,
      };
    }
    case 'staging_checkpoints': {
      if (!tables.has('run_staging_checkpoints')) return { cursor, done: true, deleted: 0 };
      const changes = database
        .query('DELETE FROM run_staging_checkpoints WHERE source=? AND run_id=?')
        .run(source, runId);
      return { cursor: '', done: true, deleted: Number(changes.changes ?? 0) };
    }
    case 'disappearance_missing':
      return deletePage(
        database,
        'run_disappearance_missing',
        `SELECT record_key AS key FROM run_disappearance_missing WHERE source=? AND run_id=? AND record_key>? ORDER BY record_key LIMIT ?`,
        'DELETE FROM run_disappearance_missing WHERE source=? AND run_id=? AND record_key=?',
        source,
        runId,
        cursor,
        pageSize,
        tables,
      );
    case 'disappearance_stops': {
      if (!tables.has('run_disappearance_stops')) return { cursor, done: true, deleted: 0 };
      const changes = database
        .query('DELETE FROM run_disappearance_stops WHERE source=? AND run_id=?')
        .run(source, runId);
      return { cursor: '', done: true, deleted: Number(changes.changes ?? 0) };
    }
    case 'vndb_spool': {
      if (!tables.has('vndb_table_spool')) return { cursor, done: true, deleted: 0 };
      const [tableName, sequenceText] = splitCursor(cursor);
      const sequence = sequenceText === '' ? -1 : Number(sequenceText);
      const rows = database
        .query(
          `SELECT table_name,sequence FROM vndb_table_spool
          WHERE source=? AND run_id=? AND (table_name,sequence)>(?,?)
          ORDER BY table_name,sequence LIMIT ?`,
        )
        .all(source, runId, tableName, sequence, pageSize) as { table_name: string; sequence: number }[];
      for (const row of rows)
        database
          .query('DELETE FROM vndb_table_spool WHERE source=? AND run_id=? AND table_name=? AND sequence=?')
          .run(source, runId, row.table_name, row.sequence);
      const last = rows.at(-1);
      return {
        cursor: last ? `${last.table_name}\u001f${last.sequence}` : cursor,
        done: rows.length < pageSize,
        deleted: rows.length,
      };
    }
    case 'vndb_rows': {
      if (!tables.has('vndb_table_rows')) return { cursor, done: true, deleted: 0 };
      const parts = cursor ? cursor.split('\u001f') : ['', '', ''];
      const rows = database
        .query(
          `SELECT table_name,id,child FROM vndb_table_rows
          WHERE source=? AND run_id=? AND (table_name,id,child)>(?,?,?)
          ORDER BY table_name,id,child LIMIT ?`,
        )
        .all(source, runId, parts[0] ?? '', parts[1] ?? '', parts[2] ?? '', pageSize) as {
        table_name: string;
        id: string;
        child: string;
      }[];
      for (const row of rows)
        database
          .query('DELETE FROM vndb_table_rows WHERE source=? AND run_id=? AND table_name=? AND id=? AND child=?')
          .run(source, runId, row.table_name, row.id, row.child);
      const last = rows.at(-1);
      return {
        cursor: last ? `${last.table_name}\u001f${last.id}\u001f${last.child}` : cursor,
        done: rows.length < pageSize,
        deleted: rows.length,
      };
    }
    case 'vndb_runs': {
      if (!tables.has('vndb_table_runs')) return { cursor, done: true, deleted: 0 };
      const columns = database.query('PRAGMA table_info(vndb_table_runs)').all() as { name: string }[];
      const linked = columns.some((column) => column.name === 'materialized_generation')
        ? (database
            .query(`SELECT run_id FROM vndb_table_runs WHERE source=? AND materialized_generation=?`)
            .all(source, runId) as { run_id: string }[])
        : [];
      const ids = [runId, ...linked.map((row) => row.run_id)];
      let extra = 0;
      if (tables.has('vndb_acquisition_checkpoints'))
        for (const id of ids)
          extra += Number(
            database.query('DELETE FROM vndb_acquisition_checkpoints WHERE source=? AND run_id=?').run(source, id)
              .changes ?? 0,
          );
      if (tables.has('vndb_acquisition_members'))
        for (const id of ids)
          extra += Number(
            database.query('DELETE FROM vndb_acquisition_members WHERE source=? AND run_id=?').run(source, id)
              .changes ?? 0,
          );
      const changes = database.query('DELETE FROM vndb_table_runs WHERE source=? AND run_id=?').run(source, runId);
      return { cursor: '', done: true, deleted: Number(changes.changes ?? 0) + extra };
    }
    case 'entries':
      return deletePage(
        database,
        'run_entries',
        `SELECT record_key AS key FROM run_entries WHERE source=? AND run_id=? AND record_key>? ORDER BY record_key LIMIT ?`,
        'DELETE FROM run_entries WHERE source=? AND run_id=? AND record_key=?',
        source,
        runId,
        cursor,
        pageSize,
        tables,
      );
    case 'tombstone': {
      database
        .query(
          `UPDATE run_generations SET status=?, diagnostics_recorded=0, diagnostic_records=0, diagnostic_entries=0, cursor=?
          WHERE source=? AND id=? AND status=?`,
        )
        .run('retired', '', source, runId, 'retiring');
      return { cursor: '', done: true, deleted: 0 };
    }
  }
}

function revalidatePins(
  database: Database,
  plan: RetentionPlanDocument,
  source: string,
  catalog: RetentionCatalog,
): void {
  const pins = sourcePins(database, source);
  if (pins.baseline !== plan.pins.baseline || pins.active !== plan.pins.active)
    throw new RetentionFailure(
      'Observed baseline or recoverable generation changed; build a fresh explicit plan.',
      'stale',
    );
  if (pins.presentCount !== plan.pins.presentCount || pins.sequence !== plan.pins.sequence)
    throw new RetentionFailure(
      'Observed source sequence or present count changed; build a fresh explicit plan.',
      'stale',
    );
  if (catalog.userVersion !== plan.state.userVersion)
    throw new RetentionFailure('State schema version changed; build a fresh explicit plan.', 'stale');
}

function beginOrResumeWork(database: Database, plan: RetentionPlanDocument, catalog: RetentionCatalog): WorkRow {
  const existing = workRow(database, plan.planId);
  const selected = plan.selected.map((row) => row.id);
  if (existing) {
    if (existing.source !== plan.source || existing.selected_json !== JSON.stringify(selected))
      throw new RetentionFailure(
        'Stored retention work does not match this plan; build a fresh explicit plan.',
        'stale',
      );
    return existing;
  }
  for (const row of plan.selected) {
    const current = database.query(`${generationSelect(catalog)} WHERE source=? AND id=?`).get(plan.source, row.id) as {
      status: string;
      supplied: unknown;
      diagnostic_records: unknown;
    } | null;
    if (!current)
      throw new RetentionFailure(`Generation ${row.id} is no longer present; build a fresh explicit plan.`, 'stale');
    if (current.status === 'retired')
      throw new RetentionFailure(
        'A selected generation is already retired under a different outcome; build a fresh explicit plan.',
        'stale',
      );
    if (current.status === 'retiring')
      throw new RetentionFailure(
        'A selected generation is already retiring under another local plan; finish that plan.',
        'stale',
      );
    if (current.status !== 'complete' || !row.eligible)
      throw new RetentionFailure(
        'A selected generation is no longer an eligible superseded complete capture.',
        'ineligible',
      );
    const classified = classifyGeneration(
      database,
      plan.source,
      {
        id: row.id,
        seq: row.seq,
        status: current.status,
        supplied: integer(current.supplied, 'supplied'),
        diagnosticRecords:
          current.diagnostic_records === null || current.diagnostic_records === undefined
            ? null
            : integer(current.diagnostic_records, 'diagnostic_records'),
      },
      sourcePins(database, plan.source),
      catalog.tables,
    );
    if (!classified.eligible) throw new RetentionFailure(classified.explanation, 'ineligible');
  }
  const lease = randomBytes(24).toString('hex');
  for (const row of plan.selected) {
    database
      .query('UPDATE run_generations SET status=?, lease=? WHERE source=? AND id=? AND status=?')
      .run('retiring', lease, plan.source, row.id, 'complete');
  }
  database
    .query(
      `INSERT INTO run_retention_work(plan_id,source,selected_json,bound_json,status,generation_id,phase,cursor,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      plan.planId,
      plan.source,
      JSON.stringify(selected),
      JSON.stringify(plan.pins),
      'applying',
      selected[0]!,
      DELETE_PHASES[0],
      '',
      plan.createdAt,
    );
  return workRow(database, plan.planId)!;
}

export async function applyRetentionPlan(
  input: { state: string; plan: string; confirm: string },
  options: RetentionOptions = {},
): Promise<RetentionApplyDocument> {
  admitPlanId(input.confirm);
  const plan = await readRetentionPlanFile(input.plan);
  if (plan.planId !== input.confirm)
    throw new RetentionFailure(
      'Apply requires the current plan identity as --confirm; the selected set is never expanded.',
      'usage',
    );
  if (!plan.applyable)
    throw new RetentionFailure(
      'This plan includes ineligible generations; build a fresh explicit plan of eligible captures.',
      'ineligible',
    );
  let opened: Awaited<ReturnType<typeof openWritable>> | undefined;
  let session: ImportSession | undefined;
  try {
    throwIfAborted(options.signal);
    opened = await openWritable(input.state, options);
    if (opened.identity.dev !== plan.state.dev || opened.identity.ino !== plan.state.ino)
      throw new RetentionFailure('State file identity does not match the plan; build a fresh explicit plan.', 'stale');
    const database = opened.database;
    requireKnownSchema(database);
    session = new ImportSession(database);
    const ownership = session.acquire(plan.source);
    if (ownership === 'busy') throw new RetentionFailure('A live or uninspectable owner holds this source.', 'busy');
    try {
      return applyRetentionOnDatabase(
        database,
        plan,
        session,
        ownership,
        opened.path,
        retentionCatalog(database),
        options,
      );
    } finally {
      session.release(ownership);
    }
  } catch (error) {
    if (error instanceof RetentionFailure && error.kind === 'cancelled') {
      return {
        version: 1,
        operation: 'apply',
        status: 'cancelled',
        planId: plan.planId,
        source: plan.source,
        retired: [],
        inProgress: plan.selected.map((row) => row.id),
        sqliteNote: SQLITE_NOTE,
        snapshot: snapshotAdvice(opened?.path ?? plan.state.path),
      };
    }
    throw error;
  } finally {
    session?.close();
    opened?.close({ database: session === undefined });
  }
}

export function applyRetentionOnDatabase(
  database: Database,
  plan: RetentionPlanDocument,
  session: ImportSession,
  ownership: ImportOwnership,
  statePath: string,
  catalog: RetentionCatalog,
  options: RetentionOptions = {},
): RetentionApplyDocument {
  const pageSize = options.pageSize ?? RETENTION_DELETE_PAGE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > RETENTION_MAX_PAGE)
    throw new RetentionFailure('Deletion page size must be an integer from 1 through 100.', 'usage');
  const started = database
    .transaction(() => {
      session.assertHeld(ownership);
      if (!catalog.tables.has('run_retention_work')) ensureRetentionWork(database);
      const existing = workRow(database, plan.planId);
      if (existing?.status === 'complete') return existing;
      revalidatePins(database, plan, plan.source, catalog);
      return beginOrResumeWork(database, plan, catalog);
    })
    .immediate();
  if (started.status === 'complete') {
    const retired = started.result_json
      ? (JSON.parse(started.result_json) as { retired: string[] }).retired
      : plan.selected.map((row) => row.id);
    return {
      version: 1,
      operation: 'apply',
      status: 'complete',
      planId: plan.planId,
      source: plan.source,
      retired,
      inProgress: [],
      sqliteNote: SQLITE_NOTE,
      snapshot: snapshotAdvice(statePath),
    };
  }
  let generationId = started.generation_id;
  let phase = started.phase as RetentionDeletePhase;
  let cursor = started.cursor;
  const selected = plan.selected.map((row) => row.id);
  while (generationId) {
    throwIfAborted(options.signal);
    options.observer?.beforePage?.({ generation: generationId, phase });
    throwIfAborted(options.signal);
    const advanced = database
      .transaction(() => {
        session.assertHeld(ownership);
        revalidatePins(database, plan, plan.source, catalog);
        const current = workRow(database, plan.planId);
        if (!current || current.status !== 'applying')
          throw new RetentionFailure('Retention work is no longer the applying local plan.', 'stale');
        const page = runPhasePage(database, plan.source, generationId, phase, cursor, pageSize, catalog.tables);
        let nextGeneration = generationId;
        let nextPhase = phase;
        let nextCursor = page.cursor;
        if (page.done) {
          const nextIndex = phaseIndex(phase) + 1;
          if (nextIndex < DELETE_PHASES.length) {
            nextPhase = DELETE_PHASES[nextIndex]!;
            nextCursor = '';
          } else {
            const position = selected.indexOf(generationId);
            const following = selected[position + 1] ?? '';
            nextGeneration = following;
            nextPhase = DELETE_PHASES[0]!;
            nextCursor = '';
          }
        }
        const complete = !nextGeneration;
        database
          .query(
            `UPDATE run_retention_work SET generation_id=?, phase=?, cursor=?, status=?, result_json=? WHERE plan_id=? AND status=?`,
          )
          .run(
            nextGeneration,
            complete ? '' : nextPhase,
            complete ? '' : nextCursor,
            complete ? 'complete' : 'applying',
            complete ? JSON.stringify({ retired: selected }) : null,
            plan.planId,
            'applying',
          );
        return { nextGeneration, nextPhase, nextCursor, complete };
      })
      .immediate();
    if (advanced.complete) {
      return {
        version: 1,
        operation: 'apply',
        status: 'complete',
        planId: plan.planId,
        source: plan.source,
        retired: selected,
        inProgress: [],
        sqliteNote: SQLITE_NOTE,
        snapshot: snapshotAdvice(statePath),
      };
    }
    generationId = advanced.nextGeneration;
    phase = advanced.nextPhase;
    cursor = advanced.nextCursor;
  }
  return {
    version: 1,
    operation: 'apply',
    status: 'complete',
    planId: plan.planId,
    source: plan.source,
    retired: selected,
    inProgress: [],
    sqliteNote: SQLITE_NOTE,
    snapshot: snapshotAdvice(statePath),
  };
}

export function inspectOwnerBusy(owner: { pid: number; birth: string }): boolean {
  return importOwnerIsBusy(owner);
}

export {
  SQLITE_NOTE as RETENTION_SQLITE_NOTE,
  snapshotAdvice as retentionSnapshotAdvice,
  sourcePins as retentionSourcePins,
  ownershipRow as retentionOwnershipRow,
  requireKnownSchema as assertRetentionKnownSchema,
  ensureRetentionWork,
  workRow as retentionWorkRow,
  runPhasePage as runRetentionDeletePhase,
  openReadonly as openRetentionReadonly,
  openWritable as openRetentionWritable,
  throwIfAborted as throwIfRetentionAborted,
  admitSource as admitRetentionSource,
  admitGenerationId as admitRetentionGenerationId,
  admitPlanId as admitRetentionPlanId,
  exactObject as exactRetentionObject,
  integer as retentionInteger,
  countRows as retentionCountRows,
  existsFlag as retentionExistsFlag,
  optionalCount as retentionOptionalCount,
  userVersion as retentionUserVersion,
  PRESERVED as RETENTION_PRESERVED,
  MAX_PLAN_BYTES as RETENTION_MAX_PLAN_BYTES,
};
