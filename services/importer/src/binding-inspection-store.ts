import { Database } from 'bun:sqlite';
import type { FileHandle } from 'node:fs/promises';
import {
  BINDING_BODY_BUDGET,
  BINDING_SCHEMA_TOKEN,
  BINDING_UUID,
  DEFAULT_BINDING_PAGE_SIZE,
  MAX_BINDING_PAGE_SIZE,
  bindingResumeGuidance,
  candidateLocator,
  decodeBindingCursor,
  decodeMediaAccepted,
  decodeMediaBody,
  decodeMediaStatus,
  decodeMetadataAck,
  decodeMetadataBody,
  decodeSemanticAck,
  decodeSemanticBody,
  emptyBindingMetrics,
  freezeBindingMetrics,
  integerOrNull,
  isFieldGroup,
  nextBindingCursor,
  projectBody,
  safeSignature,
  unavailableRow,
  utf8Bytes,
  validBindingRecord,
  validBindingRequestKey,
  validBindingSource,
  type BindingFieldGroup,
  type BindingInspectionDetail,
  type BindingInspectionDocument,
  type BindingInspectionMetrics,
  type BindingInspectionPage,
  type BindingInspectionPageKind,
  type BindingInspectionRequest,
  type BindingInspectionRow,
  type BindingInspectionState,
  type BindingSectionAvailability,
  type MutableBindingMetrics,
} from './binding-inspection.ts';
import {
  InspectionFailure,
  closeReadonlySqlite,
  openReadonlySqlite,
  type OpenReadonlySqliteOptions,
} from './inspection-open.ts';

const REQUIRED_RECORDS = [
  'source',
  'external_id',
  'state',
  'subject',
  'bootstrap_key',
  'candidate_count',
  'cover_key',
] as const;
const JOURNAL_COLUMNS = ['source', 'external_id', 'key', 'bytes', 'signature', 'acknowledgement'] as const;
const CANDIDATE_COLUMNS = [
  'source',
  'external_id',
  'field_group',
  'candidate',
  'subject',
  'key',
  'bytes',
  'signature',
] as const;
const GROUP_COLUMNS = ['source', 'external_id', 'field_group', 'candidate_count'] as const;
const MEDIA_COLUMNS = ['source', 'external_id', 'key', 'bytes', 'signature', 'accepted', 'status'] as const;
const METADATA_CURRENT_COLUMNS = ['source', 'external_id', 'key'] as const;

type FamilyStatus = BindingSectionAvailability;
type SchemaInventory = Readonly<{
  token: string;
  records: true;
  groups: FamilyStatus;
  semantic: FamilyStatus;
  candidates: FamilyStatus;
  media: FamilyStatus;
  metadata: FamilyStatus;
  runSources: FamilyStatus;
}>;

type BindingRow = {
  source: unknown;
  external_id: unknown;
  state: unknown;
  subject: unknown;
  bootstrap_key: unknown;
  candidate_count: unknown;
  cover_key: unknown;
};

type GroupRow = { field_group: unknown; candidate_count: unknown };

type JournalSqlRow = {
  key: unknown;
  signature: unknown;
  byte_length: unknown;
  bytes: unknown;
  acknowledged: unknown;
  ack_length: unknown;
  acknowledgement: unknown;
};

type CandidateSqlRow = {
  field_group: unknown;
  candidate: unknown;
  subject: unknown;
  key: unknown;
  signature: unknown;
  byte_length: unknown;
  bytes: unknown;
};

type MediaSqlRow = {
  key: unknown;
  signature: unknown;
  byte_length: unknown;
  bytes: unknown;
  accepted_length: unknown;
  accepted: unknown;
  status_length: unknown;
  status: unknown;
};

const JOURNAL_SELECT = `key, signature,
  length(CAST(bytes AS BLOB)) AS byte_length,
  CASE WHEN length(CAST(bytes AS BLOB)) <= ${BINDING_BODY_BUDGET} THEN bytes ELSE NULL END AS bytes,
  CASE WHEN acknowledgement IS NULL THEN 0 ELSE 1 END AS acknowledged,
  CASE WHEN acknowledgement IS NULL THEN NULL ELSE length(CAST(acknowledgement AS BLOB)) END AS ack_length,
  CASE WHEN acknowledgement IS NOT NULL AND length(CAST(acknowledgement AS BLOB)) <= ${BINDING_BODY_BUDGET}
    THEN acknowledgement ELSE NULL END AS acknowledgement`;

const CANDIDATE_SELECT = `field_group, candidate, subject, key, signature,
  length(CAST(bytes AS BLOB)) AS byte_length,
  CASE WHEN length(CAST(bytes AS BLOB)) <= ${BINDING_BODY_BUDGET} THEN bytes ELSE NULL END AS bytes`;

