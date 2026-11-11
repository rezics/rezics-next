import { Database } from 'bun:sqlite';
import type { SourceVocabularyBindings } from '@rezics/conversion';
import { createBangumiPersonCareerAdmission, parseBangumiPersonCareerBindings } from './bangumi-person-careers.ts';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { type Importer, type ImporterOptions } from './importer.ts';
import { formatImportTransportError, ImportTransportError } from './import-client.ts';
import { createReviewedCatalogueLookup } from './reviewed-catalogue.ts';
import {
  composeBangumiImportIdentifierLookups,
  createShowcaseBangumiGameGenreLookup,
  parseBangumiGameGenreBindings,
  type BangumiGameGenreBindings,
} from './showcase-bangumi-game-genres.ts';
import { createMediaResolver } from './media-resolver.ts';
import { admittedSourceAdmissions } from './registration-contract.ts';
import { bindSourceRegistration, createSelectedFamilySourceRegistration } from './source-registry.ts';
import { DEFAULT_DUMP_CHUNK_BYTES, observeDumpRetention } from './dumps-bytes.ts';
import { DEFAULT_VNDB_ARCHIVE_BYTES, DEFAULT_VNDB_ARCHIVE_ENTRIES } from './vndb-tables.ts';
import {
  VNDB_ACQUISITION_MISSING_STATE,
  VNDB_ACQUISITION_UNSUPPORTED,
  VndbAcquisitionError,
  captureVndbIdentity,
  resumeVndbAcquisitionInvocation,
  vndbCodec,
  type VndbAcquisitionIdentity,
} from './vndb-acquisition.ts';
import { readArchive } from './archive.ts';
import { VndbInputError, VndbMaterialization } from './vndb-materialization.ts';
import type {
  ImportProgressObserver,
  ImportProgressPhase,
  SourceRegistration,
  StagingCaptureIdentity,
  StagingCheckpointRequest,
} from './import-contract.ts';
import type { ImportMediaResolution } from './importer.ts';
import type { Owner } from './record-bindings.ts';
import { createWritableProgressSink, ImportProgressReporter, type ImportProgressOutcome } from './import-progress.ts';
import { CredentialInputError, IMPORTER_SCOPES, VNDB_IMPORTER_SCOPES } from './credentials.ts';
import { diagnosticsUsage, runDiagnosticsCli } from './diagnostics-cli.ts';
import { captureComparisonUsage, runCaptureComparisonCli } from './capture-comparison-cli.ts';
import { disappearanceReviewUsage, runDisappearanceReviewCli } from './disappearance-review-cli.ts';
import { runBindingInspectionCli } from './binding-inspection-cli.ts';
import { runInspectCli } from './inspect-cli.ts';
import { resumeUsage, runResumeCli } from './resume-cli.ts';
import { observationsUsage, runObservationsCli } from './source-observation-cli.ts';
import { classificationsUsage, runClassificationsCli } from './source-classification-cli.ts';
import { runPreviewCli } from './preview-cli.ts';
import { runCompareCli } from './compare-cli.ts';
import { runBackupCli } from './backup-cli.ts';
import { batchUsage, runBatchCli } from './batch-cli.ts';
import { retentionUsage, runRetentionCli } from './retention-cli.ts';
import { DESTINATION_USAGE, runDestinationCli } from './source-destination-cli.ts';
import {
  SourceDestinationError,
  mismatchMessage,
  preflightSourceDestination,
  throwAdmissionRefusal,
  unboundMessage,
} from './source-destination.ts';
import { runStagingRetirementCli, stagingRetirementUsage } from './staging-retirement-cli.ts';
import { admitDumpCompression, decodeBudgetLimit, decodeDumpBytes } from './compressed-dump.ts';
import { DEFAULT_DECODED_ZSTD_BYTES, probeZstdExecutable, resolveZstdExecutable } from './zstd-input.ts';
import {
  DumpInputError,
  fileChunks,
  fingerprintDump,
  observedEntries,
  openDump,
  openLibraryMetadata,
  ownedChunks,
  throwIfAborted,
} from './dump-input.ts';
import { admitOpenLibraryDumpSet, OpenLibraryDumpSetError } from './open-library-dump-set.ts';
import { fingerprintOpenLibraryDumpSet, readOpenLibraryDumpSet } from './open-library-dump-set-records.ts';
import type { OpenLibraryDumpSetAdmission } from './open-library-dump-set.ts';
import {
  STAGING_MISSING_STATE,
  STAGING_UNSUPPORTED_INPUT,
  captureDumpSetIdentity,
  captureFileIdentity,
  captureIdentity,
} from './staging-checkpoint.ts';
import {
  admitImportCliConfig,
  importCliDiagnostic as diagnostic,
  importCliResult,
  importCliUsage,
  parseImportCliConfig,
  planImportCliArgv,
  type ImportCliClock,
  type ImportCliConfig,
  type ImportCliHelpTopic,
  type ImportCliOptions,
  type ImportCliResult,
  type ImportCliSourceKind,
  ImportCliInputFailure,
} from './cli-contract.ts';
import type { ImportCliHost } from './cli-host.ts';

