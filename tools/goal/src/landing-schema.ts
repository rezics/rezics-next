import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { matchesPath } from './briefs.ts';
import { ensureDerivedDependencies } from './candidate.ts';
import { runBun } from './landing-transpile.ts';
import { policyGit } from './merge.ts';
import { defaultPolicy, type ControlPolicy } from './policy.ts';

/** Kernel migrations; the whole-segment `**` also matches the top-level migrations directory. */
export const SCHEMA_MIGRATION_PATHS = ['services/kernel/db/**/migrations/*.sql'];
/** Dumps derived from the migrations; a changed dump is committed onto the candidate as its own commit. */
export const SCHEMA_DUMP_PATHS = ['services/kernel/db/**/schema.sql'];
const SCHEMA_DUMP_ARGS = ['run', '--cwd', 'services/kernel', 'derived', 'schema'];

export type LandingSchemaResult = {
  outcome: 'skipped' | 'unchanged' | 'committed' | 'diagnostic';
  /** HEAD after regeneration: the input candidate unless a dump commit was added. */
  candidate: string;
  /** Null when no regeneration ran. */
  elapsedMs: number | null;
  logPath: string;
  /** The first error line of a failed regeneration, reported like a compiler diagnostic. */
  message: string | null;
};

function firstError(output: string, status: number | null, error: Error | undefined): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.find((line) => /\berror\b/i.test(line)) ??
    lines[0] ??
    error?.message ??
    `bun exited ${status ?? 'without a status'}`
  );
}

/** Tracked files that differ from the index, plus untracked files that are not ignored. */
function workingFiles(cwd: string, policy: ControlPolicy['merge']): string[] {
  const output = policyGit(cwd, ['ls-files', '--modified', '--others', '--exclude-standard', '-z'], policy);
  return [...new Set(output.split('\0').filter(Boolean))];
}

/**
 * Regenerates the Kernel schema dumps for a dev candidate that changed a migration and commits each changed dump onto the
 * candidate, as its own commit, before the candidate is published. A failed regeneration returns its first error for the
 * source owner's session; it does not fail the attempt.
 */
export async function regenerateLandingSchema(input: {
  cwd: string;
  changedFiles: readonly string[];
  taskId: string;
  logPath: string;
  policy?: ControlPolicy['merge'];
}): Promise<LandingSchemaResult> {
  const { cwd, logPath } = input;
  const policy = input.policy ?? defaultPolicy.merge;
  const head = () => policyGit(cwd, ['rev-parse', 'HEAD'], policy);
  if (!input.changedFiles.some((path) => matchesPath(path, SCHEMA_MIGRATION_PATHS)))
    return { outcome: 'skipped', candidate: head(), elapsedMs: null, logPath, message: null };

  ensureDerivedDependencies(cwd, logPath, [['bun', ...SCHEMA_DUMP_ARGS]]);
  appendFileSync(logPath, `$ bun ${SCHEMA_DUMP_ARGS.join(' ')} (cwd: ${cwd})\n`);
  const started = performance.now();
  const run = await runBun(cwd, SCHEMA_DUMP_ARGS);
  const elapsedMs = Math.round(performance.now() - started);
  appendFileSync(logPath, `${run.output}${run.output.endsWith('\n') || !run.output ? '' : '\n'}`);
  if (run.error || run.status !== 0) {
    const message = firstError(run.output, run.status, run.error);
    appendFileSync(logPath, `Schema dump regeneration failed in ${elapsedMs}ms: ${message}\n`);
    return { outcome: 'diagnostic', candidate: head(), elapsedMs, logPath, message };
  }

  const changed = workingFiles(cwd, policy);
  const dumps = changed.filter((path) => matchesPath(path, SCHEMA_DUMP_PATHS));
  const outside = changed.filter((path) => !dumps.includes(path));
  if (outside.length) throw new Error(`Schema regeneration changed non-dump files: ${outside.join(', ')}`);
  if (!dumps.length) {
    appendFileSync(logPath, `Schema dumps already match the migrations; regenerated in ${elapsedMs}ms, no commit\n`);
    return { outcome: 'unchanged', candidate: head(), elapsedMs, logPath, message: null };
  }

  const before = head();
  policyGit(cwd, ['add', '--', ...dumps], policy);
  policyGit(cwd, ['commit', '-m', `chore(kernel): regenerate schema dumps for ${input.taskId}`], policy);
  appendFileSync(logPath, `Regenerated ${dumps.join(', ')} in ${elapsedMs}ms; committed onto ${before}\n`);
  return { outcome: 'committed', candidate: head(), elapsedMs, logPath, message: null };
}
