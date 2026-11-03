import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, rm, stat, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SourceId, SourceRecord } from '@rezics/conversion';
import type { BatchCommand } from '@rezics/definitions/bulk';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import { admitDumpCompression, decodeDumpBytes, type DumpCompression } from './compressed-dump.ts';
import { readDump } from './dumps.ts';
import { observeDumpRetention } from './dumps-bytes.ts';
import {
  DumpInputError,
  fileChunks,
  observedEntries,
  openDump,
  openLibraryMetadata,
  ownedChunks,
  throwIfAborted,
  type DumpInputObserver,
  type RawVndbEntry,
} from './dump-input.ts';
import { readArchive } from './archive.ts';
import { createSourceRegistration } from './source-registry.ts';
import { iterateVndbRecords, VndbInputError } from './vndb-materialization.ts';
import { DEFAULT_VNDB_ARCHIVE_BYTES, VndbTablesStore } from './vndb-tables.ts';
import { DEFAULT_DUMP_CHUNK_BYTES } from './dumps-bytes.ts';
import type { ImportConversion } from './import-contract.ts';
import type { RecordRow } from './record-store.ts';
import {
  DEFAULT_DISAPPEARANCE_THRESHOLD,
  DumpPreviewStore,
  PreviewStoreFailure,
  type PreviewKind,
  type PreviewPlan,
  type PreviewRecordRow,
} from './dump-preview-store.ts';

export class DumpPreviewFailure extends PreviewStoreFailure {}

export type DumpPreviewOptions = Readonly<{
  source: SourceId;
  dump: string;
  sourceAlias?: string;
  baseline?: string;
  outputDir?: string;
  stdin?: AsyncIterable<Uint8Array>;
  entries?: AsyncIterable<RawVndbEntry>;
  signal?: AbortSignal;
  observer?: DumpInputObserver;
  maxStoreBytes?: number;
  compression?: DumpCompression;
  decodeBudget?: number;
  zstdExecutable?: string;
}>;

export type CapturedBaseline = Readonly<{
  generation: string;
  presentCount: number;
}>;

const PROSE_KEYS = new Set(['summary', 'description', 'infobox', 'alias', 'text', 'body']);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sameFile(
  left: Awaited<ReturnType<FileHandle['stat']>>,
  right: Awaited<ReturnType<FileHandle['stat']>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function boundedJson(value: unknown): string {
  return JSON.stringify(value);
}

function displayString(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu, (character) => {
    const code = character.codePointAt(0)!.toString(16).padStart(4, '0');
    return `\\u${code}`;
  });
}

function displayValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length > 200 || PROSE_KEYS.has(value))
      return { kind: 'document', bytes: Buffer.byteLength(value, 'utf8'), digest: sha256(value) };
    return displayString(value);
  }
  if (Array.isArray(value)) return value.slice(0, 32).map(displayValue);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'sourceUrl' || key === 'url' || /password|secret|token|credential/i.test(key)) continue;
      result[key] =
        PROSE_KEYS.has(key) && typeof item === 'string'
          ? { kind: 'document', bytes: Buffer.byteLength(item, 'utf8'), digest: sha256(item) }
          : displayValue(item);
    }
    return result;
  }
  return value;
}

function operationList(conversion: ImportConversion): unknown[] {
  return conversion.proposals.map((command) => {
    const item = command as BatchCommand;
    const source = item.source;
    const row: Record<string, unknown> = {
      operation: item.op,
      fieldGroup: source.field_group,
      recordRevision: source.record_revision,
      converterRevision: source.converter_revision,
      digest: source.digest,
    };
    if (item.op === 'create') {
      row.subjectType = item.subject.type;
      row.labels = displayValue(item.subject.labels);
    } else if (item.op === 'propose') {
      row.subject = { kind: 'unresolved-or-bound-target', present: typeof item.subject === 'string' };
      row.property = item.statement.property;
      row.value = displayValue(item.statement.value);
      if (item.statement.qualifiers) row.qualifiers = displayValue(item.statement.qualifiers);
      row.references = displayValue(item.statement.references);
      if (!('subject' in item) || typeof item.subject !== 'string') row.unresolvedTarget = true;
    } else {
      row.meaning = 'retract';
    }
    return row;
  });
}

