import type { Database } from 'bun:sqlite';
import {
  DEFAULT_PAGE_SIZE,
  InspectionFailure,
  InspectionStore,
  MAX_PAGE_SIZE,
  MAX_RECORD_KEY_BYTES,
  encodeOpaqueCursor,
  exactObject,
  integer,
  parseCapturedRecordRow,
  utf8Bytes,
  validGeneration,
  validRecordKey,
  validSource,
  RECORD_KEY,
} from './inspection-store.ts';

export const CAPTURE_COMPARISON_VERSION = 1 as const;
export const CAPTURE_COMPARISON_SCHEMA = 'run-entries-present-v1';
export const DEFAULT_CAPTURE_PAGE = DEFAULT_PAGE_SIZE;
export const MAX_CAPTURE_PAGE = MAX_PAGE_SIZE;
/** Bounded merge/scan window for one detail page. A sparse category continues instead of scanning the rest of N+M. */
export const CAPTURE_SCAN_WINDOW = 256;
/** PK keyset batch retained as merge lookahead. */
export const CAPTURE_MERGE_BATCH = 32;
const MAX_CURSOR_BYTES = 2048;
const MAX_PROJECTION_PARSE_BYTES = 2 * 1024 * 1024 + 64;
const MAX_FIELD_DETAILS = 16;
const MAX_FIELD_VALUE_BYTES = 256;
const SOURCE_KINDS = new Set(['bangumi', 'vndb', 'openlibrary', 'wikidata']);

export type CaptureComparisonKind = 'new' | 'changed' | 'unchanged' | 'vanished';

export const CAPTURE_COMPARISON_KINDS: readonly CaptureComparisonKind[] = [
  'new',
  'changed',
  'unchanged',
  'vanished',
];

export type CaptureComparisonRequest = Readonly<{
  source: string;
  before: string;
  after: string;
  page?: CaptureComparisonKind;
  limit?: number;
  cursor?: string;
  record?: string;
  counts?: boolean;
}>;

export type CaptureUnavailableReason =
  | 'missing'
  | 'staging'
  | 'abandoned'
  | 'noncomplete'
  | 'partially-retired'
  | 'retired'
  | 'unsupported-status';

export type CaptureHeader = Readonly<{
  generation: string;
  seq: number;
  status: string;
  supplied: number;
  survivors: number;
  prior: number;
  skipped: number | null;
  classified: number;
  resolved: number;
  expected: number | null;
  presentAccounting: 'stored-supplied';
}>;

export type CaptureIdentity = Readonly<{
  recordRevision: string;
  digest: string;
  converterRevision: string;
  capturedClassification: string | null;
}>;

export type CaptureIdentityComparison = Readonly<{
  revisionEqual: boolean;
  digestEqual: boolean;
  converterEqual: boolean;
  factors: readonly ('revision' | 'digest' | 'converter')[];
}>;

export type CaptureProjectionField = Readonly<{
  name: string;
  before: string | null;
  after: string | null;
  equal: boolean;
  truncated: boolean;
  omittedBytes: number;
}>;

export type CaptureProjectionView =
  | Readonly<{
      available: true;
      format: 'source-record';
      sourceKind: string;
      truncated: boolean;
      omittedBytes: number;
      fields: readonly CaptureProjectionField[];
    }>
  | Readonly<{
      available: false;
      reason: 'absent' | 'unsupported-format' | 'malformed' | 'vanished-placeholder' | 'truncated-without-decode';
      omittedBytes: number;
    }>;

export type CaptureComparisonRow = Readonly<{
  recordKey: string;
  category: CaptureComparisonKind;
  before: CaptureIdentity | null;
  after: CaptureIdentity | null;
  identity: CaptureIdentityComparison | null;
  capturedClassification: Readonly<{ before: string | null; after: string | null }>;
}>;

export type CaptureRecordDetail = CaptureComparisonRow &
  Readonly<{
    found: boolean;
    presentBefore: boolean;
    presentAfter: boolean;
    excludedVanishedBefore: boolean;
    excludedVanishedAfter: boolean;
    projection: CaptureProjectionView;
    nativePublication: 'independent-of-local-capture';
    historicalSubjectIdentity: 'retained-only-when-stored';
  }>;

export type CaptureCounts = Readonly<
  | { state: 'pending' }
  | {
      state: 'complete';
      new: number;
      changed: number;
      unchanged: number;
      vanished: number;
      presentBefore: number;
      presentAfter: number;
      excludedVanishedBefore: number;
      excludedVanishedAfter: number;
      scannedRows: number;
      visitedRows: number;
    }
