import {
  applyRetentionPlan,
  buildRetentionPlan,
  listRetentionGenerations,
  RETENTION_DEFAULT_PAGE,
  type RetentionApplyDocument,
  type RetentionGenerationRow,
  type RetentionListDocument,
  type RetentionOptions,
  type RetentionPlanDocument,
} from './retention.ts';
import { RetentionFailure } from './retention-errors.ts';

const MAX_ARGUMENTS_WITH_COMMAND = 64;
const MAX_ARGUMENT_BYTES = 4096;
const MAX_TOTAL_ARGUMENT_BYTES = 16_384;
const USAGE = [
  'Usage: rezics-import retention --state <sqlite-path> --source <configured-source-id>',
  '       [--after <generation-id>] [--limit 1..100] [--json]',
  '       rezics-import retention --state <sqlite-path> --source <configured-source-id>',
  '       --generation <id> [--generation <id> ...] --output <plan-path> [--json]',
  '       rezics-import retention --state <sqlite-path> --plan <plan-path> --confirm <plan-id> --apply [--json]',
  '       rezics-import retention --help',
  'Default is a read-only page of exact generations. Apply requires the current plan identity and revalidation.',
  'Retention is local importer history cleanup. It never contacts Auth or the API, and it never VACUUMs the state file.',
].join('\n');

export type RetentionCliResult = Readonly<{ code: number; stdout: string; stderr: string; openHandles: number }>;
export type RetentionCliOptions = RetentionOptions;

class UsageFailure extends RetentionFailure {
  constructor(message: string) {
    super(message, 'usage');
  }
}

type Parsed =
  | 'help'
  | { command: 'list'; state: string; source: string; after?: string; limit?: number; json: boolean }
  | { command: 'plan'; state: string; source: string; generations: string[]; output: string; json: boolean }
  | { command: 'apply'; state: string; plan: string; confirm: string; json: boolean };

function jsonSafe(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  );
}

function terminalSafe(value: string): string {
  return value.replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  );
}

function boundedArguments(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length + 1 > MAX_ARGUMENTS_WITH_COMMAND)
    throw new UsageFailure('Retention arguments exceed the supported count.');
  let totalBytes = Buffer.byteLength('retention', 'utf8');
  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.length > MAX_ARGUMENT_BYTES || argument.includes('\0'))
      throw new UsageFailure('Retention arguments exceed the supported size.');
    totalBytes += Buffer.byteLength(argument, 'utf8');
    if (totalBytes > MAX_TOTAL_ARGUMENT_BYTES) throw new UsageFailure('Retention arguments exceed the supported size.');
  }
}

export function retentionUsage(): string {
  return USAGE;
}