function mediaDescriptors(conversion: ImportConversion): unknown[] {
  const intents =
    'mediaImportIntents' in conversion ? (conversion.mediaImportIntents as readonly MediaImportRequest[]) : [];
  return intents.map((intent) => ({
    kind: 'media-intent',
    role: 'cover',
    rightsHolder: intent.credit.rightsHolder,
    license: intent.credit.license,
    via: intent.credit.via.name,
  }));
}

function displayProjection(conversion: ImportConversion, sourceKind: SourceId): string {
  const normalized = displayValue(conversion.normalized);
  const statistic =
    conversion.sourceStatistic === undefined
      ? conversion.sourceStatisticClear === undefined
        ? undefined
        : { kind: 'source-statistic-clear', source: conversion.sourceStatisticClear.source }
      : {
          kind: 'source-statistic',
          source: conversion.sourceStatistic.source,
          count: conversion.sourceStatistic.count,
          mean: conversion.sourceStatistic.mean,
          asOf: conversion.sourceStatistic.asOf,
          note: 'Source statistic only; not a local vote or publication.',
        };
  return boundedJson({
    sourceKind,
    normalized,
    ignored: 'outcome' in conversion && conversion.outcome === 'ignored',
    mediaIntents: mediaDescriptors(conversion),
    ...(statistic ? { sourceStatistic: statistic } : {}),
  });
}

function provenance(conversion: ImportConversion, source: string, sourceKind: SourceId): string {
  return boundedJson({
    source,
    sourceKind,
    externalId: conversion.external_id,
    recordRevision: conversion.record_revision ?? 'unversioned',
    converterRevision: conversion.converter_revision,
    digest: conversion.digest,
  });
}

function diagnosticsJson(conversion: ImportConversion): string {
  return boundedJson(
    conversion.diagnostics.map((item) => ({
      pointer: item.pointer,
      code: item.code,
      ...(item.sourceVocabularyGap
        ? { sourceVocabularyGap: { path: item.sourceVocabularyGap.path, reason: item.sourceVocabularyGap.reason } }
        : {}),
    })),
  );
}

async function openReadonlyState(
  statePath: string,
): Promise<{ path: string; descriptor: FileHandle; database: Database }> {
  const path = resolve(statePath);
  let descriptor: FileHandle | undefined;
  let database: Database | undefined;
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    descriptor = await open(path, flags);
    const identity = await descriptor.stat();
    if (!identity.isFile())
      throw new DumpPreviewFailure(`Baseline path is not a regular file: ${JSON.stringify(path)}.`, 2);
    database = new Database(path, { readonly: true, create: false, strict: true });
    const afterOpen = await stat(path);
    if (!sameFile(identity, afterOpen))
      throw new DumpPreviewFailure('Baseline path changed while it was being opened.', 2);
    const handle = { path, descriptor, database };
    descriptor = undefined;
    database = undefined;
    return handle;
  } catch (error) {
    database?.close();
    await descriptor?.close().catch(() => {});
    if (error instanceof DumpPreviewFailure) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') throw new DumpPreviewFailure(`Baseline file does not exist: ${JSON.stringify(path)}.`, 2);
    if (code === 'ELOOP')
      throw new DumpPreviewFailure(`Baseline path must not be a symbolic link: ${JSON.stringify(path)}.`, 2);
    if (
      error instanceof Error &&
      /not a database|unable to open database|database disk image is malformed/i.test(error.message)
    )
      throw new DumpPreviewFailure(
        `Baseline file is not a supported readable SQLite database: ${JSON.stringify(path)}.`,
        2,
      );
    if (error instanceof Error && /no such (?:table|column)/i.test(error.message))
      throw new DumpPreviewFailure('Unsupported importer state schema: a required journal field is unavailable.', 2);
    throw new DumpPreviewFailure(`Unable to open baseline file ${JSON.stringify(path)}${code ? ` (${code})` : ''}.`, 2);
  }
}

