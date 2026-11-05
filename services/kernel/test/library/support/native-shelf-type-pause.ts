import { AsyncLocalStorage } from 'node:async_hooks';
import type { LibraryShelvesDriver, TypeWorkPause } from '../../../../../specs/library-shelves-driver.ts';
import type { TypePreparationSourceObserved } from '../../../src/library/type-preparation-contract.ts';

type Selection = Parameters<LibraryShelvesDriver['pauseTypeWork']>[0];
type Observation = Awaited<TypeWorkPause['reached']>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Per-world request latches. Projection workflows must be bound by their actual producer. */
export function createNativeShelfTypePauses() {
  const execution = new AsyncLocalStorage<Promise<void>>();
  const latches = new Set<{
    selection: Selection;
    reached: ReturnType<typeof deferred<Observation>>;
    release: ReturnType<typeof deferred<void>>;
    completed: Promise<void> | undefined;
  }>();
  let closed = false;
  function releaseAll() {
    for (const latch of latches) {
      latch.release.resolve();
      if (!latch.completed) latch.reached.reject(new Error('Shelf type observation latch closed before reaching'));
    }
  }
  const observe: TypePreparationSourceObserved = async (observation) => {
    const latch = [...latches].find(
      ({ selection, completed }) =>
        !completed &&
        selection.subjectId === observation.subjectId &&
        (selection.accountId === undefined || selection.accountId === observation.accountId),
    );
    if (!latch) return;
    const completed = execution.getStore();
    if (!completed) throw new Error('Entry source observation has no owning request');
    latch.completed = completed;
    latch.reached.resolve({ sourceId: observation.sourceId, stamp: { ...observation.stamp } });
    await latch.release.promise;
  };
  return {
    observe,
    async pause(selection: Selection): Promise<TypeWorkPause> {
      if (closed) throw new Error('Shelf type observation latches are closed');
      if (selection.workflow !== 'entry') {
        const producer =
          selection.workflow === 'sync'
            ? 'syncShelfSubjectType(change: ShelfTypeChange, dependencies: ShelfProjectionDependencies); library.shelfTypeSync subject.revised/merged consumer registration'
            : 'verifyShelfEntryType(eventId: string, accountId: string, subjectId: string, dependencies: ShelfProjectionDependencies); library.shelfTypeVerify entry.updated consumer registration';
        throw new Error(`Native Library dependency_unavailable: library/shelf-contract.ts:${producer}`);
      }
      if (selection.boundary !== 'sourceObserved')
        throw new Error('Native Library dependency_unavailable: entry preparation has no entryObserved boundary');
      const latch = {
        selection: { ...selection },
        reached: deferred<Observation>(),
        release: deferred<void>(),
        completed: undefined as Promise<void> | undefined,
      };
      // Closing an armed latch must not leave an unhandled rejection when its caller failed earlier.
      void latch.reached.promise.catch(() => undefined);
      latches.add(latch);
      return {
        reached: latch.reached.promise,
        async resume() {
          await latch.reached.promise;
          latch.release.resolve();
          await latch.completed;
          latches.delete(latch);
        },
      };
    },
    async run<T>(body: () => Promise<T>): Promise<T> {
      const completed = deferred<void>();
      try {
        return await execution.run(completed.promise, body);
      } catch (error) {
        releaseAll();
        throw error;
      } finally {
        completed.resolve();
      }
    },
    async settle(input?: { exceptPaused?: boolean }) {
      if (!input?.exceptPaused) await Promise.all([...latches].map((latch) => latch.completed));
    },
    async close() {
      closed = true;
      releaseAll();
      await Promise.all([...latches].map((latch) => latch.completed));
      latches.clear();
    },
  };
}
