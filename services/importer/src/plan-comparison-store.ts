import { Database } from 'bun:sqlite';
import { MAX_DUMP_RECORD_BYTES } from './dumps-bytes.ts';
import { MAX_PREVIEW_STORE_BYTES } from './dump-preview-store.ts';

export const DEFAULT_COMPARISON_PAGE = 20;
export const MAX_COMPARISON_PAGE = 100;
export const MAX_COMPARISON_STORE_BYTES = MAX_PREVIEW_STORE_BYTES;
export const COMPARISON_FORMAT_VERSION = 1;
export const MAX_COMPARISON_PARTS_PER_RECORD = 4096;

export const COMPARISON_TABLES = ['comparison_plans', 'comparison_records', 'comparison_parts'] as const;

export type ComparisonKind = 'only-left' | 'only-right' | 'changed' | 'unchanged' | 'skipped' | 'unavailable';

export type ComparisonPlan = Readonly<{
  comparisonId: string;
  version: number;
  captureDigest: string;
  source: string;
  sourceKind: string;
  leftPreviewId: string;
  rightPreviewId: string;
  leftConverter: string;
  rightConverter: string;
  leftDump: string;
  rightDump: string;
  leftView: string;
  rightView: string;
  leftBaseline: string | null;
  rightBaseline: string | null;
  leftBaselinePresent: number;
  rightBaselinePresent: number;
  leftAdmitted: number;
  rightAdmitted: number;
  leftSkipped: number;
  rightSkipped: number;
  leftVanished: number;
  rightVanished: number;
  inputDiffers: boolean;
  converterDiffers: boolean;
  complete: boolean;
  errorIdentity: string | null;
  errorMessage: string | null;
  onlyLeftCount: number;
  onlyRightCount: number;
  changedCount: number;
  unchangedCount: number;
  skippedCount: number;
  unavailableCount: number;
  storedBytes: number;
}>;

export type ComparisonRecordRow = Readonly<{
  recordKey: string;
  kind: ComparisonKind;
  leftKind: string | null;
  rightKind: string | null;
  leftDigest: string | null;
  rightDigest: string | null;
  leftRevision: string | null;
  rightRevision: string | null;
  leftConverter: string | null;
  rightConverter: string | null;
  leftSkipped: boolean | null;
  rightSkipped: boolean | null;
  leftVanished: boolean;
  rightVanished: boolean;
  digestDiffers: boolean;
  converterDiffers: boolean;
  retainedEqual: boolean;
  summaryJson: string;
  leftJson: string | null;
  rightJson: string | null;
}>;

export type ComparisonPartRow = Readonly<{
  address: string;
  domain: string;
  change: 'added' | 'removed' | 'changed' | 'unchanged';
  beforeJson: string | null;
  afterJson: string | null;
  ordinal: number;
}>;

export type ComparisonPage<T> = Readonly<{
  kind: ComparisonKind;
  limit: number;
  rows: readonly T[];
}> &
  (Readonly<{ end: 'more'; nextCursor: string }> | Readonly<{ end: 'end' }>);

export type ComparisonPartPage = Readonly<{
  recordKey: string;
  limit: number;
  rows: readonly ComparisonPartRow[];
}> &
  (Readonly<{ end: 'more'; nextCursor: string }> | Readonly<{ end: 'end' }>);

const RECORD_KEY =
  /^(?:[\p{L}\p{N}][\p{L}\p{N}._:/@+\-]*|\/(?:works\/OL[1-9][0-9]*W|books\/OL[1-9][0-9]*M|authors\/OL[1-9][0-9]*A))$/u;
const SOURCE_ID = /^[a-z][a-z0-9_-]{0,31}$/u;
const KINDS = new Set<ComparisonKind>(['only-left', 'only-right', 'changed', 'unchanged', 'skipped', 'unavailable']);

export class ComparisonStoreFailure extends Error {
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
  if (!SOURCE_ID.test(value) || bytes(value) > 32) throw new ComparisonStoreFailure('Source identifier is invalid.', 2);
}

