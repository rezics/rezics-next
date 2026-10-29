import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Database, Statement } from 'bun:sqlite';
import { join } from 'node:path';
import type { SourceRecord } from '@rezics/conversion';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import type { MediaImportAccepted, MediaImportRequest, MediaImportStatus } from '@rezics/definitions/media-import';
import type {
  CreateImportPipelineDriver,
  Exchange,
  MediaMode,
  Phase,
  PipelineOptions,
  PipelineRecord,
  PipelineReport,
} from '../../../specs/imports-pipeline-driver.ts';
import { Importer, type ImportMediaResolution, type ImporterOptions } from '../src/importer.ts';
import { createImportTransport, type ImportTransportOptions } from '../src/import-client.ts';
import { createMediaResolver } from '../src/media-resolver.ts';
import type { Owner } from '../src/record-bindings.ts';
import { createSourceRegistration } from '../src/source-registry.ts';

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../specs/fixtures/imports/bangumi/subject.json'), 'utf8'),
);
const nativeRegistration = createSourceRegistration('bangumi');
/** Machine-independent work counters for the record-cpu-growth specification. */
export const pipelineWork = { conversions: 0, prepares: 0, statements: 0, transactions: 0, commits: 0 };
const registration: typeof nativeRegistration = {
  ...nativeRegistration,
  convert(input, context) {
    pipelineWork.conversions++;
    return nativeRegistration.convert(input, context);
  },
};
let tracedDatabases = 0;
function countWork(database: Database): Database {
  const trace = process.env.IMPORTER_PREPARE_TRACE === '1';
  const databaseNumber = trace ? ++tracedDatabases : 0;
  let prepareEvent = 0;
  const prepare = database.prepare.bind(database);
  const count = (sql: string) => {
    if (/^\s*BEGIN\b/i.test(sql)) pipelineWork.transactions++;
    if (/^\s*(?:COMMIT|END)\b/i.test(sql)) pipelineWork.commits++;
  };
  database.prepare = ((sql: string, ...rest: unknown[]) => {
    pipelineWork.prepares++;
    count(sql);
    // Opt-in cold-cache evidence only: bounded literal SQL, never bound parameters.
    if (trace && ++prepareEvent <= 128 && sql.length <= 16_384) {
      console.info('importer prepare trace:', JSON.stringify({ database: databaseNumber, event: prepareEvent, sql }));
    }
    const statement = (prepare as (sql: string, ...rest: unknown[]) => Statement)(sql, ...rest);
    for (const method of ['run', 'get', 'all'] as const) {
      const execute = statement[method].bind(statement) as (...args: unknown[]) => unknown;
      (statement as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        pipelineWork.statements++;
        return execute(...args);
      };
    }
    return statement;
  }) as Database['prepare'];
  const exec = database.exec.bind(database);
  database.exec = ((sql: string, ...rest: unknown[]) => {
    pipelineWork.statements++;
    count(sql);
    return (exec as (sql: string, ...rest: unknown[]) => unknown)(sql, ...rest);
  }) as Database['exec'];
  return database;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
        )
      : value;
