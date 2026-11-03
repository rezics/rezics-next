import { Database } from 'bun:sqlite';
import { createAccountTokenProvider, CredentialInputError, VNDB_IMPORTER_SCOPES } from './credentials.ts';
import { createImporter } from './importer.ts';
import { createImportTransport } from './import-client.ts';
import { ImportSession } from './import-session.ts';
import {
  SourceDestinationError,
  mismatchMessage,
  preflightSourceDestination,
  unboundMessage,
} from './source-destination.ts';
import {
  DIGEST,
  SOURCE_OBSERVATION_PAGE_MAX,
  isIntendedObservation,
  nativeReason,
  parseObservationReason,
  safeObservationSummary,
  type AggregateOperationStatus,
  type IntendedObservation,
  type RetainedObservationHead,
} from './source-observation.ts';
import { isIntendedClassification } from './source-classification.ts';

const SOURCE = /^[a-z][a-z0-9_-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT = /^[A-Za-z0-9._~-]{1,255}$/;

export const observationsUsage = () =>
  [
    'Usage: rezics-import observations --state <sqlite-path> --source <configured-source-id>',
    '       [--after <operation-id>] [--limit 1..20]',
    '       rezics-import observations --state <sqlite-path> --source <configured-source-id> --operation <operation-id>',
    '       rezics-import observations --state <sqlite-path> --source <configured-source-id> --operation <operation-id>',
    '       --resolve --reviewed-observation <64-hex> --api <https-origin> --account-key <path>',
    '       --account <uuid> --client <client-id> --auth <https-origin>',
    'Lists at most 20 unresolved source-observation operations per page. Detail and resolve use the stable operation id.',
    'A source figure is independent of a REZICS vote. Older dates cannot be forced with CAS; supply corrected input.',
    'Resume an uncertain delivery with the ordinary import command; it reuses the sealed body and key.',
    'Resolve checks the source destination before credentials. A mistyped --api fails without contacting Auth.',
  ].join('\n');

export type ObservationsCliResult = { code: number; stdout: string; stderr: string; openHandles: number };
export type ObservationsCliOptions = {
  signal?: AbortSignal;
  fetch?: typeof fetch;
  testOrigin?: string;
  instrumentDatabase?: (database: Database) => Database;
};

class InputFailure extends Error {
  constructor(message = 'Invalid observation arguments.') {
    super(message);
  }
}

export type ObservationArgs =
  | 'help'
  | {
      state: string;
      source: string;
      after?: string;
      limit: number;
      operation?: string;
      resolve: boolean;
      reviewedObservation?: string;
      api?: string;
      accountKey?: string;
      account?: string;
      client?: string;
      auth?: string;
    };

function bounded(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length > 64) throw new InputFailure();
  let total = Buffer.byteLength('observations');
  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.length > 4096 || argument.includes('\0')) throw new InputFailure();
    total += Buffer.byteLength(argument);
    if (total > 16384) throw new InputFailure();
  }
}

export function parseObservationArgs(argv: readonly string[]): ObservationArgs {
  bounded(argv);
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) return 'help';
  const values = new Map<string, string>();
  const flags = new Set([
    '--state',
    '--source',
    '--after',
    '--limit',
    '--operation',
    '--reviewed-observation',
    '--api',
    '--account-key',
    '--account',
    '--client',
    '--auth',
  ]);
  let resolve = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--resolve') {
      if (resolve) throw new InputFailure('Observation flags cannot be repeated.');
      resolve = true;
      continue;
    }
    if (flag === '--help') throw new InputFailure();
    if (!flags.has(flag) || values.has(flag)) throw new InputFailure('Unknown, obsolete or repeated observation flag.');
    const value = argv[++index];
    if (value === undefined || value.length === 0 || value.startsWith('--'))
      throw new InputFailure(`Observation flag ${flag} requires one value.`);
    values.set(flag, value);
  }
  const state = values.get('--state');
  const source = values.get('--source');
  if (!state || !state.trim() || state === '-' || !source || !SOURCE.test(source))
    throw new InputFailure('Observations require --state <sqlite-path> and --source <configured-source-id>.');
  const limitText = values.get('--limit');
  const limit = limitText === undefined ? 20 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > SOURCE_OBSERVATION_PAGE_MAX)
    throw new InputFailure('--limit must be an integer from 1 through 20.');
  const after = values.get('--after');
  if (after !== undefined && !DIGEST.test(after)) throw new InputFailure('--after must be a 64-hex operation id.');
  const operation = values.get('--operation');
  if (operation !== undefined && !DIGEST.test(operation))
    throw new InputFailure('--operation must be a 64-hex operation id.');
  if (after !== undefined && operation !== undefined)
    throw new InputFailure('--after cannot be combined with --operation.');
  const reviewed = values.get('--reviewed-observation');
  if (reviewed !== undefined && !DIGEST.test(reviewed))
    throw new InputFailure('--reviewed-observation must be the 64-hex head shown in the reviewed detail.');
  if (resolve) {
    if (!operation) throw new InputFailure('--resolve requires --operation <operation-id>.');
    if (!reviewed) throw new InputFailure('--resolve requires --reviewed-observation matching the reviewed head.');
    const api = values.get('--api');
    const accountKey = values.get('--account-key');
    const account = values.get('--account');
    const client = values.get('--client');
    const auth = values.get('--auth');
    if (!api || !accountKey || !account || !UUID.test(account) || !client || !CLIENT.test(client) || !auth)
      throw new InputFailure('Resolve requires --api --account-key --account --client --auth.');
    return {
      state,
      source,
      limit,
      operation,
      resolve: true,
      reviewedObservation: reviewed,
      api,
      accountKey,
      account,
      client,
      auth,
    };
  }
  if (reviewed || values.has('--api') || values.has('--account-key'))
    throw new InputFailure('Credential flags are only valid with --resolve.');
  return {
    state,
    source,
    limit,
    resolve: false,
    ...(after ? { after } : {}),
    ...(operation ? { operation } : {}),
  };
}

