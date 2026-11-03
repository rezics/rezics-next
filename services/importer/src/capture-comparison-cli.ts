import {
  CaptureComparison,
  CaptureComparisonFailure,
  MAX_CAPTURE_PAGE,
  isCaptureComparisonKind,
  type CaptureComparisonDocument,
  type CaptureComparisonKind,
  type CaptureComparisonPage,
  type CaptureHeader,
  type CaptureIdentity,
  type CaptureRecordDetail,
} from './capture-comparison.ts';
import { InspectionFailure } from './inspection-store.ts';

const MAX_ARGUMENTS_WITH_COMMAND = 64;
const MAX_ARGUMENT_BYTES = 4096;
const MAX_TOTAL_ARGUMENT_BYTES = 16_384;
const USAGE = [
  'Usage: rezics-import capture-comparison --state <sqlite-path> --source <configured-source-id>',
  '       --before <generation-id> --after <generation-id>',
  '       [--counts] [--page new|changed|unchanged|vanished] [--limit 1..100]',
  '       [--cursor <opaque-cursor>] [--record <native-record-key>] [--json]',
  '       rezics-import capture-comparison --help',
  'Pages default to 20 rows. Comparison is local and read-only; it never imports, contacts the API, or writes importer state.',
  'Complete counts require --counts. A detail page does not recount. Generation IDs are exact decimal text.',
].join('\n');

export type CaptureComparisonCliResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
  openHandles: number;
}>;

export type CaptureComparisonCliOptions = Readonly<{ signal?: AbortSignal }>;

export type ParsedCaptureComparisonArgs = Readonly<{
  state: string;
  request: {
    source: string;
    before: string;
    after: string;
    page?: CaptureComparisonKind;
    limit?: number;
    cursor?: string;
    record?: string;
    counts?: boolean;
  };
  json: boolean;
}>;

class UsageFailure extends CaptureComparisonFailure {
  constructor(message: string) {
    super(message, 2);
  }
}

function boundedArguments(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length + 1 > MAX_ARGUMENTS_WITH_COMMAND)
    throw new UsageFailure('Capture comparison arguments exceed the supported count.');
  let totalBytes = Buffer.byteLength('capture-comparison', 'utf8');
  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.length > MAX_ARGUMENT_BYTES || argument.includes('\0'))
      throw new UsageFailure('Capture comparison arguments exceed the supported size.');
    totalBytes += Buffer.byteLength(argument, 'utf8');
    if (totalBytes > MAX_TOTAL_ARGUMENT_BYTES)
      throw new UsageFailure('Capture comparison arguments exceed the supported size.');
  }
}

export function parseCaptureComparisonArgs(argv: readonly string[]): ParsedCaptureComparisonArgs | 'help' {
  boundedArguments(argv);
  if (argv.length === 1 && argv[0] === '--help') return 'help';
  if (!Array.isArray(argv)) throw new UsageFailure('Capture comparison arguments are invalid.');

  const values = new Map<string, string>();
  const valueFlags = new Set(['--state', '--source', '--before', '--after', '--page', '--limit', '--cursor', '--record']);
  let json = false;
  let counts = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--json') {
      if (json) throw new UsageFailure('Capture comparison flags cannot be repeated.');
      json = true;
      continue;
    }
    if (flag === '--counts') {
      if (counts) throw new UsageFailure('Capture comparison flags cannot be repeated.');
      counts = true;
      continue;
    }
    if (!valueFlags.has(flag) || values.has(flag))
      throw new UsageFailure('Unknown, import-only or repeated capture-comparison flag.');
    const value = argv[++index];
    if (value === undefined || value.length === 0 || value.startsWith('--'))
      throw new UsageFailure(`Capture comparison flag ${flag} requires one value.`);
    values.set(flag, value);
  }

  const state = values.get('--state');
  const source = values.get('--source');
  const before = values.get('--before');
  const after = values.get('--after');
  if (!state || !state.trim() || state === '-' || state.length > MAX_ARGUMENT_BYTES || !source || !before || !after)
    throw new UsageFailure(
      'Capture comparison requires --state <sqlite-path>, --source <configured-source-id>, --before <generation-id> and --after <generation-id>.',
    );
  if (Buffer.byteLength(source, 'utf8') > 32 || !/^[a-z][a-z0-9_-]{0,31}$/u.test(source))
    throw new UsageFailure('--source must be an exact configured source identifier.');
  if (
    Buffer.byteLength(before, 'utf8') > 32 ||
    !/^[1-9][0-9]*$/u.test(before) ||
    !Number.isSafeInteger(Number(before))
  )
    throw new UsageFailure('--before must be a positive stored generation ID.');
  if (Buffer.byteLength(after, 'utf8') > 32 || !/^[1-9][0-9]*$/u.test(after) || !Number.isSafeInteger(Number(after)))
    throw new UsageFailure('--after must be a positive stored generation ID.');

  const request: ParsedCaptureComparisonArgs['request'] = { source, before, after };
  if (counts) request.counts = true;
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
    if (!isCaptureComparisonKind(pageValue))
      throw new UsageFailure('--page must be new, changed, unchanged or vanished.');
    request.page = pageValue;
  }
  const limitValue = values.get('--limit');
  if (limitValue !== undefined) {
    if (!/^(?:[1-9][0-9]{0,2})$/u.test(limitValue))
      throw new UsageFailure('--limit must be an integer from 1 through 100.');
    const limit = Number(limitValue);
    if (limit > MAX_CAPTURE_PAGE) throw new UsageFailure('--limit must be an integer from 1 through 100.');
    if (request.page === undefined) throw new UsageFailure('--limit requires --page new|changed|unchanged|vanished.');
    request.limit = limit;
  }
  const cursor = values.get('--cursor');
  if (cursor !== undefined) {
    if (request.page === undefined) throw new UsageFailure('--cursor requires --page new|changed|unchanged|vanished.');
    request.cursor = cursor;
  }
  return { state, request, json };
}