export function validComparisonRecordKey(value: string): void {
  if (bytes(value) > 512 || !RECORD_KEY.test(value))
    throw new ComparisonStoreFailure('Record key must be an exact native source record key.', 2);
}

export function isComparisonKind(value: string): value is ComparisonKind {
  return KINDS.has(value as ComparisonKind);
}

function cursorEncode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function cursorObject(value: string): Record<string, unknown> {
  if (bytes(value) > 2048 || !/^[A-Za-z0-9_-]+$/u.test(value))
    throw new ComparisonStoreFailure('Cursor is malformed or exceeds its bound.', 2);
  let decoded: string;
  let cursor: unknown;
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) throw new Error('noncanonical');
    cursor = JSON.parse(decoded) as unknown;
  } catch {
    throw new ComparisonStoreFailure('Cursor is malformed or noncanonical.', 2);
  }
  if (
    !cursor ||
    typeof cursor !== 'object' ||
    Array.isArray(cursor) ||
    Object.getPrototypeOf(cursor) !== Object.prototype
  )
    throw new ComparisonStoreFailure('Cursor is malformed or noncanonical.', 2);
  return cursor as Record<string, unknown>;
}

function bindCursor(
  value: string,
  expected: { comparisonId: string; captureDigest: string; keys: readonly string[] },
): Record<string, unknown> {
  const result = cursorObject(value);
  const keys = Object.keys(result);
  if (keys.length !== expected.keys.length || keys.some((key) => !expected.keys.includes(key)))
    throw new ComparisonStoreFailure('Cursor is malformed or noncanonical.', 2);
  if (result.v !== 1 || result.comparison !== expected.comparisonId || result.capture !== expected.captureDigest)
    throw new ComparisonStoreFailure('Cursor belongs to a different comparison, capture or page.', 2);
  return result;
}

export class PlanComparisonStore {
  readonly database: Database;
  private closed = false;
  private storedBytes = 0;
  private readonly ceiling: number;

  constructor(
    path: string | Database,
    options: { maxStoreBytes?: number; instrumentDatabase?: (database: Database) => Database } = {},
  ) {
    this.ceiling = options.maxStoreBytes ?? MAX_COMPARISON_STORE_BYTES;
    if (!Number.isSafeInteger(this.ceiling) || this.ceiling < 1)
      throw new ComparisonStoreFailure('Comparison storage ceiling is invalid.', 2);
    const opened = typeof path === 'string' ? new Database(path, { create: true, strict: true }) : path;
    this.database = options.instrumentDatabase ? options.instrumentDatabase(opened) : opened;
    try {
      this.database.exec('PRAGMA journal_mode = WAL');
      this.database.exec('PRAGMA busy_timeout = 5000');
      this.database.exec('PRAGMA synchronous = NORMAL');
      this.database.exec(`CREATE TABLE IF NOT EXISTS comparison_plans (
        comparison_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        capture_digest TEXT NOT NULL,
        source TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        left_preview_id TEXT NOT NULL,
        right_preview_id TEXT NOT NULL,
        left_converter TEXT NOT NULL,
        right_converter TEXT NOT NULL,
        left_dump TEXT NOT NULL,
        right_dump TEXT NOT NULL,
        left_view TEXT NOT NULL,
        right_view TEXT NOT NULL,
        left_baseline TEXT,
        right_baseline TEXT,
        left_baseline_present INTEGER NOT NULL,
        right_baseline_present INTEGER NOT NULL,
        left_admitted INTEGER NOT NULL,
        right_admitted INTEGER NOT NULL,
        left_skipped INTEGER NOT NULL,
        right_skipped INTEGER NOT NULL,
        left_vanished INTEGER NOT NULL,
        right_vanished INTEGER NOT NULL,
        input_differs INTEGER NOT NULL,
        converter_differs INTEGER NOT NULL,
        complete INTEGER NOT NULL,
        error_identity TEXT,
        error_message TEXT,
        only_left_count INTEGER NOT NULL,
        only_right_count INTEGER NOT NULL,
        changed_count INTEGER NOT NULL,
        unchanged_count INTEGER NOT NULL,
        skipped_count INTEGER NOT NULL,
        unavailable_count INTEGER NOT NULL,
        stored_bytes INTEGER NOT NULL
      ) WITHOUT ROWID`);
      this.database.exec(`CREATE TABLE IF NOT EXISTS comparison_records (
        comparison_id TEXT NOT NULL,
        record_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        left_kind TEXT,
        right_kind TEXT,
        left_digest TEXT,
        right_digest TEXT,
        left_revision TEXT,
        right_revision TEXT,
        left_converter TEXT,
        right_converter TEXT,
        left_skipped INTEGER,
        right_skipped INTEGER,
        left_vanished INTEGER NOT NULL,
        right_vanished INTEGER NOT NULL,
        digest_differs INTEGER NOT NULL,
        converter_differs INTEGER NOT NULL,
        retained_equal INTEGER NOT NULL,
        summary_json TEXT NOT NULL,
        left_json TEXT,
        right_json TEXT,
        PRIMARY KEY (comparison_id, record_key)
      ) WITHOUT ROWID`);
      this.database.exec(
        'CREATE INDEX IF NOT EXISTS comparison_kind_order ON comparison_records(comparison_id, kind, record_key)',
      );
      this.database.exec(`CREATE TABLE IF NOT EXISTS comparison_parts (
        comparison_id TEXT NOT NULL,
        record_key TEXT NOT NULL,
        address TEXT NOT NULL,
        domain TEXT NOT NULL,
        change TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (comparison_id, record_key, address)
      ) WITHOUT ROWID`);
      this.database.exec(
        'CREATE INDEX IF NOT EXISTS comparison_part_order ON comparison_parts(comparison_id, record_key, ordinal)',
      );
    } catch (error) {
      this.closed = true;
      if (typeof path === 'string') this.database.close();
      throw error;
    }
  }

