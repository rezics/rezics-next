import { defaultPolicy } from './policy.ts';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const CHECK_LOG_PATH_PREFIX = '.temp/goal/checks/worker-check-';
const CHECK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WorkerCheckObservationTask = {
  worktree: string;
};

export type WorkerCheckObservationPolicy = {
  checkCommandCharacters: number;
  checkStatusCharacters: number;
  checkLogBytes: number;
  checkSummaryCharacters: number;
  summaryCharacters: number;
};

export type WorkerCheckObservation =
  | { status: 'pending' }
  | { status: 'terminal'; resumeText: string };

function singleLine(value: unknown, limit: number): string {
  return String(value)
    .replace(/[\r\n\0]+/g, ' ')
    .slice(0, limit);
}

function checkCommand(value: Record<string, unknown>, policy: WorkerCheckObservationPolicy): string {
  const argv = value.argv;
  if (Array.isArray(argv) && argv.every((part) => typeof part === 'string'))
    return JSON.stringify(argv).slice(0, policy.checkCommandCharacters);
  if (typeof value.command === 'string') return singleLine(value.command, policy.checkCommandCharacters);
  return 'unknown (terminal record did not include argv)';
}

function ownedTerminalLogPath(
  task: WorkerCheckObservationTask,
  id: string,
  value: Record<string, unknown>,
  policy: WorkerCheckObservationPolicy,
): { path: string; original: string } | { path: null; original: string; reason: string } {
  const raw = value.log ?? value.logPath ?? value.log_path;
  const original =
    typeof raw === 'string'
      ? singleLine(raw, policy.summaryCharacters)
      : 'unknown (terminal record did not include a log path)';
  const unknown = (reason: string) => ({ path: null, original, reason });
  if (!CHECK_UUID.test(id)) return unknown('check id is not a bare UUID');
  if (value.id !== id) return unknown('terminal record identity does not match the owned check UUID');
  if (typeof value.cwd !== 'string' || !isAbsolute(value.cwd) || resolve(value.cwd) !== resolve(task.worktree))
    return unknown('terminal record cwd does not match this task worktree');
  if (
    String(value.status ?? '').toLowerCase() !== 'finished' ||
    typeof value.runnerPid !== 'number' ||
    !Number.isSafeInteger(value.runnerPid) ||
    Number(value.runnerPid) <= 0 ||
    typeof value.runnerHost !== 'string' ||
    !value.runnerHost.length ||
    !Array.isArray(value.argv) ||
    !value.argv.every((part) => typeof part === 'string')
  )
    return unknown('terminal record is incomplete or is not in the finished state');
  if (typeof raw !== 'string' || !raw.length) return unknown('terminal record did not include an original log path');

  const normalized = raw.replaceAll('\\', '/');
  if (
    isAbsolute(raw) ||
    normalized.split('/').some((part) => part === '..' || part === '.') ||
    normalized !== `${CHECK_LOG_PATH_PREFIX}${id}.log`
  )
    return unknown('log path is outside this UUID-owned check log prefix');
  const path = resolve(task.worktree, raw);
  const checksDirectory = resolve(task.worktree, '.temp/goal/checks');
  const relativePath = relative(resolve(task.worktree), path).replaceAll('\\', '/');
  if (dirname(path) !== checksDirectory || relativePath !== normalized || basename(path) !== `worker-check-${id}.log`)
    return unknown('log path is nested or does not match this check UUID');

  try {
    const components = [
      task.worktree,
      join(task.worktree, '.temp'),
      join(task.worktree, '.temp/goal'),
      checksDirectory,
      path,
    ];
    for (const [index, component] of components.entries()) {
      const stat = lstatSync(component);
      if (stat.isSymbolicLink()) return unknown('log path crosses a symbolic link');
      if (index < components.length - 1 ? !stat.isDirectory() : !stat.isFile())
        return unknown('log path is not a regular file under this worktree');
    }
  } catch {
    return unknown('owned terminal log is missing or unreadable');
  }
  return { path, original };
}

