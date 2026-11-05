import { DumpInputError } from './dump-input.ts';
import { PlanComparison, PlanComparisonFailure } from './plan-comparison.ts';
import {
  ComparisonStoreFailure,
  DEFAULT_COMPARISON_PAGE,
  MAX_COMPARISON_PAGE,
  isComparisonKind,
  validComparisonRecordKey,
  type ComparisonKind,
  type ComparisonPlan,
} from './plan-comparison-store.ts';

const MAX_ARGUMENTS_WITH_COMMAND = 64;
const MAX_ARGUMENT_BYTES = 4096;
const MAX_TOTAL_ARGUMENT_BYTES = 16_384;
const USAGE = [
  'Usage: rezics-import compare --left <preview-dir> --right <preview-dir>',
  '       [--output-dir <path>] [--page only-left|only-right|changed|unchanged|skipped|unavailable]',
  '       [--limit 1..100] [--cursor <opaque-cursor>] [--record <native-record-key>] [--json]',
  '       rezics-import compare --comparison-dir <path> [--page ...] [--record ...] [--json]',
  '       rezics-import compare --help',
  'Pages default to 20 rows. Comparison is local and offline; it never imports, writes import state, or contacts the API.',
].join('\n');

export type CompareCliResult = Readonly<{ code: number; stdout: string; stderr: string; openHandles: number }>;
export type CompareCliOptions = Readonly<{
  signal?: AbortSignal;
  fetch?: typeof fetch;
}>;

export type ParsedCompareArgs = Readonly<{
  left?: string;
  right?: string;
  outputDir?: string;
  comparisonDir?: string;
  page?: ComparisonKind;
  limit?: number;
  cursor?: string;
  record?: string;
  json: boolean;
}>;

class UsageFailure extends PlanComparisonFailure {
  constructor(message: string) {
    super(message, 2);
  }
}

function boundedArguments(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length + 1 > MAX_ARGUMENTS_WITH_COMMAND)
    throw new UsageFailure('Comparison arguments exceed the supported count.');
  let totalBytes = Buffer.byteLength('compare', 'utf8');
  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.length > MAX_ARGUMENT_BYTES || argument.includes('\0'))
      throw new UsageFailure('Comparison arguments exceed the supported size.');
    totalBytes += Buffer.byteLength(argument, 'utf8');
    if (totalBytes > MAX_TOTAL_ARGUMENT_BYTES)
      throw new UsageFailure('Comparison arguments exceed the supported size.');
  }
}

