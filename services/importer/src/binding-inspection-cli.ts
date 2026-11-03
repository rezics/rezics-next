import type { Database } from 'bun:sqlite';
import {
  BINDING_RECORD_BYTES,
  BINDING_SOURCE_BYTES,
  DEFAULT_BINDING_PAGE_SIZE,
  isBindingPageKind,
  utf8Bytes,
  validBindingRecord,
  validBindingSource,
  type BindingInspectionDocument,
  type BindingInspectionPageKind,
  type BindingInspectionRow,
} from './binding-inspection.ts';
import { BindingInspectionStore } from './binding-inspection-store.ts';
import { InspectionFailure } from './inspection-open.ts';

const MAX_ARGUMENTS_WITH_COMMAND = 64;
const MAX_ARGUMENT_BYTES = 4096;
const MAX_TOTAL_ARGUMENT_BYTES = 16_384;
const USAGE = [
  'Usage: rezics-import inspect-bindings --state <sqlite-path> --source <configured-source-id> --record <external-record-key>',
  '       [--page semantic|candidates|media|metadata] [--limit 1..100] [--cursor <opaque-cursor>]',
  '       [--request <original-request-key|field-group/candidate-uuid>] [--json]',
  '       rezics-import inspect-bindings --help',
  'Pages default to 20 rows. Binding inspection is local and read-only; it never resumes a run or writes state.',
].join('\n');

export type BindingInspectionCliResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
  openHandles: number;
}>;

export type BindingInspectionCliOptions = Readonly<{
  signal?: AbortSignal;
  instrumentDatabase?: (database: Database) => Database;
}>;

export type ParsedBindingInspectionArgs = Readonly<{
  state: string;
  request: {
    source: string;
    record: string;
    page?: BindingInspectionPageKind;
    limit?: number;
    cursor?: string;
    request?: string;
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
  let totalBytes = Buffer.byteLength('inspect-bindings', 'utf8');
  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.length > MAX_ARGUMENT_BYTES || argument.includes('\0'))
      throw new UsageFailure('Inspection arguments exceed the supported size.');
    totalBytes += Buffer.byteLength(argument, 'utf8');
    if (totalBytes > MAX_TOTAL_ARGUMENT_BYTES)
      throw new UsageFailure('Inspection arguments exceed the supported size.');
  }
}

