import { Database } from 'bun:sqlite';
import { InspectionFailure } from './inspection-open.ts';
import { ImportSession, importOwnerIsBusy, readImportOwner } from './import-session.ts';
import { ResumeStateError } from './resume-state.ts';
import {
  DESTINATION_REVIEW_REVISION,
  SourceDestinationError,
  destinationSourceId,
  insertSourceDestination,
  mismatchMessage,
  normalizeApiOrigin,
  openDestinationReview,
  reviewSourceDestination,
  type SourceDestinationReview,
} from './source-destination.ts';

const MAX_ARGUMENTS_WITH_COMMAND = 64;
const MAX_ARGUMENT_BYTES = 4096;
const MAX_TOTAL_ARGUMENT_BYTES = 16_384;

export const DESTINATION_USAGE = [
  'Usage: rezics-import destination --state <sqlite-path> --source <configured-source-id> --api <https-origin> [--json]',
  '       rezics-import destination --state <sqlite-path> --source <configured-source-id> --api <https-origin>',
  '       --review-revision <64-hex> --declare --acknowledge-unverified [--json]',
  '       rezics-import destination --help',
  'Default is a bounded read-only review of one exact source destination. It never contacts Auth or the API and never writes.',
  'Declaration records the operator-supplied origin as local configuration, not verified historical destination evidence.',
  'It changes only destination metadata. Generations, pending requests, native identifiers, acknowledgements, observation heads and the baseline stay intact.',
  'An already-bound source cannot be rebound. Ordinary import never adopts an origin from --api.',
  'Same-origin server replacement cannot be detected without a separately released deployment identity.',
].join('\n');

export type DestinationCliResult = Readonly<{ code: number; stdout: string; stderr: string; openHandles: number }>;
export type DestinationCliOptions = Readonly<{
  signal?: AbortSignal;
  testOrigin?: string;
  instrumentDatabase?: (database: Database) => Database;
}>;

type Parsed =
  | 'help'
  | {
      state: string;
      source: string;
      api: string;
      json: boolean;
      declare: boolean;
      acknowledge: boolean;
      reviewRevision?: string;
    };

class UsageFailure extends SourceDestinationError {
  constructor(message: string) {
    super(message, 'usage');
  }
}

function boundedArguments(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length + 1 > MAX_ARGUMENTS_WITH_COMMAND)
    throw new UsageFailure('Destination arguments exceed the supported count.');
  let totalBytes = Buffer.byteLength('destination', 'utf8');
  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.length > MAX_ARGUMENT_BYTES || argument.includes('\0'))
      throw new UsageFailure('Destination arguments exceed the supported size.');
    totalBytes += Buffer.byteLength(argument, 'utf8');
    if (totalBytes > MAX_TOTAL_ARGUMENT_BYTES)
      throw new UsageFailure('Destination arguments exceed the supported size.');
  }
}

function jsonSafe(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  );
}

function terminalSafe(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function parseDestinationArgs(argv: readonly string[]): Parsed {
  boundedArguments(argv);
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) return 'help';
  const values = new Map<string, string>();
  const valueFlags = new Set(['--state', '--source', '--api', '--review-revision']);
  let json = false;
  let declare = false;
  let acknowledge = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--help') throw new UsageFailure('Destination help cannot be mixed with other flags.');
    if (flag === '--json') {
      if (json) throw new UsageFailure('Destination flags cannot be repeated.');
      json = true;
      continue;
    }
    if (flag === '--declare') {
      if (declare) throw new UsageFailure('Destination flags cannot be repeated.');
      declare = true;
      continue;
    }
    if (flag === '--acknowledge-unverified') {
      if (acknowledge) throw new UsageFailure('Destination flags cannot be repeated.');
      acknowledge = true;
      continue;
    }
    if (!valueFlags.has(flag) || values.has(flag))
      throw new UsageFailure('Unknown, import-only or repeated destination flag.');
    const value = argv[++index];
    if (value === undefined || value.length === 0 || value.startsWith('--'))
      throw new UsageFailure(`Destination flag ${flag} requires one value.`);
    values.set(flag, value);
  }
  const state = values.get('--state');
  const source = values.get('--source');
  const api = values.get('--api');
  if (!state || !state.trim() || state === '-' || !source || !api)
    throw new UsageFailure(
      'Destination review requires --state <sqlite-path> --source <configured-source-id> --api <https-origin>.',
    );
  destinationSourceId(source);
  const reviewRevision = values.get('--review-revision');
  if (declare) {
    if (!acknowledge)
      throw new UsageFailure(
        'Declaration requires --declare --acknowledge-unverified and the exact source, origin and review revision.',
      );
    if (!reviewRevision || !DESTINATION_REVIEW_REVISION.test(reviewRevision))
      throw new UsageFailure('--review-revision must be the 64-hex fingerprint from destination review.');
    return { state, source, api, json, declare: true, acknowledge: true, reviewRevision };
  }
  if (acknowledge || reviewRevision)
    throw new UsageFailure('--declare is required to apply a destination declaration.');
  return { state, source, api, json, declare: false, acknowledge: false };
}

