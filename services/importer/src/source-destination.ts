import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { InspectionFailure, closeReadonlySqlite, openReadonlySqlite } from './inspection-open.ts';

export const SOURCE_DESTINATION_SCHEMA_VERSION = 1;
export const SOURCE_DESTINATION_TABLE = 'source_destinations';
export const SOURCE_DESTINATION_DDL = `CREATE TABLE IF NOT EXISTS source_destinations (
  source TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('first-use','operator-declared')),
  schema_version INTEGER NOT NULL
) WITHOUT ROWID`;

export type SourceDestinationProvenance = 'first-use' | 'operator-declared';
export type SourceDestinationBinding = Readonly<{
  origin: string;
  provenance: SourceDestinationProvenance;
  schemaVersion: number;
}>;

export type SourceDestinationRefusal = Readonly<
  | { kind: 'mismatch'; binding: SourceDestinationBinding }
  | { kind: 'unbound' }
  | { kind: 'unavailable'; message: string }
>;

export type SourceDestinationReview = Readonly<{
  version: 1;
  source: string;
  selectedOrigin: string;
  status: 'bound' | 'unbound' | 'absent' | 'unavailable';
  origin: string | null;
  provenance: SourceDestinationProvenance | null;
  recorded: 'first-use' | 'operator-declared' | null;
  activeGeneration: Readonly<{ id: string; status: string }> | null;
  pendingWork: Readonly<{ envelopes: number; deferredCovers: number }>;
  reviewRevision: string;
  note: string;
}>;

const SOURCE_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const REVIEW_REVISION = /^[0-9a-f]{64}$/;

export class SourceDestinationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'mismatch'
      | 'unbound'
      | 'already-bound'
      | 'stale'
      | 'busy'
      | 'unavailable'
      | 'usage'
      | 'empty'
      | 'absent',
    readonly exitCode = 2,
  ) {
    super(message);
    this.name = 'SourceDestinationError';
  }
}

export function destinationSourceId(value: string): void {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 32 || !SOURCE_ID.test(value))
    throw new SourceDestinationError('--source must be an exact configured source identifier.', 'usage');
}

export function normalizeApiOrigin(value: string, testOrigin?: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SourceDestinationError('API origin is not a valid URL.', 'usage');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.hostname)
    throw new SourceDestinationError(
      'API origin must be an HTTPS origin with no path, query, fragment or credentials.',
      'usage',
    );
  if (testOrigin === undefined) {
    if (url.protocol !== 'https:') throw new SourceDestinationError('API origin must be an HTTPS origin.', 'usage');
    return url.origin;
  }
  let test: URL;
  try {
    test = new URL(testOrigin);
  } catch {
    throw new SourceDestinationError('API origin must match the exact loopback test origin.', 'usage');
  }
  if (
    test.protocol !== 'http:' ||
    test.hostname !== '127.0.0.1' ||
    test.origin !== testOrigin ||
    url.origin !== test.origin
  )
    throw new SourceDestinationError('API origin must match the exact loopback test origin.', 'usage');
  return url.origin;
}

export function ensureSourceDestinationSchema(database: Database): void {
  database.exec(SOURCE_DESTINATION_DDL);
}

export function sourceHasHistory(database: Database, source: string): boolean {
  const table = database
    .query("SELECT 1 AS found FROM sqlite_schema WHERE type='table' AND name='run_sources'")
    .get() as { found: number } | null;
  if (!table) return false;
  const row = database.query('SELECT 1 AS found FROM run_sources WHERE source=? LIMIT 1').get(source) as {
    found: number;
  } | null;
  return Boolean(row);
}

