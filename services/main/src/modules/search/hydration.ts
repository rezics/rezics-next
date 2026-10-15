import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { SearchRequestTimedOut } from '../work/search-readiness.ts';

// Card delivery must leave time for the Realm, graph and recovery owners to
// close their proofs. The enclosing search retains its existing wall bound.
export const SEARCH_HYDRATION_FENCE_MS = 250;

/** An unfinished card is deferred, never delivered using an unfenced summary.
 * Abort its transport without aborting the remaining scope/fence allocation. */
export async function boundedSearchHydration<T>(read: () => Promise<T>): Promise<T | null> {
  const outer = fusekiReadBudget.getStore();
  if (outer?.deadline === undefined) return read();
  outer.signal.throwIfAborted();
  const deadline = outer.deadline - SEARCH_HYDRATION_FENCE_MS;
  const remaining = deadline - performance.now();
  if (remaining <= 0) return null;
  const controller = new AbortController();
  const budget = { ...outer, deadline, signal: AbortSignal.any([outer.signal, controller.signal]),
    get callsLeft() { return outer.callsLeft; },
    set callsLeft(value: number) { outer.callsLeft = value; },
    get bytesLeft() { return outer.bytesLeft; },
    set bytesLeft(value: number) { outer.bytesLeft = value; },
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deferred = new Promise<null>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(null); }, remaining);
  });
  try {
    return await Promise.race([fusekiReadBudget.run(budget, read), deferred]);
  } catch (error) {
    if (!outer.signal.aborted && (controller.signal.aborted
      || error instanceof SearchRequestTimedOut && performance.now() >= deadline)) return null;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
