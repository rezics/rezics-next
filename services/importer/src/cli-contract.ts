import type { Database } from 'bun:sqlite';
import type { SourceId } from '@rezics/conversion';
import { parseDumpCompression, type DumpCompression } from './compressed-dump.ts';
import { DumpInputError, type RawVndbEntry } from './dump-input.ts';
import type { CredentialsObserver } from './credentials.ts';
import type { Importer, createImporter } from './importer.ts';
import type { ImportProgressMode, ImportProgressSink } from './import-progress.ts';
import type { SourceRegistration } from './import-contract.ts';
import { STAGING_COST, STAGING_UNSUPPORTED_INPUT, isStagingCheckpointSource } from './staging-checkpoint.ts';
import { VNDB_ACQUISITION_COST, VNDB_ACQUISITION_UNSUPPORTED, isVndbAcquisitionId } from './vndb-acquisition.ts';
import type { VndbTablesStore } from './vndb-tables.ts';

const VALID_SOURCE = /^(?:bangumi|vndb|openlibrary|wikidata)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT = /^[A-Za-z0-9._~-]{1,255}$/;

export const IMPORT_CLI_SUBCOMMANDS = [
  'inspect-bindings',
  'resume',
  'inspect',
  'capture-comparison',
  'disappearance-review',
  'observations',
  'classifications',
  'preview',
  'compare',
  'backup',
  'validate-snapshot',
  'restore',
  'diagnostics',
  'batch',
  'destination',
  'retention',
  'retire-staging',
] as const;

export type ImportCliSubcommand = (typeof IMPORT_CLI_SUBCOMMANDS)[number];

const HELP_TOPICS = [
  'resume',
  'capture-comparison',
  'disappearance-review',
  'observations',
  'classifications',
  'diagnostics',
  'batch',
  'destination',
  'retention',
  'retire-staging',
] as const;

export type ImportCliHelpTopic = 'import' | (typeof HELP_TOPICS)[number];

const FULL_ARGV_COMMANDS = new Set<ImportCliSubcommand>(['backup', 'validate-snapshot', 'restore']);

export type ImportCliSourceKind = SourceId;

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

export type ImportCliClock = { now(): number; sleep(ms: number): Promise<void> };

