import { Database } from 'bun:sqlite';
import { constants } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_GENERATION_ID_BYTES = 32;
const MAX_RECORD_KEY_BYTES = 512;
const MAX_ENVELOPE_BYTES = 65_536;
const MAX_ENVELOPES = 3;
const MAX_RECORD_COMMANDS = 300;
const MAX_RECORD_BYTES = 2 * 1024 * 1024 + 64;
const MAX_KEYS_JSON_BYTES = 256 * 1024;

const SOURCE_ID = /^[a-z][a-z0-9_-]{0,31}$/u;
const GENERATION_ID = /^[1-9][0-9]*$/u;
const RECORD_KEY =
  /^(?:[\p{L}\p{N}][\p{L}\p{N}._:/@+\-]*|\/(?:works\/OL[1-9][0-9]*W|books\/OL[1-9][0-9]*M|authors\/OL[1-9][0-9]*A))$/u;
const FIELD_GROUPS = new Set(['facts', 'summary', 'cover']);
const OPERATIONS = new Set(['create', 'propose', 'retract']);

export type InspectionPageKind = 'pending' | 'covers';
export type InspectionRequest = Readonly<{
  source: string;
  generation?: string;
  record?: string;
  page?: InspectionPageKind;
  limit?: number;
  cursor?: string;
}>;

export type FieldOperationSummary = Readonly<{
  fieldGroup: 'facts' | 'summary' | 'cover';
  operation: 'create' | 'propose' | 'retract';
  unresolved: number;
  settled: number;
}>;

export type PendingEnvelopeSummary = Readonly<{
  recordKey: string;
  classification: string | null;
  envelopeIndex: number;
  multiEnvelope: boolean;
  unresolvedCommands: number;
  fieldOperations: readonly FieldOperationSummary[];
}>;

export type DeferredCoverSummary = Readonly<{
  recordKey: string;
  classification: string | null;
  unresolvedCommands: number;
  fieldOperations: readonly FieldOperationSummary[];
  omittedFieldGroups: readonly string[];
}>;

export type InspectionEnvelope = Readonly<{
  index: number;
  multiEnvelope: boolean;
  delivery: 'unresolved' | 'settled';
  byteLength: number;
  sha256: string;
  commands: readonly Readonly<{
    key: string;
    fieldGroup: 'facts' | 'summary' | 'cover';
    operation: 'create' | 'propose' | 'retract';
    delivery: 'unresolved' | 'acknowledged' | 'settled-with-fence-omission';
  }>[];
}>;

export type InspectionRecord = Readonly<{
  recordKey: string;
  found: boolean;
  state?: 'present' | 'vanished';
  recordRevision?: string;
  converterRevision?: string;
  digest?: string;
  classification?: string | null;
  resolved?: boolean;
  unresolvedCommands?: number;
  deferredCover?: boolean;
  omittedFieldGroups?: readonly string[];
  localCompletionRetained?: boolean;
  envelopes?: readonly InspectionEnvelope[];
}>;

export type InspectionDocument = Readonly<{
  version: 1;
  source: string;
  sourceState: 'absent' | 'active' | 'baseline' | 'uninitialized';
  baseline: null | Readonly<{ generation: string; presentCount: number; empty: boolean }>;
  ownershipRow: 'present' | 'absent' | 'unavailable';
  selection: null | Readonly<{ kind: 'active' | 'baseline' | 'explicit'; generation: string }>;
  generation: null | Readonly<{
    id: string;
    status: string;
    phase: 'acquiring' | 'validated/sealed' | 'finalizing' | 'terminal' | 'unknown';
    activeWork: readonly ('applying' | 'deferred')[];
    counts: Readonly<{
      priorMembership: number | null;
      supplied: number | null;
      survivors: number | null;
      skipped: number | null;
      invalidInputFlag: number | null;
      classified: number | null;
      resolved: number | null;
      expected: number | null;
      prepared: number | null;
    }>;
    resume: string;
  }>;
  record: InspectionRecord | null;
  page: null | Readonly<{
    kind: InspectionPageKind;
    limit: number;
    end: 'end' | 'more';
    nextCursor?: string;
    rows: readonly (PendingEnvelopeSummary | DeferredCoverSummary)[];
  }>;
}>;

type SourceRow = {
  source: unknown;
  sequence: unknown;
  lease_run: unknown;
  generation: unknown;
  present_count: unknown;
};

type GenerationRow = {
  id: unknown;
  seq: unknown;
  status: unknown;
  threshold: unknown;
  prior: unknown;
  supplied: unknown;
  survivors: unknown;
  invalid: unknown;
  classified: unknown;
  resolved: unknown;
  expected: unknown;
  prepared: unknown;
  skipped: unknown;
};

type EntryRow = {
  row_json: unknown;
  kind: unknown;
  resolved: unknown;
  keys_json: unknown;
  omissions_json: unknown;
  remaining: unknown;
  cover_pending: unknown;
};

type EnvelopePageRow = {
  record_key: unknown;
  kind: unknown;
  envelope_index: unknown;
  multi: unknown;
  remaining: unknown;
  command_count: unknown;
  command_groups: unknown;
};

type CoverPageRow = {
  record_key: unknown;
  kind: unknown;
  remaining: unknown;
  command_count: unknown;
  command_groups: unknown;
  omissions_json: unknown;
};