const MEDIA_SELECT = `key, signature,
  length(CAST(bytes AS BLOB)) AS byte_length,
  CASE WHEN length(CAST(bytes AS BLOB)) <= ${BINDING_BODY_BUDGET} THEN bytes ELSE NULL END AS bytes,
  CASE WHEN accepted IS NULL THEN NULL ELSE length(CAST(accepted AS BLOB)) END AS accepted_length,
  CASE WHEN accepted IS NOT NULL AND length(CAST(accepted AS BLOB)) <= ${BINDING_BODY_BUDGET} THEN accepted ELSE NULL END AS accepted,
  CASE WHEN status IS NULL THEN NULL ELSE length(CAST(status AS BLOB)) END AS status_length,
  CASE WHEN status IS NOT NULL AND length(CAST(status AS BLOB)) <= ${BINDING_BODY_BUDGET} THEN status ELSE NULL END AS status`;

function familySql(kind: BindingInspectionPageKind): { table: string; select: string } {
  if (kind === 'semantic') return { table: 'binding_journal', select: JOURNAL_SELECT };
  if (kind === 'candidates') return { table: 'binding_candidates', select: CANDIDATE_SELECT };
  if (kind === 'media') return { table: 'binding_media', select: MEDIA_SELECT };
  return { table: 'binding_metadata_journal', select: JOURNAL_SELECT };
}

/** Read-only exact-record binding inspector. It never constructs RecordBindings or a writer. */
export class BindingInspectionStore {
  readonly database: Database;
  readonly path: string;
  readonly schema: SchemaInventory;
  private readonly descriptor: FileHandle;
  private closed = false;
  private metrics: MutableBindingMetrics = emptyBindingMetrics();

  private constructor(path: string, descriptor: FileHandle, database: Database, schema: SchemaInventory) {
    this.path = path;
    this.descriptor = descriptor;
    this.database = database;
    this.schema = schema;
  }

  static async open(statePath: string, options: OpenReadonlySqliteOptions = {}): Promise<BindingInspectionStore> {
    const opened = await openReadonlySqlite(statePath, options);
    try {
      const schema = BindingInspectionStore.readSchema(opened.database);
      return new BindingInspectionStore(opened.path, opened.descriptor, opened.database, schema);
    } catch (error) {
      await closeReadonlySqlite(opened);
      if (error instanceof InspectionFailure) throw error;
      throw new InspectionFailure('Malformed or unavailable importer binding data; no state was changed.');
    }
  }

  lastMetrics(): BindingInspectionMetrics {
    return freezeBindingMetrics(this.metrics);
  }

