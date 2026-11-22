import {
  isActiveMinecraftPreparation,
  type MinecraftJavaPolicy,
  type MinecraftPreparation,
  type MinecraftPreparationMode,
  type MinecraftPreparationPhase,
  type MinecraftPreparationProgress,
  type MinecraftSelection,
  type MinecraftUpgradeMode,
  type MinecraftWorldVersionRisk,
} from '@rezics/launcher-contract';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Locks, readJson, writeJson } from '../storage.ts';

type BuildMode = Exclude<MinecraftPreparationMode, 'upgrade'>;
type Upgrade = {
  mode: 'upgrade';
  selection: MinecraftSelection;
  upgradeMode: MinecraftUpgradeMode;
  worldIds?: readonly string[];
  worldVersionConfirmation?: MinecraftWorldVersionRisk;
  java?: MinecraftJavaPolicy;
};
type Request = { mode: BuildMode } | Upgrade;

export type MinecraftPreparationJob = Request & {
  id: string;
  signal: AbortSignal;
  report(phase: MinecraftPreparationPhase, progress?: MinecraftPreparationProgress): Promise<void>;
  commit(write: () => Promise<unknown>, resultInstanceId?: string): Promise<void>;
};

type Options = {
  directory(instanceId: string): string;
  prepare(instanceId: string, job: MinecraftPreparationJob): Promise<void>;
  withInstance?(instanceId: string, work: () => Promise<MinecraftPreparation>): Promise<MinecraftPreparation>;
  recoverCommitted?(preparation: MinecraftPreparation): Promise<string | undefined>;
};

type Work = {
  status: MinecraftPreparation;
  controller: AbortController;
  request: Request;
  done?: Promise<MinecraftPreparation>;
};

export function createMinecraftPreparation({ directory, prepare, withInstance, recoverCommitted }: Options) {
  const locks = new Locks();
  const running = new Map<string, Work>();
  const observers = new Set<(value: MinecraftPreparation) => void>();
  const recordPath = (id: string) => join(directory(id), 'minecraft-preparation.json');

  function publish(status: MinecraftPreparation) {
    for (const observe of observers) {
      try {
        observe(status);
      } catch {
        // The job and the persisted record outlive any observer.
      }
    }
  }

  async function update(work: Work, patch: Partial<MinecraftPreparation>) {
    const next = { ...work.status, ...patch, updatedAt: Date.now() };
    if (next.phase !== work.status.phase && !patch.progress) delete next.progress;
    await writeJson(recordPath(next.instanceId), next);
    work.status = next;
    publish(next);
    return next;
  }

  async function readCurrent(id: string) {
    const work = running.get(id);
    if (work) return work.status;
    const persisted = await readJson<MinecraftPreparation>(recordPath(id));
    if (!persisted) return null;
    if (!isActiveMinecraftPreparation(persisted)) return persisted;
    const completed =
      persisted.state === 'running' && persisted.phase === 'verify' && !persisted.cancellable
        ? await recoverCommitted?.(persisted)
        : undefined;
    const interrupted: MinecraftPreparation = {
      ...persisted,
      cancellable: false,
      ...(completed
        ? {
            state: 'ready',
            updatedAt: Date.now(),
            ...(persisted.mode === 'upgrade' && { resultInstanceId: completed }),
          }
        : {
            state: 'failed',
            interrupted: true,
            error: 'Launcher closed before preparation completed. Retry to verify and reuse finished downloads.',
          }),
    };
    await writeJson(recordPath(id), interrupted);
    return interrupted;
  }

  async function run(id: string, work: Work): Promise<MinecraftPreparation> {
    const { signal } = work.controller;
    let committed = false;
    let resultInstanceId: string | undefined;
    let result: Pick<MinecraftPreparation, 'state' | 'error' | 'resultInstanceId'>;
    try {
      await prepare(id, {
        ...work.request,
        id: work.status.id,
        signal,
        report: (phase, progress) =>
          locks.run(id, async () => {
            signal.throwIfAborted();
            const current = work.status.progress;
            if (
              work.status.phase !== phase ||
              (progress && (current?.completed !== progress.completed || current.total !== progress.total))
            ) {
              await update(work, { phase, ...(progress && { progress }) });
            }
          }),
        async commit(write, resultId) {
          await locks.run(id, async () => {
            signal.throwIfAborted();
            await update(work, { phase: 'verify', cancellable: false });
          });
          await write();
          resultInstanceId = resultId;
          committed = true;
        },
      });
      signal.throwIfAborted();
      if (!committed) throw new Error('The installation was not saved.');
      result = { state: 'ready', ...(resultInstanceId && { resultInstanceId }) };
    } catch (failure) {
      result = signal.aborted
        ? { state: 'cancelled' }
        : {
            state: 'failed',
            error:
              failure instanceof Error && failure.message.trim()
                ? failure.message.slice(0, 320)
                : 'Game preparation could not verify the current step. Check your connection and retry.',
          };
    }

    return locks.run(id, async () => {
      try {
        return await update(work, { ...result, cancellable: false });
      } catch {
        const status: MinecraftPreparation = {
          ...work.status,
          state: 'failed',
          updatedAt: Date.now(),
          cancellable: false,
          error: 'Launcher could not save preparation status. Reopen the instance and verify its installation.',
        };
        work.status = status;
        publish(status);
        return status;
      } finally {
        running.delete(id);
      }
    });
  }

  return {
    active(id: string) {
      return running.get(id)?.status;
    },
    activeJobs() {
      return Array.from(running.values(), ({ status }) => status).filter(isActiveMinecraftPreparation);
    },
    hasActiveJobs() {
      return running.size > 0;
    },
    async waitForWork() {
      await Promise.allSettled(Array.from(running.values(), ({ done }) => done));
    },
    subscribe(observer: (value: MinecraftPreparation) => void) {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    start(id: string, input: BuildMode | Upgrade) {
      return locks.run(id, async () => {
        const request: Request = typeof input === 'string' ? { mode: input } : input;
        const current = running.get(id);
        if (current) {
          if (request.mode === 'upgrade' || current.request.mode === 'upgrade') {
            throw new Error('Wait for the current Minecraft preparation to finish before changing this instance.');
          }
          return current.status;
        }
        const status: MinecraftPreparation = {
          ...request,
          id: randomUUID(),
          instanceId: id,
          phase: 'queued',
          state: 'running',
          updatedAt: Date.now(),
          cancellable: true,
        };
        await writeJson(recordPath(id), status);
        const work: Work = { status, controller: new AbortController(), request };
        running.set(id, work);
        work.done = withInstance ? withInstance(id, () => run(id, work)) : run(id, work);
        void work.done.catch(() => {});
        publish(status);
        return status;
      });
    },
    read(id: string) {
      return locks.run(id, () => readCurrent(id));
    },
    cancel(id: string, attemptId?: string) {
      return locks.run(id, async () => {
        const work = running.get(id);
        if (!work?.status.cancellable || (attemptId !== undefined && work.status.id !== attemptId)) {
          return readCurrent(id);
        }
        const status = await update(work, { state: 'cancelling', cancellable: false });
        work.controller.abort(new Error('Game preparation was cancelled.'));
        return status;
      });
    },
    async wait(id: string): Promise<MinecraftPreparation | null> {
      const work = running.get(id);
      return work?.done ?? locks.run(id, () => readCurrent(id));
    },
  };
}
