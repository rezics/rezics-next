import type { Database } from 'bun:sqlite';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import type { SourceId } from '@rezics/conversion';
import { createImporter, type Importer, type ImporterOptions } from './importer.ts';
import { createImportTransport } from './import-client.ts';
import { createReviewedCatalogueLookup } from './reviewed-catalogue.ts';
import { createMediaResolver } from './media-resolver.ts';
import { createSourceRegistration } from './source-registry.ts';
import {
  DEFAULT_DUMP_CHUNK_BYTES,
  DEFAULT_DUMP_RECORD_BYTES,
  MAX_DUMP_CHUNK_BYTES,
  observeDumpRetention,
} from './dumps-bytes.ts';
import { DEFAULT_VNDB_ARCHIVE_BYTES, type VndbTablesStore } from './vndb-tables.ts';
import { readArchive } from './archive.ts';
import { VndbInputError, VndbMaterialization } from './vndb-materialization.ts';
import type { ImportProgressObserver, SourceRegistration } from './import-contract.ts';
import type { ImportMediaResolution } from './importer.ts';
import type { Owner } from './record-bindings.ts';
import {
  createWritableProgressSink,
  ImportProgressReporter,
  type ImportProgressMode,
  type ImportProgressOutcome,
  type ImportProgressPhase,
  type ImportProgressSink,
} from './import-progress.ts';
import {
  createAccountTokenProvider,
  CredentialInputError,
  IMPORTER_SCOPES,
  VNDB_IMPORTER_SCOPES,
  type CredentialsObserver,
} from './credentials.ts';
import { runInspectCli } from './inspect-cli.ts';

const VALID_SOURCE = /^(?:bangumi|vndb|openlibrary|wikidata)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT = /^[A-Za-z0-9._~-]{1,255}$/;

type SourceKind = SourceId;
type RawVndbEntry = {
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'hardlink';
  declaredBytes: number;
  bytes: AsyncIterable<Uint8Array>;
  linkTarget?: string;
};

export type ImportCliObserver = {
  /** @deprecated Account-key reads are also reported here for older boundary observers. */
  onTokenRead?(path: string, bytes: number): void;
  onAccountKey?: CredentialsObserver['onAccountKey'];
  onDatabaseOpen?(path: string): void;
  onInputPass?(kind: 'dump' | 'vndb-entries'): void;
  onInputChunk?(kind: 'dump' | 'vndb-entries', bytes: number, backingBytes: number): void;
  onInputBuffer?(bytes: number): void;
  onPageRecords?(records: number): void;
  onCoordinator?(input: {
    importer: Importer;
    registration: SourceRegistration;
    state: string;
    converterModule: string;
    decoderModule: string;
  }): void;
  onVndbStore?(input: { importer: Importer; store: VndbTablesStore }): void;
};

export type ImportCliOptions = {
  stdin?: AsyncIterable<Uint8Array>;
  /** Raw VNDB archive members are injected at this external boundary in tests. */
  entries?: AsyncIterable<RawVndbEntry>;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  clock?: { now(): number; sleep(ms: number): Promise<void> };
  /** The sole HTTP exception is an exact loopback origin supplied by the test driver. */
  testOrigin?: string;
  instrumentDatabase?: (database: Database) => Database;
  observer?: ImportCliObserver;
  progressSink?: ImportProgressSink;
  progressTty?: boolean;
  /** Observe construction while retaining the real coordinator and its durable stores. */
  createImporter?: typeof createImporter;
};

export type ImportCliResult = {
  code: number;
  stdout: string;
  stderr: string;
  openHandles: number;
};

type Config = {
  source: SourceKind;
  dump: string;
  state: string;
  api: string;
  accountKey: string;
  account: string;
  client: string;
  auth: string;
  sourceAlias?: string;
  disappearanceThreshold?: number;
  progressMode?: ImportProgressMode;
};

class InputFailure extends Error {}

function usage(): string {
  return [
    'Usage: rezics-import --source <bangumi|vndb|openlibrary|wikidata> --dump <path|-> --state <sqlite-path>',
    '       --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>',
    '       [--source-alias <name>] [--disappearance-threshold <0..1>] [--progress <human|jsonl>]',
    'Options: --source --dump --state --api --account-key --account --client --auth --source-alias --disappearance-threshold --progress --help',
  ].join('\n');
}