  inspect(request: BindingInspectionRequest, signal?: AbortSignal): BindingInspectionDocument {
    validBindingSource(request.source);
    validBindingRecord(request.record);
    if (request.page === undefined && (request.cursor !== undefined || request.limit !== undefined))
      throw new InspectionFailure('A cursor or page size requires --page semantic|candidates|media|metadata.', 2);
    if (
      request.page !== undefined &&
      request.page !== 'semantic' &&
      request.page !== 'candidates' &&
      request.page !== 'media' &&
      request.page !== 'metadata'
    )
      throw new InspectionFailure('Page must be semantic, candidates, media or metadata.', 2);
    if (
      request.page !== undefined &&
      request.limit !== undefined &&
      (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > MAX_BINDING_PAGE_SIZE)
    )
      throw new InspectionFailure('Page size must be an integer from 1 through 100.', 2);
    if (request.cursor !== undefined && request.page === undefined)
      throw new InspectionFailure('A cursor requires a page selector.', 2);
    if (request.request !== undefined && request.page === undefined)
      throw new InspectionFailure('An exact original request requires --page semantic|candidates|media|metadata.', 2);
    if (request.request !== undefined && request.cursor !== undefined)
      throw new InspectionFailure('Exact request detail cannot be combined with a page cursor.', 2);
    if (request.request !== undefined && request.page === 'candidates') {
      const slash = request.request.indexOf('/');
      if (slash <= 0) throw new InspectionFailure('Candidate locator must be field-group/candidate-uuid.', 2);
    } else if (request.request !== undefined && request.page)
      validBindingRequestKey(request.source, request.record, request.request);
    return this.snapshot(signal, () => this.readView(request, signal));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.database.close();
    } catch {
      // Continue closing the descriptor even if SQLite reports a close failure.
    } finally {
      await this.descriptor.close().catch(() => {});
    }
  }

  private static tableExists(database: Database, name: string): boolean {
    const found = database.query('SELECT 1 AS found FROM sqlite_schema WHERE type=? AND name=?').get('table', name) as {
      found: number;
    } | null;
    return !!found;
  }

  private static columns(database: Database, table: string): Set<string> {
    return new Set(
      database
        .query(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => (row as { name: string }).name),
    );
  }

  private static family(
    database: Database,
    table: string,
    columns: readonly string[],
    requiredTogether: readonly string[] = [table],
  ): FamilyStatus {
    const present = requiredTogether.every((name) => BindingInspectionStore.tableExists(database, name));
    if (!present) {
      if (requiredTogether.some((name) => BindingInspectionStore.tableExists(database, name))) return 'unavailable';
      return 'not-retained';
    }
    for (const name of requiredTogether) {
      const actual = BindingInspectionStore.columns(database, name);
      const expected = name === table ? columns : BindingInspectionStore.columnsFor(name);
      if (expected.some((column) => !actual.has(column))) return 'unavailable';
    }
    return 'available';
  }

  private static columnsFor(table: string): readonly string[] {
    if (table === 'binding_records') return REQUIRED_RECORDS;
    if (table === 'binding_groups') return GROUP_COLUMNS;
    if (table === 'binding_journal') return JOURNAL_COLUMNS;
    if (table === 'binding_candidates') return CANDIDATE_COLUMNS;
    if (table === 'binding_media') return MEDIA_COLUMNS;
    if (table === 'binding_metadata_journal') return JOURNAL_COLUMNS;
    if (table === 'binding_metadata_current') return METADATA_CURRENT_COLUMNS;
    return [];
  }

  private static readSchema(database: Database): SchemaInventory {
    if (!BindingInspectionStore.tableExists(database, 'binding_records'))
      throw new InspectionFailure('Unsupported importer binding schema: table binding_records is missing.');
    const recordColumns = BindingInspectionStore.columns(database, 'binding_records');
    const missing = REQUIRED_RECORDS.find((column) => !recordColumns.has(column));
    if (missing)
      throw new InspectionFailure(`Unsupported importer binding schema: column binding_records.${missing} is missing.`);
    const metadata = BindingInspectionStore.family(database, 'binding_metadata_journal', JOURNAL_COLUMNS, [
      'binding_metadata_journal',
      'binding_metadata_current',
    ]);
    const runSources = BindingInspectionStore.tableExists(database, 'run_sources')
      ? BindingInspectionStore.columns(database, 'run_sources').has('source')
        ? 'available'
        : 'unavailable'
      : 'not-retained';
    return {
      token: BINDING_SCHEMA_TOKEN,
      records: true,
      groups: BindingInspectionStore.family(database, 'binding_groups', GROUP_COLUMNS),
      semantic: BindingInspectionStore.family(database, 'binding_journal', JOURNAL_COLUMNS),
      candidates: BindingInspectionStore.family(database, 'binding_candidates', CANDIDATE_COLUMNS),
      media: BindingInspectionStore.family(database, 'binding_media', MEDIA_COLUMNS),
      metadata,
      runSources: runSources === 'not-retained' ? 'unavailable' : runSources,
    };
  }

  private checkOpen(): void {
    if (this.closed) throw new InspectionFailure('Binding inspection store is closed.');
  }

  private snapshot<T>(signal: AbortSignal | undefined, operation: () => T): T {
    this.checkOpen();
    if (signal?.aborted) throw new InspectionFailure('Inspection was cancelled.', 130);
    this.metrics = emptyBindingMetrics();
    this.database.exec('BEGIN');
    this.metrics.queries += 1;
    try {
      const value = operation();
      if (signal?.aborted) throw new InspectionFailure('Inspection was cancelled.', 130);
      this.database.exec('COMMIT');
      this.metrics.queries += 1;
      return value;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
        this.metrics.queries += 1;
      } catch {
        // Preserve the original bounded read failure.
      }
      if (error instanceof InspectionFailure) throw error;
      if (
        error instanceof Error &&
        /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i.test(error.message)
      )
        throw new InspectionFailure('State database is busy or locked; retry the local inspection.');
      if (error instanceof Error && /no such (?:table|column)|no query solution|no such index/i.test(error.message))
        throw new InspectionFailure(
          'Unsupported importer binding schema: a required journal field or index is unavailable.',
        );
      throw new InspectionFailure('Malformed or unavailable importer binding data; no state was changed.');
    }
  }

  private get<T>(sql: string, ...parameters: (string | number)[]): T | null {
    this.metrics.queries += 1;
    const row = this.database.query(sql).get(...parameters) as T | null;
    if (row) this.metrics.visitedRows += 1;
    return row;
  }

  private all<T>(sql: string, ...parameters: (string | number)[]): T[] {
    this.metrics.queries += 1;
    const rows = this.database.query(sql).all(...parameters) as T[];
    this.metrics.visitedRows += rows.length;
    return rows;
  }

  private readView(request: BindingInspectionRequest, signal?: AbortSignal): BindingInspectionDocument {
    if (signal?.aborted) throw new InspectionFailure('Inspection was cancelled.', 130);
    const binding = this.readBinding(request.source, request.record);
    const groups = this.readGroups(request.source, request.record);
    const currentMetadataKey = this.readCurrentMetadataKey(request.source, request.record);
    const runRow = this.readRunRow(request.source);
    const page = request.page !== undefined && request.request === undefined ? this.readPage(request, signal) : null;
    const detail =
      request.page !== undefined && request.request !== undefined ? this.readDetail(request, signal) : null;
    return {
      version: 1,
      source: request.source,
      record: request.record,
      capture: 'local',
      runRow,
      binding: {
        state: binding.state,
        subject: binding.subject,
        bootstrapKey: binding.bootstrapKey,
        currentMetadataKey,
        currentCoverKey: binding.currentCoverKey,
        storedCandidateCapacity: binding.storedCandidateCapacity,
        storedGroupCapacity: groups,
      },
      sections: {
        semantic: this.schema.semantic,
        candidates: this.schema.candidates,
        media: this.schema.media,
        metadata: this.schema.metadata,
      },
      page,
      request: detail,
      resume: bindingResumeGuidance(request.source),
    };
  }

  private readBinding(
    source: string,
    record: string,
  ): {
    state: BindingInspectionState;
    subject: string | null;
    bootstrapKey: string | null;
    currentCoverKey: string | null;
    storedCandidateCapacity: number | null;
  } {
    const row = this.get<BindingRow>(
      'SELECT source, external_id, state, subject, bootstrap_key, candidate_count, cover_key FROM binding_records WHERE source=? AND external_id=?',
      source,
      record,
    );
    if (!row) {
      return {
        state: 'absent',
        subject: null,
        bootstrapKey: null,
        currentCoverKey: null,
        storedCandidateCapacity: null,
      };
    }
    if (row.source !== source || row.external_id !== record)
      throw new InspectionFailure('Malformed journal row: binding identity does not match its lookup key.');
    if (row.state !== 'pending' && row.state !== 'bound' && row.state !== 'taken-down')
      throw new InspectionFailure('Malformed journal row: binding state is not a supported stored state.');
    const subject =
      row.subject === null
        ? null
        : typeof row.subject === 'string' && BINDING_UUID.test(row.subject)
          ? row.subject
          : null;
    if (row.subject !== null && subject === null)
      throw new InspectionFailure('Malformed journal row: locally acknowledged subject is not a stored identifier.');
    if (row.state === 'pending' && subject !== null)
      throw new InspectionFailure('Malformed journal row: a pending binding retains a subject identifier.');
    if (row.state === 'bound' && subject === null)
      throw new InspectionFailure('Malformed journal row: a bound record has no locally acknowledged subject.');
    const bootstrapKey =
      typeof row.bootstrap_key === 'string' &&
      utf8Bytes(row.bootstrap_key) <= 255 &&
      row.bootstrap_key.startsWith(`${source}:${record}:`)
        ? row.bootstrap_key
        : null;
    if (bootstrapKey === null)
      throw new InspectionFailure('Malformed journal row: bootstrap original request key is unsupported.');
    const currentCoverKey =
      row.cover_key === null
        ? null
        : typeof row.cover_key === 'string' &&
            utf8Bytes(row.cover_key) <= 255 &&
            row.cover_key.startsWith(`${source}:${record}:`)
          ? row.cover_key
          : null;
    if (row.cover_key !== null && currentCoverKey === null)
      throw new InspectionFailure('Malformed journal row: current cover journal key is unsupported.');
    const storedCandidateCapacity = integerOrNull(row.candidate_count);
    if (storedCandidateCapacity === null)
      throw new InspectionFailure('Malformed journal row: stored candidate capacity is not a bounded integer.');
    return {
      state: row.state,
      subject,
      bootstrapKey,
      currentCoverKey,
      storedCandidateCapacity,
    };
  }

  private readGroups(
    source: string,
    record: string,
  ): readonly { fieldGroup: BindingFieldGroup; storedCapacity: number }[] | null {
    if (this.schema.groups !== 'available') return null;
    const rows = this.all<GroupRow>(
      'SELECT field_group, candidate_count FROM binding_groups WHERE source=? AND external_id=? ORDER BY field_group',
      source,
      record,
    );
    const groups: { fieldGroup: BindingFieldGroup; storedCapacity: number }[] = [];
    for (const row of rows) {
      if (!isFieldGroup(row.field_group))
        throw new InspectionFailure('Malformed journal row: stored field group is unsupported.');
      const storedCapacity = integerOrNull(row.candidate_count);
      if (storedCapacity === null)
        throw new InspectionFailure('Malformed journal row: stored group capacity is not a bounded integer.');
      groups.push({ fieldGroup: row.field_group, storedCapacity });
    }
    return groups;
  }

  private readCurrentMetadataKey(source: string, record: string): string | null {
    if (this.schema.metadata !== 'available') return null;
    const row = this.get<{ key: unknown }>(
      'SELECT key FROM binding_metadata_current WHERE source=? AND external_id=?',
      source,
      record,
    );
    if (!row) return null;
    if (typeof row.key !== 'string' || utf8Bytes(row.key) > 255 || !row.key.startsWith(`${source}:${record}:`))
      throw new InspectionFailure('Malformed journal row: current metadata pointer is unsupported.');
    return row.key;
  }

  private readRunRow(source: string): BindingInspectionDocument['runRow'] {
    if (this.schema.runSources !== 'available') return 'unavailable';
    const row = this.get<{ source: unknown }>('SELECT source FROM run_sources WHERE source=?', source);
    if (!row) return 'absent';
    if (row.source !== source)
      throw new InspectionFailure('Malformed journal row: source identity does not match its lookup key.');
    return 'present';
  }

  private requireFamily(kind: BindingInspectionPageKind): void {
    const status = this.schema[kind];
    if (status === 'not-retained')
      throw new InspectionFailure(`The ${kind} journal family was not retained in this state file.`, 2);
    if (status !== 'available')
      throw new InspectionFailure(`The ${kind} journal family is present but cannot be interpreted safely.`, 1);
  }

  private readPage(request: BindingInspectionRequest, signal?: AbortSignal): BindingInspectionPage {
    if (signal?.aborted) throw new InspectionFailure('Inspection was cancelled.', 130);
    const kind = request.page!;
    this.requireFamily(kind);
    const limit = request.limit ?? DEFAULT_BINDING_PAGE_SIZE;
    const cursor =
      request.cursor === undefined ? null : decodeBindingCursor(request.cursor, request, this.schema.token);
    const fetched =
      kind === 'candidates'
        ? this.readCandidatePage(request.source, request.record, limit + 1, cursor, signal)
        : kind === 'media'
          ? this.readMediaPage(request.source, request.record, limit + 1, cursor, signal)
          : this.readJournalPage(kind, request.source, request.record, limit + 1, cursor, signal);
    const hasMore = fetched.length > limit;
    const rows = fetched.slice(0, limit);
    const last = rows.at(-1);
    return {
      kind,
      limit,
      end: hasMore ? 'more' : 'end',
      snapshot: 'local',
      ...(hasMore && last ? { nextCursor: nextBindingCursor(request, this.schema.token, last) } : {}),
      rows,
    };
  }

  private readDetail(request: BindingInspectionRequest, signal?: AbortSignal): BindingInspectionDetail {
    if (signal?.aborted) throw new InspectionFailure('Inspection was cancelled.', 130);
    const kind = request.page!;
    this.requireFamily(kind);
    const row =
      kind === 'candidates'
        ? this.readCandidateDetail(request.source, request.record, request.request!, signal)
        : kind === 'media'
          ? this.readMediaDetail(request.source, request.record, request.request!, signal)
          : this.readJournalDetail(kind, request.source, request.record, request.request!, signal);
    if (!row)
      return {
        category: kind,
        row: unavailableRow(kind, request.request!, 'No retained row exists for this exact original request.', {
          byteLength: null,
          sha256: null,
          digestOmitted: 'no stored body',
        }),
        explained:
          'This exact original request is not retained in the selected journal family. Inspection does not search other records or reverse-map identifiers.',
      };
    return {
      category: kind,
      row,
      explained: this.explain(kind, row),
    };
  }

  private explain(kind: BindingInspectionPageKind, row: BindingInspectionRow): string {
    if (row.display === 'unavailable')
      return `This row is retained but cannot be displayed safely: ${row.reason}. Original bytes were left unchanged.`;
    if (kind === 'semantic')
      return row.acknowledgement === 'present'
        ? 'A local acknowledgement is retained for this original semantic request. It is a local receipt, not current acceptance, adoption or a public fact.'
        : 'No local acknowledgement is retained for this original semantic request. Unknown delivery remains unknown.';
    if (kind === 'candidates')
      return 'This row is currently owned candidate capacity for the exact record. The stored count is local accounting, not a public vote total.';
    if (kind === 'media') {
      if (row.coverPermission === 'available-cover')
        return 'A local available media status is retained for this original media request. That is not a live native visibility check.';
      if (row.mediaAccepted === 'reserved')
        return 'A reserved media receipt is retained. A reserved receipt supplies no cover permission.';
      return 'This original media request is retained without an accepted receipt. Absence of a receipt is not proof that the server did nothing.';
    }
    return row.acknowledgement === 'present'
      ? 'A metadata acknowledgement is retained. It is separate from source licence, native current metadata and candidate publication.'
      : 'No metadata acknowledgement is retained for this original metadata request. Unknown delivery remains unknown.';
  }

  private readJournalPage(
    kind: 'semantic' | 'metadata',
    source: string,
    record: string,
    limit: number,
    cursor: Record<string, unknown> | null,
    signal?: AbortSignal,
  ): BindingInspectionRow[] {
    const after = cursor ? String(cursor.key) : '';
    const { table, select } = familySql(kind);
    const rows = this.all<JournalSqlRow>(
      `SELECT ${select} FROM ${table} WHERE source=? AND external_id=? AND key>? ORDER BY key LIMIT ?`,
      source,
      record,
      after,
      limit,
    );
    return rows.map((row) => this.projectJournal(kind, source, record, row, signal));
  }

  private readJournalDetail(
    kind: 'semantic' | 'metadata',
    source: string,
    record: string,
    key: string,
    signal?: AbortSignal,
  ): BindingInspectionRow | null {
    const { table, select } = familySql(kind);
    const row = this.get<JournalSqlRow>(
      `SELECT ${select} FROM ${table} WHERE source=? AND external_id=? AND key=?`,
      source,
      record,
      key,
    );
    return row ? this.projectJournal(kind, source, record, row, signal) : null;
  }

  private readCandidatePage(
    source: string,
    record: string,
    limit: number,
    cursor: Record<string, unknown> | null,
    signal?: AbortSignal,
  ): BindingInspectionRow[] {
    const afterGroup = cursor ? String(cursor.fieldGroup) : '';
    const afterCandidate = cursor ? String(cursor.candidate) : '';
    const rows = this.all<CandidateSqlRow>(
      `SELECT ${CANDIDATE_SELECT} FROM binding_candidates
        WHERE source=? AND external_id=? AND (field_group, candidate)>(?, ?)
        ORDER BY field_group, candidate LIMIT ?`,
      source,
      record,
      afterGroup,
      afterCandidate,
      limit,
    );
    return rows.map((row) => this.projectCandidate(source, record, row, signal));
  }

  private readCandidateDetail(
    source: string,
    record: string,
    locator: string,
    signal?: AbortSignal,
  ): BindingInspectionRow | null {
    const slash = locator.indexOf('/');
    const fieldGroup = locator.slice(0, slash);
    const candidate = locator.slice(slash + 1);
    if (!isFieldGroup(fieldGroup) || !BINDING_UUID.test(candidate))
      throw new InspectionFailure('Candidate locator must be field-group/candidate-uuid.', 2);
    const row = this.get<CandidateSqlRow>(
      `SELECT ${CANDIDATE_SELECT} FROM binding_candidates
        WHERE source=? AND external_id=? AND field_group=? AND candidate=?`,
      source,
      record,
      fieldGroup,
      candidate,
    );
    return row ? this.projectCandidate(source, record, row, signal) : null;
  }

  private readMediaPage(
    source: string,
    record: string,
    limit: number,
    cursor: Record<string, unknown> | null,
    signal?: AbortSignal,
  ): BindingInspectionRow[] {
    const after = cursor ? String(cursor.key) : '';
    const rows = this.all<MediaSqlRow>(
      `SELECT ${MEDIA_SELECT} FROM binding_media WHERE source=? AND external_id=? AND key>? ORDER BY key LIMIT ?`,
      source,
      record,
      after,
      limit,
    );
    return rows.map((row) => this.projectMedia(source, record, row, signal));
  }

  private readMediaDetail(
    source: string,
    record: string,
    key: string,
    signal?: AbortSignal,
  ): BindingInspectionRow | null {
    const row = this.get<MediaSqlRow>(
      `SELECT ${MEDIA_SELECT} FROM binding_media WHERE source=? AND external_id=? AND key=?`,
      source,
      record,
      key,
    );
    return row ? this.projectMedia(source, record, row, signal) : null;
  }

  private projectJournal(
    kind: 'semantic' | 'metadata',
    source: string,
    record: string,
    row: JournalSqlRow,
    signal?: AbortSignal,
  ): BindingInspectionRow {
    if (signal?.aborted) throw new InspectionFailure('Inspection was cancelled.', 130);
    const key = this.tryJournalKey(source, record, row.key);
    const byteLength = integerOrNull(row.byte_length);
    const loaded = typeof row.bytes === 'string' ? row.bytes : null;
    const body = projectBody(loaded, byteLength, this.metrics);
    if (!key)
      return unavailableRow(
        kind,
        typeof row.key === 'string' ? row.key : 'unknown',
        'stored request key is unsupported',
        body,
      );
    if (byteLength === null)
      return unavailableRow(kind, key, 'stored request body length is not a bounded integer', body);
    if (body.digestOmitted && byteLength > BINDING_BODY_BUDGET)
      return unavailableRow(kind, key, body.digestOmitted, body);
    const signature = safeSignature(row.signature);
    if (kind === 'semantic') {
      const decoded = decodeSemanticBody(loaded, this.metrics);
      const acknowledged = row.acknowledged === 1;
      if (row.acknowledged !== 0 && row.acknowledged !== 1)
        return unavailableRow(kind, key, 'acknowledgement presence flag is unsupported', body);
      const ackLength = row.acknowledged === 1 ? integerOrNull(row.ack_length) : null;
      const ackLoaded = typeof row.acknowledgement === 'string' ? row.acknowledgement : null;
      if (acknowledged && ackLength !== null && ackLength > BINDING_BODY_BUDGET) {
        return {
          ...this.semanticRow(key, signature, body, decoded, 'present', null),
          display: 'unavailable',
          reason: `stored acknowledgement exceeds the ${BINDING_BODY_BUDGET}-byte inspection budget`,
        };
      }
      const native = acknowledged ? decodeSemanticAck(ackLoaded, this.metrics) : null;
      if (!decoded.usable)
        return unavailableRow(kind, key, 'original request body is not a supported semantic shape', body);
      return this.semanticRow(key, signature, body, decoded, acknowledged ? 'present' : 'absent', native);
    }
    const decoded = decodeMetadataBody(loaded, this.metrics);
    const acknowledged = row.acknowledged === 1;
    if (row.acknowledged !== 0 && row.acknowledged !== 1)
      return unavailableRow(kind, key, 'acknowledgement presence flag is unsupported', body);
    const ackLoaded = typeof row.acknowledgement === 'string' ? row.acknowledgement : null;
    const ack = acknowledged
      ? decodeMetadataAck(ackLoaded, this.metrics)
      : { effect: null, metadataRevision: null, usable: false };
    if (!decoded.usable)
      return unavailableRow(kind, key, 'original metadata request body is not a supported shape', body);
    return {
      display: 'retained',
      category: 'metadata',
      key,
      ordering: {},
      reason: null,
      signature,
      body,
      operation: null,
      fieldGroup: null,
      acknowledgement: acknowledged ? 'present' : 'absent',
      native: ack.usable && ack.metadataRevision !== null ? { metadataRevision: ack.metadataRevision } : null,
      candidate: null,
      subject: null,
      originalKey: null,
      mediaAccepted: 'unavailable',
      mediaStatus: 'unavailable',
      coverPermission: 'none',
      metadataEffect: ack.effect,
      storedCapacityNote: null,
    };
  }

  private semanticRow(
    key: string,
    signature: string | null,
    body: BindingInspectionRow['body'],
    decoded: ReturnType<typeof decodeSemanticBody>,
    acknowledgement: 'absent' | 'present',
    native: BindingInspectionRow['native'],
  ): BindingInspectionRow {
    return {
      display: 'retained',
      category: 'semantic',
      key,
      ordering: {},
      reason: null,
      signature,
      body,
      operation: decoded.operation,
      fieldGroup: decoded.fieldGroup,
      acknowledgement,
      native,
      candidate: decoded.candidate,
      subject: decoded.subject,
      originalKey: null,
      mediaAccepted: 'unavailable',
      mediaStatus: 'unavailable',
      coverPermission: 'none',
      metadataEffect: null,
      storedCapacityNote: null,
    };
  }

  private projectCandidate(
    source: string,
    record: string,
    row: CandidateSqlRow,
    signal?: AbortSignal,
  ): BindingInspectionRow {
    if (signal?.aborted) throw new InspectionFailure('Inspection was cancelled.', 130);
    if (!isFieldGroup(row.field_group) || typeof row.candidate !== 'string' || !BINDING_UUID.test(row.candidate))
      return unavailableRow(
        'candidates',
        typeof row.candidate === 'string' ? row.candidate : 'unknown',
        'owned candidate identity is unsupported',
        projectBody(typeof row.bytes === 'string' ? row.bytes : null, integerOrNull(row.byte_length), this.metrics),
      );
    const key = candidateLocator(row.field_group, row.candidate);
    const byteLength = integerOrNull(row.byte_length);
    const loaded = typeof row.bytes === 'string' ? row.bytes : null;
    const body = projectBody(loaded, byteLength, this.metrics);
    if (byteLength === null || (body.digestOmitted && (byteLength ?? 0) > BINDING_BODY_BUDGET))
      return unavailableRow('candidates', key, body.digestOmitted ?? 'owned candidate body is unavailable', body, {
        fieldGroup: row.field_group,
        candidate: row.candidate,
      });
    const originalKey = this.optionalJournalKey(source, record, row.key);
    const subject = typeof row.subject === 'string' && BINDING_UUID.test(row.subject) ? row.subject : null;
    const decoded = decodeSemanticBody(loaded, this.metrics);
    if (!originalKey || !subject || !decoded.usable)
      return unavailableRow('candidates', key, 'owned candidate original request cannot be interpreted safely', body, {
        fieldGroup: row.field_group,
        candidate: row.candidate,
      });
    return {
      display: 'retained',
      category: 'candidates',
      key,
      ordering: { fieldGroup: row.field_group, candidate: row.candidate },
      reason: null,
      signature: safeSignature(row.signature),
      body,
      operation: decoded.operation,
      fieldGroup: row.field_group,
      acknowledgement: 'present',
      native: { subject, candidate: row.candidate },
      candidate: row.candidate,
      subject,
      originalKey,
      mediaAccepted: 'unavailable',
      mediaStatus: 'unavailable',
      coverPermission: 'none',
      metadataEffect: null,
      storedCapacityNote: 'stored owned-candidate capacity; not a public vote or count total',
    };
  }

  private projectMedia(source: string, record: string, row: MediaSqlRow, signal?: AbortSignal): BindingInspectionRow {
    if (signal?.aborted) throw new InspectionFailure('Inspection was cancelled.', 130);
    const key = this.tryJournalKey(source, record, row.key);
    const byteLength = integerOrNull(row.byte_length);
    const loaded = typeof row.bytes === 'string' ? row.bytes : null;
    const body = projectBody(loaded, byteLength, this.metrics);
    if (!key)
      return unavailableRow(
        'media',
        typeof row.key === 'string' ? row.key : 'unknown',
        'stored request key is unsupported',
        body,
      );
    if (byteLength === null || (body.digestOmitted && (byteLength ?? 0) > BINDING_BODY_BUDGET))
      return unavailableRow('media', key, body.digestOmitted ?? 'media request body is unavailable', body);
    const decoded = decodeMediaBody(loaded, this.metrics);
    const acceptedLength = integerOrNull(row.accepted_length);
    const statusLength = integerOrNull(row.status_length);
    if (acceptedLength !== null && acceptedLength > BINDING_BODY_BUDGET)
      return unavailableRow(
        'media',
        key,
        `stored accepted receipt exceeds the ${BINDING_BODY_BUDGET}-byte inspection budget`,
        body,
      );
    if (statusLength !== null && statusLength > BINDING_BODY_BUDGET)
      return unavailableRow(
        'media',
        key,
        `stored media status exceeds the ${BINDING_BODY_BUDGET}-byte inspection budget`,
        body,
      );
    const accepted = decodeMediaAccepted(typeof row.accepted === 'string' ? row.accepted : null, this.metrics);
    const status = decodeMediaStatus(typeof row.status === 'string' ? row.status : null, this.metrics);
    const hasAccepted = row.accepted !== null && row.accepted !== undefined;
    const hasStatus = row.status !== null && row.status !== undefined;
    if (!decoded.usable)
      return unavailableRow('media', key, 'original media request body is not a supported shape', body);
    const coverPermission = status.state === 'available' ? 'available-cover' : 'none';
    return {
      display: 'retained',
      category: 'media',
      key,
      ordering: {},
      reason: null,
      signature: safeSignature(row.signature),
      body,
      operation: null,
      fieldGroup: 'cover',
      acknowledgement: hasAccepted ? 'present' : 'absent',
      native: {
        ...(decoded.subject ? { subject: decoded.subject } : {}),
        ...(accepted.media ? { media: accepted.media } : status.media ? { media: status.media } : {}),
      },
      candidate: null,
      subject: decoded.subject,
      originalKey: null,
      mediaAccepted: hasAccepted ? (accepted.usable ? 'reserved' : 'unavailable') : 'absent',
      mediaStatus: hasStatus ? (status.state ?? 'unavailable') : 'absent',
      coverPermission,
      metadataEffect: null,
      storedCapacityNote: null,
    };
  }

  private tryJournalKey(source: string, record: string, value: unknown): string | null {
    if (typeof value !== 'string' || utf8Bytes(value) > 255 || !value.startsWith(`${source}:${record}:`)) return null;
    return value;
  }

  private optionalJournalKey(source: string, record: string, value: unknown): string | null {
    return this.tryJournalKey(source, record, value);
  }
}

export type { BindingInspectionDocument, BindingInspectionMetrics, BindingInspectionRequest };