export function readSourceDestination(
  database: Database,
  source: string,
): SourceDestinationBinding | null | 'unavailable' {
  const table = database
    .query('SELECT 1 AS found FROM sqlite_schema WHERE type=? AND name=?')
    .get('table', SOURCE_DESTINATION_TABLE) as { found: number } | null;
  if (!table) return null;
  const columns = new Set(
    database
      .query(`PRAGMA table_info(${SOURCE_DESTINATION_TABLE})`)
      .all()
      .map((row) => (row as { name: string }).name),
  );
  if (!columns.has('source') || !columns.has('origin') || !columns.has('provenance') || !columns.has('schema_version'))
    return 'unavailable';
  const row = database
    .query('SELECT origin,provenance,schema_version FROM source_destinations WHERE source=?')
    .get(source) as { origin: unknown; provenance: unknown; schema_version: unknown } | null;
  if (!row) return null;
  if (
    typeof row.origin !== 'string' ||
    row.origin.length === 0 ||
    row.origin.length > 256 ||
    (row.provenance !== 'first-use' && row.provenance !== 'operator-declared') ||
    typeof row.schema_version !== 'number' ||
    !Number.isInteger(row.schema_version) ||
    row.schema_version < 1
  )
    return 'unavailable';
  return { origin: row.origin, provenance: row.provenance, schemaVersion: row.schema_version };
}

export function mismatchMessage(source: string, configured: string, binding: SourceDestinationBinding): string {
  const recorded =
    binding.provenance === 'first-use'
      ? 'recorded on first use'
      : 'declared by the operator for legacy state; that declaration is local configuration, not verified historical destination evidence';
  return [
    `Configured API origin ${configured} does not match source ${JSON.stringify(source)} recorded origin ${binding.origin} (${recorded}).`,
    'Import refused before credentials or native replay. The local journal, pending requests and baseline are unchanged.',
    'Continue at the recorded origin with ordinary renewed credentials. Same-origin server replacement cannot be detected without a separately released deployment identity.',
    'A different destination needs a separate state file. Do not rename a source alias to impersonate another history.',
  ].join(' ');
}

export function unboundMessage(source: string): string {
  return [
    `Source ${JSON.stringify(source)} has local import history with no recorded API origin.`,
    'Old state cannot prove its historical destination. Review it with rezics-import destination --state <sqlite-path> --source <configured-source-id> --api <https-origin>, then declare that origin explicitly.',
    'Ordinary import will not guess or adopt an origin from --api.',
    'Until a declaration, use read-only inspect and backup. New destination use starts with a separate state file.',
  ].join(' ');
}

function pendingWork(
  database: Database,
  source: string,
  generation: string | null,
): { envelopes: number; deferredCovers: number } {
  if (!generation) return { envelopes: 0, deferredCovers: 0 };
  const envelopesTable = database
    .query("SELECT 1 AS found FROM sqlite_schema WHERE type='table' AND name='run_envelopes'")
    .get() as { found: number } | null;
  const entriesTable = database
    .query("SELECT 1 AS found FROM sqlite_schema WHERE type='table' AND name='run_entries'")
    .get() as { found: number } | null;
  const envelopes = envelopesTable
    ? (
        database
          .query('SELECT COUNT(*) AS count FROM run_envelopes WHERE source=? AND run_id=? AND pending=1')
          .get(source, generation) as { count: number }
      ).count
    : 0;
  const deferredCovers = entriesTable
    ? (
        database
          .query('SELECT COUNT(*) AS count FROM run_entries WHERE source=? AND run_id=? AND cover_pending=1')
          .get(source, generation) as { count: number }
      ).count
    : 0;
  return { envelopes, deferredCovers };
}

function generationStatus(database: Database, source: string, id: string | null): string | null {
  if (!id) return null;
  const table = database
    .query("SELECT 1 AS found FROM sqlite_schema WHERE type='table' AND name='run_generations'")
    .get() as { found: number } | null;
  if (!table) return null;
  const row = database.query('SELECT status FROM run_generations WHERE source=? AND id=?').get(source, id) as {
    status: unknown;
  } | null;
  return row && typeof row.status === 'string' ? row.status : null;
}

function sourcePointers(
  database: Database,
  source: string,
): {
  leaseRun: string | null;
  generation: string | null;
  presentCount: number | null;
} {
  const table = database
    .query("SELECT 1 AS found FROM sqlite_schema WHERE type='table' AND name='run_sources'")
    .get() as { found: number } | null;
  if (!table) return { leaseRun: null, generation: null, presentCount: null };
  const row = database
    .query('SELECT lease_run,generation,present_count FROM run_sources WHERE source=?')
    .get(source) as { lease_run: unknown; generation: unknown; present_count: unknown } | null;
  if (!row) return { leaseRun: null, generation: null, presentCount: null };
  return {
    leaseRun: typeof row.lease_run === 'string' ? row.lease_run : null,
    generation: typeof row.generation === 'string' ? row.generation : null,
    presentCount: typeof row.present_count === 'number' ? row.present_count : null,
  };
}