export function parseCompareArgs(argv: readonly string[]): ParsedCompareArgs | 'help' {
  boundedArguments(argv);
  if (argv.length === 1 && argv[0] === '--help') return 'help';
  const values = new Map<string, string>();
  const valueFlags = new Set([
    '--left',
    '--right',
    '--output-dir',
    '--comparison-dir',
    '--page',
    '--limit',
    '--cursor',
    '--record',
  ]);
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--json') {
      if (json) throw new UsageFailure('Comparison flags cannot be repeated.');
      json = true;
      continue;
    }
    if (!valueFlags.has(flag) || values.has(flag))
      throw new UsageFailure('Unknown, import-only or repeated comparison flag.');
    const value = argv[++index];
    if (value === undefined || value.length === 0 || value.startsWith('--'))
      throw new UsageFailure(`Comparison flag ${flag} requires one value.`);
    values.set(flag, value);
  }

  const comparisonDir = values.get('--comparison-dir');
  const left = values.get('--left');
  const right = values.get('--right');
  if (comparisonDir) {
    if (left || right || values.has('--output-dir'))
      throw new UsageFailure(
        '--comparison-dir reopens a retained comparison and cannot be combined with plan acquisition flags.',
      );
    if (!comparisonDir.trim() || comparisonDir === '-')
      throw new UsageFailure('--comparison-dir must be a caller-owned directory.');
  } else {
    if (!left || !right) throw new UsageFailure('Comparison requires --left and --right preview directories.');
    if (!left.trim() || left === '-' || !right.trim() || right === '-')
      throw new UsageFailure('Comparison plan directories are invalid.');
  }
  const outputDir = values.get('--output-dir');
  if (outputDir !== undefined && (!outputDir.trim() || outputDir === '-'))
    throw new UsageFailure('--output-dir must be a caller-owned directory.');
  const page = values.get('--page');
  if (page !== undefined && !isComparisonKind(page))
    throw new UsageFailure('--page must be only-left, only-right, changed, unchanged, skipped or unavailable.');
  const limitValue = values.get('--limit');
  let limit: number | undefined;
  if (limitValue !== undefined) {
    if (!/^(?:[1-9][0-9]{0,2})$/u.test(limitValue))
      throw new UsageFailure('--limit must be an integer from 1 through 100.');
    limit = Number(limitValue);
    if (limit > MAX_COMPARISON_PAGE) throw new UsageFailure('--limit must be an integer from 1 through 100.');
    if (page === undefined)
      throw new UsageFailure('--limit requires --page only-left|only-right|changed|unchanged|skipped|unavailable.');
  }
  const cursor = values.get('--cursor');
  if (cursor !== undefined && page === undefined && values.get('--record') === undefined)
    throw new UsageFailure('--cursor requires --page or --record.');
  const record = values.get('--record');
  if (record !== undefined) {
    try {
      validComparisonRecordKey(record);
    } catch {
      throw new UsageFailure('--record must be an exact native source record key.');
    }
  }
  return {
    json,
    ...(left ? { left } : {}),
    ...(right ? { right } : {}),
    ...(comparisonDir ? { comparisonDir } : {}),
    ...(outputDir ? { outputDir } : {}),
    ...(page ? { page: page as ComparisonKind } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor ? { cursor } : {}),
    ...(record ? { record } : {}),
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

function importInvocation(plan: ComparisonPlan): string[] {
  const alias = plan.source === plan.sourceKind ? '' : ` --source-alias ${terminalString(plan.source)}`;
  return [
    'Ordinary import reopens the actual dump, acquires its lease, and rechecks authority and fences. Comparison evidence does not license a later file, apply a preview, or bypass those checks.',
    `  bun services/importer/src/cli.ts --source ${plan.sourceKind}${alias} --dump <complete-input-path> --state <sqlite-path> --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>`,
  ];
}

function baselineLine(view: string, baseline: string | null, present: number): string {
  return view === 'first-import'
    ? 'first-import preview; this is not proof that the server has no existing subjects'
    : `baseline-comparison against captured generation ${terminalString(baseline ?? '')} (present=${present})`;
}

function renderPlan(plan: ComparisonPlan, directory: string): string[] {
  const lines = [
    `Comparison: ${plan.comparisonId}`,
    `Source kind: ${plan.sourceKind}`,
    `Configured source: ${terminalString(plan.source)}`,
    `Left converter: ${terminalString(plan.leftConverter)}`,
    `Right converter: ${terminalString(plan.rightConverter)}`,
    `Converter revisions differ: ${plan.converterDiffers ? 'yes' : 'no'}`,
    `Admitted input paths differ: ${plan.inputDiffers ? 'yes' : 'no'}`,
    `Left input: complete admitted=${plan.leftAdmitted} skipped=${plan.leftSkipped} dump=${terminalString(plan.leftDump)}`,
    `Right input: complete admitted=${plan.rightAdmitted} skipped=${plan.rightSkipped} dump=${terminalString(plan.rightDump)}`,
    `Left view: ${baselineLine(plan.leftView, plan.leftBaseline, plan.leftBaselinePresent)}`,
    `Right view: ${baselineLine(plan.rightView, plan.rightBaseline, plan.rightBaselinePresent)}`,
    `Plan-owned vanished counts: left=${plan.leftVanished} right=${plan.rightVanished}; absence from one dump is an input comparison difference, not that plan's withdrawal eligibility.`,
    `Counts: only-left=${plan.onlyLeftCount} only-right=${plan.onlyRightCount} changed=${plan.changedCount} unchanged=${plan.unchangedCount} skipped=${plan.skippedCount} unavailable=${plan.unavailableCount}`,
    `Comparison store: ${directory}`,
    `Complete: ${plan.complete ? 'yes' : 'no'}`,
  ];
  if (plan.leftBaseline === null && plan.rightBaseline === null)
    lines.push('Neither plan captured a baseline; this first-import comparison does not establish server emptiness.');
  if (plan.inputDiffers && plan.converterDiffers)
    lines.push(
      'Different admitted input and different converter revisions are both present; the captures do not assign causal responsibility.',
    );
  lines.push(...importInvocation(plan));
  return lines;
}

function renderRecord(
  detail: ReturnType<PlanComparison['record']>,
  parts: ReturnType<PlanComparison['parts']>,
): string[] {
  if (!detail.found) return [`Exact record ${terminalString(detail.recordKey)}: not present in this comparison.`];
  const lines = [
    `Exact record ${terminalString(detail.recordKey)}: ${detail.kind}`,
    `  Left: ${detail.leftKind ? `${detail.leftKind} revision=${terminalString(detail.leftRevision ?? '')} digest=${detail.leftDigest} converter=${terminalString(detail.leftConverter ?? '')}${detail.leftSkipped ? ' skipped' : ''}` : 'absent from the left prospective dump'}`,
    `  Right: ${detail.rightKind ? `${detail.rightKind} revision=${terminalString(detail.rightRevision ?? '')} digest=${detail.rightDigest} converter=${terminalString(detail.rightConverter ?? '')}${detail.rightSkipped ? ' skipped' : ''}` : 'absent from the right prospective dump'}`,
    `  Digest distinction: ${detail.digestDiffers ? 'changed' : 'equal'}`,
    `  Converter distinction: ${detail.converterDiffers ? 'changed' : 'equal'}`,
    `  Retained rendered fields: ${detail.retainedEqual ? 'equal; a digest or revision distinction is not complete semantic equivalence' : 'changed'}`,
  ];
  if (detail.kind === 'only-left' || detail.kind === 'only-right') {
    lines.push(
      "  Presence in a preview is prospective source membership. Absence from the other dump is an input comparison difference; source withdrawal eligibility still belongs to that plan's complete acquisition.",
    );
  }
  if (detail.leftVanished || detail.rightVanished) {
    lines.push(
      `  Plan-owned vanished markers: left=${detail.leftVanished ? 'yes' : 'no'} right=${detail.rightVanished ? 'yes' : 'no'}`,
    );
  }
  lines.push(`  Difference parts (${parts.rows.length} of at most ${parts.limit}):`);
  for (const part of parts.rows) {
    lines.push(
      `    ${terminalString(part.address)} ${part.change} domain=${part.domain} before=${part.beforeJson ?? 'none'} after=${part.afterJson ?? 'none'}`,
    );
  }
  lines.push(
    parts.end === 'more'
      ? `  More difference parts are available. Next cursor: ${parts.nextCursor}`
      : "  End of this record's difference parts; no next cursor.",
  );
  return lines;
}

function renderPage(page: ReturnType<PlanComparison['page']>): string[] {
  const lines = [`${page.kind} page (${page.rows.length} of at most ${page.limit} rows):`];
  for (const row of page.rows) {
    lines.push(
      `  ${terminalString(row.recordKey)} ${row.kind} digest=${row.digestDiffers ? 'changed' : 'equal'} converter=${row.converterDiffers ? 'changed' : 'equal'} retained=${row.retainedEqual ? 'equal' : 'changed'}`,
    );
  }
  lines.push(
    page.end === 'more'
      ? `More rows are available. Next cursor: ${page.nextCursor}`
      : 'End of this comparison page; no next cursor.',
  );
  return lines;
}

function defaultKind(plan: ComparisonPlan): ComparisonKind | null {
  if (plan.changedCount > 0) return 'changed';
  if (plan.onlyLeftCount > 0) return 'only-left';
  if (plan.onlyRightCount > 0) return 'only-right';
  if (plan.skippedCount > 0) return 'skipped';
  if (plan.unavailableCount > 0) return 'unavailable';
  if (plan.unchangedCount > 0) return 'unchanged';
  return null;
}

function documentFor(comparison: PlanComparison, parsed: ParsedCompareArgs): Record<string, unknown> {
  const plan = comparison.plan;
  const document: Record<string, unknown> = {
    version: 1,
    comparisonId: plan.comparisonId,
    captureDigest: plan.captureDigest,
    source: plan.source,
    sourceKind: plan.sourceKind,
    left: {
      previewId: plan.leftPreviewId,
      converterRevision: plan.leftConverter,
      dumpPath: plan.leftDump,
      view: plan.leftView,
      baseline: plan.leftBaseline ? { generation: plan.leftBaseline, presentCount: plan.leftBaselinePresent } : null,
      admitted: plan.leftAdmitted,
      skipped: plan.leftSkipped,
      vanished: plan.leftVanished,
    },
    right: {
      previewId: plan.rightPreviewId,
      converterRevision: plan.rightConverter,
      dumpPath: plan.rightDump,
      view: plan.rightView,
      baseline: plan.rightBaseline ? { generation: plan.rightBaseline, presentCount: plan.rightBaselinePresent } : null,
      admitted: plan.rightAdmitted,
      skipped: plan.rightSkipped,
      vanished: plan.rightVanished,
    },
    inputDiffers: plan.inputDiffers,
    converterDiffers: plan.converterDiffers,
    complete: plan.complete,
    error: plan.errorIdentity ? { identity: plan.errorIdentity, message: plan.errorMessage } : null,
    counts: {
      onlyLeft: plan.onlyLeftCount,
      onlyRight: plan.onlyRightCount,
      changed: plan.changedCount,
      unchanged: plan.unchangedCount,
      skipped: plan.skippedCount,
      unavailable: plan.unavailableCount,
    },
    store: comparison.directory,
    importInvocation: importInvocation(plan),
  };
  if (parsed.record) {
    const detail = comparison.record(parsed.record);
    document.record = detail;
    if (detail.found)
      document.parts = comparison.parts(parsed.record, {
        limit: parsed.page ? DEFAULT_COMPARISON_PAGE : (parsed.limit ?? DEFAULT_COMPARISON_PAGE),
        ...(parsed.page || !parsed.cursor ? {} : { cursor: parsed.cursor }),
      });
  }
  if (parsed.page)
    document.page = comparison.page(parsed.page, {
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
    });
  return document;
}

function errorMessage(error: unknown): { code: number; message: string } {
  if (error instanceof PlanComparisonFailure || error instanceof ComparisonStoreFailure)
    return { code: error.code, message: error.message };
  if (error instanceof DumpInputError) return { code: 2, message: 'Input is unavailable or invalid.' };
  if (error instanceof DOMException && error.name === 'AbortError')
    return { code: 130, message: 'Comparison was cancelled.' };
  return { code: 1, message: 'Comparison failed safely; importer state was not changed.' };
}

function requestedJson(argv: readonly string[]): boolean {
  return Array.isArray(argv) && argv.includes('--json');
}

/** Offline plan comparison. It does not construct credentials, transport or importer objects. */
export async function runCompareCli(
  argv: readonly string[],
  options: CompareCliOptions = {},
): Promise<CompareCliResult> {
  if (options.fetch) {
    const forbidden = options.fetch;
    options = {
      ...options,
      fetch: (async () => {
        throw new Error('Plan comparison must not perform network effects.');
      }) as unknown as typeof fetch,
    };
    void forbidden;
  }
  const jsonRequested = requestedJson(argv);
  let parsed: ParsedCompareArgs | 'help';
  try {
    parsed = parseCompareArgs(argv);
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

  let comparison: PlanComparison | undefined;
  try {
    if (options.signal?.aborted) throw new PlanComparisonFailure('Comparison was cancelled.', 130);
    comparison = parsed.comparisonDir
      ? await PlanComparison.open(parsed.comparisonDir)
      : await PlanComparison.build({
          leftDir: parsed.left!,
          rightDir: parsed.right!,
          ...(parsed.outputDir ? { outputDir: parsed.outputDir } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
    const code = comparison.plan.complete ? 0 : 2;
    if (parsed.json)
      return {
        code,
        stdout: `${jsonSafe(documentFor(comparison, parsed))}\n`,
        stderr: '',
        openHandles: 0,
      };
    const lines = renderPlan(comparison.plan, comparison.directory);
    if (parsed.page) {
      lines.push(
        ...renderPage(
          comparison.page(parsed.page, {
            ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
            ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
          }),
        ),
      );
    } else if (!parsed.record) {
      const kind = defaultKind(comparison.plan);
      if (kind) lines.push(...renderPage(comparison.page(kind, { limit: DEFAULT_COMPARISON_PAGE })));
    }
    if (parsed.record) {
      const parts = comparison.parts(parsed.record, {
        limit: parsed.limit ?? DEFAULT_COMPARISON_PAGE,
        ...(parsed.page || !parsed.cursor ? {} : { cursor: parsed.cursor }),
      });
      lines.push(...renderRecord(comparison.record(parsed.record), parts));
    }
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
    await comparison?.close();
  }
}