>;

export type CaptureComparisonPage = Readonly<{
  kind: CaptureComparisonKind;
  limit: number;
  scannedRows: number;
  scanWindow: number;
  visitedRows: number;
  end: 'end' | 'more';
  nextCursor?: string;
  rows: readonly CaptureComparisonRow[];
}>;

export type CaptureComparisonWork = Readonly<{
  sqliteReads: number;
  visitedRows: number;
  decodedProjectionBytes: number;
  comparisonCalls: number;
  retainedBufferBytes: number;
  scannedRows: number;
}>;

export type CaptureComparisonDocument = Readonly<{
  version: typeof CAPTURE_COMPARISON_VERSION;
  schema: typeof CAPTURE_COMPARISON_SCHEMA;
  source: string;
  before: CaptureHeader;
  after: CaptureHeader;
  presentPopulation: 'row-json-state-present';
  vanishedJournalRows: 'excluded-from-present-population';
  stagedClassification: 'not-a-comparison-result';
  counts: CaptureCounts;
  record: CaptureRecordDetail | null;
  page: CaptureComparisonPage | null;
  work: CaptureComparisonWork;
  authority: Readonly<{
    localCapture: true;
    nativePublication: 'independent';
    currentBinding: 'never-substituted-for-historical-identity';
    transport: 'none';
  }>;
}>;

export type CaptureComparisonObserver = Readonly<{
  onQuery?(sql: string): void;
  onRowVisit?(count: number): void;
  onProjectionBytes?(bytes: number): void;
  onCompare?(): void;
  onBuffer?(bytes: number): void;
}>;

type EntryRow = {
  record_key: unknown;
  row_json: unknown;
  projection_json: unknown;
  kind: unknown;
};

type GenerationProbe = {
  id: unknown;
  seq: unknown;
  status: unknown;
  supplied: unknown;
  survivors: unknown;
  prior: unknown;
  skipped: unknown;
  classified: unknown;
  resolved: unknown;
  expected: unknown;
  retired: unknown;
  retention_state: unknown;
};

type PresentRow = Readonly<{
  recordKey: string;
  identity: CaptureIdentity;
  projectionJson: string;
}>;

type DecodedProjection =
  | Extract<CaptureProjectionView, { available: false }>
  | (Extract<CaptureProjectionView, { available: true }> & { record: unknown });

export class CaptureComparisonFailure extends InspectionFailure {}

export function isCaptureComparisonKind(value: string): value is CaptureComparisonKind {
  return (CAPTURE_COMPARISON_KINDS as readonly string[]).includes(value);
}

function fail(message: string, code = 1): never {
  throw new CaptureComparisonFailure(message, code);
}

function classification(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !['new', 'changed', 'unchanged', 'vanished'].includes(value))
    fail('Malformed journal row: record classification is unsupported.');
  return value;
}

function decodeCursorJson(value: string): Record<string, unknown> {
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
  return exactObject(
    cursor,
    [
      'v',
      'schema',
      'source',
      'before',
      'after',
      'kind',
      'beforeKey',
      'afterKey',
      'beforeStatus',
      'afterStatus',
      'beforeSeq',
      'afterSeq',
      'beforeSupplied',
      'afterSupplied',
    ],
    'cursor',
  );
}

function identityComparison(before: CaptureIdentity, after: CaptureIdentity): CaptureIdentityComparison {
  const revisionEqual = before.recordRevision === after.recordRevision;
  const digestEqual = before.digest === after.digest;
  const converterEqual = before.converterRevision === after.converterRevision;
  const factors: ('revision' | 'digest' | 'converter')[] = [];
  if (!revisionEqual) factors.push('revision');
  if (!digestEqual) factors.push('digest');
  if (!converterEqual) factors.push('converter');
  return { revisionEqual, digestEqual, converterEqual, factors };
}

function categoryOf(before: PresentRow | null, after: PresentRow | null): CaptureComparisonKind {
  if (before && !after) return 'vanished';
  if (!before && after) return 'new';
  if (!before || !after) fail('Comparison merge produced an empty pair.');
  const identity = identityComparison(before.identity, after.identity);
  return identity.factors.length === 0 ? 'unchanged' : 'changed';
}

