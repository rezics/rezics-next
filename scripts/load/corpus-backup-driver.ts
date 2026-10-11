import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { restoreCatalogueBackup, retainStoppedOwnerBackup,
  type CorpusPreparationTiming } from './catalogue-backup.ts';
import type { CorpusBackupDriver } from './work-profile-corpus.ts';
import { dockerEnvironment, root, stream } from '../fixture/stack.ts';
import type { QaResourceClass } from '../qa/resource-classes.ts';

export interface CorpusRestoreSmokeInput {
  target: string;
  runId: string;
  apps: Record<string, string>;
  signal: AbortSignal;
}

export interface CorpusBackupDriverOptions {
  /** Persistent QA project whose owner stores receive the public commands. */
  sourceRunId: string;
  /** Private location under this checkout's .temp for stopped copies. */
  directory: string;
  /** Drain or close public API writers; return a resume callback when the build continues. */
  quiesce(signal: AbortSignal): Promise<void | (() => Promise<void>)>;
  /** Read the restored corpus through the public API after startup and migrations. */
  smokeRead(input: CorpusRestoreSmokeInput): Promise<void | (() => Promise<void>)>;
  /** Leave source storage stopped while restored copies run, when requested. */
  resumeSource?: boolean;
  onSourceStartup?: (elapsedMs: number) => void;
  restoreResourceClass?: QaResourceClass;
}

interface RestoredCopy {
  backup: Awaited<ReturnType<typeof restoreCatalogueBackup>>;
  preparation: CorpusPreparationTiming;
  stopSmokeRead?: () => Promise<void>;
}

export interface ManagedCorpusBackupDriver extends CorpusBackupDriver {
  /** Measured wall time through migrations and API smoke readiness. */
  preparation(target: string): CorpusPreparationTiming | undefined;
  /** Stop the in-process smoke reader and remove this restored QA project. */
  stop(target: string): Promise<void>;
}

function restoreRunId(target: string): string {
  if (!/^[a-z][a-z0-9-]{1,60}$/.test(target)) throw new Error('Invalid corpus restore target');
  return `profile-${createHash('sha256').update(target).digest('hex').slice(0, 20)}`;
}

async function migrateRestoredCopy(runId: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const appsFile = join(root, '.temp/stack', `rezics-qa-${runId}`, 'apps.env');
  await stream(
    'bun',
    ['scripts/load/work-profile-restore-migrations.ts', relative(root, appsFile)],
    dockerEnvironment(),
    undefined,
    300_000,
    signal,
  );
  signal.throwIfAborted();
}

/** A real public-corpus driver backed by the stopped owner-copy lifecycle. */
export function createCorpusBackupDriver(options: CorpusBackupDriverOptions): ManagedCorpusBackupDriver {
  const directory = resolve(options.directory);
  const restored = new Map<string, RestoredCopy>();

  return {
    async backup(id, signal) {
      if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(id)) throw new Error('Invalid work profile corpus id');
      const backupDirectory = join(directory, id);
      const resumeWriter = await options.quiesce(signal);
      let failed = false;
      try {
        signal.throwIfAborted();
        return await retainStoppedOwnerBackup(options.sourceRunId, id, backupDirectory, Date.now(), {
          purpose: 'work-profile',
          resumeSource: options.resumeSource,
          signal,
          onSourceStartup: options.onSourceStartup,
        });
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        if ((options.resumeSource !== false || failed) && resumeWriter) await resumeWriter();
      }
    },

    async restore(backupPath, target, signal) {
      if (restored.has(target)) throw new Error('Corpus restore target is already open');
      signal.throwIfAborted();
      const runId = restoreRunId(target);
      const startedAt = performance.now();
      const backup = await restoreCatalogueBackup(backupPath, runId, { signal, resourceClass: options.restoreResourceClass });
      let stopSmokeRead: (() => Promise<void>) | undefined;
      try {
        signal.throwIfAborted();
        await migrateRestoredCopy(runId, signal);
        stopSmokeRead = (await options.smokeRead({ target, runId, apps: backup.apps, signal })) ?? undefined;
        signal.throwIfAborted();
        const totalMs = performance.now() - startedAt;
        const preparation = { ...backup.preparation,
          readinessMs: totalMs - backup.preparation.restoreMs - backup.preparation.startupMs,
          totalMs };
        restored.set(target, { backup, stopSmokeRead, preparation });
      } catch (error) {
        const cleanup: unknown[] = [];
        try {
          await stopSmokeRead?.();
        } catch (stopError) {
          cleanup.push(stopError);
        }
        try {
          await backup.stop();
        } catch (stopError) {
          cleanup.push(stopError);
        }
        if (cleanup.length)
          throw new AggregateError([error, ...cleanup], 'Corpus restore failed and cleanup was incomplete', {
            cause: error,
          });
        throw error;
      }
    },

    preparation(target) {
      const timing = restored.get(target)?.preparation;
      return timing ? { ...timing } : undefined;
    },

    async stop(target) {
      const copy = restored.get(target);
      if (!copy) return;
      restored.delete(target);
      const errors: unknown[] = [];
      try {
        await copy.stopSmokeRead?.();
      } catch (error) {
        errors.push(error);
      }
      try {
        await copy.backup.stop();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, 'Corpus restore cleanup failed');
    },
  };
}
