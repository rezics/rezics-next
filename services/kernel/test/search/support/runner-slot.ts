import type { startSearchIndexing } from '../../../src/search/runner.ts';
import type { WorkService } from '../../../src/work/registry.ts';
import type { WorkerConfig } from '../../../src/worker.ts';

export type SearchWorkerKind = 'in-process' | 'owned-child';

/** Pool/AsyncLocalStorage identity is a capability that cannot cross child IPC. */
export function searchWorkerOwnership(kernelPool: WorkerConfig['kernelPool']) {
  const kind: SearchWorkerKind = kernelPool ? 'in-process' : 'owned-child';
  return {
    kind,
    requireOwnedChild(): void {
      if (kernelPool)
        throw new Error(
          'Owned-child crash/restart is incompatible with the explicit kernelPool capability (in-process instrumentation)',
        );
    },
  };
}

export type SearchRunnerControl = Pick<Awaited<ReturnType<typeof startSearchIndexing>>, 'stop' | 'refresh'>;

function canStop(service: unknown): service is WorkService {
  return (
    service !== null &&
    (typeof service === 'object' || typeof service === 'function') &&
    'stop' in service &&
    typeof service.stop === 'function'
  );
}

function validate(service: WorkService): asserts service is SearchRunnerControl {
  if (!canStop(service)) throw new Error('Search service must export stop');
  if (!('refresh' in service) || typeof service.refresh !== 'function') {
    throw new Error('Search service must export refresh');
  }
}

/** Test-only ownership of the runner returned by the actual post-launch starter. */
export function createSearchRunnerSlot() {
  let adopted = false;
  let sealed = false;
  let current: SearchRunnerControl | undefined;
  let start: (() => WorkService | Promise<WorkService>) | undefined;
  let tail = Promise.resolve();
  let closing: Promise<void> | undefined;
  const rejected = new Set<WorkService>();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    // A failed control keeps its own rejection but cannot skip subsequent cleanup.
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  function control<T>(operation: () => Promise<T>): Promise<T> {
    if (sealed) return Promise.reject(new Error('Search runner slot is stopped'));
    return enqueue(operation);
  }

  async function dispose(service: WorkService): Promise<void> {
    await service.stop();
    rejected.delete(service);
    if (current === service) current = undefined;
  }

  async function discard(service: WorkService): Promise<void> {
    if (!canStop(service)) return;
    rejected.add(service);
    await dispose(service);
  }

  function stop(): Promise<void> {
    // Seal synchronously, including while earlier admitted controls are still running.
    sealed = true;
    return (closing ??= enqueue(async () => {
      if (current) rejected.add(current);
      const failures: unknown[] = [];
      // Set iteration includes rejected adoptions arriving while cleanup awaits a stop.
      for (const service of rejected) {
        try {
          await dispose(service);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Search runner slot cleanup failed');
    }));
  }

  const service: WorkService = { stop };
  return {
    adopt(runner: WorkService, starter: () => WorkService | Promise<WorkService>): WorkService {
      try {
        if (sealed) throw new Error('Search runner slot is stopped');
        if (adopted) throw new Error('Search runner slot is already adopted');
        adopted = true;
        validate(runner);
      } catch (error) {
        // adopt is synchronous. Queue rejected-handle cleanup so shutdown waits for it;
        // a failed cleanup remains owned in `rejected` for shutdown to attempt again.
        if (canStop(runner)) {
          rejected.add(runner);
          void enqueue(async () => {
            if (rejected.has(runner)) await dispose(runner);
          });
        }
        throw error;
      }
      current = runner;
      start = starter;
      return service;
    },
    pause(): Promise<void> {
      return control(async () => {
        if (current) await dispose(current);
      });
    },
    resume(): Promise<void> {
      return control(async () => {
        if (current) return;
        if (!start) throw new Error('Search runner slot has not adopted a service');
        const runner = await start();
        try {
          validate(runner);
        } catch (error) {
          try {
            await discard(runner);
          } catch {
            // Preserve validation's error; shutdown still owns the failed cleanup.
          }
          throw error;
        }
        current = runner;
      });
    },
    withRunner<T>(operation: (runner: SearchRunnerControl) => Promise<T>): Promise<T> {
      return control(async () => {
        if (!current) throw new Error('Search runner slot is paused');
        return operation(current);
      });
    },
    stop,
  };
}