/** Caller-supplied process, network, clock and store bindings for one constructed Import run. */
export type ImportCliOptions = {
  stdin?: AsyncIterable<Uint8Array>;
  /** Raw VNDB archive members are injected at this external boundary in tests. */
  entries?: AsyncIterable<RawVndbEntry>;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  clock?: ImportCliClock;
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

export type ImportCliMode =
  | 'ordinary'
  | 'checkpoint-staging'
  | 'resume-staging'
  | 'checkpoint-acquisition'
  | 'resume-acquisition';

/** Parsed ordinary single-source command. Subcommands never produce this plan. */
export type ImportCliConfig = {
  source: ImportCliSourceKind;
  dump?: string;
  dumpSet?: string;
  state: string;
  api: string;
  accountKey: string;
  account: string;
  client: string;
  auth: string;
  sourceAlias?: string;
  bangumiGameGenreBindings?: string;
  bangumiPersonCareerBindings?: string;
  disappearanceThreshold?: number;
  progressMode?: ImportProgressMode;
  compression: DumpCompression;
  decodeBudget?: number;
  zstdExecutable?: string;
  mode: ImportCliMode;
  generation?: string;
  acquisition?: string;
};

export type ImportCliPlan =
  | { kind: 'help'; usage: ImportCliHelpTopic }
  | { kind: 'subcommand'; name: ImportCliSubcommand; argv: readonly string[] }
  | { kind: 'ordinary'; argv: readonly string[] };

export class ImportCliInputFailure extends DumpInputError {
  constructor(message = 'Invalid importer arguments.', identity: DumpInputError['identity'] = 'invalid-input') {
    super(message, identity);
    this.name = 'ImportCliInputFailure';
  }
}

export function importCliResult(code: number, stdout: string, stderr: string, openHandles = 0): ImportCliResult {
  return { code, stdout, stderr, openHandles };
}

export function importCliDiagnostic(
  message: string,
  counts?: { new: number; changed: number; unchanged: number; vanished: number },
  skipped = 0,
): string {
  const summary = counts
    ? `\nnew=${counts.new} changed=${counts.changed} unchanged=${counts.unchanged} vanished=${counts.vanished} skipped=${skipped}`
    : `\nskipped=${skipped}`;
  return `${message}${summary}\n`;
}

export function importCliUsage(): string {
  return [
    'Usage: rezics-import --source <bangumi|vndb|openlibrary|wikidata> --dump <path|-> --state <sqlite-path>',
    '       --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>',
    '       [--source-alias <name>] [--disappearance-threshold <0..1>] [--progress <human|jsonl>]',
    '       [--bangumi-game-genre-bindings-file <finite-json-path>]',
    '       [--bangumi-person-career-bindings-file <finite-json-path>]',
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
    'Options: --source --dump --dump-set --state --api --account-key --account --client --auth --source-alias --bangumi-game-genre-bindings-file --bangumi-person-career-bindings-file --disappearance-threshold --progress --compression --decode-budget --zstd-executable --checkpoint-staging --resume-staging --generation --checkpoint-acquisition --resume-acquisition --acquisition --help',
    'gzip is admitted only for Open Library and Wikidata streamed dumps. zstd is admitted only for VNDB archives and Wikidata streamed dumps, as one regular local file (not stdin). Default --compression none. A suffix is not a source identity. --decode-budget is a whole-set decoded-byte ceiling (default 256 GiB) for one gzip dump, one zstd dump or one complete dump set, never a per-member multiple. Dump-set version 1 stays plain; version 2 requires explicit per-member none or gzip. --compression does not apply to --dump-set. zstd uses /usr/bin/zstd or PATH zstd, or --zstd-executable, with a 128 MiB decoder window.',
    'Each exact source alias records its API origin on first use. A mistyped --api fails before credentials. Legacy unbound history needs rezics-import destination. Same-origin server replacement cannot be detected without a separately released deployment identity.',
    '--checkpoint-staging and --resume-staging admit one uncompressed Bangumi regular file, one Open Library or Wikidata regular file (plain, gzip, or Wikidata zstd), or one Open Library dump-set. They re-hash every original file before any capture or resume mutation, then replay the production decoder from the start of each member. Default import still discards unsealed staging. After sealing, resume with the ordinary dump-free command; do not replace input. Local conversion is not publication, and Bangumi ratings stay omitted. VNDB archives and stdin stay non-resumable.',
    STAGING_COST,
    '--checkpoint-acquisition and --resume-acquisition apply only to one regular local VNDB archive with plain tar or owned zstd decoding. They re-hash the complete original file before table mutation. Stdin cannot resume. Table acquisition IDs are distinct from source generation IDs. After tables are ready, resume publication with --resume-acquisition; after sealing, use the ordinary command.',
    VNDB_ACQUISITION_COST,
  ].join('\n');
}

function isSubcommand(value: string | undefined): value is ImportCliSubcommand {
  return IMPORT_CLI_SUBCOMMANDS.includes(value as ImportCliSubcommand);
}

function isHelpTopic(value: string | undefined): value is (typeof HELP_TOPICS)[number] {
  return HELP_TOPICS.includes(value as (typeof HELP_TOPICS)[number]);
}

/** Classify argv before any credentials, SQLite, dump or network work. */
export function planImportCliArgv(argv: readonly string[]): ImportCliPlan {
  if (!Array.isArray(argv)) return { kind: 'ordinary', argv };
  if (argv.length === 1 && argv[0] === '--help') return { kind: 'help', usage: 'import' };
  if (argv.length === 2 && argv[0] === '--help' && isHelpTopic(argv[1])) return { kind: 'help', usage: argv[1] };
  const name = argv[0];
  if (isSubcommand(name)) {
    return {
      kind: 'subcommand',
      name,
      argv: FULL_ARGV_COMMANDS.has(name) ? argv : argv.slice(1),
    };
  }
  return { kind: 'ordinary', argv };
}

export function parseImportCliOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ImportCliInputFailure();
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.hostname)
    throw new ImportCliInputFailure();
  return url;
}

export function validateImportCliApiOrigin(api: string, testOrigin?: string): string {
  const url = parseImportCliOrigin(api);
  if (testOrigin === undefined) {
    if (url.protocol !== 'https:') throw new ImportCliInputFailure();
  } else {
    const test = parseImportCliOrigin(testOrigin);
    if (
      test.protocol !== 'http:' ||
      test.hostname !== '127.0.0.1' ||
      test.origin !== testOrigin ||
      url.origin !== test.origin
    )
      throw new ImportCliInputFailure();
  }
  return url.origin;
}

