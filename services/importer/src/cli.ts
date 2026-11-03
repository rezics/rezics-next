import { Database } from 'bun:sqlite';
import { lstat, type FileHandle } from 'node:fs/promises';
import type { SourceId } from '@rezics/conversion';
import { createImporter, type Importer, type ImporterOptions } from './importer.ts';
import { createImportTransport } from './import-client.ts';
import { createReviewedCatalogueLookup } from './reviewed-catalogue.ts';
import { createMediaResolver } from './media-resolver.ts';
import { createSourceRegistration } from './source-registry.ts';
import { DEFAULT_DUMP_CHUNK_BYTES, observeDumpRetention } from './dumps-bytes.ts';
import { DEFAULT_VNDB_ARCHIVE_BYTES, DEFAULT_VNDB_ARCHIVE_ENTRIES, type VndbTablesStore } from './vndb-tables.ts';
import {
  VNDB_ACQUISITION_COST,
  VNDB_ACQUISITION_MISSING_STATE,
  VNDB_ACQUISITION_UNSUPPORTED,
  VndbAcquisitionError,
  captureVndbIdentity,
  isVndbAcquisitionId,
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
import {
  admitDumpCompression,
  decodeBudgetLimit,
  decodeDumpBytes,
  parseDumpCompression,
  type DumpCompression,
} from './compressed-dump.ts';
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
  type RawVndbEntry,
} from './dump-input.ts';
import { admitOpenLibraryDumpSet, OpenLibraryDumpSetError } from './open-library-dump-set.ts';
import { fingerprintOpenLibraryDumpSet, readOpenLibraryDumpSet } from './open-library-dump-set-records.ts';
import type { OpenLibraryDumpSetAdmission } from './open-library-dump-set.ts';
import {
  STAGING_COST,
  STAGING_MISSING_STATE,
  STAGING_UNSUPPORTED_INPUT,
  captureDumpSetIdentity,
  captureFileIdentity,
  captureIdentity,
  isStagingCheckpointSource,
} from './staging-checkpoint.ts';

const VALID_SOURCE = /^(?:bangumi|vndb|openlibrary|wikidata)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT = /^[A-Za-z0-9._~-]{1,255}$/;

type SourceKind = SourceId;

export type ImportCliObserver = {
  /** @deprecated Account-key reads are also reported here for older boundary observers. */
  onTokenRead?(path: string, bytes: number): void;
  onAccountKey?: CredentialsObserver['onAccountKey'];
  onDatabaseOpen?(path: string): void;
  beforeRetentionPage?(input: { generation: string; phase: string }): void;
  onInputPass?(kind: 'dump' | 'vndb-entries'): void;
  onInputChunk?(kind: 'dump' | 'vndb-entries', bytes: number, backingBytes: number): void;
  onFingerprint?(bytes: number): void;
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
  dump?: string;
  dumpSet?: string;
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
  zstdExecutable?: string;
  mode: 'ordinary' | 'checkpoint-staging' | 'resume-staging' | 'checkpoint-acquisition' | 'resume-acquisition';
  generation?: string;
  acquisition?: string;
};

class InputFailure extends DumpInputError {}

