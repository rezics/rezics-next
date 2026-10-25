import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { SourceRecord } from '@rezics/conversion';
import {
  checkBatchWrite,
  checkBatchWriteResult,
  FIELD_GROUPS,
  type BatchCommand,
  type BatchWriteRequest,
  type BatchWriteResult,
} from '@rezics/definitions/bulk';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import type {
  ImportConversion,
  ImportTransport,
  RunResultSink,
  RunStatus,
  SourceRegistration,
} from './import-contract.ts';
import { readDump } from './dumps.ts';
import { ImportSession } from './import-session.ts';
import type { Candidate, Owner } from './record-bindings.ts';
import type { RecordRow } from './record-store.ts';
import type { Omission, Pending, Run, SourceProjection, Staged } from './run-store.ts';
import { createSourceRegistration } from './source-registry.ts';

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
};
export type ImporterOptions = {
  path: string | Database;
  transport: ImportTransport;
  mediaResolver?: ImportMediaResolver;
  identifierLookup?: ImportIdentifierLookup;
  onConversionOutput?(output: ImportConversion): void;
  afterBulkSuccess?(request: BatchWriteRequest, result: BatchWriteResult): void | Promise<void>;
  instrumentDatabase?: (database: Database) => Database;
};

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const success = (result: BatchWriteResult['results'][number]) => result.status === 200 || result.status === 201;
class Interrupted extends Error {}

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
  private closing = false;

  constructor(private readonly options: ImporterOptions) {
    this.session = new ImportSession(
      options.path,
      options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {},
    );
  }

  runDump(
    registration: SourceRegistration,
    bytes: AsyncIterable<Uint8Array>,
    options: ImportRunOptions = {},
  ): Promise<ImportRunResult> {
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
    this.options.onConversionOutput?.(result);
    return result;
  }

  private async fences(owner: Owner): Promise<Omission[]> {
    const values = await Promise.all(
      FIELD_GROUPS.map(async (field_group): Promise<Omission | null> => {
        const value = await this.options.transport.readFence({ ...owner, field_group });
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
    if (checkBatchWriteResult(result).length || result.results.length !== request.commands.length)
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

  private async send(request: BatchWriteRequest, signal: AbortSignal): Promise<BatchWriteResult> {
    if (signal.aborted) throw new Interrupted('Import was interrupted');
    if (checkBatchWrite(request).length || Buffer.byteLength(JSON.stringify(request)) > 65536)
      throw new Error('Invalid public envelope');
    const response = await this.options.transport.batchWrite(request);
    this.validateResult(request, response);
    if (response.results.some(success)) {
      try {
        await this.options.afterBulkSuccess?.(request, response);
      } catch {
        throw new Interrupted('Interrupted after remote success before local acknowledgement');
      }
    }
    return response;
  }

  private acknowledge(owner: Owner, request: BatchWriteRequest, result: BatchWriteResult): void {
    // The complete response is validated before the first local acknowledgement.
    this.validateResult(request, result);
    for (const entry of result.results) {
      if (success(entry)) this.session.bindings.acknowledge(owner, entry.key, { results: [entry] });
      else if (entry.status === 404 && request.commands.find((c) => c.key === entry.key)?.op !== 'create')
        this.session.bindings.takenDown(owner, { status: 404 });
    }
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

  private async bootstrap(
    registration: SourceRegistration,
    staged: Staged<SourceProjection>,
    conversion: ImportConversion,
    signal: AbortSignal,
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
    const result = await this.send(request, signal);
    this.acknowledge(owner, request, result);
    const bound = bindings.claim(owner);
    return bound?.state === 'bound' ? bound.subject : null;
  }

  private async dispatch(run: Run, pending: Pending, signal: AbortSignal): Promise<boolean> {
    const owner = { source: run.source, external_id: pending.recordKey };
    const omissions = await this.fences(owner);
    // An empty commands argument augments only omission proof, retaining the
    // original immutable journal and each of its public operation bodies.
    this.session.store.prepare(run, pending.recordKey, { commands: [], omissions });
    const proved = this.session.store.key(run.source, pending.recordKey, run).omissions;
    const original = JSON.parse(pending.bytes) as BatchWriteRequest;
    const commands = original.commands.filter(
      (command) => !proved.some((o) => o.field_group === command.source.field_group),
    );
    if (!commands.length) return true;
    const request = { commands };
    for (const command of commands) {
      this.session.bindings.prepare(owner, hash(`${run.id}:${command.key}`), { commands: [command] });
    }
    const result = await this.send(request, signal);
    // Returned identities must be durable before RunStore can resolve a record.
    this.acknowledge(owner, request, result);
    this.session.store.acknowledge(run, result, { recordKey: pending.recordKey });
    return result.results.every(success);
  }

  private async drain(run: Run, signal: AbortSignal): Promise<boolean> {
    let after: string | undefined;
    let complete = true;
    for (;;) {
      const page = this.session.store.pagePending(run, { ...(after ? { after } : {}), limit: 100 });
      for (const pending of page) {
        try {
          if (!(await this.dispatch(run, pending, signal))) complete = false;
        } catch (error) {
          if (error instanceof Interrupted) throw error;
          complete = false;
        }
        after = pending.after;
      }
      if (page.length < 100) return complete;
    }
  }

  private async plan(
    registration: SourceRegistration,
    run: Run,
    staged: Staged<SourceProjection>,
    signal: AbortSignal,
  ): Promise<Kind | null> {
    if (signal.aborted) throw new Interrupted('Import was interrupted');
    const store = this.session.store;
    const { row } = staged;
    const owner = { source: row.source, external_id: row.recordKey };
    let omissions = await this.fences(owner);
    const acknowledged = store.key(row.source, row.recordKey).acknowledged;
    if (isDeepStrictEqual(acknowledged, row)) {
      return store.classify(run, row.recordKey, { commands: [], omissions });
    }
    const candidates = this.current(owner);
    let conversion: ImportConversion | null = null;
    let subject: string | null = null;
    if (row.state === 'present') {
      conversion = this.convert(registration, staged);
      const claim = this.session.bindings.claim(owner);
      if (claim?.state === 'bound') subject = claim.subject;
      else if (
        !omissions.some((o) => o.field_group === 'facts') &&
        !('outcome' in conversion && conversion.outcome === 'ignored')
      ) {
        subject = await this.bootstrap(registration, staged, conversion, signal);
        if (!subject) return null;
      }
      if (subject) {
        omissions = await this.fences(owner);
        const resolvedReferences = await this.options.identifierLookup?.resolve({ owner, conversion, signal });
        const context = { subjectId: subject, ...(resolvedReferences ? { resolvedReferences } : {}) };
        conversion = this.convert(registration, staged, context);
        const intents =
          'mediaImportIntents' in conversion ? (conversion.mediaImportIntents as MediaImportRequest[]) : [];
        if (intents.length && !omissions.some((o) => o.field_group === 'cover')) {
          if (!this.options.mediaResolver) throw new Interrupted('Media resolution is required');
          const resolution = await this.options.mediaResolver.resolve({
            owner,
            subject,
            mediaImportIntents: intents,
            signal,
          });
          if (resolution.status !== 'available') throw new Interrupted('Media resolution is incomplete');
          const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
          for (const intent of intents)
            if (!uuid.test(resolution.mediaIds[intent.sourceUrl] ?? ''))
              throw new Interrupted('Media availability is incomplete');
          conversion = this.convert(registration, staged, { ...context, mediaIds: resolution.mediaIds });
        }
      }
    }
    const commands: BatchCommand[] = [];
    for (const candidate of candidates) {
      if (omissions.some((o) => o.field_group === candidate.field_group)) continue;
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
      if (command.op === 'create' || omissions.some((o) => o.field_group === command.source.field_group)) continue;
      if (command.op !== 'propose' || !subject || command.subject !== subject)
        throw new Error('Converter did not produce bound proposals');
      commands.push({ ...command, key: operationKey(owner, `${run.id}:propose:${command.key}`) });
    }
    if (!commands.length && !omissions.length) {
      const kind = store.classify(run, row.recordKey, { commands: [] });
      if (conversion && 'outcome' in conversion && conversion.outcome === 'ignored')
        store.acknowledgeNoEffects(run, row.recordKey, { reason: 'converter-ignored' });
      else if (row.state === 'vanished' && !candidates.length)
        store.acknowledgeNoEffects(run, row.recordKey, { reason: 'no-owned-candidates' });
      else throw new Error('Conversion has no justified final plan');
      return kind;
    }
    return store.prepare(run, row.recordKey, { commands, omissions });
  }

  private async run(
    registration: SourceRegistration,
    records: AsyncIterable<SourceRecord>,
    options: ImportRunOptions,
  ): Promise<ImportRunResult> {
    const result: ImportRunResult = {
      status: 'interrupted',
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
    const signal = AbortSignal.any([this.shutdown.signal, ...(options.signal ? [options.signal] : [])]);
    const ownership = this.session.acquire(registration.source);
    if (ownership === 'busy') return finish('busy', 'Source has a live coordinator');
    const store = this.session.store;
    try {
      let run = this.session.reopen(ownership);
      let resumed = !!run;
      if (run) {
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
        } else if (final !== 'incomplete') {
          while (final === 'more') final = store.finalize(run, 100);
          return finish('committed', 'Resumed source finalization');
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
        try {
          for await (const record of records) {
            if (signal.aborted) throw new Interrupted('Import was interrupted');
            if (record.source !== registration.sourceKind) throw new Error('Source stream registration mismatch');
            const conversion = registration.convert(
              { external_id: record.key, record_revision: record.revision ?? 'unversioned', record: record.payload },
              { source: registration.source },
            );
            this.options.onConversionOutput?.(conversion);
            store.stage(run, {
              row: {
                source: registration.source,
                recordKey: record.key,
                recordRevision: conversion.record_revision ?? 'unversioned',
                converter_revision: registration.converter_revision,
                digest: conversion.digest,
                state: 'present',
              },
              projection: { sourceKind: registration.sourceKind, normalizedRecord: conversion.normalized },
            });
          }
        } catch (error) {
          store.seal(run, { complete: false, reason: 'malformed' });
          return finish(
            error instanceof Interrupted ? 'interrupted' : 'invalid-dump',
            'Input is incomplete or invalid',
          );
        }
        const seal = store.seal(run, { complete: true });
        if (seal.status !== 'ready')
          return finish(seal.status === 'mass-disappearance' ? 'mass-disappearance' : 'invalid-dump', seal.diagnostic);
      }
      if (resumed && !(await this.drain(run, signal)))
        return finish('bulk-failed', 'Durable operations remain unresolved');
      let failed = false;
      let after: string | undefined;
      for (;;) {
        const page = store.pageStaged(run, { ...(after ? { after } : {}), limit: 100 });
        for (const staged of page) {
          const { row, projection } = staged;
          after = row.recordKey;
          // Prior attempts can already have classified disappeared rows in this
          // journal. The dedicated vanished index owns that enumeration.
          if (row.state === 'vanished') continue;
          try {
            const configured =
              projection.sourceKind === registration.sourceKind &&
              row.converter_revision === registration.converter_revision
                ? registration
                : createSourceRegistration(projection.sourceKind, {
                    source: row.source,
                    converterRevision: row.converter_revision,
                  });
            const kind = await this.plan(configured, run, staged, signal);
            if (kind) observe(kind, row.recordKey);
            else failed = true;
          } catch (error) {
            if (error instanceof Interrupted) throw error;
            failed = true;
          }
        }
        if (page.length < 100) break;
      }
      after = undefined;
      for (;;) {
        const page = store.pageVanished(run, { ...(after ? { after } : {}), limit: 100 });
        for (const prior of page) {
          after = prior.recordKey;
          try {
            const kind = await this.plan(
              registration,
              run,
              {
                row: { ...prior, state: 'vanished' },
                projection: { sourceKind: registration.sourceKind, normalizedRecord: null },
              },
              signal,
            );
            if (kind) observe(kind, prior.recordKey);
            else failed = true;
          } catch (error) {
            if (error instanceof Interrupted) throw error;
            failed = true;
          }
        }
        if (page.length < 100) break;
      }
      if (!(await this.drain(run, signal))) failed = true;
      if (failed) return finish('bulk-failed', 'Durable operations remain unresolved');
      let final = store.finalize(run, 100);
      while (final === 'more') final = store.finalize(run, 100);
      return finish(
        final === 'complete' ? 'committed' : 'bulk-failed',
        final === 'complete' ? 'Source snapshot committed' : 'Records remain unresolved',
      );
    } catch (error) {
      return finish(
        error instanceof Interrupted ? 'interrupted' : 'bulk-failed',
        error instanceof Interrupted ? error.message : 'Import operations remain unresolved',
      );
    } finally {
      this.session.release(ownership);
    }
  }
}

export function createImporter(options: ImporterOptions): Importer {
  return new Importer(options);
}