function reviewRevisionFor(
  database: Database,
  source: string,
  selectedOrigin: string,
  binding: SourceDestinationBinding | null | 'unavailable',
): string {
  const pointers = sourcePointers(database, source);
  const active = pointers.leaseRun;
  const work = pendingWork(database, source, active);
  const status = generationStatus(database, source, active);
  const origin = binding === 'unavailable' || binding === null ? '' : binding.origin;
  const provenance = binding === 'unavailable' || binding === null ? '' : binding.provenance;
  const canonical = [
    'v1',
    source,
    selectedOrigin,
    origin,
    provenance,
    pointers.leaseRun ?? '',
    pointers.generation ?? '',
    String(pointers.presentCount ?? ''),
    String(work.envelopes),
    String(work.deferredCovers),
    status ?? '',
  ].join('\0');
  return createHash('sha256').update(canonical).digest('hex');
}

function reviewNote(status: SourceDestinationReview['status'], provenance: SourceDestinationProvenance | null): string {
  if (status === 'unavailable')
    return 'Destination metadata is damaged or unreadable. Use read-only inspect and backup; do not invent an origin.';
  if (status === 'bound' && provenance === 'first-use')
    return 'This origin was recorded on first use. Continue at that destination with ordinary renewed credentials. Same-origin server replacement cannot be detected without a separately released deployment identity.';
  if (status === 'bound' && provenance === 'operator-declared')
    return 'This origin was declared by the operator for legacy state. The declaration is local configuration, not verified historical destination evidence. Sealed recovery still replays original requests once that original destination is supplied.';
  if (status === 'unbound')
    return 'Old state has no trustworthy origin to infer. Declare the original destination explicitly; ordinary import will not adopt --api. An operator who cannot establish the original destination leaves this history unbound and uses read-only inspect and backup.';
  return 'This identifier has no local history. Ordinary import records the API origin on first use before any generation or network effect.';
}

export function inspectDestination(
  database: Database,
  source: string,
): Readonly<{
  status: 'bound' | 'unbound' | 'unavailable';
  origin: string | null;
  provenance: SourceDestinationProvenance | null;
  recorded: 'first-use' | 'operator-declared' | null;
}> {
  const binding = readSourceDestination(database, source);
  if (binding === 'unavailable') return { status: 'unavailable', origin: null, provenance: null, recorded: null };
  if (!binding) return { status: 'unbound', origin: null, provenance: null, recorded: null };
  return { status: 'bound', origin: binding.origin, provenance: binding.provenance, recorded: binding.provenance };
}

export function reviewSourceDestination(
  database: Database,
  source: string,
  selectedOrigin: string,
): SourceDestinationReview {
  destinationSourceId(source);
  const binding = readSourceDestination(database, source);
  const pointers = sourcePointers(database, source);
  const history = sourceHasHistory(database, source);
  const activeId = pointers.leaseRun;
  const status = generationStatus(database, source, activeId);
  const work = pendingWork(database, source, activeId);
  const reviewStatus: SourceDestinationReview['status'] =
    binding === 'unavailable' ? 'unavailable' : binding ? 'bound' : history ? 'unbound' : 'absent';
  const provenance = binding === 'unavailable' || binding === null ? null : binding.provenance;
  return {
    version: 1,
    source,
    selectedOrigin,
    status: reviewStatus,
    origin: binding === 'unavailable' || binding === null ? null : binding.origin,
    provenance,
    recorded: provenance,
    activeGeneration: activeId && status ? { id: activeId, status } : null,
    pendingWork: work,
    reviewRevision: reviewRevisionFor(database, source, selectedOrigin, binding),
    note: reviewNote(reviewStatus, provenance),
  };
}

export function insertSourceDestination(
  database: Database,
  source: string,
  origin: string,
  provenance: SourceDestinationProvenance,
): void {
  ensureSourceDestinationSchema(database);
  database
    .prepare('INSERT INTO source_destinations(source,origin,provenance,schema_version) VALUES(?,?,?,?)')
    .run(source, origin, provenance, SOURCE_DESTINATION_SCHEMA_VERSION);
}