export function parseRetentionArgs(argv: readonly string[]): Parsed {
  boundedArguments(argv);
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) return 'help';
  const values = new Map<string, string>();
  const generations: string[] = [];
  const valueFlags = new Set(['--state', '--source', '--after', '--limit', '--output', '--plan', '--confirm']);
  let json = false;
  let apply = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--help') throw new UsageFailure('Retention help cannot be mixed with other flags.');
    if (flag === '--json') {
      if (json) throw new UsageFailure('Retention flags cannot be repeated.');
      json = true;
      continue;
    }
    if (flag === '--apply') {
      if (apply) throw new UsageFailure('Retention flags cannot be repeated.');
      apply = true;
      continue;
    }
    if (flag === '--generation') {
      const value = argv[++index];
      if (value === undefined || value.length === 0 || value.startsWith('--'))
        throw new UsageFailure('Retention flag --generation requires one value.');
      generations.push(value);
      continue;
    }
    if (!valueFlags.has(flag) || values.has(flag))
      throw new UsageFailure('Unknown, import-only or repeated retention flag.');
    const value = argv[++index];
    if (value === undefined || value.length === 0 || value.startsWith('--'))
      throw new UsageFailure(`Retention flag ${flag} requires one value.`);
    values.set(flag, value);
  }
  const state = values.get('--state');
  if (!state || !state.trim() || state === '-') throw new UsageFailure('Retention requires --state <sqlite-path>.');
  if (apply) {
    if (
      values.has('--source') ||
      values.has('--after') ||
      values.has('--limit') ||
      values.has('--output') ||
      generations.length
    )
      throw new UsageFailure('Apply uses --state, --plan and --confirm.');
    const plan = values.get('--plan');
    const confirm = values.get('--confirm');
    if (!plan || !confirm) throw new UsageFailure('Apply requires --plan <path> and --confirm <plan-id>.');
    return { command: 'apply', state, plan, confirm, json };
  }
  if (values.has('--plan') || values.has('--confirm'))
    throw new UsageFailure('A plan identity is only used with --apply.');
  const source = values.get('--source');
  if (!source) throw new UsageFailure('Listing and planning require --source <configured-source-id>.');
  if (generations.length || values.has('--output')) {
    if (values.has('--after') || values.has('--limit'))
      throw new UsageFailure('A retention plan uses --generation and --output.');
    const output = values.get('--output');
    if (!output || generations.length === 0)
      throw new UsageFailure('A retention plan requires --generation <id> and --output <path>.');
    return { command: 'plan', state, source, generations, output, json };
  }
  const parsed: Extract<Parsed, { command: 'list' }> = { command: 'list', state, source, json };
  const after = values.get('--after');
  if (after !== undefined) parsed.after = after;
  const limitValue = values.get('--limit');
  if (limitValue !== undefined) {
    if (!/^(?:[1-9][0-9]{0,2})$/u.test(limitValue))
      throw new UsageFailure('--limit must be an integer from 1 through 100.');
    const limit = Number(limitValue);
    if (limit > 100) throw new UsageFailure('--limit must be an integer from 1 through 100.');
    parsed.limit = limit;
  }
  return parsed;
}

function pinLabel(pin: RetentionGenerationRow['pin']): string {
  if (pin === 'baseline') return 'baseline pin';
  if (pin === 'active') return 'active/recoverable pin';
  return 'unpinned';
}

function countLine(counts: RetentionGenerationRow['counts']): string {
  return `entries ${counts.entries}, envelopes ${counts.envelopes}, commands ${counts.commands}, diagnostics ${counts.diagnostics}, diagnostic records ${counts.diagnosticRecords}, aggregate operations ${counts.aggregateOperations}, vndb runs ${counts.vndbRuns}, vndb rows ${counts.vndbRows}, vndb spool ${counts.vndbSpool}`;
}

function renderGeneration(row: RetentionGenerationRow): string[] {
  return [
    `Generation ${JSON.stringify(row.id)}: status ${row.status}; ${pinLabel(row.pin)}; ${row.eligible ? 'eligible' : 'ineligible'} (${row.reason}).`,
    `  ${row.explanation}`,
    `  Retained generation-local rows: ${countLine(row.counts)}.`,
  ];
}

function renderList(document: RetentionListDocument): string {
  const lines = [
    `Source: ${JSON.stringify(document.source)}`,
    `Source state: ${document.sourceState}`,
    `Completed baseline: ${document.baseline ? JSON.stringify(document.baseline) : 'none'}; active/recoverable: ${document.active ? JSON.stringify(document.active) : 'none'}; present ${document.presentCount ?? 'none'}; sequence ${document.sequence ?? 'none'}.`,
    `Ownership row: ${document.ownershipRow}; listing never claims a lease.`,
    `Generation page (${document.generations.length} of at most ${document.limit}):`,
  ];
  if (document.generations.length === 0) lines.push('  No generations in this page.');
  for (const row of document.generations) lines.push(...renderGeneration(row));
  lines.push(
    document.end === 'more'
      ? `More generations are available. Next --after ${JSON.stringify(document.nextAfter)}`
      : 'End of this generation page; no next cursor.',
  );
  lines.push('Preserved authorities:');
  for (const item of document.preserved) lines.push(`  ${item}`);
  lines.push(document.sqliteNote);
  lines.push(document.snapshot);
  lines.push(
    'Build an explicit plan with --generation <id> --output <plan-path>. Apply never runs from a listing page.',
  );
  return `${lines.join('\n')}\n`;
}