function validateBaselineSchema(database: Database): void {
  const required: Record<string, readonly string[]> = {
    run_sources: ['source', 'sequence', 'lease_run', 'generation', 'present_count'],
    run_members: ['source', 'record_key', 'active', 'seen', 'row_json'],
    run_acknowledged: ['source', 'record_key', 'row_json', 'projection_json'],
  };
  for (const [table, columns] of Object.entries(required)) {
    const found = database
      .query('SELECT 1 AS found FROM sqlite_schema WHERE type=? AND name=?')
      .get('table', table) as { found: number } | null;
    if (!found) throw new DumpPreviewFailure(`Unsupported importer state schema: table ${table} is missing.`);
    const actual = new Set(
      database
        .query(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => (row as { name: string }).name),
    );
    const missing = columns.find((column) => !actual.has(column));
    if (missing)
      throw new DumpPreviewFailure(`Unsupported importer state schema: column ${table}.${missing} is missing.`);
  }
}

function captureBaseline(database: Database, source: string, store: DumpPreviewStore): CapturedBaseline | null {
  validateBaselineSchema(database);
  database.exec('BEGIN');
  try {
    const sourceRow = database
      .query('SELECT generation, present_count AS presentCount FROM run_sources WHERE source=?')
      .get(source) as { generation: string | null; presentCount: number } | null;
    const generation = sourceRow?.generation ?? null;
    if (!generation) {
      database.exec('COMMIT');
      return null;
    }
    const presentCount = sourceRow?.presentCount ?? 0;
    const bindings = database
      .query("SELECT 1 AS found FROM sqlite_schema WHERE type='table' AND name='binding_records'")
      .get() as { found: number } | null;
    const memberSql = bindings
      ? `SELECT m.record_key AS recordKey, m.row_json AS rowJson, a.projection_json AS projectionJson,
                b.subject AS subject
         FROM run_members AS m
         LEFT JOIN run_acknowledged AS a ON a.source=m.source AND a.record_key=m.record_key
         LEFT JOIN binding_records AS b ON b.source=m.source AND b.external_id=m.record_key AND b.state='bound'`
      : `SELECT m.record_key AS recordKey, m.row_json AS rowJson, a.projection_json AS projectionJson,
                NULL AS subject
         FROM run_members AS m
         LEFT JOIN run_acknowledged AS a ON a.source=m.source AND a.record_key=m.record_key`;
    type BaselineCopyRow = {
      recordKey: string;
      rowJson: string;
      projectionJson: string | null;
      subject: string | null;
    };
    let after: string | null = null;
    for (;;) {
      const sql =
        after === null
          ? `${memberSql} WHERE m.source=? AND m.active=1 ORDER BY m.record_key LIMIT 101`
          : `${memberSql} WHERE m.source=? AND m.active=1 AND m.record_key>? ORDER BY m.record_key LIMIT 101`;
      const statement: ReturnType<Database['query']> = database.query(sql);
      const rows = (after === null ? statement.all(source) : statement.all(source, after)) as BaselineCopyRow[];
      const page: BaselineCopyRow[] = rows.slice(0, 100);
      for (const item of page) {
        const row = JSON.parse(item.rowJson) as RecordRow;
        if (row.source !== source || row.recordKey !== item.recordKey || row.state !== 'present')
          throw new DumpPreviewFailure('Malformed journal row: baseline membership is unsupported.');
        const projection = item.projectionJson
          ? JSON.parse(item.projectionJson)
          : { sourceKind: null, normalizedRecord: null };
        store.captureBaselineMember(
          row,
          boundedJson([projection.sourceKind ?? null, projection.normalizedRecord ?? null]),
          item.subject,
        );
      }
      if (rows.length <= 100) break;
      after = page.at(-1)!.recordKey;
    }
    const copied = store.records.count(source);
    if (copied !== presentCount)
      throw new DumpPreviewFailure('Baseline membership is inconsistent with the captured generation count.');
    database.exec('COMMIT');
    return { generation, presentCount };
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original bounded read failure.
    }
    if (error instanceof DumpPreviewFailure || error instanceof PreviewStoreFailure) throw error;
    if (error instanceof Error && /no such (?:table|column)/i.test(error.message))
      throw new DumpPreviewFailure('Unsupported importer state schema: a required journal field is unavailable.');
    throw new DumpPreviewFailure('Unable to capture a consistent completed baseline.');
  }
}