function rowOf(before: PresentRow | null, after: PresentRow | null): CaptureComparisonRow {
  const category = categoryOf(before, after);
  return {
    recordKey: (after ?? before)!.recordKey,
    category,
    before: before?.identity ?? null,
    after: after?.identity ?? null,
    identity: before && after ? identityComparison(before.identity, after.identity) : null,
    capturedClassification: {
      before: before?.identity.capturedClassification ?? null,
      after: after?.identity.capturedClassification ?? null,
    },
  };
}

function truncateDisplay(value: string): { text: string; truncated: boolean; omittedBytes: number } {
  const size = utf8Bytes(value);
  if (size <= MAX_FIELD_VALUE_BYTES) return { text: value, truncated: false, omittedBytes: 0 };
  let end = MAX_FIELD_VALUE_BYTES;
  while (end > 0 && (value.charCodeAt(end) & 0xc0) === 0x80) end--;
  const text = value.slice(0, end);
  return { text, truncated: true, omittedBytes: size - utf8Bytes(text) };
}

function fieldValue(value: unknown): { text: string; truncated: boolean; omittedBytes: number } {
  if (value === null || value === undefined) return { text: 'null', truncated: false, omittedBytes: 0 };
  if (typeof value === 'string') return truncateDisplay(value);
  if (typeof value === 'number' || typeof value === 'boolean')
    return { text: String(value), truncated: false, omittedBytes: 0 };
  try {
    return truncateDisplay(JSON.stringify(value) ?? 'null');
  } catch {
    return { text: '[unprintable]', truncated: true, omittedBytes: 0 };
  }
}

function ownData(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return value as Record<string, unknown>;
}

function decodeProjection(raw: unknown, work: Work): DecodedProjection {
  if (raw === null || raw === undefined) return { available: false, reason: 'absent', omittedBytes: 0 };
  if (typeof raw !== 'string') return { available: false, reason: 'malformed', omittedBytes: 0 };
  const size = utf8Bytes(raw);
  work.decodedProjectionBytes += size;
  work.observer?.onProjectionBytes?.(size);
  if (size > MAX_PROJECTION_PARSE_BYTES)
    return { available: false, reason: 'truncated-without-decode', omittedBytes: size };
  if (raw === '[]') return { available: false, reason: 'vanished-placeholder', omittedBytes: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { available: false, reason: 'malformed', omittedBytes: size };
  }
  if (Array.isArray(parsed))
    return {
      available: false,
      reason: parsed.length === 0 ? 'vanished-placeholder' : 'unsupported-format',
      omittedBytes: size,
    };
  const object = ownData(parsed);
  if (!object || typeof object.sourceKind !== 'string' || !SOURCE_KINDS.has(object.sourceKind))
    return { available: false, reason: 'unsupported-format', omittedBytes: size };
  return {
    available: true,
    format: 'source-record',
    sourceKind: object.sourceKind,
    truncated: false,
    omittedBytes: 0,
    fields: [],
    record: object.normalizedRecord,
  };
}

function projectionFields(before: unknown, after: unknown): {
  fields: CaptureProjectionField[];
  truncated: boolean;
  omittedBytes: number;
} {
  const left = ownData(before) ?? {};
  const right = ownData(after) ?? {};
  const names = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const truncated = names.length > MAX_FIELD_DETAILS;
  const selected = names.slice(0, MAX_FIELD_DETAILS);
  const omittedBytes = truncated ? names.length - selected.length : 0;
  const fields = selected.map((name) => {
    const hasBefore = Object.hasOwn(left, name);
    const hasAfter = Object.hasOwn(right, name);
    const beforeValue = hasBefore ? fieldValue(left[name]) : null;
    const afterValue = hasAfter ? fieldValue(right[name]) : null;
    return {
      name,
      before: beforeValue?.text ?? null,
      after: afterValue?.text ?? null,
      equal: hasBefore && hasAfter && beforeValue!.text === afterValue!.text && !beforeValue!.truncated && !afterValue!.truncated,
      truncated: Boolean(beforeValue?.truncated || afterValue?.truncated),
      omittedBytes: (beforeValue?.omittedBytes ?? 0) + (afterValue?.omittedBytes ?? 0),
    };
  });
  return { fields, truncated, omittedBytes };
}

function publishedProjection(view: DecodedProjection, fields: readonly CaptureProjectionField[], extra: { truncated: boolean; omittedBytes: number }): CaptureProjectionView {
  if (!view.available) return view;
  return {
    available: true,
    format: 'source-record',
    sourceKind: view.sourceKind,
    truncated: extra.truncated || view.truncated,
    omittedBytes: extra.omittedBytes + view.omittedBytes,
    fields,
  };
}