export function parseImportCliConfig(argv: readonly string[]): ImportCliConfig | 'help' {
  if (!Array.isArray(argv) || argv.length > 64) throw new ImportCliInputFailure();
  let totalBytes = 0;
  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.length > 4096 || argument.includes('\0'))
      throw new ImportCliInputFailure();
    totalBytes += Buffer.byteLength(argument);
    if (totalBytes > 16384) throw new ImportCliInputFailure();
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
    '--bangumi-game-genre-bindings-file',
    '--bangumi-person-career-bindings-file',
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
      if (flags.has(flag) || values.has(flag)) throw new ImportCliInputFailure();
      flags.add(flag);
      continue;
    }
    if (!valueFlags.has(flag) || values.has(flag)) throw new ImportCliInputFailure();
    const value = argv[++index];
    if (
      value === undefined ||
      valueFlags.has(value) ||
      booleanFlags.has(value) ||
      value === '--help' ||
      value.length === 0
    )
      throw new ImportCliInputFailure();
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
    throw new ImportCliInputFailure();
  if (dump !== undefined && dump !== '-' && !dump.trim()) throw new ImportCliInputFailure();
  if (dumpSet !== undefined && (!dumpSet.trim() || dumpSet === '-')) throw new ImportCliInputFailure();
  if (dumpSet !== undefined && source !== 'openlibrary') throw new ImportCliInputFailure();
  if (dumpSet !== undefined && values.has('--compression')) throw new ImportCliInputFailure();
  if (!state.trim() || state === '-') throw new ImportCliInputFailure();
  if (!accountKey.trim()) throw new ImportCliInputFailure();
  const bangumiGameGenreBindings = values.get('--bangumi-game-genre-bindings-file');
  if (bangumiGameGenreBindings !== undefined && (source !== 'bangumi' || !bangumiGameGenreBindings.trim()))
    throw new ImportCliInputFailure();

  const bangumiPersonCareerBindings = values.get('--bangumi-person-career-bindings-file');
  if (bangumiPersonCareerBindings !== undefined && (source !== 'bangumi' || !bangumiPersonCareerBindings.trim()))
    throw new ImportCliInputFailure();

  const checkpointStaging = flags.has('--checkpoint-staging');
  const resumeStaging = flags.has('--resume-staging');
  const checkpointAcquisition = flags.has('--checkpoint-acquisition');
  const resumeAcquisition = flags.has('--resume-acquisition');
  const modeCount = [checkpointStaging, resumeStaging, checkpointAcquisition, resumeAcquisition].filter(Boolean).length;
  if (modeCount > 1) throw new ImportCliInputFailure();
  const generation = values.get('--generation');
  const acquisition = values.get('--acquisition');
  if (resumeStaging) {
    if (!generation || !/^[1-9][0-9]*$/.test(generation)) throw new ImportCliInputFailure();
  } else if (generation !== undefined) {
    throw new ImportCliInputFailure();
  }
  if (resumeAcquisition) {
    if (!acquisition || !isVndbAcquisitionId(acquisition)) throw new ImportCliInputFailure();
  } else if (acquisition !== undefined) {
    throw new ImportCliInputFailure();
  }
  const result: ImportCliConfig = {
    source: source as ImportCliSourceKind,
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
    ...(bangumiGameGenreBindings === undefined ? {} : { bangumiGameGenreBindings }),
    ...(bangumiPersonCareerBindings === undefined ? {} : { bangumiPersonCareerBindings }),
  };
  const compression = values.get('--compression');
  if (compression !== undefined) result.compression = parseDumpCompression(compression);
  if (result.compression === 'zstd' && dump === '-') throw new ImportCliInputFailure();
  const zstdExecutable = values.get('--zstd-executable');
  if (zstdExecutable !== undefined) {
    if (result.compression !== 'zstd') throw new ImportCliInputFailure();
    result.zstdExecutable = zstdExecutable;
  }
  const decodeBudget = values.get('--decode-budget');
  if (decodeBudget !== undefined) {
    if (result.dumpSet === undefined && result.compression !== 'gzip' && result.compression !== 'zstd')
      throw new ImportCliInputFailure();
    if (!/^[1-9][0-9]{0,15}$/.test(decodeBudget)) throw new ImportCliInputFailure();
    const parsedBudget = Number(decodeBudget);
    if (!Number.isSafeInteger(parsedBudget) || parsedBudget <= 0) throw new ImportCliInputFailure();
    result.decodeBudget = parsedBudget;
  }
  const progressMode = values.get('--progress');
  if (progressMode !== undefined) {
    if (progressMode !== 'human' && progressMode !== 'jsonl') throw new ImportCliInputFailure();
    result.progressMode = progressMode;
  }
  const sourceAlias = values.get('--source-alias');
  if (sourceAlias !== undefined) result.sourceAlias = sourceAlias;
  const threshold = values.get('--disappearance-threshold');
  if (threshold !== undefined) {
    if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(threshold)) throw new ImportCliInputFailure();
    const parsed = Number(threshold);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new ImportCliInputFailure();
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

export function admitImportCliConfig(config: ImportCliConfig, testOrigin?: string): ImportCliConfig {
  const api = validateImportCliApiOrigin(config.api, testOrigin);
  const auth = parseImportCliOrigin(config.auth);
  if (auth.protocol !== 'https:') throw new ImportCliInputFailure();
  return { ...config, api, auth: auth.origin };
}
