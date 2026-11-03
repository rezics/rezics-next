import type { Database } from 'bun:sqlite';
import type { FileHandle } from 'node:fs/promises';
import type { SourceId } from '@rezics/conversion';
import { createImporter, type Importer, type ImporterOptions } from './importer.ts';
import { createImportTransport } from './import-client.ts';
import { createReviewedCatalogueLookup } from './reviewed-catalogue.ts';
import { createMediaResolver } from './media-resolver.ts';
import { createSourceRegistration } from './source-registry.ts';
import { DEFAULT_DUMP_CHUNK_BYTES, observeDumpRetention } from './dumps-bytes.ts';
import { DEFAULT_VNDB_ARCHIVE_BYTES, type VndbTablesStore } from './vndb-tables.ts';
import { readArchive } from './archive.ts';
import { VndbInputError, VndbMaterialization } from './vndb-materialization.ts';
import type { ImportProgressObserver, ImportProgressPhase, SourceRegistration } from './import-contract.ts';
import type { ImportMediaResolution } from './importer.ts';
import type { Owner } from './record-bindings.ts';
import {
  createWritableProgressSink,
  ImportProgressReporter,
  type ImportProgressMode,
  type ImportProgressOutcome,
  type ImportProgressSink,
} from './import-progress.ts';
import {
  createAccountTokenProvider,
  CredentialInputError,
  IMPORTER_SCOPES,
  VNDB_IMPORTER_SCOPES,
  type CredentialsObserver,
} from './credentials.ts';
import { diagnosticsUsage, runDiagnosticsCli } from './diagnostics-cli.ts';
import { captureComparisonUsage, runCaptureComparisonCli } from './capture-comparison-cli.ts';
import { runInspectCli } from './inspect-cli.ts';
import { observationsUsage, runObservationsCli } from './source-observation-cli.ts';
import { runPreviewCli } from './preview-cli.ts';
import { runCompareCli } from './compare-cli.ts';
import { runBackupCli } from './backup-cli.ts';
import {
  admitDumpCompression,
  decodeDumpBytes,
  parseDumpCompression,
  type DumpCompression,
} from './compressed-dump.ts';
import {
  DumpInputError,
  fileChunks,
  observedEntries,
  openDump,
  openLibraryMetadata,
  ownedChunks,
  throwIfAborted,
  type RawVndbEntry,
} from './dump-input.ts';

const VALID_SOURCE = /^(?:bangumi|vndb|openlibrary|wikidata)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT = /^[A-Za-z0-9._~-]{1,255}$/;

type SourceKind = SourceId;

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
  compression: DumpCompression;
  decodeBudget?: number;
};

class InputFailure extends DumpInputError {}

