import type { Database } from 'bun:sqlite';
import { importInvocationShape } from './conversion-diagnostics.ts';
import {
  InspectionFailure,
  closeReadonlySqlite,
  openReadonlySqlite,
  type OpenReadonlySqliteOptions,
  type ReadonlySqlite,
} from './inspection-open.ts';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_RECORD_KEY_BYTES,
  RECORD_KEY,
  encodeOpaqueCursor,
  exactObject,
  integer,
  utf8Bytes,
  validGeneration,
  validRecordKey,
  validSource,
} from './inspection-store.ts';

export { InspectionFailure } from './inspection-open.ts';

export const DISAPPEARANCE_REVIEW_VERSION = 1 as const;
export const DISAPPEARANCE_REVIEW_SCHEMA = 'disappearance-stop-evidence-v1';
export const DEFAULT_DISAPPEARANCE_PAGE = DEFAULT_PAGE_SIZE;
export const MAX_DISAPPEARANCE_PAGE = MAX_PAGE_SIZE;
const MAX_CURSOR_BYTES = 2048;
const MAX_REVISION_BYTES = 256;
const MAX_CONVERTER_BYTES = 128;
const DIGEST = /^[a-f0-9]{64}$/u;
const STOP_COLUMNS = [
  'source',
  'run_id',
  'evidence_id',
  'baseline_generation',
  'supplied',
  'survivors',
  'prior',
  'missing',
  'threshold',
  'input_complete',
] as const;
const MISSING_COLUMNS = ['source', 'run_id', 'record_key', 'record_revision', 'digest', 'converter_revision'] as const;

export class DisappearanceReviewFailure extends InspectionFailure {}

export type DisappearanceReviewRequest = Readonly<{
  source: string;
  generation: string;
  page?: 'missing';
  limit?: number;
  cursor?: string;
  record?: string;
}>;

export type DisappearanceEvidenceAvailability = 'complete' | 'unavailable' | 'retired' | 'partially-retired';

export type DisappearanceMissingRow = Readonly<{
  recordKey: string;
  recordRevision: string;
  digest: string;
  converterRevision: string;
}>;

export type DisappearanceReviewWork = Readonly<{
  sqliteReads: number;
  visitedRows: number;
  emittedRows: number;
  probes: number;
  retainedBufferBytes: number;
}>;

export type DisappearanceReviewDocument = Readonly<{
  version: typeof DISAPPEARANCE_REVIEW_VERSION;
  schema: typeof DISAPPEARANCE_REVIEW_SCHEMA;
  source: string;
  generation: Readonly<{
    id: string;
    status: string;
    seq: number;
    comparedBaseline: Readonly<{ generation: string | null; presentCount: number | null }>;
    counts: Readonly<{
      supplied: number;
      survivors: number;
      prior: number;
      missing: number;
      threshold: number;
    }>;
    input: 'complete' | 'malformed-or-truncated' | 'other';
  }>;
  evidence: Readonly<{
    availability: DisappearanceEvidenceAvailability;
    identity: string | null;
    reason: string;
  }>;
  record: (DisappearanceMissingRow & Readonly<{ found: boolean; nativeDeletion: 'not-established' }>) | null;
  page: null | Readonly<{
    kind: 'missing';
    limit: number;
    storedMissing: number;
    end: 'end' | 'more';
    nextCursor?: string;
    rows: readonly DisappearanceMissingRow[];
  }>;
  work: DisappearanceReviewWork;
  authority: Readonly<{
    inspection: 'read-only';
    disappearanceApproval: 'none';
    thresholdChange: 'none';
    nativePublication: 'independent';
    transport: 'none';
  }>;
  ordinaryImport: string;
}>;

export type DisappearanceReviewObserver = Readonly<{
  onQuery?(sql: string): void;
  onRowVisit?(count: number): void;
  onBuffer?(bytes: number): void;
}>;

type GenerationRow = {
  id: unknown;
  seq: unknown;
  status: unknown;
  threshold: unknown;
  prior: unknown;
  supplied: unknown;
  survivors: unknown;
  retired: unknown;
  retention_state: unknown;
};

type StopRow = {
  source: unknown;
  run_id: unknown;
  evidence_id: unknown;
  baseline_generation: unknown;
  supplied: unknown;
  survivors: unknown;
  prior: unknown;
  missing: unknown;
  threshold: unknown;
  input_complete: unknown;
};

type MissingRow = {
  record_key: unknown;
  record_revision: unknown;
  digest: unknown;
  converter_revision: unknown;
};

