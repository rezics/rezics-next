import { Database } from 'bun:sqlite';

export type RecordState = 'present' | 'vanished';

export type RecordRow = {
  source: string;
  recordKey: string;
  recordRevision: string;
  digest: string;
  converter_revision: string;
  state: RecordState;
};

export type RecordStoreOptions = {
  /** Install database instrumentation before any statements are prepared. */
  instrumentDatabase?: (database: Database) => Database;
  onStatement?: (sql: string) => void;
};

const RECORDS_TABLE = 'acknowledged_records';
const COUNTS_TABLE = 'record_source_counts';

const RECORD_COLUMNS = `source,
  record_key AS recordKey,
  record_revision AS recordRevision,
  digest,
  converter_revision,
  state`;

export const RECORD_LOOKUP_SQL = `SELECT ${RECORD_COLUMNS}
FROM ${RECORDS_TABLE}
WHERE source = ? AND record_key = ?`;

const PAGE_FROM_START_SQL = `SELECT ${RECORD_COLUMNS}
FROM ${RECORDS_TABLE}
WHERE source = ?
ORDER BY record_key
LIMIT ?`;

const PAGE_AFTER_KEY_SQL = `SELECT ${RECORD_COLUMNS}
FROM ${RECORDS_TABLE}
WHERE source = ? AND record_key > ?
ORDER BY record_key
LIMIT ?`;

const UPSERT_RECORD_SQL = `INSERT INTO ${RECORDS_TABLE}
  (source, record_key, record_revision, digest, converter_revision, state)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(source, record_key) DO UPDATE SET
  record_revision = excluded.record_revision,
  digest = excluded.digest,
  converter_revision = excluded.converter_revision,
  state = excluded.state`;

const UPDATE_COUNT_SQL = `INSERT INTO ${COUNTS_TABLE} (source, present_count)
VALUES (?, ?)
ON CONFLICT(source) DO UPDATE SET
  present_count = ${COUNTS_TABLE}.present_count + excluded.present_count`;
const DECREMENT_COUNT_SQL = `UPDATE ${COUNTS_TABLE}
SET present_count = present_count + ?
WHERE source = ?`;
const PREVIOUS_STATE_SQL = `SELECT state FROM ${RECORDS_TABLE} WHERE source = ? AND record_key = ?`;

const ROW_FIELDS = new Set(['source', 'recordKey', 'recordRevision', 'digest', 'converter_revision', 'state']);

function requireBoundedString(name: string, value: unknown, maxBytes: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${name} must be a non-empty trimmed string`);
  }
  if (new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new RangeError(`${name} exceeds ${maxBytes} bytes`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} must not contain control characters`);
  }
}

function validateSource(source: unknown): asserts source is string {
  requireBoundedString('source', source, 64);
  if (!/^[a-z][a-z0-9_-]*$/u.test(source)) {
    throw new TypeError('source must be a lowercase source identifier');
  }
}

function validateRecordKey(recordKey: unknown): asserts recordKey is string {
  requireBoundedString('recordKey', recordKey, 512);
  if (
    !/^(?:[\p{L}\p{N}][\p{L}\p{N}._:/@+-]*|\/(?:works\/OL[1-9][0-9]*W|books\/OL[1-9][0-9]*M|authors\/OL[1-9][0-9]*A))$/u.test(
      recordKey,
    )
  ) {
    throw new TypeError('recordKey must be a source identifier');
  }
}

function validateRevision(name: string, revision: unknown, maxBytes: number): asserts revision is string {
  requireBoundedString(name, revision, maxBytes);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/u.test(revision)) {
    throw new TypeError(`${name} must be a revision identifier`);
  }
}

function validateRow(value: unknown): asserts value is RecordRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('record must be a metadata object');
  }

  const keys = Object.keys(value);
  if (keys.length !== ROW_FIELDS.size || keys.some((key) => !ROW_FIELDS.has(key))) {
    throw new TypeError('record must contain only acknowledged metadata fields');
  }

  const row = value as RecordRow;
  validateSource(row.source);
  validateRecordKey(row.recordKey);
  validateRevision('recordRevision', row.recordRevision, 256);
  if (typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(row.digest)) {
    throw new TypeError('digest must be a lowercase SHA-256 hex digest');
  }
  validateRevision('converter_revision', row.converter_revision, 128);
  if (row.state !== 'present' && row.state !== 'vanished') {
    throw new TypeError('state must be present or vanished');
  }
}

type StoredRecord = RecordRow;

/** Durable acknowledged source metadata, independent of content and converter storage. */
export class RecordStore {
  readonly database: Database;

  private readonly onStatement: ((sql: string) => void) | undefined;
  private readonly ownsDatabase: boolean;
  private readonly recordLookupStatement!: ReturnType<Database['query']>;
  private readonly previousStateStatement!: ReturnType<Database['query']>;
  private readonly upsertRecordStatement!: ReturnType<Database['query']>;
  private readonly updateCountStatement!: ReturnType<Database['query']>;
  private readonly decrementCountStatement!: ReturnType<Database['query']>;
  private readonly countStatement!: ReturnType<Database['query']>;
  private readonly pageFromStartStatement!: ReturnType<Database['query']>;
  private readonly pageAfterKeyStatement!: ReturnType<Database['query']>;
  private closed = false;