type RawEnvelope = {
  envelope_index: unknown;
  multi: unknown;
  bytes: unknown;
  keys_json: unknown;
  remaining: unknown;
  pending: unknown;
};

type CommandRow = {
  command_key: unknown;
  field_group: unknown;
  op: unknown;
  envelope_index: unknown;
  done: unknown;
};

export class InspectionFailure extends Error {
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

function validSource(value: unknown): asserts value is string {
  if (typeof value !== 'string' || bytes(value) > 32 || !SOURCE_ID.test(value))
    throw new InspectionFailure('Source must be an exact configured source identifier.', 2);
}

function validGeneration(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    bytes(value) > MAX_GENERATION_ID_BYTES ||
    !GENERATION_ID.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new InspectionFailure('Generation must be a positive stored generation ID.', 2);
}

function validRecordKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || bytes(value) > MAX_RECORD_KEY_BYTES || !RECORD_KEY.test(value))
    throw new InspectionFailure('Record key must be an exact native source record key.', 2);
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw new InspectionFailure(`Malformed journal value: ${label} is not a bounded integer.`);
  return value;
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null || value === undefined ? null : integer(value, label);
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
    throw new InspectionFailure(`Malformed journal value: ${label} has an unsupported shape.`);
  return value as Record<string, unknown>;
}

function parseJson(value: unknown, label: string, maxBytes: number): unknown {
  if (typeof value !== 'string' || bytes(value) > maxBytes)
    throw new InspectionFailure(`Malformed journal value: ${label} exceeds its stored bound.`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new InspectionFailure(`Malformed journal value: ${label} is invalid JSON.`);
  }
}

function parseRecordRow(value: unknown, source: string, key: string): {
  state: 'present' | 'vanished';
  recordRevision: string;
  converterRevision: string;
  digest: string;
} {
  const row = exactObject(
    parseJson(value, 'run_entries.row_json', 4096),
    ['source', 'recordKey', 'recordRevision', 'digest', 'converter_revision', 'state'],
    'run_entries.row_json',
  );
  if (
    row.source !== source ||
    row.recordKey !== key ||
    typeof row.recordRevision !== 'string' ||
    bytes(row.recordRevision) > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/u.test(row.recordRevision) ||
    typeof row.converter_revision !== 'string' ||
    bytes(row.converter_revision) > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/u.test(row.converter_revision) ||
    typeof row.digest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(row.digest) ||
    (row.state !== 'present' && row.state !== 'vanished')
  )
    throw new InspectionFailure(`Malformed journal row: record metadata for ${JSON.stringify(key)} is unsupported.`);
  return {
    state: row.state,
    recordRevision: row.recordRevision,
    converterRevision: row.converter_revision,
    digest: row.digest,
  };
}

function parseKeyList(value: unknown, label: string, maximum: number): string[] {
  const parsed = parseJson(value, label, MAX_KEYS_JSON_BYTES);
  if (!Array.isArray(parsed) || parsed.length > maximum)
    throw new InspectionFailure(`Malformed journal value: ${label} exceeds its command bound.`);
  const keys = parsed.map((key) => {
    if (typeof key !== 'string' || bytes(key) > 255 || !/^[\x20-\x7e]+$/u.test(key))
      throw new InspectionFailure(`Malformed journal value: ${label} contains an invalid command key.`);
    return key;
  });
  if (new Set(keys).size !== keys.length)
    throw new InspectionFailure(`Malformed journal value: ${label} repeats a command key.`);
  return keys;
}

function parseOmissions(value: unknown): string[] {
  const parsed = parseJson(value, 'run_entries.omissions_json', 4096);
  if (!Array.isArray(parsed) || parsed.length > 3)
    throw new InspectionFailure('Malformed journal value: omission list exceeds its stored bound.');
  const groups = new Set<string>();
  for (const item of parsed) {
    const omission = exactObject(item, ['field_group', 'disposition', 'securityRevision'], 'omission');
    if (
      typeof omission.field_group !== 'string' ||
      !FIELD_GROUPS.has(omission.field_group) ||
      omission.disposition !== 'fenced' ||
      typeof omission.securityRevision !== 'string' ||
      bytes(omission.securityRevision) > 256 ||
      !/^[1-9][0-9]*$/u.test(omission.securityRevision) ||
      groups.has(omission.field_group)
    )
      throw new InspectionFailure('Malformed journal value: omission record is unsupported.');
    groups.add(omission.field_group);
  }
  return [...groups].sort();
}

