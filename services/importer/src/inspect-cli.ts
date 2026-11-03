import {
  InspectionFailure,
  InspectionStore,
  type DeferredCoverSummary,
  type InspectionDocument,
  type InspectionEnvelope,
  type InspectionPageKind,
  type InspectionRecord,
  type PendingEnvelopeSummary,
} from './inspection-store.ts';

const MAX_ARGUMENTS_WITH_COMMAND = 64;
const MAX_ARGUMENT_BYTES = 4096;
const MAX_TOTAL_ARGUMENT_BYTES = 16_384;
const USAGE = [
  'Usage: rezics-import inspect --state <sqlite-path> --source <configured-source-id>',
  '       [--generation <generation-id>] [--record <native-record-key>]',
  '       [--page pending|covers] [--limit 1..100] [--cursor <opaque-cursor>] [--json]',
  '       rezics-import inspect --help',
  'Pages default to 20 rows. Inspection is local and read-only; it never resumes a run.',
  'The document includes the recorded API origin and whether it was recorded on first use or declared for legacy state.',
].join('\n');

export type InspectCliResult = Readonly<{ code: number; stdout: string; stderr: string; openHandles: number }>;

export type InspectCliOptions = Readonly<{ signal?: AbortSignal }>;

export type ParsedInspectionArgs = Readonly<{
  state: string;
  request: {
    source: string;
    generation?: string;
    record?: string;
    page?: InspectionPageKind;
    limit?: number;
    cursor?: string;
  };
  json: boolean;
}>;

class UsageFailure extends InspectionFailure {
  constructor(message: string) {
    super(message, 2);
  }
}

function boundedArguments(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length + 1 > MAX_ARGUMENTS_WITH_COMMAND)
    throw new UsageFailure('Inspection arguments exceed the supported count.');
  let totalBytes = Buffer.byteLength('inspect', 'utf8');
  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.length > MAX_ARGUMENT_BYTES || argument.includes('\0'))
      throw new UsageFailure('Inspection arguments exceed the supported size.');
    totalBytes += Buffer.byteLength(argument, 'utf8');
    if (totalBytes > MAX_TOTAL_ARGUMENT_BYTES)
      throw new UsageFailure('Inspection arguments exceed the supported size.');
  }
}

export function parseInspectionArgs(argv: readonly string[]): ParsedInspectionArgs | 'help' {
  boundedArguments(argv);
  if (argv.length === 1 && argv[0] === '--help') return 'help';
  if (!Array.isArray(argv)) throw new UsageFailure('Inspection arguments are invalid.');

  const values = new Map<string, string>();
  const valueFlags = new Set(['--state', '--source', '--generation', '--record', '--page', '--limit', '--cursor']);
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--json') {
      if (json) throw new UsageFailure('Inspection flags cannot be repeated.');
      json = true;
      continue;
    }
    if (!valueFlags.has(flag) || values.has(flag))
      throw new UsageFailure('Unknown, import-only or repeated inspection flag.');
    const value = argv[++index];
    if (value === undefined || value.length === 0 || value.startsWith('--'))
      throw new UsageFailure(`Inspection flag ${flag} requires one value.`);
    values.set(flag, value);
  }

  const state = values.get('--state');
  const source = values.get('--source');
  if (!state || !state.trim() || state === '-' || state.length > MAX_ARGUMENT_BYTES || !source)
    throw new UsageFailure('Inspection requires --state <sqlite-path> and --source <configured-source-id>.');
  if (Buffer.byteLength(source, 'utf8') > 32 || !/^[a-z][a-z0-9_-]{0,31}$/u.test(source))
    throw new UsageFailure('--source must be an exact configured source identifier.');
  const request: ParsedInspectionArgs['request'] = { source };
  const generation = values.get('--generation');
  if (generation !== undefined) {
    if (
      Buffer.byteLength(generation, 'utf8') > 32 ||
      !/^[1-9][0-9]*$/u.test(generation) ||
      !Number.isSafeInteger(Number(generation))
    )
      throw new UsageFailure('--generation must be a positive stored generation ID.');
    request.generation = generation;
  }
  const record = values.get('--record');
  if (record !== undefined) {
    if (
      Buffer.byteLength(record, 'utf8') > 512 ||
      !/^(?:[\p{L}\p{N}][\p{L}\p{N}._:/@+\-]*|\/(?:works\/OL[1-9][0-9]*W|books\/OL[1-9][0-9]*M|authors\/OL[1-9][0-9]*A))$/u.test(
        record,
      )
    )
      throw new UsageFailure('--record must be an exact native source record key.');
    request.record = record;
  }
  const pageValue = values.get('--page');
  if (pageValue !== undefined) {
    if (pageValue !== 'pending' && pageValue !== 'covers') throw new UsageFailure('--page must be pending or covers.');
    request.page = pageValue;
  }
  const limitValue = values.get('--limit');
  if (limitValue !== undefined) {
    if (!/^(?:[1-9][0-9]{0,2})$/u.test(limitValue))
      throw new UsageFailure('--limit must be an integer from 1 through 100.');
    const limit = Number(limitValue);
    if (limit > 100) throw new UsageFailure('--limit must be an integer from 1 through 100.');
    if (request.page === undefined) throw new UsageFailure('--limit requires --page pending|covers.');
    request.limit = limit;
  }
  const cursor = values.get('--cursor');
  if (cursor !== undefined) {
    if (request.page === undefined) throw new UsageFailure('--cursor requires --page pending|covers.');
    request.cursor = cursor;
  }
  return { state, request, json };
}

