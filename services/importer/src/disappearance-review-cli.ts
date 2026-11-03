import type { Database } from 'bun:sqlite';
import {
  DisappearanceReview,
  DisappearanceReviewFailure,
  MAX_DISAPPEARANCE_PAGE,
  type DisappearanceMissingRow,
  type DisappearanceReviewDocument,
  type DisappearanceReviewRequest,
} from './disappearance-review.ts';
import { InspectionFailure } from './inspection-open.ts';

const MAX_ARGUMENTS_WITH_COMMAND = 64;
const MAX_ARGUMENT_BYTES = 4096;
const MAX_TOTAL_ARGUMENT_BYTES = 16_384;
const USAGE = [
  'Usage: rezics-import disappearance-review --state <sqlite-path> --source <configured-source-id>',
  '       --generation <stopped-generation-id>',
  '       [--page missing] [--limit 1..100] [--cursor <opaque-cursor>] [--record <native-record-key>] [--json]',
  '       rezics-import disappearance-review --help',
  'Pages default to 20 missing identities and accept at most 100. Review is local and read-only; it never imports, contacts the API, changes a threshold, or accepts a stopped generation.',
  'Stored complete counts are shown in the header. A local missing row is not a native deletion, publication or takedown.',
].join('\n');

export type DisappearanceReviewCliResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
  openHandles: number;
}>;

export type DisappearanceReviewCliOptions = Readonly<{
  signal?: AbortSignal;
  instrumentDatabase?: (database: Database) => Database;
}>;

export type ParsedDisappearanceReviewArgs = Readonly<{
  state: string;
  request: DisappearanceReviewRequest;
  json: boolean;
}>;

class UsageFailure extends DisappearanceReviewFailure {
  constructor(message: string) {
    super(message, 2);
  }
}

function boundedArguments(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length + 1 > MAX_ARGUMENTS_WITH_COMMAND)
    throw new UsageFailure('Disappearance review arguments exceed the supported count.');
  let totalBytes = Buffer.byteLength('disappearance-review', 'utf8');
  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.length > MAX_ARGUMENT_BYTES || argument.includes('\0'))
      throw new UsageFailure('Disappearance review arguments exceed the supported size.');
    totalBytes += Buffer.byteLength(argument, 'utf8');
    if (totalBytes > MAX_TOTAL_ARGUMENT_BYTES)
      throw new UsageFailure('Disappearance review arguments exceed the supported size.');
  }
}

export function parseDisappearanceReviewArgs(argv: readonly string[]): ParsedDisappearanceReviewArgs | 'help' {
  boundedArguments(argv);
  if (argv.length === 1 && argv[0] === '--help') return 'help';
  if (!Array.isArray(argv)) throw new UsageFailure('Disappearance review arguments are invalid.');

  const values = new Map<string, string>();
  const valueFlags = new Set(['--state', '--source', '--generation', '--page', '--limit', '--cursor', '--record']);
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--json') {
      if (json) throw new UsageFailure('Disappearance review flags cannot be repeated.');
      json = true;
      continue;
    }
    if (!valueFlags.has(flag) || values.has(flag))
      throw new UsageFailure('Unknown, import-only or repeated disappearance-review flag.');
    const value = argv[++index];
    if (value === undefined || value.length === 0 || value.startsWith('--'))
      throw new UsageFailure(`Disappearance review flag ${flag} requires one value.`);
    values.set(flag, value);
  }

  const state = values.get('--state');
  const source = values.get('--source');
  const generation = values.get('--generation');
  if (!state || !state.trim() || state === '-' || state.length > MAX_ARGUMENT_BYTES || !source || !generation)
    throw new UsageFailure(
      'Disappearance review requires --state <sqlite-path>, --source <configured-source-id> and --generation <stopped-generation-id>.',
    );
  if (Buffer.byteLength(source, 'utf8') > 32 || !/^[a-z][a-z0-9_-]{0,31}$/u.test(source))
    throw new UsageFailure('--source must be an exact configured source identifier.');
  if (
    Buffer.byteLength(generation, 'utf8') > 32 ||
    !/^[1-9][0-9]*$/u.test(generation) ||
    !Number.isSafeInteger(Number(generation))
  )
    throw new UsageFailure('--generation must be a positive stored generation ID.');

  const record = values.get('--record');
  if (
    record !== undefined &&
    (Buffer.byteLength(record, 'utf8') > 512 ||
      !/^(?:[\p{L}\p{N}][\p{L}\p{N}._:/@+\-]*|\/(?:works\/OL[1-9][0-9]*W|books\/OL[1-9][0-9]*M|authors\/OL[1-9][0-9]*A))$/u.test(
        record,
      ))
  )
    throw new UsageFailure('--record must be an exact native source record key.');
  const pageValue = values.get('--page');
  if (pageValue !== undefined && pageValue !== 'missing') throw new UsageFailure('--page must be missing.');
  const limitValue = values.get('--limit');
  let limit: number | undefined;
  if (limitValue !== undefined) {
    if (!/^(?:[1-9][0-9]{0,2})$/u.test(limitValue))
      throw new UsageFailure('--limit must be an integer from 1 through 100.');
    limit = Number(limitValue);
    if (limit > MAX_DISAPPEARANCE_PAGE) throw new UsageFailure('--limit must be an integer from 1 through 100.');
  }
  const cursor = values.get('--cursor');
  const page = pageValue === 'missing' || limit !== undefined || cursor !== undefined || record === undefined ? 'missing' : undefined;
  const request: DisappearanceReviewRequest = {
    source,
    generation,
    ...(page ? { page } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(record === undefined ? {} : { record }),
  };
  return { state, request, json };
}

