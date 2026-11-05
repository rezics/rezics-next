import type { Database } from 'bun:sqlite';
import { importOwnerIsBusy } from './import-session.ts';
import { StateBackupFailure } from './state-backup-errors.ts';

export const SNAPSHOT_FORMAT = 'rezics-importer-stopped-state';
export const SNAPSHOT_FORMAT_VERSION = 1;
export const SCHEMA_COMPATIBILITY = 'importer-required-tables-v1';
const MAX_SUMMARY_SOURCES = 32;
const MAX_SOURCE_CHARS = 64;
const MAX_GENERATION_CHARS = 32;
const MAX_STATUS_CHARS = 32;
const OWNER_PAGE = 32;

export const REQUIRED_TABLES: Record<string, readonly string[]> = {
  import_owners: ['source', 'pid', 'birth', 'capability'],
  run_sources: ['source', 'sequence', 'lease_run', 'generation', 'present_count'],
  run_generations: [
    'source',
    'id',
    'seq',
    'lease',
    'status',
    'threshold',
    'prior',
    'supplied',
    'survivors',
    'invalid',
    'classified',
    'resolved',
    'expected',
    'changed',
    'prepared',
    'cursor',
    'skipped',
  ],
  run_entries: [
    'source',
    'run_id',
    'record_key',
    'row_json',
    'projection_json',
    'kind',
    'resolved',
    'bytes',
    'keys_json',
    'omissions_json',
    'pending',
    'remaining',
    'cover_pending',
  ],
  run_members: ['source', 'record_key', 'active', 'seen', 'row_json'],
  run_acknowledged: ['source', 'record_key', 'row_json', 'projection_json'],
  run_commands: ['source', 'run_id', 'command_key', 'record_key', 'field_group', 'op', 'envelope_index', 'done'],
  run_payloads: ['source', 'command_key', 'body'],
  run_envelopes: [
    'source',
    'run_id',
    'record_key',
    'envelope_index',
    'multi',
    'bytes',
    'keys_json',
    'remaining',
    'pending',
  ],
  binding_records: ['source', 'external_id', 'state', 'subject', 'bootstrap_key', 'candidate_count', 'cover_key'],
  binding_groups: ['source', 'external_id', 'field_group', 'candidate_count'],
  binding_journal: ['source', 'external_id', 'key', 'bytes', 'signature', 'acknowledgement'],
  binding_candidates: ['source', 'external_id', 'field_group', 'candidate', 'subject', 'key', 'bytes', 'signature'],
  binding_media: ['source', 'external_id', 'key', 'bytes', 'signature', 'accepted', 'status'],
  binding_metadata_journal: ['source', 'external_id', 'key', 'bytes', 'signature', 'acknowledgement'],
  binding_metadata_current: ['source', 'external_id', 'key'],
};

const REQUIRED_INDEXES = [
  ['run_envelope_pending', 'run_envelopes'],
  ['run_cover_pending', 'run_entries'],
] as const;

/** Additive destination binding. Missing on legacy snapshots; present rows are preserved byte-for-byte. */
const OPTIONAL_TABLES: Record<string, readonly string[]> = {
  source_destinations: ['source', 'origin', 'provenance', 'schema_version'],
  run_aggregate_operations: [
    'source',
    'run_id',
    'operation_id',
    'record_key',
    'subject_id',
    'provider',
    'source_alias',
    'source_record_id',
    'kind',
    'command_key',
    'request_bytes',
    'intended_json',
    'status',
  ],
  run_aggregate_heads: ['source', 'subject_id', 'provider', 'digest', 'head_json'],
  run_classification_heads: ['source', 'subject_id', 'association_key', 'digest', 'head_json'],
};

export type RunBaseline = Readonly<{
  source: string;
  activeGeneration: string | null;
  baselineGeneration: string | null;
  status: string | null;
  presentCount: number;
  ownerRow: 'absent' | 'stopped';
}>;

export type SnapshotManifest = Readonly<{
  version: typeof SNAPSHOT_FORMAT_VERSION;
  format: typeof SNAPSHOT_FORMAT;
  createdAt: string;
  sqliteCompatibility: Readonly<{ pageSize: number; pageCount: number; userVersion: number }>;
  schemaCompatibility: typeof SCHEMA_COMPATIBILITY;
  content: Readonly<{ file: 'importer-state.sqlite'; bytes: number; sha256: string }>;
  runs: readonly RunBaseline[];
}>;

export type SchemaObserver = Readonly<{ onSql?(sql: string): void }>;

function sql(database: Database, text: string, observer?: SchemaObserver) {
  observer?.onSql?.(text);
  return database.query(text);
}