function parse(argv: readonly string[]): Config | 'help' {
  if (!Array.isArray(argv) || argv.length > 64) throw new InputFailure();
  let totalBytes = 0;
  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.length > 4096 || argument.includes('\0')) throw new InputFailure();
    totalBytes += Buffer.byteLength(argument);
    if (totalBytes > 16384) throw new InputFailure();
  }
  if (argv.length === 1 && argv[0] === '--help') return 'help';

  const values = new Map<string, string>();
  const valueFlags = new Set([
    '--source',
    '--dump',
    '--state',
    '--api',
    '--account-key',
    '--account',
    '--client',
    '--auth',
    '--source-alias',
    '--disappearance-threshold',
    '--progress',
  ]);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (!valueFlags.has(flag) || values.has(flag)) throw new InputFailure();
    const value = argv[++index];
    if (value === undefined || valueFlags.has(value) || value === '--help' || value.length === 0)
      throw new InputFailure();
    values.set(flag, value);
  }

  const source = values.get('--source');
  const dump = values.get('--dump');
  const state = values.get('--state');
  const api = values.get('--api');
  const accountKey = values.get('--account-key');
  const account = values.get('--account');
  const client = values.get('--client');
  const auth = values.get('--auth');
  if (
    !source ||
    !VALID_SOURCE.test(source) ||
    !dump ||
    !state ||
    !api ||
    !accountKey ||
    !account ||
    !UUID.test(account) ||
    !client ||
    !CLIENT.test(client) ||
    !auth
  )
    throw new InputFailure();
  if (dump !== '-' && !dump.trim()) throw new InputFailure();
  if (!state.trim() || state === '-') throw new InputFailure();
  if (!accountKey.trim()) throw new InputFailure();

  const result: Config = {
    source: source as SourceKind,
    dump,
    state,
    api,
    accountKey,
    account,
    client,
    auth,
  };
  const progressMode = values.get('--progress');
  if (progressMode !== undefined) {
    if (progressMode !== 'human' && progressMode !== 'jsonl') throw new InputFailure();
    result.progressMode = progressMode;
  }
  const sourceAlias = values.get('--source-alias');
  if (sourceAlias !== undefined) result.sourceAlias = sourceAlias;
  const threshold = values.get('--disappearance-threshold');
  if (threshold !== undefined) {
    if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(threshold)) throw new InputFailure();
    const parsed = Number(threshold);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new InputFailure();
    result.disappearanceThreshold = parsed;
  }
  return result;
}

function parseOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InputFailure();
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.hostname)
    throw new InputFailure();
  return url;
}

function validateOrigin(api: string, testOrigin?: string): string {
  const url = parseOrigin(api);
  if (testOrigin === undefined) {
    if (url.protocol !== 'https:') throw new InputFailure();
  } else {
    const test = parseOrigin(testOrigin);
    if (
      test.protocol !== 'http:' ||
      test.hostname !== '127.0.0.1' ||
      test.origin !== testOrigin ||
      url.origin !== test.origin
    )
      throw new InputFailure();
  }
  return url.origin;
}

async function openDump(path: string, handleCount: { value: number }): Promise<FileHandle | undefined> {
  if (path === '-') return undefined;
  let handle: FileHandle;
  try {
    // Reach the descriptor check even for a FIFO with no writer; regular-file reads are unchanged.
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    throw new InputFailure();
  }
  handleCount.value++;
  try {
    if (!(await handle.stat()).isFile()) throw new InputFailure();
    return handle;
  } catch (error) {
    try {
      await handle.close();
    } finally {
      handleCount.value--;
    }
    if (error instanceof InputFailure) throw error;
    throw new InputFailure();
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('Import interrupted', 'AbortError');
}

async function clockSleep(
  clock: NonNullable<ImportCliOptions['clock']>,
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', aborted);
    const aborted = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('Import interrupted', 'AbortError'));
    };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve()
      .then(() => {
        throwIfAborted(signal);
        return clock.sleep(ms);
      })
      .then(
        () => {
          cleanup();
          resolve();
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
  });
}

function inputWithSignal<T>(operation: () => T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', aborted);
    const aborted = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new DOMException('Import interrupted', 'AbortError'));
    };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve()
      .then(() => {
        throwIfAborted(signal);
        return operation();
      })
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
  });
}

