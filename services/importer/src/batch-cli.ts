import type { ImportCliOptions, ImportCliResult } from './cli.ts';
import type { ImportProgressEvent, ImportProgressMode, ImportProgressSink } from './import-progress.ts';
import {
  BATCH_PREFLIGHT_NOTE,
  BatchManifestError,
  MAX_BATCH_JOBS,
  MAX_BATCH_MANIFEST_BYTES,
  observationRecoveryCommand,
  ordinaryImportArgv,
  ordinaryRecoveryCommand,
  preflightBatchManifest,
  revalidateJobInputs,
  type BatchJobPlan,
  type BatchManifestPlan,
} from './batch-manifest.ts';

const MAX_ARGUMENTS_WITH_COMMAND = 64;
const MAX_ARGUMENT_BYTES = 4096;
const MAX_TOTAL_ARGUMENT_BYTES = 16_384;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT = /^[A-Za-z0-9._~-]{1,255}$/;

export const BATCH_DOCUMENT_VERSION = 1;

export function batchUsage(): string {
  return [
    'Usage: rezics-import batch --manifest <path> [--json]',
    '       rezics-import batch --manifest <path> --run --api <https-origin> --account-key <path>',
    '       --account <uuid> --client <client-id> --auth <https-origin> [--progress human|jsonl] [--json]',
    '       rezics-import batch --help',
    `The manifest is a versioned JSON list of at most ${MAX_BATCH_JOBS} independent source jobs and ${MAX_BATCH_MANIFEST_BYTES} bytes.`,
    'Default invocation parses, validates and displays the job plan. It does not acquire credentials, open state for mutation, decode dumps or send network requests.',
    'Execution requires --run. There is no hidden approval loop, cached plan token, continue-on-error or parallel worker.',
    BATCH_PREFLIGHT_NOTE,
    'Credentials stay on this invocation. The manifest and report never embed keys, tokens or request bodies.',
    'Stop before the next job on any non-success, cancellation, uncertain delivery, disappearance, incompatible input, wrong-origin destination, or observation-conflict exit 6.',
    'Completed jobs stay completed. Later jobs are not started, not labelled failed and not rolled back.',
    'Rerun the same manifest through ordinary per-source recovery. A batch report cannot resume a request.',
  ].join('\n');
}

export type BatchJobStatus = 'planned' | 'completed' | 'stopped' | 'not-started';

export type BatchJobSummary = Readonly<{
  index: number;
  name: string;
  sourceKind: string;
  sourceAlias: string;
  inputMode: string;
  dump: string;
  state: string;
  status: BatchJobStatus;
  code: number | null;
  outcome: string | null;
  sourceComplete: boolean | null;
  runComplete: boolean | null;
  runId: string | null;
  sourceRunId: string | null;
  invocation: string | null;
  recovery: string[] | null;
  diagnostic: string | null;
}>;

export type BatchDocument = Readonly<{
  version: typeof BATCH_DOCUMENT_VERSION;
  mode: 'preview' | 'run';
  preflight: 'local-shape-and-path';
  note: string;
  jobs: readonly BatchJobSummary[];
  stopping: { index: number; name: string; code: number; outcome: string | null } | null;
  notStarted: readonly { index: number; name: string }[];
}>;

export type BatchCliResult = ImportCliResult;
export type BatchCliOptions = ImportCliOptions;

type Credentials = Readonly<{
  api: string;
  accountKey: string;
  account: string;
  client: string;
  auth: string;
}>;

type ParsedBatchArgs = Readonly<{
  manifest: string;
  run: boolean;
  json: boolean;
  progressMode?: ImportProgressMode;
  credentials?: Credentials;
}>;

class UsageFailure extends BatchManifestError {
  constructor(message: string) {
    super(message);
    this.name = 'BatchUsageFailure';
  }
}