export function validateImporterSchema(database: Database, observer?: SchemaObserver): void {
  const tables = sql(database, 'SELECT name FROM sqlite_schema WHERE type=? ORDER BY name', observer).all('table') as {
    name: string;
  }[];
  if (tables.length === 0)
    throw new StateBackupFailure('File is not a supported importer state database.', 'incompatible');
  if (!tables.some((row) => row.name === 'import_owners'))
    throw new StateBackupFailure(
      'Owner safety cannot be established; this schema has no import_owners table.',
      'incompatible',
    );
  for (const [table, columns] of Object.entries(REQUIRED_TABLES)) {
    const found = sql(database, 'SELECT 1 AS found FROM sqlite_schema WHERE type=? AND name=?', observer).get(
      'table',
      table,
    ) as { found: number } | null;
    if (!found)
      throw new StateBackupFailure(`Unsupported importer state schema: table ${table} is missing.`, 'incompatible');
    const actual = new Set(
      sql(database, `PRAGMA table_info(${table})`, observer)
        .all()
        .map((row) => (row as { name: string }).name),
    );
    const missing = columns.find((column) => !actual.has(column));
    if (missing)
      throw new StateBackupFailure(
        `Older unsupported importer schema: column ${table}.${missing} is missing.`,
        'incompatible',
      );
  }
  for (const [table, columns] of Object.entries(OPTIONAL_TABLES)) {
    const found = sql(database, 'SELECT 1 AS found FROM sqlite_schema WHERE type=? AND name=?', observer).get(
      'table',
      table,
    ) as { found: number } | null;
    if (!found) continue;
    const actual = new Set(
      sql(database, `PRAGMA table_info(${table})`, observer)
        .all()
        .map((row) => (row as { name: string }).name),
    );
    const missing = columns.find((column) => !actual.has(column));
    if (missing)
      throw new StateBackupFailure(
        `Older unsupported importer schema: column ${table}.${missing} is missing.`,
        'incompatible',
      );
  }
  for (const [index, table] of REQUIRED_INDEXES) {
    const found = sql(
      database,
      'SELECT 1 AS found FROM sqlite_schema WHERE type=? AND name=? AND tbl_name=?',
      observer,
    ).get('index', index, table) as { found: number } | null;
    if (!found)
      throw new StateBackupFailure(
        `Unsupported importer state schema: required index ${index} is missing.`,
        'incompatible',
      );
  }
}

export function refuseBusyOwners(database: Database, observer?: SchemaObserver): void {
  let after = '';
  for (;;) {
    const rows = sql(
      database,
      'SELECT source,pid,birth FROM import_owners WHERE source>? ORDER BY source LIMIT ?',
      observer,
    ).all(after, OWNER_PAGE) as { source: unknown; pid: unknown; birth: unknown }[];
    if (rows.length === 0) return;
    for (const row of rows) {
      if (typeof row.source !== 'string' || typeof row.pid !== 'number' || typeof row.birth !== 'string')
        throw new StateBackupFailure('Owner evidence is malformed and cannot be verified.', 'busy');
      if (importOwnerIsBusy({ pid: row.pid, birth: row.birth }))
        throw new StateBackupFailure('Importer state has a live or unverifiable owner and is busy.', 'busy');
      after = row.source;
    }
    if (rows.length < OWNER_PAGE) return;
  }
}

function boundedText(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || (!empty && value.length === 0))
    throw new StateBackupFailure('Malformed source summary row.', 'corrupt');
  return value;
}

function optionalId(value: unknown, max: number): string | null {
  if (value === null) return null;
  return boundedText(value, max);
}

function generationStatus(
  database: Database,
  source: string,
  id: string | null,
  observer?: SchemaObserver,
): string | null {
  if (id === null) return null;
  const row = sql(database, 'SELECT status FROM run_generations WHERE source=? AND id=?', observer).get(source, id) as {
    status: unknown;
  } | null;
  if (!row) return null;
  return boundedText(row.status, MAX_STATUS_CHARS);
}

export function readRunBaselines(database: Database, observer?: SchemaObserver): RunBaseline[] {
  const sources = sql(
    database,
    'SELECT source,lease_run,generation,present_count FROM run_sources ORDER BY source LIMIT ?',
    observer,
  ).all(MAX_SUMMARY_SOURCES + 1) as {
    source: unknown;
    lease_run: unknown;
    generation: unknown;
    present_count: unknown;
  }[];
  const listed = sources.slice(0, MAX_SUMMARY_SOURCES);
  const runs: RunBaseline[] = [];
  for (const row of listed) {
    if (typeof row.present_count !== 'number' || !Number.isInteger(row.present_count) || row.present_count < 0)
      throw new StateBackupFailure('Malformed source summary row.', 'corrupt');
    const source = boundedText(row.source, MAX_SOURCE_CHARS);
    const active = optionalId(row.lease_run ?? null, MAX_GENERATION_CHARS);
    const baseline = optionalId(row.generation ?? null, MAX_GENERATION_CHARS);
    const owner = sql(database, 'SELECT 1 AS found FROM import_owners WHERE source=?', observer).get(source) as {
      found: number;
    } | null;
    runs.push({
      source,
      activeGeneration: active,
      baselineGeneration: baseline,
      status: generationStatus(database, source, active ?? baseline, observer),
      presentCount: row.present_count,
      ownerRow: owner ? 'stopped' : 'absent',
    });
  }
  return runs;
}