async function vndbRecords(
  store: DumpPreviewStore,
  source: string,
  input: AsyncIterable<Uint8Array> | AsyncIterable<RawVndbEntry>,
  options: { entries?: boolean; signal: AbortSignal; observer?: DumpInputObserver },
): Promise<AsyncGenerator<SourceRecord>> {
  const tables = new VndbTablesStore(store.database);
  const run = randomUUID();
  tables.begin(source, run);
  try {
    if (options.entries) {
      await tables.stage(
        source,
        run,
        observedEntries(input as AsyncIterable<RawVndbEntry>, options.signal, options.observer),
      );
    } else {
      await tables.stage(
        source,
        run,
        readArchive(input as AsyncIterable<Uint8Array>, {
          maxTotalBytes: DEFAULT_VNDB_ARCHIVE_BYTES,
          maxChunkBytes: DEFAULT_DUMP_CHUNK_BYTES,
          maxMetadataBytes: 4096,
          signal: options.signal,
          onProgress: () => {},
        }),
      );
    }
  } catch (error) {
    if (error instanceof DumpInputError) throw error;
    throw new VndbInputError();
  }
  if (tables.inspect(source, run).state !== 'ready') throw new VndbInputError();
  return iterateVndbRecords(tables, source, run, { signal: options.signal });
}

function classify(
  store: DumpPreviewStore,
  source: string,
  conversion: ImportConversion,
  sourceKind: SourceId,
): Exclude<PreviewKind, 'vanished'> {
  const baseline = store.baselineMember(source, conversion.external_id);
  if (!baseline) return 'new';
  const comparison = boundedJson([sourceKind, conversion.normalized]);
  const revision = conversion.record_revision ?? 'unversioned';
  if (
    baseline.row.recordRevision === revision &&
    baseline.row.digest === conversion.digest &&
    baseline.row.converter_revision === conversion.converter_revision &&
    baseline.comparisonJson === comparison
  )
    return 'unchanged';
  return 'changed';
}

export class DumpPreview {
  private constructor(
    readonly directory: string,
    readonly retainDirectory: boolean,
    readonly store: DumpPreviewStore,
    readonly plan: PreviewPlan,
  ) {}

  static async open(directory: string): Promise<DumpPreview> {
    const store = new DumpPreviewStore(join(directory, 'preview.sqlite'));
    try {
      const plan = store.loadPlan();
      if (!plan) throw new DumpPreviewFailure('Preview directory does not contain a plan.', 2);
      return new DumpPreview(directory, true, store, plan);
    } catch (error) {
      store.close();
      throw error;
    }
  }