function boundedArguments(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length + 1 > MAX_ARGUMENTS_WITH_COMMAND)
    throw new UsageFailure('Batch arguments exceed the supported count.');
  let totalBytes = Buffer.byteLength('batch', 'utf8');
  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.length > MAX_ARGUMENT_BYTES || argument.includes('\0'))
      throw new UsageFailure('Batch arguments exceed the supported size.');
    totalBytes += Buffer.byteLength(argument, 'utf8');
    if (totalBytes > MAX_TOTAL_ARGUMENT_BYTES) throw new UsageFailure('Batch arguments exceed the supported size.');
  }
}

function parseOrigin(value: string, role: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageFailure(`${role} must be an HTTPS origin.`);
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.hostname)
    throw new UsageFailure(`${role} must be an HTTPS origin with no path, query, fragment or credentials.`);
  return url.origin;
}

function validateApiOrigin(api: string, testOrigin?: string): string {
  const url = new URL(parseOrigin(api, '--api'));
  if (testOrigin === undefined) {
    if (url.protocol !== 'https:') throw new UsageFailure('--api must be an HTTPS origin.');
    return url.origin;
  }
  const test = new URL(parseOrigin(testOrigin, 'test origin'));
  if (
    test.protocol !== 'http:' ||
    test.hostname !== '127.0.0.1' ||
    test.origin !== testOrigin ||
    url.origin !== test.origin
  )
    throw new UsageFailure('--api must match the exact loopback test origin.');
  return url.origin;
}

export function parseBatchArgs(argv: readonly string[], testOrigin?: string): ParsedBatchArgs | 'help' {
  boundedArguments(argv);
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) return 'help';
  const values = new Map<string, string>();
  const valueFlags = new Set(['--manifest', '--api', '--account-key', '--account', '--client', '--auth', '--progress']);
  let json = false;
  let run = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--help') return 'help';
    if (flag === '--json') {
      if (json) throw new UsageFailure('Batch flags cannot be repeated.');
      json = true;
      continue;
    }
    if (flag === '--run') {
      if (run) throw new UsageFailure('Batch flags cannot be repeated.');
      run = true;
      continue;
    }
    if (!valueFlags.has(flag) || values.has(flag))
      throw new UsageFailure('Unknown, import-only or repeated batch flag.');
    const value = argv[++index];
    if (value === undefined || value.length === 0 || value.startsWith('--'))
      throw new UsageFailure(`Batch flag ${flag} requires one value.`);
    values.set(flag, value);
  }
  const manifest = values.get('--manifest');
  if (!manifest || !manifest.trim() || manifest === '-')
    throw new UsageFailure('batch requires --manifest <path> to a local JSON file.');
  const progressMode = values.get('--progress');
  if (progressMode !== undefined && progressMode !== 'human' && progressMode !== 'jsonl')
    throw new UsageFailure('--progress must be human or jsonl.');
  const credentialFlags = ['--api', '--account-key', '--account', '--client', '--auth'] as const;
  const present = credentialFlags.filter((flag) => values.has(flag));
  if (run && present.length !== credentialFlags.length)
    throw new UsageFailure('batch --run requires --api --account-key --account --client --auth.');
  if (!run && present.length !== 0 && present.length !== credentialFlags.length)
    throw new UsageFailure(
      'Credential flags must be supplied together; preview still does not open the key or contact the network.',
    );
  let credentials: Credentials | undefined;
  if (present.length === credentialFlags.length) {
    const account = values.get('--account')!;
    const client = values.get('--client')!;
    const accountKey = values.get('--account-key')!;
    if (!UUID.test(account)) throw new UsageFailure('--account must be a UUID.');
    if (!CLIENT.test(client)) throw new UsageFailure('--client must be a registered client id.');
    if (!accountKey.trim() || accountKey === '-') throw new UsageFailure('--account-key must be a local key file.');
    const auth = parseOrigin(values.get('--auth')!, '--auth');
    if (new URL(auth).protocol !== 'https:') throw new UsageFailure('--auth must be an HTTPS origin.');
    credentials = {
      api: validateApiOrigin(values.get('--api')!, testOrigin),
      accountKey,
      account,
      client,
      auth,
    };
  }
  return {
    manifest,
    run,
    json,
    ...(progressMode ? { progressMode: progressMode as ImportProgressMode } : {}),
    ...(credentials ? { credentials } : {}),
  };
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