function jsonSafe(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  );
}

function terminalString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  );
}

function count(value: number | null, whenUnknown = 'unknown'): string {
  return value === null ? whenUnknown : String(value);
}

function commandOperations(
  value: readonly { fieldGroup: string; operation: string; unresolved: number; settled: number }[],
): string {
  return value.length
    ? value
        .map((item) => `${item.fieldGroup}/${item.operation}: unresolved ${item.unresolved}, settled ${item.settled}`)
        .join('; ')
    : 'none stored';
}

function renderRecord(record: InspectionRecord): string[] {
  const lines = [`Exact record ${terminalString(record.recordKey)}:`];
  if (!record.found) {
    lines.push('  No entry exists for this key in the selected generation.');
    return lines;
  }
  lines.push(`  Source record state: ${record.state}`);
  lines.push(`  Record revision: ${terminalString(record.recordRevision ?? '')}`);
  lines.push(`  Converter revision: ${terminalString(record.converterRevision ?? '')}`);
  lines.push(`  Record digest: ${record.digest}`);
  lines.push(`  Classification: ${record.classification ?? 'not classified'}`);
  lines.push(`  Resolved in this generation: ${record.resolved ? 'yes' : 'no'}`);
  lines.push(`  Unresolved commands: ${record.unresolvedCommands ?? 'unknown'}`);
  lines.push(`  Deferred cover: ${record.deferredCover ? 'pending' : 'no'}`);
  lines.push(
    `  Fence omissions: ${record.omittedFieldGroups?.length ? record.omittedFieldGroups.join(', ') : 'none recorded'}`,
  );
  lines.push(
    `  Local source-key completion row retained: ${record.localCompletionRetained ? 'yes' : 'no'}; it is not generation-scoped, not a current selected/public read, and not proof of publication.`,
  );
  if (!record.envelopes?.length) {
    lines.push('  Prepared request envelopes: none retained for this record.');
    return lines;
  }
  lines.push('  Prepared request envelopes:');
  for (const envelope of record.envelopes) lines.push(...renderEnvelope(envelope));
  return lines;
}

function renderEnvelope(envelope: InspectionEnvelope): string[] {
  const lines = [
    `    #${envelope.index}: ${envelope.delivery}; ${envelope.byteLength} bytes; SHA-256 ${envelope.sha256}${envelope.multiEnvelope ? '; multi-envelope record' : ''}`,
  ];
  for (const command of envelope.commands) {
    lines.push(`      ${terminalString(command.key)} ${command.fieldGroup}/${command.operation}: ${command.delivery}`);
  }
  return lines;
}

function isPending(row: PendingEnvelopeSummary | DeferredCoverSummary): row is PendingEnvelopeSummary {
  return Object.hasOwn(row, 'envelopeIndex');
}

function renderPage(page: NonNullable<InspectionDocument['page']>): string[] {
  const heading = page.kind === 'pending' ? 'Pending envelope page' : 'Deferred cover page';
  const lines = [`${heading} (${page.rows.length} of at most ${page.limit} rows):`];
  for (const row of page.rows) {
    if (isPending(row)) {
      lines.push(
        `  ${terminalString(row.recordKey)} classification=${row.classification ?? 'unknown'} envelope=${row.envelopeIndex} unresolved=${row.unresolvedCommands}; ${commandOperations(row.fieldOperations)}`,
      );
    } else {
      lines.push(
        `  ${terminalString(row.recordKey)} classification=${row.classification ?? 'unknown'} unresolved=${row.unresolvedCommands}; ${commandOperations(row.fieldOperations)}; fence omissions=${row.omittedFieldGroups.length ? row.omittedFieldGroups.join(', ') : 'none'}`,
      );
    }
  }
  lines.push(
    page.end === 'more'
      ? `More work is available. Next cursor: ${page.nextCursor}`
      : 'End of this live page; no next cursor.',
  );
  lines.push(
    'Each page is one short consistent read. A writer can settle work between invocations; absence from a later page is not evidence that this view observed delivery.',
  );
  return lines;
}