function origin(value: string, testOrigin?: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InputFailure();
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.hostname)
    throw new InputFailure();
  if (testOrigin) {
    const test = new URL(testOrigin);
    if (test.protocol !== 'http:' || test.hostname !== '127.0.0.1' || url.origin !== test.origin)
      throw new InputFailure();
    return url.origin;
  }
  if (url.protocol !== 'https:') throw new InputFailure();
  return url.origin;
}

function render(operation: {
  operationId: string;
  recordKey: string;
  subjectId: string;
  sourceAlias: string;
  intended: unknown;
  reviewedHead: unknown;
  status: AggregateOperationStatus;
  nativeReason: string | null;
}): string {
  if (isIntendedClassification(operation.intended)) throw new InputFailure('Not an observation operation.');
  const reason = parseObservationReason(operation.nativeReason);
  return `${JSON.stringify(
    safeObservationSummary({
      operationId: operation.operationId,
      recordKey: operation.recordKey,
      subjectId: operation.subjectId,
      provider: 'vndb',
      sourceAlias: operation.sourceAlias,
      intended: operation.intended as IntendedObservation,
      head: (operation.reviewedHead as RetainedObservationHead | null) ?? null,
      status: operation.status,
      ...(reason ? { reason } : {}),
    }),
    null,
    2,
  )}\n`;
}

export async function runObservationsCli(
  argv: readonly string[],
  options: ObservationsCliOptions = {},
): Promise<ObservationsCliResult> {
  let parsed: ObservationArgs;
  try {
    parsed = parseObservationArgs(argv);
  } catch (error) {
    return {
      code: 2,
      stdout: '',
      stderr: `${error instanceof InputFailure ? error.message : 'Invalid observation arguments.'}\n${observationsUsage()}\n`,
      openHandles: 0,
    };
  }
  if (parsed === 'help') return { code: 0, stdout: `${observationsUsage()}\n`, stderr: '', openHandles: 0 };
  if (parsed.resolve) return runResolve(parsed, options);

  let session: ImportSession | undefined;
  try {
    session = new ImportSession(
      parsed.state,
      options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {},
    );
    const run = session.store.activeRun(parsed.source);
    if (!run)
      return {
        code: 2,
        stdout: '',
        stderr: 'No active source run owns observation operations for this state.\n',
        openHandles: 0,
      };
    if (parsed.operation) {
      const detail = session.store.aggregateOperation(run, parsed.operation);
      if (!detail || isIntendedClassification(detail.intended))
        return {
          code: 2,
          stdout: '',
          stderr: 'Unknown, obsolete, wrong-run or already-resolved observation operation.\n',
          openHandles: 0,
        };
      if (!isIntendedObservation(detail.intended))
        return {
          code: 2,
          stdout: '',
          stderr: 'Unknown, obsolete, wrong-run or already-resolved observation operation.\n',
          openHandles: 0,
        };
      return {
        code: 0,
        stdout: render({
          ...detail,
          intended: detail.intended,
          reviewedHead: detail.reviewedHead as RetainedObservationHead | null,
        }),
        stderr: '',
        openHandles: 0,
      };
    }
    const page = session.store.pageUnresolvedAggregates(run, {
      ...(parsed.after ? { after: parsed.after } : {}),
      limit: parsed.limit,
      family: 'statistic',
    });
    const lines = [
      'Unresolved source observations (at most 20 per page). A source figure is independent of a REZICS vote.',
      ...page.operations.map(
        (operation) =>
          `${operation.operationId}  ${operation.recordKey}  ${operation.intended.asOf}  ${operation.intended.kind}  ${operation.status}${
            operation.nativeReason
              ? `  ${nativeReason(parseObservationReason(operation.nativeReason) ?? 'cas-mismatch')}`
              : ''
          }`,
      ),
      page.next ? `next --after ${page.next}` : 'end of page',
    ];
    return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '', openHandles: 0 };
  } catch (error) {
    return {
      code: error instanceof InputFailure ? 2 : 1,
      stdout: '',
      stderr: `${error instanceof InputFailure ? error.message : 'Observation inspection failed safely.'}\n`,
      openHandles: 0,
    };
  } finally {
    session?.close();
  }
}