export function captureComparisonUsage(): string {
  return USAGE;
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

function terminalSafeMessage(value: string): string {
  return value.replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  );
}

function identityLine(label: string, identity: CaptureIdentity | null): string {
  if (!identity) return `  ${label}: absent from that capture's present population`;
  return `  ${label}: revision=${terminalString(identity.recordRevision)} digest=${identity.digest} converter=${terminalString(identity.converterRevision)} captured-classification=${identity.capturedClassification ?? 'not classified'} (import-time classification is not this comparison result)`;
}

function renderHeader(label: string, header: CaptureHeader): string[] {
  return [
    `${label} capture: generation ${terminalString(header.generation)} status=${terminalString(header.status)} seq=${header.seq}`,
    `  stored present accounting (supplied)=${header.supplied}; survivors=${header.survivors}; prior=${header.prior}; skipped=${header.skipped ?? 'unknown'}`,
    `  classified=${header.classified} resolved=${header.resolved} expected=${header.expected ?? 'unknown'}`,
  ];
}

function renderRecord(record: CaptureRecordDetail): string[] {
  if (!record.found) {
    return [
      `Exact record ${terminalString(record.recordKey)}: not present in either capture's present population.`,
      `  Excluded vanished journal rows: before=${record.excludedVanishedBefore ? 'yes' : 'no'} after=${record.excludedVanishedAfter ? 'yes' : 'no'}`,
      '  Native publication and current bindings are independent of this local comparison.',
    ];
  }
  const lines = [
    `Exact record ${terminalString(record.recordKey)}: ${record.category}`,
    identityLine('Before', record.before),
    identityLine('After', record.after),
  ];
  if (record.identity) {
    lines.push(
      `  Identity: revision ${record.identity.revisionEqual ? 'equal' : 'changed'}, digest ${record.identity.digestEqual ? 'equal' : 'changed'}, converter ${record.identity.converterEqual ? 'equal' : 'changed'}${record.identity.factors.length ? `; factors=${record.identity.factors.join(',')}` : ''}`,
    );
  }
  lines.push(
    `  Import-time captured classification: before=${record.capturedClassification.before ?? 'none'} after=${record.capturedClassification.after ?? 'none'}; that staged label is not this comparison result.`,
  );
  if (record.projection.available) {
    lines.push(
      `  Retained projection (${record.projection.format}, sourceKind=${terminalString(record.projection.sourceKind)})${record.projection.truncated ? `; truncated, omitted=${record.projection.omittedBytes}` : ''}:`,
    );
    if (!record.projection.fields.length) lines.push('    no bounded field names stored on the normalized record');
    for (const field of record.projection.fields) {
      lines.push(
        `    ${terminalString(field.name)} ${field.equal ? 'equal' : 'differs'} before=${field.before === null ? 'absent' : terminalString(field.before)} after=${field.after === null ? 'absent' : terminalString(field.after)}${field.truncated ? `; omittedBytes=${field.omittedBytes}` : ''}`,
      );
    }
  } else {
    lines.push(
      `  Retained projection detail unavailable (${record.projection.reason}); identity still used revision/digest/converter. omittedBytes=${record.projection.omittedBytes}`,
    );
  }
  lines.push('  Local capture evidence only. Native candidate proposal, acceptance, adoption and current publication are independent outcomes.');
  lines.push('  Historical subject identity is reported only when the capture itself retained it; a later current binding is not substituted.');
  return lines;
}