function compareProjections(beforeJson: string | null, afterJson: string | null, work: Work): CaptureProjectionView {
  const before = beforeJson === null ? { available: false as const, reason: 'absent' as const, omittedBytes: 0 } : decodeProjection(beforeJson, work);
  const after = afterJson === null ? { available: false as const, reason: 'absent' as const, omittedBytes: 0 } : decodeProjection(afterJson, work);
  if (beforeJson !== null && afterJson !== null && (!before.available || !after.available)) {
    return {
      available: false,
      reason: 'unsupported-format',
      omittedBytes: before.omittedBytes + after.omittedBytes,
    };
  }
  if (before.available && after.available) {
    const compared = projectionFields(before.record, after.record);
    return {
      available: true,
      format: 'source-record',
      sourceKind: before.sourceKind === after.sourceKind ? before.sourceKind : `${before.sourceKind}|${after.sourceKind}`,
      truncated: compared.truncated || before.truncated || after.truncated,
      omittedBytes: compared.omittedBytes + before.omittedBytes + after.omittedBytes,
      fields: compared.fields,
    };
  }
  if (before.available) {
    const compared = projectionFields(before.record, undefined);
    return publishedProjection(before, compared.fields, compared);
  }
  if (after.available) {
    const compared = projectionFields(undefined, after.record);
    return publishedProjection(after, compared.fields, compared);
  }
  if (before.reason === after.reason) return before;
  return { available: false, reason: 'unsupported-format', omittedBytes: before.omittedBytes + after.omittedBytes };
}

function availability(
  status: string,
  retired: unknown,
  retentionState: unknown,
): { available: true } | { available: false; reason: CaptureUnavailableReason } {
  if (retired === 1 || retentionState === 'retired' || status === 'retired') return { available: false, reason: 'retired' };
  if (
    retired === 2 ||
    retentionState === 'partially-retired' ||
    retentionState === 'partially_retired' ||
    status === 'partially-retired' ||
    status === 'partially_retired'
  )
    return { available: false, reason: 'partially-retired' };
  if (status === 'complete') return { available: true };
  if (status === 'staging') return { available: false, reason: 'staging' };
  if (status === 'abandoned') return { available: false, reason: 'abandoned' };
  if (['ready', 'finalizing', 'invalid-input', 'mass-disappearance'].includes(status))
    return { available: false, reason: 'noncomplete' };
  return { available: false, reason: 'unsupported-status' };
}

function unavailableMessage(source: string, id: string, reason: CaptureUnavailableReason, status: string): string {
  const target = `generation ${JSON.stringify(id)} for source ${JSON.stringify(source)}`;
  if (reason === 'missing') return `No generation ${JSON.stringify(id)} exists for source ${JSON.stringify(source)}.`;
  if (reason === 'staging') return `${target} is a staging capture and cannot be compared.`;
  if (reason === 'abandoned') return `${target} is abandoned history and cannot be compared.`;
  if (reason === 'retired') return `${target} is retired history and cannot be compared.`;
  if (reason === 'partially-retired') return `${target} is partially retired history and cannot be compared.`;
  if (reason === 'noncomplete')
    return `${target} is not a complete capture (status ${JSON.stringify(status)}) and cannot be compared.`;
  return `${target} has unsupported capture status ${JSON.stringify(status)}.`;
}

class Work {
  sqliteReads = 0;
  visitedRows = 0;
  decodedProjectionBytes = 0;
  comparisonCalls = 0;
  retainedBufferBytes = 0;
  scannedRows = 0;
  constructor(readonly observer?: CaptureComparisonObserver) {}
  snapshot(): CaptureComparisonWork {
    this.observer?.onBuffer?.(this.retainedBufferBytes);
    return {
      sqliteReads: this.sqliteReads,
      visitedRows: this.visitedRows,
      decodedProjectionBytes: this.decodedProjectionBytes,
      comparisonCalls: this.comparisonCalls,
      retainedBufferBytes: this.retainedBufferBytes,
      scannedRows: this.scannedRows,
    };
  }
}

class QueryCounter {
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

class PresentStream {
  private buffer: PresentRow[] = [];
  private fetchKey: string;
  private consumedKey: string;
  exhausted = false;
  visited = 0;
  excludedVanished = 0;
  present = 0;

