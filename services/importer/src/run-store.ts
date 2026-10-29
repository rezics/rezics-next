import { Database, type SQLQueryBindings, type Statement } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import type { SourceId } from '@rezics/conversion';
import {
  BatchStatementSchema,
  FIELD_GROUPS,
  type BatchCommand,
  type BatchStatement,
  type FieldGroup,
} from '@rezics/definitions/bulk';
import { checkBatch, checkResult } from './accepted-checks.ts';
import type { ImportBatchRequest, ImportBatchResult } from './import-contract.ts';
import type { RecordRow } from './record-store.ts';
import { MAX_DUMP_RECORD_BYTES } from './dumps-bytes.ts';

export type Run = { source: string; id: string; lease: string };
/** Callers supply only the pure converter's sanitized normalized record, never raw dump data. */
export type SourceProjection = { sourceKind: SourceId; normalizedRecord: unknown };
export type Staged<Projection = BatchStatement[]> = { row: RecordRow; projection: Projection };
export type Omission = { field_group: FieldGroup; disposition: 'fenced'; securityRevision: string };
export type Pending = { after: string; recordKey: string; bytes: string; keys: string[] };
export type DeferredCover<Projection = SourceProjection> = Staged<Projection> & { kind: Kind };
export type Seal = {
  status: 'ready' | 'invalid-input' | 'mass-disappearance';
  prior: number;
  seenSurvivors: number;
  supplied: number;
  diagnostic: string;
};
type Kind = 'new' | 'changed' | 'unchanged' | 'vanished';
type Source = {
  source: string;
  sequence: number;
  lease_run: string | null;
  generation: string | null;
  present_count: number;
};
type Generation = {
  source: string;
  id: string;
  seq: number;
  lease: string;
  status: string;
  threshold: number;
  prior: number;
  supplied: number;
  survivors: number;
  invalid: number;
  classified: number;
  resolved: number;
  expected: number;
  changed: number;
  prepared: number;
  cursor: string;
  skipped?: number;
};
type Entry = {
  source: string;
  run_id: string;
  record_key: string;
  row_json: string;
  projection_json: string;
  kind: Kind | null;
  resolved: number;
  bytes: string | null;
  keys_json: string;
  omissions_json: string;
  pending: number;
  remaining: number;
  cover_pending: number;
  reference_signature: string | null;
};
type Member = { source: string; record_key: string; active: number; seen: number; row_json: string };
type Command = {
  source: string;
  run_id: string;
  command_key: string;
  record_key: string;
  field_group: FieldGroup;
  op: BatchCommand['op'];
  envelope_index: number;
  done: number;
};
type Envelope = {
  record_key: string;
  envelope_index: number;
  multi: number;
  bytes: string;
  keys_json: string;
};

export const RUN_TABLES = [
  'run_sources',
  'run_generations',
  'run_entries',
  'run_members',
  'run_acknowledged',
  'run_commands',
  'run_payloads',
  'run_envelopes',
] as const;