export function disappearanceReviewUsage(): string {
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

function identityLine(row: DisappearanceMissingRow): string {
  return `${terminalString(row.recordKey)} revision=${terminalString(row.recordRevision)} digest=${row.digest} converter=${terminalString(row.converterRevision)}`;
}

function renderRecord(
  record: NonNullable<DisappearanceReviewDocument['record']>,
): string[] {
  if (!record.found) {
    return [
      `Exact record ${terminalString(record.recordKey)}: not present in this stop's missing-identity evidence.`,
      '  A local missing row is not a native deletion, publication or takedown.',
    ];
  }
  return [
    `Exact record ${identityLine(record)}`,
    '  Safe metadata only: identity, revision, digest and converter. Raw source fields, leases, envelopes and secrets are absent.',
    '  A local missing row is not a native deletion, publication or takedown.',
  ];
}

function renderPage(page: NonNullable<DisappearanceReviewDocument['page']>): string[] {
  const lines = [
    `Missing page (${page.rows.length} of at most ${page.limit} rows; stored missing=${page.storedMissing}):`,
  ];
  if (!page.rows.length) lines.push('  No missing identities on this page.');
  for (const row of page.rows) lines.push(`  ${identityLine(row)}`);
  lines.push(
    page.end === 'more'
      ? `More missing identities remain. Next cursor: ${page.nextCursor}`
      : 'End of this missing page; no next cursor.',
  );
  lines.push('Each page is one short consistent read. A later page revalidates the same source, generation and evidence identity.');
  return lines;
}

export function renderDisappearanceReview(document: DisappearanceReviewDocument): string {
  const generation = document.generation;
  const baseline = generation.comparedBaseline.generation
    ? `generation ${terminalString(generation.comparedBaseline.generation)}`
    : 'none recorded';
  const input =
    generation.input === 'malformed-or-truncated'
      ? 'malformed or truncated input; this is not a complete capture halted for mass loss'
      : generation.input === 'complete'
        ? 'complete capture halted for mass loss'
        : 'not a mass-disappearance stop';
  const lines = [
    `Configured source: ${terminalString(document.source)}`,
    `Stopped generation: ${terminalString(generation.id)} status=${terminalString(generation.status)} seq=${generation.seq}`,
    `Compared completed baseline: ${baseline}`,
    `Input: ${input}`,
    `Counts: prior=${generation.counts.prior} survivors=${generation.counts.survivors} supplied=${generation.counts.supplied} missing=${generation.counts.missing} threshold=${generation.counts.threshold}`,
    `Evidence: ${document.evidence.availability}${document.evidence.identity ? `; identity=${document.evidence.identity}` : ''}`,
    document.evidence.reason,
    'A generation number is not proof of source-native version order.',
    `Work this invocation: sqliteReads=${document.work.sqliteReads} visitedRows=${document.work.visitedRows} emittedRows=${document.work.emittedRows} probes=${document.work.probes} retainedBufferBytes=${document.work.retainedBufferBytes}`,
  ];
  if (document.record) lines.push(...renderRecord(document.record));
  if (document.page) lines.push(...renderPage(document.page));
  lines.push(
    `Authority: inspection=${document.authority.inspection}; disappearanceApproval=${document.authority.disappearanceApproval}; thresholdChange=${document.authority.thresholdChange}; nativePublication=${document.authority.nativePublication}; transport=${document.authority.transport}.`,
  );
  lines.push('Review does not approve disappearance, change a baseline, or change the disappearance threshold.');
  lines.push('Verify the selected file, source and families with the existing diagnostics command and complete-set producer.');
  lines.push('Correct the local capture, then invoke ordinary import with current input and credentials at execution time:');
  lines.push(`  bun services/importer/src/cli.ts ${document.ordinaryImport.replace(/^rezics-import /, '')}`);
  lines.push('Ordinary rerun reacquires current authority and keeps the existing disappearance barrier.');
  lines.push('Uncertain earlier requests still use original native custody. Acknowledged but unread work uses ordinary readback.');
  return `${lines.join('\n')}\n`;
}

function errorMessage(error: unknown): { code: number; message: string } {
  if (error instanceof InspectionFailure) return { code: error.code, message: error.message };
  return { code: 1, message: 'Disappearance review failed safely; importer state was not changed.' };
}

function requestedJson(argv: readonly string[]): boolean {
  return Array.isArray(argv) && argv.includes('--json');
}

/** Read-only disappearance review. It does not construct credentials, transport or importer objects. */
export async function runDisappearanceReviewCli(
  argv: readonly string[],
  options: DisappearanceReviewCliOptions = {},
): Promise<DisappearanceReviewCliResult> {
  const jsonRequested = requestedJson(argv);
  let parsed: ParsedDisappearanceReviewArgs | 'help';
  try {
    parsed = parseDisappearanceReviewArgs(argv);
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

  let review: DisappearanceReview | undefined;
  let document: DisappearanceReviewDocument | undefined;
  let failure: { code: number; message: string } | undefined;
  try {
    if (options.signal?.aborted) throw new DisappearanceReviewFailure('Disappearance review was cancelled.', 130);
    review = await DisappearanceReview.open(parsed.state, {
      ...(options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {}),
    });
    document = review.review(parsed.request, options.signal);
  } catch (error) {
    failure = errorMessage(error);
  } finally {
    await review?.close();
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
      stdout: parsed.json ? `${jsonSafe(document)}\n` : renderDisappearanceReview(document!),
      stderr: '',
      openHandles: 0,
    };
  } catch {
    const message = 'Disappearance review presentation failed safely; importer state was not changed.';
    return parsed.json
      ? { code: 1, stdout: `${jsonSafe({ version: 1, error: message })}\n`, stderr: '', openHandles: 0 }
      : { code: 1, stdout: '', stderr: `${message}\n`, openHandles: 0 };
  }
}