  constructor(
    private readonly queries: QueryCounter,
    private readonly source: string,
    private readonly runId: string,
    afterKey: string,
    private readonly work: Work,
    private readonly signal?: AbortSignal,
  ) {
    this.fetchKey = afterKey;
    this.consumedKey = afterKey;
  }

  private fill(): void {
    if (this.exhausted || this.buffer.length) return;
    if (this.signal?.aborted) fail('Capture comparison was cancelled.', 130);
    const fetched = this.queries.all<EntryRow>(
      `SELECT record_key,row_json,projection_json,kind
      FROM run_entries WHERE source=? AND run_id=? AND record_key>?
      ORDER BY record_key LIMIT ?`,
      this.source,
      this.runId,
      this.fetchKey,
      CAPTURE_MERGE_BATCH,
    );
    if (fetched.length < CAPTURE_MERGE_BATCH) this.exhausted = true;
    const rows: PresentRow[] = [];
    for (const raw of fetched) {
      this.visited += 1;
      this.work.visitedRows += 1;
      this.work.observer?.onRowVisit?.(1);
      if (typeof raw.record_key !== 'string' || utf8Bytes(raw.record_key) > MAX_RECORD_KEY_BYTES || !RECORD_KEY.test(raw.record_key))
        fail('Malformed journal row: comparison contains an invalid source record key.');
      this.fetchKey = raw.record_key;
      if (typeof raw.row_json !== 'string')
        fail(`Malformed journal row: record metadata for ${JSON.stringify(raw.record_key)} is unsupported.`);
      const metadata = parseCapturedRecordRow(raw.row_json, this.source, raw.record_key);
      if (typeof raw.projection_json !== 'string')
        fail(`Malformed journal row: projection for ${JSON.stringify(raw.record_key)} is unsupported.`);
      this.work.retainedBufferBytes += utf8Bytes(raw.row_json) + utf8Bytes(raw.record_key);
      if (metadata.state === 'vanished') {
        this.excludedVanished += 1;
        this.consumedKey = raw.record_key;
        continue;
      }
      this.present += 1;
      rows.push({
        recordKey: raw.record_key,
        identity: {
          recordRevision: metadata.recordRevision,
          digest: metadata.digest,
          converterRevision: metadata.converterRevision,
          capturedClassification: classification(raw.kind),
        },
        projectionJson: raw.projection_json,
      });
    }
    this.buffer = rows;
    this.work.retainedBufferBytes += this.buffer.length * 64;
  }

  peek(): PresentRow | null {
    this.fill();
    return this.buffer[0] ?? null;
  }

  take(): PresentRow | null {
    this.fill();
    const row = this.buffer.shift();
    if (row) this.consumedKey = row.recordKey;
    return row ?? null;
  }

