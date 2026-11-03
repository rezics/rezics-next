import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { choosePool } from './allowance.ts';
import { agentAdapter } from './agents.ts';
import { launchCommand, workerEnvironment } from './launch.ts';
import { measureLog } from './records.ts';
import { readRouting } from './routing.ts';
import { processIdentity, terminateProcessGroup, type ProcessIdentity } from './process.ts';
import type { AttemptRef } from './contracts.ts';
import type { WorkerTasks } from './tasks.ts';

export const CONSULTATION_LIMIT_MS = 120_000;

function boundedCause(text: string): string {
  return text.split(/\r?\n/, 1)[0]!.trim().slice(0, 1000);
}

function stderrCause(path: string): string {
  try {
    return boundedCause(readFileSync(path, 'utf8'));
  } catch {
    return '';
  }
}

function closeFd(fd: number | undefined): void {
  if (fd === undefined) return;
  closeSync(fd);
}

function failedConsultation(code: number | null, signal: NodeJS.Signals | null, cause: string): Error {
  const status = signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`;
  return new Error(cause ? `consultation failed (${status}): ${cause}` : `consultation failed (${status})`);
}

function asConsultationFailure(error: unknown, cause: string): Error {
  if (error instanceof Error) {
    if (error.message === 'consultation timed out')
      return cause ? new Error(`consultation timed out: ${cause}`) : error;
    if (
      error.message.startsWith('consultation failed') ||
      error.message.startsWith('consultation produced') ||
      error.message.startsWith('consultation timed out')
    )
      return error;
    return new Error(
      cause ? `consultation failed: ${error.message}: ${cause}` : `consultation failed: ${error.message}`,
    );
  }
  return new Error(cause ? `consultation failed: ${String(error)}: ${cause}` : `consultation failed: ${String(error)}`);
}

/** The prompt is assembled from only the four evidence artifacts. No transcript or project access is requested. */
export async function consult(tasks: WorkerTasks, ref: AttemptRef, directory: string): Promise<string> {
  const store = tasks.store;
  store.assertCurrent(ref);
  const attempt = store.attempt(ref);
  if (attempt.consulted) throw new Error('this task already used its one consultation');
  const profile = readRouting(tasks.settings.routingFile).consultation;
  const readings = tasks.settings.pools.map((p) => tasks.reader(p));
  const pool = choosePool(profile, tasks.settings.pools, readings);
  const contract = readFileSync(join(directory, 'contract.md'), 'utf8');
  const prompt = [
    'Use only this evidence. Do not read the project, run tools, wait, or edit files. Give one answer: the root cause, the smallest correction, and whether the acceptance is inconsistent.',
    ...['contract.md', 'diff.patch', 'failure.json', 'approaches.json'].map(
      (name) => `${name}:\n${name === 'contract.md' ? contract : readFileSync(join(directory, name), 'utf8')}`,
    ),
  ].join('\n\n');
  const logPath = join(tasks.settings.stateDirectory, 'runs', ref.taskId, `${ref.attempt}.consultation.jsonl`);
  const errPath = `${logPath}.err`;
  mkdirSync(join(tasks.settings.stateDirectory, 'runs', ref.taskId), { recursive: true });
  const outFd = openSync(logPath, 'w');
  let errFd: number | undefined;
  let child: ChildProcess | undefined;
  let identity: ProcessIdentity | null = null;
  const [command, args] = launchCommand({
    profile,
    pool,
    worktree: directory,
    prompt,
    logPath,
    readOnly: true,
    consultation: true,
    codex: tasks.settings.codex,
  });
  const startedAt = new Date().toISOString();
  try {
    const stderrFd = openSync(errPath, 'w');
    errFd = stderrFd;
    child = store.write(ref, () => {
      store.updateAttempt(ref, (a) => {
        a.consulted = true;
      });
      const process = spawn(command, args, {
        cwd: directory,
        detached: true,
        stdio: ['ignore', outFd, stderrFd],
        env: workerEnvironment(pool),
      });
      const spawned = process.pid ? processIdentity(process.pid) : null;
      if (spawned)
        store.updateAttempt(ref, (a) => {
          a.auxiliaryProcesses.push(spawned);
        });
      store.event(ref, 'consultation-started', {
        profile,
        pool: pool.name,
        before: readings.find((r) => r.pool === pool.name),
        process: spawned,
      });
      return process;
    });
    identity = child.pid ? processIdentity(child.pid) : null;
  } finally {
    closeFd(outFd);
    closeFd(errFd);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!child) throw new Error('consultation failed to start');
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const outcome = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('consultation timed out')), CONSULTATION_LIMIT_MS);
      }),
    ]);
    store.assertCurrent(ref);
    if (outcome.signal || outcome.code !== 0)
      throw failedConsultation(outcome.code, outcome.signal, stderrCause(errPath));
    const endedAt = new Date().toISOString();
    const measurement = measureLog(readFileSync(logPath, 'utf8'), { adapter: agentAdapter(profile.cli) });
    if (!measurement.result.trim()) throw new Error('consultation produced no usable advice');
    writeFileSync(join(directory, 'consultation.md'), measurement.result);
    store.event(ref, 'consultation-completed', {
      profile,
      pool: pool.name,
      startedAt,
      endedAt,
      tokens: measurement.tokens,
      after: tasks.reader(pool),
    });
    return measurement.result;
  } catch (error) {
    store.assertCurrent(ref);
    throw asConsultationFailure(error, stderrCause(errPath));
  } finally {
    clearTimeout(timer);
    await terminateProcessGroup(identity, tasks.settings.terminationGraceMs);
  }
}
