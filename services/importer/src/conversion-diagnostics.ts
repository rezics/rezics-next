import { Database, type SQLQueryBindings, type Statement } from 'bun:sqlite';
import { BATCH_LIMIT } from '@rezics/definitions/bulk';
import { sourceVocabularyLimits } from '@rezics/conversion/source-vocabulary';

/** Converter field collections (Open Library, Bangumi, VNDB titles, Wikidata statements). */
const CONVERTER_FIELD_CAP = 64;
/** VNDB admitted string budget; diagnostic codes may be sentences. */
const CONVERTER_SENTENCE_BYTES = 4096;
/** Shared conversion field-string budget used for JSON pointers. */
const CONVERTER_POINTER_BYTES = 1500;
/** Public envelope budget reused as the per-record diagnostic vector ceiling. */
const PUBLIC_ENVELOPE_BYTES = 65536;

export const CONVERSION_DIAGNOSTIC_LIMITS = Object.freeze({
  maxEntries: CONVERTER_FIELD_CAP + sourceVocabularyLimits.gaps + BATCH_LIMIT,
  maxPointerBytes: CONVERTER_POINTER_BYTES,
  maxCodeBytes: CONVERTER_SENTENCE_BYTES,
  maxCategoryBytes: 64,
  maxVectorBytes: PUBLIC_ENVELOPE_BYTES,
});

export const CONVERSION_DIAGNOSTIC_PHASES = ['staging', 'application'] as const;
export type ConversionDiagnosticPhase = (typeof CONVERSION_DIAGNOSTIC_PHASES)[number];

export type SanitizedConversionDiagnostic = {
  pointer: string;
  code: string;
  category?: string;
};

export type ConversionDiagnosticCoverage = 'recorded' | 'unavailable' | 'unsupported';

export type ConversionDiagnosticRecordView = {
  recordKey: string;
  phase: ConversionDiagnosticPhase;
  digest: string;
  converterRevision: string;
  recordRevision: string;
  diagnostics: readonly SanitizedConversionDiagnostic[];
};

export type ConversionDiagnosticGenerationView = {
  source: string;
  generation: string;
  status: string;
  live: boolean;
  coverage: ConversionDiagnosticCoverage;
  diagnosticRecords?: number;
  diagnosticEntries?: number;
};

export type ConversionDiagnosticPage = {
  generation: ConversionDiagnosticGenerationView;
  records: ConversionDiagnosticRecordView[];
  nextCursor: string | null;
};

export class ConversionDiagnosticError extends Error {
  constructor(message = 'Converter diagnostics are invalid') {
    super(message);
    this.name = 'ConversionDiagnosticError';
  }
}

const SOURCE_ID = /^[a-z][a-z0-9_-]*$/u;
const GENERATION_ID = /^[1-9][0-9]*$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/u;
const RECORD_KEY =
  /^(?:[\p{L}\p{N}][\p{L}\p{N}._:/@+\-]*|\/(?:works\/OL[1-9][0-9]*W|books\/OL[1-9][0-9]*M|authors\/OL[1-9][0-9]*A))$/u;
const PHASES = new Set<string>(CONVERSION_DIAGNOSTIC_PHASES);

function fail(message = 'Converter diagnostics are invalid'): never {
  throw new ConversionDiagnosticError(message);
}

function utf8Bytes(value: string): number {
  if (!value.isWellFormed()) fail();
  return Buffer.byteLength(value, 'utf8');
}

function jsonPointer(value: string): boolean {
  if (value === '') return true;
  if (!value.startsWith('/')) return false;
  for (let index = 1; index < value.length; index++) {
    if (value.charCodeAt(index) !== 126) continue;
    const escape = value.charCodeAt(index + 1);
    if (escape !== 48 && escape !== 49) return false;
    index++;
  }
  return true;
}

function ownData(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length > required.length + optional.length) fail();
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string') fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    if (!required.includes(key) && !optional.includes(key)) fail();
  }
  for (const key of required) if (!Object.hasOwn(record, key)) fail();
  return record;
}

