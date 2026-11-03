import type { SourceId } from '@rezics/conversion';
import { createImporter, type Importer, type ImporterOptions, type ImportRunResult } from './importer.ts';
import { createImportTransport } from './import-client.ts';
import { createReviewedCatalogueLookup } from './reviewed-catalogue.ts';
import { createMediaResolver } from './media-resolver.ts';
import { createSourceRegistration } from './source-registry.ts';
import type {
  ImportProgressObserver,
  ImportProgressPhase,
  ImportTransport,
  SourceRegistration,
} from './import-contract.ts';
import type { ImportMediaResolution } from './importer.ts';
import type { Owner } from './record-bindings.ts';
import {
  createWritableProgressSink,
  ImportProgressReporter,
  type ImportProgressMode,
  type ImportProgressOutcome,
} from './import-progress.ts';
import {
  createAccountTokenProvider,
  CredentialInputError,
  IMPORTER_SCOPES,
  VNDB_IMPORTER_SCOPES,
} from './credentials.ts';
import { ImportSession } from './import-session.ts';
import { ResumeStateError } from './resume-state.ts';
import { throwIfAborted } from './dump-input.ts';
import type { ImportCliOptions, ImportCliResult } from './cli.ts';

const VALID_SOURCE = /^(?:bangumi|vndb|openlibrary|wikidata)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT = /^[A-Za-z0-9._~-]{1,255}$/;
const REJECTED = new Set([
  '--dump',
  '--dump-set',
  '--disappearance-threshold',
  '--checkpoint-staging',
  '--resume-staging',
  '--compression',
  '--decode-budget',
  '--generation',
]);

type SourceKind = SourceId;

export type ResumeCliConfig = {
  source: SourceKind;
  state: string;
  api: string;
  accountKey: string;
  account: string;
  client: string;
  auth: string;
  sourceAlias?: string;
  progressMode?: ImportProgressMode;
};

class ResumeArgumentError extends Error {
  constructor() {
    super('Invalid resume arguments');
    this.name = 'ResumeArgumentError';
  }
}

class ResumeActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResumeActivationError';
  }
}

export function resumeUsage(): string {
  return [
    'Usage: rezics-import resume --source <bangumi|vndb|openlibrary|wikidata> --state <sqlite-path>',
    '       --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>',
    '       [--source-alias <configured-source-id>] [--progress <human|jsonl>]',
    '       rezics-import resume --help',
    '',
    'Resume finishes an existing sealed generation without a dump, stdin, archive or materialization.',
    'It never begins, stages, seals, abandons or replaces a generation. Staging and no-active state',
    'are left untouched and do no catalogue or credential HTTP work.',
    '',
    'Built-in Wikidata registration:',
    '  bun services/importer/src/cli.ts resume --source wikidata --state /var/lib/rezics/importer.sqlite',
    '    --api https://api.rezics.example --account-key /run/secrets/rezics-importer-account.jwk',
    '    --account 6b147e8d-1762-4717-9a65-aeb435cb843e --client rezics-importer --auth https://auth.rezics.example',
    '',
    'Configured alias (exact durable identity, not a profile selector):',
    '  bun services/importer/src/cli.ts resume --source bangumi --source-alias community-bangumi',
    '    --state /var/lib/rezics/importer.sqlite --api https://api.rezics.example',
    '    --account-key /run/secrets/rezics-importer-account.jwk --account 6b147e8d-1762-4717-9a65-aeb435cb843e',
    '    --client rezics-importer --auth https://auth.rezics.example',
    '',
    'No active generation vs incomplete staging: both refuse to start and point at ordinary complete-input',
    'import or `rezics-import inspect`. They do not acquire a dump or execute inspect.',
    'Current-authority retry: invoke this command again with the same state after restoring grants;',
    'pending envelopes keep their original body and key. Denied delivery is not rewritten.',
    '',
    'This command is not inspect (read-only pages), preview (offline dump comparison), backup or restore.',
    'Options: --source --state --api --account-key --account --client --auth --source-alias --progress --help',
  ].join('\n');
}