async function closeInput<T>(iterator: AsyncIterator<T>, signal: AbortSignal, localFile = false): Promise<void> {
  try {
    // The owning finally requests cleanup exactly once. Source cleanup may be
    // queued behind a pending next(), or reject after this invocation finishes.
    const closing = Promise.resolve(iterator.return?.());
    void closing.catch(() => {});
    if (localFile) await closing;
    else if (!signal.aborted) await inputWithSignal(() => closing, signal);
  } catch {
    // Preserve the original parser, staging or cancellation failure.
  }
}

async function* fileChunks(handle: FileHandle, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  let position = 0;
  for (;;) {
    throwIfAborted(signal);
    const buffer = new Uint8Array(DEFAULT_DUMP_CHUNK_BYTES);
    let result: { bytesRead: number };
    try {
      result = await handle.read(buffer, 0, buffer.byteLength, position);
    } catch {
      throw new InputFailure();
    }
    throwIfAborted(signal);
    if (!result.bytesRead) return;
    position += result.bytesRead;
    yield buffer.subarray(0, result.bytesRead);
  }
}

async function* ownedChunks(
  input: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  kind: 'dump',
  observer: ImportCliObserver | undefined,
  localFile = false,
  progress?: ImportProgressReporter,
): AsyncGenerator<Uint8Array> {
  observer?.onInputPass?.(kind);
  const iterator = input[Symbol.asyncIterator]();
  let ended = false;
  try {
    for (;;) {
      // Owned descriptor reads settle before the descriptor is closed. Only
      // source-controlled operations may be left pending after cancellation.
      const next = localFile ? await iterator.next() : await inputWithSignal(() => iterator.next(), signal);
      if (next.done) {
        ended = true;
        return;
      }
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array) || chunk.buffer.byteLength > MAX_DUMP_CHUNK_BYTES) throw new InputFailure();
      if (!chunk.byteLength) continue;
      for (let offset = 0; offset < chunk.byteLength; offset += DEFAULT_DUMP_CHUNK_BYTES) {
        const size = Math.min(DEFAULT_DUMP_CHUNK_BYTES, chunk.byteLength - offset);
        const owned = new Uint8Array(size);
        owned.set(chunk.subarray(offset, offset + size));
        observer?.onInputChunk?.(kind, size, owned.buffer.byteLength);
        progress?.add('inputBytes', size);
        yield owned;
      }
    }
  } finally {
    if (!ended) await closeInput(iterator, signal, localFile);
  }
}

/** Carry Open Library's native TSV modification date into its JSON record. */
async function* openLibraryMetadata(input: AsyncIterable<Uint8Array>, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const lineLimit = DEFAULT_DUMP_RECORD_BYTES + 1;
  let line = new Uint8Array(0);
  let length = 0;

  const append = (bytes: Uint8Array) => {
    const required = length + bytes.byteLength;
    if (required > lineLimit) throw new InputFailure();
    if (required > line.byteLength) {
      const capacity = Math.min(lineLimit, Math.max(required, line.byteLength ? line.byteLength * 2 : 64));
      const next = new Uint8Array(capacity);
      next.set(line.subarray(0, length));
      line = next;
    }
    line.set(bytes, length);
    length = required;
  };

  const metadataLine = (raw: Uint8Array): Uint8Array => {
    let text: string;
    try {
      text = decoder.decode(raw);
    } catch {
      return raw;
    }
    const first = text.indexOf('\t');
    const second = first < 0 ? -1 : text.indexOf('\t', first + 1);
    const third = second < 0 ? -1 : text.indexOf('\t', second + 1);
    const fourth = third < 0 ? -1 : text.indexOf('\t', third + 1);
    if (first < 0 || second < 0 || third < 0 || fourth < 0 || text.indexOf('\t', fourth + 1) >= 0) return raw;
    const date = text.slice(third + 1, fourth);
    const stamp = /^\d{4}-\d{2}-\d{2}$/u.test(date)
      ? `${date}T00:00:00Z`
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z?$/u.test(date)
        ? date
        : undefined;
    if (!stamp) return raw;
    const json = text.slice(fourth + 1);
    let payload: unknown;
    try {
      payload = JSON.parse(json);
    } catch {
      return raw;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.hasOwn(payload, 'last_modified'))
      return raw;
    let close = json.length - 1;
    while (close >= 0 && /\s/u.test(json[close]!)) close--;
    if (json[close] !== '}') return raw;
    const addition = `,"last_modified":{"type":"/type/datetime","value":${JSON.stringify(stamp)}}`;
    return encoder.encode(`${text.slice(0, fourth + 1)}${json.slice(0, close)}${addition}${json.slice(close)}`);
  };

  const emit = async function* (raw: Uint8Array): AsyncGenerator<Uint8Array> {
    const transformed = metadataLine(raw);
    for (let offset = 0; offset < transformed.byteLength; offset += DEFAULT_DUMP_CHUNK_BYTES) {
      throwIfAborted(signal);
      const size = Math.min(DEFAULT_DUMP_CHUNK_BYTES, transformed.byteLength - offset);
      const chunk = new Uint8Array(size);
      chunk.set(transformed.subarray(offset, offset + size));
      yield chunk;
    }
  };

  try {
    for await (const chunk of input) {
      throwIfAborted(signal);
      let start = 0;
      for (let offset = 0; offset < chunk.byteLength; offset++) {
        if (chunk[offset] !== 10) continue;
        append(chunk.subarray(start, offset));
        yield* emit(line.subarray(0, length));
        const newline = new Uint8Array([10]);
        yield newline;
        length = 0;
        start = offset + 1;
      }
      append(chunk.subarray(start));
    }
    if (length) yield* emit(line.subarray(0, length));
  } finally {
    line = new Uint8Array(0);
    length = 0;
  }
}