  constructor(path: string | Database, options: RecordStoreOptions = {}) {
    this.onStatement = options.onStatement;
    let database: Database;
    if (typeof path === 'string') {
      this.ownsDatabase = true;
      database = new Database(path, { create: true, strict: true });
    } else {
      this.ownsDatabase = false;
      database = path;
    }
    try {
      this.database = options.instrumentDatabase?.(database) ?? database;
    } catch (error) {
      if (this.ownsDatabase) database.close();
      throw error;
    }

    try {
      this.execute('PRAGMA journal_mode = WAL');
      this.execute('PRAGMA busy_timeout = 5000');
      this.execute('PRAGMA synchronous = NORMAL');
      this.execute(`CREATE TABLE IF NOT EXISTS ${RECORDS_TABLE} (
        source TEXT NOT NULL,
        record_key TEXT NOT NULL,
        record_revision TEXT NOT NULL,
        digest TEXT NOT NULL CHECK (length(digest) = 64),
        converter_revision TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('present', 'vanished')),
        PRIMARY KEY (source, record_key)
      ) WITHOUT ROWID`);
      this.execute(`CREATE TABLE IF NOT EXISTS ${COUNTS_TABLE} (
        source TEXT PRIMARY KEY,
        present_count INTEGER NOT NULL CHECK (present_count >= 0)
      ) WITHOUT ROWID`);
      this.recordLookupStatement = this.database.query(RECORD_LOOKUP_SQL);
      this.previousStateStatement = this.database.query(PREVIOUS_STATE_SQL);
      this.upsertRecordStatement = this.database.query(UPSERT_RECORD_SQL);
      this.updateCountStatement = this.database.query(UPDATE_COUNT_SQL);
      this.decrementCountStatement = this.database.query(DECREMENT_COUNT_SQL);
      this.countStatement = this.database.query(`SELECT present_count FROM ${COUNTS_TABLE} WHERE source = ?`);
      this.pageFromStartStatement = this.database.query(PAGE_FROM_START_SQL);
      this.pageAfterKeyStatement = this.database.query(PAGE_AFTER_KEY_SQL);
    } catch (error) {
      this.closed = true;
      if (this.ownsDatabase) this.database.close();
      throw error;
    }
  }

  get(source: string, recordKey: string): RecordRow | null {
    this.assertOpen();
    validateSource(source);
    validateRecordKey(recordKey);
    this.onStatement?.(RECORD_LOOKUP_SQL);
    return (this.recordLookupStatement.get(source, recordKey) as StoredRecord | null) ?? null;
  }

  put(row: RecordRow): void {
    this.assertOpen();
    validateRow(row);

    this.execute('BEGIN IMMEDIATE');
    try {
      this.onStatement?.(PREVIOUS_STATE_SQL);
      const previous = this.previousStateStatement.get(row.source, row.recordKey) as { state: RecordState } | null;

      this.onStatement?.(UPSERT_RECORD_SQL);
      this.upsertRecordStatement.run(
        row.source,
        row.recordKey,
        row.recordRevision,
        row.digest,
        row.converter_revision,
        row.state,
      );

      const oldPresent = previous?.state === 'present' ? 1 : 0;
      const newPresent = row.state === 'present' ? 1 : 0;
      const change = newPresent - oldPresent;
      if (change > 0) {
        this.onStatement?.(UPDATE_COUNT_SQL);
        this.updateCountStatement.run(row.source, change);
      } else if (change < 0) {
        this.onStatement?.(DECREMENT_COUNT_SQL);
        this.decrementCountStatement.run(change, row.source);
      }

      this.execute('COMMIT');
    } catch (error) {
      try {
        this.execute('ROLLBACK');
      } catch {
        // Keep the original failure if rollback itself reports an error.
      }
      throw error;
    }
  }

  count(source: string): number {
    this.assertOpen();
    validateSource(source);
    const sql = `SELECT present_count FROM ${COUNTS_TABLE} WHERE source = ?`;
    this.onStatement?.(sql);
    const result = this.countStatement.get(source) as { present_count: number } | null;
    return result?.present_count ?? 0;
  }

  page(source: string, options: { after?: string | null; limit: number }): RecordRow[] {
    this.assertOpen();
    validateSource(source);
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new RangeError('page limit must be an integer from 1 through 100');
    }

    if (options.after === undefined || options.after === null) {
      this.onStatement?.(PAGE_FROM_START_SQL);
      return this.pageFromStartStatement.all(source, options.limit) as RecordRow[];
    }

    validateRecordKey(options.after);
    this.onStatement?.(PAGE_AFTER_KEY_SQL);
    return this.pageAfterKeyStatement.all(source, options.after, options.limit) as RecordRow[];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsDatabase) this.database.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('record store is closed');
  }

  private execute(sql: string): void {
    this.onStatement?.(sql);
    this.database.exec(sql);
  }
}