  position(): string {
    return this.consumedKey;
  }
}

function generationColumns(queries: QueryCounter): Set<string> {
  return new Set(
    queries.all<{ name: string }>('PRAGMA table_info(run_generations)').map((row) => row.name),
  );
}

function readHeader(queries: QueryCounter, columns: Set<string>, source: string, id: string): CaptureHeader {
  const skipped = columns.has('skipped') ? 'skipped' : 'NULL AS skipped';
  const retired = columns.has('retired') ? 'retired' : 'NULL AS retired';
  const retention = columns.has('retention_state') ? 'retention_state' : 'NULL AS retention_state';
  const row = queries.get<GenerationProbe>(
    `SELECT id,seq,status,supplied,survivors,prior,classified,resolved,expected,${skipped},${retired},${retention}
    FROM run_generations WHERE source=? AND id=?`,
    source,
    id,
  );
  if (!row) fail(unavailableMessage(source, id, 'missing', ''), 2);
  if (row.id !== id) fail('Malformed journal row: generation identity does not match its lookup key.');
  if (typeof row.status !== 'string' || utf8Bytes(row.status) > 64 || !/^[a-z][a-z0-9-]*$/u.test(row.status))
    fail('Malformed journal row: generation status is not a stored status identifier.');
  const state = availability(row.status, row.retired, row.retention_state);
  if (!state.available) fail(unavailableMessage(source, id, state.reason, row.status), 2);
  integer(row.seq, 'run_generations.seq', 1);
  return {
    generation: id,
    seq: integer(row.seq, 'run_generations.seq', 1),
    status: row.status,
    supplied: integer(row.supplied, 'run_generations.supplied'),
    survivors: integer(row.survivors, 'run_generations.survivors'),
    prior: integer(row.prior, 'run_generations.prior'),
    skipped: row.skipped === null || row.skipped === undefined ? null : integer(row.skipped, 'run_generations.skipped'),
    classified: integer(row.classified, 'run_generations.classified'),
    resolved: integer(row.resolved, 'run_generations.resolved'),
    expected: row.expected === null || row.expected === undefined ? null : integer(row.expected, 'run_generations.expected'),
    presentAccounting: 'stored-supplied',
  };
}

function bindCursor(
  cursor: Record<string, unknown>,
  request: CaptureComparisonRequest,
  before: CaptureHeader,
  after: CaptureHeader,
): { beforeKey: string; afterKey: string; kind: CaptureComparisonKind } {
  if (
    cursor.v !== 1 ||
    cursor.schema !== CAPTURE_COMPARISON_SCHEMA ||
    cursor.source !== request.source ||
    cursor.before !== request.before ||
    cursor.after !== request.after ||
    cursor.kind !== request.page
  )
    fail('Cursor belongs to a different source, generation pair, schema or page.', 2);
  if (cursor.beforeStatus !== before.status || cursor.afterStatus !== after.status)
    fail('Cursor is invalid because a compared capture is no longer the same complete history.', 2);
  if (cursor.beforeSeq !== before.seq || cursor.afterSeq !== after.seq)
    fail('Cursor is invalid because a compared capture identity changed.', 2);
  if (cursor.beforeSupplied !== before.supplied || cursor.afterSupplied !== after.supplied)
    fail('Cursor is invalid because retained capture accounting changed.', 2);
  if (
    typeof cursor.beforeKey !== 'string' ||
    (cursor.beforeKey !== '' && (utf8Bytes(cursor.beforeKey) > MAX_RECORD_KEY_BYTES || !RECORD_KEY.test(cursor.beforeKey)))
  )
    fail('Cursor record ordering key is invalid.', 2);
  if (
    typeof cursor.afterKey !== 'string' ||
    (cursor.afterKey !== '' && (utf8Bytes(cursor.afterKey) > MAX_RECORD_KEY_BYTES || !RECORD_KEY.test(cursor.afterKey)))
  )
    fail('Cursor record ordering key is invalid.', 2);
  if (typeof cursor.kind !== 'string' || !isCaptureComparisonKind(cursor.kind)) fail('Cursor page kind is invalid.', 2);
  return { beforeKey: cursor.beforeKey, afterKey: cursor.afterKey, kind: cursor.kind };
}

function encodePageCursor(
  request: CaptureComparisonRequest,
  before: CaptureHeader,
  after: CaptureHeader,
  kind: CaptureComparisonKind,
  beforeKey: string,
  afterKey: string,
): string {
  return encodeOpaqueCursor({
    v: 1,
    schema: CAPTURE_COMPARISON_SCHEMA,
    source: request.source,
    before: request.before,
    after: request.after,
    kind,
    beforeKey,
    afterKey,
    beforeStatus: before.status,
    afterStatus: after.status,
    beforeSeq: before.seq,
    afterSeq: after.seq,
    beforeSupplied: before.supplied,
    afterSupplied: after.supplied,
  });
}

function mergeOnce(
  left: PresentStream,
  right: PresentStream,
  work: Work,
): { before: PresentRow | null; after: PresentRow | null } | null {
  const peekLeft = left.peek();
  const peekRight = right.peek();
  if (!peekLeft && !peekRight) return null;
  work.scannedRows += 1;
  work.comparisonCalls += 1;
  work.observer?.onCompare?.();
  if (peekLeft && peekRight && peekLeft.recordKey === peekRight.recordKey)
    return { before: left.take(), after: right.take() };
  if (peekLeft && (!peekRight || peekLeft.recordKey < peekRight.recordKey)) return { before: left.take(), after: null };
  return { before: null, after: right.take() };
}

function countPair(
  queries: QueryCounter,
  request: CaptureComparisonRequest,
  work: Work,
  signal?: AbortSignal,
): Extract<CaptureCounts, { state: 'complete' }> {
  const left = new PresentStream(queries, request.source, request.before, '', work, signal);
  const right = new PresentStream(queries, request.source, request.after, '', work, signal);
  const counts = { new: 0, changed: 0, unchanged: 0, vanished: 0 };
  while (true) {
    if (signal?.aborted) fail('Capture comparison was cancelled.', 130);
    const pair = mergeOnce(left, right, work);
    if (!pair) break;
    counts[categoryOf(pair.before, pair.after)] += 1;
  }
  return {
    state: 'complete',
    ...counts,
    presentBefore: left.present,
    presentAfter: right.present,
    excludedVanishedBefore: left.excludedVanished,
    excludedVanishedAfter: right.excludedVanished,
    scannedRows: work.scannedRows,
    visitedRows: work.visitedRows,
  };
}

function pagePair(
  queries: QueryCounter,
  request: CaptureComparisonRequest,
  before: CaptureHeader,
  after: CaptureHeader,
  kind: CaptureComparisonKind,
  limit: number,
  start: { beforeKey: string; afterKey: string },
  work: Work,
  signal?: AbortSignal,
): CaptureComparisonPage {
  const left = new PresentStream(queries, request.source, request.before, start.beforeKey, work, signal);
  const right = new PresentStream(queries, request.source, request.after, start.afterKey, work, signal);
  const rows: CaptureComparisonRow[] = [];
  let scanned = 0;
  while (rows.length < limit && scanned < CAPTURE_SCAN_WINDOW) {
    if (signal?.aborted) fail('Capture comparison was cancelled.', 130);
    const pair = mergeOnce(left, right, work);
    if (!pair) break;
    scanned += 1;
    if (categoryOf(pair.before, pair.after) === kind) rows.push(rowOf(pair.before, pair.after));
  }
  const more = Boolean(left.peek() || right.peek());
  const end = more ? 'more' : 'end';
  return {
    kind,
    limit,
    scannedRows: scanned,
    scanWindow: CAPTURE_SCAN_WINDOW,
    visitedRows: left.visited + right.visited,
    end,
    ...(end === 'more'
      ? { nextCursor: encodePageCursor(request, before, after, kind, left.position(), right.position()) }
      : {}),
    rows,
  };
}

function readEntry(
  queries: QueryCounter,
  source: string,
  runId: string,
  key: string,
  work: Work,
): { present: PresentRow | null; vanished: boolean } {
  const raw = queries.get<EntryRow>(
    `SELECT record_key,row_json,projection_json,kind FROM run_entries WHERE source=? AND run_id=? AND record_key=?`,
    source,
    runId,
    key,
  );
  if (!raw) return { present: null, vanished: false };
  work.visitedRows += 1;
  work.observer?.onRowVisit?.(1);
  if (raw.record_key !== key) fail('Malformed journal row: record identity does not match its lookup key.');
  if (typeof raw.row_json !== 'string') fail(`Malformed journal row: record metadata for ${JSON.stringify(key)} is unsupported.`);
  const metadata = parseCapturedRecordRow(raw.row_json, source, key);
  if (typeof raw.projection_json !== 'string') fail(`Malformed journal row: projection for ${JSON.stringify(key)} is unsupported.`);
  if (metadata.state === 'vanished') return { present: null, vanished: true };
  return {
    present: {
      recordKey: key,
      identity: {
        recordRevision: metadata.recordRevision,
        digest: metadata.digest,
        converterRevision: metadata.converterRevision,
        capturedClassification: classification(raw.kind),
      },
      projectionJson: raw.projection_json,
    },
    vanished: false,
  };
}

function readRecord(
  queries: QueryCounter,
  request: CaptureComparisonRequest,
  key: string,
  work: Work,
): CaptureRecordDetail {
  const before = readEntry(queries, request.source, request.before, key, work);
  const after = readEntry(queries, request.source, request.after, key, work);
  work.comparisonCalls += 1;
  work.observer?.onCompare?.();
  if (!before.present && !after.present) {
    return {
      recordKey: key,
      category: 'unchanged',
      before: null,
      after: null,
      identity: null,
      capturedClassification: { before: null, after: null },
      found: false,
      presentBefore: false,
      presentAfter: false,
      excludedVanishedBefore: before.vanished,
      excludedVanishedAfter: after.vanished,
      projection: { available: false, reason: 'absent', omittedBytes: 0 },
      nativePublication: 'independent-of-local-capture',
      historicalSubjectIdentity: 'retained-only-when-stored',
    };
  }
  const summary = rowOf(before.present, after.present);
  return {
    ...summary,
    found: true,
    presentBefore: before.present !== null,
    presentAfter: after.present !== null,
    excludedVanishedBefore: before.vanished,
    excludedVanishedAfter: after.vanished,
    projection: compareProjections(before.present?.projectionJson ?? null, after.present?.projectionJson ?? null, work),
    nativePublication: 'independent-of-local-capture',
    historicalSubjectIdentity: 'retained-only-when-stored',
  };
}

function documentOf(input: {
  request: CaptureComparisonRequest;
  before: CaptureHeader;
  after: CaptureHeader;
  counts: CaptureCounts;
  record: CaptureRecordDetail | null;
  page: CaptureComparisonPage | null;
  work: CaptureComparisonWork;
}): CaptureComparisonDocument {
  return {
    version: CAPTURE_COMPARISON_VERSION,
    schema: CAPTURE_COMPARISON_SCHEMA,
    source: input.request.source,
    before: input.before,
    after: input.after,
    presentPopulation: 'row-json-state-present',
    vanishedJournalRows: 'excluded-from-present-population',
    stagedClassification: 'not-a-comparison-result',
    counts: input.counts,
    record: input.record,
    page: input.page,
    work: input.work,
    authority: {
      localCapture: true,
      nativePublication: 'independent',
      currentBinding: 'never-substituted-for-historical-identity',
      transport: 'none',
    },
  };
}

/** Read-only comparison of two complete retained captures. Never constructs RunStore. */
export class CaptureComparison {
  private closed = false;

