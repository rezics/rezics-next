import {
  applyStagingRetirementPlan,
  buildStagingRetirementPlan,
  reviewStagingRetirement,
  type StagingRetirementApplyDocument,
  type StagingRetirementOptions,
  type StagingRetirementPlanDocument,
  type StagingRetirementReview,
} from './staging-retirement.ts';
import { RetentionFailure } from './retention-errors.ts';

const MAX_ARGUMENTS_WITH_COMMAND = 64;
const MAX_ARGUMENT_BYTES = 4096;
const MAX_TOTAL_ARGUMENT_BYTES = 16_384;
const USAGE = [
  'Usage: rezics-import retire-staging --state <sqlite-path> --source <configured-source-id> --generation <id> [--json]',
  '       rezics-import retire-staging --state <sqlite-path> --source <configured-source-id> --generation <id> --output <plan-path> [--json]',
  '       rezics-import retire-staging --state <sqlite-path> --plan <plan-path> --confirm <plan-id> --apply [--json]',
  '       rezics-import retire-staging --help',
  'Default is a read-only review of one exact unpublished staging capture. Apply requires the current plan identity and revalidation.',
  'This command never contacts Auth or the API, never requires the original dump, and never VACUUMs the state file.',
  'VNDB table acquisitions that have not become native staging stay unsupported and are not deleted.',
].join('\n');

export type StagingRetirementCliResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
  openHandles: number;
}>;
export type StagingRetirementCliOptions = StagingRetirementOptions;

class UsageFailure extends RetentionFailure {
  constructor(message: string) {
    super(message, 'usage');
  }
}

type Parsed =
  | 'help'
  | { command: 'review'; state: string; source: string; generation: string; json: boolean }
  | { command: 'plan'; state: string; source: string; generation: string; output: string; json: boolean }
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
    throw new UsageFailure('Staging retirement arguments exceed the supported count.');
  let totalBytes = Buffer.byteLength('retire-staging', 'utf8');
  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.length > MAX_ARGUMENT_BYTES || argument.includes('\0'))
      throw new UsageFailure('Staging retirement arguments exceed the supported size.');
    totalBytes += Buffer.byteLength(argument, 'utf8');
    if (totalBytes > MAX_TOTAL_ARGUMENT_BYTES)
      throw new UsageFailure('Staging retirement arguments exceed the supported size.');
  }
}

export function stagingRetirementUsage(): string {
  return USAGE;
}

export function parseStagingRetirementArgs(argv: readonly string[]): Parsed {
  boundedArguments(argv);
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) return 'help';
  const values = new Map<string, string>();
  const valueFlags = new Set(['--state', '--source', '--generation', '--output', '--plan', '--confirm']);
  let json = false;
  let apply = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--help') throw new UsageFailure('Staging retirement help cannot be mixed with other flags.');
    if (flag === '--json') {
      if (json) throw new UsageFailure('Staging retirement flags cannot be repeated.');
      json = true;
      continue;
    }
    if (flag === '--apply') {
      if (apply) throw new UsageFailure('Staging retirement flags cannot be repeated.');
      apply = true;
      continue;
    }
    if (!valueFlags.has(flag) || values.has(flag))
      throw new UsageFailure('Unknown, import-only or repeated staging retirement flag.');
    const value = argv[++index];
    if (value === undefined || value.length === 0 || value.startsWith('--'))
      throw new UsageFailure(`Staging retirement flag ${flag} requires one value.`);
    values.set(flag, value);
  }
  const state = values.get('--state');
  if (!state || !state.trim() || state === '-')
    throw new UsageFailure('Staging retirement requires --state <sqlite-path>.');
  if (apply) {
    if (values.has('--source') || values.has('--generation') || values.has('--output'))
      throw new UsageFailure('Apply uses --state, --plan and --confirm.');
    const plan = values.get('--plan');
    const confirm = values.get('--confirm');
    if (!plan || !confirm) throw new UsageFailure('Apply requires --plan <path> and --confirm <plan-id>.');
    return { command: 'apply', state, plan, confirm, json };
  }
  if (values.has('--plan') || values.has('--confirm'))
    throw new UsageFailure('A plan identity is only used with --apply.');
  const source = values.get('--source');
  const generation = values.get('--generation');
  if (!source || !generation)
    throw new UsageFailure('Review and planning require --source <configured-source-id> and --generation <id>.');
  const output = values.get('--output');
  if (output) return { command: 'plan', state, source, generation, output, json };
  return { command: 'review', state, source, generation, json };
}