function renderPlan(document: RetentionPlanDocument): string {
  const lines = [
    `Retention plan ${document.planId}`,
    `Source: ${JSON.stringify(document.source)}`,
    `State identity: dev ${document.state.dev}, ino ${document.state.ino}, user_version ${document.state.userVersion}`,
    `Pins: baseline ${document.pins.baseline ? JSON.stringify(document.pins.baseline) : 'none'}, active ${document.pins.active ? JSON.stringify(document.pins.active) : 'none'}, present ${document.pins.presentCount}, sequence ${document.pins.sequence}, ownership ${document.pins.ownershipRow}`,
    `Applyable: ${document.applyable ? 'yes' : 'no'}; selected ${document.selected.length} generation(s).`,
  ];
  for (const row of document.selected) lines.push(...renderGeneration(row));
  lines.push('Becomes unavailable:');
  for (const item of document.unavailable) lines.push(`  ${item}`);
  lines.push('Remains preserved:');
  for (const item of document.preserved) lines.push(`  ${item}`);
  lines.push(document.sqliteNote);
  lines.push(document.snapshot);
  lines.push(`Apply: ${document.apply}`);
  return `${lines.join('\n')}\n`;
}

function renderApply(document: RetentionApplyDocument): string {
  const lines = [
    `Retention apply ${document.status} for plan ${document.planId}`,
    `Source: ${JSON.stringify(document.source)}`,
    `Retired generations: ${document.retired.length ? document.retired.map((id) => JSON.stringify(id)).join(', ') : 'none'}`,
    `In-progress generations: ${document.inProgress.length ? document.inProgress.map((id) => JSON.stringify(id)).join(', ') : 'none'}`,
    document.sqliteNote,
    document.snapshot,
  ];
  return `${lines.join('\n')}\n`;
}

function errorMessage(error: unknown): { code: number; message: string } {
  if (error instanceof RetentionFailure) return { code: error.code, message: error.message };
  return { code: 1, message: 'Retention failed safely; importer state was not replaced.' };
}

function requestedJson(argv: readonly string[]): boolean {
  return Array.isArray(argv) && argv.includes('--json');
}

export async function runRetentionCli(
  argv: readonly string[],
  options: RetentionCliOptions = {},
): Promise<RetentionCliResult> {
  const jsonRequested = requestedJson(argv);
  let parsed: Parsed;
  try {
    parsed = parseRetentionArgs(argv);
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
    return { code: detail.code, stdout: '', stderr: `${terminalSafe(detail.message)}\n${USAGE}\n`, openHandles: 0 };
  }

  let document: RetentionListDocument | RetentionPlanDocument | RetentionApplyDocument | undefined;
  let failure: { code: number; message: string } | undefined;
  try {
    if (parsed.command === 'list')
      document = await listRetentionGenerations(
        {
          state: parsed.state,
          source: parsed.source,
          ...(parsed.after ? { after: parsed.after } : {}),
          ...(parsed.limit !== undefined ? { limit: parsed.limit } : { limit: RETENTION_DEFAULT_PAGE }),
        },
        options,
      );
    else if (parsed.command === 'plan')
      document = await buildRetentionPlan(
        { state: parsed.state, source: parsed.source, generations: parsed.generations, output: parsed.output },
        options,
      );
    else
      document = await applyRetentionPlan({ state: parsed.state, plan: parsed.plan, confirm: parsed.confirm }, options);
  } catch (error) {
    failure = errorMessage(error);
  }
  if (failure) {
    if (parsed.json)
      return {
        code: failure.code,
        stdout: `${jsonSafe({ version: 1, error: failure.message })}\n`,
        stderr: '',
        openHandles: 0,
      };
    return { code: failure.code, stdout: '', stderr: `${terminalSafe(failure.message)}\n`, openHandles: 0 };
  }
  const body = parsed.json
    ? `${jsonSafe(document)}\n`
    : parsed.command === 'list'
      ? renderList(document as RetentionListDocument)
      : parsed.command === 'plan'
        ? renderPlan(document as RetentionPlanDocument)
        : renderApply(document as RetentionApplyDocument);
  const cancelled = parsed.command === 'apply' && (document as RetentionApplyDocument).status === 'cancelled';
  return { code: cancelled ? 130 : 0, stdout: body, stderr: '', openHandles: 0 };
}