  private constructor(
    readonly store: InspectionStore,
    private readonly observer?: CaptureComparisonObserver,
  ) {}

  static async open(statePath: string, observer?: CaptureComparisonObserver): Promise<CaptureComparison> {
    const store = await InspectionStore.open(statePath);
    return new CaptureComparison(store, observer);
  }

  compare(request: CaptureComparisonRequest, signal?: AbortSignal): CaptureComparisonDocument {
    if (this.closed) fail('Capture comparison store is closed.');
    validSource(request.source);
    validGeneration(request.before);
    validGeneration(request.after);
    if (request.record !== undefined) validRecordKey(request.record);
    if (request.page !== undefined && !isCaptureComparisonKind(request.page))
      fail('Page must be new, changed, unchanged or vanished.', 2);
    if (request.page === undefined && (request.cursor !== undefined || request.limit !== undefined))
      fail('A cursor or page size requires --page new|changed|unchanged|vanished.', 2);
    if (
      request.limit !== undefined &&
      (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > MAX_CAPTURE_PAGE)
    )
      fail('Page size must be an integer from 1 through 100.', 2);
    if (request.counts !== undefined && request.counts !== true && request.counts !== false)
      fail('Counts must be an explicit boolean request.', 2);
    return this.store.readConsistent(signal, () => this.read(request, signal));
  }