function renderReview(document: StagingRetirementReview): string {
  const checkpoint =
    document.checkpoint === null
      ? 'none'
      : document.checkpoint.state === 'present'
        ? `present; committed prefix ${document.checkpoint.committedOrdinal} records, ${document.checkpoint.bytes} hashed bytes`
        : document.checkpoint.state;
  const lines = [
    `Source: ${JSON.stringify(document.source)}`,
    `Generation: ${JSON.stringify(document.generation)}; status ${document.status}; ${document.pin === 'active' ? 'active/recoverable pin' : document.pin === 'baseline' ? 'baseline pin' : 'unpinned'}.`,
    `Eligibility: ${document.eligible ? 'eligible' : 'ineligible'} (${document.reason}).`,
    `  ${document.explanation}`,
    `Completed baseline: ${document.baseline ? JSON.stringify(document.baseline) : 'none'}; active/recoverable: ${document.active ? JSON.stringify(document.active) : 'none'}; present ${document.presentCount ?? 'none'}; sequence ${document.sequence ?? 'none'}.`,
    `Owner availability: ${document.ownerAvailability}; review never claims a lease.`,
    `Checkpoint: ${checkpoint}.`,
    `Retained capture-local rows: entries ${document.counts.entries}, diagnostics ${document.counts.diagnostics}, diagnostic records ${document.counts.diagnosticRecords}, staging checkpoints ${document.counts.stagingCheckpoints}, staging prefix ${document.counts.stagingPrefix}.`,
    `Resume consequence: ${document.resumeConsequence}`,
    'Becomes unavailable:',
  ];
  for (const item of document.unavailable) lines.push(`  ${item}`);
  lines.push('Remains preserved:');
  for (const item of document.preserved) lines.push(`  ${item}`);
  lines.push(document.sqliteNote);
  lines.push(document.snapshot);
  lines.push(
    'Build an explicit plan with --output <plan-path>. Confirmation names that plan and acknowledges that this unpublished input cannot be resumed after retirement.',
  );
  return `${lines.join('\n')}\n`;
}

function renderPlan(document: StagingRetirementPlanDocument): string {
  const lines = [
    `Staging retirement plan ${document.planId}`,
    `Source: ${JSON.stringify(document.source)}; generation ${JSON.stringify(document.generation)}`,
    `State identity: dev ${document.state.dev}, ino ${document.state.ino}, user_version ${document.state.userVersion}`,
    `Pins: baseline ${document.pins.baseline ? JSON.stringify(document.pins.baseline) : 'none'}, active ${document.pins.active ? JSON.stringify(document.pins.active) : 'none'}, present ${document.pins.presentCount}, sequence ${document.pins.sequence}, ownership ${document.pins.ownershipRow}`,
    `Applyable: ${document.applyable ? 'yes' : 'no'}. Confirmation acknowledges that this unpublished input/checkpoint cannot be resumed after retirement.`,
  ];
  lines.push(...renderReview(document.review).trimEnd().split('\n'));
  lines.push(`Apply: ${document.apply}`);
  return `${lines.join('\n')}\n`;
}

function renderApply(document: StagingRetirementApplyDocument): string {
  const lines = [
    `Staging retirement apply ${document.status} for plan ${document.planId}`,
    `Source: ${JSON.stringify(document.source)}; generation ${JSON.stringify(document.generation)}`,
    `Retired generations: ${document.retired.length ? document.retired.map((id) => JSON.stringify(id)).join(', ') : 'none'}`,
    `In-progress generations: ${document.inProgress.length ? document.inProgress.map((id) => JSON.stringify(id)).join(', ') : 'none'}`,
    document.sqliteNote,
    document.snapshot,
  ];
  return `${lines.join('\n')}\n`;
}

function errorMessage(error: unknown): { code: number; message: string } {
  if (error instanceof RetentionFailure) return { code: error.code, message: error.message };
  return { code: 1, message: 'Staging retirement failed safely; importer state was not replaced.' };
}

function requestedJson(argv: readonly string[]): boolean {
  return Array.isArray(argv) && argv.includes('--json');
}

export async function runStagingRetirementCli(
  argv: readonly string[],
  options: StagingRetirementCliOptions = {},
): Promise<StagingRetirementCliResult> {
  const jsonRequested = requestedJson(argv);
  let parsed: Parsed;
  try {
    parsed = parseStagingRetirementArgs(argv);
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

  let document: StagingRetirementReview | StagingRetirementPlanDocument | StagingRetirementApplyDocument | undefined;
  let failure: { code: number; message: string } | undefined;
  try {
    if (parsed.command === 'review')
      document = await reviewStagingRetirement(
        { state: parsed.state, source: parsed.source, generation: parsed.generation },
        options,
      );
    else if (parsed.command === 'plan')
      document = await buildStagingRetirementPlan(
        {
          state: parsed.state,
          source: parsed.source,
          generation: parsed.generation,
          output: parsed.output,
        },
        options,
      );
    else
      document = await applyStagingRetirementPlan(
        { state: parsed.state, plan: parsed.plan, confirm: parsed.confirm },
        options,
      );
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
    : parsed.command === 'review'
      ? renderReview(document as StagingRetirementReview)
      : parsed.command === 'plan'
        ? renderPlan(document as StagingRetirementPlanDocument)
        : renderApply(document as StagingRetirementApplyDocument);
  const cancelled = parsed.command === 'apply' && (document as StagingRetirementApplyDocument).status === 'cancelled';
  return { code: cancelled ? 130 : 0, stdout: body, stderr: '', openHandles: 0 };
}
