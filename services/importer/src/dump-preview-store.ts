import { Database } from 'bun:sqlite';
import { RecordStore, type RecordRow } from './record-store.ts';
import { MAX_DUMP_RECORD_BYTES } from './dumps-bytes.ts';

export const DEFAULT_PREVIEW_PAGE = 20;
export const MAX_PREVIEW_PAGE = 100;
export const MAX_PREVIEW_STORE_BYTES = 256 * 1024 * 1024;
export const DEFAULT_DISAPPEARANCE_THRESHOLD = 0.2;

export type PreviewKind = 'new' | 'changed' | 'unchanged' | 'vanished';
export type PreviewViewKind = 'first-import' | 'baseline-comparison';

export type PreviewPlan = Readonly<{
  previewId: string;
  source: string;
  sourceKind: string;
  converterRevision: string;
  dumpPath: string;
  viewKind: PreviewViewKind;
  baselineId: string | null;
  baselinePresent: number;
  complete: boolean;
  errorIdentity: string | null;
  errorMessage: string | null;
  disappearanceWouldBlock: boolean;
  admitted: number;
  skipped: number;
  newCount: number;
  changedCount: number;
  unchangedCount: number;
  vanishedCount: number;
  prior: number;
  survivors: number;
  storedBytes: number;
}>;

export type PreviewRecordRow = Readonly<{
  recordKey: string;
  kind: Exclude<PreviewKind, 'vanished'>;
  recordRevision: string;
  digest: string;
  converterRevision: string;
  skipped: boolean;
  comparisonJson: string;
  displayJson: string;
  diagnosticsJson: string;
  operationsJson: string;
  provenanceJson: string;
}>;

export type PreviewVanishedRow = Readonly<{
  recordKey: string;
  recordRevision: string;
  digest: string;
  converterRevision: string;
  subjectBinding: string | null;
}>;

export type PreviewPage<T> = Readonly<{
  kind: PreviewKind;
  limit: number;
  end: 'end' | 'more';
  nextCursor?: string;
  rows: readonly T[];
}>;

const RECORD_KEY =
  /^(?:[\p{L}\p{N}][\p{L}\p{N}._:/@+\-]*|\/(?:works\/OL[1-9][0-9]*W|books\/OL[1-9][0-9]*M|authors\/OL[1-9][0-9]*A))$/u;
const SOURCE_ID = /^[a-z][a-z0-9_-]{0,31}$/u;

export class PreviewStoreFailure extends Error {
  constructor(
    message: string,
    readonly code: number = 1,
  ) {
    super(message);
  }
}

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function validSource(value: string): void {
  if (!SOURCE_ID.test(value) || bytes(value) > 32) throw new PreviewStoreFailure('Source identifier is invalid.', 2);
}

function validRecordKey(value: string): void {
  if (bytes(value) > 512 || !RECORD_KEY.test(value))
    throw new PreviewStoreFailure('Record key must be an exact native source record key.', 2);
}

function cursorEncode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function cursorDecode(
  value: string,
  previewId: string,
  source: string,
  kind: PreviewKind,
): { record: string } {
  if (bytes(value) > 2048 || !/^[A-Za-z0-9_-]+$/u.test(value))
    throw new PreviewStoreFailure('Cursor is malformed or exceeds its bound.', 2);
  let decoded: string;
  let cursor: unknown;
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) throw new Error('noncanonical');
    cursor = JSON.parse(decoded) as unknown;
  } catch {
    throw new PreviewStoreFailure('Cursor is malformed or noncanonical.', 2);
  }
  if (
    !cursor ||
    typeof cursor !== 'object' ||
    Array.isArray(cursor) ||
    Object.getPrototypeOf(cursor) !== Object.prototype
  )
    throw new PreviewStoreFailure('Cursor is malformed or noncanonical.', 2);
  const result = cursor as Record<string, unknown>;
  const keys = Object.keys(result);
  if (keys.length !== 5 || keys.some((key) => !['v', 'preview', 'source', 'kind', 'record'].includes(key)))
    throw new PreviewStoreFailure('Cursor is malformed or noncanonical.', 2);
  if (result.v !== 1 || result.preview !== previewId || result.source !== source || result.kind !== kind)
    throw new PreviewStoreFailure('Cursor belongs to a different preview, source or page.', 2);
  if (typeof result.record !== 'string') throw new PreviewStoreFailure('Cursor record ordering key is invalid.', 2);
  validRecordKey(result.record);
  return { record: result.record };
}

export class DumpPreviewStore {
  readonly database: Database;
  readonly records: RecordStore;
  private closed = false;
  private storedBytes = 0;
  private readonly ceiling: number;