export function isConversionDiagnosticPhase(value: unknown): value is ConversionDiagnosticPhase {
  return typeof value === 'string' && PHASES.has(value);
}

export function sanitizeConversionDiagnostics(input: unknown): SanitizedConversionDiagnostic[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) fail();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) fail();
  const length = lengthDescriptor.value;
  if (!Number.isInteger(length) || length < 0 || length > CONVERSION_DIAGNOSTIC_LIMITS.maxEntries) fail();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== length + 1) fail();
  const result: SanitizedConversionDiagnostic[] = [];
  let vectorBytes = 2;
  for (let index = 0; index < length; index++) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    const entry = ownData(descriptor.value, ['pointer', 'code'], ['category', 'sourceVocabularyGap']);
    if (typeof entry.pointer !== 'string' || typeof entry.code !== 'string') fail();
    const pointerBytes = utf8Bytes(entry.pointer);
    const codeBytes = utf8Bytes(entry.code);
    if (pointerBytes > CONVERSION_DIAGNOSTIC_LIMITS.maxPointerBytes) fail();
    if (codeBytes > CONVERSION_DIAGNOSTIC_LIMITS.maxCodeBytes) fail();
    if (!jsonPointer(entry.pointer)) fail();
    const sanitized: SanitizedConversionDiagnostic = { pointer: entry.pointer, code: entry.code };
    if (entry.category !== undefined) {
      if (typeof entry.category !== 'string') fail();
      const categoryBytes = utf8Bytes(entry.category);
      if (categoryBytes > CONVERSION_DIAGNOSTIC_LIMITS.maxCategoryBytes) fail();
      sanitized.category = entry.category;
    }
    const encoded = Buffer.byteLength(JSON.stringify(sanitized), 'utf8');
    vectorBytes += encoded + (index ? 1 : 0);
    if (vectorBytes > CONVERSION_DIAGNOSTIC_LIMITS.maxVectorBytes) fail();
    result.push(sanitized);
  }
  return result;
}

export function encodeDiagnosticCursor(input: {
  source: string;
  generation: string;
  view: 'records';
  after: string;
  phase?: ConversionDiagnosticPhase;
}): string {
  const body: Record<string, string> = {
    v: '1',
    source: input.source,
    generation: input.generation,
    view: input.view,
    after: input.after,
  };
  if (input.phase) body.phase = input.phase;
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

export function decodeDiagnosticCursor(
  token: string,
  expected: { source: string; generation: string; view: 'records'; phase?: ConversionDiagnosticPhase },
): { after: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    fail('Diagnostic cursor is invalid');
  }
  const body = ownData(parsed, ['v', 'source', 'generation', 'view', 'after'], ['phase']);
  if (
    body.v !== '1' ||
    body.source !== expected.source ||
    body.generation !== expected.generation ||
    body.view !== expected.view ||
    typeof body.after !== 'string'
  )
    fail('Diagnostic cursor is invalid');
  if ((body.phase ?? undefined) !== expected.phase) fail('Diagnostic cursor is invalid');
  admitRecordKey(body.after);
  return { after: body.after };
}

export function admitSourceId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || utf8Bytes(value) > 64 || !SOURCE_ID.test(value)) fail('Invalid diagnostic source');
}

export function admitGenerationId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || utf8Bytes(value) > 32 || !GENERATION_ID.test(value))
    fail('Invalid diagnostic generation');
}

export function admitRecordKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || utf8Bytes(value) > 512 || !RECORD_KEY.test(value)) fail('Invalid diagnostic record');
}

export function admitDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail();
}

export function admitRevision(value: unknown, cap: number): asserts value is string {
  if (typeof value !== 'string' || utf8Bytes(value) > cap || !REVISION.test(value)) fail();
}

export function escapeDiagnosticText(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 32 || code === 127) result += `\\u${code.toString(16).padStart(4, '0')}`;
    else result += char;
  }
  return result;
}