function renderPage(page: CaptureComparisonPage): string[] {
  const lines = [
    `${page.kind} page (${page.rows.length} of at most ${page.limit} rows; scanned ${page.scannedRows} present-merge steps of window ${page.scanWindow}; visited ${page.visitedRows} journal rows):`,
  ];
  for (const row of page.rows) {
    const factors = row.identity?.factors.length ? ` factors=${row.identity.factors.join(',')}` : '';
    lines.push(
      `  ${terminalString(row.recordKey)} ${row.category}${factors}; before converter=${row.before ? terminalString(row.before.converterRevision) : 'absent'} after converter=${row.after ? terminalString(row.after.converterRevision) : 'absent'}`,
    );
  }
  if (!page.rows.length && page.end === 'more') {
    lines.push(
      'No matches in this scan window. Remaining work exists; this is not a completed empty comparison. Continue with the next cursor.',
    );
  }
  lines.push(
    page.end === 'more'
      ? `More work is available. Next cursor: ${page.nextCursor}`
      : 'End of this comparison page; no next cursor.',
  );
  lines.push('Each page is one short consistent read. A later page revalidates the same source and generation identities.');
  return lines;
}

export function renderCaptureComparison(document: CaptureComparisonDocument): string {
  const lines = [
    `Configured source: ${terminalString(document.source)}`,
    'Comparing retained complete captures of the same configured source. This is local journal evidence, not a native verification substitute.',
    ...renderHeader('Before', document.before),
    ...renderHeader('After', document.after),
    `Present population: ${document.presentPopulation}; vanished journal rows are ${document.vanishedJournalRows}.`,
    `Staged import classification is ${document.stagedClassification}.`,
  ];
  if (document.counts.state === 'pending') {
    lines.push('Category counts: pending. Pass --counts for one explicit streaming comparison of every present row.');
  } else {
    const counts = document.counts;
    lines.push(
      `Category counts: new=${counts.new} changed=${counts.changed} unchanged=${counts.unchanged} vanished=${counts.vanished}`,
    );
    lines.push(
      `  present before=${counts.presentBefore} after=${counts.presentAfter}; excluded vanished-state rows before=${counts.excludedVanishedBefore} after=${counts.excludedVanishedAfter}`,
    );
    lines.push(`  count pass scanned ${counts.scannedRows} present-merge steps and visited ${counts.visitedRows} journal rows.`);
  }
  lines.push(
    `Work this invocation: sqliteReads=${document.work.sqliteReads} visitedRows=${document.work.visitedRows} scannedRows=${document.work.scannedRows} comparisonCalls=${document.work.comparisonCalls} decodedProjectionBytes=${document.work.decodedProjectionBytes} retainedBufferBytes=${document.work.retainedBufferBytes}`,
  );
  if (document.record) lines.push(...renderRecord(document.record));
  if (document.page) lines.push(...renderPage(document.page));
  lines.push(
    `Authority: localCapture=${document.authority.localCapture}; nativePublication=${document.authority.nativePublication}; currentBinding=${document.authority.currentBinding}; transport=${document.authority.transport}.`,
  );
  lines.push(
    'Return to the existing authorized importer to acquire a later dump. Capture comparison does not resume a run, replay envelopes, or change local tables.',
  );
  lines.push(
    `  bun services/importer/src/cli.ts --source <original-source-kind> --source-alias ${terminalString(document.source)} --dump <complete-input-path> --state <same-state-path> --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>`,
  );
  return `${lines.join('\n')}\n`;
}

function errorMessage(error: unknown): { code: number; message: string } {
  if (error instanceof InspectionFailure) return { code: error.code, message: error.message };
  return { code: 1, message: 'Capture comparison failed safely; importer state was not changed.' };
}

function requestedJson(argv: readonly string[]): boolean {
  return Array.isArray(argv) && argv.includes('--json');
}

/** Read-only capture comparison route. It does not construct credentials, transport or importer objects. */
export async function runCaptureComparisonCli(
  argv: readonly string[],
  options: CaptureComparisonCliOptions = {},
): Promise<CaptureComparisonCliResult> {
  const jsonRequested = requestedJson(argv);
  let parsed: ParsedCaptureComparisonArgs | 'help';
  try {
    parsed = parseCaptureComparisonArgs(argv);
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

  let comparison: CaptureComparison | undefined;
  let document: CaptureComparisonDocument | undefined;
  let failure: { code: number; message: string } | undefined;
  try {
    if (options.signal?.aborted) throw new CaptureComparisonFailure('Capture comparison was cancelled.', 130);
    comparison = await CaptureComparison.open(parsed.state);
    document = comparison.compare(parsed.request, options.signal);
  } catch (error) {
    failure = errorMessage(error);
  } finally {
    await comparison?.close();
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
      stdout: parsed.json ? `${jsonSafe(document)}\n` : renderCaptureComparison(document!),
      stderr: '',
      openHandles: 0,
    };
  } catch {
    const message = 'Capture comparison presentation failed safely; importer state was not changed.';
    return parsed.json
      ? { code: 1, stdout: `${jsonSafe({ version: 1, error: message })}\n`, stderr: '', openHandles: 0 }
      : { code: 1, stdout: '', stderr: `${message}\n`, openHandles: 0 };
  }
}