class Work {
  sqliteReads = 0;
  visitedRows = 0;
  emittedRows = 0;
  probes = 0;
  retainedBufferBytes = 0;
  constructor(readonly observer?: DisappearanceReviewObserver) {}
  snapshot(): DisappearanceReviewWork {
    this.observer?.onBuffer?.(this.retainedBufferBytes);
    return {
      sqliteReads: this.sqliteReads,
      visitedRows: this.visitedRows,
      emittedRows: this.emittedRows,
      probes: this.probes,
      retainedBufferBytes: this.retainedBufferBytes,
    };
  }
}

class Queries {
  constructor(
    private readonly database: Database,
    private readonly work: Work,
  ) {}
  get<T>(sql: string, ...args: (string | number)[]): T | null {
    this.work.sqliteReads += 1;
    this.work.observer?.onQuery?.(sql);
    return this.database.query(sql).get(...args) as T | null;
  }
  all<T>(sql: string, ...args: (string | number)[]): T[] {
    this.work.sqliteReads += 1;
    this.work.observer?.onQuery?.(sql);
    return this.database.query(sql).all(...args) as T[];
  }
}

function fail(message: string, code = 1): never {
  throw new DisappearanceReviewFailure(message, code);
}

function inspectSchema(database: Database): Schema {
  for (const table of ['run_sources', 'run_generations'] as const) {
    const found = database
      .query('SELECT 1 AS found FROM sqlite_schema WHERE type=? AND name=?')
      .get('table', table) as { found: number } | null;
    if (!found) fail(`Unsupported importer state schema: table ${table} is missing.`, 2);
  }
  const generation = schemaColumns(database, 'run_generations') ?? new Set<string>();
  const stop = schemaColumns(database, 'run_disappearance_stops');
  const missing = schemaColumns(database, 'run_disappearance_missing');
  let evidence: Schema['evidence'] = 'absent';
  if (stop && missing) {
    const stopMissing = STOP_COLUMNS.find((column) => !stop.has(column));
    const missingMissing = MISSING_COLUMNS.find((column) => !missing.has(column));
    if (stopMissing)
      fail(`Unsupported importer state schema: column run_disappearance_stops.${stopMissing} is missing.`, 2);
    if (missingMissing)
      fail(`Unsupported importer state schema: column run_disappearance_missing.${missingMissing} is missing.`, 2);
    evidence = 'complete';
  } else if (stop || missing) {
    fail('Unsupported importer state schema: disappearance evidence tables are incomplete.', 2);
  }
  return {
    generationRetired: generation.has('retired'),
    generationRetention: generation.has('retention_state'),
    evidence,
  };
}

function availability(
  status: string,
  retired: unknown,
  retentionState: unknown,
): { available: true } | { available: false; reason: DisappearanceEvidenceAvailability } {
  if (retired === 1 || retentionState === 'retired' || status === 'retired')
    return { available: false, reason: 'retired' };
  if (
    retired === 2 ||
    retentionState === 'partially-retired' ||
    retentionState === 'partially_retired' ||
    status === 'partially-retired' ||
    status === 'partially_retired'
  )
    return { available: false, reason: 'partially-retired' };
  return { available: true };
}

function admitIdentity(value: unknown, label: string, maxBytes: number, pattern: RegExp): string {
  if (typeof value !== 'string' || utf8Bytes(value) > maxBytes || !pattern.test(value))
    fail(`Malformed journal row: ${label} is not admitted record metadata.`);
  return value;
}

function parseMissing(row: MissingRow): DisappearanceMissingRow {
  if (
    typeof row.record_key !== 'string' ||
    utf8Bytes(row.record_key) > MAX_RECORD_KEY_BYTES ||
    !RECORD_KEY.test(row.record_key)
  )
    fail('Malformed journal row: missing identity is not an exact source record key.');
  const recordRevision = admitIdentity(
    row.record_revision,
    'recordRevision',
    MAX_REVISION_BYTES,
    /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/u,
  );
  const digest = admitIdentity(row.digest, 'digest', 64, DIGEST);
  const converterRevision = admitIdentity(
    row.converter_revision,
    'converter_revision',
    MAX_CONVERTER_BYTES,
    /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/u,
  );
  return { recordKey: row.record_key, recordRevision, digest, converterRevision };
}