function resumeInvocation(
  source: string,
  status: string,
  generation?: string,
  checkpoint?: NonNullable<InspectionDocument['generation']>['checkpoint'],
): string[] {
  const threshold = status === 'mass-disappearance' ? ' [--disappearance-threshold <reviewed-0..1>]' : '';
  if (status === 'staging' && checkpoint && generation) {
    return [
      'Return to checkpointed staging with the original files; this does not replace input:',
      `  bun services/importer/src/cli.ts --source <original-source-kind> --source-alias ${terminalString(source)} --dump <original-file> --state <same-state-path> --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin> --resume-staging --generation ${terminalString(generation)}`,
      `  bun services/importer/src/cli.ts --source openlibrary --source-alias ${terminalString(source)} --dump-set <original-manifest> --state <same-state-path> --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin> --resume-staging --generation ${terminalString(generation)}`,
      'Resume re-hashes every original file and replays the production decoder from the start of each member to verify the committed prefix. Inspection does not establish authorization or remote effect.',
    ];
  }
  if (status === 'ready' || status === 'finalizing') {
    return [
      'This generation is already sealed. Resume with the ordinary import command; do not replace input or use --resume-staging:',
      `  bun services/importer/src/cli.ts --source <original-source-kind> --source-alias ${terminalString(source)} --dump <complete-input-path> --state <same-state-path> --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>`,
      'Sealed recovery rechecks current authority and replays original requests. Inspection does not establish authorization or remote effect.',
    ];
  }
  return [
    'Return to the existing authorized importer after reviewing the retained context:',
    `  bun services/importer/src/cli.ts --source <original-source-kind> --source-alias ${terminalString(source)} --dump <complete-input-path> --state <same-state-path> --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>${threshold}`,
    'The existing import flow rechecks current authority, complete input integrity, source registration, fences and single-owner admission. Inspection does not establish authorization or remote effect.',
  ];
}

function renderDestination(document: InspectionDocument): string {
  if (document.destination.status === 'unavailable')
    return 'API destination: unavailable or damaged. Use backup; do not invent an origin.';
  if (document.destination.status === 'unbound')
    return 'API destination: not recorded. This source history is unbound. Review and declare the original origin with rezics-import destination before importing. Same-origin server replacement cannot be detected without a separately released deployment identity.';
  const recorded =
    document.destination.recorded === 'operator-declared'
      ? 'operator-declared for legacy state; this is local configuration, not verified historical destination evidence'
      : 'recorded on first use';
  return `API destination: ${document.destination.origin} (${recorded}).`;
}