  private read(request: CaptureComparisonRequest, signal?: AbortSignal): CaptureComparisonDocument {
    if (signal?.aborted) fail('Capture comparison was cancelled.', 130);
    const work = new Work(this.observer);
    const queries = new QueryCounter(this.store.database, work);
    const sourceRow = queries.get<{ source: unknown }>(
      'SELECT source FROM run_sources WHERE source=?',
      request.source,
    );
    if (!sourceRow) fail(`No source state exists for ${JSON.stringify(request.source)}.`, 2);
    if (sourceRow.source !== request.source)
      fail('Malformed journal row: source identity does not match its lookup key.');
    const columns = generationColumns(queries);
    const before = readHeader(queries, columns, request.source, request.before);
    const after = readHeader(queries, columns, request.source, request.after);
    let start = { beforeKey: '', afterKey: '' };
    if (request.cursor !== undefined) {
      if (request.page === undefined) fail('A cursor requires a page selector.', 2);
      start = bindCursor(decodeCursorJson(request.cursor), request, before, after);
    }
    const counts = request.counts ? countPair(queries, request, work, signal) : { state: 'pending' as const };
    if (counts.state === 'complete') {
      if (counts.presentBefore !== before.supplied || counts.presentAfter !== after.supplied)
        fail(
          `Incomplete capture accounting: stored supplied counts do not match present rows for source ${JSON.stringify(request.source)}.`,
        );
    }
    const record = request.record === undefined ? null : readRecord(queries, request, request.record, work);
    const page =
      request.page === undefined
        ? null
        : pagePair(
            queries,
            request,
            before,
            after,
            request.page,
            request.limit ?? DEFAULT_CAPTURE_PAGE,
            start,
            work,
            signal,
          );
    return documentOf({ request, before, after, counts, record, page, work: work.snapshot() });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.store.close();
  }
}