function usage(): string {
  return [
    'Usage: rezics-import --source <bangumi|vndb|openlibrary|wikidata> --dump <path|-> --state <sqlite-path>',
    '       --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>',
    '       [--source-alias <name>] [--disappearance-threshold <0..1>] [--progress <human|jsonl>]',
    '       [--compression none|gzip] [--decode-budget <bytes>]',
    '       rezics-import diagnostics --source <bangumi|vndb|openlibrary|wikidata> --state <sqlite-path>',
    '       [--generation <id>] [--record <key>] [--limit <1..100>] [--cursor <token>] [--phase staging|application] [--format json|text]',
    '       rezics-import observations --state <sqlite-path> --source <configured-source-id> [--after <operation-id>] [--limit 1..20]',
    '       rezics-import observations --state <sqlite-path> --source <configured-source-id> --operation <operation-id>',
    '       rezics-import observations --state <sqlite-path> --source <configured-source-id> --operation <operation-id>',
    '       --resolve --reviewed-observation <64-hex> --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>',
    'Exit 6 means a source observation needs explicit resolution; it is not an authorization failure.',
    'Options: --source --dump --state --api --account-key --account --client --auth --source-alias --disappearance-threshold --progress --compression --decode-budget --help',
    'gzip is admitted only for Open Library and Wikidata streamed dumps. Default --compression none. A .gz suffix is not a source identity. --decode-budget is a gzip decoded-byte ceiling (default 256 GiB).',
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
    '--compression',
    '--decode-budget',
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
    compression: 'none',
  };
  const compression = values.get('--compression');
  if (compression !== undefined) result.compression = parseDumpCompression(compression);
  const decodeBudget = values.get('--decode-budget');
  if (decodeBudget !== undefined) {
    if (result.compression !== 'gzip') throw new InputFailure();
    if (!/^[1-9][0-9]{0,15}$/.test(decodeBudget)) throw new InputFailure();
    const parsedBudget = Number(decodeBudget);
    if (!Number.isSafeInteger(parsedBudget) || parsedBudget <= 0) throw new InputFailure();
    result.decodeBudget = parsedBudget;
  }
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
  if (Array.isArray(argv) && argv[0] === 'capture-comparison')
    return runCaptureComparisonCli(argv.slice(1), options.signal ? { signal: options.signal } : {});
  if (Array.isArray(argv) && argv.length === 2 && argv[0] === '--help' && argv[1] === 'capture-comparison')
    return { code: 0, stdout: `${captureComparisonUsage()}\n`, stderr: '', openHandles: 0 };
  if (Array.isArray(argv) && argv[0] === 'observations')
    return runObservationsCli(argv.slice(1), {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.testOrigin ? { testOrigin: options.testOrigin } : {}),
      ...(options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {}),
    });
  if (Array.isArray(argv) && argv.length === 2 && argv[0] === '--help' && argv[1] === 'observations')
    return { code: 0, stdout: `${observationsUsage()}\n`, stderr: '', openHandles: 0 };
  if (Array.isArray(argv) && argv[0] === 'preview')
    return runPreviewCli(argv.slice(1), {
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.entries === undefined ? {} : { entries: options.entries }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  if (Array.isArray(argv) && argv[0] === 'compare')
    return runCompareCli(argv.slice(1), {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  if (Array.isArray(argv) && (argv[0] === 'backup' || argv[0] === 'validate-snapshot' || argv[0] === 'restore'))
    return runBackupCli(argv, options.signal ? { signal: options.signal } : {});
  if (Array.isArray(argv) && argv[0] === 'diagnostics')
    return runDiagnosticsCli(argv.slice(1), {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {}),
      ...(options.observer?.onDatabaseOpen ? { observer: { onDatabaseOpen: options.observer.onDatabaseOpen } } : {}),
    });
  if (Array.isArray(argv) && argv.length === 2 && argv[0] === '--help' && argv[1] === 'diagnostics')
    return { code: 0, stdout: `${diagnosticsUsage()}\n`, stderr: '', openHandles: 0 };
  let config: Config;
  try {
    const parsed = parse(argv);
    if (parsed === 'help') return { code: 0, stdout: `${usage()}\n`, stderr: '', openHandles: 0 };
    config = parsed;
    validateOrigin(config.api, options.testOrigin);
    const auth = parseOrigin(config.auth);
    if (auth.protocol !== 'https:') throw new InputFailure();
    config.auth = auth.origin;
  } catch (error) {
    return {
      code: 2,
      stdout: '',
      stderr: diagnostic(
        error instanceof DumpInputError && error.identity !== 'invalid-input'
          ? error.message
          : 'Invalid importer arguments.',
      ),
      openHandles: 0,
    };
  }

  let registration: SourceRegistration;
  try {
    registration = createSourceRegistration(config.source, { source: config.sourceAlias ?? config.source });
    admitDumpCompression(config.source, config.compression);
  } catch (error) {
    return {
      code: 2,
      stdout: '',
      stderr: diagnostic(error instanceof DumpInputError ? error.message : 'Invalid importer arguments.'),
      openHandles: 0,
    };
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
          ? [...VNDB_IMPORTER_SCOPES, 'subject:read']
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
          : error instanceof DumpInputError
            ? error.message
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
    readSourceStatistics: (input: Parameters<typeof importTransport.readSourceStatistics>[0]) =>
      track(() => importTransport.readSourceStatistics(input, signal)),
    readPublicFigure: (input: Parameters<typeof importTransport.readPublicFigure>[0]) =>
      track(() => importTransport.readPublicFigure(input, signal)),
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
      const input = decodeDumpBytes(
        ownedChunks(
          dumpHandle ? fileChunks(dumpHandle, signal) : (options.stdin ?? (process.stdin as AsyncIterable<Uint8Array>)),
          signal,
          'dump',
          options.observer,
          dumpHandle !== undefined,
          progress,
        ),
        {
          compression: config.compression,
          signal,
          ...(config.decodeBudget === undefined ? {} : { decodeBudget: config.decodeBudget }),
          ...(progress ? { progress } : {}),
          observer: { onDecodedChunk: (_bytes, backing) => options.observer?.onInputBuffer?.(backing) },
        },
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
      code: interrupted
        ? 130
        : error instanceof InputFailure || error instanceof VndbInputError || error instanceof DumpInputError
          ? 2
          : 1,
      stdout: '',
      stderr: diagnostic(
        interrupted
          ? 'Import interrupted; durable state is retained for resume.'
          : error instanceof DumpInputError
            ? error.message
            : 'Import failed safely.',
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
  if (output.code === 6) return { phase: 'observation-conflict', outcome: 'observation-conflict' };
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
      stderr: diagnostic(run.diagnostic || 'Input is incomplete or invalid.', counts, run.skipped),
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
  if (run.status === 'observation-conflict')
    return {
      code: 6,
      stdout: '',
      stderr: diagnostic(
        'Source observation requires explicit operator resolution. Use rezics-import observations to inspect and resolve.',
        counts,
        run.skipped,
      ),
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