function terminalCheckFailureEvidence(
  task: WorkerCheckObservationTask,
  id: string,
  value: Record<string, unknown>,
  status: unknown,
  policy: WorkerCheckObservationPolicy,
): string {
  const command = checkCommand(value, policy);
  const exitValue =
    value.exitStatus ?? value.exit_status ?? value.exitCode ?? value.exit_code ?? value.exit ?? value.code;
  const exitCode = Number(exitValue);
  const log = ownedTerminalLogPath(task, id, value, policy);
  const header = `check ${id} failure evidence: command ${command}; exit status ${singleLine(status, policy.checkStatusCharacters)}; evidence path ${log.original}`;
  if (!Number.isSafeInteger(exitCode) || exitCode === 0 || exitCode !== Number(status))
    return `${header}; excerpt unknown (terminal record exit status is missing or inconsistent).`;
  if (log.path === null) return `${header}; excerpt unknown (${log.reason}); original path ${log.original}.`;

  let descriptor: number | undefined;
  try {
    descriptor = openSync(log.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile()) return `${header}; excerpt unknown (owned log is not a regular file).`;
    const truncated = before.size > policy.checkLogBytes;
    const length = Math.min(before.size, policy.checkLogBytes);
    const offset = truncated ? before.size - length : 0;
    const bytes = Buffer.alloc(length);
    const count = readSync(descriptor, bytes, 0, length, offset);
    const after = fstatSync(descriptor);
    if (count !== length || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      return `${header}; excerpt unknown (owned log changed during the bounded read).`;
    const excerpt = bytes
      .subarray(0, count)
      .toString('utf8')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/g, '?')
      .trim();
    if (!excerpt) return `${header}; excerpt unknown (owned terminal log is empty).`;
    const state = truncated
      ? `truncated; the complete failure detail is unknown (showing only the final ${policy.checkLogBytes} bytes)`
      : `complete (${length} bytes)`;
    return [
      `${header}; excerpt status ${state}.`,
      `BEGIN OWNED CHECK LOG EXCERPT ${id}`,
      excerpt,
      `END OWNED CHECK LOG EXCERPT ${id}`,
    ].join('\n');
  } catch {
    return `${header}; excerpt unknown (owned terminal log is unreadable); original path ${log.original}.`;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Interpret ordinary worker-check result/run files. Importing this module does no filesystem or process work. */
export function observeWorkerChecks(
  task: WorkerCheckObservationTask,
  checks: readonly string[],
  policy: WorkerCheckObservationPolicy = defaultPolicy.worker,
): WorkerCheckObservation {
  if (!checks.length)
    return {
      status: 'terminal',
      resumeText: 'The waiting attempt has no saved check ids; resume and report this recovery issue.',
    };
  const directory = join(task.worktree, '.temp/goal/checks');
  const details: string[] = [];
  let settledChecks = 0;
  for (const id of checks) {
    const resultPath = join(directory, 'results', `${id}.json`);
    if (!existsSync(resultPath)) {
      const runPaths = [join(directory, 'runs', `${id}.json`), join(directory, `${id}.json`)];
      const runPath = runPaths.find(existsSync);
      if (runPath) {
        try {
          const run = JSON.parse(readFileSync(runPath, 'utf8')) as Record<string, unknown>;
          const state = String(run.state ?? run.status ?? '').toLowerCase();
          if (!state || ['queued', 'starting', 'running', 'in_progress'].includes(state)) return { status: 'pending' };
          details.push(
            `check ${id}: check host stopped in state ${state}; exit status unavailable; log path ${String(run.logPath ?? run.log_path ?? 'unavailable')}`,
          );
          settledChecks += 1;
          continue;
        } catch {
          details.push(
            `check ${id}: check host left an unreadable run record; exit status unavailable; log path ${runPath}`,
          );
          settledChecks += 1;
          continue;
        }
      }
      details.push(
        `check ${id}: run vanished or check host failed before writing a result; exit status unavailable; log path unavailable`,
      );
      settledChecks += 1;
      continue;
    }
    try {
      const document = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
      const value =
        document.result && typeof document.result === 'object'
          ? (document.result as Record<string, unknown>)
          : document;
      // worker-check writes its result record when the check starts ({status: running, runnerPid}); only an exit
      // status or a dead runner ends it. Treating the start record as a result woke every attempt at once.
      const exit = value.exitStatus ?? value.exit_status ?? value.exitCode ?? value.exit_code ?? value.exit;
      const pending = ['queued', 'starting', 'running', 'in_progress'].includes(
        String(value.status ?? '').toLowerCase(),
      );
      if (exit === undefined && pending) {
        const runner = Number(value.runnerPid ?? value.runner_pid);
        const local = !value.runnerHost || value.runnerHost === hostname();
        if (!Number.isSafeInteger(runner) || runner <= 0 || !local || processAlive(runner)) return { status: 'pending' };
        details.push(
          `check ${id}: run vanished (runner ${runner} exited without a result); exit status unavailable; log path ${String(value.log ?? value.logPath ?? 'unavailable')}`,
        );
        settledChecks += 1;
        continue;
      }
      const status =
        value.exitStatus ??
        value.exit_status ??
        value.exitCode ??
        value.exit_code ??
        value.exit ??
        value.code ??
        value.status ??
        'unknown';
      const numericStatus = Number(status);
      const summary =
        value.failureSummary ??
        value.failure_summary ??
        value.failure ??
        value.summary ??
        value.errorLine ??
        value.error ??
        (Number.isFinite(numericStatus)
          ? numericStatus === 0
            ? 'passed'
            : 'check failed without a summary'
          : 'summary unavailable');
      const log = value.logPath ?? value.log_path ?? value.log ?? 'unknown (result record did not name a log path)';
      details.push(
        `check ${id}: exit status ${String(status)}; ${String(summary)
          .replace(/[\r\n]+/g, ' ')
          .slice(0, policy.checkSummaryCharacters)}; log path ${String(log)
          .replace(/[\r\n]+/g, ' ')
          .slice(0, policy.summaryCharacters)}`,
      );
      if (Number.isFinite(numericStatus) && numericStatus !== 0)
        details.push(terminalCheckFailureEvidence(task, id, value, status, policy));
      settledChecks += 1;
    } catch (error) {
      details.push(
        `check ${id}: check host failed to write a readable result (${String(error)}); log path ${resultPath}`,
      );
      settledChecks += 1;
    }
  }
  return details.some((line) => line.startsWith('check ') && line.includes('run vanished'))
    ? {
        status: 'terminal',
        resumeText: `The checks completed or failed to run. Resume this same session with their results:\n${details.join('\n')}`,
      }
    : settledChecks === checks.length
      ? {
          status: 'terminal',
          resumeText: `All checks have finished. Resume this same session with their results:\n${details.join('\n')}`,
        }
      : { status: 'pending' };
}
