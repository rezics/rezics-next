import { defaultPolicy } from './policy.ts';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Runtime } from './config.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import { REUSED_PID_REFUSAL, terminateProcessGroup } from './process.ts';
import { regenerateDerivedHead } from './promotion.ts';
import { completedUtcHour } from './efficiency-report-time.ts';
import { MAINTENANCE_BOOTSTRAP_PAGE_SIZE, MAINTENANCE_CANDIDATE_BATCH_SIZE } from './store.ts';
import { removeFinishedWorktree, type LifetimeRuntime } from './worktree-lifetime.ts';

export const MAINTENANCE_JOBS = ['reap', 'alarm', 'detect', 'regenerate'] as const;
export type MaintenanceJob = (typeof MAINTENANCE_JOBS)[number];
export type MaintenanceWorkUnit =
  | 'reap-worktree-existence'
  | 'process-group-termination'
  | 'maintenance-backfill-attempt-row'
  | 'process-directory-entry';

/** A timed-out subprocess and all its descendants belong to this maintenance run. */
export async function maintenanceCommand(argv: string[], cwd: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, detached: true, stdio: 'inherit' });
    const cancel = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reject(error);
      }
    };
    signal.addEventListener('abort', cancel, { once: true });
    child.once('error', reject);
    child.once('close', (code) => {
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) reject(signal.reason);
      else if (code !== 0) reject(new Error(`${argv.join(' ')}: exit ${code}`));
      else resolve();
    });
    if (signal.aborted) cancel();
  });
}

/** The periodic sweep excludes generators; explicit regeneration runs as a separate, bounded process. */
export async function runMaintenance(
  job: MaintenanceJob | 'all',
  runtime: Runtime,
  observe?: (unit: MaintenanceWorkUnit) => void,
  lifetimeRuntime?: LifetimeRuntime,
): Promise<number> {
  const policy = runtime.settings?.policy ?? defaultPolicy;
  const budget = job === 'regenerate' ? policy.maintenance.regenerationBudgetMs : policy.maintenance.budgetMs;
  const deadlineMs = Date.now() + budget;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Maintenance budget exhausted (${budget}ms)`)), budget);
  const signal = controller.signal;
  let lease;
  let failed = false;
  const step = async (name: string, action: () => Promise<unknown>) => {
    let cancel: () => void = () => {};
    try {
      signal.throwIfAborted();
      await Promise.race([
        new Promise<never>((_, reject) => {
          cancel = () => reject(signal.reason);
          signal.addEventListener('abort', cancel, { once: true });
        }),
        action(),
      ]);
    } catch (error) {
      failed = true;
      console.error(`maintenance ${name}:`, error);
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  };
  try {
    try {
      lease = acquireDirectoryLease(
        join(runtime.stateDirectory, job === 'regenerate' ? 'maintenance-regenerate.lease' : 'maintenance.lease'),
        runtime.settings?.policy?.leases,
      );
    } catch (error) {
      if (error instanceof LeaseHeldError) return 0;
      throw error;
    }
    for (const name of job === 'all' ? MAINTENANCE_JOBS.filter((name) => name !== 'regenerate') : [job]) {
      await step(name, async () => {
        switch (name) {
          case 'reap':
            // The process index is backfilled in fixed pages, then task writers keep its queue current.
            const processBackfill = runtime.store.bootstrapMaintenanceProcesses(MAINTENANCE_BOOTSTRAP_PAGE_SIZE);
            for (let index = 0; index < processBackfill.examined; index++)
              observe?.('maintenance-backfill-attempt-row');
            const candidates = runtime.store.reapMaintenanceCandidates(MAINTENANCE_CANDIDATE_BATCH_SIZE);
            const completed: typeof candidates = [];
            for (const candidate of candidates) {
              signal.throwIfAborted();
              try {
                observe?.('reap-worktree-existence');
                // The worktree is the custody boundary: retain the candidate until deletion makes reaping eligible.
                if (existsSync(candidate.worktree)) continue;
                observe?.('process-group-termination');
                await terminateProcessGroup(candidate.process, 1000, undefined, () =>
                  observe?.('process-directory-entry'),
                ).catch((error: unknown) => {
                  // A reused PID means the recorded worker is gone; there is nothing of this attempt left to reap.
                  if (error instanceof Error && error.message === REUSED_PID_REFUSAL) return;
                  throw error;
                });
                completed.push(candidate);
              } catch (error) {
                failed = true;
                console.error(`maintenance reap ${candidate.taskId}:${candidate.attempt}:`, error);
              }
            }
            runtime.store.completeMaintenanceCandidates(completed);
            await removeFinishedWorktree(runtime.settings, runtime.store, lifetimeRuntime, undefined, {
              deadlineMs,
              signal,
            });
            break;
          case 'detect':
            await runtime.deliverReminders?.();
            break;
          case 'alarm':
            await step('alarm flow', async () => runtime.evaluateFlow?.());
            if (runtime.hourlyEfficiencyReport?.enabled)
              await maintenanceCommand(
                [
                  process.execPath,
                  join(runtime.mainCheckout, 'tools/goal/scripts/efficiency-report.ts'),
                  '--send',
                  '--scheduled',
                  '--bucket',
                  completedUtcHour(Date.now()).start,
                ],
                runtime.mainCheckout,
                signal,
              );
            break;
          case 'regenerate':
            await maintenanceCommand([process.execPath, import.meta.filename], runtime.mainCheckout, signal);
            break;
        }
      });
    }
  } finally {
    clearTimeout(timer);
    lease?.release();
  }
  return failed ? 1 : 0;
}

/** Generators may block their event loop; the parent enforces their separate wall-clock budget. */
async function regenerate(): Promise<void> {
  const { loadSettings } = await import('./config.ts');
  const settings = loadSettings();
  const path = join(settings.stateDirectory, 'dev-derived.json');
  let previous = 0;
  try {
    previous = JSON.parse(readFileSync(path, 'utf8')).at;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (Date.now() - previous < (settings.policy ?? defaultPolicy).maintenance.derivedRefreshMs) return;
  const head = Bun.spawnSync(['git', 'rev-parse', settings.integrationBranch], {
    cwd: settings.mainCheckout,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (head.exitCode !== 0) throw new Error(head.stderr.toString());
  const result = await regenerateDerivedHead(
    { settings, ...(settings.derivedFiles ? { derivedFiles: settings.derivedFiles } : {}) },
    head.stdout.toString().trim(),
    settings.integrationBranch,
  );
  if (!result.retry) {
    writeFileSync(`${path}.tmp`, JSON.stringify({ at: Date.now() }), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
}

if (import.meta.main) {
  try {
    await regenerate();
  } catch (error) {
    console.error('maintenance regenerate:', error);
    process.exitCode = 1;
  }
}

/** systemd owns this process; each pass waits for verification to finish before the next starts. */
export async function runResidentVerifier(
  runtime: Pick<Runtime, 'verify'> & Partial<Pick<Runtime, 'settings'>>,
): Promise<number> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    while (!controller.signal.aborted) {
      await runtime.verify?.();
      if (controller.signal.aborted) break;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, (runtime.settings?.policy ?? defaultPolicy).verifier.residentPollMs);
        controller.signal.addEventListener('abort', finish, { once: true });
      });
    }
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
  return 0;
}