async function runResolve(
  parsed: Exclude<ObservationArgs, 'help'>,
  options: ObservationsCliOptions,
): Promise<ObservationsCliResult> {
  const signal = options.signal ?? new AbortController().signal;
  let importer: ReturnType<typeof createImporter> | undefined;
  try {
    const api = origin(parsed.api!, options.testOrigin);
    const auth = origin(parsed.auth!);
    const destinationPreflight = await preflightSourceDestination({
      statePath: parsed.state,
      source: parsed.source,
      origin: api,
      missingState: 'error',
    });
    if (destinationPreflight.status === 'mismatch')
      throw new SourceDestinationError(mismatchMessage(parsed.source, api, destinationPreflight.binding), 'mismatch');
    if (destinationPreflight.status === 'unbound')
      throw new SourceDestinationError(unboundMessage(parsed.source), 'unbound');
    if (destinationPreflight.status === 'unavailable')
      throw new SourceDestinationError(destinationPreflight.message, 'unavailable', destinationPreflight.exitCode);
    const tokenProvider = await createAccountTokenProvider({
      accountKeyPath: parsed.accountKey!,
      account: parsed.account!,
      client: parsed.client!,
      authOrigin: auth,
      scopes: [...VNDB_IMPORTER_SCOPES, 'subject:read'],
      fetch: options.fetch ?? globalThis.fetch,
      signal,
    });
    const transport = createImportTransport({
      origin: api,
      tokenProvider,
      fetch: options.fetch ?? globalThis.fetch,
    });
    importer = createImporter({
      path: parsed.state,
      destination: { origin: api },
      transport: {
        batchWrite: (request) => transport.batch(request, signal),
        readFence: (tuple) =>
          transport.fence(
            { source: tuple.source, externalId: tuple.external_id, fieldGroup: tuple.field_group },
            signal,
          ),
        writeSourceStatistic: (input) => transport.writeSourceStatistic(input, signal),
        clearSourceStatistic: (input) => transport.clearSourceStatistic(input, signal),
        readSourceStatistics: (input) => transport.readSourceStatistics(input, signal),
        readPublicFigure: (input) => transport.readPublicFigure(input, signal),
      },
      ...(options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {}),
    });
    const result = await importer.resolveObservation(
      parsed.source,
      parsed.operation!,
      parsed.reviewedObservation!,
      signal,
    );
    if (result.status === 'busy')
      return { code: 5, stdout: '', stderr: 'This source already has an active import.\n', openHandles: 0 };
    if (result.status === 'resume')
      return {
        code: 2,
        stdout: '',
        stderr: 'Uncertain deliveries resume through the ordinary import command with the sealed body and key.\n',
        openHandles: 0,
      };
    if (result.status === 'unknown')
      return {
        code: 2,
        stdout: '',
        stderr: 'Unknown, obsolete, wrong-run or already-resolved observation operation.\n',
        openHandles: 0,
      };
    if (result.status === 'refused')
      return {
        code: 2,
        stdout: '',
        stderr: `${nativeReason('older-date')} Supply corrected authoritative input.\n`,
        openHandles: 0,
      };
    if (result.status === 'conflict')
      return {
        code: 6,
        stdout: '',
        stderr: 'The reviewed head no longer matches; inspect the operation and decide again.\n',
        openHandles: 0,
      };
    const detail = importer.observationDetail(parsed.source, result.operationId);
    return {
      code: 0,
      stdout:
        detail && isIntendedObservation(detail.intended)
          ? render({
              ...detail,
              intended: detail.intended,
              reviewedHead: detail.reviewedHead as RetainedObservationHead | null,
            })
          : `Resolved ${result.operationId}\n`,
      stderr: '',
      openHandles: 0,
    };
  } catch (error) {
    if (error instanceof SourceDestinationError)
      return { code: error.exitCode, stdout: '', stderr: `${error.message}\n`, openHandles: 0 };
    if (error instanceof CredentialInputError)
      return { code: 2, stdout: '', stderr: 'Input or account key is unavailable or invalid.\n', openHandles: 0 };
    if (error instanceof InputFailure) return { code: 2, stdout: '', stderr: `${error.message}\n`, openHandles: 0 };
    return {
      code: 1,
      stdout: '',
      stderr: 'Observation resolution failed; durable state is retained.\n',
      openHandles: 0,
    };
  } finally {
    await importer?.close();
  }
}