function parseCommandGroups(value: unknown, commandCount: unknown, remaining: unknown, maximum: number): FieldOperationSummary[] {
  const total = integer(commandCount, 'command count', 0);
  const unresolved = integer(remaining, 'unresolved command count', 0);
  if (total > maximum) throw new InspectionFailure('Malformed journal row: command count exceeds its stored bound.');
  const raw = parseJson(value, 'command summary', 4096);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new InspectionFailure('Malformed journal value: command summary is not an object.');
  const groups: FieldOperationSummary[] = [];
  let seen = 0;
  let pending = 0;
  for (const [groupKey, counts] of Object.entries(raw)) {
    const [fieldGroup, operation, extra] = groupKey.split(':');
    if (
      extra !== undefined ||
      !FIELD_GROUPS.has(fieldGroup ?? '') ||
      !OPERATIONS.has(operation ?? '') ||
      !Array.isArray(counts) ||
      counts.length !== 3
    )
      throw new InspectionFailure('Malformed journal value: command summary contains an unsupported group.');
    const groupUnresolved = integer(counts[0], 'command group unresolved count');
    const settled = integer(counts[1], 'command group settled count');
    const invalid = integer(counts[2], 'command group invalid count');
    if (invalid !== 0) throw new InspectionFailure('Malformed journal row: command delivery state is unsupported.');
    if (groupUnresolved + settled === 0)
      throw new InspectionFailure('Malformed journal value: empty command group.');
    seen += groupUnresolved + settled;
    pending += groupUnresolved;
    groups.push({
      fieldGroup: fieldGroup as FieldOperationSummary['fieldGroup'],
      operation: operation as FieldOperationSummary['operation'],
      unresolved: groupUnresolved,
      settled,
    });
  }
  if (seen !== total || pending !== unresolved)
    throw new InspectionFailure('Malformed journal row: command keys, phases and stored counts disagree.');
  groups.sort((left, right) =>
    left.fieldGroup === right.fieldGroup
      ? left.operation.localeCompare(right.operation)
      : left.fieldGroup.localeCompare(right.fieldGroup),
  );
  return groups;
}

function safeStatus(value: unknown): string {
  if (typeof value !== 'string' || bytes(value) > 64 || !/^[a-z][a-z0-9-]*$/u.test(value))
    throw new InspectionFailure('Malformed journal row: generation status is not a stored status identifier.');
  return value;
}

function cursorEncode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function cursorDecode(value: string, request: InspectionRequest, runId: string): Record<string, unknown> {
  if (bytes(value) > 2048 || !/^[A-Za-z0-9_-]+$/u.test(value))
    throw new InspectionFailure('Cursor is malformed or exceeds its bound.', 2);
  let decoded: string;
  let cursor: unknown;
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) throw new Error('noncanonical');
    cursor = JSON.parse(decoded) as unknown;
  } catch {
    throw new InspectionFailure('Cursor is malformed or noncanonical.', 2);
  }
  const keys = request.page === 'pending' ? ['v', 'source', 'run', 'kind', 'record', 'envelope'] : ['v', 'source', 'run', 'kind', 'record'];
  const result = exactObject(cursor, keys, 'cursor');
  if (
    result.v !== 1 ||
    result.source !== request.source ||
    result.run !== runId ||
    result.kind !== request.page
  )
    throw new InspectionFailure('Cursor belongs to a different source, generation or page.', 2);
  if (typeof result.record !== 'string' || bytes(result.record) > MAX_RECORD_KEY_BYTES || !RECORD_KEY.test(result.record))
    throw new InspectionFailure('Cursor record ordering key is invalid.', 2);
  if (request.page === 'pending' && (!Number.isInteger(result.envelope) || (result.envelope as number) < 0 || (result.envelope as number) >= MAX_ENVELOPES))
    throw new InspectionFailure('Cursor envelope ordering key is invalid.', 2);
  return result;
}

function phaseFor(status: string): 'acquiring' | 'validated/sealed' | 'finalizing' | 'terminal' | 'unknown' {
  if (status === 'staging') return 'acquiring';
  if (status === 'ready') return 'validated/sealed';
  if (status === 'finalizing') return 'finalizing';
  if (['complete', 'invalid-input', 'mass-disappearance', 'abandoned'].includes(status)) return 'terminal';
  return 'unknown';
}

function resumeGuidance(status: string, activeWork: readonly ('applying' | 'deferred')[]): string {
  if (status === 'staging') return 'The existing importer requires a complete validated input before it can resume; incomplete acquisition is discarded by its ordinary workflow.';
  if (status === 'ready' && activeWork.includes('applying'))
    return `The existing importer rechecks current authority and replays each retained request with its original command keys and bytes${activeWork.includes('deferred') ? '; deferred covers also remain pending' : ''}; unresolved authority or ownership failures remain in force.`;
  if (status === 'ready' && activeWork.includes('deferred'))
    return 'Deferred covers remain pending; the existing importer rechecks current authority, fences and source registration before continuing.';
  if (status === 'ready') return 'The existing importer rechecks current authority, input integrity, source registration and fences before ordinary continuation.';
  if (status === 'finalizing') return 'The existing importer continues the retained baseline finalization cursor after ordinary source ownership admission.';
  if (status === 'mass-disappearance') return 'This generation did not advance the baseline; ordinary resume needs a complete input and deliberate review of the existing disappearance threshold.';
  if (status === 'invalid-input') return 'This generation did not advance the baseline; ordinary resume requires a complete valid input.';
  if (status === 'complete') return 'This generation is the retained completed baseline; a later import still uses ordinary ownership and current authority checks.';
  return 'The stored status is not recognized by this inspector; resume behavior is not inferred and the existing importer remains responsible for admission.';
}