const GAME_GENRE_BINDING_FILE_BYTES = 256 * 1024;

async function readBangumiBindings<T>(path: string, parse: (value: unknown) => T): Promise<T> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > GAME_GENRE_BINDING_FILE_BYTES)
      throw new TypeError('Invalid binding profile file');
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(8192, GAME_GENRE_BINDING_FILE_BYTES + 1 - size));
      const read = await handle.read(chunk, 0, chunk.length, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
      if (size > GAME_GENRE_BINDING_FILE_BYTES) throw new TypeError('Binding profile file exceeds its byte cap');
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
    return parse(JSON.parse(text) as unknown);
  } finally {
    await handle.close();
  }
}

async function clockSleep(clock: ImportCliClock, ms: number, signal: AbortSignal): Promise<void> {
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

function converterModule(source: ImportCliSourceKind): string {
  const modules: Record<ImportCliSourceKind, string> = {
    bangumi: '@rezics/conversion/bangumi',
    vndb: '@rezics/conversion/vndb',
    openlibrary: '@rezics/conversion/open-library',
    wikidata: '@rezics/conversion/wikidata',
  };
  return import.meta.resolve(modules[source]);
}

export type ImportCliApplication = {
  host: ImportCliHost;
  run(argv: readonly string[], options?: ImportCliOptions): Promise<ImportCliResult>;
  runSingleSource(argv: readonly string[], options?: ImportCliOptions): Promise<ImportCliResult>;
};

function helpResult(topic: ImportCliHelpTopic): ImportCliResult {
  const text =
    topic === 'import'
      ? importCliUsage()
      : topic === 'resume'
        ? resumeUsage()
        : topic === 'capture-comparison'
          ? captureComparisonUsage()
          : topic === 'disappearance-review'
            ? disappearanceReviewUsage()
            : topic === 'observations'
              ? observationsUsage()
              : topic === 'classifications'
                ? classificationsUsage()
                : topic === 'diagnostics'
                  ? diagnosticsUsage()
                  : topic === 'batch'
                    ? batchUsage()
                    : topic === 'destination'
                      ? DESTINATION_USAGE
                      : topic === 'retention'
                        ? retentionUsage()
                        : stagingRetirementUsage();
  return importCliResult(0, `${text}\n`, '');
}

/** Constructed single-source and command dispatch. Batch receives this application's executor. */
export function createImportCliApplication(host: ImportCliHost): ImportCliApplication {
  const runSingleSource = (argv: readonly string[], options: ImportCliOptions = {}) =>
    executeOrdinaryImport(argv, host.mergeInvocation(options), host);

  async function run(argv: readonly string[], options: ImportCliOptions = {}): Promise<ImportCliResult> {
    const bindings = host.mergeInvocation(options);
    const plan = planImportCliArgv(argv);
    if (plan.kind === 'help') return helpResult(plan.usage);
    if (plan.kind === 'ordinary') return runSingleSource(plan.argv, bindings);
    const sub = plan.argv;
    switch (plan.name) {
      case 'inspect-bindings':
        return runBindingInspectionCli(sub, {
          ...(bindings.signal ? { signal: bindings.signal } : {}),
          ...(bindings.instrumentDatabase ? { instrumentDatabase: bindings.instrumentDatabase } : {}),
        });
      case 'resume':
        return runResumeCli(sub, bindings);
      case 'inspect':
        return runInspectCli(sub, bindings.signal ? { signal: bindings.signal } : {});
      case 'capture-comparison':
        return runCaptureComparisonCli(sub, bindings.signal ? { signal: bindings.signal } : {});
      case 'disappearance-review':
        return runDisappearanceReviewCli(sub, {
          ...(bindings.signal ? { signal: bindings.signal } : {}),
          ...(bindings.instrumentDatabase ? { instrumentDatabase: bindings.instrumentDatabase } : {}),
        });
      case 'observations':
        return runObservationsCli(sub, {
          ...(bindings.signal ? { signal: bindings.signal } : {}),
          ...(bindings.fetch ? { fetch: bindings.fetch } : {}),
          ...(bindings.testOrigin ? { testOrigin: bindings.testOrigin } : {}),
          ...(bindings.instrumentDatabase ? { instrumentDatabase: bindings.instrumentDatabase } : {}),
        });
      case 'classifications':
        return runClassificationsCli(sub, {
          ...(bindings.signal ? { signal: bindings.signal } : {}),
          ...(bindings.fetch ? { fetch: bindings.fetch } : {}),
          ...(bindings.testOrigin ? { testOrigin: bindings.testOrigin } : {}),
          ...(bindings.instrumentDatabase ? { instrumentDatabase: bindings.instrumentDatabase } : {}),
        });
      case 'preview':
        return runPreviewCli(sub, {
          ...(bindings.stdin === undefined ? {} : { stdin: bindings.stdin }),
          ...(bindings.entries === undefined ? {} : { entries: bindings.entries }),
          ...(bindings.signal === undefined ? {} : { signal: bindings.signal }),
          ...(bindings.fetch === undefined ? {} : { fetch: bindings.fetch }),
        });
      case 'compare':
        return runCompareCli(sub, {
          ...(bindings.signal === undefined ? {} : { signal: bindings.signal }),
          ...(bindings.fetch === undefined ? {} : { fetch: bindings.fetch }),
        });
      case 'backup':
      case 'validate-snapshot':
      case 'restore':
        return runBackupCli(sub, bindings.signal ? { signal: bindings.signal } : {});
      case 'diagnostics':
        return runDiagnosticsCli(sub, {
          ...(bindings.signal ? { signal: bindings.signal } : {}),
          ...(bindings.instrumentDatabase ? { instrumentDatabase: bindings.instrumentDatabase } : {}),
          ...(bindings.observer?.onDatabaseOpen
            ? { observer: { onDatabaseOpen: bindings.observer.onDatabaseOpen } }
            : {}),
        });
      case 'batch':
        return runBatchCli(sub, bindings, { runSingleSource });
      case 'destination':
        return runDestinationCli(sub, {
          ...(bindings.signal ? { signal: bindings.signal } : {}),
          ...(bindings.testOrigin ? { testOrigin: bindings.testOrigin } : {}),
          ...(bindings.instrumentDatabase ? { instrumentDatabase: bindings.instrumentDatabase } : {}),
        });
      case 'retention':
        return runRetentionCli(sub, {
          ...(bindings.signal ? { signal: bindings.signal } : {}),
          ...(bindings.instrumentDatabase ? { instrumentDatabase: bindings.instrumentDatabase } : {}),
          ...(bindings.observer?.onDatabaseOpen || bindings.observer?.beforeRetentionPage
            ? {
                observer: {
                  ...(bindings.observer.onDatabaseOpen ? { onDatabaseOpen: bindings.observer.onDatabaseOpen } : {}),
                  ...(bindings.observer.beforeRetentionPage
                    ? { beforePage: bindings.observer.beforeRetentionPage }
                    : {}),
                },
              }
            : {}),
        });
      case 'retire-staging':
        return runStagingRetirementCli(sub, {
          ...(bindings.signal ? { signal: bindings.signal } : {}),
          ...(bindings.instrumentDatabase ? { instrumentDatabase: bindings.instrumentDatabase } : {}),
          ...(bindings.observer?.onDatabaseOpen || bindings.observer?.beforeRetentionPage
            ? {
                observer: {
                  ...(bindings.observer.onDatabaseOpen ? { onDatabaseOpen: bindings.observer.onDatabaseOpen } : {}),
                  ...(bindings.observer.beforeRetentionPage
                    ? { beforePage: bindings.observer.beforeRetentionPage }
                    : {}),
                },
              }
            : {}),
        });
    }
  }

  return { host, run, runSingleSource };
}

async function executeOrdinaryImport(
  argv: readonly string[],
  options: ImportCliOptions,
  host: ImportCliHost,
): Promise<ImportCliResult> {
  let config: ImportCliConfig;
  try {
    const parsed = parseImportCliConfig(argv);
    if (parsed === 'help') return importCliResult(0, `${importCliUsage()}\n`, '');
    config = admitImportCliConfig(parsed, options.testOrigin);
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

  let bangumiGameGenreBindings: BangumiGameGenreBindings | undefined;
  if (config.bangumiGameGenreBindings) {
    try {
      bangumiGameGenreBindings = await readBangumiBindings(
        config.bangumiGameGenreBindings,
        parseBangumiGameGenreBindings,
      );
    } catch {
      return {
        code: 2,
        stdout: '',
        stderr: diagnostic('Invalid Bangumi Game genre binding profile.'),
        openHandles: 0,
      };
    }
  }

  let bangumiPersonCareerBindings: SourceVocabularyBindings | undefined;
  if (config.bangumiPersonCareerBindings) {
    try {
      bangumiPersonCareerBindings = await readBangumiBindings(
        config.bangumiPersonCareerBindings,
        parseBangumiPersonCareerBindings,
      );
    } catch {
      return {
        code: 2,
        stdout: '',
        stderr: diagnostic('Invalid Bangumi Person career binding profile.'),
        openHandles: 0,
      };
    }
  }

  let registration: SourceRegistration;
  let zstdExecutable: string | undefined;
  try {
    const sourceAlias = config.sourceAlias ?? config.source;
    registration =
      config.source === 'bangumi' && sourceAlias === 'bangumi_cross_media'
        ? createSelectedFamilySourceRegistration('bangumi', sourceAlias)
        : bindSourceRegistration(admittedSourceAdmissions[config.source], { source: sourceAlias });
    admitDumpCompression(config.source, config.compression);
    if (config.compression === 'zstd') {
      zstdExecutable = await resolveZstdExecutable(config.zstdExecutable);
      await probeZstdExecutable(zstdExecutable);
    }
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
  let dumpSet: OpenLibraryDumpSetAdmission | undefined;
  let resumeSealedDumpSet = false;
  let importer: Importer | undefined;
  let lastHttpStatus: number | undefined;
  let capture: StagingCaptureIdentity | undefined;
  let vndbCapture: VndbAcquisitionIdentity | undefined;
  let tableAcquisitionId = config.acquisition;
  const clock = options.clock ?? host.clock;
  const guardedFetch = (async (request: Request) => {
    const response = await (options.fetch ?? host.fetch)(request);
    lastHttpStatus = response.status;
    return response;
  }) as unknown as typeof fetch;
  let tokenProvider: Awaited<ReturnType<ImportCliHost['createTokenProvider']>> | undefined;
  try {
    if (config.dumpSet) {
      try {
        dumpSet = await admitOpenLibraryDumpSet(
          config.dumpSet,
          { state: config.state, accountKey: config.accountKey },
          'openlibrary',
        );
      } catch (error) {
        if (
          config.mode === 'ordinary' &&
          error instanceof OpenLibraryDumpSetError &&
          error.reason === 'unavailable' &&
          sealedDumpSetResumePossible(config.state, config.sourceAlias ?? config.source)
        )
          resumeSealedDumpSet = true;
        else throw error;
      }
      if (dumpSet && config.mode !== 'ordinary') {
        const members = await fingerprintOpenLibraryDumpSet(dumpSet, {
          signal,
          handleCount: handles,
          ...(options.observer === undefined ? {} : { observer: options.observer }),
        });
        capture = captureDumpSetIdentity({
          members,
          sourceAlias: config.sourceAlias ?? config.source,
          converterRevision: registration.converter_revision,
          disappearanceThreshold: config.disappearanceThreshold ?? 0.2,
          decodeBudget: decodeBudgetLimit(config.decodeBudget),
          manifestVersion: dumpSet.version,
        });
      }
    } else {
      dumpHandle = await openDump(config.dump!, handles);
      if (config.mode !== 'ordinary') {
        if (!dumpHandle)
          throw new DumpInputError(
            config.mode === 'checkpoint-acquisition' || config.mode === 'resume-acquisition'
              ? VNDB_ACQUISITION_UNSUPPORTED
              : STAGING_UNSUPPORTED_INPUT,
            'checkpoint-unsupported',
          );
        const fingerprint = await fingerprintDump(dumpHandle, signal, options.observer);
        if (config.mode === 'checkpoint-acquisition' || config.mode === 'resume-acquisition') {
          vndbCapture = captureVndbIdentity({
            sha256: fingerprint.sha256,
            bytes: fingerprint.bytes,
            codec: vndbCodec(config.compression),
            sourceAlias: config.sourceAlias ?? config.source,
            converterRevision: registration.converter_revision,
            childCap: 64,
            maxRows: 2_000_000,
            maxSourceRecords: 500_000,
            maxArchiveBytes: DEFAULT_VNDB_ARCHIVE_BYTES,
            maxArchiveEntries: DEFAULT_VNDB_ARCHIVE_ENTRIES,
            decodeBudget: config.compression === 'zstd' ? (config.decodeBudget ?? DEFAULT_DECODED_ZSTD_BYTES) : 0,
          });
        } else {
          capture =
            config.compression === 'none'
              ? captureIdentity({
                  sha256: fingerprint.sha256,
                  bytes: fingerprint.bytes,
                  sourceAlias: config.sourceAlias ?? config.source,
                  sourceKind: config.source,
                  converterRevision: registration.converter_revision,
                  disappearanceThreshold: config.disappearanceThreshold ?? 0.2,
                })
              : captureFileIdentity({
                  sha256: fingerprint.sha256,
                  bytes: fingerprint.bytes,
                  sourceAlias: config.sourceAlias ?? config.source,
                  sourceKind: config.source,
                  converterRevision: registration.converter_revision,
                  disappearanceThreshold: config.disappearanceThreshold ?? 0.2,
                  compression: config.compression,
                  decodeBudget: decodeBudgetLimit(config.decodeBudget),
                });
        }
      }
    }
    if (config.mode === 'resume-staging' || config.mode === 'resume-acquisition') {
      let stateStat: Awaited<ReturnType<typeof lstat>>;
      try {
        stateStat = await lstat(config.state);
      } catch {
        throw new DumpInputError(
          config.mode === 'resume-acquisition' ? VNDB_ACQUISITION_MISSING_STATE : STAGING_MISSING_STATE,
        );
      }
      if (!stateStat.isFile())
        throw new DumpInputError(
          config.mode === 'resume-acquisition' ? VNDB_ACQUISITION_MISSING_STATE : STAGING_MISSING_STATE,
        );
    }
    const destinationSource = config.sourceAlias ?? config.source;
    const destinationPreflight = await preflightSourceDestination({
      statePath: config.state,
      source: destinationSource,
      origin: config.api,
      missingState: config.mode === 'resume-staging' || config.mode === 'resume-acquisition' ? 'error' : 'first-use',
    });
    if (destinationPreflight.status === 'mismatch')
      throw new SourceDestinationError(
        mismatchMessage(destinationSource, config.api, destinationPreflight.binding),
        'mismatch',
      );
    if (destinationPreflight.status === 'unbound')
      throw new SourceDestinationError(unboundMessage(destinationSource), 'unbound');
    if (destinationPreflight.status === 'unavailable')
      throw new SourceDestinationError(destinationPreflight.message, 'unavailable', destinationPreflight.exitCode);
    if (config.mode !== 'checkpoint-acquisition' && config.mode !== 'resume-acquisition') {
      tokenProvider = await host.createTokenProvider({
        accountKeyPath: config.accountKey,
        account: config.account,
        client: config.client,
        authOrigin: config.auth,
        scopes:
          config.source === 'vndb'
            ? [...VNDB_IMPORTER_SCOPES]
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
    }
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
      code: error instanceof SourceDestinationError ? error.exitCode : 2,
      stdout: '',
      stderr: diagnostic(
        error instanceof SourceDestinationError
          ? error.message
          : error instanceof CredentialInputError
            ? 'Input or account key is unavailable or invalid.'
            : error instanceof OpenLibraryDumpSetError
              ? error.message
              : error instanceof DumpInputError
                ? error.message
                : 'Input is unavailable or invalid.',
      ),
      openHandles: 0,
    };
  }

  let importTransport: ReturnType<ImportCliHost['createTransport']> | undefined;
  const connectTransport = async () => {
    if (importTransport) return importTransport;
    tokenProvider ??= await host.createTokenProvider({
      accountKeyPath: config.accountKey,
      account: config.account,
      client: config.client,
      authOrigin: config.auth,
      scopes:
        config.source === 'vndb'
          ? [...VNDB_IMPORTER_SCOPES]
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
    importTransport = host.createTransport({
      origin: config.api,
      tokenProvider,
      fetch: guardedFetch,
      now: () => clock.now(),
      sleep: (ms) => clock.sleep(ms),
    });
    return importTransport;
  };
  if (tokenProvider) await connectTransport();
  const liveTransport = () => {
    if (!importTransport) throw new Error('VNDB publication has not started');
    return importTransport;
  };
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
        onVerifiedPrefix: (count) => progress.add('verifiedPrefix', count),
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
    setSourceRecordMetadata: (
      input: Parameters<ReturnType<ImportCliHost['createTransport']>['setSourceRecordMetadata']>[0],
    ) => track(() => liveTransport().setSourceRecordMetadata(input, signal)),
    batchWrite: (request: Parameters<ReturnType<ImportCliHost['createTransport']>['batch']>[0]) =>
      track(async () => {
        const pages = await liveTransport().batches(request.commands, signal);
        return { results: pages.flatMap((page) => page.results) };
      }),
    clearSourceStatistic: (
      input: Parameters<ReturnType<ImportCliHost['createTransport']>['clearSourceStatistic']>[0],
    ) => track(() => liveTransport().clearSourceStatistic(input, signal)),
    writeSourceStatistic: (
      input: Parameters<NonNullable<ReturnType<ImportCliHost['createTransport']>['writeSourceStatistic']>>[0],
    ) => track(() => liveTransport().writeSourceStatistic(input, signal)),
    readSourceStatistics: (
      input: Parameters<ReturnType<ImportCliHost['createTransport']>['readSourceStatistics']>[0],
    ) => track(() => liveTransport().readSourceStatistics(input, signal)),
    readPublicFigure: (input: Parameters<ReturnType<ImportCliHost['createTransport']>['readPublicFigure']>[0]) =>
      track(() => liveTransport().readPublicFigure(input, signal)),
    readSourceClassifications: (
      input: Parameters<ReturnType<ImportCliHost['createTransport']>['readSourceClassifications']>[0],
    ) => track(() => liveTransport().readSourceClassifications(input, signal)),
    writeSourceClassification: (
      input: Parameters<ReturnType<ImportCliHost['createTransport']>['writeSourceClassification']>[0],
    ) => track(() => liveTransport().writeSourceClassification(input, signal)),
    clearSourceClassification: (
      input: Parameters<ReturnType<ImportCliHost['createTransport']>['clearSourceClassification']>[0],
    ) => track(() => liveTransport().clearSourceClassification(input, signal)),
    readFence: (tuple: { source: string; external_id: string; field_group: 'facts' | 'summary' | 'cover' }) =>
      readFence(() =>
        liveTransport().fence(
          { source: tuple.source, externalId: tuple.external_id, fieldGroup: tuple.field_group },
          signal,
        ),
      ),
  };

  const mediaPort = {
    readFence: (tuple: { source: string; externalId: string; fieldGroup: 'cover' }, mediaSignal: AbortSignal) =>
      readFence(() => liveTransport().fence(tuple, mediaSignal)),
    importFromUrl: (bytes: string, key: string, mediaSignal: AbortSignal) =>
      track(() => liveTransport().requestMedia(bytes, key, mediaSignal)),
    importStatus: (id: string, mediaSignal: AbortSignal) => track(() => liveTransport().mediaStatus(id, mediaSignal)),
  };

  let output: ImportCliResult = { code: 1, stdout: '', stderr: diagnostic('Import failed safely.'), openHandles: 0 };
  try {
    await progress?.setPhase(vndbCapture ? 'verifying' : 'acquiring');
    if (capture) progress?.add('inputBytes', capture.bytes);
    if (vndbCapture) progress?.add('inputBytes', vndbCapture.bytes);
    options.observer?.onDatabaseOpen?.(config.state);
    const importerOptions: ImporterOptions = {
      path: config.state,
      transport: signalTransport,
      destination: { origin: config.api },
      now: () => clock.now(),
      // Keep Importer's cancellable native timer unless a clock was explicitly supplied.
      ...(host.explicitClock
        ? { sleep: (ms: number, sleepSignal: AbortSignal) => clockSleep(clock, ms, sleepSignal) }
        : {}),
      processIdentity: host.processIdentity,
      ...(options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {}),
      ...(config.mode === 'resume-staging' || config.mode === 'resume-acquisition' ? { create: false } : {}),
    };
    importer = (options.createImporter ?? host.createImporter)(importerOptions);
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
    if (config.source === 'bangumi') {
      if (bangumiPersonCareerBindings)
        importerOptions.vocabularyAdmission = createBangumiPersonCareerAdmission(
          bangumiPersonCareerBindings,
          liveTransport(),
        );
      const publicTagLookup = createReviewedCatalogueLookup(importer.session.bindings, liveTransport());
      importerOptions.identifierLookup = bangumiGameGenreBindings
        ? composeBangumiImportIdentifierLookups(
            publicTagLookup,
            createShowcaseBangumiGameGenreLookup(registration.source, bangumiGameGenreBindings, liveTransport()).lookup,
          )
        : publicTagLookup;
    }

    const decoderModule =
      config.source === 'vndb' ? import.meta.resolve('./vndb-tables.ts') : import.meta.resolve('./dumps.ts');
    if (config.source === 'vndb') {
      const materialization = new VndbMaterialization(importer, registration);
      options.observer?.onVndbStore?.({ importer, store: materialization.tables });
      const tracked = config.mode === 'checkpoint-acquisition' || config.mode === 'resume-acquisition';
      const admitted = tracked ? importer.session.admit(registration.source, config.api) : undefined;
      if (admitted && typeof admitted === 'object' && 'kind' in admitted)
        throwAdmissionRefusal(registration.source, config.api, admitted);
      const ownership = admitted === 'busy' ? 'busy' : admitted;
      if (ownership === 'busy') {
        output = {
          code: 5,
          stdout: '',
          stderr: diagnostic('This source already has an active import.'),
          openHandles: 0,
        };
      } else
        try {
          let acquisition: string;
          let publishOnly = false;
          if (config.mode === 'resume-acquisition') {
            if (!vndbCapture || !config.acquisition) throw new ImportCliInputFailure();
            const compatibility = materialization.resumeCompatibility(config.acquisition, vndbCapture);
            if (!compatibility.ok) throw new VndbAcquisitionError(compatibility.code, compatibility.message);
            acquisition = config.acquisition;
            publishOnly = compatibility.action === 'publish';
            progress?.setSourceRun(acquisition);
          } else if (config.mode === 'checkpoint-acquisition') {
            if (!vndbCapture) throw new ImportCliInputFailure();
            acquisition = materialization.beginCheckpointed(vndbCapture);
            tableAcquisitionId = acquisition;
            progress?.setSourceRun(acquisition);
          } else {
            acquisition = materialization.begin();
            progress?.setSourceRun(acquisition);
          }
          let emptyCatalogue = false;
          if (!publishOnly) {
            await progress?.setPhase(tracked ? 'loading' : 'materializing');
            const loadProgress = tracked ? undefined : progress;
            const entries =
              options.entries !== undefined
                ? observedEntries(options.entries, signal, options.observer, loadProgress)
                : readArchive(
                    decodeDumpBytes(
                      ownedChunks(
                        dumpHandle
                          ? fileChunks(dumpHandle, signal)
                          : (options.stdin ?? (process.stdin as AsyncIterable<Uint8Array>)),
                        signal,
                        'dump',
                        options.observer,
                        dumpHandle !== undefined,
                        loadProgress,
                      ),
                      {
                        compression: config.compression,
                        signal,
                        ...(config.decodeBudget === undefined ? {} : { decodeBudget: config.decodeBudget }),
                        ...(progress ? { progress } : {}),
                        observer: { onDecodedChunk: (_bytes, backing) => options.observer?.onInputBuffer?.(backing) },
                        ...(zstdExecutable === undefined ? {} : { zstdExecutable }),
                        zstdProbe: false,
                      },
                    ),
                    {
                      maxTotalBytes: DEFAULT_VNDB_ARCHIVE_BYTES,
                      maxChunkBytes: DEFAULT_DUMP_CHUNK_BYTES,
                      maxMetadataBytes: 4096,
                      signal,
                      onProgress: (sample) => options.observer?.onInputBuffer?.(sample.retainedBytes),
                    },
                  );
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
              completeEmptyTables = empty && required.size === 0;
            })();
            try {
              await materialization.stage(
                acquisition,
                verifiedEntries as unknown as Parameters<VndbMaterialization['stage']>[1],
                tracked && vndbCapture
                  ? {
                      identity: vndbCapture,
                      resume: config.mode === 'resume-acquisition',
                      onCommitted: (count) => progress?.add('verifiedPrefix', count),
                      onVerified: (count) => progress?.add('verifiedPrefix', count),
                    }
                  : undefined,
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
            if (tracked) await progress?.setPhase('validating');
          }
          options.observer?.onCoordinator?.({
            importer,
            registration,
            state: config.state,
            converterModule: converterModule(config.source),
            decoderModule,
          });
          await connectTransport();
          await progress?.setPhase(tracked ? 'publishing' : 'staging');
          const runOptions = {
            acquisitionMode: config.acquisitionMode,
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
          if (tracked && run.status === 'interrupted')
            output = {
              ...resultFor(run, lastHttpStatus, signal),
              stderr: diagnostic(
                `Import interrupted; last valid VNDB table checkpoint remains recoverable. Resume with --resume-acquisition --acquisition ${acquisition} and the original file.`,
              ),
            };
          else output = resultFor(run, lastHttpStatus, signal);
        } finally {
          if (ownership && importer.session.heldOwnership(registration.source) === ownership)
            importer.session.release(ownership);
        }
    } else if (dumpSet || resumeSealedDumpSet) {
      const restoreRetention = observeDumpRetention((sample) => options.observer?.onInputBuffer?.(sample.total));
      try {
        options.observer?.onCoordinator?.({
          importer,
          registration,
          state: config.state,
          converterModule: converterModule(config.source),
          decoderModule,
        });
        const stream = dumpSet
          ? readOpenLibraryDumpSet(dumpSet, {
              signal,
              handleCount: handles,
              ...(options.observer === undefined ? {} : { observer: options.observer }),
              ...(progress === undefined ? {} : { progress }),
              ...(config.decodeBudget === undefined ? {} : { decodeBudget: config.decodeBudget }),
            })
          : undefined;
        const records = stream ? (capture ? stream.frames : stream.records) : (async function* () {})();
        const run = await importer.runDumpSet(registration, records, {
          acquisitionMode: config.acquisitionMode,
          ...(config.disappearanceThreshold === undefined
            ? {}
            : { disappearanceThreshold: config.disappearanceThreshold }),
          signal,
          ...(progressHooks ? { progress: progressHooks } : {}),
          ...(checkpointRequest(config, capture) ? { checkpoint: checkpointRequest(config, capture)! } : {}),
        });
        output = resultFor(run, lastHttpStatus, signal);
      } finally {
        restoreRetention();
      }
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
          ...(zstdExecutable === undefined ? {} : { zstdExecutable }),
          zstdProbe: false,
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
          acquisitionMode: config.acquisitionMode,
          ...(config.disappearanceThreshold === undefined
            ? {}
            : { disappearanceThreshold: config.disappearanceThreshold }),
          signal,
          ...(config.source === 'bangumi' ? { bangumiPersonDetailRows: true } : {}),
          ...(progressHooks ? { progress: progressHooks } : {}),
          ...(checkpointRequest(config, capture) ? { checkpoint: checkpointRequest(config, capture)! } : {}),
        });
        output = resultFor(run, lastHttpStatus, signal);
      } finally {
        restoreRetention();
      }
    }
  } catch (error) {
    const interrupted = signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
    const missingState =
      (config.mode === 'resume-staging' || config.mode === 'resume-acquisition') &&
      error instanceof Error &&
      /unable to open database|SQLITE_CANTOPEN|no such file/i.test(error.message);
    output = {
      code: interrupted
        ? 130
        : error instanceof SourceDestinationError
          ? error.exitCode
          : error instanceof ImportCliInputFailure ||
              error instanceof VndbInputError ||
              error instanceof VndbAcquisitionError ||
              error instanceof DumpInputError ||
              missingState
            ? 2
            : 1,
      stdout: '',
      stderr: diagnostic(
        interrupted
          ? config.mode === 'checkpoint-acquisition' || config.mode === 'resume-acquisition'
            ? `Import interrupted; last valid VNDB table checkpoint remains recoverable and no native batch was sent.${tableAcquisitionId ? ` Next: ${resumeVndbAcquisitionInvocation(tableAcquisitionId)}` : ''}`
            : config.mode !== 'ordinary'
              ? 'Import interrupted; last valid staging checkpoint remains recoverable and no native batch was sent.'
              : 'Import interrupted; durable state is retained for resume.'
          : missingState
            ? config.mode === 'resume-acquisition'
              ? VNDB_ACQUISITION_MISSING_STATE
              : STAGING_MISSING_STATE
            : error instanceof SourceDestinationError ||
                error instanceof VndbAcquisitionError ||
                error instanceof OpenLibraryDumpSetError
              ? error.message
              : error instanceof DumpInputError
                ? error.message
                : error instanceof Error && error.message.startsWith('VNDB table staging failed')
                  ? error.message
                  : error instanceof ImportTransportError
                    ? formatImportTransportError(error)
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

function sealedDumpSetResumePossible(statePath: string, source: string): boolean {
  let database: Database | undefined;
  try {
    database = new Database(statePath, { readonly: true, create: false, strict: true });
    const row = database
      .query(
        `SELECT 1 AS found
         FROM run_sources AS s
         JOIN run_generations AS g ON g.source=s.source AND g.id=s.lease_run
         WHERE s.source=? AND s.lease_run IS NOT NULL AND g.status IN ('ready','finalizing')`,
      )
      .get(source) as { found: number } | null;
    return Boolean(row);
  } catch {
    return false;
  } finally {
    database?.close();
  }
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

function checkpointRequest(
  config: ImportCliConfig,
  capture: StagingCaptureIdentity | undefined,
): StagingCheckpointRequest | undefined {
  if (!capture || config.mode === 'ordinary') return undefined;
  return {
    action: config.mode === 'resume-staging' ? 'resume' : 'acquire',
    ...(config.generation ? { generation: config.generation } : {}),
    identity: capture,
  };
}

function resultFor(
  run: Awaited<ReturnType<Importer['runRecords']>>,
  httpStatus: number | undefined,
  signal: AbortSignal,
): ImportCliResult {
  const counts = run.counts;
  const summary = `new=${counts.new} changed=${counts.changed} unchanged=${counts.unchanged} vanished=${counts.vanished} skipped=${run.skipped}`;
  const prefix = run.committedPrefix !== undefined ? ` committedPrefix=${run.committedPrefix}` : '';
  if (run.status === 'committed')
    return { code: 0, stdout: `Import complete: ${summary}${prefix}\n`, stderr: '', openHandles: 0 };
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
      stderr: diagnostic(
        run.diagnostic.startsWith('Local importer history cleanup')
          ? run.diagnostic
          : 'This source already has an active import.',
        counts,
        run.skipped,
      ),
      openHandles: 0,
    };
  if (run.status === 'interrupted' || signal.aborted)
    return {
      code: 130,
      stdout: '',
      stderr: diagnostic(
        run.checkpointed && run.runId
          ? `Import interrupted; last valid staging checkpoint remains recoverable. Resume with --resume-staging --generation ${run.runId} and the original input.`
          : 'Import interrupted; durable state is retained for resume.',
        counts,
        run.skipped,
      ),
      openHandles: 0,
    };
  if (run.status === 'observation-conflict')
    return {
      code: 6,
      stdout: '',
      stderr: diagnostic(
        'Source observation requires explicit operator resolution. Use rezics-import observations or rezics-import classifications to inspect and resolve.',
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