function plannedSummary(job: BatchJobPlan, status: BatchJobStatus = 'planned'): BatchJobSummary {
  return {
    index: job.index,
    name: job.name,
    sourceKind: job.sourceKind,
    sourceAlias: job.sourceAlias,
    inputMode: job.inputMode,
    dump: job.dump.path,
    state: job.state.path,
    status,
    code: null,
    outcome: status === 'not-started' ? 'not-started' : null,
    sourceComplete: null,
    runComplete: null,
    runId: null,
    sourceRunId: null,
    invocation: null,
    recovery: null,
    diagnostic: null,
  };
}

function recoveryFor(job: BatchJobPlan, code: number): string[] {
  if (code === 6) return observationRecoveryCommand(job);
  return ordinaryRecoveryCommand(job);
}

function outcomeForCode(code: number, sourceComplete: boolean | null): string {
  if (code === 0) return 'committed';
  if (code === 2) return 'invalid-input';
  if (code === 3) return 'mass-disappearance';
  if (code === 4) return 'denied';
  if (code === 5) return 'busy';
  if (code === 6) return 'observation-conflict';
  if (code === 130) return 'interrupted';
  if (sourceComplete === true) return 'uncertain';
  return 'failed';
}

function sanitizeDiagnostic(text: string): string {
  return terminalSafe(text.replace(/\s+/g, ' ').trim()).slice(0, 512);
}

function executedSummary(
  job: BatchJobPlan,
  result: ImportCliResult,
  progress: ImportProgressEvent | null,
): BatchJobSummary {
  const sourceComplete = progress?.sourceComplete ?? null;
  const code = result.code;
  const status: BatchJobStatus = code === 0 ? 'completed' : 'stopped';
  const diagnostic =
    code === 0
      ? sanitizeDiagnostic(result.stdout || 'Import complete.')
      : sanitizeDiagnostic(result.stderr || 'Import failed safely.');
  return {
    index: job.index,
    name: job.name,
    sourceKind: job.sourceKind,
    sourceAlias: job.sourceAlias,
    inputMode: job.inputMode,
    dump: job.dump.path,
    state: job.state.path,
    status,
    code,
    outcome: progress?.outcome ?? outcomeForCode(code, sourceComplete),
    sourceComplete,
    runComplete: code === 0,
    runId: progress?.run ?? null,
    sourceRunId: progress?.sourceRun ?? null,
    invocation: progress?.invocation ?? null,
    recovery: code === 0 ? null : recoveryFor(job, code),
    diagnostic,
  };
}

function documentFrom(
  plan: BatchManifestPlan,
  mode: 'preview' | 'run',
  summaries: readonly BatchJobSummary[],
): BatchDocument {
  const stopping = summaries.find((job) => job.status === 'stopped');
  const notStarted = summaries
    .filter((job) => job.status === 'not-started')
    .map((job) => ({ index: job.index, name: job.name }));
  return {
    version: BATCH_DOCUMENT_VERSION,
    mode,
    preflight: 'local-shape-and-path',
    note: plan.note,
    jobs: summaries,
    stopping: stopping
      ? { index: stopping.index, name: stopping.name, code: stopping.code ?? 1, outcome: stopping.outcome }
      : null,
    notStarted,
  };
}

function renderPreview(plan: BatchManifestPlan): string {
  const lines = [
    `Batch preview: ${plan.jobs.length} independent source job${plan.jobs.length === 1 ? '' : 's'}.`,
    plan.note,
    '',
  ];
  for (const job of plan.jobs) {
    lines.push(
      `${job.index}/${plan.jobs.length} ${terminalSafe(job.name)}  source ${job.sourceKind} alias ${terminalSafe(job.sourceAlias)}  ${job.inputMode}  dump ${terminalSafe(job.dump.path)}  state ${terminalSafe(job.state.path)}`,
    );
  }
  lines.push(
    '',
    'Execute with the same manifest and --run after supplying credentials. Preview does not cache a plan token.',
  );
  return `${lines.join('\n')}\n`;
}