export function renderDestinationReview(document: SourceDestinationReview, declared = false): string {
  const recorded =
    document.recorded === 'first-use'
      ? 'recorded on first use'
      : document.recorded === 'operator-declared'
        ? 'operator-declared for legacy state'
        : 'not recorded';
  const lines = [
    `Source: ${JSON.stringify(document.source)}`,
    `Selected origin: ${document.selectedOrigin}`,
    `Destination status: ${document.status}`,
    `Recorded origin: ${document.origin ?? 'none'} (${recorded})`,
    document.activeGeneration
      ? `Active generation: ${document.activeGeneration.id} (${document.activeGeneration.status})`
      : 'Active generation: none',
    `Pending work: envelopes ${document.pendingWork.envelopes}, deferred covers ${document.pendingWork.deferredCovers}`,
    `Review revision: ${document.reviewRevision}`,
    document.note,
  ];
  if (declared)
    lines.push(
      'Declared this origin as local operator configuration. Original requests, keys, acknowledgements, observation heads and the baseline are unchanged.',
    );
  else if (document.status === 'unbound')
    lines.push(
      `Declare with: bun services/importer/src/cli.ts destination --state <same-state-path> --source ${JSON.stringify(document.source)} --api ${document.selectedOrigin} --review-revision ${document.reviewRevision} --declare --acknowledge-unverified`,
    );
  else if (document.status === 'absent')
    lines.push(
      'Ordinary import records the API origin on first use. Declaration is only for existing unbound history.',
    );
  return `${lines.map(terminalSafe).join('\n')}\n`;
}

function refuseLiveOwner(owner: { pid: number; birth: string } | null): void {
  if (owner && importOwnerIsBusy(owner))
    throw new SourceDestinationError('A live or uninspectable owner holds this source.', 'busy', 5);
}

function refuseDeclaration(current: SourceDestinationReview, source: string, reviewRevision: string): void {
  if (current.status === 'unavailable')
    throw new SourceDestinationError(
      'Destination metadata is damaged or unreadable; importer state was not changed.',
      'unavailable',
    );
  if (current.status === 'bound')
    throw new SourceDestinationError(
      `Source ${JSON.stringify(source)} already has recorded origin ${current.origin}. Declaration cannot rebind it.`,
      'already-bound',
    );
  if (current.status === 'absent')
    throw new SourceDestinationError(
      'This identifier has no local history to declare. Ordinary import records the API origin on first use.',
      'empty',
    );
  if (current.reviewRevision !== reviewRevision)
    throw new SourceDestinationError(
      'Destination review is stale; inspect again and declare against the current local revision.',
      'stale',
    );
}

function declareOnDatabase(
  database: Database,
  source: string,
  origin: string,
  reviewRevision: string,
): SourceDestinationReview {
  refuseLiveOwner(readImportOwner(database, source));
  refuseDeclaration(reviewSourceDestination(database, source, origin), source, reviewRevision);
  return database
    .transaction(() => {
      refuseLiveOwner(readImportOwner(database, source));
      const afterLock = reviewSourceDestination(database, source, origin);
      refuseDeclaration(afterLock, source, reviewRevision);
      insertSourceDestination(database, source, origin, 'operator-declared');
      return reviewSourceDestination(database, source, origin);
    })
    .immediate();
}

function failure(error: unknown, json: boolean): DestinationCliResult {
  const missing =
    (error instanceof ResumeStateError && error.kind === 'missing') ||
    (error instanceof Error &&
      /No importer state database exists|unable to open database|SQLITE_CANTOPEN/i.test(error.message));
  const code =
    error instanceof SourceDestinationError
      ? error.exitCode
      : error instanceof InspectionFailure
        ? error.code
        : error instanceof ResumeStateError
          ? error.kind === 'busy-lock'
            ? 1
            : 2
          : missing
            ? 2
            : 1;
  const message =
    error instanceof SourceDestinationError || error instanceof InspectionFailure
      ? error.message
      : error instanceof ResumeStateError && error.kind !== 'missing'
        ? error.message
        : missing
          ? 'State file does not exist or is not a supported importer database.'
          : 'Destination command failed safely; importer state was not changed.';
  if (json) return { code, stdout: `${jsonSafe({ version: 1, error: message })}\n`, stderr: '', openHandles: 0 };
  return { code, stdout: '', stderr: `${terminalSafe(message)}\n`, openHandles: 0 };
}

export async function runDestinationCli(
  argv: readonly string[],
  options: DestinationCliOptions = {},
): Promise<DestinationCliResult> {
  const jsonRequested = Array.isArray(argv) && argv.includes('--json');
  let parsed: Parsed;
  try {
    parsed = parseDestinationArgs(argv);
  } catch (error) {
    const result = failure(error, jsonRequested);
    if (result.code === 2 && !jsonRequested) return { ...result, stderr: `${result.stderr}${DESTINATION_USAGE}\n` };
    return result;
  }
  if (parsed === 'help') return { code: 0, stdout: `${DESTINATION_USAGE}\n`, stderr: '', openHandles: 0 };
  if (options.signal?.aborted)
    return failure(new SourceDestinationError('Destination command was cancelled.', 'usage', 130), parsed.json);
  let origin: string;
  try {
    origin = normalizeApiOrigin(parsed.api, options.testOrigin);
  } catch (error) {
    return failure(error, parsed.json);
  }

  if (!parsed.declare) {
    try {
      const document = await openDestinationReview({
        statePath: parsed.state,
        source: parsed.source,
        origin,
      });
      return {
        code: 0,
        stdout: parsed.json ? `${jsonSafe(document)}\n` : renderDestinationReview(document),
        stderr: '',
        openHandles: 0,
      };
    } catch (error) {
      return failure(error, parsed.json);
    }
  }

  let opened: { close(): void } | undefined;
  try {
    const declared = await ImportSession.openDestinationDeclaration(parsed.state, {
      ...(options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {}),
    });
    opened = declared;
    const document = declareOnDatabase(declared.database, parsed.source, origin, parsed.reviewRevision!);
    return {
      code: 0,
      stdout: parsed.json ? `${jsonSafe({ ...document, declared: true })}\n` : renderDestinationReview(document, true),
      stderr: '',
      openHandles: 0,
    };
  } catch (error) {
    return failure(error, parsed.json);
  } finally {
    opened?.close();
  }
}

export { mismatchMessage };