  constructor(
    path: string | Database,
    options: { maxStoreBytes?: number } = {},
  ) {
    this.ceiling = options.maxStoreBytes ?? MAX_PREVIEW_STORE_BYTES;
    if (!Number.isSafeInteger(this.ceiling) || this.ceiling < 1)
      throw new PreviewStoreFailure('Preview storage ceiling is invalid.', 2);
    this.database = typeof path === 'string' ? new Database(path, { create: true, strict: true }) : path;
    try {
      this.database.exec('PRAGMA journal_mode = WAL');
      this.database.exec('PRAGMA busy_timeout = 5000');
      this.database.exec('PRAGMA synchronous = NORMAL');
      this.database.exec(`CREATE TABLE IF NOT EXISTS preview_plans (
        preview_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        converter_revision TEXT NOT NULL,
        dump_path TEXT NOT NULL,
        view_kind TEXT NOT NULL,
        baseline_id TEXT,
        baseline_present INTEGER NOT NULL,
        complete INTEGER NOT NULL,
        error_identity TEXT,
        error_message TEXT,
        disappearance_would_block INTEGER NOT NULL,
        admitted INTEGER NOT NULL,
        skipped INTEGER NOT NULL,
        new_count INTEGER NOT NULL,
        changed_count INTEGER NOT NULL,
        unchanged_count INTEGER NOT NULL,
        vanished_count INTEGER NOT NULL,
        prior INTEGER NOT NULL,
        survivors INTEGER NOT NULL,
        stored_bytes INTEGER NOT NULL
      ) WITHOUT ROWID`);
      this.database.exec(`CREATE TABLE IF NOT EXISTS preview_records (
        preview_id TEXT NOT NULL,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        record_key TEXT NOT NULL,
        record_revision TEXT NOT NULL,
        digest TEXT NOT NULL,
        converter_revision TEXT NOT NULL,
        skipped INTEGER NOT NULL,
        comparison_json TEXT NOT NULL,
        display_json TEXT NOT NULL,
        diagnostics_json TEXT NOT NULL,
        operations_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        PRIMARY KEY (preview_id, source, record_key)
      ) WITHOUT ROWID`);
      this.database.exec(
        'CREATE INDEX IF NOT EXISTS preview_kind_order ON preview_records(preview_id, source, kind, record_key)',
      );
      this.database.exec(`CREATE TABLE IF NOT EXISTS preview_vanished (
        preview_id TEXT NOT NULL,
        source TEXT NOT NULL,
        record_key TEXT NOT NULL,
        record_revision TEXT NOT NULL,
        digest TEXT NOT NULL,
        converter_revision TEXT NOT NULL,
        subject_binding TEXT,
        PRIMARY KEY (preview_id, source, record_key)
      ) WITHOUT ROWID`);
      this.database.exec(
        'CREATE INDEX IF NOT EXISTS preview_vanished_order ON preview_vanished(preview_id, source, record_key)',
      );
      this.database.exec(`CREATE TABLE IF NOT EXISTS preview_baseline_projections (
        source TEXT NOT NULL,
        record_key TEXT NOT NULL,
        comparison_json TEXT NOT NULL,
        subject_binding TEXT,
        PRIMARY KEY (source, record_key)
      ) WITHOUT ROWID`);
      this.records = new RecordStore(this.database);
    } catch (error) {
      this.closed = true;
      if (typeof path === 'string') this.database.close();
      throw error;
    }
  }

  beginPlan(plan: {
    previewId: string;
    source: string;
    sourceKind: string;
    converterRevision: string;
    dumpPath: string;
    viewKind: PreviewViewKind;
    baselineId: string | null;
    baselinePresent: number;
  }): void {
    this.assertOpen();
    validSource(plan.source);
    this.database
      .query(
        `INSERT INTO preview_plans(
          preview_id,source,source_kind,converter_revision,dump_path,view_kind,baseline_id,baseline_present,
          complete,error_identity,error_message,disappearance_would_block,admitted,skipped,new_count,changed_count,
          unchanged_count,vanished_count,prior,survivors,stored_bytes
        ) VALUES (?,?,?,?,?,?,?,?,0,NULL,NULL,0,0,0,0,0,0,0,?,?,0)`,
      )
      .run(
        plan.previewId,
        plan.source,
        plan.sourceKind,
        plan.converterRevision,
        plan.dumpPath,
        plan.viewKind,
        plan.baselineId,
        plan.baselinePresent,
        plan.baselinePresent,
        0,
      );
  }