function renderRun(document: BatchDocument): string {
  const total = document.jobs.length;
  const completed = document.jobs.filter((job) => job.status === 'completed').length;
  const lines: string[] = [];
  if (!document.stopping) {
    lines.push(`Batch complete: ${completed} of ${total} source jobs succeeded independently.`);
  } else {
    lines.push(
      `Batch stopped at job ${document.stopping.index}/${total} ${terminalSafe(document.stopping.name)} (code ${document.stopping.code}). ${completed} completed, ${document.notStarted.length} not started.`,
    );
    lines.push('Later jobs were not started, not labelled failed and not rolled back. Completed jobs stay completed.');
  }
  lines.push(document.note);
  lines.push('');
  for (const job of document.jobs) {
    const identity = job.runId ? ` run ${job.runId}` : '';
    const sourceRun = job.sourceRunId ? ` source-run ${job.sourceRunId}` : '';
    const complete =
      job.status === 'planned' || job.status === 'not-started'
        ? job.status
        : `source-complete=${job.sourceComplete === true ? 'yes' : job.sourceComplete === false ? 'no' : 'unknown'} run-complete=${job.runComplete ? 'yes' : 'no'}`;
    lines.push(
      `${job.index}/${total} ${terminalSafe(job.name)}  ${job.status}  source ${job.sourceKind} alias ${terminalSafe(job.sourceAlias)}  ${complete}${identity}${sourceRun}${job.code === null ? '' : `  code ${job.code}`}`,
    );
    if (job.diagnostic) lines.push(`  ${job.diagnostic}`);
    if (job.recovery) for (const line of job.recovery) lines.push(`  ${terminalSafe(line)}`);
  }
  return `${lines.join('\n')}\n`;
}

function parseProgressFrame(frame: string): ImportProgressEvent | null {
  const trimmed = frame.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const event = JSON.parse(trimmed) as ImportProgressEvent;
    if (event && event.version === 1 && typeof event.source === 'string') return event;
  } catch {
    return null;
  }
  return null;
}

function wrapProgressSink(
  sink: ImportProgressSink | undefined,
  job: BatchJobPlan,
  jobs: number,
  mode: ImportProgressMode | undefined,
  capture: { event: ImportProgressEvent | null },
): ImportProgressSink | undefined {
  if (!sink) return undefined;
  return {
    write(frame, signal) {
      const event = parseProgressFrame(frame);
      if (event) capture.event = event;
      const context = {
        index: job.index,
        jobs,
        name: job.name,
        sourceKind: job.sourceKind,
        sourceAlias: job.sourceAlias,
      };
      if (mode === 'jsonl' && event) {
        return sink.write(`${jsonSafe({ ...event, batch: context })}\n`, signal);
      }
      if (mode === 'human') {
        const prefix = `Batch job ${job.index}/${jobs} ${terminalSafe(job.name)}: `;
        return sink.write(frame.startsWith('\r') ? `\r${prefix}${frame.slice(1)}` : `${prefix}${frame}`, signal);
      }
      return sink.write(frame, signal);
    },
  };
}

function resultOf(code: number, stdout: string, stderr: string, openHandles = 0): BatchCliResult {
  return { code, stdout, stderr, openHandles };
}

function failure(error: unknown): BatchCliResult {
  const message =
    error instanceof BatchManifestError
      ? error.message
      : error instanceof Error && error.name === 'AbortError'
        ? 'Batch interrupted before a job started; durable per-source state is unchanged.'
        : 'Invalid batch arguments.';
  const code =
    error instanceof Error && error.name === 'AbortError' ? 130 : error instanceof BatchManifestError ? 2 : 2;
  return resultOf(code, '', `${terminalSafe(message)}\n`);
}