async function* observedEntries(
  input: AsyncIterable<RawVndbEntry>,
  signal: AbortSignal,
  observer: ImportCliObserver | undefined,
  progress?: ImportProgressReporter,
): AsyncGenerator<RawVndbEntry> {
  observer?.onInputPass?.('vndb-entries');
  const iterator = input[Symbol.asyncIterator]();
  let ended = false;
  try {
    for (;;) {
      const next = await inputWithSignal(() => iterator.next(), signal);
      if (next.done) {
        ended = true;
        return;
      }
      const entry = next.value;
      const byteIterator = entry.bytes[Symbol.asyncIterator]();
      const bytes = (async function* (): AsyncGenerator<Uint8Array> {
        let byteEnded = false;
        try {
          for (;;) {
            const item = await inputWithSignal(() => byteIterator.next(), signal);
            if (item.done) {
              byteEnded = true;
              return;
            }
            const chunk = item.value;
            if (!(chunk instanceof Uint8Array)) throw new InputFailure();
            observer?.onInputChunk?.('vndb-entries', chunk.byteLength, chunk.buffer.byteLength);
            progress?.add('inputBytes', chunk.byteLength);
            yield chunk;
          }
        } finally {
          if (!byteEnded) await closeInput(byteIterator, signal);
        }
      })();
      yield { ...entry, bytes };
    }
  } finally {
    if (!ended) await closeInput(iterator, signal);
  }
}

function converterModule(source: SourceKind): string {
  const modules: Record<SourceKind, string> = {
    bangumi: '@rezics/conversion/bangumi',
    vndb: '@rezics/conversion/vndb',
    openlibrary: '@rezics/conversion/open-library',
    wikidata: '@rezics/conversion/wikidata',
  };
  return import.meta.resolve(modules[source]);
}

function diagnostic(
  message: string,
  counts?: { new: number; changed: number; unchanged: number; vanished: number },
  skipped = 0,
) {
  const summary = counts
    ? `\nnew=${counts.new} changed=${counts.changed} unchanged=${counts.unchanged} vanished=${counts.vanished} skipped=${skipped}`
    : `\nskipped=${skipped}`;
  return `${message}${summary}\n`;
}