const uuid = (value: string) => {
  const text = hash(value);
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-4${text.slice(13, 16)}-8${text.slice(17, 20)}-${text.slice(20, 32)}`;
};
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type Event<T = unknown> = {
  at: number;
  key: string;
  sequence: number;
  signal?: AbortSignal;
  exchange?: Exchange;
  operation(): T;
  resolve(value: T): void;
  reject(error: unknown): void;
};

class Scheduler {
  now = 0;
  active = 0;
  private order = 0;
  private eventSequence = 0;
  private events: Event[] = [];
  constructor(
    private readonly reverse: boolean,
    private readonly latency: number,
    private readonly exchanges: Exchange[],
    private readonly hook: (exchange: Exchange) => void,
    private readonly sleepLog: { phase: Phase; ms: number }[],
    private readonly flushTurns = 8,
  ) {}

  request<T>(
    input: Omit<Exchange, 'started' | 'ended' | 'startOrder' | 'endOrder' | 'cancelled'>,
    signal: AbortSignal | undefined,
    operation: () => T,
    delay = this.latency,
  ): Promise<T> {
    const exchange: Exchange = {
      ...input,
      started: this.now,
      ended: this.now,
      startOrder: ++this.order,
      endOrder: 0,
      cancelled: false,
    };
    return this.schedule(delay, input.recordKey, signal, operation, exchange);
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    this.sleepLog.push({ phase: 'media', ms });
    return this.schedule(ms, '', signal, () => undefined);
  }

  timer(callback: () => void, ms: number): () => void {
    this.active++;
    const event: Event = {
      at: this.now + ms,
      key: '',
      sequence: ++this.eventSequence,
      operation: callback,
      resolve() {},
      reject() {},
    };
    this.events.push(event);
    return () => {
      const index = this.events.indexOf(event);
      if (index !== -1) {
        this.events.splice(index, 1);
        this.active--;
      }
    };
  }

  private schedule<T>(
    delay: number,
    key: string,
    signal: AbortSignal | undefined,
    operation: () => T,
    exchange?: Exchange,
  ): Promise<T> {
    this.active++;
    return new Promise<T>((resolve, reject) => {
      this.events.push({
        at: this.now + delay,
        key,
        sequence: ++this.eventSequence,
        ...(signal ? { signal } : {}),
        ...(exchange ? { exchange } : {}),
        operation,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
  }

  async drive<T>(promise: Promise<T>): Promise<T> {
    let settled = false;
    let value: T | undefined;
    let failure: unknown;
    void promise.then(
      (result) => {
        value = result;
        settled = true;
      },
      (error) => {
        failure = error;
        settled = true;
      },
    );
    while (!settled || this.events.length) {
      for (let turn = 0; turn < this.flushTurns; turn++) await Promise.resolve();
      if (!this.events.length) {
        await Promise.resolve();
        continue;
      }
      this.events.sort(
        (a, b) =>
          a.at - b.at || (this.reverse ? compare(b.key, a.key) : compare(a.key, b.key)) || a.sequence - b.sequence,
      );
      const event = this.events.shift()!;
      this.now = Math.max(this.now, event.at);
      this.active--;
      if (event.exchange) {
        event.exchange.ended = this.now;
        event.exchange.endOrder = ++this.order;
      }
      if (settled || event.signal?.aborted) {
        if (event.exchange) {
          event.exchange.cancelled = true;
          this.exchanges.push(event.exchange);
          this.hook(event.exchange);
        }
        event.reject(event.signal?.reason ?? new Error('Cancelled after importer completion'));
      } else {
        try {
          const result = event.operation();
          if (event.exchange) {
            this.exchanges.push(event.exchange);
            this.hook(event.exchange);
          }
          event.resolve(result);
        } catch (error) {
          if (event.exchange) {
            this.exchanges.push(event.exchange);
            this.hook(event.exchange);
          }
          event.reject(error);
        }
      }
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    }
    if (failure !== undefined) throw failure;
    return value as T;
  }
}

type Receipt = { bytes: string; result: BatchWriteResult['results'][number] };
type Job = {
  key: string;
  bytes: string;
  request: MediaImportRequest;
  accepted: MediaImportAccepted;
  submittedAt: number;
};

function mediaStatus(job: Job, state: MediaImportStatus['media']['state']): MediaImportStatus {
  const measured = state === 'uploaded' || state === 'available';
  return {
    media: {
      ...job.accepted.media,
      state,
      credit: job.request.credit,
      provenance: job.request.provenance,
      byteCount: measured ? 123 : null,
      mediaType: measured ? 'image/webp' : null,
      sha256: measured ? 'b'.repeat(64) : null,
      ...(state === 'rejected' ? { rejection: { code: 'source-denied' } } : {}),
    },
  } as MediaImportStatus;
}

function sourceRecord(record: PipelineRecord): SourceRecord {
  const payload = structuredClone(fixture);
  payload.id = Number(record.key);
  payload.name = `Pipeline ${record.key} revision ${record.revision}`;
  if (record.cover) {
    payload.images = {
      large: `https://lain.bgm.tv/pic/cover/l/ab/cd/${record.key}.jpg`,
    };
  } else delete payload.images;
  return { source: 'bangumi', key: record.key, revision: String(record.revision), payload };
}