function fail(): never {
  throw new TypeError('Invalid run-store input');
}
function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    required.some((k) => !Object.hasOwn(value, k)) ||
    Reflect.ownKeys(value).some((k) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, k)!;
      return (
        typeof k !== 'string' ||
        (!required.includes(k) && !optional.includes(k)) ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      );
    })
  )
    fail();
}
function identifier(value: unknown, cap: number, pattern: RegExp): asserts value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > cap || !pattern.test(value)) fail();
}
function sourceId(value: unknown): asserts value is string {
  identifier(value, 64, /^[a-z][a-z0-9_-]*$/u);
}
function keyId(value: unknown): asserts value is string {
  // Native Open Library keys are opaque SQL identifiers; retain their leading slash.
  identifier(
    value,
    512,
    /^(?:[\p{L}\p{N}][\p{L}\p{N}._:/@+\-]*|\/(?:works\/OL[1-9][0-9]*W|books\/OL[1-9][0-9]*M|authors\/OL[1-9][0-9]*A))$/u,
  );
}
function validateRun(run: Run) {
  exact(run, ['source', 'id', 'lease']);
  sourceId(run.source);
  identifier(run.id, 32, /^[1-9][0-9]*$/u);
  identifier(run.lease, 48, /^[a-f0-9]{48}$/u);
}
function pageLimit(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 100) fail();
}
function boundedJson(value: unknown, cap = 65536, commandBodies?: string[]): string {
  // Serialize data descriptors directly so neither accessors nor toJSON can run.
  let budget = cap;
  const parts: string[] = [];
  const parents = new Set<object>();
  function append(bytes: string) {
    budget -= Buffer.byteLength(bytes);
    if (budget < 0) fail();
    parts.push(bytes);
  }
  function string(value: string) {
    if (Buffer.byteLength(value) > budget) fail();
    append(JSON.stringify(value));
  }
  function visit(v: unknown, depth: number) {
    const start = parts.length;
    if (depth > 64) fail();
    if (typeof v === 'string') {
      string(v);
      return;
    }
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) {
      append(JSON.stringify(v));
      return;
    }
    if (!v || typeof v !== 'object' || parents.has(v)) fail();
    const array = Array.isArray(v);
    if (
      array
        ? Object.getPrototypeOf(v) !== Array.prototype
        : ![Object.prototype, null].includes(Object.getPrototypeOf(v))
    )
      fail();
    parents.add(v);
    append(array ? '[' : '{');
    const keys = Reflect.ownKeys(v);
    const length = array ? (Object.getOwnPropertyDescriptor(v, 'length')!.value as number) : 0;
    if (array && (length > budget || keys.length !== length + 1)) fail();
    let count = 0;
    for (const k of keys) {
      if (array && k === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(v, k)!;
      if (typeof k !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
      if (array && k !== String(count)) fail();
      if (count++) append(',');
      if (!array) {
        string(k);
        append(':');
      }
      visit(descriptor.value, depth + 1);
    }
    append(array ? ']' : '}');
    parents.delete(v);
    // A request's commands are at depth two. Capture their already serialized
    // bytes once; splitting and the payload journal reuse these exact bodies.
    if (commandBodies && depth === 2) commandBodies.push(parts.slice(start).join(''));
  }
  try {
    visit(value, 0);
    return parts.join('');
  } catch {
    return fail();
  }
}
function validateRow(row: unknown): asserts row is RecordRow {
  exact(row, ['source', 'recordKey', 'recordRevision', 'digest', 'converter_revision', 'state']);
  sourceId(row.source);
  keyId(row.recordKey);
  identifier(row.recordRevision, 256, /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/u);
  identifier(row.converter_revision, 128, /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/u);
  identifier(row.digest, 64, /^[a-f0-9]{64}$/u);
  if (row.state !== 'present' && row.state !== 'vanished') fail();
}
// Validate the exported portable statement schema without a second statement contract.
// BatchStatementSchema uses only these JSON Schema keywords. Unknown keywords fail closed.
function matchesStatementSchema(schema: unknown, value: unknown): boolean {
  const s = schema as {
    anyOf?: unknown[];
    type?: string;
    const?: unknown;
    properties?: Record<string, unknown>;
    required?: string[];
    items?: unknown;
    minItems?: number;
    maxItems?: number;
    minLength?: number;
  };
  if (
    Object.keys(s).some(
      (k) =>
        !['anyOf', 'type', 'const', 'properties', 'required', 'items', 'minItems', 'maxItems', 'minLength'].includes(k),
    )
  )
    return false;
  if (s.anyOf) return s.anyOf.some((variant) => matchesStatementSchema(variant, value));
  if (Object.hasOwn(s, 'const')) return value === s.const;
  if (s.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>;
    return (
      (s.required ?? []).every((k) => Object.hasOwn(v, k)) &&
      Object.keys(v).every(
        (k) => !!s.properties && Object.hasOwn(s.properties, k) && matchesStatementSchema(s.properties[k], v[k]),
      )
    );
  }
  if (s.type === 'array')
    return (
      Array.isArray(value) &&
      value.length >= (s.minItems ?? 0) &&
      value.length <= (s.maxItems ?? Infinity) &&
      value.every((v) => matchesStatementSchema(s.items, v))
    );
  if (s.type === 'string') return typeof value === 'string' && [...value].length >= (s.minLength ?? 0);
  return Object.keys(s).length === 0;
}
const token = () => randomBytes(24).toString('hex');
const rowBytes = (row: RecordRow) =>
  JSON.stringify({
    source: row.source,
    recordKey: row.recordKey,
    recordRevision: row.recordRevision,
    digest: row.digest,
    converter_revision: row.converter_revision,
    state: row.state,
  });

/**
 * Importer-only state: no transport, source mapping, subject identity generation or kernel authority.
 * Current acknowledgements and completed source snapshots are separate authorities for separate facts.
 * run_acknowledged is this store's acknowledgement authority. A future RecordStore integration MUST
 * supply a transaction adapter on this same Database, replacing these exact acknowledgement reads/
 * writes inside this transaction; independently calling RecordStore.put would create two authorities
 * and cannot atomically discharge journal commands. No such adapter is installed implicitly.
 *
 * All methods are synchronous bounded operations, suitable for an async coordinator to forward.
 * The constructor instruments the actual handle before schema work or preparing any statement.
 */
export class RunStore<Projection = BatchStatement[]> {
  readonly database: Database;
  private closed = false;
  private readonly statements = new Map<string, Statement>();
  private preparer: unknown;
  private readonly projectionMode: 'source-record' | undefined;
  constructor(
    path: string | Database,
    options: {
      instrumentDatabase?: (database: Database) => Database;
      projectionMode?: 'source-record';
    } = {},
  ) {
    if (options.projectionMode !== undefined && options.projectionMode !== 'source-record') fail();
    this.projectionMode = options.projectionMode;
    const db = typeof path === 'string' ? new Database(path, { create: true, strict: true }) : path;
    try {
      this.database = options.instrumentDatabase?.(db) ?? db;
      this.database.exec('PRAGMA journal_mode=WAL');
      this.database.exec('PRAGMA busy_timeout=5000');
      this.database.exec('PRAGMA synchronous=NORMAL');
      // Schema initialization happens once per connection, never in a run operation.
      this.database.exec(`CREATE TABLE IF NOT EXISTS run_sources (
        source TEXT PRIMARY KEY, sequence INTEGER NOT NULL, lease_run TEXT,
        generation TEXT, present_count INTEGER NOT NULL) WITHOUT ROWID`);
      this.database.exec(`CREATE TABLE IF NOT EXISTS run_generations (
        source TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, lease TEXT NOT NULL,
        status TEXT NOT NULL, threshold REAL NOT NULL, prior INTEGER NOT NULL,
        supplied INTEGER NOT NULL DEFAULT 0, survivors INTEGER NOT NULL DEFAULT 0,
        invalid INTEGER NOT NULL DEFAULT 0, classified INTEGER NOT NULL DEFAULT 0,
        resolved INTEGER NOT NULL DEFAULT 0, expected INTEGER NOT NULL DEFAULT 0,
        changed INTEGER NOT NULL DEFAULT 0, prepared INTEGER NOT NULL DEFAULT 0,
        cursor TEXT NOT NULL DEFAULT '', skipped INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(source,id)) WITHOUT ROWID`);
      // Additive migration leaves existing run journals and immutable prepared work intact.
      const generationColumns = this.all<{ name: string }>('PRAGMA table_info(run_generations)');
      if (!generationColumns.some(({ name }) => name === 'skipped'))
        this.database.exec('ALTER TABLE run_generations ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0');
      this.database.exec(`CREATE TABLE IF NOT EXISTS run_entries (
        source TEXT NOT NULL, run_id TEXT NOT NULL, record_key TEXT NOT NULL,
        row_json TEXT NOT NULL, projection_json TEXT NOT NULL, kind TEXT,
        resolved INTEGER NOT NULL DEFAULT 0, bytes TEXT, keys_json TEXT NOT NULL DEFAULT '[]',
        omissions_json TEXT NOT NULL DEFAULT '[]', pending INTEGER NOT NULL DEFAULT 0,
        remaining INTEGER NOT NULL DEFAULT 0, cover_pending INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(source,run_id,record_key)) WITHOUT ROWID`);
      const entryColumns = this.database.query('PRAGMA table_info(run_entries)').all() as { name: string }[];
      if (!entryColumns.some((column) => column.name === 'cover_pending'))
        this.database.exec('ALTER TABLE run_entries ADD COLUMN cover_pending INTEGER NOT NULL DEFAULT 0');
      if (!entryColumns.some((column) => column.name === 'reference_signature'))
        this.database.exec('ALTER TABLE run_entries ADD COLUMN reference_signature TEXT');
      this.database.exec(`CREATE INDEX IF NOT EXISTS run_pending ON run_entries(source,run_id,pending,record_key)`);
      this.database.exec(
        'CREATE INDEX IF NOT EXISTS run_cover_pending ON run_entries(source,run_id,cover_pending,record_key)',
      );
      this.database.exec(`CREATE TABLE IF NOT EXISTS run_members (
        source TEXT NOT NULL, record_key TEXT NOT NULL, active INTEGER NOT NULL,
        seen INTEGER NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY(source,record_key)) WITHOUT ROWID`);
      // active=1 excludes all vanished history; seen<generation excludes the S staged survivors.
      // (seen,key) is the composite disappearance cursor. Even failed stages keep seen<next generation.
      this.database.exec(`CREATE INDEX IF NOT EXISTS run_missing ON run_members(source,active,seen,record_key)`);
      this.database.exec(`CREATE TABLE IF NOT EXISTS run_acknowledged (
        source TEXT NOT NULL, record_key TEXT NOT NULL, row_json TEXT NOT NULL,
        projection_json TEXT NOT NULL, PRIMARY KEY(source,record_key)) WITHOUT ROWID`);
      this.database.exec(`CREATE TABLE IF NOT EXISTS run_reference_signatures (
        source TEXT NOT NULL, record_key TEXT NOT NULL, signature TEXT NOT NULL,
        PRIMARY KEY(source,record_key)) WITHOUT ROWID`);
      this.database.exec(`CREATE TABLE IF NOT EXISTS run_commands (
        source TEXT NOT NULL, run_id TEXT NOT NULL, command_key TEXT NOT NULL,
        record_key TEXT NOT NULL, field_group TEXT NOT NULL, op TEXT NOT NULL,
        envelope_index INTEGER NOT NULL, done INTEGER NOT NULL,
        PRIMARY KEY(source,run_id,command_key)) WITHOUT ROWID`);
      this.database.exec(`CREATE TABLE IF NOT EXISTS run_payloads (
        source TEXT NOT NULL, command_key TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(source,command_key)) WITHOUT ROWID`);
      this.database.exec(`CREATE TABLE IF NOT EXISTS run_envelopes (
        source TEXT NOT NULL, run_id TEXT NOT NULL, record_key TEXT NOT NULL,
        envelope_index INTEGER NOT NULL, multi INTEGER NOT NULL,
        bytes TEXT NOT NULL, keys_json TEXT NOT NULL, remaining INTEGER NOT NULL,
        pending INTEGER NOT NULL, PRIMARY KEY(source,run_id,record_key,envelope_index)) WITHOUT ROWID`);
      this.database.exec(`CREATE INDEX IF NOT EXISTS run_envelope_pending
        ON run_envelopes(source,run_id,pending,record_key,envelope_index)`);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  /**
   * Every SQL text is a literal, so the cache holds one statement per call site. Replacing the
   * connection's prepare entry point (instrumentation installed or removed) starts a new cache.
   */
  private query(sql: string) {
    if (this.closed) throw new Error('Run store is closed');
    if (this.database.prepare !== this.preparer) {
      for (const cached of this.statements.values()) cached.finalize();
      this.statements.clear();
      this.preparer = this.database.prepare;
    }
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  private get<T>(sql: string, ...args: SQLQueryBindings[]): T | null {
    return this.query(sql).get(...args) as T | null;
  }
  private all<T>(sql: string, ...args: SQLQueryBindings[]): T[] {
    return this.query(sql).all(...args) as T[];
  }
  private write(sql: string, ...args: SQLQueryBindings[]) {
    return this.query(sql).run(...args);
  }
  private transaction<T>(fn: () => T): T {
    // Inside ImportSession.atomic the enclosing transaction owns the commit.
    if (this.database.inTransaction) return fn();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.database.exec('COMMIT');
      return value;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  private generation(run: Run, terminal = false): Generation {
    validateRun(run);
    const g = this.get<Generation>('SELECT * FROM run_generations WHERE source=? AND id=?', run.source, run.id);
    if (!g || g.lease !== run.lease || (!terminal && !['staging', 'ready', 'finalizing'].includes(g.status)))
      throw new Error('Run capability is stale or terminal');
    return g;
  }
  private release(run: Run, status: string) {
    this.write('UPDATE run_generations SET status=? WHERE source=? AND id=?', status, run.source, run.id);
    this.write('UPDATE run_sources SET lease_run=NULL WHERE source=? AND lease_run=?', run.source, run.id);
  }
  begin(source: string, options: { disappearanceThreshold?: number } = {}): Run | 'busy' {
    sourceId(source);
    exact(options, [], ['disappearanceThreshold']);
    const threshold = options.disappearanceThreshold ?? 0.2;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) fail();
    return this.transaction(() => {
      const s = this.get<Source>('SELECT * FROM run_sources WHERE source=?', source);
      if (s?.lease_run) return 'busy';
      const seq = (s?.sequence ?? 0) + 1;
      if (!Number.isSafeInteger(seq)) throw new Error('Source sequence exhausted');
      const run = { source, id: String(seq), lease: token() };
      this.write(
        `INSERT INTO run_sources(source,sequence,lease_run,generation,present_count) VALUES(?,?,?,?,?)
        ON CONFLICT(source) DO UPDATE SET sequence=excluded.sequence,lease_run=excluded.lease_run`,
        source,
        seq,
        run.id,
        s?.generation ?? null,
        s?.present_count ?? 0,
      );
      this.write(
        `INSERT INTO run_generations(source,id,seq,lease,status,threshold,prior) VALUES(?,?,?,?,?,?,?)`,
        source,
        run.id,
        seq,
        run.lease,
        'staging',
        threshold,
        s?.present_count ?? 0,
      );
      return run;
    });
  }
  activeRun(source: string): Run | null {
    sourceId(source);
    const active = this.get<{ lease_run: string; id: string; lease: string }>(
      `SELECT s.lease_run,g.id,g.lease FROM run_sources AS s
      JOIN run_generations AS g ON g.source=s.source AND g.id=s.lease_run
      WHERE s.source=? AND s.lease_run IS NOT NULL
      AND g.status IN ('staging','ready','finalizing')`,
      source,
    );
    return active ? { source, id: active.id, lease: active.lease } : null;
  }
  /** Exact identity lookup for the bounded count sealed with this acquisition. */
  skipped(run: Run): number {
    const g = this.generation(run, true);
    return g.skipped ?? 0;
  }
  pageStaged(run: Run, options: { after?: string; limit: number }): Staged<Projection>[] {
    exact(options, ['limit'], ['after']);
    pageLimit(options.limit);
    if (options.after !== undefined) keyId(options.after);
    validateRun(run);
    const sealed = this.get<{ id: string }>(
      `SELECT g.id FROM run_sources AS s
      JOIN run_generations AS g ON g.source=s.source AND g.id=s.lease_run
      WHERE s.source=? AND s.lease_run=? AND g.id=? AND g.lease=? AND g.status='ready'`,
      run.source,
      run.id,
      run.id,
      run.lease,
    );
    if (!sealed) throw new Error('Run is stale, unsealed, failed, or no longer current');
    const rows =
      options.after === undefined
        ? this.all<{ row_json: string; projection_json: string }>(
            `SELECT row_json,projection_json FROM run_entries
          WHERE source=? AND run_id=? ORDER BY record_key LIMIT ?`,
            run.source,
            run.id,
            options.limit,
          )
        : this.all<{ row_json: string; projection_json: string }>(
            `SELECT row_json,projection_json FROM run_entries
          WHERE source=? AND run_id=? AND record_key>? ORDER BY record_key LIMIT ?`,
            run.source,
            run.id,
            options.after,
            options.limit,
          );
    return rows.map((entry) => ({ row: JSON.parse(entry.row_json), projection: JSON.parse(entry.projection_json) }));
  }
  pageAcknowledged(source: string, options: { after?: string; limit: number }): RecordRow[] {
    sourceId(source);
    exact(options, ['limit'], ['after']);
    pageLimit(options.limit);
    if (options.after !== undefined) keyId(options.after);
    const rows =
      options.after === undefined
        ? this.all<{ row_json: string }>(
            `SELECT row_json FROM run_acknowledged WHERE source=? ORDER BY record_key LIMIT ?`,
            source,
            options.limit,
          )
        : this.all<{ row_json: string }>(
            `SELECT row_json FROM run_acknowledged WHERE source=? AND record_key>? ORDER BY record_key LIMIT ?`,
            source,
            options.after,
            options.limit,
          );
    return rows.map((entry) => JSON.parse(entry.row_json));
  }
  reopen(run: Run): Run {
    return this.transaction(() => {
      this.generation(run);
      const lease = token();
      this.write('UPDATE run_generations SET lease=? WHERE source=? AND id=?', lease, run.source, run.id);
      return { source: run.source, id: run.id, lease };
    });
  }
  abandon(run: Run): 'abandoned' | 'pending-work' {
    return this.transaction(() => {
      const g = this.generation(run);
      if (g.prepared || g.status === 'finalizing') return 'pending-work';
      this.release(run, 'abandoned');
      return 'abandoned';
    });
  }
  stage(run: Run, record: Staged<Projection>): void {
    exact(record, ['row', 'projection']);
    validateRow(record.row);
    if (record.row.source !== run.source || record.row.state !== 'present') fail();
    let projection: string;
    if (this.projectionMode === 'source-record') {
      const sourceProjection: unknown = record.projection;
      exact(sourceProjection, ['sourceKind', 'normalizedRecord']);
      if (!['bangumi', 'vndb', 'openlibrary', 'wikidata'].includes(sourceProjection.sourceKind as string)) fail();
      // Only the caller's sanitized converter input is retained; row metadata stays separate.
      const normalizedRecord = boundedJson(sourceProjection.normalizedRecord, MAX_DUMP_RECORD_BYTES);
      projection = `{"sourceKind":${JSON.stringify(sourceProjection.sourceKind)},"normalizedRecord":${normalizedRecord}}`;
    } else {
      if (!Array.isArray(record.projection)) fail();
      projection = boundedJson(record.projection);
      if (!record.projection.every((p) => matchesStatementSchema(BatchStatementSchema, p))) fail();
    }
    const duplicate = this.transaction(() => {
      const g = this.generation(run);
      if (g.status !== 'staging') throw new Error('Run is sealed');
      const inserted = this.write(
        `INSERT OR IGNORE INTO run_entries(source,run_id,record_key,row_json,projection_json)
        VALUES(?,?,?,?,?)`,
        run.source,
        run.id,
        record.row.recordKey,
        rowBytes(record.row),
        projection,
      );
      if (!inserted.changes) {
        this.write('UPDATE run_generations SET invalid=1 WHERE source=? AND id=?', run.source, run.id);
        return true;
      }
      const m = this.get<Member>(
        'SELECT * FROM run_members WHERE source=? AND record_key=?',
        run.source,
        record.row.recordKey,
      );
      const survivor = m?.active === 1 && m.seen !== g.seq ? 1 : 0;
      if (survivor)
        this.write(
          'UPDATE run_members SET seen=? WHERE source=? AND record_key=?',
          g.seq,
          run.source,
          record.row.recordKey,
        );
      this.write(
        'UPDATE run_generations SET supplied=supplied+1,survivors=survivors+? WHERE source=? AND id=?',
        survivor,
        run.source,
        run.id,
      );
      return false;
    });
    if (duplicate) throw new Error('Duplicate staged key invalidates input');
  }
  seal(
    run: Run,
    input: { complete: true; skipped?: number } | { complete: false; reason: 'malformed' | 'truncated' },
  ): Seal {
    if (input.complete === true) {
      exact(input, ['complete'], ['skipped']);
      const skipped = input.skipped ?? 0;
      if (!Number.isSafeInteger(skipped) || skipped < 0) fail();
    } else {
      exact(input, ['complete', 'reason']);
      if (input.complete !== false || !['malformed', 'truncated'].includes(input.reason)) fail();
    }
    return this.transaction(() => {
      const g = this.generation(run);
      if (g.status !== 'staging') throw new Error('Run is already sealed');
      const skippedCount = input.complete === true ? (input.skipped ?? 0) : 0;
      const missing = g.prior - g.survivors;
      const status =
        !input.complete || g.invalid
          ? 'invalid-input'
          : g.prior > 0 && (missing === g.prior || missing / g.prior > g.threshold)
            ? 'mass-disappearance'
            : 'ready';
      if (status !== 'ready') this.release(run, status);
      else
        this.write(
          'UPDATE run_generations SET status=?,expected=?,skipped=? WHERE source=? AND id=?',
          'ready',
          g.supplied + missing,
          skippedCount,
          run.source,
          run.id,
        );
      return {
        status,
        prior: g.prior,
        seenSurvivors: g.survivors,
        supplied: g.supplied,
        diagnostic:
          status === 'ready'
            ? 'Input sealed'
            : status === 'invalid-input'
              ? 'Input is incomplete or invalid'
              : 'Disappearance threshold exceeded',
      };
    });
  }
  private entry(run: Run, key: string) {
    return this.get<Entry>(
      'SELECT * FROM run_entries WHERE source=? AND run_id=? AND record_key=?',
      run.source,
      run.id,
      key,
    );
  }
  private resolve(run: Run, entry: Entry) {
    if (entry.resolved || entry.remaining || entry.cover_pending) return;
    this.write(
      'UPDATE run_entries SET resolved=1,pending=0 WHERE source=? AND run_id=? AND record_key=?',
      run.source,
      run.id,
      entry.record_key,
    );
    this.write(
      `INSERT INTO run_acknowledged(source,record_key,row_json,projection_json) VALUES(?,?,?,?)
      ON CONFLICT(source,record_key) DO UPDATE SET row_json=excluded.row_json,projection_json=excluded.projection_json`,
      run.source,
      entry.record_key,
      entry.row_json,
      entry.projection_json,
    );
    if (entry.reference_signature !== null)
      this.write(
        `INSERT INTO run_reference_signatures(source,record_key,signature) VALUES(?,?,?)
        ON CONFLICT(source,record_key) DO UPDATE SET signature=excluded.signature`,
        run.source,
        entry.record_key,
        entry.reference_signature,
      );
    this.write('UPDATE run_generations SET resolved=resolved+1 WHERE source=? AND id=?', run.source, run.id);
  }
  classify(run: Run, key: string, input: { commands: BatchCommand[]; omissions?: Omission[] }): Kind {
    return this.plan(run, key, input, false);
  }
  referenceSignature(source: string, key: string): string | null {
    sourceId(source);
    keyId(key);
    return this.get<{ signature: string }>(
      'SELECT signature FROM run_reference_signatures WHERE source=? AND record_key=?',
      source,
      key,
    )?.signature ?? null;
  }
  stageReferenceSignature(run: Run, key: string, signature: string): void {
    validateRun(run);
    keyId(key);
    if (!/^[a-f0-9]{64}$/u.test(signature)) fail();
    this.transaction(() => {
      if (!this.entry(run, key)) throw new Error('Reference signature requires a staged record');
      this.write(
        'UPDATE run_entries SET reference_signature=? WHERE source=? AND run_id=? AND record_key=?',
        signature,
        run.source,
        run.id,
        key,
      );
    });
  }
  /**
   * Trusted coordinator disposition after classification: only a pure converter ignored
   * outcome or an exact current candidate lookup can establish no owned effects.
   * This is neither a receipt nor fence evidence; every refresh must still check all tuple fences.
   */
  acknowledgeNoEffects(run: Run, key: string, input: { reason: 'converter-ignored' | 'no-owned-candidates' }): void {
    validateRun(run);
    keyId(key);
    exact(input, ['reason']);
    if (input.reason !== 'converter-ignored' && input.reason !== 'no-owned-candidates') fail();
    this.transaction(() => {
      const live = this.get<{ id: string }>(
        `SELECT g.id FROM run_sources AS s
        JOIN run_generations AS g ON g.source=s.source AND g.id=s.lease_run
        WHERE s.source=? AND s.lease_run=? AND g.id=? AND g.lease=? AND g.status='ready'`,
        run.source,
        run.id,
        run.id,
        run.lease,
      );
      if (!live) throw new Error('Run is stale, unsealed, failed, or no longer current');
      const entry = this.entry(run, key);
      // Original keys/bytes are immutable even after commands are acknowledged or fenced.
      if (!entry?.kind || entry.bytes !== null || entry.keys_json !== '[]' || entry.remaining || entry.pending)
        throw new Error('No-effect acknowledgement requires a classified empty command plan');
      this.resolve(run, entry);
    });
  }
  /** Private record plan; every dispatch still uses the portable one-envelope contract. */
  prepare(
    run: Run,
    key: string,
    input: { commands: BatchCommand[]; omissions?: Omission[]; deferredCover?: boolean },
  ): Kind {
    return this.plan(run, key, input, true);
  }
  private plan(
    run: Run,
    key: string,
    input: { commands: BatchCommand[]; omissions?: Omission[]; deferredCover?: boolean },
    multi: boolean,
  ): Kind {
    keyId(key);
    exact(input, ['commands'], ['omissions', 'deferredCover']);
    if (input.deferredCover !== undefined && typeof input.deferredCover !== 'boolean') fail();
    if (!Array.isArray(input.commands) || input.commands.length > (multi ? 300 : 100)) fail();
    const request: ImportBatchRequest = { commands: input.commands };
    const bodies: string[] = [];
    const bytes = boundedJson(request, multi ? 2 * 1024 * 1024 : 65536, bodies);
    // Work only with the descriptor-checked JSON snapshot from here onward.
    const commands = (JSON.parse(bytes) as ImportBatchRequest).commands;
    const envelopes: { bytes: string; keys: string[] }[] = [];
    const commandEnvelopes: number[] = [];
    const unique = new Set<string>();
    let parts: string[] = [];
    let keys: string[] = [];
    let size = Buffer.byteLength('{"commands":[]}');
    const flush = () => {
      if (!parts.length) return;
      const body = `{"commands":[${parts.join(',')}]}`;
      if (checkBatch(JSON.parse(body)).length) fail();
      envelopes.push({ bytes: body, keys });
      parts = [];
      keys = [];
      size = Buffer.byteLength('{"commands":[]}');
    };
    for (let i = 0; i < commands.length; i++) {
      const c = commands[i]!;
      const body = bodies[i];
      if (!body || !c || typeof c !== 'object') fail();
      const length = Buffer.byteLength(body);
      if (length + Buffer.byteLength('{"commands":[]}') > 65536)
        throw new TypeError('Command byte size exceeds envelope limit');
      if (unique.has(c.key)) fail();
      unique.add(c.key);
      if (parts.length === 100 || size + length + (parts.length ? 1 : 0) > 65536) flush();
      commandEnvelopes.push(envelopes.length);
      size += length + (parts.length ? 1 : 0);
      parts.push(body);
      keys.push(c.key);
    }
    flush();
    const omissions = input.omissions ?? [];
    if (!Array.isArray(omissions) || omissions.length > 3) fail();
    boundedJson(omissions);
    const groups = new Set<FieldGroup>();
    for (const o of omissions) {
      exact(o, ['field_group', 'disposition', 'securityRevision']);
      if (!FIELD_GROUPS.includes(o.field_group) || o.disposition !== 'fenced' || groups.has(o.field_group)) fail();
      identifier(o.securityRevision, 256, /^[1-9][0-9]*$/u);
      groups.add(o.field_group);
    }
    return this.transaction(() => {
      const g = this.generation(run);
      if (g.status !== 'ready') throw new Error('Run is not ready for classification');
      let e = this.entry(run, key);
      if (!e) {
        const m = this.get<Member>('SELECT * FROM run_members WHERE source=? AND record_key=?', run.source, key);
        if (!m || !m.active || m.seen >= g.seq) throw new Error('Key is outside this snapshot');
        const row: RecordRow = { ...JSON.parse(m.row_json), state: 'vanished' };
        this.write(
          `INSERT INTO run_entries(source,run_id,record_key,row_json,projection_json) VALUES(?,?,?,?,?)`,
          run.source,
          run.id,
          key,
          rowBytes(row),
          '[]',
        );
        e = this.entry(run, key)!;
      }
      const row = JSON.parse(e.row_json) as RecordRow;
      for (const c of commands) {
        if (
          c.source.source !== run.source ||
          c.source.external_id !== key ||
          c.source.digest !== row.digest ||
          c.source.record_revision !== row.recordRevision ||
          c.source.converter_revision !== row.converter_revision
        )
          fail();
      }
      if (e.kind && commands.length && e.bytes !== bytes) throw new Error('Prepared command envelope is immutable');
      if (!e.kind) {
        const current = this.get<{ row_json: string; projection_json: string }>(
          'SELECT row_json,projection_json FROM run_acknowledged WHERE source=? AND record_key=?',
          run.source,
          key,
        );
        e.kind =
          row.state === 'vanished'
            ? 'vanished'
            : !current
              ? 'new'
              : current.row_json === e.row_json && current.projection_json === e.projection_json
                ? 'unchanged'
                : 'changed';
        if (multi && !commands.length && !omissions.length && !input.deferredCover && e.kind !== 'unchanged')
          throw new Error('Empty record plan requires unchanged or fenced proof');
        // A successful omission can acknowledge a record in an abandoned generation.
        // Snapshot equality must still compare against the complete pointer, not that ack.
        const baseline = this.get<{ row_json: string; projection_json: string }>(
          `SELECT row_json,projection_json FROM run_entries
          WHERE source=? AND run_id=(SELECT generation FROM run_sources WHERE source=?) AND record_key=?`,
          run.source,
          run.source,
          key,
        );
        const snapshotChanged =
          !baseline || baseline.row_json !== e.row_json || baseline.projection_json !== e.projection_json;
        const keys: string[] = [];
        // Each original request envelope is stored before this transaction returns to a caller/transport.
        for (let i = 0; i < commands.length; i++) {
          const c = commands[i]!;
          const body = bodies[i]!;
          const old = this.get<{ body: string }>(
            'SELECT body FROM run_payloads WHERE source=? AND command_key=?',
            run.source,
            c.key,
          );
          if (old && old.body !== body) throw new Error('Command key already has a different payload');
          if (!old)
            this.write('INSERT INTO run_payloads(source,command_key,body) VALUES(?,?,?)', run.source, c.key, body);
          this.write(
            `INSERT INTO run_commands(source,run_id,command_key,record_key,field_group,op,envelope_index,done)
            VALUES(?,?,?,?,?,?,?,?)`,
            run.source,
            run.id,
            c.key,
            key,
            c.source.field_group,
            c.op,
            commandEnvelopes[i]!,
            0,
          );
          keys.push(c.key);
        }
        for (let i = 0; i < envelopes.length; i++) {
          const envelope = envelopes[i]!;
          this.write(
            `INSERT INTO run_envelopes(source,run_id,record_key,envelope_index,multi,bytes,keys_json,remaining,pending)
            VALUES(?,?,?,?,?,?,?,?,?)`,
            run.source,
            run.id,
            key,
            i,
            envelopes.length > 1 ? 1 : 0,
            envelope.bytes,
            JSON.stringify(envelope.keys),
            envelope.keys.length,
            1,
          );
        }
        e.bytes = keys.length ? bytes : null;
        e.keys_json = JSON.stringify(keys);
        e.remaining = keys.length;
        this.write(
          `UPDATE run_entries SET kind=?,bytes=?,keys_json=?,remaining=?,pending=? WHERE source=? AND run_id=? AND record_key=?`,
          e.kind,
          e.bytes,
          e.keys_json,
          e.remaining,
          e.remaining ? 1 : 0,
          run.source,
          run.id,
          key,
        );
        this.write(
          `UPDATE run_generations SET classified=classified+1,changed=changed+?,prepared=prepared+?
          WHERE source=? AND id=?`,
          snapshotChanged ? 1 : 0,
          keys.length ? 1 : 0,
          run.source,
          run.id,
        );
      }
      const saved: Omission[] = JSON.parse(e.omissions_json);
      for (const omission of omissions) {
        const i = saved.findIndex((o) => o.field_group === omission.field_group);
        if (i < 0) saved.push(omission);
        else {
          const prior = saved[i]!.securityRevision;
          const next = omission.securityRevision;
          if (prior.length < next.length || (prior.length === next.length && prior <= next)) saved[i] = omission;
        }
      }
      if (omissions.length) {
        this.write(
          'UPDATE run_entries SET omissions_json=? WHERE source=? AND run_id=? AND record_key=?',
          JSON.stringify(saved),
          run.source,
          run.id,
          key,
        );
        for (const commandKey of JSON.parse(e.keys_json) as string[]) {
          const c = this.get<Command>(
            'SELECT * FROM run_commands WHERE source=? AND run_id=? AND command_key=?',
            run.source,
            run.id,
            commandKey,
          )!;
          if (!c.done && saved.some((o) => o.field_group === c.field_group)) {
            this.completeCommand(run, c);
            e.remaining--;
          }
        }
        this.write(
          'UPDATE run_entries SET remaining=? WHERE source=? AND run_id=? AND record_key=?',
          e.remaining,
          run.source,
          run.id,
          key,
        );
      }
      if (input.deferredCover) {
        e.cover_pending = 1;
        this.write(
          'UPDATE run_entries SET cover_pending=1 WHERE source=? AND run_id=? AND record_key=?',
          run.source,
          run.id,
          key,
        );
      }
      if (e.bytes || e.kind === 'unchanged' || saved.length) this.resolve(run, e);
      return e.kind;
    });
  }
  pageDeferredCovers(run: Run, page: { after?: string; limit: number }): DeferredCover<Projection>[] {
    exact(page, ['limit'], ['after']);
    pageLimit(page.limit);
    if (page.after !== undefined) keyId(page.after);
    const g = this.generation(run, true);
    if (!['ready', 'finalizing'].includes(g.status)) return [];
    const rows = this.all<{ row_json: string; projection_json: string; kind: Kind }>(
      `SELECT row_json,projection_json,kind FROM run_entries INDEXED BY run_cover_pending
      WHERE source=? AND run_id=? AND cover_pending=1 AND record_key>?
      ORDER BY record_key LIMIT ?`,
      run.source,
      run.id,
      page.after ?? '',
      page.limit,
    );
    return rows.map((entry) => ({
      row: JSON.parse(entry.row_json),
      projection: JSON.parse(entry.projection_json),
      kind: entry.kind,
    }));
  }
  resolveDeferredCover(run: Run, key: string, input: { omission?: Omission } = {}): { resolved: boolean; kind: Kind } {
    validateRun(run);
    keyId(key);
    exact(input, [], ['omission']);
    return this.transaction(() => {
      const g = this.generation(run, true);
      if (!['ready', 'finalizing'].includes(g.status)) throw new Error('Run is not ready');
      const entry = this.entry(run, key);
      if (!entry?.kind || !entry.cover_pending) throw new Error('Cover is not deferred');
      const omissions: Omission[] = JSON.parse(entry.omissions_json);
      if (input.omission) {
        const omission = input.omission;
        exact(omission, ['field_group', 'disposition', 'securityRevision']);
        if (
          omission.field_group !== 'cover' ||
          omission.disposition !== 'fenced' ||
          !/^[1-9][0-9]*$/u.test(omission.securityRevision)
        )
          fail();
        const prior = omissions.findIndex((value) => value.field_group === 'cover');
        if (prior < 0) omissions.push(omission);
        else omissions[prior] = omission;
      }
      entry.cover_pending = 0;
      this.write(
        'UPDATE run_entries SET cover_pending=0,omissions_json=? WHERE source=? AND run_id=? AND record_key=?',
        JSON.stringify(omissions),
        run.source,
        run.id,
        key,
      );
      this.resolve(run, entry);
      return { resolved: !entry.remaining, kind: entry.kind };
    });
  }
  pagePending(run: Run, page: { after?: string; limit: number }): Pending[] {
    exact(page, ['limit'], ['after']);
    pageLimit(page.limit);
    let recordKey = '';
    let envelopeIndex = -1;
    if (page.after !== undefined) {
      if (typeof page.after !== 'string') fail();
      if (page.after.startsWith('!')) {
        identifier(page.after, 2048, /^![A-Za-z0-9_-]+$/u);
        let cursor: { source: string; run: string; record: string; envelope: number };
        try {
          cursor = JSON.parse(Buffer.from(page.after.slice(1), 'base64url').toString('utf8'));
        } catch {
          return fail();
        }
        exact(cursor, ['source', 'run', 'record', 'envelope']);
        if (cursor.source !== run.source || cursor.run !== run.id) fail();
        keyId(cursor.record);
        if (!Number.isInteger(cursor.envelope) || cursor.envelope < 0 || cursor.envelope >= 300) fail();
        recordKey = cursor.record;
        envelopeIndex = cursor.envelope;
      } else {
        keyId(page.after);
        recordKey = page.after;
        // Legacy single-envelope cursors continue after the whole record key.
        envelopeIndex = 300;
      }
    }
    const g = this.generation(run, true);
    if (!['ready', 'finalizing'].includes(g.status)) return [];
    return this.all<Envelope>(
      `SELECT record_key,envelope_index,multi,bytes,keys_json FROM run_envelopes INDEXED BY run_envelope_pending
      WHERE source=? AND run_id=? AND pending=1 AND (record_key,envelope_index)>(?,?)
      ORDER BY record_key,envelope_index LIMIT ?`,
      run.source,
      run.id,
      recordKey,
      envelopeIndex,
      page.limit,
    ).map((e) => ({
      after: e.multi
        ? '!' +
          Buffer.from(
            JSON.stringify({ source: run.source, run: run.id, record: e.record_key, envelope: e.envelope_index }),
          ).toString('base64url')
        : e.record_key,
      recordKey: e.record_key,
      bytes: e.bytes,
      keys: JSON.parse(e.keys_json),
    }));
  }
  pendingRecord(run: Run, key: string): Pending[] {
    validateRun(run);
    keyId(key);
    const g = this.generation(run, true);
    if (!['ready', 'finalizing'].includes(g.status)) return [];
    return this.all<Envelope>(
      `SELECT record_key,envelope_index,multi,bytes,keys_json FROM run_envelopes
      WHERE source=? AND run_id=? AND record_key=? AND pending=1
      ORDER BY envelope_index LIMIT 300`,
      run.source,
      run.id,
      key,
    ).map((envelope) => ({
      after: envelope.multi
        ? '!' +
          Buffer.from(
            JSON.stringify({
              source: run.source,
              run: run.id,
              record: envelope.record_key,
              envelope: envelope.envelope_index,
            }),
          ).toString('base64url')
        : envelope.record_key,
      recordKey: envelope.record_key,
      bytes: envelope.bytes,
      keys: JSON.parse(envelope.keys_json),
    }));
  }
  pageVanished(run: Run, page: { after?: string; limit: number }): RecordRow[] {
    validateRun(run);
    exact(page, ['limit'], ['after']);
    pageLimit(page.limit);
    if (page.after !== undefined) keyId(page.after);
    // A capability check with zero returned rows keeps the page's returned-row bound exactly M.
    // The no-op update is an exact run key seek; no in-memory lease cache can bypass a reopen fence.
    if (
      !this.write(
        `UPDATE run_generations SET lease=lease WHERE source=? AND id=? AND lease=? AND status='ready'`,
        run.source,
        run.id,
        run.lease,
      ).changes
    )
      throw new Error('Run is not ready');
    // after is the last emitted key. Its exact membership lookup recovers the seen half of
    // the durable composite cursor, including after failed staging touched some prior members.
    const after = page.after ?? '';
    return this.all<{ row_json: string }>(
      `SELECT m.row_json FROM run_members AS m INDEXED BY run_missing
      WHERE m.source=? AND m.active=1
        AND m.seen<(SELECT seq FROM run_generations WHERE source=? AND id=?)
        AND (m.seen,m.record_key)>(COALESCE((SELECT seen FROM run_members WHERE source=? AND record_key=?),-1),?)
      ORDER BY m.seen,m.record_key LIMIT ?`,
      run.source,
      run.source,
      run.id,
      run.source,
      after,
      after,
      page.limit,
    ).map((m) => JSON.parse(m.row_json) as RecordRow);
  }
  private completeCommand(run: Run, command: Command) {
    this.write(
      'UPDATE run_commands SET done=1 WHERE source=? AND run_id=? AND command_key=?',
      run.source,
      run.id,
      command.command_key,
    );
    this.write(
      `UPDATE run_envelopes SET remaining=remaining-1,pending=CASE WHEN remaining=1 THEN 0 ELSE 1 END
      WHERE source=? AND run_id=? AND record_key=? AND envelope_index=?`,
      run.source,
      run.id,
      command.record_key,
      command.envelope_index,
    );
  }
  acknowledge(run: Run, result: ImportBatchResult, scope?: { recordKey: string }): void {
    boundedJson(result);
    if (checkResult(result).length || new Set(result.results.map((r) => r.key)).size !== result.results.length) fail();
    if (scope !== undefined) {
      exact(scope, ['recordKey']);
      keyId(scope.recordKey);
    }
    this.transaction(() => {
      const g = this.generation(run, true);
      if (!['ready', 'complete'].includes(g.status)) throw new Error('Run is not ready');
      const completed: Command[] = [];
      // Validate the response once and seek only keyed command metadata. No
      // acknowledgement parses a record plan or searches its command array.
      for (const r of result.results) {
        const c = this.get<Command>(
          'SELECT * FROM run_commands WHERE source=? AND run_id=? AND command_key=?',
          run.source,
          run.id,
          r.key,
        );
        if (!c || (scope && c.record_key !== scope.recordKey)) throw new Error('Unknown or unowned command result');
        if (scope && 'value' in r) {
          const value = r.value;
          if (
            (c.op === 'create' && !Object.hasOwn(value, 'id')) ||
            (c.op === 'propose' && !Object.hasOwn(value, 'candidate')) ||
            (c.op === 'retract' && Object.keys(value).length !== 1)
          )
            throw new Error('Result value does not match command operation');
        }
        if (c.done || (r.status !== 200 && r.status !== 201)) continue;
        completed.push(c);
      }
      const decrements = new Map<string, number>();
      for (const c of completed) {
        this.completeCommand(run, c);
        decrements.set(c.record_key, (decrements.get(c.record_key) ?? 0) + 1);
      }
      for (const [key, count] of decrements) {
        const entry = this.get<{ remaining: number }>(
          `UPDATE run_entries SET remaining=remaining-? WHERE source=? AND run_id=? AND record_key=?
          RETURNING remaining`,
          count,
          run.source,
          run.id,
          key,
        )!;
        if (!entry.remaining) this.resolve(run, this.entry(run, key)!);
      }
    });
  }
  finalize(run: Run, pageCap: number): 'incomplete' | 'more' | 'complete' {
    pageLimit(pageCap);
    return this.transaction(() => {
      const g = this.generation(run, true);
      if (g.status === 'complete') return 'complete';
      if (!['ready', 'finalizing'].includes(g.status)) throw new Error('Run cannot finalize');
      if (g.classified !== g.expected || g.resolved !== g.expected) return 'incomplete';
      const entries = this.all<Entry>(
        `SELECT * FROM run_entries WHERE source=? AND run_id=? AND record_key>?
        ORDER BY record_key LIMIT ?`,
        run.source,
        run.id,
        g.cursor,
        pageCap,
      );
      for (const e of entries) {
        const row = JSON.parse(e.row_json) as RecordRow;
        this.write(
          `INSERT INTO run_members(source,record_key,active,seen,row_json) VALUES(?,?,?,?,?)
          ON CONFLICT(source,record_key) DO UPDATE SET active=excluded.active,seen=excluded.seen,row_json=excluded.row_json`,
          run.source,
          e.record_key,
          row.state === 'present' ? 1 : 0,
          g.seq,
          e.row_json,
        );
      }
      if (entries.length === pageCap) {
        this.write(
          'UPDATE run_generations SET status=?,cursor=? WHERE source=? AND id=?',
          'finalizing',
          entries[entries.length - 1]!.record_key,
          run.source,
          run.id,
        );
        return 'more';
      }
      // The complete pointer switches only after the durable S+D cursor is exhausted.
      // Old run_entries remain immutable baseline snapshots across partial/crashed finalization.
      this.write(
        `UPDATE run_sources SET generation=CASE WHEN generation IS NULL OR ? > 0 THEN ? ELSE generation END,
        present_count=?,lease_run=NULL WHERE source=? AND lease_run=?`,
        g.changed,
        run.id,
        g.supplied,
        run.source,
        run.id,
      );
      this.write('UPDATE run_generations SET status=? WHERE source=? AND id=?', 'complete', run.source, run.id);
      return 'complete';
    });
  }
  source(source: string): { generation: string | null; count: number } {
    sourceId(source);
    const s = this.get<Source>('SELECT * FROM run_sources WHERE source=?', source);
    return { generation: s?.generation ?? null, count: s?.present_count ?? 0 };
  }
  /** Optional bounded key observation; production staging never collects a source's keys. */
  key(
    source: string,
    key: string,
    run?: Run,
  ): {
    baseline: RecordRow | null;
    acknowledged: RecordRow | null;
    staged: Staged<Projection> | null;
    omissions: Omission[];
    coverPending: boolean;
    resolved: boolean;
    kind: Kind | null;
  } {
    sourceId(source);
    keyId(key);
    const s = this.source(source);
    const baseline = s.generation ? this.entry({ source, id: s.generation, lease: '' }, key) : null;
    const ack = this.get<{ row_json: string }>(
      'SELECT row_json FROM run_acknowledged WHERE source=? AND record_key=?',
      source,
      key,
    );
    let e: Entry | null = null;
    if (run) {
      if (run.source !== source) fail();
      const g = this.generation(run, true);
      if (['staging', 'ready', 'finalizing', 'complete'].includes(g.status)) e = this.entry(run, key);
    }
    return {
      baseline: baseline ? JSON.parse(baseline.row_json) : null,
      acknowledged: ack ? JSON.parse(ack.row_json) : null,
      staged: e ? { row: JSON.parse(e.row_json), projection: JSON.parse(e.projection_json) } : null,
      omissions: e ? JSON.parse(e.omissions_json) : [],
      coverPending: e?.cover_pending === 1,
      resolved: e?.resolved === 1,
      kind: e?.kind ?? null,
    };
  }
  close(): void {
    if (!this.closed) {
      this.statements.clear();
      this.database.close();
      this.closed = true;
    }
  }
}