  beginPlan(plan: {
    comparisonId: string;
    captureDigest: string;
    source: string;
    sourceKind: string;
    leftPreviewId: string;
    rightPreviewId: string;
    leftConverter: string;
    rightConverter: string;
    leftDump: string;
    rightDump: string;
    leftView: string;
    rightView: string;
    leftBaseline: string | null;
    rightBaseline: string | null;
    leftBaselinePresent: number;
    rightBaselinePresent: number;
    leftAdmitted: number;
    rightAdmitted: number;
    leftSkipped: number;
    rightSkipped: number;
    leftVanished: number;
    rightVanished: number;
    inputDiffers: boolean;
    converterDiffers: boolean;
  }): void {
    this.assertOpen();
    validSource(plan.source);
    this.database
      .query(
        `INSERT INTO comparison_plans(
          comparison_id,version,capture_digest,source,source_kind,left_preview_id,right_preview_id,
          left_converter,right_converter,left_dump,right_dump,left_view,right_view,left_baseline,right_baseline,
          left_baseline_present,right_baseline_present,left_admitted,right_admitted,left_skipped,right_skipped,
          left_vanished,right_vanished,input_differs,converter_differs,complete,error_identity,error_message,
          only_left_count,only_right_count,changed_count,unchanged_count,skipped_count,unavailable_count,stored_bytes
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,NULL,0,0,0,0,0,0,0)`,
      )
      .run(
        plan.comparisonId,
        COMPARISON_FORMAT_VERSION,
        plan.captureDigest,
        plan.source,
        plan.sourceKind,
        plan.leftPreviewId,
        plan.rightPreviewId,
        plan.leftConverter,
        plan.rightConverter,
        plan.leftDump,
        plan.rightDump,
        plan.leftView,
        plan.rightView,
        plan.leftBaseline,
        plan.rightBaseline,
        plan.leftBaselinePresent,
        plan.rightBaselinePresent,
        plan.leftAdmitted,
        plan.rightAdmitted,
        plan.leftSkipped,
        plan.rightSkipped,
        plan.leftVanished,
        plan.rightVanished,
        plan.inputDiffers ? 1 : 0,
        plan.converterDiffers ? 1 : 0,
      );
  }

