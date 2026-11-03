import type { SourceId } from '@rezics/conversion';
import { admitDumpCompression, parseDumpCompression, type DumpCompression } from './compressed-dump.ts';
import { probeZstdExecutable, resolveZstdExecutable } from './zstd-input.ts';
import { DumpInputError, type RawVndbEntry } from './dump-input.ts';
import { DumpPreview, DumpPreviewFailure, type DumpPreviewOptions } from './dump-preview.ts';
import {
  DEFAULT_PREVIEW_PAGE,
  MAX_PREVIEW_PAGE,
  PreviewStoreFailure,
  type PreviewKind,
  type PreviewPlan,
} from './dump-preview-store.ts';

const MAX_ARGUMENTS_WITH_COMMAND = 64;
const MAX_ARGUMENT_BYTES = 4096;
const MAX_TOTAL_ARGUMENT_BYTES = 16_384;
const VALID_SOURCE = /^(?:bangumi|vndb|openlibrary|wikidata)$/;
const SOURCE_ALIAS = /^[a-z][a-z0-9_-]{0,31}$/u;
const RECORD_KEY =
  /^(?:[\p{L}\p{N}][\p{L}\p{N}._:/@+\-]*|\/(?:works\/OL[1-9][0-9]*W|books\/OL[1-9][0-9]*M|authors\/OL[1-9][0-9]*A))$/u;
const USAGE = [
  'Usage: rezics-import preview --source <bangumi|vndb|openlibrary|wikidata> --dump <path|->',
  '       [--source-alias <configured-source-id>] [--baseline <sqlite-path>] [--output-dir <path>]',
  '       [--compression none|gzip|zstd] [--decode-budget <bytes>] [--zstd-executable <absolute-path>]',
  '       [--page new|changed|unchanged|vanished] [--limit 1..100] [--cursor <opaque-cursor>]',
  '       [--record <native-record-key>] [--json]',
  '       rezics-import preview --plan-dir <path> [--page ...] [--record ...] [--json]',
  '       rezics-import preview --help',
  'Pages default to 20 rows. Preview is local and offline; it never imports, writes import state, or contacts the API.',
  'gzip is admitted only for Open Library and Wikidata streamed dumps. zstd is admitted only for VNDB archives and Wikidata streamed dumps as one regular local file. Default --compression none. --plan-dir does not reopen or decompress input.',
].join('\n');

export type PreviewCliResult = Readonly<{ code: number; stdout: string; stderr: string; openHandles: number }>;
export type PreviewCliOptions = Readonly<{
  stdin?: AsyncIterable<Uint8Array>;
  entries?: AsyncIterable<RawVndbEntry>;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}>;

export type ParsedPreviewArgs = Readonly<{
  source?: SourceId;
  dump?: string;
  sourceAlias?: string;
  baseline?: string;
  outputDir?: string;
  planDir?: string;
  page?: PreviewKind;
  limit?: number;
  cursor?: string;
  record?: string;
  json: boolean;
  compression: DumpCompression;
  decodeBudget?: number;
  zstdExecutable?: string;
}>;

class UsageFailure extends DumpPreviewFailure {
  constructor(message: string) {
    super(message, 2);
  }
}

function boundedArguments(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length + 1 > MAX_ARGUMENTS_WITH_COMMAND)
    throw new UsageFailure('Preview arguments exceed the supported count.');
  let totalBytes = Buffer.byteLength('preview', 'utf8');
  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.length > MAX_ARGUMENT_BYTES || argument.includes('\0'))
      throw new UsageFailure('Preview arguments exceed the supported size.');
    totalBytes += Buffer.byteLength(argument, 'utf8');
    if (totalBytes > MAX_TOTAL_ARGUMENT_BYTES) throw new UsageFailure('Preview arguments exceed the supported size.');
  }
}