function decodeCursor(value: string, request: DisappearanceReviewRequest, evidenceId: string): string {
  if (utf8Bytes(value) > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/u.test(value))
    fail('Cursor is malformed or exceeds its bound.', 2);
  let decoded: string;
  let cursor: unknown;
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) throw new Error('noncanonical');
    cursor = JSON.parse(decoded) as unknown;
  } catch {
    fail('Cursor is malformed or noncanonical.', 2);
  }
  const result = exactObject(cursor, ['v', 'schema', 'view', 'source', 'generation', 'evidence', 'record'], 'cursor');
  if (
    result.v !== 1 ||
    result.schema !== DISAPPEARANCE_REVIEW_SCHEMA ||
    result.view !== 'missing' ||
    result.source !== request.source ||
    result.generation !== request.generation ||
    result.evidence !== evidenceId
  )
    fail('Cursor belongs to a different source, generation or stop-evidence snapshot.', 2);
  if (
    typeof result.record !== 'string' ||
    utf8Bytes(result.record) > MAX_RECORD_KEY_BYTES ||
    !RECORD_KEY.test(result.record)
  )
    fail('Cursor record ordering key is invalid.', 2);
  return result.record;
}

function encodeCursor(request: DisappearanceReviewRequest, evidenceId: string, record: string): string {
  return encodeOpaqueCursor({
    v: 1,
    schema: DISAPPEARANCE_REVIEW_SCHEMA,
    view: 'missing',
    source: request.source,
    generation: request.generation,
    evidence: evidenceId,
    record,
  });
}

function inputKind(status: string, complete: number | null): DisappearanceReviewDocument['generation']['input'] {
  if (status === 'invalid-input') return 'malformed-or-truncated';
  if (status === 'mass-disappearance' && complete === 1) return 'complete';
  if (status === 'mass-disappearance') return 'complete';
  return 'other';
}

function evidenceReason(availability: DisappearanceEvidenceAvailability, status: string): string {
  if (availability === 'retired')
    return 'This generation has been retired. Pruned stop evidence is unavailable, not an empty capture.';
  if (availability === 'partially-retired')
    return 'This generation is partially retired. Remaining stop evidence cannot be treated as a complete historic list.';
  if (status === 'invalid-input')
    return 'This generation stopped as incomplete or invalid input, not mass disappearance.';
  if (status !== 'mass-disappearance')
    return 'This generation is not a mass-disappearance stop. Capture comparison covers two complete captures.';
  return 'This retained stop has no immutable missing-identity evidence. Counts are stored generation totals. Do not reconstruct a historic list from current membership.';
}

type Schema = Readonly<{
  generationRetired: boolean;
  generationRetention: boolean;
  evidence: 'complete' | 'absent' | 'unsupported';
}>;

function schemaColumns(database: Database, table: string): Set<string> | null {
  const found = database.query('SELECT 1 AS found FROM sqlite_schema WHERE type=? AND name=?').get('table', table) as {
    found: number;
  } | null;
  if (!found) return null;
  return new Set((database.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name));
}

/** Read-only review of one stopped mass-disappearance generation. Never constructs RunStore. */
export class DisappearanceReview {
  private closed = false;

  private constructor(
    private readonly opened: ReadonlySqlite,
    private readonly schema: Schema,
    private readonly observer?: DisappearanceReviewObserver,
  ) {}

  static async open(
    statePath: string,
    options: OpenReadonlySqliteOptions & { observer?: DisappearanceReviewObserver } = {},
  ): Promise<DisappearanceReview> {
    const opened = await openReadonlySqlite(statePath, options);
    try {
      const schema = inspectSchema(opened.database);
      return new DisappearanceReview(opened, schema, options.observer);
    } catch (error) {
      await closeReadonlySqlite(opened);
      if (error instanceof InspectionFailure) throw error;
      throw new DisappearanceReviewFailure('Malformed or unavailable importer journal data; no state was changed.');
    }
  }

  review(request: DisappearanceReviewRequest, signal?: AbortSignal): DisappearanceReviewDocument {
    if (this.closed) fail('Disappearance review store is closed.');
    validSource(request.source);
    validGeneration(request.generation);
    if (request.record !== undefined) validRecordKey(request.record);
    if (request.page !== undefined && request.page !== 'missing') fail('Page must be missing.', 2);
    if (
      request.limit !== undefined &&
      (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > MAX_DISAPPEARANCE_PAGE)
    )
      fail('Page size must be an integer from 1 through 100.', 2);
    if (request.cursor !== undefined && request.page !== 'missing') fail('A cursor requires a missing page.', 2);
    if (request.limit !== undefined && request.page !== 'missing') fail('A page size requires a missing page.', 2);
    return this.snapshot(signal, () => this.read(request, signal));
  }