  insertRecord(comparisonId: string, record: ComparisonRecordRow): void {
    this.assertOpen();
    validComparisonRecordKey(record.recordKey);
    if (!isComparisonKind(record.kind))
      throw new ComparisonStoreFailure('Comparison difference kind is unsupported.', 2);
    const payload =
      bytes(record.summaryJson) +
      (record.leftJson ? bytes(record.leftJson) : 0) +
      (record.rightJson ? bytes(record.rightJson) : 0);
    if (payload > MAX_DUMP_RECORD_BYTES * 2)
      throw new ComparisonStoreFailure('Comparison record projection exceeds its bound.');
    this.charge(payload + 256);
    const inserted = this.database
      .query(
        `INSERT OR IGNORE INTO comparison_records(
          comparison_id,record_key,kind,left_kind,right_kind,left_digest,right_digest,left_revision,right_revision,
          left_converter,right_converter,left_skipped,right_skipped,left_vanished,right_vanished,digest_differs,
          converter_differs,retained_equal,summary_json,left_json,right_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        comparisonId,
        record.recordKey,
        record.kind,
        record.leftKind,
        record.rightKind,
        record.leftDigest,
        record.rightDigest,
        record.leftRevision,
        record.rightRevision,
        record.leftConverter,
        record.rightConverter,
        record.leftSkipped === null ? null : record.leftSkipped ? 1 : 0,
        record.rightSkipped === null ? null : record.rightSkipped ? 1 : 0,
        record.leftVanished ? 1 : 0,
        record.rightVanished ? 1 : 0,
        record.digestDiffers ? 1 : 0,
        record.converterDiffers ? 1 : 0,
        record.retainedEqual ? 1 : 0,
        record.summaryJson,
        record.leftJson,
        record.rightJson,
      );
    if (!inserted.changes)
      throw new ComparisonStoreFailure('Duplicate comparison record key invalidates the merge.', 2);
    const column =
      record.kind === 'only-left'
        ? 'only_left_count'
        : record.kind === 'only-right'
          ? 'only_right_count'
          : record.kind === 'changed'
            ? 'changed_count'
            : record.kind === 'unchanged'
              ? 'unchanged_count'
              : record.kind === 'skipped'
                ? 'skipped_count'
                : 'unavailable_count';
    this.database
      .query(`UPDATE comparison_plans SET ${column}=${column}+1, stored_bytes=? WHERE comparison_id=?`)
      .run(this.storedBytes, comparisonId);
  }

  insertPart(comparisonId: string, recordKey: string, part: ComparisonPartRow): void {
    this.assertOpen();
    if (part.ordinal < 0 || part.ordinal >= MAX_COMPARISON_PARTS_PER_RECORD)
      throw new ComparisonStoreFailure('Comparison part page exceeds its bound.', 2);
    const payload =
      bytes(part.address) +
      (part.beforeJson ? bytes(part.beforeJson) : 0) +
      (part.afterJson ? bytes(part.afterJson) : 0);
    if (payload > MAX_DUMP_RECORD_BYTES)
      throw new ComparisonStoreFailure('Comparison part projection exceeds its bound.');
    this.charge(payload + 64);
    this.database
      .query(
        `INSERT INTO comparison_parts(comparison_id,record_key,address,domain,change,before_json,after_json,ordinal)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        comparisonId,
        recordKey,
        part.address,
        part.domain,
        part.change,
        part.beforeJson,
        part.afterJson,
        part.ordinal,
      );
    this.database
      .query('UPDATE comparison_plans SET stored_bytes=? WHERE comparison_id=?')
      .run(this.storedBytes, comparisonId);
  }