export function parsePreviewArgs(argv: readonly string[]): ParsedPreviewArgs | 'help' {
  boundedArguments(argv);
  if (argv.length === 1 && argv[0] === '--help') return 'help';
  const values = new Map<string, string>();
  const valueFlags = new Set([
    '--source',
    '--dump',
    '--source-alias',
    '--baseline',
    '--output-dir',
    '--plan-dir',
    '--page',
    '--limit',
    '--cursor',
    '--record',
    '--compression',
    '--decode-budget',
    '--zstd-executable',
  ]);
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--json') {
      if (json) throw new UsageFailure('Preview flags cannot be repeated.');
      json = true;
      continue;
    }
    if (!valueFlags.has(flag) || values.has(flag))
      throw new UsageFailure('Unknown, import-only or repeated preview flag.');
    const value = argv[++index];
    if (value === undefined || value.length === 0 || value.startsWith('--'))
      throw new UsageFailure(`Preview flag ${flag} requires one value.`);
    values.set(flag, value);
  }

  const planDir = values.get('--plan-dir');
  const source = values.get('--source');
  const dump = values.get('--dump');
  if (planDir) {
    if (
      source ||
      dump ||
      values.has('--source-alias') ||
      values.has('--baseline') ||
      values.has('--output-dir') ||
      values.has('--compression') ||
      values.has('--decode-budget') ||
      values.has('--zstd-executable')
    )
      throw new UsageFailure(
        '--plan-dir reopens a retained preview and cannot be combined with dump acquisition flags.',
      );
  } else {
    if (!source || !VALID_SOURCE.test(source) || !dump) throw new UsageFailure('Preview requires --source and --dump.');
    if (dump !== '-' && !dump.trim()) throw new UsageFailure('Preview dump path is invalid.');
  }
  let compression: DumpCompression = 'none';
  const compressionValue = values.get('--compression');
  if (compressionValue !== undefined) compression = parseDumpCompression(compressionValue);
  if (source) admitDumpCompression(source, compression);
  if (compression === 'zstd' && dump === '-')
    throw new UsageFailure('zstd compression requires one regular local dump file, not stdin.');
  let zstdExecutable: string | undefined;
  const zstdExecutableValue = values.get('--zstd-executable');
  if (zstdExecutableValue !== undefined) {
    if (compression !== 'zstd') throw new UsageFailure('--zstd-executable applies only with --compression zstd.');
    zstdExecutable = zstdExecutableValue;
  }
  let decodeBudget: number | undefined;
  const decodeBudgetValue = values.get('--decode-budget');
  if (decodeBudgetValue !== undefined) {
    if (compression !== 'gzip' && compression !== 'zstd')
      throw new UsageFailure('--decode-budget applies only with --compression gzip or zstd.');
    if (!/^[1-9][0-9]{0,15}$/.test(decodeBudgetValue))
      throw new UsageFailure('--decode-budget must be a positive safe integer byte count.');
    decodeBudget = Number(decodeBudgetValue);
    if (!Number.isSafeInteger(decodeBudget) || decodeBudget <= 0)
      throw new UsageFailure('--decode-budget must be a positive safe integer byte count.');
  }
  const alias = values.get('--source-alias');
  if (alias !== undefined && (Buffer.byteLength(alias, 'utf8') > 32 || !SOURCE_ALIAS.test(alias)))
    throw new UsageFailure('--source-alias must be an exact configured source identifier.');
  const baseline = values.get('--baseline');
  if (baseline !== undefined && (!baseline.trim() || baseline === '-'))
    throw new UsageFailure('--baseline must be an existing regular state file.');
  const outputDir = values.get('--output-dir');
  if (outputDir !== undefined && (!outputDir.trim() || outputDir === '-'))
    throw new UsageFailure('--output-dir must be a caller-owned directory.');
  const page = values.get('--page');
  if (page !== undefined && page !== 'new' && page !== 'changed' && page !== 'unchanged' && page !== 'vanished')
    throw new UsageFailure('--page must be new, changed, unchanged or vanished.');
  const limitValue = values.get('--limit');
  let limit: number | undefined;
  if (limitValue !== undefined) {
    if (!/^(?:[1-9][0-9]{0,2})$/u.test(limitValue))
      throw new UsageFailure('--limit must be an integer from 1 through 100.');
    limit = Number(limitValue);
    if (limit > MAX_PREVIEW_PAGE) throw new UsageFailure('--limit must be an integer from 1 through 100.');
    if (page === undefined) throw new UsageFailure('--limit requires --page new|changed|unchanged|vanished.');
  }
  const cursor = values.get('--cursor');
  if (cursor !== undefined && page === undefined)
    throw new UsageFailure('--cursor requires --page new|changed|unchanged|vanished.');
  const record = values.get('--record');
  if (record !== undefined && (Buffer.byteLength(record, 'utf8') > 512 || !RECORD_KEY.test(record)))
    throw new UsageFailure('--record must be an exact native source record key.');
  return {
    json,
    ...(source ? { source: source as SourceId } : {}),
    ...(dump ? { dump } : {}),
    ...(planDir ? { planDir } : {}),
    ...(alias ? { sourceAlias: alias } : {}),
    ...(baseline ? { baseline } : {}),
    ...(outputDir ? { outputDir } : {}),
    ...(page ? { page: page as PreviewKind } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor ? { cursor } : {}),
    ...(record ? { record } : {}),
    compression,
    ...(decodeBudget === undefined ? {} : { decodeBudget }),
    ...(zstdExecutable === undefined ? {} : { zstdExecutable }),
  };
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