export function parseResumeArgs(argv: readonly string[]): ResumeCliConfig | 'help' {
  if (!Array.isArray(argv) || argv.length > 64) throw new ResumeArgumentError();
  let totalBytes = 0;
  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.length > 4096 || argument.includes('\0')) throw new ResumeArgumentError();
    totalBytes += Buffer.byteLength(argument);
    if (totalBytes > 16384) throw new ResumeArgumentError();
  }
  if (argv.length === 1 && argv[0] === '--help') return 'help';

  const values = new Map<string, string>();
  const valueFlags = new Set([
    '--source',
    '--state',
    '--api',
    '--account-key',
    '--account',
    '--client',
    '--auth',
    '--source-alias',
    '--progress',
  ]);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (REJECTED.has(flag) || flag === '-') throw new ResumeArgumentError();
    if (!valueFlags.has(flag) || values.has(flag)) throw new ResumeArgumentError();
    const value = argv[++index];
    if (value === undefined || valueFlags.has(value) || REJECTED.has(value) || value === '--help' || value.length === 0)
      throw new ResumeArgumentError();
    values.set(flag, value);
  }

  const source = values.get('--source');
  const state = values.get('--state');
  const api = values.get('--api');
  const accountKey = values.get('--account-key');
  const account = values.get('--account');
  const client = values.get('--client');
  const auth = values.get('--auth');
  if (
    !source ||
    !VALID_SOURCE.test(source) ||
    !state ||
    !api ||
    !accountKey ||
    !account ||
    !UUID.test(account) ||
    !client ||
    !CLIENT.test(client) ||
    !auth
  )
    throw new ResumeArgumentError();
  if (!state.trim() || state === '-') throw new ResumeArgumentError();
  if (!accountKey.trim()) throw new ResumeArgumentError();

  const result: ResumeCliConfig = {
    source: source as SourceKind,
    state,
    api,
    accountKey,
    account,
    client,
    auth,
  };
  const progressMode = values.get('--progress');
  if (progressMode !== undefined) {
    if (progressMode !== 'human' && progressMode !== 'jsonl') throw new ResumeArgumentError();
    result.progressMode = progressMode;
  }
  const sourceAlias = values.get('--source-alias');
  if (sourceAlias !== undefined) result.sourceAlias = sourceAlias;
  return result;
}

function parseOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ResumeArgumentError();
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.hostname)
    throw new ResumeArgumentError();
  return url;
}