  seal(
    comparisonId: string,
    input: { complete: true } | { complete: false; errorIdentity: string; errorMessage: string },
  ): ComparisonPlan {
    this.assertOpen();
    if (input.complete) {
      this.database
        .query('UPDATE comparison_plans SET complete=1, stored_bytes=? WHERE comparison_id=?')
        .run(this.storedBytes, comparisonId);
    } else {
      this.database
        .query(
          `UPDATE comparison_plans SET complete=0, error_identity=?, error_message=?, stored_bytes=? WHERE comparison_id=?`,
        )
        .run(input.errorIdentity, input.errorMessage, this.storedBytes, comparisonId);
    }
    return this.plan(comparisonId);
  }

  plan(comparisonId: string): ComparisonPlan {
    this.assertOpen();
    const row = this.database.query('SELECT * FROM comparison_plans WHERE comparison_id=?').get(comparisonId) as Record<
      string,
      unknown
    > | null;
    if (!row) throw new ComparisonStoreFailure('Comparison plan is missing.');
    return this.mapPlan(row);
  }

  loadPlan(): ComparisonPlan | null {
    this.assertOpen();
    const row = this.database.query('SELECT comparison_id FROM comparison_plans LIMIT 2').all() as {
      comparison_id: string;
    }[];
    if (row.length !== 1) return null;
    return this.plan(row[0]!.comparison_id);
  }