  captureBaselineMember(row: RecordRow, comparisonJson: string, subjectBinding: string | null): void {
    this.assertOpen();
    this.charge(bytes(comparisonJson) + (subjectBinding ? bytes(subjectBinding) : 0) + 256);
    this.records.put(row);
    this.database
      .query(
        `INSERT INTO preview_baseline_projections(source,record_key,comparison_json,subject_binding)
         VALUES (?,?,?,?)`,
      )
      .run(row.source, row.recordKey, comparisonJson, subjectBinding);
  }

  baselineMember(source: string, recordKey: string): {
    row: RecordRow;
    comparisonJson: string;
    subjectBinding: string | null;
  } | null {
    this.assertOpen();
    const row = this.records.get(source, recordKey);
    if (!row || row.state !== 'present') return null;
    const extra = this.database
      .query(
        `SELECT comparison_json AS comparisonJson, subject_binding AS subjectBinding
         FROM preview_baseline_projections WHERE source=? AND record_key=?`,
      )
      .get(source, recordKey) as { comparisonJson: string; subjectBinding: string | null } | null;
    if (!extra) return { row, comparisonJson: '', subjectBinding: null };
    return { row, comparisonJson: extra.comparisonJson, subjectBinding: extra.subjectBinding };
  }

  pageBaseline(source: string, after: string | null, limit: number): RecordRow[] {
    this.assertOpen();
    return this.records.page(source, { ...(after ? { after } : {}), limit });
  }

  insertRecord(previewId: string, source: string, record: PreviewRecordRow): 'inserted' | 'duplicate' {
    this.assertOpen();
    validSource(source);
    validRecordKey(record.recordKey);
    const payload =
      bytes(record.comparisonJson) +
      bytes(record.displayJson) +
      bytes(record.diagnosticsJson) +
      bytes(record.operationsJson) +
      bytes(record.provenanceJson);
    if (payload > MAX_DUMP_RECORD_BYTES) throw new PreviewStoreFailure('Preview record projection exceeds its bound.');
    this.charge(payload + 256);
    const inserted = this.database
      .query(
        `INSERT OR IGNORE INTO preview_records(
          preview_id,source,kind,record_key,record_revision,digest,converter_revision,skipped,
          comparison_json,display_json,diagnostics_json,operations_json,provenance_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        previewId,
        source,
        record.kind,
        record.recordKey,
        record.recordRevision,
        record.digest,
        record.converterRevision,
        record.skipped ? 1 : 0,
        record.comparisonJson,
        record.displayJson,
        record.diagnosticsJson,
        record.operationsJson,
        record.provenanceJson,
      );
    if (!inserted.changes) return 'duplicate';
    this.database
      .query(
        `UPDATE preview_plans SET admitted=admitted+1, skipped=skipped+?, new_count=new_count+?,
         changed_count=changed_count+?, unchanged_count=unchanged_count+?, stored_bytes=?
         WHERE preview_id=?`,
      )
      .run(
        record.skipped ? 1 : 0,
        record.kind === 'new' ? 1 : 0,
        record.kind === 'changed' ? 1 : 0,
        record.kind === 'unchanged' ? 1 : 0,
        this.storedBytes,
        previewId,
      );
    return 'inserted';
  }

  markSurvivor(previewId: string): void {
    this.assertOpen();
    this.database.query('UPDATE preview_plans SET survivors=survivors+1 WHERE preview_id=?').run(previewId);
  }

  insertVanished(previewId: string, source: string, row: PreviewVanishedRow): void {
    this.assertOpen();
    validRecordKey(row.recordKey);
    this.charge(256);
    this.database
      .query(
        `INSERT INTO preview_vanished(
          preview_id,source,record_key,record_revision,digest,converter_revision,subject_binding
        ) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        previewId,
        source,
        row.recordKey,
        row.recordRevision,
        row.digest,
        row.converterRevision,
        row.subjectBinding,
      );
    this.database
      .query('UPDATE preview_plans SET vanished_count=vanished_count+1, stored_bytes=? WHERE preview_id=?')
      .run(this.storedBytes, previewId);
  }

  hasRecord(previewId: string, source: string, recordKey: string): boolean {
    this.assertOpen();
    return !!this.database
      .query('SELECT 1 AS found FROM preview_records WHERE preview_id=? AND source=? AND record_key=?')
      .get(previewId, source, recordKey);
  }

