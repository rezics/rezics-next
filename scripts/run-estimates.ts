/**
 * Root `bun test` slot estimates shared by every worktree.
 *
 * Cost: one read of a file of at most 2000 entries before a run, and one rewrite after it.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MAX_RUN_ESTIMATES = 2000;
export const RUN_ESTIMATES_FILE = 'root-bun-tests.json';

const requiredValueOptions = new Set([
  '--timeout',
  '--rerun-each',
  '--retry',
  '--seed',
  '--coverage-reporter',
  '--coverage-dir',
  '-t',
  '--test-name-pattern',
  '--reporter',
  '--reporter-outfile',
  '--max-concurrency',
  '--path-ignore-patterns',
  '--shard',
  '--timings',
]);

type InvocationParts = { files: string[]; flags: string[] };

export type RunEstimate = {
  invocation: string;
  heldMs: number;
  recordedAt: string;
};

type RunEstimateRecord = { invocations: RunEstimate[] };

function splitArguments(args: string[]): InvocationParts {
  const files: string[] = [];
  const flags: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === '--') {
      flags.push(argument);
      files.push(...args.slice(index + 1));
      break;
    }
    if (!argument.startsWith('-')) {
      files.push(argument);
      continue;
    }
    flags.push(argument);
    if (argument.includes('=')) continue;
    if (requiredValueOptions.has(argument)) {
      if (args[index + 1] !== undefined) flags.push(args[++index]!);
      continue;
    }
    if (argument === '--changed' && args[index + 1] && !args[index + 1]!.startsWith('-')) {
      flags.push(args[++index]!);
      continue;
    }
    if ((argument === '--bail' || argument === '--parallel') && /^\d+$/.test(args[index + 1] ?? '')) {
      flags.push(args[++index]!);
    }
  }
  return { files, flags };
}

function isInside(root: string, path: string): boolean {
  const inside = relative(root, path);
  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
}

function portable(path: string): string {
  return path.split(sep).join('/');
}

function normalizeFileFilter(root: string, cwd: string, filter: string): string {
  const absolute = isAbsolute(filter) ? resolve(filter) : resolve(cwd, filter);
  return isInside(root, absolute) ? portable(relative(root, absolute)) : filter;
}

/** A stable key for a checkout-relative cwd, sorted file filters, and ordered remaining flags. */
export function invocationKey(checkoutRoot: string, cwd: string, args: string[]): string | null {
  try {
    const root = resolve(checkoutRoot);
    const workingDirectory = isAbsolute(cwd) ? resolve(cwd) : resolve(root, cwd);
    if (!isInside(root, workingDirectory)) return null;
    const cwdFromRoot = portable(relative(root, workingDirectory)) || '.';
    const { files, flags } = splitArguments(args);
    const normalizedFiles = files.map((file) => normalizeFileFilter(root, workingDirectory, file)).sort();
    return JSON.stringify({ cwd: cwdFromRoot, files: normalizedFiles, flags });
  } catch {
    return null;
  }
}

/** The main checkout's shared estimates directory, or null when this process has no Git checkout metadata. */
export function runEstimatesDirectory(checkoutRoot: string, testDirectory?: string): string | null {
  try {
    const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: checkoutRoot,
      encoding: 'utf8',
    });
    if (result.status !== 0 || !result.stdout.trim()) return null;
    if (testDirectory) return resolve(testDirectory);
    return resolve(dirname(result.stdout.trim()), '.temp/check-estimates');
  } catch {
    return null;
  }
}

function recordPath(directory: string): string {
  return join(directory, RUN_ESTIMATES_FILE);
}

function isRunEstimate(value: unknown): value is RunEstimate {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<RunEstimate>;
  return (
    typeof entry.invocation === 'string' &&
    Number.isSafeInteger(entry.heldMs) &&
    entry.heldMs! >= 0 &&
    typeof entry.recordedAt === 'string' &&
    Number.isFinite(Date.parse(entry.recordedAt))
  );
}

function readRecord(directory: string): RunEstimateRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(recordPath(directory), 'utf8')) as { invocations?: unknown };
    if (!parsed || !Array.isArray(parsed.invocations) || !parsed.invocations.every(isRunEstimate)) return null;
    return { invocations: parsed.invocations };
  } catch {
    return null;
  }
}

/** Returns no estimate when the record is absent, unreadable, malformed, or replaced during a read. */
export function readEstimate(directory: string, invocation: string): number | undefined {
  const record = readRecord(directory);
  return record?.invocations.find((entry) => entry.invocation === invocation)?.heldMs;
}

/** Reads one validated snapshot so a run needs no second read when it records its result. */
export function readRunEstimates(directory: string): RunEstimate[] {
  return readRecord(directory)?.invocations ?? [];
}

/** Records one held duration atomically. A failed write never affects the test run. */
export function recordEstimate(
  directory: string,
  invocation: string,
  heldMs: number,
  recordedAt = new Date(),
  previous?: readonly RunEstimate[],
): void {
  if (!Number.isSafeInteger(heldMs) || heldMs < 0) return;
  try {
    const existing = previous === undefined ? (readRecord(directory)?.invocations ?? []) : [...previous];
    const next: RunEstimate[] = [
      { invocation, heldMs, recordedAt: recordedAt.toISOString() },
      ...existing.filter((entry) => entry.invocation !== invocation),
    ];
    next.sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt));
    const retained = next.slice(0, MAX_RUN_ESTIMATES);
    mkdirSync(directory, { recursive: true });
    const path = recordPath(directory);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ invocations: retained } satisfies RunEstimateRecord)}\n`, {
        flag: 'wx',
      });
      renameSync(temporary, path);
    } catch {
      rmSync(temporary, { force: true });
    }
  } catch {
    // Check-slot timing is advisory and cannot fail the test invocation.
  }
}

/** Whether the supplied filters include the root checkout's specs directory. */
export function includesSpecs(args: string[]): boolean {
  const { files } = splitArguments(args);
  if (files.length === 0) return true;
  return files.some((filter) => /(?:^|[/\\])specs(?:[/\\]|$)/.test(filter));
}
