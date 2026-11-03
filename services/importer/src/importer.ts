import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { SourceRecord } from '@rezics/conversion';
import {
  FIELD_GROUPS,
  type BatchCommand,
  type BatchWriteRequest,
  type BatchWriteResult,
} from '@rezics/definitions/bulk';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import { checkBatch, checkResult } from './accepted-checks.ts';
import type {
  ImportConversion,
  ImportTransport,
  ImportSourceRecord,
  ImportSourceRecordMetadataCommand,
  ImportProgressObserver,
  ImportProgressKind,
  RunResultSink,
  RunStatus,
  SourceRegistration,
} from './import-contract.ts';
import { ImportTransportError } from './import-client.ts';
import {
  DIGEST,
  ObservationConflictError,
  ObservationRefusedError,
  aggregateOperationId,
  classifyObservation,
  effectiveAlias,
  headFromClear,
  headFromStatistic,
  intendedPayload,
  observationDigest,
  parseObservationReason,
  type IntendedObservation,
  type ObservationHeadRead,
  type ObservationReason,
  type RetainedObservationHead,
} from './source-observation.ts';
import { readDump } from './dumps.ts';
import { ImportSession } from './import-session.ts';
import type { Candidate, Owner } from './record-bindings.ts';
import type { DeferredCover, Omission, Pending, Run, SourceProjection, Staged } from './run-store.ts';
import { createSourceRegistration } from './source-registry.ts';
import { resolveOwnReferences } from './own-references.ts';
import { ConversionDiagnosticError, type ConversionDiagnosticPhase } from './conversion-diagnostics.ts';

export type ImportMediaResolution =
  | { status: 'available'; mediaIds: Readonly<Record<string, string>> }
  | { status: 'pending' | 'rejected' };
/** Actual public media availability, never a URL statement or locally allocated ID. */
export interface ImportMediaResolver {
  resolve(input: {
    owner: Owner;
    subject: string;
    mediaImportIntents: readonly MediaImportRequest[];
    signal: AbortSignal;
    deferPending?: boolean;
  }): Promise<ImportMediaResolution>;
}

export interface ImportIdentifierLookup {
  resolve(input: {
    owner: Owner;
    conversion: ImportConversion;
    signal: AbortSignal;
  }): Promise<Readonly<Record<string, string>>>;
}

type Kind = 'new' | 'changed' | 'unchanged' | 'vanished';
export type ImportRunResult = {
  status: RunStatus;
  skipped: number;
  counts: Record<Kind, number>;
  new: string[];
  changed: string[];
  unchanged: string[];
  vanished: string[];
  diagnostic: string;
};
export type ImportRunOptions = {
  disappearanceThreshold?: number;
  maxRecordBytes?: number;
  signal?: AbortSignal;
  /** Explicit fixture/diagnostic bound; production defaults to no collected keys. */
  collectionLimit?: number;
  sink?: RunResultSink;
  progress?: ImportProgressObserver;
};
export type ImporterOptions = {
  path: string | Database;
  transport: ImportTransport;
  recordConcurrency?: number;
  mediaDeadlineMs?: number;
  mediaResolver?: ImportMediaResolver;
  identifierLookup?: ImportIdentifierLookup;
  onConversionOutput?(output: ImportConversion): void;
  afterBulkSuccess?(request: BatchWriteRequest, result: BatchWriteResult): void | Promise<void>;
  instrumentDatabase?: (database: Database) => Database;
  now?(): number;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  observer?: {
    onRecordActive?(phase: 'staged' | 'vanished' | 'resumed' | 'media', recordKey: string, active: boolean): void;
    onPageRetained?(
      phase: 'staged' | 'vanished' | 'resumed' | 'media',
      records: readonly { recordKey: string; bytes: number }[],
    ): void;
    onAcknowledged?(recordKey: string): void;
  };
};

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const success = (result: BatchWriteResult['results'][number]) => result.status === 200 || result.status === 201;
class Interrupted extends Error {}
type Phase = 'staged' | 'vanished' | 'resumed' | 'media';
type Write = <T>(operation: () => Promise<T>) => Promise<T>;
// Platform policy per logical write and run, independent of width recovery.
const MAX_WRITE_INVOCATIONS = 8;
type Planned = {
  kind: Kind;
  deferredCover: boolean;
  conversion?: ImportConversion;
  observationConflict?: boolean;
};

// Native source keys are not normalized into different record identities. Compound
// planner identities are hashed so their printable public keys remain bounded.
function operationKey(owner: Owner, identity: string): string {
  const prefix = `${owner.source}:${owner.external_id}:`;
  const suffix = hash(identity);
  if (!/^[\x20-\x7e]+$/.test(prefix) || Buffer.byteLength(prefix + suffix) > 255)
    throw new TypeError('Source key cannot form a bounded public operation key');
  return prefix + suffix;
}

/** Ordinary API reconciliation; only the injected transport can perform catalogue effects. */
export class Importer {
  readonly session: ImportSession;
  private readonly running = new Set<Promise<ImportRunResult>>();
  private readonly shutdown = new AbortController();
  private readonly runControllers = new WeakMap<AbortSignal, AbortController>();
  private readonly progressObservers = new WeakMap<AbortSignal, ImportProgressObserver>();
  private readonly recordConcurrency: number;
  private readonly writeWidths = new WeakMap<AbortSignal, { width: number }>();
  private readonly mediaDeadlineMs: number;
  private closing = false;