export function parseBindingInspectionArgs(argv: readonly string[]): ParsedBindingInspectionArgs | 'help' {
  boundedArguments(argv);
  if (argv.length === 1 && argv[0] === '--help') return 'help';
  if (!Array.isArray(argv)) throw new UsageFailure('Inspection arguments are invalid.');

  const values = new Map<string, string>();
  const valueFlags = new Set(['--state', '--source', '--record', '--page', '--limit', '--cursor', '--request']);
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
  const record = values.get('--record');
  if (!state || !state.trim() || state === '-' || state.length > MAX_ARGUMENT_BYTES || !source || !record)
    throw new UsageFailure(
      'Binding inspection requires --state <sqlite-path>, --source <configured-source-id> and --record <external-record-key>.',
    );
  if (utf8Bytes(source) > BINDING_SOURCE_BYTES)
    throw new UsageFailure('--source must be an exact configured source identifier.');
  validBindingSource(source);
  if (utf8Bytes(record) > BINDING_RECORD_BYTES)
    throw new UsageFailure('--record must be an exact stored external record identifier.');
  validBindingRecord(record);
  const request: ParsedBindingInspectionArgs['request'] = { source, record };
  const pageValue = values.get('--page');
  if (pageValue !== undefined) {
    if (!isBindingPageKind(pageValue))
      throw new UsageFailure('--page must be semantic, candidates, media or metadata.');
    request.page = pageValue;
  }
  const limitValue = values.get('--limit');
  if (limitValue !== undefined) {
    if (!/^(?:[1-9][0-9]{0,2})$/u.test(limitValue))
      throw new UsageFailure('--limit must be an integer from 1 through 100.');
    const limit = Number(limitValue);
    if (limit > 100) throw new UsageFailure('--limit must be an integer from 1 through 100.');
    if (request.page === undefined)
      throw new UsageFailure('--limit requires --page semantic|candidates|media|metadata.');
    request.limit = limit;
  }
  const cursor = values.get('--cursor');
  if (cursor !== undefined) {
    if (request.page === undefined)
      throw new UsageFailure('--cursor requires --page semantic|candidates|media|metadata.');
    request.cursor = cursor;
  }
  const exact = values.get('--request');
  if (exact !== undefined) {
    if (request.page === undefined)
      throw new UsageFailure('--request requires --page semantic|candidates|media|metadata.');
    request.request = exact;
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

function terminalSafeMessage(value: string): string {
  return value.replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  );
}

function sectionLabel(value: BindingInspectionDocument['sections'][BindingInspectionPageKind]): string {
  if (value === 'available') return 'available';
  if (value === 'not-retained') return 'not retained';
  return 'unavailable';
}

function bodyLine(row: BindingInspectionRow): string {
  const digest = row.body.sha256 ?? (row.body.digestOmitted ? `omitted (${row.body.digestOmitted})` : 'omitted');
  const length = row.body.byteLength === null ? 'unknown' : String(row.body.byteLength);
  return `${length} bytes; SHA-256 ${digest}`;
}

function nativeLine(row: BindingInspectionRow): string {
  if (!row.native) return 'no admitted native identifiers';
  const parts: string[] = [];
  if (row.native.subject) parts.push(`subject ${row.native.subject}`);
  if (row.native.candidate) parts.push(`candidate ${row.native.candidate}`);
  if (row.native.revision !== undefined) parts.push(`revision ${row.native.revision}`);
  if (row.native.media) parts.push(`media ${row.native.media}`);
  if (row.native.metadataRevision !== undefined) parts.push(`metadata revision ${row.native.metadataRevision}`);
  return parts.length ? parts.join(', ') : 'no admitted native identifiers';
}

function renderRow(row: BindingInspectionRow): string[] {
  if (row.display === 'unavailable') {
    return [`  ${terminalString(row.key)} unavailable: ${row.reason ?? 'display failed'}; ${bodyLine(row)}`];
  }
  const lines = [`  ${terminalString(row.key)} ${bodyLine(row)}`];
  if (row.operation || row.fieldGroup)
    lines.push(`    operation ${row.operation ?? 'unknown'} / field-group ${row.fieldGroup ?? 'unknown'}`);
  if (row.category === 'semantic' || row.category === 'metadata')
    lines.push(`    acknowledgement: ${row.acknowledgement}; ${nativeLine(row)}`);
  if (row.category === 'candidates') {
    lines.push(
      `    owned candidate ${row.candidate} on ${row.fieldGroup} for subject ${row.subject}; original key ${terminalString(row.originalKey ?? '')}`,
    );
    lines.push(`    ${row.storedCapacityNote}`);
  }
  if (row.category === 'media') {
    lines.push(
      `    accepted receipt: ${row.mediaAccepted}; status: ${row.mediaStatus}; cover permission: ${row.coverPermission}`,
    );
    lines.push(`    ${nativeLine(row)}`);
  }
  if (row.category === 'metadata' && row.metadataEffect)
    lines.push(`    retained metadata effect: ${row.metadataEffect} (not source licence or current native metadata)`);
  if (row.signature) lines.push(`    original signature: ${row.signature}`);
  return lines;
}

function nextPageCommand(
  state: string,
  document: BindingInspectionDocument,
  page: NonNullable<BindingInspectionDocument['page']>,
): string[] {
  if (page.end === 'end' || !page.nextCursor) return ['End of this local page; no next cursor.'];
  return [
    'More retained rows follow. This cursor is snapshot-local and is not a native grant. Next page:',
    `  bun services/importer/src/cli.ts inspect-bindings --state ${terminalString(state)} --source ${terminalString(document.source)} --record ${terminalString(document.record)} --page ${page.kind} --limit ${page.limit} --cursor ${page.nextCursor}`,
  ];
}

export function renderBindingInspection(document: BindingInspectionDocument, statePath: string): string {
  const lines = [
    `Exact source ${terminalString(document.source)} record ${terminalString(document.record)}`,
    'Capture: one local consistent read. Refresh with a new invocation; this document does not promise continuity.',
    `Current source run row: ${document.runRow}; a missing binding is not evidence that the source itself is absent.`,
    `Retained binding state: ${document.binding.state}`,
  ];
  if (document.binding.state === 'pending')
    lines.push(
      'A bootstrap original request is retained without a local acknowledgement. An absent acknowledgement is not proof that the server did nothing.',
    );
  else if (document.binding.state === 'bound')
    lines.push(
      `Locally acknowledged subject: ${document.binding.subject}. That receipt is not current native visibility, public selection or a live fence.`,
    );
  else if (document.binding.state === 'taken-down') {
    lines.push(
      'This local binding records an observed native 404. It is not a fresh fence or a live visibility check.',
    );
    if (document.binding.subject)
      lines.push(`Last locally acknowledged subject still stored: ${document.binding.subject}.`);
  } else {
    lines.push(
      'No binding_records row exists for this exact source and record. That is not evidence that the source itself is absent.',
    );
  }
  lines.push(`Bootstrap original request key: ${document.binding.bootstrapKey ?? 'none retained'}`);
  lines.push(`Current metadata pointer: ${document.binding.currentMetadataKey ?? 'none retained'}`);
  lines.push(`Current cover journal key: ${document.binding.currentCoverKey ?? 'none retained'}`);
  if (document.binding.storedCandidateCapacity === null) {
    lines.push('Stored candidate capacity: unavailable.');
  } else {
    lines.push(
      `Stored candidate capacity (local accounting, not a public vote total): ${document.binding.storedCandidateCapacity}`,
    );
  }
  if (document.binding.storedGroupCapacity) {
    for (const group of document.binding.storedGroupCapacity)
      lines.push(`  ${group.fieldGroup}: ${group.storedCapacity} stored capacity`);
  }
  lines.push(
    `Journal families: semantic ${sectionLabel(document.sections.semantic)}; candidates ${sectionLabel(document.sections.candidates)}; media ${sectionLabel(document.sections.media)}; metadata ${sectionLabel(document.sections.metadata)}.`,
  );
  if (document.page) {
    lines.push(
      `${document.page.kind} page (${document.page.rows.length} of at most ${document.page.limit} rows; default ${DEFAULT_BINDING_PAGE_SIZE}):`,
    );
    for (const row of document.page.rows) lines.push(...renderRow(row));
    lines.push(...nextPageCommand(statePath, document, document.page));
    lines.push(
      'Each page is one short consistent read. A writer may acknowledge work between invocations; this cursor is not a stable history promise.',
    );
  }
  if (document.request) {
    lines.push(`Exact original request in ${document.request.category}:`);
    lines.push(...renderRow(document.request.row));
    lines.push(`  ${document.request.explained}`);
    lines.push('Raw wire bodies are omitted; byte digest and recognized safe metadata are sufficient.');
  }
  lines.push(document.resume);
  return `${lines.join('\n')}\n`;
}

function errorMessage(error: unknown): { code: number; message: string } {
  if (error instanceof InspectionFailure) return { code: error.code, message: error.message };
  return { code: 1, message: 'Inspection failed safely; importer state was not changed.' };
}

function requestedJson(argv: readonly string[]): boolean {
  return Array.isArray(argv) && argv.includes('--json');
}

/** Read-only binding inspection route. It does not construct credentials, transport or importer objects. */
export async function runBindingInspectionCli(
  argv: readonly string[],
  options: BindingInspectionCliOptions = {},
): Promise<BindingInspectionCliResult> {
  const jsonRequested = requestedJson(argv);
  let parsed: ParsedBindingInspectionArgs | 'help';
  try {
    parsed = parseBindingInspectionArgs(argv);
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

  let store: BindingInspectionStore | undefined;
  let document: BindingInspectionDocument | undefined;
  let failure: { code: number; message: string } | undefined;
  try {
    if (options.signal?.aborted) throw new InspectionFailure('Inspection was cancelled.', 130);
    store = await BindingInspectionStore.open(
      parsed.state,
      options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {},
    );
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
      stdout: parsed.json ? `${jsonSafe(document)}\n` : renderBindingInspection(document!, parsed.state),
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