/** Parse and run one real importer acquisition without import-time work. */
export async function runImportCli(argv: readonly string[], options: ImportCliOptions = {}): Promise<ImportCliResult> {
  if (Array.isArray(argv) && argv[0] === 'inspect')
    return runInspectCli(argv.slice(1), options.signal ? { signal: options.signal } : {});

  let config: Config;
  try {
    const parsed = parse(argv);
    if (parsed === 'help') return { code: 0, stdout: `${usage()}\n`, stderr: '', openHandles: 0 };
    config = parsed;
    validateOrigin(config.api, options.testOrigin);
    const auth = parseOrigin(config.auth);
    if (auth.protocol !== 'https:') throw new InputFailure();
    config.auth = auth.origin;
  } catch {
    return { code: 2, stdout: '', stderr: diagnostic('Invalid importer arguments.'), openHandles: 0 };
  }

  let registration: SourceRegistration;
  try {
    registration = createSourceRegistration(config.source, { source: config.sourceAlias ?? config.source });
  } catch {
    return { code: 2, stdout: '', stderr: diagnostic('Invalid importer arguments.'), openHandles: 0 };
  }

  const externalSignal = options.signal ?? new AbortController().signal;
  const progressAbort = new AbortController();
  const signal = AbortSignal.any([externalSignal, progressAbort.signal]);
  const credentialLifetime = new AbortController();
  const handles = { value: 0 };
  let dumpHandle: FileHandle | undefined;
  let importer: Importer | undefined;
  let lastHttpStatus: number | undefined;
  const clock = options.clock ?? {
    now: () => Date.now(),
    sleep: async (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  const guardedFetch = (async (request: Request) => {
    const response = await (options.fetch ?? globalThis.fetch)(request);
    lastHttpStatus = response.status;
    return response;
  }) as unknown as typeof fetch;
  let tokenProvider: Awaited<ReturnType<typeof createAccountTokenProvider>>;
  try {
    dumpHandle = await openDump(config.dump, handles);
    tokenProvider = await createAccountTokenProvider({
      accountKeyPath: config.accountKey,
      account: config.account,
      client: config.client,
      authOrigin: config.auth,
      scopes:
        config.source === 'vndb'
          ? VNDB_IMPORTER_SCOPES
          : config.source === 'bangumi'
            ? [...IMPORTER_SCOPES, 'subject:read']
            : IMPORTER_SCOPES,
      fetch: guardedFetch,
      signal: AbortSignal.any([signal, credentialLifetime.signal]),
      now: () => clock.now(),
      observer: {
        onAccountKey(path, observation) {
          options.observer?.onTokenRead?.(path, observation.bytes);
          options.observer?.onAccountKey?.(path, observation);
        },
      },
    });
  } catch (error) {
    credentialLifetime.abort();
    if (dumpHandle) {
      try {
        await dumpHandle.close();
      } catch {
        // Preserve the bounded input diagnostic.
      }
      handles.value--;
    }
    return {
      code: 2,
      stdout: '',
      stderr: diagnostic(
        error instanceof CredentialInputError
          ? 'Input or account key is unavailable or invalid.'
          : 'Input is unavailable or invalid.',
      ),
      openHandles: 0,
    };
  }

  const importTransport = createImportTransport({
    origin: validateOrigin(config.api, options.testOrigin),
    tokenProvider,
    fetch: guardedFetch,
    now: () => clock.now(),
    sleep: (ms) => clock.sleep(ms),
  });
  const progress = config.progressMode
    ? new ImportProgressReporter({
        source: config.source,
        mode: config.progressMode,
        tty: options.progressTty ?? false,
        sink: options.progressSink ?? createWritableProgressSink(process.stderr),
        signal,
        onFailure: () => progressAbort.abort(new DOMException('Progress output failed', 'AbortError')),
      })
    : undefined;
  const progressCounters = {
    new: 'newRecords',
    changed: 'changedRecords',
    unchanged: 'unchangedRecords',
    vanished: 'vanishedRecords',
  } as const;
  const progressHooks: ImportProgressObserver | undefined = progress
    ? {
        onPhase: (phase) => progress.setPhase(phase),
        onRun: (run, resumed) => progress.setRun(run, resumed),
        onStaged: (count) => progress.add('stagedRecords', count),
        onSourceCompleted: () => progress.setSourceComplete(),
        onAcknowledgedEffects: (count) => progress.add('acknowledgedEffects', count),
        onClassified: (kind) => progress.add(progressCounters[kind]),
        onSkipped: (count) => progress.add('skippedRecords', count),
        onMedia: (outcome) => progress.add(outcome === 'deferred' ? 'deferredMedia' : 'rejectedMedia'),
      }
    : undefined;
  const inFlight = new Set<Promise<unknown>>();
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = Promise.resolve().then(operation);
    inFlight.add(pending);
    void pending.finally(() => inFlight.delete(pending)).catch(() => {});
    return pending;
  };
  const settleInFlight = async () => {
    while (inFlight.size) await Promise.allSettled([...inFlight]);
  };
  let fenceTail: Promise<void> = Promise.resolve();
  let fenceFailure: unknown;
  const readFence = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = fenceTail.then(async () => {
      if (fenceFailure !== undefined) throw fenceFailure;
      try {
        return await operation();
      } catch (error) {
        fenceFailure = error;
        throw error;
      }
    });
    fenceTail = result.then(
      () => undefined,
      () => undefined,
    );
    return track(() => result);
  };
  const signalTransport = {
    setSourceRecordMetadata: (input: Parameters<typeof importTransport.setSourceRecordMetadata>[0]) =>
      track(() => importTransport.setSourceRecordMetadata(input, signal)),
    batchWrite: (request: Parameters<typeof importTransport.batch>[0]) =>
      track(() => importTransport.batch(request, signal)),
    clearSourceStatistic: (input: Parameters<typeof importTransport.clearSourceStatistic>[0]) =>
      track(() => importTransport.clearSourceStatistic(input, signal)),
    writeSourceStatistic: (input: Parameters<NonNullable<typeof importTransport.writeSourceStatistic>>[0]) =>
      track(() => importTransport.writeSourceStatistic(input, signal)),
    readFence: (tuple: { source: string; external_id: string; field_group: 'facts' | 'summary' | 'cover' }) =>
      readFence(() =>
        importTransport.fence(
          { source: tuple.source, externalId: tuple.external_id, fieldGroup: tuple.field_group },
          signal,
        ),
      ),
  };

  const mediaPort = {
    readFence: (tuple: { source: string; externalId: string; fieldGroup: 'cover' }, mediaSignal: AbortSignal) =>
      readFence(() => importTransport.fence(tuple, mediaSignal)),
    importFromUrl: (bytes: string, key: string, mediaSignal: AbortSignal) =>
      track(() => importTransport.requestMedia(bytes, key, mediaSignal)),
    importStatus: (id: string, mediaSignal: AbortSignal) => track(() => importTransport.mediaStatus(id, mediaSignal)),
  };

  let output: ImportCliResult = { code: 1, stdout: '', stderr: diagnostic('Import failed safely.'), openHandles: 0 };
  try {
    await progress?.setPhase('acquiring');
    options.observer?.onDatabaseOpen?.(config.state);
    const importerOptions: ImporterOptions = {
      path: config.state,
      transport: signalTransport,
      now: () => clock.now(),
      // Keep Importer's cancellable native timer unless a clock was explicitly supplied.
      ...(options.clock ? { sleep: (ms: number, sleepSignal: AbortSignal) => clockSleep(clock, ms, sleepSignal) } : {}),
      ...(options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {}),
    };
    importer = (options.createImporter ?? createImporter)(importerOptions);
    const media = createMediaResolver({
      bindings: importer.session.bindings,
      port: mediaPort,
      sleep: async (ms, mediaSignal) => {
        throwIfAborted(mediaSignal);
        await clock.sleep(ms);
        throwIfAborted(mediaSignal);
      },
      pollAttempts: 5,
      pollDelayMs: 1000,
    });
    const mediaAdapter = {
      async resolve(input: {
        owner: Owner;
        subject: string;
        mediaImportIntents: Parameters<typeof media.resolve>[0]['mediaImportIntents'];
        signal: AbortSignal;
      }): Promise<ImportMediaResolution> {
        const result = await media.resolve({
          owner: input.owner,
          containerId: input.subject,
          mediaImportIntents: input.mediaImportIntents,
          signal: input.signal,
        });
        if (result.outcome === 'fenced') return { status: 'pending' };
        if (result.assets.some((asset) => asset.outcome === 'rejected')) return { status: 'rejected' };
        if (result.assets.some((asset) => asset.outcome === 'pending')) return { status: 'pending' };
        return { status: 'available', mediaIds: result.mediaIds };
      },
    };
    // The resolver is wired after session construction so it uses the exact
    // production RecordBindings handle owned by this coordinator.
    importerOptions.mediaResolver = mediaAdapter;
    if (config.source === 'bangumi')
      importerOptions.identifierLookup = createReviewedCatalogueLookup(importer.session.bindings, importTransport);

    const decoderModule =
      config.source === 'vndb' ? import.meta.resolve('./vndb-tables.ts') : import.meta.resolve('./dumps.ts');
    if (config.source === 'vndb') {
      const materialization = new VndbMaterialization(importer, registration);
      options.observer?.onVndbStore?.({ importer, store: materialization.tables });
      const acquisition = materialization.begin();
      progress?.setSourceRun(acquisition);
      await progress?.setPhase('materializing');
      const entries =
        options.entries !== undefined
          ? observedEntries(options.entries, signal, options.observer, progress)
          : readArchive(
              ownedChunks(
                dumpHandle
                  ? fileChunks(dumpHandle, signal)
                  : (options.stdin ?? (process.stdin as AsyncIterable<Uint8Array>)),
                signal,
                'dump',
                options.observer,
                dumpHandle !== undefined,
                progress,
              ),
              {
                maxTotalBytes: DEFAULT_VNDB_ARCHIVE_BYTES,
                maxChunkBytes: DEFAULT_DUMP_CHUNK_BYTES,
                maxMetadataBytes: 4096,
                signal,
                onProgress: (sample) => options.observer?.onInputBuffer?.(sample.retainedBytes),
              },
            );
      // The table reader deliberately rejects an empty catalogue. A complete,
      // validated empty native archive still needs the ordinary loss-all guard
      // when this source already has a completed baseline. Observe only framing;
      // table/header validation remains with the existing table reader.
      let completeEmptyTables = false;
      const verifiedEntries = (async function* () {
        const required = new Set([
          'db/vn',
          'db/vn.header',
          'db/vn_titles',
          'db/vn_titles.header',
          'db/entry_meta',
          'db/entry_meta.header',
        ]);
        let empty = true;
        for await (const entry of entries) {
          if (required.has(entry.path)) {
            required.delete(entry.path);
            if (!entry.path.endsWith('.header') && entry.declaredBytes !== 0) empty = false;
          }
          yield entry;
        }
        // Reaching EOF here also proves that stage consumed every preceding
        // member, including all validated headers and any ignored members.
        completeEmptyTables = empty && required.size === 0;
      })();
      let emptyCatalogue = false;
      try {
        await materialization.stage(
          acquisition,
          verifiedEntries as unknown as Parameters<VndbMaterialization['stage']>[1],
        );
      } catch (error) {
        if (
          !completeEmptyTables ||
          !(error instanceof VndbInputError) ||
          importer.session.store.source(registration.source).count === 0
        )
          throw error;
        emptyCatalogue = true;
      }
      options.observer?.onCoordinator?.({
        importer,
        registration,
        state: config.state,
        converterModule: converterModule(config.source),
        decoderModule,
      });
      const runOptions = {
        ...(config.disappearanceThreshold === undefined
          ? {}
          : { disappearanceThreshold: config.disappearanceThreshold }),
        signal,
        ...(progressHooks ? { progress: progressHooks } : {}),
      };
      const run = emptyCatalogue
        ? await importer.runRecords(registration, (async function* () {})(), runOptions)
        : await materialization.commit(acquisition, {
            ...runOptions,
            onPageRecords: (count) => {
              options.observer?.onPageRecords?.(count);
              progress?.add('materializedRecords', count);
            },
          });
      output = resultFor(run, lastHttpStatus, signal);
    } else {
      const input = ownedChunks(
        dumpHandle ? fileChunks(dumpHandle, signal) : (options.stdin ?? (process.stdin as AsyncIterable<Uint8Array>)),
        signal,
        'dump',
        options.observer,
        dumpHandle !== undefined,
        progress,
      );
      const nativeInput = config.source === 'openlibrary' ? openLibraryMetadata(input, signal) : input;
      const restoreRetention = observeDumpRetention((sample) => options.observer?.onInputBuffer?.(sample.total));
      try {
        options.observer?.onCoordinator?.({
          importer,
          registration,
          state: config.state,
          converterModule: converterModule(config.source),
          decoderModule,
        });
        const run = await importer.runDump(registration, nativeInput, {
          ...(config.disappearanceThreshold === undefined
            ? {}
            : { disappearanceThreshold: config.disappearanceThreshold }),
          signal,
          ...(progressHooks ? { progress: progressHooks } : {}),
        });
        output = resultFor(run, lastHttpStatus, signal);
      } finally {
        restoreRetention();
      }
    }
  } catch (error) {
    const interrupted = signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
    output = {
      code: interrupted ? 130 : error instanceof InputFailure || error instanceof VndbInputError ? 2 : 1,
      stdout: '',
      stderr: diagnostic(
        interrupted ? 'Import interrupted; durable state is retained for resume.' : 'Import failed safely.',
      ),
      openHandles: 0,
    };
  } finally {
    credentialLifetime.abort();
    await settleInFlight();
    if (importer) {
      try {
        await importer.close();
      } catch {
        try {
          importer.session.close();
        } catch {
          // Preserve the primary status; the durable run remains available for recovery.
        }
      }
    }
    if (dumpHandle) {
      try {
        await dumpHandle.close();
      } catch {
        // The file is already bounded and no further bytes will be read.
      }
      handles.value--;
    }
    output.openHandles = handles.value;
  }
  if (progress) {
    const terminal = progressTerminal(output, signal);
    try {
      await progress.finish(terminal.phase, terminal.outcome);
    } catch {
      // The reporter exposes only a sanitized output-failure state to the CLI.
    }
    if (progress.outputFailed) {
      output = {
        code: 1,
        stdout: '',
        stderr: diagnostic('Progress output failed; import outcome is safely retained.'),
        openHandles: output.openHandles,
      };
    } else if (progress.outputIncomplete) {
      output.stderr += diagnostic('Progress output was cancelled before its terminal frame flushed.');
    }
  }
  return output;
}