  private snapshot<T>(signal: AbortSignal | undefined, operation: () => T): T {
    if (signal?.aborted) fail('Disappearance review was cancelled.', 130);
    this.opened.database.exec('BEGIN');
    try {
      const value = operation();
      if (signal?.aborted) fail('Disappearance review was cancelled.', 130);
      this.opened.database.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.opened.database.exec('ROLLBACK');
      } catch {
        // Preserve the original bounded read failure.
      }
      if (error instanceof InspectionFailure) throw error;
      if (
        error instanceof Error &&
        /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i.test(error.message)
      )
        fail('State database is busy or locked; retry the local review.');
      if (error instanceof Error && /no such (?:table|column)|no query solution|no such index/i.test(error.message))
        fail('Unsupported importer state schema: a required journal field or index is unavailable.', 2);
      fail('Malformed or unavailable importer journal data; no state was changed.');
    }
  }

  private read(request: DisappearanceReviewRequest, signal?: AbortSignal): DisappearanceReviewDocument {
    if (signal?.aborted) fail('Disappearance review was cancelled.', 130);
    const work = new Work(this.observer);
    const queries = new Queries(this.opened.database, work);
    const sourceRow = queries.get<{ source: unknown; generation: unknown; present_count: unknown }>(
      'SELECT source,generation,present_count FROM run_sources WHERE source=?',
      request.source,
    );
    if (!sourceRow) fail(`No source state exists for ${JSON.stringify(request.source)}.`, 2);
    if (sourceRow.source !== request.source)
      fail('Malformed journal row: source identity does not match its lookup key.');
    const retired = this.schema.generationRetired ? 'retired' : 'NULL AS retired';
    const retention = this.schema.generationRetention ? 'retention_state' : 'NULL AS retention_state';
    const generation = queries.get<GenerationRow>(
      `SELECT id,seq,status,threshold,prior,supplied,survivors,${retired},${retention}
      FROM run_generations WHERE source=? AND id=?`,
      request.source,
      request.generation,
    );
    if (!generation) fail(`No retained generation ${JSON.stringify(request.generation)} exists for this source.`, 2);
    if (generation.id !== request.generation)
      fail('Malformed journal row: generation identity does not match its lookup key.');
    if (
      typeof generation.status !== 'string' ||
      utf8Bytes(generation.status) > 64 ||
      !/^[a-z][a-z0-9-]*$/u.test(generation.status)
    )
      fail('Malformed journal row: generation status is not a stored status identifier.');
    const retentionState = availability(generation.status, generation.retired, generation.retention_state);
    const counts = {
      supplied: integer(generation.supplied, 'run_generations.supplied'),
      survivors: integer(generation.survivors, 'run_generations.survivors'),
      prior: integer(generation.prior, 'run_generations.prior'),
      missing:
        integer(generation.prior, 'run_generations.prior') - integer(generation.survivors, 'run_generations.survivors'),
      threshold:
        typeof generation.threshold === 'number' && Number.isFinite(generation.threshold)
          ? generation.threshold
          : fail('Malformed journal row: disappearance threshold is invalid.'),
    };
    const stop =
      this.schema.evidence === 'complete'
        ? queries.get<StopRow>(
            `SELECT source,run_id,evidence_id,baseline_generation,supplied,survivors,prior,missing,threshold,input_complete
            FROM run_disappearance_stops WHERE source=? AND run_id=?`,
            request.source,
            request.generation,
          )
        : null;
    const evidenceAvailability: DisappearanceEvidenceAvailability = !retentionState.available
      ? retentionState.reason
      : stop &&
          typeof stop.evidence_id === 'string' &&
          stop.source === request.source &&
          stop.run_id === request.generation
        ? 'complete'
        : 'unavailable';
    if (evidenceAvailability === 'complete' && stop) {
      counts.supplied = integer(stop.supplied, 'run_disappearance_stops.supplied');
      counts.survivors = integer(stop.survivors, 'run_disappearance_stops.survivors');
      counts.prior = integer(stop.prior, 'run_disappearance_stops.prior');
      counts.missing = integer(stop.missing, 'run_disappearance_stops.missing');
      if (typeof stop.threshold !== 'number' || !Number.isFinite(stop.threshold))
        fail('Malformed journal row: stored stop threshold is invalid.');
      counts.threshold = stop.threshold;
    }
    const evidenceId =
      evidenceAvailability === 'complete' && typeof stop?.evidence_id === 'string' ? stop.evidence_id : null;
    const comparedBaseline =
      evidenceAvailability === 'complete' && stop
        ? typeof stop.baseline_generation === 'string' && stop.baseline_generation.length
          ? stop.baseline_generation
          : null
        : sourceRow.generation === null || sourceRow.generation === undefined
          ? null
          : String(sourceRow.generation);
    const completeFlag =
      evidenceAvailability === 'complete' && stop
        ? integer(stop.input_complete, 'run_disappearance_stops.input_complete')
        : null;
    let after = '';
    if (request.cursor !== undefined) {
      if (evidenceAvailability !== 'complete' || !evidenceId)
        fail('Cursor belongs to a different source, generation or stop-evidence snapshot.', 2);
      after = decodeCursor(request.cursor, request, evidenceId);
    }
    let record: DisappearanceReviewDocument['record'] = null;
    if (request.record !== undefined) {
      if (evidenceAvailability !== 'complete') {
        record = {
          found: false,
          recordKey: request.record,
          recordRevision: '',
          digest: '',
          converterRevision: '',
          nativeDeletion: 'not-established',
        };
      } else {
        work.probes += 1;
        const row = queries.get<MissingRow>(
          `SELECT record_key,record_revision,digest,converter_revision
          FROM run_disappearance_missing WHERE source=? AND run_id=? AND record_key=?`,
          request.source,
          request.generation,
          request.record,
        );
        if (!row) {
          record = {
            found: false,
            recordKey: request.record,
            recordRevision: '',
            digest: '',
            converterRevision: '',
            nativeDeletion: 'not-established',
          };
        } else {
          work.visitedRows += 1;
          work.emittedRows += 1;
          const parsed = parseMissing(row);
          work.retainedBufferBytes +=
            utf8Bytes(parsed.recordKey) + utf8Bytes(parsed.recordRevision) + 64 + utf8Bytes(parsed.converterRevision);
          record = { ...parsed, found: true, nativeDeletion: 'not-established' };
        }
      }
    }
    const page =
      request.page === 'missing'
        ? this.readPage(queries, request, work, evidenceAvailability, evidenceId, counts.missing, after)
        : null;
    return {
      version: DISAPPEARANCE_REVIEW_VERSION,
      schema: DISAPPEARANCE_REVIEW_SCHEMA,
      source: request.source,
      generation: {
        id: request.generation,
        status: generation.status,
        seq: integer(generation.seq, 'run_generations.seq', 1),
        comparedBaseline: {
          generation: comparedBaseline,
          presentCount:
            sourceRow.present_count === null || sourceRow.present_count === undefined
              ? null
              : integer(sourceRow.present_count, 'run_sources.present_count'),
        },
        counts,
        input: inputKind(generation.status, completeFlag),
      },
      evidence: {
        availability: evidenceAvailability,
        identity: evidenceId,
        reason:
          evidenceAvailability === 'complete'
            ? 'Immutable missing identities were captured at the complete seal barrier for this generation.'
            : evidenceReason(evidenceAvailability, generation.status),
      },
      record,
      page,
      work: work.snapshot(),
      authority: {
        inspection: 'read-only',
        disappearanceApproval: 'none',
        thresholdChange: 'none',
        nativePublication: 'independent',
        transport: 'none',
      },
      ordinaryImport: importInvocationShape(),
    };
  }

  private readPage(
    queries: Queries,
    request: DisappearanceReviewRequest,
    work: Work,
    availability: DisappearanceEvidenceAvailability,
    evidenceId: string | null,
    storedMissing: number,
    after: string,
  ): NonNullable<DisappearanceReviewDocument['page']> {
    const limit = request.limit ?? DEFAULT_DISAPPEARANCE_PAGE;
    if (availability !== 'complete' || !evidenceId) {
      return { kind: 'missing', limit, storedMissing, end: 'end', rows: [] };
    }
    const fetched = queries.all<MissingRow>(
      `SELECT record_key,record_revision,digest,converter_revision
      FROM run_disappearance_missing
      WHERE source=? AND run_id=? AND record_key>?
      ORDER BY record_key LIMIT ?`,
      request.source,
      request.generation,
      after,
      limit + 1,
    );
    work.visitedRows += fetched.length;
    const more = fetched.length > limit;
    if (more) work.probes += 1;
    const rows = fetched.slice(0, limit).map((row) => {
      work.emittedRows += 1;
      const parsed = parseMissing(row);
      work.retainedBufferBytes +=
        utf8Bytes(parsed.recordKey) + utf8Bytes(parsed.recordRevision) + 64 + utf8Bytes(parsed.converterRevision);
      return parsed;
    });
    const last = rows.at(-1);
    return {
      kind: 'missing',
      limit,
      storedMissing,
      end: more ? 'more' : 'end',
      ...(more && last ? { nextCursor: encodeCursor(request, evidenceId, last.recordKey) } : {}),
      rows,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await closeReadonlySqlite(this.opened);
  }
}