function usage(): string {
  return [
    'Usage: rezics-import --source <bangumi|vndb|openlibrary|wikidata> --dump <path|-> --state <sqlite-path>',
    '       --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>',
    '       [--source-alias <name>] [--disappearance-threshold <0..1>] [--progress <human|jsonl>]',
    '       [--compression none|gzip|zstd] [--decode-budget <bytes>] [--zstd-executable <absolute-path>]',
    '       [--checkpoint-staging] [--resume-staging --generation <id>]',
    '       [--checkpoint-acquisition] [--resume-acquisition --acquisition <id>]',
    '       rezics-import resume --source <bangumi|vndb|openlibrary|wikidata> --state <sqlite-path>',
    '       --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>',
    '       [--source-alias <name>] [--progress <human|jsonl>]',
    '       rezics-import --source openlibrary --dump-set <manifest-path> --state <sqlite-path>',
    '       --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>',
    '       [--source-alias <name>] [--disappearance-threshold <0..1>] [--progress <human|jsonl>] [--decode-budget <bytes>]',
    '       [--checkpoint-staging] [--resume-staging --generation <id>]',
    '       rezics-import diagnostics --source <bangumi|vndb|openlibrary|wikidata> --state <sqlite-path>',
    '       [--generation <id>] [--record <key>] [--limit <1..100>] [--cursor <token>] [--phase staging|application] [--format json|text]',
    '       rezics-import disappearance-review --state <sqlite-path> --source <configured-source-id> --generation <id>',
    '       [--page missing] [--limit 1..100] [--cursor <token>] [--record <key>] [--json]',
    '       rezics-import retention --state <sqlite-path> --source <configured-source-id> [--after <id>] [--limit 1..100]',
    '       rezics-import retention --state <sqlite-path> --source <configured-source-id> --generation <id> [--generation <id> ...] --output <plan-path>',
    '       rezics-import retention --state <sqlite-path> --plan <plan-path> --confirm <plan-id> --apply',
    '       rezics-import retire-staging --state <sqlite-path> --source <configured-source-id> --generation <id>',
    '       rezics-import retire-staging --state <sqlite-path> --source <configured-source-id> --generation <id> --output <plan-path>',
    '       rezics-import retire-staging --state <sqlite-path> --plan <plan-path> --confirm <plan-id> --apply',
    '       rezics-import observations --state <sqlite-path> --source <configured-source-id> [--after <operation-id>] [--limit 1..20]',
    '       rezics-import observations --state <sqlite-path> --source <configured-source-id> --operation <operation-id>',
    '       rezics-import observations --state <sqlite-path> --source <configured-source-id> --operation <operation-id>',
    '       --resolve --reviewed-observation <64-hex> --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>',
    '       rezics-import classifications --state <sqlite-path> --source <configured-source-id> [--after <operation-id>] [--limit 1..20]',
    '       rezics-import classifications --state <sqlite-path> --source <configured-source-id> --operation <operation-id>',
    '       rezics-import classifications --state <sqlite-path> --source <configured-source-id> --operation <operation-id>',
    '       --resolve --reviewed-observation <64-hex> --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>',
    '       rezics-import batch --manifest <path> [--json]',
    '       rezics-import batch --manifest <path> --run --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>',
    '       [--progress human|jsonl] [--json]',
    '       rezics-import destination --state <sqlite-path> --source <configured-source-id> --api <https-origin> [--json]',
    '       rezics-import destination --state <sqlite-path> --source <configured-source-id> --api <https-origin>',
    '       --review-revision <64-hex> --declare --acknowledge-unverified [--json]',
    'Exit 6 means a source observation or classification needs explicit resolution; it is not an authorization failure.',
    'Options: --source --dump --dump-set --state --api --account-key --account --client --auth --source-alias --disappearance-threshold --progress --compression --decode-budget --zstd-executable --checkpoint-staging --resume-staging --generation --checkpoint-acquisition --resume-acquisition --acquisition --help',
    'gzip is admitted only for Open Library and Wikidata streamed dumps. zstd is admitted only for VNDB archives and Wikidata streamed dumps, as one regular local file (not stdin). Default --compression none. A suffix is not a source identity. --decode-budget is a whole-set decoded-byte ceiling (default 256 GiB) for one gzip dump, one zstd dump or one complete dump set, never a per-member multiple. Dump-set version 1 stays plain; version 2 requires explicit per-member none or gzip. --compression does not apply to --dump-set. zstd uses /usr/bin/zstd or PATH zstd, or --zstd-executable, with a 128 MiB decoder window.',
    'Each exact source alias records its API origin on first use. A mistyped --api fails before credentials. Legacy unbound history needs rezics-import destination. Same-origin server replacement cannot be detected without a separately released deployment identity.',
    '--checkpoint-staging and --resume-staging admit one uncompressed Bangumi regular file, one Open Library or Wikidata regular file (plain, gzip, or Wikidata zstd), or one Open Library dump-set. They re-hash every original file before any capture or resume mutation, then replay the production decoder from the start of each member. Default import still discards unsealed staging. After sealing, resume with the ordinary dump-free command; do not replace input. Local conversion is not publication, and Bangumi ratings stay omitted. VNDB archives and stdin stay non-resumable.',
    STAGING_COST,
    '--checkpoint-acquisition and --resume-acquisition apply only to one regular local VNDB archive with plain tar or owned zstd decoding. They re-hash the complete original file before table mutation. Stdin cannot resume. Table acquisition IDs are distinct from source generation IDs. After tables are ready, resume publication with --resume-acquisition; after sealing, use the ordinary command.',
    VNDB_ACQUISITION_COST,
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
  const flags = new Set<string>();
  const valueFlags = new Set([
    '--source',
    '--dump',
    '--dump-set',
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
    '--generation',
    '--acquisition',
    '--zstd-executable',
  ]);
  const booleanFlags = new Set([
    '--checkpoint-staging',
    '--resume-staging',
    '--checkpoint-acquisition',
    '--resume-acquisition',
  ]);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (booleanFlags.has(flag)) {
      if (flags.has(flag) || values.has(flag)) throw new InputFailure();
      flags.add(flag);
      continue;
    }
    if (!valueFlags.has(flag) || values.has(flag)) throw new InputFailure();
    const value = argv[++index];
    if (
      value === undefined ||
      valueFlags.has(value) ||
      booleanFlags.has(value) ||
      value === '--help' ||
      value.length === 0
    )
      throw new InputFailure();
    values.set(flag, value);
  }

  const source = values.get('--source');
  const dump = values.get('--dump');
  const dumpSet = values.get('--dump-set');
  const state = values.get('--state');
  const api = values.get('--api');
  const accountKey = values.get('--account-key');
  const account = values.get('--account');
  const client = values.get('--client');
  const auth = values.get('--auth');
  if (
    !source ||
    !VALID_SOURCE.test(source) ||
    (dump !== undefined && dumpSet !== undefined) ||
    (dump === undefined && dumpSet === undefined) ||
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
  if (dump !== undefined && dump !== '-' && !dump.trim()) throw new InputFailure();
  if (dumpSet !== undefined && (!dumpSet.trim() || dumpSet === '-')) throw new InputFailure();
  if (dumpSet !== undefined && source !== 'openlibrary') throw new InputFailure();
  if (dumpSet !== undefined && values.has('--compression')) throw new InputFailure();
  if (!state.trim() || state === '-') throw new InputFailure();
  if (!accountKey.trim()) throw new InputFailure();

  const checkpointStaging = flags.has('--checkpoint-staging');
  const resumeStaging = flags.has('--resume-staging');
  const checkpointAcquisition = flags.has('--checkpoint-acquisition');
  const resumeAcquisition = flags.has('--resume-acquisition');
  const modeCount = [checkpointStaging, resumeStaging, checkpointAcquisition, resumeAcquisition].filter(Boolean).length;
  if (modeCount > 1) throw new InputFailure();
  const generation = values.get('--generation');
  const acquisition = values.get('--acquisition');
  if (resumeStaging) {
    if (!generation || !/^[1-9][0-9]*$/.test(generation)) throw new InputFailure();
  } else if (generation !== undefined) {
    throw new InputFailure();
  }
  if (resumeAcquisition) {
    if (!acquisition || !isVndbAcquisitionId(acquisition)) throw new InputFailure();
  } else if (acquisition !== undefined) {
    throw new InputFailure();
  }
  const result: Config = {
    source: source as SourceKind,
    ...(dump === undefined ? {} : { dump }),
    ...(dumpSet === undefined ? {} : { dumpSet }),
    state,
    api,
    accountKey,
    account,
    client,
    auth,
    compression: 'none',
    mode: resumeStaging
      ? 'resume-staging'
      : checkpointStaging
        ? 'checkpoint-staging'
        : resumeAcquisition
          ? 'resume-acquisition'
          : checkpointAcquisition
            ? 'checkpoint-acquisition'
            : 'ordinary',
    ...(generation ? { generation } : {}),
    ...(acquisition ? { acquisition } : {}),
  };
  const compression = values.get('--compression');
  if (compression !== undefined) result.compression = parseDumpCompression(compression);
  if (result.compression === 'zstd' && dump === '-') throw new InputFailure();
  const zstdExecutable = values.get('--zstd-executable');
  if (zstdExecutable !== undefined) {
    if (result.compression !== 'zstd') throw new InputFailure();
    result.zstdExecutable = zstdExecutable;
  }
  const decodeBudget = values.get('--decode-budget');
  if (decodeBudget !== undefined) {
    if (result.dumpSet === undefined && result.compression !== 'gzip' && result.compression !== 'zstd')
      throw new InputFailure();
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
  if (result.mode === 'checkpoint-staging' || result.mode === 'resume-staging') {
    if (result.dump === '-' || !isStagingCheckpointSource(result.source))
      throw new DumpInputError(STAGING_UNSUPPORTED_INPUT, 'checkpoint-unsupported');
    if (result.dumpSet !== undefined && (result.source !== 'openlibrary' || result.compression !== 'none'))
      throw new DumpInputError(STAGING_UNSUPPORTED_INPUT, 'checkpoint-unsupported');
    if (result.compression === 'zstd' && result.source !== 'wikidata')
      throw new DumpInputError(STAGING_UNSUPPORTED_INPUT, 'checkpoint-unsupported');
    if (result.compression !== 'none' && result.source === 'bangumi')
      throw new DumpInputError(STAGING_UNSUPPORTED_INPUT, 'checkpoint-unsupported');
  }
  if (result.mode === 'checkpoint-acquisition' || result.mode === 'resume-acquisition') {
    if (
      result.dumpSet !== undefined ||
      result.dump === '-' ||
      result.source !== 'vndb' ||
      result.compression === 'gzip'
    )
      throw new DumpInputError(VNDB_ACQUISITION_UNSUPPORTED, 'checkpoint-unsupported');
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
  if (Array.isArray(argv) && argv[0] === 'inspect-bindings')
    return runBindingInspectionCli(argv.slice(1), {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {}),
    });
  if (Array.isArray(argv) && argv[0] === 'resume') return runResumeCli(argv.slice(1), options);
  if (Array.isArray(argv) && argv.length === 2 && argv[0] === '--help' && argv[1] === 'resume')
    return { code: 0, stdout: `${resumeUsage()}\n`, stderr: '', openHandles: 0 };
  if (Array.isArray(argv) && argv[0] === 'inspect')
    return runInspectCli(argv.slice(1), options.signal ? { signal: options.signal } : {});
  if (Array.isArray(argv) && argv[0] === 'capture-comparison')
    return runCaptureComparisonCli(argv.slice(1), options.signal ? { signal: options.signal } : {});
  if (Array.isArray(argv) && argv.length === 2 && argv[0] === '--help' && argv[1] === 'capture-comparison')
    return { code: 0, stdout: `${captureComparisonUsage()}\n`, stderr: '', openHandles: 0 };
  if (Array.isArray(argv) && argv[0] === 'disappearance-review')
    return runDisappearanceReviewCli(argv.slice(1), {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {}),
    });
  if (Array.isArray(argv) && argv.length === 2 && argv[0] === '--help' && argv[1] === 'disappearance-review')
    return { code: 0, stdout: `${disappearanceReviewUsage()}\n`, stderr: '', openHandles: 0 };
  if (Array.isArray(argv) && argv[0] === 'observations')
    return runObservationsCli(argv.slice(1), {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.testOrigin ? { testOrigin: options.testOrigin } : {}),
      ...(options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {}),
    });
  if (Array.isArray(argv) && argv.length === 2 && argv[0] === '--help' && argv[1] === 'observations')
    return { code: 0, stdout: `${observationsUsage()}\n`, stderr: '', openHandles: 0 };
  if (Array.isArray(argv) && argv[0] === 'classifications')
    return runClassificationsCli(argv.slice(1), {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.testOrigin ? { testOrigin: options.testOrigin } : {}),
      ...(options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {}),
    });
  if (Array.isArray(argv) && argv.length === 2 && argv[0] === '--help' && argv[1] === 'classifications')
    return { code: 0, stdout: `${classificationsUsage()}\n`, stderr: '', openHandles: 0 };
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
  if (Array.isArray(argv) && argv[0] === 'batch') return runBatchCli(argv.slice(1), options);
  if (Array.isArray(argv) && argv.length === 2 && argv[0] === '--help' && argv[1] === 'batch')
    return { code: 0, stdout: `${batchUsage()}\n`, stderr: '', openHandles: 0 };
  if (Array.isArray(argv) && argv[0] === 'destination')
    return runDestinationCli(argv.slice(1), {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.testOrigin ? { testOrigin: options.testOrigin } : {}),
      ...(options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {}),
    });
  if (Array.isArray(argv) && argv.length === 2 && argv[0] === '--help' && argv[1] === 'destination')
    return { code: 0, stdout: `${DESTINATION_USAGE}\n`, stderr: '', openHandles: 0 };
  if (Array.isArray(argv) && argv[0] === 'retention')
    return runRetentionCli(argv.slice(1), {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {}),
      ...(options.observer?.onDatabaseOpen || options.observer?.beforeRetentionPage
        ? {
            observer: {
              ...(options.observer.onDatabaseOpen ? { onDatabaseOpen: options.observer.onDatabaseOpen } : {}),
              ...(options.observer.beforeRetentionPage ? { beforePage: options.observer.beforeRetentionPage } : {}),
            },
          }
        : {}),
    });
  if (Array.isArray(argv) && argv.length === 2 && argv[0] === '--help' && argv[1] === 'retention')
    return { code: 0, stdout: `${retentionUsage()}\n`, stderr: '', openHandles: 0 };
  if (Array.isArray(argv) && argv[0] === 'retire-staging')
    return runStagingRetirementCli(argv.slice(1), {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {}),
      ...(options.observer?.onDatabaseOpen || options.observer?.beforeRetentionPage
        ? {
            observer: {
              ...(options.observer.onDatabaseOpen ? { onDatabaseOpen: options.observer.onDatabaseOpen } : {}),
              ...(options.observer.beforeRetentionPage ? { beforePage: options.observer.beforeRetentionPage } : {}),
            },
          }
        : {}),
    });
  if (Array.isArray(argv) && argv.length === 2 && argv[0] === '--help' && argv[1] === 'retire-staging')
    return { code: 0, stdout: `${stagingRetirementUsage()}\n`, stderr: '', openHandles: 0 };
  let config: Config;
  try {
    const parsed = parse(argv);
    if (parsed === 'help') return { code: 0, stdout: `${usage()}\n`, stderr: '', openHandles: 0 };
    config = parsed;
    config.api = validateOrigin(config.api, options.testOrigin);
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
  let zstdExecutable: string | undefined;
  try {
    registration = createSourceRegistration(config.source, { source: config.sourceAlias ?? config.source });
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
  const clock = options.clock ?? {
    now: () => Date.now(),
    sleep: async (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  const guardedFetch = (async (request: Request) => {
    const response = await (options.fetch ?? globalThis.fetch)(request);
    lastHttpStatus = response.status;
    return response;
  }) as unknown as typeof fetch;
  let tokenProvider: Awaited<ReturnType<typeof createAccountTokenProvider>> | undefined;
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

  let importTransport: ReturnType<typeof createImportTransport> | undefined;
  const connectTransport = async () => {
    if (importTransport) return importTransport;
    tokenProvider ??= await createAccountTokenProvider({
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
    importTransport = createImportTransport({
      origin: validateOrigin(config.api, options.testOrigin),
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
      input: Parameters<ReturnType<typeof createImportTransport>['setSourceRecordMetadata']>[0],
    ) => track(() => liveTransport().setSourceRecordMetadata(input, signal)),
    batchWrite: (request: Parameters<ReturnType<typeof createImportTransport>['batch']>[0]) =>
      track(() => liveTransport().batch(request, signal)),
    clearSourceStatistic: (input: Parameters<ReturnType<typeof createImportTransport>['clearSourceStatistic']>[0]) =>
      track(() => liveTransport().clearSourceStatistic(input, signal)),
    writeSourceStatistic: (
      input: Parameters<NonNullable<ReturnType<typeof createImportTransport>['writeSourceStatistic']>>[0],
    ) => track(() => liveTransport().writeSourceStatistic(input, signal)),
    readSourceStatistics: (input: Parameters<ReturnType<typeof createImportTransport>['readSourceStatistics']>[0]) =>
      track(() => liveTransport().readSourceStatistics(input, signal)),
    readPublicFigure: (input: Parameters<ReturnType<typeof createImportTransport>['readPublicFigure']>[0]) =>
      track(() => liveTransport().readPublicFigure(input, signal)),
    readSourceClassifications: (
      input: Parameters<ReturnType<typeof createImportTransport>['readSourceClassifications']>[0],
    ) => track(() => liveTransport().readSourceClassifications(input, signal)),
    writeSourceClassification: (
      input: Parameters<ReturnType<typeof createImportTransport>['writeSourceClassification']>[0],
    ) => track(() => liveTransport().writeSourceClassification(input, signal)),
    clearSourceClassification: (
      input: Parameters<ReturnType<typeof createImportTransport>['clearSourceClassification']>[0],
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
      ...(options.clock ? { sleep: (ms: number, sleepSignal: AbortSignal) => clockSleep(clock, ms, sleepSignal) } : {}),
      ...(options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {}),
      ...(config.mode === 'resume-staging' || config.mode === 'resume-acquisition' ? { create: false } : {}),
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
      importerOptions.identifierLookup = createReviewedCatalogueLookup(importer.session.bindings, liveTransport());

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
            if (!vndbCapture || !config.acquisition) throw new InputFailure();
            const compatibility = materialization.resumeCompatibility(config.acquisition, vndbCapture);
            if (!compatibility.ok) throw new VndbAcquisitionError(compatibility.code, compatibility.message);
            acquisition = config.acquisition;
            publishOnly = compatibility.action === 'publish';
            progress?.setSourceRun(acquisition);
          } else if (config.mode === 'checkpoint-acquisition') {
            if (!vndbCapture) throw new InputFailure();
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
          : error instanceof InputFailure ||
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
  config: Config,
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