  pageRecords(
    comparisonId: string,
    kind: ComparisonKind,
    options: { limit?: number; cursor?: string },
  ): ComparisonPage<{
    recordKey: string;
    kind: ComparisonKind;
    digestDiffers: boolean;
    converterDiffers: boolean;
    retainedEqual: boolean;
    leftDigest: string | null;
    rightDigest: string | null;
  }> {
    this.assertOpen();
    const plan = this.plan(comparisonId);
    const limit = options.limit ?? DEFAULT_COMPARISON_PAGE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_COMPARISON_PAGE)
      throw new ComparisonStoreFailure('Page size must be an integer from 1 through 100.', 2);
    const after = options.cursor ? this.decodeRecordCursor(options.cursor, plan, kind) : null;
    const rows =
      after === null
        ? (this.database
            .query(
              `SELECT record_key AS recordKey, kind, digest_differs AS digestDiffers,
                      converter_differs AS converterDiffers, retained_equal AS retainedEqual,
                      left_digest AS leftDigest, right_digest AS rightDigest
               FROM comparison_records INDEXED BY comparison_kind_order
               WHERE comparison_id=? AND kind=?
               ORDER BY record_key LIMIT ?`,
            )
            .all(comparisonId, kind, limit + 1) as {
            recordKey: string;
            kind: ComparisonKind;
            digestDiffers: number;
            converterDiffers: number;
            retainedEqual: number;
            leftDigest: string | null;
            rightDigest: string | null;
          }[])
        : (this.database
            .query(
              `SELECT record_key AS recordKey, kind, digest_differs AS digestDiffers,
                      converter_differs AS converterDiffers, retained_equal AS retainedEqual,
                      left_digest AS leftDigest, right_digest AS rightDigest
               FROM comparison_records INDEXED BY comparison_kind_order
               WHERE comparison_id=? AND kind=? AND record_key>?
               ORDER BY record_key LIMIT ?`,
            )
            .all(comparisonId, kind, after, limit + 1) as {
            recordKey: string;
            kind: ComparisonKind;
            digestDiffers: number;
            converterDiffers: number;
            retainedEqual: number;
            leftDigest: string | null;
            rightDigest: string | null;
          }[]);
    const more = rows.length > limit;
    const page = rows.slice(0, limit).map((row) => ({
      recordKey: row.recordKey,
      kind: row.kind,
      digestDiffers: row.digestDiffers === 1,
      converterDiffers: row.converterDiffers === 1,
      retainedEqual: row.retainedEqual === 1,
      leftDigest: row.leftDigest,
      rightDigest: row.rightDigest,
    }));
    if (more)
      return {
        kind,
        limit,
        end: 'more',
        nextCursor: cursorEncode({
          v: 1,
          comparison: comparisonId,
          capture: plan.captureDigest,
          kind,
          record: page.at(-1)!.recordKey,
        }),
        rows: page,
      };
    return { kind, limit, end: 'end', rows: page };
  }

  recordDetail(
    comparisonId: string,
    recordKey: string,
  ): { found: false; recordKey: string } | ({ found: true } & ComparisonRecordRow) {
    this.assertOpen();
    validComparisonRecordKey(recordKey);
    const row = this.database
      .query(
        `SELECT record_key AS recordKey, kind, left_kind AS leftKind, right_kind AS rightKind,
                left_digest AS leftDigest, right_digest AS rightDigest, left_revision AS leftRevision,
                right_revision AS rightRevision, left_converter AS leftConverter, right_converter AS rightConverter,
                left_skipped AS leftSkipped, right_skipped AS rightSkipped, left_vanished AS leftVanished,
                right_vanished AS rightVanished, digest_differs AS digestDiffers, converter_differs AS converterDiffers,
                retained_equal AS retainedEqual, summary_json AS summaryJson, left_json AS leftJson, right_json AS rightJson
         FROM comparison_records WHERE comparison_id=? AND record_key=?`,
      )
      .get(comparisonId, recordKey) as {
      recordKey: string;
      kind: ComparisonKind;
      leftKind: string | null;
      rightKind: string | null;
      leftDigest: string | null;
      rightDigest: string | null;
      leftRevision: string | null;
      rightRevision: string | null;
      leftConverter: string | null;
      rightConverter: string | null;
      leftSkipped: number | null;
      rightSkipped: number | null;
      leftVanished: number;
      rightVanished: number;
      digestDiffers: number;
      converterDiffers: number;
      retainedEqual: number;
      summaryJson: string;
      leftJson: string | null;
      rightJson: string | null;
    } | null;
    if (!row) return { found: false, recordKey };
    return {
      found: true,
      recordKey: row.recordKey,
      kind: row.kind,
      leftKind: row.leftKind,
      rightKind: row.rightKind,
      leftDigest: row.leftDigest,
      rightDigest: row.rightDigest,
      leftRevision: row.leftRevision,
      rightRevision: row.rightRevision,
      leftConverter: row.leftConverter,
      rightConverter: row.rightConverter,
      leftSkipped: row.leftSkipped === null ? null : row.leftSkipped === 1,
      rightSkipped: row.rightSkipped === null ? null : row.rightSkipped === 1,
      leftVanished: row.leftVanished === 1,
      rightVanished: row.rightVanished === 1,
      digestDiffers: row.digestDiffers === 1,
      converterDiffers: row.converterDiffers === 1,
      retainedEqual: row.retainedEqual === 1,
      summaryJson: row.summaryJson,
      leftJson: row.leftJson,
      rightJson: row.rightJson,
    };
  }

  pageParts(comparisonId: string, recordKey: string, options: { limit?: number; cursor?: string }): ComparisonPartPage {
    this.assertOpen();
    validComparisonRecordKey(recordKey);
    const plan = this.plan(comparisonId);
    const limit = options.limit ?? DEFAULT_COMPARISON_PAGE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_COMPARISON_PAGE)
      throw new ComparisonStoreFailure('Page size must be an integer from 1 through 100.', 2);
    const after = options.cursor ? this.decodePartCursor(options.cursor, plan, recordKey) : -1;
    const rows = this.database
      .query(
        `SELECT address, domain, change, before_json AS beforeJson, after_json AS afterJson, ordinal
         FROM comparison_parts INDEXED BY comparison_part_order
         WHERE comparison_id=? AND record_key=? AND ordinal>?
         ORDER BY ordinal LIMIT ?`,
      )
      .all(comparisonId, recordKey, after, limit + 1) as {
      address: string;
      domain: string;
      change: ComparisonPartRow['change'];
      beforeJson: string | null;
      afterJson: string | null;
      ordinal: number;
    }[];
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    if (more)
      return {
        recordKey,
        limit,
        end: 'more',
        nextCursor: cursorEncode({
          v: 1,
          comparison: comparisonId,
          capture: plan.captureDigest,
          record: recordKey,
          part: page.at(-1)!.ordinal,
        }),
        rows: page,
      };
    return { recordKey, limit, end: 'end', rows: page };
  }

  explainKindPage(): string {
    this.assertOpen();
    return this.database
      .query(
        `EXPLAIN QUERY PLAN SELECT record_key FROM comparison_records INDEXED BY comparison_kind_order
         WHERE comparison_id=? AND kind=? AND record_key>? ORDER BY record_key LIMIT ?`,
      )
      .all('c', 'changed', 'a', 21)
      .map((row) => String((row as { detail: string }).detail))
      .join('\n');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private decodeRecordCursor(value: string, plan: ComparisonPlan, kind: ComparisonKind): string {
    const cursor = bindCursor(value, {
      comparisonId: plan.comparisonId,
      captureDigest: plan.captureDigest,
      keys: ['v', 'comparison', 'capture', 'kind', 'record'],
    });
    if (cursor.kind !== kind)
      throw new ComparisonStoreFailure('Cursor belongs to a different comparison, capture or page.', 2);
    if (typeof cursor.record !== 'string')
      throw new ComparisonStoreFailure('Cursor record ordering key is invalid.', 2);
    validComparisonRecordKey(cursor.record);
    return cursor.record;
  }

  private decodePartCursor(value: string, plan: ComparisonPlan, recordKey: string): number {
    const cursor = bindCursor(value, {
      comparisonId: plan.comparisonId,
      captureDigest: plan.captureDigest,
      keys: ['v', 'comparison', 'capture', 'record', 'part'],
    });
    if (cursor.record !== recordKey)
      throw new ComparisonStoreFailure('Cursor belongs to a different comparison, capture or page.', 2);
    if (typeof cursor.part !== 'number' || !Number.isInteger(cursor.part) || cursor.part < 0)
      throw new ComparisonStoreFailure('Cursor part ordering key is invalid.', 2);
    return cursor.part;
  }

  private mapPlan(row: Record<string, unknown>): ComparisonPlan {
    return {
      comparisonId: String(row.comparison_id),
      version: Number(row.version),
      captureDigest: String(row.capture_digest),
      source: String(row.source),
      sourceKind: String(row.source_kind),
      leftPreviewId: String(row.left_preview_id),
      rightPreviewId: String(row.right_preview_id),
      leftConverter: String(row.left_converter),
      rightConverter: String(row.right_converter),
      leftDump: String(row.left_dump),
      rightDump: String(row.right_dump),
      leftView: String(row.left_view),
      rightView: String(row.right_view),
      leftBaseline: row.left_baseline === null ? null : String(row.left_baseline),
      rightBaseline: row.right_baseline === null ? null : String(row.right_baseline),
      leftBaselinePresent: Number(row.left_baseline_present),
      rightBaselinePresent: Number(row.right_baseline_present),
      leftAdmitted: Number(row.left_admitted),
      rightAdmitted: Number(row.right_admitted),
      leftSkipped: Number(row.left_skipped),
      rightSkipped: Number(row.right_skipped),
      leftVanished: Number(row.left_vanished),
      rightVanished: Number(row.right_vanished),
      inputDiffers: Number(row.input_differs) === 1,
      converterDiffers: Number(row.converter_differs) === 1,
      complete: Number(row.complete) === 1,
      errorIdentity: row.error_identity === null ? null : String(row.error_identity),
      errorMessage: row.error_message === null ? null : String(row.error_message),
      onlyLeftCount: Number(row.only_left_count),
      onlyRightCount: Number(row.only_right_count),
      changedCount: Number(row.changed_count),
      unchangedCount: Number(row.unchanged_count),
      skippedCount: Number(row.skipped_count),
      unavailableCount: Number(row.unavailable_count),
      storedBytes: Number(row.stored_bytes),
    };
  }

  private charge(amount: number): void {
    const next = this.storedBytes + amount;
    if (next > this.ceiling) throw new ComparisonStoreFailure('Comparison storage exceeded its configured ceiling.');
    this.storedBytes = next;
  }

  private assertOpen(): void {
    if (this.closed) throw new ComparisonStoreFailure('Comparison store is closed.');
  }
}