  static async build(options: DumpPreviewOptions): Promise<DumpPreview> {
    const signal = options.signal ?? new AbortController().signal;
    if (signal.aborted) throw new DumpPreviewFailure('Preview was cancelled.', 130);
    const compression = options.compression ?? 'none';
    admitDumpCompression(options.source, compression);
    if (compression === 'zstd' && options.dump === '-')
      throw new DumpPreviewFailure('zstd compression requires one regular local dump file, not stdin.', 2);
    const retain = Boolean(options.outputDir);
    const ownedDir = options.outputDir
      ? await createOutputDir(options.outputDir)
      : await mkdtemp(join(tmpdir(), 'rezics-dump-preview-'));
    const store = new DumpPreviewStore(join(ownedDir, 'preview.sqlite'), {
      ...(options.maxStoreBytes === undefined ? {} : { maxStoreBytes: options.maxStoreBytes }),
    });
    const handles = { value: 0 };
    let dumpHandle: FileHandle | undefined;
    let baselineHandle: { descriptor: FileHandle; database: Database } | undefined;
    const previewId = randomUUID();
    const source = options.sourceAlias ?? options.source;
    const registration = createSourceRegistration(options.source, { source });
    try {
      throwIfAborted(signal, 'Preview interrupted');
      let viewKind: 'first-import' | 'baseline-comparison' = 'first-import';
      let baselineId: string | null = null;
      let baselinePresent = 0;
      if (options.baseline) {
        const opened = await openReadonlyState(options.baseline);
        baselineHandle = opened;
        try {
          const captured = captureBaseline(opened.database, source, store);
          if (captured) {
            viewKind = 'baseline-comparison';
            baselineId = captured.generation;
            baselinePresent = captured.presentCount;
          }
        } finally {
          opened.database.close();
          await opened.descriptor.close();
          baselineHandle = undefined;
        }
      }
      store.beginPlan({
        previewId,
        source,
        sourceKind: options.source,
        converterRevision: registration.converter_revision,
        dumpPath: options.dump,
        viewKind,
        baselineId,
        baselinePresent,
      });
      dumpHandle = await openDump(options.dump, handles);
      const dumpBytes = decodeDumpBytes(
        ownedChunks(
          dumpHandle ? fileChunks(dumpHandle, signal) : (options.stdin ?? (async function* () {})()),
          signal,
          'dump',
          options.observer,
          dumpHandle !== undefined,
        ),
        {
          compression,
          signal,
          ...(options.decodeBudget === undefined ? {} : { decodeBudget: options.decodeBudget }),
          ...(options.zstdExecutable === undefined
            ? {}
            : { zstdExecutable: options.zstdExecutable, zstdProbe: false }),
        },
      );
      const restoreRetention = observeDumpRetention(() => {});
      try {
        let records: AsyncIterable<SourceRecord>;
        if (options.source === 'vndb') {
          records = await vndbRecords(store, source, options.entries ?? dumpBytes, {
            entries: options.entries !== undefined,
            signal,
            ...(options.observer === undefined ? {} : { observer: options.observer }),
          });
        } else {
          const native = options.source === 'openlibrary' ? openLibraryMetadata(dumpBytes, signal) : dumpBytes;
          records = readDump(options.source, native);
        }
        for await (const record of records) {
          throwIfAborted(signal, 'Preview interrupted');
          if (record.source !== options.source) throw new DumpPreviewFailure('Source stream registration mismatch.');
          const conversion = registration.convert(
            { external_id: record.key, record_revision: record.revision ?? 'unversioned', record: record.payload },
            { source },
          );
          const skipped = 'outcome' in conversion && conversion.outcome === 'ignored';
          const kind = classify(store, source, conversion, options.source);
          if (kind !== 'new') store.markSurvivor(previewId);
          const staged: PreviewRecordRow = {
            recordKey: record.key,
            kind,
            recordRevision: conversion.record_revision ?? 'unversioned',
            digest: conversion.digest,
            converterRevision: conversion.converter_revision,
            skipped,
            comparisonJson: boundedJson([options.source, conversion.normalized]),
            displayJson: displayProjection(conversion, options.source),
            diagnosticsJson: diagnosticsJson(conversion),
            operationsJson: boundedJson(operationList(conversion)),
            provenanceJson: provenance(conversion, source, options.source),
          };
          if (store.insertRecord(previewId, source, staged) === 'duplicate')
            throw new DumpPreviewFailure('Duplicate staged key invalidates input.', 2);
        }
      } finally {
        restoreRetention();
      }
      const live = store.plan(previewId);
      const missing = live.prior - live.survivors;
      const disappearanceWouldBlock =
        live.prior > 0 && (missing === live.prior || missing / live.prior > DEFAULT_DISAPPEARANCE_THRESHOLD);
      if (viewKind === 'baseline-comparison') {
        let after: string | null = null;
        for (;;) {
          const page = store.pageBaseline(source, after, 100);
          for (const row of page) {
            if (!store.hasRecord(previewId, source, row.recordKey))
              store.insertVanished(previewId, source, {
                recordKey: row.recordKey,
                recordRevision: row.recordRevision,
                digest: row.digest,
                converterRevision: row.converter_revision,
                subjectBinding: store.baselineMember(source, row.recordKey)?.subjectBinding ?? null,
              });
          }
          if (page.length < 100) break;
          after = page.at(-1)!.recordKey;
        }
      }
      const plan = store.seal(previewId, { complete: true, disappearanceWouldBlock });
      return new DumpPreview(ownedDir, retain, store, plan);
    } catch (error) {
      const interrupted = signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      try {
        if (store.loadPlan())
          store.seal(previewId, {
            complete: false,
            errorIdentity: interrupted
              ? 'cancelled'
              : error instanceof DumpInputError
                ? error.identity
                : error instanceof VndbInputError
                  ? 'invalid-input'
                  : 'invalid-input',
            errorMessage: interrupted
              ? 'Preview was cancelled.'
              : error instanceof DumpPreviewFailure || error instanceof PreviewStoreFailure
                ? error.message
                : error instanceof DumpInputError
                  ? error.message
                  : 'Input is incomplete or invalid.',
          });
      } catch {
        // The incomplete plan identity is best-effort once acquisition has failed.
      }
      if (dumpHandle) {
        try {
          await dumpHandle.close();
        } catch {
          // Bounded input already stopped.
        }
        dumpHandle = undefined;
        handles.value--;
      }
      if (baselineHandle) {
        try {
          baselineHandle.database.close();
        } catch {
          // Baseline is read-only.
        }
        await baselineHandle.descriptor.close().catch(() => {});
      }
      const plan = store.loadPlan();
      if (plan && !interrupted) return new DumpPreview(ownedDir, retain, store, plan);
      store.close();
      if (!retain) await rm(ownedDir, { recursive: true, force: true });
      if (interrupted) throw new DumpPreviewFailure('Preview was cancelled.', 130);
      if (error instanceof DumpPreviewFailure || error instanceof PreviewStoreFailure) throw error;
      throw new DumpPreviewFailure(
        error instanceof Error ? error.message : 'Input is incomplete or invalid.',
        error instanceof DumpInputError || error instanceof VndbInputError ? 2 : 1,
      );
    } finally {
      if (dumpHandle) {
        try {
          await dumpHandle.close();
        } catch {
          // The file is already bounded.
        }
        handles.value--;
      }
    }
  }

