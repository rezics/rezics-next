import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';

const activeTick = new AsyncLocalStorage<string>();
const TICK_NAME = /^[A-Za-z][\w.:-]{0,80}$/;

/** The tick name while `fn` runs. Undefined outside `runWorkerTick`. */
export function currentWorkerTick(): string | undefined {
  return activeTick.getStore();
}

/**
 * Runs one worker tick on a fresh async resource.
 *
 * A pooled `connect()` publishes its hold with `AsyncLocalStorage.enterWith`,
 * which stays on the current resource across that turn's awaits. Interval
 * callbacks and relay loops started from process startup share one resource,
 * so a connection this tick still holds is an outer checkout for every later
 * worker. The notification listener uses the same `AsyncResource` boundary
 * for its retained connection: the hold sticks to this tick and is not
 * inherited by another worker in the caller's context. A tick still sees a
 * hold the caller already owned.
 */
export async function runWorkerTick<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  if (!TICK_NAME.test(name)) throw new Error('worker tick name is invalid');
  const resource = new AsyncResource('worker-tick');
  try {
    return await resource.runInAsyncScope(() => activeTick.run(name, fn));
  } finally {
    resource.emitDestroy();
  }
}