function progressTerminal(
  output: ImportCliResult,
  signal: AbortSignal,
): { phase: ImportProgressPhase; outcome: ImportProgressOutcome } {
  if (signal.aborted || output.code === 130) return { phase: 'interrupted', outcome: 'interrupted' };
  if (output.code === 0) return { phase: 'committed', outcome: 'committed' };
  if (output.code === 2) return { phase: 'invalid-input', outcome: 'invalid-input' };
  if (output.code === 3) return { phase: 'mass-disappearance', outcome: 'mass-disappearance' };
  if (output.code === 4) return { phase: 'denied', outcome: 'denied' };
  if (output.code === 5) return { phase: 'busy', outcome: 'busy' };
  return { phase: 'failed', outcome: 'failed' };
}

function resultFor(
  run: Awaited<ReturnType<Importer['runRecords']>>,
  httpStatus: number | undefined,
  signal: AbortSignal,
): ImportCliResult {
  const counts = run.counts;
  const summary = `new=${counts.new} changed=${counts.changed} unchanged=${counts.unchanged} vanished=${counts.vanished} skipped=${run.skipped}`;
  if (run.status === 'committed')
    return { code: 0, stdout: `Import complete: ${summary}\n`, stderr: '', openHandles: 0 };
  if (run.status === 'invalid-dump')
    return {
      code: 2,
      stdout: '',
      stderr: diagnostic('Input is incomplete or invalid.', counts, run.skipped),
      openHandles: 0,
    };
  if (run.status === 'mass-disappearance')
    return {
      code: 3,
      stdout: '',
      stderr: diagnostic('Disappearance threshold exceeded.', counts, run.skipped),
      openHandles: 0,
    };
  if (run.status === 'busy')
    return {
      code: 5,
      stdout: '',
      stderr: diagnostic('This source already has an active import.', counts, run.skipped),
      openHandles: 0,
    };
  if (run.status === 'interrupted' || signal.aborted)
    return {
      code: 130,
      stdout: '',
      stderr: diagnostic('Import interrupted; durable state is retained for resume.', counts, run.skipped),
      openHandles: 0,
    };
  if (httpStatus === 401 || httpStatus === 403)
    return {
      code: 4,
      stdout: '',
      stderr: diagnostic('Import authorization was denied.', counts, run.skipped),
      openHandles: 0,
    };
  return {
    code: 1,
    stdout: '',
    stderr: diagnostic('Import failed; durable state is retained for resume.', counts, run.skipped),
    openHandles: 0,
  };
}

if (import.meta.main) {
  const controller = new AbortController();
  const interrupt = () => {
    if (!controller.signal.aborted) controller.abort(new DOMException('Interrupted', 'AbortError'));
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  void runImportCli(process.argv.slice(2), {
    stdin: process.stdin as AsyncIterable<Uint8Array>,
    signal: controller.signal,
    progressSink: createWritableProgressSink(process.stderr),
    progressTty: process.stderr.isTTY === true,
  })
    .then(
      (result) => {
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exitCode = result.code;
      },
      () => {
        process.stderr.write('Import failed safely.\n');
        process.exitCode = 1;
      },
    )
    .finally(() => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    });
}