  page(kind: PreviewKind, options: { limit?: number; cursor?: string } = {}) {
    if (kind === 'vanished') return this.store.pageVanished(this.plan.previewId, this.plan.source, options);
    return this.store.pageRecords(this.plan.previewId, this.plan.source, kind, options);
  }

  record(recordKey: string) {
    return this.store.recordDetail(this.plan.previewId, this.plan.source, recordKey);
  }

  async close(): Promise<void> {
    this.store.close();
    if (!this.retainDirectory) await rm(this.directory, { recursive: true, force: true });
  }
}

async function createOutputDir(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    const opened = await open(resolved, constants.O_NOFOLLOW ?? 0);
    try {
      const identity = await opened.stat();
      if (!identity.isDirectory()) throw new DumpPreviewFailure('Preview output path is not a directory.', 2);
    } finally {
      await opened.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await mkdir(resolved, { recursive: false, mode: 0o700 });
      return resolved;
    }
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new DumpPreviewFailure('Preview output path must not be a symbolic link.', 2);
    if (error instanceof DumpPreviewFailure) throw error;
    throw new DumpPreviewFailure('Preview output directory could not be created.', 2);
  }
  const sqlite = join(resolved, 'preview.sqlite');
  try {
    await stat(sqlite);
    throw new DumpPreviewFailure('Preview output directory already contains a database; refusing to overwrite it.', 2);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolved;
    throw error instanceof DumpPreviewFailure
      ? error
      : new DumpPreviewFailure('Preview output directory already contains a database; refusing to overwrite it.', 2);
  }
}