async function runSingleSource(argv: readonly string[], options: ImportCliOptions): Promise<ImportCliResult> {
  const module = await import('./cli.ts');
  return module.runImportCli(argv, options);
}

export async function runBatchCli(argv: readonly string[], options: BatchCliOptions = {}): Promise<BatchCliResult> {
  let parsed: ParsedBatchArgs | 'help';
  try {
    parsed = parseBatchArgs(argv, options.testOrigin);
  } catch (error) {
    return failure(error);
  }
  if (parsed === 'help') return resultOf(0, `${batchUsage()}\n`, '');

  let plan: BatchManifestPlan;
  try {
    plan = await preflightBatchManifest(parsed.manifest);
  } catch (error) {
    return failure(error);
  }

  if (!parsed.run) {
    const summaries = plan.jobs.map((job) => plannedSummary(job));
    const document = documentFrom(plan, 'preview', summaries);
    return resultOf(0, parsed.json ? `${jsonSafe(document)}\n` : renderPreview(plan), '');
  }

  if (!parsed.credentials) return failure(new UsageFailure('batch --run requires credentials on the invocation.'));

  const summaries: BatchJobSummary[] = [];
  let stopping: BatchJobSummary | undefined;
  let openHandles = 0;
  for (let offset = 0; offset < plan.jobs.length; offset++) {
    const job = plan.jobs[offset]!;
    if (options.signal?.aborted) {
      summaries.push(plannedSummary(job, 'not-started'));
      for (let rest = offset + 1; rest < plan.jobs.length; rest++)
        summaries.push(plannedSummary(plan.jobs[rest]!, 'not-started'));
      stopping = {
        ...plannedSummary(job, 'stopped'),
        code: 130,
        outcome: 'interrupted',
        diagnostic: 'Batch interrupted before a job started; no new coordinator was started.',
        recovery: ordinaryRecoveryCommand(job),
      };
      summaries[offset] = stopping;
      break;
    }
    try {
      await revalidateJobInputs(job, plan.directory);
    } catch (error) {
      stopping = {
        ...plannedSummary(job, 'stopped'),
        code: 2,
        outcome: 'invalid-input',
        diagnostic: sanitizeDiagnostic(error instanceof Error ? error.message : 'Job inputs changed.'),
        recovery: ordinaryRecoveryCommand(job),
      };
      summaries.push(stopping);
      for (let rest = offset + 1; rest < plan.jobs.length; rest++)
        summaries.push(plannedSummary(plan.jobs[rest]!, 'not-started'));
      break;
    }
    const capture: { event: ImportProgressEvent | null } = { event: null };
    const progressSink = wrapProgressSink(options.progressSink, job, plan.jobs.length, parsed.progressMode, capture);
    const result = await runSingleSource(ordinaryImportArgv(job, parsed.credentials, parsed.progressMode), {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.testOrigin ? { testOrigin: options.testOrigin } : {}),
      ...(options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {}),
      ...(options.observer ? { observer: options.observer } : {}),
      ...(options.createImporter ? { createImporter: options.createImporter } : {}),
      ...(progressSink ? { progressSink } : {}),
      ...(options.progressTty === undefined ? {} : { progressTty: options.progressTty }),
    });
    openHandles = result.openHandles;
    const summary = executedSummary(job, result, capture.event);
    summaries.push(summary);
    if (result.code !== 0) {
      stopping = summary;
      for (let rest = offset + 1; rest < plan.jobs.length; rest++)
        summaries.push(plannedSummary(plan.jobs[rest]!, 'not-started'));
      break;
    }
  }

  const document = documentFrom(plan, 'run', summaries);
  const stdout = parsed.json ? `${jsonSafe(document)}\n` : renderRun(document);
  return resultOf(stopping?.code ?? 0, stdout, '', openHandles);
}