export function readSqliteCompatibility(
  database: Database,
  observer?: SchemaObserver,
): SnapshotManifest['sqliteCompatibility'] {
  const pageSize = sql(database, 'PRAGMA page_size', observer).get() as { page_size: number };
  const pageCount = sql(database, 'PRAGMA page_count', observer).get() as { page_count: number };
  const userVersion = sql(database, 'PRAGMA user_version', observer).get() as { user_version: number };
  return { pageSize: pageSize.page_size, pageCount: pageCount.page_count, userVersion: userVersion.user_version };
}

export function quoteSqlPath(path: string): string {
  if (path.includes('\0')) throw new StateBackupFailure('State path contains an invalid NUL byte.', 'unsafe-file');
  return `'${path.replaceAll("'", "''")}'`;
}

export function parseManifest(value: Record<string, unknown>): SnapshotManifest {
  function fail(): never {
    throw new StateBackupFailure('Snapshot manifest has the wrong shape.', 'corrupt');
  }
  if (value.version !== SNAPSHOT_FORMAT_VERSION || value.format !== SNAPSHOT_FORMAT) fail();
  const createdAt = value.createdAt;
  if (typeof createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt)) fail();
  const sqlite = value.sqliteCompatibility;
  if (!sqlite || typeof sqlite !== 'object' || Array.isArray(sqlite)) fail();
  const sqliteCompatibility = sqlite as Record<string, unknown>;
  const pageSize = sqliteCompatibility.pageSize;
  const pageCount = sqliteCompatibility.pageCount;
  const userVersion = sqliteCompatibility.userVersion;
  if (
    typeof pageSize !== 'number' ||
    typeof pageCount !== 'number' ||
    typeof userVersion !== 'number' ||
    !Number.isInteger(pageSize) ||
    !Number.isInteger(pageCount) ||
    !Number.isInteger(userVersion) ||
    pageSize <= 0 ||
    pageCount < 0
  )
    fail();
  if (value.schemaCompatibility !== SCHEMA_COMPATIBILITY) fail();
  const content = value.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) fail();
  const contentRecord = content as Record<string, unknown>;
  const bytes = contentRecord.bytes;
  const sha256 = contentRecord.sha256;
  if (
    contentRecord.file !== 'importer-state.sqlite' ||
    typeof bytes !== 'number' ||
    !Number.isInteger(bytes) ||
    bytes < 0 ||
    typeof sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sha256)
  )
    fail();
  const listed = value.runs;
  if (!Array.isArray(listed) || listed.length > MAX_SUMMARY_SOURCES) fail();
  const runs: RunBaseline[] = [];
  for (const entry of listed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail();
    const row = entry as Record<string, unknown>;
    const source = row.source;
    const presentCount = row.presentCount;
    const activeGeneration = row.activeGeneration;
    const baselineGeneration = row.baselineGeneration;
    const status = row.status;
    const ownerRow = row.ownerRow;
    if (
      typeof source !== 'string' ||
      source.length === 0 ||
      source.length > MAX_SOURCE_CHARS ||
      typeof presentCount !== 'number' ||
      !Number.isInteger(presentCount) ||
      presentCount < 0
    )
      fail();
    if (
      activeGeneration !== null &&
      (typeof activeGeneration !== 'string' ||
        activeGeneration.length === 0 ||
        activeGeneration.length > MAX_GENERATION_CHARS)
    )
      fail();
    if (
      baselineGeneration !== null &&
      (typeof baselineGeneration !== 'string' ||
        baselineGeneration.length === 0 ||
        baselineGeneration.length > MAX_GENERATION_CHARS)
    )
      fail();
    if (status !== null && (typeof status !== 'string' || status.length === 0 || status.length > MAX_STATUS_CHARS))
      fail();
    if (ownerRow !== 'absent' && ownerRow !== 'stopped') fail();
    runs.push({
      source,
      activeGeneration,
      baselineGeneration,
      status,
      presentCount,
      ownerRow,
    });
  }
  return {
    version: SNAPSHOT_FORMAT_VERSION,
    format: SNAPSHOT_FORMAT,
    createdAt,
    sqliteCompatibility: { pageSize, pageCount, userVersion },
    schemaCompatibility: SCHEMA_COMPATIBILITY,
    content: { file: 'importer-state.sqlite', bytes, sha256 },
    runs,
  };
}

export function integrityWork(
  database: Database,
  observer?: SchemaObserver,
): { ok: boolean; pageCount: number; messages: string[] } {
  const pageCount = (sql(database, 'PRAGMA page_count', observer).get() as { page_count: number }).page_count;
  const rows = sql(database, 'PRAGMA integrity_check', observer).all() as Record<string, unknown>[];
  const messages = rows.slice(0, 8).map((row) => String(Object.values(row)[0] ?? ''));
  const ok = messages.length === 1 && messages[0] === 'ok';
  return { ok, pageCount, messages };
}