function importInvocation(plan: PreviewPlan): string[] {
  const alias = plan.source === plan.sourceKind ? '' : ` --source-alias ${terminalString(plan.source)}`;
  return [
    'Ordinary import reopens the actual dump, acquires its lease, and rechecks authority and fences. Preview evidence does not license a later file or bypass those checks.',
    `  bun services/importer/src/cli.ts --source ${plan.sourceKind}${alias} --dump <complete-input-path> --state <sqlite-path> --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>`,
  ];
}

function renderPlan(plan: PreviewPlan, directory: string): string[] {
  const lines = [
    `Preview: ${plan.previewId}`,
    `Source kind: ${plan.sourceKind}`,
    `Configured source: ${terminalString(plan.source)}`,
    `Converter revision: ${terminalString(plan.converterRevision)}`,
    `View: ${plan.viewKind === 'first-import' ? 'first-import preview; this is not proof that the server has no existing subjects' : `baseline-comparison against captured generation ${terminalString(plan.baselineId ?? '')}`}`,
    `Input: ${plan.complete ? 'complete' : `incomplete (${plan.errorIdentity ?? 'invalid-input'})`}`,
    `Admitted ${plan.admitted} of ${plan.admitted} decoded source members; skipped=${plan.skipped}`,
    `Counts: new=${plan.newCount} changed=${plan.changedCount} unchanged=${plan.unchangedCount} vanished=${plan.complete ? plan.vanishedCount : 'withheld'} prior=${plan.prior} survivors=${plan.survivors}`,
    `Disappearance rule would block application: ${plan.disappearanceWouldBlock ? 'yes' : 'no'}`,
    `Preview store: ${directory}`,
  ];
  if (!plan.complete) lines.push('Incomplete input cannot present a valid vanished set or a retraction plan.');
  if (plan.viewKind === 'first-import') lines.push('No completed local baseline was captured for this comparison.');
  lines.push(...importInvocation(plan));
  return lines;
}

function renderRecord(detail: ReturnType<DumpPreview['record']>): string[] {
  if (!detail.found) return [`Exact record ${terminalString(detail.recordKey)}: not present in this preview.`];
  if (detail.kind === 'vanished') {
    return [
      `Exact record ${terminalString(detail.recordKey)}: vanished`,
      '  Prospective meaning: source withdrawal of this source membership. This is not subject deletion, removal of every independent assertion, or disappearance from the remote catalogue.',
      `  Captured revision: ${terminalString(detail.recordRevision)}`,
      `  Captured digest: ${detail.digest}`,
      `  Captured converter revision: ${terminalString(detail.converterRevision)}`,
      `  Recorded subject binding: ${detail.subjectBinding ? terminalString(detail.subjectBinding) : 'not available'}`,
    ];
  }
  return [
    `Exact record ${terminalString(detail.recordKey)}: ${detail.kind}${detail.skipped ? ' (ignored/skipped converter outcome)' : ''}`,
    `  Record revision: ${terminalString(detail.recordRevision)}`,
    `  Converter revision: ${terminalString(detail.converterRevision)}`,
    `  Digest: ${detail.digest}`,
    `  Provenance: ${detail.provenanceJson}`,
    `  Prospective operations: ${detail.operationsJson}`,
    `  Converter diagnostics: ${detail.diagnosticsJson}`,
    `  Admitted public fields: ${detail.displayJson}`,
  ];
}

function renderPage(page: ReturnType<DumpPreview['page']>): string[] {
  const lines = [`${page.kind} page (${page.rows.length} of at most ${page.limit} rows):`];
  for (const row of page.rows) {
    if ('digest' in row && 'recordRevision' in row && !('skipped' in row)) {
      lines.push(`  ${terminalString(row.recordKey)} vanished revision=${terminalString(row.recordRevision)}`);
    } else if ('skipped' in row) {
      lines.push(
        `  ${terminalString(row.recordKey)} ${row.kind} revision=${terminalString(row.recordRevision)} digest=${row.digest}${row.skipped ? ' skipped' : ''}`,
      );
    }
  }
  lines.push(
    page.end === 'more'
      ? `More rows are available. Next cursor: ${page.nextCursor}`
      : 'End of this preview page; no next cursor.',
  );
  return lines;
}

function documentFor(preview: DumpPreview, parsed: ParsedPreviewArgs): Record<string, unknown> {
  const plan = preview.plan;
  const document: Record<string, unknown> = {
    version: 1,
    previewId: plan.previewId,
    source: plan.source,
    sourceKind: plan.sourceKind,
    converterRevision: plan.converterRevision,
    view: plan.viewKind,
    baseline: plan.baselineId ? { generation: plan.baselineId, presentCount: plan.baselinePresent } : null,
    complete: plan.complete,
    error: plan.errorIdentity ? { identity: plan.errorIdentity, message: plan.errorMessage } : null,
    disappearanceWouldBlock: plan.disappearanceWouldBlock,
    counts: {
      admitted: plan.admitted,
      skipped: plan.skipped,
      new: plan.newCount,
      changed: plan.changedCount,
      unchanged: plan.unchangedCount,
      vanished: plan.complete ? plan.vanishedCount : null,
      prior: plan.prior,
      survivors: plan.survivors,
      denominator: plan.admitted,
    },
    store: preview.directory,
    importInvocation: importInvocation(plan),
  };
  if (parsed.record) document.record = preview.record(parsed.record);
  if (parsed.page)
    document.page = preview.page(parsed.page, {
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
    });
  return document;
}