export function renderInspection(document: InspectionDocument): string {
  const lines = [`Source: ${terminalString(document.source)}`, `Source state: ${document.sourceState}`];
  lines.push(renderDestination(document));
  if (document.sourceState === 'absent') lines.push('No state exists for this source identifier.');
  if (document.sourceState === 'uninitialized')
    lines.push('State exists, but there is no active generation or completed baseline.');
  if (document.baseline) {
    lines.push(
      `Completed baseline: generation ${terminalString(document.baseline.generation)}, present records ${document.baseline.presentCount}${document.baseline.empty ? ' (recognized empty completed source)' : ''}.`,
    );
  } else {
    lines.push('Completed baseline: none recorded.');
  }
  if (document.selection)
    lines.push(
      `Viewed generation: ${terminalString(document.selection.generation)} (${document.selection.kind} selection).`,
    );
  if (document.generation) {
    const generation = document.generation;
    lines.push(`Stored status: ${terminalString(generation.status)}; phase: ${generation.phase}.`);
    lines.push(
      `Retained work: ${generation.activeWork.length ? generation.activeWork.join(', ') : 'no pending envelopes or deferred covers reported'}.`,
    );
    lines.push('Stored phase counts:');
    lines.push(`  prior active membership: ${count(generation.counts.priorMembership)}`);
    lines.push(`  supplied records: ${count(generation.counts.supplied)}`);
    lines.push(`  surviving prior members: ${count(generation.counts.survivors)}`);
    lines.push(`  skipped records: ${count(generation.counts.skipped)}`);
    lines.push(
      `  invalid input flag: ${generation.counts.invalidInputFlag === null ? 'unknown' : generation.counts.invalidInputFlag ? 'set' : 'not set'}`,
    );
    lines.push(`  classified: ${count(generation.counts.classified)}`);
    lines.push(`  resolved: ${count(generation.counts.resolved)}`);
    lines.push(`  expected after sealing: ${count(generation.counts.expected, 'not set during acquisition')}`);
    lines.push(`  prepared records: ${count(generation.counts.prepared)}`);
    if (document.baseline)
      lines.push(
        'Retained progress belongs to the viewed generation; it does not replace the completed baseline until ordinary finalization succeeds.',
      );
    lines.push(`Resume behavior: ${generation.resume}`);
    if (generation.checkpoint)
      lines.push(
        `Checkpoint: committed prefix ${generation.checkpoint.committedOrdinal} records${
          generation.checkpoint.memberCount > 1 || generation.checkpoint.completedMembers > 0
            ? `, ${generation.checkpoint.completedMembers} of ${generation.checkpoint.memberCount} members complete`
            : ''
        }, ${generation.checkpoint.bytes} hashed bytes, source kind ${generation.checkpoint.sourceKind}, converter ${generation.checkpoint.converterRevision}.`,
      );
  }
  lines.push(`Ownership row present: ${document.ownershipRow}; this is not a liveness or lease-capability check.`);
  if (document.record) lines.push(...renderRecord(document.record));
  if (document.page) lines.push(...renderPage(document.page));
  if (document.generation)
    lines.push(
      ...resumeInvocation(
        document.source,
        document.generation.status,
        document.generation.id,
        document.generation.checkpoint,
      ),
    );
  lines.push('Other subsystem journals are outside this source-dump view.');
  return `${lines.join('\n')}\n`;
}

function errorMessage(error: unknown): { code: number; message: string } {
  if (error instanceof InspectionFailure) return { code: error.code, message: error.message };
  return { code: 1, message: 'Inspection failed safely; importer state was not changed.' };
}

function terminalSafeMessage(value: string): string {
  return value.replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  );
}

function requestedJson(argv: readonly string[]): boolean {
  return Array.isArray(argv) && argv.includes('--json');
}

/** Read-only inspection route. It does not construct credentials, transport or importer objects. */
export async function runInspectCli(
  argv: readonly string[],
  options: InspectCliOptions = {},
): Promise<InspectCliResult> {
  const jsonRequested = requestedJson(argv);
  let parsed: ParsedInspectionArgs | 'help';
  try {
    parsed = parseInspectionArgs(argv);
    if (parsed === 'help') return { code: 0, stdout: `${USAGE}\n`, stderr: '', openHandles: 0 };
  } catch (error) {
    const detail = errorMessage(error);
    if (jsonRequested)
      return {
        code: detail.code,
        stdout: `${jsonSafe({ version: 1, error: detail.message })}\n`,
        stderr: '',
        openHandles: 0,
      };
    return {
      code: detail.code,
      stdout: '',
      stderr: `${terminalSafeMessage(detail.message)}\n${USAGE}\n`,
      openHandles: 0,
    };
  }

  let store: InspectionStore | undefined;
  let document: InspectionDocument | undefined;
  let failure: { code: number; message: string } | undefined;
  try {
    if (options.signal?.aborted) throw new InspectionFailure('Inspection was cancelled.', 130);
    store = await InspectionStore.open(parsed.state);
    document = store.inspect(parsed.request, options.signal);
  } catch (error) {
    failure = errorMessage(error);
  } finally {
    await store?.close();
  }
  if (failure) {
    if (parsed.json)
      return {
        code: failure.code,
        stdout: `${jsonSafe({ version: 1, error: failure.message })}\n`,
        stderr: '',
        openHandles: 0,
      };
    return { code: failure.code, stdout: '', stderr: `${terminalSafeMessage(failure.message)}\n`, openHandles: 0 };
  }
  try {
    return {
      code: 0,
      stdout: parsed.json ? `${jsonSafe(document)}\n` : renderInspection(document!),
      stderr: '',
      openHandles: 0,
    };
  } catch {
    const message = 'Inspection presentation failed safely; importer state was not changed.';
    return parsed.json
      ? { code: 1, stdout: `${jsonSafe({ version: 1, error: message })}\n`, stderr: '', openHandles: 0 }
      : { code: 1, stdout: '', stderr: `${message}\n`, openHandles: 0 };
  }
}