  seal(
    previewId: string,
    input:
      | { complete: true; disappearanceWouldBlock: boolean }
      | { complete: false; errorIdentity: string; errorMessage: string },
  ): PreviewPlan {
    this.assertOpen();
    if (input.complete) {
      this.database
        .query(
          `UPDATE preview_plans SET complete=1, disappearance_would_block=?, stored_bytes=? WHERE preview_id=?`,
        )
        .run(input.disappearanceWouldBlock ? 1 : 0, this.storedBytes, previewId);
    } else {
      this.database
        .query(
          `UPDATE preview_plans SET complete=0, error_identity=?, error_message=?, vanished_count=0,
           disappearance_would_block=0, stored_bytes=? WHERE preview_id=?`,
        )
        .run(input.errorIdentity, input.errorMessage, this.storedBytes, previewId);
      this.database.query('DELETE FROM preview_vanished WHERE preview_id=?').run(previewId);
    }
    return this.plan(previewId);
  }

  plan(previewId: string): PreviewPlan {
    this.assertOpen();
    const row = this.database.query('SELECT * FROM preview_plans WHERE preview_id=?').get(previewId) as
      | Record<string, unknown>
      | null;
    if (!row) throw new PreviewStoreFailure('Preview plan is missing.');
    return {
      previewId: String(row.preview_id),
      source: String(row.source),
      sourceKind: String(row.source_kind),
      converterRevision: String(row.converter_revision),
      dumpPath: String(row.dump_path),
      viewKind: row.view_kind as PreviewViewKind,
      baselineId: row.baseline_id === null ? null : String(row.baseline_id),
      baselinePresent: Number(row.baseline_present),
      complete: Number(row.complete) === 1,
      errorIdentity: row.error_identity === null ? null : String(row.error_identity),
      errorMessage: row.error_message === null ? null : String(row.error_message),
      disappearanceWouldBlock: Number(row.disappearance_would_block) === 1,
      admitted: Number(row.admitted),
      skipped: Number(row.skipped),
      newCount: Number(row.new_count),
      changedCount: Number(row.changed_count),
      unchangedCount: Number(row.unchanged_count),
      vanishedCount: Number(row.vanished_count),
      prior: Number(row.prior),
      survivors: Number(row.survivors),
      storedBytes: Number(row.stored_bytes),
    };
  }

  loadPlan(): PreviewPlan | null {
    this.assertOpen();
    const row = this.database.query('SELECT preview_id FROM preview_plans LIMIT 2').all() as { preview_id: string }[];
    if (row.length !== 1) return null;
    return this.plan(row[0]!.preview_id);
  }