export function importInvocationShape(): string {
  return [
    'rezics-import --source <source> --dump <dump-path> --state <state-path>',
    '--api <https-origin> --account-key <key-path> --account <account-uuid>',
    '--client <client-id> --auth <https-origin>',
  ].join(' ');
}

const LIVE_STATUS = new Set(['staging', 'ready', 'finalizing']);

export class ConversionDiagnosticsView {
  private readonly statements = new Map<string, Statement>();
  private preparer: unknown;
  readonly capability: 'recorded' | 'unsupported';
  private readonly hasCore: boolean;
  constructor(readonly database: Database) {
    const tables = this.all<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('run_sources','run_generations','run_conversion_diagnostics','run_conversion_diagnostic_records') ORDER BY name",
    );
    const names = new Set(tables.map((row) => row.name));
    this.hasCore = names.has('run_sources') && names.has('run_generations');
    this.capability =
      this.hasCore && names.has('run_conversion_diagnostics') && names.has('run_conversion_diagnostic_records')
        ? 'recorded'
        : 'unsupported';
  }
  private query(sql: string) {
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
  close(): void {
    for (const cached of this.statements.values()) cached.finalize();
    this.statements.clear();
  }
  resolveGeneration(source: string, generation?: string): ConversionDiagnosticGenerationView {
    admitSourceId(source);
    if (generation !== undefined) admitGenerationId(generation);
    if (!this.hasCore)
      return {
        source,
        generation: generation ?? '',
        status: 'missing',
        live: false,
        coverage: 'unsupported',
      };
    const pointer = this.get<{ lease_run: string | null; generation: string | null }>(
      'SELECT lease_run,generation FROM run_sources WHERE source=?',
      source,
    );
    let id = generation;
    if (id === undefined) {
      if (pointer?.lease_run) {
        const active = this.get<{ id: string; status: string }>(
          `SELECT id,status FROM run_generations WHERE source=? AND id=? AND status IN ('staging','ready','finalizing')`,
          source,
          pointer.lease_run,
        );
        if (active) id = active.id;
      }
      if (id === undefined) id = pointer?.generation ?? undefined;
    }
    if (id === undefined)
      return {
        source,
        generation: '',
        status: 'missing',
        live: false,
        coverage: this.capability === 'unsupported' ? 'unsupported' : 'unavailable',
      };
    const row = this.get<{
      status: string;
      diagnostics_recorded?: number | null;
      diagnostic_records?: number | null;
      diagnostic_entries?: number | null;
    }>('SELECT * FROM run_generations WHERE source=? AND id=?', source, id);
    if (!row)
      return {
        source,
        generation: id,
        status: 'missing',
        live: false,
        coverage: this.capability === 'unsupported' ? 'unsupported' : 'unavailable',
      };
    if (this.capability === 'unsupported')
      return { source, generation: id, status: row.status, live: LIVE_STATUS.has(row.status), coverage: 'unsupported' };
    if (row.status === 'retired' || row.status === 'retiring' || !row.diagnostics_recorded)
      return { source, generation: id, status: row.status, live: LIVE_STATUS.has(row.status), coverage: 'unavailable' };
    return {
      source,
      generation: id,
      status: row.status,
      live: LIVE_STATUS.has(row.status),
      coverage: 'recorded',
      diagnosticRecords: row.diagnostic_records ?? 0,
      diagnosticEntries: row.diagnostic_entries ?? 0,
    };
  }
  pageRecords(input: {
    source: string;
    generation: string;
    limit: number;
    after?: string;
    phase?: ConversionDiagnosticPhase;
  }): ConversionDiagnosticPage {
    admitSourceId(input.source);
    admitGenerationId(input.generation);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) fail('Invalid diagnostic page limit');
    if (input.after !== undefined) admitRecordKey(input.after);
    if (input.phase !== undefined && !isConversionDiagnosticPhase(input.phase)) fail();
    const generation = this.resolveGeneration(input.source, input.generation);
    if (generation.coverage !== 'recorded') return { generation, records: [], nextCursor: null };
    const limit = input.limit + 1;
    const rows =
      input.phase === undefined
        ? input.after === undefined
          ? this.all<{ record_key: string }>(
              `SELECT record_key FROM run_conversion_diagnostic_records
              WHERE source=? AND run_id=? ORDER BY record_key LIMIT ?`,
              input.source,
              input.generation,
              limit,
            )
          : this.all<{ record_key: string }>(
              `SELECT record_key FROM run_conversion_diagnostic_records
              WHERE source=? AND run_id=? AND record_key>? ORDER BY record_key LIMIT ?`,
              input.source,
              input.generation,
              input.after,
              limit,
            )
        : input.after === undefined
          ? this.all<{ record_key: string }>(
              `SELECT record_key FROM run_conversion_diagnostics
              WHERE source=? AND run_id=? AND phase=? AND diagnostic_count>0
              ORDER BY record_key LIMIT ?`,
              input.source,
              input.generation,
              input.phase,
              limit,
            )
          : this.all<{ record_key: string }>(
              `SELECT record_key FROM run_conversion_diagnostics
              WHERE source=? AND run_id=? AND phase=? AND diagnostic_count>0 AND record_key>?
              ORDER BY record_key LIMIT ?`,
              input.source,
              input.generation,
              input.phase,
              input.after,
              limit,
            );
    const overflow = rows.length === limit;
    const keys = overflow ? rows.slice(0, input.limit) : rows;
    const records: ConversionDiagnosticRecordView[] = [];
    for (const row of keys) {
      const detail = this.recordDetail({
        source: input.source,
        generation: input.generation,
        recordKey: row.record_key,
        ...(input.phase ? { phase: input.phase } : {}),
      });
      records.push(...detail);
    }
    return {
      generation,
      records,
      nextCursor: overflow
        ? encodeDiagnosticCursor({
            source: input.source,
            generation: input.generation,
            view: 'records',
            after: keys.at(-1)!.record_key,
            ...(input.phase ? { phase: input.phase } : {}),
          })
        : null,
    };
  }
  recordDetail(input: {
    source: string;
    generation: string;
    recordKey: string;
    phase?: ConversionDiagnosticPhase;
  }): ConversionDiagnosticRecordView[] {
    admitSourceId(input.source);
    admitGenerationId(input.generation);
    admitRecordKey(input.recordKey);
    if (input.phase !== undefined && !isConversionDiagnosticPhase(input.phase)) fail();
    if (this.capability === 'unsupported') return [];
    const rows =
      input.phase === undefined
        ? this.all<{
            phase: string;
            digest: string;
            converter_revision: string;
            record_revision: string;
            diagnostics_json: string;
          }>(
            `SELECT phase,digest,converter_revision,record_revision,diagnostics_json
            FROM run_conversion_diagnostics WHERE source=? AND run_id=? AND record_key=? ORDER BY phase`,
            input.source,
            input.generation,
            input.recordKey,
          )
        : this.all<{
            phase: string;
            digest: string;
            converter_revision: string;
            record_revision: string;
            diagnostics_json: string;
          }>(
            `SELECT phase,digest,converter_revision,record_revision,diagnostics_json
            FROM run_conversion_diagnostics WHERE source=? AND run_id=? AND record_key=? AND phase=?`,
            input.source,
            input.generation,
            input.recordKey,
            input.phase,
          );
    const result: ConversionDiagnosticRecordView[] = [];
    for (const row of rows) {
      if (!isConversionDiagnosticPhase(row.phase)) fail('Retained diagnostic phase is invalid');
      admitDigest(row.digest);
      admitRevision(row.converter_revision, 128);
      admitRevision(row.record_revision, 256);
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.diagnostics_json);
      } catch {
        fail('Retained diagnostic vector is invalid');
      }
      result.push({
        recordKey: input.recordKey,
        phase: row.phase,
        digest: row.digest,
        converterRevision: row.converter_revision,
        recordRevision: row.record_revision,
        diagnostics: sanitizeConversionDiagnostics(parsed),
      });
    }
    return result;
  }
}
