import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { choosePool } from './allowance.ts';
import { agentAdapter } from './agents.ts';
import { launchCommand, workerEnvironment } from './launch.ts';
import { measureLog } from './records.ts';
import { readRouting } from './routing.ts';
import { processIdentity, terminateProcessGroup } from './process.ts';
import type { AttemptRef } from './contracts.ts';
import type { WorkerTasks } from './tasks.ts';

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
  mkdirSync(join(tasks.settings.stateDirectory, 'runs', ref.taskId), { recursive: true });
  const fd = openSync(logPath, 'w');
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
  let child: ReturnType<typeof spawn>;
  try {
    child = store.write(ref, () => {
      store.updateAttempt(ref, (a) => {
        a.consulted = true;
      });
      const process = spawn(command, args, {
        cwd: directory,
        detached: true,
        stdio: ['ignore', fd, 'ignore'],
        env: workerEnvironment(pool),
      });
      const identity = process.pid ? processIdentity(process.pid) : null;
      if (identity)
        store.updateAttempt(ref, (a) => {
          a.auxiliaryProcesses.push(identity);
        });
      store.event(ref, 'consultation-started', {
        profile,
        pool: pool.name,
        before: readings.find((r) => r.pool === pool.name),
        process: process.pid ? processIdentity(process.pid) : null,
      });
      return process;
    });
  } finally {
    closeSync(fd);
  }
  const identity = child.pid ? processIdentity(child.pid) : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    await Promise.race([
      exited.then((code) => {
        if (code !== 0) throw new Error('consultation failed');
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('consultation timed out')), 120000);
      }),
    ]);
    store.assertCurrent(ref);
    const endedAt = new Date().toISOString();
    const measurement = measureLog(readFileSync(logPath, 'utf8'), { adapter: agentAdapter(profile.cli) });
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
    throw error;
  } finally {
    clearTimeout(timer);
    await terminateProcessGroup(identity, tasks.settings.terminationGraceMs);
  }
}