function errorMessage(error: unknown): { code: number; message: string } {
  if (error instanceof DumpPreviewFailure || error instanceof PreviewStoreFailure)
    return { code: error.code, message: error.message };
  if (error instanceof DumpInputError) return { code: 2, message: error.message };
  if (error instanceof DOMException && error.name === 'AbortError')
    return { code: 130, message: 'Preview was cancelled.' };
  return { code: 1, message: 'Preview failed safely; importer state was not changed.' };
}

function requestedJson(argv: readonly string[]): boolean {
  return Array.isArray(argv) && argv.includes('--json');
}

/** Offline dump preview. It does not construct credentials, transport or importer objects. */
export async function runPreviewCli(
  argv: readonly string[],
  options: PreviewCliOptions = {},
): Promise<PreviewCliResult> {
  if (options.fetch) {
    const forbidden = options.fetch;
    options = {
      ...options,
      fetch: (async () => {
        throw new Error('Dump preview must not perform network effects.');
      }) as unknown as typeof fetch,
    };
    void forbidden;
  }
  const jsonRequested = requestedJson(argv);
  let parsed: ParsedPreviewArgs | 'help';
  try {
    parsed = parsePreviewArgs(argv);
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

  let preview: DumpPreview | undefined;
  try {
    if (options.signal?.aborted) throw new DumpPreviewFailure('Preview was cancelled.', 130);
    let zstdExecutable = parsed.zstdExecutable;
    if (!parsed.planDir && parsed.compression === 'zstd') {
      zstdExecutable = await resolveZstdExecutable(parsed.zstdExecutable);
      await probeZstdExecutable(zstdExecutable, {
        ...(options.signal ? { signal: options.signal } : {}),
      });
    }
    preview = parsed.planDir
      ? await DumpPreview.open(parsed.planDir)
      : await DumpPreview.build({
          source: parsed.source!,
          dump: parsed.dump!,
          ...(parsed.sourceAlias ? { sourceAlias: parsed.sourceAlias } : {}),
          ...(parsed.baseline ? { baseline: parsed.baseline } : {}),
          ...(parsed.outputDir ? { outputDir: parsed.outputDir } : {}),
          ...(options.stdin ? { stdin: options.stdin } : {}),
          ...(options.entries ? { entries: options.entries } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          compression: parsed.compression,
          ...(parsed.decodeBudget === undefined ? {} : { decodeBudget: parsed.decodeBudget }),
          ...(zstdExecutable === undefined ? {} : { zstdExecutable }),
        } satisfies DumpPreviewOptions);
    const code = preview.plan.complete ? 0 : 2;
    if (parsed.json)
      return {
        code,
        stdout: `${jsonSafe(documentFor(preview, parsed))}\n`,
        stderr: '',
        openHandles: 0,
      };
    const lines = renderPlan(preview.plan, preview.directory);
    if (parsed.page) {
      if (parsed.page === 'vanished' && !preview.plan.complete)
        throw new DumpPreviewFailure('Incomplete input cannot present a vanished membership page.', 2);
      lines.push(
        ...renderPage(
          preview.page(parsed.page, {
            ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
            ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
          }),
        ),
      );
    } else if (!parsed.record) {
      const defaultKind: PreviewKind =
        preview.plan.changedCount > 0 ? 'changed' : preview.plan.newCount > 0 ? 'new' : 'unchanged';
      if (preview.plan.newCount || preview.plan.changedCount || preview.plan.unchangedCount)
        lines.push(...renderPage(preview.page(defaultKind, { limit: DEFAULT_PREVIEW_PAGE })));
    }
    if (parsed.record) lines.push(...renderRecord(preview.record(parsed.record)));
    return { code, stdout: `${lines.join('\n')}\n`, stderr: '', openHandles: 0 };
  } catch (error) {
    const detail = errorMessage(error);
    if (parsed.json)
      return {
        code: detail.code,
        stdout: `${jsonSafe({ version: 1, error: detail.message })}\n`,
        stderr: '',
        openHandles: 0,
      };
    return { code: detail.code, stdout: '', stderr: `${terminalSafeMessage(detail.message)}\n`, openHandles: 0 };
  } finally {
    await preview?.close();
  }
}