function validateOrigin(api: string, testOrigin?: string): string {
  const url = parseOrigin(api);
  if (testOrigin === undefined) {
    if (url.protocol !== 'https:') throw new ResumeArgumentError();
  } else {
    const test = parseOrigin(testOrigin);
    if (
      test.protocol !== 'http:' ||
      test.hostname !== '127.0.0.1' ||
      test.origin !== testOrigin ||
      url.origin !== test.origin
    )
      throw new ResumeArgumentError();
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

function progressTerminal(
  output: ImportCliResult,
  signal: AbortSignal,
): { phase: ImportProgressPhase; outcome: ImportProgressOutcome } {
  if (signal.aborted || output.code === 130) return { phase: 'interrupted', outcome: 'interrupted' };
  if (output.code === 0) return { phase: 'committed', outcome: 'committed' };
  if (output.code === 2) return { phase: 'invalid-input', outcome: 'invalid-input' };
  if (output.code === 5) return { phase: 'busy', outcome: 'busy' };
  if (output.code === 4) return { phase: 'denied', outcome: 'denied' };
  if (output.code === 6) return { phase: 'observation-conflict', outcome: 'observation-conflict' };
  return { phase: 'failed', outcome: 'failed' };
}

function resultFor(run: ImportRunResult, httpStatus: number | undefined, signal: AbortSignal): ImportCliResult {
  const counts = run.counts;
  const summary = `new=${counts.new} changed=${counts.changed} unchanged=${counts.unchanged} vanished=${counts.vanished} skipped=${run.skipped}`;
  if (run.status === 'committed')
    return { code: 0, stdout: `Import complete: ${summary}\n`, stderr: '', openHandles: 0 };
  if (run.status === 'busy')
    return {
      code: 5,
      stdout: '',
      stderr: diagnostic('This source already has an active import.', counts, run.skipped),
      openHandles: 0,
    };
  if (run.status === 'invalid-dump')
    return { code: 2, stdout: '', stderr: diagnostic(run.diagnostic, counts, run.skipped), openHandles: 0 };
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

function importerScopes(source: SourceKind): readonly string[] {
  if (source === 'vndb') return [...VNDB_IMPORTER_SCOPES, 'subject:read'];
  if (source === 'bangumi') return [...IMPORTER_SCOPES, 'subject:read'];
  return IMPORTER_SCOPES;
}

/** Parse and resume one sealed generation without opening a dump or constructing an empty input. */
export async function runResumeCli(argv: readonly string[], options: ImportCliOptions = {}): Promise<ImportCliResult> {
  let config: ResumeCliConfig;
  try {
    const parsed = parseResumeArgs(argv);
    if (parsed === 'help') return { code: 0, stdout: `${resumeUsage()}\n`, stderr: '', openHandles: 0 };
    config = parsed;
    validateOrigin(config.api, options.testOrigin);
    const auth = parseOrigin(config.auth);
    if (auth.protocol !== 'https:') throw new ResumeArgumentError();
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
  const clock = options.clock ?? {
    now: () => Date.now(),
    sleep: async (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  let lastHttpStatus: number | undefined;
  const guardedFetch = (async (request: Request) => {
    const response = await (options.fetch ?? globalThis.fetch)(request);
    lastHttpStatus = response.status;
    return response;
  }) as unknown as typeof fetch;

  let session: ImportSession | undefined;
  try {
    options.observer?.onDatabaseOpen?.(config.state);
    session = await ImportSession.openExisting(config.state, {
      ...(options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {}),
    });
  } catch (error) {
    if (error instanceof ResumeStateError && error.kind === 'missing')
      return {
        code: 2,
        stdout: '',
        stderr: diagnostic(
          'Importer state database does not exist. Ordinary import with a complete dump creates it; inspect cannot run on a missing file.',
        ),
        openHandles: 0,
      };
    if (error instanceof ResumeStateError && error.kind === 'busy-lock')
      return {
        code: 5,
        stdout: '',
        stderr: diagnostic('This source already has an active import.'),
        openHandles: 0,
      };
    return {
      code: 2,
      stdout: '',
      stderr: diagnostic('Importer state is damaged or unavailable.'),
      openHandles: 0,
    };
  }

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

  const slot: { transport?: ReturnType<typeof createImportTransport> } = {};
  const requireTransport = () => {
    if (!slot.transport) throw new ResumeActivationError('Resume transport was used before admission.');
    return slot.transport;
  };
  const deferredTransport: ImportTransport = {
    setSourceRecordMetadata: (input) => track(() => requireTransport().setSourceRecordMetadata(input, signal)),
    batchWrite: (request) => track(() => requireTransport().batch(request, signal)),
    clearSourceStatistic: (input) => track(() => requireTransport().clearSourceStatistic(input, signal)),
    writeSourceStatistic: (input) => track(() => requireTransport().writeSourceStatistic(input, signal)),
    readSourceStatistics: (input) => track(() => requireTransport().readSourceStatistics(input, signal)),
    readPublicFigure: (input) => track(() => requireTransport().readPublicFigure(input, signal)),
    readFence: (tuple: { source: string; external_id: string; field_group: 'facts' | 'summary' | 'cover' }) =>
      readFence(() =>
        requireTransport().fence(
          { source: tuple.source, externalId: tuple.external_id, fieldGroup: tuple.field_group },
          signal,
        ),
      ),
  };

  const importerOptions: ImporterOptions = {
    path: session.store.database,
    session,
    existing: true,
    transport: deferredTransport,
    now: () => clock.now(),
    ...(options.clock ? { sleep: (ms: number, sleepSignal: AbortSignal) => clockSleep(clock, ms, sleepSignal) } : {}),
    ...(options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {}),
  };
  const importer: Importer = (options.createImporter ?? createImporter)(importerOptions);
  let output: ImportCliResult = { code: 1, stdout: '', stderr: diagnostic('Import failed safely.'), openHandles: 0 };
  try {
    const run = await importer.resumeExisting(registration, {
      signal,
      ...(progressHooks ? { progress: progressHooks } : {}),
      async activateNetwork() {
        const tokenProvider = await createAccountTokenProvider({
          accountKeyPath: config.accountKey,
          account: config.account,
          client: config.client,
          authOrigin: config.auth,
          scopes: importerScopes(config.source),
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
        slot.transport = createImportTransport({
          origin: validateOrigin(config.api, options.testOrigin),
          tokenProvider,
          fetch: guardedFetch,
          now: () => clock.now(),
          sleep: (ms) => clock.sleep(ms),
        });
        const mediaPort = {
          readFence: (tuple: { source: string; externalId: string; fieldGroup: 'cover' }, mediaSignal: AbortSignal) =>
            readFence(() => slot.transport!.fence(tuple, mediaSignal)),
          importFromUrl: (bytes: string, key: string, mediaSignal: AbortSignal) =>
            track(() => slot.transport!.requestMedia(bytes, key, mediaSignal)),
          importStatus: (id: string, mediaSignal: AbortSignal) =>
            track(() => slot.transport!.mediaStatus(id, mediaSignal)),
        };
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
        importerOptions.mediaResolver = {
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
        if (config.source === 'bangumi')
          importerOptions.identifierLookup = createReviewedCatalogueLookup(importer.session.bindings, slot.transport);
        options.observer?.onCoordinator?.({
          importer,
          registration,
          state: config.state,
          converterModule: converterModule(config.source),
          decoderModule: import.meta.resolve('./dumps.ts'),
        });
      },
    });
    output = resultFor(run, lastHttpStatus, signal);
  } catch (error) {
    const interrupted = signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
    output = {
      code: interrupted ? 130 : error instanceof ResumeActivationError || error instanceof CredentialInputError ? 2 : 1,
      stdout: '',
      stderr: diagnostic(
        interrupted
          ? 'Import interrupted; durable state is retained for resume.'
          : error instanceof CredentialInputError
            ? 'Input or account key is unavailable or invalid.'
            : 'Import failed safely.',
      ),
      openHandles: 0,
    };
  } finally {
    credentialLifetime.abort();
    await settleInFlight();
    try {
      await importer.close();
    } catch {
      try {
        importer.session.close();
      } catch {
        // Preserve the primary status; the durable run remains available for recovery.
      }
    }
    session = undefined;
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

function converterModule(source: SourceKind): string {
  const modules: Record<SourceKind, string> = {
    bangumi: '@rezics/conversion/bangumi',
    vndb: '@rezics/conversion/vndb',
    openlibrary: '@rezics/conversion/open-library',
    wikidata: '@rezics/conversion/wikidata',
  };
  return import.meta.resolve(modules[source]);
}