  pageRecords(
    previewId: string,
    source: string,
    kind: Exclude<PreviewKind, 'vanished'>,
    options: { limit?: number; cursor?: string },
  ): PreviewPage<{ recordKey: string; kind: string; recordRevision: string; digest: string; skipped: boolean }> {
    this.assertOpen();
    const limit = options.limit ?? DEFAULT_PREVIEW_PAGE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PREVIEW_PAGE)
      throw new PreviewStoreFailure('Page size must be an integer from 1 through 100.', 2);
    const after = options.cursor ? cursorDecode(options.cursor, previewId, source, kind).record : null;
    const rows =
      after === null
        ? (this.database
            .query(
              `SELECT record_key AS recordKey, kind, record_revision AS recordRevision, digest, skipped
               FROM preview_records INDEXED BY preview_kind_order
               WHERE preview_id=? AND source=? AND kind=?
               ORDER BY record_key LIMIT ?`,
            )
            .all(previewId, source, kind, limit + 1) as {
            recordKey: string;
            kind: string;
            recordRevision: string;
            digest: string;
            skipped: number;
          }[])
        : (this.database
            .query(
              `SELECT record_key AS recordKey, kind, record_revision AS recordRevision, digest, skipped
               FROM preview_records INDEXED BY preview_kind_order
               WHERE preview_id=? AND source=? AND kind=? AND record_key>?
               ORDER BY record_key LIMIT ?`,
            )
            .all(previewId, source, kind, after, limit + 1) as {
            recordKey: string;
            kind: string;
            recordRevision: string;
            digest: string;
            skipped: number;
          }[]);
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      kind,
      limit,
      end: more ? 'more' : 'end',
      ...(more
        ? {
            nextCursor: cursorEncode({
              v: 1,
              preview: previewId,
              source,
              kind,
              record: page.at(-1)!.recordKey,
            }),
          }
        : {}),
      rows: page.map((row) => ({
        recordKey: row.recordKey,
        kind: row.kind,
        recordRevision: row.recordRevision,
        digest: row.digest,
        skipped: row.skipped === 1,
      })),
    };
  }

  pageVanished(
    previewId: string,
    source: string,
    options: { limit?: number; cursor?: string },
  ): PreviewPage<PreviewVanishedRow> {
    this.assertOpen();
    const plan = this.plan(previewId);
    if (!plan.complete)
      throw new PreviewStoreFailure('Incomplete input cannot present a vanished membership page.', 2);
    const limit = options.limit ?? DEFAULT_PREVIEW_PAGE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PREVIEW_PAGE)
      throw new PreviewStoreFailure('Page size must be an integer from 1 through 100.', 2);
    const after = options.cursor ? cursorDecode(options.cursor, previewId, source, 'vanished').record : null;
    const rows =
      after === null
        ? (this.database
            .query(
              `SELECT record_key AS recordKey, record_revision AS recordRevision, digest,
                      converter_revision AS converterRevision, subject_binding AS subjectBinding
               FROM preview_vanished INDEXED BY preview_vanished_order
               WHERE preview_id=? AND source=?
               ORDER BY record_key LIMIT ?`,
            )
            .all(previewId, source, limit + 1) as {
            recordKey: string;
            recordRevision: string;
            digest: string;
            converterRevision: string;
            subjectBinding: string | null;
          }[])
        : (this.database
            .query(
              `SELECT record_key AS recordKey, record_revision AS recordRevision, digest,
                      converter_revision AS converterRevision, subject_binding AS subjectBinding
               FROM preview_vanished INDEXED BY preview_vanished_order
               WHERE preview_id=? AND source=? AND record_key>?
               ORDER BY record_key LIMIT ?`,
            )
            .all(previewId, source, after, limit + 1) as {
            recordKey: string;
            recordRevision: string;
            digest: string;
            converterRevision: string;
            subjectBinding: string | null;
          }[]);
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      kind: 'vanished',
      limit,
      end: more ? 'more' : 'end',
      ...(more
        ? {
            nextCursor: cursorEncode({
              v: 1,
              preview: previewId,
              source,
              kind: 'vanished',
              record: page.at(-1)!.recordKey,
            }),
          }
        : {}),
      rows: page,
    };
  }

  recordDetail(
    previewId: string,
    source: string,
    recordKey: string,
  ):
    | { found: false; recordKey: string }
    | ({ found: true; kind: Exclude<PreviewKind, 'vanished'> } & PreviewRecordRow)
    | ({ found: true; kind: 'vanished' } & PreviewVanishedRow) {
    this.assertOpen();
    validRecordKey(recordKey);
    const present = this.database
      .query(
        `SELECT record_key AS recordKey, kind, record_revision AS recordRevision, digest,
                converter_revision AS converterRevision, skipped, comparison_json AS comparisonJson,
                display_json AS displayJson, diagnostics_json AS diagnosticsJson,
                operations_json AS operationsJson, provenance_json AS provenanceJson
         FROM preview_records WHERE preview_id=? AND source=? AND record_key=?`,
      )
      .get(previewId, source, recordKey) as
      | (PreviewRecordRow & { kind: Exclude<PreviewKind, 'vanished'>; skipped: number })
      | null;
    if (present)
      return {
        found: true,
        kind: present.kind,
        recordKey: present.recordKey,
        recordRevision: present.recordRevision,
        digest: present.digest,
        converterRevision: present.converterRevision,
        skipped: present.skipped === 1,
        comparisonJson: present.comparisonJson,
        displayJson: present.displayJson,
        diagnosticsJson: present.diagnosticsJson,
        operationsJson: present.operationsJson,
        provenanceJson: present.provenanceJson,
      };
    const vanished = this.database
      .query(
        `SELECT record_key AS recordKey, record_revision AS recordRevision, digest,
                converter_revision AS converterRevision, subject_binding AS subjectBinding
         FROM preview_vanished WHERE preview_id=? AND source=? AND record_key=?`,
      )
      .get(previewId, source, recordKey) as PreviewVanishedRow | null;
    if (vanished) return { found: true, kind: 'vanished', ...vanished };
    return { found: false, recordKey };
  }

  explainKindPage(): string {
    this.assertOpen();
    return this.database
      .query(
        `EXPLAIN QUERY PLAN SELECT record_key FROM preview_records INDEXED BY preview_kind_order
         WHERE preview_id=? AND source=? AND kind=? AND record_key>? ORDER BY record_key LIMIT ?`,
      )
      .all('p', 's', 'new', 'a', 21)
      .map((row) => String((row as { detail: string }).detail))
      .join('\n');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.records.close();
    } finally {
      this.database.close();
    }
  }

  private charge(amount: number): void {
    const next = this.storedBytes + amount;
    if (next > this.ceiling) throw new PreviewStoreFailure('Preview storage exceeded its configured ceiling.');
    this.storedBytes = next;
  }

  private assertOpen(): void {
    if (this.closed) throw new PreviewStoreFailure('Preview store is closed.');
  }
}
