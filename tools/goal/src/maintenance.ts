import { defaultPolicy } from './policy.ts';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Runtime } from './config.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import { terminateProcessGroup } from './process.ts';
import { regenerateDerivedHead } from './promotion.ts';
import { completedUtcHour } from './efficiency-report.ts';

export const MAINTENANCE_JOBS = ['reap', 'alarm', 'detect', 'regenerate'] as const;
export type MaintenanceJob = (typeof MAINTENANCE_JOBS)[number];

/** Each timer activation is bounded and runs all jobs even when one fails. */
export async function runMaintenance(job: MaintenanceJob | 'all', runtime: Runtime): Promise<number> {
  let lease;
  try {
    lease = acquireDirectoryLease(join(runtime.stateDirectory, 'maintenance.lease'), runtime.settings.policy?.leases);
  } catch (error) {
    if (error instanceof LeaseHeldError) return 0;
    throw error;
  }
  let failed = false;
  try {
    for (const name of job === 'all' ? MAINTENANCE_JOBS : [job]) {
      try {
        switch (name) {
          case 'reap':
            // Only recorded worker groups are ours to reap. Birth identity protects against PID reuse.
            for (const task of runtime.store.tasks()) {
              if (existsSync(task.worktree)) continue;
              for (const attempt of runtime.store.attempts(task.id))
                if (attempt.process) await terminateProcessGroup(attempt.process, 1000);
            }
            break;
          case 'detect':
            await runtime.deliverReminders?.();
            break;
          case 'alarm': {
            await runtime.evaluateFlow?.();
            if (runtime.hourlyEfficiencyReport?.enabled) {
              const child = Bun.spawn(
                [
                  process.execPath,
                  join(runtime.mainCheckout, 'tools/goal/scripts/efficiency-report.ts'),
                  '--send',
                  '--scheduled',
                  '--bucket',
                  completedUtcHour(Date.now()).start,
                ],
                { cwd: runtime.mainCheckout, stdout: 'inherit', stderr: 'inherit' },
              );
              if ((await child.exited) !== 0) throw new Error('Hourly report failed');
            }
            break;
          }
          case 'regenerate': {
            const path = join(runtime.stateDirectory, 'dev-derived.json');
            let previous = 0;
            try {
              previous = JSON.parse(readFileSync(path, 'utf8')).at;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            if (Date.now() - previous < (runtime.settings.policy ?? defaultPolicy).maintenance.derivedRefreshMs) break;
            const head = Bun.spawnSync(['git', 'rev-parse', runtime.settings.integrationBranch], {
              cwd: runtime.mainCheckout,
              stdout: 'pipe',
              stderr: 'pipe',
            });
            if (head.exitCode !== 0) throw new Error(head.stderr.toString());
            const result = await regenerateDerivedHead(
              {
                settings: runtime.settings,
                ...(runtime.settings.derivedFiles ? { derivedFiles: runtime.settings.derivedFiles } : {}),
              },
              head.stdout.toString().trim(),
              runtime.settings.integrationBranch,
            );
            // A concurrent landing advances dev; retry from that new head on the next timer activation.
            if (!result.retry) {
              writeFileSync(`${path}.tmp`, JSON.stringify({ at: Date.now() }), { mode: 0o600 });
              renameSync(`${path}.tmp`, path);
            }
            break;
          }
        }
      } catch (error) {
        failed = true;
        console.error(`maintenance ${name}:`, error);
      }
    }
  } finally {
    lease.release();
  }
  return failed ? 1 : 0;
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