function sameFile(left: Awaited<ReturnType<FileHandle['stat']>>, right: Awaited<ReturnType<FileHandle['stat']>>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Dedicated read-only source-generation reader. It never opens RunStore or ImportSession. */
export class InspectionStore {
  readonly database: Database;
  readonly path: string;
  private readonly descriptor: FileHandle;
  private closed = false;

  private constructor(path: string, descriptor: FileHandle, database: Database) {
    this.path = path;
    this.descriptor = descriptor;
    this.database = database;
  }

  static async open(statePath: string): Promise<InspectionStore> {
    const path = resolve(statePath);
    let descriptor: FileHandle | undefined;
    let database: Database | undefined;
    let store: InspectionStore | undefined;
    try {
      const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
      descriptor = await open(path, flags);
      const identity = await descriptor.stat();
      if (!identity.isFile()) throw new InspectionFailure(`State path is not a regular file: ${JSON.stringify(path)}.`, 2);
      database = new Database(path, { readonly: true, create: false, strict: true });
      const afterOpen = await stat(path);
      if (!sameFile(identity, afterOpen)) throw new InspectionFailure('State path changed while it was being opened.', 2);
      store = new InspectionStore(path, descriptor, database);
      descriptor = undefined;
      database = undefined;
      store.validateSchema();
      return store;
    } catch (error) {
      await store?.close();
      database?.close();
      await descriptor?.close().catch(() => {});
      if (error instanceof InspectionFailure) throw error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') throw new InspectionFailure(`State file does not exist: ${JSON.stringify(path)}.`, 2);
      if (code === 'ELOOP') throw new InspectionFailure(`State path must not be a symbolic link: ${JSON.stringify(path)}.`, 2);
      if (
        code === 'SQLITE_BUSY' ||
        code === 'SQLITE_LOCKED' ||
        (error instanceof Error && /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i.test(error.message))
      )
        throw new InspectionFailure('State database is busy or locked; retry the local inspection.', 1);
      if (error instanceof Error && /not a database|unable to open database|database disk image is malformed/i.test(error.message))
        throw new InspectionFailure(`State file is not a supported readable SQLite database: ${JSON.stringify(path)}.`, 2);
      throw new InspectionFailure(`Unable to open state file ${JSON.stringify(path)}${code ? ` (${code})` : ''}.`, 2);
    }
  }

  private validateSchema(): void {
    const required: Record<string, readonly string[]> = {
      run_sources: ['source', 'sequence', 'lease_run', 'generation', 'present_count'],
      run_generations: [
        'source', 'id', 'seq', 'lease', 'status', 'threshold', 'prior', 'supplied', 'survivors', 'invalid',
        'classified', 'resolved', 'expected', 'changed', 'prepared', 'cursor',
      ],
      run_entries: [
        'source', 'run_id', 'record_key', 'row_json', 'projection_json', 'kind', 'resolved', 'bytes', 'keys_json',
        'omissions_json', 'pending', 'remaining', 'cover_pending',
      ],
      run_acknowledged: ['source', 'record_key', 'row_json', 'projection_json'],
      run_commands: ['source', 'run_id', 'command_key', 'record_key', 'field_group', 'op', 'envelope_index', 'done'],
      run_payloads: ['source', 'command_key', 'body'],
      run_envelopes: [
        'source', 'run_id', 'record_key', 'envelope_index', 'multi', 'bytes', 'keys_json', 'remaining', 'pending',
      ],
    };
    for (const [table, columns] of Object.entries(required)) {
      const found = this.database
        .query('SELECT 1 AS found FROM sqlite_schema WHERE type=? AND name=?')
        .get('table', table) as { found: number } | null;
      if (!found) throw new InspectionFailure(`Unsupported importer state schema: table ${table} is missing.`);
      const actual = new Set(
        this.database.query(`PRAGMA table_info(${table})`).all().map((row) => (row as { name: string }).name),
      );
      const missing = columns.find((column) => !actual.has(column));
      if (missing) throw new InspectionFailure(`Unsupported importer state schema: column ${table}.${missing} is missing.`);
    }
    for (const [index, table] of [
      ['run_envelope_pending', 'run_envelopes'],
      ['run_cover_pending', 'run_entries'],
    ] as const) {
      const found = this.database
        .query('SELECT 1 AS found FROM sqlite_schema WHERE type=? AND name=? AND tbl_name=?')
        .get('index', index, table) as { found: number } | null;
      if (!found) throw new InspectionFailure(`Unsupported importer state schema: required index ${index} is missing.`);
    }
  }

  private checkOpen(): void {
    if (this.closed) throw new InspectionFailure('Inspection store is closed.');
  }

  private snapshot<T>(signal: AbortSignal | undefined, operation: () => T): T {
    this.checkOpen();
    if (signal?.aborted) throw new InspectionFailure('Inspection was cancelled.', 130);
    this.database.exec('BEGIN');
    try {
      const value = operation();
      if (signal?.aborted) throw new InspectionFailure('Inspection was cancelled.', 130);
      this.database.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the original bounded read failure.
      }
      if (error instanceof InspectionFailure) throw error;
      if (error instanceof Error && /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i.test(error.message))
        throw new InspectionFailure('State database is busy or locked; retry the local inspection.');
      if (error instanceof Error && /malformed JSON/i.test(error.message))
        throw new InspectionFailure('Malformed journal data: a stored command key list is not valid JSON.');
      if (error instanceof Error && /no such (?:table|column)|no query solution|no such index/i.test(error.message))
        throw new InspectionFailure('Unsupported importer state schema: a required journal field or index is unavailable.');
      throw new InspectionFailure('Malformed or unavailable importer journal data; no state was changed.');
    }
  }

  inspect(request: InspectionRequest, signal?: AbortSignal): InspectionDocument {
    validSource(request.source);
    if (request.generation !== undefined) validGeneration(request.generation);
    if (request.record !== undefined) validRecordKey(request.record);
    if (request.page === undefined && (request.cursor !== undefined || request.limit !== undefined))
      throw new InspectionFailure('A cursor or page size requires --page pending|covers.', 2);
    if (request.page !== undefined && request.page !== 'pending' && request.page !== 'covers')
      throw new InspectionFailure('Page must be pending or covers.', 2);
    if (request.page !== undefined && request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > MAX_PAGE_SIZE))
      throw new InspectionFailure('Page size must be an integer from 1 through 100.', 2);
    if (request.cursor !== undefined && request.page === undefined)
      throw new InspectionFailure('A cursor requires a page selector.', 2);
    return this.snapshot(signal, () => this.readView(request, signal));
  }

  private readView(request: InspectionRequest, signal?: AbortSignal): InspectionDocument {
    if (signal?.aborted) throw new InspectionFailure('Inspection was cancelled.', 130);
    const source = this.database
      .query('SELECT source,sequence,lease_run,generation,present_count FROM run_sources WHERE source=?')
      .get(request.source) as SourceRow | null;
    if (source && source.source !== request.source)
      throw new InspectionFailure('Malformed journal row: source identity does not match its lookup key.');
    const presentCount = source ? integer(source.present_count, 'run_sources.present_count') : null;
    const liveGeneration = source?.lease_run === null || source?.lease_run === undefined ? null : source.lease_run;
    const baselineGeneration = source?.generation === null || source?.generation === undefined ? null : source.generation;
    if (liveGeneration !== null) validGeneration(liveGeneration);
    if (baselineGeneration !== null) validGeneration(baselineGeneration);
    if (source && (typeof source.sequence !== 'number' || !Number.isSafeInteger(source.sequence) || source.sequence < 0))
      throw new InspectionFailure('Malformed journal row: source sequence is not a bounded integer.');

    let selectedId: string | null = null;
    let selection: InspectionDocument['selection'] = null;
    if (request.generation !== undefined) {
      selectedId = request.generation;
      selection = { kind: 'explicit', generation: request.generation };
    } else if (liveGeneration !== null) {
      selectedId = liveGeneration;
      selection = { kind: 'active', generation: liveGeneration };
    } else if (baselineGeneration !== null) {
      selectedId = baselineGeneration;
      selection = { kind: 'baseline', generation: baselineGeneration };
    }

    if (selectedId !== null && !source)
      throw new InspectionFailure(`No source state exists for ${JSON.stringify(request.source)}.`);

    const baseline = source && baselineGeneration !== null
      ? { generation: baselineGeneration, presentCount: presentCount!, empty: presentCount === 0 }
      : null;
    const sourceState: InspectionDocument['sourceState'] = !source
      ? 'absent'
      : liveGeneration !== null
        ? 'active'
        : baselineGeneration !== null
          ? 'baseline'
          : 'uninitialized';
    const ownershipRow = this.ownerRow(request.source);
    const generation = selectedId === null ? null : this.readGeneration(request.source, selectedId, source, signal);
    let record: InspectionRecord | null = null;
    if (request.record !== undefined) {
      if (selectedId === null) record = { recordKey: request.record, found: false };
      else record = this.readRecord(request.source, selectedId, request.record, signal);
    }
    let page: InspectionDocument['page'] = null;
    if (request.page !== undefined) {
      if (selectedId === null) throw new InspectionFailure('There is no active generation or completed baseline to page.', 2);
      const runId = selectedId;
      const limit = request.limit ?? DEFAULT_PAGE_SIZE;
      const cursor = request.cursor === undefined ? null : cursorDecode(request.cursor, request, runId);
      page = this.readPage(request.source, runId, request.page, limit, cursor, signal);
    }
    return {
      version: 1,
      source: request.source,
      sourceState,
      baseline,
      ownershipRow,
      selection,
      generation,
      record,
      page,
    };
  }

  private ownerRow(source: string): InspectionDocument['ownershipRow'] {
    const table = this.database
      .query('SELECT 1 AS found FROM sqlite_schema WHERE type=? AND name=?')
      .get('table', 'import_owners') as { found: number } | null;
    if (!table) return 'unavailable';
    const columns = new Set(
      this.database.query('PRAGMA table_info(import_owners)').all().map((row) => (row as { name: string }).name),
    );
    if (!columns.has('source')) return 'unavailable';
    const row = this.database.query('SELECT 1 AS found FROM import_owners WHERE source=? LIMIT 1').get(source);
    return row ? 'present' : 'absent';
  }

  private readGeneration(
    source: string,
    id: string,
    sourceRow: SourceRow | null,
    signal?: AbortSignal,
  ): NonNullable<InspectionDocument['generation']> {
    if (signal?.aborted) throw new InspectionFailure('Inspection was cancelled.', 130);
    const hasSkipped = new Set(
      this.database.query('PRAGMA table_info(run_generations)').all().map((row) => (row as { name: string }).name),
    ).has('skipped');
    const skipped = hasSkipped ? 'skipped' : 'NULL AS skipped';
    const row = this.database
      .query(
        `SELECT id,seq,status,threshold,prior,supplied,survivors,invalid,classified,resolved,expected,prepared,${skipped}
        FROM run_generations WHERE source=? AND id=?`,
      )
      .get(source, id) as GenerationRow | null;
    if (!row) throw new InspectionFailure(`No generation ${JSON.stringify(id)} exists for source ${JSON.stringify(source)}.`, 2);
    if (row.id !== id) throw new InspectionFailure('Malformed journal row: generation identity does not match its lookup key.');
    const status = safeStatus(row.status);
    if (sourceRow?.lease_run === id && !['staging', 'ready', 'finalizing'].includes(status))
      throw new InspectionFailure(`Malformed journal row: source points to non-active generation ${JSON.stringify(id)}.`);
    if (sourceRow?.generation === id && status !== 'complete')
      throw new InspectionFailure(`Malformed journal row: baseline points to non-completed generation ${JSON.stringify(id)}.`);
    const priorMembership = nullableInteger(row.prior, 'run_generations.prior');
    const supplied = nullableInteger(row.supplied, 'run_generations.supplied');
    const survivors = nullableInteger(row.survivors, 'run_generations.survivors');
    const skippedCount = nullableInteger(row.skipped, 'run_generations.skipped');
    const invalidInputFlag = nullableInteger(row.invalid, 'run_generations.invalid');
    const classified = nullableInteger(row.classified, 'run_generations.classified');
    const resolved = nullableInteger(row.resolved, 'run_generations.resolved');
    const prepared = nullableInteger(row.prepared, 'run_generations.prepared');
    const expected = status === 'staging' ? null : nullableInteger(row.expected, 'run_generations.expected');
    if (invalidInputFlag !== null && invalidInputFlag > 1)
      throw new InspectionFailure('Malformed journal row: invalid-input flag is not boolean.');
    if (typeof row.threshold !== 'number' || !Number.isFinite(row.threshold) || row.threshold < 0 || row.threshold > 1)
      throw new InspectionFailure('Malformed journal row: disappearance threshold is invalid.');
    integer(row.seq, 'run_generations.seq');
    const work = this.database
      .query(
        `SELECT
          EXISTS(SELECT 1 FROM run_envelopes INDEXED BY run_envelope_pending WHERE source=? AND run_id=? AND pending=1) AS pending,
          EXISTS(SELECT 1 FROM run_entries INDEXED BY run_cover_pending WHERE source=? AND run_id=? AND cover_pending=1) AS covers`,
      )
      .get(source, id, source, id) as { pending: unknown; covers: unknown };
    const activeWork: ('applying' | 'deferred')[] = [];
    if (work.pending === 1) activeWork.push('applying');
    else if (work.pending !== 0) throw new InspectionFailure('Malformed journal row: pending-work indicator is not boolean.');
    if (work.covers === 1) activeWork.push('deferred');
    else if (work.covers !== 0) throw new InspectionFailure('Malformed journal row: deferred-cover indicator is not boolean.');
    return {
      id,
      status,
      phase: phaseFor(status),
      activeWork,
      counts: {
        priorMembership,
        supplied,
        survivors,
        skipped: skippedCount,
        invalidInputFlag,
        classified,
        resolved,
        expected,
        prepared,
      },
      resume: resumeGuidance(status, activeWork),
    };
  }

  private readPage(
    source: string,
    runId: string,
    kind: InspectionPageKind,
    limit: number,
    cursor: Record<string, unknown> | null,
    signal?: AbortSignal,
  ): NonNullable<InspectionDocument['page']> {
    if (signal?.aborted) throw new InspectionFailure('Inspection was cancelled.', 130);
    if (kind === 'pending') {
      const afterRecord = cursor ? (cursor.record as string) : '';
      const afterEnvelope = cursor ? (cursor.envelope as number) : -1;
      // One run_envelope_pending seek returns at most P+1 envelope summaries. Each row's
      // JSON key list is bounded to 100 commands and joins run_commands by its full primary key.
      const fetched = this.database
        .query(
          `SELECT n.record_key,e.kind,n.envelope_index,n.multi,n.remaining,
            json_array_length(n.keys_json) AS command_count,
            (SELECT COALESCE(json_group_object(group_key,json_array(unresolved,settled,invalid)),'{}')
              FROM (
                SELECT c.field_group || ':' || c.op AS group_key,
                  sum(CASE WHEN c.done=0 THEN 1 ELSE 0 END) AS unresolved,
                  sum(CASE WHEN c.done=1 THEN 1 ELSE 0 END) AS settled,
                  sum(CASE WHEN c.done NOT IN (0,1) THEN 1 ELSE 0 END) AS invalid
                FROM json_each(n.keys_json) AS selected
                JOIN run_commands AS c
                  ON c.source=n.source AND c.run_id=n.run_id AND c.command_key=selected.value
                GROUP BY c.field_group,c.op
              ) AS grouped
            ) AS command_groups
          FROM run_envelopes AS n INDEXED BY run_envelope_pending
          JOIN run_entries AS e
            ON e.source=n.source AND e.run_id=n.run_id AND e.record_key=n.record_key
          WHERE n.source=? AND n.run_id=? AND n.pending=1
            AND (n.record_key,n.envelope_index)>(?,?)
          ORDER BY n.record_key,n.envelope_index LIMIT ?`,
        )
        .all(source, runId, afterRecord, afterEnvelope, limit + 1) as EnvelopePageRow[];
      const hasMore = fetched.length > limit;
      const rows = fetched.slice(0, limit).map((row) => {
        const key = this.pageKey(row.record_key);
        const classification = this.classification(row.kind);
        const envelopeIndex = integer(row.envelope_index, 'run_envelopes.envelope_index');
        if (envelopeIndex >= MAX_ENVELOPES || (row.multi !== 0 && row.multi !== 1))
          throw new InspectionFailure('Malformed journal row: envelope ordering metadata is unsupported.');
        if (row.remaining === 0 || row.remaining === null)
          throw new InspectionFailure('Malformed journal row: a pending envelope has no unresolved commands.');
        const fieldOperations = parseCommandGroups(row.command_groups, row.command_count, row.remaining, 100);
        return {
          recordKey: key,
          classification,
          envelopeIndex,
          multiEnvelope: row.multi === 1,
          unresolvedCommands: integer(row.remaining, 'run_envelopes.remaining'),
          fieldOperations,
        } satisfies PendingEnvelopeSummary;
      });
      const last = rows.at(-1);
      return {
        kind,
        limit,
        end: hasMore ? 'more' : 'end',
        ...(hasMore && last
          ? {
              nextCursor: cursorEncode({
                v: 1,
                source,
                run: runId,
                kind,
                record: last.recordKey,
                envelope: last.envelopeIndex,
              }),
            }
          : {}),
        rows,
      };
    }

    const afterRecord = cursor ? (cursor.record as string) : '';
    // One run_cover_pending seek returns at most P+1 record summaries. Each row has at most
    // 300 stored command keys, joined through run_commands' source/run/key primary key.
    const fetched = this.database
      .query(
        `SELECT e.record_key,e.kind,e.remaining,
          json_array_length(e.keys_json) AS command_count,e.omissions_json,
          (SELECT COALESCE(json_group_object(group_key,json_array(unresolved,settled,invalid)),'{}')
            FROM (
              SELECT c.field_group || ':' || c.op AS group_key,
                sum(CASE WHEN c.done=0 THEN 1 ELSE 0 END) AS unresolved,
                sum(CASE WHEN c.done=1 THEN 1 ELSE 0 END) AS settled,
                sum(CASE WHEN c.done NOT IN (0,1) THEN 1 ELSE 0 END) AS invalid
              FROM json_each(e.keys_json) AS selected
              JOIN run_commands AS c
                ON c.source=e.source AND c.run_id=e.run_id AND c.command_key=selected.value
              GROUP BY c.field_group,c.op
            ) AS grouped
          ) AS command_groups
        FROM run_entries AS e INDEXED BY run_cover_pending
        WHERE e.source=? AND e.run_id=? AND e.cover_pending=1 AND e.record_key>?
        ORDER BY e.record_key LIMIT ?`,
      )
      .all(source, runId, afterRecord, limit + 1) as CoverPageRow[];
    const hasMore = fetched.length > limit;
    const rows = fetched.slice(0, limit).map((row) => ({
      recordKey: this.pageKey(row.record_key),
      classification: this.classification(row.kind),
      unresolvedCommands: integer(row.remaining, 'run_entries.remaining'),
      fieldOperations: parseCommandGroups(row.command_groups, row.command_count, row.remaining, MAX_RECORD_COMMANDS),
      omittedFieldGroups: parseOmissions(row.omissions_json),
    } satisfies DeferredCoverSummary));
    const last = rows.at(-1);
    return {
      kind,
      limit,
      end: hasMore ? 'more' : 'end',
      ...(hasMore && last
        ? {
            nextCursor: cursorEncode({ v: 1, source, run: runId, kind, record: last.recordKey }),
          }
        : {}),
      rows,
    };
  }

  private pageKey(value: unknown): string {
    if (typeof value !== 'string' || bytes(value) > MAX_RECORD_KEY_BYTES || !RECORD_KEY.test(value))
      throw new InspectionFailure('Malformed journal row: page contains an invalid source record key.');
    return value;
  }

  private classification(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== 'string' || !['new', 'changed', 'unchanged', 'vanished'].includes(value))
      throw new InspectionFailure('Malformed journal row: record classification is unsupported.');
    return value;
  }

  private readRecord(source: string, runId: string, key: string, signal?: AbortSignal): InspectionRecord {
    if (signal?.aborted) throw new InspectionFailure('Inspection was cancelled.', 130);
    const entry = this.database
      .query(
        `SELECT row_json,kind,resolved,keys_json,omissions_json,remaining,cover_pending
        FROM run_entries WHERE source=? AND run_id=? AND record_key=?`,
      )
      .get(source, runId, key) as EntryRow | null;
    if (!entry) return { recordKey: key, found: false };
    const metadata = parseRecordRow(entry.row_json, source, key);
    const kind = this.classification(entry.kind);
    if (entry.resolved !== 0 && entry.resolved !== 1)
      throw new InspectionFailure('Malformed journal row: resolved flag is not boolean.');
    if (entry.cover_pending !== 0 && entry.cover_pending !== 1)
      throw new InspectionFailure('Malformed journal row: deferred-cover flag is not boolean.');
    const remaining = integer(entry.remaining, 'run_entries.remaining');
    const omissions = parseOmissions(entry.omissions_json);
    const globalCompletion = this.database
      .query('SELECT 1 AS found FROM run_acknowledged WHERE source=? AND record_key=?')
      .get(source, key);
    const envelopeRows = this.database
      .query(
        `SELECT envelope_index,multi,bytes,keys_json,remaining,pending
        FROM run_envelopes WHERE source=? AND run_id=? AND record_key=?
        ORDER BY envelope_index LIMIT ?`,
      )
      .all(source, runId, key, MAX_ENVELOPES + 1) as RawEnvelope[];
    if (envelopeRows.length > MAX_ENVELOPES)
      throw new InspectionFailure('Malformed journal row: prepared envelope count exceeds its stored bound.');
    let totalBytes = 0;
    let priorIndex = -1;
    let multi: number | null = null;
    const commands: InspectionEnvelope['commands'][number][] = [];
    const envelopes: InspectionEnvelope[] = [];
    for (const raw of envelopeRows) {
      const index = integer(raw.envelope_index, 'run_envelopes.envelope_index');
      if (index >= MAX_ENVELOPES || index !== priorIndex + 1 || (multi !== null && multi !== raw.multi))
        throw new InspectionFailure('Malformed journal row: prepared envelope ordering is inconsistent.');
      priorIndex = index;
      if (raw.multi !== 0 && raw.multi !== 1)
        throw new InspectionFailure('Malformed journal row: multi-envelope flag is not boolean.');
      multi = raw.multi;
      if (typeof raw.bytes !== 'string' || bytes(raw.bytes) > MAX_ENVELOPE_BYTES)
        throw new InspectionFailure('Malformed journal row: prepared envelope exceeds its stored byte bound.');
      totalBytes += bytes(raw.bytes);
      if (totalBytes > MAX_RECORD_BYTES)
        throw new InspectionFailure('Malformed journal row: total prepared request bytes exceed their stored bound.');
      if (raw.pending !== 0 && raw.pending !== 1)
        throw new InspectionFailure('Malformed journal row: envelope pending flag is not boolean.');
      const keys = parseKeyList(raw.keys_json, 'run_envelopes.keys_json', 100);
      const envelopeRemaining = integer(raw.remaining, 'run_envelopes.remaining');
      const foundCommands: CommandRow[] = [];
      for (const commandKey of keys) {
        if (signal?.aborted) throw new InspectionFailure('Inspection was cancelled.', 130);
        const command = this.database
          .query(
            `SELECT command_key,field_group,op,envelope_index,done FROM run_commands
            WHERE source=? AND run_id=? AND command_key=?`,
          )
          .get(source, runId, commandKey) as CommandRow | null;
        if (!command) throw new InspectionFailure('Malformed journal row: an envelope references a missing command.');
        foundCommands.push(command);
      }
      let unresolved = 0;
      const envelopeCommands = foundCommands.map((command) => {
        if (
          typeof command.command_key !== 'string' ||
          bytes(command.command_key) > 255 ||
          !/^[\x20-\x7e]+$/u.test(command.command_key) ||
          !FIELD_GROUPS.has(String(command.field_group)) ||
          !OPERATIONS.has(String(command.op)) ||
          command.envelope_index !== index ||
          (command.done !== 0 && command.done !== 1)
        )
          throw new InspectionFailure('Malformed journal row: command metadata is inconsistent with its envelope.');
        if (command.done === 0) unresolved++;
        const omitted = omissions.includes(String(command.field_group));
        return {
          key: String(command.command_key),
          fieldGroup: command.field_group as InspectionEnvelope['commands'][number]['fieldGroup'],
          operation: command.op as InspectionEnvelope['commands'][number]['operation'],
          delivery:
            command.done === 0
              ? 'unresolved'
              : omitted
                ? 'settled-with-fence-omission'
                : 'acknowledged',
        } as const;
      });
      if (unresolved !== envelopeRemaining || (raw.pending === 1) !== (envelopeRemaining > 0))
        throw new InspectionFailure('Malformed journal row: envelope delivery flags and command rows disagree.');
      commands.push(...envelopeCommands);
      envelopes.push({
        index,
        multiEnvelope: raw.multi === 1,
        delivery: raw.pending === 1 ? 'unresolved' : 'settled',
        byteLength: bytes(raw.bytes),
        sha256: createHash('sha256').update(raw.bytes, 'utf8').digest('hex'),
        commands: envelopeCommands,
      });
    }
    if (commands.length > MAX_RECORD_COMMANDS)
      throw new InspectionFailure('Malformed journal row: prepared command count exceeds its stored bound.');
    if (remaining !== commands.filter((command) => command.delivery === 'unresolved').length)
      throw new InspectionFailure('Malformed journal row: record and envelope unresolved counts disagree.');
    if (entry.resolved === 1 && (remaining !== 0 || entry.cover_pending !== 0 || kind === null))
      throw new InspectionFailure('Malformed journal row: record resolution flags are inconsistent.');
    return {
      recordKey: key,
      found: true,
      ...metadata,
      classification: kind,
      resolved: entry.resolved === 1,
      unresolvedCommands: remaining,
      deferredCover: entry.cover_pending === 1,
      omittedFieldGroups: omissions,
      localCompletionRetained: !!globalCompletion,
      envelopes,
    };
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
}