export type WriteSimulation = {
  limit: number;
  until?: number;
  status?: number;
  retryable?: boolean;
  http?: Pick<ImportTransportOptions, 'maxAttempts' | 'maxWaitMs' | 'maxTotalWaitMs' | 'deadlineMs'>;
  invocations?: { at: number; bytes: string; recordKey: string }[];
  onSend?(
    request: BatchWriteRequest,
    at: number,
  ): { status?: number; retryAfter?: string; delayMs?: number } | undefined;
  accepted: Map<string, number>;
  attempts: { at: number; inFlight: number; overloaded: boolean; keys: string[] }[];
};
export const createImportPipelineDriver: (
  options: Parameters<CreateImportPipelineDriver>[0] & { writes?: WriteSimulation },
) => ReturnType<CreateImportPipelineDriver> = async (factoryOptions) => {
  let options: PipelineOptions = { ...factoryOptions };
  const writes = factoryOptions.writes;
  let inFlightWrites = 0;
  const path = join(factoryOptions.directory, 'imports.sqlite');
  const receipts = new Map<string, Receipt>();
  const subjectKeys = new Set<string>();
  const proposalKeys = new Set<string>();
  const retractionKeys = new Set<string>();
  const subjects = new Map<string, string>();
  const jobs = new Map<string, Job>();
  const jobsById = new Map<string, Job>();
  const jobRecords = new Set<string>();
  const desiredMedia = new Map<string, 'available' | 'rejected' | 'pending'>();
  const coverFences = new Map<string, string>();
  const knownCovers = new Map<string, boolean>();
  let duplicateEffects = 0;
  let importer: Importer;
  let scheduler: Scheduler;
  let currentSignal: AbortSignal | undefined;
  let currentHook: ((exchange: Exchange) => void) | undefined;
  let interruptKey: string | undefined;
  let interrupted = false;
  let fault = options.fault;
  let exchanges: Exchange[] = [];
  let observed: PipelineReport['observed'] = [];
  let conversions: PipelineReport['conversions'] = [];
  let collectConversions = true;
  let acknowledgements: PipelineReport['acknowledgements'] = [];
  let sleeps: PipelineReport['sleeps'] = [];
  let acknowledgedKeys = new Set<string>();
  let active = new Map<string, { phase: Phase; count: number }>();
  let retained = new Map<string, number>();
  let peakRecords = 0;
  let peakByPhase: Record<Phase, number> = { staged: 0, vanished: 0, resumed: 0, media: 0 };
  let memory = { liveRecords: 0, liveBytes: 0, stagedPageRecords: 0 };

  const phase = (key: string, fallback: Phase): Phase => active.get(key)?.phase ?? fallback;
  const sampleMemory = () => {
    const keys = new Set([...retained.keys(), ...active.keys()]);
    const bytes =
      [...retained.values()].reduce((sum, value) => sum + value, 0) +
      [...active.keys()].filter((key) => !retained.has(key)).length * 65536;
    memory.liveRecords = Math.max(memory.liveRecords, keys.size);
    memory.liveBytes = Math.max(memory.liveBytes, bytes);
  };
  const exchangeHook = (exchange: Exchange) => currentHook?.(structuredClone(exchange));

  const fenceReply = (key: string, group: string) => {
    const revision = group === 'cover' ? coverFences.get(key) : undefined;
    return revision ? { fenced: true, securityRevision: revision } : { fenced: false, securityRevision: null };
  };

  const applyCommand = (command: BatchCommand, bytes: string): BatchWriteResult['results'][number] => {
    const prior = receipts.get(command.key);
    if (prior) {
      if (prior.bytes !== bytes) duplicateEffects++;
      return structuredClone(prior.result);
    }
    const owner = `${command.source.source}:${command.source.external_id}`;
    let result: BatchWriteResult['results'][number];
    if (command.op === 'create') {
      subjectKeys.add(command.key);
      const id = subjects.get(owner) ?? uuid(`subject:${owner}`);
      subjects.set(owner, id);
      result = { key: command.key, status: 201, value: { id, revision: 1 } };
    } else if (command.op === 'propose') {
      proposalKeys.add(command.key);
      result = {
        key: command.key,
        status: 201,
        value: { candidate: uuid(`candidate:${command.key}`), revision: 1 },
      };
    } else {
      retractionKeys.add(command.key);
      result = { key: command.key, status: 200, value: { revision: 1 } };
    }
    if (writes) writes.accepted.set(command.key, (writes.accepted.get(command.key) ?? 0) + 1);
    receipts.set(command.key, { bytes, result: structuredClone(result) });
    return result;
  };

  const transport = {
    readFence(tuple: { source: string; external_id: string; field_group: BatchCommand['source']['field_group'] }) {
      const key = tuple.external_id;
      return scheduler.request(
        {
          recordKey: key,
          phase: phase(key, 'staged'),
          kind: 'fence',
          fieldGroup: tuple.field_group,
          metadata: false,
          bytes: JSON.stringify(tuple),
          keys: [],
        },
        currentSignal,
        () => fenceReply(key, tuple.field_group),
      );
    },
    batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
      writes?.invocations?.push({
        at: scheduler.now,
        bytes: JSON.stringify(request),
        recordKey: request.commands[0]!.source.external_id,
      });
      return writes ? httpTransport.batch(request, currentSignal) : remoteBatch(request);
    },
  };

  const remoteBatch = (
    request: BatchWriteRequest,
    overloaded = false,
    reply?: { status?: number; retryAfter?: string; delayMs?: number },
  ): Promise<BatchWriteResult> => {
    const key = request.commands[0]!.source.external_id;
    const bytes = JSON.stringify(request);
    const bootstrap = request.commands.every((command) => command.op === 'create');
    const metadata =
      !bootstrap &&
      request.commands.some((command) => command.op === 'propose' && command.source.field_group !== 'cover');
    return scheduler.request(
      {
        recordKey: key,
        phase: phase(key, 'staged'),
        kind: 'bulk',
        metadata,
        bytes,
        keys: request.commands.map((command) => command.key),
        request: structuredClone(request),
      },
      currentSignal,
      () => {
        if (overloaded || reply?.status !== undefined)
          throw Response.json(
            {
              type: 'https://rezics.com/problems/transaction_retry_exhausted',
              title: 'Transaction retry exhausted',
              status: reply?.status ?? writes?.status ?? 503,
              code: 'transaction_retry_exhausted',
              retryable: writes?.retryable ?? true,
            },
            {
              status: reply?.status ?? writes?.status ?? 503,
              headers: reply?.retryAfter === undefined ? {} : { 'retry-after': reply.retryAfter },
            },
          );
        const inject = !bootstrap && fault?.recordKey === key;
        if (inject && fault?.response === 'bulk-error')
          return {
            results: request.commands.map((command) => ({
              key: command.key,
              status: 409,
              problem: { type: 'conflict', title: 'Fixture rejection', status: 409 },
            })),
          };
        const results = request.commands.map((command) => applyCommand(command, JSON.stringify(command)));
        if (inject && fault?.response === 'invalid-response')
          return { results: [{ key: 'invalid', status: 200, value: { revision: 1 } }] } as BatchWriteResult;
        return { results };
      },
      reply?.delayMs,
    );
  };
  const httpTransport = createImportTransport({
    origin: 'https://api.example.test',
    tokenProvider: async (_fresh?: boolean) => 'fixture',
    ...writes?.http,
    now: () => scheduler.now,
    schedule: (callback, ms) => scheduler.timer(callback, ms),
    sleep: (ms) => scheduler.sleep(ms, currentSignal ?? new AbortController().signal),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = (await request.json()) as BatchWriteRequest;
      const count = ++inFlightWrites;
      const reply = writes!.onSend?.(body, scheduler.now);
      const overloaded = count > writes!.limit && scheduler.now < (writes!.until ?? Infinity);
      writes!.attempts.push({
        at: scheduler.now,
        inFlight: count,
        overloaded,
        keys: body.commands.map((command) => command.key),
      });
      try {
        return Response.json(await remoteBatch(body, overloaded, reply));
      } catch (error) {
        if (error instanceof Response) return error;
        throw error;
      } finally {
        inFlightWrites--;
      }
    }) as typeof fetch,
  });

  const makeImporter = () => {
    const importerOptions: ImporterOptions = {
      path,
      transport,
      instrumentDatabase: countWork,
      ...(options.recordConcurrency === undefined ? {} : { recordConcurrency: options.recordConcurrency }),
      ...(options.mediaDeadlineMs === undefined ? {} : { mediaDeadlineMs: options.mediaDeadlineMs }),
      now: () => scheduler.now,
      sleep: (ms, signal) => scheduler.sleep(ms, signal),
      onConversionOutput(output) {
        if (!collectConversions) return;
        conversions.push({
          recordKey: output.external_id,
          output: structuredClone(output),
        });
      },
      afterBulkSuccess(request) {
        const key = request.commands[0]?.source.external_id;
        const bootstrap = request.commands.every((command) => command.op === 'create');
        if (!interrupted && interruptKey === key && !bootstrap) {
          interrupted = true;
          throw new Error('Injected interruption');
        }
      },
      observer: {
        onRecordActive(recordPhase, recordKey, isActive) {
          const prior = active.get(recordKey);
          if (isActive) active.set(recordKey, { phase: recordPhase, count: (prior?.count ?? 0) + 1 });
          else if (prior && prior.count > 1) active.set(recordKey, { ...prior, count: prior.count - 1 });
          else active.delete(recordKey);
          peakRecords = Math.max(peakRecords, active.size);
          for (const value of Object.keys(peakByPhase) as Phase[]) {
            const count = [...active.values()].filter((entry) => entry.phase === value).length;
            peakByPhase[value] = Math.max(peakByPhase[value], count);
          }
          sampleMemory();
        },
        onPageRetained(recordPhase, rows) {
          retained = new Map(rows.map((row) => [row.recordKey, row.bytes]));
          if (recordPhase === 'staged') memory.stagedPageRecords = Math.max(memory.stagedPageRecords, rows.length);
          sampleMemory();
        },
        onAcknowledged(recordKey) {
          if (!acknowledgedKeys.has(recordKey)) {
            acknowledgedKeys.add(recordKey);
            acknowledgements.push({ recordKey, at: scheduler.now });
          }
        },
      },
    };
    importer = new Importer(importerOptions);
    importer.session.store.database.exec('PRAGMA synchronous=OFF');
    const resolver = createMediaResolver({
      bindings: importer.session.bindings,
      port: {
        readFence(tuple, signal) {
          const key = tuple.externalId;
          return scheduler.request(
            {
              recordKey: key,
              phase: phase(key, 'media'),
              kind: 'fence',
              fieldGroup: 'cover',
              metadata: false,
              bytes: JSON.stringify(tuple),
              keys: [],
            },
            signal,
            () => fenceReply(key, 'cover'),
          );
        },
        importFromUrl(bytes, key, signal) {
          const request = JSON.parse(bytes) as MediaImportRequest;
          const recordKey = request.provenance.external_id;
          return scheduler.request(
            {
              recordKey,
              phase: phase(recordKey, 'staged'),
              kind: 'media-post',
              metadata: false,
              bytes,
              keys: [key],
            },
            signal,
            () => {
              let job = jobs.get(key);
              if (!job) {
                const accepted: MediaImportAccepted = {
                  media: {
                    id: uuid(`media:${key}`),
                    containerId: request.containerId,
                    purpose: 'cover',
                    state: 'reserved',
                  },
                };
                job = { key, bytes, request, accepted, submittedAt: scheduler.now };
                jobs.set(key, job);
                jobsById.set(accepted.media.id, job);
                jobRecords.add(recordKey);
              } else if (job.bytes !== bytes) duplicateEffects++;
              return { status: 202, body: structuredClone(job.accepted) };
            },
          );
        },
        importStatus(id, signal) {
          const job = jobsById.get(id);
          if (!job) throw new Error('Unknown media job');
          const recordKey = job.request.provenance.external_id;
          return scheduler.request(
            {
              recordKey,
              phase: phase(recordKey, 'media'),
              kind: 'media-status',
              metadata: false,
              bytes: id,
              keys: [],
            },
            signal,
            () => {
              const mode = options.media ?? 'available';
              const desired = desiredMedia.get(recordKey);
              const state =
                desired === 'available'
                  ? 'available'
                  : desired === 'rejected'
                    ? 'rejected'
                    : desired === 'pending'
                      ? 'reserved'
                      : mode === 'available' || mode === 'cached'
                        ? 'available'
                        : mode === 'rejected'
                          ? 'rejected'
                          : typeof mode === 'object' && scheduler.now >= job.submittedAt + mode.after
                            ? 'available'
                            : 'reserved';
              return { status: 200, body: mediaStatus(job, state) };
            },
          );
        },
      },
      sleep: (ms, signal) => scheduler.sleep(ms, signal),
    });
    importerOptions.mediaResolver = {
      async resolve(input): Promise<ImportMediaResolution> {
        if (options.media === 'cached') {
          for (const supplied of input.mediaImportIntents) {
            const request = canonical(supplied) as MediaImportRequest;
            const signature = hash(JSON.stringify(request));
            const key = `${input.owner.source}:${input.owner.external_id}:${signature}`;
            if (!importer.session.bindings.mediaPending(input.owner, key)) {
              importer.session.bindings.prepareMedia(input.owner, key, signature, request);
              const accepted: MediaImportAccepted = {
                media: {
                  id: uuid(`media:${key}`),
                  containerId: input.subject,
                  purpose: 'cover',
                  state: 'reserved',
                },
              };
              importer.session.bindings.acceptMedia(input.owner, key, accepted);
              importer.session.bindings.observeMedia(
                input.owner,
                key,
                mediaStatus(
                  { key, bytes: JSON.stringify(request), request, accepted, submittedAt: scheduler.now },
                  'available',
                ),
              );
            }
          }
        }
        const result = await resolver.resolve({
          owner: input.owner,
          containerId: input.subject,
          mediaImportIntents: input.mediaImportIntents,
          signal: input.signal,
          deferPending: input.deferPending ?? false,
        });
        if (result.outcome === 'fenced') return { status: 'pending' };
        if (result.assets.some((asset) => asset.outcome === 'rejected')) return { status: 'rejected' };
        if (result.assets.some((asset) => asset.outcome === 'pending')) return { status: 'pending' };
        return { status: 'available', mediaIds: result.mediaIds };
      },
    };
  };

  const resetReport = (collect: boolean) => {
    exchanges = [];
    observed = [];
    conversions = [];
    collectConversions = collect;
    acknowledgements = [];
    sleeps = [];
    acknowledgedKeys = new Set();
    active = new Map();
    retained = new Map();
    peakRecords = 0;
    peakByPhase = { staged: 0, vanished: 0, resumed: 0, media: 0 };
    memory = { liveRecords: 0, liveBytes: 0, stagedPageRecords: 0 };
    scheduler = new Scheduler(
      options.completionOrder === 'reverse',
      options.latencyMs ?? 5,
      exchanges,
      exchangeHook,
      sleeps,
      writes ? 256 : 8,
    );
  };

  resetReport(true);
  makeImporter();

  return {
    async run(rows, runOptions = {}) {
      const collect = runOptions.collect !== false;
      resetReport(collect);
      currentSignal = runOptions.signal;
      currentHook = runOptions.onExchange;
      interruptKey = runOptions.interruptAfterSuccess;
      interrupted = false;
      fault = options.fault;
      for (const row of rows) knownCovers.set(row.key, !!row.cover);
      const start = scheduler.now;
      const sink = collect
        ? {
            onNew: (recordKey: string) => observed.push({ kind: 'new', recordKey }),
            onChanged: (recordKey: string) => observed.push({ kind: 'changed', recordKey }),
            onUnchanged: (recordKey: string) => observed.push({ kind: 'unchanged', recordKey }),
            onVanished: (recordKey: string) => observed.push({ kind: 'vanished', recordKey }),
          }
        : undefined;
      async function* input() {
        for (const row of rows) yield sourceRecord(row);
      }
      const result = await scheduler.drive(
        importer.runRecords(registration, input(), {
          collectionLimit: collect ? 10_000 : 0,
          ...(sink ? { sink } : {}),
          ...(runOptions.signal ? { signal: runOptions.signal } : {}),
          ...(runOptions.disappearanceThreshold === undefined
            ? {}
            : { disappearanceThreshold: runOptions.disappearanceThreshold }),
        }),
      );
      const recordKeys = [...new Set(rows.map((row) => row.key))].sort();
      const activeRun = importer.session.store.activeRun(registration.source);
      const coverProposed = new Set<string>();
      for (const exchange of exchanges) {
        if (exchange.kind !== 'bulk') continue;
        if (
          exchange.request?.commands.some(
            (command) => command.op === 'propose' && command.source.field_group === 'cover',
          )
        )
          coverProposed.add(exchange.recordKey);
      }
      const records = recordKeys.map((recordKey) => {
        const state = importer.session.store.key(registration.source, recordKey, activeRun ?? undefined);
        const rejected =
          jobRecords.has(recordKey) && (desiredMedia.get(recordKey) === 'rejected' || options.media === 'rejected');
        return {
          recordKey,
          acknowledged: state.acknowledged !== null,
          cover: !knownCovers.get(recordKey)
            ? ('none' as const)
            : coverProposed.has(recordKey)
              ? ('proposed' as const)
              : state.coverPending
                ? ('pending' as const)
                : coverFences.has(recordKey)
                  ? ('fenced' as const)
                  : rejected
                    ? ('rejected' as const)
                    : ('none' as const),
        };
      });
      currentHook = undefined;
      currentSignal = undefined;
      return {
        result,
        observed,
        conversions,
        exchanges,
        acknowledgements,
        records,
        elapsedMs: scheduler.now - start,
        sleeps,
        peakRecords,
        peakByPhase,
        activeRequestsAtEnd: scheduler.active,
        memory,
      };
    },
    setMedia(recordKey, state) {
      desiredMedia.set(recordKey, state);
    },
    setCoverFence(recordKey) {
      coverFences.set(recordKey, String(1000 + coverFences.size));
    },
    async reopen(next = {}) {
      await importer.close();
      options = { ...options, ...next };
      resetReport(true);
      makeImporter();
    },
    async effects() {
      return {
        subjects: subjectKeys.size,
        proposals: proposalKeys.size,
        retractions: retractionKeys.size,
        duplicateEffects,
      };
    },
    async close() {
      await importer.close();
    },
  };
};