  constructor(private readonly options: ImporterOptions) {
    const concurrency = options.recordConcurrency ?? 16;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64)
      throw new TypeError('recordConcurrency must be an integer from 1 through 64');
    const mediaDeadlineMs = options.mediaDeadlineMs ?? 600_000;
    if (!Number.isFinite(mediaDeadlineMs) || mediaDeadlineMs < 0)
      throw new TypeError('mediaDeadlineMs must be a non-negative finite number');
    this.recordConcurrency = concurrency;
    this.mediaDeadlineMs = mediaDeadlineMs;
    this.session = new ImportSession(
      options.path,
      options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {},
    );
  }

  async runDump(
    registration: SourceRegistration,
    bytes: AsyncIterable<Uint8Array>,
    options: ImportRunOptions = {},
  ): Promise<ImportRunResult> {
    const acquiring = options.progress?.onPhase?.('acquiring');
    if (acquiring !== undefined) await acquiring;
    return this.runRecords(
      registration,
      readDump(registration.sourceKind, bytes, {
        maxRecordBytes: options.maxRecordBytes,
      }),
      options,
    );
  }

  /** VNDB grouped loaders pass their actual SourceRecord stream here. */
  runRecords(
    registration: SourceRegistration,
    records: AsyncIterable<SourceRecord>,
    options: ImportRunOptions = {},
  ): Promise<ImportRunResult> {
    if (this.closing) return Promise.reject(new Error('Importer is closing'));
    const task = this.run(registration, records, options);
    this.running.add(task);
    void task.finally(() => this.running.delete(task)).catch(() => {});
    return task;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.shutdown.abort();
    await Promise.allSettled(this.running);
    this.session.close();
  }

  private convert(
    registration: SourceRegistration,
    staged: Staged<SourceProjection>,
    context: {
      subjectId?: string;
      mediaIds?: Readonly<Record<string, string>>;
      resolvedReferences?: Readonly<Record<string, string>>;
    } = {},
  ): ImportConversion {
    const result = registration.convert(
      {
        external_id: staged.row.recordKey,
        record_revision: staged.row.recordRevision,
        record: staged.projection.normalizedRecord,
      },
      { ...context, source: registration.source },
    );
    if (result.digest !== staged.row.digest || result.converter_revision !== staged.row.converter_revision)
      throw new Error('Persisted source conversion differs from its registered projection');
    return result;
  }

  private retainDiagnostics(
    run: Run,
    staged: Staged<SourceProjection>,
    conversion: ImportConversion,
    phase: ConversionDiagnosticPhase,
  ): void {
    this.session.store.retainConversionDiagnostics(run, {
      recordKey: staged.row.recordKey,
      digest: conversion.digest,
      converterRevision: conversion.converter_revision,
      recordRevision: conversion.record_revision ?? staged.row.recordRevision,
      phase,
      diagnostics: conversion.diagnostics,
    });
  }

  private async fences(owner: Owner, signal: AbortSignal): Promise<Omission[]> {
    if (signal.aborted) throw new Interrupted('Import was interrupted');
    const values = await Promise.all(
      FIELD_GROUPS.map(async (field_group): Promise<Omission | null> => {
        if (signal.aborted) throw new Interrupted('Import was interrupted');
        const value = await this.options.transport.readFence({ ...owner, field_group });
        if (signal.aborted) throw new Interrupted('Import was interrupted');
        if (!value || typeof value.fenced !== 'boolean') throw new Error('Invalid fence response');
        if (!value.fenced) {
          if (value.securityRevision !== null) throw new Error('Invalid open fence response');
          return null;
        }
        if (typeof value.securityRevision !== 'string' || !/^[1-9][0-9]*$/.test(value.securityRevision))
          throw new Error('Invalid restricted fence revision');
        return { field_group, disposition: 'fenced', securityRevision: value.securityRevision };
      }),
    );
    return values.filter((value): value is Omission => value !== null);
  }

  private validateResult(request: BatchWriteRequest, result: BatchWriteResult): void {
    if (checkResult(result).length || result.results.length !== request.commands.length)
      throw new Error('Invalid bulk response');
    const expected = new Map(request.commands.map((command) => [command.key, command]));
    const seen = new Set<string>();
    for (const entry of result.results) {
      const command = expected.get(entry.key);
      if (!command || seen.has(entry.key)) throw new Error('Bulk response key mismatch');
      seen.add(entry.key);
      if ('value' in entry) {
        const fields = Object.keys(entry.value).sort().join(',');
        if (
          fields !==
          (command.op === 'create' ? 'id,revision' : command.op === 'propose' ? 'candidate,revision' : 'revision')
        )
          throw new Error('Bulk response operation mismatch');
      }
    }
  }

  private async send(request: BatchWriteRequest, signal: AbortSignal, write: Write): Promise<BatchWriteResult> {
    if (signal.aborted) throw new Interrupted('Import was interrupted');
    const text = JSON.stringify(request);
    if (checkBatch(request).length || Buffer.byteLength(text) > 65536) throw new Error('Invalid public envelope');
    const response = await write(() => this.options.transport.batchWrite(request));
    if (signal.aborted) throw new Interrupted('Import was interrupted');
    this.validateResult(request, response);
    if (response.results.some(success)) {
      try {
        await this.options.afterBulkSuccess?.(request, response);
      } catch {
        this.runControllers.get(signal)?.abort();
        throw new Interrupted('Interrupted after remote success before local acknowledgement');
      }
    }
    if (signal.aborted) throw new Interrupted('Import was interrupted');
    return response;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0) return;
    if (this.options.sleep) return this.options.sleep(ms, signal);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, ms);
      const abort = () => done(new Interrupted('Import was interrupted'));
      function done(error?: Error) {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      }
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  private progress(signal: AbortSignal): ImportProgressObserver | undefined {
    return this.progressObservers.get(signal);
  }

  private retain(phase: Phase, rows: readonly { recordKey: string; value: unknown }[]): void {
    this.options.observer?.onPageRetained?.(
      phase,
      rows.map(({ recordKey, value }) => ({ recordKey, bytes: Buffer.byteLength(JSON.stringify(value)) })),
    );
  }

  private async concurrent<T, R>(
    phase: Phase,
    values: readonly T[],
    signal: AbortSignal,
    key: (value: T) => string,
    operation: (value: T, write: Write) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(values.length);
    const width = this.writeWidths.get(signal) ?? { width: this.recordConcurrency };
    this.writeWidths.set(signal, width);
    let next = 0;
    let active = 0;
    let running = 0;
    let stopped = false;
    let failure: unknown;
    // Paused records retain their stack at the failed write, including its exact
    // envelope. Earlier planning, bootstrap and media effects are not repeated.
    type Retry = { resume(): void; next: Retry | undefined };
    let retry: Retry | undefined;
    await new Promise<void>((done) => {
      const resume = () => {
        const entry = retry!;
        retry = entry.next;
        active++;
        entry.resume();
      };
      const aborted = () => {
        failure ??= new Interrupted('Import was interrupted');
        stopped = true;
        pump();
      };
      const pump = () => {
        if (stopped) {
          while (retry) resume();
        } else {
          while (active < width.width && (retry || next < values.length)) {
            if (retry) resume();
            else start(next++);
          }
        }
        if (!running && (stopped || next >= values.length)) {
          signal.removeEventListener('abort', aborted);
          done();
        }
      };
      const write: Write = async (effect) => {
        let invocations = 0;
        let prior: ImportTransportError | undefined;
        for (;;) {
          if (signal.aborted) throw new Interrupted('Import was interrupted');
          if (prior?.retry) {
            const { notBefore, deadline } = prior.retry;
            if (this.now() >= deadline) throw prior;
            if (notBefore !== undefined) {
              await this.sleep(notBefore - this.now(), signal);
              if (signal.aborted) throw new Interrupted('Import was interrupted');
              // Never send early even if an injected sleeper wakes prematurely.
              if (this.now() < notBefore || this.now() >= deadline) throw prior;
            }
          }
          const singleWriter = width.width === 1 && active === 1;
          invocations++;
          try {
            const result = await effect();
            width.width = Math.min(this.recordConcurrency, width.width + 1);
            pump();
            return result;
          } catch (error) {
            const overload =
              error instanceof ImportTransportError &&
              (error.status === 429 || (error.status === 503 && error.retryable));
            // An older wide cohort can finish after another record narrowed to
            // one. An isolated width-one failure can stop sooner than the cap.
            if (
              !overload ||
              singleWriter ||
              signal.aborted ||
              invocations >= MAX_WRITE_INVOCATIONS ||
              error.retry?.stopped
            )
              throw error;
            prior = error;
            width.width = Math.max(1, Math.floor(width.width / 2));
            active--;
            await new Promise<void>((resolve) => {
              retry = { resume: resolve, next: retry };
              pump();
            });
          }
        }
      };
      const start = (index: number) => {
        active++;
        running++;
        const value = values[index]!;
        const recordKey = key(value);
        this.options.observer?.onRecordActive?.(phase, recordKey, true);
        void operation(value, write)
          .then(
            (result) => {
              results[index] = result;
            },
            (error: unknown) => {
              failure ??= error;
              stopped = true;
              this.runControllers.get(signal)?.abort(error);
            },
          )
          .finally(() => {
            active--;
            running--;
            this.options.observer?.onRecordActive?.(phase, recordKey, false);
            pump();
          });
      };
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      else pump();
    });
    if (failure !== undefined) throw failure;
    return results;
  }

  /**
   * One durable commit for a group of writes: RunStore and RecordBindings operations inside it join
   * this transaction instead of committing (and syncing) each on its own.
   */
  private atomic<T>(operation: () => T): T {
    return this.session.store.database.transaction(operation).immediate();
  }

  private acknowledged(recordKey: string): void {
    this.options.observer?.onAcknowledged?.(recordKey);
  }

  private acknowledge(owner: Owner, request: BatchWriteRequest, result: BatchWriteResult): number {
    // The complete response is validated before the first local acknowledgement.
    this.validateResult(request, result);
    let acknowledgedEffects = 0;
    for (const entry of result.results) {
      if (success(entry)) {
        this.session.bindings.acknowledge(owner, entry.key, { results: [entry] });
        acknowledgedEffects++;
      } else if (entry.status === 404 && request.commands.find((c) => c.key === entry.key)?.op !== 'create')
        this.session.bindings.takenDown(owner, { status: 404 });
    }
    return acknowledgedEffects;
  }

  private current(owner: Owner): Candidate[] {
    const candidates: Candidate[] = [];
    for (const group of FIELD_GROUPS) {
      let after: string | undefined;
      for (;;) {
        const page = this.session.bindings.candidates(owner, group, { ...(after ? { after } : {}), limit: 100 });
        candidates.push(...page);
        if (candidates.length > 300) throw new Error('Owned candidate bound exceeded');
        if (page.length < 100) break;
        after = page.at(-1)!.candidate;
      }
    }
    return candidates;
  }

  private async metadata(
    owner: Owner,
    descriptor: ImportSourceRecord | undefined,
    signal: AbortSignal,
    write: Write,
  ): Promise<void> {
    const bindings = this.session.bindings;
    if (!descriptor) return;
    const signature = hash(JSON.stringify(descriptor));
    let journal = bindings.metadata(owner);
    if (journal?.result && journal.signature === signature) return;
    const port = this.options.transport.setSourceRecordMetadata;
    if (!port) throw new Error('Source record metadata transport is unavailable');
    const send = async (pending: NonNullable<typeof journal>) => {
      const result = await write(() =>
        port.call(
          this.options.transport,
          {
            command: JSON.parse(pending.bytes) as ImportSourceRecordMetadataCommand,
            idempotencyKey: pending.key,
          },
          signal,
        ),
      );
      if (signal.aborted) throw new Interrupted('Import was interrupted');
      bindings.acknowledgeMetadata(owner, pending.key, result);
      if (result.effect !== 'noEffect') this.progress(signal)?.onAcknowledgedEffects?.(1);
    };
    // Never consume a new descriptor in place of a response-lost immutable intent.
    if (journal && !journal.result) {
      await send(journal);
      journal = bindings.metadata(owner);
      if (journal?.signature === signature) return;
    }
    const revision = journal?.result?.metadata_revision ?? null;
    const pending = bindings.prepareMetadata(
      owner,
      operationKey(owner, `metadata:${signature}:${revision}`),
      signature,
      {
        ...owner,
        metadata: descriptor,
        expected_metadata_revision: revision,
      },
    );
    await send(pending);
  }

  private async bootstrap(
    registration: SourceRegistration,
    staged: Staged<SourceProjection>,
    conversion: ImportConversion,
    signal: AbortSignal,
    write: Write,
  ): Promise<string | null> {
    const owner = { source: staged.row.source, external_id: staged.row.recordKey };
    const bindings = this.session.bindings;
    const claim = bindings.claim(owner);
    if (claim?.state === 'bound') return claim.subject;
    if (claim?.state === 'taken-down') throw new Error('Source claim is terminal');
    const key = operationKey(owner, 'bootstrap');
    let journal = bindings.journal(owner, key);
    if (!journal) {
      const creates = conversion.proposals.filter((command) => command.op === 'create');
      if (creates.length !== 1) return null;
      const create = creates[0]!;
      if (create.op !== 'create' || Object.hasOwn(create.subject, 'statements'))
        throw new Error('Bootstrap must be a minimal create');
      journal = bindings.prepare(owner, hash(`bootstrap:${registration.sourceKind}`), {
        commands: [{ ...create, key }],
      });
    }
    const request = JSON.parse(journal.bytes) as BatchWriteRequest;
    const result = await this.send(request, signal, write);
    const acknowledgedEffects = this.acknowledge(owner, request, result);
    this.progress(signal)?.onAcknowledgedEffects?.(acknowledgedEffects);
    const bound = bindings.claim(owner);
    return bound?.state === 'bound' ? bound.subject : null;
  }

  private async dispatch(run: Run, pending: Pending, signal: AbortSignal, write: Write): Promise<boolean> {
    const owner = { source: run.source, external_id: pending.recordKey };
    const omissions = await this.fences(owner, signal);
    // An empty commands argument augments only omission proof, retaining the
    // original immutable journal and each of its public operation bodies.
    const { omissions: proved } = this.session.store.prepareWithOmissions(run, pending.recordKey, {
      commands: [],
      omissions,
    });
    const original = JSON.parse(pending.bytes) as BatchWriteRequest;
    const commands = original.commands.filter(
      (command) => !proved.some((o) => o.field_group === command.source.field_group),
    );
    if (!commands.length) return true;
    const request = { commands };
    this.atomic(() => {
      for (const command of commands)
        this.session.bindings.prepare(owner, hash(`${run.id}:${command.key}`), { commands: [command] });
    });
    const result = await this.send(request, signal, write);
    // Returned identities must be durable before RunStore can resolve a record.
    const acknowledgedEffects = this.atomic(() => {
      const count = this.acknowledge(owner, request, result);
      this.session.store.acknowledge(run, result, { recordKey: pending.recordKey });
      return count;
    });
    this.progress(signal)?.onAcknowledgedEffects?.(acknowledgedEffects);
    if (this.session.store.key(run.source, pending.recordKey, run).acknowledged) this.acknowledged(pending.recordKey);
    return result.results.every(success);
  }

  private async drain(run: Run, signal: AbortSignal, phase: Phase): Promise<boolean> {
    let after: string | undefined;
    let complete = true;
    for (;;) {
      const page = this.session.store.pagePending(run, { ...(after ? { after } : {}), limit: 100 });
      this.retain(
        phase,
        page.map((pending) => ({ recordKey: pending.recordKey, value: pending })),
      );
      const outcomes = await this.concurrent(
        phase,
        page,
        signal,
        (pending) => pending.recordKey,
        async (pending, write) => {
          try {
            return await this.dispatch(run, pending, signal, write);
          } catch (error) {
            if (error instanceof Interrupted) throw error;
            return false;
          }
        },
      );
      if (outcomes.some((outcome) => !outcome)) complete = false;
      if (page.length) after = page.at(-1)!.after;
      this.options.observer?.onPageRetained?.(phase, []);
      if (page.length < 100) return complete;
    }
  }

  private async readObservationHead(
    owner: Owner,
    subjectId: string,
    signal: AbortSignal,
    write: Write,
  ): Promise<ObservationHeadRead> {
    const read = this.options.transport.readSourceStatistics;
    const retained = this.session.store.retainedAggregateHead(owner.source, subjectId);
    if (!read) return retained ? { kind: 'head', head: retained } : { kind: 'absent' };
    try {
      const rows = await write(() => read.call(this.options.transport, { subjectId }, signal));
      const row = rows.find((item) => item.source === 'vndb');
      if (row && typeof row.sourceRecordId === 'string' && typeof row.asOf === 'string')
        return { kind: 'head', head: headFromStatistic(subjectId, row) };
      return retained?.cleared ? { kind: 'head', head: retained } : { kind: 'absent' };
    } catch (error) {
      if (
        error instanceof ImportTransportError &&
        (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 503)
      )
        return {
          kind: 'unavailable',
          ...(error.status === undefined ? {} : { status: error.status }),
          ...(error.code === undefined ? {} : { code: error.code }),
        };
      throw error;
    }
  }

  private async confirmObservation(
    subjectId: string,
    intended: IntendedObservation,
    signal: AbortSignal,
    write: Write,
  ): Promise<{ head: RetainedObservationHead | null; figure: unknown; figureUnavailable: boolean }> {
    const read = this.options.transport.readSourceStatistics;
    let head: RetainedObservationHead | null = null;
    if (read) {
      try {
        const rows = await write(() => read.call(this.options.transport, { subjectId }, signal));
        const row = rows.find((item) => item.source === 'vndb');
        if (row) head = headFromStatistic(subjectId, row);
      } catch {
        return { head: null, figure: null, figureUnavailable: true };
      }
    }
    if (intended.kind === 'clear' && !head) head = headFromClear(subjectId, intended);
    let figure: unknown = null;
    let figureUnavailable = false;
    const readFigure = this.options.transport.readPublicFigure;
    if (readFigure) {
      try {
        figure = await write(() => readFigure.call(this.options.transport, { subjectId }, signal));
      } catch {
        figureUnavailable = true;
      }
    }
    return { head, figure, figureUnavailable };
  }

  private async deliverObservation(
    owner: Owner,
    subjectId: string,
    intended: IntendedObservation,
    commandKey: string,
    requestBytes: string,
    signal: AbortSignal,
    write: Write,
  ): Promise<'delivered' | 'conflict'> {
    const body = JSON.parse(requestBytes) as Record<string, unknown>;
    try {
      if (intended.kind === 'write') {
        const put = this.options.transport.writeSourceStatistic;
        if (!put) throw new Error('Source statistic transport is unavailable');
        await write(() =>
          put.call(
            this.options.transport,
            { subjectId, source: 'vndb', value: body as never, idempotencyKey: commandKey },
            signal,
          ),
        );
      } else {
        const clear = this.options.transport.clearSourceStatistic;
        if (!clear) throw new Error('Source statistic clear transport is unavailable');
        await write(() =>
          clear.call(
            this.options.transport,
            { subjectId, source: 'vndb', value: body as never, idempotencyKey: commandKey },
            signal,
          ),
        );
      }
      return 'delivered';
    } catch (error) {
      if (error instanceof ImportTransportError && error.status === 409) return 'conflict';
      throw error;
    }
  }

  private async applyObservation(
    run: Run,
    owner: Owner,
    subjectId: string,
    intended: IntendedObservation,
    signal: AbortSignal,
    write: Write,
  ): Promise<boolean> {
    const store = this.session.store;
    const operationId = aggregateOperationId({ runId: run.id, recordKey: owner.external_id, subjectId, intended });
    const existing = store.aggregateOperation(run, operationId) ?? store.unresolvedAggregate(run, owner.external_id);
    const commandKey = operationKey(
      owner,
      `${run.id}:source-statistic${intended.kind === 'clear' ? '-clear' : ''}:${hash(JSON.stringify(intendedPayload(intended)))}`,
    );
    const requestBytes = JSON.stringify(intendedPayload(intended));
    if (existing?.status === 'delivered' && existing.operationId === operationId) return true;
    if (existing?.status === 'uncertain' || existing?.status === 'prepared') {
      const sealed = existing.requestBytes;
      const key = existing.commandKey;
      store.markAggregate(run, existing.operationId, { status: 'uncertain' });
      const result = await this.deliverObservation(owner, subjectId, intended, key, sealed, signal, write);
      if (result === 'conflict') {
        store.markAggregate(run, existing.operationId, {
          status: 'conflict',
          nativeReason: 'cas-mismatch',
        });
        throw new ObservationConflictError(existing.operationId, 'cas-mismatch');
      }
      const confirmed = await this.confirmObservation(subjectId, intended, signal, write);
      const head =
        intended.kind === 'clear'
          ? headFromClear(subjectId, intended)
          : (confirmed.head ??
            headFromStatistic(subjectId, {
              source: 'vndb',
              ...intended,
              licence: 'ODbL-1.0',
              attribution: 'VNDB',
            } as never));
      store.retainAggregateHead(owner.source, { ...head, subjectId });
      store.markAggregate(run, existing.operationId, {
        status: 'delivered',
        reviewedHead: head,
        outcome: { figure: confirmed.figure, figureUnavailable: confirmed.figureUnavailable },
      });
      this.progress(signal)?.onAcknowledgedEffects?.(1);
      return true;
    }
    if (existing?.status === 'conflict' || existing?.status === 'refused') {
      const reason =
        parseObservationReason(existing.nativeReason) ??
        (existing.status === 'refused' ? 'older-date' : 'cas-mismatch');
      if (existing.status === 'refused') throw new ObservationRefusedError(existing.operationId, reason);
      throw new ObservationConflictError(existing.operationId, reason);
    }
    const head = await this.readObservationHead(owner, subjectId, signal, write);
    if (head.kind === 'unavailable') throw new ImportTransportError(head.status, undefined, head.code);
    const decision = classifyObservation(intended, subjectId, head);
    if (decision.action === 'identical') return true;
    const reviewed = head.kind === 'head' ? head.head : null;
    if (decision.action === 'refused' || decision.action === 'conflict') {
      store.prepareAggregate(run, {
        operationId,
        recordKey: owner.external_id,
        subjectId,
        sourceAlias: effectiveAlias(intended.sourceAlias),
        intended,
        commandKey,
        requestBytes,
        reviewedHead: reviewed,
        status: decision.action === 'refused' ? 'refused' : 'conflict',
        nativeReason: decision.reason,
      });
      if (decision.action === 'refused') throw new ObservationRefusedError(operationId, decision.reason);
      throw new ObservationConflictError(operationId, decision.reason);
    }
    store.prepareAggregate(run, {
      operationId,
      recordKey: owner.external_id,
      subjectId,
      sourceAlias: effectiveAlias(intended.sourceAlias),
      intended,
      commandKey,
      requestBytes,
      reviewedHead: reviewed,
      status: 'prepared',
    });
    try {
      store.markAggregate(run, operationId, { status: 'uncertain' });
      const result = await this.deliverObservation(owner, subjectId, intended, commandKey, requestBytes, signal, write);
      if (result === 'conflict') {
        store.markAggregate(run, operationId, { status: 'conflict', nativeReason: 'concurrent-head' });
        throw new ObservationConflictError(operationId, 'concurrent-head');
      }
    } catch (error) {
      if (error instanceof ObservationConflictError) throw error;
      if (error instanceof Interrupted) throw error;
      store.markAggregate(run, operationId, { status: 'uncertain' });
      throw error;
    }
    const confirmed = await this.confirmObservation(subjectId, intended, signal, write);
    const retained =
      intended.kind === 'clear'
        ? headFromClear(subjectId, intended)
        : (confirmed.head ?? {
            provider: 'vndb' as const,
            sourceAlias: effectiveAlias(intended.sourceAlias),
            sourceRecordId: intended.sourceRecordId,
            asOf: intended.asOf,
            count: intended.count,
            cleared: false,
            digest: observationDigest(subjectId, intended),
            ...(intended.kind === 'write' ? { scale: intended.scale, mean: intended.mean } : {}),
          });
    store.retainAggregateHead(owner.source, { ...retained, subjectId });
    store.markAggregate(run, operationId, {
      status: 'delivered',
      reviewedHead: retained,
      outcome: { figure: confirmed.figure, figureUnavailable: confirmed.figureUnavailable },
    });
    this.progress(signal)?.onAcknowledgedEffects?.(1);
    return true;
  }

  async pageObservationConflicts(source: string, after?: string, limit = 20) {
    const run = this.session.store.activeRun(source);
    if (!run) return { operations: [], next: null as string | null };
    return this.session.store.pageUnresolvedAggregates(run, { ...(after ? { after } : {}), limit });
  }

  observationDetail(source: string, operationId: string) {
    const run = this.session.store.activeRun(source);
    if (!run) return null;
    return this.session.store.aggregateOperation(run, operationId);
  }

  async resolveObservation(
    source: string,
    operationId: string,
    reviewedObservation: string,
    signal: AbortSignal = this.shutdown.signal,
  ): Promise<{ status: 'delivered' | 'conflict' | 'refused' | 'busy' | 'unknown' | 'resume'; operationId: string }> {
    if (!DIGEST.test(operationId) || !DIGEST.test(reviewedObservation))
      throw new TypeError('Observation resolution requires exact operation and reviewed digests');
    const ownership = this.session.acquire(source);
    if (ownership === 'busy') return { status: 'busy', operationId };
    const write: Write = (operation) => operation();
    try {
      const run = this.session.store.activeRun(source);
      if (!run) return { status: 'unknown', operationId };
      const prior = this.session.store.aggregateOperation(run, operationId);
      if (!prior) return { status: 'unknown', operationId };
      if (prior.status === 'delivered' || prior.status === 'superseded')
        return { status: 'delivered', operationId: prior.operationId };
      if (prior.status === 'uncertain' || prior.status === 'prepared') return { status: 'resume', operationId };
      if (prior.status === 'refused' || parseObservationReason(prior.nativeReason) === 'older-date')
        return { status: 'refused', operationId };
      if (prior.reviewedHead?.digest !== reviewedObservation) return { status: 'conflict', operationId };
      const owner = { source, external_id: prior.recordKey };
      const omissions = await this.fences(owner, signal);
      if (prior.kind === 'write' && omissions.some((omission) => omission.field_group === 'facts'))
        return { status: 'conflict', operationId };
      const head = await this.readObservationHead(owner, prior.subjectId, signal, write);
      if (head.kind === 'unavailable') throw new ImportTransportError(head.status, undefined, head.code);
      const currentDigest = head.kind === 'head' ? head.head.digest : null;
      if (currentDigest !== reviewedObservation) {
        this.session.store.markAggregate(run, operationId, {
          status: 'conflict',
          nativeReason: 'concurrent-head',
          reviewedHead: head.kind === 'head' ? head.head : null,
        });
        return { status: 'conflict', operationId };
      }
      const decision = classifyObservation(prior.intended, prior.subjectId, head);
      if (decision.action === 'identical') {
        this.session.store.markAggregate(run, operationId, {
          status: 'delivered',
          reviewedHead: head.kind === 'head' ? head.head : prior.reviewedHead,
        });
        return { status: 'delivered', operationId };
      }
      if (decision.action === 'refused') {
        this.session.store.markAggregate(run, operationId, { status: 'refused', nativeReason: decision.reason });
        return { status: 'refused', operationId };
      }
      const expectedObservation = reviewedObservation;
      const successorId = aggregateOperationId({
        runId: run.id,
        recordKey: prior.recordKey,
        subjectId: prior.subjectId,
        intended: prior.intended,
        expectedObservation,
      });
      const commandKey = operationKey(
        owner,
        `${run.id}:source-statistic${prior.kind === 'clear' ? '-clear' : ''}:cas:${expectedObservation}`,
      );
      const requestBytes = JSON.stringify({ ...intendedPayload(prior.intended), expectedObservation });
      const successor = this.session.store.supersedeWithSuccessor(run, operationId, {
        operationId: successorId,
        recordKey: prior.recordKey,
        subjectId: prior.subjectId,
        sourceAlias: prior.sourceAlias,
        intended: prior.intended,
        commandKey,
        requestBytes,
        reviewedHead: head.kind === 'head' ? head.head : null,
        expectedObservation,
        status: 'prepared',
      });
      this.session.store.markAggregate(run, successor.operationId, { status: 'uncertain' });
      const result = await this.deliverObservation(
        owner,
        prior.subjectId,
        prior.intended,
        successor.commandKey,
        successor.requestBytes,
        signal,
        write,
      );
      if (result === 'conflict') {
        this.session.store.markAggregate(run, successor.operationId, {
          status: 'conflict',
          nativeReason: 'cas-mismatch',
        });
        return { status: 'conflict', operationId: successor.operationId };
      }
      const confirmed = await this.confirmObservation(prior.subjectId, prior.intended, signal, write);
      const retained =
        prior.intended.kind === 'clear'
          ? headFromClear(prior.subjectId, prior.intended)
          : (confirmed.head ?? headFromStatistic(prior.subjectId, { source: 'vndb', ...prior.intended } as never));
      this.session.store.retainAggregateHead(source, { ...retained, subjectId: prior.subjectId });
      this.session.store.markAggregate(run, successor.operationId, {
        status: 'delivered',
        reviewedHead: retained,
        outcome: { figure: confirmed.figure, figureUnavailable: confirmed.figureUnavailable },
      });
      return { status: 'delivered', operationId: successor.operationId };
    } finally {
      this.session.release(ownership);
    }
  }

  private async plan(
    registration: SourceRegistration,
    run: Run,
    staged: Staged<SourceProjection>,
    signal: AbortSignal,
    write: Write,
  ): Promise<Planned | null> {
    if (signal.aborted) throw new Interrupted('Import was interrupted');
    const store = this.session.store;
    const { row } = staged;
    const owner = { source: row.source, external_id: row.recordKey };
    const claim = row.state === 'present' ? this.session.bindings.claim(owner) : null;
    // Metadata is independent of semantic no-change detection. Failure keeps this
    // record unclassified and the source baseline unchanged, with its own retry intent.
    if (claim?.state === 'bound') await this.metadata(owner, staged.projection.sourceRecordMetadata, signal, write);
    let omissions = await this.fences(owner, signal);
    const recordState = store.key(row.source, row.recordKey, run);
    const acknowledged = recordState.acknowledged;
    // Disappearance has no source projection or references to resolve. Its exact
    // owner still supplies the candidates to retract through ordinary reconciliation.
    const ownReferences =
      row.state !== 'present' || this.options.identifierLookup
        ? null
        : resolveOwnReferences(staged.projection, row.source, this.session.bindings);
    if (ownReferences) {
      const prior = store.referenceSignature(row.source, row.recordKey);
      // A resolved entry belongs to this run's immutable command plan. If another
      // record taught a binding after that entry resolved, the next input pass refreshes it.
      if (recordState.resolved) return { kind: recordState.kind ?? 'unchanged', deferredCover: false };
      if (isDeepStrictEqual(acknowledged, row) && prior === ownReferences.signature) {
        return { kind: store.classify(run, row.recordKey, { commands: [], omissions }), deferredCover: false };
      }
      store.stageReferenceSignature(run, row.recordKey, ownReferences.signature);
    } else if (isDeepStrictEqual(acknowledged, row)) {
      return { kind: store.classify(run, row.recordKey, { commands: [], omissions }), deferredCover: false };
    }
    const candidates = this.current(owner);
    let conversion: ImportConversion | null = null;
    let observedConversion: ImportConversion | undefined;
    let subject: string | null = null;
    let deferredCover = false;
    let skipCover = false;
    let statisticWritten = false;
    if (row.state === 'present') {
      conversion = this.convert(registration, staged);
      observedConversion = conversion;
      this.retainDiagnostics(run, staged, conversion, 'application');
      if (claim?.state === 'bound') subject = claim.subject;
      else if (
        !omissions.some((o) => o.field_group === 'facts') &&
        !('outcome' in conversion && conversion.outcome === 'ignored')
      ) {
        subject = await this.bootstrap(registration, staged, conversion, signal, write);
        if (!subject) return null;
        await this.metadata(owner, staged.projection.sourceRecordMetadata, signal, write);
      }
      if (subject) {
        omissions = await this.fences(owner, signal);
        const resolvedReferences = this.options.identifierLookup
          ? await this.options.identifierLookup.resolve({ owner, conversion, signal })
          : ownReferences?.resolvedReferences;
        const context = { subjectId: subject, ...(resolvedReferences ? { resolvedReferences } : {}) };
        conversion = this.convert(registration, staged, context);
        this.retainDiagnostics(run, staged, conversion, 'application');
        const intents =
          'mediaImportIntents' in conversion ? (conversion.mediaImportIntents as MediaImportRequest[]) : [];
        if (intents.length && !omissions.some((o) => o.field_group === 'cover')) {
          if (!this.options.mediaResolver) throw new Interrupted('Media resolution is required');
          const resolution = await this.options.mediaResolver.resolve({
            owner,
            subject,
            mediaImportIntents: intents,
            signal,
            deferPending: true,
          });
          if (resolution.status === 'available') {
            const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
            for (const intent of intents)
              if (!uuid.test(resolution.mediaIds[intent.sourceUrl] ?? ''))
                throw new Error('Media availability is incomplete');
            conversion = this.convert(registration, staged, { ...context, mediaIds: resolution.mediaIds });
            this.retainDiagnostics(run, staged, conversion, 'application');
          } else {
            skipCover = true;
            deferredCover = resolution.status === 'pending';
            this.progress(signal)?.onMedia?.(resolution.status === 'pending' ? 'deferred' : 'rejected');
          }
        }
      }
    }
    if (subject && conversion?.sourceStatistic && !omissions.some((o) => o.field_group === 'facts')) {
      const { source: _source, expectedObservation: _token, ...value } = conversion.sourceStatistic;
      statisticWritten = await this.applyObservation(run, owner, subject, { kind: 'write', ...value }, signal, write);
    }
    // Removal addresses only this exact binding and remains permitted behind a facts fence.
    if (subject && conversion?.sourceStatisticClear) {
      const { source: _source, expectedObservation: _token, ...value } = conversion.sourceStatisticClear;
      statisticWritten = await this.applyObservation(run, owner, subject, { kind: 'clear', ...value }, signal, write);
    }
    const retainedCandidates = new Map<Candidate, BatchCommand>();
    const retainedProposals = new Set<BatchCommand>();
    for (const candidate of candidates) {
      if (
        omissions.some((o) => o.field_group === candidate.field_group) ||
        (skipCover && candidate.field_group === 'cover') ||
        // A converter transition refreshes even older matching revisions left
        // behind a fence. Only this run's acknowledged proposals can survive it.
        (acknowledged?.converter_revision !== row.converter_revision &&
          candidate.signature !== hash(`${run.id}:${candidate.key}`))
      )
        continue;
      const prior = (JSON.parse(candidate.bytes) as BatchWriteRequest).commands[0]!;
      if (prior.op !== 'propose') throw new Error('Owned candidate lacks its actual proposal');
      const unchanged = conversion?.proposals.find(
        (command) =>
          command.op === 'propose' &&
          // Equal facts from another converter revision still need fresh public
          // provenance. Only the producing revision can justify retention.
          command.source.converter_revision === prior.source.converter_revision &&
          command.source.field_group === candidate.field_group &&
          command.subject === candidate.subject &&
          isDeepStrictEqual(command.statement, prior.statement) &&
          !retainedProposals.has(command),
      );
      if (unchanged) {
        retainedCandidates.set(candidate, unchanged);
        retainedProposals.add(unchanged);
      }
    }
    const statisticOnly =
      (statisticWritten ||
        (registration.sourceKind === 'vndb' &&
          acknowledged?.state === 'present' &&
          acknowledged.recordRevision === row.recordRevision &&
          acknowledged.converter_revision === row.converter_revision &&
          !conversion?.sourceStatistic &&
          !conversion?.sourceStatisticClear)) &&
      !skipCover &&
      candidates.length > 0 &&
      retainedCandidates.size === candidates.length &&
      conversion?.proposals.every((command) => command.op === 'create' || retainedProposals.has(command));
    if (!statisticOnly) {
      for (const [candidate, proposal] of retainedCandidates) {
        const prior = (JSON.parse(candidate.bytes) as BatchWriteRequest).commands[0]!;
        // Equal values still need the changed source's actual digest. An acknowledged
        // proposal from this immutable run is already current and must survive replay.
        if (prior.source.digest !== row.digest && candidate.signature !== hash(`${run.id}:${candidate.key}`)) {
          retainedCandidates.delete(candidate);
          retainedProposals.delete(proposal);
        }
      }
    }
    const commands: BatchCommand[] = [];
    for (const candidate of candidates) {
      if (
        retainedCandidates.has(candidate) ||
        omissions.some((o) => o.field_group === candidate.field_group) ||
        (skipCover && candidate.field_group === 'cover')
      )
        continue;
      const prior = (JSON.parse(candidate.bytes) as BatchWriteRequest).commands[0]!;
      if (prior.op !== 'propose') throw new Error('Owned candidate lacks its actual proposal');
      commands.push({
        op: 'retract',
        key: operationKey(owner, `${run.id}:retract:${candidate.candidate}`),
        source: {
          source: row.source,
          external_id: row.recordKey,
          record_revision: row.recordRevision,
          converter_revision: row.converter_revision,
          digest: row.digest,
          field_group: candidate.field_group,
        },
        subject: candidate.subject,
        candidate: candidate.candidate,
        references: prior.statement.references,
      });
    }
    for (const command of conversion?.proposals ?? []) {
      if (
        retainedProposals.has(command) ||
        command.op === 'create' ||
        omissions.some((o) => o.field_group === command.source.field_group) ||
        (skipCover && command.source.field_group === 'cover')
      )
        continue;
      if (command.op !== 'propose' || !subject || command.subject !== subject)
        throw new Error('Converter did not produce bound proposals');
      commands.push({ ...command, key: operationKey(owner, `${run.id}:propose:${command.key}`) });
    }
    if (!commands.length && !omissions.length && !deferredCover) {
      const kind = store.classify(run, row.recordKey, { commands: [] });
      if (conversion && 'outcome' in conversion && conversion.outcome === 'ignored')
        store.acknowledgeNoEffects(run, row.recordKey, { reason: 'converter-ignored' });
      else if (row.state === 'vanished' && !candidates.length)
        store.acknowledgeNoEffects(run, row.recordKey, { reason: 'no-owned-candidates' });
      else if (statisticOnly) {
        // A confirmed statistic-only refresh changes the input projection without
        // replacing any acknowledged semantic candidate or its immutable journal.
        store.acknowledgeStatisticRefresh(run, row.recordKey);
      } else throw new Error('Conversion has no justified final plan');
      this.acknowledged(row.recordKey);
      return { kind, deferredCover: false, ...(observedConversion ? { conversion: observedConversion } : {}) };
    }
    return {
      kind: store.prepare(run, row.recordKey, {
        commands,
        omissions,
        ...(deferredCover ? { deferredCover: true } : {}),
      }),
      deferredCover,
      ...(observedConversion ? { conversion: observedConversion } : {}),
    };
  }

  private async resolveCover(
    registration: SourceRegistration,
    run: Run,
    deferred: DeferredCover<SourceProjection>,
    signal: AbortSignal,
    write: Write,
  ): Promise<{ outcome: 'pending' | 'failed' | 'resolved'; kind: Kind }> {
    const { row } = deferred;
    const owner = { source: row.source, external_id: row.recordKey };
    let omissions = await this.fences(owner, signal);
    const coverOmission = omissions.find((omission) => omission.field_group === 'cover');
    if (coverOmission) {
      const result = this.session.store.resolveDeferredCover(run, row.recordKey, { omission: coverOmission });
      if (result.resolved) this.acknowledged(row.recordKey);
      return { outcome: result.resolved ? 'resolved' : 'failed', kind: result.kind };
    }
    const claim = this.session.bindings.claim(owner);
    if (claim?.state !== 'bound') return { outcome: 'failed', kind: deferred.kind };
    // The context-free conversion exists only as input to identifier lookup.
    const lookup = this.options.identifierLookup;
    const ownReferences = lookup ? null : resolveOwnReferences(deferred.projection, row.source, this.session.bindings);
    const resolvedReferences = lookup
      ? await lookup.resolve({ owner, conversion: this.convert(registration, deferred), signal })
      : ownReferences?.resolvedReferences;
    const context = {
      subjectId: claim.subject,
      ...(resolvedReferences ? { resolvedReferences } : {}),
    };
    let conversion = this.convert(registration, deferred, context);
    const intents = 'mediaImportIntents' in conversion ? (conversion.mediaImportIntents as MediaImportRequest[]) : [];
    if (!intents.length) {
      const result = this.session.store.resolveDeferredCover(run, row.recordKey);
      if (result.resolved) this.acknowledged(row.recordKey);
      return { outcome: result.resolved ? 'resolved' : 'failed', kind: result.kind };
    }
    if (!this.options.mediaResolver) return { outcome: 'failed', kind: deferred.kind };
    const resolution = await this.options.mediaResolver.resolve({
      owner,
      subject: claim.subject,
      mediaImportIntents: intents,
      signal,
      deferPending: false,
    });
    if (resolution.status !== 'available') {
      if (resolution.status === 'pending') {
        this.progress(signal)?.onMedia?.('deferred');
        return { outcome: 'pending', kind: deferred.kind };
      }
      this.progress(signal)?.onMedia?.('rejected');
      const rejected = this.session.store.resolveDeferredCover(run, row.recordKey);
      if (rejected.resolved) this.acknowledged(row.recordKey);
      return { outcome: rejected.resolved ? 'resolved' : 'failed', kind: rejected.kind };
    }
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const intent of intents)
      if (!uuid.test(resolution.mediaIds[intent.sourceUrl] ?? '')) return { outcome: 'failed', kind: deferred.kind };
    omissions = await this.fences(owner, signal);
    const freshCoverOmission = omissions.find((omission) => omission.field_group === 'cover');
    if (freshCoverOmission) {
      const result = this.session.store.resolveDeferredCover(run, row.recordKey, { omission: freshCoverOmission });
      if (result.resolved) this.acknowledged(row.recordKey);
      return { outcome: result.resolved ? 'resolved' : 'failed', kind: result.kind };
    }
    conversion = this.convert(registration, deferred, { ...context, mediaIds: resolution.mediaIds });
    const proposals: BatchCommand[] = [];
    for (const command of conversion.proposals) {
      if (command.op === 'create' || command.source.field_group !== 'cover') continue;
      if (command.op !== 'propose' || command.subject !== claim.subject)
        throw new Error('Converter did not produce bound cover proposals');
      proposals.push({ ...command, key: operationKey(owner, `${run.id}:propose:${command.key}`) });
    }
    const proposalsByKey = new Map(proposals.map((command) => [command.key, command]));
    if (proposalsByKey.size !== proposals.length) throw new Error('Cover proposals contain duplicate command keys');
    const acknowledgedProposals = new Set<string>();
    const commands: BatchCommand[] = [];
    for (const candidate of this.current(owner).filter((value) => value.field_group === 'cover')) {
      const proposal = proposalsByKey.get(candidate.key);
      if (proposal) {
        const bytes = JSON.stringify({ commands: [proposal] });
        if (candidate.signature !== hash(`${run.id}:${proposal.key}`) || candidate.bytes !== bytes)
          throw new Error('Acknowledged cover proposal conflicts with its original request');
        // A candidate acknowledged from this run is already the result of its immutable
        // proposal. Keep it and avoid replaying that proposal at the completion boundary.
        acknowledgedProposals.add(candidate.key);
        continue;
      }
      const prior = (JSON.parse(candidate.bytes) as BatchWriteRequest).commands[0]!;
      if (prior.op !== 'propose') throw new Error('Owned candidate lacks its actual proposal');
      commands.push({
        op: 'retract',
        key: operationKey(owner, `${run.id}:retract:${candidate.candidate}`),
        source: {
          source: row.source,
          external_id: row.recordKey,
          record_revision: row.recordRevision,
          converter_revision: row.converter_revision,
          digest: row.digest,
          field_group: 'cover',
        },
        subject: candidate.subject,
        candidate: candidate.candidate,
        references: prior.statement.references,
      });
    }
    commands.push(...proposals.filter((command) => !acknowledgedProposals.has(command.key)));
    if (commands.length) {
      const request = { commands };
      this.atomic(() => {
        for (const command of commands)
          this.session.bindings.prepare(owner, hash(`${run.id}:${command.key}`), { commands: [command] });
      });
      const result = await this.send(request, signal, write);
      const acknowledgedEffects = this.acknowledge(owner, request, result);
      this.progress(signal)?.onAcknowledgedEffects?.(acknowledgedEffects);
      if (!result.results.every(success)) return { outcome: 'failed', kind: deferred.kind };
    }
    const result = this.session.store.resolveDeferredCover(run, row.recordKey);
    if (result.resolved) this.acknowledged(row.recordKey);
    return { outcome: result.resolved ? 'resolved' : 'failed', kind: result.kind };
  }

  private async resolveCovers(
    registration: SourceRegistration,
    run: Run,
    signal: AbortSignal,
    deadline: number,
  ): Promise<boolean> {
    for (;;) {
      let after: string | undefined;
      let pending = false;
      let failed = false;
      let stopped = false;
      for (;;) {
        const page = this.session.store.pageDeferredCovers(run, {
          ...(after ? { after } : {}),
          limit: 100,
        });
        this.retain(
          'media',
          page.map((entry) => ({ recordKey: entry.row.recordKey, value: entry })),
        );
        const outcomes = await this.concurrent(
          'media',
          page,
          signal,
          (entry) => entry.row.recordKey,
          async (entry, write) => {
            try {
              return await this.resolveCover(registration, run, entry, signal, write);
            } catch (error) {
              if (error instanceof Interrupted) throw error;
              const overload =
                error instanceof ImportTransportError &&
                (error.status === 429 || (error.status === 503 && error.retryable));
              return { outcome: overload ? ('stopped' as const) : ('failed' as const), kind: entry.kind };
            }
          },
        );
        for (const outcome of outcomes) {
          if (outcome.outcome === 'pending') pending = true;
          else if (outcome.outcome === 'failed') failed = true;
          else if (outcome.outcome === 'stopped') stopped = true;
        }
        if (page.length) after = page.at(-1)!.row.recordKey;
        this.options.observer?.onPageRetained?.('media', []);
        // Polling availability must not open a new budget for a failed write.
        if (stopped) return false;
        if (page.length < 100) break;
      }
      if (!pending && !failed) return true;
      const remaining = deadline - this.now();
      if (remaining <= 0) return false;
      await this.sleep(Math.min(1000, remaining), signal);
    }
  }

  private async run(
    registration: SourceRegistration,
    records: AsyncIterable<SourceRecord>,
    options: ImportRunOptions,
  ): Promise<ImportRunResult> {
    const result: ImportRunResult = {
      status: 'interrupted',
      skipped: 0,
      counts: { new: 0, changed: 0, unchanged: 0, vanished: 0 },
      new: [],
      changed: [],
      unchanged: [],
      vanished: [],
      diagnostic: '',
    };
    const limit = options.collectionLimit ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10000) throw new TypeError('Invalid key collection limit');
    const observe = (kind: Kind, key: string) => {
      result.counts[kind]++;
      options.progress?.onClassified?.(kind);
      if (limit) {
        if (Object.values(result.counts).reduce((a, b) => a + b, 0) > limit)
          throw new Interrupted('Key collection bound exceeded');
        result[kind].push(key);
      }
      const sinks = {
        new: options.sink?.onNew,
        changed: options.sink?.onChanged,
        unchanged: options.sink?.onUnchanged,
        vanished: options.sink?.onVanished,
      };
      sinks[kind]?.(key);
    };
    const finish = (status: RunStatus, diagnostic: string) => Object.assign(result, { status, diagnostic });
    const runController = new AbortController();
    const signal = AbortSignal.any([
      this.shutdown.signal,
      runController.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    this.runControllers.set(signal, runController);
    const mediaDeadline = this.now() + this.mediaDeadlineMs;
    const ownership = this.session.acquire(registration.source);
    if (ownership === 'busy') return finish('busy', 'Source has a live coordinator');
    const store = this.session.store;
    if (options.progress) this.progressObservers.set(signal, options.progress);
    try {
      let run = this.session.reopen(ownership);
      let resumed = !!run;
      let skipped = 0;
      if (run) {
        options.progress?.onRun?.(run.id, true);
        const resuming = options.progress?.onPhase?.('resuming');
        if (resuming !== undefined) await resuming;
        // Capture sealed accounting before finalization can mark or otherwise retire the run.
        skipped = store.skipped(run);
        result.skipped = skipped;
        // A staging run has no permitted effects and can be discarded. A sealed
        // or finalizing run must finish its durable payload before newer input.
        let final: 'incomplete' | 'more' | 'complete' | null = null;
        try {
          final = store.finalize(run, 100);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'Run cannot finalize') throw error;
        }
        if (final === null) {
          if (store.abandon(run) !== 'abandoned') throw new Error('Cannot discard uncertain import');
          run = null;
          resumed = false;
        } else {
          options.progress?.onSkipped?.(skipped);
          if (final !== 'incomplete') {
            options.progress?.onSourceCompleted?.();
            const finalizing = options.progress?.onPhase?.('finalizing');
            if (finalizing !== undefined) await finalizing;
            while (final === 'more') final = store.finalize(run, 100);
            return finish('committed', 'Resumed source finalization');
          }
        }
      }
      if (!run) {
        const next = store.begin(
          registration.source,
          options.disappearanceThreshold === undefined
            ? {}
            : { disappearanceThreshold: options.disappearanceThreshold },
        );
        if (next === 'busy') return finish('busy', 'Source has active durable work');
        run = next;
        options.progress?.onRun?.(run.id, false);
        try {
          // Staged rows need no durability before the seal, so a page of them shares one commit. The
          // result equals staging one by one: the rows before a failure and its invalid mark persist.
          const buffered: { staged: Staged<SourceProjection>; conversion: ImportConversion }[] = [];
          let stagingStarted = false;
          const enterStaging = () => {
            if (stagingStarted) return;
            stagingStarted = true;
            return options.progress?.onPhase?.('staging');
          };
          const flush = () => {
            if (buffered.length === 0) return;
            const commit = () => {
              const page = buffered.splice(0);
              let failure: unknown;
              let stagedCount = 0;
              this.atomic(() => {
                for (const item of page) {
                  try {
                    store.stage(next, item.staged);
                    this.retainDiagnostics(next, item.staged, item.conversion, 'staging');
                    stagedCount++;
                  } catch (error) {
                    if (error instanceof ConversionDiagnosticError) throw error;
                    failure = error;
                    return;
                  }
                }
              });
              options.progress?.onStaged?.(stagedCount);
              if (failure !== undefined) throw failure;
            };
            const phase = enterStaging();
            return phase !== undefined ? Promise.resolve(phase).then(commit) : commit();
          };
          for await (const record of records) {
            if (signal.aborted) throw new Interrupted('Import was interrupted');
            if (record.source !== registration.sourceKind) throw new Error('Source stream registration mismatch');
            const conversion = registration.convert(
              { external_id: record.key, record_revision: record.revision ?? 'unversioned', record: record.payload },
              { source: registration.source },
            );
            if ('outcome' in conversion && conversion.outcome === 'ignored') {
              if (skipped === Number.MAX_SAFE_INTEGER) throw new Interrupted('Skipped input count exceeded its bound');
              skipped++;
              options.progress?.onSkipped?.(1);
            }
            buffered.push({
              conversion,
              staged: {
                row: {
                  source: registration.source,
                  recordKey: record.key,
                  recordRevision: conversion.record_revision ?? 'unversioned',
                  converter_revision: registration.converter_revision,
                  digest: conversion.digest,
                  state: 'present',
                },
                projection: {
                  sourceKind: registration.sourceKind,
                  normalizedRecord: conversion.normalized,
                  ...('outcome' in conversion && conversion.outcome === 'ignored'
                    ? {}
                    : registration.describeSourceRecord
                      ? { sourceRecordMetadata: registration.describeSourceRecord(record.key) }
                      : {}),
                },
              },
            });
            if (buffered.length >= 100) {
              const pending = flush();
              if (pending !== undefined) await pending;
            }
          }
          const phase = enterStaging();
          if (phase !== undefined) await phase;
          const pending = flush();
          if (pending !== undefined) await pending;
        } catch (error) {
          store.seal(run, { complete: false, reason: 'malformed' });
          return finish(
            signal.aborted || error instanceof Interrupted ? 'interrupted' : 'invalid-dump',
            'Input is incomplete or invalid',
          );
        }
        const seal = store.seal(run, { complete: true, skipped });
        options.progress?.onSourceCompleted?.();
        if (seal.status !== 'ready')
          return finish(seal.status === 'mass-disappearance' ? 'mass-disappearance' : 'invalid-dump', seal.diagnostic);
        result.skipped = skipped;
      }
      result.skipped = skipped;
      const reconciling = options.progress?.onPhase?.('reconciling');
      if (reconciling !== undefined) await reconciling;
      if (resumed && !(await this.drain(run, signal, 'resumed')))
        return finish('bulk-failed', 'Durable operations remain unresolved');
      let failed = false;
      let observationConflict = false;
      let after: string | undefined;
      for (;;) {
        const page = store.pageStaged(run, { ...(after ? { after } : {}), limit: 100 });
        this.retain(
          'staged',
          page.map((staged) => ({ recordKey: staged.row.recordKey, value: staged })),
        );
        const outcomes = await this.concurrent(
          'staged',
          page,
          signal,
          (staged) => staged.row.recordKey,
          async (staged, write): Promise<Planned | 'failed' | null> => {
            const { row, projection } = staged;
            // Prior attempts can already have classified disappeared rows in this
            // journal. The dedicated vanished index owns that enumeration.
            if (row.state === 'vanished') return null;
            const state = store.key(row.source, row.recordKey, run);
            if (state.coverPending) return state.kind ? { kind: state.kind, deferredCover: true } : 'failed';
            try {
              const configured =
                projection.sourceKind === registration.sourceKind &&
                row.converter_revision === registration.converter_revision
                  ? registration
                  : createSourceRegistration(projection.sourceKind, {
                      source: row.source,
                      converterRevision: row.converter_revision,
                    });
              const planned = await this.plan(configured, run, staged, signal, write);
              if (!planned) return 'failed';
              for (const pending of store.pendingRecord(run, row.recordKey))
                if (!(await this.dispatch(run, pending, signal, write))) return 'failed';
              return planned;
            } catch (error) {
              if (error instanceof Interrupted) throw error;
              if (error instanceof ObservationConflictError || error instanceof ObservationRefusedError)
                return { kind: 'unchanged' as const, deferredCover: false, observationConflict: true };
              return 'failed';
            }
          },
        );
        for (let index = 0; index < outcomes.length; index++) {
          const outcome = outcomes[index];
          if (outcome === 'failed') failed = true;
          else if (outcome) {
            if (outcome.observationConflict) observationConflict = true;
            else {
              if (outcome.conversion) this.options.onConversionOutput?.(outcome.conversion);
              observe(outcome.kind, page[index]!.row.recordKey);
            }
          }
        }
        if (page.length) after = page.at(-1)!.row.recordKey;
        this.options.observer?.onPageRetained?.('staged', []);
        if (page.length < 100) break;
      }
      after = undefined;
      for (;;) {
        const page = store.pageVanished(run, { ...(after ? { after } : {}), limit: 100 });
        this.retain(
          'vanished',
          page.map((prior) => ({ recordKey: prior.recordKey, value: prior })),
        );
        const outcomes = await this.concurrent(
          'vanished',
          page,
          signal,
          (prior) => prior.recordKey,
          async (prior, write): Promise<Planned | 'failed'> => {
            try {
              const planned = await this.plan(
                registration,
                run,
                {
                  row: { ...prior, state: 'vanished' },
                  projection: { sourceKind: registration.sourceKind, normalizedRecord: null },
                },
                signal,
                write,
              );
              if (!planned) return 'failed';
              for (const pending of store.pendingRecord(run, prior.recordKey))
                if (!(await this.dispatch(run, pending, signal, write))) return 'failed';
              return planned;
            } catch (error) {
              if (error instanceof Interrupted) throw error;
              if (error instanceof ObservationConflictError || error instanceof ObservationRefusedError)
                return { kind: 'unchanged' as const, deferredCover: false, observationConflict: true };
              return 'failed';
            }
          },
        );
        for (let index = 0; index < outcomes.length; index++) {
          const outcome = outcomes[index]!;
          if (outcome === 'failed') failed = true;
          else if (outcome.observationConflict) observationConflict = true;
          else observe(outcome.kind, page[index]!.recordKey);
        }
        if (page.length) after = page.at(-1)!.recordKey;
        this.options.observer?.onPageRetained?.('vanished', []);
        if (page.length < 100) break;
      }
      // Inspect durable leftovers without retrying a failed record in the same run.
      store.pagePending(run, { limit: 100 });
      const deferredMedia = options.progress?.onPhase?.('deferred-media');
      if (deferredMedia !== undefined) await deferredMedia;
      if (!(await this.resolveCovers(registration, run, signal, mediaDeadline))) failed = true;
      if (observationConflict || store.hasObservationConflicts(run)) {
        const conflict = options.progress?.onPhase?.('observation-conflict');
        if (conflict !== undefined) await conflict;
        return finish('observation-conflict', 'Source observation requires explicit operator resolution');
      }
      if (failed || store.hasUnresolvedAggregates(run))
        return finish('bulk-failed', 'Durable operations remain unresolved');
      const finalizing = options.progress?.onPhase?.('finalizing');
      if (finalizing !== undefined) await finalizing;
      let final = store.finalize(run, 100);
      while (final === 'more') final = store.finalize(run, 100);
      return finish(
        final === 'complete' ? 'committed' : 'bulk-failed',
        final === 'complete' ? 'Source snapshot committed' : 'Records remain unresolved',
      );
    } catch (error) {
      if (error instanceof ObservationConflictError || error instanceof ObservationRefusedError)
        return finish('observation-conflict', 'Source observation requires explicit operator resolution');
      return finish(
        error instanceof Interrupted ? 'interrupted' : 'bulk-failed',
        error instanceof Interrupted ? error.message : 'Import operations remain unresolved',
      );
    } finally {
      this.runControllers.delete(signal);
      this.progressObservers.delete(signal);
      this.session.release(ownership);
    }
  }
}

export function createImporter(options: ImporterOptions): Importer {
  return new Importer(options);
}