export function evaluateAdmission(
  database: Database,
  source: string,
  origin: string,
): 'first-use' | 'match' | SourceDestinationRefusal {
  const binding = readSourceDestination(database, source);
  if (binding === 'unavailable')
    return {
      kind: 'unavailable',
      message: 'Destination metadata is damaged or unreadable; importer state was not changed.',
    };
  if (binding) return binding.origin === origin ? 'match' : { kind: 'mismatch', binding };
  if (sourceHasHistory(database, source)) return { kind: 'unbound' };
  return 'first-use';
}

export type PreflightResult = Readonly<
  | { status: 'first-use' }
  | { status: 'admitted'; binding: SourceDestinationBinding }
  | { status: 'mismatch'; binding: SourceDestinationBinding }
  | { status: 'unbound' }
  | { status: 'unavailable'; message: string; exitCode: number }
>;

export async function preflightSourceDestination(input: {
  statePath: string;
  source: string;
  origin: string;
  missingState: 'first-use' | 'error';
}): Promise<PreflightResult> {
  destinationSourceId(input.source);
  if (!existsSync(input.statePath)) {
    if (input.missingState === 'first-use') return { status: 'first-use' };
    return {
      status: 'unavailable',
      message: `State file does not exist: ${JSON.stringify(input.statePath)}.`,
      exitCode: 2,
    };
  }
  try {
    if (!statSync(input.statePath).isFile())
      return {
        status: 'unavailable',
        message: `State path is not a regular file: ${JSON.stringify(input.statePath)}.`,
        exitCode: 2,
      };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && input.missingState === 'first-use') return { status: 'first-use' };
    return {
      status: 'unavailable',
      message: `Unable to open state file ${JSON.stringify(input.statePath)}${code ? ` (${code})` : ''}.`,
      exitCode: 2,
    };
  }
  let opened: Awaited<ReturnType<typeof openReadonlySqlite>> | undefined;
  try {
    opened = await openReadonlySqlite(input.statePath);
    const decision = evaluateAdmission(opened.database, input.source, input.origin);
    if (decision === 'first-use') return { status: 'first-use' };
    if (decision === 'match') {
      const binding = readSourceDestination(opened.database, input.source);
      if (!binding || binding === 'unavailable')
        return {
          status: 'unavailable',
          message: 'Destination metadata is damaged or unreadable; importer state was not changed.',
          exitCode: 2,
        };
      return { status: 'admitted', binding };
    }
    if (decision.kind === 'mismatch') return { status: 'mismatch', binding: decision.binding };
    if (decision.kind === 'unbound') return { status: 'unbound' };
    return { status: 'unavailable', message: decision.message, exitCode: 2 };
  } catch (error) {
    if (error instanceof InspectionFailure) {
      if (input.missingState === 'first-use' && /does not exist/.test(error.message)) return { status: 'first-use' };
      return { status: 'unavailable', message: error.message, exitCode: error.code };
    }
    return {
      status: 'unavailable',
      message: 'State file is not a supported readable SQLite database.',
      exitCode: 2,
    };
  } finally {
    if (opened) await closeReadonlySqlite(opened);
  }
}

export async function openDestinationReview(input: {
  statePath: string;
  source: string;
  origin: string;
}): Promise<SourceDestinationReview> {
  destinationSourceId(input.source);
  const opened = await openReadonlySqlite(input.statePath);
  try {
    return reviewSourceDestination(opened.database, input.source, input.origin);
  } finally {
    await closeReadonlySqlite(opened);
  }
}

export const DESTINATION_REVIEW_REVISION = REVIEW_REVISION;

export function throwAdmissionRefusal(source: string, origin: string, refusal: SourceDestinationRefusal): never {
  if (refusal.kind === 'mismatch')
    throw new SourceDestinationError(mismatchMessage(source, origin, refusal.binding), 'mismatch');
  if (refusal.kind === 'unbound') throw new SourceDestinationError(unboundMessage(source), 'unbound');
  throw new SourceDestinationError(refusal.message, 'unavailable');
}
